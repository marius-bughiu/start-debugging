---
title: "ASP.NET Core 11 で Swagger UI の代わりに Scalar で OpenAPI ドキュメントを提供する方法"
description: "ASP.NET Core 11 で UseSwaggerUI を MapScalarApiReference に置き換えます。ルーティング、複数ドキュメント、認証情報の事前入力、本番環境での制御、CDN 不要のアセット、そして Scalar 固有の OpenAPI 拡張を解説します。"
pubDate: 2026-08-09
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "openapi"
  - "scalar"
lang: "ja"
translationOf: "2026/08/how-to-serve-openapi-docs-with-scalar-instead-of-swagger-ui-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-08-09
---

ASP.NET Core 11 の API で Swagger UI を Scalar に置き換えるには、`Scalar.AspNetCore` をインストールし、`app.UseSwaggerUI(...)` の呼び出しを削除して、既存の `app.MapOpenApi()` の隣に `app.MapScalarApiReference()` を追加します。これで UI は `/scalar` に配置され、ドキュメントは `/openapi/v1.json` から読み込まれます。これはまさに `MapOpenApi` がすでに提供しているものです。ここまでが 90 パーセントのケースです。残りの 10 パーセントが以下の内容です。既定ではないルートに置かれたドキュメント、複数のドキュメント、実際にトークンを付与する Authorize ボタン、そしてこれら一式を本番のホスト名から遠ざける方法です。

本記事の内容はすべて .NET 11 (Preview 6、SDK `11.0.100-preview.6.26359.118` で検証) と `Microsoft.NET.Sdk.Web`、C# 14 を対象とし、2026-08-07 に公開された `Scalar.AspNetCore` 2.16.18 を使用します。以下の API 表面は .NET 8、9、10 でも同一です。パッケージが `net8.0` 以上を対象としているためです。

## 最初から最後までの 6 ステップ

1. `dotnet add package Scalar.AspNetCore` で `Scalar.AspNetCore` をインストールし、`Program.cs` に `using Scalar.AspNetCore;` を追加します。
2. ミドルウェアの呼び出し `app.UseSwaggerUI(...)` を削除し、他で使っていなければ `Swashbuckle.AspNetCore.SwaggerUI` のパッケージ参照も削除します。
3. すでに `app.MapOpenApi()` を包んでいるのと同じ環境ガードの中で `app.MapScalarApiReference()` を呼び出します。
4. OpenAPI の JSON が `/openapi/{documentName}.json` にない場合は、`WithOpenApiRoutePattern` または `AddDocument` で Scalar を正しいドキュメントに向けます。
5. 開発時に Authorize ボタンが本物のトークンを送るよう、`AddPreferredSecuritySchemes` と `AddHttpAuthentication` で資格情報を事前入力します。
6. 本番環境の方針を決めます。エンドポイントを本番から完全に外すか、マップしたうえで戻り値のエンドポイントビルダーに `RequireAuthorization()` をチェーンするかのどちらかです。

## Swagger UI がなくなると実際に何が変わるのか

最も影響の大きい違いは見た目ではありません。`UseSwaggerUI` はミドルウェアを登録します。`MapScalarApiReference` はエンドポイントを登録します。このひとつの変更が UI をパイプラインからルーティングテーブルへ移動させ、以降のすべてはそこから導かれます。

ミドルウェアは登録順に実行され、エンドポイントルーティングが関与する前にリクエストを終了させます。Swagger UI が歴史的に認可ポリシーを無視してきたのはそのためで、回避するには独自のミドルウェアでラップする必要がありました。エンドポイントは他と同じようにルーティングに参加するため、メタデータを持ち、`EndpointDataSource` に現れ、すでにご存じの規約がそのまま適用されます。

```csharp
// Program.cs -- .NET 11, C# 14
// Before: Swashbuckle's UI middleware over the built-in OpenAPI document
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.UseSwaggerUI(options => options.SwaggerEndpoint("/openapi/v1.json", "v1"));
}
```

