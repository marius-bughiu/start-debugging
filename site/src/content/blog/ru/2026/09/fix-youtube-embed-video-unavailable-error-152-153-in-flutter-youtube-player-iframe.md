---
title: "Исправление: встроенное видео YouTube показывает \"Video unavailable\" (Error 152 / 153) во Flutter с youtube_player_iframe"
description: "Error 153 означает, что YouTube не получил Referer; 152 означает, что страница выдаёт себя за youtube.com. Обновите youtube_player_iframe до 6.0.2 и задайте origin как https://<id вашего приложения> или используйте youtube-nocookie на 5.x."
pubDate: 2026-09-26
template: error-page
tags:
  - "errors"
  - "flutter"
  - "webview"
  - "ios"
  - "android"
lang: "ru"
translationOf: "2026/09/fix-youtube-embed-video-unavailable-error-152-153-in-flutter-youtube-player-iframe"
translatedBy: "claude"
translationDate: 2026-09-26
---

YouTube теперь отказывается воспроизводить встроенное видео, если не может определить, кто его встраивает, а во Flutter-приложении такой идентификацией служит origin HTML-страницы, которую `youtube_player_iframe` загружает в WebView. Error 153 означает, что у страницы вообще не было origin, поэтому `Referer` не отправлялся. Error 152 означает, что страница выдавала себя за `https://www.youtube.com`, а именно так по умолчанию и поступают `youtube_player_iframe` 5.2.2 и более старые версии. Исправление: обновиться до `youtube_player_iframe` 6.0.2 и задать `YoutubePlayerParams(origin: 'https://com.yourcompany.yourapp')`. Если вы застряли на 5.x, задайте вместо этого `origin: 'https://www.youtube-nocookie.com'`, но ни в коем случае не ID приложения.

Всё описанное ниже измерено на симуляторе iOS 26.5 (iPhone 17 Pro Max, Xcode 27.0) с Flutter 3.44.8 / Dart 3.12.2, `webview_flutter` 4.14.1 и `webview_flutter_wkwebview` 3.26.1 и сверено с исходным кодом `youtube_player_iframe` 5.2.2 и 6.0.2. На Android я эту матрицу не прогонял, поэтому замечания про Android взяты из документации YouTube и исходников пакета, а не с устройства.

## Ошибка в контексте

Вместо видео в области плеера отображается собственная карточка ошибки YouTube:

```text
Video unavailable
Error 153
Video player configuration error
```

