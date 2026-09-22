---
title: "So verhindern Sie, dass eine Flutter-WebView mit NavigationDelegate zu externen URLs navigiert"
description: "Halten Sie eine Flutter-WebView mit webview_flutter 4.14.1 auf Ihrer eigenen Domain: URL parsen, Uri.host statt startsWith vergleichen, mailto: und tel: an url_launcher übergeben und wissen, was Android und iOS tatsächlich an onNavigationRequest senden."
pubDate: 2026-09-22
template: how-to
tags:
  - "flutter"
  - "dart"
  - "webview"
  - "security"
  - "android"
  - "ios"
lang: "de"
translationOf: "2026/09/how-to-block-a-flutter-webview-from-navigating-to-external-urls"
translatedBy: "claude"
translationDate: 2026-09-22
---

**Kurze Antwort:** Mit `webview_flutter` 4.14.1 unter Flutter 3.44 geben Sie dem `WebViewController` einen `NavigationDelegate`, dessen `onNavigationRequest` die `request.url` mit `Uri.tryParse` parst, nur dann `NavigationDecision.navigate` zurückgibt, wenn `uri.scheme == 'https'` gilt und `uri.host` auf Ihrer Allowlist steht, und für alles andere `NavigationDecision.prevent` liefert. Optional öffnet er den blockierten Link mit `url_launcher` im Systembrowser. Verwenden Sie nicht `url.startsWith('https://example.com')`: Damit kommen `https://example.com.evil.net` und `https://example.com@evil.net` durch. Und kennen Sie die Grenzen: Unter Android sieht der Callback weder Subframe-Navigationen noch POST-Formularübermittlungen.

Der Rest dieses Beitrags baut diese Richtlinie Schritt für Schritt auf, zeigt die Testtabelle, die beweist, dass die naive Prüfung falsch ist, und geht die Plattformunterschiede durch, die bestimmen, was Ihr Callback blockieren kann und was nicht. Alles Folgende wurde mit `webview_flutter` 4.14.1, `webview_flutter_android` 4.14.1, `webview_flutter_wkwebview` 3.26.1 und `url_launcher` 6.3.2 unter Flutter 3.44.8 / Dart 3.12.2 kompiliert und getestet.

## Warum eine WebView Ihre Website verlässt

Ein eingebettetes Hilfecenter, eine Checkout-Seite oder ein Bildschirm mit Nutzungsbedingungen soll in der Regel eine einzige Website anzeigen. Die Seite weiß das nicht. Sie enthält Footer-Links zu Twitter, ein "powered by"-Badge, einen OAuth-Button, eine `mailto:`-Supportadresse und vielleicht nutzergenerierte Inhalte mit beliebigen Links. Ein Tipp auf einen davon, und die WebView lädt ihn bereitwillig innerhalb Ihrer App, ohne Adressleiste, ohne Zurück-Button, sofern Sie keinen gebaut haben, und mit dem Namen Ihrer App oben auf dem Bildschirm. Das ist ein UX-Problem (Nutzer stranden auf einer fremden Website) und ein Vertrauensproblem (eine Phishing-Seite, die in Ihrer App gerendert wird, erbt die Glaubwürdigkeit Ihrer App).

`webview_flutter` bietet dafür genau einen Hook: `NavigationDelegate.onNavigationRequest`. Seine Signatur in 4.14.1 lautet:

```dart
// webview_flutter 4.14.1
FutureOr<NavigationDecision> Function(NavigationRequest request)? onNavigationRequest
```

`NavigationRequest` trägt genau zwei Felder, `url` (ein `String`) und `isMainFrame` (ein `bool`), und `NavigationDecision` hat zwei Werte, `navigate` und `prevent`. Alles andere liegt bei Ihnen.

## Das README-Beispiel ist der Bug

Das offizielle README des Pakets zeigt dieses Snippet:

```dart
// From the webview_flutter 4.14.1 README
onNavigationRequest: (NavigationRequest request) {
  if (request.url.startsWith('https://www.youtube.com/')) {
    return NavigationDecision.prevent;
  }
  return NavigationDecision.navigate;
},
```

