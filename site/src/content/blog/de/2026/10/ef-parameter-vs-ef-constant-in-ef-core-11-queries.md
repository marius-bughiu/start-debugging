---
title: "EF.Parameter vs. EF.Constant in EF Core 11 Abfragen"
description: "EF.Constant schreibt einen erfassten Wert als SQL-Literal in die Abfrage, EF.Parameter macht aus einem Literal einen SQL-Parameter. Belassen Sie die Standardeinstellungen von EF Core, nutzen Sie EF.Parameter, damit dynamisch gebaute Expression Trees nicht bei jedem Aufruf neu kompiliert werden, und EF.Constant nur für Werte mit wenigen Ausprägungen, deren Daten so schief verteilt sind, dass jeder Wert einen eigenen Plan braucht."
pubDate: 2026-10-02
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "dotnet"
  - "sql-server"
  - "performance"
lang: "de"
translationOf: "2026/10/ef-parameter-vs-ef-constant-in-ef-core-11-queries"
translatedBy: "claude"
translationDate: 2026-10-02
---

`EF.Constant(x)` weist EF Core an, einen Wert als Literal ins SQL zu schreiben (`WHERE [Status] = N'Pending'`), obwohl er aus einer Variable stammt und EF ihn normalerweise als Parameter senden würde. `EF.Parameter(x)` macht das Gegenteil: Es erzwingt, dass ein Wert, den EF normalerweise inline schreiben würde, etwa ein Literal oder ein `Expression.Constant` in einem von Hand gebauten Baum, als Parameter übertragen wird (`WHERE [Status] = @p`). Die Standardeinstellungen sind für fast jede Abfrage richtig. Greifen Sie zu `EF.Parameter`, wenn Sie Expression Trees dynamisch bauen, denn rohe Konstanten in diesen Bäumen erzwingen bei jedem neuen Wert eine vollständige Kompilierung der Abfrage. Greifen Sie zu `EF.Constant` nur, wenn eine Spalte wenige verschiedene Werte mit stark schiefer Datenverteilung hat und die Datenbank pro Wert einen eigenen Plan benötigt.

Alles Folgende wurde mit EF Core 11.0.0-rc.1.26425.128 und SDK 11.0.100-rc.1.26425.128 auf einem Apple M4 ausgeführt. Wo angegeben, habe ich zusätzlich EF Core 10.0.12 mit SDK 10.0.302 geprüft, mit demselben Verhalten. `EF.Constant` erschien in EF Core 8.0.2, `EF.Parameter` in EF Core 9 und das auf Collections spezialisierte `EF.MultipleParameters` in EF Core 10.

## Der Vergleich auf einen Blick

| | `EF.Parameter(x)` | `EF.Constant(x)` |
| --- | --- | --- |
| Verfügbar seit | EF Core 9 | EF Core 8.0.2 |
| Skalares Ergebnis im SQL | `@p`-Parameter | Literal, z. B. `N'Pending'` |
| Collection-Ergebnis im SQL (EF 10/11) | ein JSON-Parameter + `OPENJSON` | `IN (1, 2, 3, ...)`-Literale |
| Einträge im EF-Query-Cache bei N verschiedenen Werten | 1 | 1 (seit EF 9) |
| Einträge im Plan-Cache der Datenbank bei N verschiedenen Werten | 1 | bis zu N |
| Plan auf den konkreten Wert zugeschnitten | Nein (Parameter Sniffing greift) | Ja |
| Wert erscheint standardmäßig in den EF-Logs | Nein (`'?'`) | Nein, seit EF 10 als `?` maskiert |
| Funktioniert in `EF.CompileQuery` / Query-Filtern | Nein, wirft eine Exception | Nein, wirft eine Exception |
| Hauptverwendung | dynamische Expression Trees, Erzwingen eines JSON-Collection-Parameters | schief verteilte Spalten mit niedriger Kardinalität, Erzwingen einer inline geschriebenen `IN`-Liste |

## Was EF Core standardmäßig tut

Die Parametrisierungsregel von EF ist einfach: Alles, was von außerhalb des Expression Trees kommt (eine erfasste lokale Variable, ein Feld, ein Methodenargument), wird zum Parameter, und alles, was als Literal im Lambda steht, wird zur Konstante. So sieht das Ergebnis von EF Core 11 RC 1 für SQL Server aus, direkt aus `ToQueryString()`:

