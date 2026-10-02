---
title: "EF.Parameter или EF.Constant в запросах EF Core 11"
description: "EF.Constant встраивает захваченное значение в SQL как литерал, EF.Parameter превращает литерал в SQL-параметр. Оставляйте поведение EF Core по умолчанию, используйте EF.Parameter, чтобы динамически построенные деревья выражений не перекомпилировались при каждом вызове, а EF.Constant применяйте только для значений с небольшим набором вариантов и настолько перекошенными данными, что каждому нужен свой план."
pubDate: 2026-10-02
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "dotnet"
  - "sql-server"
  - "performance"
lang: "ru"
translationOf: "2026/10/ef-parameter-vs-ef-constant-in-ef-core-11-queries"
translatedBy: "claude"
translationDate: 2026-10-02
---

`EF.Constant(x)` велит EF Core записать значение в SQL как литерал (`WHERE [Status] = N'Pending'`), хотя оно пришло из переменной, которую EF обычно отправил бы как параметр. `EF.Parameter(x)` делает обратное: заставляет значение, которое EF обычно встраивает, например литерал или `Expression.Constant` в вручную построенном дереве, уйти в базу как параметр (`WHERE [Status] = @p`). Поведение по умолчанию подходит почти для всех запросов. Обращайтесь к `EF.Parameter`, когда строите деревья выражений динамически: сырые константы в таких деревьях вызывают полную компиляцию запроса для каждого нового значения. Обращайтесь к `EF.Constant` только тогда, когда у столбца несколько различных значений с сильно перекошенными данными и базе нужен отдельный план для каждого значения.

Всё ниже запускалось на EF Core 11.0.0-rc.1.26425.128 с SDK 11.0.100-rc.1.26425.128 на Apple M4. Где указано, я также проверял EF Core 10.0.12 на SDK 10.0.302, и поведение было таким же. `EF.Constant` появился в EF Core 8.0.2, `EF.Parameter` в EF Core 9, а специфичный для коллекций `EF.MultipleParameters` в EF Core 10.

## Сравнение с первого взгляда

| | `EF.Parameter(x)` | `EF.Constant(x)` |
| --- | --- | --- |
| Доступен с | EF Core 9 | EF Core 8.0.2 |
| Результат для скаляра в SQL | параметр `@p` | литерал, например `N'Pending'` |
| Результат для коллекции в SQL (EF 10/11) | один JSON-параметр + `OPENJSON` | литералы `IN (1, 2, 3, ...)` |
| Записей в кеше запросов EF для N различных значений | 1 | 1 (начиная с EF 9) |
| Записей в кеше планов базы данных для N различных значений | 1 | до N |
| План, подобранный под конкретное значение | Нет (действует parameter sniffing) | Да |
| Значение в журналах EF по умолчанию | Нет (`'?'`) | Нет, скрыто как `?` начиная с EF 10 |
| Работает в `EF.CompileQuery` / фильтрах запросов | Нет, выбрасывает исключение | Нет, выбрасывает исключение |
| Основное применение | динамические деревья выражений, принудительный JSON-параметр для коллекции | перекошенные столбцы с малым числом значений, принудительный встроенный список `IN` |

## Что EF Core делает по умолчанию

Правило параметризации в EF простое: всё, что приходит извне дерева выражения (захваченная локальная переменная, поле, аргумент метода), становится параметром, а всё, что записано литералом внутри лямбды, становится константой. Вот что EF Core 11 RC 1 генерирует для SQL Server, прямо из `ToQueryString()`:

```csharp
// EF Core 11.0.0-rc.1, Microsoft.EntityFrameworkCore.SqlServer, .NET 11 RC 1
var status = "Pending";

db.Orders.Where(o => o.Status == status);
// DECLARE @status nvarchar(4000) = N'Pending';
// WHERE [o].[Status] = @status

db.Orders.Where(o => o.Status == "Pending");
// WHERE [o].[Status] = N'Pending'
```

