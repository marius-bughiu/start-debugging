---
title: "ASP.NET Core 11 で Redis を L2 キャッシュとして HybridCache を使う方法"
description: "ASP.NET Core 11 で HybridCache を Redis の L2 に接続します。サービスを登録し、StackExchange Redis の分散キャッシュを追加すれば、GetOrCreateAsync がスタンピード保護とタグ無効化を組み込んだ 2 階層キャッシュを提供します。"
pubDate: 2026-06-07
template: how-to
tags:
  - "aspnetcore"
  - "dotnet"
  - "performance"
lang: "ja"
translationOf: "2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache"
translatedBy: "claude"
translationDate: 2026-06-07
---

ASP.NET Core 11 で Redis を第 2 階層のキャッシュとして HybridCache を使うには、`Microsoft.Extensions.Caching.Hybrid` をインストールし、`builder.Services.AddHybridCache()` を呼び出してから、`AddStackExchangeRedisCache(...)` で Redis を裏付けとする `IDistributedCache` を登録します。HybridCache はその `IDistributedCache` を自動的に L2 として取り込みます。これ以降、`GetOrCreateAsync` の各呼び出しはまず L1 (プロセス内メモリ) を読み、L2 (Redis) にフォールバックし、完全なミスのときだけファクトリを呼び出します。スタンピード保護とタグベースの無効化が、cache-aside のボイラープレートなしで無料で手に入ります。この記事では、完全なセットアップ、本当に重要なオプション、そして多くの人がつまずく複数インスタンスの落とし穴を順を追って説明します。

すべての例は .NET 11、ASP.NET Core 11、C# 14 を対象とし、`Microsoft.Extensions.Caching.Hybrid` 9.x を使用します (このパッケージは .NET 9 で GA となり、.NET 11 で使うのも同じパッケージです)。ライブラリ自体は .NET Framework 4.7.2 や .NET Standard 2.0 までのランタイムをサポートしているため、同じコードが古いホストでも動作します。

## HybridCache が存在する理由

分散キャッシュを出荷したことがあるなら、このループを手で書いたことがあるはずです。`IMemoryCache` を確認し、ミス、`IDistributedCache` (Redis) を確認し、ミス、デシリアライズし、データベースを呼び出し、シリアライズし、両方の層に書き戻し、返す。これをキャッシュする値ごとに掛け算すると、ほぼ同一の cache-aside コードの山ができあがり、コピーごとに独自の微妙なバグを抱えます。古典的なバグは 2 つあります。スタンピードガードの欠如 (100 件のリクエストが期限切れのキーに同時に当たり、すべてがデータベースをたたく) と、2 つの層の間でのシリアライズの不整合です。

HybridCache はそのすべてを 1 回の呼び出しにまとめます。これは 2 階層キャッシュです。L1 はプロセス内の `MemoryCache` (高速、サーバーごと、再起動で失われる) で、L2 は登録した任意の `IDistributedCache` (Redis、SQL Server、Postgres、Garnet) です。この記事の要点は次のとおりです。L2 を HybridCache に直接構成するわけではありません。HybridCache は依存性注入コンテナーから `IDistributedCache` を見つけ出します。Redis の分散キャッシュを登録すれば、HybridCache はそれを自動的に L2 として使用します。

## Redis を L2 キャッシュとして接続する

ここでは、エンドツーエンドのセットアップを番号付きの手順として示します。

1. 2 つのパッケージをインストールします。1 つ目は HybridCache を持ち込み、2 つ目は StackExchange ベースの Redis 用 `IDistributedCache` です。

   ```dotnetcli
   dotnet add package Microsoft.Extensions.Caching.Hybrid
   dotnet add package Microsoft.Extensions.Caching.StackExchangeRedis
   ```

2. Redis の接続文字列を構成に保存します。開発環境では user-secrets ファイルを使ってバージョン管理の外に置いてください。

   ```json
   {
     "ConnectionStrings": {
       "RedisConnectionString": "localhost:6379"
     }
   }
   ```

