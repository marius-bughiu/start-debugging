---
title: "Was ist ein Blazor-Rendermodus und welcher führt meine Komponente aus?"
description: "Ein Rendermodus entscheidet, wo eine Razor-Komponente ausgeführt wird und ob sie interaktiv ist. Hier sind die vier Modi in .NET 11, die Vererbungsregeln, die bestimmen, was Ihre Komponente erbt, und die Eigenschaften RendererInfo und AssignedRenderMode, die zur Laufzeit verraten, welcher Modus gewonnen hat."
pubDate: 2026-09-05
tags:
  - "blazor"
  - "aspnetcore"
  - "dotnet-11"
  - "csharp"
lang: "de"
translationOf: "2026/09/what-is-a-blazor-render-mode-and-which-one-runs-my-component"
translatedBy: "claude"
translationDate: 2026-09-05
---

Ein Rendermodus ist die Einstellung pro Komponente in einer Blazor Web App, die zwei Dinge entscheidet: wo die Komponente ausgeführt wird (Server oder Browser) und ob sie auf UI-Ereignisse reagieren kann. Es gibt vier: Static Server, Interactive Server, Interactive WebAssembly und Interactive Auto. Zugewiesen wird ein Modus über die Direktive oder das Direktivenattribut `@rendermode`, der Standard ist Static Server, und Modi werden im Komponentenbaum nach unten weitergegeben, weshalb die meisten Komponenten gar keinen deklarieren. Um herauszufinden, welcher Modus eine bestimmte Komponente tatsächlich ausführt, lesen Sie `ComponentBase.AssignedRenderMode` und `ComponentBase.RendererInfo` innerhalb der Komponente: `AssignedRenderMode` ist `null` bei statischem SSR, und `RendererInfo.IsInteractive` ist während des Prerenderings `false`, selbst bei einer Komponente mit interaktivem zugewiesenem Modus.

Alles hier zielt auf .NET 11 und ASP.NET Core 11 mit C# 14. Rendermodi existieren nur in einer Blazor Web App (das vereinheitlichte Template aus .NET 8). Eine eigenständige Blazor-WebAssembly-App oder eine alte Blazor-Server-App hat ein einziges Hostingmodell für die gesamte App und überhaupt keine `@rendermode`-Direktive. Wo sich das Verhalten in .NET 10 oder .NET 11 geändert hat, weise ich darauf hin.

## Die vier Modi und die zwei Achsen, auf denen sie variieren

| Modus | Ausführung auf | Interaktiv | Benötigt ein `.Client`-Projekt |
| --- | --- | --- | --- |
| Static Server | Server | Nein | Nein |
| Interactive Server | Server, über einen SignalR-Circuit | Ja | Nein |
| Interactive WebAssembly | Browser | Ja | Ja |
| Interactive Auto | Zuerst Server, bei späteren Besuchen Browser | Ja | Ja |

Static Server, meist als statisches SSR geschrieben, rendert die Komponente in den HTTP-Antwortstream und hört dann auf. Es gibt keinen Circuit, keine .NET-Laufzeit im Browser und keine Ereignisbehandlung. Ein `@onclick` auf einem statisch gerenderten Button kompiliert fehlerfrei und tut zur Laufzeit nichts. Das ist der Standard, und für Inhaltsseiten ist es der richtige: keine offen zu haltende Verbindung, keine WebAssembly-Nutzlast zum Herunterladen.

Interactive Server hält die Komponente auf dem Server am Leben und leitet DOM-Ereignisse und Diffs über eine SignalR-Verbindung. Interactive WebAssembly lädt die .NET-Laufzeit und das App-Bundle herunter und führt die Komponente im Browser aus. Interactive Auto ist keine dritte Laufzeit: Beim ersten Besuch wird mit Interactive Server gerendert, während das WebAssembly-Bundle im Hintergrund geladen wird, danach wird bei weiteren Besuchen WebAssembly verwendet, sobald das Bundle im Cache liegt.

Eine Eigenschaft von Auto überrascht viele. Laut [Dokumentation zu Rendermodi](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes) wechselt Auto niemals den Rendermodus einer Komponente, die bereits auf der Seite ist. Auto trifft eine Entscheidung, wenn die Komponente zum ersten Mal rendert, und behält diesen Modus, solange die Komponente existiert. Zusätzlich bevorzugt Auto den Modus bereits vorhandener interaktiver Komponenten auf der Seite, damit nicht mitten auf der Seite eine zweite .NET-Laufzeit entsteht, die keinen Zustand mit der ersten teilt. Wer noch zwischen Hostingmodellen wählt statt eines zu debuggen, findet die ausführliche Behandlung in [Blazor Server vs WebAssembly vs Blazor United in .NET 11](/de/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/).

