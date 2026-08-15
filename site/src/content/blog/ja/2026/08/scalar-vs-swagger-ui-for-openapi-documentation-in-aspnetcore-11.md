---
title: "ASP.NET Core 11 の OpenAPI ドキュメントにおける Scalar と Swagger UI の比較"
description: "Scalar は gzip 圧縮後 1.02 MiB の JavaScript と、はるかに優れたリクエストビルダーを配信します。Swagger UI は 514 KiB で、.NET 11 が既定で出力する OpenAPI 3.2 をレンダリングします。実測したペイロード、3.2 対応の差、両者のエンドポイントルーティング、そして決め手になる認証まわりの詳細をまとめます。"
pubDate: 2026-08-15
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "openapi"
  - "scalar"
lang: "ja"
translationOf: "2026/08/scalar-vs-swagger-ui-for-openapi-documentation-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-08-15
---

新しい .NET 11 の API でドキュメントの読者が社外の人であれば、**Scalar** (`Scalar.AspNetCore` 2.16.20) を選んでください。リクエストビルダー、複数言語のコードサンプル、検索のいずれも Swagger UI より本当に優れています。ペイロードを小さくしたい場合、すでに設定済みの OAuth2 リダイレクトフローに依存している場合、あるいは今日の時点で OpenAPI 3.2 の確実なレンダリングが必要な場合は、**Swagger UI** (`Swashbuckle.AspNetCore.SwaggerUI` 10.2.3、内部に swagger-ui 5.32.7 を同梱) を選んでください。.NET 11 は既定で 3.2 を出力しますが、Scalar の 3.2 対応はまだオープンな課題だからです。どちらも MIT ライセンスで、どちらも OpenAPI ドキュメントに一切関与しない純粋なレンダラーであり、Microsoft のガイダンスはどちらも本番環境で到達可能にすべきではないというものです。

以下の計測はすべて、記載したとおりのパッケージバージョンで .NET SDK 10.0.201 上で 2026-08-15 に実行しました。API の表面は .NET 8 から .NET 11 まで同一です。どちらのパッケージも `net8.0`、`net9.0`、`net10.0` のアセンブリを提供し、ランタイムを固定せずに `Microsoft.AspNetCore.App` へのフレームワーク参照を取っているためです。

## 多くの人が比較していると思っているものは、本当の論点ではありません

.NET 9 以降、`dotnet new webapi` に Swashbuckle は含まれていません。ドキュメントを生成するのは `Microsoft.AspNetCore.OpenApi` で、トリミングと Native AOT にも対応しています。つまり目の前にある選択は「Swashbuckle か Scalar か」ではなく、「フレームワークがすでに生成しているドキュメントを、どの JavaScript バンドルでレンダリングするか」です。生成側でまだ Swashbuckle の `SwaggerGen` を使っているなら、それは別の判断であり、[ASP.NET Core 11 で Swashbuckle なしに OpenAPI を公開する方法](/ja/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/)で扱っています。

この区別には実務上の帰結があります。メタパッケージの `Swashbuckle.AspNetCore` は、UI と一緒に `Swashbuckle.AspNetCore.Swagger`、`SwaggerGen`、`Microsoft.Extensions.ApiDescription.Server` を引き込みます。UI だけが必要なら `Swashbuckle.AspNetCore.SwaggerUI` を直接参照すれば、それ以外は付いてきません。

```xml
<!-- .NET 11, C# 14: the UI only, no second document generator -->
<ItemGroup>
  <PackageReference Include="Microsoft.AspNetCore.OpenApi" Version="11.0.0" />
  <PackageReference Include="Swashbuckle.AspNetCore.SwaggerUI" Version="10.2.3" />
</ItemGroup>
```

```xml
<!-- .NET 11, C# 14: the Scalar equivalent, one package, zero NuGet dependencies -->
<ItemGroup>
  <PackageReference Include="Microsoft.AspNetCore.OpenApi" Version="11.0.0" />
  <PackageReference Include="Scalar.AspNetCore" Version="2.16.20" />
</ItemGroup>
```

## 比較表

