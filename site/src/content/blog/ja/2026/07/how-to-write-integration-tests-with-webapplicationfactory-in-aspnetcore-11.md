---
title: "ASP.NET Core 11 で WebApplicationFactory<T> を使って統合テストを書く方法"
description: "ASP.NET Core 11 における WebApplicationFactory<TEntryPoint> の完全ガイドです。Program エントリポイントを到達可能にする方法、ConfigureTestServices と ConfigureWebHost の違い、IDbContextOptionsConfiguration 経由での EF Core 登録の差し替え、.NET 11 プレビュー 6 の新しい ConfigureHostApplicationBuilder フック、認証の偽装、WebApplicationFactoryClientOptions、そして実際のポートが必要なときの UseKestrel を解説します。"
pubDate: 2026-07-26
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "testing"
  - "integration-tests"
  - "xunit"
lang: "ja"
translationOf: "2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-26
---

ASP.NET Core 11 で `WebApplicationFactory<TEntryPoint>` を使う統合テストを書くには、テストプロジェクトから `Microsoft.AspNetCore.Mvc.Testing` を参照し、`Program.cs` の末尾に `public partial class Program { }` を追加してアプリのエントリポイントを到達可能にし、`IClassFixture<T>` 経由で xUnit のテストクラスに `WebApplicationFactory<Program>` を注入して `CreateClient()` を呼び出します。この `HttpClient` は、ソケットもポートも `dotnet run` も使わず、メモリ内トランスポート越しに実際のミドルウェアパイプラインと実際の DI コンテナーと通信します。それ以外のこと (サービスをテストダブルに差し替える、EF Core を別のデータベースに向ける、認証済みユーザーを偽装する) はすべて `ConfigureWebHost` または `WithWebHostBuilder` の中で行います。本記事は .NET 11 (執筆時点ではプレビュー 6、GA は 2026 年 11 月) と C# 14 を対象とし、.NET 9 以降に追加された 2 つの API、つまり .NET 10 の `UseKestrel` と .NET 11 プレビュー 6 の `ConfigureHostApplicationBuilder` を取り上げます。それ以外は .NET 8、9、10 でもそのまま動作します。

## ファクトリーが実際に起動するもの

`WebApplicationFactory<TEntryPoint>` は `dotnet run` と同じようにアプリを起動するわけではありません。`HostFactoryResolver` を使ってエントリポイントを呼び出し、実行される直前の `IHost` を横取りし、サーバー実装を `TestServer` に差し替えて、構築済みのホストを返します。この帰結は理解しておく価値があります。意外に見える挙動のほとんどはここから説明できるからです。

- あなたの `Program.cs` は実行されます。`builder.Services.Add*` の呼び出し、ミドルウェアの登録、`MapGet` はすべて本番とまったく同じように実行されます。
- ネットワークソケットは開かれません。`TestServer` はメモリ内の `HttpMessageHandler` の上に `IServer` を実装しているため、リクエストはトランスポート層を完全に飛ばします。Kestrel は関与しないので、HTTPS へのリダイレクト、HTTP/2 のネゴシエーション、接続数の上限は検証されません。
- DI コンテナーは本番のコンテナーに、`ConfigureTestServices` で重ねたものを足したものです。シングルトンはファクトリーの寿命だけ生き続けるため、リセットしない限り同じフィクスチャ内のテスト間で状態が漏れます。

最後の点こそが本当の価値です。単体テストが教えてくれるのは、ハンドラーが正しいオブジェクトを返すことだけです。統合テストは、ルートテンプレートが一致すること、モデルバインディングがボディを解析すること、認可ポリシーが呼び出し元を通すこと、フィルターパイプラインが正しい順序で走ること、そしてネットワーク上の JSON がクライアントの期待するプロパティ名を持つことを教えてくれます。ハンドラーを直接呼ぶだけでは、そのどれも検証されません。

