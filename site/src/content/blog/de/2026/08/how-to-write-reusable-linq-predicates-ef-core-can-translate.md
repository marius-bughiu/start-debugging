---
title: "Wiederverwendbare LINQ-Prädikate schreiben, die EF Core in Where, Select und OrderBy übersetzen kann"
description: "Eine bool-Hilfsmethode wirft \"could not be translated\". Ein Expression<Func<T, bool>> nicht. So komponieren, verschachteln und wiederverwenden Sie Expression Trees in EF Core 11 ohne LINQKit, mit dem echten SQL zu jedem Fall."
pubDate: 2026-08-23
tags:
  - "ef-core"
  - "linq"
  - "csharp"
  - "dotnet"
lang: "de"
translationOf: "2026/08/how-to-write-reusable-linq-predicates-ef-core-can-translate"
translatedBy: "claude"
translationDate: 2026-08-23
---

Die Regel ist kurz: EF Core kann nur das übersetzen, was beim Provider noch ein Expression Tree ist. Eine Hilfsmethode `static bool IsActive(Customer c)` kompiliert zu einem Methodenaufruf-Knoten und wirft zur Laufzeit; dieselbe Logik als `static readonly Expression<Func<Customer, bool>> IsActive` übersetzt sauber und lässt sich komponieren, verschachteln und auf andere Entitätstypen umhängen. Was die meisten Anleitungen falsch darstellen: Sie brauchen angeblich `AsExpandable()` aus LINQKit, um solche Bäume zu komponieren. Das stimmt nicht: `Expression.Invoke` wird seit EF Core 3.1 übersetzt, und jedes SQL-Fragment unten stammt aus EF Core 11.0.0-preview.7.26381.103 mit dem SQL Server Provider über `ToQueryString()`.

## Warum die bool-Hilfsmethode wirft und die Expression nicht

Beginnen wir mit der Form, zu der fast alle zuerst greifen, weil sie sich gut liest:

```csharp
// EF Core 11.0.0-preview.7, C# 14
static bool IsActiveMethod(Customer c) => !c.IsDeleted && c.Orders.Count > 0;

db.Customers.Where(c => IsActiveMethod(c));
```

Der C#-Compiler macht aus dieser Lambda einen Expression Tree, dessen Rumpf ein `MethodCallExpression` auf `IsActiveMethod` ist. EF Core kann nicht in einen kompilierten Methodenrumpf hineinsehen, also bricht die Übersetzung ab:

```
System.InvalidOperationException
The LINQ expression 'DbSet<Customer>()
    .Where(c => Helpers.IsActiveMethod(c))' could not be translated. Either rewrite
the query in a form that can be translated, or switch to client evaluation explicitly
by inserting a call to 'AsEnumerable', 'AsAsyncEnumerable', 'ToList', or 'ToListAsync'.
```

