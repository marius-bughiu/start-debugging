---
title: "Fix: its render mode is not supported by the parent component's render mode (Blazor)"
description: "You put @rendermode on a child whose parent is already interactive. A subtree has exactly one render mode. Remove the child directive or move it to the boundary."
pubDate: 2026-06-09
template: error-page
tags:
  - "errors"
  - "blazor"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
---

The fix: you applied `@rendermode` to a child component that lives inside a subtree which already has an interactive render mode, and the two modes do not match. A Blazor subtree has exactly one render mode, fixed at its interactive boundary. You cannot switch from `InteractiveServer` to `InteractiveWebAssembly` (or back) partway down the tree. Remove the `@rendermode` directive from the child so it inherits the parent's mode, or move the render mode up to the single component that owns the interactive boundary. If the modes are actually the same, the real problem is a duplicate `@rendermode` on a nested component, and you should delete the inner one.

```text
System.InvalidOperationException: Cannot create a component of type
'BlazorSample.Components.SharedMessage' because its render mode
'Microsoft.AspNetCore.Components.Web.InteractiveWebAssemblyRenderMode'
is not supported by Interactive Server rendering.
   at Microsoft.AspNetCore.Components.Rendering.ComponentState..ctor(...)
   at Microsoft.AspNetCore.Components.RenderTree.Renderer.AddToRenderQueue(...)
   at Microsoft.AspNetCore.Components.Endpoints.EndpointHtmlRenderer...
```

This guide is written against .NET 11 (ASP.NET Core 11, `Microsoft.AspNetCore.Components` 11.0.0), but the rule has been identical since render modes shipped in .NET 8. The message text varies depending on which combination you hit, so search traffic lands here under several phrasings: "its render mode is not supported by Interactive Server rendering", "render mode is not supported by the parent component's render mode", and the closely related "Cannot pass the parameter X to component Y with rendermode InteractiveServerRenderMode". All three come from the same underlying constraint, and the last one has a different fix, covered below.

## One subtree, one render mode

In a Blazor Web App, interactivity is not a per-component toggle that you sprinkle wherever you like. When a component declares `@rendermode InteractiveServer` or `@rendermode InteractiveWebAssembly`, it creates an interactive *boundary*. Everything rendered inside that boundary -- every child, grandchild, and the content they render -- runs under that one render mode. The boundary is the root of an interactive *island*, and an island has a single hosting model: either a SignalR circuit on the server, or a WebAssembly runtime in the browser. There is no mechanism to run half an island on the server and half in the browser, because the two share a live component state tree and a single dispatcher.

That is why the rules in the official docs are stated as absolutes. From the [Blazor render modes documentation](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes):

- Render modes propagate down the component hierarchy.
- The default render mode is Static.
- You can't switch to a different interactive render mode in a child component. For example, a Server component can't be a child of a WebAssembly component.

So when the renderer walks the tree, reaches your child component, and finds a `@rendermode` that conflicts with the island it is already inside, it cannot honor it. It throws rather than silently picking one. The exception is constructed when the framework tries to create the component state for the offending child, which is why the stack trace points into `ComponentState` and the renderer, not into your code.

A useful mental model: `@rendermode` answers the question "where does this island start and what hosts it?" It is not a property of every component. Most components should carry no render mode at all and simply inherit whatever island they land in.

## The minimal repro

A page is interactive on the server, and it nests a component that asks for WebAssembly:

```razor
@* RenderMode11.razor -- .NET 11, ASP.NET Core 11 -- throws at render time *@
@page "/render-mode-11"
@rendermode InteractiveServer

<h1>Dashboard</h1>

<SharedMessage @rendermode="InteractiveWebAssembly" />
```

`SharedMessage` itself is render-mode agnostic (it declares no mode of its own):

```razor
@* SharedMessage.razor -- .NET 11 *@
<p>@message</p>
<button @onclick="UpdateMessage">Update</button>

@code {
    private string message = "Not updated yet.";
    private void UpdateMessage() => message = "Updated!";
}
```

Navigate to `/render-mode-11` and the page fails to render with:

```text
Cannot create a component of type 'SharedMessage' because its render mode
'InteractiveWebAssemblyRenderMode' is not supported by Interactive Server rendering.
```

The parent owns a server island. The child demanded a WebAssembly island nested inside it. That nesting is not representable, so it throws.

## The fix, ranked

**1. Remove the render mode from the child (most common).** Nine times out of ten the child should never have had a `@rendermode` at all. It was copied from a sample, or added defensively "to make it interactive", when in fact it inherits interactivity from its parent for free. Delete the directive:

```razor
@* RenderMode11.razor -- fixed: child inherits the parent's server island *@
@page "/render-mode-11"
@rendermode InteractiveServer

<h1>Dashboard</h1>

<SharedMessage />
```

