---
title: "Решение: \"The LINQ expression could not be translated\" в EF Core 11"
description: "EF Core 11 выбрасывает это, когда Where или OrderBy вызывает метод, который нельзя преобразовать в SQL. Перепишите предикат с помощью транслируемых операторов или сначала загрузите данные на клиент через AsEnumerable."
pubDate: 2026-07-04
template: error-page
tags:
  - "errors"
  - "efcore"
  - "dotnet"
lang: "ru"
translationOf: "2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-04
---

EF Core 11 выбрасывает `The LINQ expression could not be translated`, когда часть вашего запроса вне финального `Select` (обычно `Where`, `OrderBy`, `GroupBy` или `Join`) вызывает метод или использует конструкцию, которую поставщик базы данных не может преобразовать в SQL. Исправьте это, переписав предикат с помощью операторов, которые EF умеет транслировать (`==`, `Contains`, `StartsWith`, `EF.Functions.*`), или, если вам действительно нужна логика в памяти, намеренно принудите вычисление на клиенте, вызвав `AsEnumerable()`, `AsAsyncEnumerable()`, `ToList()` или `ToListAsync()` перед нетранслируемым шагом. Это относится к `Microsoft.EntityFrameworkCore` 11.0 на .NET 11 с C# 14, и поведение не менялось начиная с EF Core 3.0.

## Ошибка в контексте

Полное исключение времени выполнения выглядит так. EF Core печатает точное дерево выражения, на котором он споткнулся, и это самая полезная подсказка на всём экране:

```
System.InvalidOperationException: The LINQ expression 'DbSet<Order>()
    .Where(o => o.CustomerName.Equals(
        name,
        StringComparison.OrdinalIgnoreCase))' could not be translated. Either rewrite the query in a form that can be translated, or switch to client evaluation explicitly by inserting a call to 'AsEnumerable', 'AsAsyncEnumerable', 'ToList', or 'ToListAsync'. See https://go.microsoft.com/fwlink/?linkid=2101038 for more information.
```

Тип исключения -- `System.InvalidOperationException`, и оно выбрасывается при выполнении запроса (на `ToList`, `First`, `foreach` или `await`), а не когда вы его составляете. Именно поэтому трассировка стека часто указывает на ваш репозиторий или контроллер, а не на `Where`, который на самом деле его вызвал. Читайте процитированное выражение, а не трассировку стека.

## Почему это происходит

EF Core транслирует как можно большую часть вашего запроса в один SQL-оператор и выполняет его на сервере базы данных. Начиная с версии 3.0, он поддерживает частичное вычисление на клиенте ровно в одном месте: в проекции верхнего уровня, то есть в последнем вызове `Select`. Если любая другая часть запроса -- `Where`, `OrderBy`, `Skip`, `GroupBy`, `Join` или вложенный подзапрос -- содержит выражение, которое он не может транслировать, он отказывается тихо загрузить всю таблицу в память и фильтровать там. Вместо этого он выбрасывает исключение.

Этот преднамеренный отказ -- это возможность, а не недостаток. До EF Core 3.0 фреймворк охотно вычислял нетранслируемый `Where` на клиенте, а это значит, что дешёвый на вид запрос мог тихо скачать миллион строк и отфильтровать их в вашем процессе. Текущее поведение меняет громкое исключение на этапе разработки на целый класс катастроф производительности в продакшене, которых вы никогда не видите. Когда вы натыкаетесь на эту ошибку, EF Core сообщает вам, что написанный вами предикат не имеет эквивалента в SQL.

Обычные причины:

- Вызов метода C# без сопоставления с SQL (собственный хелпер, `string.Equals` с `StringComparison`, `Enum.HasFlag`, `decimal.Round` с `MidpointRounding`).
- Форматирование или разбор внутри запроса (`DateTime.ToString("yyyy-MM-dd")`, `int.Parse`, `Guid.Parse`).
- Обращение к типу или вызов типа, который поставщик не может сопоставить (вычисляемое свойство, за которым стоит логика C#, а не сопоставленный столбец).
- Сравнение с конструкцией, которую поставщик не поддерживает для вашей базы данных (определённая арифметика `TimeSpan`, некоторые API на основе `Span`).

## Минимальное воспроизведение

Вот наименьшая программа, которая это воспроизводит. Сравнение без учёта регистра с перегрузкой `StringComparison` -- самая распространённая причина в реальном мире, потому что оно прекрасно читается в C# и совершенно не транслируется:

```csharp
// .NET 11, EF Core 11, Microsoft.EntityFrameworkCore.SqlServer 11.0
using Microsoft.EntityFrameworkCore;

using var db = new ShopContext();

string name = "acme";

// Throws at ToListAsync: StringComparison has no SQL translation.
var orders = await db.Orders
    .Where(o => o.CustomerName.Equals(name, StringComparison.OrdinalIgnoreCase))
    .ToListAsync();

public class Order
{
    public int Id { get; set; }
    public string CustomerName { get; set; } = "";
    public DateTime PlacedOn { get; set; }
}

public class ShopContext : DbContext
{
    public DbSet<Order> Orders => Set<Order>();

    protected override void OnConfiguring(DbContextOptionsBuilder options) =>
        options.UseSqlServer("Server=.;Database=Shop;Trusted_Connection=True;Encrypt=False");
}
```

Вызов `Equals(name, StringComparison.OrdinalIgnoreCase)` и есть проблема. У EF Core нет способа выразить "порядковое, без учёта регистра" в виде SQL, потому что чувствительность к регистру в SQL определяется collation столбца, а не аргументом метода. Поэтому он выбрасывает исключение.

## Решение в деталях

Решения упорядочены от лучшего (оставить работу на сервере) до крайней меры (намеренно загрузить данные в память).

### 1. Перепишите предикат с помощью транслируемых операторов

В девяноста процентах случаев решение -- выразить то же намерение с помощью операторов, которые EF Core знает. Для сравнения без учёта регистра полностью откажитесь от перегрузки `StringComparison`. В SQL Server collation по умолчанию уже не учитывает регистр, поэтому простой `==` делает то, что вам нужно, и транслируется в чистый `WHERE`:

```csharp
// .NET 11, EF Core 11 -- translates to WHERE [o].[CustomerName] = @name
var orders = await db.Orders
    .Where(o => o.CustomerName == name)
    .ToListAsync();
```

Если вам нужно сравнение без учёта регистра независимо от collation столбца, используйте `EF.Functions.Collate`, чтобы привязать сравнение к collation без учёта регистра, которое поставщик транслирует в предложение `COLLATE`:

```csharp
// .NET 11, EF Core 11 -- explicit case-insensitive comparison in SQL
var orders = await db.Orders
    .Where(o => EF.Functions.Collate(o.CustomerName, "SQL_Latin1_General_CP1_CI_AS") == name)
    .ToListAsync();
```

Поверхность `EF.Functions` существует именно для этого: `Like`, `Collate`, `DateDiffDay`, `Contains` (полнотекстовый), `Random` и специфичные для поставщика хелперы дают вам SQL-конструкции, которые чистый C# выразить не может. Обращайтесь к ней прежде, чем сдаваться и отказываться от вычисления на сервере. Для сопоставления подстрок предпочитайте `Contains`, `StartsWith` и `EndsWith`, которые транслируются в `LIKE`:

```csharp
// .NET 11, EF Core 11 -- translates to WHERE [o].[CustomerName] LIKE @p + '%'
var orders = await db.Orders
    .Where(o => o.CustomerName.StartsWith(name))
    .ToListAsync();
```

### 2. Вычисляйте значение до запроса, а не внутри него

Огромная доля этих ошибок -- самонанесённые: вы вызываете метод внутри запроса, результат которого на самом деле не зависит от строки. Вынесите его в локальную переменную, и EF Core превратит её в параметр:

```csharp
// Throws: ToString() on a DateTime cannot be translated
var bad = await db.Orders
    .Where(o => o.PlacedOn.ToString("yyyy") == "2026")
    .ToListAsync();

// Fixed: compare the mapped column directly, no formatting in SQL
var year = 2026;
var good = await db.Orders
    .Where(o => o.PlacedOn.Year == year)
    .ToListAsync();
```

`DateTime.Year`, `Month`, `Day`, `Date` и им подобные действительно транслируются (в `DATEPART` на SQL Server), тогда как `ToString(format)` -- нет. Практическое правило: извлекайте нужный вам фрагмент данных свойством, которое EF может сопоставить, вместо того чтобы форматировать всё значение в строку и сравнивать по ней.

### 3. Перенесите чисто клиентскую логику в проекцию верхнего уровня

Помните, что EF Core разрешает вычисление на клиенте в последнем `Select`. Если ваш нетранслируемый метод на самом деле про формирование вывода, а не про фильтрацию, перенесите его туда. Этот запрос фильтрует и сортирует в SQL, а затем выполняет хелпер C# только на вернувшихся строках:

```csharp
// .NET 11, EF Core 11 -- filter in SQL, format on the client in the projection
var rows = await db.Orders
    .Where(o => o.PlacedOn.Year == 2026)      // server
    .OrderByDescending(o => o.PlacedOn)        // server
    .Select(o => new
    {
        o.Id,
        Display = FormatCustomer(o.CustomerName) // client, allowed here
    })
    .ToListAsync();

static string FormatCustomer(string raw) => raw.Trim().ToUpperInvariant();
```

`FormatCustomer` выбросил бы исключение в `Where`, но в финальном `Select` он допустим и выполняется в памяти на уже отфильтрованном наборе результатов. Это санкционированный способ совместить фильтрацию в SQL с форматированием в C#.

### 4. Принудите вычисление на клиенте намеренно (крайняя мера)

Если логика действительно не может выполняться в SQL и должна находиться в `Where`, явно выберите вычисление на клиенте, разорвав запрос с помощью `AsEnumerable` или `AsAsyncEnumerable`. Всё до разрыва выполняется на сервере; всё после -- в памяти:

```csharp
// .NET 11, EF Core 11 -- narrow in SQL first, then filter in memory
var orders = db.Orders
    .Where(o => o.PlacedOn.Year == 2026)   // runs in SQL, cuts the row count down
    .AsAsyncEnumerable();                    // boundary: client evaluation from here

var matched = new List<Order>();
await foreach (var o in orders)
{
    if (o.CustomerName.Equals(name, StringComparison.OrdinalIgnoreCase))
        matched.Add(o);
}
```

Критически важная деталь -- разместить как можно больше фильтрации до границы `AsEnumerable`, чтобы передать наименьшее число строк. Вызов `AsEnumerable()` на голом `DbSet` с последующей фильтрацией скачивает всю таблицу, а это ровно та катастрофа, от которой вас защищало исключение. Предпочитайте здесь `AsAsyncEnumerable`, а не `ToList`, чтобы потоково передавать, а не буферизовать промежуточный результат.

## Подводные камни и варианты

**Работало в EF Core 2.2 и сломалось после обновления.** Вычисление на клиенте где угодно было удалено в EF Core 3.0. Запрос, который "работал" раньше, вероятно, всё это время фильтровал в памяти. Обновление не сломало ваш запрос, оно вскрыло скрытую проблему производительности. Если вы переходите между мажорными версиями, перед началом стоит прочитать про [критические изменения, которые действительно кусаются при миграции с EF Core 6 на EF Core 11](/ru/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).

**Поставщик in-memory не выбрасывает исключение, а настоящий выбрасывает.** Если ваши модульные тесты используют поставщик in-memory, они вычисляют всё на клиенте и никогда не видят эту ошибку, а затем продакшен против SQL Server или PostgreSQL выбрасывает исключение на том же запросе. Тестируйте против поставщика, который транслирует. Запуск вашего набора тестов против настоящей базы данных с чем-то вроде Testcontainers ловит такие случаи до выпуска.

**`GroupBy`, проецирующийся во что-то, что SQL не может агрегировать.** `GroupBy`, за которым следует `Select`, возвращающий сырые сгруппированные сущности (а не агрегаты вроде `Count`, `Sum`, `Max`), часто не может быть транслирован. Переформируйте проекцию в скалярные агрегаты или группируйте на клиенте после материализации.

**Свойства навигации и несопоставленные вычисляемые члены.** Фильтрация по вычисляемому свойству C# (геттер с логикой, а не сопоставленный столбец) не может быть транслирована, потому что за ней нет столбца. Сопоставьте персистентный/вычисляемый столбец или фильтруйте по нижележащим столбцам.

**`Contains` по большому локальному списку.** `Where(o => ids.Contains(o.Id))` действительно транслируется (в `IN` или табличный параметр в EF Core 11), но связанное "could not be translated" может появиться, когда тип элемента сложный. Держите аргумент `Contains` простым списком скаляров.

**Другая ошибка, тот же триггер.** Если вы видите `The LINQ expression could not be translated`, а прямо под ним примечание про `AsSplitQuery`, вы упираетесь в предел трансляции в запросе с несколькими include коллекций, а не в проблему вычисления на клиенте. Это про декартово произведение, и решение -- [разделение запросов, чтобы избежать декартова произведения в EF Core 11](/ru/2026/06/how-to-use-query-splitting-to-avoid-a-cartesian-explosion-in-ef-core-11/), а не переписывание предиката.

Ментальная модель, которая навсегда убережёт вас от этой ошибки: всё, кроме финального `Select`, должно стать SQL. Прежде чем писать `Where`, спросите себя, смогла бы база данных его выполнить. Если ответ связан с методом C#, о котором база данных никогда не слышала, либо найдите эквивалент в `EF.Functions`, либо предварительно вычислите значение, либо примите, что вы загружаете строки в память, и скажите об этом явно с помощью `AsAsyncEnumerable`.

## Связанное

- [Как обнаружить запросы N+1 в EF Core 11](/ru/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) охватывает другую тихую ловушку производительности запросов, которая переживает блокировку вычисления на клиенте.
- [AsNoTracking vs AsNoTrackingWithIdentityResolution в EF Core 11](/ru/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/) стоит прочитать, когда ваши запросы на чтение транслируются чисто и вы хотите сделать их быстрее.
- [Как сопоставлять и запрашивать столбцы JSON в EF Core 11](/ru/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) показывает, как удерживать предикаты JSON на сервере вместо материализации и фильтрации.
- [Как использовать скомпилированные запросы с EF Core для горячих путей](/ru/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) помогает, когда ваш запрос уже транслируется и вы настраиваете пропускную способность.
- [Как использовать ExecuteUpdate и ExecuteDelete для массовых записей в EF Core 11](/ru/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) -- это аналог со стороны записи для удержания работы в базе данных, а не в памяти.

## Источники

- [Вычисление на клиенте vs на сервере, документация EF Core](https://learn.microsoft.com/en-us/ef/core/querying/client-eval)
- [Как работают запросы, документация EF Core](https://learn.microsoft.com/en-us/ef/core/querying/how-query-works)
- [Функции базы данных и EF.Functions, документация EF Core](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/functions)
- [dotnet/efcore issue #24318: "could not be translated" с поставщиком in-memory](https://github.com/dotnet/efcore/issues/24318)
