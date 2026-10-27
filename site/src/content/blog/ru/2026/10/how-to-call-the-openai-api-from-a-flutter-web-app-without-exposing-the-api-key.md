---
title: "Как вызывать OpenAI API из Flutter web-приложения, не раскрывая API-ключ"
description: "Всё, что вы компилируете в сборку Flutter web, включая значения --dart-define, попадает в браузер открытым текстом. Единственный безопасный вариант: небольшой backend-прокси, который хранит ключ, аутентифицирует пользователя, фиксирует модель и передаёт обратно SSE-поток Responses API. Полный прокси на Dart shelf и клиент Flutter, проверено на Flutter 3.44, Dart 3.12 и http 1.6."
pubDate: 2026-10-27
template: how-to
tags:
  - "flutter"
  - "flutter-web"
  - "dart"
  - "openai"
  - "security"
  - "how-to"
lang: "ru"
translationOf: "2026/10/how-to-call-the-openai-api-from-a-flutter-web-app-without-exposing-the-api-key"
translatedBy: "claude"
translationDate: 2026-10-27
---

**Короткий ответ:** спрятать ключ OpenAI API внутри Flutter web-приложения невозможно. `--dart-define`, `String.fromEnvironment`, встроенный ассет `.env` и обфускация в итоге оказываются в файлах, которые скачивает браузер, а сам ключ ещё и виден в заголовке `Authorization` каждого запроса в DevTools. Храните ключ на сервере, который вы контролируете, пусть Flutter-приложение обращается к этому серверу с собственным токеном сессии пользователя, а сервер сам формирует запрос к OpenAI (фиксированная модель, ограниченное число токенов, заданный `safety_identifier`) и передаёт ответ потоком обратно. Ниже приведён полный проверенный прокси на Dart с `shelf` и клиент Flutter web, который отображает потоковый ответ по токенам.

Всё здесь собрано и запущено на Flutter 3.44.8, Dart 3.12.2, `package:http` 1.6.0 и `package:shelf` 1.4 с OpenAI Responses API (`POST /v1/responses`). Прокси проверен end to end в браузере на локальном фиктивном upstream, который отдаёт события server-sent events в том же формате, что и OpenAI, поэтому поведение потоковой передачи и CORS ниже измерено, а не предполагается.

## Почему `--dart-define` и файлы `.env` не защищают ключ

Обычная первая попытка выглядит так:

```dart
// Flutter 3.44, Dart 3.12, http 1.6 -- DO NOT SHIP THIS
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

const apiKey = String.fromEnvironment('OPENAI_API_KEY');

void main() => runApp(MaterialApp(
      home: TextButton(
        onPressed: () => http.post(
          Uri.parse('https://api.openai.com/v1/responses'),
          headers: {'Authorization': 'Bearer $apiKey'},
        ),
        child: const Text('Ask'),
      ),
    ));
```

Сборка с фиктивным ключом:

```bash
flutter build web --release --dart-define=OPENAI_API_KEY=sk-proj-DEMO1234567890leak
grep -o '.\{30\}sk-proj-[A-Za-z0-9]*.\{5\}' build/web/main.dart.js
```

Релизная сборка, минифицированная dart2js, всё равно содержит такую строку:

```text
A.aC(["Authorization","Bearer sk-proj-DEMO1234567890leak"],s,
```

`String.fromEnvironment` является константой времени компиляции, поэтому компилятор подставляет значение как строковый литерал. Минификация переименовывает идентификаторы, но никогда не шифрует строки. Я собрал то же приложение и через `flutter build web --wasm`: ключ лежит в `main.dart.wasm` обычными байтами (`grep -a` его находит). Если нужно напомнить, что даёт сборка Wasm, см. [как собрать Flutter web-приложение с WebAssembly](/ru/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/): она меняет среду выполнения, но не то, кто может прочитать ваши константы.

Другие популярные варианты проваливаются так же:

- Файл `.env`, указанный в `assets:` в `pubspec.yaml`, отдаётся по адресу `/assets/.env` (ассеты Flutter web это обычные статические файлы). Любой может его скачать.
- `flutter build --obfuscate` для web-сборок вообще недоступен (документация Flutter отсылает к минификации), а на мобильных платформах он лишь переименовывает символы и никогда не трогает строковые литералы.
- Разбиение ключа на части и склейка во время выполнения задерживает человека максимум на минуту. Итоговая строка всё равно появляется в заголовке запроса.

