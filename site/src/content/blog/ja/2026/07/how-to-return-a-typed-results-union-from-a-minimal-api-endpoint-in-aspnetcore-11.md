---
title: "ASP.NET Core 11 の minimal API エンドポイントから型付き Results<T1, T2> ユニオンを返す方法"
description: "ハンドラーの戻り値の型を Results<Ok<T>, NotFound> と宣言し、TypedResults.Ok / TypedResults.NotFound を返します。ユニオンはハンドラーが宣言したものだけを返すことをコンパイル時にチェックし、OpenAPI に対して自己記述するため、.Produces を手書きする必要がありません。非同期ハンドラー、6 型の上限、ASP.NET Core 11 でのテストを扱います。"
pubDate: 2026-07-14
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-apis"
  - "openapi"
lang: "ja"
translationOf: "2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-14
---

minimal API エンドポイントが複数の形で応答できる場合、たとえばエンティティを伴う `200 OK` か、存在しないときの `404 Not Found` のような場合、つい手が伸びるのはハンドラーを `IResult` を返すものとして宣言し、`Results.Ok(...)` や `Results.NotFound()` を呼ぶやり方です。これはコンパイルは通りますが、`IResult` が運べない 2 つのものを捨ててしまいます。コンパイラーはもう、意図したリザルトだけを返しているかをチェックしませんし、OpenAPI はエンドポイントに `.Produces(404)` を手書きしない限り、`404` が起こりうることすら知りません。解決策は `Microsoft.AspNetCore.Http.HttpResults` の `Results<TResult1, TResult2, ...>` ユニオン型です。ハンドラーを `Results<Ok<Todo>, NotFound>` と宣言し、具体的な値 `TypedResults.Ok(todo)` と `TypedResults.NotFound()` を返せば、ユニオンは OpenAPI に対して自己記述し、その一方でコンパイラーは列挙していないものを返すあらゆる分岐を却下します。以下はすべて `Microsoft.NET.Sdk.Web` と C# 14 を用いた .NET 11 を対象とします。ユニオンは .NET 7 以来まったく同じ挙動なので、同じコードは .NET 10 GA でも変更なしに動作します。

## なぜ IResult は OpenAPI メタデータを失うのか

多くの人が最初に書くバージョンから始めましょう。ハンドラーが `IResult` を返すのは、それが両方の分岐に合う唯一の型だからです。

```csharp
// .NET 11, C# 14 -- Program.cs
app.MapGet("/todos/{id}", async (int id, TodoDb db) =>
{
    var todo = await db.Todos.FindAsync(id);
    return todo is null
        ? Results.NotFound()
        : Results.Ok(todo);
});
```

これは実行時には動作しますし、それこそ `Results` が存在する理由です。静的クラス `Results` のすべてのヘルパーは `IResult` を返すので、分岐が `200` と `404` を生み出す場合でも、コンパイラーは喜んで `IResult` をデリゲートの戻り値の型として推論します。そのコストは OpenAPI ドキュメントに現れます。フレームワークは仕様のレスポンスセクションを構築するために宣言された戻り値の型を調べますが、見えるのは `IResult` だけであり、これはステータスコードやペイロードについて何も語らないインターフェースです。Swagger UI は文書化されていない単一の `200` を表示し、`404` はまったく表示しません。正確な仕様を得るには、エンドポイントを手書きで注釈する必要があります。

```csharp
// .NET 11, C# 14 -- the manual annotation IResult forces on you
app.MapGet("/todos/{id}", async (int id, TodoDb db) =>
{
    var todo = await db.Todos.FindAsync(id);
    return todo is null ? Results.NotFound() : Results.Ok(todo);
})
.Produces<Todo>(StatusCodes.Status200OK)
.Produces(StatusCodes.Status404NotFound);
```

これらの `.Produces` 呼び出しは純粋な重複です。ハンドラー本体がすでに決めていることを言い直しているだけで、両者を同期させるものは何もありません。半年後に `400` の分岐を追加しても、仕様は依然としてエンドポイントが `200` か `404` しか返さないと主張します。メタデータが、それを生み出すコードとは別の場所に存在するからです。まさにこのずれを、型付きユニオンは取り除きます。

## ユニオンを宣言し、TypedResults を返す

静的クラス `TypedResults` は `Results` の型付きの双子です。`Results.Ok(x)` が `IResult` を返すのに対し、`TypedResults.Ok(x)` は `Microsoft.AspNetCore.Http.HttpResults` 名前空間の具体的な `Ok<T>` を返し、`TypedResults.NotFound()` は `NotFound` を返します。これらの具体型はそれぞれ `IEndpointMetadataProvider` を実装しているので、それぞれが自分を OpenAPI に対してどう記述するかを知っています。`Results<TResult1, TResult2>` 型はそれらを 1 つの宣言された戻り値の型に束ねます。上のエンドポイントを変換するのは 3 ステップです。

