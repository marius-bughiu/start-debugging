---
title: "C# における List<T> vs Span<T> vs ReadOnlySpan<T>: どれを選ぶべきか"
description: "List<T> は伸長するヒープ上のコレクションです。Span<T> と ReadOnlySpan<T> は、すでに所有しているメモリに対するスタック専用のビューです。保存・async からの返却・伸長が必要なものには List<T> を、同期メソッド内での変更可能でアロケーションのないビューには Span<T> を、文字列・u8 リテラル・スライスに対する読み取り専用の解析には ReadOnlySpan<T> を使います。"
pubDate: 2026-05-25
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "performance"
  - "memory"
lang: "ja"
translationOf: "2026/05/list-vs-span-vs-readonlyspan-in-csharp"
translatedBy: "claude"
translationDate: 2026-05-25
---

伸長し、フィールドに保存され、メソッドから返され、または `await` をまたいで渡されるコレクションには `List<T>` を使います。すでに持っている連続バッファ (配列、`stackalloc` ブロック、スライス) に対する変更可能でアロケーションのないビューが、単一の同期メソッド内で欲しいときには `Span<T>` を使います。読み取りだけを行う同じビューには `ReadOnlySpan<T>` を使います。文字列のスライス、`u8` リテラル、解析、検索などです。好みを上書きする決定が一つあります。2 つの span は `ref struct` 型なので、ヒープ上には存在できず、クラスのフィールドにはなれず、`await` や `yield` をまたぐこともできません。これらのいずれかが必要なら、`List<T>` (または配列) を使うしかありません。

この記事は .NET 11 と C# 14 を対象としています。`Span<T>` と `ReadOnlySpan<T>` は .NET Core 2.1 以降 BCL に、C# 7.2 以降言語に存在しますが、ここで重要なのは 2 つの最近の変更です。C# 13 (.NET 9) は `allows ref struct` という逆制約と `params ReadOnlySpan<T>` を追加し、C# 14 (.NET 11) は配列と span のあいだのファーストクラスの暗黙変換を追加しました。どちらもこれらの型のあいだを行き来する摩擦を減らします。`List<T>` は .NET Framework 2.0 にさかのぼります。

## これらは同じものの 3 つのバリエーションではありません

この比較が人を混乱させるのは、3 つの名前が同格に見えるのに、実はそうではないからです。そのうち 2 つは名ばかりのコレクションです。

`List<T>` はクラスです。これは、いっぱいになると容量を倍にするプライベートな `T[]` を包む伸長するラッパーです。マネージドヒープ上に存在し、GC が追跡し、フィールドに保存でき、返すことができ、ラムダで捕捉でき、`async` メソッドに渡せます。自身のストレージを所有し、伸長できます。これは何も考えずに手に取る日常のコレクションであり、たいていその直感は正しいのです。

`Span<T>` は `ref struct` です。メモリを一切所有しません。これは、ほかの誰かが確保した連続領域 (配列、配列のスライス、`stackalloc` バッファ、またはアンマネージドメモリ) を指す、小さな値 (マネージド参照と長さ) です。下層のストレージを所有していないため、伸長できません。変更可能です。`Span<T>` を通じて書き込むと、下層のバッファに書き込まれます。`ref struct` であるため、ランタイムはそれがスタック上にのみ存在できることを保証します。これこそがスタックメモリを指すのを安全にしているものですが、同時にフィールドになること、ボックス化されること、`await` を生き延びることを禁じているものでもあります。

`ReadOnlySpan<T>` は同じ `ref struct` のビューで、書き込み機能がないものです。これは文字列のスライスが返すもの (`"hello".AsSpan(1, 3)`)、UTF-8 リテラルが生成するもの (`"GET"u8` は `ReadOnlySpan<byte>` です)、そしてバッファを読み取るだけのときに受け取るべきパラメーター型です。`Span<T>` のスタック専用の制約について述べたすべてが、そのまま当てはまります。

ですから本当の問いは「どのコレクションか」であることはまれです。それは「バッファを所有して伸長するのか (`List<T>`)、それともすでに持っているものを、変更可能に (`Span<T>`) または読み取り専用に (`ReadOnlySpan<T>`) 見るのか」です。

## 決定マトリックス

以下の動作は、特に記載がない限り .NET 9+ / C# 13+ のものです。

