---
title: "How to reserve space for an adaptive AdMob banner in Flutter to avoid layout shift"
description: "The official google_mobile_ads sample renders nothing until onAdLoaded, so your content jumps by 150 dp seconds after the screen appears. Ask for the anchored adaptive size first, reserve it with a SizedBox, persist the height across launches, and only then load the ad. Measured on Flutter 3.44.8 with google_mobile_ads 9.1.0."
pubDate: 2026-10-05
template: how-to
tags:
  - "flutter"
  - "dart"
  - "admob"
  - "android"
  - "layout"
---

**Short answer:** an anchored adaptive banner's height is known before the ad loads, so reserve it. Call `AdSize.getLargeAnchoredAdaptiveBannerAdSize(width)` as soon as you have a non-zero width, put a `SizedBox` of exactly that height in the banner slot right away, and swap the `AdWidget` into the box when `onAdLoaded` fires. Persist the height with `shared_preferences` so the very first frame on the next cold start already has the slot, and keep the slot when a load fails instead of collapsing it. Everything below was measured with Flutter 3.44.8 (Dart 3.12.2) and `google_mobile_ads` 9.1.0 on an Android 16 (API 36) emulator.

## Why the screen jumps when the banner arrives

Google's banner guide for the Flutter plugin loads the ad and only adds it to the tree in `onAdLoaded`. The display snippet is guarded by `if (_bannerAd != null)`, and the size of the box comes from `_bannerAd!.size`. Until the network round trip finishes, the banner slot is zero pixels tall. When the ad lands, the slot grows, the `Scaffold` body shrinks by the same amount, and anything the user was looking at near the bottom moves.

That shift is worse than it used to be for two reasons:

1. **Large anchored adaptive banners are tall.** Since `google_mobile_ads` 8.0.0, `getCurrentOrientationAnchoredAdaptiveBannerAdSize` is deprecated in favor of `getLargeAnchoredAdaptiveBannerAdSize`. Google's guide describes the large variant as "up to 20% of screen height, between 50 and 150 dp". On a typical phone that is roughly double the old 50 to 64 dp strip.
2. **The ad arrives late.** The request goes out after `MobileAds.instance.initialize()`, an ad auction and a creative download. On a cold start that is seconds, not frames, which is exactly when users start reading or tapping.

## Measuring the shift

To get real numbers I built a probe app: a `Scaffold` whose body is a `ListView` wrapped in a `LayoutBuilder` that logs every change to the body's height, with the banner in `bottomNavigationBar`. The emulator was a 1080x2400 screen at 420 dpi, which Flutter sees as 411.43 x 914.29 logical pixels, using the official adaptive banner test unit `ca-app-pub-3940256099942544/9214589741` and a release build.

First, the heights the SDK hands back for different widths (all values in dp):

| Width requested | Large anchored (current orientation) | Large, landscape | Standard anchored (deprecated) |
|---|---|---|---|
| 320 | 100 | 82 | 50 |
| 360 | 113 | 82 | 56 |
| 411 | 128 | 82 | 64 |
| 412 | 129 | 82 | 64 |
| 600 | 150 | 82 | 77 |
| 800 | 150 | 82 | 90 |

In portrait the large size tracks the 320x50 aspect ratio scaled up to 320x100 and caps at 150. In landscape it is pinned at 82, which is 20% of the 411 dp landscape height. None of this needs a network call: the size is computed on device and resolves in a few milliseconds.

Then the timeline of the body height for the tutorial pattern versus a reserved slot:

| Pattern | First real frame | Body height change | When |
|---|---|---|---|
| Render nothing until `onAdLoaded` | 302 ms | 914.29 -> 762.29 | 5,338 ms, when the ad loaded |
| Reserve the size, fetched in `didChangeDependencies` | 439 ms | 914.29 -> 762.29 | 448 ms, one frame later |
| Reserve the size, height restored from `shared_preferences` | 546 ms | 0 -> 762.29 directly | no shift at all |

The 152 dp drop is the 128 dp banner plus the 24 dp gesture navigation inset that `SafeArea` adds below it. In the naive version it happens more than five seconds after the screen appeared. Reserving the size moves it to the frame right after the first one, and persisting the height removes it.

## Step 1: get the size before you load anything

The size methods on `AdSize` are static and asynchronous because they cross the platform channel, but they do not depend on an ad being loaded. Call them as soon as `MediaQuery` gives you a width:

```dart
// Flutter 3.44.8, google_mobile_ads 9.1.0
@override
void didChangeDependencies() {
  super.didChangeDependencies();
  final size = MediaQuery.sizeOf(context);
  final padding = MediaQuery.paddingOf(context);
  final width = (size.width - padding.left - padding.right).truncate();
  // Android can report a 0x0 window on the very first frame.
  if (width <= 0 || width == _width) return;
  _width = width;
  unawaited(_load(width));
}
```

The `width <= 0` guard is not decorative. In the release build, the first `build` ran with a 0x0 `MediaQuery` size: Android had not delivered window metrics yet. Even `platformDispatcher.implicitView` in `main()` reported `physicalSize` 0 and a `devicePixelRatio` of 1.0 before `runApp`. Asking for a large anchored banner with width 0 returned `0x100`, and loading that size failed with `LoadAdError(code: 3, ... "Ad request doesn't meet size requirements")`. The tutorial code fires its first request from that zero-width frame and only succeeds because `didChangeDependencies` runs again a frame later with real metrics.

Subtract the horizontal safe-area padding before asking. Google's inline adaptive guide is explicit that the width "should take into account the device width and any safe areas that are applicable", and in landscape on a phone with a display cutout `MediaQuery.paddingOf(context).left` is not zero.

## Step 2: build a slot that owns its height

The slot is a `SizedBox` with the reserved height that is always in the tree. The `AdWidget` goes inside it only after the ad loaded, because `AdWidget` throws "AdWidget requires Ad.load to be called before AdWidget is inserted into the tree" otherwise.

```dart
// Flutter 3.44.8, google_mobile_ads 9.1.0, shared_preferences 2.5.5
class AnchoredBannerSlot extends StatefulWidget {
  const AnchoredBannerSlot({super.key, required this.adUnitId});

  final String adUnitId;

  @override
  State<AnchoredBannerSlot> createState() => _AnchoredBannerSlotState();
}

class _AnchoredBannerSlotState extends State<AnchoredBannerSlot> {
  BannerAd? _ad;
  bool _loaded = false;
  int? _width;
  int? _height;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final size = MediaQuery.sizeOf(context);
    final padding = MediaQuery.paddingOf(context);
    final width = (size.width - padding.left - padding.right).truncate();
    // Android can report a 0x0 window on the very first frame.
    if (width <= 0 || width == _width) return;
    _width = width;
    _height = BannerHeightCache.lookup(width);
    unawaited(_load(width));
  }

  Future<void> _load(int width) async {
    final size = await AdSize.getLargeAnchoredAdaptiveBannerAdSize(width);
    if (!mounted || width != _width || size == null) return;
    BannerHeightCache.remember(width, size.height);

    final previous = _ad;
    setState(() {
      _height = size.height;
      _ad = null;
      _loaded = false;
    });
    await previous?.dispose();
    if (!mounted || width != _width) return;

    final ad = BannerAd(
      adUnitId: widget.adUnitId,
      request: const AdRequest(),
      size: size,
      listener: BannerAdListener(
        onAdLoaded: (ad) {
          if (!mounted || ad != _ad) {
            ad.dispose();
            return;
          }
          setState(() => _loaded = true);
        },
        onAdFailedToLoad: (ad, error) {
          ad.dispose();
          // Keep the reserved height: collapsing now would be a layout shift.
          if (mounted && ad == _ad) setState(() => _ad = null);
        },
      ),
    );
    _ad = ad;
    await ad.load();
  }

  @override
  void dispose() {
    _ad?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final height = _height;
    if (height == null) return const SizedBox.shrink();
    final ad = _ad;
    return SafeArea(
      top: false,
      child: SizedBox(
        height: height.toDouble(),
        child: Center(
          child: _loaded && ad != null
              ? SizedBox(
                  width: ad.size.width.toDouble(),
                  height: ad.size.height.toDouble(),
                  child: AdWidget(ad: ad),
                )
              : null,
        ),
      ),
    );
  }
}
```

A few details that matter:

- **`width != _width` after every `await`.** Rotation changes the width while a size lookup or a `dispose()` is in flight. Without the check, a stale portrait request can overwrite the landscape slot.
- **`ad != _ad` in `onAdLoaded`.** If the widget already moved on to a newer request, the late ad is disposed instead of shown.
- **`SafeArea(top: false)` outside the reserved box.** The slot sits in `bottomNavigationBar`, so it has to absorb the bottom inset itself. With edge-to-edge enforced for apps targeting Android 15 and later, that inset is no longer subtracted for you.
- **`Center` around the `AdWidget`.** On iOS the plugin's docs say the widget needs a parent "with a specified width and height", otherwise the ad may not show. The inner `SizedBox` gives it exactly the requested size.

Using it is one line in the `Scaffold`:

