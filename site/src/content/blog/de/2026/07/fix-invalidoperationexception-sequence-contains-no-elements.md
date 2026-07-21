---
title: "Lösung: System.InvalidOperationException: Sequence contains no elements"
description: "Diese Exception bedeutet, dass Sie .First() oder .Single() auf einer leeren Sequenz aufgerufen haben. Nutzen Sie FirstOrDefault/SingleOrDefault mit null-Prüfung, sichern Sie die Abfrage ab oder beheben Sie, warum die Quelle leer ist."
pubDate: 2026-07-21
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "linq"
  - "ef-core"
lang: "de"
translationOf: "2026/07/fix-invalidoperationexception-sequence-contains-no-elements"
translatedBy: "claude"
translationDate: 2026-07-21
---

`System.InvalidOperationException: Sequence contains no elements` bedeutet, dass Sie `.First()`, `.Single()`, `.Last()` oder einen ihrer Aggregat-Verwandten (`.Average()`, `.Max()`, `.Min()`) auf einer Sequenz aufgerufen haben, die sich als leer herausstellte. Der Operator hat zugesagt, ein Element zurückzugeben, und es gab keines, also wurde die Exception geworfen. Die Lösung besteht darin, zu entscheiden, was "leer" für diesen Aufruf bedeuten soll: Ist leer ein normales Ergebnis, wechseln Sie zu `.FirstOrDefault()` / `.SingleOrDefault()` und behandeln Sie das `null` (oder den Standardwert), das Sie zurückerhalten; ist leer ein Fehler, korrigieren Sie die Abfrage oder die Daten, sodass die Sequenz an dieser Stelle nie leer ist. Dies wurde mit .NET 11, C# 14 und EF Core 11.0.0 geprüft, aber Meldung und Verhalten sind seit dem Erscheinen von LINQ in .NET Framework 3.5 stabil, sodass die Anleitung für jede Version gilt.

## Der Fehler im Kontext

Die vollständige Exception, geworfen aus dem Inneren von `System.Linq`, sieht so aus:

```
System.InvalidOperationException: Sequence contains no elements
   at System.Linq.ThrowHelper.ThrowNoElementsException()
   at System.Linq.Enumerable.First[TSource](IEnumerable`1 source)
   at MyApp.OrderService.GetLatest() in /src/OrderService.cs:line 42
```

Der entscheidende Hinweis ist der oberste Frame: `System.Linq.ThrowHelper.ThrowNoElementsException`. Sehen Sie das im Stack Trace, dann lief ein elementliefernder LINQ-Operator gegen eine leere Quelle. Der genaue Wortlaut ist für die Suche wichtig, denn LINQ wirft aus derselben Klasse vier eng verwandte Meldungen, die Unterschiedliches bedeuten:

- `Sequence contains no elements` -- `.First()`, `.Single()`, `.Last()` (ohne Prädikat) auf einer leeren Quelle.
- `Sequence contains no matching element` -- `.First(predicate)`, `.Single(predicate)`, `.Last(predicate)`, wenn nichts zutraf.
- `Sequence contains more than one element` -- `.Single()` auf einer Quelle mit zwei oder mehr Elementen.
- `Sequence contains more than one matching element` -- `.Single(predicate)`, wenn mehr als ein Element zutraf.

Dieser Beitrag behandelt die erste. Die anderen werden im Abschnitt zu den Varianten behandelt, denn bei der falschen zu landen kostet Sie Zeit.

## Warum das passiert

`.First()` und `.Single()` sind Operatoren mit Vertrag: Ihr Rückgabetyp ist ein nicht-nullbarer `TSource`, sie haben also keine Möglichkeit, "hier ist nichts" zu signalisieren, außer eine Exception zu werfen. Ist die Quelle leer, gibt es kein Element zurückzugeben, und `default(TSource)` zurückzugeben wäre bei einem Referenztyp eine Lüge (Sie erhielten `null`, wo die Signatur einen Wert zusagte). Deshalb wirft die Laufzeit stattdessen `InvalidOperationException`. Das ist eine bewusste Design-Entscheidung, kein Fehler: Die `*OrDefault`-Varianten existieren genau für den Fall, dass leer akzeptabel ist.

Der verwirrende Teil ist, dass die Sequenz oft aus Gründen leer ist, die an der Aufrufstelle unsichtbar sind. Ein vorgelagerter `Where`-Filter hat alle Zeilen entfernt. Eine Datenbanktabelle hat noch keinen passenden Datensatz. Eine Collection wurde geleert oder nie befüllt, weil ein früheres `await` still fehlschlug. Die Exception feuert in der `.First()`-Zeile, aber die eigentliche Ursache liegt drei Zeilen (oder drei Methodenaufrufe) davor. Deshalb ist "einfach in try/catch einpacken" selten der richtige Instinkt: Sie wollen wissen, warum die Sequenz leer ist, und nicht nur das Symptom schlucken.

## Minimale Reproduktion

Der kleinste Code, der sie auslöst:

```csharp
// .NET 11, C# 14
var numbers = new List<int>();     // empty
int first = numbers.First();       // System.InvalidOperationException: Sequence contains no elements
```

Dasselbe passiert, wenn ein Filter alles eliminiert, was die weit häufigere reale Form ist:

```csharp
// .NET 11, C# 14
var orders = new List<Order>
{
    new(Id: 1, Status: "shipped"),
    new(Id: 2, Status: "shipped"),
};

