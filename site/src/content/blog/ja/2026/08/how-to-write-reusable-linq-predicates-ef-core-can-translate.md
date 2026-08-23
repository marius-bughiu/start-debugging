---
title: "EF Core が Where、Select、OrderBy で変換できる再利用可能な LINQ 述語の書き方"
description: "bool を返すヘルパーメソッドは \"could not be translated\" を投げますが、Expression<Func<T, bool>> は投げません。LINQKit なしで EF Core 11 の式ツリーを合成、入れ子、再利用する方法を、各ケースの実際の SQL 付きで解説します。"
pubDate: 2026-08-23
tags:
  - "ef-core"
  - "linq"
  - "csharp"
  - "dotnet"
lang: "ja"
translationOf: "2026/08/how-to-write-reusable-linq-predicates-ef-core-can-translate"
translatedBy: "claude"
translationDate: 2026-08-23
---

ルールは単純です。EF Core が変換できるのは、プロバイダーに届いた時点でまだ式ツリーとして残っているものだけです。`static bool IsActive(Customer c)` というヘルパーはメソッド呼び出しノードにコンパイルされ、実行時に例外を投げます。同じロジックを `static readonly Expression<Func<Customer, bool>> IsActive` として保持すれば、きれいに変換され、合成も入れ子も他のエンティティ型への再バインドもできます。多くの解説が間違っているのは、こうしたツリーの合成に LINQKit の `AsExpandable()` が必要だという点です。必要ありません。`Expression.Invoke` は EF Core 3.1 以降変換されますし、以下の SQL はすべて EF Core 11.0.0-preview.7.26381.103 の SQL Server プロバイダーで `ToQueryString()` から取得したものです。

## bool ヘルパーメソッドが例外を投げ、式が投げない理由

読みやすいので誰もが最初に書く形から始めます。

```csharp
// EF Core 11.0.0-preview.7, C# 14
static bool IsActiveMethod(Customer c) => !c.IsDeleted && c.Orders.Count > 0;

db.Customers.Where(c => IsActiveMethod(c));
```

C# コンパイラーはこのラムダを、本体が `IsActiveMethod` を指す `MethodCallExpression` である式ツリーに変換します。EF Core はコンパイル済みメソッドの本体を覗く手段を持たないため、変換はそこで止まります。

```
System.InvalidOperationException
The LINQ expression 'DbSet<Customer>()
    .Where(c => Helpers.IsActiveMethod(c))' could not be translated. Either rewrite
the query in a form that can be translated, or switch to client evaluation explicitly
by inserting a call to 'AsEnumerable', 'AsAsyncEnumerable', 'ToList', or 'ToListAsync'.
```

