---
title: "Agent Framework の Copilot プロバイダーが Copilot CLI をただの AIAgent に変えます"
description: "Microsoft.Agents.AI.GitHub.Copilot 1.16.0 が 2026-07-30 に公開されました。Copilot CLI のランタイムは AIAgent 抽象の背後に収まり、権限は既定で拒否、そして Squad はエージェントのチーム全体を 1 つの AIAgent として差し込みます。"
pubDate: 2026-08-03
tags:
  - "agent-framework"
  - "github-copilot"
  - "ai-agents"
  - "dotnet"
  - "csharp"
  - "mcp"
lang: "ja"
translationOf: "2026/08/agent-framework-github-copilot-provider-copilot-cli-as-aiagent"
translatedBy: "claude"
translationDate: 2026-08-03
---

Microsoft は 2026-07-30 に `Microsoft.Agents.AI.GitHub.Copilot` 1.16.0 を NuGet へ公開しました。[同日に出た Agent Framework ブログの記事](https://devblogs.microsoft.com/agent-framework/building-agent-teams-with-agent-framework-github-copilot-cli-and-squad/)は、GitHub Copilot 統合が C# と Python の両方で完全にサポートされたと説明しています。実務上の効果はこうです。shell コマンドを実行し、ファイルを編集し、URL を取得し、MCP を話す Copilot CLI のランタイムに、通常の `AIAgent` 抽象から手が届くようになりました。

## コーディングエージェントまで 2 行

```bash
dotnet add package Microsoft.Agents.AI.GitHub.Copilot
```

```csharp
using GitHub.Copilot;
using Microsoft.Agents.AI;

await using CopilotClient copilotClient = new();
await copilotClient.StartAsync();

AIAgent agent = copilotClient.AsAIAgent();

Console.WriteLine(await agent.RunAsync("What is Microsoft Agent Framework?"));
```

`AsAIAgent` は任意で `tools:` と `instructions:` を受け取るので、別の場所ですでに登録した `AIFunction` をそのまま渡せます。戻ってくるのは標準の `AIAgent` です。つまり `RunStreamingAsync`、複数ターンのコンテキスト用の `CreateSessionAsync`、そして Agent Framework の上にすでに構築した workflow やオーケストレーションが、そのまま変更なしで動きます。これが [Copilot SDK を直接](/ja/2026/06/github-copilot-sdk-ga-embed-copilot-agent-runtime-csharp/)扱う場合との違いです。セッションのイベントループを手書きするのをやめ、Copilot をプロバイダーの 1 つとして扱えます。

## 権限は既定で拒否です

最初につまずく点は、権限ハンドラーを渡すまでエージェントが shell コマンドを実行できず、ファイルシステムにも触れず、URL も取得できないことです。

```csharp
SessionConfig sessionConfig = new()
{
    OnPermissionRequest = PromptPermission,
};

AIAgent agent = copilotClient.AsAIAgent(sessionConfig);
```

ハンドラーは `PermissionDecision.ApproveOnce()` または `PermissionDecision.Reject()` を返します。`PermissionHandler.ApproveAll` というショートカットもありますが、[MS Learn のプロバイダーページ](https://learn.microsoft.com/en-us/agent-framework/agents/providers/github-copilot)は、作業マシンではなくコンテナーや dev container の中で動かすようはっきり書いています。MCP サーバーも一緒に使えます。stdio のローカル接続と HTTP のリモート接続を `SessionConfig.McpServers` で設定します。一方でコードインタープリター、ファイル検索、ホスト型 Web 検索は使えません。ドキュメントはこの 3 つをこのプロバイダーでは未サポートと記載しています。

## Squad も同じ抽象に乗ります

発表の後半は Squad です。コーディネーターと数名のスペシャリストが `.squad/` 配下の markdown ファイルとしてリポジトリに住む、オープンソースのマルチエージェント構成です。`Squad.Agents.AI` パッケージがチーム全体を `DelegatingAIAgent` として包むので、顔ぶれ全員がアプリケーションから見ると 1 つの `AIAgent` になります。

```csharp
builder.Services.AddSquadAgent(o =>
{
    o.SquadFolderPath = @"C:\path\to\your\team-root";
});

var squad = host.Services.GetRequiredService<AIAgent>();
var session = await squad.CreateSessionAsync();
var response = await squad.RunAsync("What can this Squad team do?", session);
```

スペシャリストへのディスパッチごとに `squad.subagent {Name}` という名前の OpenTelemetry スパンが出るため、分岐の様子が追加の配線なしで Aspire や Jaeger に現れます。Squad 自体はまだアルファです（`Squad.Agents.AI` は 0.5.5、0.5.6 のプレビューあり）。フォルダーの生成には `dotnet add package Squad.Agents.AI --prerelease` と npm パッケージ `@bradygaster/squad-cli` が必要です。

今週取り入れる価値があるのはプロバイダーのほうです。Squad は、コーディングエージェントが単なる `AIAgent` になれば、そのチーム全体もまた `AIAgent` になれるという興味深い証明です。