| 能力                                          | `List<T>`              | `Span<T>`                  | `ReadOnlySpan<T>`          |
| --------------------------------------------- | ---------------------- | -------------------------- | -------------------------- |
| 種別                                          | クラス (ヒープ)        | `ref struct` (スタック)    | `ref struct` (スタック)    |
| 自身のストレージを所有                        | はい                   | いいえ (ビュー)            | いいえ (ビュー)            |
| 伸長できる / `Add`                            | はい                   | いいえ                     | いいえ                     |
| 要素を変更                                    | はい                   | はい                       | いいえ                     |
| 作成時のアロケーション                        | ヒープ (下層の `T[]`)  | なし                       | なし                       |
| クラスのフィールドに保存                      | はい                   | いいえ                     | いいえ                     |
| `async` メソッドから返す                      | はい                   | いいえ                     | いいえ                     |
| `await` / `yield` をまたいで使う              | はい                   | いいえ                     | いいえ                     |
| ラムダ / クロージャで捕捉                     | はい                   | いいえ                     | いいえ                     |
| ボックス化 / `object` やインターフェースに代入 | はい                  | いいえ                     | いいえ                     |
| ジェネリック型引数として使う                  | はい                   | `allows ref struct` のときのみ | `allows ref struct` のときのみ |
| コピーなしのスライス                          | いいえ (`GetRange` はコピー) | はい (`Slice`、コピーなし) | はい (`Slice`、コピーなし) |
| `string` を元にする                           | いいえ                 | いいえ                     | はい (`AsSpan`)            |
| `stackalloc` を元にする                       | いいえ                 | はい                       | はい                       |
| 初出                                          | .NET Framework 2.0     | .NET Core 2.1              | .NET Core 2.1              |

「クラスのフィールドに保存」から「ボックス化」までの行が、ほとんどの実際のケースを決めます。あなたのシナリオでそのいずれかが「はい」であれば、span は外れ、`List<T>` か配列を保持します。それ以外はすべて、パフォーマンスと使い勝手の問題です。

## List<T> を選ぶとき

`List<T>` がデフォルトです。コレクションの寿命が単一の同期メソッドより長いとき、あるいは最終的なサイズが事前にわからないときには、いつでもこれに頼ってください。

- **コレクションを少しずつ構築する。** 行を読み、結果を追加し、イベントを蓄積しています。`Add` は償却 O(1) で、リストは自身でサイズを変えます。span は伸長できないので、勝負にすらなりません。
- **コレクションがフィールドまたは返り値である。** キャッシュ、レジストリ、リポジトリから返す `List<Order>`。`ref struct` はフィールドになれず、非同期境界をまたいで返すこともできないので、スタックフレームより長く生きるものはすべて `List<T>` に入ります。
- **`await` をまたぐ。** メソッドが await した瞬間、await を生き延びるすべてのローカルは、ヒープに確保されたステートマシンに引き上げられます。`ref struct` は引き上げられないので、`Span<T>` のローカルは await を生き延びられません。`List<T>` は生き延びられます。

```csharp
// .NET 11, C# 14 -- List<T> is the only correct choice here:
// it grows, it is returned, and the method is async.
public async Task<List<Order>> LoadRecentAsync(DbContext db, CancellationToken ct)
{
    var results = new List<Order>();
    await foreach (var order in db.Orders.AsAsyncEnumerable().WithCancellation(ct))
    {
        if (order.Total > 100m)
            results.Add(order);   // grows on demand
    }
    return results;               // escapes the stack frame
}
```

正しい選択をしたという手がかりが欲しいなら、メソッドが返ったあともそのコレクションが存在する必要があるかを問うてください。必要なら、それは `List<T>` か配列であり、span ではありません。

## Span<T> を選ぶとき

`Span<T>` は、すでに制御しているメモリに対する変更可能でアロケーションのないビューで、単一の同期メソッド内で使って破棄するためのものです。典型的な利点は、中間のアロケーションを避けることです。