// No pending orders exist, so the filtered sequence is empty.
Order next = orders.First(o => o.Status == "pending");
// System.InvalidOperationException: Sequence contains no matching element
```

Beachten Sie, dass die zweite Meldung die Variante `no matching element` ist, weil ein Prädikat übergeben wurde. Beide stammen aus derselben Fehlerfamilie: Sie nahmen an, dass mindestens ein Element vorhanden wäre, und es war keines da.

## Die Lösung im Detail

Arbeiten Sie diese Optionen der Reihe nach durch. Die ersten beiden decken fast jeden realen Fall ab.

### 1. FirstOrDefault / SingleOrDefault nutzen und den leeren Fall behandeln

Ist eine leere Sequenz ein legitimes Ergebnis (noch keine Zeilen, ein optionaler Lookup, eine Suche, die nichts finden kann), wechseln Sie zur `*OrDefault`-Überladung und prüfen Sie, was Sie zurückerhalten:

```csharp
// .NET 11, C# 14
Order? next = orders.FirstOrDefault(o => o.Status == "pending");
if (next is null)
{
    // No pending order. Handle it: return early, use a fallback, log, whatever fits.
    return;
}
Process(next);
```

`FirstOrDefault` gibt `default(TSource)` zurück, wenn die Sequenz leer ist: `null` bei einem Referenztyp, `0` bei `int`, `default` bei einem Struct. In einer Codebasis mit nullbaren Annotationen (`<Nullable>enable</Nullable>`, der Standard in neuen .NET-11-Vorlagen) typisiert der Compiler das Ergebnis als `Order?` und mahnt Sie so lange, bis Sie auf null prüfen, was genau die Sicherheit ist, die Sie wollen. Überspringen Sie die Prüfung nicht: `First` durch `FirstOrDefault` zu ersetzen und dann das Ergebnis sofort zu dereferenzieren, tauscht nur `InvalidOperationException` gegen eine `NullReferenceException` eine Zeile später. Wirken die Nullbarkeits-Warnungen wie Lärm, ist es der Compiler, der auf die eigentliche Arbeit zeigt, und das hängt direkt mit [CS8618 und nicht-nullbaren Eigenschaften](/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/) zusammen.

Seit .NET 6 gibt es außerdem eine Überladung, mit der Sie Ihren eigenen Standardwert angeben können, was sauberer ist als eine separate null-Prüfung, wenn Sie einen sinnvollen Fallback haben:

```csharp
// .NET 11, C# 14 -- FirstOrDefault(predicate, defaultValue) added in .NET 6
Order next = orders.FirstOrDefault(o => o.Status == "pending", Order.None);
```

### 2. Die Sequenz absichern, bevor Sie First aufrufen

Wenn Sie das erste Element wirklich brauchen, aber nur, falls eines existiert, prüfen Sie zuerst auf Leere. Bei einer In-Memory-Collection genügen `Count` oder `Any()`:

```csharp
// .NET 11, C# 14
if (orders.Count > 0)
{
    Order first = orders.First();   // safe: we know it is non-empty
    Process(first);
}
```

Bevorzugen Sie `Count` (oder `Count > 0`) für alles, was `ICollection<T>` implementiert, etwa `List<T>` oder ein Array, weil es O(1) ist. Nutzen Sie `.Any()` für ein `IEnumerable<T>` mit verzögerter Auswertung, bei dem Sie nicht günstig an eine Anzahl kommen. Schreiben Sie nicht `if (orders.Count() > 0)` auf einer verzögerten Sequenz: `Count()` zählt das gesamte Ding durch, während `Any()` nach dem ersten Element stoppt.

### 3. Beheben, warum die Sequenz leer ist

Manchmal ist leer der Fehler, kein gültiger Zustand. Wenn `orders.First(o => o.Status == "pending")` immer eine Zeile finden sollte und es nicht tut, liegt die eigentliche Korrektur vorgelagert: ein zu strenger Filter, eine Groß-/Kleinschreibungs-Abweichung (`"Pending"` vs. `"pending"`), ein Join, der Zeilen verwarf, oder Daten, die nie eingefügt wurden. Greifen Sie hier erst dann zu einem `*OrDefault`, wenn Sie bestätigt haben, dass die Sequenz leer sein darf. Einen "das sollte nie leer sein"-Fall mit `FirstOrDefault` zu verschleiern, versteckt einen echten Daten- oder Logikfehler und verschiebt den Absturz an eine schwerer zu diagnostizierende Stelle.

### 4. Bei Aggregaten eine nullbare Überladung oder DefaultIfEmpty nutzen

`.Average()`, `.Max()`, `.Min()` und `.Sum()` teilen dieselbe Falle. `.Average()` und die Werttyp-Versionen von `.Max()`/`.Min()` werfen `Sequence contains no elements` auf einer leeren Quelle (`.Sum()` gibt 0 zurück, was seine eigene Überraschung ist). Zwei saubere Lösungen:

```csharp
// .NET 11, C# 14
var prices = new List<int>();

