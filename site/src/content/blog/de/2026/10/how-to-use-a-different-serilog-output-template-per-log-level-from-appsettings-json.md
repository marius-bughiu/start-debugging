---
title: "So verwenden Sie in Serilog pro Log-Level ein anderes Output-Template aus appsettings.json"
description: "outputTemplate gilt pro Sink, daher braucht eine Formatierung pro Level entweder ein ExpressionTemplate mit {#if @l ...}-Blöcken oder zwei Logger-Sub-Loggern mit den Filtern ByIncludingOnly / ByExcluding. Beides rein über appsettings.json konfiguriert, getestet mit Serilog 4.4, Serilog.Settings.Configuration 10.0.1 und Serilog.Expressions 5.0."
pubDate: 2026-10-26
template: how-to
tags:
  - "dotnet"
  - "csharp"
  - "logging"
  - "serilog"
  - "aspnet-core"
lang: "de"
translationOf: "2026/10/how-to-use-a-different-serilog-output-template-per-log-level-from-appsettings-json"
translatedBy: "claude"
translationDate: 2026-10-26
---

Ein Serilog-`outputTemplate` gehört zu einem Sink, nicht zu einem Level, daher gibt es keine Einstellung `"outputTemplate": { "Error": "..." }`. Allein über `appsettings.json` gibt es zwei saubere Wege zu einer Formatierung pro Level. Der erste ersetzt `outputTemplate` durch einen `formatter` vom Typ `Serilog.Templates.ExpressionTemplate` (aus dem Paket `Serilog.Expressions`) und verzweigt innerhalb des Templates mit `{#if @l in ['Error', 'Fatal']} ... {#else} ... {#end}`. Der zweite schreibt in zwei `"Name": "Logger"`-Sub-Logger, jeweils mit einem `Filter` (`ByIncludingOnly` / `ByExcluding` auf `@l`) und einem eigenen einfachen `outputTemplate`. Fügen Sie nicht einfach einen zweiten Sink mit `restrictedToMinimumLevel` hinzu: Das ist eine Untergrenze, daher wird jeder Fehler doppelt geschrieben. Alles Folgende wurde mit dem .NET 10.0.302 SDK, Serilog 4.4.0, Serilog.Settings.Configuration 10.0.1, Serilog.Expressions 5.0.0, Serilog.Sinks.Console 6.1.1 und Serilog.Sinks.File 7.0.0 ausgeführt. Dasselbe JSON funktioniert unverändert unter .NET 11.

## Warum sich outputTemplate nicht nach Level unterscheiden kann

`outputTemplate` ist ein Konstruktorargument der Console- und File-Sinks. Intern baut der Sink aus diesem String einen einzigen `MessageTemplateTextFormatter` und verwendet ihn für jedes Ereignis, das er erhält. Serilog.Settings.Configuration ruft lediglich `WriteTo.Console(outputTemplate: "...")` für Sie auf, sodass alles, was Sie ins JSON schreiben, eins zu eins diesem einen Formatter entspricht. Das Level steht *innerhalb* des Templates als `{Level}` zur Verfügung, aber ein klassisches Message Template kennt keine Bedingungen: Es kann das Level ausgeben, sich seinetwegen aber nicht in der Form ändern.

Eine Ausgabe pro Level braucht also eines von zwei Dingen:

1. einen Formatter, der selbst Entscheidungen treffen kann, und genau das ist `ExpressionTemplate`, oder
2. getrennte Pipelines, jede mit eigenem Formatter und einem vorgeschalteten Filter, sodass ein Ereignis in genau eine davon gelangt.

Typische Gründe dafür: kurze einzeilige Ausgabe für `Debug` und `Information` in der Konsole, aber vollständige Zeitstempel, zusätzliche Kontexteigenschaften und der Stack Trace für `Error` und `Fatal`; oder eine eigene `errors.log` mit reichhaltigerem Layout als das Hauptlog.

