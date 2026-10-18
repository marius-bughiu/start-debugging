---
title: "How to Format Numbers with Indian Lakh/Crore Digit Grouping in .NET (NumberGroupSizes)"
description: "Use the en-IN culture or set NumberFormatInfo.NumberGroupSizes to [3, 2] to print 12,34,56,789 instead of 123,456,789 in C#. Measured on .NET 10 and .NET 11 RC1: how the array works, why CurrencyGroupSizes is separate, the invariant-globalization trap that silently prints Western grouping, and a lakh/crore words helper."
pubDate: 2026-10-18
template: how-to
tags:
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "globalization"
  - "formatting"
---

**Short answer:** pass the `en-IN` culture (or any other Indian culture such as `hi-IN`) to `ToString("N2", culture)` and .NET prints `12,34,56,789.50` instead of `123,456,789.50`, because those cultures already ship `NumberFormatInfo.NumberGroupSizes = [3, 2]`. If you need the grouping without the rest of the culture, clone a `NumberFormatInfo`, set `NumberGroupSizes = [3, 2]` (and `CurrencyGroupSizes` and `PercentGroupSizes` if you use `C` or `P`), and pass that as the format provider. The array means "first group from the right has 3 digits, every group after it has 2", and it works for `int`, `long`, `decimal`, `double`, `BigInteger`, custom `#,##0` patterns and `TryFormat` alike.

Everything below was measured on .NET SDK 10.0.302 (runtime 10.0.10) and on .NET 11 RC1 (`11.0.100-rc.1.26425.128`) on macOS with ICU, C# 14. The output was byte-identical on both runtimes, and the `NumberGroupSizes` API itself has not changed since .NET Framework 1.1, so the same code works on .NET 8 and 9.

## Why Indian grouping is different from Western grouping

The Western convention groups every three digits: thousand, million, billion. The Indian numbering system groups the first three digits (hundreds), then every two digits after that: thousand, lakh (1,00,000), crore (1,00,00,000), and so on. So one hundred twenty-three million four hundred fifty-six thousand seven hundred eighty-nine is written `123,456,789` in the US and `12,34,56,789` in India (12 crore, 34 lakh, 56 thousand, 789).

.NET does not hard-code either convention. Every `NumberFormatInfo` carries three integer arrays that describe how to split the integral part of a number into groups:

- `NumberGroupSizes`, used by the `N` format and by custom patterns that contain `,`
- `CurrencyGroupSizes`, used by the `C` format
- `PercentGroupSizes`, used by the `P` format

The formatter walks those arrays from the decimal point to the left. That is the whole mechanism, and the reason a single array can describe both conventions.

## Minimal repro: the same number, two cultures

```csharp
// .NET 11, C# 14 (also .NET 10.0.10)
using System.Globalization;

var us  = CultureInfo.GetCultureInfo("en-US");
var inr = CultureInfo.GetCultureInfo("en-IN");
decimal amount = 123456789.5m;

Console.WriteLine(string.Join(",", us.NumberFormat.NumberGroupSizes));  // 3
Console.WriteLine(string.Join(",", inr.NumberFormat.NumberGroupSizes)); // 3,2

Console.WriteLine(amount.ToString("N2", us));   // 123,456,789.50
Console.WriteLine(amount.ToString("N2", inr));  // 12,34,56,789.50
Console.WriteLine(amount.ToString("C", inr));   // ₹12,34,56,789.50
Console.WriteLine(12345.678.ToString("P1", inr)); // 12,34,567.8%
```

`hi-IN`, `bn-IN` and `ta-IN` report the same `[3, 2]` sizes for all three arrays. They also use ASCII digits in the output: .NET's numeric formatting never substitutes `NativeDigits`, so you get `12,34,56,789`, not Devanagari or Bengali digits, regardless of which Indian culture you pick.

## The fix, step by step

If your app already runs with an Indian culture as `CurrentCulture`, you are done: `$"{amount:N2}"` picks up the grouping automatically. Most of the time, though, you need Indian grouping on a server whose culture is `en-US` or invariant, or you need it for one column in a report. Here is the procedure that works in every case.

1. Decide whether you want the whole Indian culture or only its digit grouping. `en-IN` also brings the `₹` currency symbol, `dd-MM-yyyy` style dates and Indian English names for months. If you only want the commas, build a custom `NumberFormatInfo` instead.
2. Start from a writable copy. `CultureInfo.GetCultureInfo(...)` and `CultureInfo.InvariantCulture` return read-only instances, and assigning to their `NumberFormat` properties throws `InvalidOperationException: Instance is read-only.` Call `Clone()` on the `NumberFormatInfo`, or create a culture with `new CultureInfo("en-US")`, which is writable.
3. Assign the group sizes. Set `NumberGroupSizes = [3, 2]` for `N` and custom patterns. Set `CurrencyGroupSizes` and `PercentGroupSizes` too if you format with `C` or `P`; they are independent arrays.
4. Freeze it with `NumberFormatInfo.ReadOnly(nfi)` and keep it in a `static readonly` field so every caller shares one immutable provider.
5. Pass it as the `IFormatProvider` to `ToString`, `TryFormat`, `string.Format` or `string.Create`, or set it as `CurrentCulture` if the whole thread should use it.

