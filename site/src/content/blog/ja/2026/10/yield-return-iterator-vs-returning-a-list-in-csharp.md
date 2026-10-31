---
title: "yield return イテレーターと List<T> を返す方法の比較: C# で IEnumerable を返すメソッドの本当のコスト"
description: "yield return メソッドは、生成する要素数に関係なく、呼び出しごとに 40 バイトのステートマシンオブジェクト 1 つ分のコストがかかります。List<T> は内部配列全体を先に確保します。.NET 10.0.10 で計測した結果、メモリと早期終了ではイテレーターが有利で、呼び出し側が複数回列挙する場合、Count が必要な場合、ToList() を呼ぶ場合は List<T> が有利でした。"
pubDate: 2026-10-31
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "linq"
  - "performance"
lang: "ja"
translationOf: "2026/10/yield-return-iterator-vs-returning-a-list-in-csharp"
translatedBy: "claude"
translationDate: 2026-10-31
---

**結論:** `yield return` メソッドは、10 件を生成しても 100 万件を生成しても、呼び出しごとに小さなオブジェクトをちょうど 1 つ確保します (.NET 10.0.10 の単純な `IEnumerable<int>` ループでは 40 バイト)。`List<T>` を構築して返すメソッドは、リストと結果のサイズに応じた内部配列を確保します。1,000 個の int の場合、サイズを事前指定したリストで 4,056 バイト、指定しない場合は 8,424 バイトです。呼び出し側が 1 回だけ列挙する場合 (1,000 件では、1 回の `foreach` がリストへの格納と読み取りより約 2 倍高速でした)、途中で打ち切る可能性がある場合、またはシーケンスが大きい、もしくは無限の場合は、イテレーターを選んでください。呼び出し側が `Count` やインデックスアクセスを必要とする場合、または複数回列挙する場合は、`List<T>` を選び (戻り値の型にも `List<T>` または `IReadOnlyList<T>` と明示してください)、イテレーターに対する追加の走査のたびにメソッド本体が再実行されることを避けてください。

以下はすべて、Apple M4 上の .NET 10.0.10 (SDK 10.0.302) と C# 14 で計測したものです。実行時間には BenchmarkDotNet 0.15.8、呼び出しごとのアロケーション量には `GC.GetAllocatedBytesForCurrentThread()` を使用しました。

## 比較の概要

| | `yield return` イテレーター | `IEnumerable<T>` として返す `List<T>` |
| --- | --- | --- |
| 呼び出しごとのアロケーション (.NET 10.0.10, `int`) | 40 B で一定 (JIT がインライン化すると 0 B になることもある) | 32 B + 内部配列 (1,000 個の int で 4,056 B) |
| 呼び出し時に行う処理 | なし (引数チェックも行わない) | すべて |
| 呼び出し側が 1 件で止めた場合の処理量 | 1 件 | 全件 |
| 2 回目の `foreach` | メソッド本体を再実行 | 保存済みの要素を読み取る |
| `Count()` | シーケンス全体を走査 | `ICollection<T>` 経由で O(1) |
| `TryGetNonEnumeratedCount` | `false` | `true` |
| `ToList()` / `ToArray()` | 倍々で拡張 / 正確なサイズでコピー | 正確なサイズで 1 回コピー |
| 例外のスロー | 最初の `MoveNext()` で | 呼び出し時 |
| 結果のスレッドセーフ性 | 列挙のたびに新しいステートマシン | 複数スレッドから安全に読み取れる |

## コンパイラーが `yield return` を変換するもの

この記事全体で使用するイテレーターは次のとおりです。

```csharp
// .NET 10.0.10, C# 14
public static IEnumerable<int> Iterator(int n)
{
    for (int i = 0; i < n; i++)
        yield return i * 2;
}
```

Roslyn はこのメソッドを、ここでは `<Iterator>d__0` という名前の隠しクラスに書き換えます。メソッド本体は"そのクラスを確保し、引数を格納して返す"だけになります。生成された型をリフレクションで調べると、中身が正確にわかります。

```text
Src+<Iterator>d__0
  field Int32 <>1__state
  field Int32 <>2__current
  field Int32 <>l__initialThreadId
  field Int32 n
  field Int32 <>3__n
  field Int32 <i>5__2
  implements IEnumerable`1, IEnumerable, IEnumerator`1, IDisposable, IEnumerator
```

