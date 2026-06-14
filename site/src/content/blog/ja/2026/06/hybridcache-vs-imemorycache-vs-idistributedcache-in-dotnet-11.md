---
title: ".NET 11 における HybridCache vs IMemoryCache vs IDistributedCache: どれを選ぶべきか？"
description: ".NET 11 の新しいキャッシュコードでは、デフォルトで HybridCache を使ってください。IMemoryCache はシリアライズ不要で単一サーバーの速度が必要なときだけ、IDistributedCache はバッキングストアとしてのみ選びます。これが判断のためのマトリクスです。"
pubDate: 2026-06-14
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "aspnetcore"
  - "caching"
  - "performance"
lang: "ja"
translationOf: "2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-06-14
---

.NET 11 の新しいキャッシュコードでは、デフォルトで `HybridCache` を使ってください。`IMemoryCache` のインプロセスの速度、`IDistributedCache` のサーバー間のリーチ、そしてどちらの旧来の API も持たないキャッシュスタンピード保護とタグによる無効化を、すべて 1 回の `GetOrCreateAsync` 呼び出しの背後で提供します。素の `IMemoryCache` を選ぶのは、シリアライズなしで単一サーバーのレイテンシと、きめ細かい削除制御が必要なときだけにしてください。素の `IDistributedCache` を選ぶのは、主に L1 層なしの分散ストアが必要なとき（または `HybridCache` のバッキング層として）です。この記事では、その推奨を完全な機能マトリクス、実際に効いてくる API の違い、そしてあなたの代わりに判断を下す決め手で裏付けます。

ここで扱う内容はすべて .NET 11、ASP.NET Core 11、C# 14 を対象としています。`HybridCache` は `Microsoft.Extensions.Caching.Hybrid` パッケージで提供され、これは .NET 9 とともに GA となり、.NET 11 で使うものと同じパッケージです。.NET Framework 4.7.2 や .NET Standard 2.0 までのランタイムをサポートするため、以下の比較は最新の TFM に限定されません。

## 機能マトリクス

| 機能                            | IMemoryCache              | IDistributedCache               | HybridCache                          |
| ------------------------------- | ------------------------- | ------------------------------- | ------------------------------------ |
| 層                              | L1（インプロセス）        | L2（アウトオブプロセス）        | L1 + オプションの L2                 |
| サーバー間で共有                | いいえ                    | はい                            | はい（L2 経由）                      |
| プロセス再起動を生き延びる      | いいえ                    | はい                            | L2 は生き延び、L1 は生き延びない     |
| 格納形式                        | 生のオブジェクト          | `byte[]`                        | L1 ではオブジェクト、L2 ではシリアライズ済み |
| シリアライズ                    | なし                      | 自分で書く                      | 組み込み（`System.Text.Json` ほか）  |
| キャッシュスタンピード保護      | なし                      | なし                            | あり                                 |
| タグによる無効化                | なし                      | なし                            | あり（`RemoveByTagAsync`）           |
| 1 回の呼び出しで取得または生成  | 拡張のみ、ガードなし      | なし                            | あり（`GetOrCreateAsync`）           |
| エントリ単位の有効期限制御      | 完全                      | 絶対 + スライディング           | 全体 + ローカル（`LocalCacheExpiration`） |
| 組み込みの OpenTelemetry メトリクス | あり（.NET 11）        | バックエンド次第                | あり                                 |
| 標準同梱（NuGet 不要）          | はい                      | 抽象はあり、バックエンドはなし  | いいえ（1 パッケージ）               |
| 最小ランタイム                  | 広い                      | 広い                            | .NET Framework 4.7.2 / netstandard2.0 |

3 つとも DI 経由で登録され、インターフェース（`HybridCache` の場合は抽象クラス）で解決されます。重要な違いは登録にあるのではなく、キャッシュミス時と並行アクセス下で各々が何をするかにあります。

## 各 API が実際に何であるか

`IMemoryCache` は、生のオブジェクト参照をプロセス内の `ConcurrentDictionary` ベースのストアに格納します。シリアライズはありません。`Customer` を入れれば、同じ `Customer` 参照が返ってきます。これにより 3 つの中で最速になり、キャッシュヒットが本質的に辞書の参照のコストで済む唯一のものになります。代償は、プロセス単位であることです。ロードバランサーの背後にある 2 つのインスタンスは 2 つの独立したキャッシュを持ち、再起動すると空になります。

```csharp
// .NET 11, C# 14
builder.Services.AddMemoryCache();

public class ProductService(IMemoryCache cache, ProductDb db)
{
    public Task<Product> GetAsync(int id) =>
        cache.GetOrCreateAsync($"product:{id}", entry =>
        {
            entry.AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(5);
            return db.LoadProductAsync(id);
        })!;
}
```

