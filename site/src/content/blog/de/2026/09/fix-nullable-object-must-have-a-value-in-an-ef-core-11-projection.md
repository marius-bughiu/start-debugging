---
title: "Lösung: InvalidOperationException: Nullable object must have a value in einer EF Core 11 Projektion"
description: "EF Core wirft diesen Fehler, wenn ein Select ein SQL-NULL in einen nicht nullbaren int, decimal oder DateTime liest. Casten Sie das Member auf seinen nullbaren Typ und ergänzen Sie ?? default, oder sichern Sie die Navigation mit einer Null-Prüfung ab."
pubDate: 2026-09-14
template: error-page
tags:
  - "errors"
  - "efcore"
  - "dotnet"
  - "linq"
lang: "de"
translationOf: "2026/09/fix-nullable-object-must-have-a-value-in-an-ef-core-11-projection"
translatedBy: "claude"
translationDate: 2026-09-14
---

EF Core wirft `InvalidOperationException: Nullable object must have a value`, wenn das für Ihr `Select` generierte SQL `NULL` in einer Spalte liefert, die Ihre Projektion einem nicht nullbaren Werttyp zuweist (`int`, `decimal`, `DateTime`, `Guid`, ein Struct). Die üblichen Verdächtigen sind eine optionale Navigation (`o.Customer.Rating` bei einer Bestellung ohne Kunde), `Max`/`Min`/`Average` über eine leere Collection und ein ganzes DTO von der leeren Seite eines `DefaultIfEmpty`-Joins. Die Lösung besteht darin, die Nullbarkeit im LINQ sichtbar zu machen: Casten Sie auf den nullbaren Typ (`(int?)o.Customer.Rating`) und geben Sie mit `?? 0` einen Standardwert an, oder schreiben Sie `o.Customer == null ? 0 : o.Customer.Rating`. Alle folgenden Ergebnisse wurden mit `Microsoft.EntityFrameworkCore` 11.0.0-rc.1.26425.128 auf .NET 11 RC 1 gemessen und mit EF Core 10.0.12 verglichen. Ein Fall ist in EF Core 11 neu: das Projizieren einer JSON Complex Collection zusammen mit einer Collection-Navigation. Das ist eine echte Regression und hat einen eigenen Abschnitt.

## Der Fehler im Kontext

Im Laufzeitfall stammt die Exception aus dem kompilierten Shaper, nicht aus Ihrem Code oder dem Datenbanktreiber. Dadurch wirkt der Stack Trace nutzlos:

```
System.InvalidOperationException: Nullable object must have a value.
   at lambda_method272(Closure, QueryContext, DbDataReader, ResultContext, SingleQueryResultCoordinator)
   at Microsoft.EntityFrameworkCore.Query.Internal.SingleQueryingEnumerable`1.Enumerator.MoveNext()
   at System.Collections.Generic.List`1..ctor(IEnumerable`1 collection)
```

`lambda_method` ist der Materializer, den EF Core für Ihre Projektion kompiliert hat. Er liest jede Spalte als nullbaren Wert und ruft dann `.Value` auf, um sie in Ihr nicht nullbares Member zu schreiben. Ist die Spalte `NULL`, wirft `Nullable<T>.Value`, und Sie erhalten dieselbe Meldung wie bei `((int?)null).Value` in reinem C#. Die Abfrage wurde problemlos übersetzt, und das SQL lief problemlos. Fehlgeschlagen ist die Umwandlung von Zeile in Objekt.

Stehen stattdessen ``System.Nullable`1.get_Value()`` und `SelectExpression.ClientProjectionRemappingExpressionVisitor.VisitExtension` ganz oben, ist die Abfrage beim Kompilieren gescheitert, bevor überhaupt SQL lief. Sogar `ToQueryString()` wirft dann. Das ist die EF Core 11 Regression, die weiter unten im Abschnitt zur JSON Complex Collection behandelt wird.

## Warum das passiert

LINQ-to-Objects und SQL sind sich uneinig, was "fehlend" bedeutet. In C# wirft `order.Customer.Rating` bei einem null-`Customer` eine `NullReferenceException`, und `new List<decimal>().Max()` wirft `Sequence contains no elements`. In SQL erzeugt ein `LEFT JOIN` ohne Treffer `NULL`-Spalten, und `MAX` über null Zeilen liefert `NULL`. EF Core übersetzt nach der SQL-Semantik, daher gibt es in der Datenbank keine Exception. Das `NULL` landet dann in einem CLR-Member, das es nicht aufnehmen kann.

