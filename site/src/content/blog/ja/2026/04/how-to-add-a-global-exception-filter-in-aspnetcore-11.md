---
title: "ASP.NET Core 11 でグローバル例外フィルターを追加する方法"
description: "ASP.NET Core 11 におけるグローバル例外処理の完全ガイド: なぜ IExceptionFilter は適切なツールではないのか、IExceptionHandler と UseExceptionHandler の連携、ProblemDetails レスポンス、複数ハンドラーチェーン、そして .NET 10 の診断抑制に関する破壊的変更について解説します。"
pubDate: 2026-04-26
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "error-handling"
lang: "ja"
translationOf: "2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-04-26
---

ASP.NET Core 11 アプリケーションで未処理の例外をすべて捕捉し、整ったHTTPレスポンスに変換するには、`IExceptionHandler` を実装し、`services.AddExceptionHandler<T>()` で登録し、`app.UseExceptionHandler()` をミドルウェアパイプラインの早い段階に配置します。古い MVC の `IExceptionFilter` はコントローラーアクションに対してのみ発火するため、minimal API のエンドポイント、ミドルウェアの例外、モデルバインディングの失敗、MVC が走る前に投げられたものを取り逃します。ハンドラーベースのアプローチはこれをパイプライン全体で置き換え、RFC 7807 レスポンスのために `ProblemDetails` と統合され、Native AOT、minimal API、コントローラーで同じように動作します。本ガイドの内容はすべて `Microsoft.NET.Sdk.Web` と C# 14 を使った .NET 11 (preview 3) を対象としていますが、API は .NET 8 から安定しており、パターンは .NET 9 や .NET 10 でも変更なく適用できます。

## 「例外フィルター」は検索用語ですが、ほぼ必要ありません

開発者が「グローバル例外フィルター」を追加する方法を尋ねるとき、検索エンジンの上位結果は通常 2017 年の Stack Overflow の回答で、`IExceptionFilter` と `MvcOptions.Filters.Add<T>` を指しています。そのコードは今もコンパイルでき、今も動作しますが、ASP.NET Core 8 以降は正解ではありません。

`IExceptionFilter` は `Microsoft.AspNetCore.Mvc.Filters` にあります。MVC パイプラインの一部であり、それは三つのことを意味します:

1. MVC アクション、MVC フィルター、または結果エグゼキューターの内部で投げられた例外しか捕捉しません。パイプラインのもっと前で投げられたもの (モデルバインディングのエラー、認証の失敗、ルーティングの 404) は決して届きません。
2. minimal API のエンドポイント (`app.MapGet("/", ...)`) からの例外を見ません。minimal API は `MvcRoutedActionInvoker` を経由しないため、MVC フィルターはそれらに対して沈黙します。
3. モデルバインディングがすでに `ModelState` のエラーを生成した後に走るため、不正なリクエストボディは、変換したかった例外がフィルターに届く前にフレームワークから 400 を返します。

現代の同等品は `IExceptionHandler` で、`Microsoft.AspNetCore.Diagnostics` 8.0 で導入され、.NET 11 でも変更ありません。これはパイプラインの最上位に位置する `UseExceptionHandler` ミドルウェアの内部から走るため、単一のハンドラーでコントローラー、minimal API、gRPC、SignalR ネゴシエーション、静的ファイル、ミドルウェアが投げる例外を一箇所でカバーします。それが「グローバル」と言うときの意味です。

このガイドの残りは `IExceptionHandler` のパスです。最後のセクションでは、MVC フィルターが今でも正しいツールである数少ないケースを取り上げます。

## 最小の IExceptionHandler

`IExceptionHandler` は単一メソッドのインターフェースです:

```csharp
// .NET 11, C# 14
namespace Microsoft.AspNetCore.Diagnostics;

public interface IExceptionHandler
{
    ValueTask<bool> TryHandleAsync(
        HttpContext httpContext,
        Exception exception,
        CancellationToken cancellationToken);
}
```

レスポンスを書き、ミドルウェアを停止させたい場合は `true` を返します。チェーン内の次のハンドラー (もしくは、どれも処理しない場合はフレームワークのデフォルトのエラーレスポンス) にフォールスルーさせたい場合は `false` を返します。

「あらゆる例外を JSON ボディの 500 に変換する」動作するハンドラーは約 30 行です:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

