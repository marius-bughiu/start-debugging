---
title: "How to call the OpenAI API from a Flutter web app without exposing the API key"
description: "Anything you compile into a Flutter web build, including --dart-define values, ships to the browser in plain text. The only safe pattern is a small backend proxy that holds the key, authenticates the user, pins the model, and streams the Responses API SSE back. Full Dart shelf proxy and Flutter client, tested with Flutter 3.44, Dart 3.12, and http 1.6."
pubDate: 2026-10-27
template: how-to
tags:
  - "flutter"
  - "flutter-web"
  - "dart"
  - "openai"
  - "security"
  - "how-to"
---

**Short answer:** you cannot hide an OpenAI API key inside a Flutter web app. `--dart-define`, `String.fromEnvironment`, a bundled `.env` asset, and obfuscation all end up in files the browser downloads, and the key is also visible in the `Authorization` header of every request in DevTools. Put the key on a server you control, have the Flutter app call that server with the user's own session token, and let the server build the OpenAI request (fixed model, capped tokens, `safety_identifier` set) and stream the response back. Below is a complete, tested proxy written in Dart with `shelf` and a Flutter web client that renders the streamed answer token by token.

Everything here was built and run with Flutter 3.44.8, Dart 3.12.2, `package:http` 1.6.0, and `package:shelf` 1.4 against the OpenAI Responses API (`POST /v1/responses`). The proxy was tested end to end in a browser against a local fake upstream that emits the same server-sent event shape as OpenAI, so the streaming and CORS behaviour below is measured, not assumed.

## Why `--dart-define` and `.env` files do not protect the key

The usual first attempt looks like this:

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

Built with a fake key:

```bash
flutter build web --release --dart-define=OPENAI_API_KEY=sk-proj-DEMO1234567890leak
grep -o '.\{30\}sk-proj-[A-Za-z0-9]*.\{5\}' build/web/main.dart.js
```

The release build, minified by dart2js, still contains this line:

```text
A.aC(["Authorization","Bearer sk-proj-DEMO1234567890leak"],s,
```

`String.fromEnvironment` is a compile-time constant, so the compiler inlines the value as a string literal. Minification renames identifiers, it never encrypts strings. I also built the same app with `flutter build web --wasm`, and the key is in `main.dart.wasm` as plain bytes (`grep -a` finds it). If you need a refresher on what the Wasm build produces, see [how to build a Flutter web app with WebAssembly](/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/): it changes the runtime, not who can read your constants.

The other popular variants fail the same way:

- A `.env` file listed under `assets:` in `pubspec.yaml` is served at `/assets/.env` (Flutter web assets are plain static files). Anyone can fetch it.
- `flutter build --obfuscate` is not available for web builds at all (Flutter's docs point to minification instead), and on mobile it only renames symbols, never string literals.
- Splitting the key into pieces and concatenating it at runtime only delays a human by a minute. The final string still appears in the request header.

There is no client-side fix because the browser has to send the key to OpenAI. Whoever controls the browser controls the request. OpenAI's own [API key safety guidance](https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety) says the same thing: never deploy the key in browsers or mobile apps, route requests through your own backend instead. A leaked key is not just a billing problem. Depending on its permissions, it can read your stored responses, files, and vector stores, and use every model your project has access to.

## What the proxy has to do (and why "just forward the body" is not enough)

A proxy that copies the incoming body to OpenAI and adds the key only moves the problem: now anyone can use your proxy URL as a free OpenAI endpoint. A useful proxy does five things:

1. **Authenticates the caller** with a credential that belongs to the user (a Firebase ID token, your session cookie, an OIDC access token), not with a shared app secret that would itself be extractable.
2. **Throttles per user**, so one account cannot drain your budget.
3. **Accepts only the fields you expect.** The client sends a prompt. The server decides the model, the instructions, and `max_output_tokens`. If the client could pick `model`, an attacker would pick the most expensive one.
4. **Builds the upstream request** with the secret key and a `safety_identifier`, a stable per-user string (max 64 characters, hashed if it is derived from an email) that lets OpenAI attribute abuse to one of your users instead of to your whole organization. It replaces the older `user` parameter, see [OpenAI's safety identifier article](https://help.openai.com/en/articles/5428082-how-to-incorporate-a-safety-identifier).
5. **Streams the answer back unbuffered**, so the user sees tokens as they arrive instead of waiting for the full completion.

## Steps to put OpenAI behind your own endpoint

1. Create a Dart server project for the proxy and add `shelf` and `http`.
2. Store the OpenAI key as a server-side secret (environment variable or your platform's secret manager), never in the Flutter repo.
3. Implement `POST /api/chat`: verify the user, throttle, validate the prompt, call `/v1/responses` with `stream: true`, and pipe the SSE stream back.
4. Restrict CORS to your web app's origin, or serve the Flutter build from the same origin and skip CORS entirely.
5. In the Flutter app, call `/api/chat` with the user's token and parse `response.output_text.delta` events from the stream.
6. Deploy the proxy (Cloud Run, Fly.io, a VM, anything that runs a Dart executable or a container) and pass its URL to the Flutter build with `--dart-define=CHAT_PROXY_URL=...`. A URL is fine to ship; a secret is not.

## The proxy: about 100 lines of Dart

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

A few details are doing more work than they look:

- **`'shelf.io.buffer_output': false`** is what makes streaming work. Without it, `shelf_io` buffers the response body and the browser gets everything at the end. With it, curl received each SSE event on the same 400 ms cadence the fake upstream wrote them.
- **`store: false`** tells OpenAI not to keep the response for later retrieval. Leave it on if you rely on `previous_response_id` for multi-turn conversations, but then keep the response IDs on the server too, so one user cannot continue another user's conversation by guessing IDs.
- **The upstream error body is logged, not returned.** OpenAI error messages can include organization or project details you do not need to hand to a browser.
- **`OPENAI_BASE_URL`** exists so you can point the proxy at a fake upstream in tests, which is exactly how I verified it. Model IDs change often; check the current list on the [OpenAI models page](https://developers.openai.com/api/docs/models) and change `_model` on the server without touching the app.

Running it against the fake upstream with curl shows all three guards working:

```bash
# no token -> 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8080/api/chat -d '{"prompt":"hi"}'

# valid token, client tries to pick a model -> streams, model is ignored
curl -sN -X POST localhost:8080/api/chat -H 'Authorization: Bearer demo-alice' \
  -d '{"prompt":"hi","model":"gpt-6-astra"}'
```

The fake upstream logged what actually left the server: `"model":"gpt-6-luna"`, `"safety_identifier":"alice"`, and `Authorization: Bearer <server key>`. The client's `model` field never made it through. A second request from the same user within two seconds got `429 slow down`.

## Replacing the demo authentication

`_verifyUser` is the only part you must rewrite before shipping. The rule is that the credential must identify a user and be issued by something the attacker cannot impersonate:

- **Firebase Authentication:** the Flutter app calls `FirebaseAuth.instance.currentUser!.getIdToken()` and sends it as the bearer token. The proxy verifies the JWT signature against Google's public signing keys and checks `aud` (your Firebase project ID), `iss`, and `exp`, then uses the `sub` claim as `userId`.
- **Your own backend session:** if the Flutter app is served from the same site as your existing API, a `SameSite=Lax` or `Strict` session cookie is enough, and you do not need an `Authorization` header at all.
- **OIDC (Entra ID, Auth0, Keycloak):** validate the access token's signature, audience, and scope exactly as you would for any other API. The [CORS and JWT setup for a protected ASP.NET Core API](/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/) covers the same preflight and header rules from the server side.

Anonymous public apps are the hard case. Without a login, the best you can do is rate-limit by IP, add a bot check such as Firebase App Check or Cloudflare Turnstile, and set a hard monthly budget on the OpenAI project. Assume the endpoint will be found and scripted.

The in-memory `_lastCall` map also only works for a single instance. Once you scale out, move the throttle to Redis or your platform's rate limiter, and add a daily token budget per user by reading `usage` from the `response.completed` event.

## The Flutter web client: streaming SSE with `package:http`

Since `package:http` 1.3.0, `BrowserClient` uses the Fetch API instead of `XMLHttpRequest`, so `client.send()` on the web exposes the response body as a real stream of chunks. That is all you need to read server-sent events; there is no need for a separate SSE package.

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

In a widget, append each delta to a `StringBuffer` inside `setState`:

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

I built this client with `flutter build web --release --dart-define=CHAT_PROXY_URL=http://localhost:8080/api/chat`, served it from `localhost:8081` (a different origin than the proxy, so CORS was exercised), and clicked the button in a browser. The fake upstream emits one word every 400 ms, and the UI logged the deltas at 25, 416, 820, 1223, and 1627 ms: real incremental rendering, not one buffered blob at the end. `grep` on that build's `main.dart.js` finds the proxy URL and no trace of the server key.

If the user can navigate away mid-answer, hold the `StreamSubscription` instead of using `await for`, and cancel it in `dispose`. Cancelling closes the fetch, which closes the proxy's upstream connection and stops OpenAI from generating (and billing) the rest. The pattern is the same as in [how to cancel a StreamSubscription in dispose in Flutter](/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/); `package:http` 1.6.0 specifically fixed cancellation of web response streams that are waiting for the next chunk, so stay on 1.6.0 or later.

## Gotchas when you deploy

**CORS errors with no status code.** If `ALLOWED_ORIGIN` does not match the page origin exactly (scheme, host, and port), the browser blocks the response and Dart only sees a generic `ClientException: Failed to fetch`. The request may still have reached OpenAI and cost money. The cleanest fix is to avoid CORS: serve `build/web` from the same origin as `/api/chat`, either from the proxy itself or behind one reverse proxy. During development, Flutter 3.38 and later can forward a path prefix to your local proxy through a [`web_dev_config.yaml` proxy rule](https://docs.flutter.dev/platform-integration/web/web-dev-config-file), which gives you same-origin calls under `flutter run -d chrome` too.

**Platform buffering breaks streaming.** Some hosts and CDNs buffer `text/event-stream` responses or impose a 30 to 60 second response timeout. If tokens arrive all at once in production but stream locally, check the platform's response-streaming settings before blaming Dart. Nginx needs `proxy_buffering off;` (or an `X-Accel-Buffering: no` response header) for the location.

**Keep caching layers away from `/api/`.** If you put a CDN, a custom service worker, or an HTTP cache in front of the app, exclude the proxy path so streamed answers are never cached or replayed. Stale builds are a separate problem covered in [why Flutter web serves a stale cached build after reload](/2026/09/fix-flutter-web-serves-a-stale-cached-build-after-reload/).

**The same rule applies to mobile.** An Android or iOS build makes extraction slightly less convenient, not impossible: strings are recoverable from `libapp.so` with standard tools. Tools like [FlutterGuard CLI](/2026/01/flutterguard-cli-a-fast-what-can-an-attacker-extract-check-for-flutter-3-x-apps/) exist precisely to show what an attacker can pull out of a release build. Use the same proxy for every platform.

**Realtime voice is the one exception, and it still needs a server.** For the Realtime API over WebRTC, the browser is allowed to connect directly to OpenAI, but only with a short-lived ephemeral key (`ek_...`) that your server mints by calling `POST /v1/realtime/client_secrets` with the real key. The standard key still never leaves the server. See OpenAI's [Realtime API with WebRTC guide](https://developers.openai.com/api/docs/guides/realtime-webrtc).

**Prefer .NET on the server?** The proxy shape does not depend on Dart. An ASP.NET Core minimal API that streams an LLM response with `HttpClient` and `IAsyncEnumerable` is walked through in [calling the Claude API from a .NET 11 minimal API with streaming](/2026/04/how-to-call-the-claude-api-from-a-net-11-minimal-api-with-streaming/); swap the upstream URL and request body for OpenAI's and keep the same auth, throttle, and model-pinning rules.

### Read next

- [How to configure CORS for a JWT-protected API in ASP.NET Core 11](/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/)
- [How to call the Claude API from a .NET 11 minimal API with streaming](/2026/04/how-to-call-the-claude-api-from-a-net-11-minimal-api-with-streaming/)
- [How to cancel a StreamSubscription in dispose in Flutter](/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/)
- [FlutterGuard CLI: what can an attacker extract from a Flutter 3.x app?](/2026/01/flutterguard-cli-a-fast-what-can-an-attacker-extract-check-for-flutter-3-x-apps/)

### Sources

- [Best practices for API key safety](https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety) (OpenAI Help Center)
- [How to incorporate a safety identifier](https://help.openai.com/en/articles/5428082-how-to-incorporate-a-safety-identifier) (OpenAI Help Center)
- [Streaming API responses](https://developers.openai.com/api/docs/guides/streaming-responses) (OpenAI docs)
- [Realtime API with WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc) (OpenAI docs)
- [package:http changelog](https://pub.dev/packages/http/changelog) (BrowserClient on Fetch in 1.3.0, web stream cancellation fix in 1.6.0)
- [package:shelf](https://pub.dev/packages/shelf) (pub.dev)
- [Set up a web development configuration file](https://docs.flutter.dev/platform-integration/web/web-dev-config-file) (Flutter docs)
