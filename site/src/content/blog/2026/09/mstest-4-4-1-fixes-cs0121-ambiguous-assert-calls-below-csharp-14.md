---
title: "MSTest 4.4.1 Fixes the CS0121 Ambiguous Assert Calls That 4.4.0 Broke Below C# 14"
description: "MSTest 4.4.0 added Span<T> and ReadOnlySpan<T> overloads to Assert.Contains and Assert.DoesNotContain, which made ordinary array and string assertions fail with CS0121 on net8.0, net9.0, or any project below C# 14. MSTest 4.4.1, published on 2026-09-16, adds exact array overloads and constrained forwarders. Two explicit-generic call shapes still fail."
pubDate: 2026-09-17
tags:
  - "mstest"
  - "testing"
  - "csharp"
  - "dotnet"
  - "breaking-changes"
---

If you bumped MSTest to 4.4.0 in a project that targets `net8.0` or `net9.0`, your test project may have stopped compiling on lines that had not changed in years. [MSTest 4.4.1](https://github.com/microsoft/testfx/releases/tag/v4.4.1), published to NuGet on 2026-09-16, fixes that. Here is what broke, the version matrix I measured, and the two call shapes that 4.4.1 still does not cover.

## Span overloads that only C# 14 can rank

MSTest 4.4.0 added `Span<T>` and `ReadOnlySpan<T>` overloads next to the existing `IEnumerable<T>` ones on `Assert.Contains` and `Assert.DoesNotContain`. On C# 14, first-class span conversions give the compiler tie-breaking rules for arrays and strings, so it picks an overload. Below C# 14, `T[]` to `Span<T>` is only a user-defined `op_Implicit`, and neither overload is better. [Issue #11022](https://github.com/microsoft/testfx/issues/11022) reported this on the day after 4.4.0 shipped:

```text
error CS0121: The call is ambiguous between the following methods or properties:
'Assert.Contains<T>(T, System.Collections.Generic.IEnumerable<T>, string?, string, string)' and
'Assert.Contains<T>(T, System.Span<T>, string?, string, string)'
```

Since `net8.0` defaults to C# 12 and `net9.0` to C# 13, those TFMs break out of the box. So does a `net10.0` project pinned to an older `LangVersion`.

## The version matrix

I compiled the same file against each version with SDK 10.0.302:

```csharp
int[] ids = [1, 2, 3];
string name = "Marius";

Assert.Contains(2, ids);
Assert.DoesNotContain(4, ids);
Assert.DoesNotContain('z', name);
Assert.Contains<int>(2, ids);
```

| MSTest | Target / language | Result |
| --- | --- | --- |
| 4.3.3 | `net8.0`, `net10.0` | builds |
| 4.4.0 | `net10.0` (C# 14) | builds |
| 4.4.0 | `net8.0`, `net9.0`, or `net10.0` with `LangVersion` 12 | 4 x `CS0121` |
| 4.4.0 | `net8.0` with `LangVersion` 14 | builds |
| 4.4.1 | `net8.0`, `net10.0` | builds |

All four calls fail on 4.4.0, including the explicit `Contains<int>` and the `string` case. The only 4.4.0 workaround is raising `LangVersion` to 14 on an older TFM, which is not a supported combination. Upgrading is the real fix:

```xml
<PackageReference Include="MSTest" Version="4.4.1" />
```

If you use `MSTest.Sdk`, bump the version in `global.json` or in the `Sdk="MSTest.Sdk/4.4.1"` attribute instead.

## How 4.4.1 fixes it, and what it leaves out

[PR #11038](https://github.com/microsoft/testfx/pull/11038) adds exact `T[]` overloads to every affected `Assert` family. An exact match beats both conversions, so inferred and explicit calls on arrays resolve again. It also adds constrained forwarders that keep inferred calls working for other types that convert to a span, such as `string`, `ArraySegment<T>`, and your own collections. They forward to the existing `IEnumerable<T>` code, so behavior matches 4.3.3.

The PR says explicit `<T>` calls on non-array types are out of scope, and my probe on 4.4.1 with `net8.0` agrees:

```csharp
var seg = new ArraySegment<int>(ids);
Assert.Contains(2, seg);           // OK
Assert.Contains(2, ids.AsSpan());  // OK
Assert.Contains<int>(2, seg);      // CS0121
Assert.Contains<char>('M', name);  // CS0121
```

Drop the type argument and let inference pick the forwarder, or cast to `IEnumerable<T>`.

The same release also narrows what the MSTest source generator roots for trimming and Native AOT, and fixes source-generated literals for enums, narrow integral types, `NaN`, and control characters. If you turned on the generator after [MSTest 4.4 graduated it](/2026/09/mstest-4-4-native-aot-source-generation/), that is a second reason to take 4.4.1.
