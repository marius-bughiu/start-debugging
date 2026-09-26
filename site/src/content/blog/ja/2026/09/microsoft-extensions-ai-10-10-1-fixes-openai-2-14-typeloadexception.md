---
title: "Microsoft.Extensions.AI.OpenAI 10.10.1 で OpenAI 2.14 の TypeLoadException が修正されました"
description: "OpenAI 2.14.0 で GlobalMcpToolCallApprovalPolicy が改名され、Microsoft.Extensions.AI.OpenAI 10.10.0 経由でツールを含む Responses API 呼び出しがすべて壊れていました。10.10.1 は OpenAI 2.14.0 に移行し、OpenAI 互換エンドポイントでの reasoning status が null になる問題の修正も取り込みます。"
pubDate: 2026-09-26
tags:
  - "dotnet"
  - "ai"
  - "microsoft-extensions-ai"
  - "openai"
  - "csharp"
lang: "ja"
translationOf: "2026/09/microsoft-extensions-ai-10-10-1-fixes-openai-2-14-typeloadexception"
translatedBy: "claude"
translationDate: 2026-09-26
---

`Microsoft.Extensions.AI.OpenAI` 10.10.1 が 2026 年 9 月 25 日に NuGet に公開されました。[リリースノート](https://github.com/dotnet/extensions/releases/tag/v10.10.1) は "Upgrade OpenAI SDK to 2.14.0" の 1 行だけです。しかしこの 1 行の裏には実行時のクラッシュが隠れています。アプリが `Microsoft.Extensions.AI.OpenAI` 10.10.0 を参照していて、依存関係グラフのどこかが `OpenAI` を 2.14.0 に引き上げていた場合 (Dependabot の更新、直接参照、別のパッケージなど)、9 月 15 日以降、ツールを含む Responses API の呼び出しはすべて `TypeLoadException` で失敗していました。

## 改名された実験的な型が JIT 時に解決される

`OpenAI` 2.14.0 は 9 月 15 日にリリースされました。変更点の中に、実験的な構造体 `OpenAI.Responses.GlobalMcpToolCallApprovalPolicy` が `DefaultMcpToolCallApprovalPolicy` に、`McpToolCallApprovalPolicy` の `GlobalPolicy` プロパティが `DefaultPolicy` に改名されたことがあります。実験的 API (`OPENAI001`) は破壊的変更が許されていますが、`Microsoft.Extensions.AI.OpenAI` 10.10.0 は `OpenAIResponsesChatClient.ToResponseTool` の中で古い名前に対してコンパイルされていました。これは各 `AITool` を Responses のツールに変換するメソッドです。

10.10.0 の nuspec は `OpenAI` の最小バージョンを `2.13.0` と宣言しているため、別の何かが要求すれば NuGet は問題なく 2.14.0 を解決します。ビルド時には何も失敗しません。ツールを含む `ChatOptions` での最初の呼び出しが、JIT が `ToResponseTool` をコンパイルする時点で失敗します。

```text
System.TypeLoadException: Could not load type 'OpenAI.Responses.GlobalMcpToolCallApprovalPolicy'
from assembly 'OpenAI, Version=2.14.0.0, Culture=neutral, PublicKeyToken=b4187f3e65366280'.
   at Microsoft.Extensions.AI.OpenAIResponsesChatClient.ToResponseTool(AITool tool, ChatOptions options, ToolSearchLookup toolSearchLookup)
   at Microsoft.Extensions.AI.OpenAIResponsesChatClient.AsCreateResponseOptions(...)
   at Microsoft.Extensions.AI.OpenAIResponsesChatClient.GetStreamingResponseAsync(...)
```

MCP を使っているかどうかは関係ありません。メソッドがその型を参照しているので、普通の `AIFunction` でも発生します。[issue #7760](https://github.com/dotnet/extensions/issues/7760) では .NET 10 上の `Microsoft.Agents.AI.OpenAI` 1.21.0 で報告されています。

## OpenAI 2.13.0 に留まるのがきれいな回避策ではなかった理由

`OpenAI` を 2.13.0 に固定すればクラッシュは避けられますが、2.13.0 には別のバグがあります。`ReasoningResponseItem` のデシリアライズが JSON の `null` に対して `ToReasoningStatus()` を呼び出してしまうのです。reasoning 項目を省略せずに `"status": null` としてシリアライズするサードパーティの OpenAI 互換バックエンドでは、SSE ストリーム全体が `ArgumentOutOfRangeException: Unknown ReasoningStatus value` で切断されます。OpenAI 2.14.0 で null チェックが追加されました。つまり 1 週間ほど、どちらのバグを受け入れるか選ぶ必要がありました。

[PR #7761](https://github.com/dotnet/extensions/pull/7761) は両方を解決します。`OpenAI` 2.14.0 に更新し、`HostedMcpServerToolAlwaysRequireApprovalMode` と `HostedMcpServerToolNeverRequireApprovalMode` を `DefaultMcpToolCallApprovalPolicy` にマッピングし、`status` が null のケースに対するストリーミングの回帰テストを追加しています。

## アップグレード方法

2 つのパッケージは一緒に更新してください。`Microsoft.Extensions.AI.OpenAI` 10.10.1 は `OpenAI` 2.14.0 を必要とするため、回避策として 2.13.0 を固定していた場合はその固定を外してください。外さないとダウングレードエラー `NU1605` が発生します。

```xml
<ItemGroup>
  <PackageReference Include="Microsoft.Extensions.AI.OpenAI" Version="10.10.1" />
  <PackageReference Include="OpenAI" Version="2.14.0" />
</ItemGroup>
```

エージェントフレームワークや SDK ラッパーはこれらのパッケージを推移的に持ち込むことが多いので、実際に解決されたバージョンを確認します。

```bash
dotnet list package --include-transitive | grep -E "OpenAI|Extensions.AI"
```

自分のコードで MCP の承認関連の型を直接使っている場合は、改名の影響を受けます。

```csharp
#pragma warning disable OPENAI001
var policy = new McpToolCallApprovalPolicy(DefaultMcpToolCallApprovalPolicy.NeverRequireApproval);
var mode = policy.DefaultPolicy; // was policy.GlobalPolicy in OpenAI 2.13.0
#pragma warning restore OPENAI001
```

より一般的な教訓として、実験的 API を持つパッケージへのライブラリの最小バージョン依存は、事実上、破壊的変更に対して開かれた範囲です。Responses ベースのエージェントを本番で動かしているなら、依存関係を更新するたびにツール付きのリクエストを 1 回送るスモークテストがあれば、実行時ではなく CI でこの問題を検出できていたはずです。このリリースラインのその他の変更については、以前の記事 [Microsoft.Extensions.AI 10.10 がスコアのない評価メトリクスを失敗扱いにする件](/ja/2026/09/microsoft-extensions-ai-10-10-fails-closed-on-unscored-evaluation-metrics/) をご覧ください。
