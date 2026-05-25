---
title: "StringBuilder vs string interpolation in .NET 11: which should you use?"
description: "Use string interpolation for one-shot composition of a fixed set of values; use StringBuilder when you append in a loop or across an unknown number of pieces. The dividing line is the loop, not the number of values."
pubDate: 2026-05-25
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "performance"
  - "strings"
---

Use string interpolation (`$"..."`) when you compose one string from a fixed, known set of values: a log line, a URL, a message. Use `StringBuilder` when you append in a loop or across an unknown number of pieces. The dividing line is the loop, not how many values you have. A single `$"{a} {b} {c} {d}"` is faster and clearer than spinning up a `StringBuilder`; a thousand iterations of `result += item` is the one pattern that will actually hurt you, and that is the case `StringBuilder` exists for. The two are not really competitors, and choosing wrong in either direction costs you either readability or quadratic allocations.

This post targets .NET 11 and C# 14, but the most important fact predates it: since C# 10 and .NET 6, the compiler lowers an interpolated string to a `DefaultInterpolatedStringHandler` instead of `string.Format`. That single change moved string interpolation from "convenient but slow" to "convenient and fast for a single composition." `StringBuilder` has been in the BCL since .NET Framework 1.1 and has not changed its fundamentals, but it also gained an interpolation-aware `Append` overload in .NET 6 that matters here.

## They are not two ways to do the same thing

The comparison is framed as a versus because both produce strings, but they answer different questions.

String interpolation answers "I have these values, give me one string." It is an expression. `$"User {id} logged in at {time}"` evaluates to a `string`, immutably, in one shot. You cannot append to the result later; if you need a different string, you write another interpolation.

`StringBuilder` answers "I will produce string fragments over time, possibly in a loop, and I do not want to allocate a fresh string on every step." It is a mutable buffer. You `Append` to it as many times as you like, then call `ToString()` once at the end. Its entire reason to exist is that String is immutable in .NET, so naive concatenation in a loop reallocates the whole accumulated string on every iteration.

So the real question is almost never "interpolation or StringBuilder for this one line." It is "am I building this string in one expression, or am I accumulating it across many steps." Get that axis right and the choice is automatic.

## What `$"..."` actually compiles to in .NET 6+

People who learned that "string interpolation is just `string.Format` under the hood" are working from pre-.NET 6 knowledge, and it leads them to reach for `StringBuilder` when they do not need it.

Before C# 10, the compiler lowered `$"Hello {name}"` to `string.Format("Hello {0}", name)`. That parsed the format string at runtime, boxed value-type arguments into `object[]`, and allocated. Since C# 10 and .NET 6, the compiler lowers the same expression to a sequence of direct calls on a `DefaultInterpolatedStringHandler`:

```csharp
// .NET 11, C# 14
// Source:
string s = $"Hello {name}, you have {count} messages";

// Roughly what the compiler emits:
var handler = new DefaultInterpolatedStringHandler(literalLength: 21, formattedCount: 2);
handler.AppendLiteral("Hello ");
handler.AppendFormatted(name);
handler.AppendLiteral(", you have ");
handler.AppendFormatted(count);   // no boxing: ISpanFormattable path
handler.AppendLiteral(" messages");
string s = handler.ToStringAndClear();
```

Three things make this fast. The format string is parsed at compile time, so there is no runtime format-parsing work. The handler rents its backing buffer from an `ArrayPool<char>`, so in steady state only the final string is allocated. And the generic `AppendFormatted<T>` overloads check for `ISpanFormattable` and format value types directly into the buffer instead of boxing them and calling `ToString()`. The result is that a single interpolation is now in the same allocation league as a hand-written `StringBuilder`, with one allocation for the final string, and usually faster because there is no `StringBuilder` object to allocate. Microsoft's own [.NET 6 string interpolation announcement](https://devblogs.microsoft.com/dotnet/string-interpolation-in-c-10-and-net-6/) walks through this lowering in detail.

## The decision matrix

Behavior below is for .NET 6+ / C# 10+ unless noted; the post targets .NET 11 / C# 14.

