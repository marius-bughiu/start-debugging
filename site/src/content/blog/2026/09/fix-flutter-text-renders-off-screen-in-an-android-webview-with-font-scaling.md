---
title: "Fix: Flutter Text renders off-screen in an Android WebView when system font scaling is enabled"
description: "Flutter web 3.41 to 3.44 reports a ~625x line-height override when an Android WebView's textZoom is not 100. Upgrade to 3.47, or clear the override in MaterialApp.builder."
pubDate: 2026-09-11
template: error-page
tags:
  - "errors"
  - "flutter"
  - "flutter-web"
  - "android"
  - "accessibility"
---

If your Flutter web app runs inside an Android `WebView` and every plain `Text` disappears as soon as the user changes the system font size, this is a known bug in the web engine. On Flutter 3.41.0 through 3.44.9 it misreads the WebView's `textZoom` as a user line-height preference. `MediaQuery.lineHeightScaleFactorOverride` comes back as roughly `624.9`, so an 18 px line is laid out about 12,900 px tall and its glyphs paint far below the viewport. Upgrade to Flutter 3.47.0 or later (3.47.3 is current stable), where the detection code was rewritten. On older versions, clear the bogus override in `MaterialApp.builder`. If you own the Android host, you can also pin `textZoom` to 100.

This post covers Flutter 3.44.8 (Dart 3.12.2), which is the version in the bug report, and compares it with the 3.47.3 engine source. The widget-level behaviour below was reproduced with `flutter test` on 3.44.8.

## What the broken screen looks like

There is no exception and no console error. Web fonts load with HTTP 200, the `flutter-first-frame` event fires, and the scheduler keeps ticking. The symptoms are all geometric:

- Every `Text` widget is invisible, while icons, borders, images and `Container` backgrounds still paint.
- Anything below the first `Text` in a `Column` is gone too, because the inflated text pushes it thousands of pixels down.
- Fixed-height bars such as `NavigationBar` clip their labels away, and `TextField`s grow to their `maxHeight`.
- In release mode some routes are replaced by the gray `ErrorWidget`. In a debug build, expect a [RenderFlex overflow](/2026/05/fix-renderflex-overflowed-in-flutter/) measured in thousands of pixels, not the usual handful past the edge.

The trigger is specific. The same build renders fine in desktop Chrome, in the Chrome browser app on the same phone, in GeckoView, and in a WebView on the stock emulator with default settings. It breaks only in an Android System WebView whose `textZoom` is not exactly 100. The system font-size slider in Settings > Accessibility sets that value automatically for any WebView that does not override it.

