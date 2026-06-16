---
title: "Swashbuckle から .NET 11 の組み込み OpenAPI ジェネレーターへ移行する"
description: ".NET 11 で Swashbuckle.AspNetCore から Microsoft.AspNetCore.OpenApi へのステップバイステップの移行: AddSwaggerGen を AddOpenApi に置き換え、操作・スキーマ・ドキュメントのフィルターをトランスフォーマーに変換し、UI を残し、噛みついてくる Microsoft.OpenApi v2 の破壊的変更を扱います。"
pubDate: 2026-06-16
updatedDate: 2026-06-16
template: migration
tags:
  - "migration"
  - "swashbuckle"
  - "openapi"
  - "aspnetcore-11"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-06-16
---

ASP.NET Core プロジェクトがまだ `builder.Services.AddSwaggerGen()` と `app.UseSwagger()` を呼び出しているなら、それは Swashbuckle.AspNetCore を使っています。これは .NET の OpenAPI のあり方を 10 年近く支えてきたパッケージです。.NET 9 以降、Web API のテンプレートはこれを含まなくなりました。新規プロジェクトは代わりに Microsoft 自身のパッケージ `Microsoft.AspNetCore.OpenApi` を使います。本記事では、既存の Swashbuckle のコードベースを `net11.0`、C# 14 で組み込みジェネレーターへ移行します。新規プロジェクト向けのガイドが飛ばす部分、つまり何を削除するか、各 `IOperationFilter`、`ISchemaFilter`、`IDocumentFilter` がどのトランスフォーマーに対応するか、クリックできる UI をどう残すか、そして修正するまでコンパイルが通らない Microsoft.OpenApi v2 の破壊的変更を扱います。

フィルターが数個の小さな API なら、これは午後ひとつ分です。独自フィルターが十数個、サンプルプロバイダー、複数の `SwaggerDoc` バージョンを持つ大きなサービスなら、1 日を見ておいてください。Swashbuckle は非推奨ではないので、これは強制ではなく選択です。やる理由は、組み込みジェネレーターがボックスに同梱され、ランタイムにリリースごとに追従し、Native AOT をサポートし、デフォルトで OpenAPI 3.1 を出力するからです。待つ理由は、Swashbuckle の UI 機能や、まだトランスフォーマーの代替がないコミュニティ製フィルターに依存している場合です。それは始める前に判断してください。途中ではなく。

## なぜ今移行するか

- ジェネレーターはフレームワークに付属します。.NET のリリースに遅れる、ビルドに固定されたサードパーティパッケージはありません。これはまさに、Microsoft がこれを引き取るきっかけとなった .NET 6 時代の痛みです。
- アプリの他の部分がすでに使っている `System.Text.Json` のスキーマサポートを再利用するため、ドキュメントのスキーマは API が実際にシリアライズするものと一致します。
- Native AOT に対応しています。リフレクションを多用する Swashbuckle の生成は対応していないため、AOT の minimal API サービスはいずれにせよ Swashbuckle を手放す必要がありました。
- OpenAPI 3.1 と JSON Schema draft 2020-12 がデフォルトであり、オプトインではありません。

## 何が壊れるか

| 領域 | 変更 | 深刻度 |
| --- | --- | --- |
| `AddSwaggerGen` / `UseSwagger` | `AddOpenApi` / `MapOpenApi` に置き換え。ルートが異なる (`/swagger/v1/swagger.json` ではなく `/openapi/v1.json`) | 高 |
| `IOperationFilter` / `ISchemaFilter` / `IDocumentFilter` | もう呼び出されない。`AddOperationTransformer` / `AddSchemaTransformer` / `AddDocumentTransformer` として書き直す | 高 |
| 同梱の Swagger UI | フレームワークは JSON のみ生成。UI (Scalar または独立した Swagger UI パッケージ) は自分で追加する | 高 |
| `Microsoft.OpenApi` の名前空間 | v2 で型が `Microsoft.OpenApi.Models` から `Microsoft.OpenApi` へ移動。`OpenApiSchema` は `IOpenApiSchema` になる | 中 |
| スキーマの例 | `OpenApiString`/`IOpenApiAny` がなくなる。例は `System.Text.Json.Nodes.JsonNode` になる | 中 |
| デフォルトの spec バージョン | Swashbuckle はデフォルトで OpenAPI 3.0。組み込みジェネレーターは 3.1 | 中 |
| `SwaggerDoc("v1", ...)` | `AddOpenApi("v1")` と `Info` 用のドキュメントトランスフォーマーに置き換え | 低 |
| `[SwaggerOperation]` / `EnableAnnotations` | minimal API のメタデータ (`WithSummary`、`WithDescription`、`WithTags`) に置き換え | 低 |

