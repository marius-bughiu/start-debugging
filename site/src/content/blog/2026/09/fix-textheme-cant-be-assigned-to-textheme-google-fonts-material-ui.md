---
title: "Fix: The argument type 'TextTheme' can't be assigned to the parameter type 'TextTheme?' with google_fonts"
description: "Your app imports material_ui but google_fonts 8.2.1 still returns the SDK TextTheme. Build the TextTheme yourself from GoogleFonts.roboto tear-offs until google_fonts migrates."
pubDate: 2026-09-11
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "material-design"
  - "google-fonts"
---

You have two different classes named `TextTheme` in one program. Your app imports `package:material_ui/material_ui.dart`, so `ThemeData.textTheme` expects the `material_ui` copy of `TextTheme`. `google_fonts` 8.2.1, the latest release, still imports `package:flutter/material.dart`, so `GoogleFonts.robotoTextTheme()` returns the SDK copy. Dart treats them as unrelated types. The fix that works today: stop calling the `...TextTheme()` helpers and apply the font per style with a `GoogleFonts.roboto` tear-off, which returns a `TextStyle`, a type both copies share. `MaterialUiCompatibilityBridge` cannot fix this, because it is a compile-time error.

Everything below was reproduced on Flutter 3.44.8 (Dart 3.12.2) with `material_ui` 1.2.0, `cupertino_ui` 1.0.2 and `google_fonts` 8.2.1, and checked against the `google_fonts` source on the `flutter/packages` main branch as of September 11, 2026. The same error reproduces on the 3.47 stable line and on master, because the mismatch is in the package, not the SDK.

## What the analyzer and the compiler print

`flutter analyze` and the IDE give you the short form, which looks like nonsense because the two type names are identical:

```text
error • The argument type 'TextTheme' can't be assigned to the parameter type 'TextTheme?'.  • lib/main.dart:13:20 • argument_type_not_assignable
```

The front end compiler, which runs on `flutter run`, `flutter build` and `flutter test`, is more helpful. It numbers the two types and tells you where each one lives:

```text
lib/main.dart:13:47: Error: The argument type 'TextTheme/*1*/' can't be assigned to the parameter type 'TextTheme/*2*/?'.
 - 'TextTheme/*1*/' is from 'package:flutter/src/material/text_theme.dart' ('/opt/homebrew/share/flutter/packages/flutter/lib/src/material/text_theme.dart').
 - 'TextTheme/*2*/' is from 'package:material_ui/src/text_theme.dart' ('/Users/marius/.pub-cache/hosted/pub.dev/material_ui-1.2.0/lib/src/text_theme.dart').
        textTheme: GoogleFonts.robotoTextTheme(),
                                              ^
```

That second message is the diagnosis. If yours names `package:flutter/src/material/...` and `package:material_ui/src/...`, you are in the right place. If it names two other libraries, skip to the lookalikes section at the end.

## Why two TextTheme classes exist

Since Flutter 3.44, Material and Cupertino have been shipped as the standalone `material_ui` and `cupertino_ui` packages. `material_ui` 1.0.0, published on August 12, 2026, is a copy of the Material library that was frozen in the SDK in April. It is not a re-export. `material_ui/lib/src/text_theme.dart` declares its own `class TextTheme`, just as it declares its own `ThemeData`, `Theme` and `ColorScheme`.

Dart type identity comes from the declaring library, not from the name. `package:flutter/src/material/text_theme.dart`'s `TextTheme` and `package:material_ui/src/text_theme.dart`'s `TextTheme` have the same fields and the same code, but neither is a subtype of the other, so neither is assignable to the other.

`google_fonts` 8.2.1 was published on July 31, 2026, before `material_ui` reached 1.0. Its `lib/src/google_fonts_all_parts.dart` still has:

```dart
// google_fonts 8.2.1, lib/src/google_fonts_all_parts.dart
import 'package:flutter/material.dart';
```

