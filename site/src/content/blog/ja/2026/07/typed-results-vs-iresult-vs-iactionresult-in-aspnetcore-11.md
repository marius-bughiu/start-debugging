---
title: "ASP.NET Core 11 における型付き結果 (Results<>) vs IResult vs IActionResult"
description: "ASP.NET Core 11 では、minimal API には TypedResults を使って Results<T1, TN> を返し、コントローラーには ActionResult<T> を返します。素の IResult と素の IActionResult は非常手段として扱いましょう。どんなレスポンスでもコンパイルは通りますが、OpenAPI には何も伝えないため、手書きの ProducesResponseType 属性という代償を払うことになります。"
pubDate: 2026-07-23
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-apis"
lang: "ja"
translationOf: "2026/07/typed-results-vs-iresult-vs-iactionresult-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-23
---

エンドポイントが取りうるレスポンスが 1 つだけなら、その具体的な型 1 つを宣言して先に進みましょう。複数ある場合、ASP.NET Core 11 での的確な答えはこうです。minimal API からは `TypedResults` を使って `Results<TResult1, TResultN>` を返し、コントローラーからは `ActionResult<T>` を返します。どちらもハンドラーが宣言したものしか返さないことをコンパイル時にチェックしてくれ、どちらも OpenAPI ジェネレーターにレスポンスのメタデータを無償で渡してくれます。2 つのインターフェース型、素の `IResult` と素の `IActionResult` は非常手段です。何を返そうとコンパイルが通り、まさにそれゆえにフレームワークには何も伝えず、正確な仕様を得るために `[ProducesResponseType]` や `.Produces` を手書きさせられます。以下はすべて `Microsoft.NET.Sdk.Web` と C# 14 を使った .NET 11 が対象ですが、`HttpResults` 型は .NET 7 以降ずっと同じ挙動なので、同じコードが .NET 10 GA でも変更なく動きます。

このキュー内のタイトルにある 3 つの候補は、2 つの異なる世界に対応しています。`IActionResult` は MVC コントローラーの世界です。`IResult` とその型付き共用体 `Results<>` は、`Microsoft.AspNetCore.Http.HttpResults` 名前空間を土台とする minimal API の世界です。この比較を書く価値があるひねりは、.NET 7 以降 `HttpResults` 型がコントローラーでも動くようになった点です。そのため、コントローラーのアクションでは今や MVC の結果型と minimal API の結果型のあいだで本当の選択肢があります。うまく選ぶには、それぞれの型が何を伝え、何を伝えないのかを理解する必要があります。

## 機能マトリクス

| 機能 | `IActionResult` | `ActionResult<T>` | `IResult`（素） | `Results<T1, TN>` |
| --- | --- | --- | --- | --- |
| 主な住処 | コントローラー | コントローラー | Minimal API + コントローラー | Minimal API + コントローラー |
| OpenAPI へ自己記述する | いいえ | 部分的（`T` を推論） | いいえ | はい |
| `[ProducesResponseType]` / `.Produces` が必要 | はい、多用する | `T` 以外のステータスコードに対して | はい | いいえ |
| コンパイル時の戻り値チェック | いいえ | いいえ | いいえ | はい |
| コンテンツネゴシエーション / フォーマッター | はい | はい | いいえ | いいえ |
| ペイロード型からの暗黙的キャスト | いいえ（インターフェース） | はい（`T` から `ActionResult<T>`） | いいえ | はい（各共用体引数） |
| 結果を直接ユニットテストできる | キャストが必要 | キャストが必要 | キャストが必要 | 具体的な `.Result` |

マトリクスを上から下へ読めば、パターンは明白です。2 つのインターフェースの行は、メタデータと安全性のすべての列で「いいえ」です。2 つの型付きの行は、その冗長さと引き換えに「いいえ」を「はい」に変えます。インターフェースと `ActionResult<T>` が `HttpResults` 型に勝る唯一の列はコンテンツネゴシエーションであり、その 1 行こそが、ときにあなたの代わりに選択を決めてしまう落とし穴です。詳しくは後述します。

## Results<>（と TypedResults）を選ぶとき

**minimal API** のエンドポイントが複数の形で応答しうるなら、いつでも共用体に手を伸ばしましょう。