// Option A: project to a nullable so the aggregate returns null instead of throwing.
double? avg = prices.Average(p => (int?)p);   // null when empty, no exception

// Option B: supply a fallback element before aggregating.
int max = prices.DefaultIfEmpty(0).Max();     // 0 when empty
```

`DefaultIfEmpty` ist die Allzweck-Notluke: Es liefert ein einzelnes Standardelement, wenn die Quelle leer ist, sodass jeder nachgelagerte Operator, einschließlich `.First()`, mindestens ein Element sieht.

## Fallstricke und Varianten

Einige Situationen erzeugen diese Exception oder eine nahe Verwandte aus Gründen, die die Meldung nicht ausbuchstabiert:

- **`no matching element` ist eine andere Meldung mit derselben Ursache.** `.First()` auf einer leeren Quelle sagt `Sequence contains no elements`; `.First(predicate)`, das auf nichts zutrifft, sagt `Sequence contains no matching element`. Sie werden von verschiedenen Helfern geworfen, aber die Korrektur ist identisch: `FirstOrDefault(predicate)` und eine null-Prüfung. Hat Ihre Quelle Zeilen, das Prädikat trifft aber nie zu, ist die an `First` übergebene Sequenz faktisch leer.

- **`.Single()` wirft zwei verschiedene Meldungen.** `.Single()` garantiert *genau ein* Element, kann also auf zwei Arten fehlschlagen: `Sequence contains no elements` bei null, und `Sequence contains more than one element` bei zwei oder mehr. Sehen Sie die Variante "more than one", ist `FirstOrDefault` nicht die Korrektur; entweder ist Ihre Eindeutigkeitsannahme falsch (eine fehlende `WHERE`-Klausel, ein doppelter Schlüssel), oder Sie sollten `First` nutzen, weil Sie nur eines von mehreren wollen. Nutzen Sie `Single` nur, wenn ein zweiter Treffer selbst ein Fehler ist, für den sich das Werfen lohnt.

- **EF Core wirft dasselbe aus `First`/`Single`, und die asynchronen Versionen ebenfalls.** `dbContext.Orders.First(o => o.Id == id)` übersetzt zu `SELECT TOP(1)` und wirft `Sequence contains no elements`, wenn keine Zeile zutrifft. `FirstAsync` und `SingleAsync` werfen identisch. Die Korrektur ist `FirstOrDefaultAsync` / `SingleOrDefaultAsync` plus eine null-Prüfung. Weil diese gegen die Datenbank laufen, ist ein leeres Ergebnis oft normal (die Zeile wurde gelöscht, die id ist falsch), sodass die asynchronen `*OrDefault`-Überladungen meist das sind, was Sie wollen. Siehe [IEnumerable vs. IAsyncEnumerable vs. IQueryable](/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/), warum der LINQ-Operator sich gleich verhält, ob er im Speicher oder als SQL läuft.

- **`FirstOrDefault` auf einer Werttyp-Sequenz gibt 0 zurück, nicht null.** Bei `List<int>` gibt `FirstOrDefault()` auf einer leeren Liste `0` zurück, was ein gültiges `int` und von einem echten ersten Element `0` ununterscheidbar ist. Müssen Sie "leer" von "der erste Wert ist zufällig der Standard" unterscheiden, projizieren Sie auf einen nullbaren Typ (`.Select(x => (int?)x).FirstOrDefault()`) oder sichern Sie mit `.Any()` ab, statt sich auf den Standard-Sentinel zu verlassen.

- **Die leere Sequenz kann von einer falsch übersetzten Abfrage kommen, nicht von fehlenden Daten.** In EF Core kann eine Abfrage, die einen Teil eines Filters still clientseitig auswertet, oder eine, die sich gar nicht übersetzen ließ, eine andere (oft leere) Ergebnismenge liefern als erwartet. Wirft ein `First` gegen die Datenbank und Sie sind sicher, dass die Zeile existiert, prüfen Sie, ob die Abfrage so übersetzt wurde, wie Sie es wollten. Dieser Fehlermodus wird in [der LINQ-Ausdruck konnte nicht übersetzt werden](/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/) behandelt.

- **Das Einpacken in try/catch verdeckt die eigentliche Frage.** `InvalidOperationException` um einen `First`-Aufruf zu fangen, stoppt zwar technisch den Absturz, fängt aber auch unverwandte `InvalidOperationException`s (etwa einen Fehler wegen einer während der Enumeration geänderten Collection) und sagt Ihnen nichts darüber, warum die Sequenz leer war. Bevorzugen Sie `*OrDefault` plus einen expliziten Zweig: Das ist schneller (keine Exception-Maschinerie), enger gefasst und selbstdokumentierend.

Das mentale Modell, das Sie behalten sollten: `.First()` und `.Single()` sind Zusicherungen, dass ein Element existiert. `Sequence contains no elements` ist diese Zusicherung, die fehlschlägt. Entscheiden Sie, ob der leere Fall zulässig ist. Ist er das, drücken Sie das mit `FirstOrDefault`/`SingleOrDefault` aus und behandeln Sie den Standardwert, den Sie zurückerhalten. Ist er es nicht, korrigieren Sie Abfrage oder Daten vorgelagert, sodass die Sequenz an dieser Stelle nie leer ist, statt es an der Aufrufstelle zu übertünchen.

## Verwandt

- [Lösung: Der LINQ-Ausdruck konnte in EF Core 11 nicht übersetzt werden](/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/) für den Fall, dass das leere Ergebnis von einer Abfrage kommt, die nicht so lief wie erwartet.
- [IEnumerable vs. IAsyncEnumerable vs. IQueryable in C#](/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/) dafür, warum `First` sich im Speicher und gegen eine Datenbank gleich verhält und wann die Abfrage tatsächlich ausgeführt wird.
- [Lösung: CS8618 nicht-nullbare Eigenschaft muss einen Nicht-null-Wert enthalten](/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/) für die Behandlung des nullbaren Ergebnisses, das `FirstOrDefault` zurückgibt.
- [LINQ FullJoin und Tupel-liefernde Joins in .NET 11](/2026/06/linq-fulljoin-tuple-returning-joins-dotnet-11-preview-5/) für das Formen von Join-Ergebnissen, ohne Zeilen zu verwerfen, die eine Sequenz leer lassen würden.

## Quellen

- Microsoft Learn, [Enumerable.First Method](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.first) (wirft `InvalidOperationException`, wenn die Quellsequenz leer ist oder kein Element dem Prädikat entspricht; nutzen Sie `FirstOrDefault`, um stattdessen einen Standardwert zurückzugeben).
- Microsoft Learn, [Enumerable.Single Method](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.single) (wirft, wenn die Sequenz leer ist, mehr als ein Element enthält oder kein Element zutrifft).
- Microsoft Learn, [Enumerable.FirstOrDefault Method](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.firstordefault) (gibt `default(TSource)` für eine leere Sequenz zurück, plus die .NET-6-Überladung, die einen expliziten Standardwert akzeptiert).
- Microsoft Learn, [Enumerable.DefaultIfEmpty Method](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.defaultifempty) (liefert ein einzelnes Standardelement, wenn die Quelle leer ist).