3. Redis の `IDistributedCache` を登録します。これが L2 です。`AddStackExchangeRedisCache` は、あなたの Redis インスタンスを裏付けとする `IDistributedCache` を依存性注入に配置します。

   ```csharp
   // .NET 11, ASP.NET Core 11, C# 14
   var builder = WebApplication.CreateBuilder(args);

   builder.Services.AddStackExchangeRedisCache(options =>
   {
       options.Configuration =
           builder.Configuration.GetConnectionString("RedisConnectionString");
   });
   ```

4. HybridCache を登録します。手順 3 の `IDistributedCache` を見つけ、それを L2 として使用します。`IDistributedCache` が登録されていなくても、HybridCache は L1 のみのプロセス内キャッシュとして動作するため、この 1 行が 2 階層の動作を「オンにする」唯一のものです。

   ```csharp
   // .NET 11, ASP.NET Core 11
   builder.Services.AddHybridCache();

   var app = builder.Build();
   ```

これで配線はすべて完了です。手順 3 と 4 の間で順序は問題になりません。なぜなら、依存性注入は HybridCache が初めて必要としたときに `IDistributedCache` を遅延解決するからです。HybridCache に `UseRedis()` の呼び出しはなく、Redis を指す L2 設定もありません。検出は `IDistributedCache` を通じて暗黙的に行われ、これこそが、同じ HybridCache のコードが Redis、SQL Server、あるいは L2 なしに対して、1 行も変えずに動作する理由です。

## GetOrCreateAsync での読み書き

`GetOrCreateAsync` は、95% の場面で使う API です。`HybridCache` を注入し、キーとファクトリを渡して呼び出します。

```csharp
// .NET 11, C# 14
public sealed class ProductService(HybridCache cache, ProductDbContext db)
{
    public async Task<Product?> GetProductAsync(int id, CancellationToken ct = default)
    {
        return await cache.GetOrCreateAsync(
            $"product:{id}",                       // unique cache key
            async cancel => await db.Products
                .AsNoTracking()
                .FirstOrDefaultAsync(p => p.Id == id, cancel),
            cancellationToken: ct);
    }
}
```

`product:42` への最初の呼び出しでは、HybridCache は L1 をミスし、L2 をミスし、ファクトリを実行し、結果をシリアライズして Redis とプロセス内キャッシュの両方に書き込み、返します。同じサーバー上の次の呼び出しは L1 にヒットし、Redis には一切触れません。クラスター内の別のサーバーでの呼び出しは L1 をミスしますが L2 (Redis) にヒットするため、データベースをスキップして自分の L1 を埋め戻します。これが 2 階層の利点です。ホットなキーはプロセス内に留まり、ウォームなキーは Redis に留まり、データベースは両方の層がコールドなときだけミスを見ます。

呼び出しの内側に直接渡されている補間文字列に注目してください。ドキュメントは、キーをまずローカル変数に組み立てるのではなく、このようにインラインで書くことを推奨しています。これにより、ライブラリの将来のバージョンが場合によっては文字列の割り当てを回避できるようになるためです。`GetOrCreateAsync` には `state` のタプルと `static` ラムダを受け取る 2 つ目のオーバーロードもあり、これはホットパスでのクロージャの割り当てを回避します。

```csharp
// .NET 11, C# 14 - allocation-conscious overload
return await cache.GetOrCreateAsync(
    $"product:{id}",
    (db, id),
    static async (state, cancel) => await state.db.Products
        .AsNoTracking()
        .FirstOrDefaultAsync(p => p.Id == state.id, cancel),
    cancellationToken: ct);
```

既定では状態なしのオーバーロードを使ってください。状態ありのほうに頼るのは、クロージャの割り当てが効いているとプロファイラーが告げたときだけにします。データベースの往復のコストと比べれば、それはまれです。

