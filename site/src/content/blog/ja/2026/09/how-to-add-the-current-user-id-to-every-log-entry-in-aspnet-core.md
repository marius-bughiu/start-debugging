---
title: "ASP.NET Core ですべてのログエントリに現在のユーザー ID を追加する方法"
description: "BeginScope ミドルウェアでは、例外ハンドラーのエラーログと Request finished の行が漏れます。IHttpContextAccessor からユーザーを読み取る ILogEnricher を登録し、処理がリクエストの外に出るときだけスコープを開き、Serilog の AddSerilog がエンリッチメントを黙って無効化する点に注意しましょう。"
pubDate: 2026-09-21
template: how-to
tags:
  - "aspnet-core"
  - "dotnet-10"
  - "logging"
  - "observability"
  - "opentelemetry"
  - "serilog"
  - "how-to"
lang: "ja"
translationOf: "2026/09/how-to-add-the-current-user-id-to-every-log-entry-in-aspnet-core"
translatedBy: "claude"
translationDate: 2026-09-21
---

結論から言うと、ユーザー ID をすべての `LogInformation` 呼び出しに渡すのはやめましょう。また、パイプラインを `ILogger.BeginScope` で囲むミドルウェアで終わりにするのも不十分です。そのスコープはスコープの *内側* で行われたログ呼び出しにしか適用されないため、障害時に最も欲しい 2 行、つまり `ExceptionHandlerMiddleware` のエラーとホスティングの "Request finished" エントリが漏れてしまいます。代わりに `Microsoft.Extensions.Telemetry` を追加し、`builder.Logging.EnableEnrichment()` を呼び出し、`IHttpContextAccessor` から `ClaimTypes.NameIdentifier` を読み取る `ILogEnricher` を `builder.Services.AddLogEnricher<UserIdEnricher>()` で登録します。これはフレームワーク自身のものを含むすべてのカテゴリで、ログレコードごとに 1 回実行されます。唯一対応できないのはリクエストより長く生きる処理なので、`Task.Run` やキューに処理を渡す前に ID を取得し、そこでスコープを開きます。

以下の内容はすべて .NET 10 (SDK 10.0.302、ASP.NET Core ランタイム 10.0.10) 上で、`Microsoft.Extensions.Telemetry` 10.10.0、`OpenTelemetry.Extensions.Hosting` と `OpenTelemetry.Exporter.Console` 1.19.1、`Serilog.AspNetCore` 10.0.0 を使って実行しました。結果の表はドキュメントを読んで作ったものではなく、小さなテストアプリに対する実際のリクエストから得たものです。

## BeginScope ミドルウェアが正しく見えて実は正しくない理由

StackOverflow で最初に見つかる答えは、次のようなミドルウェアです。

```csharp
// .NET 10, ASP.NET Core 10: the common approach, and its gap
app.UseExceptionHandler("/error");
app.UseAuthentication();

app.Use(async (ctx, next) =>
{
    var userId = ctx.User.FindFirstValue(ClaimTypes.NameIdentifier);
    if (userId is null) { await next(ctx); return; }

    var logger = ctx.RequestServices.GetRequiredService<ILoggerFactory>()
        .CreateLogger("UserScope");
    using (logger.BeginScope(new Dictionary<string, object?> { ["UserId"] = userId }))
    {
        await next(ctx);
    }
});

app.UseAuthorization();
```

自分のコードに対しては機能します。エンドポイント内の `log.LogInformation("Loading orders")` は、スコープに `"UserId":"u-42"` を含んで出力されます。問題は構造的なものです。ログのスコープは `AsyncLocal` に格納されるため、`using` ブロックがスタック上にある間に行われたログ呼び出しにしか付与されません。重要なログ行のうち 2 つは、そのブロックが破棄された後に書き込まれます。

- `UseExceptionHandler` はスコープのミドルウェアの外側にあります (そうしないと認証から発生する例外を捕捉できないため、外側に置く必要があります)。"An unhandled exception has occurred while executing the request." をログに記録する時点では、例外はすでに `using` を通り抜けて巻き戻っており、スコープは消えています。
- "Request finished ... 500" は、ミドルウェアパイプライン全体を囲む `Microsoft.AspNetCore.Hosting.Diagnostics` によって書き込まれます。自分で書いたミドルウェアでは、その周りにスコープを置くことはできません。