## Die naive Konfiguration, die Fehler dupliziert

Dies ist die Konfiguration, die die meisten zuerst ausprobieren, und der Grund, warum die Frage gestellt wird:

```json
// appsettings.json, Serilog 4.4.0, Serilog.Settings.Configuration 10.0.1
{
  "Serilog": {
    "Using": [ "Serilog.Sinks.Console" ],
    "MinimumLevel": "Debug",
    "WriteTo": [
      { "Name": "Console", "Args": { "outputTemplate": "[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj}{NewLine}" } },
      { "Name": "Console", "Args": { "restrictedToMinimumLevel": "Error", "outputTemplate": "[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj} ({SourceContext}){NewLine}{Exception}" } }
    ]
  }
}
```

Das Testprogramm protokolliert ein Ereignis pro Level, beim `Error` mit einer Exception:

```csharp
// Program.cs, .NET 10, Serilog 4.4.0
using Microsoft.Extensions.Configuration;
using Serilog;

var config = new ConfigurationBuilder().AddJsonFile(args[0]).Build();
Log.Logger = new LoggerConfiguration().ReadFrom.Configuration(config).CreateLogger();

var orderId = 42;
Log.Debug("Cache warm for {Region}", "eu-west");
Log.Information("Order {OrderId} accepted", orderId);
Log.Warning("Order {OrderId} took {Elapsed} ms", orderId, 1830);
try { throw new InvalidOperationException("Payment gateway timed out"); }
catch (Exception ex) { Log.Error(ex, "Order {OrderId} failed", orderId); }
Log.Fatal("Shutting down: {Reason}", "unrecoverable");
Log.CloseAndFlush();
```

Die Ausgabe:

```text
[09:04:23 DBG] Cache warm for eu-west
[09:04:23 INF] Order 42 accepted
[09:04:23 WRN] Order 42 took 1830 ms
[09:04:23 ERR] Order 42 failed
[09:04:23 ERR] Order 42 failed ()
System.InvalidOperationException: Payment gateway timed out
   at Program.<Main>$(String[] args) in .../Program.cs:line 11
[09:04:23 FTL] Shutting down: unrecoverable
[09:04:23 FTL] Shutting down: unrecoverable ()
```

`restrictedToMinimumLevel` bedeutet nur "dieses Level und darüber". Der erste Sink hat keine Obergrenze, daher landen `Error` und `Fatal` in beiden. Ein Argument `restrictedToMaximumLevel` gibt es nicht. Sie brauchen einen echten Filter oder eine echte Bedingung.

## Option 1: ein Sink, ein ExpressionTemplate mit #if-Blöcken

`Serilog.Expressions` liefert `ExpressionTemplate`, einen `ITextFormatter`, dessen Template-Sprache `{#if <expr>}`, `{#else if <expr>}`, `{#else}` und `{#end}` unterstützt. Das aktuelle Level ist `@l`. Serilog.Settings.Configuration kann es direkt aus JSON erzeugen, weil die Console- und File-Sinks eine Überladung mit einem `ITextFormatter formatter` haben und der Settings-Reader ein Objekt mit einem `type`-Schlüssel an den Konstruktor dieses Typs bindet.

1. Fügen Sie die Pakete hinzu:

```bash
# .NET 10 SDK; package versions as of October 2026
dotnet add package Serilog.AspNetCore --version 10.0.0
dotnet add package Serilog.Expressions --version 5.0.0
```

`Serilog.AspNetCore` 10.0.0 bringt Serilog 4.x, Serilog.Settings.Configuration sowie die Console- und File-Sinks mit. In einer einfachen Konsolen- oder Worker-App verwenden Sie stattdessen `Serilog.Extensions.Hosting` (oder die einzelnen Pakete, wie im Testprojekt).

2. Ersetzen Sie `outputTemplate` durch ein `formatter`-Objekt:

```json
// appsettings.json, Serilog.Expressions 5.0.0
{
  "Serilog": {
    "Using": [ "Serilog.Sinks.Console", "Serilog.Expressions" ],
    "MinimumLevel": "Debug",
    "WriteTo": [
      {
        "Name": "Console",
        "Args": {
          "formatter": {
            "type": "Serilog.Templates.ExpressionTemplate, Serilog.Expressions",
            "template": "{#if @l = 'Debug'}  dbg {@m}\n{#else if @l in ['Information', 'Warning']}[{@t:HH:mm:ss} {@l:u3}] {@m}\n{#else}[{@t:yyyy-MM-dd HH:mm:ss.fff} {@l:u3}] {@m} {Rest()}\n{#if @x is not null}{@x}{#end}{#end}"
          }
        }
      }
    ]
  }
}
```

3. Führen Sie es aus. Aus einem einzigen Sink kommen drei verschiedene Layouts:

```text
  dbg Cache warm for eu-west
[09:04:47 INF] Order 42 accepted
[09:04:47 WRN] Order 42 took 1830 ms
[2026-10-26 09:04:47.048 ERR] Order 42 failed {"OrderId":42}
System.InvalidOperationException: Payment gateway timed out
   at Program.<Main>$(String[] args) in .../Program.cs:line 11
[2026-10-26 09:04:47.051 FTL] Shutting down: unrecoverable {"Reason":"unrecoverable"}
```

Die Template-Syntax ist nicht die klassische, übersetzen Sie also mit:

| Klassisches `outputTemplate` | `ExpressionTemplate` |
| --- | --- |
| `{Timestamp:HH:mm:ss}` | `{@t:HH:mm:ss}` |
| `{Level:u3}` | `{@l:u3}` |
| `{Message:lj}` | `{@m}` (gibt Strings bereits ohne Anführungszeichen aus) |
| `{Exception}` | `{@x}` |
| `{NewLine}` | ein wörtliches `\n` im JSON-String |
| `{Properties:j}` | `{Rest()}` oder `{Rest(true)}` |
| `{SourceContext}` | `{SourceContext}` (unverändert) |

Zwei Details aus dieser Tabelle sind in der Praxis wichtig. `{NewLine}` gibt es in Expression Templates nicht; das `\n` im JSON-String ist nach dem Parsen des JSON ein echter Zeilenumbruch, genau wie gewünscht, maskieren Sie es also nicht doppelt. Und `{@x}` endet bereits mit einem Zeilenumbruch, sodass `{@x}\n` nach jedem Stack Trace eine leere Zeile ausgibt.

### Kontexteigenschaften nur anzeigen, wenn es welche gibt

`Rest()` liefert die Ereigniseigenschaften, auf die das *Expression Template* nicht verwiesen hat. Es enthält weiterhin diejenigen, die im Nachrichtentext vorkommen, weshalb oben `{"OrderId":42}` erscheint, obwohl die Nachricht bereits "Order 42" sagt. `Rest(true)` schließt zusätzlich Eigenschaften aus, auf die im Message Template verwiesen wird, und Sie können es absichern, sodass nie ein leeres `{}` ausgegeben wird:

```json
"template": "{#if @l in ['Error', 'Fatal']}[{@t:HH:mm:ss.fff} {@l:u3}] {@m}{#if Rest(true) <> {}} {Rest(true)}{#end}\n{@x}{#else}[{@t:HH:mm:ss} {@l:u3}] {@m}\n{#end}"
```

Mit einer über `LogContext` um den Aufruf von `Log.Error` herum hinzugefügten `TenantId` ergibt das:

```text
[09:05:30 DBG] Cache warm for eu-west
[09:05:30 INF] Order 42 accepted
[09:05:30 WRN] Order 42 took 1830 ms
[09:05:30.374 ERR] Order 42 failed {"TenantId":"acme"}
System.InvalidOperationException: Payment gateway timed out
   at Program.<Main>$(String[] args) in .../Program.cs:line 13
[09:05:30.383 FTL] Shutting down: unrecoverable
```

