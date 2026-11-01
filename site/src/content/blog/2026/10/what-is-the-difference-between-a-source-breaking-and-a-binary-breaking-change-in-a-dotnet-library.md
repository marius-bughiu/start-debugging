---
title: "What Is the Difference Between a Source-Breaking and a Binary-Breaking Change in a .NET Library?"
description: "A source-breaking change stops consumer code from compiling the next time it is rebuilt; a binary-breaking change makes already-compiled consumers fail at run time with MissingMethodException, MissingFieldException or TypeLoadException. Measured on .NET 10 with a v1/v2 DLL swap, plus what package validation catches and what it misses."
pubDate: 2026-10-16
tags:
  - "dotnet"
  - "dotnet-10"
  - "csharp"
  - "nuget"
  - "library-design"
---

**Short answer:** a **source-breaking** change is one that makes a consumer's code fail to compile the next time they rebuild against your new version, while their already-compiled binaries keep running fine. A **binary-breaking** change is the opposite failure mode: code that was compiled against your old version stops working when your new DLL is dropped next to it without a rebuild, typically with `MissingMethodException`, `MissingFieldException` or `TypeLoadException`. The two are independent. Adding an optional parameter is binary-breaking but source-compatible; renaming a parameter is source-breaking but binary-compatible. For a NuGet library, binary breaks are the dangerous ones, because consumers get your new DLL transitively through some other package and never recompile the code that calls you.

Everything below was measured on .NET SDK 10.0.302 with runtime 10.0.10 and C# 14, by compiling a small console app against version 1 of a library, then swapping in version 2 of the DLL without rebuilding the app, and then rebuilding it. The rules have not changed in years, so they apply equally to .NET 8, 9 and 11.

## Why there are two different contracts

When you compile a C# call like `Api.Connect(url)`, the compiler resolves the overload, fills in default values for optional parameters, inlines constants, and then emits IL that references one exact member by its full signature: declaring type, name, parameter types and return type. At run time the CLR does not redo overload resolution. It looks up that exact signature in whatever version of your assembly it loaded. If the signature is gone, it throws.

So your library really has two contracts:

1. The **source contract**: the shape the C# compiler sees. Names, parameter names, overload sets, default values, accessibility, generic constraints. Consumers only hit this when they rebuild.
2. The **binary contract**: the metadata signatures that compiled IL binds to. Consumers hit this every time the process starts, recompiled or not.

There is a third category Microsoft's [library guidance](https://learn.microsoft.com/en-us/dotnet/standard/library-guidance/breaking-changes) lists, the **behavior** break (same signatures, different results or exceptions), but it is orthogonal to the other two. Some changes in this post are interesting precisely because they are neither source- nor binary-breaking and still change behavior.

## The repro: one app, two versions of a library

Version 1 of the library:

```csharp
// Acme.Core 1.0.0, .NET 10, C# 14
namespace Acme.Core;

public static class Api
{
    public const int MaxRetries = 3;
    public static string Version = "1.0";

    public static string Connect(string url) => $"v1 Connect({url})";
    public static string Retry(int count = 3) => $"v1 Retry({count})";
    public static string Send(string message) => $"v1 Send({message})";
    public static string Load(string path) => $"v1 Load({path})";
    public static string Describe() => "v1 Describe";
}
```

The consumer, compiled once against 1.0.0:

```csharp
// App, .NET 10, C# 14. Compiled against Acme.Core 1.0.0.
using Acme.Core;

Run("const", () => $"MaxRetries = {Api.MaxRetries}");
Run("default", () => Api.Retry());
Run("named arg", () => Api.Send(message: "hi"));
Run("null arg", () => Api.Load(null!));
Run("optional param", () => Api.Connect("https://example.com"));
Run("field", () => Api.Version);
Run("return type", () => Api.Describe());

static void Run(string label, Func<object> f)
{
    try { Console.WriteLine($"{label,-15} OK   {f()}"); }
    catch (Exception ex) { Console.WriteLine($"{label,-15} FAIL {ex.GetType().Name}: {ex.Message}"); }
}
```

Version 2 makes seven changes that each look harmless in a code review:

```csharp
// Acme.Core 2.0.0, .NET 10, C# 14
namespace Acme.Core;

public static class Api
{
    public const int MaxRetries = 5;                         // was 3
    public static string Version { get; set; } = "2.0";      // was a field

    public static string Connect(string url, int timeoutMs = 0) => $"v2 Connect({url}, {timeoutMs})"; // added optional param
    public static string Retry(int count = 5) => $"v2 Retry({count})";  // default was 3
    public static string Send(string text) => $"v2 Send({text})";      // parameter renamed
    public static string Load(string path) => $"v2 Load(string)";
    public static string Load(Uri path) => $"v2 Load(Uri)";             // new overload
    public static object Describe() => "v2 Describe";                    // return type was string
}
```

### Old App.dll, new Acme.Core.dll (no rebuild)

This is what a consumer sees when NuGet unifies them onto your new version because some other dependency asked for it:

```text
const           OK   MaxRetries = 3
default         OK   v2 Retry(3)
named arg       OK   v2 Send(hi)
null arg        OK   v2 Load(string)
optional param  FAIL MissingMethodException: Method not found: 'System.String Acme.Core.Api.Connect(System.String)'.
field           FAIL MissingFieldException: Field not found: 'Acme.Core.Api.Version'.
return type     FAIL MissingMethodException: Method not found: 'System.String Acme.Core.Api.Describe()'.
```

Three binary breaks. Note that the app is calling **v2 code** for `Retry`, `Send` and `Load`, but it still prints `MaxRetries = 3` and passes `3` to `Retry`. Those values were baked into App.dll at compile time.

### App rebuilt against 2.0.0

```text
Program.cs(6,33): error CS1739: The best overload for 'Send' does not have a parameter named 'message'
Program.cs(7,27): error CS0121: The call is ambiguous between the following methods or properties: 'Acme.Core.Api.Load(string)' and 'Acme.Core.Api.Load(System.Uri)'
```

Two source breaks, both in calls that ran fine without the rebuild. After fixing them (`Send(text: "hi")`, `Load((string)null!)`) the rebuilt app prints:

```text
const           OK   MaxRetries = 5
default         OK   v2 Retry(5)
named arg       OK   v2 Send(hi)
null arg        OK   v2 Load(string)
optional param  OK   v2 Connect(https://example.com, 0)
field           OK   2.0
return type     OK   v2 Describe
```

Everything that threw before now works, and the constant and the default have silently jumped from 3 to 5.

## The four quadrants

Putting the results side by side:

| Change in v2 | Source-breaking | Binary-breaking | What actually happens |
| --- | --- | --- | --- |
| Add an optional parameter | No | **Yes** | `MissingMethodException` until recompile |
| Field to property, same name | No (mostly) | **Yes** | `MissingFieldException` until recompile |
| Change the return type | Sometimes | **Yes** | `MissingMethodException` |
| Rename a parameter | **Yes** (named args) | No | `CS1739` on rebuild |
| Add an overload | **Sometimes** | No | `CS0121` on `null`, or silently binds to a different overload |
| Change a `public const` value | No | No | Old binaries keep the old value forever |
| Change an optional parameter default | No | No | Old binaries keep the old default |

The last two rows are the trap. They pass every compatibility check and still change behavior, and the behavior depends on **when the consumer last compiled**, which means two assemblies in the same process can disagree about the value of `MaxRetries`.

## Binary-breaking changes, in more detail