つまり、サポート担当者がユーザー ID で検索するまさにそのエントリであるエラーログが、ユーザー ID を持たないエントリになります。スコープのミドルウェアを `UseExceptionHandler` より上に移動しても解決しません。認証が実行されるまでユーザーは判明しないからです。

同じ `AsyncLocal` の挙動には、エンリッチャーにない利点もあります。スコープは `ExecutionContext` とともに `Task.Run` やその他の継続に流れるため、リクエスト内で開始された fire-and-forget の処理は、レスポンスの送信後も ID を保持します。

## 各アプローチが実際にタグ付けするもの

認証済みユーザー `u-42` で、各構成の同じアプリに対して 3 つのリクエストを実行しました。ログを出力するエンドポイント、例外をスローするエンドポイント、そしてレスポンス送信の 300 ms 後にログを出力する `Task.Run` を開始するエンドポイントです。出力は `IncludeScopes = true` を指定した `AddJsonConsole` を経由させ、その後 OpenTelemetry のコンソールエクスポーターでも同じことを繰り返しました。

| ログエントリ | ミドルウェアの `BeginScope` | `ILogEnricher` | エンリッチャー + 受け渡し時のスコープ |
| --- | --- | --- | --- |
| "Request starting" (ホスティング) | なし | なし | なし |
| エンドポイント自身の `LogInformation` | あり | あり | あり |
| `ExceptionHandlerMiddleware` のエラー | **なし** | あり | あり |
| "Request finished" (ホスティング) | **なし** | あり | あり |
| レスポンス後の `Task.Run` のログ | あり | **なし** | あり |

"Request starting" は設計上タグ付けできません。認証が実行される前に書き込まれるため、その時点ではユーザーがまだ存在しないからです。リクエストの残りの部分と結び付けるには、共有される `TraceId` を利用してください。

## ステップ 1: エンリッチャーを追加する

ログのエンリッチメントは `dotnet/extensions` ライブラリの一部です。`ILogEnricher` と `AddLogEnricher` は `Microsoft.Extensions.Telemetry.Abstractions` にあり、`EnableEnrichment()` は `Microsoft.Extensions.Telemetry` にあります。後者は抽象化パッケージを参照しているので、パッケージは 1 つで十分です。

```bash
dotnet add package Microsoft.Extensions.Telemetry --version 10.10.0
```

エンリッチャー自体は数行です。

```csharp
// .NET 10, Microsoft.Extensions.Telemetry 10.10.0
using System.Security.Claims;
using Microsoft.Extensions.Diagnostics.Enrichment;

public sealed class UserIdEnricher(IHttpContextAccessor accessor) : ILogEnricher
{
    public void Enrich(IEnrichmentTagCollector collector)
    {
        var userId = accessor.HttpContext?.User.FindFirstValue(ClaimTypes.NameIdentifier);
        if (userId is not null)
        {
            collector.Add("user.id", userId);
        }
    }
}
```

次に `Program.cs` で組み込みます。

```csharp
// .NET 10, ASP.NET Core 10, Microsoft.Extensions.Telemetry 10.10.0
var builder = WebApplication.CreateBuilder(args);

builder.Logging.EnableEnrichment();
builder.Services.AddHttpContextAccessor();
builder.Services.AddLogEnricher<UserIdEnricher>();

builder.Services.AddAuthentication(/* your scheme */);
builder.Services.AddAuthorization();

var app = builder.Build();
app.UseExceptionHandler("/error");
app.UseAuthentication();
app.UseAuthorization();
```

ミドルウェアは不要です。`EnableEnrichment()` は既定の `LoggerFactory` を `Microsoft.Extensions.Telemetry` の拡張版に置き換えます。拡張版は、登録されたすべての `ILogEnricher` をログレコードごとに 1 回呼び出し、タグをレコードの状態に追加します。エンリッチャーはスコープが開かれた時点ではなくログ呼び出しの時点でユーザーを読み取るため、例外ハンドラーやホスティングの診断機能がエントリを書き込むときにもユーザーを見つけられます。`HttpContext` はリクエストが完了するまで生きているからです。

