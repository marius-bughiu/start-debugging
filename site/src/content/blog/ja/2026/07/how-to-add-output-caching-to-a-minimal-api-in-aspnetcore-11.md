---
title: "ASP.NET Core 11 の Minimal API に出力キャッシュを追加する方法"
description: "ASP.NET Core 11 の Minimal API における出力キャッシュの完全な実践ガイド：AddOutputCache と UseOutputCache、エンドポイントと MapGroup での CacheOutput、名前付きポリシーとベースポリシー、Expire、VaryByQuery と VaryByHeader、EvictByTagAsync によるタグベースの無効化、キャッシュスタンピード対策、ETag による再検証、そして Redis バッキングストア。"
pubDate: 2026-07-12
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-api"
  - "performance"
  - "caching"
lang: "ja"
translationOf: "2026/07/how-to-add-output-caching-to-a-minimal-api-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-12
---

ASP.NET Core 11 の Minimal API に出力キャッシュを追加するには、必要な可動部品はちょうど 3 つです。`builder.Services.AddOutputCache()` でサービスを登録し、`app.UseOutputCache()` でミドルウェアを追加し、キャッシュしたいエンドポイントを `.CacheOutput()` でマークします。これだけで HTTP レスポンス全体をメモリにキャッシュし、ハンドラーを再実行せずに返せます。これより先のこと（有効期限のウィンドウ、クエリごとのキャッシュキー、タグベースの無効化、Redis バッキングストア）はすべて洗練の話です。この記事ではその全経路を端から端まで辿ります。対象は .NET 11（執筆時点では Preview 5、GA は 2026 年 11 月）で、`Microsoft.NET.Sdk.Web` と C# 14 を使いますが、出力キャッシュ API は ASP.NET Core 7 以降安定しているため、ここでの各ステップは .NET 8、9、10 でもそのまま動作します。

## 出力キャッシュはレスポンスキャッシュではありません

まず最初にはっきりさせておくべきことがあります。ほとんど誰もがつまずくからです。出力キャッシュとレスポンスキャッシュは、異なる問題を解決する異なる機能です。

レスポンスキャッシュ（`AddResponseCaching`）は古い方のミドルウェアです。これは HTTP キャッシュに参加します。`Cache-Control`、`Vary`、`Expires` ヘッダーを読み書きし、レスポンスが正しいヘッダーでオプトインした場合にのみキャッシュします。実質的にはアプリ内部に存在する共有プロキシキャッシュであり、うっかり入った `Set-Cookie` や欠けた `Cache-Control: public` が黙って機能を無効化してしまうため、正しく使うのが難しいのです。

出力キャッシュ（`AddOutputCache`、ASP.NET Core 7 で追加）はサーバー制御です。クライアントのリクエストヘッダーに関係なく、何をどれだけの間キャッシュするかをサーバーが決めます。任意の値によるキャッシュキーのバリエーション、基になるデータが変わったときに一群のエントリを一掃できるタグベースの無効化、そしてキャッシュスタンピードに対する組み込みの保護をサポートします。両端を自分で所有する API では、出力キャッシュがほぼ常に望ましい選択肢です。この記事は全編を通じて出力キャッシュについて扱います。

## 3 つの可動部品を配線する

出力キャッシュは共有フレームワークに含まれているため、インメモリの場合にインストールする NuGet パッケージはありません。サービスを登録してミドルウェアを追加します。

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOutputCache();

var app = builder.Build();

app.UseOutputCache();

app.MapGet("/time", () => new { now = DateTime.UtcNow })
    .CacheOutput();

