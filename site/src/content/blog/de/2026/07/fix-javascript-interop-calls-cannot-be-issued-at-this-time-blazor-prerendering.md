---
title: "Lösung: JavaScript interop calls cannot be issued at this time (Blazor-Prerendering)"
description: "Prerendering führt die Komponente ohne Browser auf dem Server aus, deshalb wirft IJSRuntime. Verschieben Sie den Aufruf nach OnAfterRenderAsync, prüfen Sie RendererInfo.IsInteractive oder deaktivieren Sie das Prerendering."
pubDate: 2026-07-30
template: error-page
tags:
  - "errors"
  - "blazor"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
lang: "de"
translationOf: "2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering"
translatedBy: "claude"
translationDate: 2026-07-30
---

Die Lösung: Sie haben `IJSRuntime` aus `OnInitialized`, `OnInitializedAsync`, `OnParametersSet{Async}` oder einem Komponentenkonstruktor aufgerufen, und dieser Code lief während des Prerenderings, wenn kein Browser angebunden ist, der JavaScript ausführen könnte. Verschieben Sie den Aufruf nach `OnAfterRenderAsync(bool firstRender)`, abgesichert durch `if (firstRender)`, denn diese Methode läuft während des Prerenderings nie. Wenn Sie früher als beim ersten interaktiven Rendering verzweigen müssen, prüfen Sie `RendererInfo.IsInteractive` (.NET 9 und höher). Wenn die Komponente ohne JavaScript wirklich nicht funktioniert, schalten Sie das Prerendering für sie mit `@rendermode @(new InteractiveServerRenderMode(prerender: false))` ab.

```text
System.InvalidOperationException: JavaScript interop calls cannot be issued at this time.
This is because the component is being statically rendered. When prerendering is enabled,
JavaScript interop calls can only be performed during the OnAfterRenderAsync lifecycle method.
   at Microsoft.AspNetCore.Components.Server.Circuits.RemoteJSRuntime.BeginInvokeJS(...)
   at Microsoft.JSInterop.JSRuntime.InvokeAsync[TValue](String identifier, Object[] args)
   at BlazorSample.Components.Pages.Theme.OnInitializedAsync()
```

Dieser Beitrag zielt auf .NET 11 (ASP.NET Core 11, `Microsoft.AspNetCore.Components` 11.0.x), das Verhalten ist aber seit der Einführung des Prerenderings unverändert und die Hinweise gelten ebenso für .NET 8, 9 und 10. Die einzige Ausnahme ist `RendererInfo`, das mit .NET 9 kam.

## Zwei Fehlermeldungen, zwei Renderer

Der Suchverkehr zu diesem Problem landet bei zwei unterschiedlichen Meldungen, und welche Sie erhalten haben, verrät, welches Hosting-Modell sie geworfen hat.

Die oben zitierte Meldung stammt aus `RemoteJSRuntime` im Circuit-Stack von Blazor Server. Sie wird geworfen, wenn der Client-Proxy der Laufzeit null ist, die Komponente also außerhalb eines aktiven SignalR-Circuits ausgeführt wird. In einer klassischen Blazor-Server-App mit `render-mode="ServerPrerendered"` sehen Sie genau diese Meldung.

Die zweite Meldung stammt aus einem völlig anderen Typ:

```text
System.InvalidOperationException: JavaScript interop calls cannot be issued during
server-side static rendering, because the page has not yet loaded in the browser.
Statically-rendered components must wrap any JavaScript interop calls in conditional
logic to ensure those interop calls are not attempted during static rendering.
   at Microsoft.AspNetCore.Components.Endpoints.UnsupportedJavaScriptRuntime.Microsoft.JSInterop.IJSRuntime.InvokeAsync[TValue](...)
```

`UnsupportedJavaScriptRuntime` ist eine interne, versiegelte `IJSRuntime`, die der Endpunkt-Renderer für statisches serverseitiges Rendering registriert. Jede Methode darauf wirft. In einer Blazor Web App (dem Template ab .NET 8) laufen Prerendering und statisches SSR beide über den Endpunkt-Renderer, deshalb erhalten Sie diese Meldung bei einer Seite ganz ohne Render Mode und beim Prerender-Durchlauf einer `InteractiveWebAssembly`- oder `InteractiveAuto`-Komponente.

