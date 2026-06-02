---
title: ".NET 11 Can Round-Trip a Double as Hex, Bit for Bit"
description: ".NET 11 Preview 4 teaches double, float, and Half to format with the X specifier and parse with NumberStyles.HexFloat, producing the same IEEE-754 hex text as C printf(\"%a\")."
pubDate: 2026-06-02
tags:
  - "dotnet-11"
  - "csharp"
  - "performance"
---

The [.NET 11 Preview 4 library notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview4/libraries.md) slipped in a feature that sounds niche until the day you need it: `double`, `float`, and `Half` can now be written and read back in IEEE-754 hexadecimal form. That is the same notation C and C++ emit with `printf("%a", ...)`, and it exposes every bit of the value directly in the text.

## The X Specifier Used To Throw on a Double

Until now the `"X"` format string was integral-only. Call it on a floating-point value and you got a `FormatException`:

```csharp
double value = Math.PI;
string hex = value.ToString("X"); // .NET 10: throws FormatException
```

Starting with .NET 11, that same call returns the hex float representation:

```csharp
using System.Globalization;

double value = Math.PI;

string hex = value.ToString("X"); // "0X1.921FB54442D18P+1"
double round = double.Parse(hex, NumberStyles.HexFloat);

Console.WriteLine(round == value); // True, exact round-trip
```

The new `NumberStyles.HexFloat` flag is what tells `Parse` and `TryParse` to read that shape back. The leading `0X1.` is the mantissa, and `P+1` is the binary exponent, so what you are looking at is the literal bit layout, not a decimal approximation of it.

## Decimal Round-Trip Already Worked, So Why Bother

This is worth being precise about. Since .NET Core 3.0 the shortest round-trippable formatter has guaranteed that `double.Parse(value.ToString())` gives back the exact same `double`. So hex is not fixing a correctness bug in decimal round-tripping.

What hex buys you is transparency and interop. The decimal text for a `double` changes shape depending on the value and is opaque about which bits are set. The hex form is canonical: every distinct `double` maps to one hex string, and that string is byte-comparable across platforms and languages. If you are pinning expected values in a golden-file test, a one-character drift in the last decimal place is a real headache. Hex makes the comparison exact and obvious.

## Where It Earns Its Keep

The clearest win is cross-language interop. A native library logging floats with `%a`, or a numerics test suite shared with a C++ codebase, produces hex that .NET can now consume directly:

```csharp
// From a C++ component that printed with %a
string fromNative = "0X1.5BF0A8B145769P+1"; // ~2.718281828...
double e = double.Parse(fromNative, NumberStyles.HexFloat);
```

`Half` and `float` get the same treatment, so half-precision values coming out of an ML pipeline or a GPU buffer round-trip without a lossy hop through decimal text. Pull the [Preview 4 SDK](https://dotnet.microsoft.com/en-us/download/dotnet/11.0), target `net11.0`, and the next time you need to serialize a float for a test fixture or a debug dump, reach for `"X"` instead of hand-rolling a `BitConverter.DoubleToInt64Bits` dance.