app.Run();
```

注目すべき点が 3 つあります。1 つ目は、`AddOutputCache()` と `UseOutputCache()` はそれ自体では何もしないということです。これらはキャッシュを利用可能にするだけで、エンドポイントがオプトインするまで何もキャッシュしません。2 つ目は、引数なしの `.CacheOutput()` はデフォルトポリシーを適用し、60 秒間キャッシュします。1 分以内に `/time` を 2 回叩くと同じタイムスタンプが返ってきます。2 回目のリクエストはラムダを一切実行しないからです。

3 つ目、そしてこれが本番のバグを引き起こすものです。ミドルウェアの順序が重要です。`UseOutputCache()` は `UseCors()` の後、`UseAuthentication()` の後、`UseAuthorization()` の後に配置しなければなりません。認可より前に実行されると、匿名ユーザー向けにキャッシュされたレスポンスを認証済みユーザーに、あるいはその逆に返してしまう可能性があります。Razor Pages やコントローラーのアプリでは、`UseRouting()` の後にも来る必要があります。Minimal な `WebApplication` ホストはルーティングを自動で配線しますが、認証を追加する場合は順序の責任はあなたにあります。

```csharp
// .NET 11, C# 14 -- correct ordering with auth
app.UseAuthentication();
app.UseAuthorization();
app.UseOutputCache();   // after auth, not before
```

## 名前付きポリシーで有効期限のウィンドウを設定する

デフォルトの 60 秒のウィンドウが望みどおりであることはめったにありません。これを制御するには、インラインのビルダーを付けて `.CacheOutput()` を呼ぶか、名前付きポリシーを一度定義して名前で参照します。名前付きポリシーは、複数のエンドポイントが同じ設定を共有するときに `Program.cs` を読みやすく保ちます。

```csharp
// .NET 11, C# 14
builder.Services.AddOutputCache(options =>
{
    options.AddPolicy("Short", policy => policy.Expire(TimeSpan.FromSeconds(10)));
    options.AddPolicy("Long", policy => policy.Expire(TimeSpan.FromMinutes(30)));
});
```

そしてエンドポイントごとに名前でポリシーを選択します。

```csharp
// .NET 11, C# 14
app.MapGet("/prices", GetPrices).CacheOutput("Short");
app.MapGet("/catalog", GetCatalog).CacheOutput("Long");
```

設定をエンドポイントの近くに置いておきたい場合は、インライン形式が登録済みポリシーなしで同じことを行います。

```csharp
// .NET 11, C# 14
app.MapGet("/prices", GetPrices)
    .CacheOutput(policy => policy.Expire(TimeSpan.FromSeconds(10)));
```

ハンドラーに属性を付けたい場合のために `[OutputCache]` 属性もあり、これはコントローラーが使う形式です。Minimal API エンドポイントでは `app.MapGet("/x", [OutputCache(PolicyName = "Short")] () => ...)` のようになりますが、流暢な `.CacheOutput("Short")` の方が読みやすく、ほとんどの Minimal API コードが従う慣習です。

## ルートグループ全体を一度にキャッシュする

すべてのエンドポイントで `.CacheOutput()` を繰り返すのはすぐに嫌になります。`MapGroup` は規約を共有する `RouteGroupBuilder` を返すため、グループに出力キャッシュをアタッチすれば、その中のすべてのエンドポイントがそれを継承します。これは[MapGroup による Minimal API エンドポイントの整理](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)で扱ったリソースごとのエンドポイントモジュールとうまく合成できます。

```csharp
// .NET 11, C# 14
var catalog = app.MapGroup("/catalog")
    .CacheOutput(policy => policy.Expire(TimeSpan.FromMinutes(5)).Tag("catalog"));

catalog.MapGet("/", GetAllProducts);
catalog.MapGet("/{id:int}", GetProduct);
```

これで両方のエンドポイントは 5 分間キャッシュされ、`catalog` タグを持ちます。これは以下の無効化のステップで重要になります。

## 間違ったレスポンスを返さないようキャッシュキーを制御する

デフォルトでは、キャッシュキーは完全な URL、すなわちスキーム、ホスト、ポート、パス、そしてクエリ文字列全体です。つまり `/search?q=widgets` と `/search?q=gadgets` は自動的に別々のエントリになり、これは通常正しい動作です。しかし 2 つのケースは明示的な処理が必要です。

1 つ目：特定のクエリ値でバリエーションを付け、それ以外は無視したい場合です。`SetVaryByQuery` はキーをあなたが指定したクエリキーに限定するため、`utm_source` のようなトラッキングパラメータがキャッシュを何千もの似たようなエントリに断片化することはありません。

```csharp
// .NET 11, C# 14 -- cache per culture, ignore everything else in the query
app.MapGet("/articles", GetArticles)
    .CacheOutput(policy => policy
        .Expire(TimeSpan.FromMinutes(10))
        .SetVaryByQuery("culture"));
```

2 つ目：`Accept-Language` やカスタムの API バージョンヘッダーのような、リクエストヘッダーに基づいて異なるコンテンツを返す場合です。`SetVaryByHeader` を使い、各ヘッダー値が独自のエントリを持つようにします。

```csharp
// .NET 11, C# 14
app.MapGet("/articles", GetArticles)
    .CacheOutput(policy => policy.SetVaryByHeader("Accept-Language"));
