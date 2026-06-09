---
title: "Lösung: Der Render Mode wird vom Render Mode der übergeordneten Komponente nicht unterstützt (Blazor)"
description: "Sie haben @rendermode auf ein Kind gesetzt, dessen Eltern bereits interaktiv sind. Ein Teilbaum hat genau einen Render Mode. Entfernen Sie die Direktive oder verschieben Sie sie an die Grenze."
pubDate: 2026-06-09
template: error-page
tags:
  - "errors"
  - "blazor"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
lang: "de"
translationOf: "2026/06/fix-render-mode-is-not-supported-by-the-parent-components-render-mode-blazor"
translatedBy: "claude"
translationDate: 2026-06-09
---

Die Lösung: Sie haben `@rendermode` auf eine untergeordnete Komponente angewendet, die innerhalb eines Teilbaums liegt, der bereits einen interaktiven Render Mode hat, und die beiden Modi stimmen nicht überein. Ein Blazor-Teilbaum hat genau einen Render Mode, der an seiner interaktiven Grenze festgelegt wird. Sie können nicht mitten im Baum von `InteractiveServer` zu `InteractiveWebAssembly` (oder zurück) wechseln. Entfernen Sie die `@rendermode`-Direktive vom Kind, damit es den Modus der Eltern erbt, oder verschieben Sie den Render Mode hoch zu der einen Komponente, die die interaktive Grenze besitzt. Wenn die Modi tatsächlich identisch sind, ist das eigentliche Problem ein doppeltes `@rendermode` auf einer verschachtelten Komponente, und Sie sollten das innere löschen.

```text
System.InvalidOperationException: Cannot create a component of type
'BlazorSample.Components.SharedMessage' because its render mode
'Microsoft.AspNetCore.Components.Web.InteractiveWebAssemblyRenderMode'
is not supported by Interactive Server rendering.
   at Microsoft.AspNetCore.Components.Rendering.ComponentState..ctor(...)
   at Microsoft.AspNetCore.Components.RenderTree.Renderer.AddToRenderQueue(...)
   at Microsoft.AspNetCore.Components.Endpoints.EndpointHtmlRenderer...
```

Dieser Leitfaden ist für .NET 11 geschrieben (ASP.NET Core 11, `Microsoft.AspNetCore.Components` 11.0.0), aber die Regel ist seit der Einführung der Render Modes in .NET 8 identisch. Der Meldungstext variiert je nach Kombination, die Sie treffen, daher landet Suchverkehr unter mehreren Formulierungen hier: "its render mode is not supported by Interactive Server rendering", "render mode is not supported by the parent component's render mode" und das eng verwandte "Cannot pass the parameter X to component Y with rendermode InteractiveServerRenderMode". Alle drei stammen aus derselben zugrunde liegenden Einschränkung, und die letzte hat eine andere Lösung, die weiter unten behandelt wird.

## Ein Teilbaum, ein Render Mode

In einer Blazor Web App ist Interaktivität kein Schalter pro Komponente, den Sie nach Belieben verteilen können. Wenn eine Komponente `@rendermode InteractiveServer` oder `@rendermode InteractiveWebAssembly` deklariert, erzeugt sie eine interaktive *Grenze*. Alles, was innerhalb dieser Grenze gerendert wird (jedes Kind, jeder Nachkomme und der Inhalt, den sie rendern), läuft unter diesem einen Render Mode. Die Grenze ist die Wurzel einer interaktiven *Insel*, und eine Insel hat ein einziges Hostingmodell: entweder einen SignalR-Circuit auf dem Server oder eine WebAssembly-Laufzeit im Browser. Es gibt keinen Mechanismus, eine halbe Insel auf dem Server und eine halbe im Browser auszuführen, weil beide einen lebenden Komponentenzustandsbaum und einen einzigen Dispatcher teilen.

Deshalb werden die Regeln in der offiziellen Dokumentation als Absolute formuliert. Aus der [Blazor-Render-Modes-Dokumentation](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes):

