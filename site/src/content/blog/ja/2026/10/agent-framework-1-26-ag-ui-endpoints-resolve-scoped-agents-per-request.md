---
title: "Agent Framework 1.26: AG-UI エンドポイントがスコープ付きエージェントをシングルトン化しなくなります"
description: "Microsoft Agent Framework 1.26.0 では、MapAGUIServer がキー付き AIAgent、その AgentSessionStore、分離キープロバイダーをリクエストごとに解決するようになり、HttpContext からエージェントを選択するセレクターオーバーロードも追加されました。"
pubDate: 2026-10-24
tags:
  - "agent-framework"
  - "ag-ui"
  - "dotnet"
  - "aspnetcore"
  - "ai-agents"
lang: "ja"
translationOf: "2026/10/agent-framework-1-26-ag-ui-endpoints-resolve-scoped-agents-per-request"
translatedBy: "claude"
translationDate: 2026-10-24
---

[Microsoft Agent Framework dotnet-1.26.0](https://github.com/microsoft/agent-framework/releases/tag/dotnet-1.26.0) が 2026年10月23日にリリースされ、`Microsoft.Agents.AI.Hosting.AGUI.AspNetCore` は `1.26.0-preview.261023.1` になりました。AG-UI の背後でエージェントをホストしている方にとって最大のポイントは [PR #9382](https://github.com/microsoft/agent-framework/pull/9382) です。AG-UI エンドポイントが、エージェントを登録したときの DI ライフタイムを尊重するようになり、リクエストごとにエージェントを選択できるようになりました。

## 1.25 以前のキャプティブ依存関係

このリリースより前は、`MapAGUIServer(agentName)` と `MapAGUIServer(IHostedAgentBuilder)` は、キー付き `AIAgent`、キー付き `AgentSessionStore`、`AgentIsolationKeyProvider` を、エンドポイントをマップする時点でルートのサービスプロバイダーから一度だけ解決していました。登録したライフタイムは無視されていました。Scoped のエージェントは事実上シングルトンになり、そのエージェントがキャプチャしたものもすべて同様でした。

エージェントがリクエストごとの状態に依存している場合、これが問題になります。

```csharp
builder.Services.AddScoped<TenantContext>();

builder.Services.AddKeyedScoped<AIAgent>("support", (sp, _) =>
{
    var tenant = sp.GetRequiredService<TenantContext>();
    return chatClient.AsAIAgent(
        name: "support",
        instructions: $"You answer support questions for {tenant.Name}.");
});
```

1.25 では、最初に解決された `TenantContext` が使われ続けました。以降のすべてのリクエストは、どのテナントからのものであっても、同じ指示を持つ同じエージェントを受け取りました。典型的なキャプティブ依存関係ですが、コンストラクターではなくエンドポイントのマッピングの裏に隠れていました。

1.26 からは、この 3 つのサービスは各リクエストで `HttpContext.RequestServices` から取得されます。Scoped と Transient のエージェントはリクエストごとに新しいインスタンスになります。`IHostedAgentBuilder` 経由で登録されたシングルトンは、これまでどおりマッピング時に一度だけ解決されるため、一般的なケースで余分なコストはかかりません。登録漏れも引き続き起動時に報告されます。このチェックは `IServiceProviderIsKeyedService` を使うため、ルートプロバイダーから Scoped のインスタンスを解決することはありません。

## リクエストからエージェントを選択する

同じ PR で新しいオーバーロードが追加されました。

```csharp
public static IEndpointConventionBuilder MapAGUIServer(
    this IEndpointRouteBuilder endpoints,
    [StringSyntax("route")] string pattern,
    Func<HttpContext, AIAgent?> agentSelector)
```

セレクターはリクエストごとに一度実行されるため、エージェントはルート値、ヘッダー、クレームから決められます。

```csharp
app.MapAGUIServer("/agents/{agent}", ctx =>
{
    var name = ctx.GetRouteValue("agent") as string;
    return name is null
        ? null
        : ctx.RequestServices.GetKeyedService<AIAgent>(name);
});
```

`null` を返すと、セッション状態が読み込まれる前に `404 Not Found` が返されます。選択されたエージェントの `Name` がセッションストレージの識別子として使われるため、リクエストごとに新しいエージェントインスタンスが作られても会話は引き継がれます。XML ドキュメントには、セレクターによる選択は認可の境界ではないと明記されています。エージェントにアクセスさせたくないユーザーに `null` を返すのではなく、エンドポイントに認可ポリシー (`.RequireAuthorization(...)`) を設定してください。

## 確認すべき動作変更が 1 つあります

PR の後続コミットで、インスタンスでマップされた名前付きエージェントの識別方法が変わります。`MapAGUIServer(pattern, AIAgent)` は、名前付き、ホスト型、セレクターのマッピングと同様に、エージェントの名前を識別子として使うようになりました。以前は、同じエージェントを名前付きマッピングとインスタンスマッピングの両方で公開しても、会話は共有されませんでした。今後は共有されます。名前のないエージェントは引き続きインスタンスで識別されます。インスタンスのオーバーロードも、セッションストアをリクエストごとに解決するようになりました。

同じリリースで `AgentSessionStore.DeleteSessionAsync` が抽象メソッドとして追加されたため、`AgentSessionStore` を継承するカスタムストアは、これを実装するまでコンパイルできません。[AG-UI .NET SDK 1.0 の名前変更](/ja/2026/09/ag-ui-dotnet-sdk-1-0-moves-agui-out-of-agent-framework/)の後で `MapAGUIServer` に移行し、シングルトン以外のエージェントを登録している場合、このアップグレードによって、それらの登録が宣言どおりの意味を持つようになります。