```csharp
// EF Core 11.0.0-rc.1, Microsoft.EntityFrameworkCore.SqlServer, .NET 11 RC 1
var status = "Pending";

db.Orders.Where(o => o.Status == status);
// DECLARE @status nvarchar(4000) = N'Pending';
// WHERE [o].[Status] = @status

db.Orders.Where(o => o.Status == "Pending");
// WHERE [o].[Status] = N'Pending'
```

Diese Trennung ist Absicht. Ein Literal im Quellcode kann sich zwischen zwei Ausführungen nicht ändern, deshalb kostet das Inlining nichts und gibt dem Query Optimizer den echten Wert für seine Schätzung. Eine erfasste Variable kann sich bei jedem Aufruf ändern, ein Inlining würde also pro Wert einen anderen SQL-String erzeugen, und jeder verschiedene String bekommt einen eigenen Eintrag im Plan-Cache der Datenbank. Auf einem ausgelasteten SQL Server bedeutet das einen aufgeblähten Plan-Cache und eine Kompilierung bei jedem neuen Wert.

`EF.Constant` und `EF.Parameter` existieren, um diese Regel in beide Richtungen zu überschreiben.

## EF.Constant: ein Literal erzwingen

```csharp
// EF Core 11.0.0-rc.1
var status = "Pending";
db.Orders.Where(o => o.Status == EF.Constant(status));
// WHERE [o].[Status] = N'Pending'

var name = "O'Brien";
db.Orders.Where(o => o.Customer == EF.Constant(name));
// WHERE [o].[Customer] = N'O''Brien'
```

Die zweite Abfrage ist wichtig, wenn Sie sich um SQL Injection sorgen: EF erzeugt das Literal weiterhin über das Typ-Mapping des Providers, deshalb wird das Anführungszeichen maskiert. `EF.Constant` ist keine String-Verkettung.

Der Grund für diesen Weg ist Parameter Sniffing. SQL Server kompiliert einen parametrisierten Plan mit dem ersten Wert, den er sieht, und verwendet diesen Plan für alle späteren Werte weiter. Wenn `Status = 'Archived'` 40 Millionen Zeilen trifft und `Status = 'Pending'` 200, passt ein für den einen kompilierter Plan nicht zum anderen. Mit einem Literal bekommt jeder Wert seinen eigenen Plan mit eigener Kardinalitätsschätzung. Dieser Handel lohnt sich nur, wenn die Spalte eine kleine, feste Menge an Werten hat. Wenn Sie eine Benutzer-ID oder eine Bestellnummer in `EF.Constant` einpacken, bauen Sie genau das Plan-Cache-Problem nach, das die Standardeinstellungen von EF vermeiden sollen.

### EF.Constant kostet keine EF-Neukompilierung mehr

In EF Core 8 fügte die Implementierung die Konstante früh in der Pipeline ein, vor dem Nachschlagen im eigenen Query-Cache von EF, sodass jeder neue Wert eine vollständige LINQ-zu-SQL-Kompilierung auslöste. Die [Seite zu den Breaking Changes in EF Core 9](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/breaking-changes) beschreibt die Neufassung: Die Methode wird jetzt in einer späteren Phase nach dem Cache verarbeitet. Ich habe das geprüft, indem ich das Debug-Log-Ereignis `Compiling query expression` über 500 Ausführungen mit 500 verschiedenen Werten gezählt habe, nach einem Warm-up mit 50 Abfragen, auf SQLite im Arbeitsspeicher:

```csharp
// EF Core 11.0.0-rc.1, Microsoft.EntityFrameworkCore.Sqlite
for (int i = 0; i < 500; i++)
{
    using var db = new Ctx(conn, log: s => { if (s.Contains("Compiling query expression")) compiles++; });
    var value = "S" + i;
    db.Orders.Where(o => o.Status == EF.Constant(value)).ToList();
}
```

Das Ergebnis waren null zusätzliche Kompilierungen: EF verwendet seine kompilierte Abfrage wieder und erzeugt nur den SQL-Text neu. Die Kosten von `EF.Constant` liegen heute vollständig auf der Datenbankseite, ein Plan pro verschiedenem SQL-String.

## EF.Parameter: einen Parameter erzwingen

