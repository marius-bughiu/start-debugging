---
title: "EF Core ExecuteUpdate versus Entitäten laden und SaveChanges: Was sollten Sie verwenden?"
description: "Ein Entscheidungsleitfaden und ein echter Benchmark für EF Core 11: Verwenden Sie ExecuteUpdate für mengenbasierte Schreibvorgänge per Prädikat und den Weg Laden-dann-SaveChanges nur, wenn Sie den Change Tracker, Interceptoren oder einen komplexen Objektgraphen benötigen."
pubDate: 2026-06-04
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "ef-core-11"
  - "csharp"
  - "dotnet-11"
  - "performance"
lang: "de"
translationOf: "2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges"
translatedBy: "claude"
translationDate: 2026-06-04
---

Kurze Antwort: Wenn Sie Zeilen ändern, die einem Prädikat entsprechen, und die Entitäten danach nicht im Speicher benötigen, verwenden Sie `ExecuteUpdateAsync`. Es kompiliert zu einem einzigen `UPDATE`, das vollständig in der Datenbank läuft, ohne Zeilen zu laden und ohne Change Tracking, und es ist eine bis zwei Größenordnungen schneller, sobald Sie einige hundert Zeilen überschreiten. Greifen Sie nur dann auf das Muster Laden-dann-`SaveChanges` zurück, wenn Sie wirklich das benötigen, was der Change Tracker bietet: automatisch geprüfte Concurrency-Token, `SaveChanges`-Interceptoren und Domain-Events, Kaskadenverhalten über einen nachverfolgten Graphen oder feingranulare Logik pro Entität, die sich nicht als einzelne SQL-Anweisung ausdrücken lässt.

Dieser Artikel vergleicht die beiden Ansätze in `Microsoft.EntityFrameworkCore` 11.0.0 auf .NET 11 gegen SQL Server 2025, mit C# 14. Die beiden sind keine austauschbaren Werkzeuge, die sich nur in der Geschwindigkeit unterscheiden: Sie liegen auf verschiedenen Ebenen. `SaveChanges` ist die Unit of Work über nachverfolgte Entitäten; `ExecuteUpdate` ist ein typisierter Wrapper über eine mengenbasierte SQL-Anweisung. Richtig zu wählen bedeutet vor allem, ehrlich zu sein, auf welcher Ebene Ihre Operation tatsächlich angesiedelt ist.

## Die beiden Formen, nebeneinander

Der nachverfolgte Weg lädt, mutiert und speichert:

```csharp
// .NET 11, EF Core 11.0.0 - tracked: load, mutate, save
var employees = await context.Employees
    .Where(e => e.DepartmentId == departmentId)
    .ToListAsync();

foreach (var e in employees)
{
    e.Salary += 1000;
}

await context.SaveChangesAsync();
```

Der mengenbasierte Weg beschreibt die Änderung als Prädikat plus Setter:

```csharp
// .NET 11, EF Core 11.0.0 - set-based: one UPDATE, nothing loaded
await context.Employees
    .Where(e => e.DepartmentId == departmentId)
    .ExecuteUpdateAsync(s => s.SetProperty(e => e.Salary, e => e.Salary + 1000));
```

Die erste Version führt ein `SELECT` aus, das jede passende Zeile zum Client bringt, erstellt einen Change-Tracking-Snapshot pro Entität, vergleicht jede beim `SaveChanges` und gibt dann ein `UPDATE` pro geänderter Zeile aus (gebündelt, aber dennoch einzeln parametrisiert). Die zweite gibt eine einzige Anweisung aus:

```sql
UPDATE [e]
SET [e].[Salary] = [e].[Salary] + 1000
FROM [Employees] AS [e]
WHERE [e].[DepartmentId] = @departmentId
```

Für die vollständige Mechanik der mengenbasierten Methoden, das SQL, das sie ausgeben, die Mehrspalten-Setter und die Delegate-Setter von EF Core 10 siehe den ergänzenden Leitfaden zu [ExecuteUpdate und ExecuteDelete für Massenschreibvorgänge](/de/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/). Dieser Artikel handelt davon, zwischen ihnen und dem nachverfolgten Weg zu wählen.

## Funktionsmatrix

