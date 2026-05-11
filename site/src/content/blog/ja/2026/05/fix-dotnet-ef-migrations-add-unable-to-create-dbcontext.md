---
title: "Fix: dotnet ef migrations add が 'Unable to create an object of type DbContext' で失敗する"
description: "EF Core の設計時ツールが DbContext のインスタンスを作成できませんでした。WebApplication.CreateBuilder で host を公開するか、正しい startup project を指定するか、IDesignTimeDbContextFactory を実装してください。"
pubDate: 2026-05-11
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "ef-core-11"
  - "migrations"
lang: "ja"
translationOf: "2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext"
translatedBy: "claude"
translationDate: 2026-05-11
---

解決策: `dotnet ef` は設計時にアプリを実行して `DbContext` を発見します。失敗したのは、エントリポイントがツールから調べられる host を返さなかったか、`DbContext` の コンストラクターパラメーターが host なしでは解決できないためです。Web アプリでは、`Program.cs` が `WebApplication` をビルドして使用 (もしくは返却) するようにしてください。クラスライブラリまたはテストプロジェクトでは、`IDesignTimeDbContextFactory<TContext>` の実装を追加します。そして `--startup-project` をデータプロジェクトではなく host プロジェクトに向けて再実行してください。

```text
Unable to create an object of type 'AppDbContext'. For the different patterns supported at design time, see https://go.microsoft.com/fwlink/?linkid=851728
```

このガイドは `Microsoft.EntityFrameworkCore.Design` 11.0.0-preview.4、`dotnet-ef` 11.0.0-preview.4、.NET 11 SDK preview 4 を対象としています。同じ挙動は EF Core 3.1 までさかのぼって当てはまります。generic host の導入以降、設計時の検出ルールは形を変えていません。まだ EF Core 6 または 8 を使っている場合でも、以下の修正はすべて機能し、名前空間がわずかに違うだけです。

## 設計時ツールはどうやって DbContext を見つけるか

`dotnet ef migrations add Init` を実行しても、ツールは静的にコードをスキャンしません。プロジェクトをビルドし、得られたアセンブリをロードして、次の 4 つのうちのいずれかを、この順序で探します。

1. startup project にある `IDesignTimeDbContextFactory<TContext>` の実装。
2. `Program.Main` から返される、または暗黙の `WebApplication` ビルダーパターンで公開された host。ツールはそれに対して `IHost.Services.GetRequiredService<TContext>()` を呼び出します。
3. パラメーターのない public コンストラクターを持つ `DbContext`。ツールは `new TContext()` を直接呼び出します。
4. 注入されたサービスに依存しない `OnConfiguring` を持つ `DbContext`。

どれもインスタンスを生成しなければ、`Unable to create an object of type 'X'` エラーが出ます。メッセージ内のハイパーリンクは、同じ 4 つの経路を列挙する設計時ドキュメントを指しています。

## 典型的な Web アプリでなぜ起きるか

ほとんどのプロジェクトは経路 2 で失敗します。ツールは `Program.cs` を呼び出せても、調べるべき host を見つけられないのです。2026 年に経路 2 を壊しやすいのは 3 つの要因です。

1. `Program.cs` が `WebApplication` をビルドするが、トップレベルステートメントの順序のせいでツールが `Services` を読む前に終了する。
2. `DbContext` が `--startup-project` として渡されたものとは別のアセンブリに登録されている。ツールが間違ったプロジェクトを実行した。
3. `DbContext` の コンストラクターがカスタム型 (テナントリゾルバー、時計、機能フラグサービス) を受け取り、DI コンテナーが `app.Run()` の実際の実行なしでは解決できない。

最初のものが静かな殺し屋です。トップレベルステートメントでは、コンパイラーが `Program.Main` を合成し、その戻り値型と最後のステートメントが EF Core にとって重要になります。`app.Run()` が最後の式なら、ツールは合成された `Program` クラスに対するリフレクションで host を読み取ります。`run` 呼び出しを条件で包んだり、早期に `return` したりすると、host はツールに届きません。

## 最小再現

これがエラーを再現する最小プロジェクトです。`WebApi` プロジェクト 1 つ、注入された依存性を持つ `DbContext` 1 つ、design-time factory なし。