Исправить это на стороне клиента нельзя, потому что браузер должен отправить ключ в OpenAI. Кто контролирует браузер, тот контролирует запрос. Собственные [рекомендации OpenAI по безопасности API-ключей](https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety) говорят то же самое: никогда не размещайте ключ в браузерах или мобильных приложениях, направляйте запросы через свой backend. Утечка ключа это не только проблема со счетами. В зависимости от его прав он позволяет читать ваши сохранённые ответы, файлы и векторные хранилища и использовать все модели, доступные вашему проекту.

## Что должен делать прокси (и почему "просто переслать тело" недостаточно)

Прокси, который копирует входящее тело в OpenAI и добавляет ключ, лишь переносит проблему: теперь любой может использовать URL вашего прокси как бесплатную конечную точку OpenAI. Полезный прокси делает пять вещей:

1. **Аутентифицирует вызывающего** по учётным данным, принадлежащим пользователю (Firebase ID token, ваша cookie сессии, OIDC access token), а не по общему секрету приложения, который сам можно извлечь.
2. **Ограничивает частоту для каждого пользователя**, чтобы один аккаунт не мог исчерпать ваш бюджет.
3. **Принимает только ожидаемые поля.** Клиент отправляет запрос (prompt). Модель, инструкции и `max_output_tokens` определяет сервер. Если бы клиент мог выбирать `model`, атакующий выбрал бы самую дорогую.
4. **Формирует upstream-запрос** с секретным ключом и `safety_identifier`, стабильной строкой для каждого пользователя (максимум 64 символа, с хешированием, если она получена из адреса электронной почты), которая позволяет OpenAI приписать злоупотребление одному из ваших пользователей, а не всей вашей организации. Он заменяет прежний параметр `user`, см. [статью OpenAI о safety identifier](https://help.openai.com/en/articles/5428082-how-to-incorporate-a-safety-identifier).
5. **Передаёт ответ обратно без буферизации**, чтобы пользователь видел токены по мере поступления, а не ждал полного завершения.

## Шаги: как поставить OpenAI за собственной конечной точкой

1. Создайте серверный проект на Dart для прокси и добавьте `shelf` и `http`.
2. Храните ключ OpenAI как серверный секрет (переменная окружения или менеджер секретов вашей платформы), но никогда не в репозитории Flutter.
3. Реализуйте `POST /api/chat`: проверьте пользователя, ограничьте частоту, провалидируйте prompt, вызовите `/v1/responses` с `stream: true` и передайте SSE-поток обратно.
4. Ограничьте CORS источником (origin) вашего web-приложения либо отдавайте сборку Flutter с того же origin и полностью обойдитесь без CORS.
5. В приложении Flutter вызывайте `/api/chat` с токеном пользователя и разбирайте события `response.output_text.delta` из потока.
6. Разверните прокси (Cloud Run, Fly.io, виртуальная машина, всё, что запускает исполняемый файл Dart или контейнер) и передайте его URL в сборку Flutter через `--dart-define=CHAT_PROXY_URL=...`. URL отправлять в браузер можно, секрет нельзя.

## Прокси: около 100 строк на Dart

```yaml
# pubspec.yaml for the proxy
name: chat_proxy
environment:
  sdk: ^3.12.0
dependencies:
  http: ^1.6.0
  shelf: ^1.4.2
```

```dart
// bin/server.dart -- Dart 3.12, shelf 1.4, http 1.6
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:shelf/shelf.dart';
import 'package:shelf/shelf_io.dart' as io;

final _apiKey = Platform.environment['OPENAI_API_KEY']!;
final _baseUrl =
    Platform.environment['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1';
final _allowedOrigin =
    Platform.environment['ALLOWED_ORIGIN'] ?? 'https://app.example.com';
const _model = 'gpt-6-luna'; // pinned on the server, never taken from the client
const _maxInputChars = 4000;
final _client = http.Client();
final _lastCall = <String, DateTime>{};

Future<void> main() async {
  final handler =
      const Pipeline().addMiddleware(_cors()).addHandler(_router);
  await io.serve(handler, InternetAddress.anyIPv4,
      int.parse(Platform.environment['PORT'] ?? '8080'));
}

Future<Response> _router(Request req) async {
  if (req.method == 'POST' && req.url.path == 'api/chat') return _chat(req);
  return Response.notFound('not found');
}

Future<Response> _chat(Request req) async {
  // 1. Who is calling? Replace with real verification (Firebase ID token,
  //    your own session cookie, an OIDC access token, ...).
  final userId = await _verifyUser(req.headers['authorization']);
  if (userId == null) return Response(401, body: 'unauthorized');

  // 2. Cheap per-user throttle: one request every 2 seconds.
  final now = DateTime.now();
  final last = _lastCall[userId];
  if (last != null && now.difference(last) < const Duration(seconds: 2)) {
    return Response(429, body: 'slow down');
  }
  _lastCall[userId] = now;

  // 3. Accept only the fields you expect. The client sends a prompt, nothing else.
  final body = jsonDecode(await req.readAsString()) as Map<String, dynamic>;
  final prompt = body['prompt'];
  if (prompt is! String || prompt.isEmpty || prompt.length > _maxInputChars) {
    return Response(400, body: 'bad prompt');
  }

  // 4. Build the upstream request on the server, with the secret key.
  final upstreamReq = http.Request('POST', Uri.parse('$_baseUrl/responses'))
    ..headers.addAll({
      'Authorization': 'Bearer $_apiKey',
      'Content-Type': 'application/json',
    })
    ..body = jsonEncode({
      'model': _model,
      'instructions': 'You are a helpful assistant inside the Acme app.',
      'input': prompt,
      'max_output_tokens': 800,
      'stream': true,
      'store': false,
      'safety_identifier': userId,
    });

  final upstream = await _client.send(upstreamReq);
  if (upstream.statusCode != 200) {
    final detail = await upstream.stream.bytesToString();
    stderr.writeln('upstream ${upstream.statusCode}: $detail');
    return Response(502, body: 'upstream error');
  }

  // 5. Pipe the SSE stream straight through, unbuffered.
  return Response.ok(
    upstream.stream,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    },
    context: {'shelf.io.buffer_output': false},
  );
}

Future<String?> _verifyUser(String? authorization) async {
  // Demo only: accept "Bearer demo-<user>". Never ship this.
  if (authorization == null || !authorization.startsWith('Bearer demo-')) {
    return null;
  }
  return authorization.substring('Bearer demo-'.length);
}

Middleware _cors() => (inner) => (req) async {
      final cors = {
        'Access-Control-Allow-Origin': _allowedOrigin,
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Vary': 'Origin',
      };
      if (req.method == 'OPTIONS') return Response.ok(null, headers: cors);
      final res = await inner(req);
      return res.change(headers: cors);
    };
```

Несколько деталей работают больше, чем кажется:

- **`'shelf.io.buffer_output': false`** делает потоковую передачу рабочей. Без него `shelf_io` буферизует тело ответа, и браузер получает всё только в конце. С ним curl получал каждое SSE-событие с той же задержкой в 400 мс, с какой их писал фиктивный upstream.
- **`store: false`** сообщает OpenAI, что ответ не нужно хранить для последующего получения. Оставьте хранение включённым, если вы полагаетесь на `previous_response_id` для многоходовых диалогов, но тогда храните идентификаторы ответов и на сервере, чтобы один пользователь не мог продолжить чужой диалог, угадав идентификатор.
- **Тело ошибки upstream записывается в журнал, а не возвращается.** Сообщения об ошибках OpenAI могут содержать сведения об организации или проекте, которые не нужно отдавать браузеру.
- **`OPENAI_BASE_URL`** нужен, чтобы в тестах направить прокси на фиктивный upstream, именно так я его и проверял. Идентификаторы моделей меняются часто; актуальный список смотрите на [странице моделей OpenAI](https://developers.openai.com/api/docs/models) и меняйте `_model` на сервере, не трогая приложение.

Запуск против фиктивного upstream с помощью curl показывает, что все три защиты работают:

```bash
# no token -> 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8080/api/chat -d '{"prompt":"hi"}'

# valid token, client tries to pick a model -> streams, model is ignored
curl -sN -X POST localhost:8080/api/chat -H 'Authorization: Bearer demo-alice' \
  -d '{"prompt":"hi","model":"gpt-6-astra"}'
```

Фиктивный upstream записал в журнал то, что реально ушло с сервера: `"model":"gpt-6-luna"`, `"safety_identifier":"alice"` и `Authorization: Bearer <server key>`. Поле `model` от клиента не прошло. Второй запрос от того же пользователя в течение двух секунд получил `429 slow down`.

## Замена демонстрационной аутентификации

`_verifyUser` это единственная часть, которую необходимо переписать перед выпуском. Правило такое: учётные данные должны идентифицировать пользователя и выдаваться тем, кого атакующий не может подделать:

- **Firebase Authentication:** приложение Flutter вызывает `FirebaseAuth.instance.currentUser!.getIdToken()` и отправляет результат как bearer-токен. Прокси проверяет подпись JWT по открытым ключам подписи Google и проверяет `aud` (идентификатор вашего проекта Firebase), `iss` и `exp`, затем использует claim `sub` как `userId`.
- **Собственная сессия вашего backend:** если приложение Flutter отдаётся с того же сайта, что и ваш существующий API, достаточно cookie сессии с `SameSite=Lax` или `Strict`, и заголовок `Authorization` вообще не нужен.
- **OIDC (Entra ID, Auth0, Keycloak):** проверяйте подпись access token, audience и scope так же, как для любого другого API. [Настройка CORS и JWT для защищённого API на ASP.NET Core](/ru/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/) рассматривает те же правила preflight и заголовков со стороны сервера.

Анонимные публичные приложения это сложный случай. Без входа лучшее, что можно сделать, это ограничивать частоту по IP, добавить проверку на ботов, например Firebase App Check или Cloudflare Turnstile, и задать жёсткий месячный бюджет для проекта OpenAI. Исходите из того, что конечную точку найдут и автоматизируют обращения к ней.

Кроме того, словарь `_lastCall` в памяти работает только для одного экземпляра. При горизонтальном масштабировании перенесите ограничение частоты в Redis или в ограничитель вашей платформы и добавьте суточный бюджет токенов на пользователя, считывая `usage` из события `response.completed`.

## Клиент Flutter web: потоковый SSE через `package:http`

Начиная с `package:http` 1.3.0, `BrowserClient` использует Fetch API вместо `XMLHttpRequest`, поэтому `client.send()` в вебе отдаёт тело ответа как настоящий поток фрагментов. Этого достаточно для чтения server-sent events; отдельный SSE-пакет не нужен.

```dart
// Flutter 3.44, Dart 3.12, http 1.6
import 'dart:convert';

import 'package:http/http.dart' as http;

const proxyUrl = String.fromEnvironment(
  'CHAT_PROXY_URL',
  defaultValue: 'https://api.example.com/api/chat',
);

/// Streams the text deltas of one Responses API answer through your proxy.
Stream<String> askProxy(String prompt, String userToken) async* {
  final client = http.Client(); // BrowserClient (fetch) on the web
  try {
    final req = http.Request('POST', Uri.parse(proxyUrl))
      ..headers['Authorization'] = 'Bearer $userToken'
      ..headers['Content-Type'] = 'application/json'
      ..body = jsonEncode({'prompt': prompt});
    final res = await client.send(req);
    if (res.statusCode != 200) {
      throw http.ClientException('proxy returned ${res.statusCode}');
    }
    final lines =
        res.stream.transform(utf8.decoder).transform(const LineSplitter());
    await for (final line in lines) {
      if (!line.startsWith('data: ')) continue;
      final event = jsonDecode(line.substring(6)) as Map<String, dynamic>;
      switch (event['type']) {
        case 'response.output_text.delta':
          yield event['delta'] as String;
        case 'error':
          throw http.ClientException('${event['message']}');
      }
    }
  } finally {
    client.close();
  }
}
```

В виджете добавляйте каждую дельту в `StringBuffer` внутри `setState`:

```dart
// Flutter 3.44, Dart 3.12
Future<void> _ask() async {
  setState(() => _answer.clear());
  await for (final delta in askProxy(_controller.text, await _idToken())) {
    if (!mounted) return;
    setState(() => _answer.write(delta));
  }
}
```

Я собрал этот клиент командой `flutter build web --release --dart-define=CHAT_PROXY_URL=http://localhost:8080/api/chat`, отдал его с `localhost:8081` (другой origin, чем у прокси, так что CORS был задействован) и нажал кнопку в браузере. Фиктивный upstream выдаёт по одному слову каждые 400 мс, а UI записал дельты на отметках 25, 416, 820, 1223 и 1627 мс: это настоящий пошаговый рендеринг, а не один буферизованный блок в конце. `grep` по `main.dart.js` этой сборки находит URL прокси и не находит никаких следов серверного ключа.

Если пользователь может уйти с экрана посреди ответа, храните `StreamSubscription` вместо `await for` и отменяйте его в `dispose`. Отмена закрывает fetch, что закрывает upstream-соединение прокси и останавливает генерацию (и тарификацию) остатка ответа в OpenAI. Шаблон тот же, что в [как отменить StreamSubscription в dispose во Flutter](/ru/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/); в `package:http` 1.6.0 отдельно исправлена отмена веб-потоков ответа, ожидающих следующий фрагмент, поэтому используйте версию 1.6.0 или новее.

## Подводные камни при развёртывании

**Ошибки CORS без кода статуса.** Если `ALLOWED_ORIGIN` не совпадает с origin страницы точно (схема, хост и порт), браузер блокирует ответ, и Dart видит только общее `ClientException: Failed to fetch`. Запрос при этом мог дойти до OpenAI и стоить денег. Самое чистое решение: избежать CORS и отдавать `build/web` с того же origin, что и `/api/chat`, либо из самого прокси, либо за одним обратным прокси. Во время разработки Flutter 3.38 и новее может перенаправлять префикс пути на ваш локальный прокси через [правило proxy в `web_dev_config.yaml`](https://docs.flutter.dev/platform-integration/web/web-dev-config-file), что даёт вызовы в рамках одного origin и при `flutter run -d chrome`.

**Буферизация на платформе ломает потоковую передачу.** Некоторые хостинги и CDN буферизуют ответы `text/event-stream` или накладывают тайм-аут ответа в 30-60 секунд. Если в продакшене токены приходят все сразу, а локально идут потоком, проверьте настройки потоковых ответов платформы, прежде чем винить Dart. Nginx требует для этого location `proxy_buffering off;` (или заголовок ответа `X-Accel-Buffering: no`).

**Держите слои кеширования подальше от `/api/`.** Если перед приложением стоит CDN, собственный service worker или HTTP-кеш, исключите путь прокси, чтобы потоковые ответы никогда не кешировались и не воспроизводились повторно. Устаревшие сборки это отдельная проблема, описанная в [почему Flutter web отдаёт устаревшую кешированную сборку после перезагрузки](/ru/2026/09/fix-flutter-web-serves-a-stale-cached-build-after-reload/).

**То же правило действует для мобильных платформ.** Сборка для Android или iOS делает извлечение чуть менее удобным, но не невозможным: строки восстанавливаются из `libapp.so` стандартными средствами. Инструменты вроде [FlutterGuard CLI](/ru/2026/01/flutterguard-cli-a-fast-what-can-an-attacker-extract-check-for-flutter-3-x-apps/) существуют именно затем, чтобы показать, что атакующий может вытащить из релизной сборки. Используйте один и тот же прокси для всех платформ.

**Realtime-голос это единственное исключение, и ему всё равно нужен сервер.** Для Realtime API через WebRTC браузеру разрешено подключаться к OpenAI напрямую, но только с краткоживущим эфемерным ключом (`ek_...`), который ваш сервер выпускает, вызывая `POST /v1/realtime/client_secrets` с настоящим ключом. Основной ключ по-прежнему никогда не покидает сервер. См. [руководство OpenAI по Realtime API с WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc).

**Предпочитаете .NET на сервере?** Форма прокси не зависит от Dart. Minimal API на ASP.NET Core, которое передаёт потоком ответ LLM через `HttpClient` и `IAsyncEnumerable`, разобрано в [вызове Claude API из minimal API на .NET 11 с потоковой передачей](/ru/2026/04/how-to-call-the-claude-api-from-a-net-11-minimal-api-with-streaming/); замените URL upstream и тело запроса на OpenAI и сохраните те же правила аутентификации, ограничения частоты и фиксации модели.

### Читайте также

- [Как настроить CORS для API, защищённого JWT, в ASP.NET Core 11](/ru/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/)
- [Как вызывать Claude API из minimal API на .NET 11 с потоковой передачей](/ru/2026/04/how-to-call-the-claude-api-from-a-net-11-minimal-api-with-streaming/)
- [Как отменить StreamSubscription в dispose во Flutter](/ru/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/)
- [FlutterGuard CLI: что атакующий может извлечь из приложения Flutter 3.x?](/ru/2026/01/flutterguard-cli-a-fast-what-can-an-attacker-extract-check-for-flutter-3-x-apps/)

### Источники

- [Best practices for API key safety](https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety) (OpenAI Help Center)
- [How to incorporate a safety identifier](https://help.openai.com/en/articles/5428082-how-to-incorporate-a-safety-identifier) (OpenAI Help Center)
- [Streaming API responses](https://developers.openai.com/api/docs/guides/streaming-responses) (документация OpenAI)
- [Realtime API with WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc) (документация OpenAI)
- [package:http changelog](https://pub.dev/packages/http/changelog) (BrowserClient на Fetch в 1.3.0, исправление отмены веб-потока в 1.6.0)
- [package:shelf](https://pub.dev/packages/shelf) (pub.dev)
- [Set up a web development configuration file](https://docs.flutter.dev/platform-integration/web/web-dev-config-file) (документация Flutter)