```csharp
// EF Core 11.0.0-rc.1
db.Orders.Where(o => o.Status == EF.Parameter("Pending"));
// DECLARE @p nvarchar(4000) = N'Pending';
// WHERE [o].[Status] = @p
```

Ein fest codiertes Literal einzupacken ist für sich genommen selten nützlich. Seinen Platz hat `EF.Parameter` beim dynamischen Aufbau von Abfragen. Wenn Sie ein Prädikat mit `System.Linq.Expressions` bauen, schreibt man natürlicherweise `Expression.Constant(value)`, und EF behandelt das genau wie ein Literal im Quellcode:

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

Anders als `EF.Constant` ist ein rohes `Expression.Constant` Teil des Baums, den EF als Cache-Schlüssel verwendet. Daher ist jeder verschiedene Wert ein Cache-Miss und eine vollständige Kompilierung. Hier zeigen sich die messbaren Kosten. Gleicher Testaufbau wie oben, 500 verschiedene Werte, ein Prozess pro Variante, nach dem Warm-up:

| Variante (EF Core 11 RC 1, SQLite im Arbeitsspeicher, M4) | EF-Kompilierungen | Zeit für 500 Abfragen |
| --- | --- | --- |
| Erfasste Variable (Standard) | 0 | 186-292 ms |
| `EF.Constant(variable)` | 0 | 188-226 ms |
| Rohes `Expression.Constant` in einem gebauten Baum | 500 | 2201-2261 ms |
| `Expression.Constant` in `EF.Parameter` eingepackt | 0 | 202-355 ms |

Die Bereiche stammen aus je zwei Läufen. Die Tabelle ist leer, deshalb isoliert die Messung den reinen EF-Overhead: etwa 4 ms Kompilierung pro Abfrage, bevor die Datenbank überhaupt etwas getan hat. Auf SQL Server käme pro verschiedenem String noch eine Plan-Kompilierung der Datenbank hinzu. Ein einziger `Expression.Call` auf `EF.Parameter` bringt den dynamischen Baum zurück auf die Kosten einer normalen LINQ-Abfrage.

Der andere Weg dorthin ist, den Wert in einem Closure-Objekt zu erfassen und `Expression.Property(Expression.Constant(holder), "Value")` zu verwenden, was auch der C#-Compiler für ein Lambda tut. Das funktioniert, aber `EF.Parameter` ist kürzer und macht die Absicht sichtbar. Den Closure-Trick habe ich ausführlicher in [wiederverwendbare LINQ-Prädikate, die EF Core übersetzen kann](/de/2026/08/how-to-write-reusable-linq-predicates-ef-core-can-translate/) behandelt.

## Collections: drei Strategien, drei Marker

Bei einem Skalar ist die Wahl binär. Für eine Collection in `Contains` gibt es in EF Core 10 und 11 drei Übersetzungen, und jede Marker-Methode wählt eine davon pro Abfrage:

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

Der Standard seit EF Core 10 ist ein skalarer Parameter pro Element, aufgefüllt, sodass 8 Werte 10 Parameter ergeben (der letzte Wert wird wiederholt). Das hält die Zahl verschiedener SQL-Strings klein und teilt dem Optimizer trotzdem ungefähr mit, wie viele Werte es sind. `EF.Parameter` auf einer Collection liefert das Verhalten von EF Core 8 und 9 zurück: ein einzelner JSON-Parameter, der mit `OPENJSON` entpackt wird, ein SQL-String für jede Listenlänge, aber keine Kardinalitätsinformation für den Planer. `EF.Constant` schreibt die Werte inline, so wie es EF Core 7 tat.

Der globale Schalter ist `UseParameterizedCollectionMode`:

```csharp
// EF Core 11.0.0-rc.1
options.UseSqlServer(connectionString,
    o => o.UseParameterizedCollectionMode(ParameterTranslationMode.Constant));
```

Damit erzeugt ein einfaches `ids.Contains(...)` `IN (1, 2, ...)`, `EF.MultipleParameters(ids)` schaltet eine einzelne Abfrage zurück auf aufgefüllte Parameter, und `EF.Parameter(ids)` schaltet sie auf `OPENJSON`. Der Modus betrifft nur Collections: Eine skalare erfasste Variable bleibt in jedem Modus `@status`. Die Methoden `TranslateParameterizedCollectionsToConstants()` und `TranslateParameterizedCollectionsToParameters()` aus EF Core 9 wurden in EF Core 10 mit `[Obsolete]` markiert und sind im Quellcode von EF Core 11 RC 1 verschwunden, sodass ein Projekt, das von EF 9 aufrüstet, auf `UseParameterizedCollectionMode` umsteigen muss. Der Rest dieses Upgrade-Pfads steht in der [Anleitung zu den Breaking Changes von EF Core 6 bis 11](/de/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).