internal sealed class GlobalExceptionHandler(
    ILogger<GlobalExceptionHandler> logger,
    IProblemDetailsService problemDetailsService) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(
        HttpContext httpContext,
        Exception exception,
        CancellationToken cancellationToken)
    {
        logger.LogError(exception, "Unhandled exception on {Path}", httpContext.Request.Path);

        httpContext.Response.StatusCode = StatusCodes.Status500InternalServerError;

        return await problemDetailsService.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = httpContext,
            Exception = exception,
            ProblemDetails = new ProblemDetails
            {
                Type = "https://tools.ietf.org/html/rfc9110#section-15.6.1",
                Title = "An unexpected error occurred",
                Status = StatusCodes.Status500InternalServerError,
            },
        });
    }
}
```

ここでは二つの点が重要です。第一に、ハンドラーは `sealed` であり、C# 12+ のイディオムであるプライマリコンストラクター注入を使います。第二に、実際のレスポンスボディは `httpContext.Response.WriteAsJsonAsync(...)` を自分で呼び出すのではなく `IProblemDetailsService` に委譲しています。この一つの変更によって、レスポンスはクライアントの `Accept` ヘッダー、登録された `IProblemDetailsWriter` のセット、設定済みの `CustomizeProblemDetails` コールバックを尊重するようになります。これは ProblemDetails のセクションで再度取り上げます。

## Program.cs でハンドラーを配線する

3 行でハンドラーを追加できます。ミドルウェアの順序が重要です:

```csharp
// .NET 11, C# 14, Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddProblemDetails();
builder.Services.AddExceptionHandler<GlobalExceptionHandler>();

var app = builder.Build();

app.UseExceptionHandler();   // must come before UseAuthorization, MapControllers, etc.
app.UseStatusCodePages();    // optional, formats 4xx the same way

app.MapControllers();
app.Run();
```

`AddExceptionHandler<T>` はハンドラーを singleton として登録し、これはフレームワークによって強制されます。ハンドラーがスコープ付きサービス (`DbContext`、リクエストスコープのロガー) を必要とする場合は、コンストラクターでスコープ付きサービスを受け取るのではなく、`IServiceProvider` を注入し呼び出しごとにスコープを作成してください:

```csharp
// .NET 11, C# 14
internal sealed class DbBackedExceptionHandler(IServiceScopeFactory scopes) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(
        HttpContext ctx, Exception ex, CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AuditDbContext>();
        db.Failures.Add(new FailureRecord(ctx.TraceIdentifier, ex.GetType().FullName!));
        await db.SaveChangesAsync(ct);
        return false; // let another handler write the response
    }
}
```

引数なしの `UseExceptionHandler()` は登録された `IExceptionHandler` チェーンを使います。`string` のパスや `Action<IApplicationBuilder>` を取るオーバーロードは古いミドルウェアのみのモデルで、ハンドラーチェーンをバイパスします。どちらか一方を選び、両方を使わないでください。

## ProblemDetails は配線すれば無料で手に入る

`AddProblemDetails()` はデフォルトの `IProblemDetailsService` と `application/problem+json` 用の `IProblemDetailsWriter` を 1 つ登録します。登録されると、3 つのことが自動的に起こります:

1. `UseExceptionHandler()` は、どの `IExceptionHandler` もレスポンスを引き受けない未処理例外に対して `ProblemDetails` ボディを書き出します。
2. `UseStatusCodePages()` はボディのない 4xx レスポンスに対して `ProblemDetails` ボディを書き出します。
3. 自分のハンドラーから `problemDetailsService.TryWriteAsync(...)` を呼び出すと、同じコンテンツネゴシエーションとカスタマイズが無料で得られます。

最も有用なカスタマイズポイントは `CustomizeProblemDetails` で、ハンドラーがオブジェクトを構築した後、書き出される前に走ります。一般的なサイトはトレース識別子を追加し、サポートがユーザーに見えるエラーをログエントリと相関させられるようにします:

```csharp
// .NET 11, C# 14
builder.Services.AddProblemDetails(options =>
{
    options.CustomizeProblemDetails = ctx =>
    {
        ctx.ProblemDetails.Extensions["traceId"] = ctx.HttpContext.TraceIdentifier;
        ctx.ProblemDetails.Extensions["requestId"] =
            Activity.Current?.Id ?? ctx.HttpContext.TraceIdentifier;
    };
});
```

本番では例外メッセージやスタックトレースをレスポンスに入れないでください。それらは内部構造 (テーブル名、ファイルパス、サードパーティ API の URL) を漏らし、攻撃者がより的を絞った探査につなげる材料になります。`ex.Message` の出力は `IHostEnvironment.IsDevelopment()` で条件付けてください。

## 複数のハンドラーを例外型で順序付ける

例外ミドルウェアは登録順で登録済みハンドラーを反復し、いずれかが `true` を返すまで続けます。ここが例外型ごとの変換を置く正しい場所です:

```csharp
// .NET 11, C# 14
internal sealed class ValidationExceptionHandler(IProblemDetailsService pds) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(
        HttpContext ctx, Exception ex, CancellationToken ct)
    {
        if (ex is not FluentValidation.ValidationException ve) return false;

        ctx.Response.StatusCode = StatusCodes.Status400BadRequest;

        var errors = ve.Errors
            .GroupBy(e => e.PropertyName)
            .ToDictionary(g => g.Key, g => g.Select(e => e.ErrorMessage).ToArray());

        return await pds.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = ctx,
            Exception = ex,
            ProblemDetails = new HttpValidationProblemDetails(errors)
            {
                Type = "https://tools.ietf.org/html/rfc9110#section-15.5.1",
                Title = "One or more validation errors occurred",
                Status = StatusCodes.Status400BadRequest,
            },
        });
    }
}

