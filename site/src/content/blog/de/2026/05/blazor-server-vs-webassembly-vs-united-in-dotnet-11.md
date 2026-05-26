---
title: "Blazor Server vs Blazor WebAssembly vs Blazor United in .NET 11: Was sollten Sie 2026 wählen?"
description: "Für jede neue Blazor-App auf .NET 11 erstellen Sie eine Blazor Web App (das Template, das früher Blazor United hieß) und wählen den Render-Modus pro Seite. Nur Server- oder nur WebAssembly-Templates sind nur in engen Fällen sinnvoll."
pubDate: 2026-05-26
tags:
  - "comparison"
  - "blazor"
  - "dotnet"
  - "csharp"
  - "aspnetcore"
lang: "de"
translationOf: "2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-05-26
---

Für ein neues Blazor-Projekt auf .NET 11 lautet die Antwort: das Blazor-Web-App-Template (das Modell, das im Preview von .NET 8 unter dem Spitznamen "Blazor United" lief). Es lässt Sie das Rendering pro Komponente entscheiden: statisches serverseitiges Rendering für Marketing-Seiten, interaktiven Server für latenzarme CRUD-Bildschirme, interaktives WebAssembly für offline-fähige Widgets und Auto für Komponenten, die von Server zu WebAssembly wechseln sollen, sobald das WASM-Payload fertig heruntergeladen ist. Wählen Sie ein reines Server- oder reines WebAssembly-Template nur dann, wenn Sie eine harte Einschränkung haben, die das vereinheitlichte Modell ausschließt: eine interne App, in der der WebAssembly-Download ein K.-o.-Kriterium ist, oder eine PWA, die vollständig offline gegen eine Drittanbieter-API laufen muss.

Dieser Beitrag zielt auf .NET 11 (zum Zeitpunkt des Schreibens als Preview, GA geplant für November 2026) und das Paket-Set `Microsoft.AspNetCore.Components` 11.0.x. Die Projekt-Templates stammen aus `Microsoft.AspNetCore.Components.WebAssembly.Templates` und dem mit dem .NET-11-SDK ausgelieferten Template `dotnet new blazor`. Wo das Verhalten versionsübergreifend wichtig ist, weise ich inline auf die Unterschiede zwischen .NET 8, .NET 9, .NET 10 und .NET 11 hin.

## Was "Blazor United" in .NET 11 tatsächlich ist

"Blazor United" ist kein eigenes Hosting-Modell. Es war der Arbeitsname, den Microsoft im Preview-Zyklus von .NET 8 für das verwendet hat, was als **Blazor Web App**-Template veröffentlicht wurde. Das Template kombiniert vier Render-Modi in einem Projekt:

- **Static Server (SSR)**: HTML auf dem Server gerendert, keine Interaktivität, kein SignalR-Circuit, kein WebAssembly-Download. Lädt wie eine Razor Page.
- **Interactive Server**: HTML auf dem Server gerendert, DOM-Updates werden über einen SignalR-Circuit übertragen. Das klassische Blazor-Server-Modell.
- **Interactive WebAssembly**: Die Komponente läuft im Browser auf einer WebAssembly-Laufzeit. Das klassische Blazor-WebAssembly-Modell.
- **Interactive Auto**: Rendert auf Server, während der Nutzer wartet, dass das WebAssembly-Bundle im Hintergrund heruntergeladen wird, und übergibt dann bei der nächsten Navigation transparent an WebAssembly. Pro-Komponente-Fallback, falls WebAssembly nicht lädt.

Sie deklarieren den Modus pro Komponente mit `@rendermode InteractiveServer`, `@rendermode InteractiveWebAssembly` oder `@rendermode InteractiveAuto`. Dieselbe `.razor`-Datei kann in jedem dieser Modi laufen, solange sie keine modusspezifischen APIs aufruft (mehr dazu unten).

Blazor Server (das eigenständige Template, `dotnet new blazorserver`) und Blazor WebAssembly (`dotnet new blazorwasm`) existieren in .NET 11 weiter, aber Microsofts Empfehlung seit .NET 8 lautet: Bevorzugen Sie das vereinheitlichte Blazor-Web-App-Template, sofern Sie keinen konkreten Grund dagegen haben.

## Die Feature-Matrix

