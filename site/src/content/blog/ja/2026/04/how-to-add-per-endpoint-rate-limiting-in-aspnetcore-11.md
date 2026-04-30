---
title: "ASP.NET Core 11 でエンドポイントごとのレート制限を追加する方法"
description: "ASP.NET Core 11 におけるエンドポイントごとのレート制限の完全ガイド: fixed window と sliding window、token bucket、concurrency のいずれを選ぶか、RequireRateLimiting と [EnableRateLimiting] の違い、ユーザーや IP によるパーティショニング、OnRejected コールバック、そして誰もが踏む分散デプロイの落とし穴。"
pubDate: 2026-04-30
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "rate-limiting"
lang: "ja"
translationOf: "2026/04/how-to-add-per-endpoint-rate-limiting-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-04-30
---

ASP.NET Core 11 で特定のエンドポイントのレートを制限するには、`AddRateLimiter` で名前付きポリシーを登録し、ルーティングの後に `app.UseRateLimiter()` を呼び出し、minimal API では `RequireRateLimiting("name")`、MVC アクションでは `[EnableRateLimiting("name")]` でポリシーをエンドポイントに付与します。ランタイムは `Microsoft.AspNetCore.RateLimiting` で 4 つの組み込みアルゴリズムを提供します: fixed window、sliding window、token bucket、concurrency です。ミドルウェアはリクエストが拒否されたときに `429 Too Many Requests` を返し、`Retry-After` を含むカスタムレスポンスのために `OnRejected` コールバックを公開します。本ガイドは .NET 11 preview 3 と C# 14 を対象としますが、API は .NET 7 から安定しており、すべてのコード例は .NET 8、9、10 でも変更なしでコンパイルできます。

## 「グローバル」なレート制限が望ましいことはほとんどない理由

最もシンプルなセットアップ、つまりプロセス全体が予算を超えたときにリクエストを破棄する単一のグローバルリミッターは、10 秒ほどは魅力的に見えます。その後、ログインエンドポイントと静的なヘルスプローブがその予算を共有していることに気づくでしょう。`/login` を叩くボットネットは喜んで `/health` を巻き込んで落とし、ロードバランサーは安価なプローブが 429 を返し始めたという理由でインスタンスをローテーションから外します。

エンドポイントごとのレート制限はこれを修正します。各エンドポイントは実際のコストに合わせた制限値を持つ独自のポリシーを宣言します: `/login` は厳しい IP 単位の token bucket、`/api/search` は寛大な sliding window、ファイルアップロードのエンドポイントは concurrency リミッター、そして `/health` には何もなしです。グローバルリミッターは、もし維持するならば、主要な防御ではなくプロトコルレベルの濫用に対するセーフティネットになります。

`Microsoft.AspNetCore.RateLimiting` ミドルウェアは .NET 7 でプレビューから昇格し、それ以降は QoL 的な改良のみが入っています。.NET 11 ではフレームワークの一級の機能であり、追加で導入する NuGet パッケージはありません。

## 最小限の Program.cs

以下は、エンドポイントごとに 2 つの異なるポリシーを追加し、1 つを minimal API のエンドポイントに適用し、残りのアプリケーションをスロットリングなしで実行する最小限のセットアップです。

```csharp
// .NET 11 preview 3, C# 14
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;

    options.AddFixedWindowLimiter(policyName: "search", o =>
    {
        o.PermitLimit = 30;
        o.Window = TimeSpan.FromSeconds(10);
        o.QueueLimit = 0;
    });

    options.AddTokenBucketLimiter(policyName: "login", o =>
    {
        o.TokenLimit = 5;
        o.TokensPerPeriod = 5;
        o.ReplenishmentPeriod = TimeSpan.FromMinutes(1);
        o.QueueLimit = 0;
        o.AutoReplenishment = true;
    });
});

var app = builder.Build();

app.UseRateLimiter();

app.MapGet("/api/search", (string q) => Results.Ok(new { q }))
   .RequireRateLimiting("search");

app.MapPost("/api/login", (LoginRequest body) => Results.Ok())
   .RequireRateLimiting("login");

app.MapGet("/health", () => Results.Ok("ok"));

app.Run();

record LoginRequest(string Email, string Password);
```

