---
title: "Fix: Flutter UI overlaps the Android system navigation bar after targeting SDK 35"
description: "Targeting Android SDK 35 puts your Flutter app in edge-to-edge mode, so the Scaffold body draws behind the navigation bar. Consume the insets with SafeArea and MediaQuery padding instead of opting out, because the opt-out is already dead on Android 16."
pubDate: 2026-08-21
template: how-to
tags:
  - "flutter"
  - "dart"
  - "android"
  - "layout"
---

Your buttons worked last release. Now the bottom row of your `Scaffold` sits underneath the Android navigation bar, half-visible and half-tappable, and nothing in your layout code changed. What changed is the target SDK: once a Flutter app targets Android SDK 35 (API 35, Android 15), Android runs it edge-to-edge, and your app's window now spans the full display height including the strip the system bars occupy. The fix is not to reclaim that strip, it is to read the inset Android reports and pad your own content by it. Wrap bottom-anchored content in `SafeArea`, and pad scrollables with `MediaQuery.paddingOf(context).bottom` so the list scrolls under the bar but stops short of it. Do not reach for `android:windowOptOutEdgeToEdgeEnforcement`: Flutter's default `targetSdkVersion` has been 36 since well before the current stable, and on API 36 that opt-out is deprecated and disabled.

Everything below was verified against Flutter 3.44.2 (Dart 3.12.2), with the SDK defaults cross-checked against the current stable, Flutter 3.47.1 (released 2026-08-19, Dart 3.13.1).

## Why 48 logical pixels disappeared from the bottom of your app

Before Android 15, an app that did not explicitly go edge-to-edge got a window that stopped where the system bars started. The navigation bar was opaque, it belonged to the system, and your `Scaffold` simply never saw those pixels. Layout was easy because the OS did the insetting for you.

Android 15 inverted that default. Per Android's edge-to-edge guidance, "Edge-to-edge is enforced on Android 15 (API level 35) and higher once your app targets SDK 35." Your window now spans the entire display. The status bar becomes transparent, the gesture navigation bar becomes transparent, and the three-button navigation bar becomes translucent. Android still tells you exactly how much space those bars cover, through window insets, but it no longer subtracts that space on your behalf.

Flutter inherited this the moment its default target moved. The framework's own migration note is blunt about the sequence: "Prior to Flutter 3.27, Flutter apps targeted Android 14 by default and didn't opt into edge-to-edge mode automatically." Starting with Flutter 3.27, apps using `flutter.targetSdkVersion` target Android 15 and are automatically opted in. The change landed in `3.26.0-0.0.pre` and shipped stable in 3.27.

That default has since moved again, which is the part most write-ups on this error are stale about. In the Gradle plugin shipped with Flutter 3.44.2, and identically at the 3.47.1 tag, the defaults are:

```kotlin
// packages/flutter_tools/gradle/src/main/kotlin/FlutterExtension.kt
// Identical in Flutter 3.44.2 and 3.47.1
val compileSdkVersion: Int = 36
val minSdkVersion: Int = 24
val targetSdkVersion: Int = 36
```

So a stock `flutter create` app today does not merely target the SDK where edge-to-edge is the default. It targets the one where edge-to-edge is the only option.

## What the overlap actually looks like in numbers

It is worth pinning this down with measurements rather than screenshots, because "it looks wrong on my Pixel" is not a debuggable statement. A widget test can model the device precisely: set the view's `viewPadding` to a 24dp status bar and a 48dp three-button navigation bar, set `devicePixelRatio` to 1 so logical pixels equal physical pixels, and measure where widgets land in an 800dp-tall window.

```dart
// Flutter 3.44.2 / Dart 3.12.2
void setNavBarView(WidgetTester tester) {
  tester.view.devicePixelRatio = 1.0;
  tester.view.physicalSize = const Size(400, 800);
  tester.view.viewInsets = FakeViewPadding.zero;
  tester.view.viewPadding = const FakeViewPadding(top: 24, bottom: 48);
  tester.view.padding = const FakeViewPadding(top: 24, bottom: 48);
  addTearDown(tester.view.reset);
}

testWidgets('bare Scaffold body is not inset from the nav bar', (t) async {
  setNavBarView(t);
  await t.pumpWidget(MaterialApp(
    home: Scaffold(
      body: Align(
        alignment: Alignment.bottomCenter,
        child: SizedBox(key: const Key('marker'), height: 10, width: 10),
      ),
    ),
  ));
  print('BODY_BOTTOM=${t.getRect(find.byKey(const Key('marker'))).bottom}');
});
```

