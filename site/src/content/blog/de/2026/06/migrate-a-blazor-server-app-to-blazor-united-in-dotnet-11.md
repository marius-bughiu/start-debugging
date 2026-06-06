---
title: "Eine Blazor-Server-App in .NET 11 zu Blazor United (Blazor Web App) migrieren"
description: "Eine Schritt-für-Schritt-Checkliste, um eine eigenständige Blazor-Server-App auf das vereinheitlichte Blazor-Web-App-Template in .NET 11 zu verschieben und jede Seite ohne Verhaltensänderung auf InteractiveServer zu halten."
pubDate: 2026-06-05
updatedDate: 2026-06-05
template: migration
tags:
  - "migration"
  - "blazor"
  - "dotnet"
  - "aspnetcore"
  - "csharp"
lang: "de"
translationOf: "2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-06-05
---

Wenn Sie eine eigenständige Blazor-Server-App (`dotnet new blazorserver`) haben und sie auf das vereinheitlichte Template verschieben möchten, das während des Preview-Zyklus von .NET 8 den Spitznamen "Blazor United" trug und als **Blazor Web App** veröffentlicht wurde, ist die Migration größtenteils mechanisch und dauert in der Regel einen halben Tag für eine kleine App, ein bis drei Tage für eine große. Am Code Ihrer Komponenten muss sich nichts ändern. Was sich ändert, ist der Host: `_Host.cshtml` verschwindet, das Routing wandert in eine `Routes`-Komponente, `Program.cs` tauscht `MapBlazorHub` gegen `MapRazorComponents`, und Sie deklarieren einen Render Mode explizit. Halten Sie jede Seite auf `@rendermode InteractiveServer`, und das Verhalten bleibt identisch zu Blazor Server der .NET-7-Ära. Das Einzige, was beißt, ist die doppelte Ausführung des Prerenderings. Dieser Leitfaden zielt auf **.NET 11** (zum Zeitpunkt des Schreibens Preview, GA geplant für November 2026) und den Paketsatz `Microsoft.AspNetCore.Components` 11.0.x ab.

## Warum das eigenständige Server-Template verlassen

Das eigenständige `blazorserver`-Template funktioniert in .NET 11 weiterhin, dies ist also keine erzwungene Migration. Führen Sie sie durch, wenn eines davon ein echtes Ergebnis ist, das Sie wollen, nicht vorher:

- **Render Modes pro Seite.** Im Web-App-Template können Sie eine Marketing-Seite auf `@rendermode StaticServer` setzen (kein SignalR-Circuit, kein JavaScript, indiziert wie eine Razor Page), während Sie das Dashboard auf `InteractiveServer` halten. Im eigenständigen Template können Sie Modi überhaupt nicht mischen.
- **Ein Weg zu WebAssembly und Auto ohne Neuschreiben.** Ein später hinzugefügtes offlinefähiges Widget bedeutet, ein `.Client`-Projekt und ein `@rendermode InteractiveWebAssembly` hinzuzufügen, nicht die gesamte App zu portieren.
- **Sie sind auf dem von Microsoft empfohlenen Standard.** Templates, Doku-Beispiele und neue Tutorials führen seit .NET 8 mit dem Blazor-Web-App-Template. Beim eigenständigen Server zu bleiben ist nun eine Abweichung, die Sie im Code-Review rechtfertigen müssen.
- **Widerstandsfähiger Circuit-Zustand in .NET 10+.** Das Web-App-Template zusammen mit dem `[PersistentState]`-Attribut kann den Komponentenzustand wiederherstellen, wenn ein abgebrochener SignalR-Circuit sich wieder verbindet, etwas, das das alte `ServerPrerendered`-Modell nie sauber geschafft hat.

Falls nichts davon zutrifft, ist eine `<TargetFramework>net11.0</TargetFramework>`-Änderung an Ihrer bestehenden eigenständigen Server-App eine gültige Alternative und nicht diese Migration.

## Was bricht

