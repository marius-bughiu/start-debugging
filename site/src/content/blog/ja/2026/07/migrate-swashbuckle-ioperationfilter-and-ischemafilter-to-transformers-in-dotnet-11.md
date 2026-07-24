---
title: ".NET 11 で Swashbuckle の IOperationFilter と ISchemaFilter を OpenAPI トランスフォーマーに移行する"
description: "Swashbuckle の IOperationFilter と ISchemaFilter のコードを .NET 11 の組み込みのオペレーショントランスフォーマーとスキーマトランスフォーマーへ移すための、フィルターごとの移行リファレンスです。コンテキストオブジェクトのマッピングと、コンパイルを壊す Microsoft.OpenApi v2 の変更を扱います。"
pubDate: 2026-07-24
updatedDate: 2026-07-24
template: migration
tags:
  - "migration"
  - "swashbuckle"
  - "openapi"
  - "aspnetcore-11"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/07/migrate-swashbuckle-ioperationfilter-and-ischemafilter-to-transformers-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-07-24
---

`net11.0` ですでに `AddSwaggerGen()` を `AddOpenApi()` に置き換えているなら、登録は簡単な部分です。本当に午後を食いつぶす作業は、自作のフィルターです。Swashbuckle 向けに書いたすべての `IOperationFilter` と `ISchemaFilter` は、ジェネレーターが切り替わった瞬間に呼び出されなくなります。組み込みの `Microsoft.AspNetCore.OpenApi` ジェネレーターにはフィルターという概念がないからです。あるのはトランスフォーマーです。この記事はフィルターごとの移行リファレンスです。2 つのフィルターインターフェースが `IOpenApiOperationTransformer` と `IOpenApiSchemaTransformer` にどうマッピングされるか、各コンテキストプロパティが何になるか、そして修正するまでコンパイルが通らない Microsoft.OpenApi v2 の型変更を扱います。対象は .NET 11 (`net11.0`、C# 14)、`Microsoft.AspNetCore.OpenApi` v11、`Microsoft.OpenApi` v2 で、Swashbuckle.AspNetCore v10 からの移行です。

フィルターがひとにぎりなら 1 時間もかかりません。フィルターが十数個、サンプルプロバイダー、ポリモーフィズムのフィルターがある大規模サービスなら、半日を見込んでください。各移行の機械的な形はほぼ同じなので、コストは書き直しではありません。異なる情報を公開する 2 つのコンテキストオブジェクトと、Microsoft.OpenApi v2 の型モデルの変更にあります。周辺の登録の切り替えをまだ済ませていないなら、まず [Swashbuckle から組み込みへの完全な移行ガイド](/ja/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/) で行ってください。以降はすべて、`AddOpenApi()` と `MapOpenApi()` がすでに配置されている前提です。

## そもそもなぜフィルターを移すのか

- Swashbuckle のジェネレーターを外した瞬間、フィルターはデッドコードになります。パッケージが参照されている間は型が存在し続けるのでコンパイルは通りますが、決して実行されず、ドキュメントは適用していたすべてのカスタマイズを静かに失います。
- トランスフォーマーは、アプリケーションの残りの部分がシリアライズに使うのと同じ `System.Text.Json` のメタデータを再利用するので、スキーマトランスフォーマーは API が実際に出力する型の形をそのまま見ます。リフレクションによる近似ではありません。
- トランスフォーマーは Native AOT 互換です。リフレクションに大きく依存する Swashbuckle のフィルターパイプラインは互換ではないので、AOT サービスにはフィルターという選択肢がそもそもありません。
- 1 つの拡張性モデルが、3 つのフィルターインターフェースとアノテーション属性の代わりに、ドキュメント、オペレーション、スキーマをカバーします。

## 何が壊れるか

| 領域 | Swashbuckle | .NET 11 の組み込み | 深刻度 |
| --- | --- | --- | --- |
| オペレーションのフック | `IOperationFilter.Apply(OpenApiOperation, OperationFilterContext)` | `IOpenApiOperationTransformer.TransformAsync(...)` | 高 |
| スキーマのフック | `ISchemaFilter.Apply(OpenApiSchema, SchemaFilterContext)` | `IOpenApiSchemaTransformer.TransformAsync(...)` | 高 |
| メソッドのシグネチャ | 同期の `void Apply` | `Task TransformAsync(..., CancellationToken)` | 中 |
| 登録 | `c.OperationFilter<T>(args)` / `c.SchemaFilter<T>(args)` | `options.AddOperationTransformer<T>()` / `AddSchemaTransformer<T>()` | 中 |
| スキーマの例 | `OpenApiString` / `IOpenApiAny` | `System.Text.Json.Nodes.JsonNode` | 中 |
| スキーマの型フィールド | 文字列 `schema.Type = "string"` + `Nullable` | フラグ enum の `JsonSchemaType`、`Null` フラグ | 中 |
| リフレクションのメンバー | `context.MemberInfo` (`MemberInfo`) | `context.JsonPropertyInfo` (`JsonPropertyInfo`) | 中 |
| サブスキーマの生成 | `context.SchemaGenerator.GenerateSchema(...)` | `context.GetOrCreateSchemaAsync(...)` | 低 |

## 事前チェックリスト

1. .NET 11 SDK がすべての開発マシンと CI ランナーにインストールされていることを確認します。`dotnet --list-sdks` に `11.0.x` が表示されるはずです。
2. フィルターを棚卸しします。ソリューションを `IOperationFilter`、`ISchemaFilter`、`IDocumentFilter`、`OperationFilter<`、`SchemaFilter<` で grep します。そのリストがこの移行の正確なスコープです。ここではほかに何も変わりません。
3. ベースラインのドキュメントを保存します。Swashbuckle をまだ配線したまま `/swagger/v1/swagger.json` をリクエストし、ファイルを保管します。最後に移行後のドキュメントをエンドポイントごとに突き合わせます。
4. `AddOpenApi()` と `MapOpenApi()` がすでに `/openapi/v1.json` にドキュメントを生成することを確認します。していなければ、先に登録を移行します。
5. 作業はクリーンなベースコミットを持つブランチで行い、ロールバックが `git checkout` 1 つで済むようにします。

## 2 つのコンテキストオブジェクトのマッピング

レシピの前に、各移行を機械的にするマッピングです。Swashbuckle のフィルターと組み込みのトランスフォーマーは、変更対象として同じ OpenAPI オブジェクト (`OpenApiOperation` または `OpenApiSchema`) を渡しますが、その周りのコンテキストは異なります。

`OperationFilterContext` から `OpenApiOperationTransformerContext` へ:

| Swashbuckle | 組み込み | 備考 |
| --- | --- | --- |
| `ApiDescription` | `Description` | 同じ `ApiDescription` 型で、プロパティ名が変わっただけです。ルート、メソッド、`ActionDescriptor.EndpointMetadata` はすべて引き継がれます。 |
| `MethodInfo` | `Description.ActionDescriptor` | 生の `MethodInfo` ではなくディスクリプターからメタデータを読みます。 |
| `SchemaRepository` | `Document` | 共有スキーマは `Document.AddComponent(...)` で登録します。 |
| `SchemaGenerator` | `GetOrCreateSchemaAsync(...)` | 別個のジェネレーターオブジェクトではなく、コンテキストのメソッドになりました。 |
| `DocumentName` | `DocumentName` | 変更なし。 |

`SchemaFilterContext` から `OpenApiSchemaTransformerContext` へ:

| Swashbuckle | 組み込み | 備考 |
| --- | --- | --- |
| `Type` | `JsonTypeInfo.Type` | CLR の `Type` は 1 段深く、`System.Text.Json` のメタデータの中にあります。 |
| `MemberInfo` | `JsonPropertyInfo` | プロパティスキーマのときのみ非 null です。属性は `JsonPropertyInfo.AttributeProvider` 経由で読みます。 |
| `ParameterInfo` | `ParameterDescription` | `ApiParameterDescription` です。レスポンススキーマのときは null です。 |
| `SchemaGenerator` | `GetOrCreateSchemaAsync(...)` | 上と同じ。 |
| `DocumentName` | `DocumentName` | 変更なし。 |

移行のあいだ、この 2 つの表を開いたままにしてください。各書き直しの 9 割は、コンテキストプロパティのリネームと `JsonTypeInfo` への調整です。

## 移行の手順

### 1. 各フィルターをそのトランスフォーマーインターフェースと登録にマッピングする

すべての `IOperationFilter` は `IOpenApiOperationTransformer` (またはインラインの `AddOperationTransformer` デリゲート) になり、すべての `ISchemaFilter` は `IOpenApiSchemaTransformer` になります。同期の `void Apply` は、`Task` を返し `CancellationToken` を受け取る非同期の `TransformAsync` になります。登録は `AddSwaggerGen` のコールバックから `AddOpenApi` のオプションブロックへ移ります。

```csharp
// Before -- Swashbuckle registration, ASP.NET Core 8 style
builder.Services.AddSwaggerGen(c =>
{
    c.OperationFilter<AddCorrelationHeaderFilter>();
    c.SchemaFilter<MarkMoneyFormatFilter>();
});
```

```csharp
// After -- .NET 11, C# 14
builder.Services.AddOpenApi(options =>
{
    options.AddOperationTransformer<AddCorrelationHeaderTransformer>();
    options.AddSchemaTransformer<MarkMoneyFormatTransformer>();
});
```

**確認:** 古いフィルタークラスを削除またはリネームしてもプロジェクトはビルドが通り、`AddOpenApi` は新しい登録でコンパイルできます。まだ何も正しく動きません。次の手順で本体を埋めます。

### 2. レスポンスやヘッダーを追加する IOperationFilter を移す

これは最も一般的なフィルターで、最も機械的な移行です。本体はほとんど変わりません。`operation` をその場で変更します。組み込みのモデルは事前に確保せず null のままにするので、null の `Parameters` や `Responses` コレクションに備えてください。

```csharp
// Before -- Swashbuckle IOperationFilter
public class AddCorrelationHeaderFilter : IOperationFilter
{
    public void Apply(OpenApiOperation operation, OperationFilterContext context)
    {
        operation.Parameters ??= new List<OpenApiParameter>();
        operation.Parameters.Add(new OpenApiParameter
        {
            Name = "X-Correlation-Id",
            In = ParameterLocation.Header,
            Required = false,
            Schema = new OpenApiSchema { Type = "string" }
        });
    }
}
```

```csharp
// After -- .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

internal sealed class AddCorrelationHeaderTransformer : IOpenApiOperationTransformer
{
    public Task TransformAsync(
        OpenApiOperation operation,
        OpenApiOperationTransformerContext context,
        CancellationToken cancellationToken)
    {
        operation.Parameters ??= [];
        operation.Parameters.Add(new OpenApiParameter
        {
            Name = "X-Correlation-Id",
            In = ParameterLocation.Header,
            Required = false,
            Schema = new OpenApiSchema { Type = JsonSchemaType.String }
        });
        return Task.CompletedTask;
    }
}
```

シグネチャ以外の変更は 2 つです。`Type = "string"` は `Type = JsonSchemaType.String` になり (スキーマの型は Microsoft.OpenApi v2 ではフラグ enum であり文字列ではありません)、`OpenApiParameter` などの名前空間は `Microsoft.OpenApi.Models` ではなく `Microsoft.OpenApi` です。**確認:** `/openapi/v1.json` をリクエストし、すべてのオペレーションが `X-Correlation-Id` ヘッダーパラメーターを持つことを確認します。

### 3. エンドポイントを読む IOperationFilter を移す

ルート、HTTP メソッド、メタデータに基づく条件付きフィルターこそ、`OperationFilterContext` が重要だった場面です。読み取る `ApiDescription` は同じ型で、`context.Description` として公開されます。`EndpointMetadata` を属性で調べるパターンはそのまま引き継がれます。

```csharp
// After -- .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.OpenApi;

internal sealed class ThrottleResponseTransformer : IOpenApiOperationTransformer
{
    public Task TransformAsync(
        OpenApiOperation operation,
        OpenApiOperationTransformerContext context,
        CancellationToken cancellationToken)
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
    }
}
```

古いフィルターがカスタム属性を読むために `context.MethodInfo` を使っていたなら、代わりに `context.Description.ActionDescriptor.EndpointMetadata` を優先してください。minimal API のエンドポイントはメタデータをそこで公開し、意味のある `MethodInfo` を持たないことがあるからです。**確認:** レート制限属性を持つエンドポイントと持たないエンドポイントを 1 つずつ選び、最初のものだけがドキュメントで `429` レスポンスを示すことを確認します。

### 4. 型を形づくる ISchemaFilter を移す

スキーマフィルターの本体は、ちょうど 1 か所だけ変わります。`context.Type` が `context.JsonTypeInfo.Type` になります。`schema` に対して行っていたことはすべて同じままです。

```csharp
// Before -- Swashbuckle ISchemaFilter
public class DescribeTodoFilter : ISchemaFilter
{
    public void Apply(OpenApiSchema schema, SchemaFilterContext context)
    {
        if (context.Type == typeof(Todo))
        {
            schema.Description = "A single task tracking item.";
        }
    }
}
```

```csharp
// After -- .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

internal sealed class DescribeTodoTransformer : IOpenApiSchemaTransformer
{
    public Task TransformAsync(
        OpenApiSchema schema,
        OpenApiSchemaTransformerContext context,
        CancellationToken cancellationToken)
    {
        if (context.JsonTypeInfo.Type == typeof(Todo))
        {
            schema.Description = "A single task tracking item.";
        }
        return Task.CompletedTask;
    }
}
```

**確認:** ドキュメントの `components.schemas` の下で `Todo` スキーマを見つけ、説明が存在することを確認します。

### 5. プロパティを狙う ISchemaFilter を移す

Swashbuckle は、非 null の `context.MemberInfo` を渡すことで、スキーマがプロパティスキーマであることを伝えていました。組み込みの相当物は非 null の `context.JsonPropertyInfo` です。組み込みのジェネレーターは `System.Text.Json` で駆動されるので、`JsonPropertyInfo.Name` はシリアライズされた JSON 名 (ポリシーがそうなら、すでに camelCase) であり、CLR のメンバー名ではありません。これにより大文字小文字の不一致というバグの一群がまるごと消えます。

```csharp
// After -- .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

internal sealed class EmailFormatTransformer : IOpenApiSchemaTransformer
{
    public Task TransformAsync(
        OpenApiSchema schema,
        OpenApiSchemaTransformerContext context,
        CancellationToken cancellationToken)
    {
        if (context.JsonPropertyInfo?.Name == "email")
        {
            schema.Format = "email";
        }
        return Task.CompletedTask;
    }
}
```

古いフィルターが `MemberInfo` からカスタム属性を読んでいたなら、下層の `PropertyInfo` を公開する `context.JsonPropertyInfo?.AttributeProvider?.GetCustomAttributes(...)` 経由で取得してください。**確認:** すべてのスキーマにわたって、各 `email` プロパティが `"format": "email"` を持つことを確認します。

### 6. サンプルプロバイダーを移す

スキーマの例は、最もコンパイルに失敗しやすいものです。Microsoft.OpenApi v2 は `IOpenApiAny` の階層 (`OpenApiString`、`OpenApiInteger`、`OpenApiObject`) をまるごと削除しました。例は今や `System.Text.Json.Nodes.JsonNode` です。

```csharp
// Before -- Swashbuckle, IOpenApiAny example
schema.Example = new OpenApiString("dev@example.com");
```

```csharp
// After -- .NET 11, C# 14
using System.Text.Json.Nodes;

schema.Example = JsonValue.Create("dev@example.com");
```

複合的な例には、`OpenApiObject` ではなく `JsonObject` を組み立てます。`new JsonObject { ["id"] = 1, ["title"] = "Write" }` のようにです。**確認:** 対象スキーマの `example` フィールドが、ドキュメントと UI の両方で有効な JSON としてレンダリングされることを確認します。

### 7. コンストラクター引数やサービスが必要だったフィルターを移す

Swashbuckle は、登録時にコンストラクター引数を渡すこと (`c.OperationFilter<T>(arg1, arg2)`) や、フィルターがコンテナーからアクティベートされるためサービスを解決することを許していました。組み込みのジェネリック登録 `options.AddOperationTransformer<T>()` はトランスフォーマーを依存性注入からアクティベートするので、位置引数を渡す代わりにプライマリコンストラクター経由で注入してください。

```csharp
// After -- .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

internal sealed class TosLinkTransformer(IOptions<ApiInfoOptions> options)
    : IOpenApiOperationTransformer
{
    public Task TransformAsync(
        OpenApiOperation operation,
        OpenApiOperationTransformerContext context,
        CancellationToken cancellationToken)
    {
        operation.ExternalDocs = new OpenApiExternalDocs
        {
            Url = options.Value.TermsOfServiceUrl
        };
        return Task.CompletedTask;
    }
}
```

依存性注入に参加するのはジェネリックのオーバーロードだけです。`AddOperationTransformer(new T(...))` とデリゲートのオーバーロードは参加しません。ジェネリック形式はドキュメント生成のたびに新しく解決され、その後破棄されるので、`IDisposable` なトランスフォーマーはドキュメントが構築されるたびに後片付けされます。**確認:** 注入された値がドキュメントに現れ、最初のリクエストで「no service for type」エラーなくトランスフォーマーが解決されることを確認します。

### 8. サブスキーマを生成していたフィルターを移す

最も厄介なフィルターは、オペレーションがそれ以外では参照しない型 (たとえば共有のエラー本体) のスキーマを構築するために `context.SchemaGenerator.GenerateSchema(type, context.SchemaRepository)` を呼んでいました。組み込みの置き換えは `context.GetOrCreateSchemaAsync(...)` と `context.Document.AddComponent(...)` です。

```csharp
// After -- .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

internal sealed class ErrorResponseTransformer : IOpenApiOperationTransformer
{
    public async Task TransformAsync(
        OpenApiOperation operation,
        OpenApiOperationTransformerContext context,
        CancellationToken cancellationToken)
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
    }
}
```

手作りの `OpenApiReference` ではなく、型付きの `OpenApiSchemaReference("Error", context.Document)` を使っている点に注目してください。**確認:** `Error` スキーマが `components.schemas` の下に一度だけ現れ、オペレーションはコピーをインライン化するのではなくそれを参照することを確認します。`GetOrCreateSchemaAsync` のトランスフォーマー優先のしくみは、[オペレーショントランスフォーマーとスキーマトランスフォーマーで OpenAPI をカスタマイズする](/ja/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/) で詳しく扱っています。

## 検証

古いフィルタークラスを削除する前に、これを実行してください。

- `dotnet build` がクリーンで、`Microsoft.OpenApi.Models` や `Swashbuckle.AspNetCore.SwaggerGen` のフィルターインターフェースへの参照がないこと。
- 移行後の `/openapi/v1.json` を、事前チェックで保存したベースラインと diff します。仕様バージョンと `nullable` の扱いは異なるはずです (3.1 対 3.0) が、フィルターが生成していた各レスポンス、ヘッダー、説明、例は、オペレーションごとに一致するはずです。
- スキーマフィルターが狙っていた各プロパティが、依然として同じフォーマット、例、説明を示すこと。
- `dotnet test` が通ること。ドキュメントの形をピン留めしていた契約テストも含みます。
- ドキュメントをクライアントジェネレーターに与えているなら、再生成してまだビルドできることを確認します。[OpenAPI 仕様から強く型付けされたクライアントを生成する](/ja/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/) を参照してください。

## ロールバック計画

この移行は、フィルタークラスを削除するまでは元に戻せます。各書き直しは古いフィルターの隣に新しいトランスフォーマークラスを置く形なので、最も安全なロールバックは事前チェックのクリーンな git ベースコミットです。そのコミットを `git checkout` し、`AddSwaggerGen` ブロックに `c.OperationFilter<T>()` / `c.SchemaFilter<T>()` を戻します。移行後のドキュメントが実環境で動くまでは、フィルターとトランスフォーマーの両方をツリーに残し、その後フィルターを別のコミットで削除してください。

## つまずいた落とし穴

**スキーマトランスフォーマーは同じ型に対して複数回実行されます。** スキーマトランスフォーマーはスキーマの出現ごとに発火し、同一スキーマを `components.schemas` に重複排除するパスはトランスフォーマーの後に走ります。3 か所で使われる型は、トランスフォーマーが 3 回呼ばれるので、ロジックを冪等に保ってください。追加する前に確認し、再訪する可能性のあるリストには決して追記しないことです。Swashbuckle の `ISchemaFilter` には関連する鋭い縁があった (すでに参照済みのスキーマには呼ばれなかった) ので、古い呼び出し回数がそのまま引き継がれると考えないでください。

**実行順序はスキーマ、次にオペレーション、最後にドキュメントです。** Swashbuckle のフィルターは種類ごとに登録順で走っていました。組み込みのパイプラインはまずすべてのスキーマトランスフォーマー、次にオペレーショントランスフォーマー、最後にドキュメントトランスフォーマーを走らせ、ドキュメント生成ごとに実行します。ドキュメントは最後に走るので、オペレーショントランスフォーマーはドキュメントトランスフォーマーが走ったことを当てにできません。これは、セキュリティスキームをドキュメントトランスフォーマーに置き、同じパスの中でオペレーショントランスフォーマーからそれを参照しようとした人がつまずく点です。

**`context.Type` は今や 2 段先です。** 一括の検索置換の後で最もよくあるコンパイルエラーは、スキーマトランスフォーマーに `context.Type` を残すことです。正しくは `context.JsonTypeInfo.Type` です。僅差の 2 位は `context.MemberInfo` で、これは `context.JsonPropertyInfo` です。

**ドキュメントはリクエストごとに再生成されます。** `MapOpenApi` はルートがヒットするたびにトランスフォーマーパイプライン全体を走らせるので、トランスフォーマーは軽く保ってください。トラフィックの多いドキュメントは、エンドポイントで `.CacheOutput()` を使ってキャッシュするか、ビルド時に生成します。Swashbuckle はより積極的にキャッシュしていたので、以前は問題なかった重いフィルターが今はレイテンシとして現れることがあります。

**`OpenApiSchema` はトランスフォーマー内では具象型ですが、`IOpenApiSchema` が別の場所に現れます。** トランスフォーマーのデリゲートは可変の `OpenApiSchema` を渡します。他の v2 API は `IOpenApiSchema` を返すので、以前 `OpenApiSchema` を取っていたヘルパーメソッドはインターフェースが必要になることがあります。ドキュメントトランスフォーマー経由でセキュリティスキームを配線したのにビューアーがトークンを無視するなら、それはほぼ常にクライアントのバグではなく不正なスキームです。[Scalar で Bearer トークンが無視される理由](/ja/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/) で端から端まで追っています。

腑に落ちてしまえばメンタルモデルは小さいものです。フィルターとトランスフォーマーはどちらも、変更対象として同じ OpenAPI オブジェクトを渡すので、本体はほとんど変わりません。移行とは、コンテキストプロパティをリネームし、`JsonTypeInfo` に切り替え、例を `JsonNode` に移し、今や複数回走るのでスキーマロジックを冪等に保つことです。フィルターごとに行い、ベースラインと突き合わせれば、提供するドキュメントは消費者がすでに期待しているものになります。

## 関連記事

- [.NET 11 で Swashbuckle から組み込みの OpenAPI ジェネレーターへ移行する](/ja/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/)
- [ASP.NET Core 11 でオペレーショントランスフォーマーとスキーマトランスフォーマーを使って OpenAPI をカスタマイズする](/ja/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/)
- [ASP.NET Core 11 で Swashbuckle なしで OpenAPI を公開する](/ja/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/)
- [ASP.NET Core 11 で MapGroup を使って minimal API のエンドポイントを整理する](/ja/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [Scalar in ASP.NET Core: Bearer トークンが無視される理由](/ja/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/)

## 出典

- [OpenAPI ドキュメントをカスタマイズする、ASP.NET Core ドキュメント](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/customize-openapi?view=aspnetcore-10.0)
- [OpenApiSchemaTransformerContext、.NET API リファレンス](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.openapi.openapischematransformercontext)
- [IOpenApiOperationTransformer、.NET API リファレンス](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.openapi.iopenapioperationtransformer)
- [Swashbuckle.AspNetCore、v10 への移行](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/blob/master/docs/migrating-to-v10.md)
- [Microsoft.OpenAPI v2 アップグレードガイド](https://github.com/microsoft/OpenAPI.NET/blob/main/docs/upgrade-guide-2.md)