Now `SharedMessage` runs interactively over the same SignalR connection as its parent. The button works. This is the [render mode inheritance](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes#render-mode-inheritance) behavior the docs describe: a component placed inside an interactive parent adopts that parent's mode.

**2. Make the two modes agree.** If you genuinely wanted WebAssembly here, the *parent* is what is wrong. Set the whole island to WebAssembly at its boundary and drop the child directive:

```razor
@* fixed: the whole island is WebAssembly *@
@page "/render-mode-11"
@rendermode InteractiveWebAssembly

<SharedMessage />
```

Remember that a WebAssembly island can only live in the client project (the one whose name ends in `.Client`). Move both the page and `SharedMessage` there, or this fix trades one error for `Could not find any interactive components`.

**3. Split the island so the two modes are siblings, not nested.** Server and WebAssembly content can coexist on the same page as long as neither is *inside* the other. Make both children of a static parent:

```razor
@* fixed: two sibling islands under a static page *@
@page "/render-mode-11"

@* no @rendermode here -- the page stays static SSR *@
<ServerWidget @rendermode="InteractiveServer" />
<WasmWidget @rendermode="InteractiveWebAssembly" />
```

The page itself renders statically, and it hosts two independent islands. This is the correct pattern when one widget needs server-only services (a database, HTTP cookies) and another needs to run offline in the browser. The constraint is only about *nesting* mismatched modes, not about having both on a page.

**4. Use `InteractiveAuto` at the boundary, not in the middle.** `InteractiveAuto` is still a single render mode for the island -- it picks Server for the first visit and WebAssembly once the bundle is cached. You set it once, at the boundary, exactly like the other two. It does not let you mix modes within a subtree.

## The lookalike: "Cannot pass the parameter ... with rendermode"

A different but constantly-confused error has nearly the same trigger. When an interactive child sits under a *static* parent and you pass it a `RenderFragment` (child content), you get:

```text
System.InvalidOperationException: Cannot pass the parameter 'ChildContent' to
component 'SharedMessage' with rendermode 'InteractiveServerRenderMode'. This is
because the parameter is of the delegate type
'Microsoft.AspNetCore.Components.RenderFragment', which is arbitrary code and
cannot be serialized.
```

Here the modes do not conflict; the *parameter* cannot cross the boundary. Parameters handed from a static parent into an interactive child must be JSON serializable, because the static server has to serialize them into the page so the interactive runtime can rehydrate them. A `RenderFragment` is a compiled delegate -- arbitrary code -- so it cannot be marshaled.

The fix the framework itself uses is a wrapper component that takes no parameters and applies the render mode on its own definition. This is exactly why the Blazor Web App template wraps `Router` inside a `Routes` component:

```razor
@* WrapperComponent.razor -- holds the render mode, takes no serialized params *@
@rendermode InteractiveServer

<SharedMessage>
    <p>This child content is created inside the interactive island, not passed across it.</p>
</SharedMessage>
```

Because the `RenderFragment` is now authored *inside* the interactive boundary rather than passed across it, there is nothing to serialize. The same trick resolves the variant you hit when you try to make a layout that derives from `LayoutComponentBase` interactive in a per-page interactivity app: wrap the interactive part instead of marking the layout.

## Gotchas that send people to the wrong fix

**Marking the `App` or root component interactive.** Making a root component such as `App` interactive is not supported, so you cannot set the app-wide render mode on `App` directly. The template sets it on `<Routes @rendermode="..." />` and `<HeadOutlet @rendermode="..." />` instead. If you put `@rendermode` on `App.razor` you will see related boundary errors -- move it down to `Routes`.

**A `null` render mode is not "static".** Passing `@rendermode="@someNullVariable"` does not force static rendering. A `null` render mode means "inherit from the parent". If the parent is interactive, a `null` child stays interactive. The only reason the [static SSR pages pattern](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes#static-ssr-pages-in-an-interactive-app) works with a `null` mode is that its parent (`App`) is static to begin with.

**Global interactivity hides the directive.** If you adopted global interactivity by setting the mode on `Routes`, every page inherits it. Adding a *second* `@rendermode` to a page or component is now redundant at best and conflicting at worst. Search your project for stray `@rendermode` directives before assuming the framework is wrong.

**Component definition vs component instance.** You can apply `@rendermode` two ways: on a component *instance* (`<SharedMessage @rendermode="InteractiveServer" />`) or on the component *definition* (`@rendermode InteractiveServer` at the top of `SharedMessage.razor`, via the attribute form). A mode baked into the definition fires everywhere the component is used, including inside an island that already has a different mode. If you cannot find an offending instance directive, check the child's own `.razor` file for a definition-level one.

The throughline for every variant: decide where each interactive island begins, set the mode once at that boundary, and let everything inside inherit. The renderer throws precisely because you tried to redraw a boundary in the middle of a subtree that already had one.

## Related

- [How to persist state across the Blazor static-to-interactive render boundary in .NET 11](/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/) covers the data side of the same boundary this error guards.
- [Blazor Server vs Blazor WebAssembly vs Blazor United in .NET 11](/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) explains which hosting model each render mode picks and when to reach for which.
- [Migrate a Blazor Server app to Blazor United in .NET 11](/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/) walks through introducing render modes into an app that never had them.
- [How to share validation logic between server and Blazor WebAssembly](/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) is the pattern you want when sibling islands need the same rules.
- [Blazor SSR finally gets TempData in .NET 11](/2026/04/blazor-ssr-tempdata-dotnet-11/) is useful when a static SSR page in an otherwise interactive app needs to pass data across a full-page reload.

## Sources

- [ASP.NET Core Blazor render modes -- Render mode propagation and inheritance](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes), Microsoft Learn (aspnetcore-11.0).
- [ASP.NET Core Blazor render modes -- Child component with a different render mode than its parent](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes#render-mode-propagation), Microsoft Learn.
- [dotnet/aspnetcore #55319 -- Blazor component cannot be nested inside a parent using a render fragment if the nested component is interactive](https://github.com/dotnet/aspnetcore/issues/55319).
</content>
</invoke>
