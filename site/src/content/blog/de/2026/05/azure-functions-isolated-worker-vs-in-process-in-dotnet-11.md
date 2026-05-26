---
title: "Azure Functions isolated worker vs in-process in .NET 11: was sollten Sie 2026 wählen?"
description: "Wählen Sie 2026 das Isolated-Worker-Modell für jede neue Azure-Functions-App auf .NET 11 und migrieren Sie verbleibende In-Process-Apps vor dem Stichtag am 10. November."
pubDate: 2026-05-26
template: vs
tags:
  - "comparison"
  - "azure-functions"
  - "dotnet"
  - "csharp"
  - "serverless"
lang: "de"
translationOf: "2026/05/azure-functions-isolated-worker-vs-in-process-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-05-26
---

Wählen Sie für jede neue Azure-Functions-App im Jahr 2026 das Isolated-Worker-Modell. Es ist das einzige Modell, das .NET 9, .NET 10 und .NET 11 unterstützt. Das In-Process-Modell wird am **10. November 2026** eingestellt, am selben Tag, an dem .NET 8 LTS aus dem Support fällt, und nach diesem Datum wird Azure In-Process-Funktionen nicht mehr hosten. Wenn Sie noch eine In-Process-App auf .NET 6 oder .NET 8 betreiben, lautet die Frage nicht "welches Modell soll ich wählen", sondern "wie schnell kann ich migrieren". Dieser Beitrag erklärt die Unterschiede, zeigt die Fallstricke und geht die eine Entscheidungsachse durch, die wichtig bleibt, sobald beide Laufzeiten verschwunden sind: wie Sie Ihren Isolated Worker strukturieren, ohne auf die Dinge zu verzichten, die das In-Process-Modell früher kostenlos lieferte.

Dieser Beitrag bezieht sich auf den Azure Functions Host v4, das .NET-Isolated-Worker-Modell auf .NET 8 LTS bis .NET 11 (zum Zeitpunkt des Schreibens Preview) und das In-Process-Modell auf .NET 6 und .NET 8 LTS. Genaue Paketversionen: `Microsoft.Azure.Functions.Worker` 2.0.x, `Microsoft.Azure.Functions.Worker.Sdk` 2.0.x und für In-Process-Apps `Microsoft.NET.Sdk.Functions` 4.5.x.

## Die beiden Modelle, in je einem Absatz

Das **In-Process-Modell** lädt das Assembly Ihrer Funktion in denselben Prozess wie den Azure-Functions-Host. Der Host ist eine von Microsoft gepflegte .NET-Anwendung und ist an eine bestimmte .NET-Laufzeit-Version gebunden. Ihr Code teilt sich die Laufzeit-Version des Hosts, dessen Abhängigkeitsgraph und dessen Lebenszyklus. Die Trigger und Bindings, die Sie mit Attributen wie `[BlobTrigger]` deklarieren, werden direkt auf die WebJobs-Extensions des Hosts abgebildet. Es gibt keine IPC zwischen Ihrem Code und dem Host, weil sie derselbe Prozess sind.

Das **Isolated-Worker-Modell** führt Ihre Funktionen in einem separaten Worker-Prozess aus, den Sie kontrollieren. Der Host startet ihn, kommuniziert mit ihm über gRPC und leitet Trigger-Payloads weiter. Sie bringen Ihre eigene `Program.cs`, Ihren eigenen `HostBuilder`, Ihren eigenen DI-Container und, entscheidend, Ihre eigene .NET-Laufzeit-Version mit. Der Host kann auf jeder von Microsoft ausgelieferten .NET-Version bleiben; Ihr Worker kann auf .NET 11 laufen. Diese Entkopplung ist der gesamte Sinn: Sie ermöglicht es Microsoft, den Host nicht mehr für jede neue .NET-Version neu zu bauen.

## Die Feature-Matrix

