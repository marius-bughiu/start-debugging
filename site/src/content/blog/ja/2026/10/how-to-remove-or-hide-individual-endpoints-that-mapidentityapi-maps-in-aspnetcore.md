---
title: "ASP.NET Core で MapIdentityApi がマップする個別のエンドポイントを削除または非表示にする方法"
description: "MapIdentityApi<TUser>() は 10 個のエンドポイントをマップしますが、1 つだけ除外するスイッチはありません。.NET 11 で実測した 4 つの対処法 (OpenAPI から隠す、404 を返す、シャドウする、ルーティングから完全に削除する) と、登録を 500 エラーにする /confirmEmail の落とし穴を紹介します。"
pubDate: 2026-10-17
template: how-to
tags:
  - "aspnetcore"
  - "aspnetcore-11"
  - "identity"
  - "minimal-apis"
  - "openapi"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/10/how-to-remove-or-hide-individual-endpoints-that-mapidentityapi-maps-in-aspnetcore"
translatedBy: "claude"
translationDate: 2026-10-17
---

**結論:** `MapIdentityApi<TUser>()` にはエンドポイントを選択するパラメーターがなく、これは .NET 11 RC 2 でも変わりません。戻り値は `IEndpointConventionBuilder` で、その規約 (convention) は最終的なルートパターンが確定した状態ですべてのエンドポイントに対して実行されるため、`/register` や `/manage/2fa` をパターンで照合できます。OpenAPI ドキュメントからだけ隠すには、規約の中で `ExcludeFromDescriptionAttribute` を追加します。使えなくするには、さらに `EndpointBuilder.RequestDelegate` を 404 を返すデリゲートに置き換えます。ルーティングから完全に削除するには、Identity をプライベートな `IEndpointRouteBuilder` にマップし、フィルタリングする `EndpointDataSource` を通してそのエンドポイントを再公開します (約 30 行、後述)。`/register` や `/resendConfirmationEmail` が有効な間は、`/confirmEmail` を決して削除しないでください。どちらも `NotSupportedException` をスローして 500 を返します。

以下はすべて macOS 上で、SDK 11.0.100-rc.1.26425.128、`Microsoft.AspNetCore.Identity.EntityFrameworkCore` 11.0.0-rc.1.26425.128、EF Core InMemory ストアを使って実行しました。`IdentityApiEndpointRouteBuilderExtensions.cs` を `v8.0.0`、`v11.0.0-rc.1.26425.128`、`v11.0.0-rc.2.26504.105` の各タグ間で比較したところ、ルート一覧は 3 つとも同一で、このファイルは RC 1 から RC 2 の間で変更されていません。したがって、これらの手法は .NET 8、9、10、11 で通用します。

## エンドポイントを個別にスキップする組み込みの方法がない理由

`MapIdentityApi<TUser>()` は、空のルートグループを作成してすべてをそこにマップする 1 つの拡張メソッドです。

| メソッド | ルート | 認証が必要 |
| --- | --- | --- |
| POST | `/register` | いいえ |
| POST | `/login` | いいえ |
| POST | `/refresh` | いいえ |
| GET | `/confirmEmail` | いいえ |
| POST | `/resendConfirmationEmail` | いいえ |
| POST | `/forgotPassword` | いいえ |
| POST | `/resetPassword` | いいえ |
| POST | `/manage/2fa` | はい |
| GET | `/manage/info` | はい |
| POST | `/manage/info` | はい |

ソースコードでは、このグループをプライベートな `IdentityEndpointsConventionBuilder` 型でラップしており、コメントには "to avoid a potential future behavioral breaking change" とあります。戻り値を `RouteGroupBuilder` にキャストすることはできず、ハンドラーはメソッド内のラムダなので、自分で呼び出すこともできません。

