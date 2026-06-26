---
title: "解決方法: No service for type 'Microsoft.EntityFrameworkCore.DbContextOptions' has been registered"
description: "AddDbContext が実行されなかった、Build の後で実行された、またはコンテキストのコンストラクターが誤った DbContextOptions を受け取ると EF Core はこれをスローします。Build より前に登録し、DbContextOptions<YourContext> を使ってください。"
pubDate: 2026-06-26
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "dependency-injection"
lang: "ja"
translationOf: "2026/06/fix-no-service-for-type-dbcontextoptions-has-been-registered"
translatedBy: "claude"
translationDate: 2026-06-26
---

解決方法: 依存性注入コンテナーが `DbContext` を構築している最中に `DbContextOptions` を要求されましたが、返せるものが何もありませんでした。ほぼすべてのケースで、これは `AddDbContext<YourContext>(...)` が一度も呼ばれていない、`builder.Build()` の後で呼ばれた、もう実行されない `ConfigureServices` メソッドの中にある、またはコンテキストのコンストラクターがコンテナーの登録していないパラメーターを宣言している、のいずれかを意味します。`builder.Services.AddDbContext<YourContext>(...)` を `Build()` より前に追加し、コンストラクターには非ジェネリックの `DbContextOptions` ではなく `DbContextOptions<YourContext>` パラメーターを与えてください。

```text
System.InvalidOperationException: No service for type 'Microsoft.EntityFrameworkCore.DbContextOptions' has been registered.
   at Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.GetRequiredService(IServiceProvider provider, Type serviceType)
   at Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.GetRequiredService[T](IServiceProvider provider)
```

同じ根本原因は、型名のジェネリックなバッククォート形式とともに、アクティベーション経路を通じて現れることもあります。

```text
System.InvalidOperationException: Unable to resolve service for type 'Microsoft.EntityFrameworkCore.DbContextOptions`1[MyApp.Data.AppDbContext]' while attempting to activate 'MyApp.Data.AppDbContext'.
   at Microsoft.Extensions.DependencyInjection.ActivatorUtilities.GetService(...)
```

このガイドは .NET 11、EF Core 11.0.0（`Microsoft.EntityFrameworkCore` 11.0.0）、`Microsoft.Extensions.DependencyInjection` 11.0.0 を対象に書かれています。ここで説明する挙動は EF Core 3.0 以降で安定しているため、これらの解決方法は EF Core 6、8、10 にもそのまま当てはまります。

## 2 つのメッセージ形式は同じバグ

.NET のコンテナーは、1 つの根本的な失敗に対して 2 つの異なる文を出力します。どちらが出るかは、解決がどのように始まったかによります。

- `No service for type 'X' has been registered.` は `GetRequiredService<X>()` から来ます。何かがプロバイダーに `X` を直接要求し、`X` がコレクションに無かったのです。
- `Unable to resolve service for type 'X' while attempting to activate 'Y'.` は `ActivatorUtilities` から来ます。コンテナーが `Y` を構築中に型 `X` のコンストラクターパラメーターに当たり、それを満たせなかったのです。

ここではどちらの場合も `X` は `DbContextOptions`（またはそのジェネリック形 `DbContextOptions<AppDbContext>`。ランタイムは ``DbContextOptions`1[AppDbContext]`` と出力します）です。`Y` は、存在する場合、あなたのコンテキストです。何かを変更する前に型名を読んでください。このエラーはコンテキスト自体ではなく、EF Core がコンテキストを構成するために必要とするオプションオブジェクトに関するものです。

## AddDbContext が実際に登録するもの

解決方法を理解するには、`AddDbContext<TContext>` がコンテナーに何を入れるかを理解する必要があります。内部的には、オプションのために 2 つのものを登録します（`Microsoft.EntityFrameworkCore.EntityFrameworkServiceCollectionExtensions` の `AddCoreServices` メソッド）。

```csharp
// EF Core 11.0.0 - paraphrased from AddCoreServices
serviceCollection.TryAdd(
    new ServiceDescriptor(
        typeof(DbContextOptions<TContextImplementation>),
        CreateDbContextOptions<TContextImplementation>,
        optionsLifetime));

serviceCollection.Add(
    new ServiceDescriptor(
        typeof(DbContextOptions),
        p => p.GetRequiredService<DbContextOptions<TContextImplementation>>(),
        optionsLifetime));
```

ここから、エラーのあらゆる変種を説明する 2 つの事実が導かれます。