`IDistributedCache` は、アウトオブプロセスのストアに対する意図的に低レベルな抽象です。その表面は `GetAsync`、`SetAsync`、`RefreshAsync`、`RemoveAsync`（および同期版）で、すべての値は `byte[]` です。`GetOrCreate` はなく、オブジェクトモデルもなく、並行制御もありません。シリアライズ、キー命名、有効期限ポリシー、リードスルーのパターンは自分で担います。

```csharp
// .NET 11, C# 14
builder.Services.AddStackExchangeRedisCache(o =>
    o.Configuration = builder.Configuration.GetConnectionString("Redis"));

public class ProductService(IDistributedCache cache, ProductDb db)
{
    public async Task<Product> GetAsync(int id)
    {
        var key = $"product:{id}";
        var bytes = await cache.GetAsync(key);
        if (bytes is not null)
            return JsonSerializer.Deserialize<Product>(bytes)!;

        var product = await db.LoadProductAsync(id);
        await cache.SetAsync(key, JsonSerializer.SerializeToUtf8Bytes(product),
            new DistributedCacheEntryOptions
            {
                AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(5)
            });
        return product;
    }
}
```

これはキャッシュする値ごとに約 15 行のボイラープレートであり、コピーするたびに有効期限を忘れたり、null の扱いを誤ったり、わずかに異なるシリアライザーを選んだりする機会になります。組み込みの実装には、インメモリ（`AddDistributedMemoryCache`。実際には分散ではないため、開発とテスト専用）、Redis（`AddStackExchangeRedisCache`）、SQL Server（`AddDistributedSqlServerCache`）、Azure Cache for Redis、NCache などのサードパーティストアが含まれます。

`HybridCache` は、上記の 2 つのパターンを 1 つにまとめるために Microsoft が追加した抽象です。インプロセスの L1（デフォルトでは `MemoryCache`）を保持し、`IDistributedCache` を登録していれば、それを自動的に L2 として使います。`GetOrCreateAsync` の呼び出しは L1、次に L2 を確認し、それからファクトリを実行して両方の層に書き戻します。望まない限り、シリアライズに触れることはありません。

```csharp
// .NET 11, C# 14
builder.Services.AddHybridCache();
// If an IDistributedCache is also registered, it becomes the L2 automatically.

public class ProductService(HybridCache cache, ProductDb db)
{
    public ValueTask<Product> GetAsync(int id, CancellationToken ct = default) =>
        cache.GetOrCreateAsync(
            $"product:{id}",
            async token => await db.LoadProductAsync(id, token),
            cancellationToken: ct);
}
```

`IDistributedCache` のブロックと同じ結果が、15 行ではなく 3 行で、キャッシュスタンピード保護と、自分で配線しなくてよい L1 層付きで得られます。

## IMemoryCache を直接選ぶとき

- **再起動後のデータの再計算が安価な、単一サーバーまたはノード単位のキャッシュ。** プロセスごとに 1 回読み込むルックアップテーブル、パース済みの設定、レートリミッターのバケットなど。これらをアウトオブプロセスでシリアライズする利点はありません。.NET 11 の新しい組み込み OpenTelemetry メーターと組み合わせれば、独自のポーラーなしでヒット率と削除のメトリクスを引き続き得られます。これは [.NET 11 の MemoryCache メトリクスの記事](/ja/2026/06/dotnet-11-memorycache-opentelemetry-metrics/) で解説しています。
- **1 回のシリアライズすら多すぎるホットパス。** `IMemoryCache` は生のオブジェクトを返すため、ヒットは辞書の読み取りです。1 台のマシンで毎秒数千回読まれる値をキャッシュしているなら、これは重要です。これは、[EF Core のホットパス向けコンパイル済みクエリ](/ja/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) でクエリプランを常駐させるのと同じ理屈です。
- **`HybridCache` が公開していない削除機能が必要なとき。** サイズベースの上限（`SizeLimit` とエントリ単位の `Size`）、削除の優先度、`PostEvictionCallbacks` は `IMemoryCache` の概念です。`HybridCache` はこれらを API で公開していません。

直接行くことで受け入れる落とし穴: `IMemoryCache` の `GetOrCreateAsync` はスタンピードガードのない拡張メソッドです。コールドキャッシュのバースト下では、並行する各呼び出し元がファクトリを実行します。

## IDistributedCache を直接選ぶとき