internal sealed class NotFoundExceptionHandler(IProblemDetailsService pds) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(
        HttpContext ctx, Exception ex, CancellationToken ct)
    {
        if (ex is not EntityNotFoundException) return false;

        ctx.Response.StatusCode = StatusCodes.Status404NotFound;
        return await pds.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = ctx,
            Exception = ex,
            ProblemDetails = new ProblemDetails
            {
                Type = "https://tools.ietf.org/html/rfc9110#section-15.5.5",
                Title = "Resource not found",
                Status = StatusCodes.Status404NotFound,
            },
        });
    }
}
```

優先順位順で登録します。すべてを受け止める 500 ハンドラーは最後です:

```csharp
// .NET 11, C# 14
builder.Services.AddExceptionHandler<ValidationExceptionHandler>();
builder.Services.AddExceptionHandler<NotFoundExceptionHandler>();
builder.Services.AddExceptionHandler<GlobalExceptionHandler>();
```

ミドルウェアはまさにこの順番で singleton を反復します。`ValidationExceptionHandler` が `false` を返せば次のハンドラーが尋ねられます。`GlobalExceptionHandler` が `true` を返せばそれ以降のハンドラーは走りません。

巨大な `switch` を持つメガハンドラーを書く誘惑に抗ってください。例外型ごとのハンドラーは単体テストが容易で (それぞれは fake を一つ取る小さなクラスです)、例外型がなくなったときに削除しやすく、条件付きで配線しやすい (例えば `ValidationExceptionHandler` を FluentValidation がプロジェクトにあるときだけ登録するなど) のです。

## ハンドラーを壊すミドルウェアの順序

最も多い間違いは `UseExceptionHandler()` を間違った場所に置くことです。ルールはこうです: 捕捉したい例外を投げる可能性のあるどのミドルウェアよりも前に来なければなりません。実務上は、環境関連でない最初のミドルウェアであるべきだということです。

```csharp
// Wrong: a NullReferenceException from authentication never reaches the handler.
app.UseAuthentication();
app.UseAuthorization();
app.UseExceptionHandler();   // too late
app.MapControllers();

