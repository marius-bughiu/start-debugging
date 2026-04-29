---
title: "How to use SearchValues<T> correctly in .NET 11"
description: "SearchValues<T> beats IndexOfAny by 5x to 250x but only when you use it the way the runtime expects. The cache-as-static rule, the StringComparison gotcha, when not to bother, and the IndexOfAnyExcept inversion trick that nobody documents."
pubDate: 2026-04-29
tags:
  - "dotnet"
  - "dotnet-11"
  - "performance"
  - "csharp"
  - "searchvalues"
---

`SearchValues<T>` lives in `System.Buffers`. It is a precomputed, immutable set of values used with the `IndexOfAny`, `IndexOfAnyExcept`, `ContainsAny`, `LastIndexOfAny`, and `LastIndexOfAnyExcept` extension methods on `ReadOnlySpan<T>`. The rule that 90% of usage gets wrong is simple: build the `SearchValues<T>` instance once, store it in a `static readonly` field, and reuse it. Build it inside the hot method and you keep all the cost (the SIMD strategy selection, the bitmap allocation, the Aho-Corasick automaton for the string overload) and lose all the benefit. The other rule: do not reach for `SearchValues<T>` for sets of one or two values. `IndexOf` is already vectorised for the trivial cases and is faster.

This post targets .NET 11 (preview 4) on x64 and ARM64. The byte and char overloads of `SearchValues.Create` are stable since .NET 8. The string overload (`SearchValues<string>`) is stable since .NET 9 and unchanged in .NET 10 and .NET 11. The behaviour described below is identical on Windows, Linux, and macOS, because the SIMD code paths are shared across platforms, falling back to scalar code only where AVX2 / AVX-512 / NEON are unavailable.

## Why SearchValues exists

`ReadOnlySpan<char>.IndexOfAny('a', 'b', 'c')` is a one-shot call. The runtime cannot know whether the next call will use the same set or a different one, so it has to pick a search strategy on the spot every time. For three characters the JIT inlines a hand-tuned vectorised path, so the overhead is small, but the moment the set grows past four or five elements, `IndexOfAny` falls back to a generic loop with a hash-set membership check per character. That loop is fine for short inputs and disaster for long ones.

`SearchValues<T>` decouples the planning step from the search step. When you call `SearchValues.Create(needles)`, the runtime inspects the needles once: are they a contiguous range? a sparse set? do they share prefixes (for the string overload)? It picks one of several strategies (bitmap with `Vector256` shuffle, `IndexOfAnyAsciiSearcher`, `ProbabilisticMap`, `Aho-Corasick`, `Teddy`) and bakes the metadata into the instance. Every subsequent call against that instance skips the planning and dispatches straight to the chosen kernel. For a 12-element set you typically see a 5x to 50x speedup over the corresponding `IndexOfAny` overload. For string sets of 5+ needles you see 50x to 250x over a manual `Contains` loop.

The asymmetry is the point: planning is expensive, searching is cheap. If you build a fresh `SearchValues<T>` per call, you are paying the planner without amortising it.

## The cache-as-static rule

This is the canonical pattern. Note the `static readonly`:

```csharp
// .NET 11, C# 14
using System.Buffers;

internal static class CsvScanner
{
    private static readonly SearchValues<char> Delimiters =
        SearchValues.Create(",;\t\r\n\"");

    public static int FindNextDelimiter(ReadOnlySpan<char> input)
    {
        return input.IndexOfAny(Delimiters);
    }
}
```

The wrong version, which I see in PRs every week:

```csharp
// .NET 11 -- BROKEN, do not ship
public static int FindNextDelimiter(ReadOnlySpan<char> input)
{
    var delims = SearchValues.Create(",;\t\r\n\"");
    return input.IndexOfAny(delims);
}
```

It looks innocent. It allocates on every call, and the planner runs on every call. Benchmarks I ran on .NET 11 preview 4 with `BenchmarkDotNet`:

```
| Method                     | Mean       | Allocated |
|--------------------------- |-----------:|----------:|
| StaticSearchValues_1KB     |    71.4 ns |       0 B |
| RebuiltSearchValues_1KB    |   312.0 ns |     208 B |
| LoopWithIfChain_1KB        |   846.0 ns |       0 B |
```

The allocation is the more dangerous half. A misplaced `Create` in a hot path becomes a steady stream of LOH-adjacent garbage. On a 100k requests/sec service that is gigabytes per minute pressuring the GC for a value you should be reusing.

If you cannot use `static readonly` because the needles are user-supplied at startup, build the instance once during initialisation and store it on a singleton service:

```csharp
// .NET 11, C# 14
public sealed class TokenScanner
{
    private readonly SearchValues<string> _tokens;

    public TokenScanner(IEnumerable<string> tokens)
    {
        _tokens = SearchValues.Create(tokens.ToArray(), StringComparison.Ordinal);
    }

    public bool ContainsAny(ReadOnlySpan<char> input) => input.ContainsAny(_tokens);
}
```

Register it as a singleton in DI. Do not register it transient. Transient gives you the same per-call rebuild trap with extra steps.

## The StringComparison gotcha

`SearchValues<string>` (the multi-string overload added in .NET 9) takes a `StringComparison` argument:

```csharp
private static readonly SearchValues<string> Forbidden =
    SearchValues.Create(["drop", "delete", "truncate"], StringComparison.OrdinalIgnoreCase);
```

Only four values are supported: `Ordinal`, `OrdinalIgnoreCase`, `InvariantCulture`, and `InvariantCultureIgnoreCase`. Pass `CurrentCulture` or `CurrentCultureIgnoreCase` and the constructor throws `ArgumentException` at startup. This is correct: a culture-sensitive multi-string search would have to allocate per call to honour the current thread culture, which would defeat the precomputation.

Two consequences:

- For ASCII data, always use `Ordinal` or `OrdinalIgnoreCase`. They are 5x to 10x faster than the invariant variants because the runtime dispatches to a Teddy kernel that operates on raw bytes. The invariant variants pay for Unicode case folding even on ASCII-only inputs.
- If you need locale-correct case insensitivity (Turkish dotted I, Greek sigma), `SearchValues<string>` is not your tool. Fall back to `string.Contains(needle, StringComparison.CurrentCultureIgnoreCase)` in a loop and accept the cost. Locale-aware string matching is fundamentally not vectorisable.

The `char` and `byte` overloads have no `StringComparison` parameter. They match exactly. If you want case-insensitive ASCII matching with `SearchValues<char>`, include both cases in the set:

```csharp
// case-insensitive ASCII vowels in .NET 11, C# 14
private static readonly SearchValues<char> Vowels =
    SearchValues.Create("aeiouAEIOU");
```

Cheaper than calling `ToLowerInvariant` on the input first.

## Set membership: SearchValues.Contains is not what you think

`SearchValues<T>` exposes a `Contains(T)` method:

```csharp
SearchValues<char> set = SearchValues.Create("abc");
bool isInSet = set.Contains('b'); // true
```

Read carefully: this checks whether a single value is in the set. It is the equivalent of `HashSet<T>.Contains`, not a substring search. People reach for it expecting `string.Contains` semantics and ship code that asks "is the character 'h' in my forbidden-tokens set" instead of "does my input contain any forbidden token". That bug type-checks and runs.

The right calls for "does the input contain any of these":

- `ReadOnlySpan<char>.ContainsAny(SearchValues<char>)` for char sets.
- `ReadOnlySpan<char>.ContainsAny(SearchValues<string>)` for string sets.
- `ReadOnlySpan<byte>.ContainsAny(SearchValues<byte>)` for byte sets.

Use `SearchValues<T>.Contains(value)` only when you genuinely have a single value and want a set lookup, e.g. inside a custom tokeniser deciding whether the current character is a delimiter.

## The IndexOfAnyExcept inversion trick

`IndexOfAnyExcept(SearchValues<T>)` returns the index of the first element that is **not** in the set. This is the way to find the start of meaningful content in a string after leading whitespace, padding, or noise, in one SIMD pass:

```csharp
// .NET 11, C# 14
private static readonly SearchValues<char> WhitespaceAndQuotes =
    SearchValues.Create(" \t\r\n\"'");

public static ReadOnlySpan<char> TrimStart(ReadOnlySpan<char> input)
{
    int firstReal = input.IndexOfAnyExcept(WhitespaceAndQuotes);
    return firstReal < 0 ? ReadOnlySpan<char>.Empty : input[firstReal..];
}
```

This beats `string.TrimStart(' ', '\t', '\r', '\n', '"', '\'')` on inputs with long leading runs because `TrimStart` falls back to a per-character loop for sets above four. For the typical "strip 64 spaces of indentation" case, expect a 4x to 8x speedup.

`LastIndexOfAnyExcept` is the right-side equivalent. Together they give you a vectorised `Trim`:

```csharp
public static ReadOnlySpan<char> TrimBoth(ReadOnlySpan<char> input)
{
    int start = input.IndexOfAnyExcept(WhitespaceAndQuotes);
    if (start < 0) return ReadOnlySpan<char>.Empty;

    int end = input.LastIndexOfAnyExcept(WhitespaceAndQuotes);
    return input[start..(end + 1)];
}
```

Two slices, two SIMD scans, zero allocations. The naive `string.Trim(charsToTrim)` overload allocates a temporary array internally on .NET 11 even when the input does not need trimming.

## When to use byte over char

For protocol parsing (HTTP, JSON, ASCII CSV, log lines), the input is often `ReadOnlySpan<byte>`, not `ReadOnlySpan<char>`. Building `SearchValues<byte>` from the ASCII byte values is markedly faster than decoding to UTF-16 first:

```csharp
// .NET 11, C# 14 -- HTTP header value sanitiser
private static readonly SearchValues<byte> InvalidHeaderBytes =
    SearchValues.Create([(byte)'\0', (byte)'\r', (byte)'\n', (byte)'\t']);

public static bool IsValidHeaderValue(ReadOnlySpan<byte> value)
{
    return value.IndexOfAny(InvalidHeaderBytes) < 0;
}
```

The byte path pulls 32 bytes per AVX2 cycle vs 16 chars; on AVX-512-capable hardware it pulls 64 bytes vs 32 chars. For ASCII data you double your throughput by skipping the UTF-16 detour.

The compiler does not warn you if you accidentally use `char` codepoints above 127 in a way that breaks. But the SearchValues planner does emit a deliberate slow path when the char set spans more than the BMP-ASCII range with mixed bidi properties. If your benchmark says "this got slower than I expected", check whether you put a non-ASCII character into a set that was supposed to be ASCII-only.

## When NOT to use SearchValues

A short list of cases where the right answer is "do not bother":

- **One needle**. `span.IndexOf('x')` is already vectorised. `SearchValues.Create("x")` adds overhead.
- **Two or three char needles, called rarely**. `span.IndexOfAny('a', 'b', 'c')` is fine. The breakeven is around four needles for char and around two for string.
- **Inputs shorter than 16 elements**. The SIMD kernels have setup cost. For an 8-character span, scalar comparison wins.
- **Needles that change every call**. The whole point of `SearchValues` is amortisation. If the set is per-call user input, stay with `IndexOfAny` overloads or `Regex` with `RegexOptions.Compiled`.
- **You need group capture or backreferences**. `SearchValues` does literal matching only. It is not a regex replacement, just a faster `Contains`.

## Allocation-free static initialisation