Als Denylist-Demo ist das in Ordnung. Kehren Sie es in eine Allowlist um, was die meisten tun, erhalten Sie `if (request.url.startsWith('https://example.com')) navigate else prevent`. URLs funktionieren aber nicht über String-Präfixe. Ich habe 16 URLs sowohl durch die naive Präfixprüfung als auch durch die weiter unten gebaute Richtlinienklasse geschickt:

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

Zwei Zeilen sind die gefährlichen. `https://example.com.evil.net/login` ist ein Host, der demjenigen gehört, der `evil.net` registriert hat. `https://example.com@evil.net/login` setzt `example.com` in den Userinfo-Teil der URL, sodass der Browser sich mit `evil.net` verbindet. Beide bestehen die Präfixprüfung und werden in Ihrer App gerendert. Die übrigen Abweichungen sind falsch-negative Ergebnisse: Ein großgeschriebener Host oder eine Subdomain fliegt grundlos aus der WebView.

Die Lösung besteht darin, das Parsen `Uri` zu überlassen. `Uri.parse('https://EXAMPLE.com@evil.net:8443/x').host` liefert `evil.net`: kleingeschrieben, ohne Userinfo und Port. Vergleichen Sie diesen Wert, niemals den rohen String.

## Die Allowlist-Richtlinie aufbauen

Halten Sie die Entscheidung in einer einfachen Dart-Klasse ohne Flutter- oder Plugin-Imports. Dadurch ist sie mit `flutter test` unit-testbar, was wichtig ist, weil Sie in einem Widget-Test keine echte WebView ausführen können.

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

Einige Entscheidungen sind hier bewusst getroffen:

- **Drei Ergebnisse, nicht zwei.** `NavigationDecision` ist binär, aber "nicht in der WebView" zerfällt in "woanders öffnen" und "verwerfen". Ein Link zu Ihrer Twitter-Seite sollte den Browser öffnen. Eine `javascript:`- oder `file:`-URL sollte nirgendwohin führen.
- **Die Subdomain-Prüfung verwendet `'.$allowed'`**, mit dem führenden Punkt. `host.endsWith('example.com')` würde `notexample.com` akzeptieren, was dieselbe Fehlerklasse wie die Präfixprüfung ist.
- **`http` ist in der App nie erlaubt.** Wenn Ihre eigene Website noch einen `http`-Link ausliefert, verlässt dieser die App, statt ohne TLS zu laden. Ändern Sie das nur, wenn Sie es wirklich brauchen, und beachten Sie, dass Android Klartext seit API 28 ohnehin standardmäßig blockiert, sofern Ihre Network Security Config ihn nicht erlaubt.
- **`about:blank` ist erlaubt.** Unter iOS erscheinen sowohl `loadHtmlString` ohne `baseUrl` als auch ein frisch geöffneter leerer Frame als `about:blank`. Wer das blockiert, macht diese Abläufe kaputt.
- **Unbekannte Schemes werden blockiert, nicht gestartet.** `intent://` kann unter Android jede exportierte Activity auf dem Gerät ansprechen. Wenn Sie ein bestimmtes eigenes Scheme brauchen (Ihr eigenes `myapp://` oder `market://`), fügen Sie es explizit zu `externalSchemes` hinzu.

Die Tabelle oben ist die Ausgabe dieser Testdatei, die mit `flutter test` in etwa einer Sekunde durchläuft:

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

## Die Richtlinie in den NavigationDelegate einbinden

Die Schritte, in dieser Reihenfolge:

1. Fügen Sie die Pakete hinzu: `flutter pub add webview_flutter url_launcher`. `webview_flutter` 4.14.1 benötigt Flutter 3.38 oder neuer, Android SDK 24+ und iOS 13+.
2. Erstellen Sie den `WebViewController` einmal, in `initState`, nicht in `build`.
3. Rufen Sie `setNavigationDelegate` mit einem `onNavigationRequest` auf, das jede `LinkAction` auf eine `NavigationDecision` abbildet.
4. Starten Sie für `openExternally` `launchUrl` mit `LaunchMode.externalApplication` und geben Sie sofort `prevent` zurück.
5. Rufen Sie `loadRequest` zuletzt auf, nachdem der Delegate gesetzt ist.

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

`flutter analyze` meldet für diese Datei keine Probleme. Zwei Details verdienen besondere Erwähnung.

