---
title: "Решение: \"An exception was thrown while attempting to evaluate a LINQ query parameter expression\" в EF Core 11"
description: "EF Core выбрасывает это, когда вычисляемая на клиенте часть запроса падает во время вычисления. Прочитайте InnerException, включите EnableSensitiveDataLogging и вынесите проверку на null за пределы лямбды."
pubDate: 2026-08-19
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "dotnet"
  - "linq"
lang: "ru"
translationOf: "2026/08/fix-an-exception-was-thrown-while-attempting-to-evaluate-a-linq-query-parameter-expression"
translatedBy: "claude"
translationDate: 2026-08-19
---

Это не сбой трансляции. EF Core 11 выбрасывает `An exception was thrown while attempting to evaluate a LINQ query parameter expression`, когда он уже решил, что поддерево вашего запроса вычислимо на клиенте (это "параметр запроса"), и **ваш собственный код упал, пока EF его вычислял**. В девяти случаях из десяти настоящая ошибка, это `NullReferenceException` на захваченном объекте, и лежит она в `InnerException`. Вызовите `EnableSensitiveDataLogging()` на своём `DbContextOptionsBuilder`, чтобы EF напечатал точное выражение, на котором он споткнулся, а затем вынесите проверку на null из лямбды в место сборки запроса. Всё описанное ниже проверено на `Microsoft.EntityFrameworkCore` 10.0.11 и .NET 10; место выброса исключения символ в символ совпадает в предварительных версиях EF Core 11, так что поведение переносится без изменений.

## Ошибка в контексте

У этого сообщения есть два варианта, и какой из них вы получите, целиком зависит от того, включено ли журналирование чувствительных данных. Без него:

```
System.InvalidOperationException: An exception was thrown while attempting to evaluate a LINQ query parameter expression. See the inner exception for more information. To show additional information call 'DbContextOptionsBuilder.EnableSensitiveDataLogging'.
 ---> System.NullReferenceException: Object reference not set to an instance of an object.
   at System.Linq.Expressions.Interpreter.Instruction.NullCheck(Object o)
   at System.Linq.Expressions.Interpreter.FuncCallInstruction`2.Run(InterpretedFrame frame)
   at System.Linq.Expressions.Interpreter.Interpreter.Run(InterpretedFrame frame)
   at System.Linq.Expressions.Interpreter.LightLambda.Run(Object[] arguments)
   at Microsoft.EntityFrameworkCore.Query.Internal.ExpressionTreeFuncletizer.<Evaluate>g__EvaluateCore|74_0(...)
   --- End of inner exception stack trace ---
   at Microsoft.EntityFrameworkCore.Query.Internal.ExpressionTreeFuncletizer.Evaluate(...)
   at Microsoft.EntityFrameworkCore.Query.Internal.ExpressionTreeFuncletizer.ProcessEvaluatableRoot(...)
   at Microsoft.EntityFrameworkCore.Query.Internal.ExpressionTreeFuncletizer.VisitBinary(BinaryExpression binary)
```

С включённым `EnableSensitiveDataLogging()` сообщение меняется на куда более полезный вариант, который называет само выражение:

```
System.InvalidOperationException: An exception was thrown while attempting to evaluate the LINQ query parameter expression 'value(Program+<>c__DisplayClass0_0).filter.MinRating'. See the inner exception for more information.
 ---> System.NullReferenceException: Object reference not set to an instance of an object.
