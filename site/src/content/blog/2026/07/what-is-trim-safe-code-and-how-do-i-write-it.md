---
title: "What is trim-safe code and how do I write it?"
description: "Trim-safe code is code the .NET trimmer can statically prove is reachable, so it survives when unused code is removed from a self-contained app. This is the practical guide: turn on the analyzer, drive every IL2xxx warning to zero, annotate reflection with DynamicallyAccessedMembers, propagate RequiresUnreferencedCode to public APIs, and replace unanalyzable patterns with source generators."
pubDate: 2026-07-09
tags:
  - "dotnet"
  - "trimming"
  - "native-aot"
  - "csharp"
  - "dotnet-11"
---

Trim-safe code is code the .NET trimmer can statically prove is reachable, so it is not deleted when you publish a trimmed, self-contained app, and code that does not silently break the app when unused members around it are removed. Concretely, it means your project compiles clean under trim analysis: zero `IL2026`, `IL3050`, `IL2070`, and friends. You make code trim-safe by turning on the analyzer, then working the warning list to zero: annotate reflection you can express (`[DynamicallyAccessedMembers]`), quarantine reflection you cannot behind `[RequiresUnreferencedCode]` and push it up to a public API, and replace patterns that resist both with a source generator. A clean analysis build is the contract; if you cannot get to zero, the app is not trim-safe and trimming will produce production-only crashes that never showed up in `dotnet run`.

Everything here targets the .NET 11 SDK (`11.0.100`) and C# 14, but trim analysis warnings have existed since .NET 6, so the mechanics apply from `net6.0` onward. The .NET 8 SDK or later is the practical minimum for library work, because that is where the analyzer and the AOT-compatibility story stabilized.

## Why the trimmer needs your code to cooperate

Trimming works by reachability analysis. The trimmer (internally `ILLink`) starts at your entry point, walks every method call, field access, and type reference it can see statically, marks each thing it touches as kept, and deletes everything else. That is how a self-contained app shrinks from tens of megabytes to a fraction: the framework is enormous, your app uses a sliver, and the rest goes. Since .NET 6 the default granularity is member-level (`TrimMode=full`), not the old assembly-level `copyused` behavior, so the trimmer removes individual unused methods and types, not just whole unreferenced assemblies. That is more aggressive, and more likely to remove something you actually reach in a way the analysis could not see.

The thing analysis cannot see is reflection. When you write `type.GetMethods()` or `Activator.CreateInstance(someType)`, the trimmer has no idea which concrete type flows in at runtime, so it cannot know which members to keep. It has two bad options: keep everything that could possibly flow there (which defeats trimming) or keep nothing and let you find out at runtime with a `MissingMethodException`. It does neither. Instead it demands that the reflective code carry annotations describing exactly what it touches, and it warns wherever an unannotated value flows into a reflection call. Trim-safe code is code that satisfies those demands. The same rules govern the [Native AOT build, which makes trimming mandatory](/2026/06/what-is-native-aot-and-what-does-it-cost-you/), so everything below is also the price of admission for AOT.

## Step one: turn the analyzer on

You cannot fix warnings you cannot see, and by default a normal build shows none. There are two ways to surface them, and the docs recommend using both because they catch different things.

For an application you are going to publish trimmed, set `PublishTrimmed` in the project file (not just on the command line, so it also applies during `dotnet build`):

```xml
<!-- .NET 11, C# 14. App project. Turns on the trimmer at publish and
     the trim-compat Roslyn analyzer during every build. -->
<PropertyGroup>
  <PublishTrimmed>true</PublishTrimmed>
</PropertyGroup>
```

For a library, you do not publish it, so you enable project-scoped analysis instead. `<IsTrimmable>true</IsTrimmable>` marks the assembly as trim-compatible and turns on warnings for that project:

```xml
<!-- .NET 11, C# 14. Library project. Marks the assembly trimmable and
     emits trim warnings for this project's own code. -->
<PropertyGroup>
  <IsTrimmable>true</IsTrimmable>
</PropertyGroup>
```