1. **ハンドラーの戻り値の型をユニオンとして宣言します。** ハンドラーが生み出しうるすべてのリザルトを、順不同で列挙します: `Results<Ok<Todo>, NotFound>`。非同期ハンドラーの場合は `Task<>` で包みます: `async Task<Results<Ok<Todo>, NotFound>>`。
2. **`Results` ではなく `TypedResults` のヘルパーを返します。** `Results.Ok` を `TypedResults.Ok` に、`Results.NotFound` を `TypedResults.NotFound` に置き換えます。それぞれが具体的な実装型を返します。
3. **`.Produces` 呼び出しを削除します。** メタデータは今やユニオンが運ぶので、手書きの注釈は冗長であり、取り除くべきです。さもないと古びていきます。

変換後のエンドポイントは次のとおりです。

```csharp
// .NET 11, C# 14 -- Program.cs
using Microsoft.AspNetCore.Http.HttpResults;

app.MapGet("/todos/{id}", async Task<Results<Ok<Todo>, NotFound>> (int id, TodoDb db) =>
{
    var todo = await db.Todos.FindAsync(id);
    return todo is null
        ? TypedResults.NotFound()
        : TypedResults.Ok(todo);
});
```

`.Produces` はなく、OpenAPI ドキュメントは今や `Todo` スキーマを伴う `200` と、本体のない `404` を列挙します。いずれも戻り値の型から直接生成されたものです。公式ドキュメントはトレードオフをはっきり述べています。ユニオンを伴う `TypedResults` の使用は `IResult` を返すより冗長ですが、"but that's the trade-off for having the type information be statically available and thus capable of self-describing to OpenAPI" というわけです。[ASP.NET Core 11 で Swashbuckle なしに OpenAPI を公開する方法](/ja/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/) で扱った組み込みの OpenAPI ドキュメントジェネレーターを動かしていれば、このメタデータは追加設定なしで生成された JSON に流れ込みます。

## ユニオンが実際にどうコンパイルされるか

これを苦痛ではなく快適にしているのは暗黙変換です。`Results<Ok<Todo>, NotFound>` は、その各ジェネリック引数からユニオン自身への暗黙のキャスト演算子を定義します。ハンドラーが `Ok<Todo>` である `TypedResults.Ok(todo)` を返すと、コンパイラーはそれを暗黙的にユニオンへ変換します。自分で `Results<...>` を構築することも、キャストを書くこともありません。具体的なリザルトを返せば、変換は目に見えません。だから例の三項演算子は動くのです。両方の分岐がユニオンに吸収できる型を生み出すので、式全体がユニオンとして型付けされます。

コンパイル時の安全性もここから来ます。ユニオンは列挙した型からの変換しか定義しないので、それ以外を返すのは実行時の驚きではなくコンパイルエラーです。`BadRequest` をユニオンに追加せずに `TypedResults.BadRequest()` を返す分岐を加えると、ビルドは失敗します。

```csharp
// .NET 11, C# 14 -- does NOT compile
app.MapGet("/orders/{id}", Results<Ok<Order>, NotFound> (int id) =>
{
    if (id < 0)
        return TypedResults.BadRequest();   // error: BadRequest is not in the union
    return id > 999 ? TypedResults.NotFound() : TypedResults.Ok(new Order(id));
});
```

コンパイラーは、宣言されたリザルトと返されたリザルトが食い違っていると教えてくれるので、エンドポイントの契約とその実装が黙ってずれてしまうことはありません。実際に返す型を追加して修正します。

```csharp
// .NET 11, C# 14 -- compiles, and OpenAPI now shows 200, 404, and 400
app.MapGet("/orders/{id}", Results<Ok<Order>, NotFound, BadRequest> (int id) =>
{
    if (id < 0)
        return TypedResults.BadRequest();
    return id > 999 ? TypedResults.NotFound() : TypedResults.Ok(new Order(id));
});
```

ここでの同期ハンドラーは `Task<>` ラッパーを必要としませんが、それでも完全なユニオンの戻り値の型を明示的に宣言しなければならない点に注意してください。コンパイラーは `Ok<Order>`、`NotFound`、`BadRequest` にまたがる「最良の共通型」を自力で推論しません。まさにそれが、`IResult` を返していたエンドポイントが文句なくコンパイルされ、こちらではユニオンを綴ることを要求される理由です。

## なぜ同期版は型の宣言を必要とするのか

型推論に仕事をさせようとしたときに突き当たる失敗を理解しておく価値があります。これはコンパイルされません。