Interaktive Modi benötigen die passenden Dienste und Endpunkte in `Program.cs`, sonst bedeutet `@rendermode` nichts:

```csharp
// .NET 11, C# 14 -- Program.cs of a Blazor Web App
builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents()
    .AddInteractiveWebAssemblyComponents();

// ...

app.MapRazorComponents<App>()
    .AddInteractiveServerRenderMode()
    .AddInteractiveWebAssemblyRenderMode();
```

## Drei Stellen, an denen ein Rendermodus gesetzt werden kann

Der Modus, der bei einer Komponente ankommt, kann aus drei verschiedenen syntaktischen Positionen stammen, und die sind nicht austauschbar.

**Auf einer Komponenteninstanz**, als Direktivenattribut, dort wo die Komponente verwendet wird:

```razor
@* .NET 11 -- any render mode instance is allowed here *@
<Dialog @rendermode="InteractiveServer" />
```

**Auf einer Komponentendefinition**, als Direktive am Anfang der `.razor`-Datei. Das nutzen Sie für eine routbare Seite, weil niemand eine Seite von Hand instanziiert:

```razor
@* .NET 11 -- Pages/Counter.razor *@
@page "/counter"
@rendermode InteractiveServer
```

`@rendermode` ist sowohl eine Razor-Direktive als auch ein Razor-Direktivenattribut, und der Unterschied zählt genau einmal: Die Direktivenform verlangt eine statische Rendermodus-Instanz, die Direktivenattributform akzeptiert jede Instanz, auch eine mit Optionen konstruierte.

**Für die gesamte App**, indem der Modus auf die `Routes`-Komponente in `App.razor` gesetzt wird. Der Router gibt seinen Modus an jede geroutete Seite weiter:

```razor
@* .NET 11 -- Components/App.razor *@
<Routes @rendermode="InteractiveServer" />
<HeadOutlet @rendermode="InteractiveServer" />
```

Einen Modus auf der Wurzelkomponente `App` selbst zu setzen, wird nicht unterstützt. Deshalb wird globale Interaktivität über `Routes` und `HeadOutlet` ausgedrückt und nicht über eine einzelne Direktive ganz oben. Wer eine alte App in dieses Modell überführt, findet die Mechanik in [Migration einer Blazor-Server-App zu Blazor Web App in .NET 11](/de/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/).

Der Modus lässt sich auch berechnen, und genau so schneidet man statische SSR-Seiten aus einer ansonsten interaktiven App heraus:

```razor
@* .NET 11 -- Components/App.razor *@
<Routes @rendermode="PageRenderMode" />

@code {
    private IComponentRenderMode? PageRenderMode => InteractiveServer;
}
```

## Die Vererbungsregeln, die bestimmen, was Ihre Komponente bekommt

Die meisten Komponenten einer echten App haben überhaupt kein `@rendermode`. Sie erben, und die vier Regeln sind kurz:

1. Der Standard-Rendermodus ist Static.
2. Eine Komponente ohne `@rendermode` übernimmt den Modus ihres Elternteils.
3. In einem Kind kann nicht auf einen anderen interaktiven Modus gewechselt werden. Eine Interactive-Server-Komponente kann kein Interactive-WebAssembly-Kind hosten.
4. Parameter, die von einem statischen Elternteil an ein interaktives Kind übergeben werden, müssen JSON-serialisierbar sein.

Regel 2 ist der Grund, warum eine gemeinsam genutzte Komponente, die auf einer Seite funktioniert und auf einer anderen tot ist, fast nie selbst schuld ist. Setzen Sie das hier auf eine Seite ohne Modus, und der Button tut nichts:

```razor
@* .NET 11 -- Components/SharedMessage.razor, render-mode agnostic *@
<button @onclick="UpdateMessage">Click me</button> @message

@code {
    private string message = "Not updated yet.";

    private void UpdateMessage() => message = "Somebody updated me!";
}
```

Dieselbe Komponente unter `@rendermode InteractiveServer` funktioniert. An der Komponente hat sich nichts geändert. Der richtige Reflex bei "mein Button tut nichts" ist, den Baum nach oben zu schauen, nicht den Handler.

Regel 3 erzeugt statt Stille einen Laufzeitfehler. Eine auf Interactive Server festgelegte Seite mit einem WebAssembly-Kind scheitert mit `Cannot create a component of type '...' because its render mode 'Microsoft.AspNetCore.Components.Web.InteractiveWebAssemblyRenderMode' is not supported by Interactive Server rendering.` Geschwisterkomponenten mit unterschiedlichen interaktiven Modi auf einer statischen Seite sind in Ordnung, die Verschachtelung der einen in die andere nicht.

