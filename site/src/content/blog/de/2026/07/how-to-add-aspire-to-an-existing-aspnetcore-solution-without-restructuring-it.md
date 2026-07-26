---
title: "Wie Sie Aspire zu einer bestehenden ASP.NET Core Solution hinzufügen, ohne sie umzubauen"
description: "Aspire 13.4 in eine bestehende ASP.NET Core Solution integrieren: zwei neue Projekte und drei Zeilen pro Service. aspire init, AppHost-Verdrahtung mit AddProject und WithReference, bestehende launchSettings.json und Connection Strings bleiben erhalten, plus die Stolpersteine bei Resilienz, Health-Endpunkten und Proxy am ersten Tag."
pubDate: 2026-07-26
template: how-to
tags:
  - "aspire"
  - "dotnet"
  - "aspnetcore"
  - "dotnet-11"
  - "opentelemetry"
  - "devops"
lang: "de"
translationOf: "2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it"
translatedBy: "claude"
translationDate: 2026-07-26
---

Aspire kommt in eine bestehende ASP.NET Core Solution, indem Sie zwei neue Projekte neben die vorhandenen stellen, nicht indem Sie etwas verschieben. Ein `AppHost`-Projekt orchestriert Ihre Services zur Entwicklungszeit, eine `ServiceDefaults`-Bibliothek trägt die gemeinsame Telemetrie- und Resilienz-Konfiguration, und jeder bestehende Service bekommt genau eine Projektreferenz plus zwei Zeilen in `Program.cs`. Ordnerstruktur, Namespaces, `launchSettings.json`, Connection Strings, Dockerfiles und CI-Pipeline bleiben unverändert. Dieser Artikel geht das Ganze auf Aspire 13.4.6 durch (die aktuelle stabile Version, veröffentlicht am 2026-06-20) gegen .NET 10 und .NET 11 Preview 6.

Zwei Dinge haben sich gegenüber den Anleitungen geändert, die Sie vermutlich zuerst gefunden haben. Aspire hat mit Aspire 13 im November 2025 das ".NET" aus dem Namen gestrichen, und der Schritt `dotnet workload install aspire` ist bereits mit Aspire 9.0 entfallen. Alles kommt jetzt über NuGet und ein MSBuild-SDK. Wenn also das alte Workload noch auf der Maschine liegt, ist `dotnet workload uninstall aspire` das Erste, was Sie ausführen sollten. Wer den konzeptionellen Überblick vor der Mechanik möchte: die ältere [Übersicht, was Aspire ist](/de/2023/11/what-is-net-aspire/) trägt weiterhin.

## Was tatsächlich im Repository landet

Die ehrliche Inventur für eine Solution mit einer API und einem Worker:

```
MyApp.sln
  src/MyApp.Api/            <- unchanged except 1 ProjectReference + 2 lines
  src/MyApp.Worker/         <- unchanged except 1 ProjectReference + 2 lines
  src/MyApp.AppHost/        <- new
  src/MyApp.ServiceDefaults/<- new
  aspire.config.json        <- new, points the CLI at the AppHost
```

Kein Projekt wird verschoben. Keine Namespace-Änderung. Keine Änderung daran, wie `dotnet publish` Ihre Container-Images erzeugt, denn der AppHost ist ein Orchestrator für die Entwicklungszeit und nicht Teil dessen, was Sie bereitstellen. Genau dieser letzte Punkt wird oft missverstanden: Der AppHost läuft nicht in Produktion. Er startet Ihre Prozesse lokal, injiziert Konfiguration und speist das Dashboard.

## Schritte, um Aspire zu einer bestehenden Solution hinzuzufügen

1. Installieren Sie die Aspire CLI als globales Tool und prüfen Sie, dass sie Ihr SDK sieht.
2. Führen Sie `aspire init` im Solution-Wurzelverzeichnis aus, damit die `.sln` erkannt und ein projektbasierter AppHost erzeugt wird.
3. Fügen Sie eine Projektreferenz vom AppHost auf jeden Service hinzu, den er starten soll, und deklarieren Sie diese Services dann mit `AddProject` in der `Program.cs` des AppHosts.
4. Referenzieren Sie `ServiceDefaults` aus jedem Service und rufen Sie `AddServiceDefaults()` sowie `MapDefaultEndpoints()` auf.
5. Modellieren Sie Ihre bestehende Infrastruktur: Container für das, was lokal laufen darf, `AddConnectionString` für alles, was extern bleiben muss.
6. Führen Sie `aspire run` aus und prüfen Sie, dass jeder Service weiterhin mit den Endpunkten startet, die er vorher hatte.

