---
title: "Genkit Dart 1.0: GenkitRouter が startFlowServer に代わり、古い Flutter クライアントにはフラグが必要です"
description: "Genkit Dart 1.0.0 は API を固定し、HTTP 配信を GenkitRouter としてコアに移し、ストリーミングのエラーフレームを変更しました。0.17 クライアントのまま出荷済みの Flutter アプリには sendLegacyErrorFrame が必要です。"
pubDate: 2026-10-10
tags:
  - "dart"
  - "flutter"
  - "genkit"
  - "ai-agents"
lang: "ja"
translationOf: "2026/10/genkit-dart-1-0-genkitrouter-replaces-startflowserver"
translatedBy: "claude"
translationDate: 2026-10-10
---

Google は 2026年10月7日に [Genkit Dart 1.0.0](https://github.com/genkit-ai/genkit-dart/releases/tag/genkit-v1.0.0) をタグ付けし、10月8日に [Flutter ブログの発表記事](https://flutter.dev/blog/announcing-genkit-dart-1-0)が公開されました。コアの `genkit` パッケージ、`schemantic`、そして Google GenAI、Vertex AI、Anthropic、OpenAI、MCP、ミドルウェア、shelf の各プラグインが 1.0.0 になり、semver の対象になりました。`genkit_otel`、`genkit_chrome`、`genkit_firebase_ai`、`genkit_a2ui` は 0.x のままです。

リリースノートには、API を固定するために "a lot of breaking changes" があったと率直に書かれています。ほとんどは名前の変更です。ただし、すでにユーザーの手元にあるアプリを壊しかねない変更が 1 つあり、それは HTTP 配信にあります。

## startFlowServer は廃止され、GenkitRouter がコアに入りました

0.17 まででは、フローの配信には `genkit_shelf` と `startFlowServer` を使っていました。1.0 では HTTP 配信が `package:genkit/io.dart` に移り、素の `dart:io` 上で動作し、`genkit_shelf` は薄いアダプターになりました。`startFlowServer` と `FlowWithContextProvider` は削除されました ([#533](https://github.com/genkit-ai/genkit-dart/pull/533))。

```dart
// before (0.17)
await startFlowServer(
  flows: [helloFlow, FlowWithContextProvider(flow: secureFlow, context: bearerAuth)],
  cors: {'origin': '*'},
);

// after (1.0.0)
final genkit = GenkitRouter()
  ..addAction(helloFlow)
  ..addAction(secureFlow, contextProvider: bearerAuth);
await genkit.serve(cors: const CorsOptions());
```

コンテキストプロバイダーは、shelf の `Request` ではなく、フレームワークに依存しない `RequestData` を受け取るようになり、ヘッダー名は小文字になります。そのため `request.headers['Authorization']` という参照は `'authorization'` に変える必要があります。また、`handleHttpRequest(request, basePath: '/api')` を使えば、独自のサーバー内にルーターをマウントすることもできます。

## ストリーミングのエラーフレームが変わりました

ストリーミングのレスポンスは `Content-Type: text/event-stream` を使うようになり、失敗したストリームはエラーを含む `data:` フレームで終了します。これは Go や Python のサーバーと同じ形式です。Dart 3.12.2 と `genkit` 1.0.0 で 2 つのフローを持つサーバーを動かしました。ストリーミングのフローは 1 つチャンクを送ったあとに例外を投げます。

```dart
final boom = ai.defineFlow(
  name: 'boom',
  inputSchema: .string(),
  outputSchema: .string(),
  streamSchema: .string(),
  fn: (String name, ctx) async {
    ctx.sendChunk('partial');
    throw GenkitException('nope', status: StatusCode.internal);
  },
);
```

1.0 のデフォルト設定での `POST /boom?stream=true` の結果です。

```text
content-type: text/event-stream

data: {"message":"partial"}

data: {"error":{"code":500,"status":"INTERNAL","message":"nope"}}
```

リリースノートによると、genkit 0.17 以前のクライアントは古い `error:` フレームしか理解できません。0.17 でビルドした Flutter アプリがバックエンドを呼び出している場合、サーバーだけをアップグレードすると、そのクライアントはこれまでのようにエラーを受け取れなくなります。まだ更新されていない端末にインストールされているバージョンはすべて該当します。

対処はコンストラクターの引数を 1 つ指定するだけです。

```dart
final genkit = GenkitRouter(sendLegacyErrorFrame: true);
```

これを設定すると、同じリクエストは従来のフレームで終了します。

```text
data: {"message":"partial"}

error: {"error":{"code":500,"status":"INTERNAL","message":"nope"}}
```

非ストリーミングの呼び出しは影響を受けません。`POST /hello` は、どちらのモードでも `{"result":"Hello, Marius"}` を返しました。

## ほかにも grep しておきたい名前の変更

- `ExecutablePrompt` は `Prompt<Input, Output>` になり、プロンプトも `generate` と同様に型付きの `output` を返します。
- エージェント、セッション、スナップショット、双方向ストリーミングは `package:genkit/experimental.dart` の背後に移動し、インポートすると `experimental_member_use` のアナライザー警告が出ます。
- `agents()` は `genkit_middleware` から再エクスポートされなくなりました。`package:genkit_middleware/agents.dart` をインポートしてください。
- プラグイン作者向け: `defineMiddleware` は `generateMiddleware` になり、アプリのコードでは `ai.defineGenerateMiddleware` を使います。

Genkit のフローをモバイルクライアントに提供している場合、安全なアップグレードの順序は次のとおりです。まず `sendLegacyErrorFrame: true` を付けてサーバーを 1.0.0 でリリースし、次に Flutter アプリを 1.0 クライアントでリリースし、サポート対象の最小アプリバージョンが 0.17 を超えたらフラグを外します。