注目すべき点は 2 つあります。1 つ目は `RejectionStatusCode` がデフォルトで `503 Service Unavailable` になっていることで、これはほぼすべての公開 API にとって誤りです。`AddRateLimiter` の中で一度 `429` に設定すれば、あとは忘れて構いません。2 つ目は、ルーティングを明示的に呼び出す場合、`app.UseRateLimiter()` は `app.UseRouting()` の後に来る必要があるという点です。ミドルウェアは、どのポリシーを適用するか決めるためにエンドポイントメタデータを読むからです。組み込みの `WebApplication` は終端ミドルウェアの前にルーティングを自動で追加するため、明示的な `UseRouting` 呼び出しはルーティングとレート制限の間に挟まる必要のある別のミドルウェアがある場合にのみ必要になります。

## RequireRateLimiting と [EnableRateLimiting]

ASP.NET Core にはエンドポイントにポリシーを付与する 2 つの等しく有効な方法があり、minimal API と MVC ではメタデータの取り扱いが異なるため両方が存在します。

minimal API とエンドポイントグループでは、`IEndpointConventionBuilder` の流暢な `RequireRateLimiting` メソッドが正しい呼び出しです:

```csharp
// .NET 11, C# 14
var api = app.MapGroup("/api/v1").RequireRateLimiting("search");

api.MapGet("/products", (...) => ...);          // inherits "search"
api.MapGet("/orders", (...) => ...);            // inherits "search"
api.MapPost("/login", (...) => ...)
   .RequireRateLimiting("login");               // overrides to "login"
```

エンドポイントレベルのメタデータはグループレベルのメタデータに勝ちます。ですから `/login` でのオーバーライドは想定通りに動作します: エンドポイントで最も具体的なポリシーだけが適用されます。

MVC コントローラーでは、属性形式が正しい呼び出しです:

```csharp
// .NET 11, C# 14
[ApiController]
[Route("api/[controller]")]
[EnableRateLimiting("search")]
public class ProductsController : ControllerBase
{
    [HttpGet]
    public IActionResult List() => Ok(/* ... */);

    [HttpGet("{id}")]
    [EnableRateLimiting("hot")]    // narrower policy for a hot endpoint
    public IActionResult Get(int id) => Ok(/* ... */);

    [HttpPost("import")]
    [DisableRateLimiting]          // bypass entirely for an internal endpoint
    public IActionResult Import() => Ok();
}
```

`[EnableRateLimiting]` と `[DisableRateLimiting]` は ASP.NET Core 標準の属性解決ルールに従います: アクションレベルがコントローラーレベルに勝ち、`DisableRateLimiting` は常に勝ちます。流暢な記法と属性の記法を混ぜても問題ありません。メタデータパイプラインは両方を同じように読みます。

よくある間違いは、minimal API のエンドポイントに `.WithMetadata(new EnableRateLimitingAttribute("search"))` で `[EnableRateLimiting]` を付けることです。動作はしますが、`RequireRateLimiting("search")` の方が短く明快です。

## アルゴリズムの選択

4 つの組み込みアルゴリズムは「どの程度の頻度が多すぎるか」という問いの 4 つの異なる形に答えるもので、誤った選択はあなたの制限値を貫通するトラフィックスパイクとして、または通常のバーストで 429 を受け取る正当なユーザーとして現れます。

**Fixed window** は重ならない時間バケットでリクエストを数えます。`PermitLimit = 100, Window = 1s` は時計に整列した各 1 秒で最大 100 リクエストを意味します。計算が安価で考えやすいですが、ウィンドウ境界で 200 リクエストのバーストを許容します: あるウィンドウの最後のミリ秒に 100、次のウィンドウの最初のミリ秒に 100 です。バーストが許容できるコスト制限や、追跡に CPU を使いたくない非クリティカルな濫用対策に使用してください。

**Sliding window** はウィンドウをセグメントに分割して前進させます。`PermitLimit = 100, Window = 1s, SegmentsPerWindow = 10` は、100ms 刻みで評価される任意の 1 秒スライスでの 100 リクエストを意味します。リクエストごとの帳簿付けが増える代わりに境界バーストを排除します。これは公開される読み取り系エンドポイントの妥当なデフォルトです。

