---
title: "ASP.NET Core 11 で IProblemDetailsService を使って Minimal API のバリデーションエラーレスポンスをカスタマイズする方法"
description: "AddProblemDetails に CustomizeProblemDetails コールバックを渡して、ASP.NET Core 11 の組み込み Minimal API バリデーションが返す 400 の形を作り直します。traceId を追加したり、title を書き換えたり、400 を 422 に切り替えたり、カスタム IProblemDetailsWriter で完全に制御したりできます。"
pubDate: 2026-07-03
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-apis"
  - "validation"
lang: "ja"
translationOf: "2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-03
---

組み込みの Minimal API バリデーションは、`HttpValidationProblemDetails` のボディを持つ `400 Bad Request` を無料で返してくれますが、その形はフレームワークのデフォルトです。つまり `type`、`title`、`status`、そして `errors` ディクショナリを持つ RFC 9457 のペイロードです。サポートチケット用の `traceId`、別の `title`、エラードキュメントへのリンク、あるいは `400` の代わりに `422 Unprocessable Entity` が必要なら、そのためのフックが `AddProblemDetails(options => options.CustomizeProblemDetails = ...)` です。これを登録すると、同じコールバックがバリデーション失敗、未処理の例外、ステータスコードページのいずれに対しても発火するので、API が出すあらゆるエラーが同じフィールドを持つようになります。これは初期の .NET 10 プレビューでは欠けていた部分で、.NET 10 GA と .NET 11 で結線されました。組み込みのバリデーションフィルターが問題の詳細を `IProblemDetailsService` 経由でルーティングするようになったので、あなたのカスタマイズが実際にバリデーションエラーにも届くのです。以下はすべて `Microsoft.NET.Sdk.Web` と C# 14 を使った .NET 11 を対象としていますが、.NET 10 GA でも動作は同一です。

## デフォルトのバリデーションレスポンスの見た目

[コントローラーなしで Minimal API のリクエストボディをバリデーションする方法](/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/) で扱ったセットアップから始めます。`AddValidation()` を呼び、リクエストレコードにアノテーションを付け、あとはソースジェネレーターに仕事をさせます。

```csharp
// .NET 11, C# 14 -- Program.cs
using System.ComponentModel.DataAnnotations;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddValidation();
var app = builder.Build();

app.MapPost("/products", (CreateProduct product) =>
    TypedResults.Created($"/products/{product.Sku}", product));

app.Run();

public record CreateProduct(
    [Required, Length(3, 20)] string Sku,
    [Required, MinLength(2)] string Name,
    [Range(1, 10_000)] int Quantity);
```

不正なボディを POST すると、標準のペイロードが返ってきます。

```json
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json

{
  "type": "https://tools.ietf.org/html/rfc9110#section-15.5.1",
  "title": "One or more validation errors occurred.",
  "status": 400,
  "errors": {
    "Sku": ["The field Sku must be a string with a minimum length of 3 and a maximum length of 20."],
    "Name": ["The Name field is required."]
  }
}
```

これは正しく、機械可読ですが、あなたのサービスについては何も語っていません。バグレポートに貼り付けられる相関 ID はなく、`type` はあなた自身のエラーカタログではなく RFC を指しており、`422` を「意味的に不正、リトライ不要」と扱うクライアントは、不正な形式のリクエストと区別できない `400` を受け取ります。カスタマイズはこれらすべてを一箇所で修正します。

## カスタマイズフックを有効にする

`AddProblemDetails()` はデフォルトの `IProblemDetailsService` を登録し、そのオーバーロードは `ProblemDetailsOptions` の構成を受け取ります。そこで `CustomizeProblemDetails` を設定します。このプロパティは `ProblemDetailsContext` を受け取るデリゲートで、`HttpContext` と、まさに書き込まれようとしている可変な `ProblemDetails` の両方を公開します。

1. **コールバックとともに問題の詳細を登録します。** `builder.Build()` の前に `builder.Services.AddProblemDetails(options => options.CustomizeProblemDetails = ctx => { ... })` を呼びます。
2. **`AddValidation()` も残します。** 2 つのサービスは独立しています。`AddValidation()` が `400` を生成し、`AddProblemDetails()` がそのボディの中身をカスタマイズします。
3. **コールバック内で `ctx.ProblemDetails` を変更します。** `Extensions` に追加したり、`Title`、`Type`、`Detail` を書き換えたり、`Status` を変更したりします。

すべてのバリデーションエラーに相関 ID とサポート用のポインタを追加する結線は次のとおりです。