## 事前チェックリスト

1. すべての開発マシンと CI ランナーに .NET 11 SDK をインストールします。`dotnet --list-sdks` で確認し、`11.0.x` が表示されることを確かめます。
2. Swashbuckle の使用箇所を棚卸しします。ソリューションを `AddSwaggerGen`、`OperationFilter<`、`SchemaFilter<`、`DocumentFilter<`、`SwaggerDoc`、`EnableAnnotations`、`[SwaggerOperation` で grep します。フィルターの一覧こそが移行の実際の範囲です。
3. 基準となるドキュメントを取得します。アプリを実行し、`/swagger/v1/swagger.json` をファイルに保存します。最後に新しいドキュメントとこれを比較します。
4. OpenAPI 3.0 に縛られているコンシューマーがあれば書き留めます。3.1 で詰まるクライアントジェネレーターが最も多い驚きで、後述のとおり 1 行で対処します。
5. ロールバックが 1 コマンドになるよう、クリーンなベースをコミットします。

## 移行手順

### 1. パッケージを入れ替える

ジェネレーターのパッケージを削除し、フレームワークのものを追加します。Swagger UI の見た目を残したい場合は、ジェネレーターとは別の、その UI アセットパッケージだけを残します。

```dotnetcli
# .NET 11
dotnet remove package Swashbuckle.AspNetCore
dotnet add package Microsoft.AspNetCore.OpenApi
```

`Swashbuckle.AspNetCore.Filters` (コミュニティ製のサンプル/auth フィルターパック) を使っていた場合は、それも削除します。その機能はトランスフォーマーになります。**確認:** `dotnet build` が成功するか、これから置き換える、今や存在しない `AddSwaggerGen`/フィルターのシンボルだけで失敗します。ここでクリーンにコンパイルが通るなら、実は Swashbuckle を一度も使っていなかったということです。

### 2. 2 つの登録呼び出しを置き換える

これが中心となる入れ替えです。Swashbuckle はジェネレーターと 2 つのミドルウェアを登録していました。組み込み版はサービスを登録し、エンドポイントをマップします。

```csharp
// Before -- Swashbuckle, ASP.NET Core 8 style
builder.Services.AddSwaggerGen(c =>
{
    c.SwaggerDoc("v1", new OpenApiInfo { Title = "Todo API", Version = "v1" });
});

var app = builder.Build();

app.UseSwagger();
app.UseSwaggerUI();
```

```csharp
// After -- .NET 11, C# 14
builder.Services.AddOpenApi();

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}
```

ドキュメントは `/swagger/v1/swagger.json` から `/openapi/v1.json` に移ります。デフォルトのドキュメント名は `v1` で、そこからルート名が来ています。`IsDevelopment()` のフィルターに注目してください。OpenAPI ドキュメントは攻撃対象領域の完全なマップなので、デフォルトでは公開インターネットに提供しないでください。**確認:** アプリを実行し、`/openapi/v1.json` をリクエストします。すべてのエンドポイントを列挙した 3.1 のドキュメントが得られるはずです。`Info` ブロックは今のところ汎用的です。手順 4 で直します。

### 3. UI を取り戻す

Swashbuckle は Swagger UI を同梱していたので、`/swagger` はそのまま動きました。組み込みジェネレーターは JSON のみを生成します。ビューアーを 1 つ選び、ドキュメントに向けます。.NET 9 以降のテンプレートのデフォルトは Scalar です。

```csharp
// .NET 11, C# 14
using Scalar.AspNetCore;

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.MapScalarApiReference();
}
```

チームが Swagger UI に愛着があるなら、それも引き続き動きます。`Swashbuckle.AspNetCore.SwaggerUi` (ジェネレーターではなく UI アセットのみ) をインストールし、新しいルートに向けます。

