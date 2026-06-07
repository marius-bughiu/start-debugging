---
title: "ASP.NET Core 11 で MapGroup を使って minimal API のエンドポイントを整理する方法"
description: "ASP.NET Core 11 で MapGroup を使って minimal API を構造化するための完全ガイド。リソースごとのエンドポイントモジュールを拡張メソッドとして書く方法、ネストしたグループ、共有フィルターと認証、ルートパラメーター付きプレフィックス、OpenAPI タグ、そして人を驚かせるフィルターの順序ルールを解説します。"
pubDate: 2026-06-07
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-apis"
lang: "ja"
translationOf: "2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-06-07
---

minimal API が `Program.cs` を `app.MapGet(...)` 呼び出しが千行も並ぶ壁に変えてしまわないようにするには、関連するエンドポイントを `app.MapGroup("/prefix")` でグループ化します。これは `RouteGroupBuilder` を返し、ルートプレフィックスと、それに付与した任意の規約（フィルター、認証、OpenAPI タグ）を共有します。長続きするパターンは、リソースごとに 1 つの拡張メソッドを用意することです。`public static IEndpointRouteBuilder MapTodos(this IEndpointRouteBuilder routes)` が内部で自身のグループを構築し、`Program.cs` は `app.MapTodos();` 呼び出しのリストに縮小します。`MapGroup` は ASP.NET Core 7 以降で安定しており、.NET 11 でも変わりません。以下の内容はすべて `Microsoft.NET.Sdk.Web` と C# 14 を使った .NET 11 を対象にしていますが、API は .NET 8、9、10 でも同一です。

## なぜ Program.cs は腐るのか

minimal API には魅力的なデモが付いてきます。アプリ全体が 1 つのファイルに収まる、というものです。これはサンプルには素晴らしく、実際のサービスにはひどいものです。リソースがいくつか集まり、それぞれが 5 つの CRUD 動詞に加えていくつかのサブルートを持つようになる頃には、`Program.cs` は数百行の route handler が DI の登録、ミドルウェアの配線、`app.Run()` と入り混じったものになっています。編集したい `MapPut` を見つけるために、認証のセットアップを通り過ぎてスクロールすることになります。3 つの handler がすべて `/api/v1/orders` で始まり、そのうちの 1 つはプレフィックスにタイプミスがあって、本番環境で 404 が出るまで誰も気づきません。

解決策は「コントローラーに戻る」ことではありません。コントローラーは規約（リソースごとに 1 クラス、ルーティングは属性で）によって整理を実現しますが、その代償としてリフレクションベースの MVC パイプラインが付いてきます。minimal API はこれを `MapGroup` と素朴な C# の拡張メソッドで解決し、軽量で AOT に優しいエンドポイントモデルを保ちます。2 つのモデルでまだ迷っている場合は、トレードオフが [ASP.NET Core 11 における minimal API とコントローラーの比較](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) にまとめられています。本ガイドは、あなたが minimal API を選び、それをスケールさせたいことを前提としています。

## MapGroup は RouteGroupBuilder を返す

`MapGroup` は `IEndpointRouteBuilder` の拡張メソッドです。ルートプレフィックスを受け取り、`RouteGroupBuilder` を返します。

```csharp
// .NET 11, C# 14
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

RouteGroupBuilder todos = app.MapGroup("/todos");

todos.MapGet("/", () => "all todos");        // GET  /todos/
todos.MapGet("/{id:int}", (int id) => $"todo {id}"); // GET  /todos/42
todos.MapPost("/", () => "created");          // POST /todos/

app.Run();
```

グループ上の各 `Map{Verb}` 呼び出しは `/todos` プレフィックスを継承するため、グループ上に書くパターンは相対的です。`RouteGroupBuilder` は `IEndpointRouteBuilder` を実装しており、これが他のすべてを機能させる要点です。`app` 上で呼べるもの（`MapGroup` 自体を含む）は何でもグループ上で呼べます。こうしてネストは自然に手に入ります。

プレフィックスは単純な連結で結合されます。`app.MapGroup("/api").MapGroup("/v1").MapGet("/todos", ...)` は `GET /api/v1/todos` を登録します。セグメントを繋ぐ以上の正規化の魔法はないので、スラッシュを重複させないでください。グループプレフィックス `/todos/` に handler パターン `/{id}` を足すと `/todos//{id}` になり、期待どおりには一致しません。

## リソースごとに 1 つの拡張メソッド

スケールするパターンは、各リソースに `Map` メソッドを 1 つ持つ独自の静的クラスを与え、そのメソッドに自身のグループを作らせることです。呼び出しを連鎖させるため、戻り値の型は `IEndpointRouteBuilder`（または `RouteGroupBuilder`）にするべきです。

