---
title: "Why does a C# decimal keep trailing zeros, and how do I remove them?"
description: "1.10m prints \"1.10\" because System.Decimal stores a scale alongside its digits, and arithmetic, parsing, and JSON all preserve it. How the scale is chosen, why 1.1m == 1.10m but their strings differ, three ways to strip trailing zeros (G29, a 0.## pattern, dividing by 1.000...m) and the 1E-05 trap in G29, how to force a fixed scale, and why .NET 11's double to decimal change produces digits no trick removes. Verified on .NET 10.0.14 and .NET 11 RC3."
pubDate: 2026-11-07
tags:
  - "dotnet"
  - "csharp"
  - "dotnet-11"
  - "decimal"
---

A C# `decimal` keeps trailing zeros because it is not stored as "a number" but as a 96-bit integer plus a **scale**, the power of ten to divide by. `1.1m` is `11` with scale 1, and `1.10m` is `110` with scale 2. They compare equal (`1.1m == 1.10m` is `true`, and they hash the same), but `ToString()` prints every digit the scale says is there, so you get `"1.10"`. To drop the zeros for display, format with `ToString("G29")` or `ToString("0.############################")`. To drop them from the value itself, divide by `1.0000000000000000000000000000m` (28 zeros), which returns the same number at the smallest scale that represents it. Everything below was run on .NET 10.0.14 and .NET 11.0.0-rc.3.26522.148 (SDK 11.0.100-rc.3.26522.148, macOS arm64), and the scale rules are identical on both. One adjacent thing did change in .NET 11: converting a `double` to `decimal` now produces up to 28 digits, and those are real digits, not trailing zeros.

## The scale is part of the value

