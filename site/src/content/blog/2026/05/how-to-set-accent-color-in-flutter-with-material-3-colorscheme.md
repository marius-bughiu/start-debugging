---
title: "How to set the accent color in a Flutter app with Material 3 ColorScheme"
description: "The 2026 way to set an accent color in Flutter with Material 3: ColorScheme.fromSeed, the colorSchemeSeed shorthand, the seven DynamicSchemeVariant options, dark mode, dynamic_color on Android 12+, and harmonizing brand colors. Tested on Flutter 3.27.1 and Dart 3.11."
pubDate: 2026-05-06
template: how-to
tags:
  - "flutter"
  - "dart"
  - "material-3"
  - "theming"
  - "how-to"
---

Short answer: Material 3 does not have an "accent color" anymore. The closest single knob is the seed color you pass to `ColorScheme.fromSeed`. Use `ThemeData(colorSchemeSeed: Colors.deepPurple)` for the simplest case, or `ColorScheme.fromSeed(seedColor: ..., brightness: Brightness.light)` when you want to control variant, contrast level, or pair light and dark schemes. From that one seed, the framework derives the full M3 palette: `primary`, `onPrimary`, `secondary`, `tertiary`, `surface`, `surfaceContainer`, and the rest. Verified on Flutter 3.27.1, Dart 3.11.

This guide walks through the right way to do it in 2026, the things that look right but break in dark mode or on Android 12+, and how to keep an existing brand color while still getting the M3 tonal system.

## Why "accent color" stopped existing in M3

Material 2 had `primaryColor` and `accentColor` as two roughly independent knobs. You set them, and widgets like `FloatingActionButton`, `Switch`, or `TextField` cursor would pick one or the other. In Material 3, that vocabulary is gone. The spec replaces both with a system of color roles that are computed from a single seed:

- `primary`, `onPrimary`, `primaryContainer`, `onPrimaryContainer`
- `secondary`, `onSecondary`, `secondaryContainer`, `onSecondaryContainer`
- `tertiary`, `onTertiary`, `tertiaryContainer`, `onTertiaryContainer`
- `surface`, `onSurface`, `surfaceContainerLowest` ... `surfaceContainerHighest`
- `error`, `onError`, plus variants
- `outline`, `outlineVariant`, `inverseSurface`, `inversePrimary`

