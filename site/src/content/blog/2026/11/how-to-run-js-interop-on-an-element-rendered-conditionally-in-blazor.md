---
title: "How to Run JS Interop on an Element That Was Just Rendered Conditionally in Blazor"
description: "Blazor has no nextTick(), but you can build one: a TaskCompletionSource completed in OnAfterRenderAsync. Here is why the @ref is null or stale right after you flip an @if, which common workarounds fail, and a NextRenderAsync helper verified on .NET 10 in both InteractiveServer and InteractiveWebAssembly."
pubDate: 2026-11-10
template: how-to
tags:
  - "blazor"
  - "aspnet-core"
  - "dotnet-10"
  - "javascript-interop"
  - "csharp"
---

**Short answer:** Blazor has no `nextTick()`, and the element behind an `@ref` does not exist until the render that creates it has been applied to the DOM. Flip your `@if` condition, then `await` a task that you complete from `OnAfterRenderAsync`, and only then call `IJSRuntime`. A ten-line `NextRenderAsync()` helper (below) does this. It worked in every case tested on .NET 10 (`Microsoft.AspNetCore.Components.WebAssembly` 10.0.10, ASP.NET Core runtime 10.0.10) in both `InteractiveServer` and `InteractiveWebAssembly`, including calls that do not come from an event handler, where the popular `await Task.Yield()` trick fails.