JSON コンソールの出力では、タグは `Scopes` の下ではなく、メッセージテンプレートのパラメーターと並んで `State` に表示されます。

```json
{"EventId":1,"LogLevel":"Error","Category":"Microsoft.AspNetCore.Diagnostics.ExceptionHandlerMiddleware","Message":"An unhandled exception has occurred while executing the request.","State":{"user.id":"u-42","exception.type":"System.InvalidOperationException","{OriginalFormat}":"An unhandled exception has occurred while executing the request."}}
```

これは例外テキストとスコープを省略したものです。無料で付いてくる `exception.type` タグに注目してください。拡張ロガーは例外を持つすべてのレコードにこのタグを追加するため、"このユーザーのすべての失敗を例外の種類ごとにグループ化する" ことが 1 つのクエリで可能になります。

ここで重要な点がいくつかあります。

- `AddLogEnricher<T>` はエンリッチャーを **シングルトン** として登録します (ソースでは `AddSingleton<ILogEnricher, T>()`)。注入するのはシングルトンだけにしてください。`IHttpContextAccessor` は `AsyncLocal` を読み取るシングルトンであり、だからこそ機能します。`DbContext` やリクエストごとのユーザーサービスのようなスコープ付きサービスは、ルートプロバイダーから 1 回だけ取得されて固定されてしまいます。
- 2 回登録すると 2 回実行されます。`TryAddEnumerable` ではなく `AddSingleton` を使っているためです。
- エンリッチャーは、起動処理やバックグラウンドサービスを含め、プロセス内のすべてのログレコードに対して実行されます。アロケーションを発生させないようにし、`HttpContext` が null のときは何もせずに戻るようにしてください。

## ステップ 2: リクエストの境界を越えて ID を運ぶ

`IHttpContextAccessor.HttpContext` はリクエストが終了すると null になるため、エンリッチャーはリクエストより長く生きる処理をタグ付けできません。これが表の最後の行です。リクエストがまだあるうちに ID を取得し、バックグラウンド処理の内側でスコープを開きます。

```csharp
// .NET 10, ASP.NET Core 10
app.MapPost("/reports", (HttpContext ctx, ILogger<Program> log) =>
{
    var userId = ctx.User.FindFirstValue(ClaimTypes.NameIdentifier);

    _ = Task.Run(async () =>
    {
        using var scope = log.BeginScope("user.id:{user.id}", userId);
        await Task.Delay(300);
        log.LogInformation("Background work finished");
    });

    return Results.Accepted();
});
```

この変更により、バックグラウンドの行はスコープ `{"Message":"user.id:u-42","user.id":"u-42"}` 付きで出力され、"Request starting" を除く表のすべての行がタグ付けされました。エンリッチャーと同じキーを使えば、クエリに `OR` が不要になります。

