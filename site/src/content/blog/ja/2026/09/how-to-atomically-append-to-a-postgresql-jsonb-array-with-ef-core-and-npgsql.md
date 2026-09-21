---
title: "EF Core と Npgsql で PostgreSQL の jsonb 配列にアトミックに追加する方法"
description: "エンティティを読み込み、List.Add を呼んで保存すると、jsonb ドキュメント全体が書き換えられ、同時に行われた追加は黙って失われます。追加処理は jsonb の || 演算子を使った 1 つの UPDATE にまとめます。ExecuteSqlAsync を使うか、ExecuteUpdateAsync の中でマップした関数を使い、さらに @> によるガードで冪等にします。"
pubDate: 2026-09-21
template: how-to
tags:
  - "ef-core"
  - "ef-core-10"
  - "postgresql"
  - "npgsql"
  - "json"
  - "concurrency"
  - "how-to"
lang: "ja"
translationOf: "2026/09/how-to-atomically-append-to-a-postgresql-jsonb-array-with-ef-core-and-npgsql"
translatedBy: "claude"
translationDate: 2026-09-21
---

要点: 行を読み込み、リストに `Add` して `SaveChangesAsync` を呼ぶ方法は使わないでください。EF Core は `jsonb` ドキュメント全体をパラメーターとして送り返すため、同時に追加を行う 2 つのリクエストは互いの結果を上書きしてしまいます。代わりに、追加処理を PostgreSQL の中で行う `UPDATE` を 1 つだけ送ります: `SET "Data" = jsonb_set("Data", '{Labels}', COALESCE("Data"->'Labels', '[]') || to_jsonb(@label::text))`。これは `Database.ExecuteSqlAsync` から発行できます。あるいは、小さな関数を `HasDbFunction` でマップして `ExecuteUpdateAsync` の中から呼べば LINQ のまま書け、`jsonb_set` は EF Core 10 が生成してくれます。さらに `.Where(t => !t.Data.Labels.Contains(label))` を加えると、Npgsql がこれを `@>` に変換し、追加処理は冪等にもなります。

以下の内容はすべて .NET 10 (SDK 10.0.302) と `Npgsql.EntityFrameworkCore.PostgreSQL` 10.0.3 (EF Core 10.0.4 を取り込みます) を使い、PostgreSQL 18.4 に対して実行したものです。JSON 列は EF Core 10 が推奨する方法、つまり `ToJson()` を付けた複合型としてマップしています。ここに引用している SQL と件数はすべて実際の実行結果であり、後から再構成したものではありません。

## 20 件の同時追加で、残ったのは 3 件

モデルは次のとおりです。チケットは、ラベルとイベント履歴を保持する `jsonb` 列を持っています:

```csharp
// .NET 10, EF Core 10.0.4, Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3
public class Ticket
{
    public int Id { get; set; }
    public required string Title { get; set; }
    public required TicketData Data { get; set; }
}

public class TicketData
{
    public List<string> Labels { get; set; } = [];
    public List<TicketEvent> Events { get; set; } = [];
}

public class TicketEvent
{
    public required string Kind { get; set; }
    public DateTime At { get; set; }
}

public class AppDb : DbContext
{
    public DbSet<Ticket> Tickets => Set<Ticket>();

    protected override void OnModelCreating(ModelBuilder b)
        => b.Entity<Ticket>().ComplexProperty(t => t.Data, d => d.ToJson());
}
```

Npgsql はこれに対して `"Data" jsonb NOT NULL` を作成します。次に、多くの人が最初に書くコードを、同じ行に対して 20 個の並列タスクから、それぞれ独自の `DbContext` を使って実行します:

```csharp
// .NET 10, EF Core 10.0.4 -- the lost-update version
await using var db = new AppDb();
var t = await db.Tickets.SingleAsync(x => x.Id == id);
t.Data.Labels.Add($"l{i}");
await db.SaveChangesAsync();
```

行は最初にラベルを 1 つ持っているので、期待される結果は 21 です。実際には **3** で、3 回実行して 3 回ともそうなりました。理由は `SaveChangesAsync` が送る SQL を見ればわかります:

```sql
UPDATE "Tickets" SET "Data" = @p0
WHERE "Id" = @p1;
-- @p0='{"Labels":["hardware","urgent","via-savechanges"],"Events":[...]}'
```

EF Core は "この要素を追加せよ" とは送りません。メモリ上の複合型全体をシリアル化し、それで列を置き換えます。どのタスクも同じ初期ドキュメントを読み、自分のラベルを追加し、他の 19 件について何も知らないドキュメントを書き戻しました。最後に書いたものが勝ち、データベースは何かがおかしいことに気づきません。データベースから見れば、それぞれの `UPDATE` は完全に正当な置き換えだからです。

