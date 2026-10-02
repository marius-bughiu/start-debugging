---
title: "Agent Framework 1.23: 関数ミドルウェアが呼び出し対象のツールをついに差し替えられるように"
description: "Microsoft Agent Framework .NET 1.23.0 は FunctionInvocationContext.Function への代入を反映するようになり、ミドルウェアがツール呼び出しを別の AIFunction にリダイレクトできます。新しいヘルパー WrapWithPendingMiddleware により、残りのチェーンも呼び出しに関与し続けます。"
pubDate: 2026-10-02
tags:
  - "agent-framework"
  - "dotnet"
  - "ai-agents"
  - "microsoft-extensions-ai"
lang: "ja"
translationOf: "2026/10/agent-framework-1-23-function-middleware-can-now-swap-the-tool"
translatedBy: "claude"
translationDate: 2026-10-02
---

Microsoft Agent Framework [dotnet-1.23.0](https://github.com/microsoft/agent-framework/releases/tag/dotnet-1.23.0) は 2026-10-01 にリリースされ、多数の修正と BREAKING とマークされた 5 つの変更を含んでいます。ここで取り上げたい変更には何のマークも付いていません。メンテナーがバグ修正として扱っているためです。[PR #8615](https://github.com/microsoft/agent-framework/pull/8615) により、関数ミドルウェアがこれから呼び出す関数を実際に置き換えられるようになりました。

## 何もしなかったセッター

`AIAgentBuilder.Use(...)` で登録した関数呼び出しミドルウェアは `FunctionInvocationContext` を受け取ります。その `Function` プロパティには public なセッターがあり、`next` を呼ぶ前に別の `AIFunction` を代入することを妨げるものはありませんでした。しかし 1.22 までは、その代入は黙って無視されていました。`context.Arguments` の変更は反映されるのに、継続処理は常に、ツール一覧の構築時にラッパーが捕捉した関数を呼び出していたのです。

このため、リスクのある呼び出しを保護された実装に回す、テナントごとの実装を実行時に差し替える、エージェントを再構築せずに統合テストでスタブに置き換える、といった一連のパターンが使えませんでした。よくある回避策は `next` を呼ばずに別の関数を自分で呼び出すことでしたが、それでは自分より後に登録されたミドルウェアがすべて飛ばされます。

## 1.23 での呼び出しのリダイレクト

`FunctionInvocationDelegatingAgent` は、コールバックの実行前に呼び出し対象を捕捉し、実行後は `context.Function` に入っているものに対してディスパッチするようになりました。変更しなければ 1.22 と同じ動作です。置き換えた場合は、置き換え先が実行されます。

```csharp
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;

AIFunction sandboxedDelete = AIFunctionFactory.Create(
    (string customerId) => $"Queued deletion of {customerId} for human review.",
    "delete_customer",
    "Deletes a customer record.");

async ValueTask<object?> RouteDestructiveCalls(
    AIAgent agent,
    FunctionInvocationContext context,
    Func<FunctionInvocationContext, CancellationToken, ValueTask<object?>> next,
    CancellationToken cancellationToken)
{
    if (context.Function.Name == "delete_customer")
    {
#pragma warning disable MAAI001
        context.Function = context.WrapWithPendingMiddleware(sandboxedDelete);
#pragma warning restore MAAI001
    }

    return await next(context, cancellationToken);
}

AIAgent agent = baseAgent
    .AsBuilder()
        .Use(RouteDestructiveCalls)
        .Use(AuditMiddleware)
    .Build();
```

モデルは `delete_customer` を要求し、引数はそのまま渡され、ツールの結果はサンドボックス版が返します。

## WrapWithPendingMiddleware が存在する理由

置き換え先は直接呼び出されます。ヘルパーがなければ、上の例の `AuditMiddleware` はリダイレクトされた呼び出しを一切見ることができません。新しい `FunctionInvocationContextExtensions.WrapWithPendingMiddleware(context, function)` は、この呼び出しでまだ実行されていないコールバックで置き換え先をラップするため、残りのチェーンも引き続きその呼び出しを観測できます。

ソースから読み取れるルールは 3 つです。

- 実行中のコールバック内から、`next` を呼ぶ前に呼び出します。継続処理が実行された後は保留中のものが残らず、ヘルパーは `InvalidOperationException` をスローします。
- 保留中のコールバックがなければ、渡した関数をそのまま返します。
- `[Experimental]` と診断 `MAAI001` が付いているため、pragma が必要です。

置き換えても変わらない点が 1 つあります。ツールの承認とテレメトリは、モデルが最初に要求した関数を反映し続けます。どのコールバックが実行されるよりも前に呼び出しが解決されるためです。`delete_customer` に承認が必要なら、ミドルウェアが後で別の処理を実行するとしても、ユーザーが承認するのは `delete_customer` です。監査の観点では正しい既定動作ですが、承認を回避する手段として差し替えに頼らないでください。

## 1.23 のその他の変更の概要

アップグレードする場合は、次の BREAKING 項目もコードを検索して確認してください。実行間でツール一覧が変わったときのツール名の検証と保留中の呼び出しの扱い ([#8754](https://github.com/microsoft/agent-framework/pull/8754))、承認レスポンスのより厳格なバインド ([#8641](https://github.com/microsoft/agent-framework/pull/8641))、宣言型ワークフローにおける構成キーと環境キーの許可リストです。後者では、`AllowProcessEnvironmentVariableFallback = true` を設定しない限り、プロセス環境変数へのフォールバックは無効になります ([#8200](https://github.com/microsoft/agent-framework/pull/8200))。このリリースでは `Microsoft.Extensions.AI` も 10.10.1 に、OpenAI も 2.14.0 に更新されています。

1.21 以前から移行する場合は、まず [1.22 で AsIChatClient と実行ごとのツールについて何が変わったか](/ja/2026/09/agent-framework-1-22-asichatclient-exposes-an-agent-as-an-ichatclient/) を確認してから、`Microsoft.Agents.AI` 1.23.0 に上げてください。
