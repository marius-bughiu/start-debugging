---
title: "Исправление: EF Core `Contains` для static readonly `IList<T>` или `ISet<T>` не удаётся транслировать"
description: "EF Core 8, 9 и 10 не могут транслировать Contains, если список является static readonly полем типа IList, ICollection, ISet или IReadOnlySet. Вызовите Enumerable.Contains явно или перейдите на EF Core 11."
pubDate: 2026-09-29
template: error-page
tags:
  - "errors"
  - "efcore"
  - "dotnet"
  - "linq"
lang: "ru"
translationOf: "2026/09/fix-ef-core-contains-on-a-static-readonly-ilist-or-iset-fails-to-translate"
translatedBy: "claude"
translationDate: 2026-09-29
---

Если `Where(x => AllowedCodes.Contains(x.Code))` выбрасывает `The LINQ expression ... could not be translated` с сообщением `Translation of method 'System.Linq.Enumerable.Contains' failed`, посмотрите, как объявлено `AllowedCodes`. Почти наверняка это поле `static readonly` типа `IList<T>`, `ICollection<T>`, `ISet<T>`, `IReadOnlySet<T>`, `IImmutableSet<T>` или `FrozenSet<T>`. Самое быстрое исправление, которое сохраняет тот же SQL, это явно вызвать оператор LINQ: `Enumerable.Contains(AllowedCodes, x.Code)`. Настоящее исправление это EF Core 11, где dotnet/efcore#36757 поправил проверку корня запроса, отклоняющую такие формы. Я проверил каждый вариант ниже на `Microsoft.EntityFrameworkCore.Sqlite` 8.0.21, 9.0.19, 10.0.12 и 11.0.0-rc.1.26425.128. Первые три версии падают одинаково. EF Core 11 RC 1 транслирует все варианты.

## Ошибка в контексте

Вот исключение из EF Core 10.0.12 на .NET 10 для `static readonly IList<string>`:

```
System.InvalidOperationException: The LINQ expression 'DbSet<Order>()
    .Where(o => (IList<string>)List<string> { "Open", "Pending" }
        .Contains(o.Status))' could not be translated. Additional information: Translation of method 'System.Linq.Enumerable.Contains' failed. If this method can be mapped to your custom function, see https://go.microsoft.com/fwlink/?linkid=2132413 for more information. Either rewrite the query in a form that can be translated, or switch to client evaluation explicitly by inserting a call to 'AsEnumerable', 'AsAsyncEnumerable', 'ToList', or 'ToListAsync'. See https://go.microsoft.com/fwlink/?linkid=2101038 for more information.
   at Microsoft.EntityFrameworkCore.Query.QueryableMethodTranslatingExpressionVisitor.Translate(Expression expression)
   at Microsoft.EntityFrameworkCore.Query.QueryCompilationContext.CreateQueryExecutorExpression[TResult](Expression query)
```

В этом сообщении есть две подсказки. Первая это приведение типа. Коллекция выглядит как `(IList<string>)List<string> { "Open", "Pending" }`, то есть EF уже вычислил ваше поле до значения, константы, и обернул её в приведение обратно к объявленному типу. Вторая подсказка это имя метода. Вы написали `IList<T>.Contains`, метод экземпляра, но в сообщении указан `Enumerable.Contains`. EF переписывает вызовы `ICollection<T>.Contains` в оператор LINQ перед трансляцией. Так что дело не в методе. Проблема в аргументе, который EF ему передаёт.

Когда поле имеет тип `IReadOnlySet<T>` или `IImmutableSet<T>`, имя метода в сообщении меняется на `System.Collections.Generic.IReadOnlySet<string>.Contains` или `System.Collections.Immutable.IImmutableSet<string>.Contains`. Эти интерфейсы не наследуют `ICollection<T>`, поэтому EF никогда не переписывает вызов. Это тот же баг с другим сообщением.

## Почему static readonly поле ломается, а локальная переменная нет

Здесь два шага, и баг проявляется, только когда происходят оба.

