---
title: ".NET 11 で IWebHostBuilder から WebApplication.CreateBuilder へ移行する"
description: "従来の Startup.cs と WebHostBuilder ホスティングモデルから、WebApplication.CreateBuilder を中心としたミニマルホスティングモデルへ段階的に移行する手順。ASPDEPR008 の非推奨、ミドルウェアの順序、IStartupFilter、そしてテストを動作させ続ける方法を解説します。"
pubDate: 2026-06-06
updatedDate: 2026-06-06
template: migration
tags:
  - "migration"
  - "aspnetcore-11"
  - "dotnet-11"
  - "minimal-hosting"
lang: "ja"
translationOf: "2026/06/migrate-from-iwebhostbuilder-to-webapplication-createbuilder"
translatedBy: "claude"
translationDate: 2026-06-06
---

`Program.cs` がまだ `Host.CreateDefaultBuilder(args).ConfigureWebHostDefaults(web => web.UseStartup<Startup>())` を呼び出している場合、あなたはレガシーなホスティングモデルを使っており、コンパイラがそれについて警告を出し始めています。.NET 10 の時点で `WebHost`、`WebHostBuilder`、`IWebHost` は診断 `ASPDEPR008` とともに廃止予定としてマークされており、その非推奨は .NET 11 にも引き継がれます。代替となるのは `WebApplication.CreateBuilder(args)` を中心に構築されたミニマルホスティングモデルで、これは ASP.NET Core 6.0 以降すべてのプロジェクトテンプレートでデフォルトとなっています。この記事では、ターゲットとして `net11.0` を使い、`Startup` ベースのアプリをミニマルホスティングへ移行します。実際に人々がつまずく部分、つまりミドルウェアの順序、起動時に失われる DI スコープ、`IStartupFilter`、そして `WebApplicationFactory` テストを成功させ続ける方法を取り上げます。

この移行は、小規模なサービスであれば機械的な作業です (1～2 時間)。カスタムミドルウェア、`IStartupFilter` の実装、大きな `ConfigureServices` を持つモノリスであれば半日かかります。アプリケーションの動作については何も変える必要がありません。同じ登録と同じミドルウェアパイプラインを、よりフラットなファイルへ移すだけです。唯一の本質的な意味の違いは起動時の DI スコープで、これは後述します。

## 今移行すべき理由

- `WebHost` / `WebHostBuilder` / `IWebHost` は .NET 10 の時点で `ASPDEPR008` のビルド警告を出します。`TreatWarningsAsErrors` でビルドしている場合、これらから移行するまで .NET 11 へのアップグレードはコンパイルに失敗します。
- ミニマルホスティングモデルは、新しい ASP.NET Core の投資がすべて集まる場所です。ミニマル API 向けの Native AOT、スリム化された `WebApplication.CreateSlimBuilder`、`CreateEmptyBuilder` といった機能は、新しいパスにしか存在しません。
- 2 つのブートストラップファイルが 1 つにまとまります。`Startup.cs` と `CreateHostBuilder` の配線メソッドが、読みやすい単一の `Program.cs` になり、構成、サービス、パイプラインが上から下へ読めるようになります。
- ミニマル API への道が開けます。パイプラインが `Startup.Configure(IApplicationBuilder, IWebHostEnvironment)` のシグネチャの中に存在するコードベースでは、`app.MapGet(...)` をきれいに呼び出すことはできません。

## 何が壊れるか

