---
title: "What is a Blazor render mode and which one runs my component?"
description: "A render mode decides where a Razor component executes and whether it is interactive. Here are the four modes in .NET 11, the propagation rules that decide what your component inherits, and the RendererInfo and AssignedRenderMode properties that tell you at runtime which one actually won."
pubDate: 2026-09-05
tags:
  - "blazor"
  - "aspnetcore"
  - "dotnet-11"
  - "csharp"
---

A render mode is the per-component setting in a Blazor Web App that decides two things: where the component executes (server or browser) and whether it can respond to UI events. There are four: Static Server, Interactive Server, Interactive WebAssembly, and Interactive Auto. You assign one with the `@rendermode` directive or directive attribute, the default is Static Server, and modes propagate down the component tree so most components never declare one. To find out which mode is actually running a given component, read `ComponentBase.AssignedRenderMode` and `ComponentBase.RendererInfo` from inside the component: `AssignedRenderMode` is `null` for static SSR, and `RendererInfo.IsInteractive` is `false` while prerendering even on a component whose assigned mode is interactive.

Everything here targets .NET 11 and ASP.NET Core 11, with C# 14. Render modes exist only in a Blazor Web App (the unified template introduced in .NET 8). A standalone Blazor WebAssembly app or a legacy Blazor Server app has one hosting model for the whole app and no `@rendermode` directive at all. Where behaviour changed in .NET 10 or .NET 11, I say so.

## The four modes, and the two axes they vary on

| Mode | Executes on | Interactive | Requires a `.Client` project |
| --- | --- | --- | --- |
| Static Server | Server | No | No |
| Interactive Server | Server, over a SignalR circuit | Yes | No |
| Interactive WebAssembly | Browser | Yes | Yes |
| Interactive Auto | Server first, browser on later visits | Yes | Yes |

Static Server, usually written static SSR, renders the component to the HTTP response stream and stops. There is no circuit, no .NET runtime in the browser, and no event handling. An `@onclick` on a statically rendered button compiles fine and does nothing at runtime. This is the default, and for content pages it is the right default: no connection to hold open, no WebAssembly payload to download.

Interactive Server keeps the component alive on the server and pipes DOM events and diffs over a SignalR connection. Interactive WebAssembly downloads the .NET runtime and your app bundle and runs the component in the browser. Interactive Auto is not a third runtime: it renders with Interactive Server on first visit while the WebAssembly bundle downloads in the background, then uses WebAssembly on subsequent visits once the bundle is cached.

One property of Auto surprises people. Per the [render modes documentation](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes), Auto never switches the render mode of a component already on the page. It makes one decision when the component first renders and keeps that mode for as long as the component lives. It also prefers to match the mode of interactive components already on the page, so that a second .NET runtime that shares no state with the first one is not introduced mid-page. If you are still choosing between hosting models rather than debugging one, the longer treatment is in [Blazor Server vs WebAssembly vs Blazor United in .NET 11](/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/).

Interactive modes need the matching services and endpoints registered in `Program.cs`, or the `@rendermode` is meaningless:

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

## Three places a render mode can be set

The mode reaching a component can come from three different syntactic positions, and they are not interchangeable.

**On a component instance**, as a directive attribute, where the component is used:

```razor
@* .NET 11 -- any render mode instance is allowed here *@
<Dialog @rendermode="InteractiveServer" />
```

**On a component definition**, as a directive at the top of the `.razor` file. This is what you use for a routable page, because nothing instantiates a page by hand:

```razor
@* .NET 11 -- Pages/Counter.razor *@
@page "/counter"
@rendermode InteractiveServer
```

`@rendermode` is both a Razor directive and a Razor directive attribute, and the difference matters exactly once: the directive form requires a static render mode instance, while the directive attribute form takes any instance, including one you construct with options.

**For the whole app**, by putting the mode on the `Routes` component in `App.razor`. The router propagates its mode to every page it routes:

```razor
@* .NET 11 -- Components/App.razor *@
<Routes @rendermode="InteractiveServer" />
<HeadOutlet @rendermode="InteractiveServer" />
```

Setting a mode on the root `App` component itself is not supported. That is why global interactivity is expressed on `Routes` and `HeadOutlet` rather than one directive at the top. If you are moving a legacy app into this model, the mechanics are in [migrating a Blazor Server app to Blazor Web App in .NET 11](/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/).

You can also compute the mode, which is how you carve static SSR pages out of an otherwise interactive app:

```razor
@* .NET 11 -- Components/App.razor *@
<Routes @rendermode="PageRenderMode" />

@code {
    private IComponentRenderMode? PageRenderMode => InteractiveServer;
}
```

## The propagation rules that decide what your component gets

Most components in a real app have no `@rendermode` at all. They inherit, and the four rules are short:

1. The default render mode is Static.
2. A component with no `@rendermode` takes the mode of its parent.
3. You cannot switch to a different interactive mode in a child. An Interactive Server component cannot host an Interactive WebAssembly child.
4. Parameters passed from a static parent to an interactive child must be JSON serializable.

