---
title: "修正: EF Core 11 の \"An exception was thrown while attempting to evaluate a LINQ query parameter expression\""
description: "EF Core は、クライアント評価されるクエリの一部が評価中に例外を投げたときにこれを出します。InnerException を読み、EnableSensitiveDataLogging を有効にして、null チェックをラムダの外へ出してください。"
pubDate: 2026-08-19
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "dotnet"
  - "linq"
lang: "ja"
translationOf: "2026/08/fix-an-exception-was-thrown-while-attempting-to-evaluate-a-linq-query-parameter-expression"
translatedBy: "claude"
translationDate: 2026-08-19
---

これは変換の失敗ではありません。EF Core 11 が `An exception was thrown while attempting to evaluate a LINQ query parameter expression` を投げるのは、クエリの部分木をクライアントで評価できる (つまり "クエリパラメーター" である) と EF がすでに判断したうえで、**その評価中にあなた自身のコードが例外を投げた**ときです。10 回のうち 9 回は、実際のエラーはキャプチャされたオブジェクトに対する `NullReferenceException` であり、それは `InnerException` に入っています。`DbContextOptionsBuilder` で `EnableSensitiveDataLogging()` を呼ぶと、EF がつまずいた式そのものを出力してくれます。そのうえで null チェックをラムダの外に出し、クエリの組み立て側へ移してください。以下の内容はすべて .NET 10 上の `Microsoft.EntityFrameworkCore` 10.0.11 で検証しました。例外を投げている箇所は EF Core 11 のプレビューでも一字一句同じなので、挙動はそのまま引き継がれます。

## 実際に出るエラー

このメッセージには 2 つの変種があり、どちらが出るかは機密データのログ出力が有効かどうかだけで決まります。無効な場合:

```
System.InvalidOperationException: An exception was thrown while attempting to evaluate a LINQ query parameter expression. See the inner exception for more information. To show additional information call 'DbContextOptionsBuilder.EnableSensitiveDataLogging'.
 ---> System.NullReferenceException: Object reference not set to an instance of an object.
   at System.Linq.Expressions.Interpreter.Instruction.NullCheck(Object o)
   at System.Linq.Expressions.Interpreter.FuncCallInstruction`2.Run(InterpretedFrame frame)
   at System.Linq.Expressions.Interpreter.Interpreter.Run(InterpretedFrame frame)
   at System.Linq.Expressions.Interpreter.LightLambda.Run(Object[] arguments)
   at Microsoft.EntityFrameworkCore.Query.Internal.ExpressionTreeFuncletizer.<Evaluate>g__EvaluateCore|74_0(...)
   --- End of inner exception stack trace ---
   at Microsoft.EntityFrameworkCore.Query.Internal.ExpressionTreeFuncletizer.Evaluate(...)
   at Microsoft.EntityFrameworkCore.Query.Internal.ExpressionTreeFuncletizer.ProcessEvaluatableRoot(...)
   at Microsoft.EntityFrameworkCore.Query.Internal.ExpressionTreeFuncletizer.VisitBinary(BinaryExpression binary)
```

`EnableSensitiveDataLogging()` を有効にすると、メッセージは式そのものを名指しする、はるかに有用な変種に変わります:

```
System.InvalidOperationException: An exception was thrown while attempting to evaluate the LINQ query parameter expression 'value(Program+<>c__DisplayClass0_0).filter.MinRating'. See the inner exception for more information.
 ---> System.NullReferenceException: Object reference not set to an instance of an object.