| 領域                       | 変更                                                                                       | 重大度 |
| -------------------------- | ------------------------------------------------------------------------------------------- | -------- |
| `WebHost` / `IWebHost`     | .NET 10 の時点で廃止予定 (`ASPDEPR008`)。警告、または `TreatWarningsAsErrors` 下ではエラー     | high     |
| `builder.Host` 経由の `Startup`| `WebApplicationBuilder.Host.ConfigureWebHostDefaults(...UseStartup<T>())` は実行時に例外を投げる  | high     |
| 起動時の DI スコープ           | 起動中のサービスプロバイダーの周りにスコープがない。スコープ付きサービスの解決は例外を投げるようになった    | medium   |
| ミドルウェアの順序            | `Configure` の本体は `builder.Build()` の後に、同じ順序で再表現する必要がある             | medium   |
| `IStartupFilter`           | まだ実行されるが、ミニマルホスティングのパイプラインの周りで実行される。順序を確認すること             | low      |
| `IHostingStartup`          | まだサポートされているが、一部のアセンブリでは `WebApplicationBuilder` の読み取り方が異なる         | low      |
| `IWebHostBuilder` (インターフェース)| 限定的な構成 (`UseKestrel`、`UseUrls`) のために `builder.WebHost` 経由で残っている。なくなっていない        | low      |

最後の行に注目してください。`IWebHostBuilder` の*インターフェース*は削除されていません。`WebApplicationBuilder` はそれを `builder.WebHost` として公開しているので、引き続き `builder.WebHost.ConfigureKestrel(...)` を呼び出せます。非推奨になっているのは、スタンドアロンの `WebHost.CreateDefaultBuilder()` ブートストラップと、それがビルドする `IWebHost` です。移行のターゲットは `WebApplication.CreateBuilder` であって、名前に `WebHost` を含むすべての型の削除ではありません。

## 事前チェックリスト

1. すべての開発マシンと CI ランナーに .NET 11 SDK をインストールします。`dotnet --list-sdks` で確認し、`11.0.x` が表示されることを確かめます。
2. プロジェクトがすでに `net6.0` 以降をターゲットにしていることを確認します。ミニマルホスティングモデルは .NET 6 より前には存在しないため、.NET 5 以前のアプリはまずフレームワークの引き上げが必要です。LTS バージョンも併せて越える場合は [.NET 8 から .NET 11 へのチェックリスト](/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/)を、より大きな飛躍については [.NET Framework 4.8 から .NET 11 へのガイド](/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/)を参照してください。
3. `Startup` クラスの棚卸しをします。`ConfigureServices` のすべての行と、`Configure` のすべてのミドルウェア呼び出しを順番にリストアップします。`Configure` の順序は、保持しなければならない契約です。
4. `IStartupFilter` の実装と `IHostingStartup` のアセンブリを grep します。これらは `Startup` の外で実行され、忘れやすいものです。
5. ワンコマンドでロールバックできるよう、クリーンなベースラインをコミットします。

## 移行前: Startup ベースのアプリ

これはほぼすべての 6.0 より前のアプリが共有する形です。2 つのファイルがあり、ホストの配線がサービスとパイプラインの構成から分離されています。

```csharp
// Program.cs -- legacy generic host, ASP.NET Core 3.1 / 5.0 style
// Builds with ASPDEPR008 warnings on .NET 10/11 if WebHost APIs are used
public class Program
{
    public static void Main(string[] args) =>
        CreateHostBuilder(args).Build().Run();

    public static IHostBuilder CreateHostBuilder(string[] args) =>
        Host.CreateDefaultBuilder(args)
            .ConfigureWebHostDefaults(webBuilder =>
            {
                webBuilder.UseStartup<Startup>();
            });
}
```

```csharp
// Startup.cs -- legacy services + pipeline split
public class Startup
{
    public Startup(IConfiguration configuration) => Configuration = configuration;

    public IConfiguration Configuration { get; }

    public void ConfigureServices(IServiceCollection services)
    {
        services.AddControllers();
        services.AddDbContext<AppDbContext>(o =>
            o.UseSqlServer(Configuration.GetConnectionString("DefaultConnection")));
        services.AddScoped<IOrderService, OrderService>();
        services.AddSwaggerGen();
    }

    public void Configure(IApplicationBuilder app, IWebHostEnvironment env)
    {
        if (env.IsDevelopment())
        {
            app.UseDeveloperExceptionPage();
            app.UseSwagger();
            app.UseSwaggerUI();
        }

        app.UseHttpsRedirection();
        app.UseRouting();
        app.UseAuthentication();
        app.UseAuthorization();
        app.UseEndpoints(endpoints => endpoints.MapControllers());
    }
}
```

