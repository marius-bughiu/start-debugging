---
title: "API キーを公開せずに Flutter Web アプリから OpenAI API を呼び出す方法"
description: "Flutter Web ビルドにコンパイルしたものは、--dart-define の値も含めて、すべて平文でブラウザーに配信されます。安全な方法は、キーを保持し、ユーザーを認証し、モデルを固定し、Responses API の SSE をストリーミングで返す小さなバックエンドプロキシだけです。Flutter 3.44、Dart 3.12、http 1.6 で検証した Dart shelf プロキシと Flutter クライアントの完全なコードを紹介します。"
pubDate: 2026-10-27
template: how-to
tags:
  - "flutter"
  - "flutter-web"
  - "dart"
  - "openai"
  - "security"
  - "how-to"
lang: "ja"
translationOf: "2026/10/how-to-call-the-openai-api-from-a-flutter-web-app-without-exposing-the-api-key"
translatedBy: "claude"
translationDate: 2026-10-27
---

**結論:** Flutter Web アプリの中に OpenAI API キーを隠すことはできません。`--dart-define`、`String.fromEnvironment`、同梱した `.env` アセット、難読化は、いずれもブラウザーがダウンロードするファイルに含まれます。さらに、キーはすべてのリクエストの `Authorization` ヘッダーとして DevTools にも表示されます。キーは自分で管理するサーバーに置き、Flutter アプリにはユーザー自身のセッショントークンを付けてそのサーバーを呼び出させ、OpenAI へのリクエストはサーバー側で組み立てます(モデル固定、トークン数の上限、`safety_identifier` の設定)。レスポンスはそのままストリーミングで返します。以下に、`shelf` を使った Dart 製の動作確認済みプロキシと、ストリーミングされた回答をトークン単位で表示する Flutter Web クライアントを示します。

ここで紹介するものはすべて、Flutter 3.44.8、Dart 3.12.2、`package:http` 1.6.0、`package:shelf` 1.4 で構築し、OpenAI Responses API(`POST /v1/responses`)に対して実行しています。プロキシは、OpenAI と同じ形式の Server-Sent Events を返すローカルのフェイク上流サーバーを相手に、ブラウザーからエンドツーエンドでテストしました。そのため、以下のストリーミングと CORS の挙動は推測ではなく実測です。

## `--dart-define` や `.env` ファイルでキーを守れない理由

最初に試しがちなのは次のようなコードです。

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

偽のキーでビルドします。

```bash
flutter build web --release --dart-define=OPENAI_API_KEY=sk-proj-DEMO1234567890leak
grep -o '.\{30\}sk-proj-[A-Za-z0-9]*.\{5\}' build/web/main.dart.js
```

dart2js で minify したリリースビルドにも、次の行が残っています。

```text
A.aC(["Authorization","Bearer sk-proj-DEMO1234567890leak"],s,
```

`String.fromEnvironment` はコンパイル時定数なので、コンパイラーは値を文字列リテラルとしてインライン展開します。minify は識別子の名前を変えるだけで、文字列を暗号化することはありません。同じアプリを `flutter build web --wasm` でもビルドしましたが、キーは `main.dart.wasm` に平文のバイト列として含まれていました(`grep -a` で見つかります)。Wasm ビルドの内容を確認したい場合は [how to build a Flutter web app with WebAssembly](/ja/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/) を参照してください。変わるのはランタイムであり、定数を誰が読めるかではありません。

よく使われる他の方法も、同じ理由で失敗します。

- `pubspec.yaml` の `assets:` に載せた `.env` ファイルは `/assets/.env` で配信されます(Flutter Web のアセットはただの静的ファイルです)。誰でも取得できます。
- `flutter build --obfuscate` は Web ビルドではそもそも利用できず(Flutter のドキュメントでは minify が案内されています)、モバイルでもシンボル名を変えるだけで文字列リテラルは変わりません。
- キーを分割して実行時に連結しても、人間の手間が 1 分増えるだけです。最終的な文字列はリクエストヘッダーに現れます。

ブラウザーが OpenAI にキーを送らなければならない以上、クライアント側での解決策はありません。ブラウザーを制御できる人は、リクエストも制御できます。OpenAI 自身の [API key safety guidance](https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety) も同じことを述べています。キーをブラウザーやモバイルアプリにデプロイせず、自前のバックエンド経由でリクエストを送るようにしてください。キーの漏えいは課金だけの問題ではありません。権限によっては、保存されたレスポンス、ファイル、ベクトルストアを読み取られ、プロジェクトでアクセスできるすべてのモデルを使われる可能性があります。

