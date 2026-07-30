---
title: "Fix: JavaScript interop calls cannot be issued at this time (Blazor prerendering)"
description: "Prerendering runs your component on the server with no browser attached, so IJSRuntime throws. Move the call into OnAfterRenderAsync, gate it on RendererInfo.IsInteractive, or disable prerendering."
pubDate: 2026-07-30
template: error-page
tags:
  - "errors"
  - "blazor"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
---

The fix: you called `IJSRuntime` from `OnInitialized`, `OnInitializedAsync`, `OnParametersSet{Async}`, or a component constructor, and that code ran during prerendering, when there is no browser attached to execute JavaScript. Move the call into `OnAfterRenderAsync(bool firstRender)` guarded by `if (firstRender)`, which never runs while prerendering. If you need to branch earlier than the first interactive render, check `RendererInfo.IsInteractive` (.NET 9 and later). If the component genuinely cannot work without JavaScript, turn prerendering off for that component with `@rendermode @(new InteractiveServerRenderMode(prerender: false))`.

```text
System.InvalidOperationException: JavaScript interop calls cannot be issued at this time.
This is because the component is being statically rendered. When prerendering is enabled,
JavaScript interop calls can only be performed during the OnAfterRenderAsync lifecycle method.
   at Microsoft.AspNetCore.Components.Server.Circuits.RemoteJSRuntime.BeginInvokeJS(...)
   at Microsoft.JSInterop.JSRuntime.InvokeAsync[TValue](String identifier, Object[] args)
   at BlazorSample.Components.Pages.Theme.OnInitializedAsync()
```

This post targets .NET 11 (ASP.NET Core 11, `Microsoft.AspNetCore.Components` 11.0.x), but the behaviour is unchanged since prerendering shipped and the guidance applies to .NET 8, 9, and 10 as well. The one exception is `RendererInfo`, which arrived in .NET 9.

## Two error strings, two renderers

Search traffic for this problem lands on two different messages, and knowing which one you got tells you which hosting model threw it.

The message quoted above comes from `RemoteJSRuntime` in the Blazor Server circuit stack. It is thrown when the runtime's client proxy is null, meaning the component is executing outside a live SignalR circuit. In a classic Blazor Server app with `render-mode="ServerPrerendered"`, this is the message you see.

The second message comes from a different type entirely:

```text
System.InvalidOperationException: JavaScript interop calls cannot be issued during
server-side static rendering, because the page has not yet loaded in the browser.
Statically-rendered components must wrap any JavaScript interop calls in conditional
logic to ensure those interop calls are not attempted during static rendering.
   at Microsoft.AspNetCore.Components.Endpoints.UnsupportedJavaScriptRuntime.Microsoft.JSInterop.IJSRuntime.InvokeAsync[TValue](...)
```

`UnsupportedJavaScriptRuntime` is an internal sealed `IJSRuntime` that the endpoint renderer registers for static server-side rendering. Every method on it throws. In a Blazor Web App (the .NET 8 and later template), prerendering and static SSR both go through the endpoint renderer, so this is the message you get for a page with no render mode at all, and for the prerender pass of an `InteractiveWebAssembly` or `InteractiveAuto` component.

Both are `InvalidOperationException`, both have the same root cause, and both have the same set of fixes. If you see `UnsupportedJavaScriptRuntime` in the stack trace, note the wording: "must wrap any JavaScript interop calls in conditional logic". That phrasing matters, and it is the trap covered later in this post.

## Why prerendering has no browser to call

Prerendering is the process of statically rendering page content on the server so HTML reaches the browser as fast as possible. The component tree runs to completion, produces markup, gets written into the HTTP response, and is thrown away. Only afterwards does the Blazor script boot in the browser, open a circuit (for `InteractiveServer`) or download the runtime (for `InteractiveWebAssembly`), and re-instantiate the component interactively.

During that first pass there is no DOM, no `window`, and no transport to send a JS interop message over. `IJSRuntime` is still injectable, because the service is registered and the component compiles fine, but the implementation behind it either has no client proxy or is a placeholder whose only job is to throw a useful message. That is why this is a runtime error and never a compile-time one.

The lifecycle documentation is explicit about the consequence: `OnAfterRender` and `OnAfterRenderAsync` "aren't invoked during prerendering or static server-side rendering (static SSR) on the server because those processes aren't attached to a live browser DOM and are already complete before the DOM is updated". That property is exactly what makes `OnAfterRenderAsync` the safe place for interop.

Note also that `OnInitializedAsync` runs twice on a prerendered component: once during the static pass and once when the component goes interactive. Anything you fetch there is computed twice. That is a separate problem with a separate solution, covered in [how to persist state across the Blazor static-to-interactive render boundary](/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/).

