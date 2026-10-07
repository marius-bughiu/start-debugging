---
title: "ASP.NET Core のマルチテナントキャッシュ: Redis のキープレフィックス vs 別データベース vs 別インスタンス"
description: "ほとんどのマルチテナント ASP.NET Core アプリでは、共有 Redis 1 台にテナントのキープレフィックスを付ける方式を使い、契約上の分離やノイジーなワークロードがあるテナントだけを専用インスタンスに移してください。番号付きデータベースは避けましょう。Redis Cluster、Azure Managed Redis、Redis Cloud ではデータベース 0 しか使えません。"
pubDate: 2026-10-07
template: vs
tags:
  - "comparison"
  - "redis"
  - "aspnetcore"
  - "dotnet"
  - "caching"
  - "multi-tenancy"
lang: "ja"
translationOf: "2026/10/redis-key-prefix-vs-separate-database-vs-separate-instance-for-multi-tenant-caching-in-aspnetcore"
translatedBy: "claude"
translationDate: 2026-10-07
---

マルチテナントの ASP.NET Core アプリでは、すべてのテナントを 1 台の共有 Redis に載せ、`t:{tenantId}:` のようなキープレフィックスで分離してください。この方式はどの Redis トポロジーでも動作し、`HybridCache` と `IDistributedCache` にそのまま組み込めます。しかも `HybridCache` のインプロセス L1 はテナント間で共有されるため、そもそもプレフィックスは必要になります。テナントに専用の Redis インスタンスを与えるのは、契約、コンプライアンス上の境界、またはノイジーなワークロードが求める場合だけにしてください。番号付きデータベース (`SELECT 3`) は避けましょう。Redis Cluster、Azure Managed Redis、Redis Cloud はデータベース 0 しかサポートしておらず、得られる分離も見た目ほど強くありません。

以下の内容はすべて、.NET SDK 10.0.302 で `net10.0` を対象に、`Microsoft.Extensions.Caching.StackExchangeRedis` 10.0.12、`Microsoft.Extensions.Caching.Hybrid` 10.10.0、`StackExchange.Redis` 3.3.1 を使ってコンパイル確認しています。.NET 11 向けの 11.0.0-rc.1 パッケージにも同じ API があります。

## 3 つの選択肢の比較

| | キープレフィックス (共有インスタンス) | テナントごとの番号付きデータベース | テナントごとのインスタンス |
| --- | --- | --- | --- |
| テナントの分離方法 | すべてのキーの先頭に `t:42:` を付ける | 接続で `SELECT 42` を実行する | ホストと認証情報を分ける |
| Redis Cluster / Azure Managed Redis / Redis Cloud で動作するか | はい | いいえ、データベース 0 のみ | はい |
| 最大テナント数 | 無制限 | 既定で 16 (`databases` 設定) | 予算次第 |
| メモリ上限とエビクション | 共有 | 共有 (`maxmemory` はサーバー単位) | 別々 |
| CPU とレイテンシの分離 | なし | なし | 完全 |
| テナントごとのアクセス制御 | ACL のキーパターン `~t:42:*` (Redis 7 以降) | Valkey 9.1 以降のみ (`db=` ルール) | 認証情報を分離 |
| 1 テナントを消去する方法 | `SCAN` + `DEL`、または `HybridCache` のタグ | `FLUSHDB` | インスタンスを削除 |
| 1 回の `AddHybridCache()` で動作するか | はい | ルーティング用の `IDistributedCache` が必要 | ルーティング用の `IDistributedCache` が必要 |
| アプリインスタンスあたりの接続数 | マルチプレクサー 1 つ | 使用するデータベースごとにマルチプレクサー 1 つ | テナントごとにマルチプレクサー 1 つ |
| コスト | 最も低い | 最も低い | 最も高い |

番号付きデータベースは中間の選択肢に見えます。しかし実際には、重要な制限はプレフィックス方式と同じものを共有したうえで、プレフィックス方式にはない制約が加わります。