The rule of thumb: if the metadata signature an old caller references stops existing, it is a binary break. The [.NET API compatibility rules](https://learn.microsoft.com/en-us/dotnet/core/compatibility/library-change-rules) list them exhaustively. The ones that bite library authors most often:

- **Adding, removing or reordering parameters**, including adding an optional one. Optional parameters are a compiler feature; the IL signature of `Connect(string, int)` is a different method than `Connect(string)`. The fix is an overload, not a default:

  ```csharp
  // Acme.Core 1.1.0, .NET 10: binary and source compatible
  public static string Connect(string url) => Connect(url, Timeout.Infinite);
  public static string Connect(string url, int timeoutMs) => /* ... */ "";
  ```

  This is also why turning a synchronous method into an async one is never compatible: the return type changes. I walked through the consequences for published packages in [migrating from ValueTask back to Task](/2026/06/migrate-from-valuetask-back-to-task-when-and-why/).

- **Changing a field to a property** (or back). Fields are accessed with `ldsfld`/`ldfld`, properties with a call to `get_Version`. Same C# syntax at the call site, completely different IL. This is the classic reason the design guidelines tell you never to expose public fields.

- **Changing a return type, adding or removing `ref`/`out`/`in`, adding or removing `static`.** All of these are part of the signature.

- **Changing the `params` collection type**, for example `params T[]` to `params ReadOnlySpan<T>` in C# 13 and later. Source-compatible for callers, binary-breaking because the parameter type changed.

- **Adding a member to an interface without a default implementation.** Any class in an old binary that implements the interface fails to load. In the repro, a plugin app compiled against an `IPlugin { string Name { get; } }` died at startup once `string Version { get; }` was added:

  ```text
  Unhandled exception. System.TypeLoadException: Method 'get_Version' in type 'MyPlugin' from assembly 'PApp, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null' does not have an implementation.
  ```

  Declaring the same member with a default body (`string Version => "0.0";`) made the same old binary run and print `mine 0.0`. Default interface members require .NET Core 3.0 or later, so this escape hatch does not exist for a `netstandard2.0` target, and `ref struct` implementers (allowed since C# 13) still need an explicit implementation, which makes it a source break for them.

- **Adding an abstract member to an unsealed public class with accessible constructors**, sealing a previously unsealed type, removing `virtual`, or making a virtual member abstract. These break subclasses in other assemblies. The [CA1070 post](/2026/08/fix-ca1070-do-not-declare-event-fields-as-virtual/) has a concrete example of a modifier you cannot simply remove once shipped.

- **Changing assembly identity**: renaming the assembly or adding, removing or changing its strong-name key. Every reference to the old identity fails. If you are already strong-naming, keep the key forever; the [InternalsVisibleTo full public key post](/2026/10/how-to-add-a-strong-named-assemblys-full-public-key-to-internalsvisibleto/) shows why the key leaks into more places than you expect.

Moving a type to another assembly is the one structural change that can be made binary-compatible on purpose: leave a `[TypeForwardedTo(typeof(Foo))]` in the old assembly so old references get redirected.

In real applications a binary break rarely shows up in your own test suite. It shows up as a `MissingMethodException` inside a third-party package that was compiled against your previous version, which is exactly the shape of the [EF Core tools `ArgumentIsEmpty` failure](/2026/09/fix-missingmethodexception-argumentisempty-after-upgrading-ef-core-tools/).

## Source-breaking changes, in more detail

Source breaks are cheaper because the consumer sees them at build time with a precise error and can fix their own code. Microsoft's guidance calls them "the least disruptive" category. Common ones:

- **Renaming a parameter.** Breaks anyone using named arguments (`CS1739`), plus `dynamic` and VB late binding. Changing only the casing counts.
- **Adding an overload.** Breaks calls that become ambiguous, like `Load(null)` above. Worse, if the new overload is a *better* match for existing arguments, rebuilt callers silently switch to it, which turns a source change into a behavior change. C# 14's span conversions caused exactly this in the BCL, covered in [the C# 14 overload resolution breaking change with spans](/2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans/). Adding `[OverloadResolutionPriority]` to an existing overload has the same risk.
- **Adding a type whose name collides** with a commonly imported one, the canonical example being a library that defines its own `Task`.
- **Removing a default value** from an optional parameter, or removing `params`.
- **Adding `required` to a member**, which forces every object initializer to set it. See [fixing CS9035](/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/).
- **Adding an instance field to a struct that has no non-public fields.** Callers that initialize such a struct field by field, without `new`, now get definite-assignment errors. It is also a binary break for callers compiled with `[SkipLocalsInit]`, because their IL never initializes the new field.
- **Adding a case type to a C# 15 `union`.** Switches that were exhaustive stop being so. This one is both source- and binary-breaking; the [CS8509 union post](/2026/10/fix-cs8509-cs0161-switch-exhaustive-over-csharp-15-union-type/) shows the errors.
- **Raising warnings into errors for consumers using `TreatWarningsAsErrors`.** Marking an API `[Obsolete]` is technically a source break for those projects, which is why it is the accepted way to stage a removal rather than something to do casually.

## The silent ones: `const` and default values

`const` fields and optional parameter defaults are copied into the caller's IL at compile time. The repro shows the consequence: after the DLL swap, the app ran v2 code but still used `MaxRetries = 3` and called `Retry(3)`. Neither is a source or binary break, so no tool will warn you, but the observable behavior now depends on which assemblies were rebuilt.

Rules that follow from that:

- Only use `public const` for values that are true constants for all time (`Math.PI`, a protocol magic number). For anything versioned, use `public static readonly`, which is read at run time.
- Treat changing an optional parameter's default as a behavior break. If the default has to change, add a new overload and leave the old default where it was.

## Catching breaks before you ship: package validation

The .NET SDK ships API Compat as part of the pack pipeline. Point it at the last version you released:

```xml
<!-- Acme.Core.csproj, .NET SDK 10.0.302 -->
<PropertyGroup>
  <TargetFramework>net10.0</TargetFramework>
  <PackageVersion>2.0.0</PackageVersion>
  <EnablePackageValidation>true</EnablePackageValidation>
  <!-- resolved from your NuGet feed -->
  <PackageValidationBaselineVersion>1.0.0</PackageValidationBaselineVersion>
  <!-- opt in: report parameter renames too -->
  <ApiCompatEnableRuleCannotChangeParameterName>true</ApiCompatEnableRuleCannotChangeParameterName>
</PropertyGroup>
```

For a local experiment you can use `PackageValidationBaselinePath` with a path to the old `.nupkg` instead of a version. Running `dotnet pack` on the v2 library above produced:

```text
error CP0002: Member 'string Acme.Core.Api.Connect(string)' exists on [Baseline] lib/net10.0/Acme.Core.dll but not on lib/net10.0/Acme.Core.dll
error CP0002: Member 'string Acme.Core.Api.Describe()' exists on [Baseline] lib/net10.0/Acme.Core.dll but not on lib/net10.0/Acme.Core.dll
error CP0017: Parameter name on member 'Acme.Core.Api.Send(string)' changed from 'message' to 'text'.
```

When a break is intentional (a major version), regenerate the suppression file with `dotnet pack -p:ApiCompatGenerateSuppressionFile=true`, commit `CompatibilitySuppressions.xml` so the break is visible in review, and move the baseline forward after release. The [diagnostic ID reference](https://learn.microsoft.com/en-us/dotnet/fundamentals/apicompat/diagnostic-ids) lists every `CP` and `PKV` code; `CP0006` (interface member without a default implementation) and `CP0005` (new abstract member) are the ones you will meet most after `CP0002`.

Now look at what the same run did **not** report:

- The `const` change (3 to 5) and the default value change (3 to 5). Expected: they are not API shape changes.
- The new `Load(Uri)` overload that made `Load(null)` ambiguous. Also expected: adding members is allowed.
- **The field-to-property change on `Version`.** I re-ran it in isolation to be sure: changing `public static string Version = "1.0";` to `public static string Version { get; set; } = "1.0";` packed successfully with no diagnostic, while renaming the field to `Ver` produced `CP0002: Member 'string Acme.Core.Api.Version' exists on [Baseline]...`. On SDK 10.0.302, API Compat matches the member by name and type and does not notice that it changed kind, yet the old binary fails with `MissingFieldException`.

So package validation is a necessary net, not a sufficient one. Keep a small "old consumer" test: compile a test assembly against the previous package version, then run it against the new build, exactly like the DLL swap in this post. That catches the field/property case and any behavior break your tests assert on.

## Which one should you worry about?

It depends on how your library is consumed:

- **Low-level packages** that other packages depend on (serializers, clients, logging, utilities): binary compatibility is non-negotiable within a major version. Your consumers' consumers cannot recompile the code that calls you. A binary break here is what produces the dreaded mix of `MissingMethodException` and [assembly load failures](/2026/05/fix-could-not-load-file-or-assembly-in-published-app/) in apps that never referenced you directly.
- **Top-level packages** referenced only by applications (UI component suites, app frameworks): consumers always recompile, so binary breaks are cheap, but source breaks cost every consumer an upgrade task.
- **Internal code in one solution**: neither matters much, since everything is rebuilt together. Rename freely.

In all cases, follow semantic versioning: binary or source breaks only in a major version, staged with `[Obsolete]` messages in the minor versions before, and preferably with the old member kept around as a forwarding shim for as long as it is cheap.

## Sources

- [Breaking changes and .NET libraries](https://learn.microsoft.com/en-us/dotnet/standard/library-guidance/breaking-changes), Microsoft Learn
- [.NET API changes that affect compatibility](https://learn.microsoft.com/en-us/dotnet/core/compatibility/library-change-rules), Microsoft Learn
- [.NET package validation overview](https://learn.microsoft.com/en-us/dotnet/fundamentals/apicompat/package-validation/overview) and the [baseline version validator](https://learn.microsoft.com/en-us/dotnet/fundamentals/apicompat/package-validation/baseline-version-validator)
- [Package validation diagnostic IDs](https://learn.microsoft.com/en-us/dotnet/fundamentals/apicompat/diagnostic-ids)
