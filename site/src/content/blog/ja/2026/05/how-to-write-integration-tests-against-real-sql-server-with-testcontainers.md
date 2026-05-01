---
title: "Testcontainers で本物の SQL Server に対する統合テストを書く方法"
description: "Testcontainers 4.11 と EF Core 11 を使い、ASP.NET Core の統合テストを本物の SQL Server 2022 に対して実行するための完全ガイドです。WebApplicationFactory の組み立て、IAsyncLifetime、DbContext 登録の差し替え、マイグレーションの適用、並列実行、Ryuk によるクリーンアップ、CI のはまりどころを解説します。"
pubDate: 2026-05-01
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "testing"
  - "integration-tests"
  - "testcontainers"
  - "sql-server"
lang: "ja"
translationOf: "2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers"
translatedBy: "claude"
translationDate: 2026-05-01
---

.NET 11 のテストプロジェクトから本物の SQL Server に対して統合テストを実行するには、`Testcontainers.MsSql` 4.11.0 をインストールし、`MsSqlContainer` を保持する `WebApplicationFactory<Program>` を組み立て、`IAsyncLifetime.InitializeAsync` でコンテナを起動し、`ConfigureWebHost` で `DbContext` の登録を `container.GetConnectionString()` を指すように上書きし、最初のテストの前に一度だけマイグレーションを適用します。`IClassFixture<T>` を使えば、xUnit が同じクラス内のテストで 1 つのコンテナを共有します。SQL Server のイメージは特定のタグに固定し、デフォルトは `mcr.microsoft.com/mssql/server:2022-CU14-ubuntu-22.04` を使い、プロセスがクラッシュした場合のコンテナ破棄は Ryuk に任せます。本ガイドは .NET 11 preview 3、C# 14、EF Core 11、xUnit 2.9、Testcontainers 4.11 を前提に書かれています。同じパターンは .NET 8、9、10 でもそのまま使え、変わるのはパッケージのバージョンだけです。

## なぜインメモリプロバイダーではなく本物の SQL Server なのか

EF Core にはインメモリプロバイダーと SQLite-in-memory のオプションがあり、SQL Server に似て見えますが、肝心なところで違います。インメモリプロバイダーにはリレーショナルな振る舞いがまったくありません。トランザクションも、外部キーの強制も、`RowVersion` の同時実行トークンも、SQL への変換もありません。SQLite は本物のリレーショナルエンジンですが、SQL の方言が異なり、識別子のクォート方法も違い、decimal 型の扱いも違います。統合テストで捕まえたい具体的な問題、たとえばインデックスの欠落、ユニーク制約違反、`nvarchar` の切り詰め、`DateTime2` の精度欠落などは、これらでは静かにマスクされてしまいます。