- **.NET 11 で、`200` と `404` を返す minimal API エンドポイント。** `Results<Ok<Todo>, NotFound>` を宣言し、`TypedResults.Ok(todo)` と `TypedResults.NotFound()` を返し、すべての `.Produces` 呼び出しを削除します。今や共用体がメタデータを運びます。
- **仕様を常に正直に保たなければならないあらゆるエンドポイント。** 戻り値の型が契約そのものであるため、共用体に `BadRequest` を追加せずに `400` の分岐を追加すると、静かに古びた Swagger ページではなく、コンパイルエラーになります。
- **同じ自己記述の挙動が欲しいコントローラー。** `HttpResults` 型はコントローラーのアクションでも正当です。`public Results<NotFound, Ok<Product>> GetById(int id)` はコンパイルが通り、minimal API とまったく同じように、すべての `[ProducesResponseType]` 属性を不要にします。

これが minimal API の標準的な形です。

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

`.Produces` は不要で、生成される OpenAPI ドキュメントには `Todo` スキーマを持つ `200` と、本文なしの `404` が並びます。どちらも戻り値の型から導出されます。ステップごとの変換、6 つの型という上限、そしてテストで得られる利点については、[minimal API エンドポイントから型付き Results 共用体を返す方法](/ja/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/)で詳しく扱っています。この記事は、それをどう組み立てるかではなく、いつ他の選択肢より優先して選ぶかについてのものです。

## ActionResult<T> を選ぶとき

主要な成功ペイロードと 1 つ以上のエラー分岐を持つ**コントローラー**のアクションを書いているときは、`ActionResult<T>` に手を伸ばしましょう。

- **`Product` または `404` を返すコントローラーの `GET`。** `ActionResult<Product>` なら、`return product;` と直接書けて（暗黙的キャストがそれを `ObjectResult` にラップします）、見つからないときは `return NotFound();` と書けます。
- **成功の型を繰り返さずに仕様へ推論させたい。** `ActionResult<T>` を使えば、`[ProducesResponseType(200)]` に `Type = typeof(Product)` はもう必要ありません。フレームワークが `T` を読み取ります。ドキュメントははっきりこう述べています。「アクションが期待する戻り値の型は、`ActionResult<T>` の `T` から推論されます。」
- **コンテンツネゴシエーションが必要。** MVC の結果型は構成済みのフォーマッターを通るため、`Accept: application/xml` を送るクライアントは、そのフォーマッターを登録していれば XML を受け取ります。`HttpResults` 型はこれをまったく行いません。

```csharp
// .NET 11, C# 14 -- ProductsController.cs
[HttpGet("{id}")]
[ProducesResponseType(StatusCodes.Status200OK)]
[ProducesResponseType(StatusCodes.Status404NotFound)]
public ActionResult<Product> GetById(int id)
{
    var product = _db.Products.Find(id);
    return product is null ? NotFound() : product;   // implicit cast T -> ActionResult<T>
}
```

`ActionResult<T>` が存在し、`IActionResult` がそれを置き換えられない理由は、フレームワークの決定ではなく C# のルールです。C# はインターフェースに暗黙的キャスト演算子を許しません。`ActionResult<T>` は具体的なジェネリック型なので、`return product;` と書けるようにする `T` からの暗黙的変換を定義できます。`IActionResult` はインターフェースなので、決して定義できません。それが両者のあいだにある、人間工学上の差のすべてです。

## 素の IActionResult または IResult が実際に正しいとき

どちらのインターフェースも間違いではなく、単に用途が狭いだけです。既定ではなく、意図的に使いましょう。

- **アクションが本当に無関係な結果型を返す場合の `IActionResult`。** そしてそれぞれに `[ProducesResponseType]` を書くことを受け入れる場合です。3 つの分岐からファイル、リダイレクト、JSON 本文を返しうるような、単一の `T` が存在しないアクションにとっては、依然として正直な選択肢です。
- **単一の形の minimal API 分岐があり**、1 つの型だけの共用体を書き出したくない場合の `IResult`。常に 1 つのステータスしか生成しないハンドラーから素の `IResult` を返すのは問題ありません。ドキュメントを気にするなら `.Produces` を足すだけです。
- **minimal API とコントローラーでハンドラーを共有する。** `HttpResults` 型は両方のホスティングモデルでコンパイルが通る唯一の結果ファミリーなので、`IResult` や `Results<>` 共用体を返す共有の静的メソッドが、一度だけ書くための方法です。その移植性こそ、これらの型が minimal API の外に存在するとドキュメントに記された理由です。