```csharp
// .NET 11, C# 14 -- Endpoints/TodoEndpoints.cs
public static class TodoEndpoints
{
    public static IEndpointRouteBuilder MapTodos(this IEndpointRouteBuilder routes)
    {
        var group = routes.MapGroup("/todos")
            .WithTags("Todos");

        group.MapGet("/", GetAll);
        group.MapGet("/{id:int}", GetById).WithName("GetTodoById");
        group.MapPost("/", Create);
        group.MapPut("/{id:int}", Update);
        group.MapDelete("/{id:int}", Delete);

        return routes;
    }

    private static async Task<Ok<List<Todo>>> GetAll(TodoDb db) =>
        TypedResults.Ok(await db.Todos.ToListAsync());

    private static async Task<Results<Ok<Todo>, NotFound>> GetById(int id, TodoDb db) =>
        await db.Todos.FindAsync(id) is { } todo
            ? TypedResults.Ok(todo)
            : TypedResults.NotFound();

    private static async Task<Created<Todo>> Create(Todo todo, TodoDb db)
    {
        db.Todos.Add(todo);
        await db.SaveChangesAsync();
        return TypedResults.Created($"/todos/{todo.Id}", todo);
    }

    private static async Task<Results<NoContent, NotFound>> Update(int id, Todo input, TodoDb db)
    {
        var todo = await db.Todos.FindAsync(id);
        if (todo is null) return TypedResults.NotFound();
        todo.Title = input.Title;
        todo.Done = input.Done;
        await db.SaveChangesAsync();
        return TypedResults.NoContent();
    }

    private static async Task<Results<NoContent, NotFound>> Delete(int id, TodoDb db)
    {
        var rows = await db.Todos.Where(t => t.Id == id).ExecuteDeleteAsync();
        return rows > 0 ? TypedResults.NoContent() : TypedResults.NotFound();
    }
}
```

これで `Program.cs` は目次になります。

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddDbContext<TodoDb>(o => o.UseSqlServer(/* ... */));
builder.Services.AddOpenApi();

var app = builder.Build();

app.MapTodos();
app.MapOrders();
app.MapCustomers();

app.MapOpenApi();
app.Run();
```

このイディオムを心地よくする点が 2 つあります。第 1 に、handler はラムダではなく名前付きの `private static` メソッドなので、それぞれがスタックトレースに実名を持ち、単体で簡単にテストできます。第 2 に、`MapTodos` から `IEndpointRouteBuilder` を返すことで、望むなら連鎖を続けられます（`app.MapTodos().MapOrders();`）。もっとも、1 行に 1 呼び出しのほうが読みやすいです。

戻り値の型について 1 つ注意があります。あるメソッドの仕事がグループを構築することだけで、*呼び出し側*にそのグループへさらに規約を付与させたいなら、代わりに `RouteGroupBuilder` を返してください。メソッドがエンドポイントを登録し、呼び出し側がその後グループに触れるべきでないなら、`IEndpointRouteBuilder` を返します。この 2 つを混同することが、「なぜ私の `.RequireAuthorization()` はコンパイルできないのか」という混乱の最も一般的な原因です。

## 共有フィルター、認証、メタデータを 1 回の呼び出しで

グループの利点は、グループに適用した規約がその配下のすべてのエンドポイントに適用されることです。ここで `MapGroup` は、20 個の handler に `.RequireAuthorization()` をコピー＆ペーストするのに対して真価を発揮します。

```csharp
// .NET 11, C# 14
var admin = app.MapGroup("/admin")
    .RequireAuthorization("AdminPolicy")   // every endpoint requires the policy
    .WithTags("Admin")                     // one OpenAPI tag for the whole group
    .AddEndpointFilter<AuditFilter>();     // runs for every endpoint in the group

admin.MapGet("/users", ListUsers);
admin.MapDelete("/users/{id:int}", DeleteUser);
```

`RequireAuthorization`、`WithTags`、`WithMetadata`、`RequireRateLimiting`、`AddEndpointFilter`、`AddEndpointFilterFactory` はすべて `IEndpointConventionBuilder` のメソッドであり、`RouteGroupBuilder` がそのインターフェースを実装しているため、すべてがメンバーに流れ下ります。グループ内のルートで分割されたエンドポイントごとのレート制限が必要な場合は、[エンドポイントごとのレート制限ガイド](/2026/04/how-to-add-per-endpoint-rate-limiting-in-aspnetcore-11/) が、`RequireRateLimiting` がグループのポリシーとどう組み合わさるかを扱っています。

心に留めておく価値のある微妙な点が 1 つあります。グループ上の `AddEndpointFilter` はミドルウェアでは**ありません**。プレフィックスへのリクエストごとに 1 回実行されるわけではありません。ビルド時に、各エンドポイントのフィルターパイプラインへ個別に適用されます。実用上の違いは、フィルターはグループ内のエンドポイントが実際に一致したときにのみ実行される、という点です。404 になる `/admin/nonexistent` へのリクエストは `AuditFilter` を決して呼び出しませんが、`/admin` パスセグメント上のミドルウェアなら呼び出します。パスに限定した本物のミドルウェアが欲しい場合は、代わりに `app.UseWhen(ctx => ctx.Request.Path.StartsWithSegments("/admin"), ...)` を使ってください。

## ネストしたグループとプレフィックス内のルートパラメーター

グループ自体が `IEndpointRouteBuilder` であるため、グループ上で `MapGroup` を呼び出すことでネストします。プレフィックスはルートパラメーターと制約を含むことができ、任意の深さの handler は、任意の祖先プレフィックスで宣言されたパラメーターをバインドできます。

```csharp
// .NET 11, C# 14
var orgs = app.MapGroup("/orgs/{orgId:int}");
var projects = orgs.MapGroup("/projects/{projectId:int}");