Der Callback gibt synchron zurück. `onNavigationRequest` akzeptiert ein `Future<NavigationDecision>`, aber unter iOS wartet das Plugin per `await` auf Ihren Callback innerhalb von WebKits `decidePolicyForNavigationAction`, sodass jede Millisekunde, die Sie dort verbringen, eine Millisekunde ist, in der die Seite eingefroren bleibt. Auf `launchUrl` zu warten (was darauf wartet, dass das Betriebssystem die App wechselt), ist dort genau das Falsche. Entscheiden Sie synchron, geben Sie zurück und starten Sie im Hintergrund mit `unawaited`.

Die `mounted`-Prüfung nach `await launchUrl` ist da, weil der Nutzer die Seite womöglich bereits geschlossen hat, wenn das Betriebssystem antwortet. Falls Ihnen dieses Muster neu ist: Ich habe es ausführlich in [BuildContext sicher nach einem await verwenden](/de/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) behandelt.

## Was Android und iOS tatsächlich an onNavigationRequest senden

Das ist der Teil, den die Dokumentation mit "some platforms may also trigger this callback from calls to `loadRequest`" überspielt. Ich habe die Plattformimplementierungen in `webview_flutter_android` 4.14.1 und `webview_flutter_wkwebview` 3.26.1 gelesen, und die beiden verhalten sich sehr unterschiedlich.

### Android: Die native Seite bricht zuerst ab, Dart setzt neu an

Unter Android wird der Callback von `WebViewClient.shouldOverrideUrlLoading` gesteuert. Sobald Sie `onNavigationRequest` setzen, ruft das Plugin `setSynchronousReturnValueForShouldOverrideUrlLoading(true)` auf. Ab dann gibt die native `WebViewClientProxyApi` für jede Navigation `request.isForMainFrame() && true` zurück: Jede Main-Frame-Navigation wird sofort abgebrochen, noch bevor Dart überhaupt gefragt wurde. Dart führt dann Ihren Callback aus, und wenn dieser `navigate` zurückgibt, ruft das Plugin `loadUrl` mit derselben URL und den ursprünglichen Request-Headern auf.

Die Folgen:

- **Nach Subframes wird nie gefragt.** `_handleNavigation` kehrt vorzeitig zurück, wenn `isForMainFrame` false ist, weil `loadUrl` keine URL in einen iframe laden kann. Ein iframe auf Ihrer Seite kann überallhin navigieren, und Ihr Callback läuft nie. Deshalb kümmert sich der Code oben nicht darum, `isMainFrame == false` zu kontrollieren.
- **POST-Navigationen umgehen den Callback.** Die Android-Dokumentation selbst sagt, dass `shouldOverrideUrlLoading` für POST-Requests nicht aufgerufen wird. Ein `<form method="post" action="https://evil.net/collect">` auf einer Seite, die Sie erlaubt haben, wird abgeschickt und lädt `evil.net` in Ihrer WebView.
- **`loadRequest` wird nicht geprüft.** URLs, die Sie selbst über den Controller laden, laufen nicht durch `shouldOverrideUrlLoading`.
- **Zurück, Vorwärts und Neuladen werden nicht geprüft.** Das sind Verlaufsoperationen, keine neuen Navigationen.
- **Downloads laufen über denselben Callback.** Der `DownloadListener` des Plugins ruft `_handleNavigation` für eine Download-URL auf, sodass eine Allowlist auch Downloads von anderen Hosts stoppt.

### iOS und macOS: WebKit wartet auf Ihre Antwort

Unter WebKit wird der Callback von `WKNavigationDelegate.webView(_:decidePolicyFor:decisionHandler:)` gesteuert. Das Plugin wartet auf Ihren Callback und bildet `navigate` auf `.allow` und `prevent` auf `.cancel` ab. Nichts wird neu abgesetzt, daher bleiben POST-Bodys und Header intakt.

Die Folgen:

- **Der initiale `loadRequest` landet in Ihrem Callback.** Wenn Ihre Allowlist die URL, die Sie in `initState` laden, nicht enthält, erhalten Sie eine leere Seite und keinen Fehler. Die `about:blank`-Regel in der Richtlinie existiert aus demselben Grund, wenn Sie `loadHtmlString` verwenden.
- **Nach Subframes wird gefragt.** Jeder iframe-Ladevorgang, einschließlich eingebetteter YouTube-Player, Stripe Elements und reCAPTCHA, kommt mit `isMainFrame: false` an. Behandeln Sie diese wie Main-Frame-Navigationen, machen Sie jede Einbettung auf der Seite kaputt.
- **`target="_blank"`-Links kommen zweimal an.** Eine Anfrage für ein neues Fenster hat zunächst einen null-Zielframe, also ist `isMainFrame` `false`. Das `WKUIDelegate` `onCreateWebView` des Plugins lädt diese Anfrage dann in dieselbe WebView, und sie kommt als Main-Frame-Navigation erneut durch Ihren Callback. Beim zweiten Aufruf greift Ihre Richtlinie, ein weiterer Grund, `isMainFrame == false` durchzulassen.

Wenn Sie iframes auf beiden Plattformen einheitlich kontrollieren müssen, ist der Navigation Delegate das falsche Werkzeug. Senden Sie von Ihrem eigenen Server einen `Content-Security-Policy`-Header mit `frame-src`, den beide WebViews durchsetzen.

## Fallstricke, durch die Traffic an der Allowlist vorbeischlüpft

Der Navigation Delegate steuert Seitennavigationen. Er sieht nicht:

- **Subressourcen.** Bilder, Skripte, `fetch`- und `XMLHttpRequest`-Aufrufe an andere Hosts laden ganz normal. `onNavigationRequest` ist keine Firewall. Wenn eine Seite, die Sie erlaubt haben, dazu gebracht werden kann, Angreiferskript auszuführen, kann dieses Skript Daten per `fetch` abfließen lassen, und Ihr Callback wird nie ausgelöst. Beheben Sie das in der Seite (CSP `connect-src`), nicht in der WebView.
- **Routenwechsel in Single-Page-Apps.** `history.pushState` ändert die URL ohne Navigation. Hören Sie auf `onUrlChange`, wenn Sie das verfolgen müssen; es lässt sich nicht blockieren, kann aber auch den Origin nicht ändern und ist daher kein Fluchtweg.
- **POST unter Android**, siehe oben. Wenn Nutzer auf der eingebetteten Website Formulare absenden können, validieren Sie `action`-URLs serverseitig.
- **Weiterleitungsketten.** Eine Server-Weiterleitung von einer erlaubten URL auf einen anderen Host wird unter Android an `shouldOverrideUrlLoading` gemeldet (der Fall `WebResourceRequest.isRedirect()`) und unter WebKit an die Navigation-Policy-Prüfung, sodass die Allowlist weiterhin greift. Testen Sie es trotzdem mit Ihrem echten Login-Ablauf, denn OAuth-Anbieter lieben Weiterleitungen über vier Stationen.

Drei weitere, die in der Praxis zubeißen:

- **OAuth und SSO.** Wenn Ihre Website Nutzer über `accounts.google.com` oder einen Entra-ID-Tenant anmeldet, müssen diese Hosts auf der Allowlist stehen, sonst springt der Ablauf in den Browser und kommt nie zurück. Google weigert sich zudem, seine Anmeldeseite überhaupt in einer eingebetteten WebView anzuzeigen, daher ist die eigentliche Lösung für Google Sign-In `flutter_web_auth_2` oder ein natives SDK, keine längere Allowlist.
- **`intent://`-Links unter Android.** Websites, die per Deep Link in Apps springen, verwenden `intent://...#Intent;...;end`-URLs. Chrome versteht sie; `url_launcher` parst die Intent-Syntax nicht. Sie zu blockieren, wie es die Richtlinie tut, ist der sichere Standard. Wenn Sie sie brauchen, parsen Sie den Parameter `S.browser_fallback_url` und öffnen Sie stattdessen diesen.
- **Internationalisierte Domains.** Darts `Uri` führt keine IDNA-Konvertierung durch: `Uri.parse('https://bücher.example/x').host` ergibt `b%C3%BCcher.example`, während `https://xn--bcher-kva.example/x` als `xn--bcher-kva.example` erhalten bleibt. Die WebViews melden in der Regel die Punycode-Form, also tragen Sie die `xn--`-Schreibweise in Ihre Allowlist ein.

