---
title: "System.Web.HttpContext から Microsoft.AspNetCore.Http.HttpContext へ移行する"
description: "ASP.NET Framework の System.Web.HttpContext から ASP.NET Core 11 の HttpContext への実践的な移行: HttpContext.Current、プロパティ対応表、Server.MapPath、Session、そして段階的移行のための System.Web アダプターの互換シム。"
pubDate: 2026-06-06
updatedDate: 2026-06-06
template: migration
tags:
  - "migration"
  - "aspnetcore-11"
  - "dotnet-11"
  - "httpcontext"
  - "system-web"
lang: "ja"
translationOf: "2026/06/migrate-from-system-web-httpcontext-to-aspnetcore-httpcontext"
translatedBy: "claude"
translationDate: 2026-06-06
---

ASP.NET Framework の移行を他のどれよりも多く壊す 1 行は `HttpContext.Current` です。これは ASP.NET Core には存在しません。任意のクラスから手を伸ばせる静的なアンビエントコンテキストはなく、`HttpContext` 型は別の名前空間にある別の型であり (`System.Web.HttpContext` ではなく `Microsoft.AspNetCore.Http.HttpContext`)、依存していたプロパティのほとんどは移動したか、形が変わったか、なくなりました。この記事では .NET 11 / ASP.NET Core 11 における古い API を新しい API に対応づけ、続いて現実的な 2 つの前進の道を示します。自分が管理するコードのためのクリーンな書き直しと、`HttpContext` を渡し回す共有ライブラリの山があって一度に書き直せない場合の公式 `System.Web` アダプターです。

小さなハンドラーや 1 つのコントローラーであれば、書き直しは 1 時間です。`HttpContext.Current` が別のアセンブリにあるビジネス層を貫いて通っているモノリスでは、数日を見込み、アプリケーションごとに移行する間もライブラリが両方のフレームワークに対してコンパイルされ続けるようにアダプターに頼ってください。HTTP のセマンティクスは何も変わりません。変わるのは、リクエストにどう到達するか、ライフタイムが今や厳密にリクエストに紐づくこと、そして頼れるスレッドアフィニティがないことです。

## なぜこの移行が検索と置換ではないのか

`System.Web.HttpContext` と `Microsoft.AspNetCore.Http.HttpContext` は本当に異なるオブジェクトであり、その差は見た目だけでなく動作上のものです:

- **`HttpContext.Current` はなくなりました。** ASP.NET Framework は各リクエストにスレッドアフィニティを与えていたため、静的アクセサーは現在のスレッドから正しいコンテキストを見つけられました。ASP.NET Core はそのような保証をしないため、静的に読み取れる同等のものはありません。代わりにコンテキストを注入します。
- **コンテキストはリクエストを超えて生存できません。** ASP.NET Core ではコンテキストはリクエストの終わりにリサイクルされます。その後でそれに触れると (fire-and-forget タスクで捕捉した参照、キャッシュしたフィールド) `ObjectDisposedException` がスローされます。Framework ではこれが偶然「動いて」しまうことがよくありました。
- **スレッドアフィニティがありません。** 1 つのリクエストが `await` のポイントをまたいでスレッドを移ることがあります。`HttpContext` を並行に読み書きすることは、今やあなたが所有する競合状態です。
- **読み書きが非同期になります。** `Response.Write` は `await Response.WriteAsync` になります。フォームやボディを読むのは `await ReadFormAsync()` / ストリームの読み取りです。レスポンスのヘッダーと cookie はレスポンスが開始する前に設定しなければなりません。

