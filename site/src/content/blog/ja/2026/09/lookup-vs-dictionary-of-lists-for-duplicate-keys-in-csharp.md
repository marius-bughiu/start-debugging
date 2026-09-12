---
title: "C# で重複キーを扱うなら Lookup<TKey, TElement> か Dictionary<TKey, List<TValue>> か"
description: "一度グループ化して読むだけなら ToLookup を使います。不変で、存在しないキーには空のシーケンスを返し、null キーを受け付け、最初に現れた順序を保ちます。構築後にグループが変化する場合や JSON の境界をまたぐ場合は Dictionary<TKey, List<TValue>> を使います。"
pubDate: 2026-09-12
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "linq"
  - "collections"
  - "performance"
lang: "ja"
translationOf: "2026/09/lookup-vs-dictionary-of-lists-for-duplicate-keys-in-csharp"
translatedBy: "claude"
translationDate: 2026-09-12
---

C# で 1 つのキーを複数の値に対応させたいとき、組み込みの選択肢は `ILookup<TKey, TElement>` (`Enumerable.ToLookup` が返すもの) と、手書きの `Dictionary<TKey, List<TValue>>` の 2 つです。**既存のシーケンスから一度だけグループを構築し、あとは読むだけなら `ToLookup` を選んでください**。1 行で書け、不変で、存在しないキーに対しては例外ではなく空のシーケンスを返し、`null` キーを受け付け、グループを最初に現れた順序で列挙します。**構築後にグループが変化する場合、`TryGetValue` が必要な場合、あるいは結果を JSON で往復させる必要がある場合は `Dictionary<TKey, List<TValue>>` を選んでください。** パフォーマンスはディクショナリ寄りですが、ほとんどのケースで決め手になるほどの差ではありません。.NET 11 RC 1 では手書きのディクショナリは `ToLookup` より約 30% 速く構築でき、読み取りは 3-13% 速くなりますが、100,000 件で 2 ms 未満の差です。以下はすべて .NET 11 RC 1 (ランタイム `11.0.0-rc.1.26425.128`、C# 15) で実行したもので、ここで説明する挙動は .NET Framework 3.5 で `ToLookup` が登場して以来変わっていません。

## 2 つの形を並べて比較する

| 挙動 (.NET 11 RC 1)                         | `ToLookup` による `ILookup<TKey, TElement>` | `Dictionary<TKey, List<TValue>>`        |
| ------------------------------------------- | ---------------------------------------- | --------------------------------------- |
| 構築後の追加・削除                          | 不可、不変                               | 可                                      |
| 存在しないキーでのインデクサー              | 空のシーケンス                           | `KeyNotFoundException`                  |
| `null` キー                                 | 許可                                     | `ArgumentNullException`                 |
| グループの列挙順序                          | 構造上、キーが最初に現れた順             | 実際には挿入順だが保証なし              |
| グループ内の要素の順序                      | ソースの順序                             | `Add` した順序                          |
| `TryGetValue`                               | なし (`Contains` + インデクサー)         | あり                                    |
| パブリックコンストラクター                  | なし                                     | あり                                    |
| `System.Text.Json` シリアライズ             | 配列の配列、キーは失われる               | `TKey` をキーとするオブジェクト         |
| `System.Text.Json` デシリアライズ           | `NotSupportedException`                  | 可                                      |
| 100k 件、100 キーの構築                     | 660 us, 1.91 MB                          | 477 us, 1.91 MB                         |
| 1,000 回のプローブ、10,000 キーの読み取り   | 66.1 us, 29,344 B                        | 61.0 us, 0 B                            |

現実のケースの大半を決めるのは最初の 2 行と JSON の行です。残りは、判断軸を間違えたときに後から効いてくる細部です。

## ToLookup が実際に構築するもの

