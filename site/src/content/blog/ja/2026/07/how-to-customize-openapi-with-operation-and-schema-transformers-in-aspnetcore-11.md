---
title: "ASP.NET Core 11 で AddOperationTransformer と AddSchemaTransformer を使って OpenAPI ドキュメントをカスタマイズする方法"
description: ".NET 11 に組み込まれた OpenAPI トランスフォーマーパイプラインの詳細解説：operation トランスフォーマーと schema トランスフォーマーの違い、コンテキストオブジェクト、実行順序、DI で活性化されるトランスフォーマー、そしてヘッダー・レスポンス・サンプル・プロパティ単位の調整のためのレシピ。"
pubDate: 2026-07-12
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "openapi"
lang: "ja"
translationOf: "2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-12
---

.NET 11 に組み込まれた `Microsoft.AspNetCore.OpenApi` ジェネレーターは OpenAPI ドキュメントを所有しており、そこから出力される内容を変更する手段がトランスフォーマーです。トランスフォーマーは 3 種類あります：ドキュメント全体に対する `AddDocumentTransformer`、パスとメソッドの組み合わせによるすべての operation に対する `AddOperationTransformer`、そしてすべてのデータモデルに対する `AddSchemaTransformer` です。すべてのエンドポイントにヘッダーパラメーターや共通のレスポンスを追加するには、operation トランスフォーマーを使います。型やプロパティに format・サンプル・説明を設定するには、schema トランスフォーマーを使います。この記事は `Microsoft.AspNetCore.OpenApi` と `Microsoft.OpenApi` v2 を使う .NET 11（`net11.0`、C# 14）を対象とし、単なる一行のコードを超えて、コンテキストオブジェクト、多くの人がつまずく実行順序、そして .NET 8 のサンプルをコピーしてもコンパイルが通らない Microsoft.OpenApi v2 の型の変更まで踏み込みます。

まだドキュメントを生成していない場合は、[Swashbuckle なしで OpenAPI を公開する方法](/ja/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/)から始めてください。以下の内容はすべて、`builder.Services.AddOpenApi()` と `app.MapOpenApi()` がすでに配置されていることを前提としています。

## 各トランスフォーマーが触れてよいもの

3 種類のトランスフォーマーは互いに置き換えできるものではなく、間違ったものを選ぶことが最もよくある失敗です。ルールはスコープに関するものです：

- **ドキュメントトランスフォーマー**は `OpenApiDocument` 全体を見ます。`Info`、`servers`、トップレベルの `tags`、セキュリティスキームに適したツールです。これらはルートに存在するからです。
- **operation トランスフォーマー**は operation ごとに 1 回呼び出されます。operation とは一意なパスと HTTP メソッドの組み合わせです（`GET /todos/{id}` は 1 つの operation、`POST /todos` は別の operation です）。すべてのエンドポイントに変更を加えたい場合、あるいはメタデータから読み取れる条件にマッチするエンドポイントに変更を加えたい場合に使います。
- **schema トランスフォーマー**はジェネレーターが生成するすべてのスキーマ（ネストされたものも含む）に対して呼び出されます。リクエストボディとレスポンスボディの形状（format、サンプル、説明、nullability、非推奨化）に触れる場所です。

ドキュメントトランスフォーマーから「すべての operation」にレスポンスを追加しようとすると、`document.Paths` を手作業で辿ることになります。operation トランスフォーマーを使えば、フレームワークが各 operation を直接手渡してくれます。逆も同じです：operation トランスフォーマーから `document.Info` を設定すると、エンドポイントごとに 1 回実行され、自分自身を上書きしてしまいます。変更しようとしているものの高度（altitude）にトランスフォーマーを合わせてください。

## グローバルヘッダーを追加してスキーマを整える 4 ステップ

以下がコアとなる手順の全体像です。ここでは、すべてのエンドポイントに相関 ID ヘッダーを刻印する operation トランスフォーマーを 1 つと、ある型の format を修正する schema トランスフォーマーを 1 つ登録します。

1. **`AddOpenApi` のオプションブロックを開く。** 3 つの `Add*Transformer` メソッドはすべて `OpenApiOptions` にぶら下がっているので、`AddOpenApi(options => { ... })` のデリゲート内で登録します。