Это разделение намеренное. Литерал в исходном коде не может измениться между выполнениями, поэтому его встраивание ничего не стоит и даёт оптимизатору запросов реальное значение для оценки. Захваченная переменная может меняться при каждом вызове, поэтому её встраивание породило бы свою SQL-строку для каждого значения, а каждая различная строка получает отдельную запись в кеше планов базы данных. На загруженном SQL Server это раздувание кеша планов и компиляция при каждом новом значении.

`EF.Constant` и `EF.Parameter` существуют, чтобы переопределить это правило в любую из сторон.

## EF.Constant: принудительный литерал

```csharp
// EF Core 11.0.0-rc.1
var status = "Pending";
db.Orders.Where(o => o.Status == EF.Constant(status));
// WHERE [o].[Status] = N'Pending'

var name = "O'Brien";
db.Orders.Where(o => o.Customer == EF.Constant(name));
// WHERE [o].[Customer] = N'O''Brien'
```

Второй запрос важен, если вы беспокоитесь об инъекциях: EF по-прежнему генерирует литерал через сопоставление типов провайдера, поэтому кавычка экранируется. `EF.Constant` не является конкатенацией строк.

Причина так делать в parameter sniffing. SQL Server компилирует параметризованный план по первому увиденному значению и переиспользует этот план для всех последующих. Если `Status = 'Archived'` совпадает с 40 миллионами строк, а `Status = 'Pending'` с 200, план, скомпилированный для одного, не подходит другому. С литералом каждое значение получает собственный план со своей оценкой кардинальности. Этот компромисс окупается только тогда, когда у столбца небольшой фиксированный набор значений. Если обернуть в `EF.Constant` идентификатор пользователя или номер заказа, вы заново создадите проблему кеша планов, которой EF по умолчанию как раз избегает.

### EF.Constant больше не вызывает перекомпиляцию в EF

В EF Core 8 реализация вставляла константу в начале конвейера, до обращения к собственному кешу запросов EF, поэтому каждое новое значение приводило к полной компиляции LINQ в SQL. [Страница о критических изменениях EF Core 9](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/breaking-changes) описывает переработку: теперь метод обрабатывается на более позднем этапе, после кеша. Я проверил это, посчитав событие отладочного журнала `Compiling query expression` за 500 выполнений с 500 различными значениями после прогрева в 50 запросов, на SQLite в памяти:

```csharp
// EF Core 11.0.0-rc.1, Microsoft.EntityFrameworkCore.Sqlite
for (int i = 0; i < 500; i++)
{
    using var db = new Ctx(conn, log: s => { if (s.Contains("Compiling query expression")) compiles++; });
    var value = "S" + i;
    db.Orders.Where(o => o.Status == EF.Constant(value)).ToList();
}
```

Результат: ноль дополнительных компиляций. EF переиспользует скомпилированный запрос и лишь заново формирует текст SQL. Сегодня цена `EF.Constant` целиком лежит на стороне базы данных: один план на каждую различную SQL-строку.

## EF.Parameter: принудительный параметр

```csharp
// EF Core 11.0.0-rc.1
db.Orders.Where(o => o.Status == EF.Parameter("Pending"));
// DECLARE @p nvarchar(4000) = N'Pending';
// WHERE [o].[Status] = @p
```

Обернуть жёстко заданный литерал само по себе редко полезно. `EF.Parameter` оправдывает себя при динамическом построении запросов. Когда вы строите предикат через `System.Linq.Expressions`, естественно написать `Expression.Constant(value)`, и EF обрабатывает его точно так же, как литерал в исходном коде:

```csharp
// EF Core 11.0.0-rc.1, .NET 11 RC 1
static Expression<Func<T, bool>> Eq<T>(string property, string value, bool wrap)
{
    var p = Expression.Parameter(typeof(T), "e");
    Expression v = Expression.Constant(value);
    if (wrap)
        v = Expression.Call(typeof(EF), nameof(EF.Parameter), [typeof(string)], v);
    return Expression.Lambda<Func<T, bool>>(
        Expression.Equal(Expression.Property(p, property), v), p);
}

db.Orders.Where(Eq<Order>("Status", "Shipped", wrap: false));
// WHERE [o].[Status] = N'Shipped'

db.Orders.Where(Eq<Order>("Status", "Shipped", wrap: true));
// DECLARE @p nvarchar(4000) = N'Shipped';
// WHERE [o].[Status] = @p
```

