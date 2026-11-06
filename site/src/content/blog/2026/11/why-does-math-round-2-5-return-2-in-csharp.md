---
title: "Why does Math.Round(2.5) return 2 in C#?"
description: "Math.Round uses banker's rounding (MidpointRounding.ToEven) by default, so 2.5 rounds to 2 and 3.5 rounds to 4. How to get 'school' rounding with AwayFromZero, why Math.Round(2.675, 2) still gives 2.67, how .NET 11 changed Math.Round(double, digits) to round the exact binary value, and why ToString(\"F2\") disagrees with decimal formatting. Verified on .NET 10.0.14 and .NET 11 RC3."
pubDate: 2026-11-06
tags:
  - "dotnet"
  - "csharp"
  - "dotnet-11"
  - "floating-point"
---

`Math.Round(2.5)` returns `2` because every `Math.Round` overload that does not take a `MidpointRounding` argument uses `MidpointRounding.ToEven`, also called banker's rounding: a value exactly halfway between two integers goes to the even neighbor, so `2.5` becomes `2`, `3.5` becomes `4`, and `-2.5` becomes `-2`. This has been the default since .NET Framework 1.0 and is unchanged in .NET 10 and .NET 11. If you want the rounding most people learned in school, pass the mode explicitly: `Math.Round(2.5, MidpointRounding.AwayFromZero)` returns `3`. The default exists to avoid the upward bias that "always round .5 up" introduces when you sum many rounded values. Everything below was run on .NET 10.0.14 and .NET 11.0.0-rc.3 (SDK 11.0.100-rc.3.26522.148, macOS arm64), and one result differs between the two: .NET 11 changed how `Math.Round(double, digits)` works.

## What banker's rounding actually does

Round-half-to-even only matters for values that sit exactly on a midpoint. Anything else rounds to the nearest integer as you would expect. Here is the default next to `AwayFromZero` for a handful of midpoints:

```csharp
// .NET 10 / .NET 11, C# 14
foreach (var v in new[] { 0.5, 1.5, 2.5, 3.5, -2.5 })
    Console.WriteLine($"Math.Round({v}) = {Math.Round(v)}  AwayFromZero = {Math.Round(v, MidpointRounding.AwayFromZero)}");

Console.WriteLine($"Math.Round(2.5m) = {Math.Round(2.5m)}  decimal.Round(2.5m) = {decimal.Round(2.5m)}");
```

Output on both runtimes:

```text
Math.Round(0.5) = 0  AwayFromZero = 1
Math.Round(1.5) = 2  AwayFromZero = 2
Math.Round(2.5) = 2  AwayFromZero = 3
Math.Round(3.5) = 4  AwayFromZero = 4
Math.Round(-2.5) = -2  AwayFromZero = -3
Math.Round(2.5m) = 2  decimal.Round(2.5m) = 2
```

`decimal` is not an escape hatch: `Math.Round(decimal)` and `decimal.Round` use the same `ToEven` default. Neither is `Convert.ToInt32`, which also rounds half to even, while a cast truncates toward zero:

```csharp
// .NET 10 / .NET 11
Convert.ToInt32(2.5);   // 2
Convert.ToInt32(3.5);   // 4
(int)2.5;               // 2  (truncation, not rounding)
(int)-2.5;              // -2
Convert.ToInt32(2.5m);  // 2
```

