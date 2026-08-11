---
title: "解決: The type or namespace name 'OpenApiReference' could not be found"
description: "OpenApiReference は Microsoft.OpenApi 2.0 で削除されました。using を Microsoft.OpenApi に変えるだけでは不十分で、各箇所を OpenApiSchemaReference のような型付き参照に置き換えます。"
pubDate: 2026-08-11
template: error-page
tags:
  - "errors"
  - "aspnetcore"
  - "dotnet"
  - "dotnet-10"
  - "dotnet-11"
  - "openapi"
lang: "ja"
translationOf: "2026/08/fix-the-type-or-namespace-name-openapireference-could-not-be-found"
translatedBy: "claude"
translationDate: 2026-08-11
---

`OpenApiReference` はもう存在しません。Microsoft.OpenApi 2.0 はモデルの名前空間をすべて `Microsoft.OpenApi` に統合し、さらに汎用の参照型そのものを削除しました。そのため `using Microsoft.OpenApi.Models;` を `using Microsoft.OpenApi;` に置き換えても、名前空間のエラーが消えるだけでこのエラーは残ります。対処法は、`new OpenApiReference { Type = ..., Id = "X" }` を、参照先コンポーネントに対応する型付き参照クラス、たとえば `new OpenApiSchemaReference("X", document)` や `new OpenApiSecuritySchemeReference("Bearer", document)` に置き換えることです。以下の内容はすべて SDK 10.0.201、`Microsoft.AspNetCore.OpenApi` 10.0.10、`Microsoft.OpenApi` 2.11.0 で検証しています。

## エラーの実際の姿

この系統のエラーは 2 種類あり、検索から来る読者はそのどちらかを見ています。古い `using` ディレクティブが残っている場合、コンパイラーは型ではなく名前空間について文句を言います。

```
error CS0234: The type or namespace name 'Models' does not exist in the namespace 'Microsoft.OpenApi' (are you missing an assembly reference?)
error CS0234: The type or namespace name 'Any' does not exist in the namespace 'Microsoft.OpenApi' (are you missing an assembly reference?)
```

その using を削除するか `using Microsoft.OpenApi;` に置き換えると、本当にここへたどり着く原因となったエラーが現れます。

```
error CS0246: The type or namespace name 'OpenApiReference' could not be found (are you missing a using directive or an assembly reference?)
error CS0246: The type or namespace name 'OpenApiString' could not be found (are you missing a using directive or an assembly reference?)
error CS0117: 'OpenApiSecurityScheme' does not contain a definition for 'Reference'
error CS0029: Cannot implicitly convert type 'string' to 'Microsoft.OpenApi.JsonSchemaType?'
error CS1061: 'OpenApiDocument' does not contain a definition for 'SerializeAsJson'
```

2 番目のブロックが決定的な手がかりです。`CS0234` は「名前空間が移動した」という意味です。一方 `OpenApiReference` に対する `CS0246` は「型そのものが無くなった」という意味であり、どんな using ディレクティブを書いても戻ってきません。

## なぜ起きるのか

`Microsoft.AspNetCore.OpenApi` は 10.0 リリース以降、Microsoft.OpenApi 2.x に強く依存するようになり、.NET 11 もそれを引き継いでいます。素の `net10.0` Web プロジェクトにパッケージを追加すると、推移的な依存関係が確認できます。

```
> Microsoft.AspNetCore.OpenApi      10.0.10     10.0.10
   > Microsoft.OpenApi              2.0.0
```

Microsoft.OpenApi 2.0 では、あなたのコードの同じ 1 行に集中して効いてくる 3 つの変更が入りました。

- **名前空間が統合されました。** `Microsoft.OpenApi.Models`、`Microsoft.OpenApi.Any`、`Microsoft.OpenApi.Interfaces`、`Microsoft.OpenApi.Writers` が `Microsoft.OpenApi` にまとめられました。公開アセンブリが公開する名前空間はちょうど 3 つ、`Microsoft.OpenApi`、`Microsoft.OpenApi.Reader`、`Microsoft.OpenApi.MicrosoftExtensions` だけです。
- **`OpenApiReference` が削除されました。** 参照可能なすべてのモデルから `Reference` プロパティも消えています。`OpenApiSecurityScheme` には `Reference` メンバーが一切存在せず、これが上の `CS0117` の正体です。
- **参照がファーストクラスの型になりました。** 空のモデルに参照を貼り付けるのではなく、参照先と同じインターフェースを実装する専用の参照オブジェクトを構築します。

