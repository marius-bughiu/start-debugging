---
title: "C# の ref T ループと Span<T> インデックスの比較: .NET 10 で Span 版が同等以上に速い理由"
description: ".NET 10 では、span.Length を上限にした単純な for ループ span[i] は、境界チェックなし、ストレングスリダクション済み、カウントダウン形式のループにコンパイルされます。int インデックスで手書きした Unsafe.Add(ref r, i) ループは符号拡張と加算方向の比較が残り、計測では 2 から 5% 遅くなりました。.NET 10.0.10 の arm64 と x64 のベンチマークと JIT 逆アセンブルを紹介します。"
pubDate: 2026-10-30
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "performance"
  - "span"
  - "jit"
lang: "ja"
translationOf: "2026/10/ref-t-loop-vs-span-t-indexing-in-csharp"
translatedBy: "claude"
translationDate: 2026-10-30
---

.NET 10 では、ループを `for (int i = 0; i < span.Length; i++) sum += span[i];` と書いて、そこで終わりにしてください。JIT はすべてのインデックスが範囲内であることを証明して境界チェックを取り除き、インデックスを 1 回ごとに 4 ずつ増えるバイトオフセットに書き換え(ストレングスリダクション)、ループを単一の `dec`/`jne`(Arm64 では `sub`/`cbnz`)で終わるカウントダウン形式に変換します。"より速い"はずの手書き版である `int` インデックスの `sum += Unsafe.Add(ref r, i)` には、この最適化が適用されません。`int` カウンターが残り、反復ごとにネイティブサイズのオフセットへ符号拡張され、ループ末尾で長さとの比較が行われます。.NET 10.0.10 での計測では、`Unsafe.Add` ループは安全な span ループより **4,096 要素で 2.4%、1,000,000 要素で 3.6% 遅い** 結果になりました。`ref` ループのカウンターを `nint` にすると差は完全に消え、ポインターを進める `ref` ウォークは span ループと同等になります。つまり、.NET 10 では `ref T` のコードは span ループに並ぶことしかできません。勝つことはなく、並ぶためにメモリ安全性まで手放すことになります。

以下はすべて、macOS 27.0.1 の Apple M4 上で BenchmarkDotNet 0.15.8、.NET 10.0.10(SDK 10.0.302)、C# 14 を使って計測したものです。Arm64 のリストは、その実行で得られた実際の Tier1 コードを `DOTNET_JitDisasm` で取得したものです。x64 のリストは `win-x64` を対象にした crossgen2 10.0.10 の出力で、同じ RyuJIT がフル最適化で動作しますが、Dynamic PGO は使われていません。この結果を説明するループ最適化は [.NET 9](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-9/runtime#loop-optimizations) で導入されたため、ここでの内容は .NET 9 にも当てはまります。

## 比較の一覧

| ループの形 | ループ内の境界チェック | 反復ごとのインデックス計算 | 4,096 ints | 1,000,000 ints |
| --- | --- | --- | ---: | ---: |
| `array[i]` に対する `for` | 除去済み | ストレングスリダクション済みオフセット、カウントダウン | 1,035.6 ns | 251.9 us |
| `span[i]` に対する `for`、上限は `span.Length` | 除去済み | ストレングスリダクション済みオフセット、カウントダウン | 1,035.9 ns | 254.4 us |
| `foreach (ref readonly int x in span)` | 除去済み | 上と同じ | 1,035.6 ns | 254.5 us |
| `span[i]` に対する `for`、上限はパラメーター `n` | ループクローニングでループ外へ移動 | 高速側クローンでは上と同じ | 1,035.4 ns | 254.5 us |
| `Unsafe.Add(ref r, i)`、`int i` | なし(最初から存在しない) | 符号拡張 + 加算方向の比較 | 1,060.1 ns | 263.7 us |
| `Unsafe.Add(ref r, i)`、`nint i` | なし | ストレングスリダクション済み、カウントダウン | 1,036.1 ns | 254.7 us |
| `Unsafe.IsAddressLessThan` を使う `ref` ウォーク | なし | ポストインクリメントのポインター | 1,035.3 ns | 251.4 us |
| `Enumerable.Sum(int[])` | 該当なし | ベクトル化 | 506.9 ns | 128.6 us |