```csharp
// .NET 11, C# 14 -- Program.cs
using System.Diagnostics;
using System.ComponentModel.DataAnnotations;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddValidation();
builder.Services.AddProblemDetails(options =>
{
    options.CustomizeProblemDetails = ctx =>
    {
        // Correlate with distributed tracing; fall back to the request id.
        ctx.ProblemDetails.Extensions["traceId"] =
            Activity.Current?.Id ?? ctx.HttpContext.TraceIdentifier;

        if (ctx.ProblemDetails.Status == StatusCodes.Status400BadRequest)
        {
            ctx.ProblemDetails.Title = "Your request failed validation.";
            ctx.ProblemDetails.Type = "https://api.example.com/errors/validation";
            ctx.ProblemDetails.Extensions["support"] = "support@example.com";
        }
    };
});
var app = builder.Build();

app.MapPost("/products", (CreateProduct product) =>
    TypedResults.Created($"/products/{product.Sku}", product));

app.Run();

public record CreateProduct(
    [Required, Length(3, 20)] string Sku,
    [Required, MinLength(2)] string Name,
    [Range(1, 10_000)] int Quantity);
```

同じ不正な POST が、今度は次のように返します。

```json
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json

{
  "type": "https://api.example.com/errors/validation",
  "title": "Your request failed validation.",
  "status": 400,
  "errors": {
    "Sku": ["The field Sku must be a string with a minimum length of 3 and a maximum length of 20."],
    "Name": ["The Name field is required."]
  },
  "traceId": "00-2f0e...-b7ad...-01",
  "support": "support@example.com"
}
```

`errors` ディクショナリは手つかずなので、既存のクライアントはそのままパースを続けられます。あなたはフィールドを追加しただけで、契約を壊してはいません。`traceId` に注目してください。これは新しい `Guid.NewGuid()` ではなく `Activity.Current?.Id` から取得します。なぜなら、その値はログや OpenTelemetry スパンを流れている実際の W3C トレース ID だからです。ランダムな GUID はトレース ID のように見えますが、何とも相関しません。`HttpContext.TraceIdentifier` へのフォールバックは、トレースコンテキストなしで到着するリクエストをカバーします。

## なぜコールバックはバリデーションだけでなくすべてのエラーに届くのか

各エンドポイントを手で編集するのではなく `CustomizeProblemDetails` を選ぶ理由はカバレッジです。`AddProblemDetails()` が登録されると、コールバックはフレームワークのエラー機構が生成する問題の詳細に対して実行されます。つまり `ExceptionHandlerMiddleware`、`StatusCodePagesMiddleware`、開発者例外ページ、そして .NET 10 GA 以降は組み込みの Minimal API バリデーションフィルターです。コールバックは 1 つ、それであなたの `traceId` はバリデーションからの `400`、マッチしなかったルートからの `404`、未処理例外からの `500` に載ります。その一貫性こそが問題の詳細契約の全目的です。クライアントは、どのレイヤーが生成したかを特別扱いすることなく、API が返すどのエラーからも `traceId` を読み取れるべきなのです。

バリデーションに加えて `404` と `500` のケースも得るには、空のエラーレスポンスを埋める 2 つのミドルウェアを登録します。

```csharp
// .NET 11, C# 14
app.UseExceptionHandler();   // turns unhandled exceptions into ProblemDetails
app.UseStatusCodePages();    // fills empty 4xx/5xx responses with ProblemDetails
app.Run();
```

これらがないと、素の `Results.NotFound()` やマッチしなかったルートは空のボディを返します。なぜなら問題の詳細は「まだボディコンテンツを持たないレスポンス」に対してのみ生成されるからです。バリデーションはこの結線を必要としない例外です。バリデーションフィルター自体が `IProblemDetailsService` を呼び出すので、その `400` は `UseStatusCodePages()` を追加するかどうかに関わらずカスタマイズされます。バリデーションが捕まえないものをグローバルなバックストップで捕まえたい場合、例外パスの仕組みは [ASP.NET Core 11 でグローバル例外フィルターを追加する方法](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) で扱っています。

## バリデーションで 400 の代わりに 422 を返す

よくある API 設計の選択は、「リクエストをパースできなかった」(`400`) と「パースはできたがルールに違反している」(`422 Unprocessable Entity`) を区別することです。コールバックは `Status` を変更でき、ミドルウェアは `ProblemDetails` からステータスを書き込むので、バリデーション失敗を一箇所で `422` に昇格させることができます。

