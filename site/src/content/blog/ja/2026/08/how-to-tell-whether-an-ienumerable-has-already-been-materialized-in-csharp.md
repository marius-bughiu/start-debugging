---
title: "C# で IEnumerable<T> がすでにマテリアライズ済みかどうかを判定する方法"
description: "IEnumerable<T> に HasBeenEnumerated フラグはありません。TryGetNonEnumeratedCount が実際に何を調べているのか、なぜ Enumerable.Range が ICollection<T> のテストを通過するのか、そして無駄な ToList() を避けるガードを解説します。"
pubDate: 2026-08-23
tags:
  - "csharp"
  - "linq"
  - "dotnet"
  - "performance"
lang: "ja"
translationOf: "2026/08/how-to-tell-whether-an-ienumerable-has-already-been-materialized-in-csharp"
translatedBy: "claude"
translationDate: 2026-08-23
---

.NET には「この `IEnumerable<T>` はすでに列挙されたか」に答える API はありませんし、「このシーケンスはメモリ上にあるか」に答える API もありません。このインターフェースのメンバーは `GetEnumerator()` ただ 1 つで、呼び出されたことを実装が覚えておく義務は契約のどこにもありません。実際に使えるのは `Enumerable.TryGetNonEnumeratedCount` (.NET 6 以降) で、これは *要素数* が安く取得できるかどうかを教えてくれます。加えて、自分で書ける型テストがあります。この 2 つのシグナルは「すでにマテリアライズ済み」と重なる部分はありますが、同じものではなく、そのずれの中にバグが潜んでいます。以下の内容はすべて .NET 10.0.201 と C# 14 で計測しました。

## なぜこの問いに直接の答えがないのか

`IEnumerable<T>` はコンテナーではなく、列挙子のファクトリーです。`GetEnumerator()` を 2 回呼ぶことは正当であり、呼び出しごとにデータ上の新しい独立した走査を返してよいことになっています。`List<int>` は既存の配列に対する構造体の列挙子を返します。`yield return` を使うメソッドはステートマシンを構築し、メソッド本体を先頭から実行します。`DbSet<T>` は接続を開いて SQL を発行します。3 つとも同じインターフェースを満たしますが、要素をメモリに保持しているのは最初のものだけです。

つまり「マテリアライズ済みか」という問いは、混同されがちな 3 つの別々の問いに分かれます。

1. 要素はすでにメモリ上にあり、2 回目の走査は無料か。
2. シーケンスを走査せずに要素数が得られるか。
3. *この特定の* シーケンスオブジェクトはすでに一度走査されたか。

BCL は (1) には部分的に、(2) にはきちんと答えますが、(3) にはまったく答えません。

## ランタイムが実際に追跡しているもの: イテレーターのステートマシン

コンパイラーが生成するイテレーターは状態フィールドを持っており、それをのぞくことはできます。これは API ではなくデバッグ用の手段ですが、観察される挙動を説明してくれるので一度は見ておく価値があります。

```csharp
// .NET 10.0.201, C# 14
static IEnumerable<int> Lazy()
{
    yield return 1;
    yield return 2;
}

static string ReadState(object o)
{
    var f = o.GetType().GetField("<>1__state",
        BindingFlags.Instance | BindingFlags.NonPublic);
    return f is null ? "no state field" : $"{f.GetValue(o)}";
}

var seq = Lazy();
Console.WriteLine(ReadState(seq));      // -2  : constructed, never enumerated
var e = seq.GetEnumerator();
Console.WriteLine(ReferenceEquals(seq, e)); // True : the first call returns "this"
e.MoveNext();
Console.WriteLine(ReadState(seq));      // 1   : mid-enumeration
```

`-2` というセンチネル値はコンパイラーの高速パスです。生成元のスレッドで最初に `GetEnumerator()` を呼ぶと状態が `0` になり、クローンを確保せずに同じオブジェクトを返します。それ以降の呼び出しは、独自の状態を持つクローンを返します。2 番目の列挙子が先頭から始まる一方で最初の列挙子が位置を保つのはこのためであり、読み取れる「列挙済み」の共有ビットが存在しないのもこのためです。`<>1__state` をリフレクションで読むのは、1 つのオブジェクト、1 つのコードパス、1 つのコンパイラーについて語るだけです。製品コードには入れないでください。

## TryGetNonEnumeratedCount が正確に何をテストするか

.NET 6 で追加され .NET 11 でも形は同じで、`Enumerable.TryGetNonEnumeratedCount` は「触らずに見る」ための唯一のサポートされたプリミティブです。[ランタイムの実装](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Linq/src/System/Linq/Count.cs) は順に並んだ 3 つの型テストです。