## 番号付きデータベースが罠になる理由

Redis 自身の [`SELECT` のドキュメント](https://redis.io/docs/latest/commands/select/)は率直です。データベースは "within the same application" でキーを分けるためのものであり、無関係なワークロードを 1 台のサーバーで動かすためのものではないとされています。さらに "Redis Cluster only supports database zero" と続きます。この 1 文だけで、マネージドサービスの大部分が対象外になります。

- **Azure Managed Redis** は、[アーキテクチャのページ](https://learn.microsoft.com/en-us/azure/redis/architecture)によると "internally configured to use clustering, across all tiers and SKUs" であり、Redis Enterprise 上で動作します。
- **Redis Software と Redis Cloud** は共有データベースをまったくサポートしません。`SELECT` のページには、このコマンドは "supported solely for compatibility" であり、そこでは何の操作も行わないと書かれています。分離を `SELECT` に頼っているコードをこれらに移行すると、すべてのテナントが黙って同じキー空間に入ってしまいます。これはマルチテナントで起こりうる最悪の障害です。エラーは出ず、テナント間でデータが漏れるだけです。
- **クラスターモードの Redis OSS** (クラスターモードのマネージドサービスの大半を含む) は、データベース 0 以外を拒否します。

唯一の例外は Valkey です。[Valkey 9.0](https://www.linuxfoundation.org/press/valkey-9.0-delivers-performance-and-resiliency-for-real-time-workloads) でクラスターモードでも番号付きデータベースが使えるようになり、[Valkey 9.1 では `db=` ACL ルールが追加](https://valkey.io/commands/acl-setuser/)されて、ユーザーを特定のデータベースに制限できるようになりました。Valkey 9.1 以降を運用していて、他へ移る予定がないのであれば、データベースを使うのも妥当です。それ以外の環境でデータベースを選ぶと、テナンシーモデルが 1 つのホスティングトポロジーに縛られます。

データベースが使える環境でも、テナント同士が実際に奪い合うものは分離されません。`maxmemory` とエビクションポリシーはサーバー全体に適用されるため、1 つのテナントが自分のデータベースを埋め尽くすと、他のテナントのキーが追い出されます。Redis はコマンドを 1 本のメインスレッドで実行するので、あるテナントが遅い `KEYS *` を実行すると、すべてのデータベースが止まります。そして既定の `databases 16` では、顧客が尽きる前にテナント枠が尽きます。

もう 1 つの現実的な問題は .NET 側にあります。`AddStackExchangeRedisCache` の裏にある `IDistributedCache` 実装の `RedisCache` は、[RedisCache.cs](https://github.com/dotnet/aspnetcore/blob/main/src/Caching/StackExchangeRedis/src/RedisCache.cs) で確認できるとおり、引数なしで `connection.GetDatabase()` を呼び出します。常に接続の `DefaultDatabase` を使うということです。データベース 7 にアクセスするには、`DefaultDatabase = 7` を指定した `ConfigurationOptions` から `RedisCache` を作る必要があります。つまり使用するデータベースごとに `ConnectionMultiplexer` が 1 つ必要になり、共有マルチプレクサーが避けようとしているオーバーヘッドそのものになります。

## キープレフィックス方式を正しく実装する

`RedisCacheOptions.InstanceName` は、"a single backend cache for use with multiple apps/services" を分割するための仕組みとしてドキュメントに記載されています。これはプロセス全体で共通のプレフィックスなので、アプリ名に使い、テナントは各キーに含めてください。

```csharp
// .NET 10, ASP.NET Core 10
// Microsoft.Extensions.Caching.StackExchangeRedis 10.0.12
// Microsoft.Extensions.Caching.Hybrid 10.10.0, StackExchange.Redis 3.3.1
using Microsoft.Extensions.Caching.Hybrid;
using StackExchange.Redis;

var builder = WebApplication.CreateBuilder(args);

var mux = await ConnectionMultiplexer.ConnectAsync(
    builder.Configuration.GetConnectionString("redis")!);
builder.Services.AddSingleton<IConnectionMultiplexer>(mux);

builder.Services.AddStackExchangeRedisCache(o =>
{
    // share the multiplexer instead of opening a second connection
    o.ConnectionMultiplexerFactory = () => Task.FromResult<IConnectionMultiplexer>(mux);
    o.InstanceName = "myapp:"; // note the trailing delimiter
});
builder.Services.AddHybridCache();

builder.Services.AddHttpContextAccessor();
builder.Services.AddScoped<ITenantContext, ClaimTenantContext>();
builder.Services.AddScoped<TenantCache>();

var app = builder.Build();

app.MapGet("/products/{id:int}", async (int id, TenantCache cache) =>
    await cache.GetOrCreateAsync($"product:{id}",
        ct => ValueTask.FromResult($"product {id}")));

app.Run();
```

テナントは信頼できる情報源から取得し、クライアントが操作できるヘッダーやクエリ文字列からは決して取得しないでください。ここでは、認証済みユーザーのクレームから取得しています。

```csharp
// .NET 10, C# 14
public interface ITenantContext { string TenantId { get; } }

public sealed class ClaimTenantContext(IHttpContextAccessor accessor) : ITenantContext
{
    public string TenantId =>
        accessor.HttpContext?.User.FindFirst("tenant_id")?.Value
        ?? throw new InvalidOperationException("No tenant on this request.");
}
```

重要なのは、アプリケーションコードが生のキャッシュキーを決して組み立てないことです。毎回テナントを付加するスコープ付きラッパーを経由させることで、開発者がテナントを付け忘れることがなくなります。

```csharp
// .NET 10, C# 14, Microsoft.Extensions.Caching.Hybrid 10.10.0
public sealed class TenantCache(HybridCache cache, ITenantContext tenant)
{
    private string Key(string key) => $"t:{tenant.TenantId}:{key}";
    private string TenantTag => $"tenant:{tenant.TenantId}";

    public ValueTask<T> GetOrCreateAsync<T>(
        string key,
        Func<CancellationToken, ValueTask<T>> factory,
        HybridCacheEntryOptions? options = null,
        IEnumerable<string>? tags = null,
        CancellationToken ct = default) =>
        cache.GetOrCreateAsync(
            Key(key),
            factory,
            static (f, c) => f(c),
            options,
            [TenantTag, .. (tags ?? []).Select(t => $"{TenantTag}:{t}")],
            ct);

    public ValueTask RemoveAsync(string key, CancellationToken ct = default) =>
        cache.RemoveAsync(Key(key), ct);

    // logical wipe of everything this tenant cached
    public ValueTask InvalidateTenantAsync(CancellationToken ct = default) =>
        cache.RemoveByTagAsync(TenantTag, ct);
}
```

Redis では、テナント 42 の商品エントリは `myapp:t:42:product:7` というハッシュになります。タグにもプレフィックスを付けています。`HybridCache` のタグはグローバルな文字列なので、プレフィックスなしの `RemoveByTagAsync("products")` をあるテナントが呼ぶと、すべてのテナントの商品エントリが無効になってしまうからです。

カウンター、ロック、セットなどで `IDatabase` を直接使う場合は、StackExchange.Redis に `StackExchange.Redis.KeyspaceIsolation` として同じ仕組みが組み込まれています。

```csharp
// StackExchange.Redis 3.3.1
using StackExchange.Redis.KeyspaceIsolation;

IDatabase tenantDb = mux.GetDatabase().WithKeyPrefix($"myapp:t:{tenantId}:");
await tenantDb.StringIncrementAsync("logins"); // writes myapp:t:42:logins
```

## 議論に決着をつける L1 の問題

どの方式を選んでもプレフィックスが必須になる理由が、この点です。`HybridCache` は 2 層のキャッシュで、その L1 はプロセス内のすべてのリクエストで共有されるインプロセスの `MemoryCache` です。テナント 42 を専用の Redis インスタンスにルーティングしつつ、キャッシュキーを単なる `product:7` のままにしたとします。L2 の参照は正しいサーバーに向かいますが、L1 の参照が先に行われ、テナント 41 の `product:7` がすでにメモリ上にあります。テナント 42 はテナント 41 の商品を受け取ってしまいます。

つまり、別データベースや別インスタンスにしても、テナント単位のキーが不要になるわけではありません。どのみち作らなければならない仕組みの上に、2 つ目の分離機構が加わるだけです。プレフィックスがある以上、残る問いは、一部のテナントにキー単位の分離以上のものが必要かどうかだけです。

出力キャッシュにも同じことが当てはまります。`AddStackExchangeRedisOutputCache` には独自の `InstanceName` があり、エントリの保存先がどこであっても、キャッシュキーはテナントごとに変化させる必要があります (テナントのクレームに対する `VaryByValue`)。

## 別インスタンスが適切な場面

テナントごとに Redis を分けるのは既定の選択ではありませんが、正当な階層です。次の場合に選んでください。

- **契約または規制で求められている場合。** 特定リージョンでのデータレジデンシー、顧客管理の暗号化キー、エンタープライズ契約での "no shared infrastructure" などです。物理的な分離を求める監査人に対して、キープレフィックスでは要件を満たせません。
- **1 つのテナントのワークロードが他に害を及ぼすほど大きい場合。** 40 GB のホットデータを持つテナントや、バースト的なバッチジョブがあるテナントは、共有の `maxmemory` 上で他のテナントのキーを追い出します。そのテナントを外に出せば、残りのテナントのヒット率が予測可能な状態に戻ります。
- **テナントごとのエビクションポリシーや永続化が必要な場合。** `maxmemory-policy`、AOF、RDB の設定はサーバー全体に適用されます。
- **テナントのオフボーディングが完全であることを証明する必要がある場合。** インスタンスを削除したことは、"we scanned and deleted every key" よりも証明しやすくなります。

典型的な構成は、プール型にプレミアムなサイロ型を組み合わせたものです。全員が共有のプレフィックス付きインスタンスを使い、少数のテナントだけを専用インスタンスにマッピングします。`AddHybridCache()` が配線する L2 はちょうど 1 つなので、ルーティングは呼び出しごとにバックエンドを選ぶ `IDistributedCache` の中に置く必要があります。

```csharp
// .NET 10, C# 14, Microsoft.Extensions.Caching.StackExchangeRedis 10.0.12
using System.Collections.Concurrent;
using Microsoft.Extensions.Caching.Distributed;
using Microsoft.Extensions.Caching.StackExchangeRedis;

public sealed class TenantRoutingCache(
    IHttpContextAccessor accessor,
    IConfiguration config,
    [FromKeyedServices("shared")] IDistributedCache shared) : IDistributedCache
{
    private readonly ConcurrentDictionary<string, IDistributedCache> _dedicated = new();

    private IDistributedCache Current()
    {
        var tenant = accessor.HttpContext?.User.FindFirst("tenant_id")?.Value;
        var cs = tenant is null ? null : config[$"Tenants:{tenant}:Redis"];
        if (cs is null) return shared;

        return _dedicated.GetOrAdd(tenant!, _ => new RedisCache(
            new RedisCacheOptions { Configuration = cs, InstanceName = "myapp:" }));
    }

    public byte[]? Get(string key) => Current().Get(key);
    public Task<byte[]?> GetAsync(string key, CancellationToken token = default) =>
        Current().GetAsync(key, token);
    public void Set(string key, byte[] value, DistributedCacheEntryOptions options) =>
        Current().Set(key, value, options);
    public Task SetAsync(string key, byte[] value, DistributedCacheEntryOptions options,
        CancellationToken token = default) => Current().SetAsync(key, value, options, token);
    public void Refresh(string key) => Current().Refresh(key);
    public Task RefreshAsync(string key, CancellationToken token = default) =>
        Current().RefreshAsync(key, token);
    public void Remove(string key) => Current().Remove(key);
    public Task RemoveAsync(string key, CancellationToken token = default) =>
        Current().RemoveAsync(key, token);
}
```

共有の `RedisCache` をキー付きサービスとして登録し、ルーターを `HybridCache` が解決するキーなしの `IDistributedCache` として登録してください。キーには引き続き `TenantCache` によるテナントプレフィックスが付くため、L1 は安全に保たれます。このルーターについて知っておくべき点が 2 つあります。1 つ目は `HttpContext` に依存するため、バックグラウンドジョブでは別の方法でテナントを確立する必要があることです (ジョブランナーが設定する `AsyncLocal` で対応できます)。2 つ目は基底インターフェースしか実装していないため、`RedisCache` の `IBufferDistributedCache` による高速パスを使えないことです。少数のプレミアムテナントであれば、このトレードオフは許容できます。

専用の `RedisCache` はそれぞれマルチプレクサーを 1 つ保持します。マルチプレクサーは共有して長期間使うことを前提に設計されているので、これらのインスタンスはプロセスの存続期間中キャッシュし、リクエストごとに作成しないでください。専用テナントが 20 個、アプリの Pod が 10 個あれば、Redis への接続が追加で 200 本になります。ここがテナントごとのインスタンスモデルのスケールの限界であり、既定ではなく 1 つの階層にとどめるべき理由です。

## キープレフィックスの注意点

**プレフィックスは必ず区切り文字で終わらせてください。** `RedisCache` は `InstanceName` とキーを区切り文字なしで連結します。[HybridCache のキーに関するガイダンス](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/hybrid)に典型的な例があります。`order{customerId}{orderId}` とすると、顧客 42 の注文 123 と顧客 421 の注文 23 がどちらも `order42123` になります。テナントでも同じことが起こります。`t{tenant}{key}` と書くと、テナント `7` とキー `42:profile`、テナント `74` とキー `2:profile` が衝突します。`t:{tenant}:` を使い、テナント ID に `:` が含まれないようにしてください。

**テナントのキーの削除はコマンド 1 つではなく、スキャンです。** `RemoveByTagAsync($"tenant:{id}")` は手軽な方法ですが、論理的な無効化にすぎません。ドキュメントによると、値は "until they expire in the usual way" Redis に残ります。データを物理的に削除しなければならない場合 (オフボーディングや GDPR による消去)、すべてのプライマリをスキャンします。

```csharp
// StackExchange.Redis 3.3.1
public static async Task<long> PurgeTenantAsync(IConnectionMultiplexer mux, string tenantId)
{
    var db = mux.GetDatabase();
    long deleted = 0;
    foreach (var endpoint in mux.GetEndPoints())
    {
        var server = mux.GetServer(endpoint);
        if (server.IsReplica) continue;

        await foreach (var key in server.KeysAsync(pattern: $"myapp:t:{tenantId}:*", pageSize: 500))
        {
            // one DEL per key: in a cluster, keys from one node can span many hash slots
            if (await db.KeyDeleteAsync(key)) deleted++;
        }
    }
    return deleted;
}
```

`KeysAsync` は内部で `SCAN` を使い、クラスターでは対象ノード上のキーしか見えません。ループがすべてのエンドポイントを回しているのはそのためです。[StackExchange.Redis のドキュメント](https://seredis.dev/KeysScan)は、負荷の高い本番サーバーでの実行に対して今も注意を促しているので、控えめなページサイズでバックグラウンドジョブとして実行してください。

**テナントにハッシュタグを使わないでください。** キーを `{t:42}:product:7` のように書くと、テナントのすべてのキーが 1 つのハッシュスロットに入り、複数キーの操作が可能になる一方で、テナント全体が 1 つのシャードに固定されます。最大のテナントがホットシャードになります。クロスキーのトランザクションが本当に必要な場合を除き、テナントを波括弧の外に置いてください。

**テナントが Redis に直接アクセスする場合は ACL を追加してください。** 通常は自分のアプリだけが Redis と通信するため、プレフィックスはコードレビューと `TenantCache` ラッパーで担保されます。テナント専用のワーカーに独自の認証情報を与える場合は、Redis 7 の ACL のキーパターンでサーバー側でもプレフィックスを強制できます。`ACL SETUSER tenant42 on >secret ~myapp:t:42:* +@read +@write`。

**プレフィックスの長さはすべてのキーのオーバーヘッドになります。** `myapp:t:` に GUID のテナント ID を加えると、実際のキーに入る前に 44 バイトになります。小さなエントリが数千万件あるキャッシュでは、これは無視できないメモリ量です。短い整数や base-36 のテナント ID にすればオーバーヘッドはごくわずかで、`HybridCache` の `MaximumKeyLength` である 1024 文字からも大きく離れていられます。

## 推奨と、その理由

共有 Redis 上でキープレフィックスを使ってください。ローカルコンテナーから OSS クラスタリングの Azure Managed Redis まで、あらゆるトポロジーで動作し、1 回の `AddHybridCache()` 呼び出しと組み合わせられる唯一の選択肢であり、共有 L1 のためにどのみちテナントをキーに含める必要があります。契約やワークロードの面で分離にコストをかける価値のあるテナントには、上記のような `IDistributedCache` 経由でルーティングする専用インスタンスの階層を追加してください。Valkey 9.1 以降に腰を据えると決めていない限り、番号付きデータベースは避けましょう。`FLUSHDB` と `INFO keyspace` のデータベースごとのキー数は得られますが、メモリと CPU は他のすべてのテナントと共有したままで、クラスター構成やエンタープライズ版の Redis に移った瞬間に使えなくなります。

## 関連記事

- [How to use HybridCache in ASP.NET Core 11 with Redis as the L2 cache](/ja/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/) では、この記事の土台となる基本的な構成を扱っています。
- [HybridCache vs IMemoryCache vs IDistributedCache in .NET 11](/ja/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/) では、テナントキーが必須になる L1/L2 の分離について説明しています。
- [Output caching in a minimal API](/ja/2026/07/how-to-add-output-caching-to-a-minimal-api-in-aspnetcore-11/) では、テナントごとの出力キャッシュエントリのための `VaryByValue` を紹介しています。
- [Keyed services in .NET dependency injection](/ja/2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection/) は、共有キャッシュとルーティングキャッシュを並べて登録する方法です。
- [Named query filters in EF Core 11](/ja/2026/07/named-query-filters-vs-a-single-global-query-filter-in-ef-core-11/) は、テナント分離をデータベース側で行う場合の対となる記事です。

## 参考資料

- [Redis `SELECT` command](https://redis.io/docs/latest/commands/select/): クラスターと Redis Software に関する注記を含みます。
- [Azure Managed Redis architecture](https://learn.microsoft.com/en-us/azure/redis/architecture): クラスタリングとクラスターポリシーの詳細です。
- [Valkey `ACL SETUSER`](https://valkey.io/commands/acl-setuser/): キーパターンと 9.1 の `db=` ルールについてです。
- [RedisCacheOptions.cs](https://github.com/dotnet/aspnetcore/blob/main/src/Caching/StackExchangeRedis/src/RedisCacheOptions.cs) と [RedisCache.cs](https://github.com/dotnet/aspnetcore/blob/main/src/Caching/StackExchangeRedis/src/RedisCache.cs): `InstanceName` とデータベースがどう適用されるかを確認できます。
- [HybridCache library in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/hybrid): キーに関するガイダンスとタグによる無効化の仕様です。
- [StackExchange.Redis: KEYS, SCAN, FLUSHDB etc](https://seredis.dev/KeysScan): クラスターでのスキャンについてです。
