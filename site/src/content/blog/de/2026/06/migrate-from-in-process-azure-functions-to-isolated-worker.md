---
title: "Migration von In-Process-Azure-Functions zum Isolated-Worker-Modell (.NET 8 / .NET 11)"
description: "Eine Schritt-für-Schritt-Checkliste, um eine .NET-In-Process-Azure-Functions-App vor dem Ende des Supports am 10. November 2026 zum Isolated-Worker-Modell zu migrieren, mit csproj-Diffs, Signatur-Umschreibungen und einem Rollout per Slot-Swap."
pubDate: 2026-06-05
updatedDate: 2026-06-05
template: migration
tags:
  - "migration"
  - "azure-functions"
  - "dotnet"
  - "csharp"
  - "serverless"
lang: "de"
translationOf: "2026/06/migrate-from-in-process-azure-functions-to-isolated-worker"
translatedBy: "claude"
translationDate: 2026-06-05
---

Eine typische In-Process-Azure-Functions-App auf .NET 8 wechselt in etwa einem fokussierten Tag mit Code-Änderungen plus einem gestaffelten Release-Fenster zum Isolated-Worker-Modell. Was bricht, ist mechanisch und vorhersehbar: die SDK-Referenz in Ihrer `.csproj`, Ihre `Startup.cs`, jedes `[FunctionName]`-Attribut, jedes `Microsoft.Azure.WebJobs.Extensions.*`-Paket und jede Funktion, die einen `ILogger`-Parameter entgegennahm. Nichts davon ist schwierig, aber alles ist erforderlich, denn der Support für das In-Process-Modell endet am **10. November 2026**, und ab diesem Datum liefert Azure In-Process-Apps keine Sicherheits- und Funktionsupdates mehr. Dieser Leitfaden ist die vollständige Checkliste: was zu ändern ist, der genaue Diff für jede Änderung, wie Sie jeden Schritt verifizieren und wie Sie den Laufzeitwechsel über einen Staging-Slot ausrollen, damit die Produktion nie den kaputten Zwischenzustand sieht.