組み込みのジェネレーターではなく Swashbuckle を使っている場合も、同じ崖がひとつ隣のパッケージにあります。Swashbuckle.AspNetCore 9.0.6 は `Microsoft.OpenApi` 1.6.25 を解決するため古いコードはそのままコンパイルできますが、Swashbuckle.AspNetCore 10.1.0 は `Microsoft.OpenApi` 2.3.0 を解決するためコンパイルできなくなります。壊す原因は SDK の更新ではなく Swashbuckle の更新です。

## 最小再現コード

これはほとんどの人が持っている形で、たいていは JWT のチュートリアルからコピーした Swagger の `AddSecurityRequirement` 呼び出しの中にあります。

```csharp
// FAILS on .NET 10/11 with Microsoft.OpenApi 2.x
using Microsoft.OpenApi.Models;
using Microsoft.OpenApi.Any;

var reference = new OpenApiReference
{
    Type = ReferenceType.SecurityScheme,
    Id = "Bearer"
};

var scheme = new OpenApiSecurityScheme
{
    Reference = reference
};

var schema = new OpenApiSchema
{
    Type = "string",
    Default = new OpenApiString("hello")
};

var json = new OpenApiDocument().SerializeAsJson(OpenApiSpecVersion.OpenApi3_0);
```

6 行のなかに 5 つの異なる破壊的変更が含まれています。コンパイルエラーを 1 つずつ潰していくやり方は時間がかかるので、対応表を先にまとめて把握しておくのが有効です。

## 修正手順

### 1. using ディレクティブを置き換える

`Microsoft.OpenApi.*` のモデル用 using はすべて 1 つに収束します。

```csharp
// .NET 11, Microsoft.OpenApi 2.11.0
using Microsoft.OpenApi;
using System.Text.Json.Nodes;   // needed wherever you used IOpenApiAny
```

プロジェクト全体で `using Microsoft.OpenApi.Models;` を `using Microsoft.OpenApi;` に置換して問題ありません。`using Microsoft.OpenApi.Any;` と `using Microsoft.OpenApi.Interfaces;` はそのまま削除します。

### 2. OpenApiReference を型付き参照に置き換える

ここがどんな `using` でも直らない部分です。Microsoft.OpenApi 2.x は参照可能なコンポーネントごとに参照クラスを用意しており、どれも `(string referenceId, OpenApiDocument hostDocument = null, string externalResource = null)` という同じコンストラクター形状を持ちます。

| 旧 `ReferenceType` | 新しい型 |
| --- | --- |
| `ReferenceType.Schema` | `OpenApiSchemaReference` |
| `ReferenceType.SecurityScheme` | `OpenApiSecuritySchemeReference` |
| `ReferenceType.Parameter` | `OpenApiParameterReference` |
| `ReferenceType.RequestBody` | `OpenApiRequestBodyReference` |
| `ReferenceType.Response` | `OpenApiResponseReference` |
| `ReferenceType.Header` | `OpenApiHeaderReference` |
| `ReferenceType.Example` | `OpenApiExampleReference` |
| `ReferenceType.Link` | `OpenApiLinkReference` |
| `ReferenceType.Callback` | `OpenApiCallbackReference` |
| `ReferenceType.Tag` | `OpenApiTagReference` |
| `ReferenceType.PathItem` | `OpenApiPathItemReference` |

これによりセキュリティスキームへの参照は 1 つの式になります。

```csharp
// .NET 11, Microsoft.OpenApi 2.11.0
// old: new OpenApiSecurityScheme { Reference = new OpenApiReference { Type = ReferenceType.SecurityScheme, Id = "Bearer" } }
var schemeRef = new OpenApiSecuritySchemeReference("Bearer", document);
```

これらの参照型は参照先のインターフェースを実装しているため（`OpenApiSchemaReference` は `IOpenApiSchema`、`OpenApiSecuritySchemeReference` は `IOpenApiSecurityScheme` です）、以前モデル自身を受け取っていたコレクションにそのまま収まります。

### 3. 同じ行に生じた巻き添えを直す

同じブロックには、たいていもう 3 つの変更が現れます。