## Minimal repro

Drop this into a Blazor Web App created from the .NET 11 template with a global or per-page interactive render mode. It fails on the first request every time.

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

The same code with `@rendermode InteractiveWebAssembly` throws the `UnsupportedJavaScriptRuntime` variant instead, because the prerender pass happens in the endpoint renderer on the server rather than in a circuit. Remove the `@rendermode` line entirely and you also get the `UnsupportedJavaScriptRuntime` variant, permanently, because the page is now static SSR and never becomes interactive.

## Fix 1: move the call into `OnAfterRenderAsync`

This is the recommended fix and the one the framework's own error message points you to. `OnAfterRenderAsync` is only called after the component has rendered interactively with a live DOM, so interop is always legal there.

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

Two details that trip people up:

The `if (firstRender)` guard is not optional hygiene. Without it you re-run the interop on every render, and since `StateHasChanged` triggers a render, you get an infinite loop.

The explicit `StateHasChanged()` is required. Unlike the other lifecycle methods, the framework deliberately does not schedule a re-render when the `Task` returned from `OnAfterRenderAsync` completes, precisely to avoid that infinite loop. If you set a field and do not call `StateHasChanged`, the UI never updates and the bug looks like "my interop returns null".

Design the markup so the prerendered output is sensible without the JavaScript result. The user sees that first pass. A placeholder, a skeleton, or a sensible default beats an empty element that pops into existence a moment later.

## Fix 2: gate on `RendererInfo.IsInteractive`

Sometimes you need the branch earlier than the first interactive render, for example to decide what to render rather than what to fetch. `ComponentBase.RendererInfo` (.NET 9 and later) exposes exactly that:

- `RendererInfo.Name` returns `Static`, `Server`, `WebAssembly`, or `WebView`.
- `RendererInfo.IsInteractive` is `true` when rendering interactively and `false` while prerendering or during static SSR.
- `ComponentBase.AssignedRenderMode` returns the component's assigned render mode, or `null` when none is assigned.

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

This is the "conditional logic" the `UnsupportedJavaScriptRuntime` message asks for. It is also the right tool for a component that must render usable static markup, for instance a form that posts normally when `AssignedRenderMode is null` and uses an event handler when it does not.

On .NET 8, where `RendererInfo` does not exist, the closest equivalent for detecting the prerender pass is a `[CascadingParameter] public HttpContext? HttpContext { get; set; }` on the component: it is non-null only during server-side rendering. It works, but it couples the component to ASP.NET Core hosting types, so prefer `RendererInfo` if you can target .NET 9 or later.

## Fix 3: disable prerendering for the component

If a component is meaningless without JavaScript (a chart wrapper, a map, a rich text editor), prerendering only buys you a flash of broken markup. Turn it off at the component definition:

```razor
@* MapView.razor *@
@* .NET 11. prerender: false is valid on all three interactive render modes *@
@rendermode @(new InteractiveServerRenderMode(prerender: false))
```

Or at the usage site:

```razor
@* .NET 11 *@
<MapView @rendermode="new InteractiveWebAssemblyRenderMode(prerender: false)" />
```

To disable it app-wide, set the mode on the `Routes` component in `App.razor`, and remember to do the same for `HeadOutlet`:

```razor
@* App.razor, .NET 11 Blazor Web App template *@
<Routes @rendermode="new InteractiveServerRenderMode(prerender: false)" />
<HeadOutlet @rendermode="new InteractiveServerRenderMode(prerender: false)" />
```