```csharp
// AppDbContext.cs - .NET 11, EF Core 11.0.0-preview.4
using Microsoft.EntityFrameworkCore;

public sealed class AppDbContext : DbContext
{
    private readonly ITenantResolver _tenant;

    public AppDbContext(DbContextOptions<AppDbContext> options, ITenantResolver tenant)
        : base(options)
    {
        _tenant = tenant;
    }

    public DbSet<Order> Orders => Set<Order>();
}

public interface ITenantResolver { string Current { get; } }
public sealed class Order { public int Id { get; set; } public string TenantId { get; set; } = ""; }
```

```csharp
// Program.cs - .NET 11
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddScoped<ITenantResolver, HttpHeaderTenantResolver>();
builder.Services.AddDbContext<AppDbContext>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("Default")));

var app = builder.Build();

if (args.Contains("--migrate-only"))
{
    return; // <-- design-time tool reads this path, never reaches app.Run()
}

app.Run();
```

このプロジェクトに対して `dotnet ef migrations add Init` を実行するとエラーが表示されます。`ITenantResolver` の登録は `builder.Build()` の後にしか起きないのに、早期の `return` が合成された `Main` を断ち切り、EF Core の host 探索は部分的に初期化された状態を見ます。検出コードは `new AppDbContext()` も試しますが、コンストラクターが引数 2 つを必要とするため失敗します。

## 解決策 1 - host を発見可能にする (Web アプリ向け推奨)

最もきれいな解決策は、条件付き早期 return を入れずに `Program.cs` に host の初期化を最後まで行わせることです。EF Core の設計時 host factory は `HostFactoryResolver` を使って、コンパイル後の `Program.Main` をたどり `IHost` 参照を取得します。そのトラバースを妨げるものは、EF Core が context を見つけるのも妨げます。

```csharp
// Program.cs - .NET 11, EF Core 11.0.0-preview.4
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddScoped<ITenantResolver, HttpHeaderTenantResolver>();
builder.Services.AddDbContext<AppDbContext>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("Default")));

var app = builder.Build();

app.MapGet("/", () => "ok");

app.Run();
```

この変更ひとつで十分なことが多いです。`--verbose` フラグで確認してください。

```bash
dotnet ef migrations add Init --verbose
```

`Finding design-time services...`、`Using application service provider from Microsoft.Extensions.Hosting.IHostBuilder.`、`Using DbContext factory 'AppDbContext'.` のような行が表示されるはずです。`--verbose` が `No host builder was found` と報告するなら、経路 2 はまだ壊れており、解決策 2 か解決策 3 が必要です。

本番環境で `app.Run()` の前に終了するコンソールランナーのために `--migrate-only` スイッチが本当に必要なら、host のビルドの後に置き、void ではなく **host を返す** ようにして、合成された `Main` が依然として host 参照で終わるようにしてください。

```csharp
// Program.cs - .NET 11
var app = builder.Build();
app.MapGet("/", () => "ok");

if (args.Contains("--migrate-only"))
{
    using var scope = app.Services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    db.Database.Migrate();
}

app.Run();
```

設計時ツールは依然として `app.Run()` を終端ステートメントと見なし、それを呼ぶ前に `app.Services` を調べられます。

## 解決策 2 - 正しい startup project を指す

`Web` プロジェクトが `Data` クラスライブラリを参照するソリューションは、2 番目に多い原因です。`DbContext` のある `Data/` の中から `dotnet ef migrations add Init` を実行し、ツールが `Web` に登録された host を使うと期待する人がいます。使いません。ツールは **現在の** プロジェクト (もしくは `--project` で指定したもの) をビルドし、**そのアセンブリ** の中で host を探します。

```bash
# Run from the solution root, EF Core 11.0.0-preview.4 / .NET 11
dotnet ef migrations add Init \
  --project src/Data/Data.csproj \
  --startup-project src/Web/Web.csproj
```

`--project` はマイグレーションファイルが書き込まれる場所、`--startup-project` は host のある場所です。両者が同じプロジェクトでないときは両フラグが必須です。多くのチームは `Directory.Build.props` や `Makefile` でエイリアスにして、長い呼び出しを毎回打たずに済ませています。