**Token bucket** は `ReplenishmentPeriod` ごとに `TokensPerPeriod` のトークンを `TokenLimit` まで補充します。各リクエストはトークンを 1 つ取ります。バーストは `TokenLimit` まで許容され、その後は補充レートに収束します。これは小さなバースト (ログイン中のユーザーが 5 つのタブを開く) を許容しつつ持続レート (スクレイピングは不可) を制限したい任意のエンドポイントに正しいモデルです。ログイン、パスワードリセット、メール送信のエンドポイントはすべて token bucket の候補です。

**Concurrency** は所要時間に関係なく、同時に処理中のリクエスト数を制限します。`PermitLimit = 4` は最大 4 つの並行リクエストを意味します。5 つ目はキューに入るか拒否されます。遅い下流リソースに当たるエンドポイントに使用してください: 大きなファイルアップロード、コストのかかるレポート生成、またはコストがリクエスト数ではなくワーカー上の実時間であるエンドポイントです。

`QueueLimit` と `QueueProcessingOrder` のオプションは 4 つすべてで共通です。`QueueLimit = 0` は「容量に達したら即座に拒否」を意味し、これがほとんどの HTTP API で望ましい設定です。クライアントは 429 を受けても再試行するからです。0 でないキュー上限は、作業が短くて 200ms キューに並ぶ方がクライアントを再試行ループに送るより安価な concurrency リミッターで意味があります。

## パーティショニング: ユーザー単位、IP 単位、テナント単位

エンドポイントごとに単一の共有バケットというのはほとんど望むものではありません。`/api/search` がグローバルに 10 秒で 30 リクエストを許容している場合、騒がしいクライアント 1 つが他のすべてのユーザーをロックアウトしてしまいます。パーティション化されたリミッターは各「キー」に独自のバケットを与えます。

流暢な `AddPolicy` のオーバーロードは `HttpContext` を受け取って `RateLimitPartition<TKey>` を返します:

```csharp
// .NET 11, C# 14
options.AddPolicy("per-user-search", context =>
{
    var key = context.User.Identity?.IsAuthenticated == true
        ? context.User.FindFirst("sub")?.Value ?? "anon"
        : context.Connection.RemoteIpAddress?.ToString() ?? "unknown";

    return RateLimitPartition.GetSlidingWindowLimiter(key, _ => new SlidingWindowRateLimiterOptions
    {
        PermitLimit = 60,
        Window = TimeSpan.FromMinutes(1),
        SegmentsPerWindow = 6,
        QueueLimit = 0
    });
});
```

ファクトリはパーティションキーごとに 1 度呼び出されます。ランタイムは結果のリミッターを `PartitionedRateLimiter` にキャッシュするため、同じキーの後続リクエストは同じリミッターインスタンスを再利用します。メモリ使用量は遭遇する異なるキーの数に比例して増えるため、アイドルリミッターを退避させるべきです。フレームワークはリミッターが `IdleTimeout` (デフォルト 1 分) アイドルになったときに自動でこれを行いますが、`RateLimitPartition.GetSlidingWindowLimiter(key, factory)` のオーバーロードで調整できます。

パーティショニングの落とし穴 2 つ:

1. **リバースプロキシの背後では `RemoteIpAddress` は `null`** です。`ForwardedHeaders.XForwardedFor` を構成し、`KnownProxies` または `KnownNetworks` のリストとともに `app.UseForwardedHeaders()` を呼び出さない限り、すべてのリクエストはパーティションキー `"unknown"` を取り、再びグローバルリミッターになってしまいます。
2. **認証済みユーザーと匿名ユーザーが同じパーティションに混在する** のは `sub` だけをキーにした場合です。`"user:"` や `"ip:"` のような接頭辞を使い、ログアウトした攻撃者が実ユーザーのバケットと衝突できないようにしてください。

より複雑なポリシー (テナント単位、API キー単位、複数のリミッターを連結など) では、`IRateLimiterPolicy<TKey>` を実装して `options.AddPolicy<string, MyPolicy>("name")` で登録します。ポリシーインターフェースは同じ `GetPartition` メソッドに加え、そのポリシーにスコープされた `OnRejected` コールバックを提供します。

