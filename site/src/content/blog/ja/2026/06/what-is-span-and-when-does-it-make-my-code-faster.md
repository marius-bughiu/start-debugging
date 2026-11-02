---
title: "C# の Span<T> とは何か、そしてどんなときに実際にコードを速くするのか?"
description: "Span<T> は連続したメモリの解析や書式設定で一時コピーと割り当てを避けられます。所有、寿命制約、測定すべき処理を説明します。"
pubDate: 2026-06-20
updatedDate: 2026-11-02
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

`Span<T>` は配列、スタック領域、適切に寿命を管理した非管理メモリなどへの固定長ビューです。`ReadOnlySpan<T>` はビューからの読み取りだけを許可します。文字列は `ReadOnlySpan<char>` を提供し、変更可能な `Span<char>` は提供しません。

ビューの作成自体は元の領域を確保したり所有したりしません。しかし、処理全体が割り当てなしになるとは限らず、高速化も保証しません。

**訂正 — 2026 年 11 月 2 日：** 未検証の計測値と普遍的な高速化の主張を削除しました。UTF-8 リテラルの型、戻り値の寿命制約、割り当ての説明を修正しました。サンプルは SDK 10.0.302 と C# 14 で確認しましたが、性能ベンチマークは行っていません。

## 一時的な部分文字列を避ける

Span 対応のパーサーなら中間文字列を避けられます。次は年・月・日の部分文字列を生成せず、指定形式で日付を解析します。

```csharp
using System;
using System.Globalization;

string input = "2026-06-01";
DateOnly date = ParseIsoDate(input.AsSpan());
Console.WriteLine(date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture));

static DateOnly ParseIsoDate(ReadOnlySpan<char> input) =>
    DateOnly.ParseExact(input, "yyyy-MM-dd", CultureInfo.InvariantCulture);
```

`ParseExact` は日付を検証し、不正入力には例外を投げます。不正入力を通常のケースとして扱うなら `TryParseExact` を使います。`int.Parse(input.Slice(...))` を並べるだけでは区切り文字や暦上の日付は検証できません。

## サイズを制限した一時バッファー

```csharp
using System;
using System.Globalization;

Span<char> scratch = stackalloc char[32];
if (12345.TryFormat(scratch, out int written, provider: CultureInfo.InvariantCulture))
{
    ReadOnlySpan<char> formatted = scratch[..written];
    Console.Out.WriteLine(formatted); // 12345
    string owned = new string(formatted); // Allocates the resulting string.
    Console.WriteLine(owned);
}

ReadOnlySpan<byte> method = "GET"u8;
Console.WriteLine(method.SequenceEqual(new byte[] { 71, 69, 84 })); // True
```

一時バッファーは中間の文字配列を避けますが、最後の `string` 生成では割り当てが発生します。比較用の byte 配列も割り当てます。値を明示する例であり、ベンチマークではありません。`"GET"u8` の型は `ReadOnlySpan<byte>` です。

`stackalloc` は小さく上限を設けて使います。大きな割り当てやループ内での反復はスタックを使い切る可能性があります。未検証の入力でサイズを決めず、大きなデータには配列や適切に管理するプールを使います。

## 共有領域と寿命制約

スライスは要素をコピーしません。配列の領域が有効なら Span を返せますが、ローカルのスタックバッファーを参照する Span はメソッド外に出せません。別の `ref struct` のフィールドにはできますが、通常のクラスや構造体には格納できません。C# 13 以降では `await` をまたがない ref-struct ローカルを async メソッドで使えます。境界をまたぐなら `Memory<T>` を使います。

`ReadOnlySpan<T>` は元のバッファーを凍結しません。`CollectionsMarshal.AsSpan(list)` の使用中は、余剰容量があってもリストに追加・削除しないでください。

## 改善できる具体的な処理を測る

部分文字列、コピーしたスライス、一時的な書式設定用配列など、実際に省ける処理を探します。通常の配列やリストのループがすでに十分最適化されている場合もあります。境界チェックの除去や処理速度はランタイムと処理内容に依存し、一定倍率の高速化は保証できません。

実際に使うランタイム、代表的な入力、Release モードで同等の処理を比較します。準備を計測外に置き、割り当て量も測り、ソースと結果を保存してください。本記事は新たな速度測定結果を示していません。

配列から Span への基本的な暗黙変換は C# 14 より前からあります。.NET 10 とともに登場した C# 14 は言語側の対応を拡張しました。C# 13 の `allows ref struct` は明示的に対応したジェネリック API だけに適用されます。

所有方法の選択は [List、Span、ReadOnlySpan の比較](/ja/2026/05/list-vs-span-vs-readonlyspan-in-csharp/)、非同期の保持には[配列から ReadOnlyMemory への変換](/ja/2026/05/how-to-convert-array-to-readonlymemory-in-csharp/)を参照してください。

## 出典

- [Memory and Span usage guidelines](https://learn.microsoft.com/en-us/dotnet/standard/memory-and-spans/memory-t-usage-guidelines)
- [Span<T>](https://learn.microsoft.com/en-us/dotnet/api/system.span-1?view=net-10.0)
- [CollectionsMarshal.AsSpan](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.collectionsmarshal.asspan?view=net-10.0)
- [C# 14 first-class span types](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-14.0/first-class-span-types.md)
- [C# 13 ref struct interfaces and generic arguments](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-13.0/ref-struct-interfaces.md)