各ループは `int[]` を合計します。誤差範囲は、4,096 要素ではすべて 1.5 ns 未満、100 万要素では 0.8 us 未満です。span と `ref` の行は別の BenchmarkDotNet セッションで再実行し、すべての平均値は 1 回目から 0.6 ns(4,096)および 0.1 us(100 万)以内に収まりました。最後の行は結果の規模感をつかむためのものです。最速のスカラーループでも、ベクトル化版の半分の速度です。

## よく比較される 2 つのループ

この疑問はたいてい、BCL のソースを読んで `ref T` と `Unsafe.Add` があちこちに使われているのを見た人が、ホットなループを同じ形に書き換えたときに出てきます。2 つの形を並べてみます。

```csharp
// .NET 10.0.10, C# 14
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

static int SpanFor(ReadOnlySpan<int> s)
{
    int sum = 0;
    for (int i = 0; i < s.Length; i++) sum += s[i];
    return sum;
}

static int RefAdd(ReadOnlySpan<int> s)
{
    int sum = 0;
    ref int r = ref MemoryMarshal.GetReference(s);
    for (int i = 0; i < s.Length; i++) sum += Unsafe.Add(ref r, i);
    return sum;
}
```

`RefAdd` の発想は、`s[i]` には境界チェックがあり `Unsafe.Add` にはないので、`ref` 版のほうが速いはずだ、というものです。.NET Core 2.1 ではこの直感はたいてい正しいものでした。しかしその後、JIT はまさにこの形のループから境界チェックを取り除けるようになり、.NET 9 ではさらに 3 つの最適化が加わりました。これらはインデックス変数を JIT が完全に理解できる場合にのみ適用されます。span ループはそのすべての恩恵を受けます。`Unsafe.Add` ループはそのパターンから外れます。

## span ループに対する JIT の処理

.NET 10.0.10 で `DOTNET_JitDisasm` から取得した、`SpanFor` の Tier1 Arm64 コードです。

```asm
; Kernels:SpanFor(System.ReadOnlySpan`1[int]):int (Tier1), .NET 10.0.10 Arm64
            mov     w2, wzr            ; sum = 0
            cmp     w1, #0             ; length <= 0 ?
            ble     G_M000_IG05
            mov     x3, xzr            ; byte offset = 0
G_M000_IG04:
            ldr     w4, [x0, x3]       ; load s[i]
            add     w2, w4, w2         ; sum += ...
            add     x3, x3, #4         ; offset += 4
            sub     w1, w1, #1         ; remaining--
            cbnz    w1, G_M000_IG04    ; loop while remaining != 0
```

このループには 3 つの独立した最適化が見て取れます。

1. **境界チェックの除去。** 長さとの比較も `CORINFO_HELP_RNGCHKFAIL` の呼び出しもありません。`i` は 0 から始まり、増加しかせず、`i < s.Length` で守られているため、JIT の範囲解析は `s[i]` が常に有効だと証明できます。これは誰もが知っている部分で、span では .NET Core 2.1 から機能しています。
2. **ストレングスリダクション。** ソースでは `i` に 4 を掛けてアドレスを求めます。ループでは代わりに `x3` にバイトオフセットを保持し、そこに 4 を加えます。.NET 9 のランタイムのノートでは、JIT がインデックスアクセスを自動的にこの形へ変換すると説明されています。
3. **ループカウンターの方向。** 元の `i` は消えています。アドレスが `i` に依存しなくなると、カウンターは反復回数を制御するだけになるため、JIT は長さを 0 までカウントダウンし、比較と分岐を別々に置く代わりに `cbnz` でループを終了します。

x64 では、同じメソッドがループ本体 4 命令にコンパイルされます。

```asm
; Kernels:SpanFor, crossgen2 10.0.10, win-x64, full opts
G_M000_IG04:
       add      edx, dword ptr [rax+r8]
       add      r8, 4
       dec      ecx
       jne      SHORT G_M000_IG04