Dies zielt auf den Azure-Functions-Host v4 und migriert eine `dotnet`-App (In-Process) auf .NET 6 oder .NET 8 LTS zum `dotnet-isolated`-Isolated-Worker-Modell auf .NET 8 LTS (der empfohlene schnelle Pfad) oder .NET 11. Die referenzierten Paketversionen sind die neuesten stabilen Stand Juni 2026: `Microsoft.Azure.Functions.Worker` 2.0.x, `Microsoft.Azure.Functions.Worker.Sdk` 2.0.x und die `Microsoft.Azure.Functions.Worker.Extensions.*`-Familie. Wenn Ihre App noch auf Host v1, v2 oder v3 läuft, führen Sie zuerst das [Host-Upgrade von Version 3.x auf 4.x](https://learn.microsoft.com/en-us/azure/azure-functions/migrate-version-3-version-4) durch; dieser Leitfaden integriert den Wechsel zum Isolated Worker in denselben Durchgang.

Wenn Sie noch entscheiden, ob Sie überhaupt migrieren, lesen Sie zuerst [Isolated Worker vs In-Process in .NET 11](/de/2026/05/azure-functions-isolated-worker-vs-in-process-in-dotnet-11/). Dieser Beitrag setzt voraus, dass Sie sich entschieden haben und das mechanische Rezept wollen.

## Warum diese Migration nicht optional ist

- **Der Support für das In-Process-Modell endet am 10. November 2026.** Das ist derselbe Tag, an dem .NET 8 LTS aus dem Support fällt. Ab diesem Datum laufen In-Process-Apps weiter, erhalten aber keine Sicherheitspatches und keine Funktionsupdates von Microsoft mehr, und Sie können keine neue In-Process-App bereitstellen. Microsoft hat [den Hinweis zum Support-Ende](https://aka.ms/azure-functions-retirements/in-process-model) seit Anfang 2024 veröffentlicht.
- **Der Isolated Worker schaltet .NET 9, 10 und 11 frei.** Der In-Process-Host ist auf .NET 8 fixiert und geht nie darüber hinaus. In dem Moment, in dem Sie primäre Konstruktoren, das Schlüsselwort `field`, den Typ `System.Threading.Lock`, Collection-Ausdrücke oder Native AOT wollen, brauchen Sie den Isolated Worker, in dem Sie Ihre eigene Laufzeit mitbringen.
- **Sie erhalten eine echte Middleware-Pipeline und vollständige Dependency Injection.** Der Isolated Worker stellt `IFunctionsWorkerApplicationBuilder.UseMiddleware<T>()` und den Standard-Container `Microsoft.Extensions.DependencyInjection` ohne Einschränkungen der Override-Fläche bereit. Korrelations-IDs, Authentifizierungs-Abkürzungen für Warmup-Sonden und Request-Validierung werden zu Middleware statt zu kopiertem Code am Anfang jeder Funktion.
- **Der Cold Start kann am Ende niedriger ausfallen, nicht höher.** Der Isolated Worker mit reinem JIT ist beim Cold Start ungefähr 150 ms langsamer als In-Process, aber Native AOT auf dem Isolated Worker startet schneller, als In-Process je gestartet ist. Wenn der Cold Start der Grund war, warum Sie bei In-Process geblieben sind, lautet die moderne Antwort Isolated plus AOT.

## Was bricht

| Bereich                    | Änderung                                                                                                 | Schweregrad |
| -------------------------- | ------------------------------------------------------------------------------------------------------- | -------- |
| SDK-Referenz               | `Microsoft.NET.Sdk.Functions` entfernt; ersetzen durch `Microsoft.Azure.Functions.Worker` + `.Worker.Sdk` | hoch     |
| Ausgabetyp                 | die `.csproj` braucht `<OutputType>Exe</OutputType>`; der Worker ist jetzt ein echter Konsolenprozess    | hoch     |
| Startup                    | `FunctionsStartup` / `Startup.cs` ersetzt durch `Program.cs` mit einem `HostBuilder`                     | hoch     |
| Funktionsattribut          | `[FunctionName("X")]` wird zu `[Function("X")]`                                                          | hoch     |
| Binding-Pakete             | jedes `Microsoft.Azure.WebJobs.Extensions.*` wechselt zu `Microsoft.Azure.Functions.Worker.Extensions.*` | hoch     |
| `ILogger`-Parameter        | das per Methode injizierte `ILogger log` wird zu per Konstruktor injiziertem `ILogger<T>`                | mittel   |
| HTTP-Rückgabetyp           | `IActionResult` funktioniert nur weiter, wenn Sie die ASP.NET-Core-Integration aktivieren; sonst `HttpResponseData` | mittel   |
| Eingabe-/Ausgabe-Bindings  | Eingabe-Bindings erhalten das Suffix `Input`, Ausgabe-Bindings das Suffix `Output`, Ausgaben verlassen die Parameterliste | mittel   |
| `IBinder` / `IAsyncCollector<T>` | `IBinder` entfernt; `IAsyncCollector<T>` wird zu einer `T[]`-Rückgabe oder einem injizierten Client | mittel   |
| `FUNCTIONS_WORKER_RUNTIME` | der Wert ändert sich lokal und in den App-Einstellungen in Azure von `dotnet` zu `dotnet-isolated`        | hoch     |
| Log-Filterung              | host.json filtert die Logs Ihres Codes nicht mehr; die Filterung wandert nach `Program.cs`               | gering   |

## Pre-Flight-Checkliste

Bevor Sie eine Codezeile anfassen:

- Bestätigen Sie, dass die App auf **Host v4** läuft. Führen Sie `func --version` (Core Tools 4.x) aus und prüfen Sie die Einstellung der Functions-Laufzeitversion im Portal. Wenn Sie auf v3 oder früher sind, aktualisieren Sie zuerst den Host.
- Installieren Sie das **.NET 8 SDK** (oder das .NET 11 SDK, falls Sie darauf zielen) und die **Azure Functions Core Tools v4** lokal, damit Sie `func start` gegen das migrierte Projekt ausführen können.
- Inventarisieren Sie Ihre **Trigger- und Binding-Pakete**. Grepen Sie die `.csproj` nach `Microsoft.Azure.WebJobs.Extensions` und notieren Sie jedes; Sie brauchen den passenden `Microsoft.Azure.Functions.Worker.Extensions.*`-Ersatz.
- Inventarisieren Sie die Funktionen, die einen **`ILogger`-Methodenparameter** entgegennehmen, und jene, die **`IBinder` oder `IAsyncCollector<T>`** verwenden. Diese brauchen manuelle Änderungen, die die Upgrade-Werkzeuge nicht vollständig automatisieren können.
- Stellen Sie sicher, dass Sie einen **Staging-Bereitstellungsslot** verfügbar haben oder einen erstellen können. Der Laufzeitwechsel darf nicht direkt in der Produktion erfolgen.
- Nehmen Sie das übliche Sicherheitsnetz: einen sauberen Branch, einen grünen Build und eine bestehende Testsuite auf der In-Process-Version, damit Sie eine bekannte-gute Baseline zum Diffen haben.
- Optional, aber empfohlen: Installieren Sie den **.NET Upgrade Assistant** (`dotnet tool install -g upgrade-assistant`). Er automatisiert die `.csproj`-, `Program.cs`-, Attribut- und viele Signaturänderungen; danach korrigieren Sie von Hand die Bindings, die er nicht ableiten konnte.

## Migrationsschritte

Jeder Schritt unten ist eine einzelne Änderung mit einer Verifizierungszeile. Führen Sie sie der Reihe nach aus; das Projekt kompiliert nicht sauber, bis der letzte erledigt ist, was erwartet ist.

1. **Konvertieren Sie das SDK und die Pakete der `.csproj`.** Entfernen Sie die Referenz auf `Microsoft.NET.Sdk.Functions`, fügen Sie die Worker-Pakete hinzu und fügen Sie `<OutputType>Exe</OutputType>` hinzu. Vorher und nachher:

   ```xml
   <!-- BEFORE: in-process, .NET 8, host v4 -->
   <Project Sdk="Microsoft.NET.Sdk">
     <PropertyGroup>
       <TargetFramework>net8.0</TargetFramework>
       <AzureFunctionsVersion>v4</AzureFunctionsVersion>
     </PropertyGroup>
     <ItemGroup>
       <PackageReference Include="Microsoft.NET.Sdk.Functions" Version="4.5.0" />
     </ItemGroup>
   </Project>
   ```

   ```xml
   <!-- AFTER: isolated worker, .NET 8, host v4 -->
   <Project Sdk="Microsoft.NET.Sdk">
     <PropertyGroup>
       <TargetFramework>net8.0</TargetFramework>
       <AzureFunctionsVersion>v4</AzureFunctionsVersion>
       <OutputType>Exe</OutputType>
       <ImplicitUsings>enable</ImplicitUsings>
       <Nullable>enable</Nullable>
     </PropertyGroup>
     <ItemGroup>
       <FrameworkReference Include="Microsoft.AspNetCore.App" />
       <PackageReference Include="Microsoft.Azure.Functions.Worker" Version="2.0.0" />
       <PackageReference Include="Microsoft.Azure.Functions.Worker.Sdk" Version="2.0.0" />
       <PackageReference Include="Microsoft.Azure.Functions.Worker.Extensions.Http.AspNetCore" Version="2.0.0" />
       <PackageReference Include="Microsoft.ApplicationInsights.WorkerService" Version="2.23.0" />
       <PackageReference Include="Microsoft.Azure.Functions.Worker.ApplicationInsights" Version="2.0.0" />
     </ItemGroup>
   </Project>
   ```

   Um stattdessen auf .NET 11 zu zielen, setzen Sie `<TargetFramework>net11.0</TargetFramework>`. Die `FrameworkReference` auf `Microsoft.AspNetCore.App` ist das, was HTTP-Triggern erlaubt, weiterhin `IActionResult` zurückzugeben; behalten Sie sie auch, wenn Sie keine HTTP-Trigger haben, weil sie den Worker-Start verbessert. **Verifizieren:** `dotnet restore` ist erfolgreich und zieht die Worker-Pakete. Der Build schlägt im Code weiterhin fehl, was in Ordnung ist.

2. **Ersetzen Sie jedes Binding-Erweiterungspaket.** Für jedes inventarisierte `Microsoft.Azure.WebJobs.Extensions.*` wechseln Sie zum Worker-Äquivalent. Die gängigen:

   ```text
   Microsoft.Azure.WebJobs.Extensions.Storage.Blobs
     -> Microsoft.Azure.Functions.Worker.Extensions.Storage.Blobs
   Microsoft.Azure.WebJobs.Extensions.ServiceBus
     -> Microsoft.Azure.Functions.Worker.Extensions.ServiceBus
   Microsoft.Azure.WebJobs.Extensions.CosmosDB
     -> Microsoft.Azure.Functions.Worker.Extensions.CosmosDB
   Microsoft.Azure.WebJobs.Extensions.EventHubs
     -> Microsoft.Azure.Functions.Worker.Extensions.EventHubs
   Microsoft.Azure.WebJobs.Extensions.DurableTask
     -> Microsoft.Azure.Functions.Worker.Extensions.DurableTask
   ```

   Ein Timer-Trigger braucht, dass `Microsoft.Azure.Functions.Worker.Extensions.Timer` explizit hinzugefügt wird. Entfernen Sie `Microsoft.Azure.Functions.Extensions` vollständig; der Isolated Worker stellt das DI-Startup nativ bereit. **Verifizieren:** Es bleibt keine Referenz auf irgendein `Microsoft.Azure.WebJobs.*`-Paket. `dotnet list package | Select-String WebJobs` (PowerShell) sollte nichts ausgeben.

3. **Fügen Sie `Program.cs` hinzu und löschen Sie `Startup.cs`.** Der Isolated Worker ist eine Konsolen-App und braucht einen Einstiegspunkt. Verschieben Sie alles aus Ihrem `FunctionsStartup.Configure` nach `ConfigureServices`:

   ```csharp
   // Program.cs -- .NET 8 / .NET 11, Microsoft.Azure.Functions.Worker 2.0.x
   using Microsoft.Azure.Functions.Worker;
   using Microsoft.Extensions.DependencyInjection;
   using Microsoft.Extensions.Hosting;

   var builder = FunctionsApplication.CreateBuilder(args);

   // ConfigureFunctionsWebApplication() opts into ASP.NET Core integration so HTTP
   // triggers can keep using HttpRequest / IActionResult. Use
   // ConfigureFunctionsWorkerDefaults() instead if you have no HTTP triggers.
   builder.ConfigureFunctionsWebApplication();

   builder.Services
       .AddApplicationInsightsTelemetryWorkerService()
       .ConfigureFunctionsApplicationInsights();

   // Everything that used to be in Startup.Configure goes here:
   builder.Services.AddHttpClient();
   builder.Services.AddSingleton<IOrderStore, OrderStore>();

   builder.Build().Run();
   ```

   Löschen Sie dann die Klasse, die das Attribut `[assembly: FunctionsStartup(typeof(Startup))]` trug. **Verifizieren:** Die Datei kompiliert isoliert, und es bleibt nirgendwo ein `FunctionsStartup`-Attribut (`Select-String FunctionsStartup -Path **/*.cs`).

4. **Benennen Sie die Funktionsattribute um.** `[FunctionName("X")]` wird zu `[Function("X")]`. Die Signatur ist identisch, also ist es ein sicheres projektweites Ersetzen von Zeichenketten. **Verifizieren:** `Select-String "FunctionName" -Path **/*.cs` gibt nichts zurück.

5. **Verschieben Sie `ILogger` vom Parameter zum Konstruktor.** In-Process erlaubte Ihnen, einen Parameter `ILogger log` auf der Funktionsmethode entgegenzunehmen. Der Isolated Worker verwendet Konstruktorinjektion. Konvertieren Sie jede betroffene Funktionsklasse zu einem primären Konstruktor:

   ```csharp
   // BEFORE (in-process)
   public static class HttpTriggerCSharp
   {
       [FunctionName("HttpTriggerCSharp")]
       public static IActionResult Run(
           [HttpTrigger(AuthorizationLevel.Function, "get")] HttpRequest req,
           ILogger log)
       {
           log.LogInformation("processed a request");
           return new OkObjectResult($"Hello, {req.Query["name"]}!");
       }
   }
   ```

   ```csharp
   // AFTER (isolated worker, .NET 8 / .NET 11, C# 12+ primary constructor)
   public class HttpTriggerCSharp(ILogger<HttpTriggerCSharp> logger)
   {
       [Function("HttpTriggerCSharp")]
       public IActionResult Run(
           [HttpTrigger(AuthorizationLevel.Function, "get")] HttpRequest req)
       {
           logger.LogInformation("processed a request");
           return new OkObjectResult($"Hello, {req.Query["name"]}!");
       }
   }
   ```

   Beachten Sie, dass die Funktion nicht mehr `static` ist, die Klasse nicht mehr `static` ist und `ILogger` die Methodensignatur verlassen hat. **Verifizieren:** Die Funktionsklasse kompiliert, und keine Funktionsmethode hat noch einen `ILogger`-Parameter.

6. **Korrigieren Sie die Usings und Attributnamen von Triggern und Bindings.** Entfernen Sie `using Microsoft.Azure.WebJobs;`, fügen Sie `using Microsoft.Azure.Functions.Worker;` hinzu. Trigger behalten meist ihren Namen (`QueueTrigger` bleibt `QueueTrigger`), Eingabe-Bindings erhalten ein Suffix `Input` (`CosmosDB` wird zu `CosmosDBInput`), und Ausgabe-Bindings erhalten ein Suffix `Output` (`Queue` wird zu `QueueOutput`, `Blob` wird zu `BlobOutput`). Ausgabe-Bindings verlassen außerdem die Parameterliste: eine einzelne Ausgabe geht auf den Rückgabetyp, mehrere Ausgaben gehen auf Eigenschaften einer kleinen Ergebnisklasse. Ersetzen Sie `IAsyncCollector<T>` durch eine `T[]`-Rückgabe und entfernen Sie jeden `IBinder`-Parameter zugunsten eines injizierten Clients. **Verifizieren:** `dotnet build` ist jetzt mit null Fehlern erfolgreich.

7. **Aktualisieren Sie `local.settings.json`.** Ändern Sie den Wert der Worker-Laufzeit:

   ```json
   {
     "IsEncrypted": false,
     "Values": {
       "AzureWebJobsStorage": "UseDevelopmentStorage=true",
       "FUNCTIONS_WORKER_RUNTIME": "dotnet-isolated"
     }
   }
   ```

   Es ist keine Änderung an `host.json` erforderlich. **Verifizieren:** `func start` startet die App lokal, und Ihre Funktionen erscheinen im Start-Banner mit ihren Routen.

## Verifizierung

Nachdem der Build grün ist, führen Sie diesen Smoke-Test aus, bevor Sie sich Azure nähern:

- `dotnet build` gibt null Fehler und null `Microsoft.Azure.WebJobs.*`-Referenzen zurück.
- `func start` startet und listet jede Funktion mit dem korrekten Trigger und der korrekten Route auf.
- Treffen Sie jeden HTTP-Trigger lokal (`curl` oder Ihr Testclient) und bestätigen Sie denselben Statuscode und Body, den die In-Process-Version zurückgab.
- Lösen Sie jeden Nicht-HTTP-Trigger aus: legen Sie ein Blob ab, reihen Sie eine Nachricht ein, lassen Sie den Timer ticken. Bestätigen Sie, dass die Funktion läuft und ihre Ausgaben schreibt.
- `dotnet test` läuft durch. Achten Sie besonders auf Tests, die auf Log-Ausgabe oder Serializer-Verhalten geprüft haben, da sich beide verschieben können (siehe Gotchas).
- Vergleichen Sie einen erfassten Application-Insights-Trace von vorher und nachher. Bestätigen Sie, dass Ihre Log-Kategorien noch auf den erwarteten Ebenen erscheinen; wenn sie verschwunden sind, fehlt die Log-Filterung in Ihrer `Program.cs`.

## Rollout in Azure und Rollback

Die Azure-Seite besteht aus zwei Änderungen, die zusammen erfolgen müssen: `FUNCTIONS_WORKER_RUNTIME` auf `dotnet-isolated` setzen und das isolierte Payload bereitstellen. Wenn nur eine landet, sitzt die App in einem Fehlerzustand, weil der bereitgestellte Code nicht zur konfigurierten Laufzeit passt. Tun Sie das nie direkt in der Produktion. Stattdessen:

1. Erstellen oder wiederverwenden Sie einen **Staging-Bereitstellungsslot**.
2. Setzen Sie auf dem Staging-Slot die App-Einstellung `FUNCTIONS_WORKER_RUNTIME` auf `dotnet-isolated`. Markieren Sie sie **nicht** als Slot-Einstellung. Wenn Sie auch die .NET-Version geändert haben, aktualisieren Sie die Stack-Konfiguration auf dem Slot ebenfalls.
3. Veröffentlichen Sie das migrierte Projekt im Staging-Slot. Sie werden während des Übergangs vorübergehende Fehler in den Slot-Logs sehen; warten Sie, bis sie aufhören.
4. Smoke-testen Sie den Staging-Slot gegen echte Azure-Abhängigkeiten. Bestätigen Sie, dass die Fehler verschwunden sind und das Verhalten der Produktion entspricht.
5. **Swappen** Sie den Staging-Slot in die Produktion. Der Swap ist eine einzelne atomare Aktualisierung, sodass die Produktion nie den kaputten Zwischenzustand sieht.
6. Bestätigen Sie, dass die Produktion gesund ist.

**Rollback:** Dies ist vollständig umkehrbar, solange Sie den In-Process-Build behalten. Zum Zurücksetzen swappen Sie die Slots zurück: Das vorherige Produktions-Payload (noch In-Process) kehrt in einer einzigen Aktion in den Produktionsslot zurück. Da der Swap atomar ist, ist das Rollback derselbe Ein-Klick-Schritt wie das Rollout. Behalten Sie den In-Process-Branch und sein letztes gutes Artefakt, bis das neue Modell mindestens ein paar Tage unter echtem Datenverkehr eingelaufen ist. Die Migration wird erst in dem Moment einseitig, in dem Sie dieses In-Process-Artefakt löschen, also löschen Sie es nicht am ersten Tag.

## Gotchas, auf die wir gestoßen sind

**Logs verschwinden still aus Application Insights.** Im In-Process-Modell steuerte `host.json` die Log-Filterung für alles, einschließlich Ihres Codes. Im Isolated Worker filtert `host.json` nur die Functions-Host-Laufzeit; die Logs Ihrer Anwendung werden durch die Logging-Konfiguration in `Program.cs` gefiltert. Wenn Sie migrieren und Ihre `Information`-Logs verschwinden, fügen Sie explizite Filterung in `Program.cs` hinzu, statt zu erwarten, dass `host.json` sie abdeckt.

**HTTP-Antworten ändern ihre Form, wenn Sie sich auf Newtonsoft verlassen haben.** In-Process-HTTP-Trigger, die `IActionResult` zurückgaben, serialisierten über die MVC-Formatter des Hosts, die viele Apps mit einem Newtonsoft-Contract-Resolver konfiguriert hatten. Der Isolated Worker verwendet standardmäßig `System.Text.Json`. Wenn Ihr JSON plötzlich eine andere Schreibweise verwendet oder einen benutzerdefinierten Konverter verliert, registrieren Sie Ihren Serializer auf dem Worker. Wenn Sie abwägen, ob Sie Newtonsoft überhaupt behalten, lesen Sie [System.Text.Json vs Newtonsoft.Json in 2026](/de/2026/05/system-text-json-vs-newtonsoft-json-in-2026/).

**Durable-Functions-Orchestratoren, die Services injizierten, beginnen nichtdeterministisch zu replayen.** Die DI des In-Process-Hosts war nachsichtig genug, dass das Aufrufen eines instanzbezogenen Service innerhalb eines Orchestrators manchmal zufällig funktionierte. Auf dem Isolated Worker kann derselbe Code zu einem Deadlock führen oder nichtdeterministisch replayen. Die Korrektur ist die Standard-Durable-Regel, die das In-Process-Modell zu biegen erlaubte: Orchestratoren rufen nur Aktivitätsfunktionen auf, und Seiteneffekte leben in Aktivitäten, nicht in injizierten Services.

**Die App steht während des Deploys in Azure auf Rot, und das ist normal.** Das erste Mal, wenn Sie das isolierte Payload in einen Slot pushen, dessen `FUNCTIONS_WORKER_RUNTIME` noch `dotnet` ist (oder umgekehrt), meldet der Slot einen Fehlerzustand. Das ist die Zwischen-Diskrepanz, vor der die Dokumentation warnt. Genau deshalb läuft das Rollout über einen Staging-Slot, und sie verschwindet, sobald sowohl die Einstellung als auch das Payload übereinstimmen.

**Ausgabe-Bindings in der Parameterliste kompilieren nicht.** Der häufigste Build-Fehler nach dem Paketwechsel ist ein Ausgabe-Binding, das noch als `out`- oder `IAsyncCollector<T>`-Parameter dasitzt. Verschieben Sie es auf den Rückgabetyp (einzelne Ausgabe) oder eine Ergebnisklasse (mehrere Ausgaben). Der Compilerfehler zeigt auf den Parameter, aber die Korrektur ist strukturell, kein Typ-Cast.

## Verwandt

- [Azure Functions Isolated Worker vs In-Process in .NET 11](/de/2026/05/azure-functions-isolated-worker-vs-in-process-in-dotnet-11/) ist der entscheidungsorientierte Begleiter zu dieser Checkliste, mit der vollständigen Funktionsmatrix und dem Cold-Start-Benchmark.
- [Migration von .NET 8 auf .NET 11: die vollständige Checkliste](/de/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) ist der natürliche nächste Schritt, sobald Sie auf dem Isolated Worker sind und die Laufzeit voranbringen wollen.
- [Native AOT mit ASP.NET Core Minimal APIs verwenden](/de/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) behandelt die Publish-Einstellungen und Trim-Warnungen, denen Sie begegnen, wenn Sie AOT für den migrierten Worker aktivieren.
- [Native AOT vs ReadyToRun vs reines JIT](/de/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) hat die Zahlen hinter der Behauptung "Isolated plus AOT schlägt In-Process beim Cold Start".
- [Cold-Start-Zeit für eine .NET 11 AWS Lambda reduzieren](/de/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) teilt den Großteil des AOT-Cold-Start-Rats, falls Sie auch Funktionen außerhalb von Azure betreiben.

## Quellen

- Microsoft Learn, [C#-Apps vom In-Process-Modell zum Isolated-Worker-Modell migrieren](https://learn.microsoft.com/en-us/azure/azure-functions/migrate-dotnet-to-isolated-model).
- Microsoft Learn, [Unterschiede zwischen dem In-Process-Modell und dem Isolated-Worker-Modell](https://learn.microsoft.com/en-us/azure/azure-functions/dotnet-isolated-in-process-differences).
- Microsoft Learn, [Leitfaden zum Ausführen von C#-Azure-Functions in einem Isolated-Worker-Prozess](https://learn.microsoft.com/en-us/azure/azure-functions/dotnet-isolated-process-guide).
- Azure updates, [Der Support für das In-Process-Modell endet am 10. November 2026](https://aka.ms/azure-functions-retirements/in-process-model).
- Microsoft Learn, [Durable Functions von In-Process zum Isolated-Worker-Modell migrieren](https://learn.microsoft.com/en-us/azure/azure-functions/durable/durable-functions-migrate).
- `Microsoft.Azure.Functions.Worker` auf [NuGet](https://www.nuget.org/packages/Microsoft.Azure.Functions.Worker).
