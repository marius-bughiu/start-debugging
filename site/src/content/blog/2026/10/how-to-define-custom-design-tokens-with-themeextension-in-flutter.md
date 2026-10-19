---
title: "How to Define Custom Design Tokens with ThemeExtension and Animate Them Between Light and Dark Themes in Flutter"
description: "Subclass ThemeExtension, register one instance per ThemeData through the extensions list, read it with Theme.of(context).extension<T>(), and write a real lerp so MaterialApp's AnimatedTheme interpolates your tokens during a light/dark switch. Covers colors, radii, shadows, text styles and booleans, the missing-extension crash, the copyWith trap that drops every other extension, and why you need == and hashCode, all verified with widget tests on Flutter 3.44.8."
pubDate: 2026-10-19
template: how-to
tags:
  - "flutter"
  - "dart"
  - "theming"
  - "material-3"
  - "how-to"
---

**Short answer:** create an `@immutable` class that extends `ThemeExtension<AppTokens>`, give it the fields your design system needs (colors, radii, spacing, shadows, text styles), and implement `copyWith` and `lerp`. Put one instance in `ThemeData(extensions: [...])` for `theme` and another for `darkTheme`, then read it anywhere with `Theme.of(context).extension<AppTokens>()!`. `MaterialApp` already wraps your app in an `AnimatedTheme`, which calls `ThemeData.lerp` every frame during a theme change, and that calls your `lerp`. If your `lerp` interpolates each field with `Color.lerp`, `lerpDouble`, `BorderRadius.lerp` and friends, your custom tokens cross-fade between light and dark in exactly the same 200 ms as the built-in `ColorScheme`. Everything below was verified with widget tests on Flutter 3.44.8 (Dart 3.12.2).

The rest of this post covers what `ThemeExtension` actually is inside `ThemeData`, a complete token class with seven different field types, the wiring in `MaterialApp`, how to control the animation, and four gotchas I hit in tests: an extension that exists in only one theme, `copyWith` silently deleting your other extensions, an animation that restarts on every rebuild, and booleans that flip at exactly the halfway point.

## Why ColorScheme is not enough for design tokens

Material 3's `ColorScheme` has around 45 roles, and if you set your brand color through `ColorScheme.fromSeed` you get a coherent palette for free (see [how to set the accent color with a Material 3 ColorScheme](/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/)). But a real design system has tokens Material never thought of: a "success" green that is not `tertiary`, a raised card surface that differs from `surfaceContainerHigh` by a few percent, a code-block text style, a card radius, a shadow that exists in light mode and disappears in dark mode.

The usual workarounds are all bad. A global `AppColors` class with static constants cannot change with the brightness. A `context.isDark ? x : y` ternary sprinkled across widgets snaps instantly when the theme changes while the rest of the app animates, which looks broken. A custom `InheritedWidget` works but you have to rebuild the animation plumbing that `ThemeData` already has.