```csharp
// .NET 11, C# 14
builder.Services.AddProblemDetails(options =>
{
    options.CustomizeProblemDetails = ctx =>
    {
        // Built-in validation always produces a 400 with an errors dictionary.
        if (ctx.ProblemDetails.Status == StatusCodes.Status400BadRequest
            && ctx.ProblemDetails.Extensions.ContainsKey("errors"))
        {
            ctx.ProblemDetails.Status = StatusCodes.Status422UnprocessableEntity;
            ctx.HttpContext.Response.StatusCode =
                StatusCodes.Status422UnprocessableEntity;
        }
    };
});
```

`ProblemDetails.Status` フィールド (JSON ボディに現れるもの) と `HttpContext.Response.StatusCode` (実際の HTTP ステータス行) の両方を設定してください。2 つ目を見落とすと、HTTP `400` レスポンスの上に `422` を主張するボディを出荷することになり、それはどちらか一方だけよりも悪いです。`errors` キーのチェックは、この書き換えをバリデーション失敗に限定するので、アプリの別の場所からの素の `400` はそのステータスを保ちます。

## カスタム IProblemDetailsWriter で完全に制御する

`CustomizeProblemDetails` はオブジェクトを変更しますが、シリアライズを制御したり、いつ書き込むかを決めたりはしません。そのためには `IProblemDetailsWriter` を実装します。ライターは `CanWrite` ゲートと、レスポンスボディを所有する `WriteAsync` を持ち、これによりステータスコード、コンテンツネゴシエーション、エンドポイントのメタデータで分岐できます。

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Http;

public sealed class ValidationProblemDetailsWriter : IProblemDetailsWriter
{
    public bool CanWrite(ProblemDetailsContext context)
        => context.ProblemDetails.Status is 400 or 422;