The question shows up in many shapes: [a Vue developer asking for the `nextTick()` equivalent](https://stackoverflow.com/questions/79962461) so a slide-down animation can start on a list that is rendered inside `@if`, someone trying to focus an input that was just revealed, someone initializing a chart in a panel that appears after a click. All of them hit the same wall: the JS function receives `null` (or something that is not an element), and nothing happens.

## Why the ElementReference is empty or stale right after the @if flips

An `ElementReference` field is not the element. It is a struct holding an ID string, and that ID is assigned by the renderer while it diffs the render tree. In `RenderTreeDiffBuilder.InitializeNewElementReferenceCaptureFrame` every newly inserted element with an `@ref` gets a fresh ID from `ElementReference.CreateWithUniqueId`, and the JS side finds the element by an attribute carrying that ID. Two consequences follow:

1. Before the first render of the element, the field is `default(ElementReference)` and its `Id` is `null`.
2. After the element is removed and the `@if` turns true again, the field still holds the **old** ID until the next render runs. The old element is gone, so JS resolves that ID to `null`.

Setting `show = true` in C# does neither the diff nor the DOM update. Inside an event handler, the render is queued: `ComponentBase` calls `StateHasChanged()` after your handler returns or first yields (see `IHandleEvent.HandleEventAsync` in [ComponentBase.cs](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Components/Components/src/ComponentBase.cs)), and the renderer processes the queue only after the handler has handed control back. Calling `StateHasChanged()` yourself inside the handler does not change that, because the renderer is already in the middle of an event batch and simply queues the component again.

The docs say it plainly in [Capture references to elements](https://learn.microsoft.com/en-us/aspnet/core/blazor/javascript-interoperability/call-javascript-from-dotnet?view=aspnetcore-10.0#capture-references-to-elements): the reference should be used in `OnAfterRenderAsync` "because there's no HTML DOM element until after the component is rendered."

## The repro: four attempts, two render modes

The test app is `dotnet new blazor --interactivity Auto` on SDK 10.0.302 (macOS arm64), with one shared component hosted by a page set to `@rendermode InteractiveServer` and another set to `@rendermode InteractiveWebAssembly`. A JS probe reports what the browser actually receives:

```js
// wwwroot or inline <script> after blazor.web.js
window.probe = (el) => {
    if (el === null || el === undefined) return "null";
    if (!(el instanceof Element)) return "not an Element: " + JSON.stringify(el);
    return "Element connected=" + el.isConnected + " height=" + el.offsetHeight;
};

window.slideDown = (el, ms) => {
    if (!(el instanceof Element)) return false;
    el.animate(
        [{ height: "0px", overflow: "hidden" }, { height: el.scrollHeight + "px", overflow: "hidden" }],
        { duration: ms, easing: "ease-out" });
    return true;
};
```

The component conditionally renders a list and tries to reach it right after flipping the flag:

```razor
@* .NET 10, Blazor Web App *@
@inject IJSRuntime JS

<button @onclick="Naive">Naive</button>
<button @onclick="StateHasChangedThenCall">StateHasChanged + call</button>
<button @onclick="YieldThenCall">Task.Yield + call</button>
<button @onclick="Hide">Hide</button>

@if (show)
{
    <ul @ref="list" class="errors">
        @foreach (var e in errors)
        {
            <li>@e</li>
        }
    </ul>
}

@code {
    private bool show;
    private ElementReference list;
    private readonly string[] errors = ["Name is required", "Email is not valid"];

    private async Task Naive()
    {
        show = true;
        Console.WriteLine(await JS.InvokeAsync<string>("probe", list));
    }

    private async Task StateHasChangedThenCall()
    {
        show = true;
        StateHasChanged();
        Console.WriteLine(await JS.InvokeAsync<string>("probe", list));
    }

    private async Task YieldThenCall()
    {
        show = true;
        await Task.Yield();
        Console.WriteLine(await JS.InvokeAsync<string>("probe", list));
    }

    private void Hide() => show = false;
}
```

Clicking each button (with **Hide** in between, so every attempt starts from a removed element) produced this in the browser, identical in both modes except for the ID format:

| Attempt | `list.Id` before the call | What JS received |
|---|---|---|
| Naive, very first click | `null` | `not an Element: {"__internalId":null}` |
| Naive, after a Hide | old ID (`856631ae-...` on Server, `2` on WASM) | `null` |
| `StateHasChanged()` then call | old ID | `null` |
| `await Task.Yield()` then call | new ID | `Element connected=true` |

Two details are worth noticing. First, a never-assigned reference does not arrive in JS as `null`. The JS reviver in [ElementReferenceCapture.ts](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Components/Web.JS/src/Rendering/ElementReferenceCapture.ts) only converts `{"__internalId": "..."}` into an element when the ID is a string, so a `null` ID passes through as a plain object. A guard like `if (!el) return;` in your JS does not catch it, and a call like `el.animate(...)` fails with a `TypeError` instead. Second, the IDs differ by host: on WebAssembly `ElementReference.CreateUniqueId` uses a counter (`OperatingSystem.IsBrowser()` branch), on Server it is a GUID. Do not rely on either format.

## Why Task.Yield works in a click handler and fails everywhere else

`await Task.Yield()` worked in both modes above, which is why it gets recommended. It works by accident: when the click handler yields, `HandleEventAsync` sees an incomplete task, calls `StateHasChanged()`, and the renderer processes that render before your continuation runs. On WebAssembly the DOM is patched synchronously during that render. On Server the batch goes out over the same SignalR connection ahead of your JS call, and in this test the browser had applied it by the time the JS ran.

Take away the event handler and the trick falls apart. A timer callback, a service event, or a message from a hub reaches the component through `InvokeAsync`, and nothing renders on your behalf:

```csharp
// .NET 10: simulates a timer or a service event
private void ExternalYield() => _ = Task.Run(async () =>
{
    await Task.Delay(50);
    await InvokeAsync(async () =>
    {
        show = true;
        await Task.Yield();                       // no render was queued
        var result = await JS.InvokeAsync<string>("probe", list);
        StateHasChanged();
    });
});
```

In both render modes this returned `not an Element: {"__internalId":null}` on the first run and `null` (stale ID) after a Hide. Adding `StateHasChanged()` before the yield would happen to fix it here, but you would then depend on undocumented ordering between the render pipeline and your continuation on two different hosts. `OnAfterRenderAsync` is the documented contract, so build on that.

## A NextRenderAsync helper: Blazor's nextTick()

The idea is to request a render and hand back a task that completes when `OnAfterRenderAsync` runs for that render:

```csharp
// .NET 10, C# 14
using Microsoft.AspNetCore.Components;

public abstract class NextRenderComponentBase : ComponentBase, IDisposable
{
    private TaskCompletionSource? _nextRender;

    /// Queue a render and complete after OnAfterRenderAsync.
    protected Task NextRenderAsync()
    {
        // Capture the task first: StateHasChanged can render and run
        // OnAfterRenderAsync synchronously (WebAssembly, outside an event handler).
        var pending = _nextRender ??= new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        StateHasChanged();
        return pending.Task;
    }

    protected override Task OnAfterRenderAsync(bool firstRender)
    {
        var pending = _nextRender;
        _nextRender = null;
        pending?.TrySetResult();
        return Task.CompletedTask;
    }

    public virtual void Dispose()
    {
        _nextRender?.TrySetCanceled();
        _nextRender = null;
    }
}
```

The recipe:

1. Derive the component from `NextRenderComponentBase` (or copy its three members into the component).
2. Flip the state that controls the `@if`.
3. `await NextRenderAsync()`, which requests a render and waits for `OnAfterRenderAsync`.
4. Call `IJSRuntime` with the `ElementReference`, which now holds the new element's ID.

In code it reads like the Vue version:

```razor
@* .NET 10 *@
@inherits NextRenderComponentBase
@inject IJSRuntime JS

@code {
    private async Task ShowErrorsAsync()
    {
        show = true;
        await NextRenderAsync();                 // the <ul> now exists in the DOM
        await JS.InvokeVoidAsync("slideDown", list, 300);
    }
}
```

With this helper, every case in the repro, the click handlers and the `Task.Run` plus `InvokeAsync` path, logged `Element connected=true` with a fresh ID in both `InteractiveServer` and `InteractiveWebAssembly`, and the `slideDown` call that followed received the live `<ul>`.

### The bug the first version of this helper had

The first draft returned `_nextRender.Task` after calling `StateHasChanged()`. It passed every test on Server and in WebAssembly click handlers, then silently never logged anything for the `InvokeAsync` path on WebAssembly. Capturing the task before `StateHasChanged()` fixed it, which pins down the cause: outside an event batch, `StateHasChanged()` processes the render queue immediately, and on WebAssembly `UpdateDisplayAsync` completes synchronously, so `OnAfterRenderAsync` ran (and set `_nextRender` to `null`) before `StateHasChanged()` returned. The `NullReferenceException` vanished into the fire-and-forget `Task.Run`. If you write your own variant, keep the local.

### Why OnAfterRenderAsync is late enough on Blazor Server

On WebAssembly the DOM is updated in-process, so "after render" obviously means after the DOM change. On Server it is less obvious, since the DOM lives in another machine's browser. In [Renderer.cs](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Components/Components/src/RenderTree/Renderer.cs), the after-render callbacks are invoked from `InvokeRenderCompletedCallsAfterUpdateDisplayTask`, which first awaits the task returned by `UpdateDisplayAsync`. In [RemoteRenderer.cs](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Components/Server/src/Circuits/RemoteRenderer.cs) that task is the completion source of an `UnacknowledgedRenderBatch`, completed when the browser acknowledges that it applied the batch. So by the time `NextRenderAsync()` returns on Server, the element is in the browser's DOM, not just in the server's render tree.

## Variants, gotchas, and when not to use JS at all

**Overriding `OnAfterRenderAsync` in the derived component.** Call `await base.OnAfterRenderAsync(firstRender);` or the task never completes. If you would rather not use a base class, put the same three members directly in the component.

**`ShouldRender()` returning `false`.** No render, no `OnAfterRenderAsync`, a task that never completes. If you override `ShouldRender`, let it return `true` while `_nextRender` is pending.

**The component is disposed while awaiting.** `Dispose` cancels the pending task, so the `await` throws `TaskCanceledException` instead of hanging forever. Catch it where you call `NextRenderAsync()` if navigation away is a normal case.

**Prerendering.** `OnAfterRenderAsync` does not run during static prerendering, so neither does the continuation. That is the right behaviour, since there is no JS runtime to call yet. If you are seeing a different error there, it is the one covered in [fixing "JavaScript interop calls cannot be issued at this time"](/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/).

**Static SSR.** A component without an interactive render mode never handles `@onclick`, so none of this applies. If you are not sure which mode a component ends up in, [what a Blazor render mode is and which one runs your component](/2026/09/what-is-a-blazor-render-mode-and-which-one-runs-my-component/) walks through how to check it with `RendererInfo`.

**The element is inside a child component.** Not covered by the repro: after-render callbacks run once the whole batch is applied, so a child rendered in the same batch should be in the DOM too. If the child renders later on its own (say, after loading data), expose the readiness from the child with an `EventCallback` instead.

**Animations specifically.** If all you want is a slide-down, consider not removing the element at all. Keeping it mounted and toggling a class with a `grid-template-rows: 0fr` to `1fr` transition needs no JS interop and no render timing. Use the `NextRenderAsync()` route when you genuinely need the element to come and go, or when you call a JS library (a chart, an editor, a map) that needs a live DOM node.

**Focusing an input.** For focus you do not need your own JS: `ElementReference.FocusAsync()` is built in, but it has the exact same timing requirement. Write `show = true; await NextRenderAsync(); await input.FocusAsync();` (this order was not part of the repro above, but it is the same element-reference rule).

## Read next

- [How to fix "JavaScript interop calls cannot be issued at this time" during Blazor prerendering](/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/)
- [What a Blazor render mode is, and which one runs your component](/2026/09/what-is-a-blazor-render-mode-and-which-one-runs-my-component/)
- [Blazor Server vs WebAssembly vs United in .NET 11](/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/)
- [How to download a file from a Blazor component without JavaScript interop](/2026/08/how-to-download-a-file-from-a-blazor-component-without-javascript-interop/)
- [Fixing "Attempting to reconnect to the server" after a Blazor circuit disconnects](/2026/08/fix-attempting-to-reconnect-to-the-server-after-a-blazor-circuit-disconnects/)

## Sources

- [Call JavaScript functions from .NET methods: capture references to elements](https://learn.microsoft.com/en-us/aspnet/core/blazor/javascript-interoperability/call-javascript-from-dotnet?view=aspnetcore-10.0#capture-references-to-elements) (MS Learn, ASP.NET Core 10.0)
- [Razor component lifecycle: after component render](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/lifecycle?view=aspnetcore-10.0#after-component-render-onafterrenderasync) (MS Learn, ASP.NET Core 10.0)
- `dotnet/aspnetcore` `release/10.0`: [ComponentBase.cs](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Components/Components/src/ComponentBase.cs), [Renderer.cs](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Components/Components/src/RenderTree/Renderer.cs), [RenderTreeDiffBuilder.cs](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Components/Components/src/RenderTree/RenderTreeDiffBuilder.cs), [ElementReference.cs](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Components/Components/src/ElementReference.cs), [RemoteRenderer.cs](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Components/Server/src/Circuits/RemoteRenderer.cs), [ElementReferenceCapture.ts](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Components/Web.JS/src/Rendering/ElementReferenceCapture.ts)
- [What is the Vue's nextTick() equivalent for Blazor?](https://stackoverflow.com/questions/79962461) (Stack Overflow, 2026)