```

Обратите внимание на артикль: в нечувствительном сообщении сказано "a LINQ query parameter expression", в чувствительном, "the LINQ query parameter expression '...'". Если вы искали одно, а попали сюда с другим, вы всё равно на нужной странице. Оба варианта берутся из одной пары строк ресурсов, `ExpressionParameterizationException` и `ExpressionParameterizationExceptionSensitive`.

`<>c__DisplayClass0_0` в этом выражении, это сгенерированный компилятором класс замыкания, который хранит захваченные локальные переменные. `filter`, это захваченная переменная, `MinRating`, это обращение к члену, которое взорвалось. Одной этой строки обычно достаточно, чтобы найти нужную строку кода.

## Почему это происходит

Прежде чем построить SQL, EF обходит дерево выражения и делит его на два вида узлов: те, что зависят от корня запроса (`b.Rating`, он станет колонкой), и те, что не зависят (`filter.MinRating`, он станет параметром SQL). Вторую категорию EF называет функклетизацией, и занимается ею `ExpressionTreeFuncletizer`. Для каждого вычислимого поддерева EF компилирует `Func<object>` и вызывает его:

```csharp
// Microsoft.EntityFrameworkCore 11, ExpressionTreeFuncletizer.EvaluateCore
try
{
    return Lambda<Func<object>>(Convert(expression, typeof(object)))
        .Compile(preferInterpretation: true)
        .Invoke();
}
catch (Exception exception)
{
    throw new InvalidOperationException(
        _logger.ShouldLogSensitiveData()
            ? CoreStrings.ExpressionParameterizationExceptionSensitive(expression)
            : CoreStrings.ExpressionParameterizationException,
        exception);
}
```

Вот и весь механизм. Любое исключение, которое ваш код бросает внутри захваченного выражения, заворачивается в этот `InvalidOperationException` и перебрасывается заново. EF не жалуется на ваш запрос, он сообщает, что выполнение его куска провалилось.

Для отладки это важно. Сообщение намеренно сделано общим, потому что текст выражения может содержать пользовательские данные, и именно поэтому подробный вариант закрыт журналированием чувствительных данных. Конкретная ошибка всегда лежит в `InnerException`, а трассировка стека внутреннего исключения указывает на `System.Linq.Expressions.Interpreter`, а не на ваш код, потому что EF компилирует с `preferInterpretation: true`. Не ищите там свои собственные кадры стека. Читайте тип и сообщение внутреннего исключения.

Сравните это с родственной ошибкой `The LINQ expression could not be translated`, которая срабатывает, когда EF вообще не может превратить конструкцию в SQL. Другая стадия конвейера, другое решение.

## Минимальное воспроизведение

`DbSet<Blog>`, допускающий null DTO фильтра и `Where`, который его разыменовывает:

```csharp
// .NET 10, C# 14, Microsoft.EntityFrameworkCore.Sqlite 10.0.11
using Microsoft.EntityFrameworkCore;

public class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public int Rating { get; set; }
}

public class Filter { public int MinRating { get; set; } }

public class AppDb(DbContextOptions<AppDb> o) : DbContext(o)
{
    public DbSet<Blog> Blogs => Set<Blog>();
}
```

```csharp
// .NET 10, C# 14, EF Core 10.0.11
Filter? filter = null;                                      // came back null from the request binder
var q = db.Blogs.Where(b => b.Rating >= filter!.MinRating); // no exception yet
var rows = q.ToList();                                      // throws here
```

Две детали, которые стоит усвоить:

- **Сборка запроса ничего не выбрасывает.** Построить `IQueryable` бесплатно. Функклетизация выполняется при компиляции запроса, а это происходит на терминальном операторе. Я подтвердил это, собрав запрос и ни разу его не перечислив: исключения нет.
- **Любой терминальный оператор выбрасывает, включая `ToQueryString()`.** `ToList()`, `ToListAsync()`, `Any()`, `Count()` и `ToQueryString()` идут по одному и тому же пути компиляции. Последний удобен, потому что позволяет воспроизвести всё это вообще без подключения к базе данных.

Вот внутренние исключения, которые я измерил для самых частых триггеров, все на EF Core 10.0.11 с провайдером SQLite:

| Что вы написали | `InnerException` |
| --- | --- |
| `b.Rating >= filter!.MinRating` при `filter` равном null | `NullReferenceException` |
| `b.Rating >= config.MinRating`, где геттер бросает | ваше собственное исключение, дословно |
| `b.Rating == maybe!.Value` при `int? maybe = null` | `InvalidOperationException: Nullable object must have a value.` |
| `b.Rating == empty.First()` на пустом `List<int>` | `InvalidOperationException: Sequence contains no elements` |
| `b.Rating == int.Parse(raw)` при `raw = "not-a-number"` | `FormatException` |
| `b.Rating == map["nope"]` на `Dictionary<string, int>` | `KeyNotFoundException` |
| `b.Rating >= Bad.Value`, где падает статический инициализатор | `TargetInvocationException`, оборачивающий настоящее |
| `b.Name == s!.Trim()` при `string? s = null` | `NullReferenceException` |

Предпоследняя строка ловит людей дважды: падающий инициализатор статического поля даёт три уровня вложенности. Обёртка, затем `TargetInvocationException`, и только потом то исключение, которое вам действительно нужно. Прочитайте `ex.InnerException.InnerException`, прежде чем решать, что сообщение бесполезно.

## Решение, подробно

У решения всегда одна и та же форма: сделать так, чтобы захваченное выражение не могло упасть, когда EF его вычисляет. Есть четыре способа, в порядке предпочтения.

### 1. Собирать запрос условно, вне лямбды

Это правильное решение для подавляюще частого случая "необязательного фильтра", и оно вдобавок даёт лучший SQL, потому что предикат исчезает целиком, когда фильтра нет:

```csharp
// .NET 10, C# 14, EF Core 10.0.11
IQueryable<Blog> q = db.Blogs;

