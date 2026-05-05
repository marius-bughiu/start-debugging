---
title: "修正: System.InvalidOperationException: No connection string named 'DefaultConnection' could be found"
description: ".NET 11 で GetConnectionString が null を返す場合、appsettings.json にキーがない、ビルド出力にコピーされていない、または間違った環境ファイルが選ばれているかのいずれかです。3 つのチェックで 95% のケースが解決します。"
pubDate: 2026-05-05
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "ef-core"
  - "configuration"
lang: "ja"
translationOf: "2026/05/fix-no-connection-string-named-defaultconnection"
translatedBy: "claude"
translationDate: 2026-05-05
---

修正方法: `IConfiguration.GetConnectionString("DefaultConnection")` が `null` を返しているため、文字列を期待していた EF Core が例外を投げています。原因は次のいずれかです。`appsettings.json` に `ConnectionStrings:DefaultConnection` のエントリがない、ファイルがビルド出力にコピーされていない、または環境の選択が間違っていてキーが兄弟ファイルにしか存在しない、のいずれかです。JSON を確認し、`Copy to Output Directory = Copy if newer` を設定し、`ASPNETCORE_ENVIRONMENT` が記述したファイルと一致しているかを確認してください。

```text
Unhandled exception. System.InvalidOperationException: No connection string named 'DefaultConnection' could be found in the application configuration.
   at Microsoft.EntityFrameworkCore.SqlServerDbContextOptionsExtensions.UseSqlServer(DbContextOptionsBuilder optionsBuilder, String connectionString, Action`1 sqlServerOptionsAction)
   at Program.<Main>$(String[] args) in C:\src\Api\Program.cs:line 14
   at Program.<Main>(String[] args)
```

このエラーは EF Core の `UseSqlServer(string)` (および Npgsql、MySQL、SQLite の同等の API) が、文字列パラメーターに `null` を受け取ったときに発生します。例外メッセージ自体は EF Core のパラメーター検証から出ていますが、根本原因は常に上流の `Microsoft.Extensions.Configuration` 側にあります。本記事は .NET 11 preview 4、EF Core 11.0.0-preview.4、`Microsoft.AspNetCore.App` 11.0.0-preview.4 を対象に書いていますが、同じ内容は .NET Core 3.1 まで遡って通用します。

## なぜ GetConnectionString は null を返すのか

`IConfiguration.GetConnectionString("X")` は `configuration["ConnectionStrings:X"]` のシンタックスシュガーです。設定システムは登録済みのプロバイダー (JSON ファイル、User Secrets、環境変数、コマンドライン引数) を順番にたどり、最初に見つかった値を返します。`null` が返るということは、**どの**プロバイダーにもそのキーが存在しなかったということです。よくある原因は次の 6 つです。

1. `appsettings.json` にキーがない。
2. キーは存在するが、ファイルが出力ディレクトリにコピーされず、実行中のバイナリがそれを見ていない。
3. キーは `appsettings.Production.json` にあるが、アプリは `Development` で動いており、そこでは `appsettings.Development.json` だけが読み込まれている。
4. EF Core のデザイン時ツール (`dotnet ef migrations add`) が、JSON ファイルのないフォルダーから呼び出されている。
5. キーは User Secrets にあるが、プロジェクトの `.csproj` に `<UserSecretsId>` がない。
6. 接続文字列は環境変数として設定されているが、名前にシングルアンダースコア (`ConnectionStrings_DefaultConnection`) を使っており、必須のダブルアンダースコア (`ConnectionStrings__DefaultConnection`) になっていない。

ケース 2 と 6 は目視では正しく見えるため、サイレントキラーになります。

## 最小再現

`dotnet new webapi -n Api` で作成したクリーンな Web API と、EF Core のひも付けです。エラーを確実に再現できる最小構成です。

```csharp
// .NET 11, C# 14, EF Core 11.0.0
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddDbContext<AppDb>(options =>
    options.UseSqlServer(builder.Configuration.GetConnectionString("DefaultConnection")));

var app = builder.Build();
app.MapGet("/", () => "ok");
app.Run();