Microsoft 自身の [HttpContext 移行ガイド](https://learn.microsoft.com/en-us/aspnet/core/migration/fx-to-core/areas/http-context?view=aspnetcore-10.0) はこれを 2 つの戦略として位置づけており、その選択が以下のすべてを左右します。完全な書き直しか、段階的な移動のための `System.Web` アダプターかです。

## 何が壊れるか

| 領域 | ASP.NET Framework | ASP.NET Core 11 | 深刻度 |
| --- | --- | --- | --- |
| アンビエントコンテキスト | `HttpContext.Current` | `IHttpContextAccessor` (`AddHttpContextAccessor` で登録) | 高 |
| コンテキストのライフタイム | リクエスト後も時々使える | リクエスト終了後は `ObjectDisposedException` | 高 |
| スレッド安全性 | スレッドアフィニティのあるリクエスト | `await` をまたいでスレッドアフィニティなし | 高 |
| レスポンスへの書き込み | `Response.Write(s)` | `await Response.WriteAsync(s)` | 中 |
| フォーム / ボディの読み取り | `Request.Form`、`Request.InputStream` (sync) | `await Request.ReadFormAsync()`、`Request.Body` (一度だけ読める) | 中 |
| レスポンスヘッダー / cookie | いつでも設定可能 | レスポンス開始前に設定 (または `OnStarting` 経由) | 中 |
| 物理パス | `Server.MapPath("~/x")` | `IWebHostEnvironment.ContentRootPath` / `WebRootPath` + `Path.Combine` | 中 |
| Session | `Session["k"]`、自動シリアライズ、ロックあり | `HttpContext.Session.GetString/SetString`、バイトベース、ロックなし | 中 |
| HTML エンコード | `Server.HtmlEncode` | `System.Net.WebUtility.HtmlEncode` / `HtmlEncoder` | 低 |
| リクエスト URL | `Request.Url`、`Request.RawUrl` | `Request.Scheme/Host/Path/QueryString` または `GetDisplayUrl()` | 低 |

## 事前チェックリスト

- .NET 11 SDK をインストールします (`dotnet --version` が `11.x` を報告)。Web プロジェクトで `<TargetFramework>net11.0</TargetFramework>` を固定します。
- すべての `HttpContext.Current` 参照を棚卸しします。ソリューション全体に対する `grep -rn "HttpContext.Current"` が正直な規模見積もりです。
- `Server.MapPath`、`Session[`、`Request.Url`、`Response.Write`、`Request.ServerVariables` を棚卸しします。これらは第 2 階層の違反者です。
- アセンブリごとに決定します。ネイティブ ASP.NET Core に書き直すか、`System.Web.HttpContext` を維持してアダプターパッケージを追加するかです。まだ移行していない Framework アプリケーションを引き続き提供しなければならない共有ライブラリはアダプターの候補です。
- 何かに触れる前に、グリーンなテストスイートを用意します。移行は機械的であり、通過するスイートはそれを正直に保つ手段です。

## 移行手順

### 手順 1: アクセサーを登録し、HttpContext.Current に手を伸ばすのをやめる

アンビエントアクセスを明示的な注入で置き換えます。`Program.cs` で:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers();
builder.Services.AddHttpContextAccessor(); // enables IHttpContextAccessor

var app = builder.Build();
app.MapControllers();
app.Run();
```

以前 `HttpContext.Current` を読んでいたサービスは、今や `IHttpContextAccessor` を受け取ります:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
public sealed class CurrentUserService(IHttpContextAccessor accessor)
{
    public string? UserId =>
        accessor.HttpContext?.User.FindFirst("sub")?.Value;
}
```

`accessor.HttpContext` をフィールドにキャッシュしないでください。毎回使用する箇所で読み取ってください。なぜなら、フィールドはあるリクエストのコンテキストを捕捉して別のリクエスト、あるいはどのリクエストでもないものに渡してしまうからです。コントローラーや minimal API の中では、すでに `HttpContext` がプロパティまたはパラメーターとして手に入るので、明示的に渡すことを優先し、アクセサーは完全に省いてください。

**検証:** ソリューションが書き直したプロジェクトで `System.Web` への参照なしでコンパイルされ、`CurrentUserService` を行使するリクエストが期待されるユーザー ID を返すこと。

### 手順 2: リクエストのプロパティを変換する

ほとんどの `Request` メンバーは消えたのではなく移動しました。一般的なケースをカバーする対応:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
string method      = httpContext.Request.Method;          // was HttpMethod
bool   isHttps     = httpContext.Request.IsHttps;         // was IsSecureConnection
string? remoteIp   = httpContext.Connection.RemoteIpAddress?.ToString(); // was UserHostAddress
string userAgent   = httpContext.Request.Headers.UserAgent.ToString();

// Query string: IQueryCollection, indexer never throws on a missing key
string q = httpContext.Request.Query["key"].ToString(); // "" if absent

// Full URL: no single Request.Url anymore
// using Microsoft.AspNetCore.Http.Extensions;
string url = httpContext.Request.GetDisplayUrl();
```

フォームやボディの読み取りは非同期であり、ボディは一度だけ読める前方専用のストリームです:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
if (httpContext.Request.HasFormContentType)
{
    IFormCollection form = await httpContext.Request.ReadFormAsync();
    string firstName = form["firstname"].ToString();
}
```

**検証:** query、フォーム、ヘッダーを読むエンドポイントを叩き、値が同じリクエストに対して Framework アプリケーションが返していたものと一致することを確認します。

### 手順 3: レスポンスを変換し、ヘッダーをいつ設定できるかを尊重する

書き込みは非同期であり、ヘッダーと cookie はボディが流れ始める前に設定しなければなりません:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
httpContext.Response.StatusCode = StatusCodes.Status200OK;
httpContext.Response.ContentType = "application/json";
httpContext.Response.Headers["X-Custom"] = "value"; // before first write
await httpContext.Response.WriteAsync(payload);
```

middleware の中にいて、レスポンスが送信される直前にヘッダーを設定する必要がある場合は、遅れて設定するのではなくコールバックを使います:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
httpContext.Response.OnStarting(static state =>
{
    var ctx = (HttpContext)state;
    ctx.Response.Headers["X-Late"] = "value";
    return Task.CompletedTask;
}, httpContext);
```

**検証:** `curl -i` でレスポンスヘッダーを確認し、ヘッダーが存在し、負荷下で `response has already started` 例外が出ないことを確かめます。

### 手順 4: Server.MapPath を IWebHostEnvironment で置き換える

`Server.MapPath("~/App_Data/x.json")` には同等品がありません。`IWebHostEnvironment` を注入し、パスは自分で組み立てます:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
public sealed class FileService(IWebHostEnvironment env)
{
    public string DataPath(string name) =>
        Path.Combine(env.ContentRootPath, "App_Data", name); // project root
    public string AssetPath(string name) =>
        Path.Combine(env.WebRootPath, name);                 // wwwroot
}
```

`ContentRootPath` はプロジェクトルート (旧 `~/`)、`WebRootPath` は `wwwroot` (旧静的ファイルルート) です。HTML エンコードについては、`Server.HtmlEncode` は `System.Net.WebUtility.HtmlEncode` か、DI では注入された `HtmlEncoder` になります。

**検証:** ファイルを読み込むリクエストが、Windows でも Linux でも期待どおりの同じ絶対パスに解決されること (`Path.Combine` がポータブルに保ちます)。

### 手順 5: Session を移すが、振る舞いが異なることを知っておく

ASP.NET Core の session はオプトインで、バイトベースであり、自動シリアライズされず、リクエストごとのロックも提供しません。登録します:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
builder.Services.AddDistributedMemoryCache();
builder.Services.AddSession();
// ...
app.UseSession(); // before endpoints
```

次にインデクサーを型付きヘルパーに置き換えます:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
httpContext.Session.SetString("user", "marius"); // was Session["user"] = "marius"
string? user = httpContext.Session.GetString("user");
httpContext.Session.SetInt32("count", 3);
```

オブジェクトを保存するということは、自分でシリアライズして (例えば `System.Text.Json` で) `SetString` を呼ぶことを意味します。Framework が持っていたような自動のオブジェクト session はありません。session のロックに依存していたなら、[session 移行ガイド](https://learn.microsoft.com/en-us/aspnet/core/migration/fx-to-core/areas/session?view=aspnetcore-9.0) を読む価値があります。

**検証:** あるリクエストで値を設定し、次のリクエストで読み戻します。同じ session cookie で複数のリクエストをまたいで生き残ることを確認します。

## 書き直しが大きすぎるとき: System.Web アダプター

`HttpContext` が、まだ移行していない Framework アプリケーションも呼び出すクラスライブラリ群に織り込まれている場合、すべてのシグネチャを一度に書き直すのは現実的ではありません。Microsoft はまさにこのために [System.Web アダプター](https://learn.microsoft.com/en-us/aspnet/core/migration/fx-to-core/inc/systemweb-adapters?view=aspnetcore-10.0) を提供しています。これらは `System.Web.HttpContext` の形を ASP.NET Core のコンテキストの上に再実装するので、ライブラリは `netstandard2.0` をターゲットにして両方のランタイムを提供できます。

目にするパッケージ:

- `Microsoft.AspNetCore.SystemWebAdapters`: シム本体で、共有ライブラリから参照されます。.NET Standard 2.0、.NET Framework 4.5+、.NET 5+ をターゲットにします。
- `Microsoft.AspNetCore.SystemWebAdapters.CoreServices`: 振る舞いを構成するために ASP.NET Core アプリケーションから参照されます。.NET 6+ をターゲットにします。
- `Microsoft.AspNetCore.SystemWebAdapters.FrameworkServices`: 段階的移行の間、Framework アプリケーションから参照されます。

ASP.NET Core アプリケーションでオプトインします:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
builder.Services.AddSystemWebAdapters();
// ...
app.UseSystemWebAdapters();
```

`System.Web.HttpContext` を受け取っていたライブラリは、`System.Web` への参照をアダプターパッケージに置き換えた後もコンパイルされ続けます。リクエスト内で 2 つの表現を変換するには、キャッシュされた変換を使います。これにより、対象を絞った呼び出し箇所を段階的に書き直せます:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
// Microsoft.AspNetCore.Http.HttpContext -> System.Web.HttpContext
System.Web.HttpContext legacy = coreContext.AsSystemWeb();
// System.Web.HttpContext -> Microsoft.AspNetCore.Http.HttpContext
HttpContext core = legacy.AsAspNetCore();
```

アダプターは無料ではありません。ネイティブ API に比べてオーバーヘッドを追加し、すべてのメンバーがサポートされているわけではなく、ASP.NET Core がデフォルトで提供しないため 2 つの振る舞いはオプトインが必要です。シーク可能で完全にバッファリングされたリクエストストリーム (`PreBufferRequestStream`) と、バッファリングされたレスポンス (`BufferResponseStream`) です。ライブラリがボディを 2 回読むか `Response.End()` に依存している場合は、該当するエンドポイントでこれらを有効にします:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
app.MapDefaultControllerRoute()
   .PreBufferRequestStream()
   .BufferResponseStream();
```

## 検証

移行後、このリストを一通り確認します:

- `dotnet build` が、書き直したプロジェクトで `System.Web` に関する警告を報告しないこと。
- `dotnet test` が、スキップされた HTTP コンテキストのテストなしで通過すること。
- ホットパスのスモークテスト: ログイン (`HttpContext.User` 経由の claims)、フォームの POST、ファイルのダウンロード、session の往復。
- 短い負荷テストを行い、`ObjectDisposedException` や `response has already started` に注意します。これら 2 つの例外は、捕捉したコンテキストのバグ、または遅延したヘッダー書き込みのサインです。

## ロールバック

これはコードの移行であり、データの移行ではないので、ロールバックはブランチの `git revert` です。注意すべき唯一の点は session 状態の形式です。ASP.NET Core の session は ASP.NET Framework の session とワイヤー互換ではないため、本番トラフィックを切り替えてユーザーがアクティブな session を持っている場合、ロールバックはそれらの session を破棄し、再ログインを強制します。それらを排出するか、受け入れてください。ここの他のものは一方通行ではありません。

## 始める前に知っておく価値のある落とし穴

- **バックグラウンド作業で捕捉した `HttpContext`。** 最も一般的な本番障害: コントローラーが `Task.Run(() => DoWork(HttpContext))` を起動し、`DoWork` がそれを読む頃にはコンテキストはすでに破棄されています。必要なものを先にプレーンなオブジェクトにコピーしてください。これは fire-and-forget コードで EF Core の `DbContext` を噛む、破棄済みコンテキストの同じ罠です。
- **`accessor.HttpContext` はリクエスト外では null です。** hosted service や起動タスクではリクエストがないので、アクセサーは null を返します。これは正しく、バグではありません。バックグラウンドサービスには独自の [scoped サービスのパターン](/ja/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/) があります。
- **ボディを 2 回読む。** `Request.Body` は前方専用です。モデルバインディングがすでに消費していれば、後の読み取りは何も得られません。`EnableBuffering()` かアダプターの `PreBufferRequestStream` を使います。同期読み取りも、許可しない限り例外をスローします。これは [synchronous operations are disallowed](/ja/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed/) 例外の背後にある同じ根本原因です。
- **DI の登録順序。** `IHttpContextAccessor` を必要とするサービスがそれを解決できない場合、`AddHttpContextAccessor()` を忘れています。これはおなじみの [unable to resolve service for type](/ja/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/) エラーとして現れます。

これをより広いフレームワーク移行の一部として行う場合、これはより大きな [.NET Framework 4.8 から .NET 11 への移行](/ja/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/) の中に収まり、[IWebHostBuilder から WebApplication.CreateBuilder への移行](/ja/2026/06/migrate-from-iwebhostbuilder-to-webapplication-createbuilder/) を行う同じ工程で、ホスティングモデルもおそらく置き換えることになります。移行中に書く新しいエンドポイントについては、古いコントローラーの形をそのまま移植する前に、[minimal API 対コントローラー](/ja/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) のトレードオフを比較検討する価値があります。

## 出典

- [ASP.NET Framework の HttpContext を ASP.NET Core に移行する (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/migration/fx-to-core/areas/http-context?view=aspnetcore-10.0)
- [System.Web アダプター (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/migration/fx-to-core/inc/systemweb-adapters?view=aspnetcore-10.0)
- [ASP.NET Core で HttpContext にアクセスする (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/http-context?view=aspnetcore-10.0)
- [ASP.NET から ASP.NET Core への session 状態の移行 (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/migration/fx-to-core/areas/session?view=aspnetcore-9.0)
- [dotnet/systemweb-adapters (GitHub)](https://github.com/dotnet/systemweb-adapters)
