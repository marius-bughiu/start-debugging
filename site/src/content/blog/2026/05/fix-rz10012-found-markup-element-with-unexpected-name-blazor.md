---
title: "Fix: RZ10012: Found markup element with unexpected name in Blazor"
description: "Blazor's Razor compiler emits RZ10012 when a PascalCase tag has no matching component type in scope. Add @using for the component's namespace in _Imports.razor, or @namespace in the component, then rebuild."
pubDate: 2026-05-12
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "blazor"
  - "razor"
---

The fix: the Razor compiler saw a PascalCase tag (for example `<NavMenu />` or `<MudButton />`) and could not bind it to a component type that is in scope at that file. Add `@using <namespace>` either to the parent `.razor` file or to a `_Imports.razor` that covers it, and rebuild. If the component lives in a Razor Class Library (RCL) whose folder structure does not match its namespace, add `@namespace <FullNamespace>` to the component's `.razor` file as well. Delete `bin/`, `obj/`, and `.vs/` if the warning lingers in the IDE after a clean build.

```text
RZ10012: Found markup element with unexpected name 'NavMenu'.
If this is intended to be a component, add a @using directive for its namespace.
```

This guide is written against .NET 11 preview 4, the Razor SDK shipped with `Microsoft.AspNetCore.App` 11.0.0-preview.4, and Visual Studio 17.13. The diagnostic ID `RZ10012` and the exact wording have been stable since .NET Core 3.1, so the fixes below apply unchanged on .NET 6, 7, 8, 10, and 11. Blazor Server, Blazor WebAssembly, Blazor United, and Razor Class Libraries all emit it from the same compiler pass.

RZ10012 is a **compiler warning**, not an error, by default. The project still builds. If the tag really is meant to be a component and you ship without fixing it, the runtime renders the tag as **raw HTML** (a `<NavMenu></NavMenu>` element with no children), the click handlers never wire up, and the parameters silently disappear. That is why the rest of this post treats it as an error worth blocking the build on.

## Why the Razor compiler thinks your tag is "unexpected"

The Razor compiler classifies every element in a `.razor` file using one rule: a tag whose name starts with an **uppercase ASCII letter** is a component reference; everything else is HTML. When it sees `<NavMenu />`, it walks the **tag helper descriptor** table for the current file, looking for a component type whose short name matches and whose namespace is imported by an `@using` directive that applies to this file.

If no descriptor matches, the compiler has two choices: assume HTML and emit a warning so a human can correct course, or fail the build. The designers chose the first, which is why RZ10012 is a warning. The descriptor table is populated from three sources, in this order:

1. **`@using` directives in the file itself.** Lexical scope, only the file that declares them.
2. **`_Imports.razor` files**, applied **bottom-up by folder**. The `_Imports.razor` next to the file applies first, then the one in the parent folder, and so on up to the project root.
3. **Project-wide imports** that the SDK injects: `Microsoft.AspNetCore.Components`, `Microsoft.AspNetCore.Components.Web`, and a few others. These are why you do not have to import `<EditForm>` manually.

Note that `_Imports.razor` is **not transitive across projects**. An `_Imports.razor` in a Razor Class Library does not flow into the app that consumes it. The consumer's own `_Imports.razor` (or the page itself) has to declare `@using MyRcl` for `<MyRclComponent />` to bind.

## The minimum file that reproduces it

The smallest repro is two files in the same project:

```razor
@* .NET 11 preview 4, Razor SDK 11.0.0-preview.4 *@
@* File: Components/Pages/Home.razor *@

<h1>Home</h1>
<NavMenu />
```

```razor
@* File: Components/Layout/NavMenu.razor *@

<nav>Navigation here</nav>
```

`NavMenu` lives in `MyApp.Components.Layout`. `Home.razor` lives in `MyApp.Components.Pages`. Neither file has a `@using` for `MyApp.Components.Layout`, and there is no `_Imports.razor` that bridges them. Build:

```text
Components\Pages\Home.razor(3,2): warning RZ10012: Found markup element with unexpected name 'NavMenu'. If this is intended to be a component, add a @using directive for its namespace.
```

At runtime, the page renders `<navmenu></navmenu>` as a literal HTML tag.

