---
title: "ASP.NET Core 11 における Minimal APIs vs コントローラー：2026 年はどちらを選ぶべきか？"
description: "ASP.NET Core 11 ではデフォルトで Minimal APIs を選びます。コントローラーは、Minimal APIs がまだカバーしていない MVC の機能、つまり多数のアクションに対する規約ベースのルーティング、MVC スタイルのフィルター、Razor ビューが必要な場合にのみ使います。"
pubDate: 2026-05-21
template: vs
tags:
  - "comparison"
  - "aspnetcore"
  - "minimal-apis"
  - "controllers"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/05/minimal-apis-vs-controllers-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-05-21
---

ASP.NET Core 11 で新しい HTTP サービスを始めるにあたって Minimal APIs とコントローラーのどちらにするか悩んでいるなら、Minimal APIs を選んでください。2022 年当時にコントローラーを使い続ける理由になっていたもの（フィルターがない、バリデーションがない、OpenAPI が弱い、ルートグループがない、Native AOT がない）はもうありません。.NET 11 から、Minimal APIs にはエンドポイントフィルター、ルートグループ、`Microsoft.AspNetCore.OpenApi` による組み込みの OpenAPI ドキュメント、`Microsoft.AspNetCore.Http.Validation` の `[Validate]` によるパラメーターバリデーション、`TypedResults`、そして完全な Native AOT サポートがあります。コントローラーは次の 2 つの特定のケースで依然として正しい選択です。1 つは同じプロジェクトで Razor ビュー（MVC または Razor Pages）が必要な場合、もう 1 つは現在動作している `[Route]` 付きアクションを数百個抱える大規模な既存コードベースを保守している場合です。

この記事のすべてのコードサンプルは `<TargetFramework>net11.0</TargetFramework>` と `<LangVersion>14.0</LangVersion>` を対象とし、.NET 11 GA SDK で同梱される ASP.NET Core 11 のパッケージを使います。

## 機能マトリックス

| 機能                                        | Minimal APIs (ASP.NET Core 11)                       | Controllers (ASP.NET Core 11)                       |
| ------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------- |
| ルーティング                                | エンドポイントルーティング、`MapGet`/`MapPost`、ルートグループ | エンドポイントルーティング、属性または規約ベース |
| エンドポイントごとのフィルター              | `IEndpointFilter`、`AddEndpointFilter<T>`            | `IActionFilter`、`IAsyncActionFilter`               |
| モデルバインディング元の推論                | パラメーターバインディング規則、`[FromBody]` は任意  | `[FromBody]`、`[FromQuery]`、`[FromForm]` など      |
| バリデーション                              | ASP.NET Core 11 の `Microsoft.AspNetCore.Http.Validation` における `[Validate]` | `ModelState` と DataAnnotations、`ApiController` |
| 結果ヘルパー                                | `TypedResults`、`Results`                            | `IActionResult`、`ActionResult<T>`、`Problem()`     |
| OpenAPI / Swagger                           | `Microsoft.AspNetCore.OpenApi` 11、追加配線なし      | `Microsoft.AspNetCore.OpenApi` 11 + 規約            |
| Native AOT                                  | 完全サポート（`PublishAot=true` がそのまま動く）     | 限定的。`AddControllers` は依然 trim 警告を出す     |
| Razor ビュー / Razor Pages                  | 非対応（ビューレンダリングパイプラインがない）       | 対応（`AddControllersWithViews`、Razor Pages）      |
| Antiforgery（cookie を伴うフォーム `POST`） | `app.UseAntiforgery()` + `[FromForm]`                | `[ValidateAntiForgeryToken]` で MVC にデフォルト組み込み |
| エンドポイントあたりの既定ボイラープレート  | ラムダ 1 つ + `MapX` 1 行                            | クラス 1 つ + メソッド 1 つ + 属性                  |
| 200 エンドポイント規模での発見しやすさ      | グループ単位のファイル / 拡張メソッド                | リソースごとに 1 クラスのコントローラー             |
| AOT 公開時のバイナリサイズ                  | フレームワーク最小                                   | より大きい。フル MVC パイプライン                   |
| スループット（小さな JSON エンドポイント、TechEmpower スタイル） | コントローラーより約 3-5% 高い         | ベースライン                                        |

最終行の数値は .NET チーム自身の ASP.NET Core 11 ベンチマークから来ています。ほとんどのアプリでは、その差は「ノイズに近い」と考えてください。Minimal APIs を優先する理由はスループットの差ではありません。表面積が小さいこと、そして AOT のストーリーです。

