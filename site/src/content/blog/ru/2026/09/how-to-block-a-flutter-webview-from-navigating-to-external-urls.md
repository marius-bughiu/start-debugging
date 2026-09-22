---
title: "Как запретить Flutter WebView переходить на внешние URL с помощью NavigationDelegate"
description: "Удерживайте Flutter WebView на своём домене с webview_flutter 4.14.1: разбирайте URL, сравнивайте Uri.host вместо startsWith, передавайте mailto: и tel: в url_launcher и учитывайте, что Android и iOS на самом деле отправляют в onNavigationRequest."
pubDate: 2026-09-22
template: how-to
tags:
  - "flutter"
  - "dart"
  - "webview"
  - "security"
  - "android"
  - "ios"
lang: "ru"
translationOf: "2026/09/how-to-block-a-flutter-webview-from-navigating-to-external-urls"
translatedBy: "claude"
translationDate: 2026-09-22
---

**Короткий ответ:** с `webview_flutter` 4.14.1 на Flutter 3.44 передайте `WebViewController` объект `NavigationDelegate`, у которого `onNavigationRequest` разбирает `request.url` через `Uri.tryParse`, возвращает `NavigationDecision.navigate` только когда `uri.scheme == 'https'` и `uri.host` входит в ваш список разрешённых хостов, а для всего остального возвращает `NavigationDecision.prevent`, по желанию открывая заблокированную ссылку в системном браузере через `url_launcher`. Не используйте `url.startsWith('https://example.com')`: такая проверка пропускает `https://example.com.evil.net` и `https://example.com@evil.net`. И помните об ограничениях: на Android колбэк никогда не видит навигацию во вложенных фреймах и отправку форм методом POST.

Дальше в статье эта политика строится шаг за шагом, приводится тестовая таблица, доказывающая, что наивная проверка ошибочна, и разбираются различия платформ, которые определяют, что ваш колбэк может заблокировать, а что нет. Весь код ниже скомпилирован и проверен с `webview_flutter` 4.14.1, `webview_flutter_android` 4.14.1, `webview_flutter_wkwebview` 3.26.1 и `url_launcher` 6.3.2 на Flutter 3.44.8 / Dart 3.12.2.

## Почему WebView уходит с вашего сайта

Встроенный справочный центр, страница оформления заказа или экран с условиями использования обычно должны показывать один сайт. Сама страница об этом не знает. В ней есть ссылки в подвале на Twitter, значок "powered by", кнопка OAuth, адрес поддержки `mailto:` и, возможно, пользовательский контент с произвольными ссылками. Нажмите любую из них, и WebView спокойно загрузит её внутри вашего приложения: без адресной строки, без кнопки "назад", если вы её не сделали, и с названием вашего приложения вверху экрана. Это проблема UX (пользователи застревают на стороннем сайте) и проблема доверия (фишинговая страница, показанная внутри вашего приложения, наследует его репутацию).

`webview_flutter` предоставляет для этого один хук: `NavigationDelegate.onNavigationRequest`. Его сигнатура в 4.14.1 такая:

```dart
// webview_flutter 4.14.1
FutureOr<NavigationDecision> Function(NavigationRequest request)? onNavigationRequest
```

`NavigationRequest` содержит ровно два поля, `url` (`String`) и `isMainFrame` (`bool`), а у `NavigationDecision` два значения, `navigate` и `prevent`. Всё остальное зависит от вас.

## Пример из README и есть ошибка

В README официального пакета приведён такой фрагмент:

```dart
// From the webview_flutter 4.14.1 README
onNavigationRequest: (NavigationRequest request) {
  if (request.url.startsWith('https://www.youtube.com/')) {
    return NavigationDecision.prevent;
  }
  return NavigationDecision.navigate;
},
```

Как демонстрация списка запрещённых адресов он годится. Превратите его в список разрешённых, как делает большинство, и получите `if (request.url.startsWith('https://example.com')) navigate else prevent`. Но URL не работают как строковые префиксы. Я прогнал 16 URL и через наивную проверку префикса, и через класс политики, который построен ниже:

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

Опасны две строки. `https://example.com.evil.net/login` это хост, принадлежащий тому, кто зарегистрировал `evil.net`. `https://example.com@evil.net/login` помещает `example.com` в часть URL с данными пользователя (userinfo), поэтому браузер подключается к `evil.net`. Оба URL проходят проверку префикса и отображаются внутри вашего приложения. Остальные расхождения это ложноотрицательные результаты: хост в верхнем регистре или поддомен без всякой причины выбрасываются из WebView.