| Bereich                    | Änderung                                                                                      | Schweregrad |
| -------------------------- | ------------------------------------------------------------------------------------------- | -------- |
| Host-Seite                 | `Pages/_Host.cshtml` und `_Layout.cshtml` werden durch eine Root-Host-Komponente `App.razor` ersetzt | high     |
| Routing                    | `<Router>` wandert aus `App.razor` in ein neues `Routes.razor`                                | high     |
| Start in `Program.cs`      | `AddServerSideBlazor()` + `MapBlazorHub()` + `MapFallbackToPage("/_Host")` ersetzt durch `AddRazorComponents().AddInteractiveServerComponents()` + `MapRazorComponents<App>().AddInteractiveServerRenderMode()` | high     |
| Render Mode                | Interaktivität ist Opt-in pro Komponente oder global; kein implizites "die ganze App ist interaktiv" | high     |
| Prerendering               | `OnInitialized`/`OnInitializedAsync` laufen standardmäßig zweimal (Prerender-Durchlauf + interaktiver Durchlauf) | medium   |
| Client-Skript              | `_framework/blazor.server.js` wird zu `_framework/blazor.web.js`                             | medium   |
| Auth-Verdrahtung           | Die Komponente `CascadingAuthenticationState` wird durch `AddCascadingAuthenticationState()` in der DI ersetzt | medium   |
| `HttpContext`-Zugriff      | `HttpContext` ist nur während des statischen SSR verfügbar, nicht innerhalb einer interaktiven Komponente | medium   |
| `App.razor`-Semantik       | `App.razor` ist nicht mehr der Router; es ist die Hülle des HTML-Dokuments                   | low      |

## Checkliste vor dem Start

- Installieren Sie das **.NET 11 SDK** (`dotnet --version` meldet `11.0.1xx`). Bestätigen Sie mit `dotnet --list-sdks`.
- Committen Sie einen sauberen Checkpoint und **erstellen Sie einen Branch**. Diese Migration löscht Dateien; Sie wollen einen einfachen Weg zurück.
- Notieren Sie Ihren aktuellen Einstiegspunkt. Eigenständiges Blazor Server verwendet entweder `_Host.cshtml` (das übliche Layout vor .NET 8) oder bereits einen `App.razor`-Host. Die folgenden Schritte gehen von `_Host.cshtml` aus.
- Inventarisieren Sie jede `OnInitializedAsync` mit Seiteneffekten (Schreibvorgänge, Analytics-Ereignisse, einmalige Fetches). Das sind die Methoden, die das Prerendering zweimal ausführen wird. Sie kehren in Schritt 7 zu jeder zurück.
- Aktualisieren Sie Ihr CI auf ein .NET 11 SDK-Image und bestätigen Sie, dass ein Referenz-`dotnet build` und ein `dotnet test` mit dem aktuellen Code bestehen, bevor Sie irgendetwas anfassen.
- Erzeugen Sie eine wegwerfbare Referenz-App mit `dotnet new blazor --interactivity Server -o _ref`, damit Sie ein bekannt gutes `App.razor`, `Routes.razor` und `Program.cs` haben, von dem Sie die Struktur kopieren können.

## Migrationsschritte

### 1. Target Framework und Pakete anheben

Bearbeiten Sie die `.csproj`. Das SDK bleibt `Microsoft.NET.Sdk.Web`.

```xml
<!-- .NET 11 -->
<PropertyGroup>
  <TargetFramework>net11.0</TargetFramework>
  <Nullable>enable</Nullable>
  <ImplicitUsings>enable</ImplicitUsings>
</PropertyGroup>
```

Heben Sie alle `Microsoft.AspNetCore.Components.*`-Paketreferenzen auf `11.0.x` an. Entfernen Sie `Microsoft.AspNetCore.Components.Web`, falls es explizit referenziert wird; es ist Teil der Framework-Referenz für Web-SDK-Projekte.

Prüfen: `dotnet restore` läuft durch und `dotnet build` scheitert nur mit Fehlern zur Host-Seite und `Program.cs` (an diesem Punkt erwartet), nicht mit Fehlern bei der Paketauflösung.

### 2. Die `App.razor`-Host-Komponente erstellen

Im eigenständigen Server-Template lebt das HTML-Dokument in `Pages/_Host.cshtml` und `Pages/_Layout.cshtml`. Verschieben Sie dieses Markup in ein neues Root-`App.razor` (löschen Sie zuerst den alten `App.razor`-Router oder benennen Sie ihn um). Der `<component>`-Tag-Helper, der die Root gebootet hat, wird zu `<Routes />`.

```razor
@* .NET 11 - App.razor is now the HTML document shell, not the router *@
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <base href="/" />
    <link rel="stylesheet" href="app.css" />
    <link rel="stylesheet" href="YourApp.styles.css" />
    <HeadOutlet />
</head>
<body>
    <Routes />
    <script src="_framework/blazor.web.js"></script>
</body>
</html>
```