- Render Modes propagieren die Komponentenhierarchie hinab.
- Der standardmäßige Render Mode ist Static.
- Sie können in einer untergeordneten Komponente nicht zu einem anderen interaktiven Render Mode wechseln. Beispielsweise kann eine Server-Komponente kein Kind einer WebAssembly-Komponente sein.

Wenn der Renderer also den Baum durchläuft, Ihre untergeordnete Komponente erreicht und ein `@rendermode` findet, das mit der Insel kollidiert, in der sie sich bereits befindet, kann er es nicht erfüllen. Er wirft eine Ausnahme, statt stillschweigend einen auszuwählen. Die Ausnahme wird konstruiert, wenn das Framework versucht, den Komponentenzustand für das problematische Kind zu erstellen, weshalb der Stack Trace auf `ComponentState` und den Renderer zeigt, nicht auf Ihren Code.

Ein nützliches mentales Modell: `@rendermode` beantwortet die Frage "Wo beginnt diese Insel und was hostet sie?". Es ist keine Eigenschaft jeder Komponente. Die meisten Komponenten sollten gar keinen Render Mode tragen und einfach die Insel erben, in der sie landen.

## Die minimale Reproduktion

Eine Seite ist auf dem Server interaktiv und verschachtelt eine Komponente, die WebAssembly anfordert:

```razor
@* RenderMode11.razor -- .NET 11, ASP.NET Core 11 -- throws at render time *@
@page "/render-mode-11"
@rendermode InteractiveServer

<h1>Dashboard</h1>

<SharedMessage @rendermode="InteractiveWebAssembly" />
```

`SharedMessage` selbst ist render-mode-agnostisch (es deklariert keinen eigenen Modus):

```razor
@* SharedMessage.razor -- .NET 11 *@
<p>@message</p>
<button @onclick="UpdateMessage">Update</button>

@code {
    private string message = "Not updated yet.";
    private void UpdateMessage() => message = "Updated!";
}
```

Navigieren Sie zu `/render-mode-11`, und die Seite scheitert beim Rendern mit:

```text
Cannot create a component of type 'SharedMessage' because its render mode
'InteractiveWebAssemblyRenderMode' is not supported by Interactive Server rendering.
```

Die Eltern besitzen eine Server-Insel. Das Kind forderte eine darin verschachtelte WebAssembly-Insel. Diese Verschachtelung ist nicht darstellbar, also wird die Ausnahme geworfen.

## Die Lösung, nach Priorität geordnet

**1. Entfernen Sie den Render Mode vom Kind (am häufigsten).** In neun von zehn Fällen hätte das Kind nie ein `@rendermode` haben dürfen. Es wurde aus einem Beispiel kopiert oder vorsorglich hinzugefügt, "um es interaktiv zu machen", obwohl es die Interaktivität von seinen Eltern kostenlos erbt. Löschen Sie die Direktive:

```razor
@* RenderMode11.razor -- fixed: child inherits the parent's server island *@
@page "/render-mode-11"
@rendermode InteractiveServer

<h1>Dashboard</h1>

<SharedMessage />
```