That prints `BODY_BOTTOM=800.0`. The marker's bottom edge sits at 800, the very bottom of the display, which means its lower 48 logical pixels are underneath the navigation bar. `Scaffold.body` receives the whole window and does nothing to protect its child. That is the entire bug, and it is working as designed.

## The fix in four steps

1. Keep edge-to-edge enabled and stop looking for a switch to turn it off. On API 36 there is no supported way to turn it off, so time spent on the opt-out is time spent building something you will have to remove.

    ```dart
    // Flutter 3.44.2: nothing to add. edgeToEdge is already the default.
    ```

2. Wrap bottom-anchored and top-anchored content in `SafeArea`. This is the right tool for content that must never sit under a bar: bottom button rows, custom toolbars, floating panels, anything positioned with `Align` or `Positioned`.

    ```dart
    // Flutter 3.44.2
    Scaffold(
      body: SafeArea(
        child: Align(
          alignment: Alignment.bottomCenter,
          child: ElevatedButton(onPressed: _submit, child: const Text('Save')),
        ),
      ),
    )
    ```

3. Pad scrollables instead of wrapping them. A `ListView` inside a `SafeArea` gets a viewport that stops above the navigation bar, so content is clipped at a hard edge and the translucent bar shows empty background. Pass the inset as list padding instead: the viewport stays full-bleed and content scrolls under the bar while still coming to rest above it.

    ```dart
    // Flutter 3.44.2
    ListView(
      padding: EdgeInsets.only(bottom: MediaQuery.paddingOf(context).bottom),
      children: rows,
    )
    ```

4. Verify with a widget test rather than by eye, reusing the `setNavBarView` helper above. Device-specific bar heights are exactly the kind of thing that regresses silently on a phone you do not own.

The difference in step 3 is measurable. With a `ListView` inside `SafeArea`, the scrollable's viewport bottom measures 752.0, so the viewport itself is 48 short of the window. With the padding approach the viewport bottom is 800.0 (full-bleed, content visibly scrolls under the translucent bar) while the final row's bottom lands at 752.0, giving exactly 48 logical pixels of clearance. Same clearance for the content, correct behaviour for the scroll.

## Material's own bottom widgets already handle this, yours do not

The most common wasted hour here is adding padding that Material already added, then wondering why the gap looks doubled. `Scaffold` does inset some of its slots, but only for widgets that opt in. Measuring each slot against the same simulated 48dp navigation bar:

| Widget | Rendered height | Top edge | Result |
| --- | --- | --- | --- |
| `SizedBox(height: 56)` as `bottomNavigationBar` | 56.0 | 744.0 | overlaps, zero clearance |
| `NavigationBar` (2 destinations) | 128.0 | 672.0 | icons clear the bar by 86.0 |
| `BottomAppBar` | 128.0 | 672.0 | absorbs the 48dp inset |
| `FloatingActionButton` | default | | bottom at 736.0, clearance 64.0 |
| `AppBar` | 80.0 | 0.0 | title top at 38.0 |

Read the first two rows together, because they are the whole lesson. A raw `SizedBox` of height 56 dropped into the `bottomNavigationBar` slot renders exactly 56 tall and runs to y=800, so its lower 48 pixels are under the bar. A real `NavigationBar` with a nominal height of 80 renders at 128, which is 80 plus the 48dp inset it consumed itself. `BottomAppBar` behaves the same way. The `FloatingActionButton` ends at 736 for 64 of clearance: the 48dp inset plus Scaffold's usual 16dp margin. `AppBar` renders 80 tall, which is the 56dp toolbar plus the 24dp status bar, so the top of the screen has been handled for you since long before any of this.