これは Npgsql のバグではありません。ごく普通の更新消失 (lost update) の問題であり、JSON 列ではそれがいつもより悪化します。スカラー列であれば、*異なる* 列を変更する 2 つのリクエストは衝突しません。しかしここでは、どのラベルやイベントに対する変更も、それらすべてを保持する 1 つの列を書き換えてしまいます。

## データベース内での追加がアトミックである理由

PostgreSQL の `jsonb || jsonb` 演算子は連結を行います。左辺が配列で右辺がスカラーまたはオブジェクトの場合、右辺は 1 つの要素として追加されます:

```sql
SELECT '["a"]'::jsonb || to_jsonb('b'::text);     -- ["a", "b"]
SELECT '["a"]'::jsonb || '{"k": 1}'::jsonb;       -- ["a", {"k": 1}]
```

重要なのは演算子ではなく、古い値がどこから来るかです。`SET "Data" = ... "Data" || ...` において、右辺の `"Data"` は `UPDATE` が実行される時点での行の現在の値です。デフォルトの `READ COMMITTED` 分離レベルでは、2 つのトランザクションが同じ行を更新すると、2 つ目は最初のトランザクションがコミットするまで行ロックで待機し、その後 *新しい* 行バージョンを読み直して、`WHERE` 句と `SET` 式の両方をそれに対して再評価します。そのため、どの追加も直前の追加の上に積み重なります。リトライループも、バージョン列も、読み取りの往復も必要ありません。

## 方法 1: ExecuteSqlAsync で UPDATE を 1 つ送る

最も直接的な解決策は、ステートメントを自分で書くことです:

```csharp
// .NET 10, EF Core 10.0.4, PostgreSQL 18.4
var label = "urgent";
await db.Database.ExecuteSqlAsync($$"""
    UPDATE "Tickets"
    SET "Data" = jsonb_set("Data", '{Labels}', COALESCE("Data"->'Labels', '[]'::jsonb) || to_jsonb({{label}}::text))
    WHERE "Id" = {{id}}
    """);
```

`ExecuteSqlAsync` は `FormattableString` を受け取るので、`{{label}}` と `{{id}}` は文字列連結ではなく本物のパラメーター (`@p0`、`@p1`) になります。`$$` の raw 文字列は意図的なものです。これにより、jsonb のパスリテラル `'{Labels}'` は単一の波かっこのまま保たれ、`{{...}}` が埋め込み箇所を示します。同じ 20 個の並列タスクで実行すると、このバージョンは毎回 21 個のラベルで終わります。

このステートメントの 3 つの部分には、それぞれ理由があります:

- `jsonb_set(doc, '{Labels}', newArray)` は `Labels` キーだけを置き換え、ドキュメント内の他のキーはすべて *現時点の* 状態のまま保ちます。1 ミリ秒前に別のリクエストが追加した `Events` のエントリーも含まれます。
- `COALESCE("Data"->'Labels', '[]'::jsonb)` は、`Labels` が存在する前に書き込まれた行に対応します。`NULL || anything` は `NULL` であり、新しい値が `NULL` の `jsonb_set` はドキュメント全体に対して `NULL` を返します。これは `NOT NULL` 列ではエラーになり、null 許容列ではデータ消失になります。
- パラメーターに付けた `::text` は、`to_jsonb` に具体的な型を与えます。これがないと、自分でインライン化したリテラルは `42804: could not determine polymorphic type because input has type unknown` で失敗します。

新しい履歴イベントのようなオブジェクトの追加も同じ方法で動作します。シリアル化して `jsonb` にキャストします:

```csharp
// .NET 10, EF Core 10.0.4, System.Text.Json
var ev = new TicketEvent { Kind = "escalated", At = DateTime.UtcNow };
var json = JsonSerializer.Serialize(ev);
await db.Database.ExecuteSqlAsync($$"""
    UPDATE "Tickets"
    SET "Data" = jsonb_set("Data", '{Events}', COALESCE("Data"->'Events', '[]'::jsonb) || jsonb_build_array({{json}}::jsonb))
    WHERE "Id" = {{id}}
    """);
```

結果は `{"Events": [{"At": "2026-09-21T08:00:00Z", "Kind": "escalated"}], ...}` となり、EF でチケットを読み直すと、イベントは `DateTimeKind.Utc` として具体化されました。JSON では EF のプロパティ名 (ここでは `Kind` と `At`。モデルに `HasJsonPropertyName` がない場合のデフォルト) を使ってください。EF はそのキーでドキュメントを読むからです。

