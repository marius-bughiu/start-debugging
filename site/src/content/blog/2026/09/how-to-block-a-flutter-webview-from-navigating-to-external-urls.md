---
title: "How to block a Flutter WebView from navigating to external URLs with NavigationDelegate"
description: "Keep a Flutter WebView on your own domain with webview_flutter 4.14.1: parse the URL, compare Uri.host instead of startsWith, hand mailto: and tel: to url_launcher, and know what Android and iOS actually send to onNavigationRequest."
pubDate: 2026-09-22
template: how-to
tags:
  - "flutter"
  - "dart"
  - "webview"
  - "security"
  - "android"
  - "ios"
---

**Short answer:** with `webview_flutter` 4.14.1 on Flutter 3.44, give the `WebViewController` a `NavigationDelegate` whose `onNavigationRequest` parses `request.url` with `Uri.tryParse`, returns `NavigationDecision.navigate` only when `uri.scheme == 'https'` and `uri.host` is on your allowlist, and returns `NavigationDecision.prevent` for everything else, optionally opening the blocked link in the system browser with `url_launcher`. Do not use `url.startsWith('https://example.com')`: it lets `https://example.com.evil.net` and `https://example.com@evil.net` through. And know the limits: on Android the callback never sees subframe navigations or POST form submissions.

The rest of this post builds that policy step by step, shows the test table that proves the naive check is wrong, and walks through the platform differences that decide what your callback can and cannot block. Everything below was compiled and tested against `webview_flutter` 4.14.1, `webview_flutter_android` 4.14.1, `webview_flutter_wkwebview` 3.26.1 and `url_launcher` 6.3.2 on Flutter 3.44.8 / Dart 3.12.2.

## Why a WebView wanders off your site

An embedded help center, a checkout page, or a terms-of-service screen is usually meant to show one site. The page does not know that. It contains footer links to Twitter, a "powered by" badge, an OAuth button, a `mailto:` support address, and maybe user-generated content with arbitrary links. Tap any of those and the WebView happily loads it inside your app, with no address bar, no back button unless you built one, and your app's name at the top of the screen. That is a UX problem (users get stranded on a third-party site) and a trust problem (a phishing page rendered inside your app inherits your app's credibility).

`webview_flutter` exposes one hook for this: `NavigationDelegate.onNavigationRequest`. Its signature in 4.14.1 is:

```dart
// webview_flutter 4.14.1
FutureOr<NavigationDecision> Function(NavigationRequest request)? onNavigationRequest
```

`NavigationRequest` carries exactly two fields, `url` (a `String`) and `isMainFrame` (a `bool`), and `NavigationDecision` has two values, `navigate` and `prevent`. Everything else is up to you.

## The README example is the bug

The official package README shows this snippet:

```dart
// From the webview_flutter 4.14.1 README
onNavigationRequest: (NavigationRequest request) {
  if (request.url.startsWith('https://www.youtube.com/')) {
    return NavigationDecision.prevent;
  }
  return NavigationDecision.navigate;
},
```

As a denylist demo that is fine. Flip it into an allowlist, which is what most people do, and you get `if (request.url.startsWith('https://example.com')) navigate else prevent`. String prefixes are not how URLs work. I ran 16 URLs through both the naive prefix check and the policy class built below:

```text
URL                                                  naive     policy
https://example.com/pricing                          internal  allowInWebView
https://help.example.com/articles/42                 external  allowInWebView
https://EXAMPLE.com/Pricing                          external  allowInWebView
https://example.com:8443/admin                       internal  allowInWebView
https://example.com.evil.net/login                   internal  openExternally
https://example.com@evil.net/login                   internal  openExternally
https://notexample.com/                              external  openExternally
https://evil.net/?next=https://example.com           external  openExternally
http://example.com/                                  external  openExternally
mailto:support@example.com                           external  openExternally
tel:+15550100                                        external  openExternally
about:blank                                          external  allowInWebView
about:srcdoc                                         external  block
javascript:alert(1)                                  external  block
intent://scan/#Intent;scheme=zxing;end               external  block
file:///data/data/com.example/shared_prefs/x.xml     external  block
```

