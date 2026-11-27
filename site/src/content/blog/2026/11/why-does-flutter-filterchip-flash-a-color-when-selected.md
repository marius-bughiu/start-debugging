---
title: "Why a Flutter FilterChip flashes a color that is not splashColor when selected, and how to remove it"
description: "In Material 3, a FilterChip, ChoiceChip or InputChip starts its selection fade from ColorScheme.secondaryContainer, not from its background color, so a custom selectedColor fades in from cyan or pink. Root cause in RawChip, measured frame by frame on Flutter 3.44.8, and three fixes that remove it."
pubDate: 2026-11-27
tags:
  - "flutter"
  - "dart"
  - "material-3"
  - "theming"
  - "widgets"
---

**Short answer:** the flash is not a splash or a highlight, so `splashColor`, `highlightColor`, `surfaceTintColor` and `NoSplash.splashFactory` cannot remove it. In Material 3 (Flutter 3.44.8 and still in 3.50.1), `RawChip` cross-fades its background for about 195 ms when `selected` flips to `true`, and the start of that fade is resolved with the *selected* state, so it lands on the Material 3 default selected color, `ColorScheme.secondaryContainer`. With `ColorScheme.light()` that is the old teal `0xFF03DAC6`, which is the cyan you see. Fix it by passing the chip a `color: WidgetStateProperty` (on the chip or in `ChipThemeData.color`) instead of `selectedColor`, or by setting `secondaryContainer` in your `ColorScheme` to the color you actually want.

