---
title: "Как писать переиспользуемые предикаты LINQ, которые EF Core транслирует в Where, Select и OrderBy"
description: "Вспомогательный метод, возвращающий bool, бросает \"could not be translated\". Expression<Func<T, bool>> не бросает. Разбираем, как компоновать, вкладывать и переиспользовать деревья выражений в EF Core 11 без LINQKit, с реальным SQL для каждого случая."
pubDate: 2026-08-23
tags:
  - "ef-core"
  - "linq"
  - "csharp"
  - "dotnet"
lang: "ru"
translationOf: "2026/08/how-to-write-reusable-linq-predicates-ef-core-can-translate"
translatedBy: "claude"
translationDate: 2026-08-23
---

Правило короткое: EF Core транслирует только то, что к моменту передачи провайдеру всё ещё остаётся деревом выражения. Вспомогательный метод `static bool IsActive(Customer c)` компилируется в узел вызова метода и бросает исключение во время выполнения; та же логика, сохранённая как `static readonly Expression<Func<Customer, bool>> IsActive`, транслируется без проблем и допускает компоновку, вложение и перепривязку к другим типам сущностей. Большинство руководств ошибается в одном: якобы для компоновки таких деревьев нужен `AsExpandable()` из LINQKit. Не нужен: `Expression.Invoke` транслируется начиная с EF Core 3.1, а каждый фрагмент SQL ниже получен из EF Core 11.0.0-preview.7.26381.103 с провайдером SQL Server через `ToQueryString()`.

## Почему bool-метод бросает исключение, а выражение нет

Начнём с формы, к которой почти все тянутся первой, потому что она хорошо читается:

```csharp
// EF Core 11.0.0-preview.7, C# 14
static bool IsActiveMethod(Customer c) => !c.IsDeleted && c.Orders.Count > 0;

db.Customers.Where(c => IsActiveMethod(c));
```

Компилятор C# превращает эту лямбду в дерево выражения, телом которого является `MethodCallExpression`, указывающий на `IsActiveMethod`. Заглянуть внутрь тела скомпилированного метода EF Core не может, поэтому трансляция останавливается:

```
System.InvalidOperationException
The LINQ expression 'DbSet<Customer>()
    .Where(c => Helpers.IsActiveMethod(c))' could not be translated. Either rewrite
the query in a form that can be translated, or switch to client evaluation explicitly
by inserting a call to 'AsEnumerable', 'AsAsyncEnumerable', 'ToList', or 'ToListAsync'.
```