```csharp
// System.Linq.Enumerable, .NET 10, abridged
public static bool TryGetNonEnumeratedCount<TSource>(
    this IEnumerable<TSource> source, out int count)
{
    if (source is ICollection<TSource> collectionoft) { count = collectionoft.Count; return true; }
    if (source is Iterator<TSource> iterator)
    {
        int c = iterator.GetCount(onlyIfCheap: true);
        if (c >= 0) { count = c; return true; }
    }
    if (source is ICollection collection) { count = collection.Count; return true; }
    count = 0;
    return false;
}
```

`Iterator<TSource>` は LINQ 自身のイテレーターの内部基底クラスなので、真ん中の分岐は `System.Linq` の外からは再現できない部分です。[ドキュメントの注釈](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.trygetnonenumeratedcount) にもはっきり書かれています。「列挙せずに要素数を判定できる一般的なサブタイプを識別する、一連の型テスト」を行うということです。

一般的なシーケンスの形をすべてこのメソッドに通し、さらに手書きするであろう型テストも並べると、.NET 10.0.201 では次のようになります。

| シーケンス | `TryGetNonEnumeratedCount` | `is ICollection<T>` | `is IReadOnlyCollection<T>` | `is IQueryable` |
| --- | --- | --- | --- | --- |
| `int[]` | true, 3 | true | true | false |
| `List<int>` | true, 3 | true | true | false |
| `HashSet<int>` | true, 3 | true | true | false |
| `Queue<int>` | true, 3 | **false** | true | false |
| `Stack<int>` | true, 3 | **false** | true | false |
| `ReadOnlyCollection<int>` | true, 3 | true | true | false |
| `ImmutableArray<int>` | true, 3 | true | true | false |
| `Enumerable.Empty<int>()` | true, 0 | true | true | false |
| `Enumerable.Range(0, 1_000_000_000)` | **true, 1000000000** | **true** | true | false |
| `Enumerable.Repeat(7, 500)` | true, 500 | true | true | false |
| `list.Select(x => x)` | **true, 3** | false | false | false |
| `list.Where(x => true)` | false | false | false | false |
| `list.Take(2)` | true, 2 | **true** | true | false |
| `list.Skip(1)` | true, 2 | **true** | true | false |
| `list.OrderBy(x => x)` | true, 3 | false | false | false |
| `list.Distinct()` | false | false | false | false |
| `list.Concat(list)` | true, 6 | false | false | false |
| `((IEnumerable)list).Cast<int>()` | true, 3 | true | true | false |
| `list.DefaultIfEmpty()` | true, 3 | false | false | false |
| `Enumerable.Reverse(list)` | true, 3 | false | false | false |
| `list.GroupBy(x => x).SelectMany(g => g)` | false | false | false | false |
| `yield return` を使うイテレーターメソッド | false | false | false | false |
| `list.AsQueryable()` | false | false | false | **true** |
| `list.ToList()` / `.ToArray()` | true, 3 | true | true | false |

## この表に潜む 3 つの罠

**安く得られる要素数はマテリアライズを意味しません。** `Enumerable.Range(0, 1_000_000_000)` は定数時間で 10 億という要素数を返し、`is ICollection<int>` も通過しますが、何も確保されていません。`RangeIterator` は .NET 8 以降 `IList<T>` を実装しています。.NET 6 と .NET 7 では、イテレーターが内部の `IPartition<int>` しか実装していなかったため、同じ式は `ICollection<T>` のテストに落ちました。コードに `if (source is ICollection<T>) { /* safe to keep the reference */ }` と書いたなら、それは「10 億要素のシーケンスを保持して 2 回列挙しても安全だ」と言っているのと同じです。

同じ罠は `Select` にも現れます。`list.Select(x => x)` は `TryGetNonEnumeratedCount` から元のリストの要素数とともに `true` を返します。射影の要素数はソースの要素数と等しいからです。セレクターは 1 要素についても実行されていません。要素数が取れたことは、処理が終わっているかどうかについて何も語っていません。

**`ICollection<T>` は非常によく使う 2 つの型を取りこぼします。** `Queue<T>` と `Stack<T>` は非ジェネリックの `ICollection` とジェネリックの `IReadOnlyCollection<T>` を実装しますが、`ICollection<T>` は実装しません。`source as ICollection<T>` と書いたガードは、この 2 つに対して黙って防御的コピーへ落ちます。必要なのが `Count` と繰り返しの列挙だけなら、`IReadOnlyCollection<T>` のほうが適切なテストです。