2. **ヘッダー用の operation トランスフォーマーを登録する。** デリゲートのシグネチャは `(OpenApiOperation operation, OpenApiOperationTransformerContext context, CancellationToken ct)` です。`operation` をその場で変更し、`Task` を返します。

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

builder.Services.AddOpenApi(options =>
{
    options.AddOperationTransformer((operation, context, cancellationToken) =>
    {
        operation.Parameters ??= [];
        operation.Parameters.Add(new OpenApiParameter
        {
            Name = "X-Correlation-Id",
            In = ParameterLocation.Header,
            Required = false,
            Description = "Client-supplied request id, echoed back in the response.",
            Schema = new OpenApiSchema { Type = JsonSchemaType.String }
        });
        return Task.CompletedTask;
    });
});
```

3. **型用の schema トランスフォーマーを登録する。** そのデリゲートは `(OpenApiSchema schema, OpenApiSchemaTransformerContext context, CancellationToken ct)` です。典型的な例は、`decimal` が float ではなく金額の精度を持つことを利用者に伝えることです：

```csharp
// .NET 11, C# 14
options.AddSchemaTransformer((schema, context, cancellationToken) =>
{
    if (context.JsonTypeInfo.Type == typeof(decimal))
    {
        schema.Format = "decimal";
    }
    return Task.CompletedTask;
});
```

4. **再生成して確認する。** `/openapi/v1.json` をリクエストします。これで、すべての operation が `X-Correlation-Id` ヘッダーパラメーターを持ち、すべての `decimal` プロパティが `"format": "decimal"` を表示するはずです。`MapOpenApi` はリクエストごとにドキュメントを再生成するため、アプリ自体以外に再起動するものはありません。

これがループの全体です。この記事の残りの部分は、これらのトランスフォーマーを意外性のあるものではなく信頼できるものにするための詳細です。

## コンテキストオブジェクトをプロパティごとに見る

各トランスフォーマーはコンテキストを受け取ります。そしてコンテキストが異なるのは、各トランスフォーマーが知っている情報が異なるからです。

**operation** コンテキスト（`OpenApiOperationTransformerContext`）は `DocumentName`、`Description`（エンドポイントの `ApiDescription`）、`ApplicationServices`（`IServiceProvider`）を公開します。重要なのは `Description` です。これはルート、HTTP メソッド、`ActionDescriptor.EndpointMetadata` を保持しており、トランスフォーマーを条件付きにする方法になります。たとえば、実際にレート制限ポリシーが付いているエンドポイントにだけ `429` レスポンスを追加します：

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.RateLimiting;

options.AddOperationTransformer((operation, context, cancellationToken) =>
{
    var isRateLimited = context.Description.ActionDescriptor.EndpointMetadata
        .OfType<EnableRateLimitingAttribute>()
        .Any();

    if (isRateLimited)
    {
        operation.Responses ??= new OpenApiResponses();
        operation.Responses["429"] = new OpenApiResponse
        {
            Description = "Too many requests. Retry after the window resets."
        };
    }

    return Task.CompletedTask;
});
```

**schema** コンテキスト（`OpenApiSchemaTransformerContext`）は `DocumentName`、`JsonTypeInfo`、`JsonPropertyInfo`、`ApplicationServices` を公開します。`JsonTypeInfo` は記述対象となっている型の `System.Text.Json` メタデータなので、`context.JsonTypeInfo.Type` は CLR の `Type` です。`JsonPropertyInfo` は特定のプロパティ用にスキーマが生成されている場合にのみ設定され、型全体ではなく 1 つのメンバーを狙い撃ちできます：

```csharp
// .NET 11, C# 14
using System.Text.Json.Nodes;

options.AddSchemaTransformer((schema, context, cancellationToken) =>
{
    // Target the Email property on any type that has one.
    if (context.JsonPropertyInfo?.Name == "email")
    {
        schema.Format = "email";
        schema.Example = JsonValue.Create("dev@example.com");
    }

    return Task.CompletedTask;
});
```