Wenn Ihre WebView Ihren eigenen Flutter-Web-Build statt einer gewöhnlichen Website anzeigt, liegt das In-App-Routing in Ihrem Router, nicht in der WebView, und [verschachtelte Routen und Deep Links mit go_router](/de/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/) ist der relevantere Beitrag. Die Schriftskalierung innerhalb dieses eingebetteten Flutter-Web-Builds ist eine eigene Falle, die ich in [Flutter-Text, der in einer Android-WebView außerhalb des Bildschirms gerendert wird](/de/2026/09/fix-flutter-text-renders-off-screen-in-an-android-webview-with-font-scaling/) beschrieben habe.

## Asynchrone Entscheidungen verhalten sich je nach Plattform unterschiedlich

Weil Android zuerst abbricht und später neu ansetzt, blockiert ein `async`-Callback unter Android die Seite nie: Die alte Seite bleibt voll bedienbar auf dem Bildschirm, bis Ihr `Future` abgeschlossen ist und das Plugin `loadUrl` aufruft. Tippt der Nutzer in der Zwischenzeit auf einen zweiten Link, laufen beide Entscheidungen, und der zuletzt ausgeführte `loadUrl` gewinnt. Unter iOS hält derselbe `async`-Callback den Decision Handler von WebKit offen, also wartet die Seite. Wenn Ihre Richtlinie wirklich I/O braucht (etwa um eine entfernte Allowlist abzurufen), laden Sie diese einmal, bevor die Seite geöffnet wird, und halten Sie `onNavigationRequest` synchron, wie im Beispiel oben. Das ergibt auf beiden Plattformen identisches Verhalten.

Wenn Sie Kontrolle brauchen, die die plattformübergreifende API nicht bietet, etwa das Abfangen von Subressourcen-Requests mit `shouldInterceptRequest`, gibt es dafür in 4.14.1 keinen Dart-Hook. Das bedeutet nativen Code, und dann gilt der Ansatz aus [plattformspezifischen Code in Flutter ohne Plugins hinzufügen](/de/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/). Probieren Sie zuerst die Allowlist; für die allermeisten eingebetteten Seiten reicht sie aus.

Denken Sie schließlich daran, dass alles, was Sie im App-Binary ausliefern, einschließlich der Allowlist, für jeden lesbar ist, der die APK oder IPA entpackt. Für eine Liste von Hostnamen ist das in Ordnung, aber es ist eine gute Erinnerung daran, [was ein Angreifer aus einer Flutter-App extrahieren kann](/de/2026/01/flutterguard-cli-a-fast-what-can-an-attacker-extract-check-for-flutter-3-x-apps/): Die Allowlist schützt Ihre Nutzer davor, sich zu verirren, sie ist kein Geheimnis.

## Quellen

- [webview_flutter 4.14.1 auf pub.dev](https://pub.dev/packages/webview_flutter), einschließlich des README-Beispiels zu `onNavigationRequest` und der Tabelle zur Plattformunterstützung.
- [`NavigationDelegate`-API-Referenz](https://pub.dev/documentation/webview_flutter/latest/webview_flutter/NavigationDelegate-class.html).
- [Quellcode von webview_flutter_android](https://github.com/flutter/packages/tree/main/packages/webview_flutter/webview_flutter_android): `android_webview_controller.dart` (`_handleNavigation`) und `WebViewClientProxyApi.java` (`shouldOverrideUrlLoading`).
- [Quellcode von webview_flutter_wkwebview](https://github.com/flutter/packages/tree/main/packages/webview_flutter/webview_flutter_wkwebview): `webkit_webview_controller.dart` (`decidePolicyForNavigationAction`, `onCreateWebView`).
- [Android `WebViewClient.shouldOverrideUrlLoading`](https://developer.android.com/reference/android/webkit/WebViewClient#shouldOverrideUrlLoading(android.webkit.WebView,%20android.webkit.WebResourceRequest)).
- [Apple `webView(_:decidePolicyFor:decisionHandler:)`](https://developer.apple.com/documentation/webkit/wknavigationdelegate/webview(_:decidepolicyfor:decisionhandler:)-2ni62).
- [url_launcher 6.3.2 auf pub.dev](https://pub.dev/packages/url_launcher) und [`LaunchMode`](https://pub.dev/documentation/url_launcher/latest/url_launcher/LaunchMode.html).
- [Dart `Uri.host`](https://api.dart.dev/stable/dart-core/Uri/host.html).