EF Core の公式ドキュメントは数年前に「インメモリに対してテストするな」という警告を追加していて、チームが [testing without your production database system](https://learn.microsoft.com/en-us/ef/core/testing/choosing-a-testing-strategy) ページで推奨しているパターンは「本物のインスタンスをコンテナで立ち上げる」です。Testcontainers はそれをメソッド呼び出し 1 行で済ませます。トレードオフは SQL Server イメージを pull して起動するコールドスタートのコスト（Docker デーモンが温まっている状態でおよそ 8〜12 秒）ですが、その後のすべてのアサーションは本番と同じエンジンが評価することになります。

## イメージは固定する、フロートさせない

コードを書く前にイメージタグを決めましょう。Testcontainers のドキュメントは既定で `mcr.microsoft.com/mssql/server:2022-CU14-ubuntu-22.04` を使っていて、これは本番で `:latest` をフロートさせない理由と同じく正しい選択です。昨日通っていた CI パイプラインは今日も通る必要があります。新しい cumulative update はテストパイプラインにとって無料のアップグレードではありません。CU ごとにオプティマイザが変わり、`sys.dm_*` のスキーマが変わり、`sqlpackage` のようなツールの最低パッチレベルが上がる可能性があるからです。

`2022-CU14-ubuntu-22.04` イメージは圧縮で約 1.6 GB あり、新しい CI ランナーでの最初の pull はテストスイートの中で最も遅い部分です。CI でこのレイヤーをキャッシュしてください。GitHub Actions には `cache-from` を持つ `docker/setup-buildx-action` があり、Azure DevOps では同じ効果を得るために `~/.docker` をキャッシュできます。最初のウォームキャッシュ後の pull は約 2 秒です。

SQL Server 2025 の機能（ベクトル検索、`JSON_CONTAINS`、参照: [SQL Server 2025 JSON contains in EF Core 11](/ja/2026/04/efcore-11-json-contains-sql-server-2025/)）が必要ならタグを `2025-CU2-ubuntu-22.04` に上げてください。そうでなければ 2022 のままでよく、2022 の developer イメージは Testcontainers のメンテナーによって最も広くテストされています。

## 必要なパッケージ

3 つのパッケージでハッピーパスは網羅できます。

```xml
<!-- .NET 11, xUnit-based test project -->
<ItemGroup>
  <PackageReference Include="Testcontainers.MsSql" Version="4.11.0" />
  <PackageReference Include="Microsoft.AspNetCore.Mvc.Testing" Version="9.0.0" />
  <PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0" />
</ItemGroup>
```

`Testcontainers.MsSql` はコアの `Testcontainers` パッケージと `MsSqlBuilder` を引き込みます。`Microsoft.AspNetCore.Mvc.Testing` には `WebApplicationFactory<TEntryPoint>` が含まれ、これがあなたの DI コンテナと HTTP パイプラインを丸ごと `TestServer` 上で起動します。`Microsoft.EntityFrameworkCore.SqlServer` は本番コードがすでに参照しているもので、テストプロジェクトはフィクスチャがマイグレーションを適用できるようにこれを取り込みます。

テストが xUnit で動くなら、`xunit` 2.9.x と `xunit.runner.visualstudio` 2.8.x も追加してください。NUnit や MSTest でも同じファクトリパターンで動き、変わるのはライフサイクルフックの名前だけです。

## ファクトリクラス

統合テスト用ファクトリの仕事は 3 つです。コンテナのライフタイムを所有すること、ホストの DI に接続文字列を公開すること、そしてどのテストが走る前にもスキーマを適用することです。仮想的な `OrdersDbContext` に対する完全な実装は次のとおりです。

```csharp
// .NET 11, C# 14, EF Core 11, Testcontainers 4.11
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Testcontainers.MsSql;
using Xunit;

public sealed class OrdersApiFactory
    : WebApplicationFactory<Program>, IAsyncLifetime
{
    private readonly MsSqlContainer _sql = new MsSqlBuilder()
        .WithImage("mcr.microsoft.com/mssql/server:2022-CU14-ubuntu-22.04")
        .WithPassword("Strong!Passw0rd_for_tests")
        .Build();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<DbContextOptions<OrdersDbContext>>();
            services.AddDbContext<OrdersDbContext>(opts =>
                opts.UseSqlServer(_sql.GetConnectionString()));
        });
    }

    public async Task InitializeAsync()
    {
        await _sql.StartAsync();

        using var scope = Services.CreateScope();
        var db = scope.ServiceProvider
            .GetRequiredService<OrdersDbContext>();
        await db.Database.MigrateAsync();
    }

    public new async Task DisposeAsync()
    {
        await _sql.DisposeAsync();
        await base.DisposeAsync();
    }
}
```

立ち止まって見たい点が 3 つあります。コンテナはフィールド初期化子で構築されますが、起動するのは `InitializeAsync` の中だけです。これは xUnit がフィクスチャごとにこのメソッドを正確に 1 回だけ呼ぶためです。ホスト（つまり DI コンテナ）は `WebApplicationFactory` によって、`Services` を最初に読み込むか `CreateClient` を呼ぶときに遅延構築されるので、`InitializeAsync` が `Services.CreateScope()` を呼ぶ時点で SQL コンテナはすでに起動済みで接続文字列も結線されています。`RemoveAll<DbContextOptions<OrdersDbContext>>` の行は省略不可です。これを抜くと登録が 2 つになり、`services.AddDbContext` が 2 つ目になって、リゾルバの順序によっては両方が静かに残ります。

`WithPassword` の呼び出しは SA パスワードを設定します。SQL Server のパスワードポリシーは少なくとも 8 文字、大文字・小文字・数字・記号の混在を要求します。これより弱いものを渡すと、コンテナは起動するもののエンジンがヘルスチェックに失敗します。Testcontainers の SA パスワードのデフォルトは `yourStrong(!)Password` ですでにポリシーを満たしているので、`.WithPassword` の呼び出しを省略しても動きます。

## テストクラスでファクトリを使う

xUnit の `IClassFixture<T>` はほとんどのケースで適切なスコープです。フィクスチャを 1 度だけ構築し、クラス内のすべてのテストメソッドを同じ SQL コンテナに対して実行し、最後に破棄します。

```csharp
// .NET 11, xUnit 2.9
public sealed class OrdersApiTests : IClassFixture<OrdersApiFactory>
{
    private readonly OrdersApiFactory _factory;
    private readonly HttpClient _client;

    public OrdersApiTests(OrdersApiFactory factory)
    {
        _factory = factory;
        _client = factory.CreateClient();
    }

    [Fact]
    public async Task Post_creates_order_and_returns_201()
    {
        var response = await _client.PostAsJsonAsync("/orders",
            new { customerId = "C-101", amount = 49.99m });

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
    }

    [Fact]
    public async Task Get_returns_persisted_order()
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<OrdersDbContext>();
        db.Orders.Add(new Order { Id = "O-1", CustomerId = "C-101" });
        await db.SaveChangesAsync();

        var response = await _client.GetAsync("/orders/O-1");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }
}
```

テストごとに新しいコンテナが必要な場合（たとえばテストがスキーマを書き換える場合）は、`IClassFixture` ではなくテストクラスに直接 `IAsyncLifetime` を実装してください。これは稀なケースで、10 回中 9 回はコールドスタートのコストはクラスごとに 1 度払い、状態のリセットはコンテナの再起動ではなくテーブルの truncate で行いたいはずです。

## コンテナを再起動するのではなく、テスト間で状態をリセットする

「本物の SQL Server」テストの正直なコストは状態のリークです。テスト A が行を挿入し、テスト B が件数をアサートして間違った答えを得ます。解決策は 3 つ、速い順に紹介します。

1. **各テストの先頭で truncate する。** いちばん安上がりです。`static readonly string[] TablesInTruncationOrder` を持っておき、それぞれに `TRUNCATE TABLE` を流します。Testcontainers のメンテナーが ASP.NET Core サンプルで推奨している方法です。
2. **各テストをトランザクションで包んで最後にロールバックする。** テスト対象のコード自身が `BeginTransaction` を呼ばない場合に有効です。EF Core 11 でも、SQL Server で `EnlistTransaction` 呼び出しなしのネストしたトランザクションは依然として許可されません。
3. **`Respawn` を使う**（[NuGet パッケージ](https://www.nuget.org/packages/Respawn)）。information schema を読んで truncate スクリプトを 1 度生成し、キャッシュして各テストの前に実行します。数百テストを超えたあたりで多くの大規模チームがここに落ち着きます。

何を選ぶにしても、テスト間で `EnsureDeletedAsync` と `MigrateAsync` を呼ぶのは**やめて**ください。EF Core のマイグレーションランナーは小さなスキーマでも 1 桁秒かかります。それを 200 テストに掛けると、スイートは 30 秒から 30 分になります。テスト中の DbContext のライフタイムのトレードオフについては [removing pooled DbContextFactory in EF Core 11 test swaps](/ja/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/) と関連する [warming up the EF Core model](/ja/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/) の解説を参照してください。

## テストの並列実行

xUnit はデフォルトでテストクラスを並列実行します。クラスフィクスチャごとに 1 つのコンテナがあると、N クラスが同時に M 個のコンテナを点火することになり、M は Docker ホストのメモリで制限されます。SQL Server はアイドル時にインスタンスあたり約 1.5 GB の RAM を食うので、16 GB の GitHub Actions ランナーはスワップが始まる前におおよそ 8 並列クラスで頭打ちになります。

よく使う 2 つのつまみです。

```xml
<!-- xunit.runner.json in the test project, copy to output -->
{
  "parallelizeTestCollections": true,
  "maxParallelThreads": 4
}
```

```csharp
// or, opt-out per assembly
[assembly: CollectionBehavior(MaxParallelThreads = 4)]
```

`[Collection]` 属性を使って 1 つのコンテナを複数クラスで共有すると、それらのクラスは直列化されます。ときにはこれが正しい妥協です。コンテナは温かいまま、テストごとの実時間は遅くなりますが、RAM 圧は大きく下がります。

## Ryuk が何をするのか、なぜ有効のままにすべきか

Testcontainers は Ryuk というサイドカー（イメージ `testcontainers/ryuk`）を同梱しています。.NET プロセスが起動すると Ryuk は Docker デーモンに接続し、親プロセスを監視します。テストランナーがクラッシュしたり、パニックしたり、`kill -9` されたりすると、Ryuk は親が消えたことに気づき、ラベル付きコンテナを破棄します。Ryuk なしだと、クラッシュしたテスト実行は孤立した SQL Server コンテナを残し、次の実行はポート競合か RAM 不足にぶつかります。

Ryuk はデフォルトで有効です。制限された CI 環境では無効化（`TESTCONTAINERS_RYUK_DISABLED=true`）が推奨されることもありますが、それはクリーンアップの負担を CI 側に移します。どうしても無効化が必要なら、`docker container prune -f --filter "label=org.testcontainers=true"` を実行する post-job ステップを追加してください。

## CI のはまりどころ

GitHub Actions のランナーは Linux ランナー（`ubuntu-latest`）に Docker がプリインストールされていますが、macOS と Windows ランナーには入っていません。SQL コンテナのために Linux に固定するか、`docker/setup-docker-action` のコストを払うかのどちらかです。Azure DevOps の Microsoft ホスト型 Linux エージェントも同じです。セルフホスト型 Windows エージェントでは、WSL2 バックエンドの Docker Desktop と、ホストアーキテクチャに合った SQL Server イメージが必要です。

もう 1 つチームをかむのはタイムゾーンとカルチャです。Ubuntu のベースイメージは UTC です。テストが `DateTime.Now` に対してアサートしていると、ローカルでは通って CI で落ちます。`DateTime.UtcNow` を一貫して使うか、`TimeProvider`（.NET 8 以降に組み込み）を注入して決定論的な時刻をシードしてください。

## コンテナが本当に起動したかを検証する

テストが `A network-related or instance-specific error occurred` で落ちる場合、EF Core が接続を開く前にコンテナの起動が終わっていなかったということです。Testcontainers の MsSql モジュールにはエンジンが応答するまでポーリングする組み込みの待機戦略があるので、これが起きるのは待機戦略を差し替えたときだけです。次のように確認できます。

```csharp
// peek at the dynamic host port
var port = _sql.GetMappedPublicPort(MsSqlBuilder.MsSqlPort);
Console.WriteLine($"SQL is listening on localhost:{port}");
```

待機戦略はコンテナ内の `sqlcmd` を使います。SQL Server イメージに `sqlcmd` が含まれていない（古いイメージの）場合は、`.WithWaitStrategy(Wait.ForUnixContainer().UntilCommandIsCompleted("/opt/mssql-tools18/bin/sqlcmd", "-Q", "SELECT 1"))` を渡して上書きしてください。

## このアプローチで足りなくなる場面

Testcontainers は本物の SQL Server を提供します。Always On やシャーディングルーティング、複数ファイルにまたがる全文検索は提供しません。本番データベースが構成済みクラスタなら、統合テストは単一ノードに対して走り、スイートには既知のカバレッジギャップができます。それを記録し、クラスタ固有の振る舞いはステージング環境に対する小さく的を絞ったテストで書いてください。ステージング API の呼び出しを扱うパターンは [unit testing code that uses HttpClient](/ja/2026/04/how-to-unit-test-code-that-uses-httpclient/) を参照してください。

インメモリプロバイダーが .NET チームの一世代に教えたことは、「ローカルで通る」はデプロイのシグナルにはならないということです。本物のデータベース、本物のポート、ワイヤ上の本物のバイト、対価は 10 秒のコールドスタート。安い保険です。

## 関連

- [How to mock DbContext without breaking change tracking](/ja/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/)
- [Removing pooled DbContextFactory for cleaner test swaps in EF Core 11](/ja/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/)
- [Warm up the EF Core model before the first query](/ja/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/)
- [Single-step migrations with `dotnet ef update --add` in EF Core 11](/ja/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/)
- [Unit-testing code that uses HttpClient](/ja/2026/04/how-to-unit-test-code-that-uses-httpclient/)

## 参考資料

- [Microsoft SQL Server module (Testcontainers for .NET docs)](https://dotnet.testcontainers.org/modules/mssql/)
- [ASP.NET Core example (Testcontainers for .NET docs)](https://dotnet.testcontainers.org/examples/aspnet/)
- [Testcontainers.MsSql 4.11.0 on NuGet](https://www.nuget.org/packages/Testcontainers.MsSql)
- [Choosing a testing strategy (EF Core docs)](https://learn.microsoft.com/en-us/ef/core/testing/choosing-a-testing-strategy)
- [Respawn package on NuGet](https://www.nuget.org/packages/Respawn)
