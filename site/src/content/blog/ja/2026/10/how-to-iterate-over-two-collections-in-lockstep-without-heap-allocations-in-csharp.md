---
title: "C# でヒープ割り当てなしに 2 つのコレクションを並行して反復処理する方法"
description: "Enumerable.Zip は呼び出しごとに 144-208 バイトを割り当て、単純なループより約 10 倍遅く動作します。配列やリストであれば、同じ長さにスライスした 2 つの span に対する for ループが割り当てゼロで最速の選択肢です。foreach 構文を使いたい場合は、小さな ref struct の zip 列挙子でその 25% 以内に収まります。.NET 10.0.10 と .NET 11 RC 3 で計測しました。"
pubDate: 2026-10-27
tags:
  - "csharp"
  - "dotnet"
  - "performance"
  - "linq"
  - "memory"
lang: "ja"
translationOf: "2026/10/how-to-iterate-over-two-collections-in-lockstep-without-heap-allocations-in-csharp"
translatedBy: "claude"
translationDate: 2026-10-27
---

**結論から言うと:** 両方のソースが配列、リスト、あるいは `ReadOnlySpan<T>` を取得できるものであれば、短い方の長さを取り、両方の span をその長さにスライスして、単一のインデックスで `for` ループを 1 つ回します。これは何も割り当てず、JIT が知る中で最速の形です。コストをかけずに `foreach (var (x, y) in ...)` 構文を使いたい場合は、`MoveNext` で両方の長さをチェックする 20 行ほどの `ref struct` の zip 列挙子を書きます。ソースがインデックスアクセスできない場合 (`HashSet<T>` や `Dictionary<TKey, TValue>`) は、具象型に対して `GetEnumerator()` を 2 回呼び出し、構造体の列挙子を手動で進めます。ホットパスでは `Enumerable.Zip` を避けてください。.NET 10.0.10 と .NET 11 RC 3 では呼び出しごとに 144 から 208 バイトを割り当て、以下のベンチマークでは単純なループより約 10 倍遅く動作しました。

この記事の内容はすべて、Apple M4 上の .NET 10.0.10 (SDK 10.0.302) と .NET 11.0.0-rc.3.26522.148 で C# 14 を使って計測したものです。割り当て量の数値は両方のランタイムで同一でした。

## Enumerable.Zip のバイトはどこから来るのか

`Enumerable.Zip` は "2 つのシーケンスを一緒にループする" ための当然の答えであり、.NET Core 3.0 以降はタプルを返すオーバーロードもあるため、コードは読みやすくなります:

```csharp
// .NET 10, C# 14
long sum = 0;
foreach (var (x, y) in first.Zip(second))
    sum += (long)x * y;
```

問題は、このパイプラインのすべての部品がインターフェースの背後にある参照型であることです。`Zip` は 2 つの `IEnumerable<T>` パラメーターを受け取るため、各ソースに対してインターフェース経由で `GetEnumerator()` を呼び出します。`List<T>` の場合は構造体の `List<T>.Enumerator` がボックス化され、配列の場合は配列列挙子オブジェクトが割り当てられます。さらに `Zip` 自体が両方を保持するイテレーターオブジェクトを返します。`foreach` はそのイテレーターと `IEnumerator<(T1, T2)>` を介してやり取りするため、すべての `MoveNext` と `Current` は、JIT が通常インライン化できないインターフェース呼び出しになります。

各メソッドを動的 PGO 付きで Tier 1 まで昇格させた後、要素数 1,000 の `int` ソース 2 つを使って、定常状態での割り当て量を `GC.GetAllocatedBytesForCurrentThread()` で計測しました:

| 手法 | 呼び出しごとの割り当て量 (.NET 10.0.10 および 11 RC 3) |
|---|---|
| 配列に対する単一インデックスの `for` ループ | 0 B |
| スライスした 2 つの `ReadOnlySpan<int>` に対する `for` ループ | 0 B |
| 2 つの `List<int>` に対する `CollectionsMarshal.AsSpan` | 0 B |
| `foreach` で使う `ref struct` の zip 列挙子 | 0 B |
| 手動で進める 2 つの `List<int>.Enumerator` | 0 B |
| 2 つの `IEnumerator<int>`、ソースは配列を `IEnumerable<int>` として型付け | 64 B |
| 2 つの `IEnumerator<int>`、ソースはリストを `IEnumerable<int>` として型付け | 80 B |
| `Enumerable.Zip` のタプルオーバーロード、配列 | 144 B |
| static な結果セレクター付きの `Enumerable.Zip`、配列 | 160 B |
| `Enumerable.Zip` のタプルオーバーロード、リスト | 160 B |
| 3 つのソースを取る `Enumerable.Zip`、配列 | 208 B |