1. ジェネリックの `DbContextOptions<TContext>` が本当の登録です。これは `TryAdd` で追加されるため、その閉じた型については最初の呼び出しが勝ちます。
2. 非ジェネリックの `DbContextOptions` は `Add`（無条件）で追加されるフォワーダーです。内部では単に `GetRequiredService<DbContextOptions<TContext>>()` を呼び出します。`TryAdd` ではなく `Add` なので、`AddDbContext` を呼ぶたびに別のフォワーダーが追加され、非ジェネリックの `DbContextOptions` を解決すると **最後に登録されたものが勝ちます**。

したがって、`AddDbContext` を一度も呼ばなければ、どちらの登録も存在せず、いずれの形式を要求しても例外がスローされます。そして 2 つのコンテキストを登録しても、一方が非ジェネリックの `DbContextOptions` を受け取ると、そのコンテキストは黙ってもう一方のコンテキストのオプションを受け取ります。どちらのケースも以下で扱います。

## 最小限の再現

登録を完全に忘れたことでエラーをスローする、最小の .NET 11 プログラムです。

```csharp
// .NET 11, EF Core 11.0.0, Microsoft.AspNetCore.App 11.0.0
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

// No builder.Services.AddDbContext<AppDbContext>(...) here.
builder.Services.AddControllers();

var app = builder.Build();
app.MapControllers();
app.Run();

public sealed class AppDbContext : DbContext
{
    public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) { }
    public DbSet<Product> Products => Set<Product>();
}

public sealed class Product
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
}

[ApiController]
[Route("products")]
public sealed class ProductsController(AppDbContext db) : ControllerBase
{
    [HttpGet]
    public IActionResult Get() => Ok(db.Products.Count());
}
```

`GET /products` にアクセスすると、MVC はコンテナーに `ProductsController` のアクティベーションを依頼します。これには `AppDbContext` が必要で、それには `DbContextOptions<AppDbContext>` が必要です。誰もそれを登録していないため、エラーのアクティベーション形式が出ます。これはまさに、まだ `Program.cs` に組み込んでいないコンテキストに対して Visual Studio でコントローラーをスキャフォールディングした直後に当たる形です。

## 解決方法その 1: ホストが構築される前にコンテキストを登録する

大多数のケースでの答えです。`Program.cs` に登録を追加し、それが `builder.Build()` より前に実行されることを確認します。

```csharp
// .NET 11, EF Core 11.0.0
var connectionString = builder.Configuration.GetConnectionString("DefaultConnection")
    ?? throw new InvalidOperationException("Connection string 'DefaultConnection' not found.");

builder.Services.AddDbContext<AppDbContext>(options =>
    options.UseSqlServer(connectionString));

var app = builder.Build();
```

`builder.Build()` はサービスコレクションのスナップショットを取ります。その行より後に `builder.Services` に追加したものは、実行中のホストによって黙って無視されるため、これは誤りです。

```csharp
// .NET 11 - bug: registration after Build is discarded
var app = builder.Build();
builder.Services.AddDbContext<AppDbContext>(options => options.UseSqlServer(cs)); // too late
app.Run();
```

古い `Startup` モデルを使っている場合、登録は `ConfigureServices` に属します。このバグの典型的な形は、2 つ目の `ConfigureServices` オーバーロード、または誰かがデバッグ中に無効化して元に戻し忘れたコメントアウトされた `services.AddDbContext` 行です。プロジェクト全体で `AddDbContext` を検索し、見つかった呼び出しが実際にホストの実行するコードパス上にあることを確認してください。

リクエストパイプラインの外で `DbContext` を構築する場合、同じルールが構築したプロバイダーの内側で適用されます。スコープ付き（scoped）の `DbContext` をルートプロバイダーから、またはスコープを作らずに `app.Run()` より前に解決すると、同じ理由で失敗します。

```csharp
// .NET 11 - resolve a scoped DbContext correctly outside a request
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    await db.Database.MigrateAsync();
}
```

## 解決方法その 2: コンストラクターに DbContextOptions<YourContext> を与える

登録があるのにそれでもエラーが出る場合は、コンストラクターを見てください。EF Core の DI 登録は `DbContextOptions<AppDbContext>` を生成するので、それがコンストラクターの宣言すべきパラメーターです。

```csharp
// Right: generic, tied to this specific context type
public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) { }
```

非ジェネリック版はコンパイルでき、登録済みコンテキストが 1 つだけのときは、上記のフォワーダーが解決するため実際に動作します。しかし脆弱です。

```csharp
// Risky: non-generic. Works with one context, breaks with two.
public AppDbContext(DbContextOptions options) : base(options) { }
```

