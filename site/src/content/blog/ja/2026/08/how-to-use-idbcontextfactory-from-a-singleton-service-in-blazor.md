---
title: "Blazor のシングルトンサービスから IDbContextFactory<T> を使う方法"
description: "シングルトンは DbContext を注入できませんが、IDbContextFactory<T> なら注入できます。AddDbContextFactory がファクトリを既定でシングルトンとして登録するからです。呼び出しごとにコンテキストを生成して破棄し、インスタンスは決して保持しないでください。"
pubDate: 2026-08-16
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "blazor"
  - "ef-core"
  - "dependency-injection"
lang: "ja"
translationOf: "2026/08/how-to-use-idbcontextfactory-from-a-singleton-service-in-blazor"
translatedBy: "claude"
translationDate: 2026-08-16
---

シングルトンサービスはコンストラクタで `DbContext` を受け取れません。`AddDbContext<T>` はコンテキストを scoped として登録するため、ASP.NET Core のスコープ検証が起動時にそのキャプチャを拒否します。しかし `IDbContextFactory<T>` なら受け取れます。`AddDbContextFactory<T>` がファクトリを既定で**シングルトン**として登録するからです。ファクトリを注入し、各メソッドの中で `CreateDbContextAsync` を呼び、`await using` で包み、返されたコンテキストをフィールドに保存しないでください。この最後のルールがすべてです。Blazor のシングルトンはサーバー上のすべてのサーキットで共有されるため、キャッシュしたコンテキストには複数のユーザーから同時にアクセスが来て、EF Core は状態を壊すか例外を投げます。

本記事は .NET 11 と EF Core 11 を対象に書いています。`IDbContextFactory<T>` の登録形態は EF Core 5.0 以降変わっていないため、内容はそのまま .NET 6、8、10 にも当てはまります。以下の登録ダンプとエラーメッセージは、執筆時点でインストールしていたランタイムである .NET 10.0.201 SDK と `Microsoft.EntityFrameworkCore.Sqlite` 10.0.11 で取得したものです。

## Blazor のシングルトンが DbContext にとって最悪の状況である理由

サーバーサイド Blazor は接続中のユーザーごとに*サーキット*を保持します。このサーキットは長寿命の DI スコープが 1 つあるだけで、その寿命は HTTP リクエストではなくブラウザのタブと同じです。Blazor での EF Core に関する Microsoft 自身のガイダンスは、標準の 3 つのライフタイムがいずれも `DbContext` には不適切だと明言しています。シングルトンは全ユーザー間で 1 つのインスタンスを共有し、scoped は同一ユーザーのサーキット内の全コンポーネント間で 1 つのインスタンスを共有し、transient はそれを保持するコンポーネントと同じだけ生き続けるコンテキストを生みます。

3 つの中でシングルトンが最悪であり、しかも意図せずそこに行き着きやすいのです。カタログのキャッシュ、参照テーブルのサービス、マスタデータを更新する `IHostedService`、監査行を書き込む `IEmailSender`。いずれも自然にシングルトンになり、いずれもデータベースアクセスを必要とし、そしていずれも `DbContext` を保持できません。

素朴な書き方はスコープ検証が起動時に捕まえます。コンテキストを通常どおり登録してシングルトンに注入すると、`ValidateOnBuild` を有効にした `BuildServiceProvider` が失敗します。

```text
Error while validating the service descriptor 'ServiceType: BadWarmer Lifetime: Singleton
ImplementationType: BadWarmer': Cannot consume scoped service 'AppDb' from singleton 'BadWarmer'.
```

これは通常の ASP.NET Core アプリケーションで[シングルトンから scoped サービスを利用できないというエラー](/ja/2026/05/fix-cannot-consume-scoped-service-from-singleton/)を引き起こすのと同じ、キャプティブ依存関係のチェックです。ファクトリはそこから抜け出すための公式な手段です。

## AddDbContextFactory が実際に登録するもの

シングルトンがファクトリを注入できるのは慣習ではなく、宣言された既定値によるものです。シグネチャは次のとおりです。

```csharp
// EF Core 11, Microsoft.Extensions.DependencyInjection
public static IServiceCollection AddDbContextFactory<TContext>(
    this IServiceCollection serviceCollection,
    Action<DbContextOptionsBuilder>? optionsAction = null,
    ServiceLifetime lifetime = ServiceLifetime.Singleton)
    where TContext : DbContext;
```

`lifetime` の既定値は `ServiceLifetime.Singleton` で、これは「ファクトリ**とオプション**を登録する際のライフタイム」を制御します。`AddDbContextFactory<AppDb>` を 1 回呼んだときに追加されるサービスディスクリプタをダンプすると、形がはっきりします。