Whatever was your "accent" in M2 most often maps to `primary` in M3, and sometimes to `tertiary` if you used accent for highlights. The Material 3 [color roles documentation](https://m3.material.io/styles/color/roles) is the canonical source for which role goes on which surface.

The practical consequence: if you Google an old StackOverflow answer that says "set `ThemeData.accentColor`", that property still compiles in some narrow paths but no Material 3 widget reads it. You will spend an afternoon wondering why nothing changed. It is deprecated and effectively a no-op for M3 widgets.

## The minimal correct pattern

Material 3 is on by default in Flutter 3.16 and later. You do not need to set `useMaterial3: true` anymore. The simplest, idiomatic accent color for a brand-new app:

```dart
// Flutter 3.27.1, Dart 3.11
import 'package:flutter/material.dart';

void main() => runApp(const MyApp());

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Demo',
      theme: ThemeData(
        colorSchemeSeed: Colors.deepPurple,
        brightness: Brightness.light,
      ),
      darkTheme: ThemeData(
        colorSchemeSeed: Colors.deepPurple,
        brightness: Brightness.dark,
      ),
      themeMode: ThemeMode.system,
      home: const Scaffold(),
    );
  }
}
```

`colorSchemeSeed` is a shorthand inside `ThemeData` that is equivalent to:

```dart
// What colorSchemeSeed expands to internally
ThemeData(
  colorScheme: ColorScheme.fromSeed(
    seedColor: Colors.deepPurple,
    brightness: Brightness.light,
  ),
);
```

If you only need the seed and the brightness, prefer `colorSchemeSeed`. Reach for `ColorScheme.fromSeed` directly when you need to tune the variant, the contrast level, or override one or two specific roles.

## Choosing a DynamicSchemeVariant

Since Flutter 3.22 the `ColorScheme.fromSeed` constructor accepts a `dynamicSchemeVariant` parameter. This selects which Material Color Utilities algorithm derives the palette. The options, in order of how aggressively they keep your seed visible:

- `DynamicSchemeVariant.tonalSpot` (default): Material 3's standard recipe. Mid-saturation, balanced. The seed becomes the source for `primary`, with `secondary` and `tertiary` pulled from neighboring hues.
- `DynamicSchemeVariant.fidelity`: keeps `primary` very close to the exact seed color. Use this when the brand wants the seed to render literally.
- `DynamicSchemeVariant.content`: similar to `fidelity` but designed for content-derived palettes (e.g. the dominant color of a hero image).
- `DynamicSchemeVariant.monochrome`: greyscale. `primary`, `secondary`, `tertiary` are all neutrals.
- `DynamicSchemeVariant.neutral`: low chroma. The seed barely tints the result.
- `DynamicSchemeVariant.vibrant`: pushes chroma. Good for playful or media-heavy apps.
- `DynamicSchemeVariant.expressive`: rotates `secondary` and `tertiary` further around the wheel. Visually busier.
- `DynamicSchemeVariant.rainbow`, `DynamicSchemeVariant.fruitSalad`: extreme variants, used by Material You launchers more than by typical apps.

A concrete example. If your brand color is exactly `#7B1FA2` and the marketing team has already approved that specific purple, `tonalSpot` will desaturate it. `fidelity` preserves it:

```dart
// Flutter 3.27.1
final brand = const Color(0xFF7B1FA2);

final lightScheme = ColorScheme.fromSeed(
  seedColor: brand,
  brightness: Brightness.light,
  dynamicSchemeVariant: DynamicSchemeVariant.fidelity,
);
```

Pick the variant once, then apply it to both light and dark brightness so the look is consistent across themes.

## Pairing light and dark schemes correctly

Building two `ColorScheme` instances from the same seed (one per `Brightness`) is the right approach. The framework regenerates the tonal palette per brightness so that contrast ratios stay above the M3 minimums. Do not invert colors yourself.

```dart
// Flutter 3.27.1
final seed = Colors.indigo;

final light = ColorScheme.fromSeed(
  seedColor: seed,
  brightness: Brightness.light,
);
final dark = ColorScheme.fromSeed(
  seedColor: seed,
  brightness: Brightness.dark,
);

return MaterialApp(
  theme: ThemeData(colorScheme: light),
  darkTheme: ThemeData(colorScheme: dark),
  themeMode: ThemeMode.system,
  home: const Home(),
);
```

A common bug here: building the light theme with `Brightness.light` but forgetting to pass `Brightness.dark` to the dark theme. The dark scheme then reuses the light tones, which look washed out on a black surface and fail WCAG AA contrast on body text. Always pass both.

If you need extra control over contrast, `ColorScheme.fromSeed` accepts a `contrastLevel` from `-1.0` (lower contrast) to `1.0` (higher contrast). The default `0.0` matches the M3 spec. Higher contrast is useful when your app must satisfy enterprise accessibility audits.

## Using a brand color while keeping M3 generation

Sometimes the brand color is non-negotiable but the rest of the palette is up for grabs. Use `ColorScheme.fromSeed` and override a single role:

```dart
// Flutter 3.27.1
final scheme = ColorScheme.fromSeed(
  seedColor: Colors.indigo,
  brightness: Brightness.light,
).copyWith(
  primary: const Color(0xFF1E3A8A), // exact brand
);
```

This keeps everything else (`secondary`, `tertiary`, `surface`, etc.) in the algorithmically derived palette and only pins `primary`. Do not override more than one or two roles. The whole point of the M3 system is that the roles are mutually consistent. Pinning four colors usually breaks contrast somewhere.

A safer alternative when you have multiple required brand colors is to harmonize them against the seed instead of replacing roles. The Material Color Utilities expose `MaterialDynamicColors.harmonize`, available through the [`dynamic_color`](https://pub.dev/packages/dynamic_color) package:

```dart
// Flutter 3.27.1, dynamic_color 1.7.0
import 'package:dynamic_color/dynamic_color.dart';

final brandError = const Color(0xFFD32F2F);
final harmonized = brandError.harmonizeWith(scheme.primary);
```

`harmonizeWith` shifts the brand hue slightly towards the seed so the two coexist visually, without losing the brand's identity. This is the right tool when the design system mandates an exact red for, say, error or destructive buttons.

## Material You: dynamic color on Android 12+

If you ship on Android 12 or higher, the system can hand you a wallpaper-derived `ColorScheme`. Wire it up with `dynamic_color`'s `DynamicColorBuilder`. On iOS, web, desktop, or older Android, the builder returns `null` and you fall back to your seed.

```dart
// Flutter 3.27.1, dynamic_color 1.7.0
import 'package:dynamic_color/dynamic_color.dart';
import 'package:flutter/material.dart';

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return DynamicColorBuilder(
      builder: (lightDynamic, darkDynamic) {
        final ColorScheme light = lightDynamic ??
            ColorScheme.fromSeed(
              seedColor: Colors.indigo,
              brightness: Brightness.light,
            );
        final ColorScheme dark = darkDynamic ??
            ColorScheme.fromSeed(
              seedColor: Colors.indigo,
              brightness: Brightness.dark,
            );

        return MaterialApp(
          theme: ThemeData(colorScheme: light),
          darkTheme: ThemeData(colorScheme: dark),
          themeMode: ThemeMode.system,
          home: const Home(),
        );
      },
    );
  }
}
```

A subtle gotcha: `lightDynamic` and `darkDynamic` are not always derived from the same wallpaper. On some Pixel devices the dark scheme comes from a different source. Treat them as independent. If you need to harmonize a brand red with whichever scheme the user ended up with, do `brandRed.harmonizeWith(scheme.primary)` per build, not once at startup.

## Reading the color in your widgets

Once the scheme is set, access roles through `Theme.of(context).colorScheme`. Do not hard-code hex values inside widgets and do not reference the M2 `primaryColor` / `accentColor` getters.

```dart
// Flutter 3.27.1
class CallToAction extends StatelessWidget {
  const CallToAction({super.key, required this.label});
  final String label;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return FilledButton(
      style: FilledButton.styleFrom(
        backgroundColor: scheme.primary,
        foregroundColor: scheme.onPrimary,
      ),
      onPressed: () {},
      child: Text(label),
    );
  }
}
```

`FilledButton` already uses `primary` and `onPrimary` by default, so the explicit `styleFrom` is only there to demonstrate the role names. Most M3 widgets have sensible defaults, so the simplest answer to "how do I theme my buttons with the accent color" is "pick the right widget", not "override the style".

A quick mapping for the M2-to-M3 transition:

| M2 idea | M3 role |
| --- | --- |
| `accentColor` highlight on toggles, sliders, FAB | `primary` |
| `accentColor` used as a soft chip background | `secondaryContainer` with `onSecondaryContainer` text |
| `accentColor` used as a "third" highlight | `tertiary` |
| `primaryColor` app bar | `primary` (or `surface` for the M3 default app bar) |
| `cardColor` | `surfaceContainer` |
| `dividerColor` | `outlineVariant` |
| `disabledColor` | `onSurface` at 38% opacity |

## Things that look right but are wrong

Five mistakes I see weekly:

1. **Setting `useMaterial3: false`** in a new app to "make styling easier", then asking why `colorSchemeSeed` still produces M3 tones. `colorSchemeSeed` is M3-only. If you opt out of M3, you also opt out of seeded color schemes. Stay on M3 unless you have a hard requirement.
2. **Building one `ColorScheme` and reusing it for both themes.** The light scheme on a black background fails contrast. Build two from the same seed.
3. **Calling `ColorScheme.fromSeed` inside `build()`** of a widget high in the tree. It runs the Material Color Utilities every rebuild, which is not catastrophic but is wasteful. Build the scheme once in `main` or in your `App` `State`, then pass it down.
4. **Using `Colors.deepPurple.shade300` as a seed.** Seeds work best when they are saturated and clearly hued. A washed-out swatch shade gives you a washed-out palette. Pass the base color (e.g. `Colors.deepPurple`, which is the 500 shade) and let `tonalSpot` do the desaturation work for the lighter roles.
5. **Hard-coding a hex color for the FAB or selected `Switch` thumb** because "accent color is gone". The role is `primary`. If `primary` does not look right for that surface, your variant is wrong, not your widget.

## Cleaning up an old app: a 5-minute migration

If the app already has `accentColor` or `primarySwatch` somewhere, the cheapest correct migration is:

1. Delete `accentColor` and `primarySwatch` from `ThemeData(...)`.
2. Add `colorSchemeSeed: <your old primary>`.
3. Remove `useMaterial3: false` if you have it; M3 is the default in 3.16+.
4. Grep your project for `Theme.of(context).accentColor`, `theme.primaryColor`, and `theme.colorScheme.background` (renamed to `surface` in newer Flutters), and replace each with the right M3 role from the table above.
5. Run `flutter analyze`. Anything still warning about a deprecated theme property gets the same treatment.

The single biggest visual change you will see after this is that the default `AppBar` background is now `surface`, not `primary`. If you want the colored app bar back, set `appBarTheme: AppBarTheme(backgroundColor: scheme.primary, foregroundColor: scheme.onPrimary)`. Many teams discover after the fact that they actually preferred the M3 `surface` app bar once they got used to it.

## Related reading

If you are migrating a larger Flutter app at the same time, the [GetX to Riverpod migration walkthrough](/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) and the [profiling jank with DevTools guide](/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) cover two things that often surface during a theming refresh: state-management churn and surprise rebuild storms. For native bridges (e.g. exposing a system theme signal you cannot get from Flutter alone), see [adding platform-specific code without plugins](/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/). And if your CI matrix straddles old and new Flutter SDKs while you migrate, the post on [targeting multiple Flutter versions from one CI pipeline](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) keeps both branches green.

## Sources

- Flutter API: [`ColorScheme.fromSeed`](https://api.flutter.dev/flutter/material/ColorScheme/ColorScheme.fromSeed.html)
- Flutter API: [`ThemeData.colorSchemeSeed`](https://api.flutter.dev/flutter/material/ThemeData/colorSchemeSeed.html)
- Flutter API: [`DynamicSchemeVariant`](https://api.flutter.dev/flutter/material/DynamicSchemeVariant.html)
- Material 3 spec: [color roles](https://m3.material.io/styles/color/roles)
- pub.dev: [`dynamic_color`](https://pub.dev/packages/dynamic_color) for Material You and harmonization