## WebApplicationFactory のテストを追加する手順

1. テストプロジェクトを追加し、`Microsoft.AspNetCore.Mvc.Testing` とテスト対象アプリへのプロジェクト参照を追加します。
2. アプリの `Program.cs` に `public partial class Program { }` を追記して、エントリポイントを公開します。
3. `IClassFixture<T>` 経由でテストクラスに `WebApplicationFactory<Program>` を注入し、`CreateClient()` を呼び出します。
4. サービスや構成を差し替える必要があるときは、独自のファクトリーを派生させて `ConfigureWebHost` をオーバーライドします。
5. クラス内の他のテストに影響を与えたくないテスト単位の差し替えには `WithWebHostBuilder` を使います。
6. ホストとそのシングルトンはフィクスチャ全体で共有されるため、テスト間で共有状態をリセットします。

## 必要なパッケージ

```xml
<!-- .NET 11 preview 6, test project -->
<ItemGroup>
  <PackageReference Include="Microsoft.AspNetCore.Mvc.Testing" Version="11.0.0-preview.6.*" />
  <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.14.0" />
  <PackageReference Include="xunit.v3" Version="3.1.0" />
  <PackageReference Include="xunit.runner.visualstudio" Version="3.1.0" />
</ItemGroup>

<ItemGroup>
  <ProjectReference Include="..\..\src\Orders.Api\Orders.Api.csproj" />
</ItemGroup>
```

.NET 10 では `Microsoft.AspNetCore.Mvc.Testing` の安定版 `10.0.0` を使ってください。xUnit v2 からまだ移行していない場合でも、`xunit` 2.9.x は以下の内容すべてについて同じように動作します。唯一の違いは `IAsyncLifetime` のシグネチャで、これはライフサイクルの節で扱います。

`Microsoft.AspNetCore.Mvc.Testing` は名前に反して MVC 専用ではありません。minimal API、コントローラー、Razor Pages、Blazor Server のいずれでも動作します。さらに、ファクトリーがアプリのコンテンツルートを見つけられるように、テストアセンブリへ `WebApplicationFactoryContentRootAttribute` を刻む MSBuild ターゲットも同梱されています。これは静的ファイルや Razor ビューにとって重要です。

## エントリポイントを到達可能にする

最初の試みの多くはここで止まります。トップレベルステートメントは `Program` という名前のクラスにコンパイルされますが、そのアクセシビリティは `internal` なので、テストアセンブリから参照するとコンパイル時に失敗します。

```
error CS0122: 'Program' is inaccessible due to its protection level
```

修正は `Program.cs` の一番下、`app.Run()` の後の 1 行です。

```csharp
// .NET 11, C# 14 -- Program.cs, last line
app.Run();

public partial class Program { }
```

コンパイラーがあなたの partial 宣言と生成された宣言をマージし、クラスは public になります。もう 1 つの方法はアプリ側プロジェクトに `[assembly: InternalsVisibleTo("Orders.Api.Tests")]` を書くことですが、こちらは `Program` を internal のままにする代わりに、他のすべての internal な型もテストアセンブリに開いてしまいます。方針上の理由がない限り、partial クラスを選んでください。

関連する失敗は実行時に次のように現れます。

```
System.InvalidOperationException: The entry point exited without ever building an IHost.
```

これは、リゾルバーが `Program.cs` を最後まで実行したのに、ホストが構築されるのを一度も見なかったという意味です。よくある原因は、引数のあるパスでの早期 `return`、`Environment.Exit` を呼ぶ `Main`、起動中に投げられて握りつぶされた例外です。アプリの起動コードはテスト中にも本当に実行される点に注意してください。接続文字列を読み、欠けていれば例外を投げる `Program.cs` は、ここでも同じように例外を投げます。起動時に依存している構成は、テストプロセスからも利用できる必要があります。

## 最初のテスト

エントリポイントを公開すれば、既定のファクトリーはサブクラスすら必要としません。

