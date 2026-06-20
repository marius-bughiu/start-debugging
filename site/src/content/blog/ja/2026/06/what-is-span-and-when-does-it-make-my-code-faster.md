---
title: "C# の Span<T> とは何か、そしてどんなときに実際にコードを速くするのか?"
description: "Span<T> はスタック上にのみ存在する ref struct で、すでに自分が所有しているメモリを指すため、裏付けとなるアロケーションを持ちません。コードが速くなるのは正確に 3 つの状況だけです: ヒープのバッファを stackalloc に置き換える、コピーせずにスライスする、JIT が境界チェックを除去するタイトなループ。それ以外の場所では何も変わらず、await をまたぐとコンパイルできません。"
pubDate: 2026-06-20
tags:
  - "csharp"
  - "dotnet"
  - "performance"
  - "memory"
lang: "ja"
translationOf: "2026/06/what-is-span-and-when-does-it-make-my-code-faster"
translatedBy: "claude"
translationDate: 2026-06-20
---

`Span<T>` はスタック上にのみ存在する `ref struct` で、すでに自分が所有しているメモリの連続した領域を表します。配列、その一部、`stackalloc` バッファ、文字列の一部分、あるいはアンマネージドメモリです。マネージド参照に長さが加わったもの、それ以上ではありません。アロケーションせず、コピーせず、拡張もできません。それが型のすべてです。人々がこれに手を伸ばす理由はパフォーマンスですが、コードが速くなるのは具体的に 3 つの状況だけです: ヒープのアロケーションを `stackalloc` に置き換えられるとき、バッファをコピーせずにスライスできるとき、そして JIT が境界チェックを除去できる形にループを変えるとき。それ以外では、Span は明快さのためのツールであってパフォーマンスのためのツールではなく、3 つのどれも行わないコードに無理やり入れても何も得られません。この記事は .NET 11 と C# 14 を対象としますが、`Span<T>` 自体は .NET Core 2.1 から BCL に、C# 7.2 から言語に存在します。

落とし穴は、「`Span<T>` を使え、その方が速い」が文の後半なしに繰り返されることです。そこで後半をお伝えします: この型が実際に何であるか、サイクルを節約する正確なメカニズム、そして同じくらい重要な、Span を入れても生成コードがほぼゼロしか変わらないケースの一覧です。

## メモリに対するビューであり、コンテナではない

混乱の大部分を解消するメンタルモデル: `Span<T>` はコレクションではありません。窓です。`List<T>` や `T[]` は自身のストレージを所有し、ヒープ上に存在し、ガベージコレクションがそれらを追跡します。`Span<T>` は何も所有しません。あるメモリの先頭への参照と、いくつの要素が有効かというカウントを保持します。生成してもアロケーションは起きません。割り当てるものが何もないからです: バイト列はすでにどこかに存在しており、Span はその一区間に名前を付けるだけです。

```csharp
// .NET 11, C# 14
int[] numbers = { 10, 20, 30, 40, 50 };

Span<int> all = numbers;          // a view over the whole array, no copy
Span<int> middle = all.Slice(1, 3); // {20, 30, 40}, still the same backing memory

middle[0] = 99;                   // writes THROUGH to numbers[1]
Console.WriteLine(numbers[1]);    // 99
```

`middle` は 3 つの整数をコピーしていません。`numbers[1]` への参照に長さ `3` が加わったものです。これを通して書き込むと元の配列に書き込まれます。配列は 1 つしかないからです。このエイリアシングこそが目的のすべてです: Span は、別の場所に存在するメモリへの、安価で型付きの、境界チェック付きのハンドルです。

ランタイムは `ref struct` がスタック上にのみ存在できることを保証するため、Span はヒープからスタックへの参照が生むであろう生存期間の危険なしに、スタックメモリ(`stackalloc` バッファ)を安全に指すことができます。同じ保証が、この型が持つすべての制約の源であり、それには後で触れます。まずは、あなたが来た目的の部分です。

## 速さは実際にはどこから来るのか

Span は 3 つの異なるメカニズムでコードを速くします。それらは独立しています: あるコードは 1 つ、2 つ、あるいはどれにも当てはまらないかもしれません。どれにも当てはまらなければ、Span は実行時間に対して何もしていません。

### メカニズム 1: そもそもアロケーションしなくて済む

これが大物で、実際に仕事をしているのは Span ではありません。Span は `stackalloc` を使えるものにする安全なハンドルです。小さなスクラッチバッファ(数値のフォーマット、ルックアップキーの構築、数バイトのハッシュ計算)は伝統的にヒープ上の `new byte[n]` や `new char[n]` を意味し、それを後で GC が回収しなければなりませんでした。`stackalloc` を使えば、バッファはスタックフレーム上に存在し、メソッドが戻るときに無料で消えます。`Span<T>` はそのスタックメモリを安全に読み書きする手段です。