```text
Singleton  Microsoft.EntityFrameworkCore.DbContextOptions`1[AppDb]
Singleton  Microsoft.EntityFrameworkCore.DbContextOptions
Singleton  Microsoft.EntityFrameworkCore.Internal.IDbContextFactorySource`1[AppDb]
Singleton  Microsoft.EntityFrameworkCore.IDbContextFactory`1[AppDb]
Scoped     AppDb
```

注目すべき点が 2 つあります。

1 つ目に、`IDbContextFactory<AppDb>` はシングルトンなので、自作のシングルトンに注入してもスコープ検証を問題なく通過します。実際に解決される実装は EF Core 組み込みの `DbContextFactory<TContext>` です。

2 つ目に、これは意外に思われるのですが、`AddDbContextFactory` は**コンテキスト型そのものも scoped として登録します**。これは漏れではなく文書化された動作です。API の注釈にはこう明記されています。"For convenience, this method also registers the context type itself as a scoped service. This allows a context instance to be resolved from a dependency injection scope directly or created by the factory, as appropriate." つまり `AddDbContextFactory` を 1 回呼んだ後でも、`@inject AppDb Db` はコンパイルが通り、コンポーネント内で動作してしまいます。Blazor ではこれが罠になります。その scoped インスタンスはサーキットに紐づいており、タブ内のすべてのコンポーネントで共有されるからです。ファクトリを登録しても、誰かが間違った方法でコンテキストを注入するのを止めることはできません。

## 4 つのステップで組み立てる

1. `Program.cs` でファクトリを登録し、ライフタイムは既定のままにします。`ServiceLifetime.Scoped` は渡さないでください。これがこの仕組みを壊す最も一般的な原因です。

   ```csharp
   // .NET 11, EF Core 11
   builder.Services.AddDbContextFactory<CatalogDb>(options =>
       options.UseSqlServer(builder.Configuration.GetConnectionString("Catalog")));

   builder.Services.AddSingleton<CatalogCache>();
   ```

2. `AddDbContext` の場合とまったく同じように、コンテキストに `DbContextOptions<TContext>` を受け取るコンストラクタを用意します。ファクトリはこのコンストラクタ経由でオプションを渡すため、引数なしコンストラクタしか持たないコンテキストは生成に失敗します。

   ```csharp
   public sealed class CatalogDb(DbContextOptions<CatalogDb> options) : DbContext(options)
   {
       public DbSet<Product> Products => Set<Product>();
   }
   ```

3. シングルトンに `IDbContextFactory<TContext>` を注入し、メソッド呼び出しごとにコンテキストを 1 つ生成します。非同期の破棄がプロバイダー本来の経路を通るように、`CreateDbContextAsync` と `await using` を使ってください。

   ```csharp
   public sealed class CatalogCache(IDbContextFactory<CatalogDb> factory)
   {
       public async Task<List<Product>> GetActiveAsync(CancellationToken ct = default)
       {
           await using var db = await factory.CreateDbContextAsync(ct);
           return await db.Products
               .AsNoTracking()
               .Where(p => p.IsActive)
               .ToListAsync(ct);
       }
   }
   ```

4. すべての環境でスコープ検証を有効にします。そうすれば、将来のリファクタリングでキャプティブな `DbContext` が再び持ち込まれたときに、負荷のかかった深夜ではなく起動時に失敗してくれます。

   ```csharp
   builder.Host.UseDefaultServiceProvider(options =>
   {
       options.ValidateScopes = true;
       options.ValidateOnBuild = true;
   });
   ```

ファクトリが渡してくるコンテキストは DI コンテナの管理下に**ありません**。EF Core のドキュメントは、この方法で生成されたインスタンスについて "are not managed by the application's service provider and therefore must be disposed by the application" と明記しています。ステップ 3 の `await using` は任意の作法ではありません。これがないとプロセスの生存期間中ずっと接続をリークします。

## コンテキストをキャッシュしたときに実際に壊れるもの

魅力的に見える近道は、シングルトンのコンストラクタでコンテキストを 1 つ作って使い回すことです。自分しかユーザーがいない開発環境では無害に見えます。以下は同じ `CatalogCache` が単一のコンテキストを保持し、実際のスレッド上の 25 個の同時呼び出しにさらされた場合です。

```csharp
// Do not do this. One context, shared by every circuit on the server.
public sealed class CatalogCache(IDbContextFactory<CatalogDb> factory)
{
    private readonly CatalogDb _shared = factory.CreateDbContext();