コントローラーでの素の `IResult` 版はこうなり、属性が戻ってきている点に注目してください。

```csharp
// .NET 11, C# 14 -- ProductsController.cs
[HttpGet("{id}")]
[ProducesResponseType<Product>(StatusCodes.Status200OK)]
[ProducesResponseType(StatusCodes.Status404NotFound)]
public IResult GetById(int id)
{
    var product = _db.Products.Find(id);
    return product is null ? Results.NotFound() : Results.Ok(product);
}
```

すべての `Results.*` ヘルパーは `IResult` を返すので、コンパイラは両方の分岐について `IResult` を推論して一切文句を言わず、ApiExplorer はステータスコードについて何も語らないインターフェースを見ます。だからこそ 2 つの `[ProducesResponseType]` 行はここでは必須であり、`Results<>` 版では不要なのです。メタデータには他にどこからも来る場所がないからです。

## あなたの代わりに選択を決めてしまう落とし穴: コンテンツネゴシエーション

もし API が `Accept` ヘッダーを尊重し、結果がハードコードする形式以外の XML、CSV、あるいは任意の形式を返さなければならないなら、`HttpResults` ファミリーは対象外であり、その決定は上記のすべてを覆します。ドキュメントは、`HttpResults` 型が「構成済みの Formatters を利用***しない***」と明言し、その帰結を綴っています。「`Content negotiation` のような一部の機能は利用できません」そして「生成される `Content-Type` は `HttpResults` の実装によって決められます」。`TypedResults.Ok(product)` は、クライアントが何を求めたかにかかわらず JSON をシリアライズします。したがって、内部の JSON 専用 API はコントローラーで `Results<>` を自由に使い、自己記述のメタデータを享受できますが、XML フォーマッターを登録した公開 API は、ネゴシエーションするエンドポイントについては `ActionResult<T>` / `IActionResult` にとどまらなければなりません。これは好みではなく能力の壁であり、だからこそ意思決定の末尾ではなく先頭に属するのです。

第 2 の強制要因はホスティングモデルです。エンドポイントが minimal API に存在するなら、`IActionResult` と `ActionResult<T>` はそもそも使えません。それらはコントローラーのパイプラインに依存する MVC 型です。そこでの選択は常に `IResult` と `Results<>` のあいだだけであり、複数レスポンスのエンドポイントなら `Results<>` が勝ちます。2 つのホスティングモデルのあいだのトレードオフの全体は、[ASP.NET Core 11 における minimal API vs コントローラー](/ja/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)で解説しています。

## なぜ型付き版が偶然にはコンパイルされないのか

`Results<>` で人がぶつかる摩擦が 1 つあり、バグと読まれないように名前を付けておく価値があります。型推論は共用体をあなたの代わりに組み立ててくれません。これはコンパイルされません。

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

`TypedResults.NotFound()` と `TypedResults.Ok(todo)` は異なる具体的な型なので、コンパイラは三項演算子の共通の型を見つけられず、ラムダには推論できる戻り値の型がありません。素の `IResult` 版がコンパイルできたのは、すべての `Results.*` ヘルパーがすでに `IResult` であり、分岐に明白な共有の型を与えていたからにすぎません。`TypedResults` では、より豊かなメタデータの代償として、戻り値の型を自分で宣言します。同期ハンドラーには `Results<Ok<Todo>, NotFound>`、非同期ハンドラーには `Task<Results<Ok<Todo>, NotFound>>` です。その宣言は短縮できる定型文ではありません。それはフレームワークが仕様を組み立てるために読み取る、まさにその文字列であり、それこそが眼目です。

同じ論理が、`ActionResult<IEnumerable<Product>>` は機能するのに、`ActionResult<T>` が直接返すインターフェースをラップできない理由を説明します。暗黙的キャストは `T` から定義され、C# はインターフェースへの暗黙的キャストを禁じるため、`IEnumerable` のインスタンスを返すには明示的な `Ok(...)` のラッパーが必要です。小さなルールですが、ときに驚かされます。