## Minimal APIs が正しい選択になるとき

ASP.NET Core 11 の新しい HTTP サービスでは、デフォルトで Minimal APIs を使います。輝く具体的なケース：

- **JSON over HTTP のサービスと BFF。**典型的なサービスファイルは `Program.cs` といくつかの `MapXxxEndpoints(this RouteGroupBuilder group)` 拡張メソッドだけです。`[ApiController]` もなく、`[HttpGet("...")]` もなく、コンストラクター注入もありません。ハンドラーごとの依存関係はパラメーターとして入り、ASP.NET Core 11 のランタイムが既定で DI から解決します。
- **.NET 11 のマイクロサービスとサーバーレス関数。**Native AOT で発行すると 8-15 MB の範囲の自己完結バイナリができ、コールドスタートは 100 ms を切ります。コントローラーは AOT 下でも依然として部分的にサポートされていますが、`AddControllers` は trim 警告を出し、チームはそれを完全には抑制できていません。
- **MCP サーバーと AI エージェント向けエンドポイント。**LLM に対して HTTP 経由でひと握りの操作を公開するとき、Minimal APIs の「1 エンドポイント 1 行」という形は、ツール一覧という概念上の形と一致します。[.NET 11 Preview 4](/ja/2026/05/dotnet-11-preview-4-mcpserver-template-bundled/) で投入された同梱の `dotnet new mcpserver` テンプレートが Minimal APIs 形式の登録を使っているのも同じ理由です。
- **gRPC に隣接する JSON エンドポイント。**すでに `Grpc.AspNetCore` 上に gRPC サービスがあり、ブラウザや webhook 向けに小さな JSON 面を持ちたいとき、Minimal APIs は HTTP 層を薄く保ちます。

小さいけれど現実的なエンドポイント：

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateSlimBuilder(args);
builder.Services.AddOpenApi();
builder.Services.AddScoped<IInvoiceStore, SqlInvoiceStore>();

var app = builder.Build();
app.MapOpenApi();

var invoices = app.MapGroup("/invoices")
    .WithTags("Invoices")
    .RequireAuthorization();

invoices.MapGet("/{id:int}", async (
    int id,
    IInvoiceStore store,
    CancellationToken ct) =>
{
    var invoice = await store.FindAsync(id, ct);
    return invoice is null
        ? Results.NotFound()
        : TypedResults.Ok(invoice);
});

invoices.MapPost("/", async Task<Results<Created<Invoice>, ValidationProblem>> (
    [Validate] CreateInvoice request,
    IInvoiceStore store,
    CancellationToken ct) =>
{
    var created = await store.CreateAsync(request, ct);
    return TypedResults.Created($"/invoices/{created.Id}", created);
});