| Funktion                                  | Blazor Server (eigenständig)             | Blazor WebAssembly (eigenständig)            | Blazor Web App / United (.NET 11)            |
| ----------------------------------------- | ---------------------------------------- | -------------------------------------------- | -------------------------------------------- |
| Rendering-Ort                             | Server                                   | Browser                                      | pro Komponente (Static, Server, WASM, Auto)  |
| Initiales Payload (kalter Cache)          | ~50-80 KB HTML                           | ~1,4 MB WASM + Assemblies (R2R, .NET 11)     | ~50-80 KB HTML, WASM lädt nach Bedarf        |
| First Contentful Paint (LAN)              | ~80-150 ms                               | ~600-900 ms                                  | ~80-150 ms (Static / Server) ~600-900 ms (WASM-first) |
| Zeit bis interaktiv nach FCP              | zehn ms (WebSocket öffnen)               | hunderte ms (WASM-Boot)                      | hängt vom Render-Modus der Seite ab          |
| Persistenter WebSocket erforderlich       | ja (SignalR)                             | nein                                         | nur für Interactive-Server-Komponenten       |
| Funktioniert offline                      | nein                                     | ja (mit Service Worker)                      | ja für WebAssembly-Komponenten, nein für Server |
| Direkter Zugriff auf Datenbank / Dateien / Secrets | ja (Serverprozess)              | nein (Browser-Sandbox)                       | ja in Server-Komponenten, nein in WASM-Komponenten |
| .NET-API-Oberfläche                       | volle Server-Laufzeit                    | reduzierter, browserfähiger Teilbereich      | beide, je nach Komponente                    |
| Debugging-Erfahrung                       | F5 in Visual Studio / Rider              | Chrome-DevTools + VS-WebAssembly-Debugger    | beide                                        |
| Skalierungsgrenze pro Server              | begrenzt durch offene Circuits (~5k pro Knoten) | unbegrenzt (statische Dateien + API)  | nur für Interactive-Server-Seiten begrenzt   |
| Native-AOT-Unterstützung                  | nein (Server bleibt JIT)                 | teilweise via WASM AOT                       | pro Render-Modus                             |
| Authentifizierungsmodell                  | Cookie + Circuit                         | OIDC / Token im Browser                      | Cookie für SSR/Server, Token für WASM        |
| Status in .NET 11                         | unterstützt, nicht der empfohlene Standard | unterstützt, nicht der empfohlene Standard | empfohlener Standard                         |

Die Zeile, die das Gespräch für die meisten neuen Apps beendet, ist die letzte. Microsofts eigene Templates, Dokumentationsbeispiele und Tutorials beginnen mit dem Blazor-Web-App-Template. Nur Server oder nur WebAssembly 2026 zu wählen ist heute eine explizite Abweichung, die begründet werden muss.

## Wann Blazor Server (eigenständig) wählen

Das eigenständige Blazor-Server-Template ist weiterhin die richtige Wahl, wenn Sie eine dieser Einschränkungen haben:

- **Interne LAN-Anwendung, feste Nutzerzahl, WebAssembly-Downloads verboten.** Außendiensttools, Fertigungs-Dashboards, Bildschirme auf Krankenhausstationen. Ein 1,4-MB-WebAssembly-Download über instabiles Kiosk-WLAN ist eine schlechtere Nutzererfahrung als eine SignalR-Reconnect. Mit .NET 11 ist das eigenständige Server-Template außerdem das schlankste Container-Image, weil es die WASM-Laufzeit nie in Ihre Publish-Ausgabe kopiert.
- **Sie müssen aus der Komponente heraus einen SQL Server mit Windows-Authentifizierung oder einen Kerberos-geschützten Dienst aufrufen.** Die Komponente läuft im Serverprozess und kann daher die integrierten Anmeldeinformationen der App-Pool-Identität verwenden. Für WebAssembly gibt es keine Entsprechung ohne serverseitigen Proxy.
- **Das Team hat keine Front-End-Leute und wird auch keine bekommen.** Server-Rendering mit einem SignalR-Circuit versteckt fast alle Browser-Themen. Der Zustand lebt auf dem Server, Sie debuggen mit den üblichen .NET-Werkzeugen, und es gibt keine zweite Build-Pipeline für das WASM-Bundle.

Eine minimale Blazor-Server-`Program.cs` in .NET 11:

```csharp
// .NET 11, C# 14, Microsoft.AspNetCore.Components.Server 11.0.x
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents();

var app = builder.Build();

app.UseStaticFiles();
app.UseAntiforgery();

app.MapRazorComponents<App>()
    .AddInteractiveServerRenderMode();

app.Run();
```