Regel 4 erzeugt die verwirrendste Meldung. Kindinhalt über eine Grenze von statisch zu interaktiv zu übergeben wirft:

> System.InvalidOperationException: Cannot pass the parameter 'ChildContent' to component 'SharedMessage' with rendermode 'InteractiveServerRenderMode'. This is because the parameter is of the delegate type 'Microsoft.AspNetCore.Components.RenderFragment', which is arbitrary code and cannot be serialized.

Ein interaktives Kind eines statischen Elternteils ist eine Wurzelkomponente für seinen eigenen Renderer, und seine Parameter müssen als JSON eine Prozess- oder Netzwerkgrenze überqueren. Ein `RenderFragment` ist ein Delegat, und ein Delegat serialisiert nicht. Die historische Lösung verschiebt die Grenze nach oben: Kapseln Sie das Kind in eine Komponente ohne Renderfragment und setzen Sie `@rendermode` auf diese Hülle.

```razor
@* .NET 11 -- Components/WrapperComponent.razor *@
<SharedMessage>
    Child content
</SharedMessage>
```

```razor
@* .NET 11 -- the page *@
@page "/render-mode-10"

<WrapperComponent @rendermode="InteractiveServer" />
```

Genau deshalb liefert das Template eine `Routes.razor` aus, die den `Router` umschließt, statt `@rendermode` direkt auf `Router` zu setzen.

## Die Änderung in .NET 11: interaktive Layouts funktionieren endlich

Regel 4 hatte ein bekanntes Opfer. `LayoutComponentBase` stellt `@Body` als `RenderFragment` bereit, deshalb warf `@rendermode InteractiveServer` auf `MainLayout` in einer App mit Interaktivität pro Seite denselben Serialisierungsfehler, mit `'Body'` als Parameternamen. Jeder Workaround der letzten drei Hauptversionen war eine Variante von "packen Sie die Interaktivität stattdessen in eine Hülle oder eine Blazor-Section".