In code:

```csharp
// .NET 11, C# 14
using System.Globalization;

public static class IndianNumberFormat
{
    public static readonly NumberFormatInfo Grouping = Create();

    private static NumberFormatInfo Create()
    {
        var nfi = (NumberFormatInfo)CultureInfo.InvariantCulture.NumberFormat.Clone();
        nfi.NumberGroupSizes   = [3, 2];
        nfi.CurrencyGroupSizes = [3, 2];
        nfi.PercentGroupSizes  = [3, 2];
        nfi.CurrencySymbol     = "₹"; // invariant default is the generic ¤
        return NumberFormatInfo.ReadOnly(nfi);
    }
}

decimal amount = 123456789.5m;
Console.WriteLine(amount.ToString("N2", IndianNumberFormat.Grouping)); // 12,34,56,789.50
Console.WriteLine(amount.ToString("C",  IndianNumberFormat.Grouping)); // ₹12,34,56,789.50
```

If you forget step 3 for currency, you get a confusing half-migration. With only `NumberGroupSizes` changed, `amount.ToString("C", nfi)` still printed `¤123,456,789.50` in my test, because the `C` format reads `CurrencyGroupSizes`, which was still `[3]`.

To change grouping for an entire request or thread without touching the language of everything else, patch a writable culture:

```csharp
// .NET 11, C# 14
using System.Globalization;

var culture = new CultureInfo("en-US");          // writable, unlike GetCultureInfo
culture.NumberFormat.NumberGroupSizes = [3, 2];
CultureInfo.CurrentCulture = culture;

Console.WriteLine($"{123456789:N0}");            // 12,34,56,789
Console.WriteLine(string.Format(CultureInfo.InvariantCulture, "{0:N0}", 123456789)); // 123,456,789
```

The second line is a reminder that an explicit provider always wins over `CurrentCulture`.

## How the NumberGroupSizes array is interpreted

The rules, verified against the runtime rather than taken on faith:

- Element 0 is the size of the group closest to the decimal point. Element 1 is the next group to the left, and so on.
- The **last element repeats** for every remaining group. That is why `[3, 2]` keeps producing groups of two forever.
- If the last element is `0`, the remaining digits are **not grouped** at all.
- Every element must be between 1 and 9, except the last one, which may be 0. Anything else throws `ArgumentException` with the message "Every element in the value array should be between one and nine, except for the last element, which can be zero."

Here is what different arrays do to `1234567890`:

```csharp
// .NET 11, C# 14
using System.Globalization;

var nfi = (NumberFormatInfo)CultureInfo.InvariantCulture.NumberFormat.Clone();
long n = 1234567890;

nfi.NumberGroupSizes = [3];       Console.WriteLine(n.ToString("N0", nfi)); // 1,234,567,890
nfi.NumberGroupSizes = [3, 2];    Console.WriteLine(n.ToString("N0", nfi)); // 1,23,45,67,890
nfi.NumberGroupSizes = [3, 0];    Console.WriteLine(n.ToString("N0", nfi)); // 1234567,890
nfi.NumberGroupSizes = [3, 2, 0]; Console.WriteLine(n.ToString("N0", nfi)); // 12345,67,890
nfi.NumberGroupSizes = [4];       Console.WriteLine(n.ToString("N0", nfi)); // 12,3456,7890
nfi.NumberGroupSizes = [1, 2, 3]; Console.WriteLine(n.ToString("N0", nfi)); // 1,234,567,89,0
nfi.NumberGroupSizes = [0];       Console.WriteLine(n.ToString("N0", nfi)); // 1234567890
nfi.NumberGroupSizes = [];        Console.WriteLine(n.ToString("N0", nfi)); // 1234567890

nfi.NumberGroupSizes = [3, 0, 2]; // ArgumentException: 0 is only allowed last
nfi.NumberGroupSizes = [10];      // ArgumentException: max is 9
```

`[4]` is the shape you want for East Asian ten-thousand (wan/man) grouping if a design calls for it; no built-in .NET culture uses it by default. `[3, 0]` is handy when a spec says "separate thousands only".

