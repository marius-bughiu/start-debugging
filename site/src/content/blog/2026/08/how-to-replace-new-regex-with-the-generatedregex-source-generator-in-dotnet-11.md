---
title: "How to replace new Regex(...) with the [GeneratedRegex] source generator in .NET 11"
description: "A complete guide to converting new Regex(pattern, RegexOptions.Compiled) into [GeneratedRegex] in .NET 11: the mechanical rewrite, partial methods vs partial properties, measured startup and throughput numbers, the SYSLIB1040-1045 diagnostics, and the two patterns where the generator silently falls back to a cached Regex."
pubDate: 2026-08-02
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "regex"
  - "source-generators"
  - "performance"
  - "native-aot"
---

If your pattern is a compile-time constant, delete `new Regex(pattern, RegexOptions.Compiled)` and put `[GeneratedRegex(pattern)]` on a partial method or partial property that returns `Regex`. The source generator emits a `Regex`-derived type at build time, so you pay zero parse, analysis, and reflection-emit cost at runtime, the code is trimmable and Native AOT friendly, and you can step into the matcher in the debugger. In my measurements on .NET 10.0.201 the generated matcher was marginally faster than `RegexOptions.Compiled` in steady state (35 ns vs 37 ns per `IsMatch`) and reached its first match in roughly half the time (5.8 ms vs 12.2 ms in a cold process).

Everything below targets .NET 11 (Preview 6 at the time of writing, SDK `11.0.100-preview.6`) with C# 14, but the attribute and the generator have been stable since .NET 7, and the numbers in this post were measured on the .NET 10.0.201 SDK because that is the newest SDK I have a full runtime for. Nothing about the API surface changed between the two.

## The conversion, start to finish

1. Confirm the pattern is a compile-time constant. If it is built from user input or configuration, stop here: the generator cannot help you.
2. Mark the containing type `partial`, along with every type it is nested inside.
3. Replace the `static readonly Regex` field with a `static partial Regex` method (or a get-only `static partial Regex` property on .NET 9 and later).
4. Move the pattern, the options, and any timeout onto a `[GeneratedRegex]` attribute on that member.
5. Drop `RegexOptions.Compiled` from the options. The generator ignores it.
6. Rewrite call sites from `s_myRegex.IsMatch(text)` to `MyRegex().IsMatch(text)`.
7. Open the generated file and check the XML comment on the emitted class. If it says "Caches a `Regex` instance", the generator gave up and you got nothing.

Step 7 is the one everybody skips, and it is the one that decides whether the whole exercise was worth doing.

## Why the interpreter and RegexOptions.Compiled both cost you something

When you write `new Regex("somepattern")`, the pattern gets parsed into a tree, the tree gets optimized, and the result is written out as opcodes for the regex interpreter. Every match then walks those opcodes. It works everywhere and it is cheap to construct, but each opcode dispatch is a branch the CPU has to predict.