```csharp
// .NET 11, xUnit v3
using System.Net;
using Microsoft.AspNetCore.Mvc.Testing;

public sealed class OrdersEndpointTests
    : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly HttpClient _client;

    public OrdersEndpointTests(WebApplicationFactory<Program> factory)
        => _client = factory.CreateClient();

    [Fact]
    public async Task Unknown_order_returns_404()
    {
        var response = await _client.GetAsync("/orders/does-not-exist");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Theory]
    [InlineData("/health")]
    [InlineData("/orders")]
    public async Task Endpoint_returns_json(string url)
    {
        var response = await _client.GetAsync(url);

        response.EnsureSuccessStatusCode();
        Assert.Equal("application/json; charset=utf-8",
            response.Content.Headers.ContentType?.ToString());
    }
}
```

`IClassFixture<T>` はテストクラスごとに 1 回ファクトリーを構築し、そのクラスの最後のテストが終わったら破棄します。`CreateClient` は何度でも呼べます。呼び出しごとに、同じホストに結び付いた新しい `HttpClient` が、それぞれ独自の cookie コンテナーを持って返ってきます。

## ConfigureTestServices でサービスを差し替える

偽の決済ゲートウェイや別のデータベースが必要になった時点で、ファクトリーを派生させて `ConfigureWebHost` をオーバーライドします。`ConfigureServices` ではなく `ConfigureTestServices` を使ってください。

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

public sealed class OrdersApiFactory : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");

        builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<IPaymentGateway>();
            services.AddSingleton<IPaymentGateway, StubPaymentGateway>();
        });
    }
}
```

この違いは重要です。`ConfigureServices` のコールバックはアプリ自身のものと並んで登録順に実行されるため、`Program.cs` が実装を追加する前にあなたのコールバックが走る可能性があります。`ConfigureTestServices` はアプリのサービス登録が完了するまで意図的に遅延されており、それが「最後の登録が勝つ」上書きを確実にしています。

「最後が勝つ」が当てはまるのは、単一サービスの解決だけです。`GetRequiredService<IPaymentGateway>()` は最後の登録を返しますが、`GetRequiredService<IEnumerable<IPaymentGateway>>()` は両方を返しますし、`IEnumerable<T>` として注入されるもの (バリデーター、ヘルスチェック、ホステッドサービス、`IStartupFilter`) は元の実装も見てしまいます。`Add` の前に `RemoveAll<T>` があるのはそのためです。キー付きで登録されたサービスについては、.NET 11 の DI に `RemoveAllKeyed<T>` があり、[キー付きサービスの登録と解決](/ja/2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection/)と組み合わせて使えます。

クラスの他のテストに影響を与えたくない 1 回限りの差し替えには `WithWebHostBuilder` を使います。渡した構成以外は何も共有しない、新しいファクトリーが返ります。

```csharp
[Fact]
public async Task Gateway_timeout_maps_to_502()
{
    var client = _factory.WithWebHostBuilder(builder =>
    {
        builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<IPaymentGateway>();
            services.AddSingleton<IPaymentGateway, TimingOutGateway>();
        });
    }).CreateClient();

    var response = await client.PostAsJsonAsync("/orders",
        new { customerId = "C-1", amount = 10m });

    Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
}
```

## EF Core の登録にひそむ落とし穴

EF Core 9 より前に書かれたチュートリアルは、自分のプロバイダーを追加する前に `DbContextOptions<TContext>` のディスクリプターを探して削除するよう指示します。そのスニペットはもう説明どおりには動きません。EF Core 9 以降、`AddDbContext` はプロバイダー構成を `Microsoft.EntityFrameworkCore.Infrastructure` の `IDbContextOptionsConfiguration<TContext>` を通じて登録するため、`DbContextOptions<TContext>` だけを削除しても元の SQL Server 構成は残ったままです。そこに 2 つ目のプロバイダーを追加すると、EF は次の例外を投げます。

```
System.InvalidOperationException: Only a single database provider can be registered
in a service provider. If possible, ensure that Entity Framework is managing its
service provider by removing the call to UseInternalServiceProvider.
```

EF Core 9、10、11 で削除すべき登録はこちらです。

```csharp
// .NET 11, EF Core 11
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;