## スタンピード保護こそが本当に買っている機能

これは手で正しく実装するのが難しい部分です。人気のキーが期限切れになり、リクエストの急増が到来したとき、素朴な cache-aside は各リクエストをミスさせ、同時にファクトリを呼ばせます。HybridCache は、特定のサーバー上の特定のキーについて、ファクトリを実行する呼び出し元が 1 つだけであることを保証します。残りは同じ結果を待機します。

```csharp
// 100 concurrent requests for the same cold key
// -> exactly 1 factory invocation, 99 awaiters share the result
var tasks = Enumerable.Range(0, 100)
    .Select(_ => service.GetProductAsync(42, ct));
var results = await Task.WhenAll(tasks);
```

1 つの微妙な点があります。渡す `CancellationToken` は、キューに入っているすべての呼び出し元の結合されたキャンセルを表します。少なくとも 1 つの呼び出し元がまだ結果を欲しがっている限りファクトリは実行を続けるため、1 つのクライアントが切断しても、他のすべての人の共有作業はキャンセルされません。

正直な注意点です。この保護はインスタンスごとです。HybridCache は分散ロックを同梱していないため、3 台のサーバーのクラスターでは、コールドなキーが最大 3 回のファクトリ呼び出し (サーバーごとに 1 回) を引き起こす可能性があり、フリート全体で 1 回ではありません。ほとんどのワークロードではこれで問題ありません。クラスター全体での single-flight が本当に必要なら、外部の分散ロックか、その上に 1 つを重ねる FusionCache のようなサードパーティのキャッシュが必要です。「スタンピード保護」が「全サーバーで 1 回のデータベースクエリ」を意味すると思い込まないでください。

## 有効期限: あなたが制御する 2 つの時計

`HybridCacheEntryOptions` は 2 つの有効期限設定を公開しており、これらを混同するのが最もよくある構成ミスです。

- `Expiration` は、L2 (Redis) のコピーを含む全体の有効期間です。
- `LocalCacheExpiration` は、プロセス内 L1 の有効期間です。通常は `Expiration` より短くします。

```csharp
// .NET 11 - global defaults
builder.Services.AddHybridCache(options =>
{
    options.MaximumPayloadBytes = 1024 * 1024; // 1 MB, the default
    options.MaximumKeyLength = 1024;           // chars, the default
    options.DefaultEntryOptions = new HybridCacheEntryOptions
    {
        Expiration = TimeSpan.FromMinutes(5),       // L2 + overall
        LocalCacheExpiration = TimeSpan.FromMinutes(1) // L1 only
    };
});
```

`LocalCacheExpiration` を `Expiration` より短く保つのは意図的なパターンです。1 台のサーバーが自分のメモリから古いデータを提供できる時間を制限しつつ、サーバー間共有のために Redis が値をより長く保持できるようにします。短い L1 と長めの L2 を組み合わせると、1 台のサーバーの陳腐化ウィンドウは小さくなりますが、クラスター全体としては依然としてデータベースを回避します。`GetOrCreateAsync` に `HybridCacheEntryOptions` を渡すことで、これらの値を呼び出しごとに上書きできます。

`HybridCacheEntryOptions` の `Flags` プロパティを使うと、特定のエントリについて 1 つの層を無効化できます。たとえば、めったに読まれないが大きい値で L1 をスキップする `HybridCacheEntryFlags.DisableLocalCacheWrite`、あるいは何かをプロセス内だけに保つ `DisableDistributedCache` です。これらのオプションは外科的に使ってください。ほとんどのエントリでは既定値が正しいです。

## キーによる無効化とタグによる無効化

裏付けとなるデータが変わったら、エントリを追い出します。キーによる場合:

```csharp
await cache.RemoveAsync($"product:{id}", ct);
```

タグはより強力なツールです。エントリの作成時にタグを付け、それからグループ全体を 1 回の呼び出しで無効化します。