Das ist dokumentiertes Verhalten: EF Core unterstützt partielle Client-Auswertung nur in der obersten Projektion und wirft für alles Nicht-Übersetzbare an anderer Stelle in der Abfrage, siehe [Client- versus Server-Auswertung](https://learn.microsoft.com/en-us/ef/core/querying/client-eval). Wenn Sie darüber schon in anderen Formen gestolpert sind, steht die vollständige Diagnoseliste im [Artikel zu "The LINQ expression could not be translated"](/de/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/).

Speichern Sie dieselbe Logik stattdessen als Expression, und an der Aufrufstelle ändert sich nichts:

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

`Queryable.Where` nimmt `Expression<Func<T, bool>>`, das Feld direkt zu übergeben reicht EF also den kompletten Baum. Dasselbe gilt, wenn das Prädikat als Methodenparameter ankommt, die Grundlage jeder Specification-artigen Abstraktion:

```csharp
static IQueryable<Customer> Filter(IQueryable<Customer> q, Expression<Func<Customer, bool>> p)
    => q.Where(p);
```

Das erzeugte im Test dasselbe SQL. Sobald das Prädikat ein `Func<>` statt eines `Expression<Func<>>` ist, sind Sie wieder bei der Exception.

## Prädikate komponieren: Expression.Invoke übersetzt in EF Core 11

Interessant wird es beim Kombinieren zweier unabhängig geschriebener Prädikate. Der naheliegende Versuch scheitert:

```csharp
db.Customers.Where(c => IsActive.Compile()(c) && c.Country == "NL");
```

```
The LINQ expression 'DbSet<Customer>()
    .Where(c => Invoke(Func<Customer, bool>, c) && c.Country == "NL")'
could not be translated.
```

`Compile()` läuft beim Aufbau der Abfrage und legt eine Konstante vom Typ `Func<Customer, bool>` in den Baum. EF sieht ein undurchsichtiges Delegate und gibt auf. Genau dieser Fehler treibt Leute zu LINQKit.

Die Invocation als Expression-Knoten statt als Delegate-Aufruf zu bauen funktioniert dagegen heute:

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

Kein `AsExpandable()`, kein zusätzliches Paket. Die Query-Pipeline von EF Core reduziert `InvocationExpression`-Knoten vor der Übersetzung. Die Regression, die das in EF Core 3.0 zerstörte, wurde als [dotnet/efcore#17791](https://github.com/dotnet/efcore/issues/17791) erfasst und für 3.1 behoben, aber viele Ratschläge im Netz stammen noch aus der Zeit davor.

Zwei Details zu diesem `And`-Helfer. Erstens kostet ein `true`- oder `false`-Startwert, das womit `PredicateBuilder` beginnt, nichts: `And<Customer>(c => true, InCountry("NL"))` und `Or<Customer>(c => false, InCountry("NL"))` gaben exakt das obige `WHERE [c].[Country] = @c` aus, ohne `1 = 1`-Rest. Der Expression-Simplifier von EF faltet die Konstante weg, Sie können die Akkumulator-Schleife also naiv schreiben.

Zweitens ist `Expression.Invoke` nicht die einzige Option. Parameter mit einem `ExpressionVisitor` umzuhängen ergibt einen flacheren Baum:

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

Beide Varianten erzeugten im Test byteidentisches SQL. Nehmen Sie den Visitor, wenn Sie den kombinierten Baum selbst inspizieren oder weiter transformieren wollen, denn dann steht keine Invocation-Schicht im Weg. Nehmen Sie `Expression.Invoke`, wenn Sie zwölf Zeilen weniger wollen.

## Ein Prädikat auf einen anderen Entitätstyp umhängen

Der Visitor zahlt sich aus, sobald Sie ein `Customer`-Prädikat auf eine `Order`-Abfrage anwenden wollen. Hier komponieren Sie nicht zwei Prädikate über denselben Parameter, sondern ersetzen den Parameter durch einen Member-Pfad:

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

Eine Definition von "aktiver Kunde", aus beiden Richtungen durchgesetzt, mit dem Join gratis dazu. Wenn die Regel eher ein dauerhafter Filter als ein wiederverwendbarer Baustein ist, prüfen Sie, ob sie in [einen benannten Query-Filter](/de/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/) gehört, damit Aufrufer sie nicht vergessen können.

## Wiederverwendbare Projektionen in Select

Projektionen folgen derselben Regel, mit einem zusätzlichen Fehlermodus. Die Expression direkt an `Select` zu übergeben funktioniert:

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

Sie mit `Compile()` in eine größere Projektion zu verschachteln funktioniert nicht, und die Exception unterscheidet sich von der in `Where`, weil Projektionen partielle Client-Auswertung erlauben:

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

EF sagt Ihnen damit, dass der kompilierte Abfrageplan Ihr Delegate für immer festhalten würde. Bauen Sie die Verschachtelung als Expression-Knoten, dann übersetzt sie:

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

Das Idiom `Expression.Invoke(ToDto, memberPath)` ist der ganze Trick: es wendet eine wiederverwendbare Lambda auf einen Teilausdruck statt auf den Wurzelparameter an.

## Ein wiederverwendbares Prädikat innerhalb einer Navigation mit AsQueryable()

`ICollection<T>.Any(Func<T, bool>)` ist die `IEnumerable`-Überladung, eine gespeicherte Expression an eine Navigationseigenschaft zu übergeben kompiliert also nicht, und eine bool-Methode kompiliert zwar, übersetzt aber nicht:

```csharp
db.Customers.Where(c => c.Orders.Any(o => IsBigOrderMethod(o)));
// InvalidOperationException: ... .Any(o => Helpers.IsBigOrderMethod(o))' could not be translated
```

Schieben Sie `AsQueryable()` ein, und Sie erhalten die `Queryable`-Überladung, die eine Expression nimmt:

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

`AsQueryable()` auf einer Navigation ist innerhalb eines Abfragebaums kostenlos: EF entfernt es bei der Übersetzung. Derselbe Trick gilt für `All`, `Count` und `Select` über die Collection. `All(IsBigOrder)` wurde zu `NOT EXISTS (... AND [o].[Total] <= 1000.0)` übersetzt, `Count(IsBigOrder)` zu einem gefilterten korrelierten `COUNT(*)` und `Select(OrderDtoExpr).ToList()` zu einem `LEFT JOIN` mit `ORDER BY [c].[Id]` für den Collection-Shaper.

## Sortierschlüssel als Parameter, inklusive Boxing-Fall

Beim Sortieren heißt Wiederverwendung meist "die Spalte kommt aus einem Query String". `Queryable.OrderBy` ist generisch über den Schlüsseltyp, ein durchreichender Helfer hält den Schlüssel also stark typisiert:

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

Wenn die Spalten unterschiedliche CLR-Typen haben, ist `Expression<Func<T, object>>` verlockend, was für Werttypen einen `Convert(c.Id, Object)`-Knoten erzwingt. EF Core 11 kommt damit zurecht:

```csharp
Expression<Func<Customer, object>> key = c => c.Id;
db.Customers.OrderBy(key);   // ORDER BY [c].[Id]
```

Die Boxing-Konvertierung wird bei der Übersetzung entfernt. Vermeiden sollten Sie sie trotzdem, denn `object`-Schlüssel akzeptieren stillschweigend Dinge, die nicht übersetzen, und Sie verlieren die Prüfung des Schlüsseltyps zur Kompilierzeit. Ein `Dictionary<string, Expression<Func<T, TKey>>>` pro Schlüsseltyp oder ein kleiner Switch, der `OrderByKey` mit dem richtigen generischen Argument aufruft, macht den Fehler unmöglich. Speist die Sortierung einen paginierten Endpunkt, beachten Sie: eine stabile Reihenfolge ist harte Voraussetzung für [Keyset-Pagination](/de/2026/06/how-to-do-keyset-cursor-pagination-in-ef-core-11/).

## Die Expression.Constant-Falle, die Ihre Parameter inline setzt

Das ist der Fehler, der nur in Produktion auftaucht, und nur im Query-Plan-Cache. Wenn Sie eine Factory als Lambda schreiben, wird das eingefangene Argument zu einem Closure-Feld, und EF parametrisiert es:

```csharp
static Expression<Func<Customer, bool>> InCountry(string c) => x => x.Country == c;
// WHERE [c].[Country] = @c   with DECLARE @c nvarchar(4000) = N'NL';
```

Bauen Sie denselben Baum von Hand, schreibt man natürlicherweise `Expression.Constant(c)`, und EF gibt getreu ein Literal aus:

```csharp
var body = Expression.Equal(
    Expression.Property(p, nameof(Customer.Country)),
    Expression.Constant(c));       // <- inlined, not parameterized
// WHERE [c].[Country] = N'NL'
```

Jedes andere Land erzeugt jetzt einen anderen SQL-String, einen anderen Eintrag im EF-Query-Cache und einen anderen SQL-Server-Plan. Bei einem dynamischen Filter-Builder ist das eine Flut im Plan-Cache. Zwei Lösungen, beide gegen EF Core 11 verifiziert:

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

`EF.Constant<T>` (EF Core 8.0.2) macht das Gegenteil, wenn Sie das Literal wirklich wollen, etwa damit der Optimizer einen selektiven Wert sieht. Das Paar ist in den [Neuerungen von EF Core 9](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/whatsnew) dokumentiert. Wenn unklar ist, auf welcher Seite Sie gelandet sind, prüfen Sie es am schnellsten, indem Sie [das von EF Core erzeugte SQL protokollieren](/de/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) und nach `DECLARE @` suchen.

## Compile() gehört außerhalb der Abfrage, und es ist teuer

Die einzige legitime Verwendung von `Compile()` ist, dasselbe Prädikat gegen Objekte im Speicher laufen zu lassen, etwa um eine Änderung vor dem Speichern zu validieren. Kompilieren ist nicht billig. In einer aufgewärmten `Stopwatch`-Schleife auf .NET 11.0.100-preview.7 (grobe Schleifenmessungen, kein BenchmarkDotNet) kostete `pred.Compile()(customer)` rund 47,7 Mikrosekunden pro Operation, während der Aufruf eines einmal kompilierten Delegates rund 2,7 Nanosekunden kostete. Die exakten Zahlen verschieben sich auf Ihrer Hardware; die vier Größenordnungen nicht. Cachen Sie das Delegate neben der Expression:

```csharp
public static class CustomerRules
{
    public static readonly Expression<Func<Customer, bool>> IsActive =
        c => !c.IsDeleted && c.Orders.Count > 0;

    public static readonly Func<Customer, bool> IsActiveFunc = IsActive.Compile();
}
```

Nutzen Sie `IsActive` für `IQueryable<Customer>` und `IsActiveFunc` für alles, was bereits im Speicher liegt. Diese Trennung ist die praktische Fassung der Grenze zwischen `IEnumerable` und `IQueryable` aus [der Wahl des richtigen Rückgabetyps](/de/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/), und sie erklärt auch, warum eine Entitätseigenschaft wie `public bool IsActive => !IsDeleted && Orders.Count > 0` beim ersten Einsatz in einem `Where` mit "Translation of member 'IsActive' on entity type 'Customer' failed" wirft. Berechnete CLR-Eigenschaften haben keinen Baum, den EF lesen könnte.

Noch eine Bemerkung zu Plänen. Jede unterschiedliche Form eines Expression Trees ist ein eigener Eintrag im Cache kompilierter EF-Abfragen. Ein Prädikat-Builder, der pro Request einen anderen Baum zusammensetzt, verwendet also keinen Plan wieder, selbst wenn der SQL-Text am Ende identisch ist. Dominiert eine bestimmte zusammengesetzte Abfrage einen heißen Pfad, fixieren Sie sie mit [einer kompilierten Abfrage](/de/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/), statt den Baum bei jedem Aufruf neu zu bauen.

## Wo das in einer echten Codebasis hingehört

Zwei Formen decken fast alles ab, und die Wahl hängt davon ab, wem die Regel gehört.

Gehört die Regel zur Entität, reicht eine statische Klasse daneben. `CustomerRules.IsActive`, `OrderRules.IsBig`, eine Datei, keine Interfaces. Aufrufer schreiben `db.Customers.Where(CustomerRules.IsActive)`, und die Definition hat genau ein Zuhause. Mit dieser Variante fängt man an, und die meisten Teams brauchen nie mehr.

Gehört die Regel zu einem Anwendungsfall statt zu einer Entität, lohnt sich ein Specification-Objekt: ein kleiner Typ mit `Expression<Func<T, bool>> Criteria` plus optionalen Includes und Sortierung, mit `And`, `Or` und `Not` auf Basis der obigen Kompositionshelfer. Der Wert liegt nicht in der Abstraktion, sondern darin, dass ein Anwendungsfall herumgereicht, über das gecachte `Compile()`-Delegate gegen Objekte im Speicher unit-getestet und vom selben Baum nach SQL übersetzt werden kann.

Was Sie auch wählen: bauen Sie keine Abstraktion über `Where` selbst. Verkettete Aufrufe komponieren bereits:

```csharp
db.Customers.Where(IsActive).Where(InCountry("NL"));
```

Das gab exakt dasselbe SQL aus wie das mit `And` komponierte Einzelprädikat, bis hin zum Parameternamen. Jedes `Where` umschließt im Baum das vorherige, und EF flacht die Kette zu einem einzigen `WHERE` mit `AND` ab. Die Kompositionshelfer brauchen Sie also nur, wenn der Operator `Or` ist, wenn Sie auf einen anderen Entitätstyp umhängen, oder wenn Sie ein Prädikat aus einer Collection zusammensetzen, deren Länge zur Kompilierzeit unbekannt ist. Extension Methods über `IQueryable<T>` erledigen den einfachen `And`-Fall ganz ohne Expression-Code:

```csharp
public static IQueryable<Customer> ActiveOnly(this IQueryable<Customer> q)
    => q.Where(c => !c.IsDeleted && c.Orders.Count > 0);

public static IQueryable<Customer> InCountry(this IQueryable<Customer> q, string country)
    => q.Where(c => c.Country == country);

db.Customers.ActiveOnly().InCountry("NL");
```

Wieder dasselbe SQL. Sie geben nur die Möglichkeit auf, das Prädikat wieder herauszuziehen und gegen eine Liste im Speicher zu verwenden, und genau das erkauft Ihnen die `Expression<Func<T, bool>>`-Variante.

## Verwandte Artikel

- [Fix: "The LINQ expression could not be translated" in EF Core 11](/de/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)
- [Benannte Query-Filter für Soft Delete und Multi-Tenancy in EF Core 11 nutzen](/de/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/)
- [Das von EF Core 11 erzeugte SQL protokollieren](/de/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [Kompilierte Abfragen mit EF Core für heiße Pfade nutzen](/de/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [IEnumerable vs IAsyncEnumerable vs IQueryable in C#](/de/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/)

## Quellen

- [Client- versus Server-Auswertung](https://learn.microsoft.com/en-us/ef/core/querying/client-eval), EF Core Dokumentation
- [dotnet/efcore#17791: 3.0-Regression, Expression.Invoke übersetzen](https://github.com/dotnet/efcore/issues/17791)
- [Neuerungen in EF Core 9: EF.Parameter und EF.Constant](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/whatsnew)
- [Queryable.Where und Queryable.OrderBy](https://learn.microsoft.com/en-us/dotnet/api/system.linq.queryable), .NET API-Referenz
- Sämtliches SQL wurde mit `ToQueryString()` gegen `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0-preview.7.26381.103 auf dem .NET SDK 11.0.100-preview.7.26381.103 erfasst, ohne Datenbankverbindung