- `OpenApiSchema.Type` は `string` からフラグ列挙型 `JsonSchemaType` に変わりました。メンバーは `Null`、`Boolean`、`Integer`、`Number`、`String`、`Object`、`Array` です。`[Flags]` 列挙型なので、OpenAPI 3.1 の null 許容は別の `Nullable` プロパティではなく `JsonSchemaType.String | JsonSchemaType.Null` と表現します。
- `IOpenApiAny` の階層全体（`OpenApiString`、`OpenApiInteger`、`OpenApiArray`、`OpenApiObject` など）は削除され、`System.Text.Json.Nodes` の `JsonNode` に置き換わりました。
- `SerializeAsJson` と `SerializeAsYaml` は非同期の拡張メソッド `SerializeAsJsonAsync` と `SerializeAsYamlAsync` になりました。`Maximum`、`Minimum`、`ExclusiveMaximum`、`ExclusiveMinimum` は任意精度の数値がラウンドトリップで保たれるよう `double?` から `string?` に変わっています。

### 4. 完成版の動作するコード

上の再現コードを、.NET 11 アプリで実際に登録するドキュメントトランスフォーマーとして書き直したものが以下です。`Microsoft.AspNetCore.OpenApi` 10.0.10 に対して警告なくコンパイルできます。

```csharp
// .NET 11, Microsoft.AspNetCore.OpenApi 10.0.10, Microsoft.OpenApi 2.11.0
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

public sealed class BearerSecuritySchemeTransformer : IOpenApiDocumentTransformer
{
    public Task TransformAsync(
        OpenApiDocument document,
        OpenApiDocumentTransformerContext context,
        CancellationToken cancellationToken)
    {
        document.Components ??= new OpenApiComponents();
        document.Components.SecuritySchemes ??= new Dictionary<string, IOpenApiSecurityScheme>();

        document.Components.SecuritySchemes["Bearer"] = new OpenApiSecurityScheme
        {
            Type = SecuritySchemeType.Http,
            Scheme = "bearer",
            BearerFormat = "JWT",
            In = ParameterLocation.Header
        };

        document.Security ??= new List<OpenApiSecurityRequirement>();
        document.Security.Add(new OpenApiSecurityRequirement
        {
            [new OpenApiSecuritySchemeReference("Bearer", document)] = new List<string>()
        });

        return Task.CompletedTask;
    }
}
```

スキーマ側の対応は次のとおりです。

```csharp
// .NET 11, Microsoft.OpenApi 2.11.0
var schema = new OpenApiSchema
{
    Type = JsonSchemaType.String | JsonSchemaType.Null,   // was Type = "string" + Nullable = true
    Default = (JsonNode)"hello",                          // was new OpenApiString("hello")
    Enum = new List<JsonNode> { (JsonNode)"a", (JsonNode)"b" },
    Maximum = "100"                                       // was double? Maximum = 100
};

IOpenApiSchema widgetRef = new OpenApiSchemaReference("Widget", document);

string json = await document.SerializeAsJsonAsync(OpenApiSpecVersion.OpenApi3_1);
```

このように構築したドキュメントをシリアライズすると、セキュリティ要件はスキーマ名で表現され、コンポーネントもそのまま残った、期待どおりの出力が得られます。

```json
{
  "openapi": "3.1.1",
  "components": {
    "securitySchemes": {
      "Bearer": { "type": "http", "scheme": "bearer", "bearerFormat": "JWT" }
    }
  },
  "security": [ { "Bearer": [ ] } ]
}
```

## コンパイルが通った後に効いてくる落とし穴

**Microsoft.OpenApi を 3.x に上げて「解決」しようとしてはいけません。** NuGet 上の最新版が 3.9.0 で、ASP.NET Core 10 が 2.0.0 に固定していることを考えると、つい試したくなります。しかし組み込みジェネレーターを使うプロジェクトに 3.9.0 の明示的な `PackageReference` を追加すると、Microsoft 自身の生成コードの中でビルドが失敗します。

```
obj\Debug\net10.0\Microsoft.AspNetCore.OpenApi.SourceGenerators\...\OpenApiXmlCommentSupport.generated.cs(399,41):
error CS0200: Property or indexer 'IOpenApiMediaType.Example' cannot be assigned to -- it is read only
```

`Microsoft.AspNetCore.OpenApi` 10.0.10 に同梱される XML コメント用ソースジェネレーターは 2.x のサーフェスに合わせて書かれています。ASP.NET Core 側のパッケージが動くまでは 2.x 系にとどめてください。

**ただし Microsoft.OpenApi は 2.7.5 以降に固定してください。** ASP.NET Core 10.0.10 が推移的に解決する 2.0.0 には重大度「高」の勧告があり、NuGet は復元時にそれを知らせます。

```
warning NU1903: Package 'Microsoft.OpenApi' 2.0.0 has a known high severity vulnerability
```

