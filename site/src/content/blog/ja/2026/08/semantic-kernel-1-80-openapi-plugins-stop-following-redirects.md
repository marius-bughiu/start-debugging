---
title: "Semantic Kernel 1.80.0 で OpenAPI プラグインがリダイレクトを追わなくなりました"
description: "Semantic Kernel .NET 1.80.0 には破壊的変更が入りました。OpenAPI プラグインの既定の HttpClient がリダイレクトを追わなくなり、SSRF のバイパスがふさがれます。何が変わるのか、そしてなぜ自前の HttpClient が穴を開け直すのかを解説します。"
pubDate: 2026-08-19
tags:
  - "dotnet"
  - "semantic-kernel"
  - "ai-agents"
  - "security"
  - "csharp"
lang: "ja"
translationOf: "2026/08/semantic-kernel-1-80-openapi-plugins-stop-following-redirects"
translatedBy: "claude"
translationDate: 2026-08-19
---

Semantic Kernel .NET 1.80.0 が 2026-08-18 にリリースされました。変更履歴で重要なのは、いちばんそっけない一行です。[".NET: [Breaking] Update OpenAPI HTTP client defaults"](https://github.com/microsoft/semantic-kernel/pull/14293) です。これは Semantic Kernel が 5 月から自身の XML コメントで既知の制限として書き続けていた穴をふさぐものです。

## 検証は本物で、リダイレクトが非常口でした

2026 年 5 月に [PR #14029](https://github.com/microsoft/semantic-kernel/pull/14029) が入って以降、`RestApiOperationServerUrlValidationOptions` はすべての OpenAPI プラグインに既定で適用されています。`ServerUrlValidationOptions` を null のままにしても、既定値で構築されたインスタンスが適用されます。許可リストに載っていないものには https を強制し、ループバック、リンクローカル (クラウドのメタデータアドレス `169.254.169.254` を含む)、RFC1918、`fc00::/7`、キャリアグレード NAT、マルチキャスト、予約済みレンジに解決されるホストを拒否します。

問題は順序でした。検証はリクエストが送信される前に URL に対して実行されます。既定の `HttpClient` はリダイレクトを追っていたため、許可した公開ホストが `http://169.254.169.254/latest/meta-data/` を指す `302` を返すと、すでに検証を通過したハンドラーがそれを追いかけていました。Semantic Kernel は型自身の注記でその点に触れ、`AllowAutoRedirect = false` を自分で設定するよう案内していました。

## 1.80.0 で実際に変わったこと

プラグインファクトリは既定のクライアントを `HttpClientProvider.GetHttpClient()` 経由で解決しなくなりました。代わりに新しい `GetNonRedirectingHttpClient()` を呼び出します。これはリダイレクトを無効化した、破棄されない別のハンドラーのシングルトンに支えられています。

```csharp
public static HttpClient GetNonRedirectingHttpClient()
    => new(NonDisposableHttpClientHandler.NonRedirectingInstance, disposeHandler: false);
```

すべてのエントリポイントがここを通ります。`ImportPluginFromOpenApiAsync`、`CreatePluginFromOpenApiAsync`、`OpenApiKernelPluginFactory.CreateFromOpenApiAsync`、さらに API Manifest と Copilot Agent Plugin の拡張も同様です。リダイレクトは黙って追われるのではなく、`3xx` ステータスを持つ `HttpOperationException` として表面化するようになりました。

## HttpClient は依然としてあなたの責任です

`Microsoft.SemanticKernel.Plugins.OpenApi` を 1.80.0 に更新する前に確認すべきなのがここです。新しい既定値が効くのは、Semantic Kernel がクライアントを構築する場合だけです。自分で渡した場合は、そのまま使われます。

```csharp
var handler = new HttpClientHandler { AllowAutoRedirect = false };
using var http = new HttpClient(handler);

await kernel.ImportPluginFromOpenApiAsync(
    pluginName: "partner",
    uri: new Uri("https://partner.example.com/openapi.json"),
    executionParameters: new OpenApiFunctionExecutionParameters
    {
        HttpClient = http,
    });
```

見落としやすいのは依存性注入です。kernel の拡張メソッドは既定値にたどり着く前に `kernel.Services.GetService<HttpClient>()` にフォールバックするため、素朴な `AddHttpClient()` の登録が優先され、`AllowAutoRedirect = true` を一緒に連れ戻します。[BackgroundService から Semantic Kernel プラグインを実行する](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/)場合のようにホスト内でプラグインを組み立てているなら、プライマリハンドラーを明示的に設定してください。

破壊的な部分は本物です。末尾のスラッシュの不一致に対して `301` を返す社内 API はこれまで動いていましたが、今後は例外を投げます。リダイレクトするクライアントをプラグインに渡すのではなく、ドキュメントの `servers[].url` を直してください。