Rule 2 is why a shared component that works on one page and is inert on another is almost never the component's fault. Drop this in a page with no mode and the button does nothing:

```razor
@* .NET 11 -- Components/SharedMessage.razor, render-mode agnostic *@
<button @onclick="UpdateMessage">Click me</button> @message

@code {
    private string message = "Not updated yet.";

    private void UpdateMessage() => message = "Somebody updated me!";
}
```

Put the same component under `@rendermode InteractiveServer` and it works. Nothing about the component changed. The correct instinct on "my button does nothing" is to look up the tree, not at the handler.

Rule 3 produces a runtime error rather than silence. A page pinned to Interactive Server with a WebAssembly child fails with `Cannot create a component of type '...' because its render mode 'Microsoft.AspNetCore.Components.Web.InteractiveWebAssemblyRenderMode' is not supported by Interactive Server rendering.` Sibling components with different interactive modes on a static page are fine; nesting one inside the other is not.

Rule 4 is the one that produces the most confusing message. Passing child content across a static-to-interactive boundary throws:

> System.InvalidOperationException: Cannot pass the parameter 'ChildContent' to component 'SharedMessage' with rendermode 'InteractiveServerRenderMode'. This is because the parameter is of the delegate type 'Microsoft.AspNetCore.Components.RenderFragment', which is arbitrary code and cannot be serialized.

An interactive child of a static parent is a root component for its own renderer, and its parameters have to cross a process (or a network) boundary as JSON. A `RenderFragment` is a delegate, and a delegate does not serialize. The historical fix is to move the boundary up: wrap the child in a component that takes no render fragment, and put `@rendermode` on the wrapper.

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

This is exactly why the template ships a `Routes.razor` wrapping the `Router` instead of putting `@rendermode` on `Router` directly.

## The .NET 11 change: interactive layouts finally work

Rule 4 had a well-known casualty. `LayoutComponentBase` exposes `@Body` as a `RenderFragment`, so putting `@rendermode InteractiveServer` on `MainLayout` in a per-page interactive app threw the same serialization error, with `'Body'` as the parameter name. Every workaround for the last three major versions has been some form of "put the interactivity in a wrapper or a Blazor section instead."

