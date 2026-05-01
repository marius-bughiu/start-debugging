---
title: ".NET 8 のパフォーマンス: UnsafeAccessor vs. リフレクション"
description: ".NET 8 で UnsafeAccessor とリフレクションをベンチマーク。従来のリフレクションと比べて、UnsafeAccessor がいかにオーバーヘッドゼロのパフォーマンスを実現しているかを見ていきます。"
pubDate: 2023-11-01
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "ja"
translationOf: "2023/11/net-8-performance-unsafeaccessor-vs-reflection"
translatedBy: "claude"
translationDate: 2026-05-01
---
以前の記事で、[`UnsafeAccessor` を使ってプライベートメンバーにアクセスする方法](/2023/10/unsafe-accessor/) を取り上げました。今回は、その性能をリフレクションと比較し、本当にオーバーヘッドゼロなのかを確認します。

ここでは 4 つのベンチマークを行います。

1.  **Reflection**: 型からプライベートメソッドを取得して呼び出す処理をベンチマークします。
2.  **キャッシュ付きの Reflection:** 上のものと似ていますが、毎回メソッドを取得する代わりに、キャッシュした `MethodInfo` への参照を使います。
3.  **Unsafe accessor:** 同じプライベートメソッドを、リフレクションではなく `UnsafeAccessor` で呼び出します。
4.  **直接アクセス**: パブリックメソッドを直接呼び出します。これは、`UnsafeAccessor` が本当にオーバーヘッドゼロのパフォーマンスを実現しているかを確認するための比較対象です。

ベンチマークを自分で実行したい場合は、以下のコードを使ってください。

```cs
[SimpleJob(RuntimeMoniker.Net80)]
public class Benchmarks
{
    [UnsafeAccessor(UnsafeAccessorKind.Method, Name = "PrivateMethod")]
    extern static int PrivateMethod(Foo @this, int value);

    static readonly Foo _instance = new();

    static readonly MethodInfo _privateMethod = typeof(Foo)
        .GetMethod("PrivateMethod", BindingFlags.Instance | BindingFlags.NonPublic);

    [Benchmark]
    public int Reflection() => (int)typeof(Foo)
        .GetMethod("PrivateMethod", BindingFlags.Instance | BindingFlags.NonPublic)
        .Invoke(_instance, [42]);

    [Benchmark]
    public int ReflectionWithCache() => (int)_privateMethod.Invoke(_instance, [42]);

    [Benchmark]
    public int UnsafeAccessor() => PrivateMethod(_instance, 42);

    [Benchmark]
    public int DirectAccess() => _instance.PublicMethod(42);
}
```

## ベンチマーク結果

```plaintext
| Method              | Mean       | Error     | StdDev    |
|-------------------- |-----------:|----------:|----------:|
| Reflection          | 35.9979 ns | 0.1670 ns | 0.1562 ns |
| ReflectionWithCache | 21.2821 ns | 0.2283 ns | 0.2135 ns |
| UnsafeAccessor      |  0.0035 ns | 0.0022 ns | 0.0018 ns |
| DirectAccess        |  0.0028 ns | 0.0024 ns | 0.0023 ns |
```

結果はかなりインパクトがあります。直接アクセスと unsafe accessor を比べると、文字どおり差はありません。両者の数ナノ秒の違いはノイズとして無視できますし、実際、ベンチマークを何度か走らせると、unsafe accessor のほうが速くなるケースもあります。これはまったく自然なことで、両者が等価、つまりオーバーヘッドゼロであることを基本的に示しています。

`UnsafeAccessor` をリフレクションと比較する意味はほとんどありません。パフォーマンス面ではオーバーヘッドがなく、おまけに本物のメソッドシグネチャが手に入るというシンタックスシュガーまで付いてきます。

とはいえ、リフレクションが死んだわけではありません。`UnsafeAccessor` がカバーするのは、アクセスしたい型とメンバーがコンパイル時にわかっているケースだけです。その情報が実行時にしか得られない場合は、依然としてリフレクションが選択肢になります。

ベンチマークのコードは [GitHub でも公開されています](https://github.com/Start-Debugging/dotnet-samples/blob/main/unsafe-accessor/UnsafeAccessor.Benchmarks/Benchmarks.cs)。
