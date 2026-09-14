---
title: "Исправление: InvalidOperationException: Nullable object must have a value в проекции EF Core 11"
description: "EF Core выбрасывает это исключение, когда Select читает SQL NULL в int, decimal или DateTime, не допускающий null. Приведите член к типу, допускающему null, и добавьте ?? default, либо защитите навигацию проверкой на null."
pubDate: 2026-09-14
template: error-page
tags:
  - "errors"
  - "efcore"
  - "dotnet"
  - "linq"
lang: "ru"
translationOf: "2026/09/fix-nullable-object-must-have-a-value-in-an-ef-core-11-projection"
translatedBy: "claude"
translationDate: 2026-09-14
---

EF Core выбрасывает `InvalidOperationException: Nullable object must have a value`, когда SQL, сгенерированный для вашего `Select`, возвращает `NULL` в столбце, который проекция присваивает значимому типу, не допускающему null (`int`, `decimal`, `DateTime`, `Guid`, структура). Обычные виновники: необязательная навигация (`o.Customer.Rating` у заказа без клиента), `Max`/`Min`/`Average` по пустой коллекции и целый DTO, взятый с пустой стороны соединения через `DefaultIfEmpty`. Исправление состоит в том, чтобы сделать допустимость null видимой в LINQ: привести к типу, допускающему null (`(int?)o.Customer.Rating`), и задать значение по умолчанию через `?? 0`, либо написать `o.Customer == null ? 0 : o.Customer.Rating`. Все результаты ниже получены на `Microsoft.EntityFrameworkCore` 11.0.0-rc.1.26425.128 на .NET 11 RC 1 и сопоставлены с EF Core 10.0.12. Один случай появился только в EF Core 11: проекция сложной коллекции JSON вместе с навигацией-коллекцией. Это настоящая регрессия, и ей посвящён отдельный раздел.

## Ошибка в контексте

В случае ошибки времени выполнения исключение исходит от скомпилированного shaper, а не от вашего кода или драйвера базы данных. Из-за этого трассировка стека выглядит бесполезной:

```
System.InvalidOperationException: Nullable object must have a value.
   at lambda_method272(Closure, QueryContext, DbDataReader, ResultContext, SingleQueryResultCoordinator)
   at Microsoft.EntityFrameworkCore.Query.Internal.SingleQueryingEnumerable`1.Enumerator.MoveNext()
   at System.Collections.Generic.List`1..ctor(IEnumerable`1 collection)
```

`lambda_method` это материализатор, который EF Core скомпилировал для вашей проекции. Он читает каждый столбец как значение, допускающее null, а затем вызывает `.Value`, чтобы поместить его в ваш член, не допускающий null. Когда в столбце `NULL`, `Nullable<T>.Value` выбрасывает исключение, и вы получаете то же сообщение, что и от `((int?)null).Value` в обычном C#. Запрос транслировался без проблем, и SQL выполнился без проблем. Сбой произошёл при преобразовании строки в объект.

Если же верхние кадры это ``System.Nullable`1.get_Value()`` и `SelectExpression.ClientProjectionRemappingExpressionVisitor.VisitExtension`, то запрос упал на этапе компиляции, ещё до выполнения какого-либо SQL. Исключение выбрасывает даже `ToQueryString()`. Это регрессия EF Core 11, разобранная ниже в разделе о сложной коллекции JSON.

## Почему так происходит

LINQ-to-Objects и SQL по-разному понимают, что значит "отсутствует". В C# `order.Customer.Rating` при `Customer`, равном null, выбрасывает `NullReferenceException`, а `new List<decimal>().Max()` выбрасывает `Sequence contains no elements`. В SQL `LEFT JOIN` без совпадения даёт столбцы со значением `NULL`, а `MAX` по нулю строк возвращает `NULL`. EF Core транслирует запрос в семантику SQL, поэтому на стороне базы данных исключения не возникает. Затем `NULL` возвращается в член CLR, который не может его хранить.