```

URL とヘッダーで表現できないものについては、`VaryByValue` を使って `HttpContext` からキーの断片を計算できます。これはクレームから解決したテナント ID や、A/B のバケットでバリエーションを付ける方法です。

```csharp
// .NET 11, C# 14 -- separate cache entry per tenant
app.MapGet("/dashboard", GetDashboard)
    .CacheOutput(policy => policy.VaryByValue(context =>
        new KeyValuePair<string, string>(
            "tenant", context.User.FindFirst("tenant")?.Value ?? "public")));
```

ユーザー固有データに対する `VaryByValue` には 1 つ注意があります。出力キャッシュはデフォルトでは認証済みリクエストへのレスポンスを一切キャッシュすることを拒否します。これはまさに、あるユーザーのレスポンスが別のユーザーに漏れるのを避けるためです。それを意図的に上書きする場合（カスタムポリシーのセクションを参照）、ユーザーごとの値でバリエーションを付けることがエントリを分離し続ける手段であり、それを誤ると、パフォーマンスのバグではなくデータ漏洩のバグになります。認証済みの出力キャッシュは高度なケースとして扱い、徹底的にテストしてください。

## タグでオンデマンドに無効化する

時間ベースの有効期限は鈍い道具です。カタログが 1 日に 2 回変わるのに 5 分間キャッシュすると、変わるたびに最大 5 分間は古いデータを返し、残りの時間は無駄に再取得することになります。タグはこれを解決します。キャッシュエントリにタグをアタッチし、基になるデータが変わった瞬間にタグで一掃します。

上のグループで `.Tag("catalog")` を見ました。それを一掃するには、`IOutputCacheStore` を注入して `EvictByTagAsync` を呼びます。その自然な場所は、別の管理用エンドポイントではなく、データを変更した書き込み操作の内部です。

```csharp
// .NET 11, C# 14
app.MapPost("/catalog", async (Product product, AppDbContext db, IOutputCacheStore cache) =>
{
    db.Products.Add(product);
    await db.SaveChangesAsync();

    // The catalog changed, so drop every cached catalog response.
    await cache.EvictByTagAsync("catalog", default);

    return Results.Created($"/catalog/{product.Id}", product);
});
```

これでキャッシュは即座の読み取りを提供しつつ、鮮度を保ちます。5 分（あるいは 1 時間でも）の有効期限はセーフティネットであり、本当の無効化は書き込みが着地したまさにそのときに起こります。`EvictByTagAsync` の呼び出しを行を変更するのと同じ `SaveChanges` に結びつければ、読み手が最後に成功した書き込みより古いデータを見ることはありません。これはそうした書き込みの背後にあるクエリを突き止めることともよく組み合わさります。読み取りエンドポイントがキャッシュに手を伸ばすほど遅いなら、まず [EF Core での N+1 クエリ](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)を排除する価値があります。遅いクエリをキャッシュしても問題を隠すだけだからです。

タグはベースポリシー上で宣言的に登録することもでき、各エンドポイントに触れることなく一致するすべてのエンドポイントにタグを付けます。

```csharp
// .NET 11, C# 14
builder.Services.AddOutputCache(options =>
{
    options.AddBasePolicy(policy => policy
        .With(c => c.HttpContext.Request.Path.StartsWithSegments("/catalog"))
        .Tag("catalog"));
});
```

## ベースポリシーはデフォルトですべてに適用されます

`AddBasePolicy` は 1 つの重要な点で `AddPolicy` と異なります。ベースポリシーは、エンドポイント側の `.CacheOutput()` 呼び出しなしに、すべてのエンドポイント（あるいは `With` 述語に一致するすべてのエンドポイント）に適用されます。これはアプリ全体にわたってデフォルトの有効期限やタグ付けの方式を設定する方法です。

```csharp
// .NET 11, C# 14 -- cache everything for 30 seconds unless overridden
builder.Services.AddOutputCache(options =>
{
    options.AddBasePolicy(policy => policy.Expire(TimeSpan.FromSeconds(30)));
});
```

ここは慎重に。無差別なベースポリシーは、キャッシュするつもりのなかったエンドポイントも平気でキャッシュしてしまいます。`.With(...)` でパスのプレフィックスにスコープを絞るか、API がキャッシュ可能な読み取りとキャッシュ不可な書き込みを混在させる場合（ほとんどがそうです）は、明示的なエンドポイントごとの `.CacheOutput()` 呼び出しを優先してください。

## デフォルトポリシーがキャッシュするもの、しないもの

エンドポイントをオプトインした後でも、出力キャッシュはガードレールを適用します。既定では、次の場合にのみキャッシュします。

- レスポンスのステータスが `HTTP 200` である。
- リクエストメソッドが `GET` または `HEAD` である。
- レスポンスがクッキーを一切設定しない（`Set-Cookie` があると、そのレスポンスのキャッシュは無効になります）。
- リクエストが認証されていない。

これらのルールが、`POST` エンドポイントに `.CacheOutput()` を付けても何もしないように見える理由です。`POST` はデフォルトで除外されています。これらは、うっかり安全でないものをキャッシュしないようにするために存在します。本当に `POST` をキャッシュする必要がある、あるいは `301` レスポンスをキャッシュする、あるいは認証済みレスポンスをキャッシュする必要がある場合は、カスタムの `IOutputCachePolicy` を書いて明示的にオプトインします。

```csharp
// .NET 11, C# 14 -- excerpt of a custom policy that allows POST
public sealed class CachePostPolicy : IOutputCachePolicy
{
    public static readonly CachePostPolicy Instance = new();