Zwei leicht zu übersehende Änderungen: das Skript ist `blazor.web.js` (nicht `blazor.server.js`), und `<HeadOutlet />` zusammen mit `<Routes />` sind Komponenten, übernehmen also den Render Mode, den Sie ihnen in Schritt 6 zuweisen.

Prüfen: die Datei kompiliert als Razor-Komponente (keine `@page`-Direktive, kein `@model`).

### 3. Das Routing nach `Routes.razor` verschieben

Erstellen Sie `Routes.razor` im Projekt-Root und fügen Sie den `<Router>`-Block ein, der früher im alten `App.razor` lebte.

```razor
@* .NET 11 - Routes.razor holds the router that used to be in App.razor *@
<Router AppAssembly="@typeof(Program).Assembly">
    <Found Context="routeData">
        <RouteView RouteData="@routeData" DefaultLayout="@typeof(Layout.MainLayout)" />
        <FocusOnNavigate RouteData="@routeData" Selector="h1" />
    </Found>
    <NotFound>
        <PageTitle>Not found</PageTitle>
        <LayoutView Layout="@typeof(Layout.MainLayout)">
            <p role="alert">Sorry, there's nothing at this address.</p>
        </LayoutView>
    </NotFound>
</Router>
```

Prüfen: ein `dotnet build` beschwert sich nicht mehr über einen fehlenden `Routes`-Typ.

### 4. Render-Mode-Kurzformen in `_Imports.razor` aktivieren

Fügen Sie diese Zeile zu `_Imports.razor` hinzu, damit Sie `InteractiveServer` schreiben können, statt es vollständig zu qualifizieren:

```razor
@* .NET 11 *@
@using static Microsoft.AspNetCore.Components.Web.RenderMode
```

Prüfen: `@rendermode InteractiveServer` in einer Komponente löst sich ohne einen Using-Fehler auf.

### 5. `Program.cs` neu schreiben

Tauschen Sie die Blazor-Server-Registrierung und die Endpunkte gegen die Razor-Components-Entsprechungen.

```csharp
// .NET 11, C# 14 - Blazor Web App startup
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents();

// keep your existing app services here (DbContext, HttpClient, etc.)

var app = builder.Build();

if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Error", createScopeForErrors: true);
    app.UseHsts();
}

app.UseHttpsRedirection();
app.UseStaticFiles();
app.UseAntiforgery();

app.MapRazorComponents<App>()
    .AddInteractiveServerRenderMode();

app.Run();
```

Löschen Sie `AddServerSideBlazor()`, `app.MapBlazorHub()` und `app.MapFallbackToPage("/_Host")`. Der Aufruf `app.UseAntiforgery()` ist neu und erforderlich; das Web-App-Template aktiviert die Antiforgery-Middleware standardmäßig, und Formular-Posts scheitern ohne sie.

Prüfen: `dotnet build` läuft mit null Fehlern durch.

### 6. Die App interaktiv machen (globaler Render Mode)

Die risikoärmste Migration macht die gesamte App `InteractiveServer` und reproduziert das alte Verhalten exakt. Setzen Sie den Render Mode auf `<Routes />` und `<HeadOutlet />` innerhalb von `App.razor`:

```razor
@* .NET 11 - global InteractiveServer, matches standalone Blazor Server behaviour *@
<HeadOutlet @rendermode="InteractiveServer" />
...
<Routes @rendermode="InteractiveServer" />
```

Prüfen: führen Sie `dotnet run` aus, öffnen Sie die App und bestätigen Sie, dass interaktive Komponenten (Schaltflächen, `@onclick`, `EditForm`-Submits) funktionieren und der Browser einen offenen WebSocket zu `/_blazor` hält. Sobald das funktioniert, können Sie später einzelne Seiten auf `@rendermode StaticServer` herabstufen oder Inseln auf WebAssembly hochstufen, aber das ist Arbeit nach der Migration.

### 7. Die doppelte Ausführung des Prerenderings behandeln

Dies ist die eine Verhaltensänderung, die Leute überrascht. Mit einem interaktiven Render Mode prerendert Blazor zuerst statisches HTML, rendert dann erneut über den Live-Circuit, daher laufen `OnInitialized` und `OnInitializedAsync` zweimal. Der alte Standard des eigenständigen Servers (`render-mode="ServerPrerendered"`) hatte dieselbe Eigenschaft, aber viele Apps verwendeten `render-mode="Server"` und sahen es nie.