EF Core уже компенсирует это в нескольких местах. `Sum` оборачивается в `COALESCE(..., 0)`, скалярный `FirstOrDefault()` в подзапросе оборачивается в `ISNULL`, а материализация сущностей проверяет ключевые столбцы перед созданием объекта. Ошибка появляется в тех местах, которые не покрыты. Эти пробелы одинаковы в EF Core 10 и 11, за исключением одного исправления и одной регрессии.

## Минимальное воспроизведение

В модели есть заказы с необязательным клиентом и один клиент ("Bob") вообще без заказов:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128 (same model on EF Core 10.0.12)
public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public int Rating { get; set; }
    public List<Order> Orders { get; set; } = [];
}

public class Order
{
    public int Id { get; set; }
    public decimal Total { get; set; }
    public int? CustomerId { get; set; }     // optional relationship
    public Customer? Customer { get; set; }
}

// seed: Ana (Rating 5) with one order, Bob with none, plus one guest order with CustomerId = null
var rows = db.Orders
    .Select(o => new { o.Id, Rating = o.Customer!.Rating })
    .ToList(); // InvalidOperationException: Nullable object must have a value.
```

`!` заглушает предупреждение о допустимости null. Во время выполнения он ничего не делает. EF Core генерирует обычный `LEFT JOIN`:

```sql
-- EF Core 11 RC 1, SQL Server provider, via ToQueryString()
SELECT [o].[Id], [c].[Rating]
FROM [Orders] AS [o]
LEFT JOIN [Customers] AS [c] ON [o].[CustomerId] = [c].[Id]
```

В строке гостевого заказа в `[c].[Rating]` стоит `NULL`, и член `int Rating` анонимного типа не может его принять. Именованный DTO (`new OrderDto { Rating = o.Customer!.Rating }`) и голый скаляр (`Select(o => o.Customer!.Rating)`) падают точно так же.

## Исправления в порядке предпочтения

### 1. Приведите к типу, допускающему null, и выберите значение по умолчанию

Это самое распространённое исправление с самым дешёвым SQL:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var rows = db.Orders
    .Select(o => new { o.Id, Rating = (int?)o.Customer!.Rating ?? 0 })
    .ToList(); // { Id = 1, Rating = 0 } | { Id = 2, Rating = 5 }
```

```sql
SELECT [o].[Id], ISNULL([c].[Rating], 0)
FROM [Orders] AS [o]
LEFT JOIN [Customers] AS [c] ON [o].[CustomerId] = [c].[Id]
```

Если для вызывающего кода "нет клиента" и "рейтинг 0" означают разное, уберите `?? 0` и сделайте член DTO типа `int?`. Так различие сохранится, и обычно это честнее, чем выдумывать ноль.

### 2. Явно защитите навигацию

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var rows = db.Orders
    .Select(o => new { o.Id, Rating = o.Customer == null ? 0 : o.Customer.Rating })
    .ToList();
```

EF Core превращает проверку на null в проверку присоединённого ключа, а это правильный сигнал "совпало ли соединение", даже если сам член является столбцом, допускающим null:

```sql
SELECT [o].[Id], CASE
    WHEN [c].[Id] IS NULL THEN 0
    ELSE [c].[Rating]
END
FROM [Orders] AS [o]
LEFT JOIN [Customers] AS [c] ON [o].[CustomerId] = [c].[Id]
```

Используйте эту форму, когда проецируете несколько членов из одной и той же необязательной навигации или когда член является строкой либо другим ссылочным типом и вам нужно свойство DTO, не допускающее null.

### 3. Агрегаты по коллекциям, которые могут быть пустыми

`Sum` безопасен. `Max`, `Min` и `Average` нет. Одинаково на EF Core 11 RC 1 и 10.0.12:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
db.Customers.Select(c => new { c.Name, Biggest = c.Orders.Max(o => o.Total) });      // throws for Bob
db.Customers.Select(c => new { c.Name, Avg = c.Orders.Average(o => o.Total) });      // throws for Bob
db.Customers.Select(c => new { c.Name, Sum = c.Orders.Sum(o => o.Total) });          // Bob = 0.0
db.Customers.Select(c => new { c.Name, Last = c.Orders.OrderBy(o => o.Id)
                                                .Select(o => o.Total).FirstOrDefault() }); // Bob = 0.0
```

