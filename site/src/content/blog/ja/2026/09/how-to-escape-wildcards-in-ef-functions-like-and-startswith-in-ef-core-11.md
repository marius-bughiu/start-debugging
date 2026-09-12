---
title: "EF Core 11 で EF.Functions.Like と StartsWith クエリの % と _ ワイルドカードをエスケープする方法"
description: "EF Core 11 では StartsWith、EndsWith、Contains が % と _ を自動でエスケープしますが、EF.Functions.Like はエスケープしません。EF が生成する SQL、再利用できるエスケープヘルパー、そして SQL Server、SQLite、PostgreSQL で正しく動作させるための escapeCharacter オーバーロードを解説します。"
pubDate: 2026-09-12
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "dotnet-11"
  - "sql-server"
  - "linq"
lang: "ja"
translationOf: "2026/09/how-to-escape-wildcards-in-ef-functions-like-and-startswith-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-09-12
---

**結論:** EF Core 11 では、`string.StartsWith`、`EndsWith`、`Contains` について何もエスケープする必要はありません。EF が検索値を `50\%%` のようなパターンに書き換え、`ESCAPE N'\'` も自動で付加します。`EF.Functions.Like` は事情が異なります。パターンをそのまま渡すため、ユーザーが `50%` や `a_b` と入力するとワイルドカードとしてマッチしてしまいます。ユーザーが入力した部分は自分でエスケープし (まずバックスラッシュ、次に `%`、`_`、SQL Server では `[` も)、3 引数のオーバーロード `EF.Functions.Like(p.Name, pattern, "\\")` を呼び出してください。エスケープしたのに 3 番目の引数を省略すると、SQL Server と SQLite はバックスラッシュをリテラル文字として扱い、クエリは何のエラーもなく 0 件を返します。

以下の内容はすべて .NET 11 RC 1 (SDK `11.0.100-rc.1.26425.128`) と `Microsoft.EntityFrameworkCore.SqlServer` および `Microsoft.EntityFrameworkCore.Sqlite` `11.0.0-rc.1.26425.128` で計測したものです。SQL Server の出力は `ToQueryString()` から取得しています。SQLite のクエリはインメモリデータベースに対して実際に実行したので、行の一覧は実際の結果です。

## 検索ボックスにパーセント記号を入れると間違った行が返る理由

SQL の `LIKE` には独自の小さなパターン言語があります。SQL Server では、[`LIKE` のリファレンス](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/like-transact-sql) が 4 種類のワイルドカードを定義しています。`%` (任意の長さの文字列)、`_` (任意の 1 文字)、`[abc]` (文字セットまたは範囲)、`[^abc]` (否定セット) です。SQLite と PostgreSQL にあるのは `%` と `_` だけです。検索語にこれらの文字のいずれかが含まれると、クエリの意味が変わってしまいます。

文字列連結でパターンを組み立てる商品検索を見ると、問題はすぐにわかります。

```csharp
// .NET 11, EF Core 11.0.0-rc.1, SQLite in-memory
var term = "50%";   // what the user typed
var rows = await db.Products
    .Where(p => EF.Functions.Like(p.Name, "%" + term + "%"))
    .Select(p => p.Name)
    .ToListAsync();
```

テーブルに `50% off sale`、`500 widgets`、`done 50%`、`done 500` の行がある場合、このクエリは **4 件すべて** を返します。パターンは `%50%%` となり、これは "50 を含む" という意味なので、ユーザーが入力したパーセント記号は失われています。アンダースコアでも同じことが起こります。`$"%{term}%"` で `a_b` を検索すると、`a_b adapter` と `axb adapter` の両方にマッチしました。SQL Server では検索語の `[` が 3 つ目のワイルドカードになります。`[x]` は 1 文字 `x` にマッチする文字クラスなので、`[x]` を検索すると `%[x]%` となり、`x` を含むすべての名前が見つかります。

これは SQL インジェクションではありません。値は引き続きパラメーターとして送信される (`DECLARE @p nvarchar(4000) = N'%50%%'`) ため、誰も文字列の外に抜け出すことはできません。問題は、パターンがユーザーの意図とは別の意味になり、しかもそのときに何のエラーも出ないことです。

## EF Core 11 がすでにエスケープしてくれるもの