ツールが実際にどのアセンブリをロードしたかは `dotnet ef dbcontext info --startup-project src/Web/Web.csproj` で確認できます。解決された型名、プロバイダー、接続文字列のソースが表示されます。`info` は通るのに `migrations add` が失敗するなら、これは検出ではなくコンストラクターの問題です。解決策 3 にジャンプしてください。

## 解決策 3 - IDesignTimeDbContextFactory を実装する

host のないクラスライブラリ (パッケージ化されたデータレイヤー、テストプロジェクト、ホストされた Blazor WebAssembly の共有プロジェクトの典型的な構成) では、調べるべき `Program.Main` がありません。`DbContext` と同じプロジェクトに factory を追加します。

```csharp
// DesignTimeDbContextFactory.cs - .NET 11, EF Core 11.0.0-preview.4
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

public sealed class DesignTimeDbContextFactory : IDesignTimeDbContextFactory<AppDbContext>
{
    public AppDbContext CreateDbContext(string[] args)
    {
        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseSqlServer("Server=(localdb)\\MSSQLLocalDB;Database=design-time;Trusted_Connection=True;TrustServerCertificate=True")
            .Options;

        return new AppDbContext(options, new DesignTimeTenantResolver());
    }

    private sealed class DesignTimeTenantResolver : ITenantResolver
    {
        public string Current => "design-time";
    }
}
```

EF Core の検出は host をたどる **前** に `IDesignTimeDbContextFactory<TContext>` の有無を確認するので、この実装は他のすべてを上書きします。そのため最も信頼できる解決策ですが、代償もあります。接続文字列が重複するのです。それを避けたいなら `appsettings.json` から読み込みましょう。

```csharp
// EF Core 11.0.0-preview.4 - read connection string from config
public AppDbContext CreateDbContext(string[] args)
{
    var config = new ConfigurationBuilder()
        .SetBasePath(Directory.GetCurrentDirectory())
        .AddJsonFile("appsettings.json", optional: false)
        .AddJsonFile($"appsettings.{Environment.GetEnvironmentVariable("DOTNET_ENVIRONMENT") ?? "Development"}.json", optional: true)
        .AddEnvironmentVariables()
        .Build();

    var options = new DbContextOptionsBuilder<AppDbContext>()
        .UseSqlServer(config.GetConnectionString("Default"))
        .Options;

    return new AppDbContext(options, new DesignTimeTenantResolver());
}
```

ファイルコピーについての注意: `appsettings.json` はツールを実行するプロジェクトで `Copy if newer` に設定する必要があります。そうしないと作業ディレクトリにファイルが置かれません。検出エラーを越えて代わりに `null` の接続文字列に行き着いたなら、それは [No connection string named DefaultConnection エラーの正典記事](/ja/2026/05/fix-no-connection-string-named-defaultconnection/) で扱っているのと同じ罠です。

## 解決策 4 - args 契約の罠

すでに design-time factory があるのに CI でまだエラーが出るなら、`args` パラメーターを確認してください。EF Core のツールは自分の引数リストを `CreateDbContext(string[] args)` に渡します。それをアプリの `args` と勘違いして未知のフラグを拒否するコードは、context を返す前に例外を投げます。ツールはその投げを検出失敗として報告します。

```csharp
// Wrong - throws on EF Core's own args
public AppDbContext CreateDbContext(string[] args)
{
    if (args.Length != 2) throw new ArgumentException("expected env and db");
    ...
}
```

検証を消すか、設計時の `args` は不透明だと受け入れて代わりに `Environment.GetEnvironmentVariable` を使ってください。

## このエラーに似て非なるエラー