EF Core gleicht das bereits an mehreren Stellen aus. `Sum` wird in `COALESCE(..., 0)` verpackt, ein skalares `FirstOrDefault()` in einer Unterabfrage in `ISNULL`, und die Materialisierung von Entitäten prüft die Schlüsselspalten, bevor ein Objekt erzeugt wird. Der Fehler tritt in den Lücken auf, die das nicht abdeckt. Diese Lücken sind in EF Core 10 und 11 gleich, abgesehen von einem Fix und einer Regression.

## Minimale Reproduktion

Das Modell enthält Bestellungen mit optionalem Kunden sowie einen Kunden ("Bob") ganz ohne Bestellungen:

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

Das `!` bringt die Nullable-Warnung zum Schweigen. Zur Laufzeit bewirkt es nichts. EF Core generiert einen einfachen `LEFT JOIN`:

```sql
-- EF Core 11 RC 1, SQL Server provider, via ToQueryString()
SELECT [o].[Id], [c].[Rating]
FROM [Orders] AS [o]
LEFT JOIN [Customers] AS [c] ON [o].[CustomerId] = [c].[Id]
```

Die Zeile der Gastbestellung hat `NULL` in `[c].[Rating]`, und das `int Rating` des anonymen Typs kann das nicht aufnehmen. Ein benanntes DTO (`new OrderDto { Rating = o.Customer!.Rating }`) und ein bloßer Skalar (`Select(o => o.Customer!.Rating)`) scheitern auf die gleiche Weise.

## Lösungen, nach Präferenz geordnet

### 1. Auf den nullbaren Typ casten und dann einen Standardwert wählen

Das ist die häufigste Lösung und erzeugt das günstigste SQL:

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

Wenn "kein Kunde" und "Bewertung 0" für den Aufrufer Unterschiedliches bedeuten, lassen Sie das `?? 0` weg und machen Sie das DTO-Member zu `int?`. So bleibt der Unterschied erhalten, was meist ehrlicher ist, als eine Null zu erfinden.

### 2. Die Navigation explizit absichern

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var rows = db.Orders
    .Select(o => new { o.Id, Rating = o.Customer == null ? 0 : o.Customer.Rating })
    .ToList();
```

EF Core wandelt die Null-Prüfung in einen Test auf den gejointen Schlüssel um. Das ist das korrekte Signal für "hat der Join getroffen", selbst wenn das Member selbst eine nullbare Spalte ist:

```sql
SELECT [o].[Id], CASE
    WHEN [c].[Id] IS NULL THEN 0
    ELSE [c].[Rating]
END
FROM [Orders] AS [o]
LEFT JOIN [Customers] AS [c] ON [o].[CustomerId] = [c].[Id]
```

Verwenden Sie diese Form, wenn Sie mehrere Member aus derselben optionalen Navigation projizieren oder wenn das Member ein String oder ein anderer Referenztyp ist und Sie eine nicht nullbare DTO-Eigenschaft wollen.

### 3. Aggregate über möglicherweise leere Collections

`Sum` ist sicher. `Max`, `Min` und `Average` sind es nicht. Auf EF Core 11 RC 1 genauso wie auf 10.0.12:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
db.Customers.Select(c => new { c.Name, Biggest = c.Orders.Max(o => o.Total) });      // throws for Bob
db.Customers.Select(c => new { c.Name, Avg = c.Orders.Average(o => o.Total) });      // throws for Bob
db.Customers.Select(c => new { c.Name, Sum = c.Orders.Sum(o => o.Total) });          // Bob = 0.0
db.Customers.Select(c => new { c.Name, Last = c.Orders.OrderBy(o => o.Id)
                                                .Select(o => o.Total).FirstOrDefault() }); // Bob = 0.0
```

Das generierte SQL zeigt den Grund. `Sum` erhält `COALESCE(SUM([o].[Total]), 0.0)`, und die `FirstOrDefault`-Unterabfrage erhält `ISNULL((SELECT TOP(1) ...), 0.0)`. `MAX` und `AVG` kommen unverpackt durch. Die Lösung ist derselbe Cast, diesmal im Selektor des Aggregats:

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

`c.Orders.Select(o => o.Total).DefaultIfEmpty().Max()` funktioniert ebenfalls, wird aber zu einem `LEFT JOIN` gegen eine abgeleitete Tabelle mit einer Zeile `SELECT 1 AS empty` kompiliert. Der nullbare Cast liefert dasselbe Ergebnis mit einfacherem SQL.

### 4. `DefaultIfEmpty`-Joins, die ein DTO projizieren