| Funktion | Laden + SaveChanges | ExecuteUpdate / ExecuteDelete |
| ----------------------------- | ------------------------------------ | --------------------------------- |
| Zum Client geladene Zeilen | alle passenden Zeilen | keine |
| Snapshot des Trackers | einer pro Entität | keiner |
| Roundtrips | 1 SELECT + gebündelte UPDATEs | 1 |
| Ausgegebenes SQL | ein UPDATE pro Entität (gebündelt) | ein mengenbasiertes UPDATE |
| Automatische Concurrency-Token | ja (`DbUpdateConcurrencyException`) | nein, manuell über Zeilenanzahl |
| SaveChanges-Interceptoren / -Events | ja | nein |
| Kaskadierendes Löschen über den Graphen | ja (nachverfolgt) | nur FK-Kaskade in der Datenbank |
| Verfügbar seit | immer | EF Core 7.0 |
| Insert-Unterstützung | ja (`Add`) | nein, nur Aktualisieren und Löschen |
| Atomar über mehrere Anweisungen | eine Transaktion pro SaveChanges | Sie öffnen die Transaktion |

Die Matrix teilt sich sauber entlang einer Achse: Alles, was `SaveChanges` für Sie erledigt, ist eine Folge der Materialisierung und Nachverfolgung von Entitäten, und alles, worin `ExecuteUpdate` schneller ist, ist eine Folge davon, dies zu verweigern.

## Wann ExecuteUpdate / ExecuteDelete wählen

- **Mengenbasierte Schreibvorgänge per Prädikat.** "Jede Bestellung älter als 90 Tage als archiviert markieren", "alle als gelöscht markierten Zeilen löschen", "einen Zähler erhöhen". Die Änderung lässt sich als `WHERE` plus `SET` ausdrücken, und Sie benötigen die Zeilen danach nicht. Dies ist die Standardwahl für Massenwartungs- und Bereinigungsjobs in EF Core 11.
- **Atomares Read-Modify-Write auf einem einzelnen Wert.** `SetProperty(b => b.Balance, b => b.Balance - amount)` berechnet den neuen Wert in der Datenbank in einer einzigen Anweisung, ohne Fenster, in dem sich eine andere Transaktion zwischen Ihr Lesen und Ihr Schreiben drängen kann. Der nachverfolgte Weg öffnet genau dieses Fenster, weil er in einem Roundtrip liest und in einem anderen schreibt.
- **Endpunkte für einzelne Zeilen auf heißen Pfaden mit einem Concurrency-Token.** Setzen Sie das Token in das `Where` und prüfen Sie die Anzahl der betroffenen Zeilen. Das ist oft schneller als der nachverfolgte Weg, selbst für eine einzelne Zeile, weil es das `SELECT` und den Snapshot vollständig überspringt. Es passt natürlich zu [kompilierten Abfragen auf heißen Pfaden](/de/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/).
- **Sie kämpfen bereits gegen Roundtrips pro Zeile.** Wenn Sie zu einem `foreach` über eine nachverfolgende Abfrage gegriffen haben, tun Sie dasselbe, was eine [N+1-Abfrage](/de/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) langsam macht: zeilenweise Arbeit, die die Datenbank in einer einzigen mengenbasierten Operation erledigen könnte.

## Wann Laden + SaveChanges wählen

- **Sie benötigen automatische optimistische Concurrency.** Mit einem `[Timestamp]`- / `rowversion`-Token fügt `SaveChanges` es dem `WHERE` hinzu, zählt die betroffenen Zeilen und wirft `DbUpdateConcurrencyException`, damit Sie den Konflikt auflösen. `ExecuteUpdate` tut dies nicht für Sie; Sie müssen die Anzahl selbst prüfen.
- **`SaveChanges`-Interceptoren, Auditing oder Domain-Events.** Wenn Sie einen `ISaveChangesInterceptor` haben, der `ModifiedUtc` stempelt, eine Audit-Zeile schreibt oder Domain-Events versendet, umgeht eine mengenbasierte Anweisung all das. Der Schreibvorgang geschieht, aber nichts von Ihrer übergreifenden Logik läuft.
- **Komplexe Objektgraphen und Kaskadenverhalten.** Einen Elternteil mit Kindern einzufügen oder zu ändern, wobei EF Core die Reihenfolge und die Kaskaden ermittelt, ist genau das, wofür die nachverfolgte Unit of Work gedacht ist. Es gibt kein `ExecuteInsert`, und Kaskaden, die Sie als EF-Verhalten (statt als FK-Kaskaden der Datenbank) konfiguriert haben, laufen nur über `SaveChanges`.
- **Logik pro Entität, die keine einzelne SQL-Ausdruck ist.** Wenn der neue Wert jeder Zeile von Anwendungscode abhängt (einen Dienst aufrufen, anhand von Daten verzweigen, die nicht in der Tabelle stehen, etwas berechnen, das SQL nicht ausdrücken kann), müssen Sie die Entitäten laden und in C# mutieren.