**document** コンテキスト（`OpenApiDocumentTransformerContext`）は `DocumentName`、`DescriptionGroups`（`ApiDescriptionGroups`）、`ApplicationServices` を公開します。ドキュメントトランスフォーマーを使うのは、対象がドキュメントのルートである場合で、最も多いのはセキュリティスキームです。これについては後述します。

## 実行順序は schema、次に operation、最後に document

これが「変更が消えた」というバグ報告を生み出す部分です。トランスフォーマーは、ファイルを読んで期待する順序では実行されません。フレームワークは次の順序で実行します：

- **schema トランスフォーマーが最初。** すべてのスキーマは、いずれかの operation が処理される前にドキュメントに登録されるため、すべての schema トランスフォーマーがすべての operation トランスフォーマーより前に実行されます。schema トランスフォーマー同士は登録順に実行され、後のものは前のものの変更を見ます。
- **operation トランスフォーマーが次。** それぞれは自身の operation が追加されたときに、すべてのスキーマが存在した後で、登録順に実行されます。operation トランスフォーマーが実行される時点では、その operation の型のスキーマはすでに整形されています。
- **document トランスフォーマーが最後。** これらはすべての operation とスキーマが揃った最終パスで実行されます。後の document トランスフォーマーは前のものの編集を見ます。

実際上の帰結：document トランスフォーマーがスキーマがすでに特定の形に整形されていることを必要とする場合、スキーマは先に実行されているのでそうなっています。しかし operation トランスフォーマーは document トランスフォーマーが実行済みであることに依存できません。document は最後に実行されるからです。複数のドキュメントを生成する場合、パイプライン全体がドキュメントごとに独立して実行されるため、`internal` ドキュメントに登録されたトランスフォーマーは `public` には決して触れません。

## 強く型付けされたトランスフォーマーと依存性注入

インラインのデリゲートはステートレスな調整には十分です。トランスフォーマーがサービスを必要とする場合は、インターフェースを実装し、その型を登録してフレームワークが DI から活性化するようにします。インターフェースは `IOpenApiDocumentTransformer`、`IOpenApiOperationTransformer`、`IOpenApiSchemaTransformer` で、それぞれ単一の `TransformAsync` を持ちます。プライマリコンストラクターを使って注入します：

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

internal sealed class BearerSecuritySchemeTransformer(
    IAuthenticationSchemeProvider authenticationSchemeProvider) : IOpenApiDocumentTransformer
{
    public async Task TransformAsync(
        OpenApiDocument document,
        OpenApiDocumentTransformerContext context,
        CancellationToken cancellationToken)
    {
        var schemes = await authenticationSchemeProvider.GetAllSchemesAsync();
        if (schemes.Any(s => s.Name == "Bearer"))
        {
            document.Components ??= new OpenApiComponents();
            document.Components.SecuritySchemes["Bearer"] = new OpenApiSecurityScheme
            {
                Type = SecuritySchemeType.Http,
                Scheme = "bearer",
                In = ParameterLocation.Header,
                BearerFormat = "JSON Web Token"
            };
        }
    }
}

// Registration
builder.Services.AddOpenApi(options =>
{
    options.AddDocumentTransformer<BearerSecuritySchemeTransformer>();
});
```

DI で活性化されるトランスフォーマーは、ジェネリックオーバーロード（`AddDocumentTransformer<T>()`）、事前構築済みのインスタンス（`AddDocumentTransformer(new T())`）、あるいはデリゲートで登録します。依存性注入に参加するのはジェネリック形式だけです。ジェネリック形式はドキュメント生成ごとに新しく解決され、その後破棄されるため、`IDisposable` を実装したトランスフォーマーはドキュメントが生成されるたびにクリーンアップされます。この生成ごとのライフタイムこそが、トランスフォーマーを軽量に保つべき理由です：`MapOpenApi` エンドポイントが有効な場合、ドキュメントのルートへのリクエストごとにパイプラインが実行されます。ドキュメントの構築にコストがかかる場合は、`.CacheOutput()` でエンドポイントをキャッシュするか、[ビルド時](/ja/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/)に生成してください。

セキュリティスキームの登録は、document トランスフォーマーの代表的な仕事です。スキームを配線したのにビューアーが依然としてトークンを無視する場合、原因はほぼ常にクライアントのバグではなくドキュメント内の不正なスキームです。これは [Scalar で Bearer トークンが無視される理由](/ja/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/)で最初から最後まで追跡しました。対応するエンドポイント単位の Swagger UI のフローについては、[OpenAPI 認証フローの追加](/ja/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/)を参照してください。

## エンドポイント単位の operation トランスフォーマー

すべての operation に変更を加えたいとは限りません。単一のエンドポイントに登録された operation トランスフォーマーは、エンドポイントビルダーの `AddOpenApiOperationTransformer` を介して、そのエンドポイントに対してのみ実行されます。1 つのルートを非推奨としてマークするのは一行で済みます：

```csharp
// .NET 11, C# 14
app.MapGet("/v1/report", GenerateReport)
   .AddOpenApiOperationTransformer((operation, context, cancellationToken) =>
   {
       operation.Deprecated = true;
       operation.Description = "Superseded by /v2/report. Removed in the next major version.";
       return Task.CompletedTask;
   });