```csharp
// .NET 11, C# 14
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.UseSwaggerUI(options =>
    {
        options.SwaggerEndpoint("/openapi/v1.json", "v1");
    });
}
```

**確認:** `/scalar` (または `/swagger`) を開き、操作がレンダリングされ "Try it out" が API に到達することを確かめます。各ビューアーの新規プロジェクト向けの詳細は [ASP.NET Core 11 で Swashbuckle なしに OpenAPI を公開する](/ja/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/) にあります。

### 4. ドキュメントのメタデータをトランスフォーマーへ移す

`SwaggerDoc("v1", new OpenApiInfo { ... })` はタイトル、バージョン、説明を設定していました。組み込みモデルではこれはドキュメントトランスフォーマーで、シリアライズ前の `OpenApiDocument` 全体を処理します。

```csharp
// .NET 11, C# 14
using Microsoft.OpenApi;

builder.Services.AddOpenApi(options =>
{
    options.AddDocumentTransformer((document, context, cancellationToken) =>
    {
        document.Info = new OpenApiInfo
        {
            Title = "Todo API",
            Version = "v1",
            Description = "Task tracking endpoints."
        };
        return Task.CompletedTask;
    });
});
```

`using` に注意してください。Microsoft.OpenApi v2 (Swashbuckle v10 も `Microsoft.AspNetCore.OpenApi` も今やこれに依存します) では、モデルの型が `Microsoft.OpenApi.Models` から `Microsoft.OpenApi` へ移動しました。古い `OpenApiInfo` のコードをそのままコピーすると解決されません。**確認:** ドキュメントを再読み込みし、`info` ブロックにタイトルと説明が表示されることを確かめます。

### 5. 操作フィルターを操作トランスフォーマーへ変換する

`IOperationFilter` は、レスポンス、ヘッダー、説明を追加するために操作ごとに 1 回実行されていました。トランスフォーマーのシグネチャは異なりますが、本体はほぼ同じです。

```csharp
// Before -- Swashbuckle IOperationFilter
public class AddThrottleResponseFilter : IOperationFilter
{
    public void Apply(OpenApiOperation operation, OperationFilterContext context)
    {
        operation.Responses.TryAdd("429",
            new OpenApiResponse { Description = "Too Many Requests" });
    }
}
// registered: c.OperationFilter<AddThrottleResponseFilter>();
```

```csharp
// After -- .NET 11, C# 14
builder.Services.AddOpenApi(options =>
{
    options.AddOperationTransformer((operation, context, cancellationToken) =>
    {
        operation.Responses ??= new OpenApiResponses();
        operation.Responses["429"] = new OpenApiResponse
        {
            Description = "Too Many Requests"
        };
        return Task.CompletedTask;
    });
});
```

`OperationFilterContext` には `ApiDescription` がありました。トランスフォーマーの `context` も同じ `ApiDescription` を公開するので、ルート、HTTP メソッド、メタデータに基づく条件ロジックはそのまま引き継げます。**確認:** フィルターが対象としていたエンドポイントを 1 つ見つけ、`429` レスポンス (または追加したもの) がドキュメント上でそれに付いていることを確かめます。

### 6. スキーマフィルターとドキュメントフィルターを変換する

`ISchemaFilter` は `AddSchemaTransformer` になります。コンテキストは `Type` ではなく `JsonTypeInfo` を渡すようになったので、`context.JsonTypeInfo.Type` を読みます。

```csharp
// After -- .NET 11, C# 14
options.AddSchemaTransformer((schema, context, cancellationToken) =>
{
    if (context.JsonTypeInfo.Type == typeof(Todo))
    {
        schema.Description = "A single task tracking item.";
    }
    return Task.CompletedTask;
});
```

`IDocumentFilter` は `AddDocumentTransformer` になり、これは手順 4 で `Info` に使ったのと同じフックです。`servers`、トップレベルのタグ、セキュリティスキームに使います。よくあるのは、UI に Authorize ボタンを表示させるために Bearer スキームを宣言することです。インラインで行うこともできますし、サービスを注入する必要がある場合は強く型付けされた `IOpenApiDocumentTransformer` で行えます。**確認:** スキーマの説明 (またはセキュリティスキーム) が、古いフィルターが置いていた場所に表示されることを確かめます。さらに Authorize ボタンをセキュリティスキームに紐づけているのにビューアーがトークンを黙って無視する場合、ほぼ常にスキームの不備が原因で、[Scalar で Bearer トークンが無視される理由](/ja/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/) で詳しく掘り下げました。