**遅延は数えられないことを意味せず、数えられることは走査が安いことを意味しません。** `Where` と `Distinct` は、ソースが `List<int>` であっても `false` を返します。要素数を決めるのは述語だからです。`OrderBy` はソースの要素数とともに `true` を返しますが、列挙すればやはり完全なソートが走ります。`true` という結果を、自由に列挙してよい許可証として扱わないでください。

## 遅延する ICollection<T> はあらゆるチェックをすり抜ける

ここで挙げた手法はすべて型テストであり、型テストは `GetEnumerator()` のたびに高価な処理を行う実装によっても満たされます。これは机上の話ではありません。遅延読み込みプロキシ配下の Entity Framework Core のコレクションナビゲーションは、列挙するとデータベースに問い合わせが飛びうる `ICollection<T>` です。

```csharp
// .NET 10.0.201, C# 14
sealed class LazyCollection : ICollection<int>
{
    public static int WorkDone;
    public int Count => 3;              // cheap, known up front
    public bool IsReadOnly => true;
    public IEnumerator<int> GetEnumerator()
    {
        WorkDone++;                     // expensive, runs on every pass
        return Enumerable.Range(0, 3).GetEnumerator();
    }
    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    // mutating members omitted
}
```

この型は何の処理もしていない状態で `is ICollection<int> == true` を返し、`TryGetNonEnumeratedCount` も要素数 3 で `true` を返します。`foreach` を 1 回行うと `WorkDone` は 1 になり、以降の走査のたびに増えていきます。これを `List<int>` と区別できる API はありません。境界が自分の管理下にあるなら、`IEnumerable<T>` を渡すのをやめて `IReadOnlyList<T>` か具象型を渡すのが解決策です。ランタイムの推測がコンパイル時の保証に変わります。これは [IEnumerable、IAsyncEnumerable、IQueryable のどれを戻り値の型にするか](/ja/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/) を選ぶときと同じ論法です。

## 書く価値のあるガード

実際のところ、誰も `HasBeenEnumerated` フラグを欲しがってはいません。知りたいのは、防御的な `ToList()` が無駄になるかどうかです。その問いに直接答えましょう。

```csharp
// .NET 10.0.201, C# 14
public static IReadOnlyCollection<T> Materialize<T>(this IEnumerable<T> source)
{
    ArgumentNullException.ThrowIfNull(source);

    return source switch
    {
        // Deferred against a remote store: always pull it in, once.
        IQueryable<T> q => q.ToList(),

        // Known in-memory BCL types: reuse the reference, no copy.
        T[] a => a,
        List<T> l => l,
        IReadOnlyCollection<T> c when c.GetType().Assembly == typeof(List<T>).Assembly => c,

        _ => source.ToList(),
    };
}
```

`IQueryable<T>` のアームを最初に置くのは、2 回目の列挙が明確に 2 回目のラウンドトリップになる唯一のケースであり、そもそも LINQ の型テストがすべて `false` を返すからです。3 番目のアームのアセンブリー判定は意図的に保守的で、`Queue<T>`、`Stack<T>`、`ReadOnlyCollection<T>` などは受け入れつつ、上の `LazyCollection` や ORM のナビゲーション型を弾きます。コードベースに遅延バックエンドのコレクションがないなら、そのアームは単なる `IReadOnlyCollection<T> c => c` に減らして 1 行版のままにしてかまいません。

このガードに *入っていない* ものにも注目してください。`TryGetNonEnumeratedCount` です。これは別の問いに答えるものです。本当に要素数が欲しくてフォールバックも受け入れられるとき、つまり設計上の想定どおりの場面で使ってください。

```csharp
// .NET 10.0.201, C# 14
int capacity = source.TryGetNonEnumeratedCount(out int known) ? known : 16;
var buffer = new List<T>(capacity);
```

## ガードで節約できるもの

`Stopwatch` と `GC.GetAllocatedBytesForCurrentThread` を使い、100 回反復し、`IEnumerable<int>` として渡した 1,000,000 要素の `List<int>` に対して .NET 10.0.201 の Release 構成で計測した結果です。

| アプローチ | 時間 | 確保量 |
| --- | --- | --- |
| `input.ToList()` | 793.93 us/op | 4,000,056 バイト/op |
| `input as IReadOnlyCollection<int> ?? input.ToList()` | 1.09 us/op | 0 バイト/op |

これは BenchmarkDotNet の数値ではなく粗いループ計測ですが、確保量の列は正確であり、そこが肝心です。無条件のコピーは呼び出しのたびに 4 メガバイトのバッキング配列をラージオブジェクトヒープにもう 1 本確保しますが、ガードは何も確保しません。すでにマテリアライズ済みのリストを受け取るホットパスでは、防御的コピーがそのメソッドのコストのすべてになります。同じ理屈は [大きなファイルをメモリ不足にせずに読む](/ja/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) 場面にも当てはまります。