Сгенерированный SQL показывает причину. `Sum` получает `COALESCE(SUM([o].[Total]), 0.0)`, а подзапрос `FirstOrDefault` получает `ISNULL((SELECT TOP(1) ...), 0.0)`. `MAX` и `AVG` проходят без обёртки. Исправление то же самое приведение, только внутри селектора агрегата:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var rows = db.Customers.Select(c => new
{
    c.Name,
    Biggest  = c.Orders.Max(o => (decimal?)o.Total) ?? 0m,
    Smallest = c.Orders.Min(o => (decimal?)o.Total) ?? 0m,
    Avg      = c.Orders.Average(o => (decimal?)o.Total) ?? 0m,
}).ToList(); // Bob: 0, 0, 0
```

`c.Orders.Select(o => o.Total).DefaultIfEmpty().Max()` тоже работает, но компилируется в `LEFT JOIN` к производной таблице `SELECT 1 AS empty` из одной строки. Приведение к типу, допускающему null, даёт более простой SQL с тем же результатом.

### 4. Соединения через `DefaultIfEmpty`, проецирующие DTO

Это форма из [dotnet/efcore#30915](https://github.com/dotnet/efcore/issues/30915): ручное левое соединение, у которого внутренняя сторона является проецируемым DTO, а не сущностью.

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var rows =
    (from o in db.Orders
     join c in db.Customers.Select(c => new CustomerDto { Id = c.Id, Rating = c.Rating })
         on o.CustomerId equals c.Id into cs
     from c in cs.DefaultIfEmpty()
     select new { o.Id, Customer = c })
    .ToList(); // throws on EF Core 11 RC 1 and 10.0.12
```

LINQ-to-Objects дал бы вам `Customer = null` для гостевого заказа. EF Core вместо этого пытается построить `CustomerDto` из столбцов, где все значения `NULL`. Соединяйте сущность, а DTO стройте уже после соединения, за проверкой на null:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var rows =
    (from o in db.Orders
     join c in db.Customers on o.CustomerId equals c.Id into cs
     from c in cs.DefaultIfEmpty()
     select new
     {
         o.Id,
         Customer = c == null ? null : new CustomerDto { Id = c.Id, Rating = c.Rating }
     })
    .ToList(); // { Id = 1, Customer = null } | { Id = 2, Customer = CustomerDto 1 Rating=5 }
```

Когда на внутренней стороне сущность, EF Core может проверить ключевой столбец и решить, совпала ли строка. С простым проецируемым DTO проверять нечего. Команда EF отслеживает именно этот вариант в [dotnet/efcore#38608](https://github.com/dotnet/efcore/issues/38608), который всё ещё открыт, и говорит, что для исправления нужна переработка раскрытия навигаций.

## Что EF Core 11 уже исправил: `LeftJoin` к `GroupBy`

Одно семейство случаев в EF Core 11 действительно стало лучше. Это `LeftJoin` (оператор, добавленный в .NET 10, см. [операторы соединения LINQ в .NET 10 и 11](/ru/2026/06/linq-fulljoin-tuple-returning-joins-dotnet-11-preview-5/)) к сгруппированному агрегату, о котором сообщили в [dotnet/efcore#38055](https://github.com/dotnet/efcore/issues/38055):

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var counts = db.Orders.GroupBy(o => o.CustomerId, (k, g) => new { CustomerId = k, Count = g.Count() });

var rows = db.Customers
    .LeftJoin(counts, c => (int?)c.Id, g => g.CustomerId, (c, g) => new { c, g })
    .Select(x => new { x.c.Name, Count = x.g == null ? 0 : x.g.Count })
    .ToList();
// EF Core 10.0.12: InvalidOperationException: Nullable object must have a value.
// EF Core 11 RC 1: { Name = Ana, Count = 1 } | { Name = Bob, Count = 0 }
```