6 個の `int` フィールドに、16 バイトのオブジェクトヘッダーとメソッドテーブルポインターを加えると 40 バイトになります。`yield return` をまたいで生き残るローカル変数はすべてフィールドになり (`<i>5__2` がループ変数です)、引数はそれぞれ 2 回保存されます。`<>3__n` はシーケンスを再び列挙できるように元の値を保持し、`n` は作業用のコピーです。`string` 引数と `DateTime` ローカル変数を持つメソッドではフィールドが大きくなりますが、形は yield する要素数に依存しません。これが肝心な点で、メモリ使用量は要素数に対して O(1) です。

同じオブジェクトが `IEnumerable<T>` であると同時に、生成したスレッドからの最初の `GetEnumerator()` 呼び出しでは `IEnumerator<T>` にもなります。そのため、単純な `foreach (var x in Iterator(n))` のアロケーションは 2 回ではなく 1 回です。

`List<T>` 版は、多くの人が最初に書くコードです。

```csharp
// .NET 10.0.10, C# 14
public static List<int> ListCap(int n)
{
    var list = new List<int>(n);
    for (int i = 0; i < n; i++)
        list.Add(i * 2);
    return list;
}
```

ここでのコストは、32 バイトの `List<int>` オブジェクトと、`n` 個の要素を持つ `int[]` (ヘッダーと長さで 24 バイト、その後に 1 要素あたり 4 バイト) です。コンストラクターから `n` を外すと、リストは 4、8、16、...、1024 と拡張され、途中の配列がすべて GC に残されます。

## 呼び出しごとのアロケーション実測

各ケースを、tier-1 コードに到達させるために 200,000 回実行し、その後 1,000 回の呼び出しで平均を取りました。

| 要素数 | イテレーター, `foreach` | `List<T>(n)`, `foreach` | `List<T>()`, `foreach` | イテレーター `.ToList()` | イテレーター `.ToArray()` |
| --- | --- | --- | --- | --- | --- |
| 0 | 40 B | 32 B | 32 B | 72 B | 40 B |
| 1 | 40 B | 64 B | 72 B | 112 B | 72 B |
| 10 | 40 B | 96 B | 216 B | 256 B | 104 B |
| 1,000 | 40 B | 4,056 B | 8,424 B | 8,464 B | 4,064 B |

注目すべき点が 3 つあります。

1 つ目は、要素が 0 件の場合はリストのほうが実際には安く (32 B 対 40 B)、1 件でも差はわずかだということです。短く上限のある結果では、メモリはどちらかを選ぶ理由になりません。

2 つ目は、`Iterator(n).ToList()` が最悪の列だということです。イテレーターは `ICollection<T>` を実装していないため、`ToList()` は事前にサイズを決められず、容量指定なしのリストと同様に倍々で拡張し、さらに 40 バイトのステートマシンが加わります。すべての呼び出し側がイテレーターに対してすぐに `ToList()` を呼ぶなら、両方の設計のコストを払っていることになります。その場合は、サイズを事前指定した `List<T>` を返してください。

3 つ目は、.NET 10 ではイテレーターに対する `ToArray()` がほぼ無駄なく動くということです。1,000 個の int で 4,064 B であり、正確なサイズの配列とイテレーターの合計より 8 バイト多いだけです。.NET 9 以降、`ToArray()` は長さ不明のシーケンスをスタックに確保したセグメントにバッファリングし、正確なサイズの配列に 1 回だけコピーします。この変更については [ToList vs ToArray on .NET 9](/ja/2025/01/net-performance-tolist-vs-toarray/) で取り上げました。呼び出し側がイテレーターを実体化する必要があるなら、`ToArray()` のほうが安価な呼び出しです。

## .NET 10 の JIT が取り除いてくれるもの

