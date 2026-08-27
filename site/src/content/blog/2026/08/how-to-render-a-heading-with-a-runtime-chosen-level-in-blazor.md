---
title: "How to render a heading whose level (h1-h6) is chosen at runtime in a Blazor component"
description: "Blazor has no syntax for a variable tag name, and DynamicComponent only renders component types. Override BuildRenderTree and call builder.OpenElement(0, $\"h{level}\"). Covers attribute splatting, why the tag name must be clamped before it reaches the DOM, why changing the level rips the element out of the DOM even with @key, and an auto-levelling variant built on a cascading value."
pubDate: 2026-08-27
template: how-to
tags:
  - "dotnet"
  - "csharp"
  - "aspnetcore"
  - "how-to"
---

Razor gives you no way to write `<h@Level>`, and `<DynamicComponent>` cannot help because its `Type` parameter has to implement `IComponent`. The answer is to drop into `RenderTreeBuilder` and build the element yourself: override `BuildRenderTree` and call `builder.OpenElement(0, $"h{level}")` with a level you have already clamped to 1-6. Everything below was verified against .NET 10 (SDK 10.0.201, `Microsoft.AspNetCore.App` 10.0.5); the APIs are unchanged in the .NET 11 previews.

## Why the two obvious approaches do not work

The first instinct is `<DynamicComponent Type="...">`. It does not apply here. The docs describe it as a way to "render components by type", and the runtime enforces that. Passing an element name, or any type that is not a component, throws before anything renders:

```text
System.ArgumentException: The component type must implement Microsoft.AspNetCore.Components.IComponent.
```

There is no HTML-element equivalent. `DynamicComponent` is for choosing between `RocketLab.razor` and `SpaceX.razor`, not between `h2` and `h3`.

The second instinct is to split the tag across two `MarkupString` values:

```csharp
// .NET 10. Renders correctly in static SSR and breaks interactively.
builder.AddContent(0, (MarkupString)$"<h{Level}>");
builder.AddContent(1, ChildContent);
builder.AddContent(2, (MarkupString)$"</h{Level}>");
```

This is the trap worth understanding, because it looks like it works. Rendered through `HtmlRenderer` for static server-side rendering, the output is exactly right:

```html
<h3>Release notes</h3>
```

That happens only because static SSR concatenates the frames into a string. Inspecting the render tree shows what was actually produced: three independent sibling frames, not one element with a child.

```text
PrependFrame @sibling 0 frame=[Markup "<h3>"]
PrependFrame @sibling 1 frame=[Text "Release notes"]
PrependFrame @sibling 2 frame=[Markup "</h3>"]
```

