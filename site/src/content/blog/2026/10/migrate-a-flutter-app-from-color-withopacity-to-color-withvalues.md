---
title: "Migrate a Flutter App from Color.withOpacity to Color.withValues (Flutter 3.27+)"
description: "Replace the deprecated Color.withOpacity, opacity, value, red, green, blue and alpha with withValues, .a/.r/.g/.b and toARGB32. What dart fix rewrites for you, the four getters it leaves behind, why exact color assertions and Map<Color, T> lookups break after the swap, and how withOpacity silently drops Display P3. Measured on Flutter 3.44.8 with Dart 3.12.2."
pubDate: 2026-10-23
updatedDate: 2026-10-23
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "colors"
---

`Color.withOpacity` has been deprecated since Flutter 3.27.0, when `dart:ui` started storing color components as floating-point values with a `ColorSpace`. The replacement is `color.withValues(alpha: x)`, and its siblings are `.a` for `.opacity`, `toARGB32()` for `.value`, and `.r`/`.g`/`.b` (doubles from 0.0 to 1.0) for `.red`/`.green`/`.blue` (ints from 0 to 255). `dart fix --apply` rewrites `withOpacity`, `opacity` and `value` for you, but it leaves `red`, `green`, `blue` and `alpha` to you. The swap is not purely cosmetic: `withOpacity(0.5)` stores an alpha of `0.50196` (128/255), while `withValues(alpha: 0.5)` stores exactly `0.5`, so those two colors are no longer `==`. Any test that does `expect(color, const Color(0x80000000))` or any `Map<Color, T>` keyed by the old value breaks after the migration. A typical app takes 30 minutes to an hour, most of it in tests. Everything below was run on Flutter 3.44.8 (Dart 3.12.2).

## Why move off withOpacity now

- **Precision.** `withOpacity` quantizes alpha to 8 bits: its body is literally `withAlpha((255.0 * opacity).round())`. `withValues` keeps the double you passed. For animations that fade through many small steps, that is the difference between 256 possible alpha levels and continuous ones.
- **Color spaces.** `withValues` preserves the receiver's `colorSpace`. `withOpacity` and `withAlpha` go through `Color.fromARGB`, which always builds an sRGB color, so a Display P3 color comes back tagged as sRGB. More on that in the gotchas.
- **The deprecations will become removals.** The Flutter migration guide describes the 8-bit API removal as "Phase 2", not landed yet. When it lands, every remaining `withOpacity`, `.value` and `.red` becomes a compile error instead of an `info` diagnostic.
- **Noise.** A large app can have hundreds of `deprecated_member_use` hits from these getters alone, which buries the deprecations you actually need to act on.

## What changes in the app

| Area | Change | Severity |
| --- | --- | --- |
| Tests using exact `Color` equality | `withValues(alpha: 0.5) != const Color(0x80000000)`; use `isSameColorAs` | high |
| `Map<Color, T>` / `Set<Color>` keys | Old and new colors hash differently; lookups return `null` | high |
| `.red`/`.green`/`.blue` arithmetic | Replacements are 0.0-1.0 doubles; integer thresholds like `< 128` silently break | high |
| `withOpacity(x)` call sites | Becomes `withValues(alpha: x)`, applied by `dart fix` | low |
| `.value` / `.opacity` | Become `toARGB32()` / `.a`, applied by `dart fix` | low |
| Classes that `implements Color` | Must implement `a`, `r`, `g`, `b`, `colorSpace`, `toARGB32`, `withValues` | medium |

## Pre-flight checklist

- Flutter 3.27.0 or newer, ideally current stable. `CupertinoDynamicColor.withValues` and its `dart fix` rule came later (deprecation messages say "deprecated after v3.33.0-1.0.pre"), so Cupertino-heavy apps should be on 3.35 or newer.
- A clean `git status`, so you can review `dart fix` output as one diff.
- A passing test suite before you start. Color equality failures are the main signal that something changed, and you want them to be the only failures.
- A list of places that persist colors (shared preferences, JSON, a database). Those are where integer conversions matter.

## Migration steps