Beides sind `InvalidOperationException`, beide haben dieselbe Ursache und dieselben Lösungen. Wenn Sie `UnsupportedJavaScriptRuntime` im Stack Trace sehen, achten Sie auf die Formulierung: "must wrap any JavaScript interop calls in conditional logic". Diese Formulierung ist wichtig, und sie führt zu der Falle, die weiter unten beschrieben wird.

## Warum das Prerendering keinen Browser zum Aufrufen hat

Prerendering rendert den Seiteninhalt statisch auf dem Server, damit das HTML so schnell wie möglich im Browser ankommt. Der Komponentenbaum läuft vollständig durch, erzeugt Markup, wird in die HTTP-Antwort geschrieben und verworfen. Erst danach startet das Blazor-Skript im Browser, öffnet einen Circuit (bei `InteractiveServer`) oder lädt die Laufzeit herunter (bei `InteractiveWebAssembly`) und instanziiert die Komponente interaktiv neu.

Während dieses ersten Durchlaufs gibt es kein DOM, kein `window` und keinen Transportweg für eine JS-Interop-Nachricht. `IJSRuntime` lässt sich weiterhin injizieren, weil der Dienst registriert ist und die Komponente problemlos kompiliert, doch die dahinterliegende Implementierung hat entweder keinen Client-Proxy oder ist ein Platzhalter, dessen einzige Aufgabe darin besteht, eine hilfreiche Meldung zu werfen. Deshalb ist das ein Laufzeitfehler und nie ein Compilerfehler.

Die Dokumentation zum Lebenszyklus ist bei der Konsequenz eindeutig: `OnAfterRender` und `OnAfterRenderAsync` "aren't invoked during prerendering or static server-side rendering (static SSR) on the server because those processes aren't attached to a live browser DOM and are already complete before the DOM is updated". Genau diese Eigenschaft macht `OnAfterRenderAsync` zum sicheren Ort für Interop.

Beachten Sie außerdem: `OnInitializedAsync` läuft bei einer prerenderten Komponente zweimal, einmal im statischen Durchlauf und einmal, wenn die Komponente interaktiv wird. Alles, was Sie dort laden, wird doppelt berechnet. Das ist ein eigenes Problem mit einer eigenen Lösung, behandelt in [Zustand über die statisch-zu-interaktiv-Renderinggrenze in Blazor persistieren](/de/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/).

## Minimale Reproduktion

Fügen Sie das in eine Blazor Web App aus dem .NET-11-Template mit globalem oder seitenweisem interaktivem Render Mode ein. Es schlägt bei der ersten Anfrage jedes Mal fehl.

```razor
@* Theme.razor *@
@* .NET 11, Microsoft.AspNetCore.Components 11.0.0, Blazor Web App *@
@page "/theme"
@rendermode InteractiveServer
@inject IJSRuntime JS

<p>Stored theme: @theme</p>

@code {
    private string? theme;

    protected override async Task OnInitializedAsync()
    {
        // Throws during the prerender pass: no browser, no localStorage.
        theme = await JS.InvokeAsync<string>("localStorage.getItem", "theme");
    }
}
```

Derselbe Code mit `@rendermode InteractiveWebAssembly` wirft stattdessen die `UnsupportedJavaScriptRuntime`-Variante, weil der Prerender-Durchlauf im Endpunkt-Renderer auf dem Server stattfindet und nicht in einem Circuit. Entfernen Sie die Zeile `@rendermode` vollständig, erhalten Sie ebenfalls die `UnsupportedJavaScriptRuntime`-Variante, und zwar dauerhaft, weil die Seite jetzt statisches SSR ist und nie interaktiv wird.

## Lösung 1: den Aufruf nach `OnAfterRenderAsync` verschieben

Das ist die empfohlene Lösung und die, auf die die Fehlermeldung des Frameworks selbst verweist. `OnAfterRenderAsync` wird erst aufgerufen, nachdem die Komponente interaktiv mit einem aktiven DOM gerendert wurde, dort ist Interop also immer zulässig.

```razor
@* Theme.razor *@
@* .NET 11, Microsoft.AspNetCore.Components 11.0.0 *@
@page "/theme"
@rendermode InteractiveServer
@inject IJSRuntime JS

<p>Stored theme: @(theme ?? "loading...")</p>

@code {
    private string? theme;

    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (firstRender)
        {
            theme = await JS.InvokeAsync<string>("localStorage.getItem", "theme");
            StateHasChanged();
        }
    }
}
```

Zwei Details, über die viele stolpern:

Die Absicherung `if (firstRender)` ist keine optionale Kür. Ohne sie läuft das Interop bei jedem Rendering erneut, und da `StateHasChanged` ein Rendering auslöst, entsteht eine Endlosschleife.

Das explizite `StateHasChanged()` ist zwingend. Anders als bei den übrigen Lebenszyklusmethoden plant das Framework bewusst kein erneutes Rendering, wenn die von `OnAfterRenderAsync` zurückgegebene `Task` abgeschlossen ist, eben um diese Endlosschleife zu vermeiden. Setzen Sie ein Feld und rufen `StateHasChanged` nicht auf, aktualisiert sich die Oberfläche nie und der Fehler sieht aus wie "mein Interop liefert null".

Gestalten Sie das Markup so, dass die prerenderte Ausgabe auch ohne das JavaScript-Ergebnis sinnvoll ist. Der Benutzer sieht diesen ersten Durchlauf. Ein Platzhalter, ein Skeleton oder ein sinnvoller Standardwert ist besser als ein leeres Element, das einen Moment später plötzlich erscheint.

## Lösung 2: auf `RendererInfo.IsInteractive` prüfen

Manchmal brauchen Sie die Verzweigung früher als beim ersten interaktiven Rendering, etwa um zu entscheiden, was gerendert und nicht was geladen wird. `ComponentBase.RendererInfo` (.NET 9 und höher) macht genau das verfügbar:

- `RendererInfo.Name` liefert `Static`, `Server`, `WebAssembly` oder `WebView`.
- `RendererInfo.IsInteractive` ist `true` beim interaktiven Rendering und `false` während des Prerenderings oder bei statischem SSR.
- `ComponentBase.AssignedRenderMode` liefert den zugewiesenen Render Mode der Komponente oder `null`, wenn keiner zugewiesen ist.

```razor
@* ThemeAware.razor *@
@* .NET 11 / .NET 10 / .NET 9. RendererInfo requires aspnetcore 9.0+ *@
@page "/theme-aware"
@rendermode InteractiveServer
@inject IJSRuntime JS

@if (!RendererInfo.IsInteractive)
{
    <p>Loading preferences...</p>
}
else
{
    <p>Stored theme: @theme</p>
}

@code {
    private string? theme;

    protected override async Task OnInitializedAsync()
    {
        if (RendererInfo.IsInteractive)
        {
            theme = await JS.InvokeAsync<string>("localStorage.getItem", "theme");
        }
    }
}
```

Das ist die "conditional logic", nach der die `UnsupportedJavaScriptRuntime`-Meldung verlangt. Es ist außerdem das richtige Werkzeug für eine Komponente, die brauchbares statisches Markup rendern muss, etwa ein Formular, das bei `AssignedRenderMode is null` normal abgeschickt wird und andernfalls einen Ereignishandler nutzt.

Unter .NET 8, wo `RendererInfo` nicht existiert, ist ein `[CascadingParameter] public HttpContext? HttpContext { get; set; }` an der Komponente die nächstliegende Möglichkeit, den Prerender-Durchlauf zu erkennen: Der Wert ist nur beim serverseitigen Rendering ungleich null. Das funktioniert, koppelt die Komponente aber an ASP.NET-Core-Hosting-Typen, bevorzugen Sie also `RendererInfo`, wenn Sie .NET 9 oder höher anvisieren können.

## Lösung 3: Prerendering für die Komponente deaktivieren

Wenn eine Komponente ohne JavaScript sinnlos ist (ein Diagramm-Wrapper, eine Karte, ein Rich-Text-Editor), bringt Prerendering nur ein kurzes Aufblitzen kaputten Markups. Schalten Sie es in der Komponentendefinition ab:

```razor
@* MapView.razor *@
@* .NET 11. prerender: false is valid on all three interactive render modes *@
@rendermode @(new InteractiveServerRenderMode(prerender: false))
```

Oder an der Verwendungsstelle:

```razor
@* .NET 11 *@
<MapView @rendermode="new InteractiveWebAssemblyRenderMode(prerender: false)" />
```

Um es app-weit zu deaktivieren, setzen Sie den Modus an der `Routes`-Komponente in `App.razor` und denken Sie daran, dasselbe für `HeadOutlet` zu tun:

```razor
@* App.razor, .NET 11 Blazor Web App template *@
<Routes @rendermode="new InteractiveServerRenderMode(prerender: false)" />
<HeadOutlet @rendermode="new InteractiveServerRenderMode(prerender: false)" />
```