これは CVE-2026-49451、スキーマの循環参照における制御されない再帰で、2.0.0-preview.11 から 2.7.4 まで、および 3.0.0 から 3.5.3 までが影響を受けます。明示的に `<PackageReference Include="Microsoft.OpenApi" Version="2.11.0" />` を追加すれば警告は消え、10.0.10 のソースジェネレーターに対しても問題なくビルドできます。自分で書いたものではない OpenAPI ドキュメントをアプリが解析する場合に特に重要です。

**コレクションは自動的に初期化されなくなりました。** 1.x では `new OpenApiDocument().Components` が空の `OpenApiComponents` を返していました。2.x では null で、`Components.Schemas`、`Components.SecuritySchemes`、`Document.Tags` も同様です。`Paths` と `Servers` は引き続き初期化されます。上のトランスフォーマーがインデックス参照の前に各階層で `??=` を使っているのはこのためで、アップグレード後にビルドが通った直後に最も多く見る `NullReferenceException` の原因でもあります。

**参照はドキュメントの workspace を通じて遅延的に解決されます。** ASP.NET Core に任せずドキュメントを手で組み立てる場合、コンポーネントを登録するまで参照の `Target` は null のままで、委譲されるプロパティも空のまま返ります。

```csharp
// .NET 11, Microsoft.OpenApi 2.11.0
var reference = new OpenApiSchemaReference("Widget", document);
// reference.Target is null here, reference.Description is empty

document.Workspace.RegisterComponents(document);
// reference.Target is now resolved, reference.Description reads through to the target
```

解決は遅延的なので、`RegisterComponents` の呼び出し前に作った参照でも、呼び出し後には正しく解決されるようになります。シリアライズはいずれにせよ `$ref` を出力するため、意外に感じるのはプロキシ経由の読み取りのほうです。

**トランスフォーマーのシグネチャにあるインターフェース型に注意してください。** `Components.Schemas` は `IDictionary<string, IOpenApiSchema>`、`Components.SecuritySchemes` は `IDictionary<string, IOpenApiSecurityScheme>` であり、具象クラスではありません。具象型を前提にしていたコードにはキャストかパターンマッチが必要です。値がインラインのスキーマではなく参照オブジェクトである可能性があるからです。

**`OpenApiSecuritySchemeReference` は `$ref` としては出力されません。** その `Reference.ReferenceV3` は単に `Bearer` ですが、`OpenApiSchemaReference("Widget")` のほうは `#/components/schemas/Widget` になります。これは OpenAPI 仕様どおりで、セキュリティ要件はスキーマ名で指定されます。出力に `$ref` が無いからといって探し回る必要はありません。

## 関連記事

より広範な OpenAPI のアップグレードに取り組んでいる場合、隣接する話題は次の記事で扱っています。Swashbuckle からの移行は [Swashbuckle から組み込みの OpenAPI ジェネレーターへ移行する](/ja/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/) に、それに伴うフィルターからトランスフォーマーへの書き換えは [IOperationFilter と ISchemaFilter を OpenAPI トランスフォーマーに移植する](/ja/2026/07/migrate-swashbuckle-ioperationfilter-and-ischemafilter-to-transformers-in-dotnet-11/) にあります。トランスフォーマー API そのものについては [AddOperationTransformer と AddSchemaTransformer でドキュメントをカスタマイズする](/ja/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/) を参照してください。ドキュメントが再びビルドできるようになったら表示先も必要で、それは [Scalar で OpenAPI ドキュメントを配信する](/ja/2026/08/how-to-serve-openapi-docs-with-scalar-instead-of-swagger-ui-in-aspnetcore-11/) に書いてあります。このエラーがより大きな移行の一部として出たのであれば、[.NET 8 から .NET 11 へのチェックリスト](/ja/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) に同時期に動いた他のパッケージがまとめてあります。

## 参考資料

- [OpenAPI.NET 2.0 アップグレードガイド](https://github.com/microsoft/OpenAPI.NET/blob/main/docs/upgrade-guide-2.md)。削除された型と名前が変わったプロパティの決定版リストです。
- [dotnet/aspnetcore の Issue 61123](https://github.com/dotnet/aspnetcore/issues/61123)。.NET 10 Preview 2 で `OpenApiSecurityScheme.Reference` が消えたという報告です。
- [Swashbuckle.AspNetCore の Issue 3522](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/issues/3522)。名前空間の変更が Swashbuckle 利用者を直撃した記録です。
- [GHSA-v5pm-xwqc-g5wc](https://github.com/advisories/GHSA-v5pm-xwqc-g5wc) / CVE-2026-49451。`NU1903` 警告の根拠となった勧告です。