コストは要素ごとではなく呼び出しごとなので、起動時に 1 回だけ実行するループでは問題になりません。問題になるのは、並行ループがリクエストハンドラー、ゲームのティック、パーサーなど、何百万回も実行される場所にある場合です。呼び出しごとに数百バイト、それに呼び出し頻度を掛けたものが、まさにトレースに現れる Gen0 の揺れです。

セレクターオーバーロードで static ラムダを使っても効果はなかった点に注意してください。デリゲートはキャッシュされますが、イテレーターと 2 つの列挙子は依然として割り当てられます。

## 最速のバージョン: 単一インデックスとスライスした 2 つの span

両方のソースが連続したメモリであれば、列挙子はまったく必要ありません。1 つのインデックスで両方を走査します:

```csharp
// .NET 10, C# 14
static long DotProduct(ReadOnlySpan<int> a, ReadOnlySpan<int> b)
{
    int n = Math.Min(a.Length, b.Length);
    a = a[..n];
    b = b[..n];

    long sum = 0;
    for (int i = 0; i < a.Length; i++)
        sum += (long)a[i] * b[i];
    return sum;
}

int[] prices = [10, 20, 30];
int[] quantities = [3, 2, 1];
long total = DotProduct(prices, quantities); // 100
```

スライスは飾りではありません。ループ条件は `i < a.Length` なので、JIT は `a[i]` の境界チェックを省略できます。同じ `n` で `b = b[..n]` を行った後は、JIT は `b.Length == a.Length` であることも把握するため、`b[i]` のチェックも省略できます。スライスがないと、ループ内に `b` が少なくとも `a` と同じ長さであることを証明するものが何もないため、`b[i]` は反復のたびに境界チェックを残します。これは [Span<T> とは何か、そして実際にコードを速くするのはどんなときか](/ja/2026/06/what-is-span-and-when-does-it-make-my-code-faster/) で取り上げた "長さをループの上限にする" というルールと同じです。

配列は暗黙的に `ReadOnlySpan<T>` に変換されるので、呼び出し側はすっきりしたままです。`List<T>` の場合は、`CollectionsMarshal.AsSpan` でその内部配列に対する span を取得します:

```csharp
// .NET 10, C# 14
using System.Runtime.InteropServices;

List<int> prices = [10, 20, 30];
List<int> quantities = [3, 2, 1];

long total = DotProduct(
    CollectionsMarshal.AsSpan(prices),
    CollectionsMarshal.AsSpan(quantities));
```

`CollectionsMarshal.AsSpan` はコストがかかりません。リストの内部配列に対する、`Count` に制限された span を返します。注意点は、span がもはやリストのことを知らないということです。span を保持している間にリストへ `Add` してリストが拡張されると、span は古い配列を指し続け、例外なしに古いデータを読むことになります。span が生きている間はリストのサイズを変更しないでください。このトレードオフの残りについては [List<T> vs Span<T> vs ReadOnlySpan<T>](/ja/2026/05/list-vs-span-vs-readonlyspan-in-csharp/) の比較で詳しく扱っています。

一方のシーケンスを読みながらもう一方に書き込むには、書き込み先を `ReadOnlySpan<T>` ではなく `Span<T>` にします。パターンは変わりません。

## ref struct の zip 列挙子で foreach 構文を維持する

インデックスループは速いものの見た目は良くなく、本体が 1 行を超えると `a[i]` と `b[i]` が煩雑になります。C# の `foreach` はパターンベースです。`IEnumerable<T>` は必要なく、`MoveNext()` と `Current` を持つものを返す `GetEnumerator()` メソッドさえあれば十分です。その "もの" は `ref struct` にできるので、span を保持でき、決してボックス化されません:

```csharp
// .NET 10, C# 14
public ref struct SpanZip<T1, T2>
{
    private readonly ReadOnlySpan<T1> _first;
    private readonly ReadOnlySpan<T2> _second;
    private int _index;

    public SpanZip(ReadOnlySpan<T1> first, ReadOnlySpan<T2> second)
    {
        _first = first;
        _second = second;
        _index = -1;
    }

    public SpanZip<T1, T2> GetEnumerator() => this;

    public bool MoveNext()
    {
        int i = _index + 1;
        if ((uint)i < (uint)_first.Length && (uint)i < (uint)_second.Length)
        {
            _index = i;
            return true;
        }
        return false;
    }

    public (T1 First, T2 Second) Current => (_first[_index], _second[_index]);
}

public static class SpanZipExtensions
{
    public static SpanZip<T1, T2> ZipSpan<T1, T2>(
        this ReadOnlySpan<T1> first, ReadOnlySpan<T2> second) => new(first, second);
}
```

使い方は LINQ のように読めます:

```csharp
// .NET 10, C# 14
int[] prices = [10, 20, 30];
int[] quantities = [3, 2, 1];

long total = 0;
foreach (var (price, quantity) in prices.ZipSpan(quantities))
    total += (long)price * quantity;
```

返されるタプルは構造体である `ValueTuple` なので、分解してもヒープ上のコストはかかりません。型引数を推論させたまま `int[]` に対して `ReadOnlySpan<T>` の拡張メソッドを直接呼び出せるのは、C# 14 のファーストクラスの span 変換のおかげです。C# 13 では先に `prices.AsSpan()` と書く必要があります。`List<T>` の場合は `CollectionsMarshal.AsSpan(list)` に対して呼び出します。

`MoveNext` の形は見た目以上に重要です。最初のバージョンでは、コンストラクターで両方の span を共通の長さにスライスし、`MoveNext` では `_index` を `_first.Length` とだけ比較していました。これは正しく動作しましたが、コストは単純なループのほぼちょうど 2 倍でした。`MoveNext` で両方の長さをチェックするようにしたところ、1.23 倍まで下がりました。私の解釈では、`MoveNext` と `Current` がインライン化されると、JIT は 2 つのインデクサー呼び出しの直前に両方の比較を見ることになり、それを使って境界チェックを省略できます。別のメソッドで行ったスライスではその事実が JIT に伝わりません。いずれにせよ計測上の差は大きいので、両方のチェックを残してください。

