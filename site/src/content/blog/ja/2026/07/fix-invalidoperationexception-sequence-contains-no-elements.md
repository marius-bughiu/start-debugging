---
title: "解決: System.InvalidOperationException: Sequence contains no elements"
description: "この例外は、空のシーケンスに対して .First() や .Single() を呼び出したことを意味します。FirstOrDefault/SingleOrDefault で null をチェックするか、クエリをガードするか、ソースが空になる原因を修正します。"
pubDate: 2026-07-21
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "linq"
  - "ef-core"
lang: "ja"
translationOf: "2026/07/fix-invalidoperationexception-sequence-contains-no-elements"
translatedBy: "claude"
translationDate: 2026-07-21
---

`System.InvalidOperationException: Sequence contains no elements` は、結果的に空だったシーケンスに対して `.First()`、`.Single()`、`.Last()`、またはそれらの集計系の仲間（`.Average()`、`.Max()`、`.Min()`）を呼び出したことを意味します。演算子は要素を1つ返すと約束したのに1つもなかったため、例外を投げました。修正の方針は、その呼び出しにとって「空」が何を意味すべきかを決めることです。空が正常な結果なら、`.FirstOrDefault()` / `.SingleOrDefault()` に切り替え、返ってくる `null`（または既定値）を処理します。空がバグなら、その地点でシーケンスが決して空にならないようにクエリやデータを修正します。これは .NET 11、C# 14、EF Core 11.0.0 で検証していますが、メッセージと動作は LINQ が .NET Framework 3.5 で登場して以来安定しているため、このガイドはあらゆるバージョンに当てはまります。

## コンテキストの中のエラー

`System.Linq` の内部から投げられる完全な例外は次のようになります。

```
System.InvalidOperationException: Sequence contains no elements
   at System.Linq.ThrowHelper.ThrowNoElementsException()
   at System.Linq.Enumerable.First[TSource](IEnumerable`1 source)
   at MyApp.OrderService.GetLatest() in /src/OrderService.cs:line 42
```

手がかりは最上部のフレーム `System.Linq.ThrowHelper.ThrowNoElementsException` です。これがスタックトレースに見えるなら、要素を返す LINQ 演算子が空のソースに対して実行されたということです。LINQ は同じクラスから密接に関連する4つのメッセージを投げ、それぞれ意味が異なるため、正確な文言は検索において重要です。

- `Sequence contains no elements` -- 空のソースに対する `.First()`、`.Single()`、`.Last()`（述語なし）。
- `Sequence contains no matching element` -- 何も一致しなかった `.First(predicate)`、`.Single(predicate)`、`.Last(predicate)`。
- `Sequence contains more than one element` -- 2つ以上の項目を持つソースに対する `.Single()`。
- `Sequence contains more than one matching element` -- 複数の項目が一致した `.Single(predicate)`。

この記事は最初のものについてです。他はバリアントのセクションで扱います。間違ったものにたどり着くと時間を無駄にするからです。

## なぜこれが起きるのか

`.First()` と `.Single()` は契約を持つ演算子です。戻り値の型は null 非許容の `TSource` なので、例外を投げる以外に「ここには何もない」と伝える手段がありません。ソースが空のときは返すべき要素がなく、`default(TSource)` を返すのは参照型にとって嘘になります（シグネチャが値を約束していた場所で `null` を受け取ってしまいます）。そのためランタイムは代わりに `InvalidOperationException` を投げます。これはバグではなく意図的な設計上の選択です。`*OrDefault` のバリアントは、まさに空が許容される場合のために存在します。

紛らわしいのは、シーケンスが空になる理由が呼び出し箇所からは見えないことがよくある点です。上流の `Where` フィルターがすべての行を取り除いた、データベースのテーブルにまだ一致するレコードがない、コレクションがクリアされた、あるいは前段の `await` が黙って失敗したために一度も設定されなかった、などです。例外は `.First()` の行で発火しますが、本当の原因はその3行前（あるいは3つのメソッド呼び出し前）にあります。だからこそ「とりあえず try/catch で包む」は正しい直感であることがめったにありません。症状を飲み込むのではなく、シーケンスがなぜ空なのかを知りたいのです。

## 最小限の再現

これを投げる最小のコードです。

```csharp
// .NET 11, C# 14
var numbers = new List<int>();     // empty
int first = numbers.First();       // System.InvalidOperationException: Sequence contains no elements
```

フィルターがすべてを除去したときにも同じことが起こり、こちらのほうがはるかに一般的な実際の形です。

```csharp
// .NET 11, C# 14
var orders = new List<Order>
{
    new(Id: 1, Status: "shipped"),
    new(Id: 2, Status: "shipped"),
};

