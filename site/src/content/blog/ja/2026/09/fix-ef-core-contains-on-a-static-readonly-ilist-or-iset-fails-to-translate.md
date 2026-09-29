---
title: "修正: static readonly の `IList<T>` または `ISet<T>` に対する EF Core の `Contains` を変換できない"
description: "EF Core 8、9、10 では、リストが IList、ICollection、ISet、IReadOnlySet 型の static readonly フィールドの場合、Contains を変換できません。Enumerable.Contains を明示的に呼び出すか、EF Core 11 にアップグレードしてください。"
pubDate: 2026-09-29
template: error-page
tags:
  - "errors"
  - "efcore"
  - "dotnet"
  - "linq"
lang: "ja"
translationOf: "2026/09/fix-ef-core-contains-on-a-static-readonly-ilist-or-iset-fails-to-translate"
translatedBy: "claude"
translationDate: 2026-09-29
---

`Where(x => AllowedCodes.Contains(x.Code))` が `The LINQ expression ... could not be translated` と `Translation of method 'System.Linq.Enumerable.Contains' failed` をスローする場合は、`AllowedCodes` の宣言を確認してください。ほぼ間違いなく、`IList<T>`、`ICollection<T>`、`ISet<T>`、`IReadOnlySet<T>`、`IImmutableSet<T>`、または `FrozenSet<T>` 型の `static readonly` フィールドです。SQL を変えずに済む最も手早い修正は、LINQ 演算子を明示的に呼び出すことです: `Enumerable.Contains(AllowedCodes, x.Code)`。根本的な修正は EF Core 11 で、dotnet/efcore#36757 がこれらの形を拒否するクエリルートのチェックを修正しました。以下の各パターンは、`Microsoft.EntityFrameworkCore.Sqlite` 8.0.21、9.0.19、10.0.12、11.0.0-rc.1.26425.128 で計測しました。最初の 3 つは同じ形で失敗します。EF Core 11 RC 1 ではすべて変換できます。

## エラーの詳細

`static readonly IList<string>` の場合に、.NET 10 上の EF Core 10.0.12 で発生する例外は次のとおりです。

```
System.InvalidOperationException: The LINQ expression 'DbSet<Order>()
    .Where(o => (IList<string>)List<string> { "Open", "Pending" }
        .Contains(o.Status))' could not be translated. Additional information: Translation of method 'System.Linq.Enumerable.Contains' failed. If this method can be mapped to your custom function, see https://go.microsoft.com/fwlink/?linkid=2132413 for more information. Either rewrite the query in a form that can be translated, or switch to client evaluation explicitly by inserting a call to 'AsEnumerable', 'AsAsyncEnumerable', 'ToList', or 'ToListAsync'. See https://go.microsoft.com/fwlink/?linkid=2101038 for more information.
   at Microsoft.EntityFrameworkCore.Query.QueryableMethodTranslatingExpressionVisitor.Translate(Expression expression)
   at Microsoft.EntityFrameworkCore.Query.QueryCompilationContext.CreateQueryExecutorExpression[TResult](Expression query)
```

このメッセージには 2 つの手がかりがあります。1 つ目はキャストです。コレクションが `(IList<string>)List<string> { "Open", "Pending" }` と表示されています。これは、EF がすでにフィールドを値(定数)として評価し、宣言された型へのキャストで包んだことを意味します。2 つ目はメソッド名です。書いたのはインスタンスメソッドの `IList<T>.Contains` ですが、メッセージには `Enumerable.Contains` と出ています。EF は `ICollection<T>.Contains` の呼び出しを、変換の前に LINQ 演算子へ書き換えます。つまり、メソッドが問題なのではありません。問題は、EF がそのメソッドに渡す引数です。