Beachten Sie: `AddRazorComponents()` plus `AddInteractiveServerComponents()` ist die API ab .NET 8. Das alte `AddServerSideBlazor()` funktioniert noch, läuft aber über eine Kompatibilitätsschicht und aktiviert nicht die neue Render-Modus-Infrastruktur. Verwenden Sie die neuen APIs in jedem Greenfield-Projekt.

## Wann Blazor WebAssembly (eigenständig) wählen

Greifen Sie zum eigenständigen WebAssembly-Template, wenn:

- **Die App offline funktionieren muss.** Eine PWA, die an Servicetechniker im Feld ausgeliefert wird, eine Tablet-App für Mitarbeitende im Laden, alles, was mit einem Backend hinter einer instabilen Verbindung spricht. Kombinieren Sie einen Service Worker mit lokalem Speicher (`IndexedDB` über `Microsoft.JSInterop`), und die App überlebt einen vollständigen Netzausfall.
- **Sie auf einem CDN oder Static-Host ohne .NET-Laufzeit bereitstellen.** Blazor WebAssembly ist nur `wwwroot/` plus ein `_framework/`-Ordner. Legen Sie es auf Cloudflare Pages, GitHub Pages, Azure Static Web Apps oder einem beliebigen S3-Bucket hinter CloudFront ab. Sie zahlen keine Compute. Das Blazor-Web-App-Template dagegen benötigt einen ASP.NET-Core-Host für die Server- und SSR-Seiten.
- **Das Backend eine Drittanbieter-API ist, die Ihnen nicht gehört.** Wenn Ihr Datenspeicher Stripe, Auth0 oder eine öffentliche REST-API ist, gibt es keine Server-Logik zu hosten. Das eigenständige WASM-Template plus ein OIDC-PKCE-Flow ergibt eine vollständig clientseitige App ohne eigene Infrastruktur.
- **Sie das Front-End als Teil einer MAUI-Hybrid- oder Electron-App ausliefern wollen.** Sowohl `BlazorWebView` als auch das .NET-MAUI-Hybrid-Template erwarten einen Komponentengraphen im Stil eines eigenständigen WebAssembly. Ein Blazor-Web-App-Projekt dort einzubetten bringt nichts.

Eine minimale Blazor-WebAssembly-`Program.cs` in .NET 11:

```csharp
// .NET 11, C# 14, Microsoft.AspNetCore.Components.WebAssembly 11.0.x
using Microsoft.AspNetCore.Components.Web;
using Microsoft.AspNetCore.Components.WebAssembly.Hosting;

var builder = WebAssemblyHostBuilder.CreateDefault(args);
builder.RootComponents.Add<App>("#app");
builder.RootComponents.Add<HeadOutlet>("head::after");

builder.Services.AddScoped(sp => new HttpClient
{
    BaseAddress = new Uri(builder.HostEnvironment.BaseAddress)
});

await builder.Build().RunAsync();
```

In .NET 11 hat die WebAssembly-Laufzeit für neue Projekte Multithreading standardmäßig aktiviert, sobald Sie `<WasmEnableThreads>true</WasmEnableThreads>` in der `.csproj` setzen. Damit entfällt einer der größten Gründe, Blazor WebAssembly abzulehnen: CPU-gebundene Arbeit blockiert den UI-Thread nicht mehr.

## Wann Blazor Web App (das United-Modell) wählen

Für alles andere. Das vereinheitlichte Template liefert ein einziges Projekt, in dem:

- Die Landing Page `@rendermode StaticServer` ist und in unter 100 ms ganz ohne JavaScript lädt. Für einen Crawler ist sie nicht von einer Razor Page zu unterscheiden.
- Das Dashboard `@rendermode InteractiveServer` ist, weil es direkt mit einem `DbContext` spricht und Sie diese Abfragen nicht über eine API offenlegen wollen.
- Der Bild-Annotator `@rendermode InteractiveWebAssembly` ist, weil er ein ONNX-Modell im Browser über `Microsoft.ML.OnnxRuntime` ausführt.
- Die geteilten Shell-Komponenten `@rendermode InteractiveAuto` sind: Sie rendern beim ersten Paint unter Server und übergeben dann an WebAssembly, sobald das Bundle fertig heruntergeladen ist, so dass nachfolgende Navigationen sofort sind und einen Server-Neustart überleben.