    public Task<int> CountAsync() => _shared.Products.CountAsync();
}
```

これを EF Core 10.0.11 上で 3 回続けて実行したところ、3 つの異なる結果が得られ、うち 2 つは別々の例外でした。

```text
run 1: InvalidOperationException: A second operation was started on this context instance
       before a previous operation completed. This is usually caused by different threads
       concurrently using the same instance of DbContext.
run 2: InvalidOperationException: ExecuteReader can only be called when the connection is open.
run 3: InvalidOperationException: A second operation was started on this context instance ...
```

この非決定性こそが要点です。EF Core のスレッドセーフティ検出は、競合に勝てば 1 つ目の分かりやすいメッセージを出しますが、常に勝つわけではありません。2 回目の実行では、2 つの操作が同一接続上ですでに交錯していたため、ADO.NET の生の接続状態エラーが表面化しました。タイミングが違えば、同じバグは何も投げずに黙って誤ったデータを返します。私のテストでは、それ以前に 25 個のタスクがたまたま同期的に完了したケースがあり、すべて正しい結果を返して例外も出ませんでした。このバグが本番に到達してしまうのは、まさにそのためです。

呼び出しごとに 1 つのコンテキストへ切り替えると、同じ 25 個の同時呼び出しはすべて成功し、結果も一致しました。これは巧妙なコードではなく、[単一の作業単位というルール](/ja/2026/05/fix-second-operation-was-started-on-this-context-instance/)を素直に適用しただけです。

同じ理屈から、切り離されたタスクにコンテキストをキャプチャすると[破棄済みコンテキストインスタンスに対する ObjectDisposedException](/ja/2026/06/fix-objectdisposedexception-cannot-access-a-disposed-context-instance/) が発生する理由も説明できます。どちらのバグも、コンテキストがそれを必要とした操作より長く生き延びたことに起因します。

## このパターンを静かに壊すオーバーロード

`AddDbContextFactory` は省略可能な `lifetime` を受け取ります。`ServiceLifetime.Scoped` を渡すのはよくあるコピーアンドペーストの助言で、たいていは接続文字列をリクエストごとに解決するマルチテナントのサンプルから受け継がれたものです。これはファクトリの登録を変え、避けようとしていたはずのキャプティブ依存関係をそのまま呼び戻します。

```csharp
// This compiles, then fails at startup once a singleton consumes the factory.
builder.Services.AddDbContextFactory<CatalogDb>(
    options => options.UseSqlServer(connectionString),
    lifetime: ServiceLifetime.Scoped);
```

```text
Error while validating the service descriptor 'ServiceType: CacheWarmer Lifetime: Singleton
ImplementationType: CacheWarmer': Cannot consume scoped service
'Microsoft.EntityFrameworkCore.IDbContextFactory`1[AppDb]' from singleton 'CacheWarmer'.
```

サーキットごとの接続文字列が本当に必要な場合でも、ファクトリを scoped にしてシングルトンから利用するのはやめてください。ファクトリはシングルトンのままにしてテナントを明示的に渡すか、メソッドの中で `IServiceScopeFactory` を通じてテナント固有のファクトリを解決してください。そしてこれが、このパターン全体の本当の限界につながります。

## シングルトンにはサーキットがなく、したがってユーザーもいない

配線を正しくした後で、次にぶつかる制約がこれです。シングルトンはサーバー全体に対して一度だけ生成されます。そこには `AuthenticationStateProvider` も、サーキットに紐づくテナントリゾルバも、`HttpContext` もありません。周囲のユーザーから算出される `DbContextOptions` は、シングルトンが動く時点では単純に存在しないのです。

具体的には、次のコードは動きません。

```csharp
// The singleton has no circuit, so there is no current user to read here.
builder.Services.AddDbContextFactory<CatalogDb>((sp, options) =>
    options.UseSqlServer(sp.GetRequiredService<ITenantContext>().ConnectionString));