```csharp
// .NET 11, C# 14 -- does NOT compile
app.MapGet("/todos/{id}", async (int id, TodoDb db) =>
{
    var todo = await db.Todos.FindAsync(id);
    return todo is null
        ? TypedResults.NotFound()   // NotFound
        : TypedResults.Ok(todo);    // Ok<Todo>
});
```

`TypedResults.Ok` と `TypedResults.NotFound` は異なる具体型を返し、コンパイラーは条件式の共通型を推論することを拒むので、ラムダには推論可能な戻り値の型がありません。同じコードの `Results` 版がコンパイルできたのは、`Results` の各ヘルパーがすでに `IResult` として型付けされており、三項演算子に明白な共通型を与えていたからにすぎません。`TypedResults` では、より豊かな型情報の対価として、同期ハンドラーには `Results<Ok<Todo>, NotFound>`、非同期には `Task<Results<Ok<Todo>, NotFound>>` というように、自分で戻り値の型を宣言します。この宣言は省ける定型コードではありません。フレームワークが OpenAPI 仕様を構築するために読み取る、まさにそのものです。

## テストでの見返り

ハンドラーが `IResult` ではなく具体型を返すようになったので、ユニットテストは HTTP サーバーを立ち上げることもキャストすることもなく、正確なリザルトをアサートできます。テストが直接呼び出せるように、ハンドラーを名前付きの静的メソッドに抽出します。

```csharp
// .NET 11, C# 14 -- TodoEndpoints.cs
public static async Task<Results<Ok<Todo>, NotFound>> GetTodo(int id, TodoDb db)
{
    var todo = await db.Todos.FindAsync(id);
    return todo is null
        ? TypedResults.NotFound()
        : TypedResults.Ok(todo);
}
```

テストはそれから具体型をチェックし、その型付き `Value` に直接手を伸ばします。`IResult` に対するリフレクションも HTTP の往復もありません。

```csharp
// .NET 11, C# 14 -- xUnit
[Fact]
public async Task GetTodo_ReturnsOk_WhenFound()
{
    await using var db = new MockDb().CreateDbContext();
    db.Todos.Add(new Todo { Id = 1, Title = "Write the union post" });
    await db.SaveChangesAsync();

    var result = await TodoEndpoints.GetTodo(1, db);

    var ok = Assert.IsType<Ok<Todo>>(result.Result);
    Assert.Equal(1, ok.Value!.Id);
}
```

ユニオンは実際のリザルトを `Result` プロパティ経由で公開し、`Ok<Todo>` はペイロードを強く型付けされた `Value` 経由で公開します。これがドキュメントが `TypedResults` について挙げる "improve unit testing" の利点です。`Results` では、何かをアサートできるようになる前に、まず `IResult` を具体型に変換し直さねばなりません。ここでは型がすでに具体的なので、アサーションは 1 行です。ハンドラーが `MapGet` にインラインで書けるほど小さいなら、テスト可能にするためだけに静的メソッドへ抽出するのは妥当なリファクタリングです。[ASP.NET Core 11 の minimal API 対コントローラー](/ja/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) の比較が、その構造が報われる場面を追っています。

## 6 型の上限と、その下にとどまる方法

