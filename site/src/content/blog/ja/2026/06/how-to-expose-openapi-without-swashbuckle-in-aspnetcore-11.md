---
title: "ASP.NET Core 11 で Swashbuckle なしに OpenAPI を公開する方法"
description: "Swashbuckle は ASP.NET Core のテンプレートから消えました。.NET 11 で組み込みパッケージ Microsoft.AspNetCore.OpenApi を使って OpenAPI ドキュメントを生成し提供する方法を解説します: AddOpenApi、MapOpenApi、トランスフォーマー、複数ドキュメント、ビルド時生成、その上に載せる UI。"
pubDate: 2026-06-08
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "openapi"
lang: "ja"
translationOf: "2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-06-08
---

最近 ASP.NET Core の Web API を作成して `AddSwaggerGen` と `UseSwagger` を探したなら、それらは見つからなかったはずです。.NET 9 以降、Web API テンプレートには Swashbuckle ではなく Microsoft 独自の OpenAPI ジェネレーターが含まれています。.NET 11 で OpenAPI ドキュメントを公開するには、`Microsoft.AspNetCore.OpenApi` をインストールし、`builder.Services.AddOpenApi()` を呼び出し、`app.MapOpenApi()` を呼び出します。これでドキュメントが `/openapi/v1.json` で提供されます。UI は同梱されていません。インタラクティブなページが欲しい場合は、Scalar や Swagger UI を別途追加し、その JSON エンドポイントに向けます。以下の内容はすべて `Microsoft.NET.Sdk.Web` と C# 14 を使う .NET 11 を対象としていますが、同じ API は .NET 9 と 10 にも存在します。

## なぜ Swashbuckle はテンプレートから外れたのか

Swashbuckle.AspNetCore は長年にわたり標準の OpenAPI ソリューションでしたが、公式テンプレートに固定されたサードパーティ製パッケージであり、.NET のリリースに大きく遅れていました。.NET 6 の時代は教訓的な例です。Swashbuckle のメンテナンスは停滞し、パッケージは最新のランタイムを対象とする安定版のないままになり、新しい .NET バージョンへ更新するチームは、自分たちが所有していない依存関係を待つしかありませんでした。Microsoft は、JSON シリアライザーや依存性注入コンテナと同じように、OpenAPI 生成は同梱するに値するほど中核的だと判断しました。