```

冠詞に注目してください。非機密版は "a LINQ query parameter expression"、機密版は "the LINQ query parameter expression '...'" です。片方で検索してもう片方に行き着いたとしても、このページで問題ありません。どちらも同じリソース文字列のペア、`ExpressionParameterizationException` と `ExpressionParameterizationExceptionSensitive` から来ています。

この式に出てくる `<>c__DisplayClass0_0` は、キャプチャされたローカル変数を保持する、コンパイラーが生成したクロージャクラスです。`filter` がキャプチャされた変数で、`MinRating` が破綻したメンバーアクセスです。この 1 行だけで、たいていは該当行を特定できます。

## なぜ起きるのか

EF は SQL を組み立てる前に式ツリーをたどり、ノードを 2 種類に分けます。クエリのルートに依存するもの (`b.Rating`、これは列になります) と、依存しないもの (`filter.MinRating`、これは SQL パラメーターになります) です。後者を EF は funcletization と呼び、`ExpressionTreeFuncletizer` が担当します。評価可能な部分木ごとに、EF は `Func<object>` をコンパイルして呼び出します:

```csharp
// Microsoft.EntityFrameworkCore 11, ExpressionTreeFuncletizer.EvaluateCore
try
{
    return Lambda<Func<object>>(Convert(expression, typeof(object)))
        .Compile(preferInterpretation: true)
        .Invoke();
}
catch (Exception exception)
{
    throw new InvalidOperationException(
        _logger.ShouldLogSensitiveData()
            ? CoreStrings.ExpressionParameterizationExceptionSensitive(expression)
            : CoreStrings.ExpressionParameterizationException,
        exception);
}
```

仕組みはこれだけです。キャプチャされた式の内部であなたのコードが投げた例外は、この `InvalidOperationException` にくるまれて再スローされます。EF はクエリに文句を言っているのではなく、その一部を実行したら失敗した、と報告しているだけです。

これはデバッグの進め方に直結します。メッセージが意図的に汎用なのは、式のテキストにユーザーデータが含まれうるからで、だからこそ詳細版は機密データのログ出力の裏側に置かれています。具体的なエラーは常に `InnerException` にあり、内部例外のスタックトレースはあなたのコードではなく `System.Linq.Expressions.Interpreter` を指します。EF が `preferInterpretation: true` でコンパイルしているためです。そのスタックの中に自分のフレームを探しても無駄です。代わりに内部例外の型とメッセージを読んでください。

これは兄弟のようなエラー `The LINQ expression could not be translated` とは対照的です。あちらは、EF がその構文をそもそも SQL に変換できないときに発生します。パイプラインの段階が違えば、対処も違います。

## 最小の再現コード

`DbSet<Blog>`、null 許容のフィルター DTO、そしてそれを参照する `Where` です:

```csharp
// .NET 10, C# 14, Microsoft.EntityFrameworkCore.Sqlite 10.0.11
using Microsoft.EntityFrameworkCore;

public class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public int Rating { get; set; }
}

public class Filter { public int MinRating { get; set; } }

public class AppDb(DbContextOptions<AppDb> o) : DbContext(o)
{
    public DbSet<Blog> Blogs => Set<Blog>();
}
```

```csharp
// .NET 10, C# 14, EF Core 10.0.11
Filter? filter = null;                                      // came back null from the request binder
var q = db.Blogs.Where(b => b.Rating >= filter!.MinRating); // no exception yet
var rows = q.ToList();                                      // throws here
```

押さえておきたい点が 2 つあります。

- **クエリを組み立てるだけでは例外は出ません。** `IQueryable` を構築するのはただです。funcletization はクエリがコンパイルされるときに走り、それは終端演算子で起こります。クエリを組み立てて一度も列挙しない形で確認したところ、例外は出ませんでした。
- **`ToQueryString()` を含め、どの終端演算子でも例外が出ます。** `ToList()`、`ToListAsync()`、`Any()`、`Count()`、`ToQueryString()` はすべて同じコンパイル経路を通ります。最後のものは便利で、データベース接続なしでこの現象を再現できます。

以下は、よくあるきっかけごとに測定した内部例外です。すべて SQLite プロバイダー上の EF Core 10.0.11 で確認しました。

| 書いたコード | `InnerException` |
| --- | --- |
| `filter` が null での `b.Rating >= filter!.MinRating` | `NullReferenceException` |
| ゲッターが例外を投げる `b.Rating >= config.MinRating` | あなた自身の例外がそのまま |
| `int? maybe = null` での `b.Rating == maybe!.Value` | `InvalidOperationException: Nullable object must have a value.` |
| 空の `List<int>` に対する `b.Rating == empty.First()` | `InvalidOperationException: Sequence contains no elements` |
| `raw = "not-a-number"` での `b.Rating == int.Parse(raw)` | `FormatException` |
| `Dictionary<string, int>` に対する `b.Rating == map["nope"]` | `KeyNotFoundException` |
| 静的初期化子が例外を投げる `b.Rating >= Bad.Value` | 本来の例外を包んだ `TargetInvocationException` |
| `string? s = null` での `b.Name == s!.Trim()` | `NullReferenceException` |

下から 2 番目の行は二重に厄介です。静的フィールドの初期化子が失敗すると、入れ子が 3 段になります。外側のラッパー、次に `TargetInvocationException`、そのさらに内側に本当に知りたい例外があります。メッセージが役立たずだと結論づける前に、`ex.InnerException.InnerException` を読んでください。

## 修正方法の詳細

修正の形はいつも同じで、EF が評価するときにキャプチャされた式が例外を投げないようにすることです。方法は 4 つあり、おすすめ順に並べます。

### 1. ラムダの外で条件付きに組み立てる

圧倒的に多い "オプションのフィルター" のケースでは、これが正しい修正です。フィルターがないときは述語ごと消えるので、生成される SQL も良くなります:

```csharp
// .NET 10, C# 14, EF Core 10.0.11
IQueryable<Blog> q = db.Blogs;

