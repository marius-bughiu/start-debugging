---
title: "Lösung: YouTube-Embed zeigt \"Video unavailable\" (Error 152 / 153) in Flutter mit youtube_player_iframe"
description: "Error 153 bedeutet, dass YouTube keinen Referer erhalten hat; 152 bedeutet, dass die Seite vorgibt, youtube.com zu sein. Aktualisieren Sie youtube_player_iframe auf 6.0.2 und setzen Sie origin auf https://<your app id>, oder verwenden Sie youtube-nocookie unter 5.x."
pubDate: 2026-09-26
template: error-page
tags:
  - "errors"
  - "flutter"
  - "webview"
  - "ios"
  - "android"
lang: "de"
translationOf: "2026/09/fix-youtube-embed-video-unavailable-error-152-153-in-flutter-youtube-player-iframe"
translatedBy: "claude"
translationDate: 2026-09-26
---

YouTube verweigert inzwischen die Wiedergabe eines Embeds, wenn es nicht feststellen kann, wer es einbettet, und in einer Flutter-App ist diese Identität der Origin der HTML-Seite, die `youtube_player_iframe` in die WebView lädt. Error 153 bedeutet, dass die Seite überhaupt keinen Origin hatte und deshalb kein `Referer` gesendet wurde. Error 152 bedeutet, dass die Seite vorgab, `https://www.youtube.com` zu sein, und genau das tun `youtube_player_iframe` 5.2.2 und ältere Versionen standardmäßig. Die Lösung besteht darin, auf `youtube_player_iframe` 6.0.2 zu aktualisieren und `YoutubePlayerParams(origin: 'https://com.yourcompany.yourapp')` zu setzen. Wenn Sie auf 5.x festsitzen, setzen Sie stattdessen `origin: 'https://www.youtube-nocookie.com'`, und niemals Ihre App-ID.

Alles Folgende wurde auf einem iOS-26.5-Simulator (iPhone 17 Pro Max, Xcode 27.0) mit Flutter 3.44.8 / Dart 3.12.2, `webview_flutter` 4.14.1 und `webview_flutter_wkwebview` 3.26.1 gemessen und mit dem Quellcode von `youtube_player_iframe` 5.2.2 und 6.0.2 abgeglichen. Die Testmatrix habe ich nicht auf Android ausgeführt, die Hinweise zu Android stammen also aus der YouTube-Dokumentation und dem Paketquellcode, nicht von einem Gerät.

## Der Fehler im Kontext

Im Player-Bereich erscheint statt des Videos YouTubes eigene Fehlerkarte:

```text
Video unavailable
Error 153
Video player configuration error
```