```csharp
// .NET 11, C# 14 -- format an int to text with zero heap allocation
public static string ToHex(int value)
{
    Span<char> buffer = stackalloc char[8];   // on the stack, not the heap
    value.TryFormat(buffer, out int written, "X");
    return new string(buffer[..written]);     // the only allocation is the final string
}
```

利得は GC への圧力で測られ、ループの生の速度ではありません。毎秒 100 万個の小さな使い捨てバッファをアロケーションすれば、gen-0 コレクターが歩き回らなければならない 100 万個のオブジェクトを生み出します。それらを `stackalloc` に移せば、その圧力はゼロになります。ホットパスでは、アロケーションの除去はループから命令を削るよりも大きなエンドツーエンドの利得になることがよくあります。GC の一時停止はあなたのメソッドだけでなくプロセス全体に影響するからです。これは [params の割り当てを排除する params ReadOnlySpan<T>](/ja/2026/01/c-13-the-end-of-params-allocations/) の背後にあるのと同じ直感です: 最も速いアロケーションは決して起こらないアロケーションです。

### メカニズム 2: コピーせずにスライスできる

2 つ目のメカニズムは `Slice` です。`string` では、`Substring` で部分文字列を取ると真新しい `string` をアロケーションして文字をコピーします。配列では、`GetRange` や、新しいコレクションに実体化する LINQ の `Skip`/`Take` も同じくコピーします。Span の `Slice` はどちらも行いません: オフセットと長さを調整した、同じメモリを指す別の Span を返します。コピーゼロ、アロケーションゼロです。

```csharp
// .NET 11, C# 14 -- parse "2026-06-20" with no substring allocations
public static (int Year, int Month, int Day) ParseIsoDate(ReadOnlySpan<char> date)
{
    int year  = int.Parse(date.Slice(0, 4));  // no new string
    int month = int.Parse(date.Slice(5, 2));
    int day   = int.Parse(date.Slice(8, 2));
    return (year, month, day);
}

var parsed = ParseIsoDate("2026-06-20");      // string converts to ReadOnlySpan<char> implicitly
```

ここでの各 `int.Parse` は元の文字列のスライスから直接読み取ります。`date.Substring(0, 4)` を使う古いバージョンは、呼び出しごとに 3 つの短命な文字列をアロケーションします。何百万行も走るパーサーでは、それは何百万回も回避されたアロケーションになります。`int.Parse`、`DateTime.Parse`、`Guid.Parse` などの Span オーバーロードは、まさに部分文字列を一度も実体化せずにスライスから解析できるように存在します。これは高速な CSV とログ解析のバックボーンであり、だからこそ [メモリ不足にならずに大きな CSV を読む](/ja/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) は各行をその場で歩くために Span のスライスに頼ります。

### メカニズム 3: JIT がタイトなループで境界チェックを除去する

3 つ目のメカニズムは最も微妙で、人々が理解せずに最も頻繁に持ち出すものです。`span.Length` で境界を区切った `for` ループで Span をイテレートすると、JIT はすべてのインデックスが範囲内であることを証明でき、要素ごとの境界チェックを完全に除去できます。`for (int i = 0; i < span.Length; i++)` のパターンを認識し、`span[i]` が範囲外になり得ないことを知っているため、各アクセスを守るはずの比較と分岐を破棄します。Microsoft の JIT チームは、RyuJIT が配列の境界チェックを認識するのと同じように Span の境界チェックを認識するよう、何年もかけて教え込んできました。そして .NET 10 は、より多くのループの形が対象になるよう、根底にあるアサーション解析を順序に依存しにくくしました。これは [Performance Improvements in .NET 10](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-10/) の記事に記載されています。

これを `List<T>` をその列挙子経由でイテレートする場合と比べてください。`List<T>.Enumerator.MoveNext` はステップごとにバージョンチェック(イテレーション中にリストを変更すると `InvalidOperationException` をスローするメカニズム)に加えて境界チェックを実行します。そのバージョンチェックは正しさのための機能であって無駄ではありませんが、Span が決して払わないサイクルを消費します。

```csharp
// .NET 11, C# 14, BenchmarkDotNet 0.14.x -- dotnet run -c Release
[MemoryDiagnoser]
public class SumBench
{
    private List<int> _list = null!;

    [GlobalSetup]
    public void Setup() => _list = new List<int>(Enumerable.Range(0, 10_000));

    [Benchmark(Baseline = true)]
    public long ListForeach()
    {
        long sum = 0;
        foreach (int x in _list) sum += x;   // version + bounds check per step
        return sum;
    }

    [Benchmark]
    public long SpanForeach()
    {
        long sum = 0;
        Span<int> span = CollectionsMarshal.AsSpan(_list);  // a view, no copy
        foreach (int x in span) sum += x;                   // bounds checks elided
        return sum;
    }
}
```