    ValueTask IOutputCachePolicy.CacheRequestAsync(
        OutputCacheContext context, CancellationToken cancellationToken)
    {
        var request = context.HttpContext.Request;
        var attempt = HttpMethods.IsGet(request.Method)
                   || HttpMethods.IsHead(request.Method)
                   || HttpMethods.IsPost(request.Method);

        context.EnableOutputCaching = true;
        context.AllowCacheLookup = attempt;
        context.AllowCacheStorage = attempt;
        context.AllowLocking = true;
        context.CacheVaryByRules.QueryKeys = "*";
        return ValueTask.CompletedTask;
    }

    ValueTask IOutputCachePolicy.ServeFromCacheAsync(
        OutputCacheContext context, CancellationToken cancellationToken)
        => ValueTask.CompletedTask;

    ValueTask IOutputCachePolicy.ServeResponseAsync(
        OutputCacheContext context, CancellationToken cancellationToken)
        => ValueTask.CompletedTask;
}
```

`options.AddPolicy("CachePost", CachePostPolicy.Instance)` で名前付きポリシーとして登録し、`.CacheOutput("CachePost")` で選択します。`POST` のキャッシュは異例であり、特定の理由があるべきですが、拡張ポイントはそこにあります。

## スタンピード対策はデフォルトで有効です

ホットなキャッシュエントリが期限切れになり、100 件のリクエストが同時に到着すると、素朴なキャッシュは 100 件すべてをミスさせ、データベースを同時に叩かせます。それがキャッシュスタンピード、あるいはサンダリングハードです。出力キャッシュはリソースのロックでこれを緩和します。あるエントリが生成されている間、同じキーへの並行リクエストは、それぞれが独自に生成するのではなく、最初のものが終わるのを待ちます。これはデフォルトで有効であり、自分で作らない限りこれを行わない手作りの `IMemoryCache` コードに対する具体的な利点の 1 つです。

エンドポイントの生成が安価で、リクエストを待たせたくない場合は、ポリシーごとに `SetLocking(false)` でロックをオフにできます。

```csharp
// .NET 11, C# 14
app.MapGet("/cheap", GetCheapThing)
    .CacheOutput(policy => policy.Expire(TimeSpan.FromSeconds(5)).SetLocking(false));
