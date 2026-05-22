---
title: "C# 16 は unsafe を呼び出し側への契約に作り変えます"
description: "C# 16 は unsafe キーワードを再設計し、暗黙的に unsafe コンテキストを開く代わりに呼び出し側への義務を伝播するようにします。内部の unsafe ブロックも必須になります。"
pubDate: 2026-05-22
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "memory-safety"
lang: "ja"
translationOf: "2026/05/csharp-16-unsafe-keyword-caller-contract"
translatedBy: "claude"
translationDate: 2026-05-22
---

Richard Lander 氏は、25 年を経て `unsafe` キーワードの意味を変える[再設計を提示しました](https://devblogs.microsoft.com/dotnet/improving-csharp-memory-safety/)。現在 `unsafe` は実装上の詳細を示すものです。メソッドやブロックを unsafe コンテキストに切り替え、ポインターのコードを書いても、そのメソッドを呼び出す側はメモリ安全でないコードに触れていることを一切知りません。**.NET 11** ではプレビュー、**.NET 12** では本番を対象とする新しいモデルは、`unsafe` を呼び出し側に向けた契約へと変えます。その動機の一部は AI が生成するコードの台頭です。慣習としてのみ存在する安全性の義務は、レビューする人にとっても、コードを書くモデルにとっても見えないからです。

## キーワードが今意味するもの

現在のルールでは、メソッドを `unsafe` としてマークすると、無関係な 2 つの仕事を同時に行います。内部でポインター操作を書けるようにすることと、呼び出し側には何も要求しないことです。再設計はこの 2 つを切り離します。

メンバーのシグネチャに付いた `unsafe` は、伝播する契約になります。呼び出し側は `pointer` の逆参照を包むのと同じように、呼び出しを `unsafe { }` ブロックで包む必要があります。そして `unsafe` メソッドの内部であっても、unsafe な操作そのものには依然として明示的な内部ブロックが必要です。もうフリーパスはありません。

```csharp
/// <safety>
/// The sum of <paramref name="ptr"/> and <paramref name="ofs"/> must address
/// a byte the caller is permitted to read.
/// </safety>
public static unsafe byte ReadByte(IntPtr ptr, int ofs)
{
    // SAFETY: relies on caller obligation.
    unsafe { return ((byte*)ptr)[ofs]; }
}
```

`/// <safety>` ドキュメントブロックは義務を書き留める正式な場所であり、アナライザーはそれが欠けている `unsafe` メンバーをフラグします。

## 義務を果たす

`unsafe` な API を呼び出すメソッドには 2 つの選択肢があります。自身を `unsafe` にして伝播を続けるか、前提条件を検証してから呼び出しを包むことで安全な境界になるかです。

```csharp
void Caller2()
{
    if (!ObligationSatisfied()) throw new InvalidOperationException();
    unsafe { ReadByte(ptr, ofs); } // the guard discharges the contract
}
```

それがまさに要点です。`unsafe` ブロックは「前提条件を確認した」と表明する場所なので、メソッド全体を包むのではなく、小さく意図的であるべきです。

## 表面積は小さく、デフォルトはより厳格に

ほかにもいくつかのルールがモデルを引き締めます。型に対する `unsafe` 修飾子はなくなり、unsafe の性質はメソッド、プロパティ、フィールドにのみ存在します。ポインター型はそれ自体でシグネチャを unsafe にしなくなりました。`byte*` を渡すのは問題なく、それを逆参照することが unsafe な行為です。そして `extern` 宣言には、P/Invoke が安全に呼び出せることを証明する新しい `safe` 修飾子が付きます。

```csharp
[LibraryImport("libc")]
internal static safe partial int getpid();
```

プロジェクトの構成も分割されます。既存の `<AllowUnsafeBlocks>` プロパティは `unsafe` キーワードがそもそもコンパイルされるかどうかを引き続き制御し、新しいオプトインのプロパティが何を unsafe とみなすかという C# 16 のモデルを選択します。両方を省略すると、最も厳格な姿勢になります。

これらのどれもが、ポインターのコードをそれ自体で安全にするわけではありません。Lander 氏が述べるように、キーワードは「安全性そのものではなく、開発者が安全性を明確にして守るよう導く足場」です。ポインターを多用するホットパスを持つライブラリを保守しているなら、プレビューは `<safety>` ブロックを書き始める時期です。.NET 12 では、あなたの API を包むことを強いられるのは呼び出し側になるからです。