2 つ目のコンテキストが登録された瞬間、両方の `AddDbContext` 呼び出しが非ジェネリックの `DbContextOptions` フォワーダーを追加し、最後のものが勝ち、あなたのコンテキストは誤ったオプション、たいていは誤った接続文字列、ときには誤ったデータベースプロバイダーすら受け取ります。この失敗は、部分的な登録時の `No service` エラーとして現れることもあれば、もっと悪いことに、黙って誤ったデータベースにクエリするコンテキストとして現れることもあります。Microsoft のドキュメントはこれについて明確です。

> `DbContextOptions` を受け取るほとんどの `DbContext` サブクラスは、ジェネリックの `DbContextOptions<TContext>` バリエーションを使うべきです。これにより、複数の `DbContext` サブタイプが登録されている場合でも、特定の `DbContext` サブタイプに対する正しいオプションが依存性注入から解決されることが保証されます。

非ジェネリック形式には正当な用途が 1 つあります。継承されることを意図した基底クラスです。基底は非ジェネリックの `DbContextOptions` を受け取り、各具象サブクラスが自身の `DbContextOptions<TConcrete>` を渡せるようにします。

```csharp
// .NET 11, EF Core 11.0.0 - base class shared by several contexts
public abstract class AppDbContextBase : DbContext
{
    protected AppDbContextBase(DbContextOptions options) : base(options) { }
}

public sealed class CatalogDbContext : AppDbContextBase
{
    public CatalogDbContext(DbContextOptions<CatalogDbContext> options) : base(options) { }
}

public sealed class OrdersDbContext : AppDbContextBase
{
    public OrdersDbContext(DbContextOptions<OrdersDbContext> options) : base(options) { }
}
```

各具象コンテキストは引き続きジェネリックコンストラクターを公開するので、DI は正しいオプションを渡します。基底はサブクラスが連鎖するためのコンストラクターを提供するだけです。直接インスタンス化もされ、かつ継承もされる必要のあるコンテキストは、両方のコンストラクターを公開すべきです。ジェネリックを public に、非ジェネリックを protected にします。

## 解決方法その 3: デザイン時ツール（マイグレーションとスキャフォールディング）

このエラーの別種は、`dotnet ef` を実行したときにだけ現れます。

```text
Unable to create a 'DbContext' of type ''. The exception 'Unable to resolve service for type
'Microsoft.EntityFrameworkCore.DbContextOptions`1[MyApp.Data.AppDbContext]' while attempting to
activate 'MyApp.Data.AppDbContext'.' was thrown while attempting to create an instance.
```

デザイン時には実行中の Web ホストが無いため、EF Core はアプリケーションの DI コンテナーからオプションを取り出せません。それでもコンテキストを構築しようとして、オプションパラメーターで失敗します。信頼できる解決方法は 2 つあります。

1. EF にアプリのホストを見つけさせる。`DbContext` がスタートアッププロジェクトにあり、`Program.cs` が `AddDbContext` を呼んでいれば、EF のツールはアプリのサービスプロバイダーを使えます。デザイン時と実行時のプロジェクトを同一に保つか、`--startup-project` を渡してください。
2. 明示的なファクトリーを提供する。コンテキストの隣に `IDesignTimeDbContextFactory<TContext>` を実装します。EF はそれを自動的に見つけ、推測する代わりに使います。

```csharp
// .NET 11, EF Core 11.0.0 - found automatically by dotnet ef
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

public sealed class AppDbContextFactory : IDesignTimeDbContextFactory<AppDbContext>
{
    public AppDbContext CreateDbContext(string[] args)
    {
        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseSqlServer("Server=(localdb)\\mssqllocaldb;Database=DesignTime;ConnectRetryCount=0")
            .Options;

        return new AppDbContext(options);
    }
}
```

ファクトリーは `DbContextOptions<AppDbContext>` を手作業で構築するので、デザイン時コマンドはアプリケーションの DI に一切触れません。これは、コンテキストが独自のスタートアップホストを持たないクラスライブラリにある場合の定石の解決方法です。その失敗のより広い版については、[なぜ `dotnet ef migrations add` が "Unable to create an object of type DbContext" を報告するのか](/ja/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/) の専用解説を参照してください。

## コンテキストを手作業で構築する

DI をまったく使わないなら、非ジェネリックの `DbContextOptions` 登録は無関係です。オプションを自分で構築してコンストラクターに渡します。

```csharp
// .NET 11, EF Core 11.0.0 - no DI container involved
var options = new DbContextOptionsBuilder<AppDbContext>()
    .UseSqlServer(connectionString)
    .Options;