`RegexOptions.Compiled` pays a much larger construction bill to remove that dispatch. It does everything the interpreter does, then runs the resulting node tree through a `System.Reflection.Emit` based compiler that writes IL into a handful of `DynamicMethod` objects. That IL still has to be JIT-compiled on first use. As the [Microsoft docs put it](https://learn.microsoft.com/en-us/dotnet/standard/base-types/regular-expression-source-generators), `RegexOptions.Compiled` "represents a fundamental tradeoff between overheads on the first use and overheads on every subsequent use". Worse, it depends on runtime code generation, so on platforms that forbid dynamically generated code, and under Native AOT, `Compiled` quietly becomes a no-op and you are back on the interpreter without any warning.

The source generator removes the tradeoff instead of trading along it. The same analysis and optimization work happens, but it happens on the build machine, and what lands in your assembly is ordinary C# that the compiler turns into ordinary IL.

## The rewrite

Here is the shape almost every codebase has:

```csharp
// .NET 11, C# 14 - the pattern you are replacing
private static readonly Regex s_email = new(
    @"^(?<user>[A-Za-z0-9._%+-]+)@(?<host>[A-Za-z0-9.-]+)\.(?<tld>[A-Za-z]{2,})$",
    RegexOptions.Compiled);

public static bool IsEmail(string s) => s_email.IsMatch(s);
```

And the source-generated equivalent:

```csharp
// .NET 11, C# 14
internal static partial class EmailRules
{
    [GeneratedRegex(@"^(?<user>[A-Za-z0-9._%+-]+)@(?<host>[A-Za-z0-9.-]+)\.(?<tld>[A-Za-z]{2,})$")]
    private static partial Regex Email();

    public static bool IsEmail(string s) => Email().IsMatch(s);
}
```

Three things to notice. The class became `partial`. `RegexOptions.Compiled` is gone, because the generator ignores it and its presence just misleads the next reader. And the method has no body: you declare it, the generator implements it.

You do not need to cache anything yourself. The generated implementation returns a `static readonly` singleton, which you can see for yourself in the emitted source.

### Partial properties, if a method call reads wrong

Since .NET 9 and C# 13, `[GeneratedRegex]` also applies to get-only partial properties, which reads better when the regex is conceptually a value rather than an operation:

```csharp
// .NET 11, C# 14 - requires C# 13 or later for partial properties
internal static partial class PhoneRules
{
    [GeneratedRegex(@"^\d{3}-\d{4}$")]
    internal static partial Regex Phone { get; }
}
```

The property must be get-only. Give it a setter and the generator rejects it. There is no behavioural difference between the two forms; pick one and be consistent.

### Options, culture, and timeouts

The attribute has five constructor overloads, layering on options, a culture name, and a match timeout in milliseconds:

```csharp
// .NET 11, C# 14
[GeneratedRegex(
    pattern: "abc|def",
    options: RegexOptions.IgnoreCase | RegexOptions.Multiline,
    cultureName: "en-US",
    matchTimeoutMilliseconds: 1000)]
private static partial Regex AbcOrDef();
```

`cultureName` only matters for case-insensitive matching. If you pass `RegexOptions.CultureInvariant`, you must not also pass a culture name, and the failure mode there is genuinely confusing. See the gotchas below.

## What the numbers actually look like

I measured this rather than repeating the folklore. The setup: a console app on .NET 10.0.201, Windows 11 x64, Release build, matching the anchored email pattern above against 1,000 strings, a third of which do not match. Three engines: the interpreter, `RegexOptions.Compiled`, and `[GeneratedRegex]`.

Steady-state throughput, 200,000 `IsMatch` calls per round, best of ten rounds after three full warmup rounds of every engine:

| Engine | Time | Per call |
| --- | --- | --- |
| Interpreter | 22.1 ms | 111 ns |
| `RegexOptions.Compiled` | 7.4 ms | 37 ns |
| `[GeneratedRegex]` | 7.0 ms | 35 ns |

Cold-process first match, each engine measured in its own process so nothing is pre-warmed, four runs:

| Engine | Construction plus first `IsMatch` |
| --- | --- |
| Interpreter | 3.7 to 4.0 ms |
| `RegexOptions.Compiled` | 12.0 to 12.7 ms |
| `[GeneratedRegex]` | 5.7 to 6.1 ms |

Read those two tables together. Against `Compiled`, the generator is a small throughput win and a large startup win: same steady state, less than half the time to get there. Against the interpreter, it is a 3.2x throughput win that costs about 2 ms of extra startup in a cold process, most of which is JIT time for the emitted matcher, and which disappears entirely under Native AOT because there is no JIT left to pay.

A warning about benchmarking this yourself: my first attempt had the interpreter looking twice as fast as `Compiled`, which is nonsense. The cause was that all three engines shared one measurement method, so whichever ran first absorbed the tiered-JIT cost of the harness itself. Warm every engine through the harness before you measure any of them.

## The analyzer already knows

You do not have to find these call sites by hand. The .NET SDK ships `SYSLIB1045`, an info-level analyzer that flags any `Regex` usage convertible to source generation, along with a code fix that performs the conversion for you. Info severity means it shows up as a lightbulb in the IDE and nowhere else, so escalate it:

```ini
# .editorconfig
[*.cs]
dotnet_diagnostic.SYSLIB1045.severity = warning
```

Now `dotnet build` lists every remaining call site, and `dotnet format analyzers` can apply the fix in bulk. Set the severity to `error` once the codebase is clean so nobody adds a new one.

## When the generator quietly gives up

This is the part that bites, because it is not an error and not a warning. Two constructs make the generator refuse to emit a custom matcher, and in both cases it falls back to emitting a cached plain `Regex` instance. Your code compiles, your tests pass, and you got none of the benefit.

The first is `RegexOptions.NonBacktracking`, which neither the source generator nor `RegexCompiler` supports. The second is case-insensitive backreferences: matching `IgnoreCase` backreferences requires an internal casing table that lives inside `System.Text.RegularExpressions.dll` and is not accessible to generated code. This is the only construct `RegexCompiler` handles that the source generator does not.

You can see both directly. Add this to your project file:

```xml
<PropertyGroup>
  <EmitCompilerGeneratedFiles>true</EmitCompilerGeneratedFiles>
  <CompilerGeneratedFilesOutputPath>generated</CompilerGeneratedFilesOutputPath>
</PropertyGroup>
```

Then compile these three members and read `generated/System.Text.RegularExpressions.Generator/.../RegexGenerator.g.cs`:

```csharp
// .NET 11, C# 14
internal static partial class NonBt
{
    [GeneratedRegex(@"\d+", RegexOptions.NonBacktracking)]
    internal static partial Regex Digits();
}

internal static partial class IgnoreCaseBackref
{
    [GeneratedRegex(@"(\w)\1", RegexOptions.IgnoreCase)]
    internal static partial Regex Doubled();
}

internal static partial class Fine
{
    [GeneratedRegex(@"^\d{3}-\d{4}$")]
    internal static partial Regex Phone { get; }
}
```

The emitted file is unambiguous about which of the three worked:

```csharp
/// <summary>Caches a <see cref="Regex"/> instance for the Digits method.</summary>
/// <remarks>A custom Regex-derived type could not be generated because RegexOptions.NonBacktracking isn't supported.</remarks>
file sealed class Digits_0 : Regex
{
    internal static readonly Regex Instance = new("\\d+", RegexOptions.NonBacktracking);
}

/// <summary>Caches a <see cref="Regex"/> instance for the Doubled method.</summary>
/// <remarks>A custom Regex-derived type could not be generated because the expression contains case-insensitive backreferences which are not supported by the source generator.</remarks>
file sealed class Doubled_1 : Regex
{
    internal static readonly Regex Instance = new("(\\w)\\1", RegexOptions.IgnoreCase);
}

/// <summary>Custom <see cref="Regex"/>-derived type for the Phone method.</summary>
file sealed class Phone_2 : Regex
{
    internal static readonly Phone_2 Instance = new();
    // ... RunnerFactory, Runner, TryMatchAtCurrentPosition, and so on
}
```

"Caches a `Regex` instance" is the fallback. "Custom `Regex`-derived type" is the real thing. The generator also reports `SYSLIB1044` for the fallback cases, but its severity is **Info**, so it will not appear in a normal build log or fail CI. If you care, raise it in `.editorconfig`:

```ini
dotnet_diagnostic.SYSLIB1044.severity = warning
```

The fallback is not worthless. You still get the caching and the descriptive XML comments. But if you converted a hot path expecting a speedup, you need to know you did not get one.

## The diagnostics, with their real messages

These are the exact strings the .NET 10 SDK emits, not paraphrases:

| ID | Severity | Message |
| --- | --- | --- |
| `SYSLIB1040` | Error | Invalid `GeneratedRegexAttribute` usage. |
| `SYSLIB1041` | Error | Multiple `GeneratedRegexAttribute` attributes were applied to the same method, but only one is allowed. |
| `SYSLIB1042` | Error | The specified regex is invalid. |
| `SYSLIB1043` | Error | `GeneratedRegexAttribute` method or property must be partial, parameterless, non-generic, non-abstract, and return `Regex`. If a property, it must also be get-only. |
| `SYSLIB1044` | Info | The regex generator couldn't generate a complete source implementation for the specified regular expression due to an internal limitation. |
| `SYSLIB1045` | Info | Use `GeneratedRegexAttribute` to generate the regular expression implementation at compile time. |

## Gotchas that cost real time

**A non-partial containing type does not give you a SYSLIB error.** The generator emits its half of the partial type regardless, and the C# compiler is the one that complains, with `CS0260: Missing partial modifier on declaration of type 'NotPartial'; another partial declaration of this type exists`. If you are nested three types deep, all three need `partial`.

**`CultureInvariant` plus an explicit culture name produces a misleading message.** This combination:

```csharp
[GeneratedRegex(@"abc", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, "en-US")]
internal static partial Regex Abc();
```

fails with `error SYSLIB1042: The specified regex is invalid. 'cultureName'`. The pattern `abc` is obviously fine. The problem is that `CultureInvariant` and a named culture are mutually exclusive, and the diagnostic reuses the invalid-pattern message with the offending argument name as its payload. Drop the culture name, or drop `CultureInvariant`.

**A pinned `LangVersion` breaks the build in the generated file, not your file.** The generator emits `file`-scoped types, a C# 11 feature. Force `LangVersion` to 10 and you get `CS8936: Feature 'file types' is not available in C# 10.0. Please use language version 11.0 or greater`, pointing at `RegexGenerator.g.cs`. Partial properties push the floor to C# 13: `CS8703: The modifier 'partial' is not valid for this item in C# 10.0. Please use language version '13.0' or greater`. Modern SDKs default `LangVersion` to match the target framework, so this only bites codebases that pin it explicitly.

**Case-insensitive matching is frozen at build time.** For a case-insensitive regex the engines expand the pattern using an internal Unicode casing table, so `abc` becomes the equivalent of `[Aa][Bb][Cc]`. The other engines do that expansion at runtime, using the casing table of whatever runtime you are on. The source generator does it at compile time, using the casing table of the target framework you compiled against. If a future Unicode revision changes an equivalence, a source-generated regex keeps the old behaviour until you rebuild. This is documented in the [`GeneratedRegexAttribute` remarks](https://learn.microsoft.com/en-us/dotnet/api/system.text.regularexpressions.generatedregexattribute) and it is almost never a problem, but "almost never" is not "never".

**Timeout checks are compiled in or out, globally.** The generated code reads the ambient default once:

```csharp
internal static readonly TimeSpan s_defaultTimeout =
    AppContext.GetData("REGEX_DEFAULT_MATCH_TIMEOUT") is TimeSpan timeout
        ? timeout
        : Regex.InfiniteMatchTimeout;

internal static readonly bool s_hasTimeout = s_defaultTimeout != Regex.InfiniteMatchTimeout;
```

and gates every `base.CheckTimeout()` call in backtracking loops behind `s_hasTimeout`. That is good for throughput on the default path, and it means that if you never set `REGEX_DEFAULT_MATCH_TIMEOUT` and never pass `matchTimeoutMilliseconds`, a catastrophically backtracking pattern against hostile input will run until the heat death of your request pipeline. If a pattern touches untrusted input, set `matchTimeoutMilliseconds` on the attribute, or switch that specific pattern to `RegexOptions.NonBacktracking` and accept the fallback.

**Code size grows.** The generator emits real C# per pattern, and a large pattern generates a lot of it. If you have hundreds of regexes and only a handful are hot, converting all of them trades binary size for throughput you will not observe. The interpreter is the right answer for a pattern that runs twice during startup.

## Where this matters most: trimming and Native AOT

The strongest argument for the generator is not the 2 ns per call. It is that `RegexOptions.Compiled` depends on `System.Reflection.Emit`, which is exactly the kind of dependency that [trim-safe code](/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/) avoids and that [Native AOT](/2026/06/what-is-native-aot-and-what-does-it-cost-you/) removes outright. Under AOT, `Compiled` is a silent no-op and your carefully optimized hot path is running on the interpreter.

Source generation inverts that. Because the matcher is plain C# that the linker can see, the trimmer can remove `RegexCompiler` and potentially reflection-emit itself from the published output, and the generated matcher is compiled ahead of time along with everything else. If you are publishing AOT, converting every constant pattern is not an optimization, it is a correctness fix for an assumption your code is silently making.

## Related

- [What is a source generator and when do I need one?](/2026/06/what-is-a-source-generator-and-when-do-i-need-one/)
- [RegexOptions.AnyNewLine lands in .NET 11 Preview 3](/2026/04/regex-anynewline-dotnet-11-preview-3/)
- [How to use SearchValues correctly in .NET 11](/2026/04/how-to-use-searchvalues-correctly-in-dotnet-11/)
- [What is Native AOT and what does it cost you?](/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [What is trim-safe code and how do I write it?](/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/)

## Sources

- [.NET regular expression source generators](https://learn.microsoft.com/en-us/dotnet/standard/base-types/regular-expression-source-generators) on Microsoft Learn
- [`GeneratedRegexAttribute` API reference](https://learn.microsoft.com/en-us/dotnet/api/system.text.regularexpressions.generatedregexattribute), including the compile-time casing table remarks
- [SYSLIB diagnostics for regex source generation](https://learn.microsoft.com/en-us/dotnet/fundamentals/syslib-diagnostics/syslib1040-1049)
- [Regular Expression Improvements in .NET 7](https://devblogs.microsoft.com/dotnet/regular-expression-improvements-in-dotnet-7/) on the .NET Blog
- [`DiagnosticDescriptors.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Text.RegularExpressions/gen/DiagnosticDescriptors.cs) in dotnet/runtime, for the severity of each diagnostic

Benchmark numbers and diagnostic text in this post were produced locally on the .NET 10.0.201 SDK, Windows 11 x64, Release configuration.