フィールドが `IReadOnlySet<T>` または `IImmutableSet<T>` 型の場合、メッセージ中のメソッド名は `System.Collections.Generic.IReadOnlySet<string>.Contains` または `System.Collections.Immutable.IImmutableSet<string>.Contains` に変わります。これらのインターフェースは `ICollection<T>` を継承しないため、EF は呼び出しを書き換えません。メッセージが違うだけで、同じバグです。

## static readonly フィールドでは失敗し、ローカル変数では失敗しない理由

これには 2 つのステップがあり、両方が起きたときにだけバグが現れます。

**ステップ 1: EF は `static readonly` フィールドを定数としてインライン化します。** 変換の前に、EF の funcletizer がクエリを走査し、データベースに依存しないものをすべて評価します。キャプチャされたローカル変数、インスタンスフィールド、static プロパティはクエリパラメーターになります。`readonly`(`FieldInfo.IsInitOnly`)の static フィールドは変化しない値として扱われるため、EF は一度だけ評価して定数としてインライン化します。EF Core 10 では [`ExpressionTreeFuncletizer.VisitMember`](https://github.com/dotnet/efcore/blob/release/10.0/src/EFCore/Query/Internal/ExpressionTreeFuncletizer.cs) でこれを確認できます。static メンバーは、init-only でない限りキャプチャされた変数としてマークされます。EF はこの定数を作るとき、値の実行時の型(`List<string>`)で型付けし、宣言された型(`IList<string>`)と異なる場合は、その型へ戻す `Convert` ノードを追加します。

**ステップ 2: クエリルートのチェックは 1 種類のキャストしか取り除きません。** インメモリのコレクションに対する `Contains` を変換するために、EF はコレクションをインラインのクエリルートに変え、さらに `IN (...)` にします。EF Core 8、9、10 では、[`QueryRootProcessor.VisitQueryRootCandidate`](https://github.com/dotnet/efcore/blob/release/10.0/src/EFCore/Query/QueryRootProcessor.cs) は、変換先の型がちょうど `IEnumerable<T>` の場合にだけ `Convert` を取り除きます。

```csharp
// EF Core 10.0.x, src/EFCore/Query/QueryRootProcessor.cs
if (expression is UnaryExpression { NodeType: ExpressionType.Convert } convertExpression
    && convertExpression.Type.GetGenericTypeDefinition() == typeof(IEnumerable<>))
{
    candidateExpression = convertExpression.Operand;
}
```

`IList<string>` への `Convert` は一致しないため、コレクションはクエリルートとして認識されず、`Contains` は "could not be translated" に行き着きます。

これを踏まえると、成功と失敗のパターンが理解できます。

- `List<T>`、`HashSet<T>`、`T[]` のフィールドは、宣言された型と実行時の型が同じなので動作します。EF は `Convert` を追加しません。
- `IEnumerable<T>`、`IReadOnlyList<T>`、`IReadOnlyCollection<T>` のフィールドは、いずれも独自の `Contains` を宣言していないため動作します。呼び出しは `Enumerable.Contains` にバインドされ、コンパイラーが引数を `IEnumerable<T>` に変換し、EF が生成する定数は `IEnumerable<T>` にキャストされます。これは古いチェックが受け入れる唯一の形です。
- `IList<T>`、`ICollection<T>`、`ISet<T>`、`IReadOnlySet<T>`、`IImmutableSet<T>` は、`Contains` を宣言しているため失敗します。C# は拡張メソッドよりインスタンスメソッドを優先するので、キャストはインターフェース型のまま残ります。
- `FrozenSet<T>` は具象クラスなのに失敗します。抽象クラスだからです。実行時の値は内部のサブクラスであり、やはり `Convert` が生成されます。これが dotnet/efcore#36496 で報告されたケースで、それを修正した PR がインターフェースも合わせて修正しました。
- キャプチャされたローカル変数、readonly でない static フィールド、static プロパティは、定数ではなくパラメーターになるため、すべて動作します。パラメーターの経路にはこのバグはありませんでした。

これはリグレッションではありません。`IReadOnlySet<T>` 版の最初の報告は EF Core 7 まで遡り、dotnet/efcore#38839 は 7.0.20 から 10.0.11 まででの再現を示しています。

## 最小の再現コード

```csharp
// .NET 10, C# 14, Microsoft.EntityFrameworkCore.Sqlite 10.0.12
using Microsoft.EntityFrameworkCore;

using var db = new ShopContext();
db.Database.EnsureDeleted();
db.Database.EnsureCreated();
db.Orders.AddRange(
    new Order { Status = "Open" },
    new Order { Status = "Pending" },
    new Order { Status = "Shipped" });
db.SaveChanges();

// Throws InvalidOperationException on EF Core 8, 9 and 10
var active = db.Orders
    .Where(o => OrderRules.ActiveStatuses.Contains(o.Status))
    .ToList();

Console.WriteLine(active.Count);

public static class OrderRules
{
    public static readonly IList<string> ActiveStatuses = new List<string> { "Open", "Pending" };
}

public class Order
{
    public int Id { get; set; }
    public string Status { get; set; } = "";
}

public class ShopContext : DbContext
{
    public DbSet<Order> Orders => Set<Order>();

    protected override void OnConfiguring(DbContextOptionsBuilder options)
        => options.UseSqlite("Data Source=shop.db");
}
```

`IList<string>` を `List<string>` に変える、`readonly` を外す、またはフィールドを `{ get; }` プロパティにすると、同じクエリが動作します。多くの場合、このバグはこうして見つかります。コードレビューで「具象型ではなくインターフェースを公開しましょう」や「そのフィールドを readonly にしましょう」と指摘され、何か月も動いていたクエリが壊れるのです。

## EF Core 8、9、10、11 での宣言ごとの動作

各 EF バージョンの SQLite に対して、形ごとに 1 つずつプローブを実行しました。EF Core 8 と 9 のパッケージは .NET 10 ランタイムで実行しました。EF Core 11 RC 1 は .NET 11 RC 1 で実行しました。"constant" は EF が値を SQL にインライン化したことを、"parameter" はパラメーターとして送信したことを意味します。

| 宣言 | EF 8.0.21 | EF 9.0.19 | EF 10.0.12 | EF 11 RC 1 |
|---|---|---|---|---|
| `static readonly IList<T>` | 失敗 | 失敗 | 失敗 | constant |
| `static readonly ICollection<T>` | 失敗 | 失敗 | 失敗 | constant |
| `static readonly ISet<T>` | 失敗 | 失敗 | 失敗 | constant |
| `static readonly IReadOnlySet<T>` | 失敗 | 失敗 | 失敗 | constant |
| `static readonly IImmutableSet<T>` | 失敗 | 失敗 | 失敗 | constant |
| `static readonly FrozenSet<T>` | 失敗 | 失敗 | 失敗 | constant |
| `static readonly IReadOnlyList<T>`、`IReadOnlyCollection<T>`、`IEnumerable<T>` | constant | constant | constant | constant |
| `static readonly List<T>`、`HashSet<T>`、`T[]` | constant | constant | constant | constant |
| `static IList<T>`(readonly でない)または static プロパティ | parameter | parameter | parameter | parameter |
| キャプチャされたローカルの `IList<T>` | parameter | parameter | parameter | parameter |
| `EF.Constant(localIList).Contains(...)` | 失敗 | constant | constant | constant |

最後の行は、知っておく価値のある似たケースです。EF Core 8 では、`EF.Constant` を使ってローカルの `IList<T>` を強制的に定数にすると、同じバグに当たります。EF Core 9 以降では、`EF.Constant` は別の経路を通り、動作します。

## 修正方法(推奨順)

### 1. EF Core 11 にアップグレードする

修正は [dotnet/efcore#36757](https://github.com/dotnet/efcore/pull/36757) で、2025-09-24 に `main` にマージされ、EF Core 11 で提供されます。`IEnumerable` に代入可能な型への `Convert` をすべて、再帰的に取り除くようにチェックを変更しています。

```csharp
// EF Core 11.0, src/EFCore/Query/QueryRootProcessor.cs
if (expression is UnaryExpression { NodeType: ExpressionType.Convert } convertExpression
    && convertExpression.Type.IsAssignableTo(typeof(IEnumerable)))
{
    return VisitQueryRootCandidate(convertExpression.Operand, elementClrType);
}
```

バックポートはされていません。`release/10.0` ブランチには依然として `typeof(IEnumerable<>)` の比較が残っており、10.0.12 でも失敗します。dotnet/efcore#35024(`IList`/`ICollection` の報告)はマイルストーン 11.0.0 に設定されており、#38839 はその重複としてクローズされました。EF Core 10 LTS を使っている場合は、11 に移行するまで、以下の書き換えのいずれかを使う計画を立ててください。

### 2. `Enumerable.Contains` を明示的に呼び出す

EF Core 8、9、10 では、これを 1 行の修正として推奨します。EF Core 11 で得られるのとまったく同じ SQL になるからです。

```csharp
// .NET 10, Microsoft.EntityFrameworkCore.Sqlite 10.0.12
var active = db.Orders
    .Where(o => Enumerable.Contains(OrderRules.ActiveStatuses, o.Status))
    .ToList();

// WHERE "o"."Status" IN ('Open', 'Pending')
```

静的メソッドを直接呼び出すと、コンパイラーがフィールドを `IEnumerable<string>` に変換するため、EF の定数は `IEnumerable<T>` にキャストされた状態で届き、古いチェックを通過します。私の実行では、`IReadOnlySet<T>` と `IImmutableSet<T>` を含む、失敗していた 6 つの形すべてで動作しました。メソッド構文がよければ、`OrderRules.ActiveStatuses.AsEnumerable().Contains(o.Status)` でも同じことができます。`OrderRules.ActiveStatuses.Any(s => s == o.Status)` も同じ `IN` リストに変換されますが、読みにくいため、この問題を回避するためだけに使うことはお勧めしません。

トレードオフが 1 つあります。`ISet<T>` や `FrozenSet<T>` に対して、通常の LINQ to Objects で `Enumerable.Contains` を使うと、ハッシュ検索が使われなくなります。EF のクエリ内では、その呼び出しは .NET 上で実行されず、SQL を記述するだけなので、問題になりません。

### 3. 宣言する型を変更する

コレクションをクエリでしか使わないなら、`IReadOnlyCollection<T>`、`IReadOnlyList<T>`、または配列として宣言してください。3 つとも読み取り専用で、すべてのバージョンで変換できます。

```csharp
// .NET 10, Microsoft.EntityFrameworkCore 10.0.12
public static class OrderRules
{
    public static readonly IReadOnlyList<string> ActiveStatuses = ["Open", "Pending"];
}
```

"本物の" 不変性を得るために `FrozenSet<T>` へ切り替えるのはやめてください。EF Core 8 から 10 では、前述の理由で失敗します。

### 4. 代わりに EF に値をパラメーター化させる

フィールドをローカル変数にコピーするか、`static` プロパティにすると、EF は値を定数ではなくパラメーターとして送信します。

```csharp
// .NET 10, Microsoft.EntityFrameworkCore.Sqlite 10.0.12
var statuses = OrderRules.ActiveStatuses;
var active = db.Orders.Where(o => statuses.Contains(o.Status)).ToList();

// EF Core 10: WHERE "o"."Status" IN (@statuses1, @statuses2)
// EF Core 8/9 on SQLite: WHERE "o"."Status" IN (SELECT "s"."value" FROM json_each(@__statuses_0) AS "s")
```

これは動作しますが、SQL が変わります。定数の経路が存在する理由を思い出してください。値が変化しないので、インライン化するとデータベースに固定のリテラルリストを渡せます。これはインデックスの利用とプランのキャッシュに最適な形です。短いステータスコードのリストなら、定数のほうが優れた SQL になります。この選択肢は、リストが実行時に本当に変わりうる場合に使い、変換のバグを回避するためだけに使うのは避けてください。それぞれの場合に EF が何を生成するかを確認したいときは、変更の前後で [EF Core が生成する SQL をログ出力](/ja/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)してください。

## 誤ってこのページにたどり着くバリエーション

- **C# 14 に移行した後の配列での `Translation of method 'System.MemoryExtensions.Contains' failed`**。これは first-class の span オーバーロード解決の変更であり、このバグではありません。[C# 14 の span オーバーロード解決の修正](/ja/2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans/)を参照してください。
- **`ids.HasItem(x.Id)` のような、自分で書いたメソッドに対する一般的な "could not be translated"**。どのコレクション型を使っても、EF はメソッドの中身を見ることができません。一般的な原因と書き換えは [EF Core 11 での LINQ 式を変換できないエラー](/ja/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)にあり、述語ロジックを安全に再利用する方法は [EF Core が変換できる再利用可能な LINQ 述語の書き方](/ja/2026/08/how-to-write-reusable-linq-predicates-ef-core-can-translate/)にあります。
- **`An exception was thrown while attempting to evaluate a LINQ query parameter expression`**。これは、funcletizer がフィールドまたはプロパティの getter を実行し、その getter が例外をスローしたときに発生します。同じ段階で失敗しますが、理由は異なります。[パラメーター式の評価に関する修正](/ja/2026/08/fix-an-exception-was-thrown-while-attempting-to-evaluate-a-linq-query-parameter-expression/)を参照してください。
- **コンパイル済みクエリ(`EF.CompileQuery`)内の同じ `static readonly IList<T>`**。コンパイル済みクエリも同じ funcletizer とクエリルートのステップを通ります。EF Core 10.0.12 で同じように失敗することを確認しており、`Enumerable.Contains` で修正できます。[ホットパスでコンパイル済みクエリを使う方法](/ja/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)を参照してください。

## 関連記事

- [修正: EF Core 11 で LINQ 式を変換できない](/ja/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)
- [EF Core が変換できる再利用可能な LINQ 述語の書き方](/ja/2026/08/how-to-write-reusable-linq-predicates-ef-core-can-translate/)
- [EF Core 11 が生成する SQL をログ出力する方法](/ja/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [C# 14 の span によるオーバーロード解決の破壊的変更への対処](/ja/2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans/)
- [ホットパスで EF Core のコンパイル済みクエリを使う方法](/ja/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)

## 参考資料

- [dotnet/efcore#35024: Query could not be translated when using a static ICollection/IList field](https://github.com/dotnet/efcore/issues/35024)、マイルストーン 11.0.0。
- [dotnet/efcore#38839: Contains on a constant collection fails when declared as ICollection/IList/ISet/IReadOnlySet/IImmutableSet](https://github.com/dotnet/efcore/issues/38839)、重複としてクローズ。7.0.20 から 10.0.11 までのバージョン表付き。
- [dotnet/efcore#36757: Fix handling of readonly fields using abstract classes (i.e. FrozenSet) in parameters for primitive collections](https://github.com/dotnet/efcore/pull/36757)、修正本体、2025-09-24 にマージ。
- [`release/10.0` の `QueryRootProcessor.cs`](https://github.com/dotnet/efcore/blob/release/10.0/src/EFCore/Query/QueryRootProcessor.cs) と [`release/10.0` の `ExpressionTreeFuncletizer.cs`](https://github.com/dotnet/efcore/blob/release/10.0/src/EFCore/Query/Internal/ExpressionTreeFuncletizer.cs)。
- [What's new in EF Core 10: improved translation for parameterized collections](https://learn.microsoft.com/ef/core/what-is-new/ef-core-10.0/whatsnew#improved-translation-for-parameterized-collection)。