Two nuances matter here. First, if you want the warnings without promising the assembly is trim-safe (say, while you are still working through them), use `<EnableTrimAnalyzer>true</EnableTrimAnalyzer>` instead of `IsTrimmable`. It emits the same analysis without stamping the assembly as trimmable. Second, `IsTrimmable` defaults to `true` when you set `<IsAotCompatible>true</IsAotCompatible>`, so an AOT-compatible library is getting trim analysis whether you asked for it separately or not.

The catch with project-scoped library analysis is that it only sees your code plus the reference assemblies of your dependencies, and reference assemblies do not carry enough information for the trimmer to judge them. To see every warning, including ones that come from how your library uses its dependencies, build a small trimming test app: a console project that references your library, sets `<PublishTrimmed>true</PublishTrimmed>`, and roots your library so the whole thing gets analyzed:

```xml
<!-- .NET 11. Trimming test app. Roots the library so ILLink walks every
     code path in it, not just the ones the console Main reaches. -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net11.0</TargetFramework>
    <PublishTrimmed>true</PublishTrimmed>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\MyLibrary\MyLibrary.csproj" />
    <TrimmerRootAssembly Include="MyLibrary" />
  </ItemGroup>
</Project>
```

Then `dotnet publish -c Release -r linux-x64` and read the warnings. `TrimmerRootAssembly` is what makes the difference: without it, the trimmer only analyzes the calls your `Main` actually reaches; with it, it treats the whole library as a root and traverses every path.

## Reading the warnings that mean "not trim-safe yet"

Four warning families cover almost everything you will hit. Knowing which is which tells you the fix.

`IL2026` (`RequiresUnreferencedCode`) means you called a method someone already declared trim-incompatible. `IL3050` (`RequiresDynamicCode`) is the AOT-only sibling: the method needs runtime code generation the JIT would provide but AOT cannot. `IL2070`, `IL2075`, `IL2077`, and the rest of the `IL207x` band are data-flow warnings: an unannotated `Type` (from a parameter, a field, a return value) flowed into a reflection call that requires a `[DynamicallyAccessedMembers]` promise, and nobody made the promise. Treat every one of these as a real defect, not analyzer noise. The whole point of the analyzer is to convert a silent, publish-only, sometimes-only-in-production `MissingMethodException` into a build-time warning that points at the exact line.

One reading tip. In .NET 6+ the trimmer collapses all the internal warnings from a `PackageReference` assembly into a single per-assembly warning, so you do not drown in noise from a dependency you do not control. When you actually want to see them all (you are trying to decide whether a dependency is fixable), set `<TrimmerSingleWarn>false</TrimmerSingleWarn>` to expand them.

## Fixing IL207x: annotate the reflection you can express

The data-flow warnings are the ones you fix in your own code, and the fix is always the same shape: state the requirement at the location the `Type` comes from, so the promise lives in the type system. Take this helper, which warns because `GetMethods()` requires that the type keep its public methods and the parameter promises nothing:

```csharp
// .NET 11, C# 14. Warns IL2070: 'type' has no matching annotation.
using System.Diagnostics.CodeAnalysis;

static void UseMethods(Type type)
{
    foreach (var m in type.GetMethods()) { /* ... */ }
}
```

Copy the requirement onto the parameter:

```csharp
// .NET 11, C# 14. Clean: the parameter now carries the promise.
static void UseMethods(
    [DynamicallyAccessedMembers(DynamicallyAccessedMemberTypes.PublicMethods)] Type type)
{
    foreach (var m in type.GetMethods()) { /* ... */ }
}
```

