---
title: ".NET 11 の JIT がジェネリック仮想メソッドを非仮想化し、アロケーションも一緒に消える"
description: "Stephen Toub の Performance Improvements in .NET 11 では、ジェネリック仮想メソッド呼び出しが 6.7 ns / 24 バイトから 1.8 ns / アロケーションゼロまで下がっています。3 本の RyuJIT のプルリクエストが、.NET で最も不透明だったディスパッチのインライン化を可能にしました。"
pubDate: 2026-09-16
tags:
  - "dotnet"
  - "dotnet-11"
  - "jit"
  - "performance"
  - "csharp"
lang: "ja"
translationOf: "2026/09/dotnet-11-jit-devirtualizes-generic-virtual-methods"
translatedBy: "claude"
translationDate: 2026-09-16
---

Stephen Toub は 2026-09-15 に ["Performance Improvements in .NET 11"](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-11/) を公開しました。その脱抽象化のセクションには、何年も止まっていた変更が埋もれています。RyuJIT がジェネリック仮想メソッドを非仮想化できるようになったのです。

GVM は長らく .NET で最も遅いディスパッチ形式でした。理由は構造的なものです。通常の仮想メソッドには vtable のスロットがあるので、コンパイラーはどこを見ればよいか分かります。インターフェースに宣言された `int SizeOf<T>(T value)` には単一のスロットがありません。インスタンス化ごとに型引数で決まる別々のメソッド本体になるからです。その解決には実行時のルックアップが必要で、JIT から見ると結果は不透明な関数ポインターにすぎません。不透明であればインライン化はできず、インライン化されなければエスケープ解析が呼び出しの向こう側を見ることは決してありません。

## 記事に出てくるベンチマーク

```csharp
[Benchmark]
public int NonShared() => ((IProcessor)new Processor()).SizeOf(42);

[Benchmark]
public int Shared() => ((IProcessor)new Processor()).SizeOf("hello");

private interface IProcessor
{
    int SizeOf<T>(T value);
}

private sealed class Processor : IProcessor
{
    public int SizeOf<T>(T value) => Unsafe.SizeOf<T>();
}
```

`NonShared` は `int` でインスタンス化されるため、ランタイムは専用の本体をコンパイルします。`Shared` は `string` でインスタンス化され、参照型向けの共有本体を使うので、呼び出しを通じてジェネリックコンテキスト引数を渡す必要があります。どちらも従来は遅いままでした。

| メソッド | Runtime | 平均 | Ratio | 割り当て |
| --- | --- | --- | --- | --- |
| NonShared | .NET 10.0 | 6.678 ns | 1.00 | 24 B |
| NonShared | .NET 11.0 | 1.764 ns | 0.26 | 0 B |
| Shared | .NET 10.0 | 7.166 ns | 1.00 | 24 B |
| Shared | .NET 11.0 | 1.764 ns | 0.25 | 0 B |

## 3 本のプルリクエスト、順を追って

最初に入ったのは 2025 年 11 月の [dotnet/runtime#120866](https://github.com/dotnet/runtime/pull/120866) で、これが行き詰まりを解消しました。JIT はこれまで、引数を組み立てる前に `ldvirtftn` の呼び出しターゲットを一時変数へ退避していて、それだけでパイプラインの残りを通してディスパッチが不透明なままになっていました。この退避をやめたことで、許される場合にターゲットの評価を引数の評価より前に動かせるようになりました。

続いて [dotnet/runtime#122023](https://github.com/dotnet/runtime/pull/122023) が、非共有 GVM の非仮想化を JIT に教えました。呼び出しに必要なジェネリックコンテキストを持ち回ることで、間接ディスパッチが直接呼び出しになり、インライン化の対象になります。[dotnet/runtime#128702](https://github.com/dotnet/runtime/pull/128702) はこれを共有 GVM と、インスタンス化スタブを必要とするデフォルトインターフェース実装まで広げました。`Shared` の行が `NonShared` と同じ 1.764 ns に収まるのはそのためです。

## なぜ 24 バイトが消えるのか

アロケーションはそもそも呼び出しの目的ではありませんでした。`new Processor()` は、インターフェースへのキャストにレシーバーを与えるためだけに存在します。.NET 10 では不透明な呼び出しのせいで JIT はレシーバーがエスケープすると仮定するしかなく、`Processor` はヒープに置かれていました。1 回の呼び出しあたり 24 バイトです。

呼び出しがインライン化されると、エスケープ解析はそのオブジェクトがフレームの外に出ないことを証明できます。インスタンスはスタックに割り当てられ、誰も読まないため、そのまま完全に消えます。`Unsafe.SizeOf<T>()` も同じパスで定数に畳み込まれます。3.8 倍の高速化も本物ですが、GC 負荷の高いサービスで効いてくるのは割り当て列のゼロのほうです。

注意点が 1 つあります。これは呼び出し箇所で JIT がレシーバーの正確な型を知っている必要があり、ここではローカルに構築した `sealed` な型がそれに当たります。本当に多態的な呼び出し箇所では、引き続き [動的 PGO](/ja/2026/07/what-is-pgo-in-dotnet-and-do-i-need-to-opt-in/) のガード付き非仮想化に頼ることになり、得られるのは直接呼び出しではなく型チェックとインライン化された高速パスです。

ビジターのインターフェース、ジェネリックなシリアライザーのフック、あるいは型ではなくメソッドが型パラメーターを持つ抽象を書いているなら、これは自分のコードで測ってみる価値のある .NET 11 の変更です。[記事全文](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-11/) には逆アセンブル結果も載っています。
