---
title: "OpenAI-API aus einer Flutter-Web-App aufrufen, ohne den API-Schlüssel preiszugeben"
description: "Alles, was Sie in einen Flutter-Web-Build kompilieren, auch --dart-define-Werte, landet im Klartext im Browser. Das einzige sichere Muster ist ein kleiner Backend-Proxy, der den Schlüssel hält, den Benutzer authentifiziert, das Modell festlegt und die SSE der Responses API zurückstreamt. Vollständiger Dart-shelf-Proxy und Flutter-Client, getestet mit Flutter 3.44, Dart 3.12 und http 1.6."
pubDate: 2026-10-27
template: how-to
tags:
  - "flutter"
  - "flutter-web"
  - "dart"
  - "openai"
  - "security"
  - "how-to"
lang: "de"
translationOf: "2026/10/how-to-call-the-openai-api-from-a-flutter-web-app-without-exposing-the-api-key"
translatedBy: "claude"
translationDate: 2026-10-27
---

**Kurze Antwort:** Einen OpenAI-API-Schlüssel können Sie in einer Flutter-Web-App nicht verstecken. `--dart-define`, `String.fromEnvironment`, ein mitgeliefertes `.env`-Asset und Obfuskierung landen alle in Dateien, die der Browser herunterlädt, und der Schlüssel ist zudem im `Authorization`-Header jeder Anfrage in den DevTools sichtbar. Legen Sie den Schlüssel auf einen Server, den Sie kontrollieren, lassen Sie die Flutter-App diesen Server mit dem eigenen Sitzungs-Token des Benutzers aufrufen und lassen Sie den Server die OpenAI-Anfrage zusammenbauen (festes Modell, begrenzte Tokens, gesetzte `safety_identifier`) und die Antwort zurückstreamen. Unten finden Sie einen vollständigen, getesteten Proxy in Dart mit `shelf` und einen Flutter-Web-Client, der die gestreamte Antwort Token für Token darstellt.

Alles hier wurde mit Flutter 3.44.8, Dart 3.12.2, `package:http` 1.6.0 und `package:shelf` 1.4 gegen die OpenAI Responses API (`POST /v1/responses`) gebaut und ausgeführt. Der Proxy wurde durchgängig in einem Browser gegen einen lokalen Fake-Upstream getestet, der dieselbe Server-Sent-Event-Struktur wie OpenAI ausgibt. Das Streaming- und CORS-Verhalten unten ist also gemessen, nicht angenommen.

## Warum `--dart-define` und `.env`-Dateien den Schlüssel nicht schützen

Der übliche erste Versuch sieht so aus:

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

Gebaut mit einem Fake-Schlüssel:

```bash
flutter build web --release --dart-define=OPENAI_API_KEY=sk-proj-DEMO1234567890leak
grep -o '.\{30\}sk-proj-[A-Za-z0-9]*.\{5\}' build/web/main.dart.js
```

Der Release-Build, von dart2js minifiziert, enthält weiterhin diese Zeile:

```text
A.aC(["Authorization","Bearer sk-proj-DEMO1234567890leak"],s,
```

`String.fromEnvironment` ist eine Compile-Zeit-Konstante, daher setzt der Compiler den Wert als String-Literal ein. Minifizierung benennt Bezeichner um, sie verschlüsselt niemals Strings. Ich habe dieselbe App auch mit `flutter build web --wasm` gebaut, und der Schlüssel steht als reine Bytes in `main.dart.wasm` (`grep -a` findet ihn). Wenn Sie wissen möchten, was der Wasm-Build erzeugt, lesen Sie [wie Sie eine Flutter-Web-App mit WebAssembly bauen](/de/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/): Er ändert die Laufzeit, nicht aber, wer Ihre Konstanten lesen kann.

Die anderen beliebten Varianten scheitern auf dieselbe Weise:

- Eine `.env`-Datei, die in `pubspec.yaml` unter `assets:` aufgeführt ist, wird unter `/assets/.env` ausgeliefert (Flutter-Web-Assets sind einfache statische Dateien). Jeder kann sie abrufen.
- `flutter build --obfuscate` ist für Web-Builds gar nicht verfügbar (die Flutter-Dokumentation verweist stattdessen auf Minifizierung), und auf Mobilgeräten benennt es nur Symbole um, niemals String-Literale.
- Den Schlüssel in Teile zu zerlegen und zur Laufzeit zusammenzusetzen, hält einen Menschen höchstens eine Minute auf. Der finale String erscheint trotzdem im Anfrage-Header.

Es gibt keine clientseitige Lösung, weil der Browser den Schlüssel an OpenAI senden muss. Wer den Browser kontrolliert, kontrolliert die Anfrage. Auch OpenAIs eigene [Hinweise zur API-Schlüssel-Sicherheit](https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety) sagen dasselbe: Den Schlüssel niemals in Browsern oder mobilen Apps bereitstellen, sondern Anfragen über das eigene Backend leiten. Ein geleakter Schlüssel ist nicht nur ein Abrechnungsproblem. Je nach Berechtigungen kann er Ihre gespeicherten Antworten, Dateien und Vektorspeicher lesen und jedes Modell nutzen, auf das Ihr Projekt Zugriff hat.

## Was der Proxy leisten muss (und warum "den Body einfach weiterleiten" nicht reicht)

Ein Proxy, der den eingehenden Body an OpenAI kopiert und nur den Schlüssel hinzufügt, verschiebt das Problem lediglich: Jetzt kann jeder Ihre Proxy-URL als kostenlosen OpenAI-Endpunkt verwenden. Ein brauchbarer Proxy erledigt fünf Dinge:

1. **Er authentifiziert den Aufrufer** mit einer Zugangsberechtigung, die dem Benutzer gehört (ein Firebase-ID-Token, Ihr Sitzungs-Cookie, ein OIDC-Access-Token), nicht mit einem gemeinsamen App-Geheimnis, das sich selbst extrahieren ließe.
2. **Er drosselt pro Benutzer**, damit ein einzelnes Konto Ihr Budget nicht aufbrauchen kann.
3. **Er akzeptiert nur die erwarteten Felder.** Der Client sendet einen Prompt. Der Server entscheidet über Modell, Anweisungen und `max_output_tokens`. Könnte der Client `model` wählen, würde ein Angreifer das teuerste wählen.
4. **Er baut die Upstream-Anfrage** mit dem geheimen Schlüssel und einer `safety_identifier`, einem stabilen Zeichenfolgenwert pro Benutzer (maximal 64 Zeichen, gehasht, wenn er aus einer E-Mail-Adresse abgeleitet wird), der es OpenAI erlaubt, Missbrauch einem Ihrer Benutzer statt Ihrer ganzen Organisation zuzuordnen. Sie ersetzt den älteren Parameter `user`, siehe [OpenAIs Artikel zur Safety Identifier](https://help.openai.com/en/articles/5428082-how-to-incorporate-a-safety-identifier).
5. **Er streamt die Antwort ungepuffert zurück**, damit der Benutzer Tokens sieht, sobald sie ankommen, statt auf die vollständige Antwort zu warten.

## Schritte, um OpenAI hinter einen eigenen Endpunkt zu legen

1. Erstellen Sie ein Dart-Server-Projekt für den Proxy und fügen Sie `shelf` und `http` hinzu.
2. Speichern Sie den OpenAI-Schlüssel als serverseitiges Geheimnis (Umgebungsvariable oder der Secret Manager Ihrer Plattform), niemals im Flutter-Repository.
3. Implementieren Sie `POST /api/chat`: Benutzer prüfen, drosseln, den Prompt validieren, `/v1/responses` mit `stream: true` aufrufen und den SSE-Stream zurückleiten.
4. Beschränken Sie CORS auf den Origin Ihrer Web-App oder liefern Sie den Flutter-Build vom selben Origin aus und verzichten Sie ganz auf CORS.
5. Rufen Sie in der Flutter-App `/api/chat` mit dem Token des Benutzers auf und parsen Sie `response.output_text.delta`-Ereignisse aus dem Stream.
6. Stellen Sie den Proxy bereit (Cloud Run, Fly.io, eine VM, alles, was eine Dart-Executable oder einen Container ausführt) und übergeben Sie seine URL mit `--dart-define=CHAT_PROXY_URL=...` an den Flutter-Build. Eine URL darf ausgeliefert werden, ein Geheimnis nicht.

## Der Proxy: etwa 100 Zeilen Dart

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

Einige Details leisten mehr, als man ihnen ansieht:

- **`'shelf.io.buffer_output': false`** sorgt dafür, dass das Streaming funktioniert. Ohne diese Option puffert `shelf_io` den Antwort-Body, und der Browser erhält alles erst am Ende. Mit ihr empfing curl jedes SSE-Ereignis im selben 400-ms-Takt, in dem der Fake-Upstream sie geschrieben hat.
- **`store: false`** weist OpenAI an, die Antwort nicht für einen späteren Abruf aufzubewahren. Lassen Sie es aktiviert, wenn Sie für Mehrrunden-Unterhaltungen auf `previous_response_id` setzen. Bewahren Sie die Antwort-IDs dann aber auch auf dem Server auf, damit ein Benutzer die Unterhaltung eines anderen nicht durch Raten von IDs fortsetzen kann.
- **Der Body des Upstream-Fehlers wird protokolliert, nicht zurückgegeben.** OpenAI-Fehlermeldungen können Organisations- oder Projektdetails enthalten, die Sie einem Browser nicht mitgeben müssen.
- **`OPENAI_BASE_URL`** gibt es, damit Sie den Proxy in Tests auf einen Fake-Upstream richten können, genau so habe ich ihn verifiziert. Modell-IDs ändern sich oft. Prüfen Sie die aktuelle Liste auf der [OpenAI-Modellseite](https://developers.openai.com/api/docs/models) und ändern Sie `_model` auf dem Server, ohne die App anzufassen.

Der Lauf gegen den Fake-Upstream mit curl zeigt, dass alle drei Schutzmaßnahmen greifen:

```bash
# no token -> 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8080/api/chat -d '{"prompt":"hi"}'

# valid token, client tries to pick a model -> streams, model is ignored
curl -sN -X POST localhost:8080/api/chat -H 'Authorization: Bearer demo-alice' \
  -d '{"prompt":"hi","model":"gpt-6-astra"}'
```

Der Fake-Upstream protokollierte, was den Server tatsächlich verlassen hat: `"model":"gpt-6-luna"`, `"safety_identifier":"alice"` und `Authorization: Bearer <server key>`. Das Feld `model` des Clients kam nie durch. Eine zweite Anfrage desselben Benutzers innerhalb von zwei Sekunden erhielt `429 slow down`.

## Die Demo-Authentifizierung ersetzen

`_verifyUser` ist der einzige Teil, den Sie vor der Auslieferung neu schreiben müssen. Die Regel lautet: Die Zugangsberechtigung muss einen Benutzer identifizieren und von einer Stelle ausgestellt sein, die ein Angreifer nicht nachahmen kann:

- **Firebase Authentication:** Die Flutter-App ruft `FirebaseAuth.instance.currentUser!.getIdToken()` auf und sendet das Ergebnis als Bearer-Token. Der Proxy prüft die JWT-Signatur gegen die öffentlichen Signaturschlüssel von Google und kontrolliert `aud` (Ihre Firebase-Projekt-ID), `iss` und `exp`, und nutzt dann den `sub`-Claim als `userId`.
- **Ihre eigene Backend-Sitzung:** Wird die Flutter-App von derselben Site wie Ihre bestehende API ausgeliefert, genügt ein `SameSite=Lax`- oder `Strict`-Sitzungs-Cookie, und Sie brauchen gar keinen `Authorization`-Header.
- **OIDC (Entra ID, Auth0, Keycloak):** Prüfen Sie Signatur, Audience und Scope des Access-Tokens genau wie bei jeder anderen API. Das [CORS- und JWT-Setup für eine geschützte ASP.NET-Core-API](/de/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/) behandelt dieselben Preflight- und Header-Regeln von der Serverseite.

Anonyme öffentliche Apps sind der schwierige Fall. Ohne Login bleibt Ihnen nur, per IP zu begrenzen, eine Bot-Prüfung wie Firebase App Check oder Cloudflare Turnstile hinzuzufügen und ein hartes Monatsbudget für das OpenAI-Projekt zu setzen. Gehen Sie davon aus, dass der Endpunkt gefunden und per Skript angesprochen wird.

Die In-Memory-Map `_lastCall` funktioniert zudem nur für eine einzelne Instanz. Sobald Sie horizontal skalieren, verlagern Sie die Drosselung nach Redis oder in den Rate Limiter Ihrer Plattform und fügen ein tägliches Token-Budget pro Benutzer hinzu, indem Sie `usage` aus dem Ereignis `response.completed` lesen.

## Der Flutter-Web-Client: SSE streamen mit `package:http`

Seit `package:http` 1.3.0 nutzt `BrowserClient` die Fetch API statt `XMLHttpRequest`, daher stellt `client.send()` im Web den Antwort-Body als echten Stream von Chunks bereit. Das ist alles, was Sie zum Lesen von Server-Sent Events brauchen; ein separates SSE-Paket ist nicht nötig.

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

Hängen Sie in einem Widget jedes Delta innerhalb von `setState` an einen `StringBuffer` an:

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

Ich habe diesen Client mit `flutter build web --release --dart-define=CHAT_PROXY_URL=http://localhost:8080/api/chat` gebaut, von `localhost:8081` ausgeliefert (ein anderer Origin als der Proxy, CORS wurde also tatsächlich beansprucht) und in einem Browser auf die Schaltfläche geklickt. Der Fake-Upstream gibt alle 400 ms ein Wort aus, und die UI protokollierte die Deltas bei 25, 416, 820, 1223 und 1627 ms: echtes inkrementelles Rendering, kein einzelner gepufferter Block am Ende. `grep` auf der `main.dart.js` dieses Builds findet die Proxy-URL und keine Spur des Server-Schlüssels.

Kann der Benutzer mitten in einer Antwort wegnavigieren, halten Sie die `StreamSubscription`, statt `await for` zu verwenden, und brechen Sie sie in `dispose` ab. Das Abbrechen schließt den Fetch, der wiederum die Upstream-Verbindung des Proxys schließt und OpenAI daran hindert, den Rest zu generieren (und abzurechnen). Das Muster ist dasselbe wie in [wie Sie eine StreamSubscription in dispose in Flutter abbrechen](/de/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/). `package:http` 1.6.0 hat gezielt das Abbrechen von Web-Antwort-Streams behoben, die auf den nächsten Chunk warten, bleiben Sie also bei 1.6.0 oder neuer.

## Stolperfallen bei der Bereitstellung

**CORS-Fehler ohne Statuscode.** Stimmt `ALLOWED_ORIGIN` nicht exakt mit dem Origin der Seite überein (Schema, Host und Port), blockiert der Browser die Antwort, und Dart sieht nur eine generische `ClientException: Failed to fetch`. Die Anfrage kann OpenAI dennoch erreicht und Geld gekostet haben. Die sauberste Lösung ist, CORS zu vermeiden: Liefern Sie `build/web` vom selben Origin wie `/api/chat` aus, entweder vom Proxy selbst oder hinter einem einzigen Reverse Proxy. Während der Entwicklung kann Flutter 3.38 und neuer über eine [Proxy-Regel in `web_dev_config.yaml`](https://docs.flutter.dev/platform-integration/web/web-dev-config-file) ein Pfadpräfix an Ihren lokalen Proxy weiterleiten, was Ihnen auch unter `flutter run -d chrome` Aufrufe vom selben Origin liefert.

**Plattform-Pufferung bricht das Streaming.** Manche Hosts und CDNs puffern `text/event-stream`-Antworten oder erzwingen ein Antwort-Timeout von 30 bis 60 Sekunden. Kommen die Tokens in Produktion auf einmal an, streamen aber lokal, prüfen Sie die Response-Streaming-Einstellungen der Plattform, bevor Sie Dart verdächtigen. Nginx benötigt für die Location `proxy_buffering off;` (oder einen Antwort-Header `X-Accel-Buffering: no`).

**Halten Sie Caching-Schichten von `/api/` fern.** Wenn Sie ein CDN, einen eigenen Service Worker oder einen HTTP-Cache vor die App setzen, nehmen Sie den Proxy-Pfad aus, damit gestreamte Antworten nie zwischengespeichert oder erneut ausgespielt werden. Veraltete Builds sind ein eigenes Problem, das in [warum Flutter Web nach dem Neuladen einen veralteten gecachten Build ausliefert](/de/2026/09/fix-flutter-web-serves-a-stale-cached-build-after-reload/) behandelt wird.

**Dieselbe Regel gilt für Mobilgeräte.** Ein Android- oder iOS-Build macht die Extraktion etwas unbequemer, aber nicht unmöglich: Strings lassen sich mit Standardwerkzeugen aus `libapp.so` wiederherstellen. Werkzeuge wie [FlutterGuard CLI](/de/2026/01/flutterguard-cli-a-fast-what-can-an-attacker-extract-check-for-flutter-3-x-apps/) existieren genau dafür, zu zeigen, was ein Angreifer aus einem Release-Build ziehen kann. Verwenden Sie für jede Plattform denselben Proxy.

**Realtime-Sprache ist die eine Ausnahme, und auch sie braucht einen Server.** Für die Realtime API über WebRTC darf sich der Browser direkt mit OpenAI verbinden, aber nur mit einem kurzlebigen ephemeren Schlüssel (`ek_...`), den Ihr Server durch einen Aufruf von `POST /v1/realtime/client_secrets` mit dem echten Schlüssel erzeugt. Der Standardschlüssel verlässt den Server weiterhin nie. Siehe OpenAIs [Leitfaden zur Realtime API mit WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc).

**Lieber .NET auf dem Server?** Die Proxy-Struktur hängt nicht von Dart ab. Eine ASP.NET-Core-Minimal-API, die eine LLM-Antwort mit `HttpClient` und `IAsyncEnumerable` streamt, wird in [Claude-API aus einer .NET-11-Minimal-API mit Streaming aufrufen](/de/2026/04/how-to-call-the-claude-api-from-a-net-11-minimal-api-with-streaming/) Schritt für Schritt gezeigt. Tauschen Sie Upstream-URL und Anfrage-Body gegen die von OpenAI aus und behalten Sie dieselben Regeln für Authentifizierung, Drosselung und Modellfestlegung bei.

### Weiterlesen

- [CORS für eine JWT-geschützte API in ASP.NET Core 11 konfigurieren](/de/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/)
- [Claude-API aus einer .NET-11-Minimal-API mit Streaming aufrufen](/de/2026/04/how-to-call-the-claude-api-from-a-net-11-minimal-api-with-streaming/)
- [Eine StreamSubscription in dispose in Flutter abbrechen](/de/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/)
- [FlutterGuard CLI: Was kann ein Angreifer aus einer Flutter-3.x-App extrahieren?](/de/2026/01/flutterguard-cli-a-fast-what-can-an-attacker-extract-check-for-flutter-3-x-apps/)

### Quellen

- [Best practices for API key safety](https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety) (OpenAI Help Center)
- [How to incorporate a safety identifier](https://help.openai.com/en/articles/5428082-how-to-incorporate-a-safety-identifier) (OpenAI Help Center)
- [Streaming API responses](https://developers.openai.com/api/docs/guides/streaming-responses) (OpenAI docs)
- [Realtime API with WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc) (OpenAI docs)
- [package:http changelog](https://pub.dev/packages/http/changelog) (BrowserClient on Fetch in 1.3.0, web stream cancellation fix in 1.6.0)
- [package:shelf](https://pub.dev/packages/shelf) (pub.dev)
- [Set up a web development configuration file](https://docs.flutter.dev/platform-integration/web/web-dev-config-file) (Flutter docs)