Eine Regel, die viele übersehen: Das Deaktivieren des Prerenderings wirkt nur für Render Modes der obersten Ebene. Gibt eine übergeordnete Komponente bereits einen Render Mode an, werden die Prerendering-Einstellungen ihrer Kinder ignoriert. Das ist dieselbe Einschränkung "ein Teilbaum, ein Render Mode", die hinter [dem Fehler Der Render Mode wird vom Render Mode der übergeordneten Komponente nicht unterstützt](/de/2026/06/fix-render-mode-is-not-supported-by-the-parent-components-render-mode-blazor/) steht. Greifen Sie zu `prerender: false` nur, wenn Ihnen die Grenze gehört, und behandeln Sie es als letztes Mittel: Sie geben damit den schnellen ersten Bildaufbau und den SEO-Vorteil auf, für die das Prerendering existiert.

## Die Falle: `OnAfterRenderAsync` läuft bei statischem SSR nie

Das ist der mit Abstand häufigste Grund für "ich habe es nach `OnAfterRenderAsync` verschoben und es funktioniert immer noch nicht".

`OnAfterRender{Async}` wird weder während des Prerenderings *noch* während des statischen SSR aufgerufen. Bei einer prerenderten interaktiven Komponente ist das kein Problem, weil die Komponente einen Moment später interaktiv neu erzeugt wird und die Methode dann feuert. Bei einer Seite **ohne** Render Mode wird die Komponente jedoch nur statisch gerendert. Es gibt keinen zweiten Durchlauf. `OnAfterRenderAsync` wird nie aufgerufen, Ihr Interop passiert stillschweigend nie, und das Symptom wechselt von einer lauten Ausnahme zu einer toten Funktion.

Wenn das Interop keine Ausnahme mehr wirft, aber auch nicht mehr läuft, prüfen Sie, ob die Komponente tatsächlich einen interaktiven Render Mode hat, entweder direkt, von einem Elternteil geerbt oder global an `Routes` gesetzt. `AssignedRenderMode is null` innerhalb der Komponente ist die einzeilige Bestätigung, dass Sie im statischen SSR sind. Welches Hosting-Modell Sie zuweisen sollten, ist eine eigene Entscheidung, dargelegt in [Blazor Server vs Blazor WebAssembly vs Blazor United in .NET 11](/de/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/).

## Die dritte Variante: "the circuit has disconnected and is being disposed"

Es gibt eine dritte Meldung mit denselben Anfangsworten, und das ist ein anderer Fehler mit einer anderen Lösung:

```text
Microsoft.JSInterop.JSDisconnectedException: JavaScript interop calls cannot be issued
at this time. This is because the circuit has disconnected and is being disposed.
```

Achten Sie auf den Ausnahmetyp: `JSDisconnectedException`, nicht `InvalidOperationException`. Das hat mit Prerendering nichts zu tun. Es passiert am anderen Ende des Komponentenlebens, in serverseitigen Apps, wenn Sie JS aufrufen (oder eine `IJSObjectReference` freigeben), nachdem der SignalR-Circuit weg ist, typischerweise aus `DisposeAsync`, während der Benutzer wegnavigiert oder neu lädt. Die Lösung ist, die Ausnahme abzufangen:

```csharp
// .NET 11, server-side Blazor. Disposing a JS module after the circuit is gone.
async ValueTask IAsyncDisposable.DisposeAsync()
{
    try
    {
        if (module is not null)
        {
            await module.DisposeAsync();
        }
    }
    catch (JSDisconnectedException)
    {
    }
}
```

In einer WebAssembly-Komponente gibt es keinen Circuit, der verloren gehen kann, lassen Sie `try`/`catch` also weg und geben Sie das Modul einfach frei. Und wenn Sie nach dem Verbindungsverlust echte Aufräumarbeiten im Browser erledigen müssen, ist JS Interop das falsche Werkzeug: Verwenden Sie stattdessen das `MutationObserver`-Muster oder den `disconnectedCallback` eines Custom Elements auf dem Client.

## Stolperfallen mit derselben Ausnahme

**Komponentenbibliotheken von Drittanbietern.** MudBlazor, Radzen und ähnliche Bibliotheken rufen intern Interop auf, um Viewports zu vermessen, Popover zu positionieren oder Browserfähigkeiten auszulesen. Endet der Stack Trace der Ausnahme in einem Bibliothekstyp statt in Ihrem Code, ist die Lösung meist ein Schalter auf Bibliotheksebene oder das Deaktivieren des Prerenderings für die Seite, die die Komponente hostet. Prüfen Sie zuerst die Release Notes der Bibliothek: Die meisten haben seit .NET 8 Prerender-Absicherungen ergänzt.