## プロキシがすべきこと("ボディをそのまま転送する"だけでは不十分な理由)

受け取ったボディを OpenAI にコピーしてキーを付けるだけのプロキシは、問題を移しただけです。誰でもあなたのプロキシ URL を無料の OpenAI エンドポイントとして使えてしまいます。実用的なプロキシは次の 5 つを行います。

1. **呼び出し元を認証する。** 認証にはユーザー自身の資格情報(Firebase ID トークン、セッション Cookie、OIDC アクセストークン)を使います。共有のアプリシークレットは、それ自体が抽出されてしまうので使いません。
2. **ユーザーごとにスロットリングする。** 1 つのアカウントで予算を使い切れないようにします。
3. **想定したフィールドだけを受け付ける。** クライアントが送るのはプロンプトだけです。モデル、instructions、`max_output_tokens` はサーバーが決めます。クライアントが `model` を選べると、攻撃者は最も高価なモデルを選びます。
4. **秘密のキーと `safety_identifier` を付けて上流リクエストを組み立てる。** `safety_identifier` はユーザーごとに安定した文字列です(最大 64 文字で、メールアドレスから作る場合はハッシュ化します)。これにより OpenAI は、不正利用を組織全体ではなく、あなたのユーザーの 1 人に結び付けられます。古い `user` パラメーターの後継です。詳しくは [OpenAI's safety identifier article](https://help.openai.com/en/articles/5428082-how-to-incorporate-a-safety-identifier) を参照してください。
5. **回答をバッファリングせずにストリーミングで返す。** ユーザーは、完全な回答を待たずに、届いたトークンから順に読めます。

## OpenAI を自前のエンドポイントの背後に置く手順

1. プロキシ用の Dart サーバープロジェクトを作成し、`shelf` と `http` を追加します。
2. OpenAI キーはサーバー側のシークレット(環境変数、またはプラットフォームのシークレットマネージャー)として保存します。Flutter のリポジトリには置きません。
3. `POST /api/chat` を実装します。ユーザーを検証し、スロットリングし、プロンプトを検証し、`stream: true` で `/v1/responses` を呼び出し、SSE ストリームをそのまま返します。
4. CORS は Web アプリのオリジンだけに制限します。あるいは Flutter のビルドを同一オリジンから配信して、CORS 自体を不要にします。
5. Flutter アプリでは、ユーザーのトークンを付けて `/api/chat` を呼び出し、ストリームから `response.output_text.delta` イベントを解析します。
6. プロキシをデプロイし(Cloud Run、Fly.io、VM など、Dart の実行ファイルまたはコンテナーを実行できる場所ならどこでも)、その URL を `--dart-define=CHAT_PROXY_URL=...` で Flutter のビルドに渡します。URL は配信して構いませんが、シークレットは配信してはいけません。

## プロキシ: 約 100 行の Dart

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

見た目以上に重要な点がいくつかあります。

- **`'shelf.io.buffer_output': false`** がストリーミングを成立させる設定です。これがないと、`shelf_io` はレスポンスボディをバッファリングし、ブラウザーは最後にまとめて受け取ることになります。設定すると、curl はフェイク上流サーバーが書き込んだのと同じ 400 ms 間隔で、各 SSE イベントを受信しました。
- **`store: false`** は、後で取得できるようにレスポンスを保存しないよう OpenAI に伝えます。マルチターンの会話で `previous_response_id` を使う場合はオンのままにしてください。その場合は、レスポンス ID もサーバー側で保持し、ID を推測して他のユーザーの会話を続行できないようにします。
- **上流のエラーボディはログに記録するだけで、返しません。** OpenAI のエラーメッセージには、ブラウザーに渡す必要のない組織やプロジェクトの詳細が含まれることがあります。
- **`OPENAI_BASE_URL`** は、テストでプロキシをフェイク上流サーバーに向けるためのものです。まさにこの方法で検証しました。モデル ID は頻繁に変わるので、現在の一覧は [OpenAI models page](https://developers.openai.com/api/docs/models) で確認し、アプリには手を入れずにサーバー側の `_model` を変更してください。

フェイク上流サーバーに対して curl で実行すると、3 つのガードがすべて機能していることが分かります。

```bash
# no token -> 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8080/api/chat -d '{"prompt":"hi"}'

# valid token, client tries to pick a model -> streams, model is ignored
curl -sN -X POST localhost:8080/api/chat -H 'Authorization: Bearer demo-alice' \
  -d '{"prompt":"hi","model":"gpt-6-astra"}'
```

フェイク上流サーバーのログには、サーバーから実際に出ていった内容が記録されていました。`"model":"gpt-6-luna"`、`"safety_identifier":"alice"`、そして `Authorization: Bearer <server key>` です。クライアントの `model` フィールドは届いていません。同じユーザーが 2 秒以内に送った 2 回目のリクエストは `429 slow down` になりました。

## デモ用の認証を置き換える

出荷前に必ず書き換える必要があるのは `_verifyUser` だけです。ルールは、資格情報がユーザーを識別でき、かつ攻撃者がなりすませない何かによって発行されていることです。

- **Firebase Authentication:** Flutter アプリが `FirebaseAuth.instance.currentUser!.getIdToken()` を呼び出し、それを bearer トークンとして送ります。プロキシは JWT の署名を Google の公開署名キーで検証し、`aud`(Firebase プロジェクト ID)、`iss`、`exp` を確認してから、`sub` クレームを `userId` として使います。
- **自前のバックエンドセッション:** Flutter アプリが既存の API と同じサイトから配信されているなら、`SameSite=Lax` または `Strict` のセッション Cookie で十分で、`Authorization` ヘッダーはまったく不要です。
- **OIDC(Entra ID、Auth0、Keycloak):** 他の API と同様に、アクセストークンの署名、audience、スコープを検証します。[CORS and JWT setup for a protected ASP.NET Core API](/ja/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/) では、同じプリフライトとヘッダーのルールをサーバー側から解説しています。

匿名の公開アプリは難しいケースです。ログインがない場合にできるのは、IP によるレート制限、Firebase App Check や Cloudflare Turnstile などのボットチェックの追加、そして OpenAI プロジェクトに月次の予算上限を厳格に設定することです。エンドポイントは見つかり、スクリプトで叩かれるものと考えてください。

メモリ内の `_lastCall` マップも、単一インスタンスでしか機能しません。スケールアウトしたら、スロットリングを Redis かプラットフォームのレートリミッターに移し、`response.completed` イベントの `usage` を読んでユーザーごとの 1 日あたりトークン予算も追加してください。

## Flutter Web クライアント: `package:http` で SSE をストリーミングする

`package:http` 1.3.0 以降、`BrowserClient` は `XMLHttpRequest` ではなく Fetch API を使うため、Web での `client.send()` はレスポンスボディをチャンクの本物のストリームとして公開します。Server-Sent Events を読むにはこれで十分で、別の SSE パッケージは必要ありません。

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

ウィジェットでは、各 delta を `setState` の中で `StringBuffer` に追加します。

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

このクライアントを `flutter build web --release --dart-define=CHAT_PROXY_URL=http://localhost:8080/api/chat` でビルドし、`localhost:8081`(プロキシとは別のオリジンなので CORS も検証されます)から配信して、ブラウザーでボタンをクリックしました。フェイク上流サーバーは 400 ms ごとに 1 単語を出力し、UI のログに記録された delta の到着時刻は 25、416、820、1223、1627 ms でした。最後にまとめて 1 つのかたまりで表示されるのではなく、実際に少しずつ描画されています。このビルドの `main.dart.js` を `grep` すると、プロキシの URL は見つかりますが、サーバーのキーの痕跡はありません。

回答の途中でユーザーが画面遷移する可能性がある場合は、`await for` の代わりに `StreamSubscription` を保持し、`dispose` でキャンセルしてください。キャンセルすると fetch が閉じられ、プロキシの上流接続も閉じられて、OpenAI が残りを生成する(そして課金される)のを止められます。パターンは [how to cancel a StreamSubscription in dispose in Flutter](/ja/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/) と同じです。`package:http` 1.6.0 では、次のチャンクを待っている Web のレスポンスストリームのキャンセルが修正されているので、1.6.0 以降を使ってください。

## デプロイ時の注意点

**ステータスコードのない CORS エラー。** `ALLOWED_ORIGIN` がページのオリジン(スキーム、ホスト、ポート)と完全に一致しないと、ブラウザーがレスポンスをブロックし、Dart には汎用的な `ClientException: Failed to fetch` しか見えません。それでもリクエストは OpenAI に届いていて、料金が発生している可能性があります。最もきれいな解決策は CORS を避けることです。`build/web` を `/api/chat` と同じオリジンから、プロキシ自身または 1 つのリバースプロキシの背後で配信してください。開発中は、Flutter 3.38 以降で [`web_dev_config.yaml` proxy rule](https://docs.flutter.dev/platform-integration/web/web-dev-config-file) を使ってパスのプレフィックスをローカルのプロキシに転送でき、`flutter run -d chrome` でも同一オリジンの呼び出しになります。

**プラットフォームのバッファリングがストリーミングを壊す。** 一部のホストや CDN は `text/event-stream` のレスポンスをバッファリングしたり、30〜60 秒のレスポンスタイムアウトを課したりします。本番ではトークンがまとめて届くのにローカルではストリーミングされる場合は、Dart を疑う前にプラットフォームのレスポンスストリーミング設定を確認してください。Nginx では、該当の location に `proxy_buffering off;`(または `X-Accel-Buffering: no` レスポンスヘッダー)が必要です。

**キャッシュ層を `/api/` に近づけない。** アプリの前段に CDN、独自のサービスワーカー、HTTP キャッシュを置く場合は、ストリーミングされた回答がキャッシュされたり再生されたりしないよう、プロキシのパスを除外してください。古いビルドの問題は別の話題で、[why Flutter web serves a stale cached build after reload](/ja/2026/09/fix-flutter-web-serves-a-stale-cached-build-after-reload/) で扱っています。

**モバイルでも同じルールが当てはまります。** Android や iOS のビルドでは抽出の手間がやや増えるだけで、不可能にはなりません。`libapp.so` から標準的なツールで文字列を復元できます。[FlutterGuard CLI](/ja/2026/01/flutterguard-cli-a-fast-what-can-an-attacker-extract-check-for-flutter-3-x-apps/) のようなツールは、リリースビルドから攻撃者が何を取り出せるかを示すために存在します。すべてのプラットフォームで同じプロキシを使ってください。

**リアルタイム音声は唯一の例外ですが、それでもサーバーが必要です。** WebRTC 経由の Realtime API では、ブラウザーが OpenAI に直接接続することが許可されていますが、使えるのは短命の一時キー(`ek_...`)だけです。このキーは、サーバーが本物のキーで `POST /v1/realtime/client_secrets` を呼び出して発行します。通常のキーがサーバーの外に出ることは今回もありません。OpenAI の [Realtime API with WebRTC guide](https://developers.openai.com/api/docs/guides/realtime-webrtc) を参照してください。

**サーバー側は .NET が好みですか?** プロキシの構造は Dart に依存しません。`HttpClient` と `IAsyncEnumerable` で LLM のレスポンスをストリーミングする ASP.NET Core の minimal API は、[calling the Claude API from a .NET 11 minimal API with streaming](/ja/2026/04/how-to-call-the-claude-api-from-a-net-11-minimal-api-with-streaming/) で解説しています。上流の URL とリクエストボディを OpenAI のものに差し替え、認証、スロットリング、モデル固定のルールはそのまま維持してください。

### 関連記事

- [How to configure CORS for a JWT-protected API in ASP.NET Core 11](/ja/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/)
- [How to call the Claude API from a .NET 11 minimal API with streaming](/ja/2026/04/how-to-call-the-claude-api-from-a-net-11-minimal-api-with-streaming/)
- [How to cancel a StreamSubscription in dispose in Flutter](/ja/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/)
- [FlutterGuard CLI: what can an attacker extract from a Flutter 3.x app?](/ja/2026/01/flutterguard-cli-a-fast-what-can-an-attacker-extract-check-for-flutter-3-x-apps/)

### 参考資料

- [Best practices for API key safety](https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety) (OpenAI Help Center)
- [How to incorporate a safety identifier](https://help.openai.com/en/articles/5428082-how-to-incorporate-a-safety-identifier) (OpenAI Help Center)
- [Streaming API responses](https://developers.openai.com/api/docs/guides/streaming-responses) (OpenAI docs)
- [Realtime API with WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc) (OpenAI docs)
- [package:http changelog](https://pub.dev/packages/http/changelog) (1.3.0 で BrowserClient が Fetch に対応、1.6.0 で Web ストリームのキャンセルを修正)
- [package:shelf](https://pub.dev/packages/shelf) (pub.dev)
- [Set up a web development configuration file](https://docs.flutter.dev/platform-integration/web/web-dev-config-file) (Flutter docs)