and every generated `...TextTheme` helper is built on that import:

```dart
// google_fonts 8.2.1, lib/src/google_fonts_parts/part_r.dart (trimmed)
static TextTheme robotoTextTheme([TextTheme? textTheme]) {
  textTheme ??= ThemeData.light().textTheme;
  return TextTheme(
    displayLarge: roboto(textStyle: textTheme.displayLarge),
    // ...14 more styles
  );
}
```

Both the parameter and the return type are the SDK `TextTheme`. Once your file imports `material_ui` instead of `package:flutter/material.dart`, which is exactly what `dart fix --apply --code=migrate_design_widgets` does, every `GoogleFonts.xxxTextTheme()` call site stops compiling. This is tracked as [flutter/flutter#191067](https://github.com/flutter/flutter/issues/191067), opened the day after `material_ui` 1.0.0 shipped.

## Minimal repro

```yaml
# pubspec.yaml, Flutter 3.44.8
dependencies:
  flutter:
    sdk: flutter
  google_fonts: ^8.2.1
  material_ui: ^1.2.0
```

```dart
// Flutter 3.44.8, material_ui 1.2.0, google_fonts 8.2.1
import 'package:google_fonts/google_fonts.dart';
import 'package:material_ui/material_ui.dart';

void main() => runApp(const App());

class App extends StatelessWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      theme: ThemeData(
        textTheme: GoogleFonts.robotoTextTheme(), // error here
      ),
      home: const Scaffold(body: Center(child: Text('Hello'))),
    );
  }
}
```

Swap the import back to `package:flutter/material.dart` and it compiles, which is why so many reports of this error say "previously working".

## Why MaterialUiCompatibilityBridge does not help

The bridge that `material_ui` 0.0.3 added is the first thing people try, and it was the first suggestion a maintainer made on #191067 too. It does not fix this error, and it cannot. The bridge is a widget. It inserts the legacy `Theme` and `Localizations` inherited widgets into the tree so that an un-migrated package calling `Theme.of(context)` at runtime finds something. That covers dependencies that *read* Material state from `BuildContext`.

`google_fonts` does not read anything from the tree. It *returns* an SDK Material type from its public API, and that value flows into your code as an argument, which the type checker rejects before any widget exists. [flutter/flutter#191448](https://github.com/flutter/flutter/issues/191448) documents this limit in general terms and lists the `google_fonts` case as the first-party example. If you cannot compile, no widget wrapper is involved.

## Fix 1: apply the font per style with a tear-off (recommended)

`TextStyle` is declared in `package:flutter/painting.dart`, which is part of the SDK and is shared by both copies of Material. `GoogleFonts.roboto(...)` returns a `TextStyle`. So the only piece you have to replace is the fifteen-line loop the `...TextTheme` helper does for you, and you can write it against the `material_ui` `TextTheme`:

```dart
// lib/theme/google_text_theme.dart
// Flutter 3.44.8, Dart 3.12.2, material_ui 1.2.0, google_fonts 8.2.1
import 'package:google_fonts/google_fonts.dart';
import 'package:material_ui/material_ui.dart';

/// Applies a Google Font to every style of a material_ui [TextTheme].
///
/// Pass a tear-off such as `GoogleFonts.roboto`. Only [TextStyle] crosses
/// the package boundary, and TextStyle lives in package:flutter/painting.dart,
/// which both copies of Material share.
TextTheme withGoogleFont(
  TextTheme base,
  TextStyle Function({TextStyle? textStyle}) font,
) {
  TextStyle? apply(TextStyle? style) =>
      style == null ? null : font(textStyle: style);

  return base.copyWith(
    displayLarge: apply(base.displayLarge),
    displayMedium: apply(base.displayMedium),
    displaySmall: apply(base.displaySmall),
    headlineLarge: apply(base.headlineLarge),
    headlineMedium: apply(base.headlineMedium),
    headlineSmall: apply(base.headlineSmall),
    titleLarge: apply(base.titleLarge),
    titleMedium: apply(base.titleMedium),
    titleSmall: apply(base.titleSmall),
    bodyLarge: apply(base.bodyLarge),
    bodyMedium: apply(base.bodyMedium),
    bodySmall: apply(base.bodySmall),
    labelLarge: apply(base.labelLarge),
    labelMedium: apply(base.labelMedium),
    labelSmall: apply(base.labelSmall),
  );
}
```

The `font` parameter type is the trick that keeps call sites short. Every generated font method has the signature `TextStyle Function({TextStyle? textStyle, Color? color, double? fontSize, ...})`. A function type with more optional named parameters is a subtype of one with fewer, so `GoogleFonts.roboto`, `GoogleFonts.lato` or `GoogleFonts.pangolin` can be passed straight in.

Then build the theme first and replace its text theme:

```dart
// lib/main.dart
// Flutter 3.44.8, Dart 3.12.2, material_ui 1.2.0, google_fonts 8.2.1
import 'package:google_fonts/google_fonts.dart';
import 'package:material_ui/material_ui.dart';

import 'theme/google_text_theme.dart';

ThemeData buildTheme(Brightness brightness) {
  final base = ThemeData(
    brightness: brightness,
    colorSchemeSeed: Colors.indigo,
  );
  return base.copyWith(
    textTheme: withGoogleFont(base.textTheme, GoogleFonts.roboto),
  );
}

class App extends StatelessWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      theme: buildTheme(Brightness.light),
      darkTheme: buildTheme(Brightness.dark),
      home: const Scaffold(body: Center(child: Text('Hello'))),
    );
  }
}
```

`flutter analyze` is clean with this, and a widget test confirms the output matches what `GoogleFonts.robotoTextTheme()` used to produce: every style gets `fontFamily: 'Roboto_regular'` with `fontFamilyFallback: ['Roboto']`, which is how `google_fonts` names a loaded variant.

This version is also better than the call it replaces in one respect. `robotoTextTheme()` with no argument starts from `ThemeData.light().textTheme`, so if you reused it in `darkTheme` without passing `ThemeData.dark().textTheme`, you got dark text on a dark surface. Deriving from `base.textTheme` per brightness gets the colors right by construction. In the test above, light `bodyMedium` resolves to a near-black `Color(0xFF1B1B21)` and dark `bodyMedium` to a near-white `Color(0xFFE4E1E9)`.

When the migration lands upstream, deleting this file and going back to `GoogleFonts.robotoTextTheme(base.textTheme)` is a one-line change per theme.

### When the family name is only known at runtime

If users pick a font on a settings screen, you were probably calling `GoogleFonts.getTextTheme(name)`, which has the same problem. Wrap `getFont`, which returns a `TextStyle`:

```dart
// Flutter 3.44.8, material_ui 1.2.0, google_fonts 8.2.1
TextTheme withGoogleFontNamed(TextTheme base, String family) =>
    withGoogleFont(
      base,
      ({TextStyle? textStyle}) =>
          GoogleFonts.getFont(family, textStyle: textStyle),
    );
```

Know what this costs. `getFont` looks the family up in `GoogleFonts.asMap()`, a const map that references every generated font method, so the compiler can no longer tree-shake the unused ones. The direct tear-off in Fix 1 references one font. That size gap is what the `google_fonts_lite.dart` entry point in [flutter/packages#11433](https://github.com/flutter/packages/pull/11433) targets; it merged on September 4, 2026 but has not been published yet. Use `getFont` only if you really need a runtime name.

## Fix 2: convert an existing legacy TextTheme at the boundary

If the SDK `TextTheme` reaches you from somewhere you do not control, for example a shared theme package you cannot change this week, convert it field by field. Import the legacy library with a prefix and a `show` clause so it cannot leak any other name into the file:

```dart
// lib/theme/legacy_adapter.dart
// Flutter 3.44.8, Dart 3.12.2, material_ui 1.2.0, google_fonts 8.2.1
// Temporary: delete once google_fonts ships a material_ui release.
import 'package:flutter/material.dart' as legacy show TextTheme;
import 'package:material_ui/material_ui.dart';

extension LegacyTextThemeToMaterialUi on legacy.TextTheme {
  TextTheme toMaterialUi() => TextTheme(
        displayLarge: displayLarge,
        displayMedium: displayMedium,
        displaySmall: displaySmall,
        headlineLarge: headlineLarge,
        headlineMedium: headlineMedium,
        headlineSmall: headlineSmall,
        titleLarge: titleLarge,
        titleMedium: titleMedium,
        titleSmall: titleSmall,
        bodyLarge: bodyLarge,
        bodyMedium: bodyMedium,
        bodySmall: bodySmall,
        labelLarge: labelLarge,
        labelMedium: labelMedium,
        labelSmall: labelSmall,
      );
}
```

```dart
// Flutter 3.44.8, material_ui 1.2.0, google_fonts 8.2.1
final theme = ThemeData(
  textTheme: GoogleFonts.pangolinTextTheme().toMaterialUi(),
);
```

This compiles because each field is a `TextStyle`. It works for `TextTheme` specifically because the class is a plain bag of fifteen styles. It does not generalize: #191448 shows that the same adapter trick fails one level deeper for types like `FloatingActionButtonLocation`, whose methods take other Material types as arguments. It also keeps the light-only default described above, and it reintroduces the SDK Material import that the migration was meant to remove, so keep it in one file with a comment, and prefer Fix 1.

## Fix 3: wait for the google_fonts migration

Two pull requests migrate `google_fonts` itself: [flutter/packages#12489](https://github.com/flutter/packages/pull/12489), opened on August 17 and linked to #191067, and [flutter/packages#12810](https://github.com/flutter/packages/pull/12810), opened on September 9 as part of the ecosystem-wide [flutter/flutter#191322](https://github.com/flutter/flutter/issues/191322). The second one also raises the package's minimum to Flutter 3.44 and Dart 3.12. Neither had merged as of September 11, 2026. When one does, the `...TextTheme` helpers will take and return the `material_ui` type and the original one-liner will compile again. Watch the [google_fonts changelog](https://pub.dev/packages/google_fonts/changelog).

Two ways to wait that I would not recommend for a shipping app:

- **Revert the import in the theme file only.** That does not work. The `ThemeData` in that file becomes the SDK `ThemeData`, and your `material_ui` `MaterialApp` rejects it with the same error, just one type up. The whole app has to be on one side.
- **A `dependency_overrides` git reference to an open PR branch.** It compiles, and one commenter on #191067 offers exactly that. But you are shipping unreviewed code from a fork. If you do it anyway, pin `ref:` to a commit SHA, not a branch.

If you cannot use Fix 1 for some reason, the honest alternative is to postpone the `material_ui` migration until `google_fonts` ships. The in-SDK Material library is frozen, but it still works on 3.47.

## Gotcha: the weight is not in the theme yet

Something the `...TextTheme` helpers always did and that Fix 1 inherits: `ThemeData.textTheme` holds only colors and families at build time. The sizes and weights come from `Typography.englishLike` and are merged in later, when `Theme.of` localizes the theme. So when `google_fonts` sees `titleMedium`, the weight is `null`, it picks the regular variant, and the style gets `fontFamily: 'Roboto_regular'`. At runtime, `Theme.of(context).textTheme.titleMedium` resolves to `Roboto_regular` with `FontWeight.w500`, which means the engine renders a weight-500 style from the weight-400 file.

If your titles and labels need the real medium file, merge the geometry in before applying the font:

```dart
// Flutter 3.44.8, material_ui 1.2.0, google_fonts 8.2.1
final geometry = Typography.material2021().englishLike.merge(base.textTheme);
final textTheme = withGoogleFont(geometry, GoogleFonts.roboto);
// titleMedium -> fontFamily 'Roboto_500', fontWeight w500
```

I verified both results in a widget test. The trade-off: the English-like sizes are now baked in, so if you ship Chinese, Japanese or Korean, pick the geometry per locale (`Typography.material2021().tall` or `.dense`) instead. The same reasoning is why `TextTheme.apply(fontFamily: GoogleFonts.roboto().fontFamily)` is a trap: it sets `'Roboto_regular'` on every style, whatever its weight.

## Lookalikes that are not this bug

- **`The argument type 'TextTheme' can't be assigned to the parameter type 'CupertinoTextThemeData'`.** You passed a Material text theme to `CupertinoThemeData.textTheme`. Those are different classes by design, reported back in 2022 as [material-foundation/flutter-packages#227](https://github.com/material-foundation/flutter-packages/issues/227). There is no `...TextTheme` helper for Cupertino; build a `CupertinoTextThemeData` yourself and pass `GoogleFonts.lato()` style objects to its `textStyle` and related parameters.
- **Same message, but the compiler names one of your own files.** A class called `TextTheme` in your own code or in a generated design-token file shadows the Material one. The numbered compiler output tells you which file to rename.
- **Same message for `ColorScheme`.** That was `dynamic_color`, which returned the SDK `ColorScheme` from `DynamicColorBuilder`. It is fixed: `dynamic_color` 2.1.0 depends on `material_ui`, as the maintainer confirmed in [material-foundation/flutter-packages#698](https://github.com/material-foundation/flutter-packages/issues/698).
- **It compiles, but a package's widgets crash with "Could not find an ancestor of type Theme".** That is the runtime half of the same split, and it is the case `MaterialUiCompatibilityBridge` does fix.

## Related

- The full migration this error falls out of, including when you need the compatibility bridge, is in [migrating Flutter Material and Cupertino imports to material_ui and cupertino_ui](/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/).
- For the background on why Material left the SDK in the first place, see [Flutter 3.44 splits Material and Cupertino out of the SDK](/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/).
- If you ran the import rewrite across a monorepo, [running dart fix across a whole repo](/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/) covers how to scope and review it package by package.
- The same `ThemeData`-first approach used in Fix 1 applies to colors too: [setting the accent color with a Material 3 ColorScheme](/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/).
- For an ancestor-lookup failure from your own code rather than a dependency, read [fixing "No Material widget found" in Flutter](/2026/08/fix-no-material-widget-found-in-flutter/).

## Sources

- [flutter/flutter#191067](https://github.com/flutter/flutter/issues/191067), material_ui `TextTheme` conflict with `google_fonts`
- [flutter/flutter#191448](https://github.com/flutter/flutter/issues/191448), `MaterialUiCompatibilityBridge` cannot cover API-signature coupling
- [flutter/flutter#191322](https://github.com/flutter/flutter/issues/191322), migrate first-party packages to `material_ui` and `cupertino_ui`
- [flutter/packages#12489](https://github.com/flutter/packages/pull/12489) and [flutter/packages#12810](https://github.com/flutter/packages/pull/12810), the open `google_fonts` migration pull requests
- [flutter/packages#11433](https://github.com/flutter/packages/pull/11433), the `google_fonts_lite.dart` entry point
- [google_fonts on pub.dev](https://pub.dev/packages/google_fonts), version 8.2.1, and its [source](https://github.com/flutter/packages/tree/main/packages/google_fonts)
- [material_ui on pub.dev](https://pub.dev/packages/material_ui), version 1.2.0, and its [changelog](https://pub.dev/packages/material_ui/changelog)
- [argument_type_not_assignable](https://dart.dev/diagnostics/argument_type_not_assignable), Dart diagnostics