- **共有ストアは必要だが、明示的に L1 層を望まないとき。** すべてのノードが変更の瞬間に同じ値を見ることに正しさが依存するなら、独自の有効期限を持つインプロセスの L1 は負債です。キーを無効化しても他サーバーの L1 には届かないからです（詳細は後述）。Redis に直接行けば、L1 が持ち込む陳腐化のウィンドウがなくなります。
- **実際にはキャッシュしていないとき。** `IDistributedCache` は ASP.NET Core のセッション状態を支え、Data Protection のキーを保持できます。これらはストレージのユースケースであってリードスルーキャッシュではなく、`HybridCache` はそれらに対して形が合いません。
- **シリアライズされたバイトを完全に制御する必要があるとき。** 独自のバイナリ形式、自分で管理する圧縮、同じ Redis キーを読む別システムとの相互運用など。`HybridCache` は独自のシリアライザーを受け取れますが、バイトが契約そのものであるなら、より低レベルの API のほうが正直です。

## HybridCache を選ぶとき（デフォルト）

- **1 インスタンスを超えてスケールしうるアプリにおける、あらゆる新しいリードスルーキャッシュ。** 今日は L1 の速度を得て、Redis キャッシュを登録した瞬間に L2 の正しさを得られます。呼び出し箇所のコードは変更不要です。これはまさに [HybridCache を Redis を L2 キャッシュとして使う](/ja/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/) で説明した構成です。
- **キャッシュスタンピードが害になるあらゆる場所。** `HybridCache` は、あるキーについて並行する呼び出し元のうち 1 つだけがファクトリを実行し、残りはその単一の結果を待つことを保証します。100 件のリクエストに叩かれたコールドキャッシュは、バッキングのクエリを 100 回ではなく 1 回だけ発行します。これは [EF Core 11 における N+1 クエリの検出](/ja/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) で追い込むのと同じ問題です。
- **グループ単位の無効化が欲しいとき。** 一連のエントリにタグを付け（`tags: ["product", $"category:{categoryId}"]`）、`RemoveByTagAsync("category:42")` でまとめて削除します。旧来の API はどちらもタグの概念を持ちません。

## スタンピードのベンチマーク、具体的に

これは本番で表面化する違いなので、主張するのではなく測定する価値があります。200 ms のデータベース読み取りを模したファクトリを用意し、コールドキャッシュに対して同じキーで `GetOrCreateAsync` を 100 件並行で発行します。

```csharp
// .NET 11, BenchmarkDotNet 0.15.x style harness (simplified)
async Task<int> Factory(CancellationToken _)
{
    Interlocked.Increment(ref _factoryCalls);
    await Task.Delay(200);          // stand-in for a DB / HTTP round trip
    return 42;
}

var tasks = Enumerable.Range(0, 100)
    .Select(_ => hybrid.GetOrCreateAsync("k", Factory).AsTask());
await Task.WhenAll(tasks);
```

`HybridCache` では `_factoryCalls` は **1** です。1 つの呼び出し元が 200 ms のファクトリを実行し、残りの 99 はその結果を待つため、バースト全体がバッキング呼び出し 1 回でおよそ 200 ms で片づきます。`IMemoryCache` の `GetOrCreateAsync` 拡張メソッドに切り替えると `_factoryCalls` は最大 **100** まで上がります。コールドミスした呼び出し元を直列化するものが何もないからです。実際のデータベースに対しては、これはクエリ 1 回と、コネクションプールに 100 件積み上がる詰まりとの違いです。`IMemoryCache` の場合の正確な件数はタイミングによって変わります（最初の書き込み完了後に到達する呼び出し元もありえます）が、それこそが要点です。それは上限がなく非決定的であるのに対し、`HybridCache` はそれを 1 に固定します。数値は .NET 11（11.0.x）、Windows 11、組み込みの L1 のみで L2 未構成で測定しました。

## 有効期限: オプション名の違いが効いてくる

3 つの API は有効期限の名前が異なり、それらを取り違えるのが最も多い構成のバグです。

`IMemoryCache` は `MemoryCacheEntryOptions` で `AbsoluteExpiration`、`AbsoluteExpirationRelativeToNow`、`SlidingExpiration` を使います。`IDistributedCache` は `DistributedCacheEntryOptions` で同じ 3 つの名前を使います。`HybridCache` は `HybridCacheEntryOptions` で、意味の異なる 2 つのプロパティを使います。

```csharp
// .NET 11, C# 14
var options = new HybridCacheEntryOptions
{
    Expiration = TimeSpan.FromMinutes(5),        // overall lifetime (drives L2)
    LocalCacheExpiration = TimeSpan.FromMinutes(1) // how long the L1 copy is trusted
};
```