The getter returns a copy of the array. Writing `nfi.NumberGroupSizes[0] = 9` compiles and runs, but changes nothing: in my test the output stayed `12,34,56,789.50`. Always assign a new array.

## Which formats honor the grouping, and which do not

I ran every common path against `en-IN`:

| Call | Output |
|---|---|
| `1234567890123L.ToString("N0", inr)` | `12,34,56,78,90,123` |
| `amount.ToString("#,##0.00", inr)` | `12,34,56,789.50` |
| `BigInteger.Parse("123456789012345").ToString("N0", inr)` | `12,34,56,78,90,12,345` |
| `12345678f.ToString("N0", inr)` | `1,23,45,678` |
| `int.MinValue.ToString("N0", inr)` | `-2,14,74,83,648` |
| `123456789.TryFormat(span, out _, "N0", inr)` | `12,34,56,789` |
| `1234567.ToString("D", inr)` / `"G"` / `"F2"` | `1234567` / `1234567` / `1234567.89` |

So `N`, `C`, `P` and custom patterns with `,` all follow the arrays, including on the allocation-free `TryFormat` path. `D`, `G`, `F`, `E` and the parameterless `ToString()` never group, in any culture.

One custom-format detail trips people up: the position of the comma in a custom pattern does not matter. `123456789.ToString("#,##,##0", enUS)` prints `123,456,789`, not `12,34,56,789`. A comma between digit placeholders only switches grouping on; the sizes always come from `NumberGroupSizes`. You cannot get Indian grouping by writing the "right" pattern. You have to change the provider. A comma immediately before the decimal point (or at the end) is a different feature entirely: it divides by 1,000 per comma, so `"0,,"` turns `123456789` into `123`.

## Gotchas

### Invariant globalization mode silently prints Western grouping

This is the one that ships to production. Many container images and Native AOT apps set `<InvariantGlobalization>true</InvariantGlobalization>` (or `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1`) to drop the ICU dependency. In that mode, `CultureInfo.GetCultureInfo("en-IN")` throws `CultureNotFoundException: Only the invariant culture is supported in globalization-invariant mode.` That is at least loud.

The quiet version happens when someone also sets `PredefinedCulturesOnly` to `false` (`DOTNET_SYSTEM_GLOBALIZATION_PREDEFINED_CULTURES_ONLY=0`) to make that exception go away. Then `new CultureInfo("en-IN")` succeeds, but the culture carries invariant data. I measured `sizes=3`, `123,456,789` from `N0`, and `¤` as the currency symbol, with no exception and no warning. Your Indian users get American commas.

If you build the `NumberFormatInfo` yourself from `InvariantCulture`, as in the `IndianNumberFormat` class above, the grouping works in invariant mode too, because nothing depends on ICU data. That is the most robust option for containers. If you need the full `en-IN` culture, keep ICU in the image; the [ICU container fix](/2026/07/fix-couldnt-find-a-valid-icu-package-installed-on-the-system/) walks through the packages, and the [container deployment comparison](/2026/09/framework-dependent-vs-self-contained-vs-native-aot-for-a-dotnet-11-container-image/) covers which image types turn invariant mode on.

### The default precision of "N" is not portable

On this Mac, ICU reported `NumberDecimalDigits = 3` for `en-IN`, `hi-IN`, `en-US` and `en-GB` alike, so `amount.ToString("N", inr)` printed `12,34,56,789.500` with three decimals, while `CurrencyDecimalDigits` stayed at 2. Under invariant mode the same call printed two decimals. Culture data comes from the OS's ICU (or NLS on older Windows setups), so the default can differ between your laptop and your server. Always pass an explicit precision: `N0`, `N2`, never bare `N`, for anything a user or a test compares.

### Parsing ignores group positions

`decimal.Parse("1,23,45,678.90", NumberStyles.Number, enUS)` returns `12345678.90`, and so does `decimal.Parse("12,345,678", NumberStyles.Number, inr)`. With `NumberStyles.AllowThousands`, .NET accepts group separators anywhere in the integral part and does not validate them against `NumberGroupSizes`. That is convenient for accepting both styles of input, but it means parsing is not a validator. If you must reject `12,345,678` for an Indian-format field, check the shape with a regex such as `^\d{1,2}(,\d{2})*,\d{3}$|^\d{1,3}$` before parsing.

### A different separator

Indian style guides sometimes ask for a thin space instead of a comma. Set `NumberGroupSeparator` (and `CurrencyGroupSeparator` for `C`) on the same cloned `NumberFormatInfo`; I tested `"\u202F"` (narrow no-break space) and got `12 34 56 789` with the sizes unchanged. Use a no-break space so the number never wraps across lines.

## Printing "12.35 lakh" and "2.5 crore"