## 呼び出し箇所はアナライザーに探させる

手作業で監査する必要はありません。CA1851 「Possible multiple enumerations of 'IEnumerable' collection」は .NET 7 で導入され、.NET 10 でも **既定では有効になっていません**。有効にしましょう。

```ini
# .editorconfig
[*.{cs,vb}]
dotnet_diagnostic.CA1851.severity = warning
```

`EnableNETAnalyzers` と `AnalysisLevel` を `latest` に設定すると、このコードは .NET 10.0.201 で 2 件の診断を出します。

```csharp
public static void Twice(IEnumerable<int> input)
{
    var count = input.Count();              // CA1851
    foreach (var i in input) { _ = i; }     // CA1851
}
```

```text
warning CA1851: Possible multiple enumerations of 'IEnumerable' collection.
Consider using an implementation that avoids multiple enumerations.
```

本体を書き換えて、まずガードを通して束縛するようにすれば、両方の警告が消えます。

```csharp
public static void Guarded(IEnumerable<int> input)
{
    var list = input as IReadOnlyCollection<int> ?? input.ToList();
    var count = list.Count;
    foreach (var i in list) { _ = i; }
}
```

実際のコードベースでは 2 つの設定項目が効いてきます。`enumeration_methods` は `IEnumerable` 引数を消費する独自メソッドを登録するためのもので、`assume_method_enumerates_parameters` は既定の仮定を反転させます。既定では、独自メソッドは渡されたものを列挙 *しない* と仮定されます。同じシーケンスを自分のヘルパー 2 つに渡しても CA1851 が黙っているのは、この既定のためです。

## IQueryable と IAsyncEnumerable には別のルールが要る

`IQueryable<T>` にはここまでの話は当てはまりません。どの型テストも `false` を返し、列挙のたびにプロバイダーによる新しい変換と新しいラウンドトリップが発生します。頼るべきシグナルは静的な型であり、対処は境界で一度だけ `ToListAsync()` を呼ぶことです。ループの中でクエリを繰り返し列挙するのは [EF Core の N+1 クエリ問題](/ja/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) の一形態であり、そもそも変換できないクエリは、静かな二重ラウンドトリップではなく [「The LINQ expression could not be translated」というエラー](/ja/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/) になります。

`IAsyncEnumerable<T>` には `TryGetNonEnumeratedCount` もなく、`ICollection<T>` に相当するものもなく、安価な要素数もありません。非同期シーケンスの要素数を知る唯一の方法は、すべてを待つことです。それこそが [IAsyncEnumerable が避けさせようとしている](/ja/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/) ものです。`await source.ToListAsync()` で一度だけマテリアライズしてリストを回すか、1 回の走査で足りるように構造を組み直してください。

正直にまとめると、「これはマテリアライズ済みか」には答えられませんが、「2 回目の走査は安いか」にはたいてい答えられます。まず `IQueryable<T>` を判定し、次に `ICollection<T>` ではなく `IReadOnlyCollection<T>` を判定し、`TryGetNonEnumeratedCount` はマテリアライズの判定ではなく容量のヒントとして扱い、忘れた箇所は CA1851 に教えてもらいましょう。

## 関連記事

- [IEnumerable vs IAsyncEnumerable vs IQueryable in C#: メソッドはどれを返すべきか](/ja/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/)
- [IAsyncEnumerable&lt;T&gt; とは何か、いつ使うべきか](/ja/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/)
- [EF Core 11 で N+1 クエリを検出する方法](/ja/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [.NET 11 で大きな CSV をメモリ不足にせずに読む方法](/ja/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/)
- [解決: EF Core 11 の「The LINQ expression could not be translated」](/ja/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)

## 参考資料

- [Enumerable.TryGetNonEnumeratedCount&lt;TSource&gt; Method](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.trygetnonenumeratedcount) (MS Learn)
- [dotnet/runtime の Count.cs](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Linq/src/System/Linq/Count.cs)、型テストの実装
- [dotnet/runtime の Range.SpeedOpt.cs](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Linq/src/System/Linq/Range.SpeedOpt.cs)、`RangeIterator` が `IList<T>` を宣言している箇所
- [CA1851: Possible multiple enumerations of 'IEnumerable' collection](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1851) (MS Learn)
- [LINQ の遅延実行と遅延評価](https://learn.microsoft.com/en-us/dotnet/standard/linq/deferred-execution-lazy-evaluation) (MS Learn)