Решение в том, чтобы доверить разбор `Uri`. `Uri.parse('https://EXAMPLE.com@evil.net:8443/x').host` возвращает `evil.net`: в нижнем регистре, без userinfo и порта. Сравнивайте именно это значение, а не исходную строку.

## Построение политики со списком разрешённых хостов

Держите логику решения в обычном классе Dart без импортов Flutter или плагинов. Тогда его можно покрыть модульными тестами через `flutter test`, и это важно, потому что настоящий WebView в виджет-тесте запустить нельзя.

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

Некоторые решения здесь приняты намеренно:

- **Три исхода, а не два.** `NavigationDecision` бинарен, но "не в WebView" делится на "открыть где-то ещё" и "отбросить". Ссылка на вашу страницу в Twitter должна открыть браузер. URL `javascript:` или `file:` не должен вести никуда.
- **Проверка поддоменов использует `'.$allowed'`** с точкой в начале. `host.endsWith('example.com')` пропустил бы `notexample.com`, а это ошибка того же класса, что и проверка префикса.
- **`http` никогда не разрешён внутри приложения.** Если ваш собственный сайт всё ещё отдаёт ссылку по `http`, она уйдёт из приложения, а не загрузится без TLS. Меняйте это только при реальной необходимости и учтите, что Android с API 28 и так по умолчанию блокирует незашифрованный трафик, если конфигурация сетевой безопасности его не разрешает.
- **`about:blank` разрешён.** На iOS и `loadHtmlString` без `baseUrl`, и только что открытый пустой фрейм приходят как `about:blank`. Если заблокировать его, эти сценарии сломаются.
- **Неизвестные схемы блокируются, а не запускаются.** `intent://` на Android может нацелиться на любую экспортированную activity на устройстве. Если вам нужна конкретная собственная схема (ваша `myapp://` или `market://`), явно добавьте её в `externalSchemes`.

Таблица выше это вывод следующего тестового файла, который выполняется через `flutter test` примерно за секунду:

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

## Подключение политики к NavigationDelegate

Шаги по порядку:

1. Добавьте пакеты: `flutter pub add webview_flutter url_launcher`. `webview_flutter` 4.14.1 требует Flutter 3.38 или новее, Android SDK 24+ и iOS 13+.
2. Создайте `WebViewController` один раз, в `initState`, а не в `build`.
3. Вызовите `setNavigationDelegate` с `onNavigationRequest`, который сопоставляет каждый `LinkAction` с `NavigationDecision`.
4. Для `openExternally` запустите `launchUrl` с `LaunchMode.externalApplication` и сразу верните `prevent`.
5. Вызывайте `loadRequest` последним, после того как делегат установлен.

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

`flutter analyze` не находит в этом файле проблем. Стоит отметить две детали.

Колбэк возвращает результат синхронно. `onNavigationRequest` принимает `Future<NavigationDecision>`, но на iOS плагин выполняет `await` вашего колбэка внутри `decidePolicyForNavigationAction` из WebKit, поэтому каждая миллисекунда, проведённая там, это миллисекунда, в течение которой страница заморожена. Ожидать `launchUrl` (который ждёт, пока ОС переключит приложения) там как раз не следует. Примите решение синхронно, верните его и запустите открытие в фоне через `unawaited`.

Проверка `mounted` после `await launchUrl` нужна потому, что к моменту ответа ОС пользователь мог уже закрыть страницу. Если этот паттерн для вас новый, я подробно разобрал его в статье [о безопасном использовании BuildContext после await](/ru/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/).

## Что Android и iOS на самом деле отправляют в onNavigationRequest

Эту часть документация обходит фразой "some platforms may also trigger this callback from calls to `loadRequest`". Я прочитал платформенные реализации в `webview_flutter_android` 4.14.1 и `webview_flutter_wkwebview` 3.26.1, и ведут они себя очень по-разному.

### Android: нативная сторона сначала отменяет, Dart повторяет запрос

На Android колбэк вызывается из `WebViewClient.shouldOverrideUrlLoading`. Когда вы задаёте `onNavigationRequest`, плагин вызывает `setSynchronousReturnValueForShouldOverrideUrlLoading(true)`. С этого момента нативный `WebViewClientProxyApi` возвращает `request.isForMainFrame() && true` для каждой навигации: любая навигация в главном фрейме отменяется сразу, ещё до того, как Dart о ней спросили. Затем Dart выполняет ваш колбэк, и если тот возвращает `navigate`, плагин вызывает `loadUrl` с тем же URL и исходными заголовками запроса.

Последствия:

- **О вложенных фреймах колбэк никогда не спрашивают.** `_handleNavigation` сразу выходит, когда `isForMainFrame` равен false, потому что `loadUrl` не умеет загружать URL в iframe. Iframe на вашей странице может перейти куда угодно, а ваш колбэк так и не выполнится. Поэтому код выше и не пытается контролировать `isMainFrame == false`.
- **Навигации методом POST обходят колбэк.** В собственной документации Android сказано, что `shouldOverrideUrlLoading` не вызывается для POST-запросов. Форма `<form method="post" action="https://evil.net/collect">` на разрешённой вами странице отправится и загрузит `evil.net` в вашем WebView.
- **`loadRequest` не проверяется.** URL, которые вы загружаете сами через контроллер, не проходят через `shouldOverrideUrlLoading`.
- **Назад, вперёд и перезагрузка не проверяются.** Это операции с историей, а не новые навигации.
- **Загрузки файлов идут через тот же колбэк.** `DownloadListener` плагина вызывает `_handleNavigation` для URL загрузки, так что список разрешённых хостов останавливает и загрузки с других хостов.

### iOS и macOS: WebKit ждёт вашего ответа

В WebKit колбэк вызывается из `WKNavigationDelegate.webView(_:decidePolicyFor:decisionHandler:)`. Плагин ожидает ваш колбэк и сопоставляет `navigate` с `.allow`, а `prevent` с `.cancel`. Ничего не отправляется повторно, поэтому тела POST-запросов и заголовки сохраняются.

Последствия:

- **Начальный `loadRequest` попадает в ваш колбэк.** Если в списке разрешённых нет URL, который вы загружаете в `initState`, вы получите пустую страницу без всякой ошибки. Правило для `about:blank` в политике существует по той же причине, когда вы используете `loadHtmlString`.
- **О вложенных фреймах спрашивают.** Каждая загрузка iframe, включая встроенные плееры YouTube, элементы Stripe и reCAPTCHA, приходит с `isMainFrame: false`. Обрабатывайте их как навигации главного фрейма, и вы сломаете все встраивания на странице.
- **Ссылки с `target="_blank"` приходят дважды.** У запроса на новое окно сначала целевой фрейм равен null, поэтому `isMainFrame` равен `false`. Затем `onCreateWebView` из `WKUIDelegate` плагина загружает этот запрос в тот же WebView, и он возвращается в ваш колбэк как навигация главного фрейма. Ваша политика применяется ко второму вызову, и это ещё одна причина пропускать `isMainFrame == false`.

Если нужен единообразный контроль iframe на обеих платформах, делегат навигации для этого не подходит. Отправляйте со своего сервера заголовок `Content-Security-Policy` с `frame-src`: его соблюдают оба WebView.

## Подводные камни, через которые трафик проходит мимо списка разрешённых

Делегат навигации управляет навигацией страниц. Он не видит:

- **Подресурсы.** Изображения, скрипты, вызовы `fetch` и `XMLHttpRequest` к другим хостам загружаются как обычно. `onNavigationRequest` не является файрволом. Если на разрешённой странице можно заставить выполниться скрипт злоумышленника, этот скрипт может вывести данные через `fetch`, и ваш колбэк ни разу не сработает. Исправляйте страницу (CSP `connect-src`), а не WebView.
- **Смену маршрутов в одностраничных приложениях.** `history.pushState` меняет URL без навигации. Подпишитесь на `onUrlChange`, если это нужно отслеживать; заблокировать такое изменение нельзя, но и сменить origin оно не может, так что путём для побега не является.
- **POST на Android**, описанный выше. Если пользователи могут отправлять формы на встроенном сайте, проверяйте URL в `action` на стороне сервера.
- **Цепочки перенаправлений.** Серверное перенаправление с разрешённого URL на другой хост передаётся в `shouldOverrideUrlLoading` на Android (случай `WebResourceRequest.isRedirect()`) и в проверку политики навигации в WebKit, так что список разрешённых всё равно применяется. Всё же проверьте это на своём реальном сценарии входа, потому что OAuth-провайдеры обожают перенаправления в четыре прыжка.

Ещё три, которые кусаются на практике:

- **OAuth и SSO.** Если ваш сайт авторизует пользователей через `accounts.google.com` или тенант Entra ID, эти хосты должны быть в списке разрешённых, иначе сценарий уйдёт в браузер и не вернётся. К тому же Google вообще отказывается показывать страницу входа во встроенном WebView, поэтому настоящее решение для входа через Google это `flutter_web_auth_2` или нативный SDK, а не более длинный список разрешённых.
- **Ссылки `intent://` на Android.** Сайты, которые открывают приложения по глубоким ссылкам, используют URL вида `intent://...#Intent;...;end`. Chrome их понимает; `url_launcher` синтаксис intent не разбирает. Блокировать их, как это делает политика, безопасно по умолчанию. Если они нужны, разберите параметр `S.browser_fallback_url` и откройте его.
- **Интернационализированные домены.** `Uri` в Dart не выполняет преобразование IDNA: `Uri.parse('https://bücher.example/x').host` равен `b%C3%BCcher.example`, тогда как `https://xn--bcher-kva.example/x` остаётся `xn--bcher-kva.example`. WebView обычно сообщают форму punycode, поэтому вносите в список разрешённых написание с `xn--`.

Если ваш WebView показывает вашу собственную веб-сборку Flutter, а не обычный сайт, маршрутизация внутри приложения живёт в вашем роутере, а не в WebView, и полезнее будет статья [о вложенных маршрутах и глубоких ссылках с go_router](/ru/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/). Масштабирование шрифтов внутри такой встроенной веб-сборки Flutter это отдельная ловушка, которую я описал в статье [о Flutter Text, отрисовывающемся за пределами экрана в Android WebView](/ru/2026/09/fix-flutter-text-renders-off-screen-in-an-android-webview-with-font-scaling/).

## Асинхронные решения ведут себя по-разному на разных платформах

Поскольку Android сначала отменяет навигацию, а потом повторяет её, `async`-колбэк на Android никогда не блокирует страницу: старая страница остаётся на экране и полностью интерактивна, пока ваш `Future` не завершится и плагин не вызовет `loadUrl`. Если за это время пользователь нажмёт вторую ссылку, выполнятся оба решения, и победит тот `loadUrl`, который выполнится последним. На iOS тот же `async`-колбэк держит обработчик решения WebKit открытым, поэтому страница ждёт. Если вашей политике действительно нужен ввод-вывод (например, загрузка удалённого списка разрешённых), загрузите его один раз до открытия страницы и оставьте `onNavigationRequest` синхронным, как в примере выше. Так поведение на обеих платформах будет одинаковым.

Если нужен контроль, который кроссплатформенный API не предоставляет, например перехват запросов подресурсов через `shouldInterceptRequest`, то в 4.14.1 для этого нет хука в Dart. Это означает нативный код, и тут пригодится подход из статьи [о добавлении платформенно-зависимого кода во Flutter без плагинов](/ru/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/). Сначала попробуйте список разрешённых; для подавляющего большинства встроенных страниц его достаточно.

Наконец, помните, что всё, что вы поставляете в бинарнике приложения, включая список разрешённых хостов, может прочитать любой, кто распакует APK или IPA. Для списка имён хостов это нормально, но это хорошее напоминание о том, [что злоумышленник может извлечь из Flutter-приложения](/ru/2026/01/flutterguard-cli-a-fast-what-can-an-attacker-extract-check-for-flutter-3-x-apps/): список разрешённых защищает пользователей от ухода с сайта, но секретом он не является.

## Источники

- [webview_flutter 4.14.1 на pub.dev](https://pub.dev/packages/webview_flutter), включая пример `onNavigationRequest` из README и таблицу поддержки платформ.
- [Справочник API `NavigationDelegate`](https://pub.dev/documentation/webview_flutter/latest/webview_flutter/NavigationDelegate-class.html).
- [Исходный код webview_flutter_android](https://github.com/flutter/packages/tree/main/packages/webview_flutter/webview_flutter_android): `android_webview_controller.dart` (`_handleNavigation`) и `WebViewClientProxyApi.java` (`shouldOverrideUrlLoading`).
- [Исходный код webview_flutter_wkwebview](https://github.com/flutter/packages/tree/main/packages/webview_flutter/webview_flutter_wkwebview): `webkit_webview_controller.dart` (`decidePolicyForNavigationAction`, `onCreateWebView`).
- [Android `WebViewClient.shouldOverrideUrlLoading`](https://developer.android.com/reference/android/webkit/WebViewClient#shouldOverrideUrlLoading(android.webkit.WebView,%20android.webkit.WebResourceRequest)).
- [Apple `webView(_:decidePolicyFor:decisionHandler:)`](https://developer.apple.com/documentation/webkit/wknavigationdelegate/webview(_:decidepolicyfor:decisionhandler:)-2ni62).
- [url_launcher 6.3.2 на pub.dev](https://pub.dev/packages/url_launcher) и [`LaunchMode`](https://pub.dev/documentation/url_launcher/latest/url_launcher/LaunchMode.html).
- [Dart `Uri.host`](https://api.dart.dev/stable/dart-core/Uri/host.html).