Two rows are the dangerous ones. `https://example.com.evil.net/login` is a host owned by whoever registered `evil.net`. `https://example.com@evil.net/login` puts `example.com` in the userinfo part of the URL, so the browser connects to `evil.net`. Both pass the prefix check and render inside your app. The other disagreements are false negatives: an uppercase host or a subdomain gets kicked out of the WebView for no reason.

The fix is to let `Uri` do the parsing. `Uri.parse('https://EXAMPLE.com@evil.net:8443/x').host` returns `evil.net`: lower case, userinfo and port stripped. Compare that, never the raw string.

## Building the allowlist policy

Keep the decision in a plain Dart class with no Flutter or plugin imports. That makes it unit-testable with `flutter test`, which matters because you cannot run a real WebView in a widget test.

```dart
// Flutter 3.44, Dart 3.12, webview_flutter 4.14.1
enum LinkAction { allowInWebView, openExternally, block }

class LinkPolicy {
  const LinkPolicy({
    required this.allowedHosts,
    this.allowSubdomains = true,
    this.externalSchemes = const {'mailto', 'tel', 'sms'},
  });

  /// Hosts that may load inside the WebView, lower case, no scheme, no port.
  final Set<String> allowedHosts;
  final bool allowSubdomains;

  /// Schemes handed to the OS instead of the WebView.
  final Set<String> externalSchemes;

  LinkAction decide(String url) {
    final uri = Uri.tryParse(url);
    if (uri == null) return LinkAction.block;

    switch (uri.scheme) {
      case 'https':
        return _isAllowedHost(uri.host)
            ? LinkAction.allowInWebView
            : LinkAction.openExternally;
      case 'http':
        // Never load cleartext in-app, even for your own host.
        return LinkAction.openExternally;
      case 'about':
        return url == 'about:blank'
            ? LinkAction.allowInWebView
            : LinkAction.block;
      default:
        return externalSchemes.contains(uri.scheme)
            ? LinkAction.openExternally
            : LinkAction.block; // javascript:, file:, intent:, data:, ...
    }
  }

  bool _isAllowedHost(String host) {
    // Uri.host is already lower case and has userinfo and port stripped.
    if (allowedHosts.contains(host)) return true;
    if (!allowSubdomains) return false;
    return allowedHosts.any((allowed) => host.endsWith('.$allowed'));
  }
}
```

A few choices here are deliberate:

- **Three outcomes, not two.** `NavigationDecision` is binary, but "not in the WebView" splits into "open it somewhere else" and "drop it". A link to your Twitter page should open the browser. A `javascript:` or `file:` URL should go nowhere.
- **The subdomain check uses `'.$allowed'`**, with the leading dot. `host.endsWith('example.com')` would accept `notexample.com`, which is the same class of bug as the prefix check.
- **`http` is never allowed in-app.** If your own site still serves an `http` link, it will leave the app rather than load without TLS. Flip this only if you truly need it, and note that Android blocks cleartext by default anyway since API 28 unless your network security config allows it.
- **`about:blank` is allowed.** On iOS, `loadHtmlString` without a `baseUrl` and a freshly opened blank frame both show up as `about:blank`. Blocking it breaks those flows.
- **Unknown schemes are blocked, not launched.** `intent://` on Android can target any exported activity on the device. If you need a specific custom scheme (your own `myapp://` or `market://`), add it to `externalSchemes` explicitly.

The table above is the output of this test file, which runs in about a second with `flutter test`:

```dart
// Flutter 3.44, Dart 3.12
import 'package:flutter_test/flutter_test.dart';
import 'package:wvguard/link_policy.dart';

void main() {
  const policy = LinkPolicy(allowedHosts: {'example.com'});

  final cases = <String, LinkAction>{
    'https://help.example.com/articles/42': LinkAction.allowInWebView,
    'https://EXAMPLE.com/Pricing': LinkAction.allowInWebView,
    'https://example.com.evil.net/login': LinkAction.openExternally,
    'https://example.com@evil.net/login': LinkAction.openExternally,
    'https://notexample.com/': LinkAction.openExternally,
    'http://example.com/': LinkAction.openExternally,
    'mailto:support@example.com': LinkAction.openExternally,
    'javascript:alert(1)': LinkAction.block,
    'intent://scan/#Intent;scheme=zxing;end': LinkAction.block,
  };

  for (final entry in cases.entries) {
    test(entry.key, () => expect(policy.decide(entry.key), entry.value));
  }
}
```

## Wiring the policy into the NavigationDelegate

The steps, in order:

1. Add the packages: `flutter pub add webview_flutter url_launcher`. `webview_flutter` 4.14.1 needs Flutter 3.38 or later, Android SDK 24+ and iOS 13+.
2. Create the `WebViewController` once, in `initState`, not in `build`.
3. Call `setNavigationDelegate` with an `onNavigationRequest` that maps each `LinkAction` to a `NavigationDecision`.
4. For `openExternally`, fire `launchUrl` with `LaunchMode.externalApplication` and return `prevent` immediately.
5. Call `loadRequest` last, after the delegate is in place.

```dart
// Flutter 3.44, Dart 3.12, webview_flutter 4.14.1, url_launcher 6.3.2
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';

import 'link_policy.dart';

class HelpCenterPage extends StatefulWidget {
  const HelpCenterPage({super.key});

  @override
  State<HelpCenterPage> createState() => _HelpCenterPageState();
}

class _HelpCenterPageState extends State<HelpCenterPage> {
  static final Uri _home = Uri.parse('https://help.example.com/');
  static const LinkPolicy _policy = LinkPolicy(allowedHosts: {'example.com'});

  late final WebViewController _controller;

  @override
  void initState() {
    super.initState();
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setNavigationDelegate(
        NavigationDelegate(onNavigationRequest: _onNavigationRequest),
      )
      ..loadRequest(_home);
  }

  NavigationDecision _onNavigationRequest(NavigationRequest request) {
    // Android never asks about subframes; iOS does. Leave iframes alone here.
    if (!request.isMainFrame) return NavigationDecision.navigate;

    switch (_policy.decide(request.url)) {
      case LinkAction.allowInWebView:
        return NavigationDecision.navigate;
      case LinkAction.openExternally:
        unawaited(_openExternally(Uri.parse(request.url)));
        return NavigationDecision.prevent;
      case LinkAction.block:
        debugPrint('Blocked navigation to ${request.url}');
        return NavigationDecision.prevent;
    }
  }

  Future<void> _openExternally(Uri uri) async {
    final opened = await launchUrl(uri, mode: LaunchMode.externalApplication);
    if (!opened && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('No app can open $uri')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Help')),
      body: WebViewWidget(controller: _controller),
    );
  }
}
```

`flutter analyze` reports no issues on this file. Two details are worth calling out.

The callback returns synchronously. `onNavigationRequest` accepts a `Future<NavigationDecision>`, but on iOS the plugin `await`s your callback inside WebKit's `decidePolicyForNavigationAction`, so every millisecond you spend there is a millisecond the page sits frozen. Awaiting `launchUrl` (which waits for the OS to switch apps) is exactly the wrong thing to do there. Decide synchronously, return, and launch in the background with `unawaited`.

The `mounted` check after `await launchUrl` is there because the user may have popped the page by the time the OS answers. If that pattern is new to you, I covered it in detail in [using BuildContext safely after an await](/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/).

## What Android and iOS actually send to onNavigationRequest

This is the part the docs gloss over with "some platforms may also trigger this callback from calls to `loadRequest`". I read the platform implementations in `webview_flutter_android` 4.14.1 and `webview_flutter_wkwebview` 3.26.1, and the two behave very differently.

### Android: the native side cancels first, Dart re-issues