## 全体像とともに再述する推奨

- **新しい minimal API、複数レスポンス: `TypedResults` を使った `Results<T1, TN>`。** コンパイル時チェックに加えて自己記述の OpenAPI 仕様、`.Produces` は不要です。これが既定であり、反射的にこれを選ぶべきです。
- **新しい minimal API、単一レスポンス: 1 つの具体的な型**、たとえば `Task<Ok<Todo[]>>`。曖昧さを解消するものが何もないなら、共用体は省きましょう。
- **コントローラー、JSON 専用、メタデータを無償で欲しい: コントローラーでの `Results<T1, TN>`** は機能し、属性を不要にします。それ以外では、古典的なコントローラーの人間工学のために **`ActionResult<T>`** を選びます。
- **コンテンツをネゴシエートしなければならないあらゆるエンドポイント（XML、CSV、カスタムメディアタイプ）: `ActionResult<T>` または `IActionResult`。** `HttpResults` 型はコンテンツネゴシエーションができません、以上です。
- **素の `IResult` / 素の `IActionResult`: 非常手段としてのみ。** 本当に不均質なレスポンス、型を書き出したくない単一の形の分岐、あるいはホスティングモデルをまたいで共有するコードのために手を伸ばし、それに伴う手書きのメタデータを受け入れましょう。

保つべきメンタルモデルはこうです。インターフェースの戻り値の型は何でも受け入れ、何も文書化しないので、フレームワークは契約を属性で再表明させます。型付きの戻り値の型、`Results<>` または `ActionResult<T>` は契約そのものなので、コンパイラがそれを強制し、OpenAPI ジェネレーターがそれを読み取ります。具体的な能力、ほぼ常にコンテンツネゴシエーションがインターフェースを強いない限り、型付きの方を選びましょう。バリデーション失敗を返す分岐については、`ProblemHttpResult` を共用体に組み込むことで、[IProblemDetailsService を使って minimal API のバリデーションエラーレスポンスをカスタマイズする方法](/ja/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/)で説明した組み込みのパイプラインと形を一貫させられます。

## 関連記事

- [ASP.NET Core 11 で minimal API エンドポイントから型付き Results 共用体を返す方法](/ja/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/)：ステップごとの変換、6 つの型という上限、そしてテストについて。
- [ASP.NET Core 11 における minimal API vs コントローラー](/ja/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)：どの戻り値の型が使えるかを制約するホスティングモデルの選択について。
- [ASP.NET Core 11 で Swashbuckle なしに OpenAPI を公開する方法](/ja/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/)：このメタデータを読み取る組み込みジェネレーターについて。
- [ASP.NET Core 11 で IProblemDetailsService を使って minimal API のバリデーションエラーレスポンスをカスタマイズする方法](/ja/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/)：しばしば共用体に加わる `ProblemHttpResult` について。
- [ASP.NET Core 11 でコントローラーなしに minimal API のリクエスト本文を検証する方法](/ja/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/)：`ValidationProblem` がレスポンスの集合のどこに収まるかについて。

## 参考文献

- Microsoft Learn, [Controller action return types in ASP.NET Core web API](https://learn.microsoft.com/en-us/aspnet/core/web-api/action-return-types?view=aspnetcore-11.0)（`IActionResult`、`ActionResult<T>` とその暗黙的キャストの利点、インターフェースの暗黙的キャストの制限、そしてコンテンツネゴシエーションの注意点を含むコントローラー内の `HttpResults` 型）。
- Microsoft Learn, [Create responses in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/responses?view=aspnetcore-11.0)（`TypedResults` vs `Results`、`Results<TResult1, TResultN>` 共用体、暗黙的キャスト演算子、コンパイル時チェック、そして自己記述メタデータ）。
- Microsoft Learn, [Microsoft.AspNetCore.Http.HttpResults namespace](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.httpresults)（`Ok<T>`、`NotFound`、`BadRequest`、そして `Results<>` のオーバーロード）。
- dotnet/aspnetcore, [Introduce way for route handler delegates to return union results (issue #40672)](https://github.com/dotnet/aspnetcore/issues/40672)（`Results<>` 共用体の当初の設計）。