```

シングルトンが触れるデータが本当にユーザーごとのものであれば、そもそもシングルトンは置き場所として間違っています。処理をコンポーネントが呼び出す scoped サービスへ移すか、テナントの識別子をメソッド引数として渡し、接続文字列を自分で選択してください。

```csharp
public sealed class CatalogCache(IDbContextFactory<CatalogDb> factory)
{
    public async Task<int> CountForAsync(string tenantId, CancellationToken ct = default)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        return await db.Products.CountAsync(p => p.TenantId == tenantId, ct);
    }
}
```

マスタデータ、参照テーブル、テナント横断の集計は、シングルトンとファクトリの組み合わせに適しています。「現在のユーザー」に紐づくものは適していません。繰り返しのクエリを避けるためだけにシングルトンへ手を伸ばしているのであれば、キャッシュのほうが適切なプリミティブであり、その選び方は[HybridCache と IMemoryCache と IDistributedCache の比較](/ja/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/)で扱っています。

## プール版ファクトリを選ぶべき場面

`AddPooledDbContextFactory<TContext>` も同様にシングルトンの `IDbContextFactory<TContext>` を登録し、その実体は `PooledDbContextFactory<TContext>` です。`poolSize` の既定値は EF Core 6 以降で 1024 です (EF Core 5.0 では 128 でした)。プールされたコンテキストを破棄すると、そのまま捨てられるのではなくリセットされてプールへ返却されるため、ホットパスでのアロケーションが目に見えて減ります。

EF Core 10.0.11 で検証した動作は次のとおりです。コンテキストを生成し、破棄し、もう 1 つ生成すると**同じ**インスタンスが返り、破棄後に最初のインスタンスへ触れると `ObjectDisposedException` が発生します。つまりプールは実際に再利用しており、破棄後の使用も引き続き検出されます。

切り替える前に注意点が 2 つあります。

- プール版のオーバーロードは `lifetime` パラメータを受け取らず、`optionsAction` は省略可能ではなく必須です。プールされたコンテキストでは `OnConfiguring` がまったく呼ばれないため、設定は外側で行う必要があります。
- プールされたコンテキストは、コンストラクタで任意のサービスを注入してもらうことができません。インスタンスが無関係な操作間で再利用されるからです。コンテキストに置いた状態は、EF Core がリセットしない限り次の呼び出し元まで残ります。

短い読み取りを高頻度で行うシングルトンには、プール版ファクトリのほうが既定として適しています。たまにしか動かないシングルトンであれば通常のファクトリのほうが単純で、アロケーションの差はプロファイルに現れません。ホットパスがコンテキストの生成ではなくクエリそのものであれば、[EF Core のホットパス向けコンパイル済みクエリ](/ja/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)のほうが効果の大きい手段です。

## レンダーモード、WebAssembly、バックグラウンドサービス

シングルトンがどこに存在するかを変える境界事例が 3 つあり、挙げておく価値があります。

**interactive WebAssembly と Auto レンダーモード。** サーバープロジェクトの `Program.cs` で登録したシングルトンは、サーバー上にしか存在しません。クライアントで動作するコンポーネントは WebAssembly プロジェクト側に独自のサービスプロバイダーを持ち、そもそも `DbContext` はブラウザのサンドボックスからデータベース接続を開けません。コンポーネントを interactive server から interactive WebAssembly へ移すと、依存していたシングルトンはクライアント側で静かに解決不能になります。この境界は、[Blazor の静的レンダリングと対話的レンダリングをまたぐ状態の問題](/ja/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/)の背後にあるものと同じです。

**静的 SSR とプリレンダリング。** 静的サーバーサイドレンダリング中はサーキットが存在しませんが、アプリケーションのルートプロバイダーは依然として存在するため、ファクトリを持つシングルトンは通常どおり動作します。静的 SSR、プリレンダリング、対話的サーバーレンダリングのいずれでも同じ挙動になるデータベースパターンは数少なく、これはこの方式を選ぶ実際の根拠になります。

**BackgroundService。** `AddHostedService<T>` はシングルトンを登録するため、データを必要とするホステッドサービスもまったく同じ問題を抱え、まったく同じ解決策を取ります。処理が純粋なデータアクセスであれば `IDbContextFactory<T>` を注入し、作業単位が複数の scoped サービスをまとめて必要とするなら `IServiceScopeFactory` を使ってください。後者は[BackgroundService の中で scoped サービスを使う方法](/ja/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/)で扱っています。

このパターンは一行で言い切れるほど小さなものです。シングルトンが保持してよいのはファクトリであって、コンテキストではありません。本記事の残りはすべて、そこから導かれる帰結です。

## 参考資料

- [DbContext Lifetime, Configuration, and Initialization](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/)、EF Core のドキュメント。`AddDbContextFactory` と、管理外コンテキストの破棄について。
- [ASP.NET Core Blazor with Entity Framework Core](https://learn.microsoft.com/en-us/aspnet/core/blazor/blazor-ef-core)、サーキットについて、およびシングルトン、scoped、transient のいずれも `DbContext` に不適切である理由について。
- [EntityFrameworkServiceCollectionExtensions.AddDbContextFactory](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.entityframeworkservicecollectionextensions.adddbcontextfactory)、既定値 `ServiceLifetime.Singleton` と、コンテキスト型の scoped 登録について。
- [EntityFrameworkServiceCollectionExtensions.AddPooledDbContextFactory](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.entityframeworkservicecollectionextensions.addpooleddbcontextfactory)、`poolSize` の既定値と `OnConfiguring` に関する注意点について。