Sie haben drei Optionen. Die sauberste in .NET 11 ist das deklarative `[PersistentState]`-Attribut (in .NET 10 hinzugefügt): einmal während des Prerenders abrufen, in das HTML serialisieren, im interaktiven Durchlauf wiederherstellen.

```csharp
// .NET 11 - fetch once, survive the prerender-to-interactive handoff
public partial class Dashboard : ComponentBase
{
    [PersistentState]
    public List<Order>? Orders { get; set; }

    [Inject] public required IOrderService OrderService { get; init; }

    protected override async Task OnInitializedAsync()
    {
        // Orders is non-null on the interactive pass: state was restored,
        // so the service is not hit a second time.
        Orders ??= await OrderService.GetRecentAsync();
    }
}
```

Wenn Sie während des Prerenders überhaupt nicht abrufen wollen, deaktivieren Sie das Prerendering für diese Grenze:

```razor
@* .NET 11 - skip the prerender pass entirely for this component tree *@
<Routes @rendermode="new InteractiveServerRenderMode(prerender: false)" />
```

Prüfen: setzen Sie einen Breakpoint oder eine Log-Zeile in jede `OnInitializedAsync` mit Seiteneffekten und bestätigen Sie, dass sie einmal pro echter Navigation läuft, nicht zweimal.

### 8. Authentifizierung und Autorisierung neu verdrahten

Falls Ihre App `<CascadingAuthenticationState>` um den Router gewickelt hatte, entfernen Sie diese Komponente und registrieren Sie sie stattdessen in der DI, dann tauschen Sie `RouteView` gegen `AuthorizeRouteView` in `Routes.razor`.

```csharp
// .NET 11 - Program.cs
builder.Services.AddCascadingAuthenticationState();
```

```razor
@* .NET 11 - Routes.razor, authorized routing *@
<AuthorizeRouteView RouteData="@routeData" DefaultLayout="@typeof(Layout.MainLayout)" />
```

Prüfen: rufen Sie eine `[Authorize]`-Seite im abgemeldeten Zustand auf und bestätigen Sie, dass Sie umgeleitet werden, dann melden Sie sich an und bestätigen Sie den Zugriff.

### 9. Die toten Host-Dateien löschen

Entfernen Sie `Pages/_Host.cshtml`, `Pages/_Layout.cshtml` und jeden `app.MapRazorPages()`-Aufruf, der nur existierte, um `_Host` zu bedienen. Entfernen Sie `AddRazorPages()` aus `Program.cs`, falls nichts anderes Razor Pages verwendet.

Prüfen: `dotnet build` ist sauber und die App bedient weiterhin jede Route.

## Verifizierung: der Smoke-Test nach der Migration

Führen Sie all dies aus, bevor Sie mergen:

- `dotnet build -c Release` meldet null Warnungen im Zusammenhang mit Render Modes.
- `dotnet test` besteht mit derselben Anzahl wie Ihre Referenz vor der Migration.
- Die App startet mit `dotnet run` und die Startseite rendert.
- Ein interaktives Steuerelement (`@onclick`, `EditForm`) funktioniert und der Browser hält einen offenen `/_blazor`-WebSocket.
- Eine Seitennavigation löst einen Seiteneffekt nicht doppelt aus (die Prüfung aus Schritt 7, durchgehend wiederholt).
- Eine mit `[Authorize]` geschützte Route leitet im abgemeldeten Zustand um.
- Ein Formular-POST gelingt (dies ist die Antiforgery-Middleware-Prüfung aus Schritt 5).
- Quelltext einer Seite ansehen: das Markup ist prerendertes HTML, kein leeres `<div id="app">`.

## Rollback-Plan

Diese Migration ist nur dann reversibel, wenn Sie den Branch aus dem Schritt vor dem Start behalten haben. Sobald Sie `_Host.cshtml` löschen und `Program.cs` neu schreiben, gibt es keinen In-Place-Schalter zurück zum eigenständigen Server-Modell. Rollen Sie zurück, indem Sie den Commit vor der Migration auschecken, nicht indem Sie vorwärts editieren. Da die Änderung strukturell und keine Datenmigration ist, gibt es nichts in Ihrer Datenbank oder Ihrem Speicher rückgängig zu machen. Branch erstellen, die Arbeit erledigen, gegen den Smoke-Test verifizieren und erst mergen, wenn es grün ist.

## Stolpersteine, auf die wir gestoßen sind

