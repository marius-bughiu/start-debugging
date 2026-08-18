---
title: "Lösung: CA1873 \"Evaluation of this argument may be expensive and unnecessary if logging is disabled\""
description: "CA1873 meldet das implizite params object[]-Array, daher löst fast jeder LogDebug-Aufruf die Regel aus. Beheben Sie es mit [LoggerMessage] oder einem IsEnabled-Guard."
pubDate: 2026-08-18
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "logging"
  - "analyzers"
  - "performance"
lang: "de"
translationOf: "2026/08/fix-ca1873-evaluation-of-this-argument-may-be-expensive-and-unnecessary-if-logging-is-disabled"
translatedBy: "claude"
translationDate: 2026-08-18
---

CA1873 ist ein Performance-Analyzer, der im .NET 10 SDK als **Vorschlag** aktiviert ist, nicht als Warnung. Er erscheint deshalb in Visual Studio, Rider und `dotnet format`, lässt `dotnet build` aber sauber. Ausgelöst wird er durch das implizite `params object?[]`-Array, das jeder Aufruf im Stil von `ILogger.LogDebug` allokiert. Das bedeutet, dass er praktisch bei jedem strukturierten Logging-Aufruf mit mindestens einem Argument anschlägt, selbst bei einem einfachen String. Die eigentliche Lösung ist die Codegenerierung mit `[LoggerMessage]`, die schnelle Lösung ein `IsEnabled`-Guard, dessen Level exakt zum Aufruf passt.

Der Diagnosetext, nach dem Sie suchen:

```text
warning CA1873: Evaluation of this argument may be expensive and unnecessary if logging is disabled
```

Alles Folgende wurde gegen SDK `10.0.201`, `Microsoft.Extensions.Logging` 10.0.0 und C# 14 verifiziert, mit dem Analyzer-Quellcode aus `dotnet/sdk`.

## Was macht CA1873 in dotnet build unsichtbar?

Weil der Standard-Schweregrad in .NET 10 Vorschlag (info) ist, und Diagnosen auf Info-Ebene werden von `dotnet build` nicht ausgegeben und von `TreatWarningsAsErrors` nicht erfasst.

Ein Projekt mit einem Dutzend `LogDebug`-Aufrufen kompiliert vollständig sauber:

```text
    0 Warning(s)
    0 Error(s)
```

Machen Sie auf eine von zwei Arten eine echte Warnung daraus:

```xml
<!-- .NET 10 SDK 10.0.201: promotes every "All"-mode analyzer, CA1873 included -->
<PropertyGroup>
  <AnalysisMode>All</AnalysisMode>
</PropertyGroup>
```

```ini
# .editorconfig, targeted at just this rule
[*.{cs,vb}]
dotnet_diagnostic.CA1873.severity = warning
```

Dasselbe Projekt meldet dann 12 CA1873-Warnungen. Wenn Sie Analyzer-Schweregrade in CI verdrahten, sind die Abwägungen in [TreatWarningsAsErrors aus den Entwicklungs-Builds heraushalten](/de/2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10/) beschrieben.

## Wie kann ein offensichtlich günstiges Argument CA1873 auslösen?

Das ist der Teil, der Leute zu Suchmaschinen treibt. Die Regel betrachtet nicht nur Ihr Argument. Sie betrachtet das **implizite `params object?[]`-Array**, das der Compiler zur Übergabe dieses Arguments erzeugt, und die Erzeugung eines nicht leeren Arrays wird selbst als teuer gemeldet.

`LoggerExtensions.LogDebug` hat keine params-freie Überladung, die Nachrichtenargumente entgegennimmt:

```csharp
// Microsoft.Extensions.Logging.Abstractions 10.0.0
public static void LogDebug(this ILogger logger, string? message, params object?[] args);
```

`_logger.LogDebug("v {V}", x)` kompiliert also zu einer `object[1]`-Allokation, unabhängig davon, was `x` ist. Die Kostenprüfung des Analyzers behandelt jede Array-Erzeugung als Verstoß, sofern das Array nicht leer ist:

```csharp
// dotnet/sdk, AvoidPotentiallyExpensiveCallWhenLogging.cs
static bool IsEmptyImplicitParamsArrayCreation(IArrayCreationOperation arrayCreationOperation) =>
    arrayCreationOperation.IsImplicit &&
    arrayCreationOperation.DimensionSizes.Length == 1 &&
    arrayCreationOperation.DimensionSizes[0].ConstantValue.HasValue &&
    arrayCreationOperation.DimensionSizes[0].ConstantValue.Value is int size &&
    size == 0;
```