builder.ConfigureTestServices(services =>
{
    var registrations = services
        .Where(d => d.ServiceType ==
            typeof(IDbContextOptionsConfiguration<OrdersDbContext>))
        .ToList();

    foreach (var registration in registrations)
    {
        services.Remove(registration);
    }

    services.AddDbContext<OrdersDbContext>(options =>
        options.UseSqlite(_connection));
});
```

SQLite の接続がファクトリーのフィールドで、一度開いたら開いたままにしている点に注目してください。メモリ内の SQLite データベースは最後の接続が閉じた時点で破棄されるからです。ここで EF Core のインメモリプロバイダーに手を出してはいけません。リレーショナルなセマンティクスがないため、外部キーも一意制約も列の型もいっさい強制されません。制約が実際に働くことをテストで示す必要があるなら、[Testcontainers で本物の SQL Server に対して統合テストを書く方法](/ja/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/)で説明しているように本物のエンジンに対して実行し、データベースが明らかに過剰なケースについては[変更追跡を壊さずに DbContext をモックする方法](/ja/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/)を参照してください。

## 構成と環境

`UseEnvironment("Testing")` はもっとも手軽なレバーです。`IWebHostEnvironment.EnvironmentName` が `Testing` を返すようになり、`appsettings.Testing.json` があれば読み込まれ、本番コードはテスト用の特別扱いなしに `env.IsProduction()` で分岐できます。

個々の設定については、上書きのタイミングが厄介です。`ConfigureWebHost` 内の `ConfigureAppConfiguration` は `WebApplication.CreateBuilder` がすでに戻った後に実行されるため、そこで追加した値は、起動中に `builder.Configuration` を読む `Program.cs` のコードからは見えません。これにはほとんどの `AddOptions` や `Bind` の呼び出しが含まれます。.NET 11 プレビュー 6 では、十分に早い段階で走るフックが追加されました。

```csharp
// .NET 11 preview 6 and later
private static readonly KeyValuePair<string, string?>[] s_settings =
[
    new("Payments:Endpoint", "https://localhost/stub"),
    new("Features:UseNewPricing", "true"),
];

protected override void ConfigureHostApplicationBuilder(
    IHostApplicationBuilder hostApplicationBuilder)
{
    hostApplicationBuilder.Configuration.AddInMemoryCollection(s_settings);
    base.ConfigureHostApplicationBuilder(hostApplicationBuilder);
}
```

構成ソースは `CreateBuilder` が戻る前に組み込まれるので、起動コードからも見えます。.NET 10 以前で同等のことをするには、`CreateHost` をオーバーライドして `base.CreateHost(builder)` の前に `builder.ConfigureHostConfiguration(...)` を呼ぶか、ホストが構築される前にテストプロセスで環境変数を設定します。

## 認証済みユーザーを偽装する

テストの中で本物のトークンを取得しようとしてはいけません。常に成功するテスト用の認証スキームを登録し、それを既定にします。

```csharp
// .NET 11, C# 14
public sealed class TestAuthHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options,
    ILoggerFactory logger,
    UrlEncoder encoder)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public const string Scheme = "Test";

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        Claim[] claims =
        [
            new(ClaimTypes.NameIdentifier, "user-1"),
            new(ClaimTypes.Name, "Test User"),
            new("scope", "orders:write"),
        ];

        var principal = new ClaimsPrincipal(new ClaimsIdentity(claims, Scheme));
        var ticket = new AuthenticationTicket(principal, Scheme);
        return Task.FromResult(AuthenticateResult.Success(ticket));
    }
}

