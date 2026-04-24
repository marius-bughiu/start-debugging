---
title: ".NET 11 で OpenAPI 仕様から強く型付けされたクライアントコードを生成する方法"
description: "Microsoft 公式の OpenAPI コードジェネレーターである Kiota を使って、任意の OpenAPI 仕様から fluent で強く型付けされた C# クライアントを生成します。インストール、生成、ASP.NET Core DI への組み込み、認証設定まで順を追って解説します。"
pubDate: 2026-04-24
tags:
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "aspnet"
  - "openapi"
lang: "ja"
translationOf: "2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11"
translatedBy: "claude"
translationDate: 2026-04-24
---

API が OpenAPI ドキュメントを公開した時点で、手書きの `HttpClient` ラッパーを維持し続けるのは得策ではありません。新しいフィールド、リネームされたパス、追加のステータスコードが発生するたびに手動更新が必要となり、仕様とクライアントは静かにずれていきます。正しい解決策は関係を逆転させることです。仕様を唯一の真実のソースとして扱い、そこから C# の型を生成します。

.NET 11 では、この目的のための標準ツールが [Kiota](https://learn.microsoft.com/en-us/openapi/kiota/overview) です。Microsoft が開発した OpenAPI ベースのクライアントジェネレーターです。.NET ツールとしてインストールし、仕様を指定すると、実際の強く型付けされたリクエストクラスとレスポンスクラスを持つ fluent なリソース指向 C# クライアントが生成されます。単一のメタパッケージが HTTP、JSON、認証ミドルウェアを処理します。クリーンな仕様があれば、設定全体は 10 分未満で完了します。

## 手書き HttpClient ラッパーが機能しなくなる理由

典型的な手書きラッパーはこのような形です。レスポンス用の POCO を書き、サービスクラスにメソッドを追加し、URL セグメントをハードコードします。各エンドポイントに対して繰り返します。次に、API オーナーが新しいレスポンスフィールドを追加したり、パスパラメーター名を変更したり、nullable コントラクトを調整したりするたびに繰り返します。これらの変更はコンパイラーエラーを生成しません。プロダクションでの null 参照例外、値を静かにゼロにする JSON プロパティ名の不一致として実行時に現れます。

生成されたクライアントはこれを逆転させます。仕様は C# の型に直接コンパイルされます。仕様がフィールドを `nullable: false` と示している場合、プロパティは `string?` ではなく `string` です。仕様が新しいパスを追加した場合、次の `kiota generate` の実行でメソッドが追加されます。生成されたファイルの差分により、API コントラクトで何が変わったかを正確に確認できます。

## Kiota と NSwag: どちらのジェネレーターを選ぶか

.NET の世界では 2 つのジェネレーターが主流です。NSwag (成熟しており、単一のモノリシッククラスファイルを生成) と Kiota (新しく、リソース指向で、多くの小さなフォーカスされたファイルを生成) です。

Kiota は URL 構造を反映したパス階層を構築します。`GET /repos/{owner}/{repo}/releases` への呼び出しは `client.Repos["owner"]["repo"].Releases.GetAsync()` になります。各パスセグメントは個別の C# クラスです。これにより多くのファイルが生成されますが、生成されたコードを任意のパスレベルでナビゲートしてモックできます。

NSwag は操作ごとにメソッドを持つ 1 つのクラスを生成します: `GetReposOwnerRepoReleasesAsync(owner, repo)`。これは小さな API には簡潔ですが、仕様に数百のパスがある場合は扱いにくくなります。GitHub の完全な OpenAPI 仕様は NSwag では 40 万行に近いファイルを生成します。

Kiota は Microsoft が Microsoft Graph SDK と Azure SDK for .NET に使用しているものです。2024 年に一般提供が宣言され、公式ドキュメントのクイックスタートが参照するジェネレーターです。両方のツールを以下に示します。NSwag セクションはそのツールチェーンに既に投資しているチーム向けの最小限の代替手段をカバーします。

## ステップ 1: Kiota をインストールする

**グローバルインストール** (開発者マシンへの最もシンプルな方法):

```bash
dotnet tool install --global Microsoft.OpenApi.Kiota
```

**ローカルインストール** (チームプロジェクトに推奨 -- CI マシン間で再現可能):

```bash
dotnet new tool-manifest   # creates .config/dotnet-tools.json
dotnet tool install Microsoft.OpenApi.Kiota
```

ローカルインストール後、任意の開発者マシンや CI ジョブで `dotnet tool restore` を実行すると、正確にピン留めされたバージョンがインストールされます。チーム間のバージョンドリフトがなくなります。

インストールを確認します:

```bash
kiota --version
# 1.x.x
```

## ステップ 2: クライアントを生成する

```bash
# .NET 11 / Kiota 1.x
kiota generate \
  -l CSharp \
  -c WeatherClient \
  -n MyApp.ApiClient \
  -d ./openapi.yaml \
  -o ./src/ApiClient
```

主要なフラグ:

| フラグ | 目的 |
|--------|------|
| `-l CSharp` | ターゲット言語。Kiota は Go、Java、TypeScript、Python、PHP、Ruby もサポートします。 |
| `-c WeatherClient` | ルートクライアントクラスの名前。 |
| `-n MyApp.ApiClient` | 生成されたすべてのファイルのルート C# 名前空間。 |
| `-d ./openapi.yaml` | OpenAPI ドキュメントへのパスまたは HTTPS URL。Kiota は YAML と JSON を受け入れます。 |
| `-o ./src/ApiClient` | 出力ディレクトリ。Kiota は各実行で上書きします。生成されたファイルを手動で編集しないでください。 |

大きなパブリック仕様 (GitHub、Stripe、Azure) の場合は `--include-path` を追加して、実際に呼び出すパスにクライアントを絞り込みます:

```bash
# Only generate the /releases subtree from GitHub's spec
kiota generate \
  -l CSharp \
  -c GitHubClient \
  -n MyApp.GitHub \
  -d https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.yaml \
  -o ./src/GitHub \
  --include-path "/repos/{owner}/{repo}/releases/*"
```

`--include-path` なしでは、GitHub の完全な仕様は約 600 ファイルを生成します。指定すると、releases サブツリーの十数ファイルが取得されます。フィルターは後でいつでも広げることができます。

生成されたファイルをソース管理にコミットしてください。仕様の URL またはローカルパスがあれば再生成できます。コードレビューで使用中の正確な型を確認できます。

## ステップ 3: NuGet パッケージを追加する

```bash
dotnet add package Microsoft.Kiota.Bundle
```

`Microsoft.Kiota.Bundle` は以下を含むメタパッケージです:

- `Microsoft.Kiota.Abstractions` -- リクエストアダプターコントラクトとシリアライゼーションインターフェース
- `Microsoft.Kiota.Http.HttpClientLibrary` -- デフォルトの HTTP バックエンドである `HttpClientRequestAdapter`
- `Microsoft.Kiota.Serialization.Json` -- System.Text.Json シリアライゼーション
- `Microsoft.Kiota.Authentication.Azure` -- オプション、Azure Identity 認証プロバイダー用

このバンドルは `netstandard2.0` をターゲットとしているため、追加の `<TargetFramework>` 調整なしに .NET 8、.NET 9、.NET 10、.NET 11 (現在プレビュー中) と互換性があります。

## ステップ 4: コンソールアプリでクライアントを使用する

```csharp
// .NET 11, Kiota 1.x
using MyApp.ApiClient;
using Microsoft.Kiota.Abstractions.Authentication;
using Microsoft.Kiota.Http.HttpClientLibrary;

var adapter = new HttpClientRequestAdapter(new AnonymousAuthenticationProvider());
var client = new WeatherClient(adapter);

// GET /forecasts
var all = await client.Forecasts.GetAsync();
Console.WriteLine($"Received {all?.Count} forecasts.");

// GET /forecasts/{location}
var specific = await client.Forecasts["lon=51.5,lat=-0.1"].GetAsync();
Console.WriteLine($"Temperature: {specific?.Temperature}");

// POST /forecasts
var created = await client.Forecasts.PostAsync(new()
{
    Location = "lon=51.5,lat=-0.1",
    TemperatureC = 21,
});
Console.WriteLine($"Created forecast ID: {created?.Id}");
```

`AnonymousAuthenticationProvider` は認証ヘッダーを追加しません。パブリック API には適切です。Bearer トークンについては以下の認証セクションを参照してください。

生成された各非同期メソッドはオプションの `CancellationToken` を受け入れます。自分のコンテキストから渡します:

```csharp
// .NET 11, Kiota 1.x
using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
var forecasts = await client.Forecasts.GetAsync(cancellationToken: cts.Token);
```

トークンは HTTP アダプターを通じて流れ、基盤となる `HttpClient` 呼び出しをキャンセルします。追加の設定は不要です。

## ステップ 5: ASP.NET Core DI にクライアントを組み込む

各ハンドラーでリクエストアダプターを new するとソケットが無駄になり (`IHttpClientFactory` の接続プールをバイパスする)、クライアントがテスト不可能になります。正しいパターンはコンストラクターインジェクション経由でマネージドな `HttpClient` を受け取るファクトリークラスです。

ファクトリーを作成します:

```csharp
// .NET 11, Kiota 1.x
using MyApp.ApiClient;
using Microsoft.Kiota.Abstractions.Authentication;
using Microsoft.Kiota.Http.HttpClientLibrary;

public class WeatherClientFactory(HttpClient httpClient)
{
    public WeatherClient GetClient() =>
        new(new HttpClientRequestAdapter(
            new AnonymousAuthenticationProvider(),
            httpClient: httpClient));
}
```

`Program.cs` ですべてを登録します:

```csharp
// .NET 11
using Microsoft.Kiota.Http.HttpClientLibrary;

// Kiota の組み込み HTTP メッセージハンドラーを DI コンテナーに登録する
builder.Services.AddKiotaHandlers();

// 名前付き HttpClient を登録してハンドラーをアタッチする
builder.Services.AddHttpClient<WeatherClientFactory>(client =>
{
    client.BaseAddress = new Uri("https://api.weather.example.com");
})
.AttachKiotaHandlers();

// 生成されたクライアントをインジェクション用に直接公開する
builder.Services.AddTransient(sp =>
    sp.GetRequiredService<WeatherClientFactory>().GetClient());
```

`AddKiotaHandlers` と `AttachKiotaHandlers` は `Microsoft.Kiota.Http.HttpClientLibrary` の拡張メソッドです。Kiota のデフォルトデリゲーティングハンドラー (リトライ、リダイレクト、ヘッダー検査) を登録し、`IHttpClientFactory` のライフサイクルに組み込むことで正しくディスポーズされます。

`WeatherClient` を Minimal API エンドポイントに直接インジェクトします:

```csharp
// .NET 11
app.MapGet("/weather", async (WeatherClient client, CancellationToken ct) =>
{
    var forecasts = await client.Forecasts.GetAsync(cancellationToken: ct);
    return forecasts;
});
```

Minimal API ハンドラーの `CancellationToken` パラメーターは、HTTP リクエストアボートトークンに自動的にバインドされます。クライアントが切断すると、実行中の Kiota 呼び出しは追加コードなしにクリーンにキャンセルされます。

## ステップ 6: 認証

Bearer トークンが必要な API の場合は `IAccessTokenProvider` を実装して `BaseBearerTokenAuthenticationProvider` に渡します:

```csharp
// .NET 11, Kiota 1.x
using Microsoft.Kiota.Abstractions;
using Microsoft.Kiota.Abstractions.Authentication;

public class StaticTokenProvider(string token) : IAccessTokenProvider
{
    public Task<string> GetAuthorizationTokenAsync(
        Uri uri,
        Dictionary<string, object>? additionalContext = null,
        CancellationToken cancellationToken = default) =>
        Task.FromResult(token);

    public AllowedHostsValidator AllowedHostsValidator { get; } = new();
}
```

ファクトリーで組み込みます:

```csharp
// .NET 11, Kiota 1.x
var authProvider = new BaseBearerTokenAuthenticationProvider(
    new StaticTokenProvider(apiKey));

return new WeatherClient(new HttpClientRequestAdapter(authProvider, httpClient: httpClient));
```

プロダクションでは、`StaticTokenProvider` を現在の HTTP コンテキスト、`IOptions<>` の値、または Azure Identity の `DefaultAzureCredential` からトークンを読み取る実装に置き換えてください (`Microsoft.Kiota.Authentication.Azure` パッケージがまさにこのケース用に `AzureIdentityAuthenticationProvider` を提供しています)。

## よりシンプルなファイル構造を好む場合は NSwag を使用する

プロジェクトがすでに NSwag を使用しているか `dotnet-openapi` で生成された場合は移行不要です。NSwag CLI をインストールして次のように再生成します:

```bash
dotnet tool install --global NSwag.ConsoleCore

nswag openapi2csclient \
  /input:openapi.yaml \
  /classname:WeatherClient \
  /namespace:MyApp.ApiClient \
  /output:WeatherClient.cs
```

NSwag はクライアントクラスと対応する `IWeatherClient` インターフェースを含む単一の C# ファイルを生成します。このインターフェースによりユニットテストが簡単になります。パスレベルの間接参照なしに `IWeatherClient` を直接モックできます。生成されたファイル全体が 1 画面に収まる小さく安定した仕様では NSwag は実用的な選択です。大きく頻繁に変更される仕様では、Kiota のパスごとのファイル構造により API の差分レビューが容易になります。

## 生成されたファイルをコミットする前に注意すべき点

**仕様の品質が型の精度を決定します。** Kiota は生成時に OpenAPI ドキュメントを検証します。`nullable: true` アノテーションが欠けていると `string?` を期待していたところに `string` が生成されます。間違った `type: integer` は API が実際には浮動小数点数を送信する場合に `int` になります。サーバーのオーナーであれば、生成前に仕様に対して [Spectral](https://stoplight.io/open-source/spectral) を実行してください。

**大きなパブリック API では `--include-path` は省略不可です。** 省略すると GitHub の仕様は何百ものファイルを生成し、Stripe の仕様はさらに多くを生成します。生成時にクライアントを使用するパスに絞り込んでください。後でいつでも広いフィルターで再生成できます。時間とともに増大する 600 ファイルのクライアントを削減するのはより困難です。

**モデル名の衝突は名前空間で自動的に解決されます。** `GET /posts/{id}` と `GET /users/{id}` の両方が `Item` という名前のスキーマを参照する場合、Kiota は `Posts.Item.Item` と `Users.Item.Item` を生成します。名前が衝突するように見える場合は `using` 文を確認してください。

**Minimal API エンドポイントの `CancellationToken` は無料です。** パラメーターとして宣言するだけで ASP.NET Core がリクエストアボートトークンにバインドします。属性は不要です。Kiota の各呼び出しに渡すと、ブラウザーが接続を閉じるかゲートウェイタイムアウトが発生したときに HTTP クライアントが自動的にキャンセルされます。C# での協調的タスクキャンセルの仕組みについては [デッドロックなしに長時間実行 Task を C# でキャンセルする方法](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) で詳しく解説しています。

**再生成はローカルだけでなく CI でも行ってください。** `dotnet tool restore && kiota generate [...]` をパイプラインのステップとして追加してください。仕様が変更されリポジトリの生成コードが古くなった場合、ビルドがリリース前に差分を検出します。

## 関連記事

- API サーバー側を公開していて Scalar ドキュメント UI で Bearer 認証が正しく表示されるようにしたい場合、設定は直感的ではありません: [ASP.NET Core の Scalar: Bearer トークンが無視される理由](/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/)
- サービス間の呼び出しが REST ではなく gRPC を使用している場合、コンテナーネットワークのトラップは HTTP とは異なります: [.NET 9 と .NET 10 のコンテナーでの gRPC](/2026/01/grpc-in-containers-feels-hard-in-net-9-and-net-10-4-traps-you-can-fix/)
- HTTP クライアント層への分散トレースの追加は [ASP.NET Core 11 のネイティブ OpenTelemetry トレーシング](/2026/04/aspnetcore-11-native-opentelemetry-tracing/) と自然にペアになります。

## ソースリンク

- [Kiota の概要](https://learn.microsoft.com/en-us/openapi/kiota/overview) -- Microsoft Learn
- [.NET 向け API クライアントのビルド](https://learn.microsoft.com/en-us/openapi/kiota/quickstarts/dotnet) -- Microsoft Learn
- [.NET で Kiota クライアントを依存性注入に登録する](https://learn.microsoft.com/en-us/openapi/kiota/tutorials/dotnet-dependency-injection) -- Microsoft Learn
- [NSwag: .NET 向け Swagger/OpenAPI ツールチェーン](https://github.com/RicoSuter/NSwag) -- GitHub