Diese Komponierbarkeit erreicht nichts anderes. Sie haben nicht mehr eine binäre "Server-App oder WASM-App"-Entscheidung, sondern eine Entscheidung pro Seite, ganz wie Next.js Ihnen erlaubt, `ssr`, `static` und `client` zu mischen. Eine minimale Blazor-Web-App-`Program.cs` in .NET 11:

```csharp
// .NET 11, C# 14, Microsoft.AspNetCore.Components.Server 11.0.x +
// Microsoft.AspNetCore.Components.WebAssembly.Server 11.0.x
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents()
    .AddInteractiveWebAssemblyComponents();

var app = builder.Build();

app.UseStaticFiles();
app.UseAntiforgery();

app.MapRazorComponents<App>()
    .AddInteractiveServerRenderMode()
    .AddInteractiveWebAssemblyRenderMode()
    .AddAdditionalAssemblies(typeof(BlazorApp.Client._Imports).Assembly);

app.Run();
```

Das mit dem Template gelieferte `.Client`-Projekt ist der Ort für Komponenten, die in WebAssembly laufen müssen. Reine Server-Komponenten bleiben im Host-Projekt. Interactive-Auto-Komponenten leben in `.Client` (weil sie auch von der WebAssembly-Seite erreichbar sein müssen).

## Die Daten zu Kaltstart und Bundle-Größe

Die Zahlen unten stammen aus jeweils frischen `dotnet new blazor`, `dotnet new blazorserver` und `dotnet new blazorwasm` auf .NET-11-SDK `11.0.100-preview.4.26152.6`, mit `dotnet publish -c Release` veröffentlicht und von `dotnet run` bereitgestellt. Gemessen mit Chrome 137 auf einem MacBook Pro M2, kaltem Cache, mit Drosselung "Fast 3G" in den DevTools.

| Metrik                                       | Blazor Server | Blazor WebAssembly | Blazor Web App (Auto-Landing) |
| -------------------------------------------- | ------------- | ------------------ | ----------------------------- |
| Initial übertragenes HTML                    | 8 KB          | 4 KB               | 8 KB                          |
| Übertragene WebAssembly + Assemblies         | 0             | 1,42 MB (gzip)     | 1,42 MB (gzip, nach Bedarf)   |
| Zeit bis First Contentful Paint              | 320 ms        | 1850 ms            | 340 ms                        |
| Zeit bis interaktiv (Counter-Button)         | 410 ms        | 2300 ms            | 440 ms (Server) / 2400 ms (Übergabe an WASM) |
| Speicher nach erster Navigation              | 7 MB Browser  | 38 MB Browser      | 9 MB, dann 41 MB nach der Übergabe |

Die Blazor Web App im Auto-Modus schlägt eigenständiges WebAssembly beim First Paint um Faktor fünf, weil sie nicht auf das Bundle wartet. Sie schlägt nicht den eigenständigen Server, weil sobald das WebAssembly-Bundle fertig geladen ist, ohnehin Speicher anfällt. Der Punkt ist nicht, dass Auto in einer Metrik am schnellsten ist. Der Punkt ist, dass Auto nie das langsamste ist.

Für einen tieferen Blick darauf, wie das .NET-11-SDK das WASM-Bundle trimmt, siehe [das neue Blazor-WebWorker-Template aus .NET 11](/2026/04/dotnet-11-preview-2-blazor-webworker-template/), das dieselben Trimmer-Einstellungen verwendet.

## Der Stolperstein, der für Sie entscheidet

Drei Dinge erzwingen die Entscheidung unabhängig von Präferenz:

1. **Sie können keine `DbContext`-Injektion in eine WebAssembly-Komponente legen.** Ebenso wenig einen `IConfiguration`-Wert, der ein Secret enthält. Auch keinen Blob-Client, der einen Connection-String nutzt. Der Browser ist designbedingt eine feindliche Umgebung. Wenn Ihre Komponente die Datenbank direkt lesen muss, muss sie Server sein (oder Sie brauchen eine Backend-API, die die WASM-Komponente aufruft). Das Blazor-Web-App-Template macht das früh klar: Legen Sie `@inject ApplicationDbContext Db` in eine `.Client`-Komponente, und der Build schlägt mit einem klaren Fehler zu fehlender Dependency Injection fehl.

2. **Sie können `@rendermode` nicht innerhalb einer Render-Modus-Grenze umschalten.** Eine als Static Server gerenderte Seite kann eine Interactive-Server-Insel hosten, eine Interactive-Server-Seite kann Interactive-WebAssembly-Inseln hosten, aber Sie können Interaktivität nicht in Interaktivität verschachteln. In der Praxis heißt das: Wählen Sie den niedrigsten Render-Modus, der für die Seite reicht, und eskalieren Sie nur auf Insel-Ebene.