## 方法 2: マップした関数と ExecuteUpdateAsync で LINQ のまま書く

raw SQL は動作しますが、本来 EF が管理しているテーブル名や列名をハードコードすることになります。EF Core 10 では `ToJson()` 複合型内のプロパティに対する `ExecuteUpdateAsync` のサポートが追加されたので、自然に試したくなるのは次のコードです:

```csharp
// Does NOT translate in EF Core 10.0.4 / Npgsql 10.0.3
await db.Tickets.Where(t => t.Id == id).ExecuteUpdateAsync(s =>
    s.SetProperty(t => t.Data.Labels, t => t.Data.Labels.Append("x").ToList()));
```

これは `The LINQ expression '...AsQueryable().Append("x")' could not be translated` で失敗し、`Concat(new[] { "y" }).ToList()` の形は `does not represent a valid value` で失敗します。Npgsql は、セッター内の JSON プリミティブコレクションに対するリスト追加の演算子を変換しません。

*実際に* 動作するのは、戻り値の型がコレクション型であるユーザー定義関数です。EF はそれを `SetProperty` の右辺に置くことを許し、自分で `jsonb_set` で包みます。関数はマイグレーションで作成します:

```csharp
// EF Core 10 migration
migrationBuilder.Sql("""
    CREATE OR REPLACE FUNCTION jsonb_append_text(arr jsonb, elem text)
    RETURNS jsonb LANGUAGE sql IMMUTABLE
    AS $$ SELECT COALESCE(NULLIF(arr, 'null'::jsonb), '[]'::jsonb) || to_jsonb(elem) $$;
    """);
```

次に、C# のスタブを宣言してマップします:

```csharp
// .NET 10, EF Core 10.0.4
public static class JsonbFn
{
    public static List<string> Append(List<string> array, string element)
        => throw new InvalidOperationException("Only usable in EF Core queries.");
}

// in OnModelCreating
b.HasDbFunction(typeof(JsonbFn).GetMethod(nameof(JsonbFn.Append))!)
    .HasName("jsonb_append_text");
```

これで呼び出し側は、型付けされた普通の EF コードになります:

```csharp
await db.Tickets.Where(t => t.Id == id).ExecuteUpdateAsync(s =>
    s.SetProperty(t => t.Data.Labels, t => JsonbFn.Append(t.Data.Labels, label)));
```

EF が生成する SQL は次のとおりです:

```sql
UPDATE "Tickets" AS t
SET "Data" = jsonb_set(t."Data", '{Labels}', COALESCE(to_jsonb(jsonb_append_text(t."Data" -> 'Labels', @label)), 'null'::jsonb))
WHERE t."Id" = @id
```

20 個の並列呼び出しで 21 個のラベル、毎回同じ結果です。すでに `jsonb` である値を囲む余分な `to_jsonb(...)` は何もしない処理で、EF が設定するすべての JSON プロパティに付け加えるものです。関数内の `NULLIF(arr, 'null'::jsonb)` は、キーがまったくないのではなく `"Labels": null` を持つドキュメントに対応します。これがないと、`'null'::jsonb || '"x"'` は黙って `[null, "x"]` を生成します。

### マイグレーションなしで同じことをする: HasTranslation

データベースオブジェクトを追加できない場合は、代わりに組み込み関数を EF に出力させることができます。`jsonb_insert(array, '{-1}', element, true)` は最後の要素の後ろに挿入するので、これは追加と同じです:

```csharp
// .NET 10, EF Core 10.0.4, Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3
using System.Linq.Expressions;
using Microsoft.EntityFrameworkCore.Query.SqlExpressions;

b.HasDbFunction(typeof(JsonbFn).GetMethod(nameof(JsonbFn.Push))!)
    .HasTranslation(a =>
    {
        var jsonb = a[0].TypeMapping;
        var arr = new SqlFunctionExpression("COALESCE",
            [
                new SqlFunctionExpression("NULLIF", [a[0], new SqlFragmentExpression("'null'::jsonb")],
                    nullable: true, argumentsPropagateNullability: [false, false], typeof(string), jsonb),
                new SqlFragmentExpression("'[]'::jsonb"),
            ],
            nullable: false, argumentsPropagateNullability: [false, false], typeof(string), jsonb);
        var elem = new SqlFunctionExpression("to_jsonb",
            [new SqlUnaryExpression(ExpressionType.Convert, a[1], typeof(string), a[1].TypeMapping)],
            nullable: true, argumentsPropagateNullability: [true], typeof(string), jsonb);
        return new SqlFunctionExpression("jsonb_insert",
            [arr, new SqlFragmentExpression("'{-1}'"), elem, new SqlFragmentExpression("true")],
            nullable: true, argumentsPropagateNullability: [false, false, true, false],
            typeof(List<string>), jsonb);
    });
```