Die `Fatal`-Zeile hat keine nachgestellten geschweiften Klammern, weil ihre einzige Eigenschaft, `Reason`, bereits in der Nachricht steht.

## Option 2: zwei Sub-Logger, jeder mit eigenem outputTemplate

Wenn Sie klassische `outputTemplate`-Strings behalten möchten oder die beiden Layouts in verschiedene Sinks gehen (Konsole und Datei, Seq und Datei), verwenden Sie den `Logger`-Sink. Er erzeugt einen Sub-Logger mit eigenen Abschnitten `Filter`, `WriteTo` und `Enrich`. Die Filterausdrücke stammen wieder aus `Serilog.Expressions`, das `ByIncludingOnly(string expression)` und `ByExcluding(string expression)` ergänzt.

1. Machen Sie die beiden Filter komplementär, damit jedes Ereignis in genau einen Sub-Logger geht:

```json
// appsettings.json, Serilog.Settings.Configuration 10.0.1, Serilog.Expressions 5.0.0
{
  "Serilog": {
    "Using": [ "Serilog.Sinks.Console", "Serilog.Expressions" ],
    "MinimumLevel": "Debug",
    "WriteTo": [
      {
        "Name": "Logger",
        "Args": {
          "configureLogger": {
            "Filter": [ { "Name": "ByExcluding", "Args": { "expression": "@l in ['Error', 'Fatal']" } } ],
            "WriteTo": [ { "Name": "Console", "Args": { "outputTemplate": "[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj}{NewLine}" } } ]
          }
        }
      },
      {
        "Name": "Logger",
        "Args": {
          "configureLogger": {
            "Filter": [ { "Name": "ByIncludingOnly", "Args": { "expression": "@l in ['Error', 'Fatal']" } } ],
            "WriteTo": [ { "Name": "Console", "Args": { "outputTemplate": "[{Timestamp:HH:mm:ss.fff} {Level:u3}] {Message:lj} {Properties:j}{NewLine}{Exception}" } } ]
          }
        }
      }
    ]
  }
}
```

2. Führen Sie es aus. Keine Duplikate, und der Fehlerzweig bekommt Millisekunden, Eigenschaften und die Exception:

```text
[09:04:23 DBG] Cache warm for eu-west
[09:04:23 INF] Order 42 accepted
[09:04:23 WRN] Order 42 took 1830 ms
[09:04:23.840 ERR] Order 42 failed {}
System.InvalidOperationException: Payment gateway timed out
   at Program.<Main>$(String[] args) in .../Program.cs:line 11
[09:04:23.842 FTL] Shutting down: unrecoverable {}
```

Das `{}` ist das klassische Verhalten von `{Properties:j}`: Es listet nur die Eigenschaften auf, die nicht bereits in der Nachricht stehen, und hier gibt es keine. Anders als `Rest(true)` lässt es sich nicht bedingt machen, was ein praktischer Grund ist, für die Konsolenausgabe Option 1 vorzuziehen.

### Wenn restrictedToMinimumLevel allein genügt

Wenn das zweite Layout nur "dieses Level und darüber" braucht *und* in ein anderes Ziel geht, ist kein Filter nötig. Eine eigene Fehlerdatei ist der häufigste Fall:

```json
// appsettings.json, Serilog.Sinks.File 7.0.0
{
  "Name": "File",
  "Args": {
    "path": "logs/errors-.log",
    "rollingInterval": "Day",
    "restrictedToMinimumLevel": "Error",
    "outputTemplate": "{Timestamp:o} [{Level:u3}] {Message:lj}{NewLine}{Properties:j}{NewLine}{Exception}"
  }
}
```

Das Duplikationsproblem der naiven Konfiguration besteht nur, wenn beide Ausgaben am selben Ort landen.

