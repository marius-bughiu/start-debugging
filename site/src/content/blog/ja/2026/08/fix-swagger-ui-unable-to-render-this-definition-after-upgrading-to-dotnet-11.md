---
title: ".NET 11 へのアップグレード後に Swagger UI が Unable to render this definition と表示される問題の解決"
description: "ASP.NET Core 11 は既定で openapi 3.2.0 を出力し、10.1.5 未満の Swagger UI はこれを拒否します。Swashbuckle.AspNetCore.SwaggerUI を更新するか、OpenApiVersion を OpenApi3_1 に固定してください。"
pubDate: 2026-08-19
template: error-page
tags:
  - "errors"
  - "openapi"
  - "swagger"
  - "swashbuckle"
  - "aspnetcore"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/08/fix-swagger-ui-unable-to-render-this-definition-after-upgrading-to-dotnet-11"
translatedBy: "claude"
translationDate: 2026-08-19
---

API は変わらず起動し、`/openapi/v1.json` も 200 を返すのに、Swagger UI のページには「定義に有効なバージョンフィールドが指定されていない」というグレーのボックスだけが表示されます。原因は .NET 11 での既定値の変更です。`AddOpenApi` は `"openapi": "3.1.1"` ではなく `"openapi": "3.2.0"` を書き出すようになり、`Swashbuckle.AspNetCore.SwaggerUI` 10.1.4 以前に同梱される Swagger UI バンドルは `3.0.x` と `3.1.x` しか受け付けません。このパッケージを 10.1.5 以降に更新するか、`options.OpenApiVersion = OpenApiSpecVersion.OpenApi3_1` を設定してください。エンドポイントもトランスフォーマーもスキーマも壊れてはいません。

以下の内容はすべて .NET SDK `11.0.100-preview.7.26381.103` と `Microsoft.AspNetCore.OpenApi` `11.0.0-preview.7.26381.103`（`Microsoft.OpenApi` 3.9.0 に解決されます）で計測し、.NET SDK 10.0.201 と `Microsoft.AspNetCore.OpenApi` 10.0.10 と比較したものです。

## エラーの実際の表示

Swagger UI は操作一覧全体をこのパネルに置き換えます。

```text
Unable to render this definition

The provided definition does not specify a valid version field.

Please indicate a valid Swagger or OpenAPI version field. Supported version
fields are swagger: "2.0" and those that match openapi: 3.x.y (for example,
openapi: 3.1.0).
```

この文言は 2 つの点で誤解を招きます。ドキュメントにはバージョンフィールドが存在しますし、`3.2.0` はメッセージが説明する `3.x.y` という形にも合致しています。バンドルが実際に行っているのは、メジャーとマイナーの部分を固定の許可リストと突き合わせることであり、古いビルドではそのリストに `3.2` が入っていないのです。

サーバー側の例外を探す必要はありません。ドキュメントのエンドポイントは正常です。

```bash
curl -s http://localhost:5331/openapi/v1.json | head -3
```

```json
{
  "openapi": "3.2.0",
  "info": {
```

この 1 行目がすべてです。そこに `3.2.0` が出ていて、ブラウザーにグレーのボックスが出ているなら、このページが探していたものです。

## .NET 11 が openapi 3.2.0 を出力する理由

`OpenApiOptions.OpenApiVersion` の既定値は .NET 11 Preview 6 で `OpenApiSpecVersion.OpenApi3_1` から `OpenApiSpecVersion.OpenApi3_2` に変わりました。Microsoft はこれを、追加設定なしで最新の仕様を取り込めるようにするための意図的な動作変更として文書化しています（[OpenApiVersion の既定値が OpenApi3_2 に](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/11/openapi-version-default-3-2?view=aspnetcore-10.0)）。

この既定値が使えるようになったのは、その 1 つ前のプレビューでのもう 1 つの変更のおかげです。.NET 11 Preview 3 で `Microsoft.AspNetCore.OpenApi` が `Microsoft.OpenApi` 2.x から 3.x に移行し、OpenAPI 3.2.0 のシリアライザーを追加したのが 3.x 系だからです（[Microsoft.OpenApi が 3.x に更新](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/11/microsoft-openapi-3x?view=aspnetcore-10.0)）。依存関係の固定はパッケージ自体に表れています。`Microsoft.AspNetCore.OpenApi` 11.0.0-preview.7 は `Microsoft.OpenApi` `[3.9.0, 4.0.0)` を宣言していますが、10.0.10 は `2.0.0` を宣言していました。

