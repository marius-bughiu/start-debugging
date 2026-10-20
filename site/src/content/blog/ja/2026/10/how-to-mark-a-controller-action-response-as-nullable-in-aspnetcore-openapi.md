---
title: "ASP.NET Core 組み込み OpenAPI ドキュメントでコントローラーアクションのレスポンスを null 許容にする方法"
description: "Microsoft.AspNetCore.OpenApi がレスポンスを null 許容として出力するのは、アクションが素の T? を返す場合だけです(.NET 10 では Task<T?> でも出力されません)。ActionResult<T?> と IActionResult では、.NET 10 でも .NET 11 RC2 でもこの注釈が失われます。その理由、動作確認済みの operation transformer による修正方法、そして MVC のフォーマッターも変更しない限り仕様が実態と食い違う 204 No Content の落とし穴を解説します。"
pubDate: 2026-10-20
template: how-to
tags:
  - "aspnetcore"
  - "openapi"
  - "dotnet-11"
  - "dotnet-10"
  - "nullable-reference-types"
  - "how-to"
lang: "ja"
translationOf: "2026/10/how-to-mark-a-controller-action-response-as-nullable-in-aspnetcore-openapi"
translatedBy: "claude"
translationDate: 2026-10-20
---

**結論:** .NET 10(`Microsoft.AspNetCore.OpenApi` 10.0.13)と .NET 11 RC2(11.0.0-rc.2.26504.105)の組み込みジェネレーターは、アクション自身の戻り値の型が null 許容である場合だけ、レスポンスのスキーマを `oneOf: [{ "type": "null" }, ...]` で包みます。対象は `Person?` と、.NET 11 の `Task<Person?>` です。`ActionResult<Person?>` の内側は見ませんし、`[ProducesResponseType<Person>]` を付けた `IActionResult` には参照できる型情報がないため、どちらも null 許容にはなりません。アクションの `MethodInfo` を `NullabilityInfoContext` で読み取り、`Task<>` と `ActionResult<>` を取り除いたうえで 2xx のスキーマを自分で包む operation transformer を登録してください(コードは下記、両バージョンで動作確認済みです)。そのうえで、null がワイヤー上で何を意味するのかを決めてください。MVC は null の結果に対して、既定では `200` と `null` ではなく **204 No Content** を返します。

私がこの問題に遭遇したのは、コントローラー API から Kiota でクライアントを生成していたときです。アクションは `ActionResult<Person?>` と宣言されているのに、`GET /people/{id}` 用に生成されたメソッドは null 非許容の `Person` を返していました。以下はすべて、SDK 10.0.302(ランタイム 10.0.10)と SDK 11.0.100-rc.2.26504.105 上の検証用アプリで、`/openapi/v1.json` を出力し、各エンドポイントを curl で叩いて測定した結果です。

## 戻り値の形ごとにジェネレーターが出力する内容

テスト用コントローラーには、形ごとに 1 つのアクションがあり、すべて `null` を返します。`<Nullable>enable</Nullable>` を指定しています。

```csharp
// .NET 10 / .NET 11 RC2, C# 14, <Nullable>enable</Nullable>
[ApiController]
[Route("people")]
public class PeopleController : ControllerBase
{
    [HttpGet("plain")]
    public Person? GetPlain() => null;

    [HttpGet("taskplain")]
    public async Task<Person?> GetTaskPlain() { await Task.Yield(); return null; }

    [HttpGet("actionresult")]
    public ActionResult<Person?> GetActionResult() => (Person?)null;

    [HttpGet("task")]
    public async Task<ActionResult<Person?>> GetTask() { await Task.Yield(); return (Person?)null; }

    [HttpGet("attr")]
    [ProducesResponseType<Person>(StatusCodes.Status200OK)]
    public IActionResult GetAttr() => Ok(null);

    [HttpGet("arint")]
    public ActionResult<int?> GetArInt() => (int?)null;
}
```

