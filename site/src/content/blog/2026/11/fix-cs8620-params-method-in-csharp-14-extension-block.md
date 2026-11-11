---
title: "Fix: CS8620 \"Argument of type 'string' cannot be used for parameter ... due to differences in the nullability\" on a params method in a C# 14 extension block"
description: "CS8620 on a params member inside a C# 14 extension block is a Roslyn bug in the .NET SDK 10.0.1xx band. Move to SDK 10.0.200+ or 11.0.100, or pass an array until you can."
pubDate: 2026-11-11
template: error-page
tags:
  - "errors"
  - "csharp"
  - "csharp-14"
  - "dotnet-10"
  - "nullable"
---

The CS8620 warning you get when you call a `params` member declared inside a C# 14 `extension(...)` block is a compiler bug, not a nullability problem in your code. It is [dotnet/roslyn#80024](https://github.com/dotnet/roslyn/issues/80024), and the fix shipped in the .NET SDK 10.0.200 feature band (March 2026) and in every .NET 11 SDK, but it was never backported to 10.0.1xx: SDK 10.0.115, released on 2026-11-10, still reports it. Build with SDK 10.0.200 or later (pin it with `global.json`), and if you are stuck on the 1xx band, pass the arguments as a collection expression (`w.Tag(["a", "b"])`) or keep the `params` method as a classic `this` extension method.

## The warning as the compiler prints it

```text
Program.cs(6,7): warning CS8620: Argument of type 'string' cannot be used for parameter 'tags' of type 'string[]' in 'void extension(Widget).Tag(params string[] tags)' due to differences in the nullability of reference types.
Program.cs(6,12): warning CS8620: Argument of type 'string' cannot be used for parameter 'tags' of type 'string[]' in 'void extension(Widget).Tag(params string[] tags)' due to differences in the nullability of reference types.
```

