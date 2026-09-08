---
title: "How to stop ImageIcon from tinting an icon with the ambient IconTheme color in Flutter"
description: "ImageIcon flattens a multi-color PNG into a silhouette because it always applies ColorFilter.mode(iconThemeColor, BlendMode.srcIn). Flutter 3.47 adds useOriginalColors to switch that off. Here is why passing color: null never worked, what useOriginalColors silently drops, and the hand-rolled replacement for older SDKs."
pubDate: 2026-09-08
template: how-to
tags:
  - "flutter"
  - "dart"
  - "material-design"
  - "how-to"
---

`ImageIcon` hands your image to `Image` with `color: IconTheme.of(context).color`, and the render object turns that into `ColorFilter.mode(color, BlendMode.srcIn)`, which throws away every pixel's RGB and keeps only its alpha. A multi-color brand mark comes out as a flat silhouette, usually black or white. Since Flutter 3.47 the fix is one argument: `ImageIcon(AssetImage('assets/logo.png'), useOriginalColors: true)`. Passing `color: null` does nothing, and never did, because `IconTheme.of` is contractually obliged to return a concrete color and falls back to opaque black. On 3.44 and older there is no flag, so you replace the widget with a plain `Image` and reproduce ImageIcon's four layout arguments yourself. Everything below targets the current stable channel, Flutter 3.47.2 with Dart 3.13.2.

## Why color: null does not turn the tint off

The whole widget is about thirty lines. This is `build` as it ships in 3.47:

```dart
// package:flutter/src/widgets/image_icon.dart, Flutter 3.47.2
@override
Widget build(BuildContext context) {
  final IconThemeData iconTheme = IconTheme.of(context);
  final double? iconSize = size ?? iconTheme.size;

  if (image == null) {
    return Semantics(
      label: semanticLabel,
      child: SizedBox(width: iconSize, height: iconSize),
    );
  }

  final double? iconOpacity = iconTheme.opacity;
  Color iconColor = color ?? iconTheme.color!;

  if (iconOpacity != null && iconOpacity != 1.0) {
    iconColor = iconColor.withOpacity(iconColor.opacity * iconOpacity);
  }

  return Semantics(
    label: semanticLabel,
    child: Image(
      image: image!,
      width: iconSize,
      height: iconSize,
      color: useOriginalColors ? null : iconColor,
      fit: BoxFit.scaleDown,
      excludeFromSemantics: true,
    ),
  );
}
```

The load-bearing line is `Color iconColor = color ?? iconTheme.color!`. That `!` is not optimism, it is a guarantee that `IconTheme.of` makes explicitly. The lookup resolves the nearest ambient `IconTheme`, checks whether the result is concrete, and if it is not, backfills every null field from `IconThemeData.fallback()`:

```dart
// package:flutter/src/widgets/icon_theme.dart, Flutter 3.47.2
static IconThemeData of(BuildContext context) {
  final IconThemeData iconThemeData = _getInheritedIconThemeData(context).resolve(context);
  return iconThemeData.isConcrete
      ? iconThemeData
      : iconThemeData.copyWith(
          size: iconThemeData.size ?? const IconThemeData.fallback().size,
          // ...
          color: iconThemeData.color ?? const IconThemeData.fallback().color,
          opacity: iconThemeData.opacity ?? const IconThemeData.fallback().opacity,
          // ...
        );
}
```

And `IconThemeData.fallback()` sets `color = const Color(0xFF000000)`. There is no state of the widget tree in which `IconTheme.of(context).color` is null. So the doc comment still attached to `ImageIcon.color`, which says that with no `IconTheme` it "defaults to not recolorizing the image", describes behavior the widget has not had for a long time. With no ambient theme at all you get opaque black, which is exactly the outcome people report as "my colorful icon renders as a black blob".

Setting `color: Colors.transparent` is the other instinctive attempt, and it is worse. `BlendMode.srcIn` composites the source color into the destination's alpha, so a fully transparent source produces a fully transparent result: the icon disappears rather than showing its own colors. There is also nothing to reach for at the theme level, because you cannot express "no color" in an `IconThemeData` that `IconTheme.of` will hand back untouched.

