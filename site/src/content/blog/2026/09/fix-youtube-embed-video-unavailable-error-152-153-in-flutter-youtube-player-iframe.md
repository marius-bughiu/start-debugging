---
title: "Fix: YouTube embed shows \"Video unavailable\" (Error 152 / 153) in Flutter with youtube_player_iframe"
description: "Error 153 means YouTube got no Referer; 152 means the page claims to be youtube.com. Upgrade youtube_player_iframe to 6.0.2 and set origin to https://<your app id>, or use youtube-nocookie on 5.x."
pubDate: 2026-09-26
template: error-page
tags:
  - "errors"
  - "flutter"
  - "webview"
  - "ios"
  - "android"
---

YouTube now refuses to play an embed unless it can identify who is embedding it, and in a Flutter app that identity is the origin of the HTML page `youtube_player_iframe` loads into the WebView. Error 153 means the page had no origin at all, so no `Referer` was sent. Error 152 means the page claimed to be `https://www.youtube.com`, which is exactly what `youtube_player_iframe` 5.2.2 and older do by default. The fix is to upgrade to `youtube_player_iframe` 6.0.2 and set `YoutubePlayerParams(origin: 'https://com.yourcompany.yourapp')`. If you are stuck on 5.x, set `origin: 'https://www.youtube-nocookie.com'` instead, and never your app ID.

Everything below was measured on an iOS 26.5 simulator (iPhone 17 Pro Max, Xcode 27.0) with Flutter 3.44.8 / Dart 3.12.2, `webview_flutter` 4.14.1 and `webview_flutter_wkwebview` 3.26.1, and checked against the source of `youtube_player_iframe` 5.2.2 and 6.0.2. I did not run the matrix on Android, so the Android notes come from the YouTube docs and the package source, not from a device.

## The error in context

The player area renders YouTube's own error card instead of the video:

```text
Video unavailable
Error 153
Video player configuration error
```