## 拒否レスポンスのカスタマイズ

デフォルトの 429 レスポンスは `Retry-After` ヘッダーのない空ボディです。内部 API には問題ありませんが、公開クライアント (ブラウザ、SDK、サードパーティ統合) はヒントを期待します。`OnRejected` コールバックはリミッターが拒否した後、レスポンスが書き込まれる前に実行されます:

```csharp
// .NET 11, C# 14
options.OnRejected = async (context, cancellationToken) =>
{
    if (context.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retryAfter))
    {
        context.HttpContext.Response.Headers.RetryAfter =
            ((int)retryAfter.TotalSeconds).ToString();
    }

    context.HttpContext.Response.ContentType = "application/problem+json";
    await context.HttpContext.Response.WriteAsJsonAsync(new
    {
        type = "https://tools.ietf.org/html/rfc6585#section-4",
        title = "Too Many Requests",
        status = 429,
        detail = "Rate limit exceeded. Retry after the indicated period."
    }, cancellationToken);
};
```

間違えやすい詳細が 2 つあります。1 つ目は、`MetadataName.RetryAfter` は token bucket と補充型のリミッターでのみ設定され、fixed window や sliding window では設定されないという点です。sliding window リミッターは `Window / SegmentsPerWindow` から retry-after を計算できますが、計算は自分で行う必要があります。2 つ目は、`OnRejected` コールバックがエンドポイントの内部ではなくレートリミッターミドルウェアのパスで実行されることです。したがって `context.HttpContext.RequestServices` 経由でエンドポイント固有のサービスにアクセスすることは可能ですが、コントローラーフィルターやアクションコンテキストへのアクセスはできません。これらはまだバインドされていないからです。

グローバルではなくポリシーごとの `OnRejected` を望むなら、`IRateLimiterPolicy<TKey>` を実装してポリシーで `OnRejected` をオーバーライドします。ポリシーレベルのコールバックはグローバルなものに加えて実行されるので、レスポンスボディを 2 度書き込まないように注意してください。

## 分散デプロイの落とし穴

これまでのコード例はすべて、レート制限の状態をプロセスメモリに格納します。単一インスタンスを動かす場合は問題ありませんが、水平にスケールアウトすると壊滅的になります。ロードバランサーの背後にある 3 つのレプリカで `PermitLimit = 100` を 10 秒ごとに設定すると、各レプリカが独立してカウントするため、実際には 10 秒で 300 リクエストが許容されます。スティッキーセッションが役立つのは、ハッシュがパーティションキーを均等に分散させた場合だけで、通常はそうなりません。

`Microsoft.AspNetCore.RateLimiting` には組み込みの分散レートリミッターはありません。.NET 11 時点で維持されている選択肢は次のとおりです:

- **制限をロードバランサーに押し付ける。** NGINX `limit_req`、AWS WAF のレートベースルール、Azure Front Door のレート制限、Cloudflare Rate Limiting Rules などです。これはネットワークエッジでの粗い濫用対策に正しい答えです。
- **Redis バックエンドのライブラリを使う。** `RateLimit.Redis` (GitHub の Microsoft サンプル) と `AspNetCoreRateLimit.Redis` はどちらも、Redis の sorted set またはアトミックなインクリメントに対して `PartitionedRateLimiter<HttpContext>` を実装します。Redis のラウンドトリップはリクエストあたり 0.5-2ms を加えますが、ホットパス上にないエンドポイントには許容できます。
- **両方を組み合わせる。** エッジで寛大な制限を強制し、アプリケーションでは Redis でユーザー単位の制限を強制し、in-process は concurrency リミッターを通じた遅い下流へのバックプレッシャー専用に取っておきます。