if (filter is not null)
{
    q = q.Where(b => b.Rating >= filter.MinRating);
}

var rows = await q.ToListAsync();
```

Проверено при `filter` равном null: исключения нет, и мёртвой конструкции `WHERE` в сгенерированном SQL тоже нет.

### 2. Вынести значение в локальную переменную до запроса

Если значение действительно необязательное, а предикат нет, спроецируйте его в локальную переменную с определённым запасным значением. Тогда EF захватывает `int`, который упасть не может:

```csharp
// .NET 10, C# 14, EF Core 10.0.11
var min = filter?.MinRating ?? int.MinValue;
var rows = await db.Blogs.Where(b => b.Rating >= min).ToListAsync();
```

Это же решение подходит для `int.Parse`, `Guid.Parse` и обращений к словарю. Делайте разбор или поиск до запроса, там, где вы можете нормально обработать сбой, а не внутри лямбды, где сбой приходит завёрнутым на три слоя вглубь.

### 3. Короткое замыкание внутри лямбды

Если всё обязательно должно остаться одним выражением, подойдёт защита через `&&`, `||` или тернарный оператор. Функклетизатор обрабатывает бинарные операторы с коротким замыканием и `ConditionalExpression` особым образом и не вычисляет мёртвую ветку заранее:

```csharp
// .NET 10, C# 14, EF Core 10.0.11
var rows = await db.Blogs
    .Where(b => filter == null || b.Rating >= filter.MinRating)
    .ToListAsync();

// the ternary form behaves identically
var rows2 = await db.Blogs
    .Where(b => filter == null ? true : b.Rating >= filter.MinRating)
    .ToListAsync();
