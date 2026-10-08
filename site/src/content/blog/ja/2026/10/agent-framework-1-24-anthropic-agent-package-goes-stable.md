---
title: "Agent Framework 1.24: Anthropic エージェントパッケージが安定版に、ただしベータサービスを除く"
description: "Microsoft.Agents.AI.Anthropic 1.24.0 はプレビューのサフィックスが外れ、Anthropic 12.53.0 に依存するようになりました。IAnthropicClient から作成するエージェントは安定版 API になり、client.Beta の拡張メソッドは MAAIANTHROPIC001 で experimental になりますが、拡張メソッド構文での呼び出しでは診断が出ません。"
pubDate: 2026-10-08
tags:
  - "agent-framework"
  - "dotnet"
  - "anthropic"
  - "ai-agents"
lang: "ja"
translationOf: "2026/10/agent-framework-1-24-anthropic-agent-package-goes-stable"
translatedBy: "claude"
translationDate: 2026-10-08
---

Microsoft Agent Framework [dotnet-1.24.0](https://github.com/microsoft/agent-framework/releases/tag/dotnet-1.24.0) が 2026年10月7日にリリースされました。.NET で Claude を使ったエージェントを動かしているなら、変更履歴の中で特に重要なのが [PR #9111](https://github.com/microsoft/agent-framework/pull/9111) の "Stabilize Anthropic agent package" という1行です。先週まで、`Microsoft.Agents.AI.Anthropic` はプレビュービルドしか存在しませんでした (最後のものは `1.23.0-preview.260928.1` です)。NuGet では現在、フレームワークの他のパッケージと同時に公開された通常の `1.24.0` になっています。

## 安定版が実際にカバーする範囲

このパッケージには2つの拡張クラスがありますが、扱いは同じではありません。

`AnthropicClientExtensions` は `IAnthropicClient` に `AsAIAgent` を追加するもので、正式にリリースされた公開 API になりました。この PR では、パッケージがビルド対象とするすべてのターゲットフレームワーク (`net10.0`、`net9.0`、`net8.0`、`netstandard2.0`、`net472`) に `PublicAPI.Shipped.txt` のベースラインが追加されたため、今後は破壊的変更がパッケージ検証で検出されます。依存先も `Anthropic` 12.45.0 から 12.53.0 に更新されました。これは公式の Anthropic C# SDK で、こちらもすでに GA です。

例外が `AnthropicBetaServiceExtensions` です。`IBetaService` (`client.Beta` で得られるもの) 上の `AsAIAgent` オーバーロードを持つこのクラスは、全体が `[Experimental("MAAIANTHROPIC001")]` でマークされ、ドキュメントにも "may change in non-major releases as the underlying beta services evolve" と注記されています。[issue #9110](https://github.com/microsoft/agent-framework/issues/9110) の理屈は単純です。Anthropic SDK は GA ですが、そのベータ部分は GA ではなく、Agent Framework は上流が保証しない互換性の約束をしたくない、ということです。

## コードで変わること

通常のクライアントからエージェントを作成している場合、パッケージのバージョン以外は何も変わりません。

```xml
<PackageReference Include="Microsoft.Agents.AI.Anthropic" Version="1.24.0" />
```

```csharp
using Anthropic;
using Microsoft.Agents.AI;

AnthropicClient client = new() { ApiKey = Environment.GetEnvironmentVariable("ANTHROPIC_API_KEY") };

ChatClientAgent agent = client.AsAIAgent(
    model: "claude-sonnet-5-5",
    instructions: "You review C# pull requests and answer in short bullet points.",
    name: "reviewer");

Console.WriteLine(await agent.RunAsync("Is `async void` ever fine in an ASP.NET Core handler?"));
```

ベータ側には少し注意が必要な点があります。私は SDK 10.0.302 で 1.24.0 パッケージに対してコンパイルを確認しました。まず、オーバーロードは `Anthropic.Services` 名前空間にあるため、その `using` を追加しないと `client.Beta.AsAIAgent(...)` は解決されません。次に、属性はメソッドではなくクラスに付いており、C# はクラスレベルの `[Experimental]` を、コード中に型名が現れたときだけ報告します。拡張メソッド構文では型名が現れないため、次のコードは診断なしでそのままコンパイルできます。

```csharp
using Anthropic.Services;

ChatClientAgent agent = client.Beta.AsAIAgent(
    model: "claude-sonnet-5-5",
    instructions: "You create PowerPoint presentations.",
    tools: [pptxSkill.AsAITool()]);
```

静的呼び出しや、共有のデフォルトトークン上限を調整する場合のようにクラス名を直接書くと、`[Experimental]` の診断はデフォルトでエラーになるため、エラーになります。

```csharp
AnthropicBetaServiceExtensions.DefaultMaxTokens = 8000;
```

```text
error MAAIANTHROPIC001: 'Anthropic.Services.AnthropicBetaServiceExtensions' is for evaluation purposes only and is subject to change or removal in future updates. Suppress this diagnostic to proceed.
```

フレームワーク自身の skills サンプルでは、ファイルの先頭で `#pragma warning disable MAAIANTHROPIC001` を使って抑制しています。ベータ機能が実験ではなく設計の一部である場合は、プロジェクト全体で一度だけ抑制してください。

```xml
<PropertyGroup>
  <NoWarn>$(NoWarn);MAAIANTHROPIC001</NoWarn>
</PropertyGroup>
```

## この分け方が妥当な理由

本番環境でプレビュー版パッケージを固定したくないことは、Claude エージェントを Agent Framework から外し、代わりに `IChatClient` を手作業で組み込む一般的な理由でした (トレードオフは私の [Anthropic SDK と Microsoft.Extensions.AI の比較](/2026/06/anthropic-sdk-vs-microsoft-extensions-ai-for-calling-claude-from-dotnet/)にまとめています)。安定版のパスについては、その理由はなくなりました。ただし、この診断を監査の代わりにしないでください。拡張メソッドの呼び出し形式は診断をすり抜けるため、ビルドが警告なしで通っても、ベータ部分を使っていないとは限りません。`client.Beta` と `IBetaService` を grep して、Agent Framework または Anthropic SDK のマイナーアップデートで壊れる可能性のある呼び出し箇所を洗い出してください。

1.24.0 のそれ以外の変更は堅牢化です。`LocalCodeAct` のケイパビリティ検証、宣言型エージェントでの機密性の高い識別子の拒否、MCP 承認ヘッダーを承認された呼び出しに紐づけることなどが含まれます。1.23 を飛ばしている場合は、アップグレードの前にその[関数ミドルウェアの変更](/ja/2026/10/agent-framework-1-23-function-middleware-can-now-swap-the-tool/)から確認してください。