// No pending orders exist, so the filtered sequence is empty.
Order next = orders.First(o => o.Status == "pending");
// System.InvalidOperationException: Sequence contains no matching element
```

2つ目のメッセージが `no matching element` のバリアントになっているのは、述語が渡されたからです。どちらも同じバグの系統から来ています。少なくとも1つの要素がそこにあると仮定したのに、なかったのです。

## 詳細な解決策

これらの選択肢を順番に検討してください。最初の2つでほぼすべての実際のケースをカバーできます。

### 1. FirstOrDefault / SingleOrDefault を使い、空のケースを処理する

空のシーケンスが正当な結果である場合（まだ行がない、任意のルックアップ、見つからないこともある検索）、`*OrDefault` のオーバーロードに切り替え、返ってくるものをチェックします。

```csharp
// .NET 11, C# 14
Order? next = orders.FirstOrDefault(o => o.Status == "pending");
if (next is null)
{
    // No pending order. Handle it: return early, use a fallback, log, whatever fits.
    return;
}
Process(next);
```

`FirstOrDefault` はシーケンスが空のとき `default(TSource)` を返します。参照型なら `null`、`int` なら `0`、構造体なら `default` です。null 許容注釈が有効なコードベース（`<Nullable>enable</Nullable>`、新しい .NET 11 テンプレートでの既定）では、コンパイラは結果を `Order?` として型付けし、null をチェックするまで指摘し続けます。これはまさにあなたが欲しい安全性です。このチェックを飛ばさないでください。`First` を `FirstOrDefault` に置き換えてすぐに結果を逆参照するのは、`InvalidOperationException` を1行あとの `NullReferenceException` に交換するだけです。null 許容の警告が雑音に感じられるなら、それはコンパイラが本当にやるべき作業を指し示しているのであり、[CS8618 と null 非許容プロパティ](/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/) に直接つながります。

.NET 6 以降には、独自の既定値を指定できるオーバーロードもあり、妥当なフォールバックがある場合は別途 null チェックを書くよりすっきりします。

```csharp
// .NET 11, C# 14 -- FirstOrDefault(predicate, defaultValue) added in .NET 6
Order next = orders.FirstOrDefault(o => o.Status == "pending", Order.None);
```

### 2. First を呼ぶ前にシーケンスをガードする

最初の要素が本当に必要だが、存在する場合に限るというときは、先に空かどうかをチェックします。メモリ上のコレクションなら `Count` または `Any()` で十分です。

```csharp
// .NET 11, C# 14
if (orders.Count > 0)
{
    Order first = orders.First();   // safe: we know it is non-empty
    Process(first);
}
```

`List<T>` や配列のように `ICollection<T>` を実装するものには `Count`（または `Count > 0`）を優先してください。O(1) だからです。安価にカウントを得られない遅延評価の `IEnumerable<T>` には `.Any()` を使います。遅延シーケンスに対して `if (orders.Count() > 0)` と書かないでください。`Count()` は全体を列挙しますが、`Any()` は最初の要素で止まります。

### 3. シーケンスが空になる原因を修正する

空がバグであって正当な状態ではないこともあります。`orders.First(o => o.Status == "pending")` が常に行を見つけるはずなのに見つけられない場合、本当の修正は上流にあります。フィルターが厳しすぎる、大文字小文字の不一致（`"Pending"` と `"pending"`）、行を落とした結合、あるいは一度も挿入されなかったデータです。シーケンスが空になってよいと確認したあとにのみ、ここで `*OrDefault` に頼ってください。「これは決して空になってはならない」ケースを `FirstOrDefault` で覆い隠すのは、本物のデータやロジックのエラーを隠し、クラッシュを診断しにくい場所へ移すことになります。

### 4. 集計には null 許容オーバーロードまたは DefaultIfEmpty を使う

`.Average()`、`.Max()`、`.Min()`、`.Sum()` は同じ落とし穴を共有します。`.Average()` と `.Max()`/`.Min()` の値型版は、空のソースに対して `Sequence contains no elements` を投げます（`.Sum()` は 0 を返し、それはそれで別の驚きです）。すっきりした解決策が2つあります。

```csharp
// .NET 11, C# 14
var prices = new List<int>();

// Option A: project to a nullable so the aggregate returns null instead of throwing.
double? avg = prices.Average(p => (int?)p);   // null when empty, no exception