public class AppDb : DbContext
{
    public AppDb(DbContextOptions<AppDb> options) : base(options) { }
}
```

```json
// appsettings.json -- this file is what you THINK is being read
{
  "Logging": { "LogLevel": { "Default": "Information" } },
  "AllowedHosts": "*"
}
```

`builder.Configuration.GetConnectionString("DefaultConnection")` は `null` を返し、EF Core は `UseSqlServer(null)` で例外を投げ、ホストの構築に失敗します。例外メッセージには `DefaultConnection` という名前が出てきますが、これは紛らわしい点です。EF Core 側でこの名前が強制されているわけではなく、`GetConnectionString(...)` に渡した文字列がそのまま表示されているだけです。

## 3 つのチェックで直す

順番に実行してください。どれも私自身が一度は引っかかったものです。

### 1. JSON にキーがあることを確認する

`Program.cs` をホストしているプロジェクト (`DbContext` を定義しているプロジェクトとは別なら、そちらではなく前者) の `appsettings.json` を開き、次のセクションを追加します。

```json
// appsettings.json
{
  "ConnectionStrings": {
    "DefaultConnection": "Server=(localdb)\\mssqllocaldb;Database=AppDb;Trusted_Connection=True;TrustServerCertificate=True"
  }
}
```

`UseSqlServer` のプロバイダー名と接続文字列のフォーマットは独立です。SQL Server、PostgreSQL、MySQL、SQLite はいずれも同じ `ConnectionStrings:Name` の形を読みます。JSON にキーはあるけれど `Settings` のような別オブジェクトの中にネストされている場合、`GetConnectionString` は見つけられません。正確なパスは `ConnectionStrings.<Name>` でなければなりません。

### 2. ファイルがビルド出力に含まれているか確認する

これはクラスライブラリや worker サービスでよく踏みます。プロジェクトテンプレートに `appsettings.json` がデフォルトで含まれていないからです。`dotnet build` の後、DLL の隣にファイルがあるか確認してください。

```bash
dotnet build
ls bin/Debug/net11.0/appsettings.json
```

ない場合は、`.csproj` に次を追加します。

```xml
<!-- .NET 11 SDK-style csproj -->
<ItemGroup>
  <None Update="appsettings.json">
    <CopyToOutputDirectory>PreserveNewest</CopyToOutputDirectory>
  </None>
  <None Update="appsettings.*.json">
    <CopyToOutputDirectory>PreserveNewest</CopyToOutputDirectory>
    <DependentUpon>appsettings.json</DependentUpon>
  </None>
</ItemGroup>
```

`Microsoft.NET.Sdk.Web` はこれを暗黙的に含むので、`dotnet new webapi` で作ったプロジェクトには不要です。worker プロジェクト (`Microsoft.NET.Sdk.Worker`) も含みます。素の `Microsoft.NET.Sdk` は含みません。そして、この種のバグの大半はそこに住んでいます。`dotnet ef` のために流用したコンソールホスト、または後から `Program.cs` を生やしたクラスライブラリです。

### 3. 環境を、書き込んだファイルに合わせる

`WebApplication.CreateBuilder` はまず `appsettings.json` を読み、次に `appsettings.{Environment}.json` を読みます。後者が前者を上書きします。環境は `ASPNETCORE_ENVIRONMENT` (Web) または `DOTNET_ENVIRONMENT` (汎用ホスト) から読み込まれ、どちらも未設定なら `Production` が既定値です。よくある失敗例は、接続文字列を `appsettings.Development.json` にだけ書き、本番で実行したときに `appsettings.json` と `appsettings.Production.json` だけが読まれてしまうケースです。

```bash
# powershell
$env:ASPNETCORE_ENVIRONMENT = "Development"

# bash
export ASPNETCORE_ENVIRONMENT=Development

dotnet run
```

スタートアップ時に解決された値を一度だけ出力すると、ログで確認できます。

```csharp
// .NET 11, C# 14
var cs = builder.Configuration.GetConnectionString("DefaultConnection");
Console.WriteLine($"DefaultConnection length: {cs?.Length ?? 0}");
```

本番で接続文字列そのものをログに出してはいけません。たいていパスワードがそこに含まれるからです。長さだけログに出せば、`null`、「読み込まれているが空」、「読み込まれていて中身あり」を区別するには十分です。

## 異なる読み手に効くバリエーション

### クラスライブラリからの `dotnet ef migrations add`

EF Core のデザイン時ツールは、`Program.Main` を呼び出すか `IDesignTimeDbContextFactory<T>` を見つけるかのどちらかで `DbContext` を解決します。`DbContext` がクラスライブラリに置かれている場合、`dotnet ef` は **スタートアッププロジェクト** (Web API) を呼び出してその設定を読みます。正しいフォルダーから実行してください。

```bash
# Bad: connection string is in Api/appsettings.json,
# but you ran this in Data/, where there is no JSON.
cd Data
dotnet ef migrations add Init