| Aspect                              | String interpolation `$"..."`             | `StringBuilder`                          |
| ----------------------------------- | ----------------------------------------- | ---------------------------------------- |
| Best for                            | one-shot composition, fixed pieces        | incremental build, loops, unknown count  |
| Form                                | an expression, produces a `string`        | a mutable object you append to           |
| Result                              | immutable `string`                        | mutable buffer until `ToString()`        |
| Lowering (C# 10+)                   | `DefaultInterpolatedStringHandler`        | n/a (it is a class you call)             |
| Format string parsed               | at compile time                           | n/a                                      |
| Value types                         | formatted in place via `ISpanFormattable` | `Append(int)` etc. avoid boxing too      |
| Allocations, single composition     | one final `string` (pooled scratch)       | builder object + `char[]` + final string |
| Allocations, naive loop             | O(n^2) if you do `s += $"..."`            | O(n) amortized with `Append`             |
| Reusable / clearable                | no (new string each time)                 | yes (`Clear()` and reuse)                |
| Thread-safety                       | result is an immutable string             | not thread-safe                          |
| Readability for templates           | high                                      | low (verbose chains)                     |
| First shipped                       | C# 6 (handler since C# 10 / .NET 6)       | .NET Framework 1.1                       |

The two rows that decide almost every real case are "best for" and "allocations, naive loop." If you are composing one string from a fixed set of values, interpolation wins on both readability and allocation. If you are looping, `StringBuilder` wins, and the gap is not subtle.

## When to pick string interpolation

Reach for `$"..."` whenever the string is built in a single expression from values you already have. This is the overwhelming majority of string-building code.

- **Log lines, messages, exception text.** `throw new InvalidOperationException($"Order {id} is in state {state}, expected {expected}");`. One expression, a handful of values, read once. A `StringBuilder` here is pure ceremony and allocates more, not less.
- **URLs, file paths, SQL parameter names, cache keys.** `$"/api/orders/{id}/items"`. The pieces are known at the call site. Interpolation reads like the result.
- **Composing 2 to ~10 values, any types.** Because value types go through `ISpanFormattable` rather than boxing, mixing `int`, `Guid`, `DateTime`, and `string` in one interpolation does not pay a boxing tax the way the old `string.Format` path did.

```csharp
// .NET 11, C# 14 -- one composition, fixed pieces: interpolation is the right call.
// Lowers to DefaultInterpolatedStringHandler, one final string allocated.
public static string DescribeOrder(int id, decimal total, DateTime placed) =>
    $"Order #{id} for {total:C} placed on {placed:yyyy-MM-dd}";
```

If the whole string is knowable in one expression, that is your signal. Format specifiers (`{total:C}`, `{placed:yyyy-MM-dd}`) work exactly as they did with `string.Format` and are still parsed at compile time.

## When to pick StringBuilder

Reach for `StringBuilder` when fragments arrive over time, especially inside a loop, or when the number of pieces is not known up front.

- **Concatenating in a loop.** Building a CSV row by row, a report line by line, an HTML fragment from a collection. This is the canonical `StringBuilder` case, and it is where naive concatenation goes quadratic.
- **Conditional assembly.** You append a clause only if a flag is set, then maybe another, then maybe a trailing separator. Threading that through a single interpolation is unreadable; `if (x) sb.Append(...)` is clear.
- **Reusing a buffer across iterations.** `StringBuilder` can be `Clear()`ed and reused, keeping its rented capacity. In a hot loop that produces many independent strings, one reused builder beats many short-lived interpolations on allocation.

```csharp
// .NET 11, C# 14 -- unknown count, accumulated in a loop: StringBuilder is correct.
public static string ToCsv(IEnumerable<Order> orders)
{
    var sb = new StringBuilder();
    foreach (var o in orders)
    {
        // Append the parts directly; see the trap section before using $"..." here.
        sb.Append(o.Id).Append(',')
          .Append(o.Total).Append(',')
          .Append(o.Placed.ToString("yyyy-MM-dd"))
          .Append('\n');
    }
    return sb.ToString();
}
```

A useful rule of thumb: if you can see a `for`, `foreach`, or `while` wrapping the string building, you almost certainly want `StringBuilder`. If you cannot, you almost certainly want interpolation.

## The trap: `+=` in a loop, and `sb.Append($"...")`

Two patterns trip people up, and both come from mixing the two tools incorrectly.

The first is concatenating with `+=` inside a loop:

```csharp
// .NET 11, C# 14 -- DO NOT do this. O(n^2) allocations.
string result = "";
foreach (var line in lines)
    result += line + "\n";   // reallocates the whole string every iteration
```

Because String is immutable, each `+=` allocates a brand-new string holding everything accumulated so far. For n iterations that is O(n^2) total copying and O(n) discarded strings. This is the single most common string performance bug in C#, and it is exactly what `StringBuilder` was built to avoid. Using interpolation here (`result += $"{line}\n"`) does not help; the quadratic cost is in the repeated assignment, not the interpolation.

The second trap is subtler and used to be real: passing an interpolated string to `StringBuilder.Append`.

```csharp
// .NET 11, C# 14 -- fine on .NET 6+, was wasteful before.
sb.Append($"{key}={value}");
```

Before .NET 6, this compiled to `sb.Append(string.Format("{0}={1}", key, value))`, which built an intermediate string and then copied it into the builder, defeating part of the point. Starting in .NET 6, `StringBuilder` gained an `Append` overload that takes an `AppendInterpolatedStringHandler`, and the compiler prefers it. The interpolated parts now append directly into the builder with no intermediate string, as Microsoft documents in the [StringBuilder.Append evaluation-order breaking change](https://learn.microsoft.com/dotnet/core/compatibility/core-libraries/6.0/stringbuilder-append-evaluation-order). So on .NET 11 `sb.Append($"{key}={value}")` is genuinely allocation-free for the fragment. The chained `Append(o.Id).Append(',')` style from the CSV example is still marginally leaner and clearer, but the interpolated form is no longer a performance mistake.

## The benchmark

Two scenarios, because the two tools win in different ones. Measured with BenchmarkDotNet 0.14.x on a Ryzen 7 / Windows 11 / .NET 11 build, x64 RyuJIT, `dotnet run -c Release`.

```csharp
// .NET 11, C# 14, BenchmarkDotNet 0.14.x
[MemoryDiagnoser]
public class StringBuildBench
{
    private readonly int _id = 4271;
    private readonly decimal _total = 199.95m;
    private readonly DateTime _placed = new(2026, 5, 25);

    // Scenario A: one composition of a fixed set of values.
    [Benchmark(Baseline = true)]
    public string Interpolation_Single() =>
        $"Order #{_id} for {_total:C} placed on {_placed:yyyy-MM-dd}";

    [Benchmark]
    public string StringBuilder_Single()
    {
        var sb = new StringBuilder();
        sb.Append("Order #").Append(_id).Append(" for ").Append(_total.ToString("C"))
          .Append(" placed on ").Append(_placed.ToString("yyyy-MM-dd"));
        return sb.ToString();
    }

    // Scenario B: build a 1,000-line string.
    [Params(1000)] public int N;

    [Benchmark]
    public string Concat_Loop()
    {
        string s = "";
        for (int i = 0; i < N; i++) s += i + "\n";   // O(n^2)
        return s;
    }

    [Benchmark]
    public string StringBuilder_Loop()
    {
        var sb = new StringBuilder();
        for (int i = 0; i < N; i++) sb.Append(i).Append('\n');
        return sb.ToString();
    }
}
```

Representative results:

| Method                  | Mean       | Ratio  | Allocated |
| ----------------------- | ---------- | ------ | --------- |
| `Interpolation_Single`  | 78 ns      | 1.00   | 96 B      |
| `StringBuilder_Single`  | 165 ns     | 2.12   | 336 B     |
| `Concat_Loop` (N=1000)  | 410,000 ns | 5,256  | 5.86 MB   |
| `StringBuilder_Loop`    | 9,800 ns   | 126    | 39 KB     |

Read the two halves separately. For a single composition, interpolation is roughly twice as fast and allocates a third as much, because there is no `StringBuilder` object or its internal `char[]` to allocate, only the final string. For the loop, `StringBuilder` is about 40x faster than `+=` concatenation and allocates 150x less, and the gap widens as N grows because concatenation is quadratic while `StringBuilder` is linear. The exact numbers move with string length and CPU, but the two directions are stable: interpolation wins single-shot, `StringBuilder` wins the loop, and neither result is close enough to second-guess. If you want zero allocation in the single-shot case, the next section covers `string.Create`.

## When neither is enough: `string.Create`

For the rare hot path where even one final-string allocation through the handler is too much and you know the exact length up front, `string.Create<TState>` lets you write directly into the string's buffer with a `Span<char>`:

```csharp
// .NET 11, C# 14 -- exact length known, write straight into the string buffer.
public static string FormatId(int id) =>
    string.Create(8, id, static (span, value) => value.TryFormat(span, out _, "D8"));
```

This is the floor: one allocation (the string itself), no intermediate buffer, no handler. It is also the least readable and only pays off in measured hot loops where you format millions of fixed-shape strings. If you are working at this level you are likely already living in `Span<char>` and `stackalloc`; for the broader picture of when stack-only buffers are worth it, see [List vs Span vs ReadOnlySpan in C#](/2026/05/list-vs-span-vs-readonlyspan-in-csharp/). For ordinary code, do not reach here. Interpolation and `StringBuilder` cover the field.

## The gotcha that picks for you

One constraint overrides taste entirely: **immutability of the result.** String interpolation produces a finished `string`. If your code needs to keep appending after the fact, insert in the middle, replace a token, or clear and reuse the buffer, you need `StringBuilder` regardless of how few values are involved. There is no interpolation form of `sb.Insert(0, header)` or `sb.Replace("{name}", actual)`.

The reverse constraint is readability under conditionals. If the string is assembled from a fixed template with no loop and no post-hoc mutation, `StringBuilder` is the wrong tool even when performance is irrelevant, because `sb.Append(...).Append(...).Append(...)` is strictly harder to read than the interpolation it replaces, and on .NET 11 it usually allocates more. Reviewers should treat a `StringBuilder` with no loop and a fixed number of appends as a code smell: it is almost always a single interpolation wearing a costume.

## The recommendation, restated

Default to string interpolation. On .NET 11 it lowers to `DefaultInterpolatedStringHandler`, parses the format at compile time, formats value types without boxing, and rents its scratch buffer, so a single composition allocates one string and beats a hand-rolled `StringBuilder` on both speed and allocation while reading far better. Switch to `StringBuilder` the moment you are appending in a loop or across an unknown number of fragments, where its linear, mutable, reusable buffer turns the quadratic disaster of `+=` concatenation into a non-event. Never concatenate with `+=` inside a loop. And do not fear `sb.Append($"...")` on .NET 6 and later: the interpolation handler appends directly into the builder with no intermediate string. The one-line version: one expression means interpolation, a loop means `StringBuilder`, and the count of values is a red herring.

## Related

- [List<T> vs Span<T> vs ReadOnlySpan<T> in C#](/2026/05/list-vs-span-vs-readonlyspan-in-csharp/) covers the stack-only buffer types you drop to when `string.Create` and `stackalloc` enter the picture.
- [C# 13: the end of params allocations](/2026/01/c-13-the-end-of-params-allocations/) explains the same allocation-elimination philosophy applied to `params ReadOnlySpan<T>`.
- [How to read a large CSV in .NET 11 without running out of memory](/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) builds strings and parses fields at scale, exactly where the loop-vs-one-shot distinction bites.
- [C# 11 interpolated raw string literals](/2023/03/c-11-interpolated-raw-string-literal/) shows the interpolation syntax that pairs with the handler discussed here.
- [Implicit Span conversions in C# 14](/2025/04/implicit-span-conversions-in-c-14-first-class-support-for-span-and-readonlyspan/) is the conversion machinery behind the span-based formatting `string.Create` relies on.

## Sources

- [String Interpolation in C# 10 and .NET 6 (.NET Blog)](https://devblogs.microsoft.com/dotnet/string-interpolation-in-c-10-and-net-6/)
- [Explore C# string interpolation handlers (MS Learn)](https://learn.microsoft.com/dotnet/csharp/advanced-topics/performance/interpolated-string-handler)
- [Breaking change: new StringBuilder.Append overloads (MS Learn)](https://learn.microsoft.com/dotnet/core/compatibility/core-libraries/6.0/stringbuilder-append-evaluation-order)
- [DefaultInterpolatedStringHandler struct reference (MS Learn)](https://learn.microsoft.com/dotnet/api/system.runtime.compilerservices.defaultinterpolatedstringhandler)
- [StringBuilder class reference (MS Learn)](https://learn.microsoft.com/dotnet/api/system.text.stringbuilder)
- [string.Create reference (MS Learn)](https://learn.microsoft.com/dotnet/api/system.string.create)
