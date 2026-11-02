---
title: "Migrate a Flutter App from textScaleFactor to TextScaler (Flutter 3.16+)"
description: "Replace the deprecated textScaleFactor on MediaQueryData, Text, RichText and TextPainter with TextScaler. What dart fix rewrites (3 of 9 call sites in our sample), why its output can quietly undo Android 14 nonlinear font scaling, how to cap text size with clamp and withClampedTextScaling, and the equality and test gotchas. Measured on Flutter 3.44.8 with Dart 3.12.2."
pubDate: 2026-11-02
updatedDate: 2026-11-02
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "accessibility"
---

`textScaleFactor` has been deprecated across the Flutter framework since the 3.16 release (the annotations say "deprecated after v3.12.0-2.0.pre"). The replacement is `TextScaler`: read it with `MediaQuery.textScalerOf(context)`, pass it with `textScaler:` on `Text`, `RichText`, `TextPainter` and `MediaQueryData`, and turn a font size into a scaled size with `textScaler.scale(fontSize)` instead of `fontSize * textScaleFactor`. To cap text size, use `textScaler.clamp(maxScaleFactor: 1.3)` or `MediaQuery.withClampedTextScaling(maxScaleFactor: 1.3, child: ...)`, and to turn scaling off, use `TextScaler.noScaling` or `MediaQuery.withNoTextScaling`. `dart fix --apply` only rewrites the `MediaQueryData` constructor, `MediaQueryData.copyWith` and (sometimes) the `TextPainter` constructor: in our sample it fixed 3 of 9 deprecated call sites. Worse, the code it produces for the common "cap the text scale" pattern wraps the old number in `TextScaler.linear(...)`, which replaces Android 14's nonlinear curve with a flat multiplier. A typical app migrates in under an hour. Everything below was run on Flutter 3.44.8 (Dart 3.12.2).

## Why move off textScaleFactor now