`IEnumerable<T>` 型で `List<T>` を返すと、以前はアロケーションがもう 1 つ増えていました。インターフェース越しの `foreach` は `IEnumerable<T>.GetEnumerator()` を呼び出し、これが `List<T>.Enumerator` 構造体をボックス化するためです (64 ビットで 40 バイト)。.NET 10.0.10 では、要素 1 件の場合、"`IEnumerable` として返す List"のケースは具象リストと同じ 64 B を確保します。`DOTNET_JitObjectStackAllocation=0` を指定してプローブを再実行するとボックス化が復活し (104 B)、JIT のガード付きデヴァーチャライゼーションとオブジェクトのスタック割り当て ([.NET 10 のエニュメレーター脱抽象化作業](https://github.com/dotnet/runtime/issues/108913)の一部) によって、このエニュメレーターがスタックに置かれていることがわかります。要素が 0 件の場合は、このスイッチをオフにしてもボックスは発生しません。`Count == 0` のとき、`List<T>` は共有の空エニュメレーターを返すためです。

イテレーターの 40 バイトは、エスケープ解析の有無にかかわらず、`foreach` のケースでは変わりませんでした。ステートマシンはメソッドの外に返されるため、定義上エスケープします。JIT がスタックに割り当てられるのは、イテレーターメソッドとそれを消費するすべての処理を 1 つの呼び出し元にインライン化できた場合だけです。下のベンチマークでは一部の LINQ 呼び出しでそれが起きましたが、確実ではありません。

## 実行時間: それぞれが勝つ場面

BenchmarkDotNet 0.15.8、デフォルトジョブ、.NET 10.0.10 Arm64 RyuJIT、Apple M4。各メソッドはベンチマーク内でシーケンスを構築して消費するため、"List" の行にはリストへの格納も含まれます。平均時間とアロケーション (括弧内) です。

| ベンチマーク | N = 10 | N = 1,000 | N = 100,000 |
| --- | --- | --- | --- |
| イテレーター, `foreach` | 10.7 ns (40 B) | 580 ns (40 B) | 56.9 us (40 B) |
| `List<T>(n)`, `foreach` | 12.7 ns (96 B) | 1,004 ns (4,056 B) | 116.3 us (400,140 B) |
| `List<T>()`, `foreach` | 30.1 ns (216 B) | 1,214 ns (8,424 B) | 145.8 us (1,049,168 B) |
| `IEnumerable<T>` として返す `List<T>(n)`, `foreach` | 13.2 ns (96 B) | 1,148 ns (4,056 B) | 114.6 us (400,140 B) |
| イテレーター, `.First()` | 2.1 ns (0 B) | 2.1 ns (0 B) | 2.0 ns (0 B) |
| `List<T>(n)`, `.First()` | 11.4 ns (96 B) | 666 ns (4,056 B) | 77.3 us (400,140 B) |
| イテレーター, `.ToList()` | 34.1 ns (216 B) | 1,452 ns (8,424 B) | 166.9 us (1,049,168 B) |
| イテレーター, `.Count()` | 7.3 ns (0 B) | 541 ns (0 B) | 53.5 us (0 B) |

1 回だけ走査する場合、イテレーターはどのサイズでも高速です。10 件で約 1.2 倍、1,000 件と 100,000 件で 2 倍です。"要素ごとにインターフェース呼び出しが発生する"ほうが"リスト"に負けると予想する人にとっては意外でしょう。リスト版はリストを埋めるために同じループを実行し、次にそれを読み取る 2 つ目のループを実行し、さらに配列のコストも払います。イテレーターはループが 1 回だけです。100,000 個の int では、サイズ事前指定のリストの 400,140 バイトの配列が 85,000 バイトのしきい値を超えるため、Large Object Heap に置かれ、BenchmarkDotNet の実行中は呼び出しのたびに Gen2 コレクションが発生します。

早期終了では差が極端になります。イテレーターの `First()` は、サイズにかかわらず 2 ns です。計算するのは 1 件だけだからです。リスト版では、`First()` が 1 件も見ないうちに 100,000 件すべてが計算されます。

イテレーターが負ける 2 つの行は、いずれにしても結果全体が必要なケースです。`Iterator(n).ToList()` はどの列でも最も遅く、容量指定なしで直接リストを構築するより遅くなります。倍々の拡張にインターフェース呼び出しが上乗せされるためです。また、イテレーターの `Count()` はここでは高速ですが、それはシーケンスを消費しているからです。`Count()` を呼んでから `foreach` すると、メソッドを 2 回実行することになり、O(1) の `Count` を持つリストが勝ちます。

イテレーターの `First()` と `Count()` の行の 0 B も、.NET 10 の JIT によるものです。これらのベンチマークでは、イテレーターメソッドと LINQ 呼び出しをインライン化し、ステートマシンをスタックに割り当てました。私のアロケーションプローブでは、呼び出し箇所によって同じ結果になる場合と、通常の 40 B になる場合があり、`DOTNET_JitObjectStackAllocation=0` を指定するとすべての箇所で 40 B に戻りました。設計の前提にせず、おまけとして捉えてください。

## イテレーターは自分自身を再利用することがある

プローブの意外な数値の理由となる細かな挙動が 1 つあります。同じイテレーターを 2 回列挙しても、アロケーションは合計 80 バイトではなく 40 バイトでした。生成された `GetEnumerator()` は、state フィールドが `-2` (生成直後) で、呼び出し側が生成したスレッドにいる場合に `this` を返します。SDK 10.0.302 で生成された `Dispose()` を逆アセンブルすると、実体は `this.<>1__state = -2` だけです。したがって、`foreach` が終了するか `break` してエニュメレーターが破棄されると、オブジェクトは初期状態に戻り、同じスレッドの次の `foreach` は同じインスタンスを受け取ります。

```csharp
// .NET 10.0.10, C# 14 (SDK 10.0.302)
var seq = Iterator(5);
foreach (var x in seq) { if (x == 2) break; }
var again = seq.GetEnumerator();
Console.WriteLine(ReferenceEquals(seq, again)); // True: reused after Dispose

var fresh = Iterator(5);
var e1 = fresh.GetEnumerator();
e1.MoveNext();
var e2 = fresh.GetEnumerator();
Console.WriteLine(ReferenceEquals(fresh, e2));  // False: e1 still owns the instance
```

最初のエニュメレーターがまだ有効なうちに取得した 2 つ目のエニュメレーターや、別のスレッドから取得したものは、保存された `<>3__` の引数コピーから初期化された新しいインスタンスを受け取ります。正しさの面でこれを考慮する必要はありませんが、"イテレーターを 2 回列挙する"ことはバイト数の面では安価だということです。ただし処理量の面では安価ではなく、それが次のポイントです。

## 選択を左右する落とし穴

### 列挙のたびにメソッドが再実行される

イテレーターは要素を保存しません。2 回目の `foreach`、`Count()` の後の `foreach`、`Any()` の後の `ToList()` は、メソッド本体を再び実行します。その中のデータベース呼び出し、ファイル読み取り、`Console.WriteLine` も含まれます。

```csharp
// .NET 10.0.10, C# 14
static IEnumerable<string> ReadNames(string path)
{
    Console.WriteLine($"opening {path}");
    foreach (var line in File.ReadLines(path))
        yield return line.Trim();
}

var names = ReadNames("names.txt");
if (names.Any())                      // opening names.txt
    Console.WriteLine(names.Count()); // opening names.txt (again)
```

.NET アナライザーはこれを [CA1851: Possible multiple enumerations of IEnumerable collection](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/ca1851) として警告しますが、このルールはデフォルトでは無効です。呼び出し側が日常的に 2 回の走査を必要とするなら、リストを返してください。引き継いだ `IEnumerable<T>` を 2 回走査しても安全かどうか判断できない場合は、[実体化済みの IEnumerable を検出する方法についてのこの記事のチェック](/ja/2026/08/how-to-tell-whether-an-ienumerable-has-already-been-materialized-in-csharp/)が BCL で得られる最も近い手段です。

### 引数の検証が遅延される

イテレーター本体のコードは、先頭のガード句を含め、最初の `MoveNext()` まで何も実行されません。

```csharp
// .NET 10.0.10, C# 14
static IEnumerable<int> Take(IEnumerable<int> source, int count)
{
    ArgumentNullException.ThrowIfNull(source); // runs on first MoveNext, not here
    foreach (var x in source)
    {
        if (count-- <= 0) yield break;
        yield return x;
    }
}

var q = Take(null!, 3);   // no exception
foreach (var x in q) { }  // ArgumentNullException thrown here
```

スタックトレースは `foreach` を指し、不正な呼び出しから遠く離れている可能性があります。標準的な対処法であり、BCL 自身の LINQ 演算子が呼び出し時に例外をスローする理由でもあるのが、メソッドを 2 つに分けることです。検証を行う非イテレーターの public メソッドと、yield を行う private なイテレーター (ローカル関数でも可) に分けます。

```csharp
// .NET 10.0.10, C# 14
static IEnumerable<int> Take(IEnumerable<int> source, int count)
{
    ArgumentNullException.ThrowIfNull(source); // throws at call time
    ArgumentOutOfRangeException.ThrowIfNegative(count);
    return Core(source, count);

    static IEnumerable<int> Core(IEnumerable<int> source, int count)
    {
        foreach (var x in source)
        {
            if (count-- <= 0) yield break;
            yield return x;
        }
    }
}
```

`List<T>` を返すメソッドにはこのような罠はありません。戻る前に最後まで実行されるか、例外をスローします。

### `finally` はエニュメレーターが破棄された場合にのみ実行される

イテレーター内の `try`/`finally` と `using` ブロックは、列挙が完了したとき、またはエニュメレーターが破棄されたときに実行されます。`foreach` は `break` や例外の場合も含め、常に破棄します。`GetEnumerator()` と `MoveNext()` を手動で呼び出し、`Dispose()` を忘れたコードは、所有していたものが GC によってファイナライズされるまで、ファイルや接続を開いたままにします。リストは、返された後はリソースを保持しません。

### 再帰イテレーターは二次的に遅くなる

`yield return` は入れ子のシーケンスをそのまま転送できないため、`foreach (var child in Walk(node.Left)) yield return child;` のように書いた再帰的なツリー走査は、ノードごとに 1 つのステートマシンを確保し、すべての要素を全階層に押し上げます。つまり、O(n x depth) 回の `MoveNext` 呼び出しが発生します。深いツリーでは、単一のイテレーター内で明示的な `Stack<T>` を使うか、再帰に渡す 1 つの `List<T>` を埋める方法を使ってください。

### 戻り値の型は約束である

実際には `List<T>` を構築するメソッドから `IEnumerable<T>` を返すと、`Count` が無料であるという事実が隠れ、呼び出し側が"念のため"に `ToList()` を呼んでデータを余分にコピーすることを招きます (1,000 件での `List.ToList()` の 8,112 B のケースで、リスト自体の 4,056 B と比較したもの。[上のアロケーション表](#呼び出しごとのアロケーション実測)を参照)。実体化するなら、呼び出し側から見えるように `List<T>`、`IReadOnlyList<T>`、または配列を返してください。ストリーミングするなら `IEnumerable<T>` を返し、遅延評価であることを文書化してください。データベースやネットワークから来るデータには、どちらも適切ではありません。非同期にストリーミングすべき場面については [IEnumerable vs IAsyncEnumerable vs IQueryable](/ja/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/) で、`await foreach` については [IAsyncEnumerable とは何か](/ja/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/)でさらに詳しく扱っています。

## どちらを返すか

`yield return` イテレーターを使うのは、次の場合です。

- 呼び出し側が先頭から末尾まで 1 回だけ列挙する場合。`foreach` パイプラインや LINQ チェーンでは一般的なケースです。
- 呼び出し側が途中で止める可能性がある場合 (`First`、`Any`、`Take`、一致したときの `break`)。イテレーターは、求められた分の処理だけを行います。
- シーケンスが大きい、無限である、またはストリームから生成される場合 (ファイルの行、API のページなど)。メモリは結果全体ではなく 1 つのオブジェクト分で済みます。

`List<T>` (`List<T>` または `IReadOnlyList<T>` の型で) を返すのは、次の場合です。

- 呼び出し側が `Count`、インデックスアクセス、または複数回の走査を必要とする場合。
- 結果が小さく上限がある場合。イテレーターの 40 バイトと要素ごとのインターフェース呼び出しは何の利点ももたらしません。
- 呼び出し側がいずれにしても `ToList()` を呼ぶ場合。件数がわかっているなら、`new List<T>(capacity)` で事前にサイズを指定してください。
- メソッドに、呼び出し時にちょうど 1 回だけ行う必要のある副作用や検証がある場合。

公開 API でのデフォルトは 2 つ目のリスト、つまり実体化して正直な型で返す方法です。早期終了やメモリが実際の要件であるときに `yield return` を使い、その場合は毎回、検証を非イテレーターのラッパーに分離します。

## 関連記事

- [IEnumerable vs IAsyncEnumerable vs IQueryable in C#: which one should the method return?](/ja/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/)
- [How to tell whether an IEnumerable<T> has already been materialized in C#](/ja/2026/08/how-to-tell-whether-an-ienumerable-has-already-been-materialized-in-csharp/)
- [.NET Performance: ToList vs ToArray](/ja/2025/01/net-performance-tolist-vs-toarray/)
- [What is IAsyncEnumerable and when should I use it?](/ja/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/)
- [How to iterate over two collections in lockstep without heap allocations in C#](/ja/2026/10/how-to-iterate-over-two-collections-in-lockstep-without-heap-allocations-in-csharp/)

## 参考資料

- [yield statement](https://learn.microsoft.com/dotnet/csharp/language-reference/statements/yield) (C# language reference)
- [Iterators](https://learn.microsoft.com/dotnet/csharp/iterators) (C# guide)
- [CA1851: Possible multiple enumerations of IEnumerable collection](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/ca1851) (Microsoft Learn)
- [Enumerable.TryGetNonEnumeratedCount](https://learn.microsoft.com/dotnet/api/system.linq.enumerable.trygetnonenumeratedcount) (Microsoft Learn)
- [Roslyn iterator rewriter source](https://source.dot.net/Microsoft.CodeAnalysis.CSharp/Lowering/IteratorRewriter/IteratorMethodToStateMachineRewriter.cs.html) (source.dot.net)
- [.NET 10 de-abstraction plans, dotnet/runtime#108913](https://github.com/dotnet/runtime/issues/108913)
- [What's new in the .NET 10 runtime](https://learn.microsoft.com/dotnet/core/whats-new/dotnet-10/runtime) (Microsoft Learn)