1. **Inventory the deprecated members.** Run `flutter analyze` and filter for the color getters, so you know what `dart fix` will not touch:

    ```bash
    # Flutter 3.44.8
    flutter analyze 2>&1 | grep deprecated_member_use | grep -E "'(withOpacity|opacity|value|red|green|blue|alpha)'"
    ```

    On this sample file:

    ```dart
    // Flutter 3.44.8, Dart 3.12.2 (before)
    import 'package:flutter/material.dart';

    Color scrim(Color base) => base.withOpacity(0.54);

    bool isDark(Color c) => (c.red * 0.299 + c.green * 0.587 + c.blue * 0.114) < 128;

    int serialize(Color c) => c.value;

    double fade(Color c) => c.opacity;

    int alphaByte(Color c) => c.alpha;
    ```

    the analyzer reports seven `deprecated_member_use` infos, one per member, each carrying the suggested replacement, such as `'red' is deprecated and shouldn't be used. Use (*.r * 255.0).round().clamp(0, 255).`

    Verify: you have a count. Keep it, you will compare against it in step 3.

2. **Apply the data-driven fixes.** Flutter ships `fix_data` rules for exactly three `Color` members: `withOpacity` to `withValues(alpha: ...)`, `opacity` to `a`, and `value` to `toARGB32()`. Preview, then apply:

    ```bash
    # Flutter 3.44.8
    dart fix --dry-run .
    dart fix --apply .
    ```

    The dry run on the sample reports `deprecated_member_use - 3 fixes`, and the diff is:

    ```diff
    -Color scrim(Color base) => base.withOpacity(0.54);
    +Color scrim(Color base) => base.withValues(alpha: 0.54);
    -int serialize(Color c) => c.value;
    +int serialize(Color c) => c.toARGB32();
    -double fade(Color c) => c.opacity;
    +double fade(Color c) => c.a;
    ```

    The same rules exist for `CupertinoDynamicColor.withOpacity`. In a monorepo, run it once from the root; the analyzer picks up every nested `pubspec.yaml`.

    Verify: `flutter analyze` now reports four color deprecations instead of seven, all of them `red`, `green`, `blue` or `alpha`.

3. **Rewrite the integer getters by hand, keeping the scale.** This is where the real bugs come from. `.red` returns an `int` from 0 to 255; `.r` returns a `double` from 0.0 to 1.0. Swapping one for the other compiles fine because both are `num`, and then the comparison is wrong forever:

    ```dart
    // Flutter 3.44.8: compiles, always returns true
    bool isDark(Color c) => (c.r * 0.299 + c.g * 0.587 + c.b * 0.114) < 128;
    ```

    Either move the whole expression to the 0-1 scale, or convert explicitly where you genuinely need bytes:

    ```dart
    // Flutter 3.44.8, Dart 3.12.2 (after)
    bool isDark(Color c) => (c.r * 0.299 + c.g * 0.587 + c.b * 0.114) < 0.5;

    // Or, better for contrast decisions, the built-in WCAG luminance:
    bool isDarkWcag(Color c) => c.computeLuminance() < 0.179;

    extension ColorBytes on Color {
      int get alpha8 => (a * 255.0).round().clamp(0, 255);
      int get red8 => (r * 255.0).round().clamp(0, 255);
      int get green8 => (g * 255.0).round().clamp(0, 255);
      int get blue8 => (b * 255.0).round().clamp(0, 255);
    }

    int alphaByte(Color c) => c.alpha8;
    ```

    The extension uses the exact formula the deprecation message suggests, and it matches `toARGB32()`, which internally does `(x * 255.0).round().clamp(0, 255)` per channel. For `Colors.blue[500]` (`0xFF2196F3`), `.red` is `33` and `.r` is `0.12941176470588237`.

    Verify: `flutter analyze` reports zero color deprecations, and `grep -rnE '\.(red|green|blue)\b' lib/` shows nothing comparing a `.r`-style double against a byte-sized literal.