В отличие от `EF.Constant`, сырой `Expression.Constant` входит в дерево, которое EF использует как ключ кеша, поэтому каждое различное значение это промах кеша и полная компиляция. Именно здесь появляется измеримая цена. Тот же стенд, 500 различных значений, один процесс на вариант, после прогрева:

| Вариант (EF Core 11 RC 1, SQLite в памяти, M4) | Компиляций EF | Время на 500 запросов |
| --- | --- | --- |
| Захваченная переменная (по умолчанию) | 0 | 186-292 мс |
| `EF.Constant(variable)` | 0 | 188-226 мс |
| Сырой `Expression.Constant` в построенном дереве | 500 | 2201-2261 мс |
| `Expression.Constant`, обёрнутый в `EF.Parameter` | 0 | 202-355 мс |

Диапазоны получены по двум запускам на вариант. Таблица пуста, поэтому это изолирует собственные накладные расходы EF: примерно 4 мс компиляции на запрос, ещё до того как база что-либо сделала. На SQL Server сверху добавится компиляция плана в базе для каждой различной строки. Один `Expression.Call` к `EF.Parameter` возвращает динамическое дерево к стоимости обычного LINQ-запроса.

Другой способ добиться того же: захватить значение в объект-замыкание и использовать `Expression.Property(Expression.Constant(holder), "Value")`, что и делает компилятор C# для лямбды. Это работает, но `EF.Parameter` короче и делает намерение очевидным. Приём с замыканием я подробнее разбирал в статье [как писать переиспользуемые LINQ-предикаты, которые EF Core умеет транслировать](/ru/2026/08/how-to-write-reusable-linq-predicates-ef-core-can-translate/).

## Коллекции: три стратегии, три маркера

Для скаляра выбор бинарный. Для коллекции в `Contains` в EF Core 10 и 11 есть три трансляции, и каждый маркерный метод выбирает одну из них для конкретного запроса:

```csharp
// EF Core 11.0.0-rc.1, SQL Server provider
int[] ids = [1, 2, 3, 4, 5, 6, 7, 8];

db.Orders.Where(o => ids.Contains(o.Id));
// DECLARE @ids1 int = 1; ... DECLARE @ids8 int = 8;
// DECLARE @ids9 int = 8; DECLARE @ids10 int = 8;
// WHERE [o].[Id] IN (@ids1, @ids2, ..., @ids10)

db.Orders.Where(o => EF.Constant(ids).Contains(o.Id));
// WHERE [o].[Id] IN (1, 2, 3, 4, 5, 6, 7, 8)

db.Orders.Where(o => EF.Parameter(ids).Contains(o.Id));
// DECLARE @ids nvarchar(4000) = N'[1,2,3,4,5,6,7,8]';
// WHERE [o].[Id] IN (
//     SELECT [i].[value]
//     FROM OPENJSON(@ids) WITH ([value] int '$') AS [i]
// )

db.Orders.Where(o => EF.MultipleParameters(ids).Contains(o.Id));
// same padded IN (@ids1, ..., @ids10) as the default
```

Начиная с EF Core 10 по умолчанию используется один скалярный параметр на элемент с дополнением так, что 8 значений дают 10 параметров (последнее значение повторяется). Это сохраняет небольшое число различных SQL-строк и при этом сообщает оптимизатору примерное количество значений. `EF.Parameter` для коллекции возвращает поведение EF Core 8 и 9: один JSON-параметр, распаковываемый через `OPENJSON`, одна SQL-строка для списка любой длины, но без информации о кардинальности для планировщика. `EF.Constant` встраивает значения, как это было в EF Core 7.

Глобальный переключатель это `UseParameterizedCollectionMode`:

```csharp
// EF Core 11.0.0-rc.1
options.UseSqlServer(connectionString,
    o => o.UseParameterizedCollectionMode(ParameterTranslationMode.Constant));
```

При такой настройке обычный `ids.Contains(...)` даёт `IN (1, 2, ...)`, `EF.MultipleParameters(ids)` возвращает отдельный запрос к дополненным параметрам, а `EF.Parameter(ids)` переводит его на `OPENJSON`. Режим влияет только на коллекции: скалярная захваченная переменная остаётся `@status` в любом режиме. Методы EF Core 9 `TranslateParameterizedCollectionsToConstants()` и `TranslateParameterizedCollectionsToParameters()` были помечены `[Obsolete]` в EF Core 10 и отсутствуют в исходном коде EF Core 11 RC 1, так что проекту, обновляющемуся с EF 9, придётся перейти на `UseParameterizedCollectionMode`. Остальную часть пути обновления описывает [разбор критических изменений при переходе с EF Core 6 на EF Core 11](/ru/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).

## Подводные камни, на которые я наткнулся при тестировании

### Маркер должен находиться внутри лямбды

`EF.Constant` и `EF.Parameter` это маркеры, а не функции. Их настоящие тела выбрасывают исключение. Они работают только внутри дерева выражения, которое транслирует EF. Этот код компилируется, но падает во время выполнения:

```csharp
// EF Core 11.0.0-rc.1
db.Orders.OrderBy(o => o.Id).Take(EF.Constant(10));
// InvalidOperationException: The 'EF.Constant<T>' method may only be used
// within Entity Framework LINQ queries.
```

`Take(int)` принимает обычный `int`, а не `Expression`, поэтому C# вычисляет `EF.Constant(10)` сразу, вне какого-либо запроса. То же относится к любому аргументу оператора, который не является лямбдой.

### Не в скомпилированных запросах и не в фильтрах запросов

Начиная с EF Core 9 оба метода выбрасывают исключение внутри `EF.CompileQuery` и `EF.CompileAsyncQuery`. В EF Core 11 RC 1 сообщение понятнее, чем `InvalidCastException`, описанный в документации для EF 9:

```text
InvalidOperationException: 'EF.Constant<T>' is not supported when using compiled queries or query filters.
InvalidOperationException: 'EF.Parameter<T>' is not supported when using compiled queries or query filters.
```

Если константа нужна в горячем пути, запишите литерал прямо в лямбду скомпилированного запроса. Если нужны планы под каждое значение, скомпилированный запрос в любом случае не тот инструмент, потому что он фиксирует одну SQL-строку. Когда они окупаются, разбирает [руководство по скомпилированным запросам](/ru/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/). Это сообщение также исключает глобальные фильтры запросов, что важно, если вы рассчитывали встроить идентификатор арендатора в [именованный фильтр запросов](/ru/2026/07/named-query-filters-vs-a-single-global-query-filter-in-ef-core-11/).

### Встроенные значения скрываются в журналах

До EF Core 10 встроенная константа была видна в журналируемом SQL, в отличие от значения параметра. Начиная с EF Core 10 EF её скрывает. Из журнала EF Core 11 RC 1 при выключенном журналировании конфиденциальных данных:

```text
Executed DbCommand (20ms) [Parameters=[@secret='?' (Size = 17)], ...]
WHERE "o"."Customer" = @secret

Executed DbCommand (0ms) [Parameters=[], ...]
WHERE "o"."Customer" = ?
```

База данных по-прежнему получает настоящий литерал. Маскируется только строка журнала. Этот `?` может сбить с толку, когда вы впервые [журналируете SQL, который генерирует EF Core](/ru/2026/07/how-to-log-the-sql-that-ef-core-11-generates/), и пытаетесь вставить его в SSMS. Включите `EnableSensitiveDataLogging()` в разработке, чтобы увидеть значение.

### Режим коллекций не входит в ключ кеша запросов

Это меня удивило. Два контекста одного типа, один настроен с `ParameterTranslationMode.Constant`, а другой по умолчанию, используют один внутренний провайдер служб и один кеш скомпилированных запросов. Тот, кто первым выполнит данную форму запроса, определяет SQL для обоих:

```csharp
// EF Core 11.0.0-rc.1 and 10.0.12, same process
using (var a = new Ctx(ParameterTranslationMode.Constant))
    a.Orders.Where(o => ids.Contains(o.Id)).ToQueryString();
// WHERE [o].[Id] IN (1, 2, 3)

using (var b = new Ctx(mode: null))   // default MultipleParameters
    b.Orders.Where(o => ids.Contains(o.Id)).ToQueryString();
// WHERE [o].[Id] IN (1, 2, 3)   <- cached translation from context a
```

Объяснение находится в исходном коде. `RelationalOptionsExtension` возвращает `0` из `GetServiceProviderHashCode()`, а `RelationalCompiledQueryCacheKey` включает `UseRelationalNulls` и `QuerySplittingBehavior`, но не режим коллекций. В обычном приложении с одной конфигурацией это никогда не имеет значения. Это имеет значение, если вы регистрируете один и тот же `DbContext` дважды с разными режимами или переключаете режим в фикстуре теста и ожидаете, что следующий тест увидит другой SQL. В таком случае используйте маркеры на уровне запроса: они входят в дерево выражения, а значит, и в ключ кеша.

## Когда выбирать EF.Parameter

- Вы строите предикаты через `System.Linq.Expressions` (построители фильтров, поиск по таблице, endpoint-ы в духе OData). Оборачивайте в `EF.Parameter` каждый `Expression.Constant`, несущий пользовательский ввод, иначе вы платите полную компиляцию за каждое различное значение.
- Вам нужна трансляция через `OPENJSON` для одного запроса, у которого длина списка сильно меняется (от 1 до 2 000 идентификаторов), чтобы у базы был один план вместо множества дополненных вариантов.
- Вы установили глобальный режим коллекций в `Constant`, и одному запросу нужно вернуться к параметрам.

## Когда выбирать EF.Constant

- Столбец с несколькими значениями и сильно перекошенными данными, например статус или дискриминатор типа, где измеренные планы различаются для разных значений. Сначала подтвердите регрессию по реальному плану выполнения.
- Короткий стабильный список значений в `Contains` (фиксированный набор ролей или регионов), где оптимизатору полезно видеть литералы, и вы знаете, что число комбинаций невелико.
- Никогда для идентификаторов, пользовательского ввода с неограниченным разнообразием или чего-либо внутри скомпилированного запроса.

## Рекомендация

Не трогайте поведение EF Core 11 по умолчанию, пока у вас нет измерений. Основная реальная выгода приходится на `EF.Parameter`, потому что динамически построенное дерево с сырыми константами это лёгкая в совершении ошибка, которая стоит около 4 мс компиляции EF на вызов ещё до того, как запрос увидит база. `EF.Constant` это точечное решение parameter sniffing на перекошенных столбцах с малым числом значений. Он больше не вызывает перекомпиляцию в EF, но каждое различное значение по-прежнему стоит плана в базе данных. Если вы не уверены, что именно получилось, `ToQueryString()` покажет это сразу. Ищите `DECLARE @`. А если запрос деградировал после обновления, проверьте [что меняет уровень совместимости SQL Server для EF Core 11](/ru/2026/09/sql-server-compatibility-level-150-vs-160-what-changes-for-ef-core-11-queries/), прежде чем браться за любой из маркеров.

## Источники

- [What's new in EF Core 9: force or prevent query parameterization](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/whatsnew)
- [What's new in EF Core 10: improved translation for parameterized collections, redacting inlined constants](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew)
- [Breaking changes in EF Core 9: EF.Constant and EF.Parameter in compiled queries](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/breaking-changes)
- [`EF.cs`, `EFExtensions.cs` and `ParameterTranslationMode.cs` in dotnet/efcore](https://github.com/dotnet/efcore/tree/main/src/EFCore)
- [dotnet/efcore#13617, the original plan cache issue for inlined collections](https://github.com/dotnet/efcore/issues/13617)