重要な帰結は、バージョン文字列は変わったのにドキュメントは変わっていない、という点です。詳しくは後述します。

## 最小限の再現

API 3 行と Swagger UI の登録 1 つで足ります。

```xml
<!-- net11.0, .NET SDK 11.0.100-preview.7.26381.103 -->
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.AspNetCore.OpenApi" Version="11.0.0-preview.7.26381.103" />
    <PackageReference Include="Swashbuckle.AspNetCore.SwaggerUI" Version="9.0.6" />
  </ItemGroup>
</Project>
```

```csharp
// .NET 11, C# 14, Microsoft.AspNetCore.OpenApi 11.0.0-preview.7.26381.103
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddOpenApi();

var app = builder.Build();
app.MapOpenApi();
app.UseSwaggerUI(o => o.SwaggerEndpoint("/openapi/v1.json", "v1"));

app.MapGet("/todos/{id:int}", (int id) => new Todo(id, "write post", Status.Open, null));
app.MapPost("/todos", (Todo todo) => Results.Created($"/todos/{todo.Id}", todo));
app.Run();

internal enum Status { Open, Done }
internal record Todo(int Id, string Title, Status Status, DateTimeOffset? DueAt);
```

`/swagger` を開くとグレーのボックスが出ます。コンソールにもログにも何も出ず、ページもドキュメントも HTTP 200 です。

`Swashbuckle.AspNetCore.SwaggerUI` は独立したパッケージである点に注意してください。この現象に遭遇するのに Swashbuckle のジェネレーターは不要です。ここでのドキュメントは組み込みジェネレーターが生成しており、Swashbuckle から来ているのは UI のアセットだけです。[Swashbuckle なしで OpenAPI を公開する](/ja/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/)ガイドに従いつつ、使い慣れた `/swagger` ページを残しているなら、まさにこの構成で動いています。

## どの Swagger UI バージョンから 3.2.0 ドキュメントが表示されるか

同じ 3.2.0 ドキュメントに対してパッケージを二分探索しました。境界は `Swashbuckle.AspNetCore.SwaggerUI` 10.1.5 です。

| SwaggerUI パッケージ | 同梱の swagger-ui | `openapi: 3.2.0` を表示 |
| --- | --- | --- |
| 9.0.6 | 5.29.1 | いいえ |
| 10.0.0 | 5.30.2 | いいえ |
| 10.1.0 | 5.31.0 | いいえ |
| 10.1.4 | 5.31.1 | いいえ |
| 10.1.5 | 5.32.0 | はい |
| 10.1.7 | 5.32.1 | はい |
| 10.2.3 | 5.32.7 | はい |

10.1.5 以降ではヘッダーのバッジが `OAS 3.2` になり、すべての操作とスキーマが通常どおり表示されます。したがって最初の解決策は 1 行のパッケージ更新です。

```xml
<!-- first version whose bundled swagger-ui accepts 3.2.0 -->
<PackageReference Include="Swashbuckle.AspNetCore.SwaggerUI" Version="10.1.5" />
```

こちらを優先してください。ドキュメントを最新の仕様に保てますし、`Swashbuckle.AspNetCore.SwaggerUI` は静的アセットと middleware 拡張を 1 つ提供するだけなのでコストもかかりません。一方で `Swashbuckle.AspNetCore` メタパッケージ全体を参照している場合、10.2.x への更新は同じ UI アセットをもたらしますが、ジェネレーターも一緒に引き込みます。その境界を越える前に、[Swashbuckle が出力する OpenAPI バージョン文字列を固定する方法](/ja/2026/08/fix-cannot-target-openapi-3-0-after-upgrading-swashbuckle-aspnetcore/)の解説を読んでください。

## ドキュメントを OpenAPI 3.1 に戻す方法

UI パッケージを動かせない場合、あるいは下流の別のツールも 3.2 を拒否する場合は、ジェネレーター側でバージョンを明示的に指定します。

```csharp
// .NET 11, C# 14. Microsoft.OpenApi 3.9.0 supplies OpenApiSpecVersion.
using Microsoft.OpenApi;

builder.Services.AddOpenApi(options =>
{
    options.OpenApiVersion = OpenApiSpecVersion.OpenApi3_1;
});
```

`using Microsoft.OpenApi;` は重要です。`OpenApiSpecVersion` はフラットなルート名前空間にあり、`Microsoft.OpenApi.Models` にはありません。後者は .NET 10 に同梱された 2.x 系の時点ですでに削除されています。

