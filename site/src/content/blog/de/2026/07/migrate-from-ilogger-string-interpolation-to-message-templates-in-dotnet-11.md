---
title: "Von ILogger-String-Interpolation zu Message-Templates für strukturiertes Logging in .NET 11 migrieren"
description: "Eine Schritt-für-Schritt-Anleitung, um $-interpolierte ILogger-Aufrufe in Message-Templates und [LoggerMessage]-generierte Methoden unter .NET 11 zu überführen: was bricht, wie Sie eine Codebasis mit CA2254 durchkämmen, wie Sie den JSON-State prüfen und wie Sie zurückrollen."
pubDate: 2026-07-25
updatedDate: 2026-07-25
template: migration
tags:
  - "migration"
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "logging"
  - "observability"
lang: "de"
translationOf: "2026/07/migrate-from-ilogger-string-interpolation-to-message-templates-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-07-25
---

Jedes `_logger.LogInformation($"Order {orderId} failed for {customerId}")` in Ihrer Codebasis wirft genau die beiden Felder weg, die Sie beim nächsten Alarm brauchen werden. Diese Anleitung stellt eine .NET-11-Codebasis (SDK 11.0.100-preview.6, C# 14) von interpolierten Log-Aufrufen auf Message-Templates um und wandelt danach die heißen Pfade in `[LoggerMessage]`-generierte Methoden. In einem mittelgroßen Service kostet der Template-Durchlauf einen halben Tag weitgehend mechanischer Änderungen, gesteuert von CA2254, und der Durchgang mit dem Source Generator noch einen Tag, wenn Sie ihn sauber machen. Riskant ist daran nichts: die Korrektur ist nicht breaking, jeder Schritt lässt sich einzeln zurücknehmen, und der Gewinn ist, dass Ihr Log-Backend endlich nach `OrderId` filtern kann statt nach gerenderten Sätzen zu greppen.

## Warum Interpolation genau die Daten verliert, die Sie brauchen

- **Die Struktur ist weg, bevor der Logger sie sieht.** `$"Order {orderId} failed"` wird an der Aufrufstelle zu einem `string.Concat`- oder `DefaultInterpolatedStringHandler`-Aufruf kompiliert. Wenn `ILogger.Log` läuft, existiert keine `orderId`-Eigenschaft mehr, nur noch ein Satz. `{OriginalFormat}` im Log-State enthält dann den vollständig gerenderten Text, sodass jede einzelne Bestell-ID ein eigenes "Template" in Ihrem Aggregator erzeugt.
- **Die Kardinalität explodiert an der falschen Stelle.** Seq, Loki, Elastic und jedes OTLP-Backend gruppieren und indizieren über das Template plus dessen benannte Eigenschaften. Interpolierte Aufrufe liefern ein eindeutiges Template pro Aufruf, also genau die Form, mit der diese Systeme am schlechtesten umgehen.
- **Der String wird gebaut, auch wenn der Level aus ist.** `_logger.LogDebug($"Payload: {Serialize(request)}")` alloziert den String und führt `Serialize` bei jeder Anfrage aus, in Produktion, mit deaktiviertem `Debug`. Microsofts eigene [Anleitung für Bibliotheksautoren](https://learn.microsoft.com/en-us/dotnet/core/extensions/logging/library-guidance) sagt das ausdrücklich. Der Vorschlag, `LoggerExtensions` um Überladungen mit Interpolated String Handler zu ergänzen ([dotnet/runtime#111283](https://github.com/dotnet/runtime/issues/111283)), wurde als nicht geplant geschlossen. Das wird also nicht von selbst behoben.
- **Geschweifte Klammern in Ihren Daten können eine Exception auslösen.** Mehr dazu weiter unten, aber ein interpolierter String, dessen Wert `{` oder `}` enthält, kann aus der Logging-Pipeline heraus eine `FormatException` werfen.

Wenn noch nicht entschieden ist, wohin die Logs gehen, klären Sie das zuerst. [Strukturierte Protokollierung mit Serilog und Seq](/de/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) und [OpenTelemetry mit .NET 11 und einem kostenlosen Backend](/de/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) setzen beide voraus, dass die Templates aus dieser Anleitung bereits korrekt sind.

## Was die beiden Formen tatsächlich erzeugen

Das ist die kleinste Reproduktion. Gleiche Absicht, zwei Aufrufstile, durch den `JsonConsole`-Formatter unter .NET 11.

```csharp
// .NET 11 preview 6, C# 14
int orderId = 4711;
string customerId = "acme-inc";

// Interpolated: the template IS the rendered sentence.
_logger.LogInformation($"Order {orderId} failed for {customerId}");

// Message template: placeholders survive as named properties.
_logger.LogInformation("Order {OrderId} failed for {CustomerId}", orderId, customerId);
```

Der erste Aufruf erzeugt einen State mit einem einzigen nutzlosen Eintrag:

```json
{
  "LogLevel": "Information",
  "Message": "Order 4711 failed for acme-inc",
  "State": {
    "Message": "Order 4711 failed for acme-inc",
    "{OriginalFormat}": "Order 4711 failed for acme-inc"
  }
}
```

Der zweite Aufruf erzeugt die Felder:

```json
{
  "LogLevel": "Information",
  "Message": "Order 4711 failed for acme-inc",
  "State": {
    "Message": "Order 4711 failed for acme-inc",
    "OrderId": 4711,
    "CustomerId": "acme-inc",
    "{OriginalFormat}": "Order {OrderId} failed for {CustomerId}"
  }
}
```

Die gerenderte `Message` ist identisch. Alles, was das Log abfragbar macht, steckt im Unterschied.

## Was bricht

| Bereich | Änderung | Schweregrad |
| --- | --- | --- |
| Aufrufstellen mit `$"..."` | Müssen zu einem konstanten Template plus Argumenten werden | hoch (Menge, nicht Risiko) |
| Log-Abfragen und Dashboards | Gespeicherte Suchen auf gerendertem Text laufen weiter; neue Filter auf Eigenschaften müssen gebaut werden | mittel |
| Alarmregeln auf `{OriginalFormat}` | Der Template-String ändert sich, exakte Treffer auf den alten gerenderten Text greifen nicht mehr | mittel |
| String-Verkettung in Templates | `"Order " + id + " failed"` ist derselbe Defekt und wird von derselben Regel erkannt | mittel |
| Umstellung auf `[LoggerMessage]` | Enthaltende Klasse und Methode müssen `partial` werden; die Methode muss `void` zurückgeben | niedrig |
| `EventId`-Werte | Doppelte IDs innerhalb der Assembly erzeugen Generator-Warnungen | niedrig |
| Serilog-`@`-Destructuring | Die Semantik von `{@Order}` unterscheidet sich von der State-Enumeration in `Microsoft.Extensions.Logging` | niedrig |

Nichts davon ist ein Breaking Change zur Laufzeit. Die Roslyn-Regel, die den Durchlauf steuert, [CA2254](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2254), ist ausdrücklich als nicht breaking dokumentiert.

## Checkliste vorab

- .NET SDK 11.0.100-preview.6 oder neuer installiert (`dotnet --list-sdks`). Alles hier funktioniert auch unter .NET 8, 9 und 10.
- `<LangVersion>` auf 9 oder höher. Der `[LoggerMessage]`-Generator verweigert unterhalb von C# 9 die Arbeit. Unter .NET 11 bekommen Sie C# 14 als Standard.
- `Microsoft.Extensions.Logging.Abstractions` in jedem Projekt referenziert, das `[LoggerMessage]`-Methoden deklariert. Projekte mit `Microsoft.NET.Sdk.Web` erhalten es transitiv.
- `<EnableNETAnalyzers>true</EnableNETAnalyzers>` und `<AnalysisLevel>latest</AnalysisLevel>` in `Directory.Build.props`, sonst schlägt CA2254 nie an.
- Ein sauberer `git status` und ein grüner Testlauf vor dem Start. Der Durchlauf berührt Hunderte Zeilen, und Sie wollen ein triviales Zurücknehmen.

## Migrationsschritte

Die Reihenfolge zählt: erst den Analyzer laut werden lassen, dann alles beheben, was er findet, und erst danach den Source Generator auf den Pfaden einsetzen, wo Allokation tatsächlich etwas kostet.

1. **CA2254 zu einem Build-Fehler machen.** Tragen Sie die Regel zunächst als `warning` in `.editorconfig` ein, um den Umfang zu sehen, und heben Sie sie auf `error`, sobald die Zahl null erreicht. Prüfung: `dotnet build` meldet beim ersten Lauf eine CA2254-Anzahl größer null.
2. **Interpolierte und verkettete Aufrufe in Message-Templates umwandeln.** Ziehen Sie jeden Wert aus dem String heraus und übergeben Sie ihn als Argument, mit einem Platzhalternamen in PascalCase. Prüfung: `dotnet build` meldet null CA2254-Diagnosen.
3. **Argumentreihenfolge korrigieren, denn die Bindung ist positionsbasiert.** `LoggerExtensions` bindet Argumente von links nach rechts an Platzhalter, nicht über Namen. Prüfung: Anwendung starten und prüfen, dass jede Eigenschaft im JSON-State den Wert enthält, den ihr Name verspricht.
4. **`[LoggerMessage]`-Methoden für heiße Pfade ergänzen.** Wandeln Sie Log-Aufrufe pro Anfrage und pro Element in `partial` Methoden einer `partial` Klasse um, damit das Template nur einmal zur Kompilierzeit geparst wird. Prüfung: `dotnet build` ist sauber und die generierte Datei erscheint unter `obj/**/Microsoft.Extensions.Logging.Generators/`.
5. **Pro Nachricht eine stabile `EventId` vergeben und eindeutig halten.** Prüfung: keine `SYSLIB`-Warnungen zu doppelten Event-IDs im Build-Log.
6. **`SkipEnabledCheck` plus manuelle Absicherung verwenden, wo die Auswertung der Argumente teuer ist.** Prüfung: Kategorie auf `Information` setzen und prüfen, dass der teure Aufruf nicht läuft.
7. **Objekte mit `[LogProperties]` statt `ToString()` aufklappen.** Prüfung: die öffentlichen Eigenschaften des Objekts erscheinen als einzelne Einträge im Log-State, nicht als ein einziger flacher String.

### 1. CA2254 zu einem Build-Fehler machen

CA2254 ist ab .NET 10 standardmäßig als Vorschlag aktiviert, was bedeutet, dass die Regel in CI unsichtbar ist. Stufen Sie sie hoch:

```ini
# .editorconfig -- .NET 11, analyzers at latest
[*.{cs,vb}]

# CA2254: Template should be a static expression
dotnet_diagnostic.CA2254.severity = warning
```

Kompilieren und zählen, womit Sie es zu tun haben:

```bash
dotnet build -warnaserror:CA2254 --no-incremental
```

Aktivieren Sie CA1848 noch nicht. Diese Regel schlägt bei jedem `LogInformation`-Aufruf der Codebasis an, auch bei den korrekten, und begräbt das Signal von CA2254. Sie kommt in Schritt 4 zurück.

### 2. Auf Message-Templates umstellen

Die mechanische Umformung in drei häufigen Ausprägungen:

```csharp
// .NET 11, C# 14 -- before
_logger.LogInformation($"Order {order.Id} failed for {order.CustomerId}");
_logger.LogWarning("Retry " + attempt + " of " + maxAttempts);
_logger.LogError(ex, $"Import of {file.Name} aborted after {sw.ElapsedMilliseconds} ms");

// after
_logger.LogInformation("Order {OrderId} failed for {CustomerId}", order.Id, order.CustomerId);
_logger.LogWarning("Retry {Attempt} of {MaxAttempts}", attempt, maxAttempts);
_logger.LogError(ex, "Import of {FileName} aborted after {ElapsedMs} ms", file.Name, sw.ElapsedMilliseconds);
```

Drei Namensregeln, die sich später auszahlen:

- Platzhalter in PascalCase. Microsofts eigene Anleitung empfiehlt das, und es hält Eigenschaftsnamen zwischen handgeschriebenen und generierten Templates konsistent.
- Dasselbe Konzept bekommt überall denselben Namen. Wenn es in einem Service `OrderId` heißt, heißt es in allen `OrderId`, sonst brauchen serviceübergreifende Abfragen pro Schreibweise eine `or`-Klausel.
- Die Exception gehört nie ins Template. `LogError(ex, "...")` reicht sie über den dedizierten `Exception`-Parameter weiter, und der Provider entscheidet über die Darstellung.

### 3. Die Argumentbindung ist positionsbasiert, nicht namensbasiert

Das ist der eine Fehler, den der Durchlauf einschleppen kann, und CA2254 fängt ihn nicht:

```csharp
// .NET 11 -- compiles, no analyzer warning, WRONG
_logger.LogInformation("Order {OrderId} for {CustomerId}", customerId, orderId);
```

`Microsoft.Extensions.Logging` ordnet Platzhalter den Argumenten der Reihe nach zu. Die Namen sind Beschriftungen für die entstehenden Eigenschaften, kein Bindungsschlüssel. Die Log-Zeile rendert die Kunden-ID unter `OrderId`, und niemand merkt es, bis drei Wochen später eine Abfrage Unsinn liefert. Lesen Sie jede umgestellte Zeile einmal mit genau diesem Fehlerbild im Kopf, und stellen Sie lieber eine ganze Methode auf einmal um, statt das Ergebnis eines massenhaften Suchen-und-Ersetzens zu übernehmen.

Der `[LoggerMessage]`-Generator aus Schritt 4 hat dieses Problem nicht: Er ordnet Template-Platzhalter den Parameternamen ohne Beachtung der Groß- und Kleinschreibung zu, die Parameterreihenfolge ist dort also irrelevant.

### 4. [LoggerMessage] auf den heißen Pfaden ergänzen

Message-Templates haben die Struktur repariert. Die Kosten pro Aufruf haben sie nicht repariert: `LoggerExtensions.LogInformation` boxt Werttypen weiterhin in `object`, alloziert ein `params object?[]` und parst das Template bei jedem Aufruf neu. Der [`[LoggerMessage]` Source Generator](/de/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) entfernt alle drei Punkte, indem er zur Kompilierzeit einen stark typisierten `LoggerMessage.Define`-Wrapper erzeugt.

```csharp
// .NET 11 preview 6, C# 14
using Microsoft.Extensions.Logging;

public partial class OrderProcessor(ILogger<OrderProcessor> logger, OrderPipeline pipeline)
{
    public async Task ProcessAsync(Order order, CancellationToken ct)
    {
        try
        {
            await pipeline.RunAsync(order, ct);
            OrderProcessed(order.Id, order.CustomerId);
        }
        catch (PaymentDeclinedException ex)
        {
            OrderFailed(ex, order.Id, order.CustomerId);
        }
    }

    [LoggerMessage(
        EventId = 1001,
        Level = LogLevel.Information,
        Message = "Order {OrderId} processed for {CustomerId}")]
    private partial void OrderProcessed(int orderId, string customerId);

    [LoggerMessage(
        EventId = 1002,
        Level = LogLevel.Warning,
        Message = "Order {OrderId} failed for {CustomerId}")]
    private partial void OrderFailed(Exception ex, int orderId, string customerId);
}
```

Seit .NET 9 liest der Generator den `ILogger` auch aus einem Primary-Constructor-Parameter, deshalb hat das Beispiel oben kein explizites `_logger`-Feld. Existieren Feld und Primary-Constructor-Parameter gleichzeitig, gewinnt das Feld.

Die Einschränkungen, die man sich merken sollte, laut der [Dokumentation zur Source-Generierung](https://learn.microsoft.com/en-us/dotnet/core/extensions/logger-message-generator): Methoden müssen `partial` sein und `void` zurückgeben, weder Methoden- noch Parameternamen dürfen mit einem Unterstrich beginnen, und Parameter dürfen weder `params`, `scoped` noch `out` verwenden und keine `ref struct`-Typen sein. Statische Methoden brauchen den `ILogger` als Parameter; mit `this` werden daraus Erweiterungsmethoden.

Schalten Sie jetzt CA1848 für die umgestellten Projekte ein, eng begrenzt, damit es den Rest nicht überflutet:

```ini
# .editorconfig, in the hot-path project folder only
[*.cs]
# CA1848: Use the LoggerMessage delegates
dotnet_diagnostic.CA1848.severity = warning
```

CA1848 ist auch in .NET 10 und neuer standardmäßig nicht aktiviert und bewusst aggressiv: Sie markiert jeden Aufruf im Stil von `LogInformation`. Aktivieren Sie sie pro Projekt, nicht solutionweit, sofern Sie nicht wirklich jede Nachricht generieren lassen wollen.

### 5. Event-IDs stabil und eindeutig halten

`EventId` ist die stabile Identität einer Log-Nachricht. Sie überlebt Umformulierungen des Templates, was sie zum richtigen Anker für Alarmregeln macht. Legen Sie die IDs pro Assembly an einer Stelle ab, damit Kollisionen auffallen:

```csharp
// .NET 11 -- one file, one range per subsystem
internal static class LogEvents
{
    public const int OrderProcessed = 1001;
    public const int OrderFailed    = 1002;
    public const int PaymentRetried = 1003;
}
```

Der Generator warnt bei doppelten Event-IDs innerhalb einer Klasse. Klassenübergreifend warnt er nicht, die Konstantendatei leistet also echte Arbeit.

### 6. SkipEnabledCheck für teure Argumente

Standardmäßig ruft die generierte Methode zuerst `ILogger.IsEnabled` auf, ein deaktivierter Level kostet also einen virtuellen Aufruf. Was sie nicht kann: den Aufrufer davon abhalten, die Argumente zu berechnen. Wenn ein Argument teuer ist, ziehen Sie die Abfrage nach oben:

```csharp
// .NET 11, C# 14
[LoggerMessage(
    EventId = 2001,
    Level = LogLevel.Debug,
    Message = "Request body: {Body}",
    SkipEnabledCheck = true)]
private partial void RequestBody(string body);

// call site
if (logger.IsEnabled(LogLevel.Debug))
{
    RequestBody(await SerializeAsync(request, ct));  // only runs when Debug is on
}
```

Das ist das Muster, das den Durchsatz zurückholt, den interpolierte `LogDebug`-Aufrufe still gekostet haben.

### 7. Objekte mit [LogProperties] aufklappen

`Message = "Processing {Order}"` mit einem `Order`-Parameter liefert eine einzige Eigenschaft mit der `ToString()`-Ausgabe. Um die Felder des Objekts als getrennte Eigenschaften zu bekommen, fügen Sie `Microsoft.Extensions.Telemetry.Abstractions` hinzu und annotieren den Parameter:

```csharp
// .NET 11, Microsoft.Extensions.Telemetry.Abstractions
[LoggerMessage(
    EventId = 1004,
    Level = LogLevel.Information,
    Message = "Processing order")]
private partial void ProcessingOrder([LogProperties] Order order);
```

Jede öffentliche Eigenschaft von `Order` landet als `order.Id`, `order.CustomerId` und so weiter im Log-State. Dasselbe Paket ermöglicht die Redaktion klassifizierter Parameter, und das ist die richtige Antwort, wenn jemand ein Request-Objekt mit einer E-Mail-Adresse protokolliert haben will.

## Verifikation

Arbeiten Sie diese Liste nach jeder Phase ab, nicht einmal am Ende:

- `dotnet build -warnaserror:CA2254` endet mit Exit-Code null.
- `dotnet test` läuft ohne neue Fehlschläge. Tests, die auf gerenderten Log-Text prüfen, sind der übliche Verlust; schreiben Sie sie so um, dass sie auf die State-Eigenschaften prüfen.
- Stellen Sie den Console-Formatter auf JSON um (`"Console": { "FormatterName": "json" }` in `appsettings.Development.json`), rufen Sie einen repräsentativen Endpunkt auf und lesen Sie das erzeugte `State`-Objekt. Jeder relevante Wert muss als eigener Schlüssel erscheinen, und `{OriginalFormat}` muss Platzhalter statt Daten enthalten.
- Durchsuchen Sie die Build-Ausgabe nach `SYSLIB1015` (Parameter ohne passenden Platzhalter) und `SYSLIB0025` (Exception im Template). Beides sind Warnungen, die man beheben und nicht unterdrücken sollte.
- Prüfen Sie, dass der generierte Quellcode existiert: `obj/Debug/net11.0/generated/Microsoft.Extensions.Logging.Generators/`. Ist der Ordner leer, sitzt das Attribut auf einem nicht-`partial` Member und der Generator hat still nichts Nützliches getan.
- Auf Staging bereitstellen und das Log-Volumen vergleichen. Es sollte unverändert sein. Ein Rückgang bedeutet, dass versehentlich eine Level-Absicherung enger gezogen wurde.

## Rollback-Plan

Jeder Schritt lässt sich einzeln mit `git revert` zurücknehmen, und kein Schritt ändert eine öffentliche API oder ein Wire-Format. Ein Vorbehalt gehört laut gesagt: Sobald Ihr Log-Backend die neuen Eigenschaftsnamen indiziert, brechen darauf gebaute Dashboards und Alarme, wenn Sie den Code zurücknehmen. Erst den Code zurückrollen, dann die Dashboards, und beide Änderungen in getrennten Commits halten, damit die Reihenfolge verfügbar bleibt.

Die höhere Severity in `.editorconfig` lohnt sich auch dann, wenn Sie die Codeänderungen zurücknehmen. CA2254 auf `warning` zu belassen verhindert, dass während Ihrer Entscheidung neue interpolierte Aufrufe hinzukommen.

## Stolpersteine aus der Praxis

**Geschweifte Klammern in Daten werfen eine FormatException.** Die interpolierte Form hat einen Fehlerfall, den die meisten Teams zuerst in Produktion kennenlernen. `Microsoft.Extensions.Logging` behandelt das `message`-Argument als Formatstring und schickt es durch `LogValuesFormatter`, der `{Name}` zu `{0}` umschreibt und `string.Format` aufruft. Enthält Ihr interpoliertes Ergebnis Klammern, etwa weil Sie ein JSON-Payload protokolliert haben, sieht der Formatter Platzhalter ohne passende Argumente und wirft (`aspnet/Logging#351` ist der kanonische Report). Message-Templates sind immun: Das JSON ist ein Argument und nie Teil des Formatstrings.

```csharp
// .NET 11 -- throws FormatException at runtime when json contains { }
_logger.LogInformation($"Response: {json}");

// safe
_logger.LogInformation("Response: {Json}", json);
```

**Serilogs `{@Property}` ist kein Feature von Microsoft.Extensions.Logging.** Unter Serilog zerlegt `{@Order}` das Objekt in einen strukturierten Wert. Der `[LoggerMessage]`-Generator akzeptiert das Template, aber das `@` ist eine Serilog-Konvention, umgesetzt von `Serilog.Extensions.Logging`. Nehmen Sie nicht an, dass es bei einem einfachen OTLP- oder Console-Provider irgendetwas bewirkt. Nutzen Sie `[LogProperties]`, wenn Sie providerunabhängiges Aufklappen wollen.

**Tests, die auf Log-Text prüfen.** `Assert.Contains("Order 4711 failed", sink.Messages)` besteht die Migration unverändert, weil sich die gerenderte Nachricht nicht ändert. Das ist eine Falle: Sie können die Codebasis umstellen, ohne dass Ihre Tests je belegen, dass die Eigenschaften existieren. Ergänzen Sie pro Subsystem mindestens einen Test, der auf den State-Schlüssel prüft.

**Die Logs von EF Core selbst sind bereits als Template formuliert.** Bitte nicht "reparieren". Wenn Sie lesbares SQL vom Provider wollen, ist [das von EF Core 11 erzeugte SQL zu protokollieren](/de/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) ein Konfigurationsproblem, kein Problem der Aufrufstelle.

**Eine Backend-Migration ist eine andere Aufgabe.** Aufrufstellen umzustellen verschiebt keine Logs. Wenn OTLP das Ziel ist, machen Sie zuerst diese Migration, damit die Templates stimmen, und folgen Sie danach [dem Wechsel von Serilog zu OpenTelemetry-Logging](/de/2026/06/migrate-from-serilog-to-opentelemetry-logging-in-dotnet-11/). Beides gleichzeitig zu tun heißt, dass Sie nicht sagen können, welche Änderung ein Dashboard zerstört hat.

## Quellen

- [Logging-Source-Generierung zur Kompilierzeit](https://learn.microsoft.com/en-us/dotnet/core/extensions/logger-message-generator), Microsoft Learn
- [Hochperformantes Logging in .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/logging/high-performance-logging), Microsoft Learn
- [Logging-Anleitung für .NET-Bibliotheksautoren](https://learn.microsoft.com/en-us/dotnet/core/extensions/logging/library-guidance), Microsoft Learn
- [CA2254: Template sollte ein statischer Ausdruck sein](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2254), Microsoft Learn
- [CA1848: Verwenden Sie die LoggerMessage-Delegates](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1848), Microsoft Learn
- [API-Vorschlag: Interpolated-String-Überladungen für die ILogger-Erweiterungen](https://github.com/dotnet/runtime/issues/111283), dotnet/runtime, als nicht geplant geschlossen
- [LogInformation(string) wirft FormatException](https://github.com/aspnet/Logging/issues/351), aspnet/Logging
- [.NET 11 Preview 6 ist verfügbar](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-6/), .NET Blog
