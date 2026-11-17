---
title: "CommunityToolkit.Maui 17.0: .NET 11 Only, and Your Converters Now Use the Binding's Culture"
description: "CommunityToolkit.Maui 17.0.0 shipped on November 10, 2026 targeting .NET MAUI 11 only. The upgrade is mostly a TFM bump, but eight converters switched from CurrentCulture to the culture the binding passes, MathExpressionConverter became culture-invariant, and TextCaseConverter now uppercases 'istanbul' to 'İSTANBUL' under tr-TR."
pubDate: 2026-11-17
tags:
  - "maui"
  - "dotnet"
  - "dotnet-11"
  - "localization"
---

[CommunityToolkit.Maui 17.0.0](https://github.com/CommunityToolkit/Maui/releases/tag/17.0.0) landed on November 10, 2026, the same day .NET 11 went GA (the project-level changes for that are in [.NET 11 is generally available: what to change in your project](/2026/11/dotnet-11-is-generally-available-what-to-change-in-your-project/)). Alongside it shipped CommunityToolkit.Maui.Camera 8.0.0, CommunityToolkit.Maui.MediaElement 12.0.0, and a final CommunityToolkit.Maui.Maps 5.0.0. The headline is the move to `net11.0`, but the change most likely to show up as a bug report is quieter: several converters now format with a different culture than they did in 15.x.

## Setup changes first

The 17.0 packages target `net11.0` and its platform TFMs only and reference `Microsoft.Maui.Controls` 11.0.0. If your app is still on .NET 10, stay on CommunityToolkit.Maui 15.x, Camera 6.x and MediaElement 10.x. The minimum OS versions follow .NET MAUI 11: iOS 15.0, Mac Catalyst 17.0, Android 7.0 (API 24), Windows 10 1809. MediaElement still needs Android 8.0 (API 26). Tizen code paths are gone, matching MAUI dropping Tizen in .NET 10.

```xml
<PropertyGroup>
  <TargetFrameworks>net11.0-android;net11.0-ios;net11.0-maccatalyst</TargetFrameworks>
  <TargetFrameworks Condition="$([MSBuild]::IsOSPlatform('windows'))">$(TargetFrameworks);net11.0-windows10.0.19041.0</TargetFrameworks>
</PropertyGroup>
<ItemGroup>
  <PackageReference Include="Microsoft.Maui.Controls" Version="11.0.0" />
  <PackageReference Include="CommunityToolkit.Maui" Version="17.0.0" />
</ItemGroup>
```

On `net11.0-windows` only, the toolkit's own async methods are compiled as [runtime async](https://learn.microsoft.com/dotnet/core/whats-new/dotnet-11/runtime#runtime-async). The maintainers deliberately left it off for the Mono-based targets (Android, iOS, Mac Catalyst), and their release notes advise library authors not to enable it in packages a Mono app might consume.

## Which culture a converter sees

When a binding has no `ConverterCulture`, .NET MAUI passes `CultureInfo.CurrentUICulture` to `IValueConverter.Convert`. Until 17.0, these toolkit converters ignored that argument and read the thread's `CurrentCulture`:

- `ColorToCmykStringConverter`, `ColorToHslStringConverter`, `ColorToHslaStringConverter`
- `CompareConverter`, `IsInRangeConverter`, `ListToStringConverter`
- `MathExpressionConverter`, `MultiMathExpressionConverter`

In 17.0 they use the culture the binding hands them. Output changes only in two situations: you set `ConverterCulture` explicitly, or the user's UI language differs from their regional format (an English UI with German number formatting is common on Windows and Android). Calling a converter directly with a `null` culture keeps the old behavior.

`TextCaseConverter` is the visible one. It used invariant casing; now it uses the binding's culture, which only matters for Turkish and Azerbaijani dotted and dotless I:

```xml
<Label Text="{Binding City,
                Converter={StaticResource TextCase},
                ConverterParameter=Upper,
                ConverterCulture=tr-TR}" />
<!-- City = "istanbul": 15.x showed ISTANBUL, 17.0 shows İSTANBUL -->
```

If you used `TextCaseConverter` to build identifiers or lookup keys rather than display text, pass `ConverterCulture` explicitly or move that logic out of XAML.

## Fixes hiding in the same change

`MathExpressionConverter` expressions are now culture-invariant. Before 17.0, `3.5` in an expression meant 35 under de-DE and threw under fr-FR, and any function name containing an `I` (`PI`, `MIN`, `SIN`, `IF`, `CEILING`) failed under tr-TR. Numbers in the expression now always use `.`.

`DoubleToIntConverter` parses a string `ConverterParameter` with the invariant culture first, then falls back to the binding's culture. One edge case flips: `1.000` under de-DE now means 1, not 1000.

`DateTimeOffsetConverter` no longer applies the culture's calendar, which produced wrong years under th-TH and fa-IR and threw under ar-SA. `ColorToRgbaStringConverter` can now convert back its own output in comma-decimal cultures.

The `[BindableProperty]` source generators also stopped depending on the build machine's culture. A Turkish build agent used to emit `ınternal partial class`, and comma-decimal machines produced invalid numeric literals, both of which broke the build.

If your MAUI app ships only in English with matching UI and regional settings, 17.0 is a version bump. If it ships in Turkish, German, Thai, or Arabic locales, add a quick pass over every page that binds through these converters before you release on .NET 11. The full per-converter list is in the [17.0.0 release notes](https://github.com/CommunityToolkit/Maui/releases/tag/17.0.0).