Der Rest dieses Artikels sind diese sechs Schritte mit Code, danach die Stellen, die brechen.

## Die CLI installieren

Seit Aspire 13.3 wird die CLI als NativeAOT-kompiliertes globales .NET-Tool ausgeliefert, also ohne Workload und ohne Visual-Studio-Abhängigkeit:

```bash
dotnet tool install -g Aspire.Cli
aspire doctor
```

`aspire doctor` kam mit 13.4 und lohnt sich vor allem anderen. Es gibt die CLI-Version aus, die sichtbaren SDKs und, das ist der wichtige Teil, ob Ihre CLI-Version und Ihre `Aspire.AppHost.Sdk`-Version auseinandergelaufen sind. Der Versionsunterschied zwischen beiden ist die häufigste Quelle für "bei mir lief es" in einem Aspire-Repository.

## Den AppHost erzeugen

Aus dem Verzeichnis, das Ihre `.sln` enthält:

```bash
aspire init
```

Findet `aspire init` eine Solution-Datei, erzeugt es einen projektbasierten AppHost und nimmt ihn in die Solution auf. Findet es keine (etwa in einem polyglotten Repository), erzeugt es stattdessen eine einzelne Datei `apphost.cs` mit `#:sdk`- und `#:package`-Direktiven. Für eine bestehende ASP.NET Core Solution wollen Sie die projektbasierte Variante, denn nur sie liefert den generierten `Projects`-Namespace und IDE-integriertes Debugging über alle Services gleichzeitig.

Wer die CLI nicht nutzen möchte: die Templates leisten dasselbe.

```bash
dotnet new aspire-apphost -o src/MyApp.AppHost
dotnet new aspire-servicedefaults -o src/MyApp.ServiceDefaults
dotnet sln add src/MyApp.AppHost src/MyApp.ServiceDefaults
```

Die Projektdatei des AppHosts ist klein und die einzige Stelle, an der das Aspire-SDK auftaucht:

```xml
<!-- src/MyApp.AppHost/MyApp.AppHost.csproj -- Aspire 13.4.6 -->
<Project Sdk="Microsoft.NET.Sdk">
  <Sdk Name="Aspire.AppHost.Sdk" Version="13.4.6" />

  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <IsAspireHost>true</IsAspireHost>
    <Nullable>enable</Nullable>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Aspire.Hosting.AppHost" Version="13.4.6" />
  </ItemGroup>
</Project>
```

Beachten Sie das `TargetFramework`. Der AppHost darf ein neueres TFM anvisieren als die Services, die er startet, weil er sie als separate Prozesse startet. Eine Solution, deren Services auf `net8.0` festhängen, kann trotzdem einen `net10.0`-AppHost haben.

## Bestehende Projekte verdrahten

Referenzen vom AppHost auf die Services hinzufügen und diese dann deklarieren:

```bash
dotnet add src/MyApp.AppHost reference src/MyApp.Api src/MyApp.Worker
```

```csharp
// src/MyApp.AppHost/Program.cs -- Aspire 13.4.6
var builder = DistributedApplication.CreateBuilder(args);

var api = builder.AddProject<Projects.MyApp_Api>("api")
    .WithExternalHttpEndpoints();

builder.AddProject<Projects.MyApp_Worker>("worker")
    .WithReference(api)
    .WaitFor(api);

builder.Build().Run();
```

Der Typ `Projects.MyApp_Api` wird vom Aspire-SDK aus den `ProjectReference`-Einträgen generiert, wobei Punkte durch Unterstriche ersetzt werden. Sie schreiben ihn nicht, und er existiert erst nach dem ersten Build.