### 7. アノテーションを minimal API のメタデータに置き換える

`EnableAnnotations()` と `[SwaggerOperation(Summary = "...", Description = "...")]` を使っていた場合、属性を外し、同じメタデータをエンドポイントの規約で表現します。それらは操作にそのまま流れ込みます。

```csharp
// .NET 11, C# 14
app.MapGet("/todos/{id}", (int id) => Results.Ok(new Todo(id, "Write", false)))
   .WithSummary("Get a todo by id")
   .WithDescription("Returns a single todo item, or 404 if it does not exist.")
   .WithTags("Todos")
   .Produces<Todo>(StatusCodes.Status200OK)
   .Produces(StatusCodes.Status404NotFound);
```

コントローラーでは、すでに持っている XML ドキュメントコメントと `[ProducesResponseType]` 属性が API エクスプローラーによって読み取られるので、その多くは自動的に得られます。エンドポイントを [MapGroup](/ja/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) でグループ化しておくと、グループに付けた 1 つの `WithTags` がその中のすべての操作にタグを付けられます。**確認:** サマリーとタグが UI にレンダリングされ、`EnableAnnotations` がプロジェクトのどこにも現れないことを確かめます。

### 8. 複数ドキュメントとバージョニングを扱う

Swashbuckle の繰り返しの `SwaggerDoc("v1", ...)` / `SwaggerDoc("v2", ...)` は、それぞれ独自の名前とオプションを持つ `AddOpenApi` の繰り返し呼び出しになります。どのエンドポイントがどのドキュメントに入るかは `ShouldInclude` が決めます。

```csharp
// .NET 11, C# 14
builder.Services.AddOpenApi("public", options =>
{
    options.ShouldInclude = description =>
        description.GroupName is null || description.GroupName == "public";
});
builder.Services.AddOpenApi("internal");
```

各名前は独自のルートを得ます。`/openapi/public.json` と `/openapi/internal.json` です。`Asp.Versioning` を使っている場合、それはこのドキュメントモデルと戦うのではなく統合されます。**確認:** 各ドキュメントのルートをリクエストし、それぞれに正しいエンドポイントが現れることを確かめます。

## 検証

古いコードパスを削除する前に、このチェックリストを実行してください。

- `dotnet build` が警告ゼロでクリーンであること。残存する `Microsoft.OpenApi.Models` への参照も含みます。
- `dotnet test` が通ること。特に古い `/swagger/v1/swagger.json` のパスを固定していた契約テストがあれば、それを `/openapi/v1.json` に更新します。
- 新しい `/openapi/v1.json` を、事前チェックで保存した基準と比較します。バージョン行が `3.0.x` から `3.1.x` に変わり、スキーマの `nullable` の扱いが異なることは想定内です。それ以外は操作ごとに一致しているはずです。
- 古いフィルターが触れていた各エンドポイントが、依然として同じレスポンス、ヘッダー、説明を持つこと。
- UI が読み込まれ、"Try it out" が実際のエンドポイントに到達すること。
- spec からクライアントを生成している場合は、再生成し、依然としてコンパイルが通ることを確かめます。[OpenAPI の spec から強く型付けされたクライアントを生成する](/ja/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/) を参照してください。

## ロールバック計画

この移行は、フィルタークラスを削除し始めるまでは可逆です。ロールバックするには、`dotnet remove package Microsoft.AspNetCore.OpenApi`、`Swashbuckle.AspNetCore` を再度追加し、`AddSwaggerGen` / `UseSwagger` / `UseSwaggerUI` を復元します。フィルターからトランスフォーマーへの書き直しはその場での編集なので、事前チェックのクリーンなコミットが本当のロールバックです。そのコミットを `git checkout` すれば、1 ステップで Swashbuckle に戻れます。移行はブランチで行い、新しいドキュメントが実際の環境で動くまで基準コミットを保持してください。