app.Run();
```

`CreateSlimBuilder` は最小限のサービスセットだけを読み込み、これが Native AOT を実用化しています。`MapGroup` と `RequireAuthorization` の組み合わせは、.NET 7 より前には存在しなかったルートグループ / 共有ポリシーの仕組みです。`[Validate]` は ASP.NET Core 11 の属性で、ソースジェネレーターに支えられたバリデーター `Microsoft.AspNetCore.Http.Validation` を有効化し、これまでコントローラー専用だった DataAnnotations パイプラインを置き換えます。戻り値型 `Results<TOk, TErr>` は、追加の `Produces` 装飾なしで OpenAPI ドキュメントを正確に保つための仕組みです。

## コントローラーが正しい選択になるとき

次のいずれかが当てはまる場合はコントローラーを使います。

- **同じアプリで Razor ビューや Razor Pages が必要。**サーバーサイドレンダリングの HTML は依然としてコントローラーの領域です。`AddControllersWithViews` と `AddRazorPages` は MVC のビューパイプラインに接続します。Minimal APIs は接続せず、.NET 11 でも接続しません。エンドポイントの半分が MVC ビューで半分が JSON なら、両方を同じ `WebApplication` で動かして問題ありませんが、JSON の側は Minimal APIs にしつつビューはコントローラーに残せます。
- **大規模な MVC コードベースを保守している。**横断的な `[Authorize]`、`[ApiVersion]`、`[ProducesResponseType]` とカスタム `IAsyncActionFilter` 実装を抱える 300 コントローラーのアプリは、移行候補ではありません。書き直しの ROI はマイナスです。コントローラーのまま `net11.0` にプロジェクトをアップグレードし、チームが望むなら新しいエンドポイントを Minimal APIs として並べて追加します。
- **置き換えられない MVC の規約やフィルターに依存している。**MVC のいくつかのピースは Minimal APIs に等価物がありません：カスタムバインディングのための `IModelBinder`、ルーティング分岐のための `IActionConstraint`、`IApplicationModelConvention` の `ApplicationModel` 規約などです。これらの上にインフラを築いているなら、移行は本物の作業です。
- **`[ApiController]` の契約が欲しい。**`ModelState` が無効なときの自動 400、`[FromBody]` の推論、どこでも `ProblemDetails`、というデフォルトは便利です。ASP.NET Core 11 の Minimal APIs でも `[Validate]` と `app.UseStatusCodePages()` を配線すれば同じデフォルトが得られますが、`[ApiController]` は属性 1 つで済みます。

同等の請求書エンドポイントのコントローラー：

```csharp
// .NET 11, C# 14
[ApiController]
[Route("invoices")]
[Authorize]
public class InvoicesController(IInvoiceStore store) : ControllerBase
{
    [HttpGet("{id:int}")]
    [ProducesResponseType(typeof(Invoice), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<Invoice>> Get(int id, CancellationToken ct)
    {
        var invoice = await store.FindAsync(id, ct);
        return invoice is null ? NotFound() : Ok(invoice);
    }

    [HttpPost]
    [ProducesResponseType(typeof(Invoice), StatusCodes.Status201Created)]
    [ProducesResponseType(typeof(ValidationProblemDetails), StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<Invoice>> Create(
        CreateInvoice request,
        CancellationToken ct)
    {
        var created = await store.CreateAsync(request, ct);
        return CreatedAtAction(nameof(Get), new { id = created.Id }, created);
    }
}
```

エンドポイントが 2 つ、ボイラープレートは 2 倍、機能的な得はありません。これが 2026 年に Minimal APIs を既定にする理由です。新しいコードでは、同じことを表現するためにより少ない量を書きます。

## ベンチマーク

ASP.NET Core 11 における 2 つのスタイルの性能差は、小さな JSON エンドポイントでは小さいながらも一貫しています。.NET チームの公式ベンチマーク（https://github.com/aspnet/Benchmarks 、ASP.NET Core 11 GA の結果は 2025 年 11 月公開）は次のように報告しています。

| シナリオ                                | Minimal APIs (RPS) | Controllers (RPS) | 差     |
| --------------------------------------- | ------------------ | ----------------- | ------ |
| `GET /json`（単一オブジェクト、200 バイト） | 1,160,000       | 1,120,000         | +3.6%  |
| `POST /json`（エコー、ボディ 1 KB）     | 590,000            | 565,000           | +4.4%  |
| `GET /plaintext`（TechEmpower）         | 7,250,000          | 7,250,000         | 0%     |
| コールドスタート（AOT、`dotnet publish -aot`） | 70 ms       | 280 ms            | -75%   |

公開された実行から要約した方法論：ASP.NET Core 11 GA、Linux x64、Citrine マシン、`wrk` で Kestrel を 256 同時接続で叩く、30 秒間の実行を 5 サンプル平均。コールドスタートの行は同じラボから、初回実行時の AOT バイナリに `time` を当てた値です。`plaintext` が同一なのは、リクエストパイプラインのコストがエンドポイント形状ではなく Kestrel のパースに支配されているからです。

数字を素直に読むとこうです。ホットな JSON エンドポイントで CPU バウンドなら、コントローラーから Minimal APIs に乗り換えることで 3-5% 回収できるかもしれません。実際のアプリは時間を EF Core や HTTP 送信側に費やしていて、エンドポイントディスパッチャーではありません。一方、コールドスタートの行は本物です。AWS Lambda や Azure Functions に展開しているなら、AOT の差は「1 秒未満で温まるサービス」と「そうでないサービス」の違いそのものです。[.NET 11 Lambda のコールドスタートを減らす](/ja/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) という関連記事で、これらの数値を生み出している AOT 公開のフローを掘り下げています。

## あなたに代わって決めてしまう落とし穴

3 つの制約は、好みに関わらず結論を決めます。

- **プロジェクト内の Razor ビュー。**アプリが Razor や Razor Pages を提供しているなら、その部分はコントローラーのまま使います。Minimal APIs はレンダリング済みのビューを返せません。それでも分割は可能です：JSON エンドポイントは Minimal APIs、HTML は MVC、両方を同じ `WebApplication` に登録します。
- **`PublishAot=true`。**AOT で発行する必要があるなら（Lambda、Functions isolated、小さなコンテナー、IoT）、Minimal APIs が抵抗が一番少ない道です。.NET 11 では AOT 下のコントローラーパイプラインは依然警告を出し、チームの公式ガイダンスも AOT シナリオでは Minimal APIs を推奨しています。
- **数クラスを超える既存のコントローラーコードベース。**移行コストは横断的なフィルターと規約にあり、エンドポイントのシグネチャにはありません。意味のある `IActionFilter`、`IApplicationModelConvention`、カスタム `IModelBinder` のインフラがあるなら、移行はリファクタリングではなく書き直しです。動くものは動かしておきます。

## Minimal APIs がまだやらないこと

コントローラーにできて、ASP.NET Core 11 の Minimal APIs にまだ追いついていないことがいくつかあります。

- **複数のソースを跨ぐ複雑なバインディングのための `IModelBinder`。**Minimal APIs のバインディングは主にソースから推論され（ルート、クエリ、ボディ）、パラメーター単位です。ヘッダー、クレーム、ボディをカスタムロジックで 1 つの複合型にまとめたい場合は、その型に静的な `BindAsync` メソッドを書くことになります。動きますが、モデルバインダーほど発見しやすくはありません。
- **ルーティング分岐のための `IActionConstraint`。**`Accept` ヘッダーに応じて 1 つのルートを複数のアクションに振り分けるコンテンツネゴシエーションベースのルーティングに便利です。エンドポイントフィルターでも近づけますが、ルーティング層としての表現力は劣ります。
- **同じルート上の複数アクションに対する MVC の `[Consumes]` コンテンツネゴシエーション。**Minimal APIs では 1 つのエンドポイントにルーティングして内部で振り分けることで対応できますが、MVC の宣言的な形のほうがコンパクトです。

設計の中でこれら 3 つのいずれかが要となっているなら、損益分岐はコントローラー側に再び傾きます。新しい ASP.NET Core 11 サービスの 95% では、そうではありません。

## 選択、もう一度

ASP.NET Core 11 ではデフォルトで Minimal APIs を選びます。.NET 11 で JSON HTTP サービスを作るうえで、ボイラープレートが少なく、AOT に対応し、OpenAPI もきれいに出る方法です。コントローラーを好む歴史的な理由（フィルター、バリデーション、ルートグループ、OpenAPI、規約）は、.NET 7、8、10、11 を通じて 1 つずつ閉じられました。残っているのは、コントローラーが依然として持つ小さな MVC 機能集合（Razor ビュー、モデルバインダー、アクション制約）です。プロジェクトでそれが必要なら、必要な部分にはコントローラーを、残りには Minimal APIs を使います。2 つのスタイルは 1 つの `WebApplication` で問題なく共存します。

## 関連

- [ASP.NET Core minimal APIs で Native AOT を使う方法](/ja/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) - 上のベンチマーク数値の前提となる AOT 公開フロー。
- [ASP.NET Core 11 でエンドポイントごとの rate limiting を追加する方法](/ja/2026/04/how-to-add-per-endpoint-rate-limiting-in-aspnetcore-11/) - エンドポイントフィルターがきれいに扱えるようになった横断的関心事の 1 つ。
- [ASP.NET Core 11 でグローバルな例外フィルターを追加する方法](/ja/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) - MVC の例外フィルターに相当する Minimal API の方法。
- [.NET 11 で Swagger UI に OpenAPI 認証フローを追加する方法](/ja/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/) - 上で示した `RequireAuthorization()` フローのドキュメント化。
- [ASP.NET Core 11 のネイティブ OpenTelemetry トレーシング](/ja/2026/04/aspnetcore-11-native-opentelemetry-tracing/) - どちらのスタイルにも接続するオブザーバビリティの部品。

## ソース

- ASP.NET Core 11 ドキュメント "Minimal APIs overview"：https://learn.microsoft.com/aspnet/core/fundamentals/minimal-apis/overview
- `Microsoft.AspNetCore.Http.Validation`（ASP.NET Core 11 同梱の `[Validate]` パッケージ）：https://learn.microsoft.com/aspnet/core/fundamentals/minimal-apis/validation
- ASP.NET Core 11 の OpenAPI ドキュメント：https://learn.microsoft.com/aspnet/core/fundamentals/openapi/overview
- ASP.NET Core 向け Native AOT：https://learn.microsoft.com/aspnet/core/fundamentals/native-aot
- aspnet/Benchmarks リポジトリ（スループット表の出典）：https://github.com/aspnet/Benchmarks
- MVC controllers リファレンス：https://learn.microsoft.com/aspnet/core/mvc/controllers/actions