`NumberGroupSizes` controls separators, not words. .NET has no built-in compact formatter that produces "lakh" or "crore" (the `CompactDecimalFormat` concept exists in ICU but is not exposed through `ToString`). A small helper covers the common UI need:

```csharp
// .NET 11, C# 14
using System.Globalization;

static string ToLakhCrore(decimal value, int decimals = 2)
{
    var inr = CultureInfo.GetCultureInfo("en-IN");
    const decimal Lakh = 1_00_000m, Crore = 1_00_00_000m;
    decimal abs = Math.Abs(value);
    string sign = value < 0 ? "-" : "";
    string fmt = "#,##0." + new string('#', decimals);

    // Round in the target unit first, then promote if rounding crossed the boundary.
    decimal inLakh = Math.Round(abs / Lakh, decimals, MidpointRounding.AwayFromZero);
    if (abs >= Crore || inLakh >= 100m)
        return sign + Math.Round(abs / Crore, decimals, MidpointRounding.AwayFromZero).ToString(fmt, inr) + " crore";
    if (abs >= Lakh || inLakh >= 1m)
        return sign + inLakh.ToString(fmt, inr) + " lakh";
    return sign + abs.ToString(fmt, inr);
}

Console.WriteLine(ToLakhCrore(45_000m));         // 45,000
Console.WriteLine(ToLakhCrore(1_25_000m));       // 1.25 lakh
Console.WriteLine(ToLakhCrore(12_34_567m));      // 12.35 lakh
Console.WriteLine(ToLakhCrore(99_99_999m));      // 1 crore
Console.WriteLine(ToLakhCrore(2_50_00_000m));    // 2.5 crore
Console.WriteLine(ToLakhCrore(1234_56_78_901m)); // 1,234.57 crore
Console.WriteLine(ToLakhCrore(-3_50_000m));      // -3.5 lakh
```

The "round first, then promote" step matters. A naive version that checks `abs >= Crore` before rounding prints `100 lakh` for `99,99,999`, which no Indian reader would write. Note the digit separators in the C# literals (`1_00_000m`): the compiler accepts `_` anywhere between digits, so you can mirror Indian grouping in source code for readability.

If the helper runs in a container with invariant globalization, swap `CultureInfo.GetCultureInfo("en-IN")` for the `IndianNumberFormat.Grouping` provider from earlier, for the reasons in the gotcha above.

## Performance notes

Group sizes are read once per format call from arrays already on the `NumberFormatInfo`, so `[3, 2]` costs the same as `[3]`. The expensive mistake is creating a new `CultureInfo` or cloning a `NumberFormatInfo` per call. Cache the provider in a `static readonly` field, as shown above, and use `TryFormat` into a stack buffer when you are formatting in a hot loop; the [StringBuilder vs interpolation comparison](/2026/05/stringbuilder-vs-string-interpolation-in-dotnet-11/) shows how much the allocation-free path saves when you build larger strings from many numbers.

## Related

- [Fix: Couldn't find a valid ICU package installed on the system in a .NET container](/2026/07/fix-couldnt-find-a-valid-icu-package-installed-on-the-system/) if `en-IN` throws in Docker.
- [Framework-dependent vs self-contained vs Native AOT for a .NET 11 container image](/2026/09/framework-dependent-vs-self-contained-vs-native-aot-for-a-dotnet-11-container-image/) for where invariant globalization gets switched on.
- [How to use Native AOT with ASP.NET Core minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/), which defaults to invariant mode.
- [.NET 11 can round-trip a double as hex, bit for bit](/2026/06/dotnet-11-floating-point-hex-format-numberstyles-hexfloat/) for another corner of numeric formatting and `NumberStyles`.

## Sources

- [NumberFormatInfo.NumberGroupSizes property](https://learn.microsoft.com/en-us/dotnet/api/system.globalization.numberformatinfo.numbergroupsizes) on Microsoft Learn.
- [NumberFormatInfo.CurrencyGroupSizes property](https://learn.microsoft.com/en-us/dotnet/api/system.globalization.numberformatinfo.currencygroupsizes) on Microsoft Learn.
- [Standard numeric format strings](https://learn.microsoft.com/en-us/dotnet/standard/base-types/standard-numeric-format-strings) and [custom numeric format strings](https://learn.microsoft.com/en-us/dotnet/standard/base-types/custom-numeric-format-strings), including the group separator and number scaling specifier.
- [Globalization and ICU in .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/globalization-icu).
- [Culture creation and case mapping in globalization-invariant mode](https://learn.microsoft.com/en-us/dotnet/core/compatibility/globalization/6.0/culture-creation-invariant-mode), the .NET 6 change that introduced `PredefinedCulturesOnly`.