projects.MapGet("/issues", (int orgId, int projectId) =>
    $"issues for org {orgId}, project {projectId}");
// matches GET /orgs/7/projects/3/issues
```

handler は、それぞれが 1 つ上のレベルで宣言されているにもかかわらず、`orgId` と `projectId` の両方をバインドします。これは階層的なリソースをモデル化するきれいな方法です。URL の各レベルがグループであり、共有されるルート値が各パターンで繰り返されるのではなく構造によって捕捉されるため、末端の handler は短く保たれます。

プレフィックスは空にもできます。`app.MapGroup("")` はパスセグメントを追加しません。これは、URL を変えずに一群のエンドポイントへ規約やフィルターを付与するための手法です。

```csharp
// .NET 11, C# 14
var versioned = app.MapGroup("").WithOpenApi();
var v1 = versioned.MapGroup("/v1");
var v2 = versioned.MapGroup("/v2");
```

## 人がつまずくフィルター順序のルール

フィルターがネストしたグループ上にある場合、実行される順序は、`AddEndpointFilter` 呼び出しを書いた順序ではなく、グループのネストによって、**最も外側が先**に決まります。これはルートグループの最も直感に反する挙動で、文書化されてはいるものの見落としやすいものです。

```csharp
// .NET 11, C# 14
var outer = app.MapGroup("/outer");
var inner = outer.MapGroup("/inner");

inner.AddEndpointFilter((ctx, next) =>
{
    app.Logger.LogInformation("inner group filter");
    return next(ctx);
});

outer.AddEndpointFilter((ctx, next) =>   // added second, runs first
{
    app.Logger.LogInformation("outer group filter");
    return next(ctx);
});

inner.MapGet("/", () => "Hi!").AddEndpointFilter((ctx, next) =>
{
    app.Logger.LogInformation("endpoint filter");
    return next(ctx);
});
```

`/outer/inner/` へのリクエストは、次の順序でログ出力します。

```text
outer group filter
inner group filter
endpoint filter
```

外側のフィルターは 2 番目に追加されたにもかかわらず内側より先に実行されます。フィルターは最も外側のグループから内側へ適用され、エンドポイント自身のフィルターが最後だからです。`AddEndpointFilter` 呼び出しの相対的な順序が重要になるのは、*同じ* builder に付与されている場合だけです。異なるグループ間ではネストが勝ちます。ロギングフィルターより前に実行されなければならない認証スタイルのフィルターがある場合は、ファイル内で単に上に置くのではなく、認証を外側のグループに置いてください。

## グループで minimal API をバージョニングする

ネストしたグループに手を伸ばす一般的な理由が、URL セグメントによる API バージョニングです。各バージョンがグループであり、各リソースモジュールは受け取ったバージョン builder の下に自身をマウントします。

```csharp
// .NET 11, C# 14
public static class TodoEndpoints
{
    public static IEndpointRouteBuilder MapTodos(this IEndpointRouteBuilder routes, int version)
    {
        var group = routes.MapGroup($"/todos").WithTags($"Todos v{version}");
        group.MapGet("/", GetAll);
        // v2-only endpoint
        if (version >= 2) group.MapGet("/search", Search);
        return routes;
    }
}

// Program.cs
var v1 = app.MapGroup("/api/v1");
var v2 = app.MapGroup("/api/v2");