`ThemeExtension` was added to Flutter in 3.0 (PR #98033) to solve exactly this. It lets you hang your own typed objects off `ThemeData`, and because `ThemeData.lerp` knows about them, they take part in theme animations.

## What ThemeData does with your extension

The whole mechanism is small enough to read in one sitting. From `packages/flutter/lib/src/material/theme_data.dart` in Flutter 3.44.8:

```dart
// Flutter 3.44.8, theme_data.dart (abridged)
abstract class ThemeExtension<T extends ThemeExtension<T>> {
  const ThemeExtension();

  Object get type => T;

  ThemeExtension<T> copyWith();

  ThemeExtension<T> lerp(covariant ThemeExtension<T>? other, double t);
}

// On ThemeData:
final Map<Object, ThemeExtension<dynamic>> extensions;

T? extension<T>() => extensions[T] as T?;
```

Three facts fall out of this:

1. Extensions are stored in a `Map` keyed by `type`, which is the generic argument `T`. You can have at most one extension per type, and lookup is a map read.
2. `extension<T>()` returns `T?`. If the current theme has no entry for `T`, you get `null`, not an exception.
3. `lerp` is your responsibility. The framework never inspects your fields.

And here is how `ThemeData.lerp` combines the two maps:

```dart
// Flutter 3.44.8, ThemeData._lerpThemeExtensions
final Map<Object, ThemeExtension<dynamic>> newExtensions = a.extensions.map((
  Object id,
  ThemeExtension<dynamic> extensionA,
) {
  final ThemeExtension<dynamic>? extensionB = b.extensions[id];
  return MapEntry<Object, ThemeExtension<dynamic>>(id, extensionA.lerp(extensionB, t));
});
// Add [b]-only extensions.
newExtensions.addEntries(
  b.extensions.entries.where(
    (MapEntry<Object, ThemeExtension<dynamic>> entry) => !a.extensions.containsKey(entry.key),
  ),
);
```

Every extension in the "from" theme gets `lerp(matching, t)` called on it, where `matching` may be `null`. Extensions that only exist in the "to" theme are copied in without interpolation. Keep this in mind for the gotchas section.

## Step-by-step: building an animated token set

1. Define an `@immutable` subclass of `ThemeExtension<AppTokens>` with only non-nullable fields.
2. Implement `copyWith` so callers can override individual tokens.
3. Implement `lerp` with the matching `lerp` helper for every field type.
4. Override `==` and `hashCode` so equal token sets compare equal.
5. Register a light instance on `theme` and a dark instance on `darkTheme`.
6. Read the tokens through a `BuildContext` extension getter.

### Steps 1 to 4: the token class

```dart
// Flutter 3.44.8, Dart 3.12.2
import 'dart:ui' show lerpDouble;

import 'package:flutter/foundation.dart' show listEquals;
import 'package:flutter/material.dart';

@immutable
class AppTokens extends ThemeExtension<AppTokens> {
  const AppTokens({
    required this.surfaceRaised,
    required this.success,
    required this.cardRadius,
    required this.cardElevationShadow,
    required this.gap,
    required this.codeStyle,
    required this.useHairlineBorders,
  });

  final Color surfaceRaised;
  final Color success;
  final BorderRadius cardRadius;
  final List<BoxShadow> cardElevationShadow;
  final double gap;
  final TextStyle codeStyle;
  final bool useHairlineBorders;

  static const light = AppTokens(
    surfaceRaised: Color(0xFFFFFFFF),
    success: Color(0xFF1B873F),
    cardRadius: BorderRadius.all(Radius.circular(12)),
    cardElevationShadow: [
      BoxShadow(color: Color(0x1F000000), blurRadius: 12, offset: Offset(0, 4)),
    ],
    gap: 16,
    codeStyle: TextStyle(fontFamily: 'monospace', fontSize: 13, color: Color(0xFF24292F)),
    useHairlineBorders: false,
  );

  static const dark = AppTokens(
    surfaceRaised: Color(0xFF1E2228),
    success: Color(0xFF4ADE80),
    cardRadius: BorderRadius.all(Radius.circular(12)),
    cardElevationShadow: [
      BoxShadow(color: Color(0x00000000), blurRadius: 0, offset: Offset.zero),
    ],
    gap: 16,
    codeStyle: TextStyle(fontFamily: 'monospace', fontSize: 13, color: Color(0xFFE6EDF3)),
    useHairlineBorders: true,
  );

  @override
  AppTokens copyWith({
    Color? surfaceRaised,
    Color? success,
    BorderRadius? cardRadius,
    List<BoxShadow>? cardElevationShadow,
    double? gap,
    TextStyle? codeStyle,
    bool? useHairlineBorders,
  }) {
    return AppTokens(
      surfaceRaised: surfaceRaised ?? this.surfaceRaised,
      success: success ?? this.success,
      cardRadius: cardRadius ?? this.cardRadius,
      cardElevationShadow: cardElevationShadow ?? this.cardElevationShadow,
      gap: gap ?? this.gap,
      codeStyle: codeStyle ?? this.codeStyle,
      useHairlineBorders: useHairlineBorders ?? this.useHairlineBorders,
    );
  }

  @override
  AppTokens lerp(AppTokens? other, double t) {
    if (other is! AppTokens) return this;
    return AppTokens(
      surfaceRaised: Color.lerp(surfaceRaised, other.surfaceRaised, t)!,
      success: Color.lerp(success, other.success, t)!,
      cardRadius: BorderRadius.lerp(cardRadius, other.cardRadius, t)!,
      cardElevationShadow:
          BoxShadow.lerpList(cardElevationShadow, other.cardElevationShadow, t)!,
      gap: lerpDouble(gap, other.gap, t)!,
      codeStyle: TextStyle.lerp(codeStyle, other.codeStyle, t)!,
      useHairlineBorders: t < 0.5 ? useHairlineBorders : other.useHairlineBorders,
    );
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is AppTokens &&
          other.surfaceRaised == surfaceRaised &&
          other.success == success &&
          other.cardRadius == cardRadius &&
          listEquals(other.cardElevationShadow, cardElevationShadow) &&
          other.gap == gap &&
          other.codeStyle == codeStyle &&
          other.useHairlineBorders == useHairlineBorders;

  @override
  int get hashCode => Object.hash(
        surfaceRaised,
        success,
        cardRadius,
        Object.hashAll(cardElevationShadow),
        gap,
        codeStyle,
        useHairlineBorders,
      );
}
```

A few choices here are deliberate:

- **Non-nullable fields.** The official sample in the Flutter repo (`examples/api/lib/material/theme/theme_extension.1.dart`) uses `Color?`. That compiles, but every call site then needs `!` or a fallback, and `Color.lerp(null, x, t)` fades from transparent, which is rarely what you want. If a token always exists in your design system, make it required.
- **The `lerp` parameter type is `AppTokens?`, not `ThemeExtension<AppTokens>?`.** The base signature marks the parameter `covariant`, so you can narrow it. `other is! AppTokens` covers the `null` case.
- **Every field type has a matching static `lerp`.** `Color.lerp`, `lerpDouble`, `BorderRadius.lerp`, `EdgeInsets.lerp`, `TextStyle.lerp`, `BoxShadow.lerpList`, `Gradient.lerp`, `Offset.lerp` and `Size.lerp` all exist. They return nullable types because they accept nullable inputs, hence the `!` when both inputs are non-null.
- **Discrete values switch at the midpoint.** There is no meaningful value halfway between `true` and `false`. `ThemeData` itself uses the `t < 0.5 ? a : b` pattern for things like `platform` and `useMaterial3`, so I copy it.
- **A shadow that "disappears" is a transparent shadow, not an empty list.** `BoxShadow.lerpList` can interpolate lists of different lengths, but a shadow with the same geometry and zero alpha gives you a clean fade. In my test, at the halfway point the shadow alpha was `0.0608`, roughly half of the light value `0x1F` (`0.1216`), which is exactly the cross-fade you want.

### Step 5: register both instances

```dart
// Flutter 3.44.8
MaterialApp(
  theme: ThemeData(
    colorScheme: ColorScheme.fromSeed(seedColor: Colors.teal),
    extensions: const <ThemeExtension<dynamic>>[AppTokens.light],
  ),
  darkTheme: ThemeData(
    colorScheme: ColorScheme.fromSeed(
      seedColor: Colors.teal,
      brightness: Brightness.dark,
    ),
    extensions: const <ThemeExtension<dynamic>>[AppTokens.dark],
  ),
  themeMode: themeMode, // ThemeMode.system, .light or .dark
  home: const HomePage(),
);
```

That is all the animation wiring you need. `_MaterialAppState._materialBuilder` picks `theme` or `darkTheme` based on `themeMode` and the platform brightness, then wraps the subtree in `AnimatedTheme(data: theme, duration: ..., curve: ...)`. When the selected `ThemeData` changes, `AnimatedTheme` runs a `ThemeDataTween`, whose `lerp` is literally `ThemeData.lerp(begin!, end!, t)`. Your tokens are now part of that tween.

This works both when your own code flips `themeMode` and when the user toggles dark mode in the OS while `themeMode` is `ThemeMode.system`.

### Step 6: read tokens without the ceremony

`Theme.of(context).extension<AppTokens>()!` is long. A `BuildContext` extension makes call sites read like design-system code:

```dart
// Flutter 3.44.8
extension AppTokensContext on BuildContext {
  AppTokens get tokens => Theme.of(this).extension<AppTokens>()!;
}

class TokenCard extends StatelessWidget {
  const TokenCard({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    return Container(
      padding: EdgeInsets.all(tokens.gap),
      decoration: BoxDecoration(
        color: tokens.surfaceRaised,
        borderRadius: tokens.cardRadius,
        boxShadow: tokens.cardElevationShadow,
        border: tokens.useHairlineBorders
            ? Border.all(color: Theme.of(context).colorScheme.outlineVariant, width: 0.5)
            : null,
      ),
      child: DefaultTextStyle.merge(style: tokens.codeStyle, child: child),
    );
  }
}
```

Because `Theme.of` registers a dependency on the inherited theme, `TokenCard` rebuilds on every frame of the theme animation and sees the interpolated values. Note that `Container` with `color` and `decoration` together throws, which is why the color lives inside `BoxDecoration` (the full story is in [the "Cannot provide both a color and a decoration" fix](/2026/07/fix-cannot-provide-both-a-color-and-a-decoration-in-a-flutter-container/)).

## Proving the tokens actually animate

Visual inspection is unreliable at 200 ms. A widget test that pumps halfway through the animation is not:

```dart
// Flutter 3.44.8, flutter_test
AppTokens? seen;

class Probe extends StatelessWidget {
  const Probe({super.key});
  @override
  Widget build(BuildContext context) {
    seen = Theme.of(context).extension<AppTokens>();
    return const SizedBox();
  }
}

Widget app(ThemeMode mode) => MaterialApp(
      theme: ThemeData(extensions: const [AppTokens.light]),
      darkTheme: ThemeData(
        brightness: Brightness.dark,
        extensions: const [AppTokens.dark],
      ),
      themeMode: mode,
      home: const Probe(),
    );

testWidgets('tokens interpolate during a theme switch', (tester) async {
  await tester.pumpWidget(app(ThemeMode.light));
  expect(seen!.surfaceRaised, AppTokens.light.surfaceRaised);

  await tester.pumpWidget(app(ThemeMode.dark));
  await tester.pump(const Duration(milliseconds: 100)); // halfway of 200 ms
  expect(seen!.surfaceRaised, isNot(AppTokens.light.surfaceRaised));
  expect(seen!.surfaceRaised, isNot(AppTokens.dark.surfaceRaised));

  await tester.pumpAndSettle();
  expect(seen!.surfaceRaised, AppTokens.dark.surfaceRaised);
});
```

At 100 ms the surface color was `Color(red: 0.5588, green: 0.5667, blue: 0.5784)`, almost exactly the midpoint between white and `#1E2228`. The default curve is `Curves.linear`, so `t` equals elapsed time over duration.

## Controlling the duration and curve

`MaterialApp` exposes the animation through two older parameters and one newer one:

```dart
// Flutter 3.44.8
MaterialApp(
  // Older API, still supported:
  themeAnimationDuration: const Duration(milliseconds: 350),
  themeAnimationCurve: Curves.easeInOut,

  // Newer API, takes precedence when non-null:
  themeAnimationStyle: AnimationStyle(
    duration: const Duration(milliseconds: 350),
    curve: Curves.easeInOutCubic,
  ),
  // ...
);
```

The default is `kThemeAnimationDuration`, which is 200 ms. Passing `themeAnimationStyle: AnimationStyle.noAnimation` replaces `AnimatedTheme` with a plain `Theme`, so the switch snaps. I confirmed that the very first frame after the switch already reports the dark `surfaceRaised` in that mode. That is the right setting for golden tests and for users who enable "reduce motion", which you can read from `MediaQuery.disableAnimationsOf(context)`.

## Gotchas that showed up in tests

### An extension missing from one theme crashes at the end of the animation

Suppose you register `AppTokens.light` on `theme` but forget it on `darkTheme`. During the animation, `_lerpThemeExtensions` calls `AppTokens.light.lerp(null, t)`, which returns `this`, so widgets keep seeing light tokens. In my test the halfway frame returned an `AppTokens` instance. Then the tween reaches `t == 1.0`, `Tween.transform` returns `end` directly, and `end` has no `AppTokens` at all. `extension<AppTokens>()` returns `null` and `context.tokens` throws a null-check error on the last frame.

The result is a crash that only happens after a theme switch, which is the easiest kind to miss. The fix is structural: build both themes from one function so the extensions list is always present.

```dart
// Flutter 3.44.8
ThemeData buildTheme(Brightness brightness) {
  final isDark = brightness == Brightness.dark;
  return ThemeData(
    colorScheme: ColorScheme.fromSeed(seedColor: Colors.teal, brightness: brightness),
    extensions: <ThemeExtension<dynamic>>[
      isDark ? AppTokens.dark : AppTokens.light,
    ],
  );
}
```

### ThemeData.copyWith(extensions: ...) replaces the whole map

This one bites when you override a single token for one subtree. The source of `ThemeData.copyWith` is:

```dart
extensions: (extensions != null) ? _themeExtensionIterableToMap(extensions) : this.extensions,
```

There is no merge. In my test, a theme with `AppTokens` and `BrandTokens` that went through `copyWith(extensions: [BrandTokens(...)])` came out with `extension<AppTokens>()` returning `null`. To override one extension and keep the rest, spread the existing values first. Later entries win because the map is built with a `for` loop keyed by `type`:

```dart
// Flutter 3.44.8
final theme = Theme.of(context);
return Theme(
  data: theme.copyWith(
    extensions: [
      ...theme.extensions.values,
      context.tokens.copyWith(gap: 8), // overrides AppTokens only
    ],
  ),
  child: const CompactSection(),
);
```

Leave the list literal untyped here. Writing `<ThemeExtension<dynamic>>[...]` fails to compile with "Can't assign spread elements of type 'ThemeExtension<dynamic>' to collection elements of type 'ThemeExtension<ThemeExtension<dynamic>>'" on Dart 3.12.2, a quirk of the self-referential `T extends ThemeExtension<T>` bound. Letting inference pick the element type compiles and behaves correctly: in my test the subtree saw `gap: 8.0` and the untouched `BrandTokens` extension.

A plain `Theme` widget does not animate. If the override itself should transition (for example a "danger zone" section that tints on hover), use `AnimatedTheme` directly.

### Without == and hashCode the theme animation restarts on every rebuild

`ThemeData.==` compares `extensions` with `mapEquals`, which calls `==` on each extension. If your class does not override `==`, two instances with identical values are not equal. That matters as soon as you build tokens at runtime instead of using `const` instances, for example from a user's chosen accent color, or with `AppTokens.light.copyWith()` inside `build`.

I tested this by rebuilding `MaterialApp` with a fresh but identical `copyWith()` instance after the first animation had settled. Without `==`, `tester.hasRunningAnimations` was `true`: `AnimatedTheme` saw a "new" theme and started another 200 ms tween, rebuilding every theme-dependent widget for 12 frames for no visual change. After adding the `==` and `hashCode` overrides shown above, the same test reported `false`. If you do not want to write them by hand, packages like `theme_extensions_builder` generate `copyWith`, `lerp`, `==` and `hashCode` from an annotation.

### Booleans and enums flip at exactly t = 0.5

With the `t < 0.5` pattern, `useHairlineBorders` was already `true` at the 100 ms frame, because `t` was exactly `0.5`. That is consistent with how `ThemeData` lerps its own discrete fields, but it means a border can pop in halfway through a color fade. If that looks wrong, express the visual as a continuous token instead: replace the boolean with a border `Color` that goes from transparent to `outlineVariant`, and let `Color.lerp` handle it.

### The key is the generic argument, not the runtime type

`type` returns `T`, the type argument you passed to `ThemeExtension`, not `runtimeType`. If you write `class BrandAppTokens extends AppTokens`, an instance of it is stored under `AppTokens` and replaces the base one. That is usually what you want for white-labelling, but it means you cannot register a base and a subclass side by side.

## Where ThemeExtension fits next to other theming tools

Use `ColorScheme` first for anything Material components consume, because buttons, chips and app bars will never read your extension. Use component themes (`CardThemeData`, `FilledButtonThemeData`) when you want to restyle a Material widget everywhere. Use `ThemeExtension` for everything your own widgets need that Material has no slot for. If you are also loading fonts through `google_fonts`, keep the `TextTheme` in `ThemeData.textTheme` and only put non-standard styles (code blocks, numeric displays) in the extension; the type mismatch that sometimes appears there is covered in [the google_fonts TextTheme fix](/2026/09/fix-textheme-cant-be-assigned-to-textheme-google-fonts-material-ui/).

The same "ambient value from the nearest inherited widget" model drives `IconTheme`, which explains why icons pick up colors you did not set, as described in [how to stop ImageIcon from tinting with the IconTheme color](/2026/09/how-to-stop-imageicon-from-tinting-an-icon-with-the-icontheme-color-in-flutter/). And if your theme toggle button swaps a sun icon for a moon icon, [AnimatedSwitcher needs a key to animate that swap](/2026/10/how-to-make-animatedswitcher-animate-when-the-child-type-does-not-change/).

### Read next

- [How to set the accent color in a Flutter app with Material 3 ColorScheme](/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/)
- [How to make AnimatedSwitcher animate when the child widget type does not change](/2026/10/how-to-make-animatedswitcher-animate-when-the-child-type-does-not-change/)
- [How to stop ImageIcon from tinting an icon with the ambient IconTheme color](/2026/09/how-to-stop-imageicon-from-tinting-an-icon-with-the-icontheme-color-in-flutter/)
- [Fix: The argument type 'TextTheme' can't be assigned to the parameter type 'TextTheme?' with google_fonts](/2026/09/fix-textheme-cant-be-assigned-to-textheme-google-fonts-material-ui/)

## Sources

- [`ThemeExtension` class, Flutter API docs](https://api.flutter.dev/flutter/material/ThemeExtension-class.html)
- [`ThemeData.extensions` property, Flutter API docs](https://api.flutter.dev/flutter/material/ThemeData/extensions.html)
- [`MaterialApp.themeAnimationStyle`, Flutter API docs](https://api.flutter.dev/flutter/material/MaterialApp/themeAnimationStyle.html)
- [`theme_data.dart` source on GitHub](https://github.com/flutter/flutter/blob/master/packages/flutter/lib/src/material/theme_data.dart)
- [Official `ThemeExtension` sample, `theme_extension.1.dart`](https://github.com/flutter/flutter/blob/master/examples/api/lib/material/theme/theme_extension.1.dart)
- [Introduce Theme extensions (flutter/flutter#98033)](https://github.com/flutter/flutter/pull/98033)