```

これはきれいにスコープされます：`context.Description` を嗅ぎ回る必要も、ルートマッチングも不要で、アタッチしたエンドポイントだけが対象です。エンドポイントのグループ化とも相性がよく、グループにアタッチされたトランスフォーマーはその中のすべての operation に流れます。そのパターンについては [MapGroup による Minimal API エンドポイントの整理](/ja/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)を参照してください。

## スキーマをその場で生成する

ときには operation トランスフォーマーが、エンドポイントが他の方法では参照しない型のスキーマ（たとえば共通のエラーボディ）を必要とすることがあります。.NET 10 以降、トランスフォーマーコンテキストは `GetOrCreateSchemaAsync` を公開しており、これはジェネレーターが使うのと同じロジックでスキーマを構築します。そして `context.Document.AddComponent` はそれを再利用のために `components.schemas` の下に置きます：

```csharp
// .NET 11, C# 14
options.AddOperationTransformer(async (operation, context, cancellationToken) =>
{
    var errorSchema = await context.GetOrCreateSchemaAsync(
        typeof(ProblemDetails), null, cancellationToken);
    context.Document?.AddComponent("Error", errorSchema);

    operation.Responses ??= new OpenApiResponses();
    operation.Responses["4XX"] = new OpenApiResponse
    {
        Description = "Bad request.",
        Content = new Dictionary<string, OpenApiMediaType>
        {
            ["application/problem+json"] = new OpenApiMediaType
            {
                Schema = new OpenApiSchemaReference("Error", context.Document)
            }
        }
    };
});
```

これは、すべてのエンドポイントを `Produces<ProblemDetails>` で装飾することなく、一貫したエラー契約を文書化するきれいな方法です。エラーレスポンスを文書化するだけでなく、それ自体を整形しようとしている場合、それは別の関心事であり、[IProblemDetailsService](/ja/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/)で扱います。

## 古いサンプルを壊す Microsoft.OpenApi v2 の型の変更

.NET 10 は `Microsoft.OpenApi` の依存関係を v2 にアップグレードし、オブジェクトモデルは、.NET 8 のトランスフォーマーを貼り付けてもコンパイルが通らない形で変更されました。特に噛みつくのは 3 つの変更です：

**`OpenApiSchema.Type` は文字列ではなくフラグ列挙型になりました。** v1 では `Type = "string"` と別途 `Nullable = true` を書いていました。v2 では `Type` は null 許容の `JsonSchemaType` であり、nullability は `Null` フラグを合併（union）することで表現します：

```csharp
// .NET 11, Microsoft.OpenApi v2
// A nullable string:
schema.Type = JsonSchemaType.String | JsonSchemaType.Null;
```

**サンプルは `OpenApiString` ではなく `JsonNode` です。** `IOpenApiAny` の階層全体（`OpenApiString`、`OpenApiInteger`、`OpenApiObject`）が削除されました。代わりに `System.Text.Json.Nodes.JsonNode` を割り当てます。これが上のプロパティの例で `JsonValue.Create(...)` を使った理由です。オブジェクトのサンプルには `JsonObject` を構築します。これは古い schema フィルターを移行するときに最もコンパイルに失敗しやすい 1 つの編集で、この点は [Swashbuckle から組み込みへの移行ガイド](/ja/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/)でより深く掘り下げています。

**参照は型付けされました。** `OpenApiReference` を手作業で構築する代わりに、`OpenApiSchemaReference("Name", document)` と `OpenApiSecuritySchemeReference("Bearer", document)` を使います。これらは渡したドキュメントに対して解決され、参照切れをシリアライズ時ではなく構築時に捕捉します。

## ドキュメントが正しく見えた後に表面化する落とし穴

**schema トランスフォーマーは同じ型に対して複数回実行されることがあります。** schema トランスフォーマーはスキーマの出現ごとに発火し、同一のスキーマを `components.schemas` に重複排除するパスは、すべてのトランスフォーマーの*後*で実行されます。したがって 3 か所で使われる型は、その schema トランスフォーマーが 3 回呼び出される可能性があります。ロジックを冪等に保ってください：追加する前にチェックし、再訪するかもしれないリストには決して追加（append）しないでください。

**スキーマの再利用はトランスフォーマーから制御できるものではありません。** スキーマがインライン化されるか `components.schemas` に持ち上げられるかは、トランスフォーマーの実行後に `OpenApiOptions.CreateSchemaReferenceId` を使ってフレームワークが決定します。列挙型は常に参照されます。代わりにインライン化するには、そのデリゲートから列挙型に対して `null` を返します：

```csharp
// .NET 11, C# 14
options.CreateSchemaReferenceId = type =>
    type.Type.IsEnum ? null : OpenApiOptions.CreateDefaultSchemaReferenceId(type);