```csharp
// .NET 11, C# 14
public async Task<Product?> GetProductAsync(int id, CancellationToken ct = default)
{
    var options = new HybridCacheEntryOptions
    {
        Expiration = TimeSpan.FromMinutes(10),
        LocalCacheExpiration = TimeSpan.FromMinutes(2)
    };
    var tags = new[] { "products", $"category:{await GetCategoryAsync(id, ct)}" };

    return await cache.GetOrCreateAsync(
        $"product:{id}",
        async cancel => await db.Products
            .AsNoTracking()
            .FirstOrDefaultAsync(p => p.Id == id, cancel),
        options,
        tags,
        cancellationToken: ct);
}

// Invalidate every product in one category after a bulk price update
public ValueTask InvalidateCategoryAsync(int categoryId, CancellationToken ct = default)
    => cache.RemoveByTagAsync($"category:{categoryId}", ct);
```

これは、どのキーがどのグループに属するかを別の辞書で追跡する古いパターンを置き換えます。`RemoveByTagAsync("products")` は、`products` でタグ付けされたすべてを 1 回の呼び出しで無効化します。ワイルドカードがあります。`RemoveByTagAsync("*")` はキャッシュ全体を、タグのないエントリも含めて論理的に無効化します。glob マッチングはサポートされていないため、`RemoveByTagAsync("foo*")` で `foo` で始まるすべてを削除することはできません。

ここで人々を驚かせるニュアンスがあります。`IMemoryCache` も `IDistributedCache` もタグを理解しないため、タグの無効化は論理的な操作であって、物理的な削除ではありません。HybridCache は Redis に入り込んでタグ付けされたキーを削除したりしません。代わりに、そのタグが無効化されたことを記録し、そのタグを持つ任意のエントリを次に読むときに、その値をミスとして扱い、再取得します。バイトは自然に期限切れになるまで Redis とメモリに留まります。正しさの観点ではこれで問題ありません。Redis のメモリ会計の観点では、タグの無効化が直ちに領域を解放するわけではないことを意味します。

## 全員が陥る複数インスタンスの落とし穴

複数のサーバーを運用しているなら、これを 2 回読んでください。`RemoveAsync` または `RemoveByTagAsync` を呼び出すと、エントリは現在のサーバーと L2 (Redis) で無効化されます。他のサーバーの L1 (プロセス内メモリ) では無効化されません。それらの各サーバーは、そのコピーが `LocalCacheExpiration` を使い切るまで、自分のキャッシュコピーを提供し続けます。

つまり、5 台のサーバーがあり、サーバー A で `product:42` を削除しても、サーバー B から E は最大で `LocalCacheExpiration` の間、ローカルメモリから古い製品を返し続ける可能性があります。これが、明示的に無効化されるデータで `LocalCacheExpiration` を短く保つべき最も重要な理由です。ほぼ即時のサーバー間無効化が必要なら、自分でブロードキャストする必要があります。たとえば、各サーバーが自分の `RemoveAsync` を呼び出して処理する Redis の publish/subscribe メッセージです。HybridCache はこの伝播を標準で代行してくれません。

## シリアライズと大きなオブジェクト

L2 ストレージのために、値はシリアライズされる必要があります。HybridCache は `string` と `byte[]` を内部で扱い、それ以外はすべて既定で `System.Text.Json` を使います。`AddHybridCache` に連結することで、型固有のシリアライザーや汎用のシリアライザー (protobuf、MessagePack、XML) に差し替えられます。

```csharp
// .NET 11 - custom serializer for one type
builder.Services
    .AddHybridCache()
    .AddSerializer<Product, ProtobufProductSerializer>();
```

覚えておくべき 2 つの制限があります。`MaximumPayloadBytes` の既定値は 1 MB です。これより大きい値はログに記録され、暗黙のうちにキャッシュされないため、大きすぎるオブジェクトは常にファクトリにヒットする恒久的なミスになります。`MaximumKeyLength` の既定値は 1024 文字です。これより長いキーはキャッシュを完全にバイパスします。ユーザー入力からキーを構築する場合は、その長さを制限し、生のユーザー文字列をキーとして決して信頼しないでください。制限内に収めるためにも、キャッシュをあふれさせるサービス拒否攻撃を避けるためにも必要です。