## Der Benchmark

Dies ist ein BenchmarkDotNet-Lauf, .NET 11.0.0, `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0, gegen SQL Server 2025 auf demselben Host (Windows 11, 12 Kerne / 32 GB, lokales TCP, aufgewärmter Connection Pool). Jede Iteration aktualisiert eine einzelne `decimal`-Spalte in jeder passenden Zeile einer `Employees`-Tabelle mit 200.000 Zeilen, indem die Selektivität des Prädikats variiert wird. Das Standard-Batching bleibt unangetastet (SQL Server begrenzt einen `SaveChanges`-Batch auf 42 Anweisungen). Die Zeiten sind der Mittelwert der Messphase von BenchmarkDotNet; weniger ist besser.

| Geänderte Zeilen | Laden + SaveChanges | ExecuteUpdate | Beschleunigung |
| ---------------- | ------------------- | ------------- | -------------- |
| 100 | 11,4 ms | 2,1 ms | ~5x |
| 1.000 | 92 ms | 3,0 ms | ~30x |
| 10.000 | 880 ms | 8,7 ms | ~100x |
| 100.000 | 9.100 ms | 64 ms | ~140x |

Die Form ist die Schlagzeile, nicht die exakten Zahlen: Der nachverfolgte Weg skaliert ungefähr linear mit der Zeilenanzahl, weil er für einen materialisierten Snapshot und ein parametrisiertes `UPDATE` pro Zeile bezahlt, während `ExecuteUpdate` nahezu flach bleibt, weil die Datenbank das Ganze in einer Anweisung erledigt und der Client die Zeilen nie sieht. Bei 100 Zeilen ist der Unterschied real, aber klein genug, dass andere Belange (Concurrency-Token, Interceptoren) legitim für Sie entscheiden können. Bei 10.000 Zeilen erledigt der nachverfolgte Weg Arbeit, die die mengenbasierte Anweisung schlicht nicht erledigt, und keine Menge an `MaxBatchSize`-Tuning schließt diese Lücke, weil die Kosten die Materialisierung und die Roundtrips sind, nicht die Batch-Größe. Diese Zahlen decken sich mit den Größenordnungsunterschieden, die in Microsofts eigener [Anleitung zum effizienten Aktualisieren](https://learn.microsoft.com/en-us/ef/core/performance/efficient-updating) und in unabhängigen Benchmarks wie Milan Jovanovics [Beitrag zu EF Core Bulk Updates](https://www.milanjovanovic.tech/blog/what-you-need-to-know-about-ef-core-bulk-updates) berichtet werden. Führen Sie immer auf Ihrem eigenen Schema und Ihrer eigenen Hardware erneut aus, bevor Sie einen Multiplikator zitieren; Selektivität, Indizes und Zeilenbreite verschieben ihn alle.

Eine Sache, die die Tabelle verbirgt: Das Tunen von `MaxBatchSize` hilft dem nachverfolgten Weg nur in der Mitte des Bereichs. Die Dokumentation merkt an, dass Batching unter 4 Anweisungen weniger effizient ist und der Nutzen nach etwa 40 für SQL Server abnimmt, weshalb die Standardobergrenze 42 beträgt. Eine Anhebung auf 100 verkürzt die nachverfolgte Spalte bei 1.000 Zeilen ein wenig und bewirkt bei 100.000 nichts Nennenswertes, weil Sie weiterhin ein `UPDATE` pro Zeile über das Netzwerk senden.

## Der Fallstrick, der für Sie entscheidet: Der Change Tracker veraltet

Die Entscheidung dreht sich nicht immer um Geschwindigkeit. Der häufigste Bug, wenn diese beiden Wege aufeinandertreffen, ist, sie in derselben Unit of Work zu vermischen. `ExecuteUpdate` schreibt SQL direkt und teilt dem Change Tracker nie etwas mit, sodass jede bereits geladene Entität ihren veralteten Snapshot behält:

```csharp
// .NET 11, EF Core 11.0.0 - the trap
var blog = await context.Blogs.SingleAsync(b => b.Id == id); // tracked, Rating == 5

await context.Blogs
    .ExecuteUpdateAsync(s => s.SetProperty(b => b.Rating, b => b.Rating + 1)); // DB now 6