The requirement does not vanish, it moves to the callers, and it keeps propagating outward until it lands on a `typeof(Customer)` or a concrete type argument, where the trimmer finally knows exactly what to keep. Ask for the minimum: if all you do is `Activator.CreateInstance(type)`, request `PublicParameterlessConstructor`, not `All`. Every flag you add is members the trimmer is forbidden to delete, which is binary size you pay for. The full flow model, including how to annotate fields, generic type parameters, and return values, is covered in [the DynamicallyAccessedMembers deep dive](/2026/06/what-is-the-dynamicallyaccessedmembers-attribute/); the one-line summary is that the attribute preserves nothing by itself, it propagates an obligation to wherever the concrete type is born.

## Fixing IL2026: quarantine the reflection you cannot express

Sometimes the reflection is genuinely not analyzable. You load a type by string from configuration, or you walk `GetProperties()` over an object whose type is not known until runtime. You cannot annotate your way out of that, so you declare the method trim-incompatible with `[RequiresUnreferencedCode]` and let the warning propagate:

```csharp
// .NET 11, C# 14. Honest: this method reflects in a way trimming can break.
[RequiresUnreferencedCode("Serializes arbitrary types via reflection over their properties.")]
static string Serialize(object value)
{
    var sb = new StringBuilder();
    foreach (var p in value.GetType().GetProperties())
        sb.Append(p.Name).Append('=').Append(p.GetValue(value)).Append(';');
    return sb.ToString();
}
```

The attribute does not fix anything. It moves the `IL2026` warning to every caller of `Serialize`, the same way `[DynamicallyAccessedMembers]` moves its requirement, until it reaches a public API boundary where the library author documents the limitation and stops the propagation. This is the correct outcome for code that truly is not trim-safe: instead of a silent runtime failure, the caller gets a compile-time warning telling them this path is unsafe under trimming, and they can decide whether to avoid it. It is also why propagating cleanly to public APIs matters, since it suppresses the blanket `IL2104: Assembly produced trim warnings` and gives consumers precise, per-method signals.

If the pattern is mostly reflection, do not annotate your way around it call by call. That is the signal to replace it with compile-time code generation. Reflection-based serializers and mappers are the canonical example: rather than annotating a `GetProperties()` walk, you adopt a [source generator](/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) that emits the access code at build time, which is exactly why source-generated `System.Text.Json` exists and why it is the recommended path for AOT.

## The escape hatches, and when they are a trap

Two attributes let you silence warnings without changing the code, and both are sharp.

`[UnconditionalSuppressMessage]` silences one specific warning and, unlike plain `[SuppressMessage]`, is persisted in IL so trim analysis respects it. Use it only when the data flow is real and correct but the analyzer cannot follow it, for example a `Type[]` whose every element you know keeps its constructor by construction:

```csharp
// .NET 11, C# 14. Valid only because the setter guarantees the invariant.
[UnconditionalSuppressMessage("ReflectionAnalysis", "IL2063",
    Justification = "The array only holds types stored through the annotated setter.")]
get => _types[i];
```

The docs are blunt about the failure mode: it is only valid to suppress when the reflected-on members are genuine reflection targets elsewhere in the program. A member that is used non-reflectively (a normal method call) is not a valid suppression target, because the optimizer is free to inline it, rename it, or move it, and your suppressed reflection then breaks with no warning to warn you. Suppressing "the property is used by the app so it must be there" is exactly the invalid pattern the docs call out.

`[DynamicDependency]` is the last resort. It keeps named members but does not inform the analysis, so it does not silence warnings on its own and is used together with a suppression. Reach for it only for patterns even `[DynamicallyAccessedMembers]` cannot express, such as loading a member by string from a separate assembly:

```csharp
// .NET 11, C# 14. Last resort. Keeps Helper so the reflection below finds it.
[DynamicDependency("Helper", "MyType", "MyAssembly")]
static void RunHelper()
{
    var helper = Assembly.Load("MyAssembly").GetType("MyType").GetMethod("Helper");
    helper.Invoke(null, null);
}
```

If you find yourself scattering either attribute across many call sites, that is not a trim-safety fix, it is a design smell telling you the API is fundamentally reflection-shaped and should be regenerated at build time instead.