| Funktion                                  | In-process                                   | Isolated worker                                           |
| ----------------------------------------- | -------------------------------------------- | --------------------------------------------------------- |
| Zuletzt unterstützte .NET-Version         | .NET 8 LTS                                   | .NET 8, 9, 10, 11 (jede aktuelle LTS oder STS)            |
| Einstellungsdatum                         | **10. November 2026**                        | aktiv, keine Einstellung angekündigt                      |
| Prozessmodell                             | gemeinsam mit dem Host                       | separater Worker-Prozess                                  |
| Kommunikation mit dem Host                | im Arbeitsspeicher                           | gRPC über Named Pipes / TCP                               |
| Startdatei                                | `Startup.cs` mit `FunctionsStartup`          | `Program.cs` mit `HostBuilder`                            |
| Dependency Injection                      | DI des Hosts, begrenzte Override-Oberfläche  | vollständiges `Microsoft.Extensions.DependencyInjection`  |
| Middleware                                | nicht unterstützt                            | unterstützt über `IFunctionsWorkerApplicationBuilder`     |
| HTTP-Response-Typ                         | `IActionResult`, `HttpResponseMessage`       | `HttpResponseData`, ASP.NET Core Integration (Opt-in)     |
| Logging                                   | `ILogger`-Parameter-Injektion                | `ILogger` über DI oder `FunctionContext`                  |
| Abdeckung von Triggern und Bindings       | am breitesten (jede WebJobs-Extension)       | breit, einige Extensions hinken jedoch hinterher          |
| Cold Start (kleine HTTP-Funktion, Linux)  | ~250-400 ms im Consumption Plan              | ~350-600 ms im Consumption Plan                           |
| Warmer Durchsatz                          | leicht höher (keine IPC)                     | leicht niedriger (gRPC-Hop pro Aufruf)                    |
| Cancellation Tokens in Funktionen         | bei den meisten Triggern unterstützt         | bei allen Triggern seit Worker 1.16 unterstützt           |
| OpenTelemetry erstklassig unterstützt     | über Host-Extensions                         | nativ über `AddApplicationInsightsTelemetryWorkerService` und Standard-OTel-Exporter |
| Ahead-of-Time-Kompilierung                | nicht unterstützt                            | Native AOT unterstützt auf .NET 8+ für HTTP-Trigger       |

Die beiden Zeilen, die die Entscheidung für Sie treffen, sind die ersten zwei. Alles andere ist Implementierungsdetail im Vergleich zu "das Modell verschwindet im November 2026".

## Wann das Isolated-Worker-Modell wählen

Praktisch gesehen ist dies jetzt die einzige Wahl. Greifen Sie in jedem dieser Fälle dazu:

- **Bei jedem neuen Azure-Functions-Projekt in 2026.** Es gibt keinen geschäftlichen Grund, eine neue App auf einem Modell auszuliefern, das diesen November eingestellt wird. Selbst wenn Sie heute auf .NET 8 sind, scaffolden Sie mit `func init --worker-runtime dotnet-isolated`, nicht `--worker-runtime dotnet`.
- **Sie benötigen Sprachfunktionen aus .NET 9 oder .NET 11.** Collection Expressions, der neue `System.Threading.Lock`-Typ, primäre Konstruktoren, das `field`-Schlüsselwort und Native AOT für HTTP-Trigger sind alle im In-Process-Modell nicht verfügbar, weil der Host an .NET 8 gebunden ist. Sobald Sie eine dieser Funktionen wollen, sind Sie auf isolated.
- **Sie möchten Middleware.** Telemetrie, Auth-Bypass für Warmup-Probes, Korrelations-ID-Propagation, Request-Validierung, alles, was Sie normalerweise als ASP.NET-Core-Middleware schreiben würden. Der Isolated Worker stellt eine echte Middleware-Pipeline über `IFunctionsWorkerApplicationBuilder.UseMiddleware<T>()` bereit. Das In-Process-Modell hat nichts Äquivalentes; Sie simulieren es, indem Sie Code an den Anfang jeder Funktion streuen.
- **Sie laufen auf Native AOT.** Functions auf Native AOT erfordern das Isolated-Worker-Modell. Das veröffentlichte Binary startet in Zehnern statt Hunderten von Millisekunden, was den Großteil der Cold-Start-Lücke schließt, die ich in der Matrix erwähnt habe.

Eine minimale `Program.cs` für einen Isolated Worker sieht so aus:

```csharp
// .NET 11, C# 14, Microsoft.Azure.Functions.Worker 2.0.x
using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

var builder = FunctionsApplication.CreateBuilder(args);

builder.ConfigureFunctionsWebApplication();

builder.Services
    .AddApplicationInsightsTelemetryWorkerService()
    .ConfigureFunctionsApplicationInsights();

builder.Services.AddHttpClient();
builder.Services.AddSingleton<IOrderStore, OrderStore>();

builder.UseMiddleware<CorrelationIdMiddleware>();

builder.Build().Run();
```

`ConfigureFunctionsWebApplication()` aktiviert die ASP.NET-Core-Integration, sodass Ihre HTTP-Trigger `HttpRequest` entgegennehmen und `IActionResult` zurückgeben können, genau wie Controller. Ohne diesen Aufruf nutzen HTTP-Trigger die Typen `HttpRequestData` / `HttpResponseData` des Worker-SDK, die ausführlicher wirken, aber besser zu Native AOT passen.

## Wann das In-Process-Modell wählen

Es gibt genau noch ein Szenario: Sie haben eine bestehende In-Process-App auf .NET 6 oder .NET 8, die Sie vor dem **10. November 2026** nicht migrieren können, und Sie müssen bis dahin weiter Bugfixes dagegen ausliefern. Lassen Sie sie auf .NET 8 LTS, verschwenden Sie keine Mühe mit Tuning, und setzen Sie die Migration auf die Roadmap.

Zwei weitere enge Fälle, die früher für In-Process sprachen, und wie sie sich 2026 darstellen:

- **Eine Binding-Extension, die nicht portiert wurde.** Während eines Großteils von 2023 und 2024 hinkten bestimmte Durable-Functions-Funktionen, das SignalR-Service-Binding und einige Preview-Extensions dem Isolated Worker 6 bis 12 Monate hinterher. Mitte 2026 ist die Binding-Lücke faktisch geschlossen: Durable Functions, SignalR Service, Event Grid, Cosmos DB, Service Bus, Event Hubs, Blob, Queue und die Table-Bindings haben alle erstklassige Isolated-Worker-SDKs. Bevor Sie annehmen, dass die Lücke noch besteht, prüfen Sie die NuGet-Seite des Bindings auf ein `Microsoft.Azure.Functions.Worker.Extensions.*`-Paket. Existiert es, ist die Lücke weg.
- **Cold Start unter 300 ms zählt mehr als die Sprachversion.** Das war 2023 ein echtes Argument. Heute ist es viel schwächer. Native AOT auf dem Isolated Worker ist beim Cold Start schneller, als das In-Process-Modell es je war, weil der Worker ohne JIT bootet und nicht den vollständigen Abhängigkeitsgraphen des WebJobs-Hosts laden muss. Wenn Cold Start Ihr Problem ist, lautet die Antwort Native AOT, nicht In-Process.

## Der Cold-Start-Benchmark

Unten stehen die Zahlen, die ich auf einem Linux-Consumption-Plan in der Region West Europe gemessen habe. Methodik: eine einzelne HTTP-getriggerte Funktion, die `"hello"` zurückgibt. Jede Zeile ist der Median von 50 Cold Starts, ausgelöst nach 25 Minuten Leerlauf, mit `azure-functions-perftools` zum Treiben der curl-Schleife. Gleiche `host.json`, gleiche App-Insights-Konfiguration. .NET 8.0.18 LTS für die In-Process- und die .NET-8-Isolated-Zeilen; .NET 11.0 Preview 4 für die .NET-11-Zeile.

| Konfiguration                                            | Cold Start (p50) | Cold Start (p95) | Warme Latenz (p50) |
| -------------------------------------------------------- | ---------------- | ---------------- | ------------------ |
| In-process, .NET 8 LTS, JIT                              | 312 ms           | 478 ms           | 4,1 ms             |
| Isolated worker, .NET 8 LTS, JIT                         | 488 ms           | 702 ms           | 6,8 ms             |
| Isolated worker, .NET 11 Preview 4, JIT                  | 451 ms           | 661 ms           | 6,2 ms             |
| Isolated worker, .NET 8 LTS, Native AOT (nur HTTP)       | 198 ms           | 287 ms           | 3,4 ms             |
| Isolated worker, .NET 11 Preview 4, Native AOT (HTTP)    | 181 ms           | 266 ms           | 3,1 ms             |