On Android the callback is driven by `WebViewClient.shouldOverrideUrlLoading`. When you set `onNavigationRequest`, the plugin calls `setSynchronousReturnValueForShouldOverrideUrlLoading(true)`. From then on the native `WebViewClientProxyApi` returns `request.isForMainFrame() && true` for every navigation: every main-frame navigation is cancelled immediately, before Dart has even been asked. Dart then runs your callback, and if it returns `navigate`, the plugin calls `loadUrl` with the same URL and the original request headers.

Consequences:

- **Subframes are never asked about.** `_handleNavigation` returns early when `isForMainFrame` is false, because `loadUrl` cannot load a URL into an iframe. An iframe on your page can navigate anywhere and your callback never runs. That is why the code above does not bother policing `isMainFrame == false`.
- **POST navigations bypass the callback.** Android's own docs state that `shouldOverrideUrlLoading` is not called for POST requests. A `<form method="post" action="https://evil.net/collect">` on a page you allowed will submit and load `evil.net` in your WebView.
- **`loadRequest` is not checked.** URLs you load yourself through the controller do not go through `shouldOverrideUrlLoading`.
- **Back, forward and reload are not checked.** They are history operations, not new navigations.
- **Downloads are routed through the same callback.** The plugin's `DownloadListener` calls `_handleNavigation` for a download URL, so an allowlist also stops downloads from other hosts.

### iOS and macOS: WebKit waits for your answer

On WebKit the callback is driven by `WKNavigationDelegate.webView(_:decidePolicyFor:decisionHandler:)`. The plugin awaits your callback and maps `navigate` to `.allow` and `prevent` to `.cancel`. Nothing is re-issued, so POST bodies and headers survive intact.

Consequences:

- **The initial `loadRequest` hits your callback.** If your allowlist does not include the URL you load in `initState`, you get a blank page and no error. The `about:blank` rule in the policy exists for the same reason when you use `loadHtmlString`.
- **Subframes are asked about.** Every iframe load, including embedded YouTube players, Stripe elements and reCAPTCHA, arrives with `isMainFrame: false`. Treat those like main-frame navigations and you break every embed on the page.
- **`target="_blank"` links arrive twice.** A new-window request first has a null target frame, so `isMainFrame` is `false`. The plugin's `WKUIDelegate` `onCreateWebView` then loads that request into the same WebView, which comes back through your callback as a main-frame navigation. The second call is where your policy applies, which is another reason to let `isMainFrame == false` through.

If you need consistent iframe policing on both platforms, the navigation delegate is the wrong tool. Send a `Content-Security-Policy` header with `frame-src` from your own server, which both WebViews enforce.

## Gotchas that let traffic slip past the allowlist

The navigation delegate controls page navigations. It does not see:

- **Subresources.** Images, scripts, `fetch` and `XMLHttpRequest` calls to other hosts load normally. `onNavigationRequest` is not a firewall. If a page you allowed can be made to run attacker script, that script can exfiltrate data with a `fetch` and your callback will never fire. Fix the page (CSP `connect-src`) rather than the WebView.
- **Single-page-app route changes.** `history.pushState` changes the URL without a navigation. Listen to `onUrlChange` if you need to track it; it cannot be blocked, but it also cannot change the origin, so it is not an escape route.
- **POST on Android**, covered above. If users can post forms on the embedded site, validate `action` URLs server side.
- **Redirect chains.** A server redirect from an allowed URL to another host is reported to `shouldOverrideUrlLoading` on Android (the `WebResourceRequest.isRedirect()` case) and to the navigation policy check on WebKit, so the allowlist still applies. Test it anyway with your real login flow, because OAuth providers love a four-hop redirect.

Three more that bite in practice:

- **OAuth and SSO.** If your site signs users in through `accounts.google.com` or an Entra ID tenant, those hosts must be allowlisted or the flow bounces out to the browser and never comes back. Google also refuses to show its sign-in page in an embedded WebView at all, so the real fix for Google sign-in is `flutter_web_auth_2` or a native SDK, not a longer allowlist.
- **`intent://` links on Android.** Sites that deep-link into apps use `intent://...#Intent;...;end` URLs. Chrome understands them; `url_launcher` does not parse the intent syntax. Blocking them, as the policy does, is the safe default. If you need them, parse the `S.browser_fallback_url` parameter and open that instead.
- **Internationalized domains.** Dart's `Uri` does no IDNA conversion: `Uri.parse('https://bücher.example/x').host` is `b%C3%BCcher.example`, while `https://xn--bcher-kva.example/x` stays `xn--bcher-kva.example`. The WebViews generally report the punycode form, so put the `xn--` spelling in your allowlist.

If your WebView is showing your own Flutter web build rather than a regular site, the in-app routing lives in your router, not the WebView, and [nested routes and deep links with go_router](/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/) is the more relevant piece. Font scaling inside that embedded Flutter web build is a separate trap I wrote up in [Flutter Text rendering off-screen in an Android WebView](/2026/09/fix-flutter-text-renders-off-screen-in-an-android-webview-with-font-scaling/).

## Async decisions behave differently per platform

Because Android cancels first and re-issues later, an `async` callback on Android never blocks the page: the old page stays on screen, fully interactive, until your `Future` completes and the plugin calls `loadUrl`. If the user taps a second link in the meantime, both decisions run and whichever `loadUrl` runs last wins. On iOS the same `async` callback holds WebKit's decision handler open, so the page waits. If your policy genuinely needs I/O (for example, fetching a remote allowlist), load it once before the page opens and keep `onNavigationRequest` synchronous, as in the example above. That gives identical behaviour on both platforms.

If you need control the cross-platform API does not expose, such as intercepting subresource requests with `shouldInterceptRequest`, there is no Dart hook for it in 4.14.1. That means native code, and the approach from [adding platform-specific code in Flutter without plugins](/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/) applies. Try the allowlist first; it is enough for the vast majority of embedded pages.

Finally, remember that anything you ship in the app binary, including the allowlist, is readable by anyone who unpacks the APK or IPA. That is fine for a list of hostnames, but it is a good reminder of [what an attacker can extract from a Flutter app](/2026/01/flutterguard-cli-a-fast-what-can-an-attacker-extract-check-for-flutter-3-x-apps/): the allowlist protects your users from wandering off, it is not a secret.

## Sources

- [webview_flutter 4.14.1 on pub.dev](https://pub.dev/packages/webview_flutter), including the README `onNavigationRequest` example and platform support table.
- [`NavigationDelegate` API reference](https://pub.dev/documentation/webview_flutter/latest/webview_flutter/NavigationDelegate-class.html).
- [webview_flutter_android source](https://github.com/flutter/packages/tree/main/packages/webview_flutter/webview_flutter_android): `android_webview_controller.dart` (`_handleNavigation`) and `WebViewClientProxyApi.java` (`shouldOverrideUrlLoading`).
- [webview_flutter_wkwebview source](https://github.com/flutter/packages/tree/main/packages/webview_flutter/webview_flutter_wkwebview): `webkit_webview_controller.dart` (`decidePolicyForNavigationAction`, `onCreateWebView`).
- [Android `WebViewClient.shouldOverrideUrlLoading`](https://developer.android.com/reference/android/webkit/WebViewClient#shouldOverrideUrlLoading(android.webkit.WebView,%20android.webkit.WebResourceRequest)).
- [Apple `webView(_:decidePolicyFor:decisionHandler:)`](https://developer.apple.com/documentation/webkit/wknavigationdelegate/webview(_:decidepolicyfor:decisionhandler:)-2ni62).
- [url_launcher 6.3.2 on pub.dev](https://pub.dev/packages/url_launcher) and [`LaunchMode`](https://pub.dev/documentation/url_launcher/latest/url_launcher/LaunchMode.html).
- [Dart `Uri.host`](https://api.dart.dev/stable/dart-core/Uri/host.html).