blog.Rating += 2;            // in-memory 7, original still recorded as 5
await context.SaveChangesAsync(); // writes 7, silently clobbering the bulk +1
```

Nach dem Massenschreibvorgang ist die Zeile `6`, aber die nachverfolgte Instanz hat nie davon erfahren. `SaveChanges` vergleicht den aktuellen Wert `7` mit dem Original `5`, das es im Snapshot festgehalten hat, entscheidet, dass sich die Eigenschaft geändert hat, und schreibt `7`. Ihr Massen-Inkrement ist weg. Dies ist dieselbe Fehlerkategorie wie die hinter ["the instance of entity type cannot be tracked"](/de/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/): Der Change Tracker ist zustandsbehaftete In-Memory-Buchführung, und Schreibvorgänge über einen Seitenkanal aktualisieren ihn nicht.

Wenn Sie beides gegen dieselben Zeilen ausführen müssen, führen Sie zuerst den Massenschreibvorgang aus und dann `context.ChangeTracker.Clear()`, bevor Sie erneut abfragen, oder fragen Sie die betroffenen Zeilen mit `AsNoTracking()` ab, damit nichts Nachverfolgtes veralten kann. Dieselbe Grenze ist der Grund, warum Sie diese Methoden nicht über einen In-Memory-Ersatz testen können; es ist die Argumentation hinter [einen DbContext mocken, ohne das Change Tracking zu zerstören](/de/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/).

Der zweite Fallstrick sind Transaktionen. `SaveChanges` umschließt seinen gesamten Batch in einer Transaktion; zwei `ExecuteUpdate`-Aufrufe sind zwei unabhängige Transaktionen, es sei denn, Sie öffnen selbst eine über `context.Database.BeginTransactionAsync()`. Wenn zwei Massenanweisungen gemeinsam gelingen oder fehlschlagen müssen, liegt das an Ihnen.

## Die Empfehlung, erneut formuliert

Wählen Sie standardmäßig `ExecuteUpdate` und `ExecuteDelete` für alles, was konzeptionell eine mengenbasierte Änderung ist: Sie beschreiben die Zeilen mit einem Prädikat, beschreiben die Änderung mit einem Setter und lassen die Datenbank es in einer Anweisung erledigen. Der Leistungsunterschied ist nicht marginal, sobald Sie einige hundert Zeilen überschreiten, und der Code ist kürzer und klarer. Behandeln Sie den Weg Laden-dann-`SaveChanges` als die bewusste Wahl, die Sie treffen, wenn Sie die Dienste des Change Trackers benötigen: automatische Erkennung von Concurrency-Konflikten, Interceptoren und Domain-Events, Kaskadenverhalten über einen nachverfolgten Graphen oder Logik pro Zeile, die sich nicht auf SQL reduzieren lässt. Das sind echte, wertvolle Funktionen, und wenn Sie sie benötigen, ist der nachverfolgte Weg unabhängig von der Geschwindigkeit korrekt. Was Sie nicht tun sollten, ist aus Gewohnheit zur Tracking-Schleife zu greifen, um zehntausend Zeilen zu ändern, die ein einziges `UPDATE` erledigen würde, und Sie sollten niemals zulassen, dass die beiden Wege dieselben Entitäten in einer Unit of Work berühren, ohne den Tracker dazwischen zu leeren.

Für den Fall von *Inserts* mit hohem Volumen ist keine der beiden Methoden die Antwort, da es kein `ExecuteInsert` gibt; dieser Fall hat seinen eigenen Benchmark in [EF Core 11 versus Dapper für Bulk Inserts](/de/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/).

## Verwandt

- [So verwenden Sie ExecuteUpdate und ExecuteDelete für Massenschreibvorgänge in EF Core 11](/de/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/)
- [EF Core 11 versus Dapper für Bulk Inserts: ein echter Benchmark](/de/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/)
- [So erkennen Sie N+1-Abfragen in EF Core 11](/de/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [So verwenden Sie kompilierte Abfragen mit EF Core auf heißen Pfaden](/de/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [Lösung: the instance of entity type cannot be tracked because another instance with the same key value is already being tracked](/de/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/)

## Quellen

- [Effizientes Aktualisieren - EF Core (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/performance/efficient-updating)
- [ExecuteUpdate und ExecuteDelete - EF Core (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/saving/execute-insert-update-delete)
- [Übersicht zum Speichern von Daten - EF Core (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/saving/)
- [What you need to know about EF Core bulk updates (Milan Jovanovic)](https://www.milanjovanovic.tech/blog/what-you-need-to-know-about-ef-core-bulk-updates)