or, for the other variant (reported in [youtube_player_flutter#1155](https://github.com/sarbagyastha/youtube_player_flutter/issues/1155) on `youtube_player_iframe` ^5.2.1):

```text
This video is unavailable
Error 152-4
Watch on YouTube
```

Starting in August 2025, apps that had not changed in months stopped playing the same videos overnight, which is why issues like [#1084 "Working App Broke In prod, Youtube Changed Something"](https://github.com/sarbagyastha/youtube_player_flutter/issues/1084) and [#1124 "Error code 153"](https://github.com/sarbagyastha/youtube_player_flutter/issues/1124) collected dozens of "same here" comments. The videos are public and embeddable, they play in mobile Chrome, and they fail only inside the app.

## Why YouTube rejects the embed

The [YouTube API Services Required Minimum Functionality](https://developers.google.com/youtube/terms/required-minimum-functionality) page says that clients using the embedded player, including the IFrame Player API, "must provide identification through the HTTP Referer request header". A browser does this on its own: the `<iframe>` pointing at `youtube.com/embed/...` is requested with a `Referer` derived from the page that contains it, under the recommended `strict-origin-when-cross-origin` policy. A mobile WebView has no page to derive it from unless you give it one. For local HTML, the documented way is the base URL: `loadDataWithBaseURL` on Android and `loadHTMLString:baseURL:` on iOS, with a value of the form `https://<app-id>`, for example `https://com.google.android.youtube`.

The [IFrame API reference](https://developers.google.com/youtube/iframe_api_reference) now lists error 153 as "The request does not include the HTTP Referer header or equivalent API Client identification." Error 152 is not documented. `youtube_player_iframe` treats it as another "not embeddable" code, but in my measurements it fires on a perfectly embeddable video whenever the embedding page's origin is `https://www.youtube.com`. YouTube identifies the embedder as YouTube itself and refuses.

Now look at what the package does. `youtube_player_iframe` does not load a YouTube URL; it loads a bundled `assets/player.html` with `WebViewController.loadHtmlString`, and that page creates the player through the IFrame API. In 5.2.2 the relevant code is:

```dart
// youtube_player_iframe 5.2.2, lib/src/player_params.dart
this.origin = 'https://www.youtube.com',

// youtube_player_iframe 5.2.2, lib/src/controller/youtube_player_controller.dart
baseUrl: kIsWeb ? Uri.base.origin : params.origin,
// ...
'host': params.origin ?? 'https://www.youtube.com',
```

So by default the local HTML page gets the origin `https://www.youtube.com`, the player is created with `host: 'https://www.youtube.com'`, and the `origin` and `widget_referrer` player vars are also `https://www.youtube.com`. That is error 152. And because one parameter feeds both the page origin and the iframe host, you cannot fix it by putting your app ID in `origin`: the player then tries to load the iframe from `https://com.yourcompany.yourapp`, which does not exist.

Version 6.0.0 (May 16, 2026) split the two. `origin` now defaults to `null`, a new `privacyEnhancedMode` (default `true`) picks the host, and the base URL falls back to that host:

```dart
// youtube_player_iframe 6.0.2, lib/src/player_params.dart
String get host => privacyEnhancedMode
    ? 'https://www.youtube-nocookie.com'
    : 'https://www.youtube.com';

// youtube_player_iframe 6.0.2, lib/src/controller/youtube_player_controller.dart
baseUrl: kIsWeb ? Uri.base.origin : (params.origin ?? params.host),
```

The maintainer closed [#1155](https://github.com/sarbagyastha/youtube_player_flutter/issues/1155) with "Fixed with v6.0.0" and the 153 reports ([#1124](https://github.com/sarbagyastha/youtube_player_flutter/issues/1124), [#1150](https://github.com/sarbagyastha/youtube_player_flutter/issues/1150)) were closed on May 30, 2026 as 6.0.1 shipped.

## Minimal repro: a matrix of page origins

To see which combination YouTube accepts, I stripped the package down to what it actually does: a `WebViewController` that loads a small HTML page with `loadHtmlString`, creates a `YT.Player` with a given `host`, calls `playVideo()` in `onReady`, and reports every `onStateChange` and `onError` back to Dart through a JavaScript channel. The video is `M7lc1UVf-VE`, YouTube's own IFrame API demo, which is embeddable.

```dart
// Flutter 3.44.8, webview_flutter 4.14.1, webview_flutter_wkwebview 3.26.1
String playerHtml({required String host, String? origin}) => '''
<!DOCTYPE html><html><body style="margin:0"><div id="p"></div>
<script>
function send(m) { Log.postMessage(m); }
var tag = document.createElement('script');
tag.src = 'https://www.youtube.com/iframe_api';
document.body.appendChild(tag);
function onYouTubeIframeAPIReady() {
  new YT.Player('p', {
    host: '$host', videoId: 'M7lc1UVf-VE',
    playerVars: {autoplay: 1, mute: 1, playsinline: 1, enablejsapi: 1
      ${origin == null ? '' : ", origin: '$origin', widget_referrer: '$origin'"}},
    events: {
      onReady: function (e) { send('onReady'); e.target.playVideo(); },
      onStateChange: function (e) { send('state=' + e.data); },
      onError: function (e) { send('ERROR=' + e.data); }
    }
  });
}
</script></body></html>''';

final controller = WebViewController.fromPlatformCreationParams(
  WebKitWebViewControllerCreationParams(
    allowsInlineMediaPlayback: true,
    mediaTypesRequiringUserAction: const <PlaybackMediaTypes>{},
  ),
)
  ..setJavaScriptMode(JavaScriptMode.unrestricted)
  ..addJavaScriptChannel('Log', onMessageReceived: (m) => debugPrint(m.message))
  ..loadHtmlString(
    playerHtml(host: 'https://www.youtube.com', origin: 'https://www.youtube.com'),
    baseUrl: 'https://www.youtube.com', // the 5.2.2 default
  );
```

These are the results, each case run for 25 seconds on the simulator (`state=1` is "playing"):

| Case | Page origin (`baseUrl`) | Player `host` | Result |
| --- | --- | --- | --- |
| `youtube_player_iframe` 5.2.2 default | `https://www.youtube.com` | `https://www.youtube.com` | `ERROR=152` |
| 6.0.x with `privacyEnhancedMode: false` | `https://www.youtube.com` | `https://www.youtube.com` | `ERROR=152` |
| No base URL (`about:blank`, origin `null`) | none | `https://www.youtube.com` | `ERROR=153` |
| 5.x workaround, 6.0.x default | `https://www.youtube-nocookie.com` | `https://www.youtube-nocookie.com` | `state=1`, plays |
| App ID + nocookie host | `https://com.example.ytrepro` | `https://www.youtube-nocookie.com` | `state=1`, plays |
| App ID + youtube.com host | `https://com.example.ytrepro` | `https://www.youtube.com` | `state=1`, plays |
| App ID in 5.x `origin` (also becomes the host) | `https://com.example.ytrepro` | `https://com.example.ytrepro` | never reaches `onReady` |

Two rules fall out of that table. A page with no origin gets 153, a page that pretends to be `youtube.com` gets 152, and anything else with a real `https://` origin plays. And the iframe host must be a real YouTube host, which is why putting your app ID into the 5.x `origin` parameter produces a silent, empty player instead of a fix.

## Fix 1: upgrade to youtube_player_iframe 6.0.2 and set origin to your app ID

This is the recommended fix. It needs Flutter 3.38 or later and Dart 3.10 or later, the new minimums in 6.0.0.

```yaml
# pubspec.yaml, Flutter 3.38+ (tested on 3.44.8)
dependencies:
  youtube_player_iframe: ^6.0.2
```

```dart
// youtube_player_iframe 6.0.2, Flutter 3.44.8
final controller = YoutubePlayerController.fromVideoId(
  videoId: 'M7lc1UVf-VE',
  autoPlay: false,
  params: const YoutubePlayerParams(
    // Your Android applicationId / iOS bundle identifier, as an https URL.
    origin: 'https://com.yourcompany.yourapp',
    showFullscreenButton: true,
  ),
);
```

With `origin` set, 6.0.2 uses it as the `loadHtmlString` base URL and as the `origin` and `widget_referrer` player vars, while the iframe keeps loading from `youtube-nocookie.com` (or `youtube.com` if you turn `privacyEnhancedMode` off). That is the "App ID + nocookie host" row above, and it matches the `https://<app-id>` format YouTube documents. It is also the approach contributors converged on in [PR #1126](https://github.com/sarbagyastha/youtube_player_flutter/pull/1126), which proposed exactly this separation of origin and host before 6.0.0 shipped it.

If you leave `origin` unset, 6.0.2 still works: the page origin falls back to `https://www.youtube-nocookie.com` (the "6.0.x default" row). Setting your app ID is still better because it is what YouTube's terms ask for, and it does not rely on YouTube continuing to treat `youtube-nocookie.com` as an acceptable embedder.

Upgrading from 5.x has one breaking change you will hit immediately: `YoutubePlayerScaffold` is gone. Replace it with `YoutubePlayer`, which now handles fullscreen itself:

```dart
// youtube_player_iframe 6.0.2 (was YoutubePlayerScaffold in 5.x)
@override
Widget build(BuildContext context) {
  return Scaffold(
    body: YoutubePlayer(
      controller: controller,
      aspectRatio: 16 / 9,
    ),
  );
}
```

6.0.1 also removed the `modestbranding` param, so delete it if you pass it.

## Fix 2: stuck on 5.x, use youtube-nocookie as the origin

If you cannot move to Flutter 3.38 yet, `youtube_player_iframe` 5.2.2 (Flutter 3.24+) can be fixed with a one-line change that several people confirmed in [#1112](https://github.com/sarbagyastha/youtube_player_flutter/issues/1112) and [#1155](https://github.com/sarbagyastha/youtube_player_flutter/issues/1155):

```dart
// youtube_player_iframe 5.2.2, Flutter 3.24+
final controller = YoutubePlayerController(
  params: const YoutubePlayerParams(
    origin: 'https://www.youtube-nocookie.com',
  ),
);
```

In 5.x this single value becomes the page origin, the iframe host and the player vars at once, which is the "5.x workaround" row in the table: a real YouTube host and a page origin that is not `youtube.com`. Do not put your app ID here on 5.x. It becomes the iframe host too and the player never loads.

## Fix 3: your own WebView, give the page a base URL

If you embed YouTube yourself with `webview_flutter` or `flutter_inappwebview` rather than through the package, the rule is the same. Always pass a base URL when you load local HTML, and make it your app ID:

```dart
// webview_flutter 4.14.1
await controller.loadHtmlString(
  html,
  baseUrl: 'https://com.yourcompany.yourapp', // never omit: null gives Error 153
);
```

If you load an embed URL directly instead of local HTML, add the header yourself. `loadRequest` takes headers on both platforms, which is the `loadUrl(url, additionalHttpHeaders)` / `loadRequest:` path the YouTube docs describe:

```dart
// webview_flutter 4.14.1
await controller.loadRequest(
  Uri.parse('https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?playsinline=1'),
  headers: const {'Referer': 'https://com.yourcompany.yourapp/'},
);
```

The same goes for `flutter_inappwebview`, which `youtube_player_flutter` uses under the hood: pass `baseUrl: WebUri('https://com.yourcompany.yourapp')` to `loadData`. [#1150](https://github.com/sarbagyastha/youtube_player_flutter/issues/1150) is the Windows (WebView2) version of this error in that package.

## Gotchas and lookalikes

**Your error handler may not see 152 or 153 as what they are.** `youtube_player_iframe` 6.0.2 maps raw codes through `YoutubeError.fromCode`, which knows `152` (`sameAsNotEmbeddable2`) but not `153`, so a 153 arrives as `YoutubeError.unknown`. In 5.2.2 both 152 and 153 map to `unknown`. If you show a "video not embeddable" message based on the enum, you will show the wrong thing. Log the raw code while you debug this.

**Turning off `privacyEnhancedMode` in 6.x brings 152 back** unless you also set `origin`. With `privacyEnhancedMode: false` and no `origin`, the base URL falls back to `https://www.youtube.com`, which is the second row of the table. Set `origin` to your app ID and the youtube.com host plays fine.

**Error 150 and 101 are a different problem.** Those mean the owner disabled embedding for that video. No origin or Referer change fixes them; open the video in the YouTube app with `url_launcher` instead.

**"This video is unavailable, Error code: 15"** from September 2025 ([#1112](https://github.com/sarbagyastha/youtube_player_flutter/issues/1112), [#1125](https://github.com/sarbagyastha/youtube_player_flutter/issues/1125)) was the same family of identity checks on 5.x and responds to the same origin fixes.

**Flutter web is different.** On web the package ignores your `origin` and uses `Uri.base.origin`, the real origin of your site, because the browser sends the `Referer` itself. If you get 153 there, your server is almost certainly sending `Referrer-Policy: no-referrer` or `same-origin`, which strips the header on the cross-origin iframe request. Switch it to `strict-origin-when-cross-origin`, as YouTube recommends, or add `<meta name="referrer" content="strict-origin-when-cross-origin">` to `web/index.html`. Simon Willison hit the same thing with Django's `same-origin` default and [wrote it up](https://til.simonwillison.net/youtube/fixing-153-embed). If you also serve your Flutter web build behind aggressive caching, make sure the new `index.html` actually reaches users; [stale cached builds after reload](/2026/09/fix-flutter-web-serves-a-stale-cached-build-after-reload/) are their own trap.

**Navigation delegates can undo the fix.** If you wrap the player in your own `NavigationDelegate` and prevent every navigation that is not your domain, you can block the embed's own frames. Allow the YouTube hosts explicitly; the host-matching approach in [how to block a Flutter WebView from navigating to external URLs](/2026/09/how-to-block-a-flutter-webview-from-navigating-to-external-urls/) works with an allowlist of `www.youtube.com`, `www.youtube-nocookie.com` and `m.youtube.com`.

**Launching the video URL is not the same bug.** [flutter/flutter#178705](https://github.com/flutter/flutter/issues/178705) reports 153 when opening a link with `launchUrl`, which leaves your app entirely. That was closed as invalid and is about the browser or YouTube app on the device, not your WebView.

## Related

- [How to block a Flutter WebView from navigating to external URLs](/2026/09/how-to-block-a-flutter-webview-from-navigating-to-external-urls/) covers `NavigationDelegate` host matching on `webview_flutter` 4.14.1.
- [Fix Flutter Text rendering off-screen in an Android WebView with system font scaling](/2026/09/fix-flutter-text-renders-off-screen-in-an-android-webview-with-font-scaling/) is another WebView-embedding bug with a one-parameter fix.
- [Fix Flutter web serving a stale cached build after reload](/2026/09/fix-flutter-web-serves-a-stale-cached-build-after-reload/) matters if you ship the web `index.html` change above.
- [Flutter 3.44 splitting Material and Cupertino out of the SDK](/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/) is worth reading before the Flutter 3.38+ upgrade that `youtube_player_iframe` 6.x needs.

## Sources

- [YouTube API Services: Required Minimum Functionality, API client identity and Referer format](https://developers.google.com/youtube/terms/required-minimum-functionality)
- [YouTube IFrame Player API reference, onError codes](https://developers.google.com/youtube/iframe_api_reference)
- [youtube_player_iframe changelog (5.2.2, 6.0.0, 6.0.1, 6.0.2)](https://pub.dev/packages/youtube_player_iframe/changelog)
- [sarbagyastha/youtube_player_flutter#1155: Error 152-4 on 5.2.1, fixed in 6.0.0](https://github.com/sarbagyastha/youtube_player_flutter/issues/1155)
- [sarbagyastha/youtube_player_flutter#1124: Error code 153](https://github.com/sarbagyastha/youtube_player_flutter/issues/1124)
- [sarbagyastha/youtube_player_flutter#1112: Error code 15 and the youtube-nocookie origin workaround](https://github.com/sarbagyastha/youtube_player_flutter/issues/1112)
- [sarbagyastha/youtube_player_flutter#1126: send origin separately from host](https://github.com/sarbagyastha/youtube_player_flutter/pull/1126)
- [Simon Willison: Error 153 Video player configuration error on YouTube embeds](https://til.simonwillison.net/youtube/fixing-153-embed)
