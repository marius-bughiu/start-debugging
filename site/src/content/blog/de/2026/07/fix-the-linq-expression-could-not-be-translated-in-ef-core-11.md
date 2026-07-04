---
title: "Lösung: \"The LINQ expression could not be translated\" in EF Core 11"
description: "EF Core 11 wirft diese Ausnahme, wenn ein Where oder OrderBy eine Methode aufruft, die es nicht in SQL umsetzen kann. Schreiben Sie das Prädikat mit übersetzbaren Operatoren um, oder holen Sie die Daten zuerst mit AsEnumerable auf den Client."
pubDate: 2026-07-04
template: error-page
tags:
  - "errors"
  - "efcore"
  - "dotnet"
lang: "de"
translationOf: "2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-04
---

EF Core 11 wirft `The LINQ expression could not be translated`, wenn ein Teil Ihrer Abfrage außerhalb des abschließenden `Select` (meist ein `Where`, `OrderBy`, `GroupBy` oder `Join`) eine Methode aufruft oder ein Konstrukt verwendet, das der Datenbankanbieter nicht in SQL umsetzen kann. Beheben Sie es, indem Sie das Prädikat mit Operatoren umschreiben, die EF übersetzen kann (`==`, `Contains`, `StartsWith`, `EF.Functions.*`), oder, falls Sie wirklich Logik im Speicher benötigen, die Auswertung auf dem Client bewusst erzwingen, indem Sie `AsEnumerable()`, `AsAsyncEnumerable()`, `ToList()` oder `ToListAsync()` vor dem nicht übersetzbaren Schritt aufrufen. Das gilt für `Microsoft.EntityFrameworkCore` 11.0 auf .NET 11 mit C# 14, und das Verhalten ist seit EF Core 3.0 unverändert.

## Der Fehler im Kontext

Die vollständige Laufzeitausnahme sieht so aus. EF Core gibt den exakten Ausdrucksbaum aus, an dem es gescheitert ist, und das ist der nützlichste Hinweis auf dem ganzen Bildschirm:

```
System.InvalidOperationException: The LINQ expression 'DbSet<Order>()
    .Where(o => o.CustomerName.Equals(
        name,
        StringComparison.OrdinalIgnoreCase))' could not be translated. Either rewrite the query in a form that can be translated, or switch to client evaluation explicitly by inserting a call to 'AsEnumerable', 'AsAsyncEnumerable', 'ToList', or 'ToListAsync'. See https://go.microsoft.com/fwlink/?linkid=2101038 for more information.
```

Der Ausnahmetyp ist `System.InvalidOperationException`, und sie wird geworfen, wenn die Abfrage ausgeführt wird (bei `ToList`, `First`, `foreach` oder `await`), nicht wenn Sie sie zusammensetzen. Deshalb zeigt ein Stack Trace oft auf Ihr Repository oder Ihren Controller statt auf das `Where`, das es tatsächlich verursacht hat. Lesen Sie den zitierten Ausdruck, nicht den Stack Trace.

## Warum das passiert

EF Core übersetzt so viel wie möglich von Ihrer Abfrage in eine einzige SQL-Anweisung und führt sie auf dem Datenbankserver aus. Seit Version 3.0 unterstützt es partielle Auswertung auf dem Client an genau einer Stelle: der Projektion der obersten Ebene, also dem letzten `Select`-Aufruf. Wenn irgendein anderer Teil der Abfrage, ein `Where`, `OrderBy`, `Skip`, `GroupBy`, `Join` oder eine verschachtelte Unterabfrage, einen Ausdruck enthält, den es nicht übersetzen kann, weigert es sich, still die gesamte Tabelle in den Speicher zu laden und dort zu filtern. Stattdessen wirft es die Ausnahme.

Diese bewusste Weigerung ist eine Funktion. Vor EF Core 3.0 wertete das Framework bereitwillig ein nicht übersetzbares `Where` auf dem Client aus, was bedeutete, dass eine scheinbar günstige Abfrage still eine Million Zeilen herunterladen und sie in Ihrem Prozess filtern konnte. Das aktuelle Verhalten tauscht eine laute Ausnahme zur Entwicklungszeit gegen eine Klasse von Performance-Katastrophen in der Produktion, die Sie nie sehen. Wenn Sie auf diesen Fehler stoßen, sagt Ihnen EF Core, dass das von Ihnen geschriebene Prädikat kein SQL-Äquivalent hat.

