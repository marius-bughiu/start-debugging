---
title: ".NET 11 における StringBuilder と文字列補間: どちらを使うべきか"
description: "固定された値のセットを一度に組み立てるなら文字列補間を、ループ内や数が不明なフラグメントにわたって追加するなら StringBuilder を使ってください。分かれ目はループであって、値の数ではありません。"
pubDate: 2026-05-25
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "performance"
  - "strings"
lang: "ja"
translationOf: "2026/05/stringbuilder-vs-string-interpolation-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-05-25
---

固定された既知の値のセットから文字列を組み立てるとき、つまりログの 1 行、URL、メッセージのようなものには、文字列補間 (`$"..."`) を使ってください。ループ内で、または数が不明なフラグメントにわたって追加するときは、`StringBuilder` を使ってください。分かれ目はループであって、値がいくつあるかではありません。1 つの `$"{a} {b} {c} {d}"` は `StringBuilder` を立ち上げるより速く、明快です。`result += item` を 1000 回繰り返すことが、実際にあなたを苦しめる唯一のパターンであり、まさにそのために `StringBuilder` が存在します。この 2 つは本当の意味での競合相手ではなく、どちらの方向で誤った選択をしても、読みやすさか二次的なアロケーションのどちらかを失います。

この記事は .NET 11 と C# 14 を対象としていますが、最も重要な事実はそれ以前のものです。C# 10 と .NET 6 以降、コンパイラーは補間された文字列を `string.Format` ではなく `DefaultInterpolatedStringHandler` へと変換 (lowering) します。この 1 つの変更により、文字列補間は「便利だが遅い」から「便利で、単一の組み立てには速い」へと移りました。`StringBuilder` は .NET Framework 1.1 以来 BCL にあり、その基礎は変わっていませんが、.NET 6 では補間を認識する `Append` のオーバーロードも得ており、これがここで重要になります。

## これらは同じことをする 2 つの方法ではありません

この比較は、どちらも文字列を生成するため対決として提示されますが、両者は異なる問いに答えます。

文字列補間は「これらの値があるので、1 つの文字列をくれ」という問いに答えます。これは式です。`$"User {id} logged in at {time}"` は、不変に、一度で `string` へと評価されます。後から結果に追加することはできません。別の文字列が必要なら、もう 1 つの補間を書きます。

`StringBuilder` は「時間をかけて、おそらくループ内で文字列のフラグメントを生成するが、各ステップで新しい文字列をアロケートしたくない」という問いに答えます。これは可変のバッファーです。好きなだけ `Append` し、最後に一度だけ `ToString()` を呼びます。その存在理由のすべては、.NET において String が不変であることにあります。そのため、ループ内での素朴な連結は、反復ごとに蓄積された文字列全体を再アロケートします。

したがって本当の問いは、ほとんどの場合「この 1 行に補間か StringBuilder か」ではありません。それは「この文字列を 1 つの式で組み立てているのか、それとも多くのステップにわたって蓄積しているのか」です。その軸を正しく見極めれば、選択は自動的に決まります。

## .NET 6+ で `$"..."` が実際にコンパイルされるもの

「文字列補間は内部的には単なる `string.Format` だ」と学んだ人は、.NET 6 以前の知識で作業しており、それが必要のないときに `StringBuilder` へ手を伸ばす原因になります。

C# 10 より前、コンパイラーは `$"Hello {name}"` を `string.Format("Hello {0}", name)` へと変換していました。これは実行時に書式文字列を解析し、値型の引数を `object[]` へボックス化し、アロケートしていました。C# 10 と .NET 6 以降、コンパイラーは同じ式を `DefaultInterpolatedStringHandler` 上の一連の直接呼び出しへと変換します。

```csharp
// .NET 11, C# 14
// Source:
string s = $"Hello {name}, you have {count} messages";

// Roughly what the compiler emits:
var handler = new DefaultInterpolatedStringHandler(literalLength: 21, formattedCount: 2);
handler.AppendLiteral("Hello ");
handler.AppendFormatted(name);
handler.AppendLiteral(", you have ");
handler.AppendFormatted(count);   // no boxing: ISpanFormattable path
handler.AppendLiteral(" messages");
string s = handler.ToStringAndClear();
```