Теперь EF Core 11 добавляет во внутренний подзапрос синтетический столбец и создаёт объект только при его наличии:

```sql
SELECT [c].[Name], [o0].[CustomerId], [o0].[Count], [o0].[marker]
FROM [Customers] AS [c]
LEFT JOIN (
    SELECT [o].[CustomerId], COUNT(*) AS [Count], 1 AS [marker]
    FROM [Orders] AS [o]
    GROUP BY [o].[CustomerId]
) AS [o0] ON [c].[Id] = [o0].[CustomerId]
```

`[marker]` равен `NULL` только тогда, когда соединение не нашло совпадения, так что `x.g == null` наконец означает ровно то, что написано. Это появилось в [dotnet/efcore#38479](https://github.com/dotnet/efcore/pull/38479) (слит в июне 2026), с доработками для проекций значимых типов ([#38555](https://github.com/dotnet/efcore/pull/38555)) и последующих соединений ([#38499](https://github.com/dotnet/efcore/pull/38499)). Ни одно из этих изменений не было перенесено в 10.0.x. На EF Core 10 выполняйте приведение внутри группировки (`Count = (int?)g.Count()`) и читайте `x.g!.Count ?? 0`: это работает в обеих версиях и даёт `ISNULL([o0].[Count], 0)`.

## Регрессия EF Core 11 RC 1: сложная коллекция JSON плюс навигация-коллекция

Здесь проблема вообще не в данных. Проекция сложной коллекции, отображённой на JSON (`ComplexCollection(...).ToJson()`, см. [отображение столбцов JSON в EF Core 11](/ru/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/)), вместе с навигацией-коллекцией в одном `Select` выбрасывает исключение во время компиляции запроса:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
modelBuilder.Entity<Parent>(e =>
{
    e.ComplexCollection(p => p.Items).ToJson();
    e.HasMany(p => p.Links).WithMany(l => l.Parents);
});

var dtos = db.Parents
    .Select(p => new ParentDto
    {
        Name = p.Name,
        Items = p.Items,                                  // JSON complex collection
        Links = p.Links.Select(l => l.Name).ToList(),     // collection navigation
    })
    .ToList();
// EF Core 10.0.12: works
// EF Core 11 RC 1: InvalidOperationException: Nullable object must have a value.
//   at System.Nullable`1.get_Value()
//   at ...SelectExpression.ClientProjectionRemappingExpressionVisitor.VisitExtension(Expression expression)
```

По отдельности каждая половина работает. `AsSplitQuery()` не помогает, потому что сбой происходит до того, как EF Core решает, как разделять запрос. Это [dotnet/efcore#38928](https://github.com/dotnet/efcore/issues/38928), помеченный как регрессия начиная с 11.0.0-preview.1. Исправление, [dotnet/efcore#38932](https://github.com/dotnet/efcore/pull/38932), слито в `main` 2026-09-09. Перенос в `release/11.0`, [#38948](https://github.com/dotnet/efcore/pull/38948), на 2026-09-14 всё ещё открыт, так что в RC 1 ошибка есть, а исправление должно появиться в одном из следующих RC или в GA. До тех пор либо загрузите сущность через `Include` и выполните отображение в памяти:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var dtos = (await db.Parents.Include(p => p.Links).AsNoTracking().ToListAsync())
    .Select(p => new ParentDto { Name = p.Name, Items = p.Items, Links = p.Links.Select(l => l.Name).ToList() })
    .ToList();
```

либо выполните две проекции (одну для столбца JSON, другую для навигации) и соедините их по ключу. Оба варианта работают на RC 1. Версия с `Include` загружает все столбцы `Link`, поэтому для широких таблиц используйте вариант с двумя запросами.

## Похожие ошибки, которые приводят сюда

- **`The data is NULL at ordinal 1. This method can't be called on NULL values`** (SQLite) или **`SqlNullValueException: Data is Null`** (SQL Server): столбец, допускающий null в базе данных, отображён на свойство, не допускающее null. Типично для моделей database-first и представлений. Провайдер выбрасывает исключение при чтении столбца, ещё до того, как его увидит shaper EF Core. Проверено только на SQLite. Исправлять нужно модель: сделайте свойство `int?` или исправьте столбец. Ни `(int?)p.Stock`, ни `(int?)p.Stock ?? -1` в проекции не помогают (оба по-прежнему выбрасывают исключение на EF Core 11 RC 1), потому что EF Core доверяет модели и читает столбец через `GetInt32`.
- **`Sequence contains no elements`**: вариант той же проблемы пустого множества в LINQ-to-Objects или `First()`/`Single()`, выполненный в памяти. См. [отдельную статью](/ru/2026/07/fix-invalidoperationexception-sequence-contains-no-elements/).
- **`An exception was thrown while attempting to evaluate a LINQ query parameter expression`**, оборачивающее `Nullable object must have a value`: это ваш собственный `maybe!.Value`, который вычисляется на стороне клиента как параметр, до любого SQL. Этот случай разобран в [статье о вычислении параметров](/ru/2026/08/fix-an-exception-was-thrown-while-attempting-to-evaluate-a-linq-query-parameter-expression/).

## Как быстро найти проблемный столбец

Трассировка стека shaper никогда не называет член. Два быстрых способа его найти:

1. Вызовите `query.ToQueryString()` и поищите столбец с допускающей null стороны `LEFT JOIN`, `OUTER APPLY` или голый подзапрос `MAX`/`MIN`/`AVG`. Другие варианты описаны в статье [журналирование SQL, который генерирует EF Core 11](/ru/2026/07/how-to-log-the-sql-that-ef-core-11-generates/).
2. Временно измените проекцию на `(int?)` / `(decimal?)` для каждого члена значимого типа, выполните её и посмотрите, какой из них вернётся как `null`. Именно этот член и нужно исправить.

Если исключение выбрасывает сам `ToQueryString()`, проблема на этапе компиляции. На EF Core 11 RC 1 проверьте, нет ли в запросе описанной выше формы JSON плюс навигация. Если сбой происходит при трансляции, а не при материализации, вы обычно увидите другое сообщение, которое разобрано в [руководстве по "could not be translated"](/ru/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/).

Замечание о методике: все количества строк и исключения выше получены выполнением запросов к SQLite в памяти на обеих версиях EF Core. SQL для SQL Server сгенерирован через `ToQueryString()`, но не выполнялся. Материализатор, выбрасывающий исключение, не зависит от провайдера, поэтому те же проекции точно так же падают на SQL Server, но для этой статьи я не запускал экземпляр SQL Server.

## Источники

- [dotnet/efcore#38928](https://github.com/dotnet/efcore/issues/38928): регрессия сложной коллекции JSON плюс навигации-коллекции; исправление [#38932](https://github.com/dotnet/efcore/pull/38932), перенос [#38948](https://github.com/dotnet/efcore/pull/38948).
- [dotnet/efcore#30915](https://github.com/dotnet/efcore/issues/30915) и [#38055](https://github.com/dotnet/efcore/issues/38055): левые соединения с проекциями, не являющимися сущностями; частичное исправление в [#38479](https://github.com/dotnet/efcore/pull/38479).
- [dotnet/efcore#38608](https://github.com/dotnet/efcore/issues/38608): вариант `DefaultIfEmpty` с простым проецируемым DTO, который всё ещё открыт.
- [dotnet/efcore#33802](https://github.com/dotnet/efcore/issues/33802): непоследовательное поведение агрегатов по пустым коллекциям.
- [dotnet/efcore#35950](https://github.com/dotnet/efcore/issues/35950): регрессия `COALESCE` в `DefaultIfEmpty` в EF Core 9, исправленная в EF Core 10.
- [Complex query operators in EF Core](https://learn.microsoft.com/ef/core/querying/complex-query-operators) на Microsoft Learn.