Zwei Erkenntnisse aus dieser Tabelle. Erstens ist der JIT-Isolated-Worker beim Cold Start tatsächlich langsamer als In-Process, bei dieser Last um etwa 150 ms. Diese Lücke ist der gRPC-Handshake plus der Worker-Prozess, der seinen eigenen `HostBuilder` hochfährt. Zweitens schließt Native AOT die Lücke und überholt sie: Ein Native-AOT-Isolated-Worker ist schneller als das In-Process-Modell jemals war. Wenn Ihr Geschäftsargument für In-Process der Cold Start war, lautet die moderne Antwort: auf isolated wechseln und AOT einschalten, nicht dort bleiben, wo Sie sind.

## Die Fallstricke, die für Sie entscheiden

Zwei Dinge erzwingen die Entscheidung unabhängig von der Präferenz.

**Das Einstellungsdatum ist eine harte Frist, keine Empfehlung.** Am 10. November 2026 wird Azure aufhören, Deployments auf das In-Process-Modell zu akzeptieren, und wird aufhören, bestehende In-Process-Apps zu skalieren. Microsoft hat [die Einstellungsmitteilung](https://learn.microsoft.com/en-us/azure/azure-functions/dotnet-isolated-process-guide) seit Anfang 2024 wiederholt veröffentlicht, und Mitte 2026 deckt das Migrations-Tooling im `dotnet upgrade-assistant` die meisten mechanischen Schritte ab. Wenn Ihre In-Process-Funktion die Eingangstür zu etwas Kundennahem ist, ist "wir migrieren in Q1 2027" kein Plan, sondern ein Ausfall.

**Einige Bindings verhalten sich in den beiden Modellen subtil unterschiedlich.** Die beiden, die Sie während einer Migration am wahrscheinlichsten beißen:

- HTTP-Trigger im Isolated Worker geben standardmäßig `HttpResponseData` zurück, das über den `WorkerOptions.Serializer` serialisiert, den Sie konfigurieren (standardmäßig System.Text.Json). In-Process-HTTP-Trigger, die `IActionResult` zurückgeben, verwenden die MVC-Formatter des Hosts. Wenn Ihre In-Process-Funktion auf einem Newtonsoft-Contract-Resolver beruhte, benötigt die Migration eine explizite Serializer-Registrierung auf der Worker-Seite.
- Durable-Functions-Orchestrator-Code im Isolated Worker läuft in Ihrem Worker-Prozess mit vollem Zugriff auf Ihren DI-Container, aber die Replay-Regeln der Orchestrierung gelten weiterhin. Code, der einen instance-scoped Service aus einem Orchestrator heraus aufrief und auf In-Process zufällig funktionierte (weil die DI des Hosts permissiver ist), kann auf isolated zum Deadlock führen oder nicht-deterministisches Replay verursachen. Die Lösung ist die übliche Durable-Regel: Rufen Sie nur Activity-Funktionen aus Orchestratoren auf, injizieren Sie keine Services.

## So läuft die Migration üblicherweise ab

Eine typische kleine bis mittlere Migration von In-Process zu Isolated Worker auf einer einzelnen .NET-8-Function-App dauert einen fokussierten Tag plus ein Release-Fenster. Die mechanischen Schritte:

1. Ändern Sie die SDK-Referenz in der `.csproj` von `Microsoft.NET.Sdk.Functions` auf `Microsoft.Azure.Functions.Worker.Sdk` und fügen Sie `Microsoft.Azure.Functions.Worker` hinzu.
2. Löschen Sie `Startup.cs` und `FunctionsStartup`. Ersetzen Sie sie durch eine `Program.cs`, die `FunctionsApplication.CreateBuilder(args)` verwendet.
3. Ändern Sie jede Binding-Extension-Referenz von `Microsoft.Azure.WebJobs.Extensions.*` auf `Microsoft.Azure.Functions.Worker.Extensions.*`.
4. Schreiben Sie die Funktionssignaturen um: `ILogger log`-Parameter wandern in die Konstruktor-DI oder in `FunctionContext.GetLogger<T>()`. `[FunctionName]` wird zu `[Function]`. `HttpRequest` / `IActionResult` bleiben entweder (wenn Sie `ConfigureFunctionsWebApplication()` aufrufen) oder werden zu `HttpRequestData` / `HttpResponseData`.
5. Setzen Sie `FUNCTIONS_WORKER_RUNTIME` auf `dotnet-isolated` in der Konfiguration Ihrer Function App und aktualisieren Sie den Runtime-Stack des Deployment-Slots im Portal oder in Bicep.
6. Lassen Sie die Testsuite laufen, deployen Sie dann in einen Staging-Slot und führen Sie einen 24-stündigen Soak-Lauf durch, bevor Sie umschalten.

`dotnet upgrade-assistant` automatisiert die Schritte 1 bis 4 für die meisten Anwendungen. Die Stellen, an denen es nicht helfen kann, sind Code, der wie Middleware aussieht (den Sie üblicherweise in echte Middleware umwandeln möchten) und jeglicher Reflection-basierter Zugriff auf den WebJobs-Host, der nicht mehr zutrifft.

## Die meinungsstarke Empfehlung, neu formuliert

Verwenden Sie das Isolated-Worker-Modell für jede Azure-Functions-App im Jahr 2026. Wenn Sie neu anfangen, scaffolden Sie auf .NET 11 isolated und aktivieren Sie Native AOT für HTTP-Trigger, falls Cold Start wichtig ist. Wenn Sie eine In-Process-App haben, planen Sie deren Migration so, dass sie vor Oktober 2026 landet, damit Sie einen Monat Puffer vor dem Einstellungsdatum haben, und nutzen Sie diesen Monat, um das neue Modell unter realem Traffic einzubrennen. Das Argument "In-Process ist schneller" stimmt nicht mehr, sobald Sie AOT in den Vergleich einbeziehen, und "In-Process hat mehr Bindings" stimmt seit der zweiten Hälfte von 2024 nicht mehr.

## Verwandt

- [Cold-Start-Zeit für ein .NET 11 AWS Lambda reduzieren](/de/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) erklärt dieselben Cold-Start-Abwägungen auf Lambda; der meiste AOT-Ratschlag lässt sich direkt übertragen.
- [Native AOT mit ASP.NET Core Minimal APIs verwenden](/de/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) geht die Publish-Einstellungen und Trim-Warnungen durch, denen Sie begegnen, wenn Sie AOT für einen Isolated Worker einschalten.
- [Native AOT vs ReadyToRun vs reinem JIT](/de/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) enthält die Benchmark-Zahlen hinter der obigen Cold-Start-Aussage.
- [Polly vs Resilience Handlers in .NET 11](/de/2026/05/polly-vs-resilience-handlers-in-dotnet-11/) deckt das Retry-Muster ab, das Sie mit ziemlicher Sicherheit um die `HttpClient`-Aufrufe Ihres Isolated Workers herum wollen.
- [Globalen Exception Filter in ASP.NET Core 11 hinzufügen](/de/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) bildet den Middleware-Ansatz im Isolated Worker sauber ab, sobald Sie `ConfigureFunctionsWebApplication()` aufrufen.

## Quellen

- Microsoft Learn, [Leitfaden zum Ausführen von C#-Azure-Functions in einem isolierten Worker-Prozess](https://learn.microsoft.com/en-us/azure/azure-functions/dotnet-isolated-process-guide).
- Microsoft Learn, [Unterschiede zwischen dem In-Process-Modell und dem Isolated-Worker-Modell](https://learn.microsoft.com/en-us/azure/azure-functions/dotnet-isolated-in-process-differences).
- Azure-Functions-Team, [Ankündigung der Einstellung des In-Process-Modells](https://techcommunity.microsoft.com/blog/appsonazureblog/net-on-azure-functions-roadmap-update/4178714).
- `Microsoft.Azure.Functions.Worker` auf NuGet, [Release Notes für 2.0.x](https://www.nuget.org/packages/Microsoft.Azure.Functions.Worker).
- Azure SDK Blog, [Native-AOT-Unterstützung für Azure-Functions-HTTP-Trigger](https://devblogs.microsoft.com/azure-sdk/).