Printing the `MediaQuery` values from inside the app makes it obvious. In [flutter/flutter#190350](https://github.com/flutter/flutter/issues/190350) the reporter ran a stock `flutter create` app on Flutter 3.44.8 and changed only `adb shell settings put system font_scale`:

```text
font_scale  textZoom  lineHeightScaleFactorOverride  textScaler  Text visible
0.85        85        624.9374824709756              0.85        no
1.0         100       null                           1.0         yes
1.15        115       624.9347955648752              1.15        no
1.3         130       624.9375229225718              1.3         no
```

`textScaler` is correct at every step. `lineHeightScaleFactorOverride` is `null` at 100 and about 624.94 at every other zoom level, whether the text got smaller or larger. A value that stays the same no matter which way the input moves is not a measurement. It is a sentinel leaking through.

## Why the web engine reports a 625x line height

Since Flutter 3.41 the web engine has supported the [WCAG 1.4.12 text spacing](https://www.w3.org/WAI/WCAG21/Understanding/text-spacing.html) preferences that browser extensions and user stylesheets apply. [PR #178081](https://github.com/flutter/flutter/pull/178081) added this. Flutter draws text into a canvas, so it cannot read those CSS overrides from its own content. Instead, `EnginePlatformDispatcher._addTypographySettingsObserver` adds a hidden `<p>` probe element to `document.body` with deliberately absurd inline styles, then watches it with a `ResizeObserver`. On 3.44.8 the relevant part of `engine/src/flutter/lib/web_ui/lib/src/engine/platform_dispatcher.dart` looks like this:

```dart
// Flutter 3.44.8, lib/web_ui/lib/src/engine/platform_dispatcher.dart (abridged)
const spacingDefault = 9999.0;
_typographyMeasurementElement!.style
  ..lineHeight = '${spacingDefault}px'
  ..letterSpacing = '${spacingDefault}px'
  ..wordSpacing = '${spacingDefault}px'
  ..margin = '0px 0px ${spacingDefault}px 0px';
domDocument.body!.append(_typographyMeasurementElement!);
final double typographyMeasurementElementFontSize =
    parseFontSize(_typographyMeasurementElement!)?.toDouble() ?? _defaultRootFontSize;
final double defaultLineHeightFactor = spacingDefault / typographyMeasurementElementFontSize;

// Inside the ResizeObserver callback:
final double? computedLineHeightScaleFactor =
    fontSize != null && lineHeight != null && lineHeight != spacingDefault
    ? lineHeight / fontSize
    : null;
_updateLineHeightScaleFactorOverride(
  computedLineHeightScaleFactor == defaultLineHeightFactor
      ? null
      : computedLineHeightScaleFactor,
);
```

The idea is that if nothing outside Flutter touched the probe, its computed `line-height` is still exactly `9999px` and the override stays `null`. Any other value means a user preference, and its ratio to the font size becomes the new line-height factor.

Android WebView's `textZoom` breaks both checks. It scales the root `font-size` and also scales the probe's pixel `line-height`, which is not a user preference at all. Run the numbers for `textZoom` 115 and a 16 px default root size:

1. The probe's font size is `16 * 1.15 = 18.4px`, so `defaultLineHeightFactor = 9999 / 18.4 = 543.4`.
2. The computed `line-height` is `9999 * 1.15 = 11498.85px`. That is not `9999`, so the engine treats it as an override.
3. `computedLineHeightScaleFactor = 11498.85 / 18.4 = 624.9375`, which is exactly `9999 / 16`. The zoom factor cancels out, and that is why the reported value barely moves between zoom levels.
4. `624.9375` is not equal to `543.4`, so it is published as `MediaQueryData.lineHeightScaleFactorOverride`.

The framework takes this value at face value. `Text.build` reads `MediaQuery.maybeLineHeightScaleFactorOverrideOf(context)` and forces it onto the span's `TextStyle.height`, and onto `StrutStyle.height` when a strut is set, regardless of `inherit`. `TextStyle.height` is a multiplier of the font size, as described in [the leadingDistribution post](/2026/01/flutter-text-the-leadingdistribution-detail-that-changes-how-your-ui-breathes/), so the line box becomes 625 times taller than the glyphs. Widgets that build a `RichText` directly, such as `Icon`, never consult the override. That is why icons survive on a screen where all the text is gone.

This is a variant of an earlier bug. [#178856](https://github.com/flutter/flutter/issues/178856) described the same abnormal value after changing the browser font size at runtime, and [PR #178862](https://github.com/flutter/flutter/pull/178862) fixed it on 2 December 2025. That fix still compared against `9999` exactly, so a zoom that is already active at first paint gets through. A bisect in the issue thread places the regression between 3.39.0-0.2.pre (good) and 3.40.0-0.1.pre (bad). Among stable releases, the 9999 px sentinel is present in every tag from 3.41.0 through 3.44.9 and absent from 3.38.x.

The renderer does not matter. The thread reproduces the bug with CanvasKit, CanvasKit forced to CPU, and skwasm from a [`flutter build web --wasm`](/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/) build, because the defect is in shared Dart code.

## Minimal repro

The web side is a stock app that prints the overrides with `RichText`, so the report stays readable while the bug is active:

```dart
// Flutter 3.44.8, web target. Serve build/web and load it in an Android WebView.
import 'package:flutter/material.dart';

void main() => runApp(
      const MaterialApp(home: Scaffold(body: SafeArea(child: Probe()))),
    );

class Probe extends StatelessWidget {
  const Probe({super.key});

  @override
  Widget build(BuildContext context) {
    final mq = MediaQuery.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        RichText(
          text: TextSpan(
            text: 'line=${mq.lineHeightScaleFactorOverride}\n'
                'scale10=${mq.textScaler.scale(10)}',
            style: const TextStyle(fontSize: 15, color: Colors.black),
          ),
        ),
        const Text('PLAIN TEXT', style: TextStyle(fontSize: 18, color: Colors.red)),
      ],
    );
  }
}
```

Build it with `flutter build web --release` and serve `build/web`. Then run `adb shell settings put system font_scale 1.15` and open the page in a plain `android.webkit.WebView` with JavaScript enabled. The host does not need to call `setTextZoom`, because the WebView picks up the system scale by itself.

If you don't have a device, you can reproduce the framework half in a widget test by feeding in the value the engine reports:

```dart
// Flutter 3.44.8, flutter_test
testWidgets('engine-reported override inflates Text', (tester) async {
  await tester.pumpWidget(MaterialApp(
    builder: (context, child) => MediaQuery(
      data: MediaQuery.of(context)
          .copyWith(textScaler: const TextScaler.linear(1.15))
          .applyTextStyleOverrides(
            lineHeightScaleFactorOverride: 624.9375,
            letterSpacingOverride: null,
            wordSpacingOverride: null,
            paragraphSpacingOverride: null,
          ),
      child: child!,
    ),
    home: const Scaffold(
      body: SingleChildScrollView(
        child: Text('plain', key: Key('t'), style: TextStyle(fontSize: 18)),
      ),
    ),
  ));
  debugPrint('${tester.getSize(find.byKey(const Key('t'))).height}');
});
```

On 3.44.8 this prints `12936.0`, which is the same 12,936 px line height the issue reporter measured in the real WebView.

## Fix 1: upgrade to Flutter 3.47

[PR #186474](https://github.com/flutter/flutter/pull/186474), merged on 19 May 2026, rewrote the probe logic. It was written for a Safari "never use font sizes smaller than" bug ([#185931](https://github.com/flutter/flutter/issues/185931)) that produced the same inflated factor through the same mechanism. The fix first shipped in 3.46.0-0.1.pre and is in every 3.47 stable release. The 3.44.x hotfix line, including 3.44.9 from 5 August 2026, never received it. The new code:

```dart
// Flutter 3.47.3, lib/web_ui/lib/src/engine/platform_dispatcher.dart (abridged)
const spacingDefault = 100.0;
final double defaultLineHeightFactor =
    spacingDefault / (typographyMeasurementElementFontSize / findBrowserTextScaleFactor());

bool isDefault(double? value, double defaultValue) {
  if (value == null) {
    return true;
  }
  return (value - defaultValue).abs() < _typographyPrecisionErrorTolerance ||
      (value - defaultValue * computedTextScaleFactor).abs() <
          _typographyPrecisionErrorTolerance;
}
```

`findBrowserTextScaleFactor()` is the root font size divided by 16, which is 1.15 under `textZoom` 115. The zoomed line height of `100 * 1.15` now counts as "default", and so does the zoomed letter spacing, word spacing and paragraph margin. The override stays `null` while `textScaler` still reports 1.15. The sentinel also dropped from 9999 px to 100 px, so a future misdetection would give a factor of about 6 rather than 625.

One caveat: #190350 is still open, and nobody in the thread has posted a device test on 3.47. The analysis above comes from reading the source, not from a WebView run. After upgrading, run the `RichText` probe on a real device at `font_scale` 1.15 and confirm `line=null` before you remove any workaround. If you are upgrading from 3.44 anyway, the [3.47 desktop renderer change](/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/) is worth reading for the other targets in your app.

```bash
flutter upgrade
flutter --version
```

## Fix 2: clear the implausible overrides in MaterialApp.builder

If you can't move off 3.41 to 3.44 yet, or you don't control the host app, fix it at the root of the widget tree. `MediaQuery.applyTextStyleOverrides` replaces the four spacing overrides for everything below it. It sets each one to exactly what you pass, `null` included, and keeps `textScaler`, so the user's font-size choice still applies.

The workaround posted in the issue sets all four to `null`. That works, but it also throws away real WCAG text-spacing preferences, which is the feature the probe exists for. A narrower guard drops only values no real user setting could produce:

```dart
// Flutter 3.41.0 to 3.44.9, workaround for flutter/flutter#190350
import 'package:flutter/widgets.dart';

/// Drops text spacing overrides that no real user preference can produce.
Widget sanitizeTextSpacing(BuildContext context, Widget? child) {
  final mq = MediaQuery.of(context);
  double? sane(double? value, double max) =>
      value == null || value.abs() > max ? null : value;

  final lineHeight = sane(mq.lineHeightScaleFactorOverride, 4);
  final letter = sane(mq.letterSpacingOverride, 100);
  final word = sane(mq.wordSpacingOverride, 100);
  final paragraph = sane(mq.paragraphSpacingOverride, 1000);

  if (lineHeight == mq.lineHeightScaleFactorOverride &&
      letter == mq.letterSpacingOverride &&
      word == mq.wordSpacingOverride &&
      paragraph == mq.paragraphSpacingOverride) {
    return child ?? const SizedBox.shrink();
  }
  return MediaQuery.applyTextStyleOverrides(
    lineHeightScaleFactorOverride: lineHeight,
    letterSpacingOverride: letter,
    wordSpacingOverride: word,
    paragraphSpacingOverride: paragraph,
    child: child ?? const SizedBox.shrink(),
  );
}
```

Wire it into every app root:

```dart
// Flutter 3.44.8
MaterialApp(
  builder: sanitizeTextSpacing,
  home: const HomePage(),
);
```

WCAG 1.4.12 asks for a line height of 1.5 and letter spacing of 0.12em, so a factor cap of 4 and a 100 px cap leave plenty of headroom for real preferences. On 3.44.8 I ran this with a widget test. An override of `624.9375` becomes `null`, and the 18 px `Text` measures 30 px instead of 12,936 px. An override of `1.5` passes through unchanged. `textScaler.scale(10)` returns `11.5` in both cases.

A few details matter here:

- **Every root needs it.** The builder only covers its own `MaterialApp`. If you run separate loading, maintenance or onboarding apps with their own `MaterialApp` or `WidgetsApp`, wrap each one.
- **It follows runtime changes.** `MediaQuery.of(context)` subscribes to the ambient data, so when the user changes the font size while the page is open, the engine republishes and the guard runs again.
- **`MediaQuery.withNoTextScaling` does not help.** It only resets `textScaler`, which was never the problem. Clamping the text scale leaves the line-height override in place.
- **It is harmless after upgrading.** On 3.47 the engine should report `null` in the WebView case, so the guard returns `child` untouched. You can remove it after the upgrade has been confirmed on a device.

## Fix 3: pin textZoom to 100 in the Android host

If you ship the native host too, you can make sure the WebView never passes the system font scale to the page. Of the three fixes this is the bluntest. The Flutter web content no longer follows the user's font size at all, because `textScaler` stays at 1.0. Use it only when the web app has its own in-app text size control.

In a Kotlin host:

```kotlin
// Android System WebView, API 14+
webView.settings.javaScriptEnabled = true
webView.settings.textZoom = 100
```

In a Flutter host that uses `webview_flutter` 4.14.1, the setting is on the Android platform controller in `webview_flutter_android` 4.14.1:

```dart
// webview_flutter 4.14.1, webview_flutter_android 4.14.1
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

WebViewController buildController(Uri appUrl) {
  final controller = WebViewController()
    ..setJavaScriptMode(JavaScriptMode.unrestricted)
    ..loadRequest(appUrl);

  final platform = controller.platform;
  if (platform is AndroidWebViewController) {
    // Opt out of Android's system font scale for this WebView.
    platform.setTextZoom(100);
  }
  return controller;
}
```

This also explains reports that the bug can't be reproduced. According to the issue thread, hosts built on `flutter_inappwebview` are immune because that plugin sets `textZoom` to 100 by default. Hosts built on plain `android.webkit.WebView` or `webview_flutter` are affected as soon as the user moves the font slider off its default.

## Lookalikes that are not this bug

- **Nothing renders at all on Samsung devices with Xclipse GPUs.** If icons and backgrounds are missing too, and only in CanvasKit, you are looking at [#188164](https://github.com/flutter/flutter/issues/188164), an ANGLE-on-Vulkan rendering regression. It happens even at `textZoom` 100.
- **Huge gaps between widgets in Safari 26.5.** This is [#185931](https://github.com/flutter/flutter/issues/185931). It has the same root cause through Safari's minimum font size setting, and the same fixes apply.
- **Text overflows after `flutter upgrade` on native Android or iOS.** The typography probe only exists in the web engine. On mobile targets, look at `TextScaler` and your layout constraints instead. The per-aspect accessors such as `MediaQuery.textScalerOf`, which work the same way as the one used for [reading the screen corner radius in Flutter 3.44](/2026/07/flutter-3-44-read-the-screen-corner-radius-from-mediaquery/), let you log exactly what the platform reports.

A quick way to tell whether you are hitting this bug: log `PlatformDispatcher.instance.lineHeightScaleFactorOverride` at startup. Any value above about 3 on the web means the engine misread the probe, not that the user asked for it.

## Related

- [Fix: A RenderFlex overflowed by N pixels in Flutter](/2026/05/fix-renderflex-overflowed-in-flutter/), for the debug-mode stripe this bug produces.
- [The `leadingDistribution` detail in Flutter `Text`](/2026/01/flutter-text-the-leadingdistribution-detail-that-changes-how-your-ui-breathes/), for how `TextStyle.height` turns into line box geometry.
- [How to build a Flutter web app with WebAssembly](/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/), since the bug is the same under skwasm.
- [Flutter 3.47 makes Impeller the default renderer on desktop](/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/), for the release that carries the engine fix.

## Sources

- [flutter/flutter#190350](https://github.com/flutter/flutter/issues/190350): the Android WebView `textZoom` report, bisect, and workarounds.
- [flutter/flutter#178856](https://github.com/flutter/flutter/issues/178856) and [PR #178862](https://github.com/flutter/flutter/pull/178862): the first runtime font-size variant and its partial fix.
- [PR #178081](https://github.com/flutter/flutter/pull/178081): the web text spacing override support that added the probe.
- [PR #186474](https://github.com/flutter/flutter/pull/186474) and [flutter/flutter#185931](https://github.com/flutter/flutter/issues/185931): the zoom-tolerant detection shipped in 3.46 and 3.47.
- [`platform_dispatcher.dart` at 3.44.8](https://github.com/flutter/flutter/blob/3.44.8/engine/src/flutter/lib/web_ui/lib/src/engine/platform_dispatcher.dart) and [at 3.47.3](https://github.com/flutter/flutter/blob/3.47.3/engine/src/flutter/lib/web_ui/lib/src/engine/platform_dispatcher.dart).
- [`MediaQuery.applyTextStyleOverrides`](https://api.flutter.dev/flutter/widgets/MediaQuery/applyTextStyleOverrides.html) and [`MediaQueryData.lineHeightScaleFactorOverride`](https://api.flutter.dev/flutter/widgets/MediaQueryData/lineHeightScaleFactorOverride.html) API docs.
- [`WebSettings.setTextZoom`](https://developer.android.com/reference/android/webkit/WebSettings#setTextZoom(int)) and [`AndroidWebViewController.setTextZoom`](https://pub.dev/documentation/webview_flutter_android/latest/webview_flutter_android/AndroidWebViewController/setTextZoom.html).