これは次の SQL を生成します:

```sql
SET "Data" = jsonb_set(t."Data", '{Labels}', jsonb_insert(COALESCE(NULLIF(t."Data" -> 'Labels', 'null'::jsonb), '[]'::jsonb), '{-1}', to_jsonb(@lbl::text), true))
```

この変換の 2 つの細部は、スタイルではなく失敗から生まれたものです。最初のバージョンでは配列を直接 `COALESCE(a[0], '[]')` で包んでいましたが、モデル上 `Labels` は必須で null 非許容のコレクションなので、EF の null 許容性プロセッサーがその `COALESCE` を削除しました。先に `NULLIF` で包むと式が null 許容になるので `COALESCE` が残り、JSON の `null` もついでに処理できます。`Convert` ノードは `::text` キャストです。これがないと、定数を使った呼び出し (`JsonbFn.Push(t.Data.Labels, "a")`) は `'a'` を型なしでインライン化し、前述と同じ `42804` エラーになります。キャプチャした変数ではどちらでも動作しました。まさにコードレビューをすり抜けるタイプのバグです。

マイグレーションで関数を作る方法のほうがコード量が少なく、読みやすくなります。`HasTranslation` は、データベースに関数を追加できない場合にだけ使ってください。

## 追加処理を冪等にする

リトライ、at-least-once のメッセージ配信、ボタンのダブルクリックは、どれも "追加" を "2 回追加" に変えてしまいます。ガードは同じステートメントに入れます:

```csharp
// .NET 10, EF Core 10.0.4
var n = await db.Tickets
    .Where(t => t.Id == id && !t.Data.Labels.Contains(label))
    .ExecuteUpdateAsync(s => s.SetProperty(t => t.Data.Labels, t => JsonbFn.Push(t.Data.Labels, label)));
// n == 1 when the label was added, 0 when it was already there
```

Npgsql は、JSON プリミティブコレクションに対する `Contains` を包含演算子に変換します:

```sql
WHERE t."Id" = @id AND NOT ((t."Data" -> 'Labels') @> to_jsonb(@l))
```

PostgreSQL は行ロックを待機した後に `WHERE` 句を再評価するため、これは逐次実行だけでなく同時実行でも成り立ちます。20 個の並列タスクがすべて `"dup"` を追加した結果、影響を受けた行は合計でちょうど 1 行、値は `["hardware", "dup"]` となり、毎回同じでした。影響を受けた行数は "追加したかどうか" の答えにもなり、2 回目のクエリは不要です。*異なる* 行にまたがる集合のセマンティクス、たとえば "2 つのチケットが同じ外部 ID を共有しない" といった制約が必要なら、それは JSON 配列ではなく一意インデックスで扱うべきものです。

## 読み取り、変更、書き込みが本当に必要な場合

新しい要素が既存の要素に依存することもあります。たとえば "最後のイベントがすでに `closed` でなければ追加する" のようなロジックで、SQL にうまく収まらない場合です。そのときは `SaveChangesAsync` を使い続けますが、オプティミスティック同時実行制御のトークンで更新消失を検出できるようにします。PostgreSQL では、システム列 `xmin` が更新のたびに変わり、Npgsql は `[Timestamp]` を付けた `uint` プロパティでこれをマップします:

```csharp
// .NET 10, Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3
public class Ticket
{
    public int Id { get; set; }
    public required TicketData Data { get; set; }

    [Timestamp]
    public uint Version { get; set; }   // mapped to xmin, no migration column
}
```

これで古いデータによる書き込みは黙って勝つのではなく `DbUpdateConcurrencyException` をスローするようになり、再読み込みしてリトライできます。同じ 20 個の並列追加処理と、再読み込みしてリトライするループを使った結果、21 個のラベルがすべて反映されましたが、その代償として **167** 回の競合とリトライが発生しました。この数字こそ、データベース内での追加をデフォルトの推奨とする理由です。オプティミスティック同時実行制御は正しいものの、ホットな行で競合が起きるとリトライの嵐になります。

## 本番投入前に知っておきたい注意点