The rule that follows: Material's bottom widgets grow by the inset, custom widgets in the same slot do not. If you built a custom bottom bar, you own its padding. If you are already using `NavigationBar` and you wrap it in a `SafeArea`, you get 96dp of dead space and a bar that looks broken.

## The keyboard trap that makes SafeArea look flaky

This is the part that produces bug reports reading "SafeArea works, but only sometimes." It is not flaky. It is `MediaQueryData.padding` doing exactly what it documents.

Android reports two related values. `viewPadding` is the raw inset the system bars occupy. `padding` is that same inset with `viewInsets` (the keyboard) already subtracted and clamped at zero. When the soft keyboard opens it covers the navigation bar, so the bottom inset that mattered for layout is gone. Measured with a 300dp keyboard up:

```text
KEYBOARD_UP padding.bottom=0.0 viewPadding.bottom=48.0
```

`SafeArea` reads `padding` by default, so its bottom inset collapses to zero the instant the keyboard appears, and whatever you anchored to the bottom drops by 48 logical pixels. Sometimes that is correct, because the bar really is covered. When it is not, `SafeArea` has a flag for it, and the framework's implementation is a two-line swap:

```dart
// packages/flutter/lib/src/widgets/safe_area.dart, Flutter 3.44.2
EdgeInsets padding = MediaQuery.paddingOf(context);
// Bottom padding has been consumed - i.e. by the keyboard
if (maintainBottomViewPadding) {
  padding = padding.copyWith(bottom: MediaQuery.viewPaddingOf(context).bottom);
}
```

Setting `maintainBottomViewPadding: true` holds the gap steady. Measured side by side with the keyboard up, a plain `SafeArea` yields a bottom gap of 0.0 and one with the flag yields 48.0. Use it when a bottom control animates with the keyboard and you do not want it visibly jumping. This is the same family of problem as [a RenderFlex overflowing on the bottom when the keyboard opens](/2026/08/fix-renderflex-overflowed-on-the-bottom-when-the-keyboard-opens-in-flutter/), where the keyboard changes the constraints rather than the padding.

## Nesting SafeArea does not double the padding

Worth knowing before you go hunting for a phantom gap: `SafeArea` removes the padding it consumed from the `MediaQuery` it hands down to its subtree. A `SafeArea` inside a `SafeArea` produces a bottom gap of 48.0, not 96.0. The inner one sees zero padding and adds nothing.

That is good news for composition, because you can put a `SafeArea` in a shared page scaffold and let individual screens add their own without auditing the whole tree. It is bad news for debugging, because a wrong gap is never caused by double-nesting, so if your gap is wrong the cause is somewhere else, usually a custom widget in a `Scaffold` slot as described above.

## The opt-out exists, expires, and can crash you

For completeness, since it is the first result for most searches on this symptom. Flutter documents an opt-out for apps targeting SDK 35: add `android:windowOptOutEdgeToEdgeEnforcement` to both `LaunchTheme` and `NormalTheme` in `android/app/src/main/res/values/styles.xml`, and to the matching `values-night/styles.xml`.

```xml
<!-- android/app/src/main/res/values/styles.xml -->
<style name="NormalTheme" parent="@android:style/Theme.Light.NoTitleBar">
    <item name="android:windowOptOutEdgeToEdgeEnforcement">true</item>
</style>
```

Three reasons not to build on this. First, Android 16 killed it: the behavior-changes page states that for apps targeting API 36, `R.attr#windowOptOutEdgeToEdgeEnforcement` "is deprecated and disabled, and your app can't opt-out of going edge-to-edge." Second, Flutter already defaults you to `targetSdkVersion = 36`, so you would have to actively downgrade your target to make the attribute meaningful at all. Third, Flutter's own migration note warns that using the opt-out on Android 16 or later "might cause your app to crash," and the suggested mitigation is a version-specific `your_app/android/app/src/main/res/values-35` directory holding styles without the attribute. That is real resource plumbing bought in exchange for a behaviour that is already gone on current devices.

The same reasoning applies to `SystemChrome.setEnabledSystemUIMode`. On API 36 the other modes are simply not honored, and the framework says so in the API docs for `SystemUiMode`: if your app targets SDK 36 or later it uses `edgeToEdge` by default on Android, and "There is no way to opt out." `leanBack`, `immersive`, and `immersiveSticky` are ignored by the Android system at that target.