The shape that brings people here, from the [Stack Overflow question](https://stackoverflow.com/questions/79826396) that started the hunt, is a logging helper with tuple arguments:

```text
warning CS8620: Argument of type '(string, object)' cannot be used for parameter 'scopes' of type '(string key, object? value)[]' in ...
```

Two things in that message are a giveaway that something is off. It compares a single element (`string`) against the whole array type (`string[]`), which is never a valid comparison, and it blames nullability when nothing in the call is nullable. Changing the parameter to `string?[]`, `string[]?` or `string?[]?` does not make it go away, because nullability is not the problem.

## Why the compiler reports a nullability mismatch that is not there

When you call a `params` method with loose arguments (`w.Tag("a", "b")`), the compiler uses the "expanded form": it builds the array for you and should check each argument against the element type, `string`. The nullable flow analysis has to know which declared parameter is the `params` one to do that.

For extension members the receiver is also treated as an argument during that analysis, so the list of parameters it walks is the method's parameters plus the receiver. The [fix PR, dotnet/roslyn#80433](https://github.com/dotnet/roslyn/pull/80433), explains that the old check decided "is this the last parameter?" by looking at the parameter's `Ordinal`, which is not adjusted for that extra receiver slot. The check fails, the analyzer thinks the call is in normal form, and it compares each `string` argument to `string[]`. The two types differ, and because this check lives in the nullable analysis, the difference is reported as a nullability mismatch: CS8620.

Classic extension methods (`this Widget w`) go through a different path and never hit this. Calling the same member with an actual array also avoids it, because in normal form the argument really is a `string[]`.

## A minimal repro with every call shape

Here is the smallest project that shows the bug, plus the call shapes that do and do not trigger it. Nothing here is nullable except one tuple element, which is there to mirror the Stack Overflow case.

```csharp
// .NET 10, C# 14 -- Extensions.cs
namespace Repro;

public sealed class Widget;

public static class ClassicExtensions
{
    public static void TagClassic(this Widget w, params string[] tags) { }
}

public static class BlockExtensions
{
    extension(Widget w)
    {
        public void Tag(params string[] tags) { }
        public void TagSpan(params ReadOnlySpan<string> tags) { }
        public void TagList(params IEnumerable<string> tags) { }
        public void Codes(params int[] codes) { }
        public void Pairs(params (string key, object? value)[] pairs) { }
    }

    extension(Widget)
    {
        public static Widget Create(params string[] tags) => new();
    }
}
```

```csharp
// .NET 10, C# 14 -- Program.cs (Nullable enabled)
using Repro;

var w = new Widget();

w.TagClassic("a", "b");                 // line 5
w.Tag("a", "b");                        // line 6
w.Tag(["a", "b"]);                      // line 7
w.Tag(new[] { "a", "b" });              // line 8
w.Tag();                                // line 9
w.Tag("a");                             // line 10
w.TagSpan("a", "b");                    // line 11
w.TagList("a", "b");                    // line 12
w.Codes(1, 2);                          // line 13
w.Pairs(("k", 1), ("v", null));         // line 14
Widget.Create("a", "b");                // line 15
BlockExtensions.Tag(w, "a", "b");       // line 16
w.Tag("a", "b"!);                       // line 17
w.Tag("a"!, "b"!);                      // line 18
```

The project is a plain console app with `<TargetFramework>net10.0</TargetFramework>` (`net11.0` for the .NET 11 run), `<Nullable>enable</Nullable>` and `<ImplicitUsings>enable</ImplicitUsings>`. I built it for this post on macOS arm64 with `dotnet build --no-incremental` against three SDKs and printed the exact compiler with `#error version`:

| SDK | Roslyn (`#error version`) | CS8620 warnings |
| --- | --- | --- |
| 10.0.115 (1xx band, released 2026-11-10) | 5.0.0-2.26529.108 | 14, one per loose argument |
| 10.0.302 | 5.6.0-2.26329.109 | 0 |
| 11.0.100 | 5.12.0-1.26529.118 (C# 15) | 0 |

On 10.0.115 the warnings land on lines 6, 10, 11, 12, 13, 14, 15 and 17. That tells you a lot about the bug's boundaries:

- **Classic extension methods are clean** (line 5).
- **Normal form is clean**: a collection expression (line 7), an explicit array (line 8) and zero arguments (line 9) produce no warning.
- **Every params collection type is affected**: `ReadOnlySpan<string>` (line 11) and `IEnumerable<string>` (line 12), the C# 13 [params collections](/2025/01/csharp-13-params-collections/), fail the same way as arrays.
- **Value types are affected too**: `params int[]` (line 13) reports "differences in the nullability of reference types" for two `int` arguments. That alone proves the diagnostic is bogus.
- **Static extension members are affected** (line 15), which is the exact repro in the original Roslyn issue.
- **The static-call form is clean**: `BlockExtensions.Tag(w, "a", "b")` (line 16) compiles to a call on the generated static method and does not go through the receiver path.
- **`!` works per argument only**: on line 17 the first argument still warns, while line 18 with `!` on every argument is silent.

## Fix 1: build with SDK 10.0.200 or later

This is the real fix, and the only one that does not change your code. The Roslyn PR merged in September 2025 under the Visual Studio 18.3 milestone, but, as the issue thread explains, it landed on the main branch and was not backported to the release branch in time for the 10.0.100 GA, and no 1xx servicing release has picked it up since. According to the [.NET 10 release metadata](https://builds.dotnet.microsoft.com/dotnet/release-metadata/10.0/releases.json), 10.0.200 shipped on 2026-03-10 alongside 10.0.104, and the issue thread confirms that the Visual Studio 18.4 / SDK 10.0.200 combination no longer warns. Any 11.0 SDK has it as well.

Check which SDK actually builds your project, from the project folder, because `global.json` can override the newest one installed:

```bash
# .NET SDK 10.0.x
dotnet --version
dotnet --list-sdks
```

If it prints `10.0.1xx`, either remove a `global.json` that pins the 1xx band, or pin a fixed band explicitly:

```json
{
  "sdk": {
    "version": "10.0.200",
    "rollForward": "latestFeature"
  }
}
```

With `rollForward: latestFeature` the CLI picks the highest installed 10.0 feature band at or above 10.0.200, so 10.0.302 or 10.0.404 also satisfy it, while a machine that only has 10.0.115 fails fast with "A compatible .NET SDK was not found" instead of silently reintroducing the warning. If you manage SDKs across machines, [dotnetup can install whatever your global.json pins](/2026/10/dotnetup-public-preview-installs-the-sdk-your-global-json-pins/).

Watch out for where your build agents get the SDK from:

- **Linux distro packages** (the `dotnet-sdk-10.0` packages in Ubuntu's own feed, for example) are typically limited to the 1xx band, as the [dotnet-docker installation guide](https://github.com/dotnet/dotnet-docker/blob/main/documentation/scenarios/installing-dotnet.md) points out. Those agents keep producing CS8620 even after your laptop is clean. Install from packages.microsoft.com, the binary archive or `dotnet-install.sh` instead.
- **The `mcr.microsoft.com/dotnet/sdk:10.0` image** currently ships SDK 10.0.404 according to the repo's `manifest.versions.json`, so container builds are already fixed.
- **`actions/setup-dotnet` with `dotnet-version: 10.0.1xx`** installs the broken band on purpose. Use `10.0.x` or a `global-json-file` input.

One more detail I verified: what matters is the compiler of the project making the call, not the one that compiled the extension. A library built with 10.0.302 still produces two CS8620 warnings at the call site when a consumer project referencing its DLL is built with 10.0.115, and none when the consumer is built with 10.0.302. If you publish a library with `params` extension members, your users on 1xx SDKs will see the warning in their own code.

## Fix 2: pass a collection instead of loose arguments

If you cannot move the SDK yet, call the member in normal form. A collection expression keeps the call site almost as short:

```csharp
// .NET 10 SDK 10.0.1xx, C# 14
w.Tag(["a", "b"]);

logger.BeginKeyValueScope([
    ("AzureServiceBusEntityPath", args.EntityPath),
    ("AzureServiceBusMessageId", args.Message.MessageId),
]);
```

This works for arrays, `ReadOnlySpan<T>` and `IEnumerable<T>` params alike, and it stays valid after you upgrade, so there is nothing to revert later. The cost is that every call site has to change, and the next person who writes `w.Tag("a", "b")` gets the warning back.

## Fix 3: keep the params member as a classic extension method

Extension blocks and classic `this` extension methods can live in the same static class, so you can move everything else to the new syntax and leave only the `params` members in the old form:

```csharp
// .NET 10 SDK 10.0.115, C# 14 -- builds clean with TreatWarningsAsErrors=true
namespace Wa;

public sealed class Widget;

public static class WidgetExtensions
{
    extension(Widget w)
    {
        public string Name => "widget";

        public void TagAll(IReadOnlyList<string> tags) { }
    }

    public static void Tag(this Widget w, params string[] tags) { }
}
```

Call sites stay `w.Tag("a", "b")`, and the compiled shape is the same static method with an extension attribute, so moving it into the block later is a source-only change for callers. The usual caveat applies when you migrate it: if a classic method and a block member end up with the same signature in two different classes, you get the error covered in [the call is ambiguous after moving to C# 14 extension members](/2026/08/fix-the-call-is-ambiguous-after-moving-to-csharp-14-extension-members/).

## Fix 4: suppress it narrowly, with a link

If the call sites are few and the SDK upgrade is scheduled, a scoped pragma is honest about what is going on:

```csharp
// .NET 10 SDK 10.0.1xx, C# 14
#pragma warning disable CS8620 // false positive: dotnet/roslyn#80024, fixed in SDK 10.0.200+
        w.Mark("x", "y");
#pragma warning restore CS8620
```

Do not add `<NoWarn>CS8620</NoWarn>` to the project or `dotnet_diagnostic.CS8620.severity = none` to `.editorconfig`. CS8620 is also the warning that catches real mistakes, such as passing a `List<string?>` where a `List<string>` is expected, and switching it off project-wide hides those for good. The `!` operator is a worse option still: as line 17 of the repro shows, it has to go on every argument, and it suppresses genuine null checks on those expressions too.

## Gotchas and lookalikes

- **It breaks the build under `TreatWarningsAsErrors`.** With `-p:TreatWarningsAsErrors=true` on SDK 10.0.115, the repro fails with `error CS8620` on line 6. If your CI turned red after a "harmless" refactor to extension blocks, this is why.
- **`--no-incremental` when comparing SDKs.** If you switch SDKs in the same folder to test the fix, an incremental build can skip compilation and report zero warnings from a stale build. Force a recompile.
- **A real CS8620 looks different.** If the message compares two types with the same shape, for example `List<string?>` and `List<string>`, it is a genuine nullability mismatch and the upgrade will not remove it. The bug always compares an element type with the collection type.
- **CS8604 and CS8625 are not this bug.** Those are about passing a maybe-null value to a non-nullable parameter. The [CS8618 guide](/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/) covers the most common constructor variant.
- **Static extension members and enum-wide extensions** use the same code path. If you followed [the generic enum extension pattern](/2026/08/how-to-write-a-static-extension-member-for-every-enum-type-in-csharp-14/) and added a `params` overload, expect the same warning on 1xx.

## Related

- [C# 14 extension members: extension properties, operators, and static extensions](/2026/02/csharp-14-extension-members/)
- [Fix: the call is ambiguous after moving to C# 14 extension members](/2026/08/fix-the-call-is-ambiguous-after-moving-to-csharp-14-extension-members/)
- [How to write a static extension member for every enum type in C# 14](/2026/08/how-to-write-a-static-extension-member-for-every-enum-type-in-csharp-14/)
- [C# 13: the end of params allocations](/2026/01/c-13-the-end-of-params-allocations/)
- [dotnetup public preview installs the SDK your global.json pins](/2026/10/dotnetup-public-preview-installs-the-sdk-your-global-json-pins/)

## Sources

- [dotnet/roslyn#80024: CS8620 reported on non-null argument passed to extension method with non-nullable params collection parameter](https://github.com/dotnet/roslyn/issues/80024)
- [dotnet/roslyn#80433: Fix check for extension params parameter in nullable analysis](https://github.com/dotnet/roslyn/pull/80433)
- [Stack Overflow: Nullable warning when upgrading to extension-members syntax](https://stackoverflow.com/questions/79826396)
- [Nullable reference type warnings (CS8620) on Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/nullable-warnings#mismatch-in-nullability-declaration)
- [Extension members (C# 14) on Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/extension)
- [Select the .NET version to use (global.json rollForward)](https://learn.microsoft.com/en-us/dotnet/core/versions/selection)
- [.NET 10 release metadata](https://builds.dotnet.microsoft.com/dotnet/release-metadata/10.0/releases.json)