- **`ExecuteSqlRawAsync` と `SqlQueryRaw` は、パラメーターが 0 個でも波かっこを書式の埋め込み箇所として扱います。** `ExecuteSqlRawAsync("... jsonb_set(\"Data\", '{Labels}', ...)")` は、PostgreSQL に何かが届く前に `FormatException: Input string was not in a correct format` をスローします。波かっこを二重にする (`'{{Labels}}'`) か、前述のように `$$` の raw 文字列と補間形式の `ExecuteSqlAsync` を使ってください。
- **配列を追加すると、配列そのものではなくその要素が追加されます。** `'["a"]' || '["b"]'` は `["a", "b"]` です。追加する要素自体が配列になりうる場合は、`|| jsonb_build_array(@x::jsonb)` のように包んでください。
- **JSON 文字列に `to_jsonb` を使うと文字列になります。** `'["a"]' || to_jsonb('{"k":1}'::text)` は *テキスト* の `"{\"k\":1}"` を追加します。シリアル化したオブジェクトには `to_jsonb` ではなく `::jsonb` が必要です。
- **`jsonb_set` は存在しない親を作成しません。** `jsonb_set('{}', '{A,B}', '[1]')` は `{}` を変更せずに返します。ネストしたパスでは、親オブジェクトが存在することを確認するか、`jsonb_set` で 1 階層ずつ構築してください。
- **複合型のコレクションは、マップした関数の戻り値の型にできません。** `List<TicketEvent> PushEvent(List<TicketEvent>, string)` をマップすると、モデルのビルド時に `The DbFunction 'JsonbFn.PushEvent(...)' has an invalid return type 'List<TicketEvent>'` で失敗します。オブジェクトの配列には方法 1 を使ってください。
- **順序は呼び出し順ではなくコミット順です。** 同時に行われた追加はトランザクションがコミットされた順に反映されるため、`l11` が `l10` より前に来ることがあります。順序が重要なら、タイムスタンプや連番を一緒に追加し、読み取り時に並べ替えてください。
- **ドキュメントのサイズに注意してください。** 追加のたびに、ディスク上の `jsonb` 値全体が書き換えられます (PostgreSQL には JSON のインプレース更新がなく、大きな値は TOAST 化されます)。際限なく増える履歴は、専用のテーブルに置くべきです。
- **所有型ではこれは使えません。** EF Core の JSON に対する `ExecuteUpdate` のサポートには `ComplexProperty(...).ToJson()` が必要です。まだ `OwnsOne(...).ToJson()` を使っている場合、使えるのは方法 1 だけです。

### 次に読む

- [EF Core 11 で JSON 列をマップしてクエリする方法](/ja/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) では、この記事の前提となる `ToJson()` のマッピングを扱っています。
- [EF Core 11 における複合型と所有エンティティの比較](/ja/2026/07/complex-types-vs-owned-entities-in-ef-core-11/) では、JSON への `ExecuteUpdate` が複合型でしか動作しない理由を説明しています。
- [EF Core 11 で ExecuteUpdate と ExecuteDelete を使って一括書き込みを行う方法](/ja/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) では、変更トラッカーの死角を含め、セットベースの更新をさらに掘り下げています。
- [EF Core の ExecuteUpdate とエンティティの読み込みおよび SaveChanges の比較](/ja/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) では、2 つの書き込み経路を全般的に比較しています。
- [EF Core 11 で rowversion トークンを使ってオプティミスティック同時実行制御を実装する方法](/ja/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/) は、上記の `xmin` を使った方法の SQL Server 版です。

### 参考資料

- [JSON Functions and Operators](https://www.postgresql.org/docs/current/functions-json.html)、PostgreSQL ドキュメント (`||`、`@>`、`jsonb_set`、`jsonb_insert`)
- [Transaction Isolation: Read Committed](https://www.postgresql.org/docs/current/transaction-iso.html#XACT-READ-COMMITTED)、PostgreSQL ドキュメント
- [JSON Mapping](https://www.npgsql.org/efcore/mapping/json.html)、Npgsql EF Core プロバイダーのドキュメント
- [Concurrency Tokens](https://www.npgsql.org/efcore/modeling/concurrency.html)、Npgsql EF Core プロバイダーのドキュメント (`xmin`)
- [What's New in EF Core 10: ExecuteUpdate support for relational JSON columns](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew#executeupdate-support-for-relational-json-columns)、Microsoft Learn
- [User-defined function mapping](https://learn.microsoft.com/en-us/ef/core/querying/user-defined-function-mapping)、EF Core ドキュメント
- [`NpgsqlQuerySqlGenerator.cs` at `v10.0.3`](https://github.com/npgsql/efcore.pg/blob/v10.0.3/src/EFCore.PG/Query/Internal/NpgsqlQuerySqlGenerator.cs)、npgsql/efcore.pg