Ryzen 7 / Windows 11 / .NET 11 ビルド、x64 RyuJIT での代表的な結果:

| Method        | Mean   | Ratio | Allocated |
| ------------- | ------ | ----- | --------- |
| `ListForeach` | 6.1 us | 1.00  | 0 B       |
| `SpanForeach` | 2.4 us | 0.39  | 0 B       |

およそ 2.5 倍速く、どちらもアロケーションなし(リストはすでに存在し、`CollectionsMarshal.AsSpan` はコピーせずにその裏付け配列上の Span を渡します)。正確な比は要素の型と CPU で変わりますが、方向は安定しています。ただし単位に注目してください: これは 10,000 要素に対するマイクロ秒です。この数字こそが、次のセクションのすべての理由です。

## Span<T> があなたに何もしないとき

ここが、このアドバイスのカーゴカルト版が省く部分です。Span が役立つのは、その 3 つのメカニズムの 1 つが働いているときだけです。どれも発動しないコードに入れれば、同一の実行時間のために、より制約の多いコードを書いたことになります。さらに悪いことに、遅くしたか、コンパイルできなくしたかもしれません。

**Span に変換してすぐにコピーで取り出す。** あなたの「最適化」が `array.AsSpan().ToArray()` であったり、結果を `.ToArray()` するためだけに Span をスライスしたりするなら、結局アロケーションしています。コピーがコストであり、その前の Span は何ももたらしていません。メカニズム 2 の利得は、ビューを通して読み続けている間だけ存在します。

**ループがホットでない。** メカニズム 3 は 10,000 要素に対して 3.7 マイクロ秒を節約しました。そのループが Web リクエストごとに 1 回、あるいは合計で数百回しか走らないなら、5 桁の差で霞ませるネットワークとデータベースのレイテンシに対して、その差を測ることは決してできません。読みやすいコードをねじ曲げてコールドパスからマイクロ秒を削るのは差し引きの損です: 誰も観測できない高速化のために、明快さと制約で支払っているのです。Span は、何百万回も走るパーサー、シリアライザー、内側のループでその価値を発揮するのであって、たまのコレクションの走査ではありません。

**すでに配列を持っていて、それを順次読むだけ。** `T[]` に対する素朴な `foreach` は、すでに JIT から境界チェックの除去を得ています。配列は、その最適化が作られた元々のケースです。先に配列を Span でラップしてもループは速くなりません。配列のループはすでに速かったからです。Span が役立つのは、ソースが `List<T>`(その列挙子がバージョンチェックを抱える)であるとき、あるいはスライスが必要なときであって、すでに配列を持って先頭から末尾まで歩くときではありません。

**大きすぎる `stackalloc` を強行する。** メカニズム 1 が勝つのは小さなバッファに対してだけです。大きい、あるいは呼び出し側が制御するサイズの `stackalloc` はスタックオーバーフローのリスクがあり、それは遅いパスではなくクラッシュです。通常の指針は、`stackalloc` を小さな定数(一般に数百バイトから ~1 KB)に制限し、それを超えたらプール配列かヒープ配列にフォールバックすることです。大きすぎる `stackalloc` の上の Span は速くありません。潜在的な `StackOverflowException` です。

Span に手を伸ばす前の正直なテスト: 私は 3 つのメカニズムのどれを買っているのか? 1 つも挙げられないなら、習慣でこの型に手を伸ばしています。特定のフィールドや戻り値についてそれらの間で選ぶなら、[List vs Span vs ReadOnlySpan の判断ガイド](/ja/2026/05/list-vs-span-vs-readonlyspan-in-csharp/) が所有権と生存期間の軸全体を歩きます。

## 制約と、それらが存在する理由

`Span<T>` のすべての制約は 1 つの事実から導かれます: それは `ref struct` であり、ランタイムはそれをスタック上にのみ存在するよう強制します。それこそが `stackalloc` メモリを指すことを安全にしているのであり、交渉の余地はありません。

**`await` や `yield` をまたげない。** メソッドが await すると、コンパイラは await を生き延びるすべてのローカル変数を、ヒープに割り当てられたステートマシンに巻き上げます。スタック上にのみ存在する型は巻き上げられないため、コンパイラは `await` をまたぐ `Span<T>` のローカル変数をきっぱり拒否します。これは人々が最初にぶつかる制約です。非同期境界をまたぐバッファが必要なら、ヒープに優しい従兄弟である `Memory<T>` か `ReadOnlyMemory<T>` を使ってください。[配列を ReadOnlyMemory<T> に変換する方法](/ja/2026/05/how-to-convert-array-to-readonlymemory-in-csharp/) が await 安全なビュー型を扱います。