In Blazor Server or WebAssembly, the client walks those frames and calls `insertMarkup` once per markup frame, and [`insertMarkup` parses each frame's content on its own](https://github.com/dotnet/aspnetcore/blob/main/src/Components/Web.JS/src/Rendering/BrowserRenderer.ts) before inserting the resulting nodes. The browser's parser turns the lone string `<h3>` into an empty `<h3></h3>` element and the lone string `</h3>` into nothing at all. Your text ends up as a sibling *after* an empty heading. The component passes a static-SSR smoke test and produces broken, inaccessible markup the moment the render mode goes interactive.

A `@switch` over six hardcoded branches does work. It is just six copies of every attribute, every CSS class, and the child content, all of which have to stay in sync forever. For one component that is tolerable; for a design system with headings, labels, and section titles it is not.

## Steps: build a Heading component that picks its own tag

1. Create a plain `.cs` file, not a `.razor` file. A Razor component already generates a `BuildRenderTree` method, so declaring your own in an `@code` block produces `CS0111: Type 'Heading' already defines a member called 'BuildRenderTree' with the same parameter types`.
2. Derive from `ComponentBase` and add an `int Level` parameter, a `RenderFragment? ChildContent` parameter, and an `AdditionalAttributes` dictionary marked with `[Parameter(CaptureUnmatchedValues = true)]` so callers can still pass `class`, `id`, and `data-` attributes.
3. Override `BuildRenderTree` and clamp the level with `Math.Clamp(Level, 1, 6)` before interpolating it into the tag name. The clamp is a security control, not a convenience.
4. Call `builder.OpenElement(0, $"h{level}")`, then `builder.AddMultipleAttributes(1, AdditionalAttributes)`, then `builder.AddContent(2, ChildContent)`, then `builder.CloseElement()`.
5. Hardcode every sequence number as an integer literal. Do not use a counter variable, even one that looks harmless.

## The component in full

```csharp
// Heading.cs -- .NET 10, C# 14
using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Rendering;

public class Heading : ComponentBase
{
    [Parameter] public int Level { get; set; } = 2;
    [Parameter] public RenderFragment? ChildContent { get; set; }

    [Parameter(CaptureUnmatchedValues = true)]
    public IReadOnlyDictionary<string, object>? AdditionalAttributes { get; set; }

    protected override void BuildRenderTree(RenderTreeBuilder builder)
    {
        var level = Math.Clamp(Level, 1, 6);

        builder.OpenElement(0, $"h{level}");
        builder.AddMultipleAttributes(1, AdditionalAttributes);
        builder.AddContent(2, ChildContent);
        builder.CloseElement();
    }
}
```

Consume it exactly like any other component:

```razor
@* .NET 10 *@
<Heading Level="SectionDepth" class="title" id="release-notes">
    Release notes
</Heading>
```

Rendered through `HtmlRenderer`, the results are what you would hand-write:

```text
Level= 1 -> <h1 class="title" id="s1">Release notes</h1>
Level= 3 -> <h3 class="title" id="s1">Release notes</h3>
Level= 6 -> <h6 class="title" id="s1">Release notes</h6>
Level= 9 -> <h6 class="title" id="s1">Release notes</h6>
Level=-4 -> <h1 class="title" id="s1">Release notes</h1>
```

Note that `AddMultipleAttributes` comes before `AddContent`. All attribute frames for an element have to be appended before any child content; interleaving them throws at render time.

## Keeping it in a .razor file

If you would rather not leave Razor, you can, as long as you do not override `BuildRenderTree`. Expose the builder logic as a `RenderFragment` property and render it as the component's entire body:

```razor
@* Heading.razor -- .NET 10 *@
@Rendered

@code {
    [Parameter] public int Level { get; set; } = 2;
    [Parameter] public RenderFragment? ChildContent { get; set; }

    [Parameter(CaptureUnmatchedValues = true)]
    public IReadOnlyDictionary<string, object>? AdditionalAttributes { get; set; }

    private RenderFragment Rendered => builder =>
    {
        builder.OpenElement(0, $"h{Math.Clamp(Level, 1, 6)}");
        builder.AddMultipleAttributes(1, AdditionalAttributes);
        builder.AddContent(2, ChildContent);
        builder.CloseElement();
    };
}
```

This compiles cleanly and emits `<h4 class="title">Release notes</h4>` with no stray whitespace nodes around it, because the `@Rendered` expression is the component's only markup. The generated `BuildRenderTree` just calls into your fragment. Pick whichever file type your team greps for more often; the render tree is identical.

## The tag name reaches the DOM verbatim

The clamp in step 3 is the part people skip, and it is the part that matters. `OpenElement` does not validate or escape its `elementName` argument. Whatever string you pass is written into the output as a tag name. Here is a component with an unvalidated `string Level` parameter, rendered with three different inputs:

```text
Level="2"                          -> <h2>hi</h2>
Level="2 onload=alert(1)"          -> <h2 onload=alert(1)>hi</h2 onload=alert(1)>
Level="2><script>alert(1)</script" -> <h2><script>alert(1)</script>hi</h2><script>alert(1)</script>
```

That is a script tag in your page from a component parameter. Blazor's automatic encoding protects text and attribute *values*; it does not protect the tag name, because the tag name is never expected to be user data. Microsoft's own guidance on `RenderTreeBuilder` says as much: a malformed component "can result in undefined behavior", including "compromised security".

So never let an untrusted or merely unvalidated value reach `OpenElement`. Take an `int` rather than a `string`, clamp it, and if your API surface genuinely needs a string, validate it against an allow-list of the six heading names instead of interpolating.

## Changing the level destroys and rebuilds the element

Blazor's diff algorithm matches frames by sequence number and frame type. Two element frames at the same sequence number with *different* tag names are not the same element, so the old one is removed and a new one is inserted. Capturing the render batch when `Level` goes from 2 to 3 shows exactly that:

```text
after Level 2 -> 3:
  RemoveFrame @sibling 0 frame=[Element h3]
  PrependFrame @sibling 0 frame=[Element h3]
```

Compare that with changing only the `class` attribute, which patches in place:

```text
after class change only:
  SetAttribute @sibling 0 frame=[Attribute class=subtitle]
```

The practical consequence is that a heading that changes level loses its DOM node. Focus inside it is dropped, any `ElementReference` you captured goes stale, CSS transitions restart, and a third-party script that attached to that node is now attached to an orphan. Adding `@key` does not rescue it. Keys let the diff match elements across reordering; they do not make two different tag names the same element. A keyed version produces byte-for-byte the same edit script:

```text
keyed, Level 2 -> 3:
  RemoveFrame @sibling 0 frame=[Element h3]
  PrependFrame @sibling 0 frame=[Element h3]
```

This is rarely a problem, because a heading's level is usually fixed for the lifetime of the section. It becomes a problem when the level is derived from something that changes often, such as a collapsible outline that renumbers as the user expands nodes. If you hit that, keep the level stable and change the styling instead.

## Sequence numbers stay hardcoded, even across branches

This is the rule that is easiest to break once you add a second code path. It is tempting to write `var seq = 0;` and use `seq++` everywhere, especially in a component with an `if`/`else`. Do not. Microsoft's documentation is explicit that "app performance suffers if sequence numbers are generated dynamically", because a counter erases the information the diff algorithm uses to recognise which branch you were in. The result is longer edit scripts and, in nested structures, a much deeper recursive diff.

The correct pattern is what the Razor compiler itself emits: literal numbers that increase in *source order*, with each branch owning its own range.

```csharp
// AutoHeading.cs -- .NET 10, C# 14
protected override void BuildRenderTree(RenderTreeBuilder builder)
{
    var level = Ambient?.Value ?? 1;

    if (level <= 6)
    {
        builder.OpenElement(0, $"h{level}");
        builder.AddMultipleAttributes(1, AdditionalAttributes);
        builder.AddContent(2, ChildContent);
        builder.CloseElement();
    }
    else
    {
        builder.OpenElement(3, "div");
        builder.AddAttribute(4, "role", "heading");
        builder.AddAttribute(5, "aria-level", level);
        builder.AddMultipleAttributes(6, AdditionalAttributes);
        builder.AddContent(7, ChildContent);
        builder.CloseElement();
    }
}
```

If a component grows past a screenful of builder calls, wrap the pieces in `OpenRegion`/`CloseRegion`. Each region gets its own sequence-number space, so you can restart from zero inside it without confusing the diff.

## Auto-levelling with a cascading value

The version above hints at the more useful shape of this component. Rather than making every caller pass the right number, let the heading read its depth from context. A small cascading value carries the ambient level, and any component that opens a nested section cascades the next one down:

```csharp
// HeadingLevel.cs -- .NET 10, C# 14
public sealed class HeadingLevel
{
    public int Value { get; init; } = 1;
    public HeadingLevel Next() => new() { Value = Value + 1 };
}
```

```razor
@* Section.razor -- .NET 10 *@
<CascadingValue Value="_child" IsFixed="true">
    <section>@ChildContent</section>
</CascadingValue>

@code {
    [CascadingParameter] public HeadingLevel? Ambient { get; set; }
    [Parameter] public RenderFragment? ChildContent { get; set; }

    private HeadingLevel _child = default!;

    protected override void OnParametersSet()
        => _child = (Ambient ?? new HeadingLevel()).Next();
}
```

`AutoHeading` then takes no `Level` parameter at all. A card component dropped three sections deep renders an `h4` without knowing anything about where it was used, which is the property that makes reusable components composable in the first place. Set `IsFixed="true"` on the `CascadingValue` when the level cannot change after the section renders; it lets Blazor skip subscribing every descendant to change notifications.

## What to do past h6

HTML stops at `h6`, but a deeply nested outline does not. Rather than clamping silently and producing three sibling `h6` elements that assistive technology reads as peers, fall back to the ARIA equivalent. `role="heading"` plus `aria-level` expresses any depth:

```text
ambient=2 -> <h2 class="title">Release notes</h2>
ambient=6 -> <h6 class="title">Release notes</h6>
ambient=7 -> <div role="heading" aria-level="7" class="title">Release notes</div>
```

Native elements remain the better choice wherever they exist, so use the real `h1`-`h6` tags for levels 1 through 6 and reserve the ARIA fallback for the overflow case. In practice, needing level 7 is usually a sign the page structure should be flattened, so it is worth logging a warning in development when the fallback triggers.

One last note on the render tree types themselves: the documentation flags everything under `Microsoft.AspNetCore.Components.RenderTree` as unstable framework internals. `RenderTreeBuilder` and `ComponentBase.BuildRenderTree` are public, supported API and safe to use. Reading `RenderBatch` and `RenderTreeEdit`, as I did above to capture the diff output, is fine for diagnostics but is not something to ship in production code.

## Related

- The Razor compiler's tag resolution is what makes a variable tag name impossible in the first place, and it is also behind the error in [Found markup element with unexpected name in Blazor](/2026/05/fix-rz10012-found-markup-element-with-unexpected-name-blazor/).
- Component code that reaches for the DOM has to respect the render mode boundary, as covered in [JavaScript interop calls cannot be issued at this time](/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/).
- The same instinct to avoid JS for something the framework can do natively applies to [downloading a file from a Blazor component without JavaScript interop](/2026/08/how-to-download-a-file-from-a-blazor-component-without-javascript-interop/).
- If a heading rebuild is losing state you care about, [persisting state across the static-to-interactive render boundary](/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/) covers the mechanism.
- Which render mode you pick decides whether the `MarkupString` bug above is even reachable; see [Blazor Server vs WebAssembly vs United](/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/).

## Sources

- [ASP.NET Core Blazor advanced scenarios (render tree construction)](https://learn.microsoft.com/en-us/aspnet/core/blazor/advanced-scenarios?view=aspnetcore-10.0), including the sequence-number guidance and the security warning on malformed components.
- [Dynamically-rendered ASP.NET Core Razor components](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/dynamiccomponent?view=aspnetcore-10.0) for the `DynamicComponent` contract.
- [`RenderTreeBuilder.OpenElement` API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.components.rendering.rendertreebuilder.openelement).
- [`BrowserRenderer.ts` in dotnet/aspnetcore](https://github.com/dotnet/aspnetcore/blob/main/src/Components/Web.JS/src/Rendering/BrowserRenderer.ts) for how markup frames are parsed and inserted on the client.