```dart
// Flutter 3.44.8, google_mobile_ads 9.1.0
Scaffold(
  body: const ArticleList(),
  bottomNavigationBar: const AnchoredBannerSlot(
    adUnitId: 'ca-app-pub-3940256099942544/9214589741', // test unit
  ),
);
```

## Step 3: persist the height so the first frame is right

Step 2 still leaves a one-frame gap on cold start: the first frame with a real width renders before the platform channel answers. In the measurements that gap was 9 to 70 ms, which usually lands while the first content is still painting, but it is a shift and it shows up in screen recordings.

The fix is that the anchored height is a pure function of device and width. Google's own docs say the optimal height "remains constant across different ad requests". So the SDK's last answer is a perfect first guess for the next launch:

```dart
// Flutter 3.44.8, shared_preferences 2.5.5
class BannerHeightCache {
  static const _prefix = 'admob.anchoredHeight.';
  static final Map<int, int> _heights = {};

  static Future<void> restore() async {
    final prefs = await SharedPreferences.getInstance();
    for (final key in prefs.getKeys().where((k) => k.startsWith(_prefix))) {
      final width = int.tryParse(key.substring(_prefix.length));
      final height = prefs.getInt(key);
      if (width != null && height != null) _heights[width] = height;
    }
  }

  static int? lookup(int width) => _heights[width];

  static void remember(int width, int height) {
    if (_heights[width] == height) return;
    _heights[width] = height;
    unawaited(
      SharedPreferences.getInstance()
          .then((prefs) => prefs.setInt('$_prefix$width', height)),
    );
  }
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await BannerHeightCache.restore();
  unawaited(MobileAds.instance.initialize());
  runApp(const MyApp());
}
```

The slot already reads `BannerHeightCache.lookup(width)` in `didChangeDependencies`, so on the second launch the first real frame builds with a 128 dp box and the body goes from 0 straight to its final 762.29 dp. The live lookup still runs and overwrites the cached value, so a wrong guess (new OS version, different display size setting) costs one shift and then corrects itself. The in-memory map also helps within a session: the second screen that hosts a banner gets the height synchronously.

Do not try to compute the height yourself from the table above. The 100/320 ratio and the caps are observed SDK behavior, not a documented contract, and Google has changed adaptive sizing before. Caching the SDK's answer gives you the same first-frame accuracy without betting on a formula.

## Step 4: decide what happens when no ad comes back

With a reserved slot, a failed load leaves an empty strip at the bottom. You have two honest options:

1. **Keep the strip.** The layout never moves, and the next request (on navigation, on a timer, or via AdMob's automatic refresh if you configured it) fills it. This is what the widget above does.
2. **Collapse the strip.** You get the space back, at the cost of exactly one layout shift, and you need to re-reserve before the next attempt.

For a bottom-anchored banner I prefer the first. Users stop seeing a blank 128 dp strip as "missing" very quickly, but they never stop noticing a list that jumps under their thumb. If you collapse, animate it with an `AnimatedSize` so the change at least reads as intentional.

## The test ad was smaller than the slot

One more thing the probe surfaced. After `onAdLoaded`, `BannerAd.getPlatformAdSize()` reported `411x64` for an ad requested at `411x128`. The test creative is a standard-height banner. The native view centered it inside the 128 dp request, and rendering the `AdWidget` at 128 dp or at the platform size looked identical. Do not shrink the slot to the platform size after load: that is a layout shift in the other direction, and the next refresh may well return a full-height creative.

## Inline adaptive banners in scrolling content

Inline adaptive banners are the other adaptive family, meant for placement inside a feed. Their height is chosen by the server, so `AdSize.getCurrentOrientationInlineAdaptiveBannerAdSize(width)` returns a size with height 0 and you only learn the real height from `getPlatformAdSize()` after load. Google's sample handles that by rendering an empty `Container()` until load and then sizing the box, which shifts every item below it.

You cannot reserve an unknown height, but you can bound it. Use `AdSize.getInlineAdaptiveBannerAdSize(width, maxHeight)` and reserve `maxHeight`:

```dart
// Flutter 3.44.8, google_mobile_ads 9.1.0
class InlineBannerSlot extends StatefulWidget {
  const InlineBannerSlot({super.key, required this.adUnitId, this.maxHeight = 250});

  final String adUnitId;
  final int maxHeight;

  @override
  State<InlineBannerSlot> createState() => _InlineBannerSlotState();
}

class _InlineBannerSlotState extends State<InlineBannerSlot> {
  BannerAd? _ad;
  AdSize? _platformSize;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_ad != null) return;
    final width = MediaQuery.sizeOf(context).width.truncate();
    if (width <= 0) return;
    _ad = BannerAd(
      adUnitId: widget.adUnitId,
      request: const AdRequest(),
      size: AdSize.getInlineAdaptiveBannerAdSize(width, widget.maxHeight),
      listener: BannerAdListener(
        onAdLoaded: (ad) async {
          final size = await (ad as BannerAd).getPlatformAdSize();
          if (mounted) setState(() => _platformSize = size);
        },
        onAdFailedToLoad: (ad, error) => ad.dispose(),
      ),
    )..load();
  }

  @override
  void dispose() {
    _ad?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ad = _ad;
    final size = _platformSize;
    return SizedBox(
      height: widget.maxHeight.toDouble(),
      child: Center(
        child: ad != null && size != null
            ? SizedBox(
                width: size.width.toDouble(),
                height: size.height.toDouble(),
                child: AdWidget(ad: ad),
              )
            : null,
      ),
    );
  }
}
```

The trade-off is letterboxing when the creative is shorter than `maxHeight`. If that looks wrong in your design, the alternative is to start the request well before the item scrolls into view (a `ListView` builds items within `cacheExtent` of the viewport, 250 pixels by default) and accept that a shift above the viewport moves the scroll position. Google also warns that inline banners in scroll views can perform poorly on Android 9 and below, while anchored banners are unaffected.

## Gotchas

- **One `BannerAd`, one `AdWidget`.** Reusing an ad object in two places throws "This AdWidget is already in the Widget tree". Each slot owns its own ad.
- **`getLargeAnchoredAdaptiveBannerAdSize` can return `null`.** The plugin returns `null` when the SDK cannot find a height for the window. The slot then renders nothing, which is the same as not showing an ad.
- **Do not use the deprecated sizes to "save space".** `getCurrentOrientationAnchoredAdaptiveBannerAdSize` still works in 9.1.0 and gives 64 dp instead of 128 at 411 dp wide, but it is deprecated and the large format is what Google optimizes for.
- **Orientation changes are a new request.** The width changes, the slot re-reserves the new height immediately (landscape is 82 dp on this device), and a new ad is loaded for it. That shift is caused by the rotation itself, so it is expected.
- **Hot reload hides the first-frame bug.** The zero-width first frame only appears on a cold start. Test the reserved slot with `flutter run --release` after a force stop, not after a hot restart.
- **A release build may crash before your ad code runs.** In the probe, R8 stripped `androidx.work.impl.WorkDatabase`, which the ads SDK pulls in through WorkManager, and the app died with "Failed to create an instance of androidx.work.impl.WorkDatabase". Disabling minification (`isMinifyEnabled = false`) fixed it in the probe; a ProGuard keep rule for the WorkManager database classes is the narrower fix. If your release build crashes and debug does not, check `adb logcat` before blaming the banner code.

If you also run banners from .NET MAUI, the same reasoning applies there: the [MAUI AdMob guide for banners, interstitials and rewarded ads](/2026/07/monetize-a-net-maui-app-with-admob-banner-interstitial-rewarded/) uses the native views, which have the same pre-load sizing APIs.

## Related

- [Fix: Flutter UI overlaps the Android system navigation bar after targeting SDK 35](/2026/08/fix-flutter-ui-overlaps-the-android-navigation-bar-after-targeting-sdk-35/) explains the bottom inset the banner slot has to absorb.
- [How to use BuildContext safely after an await in Flutter](/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) covers the `mounted` checks the slot does after every asynchronous step.
- [How to profile jank in a Flutter app with DevTools](/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) helps you confirm the platform view is not costing you frames once the banner is in place.
- [Monetize a .NET MAUI app with AdMob banners, interstitials and rewarded ads](/2026/07/monetize-a-net-maui-app-with-admob-banner-interstitial-rewarded/) is the MAUI side of the same AdMob setup.

## Sources

- [Set up banner ads (Flutter)](https://developers.google.com/admob/flutter/banner) for large anchored adaptive sizing, the test ad unit IDs and the iOS sizing note.
- [Use inline adaptive for scrolling banners (Flutter)](https://developers.google.com/admob/flutter/banner/inline-adaptive) for `getInlineAdaptiveBannerAdSize` and `getPlatformAdSize`.
- [Set up banner ads (Android)](https://developers.google.com/admob/android/banner/anchored-adaptive) for the 50 to 150 dp, 20% of screen height range of large adaptive banners.
- [google_mobile_ads on pub.dev](https://pub.dev/packages/google_mobile_ads) and its [changelog](https://pub.dev/packages/google_mobile_ads/changelog), including the 8.0.0 deprecations.
- [shared_preferences on pub.dev](https://pub.dev/packages/shared_preferences).