- **A single number is wrong on Android 14 and later.** Android 14 scales small text more than large text, so at a 200% system font size a 14sp label becomes 26sp, not 28sp, and a 30sp headline becomes 38sp, not 60sp. Any code that multiplies by `textScaleFactor` (row heights, icon sizes next to text, `TextPainter` measurements) computes sizes that do not match what `Text` actually renders.
- **The scalar getter lies for nonlinear scalers.** `MediaQueryData.textScaleFactor` is now just `textScaler.textScaleFactor`, and for the system scaler that is the raw platform factor. It is a compatibility shim, not a measurement.
- **Removal is tracked.** The framework source carries `TODO`s pointing at [flutter/flutter#128825](https://github.com/flutter/flutter/issues/128825) to remove `textScaleFactor`. When that lands, every remaining use becomes a compile error.
- **Analyzer noise.** Every `Text(textScaleFactor: ...)` and `MediaQuery.textScaleFactorOf` is a `deprecated_member_use` info, and they hide the deprecations that need real work.

## What changes in the app

| Area | Change | Severity |
| --- | --- | --- |
| Capping text size via `copyWith(textScaleFactor: min(...))` | `dart fix` output flattens nonlinear scaling to linear; rewrite with `clamp` | high |
| `fontSize * textScaleFactor` arithmetic | Use `textScaler.scale(fontSize)`; results differ on Android 14+ | high |
| `Text` / `RichText` / `SelectableText` `textScaleFactor:` | Becomes `textScaler:`, manual edit (no `dart fix` rule) | low |
| `MediaQuery.textScaleFactorOf` / `maybeTextScaleFactorOf` | Become `textScalerOf` / `maybeTextScalerOf`, manual edit | low |
| `MediaQueryData(textScaleFactor:)` / `copyWith(textScaleFactor:)` | Become `textScaler: TextScaler.linear(x)`, applied by `dart fix` | low |
| `TextPainter(textScaleFactor:)` | `dart fix` only if the file imports `painting.dart` directly | low |
| Comparing scalers with `==` | `SystemTextScaler == noScaling` can be `true` while `noScaling == SystemTextScaler` is `false` | medium |

## Pre-flight checklist

- Flutter 3.16 or newer. `TextScaler`, `MediaQuery.withClampedTextScaling` and `MediaQuery.withNoTextScaling` all exist from that release; this post uses 3.44.8.
- A clean `git status`, so the `dart fix` changes show up as one reviewable diff.
- A list of places where you cap or disable text scaling. Search for `textScaleFactor` combined with `min(`, `clamp(` or `1.0`. These are the call sites that need judgment, not a rename.
- At least one physical Android 14+ device or emulator for the final check. Widget tests cannot reproduce the nonlinear curve (more on that below).

## Migration steps

1. **Inventory the deprecated members.** Run the analyzer and keep only the text scale hits:

    ```bash
    # Flutter 3.44.8
    flutter analyze 2>&1 | grep deprecated_member_use | grep -E "'textScaleFactor(Of)?'"
    ```

    This is the sample file used for every measurement in this post. It contains the six patterns I find in real apps:

    ```dart
    // Flutter 3.44.8, Dart 3.12.2 (before)
    import 'dart:math' as math;

    import 'package:flutter/material.dart';

    class CappedTextScale extends StatelessWidget {
      const CappedTextScale({super.key, required this.child});
      final Widget child;

      @override
      Widget build(BuildContext context) {
        final mq = MediaQuery.of(context);
        return MediaQuery(
          data: mq.copyWith(textScaleFactor: math.min(mq.textScaleFactor, 1.3)),
          child: child,
        );
      }
    }

    class NoScaleBadge extends StatelessWidget {
      const NoScaleBadge({super.key});

      @override
      Widget build(BuildContext context) {
        return MediaQuery(
          data: MediaQuery.of(context).copyWith(textScaleFactor: 1.0),
          child: const Text('NEW'),
        );
      }
    }

    class Price extends StatelessWidget {
      const Price({super.key});

      @override
      Widget build(BuildContext context) {
        return Text('9.99', textScaleFactor: MediaQuery.textScaleFactorOf(context));
      }
    }

    double rowHeight(BuildContext context) {
      const fontSize = 14.0;
      return fontSize * MediaQuery.textScaleFactorOf(context) + 16;
    }

    Size measure(String s, BuildContext context) {
      final painter = TextPainter(
        text: TextSpan(text: s, style: const TextStyle(fontSize: 14)),
        textDirection: TextDirection.ltr,
        textScaleFactor: MediaQuery.of(context).textScaleFactor,
      )..layout();
      return painter.size;
    }

    const testData = MediaQueryData(textScaleFactor: 2.0);
    ```

    `flutter analyze` reports 9 `deprecated_member_use` infos on it.

    Verify: you have a number to drive to zero, and you know which hits are inside cap or no-scale logic.

2. **Run dart fix, then read every change it made.** The data-driven fixes for this deprecation live in `fix_media_query.yaml` and `fix_painting.yaml`:

    ```bash
    # Flutter 3.44.8
    dart fix --dry-run .
    dart fix --apply .
    ```

    On the sample, `dart fix` reports `3 fixes made in 1 file` and leaves 6 infos behind. The three rewrites:

    ```dart
    // Flutter 3.44.8, output of dart fix --apply
    data: mq.copyWith(textScaler: TextScaler.linear(math.min(mq.textScaleFactor, 1.3))),
    // ...
    data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(1.0)),
    // ...
    const testData = MediaQueryData(textScaler: TextScaler.linear(2.0));
    ```

    The second and third are fine. The first compiles, removes one diagnostic, and is a regression: it still reads the deprecated scalar and turns it into a linear scaler, so Android 14's curve is gone for the whole subtree. Step 3 fixes it. `Text(textScaleFactor:)`, `MediaQuery.textScaleFactorOf` and the `TextPainter` in this file were not touched at all.

    Verify: `git diff` shows only `MediaQueryData` and `copyWith` changes, and you have flagged every `TextScaler.linear(` that wraps a `textScaleFactor` read.

3. **Rewrite caps and opt-outs with clamp and the MediaQuery helpers.** Replace the flattened cap with a clamp of the existing scaler, which keeps the system's curve and only limits it:

    ```dart
    // Flutter 3.44.8 (after)
    class CappedTextScale extends StatelessWidget {
      const CappedTextScale({super.key, required this.child});
      final Widget child;

      @override
      Widget build(BuildContext context) {
        return MediaQuery.withClampedTextScaling(
          maxScaleFactor: 1.3,
          child: child,
        );
      }
    }

    class NoScaleBadge extends StatelessWidget {
      const NoScaleBadge({super.key});

      @override
      Widget build(BuildContext context) {
        return MediaQuery.withNoTextScaling(child: const Text('NEW'));
      }
    }
    ```

    `withClampedTextScaling` is a `Builder` that calls `MediaQuery.of(context).textScaler.clamp(...)` and inserts a new `MediaQuery`. If you need the scaler itself rather than a widget (to pass to a single `Text`, say), call `MediaQuery.textScalerOf(context).clamp(maxScaleFactor: 1.3)` directly. A clamped scaler limits each size to the range `[min * fontSize, max * fontSize]`, so it never makes text larger than the system would.

    Verify: no `TextScaler.linear(` in the codebase takes a `textScaleFactor` read as its argument. `grep -rn "TextScaler.linear(.*textScaleFactor" lib` returns nothing.

4. **Rename the widget parameters and lookups by hand.** These have no data-driven fix, but the change is a rename:

    ```dart
    // Flutter 3.44.8 (after)
    class Price extends StatelessWidget {
      const Price({super.key});

      @override
      Widget build(BuildContext context) {
        return Text('9.99', textScaler: MediaQuery.textScalerOf(context));
      }
    }
    ```

    The same applies to `RichText`, `Text.rich`, `SelectableText`, `SelectableText.rich` and `EditableText`. Note that `Text` already reads `MediaQuery.textScalerOf(context)` when you pass nothing, so a `Text` that only forwarded the ambient value can drop the argument entirely. Do not pass both `textScaleFactor` and `textScaler` during a half-finished edit. `Text` silently prefers `textScaler`, while `SelectableText` asserts whenever both are set, and `RichText` and `TextPainter` assert whenever `textScaleFactor` is anything other than 1.0 next to an explicit `textScaler`.

    Verify: `flutter analyze` shows no `textScaleFactorOf` hits.

5. **Replace multiplication with scale().** Anywhere you compute a size from a font size, ask the scaler:

    ```dart
    // Flutter 3.44.8 (after)
    double rowHeight(BuildContext context) {
      const fontSize = 14.0;
      return MediaQuery.textScalerOf(context).scale(fontSize) + 16;
    }

    Size measure(String s, BuildContext context) {
      final painter = TextPainter(
        text: TextSpan(text: s, style: const TextStyle(fontSize: 14)),
        textDirection: TextDirection.ltr,
        textScaler: MediaQuery.textScalerOf(context),
      )..layout();
      return painter.size;
    }
    ```

    The `scale()` result only matches what `Text` renders if you pass the same font size the `TextStyle` uses. Code that did `iconSize = 24 * textScaleFactor` to keep an icon proportional to a 14sp label should now call `scale(14)` and derive the icon from that, not `scale(24)`, because the curve treats 14 and 24 differently.

    Verify: `flutter analyze` reports zero text scale deprecations, and `grep -rn "textScaleFactor" lib test` only matches comments or intentional `ignore` lines.

## Verification

```bash
# Flutter 3.44.8
flutter analyze
flutter test
dart fix --dry-run .
```

`flutter analyze` should report no `textScaleFactor` diagnostics, `flutter test` should be green, and `dart fix --dry-run` should print `Nothing to fix!` for these rules. Then run the app on an Android 14+ device or emulator, set Settings > Display > Font size to the maximum, and check three things: screens with a text-scale cap still grow body text up to the cap, headlines grow less than body text (that is the nonlinear curve working), and any layout that sized itself from `scale()` lines up with the text it surrounds. On iOS and older Android versions the system scaler is linear, so the app should look exactly as it did before the migration.

## Rolling back

The migration is a set of source edits, so `git revert` restores the old behavior. The deprecated parameters and getters still exist in 3.44.8 and still work: `MediaQueryData.textScaler` treats an explicit `textScaleFactor` as "this caller is unmigrated" and wraps it in `TextScaler.linear`. What you cannot roll back to is a release where #128825 has landed. If you must keep one deprecated call for now, suppress it on that line with `// ignore: deprecated_member_use`, not with a project-wide analyzer exclusion.

## Gotchas from a real migration

The numbers below come from a probe test run with `flutter test` on Flutter 3.44.8. To make Android 14's curve observable in a test, I used a stand-in `TextScaler` built from the 2.0x lookup table in AOSP's `FontScaleConverterFactory` (from `{8, 10, 12, 14, 18, 20, 24, 30, 100}` sp to `{16, 20, 24, 26, 30, 34, 36, 38, 100}` sp, interpolated between points). The real curve comes from the device, but the table is the same one Android uses.

```dart
// Flutter 3.44.8, Dart 3.12.2
class Android2xScaler extends TextScaler {
  const Android2xScaler();
  static const _from = [8.0, 10, 12, 14, 18, 20, 24, 30, 100];
  static const _to = [16.0, 20, 24, 26, 30, 34, 36, 38, 100];

  @override
  double scale(double fontSize) {
    if (fontSize <= _from.first) return fontSize * 2;
    for (var i = 1; i < _from.length; i++) {
      if (fontSize <= _from[i]) {
        final t = (fontSize - _from[i - 1]) / (_from[i] - _from[i - 1]);
        return _to[i - 1] + (_to[i] - _to[i - 1]) * t;
      }
    }
    return fontSize;
  }

  @override
  // ignore: deprecated_member_use
  double get textScaleFactor => 2.0;
}
```

### Multiplying by the factor overshoots large text badly

| Font size | `size * textScaleFactor` | `scale(size)` |
| --- | --- | --- |
| 12 | 24.0 | 24.0 |
| 14 | 28.0 | 26.0 |
| 16 | 32.0 | 28.0 |
| 22 | 44.0 | 35.0 |
| 30 | 60.0 | 38.0 |
| 57 | 114.0 | 61.9 |

Small text agrees, which is why this bug survives casual testing. A 57sp display style ends up almost twice as tall in your computed layout as it is on screen. Rendering through a `MediaQuery` with this scaler confirmed it: a 14sp `Text` measured 26.0 px tall and a 30sp `Text` measured 38.0 px.

### The dart fix cap and a clamp disagree above the curve's knee

Capping at 1.3 with the flattened `TextScaler.linear(min(textScaleFactor, 1.3))` from step 2, versus `scaler.clamp(maxScaleFactor: 1.3)` from step 3:

| Font size | flattened | clamped |
| --- | --- | --- |
| 12 | 15.6 | 15.6 |
| 14 | 18.2 | 18.2 |
| 22 | 28.6 | 28.6 |
| 30 | 39.0 | 38.0 |
| 57 | 74.1 | 61.9 |

The flattened version makes large text bigger than the system itself would render it without any cap. The clamp never exceeds what the system asks for.

### Equality between scalers is asymmetric

```dart
// Flutter 3.44.8, inside a widget test at the default text scale
final sys = MediaQuery.textScalerOf(context); // SystemTextScaler (no scaling)
print(sys == TextScaler.noScaling); // true
print(TextScaler.noScaling == sys); // false
```

`SystemTextScaler.==` treats `noScaling` as equal when the platform factor is 1.0, but the linear scaler's `==` only accepts other linear scalers. Code like `if (TextScaler.noScaling == MediaQuery.textScalerOf(context))` to detect "the user has not changed font size" is always false. Write the comparison with the system scaler on the left, or compare `scale(14) == 14`. On the bright side, `TextScaler.linear(1.0) == TextScaler.noScaling` is `true`, so the `TextScaler.linear(1.0)` that `dart fix` emits behaves exactly like `noScaling`.

### Widget tests cannot reproduce nonlinear scaling

`tester.platformDispatcher.textScaleFactorTestValue = 3.0` still works and is not deprecated, but the test dispatcher implements `scaleFontSize` as plain multiplication. In the probe, the system scaler under that test value returned `scale(14) == 42.0` and `scale(30) == 90.0`. Inside `MediaQuery.withClampedTextScaling(maxScaleFactor: 1.5)` it returned `21.0` for 14sp, as expected. To test layouts under the nonlinear curve, inject a custom scaler like the one above with `MediaQuery(data: MediaQuery.of(context).copyWith(textScaler: ...))`, for example from `MaterialApp.builder`.

### Passing both parameters is an assertion, not a precedence rule

`MediaQueryData(textScaleFactor: 2.0, textScaler: ...)` and `copyWith(textScaleFactor: 2.0, textScaler: ...)` both throw an `AssertionError` in debug builds. In release builds the assert is stripped and `textScaler` wins. A half-migrated helper that forwards both arguments works in production and crashes in your debug session, which is at least loud.

### clamp with equal bounds returns a linear scaler

`scaler.clamp(minScaleFactor: 1, maxScaleFactor: 1)` returns `TextScaler.linear(1.0)` (printed as `no scaling`), and `TextScaler.linear(3.0).clamp(maxScaleFactor: 1.3)` returns `linear (1.3x)`. Chained clamps keep the tighter bound: `clamp(maxScaleFactor: 1.3).clamp(maxScaleFactor: 1.5).scale(30)` is still `38.0` with the 2.0x stand-in. That makes it safe to clamp in nested widgets without the outer cap being widened.

### TextPainter fixes depend on your imports

The `TextPainter` rule in `fix_painting.yaml` declares `uris: ['painting.dart']`. In a file that imports `package:flutter/material.dart`, `dart fix` skipped `TextPainter(textScaleFactor: ...)`. The same constructor in a file that imports `package:flutter/painting.dart` was rewritten to `textScaler: TextScaler.linear(factor)`. Either way, if the argument came from `MediaQuery`, change it to `MediaQuery.textScalerOf(context)` rather than wrapping a scalar.

## Related

- The `dart fix` mechanics in step 2, including dry runs and why the exit code is not useful in CI, are covered in [running dart fix across a whole repo](/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/).
- Large text scales are the most common source of overflow stripes; [fixing "A RenderFlex overflowed"](/2026/05/fix-renderflex-overflowed-in-flutter/) shows how to reproduce them with a `TextScaler` in a test.
- Text scaling inside a WebView has its own failure mode: [Flutter text rendering off screen in an Android WebView with font scaling](/2026/09/fix-flutter-text-renders-off-screen-in-an-android-webview-with-font-scaling/).
- Two other deprecations that clean up the same `deprecated_member_use` backlog: [Color.withOpacity to Color.withValues](/2026/10/migrate-a-flutter-app-from-color-withopacity-to-color-withvalues/) and [MaterialStateProperty to WidgetStateProperty](/2026/10/migrate-a-flutter-app-from-materialstateproperty-to-widgetstateproperty/).

## Sources

- [Deprecate textScaleFactor in favor of TextScaler](https://docs.flutter.dev/release/breaking-changes/deprecate-textscalefactor) (docs.flutter.dev)
- [`TextScaler`](https://api.flutter.dev/flutter/painting/TextScaler-class.html), [`MediaQuery.withClampedTextScaling`](https://api.flutter.dev/flutter/widgets/MediaQuery/withClampedTextScaling.html) and [`MediaQuery.withNoTextScaling`](https://api.flutter.dev/flutter/widgets/MediaQuery/withNoTextScaling.html) (api.flutter.dev)
- [flutter/flutter#128522](https://github.com/flutter/flutter/pull/128522), the PR that introduced `TextScaler` and the data-driven fixes, and [flutter/flutter#128825](https://github.com/flutter/flutter/issues/128825), which tracks removing `textScaleFactor`
- [`fix_media_query.yaml`](https://github.com/flutter/flutter/blob/master/packages/flutter/lib/fix_data/fix_widgets/fix_media_query.yaml) and [`fix_painting.yaml`](https://github.com/flutter/flutter/blob/master/packages/flutter/lib/fix_data/fix_painting.yaml) (flutter/flutter)
- [`FontScaleConverterFactory.java`](https://github.com/aosp-mirror/platform_frameworks_base/blob/main/core/java/android/content/res/FontScaleConverterFactory.java), the nonlinear font scale tables (AOSP)