Hier kommt der Teil, der das Vorgehen nicht-invasiv macht und der zu wenig dokumentiert ist: Aspire liest Ihre vorhandene `Properties/launchSettings.json`. Beim Start einer Projektressource wählt es ein Profil nach Rangfolge: das Argument `launchProfileName`, falls übergeben, dann ein Profil, dessen Name dem `DOTNET_LAUNCH_PROFILE` des AppHosts entspricht, dann das erste Profil in der Datei, dann gar kein Profil. Es liest `applicationUrl` aus dem gewählten Profil und wandelt es in `ASPNETCORE_URLS` um, und es übernimmt die `environmentVariables` dieses Profils unverändert. Ihre bestehenden Profile funktionieren weiter. Steht bei einem Service ein "IIS Express"-Profil an erster Stelle und Sie wollen das Kestrel-Profil, benennen Sie es explizit:

```csharp
builder.AddProject<Projects.MyApp_Api>("api", launchProfileName: "https");
```

`launchProfileName: null` startet das Projekt ganz ohne Profil, was für einen Worker ohne sinnvolle `launchSettings.json` die sauberste Variante ist.

## Die zwei Zeilen pro Service

`ServiceDefaults` ist eine gewöhnliche Bibliothek, markiert mit `IsAspireSharedProject`. Referenzieren Sie sie aus jedem Service und rufen Sie hinein:

```csharp
// src/MyApp.Api/Program.cs -- ASP.NET Core on .NET 10 / .NET 11 Preview 6
var builder = WebApplication.CreateBuilder(args);

builder.AddServiceDefaults();   // <- added

builder.Services.AddControllers();
// ... everything you already had, untouched

var app = builder.Build();

app.MapDefaultEndpoints();      // <- added

app.MapControllers();
app.Run();
```

`AddServiceDefaults()` erledigt vier Dinge: es konfiguriert OpenTelemetry-Logging, -Metriken und -Tracing (Health-Check-Anfragen werden aus den Traces gefiltert), registriert einen Liveness-Health-Check, registriert Service Discovery und wendet `ConfigureHttpClientDefaults` an, sodass jeder `HttpClient` den Standard-Resilienz-Handler und die Service-Discovery-Auflösung bekommt. `MapDefaultEndpoints()` mappt `/health` (alle Checks müssen bestehen) und `/alive` (nur Checks mit dem Tag `live`), und das Template schützt beide hinter einer Prüfung auf die Entwicklungsumgebung.

Nichts davon ist zur Laufzeit Aspire-spezifisch. Ein Service mit `AddServiceDefaults()` läuft problemlos außerhalb des AppHosts, unter `dotnet run`, in einem Container, in Ihrer bestehenden Kubernetes-Bereitstellung. Er exportiert lediglich OTLP-Telemetrie dorthin, wohin `OTEL_EXPORTER_OTLP_ENDPOINT` zeigt: das Dashboard, wenn der AppHost ihn gestartet hat, und Ihr echter Collector, wenn nicht. Falls noch kein Collector existiert, deckt der [Rundgang durch ein kostenloses OpenTelemetry-Backend](/de/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) das andere Ende dieser Leitung ab.

## Vorhandene Infrastruktur modellieren

Hier weicht der Bestandsfall am stärksten von den Greenfield-Tutorials ab, die alle damit beginnen, sämtliche Abhängigkeiten in Container zu stecken. Meistens geht das nicht. Der geteilte Entwicklungs-SQL-Server ist aus gutem Grund geteilt, und in der Queue liegen Daten.

Für Abhängigkeiten, die lokal laufen dürfen, fügen Sie die Integration hinzu und überlassen Aspire den Container:

```bash
aspire add redis
```

```csharp
var cache = builder.AddRedis("cache");

var api = builder.AddProject<Projects.MyApp_Api>("api")
    .WithReference(cache)
    .WaitFor(cache);
```

`WithReference(cache)` injiziert `ConnectionStrings__cache` in den API-Prozess. Ihr bestehender Aufruf `builder.Configuration.GetConnectionString("cache")` liest den Wert unverändert, weil Umgebungsvariablen in der Standardkonfiguration Vorrang vor `appsettings.json` haben. Das ist der ganze Trick: Aspire verlangt nicht, dass Ihr Code die Art der Konfigurationslektüre ändert, es liefert die Werte nur mit höherem Vorrang. Dasselbe gilt, wenn Sie [HybridCache mit Redis als L2](/de/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/) verdrahten: die Cache-Ressource liefert den Connection String, der Rest Ihres Setups bleibt gleich.