その結果が `Microsoft.AspNetCore.OpenApi` です。これはデフォルトで [OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.1.html) ドキュメントを生成し、[JSON Schema draft 2020-12](https://json-schema.org/specification-links#2020-12) を使用し、フレームワークの残りの部分がすでに依存している `System.Text.Json` のスキーマサポートを再利用し、Native AOT と互換性があります。意図的に行わない唯一のことは、UI のレンダリングです。Swashbuckle はドキュメントジェネレーターと Swagger UI の Web アセットの両方をバンドルしていましたが、Microsoft はそれらの関心事を分離しました。フレームワークが仕様を生成し、あなたがビューアーを選びます。

## ドキュメントを生成する 2 つの呼び出し

パッケージを追加します:

```dotnetcli
dotnet add package Microsoft.AspNetCore.OpenApi
```

次にサービスを登録し、エンドポイントをマップします:

```csharp
// .NET 11, C# 14
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOpenApi();

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

app.MapGet("/todos/{id}", (int id) => new Todo(id, "Write the spec", false));

app.Run();

record Todo(int Id, string Title, bool Done);
```

アプリケーションを実行し、`https://localhost:{port}/openapi/v1.json` をリクエストしてください。API エクスプローラーが認識できるすべてのエンドポイントを記述した完全な OpenAPI 3.1 ドキュメントが得られ、スキーマはパラメーターと戻り値の型から推論されます。`AddOpenApi()` はドキュメントサービスを登録し、`MapOpenApi()` はリクエスト時にドキュメントをシリアライズする route handler を追加します。

デフォルトのドキュメント名は `v1` で、そのためルートは `/openapi/v1.json` です。`MapOpenApi` のルートテンプレートは `/openapi/{documentName}.json` です。上のコードで注目すべき点が 2 つあります。第一に、ドキュメントのエンドポイントは `IsDevelopment()` の背後で保護されています。これはフレームワーク自身の推奨です。OpenAPI ドキュメントはあなたの攻撃対象領域の完全な地図なので、デフォルトで公開インターネットに提供しないでください。第二に、まだ UI はありません。`/openapi/v1.json` にアクセスすると生の JSON が返されますが、これはまさにツールが欲しがるものであって、人間がクリックして見たいものではありません。

## 自分の UI を用意する

ここが Swashbuckle から移ってきた人がつまずく部分です。Swashbuckle では `/swagger` がそのまま動きました。.NET 11 ではビューアーを選び、それをドキュメントのルートに接続します。

.NET 9 以降のテンプレートのデフォルトは Scalar に傾いています。`Scalar.AspNetCore` をインストールしてマップします:

```csharp
// .NET 11, C# 14
using Scalar.AspNetCore;

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.MapScalarApiReference();
}
```

`https://localhost:{port}/scalar` にアクセスすると、`/openapi/v1.json` ドキュメントを読むインタラクティブなリファレンス UI が得られます。Scalar は標準ルートを自動検出するので、一般的なケースではこれ以上設定するものはありません。

チームが Swagger UI に愛着があるなら、それも引き続き使えます。`Swashbuckle.AspNetCore.SwaggerUi`（ジェネレーターではなく UI アセットだけ）をインストールし、ドキュメントに向けます:

```csharp
// .NET 11, C# 14
var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();

    app.UseSwaggerUI(options =>
    {
        options.SwaggerEndpoint("/openapi/v1.json", "v1");
    });
}
```

これで Swagger UI が `/swagger` で提供され、Swashbuckle が生成したものではなくフレームワークが生成したドキュメントを読み込みます。ReDoc も同じように動きます。静的な UI を提供し、`/openapi/v1.json` の URL を渡すだけです。フレームワークは JSON だけを所有するので、どのビューアーを使うかは気にしません。セキュリティ上の注意として、ドキュメント自体を保護するのと同じ理由で、3 つの UI すべてを開発専用のチェックの背後に置いてください。

## タイトル、説明、メタデータを追加する

素のドキュメントには汎用的なタイトルがあり、説明はありません。これを 2 か所で充実させます。エンドポイントごとのメタデータと、ドキュメント全体のトランスフォーマーです。

エンドポイントごとのメタデータは、ルーティングですでに使っているのと同じ minimal API の規約を使います。`WithSummary`、`WithDescription`、`WithTags` はそのまま操作に流れ込みます:

```csharp
// .NET 11, C# 14
app.MapGet("/todos/{id}", (int id) => Results.Ok(new Todo(id, "Write", false)))
   .WithSummary("Get a todo by id")
   .WithDescription("Returns a single todo item, or 404 if it does not exist.")
   .WithTags("Todos")
   .Produces<Todo>(StatusCodes.Status200OK)
   .Produces(StatusCodes.Status404NotFound);
```

API のタイトル、バージョン、連絡先といったドキュメントレベルの情報については、ドキュメントトランスフォーマーを登録します。トランスフォーマーは生成された `OpenApiDocument` がシリアライズされる前に実行されるので、何でも設定したり書き換えたりできます:

```csharp
// .NET 11, C# 14
using Microsoft.OpenApi.Models;

builder.Services.AddOpenApi(options =>
{
    options.AddDocumentTransformer((document, context, cancellationToken) =>
    {
        document.Info = new OpenApiInfo
        {
            Title = "Todo API",
            Version = "v1",
            Description = "Task tracking endpoints for the Start Debugging sample.",
            Contact = new OpenApiContact { Name = "API team", Email = "api@example.com" }
        };
        return Task.CompletedTask;
    });
});
```

トランスフォーマーは、Swashbuckle のフィルターでやっていたことの大半を置き換える拡張ポイントです。3 種類あり、登録した順序で実行されます:

- `AddDocumentTransformer` はドキュメント全体を変更します。`Info`、`servers`、トップレベルのセキュリティスキーム、タグに使います。
- `AddOperationTransformer` は操作ごとに 1 回実行されます。共通のレスポンス、ヘッダーパラメーター、説明をすべてのエンドポイントに追加するのに使います。
- `AddSchemaTransformer` は生成されたスキーマごとに 1 回実行されます。例の追加、フォーマットの調整、プロパティのマークに使います。

よくある実務上のタスクは、UI に Authorize ボタンを表示させるために Bearer セキュリティスキームを宣言することです。これはスキームとグローバル要件を追加するドキュメントトランスフォーマーです。ビューアーがトークンを黙って無視するケースに遭遇したことがあるなら、その原因はほぼ常にドキュメント内のセキュリティスキームの欠落または不正です。これについては [なぜ Scalar で Bearer トークンが無視されるのか](/ja/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/) で詳しく扱いました。

強く型付けされたトランスフォーマーには、`IOpenApiDocumentTransformer`（または操作・スキーマの相当物）を実装し、その型を登録します。これにより、たとえば登録された認証スキームを読み取って対応するセキュリティ定義を出力するために、サービスを注入できます:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi.Models;

internal sealed class BearerSecuritySchemeTransformer : IOpenApiDocumentTransformer
{
    public Task TransformAsync(
        OpenApiDocument document,
        OpenApiDocumentTransformerContext context,
        CancellationToken cancellationToken)
    {
        document.Components ??= new OpenApiComponents();
        document.Components.SecuritySchemes["Bearer"] = new OpenApiSecurityScheme
        {
            Type = SecuritySchemeType.Http,
            Scheme = "bearer",
            BearerFormat = "JWT",
            In = ParameterLocation.Header
        };
        return Task.CompletedTask;
    }
}

// Registration
builder.Services.AddOpenApi(options =>
{
    options.AddDocumentTransformer<BearerSecuritySchemeTransformer>();
});
```

## 複数のドキュメントを生成する

Swashbuckle は「v1 と v2」や「公開と内部」を複数の `SwaggerDoc` 呼び出しで扱いました。組み込みジェネレーターは、それぞれ独自の名前とオプションを持つ複数の `AddOpenApi` 呼び出しでこれを行います:

```csharp
// .NET 11, C# 14
builder.Services.AddOpenApi("public");
builder.Services.AddOpenApi("internal");
```

名前付きの各ドキュメントは独自のルートを得ます: `/openapi/public.json` と `/openapi/internal.json` です。どのエンドポイントがどのドキュメントに入るかは、`OpenApiOptions` の `ShouldInclude` デリゲートが決めます。デフォルトでは、`WithGroupName` または `[EndpointGroupName]` 属性で設定されるエンドポイントのグループ名を使い、グループ名を持たないエンドポイントはすべてのドキュメントに含まれます。`ShouldInclude` は `ApiDescription` に対する任意の述語で置き換えられます:

```csharp
// .NET 11, C# 14
builder.Services.AddOpenApi("public", options =>
{
    options.ShouldInclude = description =>
        description.GroupName is null || description.GroupName == "public";
});
```

API バージョニングを動かしているなら、バージョニングライブラリはこの同じドキュメントモデルと戦うのではなく統合され、これは古いセットアップに対する実質的な改善です。バージョンごとに 1 ドキュメントとするパターンについては [Asp.Versioning と組み込み OpenAPI](/ja/2026/04/api-versioning-openapi-dotnet-10/) を参照してください。

## ビルド時にドキュメントを生成する

ドキュメントを HTTP で提供するのは開発には適していますが、JSON ファイルをビルド成果物として欲しい場合もあります。バージョン管理にコミットする、それに対してコントラクトテストを実行する、[クライアントコードジェネレーター](/ja/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/) に渡す、あるいはライブのエンドポイントを公開する代わりに本番で静的ファイルとして提供する、といった場合です。そのためにはビルド時パッケージを追加します:

```dotnetcli
dotnet add package Microsoft.Extensions.ApiDescription.Server
```

パッケージをインストールすると、`dotnet build` はプロジェクト名のドキュメントを `obj/` に出力します。それがどこに出力されるか、生成するかどうかを制御するには、`.csproj` に MSBuild プロパティを設定します:

```xml
<PropertyGroup>
  <OpenApiGenerateDocuments>true</OpenApiGenerateDocuments>
  <OpenApiDocumentsDirectory>$(MSBuildProjectDirectory)</OpenApiDocumentsDirectory>
</PropertyGroup>
```

`OpenApiDocumentsDirectory` はプロジェクトファイルからの相対で解決されるので、上の値は JSON を `.csproj` の隣に出力します。複数生成するときにファイル名を変えたり 1 つのドキュメントを選んだりするには、`OpenApiGenerateDocumentsOptions` を使います:

```xml
<PropertyGroup>
  <OpenApiGenerateDocumentsOptions>--file-name my-api --document-name public</OpenApiGenerateDocumentsOptions>
</PropertyGroup>
```

ビルド時生成は、アプリのエントリポイントをモックサーバーに対して起動することで機能するので、`Program.cs` は実際に実行されます。つまり、起動コード、構成の読み取り、依存性注入の登録はすべてビルド中に実行されます。起動時の何かをこのコンテキストで実行すべきでない場合、たとえばデータベースへの接続などは、エントリアセンブリ名のチェックで囲んでください:

```csharp
// .NET 11, C# 14
using System.Reflection;

if (Assembly.GetEntryAssembly()?.GetName().Name != "GetDocument.Insider")
{
    builder.Services.AddDbContext<AppDbContext>(/* ... */);
}
```

現在の制限が 1 つあります。ビルド時生成は JSON のみを出力します。YAML 出力はランタイムではサポートされています（`MapOpenApi` に `.yaml` ルートを渡します）が、ビルド時にはまだサポートされていません。

## 公開前に知っておくべき落とし穴

**ドキュメントはリクエストごとに再生成されます。** `MapOpenApi` は、トランスフォーマーがライブの状態に反応できるように、意図的にエンドポイントがヒットするたびに生成パイプライン全体を実行します。リクエストの多いドキュメントでは、出力キャッシュとエンドポイントの `.CacheOutput()` でキャッシュするか、単にビルド時生成に頼って静的ファイルを提供できます。

**デフォルトの仕様バージョンは 3.1 で、これが古いツールを壊すことがあります。** 一部のコンシューマーはまだ OpenAPI 3.0 しか理解しません。下流のジェネレーターが 3.1 ドキュメントで詰まる場合は、明示的にバージョンを下げます:

```csharp
// .NET 11, C# 14
using Microsoft.OpenApi;

builder.Services.AddOpenApi(options =>
{
    options.OpenApiVersion = OpenApiSpecVersion.OpenApi3_0;
});
```

ビルド時の相当物は `<OpenApiGenerateDocumentsOptions>--openapi-version OpenApi3_1</OpenApiGenerateDocumentsOptions>` です。

**エンドポイントはデフォルトで認可を持ちません。** 開発以外でドキュメントを公開する場合は保護してください。`MapOpenApi()` は endpoint convention builder を返すので、`app.MapOpenApi().RequireAuthorization("SomePolicy")` はどの minimal endpoint とも同じように動きます。

**API エクスプローラーが認識するものしかドキュメント化しません。** minimal API のエンドポイントは自動的に検出されますが、型付きのオーバーロードや `Produces` 呼び出しなしで `IResult` を返すと、ジェネレーターはレスポンススキーマを推論できません。`Produces<T>` と `Accepts<T>` で注釈を付けて、ドキュメントが正確になるようにしてください。これは minimal API が他の場所でも報いるのと同じ規律で、[MapGroup](/ja/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) でエンドポイントを整理して保つことと相性が良いです。`WithTags` のようなグループレベルの規約は、グループ内のすべての操作に流れ込むからです。

Swashbuckle からの考え方の転換は、いったん腑に落ちれば小さなものです。フレームワークがドキュメントを所有し、トランスフォーマーがフィルターを置き換え、UI は別個の差し替え可能な関心事です。JSON を得るのに 2 行、ビューアーを得るのにもう 1 行、ドキュメントを見栄え良くするのに少数のトランスフォーマーを書きます。他人のスケジュールで出荷されるパッケージに固定されるものは何もありません。

## 関連記事

- [ASP.NET Core 11 で MapGroup を使って minimal API エンドポイントを整理する方法](/ja/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [.NET 11 で Swagger UI に OpenAPI 認証フローを追加する方法](/ja/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/)
- [.NET 11 で OpenAPI 仕様から強く型付けされたクライアントコードを生成する方法](/ja/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/)
- [ASP.NET Core の Scalar: なぜ Bearer トークンが無視されるのか](/ja/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/)
- [ASP.NET Core 11 における minimal API とコントローラーの比較](/ja/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)

## 参考資料

- [Generate OpenAPI documents, ASP.NET Core ドキュメント](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/aspnetcore-openapi?view=aspnetcore-10.0)
- [Use the generated OpenAPI documents, ASP.NET Core ドキュメント](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/using-openapi-documents?view=aspnetcore-10.0)
- [Customize OpenAPI documents, ASP.NET Core ドキュメント](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/customize-openapi?view=aspnetcore-10.0)
- [Microsoft.AspNetCore.OpenApi（NuGet）](https://www.nuget.org/packages/Microsoft.AspNetCore.OpenApi/)
- [Microsoft.Extensions.ApiDescription.Server（NuGet）](https://www.nuget.org/packages/Microsoft.Extensions.ApiDescription.Server)
</content>
