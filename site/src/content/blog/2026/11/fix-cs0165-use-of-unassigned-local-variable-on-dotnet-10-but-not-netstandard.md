---
title: "Fix: CS0165 \"Use of unassigned local variable\" on .NET 10 but not on .NET Standard 2.1"
description: "The .NET 10 error is correct: netstandard sees ImmutableArray<T> as an empty struct and hides it as warning CS8887. Assign the variable on every path."
pubDate: 2026-11-28
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-10"
  - "dotnet-11"
  - "compiler"
  - "pattern-matching"
---

The .NET 10 build is the correct one. In `Cost is { Length: 0 } cost || Foo(cost)`, the right side of `||` runs only when the pattern did not match, and that is the one path where `cost` was never assigned. The `netstandard2.1` build compiles because it sees a different `ImmutableArray<T>`. That copy has only an internal reference-type field, so the C# compiler treats it as an empty struct, and an empty struct always counts as assigned. The real error is lowered to warning CS8887, and warning level 4 hides it. To fix it, assign the variable on every path (`Cost is var cost && (cost.IsEmpty || Foo(cost))`). To catch these errors in `netstandard` builds, set `<WarningLevel>5</WarningLevel>` or higher and treat CS8887 as an error. Everything below was checked with .NET SDK 11.0.100 (Roslyn 5.12.0), building `netstandard2.1`, `net10.0` and `net11.0`.

```text
error CS0165: Use of unassigned local variable 'cost' [lib.csproj::TargetFramework=net10.0]
error CS0165: Use of unassigned local variable 'cost' [lib.csproj::TargetFramework=net11.0]
```