`Results<>` は 2 個から 6 個までのジェネリックパラメーターで定義されているので、1 つのエンドポイントは最大 6 個の異なるリザルト型を宣言できます。実際にはこれで十分すぎます。`Ok`、`Created`、`NotFound`、`BadRequest`、`Conflict`、`ValidationProblem` を返すエンドポイントはすでに上限にあり、おそらく多くをやりすぎています。上限の拡張は要望されています ([dotnet/aspnetcore#61706](https://github.com/dotnet/aspnetcore/issues/61706) として追跡されています) が、今のところ 6 が壁です。

本当にそこに突き当たった場合、妥当な逃げ道が 2 つあります。1 つ目は、関連する失敗を単一のプロブレム型にまとめることです。`BadRequest`、`Conflict`、`UnprocessableEntity` を個別に列挙するのではなく、`TypedResults.Problem(...)` 経由で `ProblemHttpResult` を返し、区別を RFC 9457 のペイロードに符号化します。これは [minimal API の検証エラーレスポンスをカスタマイズする方法](/ja/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/) で扱った組み込みの検証がすでに出力するのと同じ形です。2 つ目は、その 1 つのエンドポイントについては `IResult` にフォールバックし、`.Produces` 注釈を手書きで追加して、6 個を超える分岐の代償として手書きメタデータを受け入れることです。実際に 6 個を超えるまでは、どちらにも手を出さないでください。ほとんどのエンドポイントは 2 個か 3 個で快適に収まります。

## つまずきやすい落とし穴

- **`Ok` と `Ok<T>` は別の型です。** 引数なしの `TypedResults.Ok()` は `Ok` (本体のない `200`) を返し、`TypedResults.Ok(value)` は `Ok<T>` を返します。ユニオンが `Ok<Todo>` を列挙しているのに、ある分岐がパラメーターなしの `TypedResults.Ok()` を呼ぶと、`Ok` は `Ok<Todo>` ではないのでコンパイルされません。各分岐が生み出す正確なバリアントを列挙してください。
- **ユニオンの戻り値の型は完全に綴らなければなりません。** 省略形も推論もありません。`async Task<Results<Ok<Todo>, NotFound>>` は冗長ですが、それは意図的です。フレームワークはまさにその宣言を読んで仕様を構築するので、短縮するという選択肢はありません。
- **ハンドラーが返す `Problem` は依然として `CustomizeProblemDetails` を迂回します。** ユニオンに `ProblemHttpResult` を入れることでレスポンスは文書化されますが、ハンドラー内で構築して返す `ProblemDetails` は直接シリアライズされ、`IProblemDetailsService` を通りません。`traceId` を刻印するためにグローバルな `CustomizeProblemDetails` コールバックに頼っている場合、それらには発火しません。この仕組みは [IProblemDetailsService カスタマイズの記事](/ja/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/) で詳述されています。
- **ジェネリックリストの順序は問題ではありませんが、それはあなたのドキュメントです。** `Results<Ok<Todo>, NotFound>` と `Results<NotFound, Ok<Todo>>` はまったく同じ挙動をします。読者がエンドポイントの契約を一目で見渡せるよう、一貫した順序 (成功を最初にするのが一般的な慣習です) を選んでください。
- **ステータス以外のメタデータは依然として明示的に追加します。** ユニオンはレスポンス型とステータスコードを扱います。`.WithName`、`.WithTags`、`.RequireAuthorization`、あるいは既定でないメディアタイプ向けのカスタム `Produces` といったものは別個の関心事であり、他のどのエンドポイントとも同じく、[minimal API で JWT ベアラー認証をセットアップする方法](/ja/2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11/) の JWT 設定も含めて、依然としてエンドポイントビルダーに付けます。

心に留めておくべきメンタルモデルはこうです。`IResult` は何でも返せて何も文書化しない緊急脱出口であり、`Results<T1, TN>` はコンパイラーが強制し OpenAPI が読み取る、宣言された契約です。エンドポイントに応答の可能性が複数あるときはいつでもユニオンに手を伸ばし、各分岐から対応する `TypedResults` ヘルパーを返し、型システムにハンドラーとテストと仕様の一致を保たせましょう。エンドポイントが本当に単一の応答形しか持たないときは、ユニオンを飛ばしてその 1 つの具体型を直接宣言します。たとえば `Task<Ok<Todo[]>>` です。ユニオンがその冗長さに見合うのは、文書化すべき分岐が複数あるときだけです。

## Related

- [ASP.NET Core 11 で IProblemDetailsService を使って minimal API の検証エラーレスポンスをカスタマイズする方法](/ja/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/)：ユニオンに入れる `ProblemHttpResult` を形づくるために。
- [ASP.NET Core 11 で Swashbuckle なしに OpenAPI を公開する方法](/ja/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/)：このメタデータを読み取る組み込みジェネレーターについて。
- [ASP.NET Core 11 でコントローラーなしに minimal API のリクエストボディを検証する方法](/ja/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/)：しばしばユニオンに加わる `ValidationProblem` リザルトについて。
- [ASP.NET Core 11 で MapGroup を使って minimal API エンドポイントを整理する方法](/ja/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)：型付きエンドポイントをグループ化し共有メタデータを適用するために。
- [ASP.NET Core 11 の minimal API 対コントローラー](/ja/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)：戻り値の型の慣習が 2 つのモデルでどう異なるかについて。

## Sources

- Microsoft Learn, [Create responses in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/responses?view=aspnetcore-11.0) (`TypedResults` 対 `Results`、`Results<TResult1, TResultN>` ユニオン、暗黙のキャスト演算子、コンパイル時チェック、非同期 `Task<>` の要件、ユニットテストの例)。
- Microsoft Learn, [Microsoft.AspNetCore.Http.HttpResults namespace](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.httpresults) (`Ok<T>`、`NotFound`、`BadRequest`、6 パラメーターのオーバーロードまでの `Results<TResult1, TResult2>`)。
- dotnet/aspnetcore, [Introduce way for route handler delegates to return union results (issue #40672)](https://github.com/dotnet/aspnetcore/issues/40672) (`Results<>` ユニオンの当初の設計)。
- dotnet/aspnetcore, [Extend Results in TypedResults to support more than 6 types (issue #61706)](https://github.com/dotnet/aspnetcore/issues/61706) (6 型の上限と、それを引き上げる要望)。