## Einbindung in ASP.NET Core oder einen Worker

Am Hosting-Code ändert die Wahl des Templates nichts. Mit Serilog.AspNetCore 10.0.0:

```csharp
// Program.cs, ASP.NET Core on .NET 10 / .NET 11, Serilog.AspNetCore 10.0.0
using Serilog;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSerilog((services, lc) => lc
    .ReadFrom.Configuration(builder.Configuration)
    .ReadFrom.Services(services));

var app = builder.Build();
app.MapGet("/", (ILogger<Program> log) =>
{
    log.LogError("Something failed for {OrderId}", 42);
    return "ok";
});
app.Run();
```

Da der Formatter in der Konfiguration liegt, können Sie `appsettings.Development.json` ein kompaktes einzeiliges Template geben und `appsettings.Production.json` einen JSON-Formatter, ohne den Code anzufassen. Der [Beitrag zum Serilog-plus-Seq-Setup](/de/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) behandelt den Bootstrap-Logger und `Log.CloseAndFlush()` rund um diesen Teil.

## Stolpersteine beim Testen

**Level-Vergleiche unterscheiden Groß- und Kleinschreibung.** `@l = 'error'` ist für ein `Error`-Ereignis `false`. Verwenden Sie die exakten Namen `Verbose`, `Debug`, `Information`, `Warning`, `Error`, `Fatal` oder fügen Sie den Modifikator `ci` hinzu: `@l = 'error' ci` wurde im Test zu `true` ausgewertet. `{#if}` braucht außerdem ein echtes boolesches `true`; ein nicht boolescher Wert ist nicht "truthy".

**Ein Sub-Logger kann nicht ausführlicher sein als sein Eltern-Logger.** Mit dem Root-Wert `"MinimumLevel": "Information"` und `"MinimumLevel": "Debug"` innerhalb von `configureLogger` gab der Sub-Logger weiterhin nichts unterhalb von `INF` aus. Ereignisse werden vom Root-Logger verworfen, bevor der `Logger`-Sink sie überhaupt sieht. Setzen Sie das Root-Minimum auf das niedrigste Level, das ein Zweig braucht, und erhöhen Sie es pro Zweig.

**Fehlende Eigenschaften lassen den umgebenden Text stehen.** Beide Template-Stile rendern eine Eigenschaft, die das Ereignis nicht hat, als nichts: Das `({SourceContext})` der naiven Konfiguration gab `()` aus, und in einem `ExpressionTemplate` gab `(OrderId={OrderId})` beim `Fatal`-Ereignis `(OrderId=)` aus. Nur das Expression Template kann das beheben: Umschließen Sie optionale Eigenschaften mit `{#if OrderId is not null} ... {#end}`.

**Unbekannte Namen schlagen still fehl.** `"Enrich": [ "WithMachineName" ]` ohne installiertes Paket `Serilog.Enrichers.Environment` löste keine Ausnahme aus. Die einzige Spur war diese Meldung, nachdem `Serilog.Debugging.SelfLog.Enable(Console.Error)` aktiviert wurde:

```text
Unable to find a method called WithMachineName. Candidate methods are:
...
```

Dasselbe gilt für einen falsch geschriebenen Sink-Namen oder Filternamen, wenn `Serilog.Expressions` nicht referenziert ist. Aktivieren Sie `SelfLog`, sobald eine Template-Änderung scheinbar nichts bewirkt.

**Behalten Sie den Abschnitt `Using`, wenn Sie als Single-File veröffentlichen.** Serilog.Settings.Configuration findet jede Abhängigkeit mit "Serilog" im Namen automatisch über die `.deps.json`, daher funktionierte das Testprojekt ganz ohne `Using`. Die README des Projekts weist darauf hin, dass die automatische Erkennung im gebündelten Modus (Single-File) nicht funktioniert, listen Sie also `"Serilog.Expressions"` und jede Sink-Assembly explizit auf.