`Lookup<TKey, TElement>` にはパブリックコンストラクターがありません。`Enumerable.ToLookup` が唯一の取得手段であり、[`Lookup.cs`](https://github.com/dotnet/runtime/blob/v11.0.0-rc.1.26425.128/src/libraries/System.Linq/src/System/Linq/Lookup.cs) のソースを見ると何が返ってくるのかが正確にわかります。

- 実行時の型は内部の `CollectionLookup<TKey, TElement>` です。これはパブリックな `Lookup<TKey, TElement>` のサブクラスで、`ICollection<IGrouping<TKey, TElement>>` も実装しており、変更系のメンバーはすべて `NotSupportedException` をスローします。
- それ自体が小さなハッシュテーブルです。`Grouping<TKey, TElement>` のバケット配列を持ち、サイズは素数で `HashHelpers.ExpandPrime` によって拡張され、`_hashNext` フィールドでチェイニングします。`Dictionary` をラップしているわけではありません。
- 各グループは循環連結リストのノードでもあり、新しいキーが現れるたびに末尾に追加されます。列挙はこのリストをたどるため、グループは最初に現れた順序で返ってきます。これはハッシュのレイアウトによる偶然ではなく、型の構造上の性質です。
- 各 `Grouping` は要素を `TElement[]` に格納し、長さ 1 から始めて `List<T>` と同様に倍々で拡張します。また `IList<TElement>` を読み取り専用で実装しています。
- `null` キーは比較子を呼ばずにハッシュ値 `0` として扱われるため、`null` は正当なキーです。
- ソースが空の配列の場合は共有のシングルトン `EmptyLookup<TKey, TElement>.Instance` が返され、何も割り当てられません。

ここから 2 つのことが導かれます。1 つ目は、`ToLookup` が**即時評価**であることです。ソース全体をその場で走査します。これに対して `GroupBy` は遅延評価で、列挙するたびに同じ内部 `Lookup` を構築します。2 つ目は、`lookup[key].Count()` が O(1) であることです。`Enumerable.Count` が `Grouping` の `ICollection<T>` 実装を検出し、件数を直接読み取るためです。

## 実際に異なる挙動

表の各行を確認する小さなプログラムを示します。.NET 11 のコンソールアプリとして実行してください。

```csharp
// .NET 11 RC 1 (11.0.0-rc.1.26425.128), C# 15
var orders = new List<Order>
{
    new("alice", 1), new("bob", 2), new("alice", 3), new(null, 4), new("carol", 5),
};

var lookup = orders.ToLookup(o => o.Customer);
Console.WriteLine(lookup.GetType());                     // System.Linq.CollectionLookup`2[...]
Console.WriteLine(lookup.Count);                         // 4 (keys, not orders)
Console.WriteLine(lookup["dave"].Count());               // 0, no exception
Console.WriteLine(string.Join(",", lookup[null].Select(o => o.Id)));            // 4
Console.WriteLine(string.Join(",", lookup.Select(g => g.Key ?? "<null>")));     // alice,bob,<null>,carol

try { ((IList<Order>)lookup["alice"]).Add(new("alice", 99)); }
catch (NotSupportedException) { Console.WriteLine("groups are read-only"); }

// Eager vs deferred
var source = new List<Order> { new("x", 1) };
var eager = source.ToLookup(o => o.Customer);
var deferred = source.GroupBy(o => o.Customer);
source.Add(new("x", 2));
Console.WriteLine(eager["x"].Count());       // 1, snapshot taken at ToLookup
Console.WriteLine(deferred.First().Count()); // 2, re-evaluated on enumeration

var map = new Dictionary<string, List<Order>>();
// map["dave"]      -> KeyNotFoundException
// map.Add(null!, []) -> ArgumentNullException

record Order(string? Customer, int Id);
```

実際のバグを引き起こすのは即時評価と遅延評価の行です。`GroupBy` の結果をフィールドに保持して 2 回列挙すると、グループ化のコストを 2 回払うことになり、しかもその時点のソースの状態が見えます。`ToLookup` はスナップショットを取ります。受け取ったシーケンスがすでに具体化されているかどうか確信が持てない場合は、[グループ化する前に確認してください](/ja/2026/08/how-to-tell-whether-an-ienumerable-has-already-been-materialized-in-csharp/)。

もう 1 つの罠は `Count` です。ルックアップでは、これは要素数ではなく**キー**の数です。要素の合計数を得るには `lookup.Sum(g => g.Count())` が必要です。

## 二重ルックアップなしで List のディクショナリを構築する

ディクショナリを選ぶ場合、古典的なパターンでは新しいキーごとにキーを 2 回ハッシュします (`TryGetValue` のあとに `Add`)。

```csharp
// .NET 11 RC 1, C# 15
var map = new Dictionary<int, List<Order>>();
foreach (var o in orders)
{
    if (!map.TryGetValue(o.CustomerId, out var list))
    {
        list = new List<Order>();
        map.Add(o.CustomerId, list);
    }
    list.Add(o);
}
```

.NET 6 以降では [`CollectionsMarshal.GetValueRefOrAddDefault`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.collectionsmarshal.getvaluereforadddefault) を使って、1 件あたり 1 回のハッシュプローブで済ませられます。このメソッドは値のスロットへの `ref` を返し、キーが存在しない場合は既定値のエントリを挿入します。

```csharp
// .NET 11 RC 1, C# 15
using System.Runtime.InteropServices;

var map = new Dictionary<int, List<Order>>();
foreach (var o in orders)
{
    ref var list = ref CollectionsMarshal.GetValueRefOrAddDefault(map, o.CustomerId, out _);
    (list ??= []).Add(o);
}
```

ドキュメントには守るべきルールが 1 つあります。その `ref` を保持している間はディクショナリのエントリを追加・削除してはいけません。上のループでは `ref` は次の反復の前に消えるので安全です。

LINQ のワンライナーが好みなら `GroupBy(...).ToDictionary(g => g.Key, g => g.ToList())` でも動きますが、中間のグループを割り当てたうえで、すべての要素を新しいリストにコピーします。また .NET 9 の `AggregateBy` を使う場合は `seedSelector` のオーバーロードを使ってください。`seed` のオーバーロードはすべてのキーに**同じ**インスタンスを渡します。

```csharp
// .NET 11 RC 1, C# 15
var orders = new[] { new Order("alice", 1), new Order("bob", 2), new Order("alice", 3) };

var broken = orders.AggregateBy(o => o.Customer, seed: new List<int>(),
    (acc, o) => { acc.Add(o.Id); return acc; });
// alice: 1,2,3   bob: 1,2,3   <- one shared List

var correct = orders.AggregateBy(o => o.Customer, seedSelector: _ => new List<int>(),
    (acc, o) => { acc.Add(o.Id); return acc; });
// alice: 1,3     bob: 2
```

`AggregateBy` とその兄弟である `CountBy` は、キーごとに 1 つの集計値が欲しいときには最適です。カウントのケースは [LINQ CountBy による頻度カウント](/ja/2026/01/optimizing-frequency-counting-with-linq-countby/) で取り上げました。「キーごとのすべての値」が欲しい場合には適切なツールではありません。

## ベンチマーク

BenchmarkDotNet 0.15.8 はまだ `net11.0` モニカーを解決できない (`GetRuntimeVersion` から `NotImplementedException` をスローする) ため、これらは .NET 11 RC 1、Arm64 RyuJIT で `--inProcess` を付けて、macOS 26.6 上の Apple M4 (10 コア、16 GB) で実行しました。ソースは `int` 型の `CustomerId` をキーとする 100,000 件の `Order` レコードで、異なるキーの数は 100 または 10,000 です。読み取りベンチマークでは 1,000 個のランダムなキー (うち 10% は存在しない) をプローブし、各グループの `decimal` フィールドを合計します。

100,000 件の注文からのグループ構築:

| メソッド (.NET 11 RC 1)                        | キー数 | Mean     | Ratio | Allocated |
| ---------------------------------------------- | ------ | -------: | ----: | --------: |
| `ToLookup`                                     | 100    | 660.1 us | 1.00  | 1.91 MB   |
| `GroupBy(...).ToDictionary(g => g.ToList())`   | 100    | 883.0 us | 1.34  | 2.69 MB   |
| `TryGetValue` + `Add` ループ                   | 100    | 476.7 us | 0.72  | 1.91 MB   |
| `CollectionsMarshal.GetValueRefOrAddDefault`   | 100    | 485.8 us | 0.74  | 1.91 MB   |
| `ToLookup`                                     | 10,000 | 5,934 us | 1.00  | 3.86 MB   |
| `GroupBy(...).ToDictionary(g => g.ToList())`   | 10,000 | 7,537 us | 1.27  | 6.06 MB   |
| `TryGetValue` + `Add` ループ                   | 10,000 | 4,070 us | 0.69  | 3.59 MB   |
| `CollectionsMarshal.GetValueRefOrAddDefault`   | 10,000 | 4,384 us | 0.74  | 3.59 MB   |

1,000 個のランダムなキーを読み取り、各グループを合計:

| メソッド (.NET 11 RC 1)                        | キー数 | Mean     | Ratio | Allocated |
| ---------------------------------------------- | ------ | -------: | ----: | --------: |
| `foreach (var o in lookup[k])`                 | 100    | 3,736 us | 1.00  | 29,344 B  |
| `TryGetValue` + `List<T>` に対する `foreach`   | 100    | 3,617 us | 0.97  | 0 B       |
| `TryGetValue` + `CollectionsMarshal.AsSpan`    | 100    | 3,299 us | 0.88  | 0 B       |
| `foreach (var o in lookup[k])`                 | 10,000 | 66.1 us  | 1.00  | 29,344 B  |
| `TryGetValue` + `List<T>` に対する `foreach`   | 10,000 | 61.0 us  | 0.92  | 0 B       |
| `TryGetValue` + `CollectionsMarshal.AsSpan`    | 10,000 | 57.8 us  | 0.87  | 0 B       |

いくつか目立つ点があります。

**ルックアップの構築は単純なループより約 1.4 倍遅く、割り当ては同一です。** 100 キーではどちらも 1.91 MB になるので、差はメモリではなく 1 件ごとの処理にあります。`ToLookup` はすべての要素について `keySelector` デリゲートを呼び出し、インターフェース経由で `IEqualityComparer<TKey>.GetHashCode` と `Equals` を呼びます。`Dictionary<TKey, TValue>` はカスタム比較子のない値型キーを特別扱いし、`EqualityComparer<TKey>.Default` を直接呼び出すため、JIT が脱仮想化してインライン化します。`string` キーの場合はディクショナリも比較子オブジェクトを経由するので、この優位は小さくなります。

**`GroupBy(...).ToDictionary(...)` は両者の悪いところ取りです。** `ToLookup` が構築するのと同じ内部ルックアップを構築し、そのうえですべてのグループを新しい `List<T>` にコピーします。`ToLookup` より 27-34% 遅く、メモリは最大 57% 多く使います。ディクショナリが欲しいならループを書いてください。

**ここでは `CollectionsMarshal` は `TryGetValue` に勝ちませんでした。** 二重ハッシュが起きるのはキーが初めて現れたときだけで、100,000 件中 100 回または 10,000 回です。単一プローブ版が効くのはほとんどの要素が新しいキーを持ち込む場合で、問題になるほど遅くなることもないため、ループではこれを私の既定にしています。

**ルックアップの読み取りは毎回割り当てが発生します。** インデクサーは `IEnumerable<TElement>` を返し、`Grouping.GetEnumerator` はヒープに割り当てた `PartialArrayEnumerator<TElement>` を返します。約 917 回のヒットで 29,344 バイト、1 回あたり 32 バイトです。`List<T>` には `foreach` がボックス化せずに使える構造体の列挙子があり、`CollectionsMarshal.AsSpan` を使えば列挙子そのものがなくなり、さらに 5-9% 速くなります。100 キーでは読み取り時間の大半がグループあたり約 1,000 個の `decimal` 値の合計に費やされるため、比率が近づきます。

正直な結論は、これらの数値のどれも型を選ぶ決め手にはならないということです。10% の読み取り差やプローブあたり 32 バイトが問題になるほどホットなパスにグループがあるなら、配列に対して一度だけ構築する [`FrozenDictionary`](/ja/2024/04/net-8-performance-dictionary-vs-frozendictionary/) や、`IEnumerable<T>` の代わりに span を反復する方法のほうがおそらく適しています。これは [List vs Span vs ReadOnlySpan](/ja/2026/05/list-vs-span-vs-readonlyspan-in-csharp/) で説明したのと同じトレードオフです。

## 選択を決定づける落とし穴

**`Dictionary<TKey, List<TValue>>` を読み取り専用のマルチマップとしてそのまま公開することはできません。** `IReadOnlyDictionary<TKey, TValue>` は `TValue` について不変 (invariant) なので、次のコードはコンパイルできません。

```csharp
// .NET 11 RC 1, C# 15
Dictionary<string, List<int>> map = new() { ["a"] = [1] };
IReadOnlyDictionary<string, IReadOnlyList<int>> ro = map;
// error CS0266: Cannot implicitly convert type 'Dictionary<string, List<int>>'
// to 'IReadOnlyDictionary<string, IReadOnlyList<int>>'
```

コンパイラーが提案する明示的キャストは実行時に `InvalidCastException` をスローします。選択肢は、ディクショナリを最初から `Dictionary<string, IReadOnlyList<int>>` として宣言する (値に対する `Add` はキャストなしでは使えなくなります)、コピーする、あるいは構造上読み取り専用である `ILookup` を返す、のいずれかです。「呼び出し側に変更させてはならない」という要件があるなら、それだけでルックアップを選ぶ十分な理由になります。

**`ILookup` は JSON を通過できません。** `System.Text.Json` はこれを `IEnumerable<IGrouping<...>>` としてシリアライズするため、キーが失われた `[[{...},{...}],[{...}]]` が得られます。また `ILookup<TKey, TElement>` へのデシリアライズは、インターフェースをインスタンス化できないため `NotSupportedException` をスローします。`Dictionary<string, List<T>>` は `{"alice":[...],"bob":[...]}` としてシリアライズされ、往復できます。API のレスポンスやキャッシュするペイロードでは、境界で `lookup.ToDictionary(g => g.Key, g => g.ToList())` によって変換するか、最初からディクショナリを構築してください。

**`ILookup` には `TryGetValue` がありません。** `if (lookup.Contains(k)) use(lookup[k]);` はキーを 2 回ハッシュします。存在しないキーはすでに空のシーケンスを返すので、単にインデクサーを呼び、空のケースはそのまま素通りさせてください。`Contains` を使うのは「値がない」と「キーが存在しない」を区別して扱う必要がある場合だけですが、ルックアップではその区別は決して生じません (要素が 0 個のキーは存在し得ないためです)。

**比較子は構築時に固定されます。** どちらの型も `IEqualityComparer<TKey>` を受け取ります。文字列キーの場合は `StringComparer.OrdinalIgnoreCase` を `ToLookup` またはディクショナリのコンストラクターに渡してください。どちらの型でも後から変更することはできません。

**ディクショナリの列挙順序は実装の詳細です。** 追加しか行っていない `Dictionary` はたまたま挿入順で列挙されますが、ドキュメントでは順序は未定義とされており、`Remove` のあとに `Add` を 1 回行うだけで解放されたスロットが再利用されます。.NET 11 RC 1 では、キー `a, b, c` に対して `Remove("a")` と `Add("d")` を行うと `d, b, c` の順に列挙されます。グループを最初に現れた順序で表示するなら、ルックアップはその保証を構造的に提供してくれます。

**どちらの型も書き込みに対してスレッドセーフではありません。** ルックアップは不変なので、並行読み取りは問題ありません。List のディクショナリでは、ディクショナリとすべてのリストの両方をロックで保護する必要があります。`ConcurrentDictionary<TKey, List<T>>` でも解決しません。中のリストは依然として普通の `List<T>` だからです。並行して追加する必要があるなら、`ConcurrentDictionary<TKey, ConcurrentQueue<T>>` を使うか、アトミックに差し替える不変コレクションを使ってください。

**標準では `MultiValueDictionary` は提供されていません。** Microsoft は 2014 年に `Microsoft.Experimental.Collections` でプロトタイプを作りましたが、ランタイムに取り込まれることはなく、corefxlab リポジトリは現在アーカイブされています。変更可能なマルチマップには、今でも List のディクショナリが標準的な答えです。

## どちらを選ぶべきか

グループが手元にあるデータに対する読み取り専用のインデックスであるなら、既定では `ToLookup` を使ってください。メモリ上の 2 つの集合の結合、レポート用の行のバケット分け、ツリーのための親ごとの子の事前計算などです。短く書け、知らないうちに変更されることがなく、存在しないキーと null キーの挙動のおかげで防御的なコードを一通り省けます。オブジェクトの存続期間中にグループが変化する場合、結果をシリアライズする場合、あるいは読み取りの差が問題になると計測済みのホットループを書いている場合は、`CollectionsMarshal.GetValueRefOrAddDefault` で構築した `Dictionary<TKey, List<TValue>>` に切り替えてください。これらのグループを返すメソッドから `IEnumerable<T>` を公開するか、もっと豊かな型を公開するかで迷っているなら、[IEnumerable vs IAsyncEnumerable vs IQueryable](/ja/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/) と同じ考え方が当てはまります。呼び出し側に余計なことをさせない最も狭い型を返してください。完成したグループであれば、それは `ILookup` です。

### 関連記事

- [C# で IEnumerable がすでに具体化されているかどうかを判別する方法](/ja/2026/08/how-to-tell-whether-an-ienumerable-has-already-been-materialized-in-csharp/)
- [LINQ CountBy による頻度カウントの最適化](/ja/2026/01/optimizing-frequency-counting-with-linq-countby/)
- [.NET 8 における Dictionary と FrozenDictionary の比較](/ja/2024/04/net-8-performance-dictionary-vs-frozendictionary/)
- [C# の List vs Span vs ReadOnlySpan](/ja/2026/05/list-vs-span-vs-readonlyspan-in-csharp/)
- [C# の IEnumerable vs IAsyncEnumerable vs IQueryable](/ja/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/)

### 出典

- [`Lookup<TKey, TElement>` クラス](https://learn.microsoft.com/en-us/dotnet/api/system.linq.lookup-2)、MS Learn
- [`Enumerable.ToLookup`](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.tolookup)、MS Learn
- [`CollectionsMarshal.GetValueRefOrAddDefault`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.collectionsmarshal.getvaluereforadddefault)、MS Learn
- [`Enumerable.AggregateBy`](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.aggregateby)、MS Learn
- `v11.0.0-rc.1.26425.128` タグ時点の [`Lookup.cs`](https://github.com/dotnet/runtime/blob/v11.0.0-rc.1.26425.128/src/libraries/System.Linq/src/System/Linq/Lookup.cs) と [`Grouping.cs`](https://github.com/dotnet/runtime/blob/v11.0.0-rc.1.26425.128/src/libraries/System.Linq/src/System/Linq/Grouping.cs)、dotnet/runtime
- [MultiDictionary becomes MultiValueDictionary](https://devblogs.microsoft.com/dotnet/multidictionary-becomes-multivaluedictionary/)、.NET Blog
- [Release the Microsoft.Experimental.Collections.MultiValueDictionary](https://github.com/dotnet/runtime/issues/14406)、dotnet/runtime issue