## Stolperfallen beim Testen

### Der Marker muss innerhalb des Lambdas stehen

`EF.Constant` und `EF.Parameter` sind Marker, keine Funktionen. Ihre eigentlichen Rümpfe werfen eine Exception. Sie funktionieren nur innerhalb eines Expression Trees, den EF übersetzt. Das hier kompiliert, schlägt aber zur Laufzeit fehl:

```csharp
// EF Core 11.0.0-rc.1
db.Orders.OrderBy(o => o.Id).Take(EF.Constant(10));
// InvalidOperationException: The 'EF.Constant<T>' method may only be used
// within Entity Framework LINQ queries.
```

`Take(int)` erwartet ein einfaches `int`, keine `Expression`, deshalb wertet C# `EF.Constant(10)` sofort aus, außerhalb jeder Abfrage. Dasselbe gilt für jedes Operator-Argument, das kein Lambda ist.

### Nicht in kompilierten Abfragen, nicht in Query-Filtern

Seit EF Core 9 werfen beide Methoden innerhalb von `EF.CompileQuery` und `EF.CompileAsyncQuery` eine Exception. In EF Core 11 RC 1 ist die Meldung klarer als die für EF 9 dokumentierte `InvalidCastException`:

```text
InvalidOperationException: 'EF.Constant<T>' is not supported when using compiled queries or query filters.
InvalidOperationException: 'EF.Parameter<T>' is not supported when using compiled queries or query filters.
```

Wenn Sie in einem Hot Path eine Konstante brauchen, schreiben Sie das Literal in das Lambda der kompilierten Abfrage. Wenn Sie Pläne pro Wert brauchen, ist eine kompilierte Abfrage ohnehin das falsche Werkzeug, weil sie einen einzigen SQL-String festschreibt. Der [Leitfaden zu kompilierten Abfragen](/de/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) behandelt, wann sie sich lohnen. Die Meldung schließt auch globale Query-Filter aus, was relevant ist, wenn Sie gehofft hatten, eine Tenant-ID in einen [benannten Query-Filter](/de/2026/07/named-query-filters-vs-a-single-global-query-filter-in-ef-core-11/) einzubauen.

### Inline geschriebene Werte werden in Logs maskiert

Vor EF Core 10 war eine inline geschriebene Konstante im protokollierten SQL sichtbar, anders als ein Parameterwert. Seit EF Core 10 maskiert EF sie. Aus dem Log von EF Core 11 RC 1, bei ausgeschalteter Protokollierung sensibler Daten:

```text
Executed DbCommand (20ms) [Parameters=[@secret='?' (Size = 17)], ...]
WHERE "o"."Customer" = @secret

Executed DbCommand (0ms) [Parameters=[], ...]
WHERE "o"."Customer" = ?
```

Die Datenbank erhält weiterhin das echte Literal. Nur die Log-Zeile ist maskiert. Dieses `?` kann beim ersten Mal verwirrend sein, wenn Sie [das von EF Core erzeugte SQL protokollieren](/de/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) und versuchen, es in SSMS einzufügen. Schalten Sie in der Entwicklung `EnableSensitiveDataLogging()` ein, um den Wert zu sehen.

### Der Collection-Modus ist nicht Teil des Query-Cache-Schlüssels

Das hat mich überrascht. Zwei Kontexte desselben Typs, einer mit `ParameterTranslationMode.Constant` konfiguriert und einer mit dem Standard, teilen sich einen internen Service Provider und einen Cache für kompilierte Abfragen. Wer eine bestimmte Abfrageform zuerst ausführt, bestimmt das SQL für beide:

```csharp
// EF Core 11.0.0-rc.1 and 10.0.12, same process
using (var a = new Ctx(ParameterTranslationMode.Constant))
    a.Orders.Where(o => ids.Contains(o.Id)).ToQueryString();
// WHERE [o].[Id] IN (1, 2, 3)

using (var b = new Ctx(mode: null))   // default MultipleParameters
    b.Orders.Where(o => ids.Contains(o.Id)).ToQueryString();
// WHERE [o].[Id] IN (1, 2, 3)   <- cached translation from context a
```