oder, bei der anderen Variante (gemeldet in [youtube_player_flutter#1155](https://github.com/sarbagyastha/youtube_player_flutter/issues/1155) mit `youtube_player_iframe` ^5.2.1):

```text
This video is unavailable
Error 152-4
Watch on YouTube
```

Ab August 2025 spielten Apps, die sich seit Monaten nicht verändert hatten, über Nacht dieselben Videos nicht mehr ab. Deshalb sammelten Issues wie [#1084 "Working App Broke In prod, Youtube Changed Something"](https://github.com/sarbagyastha/youtube_player_flutter/issues/1084) und [#1124 "Error code 153"](https://github.com/sarbagyastha/youtube_player_flutter/issues/1124) Dutzende "same here"-Kommentare. Die Videos sind öffentlich und einbettbar, sie laufen im mobilen Chrome und scheitern nur innerhalb der App.

## Warum YouTube das Embed ablehnt

Die Seite [YouTube API Services Required Minimum Functionality](https://developers.google.com/youtube/terms/required-minimum-functionality) verlangt, dass Clients, die den eingebetteten Player einschließlich der IFrame Player API verwenden, "must provide identification through the HTTP Referer request header". Ein Browser erledigt das von selbst: Das `<iframe>`, das auf `youtube.com/embed/...` zeigt, wird mit einem `Referer` angefordert, der von der umgebenden Seite abgeleitet ist, unter der empfohlenen Policy `strict-origin-when-cross-origin`. Eine mobile WebView hat keine Seite, aus der sie ihn ableiten könnte, solange Sie ihr keine geben. Für lokales HTML ist der dokumentierte Weg die Base-URL: `loadDataWithBaseURL` auf Android und `loadHTMLString:baseURL:` auf iOS, mit einem Wert der Form `https://<app-id>`, zum Beispiel `https://com.google.android.youtube`.

Die [IFrame-API-Referenz](https://developers.google.com/youtube/iframe_api_reference) führt Error 153 inzwischen als "The request does not include the HTTP Referer header or equivalent API Client identification." Error 152 ist nicht dokumentiert. `youtube_player_iframe` behandelt ihn als weiteren "nicht einbettbar"-Code, doch in meinen Messungen tritt er bei einem völlig einbettbaren Video immer dann auf, wenn der Origin der einbettenden Seite `https://www.youtube.com` ist. YouTube identifiziert den Einbettenden als YouTube selbst und lehnt ab.

Nun zu dem, was das Paket tut. `youtube_player_iframe` lädt keine YouTube-URL; es lädt ein mitgeliefertes `assets/player.html` mit `WebViewController.loadHtmlString`, und diese Seite erzeugt den Player über die IFrame API. In 5.2.2 sieht der relevante Code so aus:

```dart
// youtube_player_iframe 5.2.2, lib/src/player_params.dart
this.origin = 'https://www.youtube.com',

// youtube_player_iframe 5.2.2, lib/src/controller/youtube_player_controller.dart
baseUrl: kIsWeb ? Uri.base.origin : params.origin,
// ...
'host': params.origin ?? 'https://www.youtube.com',
```

Standardmäßig erhält die lokale HTML-Seite also den Origin `https://www.youtube.com`, der Player wird mit `host: 'https://www.youtube.com'` erzeugt, und auch die Player-Variablen `origin` und `widget_referrer` sind `https://www.youtube.com`. Das ist Error 152. Und weil ein einziger Parameter sowohl den Seiten-Origin als auch den Iframe-Host speist, lässt sich das nicht beheben, indem Sie Ihre App-ID in `origin` eintragen: Der Player versucht dann, das Iframe von `https://com.yourcompany.yourapp` zu laden, das nicht existiert.

Version 6.0.0 (2026-05-16) hat beides getrennt. `origin` ist jetzt standardmäßig `null`, ein neues `privacyEnhancedMode` (Standard `true`) wählt den Host, und die Base-URL fällt auf diesen Host zurück:

```dart
// youtube_player_iframe 6.0.2, lib/src/player_params.dart
String get host => privacyEnhancedMode
    ? 'https://www.youtube-nocookie.com'
    : 'https://www.youtube.com';

// youtube_player_iframe 6.0.2, lib/src/controller/youtube_player_controller.dart
baseUrl: kIsWeb ? Uri.base.origin : (params.origin ?? params.host),
```

Der Maintainer hat [#1155](https://github.com/sarbagyastha/youtube_player_flutter/issues/1155) mit "Fixed with v6.0.0" geschlossen, und die 153-Meldungen ([#1124](https://github.com/sarbagyastha/youtube_player_flutter/issues/1124), [#1150](https://github.com/sarbagyastha/youtube_player_flutter/issues/1150)) wurden am 2026-05-30 mit dem Release von 6.0.1 geschlossen.

## Minimale Reproduktion: eine Matrix von Seiten-Origins

Um zu sehen, welche Kombination YouTube akzeptiert, habe ich das Paket auf das reduziert, was es tatsächlich tut: ein `WebViewController`, der eine kleine HTML-Seite mit `loadHtmlString` lädt, einen `YT.Player` mit einem bestimmten `host` erzeugt, in `onReady` `playVideo()` aufruft und jedes `onStateChange` und `onError` über einen JavaScript-Kanal an Dart zurückmeldet. Das Video ist `M7lc1UVf-VE`, YouTubes eigene IFrame-API-Demo, die einbettbar ist.

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

Das sind die Ergebnisse, jeder Fall lief 25 Sekunden im Simulator (`state=1` bedeutet "wird abgespielt"):

| Fall | Seiten-Origin (`baseUrl`) | Player-`host` | Ergebnis |
| --- | --- | --- | --- |
| `youtube_player_iframe` 5.2.2 Standard | `https://www.youtube.com` | `https://www.youtube.com` | `ERROR=152` |
| 6.0.x mit `privacyEnhancedMode: false` | `https://www.youtube.com` | `https://www.youtube.com` | `ERROR=152` |
| Keine Base-URL (`about:blank`, Origin `null`) | keiner | `https://www.youtube.com` | `ERROR=153` |
| 5.x-Workaround, 6.0.x-Standard | `https://www.youtube-nocookie.com` | `https://www.youtube-nocookie.com` | `state=1`, spielt ab |
| App-ID + nocookie-Host | `https://com.example.ytrepro` | `https://www.youtube-nocookie.com` | `state=1`, spielt ab |
| App-ID + youtube.com-Host | `https://com.example.ytrepro` | `https://www.youtube.com` | `state=1`, spielt ab |
| App-ID im 5.x-`origin` (wird auch zum Host) | `https://com.example.ytrepro` | `https://com.example.ytrepro` | erreicht `onReady` nie |

Aus dieser Tabelle ergeben sich zwei Regeln. Eine Seite ohne Origin bekommt 153, eine Seite, die vorgibt, `youtube.com` zu sein, bekommt 152, und alles andere mit einem echten `https://`-Origin spielt ab. Außerdem muss der Iframe-Host ein echter YouTube-Host sein. Deshalb liefert Ihre App-ID im 5.x-Parameter `origin` einen stillen, leeren Player statt einer Lösung.

## Lösung 1: auf youtube_player_iframe 6.0.2 aktualisieren und origin auf Ihre App-ID setzen

Das ist die empfohlene Lösung. Sie erfordert Flutter 3.38 oder neuer und Dart 3.10 oder neuer, die neuen Mindestversionen in 6.0.0.

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

Wenn `origin` gesetzt ist, verwendet 6.0.2 den Wert als Base-URL für `loadHtmlString` sowie als Player-Variablen `origin` und `widget_referrer`, während das Iframe weiterhin von `youtube-nocookie.com` lädt (oder von `youtube.com`, wenn Sie `privacyEnhancedMode` abschalten). Das ist die Zeile "App-ID + nocookie-Host" oben, und sie entspricht dem Format `https://<app-id>`, das YouTube dokumentiert. Auf diesen Ansatz hatten sich auch die Mitwirkenden in [PR #1126](https://github.com/sarbagyastha/youtube_player_flutter/pull/1126) geeinigt, der genau diese Trennung von Origin und Host vorschlug, bevor 6.0.0 sie auslieferte.

Wenn Sie `origin` nicht setzen, funktioniert 6.0.2 trotzdem: Der Seiten-Origin fällt auf `https://www.youtube-nocookie.com` zurück (die Zeile "6.0.x-Standard"). Ihre App-ID zu setzen ist dennoch besser, weil YouTubes Bedingungen genau das verlangen und Sie sich nicht darauf verlassen müssen, dass YouTube `youtube-nocookie.com` weiterhin als zulässigen Einbettenden akzeptiert.

Das Upgrade von 5.x bringt eine Breaking Change mit sich, auf die Sie sofort stoßen: `YoutubePlayerScaffold` ist entfernt. Ersetzen Sie es durch `YoutubePlayer`, das den Vollbildmodus jetzt selbst übernimmt:

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

6.0.1 hat außerdem den Parameter `modestbranding` entfernt, löschen Sie ihn also, falls Sie ihn übergeben.

## Lösung 2: auf 5.x festgelegt, youtube-nocookie als origin verwenden

Wenn Sie noch nicht auf Flutter 3.38 wechseln können, lässt sich `youtube_player_iframe` 5.2.2 (Flutter 3.24+) mit einer einzeiligen Änderung beheben, die mehrere Personen in [#1112](https://github.com/sarbagyastha/youtube_player_flutter/issues/1112) und [#1155](https://github.com/sarbagyastha/youtube_player_flutter/issues/1155) bestätigt haben:

```dart
// youtube_player_iframe 5.2.2, Flutter 3.24+
final controller = YoutubePlayerController(
  params: const YoutubePlayerParams(
    origin: 'https://www.youtube-nocookie.com',
  ),
);
```

In 5.x wird dieser eine Wert gleichzeitig zum Seiten-Origin, zum Iframe-Host und zu den Player-Variablen. Das ist die Zeile "5.x-Workaround" in der Tabelle: ein echter YouTube-Host und ein Seiten-Origin, der nicht `youtube.com` ist. Tragen Sie unter 5.x hier nicht Ihre App-ID ein. Sie wird dann ebenfalls zum Iframe-Host, und der Player lädt nie.

## Lösung 3: eigene WebView, der Seite eine Base-URL geben

Wenn Sie YouTube selbst mit `webview_flutter` oder `flutter_inappwebview` einbetten statt über das Paket, gilt dieselbe Regel. Übergeben Sie beim Laden von lokalem HTML immer eine Base-URL, und zwar Ihre App-ID:

```dart
// webview_flutter 4.14.1
await controller.loadHtmlString(
  html,
  baseUrl: 'https://com.yourcompany.yourapp', // never omit: null gives Error 153
);
```

Wenn Sie statt lokalem HTML direkt eine Embed-URL laden, fügen Sie den Header selbst hinzu. `loadRequest` akzeptiert auf beiden Plattformen Header, was dem in der YouTube-Dokumentation beschriebenen Weg über `loadUrl(url, additionalHttpHeaders)` / `loadRequest:` entspricht:

```dart
// webview_flutter 4.14.1
await controller.loadRequest(
  Uri.parse('https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?playsinline=1'),
  headers: const {'Referer': 'https://com.yourcompany.yourapp/'},
);
```

Dasselbe gilt für `flutter_inappwebview`, das `youtube_player_flutter` intern verwendet: Übergeben Sie `baseUrl: WebUri('https://com.yourcompany.yourapp')` an `loadData`. [#1150](https://github.com/sarbagyastha/youtube_player_flutter/issues/1150) ist die Windows-Variante (WebView2) dieses Fehlers in jenem Paket.

## Fallstricke und ähnlich aussehende Fehler

**Ihr Fehlerhandler erkennt 152 oder 153 möglicherweise nicht als das, was sie sind.** `youtube_player_iframe` 6.0.2 bildet die rohen Codes über `YoutubeError.fromCode` ab, das `152` (`sameAsNotEmbeddable2`) kennt, aber nicht `153`, sodass ein 153 als `YoutubeError.unknown` ankommt. In 5.2.2 werden sowohl 152 als auch 153 auf `unknown` abgebildet. Wenn Sie anhand des Enums eine Meldung "Video nicht einbettbar" anzeigen, zeigen Sie das Falsche an. Protokollieren Sie beim Debuggen den rohen Code.

**Das Abschalten von `privacyEnhancedMode` in 6.x bringt 152 zurück**, sofern Sie nicht zusätzlich `origin` setzen. Mit `privacyEnhancedMode: false` und ohne `origin` fällt die Base-URL auf `https://www.youtube.com` zurück, was der zweiten Zeile der Tabelle entspricht. Setzen Sie `origin` auf Ihre App-ID, dann spielt auch der youtube.com-Host problemlos ab.

**Error 150 und 101 sind ein anderes Problem.** Sie bedeuten, dass der Eigentümer das Einbetten für dieses Video deaktiviert hat. Keine Änderung an Origin oder Referer behebt sie; öffnen Sie das Video stattdessen mit `url_launcher` in der YouTube-App.

**"This video is unavailable, Error code: 15"** aus dem September 2025 ([#1112](https://github.com/sarbagyastha/youtube_player_flutter/issues/1112), [#1125](https://github.com/sarbagyastha/youtube_player_flutter/issues/1125)) gehörte zur selben Familie von Identitätsprüfungen unter 5.x und lässt sich mit denselben Origin-Lösungen beheben.

**Flutter Web verhält sich anders.** Im Web ignoriert das Paket Ihren `origin` und verwendet `Uri.base.origin`, den echten Origin Ihrer Website, weil der Browser den `Referer` selbst sendet. Wenn Sie dort 153 erhalten, sendet Ihr Server mit ziemlicher Sicherheit `Referrer-Policy: no-referrer` oder `same-origin`, was den Header bei der Cross-Origin-Anfrage des Iframes entfernt. Stellen Sie ihn auf `strict-origin-when-cross-origin` um, wie von YouTube empfohlen, oder fügen Sie `<meta name="referrer" content="strict-origin-when-cross-origin">` zu `web/index.html` hinzu. Simon Willison ist mit dem Standardwert `same-origin` von Django auf dasselbe Problem gestoßen und hat [darüber geschrieben](https://til.simonwillison.net/youtube/fixing-153-embed). Wenn Sie Ihren Flutter-Web-Build zusätzlich hinter aggressivem Caching ausliefern, stellen Sie sicher, dass die neue `index.html` die Nutzer tatsächlich erreicht; [veraltete gecachte Builds nach dem Neuladen](/de/2026/09/fix-flutter-web-serves-a-stale-cached-build-after-reload/) sind eine eigene Falle.

**Navigation-Delegates können die Lösung zunichtemachen.** Wenn Sie den Player in Ihren eigenen `NavigationDelegate` einbetten und jede Navigation verhindern, die nicht zu Ihrer Domain gehört, können Sie die eigenen Frames des Embeds blockieren. Erlauben Sie die YouTube-Hosts explizit; der Host-Abgleich aus [wie man eine Flutter-WebView an der Navigation zu externen URLs hindert](/de/2026/09/how-to-block-a-flutter-webview-from-navigating-to-external-urls/) funktioniert mit einer Allowlist aus `www.youtube.com`, `www.youtube-nocookie.com` und `m.youtube.com`.

**Das Öffnen der Video-URL ist ein anderer Bug.** [flutter/flutter#178705](https://github.com/flutter/flutter/issues/178705) meldet 153 beim Öffnen eines Links mit `launchUrl`, wodurch Ihre App komplett verlassen wird. Das Issue wurde als ungültig geschlossen und betrifft den Browser oder die YouTube-App auf dem Gerät, nicht Ihre WebView.

## Verwandte Artikel

- [Wie man eine Flutter-WebView an der Navigation zu externen URLs hindert](/de/2026/09/how-to-block-a-flutter-webview-from-navigating-to-external-urls/) behandelt den Host-Abgleich mit `NavigationDelegate` in `webview_flutter` 4.14.1.
- [Flutter-Text wird in einer Android-WebView bei System-Schriftskalierung außerhalb des Bildschirms gerendert](/de/2026/09/fix-flutter-text-renders-off-screen-in-an-android-webview-with-font-scaling/) ist ein weiterer WebView-Einbettungsfehler mit einer Lösung über einen einzigen Parameter.
- [Flutter Web liefert nach dem Neuladen einen veralteten gecachten Build aus](/de/2026/09/fix-flutter-web-serves-a-stale-cached-build-after-reload/) ist relevant, wenn Sie die obige Änderung an der Web-`index.html` ausliefern.
- [Flutter 3.44 lagert Material und Cupertino aus dem SDK aus](/de/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/) lohnt sich vor dem Upgrade auf Flutter 3.38+, das `youtube_player_iframe` 6.x benötigt.

## Quellen

- [YouTube API Services: Required Minimum Functionality, Identität des API-Clients und Referer-Format](https://developers.google.com/youtube/terms/required-minimum-functionality)
- [YouTube IFrame Player API Referenz, onError-Codes](https://developers.google.com/youtube/iframe_api_reference)
- [youtube_player_iframe Changelog (5.2.2, 6.0.0, 6.0.1, 6.0.2)](https://pub.dev/packages/youtube_player_iframe/changelog)
- [sarbagyastha/youtube_player_flutter#1155: Error 152-4 unter 5.2.1, behoben in 6.0.0](https://github.com/sarbagyastha/youtube_player_flutter/issues/1155)
- [sarbagyastha/youtube_player_flutter#1124: Error code 153](https://github.com/sarbagyastha/youtube_player_flutter/issues/1124)
- [sarbagyastha/youtube_player_flutter#1112: Error code 15 und der youtube-nocookie-Origin-Workaround](https://github.com/sarbagyastha/youtube_player_flutter/issues/1112)
- [sarbagyastha/youtube_player_flutter#1126: Origin getrennt vom Host senden](https://github.com/sarbagyastha/youtube_player_flutter/pull/1126)
- [Simon Willison: Error 153 Video player configuration error on YouTube embeds](https://til.simonwillison.net/youtube/fixing-153-embed)