    public ValueTask WriteAsync(ProblemDetailsContext context)
    {
        context.ProblemDetails.Extensions["apiVersion"] = "2026-07";
        return new ValueTask(
            context.HttpContext.Response.WriteAsJsonAsync(
                context.ProblemDetails,
                context.ProblemDetails.GetType(),
                options: null,
                contentType: "application/problem+json"));
    }
}
```

DI に登録します。そして、`AddControllers()` や `AddRazorPages()` のいずれかを使う場合はそれらより前に登録してください。それらは自身のライターを登録し、順序がどちらが勝つかを決めるからです。

```csharp
// .NET 11, C# 14
builder.Services.AddTransient<IProblemDetailsWriter, ValidationProblemDetailsWriter>();
```

ライターに手を伸ばすのは、コールバックでは足りないときだけにしましょう。クライアントごとに異なるシリアライズ、JSON と並んだ XML、あるいは 1 つのステータスコードに対してまったく異なるスキーマを出す場合などです。フィールドの追加やテキストの調整であれば、`CustomizeProblemDetails` のほうがコードが少なく、間違える余地も少ないです。

## アプリ全体ではなく 1 つのエンドポイントをカスタマイズする

これまでのすべてはグローバルです。単一のエンドポイントのバリデーションレスポンスを別の形にしたいときは、ハンドラーから自分で問題の詳細を返します。`extensions` ディクショナリを直接受け取る `TypedResults.ValidationProblem` を使います。

```csharp
// .NET 11, C# 14
app.MapPost("/legacy/products", (CreateProduct product) =>
{
    var errors = new Dictionary<string, string[]>();
    if (product.Quantity <= 0)
        errors["Quantity"] = ["Quantity must be positive on the legacy endpoint."];

    if (errors.Count > 0)
        return TypedResults.ValidationProblem(
            errors,
            extensions: new Dictionary<string, object?>
            {
                ["legacy"] = true
            });

    return TypedResults.Created($"/products/{product.Sku}", product);
});
```

ここには率直に述べておくべき鋭い落とし穴があります。ハンドラーから直接構築して返す `ProblemDetails` は、`TypedResults.ValidationProblem`、`Results.Problem`、`TypedResults.Problem` のいずれを通したものであっても、レスポンスに直接シリアライズされ、`IProblemDetailsService` を **通りません**。あなたのグローバルな `CustomizeProblemDetails` コールバックはそれに対して実行されないので、中央で追加した `traceId` が欠けます。グローバルなカスタマイズとハンドラーが返す問題を混在させる場合は、共有フィールドをハンドラーにも追加するか、サービスを実際に経由する組み込みフィルターにバリデーションを任せてください。これは最もよくある驚きです。コールバックはフレームワークが生成した問題の詳細をカバーしますが、あなた自身が new するものはカバーしません。

## 本番で刺さる落とし穴

- **`Accept` ヘッダーが、そもそも JSON を得られるかどうかを制御します。** `DefaultProblemDetailsWriter` は `application/json`、`application/problem+json`、そして `*/*` や `application/*` のようなワイルドカードに対して書き込みます。`Accept: text/html` や `application/xml` を送るクライアントはフォールバックパスをトリガーし、問題の詳細ボディを得られません。あなたの利用者がブラウザや SOAP クライアントなら、JSON が常に出荷されると仮定するのではなく、これを考慮してください。
- **初期の .NET 10 プレビューでは `CustomizeProblemDetails` がバリデーションに対して呼ばれませんでした。** これは [dotnet/aspnetcore#62723](https://github.com/dotnet/aspnetcore/issues/62723) として追跡されました。バリデーションフィルターが `IProblemDetailsService` をバイパスしていたのです。.NET 10 GA と .NET 11 ではサービス経由で結線されています。コールバックが例外に対しては発火するのにバリデーションエラーに対しては黙って飛ばされる場合、古いプレビュー SDK を使っているので更新してください。
- **コントローラーも併用する場合は順序が重要です。** MVC はバリデーションの問題の詳細を `CustomizeProblemDetails` だけではなく `ProblemDetailsFactory` と `InvalidModelStateResponseFactory` を通して生成します。Minimal API エンドポイントとコントローラーの両方を持つ混在アプリでは両方のパスを構成する必要があり、そうしないとコントローラーと Minimal API がエラーの形について食い違います。
- **内部情報を `Detail` に漏らさないでください。** コールバック内で例外メッセージを `ProblemDetails.Detail` に詰め込みたくなります。本番ではそれがスタックトレースの断片や内部の型名を露出させます。`Detail` はクライアントに安全なものに保ち、診断情報は代わりにログの中で `traceId` の背後に置いてください。
- **コールバックはすべてのエラーのホットパスで実行されます。** 安価に保ってください。`Activity.Current` を読み、ディクショナリのキーを設定するのは問題ありませんが、`CustomizeProblemDetails` の中でデータベース接続を開いたりリモートサービスを呼んだりするのはダメです。レスポンスを書き込む間に同期的に実行されるからです。

覚えておくべきモデルは次のとおりです。`AddValidation()` が何が不正かを決め、`AddProblemDetails()` がその不正さがどう記述されるかを決め、`CustomizeProblemDetails` が、フレームワークが生成したすべてのエラーに対してその記述を一度に形作る唯一の場所です。`traceId` はそこで追加し、`title` はそこで書き換え、`422` へはそこで昇格させ、シリアライズを所有する必要があるときだけカスタムの `IProblemDetailsWriter` に手を伸ばしてください。バリデーションフィルターが捕まえないものについては、[グローバル例外フィルター](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) が同じカスタマイズを運びます。そして組み込みのバリデーターがそもそもあなたのルールをカバーするかまだ判断中なら、[Minimal API バリデーション vs FluentValidation](/2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11/) がその線を引きます。

## 関連記事

- [ASP.NET Core 11 でコントローラーなしで Minimal API のリクエストボディをバリデーションする方法](/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/)：この記事がカスタマイズする `AddValidation()` のセットアップについて。
- [ASP.NET Core 11 における Minimal API バリデーション vs FluentValidation](/2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11/)：出力をカスタマイズする前に、組み込みのバリデーターがあなたのルールに合うかどうかについて。
- [ASP.NET Core 11 でグローバル例外フィルターを追加する方法](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/)：バリデーションが捕まえないものを、同じ `ProblemDetails` の形で捕まえることについて。
- [ASP.NET Core 11 で MapGroup を使って Minimal API のエンドポイントを整理する方法](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)：ルートグループ全体にバリデーションとその問題の詳細を適用することについて。
- [ASP.NET Core 11 における Minimal API vs コントローラー](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)：2 つのエンドポイントモデルでエラー処理がどう異なるかについて。

## 出典

- Microsoft Learn, [Handle errors in ASP.NET Core APIs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/error-handling-api?view=aspnetcore-10.0) (`AddProblemDetails`、問題の詳細を生成するミドルウェア、`CustomizeProblemDetails`、`IProblemDetailsService` のフォールバックとサポートされるメディアタイプ)。
- Microsoft Learn, [Create responses in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/responses?view=aspnetcore-10.0) (`IProblemDetailsService`、`TypedResults.ValidationProblem` による Minimal API のバリデーションエラーレスポンスのカスタマイズ)。
- Microsoft Learn, [ProblemDetailsOptions.CustomizeProblemDetails](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.problemdetailsoptions.customizeproblemdetails) (コールバックのシグネチャと `ProblemDetailsContext`)。
- dotnet/aspnetcore, [CustomizeProblemDetails not invoked for minimal API validation (issue #62723)](https://github.com/dotnet/aspnetcore/issues/62723) (プレビュー時代のギャップ、.NET 10 GA で解決)。