## The repro: one PNG, three places it goes gray

Any Material widget that owns its icon slot installs an `IconTheme` over that slot, so the same asset flattens in every one of them. This runs on 3.47 as written; swap the import for `package:flutter/material.dart` if you have not yet done the move onto the [standalone material_ui and cupertino_ui packages](/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/).

```dart
// Flutter 3.47.2, Dart 3.13.2
import 'package:material_ui/material_ui.dart';

const AssetImage brandMark = AssetImage('assets/brand/logo.png');

class TintDemo extends StatelessWidget {
  const TintDemo({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Tinting'),
        // Flattened to ColorScheme.onSurface.
        actions: const <Widget>[ImageIcon(brandMark)],
      ),
      body: Column(
        children: <Widget>[
          // Flattened to the button's resolved foreground color.
          ElevatedButton.icon(
            onPressed: () {},
            icon: const ImageIcon(brandMark),
            label: const Text('Open'),
          ),
          // Flattened to ListTileThemeData.iconColor.
          const ListTile(
            leading: ImageIcon(brandMark),
            title: Text('Account'),
          ),
          // Not flattened: no IconTheme is being applied to raw images.
          const Image(image: brandMark, width: 24, height: 24),
        ],
      ),
    );
  }
}
```

The last row is the tell. Same asset, same size, no color filter, correct colors. Nothing is wrong with the PNG, and nothing is wrong with asset resolution either, which is the usual first suspicion when an image looks wrong; that failure mode looks completely different and is covered in [unable to load asset after adding an image to pubspec.yaml](/2026/07/fix-unable-to-load-asset-in-flutter-after-adding-an-image-to-pubspec-yaml/).

## Steps to switch an ImageIcon to its original colors