## 移行ステップ

### 1. ConfigureServices をビルダーへ移す

ビルダーを作成し、`Startup.ConfigureServices` のすべての行をそのままコピーして、`services` を `builder.Services` に置き換えます。`IConfiguration` は `builder.Configuration` として利用できるので、接続文字列のルックアップはそのまま引き継がれます。

```csharp
// Program.cs -- .NET 11, minimal hosting model
var builder = WebApplication.CreateBuilder(args);

// formerly Startup.ConfigureServices, services -> builder.Services
builder.Services.AddControllers();
builder.Services.AddDbContext<AppDbContext>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("DefaultConnection")));
builder.Services.AddScoped<IOrderService, OrderService>();
builder.Services.AddSwaggerGen();
```

確認: `dotnet build` を実行します。パイプラインに手を付ける前に、サービス登録が配置された状態でプロジェクトがコンパイルされるはずです。ある登録が `builder.Configuration` の解決に失敗する場合、もう存在しない `Configuration` フィールド参照をコピーしています。それを `builder.Configuration` に置き換えてください。

### 2. アプリをビルドし、パイプラインを同じ順序で再表現する

`builder.Build()` を呼び出し、`Startup.Configure` を一行ずつ翻訳します。`IApplicationBuilder app` は `WebApplication app` になり、`env.IsDevelopment()` は `app.Environment.IsDevelopment()` になります。順序こそがパイプラインなので、ミドルウェアの順序は元のものと正確に一致させなければなりません。

```csharp
// .NET 11, minimal hosting model -- continued
var app = builder.Build();

// formerly Startup.Configure, same order
if (app.Environment.IsDevelopment())
{
    app.UseDeveloperExceptionPage();
    app.UseSwagger();
    app.UseSwaggerUI();
}

app.UseHttpsRedirection();
app.UseAuthentication();
app.UseAuthorization();

app.MapControllers();

app.Run();
```

2 つのものが縮みました。`UseRouting` と `UseEndpoints` はもう必要ありません。ミニマルホストはルーティングミドルウェアを自動的に追加し、`app.MapControllers()` が `UseEndpoints(e => e.MapControllers())` ブロックを置き換えます。ルーティングとエンドポイント実行の*間*で実行しなければならないミドルウェア (たとえば、一致したエンドポイントのメタデータを読むカスタムミドルウェア) がある場合は、明示的な `app.UseRouting()` 呼び出しを残し、そのミドルウェアをその後に配置してください。そうでなければ両方とも削除します。

確認: `dotnet run` を実行し、既知のルートにアクセスします。コントローラーアクションでの 200 はパイプラインが配線されていることを確認します。すべてのルートで 404 が出る場合は、通常 `MapControllers` が欠けているか、終端ミドルウェアより前に置かれていることを意味します。

### 3. Startup.cs と CreateHostBuilder の配線を削除する

`Program.cs` がすべてを保持したら、`Startup.cs` と古い `CreateHostBuilder` メソッドを削除します。`builder.Host.ConfigureWebHostDefaults(web => web.UseStartup<Startup>())` を呼び出して `Startup` を生かし続けようとしないでください。それは実行時に例外を投げます。ミニマルホスティングでは、`WebApplicationBuilder` を使い始めると、`builder.Host` や `builder.WebHost` 経由で Web ホストを構成することは禁止されます。

`Startup` を一度に削除できない場合 (段階的に移行したい巨大な `ConfigureServices` がある場合) は、ホスト経由でルーティングするのではなく手動でインスタンス化するのがブリッジパターンです。