## ハマったポイント

**OpenAPI 3.1 のデフォルトが、3.0 しか理解しないツールを壊します。** これは移行後に最も多いチケットです。下流のジェネレーターがドキュメントを拒否する場合、移行全体を巻き戻すのではなく、バージョンを明示的に下げてください。

```csharp
// .NET 11, C# 14
using Microsoft.OpenApi;

builder.Services.AddOpenApi(options =>
{
    options.OpenApiVersion = OpenApiSpecVersion.OpenApi3_0;
});
```

**スキーマの例は `OpenApiString` ではなく `JsonNode` になりました。** Microsoft.OpenApi v2 は `IOpenApiAny` の階層を廃止しました。スキーマフィルターが `schema.Example = new OpenApiString("...")` を設定していた場合、トランスフォーマーの相当物は `System.Text.Json.Nodes.JsonNode`、たとえば `JsonValue.Create("...")` や `JsonObject` を代入します。これは書き直し中に最もコンパイルが通らなくなりやすい変更です。

**ドキュメントはリクエストごとに再生成されます。** `MapOpenApi` はエンドポイントがヒットするたびに完全なパイプラインを実行します。これは意図的で、トランスフォーマーがライブの状態に反応できるようにするためです。アクセスの多いドキュメントでは、エンドポイントで `.CacheOutput()` を使ってキャッシュするか、`Microsoft.Extensions.ApiDescription.Server` でビルド時に生成して静的ファイルを提供します。ビルド時生成はあなたの `Program.cs` を実行するので、ビルド中に動くべきでない起動コード (データベース接続のオープンなど) は、エントリアセンブリ名でガードしてください。

**推論されるスキーマは Swashbuckle より厳格です。** 組み込みジェネレーターは API エクスプローラーが見えるものだけをドキュメント化します。minimal なエンドポイントが、型付きのオーバーロードや `Produces<T>` 呼び出しなしに `IResult` を返すと、レスポンススキーマが欠落します。Swashbuckle は時にこれをリフレクションでごまかしていました。新しいジェネレーターはアノテーションを求めます。スキーマが消える箇所には `Produces<T>` と `Accepts<T>` を追加してください。

**`OpenApiSchema` は今やインターフェースです。** `OpenApiSchema schema` をパラメーターやローカル変数として宣言していたコードは `IOpenApiSchema` を必要とするかもしれず、`Nullable` プロパティは `JsonSchemaType.Null` に取って代わられて消えました。手の込んだスキーマフィルターを書いていたなら、コンパイルエラーの大半はここに着地します。

腑に落ちてしまえばメンタルモデルは小さなものです。フレームワークがドキュメントを所有し、トランスフォーマーがフィルターを置き換え、UI は分離された交換可能な関心事です。作業の大半はフィルターからトランスフォーマーへの書き直しと、Microsoft.OpenApi v2 の名前空間と型の変更で、登録の入れ替え自体は 2 行です。

## 関連記事

- [ASP.NET Core 11 で Swashbuckle なしに OpenAPI を公開する方法](/ja/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/)
- [ASP.NET Core 11 で MapGroup を使って minimal API のエンドポイントを整理する方法](/ja/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [.NET 11 で OpenAPI の spec から強く型付けされたクライアントコードを生成する方法](/ja/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/)
- [ASP.NET Core の Scalar: なぜ Bearer トークンが無視されるのか](/ja/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/)
- [.NET 8 から .NET 11 への移行: 完全チェックリスト](/ja/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/)

## 参照元

- [Generate OpenAPI documents, ASP.NET Core ドキュメント](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/aspnetcore-openapi?view=aspnetcore-10.0)
- [Customize OpenAPI documents, ASP.NET Core ドキュメント](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/customize-openapi?view=aspnetcore-10.0)
- [Swashbuckle.AspNetCore migrating to v10](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/blob/master/docs/migrating-to-v10.md)
- [Microsoft.AspNetCore.OpenApi (NuGet)](https://www.nuget.org/packages/Microsoft.AspNetCore.OpenApi/)
- [Microsoft.Extensions.ApiDescription.Server (NuGet)](https://www.nuget.org/packages/Microsoft.Extensions.ApiDescription.Server)
</content>