- **`app.UseAntiforgery()` vergessen.** Das Web-App-Template benötigt die Antiforgery-Middleware. Ohne den Aufruf gibt jeder `EditForm`-POST ein 400 mit `Antiforgery token validation failed` zurück. Das eigenständige Server-Template brauchte dies nicht, weil die Formularbehandlung über den SignalR-Circuit lief, nicht über HTTP-POST.
- **`HttpContext` ist null innerhalb interaktiver Komponenten.** Im eigenständigen Server konnten Sie manchmal `IHttpContextAccessor` aus einer Komponente erreichen. Unter dem Web-App-Template existiert `HttpContext` nur während des statischen SSR-Durchlaufs. Lesen Sie, was Sie brauchen (Header, Cookies, den authentifizierten Benutzer), während des Prerenders und reichen Sie es nach unten, oder verwenden Sie den kaskadierenden `AuthenticationState`.
- **`blazor.server.js` im Markup belassen.** Wenn Sie den alten Skript-Tag aus `_Host.cshtml` wörtlich kopieren, lädt die Seite, aber kein Circuit öffnet sich und nichts ist interaktiv. Es muss `_framework/blazor.web.js` sein.
- **Scoped Services verhalten sich über die Prerender-Grenze hinweg anders.** Ein Service, der während des Prerenders und erneut während des interaktiven Durchlaufs aufgelöst wird, sind zwei verschiedene Scopes. Wenn Sie pro-Request-Zustand in einem Scoped Service zwischengespeichert haben in der Erwartung, dass er überlebt, wird er es nicht. Dies ist dieselbe Klasse von Problemen, die in [Scoped Service kann nicht aus einem Singleton konsumiert werden](/de/2026/05/fix-cannot-consume-scoped-service-from-singleton/) behandelt wird.
- **Statische Assets mit 404 nach der Verschiebung.** Das Web-App-Template bedient komponentenbezogenes CSS als `YourApp.styles.css`. Wenn Ihr altes `_Layout.cshtml` ein anders benanntes Bundle referenzierte, bricht der Link still. Prüfen Sie die `<link>`-Hrefs im neuen `App.razor`.

Das Ziel hier ist fast immer "jede Seite auf `InteractiveServer`, Prerendering behandelt". Das ist die Migration, die nichts ändert, was der Benutzer sehen kann. Static-Server-Seiten, WebAssembly-Inseln und Auto-Komponenten hinzuzufügen ist die Belohnung, die Sie danach einsammeln, eine Komponente nach der anderen, ohne weitere strukturelle Umwälzung.

## Verwandt

- [Blazor Server vs Blazor WebAssembly vs Blazor United in .NET 11: was Sie wählen sollten](/de/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) für die Entscheidung hinter dem Ziel-Template.
- [Wie man Validierungslogik zwischen Server und Blazor WebAssembly teilt](/de/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) für das Shared-Project-Muster, das Sie wollen werden, sobald Sie WASM-Komponenten hinzufügen.
- [Blazor SSR bekommt endlich TempData in .NET 11](/de/2026/04/blazor-ssr-tempdata-dotnet-11/) für die Post-Redirect-Get-Flows auf den statischen SSR-Seiten, die Sie nun hinzufügen können.
- [Lösung: Scoped Service kann nicht aus einem Singleton konsumiert werden](/de/2026/05/fix-cannot-consume-scoped-service-from-singleton/) für die Scope-Lebensdauer-Probleme, die die Prerender-Grenze offenlegt.
- [Von .NET Framework 4.8 zu .NET 11 in 2026 migrieren](/de/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/), falls dieser Blazor-Umzug Teil eines größeren Framework-Sprungs ist.

## Quellen

- [ASP.NET Core Blazor render modes](https://learn.microsoft.com/aspnet/core/blazor/components/render-modes), Microsoft Learn, abgerufen am 2026-06-05.
- [ASP.NET Core Blazor prerendered state persistence](https://learn.microsoft.com/aspnet/core/blazor/state-management/prerendered-state-persistence), Microsoft Learn, für das in .NET 10 hinzugefügte `[PersistentState]`-Attribut.
- [Migrate from ASP.NET Core in .NET 7 to .NET 8](https://learn.microsoft.com/aspnet/core/migration/70-to-80), Microsoft Learn, für die ursprünglichen Schritte zur Host-Umstrukturierung von Blazor Server zu Web App.
- [ASP.NET Core Razor component lifecycle](https://learn.microsoft.com/aspnet/core/blazor/components/lifecycle), Microsoft Learn, für das Verhalten der doppelten Prerender-Ausführung.
</content>
