---
title: "修正: Swashbuckle.AspNetCore を v9 に更新すると OpenAPI 3.0 を出力できない"
description: "Swashbuckle 8 以降は openapi 3.0.1 ではなく 3.0.4 を出力し、パッチバージョン用の OpenApiSpecVersion は存在しません。変更の理由と、ツールが期待する文字列に固定する 4 つの方法を解説します。"
pubDate: 2026-08-19
template: error-page
tags:
  - "errors"
  - "swashbuckle"
  - "openapi"
  - "aspnetcore"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/08/fix-cannot-target-openapi-3-0-after-upgrading-swashbuckle-aspnetcore"
translatedBy: "claude"
translationDate: 2026-08-19
---

`Swashbuckle.AspNetCore` を 9.x に更新したところ、コードは `OpenApiSpecVersion.OpenApi3_0` のままなのに、生成されるドキュメントが `"openapi": "3.0.1"` ではなく `"openapi": "3.0.4"` になりました。下流のツールはこれを拒否しますが、選択できる `OpenApi3_0_1` という列挙メンバーは存在しません。このバージョン文字列は Swashbuckle の設定ではなく、`Microsoft.OpenApi` の中にハードコードされたリテラルです。1.6.22 以前は `3.0.1` を、1.6.23 以降は `3.0.4` を書き込みます。1.6.23 への依存を取り込んだのは Swashbuckle 8.0.0 なので、7.x の境界をまたいだ人すべてがこの変更に当たります。以下の対処は優先順に、コンシューマー側を更新する、ミドルウェアで自分でプロパティを書き換える、Swashbuckle のスタック全体を 7.2.0 に固定する、の順です。

ここに書かれた内容はすべて .NET SDK 10.0.201 の `net10.0` 上で、Swashbuckle.AspNetCore 6.5.0、7.2.0、8.1.4、9.0.6、10.2.3 を使って計測しています。

## エラーの実際の出力

CLI にパッチバージョンを直接指定した場合:

```text
System.NotSupportedException: The specified OpenAPI version "3.0.1" is not supported.
   at Swashbuckle.AspNetCore.Cli.Program.<>c.<Main>b__1_5(IDictionary`2 namedArgs)
   at Swashbuckle.AspNetCore.Cli.CommandRunner.Run(IEnumerable`1 args)
   at Swashbuckle.AspNetCore.Cli.Program.Main(String[] args)
```

Swashbuckle 9 のまま `Microsoft.OpenApi` を据え置こうとした場合:

```text
error NU1605: Warning As Error: Detected package downgrade: Microsoft.OpenApi from 1.6.25 to 1.6.22.
  Reference the package directly from the project to select a different version.
   MyApi -> Swashbuckle.AspNetCore 9.0.6 -> Swashbuckle.AspNetCore.Swagger 9.0.6 -> Microsoft.OpenApi (>= 1.6.25)
   MyApi -> Microsoft.OpenApi (>= 1.6.22)
```

さらに NU1605 を抑止して強行した場合:

```text
error CS1705: Assembly 'Swashbuckle.AspNetCore.SwaggerGen' with identity
'Swashbuckle.AspNetCore.SwaggerGen, Version=9.0.6.0, ...' uses 'Microsoft.OpenApi, Version=1.6.25.0, ...'
which has a higher version than referenced assembly 'Microsoft.OpenApi' with identity
'Microsoft.OpenApi, Version=1.6.22.0, ...'
```

古い Swagger UI のビルドは、ドキュメントを次のように表示します:

```text
Unable to render this definition
The provided definition does not specify a valid version field.
Please indicate a valid Swagger or OpenAPI version field. Supported version fields are
swagger: "2.0" and those that match openapi: 3.x.y (for example, openapi: 3.1.0).
```

## なぜバージョン文字列が 3.0.4 で、制御できないのですか

`OpenApiSpecVersion` は小さな列挙型で、どのメンバーもパッチ番号を持っていません。Swashbuckle 9.0.6 が依存する `Microsoft.OpenApi` 1.6.25 では、メンバーはちょうど 2 つです:

```text
OpenApi2_0
OpenApi3_0
```

Swashbuckle 10.2.3 が依存する `Microsoft.OpenApi` 2.7.5 では、1 つ増えます:

```text
OpenApi2_0
OpenApi3_0
OpenApi3_1
```

3.0.1、3.0.3、3.0.4 に相当するメンバーはありません。パッチバージョンはシリアライザーのオプションではないからです。`OpenApiDocument.SerializeAsV3` はコンパイル時定数を書き出します。この変更は、配布されているアセンブリの文字列ダンプで確認できます:

```text
strings -a -e l on lib/netstandard2.0/Microsoft.OpenApi.dll:
  1.2.3   -> 3.0.1
  1.6.22  -> 3.0.1
  1.6.23  -> 3.0.4
  1.6.25  -> 3.0.4
  2.7.5   -> 3.0.4 and 3.1.1
```

この引き上げは 2024-12-20 にマージされた [OpenAPI.NET PR #2011](https://github.com/microsoft/OpenAPI.NET/pull/2011) で入りました。v2 の挙動を v1 系列に反映したものです。バグではありません。OpenAPI 3.0.4 は仕様の正式なパッチリリースであり、最新のパッチを出力するのが正しい既定値です。問題は、多くのコンシューマーが `openapi` フィールドを `3.0.x` のパターンではなく、ハードコードされた許可リストと照合している点にあります。

## どの Swashbuckle バージョンがどのパッチバージョンを出力しますか

`openapi` フィールドは、csproj に書いた Swashbuckle のバージョンではなく、実際に解決された `Microsoft.OpenApi` のアセンブリに従います:

| Swashbuckle.AspNetCore | Microsoft.OpenApi (宣言値) | `openapi` フィールド |
| --- | --- | --- |
| 6.5.0 | 1.2.3 | `3.0.1` |
| 7.2.0 | 1.6.22 | `3.0.1` |
| 8.0.0 から 8.1.4 | 1.6.23 | `3.0.4` |
| 9.0.0 から 9.0.6 | 1.6.23 から 1.6.25 | `3.0.4` |
| 10.0.0 から 10.2.3 | 2.3.0 から 2.7.5 | `3.0.4`、`OpenApi3_1` 指定時は `3.1.1` |

注意点が 2 つあります。1 つめは、実際の境界が 9.0.0 ではなく 8.0.0 だということです。7.x から 9.x へ一気に上げた場合、気づかないうちに境界をまたいでいます。2 つめは、NuGet の依存関係が下限であって固定ではないことです。Swashbuckle 7.2.0 のプロジェクトでも、`Microsoft.OpenApi` 1.6.23 以降を引き込む別の参照があれば新しいアセンブリに解決され、Swashbuckle を一切変更していないのに `3.0.4` を出力し始めます。ドキュメントが変わったのに Swashbuckle のバージョンが変わっていないなら、まず次を実行してください:

```bash
dotnet list package --include-transitive
```

## net10.0 での最小再現コード

```csharp
// .NET SDK 10.0.201, net10.0, Swashbuckle.AspNetCore 9.0.6
using Microsoft.OpenApi;
using Microsoft.OpenApi.Models;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen(o =>
    o.SwaggerDoc("v1", new OpenApiInfo { Title = "Demo", Version = "v1" }));

var app = builder.Build();
app.UseSwagger(o => o.OpenApiVersion = OpenApiSpecVersion.OpenApi3_0);
app.MapGet("/orders/{id}", (int id) => new Order(id, "open", null)).WithName("GetOrder");
app.Run();

record Order(int Id, string Status, string? Note);
```

`GET /swagger/v1/swagger.json` は次を返します:

```json
{
  "openapi": "3.0.4",
  "info": { "title": "Demo", "version": "v1" },
  "paths": { }
}
```

ここで `OpenApiVersion` を明示的に設定しても何も変わりません。`OpenApi3_0` はすでに既定値であり、列挙型にはそれ以上細かい粒度がないからです。

## CLI にパッチバージョンを渡せますか

渡せません。`dotnet swagger tofile` は `--openapiversion` を 3 つの文字列だけの閉じた集合と照合します。v10.2.3 のソースから:

```csharp
// Swashbuckle.AspNetCore.Cli/Program.cs, v10.2.3
specVersion = versionArg switch
{
    "2.0" => OpenApiSpecVersion.OpenApi2_0,
    "3.0" => OpenApiSpecVersion.OpenApi3_0,
    "3.1" => OpenApiSpecVersion.OpenApi3_1,
    _ => throw new NotSupportedException($"The specified OpenAPI version \"{versionArg}\" is not supported."),
};
```

9.0.6 では `"3.1"` の分岐も存在しないため、入力できるのは `2.0` と `3.0` だけです。10.2.3 で許可された各値の実測出力は、`2.0` が `"swagger": "2.0"`、`3.0` が `"openapi": "3.0.4"`、`3.1` が `"openapi": "3.1.1"` です。`3.0.1` や `3.1.1` を含むそれ以外の値は例外になります。

CLI について 1 点補足です。9.0.6 のツールは `net9.0` の apphost を同梱しているため、.NET 10 ランタイムしか入っていないマシンでは起動を拒否します。呼び出す前に `DOTNET_ROLL_FORWARD=Major` を設定するか、対応するランタイムをインストールしてください。

## Microsoft.OpenApi を 1.6.22 に下げれば解決しますか

Swashbuckle 9 でも 10 でも解決しません。そして、これが古い issue スレッドで最もよく見かける助言です。直接参照を追加すると、まず NU1605 が発生します。NuGet はこれを既定でエラー扱いにします。`<WarningsNotAsErrors>NU1605</WarningsNotAsErrors>` で抑止すると、復元は 1.6.22 に解決しますが、今度はコンパイルが `CS1705` で失敗します。`Swashbuckle.AspNetCore.Swagger` 9.0.6 が 1.6.25 のアセンブリ ID に対してビルドされているためです。どちらの失敗も、まっさらな `net10.0` プロジェクトで再現します。

バージョン固定の道は、スタック全体を戻した場合にのみ機能します:

```xml
<!-- net10.0, verified: emits "openapi": "3.0.1" -->
<ItemGroup>
  <PackageReference Include="Swashbuckle.AspNetCore" Version="7.2.0" />
  <PackageReference Include="Microsoft.OpenApi" Version="1.6.22" />
</ItemGroup>
```

Swashbuckle 7.2.0 は今も `netstandard2.0` を対象にしており、`net10.0` で問題なく動作し、`Microsoft.OpenApi` を 1.6.22 に解決します。`Microsoft.OpenApi` の明示的な参照は、推移的な引き上げで再び先へ進んでしまうのを防ぐためのものです。これは解決策ではなく、期限付きの一時しのぎと考えてください。OpenAPI ジェネレーターをメジャー 2 世代前で凍結することになり、8.x と 9.x にはいずれ必要になるスキーマ生成の修正が含まれています。

## Swashbuckle 9 や 10 でバージョン文字列を書き換えるには

フックはありません。Swashbuckle のメンテナーも [issue #3540](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/issues/3540) でそう述べています。`SwaggerMiddleware` は間に何も挟まずレスポンスストリームへ直接シリアライズします。彼らが提案し、実際に通用する回避策は、レスポンスをバッファリングしてプロパティを編集することです。オブジェクトモデルに一切触れないため、9.0.6 と 10.2.3 で同じように動作します:

```csharp
// net10.0, Swashbuckle.AspNetCore 9.0.6 and 10.2.3, both verified
app.UseWhen(
    ctx => ctx.Request.Path.StartsWithSegments("/swagger")
        && ctx.Request.Path.Value!.EndsWith(".json"),
    branch => branch.Use(async (ctx, next) =>
    {
        var original = ctx.Response.Body;
        using var buffer = new MemoryStream();
        ctx.Response.Body = buffer;

        await next();

        ctx.Response.Body = original;
        if (ctx.Response.StatusCode != StatusCodes.Status200OK)
        {
            buffer.Position = 0;
            await buffer.CopyToAsync(original);
            return;
        }

        var json = Encoding.UTF8.GetString(buffer.ToArray())
            .Replace("\"openapi\": \"3.0.4\"", "\"openapi\": \"3.0.1\"", StringComparison.Ordinal);
        var bytes = Encoding.UTF8.GetBytes(json);
        ctx.Response.ContentLength = bytes.Length;
        await original.WriteAsync(bytes);
    }));

app.UseSwagger(o => o.OpenApiVersion = OpenApiSpecVersion.OpenApi3_0);
app.UseSwaggerUI();
```

登録は `UseSwagger` より前に行ってください。Swagger UI は動作し続け、`/swagger/index.html` も 200 を返し、JSON エンドポイントは `3.0.1` を返します。重要な点が 2 つあります。書き込み前に `ctx.Response.Body` を元のストリームへ戻すことと、置換でバイト数が変わるため書き換え後に `ContentLength` を設定することです。`.EndsWith(".json")` の判定は、UI の静的アセットにバッファリングが及ばないようにするためのものです。YAML も配信している場合は、そちら用の分岐を追加してください。YAML ではプロパティが `openapi: '3.0.4'` として書かれるため、JSON 向けの置換は一致しません。

バッファリングを避けたい場合は、エンドポイント自体を置き換えて、自分でドキュメントをシリアライズします:

```csharp
// net10.0, Swashbuckle.AspNetCore 9.0.6
app.MapGet("/swagger/v1/swagger.json", (ISwaggerProvider provider) =>
{
    var document = provider.GetSwagger("v1");
    var node = JsonNode.Parse(document.SerializeAsJson(OpenApiSpecVersion.OpenApi3_0))!;
    node["openapi"] = "3.0.1";
    return Results.Text(
        node.ToJsonString(new JsonSerializerOptions { WriteIndented = true }),
        "application/json");
}).ExcludeFromDescription();
```

`ExcludeFromDescription()` は省略できません。付けないとエンドポイントが自分自身を検出し、`/swagger/v1/swagger.json` が自身の出力の中に記述済みパスとして現れます。`SerializeAsJson` は 1.6.x 系列では `Microsoft.OpenApi.Extensions` にありますが、`Microsoft.OpenApi` 2.x を使う Swashbuckle 10 ではこの拡張が削除されているため、そちらではミドルウェアを選んでください。

`dotnet swagger tofile` や `OpenApiGenerateDocumentsOnBuild` によるビルド時生成のドキュメントであれば、これらをコードで行う必要はありません。`--openapiversion 3.0` で生成し、ビルド手順としてファイルを書き換えます:

```bash
jq '.openapi = "3.0.1"' swagger.json > swagger.tmp && mv swagger.tmp swagger.json
```

## Swagger UI がまだ定義を拒否する場合は

ブラウザーに "The provided definition does not specify a valid version field" と表示される場合、ドキュメントは正しく、UI が古いだけです。swagger-ui は [v5.19.0](https://github.com/swagger-api/swagger-ui/releases/tag/v5.19.0)（2025-02-17 リリース）で [PR #10247](https://github.com/swagger-api/swagger-ui/pull/10247) により 3.0.4 に対応しました。Swashbuckle は `Swashbuckle.AspNetCore.SwaggerUI` 7.3.0 でこれを取り込んでいます。それより古いものは、完全に有効な 3.0.4 ドキュメントに対してこのエラーを表示します。

落とし穴は、同一ソリューション内でのバージョンのずれです。`Swashbuckle.AspNetCore.SwaggerUI` は別パッケージなので、3 つのサブパッケージを個別に参照しているプロジェクトでは、`Swagger` と `SwaggerGen` だけ上げて `SwaggerUI` が取り残されがちです。3 つとも確認したうえで、ブラウザーをキャッシュ無視で再読み込みしてください。同梱の `swagger-ui-bundle.js` は強くキャッシュされます。

問題がドキュメントではなくレンダラー側にあるなら、[Scalar でドキュメントを配信する方法](/ja/2026/08/how-to-serve-openapi-docs-with-scalar-instead-of-swagger-ui-in-aspnetcore-11/)を検討するよい機会でもあります。Scalar は 3.0.4 も 3.1 も問題なく読み込みます。

## 本当に 3.1 が必要な場合は

その場合は Swashbuckle 10 以降が必要です。`Microsoft.OpenApi` 1.6.x には `OpenApi3_1` メンバー自体が存在しません。10.x ではオプトインなので、既定は 3.0.4 のままで、3.1 は明示的に要求します:

```csharp
// net10.0, Swashbuckle.AspNetCore 10.2.3, emits "openapi": "3.1.1"
app.UseSwagger(o => o.OpenApiVersion = OpenApiSpecVersion.OpenApi3_1);
```

更新には時間を見込んでください。Swashbuckle 10 は `Microsoft.OpenApi` v2 へ移行し、名前空間がフラット化されるため、最初に遭遇するのは次のエラーです:

```text
error CS0234: The type or namespace name 'Models' does not exist in the namespace 'Microsoft.OpenApi'
```

型は `Microsoft.OpenApi` 直下に移動したので、`using Microsoft.OpenApi.Models;` を削除してください。それ以外にも、具象のモデル型はインターフェースになり（`OpenApiSchema` は `IOpenApiSchema` へ）、文字列の型名は `JsonSchemaType` 列挙値になり、`WithOpenApi()` はサポートされなくなります。[v10 移行ガイド](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/blob/master/docs/migrating-to-v10.md)はまず 9.0.6 を経由することを勧めており、これは妥当な助言です。9.x の破壊的変更（`netstandard2.0` の廃止、廃止済みメンバーの削除、`--serializeasv2` の削除）を OpenAPI.NET v2 側の変更から切り離せます。

## どの対処を選ぶべきですか

私が実際に取る順番です:

1. コンシューマー側を更新する。`3.0.4` は有効な OpenAPI 3.0 であり、現行のバリデーター、ジェネレーター、ゲートウェイはいずれも受け付けます。この種の報告のほとんどは、3 世代遅れたツールが原因です。
2. コンシューマーが動かせないベンダー製なら、ミドルウェアでの書き換えを入れる。20 行程度で、バージョンに依存せず、依存グラフを凍結しません。
3. ドキュメントが実行時配信ではなくビルド時生成なら、CI で `jq` を使ってファイルを書き換える。
4. Swashbuckle の 7.2.0 固定は、撤去用のチケットを添えた応急処置としてのみ使う。

検索結果が何と言おうと機能しないのは、現行の Swashbuckle の下で `Microsoft.OpenApi` をダウングレードすることと、パッチバージョンを表す `OpenApiSpecVersion` メンバーを探すことです。

## 関連記事

- [Swashbuckle から組み込みの OpenAPI ジェネレーターへの移行](/ja/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/)は逆方向の話で、Swashbuckle のバージョン追従を続けるより離れたい場合に役立ちます。
- ['OpenApiReference' could not be found のコンパイルエラー](/ja/2026/08/fix-the-type-or-namespace-name-openapireference-could-not-be-found/)は、同じ `Microsoft.OpenApi` v2 の名前空間フラット化から生じる兄弟エラーです。
- [IOperationFilter と ISchemaFilter をトランスフォーマーへ対応付ける](/ja/2026/07/migrate-swashbuckle-ioperationfilter-and-ischemafilter-to-transformers-in-dotnet-11/)は、移行のなかで最も時間のかかる部分です。
- [Scalar と Swagger UI の比較](/ja/2026/08/scalar-vs-swagger-ui-for-openapi-documentation-in-aspnetcore-11/)は、バージョン拒否が下流サービスではなくレンダラー由来だった場合に読む価値があります。
- [OpenAPI 仕様から厳密に型付けされたクライアントを生成する](/ja/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/)は、ドキュメントを拒否しているのがコードジェネレーターの場合に関係します。

## 参考資料

- [OpenAPI.NET PR #2011: bumps v3 patch version to 3.0.4](https://github.com/microsoft/OpenAPI.NET/pull/2011)
- [Swashbuckle.AspNetCore issue #3540: changing the openapi version in swagger.json](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/issues/3540)
- [Swashbuckle.AspNetCore issue #3216: 7.2.0 json doc says openapi 3.0.4](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/issues/3216)
- [Swashbuckle.AspNetCore issue #3265: add support for OpenAPI 3.0.4](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/issues/3265)
- [Swashbuckle.AspNetCore v9.0.0 リリースノート](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/releases/tag/v9.0.0)
- [Swashbuckle.AspNetCore v10.0.0 リリースノート](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/releases/tag/v10.0.0)
- [Swashbuckle.AspNetCore v10 移行ガイド](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/blob/master/docs/migrating-to-v10.md)
- [swagger-ui v5.19.0 リリースノート](https://github.com/swagger-api/swagger-ui/releases/tag/v5.19.0)