Für Abhängigkeiten, die extern bleiben müssen, erzeugt `AddConnectionString` eine Ressource, die von der Konfiguration des AppHosts selbst getragen wird statt von einem Container:

```csharp
// Reads ConnectionStrings:orders from the AppHost's appsettings.json or user secrets
var orders = builder.AddConnectionString("orders");

builder.AddProject<Projects.MyApp_Api>("api")
    .WithReference(orders);
```

Legen Sie den echten Wert in die User Secrets des AppHosts, nicht in `appsettings.json`:

```bash
dotnet user-secrets --project src/MyApp.AppHost set "ConnectionStrings:orders" "Server=dev-sql;Database=Orders;..."
```

Der Service sieht `ConnectionStrings__orders`, sonst ändert sich nichts. Sucht ein Service nach einem Namen, den der AppHost nie deklariert hat, bekommen Sie den bekannten Startfehler aus [kein Connection String namens DefaultConnection gefunden](/de/2026/05/fix-no-connection-string-named-defaultconnection/); der Ressourcenname in `AddConnectionString` muss exakt dem Schlüssel entsprechen, den Ihr Code abfragt.

Service-zu-Service-Aufrufe funktionieren genauso. `WithReference(api)` injiziert `services__api__https__0` und `services__api__http__0`, und Service Discovery löst den logischen Namen auf:

```csharp
builder.Services.AddHttpClient<OrdersClient>(
    c => c.BaseAddress = new("https+http://api"));
```

`https+http://` heißt: bevorzugt HTTPS, ersatzweise HTTP. Es löst nur in einem Projekt auf, das Service Discovery registriert hat, was `AddServiceDefaults()` für Sie erledigt. Verwenden Sie dieses Schema in einem Projekt ohne `AddServiceDefaults()`, bekommen Sie eine `UriFormatException` bei der ersten Anfrage, nicht beim Start.

## Ausführen

```bash
aspire run
```

Die CLI findet den AppHost über `aspire.config.json`, startet alle Ressourcen und gibt die Dashboard-URL aus. In Visual Studio oder Rider setzen Sie den AppHost als Startprojekt und drücken F5; Mehrprojekt-Startkonfigurationen entfallen.

Eine Überraschung für alle, die von den Anleitungen aus dem Jahr 2023 kommen: Docker muss nicht laufen, solange Sie keine Container-Ressource deklariert haben. Ein AppHost, der nur aus `AddProject`-Aufrufen besteht, startet ohne installierte Container-Laufzeit. Das macht den ersten Commit ungefährlich: Sie können den AppHost mit null Container-Ressourcen einbringen, Dashboard und verteiltes Tracing bekommen und Abhängigkeiten später oder nie containerisieren.

## Was am ersten Tag bricht

**Der Standard-Resilienz-Handler ändert Ihr HTTP-Verhalten.** `AddServiceDefaults()` wendet ihn auf jeden `HttpClient` im Prozess an, also Wiederholungen, ein Circuit Breaker und ein Gesamt-Timeout pro Anfrage. Wenn ein Client legitim zwei Minuten braucht oder Sie bereits eigene Polly-Pipelines haben, liegen jetzt zwei Schichten übereinander. Entfernen Sie Ihre eigene, oder schränken Sie die Defaults ein, aber lassen Sie nicht beides stehen.

**Doppelte Health-Endpunkte.** Wenn Sie `/health` bereits selbst mappen, liefert `MapDefaultEndpoints()` eine zweite Registrierung auf derselben Route. Entscheiden Sie sich für eine. Der [Rundgang zu Health Checks in Minimal APIs](/de/2026/07/how-to-add-a-health-check-endpoint-to-a-minimal-api-in-aspnetcore-11/) zeigt, was zu behalten ist, wenn Sie eine reichhaltigere Ausgabe als die Standardausgabe wollen.

**Doppelte OpenTelemetry-Registrierung.** `ConfigureOpenTelemetry` in `ServiceDefaults` ergänzt alles, was Sie bereits registriert haben. Hat Ihre `Program.cs` ein eigenes `AddOpenTelemetry().WithTracing(...)`, bekommen Sie doppelte Instrumentierung und, mit Serilog im Spiel, doppelte Log-Einträge. Löschen Sie Ihre Variante und passen Sie stattdessen die `ServiceDefaults`-Version an, genau dafür ist das gemeinsame Projekt da.