The question comes from [a Stack Overflow post](https://stackoverflow.com/questions/80012412) where a `FilterChip` with a custom `selectedColor` briefly turns cyan every time it is tapped. The asker wrapped the chip in a `Theme`, set half a dozen `ChipThemeData` colors to transparent, and nothing changed. The accepted answer (switch to `ColorScheme.fromSeed`) changes the color of the flash but, as the measurements below show, does not remove it. Everything here was checked with widget tests on Flutter 3.44.8 (stable, Dart 3.12.2), and the relevant `chip.dart` code was compared against the `3.50.1` tag on GitHub, where it is unchanged.

## The repro: a red theme and a cyan chip

Here is the smallest version of the asker's code. The theme is red, `useMaterial3` is on (it is the default anyway), and the chip asks for a faint red when selected:

```dart
// Flutter 3.44.8, Dart 3.12.2, Material 3
import 'package:flutter/material.dart';

void main() => runApp(const MyApp());

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: const ColorScheme.light(
          primary: Colors.red,
          onPrimary: Colors.white,
        ),
      ),
      home: const Scaffold(body: Center(child: ChipDemo())),
    );
  }
}

class ChipDemo extends StatefulWidget {
  const ChipDemo({super.key});

  @override
  State<ChipDemo> createState() => _ChipDemoState();
}

class _ChipDemoState extends State<ChipDemo> {
  bool _selected = false;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return FilterChip(
      label: const Text('Frequent Bugs'),
      selected: _selected,
      onSelected: (v) => setState(() => _selected = v),
      selectedColor: scheme.primaryContainer.withAlpha(20),
    );
  }
}
```

Tap the chip and, for a couple of frames, it is clearly cyan before settling on a pale pink. Tap it again and it snaps straight back to unselected with no animation at all. That asymmetry is the first clue that this is a background-color animation, not an ink effect: ink ripples play on both taps.

## What actually paints the cyan

`FilterChip`, `ChoiceChip`, `InputChip` and `ActionChip` all build a `RawChip`, and `RawChip` paints its fill through an `Ink` widget whose `ShapeDecoration.color` comes from `_getBackgroundColor`. In Material 3 that method looks like this (from `packages/flutter/lib/src/material/chip.dart`, identical in 3.44.8 and 3.50.1):

```dart
// Flutter 3.44.8 / 3.50.1, RawChip, Material 3 branch (abridged)
final Color? backgroundColor = resolveColor(
  color: widget.color ?? chipTheme.color,
  backgroundColor: widget.backgroundColor ?? chipTheme.backgroundColor,
  defaultColor: chipDefaults.color,
);
final Color? selectedColor = resolveColor(
  color: widget.color ?? chipTheme.color,
  selectedColor: widget.selectedColor ?? chipTheme.selectedColor,
  defaultColor: chipDefaults.color,
);
final selectTween = ColorTween(
  begin: backgroundTween.evaluate(enableController), // ends up as backgroundColor
  end: selectedColor,
);
return selectTween.evaluate(selectionFade);
```

The idea is a cross-fade from the unselected background to the selected color, driven by `selectionFade` (a `CurvedAnimation` with `Curves.fastOutSlowIn` over `_kSelectDuration`, 195 ms). The problem is in `resolveColor`. Every one of those three calls resolves against `statesController.value`, the chip's *current* widget states. Once you tap, those states already contain `WidgetState.selected`, so the "background" call goes through `_IndividualOverrides.resolve` like this:

1. `color` is null (you did not pass one), so it falls through to the per-state fields.
2. The states contain `selected`, so it returns the `selectedColor` field. But this call only received `backgroundColor`; its `selectedColor` field is null.
3. A null result falls back to `defaultColor`, which is `chipDefaults.color` resolved with the selected state.

For a `FilterChip`, the Material 3 defaults (`_FilterChipDefaultsM3.color` in `filter_chip.dart`) return `_colors.secondaryContainer` for the selected state. So the tween does not run "background to selectedColor"; it runs "`secondaryContainer` to selectedColor". The start of the animation is a color you never asked for.

Why cyan specifically? `ColorScheme.light()` still carries the Material 2 baseline: `secondary` defaults to `0xFF03DAC6`, and the `secondaryContainer` getter falls back to `secondary` when you do not set it. The test below prints both:

```
ColorScheme.light secondaryContainer=0xff03dac6 primaryContainer=0xfff44336
```

Nothing in `chipTheme` can override this, because `ChipThemeData.selectedColor` and `ChipThemeData.backgroundColor` feed the same `resolveColor` calls with the same null holes. `surfaceTintColor`, `shadowColor` and `selectedShadowColor` act on the `Material` underneath, not on the `Ink` fill, and `splashColor` / `highlightColor` only drive the `InkWell` overlay. That is why the asker's `Theme` wrapper had no effect.

## Measuring the flash frame by frame

To prove which color is on screen when, the test pumps the chip, taps it, advances the clock in fixed steps and reads the `Ink` decoration color at each step. It also captures the chip with `captureImage` and reads a real pixel, so the numbers are what gets rasterized, not just what a widget was configured with.

```dart
// Flutter 3.44.8 (stable), Dart 3.12.2, Material 3
// test/chip_flash_test.dart  ->  flutter test test/chip_flash_test.dart
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

String hex(Color? c) =>
    c == null ? 'null' : '0x${c.toARGB32().toRadixString(16).padLeft(8, '0')}';

Color? inkColor(WidgetTester tester) {
  final ink = tester.widget<Ink>(
      find.descendant(of: find.byType(FilterChip), matching: find.byType(Ink)));
  return (ink.decoration as ShapeDecoration).color;
}

Future<Color> pixel(WidgetTester tester) async {
  // Sample near the right edge of the chip, away from the label.
  final element = tester.element(find.byType(RepaintBoundary).last);
  final ui.Image image = (await tester.runAsync(() => captureImage(element)))!;
  final bytes = (await tester.runAsync(
      () => image.toByteData(format: ui.ImageByteFormat.rawRgba)))!;
  final i = ((image.height ~/ 2) * image.width + image.width - 6) * 4;
  return Color.fromARGB(bytes.getUint8(i + 3), bytes.getUint8(i),
      bytes.getUint8(i + 1), bytes.getUint8(i + 2));
}

void main() {
  final theme = ThemeData(
    useMaterial3: true,
    colorScheme: const ColorScheme.light(primary: Colors.red, onPrimary: Colors.white),
  );

  testWidgets('selection fade starts from secondaryContainer', (tester) async {
    var selected = false;
    await tester.pumpWidget(MaterialApp(
      theme: theme,
      home: Scaffold(
        body: Center(
          child: RepaintBoundary(
            child: StatefulBuilder(
              builder: (context, setState) => FilterChip(
                label: const Text('Frequent Bugs'),
                selected: selected,
                onSelected: (v) => setState(() => selected = v),
                selectedColor: theme.colorScheme.primaryContainer.withAlpha(20),
              ),
            ),
          ),
        ),
      ),
    ));

    await tester.tap(find.byType(FilterChip));
    var elapsed = 0;
    for (final ms in [0, 16, 50, 100, 150, 200, 400]) {
      await tester.pump(Duration(milliseconds: ms - elapsed));
      elapsed = ms;
      print('select +${ms}ms ink=${hex(inkColor(tester))}');
    }
    print('settled pixel=${hex(await pixel(tester))}');
  });
}
```

The full harness used for this post runs the same trace for every variant below and also captures a pixel 40 ms into the animation. Results for the asker's setup:

```
A asker
  idle      ink=null
  select +  0ms ink=0xff03dac6
  select + 16ms ink=0xfb07d8c4
  select + 50ms ink=0xc440b4a2
  select +100ms ink=0x45c16354
  select +150ms ink=0x1cec483b
  select +200ms ink=0x14f44336
  select +400ms ink=0x14f44336
  settled   ink=0x14f44336 pixel=0xfffef0ef
  deselect +60ms ink=null
  deselected ink=null
A2 pixel at +40ms=0xff42ccbc
```

The first frame after the tap paints a fully opaque `0xFF03DAC6`. At 40 ms the rasterized pixel is still `0xFF42CCBC`, plainly cyan. By 200 ms the fade has reached the requested `0x14F44336` (red at alpha 20). Composited, that settles to a pale pink (`0xFFFEF0EF` in the harness; the exact pixel depends on what sits behind the chip, and the single-test snippet above prints `0xFFF1E7E6`). On deselect the `Ink` color is `null` immediately: the same resolution bug resolves both tween ends to the unselected default (null for a flat `FilterChip`), so there is nothing to fade. You get a flash going in and a hard cut going out.

## Why the accepted answer only recolors the flash

Swapping to `ColorScheme.fromSeed(seedColor: Colors.red)` is good advice for a Material 3 app in general (see [how to set the accent color with a Material 3 ColorScheme](/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/) for why), but it does not touch the mechanism. It just changes what `secondaryContainer` is:

```
fromSeed secondaryContainer=0xffffdad5
B fromSeed + selectedColor
  select +  0ms ink=0xffffdad5
  select + 50ms ink=0xc4ffdad5
  select +100ms ink=0x45ffdad5
  select +200ms ink=0x14ffdad5
  settled   ink=0x14ffdad5 pixel=0xfffff6f4
```

The chip still starts fully opaque and fades to 8% opacity. Because the hue is now a pale pink close to the final color, it is much harder to notice, which is why the answer looked correct. If your `selectedColor` is anything other than (roughly) your scheme's `secondaryContainer`, the flash comes back.

The same trace with `splashColor: Colors.transparent`, `highlightColor: Colors.transparent` and `splashFactory: NoSplash.splashFactory` on the theme is identical to the asker's run, frame for frame (`0xff03dac6` at +0 ms, `0x14f44336` at +200 ms). So is a run that sets `ChipThemeData(selectedColor: ..., backgroundColor: Colors.transparent, surfaceTintColor: Colors.transparent)` instead of `selectedColor` on the widget. Neither touches the `Ink` fill.

## Fix 1: give the chip a `color` WidgetStateProperty

When `color` is non-null, `_IndividualOverrides.resolve` returns `color.resolve(states)` for all three calls, and the default never gets consulted. Put your selected color there and leave `selectedColor` unset:

```dart
// Flutter 3.44.8, Material 3
FilterChip(
  label: const Text('Frequent Bugs'),
  selected: _selected,
  onSelected: (v) => setState(() => _selected = v),
  color: WidgetStateProperty.resolveWith((states) {
    if (states.contains(WidgetState.selected)) {
      return scheme.primaryContainer.withAlpha(20);
    }
    return null; // keep the flat, unfilled look when unselected
  }),
)
```

Measured:

```
C color: WidgetStateProperty
  select +  0ms ink=0x14f44336
  select + 50ms ink=0x14f44336
  select +200ms ink=0x14f44336
  settled   ink=0x14f44336 pixel=0xfffef0ef
  deselect +60ms ink=null
```

No cyan on any frame. Note what you trade for it: both tween ends now resolve to the same value, so the fill switches instantly instead of fading. In practice the checkmark still animates in (it has its own 150 ms animation), so the chip does not feel abrupt.

To apply this to every chip in the app, set it once on the theme. `ChipThemeData.color` goes through the same `widget.color ?? chipTheme.color` path, and it measured identically (`0x14f44336` from the first frame):

```dart
// Flutter 3.44.8, Material 3
ThemeData(
  colorScheme: scheme,
  chipTheme: ChipThemeData(
    color: WidgetStateProperty.resolveWith(
      (states) => states.contains(WidgetState.selected)
          ? scheme.primaryContainer.withAlpha(20)
          : null,
    ),
  ),
)
```

If you also need a disabled color, handle `WidgetState.disabled` in the same callback. Once `color` is set, `disabledColor`, `backgroundColor` and `selectedColor` are ignored entirely.

## Fix 2: make `secondaryContainer` the color you want

If you would rather keep `selectedColor`, make the default agree with it. When `secondaryContainer` equals the selected color, the tween runs from X to X:

```dart
// Flutter 3.44.8, Material 3
final selected = Colors.red.withAlpha(20);
ThemeData(
  colorScheme: const ColorScheme.light(primary: Colors.red, onPrimary: Colors.white)
      .copyWith(secondaryContainer: selected),
)
```

Measured: `0x14f44336` on every frame, same as fix 1. This is the right fix when the chip color is a deliberate part of your scheme, but be careful: `secondaryContainer` is also the Material 3 default for the `NavigationBar` and `NavigationRail` indicators and for `FilledButton.tonal`, so a translucent value can leak into widgets you did not mean to change. If that is a concern, scope it with a `Theme` around just the chips, or use fix 1.

## Fix 3: build a complete Material 3 scheme

This is the accepted answer, and it is the right default for new apps: generate the scheme from a seed and use its own roles instead of hand-picked alphas.

```dart
// Flutter 3.44.8, Material 3
ThemeData(colorScheme: ColorScheme.fromSeed(seedColor: Colors.red))
// and on the chip: no selectedColor at all
```

With no `selectedColor`, the start and end of the fade are both `secondaryContainer` (the first frame after the tap measured `0xffffdad5`, which is also the settled color), so nothing flashes. The flash only reappears when you combine a seed scheme with a `selectedColor` that differs from `secondaryContainer`, as measured above. If you do that, you are back to fix 1 or fix 2.

## Gotchas and variants

**Every Material 3 chip has this, not just FilterChip.** The same test with a `ChoiceChip` and an `InputChip`, each with `selectedColor: Colors.red.withAlpha(20)` under `ColorScheme.light()`, painted `0xff03dac6` on the first frame after the tap. They share `RawChip._getBackgroundColor`, and their M3 defaults also use `secondaryContainer` for selected.

**Material 2 does not flash.** With `useMaterial3: false`, the first frame after the tap is `0x1f000000`, the M2 default chip background (black at 12%). The M2 branch of `_getBackgroundColor` resolves the two ends with plain `??` chains instead of the state machine, so it fades from the real background to the real selected color. If you are mid-migration and the flash appeared when you turned M3 on, this is why.

**Setting `color` disables the hover overlay.** `RawChip` passes `hoverColor: (widget.color ?? chipTheme.color) == null ? null : Colors.transparent` to its `InkWell`. On desktop and web, a chip with `color` set gets no hover highlight. If you need one, handle `WidgetState.hovered` inside your `resolveWith` callback (for example by blending in `scheme.onSurface.withAlpha(20)`), since you now own every state. Chip state colors under Material 3 are tracked in the umbrella issue [flutter/flutter#115364](https://github.com/flutter/flutter/issues/115364); a search of the flutter/flutter issues did not turn up one specifically about the selection fade starting from `secondaryContainer`.

**Elevated chips flash too, and keep their fill.** `FilterChip.elevated` with the same `selectedColor` painted `0xff03dac6` on the first frame after the tap, and its unselected fill is `surfaceContainerLow` (`0xffffffff` under `ColorScheme.light()`). Fix 1 still works, and returning `null` for the unselected state does not strip that fill: when your property resolves to `null`, `resolveColor` falls back to `chipDefaults.color` for that state. In other words, `null` from your callback means "use the Material 3 default here". Return an explicit color only for the states you want to change.

**Golden tests catch this only mid-animation.** A `pumpAndSettle()` before `matchesGoldenFile` always captures the final, correct color. If you want a regression test for this kind of bug, pump to a fixed point inside the animation (`pump(const Duration(milliseconds: 40))`) before taking the golden, as the pixel probe above does.

**Profile before blaming the GPU.** A colored flash on tap sometimes gets reported as a rendering glitch. In this case DevTools would show nothing unusual: these are ordinary frames painting the color they were told to. [Profiling jank with DevTools](/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) is the right tool for dropped frames, not for a wrong color.

## Read next

- [How to set the accent color in a Flutter app with Material 3 ColorScheme](/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/) covers `fromSeed`, `DynamicSchemeVariant` and which roles drive which widgets.
- [How to define custom design tokens with ThemeExtension in Flutter](/2026/10/how-to-define-custom-design-tokens-with-themeextension-in-flutter/) is the clean way to carry a "chip selected" color that is not a `ColorScheme` role.
- [How to stop ImageIcon from tinting an icon with the IconTheme color](/2026/09/how-to-stop-imageicon-from-tinting-an-icon-with-the-icontheme-color-in-flutter/) is another case of a Material default silently winning over the color you passed.

## Sources

- [Stack Overflow question 80012412](https://stackoverflow.com/questions/80012412), the original report and the `fromSeed` answer.
- [`chip.dart` at tag 3.50.1](https://github.com/flutter/flutter/blob/3.50.1/packages/flutter/lib/src/material/chip.dart): `_getBackgroundColor`, `resolveColor`, `_IndividualOverrides`, `_kSelectDuration`.
- [`filter_chip.dart` at tag 3.50.1](https://github.com/flutter/flutter/blob/3.50.1/packages/flutter/lib/src/material/filter_chip.dart): `_FilterChipDefaultsM3.color`.
- [`FilterChip` API docs](https://api.flutter.dev/flutter/material/FilterChip-class.html) and [`ChipThemeData.color`](https://api.flutter.dev/flutter/material/ChipThemeData/color.html).
- [`ColorScheme.light` constructor](https://api.flutter.dev/flutter/material/ColorScheme/ColorScheme.light.html), whose signature shows the `0xFF03DAC6` secondary default.
- [flutter/flutter#115364](https://github.com/flutter/flutter/issues/115364), the umbrella issue for Chip and the M3 spec.