```csharp
// .NET 11 -- temporary bridge, not the WebApplicationBuilder.Host path
var builder = WebApplication.CreateBuilder(args);
var startup = new Startup(builder.Configuration);
startup.ConfigureServices(builder.Services);

var app = builder.Build();
startup.Configure(app, app.Environment); // Configure must accept IApplicationBuilder
app.Run();
```

これがコンパイルできるのは、`WebApplication` が `IApplicationBuilder` と `IEndpointRouteBuilder` を実装しているからです。これは単一の PR のための足場と見なし、最終的な到達点とは考えないでください。

確認: ソリューション内で `UseStartup`、`WebHost.CreateDefaultBuilder`、`ConfigureWebHostDefaults` を検索します。ヒットがゼロであれば、レガシーなブートストラップはなくなっており、`ASPDEPR008` は発生しません。

### 4. ホストと Kestrel の構成をビルダーへ移す

古い `IWebHostBuilder` で構成していたもの (Kestrel の制限、URL、コンテンツルート) は、引き続き `IWebHostBuilder` のサーフェスを公開している `builder.WebHost` へ移します。ジェネリックホストの関心事 (ロギング、Serilog 統合、`UseWindowsService`) は `builder.Host` へ移します。

```csharp
// .NET 11 -- host/web host configuration on the new builder
builder.WebHost.ConfigureKestrel(k => k.Limits.MaxRequestBodySize = 50 * 1024 * 1024);
builder.Host.UseSerilog((ctx, cfg) => cfg.ReadFrom.Configuration(ctx.Configuration));
```

確認: 構成した制限が有効になっていること (制限を超えるリクエストボディが `413` を返す) と、ロギングシンクが引き続きエントリを受け取っていることを確認します。

## 検証

マージする前に、移行後にこのチェックリストを実行してください。

- `dotnet build` が `ASPDEPR008` 警告ゼロ、`UseStartup` 参照ゼロを生成すること。
- `dotnet run` が起動し、既知のルートを期待されるステータスコードで提供すること。
- `dotnet test` が、すべての `WebApplicationFactory` 統合テストを含めて成功すること (下記の落とし穴を参照)。
- ミドルウェアに依存する動作がエンドツーエンドで引き続き機能すること。認証チャレンジ、HTTPS リダイレクト、CORS プリフライト、例外ハンドラーのレスポンス。
- Kestrel の制限を超えるリクエストボディが引き続き `413` を返し、ホスト構成が移行されたことを確認すること。

## ロールバック計画

この移行は `Startup.cs` を削除するまでは元に戻せます。安全な手順は、ステップ 1 と 2 をブランチ上で行い、テストが成功することを確認し、その後にだけレガシーファイルを別のコミットで削除することです。削除後に何かが退行した場合は、削除コミットを `git revert` して `Startup.cs` と古い `Program.cs` を復元します。`Startup` パターンは .NET 11 でも引き続き動作する (警告が出るだけで、削除されてはいない) ため、一時的な revert でデバッグしながら出荷を続けられます。後戻りできない地点はジェネリックホストのブートストラップを完全に削除することです。それは独立したコミットに収めてください。

## 私たちがぶつかった落とし穴

**起動時の DI スコープがなくなった。** 古いジェネリックホストはサービスプロバイダーをビルドする際に DI スコープを作成していたので、起動中にスコープ付きサービスを解決するコードはたまたま動作していました。ミニマルホスティングはそうしません。マイグレーションやシード処理を実行するために `Configure` で `DbContext` を解決していた場合、いまでは `Cannot resolve scoped service '...' from root provider` が発生します。起動時の作業を明示的なスコープで囲んでください。

```csharp
// .NET 11 -- explicit scope for startup-time scoped resolution
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    db.Database.Migrate();
}
app.Run();
```