или, во втором варианте (описан в [youtube_player_flutter#1155](https://github.com/sarbagyastha/youtube_player_flutter/issues/1155) для `youtube_player_iframe` ^5.2.1):

```text
This video is unavailable
Error 152-4
Watch on YouTube
```

Начиная с августа 2025 года приложения, которые месяцами не менялись, за одну ночь перестали воспроизводить те же самые видео, поэтому такие issue, как [#1084 "Working App Broke In prod, Youtube Changed Something"](https://github.com/sarbagyastha/youtube_player_flutter/issues/1084) и [#1124 "Error code 153"](https://github.com/sarbagyastha/youtube_player_flutter/issues/1124), собрали десятки комментариев "у меня то же самое". Видео публичные и разрешены для встраивания, в мобильном Chrome они воспроизводятся, а ломаются только внутри приложения.

## Почему YouTube отклоняет встраивание

На странице [YouTube API Services Required Minimum Functionality](https://developers.google.com/youtube/terms/required-minimum-functionality) сказано, что клиенты, использующие встроенный плеер, включая IFrame Player API, должны идентифицировать себя через HTTP-заголовок запроса Referer. Браузер делает это сам: `<iframe>`, указывающий на `youtube.com/embed/...`, запрашивается с `Referer`, полученным из содержащей его страницы, в соответствии с рекомендуемой политикой `strict-origin-when-cross-origin`. У мобильного WebView нет страницы, из которой его можно получить, если вы её не зададите. Для локального HTML документированный способ это базовый URL: `loadDataWithBaseURL` на Android и `loadHTMLString:baseURL:` на iOS со значением вида `https://<app-id>`, например `https://com.google.android.youtube`.

В [справочнике IFrame API](https://developers.google.com/youtube/iframe_api_reference) ошибка 153 теперь описана как запрос, в котором нет HTTP-заголовка Referer или эквивалентной идентификации API-клиента. Ошибка 152 не документирована. `youtube_player_iframe` считает её ещё одним кодом "встраивание запрещено", но в моих измерениях она срабатывает на вполне встраиваемом видео всякий раз, когда origin встраивающей страницы равен `https://www.youtube.com`. YouTube определяет встраивающую сторону как сам YouTube и отказывает.

Теперь посмотрим, что делает пакет. `youtube_player_iframe` не загружает URL YouTube; он загружает встроенный в пакет `assets/player.html` через `WebViewController.loadHtmlString`, и эта страница создаёт плеер через IFrame API. В 5.2.2 соответствующий код такой:

```dart
// youtube_player_iframe 5.2.2, lib/src/player_params.dart
this.origin = 'https://www.youtube.com',

// youtube_player_iframe 5.2.2, lib/src/controller/youtube_player_controller.dart
baseUrl: kIsWeb ? Uri.base.origin : params.origin,
// ...
'host': params.origin ?? 'https://www.youtube.com',
```

Итак, по умолчанию локальная HTML-страница получает origin `https://www.youtube.com`, плеер создаётся с `host: 'https://www.youtube.com'`, а переменные плеера `origin` и `widget_referrer` тоже равны `https://www.youtube.com`. Это и есть ошибка 152. И поскольку один параметр определяет и origin страницы, и хост iframe, исправить ситуацию, указав ID приложения в `origin`, нельзя: плеер тогда пытается загрузить iframe с `https://com.yourcompany.yourapp`, которого не существует.

Версия 6.0.0 (16 мая 2026 года) разделила эти два значения. `origin` теперь по умолчанию равен `null`, новый параметр `privacyEnhancedMode` (по умолчанию `true`) выбирает хост, а базовый URL при отсутствии origin откатывается к этому хосту:

```dart
// youtube_player_iframe 6.0.2, lib/src/player_params.dart
String get host => privacyEnhancedMode
    ? 'https://www.youtube-nocookie.com'
    : 'https://www.youtube.com';

// youtube_player_iframe 6.0.2, lib/src/controller/youtube_player_controller.dart
baseUrl: kIsWeb ? Uri.base.origin : (params.origin ?? params.host),
```

Мейнтейнер закрыл [#1155](https://github.com/sarbagyastha/youtube_player_flutter/issues/1155) с комментарием "Fixed with v6.0.0", а отчёты об ошибке 153 ([#1124](https://github.com/sarbagyastha/youtube_player_flutter/issues/1124), [#1150](https://github.com/sarbagyastha/youtube_player_flutter/issues/1150)) были закрыты 30 мая 2026 года с выходом 6.0.1.

## Минимальное воспроизведение: матрица origin страницы

Чтобы понять, какую комбинацию принимает YouTube, я свёл пакет к тому, что он действительно делает: `WebViewController`, который загружает небольшую HTML-страницу через `loadHtmlString`, создаёт `YT.Player` с заданным `host`, вызывает `playVideo()` в `onReady` и передаёт каждое `onStateChange` и `onError` обратно в Dart через JavaScript-канал. Видео `M7lc1UVf-VE`, собственное демо IFrame API от YouTube, оно разрешено для встраивания.

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

Вот результаты, каждый случай прогонялся 25 секунд на симуляторе (`state=1` означает "воспроизводится"):

| Случай | Origin страницы (`baseUrl`) | `host` плеера | Результат |
| --- | --- | --- | --- |
| `youtube_player_iframe` 5.2.2 по умолчанию | `https://www.youtube.com` | `https://www.youtube.com` | `ERROR=152` |
| 6.0.x с `privacyEnhancedMode: false` | `https://www.youtube.com` | `https://www.youtube.com` | `ERROR=152` |
| Без базового URL (`about:blank`, origin `null`) | нет | `https://www.youtube.com` | `ERROR=153` |
| Обходной путь для 5.x, умолчание 6.0.x | `https://www.youtube-nocookie.com` | `https://www.youtube-nocookie.com` | `state=1`, воспроизводится |
| ID приложения + хост nocookie | `https://com.example.ytrepro` | `https://www.youtube-nocookie.com` | `state=1`, воспроизводится |
| ID приложения + хост youtube.com | `https://com.example.ytrepro` | `https://www.youtube.com` | `state=1`, воспроизводится |
| ID приложения в `origin` для 5.x (становится и хостом) | `https://com.example.ytrepro` | `https://com.example.ytrepro` | до `onReady` не доходит |

Из таблицы следуют два правила. Страница без origin получает 153, страница, выдающая себя за `youtube.com`, получает 152, а всё остальное с настоящим origin `https://` воспроизводится. И хост iframe должен быть настоящим хостом YouTube, поэтому ID приложения в параметре `origin` в 5.x даёт молчаливый пустой плеер, а не исправление.

## Исправление 1: обновиться до youtube_player_iframe 6.0.2 и задать origin как ID приложения

Это рекомендуемое исправление. Для него нужны Flutter 3.38 или новее и Dart 3.10 или новее, это новые минимальные требования в 6.0.0.

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

Когда `origin` задан, 6.0.2 использует его как базовый URL для `loadHtmlString` и как переменные плеера `origin` и `widget_referrer`, а iframe по-прежнему загружается с `youtube-nocookie.com` (или с `youtube.com`, если отключить `privacyEnhancedMode`). Это строка "ID приложения + хост nocookie" из таблицы выше, и она соответствует формату `https://<app-id>`, который документирует YouTube. К этому же подходу пришли контрибьюторы в [PR #1126](https://github.com/sarbagyastha/youtube_player_flutter/pull/1126), где предлагалось именно такое разделение origin и хоста ещё до того, как его выпустили в 6.0.0.

Если не задавать `origin`, 6.0.2 всё равно работает: origin страницы откатывается к `https://www.youtube-nocookie.com` (строка "умолчание 6.0.x"). Указать ID приложения всё же лучше, потому что этого требуют условия YouTube, и тогда вы не зависите от того, что YouTube и дальше будет считать `youtube-nocookie.com` допустимой встраивающей стороной.

При обновлении с 5.x есть одно ломающее изменение, на которое вы наткнётесь сразу: `YoutubePlayerScaffold` удалён. Замените его на `YoutubePlayer`, который теперь сам обрабатывает полноэкранный режим:

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

В 6.0.1 также удалён параметр `modestbranding`, так что уберите его, если передаёте.

## Исправление 2: застряли на 5.x, используйте youtube-nocookie как origin

Если перейти на Flutter 3.38 пока нельзя, `youtube_player_iframe` 5.2.2 (Flutter 3.24+) исправляется изменением в одну строку, которое подтвердили несколько человек в [#1112](https://github.com/sarbagyastha/youtube_player_flutter/issues/1112) и [#1155](https://github.com/sarbagyastha/youtube_player_flutter/issues/1155):

```dart
// youtube_player_iframe 5.2.2, Flutter 3.24+
final controller = YoutubePlayerController(
  params: const YoutubePlayerParams(
    origin: 'https://www.youtube-nocookie.com',
  ),
);
```

В 5.x это одно значение становится одновременно origin страницы, хостом iframe и переменными плеера, что соответствует строке "обходной путь для 5.x" в таблице: настоящий хост YouTube и origin страницы, отличный от `youtube.com`. Не указывайте здесь ID приложения на 5.x. Он тоже станет хостом iframe, и плеер так и не загрузится.

## Исправление 3: собственный WebView, задайте странице базовый URL

Если вы встраиваете YouTube сами через `webview_flutter` или `flutter_inappwebview`, а не через пакет, правило то же. Всегда передавайте базовый URL при загрузке локального HTML и делайте его равным ID приложения:

```dart
// webview_flutter 4.14.1
await controller.loadHtmlString(
  html,
  baseUrl: 'https://com.yourcompany.yourapp', // never omit: null gives Error 153
);
```

Если вместо локального HTML вы загружаете URL встраивания напрямую, добавьте заголовок сами. `loadRequest` принимает заголовки на обеих платформах, и это тот самый путь `loadUrl(url, additionalHttpHeaders)` / `loadRequest:`, который описан в документации YouTube:

```dart
// webview_flutter 4.14.1
await controller.loadRequest(
  Uri.parse('https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?playsinline=1'),
  headers: const {'Referer': 'https://com.yourcompany.yourapp/'},
);
```

То же относится к `flutter_inappwebview`, который `youtube_player_flutter` использует под капотом: передайте `baseUrl: WebUri('https://com.yourcompany.yourapp')` в `loadData`. [#1150](https://github.com/sarbagyastha/youtube_player_flutter/issues/1150) это вариант той же ошибки для Windows (WebView2) в этом пакете.

## Подводные камни и похожие ошибки

**Ваш обработчик ошибок может не распознать 152 или 153.** `youtube_player_iframe` 6.0.2 сопоставляет сырые коды через `YoutubeError.fromCode`, который знает `152` (`sameAsNotEmbeddable2`), но не `153`, поэтому 153 приходит как `YoutubeError.unknown`. В 5.2.2 и 152, и 153 сопоставляются с `unknown`. Если вы показываете сообщение "видео нельзя встроить" на основе enum, вы покажете не то. Пока отлаживаете, журналируйте сырой код.

**Отключение `privacyEnhancedMode` в 6.x возвращает 152**, если вы не задали также `origin`. С `privacyEnhancedMode: false` и без `origin` базовый URL откатывается к `https://www.youtube.com`, это вторая строка таблицы. Задайте `origin` как ID приложения, и хост youtube.com будет нормально воспроизводить видео.

**Ошибки 150 и 101 это другая проблема.** Они означают, что владелец запретил встраивание этого видео. Никакое изменение origin или Referer их не исправит; вместо этого откройте видео в приложении YouTube через `url_launcher`.

**"This video is unavailable, Error code: 15"** с сентября 2025 года ([#1112](https://github.com/sarbagyastha/youtube_player_flutter/issues/1112), [#1125](https://github.com/sarbagyastha/youtube_player_flutter/issues/1125)) относилась к тому же семейству проверок идентификации на 5.x и исправляется теми же изменениями origin.

**Во Flutter web всё иначе.** В вебе пакет игнорирует ваш `origin` и использует `Uri.base.origin`, настоящий origin вашего сайта, потому что браузер сам отправляет `Referer`. Если вы получаете там 153, ваш сервер почти наверняка отправляет `Referrer-Policy: no-referrer` или `same-origin`, что убирает заголовок из кросс-доменного запроса iframe. Переключите его на `strict-origin-when-cross-origin`, как рекомендует YouTube, или добавьте `<meta name="referrer" content="strict-origin-when-cross-origin">` в `web/index.html`. Simon Willison столкнулся с тем же из-за умолчания `same-origin` в Django и [описал это](https://til.simonwillison.net/youtube/fixing-153-embed). Если ваша веб-сборка Flutter вдобавок отдаётся с агрессивным кешированием, убедитесь, что новый `index.html` действительно доходит до пользователей; [устаревшие закешированные сборки после перезагрузки](/ru/2026/09/fix-flutter-web-serves-a-stale-cached-build-after-reload/) это отдельная ловушка.

**Делегаты навигации могут свести исправление на нет.** Если вы оборачиваете плеер в собственный `NavigationDelegate` и запрещаете любую навигацию за пределы своего домена, вы можете заблокировать собственные фреймы встраивания. Явно разрешите хосты YouTube; подход с сопоставлением хостов из статьи [как запретить Flutter WebView переходить по внешним URL](/ru/2026/09/how-to-block-a-flutter-webview-from-navigating-to-external-urls/) работает со списком разрешённых `www.youtube.com`, `www.youtube-nocookie.com` и `m.youtube.com`.

**Открытие URL видео это другой баг.** В [flutter/flutter#178705](https://github.com/flutter/flutter/issues/178705) сообщается о 153 при открытии ссылки через `launchUrl`, при котором вы полностью покидаете приложение. Issue закрыт как invalid и касается браузера или приложения YouTube на устройстве, а не вашего WebView.

## Связанные материалы

- [Как запретить Flutter WebView переходить по внешним URL](/ru/2026/09/how-to-block-a-flutter-webview-from-navigating-to-external-urls/) разбирает сопоставление хостов в `NavigationDelegate` на `webview_flutter` 4.14.1.
- [Исправление: текст Flutter уходит за пределы экрана в Android WebView при системном масштабировании шрифта](/ru/2026/09/fix-flutter-text-renders-off-screen-in-an-android-webview-with-font-scaling/) описывает ещё один баг встраивания WebView, который исправляется одним параметром.
- [Исправление: Flutter web отдаёт устаревшую закешированную сборку после перезагрузки](/ru/2026/09/fix-flutter-web-serves-a-stale-cached-build-after-reload/) пригодится, если вы выкатываете описанное выше изменение `index.html` для веба.
- [Flutter 3.44 выносит Material и Cupertino из SDK](/ru/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/) стоит прочитать перед обновлением до Flutter 3.38+, которое требуется для `youtube_player_iframe` 6.x.

## Источники

- [YouTube API Services: Required Minimum Functionality, идентификация API-клиента и формат Referer](https://developers.google.com/youtube/terms/required-minimum-functionality)
- [Справочник YouTube IFrame Player API, коды onError](https://developers.google.com/youtube/iframe_api_reference)
- [Журнал изменений youtube_player_iframe (5.2.2, 6.0.0, 6.0.1, 6.0.2)](https://pub.dev/packages/youtube_player_iframe/changelog)
- [sarbagyastha/youtube_player_flutter#1155: Error 152-4 на 5.2.1, исправлено в 6.0.0](https://github.com/sarbagyastha/youtube_player_flutter/issues/1155)
- [sarbagyastha/youtube_player_flutter#1124: Error code 153](https://github.com/sarbagyastha/youtube_player_flutter/issues/1124)
- [sarbagyastha/youtube_player_flutter#1112: Error code 15 и обходной путь с origin youtube-nocookie](https://github.com/sarbagyastha/youtube_player_flutter/issues/1112)
- [sarbagyastha/youtube_player_flutter#1126: отправлять origin отдельно от хоста](https://github.com/sarbagyastha/youtube_player_flutter/pull/1126)
- [Simon Willison: Error 153 Video player configuration error во встроенных видео YouTube](https://til.simonwillison.net/youtube/fixing-153-embed)