Ich habe eine Matrix gebaut, um zu bestätigen, was tatsächlich auslöst. Jeder dieser Fälle erzeugte CA1873 auf SDK 10.0.201:

```csharp
// .NET 10, C# 14, Microsoft.Extensions.Logging.Abstractions 10.0.0
public void StringProp(Order o) => _logger.LogDebug("v {V}", o.Name);      // CA1873
public void IntProp(Order o)    => _logger.LogDebug("v {V}", o.Id);        // CA1873
public void StringField()       => _logger.LogDebug("v {V}", _nameField);  // CA1873
public void StringLocal()       { var s = "a"; _logger.LogDebug("v {V}", s); }  // CA1873
public void StringParam(string s) => _logger.LogDebug("v {V}", s);         // CA1873
public void ConstInt()          => _logger.LogDebug("v {V}", 42);          // CA1873
```

Nur ein Aufruf ganz ohne Nachrichtenargumente entkommt, denn dann hat das implizite params-Array die Länge null:

```csharp
public void LiteralOnly() => _logger.LogDebug("nothing to see");           // clean
```

Das ist die ganze Überraschung. An `o.Name` ist nichts falsch. Eine Änderung vom November 2025 mit dem Titel "Reduce noise from CA1873" nahm Eigenschaftszugriffe, `GetType`, `GetHashCode` und `Stopwatch.GetTimestamp` gezielt von der Kostenprüfung aus, doch diese Ausnahme gilt für die *Elemente* des Arrays, während die Array-Allokation selbst weiterhin gemeldet wird. Für die params-basierten Überladungen bleibt die Rauschreduzierung unsichtbar.

## Wie sieht die minimale Reproduktion aus?

```csharp
// .NET 10 (SDK 10.0.201), C# 14
// dotnet new console + Microsoft.Extensions.Logging.Abstractions 10.0.0
using Microsoft.Extensions.Logging;

public class OrderService(ILogger<OrderService> logger)
{
    public void Process(Order order)
    {
        // CA1873: Evaluation of this argument may be expensive
        // and unnecessary if logging is disabled
        logger.LogDebug("Order {OrderId} for {Customer}", order.Id, order.Customer);
    }
}
```

Mit `<AnalysisMode>All</AnalysisMode>` oder einem expliziten Schweregrad in `.editorconfig` meldet dieser einzelne Aufruf CA1873.

## Wie behebe ich CA1873 richtig?

Verwenden Sie den `[LoggerMessage]`-Source-Generator. Er erzeugt eine stark typisierte Methode ohne params-Array und ohne Boxing, sodass für den Analyzer nichts zu melden und für die Laufzeit nichts zu allokieren bleibt, wenn das Level deaktiviert ist.

```csharp
// .NET 10, C# 14. The class must be partial.
public partial class OrderService(ILogger<OrderService> logger)
{
    public void Process(Order order) => LogOrder(order.Id, order.Customer);

    [LoggerMessage(Level = LogLevel.Debug, Message = "Order {OrderId} for {Customer}")]
    private partial void LogOrder(int orderId, string customer);
}
```

Die generierte Methode prüft `IsEnabled`, bevor sie ihre Argumente anfasst. Der Analyzer bleibt still, und der Aufruf kostet nichts, wenn Debug aus ist. Das ist derselbe Mechanismus wie beim [Ersetzen von new Regex(...) durch den GeneratedRegex-Source-Generator](/de/2026/08/how-to-replace-new-regex-with-the-generatedregex-source-generator-in-dotnet-11/). Falls Ihnen das Muster unbekannt ist, beginnen Sie bei [was ein Source Generator ist und wann Sie einen brauchen](/de/2026/06/what-is-a-source-generator-and-when-do-i-need-one/).

## Wann reicht ein IsEnabled-Guard?

Wenn Sie eine einzeilige Änderung wollen und die Klasse nicht in einen partial-Typ umbauen möchten. Der Analyzer erkennt den Guard und unterdrückt die Diagnose:

```csharp
// .NET 10, C# 14
if (logger.IsEnabled(LogLevel.Debug))
{
    logger.LogDebug("Order {OrderId} for {Customer}", order.Id, order.Customer);
}
```

Zwei Einschränkungen, bei denen ich jeweils verifiziert habe, dass ihre Verletzung eine Diagnose erzeugt:

**Das Level muss exakt übereinstimmen.** Ein `LogDebug` mit `IsEnabled(LogLevel.Information)` abzusichern meldet weiterhin CA1873, weil der Analyzer die Konstante im Guard gegen das Level des Aufrufs vergleicht:

```csharp
if (logger.IsEnabled(LogLevel.Information))
{
    logger.LogDebug("v {V}", order.Describe());   // CA1873, levels differ
}
```

**Der Guard muss inline stehen.** Ihn hinter eine Eigenschaft oder Hilfsmethode zu ziehen hebelt die Prüfung vollständig aus, weil der Analyzer die umschließenden Operationen nach einem wörtlichen `ILogger.IsEnabled`-Aufruf durchsucht:

```csharp
private bool DebugOn => logger.IsEnabled(LogLevel.Debug);

public void Process(Order order)
{
    if (DebugOn) { logger.LogDebug("v {V}", order.Describe()); }   // CA1873
}
```

## Wie teuer ist der ungeschützte Aufruf tatsächlich?

Teuer genug, um auf einem heißen Pfad zu zählen, und außerhalb davon irrelevant. Gemessen mit BenchmarkDotNet 0.15.4 auf .NET 10.0.5, Intel Core Ultra 7 265KF, mit Mindestlevel `Information`, sodass der Debug-Aufruf deaktiviert ist:

| Methode | Mittelwert | Ratio | Allokiert |
| --- | ---: | ---: | ---: |
| Unguarded | 13,22 ns | 1,00 | 64 B |
| Guarded | 0,27 ns | 0,02 | 0 B |
| SourceGenerated | 0,51 ns | 0,04 | 0 B |

Die 64 Bytes sind das `object[2]`-Array plus der geboxte `int`. Beide Lösungen senken das auf null. Achten Sie auf das Verhältnis, nicht nur auf die Nanosekunden: 13 ns pro Aufruf sind belanglos in einem Request-Handler, der eine Datenbankabfrage ausführt, und sehr relevant in einer Schleife, die eine Million Mal läuft. Genau deshalb wird die Regel als Vorschlag und nicht als Warnung ausgeliefert.

## Welche Log-Level prüft CA1873?

Standardmäßig Information und darunter. Die Designbegründung aus der Commit-Historie des Analyzers lautet, dass heiße Pfade auf Debug und Trace loggen, während Warning und Error selten genug sind, dass der Overhead pro Aufruf keine Rolle spielt.

Es gibt außerdem einen undokumentierten `.editorconfig`-Schalter, um die Schwelle zu ändern:

```ini
# Not listed on the CA1873 docs page. Values: trace, debug, information, warning, error, critical
[*.{cs,vb}]
dotnet_code_quality.CA1873.max_log_level = warning
```

Alle Werte auf SDK 10.0.201 durchzuspielen ergibt Folgendes, und legt einen Fehler offen:

| `max_log_level` | Level, die CA1873 melden |
| --- | --- |
| `trace` | Trace, **Critical** |
| `debug` | Trace, Debug, **Critical** |
| `information` (Standard) | Trace, Debug, Information, **Critical** |
| `warning` | Trace, Debug, Information, Warning, Critical |
| `error` | alle sechs |

`LogCritical` meldet bei jeder Schwelle, auch bei `trace`. Das ist ein Off-by-one-Fehler: Der ausgelieferte Vergleich schließt Critical aus dem Bereich aus, für den vorzeitig abgebrochen wird.

```csharp
// dotnet/sdk commit 574cda32, "CA1873: Fix log level comparison"
-                    logLevel < LogLevelCritical &&
+                    logLevel <= LogLevelCritical &&
```

Die Korrektur landete am 2026-06-19 in `dotnet/sdk`, nach der Auslieferung von SDK 10.0.201. Bis Sie auf ein SDK wechseln, das sie enthält, melden `LogCritical`-Aufrufe weiterhin CA1873, egal wie Sie `max_log_level` konfigurieren. Unterdrücken Sie diese einzeln, statt die Regel abzuschalten.

## Bekannter Fehlalarm: abgesicherte generierte Aufrufe

Wenn Sie eine per Source-Generator erzeugte Log-Methode in eine `IsEnabled`-Prüfung einwickeln, meldet der Analyzer trotzdem CA1873. Das ist als offenes Issue gegen den Analyzer erfasst und reproduziert sich auf SDK 10.0.201:

```csharp
// .NET 10, C# 14. Guarded, source-generated, still reports CA1873.
if (logger.IsEnabled(LogLevel.Information))
{
    LogKeys([.. dictionary.Select(p => p.Key)]);
}

[LoggerMessage(Level = LogLevel.Information, Message = "keys {Keys}")]
private partial void LogKeys(string[] keys);
```

Der Guard zählt nur, wenn er einen erkannten `ILogger`-Aufruf umschließt. Eine generierte Methode ist für den Analyzer eine gewöhnliche Methode, deshalb wird das Collection-Expression-Argument eigenständig bewertet und gemeldet. Unterdrücken Sie diesen Fall lokal, bis die Korrektur ausgeliefert ist:

```csharp
#pragma warning disable CA1873
    LogKeys([.. dictionary.Select(p => p.Key)]);
#pragma warning restore CA1873
```

## Verwechslungskandidaten, die versehentlich auf dieser Seite landen

**CA1848** ("For improved performance, use the LoggerMessage delegates") schlägt an denselben Aufrufstellen an und hat dieselbe Lösung, betrifft aber die Kosten des Parsens der Nachrichtenvorlage bei jedem Aufruf, nicht die Auswertung der Argumente. Meist sehen Sie beide zusammen, und `[LoggerMessage]` räumt beide ab.

**CA2254** ("The logging message template should not vary between calls") betrifft String-Interpolation, die Ihre strukturierten Felder zerstört. Falls Sie eigentlich dem nachjagen, siehe [Migration von ILogger-String-Interpolation zu Nachrichtenvorlagen](/de/2026/07/migrate-from-ilogger-string-interpolation-to-message-templates-in-dotnet-11/), was auch `SkipEnabledCheck` und `[LogProperties]` behandelt.

## Sollten Sie die Regel einfach abschalten?

Für eine Codebasis, die auf Anfragepfaden mit Information loggt und keine gemessenen heißen Schleifen hat: ja. Setzen Sie sie auf `none` und greifen Sie das Thema wieder auf, wenn ein Profil sagt, dass der Logging-Overhead zählt:

```ini
[*.{cs,vb}]
dotnet_diagnostic.CA1873.severity = none
```

Der nützlichere Mittelweg ist, sie beim Standard-Schweregrad Vorschlag zu belassen und `[LoggerMessage]` opportunistisch anzuwenden. Sie bekommen den IDE-Hinweis an den Aufrufstellen, die Sie ohnehin anfassen, kein CI-Rauschen, und allokationsfreies Logging sammelt sich mit der Zeit an, statt als Refactoring über 400 Dateien anzukommen. Der Allokationsgewinn ist real, nur nicht dringend, und das params-Array dahinter ist dasselbe, das C# 13 [für andere APIs zu beseitigen begann](/de/2026/01/c-13-the-end-of-params-allocations/).

## Verwandt

- [Migration von ILogger-String-Interpolation zu Nachrichtenvorlagen für strukturiertes Logging in .NET 11](/de/2026/07/migrate-from-ilogger-string-interpolation-to-message-templates-in-dotnet-11/)
- [Sensible Werte mit LogProperties in .NET aus den Logs schwärzen](/de/2026/08/how-to-redact-sensitive-values-from-logs-with-logproperties-in-dotnet/)
- [Was ist ein Source Generator und wann brauche ich einen?](/de/2026/06/what-is-a-source-generator-and-when-do-i-need-one/)
- [TreatWarningsAsErrors ohne Sabotage der Entwicklungs-Builds (.NET 10)](/de/2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10/)
- [C# 13: Das Ende der params-Allokationen](/de/2026/01/c-13-the-end-of-params-allocations/)

## Quellen

- [CA1873: Avoid potentially expensive logging](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1873) auf MS Learn
- [Add CA1873: Avoid potentially expensive logging](https://github.com/dotnet/roslyn-analyzers/pull/7290), der ursprüngliche Analyzer-PR
- [Reduce noise from CA1873](https://github.com/dotnet/sdk/commit/bb4aee4d), das die Option `max_log_level` und die Ausnahme für Eigenschaftszugriffe hinzufügte
- [CA1873: Fix log level comparison](https://github.com/dotnet/sdk/commit/574cda32), die Korrektur des `LogCritical`-Off-by-one
- [CA1873-Fehlalarme, wenn die Log-Nachricht in einer IsEnabled-Prüfung steckt](https://github.com/dotnet/roslyn-analyzers/issues/7690)
- [LoggerMessageAttribute-API-Referenz](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.logging.loggermessageattribute)