- **`Could not load file or assembly 'Microsoft.EntityFrameworkCore.Design'`**。startup project に `Microsoft.EntityFrameworkCore.Design` パッケージを追加し忘れました。`DbContext` が別の場所にあっても、ツールはスタートアセンブリの bin フォルダーからロードするため、そこに参照が必要です。
- **`No project was found`**。`.csproj` のないフォルダーで `dotnet ef` を実行しました。プロジェクトルートから実行するか、`--project` を渡してください。
- **`The command 'dotnet-ef' could not be found`**。ローカルツールマニフェストが欠けています。`dotnet new tool-manifest` と `dotnet tool install dotnet-ef --version 11.0.0-preview.4` を実行してください。バージョン固定が重要です: 何年も前にインストールしたグローバルの `dotnet-ef` はランタイムと黙ってずれます。
- **`Cannot consume scoped service from singleton`**。検出は成功したものの DI 登録が誤っています。これは別のエラーで、[scoped と singleton のライフタイム修正](/ja/2026/05/fix-cannot-consume-scoped-service-from-singleton/) が扱います。
- **`A second operation was started on this context instance`**。これも別のエラーですが、EF Core ユーザーは同じ検索の沼を経由してたどり着きます。[DbContext の並行性についての記事](/ja/2026/05/fix-second-operation-was-started-on-this-context-instance/) がステップごとに説明します。

## どの解決策も効かないときのデバッグチェックリスト

4 つすべてを試したのにツールがまだ context を見つけられない場合、このチェックリストを順にたどってください。GitHub で EF Core チームの triage ラベル "design-time" が推奨しているリストと同じです。

1. `dotnet build` がアセンブリ不足の警告なしで成功する。ツールはビルド出力に対して動くので、緑のビルドは前提条件です。
2. `dotnet ef dbcontext list --startup-project src/Web/Web.csproj` が context 名を表示する。これも失敗するなら、アセンブリは context を一度もロードしていません。`AddDbContext` が抜けている可能性が高いです。
3. `dotnet ef dbcontext info` がプロバイダーと接続文字列を表示する。これが成功するのに `migrations add` が失敗するなら、`DbContext` の コンストラクターが実際に呼ばれたときに例外を投げています。ログを追加してください。
4. startup project の `TargetFramework` が `dotnet-ef` ツールのランタイムと一致する。EF Core 11 のツールは .NET 11 を対象とします。`netstandard2.0` だけを対象としたプロジェクトは調べられません。
5. startup project が `Microsoft.EntityFrameworkCore.Design` とプロバイダーパッケージ (`Microsoft.EntityFrameworkCore.SqlServer`、`Npgsql.EntityFrameworkCore.PostgreSQL` など) の両方を参照している。
6. `Program.cs` がエントリポイントである。複数の `Main` メソッドがあったり、それを隠す `OutputType` 設定を使っていたりすると、検出が失敗します。

`dotnet ef dbcontext info` が端から端まで通れば、他のコマンドはすべて通ります。これは最良の smoke test であり、実際のマイグレーションを実行するより早いです。

## 関連

- [EF Core 11 のシングルステップマイグレーションワークフロー](/ja/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/) は、定型的なスキーマ更新のために導入された結合コマンド `dotnet ef migrations update --add` を扱います。
- 実行時の DI スコープエラーについては [singleton から scoped サービスの修正](/ja/2026/05/fix-cannot-consume-scoped-service-from-singleton/) を参照してください。
- 設計時に `GetConnectionString` が null を返す場合は [接続文字列欠落についての記事](/ja/2026/05/fix-no-connection-string-named-defaultconnection/) を参照してください。
- 設計時の検出にまったく触れずにデータレイヤーをテストするには、[Testcontainers での統合テスト](/ja/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) がマイグレーションツールチェーンからテストプロジェクトを独立させます。
- 最初のリクエスト前にモデル作成をウォームアップするには、[EF Core モデルのウォームアップ](/ja/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/) が関連するコールドパス問題をカバーします。

## 参照

- [Design-time DbContext Creation - EF Core docs](https://learn.microsoft.com/en-us/ef/core/cli/dbcontext-creation)
- [EF Core Tools Reference - dotnet ef](https://learn.microsoft.com/en-us/ef/core/cli/dotnet)
- [HostFactoryResolver source on dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Hosting/src/Internal/HostFactoryResolver.cs)
- [EF Core issue 21025: design-time discovery on top-level statements](https://github.com/dotnet/efcore/issues/21025)
- [WebApplication and the generic host - ASP.NET Core docs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis)