**Umgebungsvariablen überschreiben Array-Einträge per Index.** Ein Template pro Level ist ein langer String in `WriteTo:0:Args:formatter:template`. Das Überschreiben aus einem Container heraus nutzt `Serilog__WriteTo__0__Args__formatter__template`, und der Index verschiebt sich, wenn jemand `WriteTo` umsortiert. Wenn sich Templates je Umgebung unterscheiden, bevorzugen Sie eine Datei `appsettings.{Environment}.json`.

## Welche Option die richtige ist

Verwenden Sie das `ExpressionTemplate`, wenn die Layouts ein gemeinsames Ziel haben, typischerweise die Konsole. Es ist ein Sink, ein Durchlauf über das Ereignis, und es kann Dinge, die Sub-Logger nicht können, etwa leere Eigenschaftsbehälter ausblenden. Verwenden Sie Sub-Logger, wenn die Layouts in verschiedene Sinks gehen oder unterschiedliche Enricher brauchen oder wenn ein Team klassische Templates bevorzugt, die jeder lesen kann. In beiden Fällen muss der Filter oder die Bedingung auf `@l` geschrieben werden; eine nach Level geschlüsselte Template-Einstellung gibt es nicht.

## Weiterführende Beiträge

- Beginnen Sie mit [strukturiertem Logging mit Serilog und Seq in .NET 11](/de/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/), falls Serilog noch nicht eingebunden ist.
- Damit das Layout pro Level zeigt, wer einen Fehler ausgelöst hat, [fügen Sie die aktuelle Benutzer-ID jedem Logeintrag in ASP.NET Core hinzu](/de/2026/09/how-to-add-the-current-user-id-to-every-log-entry-in-aspnet-core/), mit `LogContext`.
- Eigenschaften, die in `Rest()` oder `{Properties:j}` erscheinen, können Geheimnisse preisgeben; [schwärzen Sie sensible Werte mit `[LogProperties]`](/de/2026/08/how-to-redact-sensitive-values-from-logs-with-logproperties-in-dotnet/), bevor sie ein Template erreichen.
- `{@m}` und `{Message:lj}` bleiben nur strukturiert, wenn die Aufrufstellen Message Templates verwenden, was die [Migration von `ILogger`-String-Interpolation zu Message Templates](/de/2026/07/migrate-from-ilogger-string-interpolation-to-message-templates-in-dotnet-11/) behebt.
- Wenn Sie Serilog zugunsten von OpenTelemetry verlassen, siehe [Migration von Serilog zu OpenTelemetry-Logging](/de/2026/06/migrate-from-serilog-to-opentelemetry-logging-in-dotnet-11/).

## Quellen

- [Serilog.Expressions README](https://github.com/serilog/serilog-expressions): `ExpressionTemplate`, die Built-ins `@l`/`@x`, `#if`/`#else if`, `Rest([deep])` und der Modifikator `ci`.
- [Serilog.Settings.Configuration README](https://github.com/serilog/serilog-settings-configuration): `Using` und automatische Erkennung (einschließlich der Einschränkung im gebündelten Modus), komplexe `formatter`-Bindung mit `type` und Sub-Logger-Konfiguration.
- [Serilog wiki: Configuration Basics](https://github.com/serilog/serilog/wiki/Configuration-Basics): Sub-Logger und warum sie das Minimum-Level des Eltern-Loggers nicht senken können.
- [Serilog.Sinks.Console](https://github.com/serilog/serilog-sinks-console) und [Serilog.Sinks.File](https://github.com/serilog/serilog-sinks-file): die Parameter `outputTemplate`, `formatter` und `restrictedToMinimumLevel`.
- [Serilog.AspNetCore](https://github.com/serilog/serilog-aspnetcore): `AddSerilog` mit `ReadFrom.Configuration` und `ReadFrom.Services`.
