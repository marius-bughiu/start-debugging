---
title: "FluentValidation 12.2 fixes IsInEnum() crashing native AOT apps on [Flags] enums"
description: "FluentValidation 12.2.0, released October 10, 2026, swaps Enum.GetValues for Enum.GetValuesAsUnderlyingType inside EnumValidator, so IsInEnum() on a [Flags] enum no longer throws NotSupportedException in a native AOT binary."
pubDate: 2026-10-12
tags:
  - "fluentvalidation"
  - "native-aot"
  - "dotnet"
  - "csharp"
  - "validation"
---

[FluentValidation 12.2.0](https://github.com/FluentValidation/FluentValidation/releases/tag/12.2.0) landed on NuGet on October 10, 2026. Most of the changelog is housekeeping (Lithuanian and Belarusian messages, a couple of `PropertyChain` fixes), but one line matters a lot if you publish with `PublishAot`: "Change EnumValidator to work under native AOT". Before this release, `RuleFor(x => x.Access).IsInEnum()` on a `[Flags]` enum compiled, passed every JIT-based test, and then crashed the published native binary on the first validation call.

## What the crash looked like

Here is a minimal app. It is the shape you would find in any AOT-published minimal API that validates a permissions or options enum:

```csharp
using FluentValidation;

var v = new GrantValidator();
Console.WriteLine(v.Validate(new Grant(Access.Read | Access.Write)).IsValid);
Console.WriteLine(v.Validate(new Grant((Access)64)).IsValid);

[Flags]
public enum Access { None = 0, Read = 1, Write = 2, Delete = 4 }

public record Grant(Access Access);

public class GrantValidator : AbstractValidator<Grant>
{
    public GrantValidator() => RuleFor(x => x.Access).IsInEnum();
}
```

I published it with `<PublishAot>true</PublishAot>` on the .NET 10.0.302 SDK (osx-arm64), once against FluentValidation 12.1.1 and once against 12.2.0. On 12.1.1 the binary dies immediately:

```text
Unhandled exception. System.NotSupportedException: 'Access[]' is missing native code or metadata.
   at System.Array.CreateInstance(Type, Int32) + 0x5c
   at System.RuntimeType.GetEnumValues() + 0x88
```

On 12.2.0 the same code prints `True` and `False`, which is the correct answer for a valid combination and an undefined bit.

## Why only [Flags] enums were affected

`EnumValidator` takes two paths. Non-flags enums go through `Enum.IsDefined`, which has always been AOT-safe. Flags enums go through a private `EvaluateFlagEnumValues` method that builds a mask from every declared value, and in 12.1.x it did that with `Enum.GetValues(Type)`. That overload is marked `[RequiresDynamicCode]` because it has to allocate an `Access[]` at runtime, and ILC cannot pre-generate an array type it never saw statically.

The publish did warn you, just not loudly. By default the trimmer collapses third-party warnings into a single line:

```text
warning IL3053: Assembly 'FluentValidation' produced AOT analysis warnings.
```

Only with `-p:TrimmerSingleWarn=false` do you see the real `IL3050` pointing at `EnumValidator.cs(103)` and `Enum.GetValues(Type)`.

## The one-line fix

[PR #2371](https://github.com/FluentValidation/FluentValidation/pull/2371) replaces the call with `Enum.GetValuesAsUnderlyingType(enumType)`, available since .NET 8 (which is FluentValidation 12's minimum target). It returns the values boxed as their underlying integer type, so no enum-typed array is created, and the existing `Convert.ToInt64` loop keeps working unchanged. No API change, no behavioural change, and it even drops a box/unbox round trip per value.

```csharp
// FluentValidation 12.2.0, EnumValidator.EvaluateFlagEnumValues
foreach (var enumValue in Enum.GetValuesAsUnderlyingType(enumType)) {
    var enumValueAsInt64 = Convert.ToInt64(enumValue);
    // ...
}
```

With 12.2.0 the `IL3053` warning for FluentValidation disappears from the publish output entirely in this sample.

## The other fix worth knowing about

12.2.0 also fixes `context.PropertyPath` inside a `.When()` on `RuleForEach` ([#2363](https://github.com/FluentValidation/FluentValidation/pull/2363)). The condition used to see the previous item's path (or `null` for the first one), because the context was updated after the condition ran. If you build error keys or log lines from `PropertyPath` inside conditions, you were getting off-by-one paths.

## What to do

Bump the package:

```bash
dotnet add package FluentValidation --version 12.2.0
```

If you ship native AOT, also set `TrimmerSingleWarn` to `false` in CI at least once. Collapsed `IL3053` lines are how bugs like this one reach production. And if you are still deciding whether you need FluentValidation at all on ASP.NET Core 11, I compared it with the built-in option in [minimal API validation vs FluentValidation](/2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11/).