これは移行で最もよくある実行時の破綻です。一般的なルールとそのバリエーションは、[シングルトンからスコープ付きサービスを解決する](/2026/05/fix-cannot-consume-scoped-service-from-singleton/)と [BackgroundService 内でスコープ付きサービスを使う](/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/)で取り上げています。

**`WebApplicationFactory<TStartup>` には指し示すべき `Startup` がもうない。** `WebApplicationFactory<Startup>` を参照していた統合テストは、新しいエントリポイント型が必要です。ミニマルホストのエントリポイントは自動生成される `Program` クラスですが、これは `internal` なので、テストプロジェクトからは見えません。`Program.cs` の末尾に partial 宣言を追加して公開します。

```csharp
// Program.cs -- end of file, .NET 11
public partial class Program { }
```

そして、テストファクトリーを `WebApplicationFactory<Program>` に変更します。partial 宣言がないと、テストプロジェクトで `'Program' is inaccessible due to its protection level` が出ます。

**`IStartupFilter` はまだ実行されるが、順序がずれる。** `services.AddTransient<IStartupFilter, MyFilter>()` 経由で登録されたフィルターは引き続き実行され、構成されたパイプラインを包みます。ミニマルホスティングでは、それらが包む明示的な `Configure` メソッドがないため、ルーティングのセットアップより前に実行されると想定していたフィルターが、いまでは少し異なる位置で実行される可能性があります。`IStartupFilter` を純粋にライブラリからミドルウェアを注入するために使っていた場合は、そのミドルウェアが `app.Use...` 呼び出しに対してどこに着地するかを監査し、リクエストの動作が異なる場合は並べ替えてください。

**一致したエンドポイントを読むミドルウェアには明示的な `UseRouting` が必要。** `UseRouting` を削除するのは一般的なケースでは問題ありませんが、`context.GetEndpoint()` を呼び出すミドルウェアがある場合、それはルーティングが実行された後に置かなければなりません。そのミドルウェアの前に `app.UseRouting()` を再追加し、`app.MapControllers()` をその後に保ちます。2 つのエンドポイントスタイルのより深い比較については、[ASP.NET Core 11 におけるミニマル API とコントローラーの比較](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)を参照してください。

**名前付きオプションの順序依存の登録。** 一部のチームは、ライブラリの `IHostingStartup` より前に `ConfigureServices` が実行されることに依存していました。ミニマルホストは `builder.Build()` の時点で `builder.Services` を積極的に評価するため、コレクションをキャプチャするライブラリ拡張を呼び出した後にサービスを登録していた場合、タイミングが異なることがあります。これはまれですが、移行後に構成したオプションが null で返ってくる場合は、それを消費する `Add...` 呼び出しより後に登録していないか確認してください。

`WebApplication.CreateBuilder` に移行すれば、残りのモダンなサーフェスが開けます。コントローラーと並ぶミニマル API エンドポイント、Native AOT 向けの `CreateSlimBuilder`、そして [ASP.NET Core 11 にグローバル例外ハンドラーを追加する](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/)で示されたよりクリーンな例外処理です。ホスティングの移行が関門であり、それ以外はそこから段階的に進められます。

## ソース

- [WebHostBuilder, IWebHost, and WebHost are obsolete](https://learn.microsoft.com/en-us/dotnet/core/compatibility/aspnet-core/10/webhostbuilder-deprecated) (.NET の破壊的変更、診断 `ASPDEPR008`)
- [Migrate from ASP.NET Core in .NET 5 to .NET 6](https://learn.microsoft.com/en-us/aspnet/core/migration/50-to-60) (元のミニマルホスティング移行ガイド)
- [Code samples migrated to the new minimal hosting model](https://learn.microsoft.com/en-us/aspnet/core/migration/50-to-60-samples) (移行前後の `Startup` の例)
- [Deprecating WebHostBuilder, IWebHost, and WebHost](https://github.com/dotnet/aspnetcore/discussions/63480) (dotnet/aspnetcore discussion #63480)