## The four fixes, ranked

Apply them in this order. Stop at the first one that solves your case.

### 1. Add `@using` to the closest `_Imports.razor`

This is the canonical fix and the one the warning text itself tells you about. Drop a single line into the `_Imports.razor` that covers your component tree:

```razor
@* File: Components/_Imports.razor *@
@using MyApp.Components.Layout
@using MyApp.Components.Shared
```

If `_Imports.razor` does not yet exist for the folder, create it. The default `dotnet new blazor` template places one at `Components/_Imports.razor` with the common usings already wired in.

This works because the Razor SDK feeds every `_Imports.razor` between the project root and the current file into the compiler as if its directives appeared at the top of the current file. Adding a using here propagates to every `.razor` in or below that folder, including layouts, pages, and partials.

### 2. Add `@using` directly to the consuming `.razor` file

When the component is referenced from exactly one file and you want to keep namespace pollution contained, declare the using inline:

```razor
@* File: Components/Pages/Home.razor *@
@using MyApp.Components.Layout

<h1>Home</h1>
<NavMenu />
```

Mechanically identical to fix 1, just narrower in scope. Useful when two folders define components with the same short name and you only want the disambiguation in one place.

### 3. Add `@namespace` to the component (Razor Class Library scenario)

When the component lives in an RCL, the auto-generated namespace is derived from `RootNamespace` plus the path of the file relative to the RCL's project file. If the RCL's `RootNamespace` does not match its actual namespace, or the file lives under a folder name the C# compiler does not accept verbatim (numbers, hyphens), the generated namespace will not match what the consumer imports. Add `@namespace` to fix the discrepancy at the source:

```razor
@* File: src/MyRcl/Components/Button.razor *@
@namespace MyRcl.Components

<button class="my-rcl-button" @onclick="OnClick">@ChildContent</button>

@code {
    [Parameter] public RenderFragment? ChildContent { get; set; }
    [Parameter] public EventCallback OnClick { get; set; }
}
```

Now the consumer can `@using MyRcl.Components` and get a clean bind. Without `@namespace`, Razor would generate `MyRcl.src.MyRcl.Components` or `Some.RootNamespace.src.MyRcl.Components` depending on how the RCL is laid out, and your `@using` would silently fail to find the type.

You can also set `RootNamespace` in the RCL's `.csproj` to bypass folder-based naming entirely:

```xml
<!-- src/MyRcl/MyRcl.csproj -->
<PropertyGroup>
  <RootNamespace>MyRcl</RootNamespace>
</PropertyGroup>
```

### 4. Clear the IDE cache when the warning lingers after a clean build

The Razor language service in Visual Studio caches tag helper descriptors per project. After a project reference is added or a namespace renamed, the cache can keep reporting RZ10012 even though `dotnet build` from a fresh `obj/` is clean. The reliable reset:

```powershell
# Close Visual Studio first, then from the solution root:
Remove-Item -Recurse -Force .vs, **/bin, **/obj
dotnet build
```

Reopen the solution. The first IntelliSense build will rehydrate the descriptor cache with the post-fix state. If you are on JetBrains Rider, the equivalent is **File > Invalidate Caches**.

## Make the warning fail the build

The default severity ships builds that render broken pages. Two ways to lift it:

**Targeted (recommended):** treat only RZ10012 as an error.

```xml
<!-- MyApp.csproj, .NET 11 preview 4 -->
<PropertyGroup>
  <WarningsAsErrors>$(WarningsAsErrors);RZ10012</WarningsAsErrors>
</PropertyGroup>
```

The `$(WarningsAsErrors);` prefix preserves whatever the SDK already promoted, which matters because newer .NET SDKs add to that list over time.

**Blanket:** treat all warnings as errors. Healthier discipline overall, but it forces you to chase every other warning the SDK ever emits, which is more cleanup than most teams want for a single fix.

```xml
<PropertyGroup>
  <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
</PropertyGroup>
```

Either way, a missing `@using` now stops the build instead of leaking through to QA as a "the button does nothing" ticket.

## Common variants that land here by mistake