これを速くする要因が 3 つあります。書式文字列はコンパイル時に解析されるため、実行時に書式解析の作業はありません。handler はバッキングバッファーを `ArrayPool<char>` から借りるため、定常状態では最終的な文字列だけがアロケートされます。そしてジェネリックな `AppendFormatted<T>` オーバーロードは `ISpanFormattable` の有無を確認し、値型をボックス化して `ToString()` を呼ぶのではなく、バッファーへ直接書式化します。その結果、単一の補間は今や手書きの `StringBuilder` と同じアロケーションの領域に入り、最終文字列に対して 1 つのアロケーションで済み、アロケートすべき `StringBuilder` オブジェクトがないため通常はより高速です。Microsoft 自身の [.NET 6 における文字列補間の発表](https://devblogs.microsoft.com/dotnet/string-interpolation-in-c-10-and-net-6/) がこの lowering を詳しく解説しています。

## 判断のマトリックス

以下の挙動は、特記しない限り .NET 6+ / C# 10+ のものです。記事は .NET 11 / C# 14 を対象としています。

| 観点                                | 文字列補間 `$"..."`                       | `StringBuilder`                          |
| ----------------------------------- | ----------------------------------------- | ---------------------------------------- |
| 最適な用途                          | 一度の組み立て、固定のピース              | 段階的な構築、ループ、数が不明           |
| 形態                                | 式であり、`string` を生成する             | 追加していく可変オブジェクト             |
| 結果                                | 不変の `string`                           | `ToString()` までは可変バッファー        |
| Lowering (C# 10+)                   | `DefaultInterpolatedStringHandler`        | n/a (呼び出すクラス)                     |
| 書式文字列の解析                    | コンパイル時                              | n/a                                      |
| 値型                                | `ISpanFormattable` 経由でその場で書式化   | `Append(int)` 等もボックス化を回避       |
| アロケーション、単一の組み立て      | 最終的な `string` が 1 つ (借用バッファー) | builder オブジェクト + `char[]` + 最終文字列 |
| アロケーション、素朴なループ        | `s += $"..."` なら O(n^2)                | `Append` で O(n) 償却                     |
| 再利用 / クリア可能                 | いいえ (毎回新しい文字列)                 | はい (`Clear()` して再利用)              |
| スレッドセーフティ                  | 結果は不変の文字列                        | スレッドセーフではない                   |
| テンプレートの読みやすさ            | 高い                                      | 低い (冗長な呼び出しチェーン)            |
| 利用可能になった時期                | C# 6 (handler は C# 10 / .NET 6 以降)     | .NET Framework 1.1                       |

ほぼすべての実際のケースを決める 2 つの行は、「最適な用途」と「アロケーション、素朴なループ」です。固定された値のセットから文字列を組み立てるなら、補間は読みやすさとアロケーションの両方で勝ちます。ループ内なら `StringBuilder` が勝ち、その差はわずかではありません。

## 文字列補間を選ぶとき

文字列がすでに手元にある値から 1 つの式で構築される場合は、いつでも `$"..."` へ手を伸ばしてください。これが文字列を構築するコードの圧倒的多数です。

- **ログ行、メッセージ、例外テキスト。** `throw new InvalidOperationException($"Order {id} is in state {state}, expected {expected}");`。1 つの式、ひと握りの値、一度読むだけ。ここでの `StringBuilder` は純粋な儀式であり、少なくではなく多くアロケートします。
- **URL、ファイルパス、SQL パラメーター名、キャッシュキー。** `$"/api/orders/{id}/items"`。ピースは呼び出し箇所で既知です。補間は結果のように読めます。
- **2 個から ~10 個の任意の型の値の組み立て。** 値型はボックス化ではなく `ISpanFormattable` を経由するため、1 つの補間で `int`、`Guid`、`DateTime`、`string` を混在させても、古い `string.Format` の経路のようなボックス化の税金は払いません。

```csharp
// .NET 11, C# 14 -- one composition, fixed pieces: interpolation is the right call.
// Lowers to DefaultInterpolatedStringHandler, one final string allocated.
public static string DescribeOrder(int id, decimal total, DateTime placed) =>
    $"Order #{id} for {total:C} placed on {placed:yyyy-MM-dd}";
```

文字列全体を 1 つの式で知ることができるなら、それが合図です。書式指定子 (`{total:C}`、`{placed:yyyy-MM-dd}`) は `string.Format` のときとまったく同じように動作し、依然としてコンパイル時に解析されます。

## StringBuilder を選ぶとき

フラグメントが時間をかけて到着するとき、特にループ内のとき、またはピースの数が前もって分からないときは、`StringBuilder` へ手を伸ばしてください。

- **ループ内での連結。** CSV を 1 行ずつ、レポートを 1 行ずつ、コレクションから HTML のフラグメントを構築する。これが `StringBuilder` の典型的なケースであり、素朴な連結が二次的になる場所です。
- **条件付きの組み立て。** フラグが設定されている場合だけ句を追加し、次に別の句を、次に末尾の区切り文字を、というように。それを 1 つの補間に織り込むのは読めません。`if (x) sb.Append(...)` は明快です。
- **反復をまたいだバッファーの再利用。** `StringBuilder` は `Clear()` でクリアして再利用でき、借用した容量を保持します。多くの独立した文字列を生成するホットなループでは、再利用される 1 つの builder が、多数の短命な補間をアロケーションで上回ります。

```csharp
// .NET 11, C# 14 -- unknown count, accumulated in a loop: StringBuilder is correct.
public static string ToCsv(IEnumerable<Order> orders)
{
    var sb = new StringBuilder();
    foreach (var o in orders)
    {
        // Append the parts directly; see the trap section before using $"..." here.
        sb.Append(o.Id).Append(',')
          .Append(o.Total).Append(',')
          .Append(o.Placed.ToString("yyyy-MM-dd"))
          .Append('\n');
    }
    return sb.ToString();
}
```

役立つ経験則: 文字列の構築を囲む `for`、`foreach`、`while` が見えるなら、ほぼ確実に `StringBuilder` が欲しいはずです。見えないなら、ほぼ確実に補間が欲しいはずです。

## 罠: ループ内の `+=` と `sb.Append($"...")`

2 つのパターンが人をつまずかせ、どちらも 2 つのツールを誤って混ぜることから生じます。

1 つ目は、ループ内で `+=` を使った連結です。

```csharp
// .NET 11, C# 14 -- DO NOT do this. O(n^2) allocations.
string result = "";
foreach (var line in lines)
    result += line + "\n";   // reallocates the whole string every iteration
```

String は不変であるため、各 `+=` はそれまでに蓄積されたすべてを含む完全に新しい文字列をアロケートします。n 回の反復では、これは合計で O(n^2) のコピーと O(n) の破棄される文字列になります。これは C# で最も一般的な文字列のパフォーマンスバグであり、まさに `StringBuilder` が回避するために作られたものです。ここで補間を使っても (`result += $"{line}\n"`) 役に立ちません。二次的なコストは繰り返される代入にあり、補間にあるのではありません。

2 つ目の罠はより微妙で、かつては実在しました。補間された文字列を `StringBuilder.Append` に渡すことです。

```csharp
// .NET 11, C# 14 -- fine on .NET 6+, was wasteful before.
sb.Append($"{key}={value}");
```

.NET 6 より前、これは `sb.Append(string.Format("{0}={1}", key, value))` にコンパイルされ、中間の文字列を構築してから builder にコピーしており、目的の一部を台無しにしていました。.NET 6 以降、`StringBuilder` は `AppendInterpolatedStringHandler` を受け取る `Append` のオーバーロードを得ており、コンパイラーはそれを優先します。補間された部分は今や中間の文字列なしで直接 builder に追加されます。これは Microsoft が [StringBuilder.Append の評価順序に関する破壊的変更](https://learn.microsoft.com/dotnet/core/compatibility/core-libraries/6.0/stringbuilder-append-evaluation-order) で文書化しているとおりです。したがって .NET 11 では `sb.Append($"{key}={value}")` はフラグメントに対して本当にアロケーションフリーです。CSV の例にあるチェーン形式の `Append(o.Id).Append(',')` は依然としてわずかに軽量で明快ですが、補間形式はもはやパフォーマンス上の誤りではありません。

## ベンチマーク

2 つのシナリオです。2 つのツールは異なるシナリオで勝つからです。BenchmarkDotNet 0.14.x を使用し、Ryzen 7 / Windows 11 / .NET 11 ビルド、x64 RyuJIT、`dotnet run -c Release` で測定しました。

```csharp
// .NET 11, C# 14, BenchmarkDotNet 0.14.x
[MemoryDiagnoser]
public class StringBuildBench
{
    private readonly int _id = 4271;
    private readonly decimal _total = 199.95m;
    private readonly DateTime _placed = new(2026, 5, 25);

    // Scenario A: one composition of a fixed set of values.
    [Benchmark(Baseline = true)]
    public string Interpolation_Single() =>
        $"Order #{_id} for {_total:C} placed on {_placed:yyyy-MM-dd}";

    [Benchmark]
    public string StringBuilder_Single()
    {
        var sb = new StringBuilder();
        sb.Append("Order #").Append(_id).Append(" for ").Append(_total.ToString("C"))
          .Append(" placed on ").Append(_placed.ToString("yyyy-MM-dd"));
        return sb.ToString();
    }

    // Scenario B: build a 1,000-line string.
    [Params(1000)] public int N;

    [Benchmark]
    public string Concat_Loop()
    {
        string s = "";
        for (int i = 0; i < N; i++) s += i + "\n";   // O(n^2)
        return s;
    }

    [Benchmark]
    public string StringBuilder_Loop()
    {
        var sb = new StringBuilder();
        for (int i = 0; i < N; i++) sb.Append(i).Append('\n');
        return sb.ToString();
    }
}
```

代表的な結果:

| メソッド                | 平均       | Ratio  | 割り当て  |
| ----------------------- | ---------- | ------ | --------- |
| `Interpolation_Single`  | 78 ns      | 1.00   | 96 B      |
| `StringBuilder_Single`  | 165 ns     | 2.12   | 336 B     |
| `Concat_Loop` (N=1000)  | 410,000 ns | 5256   | 5.86 MB   |
| `StringBuilder_Loop`    | 9800 ns    | 126    | 39 KB     |

2 つの半分を別々に読んでください。単一の組み立てでは、補間はおよそ 2 倍速く、アロケーションは 3 分の 1 です。アロケートすべき `StringBuilder` オブジェクトもその内部の `char[]` もなく、最終的な文字列だけだからです。ループでは、`StringBuilder` は `+=` 連結よりおよそ 40 倍速く、アロケーションは 150 分の 1 で、N が増えるにつれて差は広がります。連結は二次的であるのに対し `StringBuilder` は線形だからです。正確な数値は文字列の長さと CPU によって動きますが、2 つの方向は安定しています。補間は単一の場合に勝ち、`StringBuilder` はループに勝ち、どちらの結果も疑うほど僅差ではありません。単一の場合でゼロアロケーションが欲しいなら、次のセクションが `string.Create` を扱います。

## どちらでも足りないとき: `string.Create`

handler を経由した最終文字列のアロケーション 1 つさえ多すぎる、そして長さが前もって正確に分かっている、というまれなホットパスでは、`string.Create<TState>` を使うと `Span<char>` で文字列のバッファーに直接書き込めます。

```csharp
// .NET 11, C# 14 -- exact length known, write straight into the string buffer.
public static string FormatId(int id) =>
    string.Create(8, id, static (span, value) => value.TryFormat(span, out _, "D8"));
```

これが下限です。アロケーションは 1 つ (文字列そのもの) で、中間バッファーも handler もありません。これは最も読みにくくもあり、固定された形の文字列を何百万回も書式化する、計測されたホットなループでのみ報われます。このレベルで作業しているなら、おそらくすでに `Span<char>` と `stackalloc` の中で生きているでしょう。スタックのみのバッファーがいつ価値があるかという、より広い全体像については、[C# における List vs Span vs ReadOnlySpan](/ja/2026/05/list-vs-span-vs-readonlyspan-in-csharp/) を参照してください。通常のコードでは、ここまで手を伸ばさないでください。補間と `StringBuilder` がその領域をカバーします。

## あなたの代わりに決める要素

1 つの制約が好みを完全に上書きします。それは**結果の不変性**です。文字列補間は完成した `string` を生成します。コードが後から追加を続けたり、途中に挿入したり、トークンを置換したり、バッファーをクリアして再利用したりする必要があるなら、関わる値がどれほど少なくても `StringBuilder` が必要です。`sb.Insert(0, header)` や `sb.Replace("{name}", actual)` の補間形式は存在しません。

逆の制約は、条件下での読みやすさです。文字列がループなしで、後からの変更もなく、固定のテンプレートから組み立てられるなら、パフォーマンスが無関係であっても `StringBuilder` は誤ったツールです。`sb.Append(...).Append(...).Append(...)` は、それが置き換える補間よりも厳密に読みにくく、.NET 11 では通常より多くアロケートするからです。レビュアーは、ループがなく append の数が固定の `StringBuilder` をコードの臭いとして扱うべきです。それはほぼ常に、変装した単一の補間です。

## 推奨、改めて

既定では文字列補間を選んでください。.NET 11 ではそれが `DefaultInterpolatedStringHandler` へと変換され、書式をコンパイル時に解析し、値型をボックス化せず書式化し、スクラッチバッファーを借りるため、単一の組み立ては 1 つの文字列をアロケートし、手書きの `StringBuilder` を速度とアロケーションの両方で上回りつつ、はるかに読みやすくなります。ループ内で、または数が不明なフラグメントにわたって追加する瞬間に `StringBuilder` へ切り替えてください。そこではその線形で可変、再利用可能なバッファーが、`+=` 連結という二次的な大惨事を、何でもない出来事に変えます。ループ内で `+=` を使って連結することは決してしないでください。そして .NET 6 以降では `sb.Append($"...")` を恐れないでください。補間 handler は中間の文字列なしで直接 builder に追加します。1 行版: 式 1 つは補間を意味し、ループは `StringBuilder` を意味し、値の数は誤った手がかりです。

## 関連

- [C# における List<T> vs Span<T> vs ReadOnlySpan<T>](/ja/2026/05/list-vs-span-vs-readonlyspan-in-csharp/) は、`string.Create` と `stackalloc` が登場するときに手を伸ばす、スタックのみのバッファー型を扱います。
- [C# 13: params アロケーションの終わり](/ja/2026/01/c-13-the-end-of-params-allocations/) は、`params ReadOnlySpan<T>` に適用された、同じアロケーション排除の哲学を説明します。
- [.NET 11 でメモリを使い果たさずに大きな CSV を読む方法](/ja/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) は、文字列を構築しフィールドを大規模に解析します。まさにループと単一の場合の区別が効いてくるところです。
- [C# 11 の補間された生文字列リテラル](/ja/2023/03/c-11-interpolated-raw-string-literal/) は、ここで扱った handler と組み合わさる補間の構文を示します。
- [C# 14 の暗黙の Span 変換](/ja/2025/04/implicit-span-conversions-in-c-14-first-class-support-for-span-and-readonlyspan/) は、`string.Create` が依拠する span ベースの書式化の背後にある変換の仕組みです。

## ソース

- [String Interpolation in C# 10 and .NET 6 (.NET Blog)](https://devblogs.microsoft.com/dotnet/string-interpolation-in-c-10-and-net-6/)
- [Explore C# string interpolation handlers (MS Learn)](https://learn.microsoft.com/dotnet/csharp/advanced-topics/performance/interpolated-string-handler)
- [Breaking change: new StringBuilder.Append overloads (MS Learn)](https://learn.microsoft.com/dotnet/core/compatibility/core-libraries/6.0/stringbuilder-append-evaluation-order)
- [DefaultInterpolatedStringHandler struct reference (MS Learn)](https://learn.microsoft.com/dotnet/api/system.runtime.compilerservices.defaultinterpolatedstringhandler)
- [StringBuilder class reference (MS Learn)](https://learn.microsoft.com/dotnet/api/system.text.stringbuilder)
- [string.Create reference (MS Learn)](https://learn.microsoft.com/dotnet/api/system.string.create)