それぞれが出力した `200` レスポンスのスキーマは次のとおりです。

| 戻り値の型 | .NET 10.0.13 | .NET 11 RC2 |
|---|---|---|
| `Person?` | null 許容 (`oneOf`) | null 許容 (`oneOf`) |
| `Task<Person?>` | **null 非許容** | null 許容 |
| `ActionResult<Person?>` | **null 非許容** | **null 非許容** |
| `Task<ActionResult<Person?>>` | **null 非許容** | **null 非許容** |
| `IActionResult` + `[ProducesResponseType<Person>]` | **null 非許容** | **null 非許容** |
| `ActionResult<int?>` | `type: ["null", "integer", "string"]`、`oneOf` なし | null 許容 (`oneOf`) |
| Minimal API `Person? () => null` | null 許容 (`oneOf`) | null 許容 (`oneOf`) |

ここでの "null 許容" は、スキーマが次の形で出力されたことを指します。

```json
"schema": {
  "oneOf": [
    { "type": "null" },
    { "$ref": "#/components/schemas/Person" }
  ]
}
```

"null 非許容" は、素の `{ "$ref": "#/components/schemas/Person" }` のままであることを指します。`Person` コンポーネント自体が null 許容になることはありません。これは意図的な仕様です。.NET 10 RC1 以降([dotnet/aspnetcore#63301](https://github.com/dotnet/aspnetcore/pull/63301))、ジェネレーターは型ごとに共有コンポーネントを 1 つだけ保持し、null 許容かどうかは使用箇所のインライン `oneOf` ラッパーで表現します。そのため、あるエンドポイントでは null 許容、別のエンドポイントでは null 非許容という型でも、コンポーネントが 2 つに分かれることはありません。

## ActionResult<T?> で注釈が失われる理由

判定は内部メソッド 1 つ、`src/OpenApi/src/Extensions/TypeExtensions.cs` の `TypeExtensions.ShouldApplyNullableResponseSchema` にあります。`v10.0.0` タグでは次の処理をしています。

1. `ControllerActionDescriptor` からアクションの `MethodInfo` を取得します。
2. `MethodInfo.ReturnType` から `Task<T>` または `ValueTask<T>` を取り除きます。
3. その型が `ApiResponseType.Type`(ApiExplorer がレスポンス用に報告する型)と *等しく* なければ `false` を返します。
4. 等しければ `NullabilityInfoContext.Create(methodInfo.ReturnParameter)` を実行し、`WriteState == Nullable` を確認します。

`ActionResult<Person?>` が脱落するのは手順 3 です。ApiExplorer はレスポンスの型を `Person` と報告しますが、メソッドが返すのは `ActionResult<Person>` で、2 つの型は等しくないため、そこで終わりです。null 許容性のチェックには到達しません。属性を付けた `IActionResult` も同様で、戻り値の型は `IActionResult`、レスポンスの型は `Person` です。

.NET 10 で `Task<Person?>` が見落とされるのは手順 4 が原因です。取り除いた後の型は一致しますが、null 許容性のチェックは *元の* 戻り値パラメーター、つまり `Task<Person?>` に対して実行されます。`Task` 自体は null 許容ではないため、`WriteState` は `NotNull` になります。

2026 年 7 月にマージされ .NET 11 に入った [dotnet/aspnetcore#67661](https://github.com/dotnet/aspnetcore/pull/67661) は、このメソッドを書き直しました。現在は `ModelMetadata.IsNullableValueType` で先に判定を打ち切り(これで `ActionResult<int?>` が直ります)、参照型については `Task<>`/`ValueTask<>` を通して `NullabilityInfo.GenericTypeArguments[0]` をたどります(これで `Task<Person?>` が直ります)。ただし `ActionResult<>` は取り除かないため、参照型では `NullabilityInfo` が `ActionResult<Person?>` で止まり、それは null 許容ではないので、結果は依然として `false` です。PR の説明にも、参照型の扱いは "is still not handled very well in this PR" と書かれています。RC2 のタグと `main` のコードは RC1 と同じなので、GA までにこれが変わることは期待しないでください。

## 修正方法: ActionResult<T> を取り除く operation transformer

組み込みのパイプラインでは、operation transformer の中で完全な `ApiDescription` を取得でき、これだけで判定を正しくやり直せます。この transformer は 2 つのケースを扱います。戻り値の型から推論できる null 許容性と、推論の手がかりがない `IActionResult` アクション向けの明示的な `[NullableResponse(statusCode)]` 属性です。

```csharp
// .NET 10 and .NET 11 (Microsoft.AspNetCore.OpenApi 10.0.x / 11.0.0-rc.2)
using System.Reflection;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

[AttributeUsage(AttributeTargets.Method, AllowMultiple = true)]
public sealed class NullableResponseAttribute(int statusCode) : Attribute
{
    public int StatusCode { get; } = statusCode;
}

public sealed class NullableResponseTransformer : IOpenApiOperationTransformer
{
    public Task TransformAsync(
        OpenApiOperation operation,
        OpenApiOperationTransformerContext context,
        CancellationToken cancellationToken)
    {
        if (context.Description.ActionDescriptor is not ControllerActionDescriptor action
            || operation.Responses is null)
        {
            return Task.CompletedTask;
        }

        // 1. Explicit opt-in: [NullableResponse(200)]
        var statusCodes = action.MethodInfo
            .GetCustomAttributes<NullableResponseAttribute>()
            .Select(a => a.StatusCode)
            .ToHashSet();

        // 2. Inferred from the return type: T?, ActionResult<T?>, and their Task/ValueTask forms
        if (TryGetNullableResponseType(action.MethodInfo, out var valueType))
        {
            foreach (var responseType in context.Description.SupportedResponseTypes)
            {
                if (responseType.Type == valueType && responseType.StatusCode is >= 200 and < 300)
                {
                    statusCodes.Add(responseType.StatusCode);
                }
            }
        }

        foreach (var statusCode in statusCodes)
        {
            if (!operation.Responses.TryGetValue(statusCode.ToString(), out var response)
                || response.Content is null)
            {
                continue;
            }

            foreach (var mediaType in response.Content.Values)
            {
                // Microsoft.OpenApi 3.x (.NET 11) exposes IOpenApiMediaType with a read-only Schema.
                if (mediaType is OpenApiMediaType { Schema: { } schema } concrete && !IsNullWrapper(schema))
                {
                    concrete.Schema = new OpenApiSchema
                    {
                        OneOf = [new OpenApiSchema { Type = JsonSchemaType.Null }, schema]
                    };
                }
            }
        }

        return Task.CompletedTask;
    }

    private static bool TryGetNullableResponseType(MethodInfo method, out Type? valueType)
    {
        var type = method.ReturnType;
        var nullability = new NullabilityInfoContext().Create(method.ReturnParameter);

        if (type.IsGenericType
            && (type.GetGenericTypeDefinition() == typeof(Task<>)
                || type.GetGenericTypeDefinition() == typeof(ValueTask<>)))
        {
            type = type.GetGenericArguments()[0];
            nullability = nullability.GenericTypeArguments[0];
        }

        if (type.IsGenericType && type.GetGenericTypeDefinition() == typeof(ActionResult<>))
        {
            type = type.GetGenericArguments()[0];
            nullability = nullability.GenericTypeArguments[0];
        }

        valueType = type;
        return nullability.WriteState == NullabilityState.Nullable;
    }

    private static bool IsNullWrapper(IOpenApiSchema schema) =>
        schema.OneOf?.Any(s => s.Type == JsonSchemaType.Null) == true;
}
```

公開する各ドキュメントに登録します。

```csharp
// .NET 10 / .NET 11 RC2
builder.Services.AddControllers();
builder.Services.AddOpenApi(o => o.AddOperationTransformer<NullableResponseTransformer>());
```

戻り値の型から何も読み取れない場合は、属性を使います。

```csharp
// .NET 10 / .NET 11 RC2
[HttpGet("attr")]
[ProducesResponseType<Person>(StatusCodes.Status200OK)]
[NullableResponse(StatusCodes.Status200OK)]
public IActionResult GetAttr() => Ok(null);
```

transformer を登録すると、上の表のすべての行が両バージョンで `oneOf` ラッパーとして出力されました。.NET 10 の `Task<Person?>` も含みます。null 非許容の `ActionResult<Person>` は素の `$ref` のままでした。

設計上の選択をいくつか補足します。

- **コンポーネントではなく使用箇所を包みます。** これは #63301 以降のフレームワーク自身の動作と同じです。代わりにスキーマ transformer で `Person` コンポーネントに `Type |= JsonSchemaType.Null` を設定すると、`Person` を返すすべてのエンドポイントが null 許容になり、null を返さないものまで含まれてしまいます。
- **宣言された `T` と型が一致する 2xx レスポンスだけを対象にします。** 同じアクションの `ProblemDetails` を伴う `404` には触れません。
- **冪等です。** フレームワークがすでにスキーマを包んでいる場合(素の `Person?` や、.NET 11 の `Task<Person?>`)は `IsNullWrapper` がスキップするので、`oneOf` の中に `oneOf` ができることはありません。フレームワークが `ActionResult<T?>` に対応した時点で、transformer は何もしなくなります。
- **`is OpenApiMediaType` パターンは .NET 11 のためにあります。** `Microsoft.AspNetCore.OpenApi` 10.0.13 は `Microsoft.OpenApi` 2.x を取り込み、そこでは `Content` の値が具象クラスの `OpenApiMediaType` です。11.0 RC2 のパッケージは `Microsoft.OpenApi` 3.10.2 を取り込み、そこでは `Content` が `IDictionary<string, IOpenApiMediaType>` で、`IOpenApiMediaType.Schema` に setter がありません。インターフェース経由で代入すると `CS0200: Property or indexer 'IOpenApiMediaType.Schema' cannot be assigned to -- it is read only` で失敗します。パターンマッチなら両方でコンパイルできます。

transformer の一般的な仕組み(実行順序、DI による有効化、コンテキストオブジェクト)については、[transformer の詳細解説](/ja/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/)を参照してください。

## 落とし穴: コントローラーの null の結果は 200 ではなく 204 になる

同じエンドポイントが実際にワイヤー上で返した内容は次のとおりです。.NET 10 と .NET 11 RC2 で同一でした。

```text
GET /people/actionresult   -> HTTP/1.1 204 No Content   (no body)
GET /people/plain          -> HTTP/1.1 204 No Content
GET /people/taskplain      -> HTTP/1.1 204 No Content
GET /minimal/maybe         -> HTTP/1.1 200 OK, application/json, body: null
```

MVC は既定で `HttpNoContentOutputFormatter` を登録しており、その `TreatNullValueAsNoContent` プロパティの既定値は `true` です。そのため、`null` のオブジェクト結果はすべて本文が空の `204` になります。Minimal API にはこのフォーマッターがないので、実際に `200` と JSON リテラルの `null` を送信します。

つまりコントローラーでは、素の `Person?` に対してフレームワーク自身が付ける `oneOf` ラッパーでさえ、サーバーが送らないレスポンスを記述していることになります。その仕様から生成されたクライアントは `200` と `null` を期待しますが、実際には `204` を受け取ります。そこで、次の 2 つのうちどちらか、嘘のない契約を選んでください。

### オプション A: 204 のままにして仕様に記載する

MVC には手を加えず、`200` のスキーマは null 非許容のままにして、`204` を宣言します。

```csharp
// .NET 10 / .NET 11 RC2: null result -> 204 No Content
[HttpGet("{id:int}")]
[ProducesResponseType(StatusCodes.Status200OK)]
[ProducesResponseType(StatusCodes.Status204NoContent)]
public async Task<ActionResult<Person?>> Get(int id) => await _people.FindAsync(id);
```

この構成では `200` に null 許容ラッパーを付けたくないので、transformer は登録しないでください。また、素の `Person?` を返す場合は、フレームワークが依然としてラッパーを付ける点にも注意が必要です。ほとんどのクライアントジェネレーターは本文のない `204` を "結果なし" として扱い、それは呼び出し側にとってもたいてい望ましい動作です。

### オプション B: null を 200 で送り、200 を null 許容にする

no-content への変換を無効にしたうえで、transformer にそれを記述させます。

```csharp
// .NET 10 / .NET 11 RC2: null result -> 200 OK with body "null"
using Microsoft.AspNetCore.Mvc.Formatters;

builder.Services.AddControllers(o =>
{
    var noContent = o.OutputFormatters.OfType<HttpNoContentOutputFormatter>().Single();
    noContent.TreatNullValueAsNoContent = false;
});
builder.Services.AddOpenApi(o => o.AddOperationTransformer<NullableResponseTransformer>());
```

この変更の後、`GET /people/actionresult` は `HTTP/1.1 200 OK`、`Content-Type: application/json; charset=utf-8`、本文 `null` を返し、これは `oneOf` スキーマの記述とぴったり一致します。`void` のアクションは影響を受けませんでした(変更の前後どちらも、空の本文で `200` を返しました)。Microsoft Learn のフォーマットのページには別の方法として `o.OutputFormatters.RemoveType<HttpNoContentOutputFormatter>()` が載っていますが、私はプロパティを切り替える方を好みます。意図が明確になり、フォーマッターの他のケースにも影響しないからです。

API の利用側がすでに `200`/`null` を前提にしている場合や、コントローラーと Minimal API の間でエンドポイントを移行していて同じ挙動にしたい場合は、オプション B を使ってください。それ以外はオプション A を使ってください。こちらがフレームワークの既定で、transformer も不要です。

## 注意点とエッジケース

**`[ProducesResponseType]` を 1 つでも付けると、推論された 200 が消えます。** 最初のテストでは、`ActionResult<Person?>` のアクションに `[ProducesResponseType(StatusCodes.Status404NotFound)]` だけを付けたところ、`200` のレスポンスがドキュメントから完全に消え、transformer が包む対象がなくなりました。アクションに明示的なレスポンスメタデータがあると、ApiExplorer は `ActionResult<T>` に対する既定の `200` を追加しなくなります。エラーコードと並べて `[ProducesResponseType(StatusCodes.Status200OK)]` を追加してください(型は不要で、`T` は自動で補われます)。

**`string?` は JSON ではありません。** null を返す `string?` のアクションは、`TreatNullValueAsNoContent` を無効にすると、`Content-Type: text/plain` で本文が空の `200` を返しました。文字列には `StringOutputFormatter` が優先して使われるためです。それでもドキュメントは null 許容の文字列を `application/json` として記載します。コントローラーから文字列を返す場合は、`[Produces("application/json")]` を追加するか、小さな DTO を返してください。

**OpenAPI 3.0 の出力は見た目が違っても意味は同じです。** `o.OpenApiVersion = OpenApiSpecVersion.OpenApi3_0` を指定すると、`Microsoft.OpenApi` は null の枝を `oneOf` の中で `{ "enum": [null], "nullable": true }` としてシリアライズします。これは 3.0 として有効で、ジェネレーターも理解できます。既定値は .NET 10 では `3.1.1`、.NET 11 では `3.2.0` です。Swagger UI が 3.2 のドキュメントを拒否する場合は、[.NET 11 での Swagger UI の修正](/ja/2026/08/fix-swagger-ui-unable-to-render-this-definition-after-upgrading-to-dotnet-11/)を参照してください。

**null 許容コンテキストが重要です。** `NullabilityInfoContext` はコンパイラーの `[Nullable]` メタデータを読み取ります。null 許容参照型が無効なファイルやプロジェクトでは、`Person?` は警告になり、`Person` は `Nullable` ではなく `Unknown` と報告されるため、フレームワークも transformer も何も印を付けません。これは正しい結果です。null 許容性を意識していないコードは、どちらの約束もしていないからです。

**Typed results は別のコードパスです。** `Results<Ok<Person>, NotFound>` を返す Minimal API やコントローラーは、メソッドの戻り値の型ではなく `IEndpointMetadataProvider` を通じてレスポンスを記述します。`Results<Ok<Person?>, NotFound>` を返す Minimal API と、`Ok<Person?>` を返すコントローラーアクションの両方を確認しましたが、.NET 10 と .NET 11 RC2 のどちらでも `200` のスキーマは素の `Person` 参照でした。上記の transformer も `Ok<T>` からは何も推論しないため、そうしたコントローラーアクションには `[NullableResponse(200)]` を付けてください(Minimal API には `ControllerActionDescriptor` がないので、代わりに `AddOperationTransformer` でルートを確認する方法を使います)。どの形にするか迷っている場合は、[typed results と IResult と IActionResult の比較](/ja/2026/07/typed-results-vs-iresult-vs-iactionresult-in-aspnetcore-11/)に、それぞれが ApiExplorer に何を伝えるかがまとまっています。

**スキーマ transformer で "直そう" としないでください。** `Person` をグローバルに null 許容にして、すべての `$ref` が null を受け入れるようにしたくなるかもしれません。しかしそうするとエンドポイント間の区別が失われ、OpenAPI 3.1 以降では、フレームワークが他の箇所で付ける `oneOf` ラッパーの 2 つの枝がどちらも `null` に一致してしまい、`oneOf`(ちょうど 1 つに一致することを要求します)の検証が失敗します。PR #67661 は、内側のスキーマを null 非許容のままにしておく理由として、まさにこの点を挙げています。

## 関連記事

- [How to customize the OpenAPI document with AddOperationTransformer and AddSchemaTransformer in ASP.NET Core 11](/ja/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/)
- [Typed results (Results<>) vs IResult vs IActionResult in ASP.NET Core 11](/ja/2026/07/typed-results-vs-iresult-vs-iactionresult-in-aspnetcore-11/)
- [Migrate from Swashbuckle to the built-in OpenAPI generator in .NET 11](/ja/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/)
- [How to generate strongly typed client code from an OpenAPI spec in .NET 11](/ja/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/)
- [Fix: Swagger UI shows Unable to render this definition after upgrading to .NET 11](/ja/2026/08/fix-swagger-ui-unable-to-render-this-definition-after-upgrading-to-dotnet-11/)

## 参考資料

- [TypeExtensions.cs (`ShouldApplyNullableResponseSchema`), dotnet/aspnetcore](https://github.com/dotnet/aspnetcore/blob/main/src/OpenApi/src/Extensions/TypeExtensions.cs)
- [Fix nullability handling in OpenApi, dotnet/aspnetcore#67661](https://github.com/dotnet/aspnetcore/pull/67661)
- [Model nullable types using oneOf in OpenAPI schema, dotnet/aspnetcore#63301](https://github.com/dotnet/aspnetcore/pull/63301)
- [Model nullable types using allOf in JSON schema (tracking issue), dotnet/aspnetcore#63029](https://github.com/dotnet/aspnetcore/issues/63029)
- [Customize OpenAPI documents, Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/customize-openapi)
- [Format response data in ASP.NET Core Web API (special-case formatters), Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/web-api/advanced/formatting)
- [HttpNoContentOutputFormatter.TreatNullValueAsNoContent, .NET API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.mvc.formatters.httpnocontentoutputformatter.treatnullvalueasnocontent)
- [NullabilityInfoContext, .NET API reference](https://learn.microsoft.com/en-us/dotnet/api/system.reflection.nullabilityinfocontext)