**Lowercase tag name.** `<navMenu />` does not trigger RZ10012, because the first letter is lowercase and Razor classifies it as HTML. If your component renders as raw markup and there is **no** warning, you have a casing bug, not a namespace bug. Rename the tag to PascalCase.

**`@inherits` masking the component.** On .NET 7.0.302 and earlier there is a known issue ([dotnet/razor#8800](https://github.com/dotnet/razor/issues/8800)) where adding `@inherits MyBase` to a component caused the compiler to lose its component-ness and emit RZ10012 wherever it was used. Fixed in .NET 8. If you are still on .NET 7 and cannot upgrade, work around it by inheriting in `@code { protected partial class ... }` rather than via the directive.

**Third-party component library not registered.** When using MudBlazor, Radzen, Telerik, or Syncfusion, the library ships an `_Imports.razor` snippet you have to paste into your own. Missing it means every `<MudButton />` lights up with RZ10012. The vendor's "getting started" page has the exact list (MudBlazor needs `@using MudBlazor`, Radzen needs `@using Radzen` and `@using Radzen.Blazor`, etc.).

**Generic component with type parameter.** `<MyList T="string" />` will still warn if `MyList<T>` is not in scope. The `T="..."` attribute does not import a namespace; the `@using` rule applies the same way.

**Editor false positive in VS 17.4.x.** [dotnet/razor#8146](https://github.com/dotnet/razor/issues/8146) tracks a series of false positives in early VS 2022 releases. If the build is clean and only the IDE flags RZ10012, update VS to 17.6 or newer and clear `.vs/` as in fix 4.

**Component in a referenced project that targets a different framework.** A Razor Class Library targeting `net6.0` consumed by a `net11.0` app can fail to surface its components if the RCL is missing `<UseRazorSourceGenerator>true</UseRazorSourceGenerator>` or has an outdated SDK reference. Update the RCL's `<PackageReference>` to `Microsoft.AspNetCore.App` 11 and rebuild.

## A 30-second checklist

When RZ10012 lands in CI and you have a flight to catch, run through this list top to bottom:

1. Is the tag PascalCase? If lowercase, rename it.
2. Is the component in **this** project? If yes, `@using` its namespace in the nearest `_Imports.razor`.
3. Is the component in an RCL? Check the RCL has `@namespace` matching what you import, and the consumer references the RCL package or project.
4. Third-party library? Paste the vendor's snippet into `_Imports.razor`.
5. Still warning after a clean build? Delete `.vs/`, `bin/`, `obj/` and rebuild.
6. Want this to fail CI? Add `RZ10012` to `<WarningsAsErrors>`.

Ninety percent of cases are step 2 or step 4. The rest is namespace plumbing.

## Related

- [Fix: The type or namespace name could not be found after a project reference](/2026/05/fix-the-type-or-namespace-name-could-not-be-found-after-project-reference/) covers the C# side of the same family of namespace resolution failures.
- [How to share validation logic between server and Blazor WebAssembly](/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) walks through the kind of multi-project layout where RZ10012 is most likely to bite.
- [How to use Tailwind CSS with Blazor WebAssembly in .NET 11](/2026/05/how-to-use-tailwind-css-with-blazor-webassembly-in-dotnet-11/) shows a clean Blazor project layout you can compare against.
- [How to add a global exception filter in ASP.NET Core 11](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) is the runtime counterpart for catching the "tag rendered as raw HTML" bugs RZ10012 would have prevented.

## Sources

- [dotnet/aspnetcore#45427: Referenced Razor Class Library component reporting error RZ10012](https://github.com/dotnet/aspnetcore/issues/45427)
- [dotnet/razor#8800: `@inherits` breaks component recognition](https://github.com/dotnet/razor/issues/8800)
- [dotnet/razor#8146: Unusable Blazor analyzers blinking invalid RZ10012 warnings in VS 17.4.x](https://github.com/dotnet/razor/issues/8146)
- [Microsoft Learn: ASP.NET Core Blazor namespaces](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/?view=aspnetcore-9.0#namespaces)
- [Jonathan Crozier: Treat Blazor component warnings as errors](https://jonathancrozier.com/blog/treat-blazor-component-warnings-as-errors-found-markup-element-with-unexpected-name)