In a multi-targeted project, the `netstandard2.1` leg prints nothing at all. That is why this looks like a .NET 10 regression. It came up as [a Stack Overflow question](https://stackoverflow.com/questions/79986082): the library had built for months, and moving it to `net10.0` broke it.

## Why this happens: two compile-time copies of ImmutableArray<T>

Three separate things combine here.

**1. The variable really is unassigned on the right side of `||`.** A pattern variable is definitely assigned only "when true". `a || b` evaluates `b` only when `a` is false, so inside `Foo(cost)` the compiler has no assignment it can prove. This is the same rule that rejects `if (o is string s || s.Length > 0)`. The C# spec on definite assignment does not care which runtime you target.

**2. The compiler forgives this for "empty" structs.** If a struct type has no instance fields, a local of that type counts as assigned from the start, because there is nothing to initialize. For structs *loaded from metadata* (any struct defined in a referenced DLL), Roslyn has a compatibility rule from the old native compiler. It ignores fields that are **inaccessible to your assembly and of a reference type**. The comment in [`EmptyStructTypeCache.cs`](https://github.com/dotnet/roslyn/blob/main/src/Compilers/CSharp/Portable/FlowAnalysis/EmptyStructTypeCache.cs) says this mode "ignores inaccessible fields of reference type for structs loaded from metadata". A struct whose only instance fields are private or internal references is therefore "empty" for this analysis.

**3. The two targets compile against different `ImmutableArray<T>` definitions.** `netstandard2.1` does not include `System.Collections.Immutable`, so you reference the NuGet package. NuGet picks its `lib/netstandard2.0` assembly, and that one is the implementation, not a reference assembly. `net10.0` compiles against the shared framework's reference pack (`Microsoft.NETCore.App.Ref` 10.0.15 in this test). Here are the instance fields of `ImmutableArray<T>` in each, as read from metadata:

```text
System.Collections.Immutable 10.0.0, lib/netstandard2.0 (implementation)
  Assembly T[] array

Microsoft.NETCore.App.Ref 10.0.15, ref/net10.0 (reference assembly)
  Private  T[]    array
  Private  Object _dummy
  Private  Int32  _dummyPrimitive

Microsoft.NETCore.App.Ref 11.0.0, ref/net11.0: same three fields as net10.0
```

In the `netstandard2.0` copy, the only instance field is `internal T[] array`. That field is inaccessible to you and an array is a reference type, so the compatibility analysis drops it and the struct is "empty". The reference assembly adds `_dummy` and `_dummyPrimitive`. These placeholder fields come from the [hand-maintained reference source](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Collections.Immutable/ref/System.Collections.Immutable.cs) in dotnet/runtime. They exist so that a reference assembly has the same struct "shape" as the real type. A private `int` is a value-type field, the compatibility rule never ignores those, so the struct is not empty and you get CS0165.

The C# language version is not the cause. Both legs in the repro build with `LangVersion` `latest` and the same compiler.

## Where the error goes on netstandard: CS8887 and warning level 4

The CS0165 is not dropped entirely. [`DefiniteAssignment.Analyze`](https://github.com/dotnet/roslyn/blob/main/src/Compilers/CSharp/Portable/FlowAnalysis/DefiniteAssignment.cs) always runs the strict analysis first, and that one counts every field. If strict analysis finds errors, the compiler runs the compatibility analysis too. Any error found only by the strict pass is turned into a warning. For an unassigned local, that warning is **CS8887** ("Use of unassigned local variable"), part of [warning wave 5](https://learn.microsoft.com/dotnet/csharp/language-reference/compiler-messages/warning-waves). The docs describe it as firing "when a struct in an imported assembly includes an inaccessible field (usually a private field) of a reference type".

Warning waves are gated by `WarningLevel`. In SDK 11.0.100, `Microsoft.NET.Sdk.Analyzers.targets` sets it like this:

- `.NETCoreApp` targets get the TFM's major version: `net10.0` builds with `/warn:10`, `net11.0` with `/warn:11`.
- `.NETFramework` targets are pinned to 4.
- `AnalysisLevel` `preview` sets 9999.
- `.NETStandard` gets no value at all, so `csc` uses its default of 4.

So the `netstandard2.1` leg builds at warning level 4. Wave 5 is off, and CS8887 is never shown. The net10.0 leg would show the warning as well, but it never needs to: the extra `int` field means both analyses agree that this is an error.

## Minimal repro

One project, three targets. The package is only needed for `netstandard2.1`:

```xml
<!-- lib.csproj: .NET SDK 11.0.100 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFrameworks>netstandard2.1;net10.0;net11.0</TargetFrameworks>
    <LangVersion>latest</LangVersion>
  </PropertyGroup>
  <ItemGroup Condition="'$(TargetFramework)' == 'netstandard2.1'">
    <PackageReference Include="System.Collections.Immutable" Version="10.0.0" />
  </ItemGroup>
</Project>
```

```csharp
// A.cs: LangVersion latest, .NET SDK 11.0.100
using System.Collections.Immutable;

namespace ClassLibrary1;

public class A
{
    public ImmutableArray<int> Cost { get; set; }

    public bool Satisfied => Cost is { Length: 0 } cost || Foo(cost);

    static bool Foo(ImmutableArray<int> c) => true;
}
```

Building each leg with a different warning level gives:

```text
dotnet build                                   -> net10.0, net11.0: error CS0165 (netstandard2.1: clean)
dotnet build -f netstandard2.1 -p:WarningLevel=5      -> warning CS8887: Use of unassigned local variable 'cost'
dotnet build -f netstandard2.1 -p:AnalysisLevel=preview -> /warn:9999, warning CS8887
dotnet build -f netstandard2.1 -p:AnalysisLevel=latest  -> clean (does not raise WarningLevel)
dotnet build -f netstandard2.1 -p:Features=strict       -> clean
```

The pattern is not needed to trigger it. `ImmutableArray<int> v; Use(v);` behaves the same way. With the older `System.Collections.Immutable` 1.5.0 package, the result is also the same: a warning at level 5, nothing at level 4.

## The rule, tested on your own structs

To confirm that the rule depends on field accessibility and field type, not on `ImmutableArray<T>` itself, the test used a `netstandard2.0` library with six structs, consumed from a `net11.0` project at `WarningLevel` 4 and 9999. Each struct also has a `public int Length` property (omitted below), and each test was `S v; return v.Length;`:

```csharp
// Structs.dll, netstandard2.0, consumed by net11.0 via ProjectReference
public struct PrivateObject       { private object _o; }            // level 4: clean   | 9999: CS8887 warning
public struct InternalIntArray    { internal int[] _a; }            // level 4: clean   | 9999: CS8887 warning
public struct GenericArray<T>     { internal T[] _a; }              // level 4: clean   | 9999: CS8887 warning
public struct PrivateInt          { private int _x; }               // CS0165 error at both levels
public struct PrivateObjectAndInt { private object _o; private int _x; } // CS0165 error at both levels
public struct PublicObject        { public object O; }              // CS0165 error at both levels
```

One accessible field, or one value-type field of any accessibility, is enough for the hard error. Arrays count as reference types even when the element type is a value type or a type parameter. If the struct is declared in *your own* project, nothing is ignored, and you always get CS0165.

The same thing happens with common BCL structs. Each one was declared as an unassigned local and passed to a generic method, at `WarningLevel` 9999:

```text
                                netstandard2.1          net10.0
ImmutableArray<int>             warning CS8887          error CS0165
CancellationToken               warning CS8887          error CS0165
List<int>.Enumerator            warning CS8887          error CS0165
ArraySegment<int>, Memory<int>  error CS0165            error CS0165
KeyValuePair<string,string>     error CS0165            error CS0165
ValueTask, DateTime             error CS0165            error CS0165
```

So `CancellationToken ct; DoWork(ct);` also builds silently in a `netstandard2.1` library, and only fails once you add a `net10.0` target. The fix is the same.

## Why it ran correctly anyway

The original question showed that the `netstandard2.1` build, called from a .NET 10 app, returns `true` and passes the real array to `Foo`. The repro gives the same result on runtime 11.0.0 with `Cost = [1, 2]`: `Foo` received an array with `IsDefault=False, Length=2`. That works because of how the current compiler lowers the code. It copies the input into `cost` before it tests the `Length` subpattern, so the slot already holds the value when the test fails. That is a code generation detail, not something the language promises. Definite assignment exists so that this does not depend on code generation, so do not rely on it.

## The fix: assign the variable on every path

Pick whichever form reads best. Each of these builds clean on all three targets at `WarningLevel` 9999:

```csharp
// LangVersion latest, builds on netstandard2.1, net10.0, net11.0 with no CS0165 or CS8887
using System.Collections.Immutable;

public class Fixed
{
    public ImmutableArray<int> Cost { get; set; }

    // 1. `var` patterns always match, so `cost` is assigned whatever happens next
    public bool IsVar => Cost is var cost && (cost.IsEmpty || Foo(cost));

    // 2. A plain local: also reads the property only once
    public bool Local
    {
        get
        {
            var cost = Cost;
            return cost.Length == 0 || Foo(cost);
        }
    }

    // 3. A switch expression: each arm binds what it uses
    public bool Switch => Cost switch
    {
        { Length: 0 } => true,
        var cost => Foo(cost),
    };

    static bool Foo(ImmutableArray<int> c) => true;
}
```

`Cost.Length == 0 || Foo(Cost)` also compiles, but it calls the property getter twice. That matters if the getter does work, and the question's logging getter showed it. All three forms above read it once.

Be careful with `ImmutableArray<T>` here. `Length` on a default (uninitialized) `ImmutableArray<T>` throws `NullReferenceException`, and so does the `{ Length: 0 }` pattern. If `Cost` can be default, test `IsDefaultOrEmpty` instead.

## Make netstandard builds report it too

If you multi-target or still ship `netstandard2.x` libraries, raise the warning level for every target so CS8887 and its siblings show up before a `net10.0` leg turns them into errors:

```xml
<!-- Directory.Build.props: .NET SDK 10.0+ -->
<PropertyGroup>
  <!-- netstandard defaults to csc's level 4; 5+ enables the imported-struct definite assignment wave.
       TargetFrameworkIdentifier is not set yet when Directory.Build.props runs, so test TargetFramework. -->
  <WarningLevel Condition="'$(WarningLevel)' == '' And $(TargetFramework.StartsWith('netstandard'))">10</WarningLevel>
  <WarningsAsErrors>$(WarningsAsErrors);CS8880;CS8881;CS8882;CS8883;CS8884;CS8885;CS8886;CS8887</WarningsAsErrors>
</PropertyGroup>
```

With this file next to the repro, the `netstandard2.1` leg fails with `error CS8887: Use of unassigned local variable 'cost'`. A condition on `$(TargetFrameworkIdentifier)` looks more natural, but in `Directory.Build.props` it silently matches nothing: in the repro it left the build clean. CS8880 to CS8886 are the same downgrade for other cases: struct constructors that do not assign every field, `out` parameters, use of `this` before assignment, and so on. If you already use `TreatWarningsAsErrors`, raising the level is enough. Check first how many existing warnings that would turn into build breaks ([TreatWarningsAsErrors without sabotaging dev builds](/2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10/) covers scoping it to CI).

## Gotchas and lookalikes

**`<Features>strict</Features>` does not help.** It is easy to assume strict mode turns off the compatibility rule. In this repro it changes nothing: both analyses always run, and the downgrade to CS8887 still happens. `WarningLevel` is the setting that matters.

**`AnalysisLevel` `latest` is not `preview`.** Only `preview` maps to `WarningLevel` 9999 in the SDK targets. `latest` and numeric levels configure the code analyzers but leave a `netstandard` project at level 4.

**.NET Framework targets have the same blind spot.** The SDK pins `.NETFramework` to warning level 4, and the package's `lib/net462` assembly has no dummy fields. Adding a `net48` leg to the repro builds clean with `/warn:4`, and gives warning CS8887 with `-p:WarningLevel=5`.

**The squiggle depends on the IDE's target context.** In a multi-targeted project, the editor analyzes the file for one target framework at a time. With the context set to `netstandard2.1`, the red squiggle disappears, but the `net10.0` build still fails. Fix the code, not the dropdown.

**A different error with the same name.** CS0165 on a struct you declared yourself, or on a reference-type local, has nothing to do with this. The variable really is unassigned on some path. Common causes are a `try` block that assigns before an exception, a `switch` without a `default`, or an `out` assignment inside a branch. For CS8618 on fields and properties, see [CS8618 non-nullable property must contain a non-null value](/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/).

**Your own library's reference assembly does not add dummy fields.** A reference assembly that Roslyn generates (`ProduceReferenceAssembly`) keeps a struct's private fields as they are. With `ProduceReferenceAssembly=true`, the `netstandard2.0` test library's `ref/structs.dll` still had only `private object _o` on `PrivateObject`, so consumers still see it as empty. Only the hand-maintained reference sources in dotnet/runtime add `_dummyPrimitive`. If you ship a public struct whose only fields are private references, your consumers get the forgiving behavior.

## Related

- [record vs class vs struct in C#: a decision matrix](/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/), for when a struct is the right shape in the first place
- [Fix: [MemberNotNull] has no effect on a static factory method](/2026/10/fix-membernotnull-has-no-effect-on-a-static-factory-method/), another flow analysis rule that looks wrong until you see what the compiler tracks
- [Fix: CS8509 or CS0161 on a switch that is exhaustive over a C# 15 union type](/2026/10/fix-cs8509-cs0161-switch-exhaustive-over-csharp-15-union-type/), pattern matching flow analysis on the newest language version
- [TreatWarningsAsErrors without sabotaging dev builds (.NET 10)](/2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10/)
- [How to iterate over two collections in lockstep without heap allocations](/2026/10/how-to-iterate-over-two-collections-in-lockstep-without-heap-allocations-in-csharp/), which leans on `ImmutableArray<T>` and struct enumerators

## Sources

- Stack Overflow: [Why does variable from is pattern compile under .NET Standard 2.1, but fail with CS0165 on .NET 10?](https://stackoverflow.com/questions/79986082). The accepted answer points at the reference metadata. This post adds the field dump, the warning level mechanism, and the struct matrix.
- Roslyn: [`EmptyStructTypeCache.cs`](https://github.com/dotnet/roslyn/blob/main/src/Compilers/CSharp/Portable/FlowAnalysis/EmptyStructTypeCache.cs) (the compatibility rule) and [`DefiniteAssignment.cs`](https://github.com/dotnet/roslyn/blob/main/src/Compilers/CSharp/Portable/FlowAnalysis/DefiniteAssignment.cs) (strict then compatibility analysis, error-to-warning downgrade)
- Microsoft Learn: [C# warning waves, CS8880 to CS8887](https://learn.microsoft.com/dotnet/csharp/language-reference/compiler-messages/warning-waves) and [Use of unassigned local variable CS0165](https://learn.microsoft.com/dotnet/csharp/language-reference/compiler-messages/cs0165)
- dotnet/runtime: [`System.Collections.Immutable` reference source, release/10.0](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Collections.Immutable/ref/System.Collections.Immutable.cs) (the `_dummy` / `_dummyPrimitive` fields)
- dotnet/sdk: [`Microsoft.NET.Sdk.Analyzers.targets`](https://github.com/dotnet/sdk/blob/main/src/Tasks/Microsoft.NET.Build.Tasks/targets/Microsoft.NET.Sdk.Analyzers.targets) (how `WarningLevel` is chosen per target framework)