3. **HTTPS, Antiforgery und der Authentifizierungszustand laufen standardmäßig über Cookies.** WebAssembly-Komponenten sehen diese Cookies bei Cross-Origin-Anfragen nicht. Wenn der WebAssembly-Teil einer Blazor Web App eine externe API aufruft, brauchen Sie obendrauf einen OIDC-Token-Flow, nicht nur das Host-Cookie. Das ist die häufigste Stolperfalle bei der Migration einer Blazor-Server-App auf das Web-App-Template.

Speziell zur Antiforgery-Perspektive behandeln [das TempData-Verhalten in Blazor SSR unter .NET 11](/2026/04/blazor-ssr-tempdata-dotnet-11/) und der [Leitfaden zu geteilter Validierungslogik](/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) die praktischen Muster.

## Empfehlung, neu formuliert

Für ein neues Blazor-Projekt auf .NET 11 im Jahr 2026 starten Sie mit `dotnet new blazor` (dem Blazor-Web-App-Template) und vergeben Render-Modi pro Seite. Die Kosten, für eine Marketing-Seite auf `@rendermode StaticServer` herunter- oder für eine offline-fähige Komponente auf `@rendermode InteractiveWebAssembly` hochzugehen, sind nahezu null verglichen mit den Kosten, das falsche eigenständige Template zu wählen und später umzuschreiben. Wählen Sie `dotnet new blazorserver` nur, wenn Sie ein hartes Verbot von WebAssembly-Downloads haben. Wählen Sie `dotnet new blazorwasm` nur, wenn Ihr Deployment-Ziel keine .NET-Laufzeit hat oder Sie das Front-End in MAUI Hybrid oder Electron einbetten.

Wenn Sie heute schon auf Blazor Server sind und eine Migration abwägen, ist das Ziel fast immer das Blazor-Web-App-Template, mit den meisten Ihrer bestehenden Seiten auf `@rendermode InteractiveServer`. Das ist die risikoärmste Migration: Das Verhalten bleibt für die migrierten Seiten identisch, und Sie schalten die Möglichkeit frei, Static-Server- und Auto-Komponenten inkrementell hinzuzufügen.

## Verwandt

- [Minimal APIs vs Controllers in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) für die Backend-API-Entscheidungen, die eine Blazor Web App eröffnet.
- [Tailwind CSS mit Blazor WebAssembly in .NET 11 nutzen](/2026/05/how-to-use-tailwind-css-with-blazor-webassembly-in-dotnet-11/) für die Unterschiede der Style-Pipeline zwischen eigenständigem WASM und dem Blazor-Web-App-Template.
- [Validierungslogik zwischen Server und Blazor WebAssembly teilen](/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) für das praktische "Shared-Project"-Muster, das das Web-App-Template formalisiert.
- [Native AOT vs ReadyToRun vs JIT in .NET 11](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) für die Kompilierungsmodus-Trade-offs, die Server und WASM betreffen.
- [Blazor `Virtualize` mit variabler Höhe in .NET 11 Preview 3](/2026/04/blazor-virtualize-variable-height-dotnet-11-preview-3/) für eine der neuen APIs, von denen Komponentenlisten im Auto-Modus profitieren.

## Quellen

- [ASP.NET Core Blazor render modes](https://learn.microsoft.com/aspnet/core/blazor/components/render-modes), Microsoft Learn, abgerufen am 2026-05-26.
- [What's new in ASP.NET Core in .NET 8](https://learn.microsoft.com/aspnet/core/release-notes/aspnetcore-8.0) für die erste Auslieferung des vereinheitlichten Templates (damals in den Previews "Blazor United" genannt).
- [What's new in ASP.NET Core for .NET 11](https://learn.microsoft.com/aspnet/core/release-notes/aspnetcore-11.0) für die Verbesserungen pro Render-Modus.
- [ASP.NET Core Blazor WebAssembly with multithreading](https://learn.microsoft.com/aspnet/core/blazor/performance#webassembly-multithreading) für das Flag `WasmEnableThreads`.
- [`dotnet/aspnetcore` discussion 51020](https://github.com/dotnet/aspnetcore/discussions/51020), in der Microsoft-Engineers erklärten, warum aus "United" im GA-Template-Namen "Web App" wurde.