# Good: point at the startup project explicitly.
cd Data
dotnet ef migrations add Init --startup-project ../Api/Api.csproj
```

データプロジェクトを単独でマイグレーション実行したい場合 (たとえばリリースパイプラインで)、`IDesignTimeDbContextFactory<AppDb>` を追加します。

```csharp
// .NET 11, EF Core 11.0.0
public class AppDbFactory : IDesignTimeDbContextFactory<AppDb>
{
    public AppDb CreateDbContext(string[] args)
    {
        var config = new ConfigurationBuilder()
            .SetBasePath(Directory.GetCurrentDirectory())
            .AddJsonFile("appsettings.json", optional: false)
            .AddEnvironmentVariables()
            .Build();

        var options = new DbContextOptionsBuilder<AppDb>()
            .UseSqlServer(config.GetConnectionString("DefaultConnection"))
            .Options;

        return new AppDb(options);
    }
}
```

このファクトリーはデザイン時専用で、DI には登録されず、ランタイムでは動きません。

### コンテナーでの環境変数

Docker と Kubernetes の慣習では、設定パスをダブルアンダースコアでフラット化します。`ConnectionStrings:DefaultConnection` は `ConnectionStrings__DefaultConnection` になります。シングルアンダースコアはただの普通の名前で、設定システムは認識しません。

```yaml
# docker-compose, .NET 11
services:
  api:
    image: api:11.0
    environment:
      ASPNETCORE_ENVIRONMENT: Production
      ConnectionStrings__DefaultConnection: "Server=db;Database=App;User Id=sa;Password=..."
```

```bash
# Kubernetes secret reference
- name: ConnectionStrings__DefaultConnection
  valueFrom:
    secretKeyRef:
      name: db
      key: connection
```

変数名は正しいのに値が見えない場合、`AddEnvironmentVariables()` が設定パイプラインに含まれているか確認してください。`WebApplication.CreateBuilder` は呼んでくれます。コンソールプロジェクトのカスタム `ConfigurationBuilder` は、明示的に追加しない限り呼びません。

### 開発環境の User Secrets

`dotnet user-secrets set "ConnectionStrings:DefaultConnection" "..."` は、プロジェクトの `.csproj` に `<UserSecretsId>` 要素がある場合にのみ機能します。

```xml
<!-- .NET 11 SDK-style csproj -->
<PropertyGroup>
  <TargetFramework>net11.0</TargetFramework>
  <UserSecretsId>aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee</UserSecretsId>
</PropertyGroup>
```

`dotnet user-secrets init` がこれを追加してくれます。User Secrets は `IHostEnvironment.IsDevelopment()` が `true` のときだけ読み込まれるので、これもチェック 3 (環境のチェック) が重要なもう一つの理由です。

### Azure Key Vault と他のプロバイダー

`builder.Configuration.AddAzureKeyVault(...)` を使う場合、シークレット名は設定パスに `--` を区切りとして合わせる必要があります。Vault のシークレット名 `ConnectionStrings--DefaultConnection` は `ConnectionStrings:DefaultConnection` として現れます。`DefaultConnection` という名前のシークレットでは現れません。

### 見覚えのない名前がエラーに出ている

メッセージが `No connection string named 'X'` で `X` が自分の入力した名前でない場合、おそらく古い EF Core のオーバーロード `UseSqlServer(connectionStringName: "X")` を呼んでおり、これがアプリの接続文字列テーブルに対して名前を解決しています。EF Core 11 でも後方互換のためにサポートされています。修正は同じで、`ConnectionStrings:X` のエントリを追加するか、名前ではなくリテラルの接続文字列を渡してください。

### Native AOT とトリミング

Native AOT で発行した場合でも、`GetConnectionString` の設定バインディングは引き続き機能します。プレーンな文字列ルックアップだからです。今見ているこのエラーは AOT のトリム警告ではありません。同時に `IL3050` が出ている場合、それは `Configure<T>` のリフレクションベースのバインディングに対する警告であり、接続文字列向けではありません。

## 関連

このエラーの周辺にあたる EF Core の文脈については、[N+1 クエリの検出](/ja/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) のまとめと、[ホットパスでのコンパイル済みクエリ](/ja/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) のガイドを参照してください。同じ接続文字列でテストを組み上げる場合、[Testcontainers のウォークスルー](/ja/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) では、認証情報をコミットせずに fixture ごとに本物の SQL Server を立ち上げる方法を示しています。本番稼働中アプリで、この種のスタートアップ失敗を診断するには、[Serilog と Seq のセットアップ](/ja/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) によって、解決済みの設定値を本番ログ上で読みやすい形にできます。

## 参考資料

- [`IConfiguration.GetConnectionString` extension](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.configuration.configurationextensions.getconnectionstring), Microsoft Learn.
- [Configuration in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/configuration/), Microsoft Learn.
- [Design-time DbContext Creation](https://learn.microsoft.com/en-us/ef/core/cli/dbcontext-creation), EF Core docs.
- [Safe storage of app secrets in development](https://learn.microsoft.com/en-us/aspnet/core/security/app-secrets), Microsoft Learn.
- [Environment variables configuration provider](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/configuration/#environment-variables), Microsoft Learn (`__` 区切り)。