1. Check your SDK with `flutter --version`. `useOriginalColors` landed in [PR 180491](https://github.com/flutter/flutter/pull/180491) on April 27, 2026 and shipped in the Flutter 3.47 stable release. On anything older, skip to the hand-rolled replacement below.
2. Delete the `color` argument from the call site. The constructor asserts that `color` is null whenever `useOriginalColors` is true, so leaving both in place is a hard error.
3. Add `useOriginalColors: true`. That is the entire change: `build` then passes `color: null` down to `Image`, no `ColorFilter` is installed on the render object, and the decoded pixels reach the canvas untouched.
4. Re-check every state-dependent variant of that icon. Selected, unselected, disabled and pressed states are all expressed as different `IconThemeData` colors, and you have just opted out of all of them at once.
5. Decide what carries the disabled look now. If the widget relied on a translucent tint color to look grayed out, wrap the icon in `Opacity` or supply a separate desaturated asset.

The finished call site:

```dart
// Flutter 3.47.2, Dart 3.13.2
const ImageIcon(
  AssetImage('assets/brand/logo.png'),
  useOriginalColors: true,
  semanticLabel: 'Acme',
)
```

Size still comes from the ambient `IconTheme`, so the icon keeps lining up with the `Icon` widgets beside it. Only the color filter is gone.

## What useOriginalColors drops along with the tint

Look again at the last two lines of `build` that matter:

```dart
if (iconOpacity != null && iconOpacity != 1.0) {
  iconColor = iconColor.withOpacity(iconColor.opacity * iconOpacity);
}
// ...
color: useOriginalColors ? null : iconColor,
```

`IconTheme.opacity` is folded into the alpha of the tint color, and the tint color is the only channel through which it reaches the image. Set `useOriginalColors: true` and the whole computed `iconColor` is discarded, opacity included. An ancestor that dims its subtree with `IconTheme(data: IconThemeData(opacity: 0.38), ...)` will dim every `Icon` around it and leave your image at full strength.

The same applies to translucent tint colors, which is how Material actually expresses disabled icons today. `NavigationBar`'s defaults resolve the disabled state to `onSurfaceVariant` at 38 percent alpha, and that alpha travels through `srcIn` into the rendered result. Opt out of the filter and the disabled destination looks enabled.

If you need the ambient opacity back, read it and apply it yourself:

```dart
// Flutter 3.47.2, Dart 3.13.2
class BrandIcon extends StatelessWidget {
  const BrandIcon({super.key, required this.image});

  final ImageProvider image;

  @override
  Widget build(BuildContext context) {
    final double opacity = IconTheme.of(context).opacity ?? 1.0;
    final Widget icon = ImageIcon(image, useOriginalColors: true);
    return opacity == 1.0 ? icon : Opacity(opacity: opacity, child: icon);
  }
}
```

`Opacity` is a real compositing layer and is not free, which is why the guard against the common `1.0` case is worth keeping rather than wrapping unconditionally.

## The pre-3.47 replacement

There is no flag to backport, and no combination of `color` values that reaches the same result, so on 3.44 and older you stop using `ImageIcon`. The replacement is short because ImageIcon itself is short: the parts worth keeping are the size lookup, `BoxFit.scaleDown`, and the semantics split that puts the label on the wrapper and excludes the image from the tree.

```dart
// Flutter 3.44 or older. Drop-in for ImageIcon that keeps the image's colors.
import 'package:flutter/widgets.dart';

class OriginalColorImageIcon extends StatelessWidget {
  const OriginalColorImageIcon(
    this.image, {
    super.key,
    this.size,
    this.semanticLabel,
  });

  final ImageProvider image;
  final double? size;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final double? iconSize = size ?? IconTheme.of(context).size;
    return Semantics(
      label: semanticLabel,
      child: Image(
        image: image,
        width: iconSize,
        height: iconSize,
        fit: BoxFit.scaleDown,
        excludeFromSemantics: true,
      ),
    );
  }
}
```

Two details are easy to lose if you inline a bare `Image.asset` instead. `BoxFit.scaleDown` never enlarges: an asset whose intrinsic size is smaller than the icon box stays at its intrinsic size and centers, matching how `ImageIcon` behaves and avoiding the blur that `BoxFit.contain` would introduce. And `excludeFromSemantics: true` on the inner `Image` stops the accessibility tree from carrying both the wrapper's label and the image's own, which is what `ImageIcon` does for the same reason.

## Which widgets install the IconTheme that bites you

| Widget | What it puts in the ambient IconTheme |
| --- | --- |
| `AppBar`, `SliverAppBar` | `iconTheme` for the leading widget and `actionsIconTheme` for actions, defaulting to `ColorScheme.onSurface` |
| `ElevatedButton.icon` and the other `ButtonStyleButton` variants | an `AnimatedTheme` whose `iconTheme` is merged with the resolved foreground color and icon size |
| `IconButton` | the resolved foreground color for the current widget state |
| `NavigationBar`, `NavigationRail` | a `WidgetStateProperty<IconThemeData>` resolved separately for selected, unselected and disabled |
| `BottomNavigationBar` | selected and unselected item colors |
| `ListTile` | `ListTileThemeData.iconColor`, or a disabled color when `enabled: false` |
| `Chip` and its variants | the chip's own icon theme |
| `TabBar` | `labelColor` and `unselectedLabelColor` |

This is why the bug report that usually gets filed, most famously [flutter/flutter#81643](https://github.com/flutter/flutter/issues/81643), gets closed as invalid. The widget is doing precisely what an icon widget is supposed to do. The Material theming system assumes icons are monochrome silhouettes it is allowed to recolor, the same assumption behind the way [the Material 3 ColorScheme drives accent colors across a Flutter app](/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/).

## Selected and unselected destinations need two separate widgets

`NavigationBar` does not swap one icon for another. It builds both, wraps each in its own `IconTheme.merge`, and cross-fades them in a `Stack`:

```dart
// package:flutter/src/material/navigation_bar.dart, Flutter 3.47.2
final Widget selectedIconWidget = IconTheme.merge(
  data: enabled ? selectedIconTheme : disabledIconTheme,
  child: selectedIcon ?? icon,
);
final Widget unselectedIconWidget = IconTheme.merge(
  data: enabled ? unselectedIconTheme : disabledIconTheme,
  child: icon,
);
```

Because `icon` is used for the unselected slot and also for the selected slot when `selectedIcon` is null, a single `useOriginalColors: true` widget opts both states out. If you want the brand colors only when the destination is active, pass two widgets:

```dart
// Flutter 3.47.2, Dart 3.13.2
NavigationDestination(
  icon: const ImageIcon(AssetImage('assets/brand/logo_mono.png')),
  selectedIcon: const ImageIcon(
    AssetImage('assets/brand/logo.png'),
    useOriginalColors: true,
  ),
  label: 'Acme',
)
```

The monochrome asset in the unselected slot still gets tinted, which is what you want: it tracks the theme like every other destination, and the full-color mark appears only on selection.

## Gotchas worth knowing before you ship this

**The assertion is a debug-mode check, not a compile error, unless you make it one.** `ImageIcon` has a `const` constructor, so `const ImageIcon(image, useOriginalColors: true, color: Colors.red)` is evaluated at compile time and the analyzer rejects it outright. Written without `const` it throws only in debug and profile builds. In release the assert is stripped, `build` still evaluates `useOriginalColors ? null : iconColor`, and your color is silently ignored. Prefer `const` at these call sites.

**`Icon` has no equivalent and does not need one.** Font-based icons are single-glyph outlines; there are no original colors to preserve. If you need a multi-color glyph you need an image or a vector, not an `IconFont`.

**`flutter_svg` works the other way round.** `SvgPicture.asset` does not read `IconTheme` at all, so an SVG keeps its own colors by default and you opt into tinting with an explicit `colorFilter: ColorFilter.mode(IconTheme.of(context).color!, BlendMode.srcIn)`. If your SVG is unexpectedly monochrome, look for a `fill` hardcoded in the file, not for an ambient theme.

**Assert it in a widget test rather than eyeballing a screenshot.** The rendered pixels are hard to check, but the widget configuration is not:

```dart
// Flutter 3.47.2, Dart 3.13.2
testWidgets('brand mark ignores the ambient icon color', (WidgetTester tester) async {
  await tester.pumpWidget(
    const IconTheme(
      data: IconThemeData(color: Color(0xFFFF0000)),
      child: Directionality(
        textDirection: TextDirection.ltr,
        child: ImageIcon(
          AssetImage('assets/brand/logo.png'),
          useOriginalColors: true,
        ),
      ),
    ),
  );

  expect(tester.widget<Image>(find.byType(Image)).color, isNull);
});
```

A golden test catches the regression too, but this one fails with a readable message and runs without an asset bundle behaving itself.

**Ship the right density.** `BoxFit.scaleDown` will not upscale, so a 24 logical-pixel icon slot on a 3x device wants a 72 pixel asset in `assets/brand/3.0x/`. A single 24 pixel PNG that looked fine while it was being flattened to a silhouette will look obviously soft once you can see its actual pixels.

### Read next

- [Migrate Flutter Material and Cupertino imports to the material_ui and cupertino_ui packages](/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/)
- [How to set an accent color in Flutter with the Material 3 ColorScheme](/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/)
- [Fix: unable to load asset in Flutter after adding an image to pubspec.yaml](/2026/07/fix-unable-to-load-asset-in-flutter-after-adding-an-image-to-pubspec-yaml/)
- [Fix: cannot provide both a color and a decoration in a Flutter Container](/2026/07/fix-cannot-provide-both-a-color-and-a-decoration-in-a-flutter-container/)
- [What is a Flutter Key and when does omitting it cause bugs?](/2026/09/what-is-a-flutter-key-and-when-does-omitting-it-cause-bugs/)

### Sources

- [ImageIcon class, Flutter API reference](https://api.flutter.dev/flutter/widgets/ImageIcon-class.html)
- [Added useOriginalColors flag which allows ImageIcon to bypass IconTheme colorization, flutter/flutter PR 180491](https://github.com/flutter/flutter/pull/180491)
- [Flutter 3.47.0 release notes](https://docs.flutter.dev/release/release-notes/release-notes-3.47.0)
- [IconTheme.of, Flutter API reference](https://api.flutter.dev/flutter/widgets/IconTheme/of.html)
- [BlendMode.srcIn, dart:ui API reference](https://api.flutter.dev/flutter/dart-ui/BlendMode.html)
- [ImageIcon displays a colourful icon as black & white, flutter/flutter issue 81643](https://github.com/flutter/flutter/issues/81643)