このスニペットについて 2 点補足します。まず、`BeginScope` のメッセージテンプレート版のオーバーロードを使ってください。素の `Dictionary<string, object?>` のスコープも機能しますが、コンソールと OpenTelemetry のエクスポーターはその `ToString()`、つまり ``System.Collections.Generic.Dictionary`2[System.String,System.Object]`` をスコープのメッセージとして出力します。次に、エンドポイントからの `Task.Run` は受け渡しの代役にすぎません。実際の fire-and-forget の処理では、`BackgroundService` にエンキューする作業項目にユーザー ID を載せ、ワーカーがそれをデキューしたときにスコープを開いてください。このパターンと落とし穴については [BackgroundService で fire-and-forget の処理を安全に実行する方法](/ja/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/) で解説しています。

## ステップ 3: シンクに実際に表示されることを確認する

タグがどこに現れるかはプロバイダーによって異なります。

**コンソールフォーマッター。** エンリッチされたタグは状態の一部なので、`AddJsonConsole` は `IncludeScopes = false` でもそれを表示します。ステップ 2 の受け渡し用スコープには `IncludeScopes = true` が必要で、これはすべてのコンソールフォーマッターで既定ではオフです。シンプルなコンソールフォーマッターは状態のプロパティを出力せず、`IncludeScopes` がなければスコープも出力しないため、JSON フォーマッターか本格的なシンクを使ってください。

**OpenTelemetry。** `builder.Logging.AddOpenTelemetry(o => { o.IncludeScopes = true; o.AddConsoleExporter(); })` を使うと、エンリッチされたタグは、エンドポイントのログ、例外ハンドラーのエラー、"Request finished" で通常のログレコード属性 (`LogRecord.Attributes: user.id: u-42`) になり、受け渡し用のスコープは `ScopeValues` 内の `[Scope.3]:UserId: u-42` として届きました。`IncludeScopes = true` がないとスコープの値は破棄されるため、バックグラウンドの行は ID を失います。いずれにせよ OpenTelemetry に移行するのであれば、[Serilog から OpenTelemetry ロギングへの移行](/ja/2026/06/migrate-from-serilog-to-opentelemetry-logging-in-dotnet-11/) でエクスポーター側を解説しています。

**Serilog: 落とし穴。** 私が最も時間を取られたのがこれです。`Serilog.AspNetCore` は `builder.Services.AddSerilog(...)` を推奨しており、これは Serilog 独自の `ILoggerFactory` を登録します。`EnableEnrichment()` も `ILoggerFactory` を置き換えます。最後の登録が勝ち、どちらもそれを知らせてくれません。

| 登録 | 結果 |
| --- | --- |
| `Services.AddSerilog(...)` の後に `EnableEnrichment()` | **ログ出力がまったくない**: 拡張ファクトリーが勝ち、プロバイダーを持たない |
| `EnableEnrichment()` の後に `Services.AddSerilog(...)` | ログは機能するが、エンリッチャーは一度も実行されない。`user.id` はどこにもない |
| `EnableEnrichment()` と `builder.Logging.AddSerilog(logger)` | どちらの順序でも機能する。エンリッチャーが対象とするすべての行に `user.id` が付く |

1 行目は誇張ではありません。アプリはリクエストを処理しながら、stdout には 0 バイトしか書き込みませんでした。機能する組み合わせは、Serilog を Microsoft のファクトリーの下で `ILoggerProvider` として登録するものです。

```csharp
// .NET 10, Serilog.AspNetCore 10.0.0, Microsoft.Extensions.Telemetry 10.10.0
using Serilog;
using Serilog.Formatting.Compact;

var serilog = new LoggerConfiguration()
    .MinimumLevel.Information()
    .Enrich.FromLogContext()
    .WriteTo.Console(new CompactJsonFormatter())
    .CreateLogger();