using var db = new AppDbContext(options);
```

これは、`IServiceProvider` を持たないコンソールツール、テスト、バックグラウンドユーティリティに適した形です。ビルダーもジェネリックであることに注意してください。`DbContextOptionsBuilder<AppDbContext>` は `DbContextOptions<AppDbContext>` を生成し、これはジェネリックコンストラクターと一致します。

## 誤ってこのページにたどり着く類似ケース

検索のされ方は同じでも、解決が異なる類似ケースがいくつかあります。

- **`No connection string named 'DefaultConnection' could be found`。** コンテキストの登録は問題なく、接続文字列の検索が失敗しました。層が違い、解決も違います。[DefaultConnection 接続文字列エラー](/ja/2026/05/fix-no-connection-string-named-defaultconnection/) を参照してください。
- **`Unable to resolve service for type 'X' while attempting to activate 'Y'`（X が `DbContextOptions` ではなく自分のサービスの場合）。** これは EF Core の配線の問題ではなく、あなたのコードでの単純な登録漏れです。[一般的なサービス解決エラー](/ja/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/) を参照してください。
- **`Cannot consume scoped service 'AppDbContext' from singleton 'Y'`。** コンテキストは正しく登録されており、singleton がそれをキャプチャしています。解決方法は登録ではなくスコープです。
- **`A second operation was started on this context instance`。** コンテキストは問題なく解決されましたが、スレッド間で共有されているか、await が正しくありません。
- **`AddDbContextPool` と `AddDbContextFactory`。** どちらも `AddDbContext` と同じ方法で `DbContextOptions<TContext>` を登録するので、コンストラクターのルールは同一です。プール化されたコンテキストやファクトリーで構築されたコンテキストも、ジェネリックの `DbContextOptions<TContext>` パラメーターを必要とします。テストでプール化されたファクトリーを通じてコンテキストを差し替えているなら、[EF Core 11 でテスト差し替えのためにプール化された DbContext ファクトリーを取り除く方法](/ja/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/) を参照してください。

## 配線を 10 秒で確認する

登録が正しく見えるのにエラーが続く場合は、推測せずにスコープから証明します。

```csharp
// .NET 11 - remove before commit
using (var scope = app.Services.CreateScope())
{
    var options = scope.ServiceProvider.GetService<DbContextOptions<AppDbContext>>();
    Console.WriteLine(options is null ? "OPTIONS NOT REGISTERED" : "options OK");

    var ctx = scope.ServiceProvider.GetService<AppDbContext>();
    Console.WriteLine(ctx is null ? "CONTEXT NOT REGISTERED" : ctx.GetType().FullName);
}
```

オプションの行が `OPTIONS NOT REGISTERED` と出力されたら、このプロバイダーで `AddDbContext` が一度も実行されておらず、解決方法その 1 に該当します。オプションは解決されるのにコンテキストが解決されないなら、コンストラクターのパラメーターが誤っており、解決方法その 2 に該当します。最初のリクエストで失敗する代わりに、壊れたグラフではホストが起動を拒否するよう、ビルド時の検証を有効にすることもできます。

```csharp
// .NET 11
builder.Host.UseDefaultServiceProvider(o =>
{
    o.ValidateScopes = true;
    o.ValidateOnBuild = true;
});
```

`ValidateOnBuild` は各登録を一度走査して早期に失敗し、実行時の 500 を見逃しようのない起動エラーに変えます。ジェネリックコンストラクターと `Build` より前の `AddDbContext` を組み合わせれば、`DbContextOptions` エラーは戻ってきません。DI をまったく使わずにコンテキストを構築するユニットテストの背後にあるパターンについては、補足記事の [変更追跡を壊さずに DbContext をモックする方法](/ja/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) がトレードオフを扱っています。

## 出典

- Microsoft Learn、[DbContext Lifetime, Configuration, and Initialization](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/)。`DbContextOptions` versus `DbContextOptions<TContext>` のセクションを含みます。
- Microsoft Learn、[Design-time DbContext Creation](https://learn.microsoft.com/en-us/ef/core/cli/dbcontext-creation) および `IDesignTimeDbContextFactory<TContext>`。
- EF Core ソース、[`EntityFrameworkServiceCollectionExtensions.cs`](https://github.com/dotnet/efcore/blob/main/src/EFCore/Extensions/EntityFrameworkServiceCollectionExtensions.cs)。ここで `AddCoreServices` がジェネリックと非ジェネリックのオプションを登録します。
- dotnet/efcore の Issue [#32936](https://github.com/dotnet/efcore/issues/32936)。デザイン時のアクティベーションエラーとファクトリーによる解決について。