**Injizierte Dienste, die JS aufrufen.** Ein Scoped Service, der `localStorage` kapselt, wirft dort, wo Sie ihn zuerst aufrufen, und das ist oft `OnInitializedAsync`. Der Dienst kann das nicht für Sie beheben; die Aufrufstelle muss verschoben oder abgesichert werden. Manche Bibliotheken (darunter Blazored.LocalStorage) formulieren das als Hinweis, den Speicher erst nach dem ersten Rendering anzufassen, genau aus diesem Grund.

**`IJSInProcessRuntime` unter WebAssembly.** Synchrones Interop steht in clientseitigen Komponenten erst zur Verfügung, wenn die WebAssembly-Laufzeit läuft. Während des serverseitigen Prerender-Durchlaufs einer `InteractiveWebAssembly`-Komponente schlägt die Umwandlung von `IJSRuntime` in `IJSInProcessRuntime` fehl oder der Aufruf wirft. Verwenden Sie `OperatingSystem.IsBrowser()`, wenn Sie wissen müssen, ob der Code tatsächlich auf WebAssembly ausgeführt wird.

**Interaktives Routing überspringt das Prerendering.** Erreichen Sie die Seite über eine interne Enhanced Navigation in einer App, deren `Routes`-Komponente interaktiv ist, findet gar kein Prerendering statt, der Fehler ist also nur bei einem vollständigen Seitenladen reproduzierbar. Eine Komponente, die beim Klick auf einen Link funktioniert und bei F5 fehlschlägt, ist fast immer dieser Fall.

**Langlaufende Arbeit in der Initialisierung.** Weil das Prerendering auf Quiescence wartet, blockiert ein langsames `OnInitializedAsync` die gesamte prerenderte Antwort. Das ist nicht diese Ausnahme, aber das benachbarte Problem, für das Streaming Rendering existiert, und es tritt oft in denselben Komponenten auf.

## Verwandte Beiträge

- [Zustand über die statisch-zu-interaktiv-Renderinggrenze in Blazor unter .NET 11 persistieren](/de/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/) löst die Doppelinitialisierungs-Hälfte der Prerender-Grenze.
- [Lösung: Der Render Mode wird vom Render Mode der übergeordneten Komponente nicht unterstützt (Blazor)](/de/2026/06/fix-render-mode-is-not-supported-by-the-parent-components-render-mode-blazor/) erklärt die Regel ein Teilbaum, ein Render Mode, die begrenzt, wo `prerender: false` wirkt.
- [Blazor Server vs Blazor WebAssembly vs Blazor United in .NET 11](/de/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) behandelt, welchen Render Mode Sie überhaupt zuweisen sollten.
- [Eine Blazor-Server-App in .NET 11 zu Blazor United (Blazor Web App) migrieren](/de/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/) zeigt, wie Sie Render Modes in eine App einführen, die vorher keine hatte.
- [Validierungslogik zwischen Server und Blazor WebAssembly teilen](/de/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) ist das Muster für Logik, die auf beiden Seiten der Grenze laufen muss.

## Quellen

- [Prerender ASP.NET Core Razor components](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/prerender) (Microsoft Learn, .NET 10/11)
- [ASP.NET Core Razor component lifecycle](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/lifecycle) (Microsoft Learn)
- [ASP.NET Core Blazor render modes](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes) (Microsoft Learn), "Detect rendering location, interactivity, and assigned render mode at runtime"
- [ASP.NET Core Blazor JavaScript interoperability (JS interop)](https://learn.microsoft.com/en-us/aspnet/core/blazor/javascript-interoperability/) (Microsoft Learn), "JavaScript interop calls without a circuit"
- [`RemoteJSRuntime.cs`](https://github.com/dotnet/aspnetcore/blob/main/src/Components/Server/src/Circuits/RemoteJSRuntime.cs) und [`UnsupportedJavaScriptRuntime.cs`](https://github.com/dotnet/aspnetcore/blob/main/src/Components/Endpoints/src/DependencyInjection/UnsupportedJavaScriptRuntime.cs) in `dotnet/aspnetcore`, wo die beiden Meldungen geworfen werden
- [dotnet/aspnetcore #24320](https://github.com/dotnet/aspnetcore/issues/24320), das langlaufende Issue zu diesem Fehler