このオプションを設定すると .NET 11 は `"openapi": "3.1.2"` を書き出し、`Swashbuckle.AspNetCore.SwaggerUI` 9.0.6 は `OAS 3.1` バッジ付きでこれを表示します。パッチ部分に注目してください。.NET 10 は `3.1.1` を書いていましたが、同じ列挙値でも .NET 11 は `3.1.2` を書きます。メジャーとマイナーではなくバージョン文字列全体で一致判定する利用側は、それでもつまずきます。`OpenApiSpecVersion.OpenApi3_0` も引き続き受け付けられ、`3.0.4` を生成します。

利用側ごとに必要なバージョンが異なるなら、名前付きドキュメントを複数登録できます。

```csharp
// .NET 11, C# 14
builder.Services.AddOpenApi("v1");                                   // 3.2.0
builder.Services.AddOpenApi("v1-31", o =>
    o.OpenApiVersion = OpenApiSpecVersion.OpenApi3_1);               // 3.1.2
```

これで同じエンドポイントのメタデータから `/openapi/v1.json` と `/openapi/v1-31.json` が得られ、古いクライアントジェネレーターは 3.1 を読み続け、UI と新しいクライアントは 3.2 を読めます。

## 3.2.0 ドキュメントに実際に入っているもの

トランスフォーマーの点検に半日を費やす前に、この点を押さえておく価値があります。通常の minimal API では、3.2.0 のドキュメントと 3.1.2 のドキュメントはバージョン文字列を除いて同一です。

1 つのアプリ（int、string、enum、null 許容の `DateTimeOffset` を持つ record と、`IFormFile` によるアップロード）から 3 つのバージョンを生成して差分を取りました。3.1 と 3.2 の差分は 2 行で、いずれも `openapi` フィールドとドキュメントのタイトルでした。スキーマもパラメーターもレスポンスもコンポーネントも 1 つとして変わっていません。

一方、3.0 と 3.1 の差分は実質的です。JSON Schema との整合はそこで入ったからです。

```json
// OpenAPI 3.0.4
"dueAt": { "type": "string", "format": "date-time", "nullable": true }
```

```json
// OpenAPI 3.1.2 and 3.2.0
"dueAt": { "type": ["null", "string"], "format": "date-time" }
```

つまり .NET 11 へのアップグレード後にクライアントジェネレーターが壊れたからといって `OpenApi3_0` に落として「直した」つもりでいると、契約内のすべての省略可能プロパティの null 許容表現を変えてしまっています。代わりに `OpenApi3_1` に落としてください。それが .NET 10 ですでに配信していたペイロードとバイト単位で一致するバージョンです。

## Scalar でも同じ問題が起きるのか

リファレンスを [Swagger UI ではなく Scalar](/ja/2026/08/how-to-serve-openapi-docs-with-scalar-instead-of-swagger-ui-in-aspnetcore-11/) で配信している場合、このエラーは起きません。同じ .NET 11 アプリを `Scalar.AspNetCore` 2.16.20 と 2.14.14 で動かしたところ、どちらも 3.2.0 ドキュメントを表示し、ヘッダーに `OpenAPI 3.2.0` と出しました。

NuGet のグラフが不穏に見えても、これは成り立ちます。`Scalar.AspNetCore.Microsoft` 2.16.20 には `net11.0` のターゲットグループが一切ないため、`net11.0` プロジェクトはその `net10.0` アセットを解決します。それらは `Microsoft.OpenApi` 2.7.5 に対してコンパイルされており、実行時には統合された 3.9.0 アセンブリに対して読み込まれます。これはまさに Microsoft.OpenApi 3.x の破壊的変更の注意書きが警告しているバイナリ互換性のリスクですが、ここでは無害でした。`AddScalarTransformers()` と `ExcludeFromApiReference()` はどちらも動作し、期待どおり `x-scalar-ignore` 拡張を出力しました。

手書きのトランスフォーマーについても同様です。bearer のセキュリティスキームを登録するドキュメントトランスフォーマーと、`x-schema-id` を付与するスキーマトランスフォーマーは、どちらも .NET 10 向けに `Microsoft.OpenApi` 2.x に対して書かれたものでしたが、3.9.0 の .NET 11 上で無変更のままコンパイルも実行もできました。トランスフォーマーが読み取り中心か、拡張とセキュリティスキームを設定するだけなら、2.x から 3.x への移行コストはゼロと見積もって構いません。入れ子のスキーマをたどる、参照を構築する、削除された `ParseNode` の解析基盤を使っていた、といった場合は、まず[トランスフォーマーのパイプライン解説](/ja/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/)と OpenAPI.NET の移行ノートを読んでください。