キャッシュする型が不変なら、HybridCache に呼び出しごとの防御的なデシリアライズをスキップして共有インスタンスを渡すよう指示できます。これにより、大きいオブジェクトやホットなオブジェクトの CPU と割り当てを削減できます。型を `sealed` にして `[ImmutableObject(true)]` を適用します。

```csharp
// .NET 11, C# 14 - safe to reuse the same instance across callers
[ImmutableObject(true)]
public sealed record Product(int Id, string Name, decimal Price);
```

これは、オブジェクトが作成後に本当に決して変更されない場合にのみ行ってください。そうでなければ、既定の動作があなたを守ってくれている並行性のバグを再び招き入れることになります。Redis に関して言えば、`Microsoft.Extensions.Caching.StackExchangeRedis` パッケージは `IBufferDistributedCache` を実装でき、これにより HybridCache は L2 のパスで `byte[]` の割り当てを回避できます。スループットの高いサービスでは有効にする価値があります。

## すでに使っているものの隣で HybridCache がどこに収まるか

HybridCache は `IMemoryCache` や `IDistributedCache` を置き換えるものではなく、それらの上に位置して両方をオーケストレーションします。まだ `IMemoryCache` の上で手書きの cache-aside をしていたり、[.NET 11 が MemoryCache に与えた一級の OpenTelemetry メトリクス](/ja/2026/06/dotnet-11-memorycache-opentelemetry-metrics/) で説明されている新しい組み込みメーターでキャッシュヒット率を見ていたりするなら、HybridCache はプロセス内層と分散層を 1 つの一貫した API で結びつける層です。キャッシュもリトライも遅い依存関係を保護するので、[Polly と .NET 11 の組み込みレジリエンスハンドラーの比較](/ja/2026/05/polly-vs-resilience-handlers-in-dotnet-11/) のレジリエンスの話とも自然に組み合わさります。

キャッシュは、[EF Core 11 で N+1 クエリを検出する](/ja/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) で見られるクエリの問題に対する最も安価な解決策でもあります。クエリが正しくなったら、その結果をキャッシュすることでホットパスから外すことができ、これは [EF Core のホットパス向けのコンパイル済みクエリ](/ja/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) を補完します。そして L2 のシリアライズは既定で `System.Text.Json` を通るため、[System.Text.Json でカスタム JsonConverter を書く](/ja/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) と同じルールが、カスタムシリアライズを必要とするキャッシュ対象のあらゆるものに適用されます。

頭に留めておくべきメンタルモデルはこうです。HybridCache は、2 階層キャッシュ、サーバーごとのスタンピード保護、論理的なタグ無効化を、すべて `GetOrCreateAsync` の背後で提供します。`IDistributedCache` を登録した瞬間に Redis が L2 になります。HybridCache がやらない 2 つのこと、すなわちクラスター全体の single-flight とサーバー間の L1 無効化こそが、設計で回避すべき 2 つのことです。短い `LocalCacheExpiration` と、必要なら自前の publish/subscribe 無効化で対処してください。

## 出典

- [ASP.NET Core の HybridCache ライブラリ, Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/hybrid?view=aspnetcore-10.0)
- [Hello HybridCache! Streamlining Cache Management for ASP.NET Core Applications, .NET Blog](https://devblogs.microsoft.com/dotnet/hybrid-cache-is-now-ga/)
- [IBufferDistributedCache API リファレンス](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.caching.distributed.ibufferdistributedcache)
- [FusionCache の HybridCache 統合](https://github.com/ZiggyCreatures/FusionCache/blob/main/docs/MicrosoftHybridCache.md)
</content>