`ref struct` には 2 つの制約があります。`SpanZip` を `await` や `yield return` をまたいで使うことはできず、通常のクラスのフィールドに格納することもできません。コンパイラーが有効期間について文句を言う場合、そのルールは [C# が ref-safe-context をどのように決定するか](/ja/2026/10/what-is-ref-safe-context-in-csharp-and-how-does-the-compiler-decide-it-for-ref-locals/) で説明したものです。

## ソースがインデックスアクセスできない場合

`HashSet<T>`、`Dictionary<TKey, TValue>`、`Queue<T>`、`LinkedList<T>` などは span を提供できませんが、どれも具象型に対して `GetEnumerator()` を呼び出すと public な構造体の列挙子を公開します。その 2 つを自分で進めます:

```csharp
// .NET 10, C# 14
static long SumProducts(List<int> a, List<int> b)
{
    long sum = 0;
    using var ea = a.GetEnumerator();   // List<int>.Enumerator, a struct
    using var eb = b.GetEnumerator();
    while (ea.MoveNext() && eb.MoveNext())
        sum += (long)ea.Current * eb.Current;
    return sum;
}
```

これは呼び出しごとに 0 B と計測されました。重要なのはパラメーターの静的な型です。`List<int>` を `IEnumerable<int>` に変えると、まったく同じ本体が呼び出しごとに 80 B (ボックス化された 2 つの `List<int>.Enumerator` インスタンス) を割り当て、実行時のオブジェクトが配列の場合は 64 B を割り当てます。`var` がこれを隠しています。`ea` は一方のバージョンでは `List<int>.Enumerator` で、もう一方では `IEnumerator<int>` です。

構造体の列挙子はコレクション自身の安全性チェックも維持します。`List<T>.Enumerator` は列挙中にリストが変更されると `InvalidOperationException` をスローしますが、span ベースのバージョンではそれができません。

順序がここでのもう 1 つの落とし穴です。2 つの `HashSet<T>` や `Dictionary<TKey, TValue>` インスタンスを並行して走査すると、要素は内部のバケット順でペアになります。これは挿入順ではなく、同じ内容を持つ別のインスタンス間でも安定していません。zip するのは順序付きのコレクションだけにしてください。実際にキーで項目を照合しようとしているのであれば、それは zip ではなく結合か辞書の検索です。

## .NET 10 のスタック割り当てで解決すること、しないこと

.NET 10 では、[What's new in .NET 10 runtime](https://learn.microsoft.com/dotnet/core/whats-new/dotnet-10/runtime#array-enumeration-de-abstraction) のページにあるとおり、JIT が配列のインターフェースメソッドを非仮想化し、条件付きエスケープ解析によって "特定のシナリオで" 列挙子をスタックに割り当てられるようになりました。これでインターフェース版がコストゼロになると期待するのは自然です。しかし私の実行ではそうなりませんでした:

- `Enumerable.Zip` の各バリアントは、.NET 10.0.10 と .NET 11 RC 3 で同じバイト数を割り当てました。列挙子は `Zip` のイテレーター内部で生成され、そのイテレーターは呼び出し元へエスケープするため、エスケープ解析が手を出せる余地がありません。
- 配列に対する 2 つの `IEnumerator<int>` は、私の定常状態の計測では 64 B、BenchmarkDotNet では 32 B を割り当てました。これは、JIT があるコンパイルでは 2 つの列挙子のうち 1 つをスタックに割り当て、別のコンパイルではどちらも割り当てなかったことを示唆しています。これは当てにできない最適化であり、ゼロになることはありません。

脱抽象化の取り組みは本物であり、`IEnumerable<T>` として型付けされた配列に対する単一シーケンスの `foreach` には実際に効果があります。背景を知りたい場合は、[.NET 10 の小さな配列のスタック割り当て](/ja/2025/04/net-10-stack-allocation-of-arrays-of-value-types/) で関連する配列の取り組みを取り上げています。ただし、2 つのソースのケースはまだカバーされていません。

## 計測結果

BenchmarkDotNet 0.15.8、`[MemoryDiagnoser]`、インプロセスツールチェーン、.NET 10.0.10 Arm64 RyuJIT、Apple M4、1,000 個の `int` 値を持つ 2 つの配列 (またはリスト) で積の和を計算:

| メソッド | Mean | Ratio | Allocated |
|---|---:|---:|---:|
| 配列に対する単一インデックスの `for` | 247.9 ns | 1.00 | 0 B |
| スライスした 2 つの `ReadOnlySpan<int>` に対する `for` | 249.7 ns | 1.01 | 0 B |
| 2 つのリストに対する `CollectionsMarshal.AsSpan` | 250.9 ns | 1.01 | 0 B |
| `MoveNext` で両方の長さをチェックする `SpanZip` | 310.0 ns | 1.23 | 0 B |
| コンストラクターでスライスする `SpanZip` (初版) | 489.6 ns | 1.97 | 0 B |
| 手動で進める 2 つの `List<int>.Enumerator` | 652.5 ns | 2.63 | 0 B |
| 配列に対する 2 つの `IEnumerator<int>` | 1,621.2 ns | 6.54 | 32 B |
| static セレクター付きの `Enumerable.Zip` | 2,535.9 ns | 10.23 | 160 B |
| `Enumerable.Zip` のタプルオーバーロード | 2,613.6 ns | 10.54 | 144 B |

両方をチェックする `SpanZip` の行は、同じベンチマーククラスの 2 回目の実行から得たもので、その実行では `for` のベースラインが 251.4 ns と計測されたため、比率はその実行のベースラインに対するものです。インプロセスツールチェーンが必要だったのは、ファイルベースの `dotnet run bench.cs` アプリでは BenchmarkDotNet が通常の別プロジェクトを生成できないためです。

この表から読み取れることは 2 つあります。1 つ目は、span 形状のものはすべて手書きのループとノイズの範囲内に収まることです。`CollectionsMarshal.AsSpan` による計測可能な上乗せはありません。2 つ目は、"割り当てゼロ" と "速い" は別の性質だということです。手動の構造体列挙子は何も割り当てませんが、`List<T>.Enumerator.MoveNext` が要素ごとにバージョンチェックと境界チェックを行うため、依然として 2.6 倍のコストがかかります。GC の負荷が懸念であれば、割り当てゼロのどの行でも解決します。スループットが懸念であれば、span を使ってください。

## どれを選ぶか

- 両方のソースが配列、リスト、`ImmutableArray<T>`、`Memory<T>`、またはスタックバッファーの場合: スライスした span の `for` ループを使うか、`foreach` を好み、タイトな数値ループで約 20% を許容できるなら `SpanZip` を使います。本体で実際の処理を行うループであれば、1,000 要素あたり 60 ns の差は消えてしまいます。
- ソースがその他の BCL コレクションの場合: 具象型のまま保持し、構造体の列挙子を進めます。決して先に `IEnumerable<T>` パラメーターを経由させないでください。
- 長さが異なる可能性があり、それがバグである場合: ループの前に `a.Length != b.Length` をチェックして例外をスローします。`Enumerable.Zip`、上記の span ループ、`SpanZip` はいずれも短い方のシーケンスで黙って停止し、BCL には厳密な zip がありません。.NET 11 RC 3 の参照アセンブリを確認しましたが、標準で用意されている zip は依然として `Enumerable.Zip` だけです。
- ソースが 3 つ以上の場合: span ループは簡単に拡張できます (3 つすべてを最小の長さにスライスします)。.NET 6 で追加された `Enumerable.Zip` の 3 ソースオーバーロードは、呼び出しごとに 208 B かかります。
- コールドなコード、小さな入力、またはすでに割り当てを行っている LINQ パイプラインの場合: `Enumerable.Zip` をそのまま使います。最も明快なバージョンであり、そこではバイト数は問題になりません。

大量の LINQ を span に移行する場合は、C# 14 で配列引数が span オーバーロードにバインドされる方法が変わったことを覚えておいてください。[C# 14 の暗黙的な span 変換](/ja/2025/04/implicit-span-conversions-in-c-14-first-class-support-for-span-and-readonlyspan/) で、以前は `IEnumerable<T>` オーバーロードを選んでいた呼び出しが、今では span のオーバーロードを選ぶ可能性がある理由を説明しています。

### 次に読む

- [C# の Span<T> とは何か、そして実際にコードを速くするのはどんなときか](/ja/2026/06/what-is-span-and-when-does-it-make-my-code-faster/)
- [C# における List<T> vs Span<T> vs ReadOnlySpan<T>](/ja/2026/05/list-vs-span-vs-readonlyspan-in-csharp/)
- [C# の ref-safe-context とは何か、そしてコンパイラーは ref ローカルに対してそれをどのように決定するのか](/ja/2026/10/what-is-ref-safe-context-in-csharp-and-how-does-the-compiler-decide-it-for-ref-locals/)
- [.NET 10: 値型の配列のスタック割り当て](/ja/2025/04/net-10-stack-allocation-of-arrays-of-value-types/)

### 参考資料

- [Enumerable.Zip メソッド](https://learn.microsoft.com/dotnet/api/system.linq.enumerable.zip) (Microsoft Learn)
- [CollectionsMarshal.AsSpan メソッド](https://learn.microsoft.com/dotnet/api/system.runtime.interopservices.collectionsmarshal.asspan) (Microsoft Learn)
- [foreach ステートメントとパターンベースの列挙](https://learn.microsoft.com/dotnet/csharp/language-reference/statements/iteration-statements#the-foreach-statement) (C# 言語リファレンス)
- [ref struct 型](https://learn.microsoft.com/dotnet/csharp/language-reference/builtin-types/ref-struct) (C# 言語リファレンス)
- [What's new in .NET 10 runtime: 配列列挙の脱抽象化とスタック割り当て](https://learn.microsoft.com/dotnet/core/whats-new/dotnet-10/runtime)
- [.NET 10 の脱抽象化計画、dotnet/runtime#108913](https://github.com/dotnet/runtime/issues/108913)