| | Scalar 2.16.20 | Swagger UI 5.32.7 (Swashbuckle 10.2.3) |
| --- | --- | --- |
| 初回ロードの転送バイト数 (gzip) | 1,071,277 | 526,322 |
| 展開後に解析される JavaScript | 3,711 KB | 1,794 KB |
| 登録方法 | `app.MapScalarApiReference()` | `app.UseSwaggerUI(...)` または `app.MapSwaggerUI(...)` |
| エンドポイントルーティング | 対応、1.x から | 対応、10.2.0 から (2026 年 5 月) |
| OpenAPI 3.2 | パーサーは処理できるが、完全対応はオープンな課題 | swagger-ui 5.32.0 から基本的な対応 |
| コードサンプル | 20 以上のターゲット (curl、fetch、axios、Python、Go、Java、PHP、Ruby など) | 直前に送信したリクエストの curl のみ |
| アセットのキャッシュ | `Cache-Control: no-cache` と ETag、コードに固定 | 既定は ETag、`CacheLifetime` を設定すれば `max-age` |
| 認証情報の保持 | `persistAuth` が local storage に書き込む | 設定オブジェクトの `PersistAuthorization` |
| クロスオリジンの Try It | 任意の `proxyUrl` | ブラウザーからの直接 fetch、CORS は自分で解決 |
| テーマ | 12 個の組み込みテーマ、`customCss`、プラグイン | `InjectStylesheet`、`InjectJavascript`、swagger-ui のプラグイン機構 |
| ライセンス | MIT | MIT |

## ブラウザーにかかるコストの実測

どちらのパッケージもアセットを gzip ストリームとしてアセンブリに埋め込み、`Accept-Encoding: gzip` を宣言したクライアントにそのバイト列をそのまま渡します。Scalar の ASP.NET Core 統合は `IsGzipAccepted()` を確認し、保存されたアセットから `Content-Encoding` と `Vary: Accept-Encoding` を設定します。Swashbuckle の UI ミドルウェアも同じ仕組み (`IsGZipAccepted` と、gzip を受け付けない稀なクライアント向けの展開モードの `GZipStream`) を備えています。したがって保存されているリソースのサイズがそのまま転送サイズであり、何も実行せずにパッケージから読み出せます。

```csharp
// .NET SDK 10.0.201, run as a file-based app: dotnet run res.cs <dll>
using System.Reflection;

var asm = Assembly.LoadFrom(args[0]);
foreach (var name in asm.GetManifestResourceNames())
{
    using var s = asm.GetManifestResourceStream(name);
    Console.WriteLine($"{s?.Length,10}  {name}");
}
```

Scalar が配信するアセットは 3 つで、そのうちコードは 2 つだけです。

```text
   1070166  ScalarStaticAssets.scalar.js
      1111  ScalarStaticAssets.scalar.aspnetcore.js
       533  ScalarStaticAssets.favicon.svg
```

Swashbuckle の `index.html` は、バンドル、スタンドアロンプリセット、スタイルシート、そして独自の初期化スクリプトを読み込みます。

```text
    421507  swagger-ui-bundle.js
     77731  swagger-ui-standalone-preset.js
     26499  swagger-ui.css
       433  index.js
       152  index.css
       739  index.html
```

Scalar が 1,071,277 バイト、Swagger UI が 526,322 バイトで、転送量は 2.0 倍の差です。展開後で見ると `scalar.js` はブラウザーが解析すべき JavaScript が 3,708,228 バイト、Swagger UI のバンドルとプリセットの合計は 1,793,552 バイトです。見た目がモダンな方が重いという、多くの記事が示唆する内容とは逆の結果になります。

これを重く見すぎる前に、注意点が 2 つあります。まず、これは開発用のツールです。バイト列はループバック経由で自分のマシンに届き、コールドロード 1 回につき 1 度だけです。次に、Swashbuckle の `swagger-ui.js` (92,466 バイト) はパッケージに含まれていますが既定のページでは使われないため、上の数字は実際に読み込まれる量であって配布量ではありません。どちらの UI を実ネットワーク越しに配信する場合でも、[レスポンス圧縮の比較](/ja/2026/08/zstandard-vs-brotli-vs-gzip-response-compression-in-dotnet-11/)はここでは役に立ちません。どちらのパッケージもすでに自前でこれらのアセットを圧縮しており、`Content-Encoding: gzip` のレスポンスをミドルウェアが再圧縮することはないからです。