```csharp
// Program.cs -- .NET 11, C# 14, Scalar.AspNetCore 2.16.18
// After: an endpoint, not middleware
using Scalar.AspNetCore;

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.MapScalarApiReference();
}
```

2 番目のブロックに何がないかに注目してください。`SwaggerEndpoint` に相当するものがありません。Scalar はドキュメントのルートを既定で `/openapi/{documentName}.json` としており、これはまさに `MapOpenApi` が登録するルートなので、設定なしで両者が一致します。すでに Swashbuckle のジェネレーターを組み込みのものに置き換えているなら、これが最後に残っていた Swashbuckle のパッケージです。その置き換えのジェネレーター側については [ASP.NET Core 11 で Swashbuckle なしに OpenAPI を公開する](/ja/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/) で扱っています。

バグ報告をする前に知っておきたい挙動が 1 つあります。`/scalar` にアクセスすると `/scalar/` へのリダイレクトが発生します。クライアント側のアセットパスを正しく解決するためです。厳格なリダイレクトポリシー、末尾スラッシュを書き換えるプロキシ、あるいは `/scalar` で 200 を期待する統合テストがある場合、見えているのはこの 301 です。

## 既定のルートにないドキュメントに Scalar を向ける

`MapOpenApi` はルートパターンを受け取ります。古いクライアントジェネレーターに合わせるため、何年も前にこれを変更したコードベースは少なくありません。ドキュメントが `/swagger/v1/swagger.json` にある場合や、.NET 10 で追加された YAML 版を提供したい場合は、Scalar にどこを見るか伝えます。

```csharp
// Program.cs -- .NET 11, C# 14
app.MapOpenApi("/swagger/{documentName}/swagger.json");

app.MapScalarApiReference(options =>
{
    options
        .WithTitle("Orders API")
        .WithOpenApiRoutePattern("/swagger/{documentName}/swagger.json");
});
```

`WithOpenApiRoutePattern` は絶対 URL も受け付けます。別のサービスが生成した仕様にドキュメントホストを向けるにはこの方法を使います。ランタイムのジェネレーターをまったく動かしたくない場合は、`Microsoft.Extensions.ApiDescription.Server` がビルド時に生成し静的ファイルとして提供されるファイルのパスを指定することもできます。

UI 自体のルートは `MapScalarApiReference` の第 1 引数です。オーバーロードは 6 つあり、ルートプレフィックスの有無、オプションのデリゲートの有無、そしてそのデリゲートに `HttpContext` を伴うかどうかの組み合わせです。

```csharp
// Program.cs -- .NET 11, C# 14
// Mount the reference at /api-docs and vary options per request
app.MapScalarApiReference("/api-docs", (options, httpContext) =>
{
    options.WithTitle($"Orders API ({httpContext.Request.Host})");
});
```

`HttpContext` のオーバーロードは見た目以上に重要です。受信リクエストからオプションを算出するためのサポートされた手段であり、cookie からテーマを選ぶ、host ヘッダーに応じてサーバー一覧を切り替える、呼び出し元に見せてはいけないドキュメントを隠す、といった用途に使えます。

Scalar 1.x のコードベースから移行する場合、`ScalarOptions.EndpointPathPrefix` は廃止済みである点に注意してください。ルートプレフィックスは前述の第 1 引数に移動し、既定値は `/scalar/{documentName}` から単なる `/scalar` に変わりました。パスベース配下でホストされるアプリのために `OpenApiRoutePattern` を手動で書き換えていた古いサブパス回避策はもう不要で、削除すべきです。相対パスの解決はライブラリ側で処理されるようになりました。

## 1 つのサイドバーに複数のドキュメントと API バージョンを載せる

Swagger UI ではこれを `SwaggerEndpoint` の繰り返し呼び出しとドロップダウンで表現していました。Scalar では登録済みドキュメントとして表現します。

```csharp
// Program.cs -- .NET 11, C# 14
builder.Services.AddOpenApi("v1");
builder.Services.AddOpenApi("v2");

// ...

app.MapOpenApi();
app.MapScalarApiReference(options =>
{
    options
        .AddDocument("v1", "Orders API v1")
        .AddDocument("v2", "Orders API v2 (beta)", isDefault: true);
});
```