Der Quellcode erklärt es. `RelationalOptionsExtension` liefert von `GetServiceProviderHashCode()` den Wert `0` zurück, und `RelationalCompiledQueryCacheKey` enthält `UseRelationalNulls` und `QuerySplittingBehavior`, aber nicht den Collection-Modus. In einer normalen Anwendung mit einer Konfiguration spielt das nie eine Rolle. Es spielt eine Rolle, wenn Sie denselben `DbContext` zweimal mit unterschiedlichen Modi registrieren oder den Modus in einer Test-Fixture umschalten und erwarten, dass der nächste Test anderes SQL sieht. Verwenden Sie in diesem Fall die Marker pro Abfrage, denn sie sind Teil des Expression Trees und damit Teil des Cache-Schlüssels.

## Wann EF.Parameter die richtige Wahl ist

- Sie bauen Prädikate mit `System.Linq.Expressions` (Filter-Builder, Grid-Suche, OData-ähnliche Endpunkte). Packen Sie jedes `Expression.Constant`, das Benutzereingaben trägt, in `EF.Parameter`, sonst zahlen Sie pro verschiedenem Wert eine vollständige Kompilierung.
- Sie wollen die `OPENJSON`-Übersetzung für eine Abfrage, deren Listenlänge stark schwankt (1 bis 2.000 IDs), damit die Datenbank einen Plan statt vieler aufgefüllter Varianten hat.
- Sie haben den globalen Collection-Modus auf `Constant` gesetzt, und eine Abfrage soll wieder davon abweichen.

## Wann EF.Constant die richtige Wahl ist

- Eine Spalte mit wenigen Werten und stark schiefer Datenverteilung, etwa ein Status oder ein Typ-Diskriminator, bei der sich gemessene Pläne je Wert unterscheiden. Bestätigen Sie die Regression zuerst anhand des tatsächlichen Ausführungsplans.
- Eine kurze, stabile Werteliste in `Contains` (eine feste Menge von Rollen oder Regionen), bei der der Optimizer von den sichtbaren Literalen profitiert und die Zahl der möglichen Kombinationen klein ist.
- Niemals für IDs, Benutzereingaben mit unbegrenzter Vielfalt oder irgendetwas innerhalb einer kompilierten Abfrage.

## Die Empfehlung

Lassen Sie die Standardeinstellungen von EF Core 11 in Ruhe, bis Sie eine Messung haben. Der größte praktische Nutzen kommt von `EF.Parameter`, weil ein dynamisch gebauter Baum mit rohen Konstanten ein leicht zu machender Fehler ist, der pro Aufruf etwa 4 ms EF-Kompilierung kostet, bevor die Datenbank überhaupt etwas sieht. `EF.Constant` ist eine gezielte Korrektur für Parameter Sniffing bei schief verteilten Spalten mit niedriger Kardinalität. Es kostet keine EF-Neukompilierung mehr, aber jeder verschiedene Wert kostet weiterhin einen Datenbankplan. Wenn Sie nicht sicher sind, was Sie bekommen haben, zeigt `ToQueryString()` es sofort. Suchen Sie nach `DECLARE @`. Und wenn eine Abfrage nach einem Upgrade schlechter wurde, prüfen Sie [was das SQL-Server-Kompatibilitätslevel für EF Core 11 ändert](/de/2026/09/sql-server-compatibility-level-150-vs-160-what-changes-for-ef-core-11-queries/), bevor Sie zu einem der beiden Marker greifen.

## Quellen

- [What's new in EF Core 9: force or prevent query parameterization](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/whatsnew)
- [What's new in EF Core 10: improved translation for parameterized collections, redacting inlined constants](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew)
- [Breaking changes in EF Core 9: EF.Constant and EF.Parameter in compiled queries](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/breaking-changes)
- [`EF.cs`, `EFExtensions.cs` and `ParameterTranslationMode.cs` in dotnet/efcore](https://github.com/dotnet/efcore/tree/main/src/EFCore)
- [dotnet/efcore#13617, the original plan cache issue for inlined collections](https://github.com/dotnet/efcore/issues/13617)