// Option B: supply a fallback element before aggregating.
int max = prices.DefaultIfEmpty(0).Max();     // 0 when empty
```

`DefaultIfEmpty` は汎用の脱出ハッチです。ソースが空のときに単一の既定要素を生成するので、`.First()` を含む後続のどの演算子も少なくとも1つの項目を見ることになります。

## 落とし穴とバリアント

いくつかの状況は、メッセージが明示しない理由で、この例外や近い親戚を生み出します。

- **`no matching element` は同じ原因を持つ別のメッセージです。** 空のソースに対する `.First()` は `Sequence contains no elements` と言い、何にも一致しない `.First(predicate)` は `Sequence contains no matching element` と言います。投げるヘルパーは異なりますが、修正は同一で、`FirstOrDefault(predicate)` と null チェックです。ソースに行があっても述語が決して一致しないなら、`First` に渡されるシーケンスは実質的に空です。

- **`.Single()` は2つの異なるメッセージを投げます。** `.Single()` は*ちょうど1つ*の要素を保証するため、2通りの失敗があり得ます。0個のときは `Sequence contains no elements`、2個以上のときは `Sequence contains more than one element` です。「more than one」のバリアントが見えているなら、`FirstOrDefault` は修正になりません。一意性の仮定が間違っている（`WHERE` 句の欠落、キーの重複）か、複数のうち1つだけが欲しいので `First` を使うべきかのどちらかです。2つ目の一致それ自体が投げる価値のあるバグである場合にのみ `Single` を使ってください。

- **EF Core は `First`/`Single` から同じものを投げ、それらの非同期版も同様です。** `dbContext.Orders.First(o => o.Id == id)` は `SELECT TOP(1)` に変換され、一致する行がないと `Sequence contains no elements` を投げます。`FirstAsync` と `SingleAsync` も同一に投げます。修正は `FirstOrDefaultAsync` / `SingleOrDefaultAsync` に null チェックを加えることです。これらはデータベースに対して実行されるため、空の結果はしばしば正常です（行が削除された、id が間違っている）。したがって非同期の `*OrDefault` オーバーロードが通常あなたの求めるものです。LINQ 演算子がメモリ上でも SQL としてでも同じ動作をする理由は [IEnumerable vs IAsyncEnumerable vs IQueryable](/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/) を参照してください。

- **値型シーケンスに対する `FirstOrDefault` は null ではなく 0 を返します。** `List<int>` の場合、空のリストに対する `FirstOrDefault()` は `0` を返し、これは有効な `int` であって、実際の最初の要素が `0` であるのと区別がつきません。「空」と「最初の値がたまたま既定値だった」を区別する必要があるなら、null 許容に射影する（`.Select(x => (int?)x).FirstOrDefault()`）か、既定のセンチネル値に頼らず `.Any()` でガードしてください。

- **空のシーケンスは、欠落したデータではなく、誤って変換されたクエリから来ることがあります。** EF Core では、フィルターの一部を黙ってクライアント側で評価するクエリや、そもそも変換できなかったクエリが、期待とは異なる（多くは空の）結果セットを返すことがあります。データベースに対する `First` が例外を投げ、その行が存在すると確信しているなら、クエリが意図どおりに変換されたかを確認してください。この失敗モードは [LINQ 式を変換できませんでした](/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/) で扱っています。

- **try/catch で包むと本当の問いが覆い隠されます。** `First` の呼び出しの周りで `InvalidOperationException` を捕捉すれば技術的にはクラッシュを止められますが、無関係な `InvalidOperationException`（たとえば列挙中にコレクションが変更されたエラー）も捕捉してしまい、シーケンスがなぜ空だったのかについて何も教えてくれません。`*OrDefault` に明示的な分岐を加えるほうを優先してください。より高速（例外機構なし）で、範囲が狭く、自己文書化されています。

心に留めておくべきメンタルモデルはこうです。`.First()` と `.Single()` は要素が存在するという表明です。`Sequence contains no elements` はその表明が失敗したものです。空のケースが正当かどうかを決めてください。正当なら、それを `FirstOrDefault`/`SingleOrDefault` で表現し、返ってくる既定値を処理します。正当でないなら、呼び出し箇所で取り繕うのではなく、その地点でシーケンスが決して空にならないよう、上流でクエリやデータを修正してください。

## 関連

- [解決: EF Core 11 で LINQ 式を変換できませんでした](/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)：空の結果が、期待どおりに実行されなかったクエリから来る場合に。
- [C# における IEnumerable vs IAsyncEnumerable vs IQueryable](/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/)：`First` がメモリ上とデータベースに対して同じ動作をする理由と、クエリが実際にいつ実行されるかについて。
- [解決: CS8618 null 非許容プロパティは非 null 値を含む必要があります](/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/)：`FirstOrDefault` が返す null 許容の結果を処理するために。
- [.NET 11 における LINQ FullJoin とタプルを返す結合](/2026/06/linq-fulljoin-tuple-returning-joins-dotnet-11-preview-5/)：シーケンスを空にしてしまう行を落とさずに結合結果を整形するために。

## 出典

- Microsoft Learn, [Enumerable.First Method](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.first)（ソースシーケンスが空、または述語に一致する要素がないとき `InvalidOperationException` を投げる。代わりに既定値を返すには `FirstOrDefault` を使う）。
- Microsoft Learn, [Enumerable.Single Method](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.single)（シーケンスが空、複数の要素を含む、または一致する要素がないときに投げる）。
- Microsoft Learn, [Enumerable.FirstOrDefault Method](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.firstordefault)（空のシーケンスに対して `default(TSource)` を返す。明示的な既定値を受け取る .NET 6 のオーバーロードも）。
- Microsoft Learn, [Enumerable.DefaultIfEmpty Method](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.defaultifempty)（ソースが空のときに単一の既定要素を生成する）。