// in ConfigureTestServices
services.AddAuthentication(options =>
{
    options.DefaultAuthenticateScheme = TestAuthHandler.Scheme;
    options.DefaultChallengeScheme = TestAuthHandler.Scheme;
})
.AddScheme<AuthenticationSchemeOptions, TestAuthHandler>(
    TestAuthHandler.Scheme, _ => { });
```

あとは `client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue(TestAuthHandler.Scheme)` を設定すれば、リクエストは認証済みの状態で届きます。認可ポリシーは本物のまま実行されますが、それこそが狙いです。ここでテストしているのはポリシーであって、トークンの形式ではありません。本当に検証したいのがトークン検証そのものなら、それは別のテストであり、関係するパラメーターは[minimal API で JWT ベアラー認証を設定する方法](/ja/2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11/)で扱っています。

## 結果を左右するクライアントオプション

`CreateClient` は `WebApplicationFactoryClientOptions` を受け取ります。そのうち 2 つのプロパティは、テストが通るかどうかを日常的に左右します。

```csharp
var client = factory.CreateClient(new WebApplicationFactoryClientOptions
{
    AllowAutoRedirect = false,          // default true
    BaseAddress = new Uri("https://localhost"),
    HandleCookies = true,               // default true
    MaxAutomaticRedirections = 7,
});
```

`AllowAutoRedirect` は既定で `true` なので、`302` を返すハンドラーは黙って追跡され、`HttpStatusCode.Redirect` に対するアサーションは `200 OK` で失敗します。リダイレクト自体がテスト対象の挙動なら、必ずオフにしてください。`https://localhost` という `BaseAddress` は、パイプラインに `UseHttpsRedirection` が含まれる場合に効いてきます。`http://localhost` へのリクエストにはリソースではなくリダイレクトが返るからです。

## 実際のポートが必要なとき

`TestServer` はブラウザーに応答できません。.NET 10 以降、`WebApplicationFactory` は代わりに Kestrel 上で動作し、実際のループバックポートをバインドできます。

```csharp
// .NET 10 and .NET 11
var factory = new OrdersApiFactory();
factory.UseKestrel(0);      // 0 means "pick a free port"
factory.StartServer();

var client = factory.CreateClient();
// client.BaseAddress is now the real bound address, for example
// http://127.0.0.1:53127/, taken from IServerAddressesFeature
await page.GotoAsync(client.BaseAddress!.ToString());
```

`UseKestrel` はファクトリーが初期化される前、つまり `CreateClient` や `StartServer` の呼び出しより前に呼ぶ必要があります。そうでなければ `InvalidOperationException` が投げられます。Kestrel が使われると、`CreateClient` はサーバーの `IServerAddressesFeature` から取り出したアドレスを `BaseAddress` に持つ、ふつうの `HttpClient` を返します。これにより Playwright や Selenium は、他のテストがメモリ内で検証しているのと同じホストを操作できます。上限や HTTPS を構成したい場合のために、`UseKestrel()` と `UseKestrel(Action<KestrelServerOptions>)` のオーバーロードもあります。

## ライフタイム、破棄、共有状態

`WebApplicationFactory<T>` は破棄可能で、フィクスチャの破棄は xUnit がやってくれます。ファクトリーが追加のリソース (SQLite 接続、コンテナー、一時ディレクトリ) を持つ場合は、そこに `IAsyncLifetime` を実装します。xUnit v3 ではこのインターフェースが `IAsyncDisposable` を継承し、両方のメソッドが `ValueTask` を返すため、`Task` を返す v2 のシグネチャは移行後にコンパイルできなくなります。