## 似ているがこのバグではない失敗

**グレーのボックスすら出ない真っ白なページ。** これは別の失敗で、UI がドキュメントを受け取れていません。ルートを確認してください。`MapOpenApi` は `/openapi/{documentName}.json` を提供するので、パターンを変えたなら `SwaggerEndpoint` か Scalar の `WithOpenApiRoutePattern` で UI に伝える必要があります。バージョンを疑う前に、ページが実際に要求している JSON の URL を curl してください。

**ドキュメント URL が HTTP 500 を返す。** その場合はトランスフォーマーが例外を投げ、表示すべきものがなかったということです。最も多い原因は .NET 11 の退行ですらありません。`OpenApiSchema.Extensions` は代入するまで `null` であり、これは `Microsoft.OpenApi` 2.x でも 3.x でも同じなので、`schema.Extensions["x-foo"] = ...` は .NET 10 でも .NET 11 でも同様に `NullReferenceException` を投げます。次のように保護してください。

```csharp
// .NET 11, C# 14, Microsoft.OpenApi 3.9.0
options.AddSchemaTransformer((schema, context, ct) =>
{
    schema.Extensions ??= new Dictionary<string, IOpenApiExtension>();
    schema.Extensions["x-schema-id"] =
        new JsonNodeExtension(JsonValue.Create(context.JsonTypeInfo.Type.Name));
    return Task.CompletedTask;
});
```

**`error CS0200: Property or indexer 'IOpenApiMediaType.Example' cannot be assigned to -- it is read only`。** これは .NET 11 の正真正銘の副作用で、混在したソリューションで現れます。集中パッケージ管理、浮動バージョン、あるいは `net11.0` アプリからの共有参照によって `net10.0` プロジェクトが `Microsoft.OpenApi` 3.9.0 を解決してしまうと、.NET 10 SDK の OpenAPI XML コメントソースジェネレーターが 3.x のオブジェクトモデルに対してコンパイルできません。ソリューション全体を 1 つのバージョンに浮動させるのではなく、`net10.0` プロジェクトは `Microsoft.OpenApi` 2.x に留めてください。

**`System.MissingMethodException: Method not found: '... Microsoft.OpenApi.OpenApiOperation.get_Extensions()'`。** これはバイナリ互換性の失敗パターンで、グラフ内のどれかのライブラリが実行時にはもう存在しない `Microsoft.OpenApi` の API 面に対してコンパイルされていることを意味します。.NET 11 へのアップグレード単体が原因ではありません。他より大きく古いバージョンで固定されたパッケージか、自分の csproj にある明示的な `Microsoft.OpenApi` 参照が推移的な参照と競合していないかを探してください。

## 関連記事

- [ASP.NET Core 11 で Swashbuckle なしに OpenAPI を公開する方法](/ja/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/)
- [解決: Swashbuckle.AspNetCore を v9 に更新後 OpenAPI 3.0 を指定できない](/ja/2026/08/fix-cannot-target-openapi-3-0-after-upgrading-swashbuckle-aspnetcore/)
- [AddOperationTransformer と AddSchemaTransformer で OpenAPI ドキュメントをカスタマイズする方法](/ja/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/)
- [Swagger UI の代わりに Scalar で OpenAPI ドキュメントを配信する方法](/ja/2026/08/how-to-serve-openapi-docs-with-scalar-instead-of-swagger-ui-in-aspnetcore-11/)
- [.NET 11 で Swashbuckle から組み込み OpenAPI ジェネレーターへ移行する](/ja/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/)

## 出典

- [破壊的変更: OpenApiVersion の既定値が OpenApi3_2 に](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/11/openapi-version-default-3-2?view=aspnetcore-10.0), Microsoft Learn
- [破壊的変更: Microsoft.OpenApi が 3.x に更新](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/11/microsoft-openapi-3x?view=aspnetcore-10.0), Microsoft Learn
- [OpenAPI ドキュメントの生成](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/aspnetcore-openapi?view=aspnetcore-10.0), Microsoft Learn
- [OpenAPI.NET リリースノート](https://github.com/microsoft/OpenAPI.NET/releases), GitHub の microsoft/OpenAPI.NET
- [Scalar.AspNetCore.Microsoft がトランスフォーマーで失敗する](https://github.com/scalar/scalar/issues/6020), scalar/scalar の issue 6020