エスケープヘルパーを書く前に、本当に必要かどうかを確認しましょう。通常の LINQ の文字列メソッドは自動で処理されます。検索値がキャプチャされた変数の場合、EF Core 11 RC 1 は SQL Server で次の SQL を生成します。

```csharp
// .NET 11, EF Core 11.0.0-rc.1, Microsoft.EntityFrameworkCore.SqlServer
var term = "50%";
var q = db.Products.Where(p => p.Name.StartsWith(term));
Console.WriteLine(q.ToQueryString());
```

```sql
DECLARE @term_startswith nvarchar(4000) = N'50\%%';

SELECT [p].[Id], [p].[Name], [p].[Sku]
FROM [Products] AS [p]
WHERE [p].[Name] LIKE @term_startswith ESCAPE N'\'
```

EF は変数をクライアント側で評価してエスケープし、`%` を付け加えて、その結果を `@term_startswith` という名前の新しいパラメーターとして送信しました。`EndsWith` では `@term_endswith` に `N'%50\%'` が、`Contains` では `@under_contains` に `N'%a\_b%'` が入ります。`StartsWith("50%")` のような定数も同じようにエスケープされ、`LIKE N'50\%%' ESCAPE N'\'` としてインライン化されます。

エスケープ処理は `SqlServerSqlTranslatingExpressionVisitor` にあります。[`v11.0.0-rc.1.26425.128` タグ](https://github.com/dotnet/efcore/blob/v11.0.0-rc.1.26425.128/src/EFCore.SqlServer/Query/Internal/SqlServerSqlTranslatingExpressionVisitor.cs) の時点では、特殊文字のセットは 1 行で定義されています。

```csharp
// EF Core 11.0.0-rc.1, SqlServerSqlTranslatingExpressionVisitor.cs
private static bool IsLikeWildChar(char c)
    => c is '%' or '_' or '['; // See https://docs.microsoft.com/en-us/sql/t-sql/language-elements/like-transact-sql
```

`EscapeLikePattern` は、これらの文字それぞれの前と、値にすでに含まれているバックスラッシュの前にバックスラッシュを付けます。SQLite プロバイダーにも同じコードがありますが、SQLite には角かっこのクラスがないため、`IsLikeWildChar` は `%` または `_` だけです。

プロバイダー固有の注意点が 2 つあります。

- **SQLite は `Contains` にそもそも `LIKE` を使いません。** `p.Name.Contains(term)` を `instr("p"."Name", @term) > 0` に変換するので、そこではエスケープは不要です。`StartsWith` と `EndsWith` は引き続き `LIKE ... ESCAPE '\'` になります。
- **列同士の比較では `LIKE` は使われません。** `p.Name.StartsWith(p.Sku)` は SQL Server では `LEFT([p].[Name], LEN([p].[Sku])) = [p].[Sku]`、SQLite では `substr(...)` になります。パターンは行を読み込むまでわからないので、エスケープするものがありません。EF のソースコード内のコメントは、この形式は "less efficient than LIKE (i.e. StartsWith does an index scan instead of seek)" と警告しています。

ユーザー入力に対して "で始まる"、"で終わる"、"を含む" だけが必要なら、文字列メソッドを使えばそれで完了です。`EF.Functions.Like` が必要になるのは、`abc%def` のように自分で配置したワイルドカードを使いたい場合や、ユーザーのテキストをより大きなパターンの途中に埋め込む場合だけです。

## EF.Functions.Like が入力をエスケープしない理由

`EF.Functions.Like(matchExpression, pattern)` は直接的なマッピングです。[SQL Server の関数マッピングのページ](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/functions) には `@matchExpression LIKE @pattern` と記載されており、エスケープの手順はありません。これは意図的なものです。パターンにはワイルドカードが含まれることが前提であり、どの `%` があなたの意図したもので、どれがユーザー由来なのかを EF が知る方法はありません。`Like` の入力を EF が自動でエスケープするよう求めた要望 [dotnet/efcore#19118](https://github.com/dotnet/efcore/issues/19118) は not planned としてクローズされ、EF Core 11 にも公開のエスケープヘルパーは含まれていません。必要なのは 3 番目の引数を持つオーバーロードです。

```csharp
public static bool Like(this DbFunctions _, string? matchExpression, string? pattern, string? escapeCharacter);
```

このオーバーロードは `@matchExpression LIKE @pattern ESCAPE @escapeCharacter` に変換されます。つまり作業は 2 つに分かれます。C# でユーザーのテキストをエスケープし、次にどのエスケープ文字を使ったかをデータベースに伝えることです。

## EF.Functions.Like 用にユーザー入力をエスケープする手順

1. **エスケープ文字を 1 つ決めて、どこでもそれを使います。** バックスラッシュは EF が内部で使っているものと同じなので、ログに出る SQL が `StartsWith` と `Like` で同じ見た目になります。エスケープヘルパーと `escapeCharacter` 引数が一致していれば、任意の 1 文字で構いません。
2. **最初にエスケープ文字自体をエスケープします。** 先に `%` をエスケープしてからすべてのバックスラッシュを二重にすると、今追加したばかりのバックスラッシュまで二重になってしまいます。順序はエスケープ文字、次にワイルドカードでなければなりません。
3. **すべてのプロバイダーで `%` と `_` を、SQL Server では `[` もエスケープします。** `[` をエスケープしても他のプロバイダーで害はありません。SQLite と PostgreSQL はエスケープされた通常の文字をその文字として扱うので、1 つのヘルパーで 3 つすべてに対応できます。
4. **自分のワイルドカードはエスケープの後で追加します。** ヘルパーに通すのはユーザーのテキストだけです。その周りに追加する `%` はワイルドカードとして機能したままです。
5. **必ず `escapeCharacter` を渡します。** これがないと、SQL Server と SQLite にはエスケープ文字がまったく存在しません。

小さな静的クラスで 5 つすべてをカバーできます。

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
public static class LikePattern
{
    public const string EscapeCharacter = "\\";

    public static string Escape(string value, char escape = '\\')
    {
        ArgumentNullException.ThrowIfNull(value);
        return value
            .Replace(escape.ToString(), $"{escape}{escape}") // must be first
            .Replace("%", $"{escape}%")
            .Replace("_", $"{escape}_")
            .Replace("[", $"{escape}[");                      // SQL Server bracket classes
    }

    public static string Contains(string value) => $"%{Escape(value)}%";
    public static string StartsWith(string value) => $"{Escape(value)}%";
    public static string EndsWith(string value) => $"%{Escape(value)}";
}
```

次のように使います。

```csharp
// .NET 11, EF Core 11.0.0-rc.1
var term = "a_b";
var rows = await db.Products
    .Where(p => EF.Functions.Like(p.Name, LikePattern.Contains(term), LikePattern.EscapeCharacter))
    .Select(p => p.Name)
    .ToListAsync();
```

SQLite ではこれが `.param set @Contains '%a\_b%'` と `WHERE "p"."Name" LIKE @Contains ESCAPE '\'` を生成し、`a_b adapter` だけを返します。同じコードを SQL Server に対して実行すると `LIKE @Contains ESCAPE N'\'` が生成されます。残りのテストケースの結果は次のとおりです。

| 検索語 | 素朴な `Like` の結果行 (SQLite) | エスケープ済み `Like` の結果行 (SQLite) |
| --- | --- | --- |
| `50%` | `50% off sale`, `500 widgets`, `done 50%`, `done 500` | `50% off sale`, `done 50%` |
| `a_b` | `a_b adapter`, `axb adapter` | `a_b adapter` |

エスケープ版は、`[x]` に対しては `[x] marked` だけを返し (パターン `%\[x]%`)、`C:\temp` に対しては `C:\temp\logs` だけを返しました (パターン `%C:\\temp%`。パス内のバックスラッシュが二重になり、`C:tempxlogs` にはマッチしませんでした)。

ヘルパーはラムダの中で呼び出しても構いません。EF のパラメーター抽出は、列に触れないサブツリーをすべてクライアント側で評価するため、`LikePattern.Contains(term)` は .NET 内で一度だけ実行され、その結果がメソッド名にちなんだ名前 (`@Contains`) のパラメーターになります。ヘルパー自体が SQL に変換可能である必要はまったくありません。[SQL のログ](/ja/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) で読みやすいパラメーター名にしたい場合は、先にパターンをローカル変数に計算しておきます。`var pattern = LikePattern.Contains(term);` は `@pattern` として表示されます。

## escapeCharacter を忘れると何のエラーもなく 0 件が返る

エスケープの問題に気付いた人がよく次にやってしまう間違いは、検索語をエスケープしたうえで 2 引数のオーバーロードを呼び出すことです。

```csharp
// .NET 11, EF Core 11.0.0-rc.1, SQLite -- WRONG
db.Products.Where(p => EF.Functions.Like(p.Name, "%" + LikePattern.Escape("a_b") + "%"));
```

```sql
WHERE "p"."Name" LIKE '%a\_b%'
```

`ESCAPE` 句がないとバックスラッシュは通常の文字なので、データベースはリテラルの `a\_b` (`_` はワイルドカードのまま) を探し、何も見つけません。[SQLite の式に関するドキュメント](https://www.sqlite.org/lang_expr.html#like) はデフォルトのエスケープ文字が存在しないことを明記しており、SQL Server のリファレンスもエスケープ文字は "has no default" と述べています。クエリは失敗せず、単に空のリストを返すだけなので、このバグはコードレビューで見つけにくいものになっています。

PostgreSQL は例外です。PostgreSQL の `LIKE` は [バックスラッシュをデフォルトのエスケープ文字として扱う](https://www.postgresql.org/docs/current/functions-matching.html#FUNCTIONS-LIKE) ため、同じコードがたまたまそこでは動作します。これは最悪の組み合わせです。ローカルの PostgreSQL に対するテストは通り、SQL Server の本番環境では何も返りません。`escapeCharacter` を明示的に渡せば、3 つすべてで同じ動作になります。

## 別のエスケープ文字を選ぶ

バックスラッシュは `LIKE` にとって特別な文字ではなく、単なる慣習です。データが Windows のパスや正規表現の断片だらけなら、もっと珍しい文字を選びましょう。ヘルパーと引数は一致していなければなりません。

```csharp
// .NET 11, EF Core 11.0.0-rc.1, SQLite
var term = "!%";
db.Products.Where(p => EF.Functions.Like(p.Name, "%" + LikePattern.Escape(term, '!') + "%", "!"));
// .param set @p '%!!!%%'
// WHERE "p"."Name" LIKE @p ESCAPE '!'
// ROWS: Promo!%
```

`!%` は `!!!%` になりました。リテラルの `!` が `!!` に二重化され、次に `%` が `!%` になったためです。`escapeCharacter` 引数はちょうど 1 文字でなければなりません。`"ab"` を渡すと変換自体は問題なく通りますが、クエリの実行時に SQLite の `SqliteException: SQLite Error 1: 'ESCAPE expression must be a single character'` で失敗します。SQL Server も、エスケープ文字は "must evaluate to only one character" であるため、これを拒否します。`LikePattern.EscapeCharacter` のように `const` にしておけば、誰も間違った値を渡せなくなります。

## エスケープ以外の落とし穴

**大文字と小文字の区別はデータベースで決まります。** SQL Server では、`LIKE` が大文字と小文字を区別するかどうかは列の照合順序に依存し、エスケープとは無関係です。SQLite には、上の検証で表面化した罠があります。`StartsWith` は `LIKE` になり、SQLite は ASCII について大文字と小文字を区別せずに比較しますが、`Contains` は大文字と小文字を区別する `instr` になります。`50% OFF` を `StartsWith` で検索すると `50% off sale` が見つかりましたが、同じ語で `Contains` を使うと何も見つかりませんでした。SQLite でテストして SQL Server にデプロイする場合は、メソッドごとに大文字と小文字の扱いが異なることに注意してください。

**先頭の `%` はインデックスシークを台無しにします。** 値がリテラルのプレフィックスで始まるパラメーター化された `LIKE @p ESCAPE N'\'` は、SQL Server でインデックスを使えます。`%term%` は、エスケープしてもしなくても使えません。大きなテーブルで本当に "テキストのどこでも検索" が必要なら、`LIKE` にさらに負荷をかけるのではなく、SQL Server の全文検索 (`EF.Functions.Contains` / `FreeText`) を検討してください。

**1 つの変数を 2 つの文字列メソッドで再利用する場合。** EF Core 8.0.0 には、`b.Name.StartsWith(s) || b.Body.Contains(s)` が両方の比較に `Contains` のパターンを送ってしまうバグがありました ([dotnet/efcore#32432](https://github.com/dotnet/efcore/issues/32432)、8.0.2 で修正済み)。EF Core 11 は `@term_startswith = N'50\%%'` と `@term_contains = N'%50\%%'` という 2 つの別々のパラメーターを生成します。まだ 8.0.0 または 8.0.1 を使っている場合は、パッケージを更新してください。

**`StringComparison` のオーバーロードは変換されません。** `p.Name.StartsWith(term, StringComparison.OrdinalIgnoreCase)` は、RC 1 では両方のプロバイダーで `InvalidOperationException: The LINQ expression ... could not be translated` をスローします。書き換え方は [変換失敗のガイド](/ja/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/) で扱っています。このケースでの答えは、通常のオーバーロードに大文字と小文字を区別しない照合順序を組み合わせるか、`EF.Functions.Collate` を使うかのどちらかです。

**コンパイル済みクエリは問題ありません。** `StartsWith` の自動エスケープも `LikePattern` ヘルパーも通常のパラメーターを生成するので、`EF.CompileAsyncQuery` と一緒に動作します。エスケープはクエリのコンパイル時ではなく、実行ごとに行われます。検索エンドポイントを担当しているなら、[ホットパス向けのコンパイル済みクエリ](/ja/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) を参照してください。

**フィルターを組み立てるエージェントやツール。** [MCP 経由の EF Core の例](/2026/05/how-to-expose-an-ef-core-database-to-an-ai-agent-via-mcp/) のように、LLM のツールや MCP サーバーが自由形式のテキストを `EF.Functions.Like` の呼び出しに変換する場合は、モデルの引数を他のユーザー入力と同じように扱い、同じヘルパーに通してください。

## 検索ごとに適切なツールを選ぶ

- ユーザー入力に対する完全なプレフィックス、サフィックス、部分文字列の一致: `StartsWith` / `EndsWith` / `Contains`。EF Core 11 がエスケープしてくれます。
- ユーザーのテキストの周りに自分で制御するワイルドカードを置くパターン: `EF.Functions.Like(col, LikePattern.Contains(term), LikePattern.EscapeCharacter)`。
- ユーザー自身が意図的に書くパターン: 2 引数の `EF.Functions.Like`。ただし入力を検証し、SQL Server で単独の `[` がどう動作するかを考慮してください。
- 関連度順のテキスト検索: `LIKE` ではなく全文検索。

リリースする前に、対象とする各プロバイダーについて生成された SQL を一度確認してください。`ToQueryString()` なら 1 行で済み、この記事のすべてのバグを本番環境より先に見つけられたはずです。

### 次に読む

- [EF Core 11 が生成する SQL をログに出力する方法](/ja/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [修正: EF Core 11 の "The LINQ expression could not be translated"](/ja/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)
- [EF Core のホットパスでコンパイル済みクエリを使う方法](/ja/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [EF Core 11 で値コンバーターを使って enum を文字列として保存する方法](/ja/2026/08/how-to-store-an-enum-as-a-string-in-ef-core-11-with-a-value-converter/)

### 出典

- [LIKE (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/like-transact-sql), Microsoft Learn
- [関数マッピング、SQL Server プロバイダー](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/functions), EF Core ドキュメント
- [`SqlServerSqlTranslatingExpressionVisitor.cs` at v11.0.0-rc.1.26425.128](https://github.com/dotnet/efcore/blob/v11.0.0-rc.1.26425.128/src/EFCore.SqlServer/Query/Internal/SqlServerSqlTranslatingExpressionVisitor.cs), dotnet/efcore
- [dotnet/efcore#19118: Escape provider-specific symbols in user input when using EF.Functions.Like](https://github.com/dotnet/efcore/issues/19118)
- [dotnet/efcore#32432: Incorrect parameter rewriting for StartsWith/EndsWith/Contains](https://github.com/dotnet/efcore/issues/32432)
- [SQLite: LIKE 演算子](https://www.sqlite.org/lang_expr.html#like)
- [PostgreSQL: LIKE によるパターンマッチング](https://www.postgresql.org/docs/current/functions-matching.html#FUNCTIONS-LIKE)