```

**operation トランスフォーマーは document トランスフォーマーの成果を見ることができません。** document は最後に実行されるため、document トランスフォーマーにスキームを置いて、同じ実行内の operation トランスフォーマーからそれを参照しようとしないでください。スキーム*と* operation 単位の要件を同じ document トランスフォーマーから登録するか、最後に `document.Paths` を辿る document トランスフォーマーから operation 単位で要件を適用してください。

**API エクスプローラーが見るものだけが文書化されます。** トランスフォーマーは存在するものを整形します。エクスプローラーが発見しなかった operation を発明することはできません。Minimal API が `Produces<T>` なしで素の `IResult` を返す場合、トランスフォーマーが触れるレスポンススキーマは存在しません。まずエンドポイントに注釈を付けてください。正確なスキーマは下流でも重要です。なぜなら [強く型付けされたクライアントジェネレーター](/ja/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/)は、渡すドキュメントの品質次第だからです。

一度腑に落ちれば、メンタルモデルは小さなものです：スキーマが最初に整形され、operation が次、document が最後で、各トランスフォーマーは自分の名前が示すレイヤーだけに触れます。高度を選び、その場で変更し、冪等に保ってください。そうすれば提供するドキュメントは、利用者とコードジェネレーターが期待するとおりのものになります。

## 関連する読み物

- [ASP.NET Core 11 で Swashbuckle なしで OpenAPI を公開する方法](/ja/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/)
- [.NET 11 で Swashbuckle から組み込みの OpenAPI ドキュメント生成へ移行する](/ja/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/)
- [.NET 11 で Swagger UI に OpenAPI 認証フローを追加する方法](/ja/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/)
- [ASP.NET Core における Scalar：Bearer トークンが無視される理由](/ja/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/)
- [ASP.NET Core 11 で MapGroup を使って Minimal API エンドポイントを整理する方法](/ja/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)

## 出典

- [Customize OpenAPI documents, ASP.NET Core docs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/customize-openapi?view=aspnetcore-10.0)
- [IOpenApiOperationTransformer, .NET API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.openapi.iopenapioperationtransformer)
- [IOpenApiSchemaTransformer, .NET API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.openapi.iopenapischematransformer)
- [Breaking change: Microsoft.OpenApi upgraded to v2, ASP.NET Core docs](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/11/microsoft-openapi-3x?view=aspnetcore-10.0)
- [Microsoft.OpenAPI v2 upgrade guide](https://github.com/microsoft/OpenAPI.NET/blob/main/docs/upgrade-guide-2.md)
