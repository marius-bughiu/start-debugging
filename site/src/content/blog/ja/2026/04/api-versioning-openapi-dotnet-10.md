---
title: "Asp.Versioning 10.0 がついに .NET 10 の組み込み OpenAPI とうまくかみ合う"
description: "Asp.Versioning 10.0 は .NET 10 と新しい Microsoft.AspNetCore.OpenApi パイプラインを対象とする最初のリリースです。4 月 23 日の Sander ten Brinke の解説では、WithDocumentPerVersion() を使って API バージョンごとに OpenAPI ドキュメントを 1 つずつ登録する方法を紹介しています。"
pubDate: 2026-04-28
tags:
  - "dotnet-10"
  - "aspnetcore"
  - "openapi"
  - "api-versioning"
lang: "ja"
translationOf: "2026/04/api-versioning-openapi-dotnet-10"
translatedBy: "claude"
translationDate: 2026-04-28
---

ASP.NET Core 9 が Swashbuckle を組み込みの [`Microsoft.AspNetCore.OpenApi`](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/overview?view=aspnetcore-10.0) ジェネレーターに置き換えたとき、接着剤が 1 つ足りませんでした。新しいパイプラインを `Asp.Versioning` につなぎ、バージョンごとに別ドキュメントを出力するきれいな方法がなかったのです。その修正が先週着地しました。Sander ten Brinke による [4 月 23 日の .NET Blog 投稿](https://devblogs.microsoft.com/dotnet/api-versioning-in-dotnet-10-applications/) は公式の "こうやればよい" ガイドであり、.NET 10 を対象とする最初の `Asp.Versioning` パッケージとセットになっています。

## 変わったパッケージ

minimal API では、2026 年 4 月時点で最新の以下の 3 つのパッケージを参照します。

- `Asp.Versioning.Http` 10.0.0
- `Asp.Versioning.Mvc.ApiExplorer` 10.0.0
- `Asp.Versioning.OpenApi` 10.0.0-rc.1

コントローラーの場合は `Asp.Versioning.Http` を `Asp.Versioning.Mvc` 10.0.0 に差し替えます。実際の仕事をしているのは `OpenApi` パッケージです。バージョニングライブラリがすでに生成している API explorer モデルを、`Microsoft.AspNetCore.OpenApi` が期待するドキュメントトランスフォーマーパイプラインに橋渡しします。このリリース以前は、`IApiVersionDescriptionProvider` を読み、ドキュメントごとに操作をフィルターするトランスフォーマーを自前で書く必要がありました。そのコードが今では箱の中に入っています。

## バージョンごとに 1 ドキュメント、3 行で

サービス登録は OpenAPI 以前のバージョニングのストーリーから変わらず、`.AddOpenApi()` 呼び出しが 1 つ追加されるだけです。

```csharp
builder.Services.AddApiVersioning()
    .AddApiExplorer(options =>
    {
        options.GroupNameFormat = "'v'VVV";
    })
    .AddOpenApi();
```

エンドポイント側で新しい拡張メソッドが登場します。

```csharp
app.MapOpenApi().WithDocumentPerVersion();
```

`WithDocumentPerVersion()` は `DescribeApiVersions()` が返すものを列挙し、バージョンごとに 1 つのドキュメントを登録します。`/openapi/v1.json` と `/openapi/v2.json` にアクセスすると、各バージョンに属する操作だけを取得でき、ドキュメント間で共有された operation ID やスキーマの重複が漏れ出すこともありません。Scalar (`app.MapScalarApiReference()`) も Swagger UI (`app.UseSwaggerUI()`) も同じ API バージョン記述プロバイダーを通じてドキュメントを自動検出するため、ブラウザ側の選択 UI は無料で配線されます。

## バージョン付きルートグループ

minimal API ではルート側もコンパクトなままです。バージョン付き API を一度宣言し、その下にバージョンごとのグループをぶら下げます。

```csharp
var usersApi = app.NewVersionedApi("Users");

var usersV1 = usersApi.MapGroup("api/users").HasApiVersion("1.0");
var usersV2 = usersApi.MapGroup("api/users").HasApiVersion("2.0");

usersV1.MapGet("", () => Results.Ok(new { shape = "v1" }));
usersV2.MapGet("", () => Results.Ok(new { shape = "v2" }));
```

`Users` という名前が API グループになり、`HasApiVersion` が API explorer の読む値となって、各エンドポイントがどの OpenAPI ドキュメントに属するかを決めます。

## なぜ今これが重要なのか

ASP.NET Core 9 や 10 で新規アプリを始め、原則として Swashbuckle を外していた場合、戻ってこさせる唯一の要因がバージョニングでした。`Asp.Versioning.OpenApi` 10.0.0-rc.1 によってその非常口は閉じます。RC 接尾辞は待つべき唯一の理由です。出荷される API 表面はこのままで、チームは .NET 10 のサービストレインに合わせて GA を狙っています。完全なサンプルは [投稿からリンクされている Sander のリポジトリ](https://devblogs.microsoft.com/dotnet/api-versioning-in-dotnet-10-applications/) にあり、次に手書きのトランスフォーマーに手を伸ばす前にクローンしておく価値があります。