Это задокументированное поведение: частичное вычисление на клиенте EF Core поддерживает только в проекции верхнего уровня, а для всего непереводимого в остальных частях запроса бросает исключение, о чём говорит [руководство по вычислению на клиенте и на сервере](https://learn.microsoft.com/en-us/ef/core/querying/client-eval). Если вы уже сталкивались с этим в других формах, полный разбор есть в [статье про "The LINQ expression could not be translated"](/ru/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/).

Сохраните ту же логику как выражение, и в месте вызова ничего не изменится:

```csharp
static readonly Expression<Func<Customer, bool>> IsActive =
    c => !c.IsDeleted && c.Orders.Count > 0;

db.Customers.Where(IsActive);
```

```sql
SELECT [c].[Id], [c].[Country], [c].[IsDeleted], [c].[Name]
FROM [Customers] AS [c]
WHERE [c].[IsDeleted] = CAST(0 AS bit) AND EXISTS (
    SELECT 1
    FROM [Orders] AS [o]
    WHERE [c].[Id] = [o].[CustomerId])
```

`Queryable.Where` принимает `Expression<Func<T, bool>>`, поэтому передача поля напрямую отдаёт EF всё дерево целиком. То же верно, когда предикат приходит параметром метода, а это основа любой абстракции в стиле specification:

```csharp
static IQueryable<Customer> Filter(IQueryable<Customer> q, Expression<Func<Customer, bool>> p)
    => q.Where(p);
```

В эксперименте это дало идентичный SQL. Как только предикат становится `Func<>` вместо `Expression<Func<>>`, вы снова получаете исключение.

## Компоновка предикатов: Expression.Invoke транслируется в EF Core 11

Интересный случай начинается при объединении двух независимо написанных предикатов. Очевидная попытка проваливается:

```csharp
db.Customers.Where(c => IsActive.Compile()(c) && c.Country == "NL");
```

```
The LINQ expression 'DbSet<Customer>()
    .Where(c => Invoke(Func<Customer, bool>, c) && c.Country == "NL")'
could not be translated.
```

`Compile()` выполняется при построении запроса и кладёт в дерево константу типа `Func<Customer, bool>`. EF видит непрозрачный делегат и сдаётся. Именно этот сбой и гонит людей к LINQKit.

Но если построить вызов как узел выражения, а не как вызов делегата, всё работает уже сегодня:

```csharp
static Expression<Func<T, bool>> And<T>(
    Expression<Func<T, bool>> a, Expression<Func<T, bool>> b)
{
    var p = Expression.Parameter(typeof(T), "x");
    return Expression.Lambda<Func<T, bool>>(
        Expression.AndAlso(Expression.Invoke(a, p), Expression.Invoke(b, p)), p);
}

static Expression<Func<Customer, bool>> InCountry(string country) => c => c.Country == country;

db.Customers.Where(And(IsActive, InCountry("NL")));
```

```sql
DECLARE @c nvarchar(4000) = N'NL';

SELECT [c].[Id], [c].[Country], [c].[IsDeleted], [c].[Name]
FROM [Customers] AS [c]
WHERE [c].[IsDeleted] = CAST(0 AS bit) AND EXISTS (
    SELECT 1
    FROM [Orders] AS [o]
    WHERE [c].[Id] = [o].[CustomerId]) AND [c].[Country] = @c
```

Ни `AsExpandable()`, ни дополнительного пакета. Конвейер запросов EF Core сворачивает узлы `InvocationExpression` до трансляции. Регрессия, сломавшая это в EF Core 3.0, отслеживалась как [dotnet/efcore#17791](https://github.com/dotnet/efcore/issues/17791) и была исправлена к 3.1, но многие советы в сети написаны до этого исправления.

Две детали про этот помощник `And`. Во-первых, затравка `true` или `false`, с которой начинает `PredicateBuilder`, не стоит ничего: `And<Customer>(c => true, InCountry("NL"))` и `Or<Customer>(c => false, InCountry("NL"))` выдали ровно тот же `WHERE [c].[Country] = @c`, без остатка вида `1 = 1`. Упроститель выражений EF сворачивает константу, так что накопительный цикл можно писать прямолинейно.

Во-вторых, `Expression.Invoke` не единственный вариант. Перепривязка параметров через `ExpressionVisitor` даёт более плоское дерево:

```csharp
sealed class Rebind(ParameterExpression from, Expression to) : ExpressionVisitor
{
    protected override Expression VisitParameter(ParameterExpression node)
        => node == from ? to : base.VisitParameter(node);
}

public static Expression<Func<T, bool>> And<T>(
    this Expression<Func<T, bool>> a, Expression<Func<T, bool>> b)
{
    var p = a.Parameters[0];
    var right = new Rebind(b.Parameters[0], p).Visit(b.Body)!;
    return Expression.Lambda<Func<T, bool>>(Expression.AndAlso(a.Body, right), p);
}
```

Обе версии сгенерировали побайтово идентичный SQL. Выбирайте visitor, когда хотите сами осмотреть или дальше преобразовать объединённое дерево, потому что слоя вызова на пути не будет. Выбирайте `Expression.Invoke`, когда хотите написать на двенадцать строк меньше.

## Перепривязка предиката к другому типу сущности

Visitor окупается ровно в тот момент, когда предикат по `Customer` нужно применить к запросу по `Order`. Здесь вы не компонуете два предиката над одним параметром, а подменяете параметр путём доступа к члену:

```csharp
public static Expression<Func<TOuter, bool>> On<TOuter, TInner>(
    this Expression<Func<TInner, bool>> inner,
    Expression<Func<TOuter, TInner>> path)
{
    var body = new Rebind(inner.Parameters[0], path.Body).Visit(inner.Body)!;
    return Expression.Lambda<Func<TOuter, bool>>(body, path.Parameters[0]);
}

db.Orders.Where(IsActive.On((Order o) => o.Customer));
```

```sql
SELECT [o].[Id], [o].[CustomerId], [o].[Total]
FROM [Orders] AS [o]
INNER JOIN [Customers] AS [c] ON [o].[CustomerId] = [c].[Id]
WHERE [c].[IsDeleted] = CAST(0 AS bit) AND EXISTS (
    SELECT 1
    FROM [Orders] AS [o0]
    WHERE [c].[Id] = [o0].[CustomerId])
```

Одно определение "активного клиента", применяемое с обеих сторон, а join написан за вас. Если правило больше похоже на постоянный фильтр, чем на переиспользуемый блок, подумайте, не место ли ему в [именованном фильтре запросов](/ru/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/), чтобы вызывающий код не мог о нём забыть.

## Переиспользуемые проекции в Select

Проекции подчиняются тому же правилу, но с дополнительным способом сломаться. Передача выражения прямо в `Select` работает:

```csharp
static readonly Expression<Func<Customer, CustomerDto>> ToDto =
    c => new CustomerDto(c.Id, c.Name, c.Orders.Count);

db.Customers.Select(ToDto);
```

```sql
SELECT [c].[Id], [c].[Name], (
    SELECT COUNT(*)
    FROM [Orders] AS [o]
    WHERE [c].[Id] = [o].[CustomerId])
FROM [Customers] AS [c]
```

Вложить её в более крупную проекцию через `Compile()` не получится, и исключение отличается от того, что было в `Where`, потому что проекции допускают частичное вычисление на клиенте:

```csharp
db.Orders.Select(o => new { o.Id, Cust = ToDto.Compile()(o.Customer) });
```

```
System.InvalidOperationException
The client projection contains a reference to a constant expression of
'System.Func<Customer, CustomerDto>'. This could potentially cause a memory leak;
consider assigning this constant to a local variable and using the variable in the
query instead.
```

Так EF сообщает, что скомпилированный план запроса удержал бы ваш делегат навсегда. Постройте вложение как узел выражения, и оно транслируется:

```csharp
var p = Expression.Parameter(typeof(Order), "o");
var ctor = typeof(OrderDto).GetConstructor([typeof(int), typeof(CustomerDto)])!;
var body = Expression.New(ctor,
    Expression.Property(p, nameof(Order.Id)),
    Expression.Invoke(ToDto, Expression.Property(p, nameof(Order.Customer))));

db.Orders.Select(Expression.Lambda<Func<Order, OrderDto>>(body, p));
```

```sql
SELECT [o].[Id], [c].[Id], [c].[Name], (
    SELECT COUNT(*)
    FROM [Orders] AS [o0]
    WHERE [c].[Id] = [o0].[CustomerId])
FROM [Orders] AS [o]
INNER JOIN [Customers] AS [c] ON [o].[CustomerId] = [c].[Id]
```

Идиома `Expression.Invoke(ToDto, memberPath)` и есть весь приём: она применяет переиспользуемую лямбду к подвыражению, а не к корневому параметру.

## Применение переиспользуемого предиката внутри навигации через AsQueryable()

`ICollection<T>.Any(Func<T, bool>)` это перегрузка из `IEnumerable`, поэтому передать сохранённое выражение в навигационное свойство не получится на этапе компиляции, а bool-метод компилируется, но не транслируется:

```csharp
db.Customers.Where(c => c.Orders.Any(o => IsBigOrderMethod(o)));
// InvalidOperationException: ... .Any(o => Helpers.IsBigOrderMethod(o))' could not be translated
```

Вставьте `AsQueryable()`, и вы получите перегрузку из `Queryable`, которая принимает выражение:

```csharp
static readonly Expression<Func<Order, bool>> IsBigOrder = o => o.Total > 1000m;

db.Customers.Where(c => c.Orders.AsQueryable().Any(IsBigOrder));
```

```sql
SELECT [c].[Id], [c].[Country], [c].[IsDeleted], [c].[Name]
FROM [Customers] AS [c]
WHERE EXISTS (
    SELECT 1
    FROM [Orders] AS [o]
    WHERE [c].[Id] = [o].[CustomerId] AND [o].[Total] > 1000.0)
```

`AsQueryable()` на навигации внутри дерева запроса ничего не стоит: EF убирает его при трансляции. Тот же приём работает для `All`, `Count` и `Select` по коллекции. `All(IsBigOrder)` транслировался в `NOT EXISTS (... AND [o].[Total] <= 1000.0)`, `Count(IsBigOrder)` в коррелированный `COUNT(*)` с фильтром, а `Select(OrderDtoExpr).ToList()` в `LEFT JOIN` с `ORDER BY [c].[Id]` для формирователя коллекции.

## Ключи сортировки как параметры, включая случай упаковки

В сортировке переиспользование обычно означает "колонка приходит из query string". `Queryable.OrderBy` обобщён по типу ключа, поэтому сквозной помощник сохраняет строгую типизацию:

```csharp
public static IOrderedQueryable<T> OrderByKey<T, TKey>(
    this IQueryable<T> q, Expression<Func<T, TKey>> key) => q.OrderBy(key);

static readonly Dictionary<string, Expression<Func<Customer, string>>> SortKeys = new()
{
    ["name"] = c => c.Name,
    ["country"] = c => c.Country,
};

db.Customers.OrderByKey(SortKeys["name"]);   // ORDER BY [c].[Name]
```

Если у колонок разные CLR-типы, возникнет соблазн взять `Expression<Func<T, object>>`, что для значимых типов добавит узел `Convert(c.Id, Object)`. EF Core 11 это обрабатывает:

```csharp
Expression<Func<Customer, object>> key = c => c.Id;
db.Customers.OrderBy(key);   // ORDER BY [c].[Id]
```

Преобразование упаковки убирается при трансляции. Избегать его всё равно стоит, потому что ключи типа `object` молча принимают то, что не транслируется, и вы теряете проверку типа ключа во время компиляции. `Dictionary<string, Expression<Func<T, TKey>>>` на каждый тип ключа или небольшой switch, вызывающий `OrderByKey` с нужным обобщённым аргументом, делают ошибку невозможной. Если сортировка питает постраничный endpoint, учтите, что устойчивый порядок это жёсткое требование для [пагинации по keyset](/ru/2026/06/how-to-do-keyset-cursor-pagination-in-ef-core-11/).

## Ловушка Expression.Constant, которая встраивает ваши параметры

Это ошибка, которая проявляется только в продакшене и только в кеше планов запросов. Когда вы пишете фабрику как лямбду, захваченный аргумент становится полем замыкания, и EF его параметризует:

```csharp
static Expression<Func<Customer, bool>> InCountry(string c) => x => x.Country == c;
// WHERE [c].[Country] = @c   with DECLARE @c nvarchar(4000) = N'NL';
```

Когда вы собираете то же дерево руками, естественнее всего написать `Expression.Constant(c)`, и EF честно выдаёт литерал:

```csharp
var body = Expression.Equal(
    Expression.Property(p, nameof(Customer.Country)),
    Expression.Constant(c));       // <- inlined, not parameterized
// WHERE [c].[Country] = N'NL'
```

Теперь каждая новая страна даёт свою строку SQL, свою запись в кеше запросов EF и свой план в SQL Server. Для динамического построителя фильтров это переполнение кеша планов. Два решения, оба проверены на EF Core 11:

```csharp
// 1. EF.Parameter<T>, added in EF Core 9, forces parameterization of a constant
var efParameter = typeof(EF).GetMethod(nameof(EF.Parameter))!.MakeGenericMethod(typeof(string));
var value = Expression.Call(efParameter, Expression.Constant(c));
// WHERE [c].[Country] = @p

// 2. read the value through a field on a captured object, exactly like a compiler closure
sealed class Box { public string? Value; }
var value = Expression.Field(Expression.Constant(new Box { Value = c }), nameof(Box.Value));
// WHERE [c].[Country] = @Value
```

`EF.Constant<T>` (EF Core 8.0.2) делает обратное, когда литерал действительно нужен, например чтобы оптимизатор увидел селективное значение. Пара описана в [обзоре нового в EF Core 9](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/whatsnew). Если непонятно, на какой стороне вы оказались, быстрее всего [включить логирование SQL, который генерирует EF Core](/ru/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) и поискать `DECLARE @`.

## Compile() место вне запроса, и это дорого

Единственное законное применение `Compile()` это прогон того же предиката по объектам в памяти, например чтобы проверить изменение перед сохранением. Компиляция недёшева. В прогретом цикле на `Stopwatch` под .NET 11.0.100-preview.7 (грубые замеры цикла, не BenchmarkDotNet) вызов `pred.Compile()(customer)` стоил около 47.7 микросекунды на операцию, а вызов однажды скомпилированного делегата около 2.7 наносекунды. Точные цифры на вашем железе сдвинутся; четыре порядка величины нет. Кешируйте делегат рядом с выражением:

```csharp
public static class CustomerRules
{
    public static readonly Expression<Func<Customer, bool>> IsActive =
        c => !c.IsDeleted && c.Orders.Count > 0;

    public static readonly Func<Customer, bool> IsActiveFunc = IsActive.Compile();
}
```

Используйте `IsActive` для `IQueryable<Customer>` и `IsActiveFunc` для всего, что уже в памяти. Это разделение является практической версией границы между `IEnumerable` и `IQueryable`, описанной в статье про [выбор правильного возвращаемого типа](/ru/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/), и оно же объясняет, почему свойство сущности вида `public bool IsActive => !IsDeleted && Orders.Count > 0` бросает "Translation of member 'IsActive' on entity type 'Customer' failed" при первом же использовании в `Where`. У вычисляемых CLR-свойств нет дерева, которое EF мог бы прочитать.

Последнее замечание про планы. Каждая отличающаяся форма дерева выражения это отдельная запись в кеше скомпилированных запросов EF, поэтому построитель предикатов, собирающий новое дерево на каждый запрос, не переиспользует план, даже если текст SQL в итоге совпадает. Если конкретный составной запрос доминирует на горячем пути, закрепите его [скомпилированным запросом](/ru/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/), вместо того чтобы пересобирать дерево при каждом вызове.

## Где всё это живёт в реальной кодовой базе

Две формы покрывают почти всё, и выбор определяется тем, кому принадлежит правило.

Если правило принадлежит сущности, достаточно статического класса рядом. `CustomerRules.IsActive`, `OrderRules.IsBig`, один файл, никаких интерфейсов. Вызывающий код пишет `db.Customers.Where(CustomerRules.IsActive)`, и у определения ровно один дом. С этого варианта и стоит начинать, большинству команд большего никогда не требуется.

Если правило принадлежит сценарию использования, а не сущности, объект specification себя оправдывает: небольшой тип, отдающий `Expression<Func<T, bool>> Criteria` плюс необязательные include и сортировку, с `And`, `Or` и `Not` поверх описанных выше помощников компоновки. Ценность не в абстракции, а в том, что сценарий можно передавать по коду, покрывать модульными тестами по объектам в памяти через закешированный делегат `Compile()` и транслировать в SQL тем же деревом.

Что бы вы ни выбрали, не стройте абстракцию над самим `Where`. Цепочка вызовов уже компонуется:

```csharp
db.Customers.Where(IsActive).Where(InCountry("NL"));
```

Это выдало ровно тот же SQL, что и единый предикат, собранный через `And`, вплоть до имени параметра. Каждый `Where` оборачивает предыдущий в дереве, и EF схлопывает цепочку в один `WHERE` с `AND`. Значит, помощники компоновки нужны только когда оператор это `Or`, когда вы перепривязываете к другому типу сущности или когда собираете предикат из коллекции, длина которой неизвестна во время компиляции. Методы расширения над `IQueryable<T>` закрывают простой случай `And` вообще без кода работы с выражениями:

```csharp
public static IQueryable<Customer> ActiveOnly(this IQueryable<Customer> q)
    => q.Where(c => !c.IsDeleted && c.Orders.Count > 0);

public static IQueryable<Customer> InCountry(this IQueryable<Customer> q, string country)
    => q.Where(c => c.Country == country);

db.Customers.ActiveOnly().InCountry("NL");
```

Снова тот же SQL. Единственное, чего вы лишаетесь, это возможности вытащить предикат обратно и применить его к списку в памяти, а именно её и покупает вариант с `Expression<Func<T, bool>>`.

## Связанные материалы

- [Fix: "The LINQ expression could not be translated" в EF Core 11](/ru/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)
- [Как использовать именованные фильтры запросов для мягкого удаления и мультиарендности в EF Core 11](/ru/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/)
- [Как логировать SQL, который генерирует EF Core 11](/ru/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [Как использовать скомпилированные запросы EF Core на горячих путях](/ru/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [IEnumerable vs IAsyncEnumerable vs IQueryable в C#](/ru/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/)

## Источники

- [Вычисление на клиенте и на сервере](https://learn.microsoft.com/en-us/ef/core/querying/client-eval), документация EF Core
- [dotnet/efcore#17791: регрессия 3.0, трансляция Expression.Invoke](https://github.com/dotnet/efcore/issues/17791)
- [Что нового в EF Core 9: EF.Parameter и EF.Constant](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/whatsnew)
- [Queryable.Where и Queryable.OrderBy](https://learn.microsoft.com/en-us/dotnet/api/system.linq.queryable), справочник по API .NET
- Весь SQL снят через `ToQueryString()` на `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0-preview.7.26381.103 под .NET SDK 11.0.100-preview.7.26381.103, подключение к базе данных не требовалось