## Framework feature switches: trimming code you never call

Not all of trim-safety is about your reflection. A chunk of the framework ships with trimmer directives behind feature switches, so you can tell the trimmer to remove whole feature areas you do not use. These double as runtime configuration and as trimming instructions. A few worth knowing: `<EventSourceSupport>false</EventSourceSupport>` drops EventSource plumbing, `<UseSystemResourceKeys>true</UseSystemResourceKeys>` strips full exception message text from `System.*` assemblies down to resource IDs, `<InvariantGlobalization>true</InvariantGlobalization>` removes globalization data, and `<StackTraceSupport>false</StackTraceSupport>` (.NET 8+) removes runtime stack-trace generation. .NET 10 added `<UseSizeOptimizedLinq>true</UseSizeOptimizedLinq>`, which trades some LINQ throughput for smaller output and is the default under `PublishAot`. These are not about making your code analyzable; they are about not paying, in binary size, for framework features you never touch. Enable them deliberately, because each one removes real behavior.

## The workflow that actually gets you to trim-safe

The mental model that makes all of this cohere: trim-safety is not a switch, it is a build state you defend. Turn on the analyzer (`PublishTrimmed` for apps, `IsTrimmable` plus a rooted test app for libraries). Read the warnings and sort them: `IL207x` you fix by annotating the source of the `Type` with the minimum `DynamicallyAccessedMembers` flags; `IL2026`/`IL3050` you either annotate with `[RequiresUnreferencedCode]` and propagate to a public API, or you replace the reflection with a source generator; the two escape hatches you use only when an invariant is real and the analyzer genuinely cannot see it. Drive the count to zero, then keep it there, because introducing a new trim warning is a breaking change for anyone publishing your library trimmed, and a dependency bump can reintroduce one with no API change on your side. When an unsafe call slips past the analyzer and only fails at runtime, you are back to debugging a [PlatformNotSupportedException in Native AOT](/2026/05/fix-platformnotsupportedexception-in-native-aot/), which is precisely the failure the warning-free build exists to prevent. And if the target is a real web service, [the Native AOT minimal API walkthrough](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) shows the clean-build recipe end to end. Trim-safe code is not a special dialect of C#; it is ordinary C# that keeps the trimmer's reachability analysis honest, and the analyzer is the tool that tells you, at build time, whether you have.

## Related

- [What is Native AOT and what does it cost you?](/2026/06/what-is-native-aot-and-what-does-it-cost-you/) explains why trimming is mandatory under AOT and what else you trade away.
- [What is the DynamicallyAccessedMembers attribute?](/2026/06/what-is-the-dynamicallyaccessedmembers-attribute/) is the deep dive on the annotation that fixes the IL207x data-flow warnings.
- [What is a source generator and when do I need one?](/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) covers the compile-time codegen that replaces reflection you cannot annotate.
- [How to use Native AOT with ASP.NET Core minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) is the clean-build walkthrough where these warnings show up in a real app.
- [Fix: PlatformNotSupportedException in Native AOT](/2026/05/fix-platformnotsupportedexception-in-native-aot/) is the runtime failure a warning-free trim build prevents.

## Sources

- [Prepare .NET libraries for trimming](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/prepare-libraries-for-trimming), MS Learn (IsTrimmable, EnableTrimAnalyzer, the test-app pattern, RequiresUnreferencedCode, DynamicallyAccessedMembers, UnconditionalSuppressMessage, DynamicDependency).
- [Trimming options](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/trimming-options), MS Learn (PublishTrimmed, TrimmerSingleWarn, ILLinkTreatWarningsAsErrors, the feature-switch table).
- [Trim self-contained deployments and executables](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/trim-self-contained), MS Learn (TrimMode granularity and how reachability trimming works).
- [Introduction to trim warnings](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/fixing-warnings), MS Learn (the IL2026/IL3050/IL207x warning catalog and the data-flow model).
</content>
</invoke>