// Right: the handler wraps everything that follows.
app.UseExceptionHandler();
app.UseAuthentication();
app.UseAuthorization();
app.MapControllers();
```

`UseExceptionHandler` より前に正当に走るのは、本番以外の開発者向け例外ページだけです:

```csharp
// .NET 11, C# 14
if (app.Environment.IsDevelopment())
{
    app.UseDeveloperExceptionPage();
}
else
{
    app.UseExceptionHandler();
    app.UseHsts();
}
```

両方を登録した場合、dev では開発者向けページが勝ちます。ハンドラーミドルウェアが走る前にリクエストをショートサーキットするからです。通常はそれを望むはずです: dev ページはスタックトレースとソーススニペットを表示し、ローカルで実行する目的そのものだからです。

## .NET 10 の診断抑制に関する破壊的変更

.NET 8 と 9 では `UseExceptionHandler` は `IExceptionHandler` が `true` を返すかどうかに関係なく、未処理例外を `Error` レベルで常にログ出力し、`Microsoft.AspNetCore.Diagnostics.HandlerException` アクティビティを発行していました。これは二重ログを生みやすくしていました: ハンドラーがログを書き、フレームワークもログを書きました。

.NET 10 から (そして .NET 11 でも維持) フレームワークは、ハンドラーが `true` を返して引き受けたあらゆる例外について、自身の診断を抑制します。その場合のログ出力責任はハンドラーだけにあります。未処理のまま落ちる例外は引き続きフレームワークのログを発行します。

これは静かに直撃する可能性のある動作変更です。`aspnetcore.diagnostics.handler.unhandled_exceptions` についての Grafana アラートがあり、.NET 10 以降にアップグレードすると、処理された例外についてメトリックがゼロに落ちダッシュボードが平らになります。修正方法は次のとおりです:

```csharp
// Opt back in to the .NET 8/9 behaviour.
app.UseExceptionHandler(new ExceptionHandlerOptions
{
    SuppressDiagnosticsCallback = _ => false,
});
```

または、推奨としてはダッシュボードを削除してハンドラーのログ出力に頼ることです。二重カウントは元々バグでした。

コールバックは例外、リクエスト、ハンドラーがレスポンスを引き受けたかどうかを示すフラグを含む `ExceptionHandlerDiagnosticsContext` を受け取るので、選択的に抑制できます。例えばクライアントが中止したリクエストの `OperationCanceledException` をログしないようにできます:

```csharp
// .NET 11, C# 14
app.UseExceptionHandler(new ExceptionHandlerOptions
{
    SuppressDiagnosticsCallback = ctx =>
        ctx.Exception is OperationCanceledException &&
        ctx.HttpContext.RequestAborted.IsCancellationRequested,
});
```

正確なセマンティクスは [Microsoft Learn の破壊的変更ノート](https://learn.microsoft.com/en-us/dotnet/core/compatibility/aspnet-core/10/exception-handler-diagnostics-suppressed) を参照してください。

## IExceptionFilter が今でも正しいツールであるとき

MVC の `IExceptionFilter` が今でも正しい狭い 2 つのケースがあります:

1. 特定のコントローラーやアクションだけで例外を変換したく、フィルターをアクションの属性で発見できるようにしたい場合。コントローラークラスに `[TypeFilter(typeof(MyExceptionFilter))]` を付けると、グローバルパイプラインを汚さずに振る舞いをスコープできます。これは本当に「グローバル」なものというよりは、奇妙な 1 つのエンドポイントのためのアクションフィルターに近いです。
2. MVC の `ActionContext` (例えばアクションのパラメーターのための `IModelMetadataProvider`) にアクセスする必要がある場合。`IExceptionHandler` は `HttpContext` しか見えないため、このメタデータはそこでは利用できません。

それ以外では `IExceptionHandler` の方が勝ります。minimal API でも動き、MVC より前に走り、複数の登録済みハンドラーときれいに合成できます。MVC フィルターはアクションスコープのツールとして扱い、グローバルなものとして扱わないでください。

## よくある間違い: カスタム IProblemDetailsWriter の中で例外を投げる

カスタム `IProblemDetailsWriter` を実装する場合 (例えばベンダー固有のエラーエンベロープを発行するため)、`WriteAsync` から例外を投げないでください。例外ミドルウェアはその例外も捕まえ、同じハンドラーチェーンに再帰し、結果としてスタックオーバーフローになるか、運が良ければボディのない空の 500 になります。ボディ書き込みのロジックを try/catch で包み、writer が悪い状態にあるときは `CanWrite` から `false` を返してください。同じルールがハンドラーコードにも当てはまります: `TryHandleAsync` の中から例外を投げないでください。代わりに `false` を返してください。

安全な形:

```csharp
// .NET 11, C# 14
public async ValueTask<bool> TryHandleAsync(
    HttpContext ctx, Exception ex, CancellationToken ct)
{
    try
    {
        ctx.Response.StatusCode = MapStatus(ex);
        await pds.TryWriteAsync(BuildContext(ctx, ex));
        return true;
    }
    catch
    {
        return false; // let the framework default kick in
    }
}
```

## 関連

- [System.Text.Json でカスタム JsonConverter を書く](/ja/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) — クライアントが期待する形で `ProblemDetails.Extensions` 辞書をシリアライズするため。
- [ASP.NET Core エンドポイントからファイルをバッファリングなしでストリーミングする](/ja/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) — 同じパイプラインの別のミドルウェア順序の繊細な点を扱います。
- [長時間実行 Task をデッドロックなしでキャンセルする](/ja/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) — 上の診断コールバックが依拠している `OperationCanceledException` のパターンについて。
- [.NET 11 で OpenAPI 仕様から強く型付けされたクライアントを生成する](/ja/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/) — `ProblemDetails` スキーマを利用者に公開する場合に。

## 出典

- Microsoft Learn, [ASP.NET Core でエラーを処理する](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/error-handling?view=aspnetcore-10.0)。
- Microsoft Learn, [ASP.NET Core API でエラーを処理する](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/error-handling-api?view=aspnetcore-10.0)。
- Microsoft Learn 破壊的変更, [IExceptionHandler.TryHandleAsync が true を返すと例外診断が抑制される](https://learn.microsoft.com/en-us/dotnet/core/compatibility/aspnet-core/10/exception-handler-diagnostics-suppressed)。
- ASP.NET Core リリースノート, [.NET 10 preview 7 ASP.NET Core](https://github.com/dotnet/core/blob/main/release-notes/10.0/preview/preview7/aspnetcore.md)。
- GitHub の議論, [.NET 8 のグローバル例外処理のための IExceptionHandler](https://github.com/dotnet/aspnetcore/discussions/54613)。