`AddDocument` の各オーバーロードは名前、省略可能な表示タイトル、省略可能なルートパターンを受け取るため、異なるパスにあるドキュメントを 1 つのリファレンスに同居させられます。名前だけで十分な場合は `AddDocuments(["v1", "v2", "v3"])` が簡潔な書き方です。`Asp.Versioning` で API バージョンごとにドキュメントを生成しているなら、その名前がここに入ります。バージョニング固有の配線については [.NET での OpenAPI による API バージョニング](/ja/2026/04/api-versioning-openapi-dotnet-10/) を参照してください。

ドキュメント名は大文字小文字を含め、書いたとおりにジェネレーターへ渡されます。`V1` として登録したドキュメントを `v1` として要求すると、エラーではなく空のリファレンスになります。ドキュメントの取得が単に 404 になり、UI に描画するものがないためです。ドキュメント名をすべて小文字で統一しておけば、この問題は起きません。

## Authorize ボタンに本物のトークンを送らせる

ここが最も混乱を招く部分ですが、ルールは単純です。Scalar が事前入力するのは、OpenAPI ドキュメントがすでに宣言しているセキュリティスキームだけです。認証のミドルウェアを読み取ることはなく、ドキュメントが記述していないスキームを勝手に作り出すこともできません。ドキュメントに `securitySchemes` のエントリがなければ、クライアント側をどう設定しても `Authorization` ヘッダーは付きません。この失敗そのものについては [Scalar で Bearer トークンが無視される理由](/ja/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/) で詳しく書きましたが、診断内容は今も変わりません。

ドキュメントが `BearerAuth` という名前の HTTP bearer スキームを宣言している前提であれば、次のコードでそれを事前選択し、開発用トークンを事前入力できます。

```csharp
// Program.cs -- .NET 11, C# 14, Scalar.AspNetCore 2.16.18
app.MapScalarApiReference(options =>
{
    options
        .AddPreferredSecuritySchemes("BearerAuth")
        .AddHttpAuthentication("BearerAuth", auth =>
        {
            auth.Token = builder.Configuration["Scalar:DevToken"]!;
        });
});
```

OAuth2 のフローには、Swagger UI が使っていた平坦なキーと値の設定ではなく、専用のヘルパーが用意されています。`AddAuthorizationCodeFlow`、`AddClientCredentialsFlow`、`AddPasswordFlow`、`AddImplicitFlow` はいずれも設定デリゲートを受け取り、PKCE は UI が尊重してくれることを祈るチェックボックスではなくプロパティです。

```csharp
// Program.cs -- .NET 11, C# 14
app.MapScalarApiReference(options =>
{
    options
        .AddPreferredSecuritySchemes("OAuth2")
        .AddAuthorizationCodeFlow("OAuth2", flow =>
        {
            flow.ClientId = builder.Configuration["Scalar:ClientId"]!;
            flow.Pkce = Pkce.Sha256;
            flow.SelectedScopes = ["orders.read", "orders.write"];
        });
});
```

押さえておくべき点が 2 つあります。1 つ目は、ここで渡した値はブラウザーがダウンロードするページにシリアライズされるため、この方法で設定した client secret は公開されるという点です。Scalar 自身のドキュメントも、事前入力した認証情報を本番環境で決して使わないよう明記しています。これは形式的な注意書きではありません。これらの値は公開 HTML ファイルに貼り付けたものと同じだと考えてください。実際そうなっているからです。2 つ目は、`EnablePersistentAuthentication()` がユーザーの入力をブラウザーのストレージに保存し、再読み込みをまたいで保持する点です。手元のノート PC では確かに便利ですが、共有マシンでは確実に誤りです。

サーバー側を同時に構築しているなら、トークン検証の側面は [minimal API での JWT bearer 認証のセットアップ](/ja/2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11/) が、スキーム宣言そのものはドキュメントトランスフォーマーであり [操作トランスフォーマーとスキーマトランスフォーマーによる OpenAPI のカスタマイズ](/ja/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/) が扱っています。