`Expiration` はエントリの全体の有効期間で、L2 のコピーを支配します。`LocalCacheExpiration` は、エントリが L2 から再取得されるまで、インプロセスの L1 コピーがどれだけの間有効とみなされるかです。`LocalCacheExpiration` を `Expiration` より短く設定することが、マルチサーバー配置で L1 の陳腐化を抑える方法です。各ノードはローカルコピーを最大 1 分間だけ信頼し、その後で共有 L2 に対して再検証します。`HybridCache` にスライディング有効期限の概念はありません。スライディングウィンドウに依存しているなら、それはより低レベルの API にとどまる理由になります。

知っておくべきその他のデフォルト: `HybridCacheOptions.MaximumPayloadBytes` のデフォルトは 1 MB、`MaximumKeyLength` は 1024 文字です。上限を超える値やキーはログに記録され、黙ってキャッシュされません。大きな blob をキャッシュする場合、これは静かな失敗モードになります。

## あなたの代わりに判断を下す決め手

`HybridCache` におけるタグおよびキーの無効化は、他サーバーの L1 に届きません。`RemoveByTagAsync` や `RemoveAsync` を呼ぶと、エントリはローカルの L1 と共有 L2 から削除されますが、他の各ノードは、そのコピーが自身の `LocalCacheExpiration` で期限切れになるまで、自分の L1 コピーを返し続けます。ドキュメントは明示しています。タグの無効化は、将来の読み取りをミスとして扱う論理的な操作であり、他のノードを能動的にパージするわけではありません。

このたった 1 つの挙動が、いくつかの設計を決めます。

- 限定された陳腐化のウィンドウを許容できるなら（`LocalCacheExpiration` を許容するウィンドウに設定）、`HybridCache` は理想的で、L1 の速度を保てます。
- どのウィンドウも許容できないなら（古い認可や価格の値が正しさのバグになるため）、L1 層は誤った道具であり、`IDistributedCache` に直接行くべきです（あるいは `LocalCacheExpiration` をゼロに設定しますが、それは L1 の目的をほぼ無効にします）。

もう 1 つの決定要因は **シリアライズの安全性** です。`HybridCache` は、`IDistributedCache` のスレッドセーフ保証を維持するため、デフォルトで呼び出し元ごとに新しいオブジェクトをデシリアライズします。キャッシュする型がイミュータブルなら、型を sealed にして `[ImmutableObject(true)]` を適用することでインスタンスの再利用を選択でき、呼び出しごとのデシリアライズのオーバーヘッドを取り除けます。キャッシュするオブジェクトがミュータブルで共有されているなら、その属性は適用しないでください。さもないと競合状態を持ち込みます。

## 推奨、あらためて

.NET 11 では、それをしない特定の理由がない限り、新しいキャッシュコードは `HybridCache` に対して書いてください。これは旧来の両 API のほぼドロップイン置換であり、`IDistributedCache` が強いる cache-aside のボイラープレートを取り除き、ガードのない `IMemoryCache.GetOrCreateAsync` が残すスタンピードの穴を塞ぎます。単一サーバーの速度、ゼロシリアライズ、または `HybridCache` が公開しない削除機能（サイズ上限、優先度、削除コールバック）が必要なときは、素の `IMemoryCache` に降りてください。L1 の陳腐化ウィンドウのない共有ストアが必要なとき、シリアライズされたバイトが別システムとの契約であるとき、あるいはキャッシュではなくセッションやキーの保存に使うときは、素の `IDistributedCache` に降りてください。その中間のすべて、つまりほとんどのキャッシュでは、`HybridCache` が答えです。

## 関連

- [ASP.NET Core 11 で HybridCache を Redis を L2 キャッシュとして使う方法](/ja/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/)
- [.NET 11 が MemoryCache に第一級の OpenTelemetry メトリクスを与える](/ja/2026/06/dotnet-11-memorycache-opentelemetry-metrics/)
- [EF Core 11 で N+1 クエリを検出する方法](/ja/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [EF Core のホットパスでコンパイル済みクエリを使う方法](/ja/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)

## 出典

- [ASP.NET Core の HybridCache ライブラリ（Microsoft Learn）](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/hybrid?view=aspnetcore-10.0)
- [ASP.NET Core の分散キャッシュ（Microsoft Learn）](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/distributed?view=aspnetcore-10.0)
- [ASP.NET Core のインメモリキャッシュ（Microsoft Learn）](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/memory?view=aspnetcore-10.0)
- [Hello HybridCache!（Microsoft .NET ブログ、GA 発表）](https://devblogs.microsoft.com/dotnet/hybrid-cache-is-now-ga/)
- [ASP.NET Core のキャッシュの概要（Microsoft Learn）](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/overview?view=aspnetcore-10.0)