- **`stackalloc` による小さなスクラッチバッファ。** 数値の整形、小さなキーの構築、数バイトのハッシュ化。`stackalloc` はバッファをスタックに置き、`Span<T>` はそれに対する安全なハンドルです。ヒープ上に `T[]` はなく、GC への負荷もありません。
- **バッファをその場でスライスする。** ネットワークフレームの解析: ヘッダーを取り、次にペイロードを取りますが、どちらもコピーしません。`Span<T>.Slice` は同じメモリに対する別のビューを返します。
- **オフセット/長さのパラメーターの寄せ集めなしに配列の領域を変更する。** `buffer.AsSpan(start, length)` を渡すほうが、`(buffer, start, length)` をすべての呼び出しに通すよりきれいで、境界はスライス時に一度だけチェックされます。

```csharp
// .NET 11, C# 14 -- a stackalloc scratch buffer, no heap allocation
public static bool TryFormatTimestamp(long unixSeconds, Span<char> destination, out int written)
{
    Span<char> scratch = stackalloc char[20];   // on the stack, not the heap
    if (!unixSeconds.TryFormat(scratch, out int n))
    {
        written = 0;
        return false;
    }
    return scratch.Slice(0, n).TryCopyTo(destination)
        ? (written = n) >= 0
        : Fail(out written);

    static bool Fail(out int w) { w = 0; return false; }
}
```

アロケーション以外にも、本物のパフォーマンス上の理由があります。JIT は `Span<T>` を直接反復するとき、しばしば境界チェックを除去できます。span の長さがそこにあり、ループの形が認識可能だからです。`List<T>` をその列挙子を通じて反復すると、`MoveNext` ごとにバージョンチェックと境界チェックが実行されます。これは下で計測します。

よくある橋渡し: すでに `List<T>` を持っていて、ホットな読み取りやその場での変更に span のパフォーマンスが欲しいなら、コピーしないでください。`CollectionsMarshal.AsSpan(list)` を呼んで、リストの下層配列に対する `Span<T>` を直接得ます。そのビューはリストのサイズを変える次の操作までしか有効でないので、使ったら手放してください。

## ReadOnlySpan<T> を選ぶとき