日々効いてくるのはキャッシュです。`SwaggerUIOptions.CacheLifetime` は既定値を "0 days (ETags are used to check if resources have been updated)" と説明しており、そのままではどちらの UI も再検証します。違いは、Swashbuckle は本物のキャッシュを選べるのに対し、Scalar は選べないことです。Scalar の静的アセットハンドラーは `Cache-Control: no-cache` をコードに固定し、一致する `If-None-Match` には 304 を返します。ページを開くたびにアセットごとの往復が発生し続けます。

```csharp
// Program.cs -- .NET 11, C# 14, Swashbuckle.AspNetCore.SwaggerUI 10.2.3
app.UseSwaggerUI(options =>
{
    options.SwaggerEndpoint("/openapi/v1.json", "v1");
    options.CacheLifetime = TimeSpan.FromDays(7); // 304s become cache hits
});
```

## .NET 11 の落とし穴: ドキュメントは既に 3.2 です

2026 年 8 月時点で判断を左右するはずの事実であり、ほとんど誰も書いていません。Microsoft Learn は明確です。"Starting in .NET 11, the default OpenAPI version for generated documents is 3.2. In .NET 10, the default is 3.1." API を .NET 10 から .NET 11 へ上げるだけで、他は何も変えていなくても、UI がレンダリングすべきドキュメントの仕様バージョンが変わります。