4. **Fix exact color assertions in tests.** Run the suite. Any test that compares a migrated color against an integer literal now fails, because the literal goes through the 8-bit constructor and gets alpha 128/255:

    ```dart
    // Flutter 3.44.8, flutter_test
    import 'package:flutter/material.dart';
    import 'package:flutter_test/flutter_test.dart';

    Color scrim() => Colors.black.withValues(alpha: 0.5);

    void main() {
      // Fails after the migration
      test('exact', () => expect(scrim(), const Color(0x80000000)));
      // Passes
      test('same color', () => expect(scrim(), isSameColorAs(const Color(0x80000000))));
    }
    ```

    The failing one prints:

    ```text
    Expected: Color:<Color(alpha: 0.5020, red: 0.0000, green: 0.0000, blue: 0.0000, colorSpace: ColorSpace.sRGB)>
      Actual: Color:<Color(alpha: 0.5000, red: 0.0000, green: 0.0000, blue: 0.0000, colorSpace: ColorSpace.sRGB)>
    ```

    `isSameColorAs` compares each component with a default threshold of `colorEpsilon = 0.004` (about one 8-bit step) and requires the same `colorSpace`. Use it everywhere a test compares colors produced by arithmetic. If you would rather keep the expectation exact, write it with the same constructor the code uses: `Colors.black.withValues(alpha: 0.5)`.

    Verify: `flutter test` is green, and the only test edits are matcher changes, not new expected values.

5. **Audit color-keyed collections and persisted values.** Search for `Map<Color`, `Set<Color>`, `switch` on colors, and anything that stores `toARGB32()`. Both directions of the round trip matter, and the next section shows the measured behavior.

    Verify: a unit test that saves and reloads a user-chosen color asserts with `isSameColorAs`, not `==`.

## Verification

After the steps above, run:

```bash
# Flutter 3.44.8
flutter analyze
flutter test
dart fix --dry-run .
```

`flutter analyze` should show no `deprecated_member_use` on `Color` members, `flutter test` should be green, and `dart fix --dry-run` should print `Nothing to fix!` for the color rules. Then launch the app and check the screens that use translucent overlays (scrims, disabled buttons, ripple and hover colors from your theme). Visually nothing should move: for any alpha you were passing to `withOpacity`, the `toARGB32()` of the old and the new color is identical (`0x80000000` for both at 0.5), so whatever gets quantized to 8 bits ends up the same.

## Rolling back

The migration is reversible: `withOpacity`, `.opacity`, `.value` and the integer getters still exist in 3.44.8 and keep their old semantics, so `git revert` on the migration commit restores exact behavior. What you cannot roll back to is a future Flutter release where Phase 2 has removed them. If you need to stay on the deprecated API for a while, suppress the diagnostic per file with `// ignore_for_file: deprecated_member_use` rather than globally, so other deprecations stay visible.

## Gotchas from a real migration

All of these come from one probe test run on Flutter 3.44.8. The numbers are printed output, not estimates.

### The old and new color are not equal, and do not hash equal

```dart
// Flutter 3.44.8
final o = Colors.black.withOpacity(0.5);
final v = Colors.black.withValues(alpha: 0.5);

print(o.a);                          // 0.5019607843137255
print(v.a);                          // 0.5
print(o == v);                       // false
print(o.toARGB32() == v.toARGB32()); // true (both 0x80000000)
print({o: 'x'}[v]);                  // null
```

`Color.==` compares `a`, `r`, `g`, `b` and `colorSpace` as doubles, and `hashCode` hashes the same fields. If half of a codebase is migrated and the other half is not, a color produced in one half will not find its entry in a map built by the other half. Migrate a lookup table and every call site that queries it in the same commit, or key the map by `toARGB32()`.

### Persisting with toARGB32 brings back the old color

```dart
// Flutter 3.44.8
final stored = v.toARGB32();
print(Color(stored) == v); // false
print(Color(stored) == o); // true
```

`toARGB32()` is lossy by design: it rounds each channel to a byte. A color restored with `Color(int)` gets `128/255` alpha, which is the `withOpacity` value, not the one you saved. That is fine for drawing and wrong for equality checks such as "is the saved accent still the selected one". If exact round-trips matter, store the four doubles and the color space name, and rebuild with `Color.from(alpha: ..., red: ..., green: ..., blue: ..., colorSpace: ...)`.

### `.a` is not `.opacity` with a new name

`dart fix` renames `opacity` to `a`, but the old getter was computed from the 8-bit alpha. For `Colors.black.withValues(alpha: 0.3)`, `.opacity` returns `0.30196078431372547` and `.a` returns `0.3`. Code that compared `opacity` against a literal like `0.30196` or used it as a map key changes behavior after the rename. It is rare, but it is the one `dart fix` change that is not semantically neutral.