```csharp
// xUnit v3
public sealed class OrdersApiFactory : WebApplicationFactory<Program>, IAsyncLifetime
{
    private readonly SqliteConnection _connection = new("DataSource=:memory:");

    public async ValueTask InitializeAsync() => await _connection.OpenAsync();

    public override async ValueTask DisposeAsync()
    {
        await _connection.DisposeAsync();
        await base.DisposeAsync();
    }
}
```

スコープの選択はトレードオフです。`IClassFixture<T>` はテストクラスごとにホストを 1 つ起動し、`ICollectionFixture<T>` はコレクション内のすべてのクラスでホストを 1 つ共有し (そのぶん直列化されます)、アセンブリフィクスチャは実行全体で 1 つを共有します。ホストの起動は通常 200 から 500 ms 程度なので、クラス単位は妥当な既定です。ただし、その間はアプリのシングルトンがすべて共有されることを忘れないでください。キャッシュ、`static` なカウンター、`IMemoryCache`、プロセス内 outbox は、あるテストから次のテストへ状態を持ち越します。テスト内で明示的にリセットするか、フィクスチャのスコープをより狭くしてください。

時刻に依存するものについては、スリープしないでください。アプリで `TimeProvider` を登録し、`ConfigureTestServices` で `FakeTimeProvider` に差し替えます。詳しくは [TimeProvider と FakeTimeProvider で時刻に依存するコードをテストする方法](/ja/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/)を参照してください。アプリが HTTP で外部を呼び出す場合は、クライアントではなくハンドラーを差し替えます。パターンは [HttpClient を使うコードの単体テスト](/ja/2026/04/how-to-unit-test-code-that-uses-httpclient/)のとおりです。

最後の落とし穴です。`xunit.runner.visualstudio` は構成によっては既定でテストアセンブリをシャドウコピーしますが、これは静的ファイルや Razor ビューが依存するコンテンツルートの検出を壊します。本番ではレンダリングされるページがテストでは 404 になる場合は、`"shadowCopy": false` を書いた `xunit.runner.json` を追加し、出力ディレクトリにコピーされるよう設定してください。

これらを一貫して理解できるメンタルモデルは、`WebApplicationFactory` は本番のホストであり、変わっているのはサーバー実装と `ConfigureTestServices` で意図的に上書きしたものの 2 つだけ、というものです。ここで起きる驚きはすべて、実行されることを忘れていた本物の起動パス上の何かに行き着きます。

## 関連記事

- [Testcontainers で本物の SQL Server に対して統合テストを書く方法](/ja/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/)
- [.NET 11 で TimeProvider と FakeTimeProvider を使い時刻に依存するコードをテストする方法](/ja/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/)
- [HttpClient を使うコードを単体テストする方法](/ja/2026/04/how-to-unit-test-code-that-uses-httpclient/)
- [ASP.NET Core 11 の minimal API で JWT ベアラー認証を設定する方法](/ja/2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11/)
- [.NET 11 の依存性注入でキー付きサービスを登録して解決する方法](/ja/2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection/)
- [ASP.NET Core 11 の WebApplication.CreateBuilder と CreateSlimBuilder と CreateEmptyBuilder の比較](/ja/2026/07/webapplication-createbuilder-vs-createslimbuilder-vs-createemptybuilder-in-aspnetcore-11/)

## 参考資料

- [ASP.NET Core の統合テスト (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/test/integration-tests)
- [WebApplicationFactory&lt;TEntryPoint&gt;.UseKestrel (API リファレンス)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.mvc.testing.webapplicationfactory-1.usekestrel)
- [WebApplicationFactory.cs のソースコード (dotnet/aspnetcore)](https://github.com/dotnet/aspnetcore/blob/main/src/Mvc/Mvc.Testing/src/WebApplicationFactory.cs)
- [IDbContextOptionsConfiguration&lt;TContext&gt; (EF Core API リファレンス)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.infrastructure.idbcontextoptionsconfiguration-1)
- [xUnit v2 から v3 への単体テスト移行](https://xunit.net/docs/getting-started/v3/migration)