```

スカラーの合計ループとしてはこれ以上ないほど無駄がありません。`ref` への書き換えで取り除ける命令は残っていません。

## Unsafe.Add ループに対する JIT の処理

次は `RefAdd` です。同じマシン、同じ実行で取得しました。

```asm
; Kernels:RefAdd(System.ReadOnlySpan`1[int]):int (Tier1), .NET 10.0.10 Arm64
G_M000_IG03:
            ldr     w4, [x0, w3, SXTW #2]   ; load r[(nint)i * 4]
            add     w2, w4, w2
            add     w3, w3, #1              ; i++
            cmp     w3, w1                  ; i < length ?
            blt     G_M000_IG03
```

```asm
; Kernels:RefAdd, crossgen2 10.0.10, win-x64, full opts
G_M000_IG05:
       movsxd   r8, ecx                     ; sign-extend i to 64 bits
       add      esi, dword ptr [rax+4*r8]
       inc      ecx
       cmp      ecx, edx
       jl       SHORT G_M000_IG05
```

このループに境界チェックはありませんが、span ループにもなかったので、何の利点にもなりません。失われたのはストレングスリダクションとカウントダウンです。`Unsafe.Add<T>(ref T source, int elementOffset)` は、スケーリングの前に `int` のオフセットをネイティブ整数へ変換します。この符号拡張が誘導変数とアドレスの間に挟まり、JIT はそれを越えて書き換えを行いません。その結果、ループは `i` を 32 ビットのカウンターとして保持し、反復ごとにそこからアドレスを再計算し(Arm64 では `SXTW #2`、x64 では明示的な `movsxd`)、ループ末尾で長さとの実際の比較が必要になります。

Arm64 では符号拡張がロードのアドレッシングモードに組み込まれるため、命令数は span ループと同じです。それでも、2 回の実行を通じて一貫して遅い結果でした。目に見える違いはループの出口で、カウントダウンの融合された `cbnz` の代わりに、インクリメント後のカウンターと長さとの明示的な `cmp` があります。命令レベルより下のプロファイルは取っていないため、これは証明された原因ではなく、有力な原因として扱ってください。x64 では要素ごとに命令が 1 つ増えるだけです。どちらの差も大きくありません。そこが要点です。手書き版は安全性を犠牲にしたうえで、数パーセント負けるのです。

## どうしても ref ループが必要な場合の直し方

span ループに並ぶ `ref` ループの書き方は 2 つあります。1 つ目は、インデックスをネイティブサイズにして、符号拡張するものをなくすことです。

```csharp
// .NET 10.0.10, C# 14
static int RefAddNint(ReadOnlySpan<int> s)
{
    int sum = 0;
    ref int r = ref MemoryMarshal.GetReference(s);
    for (nint i = 0; i < s.Length; i++) sum += Unsafe.Add(ref r, i);
    return sum;
}
```

これの Arm64 Tier1 コードは `SpanFor` と命令単位で同一(`ldr w4, [x0, x3]`、`add x3, x3, #4`、`sub x1, x1, #1`、`cbnz`)で、ベンチマークでは span ループの 1,035.7 ns に対して 1,036.1 ns でした。x64 の crossgen2 出力も同じ 4 命令の本体になります。

2 つ目は、古い高性能コードでよく使われた、ポインターを進めるウォークです。

```csharp
// .NET 10.0.10, C# 14
static int RefWalk(ReadOnlySpan<int> s)
{
    int sum = 0;
    ref int p = ref MemoryMarshal.GetReference(s);
    ref int end = ref Unsafe.Add(ref p, s.Length);
    while (Unsafe.IsAddressLessThan(ref p, ref end))
    {
        sum += p;
        p = ref Unsafe.Add(ref p, 1);
    }
    return sum;
}
```

Arm64 ではこれはポストインデックスのアドレッシング(`ldr w3, [x0], #0x04`、ロードと前進を 1 命令で実行)を使うため、ループ本体は 5 命令ではなく 4 命令になります。100 万要素では約 1% の差で最速の行でしたが、これは別のマシン同士で見られるノイズの範囲内です。.NET 10 での手書き `ref` コードの最良のケースがこれで、1% の同等性と引き換えに、off-by-one があると例外なしに span の外側のメモリを読み書きするコードを受け入れることになります。また、`end` はバッファーの末尾を 1 要素越えた位置を指すマネージド参照である点にも注意してください。[unsafe コードのベストプラクティス](https://learn.microsoft.com/en-us/dotnet/standard/unsafe-code/best-practices)では、逆参照しない場合でも無効なマネージドポインターを作らないよう述べられており、正確な有効性の規則は ECMA-335 に委ねられています。1% のために踏み込みたい領域ではありません。

"ref ループ" だと聞いて `foreach (ref readonly int x in span)` を書いた場合、インデックス付きの span ループと同じコードにコンパイルされます。C# コンパイラーは span の `foreach` を span に対するインデックス付き `for` に展開するため、JIT からは同じ形に見えます。

## span ループの優位性が失われる場合

span ループが速いのは、JIT がその性質を証明できるからです。証明を崩すと、ループの形が変わります。最もよくあるのは、`span.Length` 以外のものでループの上限を決める場合です。

```csharp
// .NET 10.0.10, C# 14
static int SpanForN(ReadOnlySpan<int> s, int n)
{
    int sum = 0;
    for (int i = 0; i < n; i++) sum += s[i];   // n is not s.Length
    return sum;
}
```

この場合、`s[i]` は実際に範囲外になりえます。Tier1 JIT はこれを **ループクローニング** で処理します。ループの前に `n <= s.Length` のチェックを出力し、それが成り立つ場合のための境界チェックなしの高速側クローンと、反復ごとにチェックして最初の不正なインデックスで `IndexOutOfRangeException` をスローする低速側クローンを作ります。私の Arm64 のリストでは、高速側クローンは `SpanFor` と同一で、そのためベンチマークの行も並んでいます。同じメソッドの crossgen2 x64 出力ではクローンされず、ループ内に `cmp`/`jae` が残りました。したがって、このようなメソッドが段階的コンパイルで置き換えられる前に ReadyToRun コードから実行されると、チェックのコストを払うことになります。対策は、JIT に証明を自分で与えることです。ループの前に `s = s[..n];` を書き、`s.Length` までループします。スライスで最初に境界チェックが 1 回行われ、以降のすべての反復は無料になります。

2 つの span が絡む場合にも、同じ手法が効きます。

```csharp
// .NET 10.0.10, C# 14
static void CopyX2(ReadOnlySpan<int> src, Span<int> dst)
{
    dst = dst[..src.Length];                    // one check here...
    for (int i = 0; i < src.Length; i++)
        dst[i] = src[i] * 2;                    // ...none in the loop
}
```

スライスがなければ、`dst[i]` は `i < src.Length` のガードでカバーされません。Tier1 はこのループもクローンしました(入口の前の `cmp w1, w3` / `bgt` が、チェックあり・なしのコピーを選択します)。そのため 3 つのバリエーション(スライスなし、スライスあり、手動の長さチェック付き `Unsafe.Add` 版)は、4,096 要素ではいずれも互いに 1% 以内でした。64 要素では、先頭に `ArgumentException` のチェックを置いた `Unsafe.Add` 版が 3 つの中で最も遅く、スライスした span ループの 16.8 ns に対して 20.1 ns でした。それでも書くべきはスライス版です。クローニングのヒューリスティックに依存せず、メソッドが何を要求しているかを明示できるからです。

チェックを自分の目で確かめたい場合は、以前の記事 [.NET 11 における index-from-end アクセスの境界チェック除去](/ja/2026/04/jit-bounds-check-elimination-index-from-end-dotnet-11-preview-3/)で、リスト内の `CORINFO_HELP_RNGCHKFAIL` の読み方を取り上げています。[Rider の ASM ビューアー](/ja/2026/04/rider-2026-1-asm-viewer-jit-nativeaot-disassembly/)を使えば、環境変数なしで同じコードを確認できます。

## 自分のコードで確認する方法

Microsoft 自身の[unsafe コードのベストプラクティス](https://learn.microsoft.com/en-us/dotnet/standard/unsafe-code/best-practices)は率直で、unsafe による境界チェック除去の利点は "often transient"(しばしば一時的)であり、現在の JIT でまだ必要かどうかを確認し、不要なら安全なコードに書き直すよう述べています。確認には 2 つのコマンドで足ります。

```bash
# .NET 10 SDK, any OS
DOTNET_JitDisasm="SpanFor RefAdd" DOTNET_JitStdOutFile=jit.txt dotnet run -c Release
dotnet run -c Release -- --filter '*SpanFor*' '*RefAdd*'   # BenchmarkDotNet
```

確認の際に誤解しやすい点は次のとおりです。

- **Tier0 コード。** メソッドに対して最初に出力されるリストは最適化されていない Tier0 コードで、`s[i]` は実際の呼び出しと実際のチェックを伴います。`Tier1` と表示されているリストを探してください。[段階的コンパイルの仕組み](/ja/2026/07/what-is-tiered-compilation-and-how-do-i-reason-about-it/)の記事では、各 Tier がいつ実行されるか、また OSR が長時間実行されるループに何をするかを説明しています。
- **ReadyToRun と crossgen2 のリスト。** 事前コンパイルされたコードには PGO がなく、Tier1 ならインライン化する呼び出しが残ることがあります。私の x64 リストでは `MemoryMarshal.GetReference` がアウトオブラインで呼ばれていますが、これはおそらく crossgen2 がバージョンバブルを越えて `System.Private.CoreLib` へインライン化しないためです。ループ本体は代表的ですが、プロローグはそうではありません。
- **ループを隠すマイクロベンチマーク。** カーネルに `[MethodImpl(MethodImplOptions.NoInlining)]` を付けて JIT が独立したメソッドとしてコンパイルするようにし、ベンチマークのラッパーではなく、そのメソッドのリストを読んでください。
- **誤ったベースライン。** 本当の目的がスループットなら、ベクトル化版と比較してください。`int[]` に対する `Enumerable.Sum` は、ここにあるどのスカラーループよりも 2 倍の速度で動作しました。独自の演算には `Vector<T>` や `TensorPrimitives` で同じ水準に到達できます。

## どちらを選ぶか

デフォルトは、`.Length` を上限にした span(または配列)のインデックスループです。安全で、JIT のループオプティマイザーが調整対象にしている形であり、.NET 10 ではこれらの計測のどれを見ても `ref` の代替より遅くなることはありません。上限が別のものである場合は、先にスライスして上限が `.Length` になるようにしてください。

`ref T` と `Unsafe.Add` に手を伸ばすのは、JIT が除去できない境界チェックがリストで確認でき、そのチェックが重要だとベンチマークで示せる場合だけにしてください。その場合は `int` インデックスではなく `nint` インデックスかポインターウォークを使わないと、span ループが無償で得ていたストレングスリダクションを失います。API 全体で `ref` とスライスの選択を考えているなら、[`List<T>` vs `Span<T>` vs `ReadOnlySpan<T>`](/ja/2026/05/list-vs-span-vs-readonlyspan-in-csharp/)ではそもそもどの型を受け取るべきかを、[`Span<T>` とは何か、いつコードが速くなるのか](/ja/2026/06/what-is-span-and-when-does-it-make-my-code-faster/)では span が実際に効く残りの 2 か所を、[ヒープ割り当てなしで 2 つのコレクションを同時に反復する方法](/ja/2026/10/how-to-iterate-over-two-collections-in-lockstep-without-heap-allocations-in-csharp/)では、境界を証明するためのスライスのパターンを 2 入力のループに適用する方法を扱っています。

## 参考資料

- [What's new in the .NET 9 runtime: loop optimizations](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-9/runtime#loop-optimizations) (induction variable widening, post-indexed addressing, strength reduction, loop counter direction)
- [What's new in the .NET 10 runtime](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-10/runtime) (improved loop inversion, which loop cloning and induction variable optimizations depend on)
- [Unsafe code best practices](https://learn.microsoft.com/en-us/dotnet/standard/unsafe-code/best-practices) (section 9, unsafe bounds check removal; section 4, invalid managed pointers)
- [`Unsafe` class API reference](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.unsafe)
- [BenchmarkDotNet](https://benchmarkdotnet.org/)