Die üblichen Auslöser sind:

- Aufruf einer C#-Methode ohne SQL-Zuordnung (ein eigener Helper, `string.Equals` mit einem `StringComparison`, `Enum.HasFlag`, `decimal.Round` mit einem `MidpointRounding`).
- Formatieren oder Parsen innerhalb der Abfrage (`DateTime.ToString("yyyy-MM-dd")`, `int.Parse`, `Guid.Parse`).
- Navigieren zu oder Aufrufen eines Typs, den der Anbieter nicht zuordnen kann (eine berechnete Eigenschaft, die auf C#-Logik beruht, nicht auf einer zugeordneten Spalte).
- Vergleich gegen ein Konstrukt, das der Anbieter für Ihre Datenbank nicht unterstützt (bestimmte `TimeSpan`-Arithmetik, einige `Span`-basierte APIs).

## Minimale Reproduktion

Hier ist das kleinste Programm, das den Fehler reproduziert. Der Vergleich ohne Berücksichtigung der Groß-/Kleinschreibung mit einer `StringComparison`-Überladung ist die häufigste Ursache in der Praxis, weil er sich in C# perfekt liest und vollständig nicht übersetzbar ist:

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

Der Aufruf `Equals(name, StringComparison.OrdinalIgnoreCase)` ist das Problem. EF Core kann "ordinal, ohne Berücksichtigung der Groß-/Kleinschreibung" nicht als SQL ausdrücken, weil die Groß-/Kleinschreibung in SQL durch die Kollation der Spalte bestimmt wird, nicht durch ein Methodenargument. Also wirft es die Ausnahme.

## Lösung im Detail

Die Lösungen sind von der besten (die Arbeit auf dem Server belassen) bis zur letzten Möglichkeit (Daten absichtlich in den Speicher holen) geordnet.

### 1. Schreiben Sie das Prädikat mit übersetzbaren Operatoren um

In neunzig Prozent der Fälle besteht die Lösung darin, dieselbe Absicht mit Operatoren auszudrücken, die EF Core kennt. Für den Vergleich ohne Berücksichtigung der Groß-/Kleinschreibung lassen Sie die `StringComparison`-Überladung ganz weg. Auf SQL Server berücksichtigt die Standardkollation ohnehin keine Groß-/Kleinschreibung, sodass ein einfaches `==` tut, was Sie wollen, und sich in ein sauberes `WHERE` übersetzt:

```csharp
// .NET 11, EF Core 11 -- translates to WHERE [o].[CustomerName] = @name
var orders = await db.Orders
    .Where(o => o.CustomerName == name)
    .ToListAsync();
```

Wenn Sie den Vergleich ohne Berücksichtigung der Groß-/Kleinschreibung unabhängig von der Spaltenkollation benötigen, verwenden Sie `EF.Functions.Collate`, um den Vergleich an eine Kollation ohne Berücksichtigung der Groß-/Kleinschreibung zu binden, die der Anbieter in eine `COLLATE`-Klausel übersetzt:

```csharp
// .NET 11, EF Core 11 -- explicit case-insensitive comparison in SQL
var orders = await db.Orders
    .Where(o => EF.Functions.Collate(o.CustomerName, "SQL_Latin1_General_CP1_CI_AS") == name)
    .ToListAsync();
```

Die `EF.Functions`-Oberfläche existiert genau dafür: `Like`, `Collate`, `DateDiffDay`, `Contains` (Volltext), `Random` und anbieterspezifische Helper geben Ihnen SQL-Konstrukte, die reines C# nicht ausdrücken kann. Greifen Sie darauf zurück, bevor Sie die Auswertung auf dem Server aufgeben. Für die Teilzeichenfolgen-Übereinstimmung bevorzugen Sie `Contains`, `StartsWith` und `EndsWith`, die sich alle in `LIKE` übersetzen:

```csharp
// .NET 11, EF Core 11 -- translates to WHERE [o].[CustomerName] LIKE @p + '%'
var orders = await db.Orders
    .Where(o => o.CustomerName.StartsWith(name))
    .ToListAsync();
```

### 2. Berechnen Sie den Wert vor der Abfrage, nicht in ihr

Ein großer Teil dieser Fehler ist selbst verschuldet: Sie rufen innerhalb der Abfrage eine Methode auf, deren Ergebnis in Wirklichkeit nicht von der Zeile abhängt. Ziehen Sie sie in eine lokale Variable, und EF Core macht daraus einen Parameter:

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

`DateTime.Year`, `Month`, `Day`, `Date` und ähnliche übersetzen sich tatsächlich (zu `DATEPART` auf SQL Server), während `ToString(format)` es nicht tut. Die Faustregel: Extrahieren Sie das benötigte Datum mit einer Eigenschaft, die EF zuordnen kann, statt den ganzen Wert in eine Zeichenfolge zu formatieren und darauf zu vergleichen.

### 3. Verschieben Sie reine Client-Logik in die Projektion der obersten Ebene

Denken Sie daran, dass EF Core die Auswertung auf dem Client im letzten `Select` erlaubt. Wenn es bei Ihrer nicht übersetzbaren Methode eigentlich um die Formung der Ausgabe geht und nicht um das Filtern, verschieben Sie sie dorthin. Diese Abfrage filtert und ordnet in SQL und führt dann den C#-Helper nur auf den zurückgegebenen Zeilen aus:

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

`FormatCustomer` würde in einem `Where` die Ausnahme werfen, aber im abschließenden `Select` ist es zulässig und läuft im Speicher auf der bereits gefilterten Ergebnismenge. Das ist der sanktionierte Weg, SQL-Filterung mit C#-Formatierung zu kombinieren.

### 4. Erzwingen Sie die Auswertung auf dem Client bewusst (letzte Möglichkeit)

Wenn die Logik wirklich nicht in SQL laufen kann und in einem `Where` stehen muss, entscheiden Sie sich explizit für die Auswertung auf dem Client, indem Sie die Abfrage mit `AsEnumerable` oder `AsAsyncEnumerable` aufbrechen. Alles vor dem Bruch läuft auf dem Server; alles danach läuft im Speicher:

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

Das entscheidende Detail ist, so viel Filterung wie möglich vor die `AsEnumerable`-Grenze zu setzen, damit Sie die wenigsten Zeilen übertragen. `AsEnumerable()` auf einem nackten `DbSet` aufzurufen und danach zu filtern, lädt die gesamte Tabelle herunter, also genau die Katastrophe, vor der die Ausnahme Sie geschützt hat. Bevorzugen Sie hier `AsAsyncEnumerable` gegenüber `ToList`, um das Zwischenergebnis zu streamen statt zu puffern.

## Fallstricke und Varianten

**Es funktionierte in EF Core 2.2 und brach beim Upgrade.** Die Auswertung auf dem Client an beliebiger Stelle wurde in EF Core 3.0 entfernt. Eine Abfrage, die vorher "funktionierte", filterte wahrscheinlich die ganze Zeit im Speicher. Das Upgrade hat Ihre Abfrage nicht kaputt gemacht, es hat ein latentes Performance-Problem offengelegt. Wenn Sie zwischen Hauptversionen wechseln, lohnt sich vor dem Start ein Blick auf die [Breaking Changes, die beim Migrieren von EF Core 6 auf EF Core 11 wirklich zubeißen](/de/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).

**Der In-Memory-Anbieter wirft die Ausnahme nicht, der echte schon.** Wenn Ihre Unit-Tests den In-Memory-Anbieter verwenden, werten sie alles auf dem Client aus und sehen diesen Fehler nie, und dann wirft die Produktion gegen SQL Server oder PostgreSQL die Ausnahme bei derselben Abfrage. Testen Sie gegen einen Anbieter, der übersetzt. Ihre Test-Suite gegen eine echte Datenbank mit etwas wie Testcontainers laufen zu lassen, fängt diese Fälle ab, bevor sie ausgeliefert werden.

**Ein `GroupBy`, das auf etwas projiziert, das SQL nicht aggregieren kann.** Ein `GroupBy` gefolgt von einem `Select`, das rohe gruppierte Entitäten zurückgibt (statt Aggregate wie `Count`, `Sum`, `Max`), lässt sich häufig nicht übersetzen. Formen Sie die Projektion in skalare Aggregate um, oder gruppieren Sie auf dem Client nach dem Materialisieren.

**Navigationseigenschaften und nicht zugeordnete berechnete Mitglieder.** Das Filtern über eine berechnete C#-Eigenschaft (ein Getter mit Logik, keine zugeordnete Spalte) lässt sich nicht übersetzen, weil keine Spalte dahintersteht. Ordnen Sie eine persistierte/berechnete Spalte zu, oder filtern Sie stattdessen über die zugrunde liegenden Spalten.

**`Contains` über eine große lokale Liste.** `Where(o => ids.Contains(o.Id))` übersetzt sich tatsächlich (zu `IN` oder einem tabellenwertigen Parameter in EF Core 11), aber ein verwandtes "could not be translated" kann auftreten, wenn der Elementtyp komplex ist. Halten Sie das `Contains`-Argument als einfache Liste von Skalaren.

**Ein anderer Fehler, derselbe Auslöser.** Wenn Sie `The LINQ expression could not be translated` sehen und direkt darunter einen Hinweis auf `AsSplitQuery`, stoßen Sie an eine Übersetzungsgrenze in einer Abfrage mit mehreren Collection-Includes, nicht an ein Client-Eval-Problem. Dabei geht es um die kartesische Explosion, und die Lösung ist die [Aufteilung von Abfragen zur Vermeidung einer kartesischen Explosion in EF Core 11](/de/2026/06/how-to-use-query-splitting-to-avoid-a-cartesian-explosion-in-ef-core-11/), nicht das Umschreiben eines Prädikats.

Das mentale Modell, das Sie für immer aus diesem Fehler heraushält: Alles außer dem abschließenden `Select` muss zu SQL werden. Bevor Sie ein `Where` schreiben, fragen Sie sich, ob die Datenbank es ausführen könnte. Wenn die Antwort eine C#-Methode betrifft, von der die Datenbank noch nie gehört hat, finden Sie entweder das `EF.Functions`-Äquivalent, berechnen Sie den Wert vor, oder akzeptieren Sie, dass Sie Zeilen in den Speicher holen, und sagen Sie es explizit mit `AsAsyncEnumerable`.

## Verwandt

- [So erkennen Sie N+1-Abfragen in EF Core 11](/de/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) behandelt die andere stille Performance-Falle bei Abfragen, die das Blockieren der Client-Auswertung überlebt.
- [AsNoTracking vs AsNoTrackingWithIdentityResolution in EF Core 11](/de/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/) lohnt die Lektüre, sobald Ihre Leseabfragen sauber übersetzen und Sie sie schneller machen wollen.
- [So ordnen Sie JSON-Spalten zu und fragen sie in EF Core 11 ab](/de/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) zeigt, wie Sie JSON-Prädikate auf dem Server halten, statt zu materialisieren und zu filtern.
- [So verwenden Sie kompilierte Abfragen mit EF Core für Hot Paths](/de/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) hilft, sobald Ihre Abfrage übersetzbar ist und Sie den Durchsatz optimieren.
- [So verwenden Sie ExecuteUpdate und ExecuteDelete für Massenschreibvorgänge in EF Core 11](/de/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) ist das Gegenstück auf der Schreibseite, um die Arbeit in der Datenbank statt im Speicher zu halten.

## Quellen

- [Client- vs. Server-Auswertung, EF-Core-Dokumentation](https://learn.microsoft.com/en-us/ef/core/querying/client-eval)
- [Wie Abfragen funktionieren, EF-Core-Dokumentation](https://learn.microsoft.com/en-us/ef/core/querying/how-query-works)
- [Datenbankfunktionen und EF.Functions, EF-Core-Dokumentation](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/functions)
- [dotnet/efcore issue #24318: "could not be translated" mit dem In-Memory-Anbieter](https://github.com/dotnet/efcore/issues/24318)