## リファレンスを失わずに本番から締め出す

Microsoft のガイダンスは明確で、Scalar を含む OpenAPI のユーザーインターフェイスは開発環境だけのものだとしています。テンプレート既定のガードがそれを担います。

```csharp
// Program.cs -- .NET 11, C# 14
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.MapScalarApiReference();
}
```

社内のステージングホストにリファレンスを置きたいチームには、環境チェックより良い選択肢があります。これが可能なのは、まさに Scalar がエンドポイントだからです。`MapScalarApiReference` は `IEndpointConventionBuilder` を返すため、あらゆるルーティング規約が適用できます。

```csharp
// Program.cs -- .NET 11, C# 14
app.MapScalarApiReference()
   .RequireAuthorization("InternalOnly")
   .ExcludeFromDescription();

app.MapOpenApi()
   .RequireAuthorization("InternalOnly");
```

両方を保護してください。UI を保護しても `/openapi/v1.json` を匿名のままにしていては何も守れません。情報を漏らしているのはドキュメントであり、UI はその描画装置にすぎないからです。`ExcludeFromDescription()` はドキュメント用エンドポイントがドキュメント内に現れるのを防ぎます。重要というより見栄えの問題です。

## アセット、オフラインでのホスティング、そして外部に通信するフォント

Scalar は JavaScript と CSS を NuGet パッケージ内に同梱し、自分のオリジンから提供します。そのため、隔離環境やオフライン環境でも設定なしで動作します。ごく初期の 1.x では違ったため、Scalar には CDN が必要だという思い込みが今も残っています。

残る外部リクエストは既定の Web フォントだけです。1 行の呼び出しで止められます。

```csharp
// Program.cs -- .NET 11, C# 14
app.MapScalarApiReference(options =>
{
    options.DisableDefaultFonts();
});
```

`WithBundleUrl("https://cdn.jsdelivr.net/npm/@scalar/api-reference")` は逆方向で、パッケージを上げずに最新の UI を追いたい場合に CDN からバンドルを取得します。厳格な Content Security Policy を運用している場合、`DisableDefaultFonts` と同梱アセットの組み合わせにより、リファレンスに必要なのは `'self'` とインラインの設定スクリプトだけになります。

オプションはコードではなく構成からバインドすることもできます。環境ごとの設定を `Program.cs` の外に保つには、これが最もきれいな方法です。

```csharp
// Program.cs -- .NET 11, C# 14
builder.Services.AddOptions<ScalarOptions>().BindConfiguration("Scalar");
```

`MapScalarApiReference` のデリゲートで設定した値は、バインドされた値を上書きします。

## Scalar 固有のメタデータ: 安定性、非表示エンドポイント、コードサンプル

Swagger UI に相当機能がない機能は、コンパニオンパッケージ `Scalar.AspNetCore.Microsoft` (2.16.18、`net9.0` と `net10.0` を対象、`Microsoft.AspNetCore.OpenApi` と `Microsoft.OpenApi` 2.7.5 以上に依存) にあります。このパッケージは、生成されたドキュメントに Scalar のベンダー拡張を書き込むドキュメントトランスフォーマーを登録します。まだ Swashbuckle のジェネレーターを使っている場合は、`Scalar.AspNetCore.Swashbuckle` がフィルターを通じて同じ役割を果たします。

```csharp
// Program.cs -- .NET 11, C# 14, Scalar.AspNetCore.Microsoft 2.16.18
builder.Services.AddOpenApi(options => options.AddScalarTransformers());

// ...

app.MapGet("/orders", GetOrders).Stable();
app.MapGet("/orders/forecast", GetForecast).Experimental();
app.MapGet("/internal/metrics", GetMetrics).ExcludeFromApiReference();
```