One rule that catches people: disabling prerendering only takes effect for top-level render modes. If a parent component already specifies a render mode, the prerendering settings of its children are ignored. That is the same "one subtree, one render mode" constraint behind [the render mode is not supported by the parent component's render mode error](/2026/06/fix-render-mode-is-not-supported-by-the-parent-components-render-mode-blazor/). Reach for `prerender: false` only when you own the boundary, and treat it as a last resort: you are giving up the fast first paint and the SEO benefit that prerendering exists to provide.

## The trap: `OnAfterRenderAsync` never runs on a static SSR page

This is the single most common reason "I moved it to `OnAfterRenderAsync` and it still does not work".

`OnAfterRender{Async}` is not called during prerendering *or* during static SSR. On a prerendered interactive component that is fine, because the component is re-created interactively a moment later and the method fires then. But on a page with **no** render mode, the component is only ever rendered statically. There is no second pass. `OnAfterRenderAsync` is never invoked, your interop silently never happens, and the symptom flips from a loud exception to a dead feature.

If the interop stopped throwing but also stopped running, check that the component actually has an interactive render mode, either directly, inherited from a parent, or applied globally at `Routes`. `AssignedRenderMode is null` inside the component is a one-line confirmation that you are in static SSR. Which hosting model you should be assigning is a separate decision, laid out in [Blazor Server vs Blazor WebAssembly vs Blazor United in .NET 11](/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/).

## The third variant: "the circuit has disconnected and is being disposed"

There is a third message with the same opening words, and it is a different bug with a different fix:

```text
Microsoft.JSInterop.JSDisconnectedException: JavaScript interop calls cannot be issued
at this time. This is because the circuit has disconnected and is being disposed.
```

Note the exception type: `JSDisconnectedException`, not `InvalidOperationException`. This has nothing to do with prerendering. It happens at the other end of the component's life, in server-side apps, when you call JS (or dispose an `IJSObjectReference`) after the SignalR circuit is gone, typically from `DisposeAsync` while the user is navigating away or refreshing. The fix is to catch it:

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

In a WebAssembly component there is no circuit to lose, so drop the `try`/`catch` and just dispose the module. And if you need to run real cleanup in the browser after the connection is gone, JS interop is the wrong tool: use the `MutationObserver` pattern or a custom element's `disconnectedCallback` on the client instead.

## Gotchas that produce the same exception

**Third-party component libraries.** MudBlazor, Radzen, and similar libraries call interop internally to measure viewports, position popovers, or read browser capabilities. If the exception's stack trace bottoms out in a library type rather than your code, the fix is usually a library-level switch or disabling prerendering for the page that hosts the component. Check the library's release notes first: most have added prerender guards since .NET 8.

**Injected services that call JS.** A scoped service wrapping `localStorage` will throw from wherever you first call it, which is often `OnInitializedAsync`. The service cannot fix this on your behalf; the call site has to be moved or gated. Some libraries (Blazored.LocalStorage among them) surface this as guidance to only touch storage after the first render, for exactly this reason.

**`IJSInProcessRuntime` on WebAssembly.** Synchronous interop is only available in client-side components once the WebAssembly runtime is running. During the server-side prerender pass of an `InteractiveWebAssembly` component, casting `IJSRuntime` to `IJSInProcessRuntime` fails or the call throws. Use `OperatingSystem.IsBrowser()` when you need to know whether the code is actually executing on WebAssembly.

**Interactive routing skips prerendering.** If you reach the page through an internal enhanced navigation in an app whose `Routes` component is interactive, prerendering does not happen at all, so the bug only reproduces on a full page load. A component that works when you click a link and throws when you press F5 is almost always this.

**Long-running work in initialization.** Because prerendering waits for quiescence, a slow `OnInitializedAsync` blocks the whole prerendered response. That is not this exception, but it is the neighbouring problem that streaming rendering exists to solve, and it often shows up in the same components.

## Related

- [How to persist state across the Blazor static-to-interactive render boundary in .NET 11](/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/) solves the double-initialization half of the prerender boundary.
- [Fix: its render mode is not supported by the parent component's render mode (Blazor)](/2026/06/fix-render-mode-is-not-supported-by-the-parent-components-render-mode-blazor/) explains the one-subtree-one-render-mode rule that limits where `prerender: false` takes effect.
- [Blazor Server vs Blazor WebAssembly vs Blazor United in .NET 11](/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) covers which render mode to assign in the first place.
- [Migrate a Blazor Server app to Blazor United in .NET 11](/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/) walks through introducing render modes to an app that previously had none.
- [How to share validation logic between server and Blazor WebAssembly](/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) is the pattern for logic that must run on both sides of the boundary.

## Sources

- [Prerender ASP.NET Core Razor components](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/prerender) (Microsoft Learn, .NET 10/11)
- [ASP.NET Core Razor component lifecycle](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/lifecycle) (Microsoft Learn)
- [ASP.NET Core Blazor render modes](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes) (Microsoft Learn), "Detect rendering location, interactivity, and assigned render mode at runtime"
- [ASP.NET Core Blazor JavaScript interoperability (JS interop)](https://learn.microsoft.com/en-us/aspnet/core/blazor/javascript-interoperability/) (Microsoft Learn), "JavaScript interop calls without a circuit"
- [`RemoteJSRuntime.cs`](https://github.com/dotnet/aspnetcore/blob/main/src/Components/Server/src/Circuits/RemoteJSRuntime.cs) and [`UnsupportedJavaScriptRuntime.cs`](https://github.com/dotnet/aspnetcore/blob/main/src/Components/Endpoints/src/DependencyInjection/UnsupportedJavaScriptRuntime.cs) in `dotnet/aspnetcore`, where the two messages are thrown
- [dotnet/aspnetcore #24320](https://github.com/dotnet/aspnetcore/issues/24320), the long-running issue tracking this error