builder.Logging.ClearProviders();
builder.Logging.AddSerilog(serilog, dispose: true);
builder.Logging.EnableEnrichment();
builder.Services.AddHttpContextAccessor();
builder.Services.AddLogEnricher<UserIdEnricher>();
```

Serilog はエンリッチされたタグを一級の `user.id` プロパティに変換し、`BeginScope` の値も取り込むので、ステップ 2 のスコープはそのまま機能します。代償として、`UseSerilogRequestLogging` が必要とする Serilog の `IDiagnosticContext` を登録するのも `Services.AddSerilog` です。そのミドルウェアに依存している場合は、`Services.AddSerilog` を残して `EnableEnrichment` を使わず、Serilog のやり方で対応してください。`UseAuthentication` の後のミドルウェアで `LogContext.PushProperty("UserId", userId)` を使って ID をプッシュし、`options.EnrichDiagnosticContext = (dc, http) => dc.Set("UserId", http.User.FindFirstValue(ClaimTypes.NameIdentifier))` で完了イベントに追加します。`PushProperty` のミドルウェア単体を計測したところ、`BeginScope` とまったく同じ欠落 (例外ハンドラーのエラーと "Request finished" に ID がない) があったため、診断コンテキストのコールバックが重要になります。Serilog の基本的なセットアップは [Serilog と Seq による構造化ログ](/ja/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) にあります。

## 本番環境で問題になる注意点

**ユーザー ID は個人データです。** GDPR のもとでは、すべてのログ行に付与された安定したアカウント識別子によって、そのログは個人データになり、保持期間や閲覧できる人に影響します。ログに記録するのは不透明な内部 ID にし、メールアドレスや `name` クレームは決して記録しないでください。コンプライアンスチームが求める場合は、ロギング層でハッシュ化または秘匿化してください。.NET の秘匿化機能はプロパティ単位でそれを行えます。[LogProperties で機密値を秘匿化する方法](/ja/2026/08/how-to-redact-sensitive-values-from-logs-with-logproperties-in-dotnet/) を参照してください。

**正しいクレームを選んでください。** `ClaimTypes.NameIdentifier` は ASP.NET Core Identity と Cookie 認証が設定するものです。JWT bearer がトークンの `sub` クレームを `NameIdentifier` にマッピングするのは、`JwtBearerOptions.MapInboundClaims` が `true` (既定値) の間だけです。多くの API は生の JWT クレーム名を保つためにこれをオフにしており、そうするとサブジェクトは `sub` として届き、上記のエンリッチャーは黙って何も記録しません。どちらが来るか確信がない場合は `User.FindFirstValue("sub") ?? User.FindFirstValue(ClaimTypes.NameIdentifier)` を読み取ってください。

**認証は登録より前ではなく、ログ呼び出しより前に実行されている必要があります。** エンリッチャーは `HttpContext.User` を遅延的に読み取るため、認証ミドルウェアがどこにあっても、それが実行された後に記録されたものすべてをタグ付けします。認証サービスが登録されたときに `WebApplication` が追加する自動認証ミドルウェアに頼り、自分で `UseAuthentication` を呼び出していない場合、それはパイプラインの早い段階で実行されるので問題ありません。

**インタラクティブな Blazor と SignalR。** インタラクティブな Blazor Server コンポーネントでは、`IHttpContextAccessor` は現在のユーザーの信頼できる情報源ではありません。ASP.NET Core のドキュメントでも、インタラクティブレンダリングでは使用を避けるよう案内されています。サーキットやハブの呼び出しでは、`AuthenticationStateProvider` または `HubCallerContext.User` からユーザーを取得し、代わりに処理の周りでスコープを開いてください。

**エンリッチャーはレコードごとに実行されるので、軽量に保ってください。** 数個のクレームを検索する程度なら取るに足りませんが、`Enrich` の中でサービスを解決したり、データベースにクエリを発行したり、文字列をアロケートしたりしないでください。値がプロセス全体で一定 (バージョン、リージョン) であれば、1 回だけ実行される `IStaticLogEnricher` を使ってください。

**メッセージテンプレートにも ID を入れないでください。** `LogInformation("User {UserId} loaded orders", userId)` はプロパティを重複させ、キーが異なればクエリが分断されます。テンプレートはイベントについての内容に留めてください。その規律の残りについては [文字列補間からメッセージテンプレートへの移行](/ja/2026/07/migrate-from-ilogger-string-interpolation-to-message-templates-in-dotnet-11/) を参照してください。

### 次に読む

- [.NET 11 で Serilog と Seq を使って構造化ログをセットアップする方法](/ja/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/)
- [.NET 11 で Serilog から OpenTelemetry ロギングに移行する](/ja/2026/06/migrate-from-serilog-to-opentelemetry-logging-in-dotnet-11/)
- [.NET で LogProperties を使ってログから機密値を秘匿化する方法](/ja/2026/08/how-to-redact-sensitive-values-from-logs-with-logproperties-in-dotnet/)
- [ASP.NET Core で BackgroundService を使って fire-and-forget の処理を安全に実行する方法](/ja/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/)

### 出典

- Microsoft Learn の [ログのエンリッチメントの概要](https://learn.microsoft.com/dotnet/core/enrichment/overview) と [カスタムログエンリッチャー](https://learn.microsoft.com/dotnet/core/enrichment/custom-enricher)
- dotnet/extensions の [`EnrichmentServiceCollectionExtensions.cs`](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Telemetry.Abstractions/Enrichment/EnrichmentServiceCollectionExtensions.cs) (シングルトン登録)
- [.NET でのログ記録: ログのスコープ](https://learn.microsoft.com/dotnet/core/extensions/logging#log-scopes)
- [ASP.NET Core で HttpContext にアクセスする](https://learn.microsoft.com/aspnet/core/fundamentals/http-context) (インタラクティブな Blazor に関するガイダンスを含む)
- [Serilog.AspNetCore README](https://github.com/serilog/serilog-aspnetcore)
- [OpenTelemetry .NET のログ: IncludeScopes](https://github.com/open-telemetry/opentelemetry-dotnet/tree/main/docs/logs)