これは文書化された動作です。EF Core が部分的なクライアント評価をサポートするのは最上位の射影だけで、クエリのそれ以外の場所に変換できないものがあれば例外を投げます。詳しくは [クライアント評価とサーバー評価のガイダンス](https://learn.microsoft.com/en-us/ef/core/querying/client-eval) を参照してください。別の形で同じ壁に当たったことがあるなら、切り分けの一覧は [「The LINQ expression could not be translated」の記事](/ja/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/) にまとめてあります。

同じロジックを式として保持すれば、呼び出し側は何も変わりません。

```csharp
static readonly Expression<Func<Customer, bool>> IsActive =
    c => !c.IsDeleted && c.Orders.Count > 0;

db.Customers.Where(IsActive);
```

```sql
SELECT [c].[Id], [c].[Country], [c].[IsDeleted], [c].[Name]
FROM [Customers] AS [c]
WHERE [c].[IsDeleted] = CAST(0 AS bit) AND EXISTS (
    SELECT 1
    FROM [Orders] AS [o]
    WHERE [c].[Id] = [o].[CustomerId])
```

`Queryable.Where` は `Expression<Func<T, bool>>` を受け取るので、フィールドをそのまま渡せばツリー全体が EF に渡ります。述語がメソッドの引数として届く場合も同じで、これがあらゆる specification 風の抽象の土台になります。

```csharp
static IQueryable<Customer> Filter(IQueryable<Customer> q, Expression<Func<Customer, bool>> p)
    => q.Where(p);
```

検証では同一の SQL が出力されました。述語が `Expression<Func<>>` ではなく `Func<>` になった瞬間、また例外に戻ります。

## 述語の合成: EF Core 11 では Expression.Invoke が変換される

面白いのは、独立して書かれた 2 つの述語を組み合わせる場合です。素直な書き方は失敗します。

```csharp
db.Customers.Where(c => IsActive.Compile()(c) && c.Country == "NL");
```

```
The LINQ expression 'DbSet<Customer>()
    .Where(c => Invoke(Func<Customer, bool>, c) && c.Country == "NL")'
could not be translated.
```

`Compile()` はクエリ構築時に実行され、`Func<Customer, bool>` という定数をツリーに残します。EF から見れば中身の分からないデリゲートなので、そこで諦めます。この失敗が人々を LINQKit へ向かわせてきました。

しかし、デリゲート呼び出しではなく式ノードとして呼び出しを組み立てれば、現在は動作します。

```csharp
static Expression<Func<T, bool>> And<T>(
    Expression<Func<T, bool>> a, Expression<Func<T, bool>> b)
{
    var p = Expression.Parameter(typeof(T), "x");
    return Expression.Lambda<Func<T, bool>>(
        Expression.AndAlso(Expression.Invoke(a, p), Expression.Invoke(b, p)), p);
}

static Expression<Func<Customer, bool>> InCountry(string country) => c => c.Country == country;

db.Customers.Where(And(IsActive, InCountry("NL")));
```

```sql
DECLARE @c nvarchar(4000) = N'NL';

SELECT [c].[Id], [c].[Country], [c].[IsDeleted], [c].[Name]
FROM [Customers] AS [c]
WHERE [c].[IsDeleted] = CAST(0 AS bit) AND EXISTS (
    SELECT 1
    FROM [Orders] AS [o]
    WHERE [c].[Id] = [o].[CustomerId]) AND [c].[Country] = @c
```

`AsExpandable()` も追加パッケージも不要です。EF Core のクエリパイプラインは変換前に `InvocationExpression` ノードを簡約します。EF Core 3.0 でこれを壊したリグレッションは [dotnet/efcore#17791](https://github.com/dotnet/efcore/issues/17791) として記録され 3.1 で修正されましたが、ウェブ上のアドバイスの多くは修正前のままです。

この `And` ヘルパーについて知っておきたい点が 2 つあります。1 つ目は、`PredicateBuilder` が起点にする `true` や `false` のシードにコストがないことです。`And<Customer>(c => true, InCountry("NL"))` と `Or<Customer>(c => false, InCountry("NL"))` はどちらも上と同じ `WHERE [c].[Country] = @c` を出力し、`1 = 1` のような残骸はありません。EF の式簡約器が定数を畳み込むので、蓄積ループは素直に書いて構いません。

2 つ目に、`Expression.Invoke` だけが選択肢ではありません。`ExpressionVisitor` でパラメーターを再バインドすると、より平坦なツリーになります。

```csharp
sealed class Rebind(ParameterExpression from, Expression to) : ExpressionVisitor
{
    protected override Expression VisitParameter(ParameterExpression node)
        => node == from ? to : base.VisitParameter(node);
}

public static Expression<Func<T, bool>> And<T>(
    this Expression<Func<T, bool>> a, Expression<Func<T, bool>> b)
{
    var p = a.Parameters[0];
    var right = new Rebind(b.Parameters[0], p).Visit(b.Body)!;
    return Expression.Lambda<Func<T, bool>>(Expression.AndAlso(a.Body, right), p);
}
```

検証では両方のバージョンがバイト単位で同一の SQL を生成しました。合成後のツリーを自分で調べたりさらに変換したりしたいなら、呼び出し層が挟まらない visitor を選んでください。12 行短く書きたいなら `Expression.Invoke` を選んでください。

## 述語を別のエンティティ型へ再バインドする

visitor が効いてくるのは、`Customer` の述語を `Order` のクエリに適用したくなった瞬間です。ここでは同じパラメーター上で 2 つの述語を合成しているのではなく、パラメーターをメンバーパスで置き換えています。

```csharp
public static Expression<Func<TOuter, bool>> On<TOuter, TInner>(
    this Expression<Func<TInner, bool>> inner,
    Expression<Func<TOuter, TInner>> path)
{
    var body = new Rebind(inner.Parameters[0], path.Body).Visit(inner.Body)!;
    return Expression.Lambda<Func<TOuter, bool>>(body, path.Parameters[0]);
}

db.Orders.Where(IsActive.On((Order o) => o.Customer));
```

```sql
SELECT [o].[Id], [o].[CustomerId], [o].[Total]
FROM [Orders] AS [o]
INNER JOIN [Customers] AS [c] ON [o].[CustomerId] = [c].[Id]
WHERE [c].[IsDeleted] = CAST(0 AS bit) AND EXISTS (
    SELECT 1
    FROM [Orders] AS [o0]
    WHERE [c].[Id] = [o0].[CustomerId])
```

「アクティブな顧客」の定義は 1 つだけで、両方向から適用でき、join も書いてもらえます。そのルールが再利用可能な部品というより恒久的なフィルターに近いなら、呼び出し側が忘れられないように [名前付きクエリフィルター](/ja/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/) に置くべきか検討してください。

## Select での再利用可能な射影

射影も同じルールに従いますが、失敗の仕方がもう 1 つあります。式をそのまま `Select` に渡すのは動きます。

```csharp
static readonly Expression<Func<Customer, CustomerDto>> ToDto =
    c => new CustomerDto(c.Id, c.Name, c.Orders.Count);

db.Customers.Select(ToDto);
```

```sql
SELECT [c].[Id], [c].[Name], (
    SELECT COUNT(*)
    FROM [Orders] AS [o]
    WHERE [c].[Id] = [o].[CustomerId])
FROM [Customers] AS [c]
```

`Compile()` を使って大きな射影の中に入れ子にすると動きません。射影では部分的なクライアント評価が許されるため、例外は `Where` のときとは違うものになります。

```csharp
db.Orders.Select(o => new { o.Id, Cust = ToDto.Compile()(o.Customer) });
```

```
System.InvalidOperationException
The client projection contains a reference to a constant expression of
'System.Func<Customer, CustomerDto>'. This could potentially cause a memory leak;
consider assigning this constant to a local variable and using the variable in the
query instead.
```

これは、コンパイル済みクエリプランがあなたのデリゲートを永久に保持してしまうと EF が警告しているものです。入れ子を式ノードとして組み立てれば変換されます。

```csharp
var p = Expression.Parameter(typeof(Order), "o");
var ctor = typeof(OrderDto).GetConstructor([typeof(int), typeof(CustomerDto)])!;
var body = Expression.New(ctor,
    Expression.Property(p, nameof(Order.Id)),
    Expression.Invoke(ToDto, Expression.Property(p, nameof(Order.Customer))));

db.Orders.Select(Expression.Lambda<Func<Order, OrderDto>>(body, p));
```

```sql
SELECT [o].[Id], [c].[Id], [c].[Name], (
    SELECT COUNT(*)
    FROM [Orders] AS [o0]
    WHERE [c].[Id] = [o0].[CustomerId])
FROM [Orders] AS [o]
INNER JOIN [Customers] AS [c] ON [o].[CustomerId] = [c].[Id]
```

`Expression.Invoke(ToDto, memberPath)` というイディオムがすべてです。再利用可能なラムダを、ルートのパラメーターではなく部分式に適用します。

## AsQueryable() でナビゲーション内に再利用可能な述語を適用する

`ICollection<T>.Any(Func<T, bool>)` は `IEnumerable` 側のオーバーロードなので、保持した式をナビゲーションプロパティに渡すとコンパイルが通りません。bool メソッドを渡すとコンパイルは通りますが変換に失敗します。

```csharp
db.Customers.Where(c => c.Orders.Any(o => IsBigOrderMethod(o)));
// InvalidOperationException: ... .Any(o => Helpers.IsBigOrderMethod(o))' could not be translated
```

`AsQueryable()` を挟むと、式を受け取る `Queryable` 側のオーバーロードになります。

```csharp
static readonly Expression<Func<Order, bool>> IsBigOrder = o => o.Total > 1000m;

db.Customers.Where(c => c.Orders.AsQueryable().Any(IsBigOrder));
```

```sql
SELECT [c].[Id], [c].[Country], [c].[IsDeleted], [c].[Name]
FROM [Customers] AS [c]
WHERE EXISTS (
    SELECT 1
    FROM [Orders] AS [o]
    WHERE [c].[Id] = [o].[CustomerId] AND [o].[Total] > 1000.0)
```

クエリツリーの中でナビゲーションに対して呼ぶ `AsQueryable()` はコストゼロで、EF が変換時に取り除きます。同じ手はコレクションに対する `All`、`Count`、`Select` でも使えます。`All(IsBigOrder)` は `NOT EXISTS (... AND [o].[Total] <= 1000.0)` に、`Count(IsBigOrder)` はフィルター付きの相関 `COUNT(*)` に、`Select(OrderDtoExpr).ToList()` はコレクションシェイパー用の `ORDER BY [c].[Id]` を伴う `LEFT JOIN` に変換されました。

## パラメーターとしてのソートキー、ボクシングのケースを含めて

ソートで再利用と言えば、たいていは「列名がクエリ文字列から来る」ケースです。`Queryable.OrderBy` はキーの型でジェネリックなので、素通しのヘルパーを挟めばキーは強く型付けされたままです。

```csharp
public static IOrderedQueryable<T> OrderByKey<T, TKey>(
    this IQueryable<T> q, Expression<Func<T, TKey>> key) => q.OrderBy(key);

static readonly Dictionary<string, Expression<Func<Customer, string>>> SortKeys = new()
{
    ["name"] = c => c.Name,
    ["country"] = c => c.Country,
};

db.Customers.OrderByKey(SortKeys["name"]);   // ORDER BY [c].[Name]
```

列ごとに CLR の型が違う場合は `Expression<Func<T, object>>` を使いたくなります。これは値型に対して `Convert(c.Id, Object)` ノードを強制します。EF Core 11 はこれを処理できます。

```csharp
Expression<Func<Customer, object>> key = c => c.Id;
db.Customers.OrderBy(key);   // ORDER BY [c].[Id]
```

ボクシングの変換は変換時に取り除かれます。それでも避ける価値はあります。`object` のキーは変換できないものまで黙って受け付けてしまい、キー型のコンパイル時チェックを失うからです。キー型ごとに `Dictionary<string, Expression<Func<T, TKey>>>` を用意するか、正しいジェネリック引数で `OrderByKey` を呼ぶ小さな switch を書けば、この間違いは起こり得なくなります。ソートがページング API を支えているなら、安定した順序は [keyset ページング](/ja/2026/06/how-to-do-keyset-cursor-pagination-in-ef-core-11/) の必須条件である点に注意してください。

## パラメーターをインライン化してしまう Expression.Constant の罠

これは本番でしか、しかもクエリプランキャッシュでしか表面化しないバグです。ファクトリーをラムダとして書くと、キャプチャした引数はクロージャーのフィールドになり、EF はそれをパラメーター化します。

```csharp
static Expression<Func<Customer, bool>> InCountry(string c) => x => x.Country == c;
// WHERE [c].[Country] = @c   with DECLARE @c nvarchar(4000) = N'NL';
```

同じツリーを手で組み立てるとき、自然に書いてしまうのが `Expression.Constant(c)` で、EF はそのままリテラルを出力します。

```csharp
var body = Expression.Equal(
    Expression.Property(p, nameof(Customer.Country)),
    Expression.Constant(c));       // <- inlined, not parameterized
// WHERE [c].[Country] = N'NL'
```

これで国が変わるたびに別々の SQL 文字列、別々の EF クエリキャッシュエントリ、別々の SQL Server プランが生まれます。動的なフィルタービルダーではプランキャッシュの氾濫になります。EF Core 11 で検証した対処は 2 つあります。

```csharp
// 1. EF.Parameter<T>, added in EF Core 9, forces parameterization of a constant
var efParameter = typeof(EF).GetMethod(nameof(EF.Parameter))!.MakeGenericMethod(typeof(string));
var value = Expression.Call(efParameter, Expression.Constant(c));
// WHERE [c].[Country] = @p

// 2. read the value through a field on a captured object, exactly like a compiler closure
sealed class Box { public string? Value; }
var value = Expression.Field(Expression.Constant(new Box { Value = c }), nameof(Box.Value));
// WHERE [c].[Country] = @Value
```

`EF.Constant<T>` (EF Core 8.0.2) は逆で、たとえばオプティマイザーに選択性の高い値を見せたいなど、本当にリテラルが欲しいときに使います。この 2 つは [EF Core 9 の新機能](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/whatsnew) に記載されています。自分がどちら側に落ちたか分からないときは、[EF Core が生成する SQL をログに出す](/ja/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) のが一番早く、`DECLARE @` があるかを見ます。

## Compile() はクエリの外に置く、そしてコストが高い

`Compile()` の正当な用途は、同じ述語をメモリー上のオブジェクトに対して実行することです。たとえば保存前に変更を検証する場合です。コンパイルは安くありません。.NET 11.0.100-preview.7 上でウォームアップ済みの `Stopwatch` ループ (BenchmarkDotNet ではない粗いループ計測) では、`pred.Compile()(customer)` の呼び出しが 1 操作あたり約 47.7 マイクロ秒、一度だけコンパイルしたデリゲートの呼び出しが約 2.7 ナノ秒でした。正確な数値はハードウェアで動きますが、4 桁の差は動きません。デリゲートは式の隣にキャッシュしてください。

```csharp
public static class CustomerRules
{
    public static readonly Expression<Func<Customer, bool>> IsActive =
        c => !c.IsDeleted && c.Orders.Count > 0;

    public static readonly Func<Customer, bool> IsActiveFunc = IsActive.Compile();
}
```

`IQueryable<Customer>` には `IsActive` を、すでにメモリーにあるものには `IsActiveFunc` を使います。この使い分けは [戻り値の型の選び方](/ja/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/) で説明した `IEnumerable` と `IQueryable` の境界を実務に落とし込んだもので、`public bool IsActive => !IsDeleted && Orders.Count > 0` のようなエンティティのプロパティを誰かが `Where` で使った瞬間に "Translation of member 'IsActive' on entity type 'Customer' failed" が出る理由でもあります。計算された CLR プロパティには、EF が読める式ツリーが存在しません。

プランについて最後に 1 点。式ツリーの形が違えば EF のコンパイル済みクエリキャッシュのエントリも別になるので、リクエストごとに別のツリーを組み立てる述語ビルダーは、たとえ最終的な SQL のテキストが同じでもプランを再利用しません。特定の合成クエリがホットパスを占めるなら、毎回ツリーを組み立て直すのではなく [コンパイル済みクエリ](/ja/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) で固定してください。

## 実際のコードベースでの置き場所

ほぼすべてを 2 つの形でカバーできます。選択の基準は、そのルールの持ち主が誰かです。

ルールがエンティティに属するなら、その隣に静的クラスを置くだけで十分です。`CustomerRules.IsActive`、`OrderRules.IsBig`、ファイル 1 つ、インターフェースなし。呼び出し側は `db.Customers.Where(CustomerRules.IsActive)` と書き、定義の置き場所はちょうど 1 つになります。まずはこの形から始めるべきで、ほとんどのチームはこれ以上を必要としません。

ルールがエンティティではなくユースケースに属するなら、specification オブジェクトは元が取れます。`Expression<Func<T, bool>> Criteria` に加えて任意の include と並び順を公開する小さな型で、`And`、`Or`、`Not` を上の合成ヘルパーの上に実装します。価値は抽象そのものではなく、ユースケースを持ち回せること、キャッシュ済みの `Compile()` デリゲート経由でメモリー上のオブジェクトに対して単体テストできること、そして同じツリーが SQL に変換されることにあります。

どちらを選ぶにせよ、`Where` そのものの上に抽象を作ってはいけません。チェーンした呼び出しはすでに合成されます。

```csharp
db.Customers.Where(IsActive).Where(InCountry("NL"));
```

これは `And` で合成した単一述語とまったく同じ SQL を、パラメーター名まで含めて出力しました。それぞれの `Where` はツリーの中で直前の `Where` を包み、EF はそのチェーンを `AND` を使った 1 つの `WHERE` に平坦化します。つまり合成ヘルパーが必要なのは、演算子が `Or` のとき、別のエンティティ型へ再バインドするとき、そしてコンパイル時に長さが分からないコレクションから述語を組み立てるときだけです。単純な `And` のケースは、`IQueryable<T>` に対する拡張メソッドで式のコードを一切書かずに処理できます。

```csharp
public static IQueryable<Customer> ActiveOnly(this IQueryable<Customer> q)
    => q.Where(c => !c.IsDeleted && c.Orders.Count > 0);

public static IQueryable<Customer> InCountry(this IQueryable<Customer> q, string country)
    => q.Where(c => c.Country == country);

db.Customers.ActiveOnly().InCountry("NL");
```

やはり同じ SQL です。唯一失うのは、述語を取り出してメモリー上のリストに対して使う能力で、それこそが `Expression<Func<T, bool>>` 版で得られるものです。

## 関連記事

- [Fix: EF Core 11 の "The LINQ expression could not be translated"](/ja/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)
- [EF Core 11 で名前付きクエリフィルターを論理削除とマルチテナンシーに使う方法](/ja/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/)
- [EF Core 11 が生成する SQL をログに出力する方法](/ja/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [ホットパスで EF Core のコンパイル済みクエリを使う方法](/ja/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [C# における IEnumerable vs IAsyncEnumerable vs IQueryable](/ja/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/)

## 参考資料

- [クライアント評価とサーバー評価](https://learn.microsoft.com/en-us/ef/core/querying/client-eval), EF Core ドキュメント
- [dotnet/efcore#17791: 3.0 のリグレッション、Expression.Invoke の変換](https://github.com/dotnet/efcore/issues/17791)
- [EF Core 9 の新機能: EF.Parameter と EF.Constant](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/whatsnew)
- [Queryable.Where と Queryable.OrderBy](https://learn.microsoft.com/en-us/dotnet/api/system.linq.queryable), .NET API リファレンス
- SQL はすべて `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0-preview.7.26381.103 に対して .NET SDK 11.0.100-preview.7.26381.103 上で `ToQueryString()` により取得したもので、データベース接続は不要です