### withOpacity silently converts Display P3 colors to sRGB

```dart
// Flutter 3.44.8
const p3 = Color.from(alpha: 1, red: 1, green: 0, blue: 0, colorSpace: ColorSpace.displayP3);

print(p3.withOpacity(0.5));
// Color(alpha: 0.5020, red: 1.0000, green: 0.0000, blue: 0.0000, colorSpace: ColorSpace.sRGB)
print(p3.withValues(alpha: 0.5));
// Color(alpha: 0.5000, red: 1.0000, green: 0.0000, blue: 0.0000, colorSpace: ColorSpace.displayP3)
```

The P3 red is outside sRGB (converted to extended sRGB it is `red: 1.0931, green: -0.2267, blue: -0.1501`), but `withOpacity` just relabels the same component values as sRGB, so the color gets visibly duller. `withAlpha(128)` does the same, and it is not deprecated, so it will not show up in the analyzer. If your app uses wide-gamut brand colors, grep for `withAlpha(` too and replace it with `withValues(alpha: n / 255)`.

### withValues does not validate the range

`Colors.black.withOpacity(1.5)` throws an `AssertionError` in debug builds. `Colors.black.withValues(alpha: 1.5)` succeeds and stores `a == 1.5`; `toARGB32()` clamps it to `0xff000000`, but equality and anything else reading `.a` sees `1.5`. If the alpha comes from arithmetic (an animation value times a factor, for example), clamp it yourself with `clampDouble(x, 0, 1)`. `Color.lerp` clamps its output, so tweens are safe.

### Classes that implement Color

The guide notes that Flutter intends to make `Color` `sealed` eventually. If you have a class that `implements Color` (some theming packages did this to wrap a dynamic color), it must now implement the float getters, `colorSpace`, `toARGB32` and `withValues`. The recommended direction is composition: hold a `Color` field and expose it, instead of pretending to be one. `CupertinoDynamicColor` itself is the reference implementation: every override forwards to `_effectiveColor`.

## Related

- The three mechanical rewrites in step 2 are standard data-driven fixes; [running dart fix across a whole repo](/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/) covers the flags, the cases where it reports "Nothing to fix" on a dirty repo, and why its exit code is useless in CI.
- Most `withOpacity` calls in apps live next to theme colors. If you are touching them anyway, [setting the accent color with a Material 3 ColorScheme](/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/) shows how to derive those translucent variants from the scheme instead of hand-tuning alphas.
- Custom design tokens are where `Color.lerp` and exact color comparisons meet; see [defining design tokens with ThemeExtension in Flutter](/2026/10/how-to-define-custom-design-tokens-with-themeextension-in-flutter/).
- Another deprecation that will turn into a compile error on a future upgrade: [migrating off describeEnum before Flutter removes it](/2026/09/migrate-off-describeenum-before-flutter-removes-it/).
- Wide-gamut color only reaches the screen on Impeller; for desktop targets, [migrating a Flutter Windows or Linux app to Impeller](/2026/10/migrate-a-flutter-windows-or-linux-desktop-app-to-impeller/) covers the renderer switch.

## Sources

- [Migration guide for wide gamut Color](https://docs.flutter.dev/release/breaking-changes/wide-gamut-framework) (docs.flutter.dev)
- [Migration guide for wide gamut CupertinoDynamicColor](https://docs.flutter.dev/release/breaking-changes/wide-gamut-cupertino-dynamic-color) (docs.flutter.dev)
- [`Color.withValues`](https://api.flutter.dev/flutter/dart-ui/Color/withValues.html) and [`Color.withOpacity`](https://api.flutter.dev/flutter/dart-ui/Color/withOpacity.html) (api.flutter.dev)
- [`isSameColorAs` matcher](https://api.flutter.dev/flutter/flutter_test/isSameColorAs.html) (api.flutter.dev)
- [flutter/flutter#127855: Implement wide gamut color support in the Framework](https://github.com/flutter/flutter/issues/127855) and [flutter/engine#54737: Framework wide color](https://github.com/flutter/engine/pull/54737)
- [`fix_dart_ui.yaml` data-driven fixes](https://github.com/flutter/flutter/blob/master/packages/flutter/lib/fix_data/fix_dart_ui.yaml) (flutter/flutter)