`ExcludeFromApiReference()` は特筆に値します。描画されるリファレンスから操作を隠しつつ、OpenAPI ドキュメントには残し、ルーティングも完全に有効なままにします。ドキュメントからまるごと取り除く `ExcludeFromDescription()` とは異なります。クライアントジェネレーターがそのエンドポイントを引き続き見る必要があるかどうかで選んでください。`CodeSample()` は指定した `ScalarTarget` 向けに手書きのスニペットを添付し、`WithBadge()` は操作の横に色付きのラベルを置きます。minimal API を使っていない場合、どちらもコントローラーのアクションに付ける属性として利用できます。

## 半日を溶かす落とし穴

**このパッケージには `net11.0` のターゲットフレームワークがありません。** 2.16.18 時点で TFM の一覧は `net10.0` で止まっており、`net11.0` のプロジェクトは通常の互換性ルールを通じて `net10.0` のアセットを利用します。プレビュー期間中はこれで問題なく、想定どおりです。ただし TFM の完全一致を要求する社内ポリシーでビルドが失敗する場合、原因はこれです。

**リファレンスが空白なのは、ほぼ常に UI の故障ではなくドキュメントの欠落です。** `/openapi/v1.json` を直接開いてください。404 になるなら、`MapOpenApi` がマップされていないか、UI とは別の環境ガードの内側にあるか、Scalar に伝えていないルートに置かれています。いずれの場合もリファレンスはエラーではなく空の外枠を描画します。

**ビルド時のドキュメント生成は UI に供給されません。** `.csproj` で `OpenApiGenerateDocuments` を設定するとビルド時に JSON ファイルが書き出されますが、実行時に提供されるわけではありません。ビルド時生成に切り替えたので `MapOpenApi` を外した場合は、生成されたファイルを静的ファイルとして提供し、`WithOpenApiRoutePattern` をそこに向けてください。

**`launchUrl` は今も `swagger` のままです。** Swagger UI のミドルウェアを削除した後、`Properties/launchSettings.json` は `dotnet run` のたびに 404 を開き続けます。`"launchUrl": "swagger"` を `"launchUrl": "scalar"` に変更するまで直りません。

**Native AOT はここでは何も変えません。** 組み込みのジェネレーターは AOT 互換で、Scalar は静的アセットを提供するため、この組み合わせは `PublishAot` を無傷で通過します。AOT で壊れるのはたいてい自分で書いたリフレクションベースのトランスフォーマーであって、リファレンス UI ではありません。

Swagger UI は非推奨ではなく、`Swashbuckle.AspNetCore.SwaggerUI` は `Microsoft.AspNetCore.OpenApi` が生成したドキュメントの上で今も問題なく動作します。移行する理由は、Scalar がミドルウェアではなくエンドポイントであること、アセットをパッケージ内に同梱していること、そして認証の事前入力を文字列の寄せ集めではなく型付き API で行えることです。どれも重要でないなら、そのまま留まるのも十分に筋の通った答えです。

## 関連記事

- [ASP.NET Core 11 で Swashbuckle なしに OpenAPI を公開する方法](/ja/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/)
- [Scalar in ASP.NET Core: Bearer トークンが無視される理由](/ja/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/)
- [.NET 11 で Swashbuckle から組み込みの OpenAPI ジェネレーターへ移行する](/ja/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/)
- [操作トランスフォーマーとスキーマトランスフォーマーで OpenAPI ドキュメントをカスタマイズする方法](/ja/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/)
- [.NET 11 で Swagger UI に OpenAPI 認証フローを追加する方法](/ja/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/)

## 参考資料

- Microsoft Learn の [生成された OpenAPI ドキュメントを使用する](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/using-openapi-documents?view=aspnetcore-10.0)
- [Scalar の ASP.NET Core 統合ドキュメント](https://scalar.com/products/api-references/integrations/aspnetcore/integration)
- [.NET 向け Scalar OpenAPI 拡張](https://scalar.com/products/api-references/integrations/aspnetcore/openapi-extensions)
- [Scalar.AspNetCore 2.0.0 への移行ガイド](https://github.com/scalar/scalar/issues/4362)
- [NuGet の Scalar.AspNetCore](https://www.nuget.org/packages/Scalar.AspNetCore)