これを分割してほしいという要望は 2024 年から出されており、[dotnet/aspnetcore#55792](https://github.com/dotnet/aspnetcore/issues/55792) ("Split MapIdentityApi<TUser>() into multiple APIs and allow selective end points to be enabled") がそれです。拡張性に関するより広い議論の [dotnet/aspnetcore#50303](https://github.com/dotnet/aspnetcore/issues/50303) は .NET 8 のプレビュー時代にさかのぼります。どちらも Backlog マイルストーンにあります。どちらかが実装されるまでは、この問題に突き当たる典型的な理由 (公開サインアップを無効にしたい、2FA は別の場所で処理している、OpenAPI ドキュメントにパスワードリセットを載せたくない) はすべて、外側から対処する必要があります。

## テストのセットアップ

以下のすべてのバリエーションは、このアプリに組み込みます。Identity のエンドポイントは `/account` 配下に置いています。実際のアプリの多くがこのようにマウントしており、ルートの照合方法にも影響するためです。

```csharp
// .NET 11 RC 1, Microsoft.AspNetCore.Identity.EntityFrameworkCore 11.0.0-rc.1.26425.128
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddDbContext<AppDbContext>(o => o.UseInMemoryDatabase("ids"));
builder.Services.AddAuthorization();
builder.Services.AddIdentityApiEndpoints<IdentityUser>()
    .AddEntityFrameworkStores<AppDbContext>();
builder.Services.AddOpenApi();

var app = builder.Build();
app.MapOpenApi();

var account = app.MapGroup("/account");
account.MapIdentityApi<IdentityUser>();

app.Run();

class AppDbContext(DbContextOptions<AppDbContext> options)
    : IdentityDbContext<IdentityUser>(options);
```

何も変更しない場合、`/openapi/v1.json` には `/account` 配下の 10 個のルートがすべて表示され、`POST /account/register` は 200 を返し、匿名の `POST /account/manage/2fa` は 401 を返します。

以下のすべての手法に共通して重要な点があります。規約の内部では、`RouteEndpointBuilder.RoutePattern.RawText` はグループのプレフィックスを含む**最終的な**パターンです。規約からログ出力すると、`/register` ではなく `/account/register`、`/account/manage/2fa` のように出力されます。Identity 自身も、confirm-email エンドポイントの名前付けにこれを利用しています。そのため、`EndsWith` で照合するか、プレフィックス付きの完全なパスと比較します。

```csharp
// .NET 11 RC 1
string[] blocked = ["/register", "/manage/2fa"];

bool IsBlocked(EndpointBuilder b) =>
    b is RouteEndpointBuilder rb &&
    blocked.Any(p => rb.RoutePattern.RawText!.EndsWith(p, StringComparison.OrdinalIgnoreCase));
```

## オプション 1: OpenAPI ドキュメントからだけ隠す

エンドポイントは動作したままにして、公開する契約には載せたくない場合 (公開 API ドキュメントでの `/refresh` や `/manage/info` でよくあります) は、`.ExcludeFromDescription()` が追加するのと同じメタデータを追加します。

```csharp
// .NET 11 RC 1
account.MapIdentityApi<IdentityUser>().Add(b =>
{
    if (IsBlocked(b))
        b.Metadata.Add(new ExcludeFromDescriptionAttribute());
});
```

実測結果: `/account/register` と `/account/manage/2fa` は `/openapi/v1.json` から消え、`POST /account/register` は引き続き 200 を返します。これがこのオプションの狙いであり、同時に限界でもあります。隠すことはドキュメント上の措置であり、アクセス制御ではありません。Identity のドキュメントを読んだ人なら、そのルートが存在することを知っています。

`ExcludeFromDescriptionAttribute` は `Microsoft.AspNetCore.Routing` にあり、`IExcludeFromDescriptionMetadata` を実装しています。これは組み込みの `Microsoft.AspNetCore.OpenApi` ジェネレーターと Swashbuckle の API エクスプローラーの両方が尊重します。すべてを 1 か所にまとめたい場合は、[OpenAPI のオペレーションおよびスキーマトランスフォーマーに関する記事](/ja/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/)のように、ドキュメントトランスフォーマーで同じフィルタリングを行うこともできますが、メタデータを使う方法のほうが簡単で、他の API エクスプローラーの利用者にも効きます。

## オプション 2: ルートは残して 404 を返す

エンドポイントを実際に無効化するには、同じ規約の中でリクエストデリゲートを置き換えます。規約は `RouteEndpoint` が構築される前に `EndpointBuilder` を受け取り、`RequestDelegate` は設定可能なプロパティです。

```csharp
// .NET 11 RC 1
account.MapIdentityApi<IdentityUser>().Add(b =>
{
    if (!IsBlocked(b)) return;

    b.Metadata.Add(new ExcludeFromDescriptionAttribute());
    b.RequestDelegate = ctx =>
    {
        ctx.Response.StatusCode = StatusCodes.Status404NotFound;
        return Task.CompletedTask;
    };
});
```

実測結果: `POST /account/register` は 404 を返し、両方のルートが OpenAPI ドキュメントから消え、他のエンドポイントはすべてこれまでどおり動作します。`.Add(...)` の代わりに `.Finally(...)` を使っても同じ結果でした。`Finally` 規約は他のすべての規約の後に実行されるため、パイプライン内の他の何かが `RequestDelegate` にも手を加える場合は、こちらのほうが安全です。

ただし、ルーティングと認可の観点では、このエンドポイントはまだ存在しています。Identity が `/manage` グループに付ける `RequireAuthorization()` を含め、すべてのメタデータが残ります。認可ミドルウェアはエンドポイントのデリゲートより先に実行されるため、匿名の `POST /account/manage/2fa` は 404 ではなく依然として **401** を返します。404 に到達するのは認証済みの呼び出し元だけです。目的が"存在を知られないようにする"ことなら、この違いは外部から見えてしまいます。

[エンドポイントフィルター](/ja/2026/07/how-to-add-an-endpoint-filter-to-a-minimal-api-in-aspnetcore-11/)でも同じ結果になります。`AddEndpointFilter` は任意の `IEndpointConventionBuilder` で動作するためです。

```csharp
// .NET 11 RC 1
account.MapIdentityApi<IdentityUser>().AddEndpointFilter(async (ctx, next) =>
{
    var route = (ctx.HttpContext.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText ?? "";
    if (blocked.Any(p => route.EndsWith(p))) return Results.NotFound();
    return await next(ctx);
});
```

`/account/register` に対しては、こちらも 404 を返しました。しかしここでは明らかに劣っています。フィルターはすべての Identity リクエストで実行され、メタデータも追加しない限りエンドポイントは OpenAPI ドキュメントに残り、フィルターが実行される時点でリクエストボディのモデルバインドはすでに終わっています。この順序については、[エンドポイントフィルターとミドルウェアの比較](/ja/2026/07/endpoint-filters-vs-middleware-in-aspnetcore-11/)で詳しく説明しています。デリゲートの置き換えを使ってください。

## オプション 3: 優先度の高いエンドポイントでルートをシャドウする

ネット上の多くの回答では、同じルートに自前のエンドポイントをマップすることが勧められています。`MapIdentityApi` の後に `account.MapPost("/register", () => Results.NotFound())` とそのままマップしても、何の役にも立ちません。`AmbiguousMatchException` になると予想していましたが、JSON の `POST /account/register` は Identity のハンドラーから 200 を返しました。Identity のエンドポイントは `[FromBody]` パラメーターをバインドするため `application/json` の accepts メタデータを持っており、content-type マッチャーポリシーはそれを、何も宣言していない自前のエンドポイントより上位に順位付けします。自前のエンドポイントは黙って一度も実行されません。`Order` をより小さい値にすると、そうした優先順位付けが行われる前にマッチャーが自前のエンドポイントを優先します。

```csharp
// .NET 11 RC 1
account.MapIdentityApi<IdentityUser>();
account.MapPost("/register", () => Results.NotFound())
    .WithOrder(-1)
    .ExcludeFromDescription();
```

実測結果: `POST /account/register` は 404 を返し、エンドポイント一覧には `POST /account/register order=0` と `POST /account/register order=-1` の両方が含まれます。元のエンドポイントは、`ExcludeFromDescription()` がシャドウ用のエンドポイントにしか適用されないため、依然として OpenAPI ドキュメントに残ります。隠すにはオプション 1 を併用する必要があります。

シャドウは、エンドポイントを削除するのではなく**置き換え**たい場合、たとえば招待コードも要求する `/register` にしつつ、`MapIdentityApi` の残りは標準のままにしたい場合に適した手段です。単に削除したいだけなら、4 つのオプションの中で最も面倒な方法です。

## オプション 4: ルーティングからエンドポイントを完全に削除する

エンドポイントを本当に存在しないものにする (ルートも OpenAPI のエントリもなく、匿名の呼び出し元に 401 も返さず、未知の URL と同じ 404 だけを返す) には、その `RouteEndpoint` がルーティングシステムに到達しないようにする必要があります。`MapIdentityApi` が、渡された `IEndpointRouteBuilder` から使うメンバーは 2 つだけです。サービスを解決するための `ServiceProvider` と、`MapGroup("")` が自身のエンドポイントソースを追加する `DataSources` です。ここに突破口があります。

1. `MapIdentityApi` に、`DataSources` コレクションがプライベートな、自前の小さな `IEndpointRouteBuilder` を渡します。
2. そのプライベートなコレクションを、不要なエンドポイントを除外する `EndpointDataSource` でラップします。
3. そのラッパーを、実際のルートビルダーの `DataSources` に追加します。

```csharp
// .NET 11 RC 1, works the same on .NET 8, 9 and 10
using Microsoft.Extensions.Primitives;

static class IdentityApiExceptExtensions
{
    public static IEndpointConventionBuilder MapIdentityApiExcept<TUser>(
        this IEndpointRouteBuilder endpoints, params string[] excludedRoutes)
        where TUser : class, new()
    {
        var capture = new CapturingRouteBuilder(endpoints);
        var conventions = capture.MapIdentityApi<TUser>();

        bool Keep(Endpoint e) =>
            e is not RouteEndpoint re ||
            !excludedRoutes.Any(r =>
                re.RoutePattern.RawText!.EndsWith(r, StringComparison.OrdinalIgnoreCase));

        endpoints.DataSources.Add(new FilteringEndpointDataSource(capture.DataSources, Keep));
        return conventions;
    }

    private sealed class CapturingRouteBuilder(IEndpointRouteBuilder inner) : IEndpointRouteBuilder
    {
        public ICollection<EndpointDataSource> DataSources { get; } = new List<EndpointDataSource>();
        public IServiceProvider ServiceProvider => inner.ServiceProvider;
        public IApplicationBuilder CreateApplicationBuilder() => inner.CreateApplicationBuilder();
    }

    private sealed class FilteringEndpointDataSource(
        ICollection<EndpointDataSource> sources, Func<Endpoint, bool> keep) : EndpointDataSource
    {
        private readonly CompositeEndpointDataSource _inner = new(sources);

        public override IReadOnlyList<Endpoint> Endpoints =>
            _inner.Endpoints.Where(keep).ToList();

        public override IReadOnlyList<Endpoint> GetGroupedEndpoints(RouteGroupContext context) =>
            _inner.GetGroupedEndpoints(context).Where(keep).ToList();

        public override IChangeToken GetChangeToken() => _inner.GetChangeToken();
    }
}
```

使い方は 1 行の変更だけです。

```csharp
// .NET 11 RC 1
var account = app.MapGroup("/account");
account.MapIdentityApiExcept<IdentityUser>("/register", "/manage/2fa");
```

実測結果: エンドポイント一覧は 10 個ではなく 8 個になり、`/openapi/v1.json` には 8 個のパスが表示され、`POST /account/register` と匿名の `POST /account/manage/2fa` はどちらも 404 を返します。残りの 8 個のエンドポイントはこれまでどおり動作し、返される規約ビルダーも引き続きそれらに適用されるため、結果にチェーンした `.RequireRateLimiting(...)` や `.WithTags(...)` も通常どおり機能します。

このコードには、間違えやすい点が 2 つあります。

- **`GetGroupedEndpoints` をオーバーライドします。** `account` のようなグループに対して拡張メソッドを呼び出すと、外側のグループは `Endpoints` を読みません。プレフィックスとグループの規約を渡して `GetGroupedEndpoints` を呼び出します。この呼び出しを内側のソースに委譲することで、内側のソースが完全なプレフィックスとすべての規約を適用した状態で各エンドポイントを 1 回だけ構築できます。プレフィックスなしですでに構築されたエンドポイントを基底クラスに再ラップさせる方法に頼らずに済みます。`Keep` の実行時に `RawText` がすでに `/account` を含んでいるのも、このためです。
- **変更トークンを通します。** Identity のエンドポイントは静的ですが、内側のコンポジットから本物のトークンを返しておけば、キャプチャしたコレクションに他の何かがエンドポイントを追加した場合でも、データソースの正しさが保たれます。

これは、`MapIdentityApi` が `ServiceProvider` と `DataSources` しか使わないことに依存しています。8.0 から 11 RC 2 までのすべてのバージョンでそうなっていますが、これは実装の詳細です。たとえば将来のバージョンが `CreateApplicationBuilder()` を呼び出すようになっても、上記の委譲によって動作し続けます。しかし、別のビルダーにマップするようになった場合は動作しません。期待するルート一覧をアサートするテスト (私が使った `IEnumerable<EndpointDataSource>` のダンプは 3 行です) があれば、アップグレード時にそれを検出できます。

## `/confirmEmail` の落とし穴

単独では削除できない唯一のエンドポイントが `GET /confirmEmail` です。`/register`、`/resendConfirmationEmail`、そして `POST /manage/info` のメール変更の分岐は、いずれも `LinkGenerator.GetUriByName` を使って、エンドポイント名から確認リンクを生成します。この名前は `/confirmEmail` の `Finally` 規約で、`MapIdentityApi-` に最終的なルートパターンを続けた形で割り当てられます。

オプション 4 で `MapIdentityApiExcept<IdentityUser>("/confirmEmail")` とした場合、規約は引き続き実行される (エンドポイントは構築されてからフィルタリングされる) ため名前は設定されますが、リンクジェネレーターはその名前のエンドポイントを見つけられません。その結果、登録が失敗します。

```text
System.NotSupportedException: Could not find endpoint named 'MapIdentityApi-/account/confirmEmail'.
```

実測結果: `POST /account/register` は **500** を返し、`POST /account/resendConfirmationEmail` も同様ですが、`/login` は動作し続けます。この API でメール確認をまったく使いたくない場合は、`/confirmEmail` と一緒に `/register` と `/resendConfirmationEmail` も削除するか、`/confirmEmail` はルーティングしたままにしてオプション 1 で OpenAPI からだけ隠してください。

オプション 2 にはこの問題がありません。リンク生成のためにエンドポイントがまだ存在しており、ただ 404 を返すだけだからです。

## どのオプションを使うか

- **エンドポイントはそのままでよく、公開するドキュメントに載せたくないだけの場合:** オプション 1。
- **エンドポイントを動作させたくなく、`/manage/*` で匿名の呼び出し元に 401 を返すことが許容できる場合:** `Finally` でのデリゲートの置き換えを使うオプション 2。数行で済み、Identity の内部実装に依存しません。
- **エンドポイントを完全に存在させたくない場合:** オプション 4。
- **1 つのエンドポイントを別の実装にしたい場合:** オプション 3。元のエンドポイントを隠すにはオプション 1 も併用します。
- **複数のエンドポイントの内部の動作を変更したい場合** (追加の登録フィールド、ユーザー名でのログイン、異なるトークンレスポンスなど): [`IdentityApiEndpointRouteBuilderExtensions.cs`](https://github.com/dotnet/aspnetcore/blob/main/src/Identity/Core/src/IdentityApiEndpointRouteBuilderExtensions.cs) をプロジェクトにコピーして編集します。MIT ライセンスで、約 490 行あり、使われているリクエストとレスポンスの DTO (`RegisterRequest`、`LoginRequest`、`AccessTokenResponse` など) は `Microsoft.AspNetCore.Identity.Data` にあるパブリック型です。今後のフレームワーク更新による自動的な修正は受けられなくなるため、アップグレード時にはこのファイルの履歴を確認してください。

すでに複数のエンドポイントを置き換える段階にあるなら、まず [ASP.NET Core 11 における JWT と Cookie 認証の比較](/ja/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/)でトレードオフを確認してください。`MapIdentityApi` が発行するベアラートークンは JWT ではなく不透明な Data Protection トークンであり、これがチームがこれらのエンドポイントを使い続けられなくなる本当の理由であることがよくあります。

## 注意点

- **完全なルートで照合するか、`EndsWith` を慎重に使います。** `EndsWith("/info")` は `GET` と `POST /manage/info` の両方に一致します。メールとパスワードを変更できる `POST` だけをブロックしたい場合は、規約内で `b.Metadata.OfType<HttpMethodMetadata>()` も確認するか、オプション 4 では `re.Metadata.GetMetadata<HttpMethodMetadata>()` を確認します。
- **`/login` と `/refresh` はセットで扱います。** `/login` を残して `/refresh` を削除すると、クライアントは決して使えない `refreshToken` を受け取ることになります。`/refresh` が実際に何を検証するかは、[リフレッシュトークンの解説](/ja/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/)で扱っています。
- **`/register` を削除してもアカウント作成は止まりません。** `UserManager<TUser>.CreateAsync` は自前のコードから引き続き利用でき、外部ログインのフローでもユーザーは作成されます。エンドポイントをブロックしても、匿名の公開サインアップ用ルートがなくなるだけです。
- **最初からパスベースのミドルウェアに頼らないでください。** `/account/register` で始まるパスに 404 を返すミドルウェアも動作はしますが、グループのプレフィックスをハードコードすることになり、アプリ内のすべてのリクエストで実行され、OpenAPI のエントリも残ります。エンドポイントの規約は最終的なパターンを把握しており、エンドポイントの構築時に 1 回だけ実行されます。
- **Identity は専用のグループにマウントします。** `app` に直接 `MapIdentityApi` を呼び出すと、`/login` と `/register` が API のルートに配置されます。[`MapGroup` で minimal API のエンドポイントを整理する方法](/ja/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)で説明している専用グループを使えば、Identity にだけレート制限やタグを付けることもできます。

## 関連記事

- [ASP.NET Core Identity でリフレッシュトークンを実装する方法](/ja/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/) (`MapIdentityApi` では足りなくなるタイミングも含みます)
- [ASP.NET Core 11 で `MapGroup` を使って minimal API のエンドポイントを整理する方法](/ja/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [ASP.NET Core 11 でオペレーションおよびスキーマトランスフォーマーを使って OpenAPI をカスタマイズする方法](/ja/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/)
- [ASP.NET Core 11 におけるエンドポイントフィルターとミドルウェアの比較](/ja/2026/07/endpoint-filters-vs-middleware-in-aspnetcore-11/)
- [ASP.NET Core 11 における JWT と Cookie 認証の比較](/ja/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/)

## 参考資料

- [`IdentityApiEndpointRouteBuilderExtensions.cs` at `v11.0.0-rc.2.26504.105`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.2.26504.105/src/Identity/Core/src/IdentityApiEndpointRouteBuilderExtensions.cs), dotnet/aspnetcore.
- [dotnet/aspnetcore#55792: Split MapIdentityApi<TUser>() into multiple APIs and allow selective end points to be enabled](https://github.com/dotnet/aspnetcore/issues/55792)
- [dotnet/aspnetcore#50303: Extensibility for Identity Endpoints](https://github.com/dotnet/aspnetcore/issues/50303)
- [Use Identity to secure a Web API backend for SPAs](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/identity-api-authorization), Microsoft Learn.
- [Route groups and endpoint conventions in minimal APIs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/route-handlers#route-groups), Microsoft Learn.
- [`EndpointDataSource` class](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.routing.endpointdatasource), Microsoft Learn.