## System bar colors are ignored now, and contrast is automatic

One more casualty worth naming, because it produces a different symptom: nothing crashes, your color just does not apply. Under edge-to-edge, `SystemUiOverlayStyle.statusBarColor` and `SystemUiOverlayStyle.systemNavigationBarColor` do not work. On API 35 they come back if you take the opt-out; on API 36 they are gone permanently.

What still works is icon brightness. `statusBarIconBrightness` and `systemNavigationBarIconBrightness` control whether the system's own glyphs render light or dark, which is what you actually need when the content behind the bar changes shade:

```dart
// Flutter 3.44.2
AppBar(
  systemOverlayStyle: SystemUiOverlayStyle(
    statusBarIconBrightness:
        MediaQuery.platformBrightnessOf(context) == Brightness.dark
            ? Brightness.light
            : Brightness.dark,
  ),
)
```

Prefer setting `AppBar.systemOverlayStyle`, or an `AnnotatedRegion<SystemUiOverlayStyle>` when there is no app bar, over calling `SystemChrome.setSystemUIOverlayStyle` directly. The annotated region is hit-tested every frame against whatever is actually under the status and navigation bars, so it stays correct as the user scrolls or navigates. An `AppBar` creates one automatically, so do not wrap an `AppBar` in another `AnnotatedRegion`.

Finally, since API 29 Android paints a translucent body scrim behind a transparent navigation bar to keep the three buttons legible against arbitrary content. If your design already guarantees contrast and the scrim is muddying it, `systemNavigationBarContrastEnforced: false` (and `systemStatusBarContrastEnforced` for the top) turns it off. Devices on API 28 and below never applied it in the first place.

If you are building the full-bleed look on purpose rather than repairing it, the next thing you will want is the hardware curve of the display, which Flutter now [reads from MediaQuery as physical corner radii](/2026/07/flutter-3-44-read-the-screen-corner-radius-from-mediaquery/) so your content clips to the glass instead of a guessed radius.

## Related

- [Fix: A RenderFlex overflowed by N pixels on the bottom when the keyboard opens in Flutter](/2026/08/fix-renderflex-overflowed-on-the-bottom-when-the-keyboard-opens-in-flutter/) -- the other half of the bottom-inset story, where the keyboard changes constraints rather than padding.
- [Flutter 3.44: Read the physical screen corner radius from MediaQuery](/2026/07/flutter-3-44-read-the-screen-corner-radius-from-mediaquery/) -- the companion API for full-bleed layouts on rounded displays.
- [How to mix a ListView and a GridView in one scroll view with slivers in Flutter](/2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter/) -- where to apply the bottom inset when your scroll view is a `CustomScrollView` rather than a `ListView`.
- [shrinkWrap vs Expanded vs slivers for long lists in Flutter](/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/) -- picking the right scrollable before you start padding it.
- [Fix: Google Play rejects a Flutter or .NET MAUI app for missing 16 KB memory page size support](/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/) -- another store-driven Android requirement that surfaces as a build-time surprise.

## Sources

- [Set default of SystemUiMode to edge-to-edge](https://docs.flutter.dev/release/breaking-changes/default-systemuimode-edge-to-edge) -- Flutter's migration guide, including the opt-out styles and the `values-35` note.
- [Display content edge-to-edge in your app](https://developer.android.com/develop/ui/views/layout/edge-to-edge) -- Android's enforcement statement for API 35 and above.
- [Behavior changes: Apps targeting Android 16 or higher](https://developer.android.com/about/versions/16/behavior-changes-16) -- the deprecation and disabling of `windowOptOutEdgeToEdgeEnforcement`.
- [SystemUiMode API documentation](https://api.flutter.dev/flutter/services/SystemUiMode.html) -- per-mode notes on what API 35 and API 36 honor.
- [Issue 168635: App UI overlaps with 3-button navigation bar on Samsung One UI 7 / Android 15](https://github.com/flutter/flutter/issues/168635) -- the tracking discussion Flutter's own docs point to.