That restriction is gone in .NET 11. The Microsoft docs now scope the entire "Statically-rendered layout components" limitation to versions `>= 8.0 < 11.0` and state that it applies "prior to the release of .NET 11". The underlying work is [dotnet/aspnetcore#52768](https://github.com/dotnet/aspnetcore/issues/52768), shipped in .NET 11 Preview 5: when a component with a render mode receives a `RenderFragment` parameter, the framework now invokes the fragment on the static side, serializes the resulting render tree as JSON, and rehydrates it into a `RenderFragment` delegate on the interactive side. To keep this honest, the compiler requires such wrapped functions to be static local functions, so they cannot close over server state that would not survive the trip.

The practical effect: on .NET 11 you can write

```razor
@* .NET 11 only -- Components/Layout/MainLayout.razor *@
@inherits LayoutComponentBase
@rendermode InteractiveServer

<div class="page">
    <NavMenu />
    <main>@Body</main>
</div>
```

and get an interactive nav bar without the section-based wrapper dance. On .NET 10 and earlier the same file throws at runtime. State the target framework before you copy a layout snippet off the internet, because this one flipped.

## Which mode is running my component right now?

`ComponentBase` exposes two properties for this, both available since .NET 9. Neither requires injection.

`AssignedRenderMode` returns the mode the component was assigned: an `InteractiveServerRenderMode`, `InteractiveWebAssemblyRenderMode`, or `InteractiveAutoRenderMode` instance, or `null` when the component is running under static SSR.

`RendererInfo` describes the renderer actually executing the component. `RendererInfo.Name` is one of `Static`, `Server`, `WebAssembly`, or `WebView`. `RendererInfo.IsInteractive` is `true` only when the component is genuinely interactive, and `false` both for static SSR and during the prerender pass of an interactive component.

That last distinction is the useful one. A component with `@rendermode InteractiveServer` renders twice: once during prerendering, where `AssignedRenderMode` is an `InteractiveServerRenderMode` but `RendererInfo.IsInteractive` is `false`, and again over the circuit, where both agree. So:

- Use `AssignedRenderMode is null` to ask "will this component ever be interactive?" That is a decision about markup shape.
- Use `RendererInfo.IsInteractive` to ask "can I handle events right now?" That is a decision about the current pass.

A diagnostic component you can drop anywhere in the tree to see what a subtree inherited:

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

Because the probe declares no mode of its own, it inherits, and it reports exactly what its host page passed down. That is a faster answer than reading `@rendermode` directives up the tree, especially in an app that assigns modes programmatically.

The documented use for `AssignedRenderMode` is degrading gracefully: render a real HTML `form` when the component is static, and bound inputs with an event handler when it is not.

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

And the documented use for `IsInteractive` is suppressing controls that would silently do nothing during the prerender pass:

```razor
@* .NET 11 *@
<button @onclick="Send" disabled="@(!RendererInfo.IsInteractive)">
    Send
</button>
```

## Prerendering, and why your initializer runs twice

Prerendering is on by default for all three interactive modes. The server renders the component statically into the initial HTML response, then the interactive renderer takes over and renders it again. `OnInitializedAsync` therefore runs twice, once per renderer, which is the actual cause of the "my API is called twice" and "the UI flickers back to the loading state" complaints.

`OnAfterRender` and `OnAfterRenderAsync` are the exception: they are not called during prerendering at all. That is also why JS interop from `OnInitializedAsync` throws, since there is no browser to call into yet, covered in detail in [JavaScript interop calls cannot be issued at this time](/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/).

You have two responses. Turn prerendering off for the component:

```razor
@* .NET 11 -- component definition form *@
@rendermode @(new InteractiveServerRenderMode(prerender: false))
```

```razor
@* .NET 11 -- component instance form *@
<Dialog @rendermode="new InteractiveServerRenderMode(prerender: false)" />
```

Or, better for anything user-visible, keep prerendering and carry the state across the boundary with the `[PersistentState]` attribute (`[SupplyParameterFromPersistentComponentState]` under its old name; `PersistentStateAttribute` is the .NET 10 and later API):

```csharp
// .NET 11, C# 14
[PersistentState]
public int? CurrentCount { get; set; }
```

The full treatment, including `RestoreBehavior` and `AllowUpdates`, is in [how to persist state across the Blazor static-to-interactive render boundary in .NET 11](/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/).

One trap on the disable path: `prerender: false` only takes effect on a top-level render mode. If a parent component already declared a mode, the prerender setting on its children is ignored outright. Setting it on a nested component and seeing prerendering continue is not a bug.

## Static SSR loses more than interactivity

Under static SSR the request is handled by the ASP.NET Core middleware pipeline, and Razor components are not rendered during that processing. So Blazor's own router features do not participate. In .NET 10 and .NET 11, `<NotAuthorized>` content on `AuthorizeRouteView` is not shown for statically rendered pages; unauthorized requests are handled by authorization middleware instead, typically through a custom `IAuthorizationMiddlewareResultHandler`. Prior to .NET 10, `<NotFound>` content had the same problem. An app with root-level interactivity does not hit this, because after the first static render the middleware pipeline is no longer involved.

.NET 11 also adds a render-mode-adjacent tool worth knowing: the `CacheView` component caches the rendered output of a component subtree during static SSR and replays the markup on a hit without instantiating the child components or running their lifecycle methods.

```razor
@* .NET 11 *@
<CacheView VaryByQuery="category" ExpiresAfter="TimeSpan.FromMinutes(5)">
    <ProductList Category="@Category" />
</CacheView>
```

It only applies to static SSR, which is one more reason to leave content pages on the default mode instead of making the whole app interactive out of habit.

## The short version

A render mode is where the component runs and whether it can handle events. Assign it on an instance, on a definition, or on `Routes` for the whole app; everything without a directive inherits from its parent, and the default is static. A dead button means look up the tree. A serialization exception means a `RenderFragment` crossed a static-to-interactive boundary, which on .NET 10 and earlier includes any interactive layout and on .NET 11 no longer does. A duplicated API call means prerendering, and the fix is `[PersistentState]` far more often than `prerender: false`. When you need the ground truth rather than a guess, read `AssignedRenderMode` for the assignment and `RendererInfo.IsInteractive` for the current pass, and remember they disagree on purpose during the prerender.

## Related

- [Blazor Server vs Blazor WebAssembly vs Blazor United in .NET 11](/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/)
- [Migrate a Blazor Server app to Blazor United (Blazor Web App) in .NET 11](/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/)
- [How to persist state across the Blazor static-to-interactive render boundary in .NET 11](/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/)
- [Fix: JavaScript interop calls cannot be issued at this time (Blazor prerendering)](/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/)
- [Fix: Attempting to reconnect to the server after a Blazor Server circuit disconnects](/2026/08/fix-attempting-to-reconnect-to-the-server-after-a-blazor-circuit-disconnects/)

## Sources

- [ASP.NET Core Blazor render modes -- Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes?view=aspnetcore-11.0)
- [Prerender ASP.NET Core Razor components -- Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/prerender?view=aspnetcore-11.0)
- [ASP.NET Core Blazor layouts -- Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/layouts?view=aspnetcore-11.0)
- [Persist state across prerendering -- Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/blazor/state-management/prerendered-state-persistence?view=aspnetcore-11.0)
- [What's new in ASP.NET Core in .NET 11 -- Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-11)
- [Support serializing RenderFragment parameters -- dotnet/aspnetcore #52768](https://github.com/dotnet/aspnetcore/issues/52768)
- [ComponentBase.AssignedRenderMode Property -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.components.componentbase.assignedrendermode)
- [RendererInfo Struct -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.components.rendererinfo)
