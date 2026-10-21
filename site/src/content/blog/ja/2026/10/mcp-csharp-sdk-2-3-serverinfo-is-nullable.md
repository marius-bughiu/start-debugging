---
title: "MCP C# SDK 2.3: McpClient.ServerInfo が null 許容になりました。ビルドに影響する可能性があります"
description: "2026年10月20日にリリースされた ModelContextProtocol 2.3.0 では、2026-07-28 のサーバーが server/discover で自身の識別情報を省略できるため、McpClient.ServerInfo が Implementation から Implementation? に変わりました。その理由、警告をエラー扱いにしている場合に何が壊れるか、1 行で済む修正方法を解説します。"
pubDate: 2026-10-21
tags:
  - "mcp"
  - "dotnet"
  - "csharp"
  - "ai-agents"
lang: "ja"
translationOf: "2026/10/mcp-csharp-sdk-2-3-serverinfo-is-nullable"
translatedBy: "claude"
translationDate: 2026-10-21
---

[MCP C# SDK 2.3.0](https://github.com/modelcontextprotocol/csharp-sdk/releases/tag/v2.3.0) が 2026年10月20日にリリースされました。マイナーバージョンとしては通常あまりない変更が 1 つ含まれています。`McpClient.ServerInfo` の注釈が `Implementation` から `Implementation?` に変わりました。CLR のシグネチャは同一なので、実行時やコンパイル済みの呼び出し元には影響しません。影響を受けるのは、`<Nullable>enable</Nullable>` と `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>` を有効にしていて、このプロパティを直接参照しているプロジェクトです。

## 接続済みのサーバーに識別情報がない場合がある理由

プロトコルのリビジョン `2026-07-28` では、ハンドシェイクは従来の `initialize` ではなく `server/discover` で行われます。ディスカバリーでは、`io.modelcontextprotocol/serverInfo` メタデータは省略可能です。サーバーは自分が何者かを一切伝えないまま、ディスカバリーに応答し、ツールを公開し、呼び出しを処理できます。

2.3.0 より前の SDK は、この状況をモデル化していませんでした。そのようなサーバーへの接続自体は成功しますが、その後に `ServerInfo` を読み取ると `InvalidOperationException` がスローされました。これはクライアントがまったく接続されていない場合と同じ例外です。そのため、正しく動作しているサーバーが壊れた接続のように見えていました。[PR #1903](https://github.com/modelcontextprotocol/csharp-sdk/pull/1903) は、代わりに `null` を返すことでこれを修正しました。

```csharp
public override Implementation? ServerInfo => _serverCapabilities is null
    ? throw new InvalidOperationException("The client is not connected.")
    : _serverInfo;
```

この変更から、次の 3 つのルールが導かれます。

- まだ接続していない場合: 従来どおり `InvalidOperationException` をスローします。
- `2026-07-28` で接続し、サーバーが識別情報を省略した場合: `null` です。
- 従来の `initialize` で接続した場合: この経路では引き続き `serverInfo` が必須のため、`null` にはなりません。

不正な形式のメタデータは、これまでどおり `JsonException` で接続に失敗します。したがって `null` は "提供されなかった" ことを意味し、"壊れたデータ" を意味しません。

## クライアントコードでの修正方法

次のようなコードは、`.Name` へのアクセスで CS8602 が発生するようになります。

```csharp
await using var client = await McpClient.CreateAsync(transport);

logger.LogInformation("Connected to {Server} {Version}",
    client.ServerInfo.Name, client.ServerInfo.Version);
```

null の場合を明示的に処理してください。

```csharp
await using var client = await McpClient.CreateAsync(transport);

var name = client.ServerInfo?.Name ?? "Unknown server";
var version = client.ServerInfo?.Version ?? "n/a";

logger.LogInformation("Connected to {Server} {Version}", name, version);
```

`!` 演算子には頼らないでください。警告は消えますが、ディスカバリーのみに対応したサーバーにクライアントを向けた最初の瞬間に、`NullReferenceException` が復活します。また、リリースノートでも、この自己申告の識別情報は "セキュリティ上の判断に使ってはならない" と明言されています。`ServerInfo.Name` に基づいてツールへのアクセスを制御しているなら、それはもともと誤りでした。ここで `null` に出会ったのは、自分で管理できる設定に置き換える良い機会です。

## 2.3.0 のその他の変更点

このリリースは主に相互運用性と信頼性に関する改善で、どれも取り込む価値があります。

- `McpClientOptions.TimeProvider` により、テストで実際の待機時間を使わず `FakeTimeProvider` でクライアントのタイムアウトを制御できます。OAuth は短い `DiscoverProbeTimeout` の予算から除外されましたが、`InitializationTimeout` の制限は引き続き受けます。
- ツール、プロンプト、リソースが登録順に一覧表示されるようになり (#1924)、`tools/list` の出力が実行ごとに安定します。
- 新しい Streamable HTTP のレスポンスは、最初のプロトコルメッセージを待ってからヘッダーを送信します。長時間応答しないハンドラーでは、進捗通知やより長い HTTP タイムアウトが必要になる場合があります。
- Stdio クライアントは、正常終了を待つ前にサーバーの stdin を閉じます。また、従来の SSE の POST レスポンスは確定的に破棄されます。
- Streamable HTTP の 400 レスポンスに JSON の解析エラーが含まれるようになり、不正なクライアントのペイロードをはるかに素早くデバッグできます。

アップグレードはパッケージの更新だけです。

```bash
dotnet add package ModelContextProtocol --version 2.3.0
```

まだ 1.x を使っている場合は、先に [1.x から 2.x への移行](/2026/09/migrate-mcp-csharp-sdk-1-x-to-2-0-without-breaking-old-clients/)を行ってください。その後、警告をエラーとして扱う設定でビルドし、`ServerInfo` を参照している箇所をコンパイラーにすべて洗い出させましょう。
