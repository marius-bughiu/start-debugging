---
title: "MapGroup で Minimal API のエンドポイントを整理する"
description: "リソース別の拡張メソッドと MapGroup で Minimal API を整理。入れ子のルート、メタデータ、フィルター、認証、テストを説明。"
pubDate: 2026-06-07
updatedDate: 2026-11-02
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

`MapGroup` はルートの共通プレフィックスとエンドポイント規約をまとめます。ASP.NET Core 7 から利用できます。リソースごとの拡張メソッドにすると、コントローラーを導入せず `Program.cs` からルート登録を切り出せます。

**訂正 — 2026 年 11 月 2 日：** 以前の版はスラッシュの結合を単純な文字列連結と説明し、`WebApplication` の全 API をグループで使えるとしていました。修正例は SDK 10.0.302 を使用し、.NET 11 の実行確認を示すものではありません。

## 完全なリソースモジュール

```csharp
// Program.cs in a Microsoft.NET.Sdk.Web project targeting net10.0.
using System.Collections.Concurrent;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Routing;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton<TodoStore>();
var app = builder.Build();

app.MapGroup("/api").MapTodos();
app.Run();

public static class TodoEndpoints
{
    public static RouteGroupBuilder MapTodos(this IEndpointRouteBuilder routes)
    {
        var group = routes.MapGroup("/todos/").WithTags("Todos");
        group.MapGet("/{id:int}", GetTodo).WithName("GetTodo");
        group.MapPut("/{id:int}", PutTodo);
        return group;
    }

    private static Results<Ok<Todo>, NotFound> GetTodo(int id, TodoStore store) =>
        store.Items.TryGetValue(id, out var todo)
            ? TypedResults.Ok(todo)
            : TypedResults.NotFound();

    private static NoContent PutTodo(int id, Todo todo, TodoStore store)
    {
        store.Items[id] = todo;
        return TypedResults.NoContent();
    }
}

public sealed class TodoStore
{
    public ConcurrentDictionary<int, Todo> Items { get; } = new(
        new[] { new KeyValuePair<int, Todo>(1, new Todo("Write docs", false)) });
}

public record Todo(string Title, bool IsComplete);
```

`GET /api/todos/1` と `PUT /api/todos/{id}` を提供します。メモリ内ストアはデモ用で、再起動後には残りません。SDK 10 のルート合成では `/todos/` と `/{id:int}` を結合しても `/todos//{id:int}` にはなりません。表記は統一すべきですが、文字列連結だけでルートを判断しないでください。

クラスは同じプロジェクトの別ファイルに移せます。ファイル位置だけでリクエストデリゲート生成の実行が決まるわけではありません。private ハンドラーを別のテストアセンブリから直接呼ぶことはできないため、HTTP 経由でテストするか、業務処理を独立したサービスに分けます。

## グループが提供する機能

`RouteGroupBuilder` は `IEndpointRouteBuilder` と `IEndpointConventionBuilder` を実装し、ルートの入れ子や `WithTags`、`RequireAuthorization`、フィルターを扱います。`WebApplication` の全 API ではありません。`Use...` ミドルウェアやホストの寿命はアプリケーション側で扱います。

明示的なタグは OpenAPI の分類を制御しますが、ドキュメントを生成・公開しません。バージョンに応じて別途設定します。エンドポイント名はアプリケーション全体で一意にします。

入れ子のプレフィックスは合成され、外側のルート引数を内側のハンドラーにバインドできます。外側のフィルターが内側やエンドポイントのフィルターを包みます。`await next(context)` より前はハンドラーに向かう順、後は逆順です。同一グループ内の登録順も重要です。

## ポリシーを設定する

`RequireAuthorization("policy")` はメタデータを追加するだけで、ポリシー、認証ハンドラー、資格情報を作成しません。適切なサービスとミドルウェアを設定します。`/v1` というプレフィックスも、それだけで完全な API バージョニングにはなりません。

入力検証は[組み込み検証と FluentValidation の比較](/ja/2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11/)を参照してください。Native AOT はルートの整理だけでなくハンドラー、シリアライザー、依存関係にも左右されるため、[AOT ガイド](/ja/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/)を確認してください。

## 出典

- [ASP.NET Core route handlers and route groups](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/route-handlers?view=aspnetcore-10.0#route-groups)
- [Endpoint filters](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/min-api-filters?view=aspnetcore-10.0)
- [RoutePatternFactory.Combine source, .NET 10](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Http/Routing/src/Patterns/RoutePatternFactory.cs)
- [Minimal API security](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/security?view=aspnetcore-10.0)