The [`System.Decimal` docs](https://learn.microsoft.com/en-us/dotnet/api/system.decimal) are explicit about this: "The scaling factor also preserves any trailing zeros in a Decimal number." You can see it with `decimal.GetBits`, which returns the three 32-bit words of the integer and a flags word whose bits 16 to 23 hold the scale, or with the [`Scale` property](https://learn.microsoft.com/en-us/dotnet/api/system.decimal.scale) that has existed since .NET 7:

```csharp
// .NET 10 / .NET 11, C# 14
decimal a = 1.1m, b = 1.10m;

Console.WriteLine($"{a} scale {a.Scale}, {b} scale {b.Scale}");
Console.WriteLine($"a == b: {a == b}, hashes equal: {a.GetHashCode() == b.GetHashCode()}");
Console.WriteLine("GetBits(1.10m): " + string.Join(", ", decimal.GetBits(b)));
Console.WriteLine("GetBits(1.1m):  " + string.Join(", ", decimal.GetBits(a)));
```

Output on both runtimes:

```text
1.1 scale 1, 1.10 scale 2
a == b: True, hashes equal: True
GetBits(1.10m): 110, 0, 0, 131072
GetBits(1.1m):  11, 0, 0, 65536
```

`131072` is `2 << 16` and `65536` is `1 << 16`. The integer part of the representation is literally `110` versus `11`. The scale can be anything from 0 to 28, and the type has no "normalized" form: the runtime keeps whichever scale the value was born with.

This is a deliberate design. `decimal` follows the same idea as the IEEE 754 decimal formats and as SQL's `DECIMAL(p, s)`: `2.50` and `2.5` are the same quantity, but `2.50` also says "this was measured or priced to the cent". A currency amount that round-trips through your system as `19.90` instead of `19.9` is often exactly what you want.

## Where the scale comes from

Every operation that produces a `decimal` picks a scale, and none of them strip zeros on their own. These are the results on .NET 10.0.14 and .NET 11 RC3 (identical):

```csharp
// .NET 10 / .NET 11, C# 14, InvariantCulture
decimal.Parse("1.500")              // 1.500  (scale 3) parsing keeps every digit you typed
Convert.ToDecimal("2.50")           // 2.50   (scale 2)
(decimal)5                          // 5      (scale 0)

1.10m + 1.0m                        // 2.10   (scale 2) addition: the larger scale
1.10m - 0.10m                       // 1.00   (scale 2) not 1
1.5m * 2m                           // 3.0    (scale 1) multiplication: scales add
1.50m * 1.50m                       // 2.2500 (scale 4)
19.99m * 3                          // 59.97  (scale 2)

10m / 4m                            // 2.5    (scale 1)
10.00m / 4m                         // 2.50   (scale 2)
6.0m / 2m                           // 3.0    (scale 1)
1m / 3m                             // 0.3333333333333333333333333333 (scale 28)

decimal.Round(1.23456m, 2)          // 1.23   (scale 2)
decimal.Round(1.2001m, 2)           // 1.20   (scale 2) the zero survives rounding
Math.Round(1.10m, 5)                // 1.10   (scale 2) rounding never adds digits
decimal.Round(1m, 2)                // 1      (scale 0) ... so it does not pad either
decimal.Truncate(2.50m)             // 2      (scale 0)
```

The rules in plain words:

- **Literals and parsing** keep exactly the digits in the source text. `1.500m` and `decimal.Parse("1.500")` both have scale 3. Parsing a string with more than 28 fractional digits rounds to scale 28: `decimal.Parse("1.2000000000000000000000000000000")` gives `1.2000000000000000000000000000`, a value with 27 trailing zeros.
- **Addition and subtraction** align both operands to the larger scale. `1.10m - 0.10m` is `1.00`, not `1`.
- **Multiplication** adds the scales (when the result fits). Multiply a `19.99m` unit price by `1.5m` hours and you get three fractional digits.
- **Division** computes the exact quotient and stops at the smallest scale that represents it, but not below the dividend's scale minus the divisor's scale. That is why `10m / 4m` is `2.5` while `10.00m / 4m` is `2.50`, and why a non-terminating quotient fills all 28 digits.
- **Rounding** only reduces scale. `decimal.Round(x, 2)` returns a value with at most 2 fractional digits, and keeps a zero if the rounded digit is zero.

Because equality ignores the scale, the difference only appears when the value turns into text. That is where it bites: string keys, CSV exports, cache keys, snapshot tests, and API responses.

```csharp
// .NET 10 / .NET 11
var dict = new Dictionary<decimal, string> { [1.1m] = "first" };
dict[1.10m] = "second";                       // same key, overwrites
Console.WriteLine($"{dict.Count} {dict.Keys.First()}");  // 1 1.1

new[] { 1.1m, 1.10m }.Distinct().Count();                         // 1
new[] { 1.1m, 1.10m }.Select(x => x.ToString()).Distinct().Count(); // 2
```

The `Dictionary` keeps the first key instance (`1.1`) and only replaces the value. A `HashSet<decimal>` built from `1.10m, 1.1m, 1.100m` has one element, and it prints as `1.10` because that one was inserted first. If you project to strings before grouping, equal amounts land in different groups. The same reasoning about "equal values, different representations" is behind [why `string.GetHashCode()` changes every run](/2026/11/why-does-string-gethashcode-return-a-different-value-every-run-in-dotnet/): never persist or compare a derived form when you mean the value.

## Removing trailing zeros for display

If you only need the text without zeros, change the format, not the value. There are two standard options, and one of them has a trap.

```csharp
// .NET 10 / .NET 11, InvariantCulture
1.10m.ToString();                                   // "1.10"
1.10m.ToString("G29");                              // "1.1"
1.10m.ToString("0.############################");   // "1.1"
1234567.8900m.ToString("G29");                     // "1234567.89"
100.00m.ToString("G29");                            // "100"
$"{1.10m:0.##}";                                    // "1.1"
```

**`"G29"`**: the [standard numeric format docs](https://learn.microsoft.com/en-us/dotnet/standard/base-types/standard-numeric-format-strings) say that for `Decimal` with the precision specifier omitted, "fixed-point notation is always used and trailing zeros are preserved." That is why plain `ToString()` (which is `"G"`) shows `1.10`. Add a precision and the general rules apply: significant digits are counted, and trailing zeros are dropped. 29 is enough digits for any `decimal`, so nothing is rounded away (`G28` and `G30` produced the same `1.1`; `G3` turns `123.45m` into `123`, so do not go below 29).

The trap is that a precision specifier also brings back scientific notation. Fixed-point is used only if the exponent "is greater than -5 and less than the precision specifier". With 29 the upper bound never triggers for `decimal`, but the lower one does:

```csharp
// .NET 10 / .NET 11, InvariantCulture
0.0001m.ToString("G29");                            // "0.0001"
0.00001m.ToString("G29");                           // "1E-05"
0.000012m.ToString("G29");                          // "1.2E-05"
0.0000001000m.ToString("G29");                      // "1E-07"
0.0000001000m.ToString("0.############################"); // "0.0000001"
```

Any value below `0.0001` turns into exponent notation. For exchange rates, unit prices of bulk goods, or crypto amounts, that is a real bug in an invoice or a CSV. The custom pattern `"0.############################"` (one `0`, a dot, 28 `#`) never switches notation, so it is the safer default when you do not know the range.

A custom pattern is also how you get "at least two decimals, at most four" for money-like display: `1.10m.ToString("0.00##")` is `"1.10"`, and `1.23456m.ToString("0.00##")` is `"1.2346"`. Note that custom and standard formats round `decimal` midpoints away from zero (`1.005m.ToString("0.##")` is `"1.01"`, `1.015m.ToString("F2")` is `"1.02"`), which differs from `decimal.Round`'s default. The [Math.Round banker's rounding post](/2026/11/why-does-math-round-2-5-return-2-in-csharp/) covers that disagreement. Culture still applies to both approaches: pass `CultureInfo.InvariantCulture` for machine-readable output, and see [the lakh/crore grouping post](/2026/10/how-to-format-numbers-with-indian-lakh-crore-digit-grouping-in-dotnet/) for what `NumberFormatInfo` does to the separators.

## Removing trailing zeros from the value

Sometimes the display layer is not yours. `System.Text.Json` writes a `decimal` with its scale, and reads one back with the scale of the JSON text:

```csharp
// .NET 10 / .NET 11, System.Text.Json (in-box)
JsonSerializer.Serialize(1.10m);                     // 1.10
JsonSerializer.Serialize(new { Price = 19.90m });    // {"Price":19.90}
JsonSerializer.Deserialize<decimal>("1.10").Scale;   // 2
```

If an API contract or a hash of the payload needs the canonical form, normalize the value. There is no `decimal.Normalize` method in .NET 10 or .NET 11 (a reflection scan of the public members for names containing "Scale", "Normal", or "Trailing" found only the read-only `Scale` property on both runtimes), but division does it for you:

```csharp
// .NET 10 / .NET 11, C# 14
static decimal Normalize(decimal value) => value / 1.0000000000000000000000000000m;

Normalize(1.10m);            // 1.1     (scale 1)
Normalize(12.3400m);         // 12.34   (scale 2)
Normalize(100.00m);          // 100     (scale 0)
Normalize(-3.40m);           // -3.4    (scale 1)
Normalize(0.000m);           // 0       (scale 0)
Normalize(79228162514264337593543950335m); // decimal.MaxValue, unchanged
Normalize(0.0000000000000000000000000001m); // smallest positive, unchanged (scale 28)
```

This works because of the division rule above: the divisor has scale 28, so "dividend scale minus divisor scale" is negative and the runtime is free to shrink the result all the way down to the smallest scale that is still exact. Dividing by plain `1m` does not work, since that floor is the dividend's own scale (`2.50m / 1m` is still `2.50`). Dividing by `1.0m` only shaves one digit (`2.50m / 1.0m` is `2.5`, but `2.500m / 1.0m` would be `2.50`). Use the 28-zero divisor so it works for every input. The trick is widely shared (for example in [ZeroSharp's "remove trailing zeros" post](https://zerosharp-com.pages.dev/how-to-remove-the-trailing-zeros-of-precision-from-a-c-number-decimal/)); the outputs above are from this post's run, not copied from there.

Two things normalization does not do. It does not change equality, hashing, or ordering, because those never looked at the scale. And it does not round: `Normalize(1m / 3m)` still has 28 digits, because none of them are zeros.

If you build JSON for an external system and want canonical numbers everywhere, apply `Normalize` in a small `JsonConverter<decimal>`'s `Write` method rather than at every call site. The [custom JsonConverter walkthrough](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) shows the pattern; the only line that matters here is `writer.WriteNumberValue(Normalize(value))`.

## Forcing a fixed number of decimals instead

The opposite request is just as common: "always store two decimals, even for whole numbers." `decimal.Round` will not pad, but addition will, because it takes the larger scale:

```csharp
// .NET 10 / .NET 11, C# 14
static decimal WithScale(decimal value, byte scale) =>
    decimal.Round(value, scale) + new decimal(0, 0, 0, false, scale);

WithScale(1.5m, 2);      // 1.50   (scale 2)
WithScale(1.2345m, 2);   // 1.23   (scale 2)
WithScale(7m, 2);        // 7.00   (scale 2)
WithScale(3m, 4);        // 3.0000 (scale 4)
```

`new decimal(0, 0, 0, false, scale)` is a zero with the requested scale (`0.00` for 2). Rounding first caps the scale, and adding the zero raises it back to exactly `scale`. Avoid the tempting `x * 1.00m`: multiplication adds scales, so `1.5m * 1.00m` becomes `1.500`, not `1.50`. Also remember `decimal.Round` uses banker's rounding by default; pass `MidpointRounding.AwayFromZero` if `2.345` must become `2.35`.

A database column with a declared scale does this for you on the way in: SQL Server's [`decimal(p, s)`](https://learn.microsoft.com/en-us/sql/t-sql/data-types/decimal-and-numeric-transact-sql) stores exactly `s` fractional digits, so treat the scale of values you read back as coming from the column definition, not from what you wrote.

## .NET 11: digits that are not trailing zeros

The most confusing variant of this question on .NET 11 is "why does my decimal suddenly print `1.1000000000000000888178419700`?" That value has two trailing zeros, but stripping them does not give you `1.1` back. It comes from converting a `double`:

```csharp
// net10.0 and net11.0, same source, built with SDK 11.0.100-rc.3.26522.148
double price = double.Parse("1.1", CultureInfo.InvariantCulture);
decimal m = (decimal)price;

Console.WriteLine($"{m} scale {m.Scale}");
Console.WriteLine(m.ToString("G29"));
Console.WriteLine(m / 1.0000000000000000000000000000m);
```

```text
.NET 10.0.14:
1.1 scale 1
1.1
1.1

.NET 11.0.0-rc.3.26522.148:
1.1000000000000000888178419700 scale 28
1.10000000000000008881784197
1.10000000000000008881784197
```

Starting with .NET 11 Preview 7, `double` and `float` to `decimal` conversions [round the exact binary value once](https://learn.microsoft.com/en-us/dotnet/core/compatibility/core-libraries/11/decimal-biginteger-floating-point-conversions) instead of keeping only 15 (or 7) significant digits. The `double` nearest to 1.1 really is `1.100000000000000088817841970012523...`, so the new result is the correct one, and `G29` and `Normalize` can only remove the two zeros at the end. With an input of `19.99` the .NET 11 result is `19.989999999999998436805981328` (scale 27), which has no trailing zeros at all. There is no compatibility switch.

The documented way to get the old result is to go through the double's short string form, which is the value a human typed:

```csharp
// .NET 11
decimal legacy = decimal.Parse(price.ToString("G15", CultureInfo.InvariantCulture), CultureInfo.InvariantCulture);
// 1.1 (scale 1) for 1.1, 19.99 (scale 2) for 19.99, on .NET 10 and .NET 11
```

`"R"` (shortest round-trippable) gave the same results for these inputs. The better fix is to stop crossing from `double` at all: parse money from strings straight into `decimal`, and use `m` literals.

A second trap while testing this: a conversion written as a constant, like `(decimal)1.1d` or `(decimal)(0.1 + 0.2)`, is folded by the compiler. Per the breaking change note, a compiler from the .NET 11 Preview 7 SDK or later embeds the new result "regardless of the project's target framework". In this run, a `net10.0` build made with the RC3 SDK printed `1.1000000000000000888178419700` for `(decimal)1.1d` on the .NET 10.0.14 runtime, while the same expression built with SDK 10.0.302 printed `1.1`. So upgrading only the SDK can change decimal constants in a `net10.0` app, which is a behavioral break of the kind described in [source-breaking vs binary-breaking changes](/2026/10/what-is-the-difference-between-a-source-breaking-and-a-binary-breaking-change-in-a-dotnet-library/). If you need to see exactly what a `double` holds before converting it, the [hex float format added in .NET 11](/2026/06/dotnet-11-floating-point-hex-format-numberstyles-hexfloat/) shows the bits.

## Quick reference

- **Show `1.10` as `1.1`**: `ToString("0.############################", CultureInfo.InvariantCulture)`. Use `"G29"` only if values never go below `0.0001`, or you will see `1E-05`.
- **Make the value itself `1.1`** (for JSON, hashing text, cache keys): `value / 1.0000000000000000000000000000m`.
- **Always exactly N decimals**: `decimal.Round(value, n) + new decimal(0, 0, 0, false, (byte)n)`, or format with `"F2"` / `"N2"` if it is display only.
- **Compare amounts**: compare the `decimal` values, never their strings. `1.1m == 1.10m` is already `true`.
- **On .NET 11, long tails after a `double` conversion** are not trailing zeros. Avoid `double`, or round-trip through `ToString("G15")`.

## Reproducing these results

All snippets come from two console apps with `<TargetFrameworks>net10.0;net11.0</TargetFrameworks>` and `<InvariantGlobalization>true</InvariantGlobalization>`, built with SDK 11.0.100-rc.3.26522.148 and run with `dotnet run -f net10.0` and `dotnet run -f net11.0` on macOS arm64 (runtimes 10.0.14 and 11.0.0-rc.3.26522.148). The SDK comparison for the constant-folding case used a third app built once with SDK 10.0.302 (runtime 10.0.10) and once with the RC3 SDK. Apart from the runtime version line, the scale, formatting, JSON, and normalization outputs were identical on both runtimes; only the `double` to `decimal` conversions differed.

## Sources

- [System.Decimal struct, remarks on the scaling factor (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.decimal)
- [Decimal.Scale property (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.decimal.scale)
- [Decimal.GetBits method (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.decimal.getbits)
- [Standard numeric format strings, "G" specifier (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/standard/base-types/standard-numeric-format-strings)
- [Custom numeric format strings (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/standard/base-types/custom-numeric-format-strings)
- [Breaking change: Decimal and BigInteger floating-point conversions are correctly rounded (.NET 11)](https://learn.microsoft.com/en-us/dotnet/core/compatibility/core-libraries/11/decimal-biginteger-floating-point-conversions)
- [decimal and numeric (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/data-types/decimal-and-numeric-transact-sql)