```

高コストなものについては有効のままにしておきましょう。スタンピード対策は負荷時にまさに望むものであり、これは [HybridCache](/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/) がレスポンス全体のキャッシュではなくデータキャッシュのために解決するのと同じ種類の問題です。

## ETag による安価な再検証

出力キャッシュは HTTP 条件付きリクエストとも協調します。ハンドラーが `ETag` ヘッダーを設定すると、ミドルウェアは一致する `If-None-Match` に対して、ペイロード全体を再送する代わりに `304 Not Modified` と空のボディで応答します。すでにそれを持っているクライアントに提供される大きなレスポンスについては、完全な転送がわずか数バイトに変わります。

```csharp
// .NET 11, C# 14
app.MapGet("/report", async (HttpContext context) =>
{
    context.Response.Headers.ETag = $"\"{ComputeReportVersion()}\"";
    await WriteReport(context);
}).CacheOutput();
```

出力キャッシュを有効にする以上の追加設定は必要ありません。同じことがキャッシュエントリの作成時刻に対する `If-Modified-Since` でも機能します。

## 上限を調整し、スケールアウトしたら Redis へ移行する

出荷前に知っておく価値のある `OutputCacheOptions` の上限が 2 つあります。`MaximumBodySize` はデフォルトで 64 MB です。これより大きいレスポンスは決してキャッシュされません。これは妥当なデフォルトですが、大きなエクスポートがなぜキャッシュされないのか疑問に思ったときには気づきにくいものです。`SizeLimit` はデフォルトで合計 100 MB のキャッシュストレージで、これを超えると新しいエントリは古いものが退避されるのを待ちます。`DefaultExpirationTimeSpan` は、ポリシーが明示的な `Expire` を設定しないときに得られる 60 秒です。

デフォルトのストアはプロセス内メモリで、これは各サーバーインスタンスが独自のキャッシュを持ち、再起動で消えることを意味します。複数インスタンスのロードバランサーの背後では、読み取りの多いエンドポイントについてはこれで問題ないことが多いですが、あるノードでの `tag` の退避が他のノードをクリアしないことも意味します。再起動を生き延び、ノード間で一貫して退避する共有キャッシュが必要になったら、Redis ストアを追加します。これは別のパッケージです。

```bash
dotnet add package Microsoft.AspNetCore.OutputCaching.StackExchangeRedis
```

```csharp
// .NET 11, C# 14
builder.Services.AddStackExchangeRedisOutputCache(options =>
{
    options.Configuration = builder.Configuration.GetConnectionString("Redis");
    options.InstanceName = "MyApp";
});

builder.Services.AddOutputCache(options =>
{
    options.AddBasePolicy(policy => policy.Expire(TimeSpan.FromSeconds(30)));
});
```

メソッドは `AddStackExchangeRedisOutputCache` であり、`IDistributedCache` に使われる名前のよく似た `AddStackExchangeRedisCache` ではないことに注意してください。この区別は重要です。というのも Microsoft は、出力キャッシュを素の `IDistributedCache` で裏付けることに対して明確に反対を推奨しているからです。そのインターフェースはタグベースの退避が依存するアトミックな操作を欠いているため、タグが確実に退避しないのです。素の `IDistributedCache` ではなく、組み込みの Redis 出力キャッシュストアか、カスタムの `IOutputCacheStore` を使ってください。

## 覚えておくべき形

Minimal API における出力キャッシュは、小さく合成可能な部品の集合に帰着します。`AddOutputCache` で登録し、認証ミドルウェアの後に `UseOutputCache` を挿入し、`.CacheOutput()` あるいはグループレベルの `.CacheOutput()` でエンドポイントをオプトインします。ウィンドウを設定するには `Expire` に、キーを正しく保つには `SetVaryByQuery` と `SetVaryByHeader` に、そしてタイマーを待つのではなくデータが変わった瞬間に無効化するには `Tag` と `EvictByTagAsync` に手を伸ばします。高コストな処理についてはスタンピード対策を有効のままにし、認証済みおよびクッキーを持つレスポンスをキャッシュから外すデフォルトのガードレールを尊重し、実際に複数のインスタンスを動かすときにのみインメモリストアを Redis に交換します。それが現実の API の大半をカバーし、上記のすべての行は .NET 8 から .NET 11 までそのまま動作します。

## 関連記事

- [ASP.NET Core 11 で MapGroup を使って Minimal API エンドポイントを整理する方法](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [ASP.NET Core 11 で Redis を L2 キャッシュとして HybridCache を使う方法](/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/)
- [.NET 11 における HybridCache vs IMemoryCache vs IDistributedCache](/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/)
- [EF Core 11 で N+1 クエリを検出する方法](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [ASP.NET Core 11 でエンドポイントごとのレート制限を追加する方法](/2026/04/how-to-add-per-endpoint-rate-limiting-in-aspnetcore-11/)

## 出典

- [Output caching middleware in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/output)
- [Overview of caching in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/overview)
- [IOutputCacheStore.EvictByTagAsync (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.outputcaching.ioutputcachestore.evictbytagasync)
- [OutputCachePolicyBuilder (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.outputcaching.outputcachepolicybuilder)