```

Все три варианта (`filter != null && ...`, `filter == null || ...` и тернарный) отработали чисто в моём воспроизведении при `filter` равном null. И всё же ставьте этот способ на третье место по двум причинам: он отправляет в базу данных всегда истинное условие `WHERE`, когда фильтра нет, и опирается на поведение функклетизатора, которое уже менялось между мажорными версиями. Issue [dotnet/efcore#34883](https://github.com/dotnet/efcore/issues/34883), это ровно такая форма, условие, смешивающее клиентскую проверку с проверкой на стороне базы данных, и в цикле EF Core 9 оно регрессировало до внутренней ошибки `unbound variable`, пока её не исправили.

### 4. Починить то, что падает

Если виновник, это геттер свойства, который бросает, потому что сервис ещё не инициализирован (классика, это резолвер арендатора, читающий пустую окружающую область), ничего из перечисленного не поможет. Запрос в порядке; сломан ваш composition root. Заставьте геттер возвращать значение или падать раньше с сообщением, которое хоть что-то объясняет.

## Подводные камни и варианты

**Фильтры запросов не оборачиваются.** Если ваша лямбда `HasQueryFilter` читает поле на `DbContext` и это чтение падает, вы получите своё исключение в сыром виде, а не это. Я собрал контекст с `HasQueryFilter(b => b.TenantId == _tenant.Current)`, где `_tenant.Current` бросает, и `db.Blogs.ToList()` выдал `InvalidOperationException: no tenant in scope` напрямую. Причина в функклетизаторе: выражения, которые касаются контекста, идут по пути доступа к контексту, который возвращает отложенную `Lambda` вместо того, чтобы вызвать её внутри того самого блока `try`. Так что если вы отлаживаете мультиарендную конфигурацию и всё-таки видите обёртку параметризации, виноватый захват сидит в обычном `Where`, а не в фильтре. Вызов `IgnoreQueryFilters()` заставляет запрос отработать и быстро подтверждает, какой из двух случаев у вас.

**Коллекция, равная null, внутри `Contains` не падает. Она молча ничего не возвращает.** Это самый опасный вариант на странице, потому что он выглядит как решение:

```csharp
// .NET 10, C# 14, EF Core 10.0.11, SQLite provider
List<string>? names = null;
var rows = db.Blogs.Where(b => names!.Contains(b.Name)).ToList();
// rows.Count == 0, no exception
// SELECT "b"."Id", "b"."Name", "b"."Rating" FROM "Blogs" AS "b" WHERE 0
```

EF транслирует параметризованную коллекцию, равную null, во всегда ложный предикат, ровно так же, как и пустую. Вы получаете не ошибку, а ноль строк, и баг уезжает в продакшен. Если в вашей предметной области список, равный null, означает "без фильтра", скажите это явно защитой `names is null ||` или соберите запрос условно, как в решении 1.

**`EF.Constant` вас не спасёт.** Обёртка захвата в `EF.Constant(filter!.MinRating)` всё равно падает. Разыменование происходит при вычислении аргумента, ещё до того, как EF вообще увидит маркерный метод.

**Сырое `NullReferenceException` вместо обёртки означает, что падение произошло в вашем коде, а не в коде EF.** `db.Blogs.Take(filter!.MinRating)` бросает обычное `NullReferenceException`, потому что `Take` принимает `int`: компилятор C# вычисляет этот аргумент в точке вызова, и он никогда не становится частью дерева выражения. То же самое с `Skip` и со всем, что вы интерполируете в строку до передачи. Обёртку получают только лямбды.

**Цепочка не помогает.** Разбиение на `db.Blogs.Where(b => b.Id == 0).Where(b => b.Rating >= filter!.MinRating)` всё равно падает. Функклетизация проходит по всему собранному дереву во время компиляции, а не по одному оператору за раз, так что ранний фильтр не может закоротить более поздний захват.

**Падает при каждом выполнении, а не только при первом.** Кеш скомпилированных запросов ключуется по форме запроса, а функклетизация выполняется до обращения к кешу, чтобы извлечь значения параметров. Здесь не бывает "сработало один раз, а потом сломалось".

## Похожие материалы

- Другое исключение EF Core времени выполнения запроса, с которым это часто путают, разобрано в [почему EF Core говорит, что выражение LINQ не удалось транслировать](/ru/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/), там речь о конструкциях, которые EF вообще не может превратить в SQL.
- Когда внутреннее исключение, это `Sequence contains no elements`, стоит прочитать про поведение самого оператора LINQ в [что на самом деле бросает First и Single](/ru/2026/07/fix-invalidoperationexception-sequence-contains-no-elements/).
- Включение чувствительного варианта этого сообщения, это одна строка из более широкой настройки, описанной в [как увидеть SQL, который генерирует EF Core](/ru/2026/07/how-to-log-the-sql-that-ef-core-11-generates/).
- Если вы наткнулись на это, настраивая мультиарендность, [именованные фильтры запросов для мягкого удаления и мультиарендности](/ru/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/) показывают, как передать id арендатора в контекст без падающего геттера.
- Параметризация также управляет поведением кеша, что важно, когда вы гонитесь за производительностью запросов с помощью [скомпилированных запросов на горячих путях](/ru/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/).

## Источники

- [CoreStrings.ExpressionParameterizationException](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.diagnostics.corestrings.expressionparameterizationexception) на MS Learn, за точной строкой ресурса.
- [ExpressionTreeFuncletizer.cs](https://github.com/dotnet/efcore/blob/main/src/EFCore/Query/Internal/ExpressionTreeFuncletizer.cs) в dotnet/efcore, где живёт оборачивающий try/catch.
- [Вычисление на клиенте и на сервере](https://learn.microsoft.com/en-us/ef/core/querying/client-eval) в документации EF Core, о том, как EF делит дерево запроса.
- [DbContextOptionsBuilder.EnableSensitiveDataLogging](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.dbcontextoptionsbuilder.enablesensitivedatalogging), который включает вариант сообщения с именем выражения.
- [dotnet/efcore#34883](https://github.com/dotnet/efcore/issues/34883), регрессия EF Core 9, где смешанное клиентско-серверное условие давало это исключение с внутренней ошибкой `unbound variable`.
- [Обсуждение #792 в Finbuckle.MultiTenant](https://github.com/Finbuckle/Finbuckle.MultiTenant/discussions/792), характерный отчёт об этой ошибке в мультиарендном контексте.