if (filter is not null)
{
    q = q.Where(b => b.Rating >= filter.MinRating);
}

var rows = await q.ToListAsync();
```

`filter` が null の状態で検証済みです。例外は出ず、生成 SQL に無駄な `WHERE` 句も残りません。

### 2. クエリの前にローカル変数へ取り出す

値そのものは省略可能でも述語は省略できない場合は、既定値を決めたローカル変数へ射影します。そうすれば EF がキャプチャするのは `int` になり、例外は起こりえません:

```csharp
// .NET 10, C# 14, EF Core 10.0.11
var min = filter?.MinRating ?? int.MinValue;
var rows = await db.Blogs.Where(b => b.Rating >= min).ToListAsync();
```

これは `int.Parse`、`Guid.Parse`、辞書のルックアップに対する修正でもあります。失敗を正しく扱えるクエリの手前で解析や検索を済ませてください。ラムダの中でやると、失敗は 3 層に包まれて届きます。

### 3. ラムダの内側で短絡させる

どうしても 1 つの式にまとめたい場合は、`&&`、`||`、三項演算子によるガードが使えます。funcletizer は短絡する二項演算子と `ConditionalExpression` を特別扱いし、通らない分岐を先回りして評価しません:

```csharp
// .NET 10, C# 14, EF Core 10.0.11
var rows = await db.Blogs
    .Where(b => filter == null || b.Rating >= filter.MinRating)
    .ToListAsync();

// the ternary form behaves identically
var rows2 = await db.Blogs
    .Where(b => filter == null ? true : b.Rating >= filter.MinRating)
    .ToListAsync();