Jetzt läuft `SharedMessage` interaktiv über dieselbe SignalR-Verbindung wie die Eltern. Der Button funktioniert. Das ist das in der Dokumentation beschriebene Verhalten der [Render-Mode-Vererbung](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes#render-mode-inheritance): Eine Komponente, die innerhalb interaktiver Eltern platziert wird, übernimmt deren Modus.

**2. Bringen Sie die beiden Modi in Übereinstimmung.** Wenn Sie hier tatsächlich WebAssembly wollten, sind die *Eltern* falsch. Setzen Sie die gesamte Insel an ihrer Grenze auf WebAssembly und entfernen Sie die Direktive vom Kind:

```razor
@* fixed: the whole island is WebAssembly *@
@page "/render-mode-11"
@rendermode InteractiveWebAssembly

<SharedMessage />
```

Denken Sie daran, dass eine WebAssembly-Insel nur im Client-Projekt leben kann (dem, dessen Name auf `.Client` endet). Verschieben Sie sowohl die Seite als auch `SharedMessage` dorthin, sonst tauscht diese Lösung einen Fehler gegen `Could not find any interactive components`.

**3. Teilen Sie die Insel auf, damit die beiden Modi Geschwister statt verschachtelt sind.** Server- und WebAssembly-Inhalt können auf derselben Seite koexistieren, solange keiner *innerhalb* des anderen liegt. Machen Sie beide zu Kindern eines statischen Elternteils:

```razor
@* fixed: two sibling islands under a static page *@
@page "/render-mode-11"

@* no @rendermode here -- the page stays static SSR *@
<ServerWidget @rendermode="InteractiveServer" />
<WasmWidget @rendermode="InteractiveWebAssembly" />
```

Die Seite selbst rendert statisch und hostet zwei unabhängige Inseln. Das ist das korrekte Muster, wenn ein Widget servernur-Dienste benötigt (eine Datenbank, HTTP-Cookies) und ein anderes offline im Browser laufen muss. Die Einschränkung betrifft nur das *Verschachteln* nicht übereinstimmender Modi, nicht das Vorhandensein beider auf einer Seite.

**4. Verwenden Sie `InteractiveAuto` an der Grenze, nicht in der Mitte.** `InteractiveAuto` ist weiterhin ein einziger Render Mode für die Insel: Es wählt Server für den ersten Besuch und WebAssembly, sobald das Bundle im Cache liegt. Sie setzen es einmal, an der Grenze, genau wie die anderen beiden. Es erlaubt nicht, Modi innerhalb eines Teilbaums zu mischen.

## Der Doppelgänger: "Cannot pass the parameter ... with rendermode"

Ein anderer, aber ständig verwechselter Fehler hat fast denselben Auslöser. Wenn ein interaktives Kind unter einem *statischen* Elternteil sitzt und Sie ihm einen `RenderFragment` (Kindinhalt) übergeben, erhalten Sie:

```text
System.InvalidOperationException: Cannot pass the parameter 'ChildContent' to
component 'SharedMessage' with rendermode 'InteractiveServerRenderMode'. This is
because the parameter is of the delegate type
'Microsoft.AspNetCore.Components.RenderFragment', which is arbitrary code and
cannot be serialized.
```

Hier kollidieren die Modi nicht; der *Parameter* kann die Grenze nicht überschreiten. Parameter, die von einem statischen Elternteil an ein interaktives Kind übergeben werden, müssen JSON-serialisierbar sein, weil der statische Server sie in die Seite serialisieren muss, damit die interaktive Laufzeit sie rehydrieren kann. Ein `RenderFragment` ist ein kompiliertes Delegate (beliebiger Code), also kann es nicht gemarshallt werden.

Die Lösung, die das Framework selbst verwendet, ist eine Wrapper-Komponente, die keine Parameter annimmt und den Render Mode in ihrer eigenen Definition anwendet. Genau deshalb umschließt die Blazor-Web-App-Vorlage `Router` mit einer `Routes`-Komponente:

```razor
@* WrapperComponent.razor -- holds the render mode, takes no serialized params *@
@rendermode InteractiveServer

<SharedMessage>
    <p>This child content is created inside the interactive island, not passed across it.</p>
</SharedMessage>
```

Da der `RenderFragment` jetzt *innerhalb* der interaktiven Grenze geschrieben wird, statt über sie hinweg übergeben zu werden, gibt es nichts zu serialisieren. Derselbe Trick löst die Variante, die Sie treffen, wenn Sie versuchen, ein Layout interaktiv zu machen, das von `LayoutComponentBase` ableitet, in einer App mit Interaktivität pro Seite: Umschließen Sie den interaktiven Teil, statt das Layout zu markieren.

## Fallstricke, die zur falschen Lösung führen

**Die Komponente `App` oder die Wurzel als interaktiv markieren.** Eine Wurzelkomponente wie `App` interaktiv zu machen, wird nicht unterstützt, daher können Sie den app-weiten Render Mode nicht direkt auf `App` setzen. Die Vorlage setzt ihn auf `<Routes @rendermode="..." />` und `<HeadOutlet @rendermode="..." />`. Wenn Sie `@rendermode` auf `App.razor` setzen, sehen Sie verwandte Grenzfehler; verschieben Sie es nach unten zu `Routes`.

**Ein `null`-Render-Mode ist nicht "statisch".** `@rendermode="@eineNullVariable"` zu übergeben erzwingt kein statisches Rendern. Ein `null`-Render-Mode bedeutet "von den Eltern erben". Wenn die Eltern interaktiv sind, bleibt ein `null`-Kind interaktiv. Der einzige Grund, warum das [Muster für statische SSR-Seiten](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes#static-ssr-pages-in-an-interactive-app) mit einem `null`-Modus funktioniert, ist, dass dessen Eltern (`App`) von vornherein statisch sind.

**Globale Interaktivität verbirgt die Direktive.** Wenn Sie globale Interaktivität übernommen haben, indem Sie den Modus auf `Routes` setzen, erbt ihn jede Seite. Ein *zweites* `@rendermode` zu einer Seite oder Komponente hinzuzufügen ist jetzt bestenfalls redundant und schlimmstenfalls widersprüchlich. Suchen Sie nach verirrten `@rendermode`-Direktiven in Ihrem Projekt, bevor Sie annehmen, das Framework liege falsch.

**Komponentendefinition vs. Komponenteninstanz.** Sie können `@rendermode` auf zwei Arten anwenden: auf einer Komponenten-*Instanz* (`<SharedMessage @rendermode="InteractiveServer" />`) oder auf der Komponenten-*Definition* (`@rendermode InteractiveServer` am Anfang von `SharedMessage.razor`, über die Attributform). Ein in die Definition eingebackener Modus greift überall, wo die Komponente verwendet wird, auch innerhalb einer Insel, die bereits einen anderen Modus hat. Wenn Sie keine problematische Instanz-Direktive finden, prüfen Sie die eigene `.razor`-Datei des Kindes auf eine auf Definitionsebene.

Der rote Faden jeder Variante: Entscheiden Sie, wo jede interaktive Insel beginnt, setzen Sie den Modus einmal an dieser Grenze und lassen Sie alles darin erben. Der Renderer wirft die Ausnahme genau deshalb, weil Sie versucht haben, eine Grenze mitten in einem Teilbaum neu zu zeichnen, der bereits eine hatte.

## Verwandt

- [Wie man Zustand über die statisch-zu-interaktiv-Renderinggrenze von Blazor in .NET 11 erhält](/de/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/) behandelt die Datenseite derselben Grenze, die dieser Fehler schützt.
- [Blazor Server vs. Blazor WebAssembly vs. Blazor United in .NET 11](/de/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) erklärt, welches Hostingmodell jeder Render Mode wählt und wann Sie welches nehmen sollten.
- [Eine Blazor-Server-App nach Blazor United in .NET 11 migrieren](/de/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/) zeigt Schritt für Schritt, wie man Render Modes in eine App einführt, die nie welche hatte.
- [Wie man Validierungslogik zwischen Server und Blazor WebAssembly teilt](/de/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) ist das Muster, das Sie wollen, wenn Geschwister-Inseln dieselben Regeln brauchen.
- [Blazor SSR bekommt endlich TempData in .NET 11](/de/2026/04/blazor-ssr-tempdata-dotnet-11/) ist nützlich, wenn eine statische SSR-Seite in einer ansonsten interaktiven App Daten über ein vollständiges Neuladen der Seite hinweg übergeben muss.

## Quellen

- [ASP.NET Core Blazor render modes -- Render mode propagation and inheritance](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes), Microsoft Learn (aspnetcore-11.0).
- [ASP.NET Core Blazor render modes -- Child component with a different render mode than its parent](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes#render-mode-propagation), Microsoft Learn.
- [dotnet/aspnetcore #55319 -- Blazor component cannot be nested inside a parent using a render fragment if the nested component is interactive](https://github.com/dotnet/aspnetcore/issues/55319).
</content>