[Cloudflare の分散スライディングウィンドウカウンタに関するブログ記事](https://blog.cloudflare.com/counting-things-a-lot-of-different-things/) を読み、クロックスキューについて確固たる意見を持っているのでない限り、`IDistributedCache` と `INCRBY` の上に独自の分散リミッターを実装するのは避けてください。

## レート制限されたエンドポイントのテスト

`WebApplicationFactory<TEntryPoint>` による統合テストは動作しますが、レートリミッターはデフォルトではテスト間でリセットされません。戦略は 2 つあります:

1. **テストホストでポリシーをオーバーライドする。** テスト環境では寛容なリミッター (`PermitLimit = int.MaxValue`) を注入し、実際のポリシーで明示的にリミッターに当てる別のテストセットを書きます。
2. **テスト対象のエンドポイントでリミッターを無効化する。** `MapGroup`/`RequireRateLimiting` の呼び出しを `if (!env.IsEnvironment("Testing"))` で囲むか、テストオーバーライドで `[DisableRateLimiting]` を使います。

ミドルウェアはまた、エンドポイントごとのポリシーの前にすべてのリクエストで実行されるトップレベルのパーティション化リミッターのために `RateLimiterOptions.GlobalLimiter` を公開します。これは IP 単位の「明らかにボットだろう」というゲートのための正しい場所であり、どの名前付きポリシーが発火したかに関係なくすべての拒否で `Retry-After` ヘッダーを追加するための正しい場所です。これをエンドポイントごとのポリシーの代わりに使わないでください。両者は合成されるものであり、互いを置き換えるものではありません。

## 組み込みミドルウェアでは足りない場合

ミドルウェアは 90% のケースをカバーします。残る 10% は通常、次のいずれかを伴います:

- **コストベースの制限**: 各リクエストは計算されたコストに応じて N 個のトークンを消費します (5 つのファセットを持つ検索はフラットなリストよりコストがかかる)。ミドルウェアには可変トークン消費のためのフックがないため、ハンドラー内でエンドポイントを `RateLimiter.AcquireAsync(permitCount)` の手動呼び出しで包むことになります。
- **劣化を伴うソフトリミット**: 429 を返す代わりに、キャッシュされたまたはダウンサンプリングされたレスポンスを返します。これはミドルウェアではなくエンドポイントで実装します: `context.Features.Get<IRateLimitFeature>()` (.NET 9 でミドルウェアが追加) を確認してそれで分岐します。
- **ルートごとのメトリクス公開**: ミドルウェアは `Microsoft.AspNetCore.RateLimiting` メーター経由で `aspnetcore.rate_limiting.request_lease.duration` などのメトリクスを発行します。`OpenTelemetry` を通して接続すると、ダッシュボードでポリシーごとの 429 カウントが得られます。組み込みのカウンタはエンドポイント単位で分割されません。それが必要なら、`OnRejected` 内でメーターに自分でタグを付けてください。

## 関連

- [ASP.NET Core 11 でグローバル例外フィルターを追加する方法](/ja/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) は `UseRateLimiter` にも当てはまるミドルウェアの順序のルールを扱っています。
- [ASP.NET Core minimal API で Native AOT を使う方法](/ja/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) は `IRateLimiterPolicy<T>` のトリム安全性への含意を扱います。
- [HttpClient を使うコードを単体テストする方法](/ja/2026/04/how-to-unit-test-code-that-uses-httpclient/) は上記で参照したテストホストパターンを扱います。
- [.NET 11 で Swagger UI に OpenAPI 認証フローを追加する方法](/ja/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/) は API キーがユーザー識別を運ぶ場合のパーティションキーの話を扱います。
- [.NET 11 で OpenAPI 仕様から強く型付けされたクライアントコードを生成する方法](/ja/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/) は 429 契約のコンシューマー側を扱います。

## 出典

- MS Learn の [ASP.NET Core におけるレート制限ミドルウェア](https://learn.microsoft.com/aspnet/core/performance/rate-limit)。
- [`Microsoft.AspNetCore.RateLimiting` API リファレンス](https://learn.microsoft.com/dotnet/api/microsoft.aspnetcore.ratelimiting)。
- 基礎となるリミッタープリミティブのための [`System.Threading.RateLimiting` パッケージのソース](https://github.com/dotnet/runtime/tree/main/src/libraries/System.Threading.RateLimiting)。
- `429 Too Many Requests` と `Retry-After` ヘッダーの正規定義のための [RFC 6585 セクション 4](https://www.rfc-editor.org/rfc/rfc6585#section-4)。