```

3 つの書き方 (`filter != null && ...`、`filter == null || ...`、三項演算子) はいずれも、`filter` が null の再現コードで問題なく動きました。それでも 3 番目に置くのは 2 つの理由からです。フィルターがないときに常に真の `WHERE` 句をデータベースへ送ってしまうこと、そしてメジャーバージョン間で変わってきた funcletizer の挙動に依存していることです。issue [dotnet/efcore#34883](https://github.com/dotnet/efcore/issues/34883) はまさにこの形で、クライアント側の条件とデータベース側の条件を混ぜた条件式が、EF Core 9 のサイクル中に内部エラー `unbound variable` へ退行し、修正されました。

### 4. 例外を投げている当のものを直す

サービスがまだ初期化されていないためにプロパティのゲッターが例外を投げている場合 (典型例は、空のアンビエントスコープを読むテナントリゾルバーです)、上のどれも助けになりません。クエリは正しく、壊れているのは composition root です。ゲッターが値を返すようにするか、意味のあるメッセージを付けてもっと早い段階で失敗させてください。

## 落とし穴と変種

**クエリフィルターはラップされません。** `HasQueryFilter` のラムダが `DbContext` のフィールドを読み、その読み取りが例外を投げた場合、返ってくるのはこの例外ではなく生の例外です。`_tenant.Current` が例外を投げる状態で `HasQueryFilter(b => b.TenantId == _tenant.Current)` を持つコンテキストを用意したところ、`db.Blogs.ToList()` は `InvalidOperationException: no tenant in scope` をそのまま返しました。理由は funcletizer にあります。コンテキストに触れる式はコンテキストアクセサーの経路を通り、あの `try` ブロックの中で呼び出す代わりに遅延された `Lambda` を返すためです。したがって、マルチテナント構成をデバッグしていてパラメーター化のラッパーが実際に見えているなら、原因のキャプチャはフィルターではなく通常の `Where` の側にあります。`IgnoreQueryFilters()` を呼ぶとクエリが通るので、どちらのケースかを素早く切り分けられます。

**`Contains` に渡したコレクションが null でも例外にはならず、黙って何も返しません。** これはこのページで最も危険な変種です。修正のように見えてしまうからです:

```csharp
// .NET 10, C# 14, EF Core 10.0.11, SQLite provider
List<string>? names = null;
var rows = db.Blogs.Where(b => names!.Contains(b.Name)).ToList();
// rows.Count == 0, no exception
// SELECT "b"."Id", "b"."Name", "b"."Rating" FROM "Blogs" AS "b" WHERE 0
```

EF は null のパラメーター化コレクションを、空のコレクションとまったく同じように常に偽の述語へ変換します。エラーは出ず、0 行が返り、バグはそのまま出荷されます。ドメイン上、null のリストが "フィルターなし" を意味するなら、`names is null ||` のガードで明示するか、修正 1 のように条件付きで組み立ててください。

**`EF.Constant` では救えません。** キャプチャを `EF.Constant(filter!.MinRating)` で包んでも、やはり例外になります。参照外しは引数の評価中に起こり、EF がマーカーメソッドを見る前だからです。

**ラッパーではなく生の `NullReferenceException` が出た場合、投げたのは EF ではなくあなたのコードです。** `db.Blogs.Take(filter!.MinRating)` は素の `NullReferenceException` を投げます。`Take` が受け取るのは `int` なので、C# コンパイラーが呼び出し側でその引数を評価し、式ツリーの一部にはならないからです。`Skip` も同じですし、渡す前に文字列へ補間したものも同じです。ラッパーが付くのはラムダだけです。

**メソッドチェーンでは回避できません。** `db.Blogs.Where(b => b.Id == 0).Where(b => b.Rating >= filter!.MinRating)` のように分けても例外は出ます。funcletization はコンパイル時に組み立て済みのツリー全体を対象にするので、演算子単位ではありません。前段のフィルターが後段のキャプチャを短絡させることはできません。

**初回だけでなく、実行のたびに例外になります。** コンパイル済みクエリのキャッシュはクエリの形をキーにしており、funcletization はパラメーター値を取り出すためにキャッシュ参照より前に走ります。"一度は動いていたのに壊れた" ということはここでは起こりません。

## 関連記事

- これと混同されやすいもう 1 つの EF Core のクエリ実行時例外は、[EF Core が LINQ 式を変換できないと言う理由](/ja/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/) で扱っています。あちらは EF がそもそも SQL へ変換できない構文の話です。
- 内部例外が `Sequence contains no elements` の場合は、背後にある LINQ 演算子の挙動を [First と Single が実際に例外を投げる条件](/ja/2026/07/fix-invalidoperationexception-sequence-contains-no-elements/) で読んでおくとよいです。
- このメッセージの機密版を有効にする設定は、[EF Core が生成する SQL を確認する方法](/ja/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) で説明している、より広い設定のうちの 1 行です。
- マルチテナントを組んでいる最中にこれに当たったなら、[論理削除とマルチテナントのための名前付きクエリフィルター](/ja/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/) が、例外を投げるゲッターなしでテナント ID をコンテキストへ渡す方法を扱っています。
- パラメーター化はキャッシュの挙動も左右するので、[ホットパスでのコンパイル済みクエリ](/ja/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) でクエリのパフォーマンスを追う際にも関係します。

## 参考資料

- [CoreStrings.ExpressionParameterizationException](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.diagnostics.corestrings.expressionparameterizationexception) (MS Learn)。正確なリソース文字列です。
- dotnet/efcore の [ExpressionTreeFuncletizer.cs](https://github.com/dotnet/efcore/blob/main/src/EFCore/Query/Internal/ExpressionTreeFuncletizer.cs)。例外を包む try/catch がある場所です。
- EF Core ドキュメントの [クライアント評価とサーバー評価](https://learn.microsoft.com/en-us/ef/core/querying/client-eval)。EF がクエリツリーをどう分割するかについて。
- [DbContextOptionsBuilder.EnableSensitiveDataLogging](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.dbcontextoptionsbuilder.enablesensitivedatalogging)。式を名指しするメッセージ変種を有効にします。
- [dotnet/efcore#34883](https://github.com/dotnet/efcore/issues/34883)。クライアント側とデータベース側の条件が混ざった条件式が、内部エラー `unbound variable` を伴うこの例外を出していた EF Core 9 の退行です。
- [Finbuckle.MultiTenant のディスカッション #792](https://github.com/Finbuckle/Finbuckle.MultiTenant/discussions/792)。マルチテナント環境でのこのエラーの代表的な報告です。