**クラスのフィールドにできず、ボックス化できず、ラムダにキャプチャできない。** `class C { Span<int> _buf; }` とは書けず、Span を `object` に代入できず、クロージャでそれを閉じ込められません。これらのいずれも Span をスタックフレームから逃がすことになり、型はそれを禁じます。設計がビューに現在のメソッドより長く生きてほしいと求めた瞬間、答えは `List<T>`、`T[]`、あるいは `Memory<T>` ハンドルです。

**ジェネリックでの使用には `allows ref struct` が必要。** C# 13 より前は、`Span<T>` をジェネリック型引数として使うことはまったくできませんでした。C# 13 の `allows ref struct` 反制約がそれを解除しましたが、それは `where T : allows ref struct` で明示的にオプトインしたジェネリックメソッドと型に対してだけです。オプトインしていない古いジェネリック API は、依然として Span を受け取れません。

**`CollectionsMarshal.AsSpan` のビューはリストがサイズ変更するまでしか有効でない。** その Span はリストの現在の裏付け配列を指します。リサイズを引き起こすだけ `Add` すると、リストは新しい配列をアロケーションし、あなたの Span は古い、今や孤立した配列を指したままになります。そのような Span はただちに使って捨ててください。リストを変更する呼び出しをまたいで決して保持しないでください。

もう 1 つの便利さが C# 14 で入りました: 配列が今や暗黙に Span に変換されるため、`ReadOnlySpan<char> s = "GET"u8` と書き、Span が期待される場所に目に見える `.AsSpan()` なしで `myArray` を渡せます。[C# 14 の暗黙的な Span 変換](/ja/2025/04/implicit-span-conversions-in-c-14-first-class-support-for-span-and-readonlyspan/) の記事が、コンパイラが今あなたの代わりに行う変換を正確に扱います。

## 短い版

`Span<T>` は、すでに自分が所有しているメモリに対する、アロケーションなしでスタック上にのみ存在するビューです。コードを速くするのは 3 つの具体的な方法です: ヒープのバッファを `stackalloc` に置き換えられること、文字列と配列をコピーせずにスライスできること、JIT が境界チェックを除去できるループの形を与えること。これらの利得は、何百万回も走るパーサー、シリアライザー、ホットな内側のループでは本物で大きいものです。コールドパスでは見えず、Span からコピーで取り出すなら、ソースがすでに順次に歩く配列なら、あるいは測定されたホットループがまったくないなら、完全に蒸発します。そして `ref struct` であるため、設計の最初の `await`、フィールド、クロージャで止まります。3 つのメカニズムのどれを買っているか挙げられるときに手を伸ばしてください。挙げられないなら、そこにない高速化のために制約を足しているのです。

## 関連記事

- [C# における List<T> vs Span<T> vs ReadOnlySpan<T>: どれを選ぶべきか](/ja/2026/05/list-vs-span-vs-readonlyspan-in-csharp/) は、特定のフィールドや戻り値について 3 つから選ぶときの判断ガイドです。
- [C# で T[] を ReadOnlyMemory<T> に変換する方法](/ja/2026/05/how-to-convert-array-to-readonlymemory-in-csharp/) は、Span が `await` をまたげないときの await 安全な道です。
- [.NET 11 で SearchValues<T> を正しく使う方法](/ja/2026/04/how-to-use-searchvalues-correctly-in-dotnet-11/) は、SIMD で加速された複数ニードル検索のために `ReadOnlySpan<T>` の上に構築します。
- [.NET 11 でメモリ不足にならずに大きな CSV を読む方法](/ja/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) は、Span のスライスで各行をその場で解析します。
- [C# 14 の暗黙的な Span 変換](/ja/2025/04/implicit-span-conversions-in-c-14-first-class-support-for-span-and-readonlyspan/) は、呼び出し側が `.AsSpan()` を省ける変換を扱います。

## 出典

- [System.Span<T> 構造体リファレンス (MS Learn)](https://learn.microsoft.com/dotnet/api/system.span-1)
- [Memory<T> と Span<T> の使用ガイドライン (MS Learn)](https://learn.microsoft.com/dotnet/standard/memory-and-spans/memory-t-usage-guidelines)
- [Performance Improvements in .NET 10 (.NET Blog)](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-10/)
- [allows ref struct 反制約 (MS Learn, C# 13)](https://learn.microsoft.com/dotnet/csharp/language-reference/proposals/csharp-13.0/ref-struct-interfaces)
- [CollectionsMarshal.AsSpan リファレンス (MS Learn)](https://learn.microsoft.com/dotnet/api/system.runtime.interopservices.collectionsmarshal.asspan)