Swagger UI 側では、swagger-ui 5.32.0 (2026 年 2 月 27 日) が "basic OpenAPI 3.2.0 support" を導入し、Swashbuckle 10.2.3 は 5.32.7 を同梱しているため、レンダラーは少なくとも対象を認識できます。Scalar 側では `@scalar/openapi-parser` が 3.2 を理解しますが、追跡用の課題 [scalar/scalar#6715](https://github.com/scalar/scalar/issues/6715) はまだオープンで、2026 年 6 月 30 日の最終更新時点で "set OpenAPI 3.2 as the default version" とサイドバーでの深くネストしたタグのレンダリングが未完了として残っています。

実際には、minimal API のエンドポイントから生成されるドキュメントは 3.1 と 3.2 でほとんど変わらないため、大半のアプリでは違いは出ません。サイドバーのグルーピングがおかしい、スキーマが空でレンダリングされるといった症状が出た場合は、UI にバグ報告を出す前にバージョンを固定してください。

```csharp
// Program.cs -- .NET 11, C# 14
builder.Services.AddOpenApi(options =>
{
    // .NET 11 defaults to OpenApi3_2; pin 3.1 while a renderer catches up
    options.OpenApiVersion = Microsoft.OpenApi.OpenApiSpecVersion.OpenApi3_1;
});
```

ビルド時生成にも同じつまみがあり、MSBuild プロパティ `OpenApiGenerateDocumentsOptions` に `--openapi-version OpenApi3_1` を指定します。今日固定しても失うものはありません。ASP.NET Core が生成するドキュメントで 3.2 固有の機能に依存している部分はまだないからです。

## ミドルウェアかエンドポイントか、今は両方ともエンドポイント

Scalar を推す最も強いアーキテクチャ上の論拠は、`MapScalarApiReference` がエンドポイントを登録するのに対し `UseSwaggerUI` はミドルウェアを登録し、ミドルウェアはエンドポイントルーティングが関与する前にリクエストを終わらせてしまう、というものでした。この論拠は 2026 年 5 月に失効しました。Swashbuckle 10.2.0 が `MapSwaggerUI` と `MapReDoc` を "to support endpoint routing" として追加したからです。どちらの UI もエンドポイントのメタデータを持ち、`EndpointDataSource` に現れ、ルーティング規約を直接受け取れます。

```csharp
// Program.cs -- .NET 11, C# 14
// Scalar: MapScalarApiReference returns an IEndpointConventionBuilder
app.MapScalarApiReference()
   .RequireAuthorization("ApiDocsPolicy");

// Swashbuckle 10.2.0+: same shape
app.MapSwaggerUI()
   .RequireAuthorization("ApiDocsPolicy");
```

リバースプロキシの背後にいる場合は注意してください。Scalar の HTML エンドポイントは相対パスのアセットを解決するために `/scalar` へのリクエストを 301 で `/scalar/` にリダイレクトし、Swashbuckle のミドルウェアもルートプレフィックス単体へのリクエストを 301 で `index.html` にリダイレクトします。素のパスで 200 を期待する統合テストは、どちらでも失敗します。

## Authorize を押した後に何が起きるか

どちらの UI もセキュリティスキームをドキュメントから読み取るだけで、自分で作り出すことはありません。Scalar 自身のドキュメントも率直で、Scalar がスキームを扱うにはドキュメント側にすでにスキームが含まれている必要があると述べています。まだ入れていない場合に必要な仕組みは、[操作トランスフォーマーとスキーマトランスフォーマーの解説](/ja/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/)にあります。

違うのはその先の使い勝手です。Scalar はサーバー側の設定から認証情報を事前入力でき、リロードをまたいで保持できます。

```csharp
// Program.cs -- .NET 11, C# 14, Scalar.AspNetCore 2.16.20
app.MapScalarApiReference(options =>
{
    options.AddPreferredSecuritySchemes("Bearer")
           .AddHttpAuthentication("Bearer", auth => auth.WithToken(devToken));
    options.PersistentAuthentication = true;
});
```

Swagger UI の相当機能は設定オブジェクトにあり、OAuth2 については Swashbuckle が埋め込む `oauth2-redirect.html` (10 年使われてきた 664 バイトのリダイレクトスクリプト) にあります。

```csharp
// Program.cs -- .NET 11, C# 14, Swashbuckle.AspNetCore.SwaggerUI 10.2.3
app.UseSwaggerUI(options =>
{
    options.SwaggerEndpoint("/openapi/v1.json", "v1");
    options.OAuthClientId("dev-client");
    options.OAuthUsePkce();
    options.EnablePersistAuthorization();
});
```

Scalar にあって Swagger UI にない唯一の機能が `proxyUrl` です。Swagger UI の Try It はドキュメントのオリジンから `fetch` を発行するため、CORS が緩くないクロスオリジンの API ではサーバー障害のように見えるブラウザーエラーが出ます。Scalar はリクエストをプロキシ経由に切り替えられます。ドキュメントを API と別に配置しているなら、このオプション 1 つで決まります。

## 製品としての本当の差はコードサンプル

Swagger UI が見せるのは、実行した直後のリクエストに対応する curl コマンドです。Scalar は送信する前から、知っているすべてのクライアントでリクエストを描画します。shell (curl、httpie)、JavaScript (fetch、axios、jquery)、Node、Python、Go、Java、Ruby、PHP など、`hiddenClients` と `defaultHttpClient` で制御できます。読者が書いた本人たちである社内 API なら、これは飾りです。読者が自社プロダクトを組み込みやすいかどうかを判断している公開 API なら、これがページのすべてです。

Scalar はさらに `searchHotKey` (既定は CMD/CTRL+K)、12 種類の組み込みテーマ、`customCss`、任意のクライアント設定を差し込む `/scalar/config.js` フックを提供します。Swagger UI のカスタマイズは `InjectStylesheet`、`InjectJavascript`、swagger-ui のプラグイン機構を通り、より強力で、かなり快適さに欠けます。これがこの比較全体の率直な要約です。

## どちらを選ぶか

Scalar を選ぶのは、ドキュメントが製品の一部であるとき、読者がチームの外にいるとき、リクエストビルダーとコードサンプルが欲しいとき、あるいはドキュメントを API と別のオリジンに置いていてプロキシが必要なときです。

Swagger UI を選ぶのは、ペイロードを最小にして `max-age` による本物のキャッシュが欲しいとき、既存の OAuth2 設定がすでに動いているとき、チームの誰かが swagger-ui のプラグインに依存しているとき、あるいは .NET 11 が既定で 3.2 を出力する状況で 3.2 対応が明示されているレンダラーが欲しいときです。

ドキュメントを読むのが人間ではなく生成されたクライアントであるなら、どちらも選ばずに `Swashbuckle.AspNetCore.ReDoc` やエディターの拡張機能を使ってください。API に必ずレンダリング済みのリファレンスが要る、という決まりはありません。

どちらを選ぶにせよ、Microsoft Learn はセキュリティ上の立場を明確に述べています。OpenAPI のユーザーインターフェースは開発環境でのみ有効にすべきです。どちらのパッケージでも 1 行の環境ガードで済み、本番での遮断やオフラインアセットを含む手順版の設定は[Scalar の解説記事](/ja/2026/08/how-to-serve-openapi-docs-with-scalar-instead-of-swagger-ui-in-aspnetcore-11/)にあります。

## 判断を左右する細かい点

- **メタパッケージ。** `Swashbuckle.AspNetCore` 10.2.3 は `SwaggerGen` と `Microsoft.Extensions.ApiDescription.Server` を引き込みます。組み込みの生成器へ移行済みなら、生成器が 2 つある状態になり、片方は古いままです。`Swashbuckle.AspNetCore.SwaggerUI` を単独で参照してください。完全な削除手順は[Swashbuckle から組み込みの OpenAPI 生成への移行](/ja/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/)にあります。
- **どちらのパッケージも `net11.0` をターゲットにしていません。** 両方とも `net8.0`、`net9.0`、`net10.0` のアセンブリをフレームワーク参照付きで提供します。`net10.0` のアセットはロールフォワードで .NET 11 上で動作しますが、`net11.0` 固有の修正をどちらのプロジェクトにも待てないということでもあります。
- **Scalar のアセットはキャッシュされません。** `Cache-Control: no-cache` はオプションから変更できません。共有の開発環境への回線が遅い場合、ロードのたびにアセットごとの再検証を払うことになります。
- **末尾のスラッシュ。** どちらの UI も素のパスを 301 で返します。厳格なプロキシや統合テストはこれに気づきます。
- **Swagger UI のバージョンヘッダー。** Swashbuckle はアセットのレスポンスに `x-swagger-ui-version` を付与します。実際に配布されたものを確認するには便利ですが、情報漏えいとして検出するスキャナーもあります。環境ガードを設けるもう 1 つの理由です。

同じドキュメントをレンダリングする MIT ライセンスの 2 つの選択肢である以上、これは可逆な判断です。`Program.cs` の 1 行とパッケージ参照 1 つを差し替えれば、どちらの方向にも 5 分ほどで移動できます。フレームワークではなく読者を基準に選んでください。

## 関連記事

- [ASP.NET Core 11 で Swagger UI の代わりに Scalar で OpenAPI ドキュメントを配信する方法](/ja/2026/08/how-to-serve-openapi-docs-with-scalar-instead-of-swagger-ui-in-aspnetcore-11/) はルーティング、複数ドキュメント、認証、本番での遮断まで含めた完全な設定手順です。
- [ASP.NET Core 11 で Swashbuckle なしに OpenAPI を公開する方法](/ja/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/) はこの分担のうち生成側を扱います。
- [.NET 11 で Swashbuckle から組み込みの OpenAPI ドキュメント生成へ移行する](/ja/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/) は削除のチェックリストです。
- [AddOperationTransformer と AddSchemaTransformer で OpenAPI ドキュメントをカスタマイズする方法](/ja/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/) は、そもそもセキュリティスキームをドキュメントに入れる方法です。
- [.NET 11 のレスポンス圧縮における Zstandard、Brotli、Gzip の比較](/ja/2026/08/zstandard-vs-brotli-vs-gzip-response-compression-in-dotnet-11/) は、事前圧縮された静的アセットが圧縮ミドルウェアを完全に迂回する理由を説明します。

## 参考資料

- [Use the generated OpenAPI documents (Microsoft Learn, ASP.NET Core 11)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/using-openapi-documents?view=aspnetcore-11.0)
- [Generate OpenAPI documents, default version 3.2 in .NET 11 (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/aspnetcore-openapi?view=aspnetcore-11.0)
- [OpenApiSpecVersion enum, including OpenApi3_2 (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.openapi.openapispecversion)
- [Swashbuckle.AspNetCore v10.2.0 release notes, MapSwaggerUI and MapReDoc](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/releases/tag/v10.2.0)
- [Swashbuckle.AspNetCore.SwaggerUI 10.2.3 on NuGet](https://www.nuget.org/packages/Swashbuckle.AspNetCore.SwaggerUI/10.2.3)
- [swagger-ui v5.32.0 release, basic OpenAPI 3.2.0 support](https://github.com/swagger-api/swagger-ui/releases/tag/v5.32.0)
- [Scalar.AspNetCore 2.16.20 on NuGet](https://www.nuget.org/packages/Scalar.AspNetCore/2.16.20)
- [Scalar .NET integration documentation](https://scalar.com/scalar/scalar-api-references/net-integration)
- [Scalar API reference configuration options](https://scalar.com/scalar/scalar-api-references/configuration)
- [OpenAPI 3.2 support tracking issue (scalar/scalar#6715)](https://github.com/scalar/scalar/issues/6715)