Diese Einschränkung ist in .NET 11 weg. Die Microsoft-Dokumentation begrenzt die gesamte Einschränkung "Statically-rendered layout components" jetzt auf die Versionen `>= 8.0 < 11.0` und stellt fest, dass sie "prior to the release of .NET 11" gilt. Die zugrunde liegende Arbeit ist [dotnet/aspnetcore#52768](https://github.com/dotnet/aspnetcore/issues/52768), ausgeliefert in .NET 11 Preview 5: Erhält eine Komponente mit Rendermodus einen `RenderFragment`-Parameter, ruft das Framework das Fragment nun auf der statischen Seite auf, serialisiert den entstandenen Renderbaum als JSON und rehydriert ihn auf der interaktiven Seite in einen `RenderFragment`-Delegaten. Damit das ehrlich bleibt, verlangt der Compiler, dass solche gekapselten Funktionen statische lokale Funktionen sind, damit sie keinen Serverzustand einfangen, der die Reise nicht überstehen würde.

Praktisch bedeutet das: Unter .NET 11 können Sie

```razor
@* .NET 11 only -- Components/Layout/MainLayout.razor *@
@inherits LayoutComponentBase
@rendermode InteractiveServer

<div class="page">
    <NavMenu />
    <main>@Body</main>
</div>
```

schreiben und erhalten eine interaktive Navigationsleiste ohne den Umweg über sectionbasierte Hüllen. Unter .NET 10 und älter wirft dieselbe Datei zur Laufzeit. Prüfen Sie das Zielframework, bevor Sie ein Layout-Snippet aus dem Netz kopieren, denn dieser Punkt hat sich umgedreht.

## Welcher Modus führt meine Komponente gerade aus?

`ComponentBase` stellt dafür zwei Eigenschaften bereit, beide seit .NET 9 verfügbar. Keine davon benötigt Injection.

`AssignedRenderMode` liefert den zugewiesenen Modus der Komponente: eine Instanz von `InteractiveServerRenderMode`, `InteractiveWebAssemblyRenderMode` oder `InteractiveAutoRenderMode`, oder `null`, wenn die Komponente unter statischem SSR läuft.

`RendererInfo` beschreibt den Renderer, der die Komponente tatsächlich ausführt. `RendererInfo.Name` ist eines von `Static`, `Server`, `WebAssembly` oder `WebView`. `RendererInfo.IsInteractive` ist nur dann `true`, wenn die Komponente wirklich interaktiv ist, und `false` sowohl bei statischem SSR als auch während des Prerender-Durchlaufs einer interaktiven Komponente.

Diese letzte Unterscheidung ist die nützliche. Eine Komponente mit `@rendermode InteractiveServer` rendert zweimal: einmal beim Prerendering, wo `AssignedRenderMode` eine `InteractiveServerRenderMode`-Instanz ist, `RendererInfo.IsInteractive` aber `false`, und einmal über den Circuit, wo beide übereinstimmen. Also:

- Nutzen Sie `AssignedRenderMode is null` für die Frage "wird diese Komponente jemals interaktiv?" Das ist eine Entscheidung über die Form des Markups.
- Nutzen Sie `RendererInfo.IsInteractive` für die Frage "kann ich gerade jetzt Ereignisse behandeln?" Das ist eine Entscheidung über den aktuellen Durchlauf.

Eine Diagnosekomponente, die Sie an beliebiger Stelle im Baum ablegen können, um zu sehen, was ein Teilbaum geerbt hat:

```razor
@* .NET 11 -- Components/RenderModeProbe.razor *@
<dl>
    <dt>AssignedRenderMode</dt>
    <dd>@(AssignedRenderMode?.GetType().Name ?? "null (static SSR)")</dd>
    <dt>RendererInfo.Name</dt>
    <dd>@RendererInfo.Name</dd>
    <dt>RendererInfo.IsInteractive</dt>
    <dd>@RendererInfo.IsInteractive</dd>
</dl>
```

Da die Sonde selbst keinen Modus deklariert, erbt sie und meldet genau das, was ihre Hostseite nach unten gereicht hat. Das ist eine schnellere Antwort, als `@rendermode`-Direktiven im Baum nach oben zu verfolgen, besonders in einer App, die Modi programmatisch zuweist.

Der dokumentierte Einsatz von `AssignedRenderMode` ist elegantes Degradieren: ein echtes HTML-`form` rendern, wenn die Komponente statisch ist, und gebundene Eingaben mit Ereignishandler, wenn nicht.

```razor
@* .NET 11 *@
@if (AssignedRenderMode is null)
{
    <form action="/movies">
        <input type="text" name="titleFilter" />
        <input type="submit" value="Search" />
    </form>
}
else
{
    <input @bind="titleFilter" />
    <button @onclick="FilterMovies">Search</button>
}
```

Und der dokumentierte Einsatz von `IsInteractive` ist das Unterdrücken von Steuerelementen, die im Prerender-Durchlauf stillschweigend nichts täten:

```razor
@* .NET 11 *@
<button @onclick="Send" disabled="@(!RendererInfo.IsInteractive)">
    Send
</button>
```

## Prerendering, und warum Ihr Initialisierer zweimal läuft

Prerendering ist für alle drei interaktiven Modi standardmäßig aktiv. Der Server rendert die Komponente statisch in die erste HTML-Antwort, danach übernimmt der interaktive Renderer und rendert erneut. `OnInitializedAsync` läuft deshalb zweimal, einmal pro Renderer, und das ist die tatsächliche Ursache der Klagen "meine API wird zweimal aufgerufen" und "die UI springt zurück in den Ladezustand".

`OnAfterRender` und `OnAfterRenderAsync` sind die Ausnahme: Sie werden beim Prerendering gar nicht aufgerufen. Auch deshalb wirft JS-Interop aus `OnInitializedAsync` heraus, denn es gibt noch keinen Browser zum Aufrufen, ausführlich behandelt in [JavaScript interop calls cannot be issued at this time](/de/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/).

Es gibt zwei Antworten. Prerendering für die Komponente abschalten:

```razor
@* .NET 11 -- component definition form *@
@rendermode @(new InteractiveServerRenderMode(prerender: false))
```

```razor
@* .NET 11 -- component instance form *@
<Dialog @rendermode="new InteractiveServerRenderMode(prerender: false)" />
```

Oder, besser für alles, was der Nutzer sieht: Prerendering behalten und den Zustand mit dem Attribut `[PersistentState]` über die Grenze tragen (`[SupplyParameterFromPersistentComponentState]` unter dem alten Namen; `PersistentStateAttribute` ist die API ab .NET 10):

```csharp
// .NET 11, C# 14
[PersistentState]
public int? CurrentCount { get; set; }
```

Die vollständige Behandlung inklusive `RestoreBehavior` und `AllowUpdates` steht in [wie man Zustand über die statisch-zu-interaktiv-Grenze in Blazor unter .NET 11 hinweg erhält](/de/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/).

Eine Falle beim Abschalten: `prerender: false` wirkt nur auf einem Rendermodus der obersten Ebene. Hat eine Elternkomponente bereits einen Modus deklariert, wird die Prerender-Einstellung ihrer Kinder komplett ignoriert. Sie an einer verschachtelten Komponente zu setzen und weiterhin Prerendering zu sehen, ist kein Bug.

## Statisches SSR verliert mehr als nur Interaktivität

Unter statischem SSR wird die Anfrage von der ASP.NET-Core-Middleware-Pipeline verarbeitet, und Razor-Komponenten werden während dieser Verarbeitung nicht gerendert. Blazors eigene Router-Funktionen sind daher nicht beteiligt. In .NET 10 und .NET 11 wird `<NotAuthorized>`-Inhalt von `AuthorizeRouteView` bei statisch gerenderten Seiten nicht angezeigt; nicht autorisierte Anfragen behandelt stattdessen die Autorisierungs-Middleware, typischerweise über einen eigenen `IAuthorizationMiddlewareResultHandler`. Vor .NET 10 hatte `<NotFound>`-Inhalt dasselbe Problem. Eine App mit Interaktivität auf Wurzelebene trifft das nicht, weil nach dem ersten statischen Rendern die Middleware-Pipeline nicht mehr beteiligt ist.

.NET 11 ergänzt außerdem ein rendermodusnahes Werkzeug, das man kennen sollte: Die Komponente `CacheView` cacht die gerenderte Ausgabe eines Komponenten-Teilbaums während des statischen SSR und spielt das Markup bei einem Treffer wieder ab, ohne die Kindkomponenten zu instanziieren oder deren Lebenszyklusmethoden auszuführen.

```razor
@* .NET 11 *@
<CacheView VaryByQuery="category" ExpiresAfter="TimeSpan.FromMinutes(5)">
    <ProductList Category="@Category" />
</CacheView>
```

Es gilt nur für statisches SSR, was ein weiterer Grund ist, Inhaltsseiten im Standardmodus zu belassen, statt die ganze App aus Gewohnheit interaktiv zu machen.

## Die Kurzfassung

Ein Rendermodus bestimmt, wo die Komponente läuft und ob sie Ereignisse behandeln kann. Weisen Sie ihn auf einer Instanz zu, auf einer Definition oder auf `Routes` für die gesamte App; alles ohne Direktive erbt vom Elternteil, und der Standard ist statisch. Ein toter Button heißt: im Baum nach oben schauen. Eine Serialisierungsausnahme heißt, dass ein `RenderFragment` eine Grenze von statisch zu interaktiv überquert hat, wozu unter .NET 10 und älter jedes interaktive Layout gehört und unter .NET 11 nicht mehr. Ein doppelter API-Aufruf heißt Prerendering, und die Lösung ist weit häufiger `[PersistentState]` als `prerender: false`. Wenn Sie die harte Wahrheit statt einer Vermutung brauchen, lesen Sie `AssignedRenderMode` für die Zuweisung und `RendererInfo.IsInteractive` für den aktuellen Durchlauf, und denken Sie daran, dass beide während des Prerenderings absichtlich auseinanderfallen.

## Verwandt

- [Blazor Server vs Blazor WebAssembly vs Blazor United in .NET 11](/de/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/)
- [Migration einer Blazor-Server-App zu Blazor United (Blazor Web App) in .NET 11](/de/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/)
- [Zustand über die statisch-zu-interaktiv-Grenze in Blazor unter .NET 11 hinweg erhalten](/de/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/)
- [Fix: JavaScript interop calls cannot be issued at this time (Blazor-Prerendering)](/de/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/)
- [Fix: Attempting to reconnect to the server, wenn ein Blazor-Server-Circuit abbricht](/de/2026/08/fix-attempting-to-reconnect-to-the-server-after-a-blazor-circuit-disconnects/)

## Quellen

- [ASP.NET Core Blazor render modes -- Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes?view=aspnetcore-11.0)
- [Prerender ASP.NET Core Razor components -- Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/prerender?view=aspnetcore-11.0)
- [ASP.NET Core Blazor layouts -- Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/layouts?view=aspnetcore-11.0)
- [Persist state across prerendering -- Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/blazor/state-management/prerendered-state-persistence?view=aspnetcore-11.0)
- [What's new in ASP.NET Core in .NET 11 -- Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-11)
- [Support serializing RenderFragment parameters -- dotnet/aspnetcore #52768](https://github.com/dotnet/aspnetcore/issues/52768)
- [ComponentBase.AssignedRenderMode Property -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.components.componentbase.assignedrendermode)
- [RendererInfo Struct -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.components.rendererinfo)