Das ist die Form aus [dotnet/efcore#30915](https://github.com/dotnet/efcore/issues/30915): ein manueller Left Join, bei dem die innere Seite ein projiziertes DTO statt einer Entität ist.

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

LINQ-to-Objects würde für die Gastbestellung `Customer = null` liefern. EF Core versucht stattdessen, ein `CustomerDto` aus lauter `NULL`-Spalten zu bauen. Joinen Sie die Entität und bauen Sie das DTO nach dem Join hinter einer Null-Prüfung:

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

Mit einer Entität auf der inneren Seite kann EF Core anhand der Schlüsselspalte entscheiden, ob die Zeile getroffen hat. Bei einem reinen projizierten DTO gibt es nichts zu prüfen. Das EF-Team verfolgt genau diese Variante als [dotnet/efcore#38608](https://github.com/dotnet/efcore/issues/38608), die noch offen ist, und erklärt, dass für den Fix die Überarbeitung der Navigation Expansion nötig ist.

## Was EF Core 11 bereits behoben hat: `LeftJoin` gegen ein `GroupBy`

Eine Fallgruppe ist in EF Core 11 tatsächlich besser geworden: ein `LeftJoin` (der in .NET 10 hinzugefügte Operator, siehe [die Join-Operatoren von LINQ in .NET 10 und 11](/de/2026/06/linq-fulljoin-tuple-returning-joins-dotnet-11-preview-5/)) gegen ein gruppiertes Aggregat, gemeldet als [dotnet/efcore#38055](https://github.com/dotnet/efcore/issues/38055):

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

EF Core 11 fügt jetzt eine synthetische Spalte in die innere Unterabfrage ein und macht das Objekt davon abhängig:

```sql
SELECT [c].[Name], [o0].[CustomerId], [o0].[Count], [o0].[marker]
FROM [Customers] AS [c]
LEFT JOIN (
    SELECT [o].[CustomerId], COUNT(*) AS [Count], 1 AS [marker]
    FROM [Orders] AS [o]
    GROUP BY [o].[CustomerId]
) AS [o0] ON [c].[Id] = [o0].[CustomerId]
```

`[marker]` ist nur dann `NULL`, wenn der Join keinen Treffer hatte, sodass `x.g == null` endlich bedeutet, was es aussagt. Das kam mit [dotnet/efcore#38479](https://github.com/dotnet/efcore/pull/38479) (gemergt im Juni 2026), mit Nachbesserungen für Werttyp-Projektionen ([#38555](https://github.com/dotnet/efcore/pull/38555)) und nachfolgende Joins ([#38499](https://github.com/dotnet/efcore/pull/38499)). Nichts davon wurde nach 10.0.x zurückportiert. Auf EF Core 10 casten Sie innerhalb der Gruppierung (`Count = (int?)g.Count()`) und lesen `x.g!.Count ?? 0`. Das funktioniert auf beiden Versionen und erzeugt `ISNULL([o0].[Count], 0)`.

## EF Core 11 RC 1 Regression: JSON Complex Collection plus Collection-Navigation

Dieser Fall ist überhaupt kein Datenproblem. Wird eine JSON-gemappte Complex Collection (`ComplexCollection(...).ToJson()`, siehe [JSON-Spalten in EF Core 11 mappen](/de/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/)) zusammen mit einer Collection-Navigation im selben `Select` projiziert, wirft EF Core bereits beim Kompilieren der Abfrage:

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

Jede Hälfte funktioniert für sich allein. `AsSplitQuery()` hilft nicht, weil der Fehler auftritt, bevor EF Core entscheidet, wie aufgeteilt wird. Das ist [dotnet/efcore#38928](https://github.com/dotnet/efcore/issues/38928), seit 11.0.0-preview.1 als Regression markiert. Der Fix, [dotnet/efcore#38932](https://github.com/dotnet/efcore/pull/38932), wurde am 2026-09-09 in `main` gemergt. Der Backport nach `release/11.0`, [#38948](https://github.com/dotnet/efcore/pull/38948), war am 2026-09-14 noch offen. RC 1 hat den Bug also, und der Fix dürfte in einem späteren RC oder im GA landen. Bis dahin laden Sie entweder die Entität mit `Include` und mappen im Speicher:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var dtos = (await db.Parents.Include(p => p.Links).AsNoTracking().ToListAsync())
    .Select(p => new ParentDto { Name = p.Name, Items = p.Items, Links = p.Links.Select(l => l.Name).ToList() })
    .ToList();
```

oder Sie führen zwei Projektionen aus (eine für die JSON-Spalte, eine für die Navigation) und fügen sie über den Schlüssel zusammen. Beides funktioniert auf RC 1. Die `Include`-Variante lädt jede `Link`-Spalte, bei breiten Tabellen ist daher die Variante mit zwei Abfragen besser.

## Ähnliche Fehler, die hier landen

- **`The data is NULL at ordinal 1. This method can't be called on NULL values`** (SQLite) oder **`SqlNullValueException: Data is Null`** (SQL Server): eine Spalte, die in der Datenbank nullbar ist, aber auf eine nicht nullbare Eigenschaft gemappt wurde, typisch für Database-First-Modelle und Views. Der Provider wirft beim Lesen der Spalte, bevor der Shaper von EF Core sie sieht. Nur auf SQLite gemessen. Die Lösung liegt im Modell: Machen Sie die Eigenschaft zu `int?` oder korrigieren Sie die Spalte. Weder `(int?)p.Stock` noch `(int?)p.Stock ?? -1` in der Projektion hilft (beide werfen auf EF Core 11 RC 1 weiterhin), weil EF Core dem Modell vertraut und die Spalte mit `GetInt32` liest.
- **`Sequence contains no elements`**: die LINQ-to-Objects-Version desselben Leere-Menge-Problems oder ein `First()`/`Single()`, das im Speicher lief. Siehe [den eigenen Beitrag dazu](/de/2026/07/fix-invalidoperationexception-sequence-contains-no-elements/).
- **`An exception was thrown while attempting to evaluate a LINQ query parameter expression`**, das `Nullable object must have a value` umhüllt: Hier wird Ihr eigenes `maybe!.Value` clientseitig als Parameter ausgewertet, bevor überhaupt SQL läuft. Das behandelt [der Beitrag zur Parameterauswertung](/de/2026/08/fix-an-exception-was-thrown-while-attempting-to-evaluate-a-linq-query-parameter-expression/).

## Die verantwortliche Spalte schnell finden

Der Stack Trace des Shapers nennt das Member nie. Zwei schnelle Wege, es zu finden:

1. Rufen Sie `query.ToQueryString()` auf und suchen Sie nach einer Spalte von der nullbaren Seite eines `LEFT JOIN`, `OUTER APPLY` oder einer unverpackten `MAX`/`MIN`/`AVG`-Unterabfrage. [Das von EF Core 11 generierte SQL protokollieren](/de/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) behandelt die anderen Möglichkeiten.
2. Ändern Sie die Projektion vorübergehend auf `(int?)` / `(decimal?)` für jedes Werttyp-Member, führen Sie sie aus und prüfen Sie, welches `null` zurückgibt. Dieses Member müssen Sie korrigieren.

Wirft schon `ToQueryString()` selbst, liegt das Problem beim Kompilieren. Prüfen Sie auf EF Core 11 RC 1, ob die oben beschriebene Form aus JSON plus Navigation vorliegt. Schlägt die Übersetzung statt der Materialisierung fehl, sehen Sie in der Regel eine andere Meldung, die [der Leitfaden zu "could not be translated"](/de/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/) behandelt.

Ein Hinweis zur Methode: Jede Zeilenanzahl und jede Exception oben stammt aus der Ausführung der Abfragen gegen SQLite im Speicher, auf beiden EF Core Versionen. Das SQL für SQL Server wurde mit `ToQueryString()` generiert, nicht ausgeführt. Der werfende Materializer ist providerunabhängig, daher scheitern dieselben Projektionen auf SQL Server genauso, aber für diesen Beitrag habe ich keine SQL Server Instanz betrieben.

## Quellen

- [dotnet/efcore#38928](https://github.com/dotnet/efcore/issues/38928): Regression bei JSON Complex Collection plus Collection-Navigation; Fix [#38932](https://github.com/dotnet/efcore/pull/38932), Backport [#38948](https://github.com/dotnet/efcore/pull/38948).
- [dotnet/efcore#30915](https://github.com/dotnet/efcore/issues/30915) und [#38055](https://github.com/dotnet/efcore/issues/38055): per Left Join verknüpfte Projektionen ohne Entität; teilweiser Fix in [#38479](https://github.com/dotnet/efcore/pull/38479).
- [dotnet/efcore#38608](https://github.com/dotnet/efcore/issues/38608): die noch offene `DefaultIfEmpty`-Variante mit reinem projiziertem DTO.
- [dotnet/efcore#33802](https://github.com/dotnet/efcore/issues/33802): inkonsistentes Verhalten von Aggregaten über leere Collections.
- [dotnet/efcore#35950](https://github.com/dotnet/efcore/issues/35950): die `DefaultIfEmpty` `COALESCE` Regression aus EF Core 9, behoben in EF Core 10.
- [Komplexe Abfrageoperatoren in EF Core](https://learn.microsoft.com/ef/core/querying/complex-query-operators) auf Microsoft Learn.