`ReadOnlySpan<T>` は、バッファを読み取り、それを変更する必要のない、あらゆる同期メソッドに適したパラメーター型です。Microsoft の [Memory と Span の使用ガイドライン](https://learn.microsoft.com/dotnet/standard/memory-and-spans/memory-t-usage-guidelines) によれば、ルール 1 は「同期 API では `Memory<T>` より `Span<T>` を優先する」、ルール 2 は「バッファが読み取り専用であるべきなら `ReadOnlySpan<T>` を使う」です。解析と検索のほとんどは読み取り専用です。

- **部分文字列を確保せずに文字列をスライスする。** `"2026-05-25".AsSpan(0, 4)` は、新しい `string` なしで年を `ReadOnlySpan<char>` として返します。`int.Parse` などには span のオーバーロードがあるので、スライスから直接解析できます。
- **UTF-8 リテラル。** `"GET"u8` はアセンブリに焼き込まれた `ReadOnlySpan<byte>` です。入ってくるバイトバッファをこれと比較するのはアロケーションなしです。
- **あらゆる形のバッファを受け取る。** `ReadOnlySpan<byte>` を取るメソッドは、`byte[]`、`ArraySegment<byte>`、`stackalloc` バッファ、またはスライスで、オーバーロードなしに呼べます。C# 14 では配列から span への変換が暗黙なので、呼び出し側は `.AsSpan()` すら書きません。

```csharp
// .NET 11, C# 14 -- read-only parsing with zero substring allocations
public static (int year, int month, int day) ParseIsoDate(ReadOnlySpan<char> date)
{
    int year  = int.Parse(date.Slice(0, 4));
    int month = int.Parse(date.Slice(5, 2));
    int day   = int.Parse(date.Slice(8, 2));
    return (year, month, day);
}

// All three callers work; none allocate a substring.
var a = ParseIsoDate("2026-05-25");                 // string -> ReadOnlySpan<char>
var b = ParseIsoDate("2026-05-25".AsSpan());         // explicit
Span<char> buf = stackalloc char[10];
"2026-05-25".CopyTo(buf);
var c = ParseIsoDate(buf);                            // Span<char> -> ReadOnlySpan<char>
```

`Span<T>` は `ReadOnlySpan<T>` に暗黙変換されますが、その逆は決してないことに注意してください。メソッドが実際に必要とする最も制限的な型を取ってください。読み取るだけなら `ReadOnlySpan<T>` を要求すれば、変更可能かどうかにかかわらずすべての呼び出し側があなたに到達できます。これは [複数の検索対象を高速に探す SearchValues<T>](/ja/2026/04/how-to-use-searchvalues-correctly-in-dotnet-11/) と自然に組み合わさります。これは完全に `ReadOnlySpan<T>` 入力を中心に構築されています。

## ベンチマーク: 10,000 個の int を合計する

パフォーマンスの主張は具体的です。`Span<T>` や `ReadOnlySpan<T>` の反復は `List<T>` の反復より速い、というものです。JIT が span では要素ごとの境界チェックを除去するのに対し、リストの列挙子はそうしないからです。計測は以下のとおりです。

```csharp
// .NET 11, C# 14, BenchmarkDotNet 0.14.x
// dotnet run -c Release
[MemoryDiagnoser]
public class SumBench
{
    private List<int> _list = null!;
    private int[] _array = null!;

    [GlobalSetup]
    public void Setup()
    {
        _array = Enumerable.Range(0, 10_000).ToArray();
        _list = new List<int>(_array);
    }

    [Benchmark(Baseline = true)]
    public long ListForeach()
    {
        long sum = 0;
        foreach (int x in _list) sum += x;   // List<T>.Enumerator: version + bounds check
        return sum;
    }

    [Benchmark]
    public long SpanForeach()
    {
        long sum = 0;
        Span<int> span = CollectionsMarshal.AsSpan(_list);  // view, no copy
        foreach (int x in span) sum += x;                   // bounds checks elided
        return sum;
    }

    [Benchmark]
    public long ReadOnlySpanForeach()
    {
        long sum = 0;
        ReadOnlySpan<int> span = _array;     // C# 14 implicit conversion
        foreach (int x in span) sum += x;
        return sum;
    }
}
```

Ryzen 7 / Windows 11 / .NET 11 ビルド、x64 RyuJIT での代表的な結果:

| メソッド              | 平均      | Ratio | アロケート |
| --------------------- | --------- | ----- | ---------- |
| `ListForeach`         | 6.1 us    | 1.00  | 0 B        |
| `SpanForeach`         | 2.4 us    | 0.39  | 0 B        |
| `ReadOnlySpanForeach` | 2.4 us    | 0.39  | 0 B        |

span のループでおよそ 2.5 倍速く、3 つすべてでアロケーションはゼロです (リストはすでに存在し、`CollectionsMarshal.AsSpan` はコピーしません)。正確な比率は要素の型と CPU によって動きますが、方向は安定しています。span の列挙子は `ref` をたどる薄いループで、JIT が強く最適化します。一方 `List<T>.Enumerator` は、並行変更を検出するバージョンチェックを抱えています。そのバージョンチェックは無駄ではなく機能です (反復中に変更すると `List<T>` が `InvalidOperationException` を投げるのはこのためです) が、span が決して払わないサイクルを消費します。

正直な但し書き: 10,000 要素の合計ではこれはマイクロ秒です。ループがホットでないなら、4 マイクロ秒を削るためにコードをねじ曲げないでください。span は、数百万回実行されるホットな内側のループ、パーサー、シリアライザーで真価を発揮するのであって、たまのリスト走査ではありません。

## あなたの代わりに決めてしまう落とし穴

3 つの制約が好みを完全に上書きします。そしてその 3 つすべては、`Span<T>` と `ReadOnlySpan<T>` が `ref struct` 型であることに由来します。

**スコープ内の `await` は span を除外します。** `ref struct` のローカルは `await` を生き延びられません。コンパイラはそれをヒープに確保されたステートマシンに引き上げる必要がありますが、スタック専用の型はそれを禁じるからです。コンパイラはきっぱり拒否します。メソッドが await し、await をまたぐバッファが必要なら、`Memory<T>` / `ReadOnlyMemory<T>` (ヒープに優しい従兄弟) か `List<T>` / 配列を使ってください。await をまたいで安全なビュー型については [T[] を ReadOnlyMemory<T> に変換する方法](/ja/2026/05/how-to-convert-array-to-readonlymemory-in-csharp/) を参照してください。

**フィールド、async をまたぐ返却、またはクロージャは span を除外します。** `class C { Span<int> _buf; }` とは書けません。span をラムダで捕捉できません。`async Task<Span<int>>` から返せません。設計上、バッファが現在のスタックフレームを抜け出る必要が生じた瞬間、答えは `List<T>` か `T[]` で、async には `Memory<T>` ハンドルを添えることもあります。

**C# 13 より前のジェネリックコンテキストは span を制限します。** C# 13 より前は、`Span<T>` をジェネリック型引数として使うことはまったくできませんでした。C# 13 の `allows ref struct` 逆制約があれば使えますが、ジェネリックメソッドや型が `where T : allows ref struct` でオプトインした場合に限ります。オプトインしていないジェネリック API は、依然として span を受け取れません。`List<T>` にはそのような制約はありません。普通のクラスです。

`CollectionsMarshal.AsSpan` には微妙な寿命の罠もあります。それが返す span は、リストの現在の下層配列を指します。その後にサイズ変更を引き起こすほど `Add` すると、リストは新しい配列を確保し、あなたの span は古い、いまや孤立した配列を指すことになります。その span は、リストへの次の変更呼び出しまでしか有効でないものとして扱ってください。

## 推奨、改めて

デフォルトは `List<T>` です。これは、伸長し、保存し、返し、await をまたいで運び、捕捉するコレクションであり、.NET 11 では、計測されたホットパスでない限りあらゆる用途に十分すぎるほど速いです。すでに所有しているバッファに対する変更可能でアロケーションのないビューが欲しく、それを単一の同期メソッド内で使って破棄するとき、とくに `stackalloc` やその場のスライスを伴うときには `Span<T>` に下りてください。同期的な読み手のパラメーター型として、また文字列のスライスや `u8` リテラルの返り値として `ReadOnlySpan<T>` を使い、部分文字列を確保せずに解析・検索してください。span が理想的なのに `await`、フィールド、クロージャが立ちはだかるときは、`Memory<T>` / `ReadOnlyMemory<T>` に頼るか、`List<T>` のままにしてください。最短の正しい版: 所有して伸長するなら `List<T>`、見て変更するなら `Span<T>`、見て読むなら `ReadOnlySpan<T>`。

## 関連

- [C# 14 における暗黙の Span 変換: Span と ReadOnlySpan のファーストクラスサポート](/ja/2025/04/implicit-span-conversions-in-c-14-first-class-support-for-span-and-readonlyspan/) は、呼び出し側が `.AsSpan()` を省略できるようにする変換を扱います。
- [C# で T[] を ReadOnlyMemory<T> に変換する方法](/ja/2026/05/how-to-convert-array-to-readonlymemory-in-csharp/) は、span が `await` をまたげないときの、await をまたいで安全な対応物です。
- [.NET 11 で SearchValues<T> を正しく使う方法](/ja/2026/04/how-to-use-searchvalues-correctly-in-dotnet-11/) は、高速な複数文字検索のために `ReadOnlySpan<T>` の上に構築されています。
- [.NET 11 でメモリを使い果たさずに大きな CSV を読む方法](/ja/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) は、コピーせずに解析するために span のスライスに大きく依存しています。
- [C# 13: params のアロケーションの終わり](/ja/2026/01/c-13-the-end-of-params-allocations/) は、span が可能にするアロケーションのない `params`、`params ReadOnlySpan<T>` を説明しています。

## 出典

- [Memory<T> と Span<T> の使用ガイドライン (MS Learn)](https://learn.microsoft.com/dotnet/standard/memory-and-spans/memory-t-usage-guidelines)
- [System.Span<T> 構造体リファレンス (MS Learn)](https://learn.microsoft.com/dotnet/api/system.span-1)
- [System.ReadOnlySpan<T> 構造体リファレンス (MS Learn)](https://learn.microsoft.com/dotnet/api/system.readonlyspan-1)
- [allows ref struct 逆制約 (MS Learn、C# 13 提案)](https://learn.microsoft.com/dotnet/csharp/language-reference/proposals/csharp-13.0/ref-struct-interfaces)
- [CollectionsMarshal.AsSpan リファレンス (MS Learn)](https://learn.microsoft.com/dotnet/api/system.runtime.interopservices.collectionsmarshal.asspan)
- [List<T> クラスリファレンス (MS Learn)](https://learn.microsoft.com/dotnet/api/system.collections.generic.list-1)