The `Create` overloads accept `ReadOnlySpan<T>`. You can pass a string literal (the C# compiler converts string literals to `ReadOnlySpan<char>` through `RuntimeHelpers.CreateSpan` since .NET 7), an array, or a collection expression. All three produce the same `SearchValues<T>` instance; the compiler does not generate intermediate arrays for the string-literal form.

```csharp
// .NET 11, C# 14 -- all three are equivalent in cost at runtime
private static readonly SearchValues<char> A = SearchValues.Create("abc");
private static readonly SearchValues<char> B = SearchValues.Create(['a', 'b', 'c']);
private static readonly SearchValues<char> C = SearchValues.Create(new[] { 'a', 'b', 'c' });
```

For the string overload, the input must be an array (`string[]`) or a collection expression that targets one:

```csharp
private static readonly SearchValues<string> Tokens =
    SearchValues.Create(["select", "insert", "update"], StringComparison.OrdinalIgnoreCase);
```

The constructor copies the needles into its internal state, so the source array is not retained. Mutating the array after construction does nothing to the `SearchValues<string>` instance. This is the opposite of `Regex` with cached patterns, where the source string is retained.

## Source-generator-friendly pattern

If you have a `partial` class and a code generator (your own or `System.Text.RegularExpressions.GeneratedRegex`), generating a `static readonly SearchValues<char>` field as part of the generated output is a clean pattern. Trim-safe, AOT-safe, no reflection, no heap allocation per call.

```csharp
// .NET 11, C# 14 -- hand-rolled equivalent of what a generator would emit
internal static partial class IdentifierScanner
{
    private static readonly SearchValues<char> NonIdentifierChars =
        SearchValues.Create(GetNonIdentifierAscii());

    private static ReadOnlySpan<char> GetNonIdentifierAscii()
    {
        // Build a 96-element set of non-[A-Za-z0-9_] ASCII chars at type init.
        Span<char> buffer = stackalloc char[96];
        int i = 0;
        for (int c = ' '; c <= '~'; c++)
        {
            if (!(char.IsAsciiLetterOrDigit((char)c) || c == '_'))
                buffer[i++] = (char)c;
        }
        return buffer[..i].ToArray();
    }
}
```

The `stackalloc` runs once because `static readonly` is initialised exactly once by the runtime's type initialiser. The `.ToArray()` is the one allocation in the lifetime of the type. After that, every search is allocation-free.

## Native AOT and trim warnings

`SearchValues<T>` is fully compatible with Native AOT. There is no reflection inside, no dynamic codegen at runtime. Your published-AOT binary contains the same SIMD kernels as the JIT version, selected at AOT-compile time based on the target ISA you specified (`-r linux-x64` defaults to baseline x64 with SSE2 + AVX2 paths included; `-p:TargetIsa=AVX-512` extends to AVX-512). No trim warnings, no `[DynamicallyAccessedMembers]` annotations needed.

If you publish for `linux-arm64`, the NEON kernels are picked up automatically. The same source compiles for both targets without conditional code.

## Related reading

- [Span<T> vs ReadOnlySpan<T> and when each one earns its keep](/2026/01/net-10-performance-searchvalues/) covers an earlier `SearchValues` snapshot from the .NET 10 timeframe; revisit it for the SIMD background.
- [Channels instead of BlockingCollection](/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) is the right transport when you scan inputs in a worker.
- [How to read a large CSV in .NET 11 without running out of memory](/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) uses `SearchValues<char>` for delimiter scanning in the parser.
- [How to detect when a file finishes being written to in .NET](/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/) pairs naturally with the CSV scanner above when consuming inbox files.

## Sources

- [`SearchValues<T>` reference, MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.buffers.searchvalues-1) -- the canonical API surface, including the byte / char / string `Create` overloads.
- [`SearchValues.Create(ReadOnlySpan<string>, StringComparison)` MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.buffers.searchvalues.create) -- documents the four supported `StringComparison` values and the `ArgumentException` thrown for the others.
- [.NET runtime PR 90395 -- initial `SearchValues<T>`](https://github.com/dotnet/runtime/pull/90395) -- the introduction of byte and char overloads in .NET 8 with the SIMD strategy table.
- [.NET runtime PR 96570 -- `SearchValues<string>`](https://github.com/dotnet/runtime/pull/96570) -- the .NET 9 addition of the multi-string Aho-Corasick / Teddy kernels.
- [Boosting string search performance in .NET 8.0 with SearchValues, endjin](https://endjin.com/blog/2024/01/dotnet-8-searchvalues-string-search-performance-boost) -- the cleanest external benchmark write-up for the char path.