v1.MapTodos(version: 1);
v2.MapTodos(version: 2);
```

手書きの URL バージョニングを超える用途（media-type やヘッダーによるバージョニング、非推奨ヘッダー、version set）には、`Asp.Versioning` パッケージがグループ上の `HasApiVersion` を通じて `MapGroup` と統合されますが、「v1 と v2 のパスプレフィックス」という一般的なケースには、上記の素朴なネストで十分であり、追加の依存関係を一切持ち込みません。

## OpenAPI ドキュメント内でのグループ化

グループ上の `WithTags` が、Swagger UI や Scalar の折りたたみ可能なセクションを生成するものです。グループに 1 回タグを付ければ、各エンドポイントはそのタグの下に収まります。

```csharp
// .NET 11, C# 14
var todos = app.MapGroup("/todos").WithTags("Todos");
```

タグがない場合、組み込みの OpenAPI ジェネレーターは最初のルートセグメントをタグとして使うフォールバックに頼ります。これはたいてい機能しますが、プレフィックスのリファクタリングが API のセクション名を黙って変えてしまわないよう、明示的に設定する価値があります。仕様で認証フローも公開する場合は、グループはセキュリティ要件を付与するのに適した場所で、各操作にそれが表示されるようになります。`WithOpenApi` とセキュリティスキームの配線については [.NET 11 で OpenAPI 認証フローを Swagger UI に追加する](/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/) を参照してください。

## リファクタリング前に知っておくと良い落とし穴

フラットなファイルを初めてグループに再構成するときにぶつかりやすい鋭い角がいくつかあります。

- **`MapGroup` は builder 上で呼ばねばならず、`app.Run()` の後ではいけません。** すべてのエンドポイント登録と同様、アプリがリクエストの処理を開始する前に行う必要があります。request handler の中からグループを追加しても何も起きません。
- **グループプレフィックスはパス全体に対する制約ではありません。** `MapGroup("/api")` は、別の場所にあるトップレベルの `MapGet("/api/...")` 呼び出しが一致することを妨げません。グループは、あなたがそれを*通じて*登録したエンドポイントだけを支配します。
- **グループ上の `RequireAuthorization()` は加算的であり、上書きではありません。** 内側のグループやエンドポイントも別のポリシーで `RequireAuthorization` を呼ぶ場合、両方のポリシーが適用されます（リクエストはすべてを満たす必要があります）。「内側が勝つ」という意味論はありません。
- **`AddEndpointFilterFactory` はビルド時に、エンドポイントごとに 1 回実行され、リクエストごとではありません。** ファクトリーは `MethodInfo` を検査し、実際のリクエストごとのデリゲートを返します。コストの高いリクエストごとのロジックを（返されるデリゲートではなく）ファクトリー本体に置くと、リクエスト時には決して実行されません。これは、ドキュメントがエンドポイントのグループに対して `DbContext` をプライベートクエリモードに切り替えるのに使うのと同じファクトリーパターンです。
- **Native AOT はこれらすべてで問題なく動作します。** グループ、拡張メソッドによるモジュール、フィルターはすべて AOT に優しい minimal API の表面の一部であり、どれもリフレクションへのフォールバックを強制しません。トリミングや AOT で発行する場合は、グループ化された handler をきれいにソース生成させる request delegate ジェネレーターの詳細について [ASP.NET Core minimal API で Native AOT を使う](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) を参照してください。

持ち帰るべきメンタルモデルはこうです。`RouteGroupBuilder` は、記憶されたプレフィックスと記憶された規約のセットを持つだけの `IEndpointRouteBuilder` です。あらゆる整理の技、モジュール化、ネスト、バージョニング、共有認証、はこの 1 つの事実から導かれます。まずリソースごとに 1 つの `MapXxx` 拡張メソッドを抽出し、`Program.cs` を呼び出しのリストに畳み込み、URL 階層が本当にネストするときにだけネストしたグループに手を伸ばしてください。

## 関連

- [ASP.NET Core 11 における minimal API とコントローラーの比較](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)。2 つのエンドポイントモデルでまだ迷っている場合に。
- [ASP.NET Core 11 でグローバル例外フィルターを追加する](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/)。グループ化されたすべてのエンドポイントの例外を 1 か所で捕捉するために。
- [ASP.NET Core 11 でエンドポイントごとのレート制限を追加する](/2026/04/how-to-add-per-endpoint-rate-limiting-in-aspnetcore-11/)。`RequireRateLimiting` をグループポリシーと組み合わせるために。
- [.NET 11 で OpenAPI 認証フローを Swagger UI に追加する](/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/)。グループのタグにセキュリティスキームを付与するために。
- [ASP.NET Core minimal API で Native AOT を使う](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/)。グループ化されたエンドポイントをトリミングおよび AOT で発行するために。

## 出典

- Microsoft Learn, [Route handlers in Minimal API apps](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/route-handlers?view=aspnetcore-10.0)（ルートグループ、ネスト、フィルター順序）。
- Microsoft Learn, [Filters in Minimal API apps](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/min-api-filters?view=aspnetcore-10.0)（`AddEndpointFilter`、`AddEndpointFilterFactory`）。
- Microsoft Learn, [Organizing ASP.NET Core Minimal APIs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/organizing-apis?view=aspnetcore-10.0)。
- API リファレンス, [EndpointRouteBuilderExtensions.MapGroup](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.builder.endpointroutebuilderextensions.mapgroup)。
