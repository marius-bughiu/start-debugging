---
title: "RyuJIT が .NET 11 Preview 3 でさらに bounds check を刈り込む: index-from-end と i + 定数"
description: ".NET 11 Preview 3 は RyuJIT に連続した index-from-end アクセスと i + 定数 < length パターンで冗長な bounds check を除去することを教え、タイトなループでの分岐圧力を削減します。"
pubDate: 2026-04-19
tags:
  - "dotnet"
  - "dotnet-11"
  - "jit"
  - "performance"
  - "csharp"
lang: "ja"
translationOf: "2026/04/jit-bounds-check-elimination-index-from-end-dotnet-11-preview-3"
translatedBy: "claude"
translationDate: 2026-04-24
---

Bounds check elimination は、多くの .NET コードの速度を静かに決める JIT 最適化です。マネージドコードのすべての `array[i]` と `span[i]` は暗黙の compare-and-branch を運び、RyuJIT がインデックスが範囲内であることを証明できれば、その分岐は消えます。.NET 11 Preview 3 はその証明を、以前はチェックを払っていた 2 つの一般的なパターンに拡張します。

両方の変更は [ランタイムのリリースノート](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/runtime.md) にドキュメント化され、2026 年 4 月 14 日の [.NET 11 Preview 3 アナウンス](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/) で取り上げられています。

## 連続した index-from-end アクセス

C# 8 で導入された index-from-end 演算子 `^1`、`^2` は `Length - 1`、`Length - 2` の syntactic sugar です。JIT はしばらくの間、最初のそのようなアクセスで bounds check を省くことができましたが、その直後の 2 回目のアクセスは独立に扱われ、冗長な compare-and-branch を強制することが多くありました。

.NET 11 Preview 3 では、range analysis が連続する index-from-end アクセス間で length の証明を再利用します:

```csharp
static int TailSum(int[] values)
{
    // .NET 10: two bounds checks, one per access.
    // .NET 11 Preview 3: the JIT proves both are in range from a single length test.
    return values[^1] + values[^2];
}
```

[Rider 2026.1 の ASM ビューアー](https://blog.jetbrains.com/dotnet/) で `TailSum` を逆アセンブルすると、2 つ目の `cmp`/`ja` ペアが単純に消えているのがわかります。バッファの末尾を歩くコード、ring-buffer アクセサー、最後のトークンを覗くパーサー、固定ウィンドウの比較器 - すべてがソース変更なしに恩恵を受けます。

## `i + 定数 < length` ループ

2 つ目の改善は数値とパースコードで頻出するパターンを狙います。stride-2 ループは紙上では問題ないように見えましたが、2 回目のアクセスでまだ bounds check を払っていました:

```csharp
static int SumPairs(ReadOnlySpan<int> buffer)
{
    int sum = 0;
    for (int i = 0; i + 1 < buffer.Length; i += 2)
    {
        // buffer[i] is trivially safe, but buffer[i + 1] used to
        // get its own bounds check, even though the loop condition
        // already proved it.
        sum += buffer[i] + buffer[i + 1];
    }
    return sum;
}
```

ループ条件 `i + 1 < buffer.Length` は `buffer[i + 1]` が範囲内であることをすでに証明していますが、RyuJIT は以前は 2 つのアクセスを独立に扱っていました。Preview 3 は解析にインデックス + 小さな定数を length に対して推論することを教え、`buffer[i]` と `buffer[i + 1]` の両方が普通の load にコンパイルされます。

同じ書き換えは `i + 2`、`i + 3` などにも適用され、定数オフセットがループ条件が保証する値と一致している限り有効です。ループ条件を `i + 3 < buffer.Length` に広げれば、stride-4 の内側ループが 4 アクセスすべてで bounds-check-free になります。

## なぜ小さな分岐が積み重なるか

単一の bounds check は現代の CPU で 1 ナノ秒以下のコストです。真の圧力は二次的です: 消費する分岐スロット、阻害するループアンローリングの判断、打ち負かすベクトル化の機会。RyuJIT が内側ループ全体が bounds-safe であることを証明すると、より積極的にアンロールしてブロックを自動ベクトル化器に渡す自由を得ます。そこが紙上の 1% のマイクロ勝ちが実際の数値カーネル上で 10 から 20% の改善に変わる場所です。

## 今日試す

どちらの最適化も feature flag を必要としません。.NET 11 Preview 3 SDK を走らせれば自動的に効きます。`DOTNET_JitDisasm=TailSum` を設定して生成されたコードをダンプし、.NET 10 で 1 回、Preview 3 で 1 回実行し、diff します。配列や span 上のホットループを保守しているなら、特にバッファの終端を覗いたり固定 stride で歩くものなら、これは Preview 3 で待っている無料のスピードアップです。