**Шаг 1: EF подставляет `static readonly` поля как константы.** Перед трансляцией funcletizer в EF обходит запрос и вычисляет всё, что не зависит от базы данных. Захваченные локальные переменные, поля экземпляра и статические свойства становятся параметрами запроса. Статическое поле с `readonly` (`FieldInfo.IsInitOnly`) считается значением, которое не может измениться, поэтому EF вычисляет его один раз и подставляет как константу. В EF Core 10 это видно в [`ExpressionTreeFuncletizer.VisitMember`](https://github.com/dotnet/efcore/blob/release/10.0/src/EFCore/Query/Internal/ExpressionTreeFuncletizer.cs): статический член помечается как захваченная переменная "unless the captured variable is init-only". Когда EF строит эту константу, он типизирует её по типу значения времени выполнения (`List<string>`), а затем добавляет узел `Convert` обратно к объявленному типу (`IList<string>`), если два типа различаются.

**Шаг 2: проверка корня запроса снимает только один вид приведения.** Чтобы транслировать `Contains` по коллекции в памяти, EF превращает коллекцию во встроенный корень запроса, а затем в `IN (...)`. В EF Core 8, 9 и 10 [`QueryRootProcessor.VisitQueryRootCandidate`](https://github.com/dotnet/efcore/blob/release/10.0/src/EFCore/Query/QueryRootProcessor.cs) снимает `Convert` только тогда, когда целевой тип в точности `IEnumerable<T>`:

```csharp
// EF Core 10.0.x, src/EFCore/Query/QueryRootProcessor.cs
if (expression is UnaryExpression { NodeType: ExpressionType.Convert } convertExpression
    && convertExpression.Type.GetGenericTypeDefinition() == typeof(IEnumerable<>))
{
    candidateExpression = convertExpression.Operand;
}
```

`Convert` к `IList<string>` не подходит, поэтому коллекция не распознаётся как корень запроса, и `Contains` доходит до "could not be translated".

С этим понятна и картина того, что работает, а что нет:

- Поля `List<T>`, `HashSet<T>` и `T[]` работают, потому что объявленный тип совпадает с типом времени выполнения. EF не добавляет `Convert`.
- Поля `IEnumerable<T>`, `IReadOnlyList<T>` и `IReadOnlyCollection<T>` работают, потому что ни один из этих типов не объявляет собственный `Contains`. Вызов привязывается к `Enumerable.Contains`, компилятор приводит аргумент к `IEnumerable<T>`, и константа, которую создаёт EF, приведена к `IEnumerable<T>`, то есть к единственной форме, которую принимает старая проверка.
- `IList<T>`, `ICollection<T>`, `ISet<T>`, `IReadOnlySet<T>` и `IImmutableSet<T>` не работают, потому что объявляют `Contains`. C# предпочитает метод экземпляра методу расширения, поэтому приведение остаётся к типу интерфейса.
- `FrozenSet<T>` не работает, хотя это конкретный класс, потому что он абстрактный. Значение времени выполнения это внутренний подкласс, что снова порождает `Convert`. Именно этот случай описан в dotnet/efcore#36496, а PR, который его исправил, исправил и интерфейсы.
- Захваченная локальная переменная, нестатическое readonly поле и статическое свойство работают, потому что становятся параметрами, а не константами, а в пути через параметры этого бага никогда не было.

Это не регрессия. Первоначальный отчёт о варианте с `IReadOnlySet<T>` восходит к EF Core 7, а dotnet/efcore#38839 воспроизводит его на версиях с 7.0.20 по 10.0.11.

## Минимальный пример воспроизведения

```csharp
// .NET 10, C# 14, Microsoft.EntityFrameworkCore.Sqlite 10.0.12
using Microsoft.EntityFrameworkCore;

using var db = new ShopContext();
db.Database.EnsureDeleted();
db.Database.EnsureCreated();
db.Orders.AddRange(
    new Order { Status = "Open" },
    new Order { Status = "Pending" },
    new Order { Status = "Shipped" });
db.SaveChanges();

// Throws InvalidOperationException on EF Core 8, 9 and 10
var active = db.Orders
    .Where(o => OrderRules.ActiveStatuses.Contains(o.Status))
    .ToList();

Console.WriteLine(active.Count);

public static class OrderRules
{
    public static readonly IList<string> ActiveStatuses = new List<string> { "Open", "Pending" };
}

public class Order
{
    public int Id { get; set; }
    public string Status { get; set; } = "";
}

public class ShopContext : DbContext
{
    public DbSet<Order> Orders => Set<Order>();

    protected override void OnConfiguring(DbContextOptionsBuilder options)
        => options.UseSqlite("Data Source=shop.db");
}
```

Замените `IList<string>` на `List<string>`, уберите `readonly` или превратите поле в свойство `{ get; }`, и тот же запрос заработает. Обычно баг находят именно так: на ревью кода предлагают "открывать интерфейс, а не конкретный тип" или "сделать поле readonly", и запрос, который месяцами работал, ломается.

## Что делает каждое объявление в EF Core 8, 9, 10 и 11

Я запустил по одной пробе для каждой формы на SQLite в каждой версии EF. Пакеты EF Core 8 и 9 работали на среде выполнения .NET 10. EF Core 11 RC 1 работал на .NET 11 RC 1. "Constant" означает, что EF подставил значения прямо в SQL. "Parameter" означает, что он передал их как параметры.

| Объявление | EF 8.0.21 | EF 9.0.19 | EF 10.0.12 | EF 11 RC 1 |
|---|---|---|---|---|
| `static readonly IList<T>` | fails | fails | fails | constant |
| `static readonly ICollection<T>` | fails | fails | fails | constant |
| `static readonly ISet<T>` | fails | fails | fails | constant |
| `static readonly IReadOnlySet<T>` | fails | fails | fails | constant |
| `static readonly IImmutableSet<T>` | fails | fails | fails | constant |
| `static readonly FrozenSet<T>` | fails | fails | fails | constant |
| `static readonly IReadOnlyList<T>`, `IReadOnlyCollection<T>`, `IEnumerable<T>` | constant | constant | constant | constant |
| `static readonly List<T>`, `HashSet<T>`, `T[]` | constant | constant | constant | constant |
| `static IList<T>` (не readonly) или статическое свойство | parameter | parameter | parameter | parameter |
| захваченная локальная переменная `IList<T>` | parameter | parameter | parameter | parameter |
| `EF.Constant(localIList).Contains(...)` | fails | constant | constant | constant |

Последняя строка это похожий случай, о котором полезно знать. В EF Core 8 принудительное превращение локального `IList<T>` в константу через `EF.Constant` попадает на тот же баг. Начиная с EF Core 9 `EF.Constant` идёт другим путём и работает.

## Исправления в порядке предпочтения

### 1. Перейти на EF Core 11

Исправление это [dotnet/efcore#36757](https://github.com/dotnet/efcore/pull/36757), влитое в `main` 2025-09-24 и вошедшее в EF Core 11. Оно меняет проверку так, чтобы снимался любой `Convert`, целевой тип которого приводим к `IEnumerable`, причём рекурсивно:

```csharp
// EF Core 11.0, src/EFCore/Query/QueryRootProcessor.cs
if (expression is UnaryExpression { NodeType: ExpressionType.Convert } convertExpression
    && convertExpression.Type.IsAssignableTo(typeof(IEnumerable)))
{
    return VisitQueryRootCandidate(convertExpression.Operand, elementClrType);
}
```

Исправление не было перенесено в старые версии. В ветке `release/10.0` всё ещё сравнение с `typeof(IEnumerable<>)`, и 10.0.12 всё ещё падает. dotnet/efcore#35024 (отчёт про `IList`/`ICollection`) отнесён к milestone 11.0.0, а #38839 закрыт как дубликат. Если вы на EF Core 10 LTS, до перехода на 11 планируйте использовать одну из переписанных форм ниже.

### 2. Вызвать `Enumerable.Contains` явно

Это исправление в одну строку, которое я рекомендую для EF Core 8, 9 и 10, потому что оно даёт в точности тот SQL, который вы получите в EF Core 11:

```csharp
// .NET 10, Microsoft.EntityFrameworkCore.Sqlite 10.0.12
var active = db.Orders
    .Where(o => Enumerable.Contains(OrderRules.ActiveStatuses, o.Status))
    .ToList();

// WHERE "o"."Status" IN ('Open', 'Pending')
```

Прямой вызов статического метода заставляет компилятор привести поле к `IEnumerable<string>`, поэтому константа EF приходит приведённой к `IEnumerable<T>` и проходит старую проверку. В моих запусках это сработало для всех шести падающих форм, включая `IReadOnlySet<T>` и `IImmutableSet<T>`. `OrderRules.ActiveStatuses.AsEnumerable().Contains(o.Status)` делает то же самое, если вам ближе синтаксис методов. `OrderRules.ActiveStatuses.Any(s => s == o.Status)` тоже транслируется в тот же список `IN`, но читается хуже, и я бы не стал использовать его только ради обхода этой проблемы.

Один компромисс: для `ISet<T>` или `FrozenSet<T>` `Enumerable.Contains` в обычном LINQ to Objects пропустил бы поиск по хешу. Внутри запроса EF это не важно, потому что вызов никогда не выполняется в .NET. Он лишь описывает SQL.

### 3. Изменить объявленный тип

Если коллекция используется только в запросах, объявите её как `IReadOnlyCollection<T>`, `IReadOnlyList<T>` или массив. Все три доступны только для чтения, и все три транслируются во всех версиях:

```csharp
// .NET 10, Microsoft.EntityFrameworkCore 10.0.12
public static class OrderRules
{
    public static readonly IReadOnlyList<string> ActiveStatuses = ["Open", "Pending"];
}
```

Не переходите на `FrozenSet<T>` ради "настоящей" неизменяемости. В EF Core с 8 по 10 он падает по причине, описанной выше.

### 4. Позволить EF параметризовать значения

Если скопировать поле в локальную переменную или превратить его в `static` свойство, EF будет передавать значения как параметры, а не как константы:

```csharp
// .NET 10, Microsoft.EntityFrameworkCore.Sqlite 10.0.12
var statuses = OrderRules.ActiveStatuses;
var active = db.Orders.Where(o => statuses.Contains(o.Status)).ToList();

// EF Core 10: WHERE "o"."Status" IN (@statuses1, @statuses2)
// EF Core 8/9 on SQLite: WHERE "o"."Status" IN (SELECT "s"."value" FROM json_each(@__statuses_0) AS "s")
```

Это работает, но меняет SQL. Помните, зачем существует путь через константы: значения никогда не меняются, поэтому их подстановка даёт базе данных фиксированный список литералов, что лучше всего для использования индексов и кеширования планов. Для короткого списка кодов статуса константы дают лучший SQL. Используйте этот вариант, когда список действительно может меняться во время выполнения, а не только ради обхода бага трансляции. Если хотите увидеть, что EF генерирует в каждом случае, [запишите в журнал SQL, который генерирует EF Core](/ru/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) до и после изменения.

## Варианты, которые попадают на эту страницу по ошибке

- **`Translation of method 'System.MemoryExtensions.Contains' failed`** на массиве после перехода на C# 14. Это изменение в разрешении перегрузок для span первого класса, а не этот баг. См. [исправление разрешения перегрузок со span в C# 14](/ru/2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans/).
- **Общее "could not be translated" для метода, который вы написали сами**, например `ids.HasItem(x.Id)`. EF не видит внутрь вашего метода, какой бы тип коллекции вы ни использовали. Общие причины и способы переписывания разобраны в [статье про LINQ expression could not be translated в EF Core 11](/ru/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/), а безопасное повторное использование логики предикатов описано в [статье про переиспользуемые предикаты LINQ, которые EF Core умеет транслировать](/ru/2026/08/how-to-write-reusable-linq-predicates-ef-core-can-translate/).
- **`An exception was thrown while attempting to evaluate a LINQ query parameter expression`**. Это происходит, когда funcletizer выполняет геттер вашего поля или свойства, и геттер выбрасывает исключение. Падение происходит на той же стадии, но по другой причине. См. [исправление вычисления выражения параметра](/ru/2026/08/fix-an-exception-was-thrown-while-attempting-to-evaluate-a-linq-query-parameter-expression/).
- **Тот же `static readonly IList<T>` внутри скомпилированного запроса** (`EF.CompileQuery`). Скомпилированные запросы проходят те же шаги funcletizer и корня запроса. Я подтвердил, что они падают так же на EF Core 10.0.12, и `Enumerable.Contains` их тоже исправляет. См. [как использовать скомпилированные запросы для горячих путей](/ru/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/).

## Связанные материалы

- [Fix: The LINQ expression could not be translated in EF Core 11](/ru/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)
- [How to write reusable LINQ predicates EF Core can translate](/ru/2026/08/how-to-write-reusable-linq-predicates-ef-core-can-translate/)
- [How to log the SQL that EF Core 11 generates](/ru/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [Fix the C# 14 overload resolution breaking change with spans](/ru/2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans/)
- [How to use compiled queries with EF Core for hot paths](/ru/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)

## Источники

- [dotnet/efcore#35024: Query could not be translated when using a static ICollection/IList field](https://github.com/dotnet/efcore/issues/35024), milestone 11.0.0.
- [dotnet/efcore#38839: Contains on a constant collection fails when declared as ICollection/IList/ISet/IReadOnlySet/IImmutableSet](https://github.com/dotnet/efcore/issues/38839), закрыт как дубликат, с матрицей версий от 7.0.20 до 10.0.11.
- [dotnet/efcore#36757: Fix handling of readonly fields using abstract classes (i.e. FrozenSet) in parameters for primitive collections](https://github.com/dotnet/efcore/pull/36757), исправление, влито 2025-09-24.
- [`QueryRootProcessor.cs` на `release/10.0`](https://github.com/dotnet/efcore/blob/release/10.0/src/EFCore/Query/QueryRootProcessor.cs) и [`ExpressionTreeFuncletizer.cs` на `release/10.0`](https://github.com/dotnet/efcore/blob/release/10.0/src/EFCore/Query/Internal/ExpressionTreeFuncletizer.cs).
- [What's new in EF Core 10: improved translation for parameterized collections](https://learn.microsoft.com/ef/core/what-is-new/ef-core-10.0/whatsnew#improved-translation-for-parameterized-collection).