The [Math.Round documentation](https://learn.microsoft.com/en-us/dotnet/api/system.math.round) describes round-to-nearest-even as the default because it "conforms to IEEE Standard 754, section 4", and because it reduces the error that builds up when midpoints are always pushed in the same direction.

## Why the default is not "round half up"

The bias argument is easy to dismiss until you measure it. Take the 1,000 midpoints `0.5, 1.5, ..., 999.5`, sum them exactly, and compare against the sum of the rounded values:

```csharp
// .NET 10 / .NET 11
decimal[] mids = Enumerable.Range(0, 1000).Select(i => i + 0.5m).ToArray();
decimal exact = mids.Sum();
decimal even  = mids.Sum(x => Math.Round(x));
decimal away  = mids.Sum(x => Math.Round(x, MidpointRounding.AwayFromZero));
Console.WriteLine($"exact={exact} toEven={even} awayFromZero={away}");
```

```text
exact=500000.0 toEven=500000 awayFromZero=500500
```

Half the midpoints round down and half round up under `ToEven`, so the total is exact. Under `AwayFromZero` every one of them rounds up, and the total drifts by 0.5 per value. For line items that are summed, invoiced, or aggregated into reports, that drift is real money, which is where the "banker's" name comes from. It is also why Python 3's `round()` behaves the same way, while JavaScript's `Math.round(2.5)` returns `3` (and `Math.round(-2.5)` returns `-2`, because it rounds half toward positive infinity). If you are porting a calculation between languages, check the midpoint rule first.

## Picking a MidpointRounding mode

Since .NET Core 3.0, `MidpointRounding` has five members. Only two of them are about midpoints. The other three are directed rounding modes that ignore "nearest" entirely:

```csharp
// .NET 10 / .NET 11
foreach (MidpointRounding m in Enum.GetValues<MidpointRounding>())
    Console.WriteLine($"{m,-20} 2.5->{Math.Round(2.5, m),3}  -2.5->{Math.Round(-2.5, m),3}  2.4->{Math.Round(2.4, m),3}  2.6->{Math.Round(2.6, m),3}");
```

```text
ToEven               2.5->  2  -2.5-> -2  2.4->  2  2.6->  3
AwayFromZero         2.5->  3  -2.5-> -3  2.4->  2  2.6->  3
ToZero               2.5->  2  -2.5-> -2  2.4->  2  2.6->  2
ToNegativeInfinity   2.5->  2  -2.5-> -3  2.4->  2  2.6->  2
ToPositiveInfinity   2.5->  3  -2.5-> -2  2.4->  3  2.6->  3
```

Read the `2.6` and `2.4` columns. `ToZero` turns `2.6` into `2`, so it is `Math.Truncate` with a `digits` parameter, not a "round half down" mode. `ToNegativeInfinity` is a floor and `ToPositiveInfinity` is a ceiling. They are useful when you need "floor to two decimals" (`Math.Round(x, 2, MidpointRounding.ToNegativeInfinity)`), but swapping `ToEven` for `ToZero` to "fix" banker's rounding will silently break every non-midpoint value.

A practical rule:

- **Display and user-facing totals that must match a calculator or Excel**: `AwayFromZero`.
- **Accumulated financial or statistical values**: leave the default `ToEven`, or follow whatever your domain's regulation specifies.
- **Truncation, floor, or ceiling to N decimals**: `ToZero`, `ToNegativeInfinity`, `ToPositiveInfinity`.

Passing an undefined value, such as `(MidpointRounding)7`, throws `ArgumentException`.

If you write generic numeric code, the same overloads exist on the generic math interfaces, so you can make the mode explicit once:

```csharp
// .NET 7+, C# 11+
static T RoundHalfUp<T>(T x) where T : IFloatingPoint<T>
    => T.Round(x, MidpointRounding.AwayFromZero);

RoundHalfUp(2.5);   // 3
RoundHalfUp(2.5m);  // 3
```

`double.Round`, `float.Round`, `Half.Round`, and `MathF.Round` all default to `ToEven` too.

## Why Math.Round(2.675, 2, AwayFromZero) gives 2.67 on .NET 11

This is the second most common rounding complaint, and it has nothing to do with the midpoint mode. The literal `2.675` cannot be stored exactly in a `double`. The nearest representable value is slightly below the midpoint:

```csharp
// .NET 10 / .NET 11
Console.WriteLine(2.675.ToString("F30"));
// 2.674999999999999822364316059975
```

Since the stored value is below `2.675`, the correctly rounded result to two decimals is `2.67` no matter which midpoint mode you pick. There is no midpoint to round away from. The same applies to `1.005` (stored as `1.00499999999999989...`) and to [the `655.925` example in the .NET docs](https://learn.microsoft.com/en-us/dotnet/core/compatibility/core-libraries/11/math-round-digits).

Here is where the two runtimes disagree:

```csharp
// Same source, run on .NET 10.0.14 and .NET 11.0.0-rc.3
Math.Round(2.675, 2, MidpointRounding.AwayFromZero);
Math.Round(655.925, 2, MidpointRounding.AwayFromZero);
```

```text
.NET 10:  2.68   655.93
.NET 11:  2.67   655.92
```

In .NET 10 and earlier, `Math.Round(value, digits, mode)` computed `Round(value * 10^digits, mode) / 10^digits`. The multiplication itself rounds: `2.675 * 100` lands on exactly `267.5` in floating point, which is a midpoint, so `AwayFromZero` produced `268` and the final answer `2.68`. The scaling step sometimes pushed values onto a midpoint or across a rounding boundary, so the result depended on an intermediate rounding error rather than on the input.

.NET 11 Preview 7 replaced that with arbitrary-precision arithmetic on the exact input value, per the breaking change note ["Math.Round and MathF.Round return correctly rounded results"](https://learn.microsoft.com/en-us/dotnet/core/compatibility/core-libraries/11/math-round-digits) (implemented in [dotnet/runtime#130574](https://github.com/dotnet/runtime/pull/130574)). Microsoft's note puts the old error rate at roughly 5% of random values. To check that number independently, this test rounds a million random three-decimal doubles to two decimals and compares the result against rounding the exact binary value (obtained from `ToString("F28")`, which prints the exact digits since .NET Core 3.0) with `decimal` arithmetic:

```csharp
// .NET 10 / .NET 11, Release build
var rng = new Random(42); int n = 1_000_000, mismatch = 0;
for (int i = 0; i < n; i++)
{
    double x = Math.Round(rng.NextDouble() * 1000, 3);
    decimal exact = decimal.Parse(x.ToString("F28"), CultureInfo.InvariantCulture);
    double expected = (double)Math.Round(exact, 2, MidpointRounding.AwayFromZero);
    if (Math.Round(x, 2, MidpointRounding.AwayFromZero) != expected) mismatch++;
}
Console.WriteLine($"mismatches vs exact-value rounding: {mismatch}/{n}");
```

```text
.NET 10.0.14:      mismatches vs exact-value rounding: 43309/1000000
.NET 11.0.0-rc.3:  mismatches vs exact-value rounding: 0/1000000
```

About 4.3% of these inputs gave a result on .NET 10 that differs from correct rounding of the stored value. On .NET 11 none do. This sample favors values with three decimals, which put many inputs near a two-decimal midpoint, so treat 4.3% as a figure for this distribution and not a general rate.

The same change lifted the old `digits` limit. On .NET 10, `Math.Round(x, 16)` throws `ArgumentOutOfRangeException` ("Rounding digits must be between 0 and 15, inclusive"). On .NET 11, any non-negative `digits` is accepted, and 17 or more leaves the `double` unchanged. `MathF.Round(float, digits)` gets the same treatment (its old limit was 6). `Math.Round(double)` without `digits` and all the `decimal` overloads are not affected. `decimal` still caps `digits` at 28 and throws for 29.

The breaking change note does not mention a compatibility switch. If a test suite or a persisted format depends on the old results, you have to reproduce the old algorithm yourself:

```csharp
// .NET 11: reproduces the .NET 10 scale-and-round result
static double LegacyRound(double value, int digits, MidpointRounding mode)
{
    double pow10 = Math.Pow(10, digits);
    return Math.Round(value * pow10, mode) / pow10;
}

LegacyRound(2.675, 2, MidpointRounding.AwayFromZero); // 2.68 on .NET 10 and .NET 11
```

The better fix is to stop storing base-10 quantities in `double`.

## The decimal cast trick changed too

A common workaround for the `2.675` problem was `Math.Round((decimal)x, 2, MidpointRounding.AwayFromZero)`. It worked on .NET 10 because the `double` to `decimal` conversion only kept 15 significant digits, so `(decimal)2.675` came out as exactly `2.675m`, a real midpoint. .NET 11 Preview 7 also changed that conversion to be correctly rounded (["Decimal and BigInteger floating-point conversions are correctly rounded"](https://learn.microsoft.com/en-us/dotnet/core/compatibility/core-libraries/11/decimal-biginteger-floating-point-conversions)). Converting a runtime `double` variable holding `2.675` gives:

```text
.NET 10.0.14:      2.675
.NET 11.0.0-rc.3:  2.6749999999999998223643160600
```

so the cast-then-round trick now returns `2.67`, which is again the correct rounding of the value you actually had. One trap while testing this: when you write `(decimal)2.675` with a literal, the C# compiler folds the conversion at build time, and per the breaking change note a .NET 11 Preview 7 or later SDK embeds the new result regardless of target framework. A `net10.0` build compiled with the .NET 11 SDK printed `2.6749999999999998223643160600` for the constant, and `2.675` only for the runtime conversion.

If what you really want is "round the number the user typed", use `decimal` from the start. A `decimal` literal or a parsed string keeps the decimal digits, so the midpoint is real and the mode does what you asked:

```csharp
// .NET 10 / .NET 11
Math.Round(2.675m, 2, MidpointRounding.AwayFromZero);   // 2.68

// If you only have a double, go through its shortest round-trip string ("2.675"):
decimal d = decimal.Parse(x.ToString(CultureInfo.InvariantCulture), CultureInfo.InvariantCulture);
Math.Round(d, 2, MidpointRounding.AwayFromZero);        // 2.68 for x = 2.675
```

The string round trip is a heuristic: it recovers the shortest decimal that maps to the same `double`, which is usually what a human entered, but it is not the stored value. For prices, quantities, and anything else a person counts in base 10, model it as `decimal` end to end.

## ToString("F2") does not round the same way as decimal formatting

Formatting is a separate code path with its own rules, and `double` and `decimal` differ:

```csharp
// .NET 10 / .NET 11, InvariantCulture
0.125.ToString("F2");   // "0.12"   (exact midpoint, rounded to even)
2.5.ToString("F0");     // "2"
3.5.ToString("F0");     // "4"
2.675.ToString("F2");   // "2.67"   (stored value is below the midpoint)

0.125m.ToString("F2");  // "0.13"   (decimal formatting rounds away from zero)
2.5m.ToString("N0");    // "3"
2.675m.ToString("F2");  // "2.68"
$"{0.125m:0.00}";       // "0.13"
```

On both .NET 10 and .NET 11, `double` formatting rounds the exact binary value and breaks exact ties to even, while `decimal` formatting rounds midpoints away from zero. That gives a surprising combination: `Math.Round(0.125, 2, MidpointRounding.AwayFromZero)` returns `0.13`, but `0.125.ToString("F2")` prints `"0.12"`. If the displayed number must agree with the stored rounded number, round first with an explicit mode and then format, or keep the value in `decimal`. Do not rely on a format string as your rounding step. These formatting results were observed on .NET 10 and .NET 11 only; .NET Framework used a different formatting implementation before .NET Core 3.0, so do not assume it matches.

## Gotchas when rounding in other layers

- **Databases**: SQL Server's [`ROUND`](https://learn.microsoft.com/en-us/sql/t-sql/functions/round-transact-sql) rounds midpoints away from zero, so a value rounded in C# with the default can differ from the same value rounded in a query. EF Core cannot translate `Math.Round` or `decimal.Round` calls that pass a `MidpointRounding` argument, which is one of the cases covered in [fixing "The LINQ expression could not be translated" in EF Core 11](/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/).
- **float widening**: `Math.Round(16.325f, 2)` widens the `float` to `double` first. The float's stored value is `16.325000762939453`, so it rounds to `16.33` on both runtimes even though `16.325` looks like a midpoint. `MathF.Round(16.325f, 2)` returns `16.33` as well. Keep `float` math in `MathF` and avoid mixing `float`, `double`, and `decimal` in one calculation.
- **Upgrading to .NET 11**: expect snapshot tests that assert on `Math.Round(double, digits)` output to change. The new values are the correct ones, but they are a behavioral break, which is exactly the kind covered in [the difference between source-breaking and binary-breaking changes](/2026/10/what-is-the-difference-between-a-source-breaking-and-a-binary-breaking-change-in-a-dotnet-library/): your code compiles and runs, and the numbers move.
- **Seeing the stored value**: `ToString("F30")`, `ToString("G17")`, or the hexadecimal float format in [.NET 11's `NumberStyles.HexFloat` support](/2026/06/dotnet-11-floating-point-hex-format-numberstyles-hexfloat/) show what a `double` really holds. Check that before blaming the rounding mode.
- **Custom display formats**: if you build your own grouping or unit scaling, apply the mode explicitly, as the [Indian lakh and crore formatting helper](/2026/10/how-to-format-numbers-with-indian-lakh-crore-digit-grouping-in-dotnet/) does with `MidpointRounding.AwayFromZero` before formatting.

## Reproducing these results

All snippets come from two small console apps targeting `net10.0;net11.0`, built with SDK 11.0.100-rc.3.26522.148 and run on runtimes 10.0.14 and 11.0.0-rc.3.26522.148 on macOS arm64 with `InvariantGlobalization` enabled and `CultureInfo.InvariantCulture` set at startup. Run each with `dotnet run -f net10.0` and `dotnet run -f net11.0` and diff the output. Apart from the runtime version line, the only results that differ are `Math.Round(2.675, 2, AwayFromZero)`, `Math.Round(655.925, 2, AwayFromZero)`, the `digits: 16` exception, the runtime `double` to `decimal` conversion, and the mismatch count. The midpoint behavior that started this question, `Math.Round(2.5) == 2`, is identical on both and will stay that way: it is the documented default, and the fix is to say which rounding you mean.

## Sources

- [Math.Round method (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.math.round)
- [MidpointRounding enum (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.midpointrounding)
- [Breaking change: Math.Round and MathF.Round return correctly rounded results (.NET 11)](https://learn.microsoft.com/en-us/dotnet/core/compatibility/core-libraries/11/math-round-digits)
- [Breaking change: Decimal and BigInteger floating-point conversions are correctly rounded (.NET 11)](https://learn.microsoft.com/en-us/dotnet/core/compatibility/core-libraries/11/decimal-biginteger-floating-point-conversions)
- [dotnet/runtime#130574](https://github.com/dotnet/runtime/pull/130574)
- [ROUND (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/functions/round-transact-sql)