**Endpunkte laufen standardmäßig über einen Proxy.** Aspire setzt einen Reverse Proxy vor jeden Endpunkt, der Port im Browser ist also nicht der Port, an den Kestrel gebunden hat. Das fällt erst auf, wenn etwas Externes einen Port festnagelt: eine bei Ihrem Identity Provider registrierte OIDC-Redirect-URI, ein Webhook aus einer Zahlungs-Sandbox, eine fest verdrahtete URL in einem mobilen Client. Pro Endpunkt abschalten:

```csharp
builder.AddProject<Projects.MyApp_Api>("api")
    .WithEndpoint("https", e => e.IsProxied = false);
```

**Ihr CI kompiliert jetzt den AppHost.** `dotnet build MyApp.sln` nimmt das neue Projekt mit, das `Aspire.AppHost.Sdk` von NuGet wiederherstellen muss. Auf einem abgeschotteten Feed mit expliziter Paket-Allowlist schlägt das fehl, und der Fehler ist ein SDK-Auflösungsfehler statt eines Fehlers wegen eines fehlenden Pakets, was die Diagnose unnötig verlangsamt. Entweder nehmen Sie das SDK und die Hosting-Pakete in die Allowlist auf, oder Sie schließen den AppHost per Solution-Filter aus dem CI-Build aus. Darüber hinaus muss sich in Ihrer Bereitstellungspipeline nichts ändern, weil Sie weiterhin dieselben Service-Projekte auf dieselbe Weise veröffentlichen.

**Postgres-Nutzer unter 13.4:** das Standard-Image ist von 17.6 auf 18.3 gewechselt und lässt sich nicht an ein bestehendes 17.x-Datenvolume anhängen. Pinnen Sie den Tag mit `WithImageTag`, wenn Ihnen lokale Daten wichtig sind.

## Verwandte Artikel

- [Was ist .NET Aspire?](/de/2023/11/what-is-net-aspire/) für das konzeptionelle Modell hinter AppHost und Integrationen.
- [Wie Sie einen Health-Check-Endpunkt zu einer Minimal API in ASP.NET Core 11 hinzufügen](/de/2026/07/how-to-add-a-health-check-endpoint-to-a-minimal-api-in-aspnetcore-11/), falls `MapDefaultEndpoints` mit Ihrem Bestand kollidiert.
- [Wie Sie OpenTelemetry mit .NET 11 und einem kostenlosen Backend nutzen](/de/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) dazu, wohin die Traces gehen, sobald Sie das Dashboard verlassen.
- [Fix: Kein Connection String namens 'DefaultConnection' gefunden](/de/2026/05/fix-no-connection-string-named-defaultconnection/) zum Fehlerbild bei abweichenden Ressourcennamen.
- [Aspire 13.2 Isolated Mode und parallele AppHost-Instanzen](/de/2026/04/aspire-13-2-isolated-mode-parallel-apphost-instances/), wenn zwei Entwickler oder zwei Branches denselben AppHost gleichzeitig starten müssen.

## Quellen

- [Add Aspire to an existing app](https://aspire.dev/get-started/add-aspire-existing-app/), Aspire-Dokumentation.
- [C# service defaults](https://aspire.dev/get-started/csharp-service-defaults/), Aspire-Dokumentation.
- [C# launch profiles in the Aspire AppHost](https://aspire.dev/integrations/dotnet/launch-profiles/), Aspire-Dokumentation.
- [External parameters and secrets in the AppHost](https://aspire.dev/fundamentals/external-parameters/), Aspire-Dokumentation.
- [Service discovery](https://aspire.dev/fundamentals/service-discovery/), Aspire-Dokumentation.
- [What's new in Aspire 13.3](https://aspire.dev/whats-new/aspire-13-3/) und [What's new in Aspire 13.4](https://aspire.dev/whats-new/aspire-13-4/), Aspire-Dokumentation.
- [Aspire releases](https://github.com/microsoft/aspire/releases) auf GitHub, für Version 13.4.6 und das Datum.
