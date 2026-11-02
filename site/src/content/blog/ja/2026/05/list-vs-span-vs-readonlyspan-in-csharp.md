---
title: "C# における List<T> vs Span<T> vs ReadOnlySpan<T>: どれを選ぶべきか"
description: "可変長コレクションの List<T>、書き込み可能なビューの Span<T>、読み取り専用ビューの ReadOnlySpan<T> を寿命と async 制約で選びます。"
pubDate: 2026-05-25
updatedDate: 2026-11-02
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

`List<T>` は拡張可能なコレクションを管理します。`Span<T>` は連続したメモリへの固定長ビューで、`ReadOnlySpan<T>` はそのビューを通じた書き込みを禁止します。ビューに置き換えても、バッファーの所有や寿命管理が不要になるわけではありません。

**訂正 — 2026 年 11 月 2 日：** 未検証の .NET 11 ベンチマーク数値を削除し、戻り値、フィールド、バージョンの説明を修正しました。サンプルは SDK 10.0.302 と C# 14 で確認しました。普遍的な高速化は主張しません。

## 所有と寿命で選ぶ

| 必要な操作 | 出発点 |
| --- | --- |
| コレクションに要素を追加する | `List<T>` |
| 連続した領域を同期的に読み書きする | `Span<T>` |
| ビューから書き込まずに読み取る | `ReadOnlySpan<T>` |
| クラスのフィールドや `await` をまたいでビューを保持する | `Memory<T>` / `ReadOnlyMemory<T>` |

Span はバッファーを所有しません。配列を参照し、保存先の寿命が有効なら Span を返せます。メソッド内の `stackalloc` を参照する Span は返せません。別の `ref struct` のフィールドにはできますが、通常のクラスや構造体には格納できず、ボックス化やラムダによるキャプチャもできません。

C# 13 以降では、`await` をまたいで生存しなければ async メソッド内で ref-struct ローカル変数を使えます。境界をまたぐ場合は Memory を使います。読み取り専用ビューでも元のバッファーは不変とは限らず、別の参照から変更される可能性があります。

## コピーせず変更する

```csharp
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

var values = new List<int> { 3, 9, 4 };
Span<int> view = CollectionsMarshal.AsSpan(values);
view[1] = 20;
Console.WriteLine(values[1]); // 20

int[] array = { 10, 20, 30 };
Span<int> tail = Tail(array);
tail[0] = 99;
Console.WriteLine(array[1]); // 99

static Span<int> Tail(int[] source) => source.AsSpan(1);
```

どちらのビューも元の領域を共有します。`Tail` は配列上の有効な Span を返し、ローカルのスタックバッファーは返していません。`CollectionsMarshal.AsSpan` のビューを使用中は、内部配列のサイズ変更が起きなくてもリストへの追加・削除は禁止です。測定で必要性が示されるまでは通常のリスト API を優先します。

## 読み取り専用入力

```csharp
using System;

ReadOnlySpan<char> text = "2026-05-25".AsSpan(0, 4);
ReadOnlySpan<byte> method = "GET"u8;
Console.WriteLine(int.Parse(text)); // 2026
Console.WriteLine(method.Length);   // 3
```

文字列は `ReadOnlySpan<char>`、UTF-8 リテラルは `ReadOnlySpan<byte>` を提供します。変更可能な Span は読み取り専用へ変換できますが、逆はできません。変更しないメソッドには読み取り専用の引数型を使います。

C# 14 は .NET 10 とともに登場しました。配列から Span への基本的な暗黙変換はそれ以前からあり、C# 14 は型推論や拡張メソッドのレシーバーなどで言語側の対応を広げました。C# 13 の `allows ref struct` は、明示的に対応したジェネリック API でのみ使えます。`List<Span<int>>` が許可されるわけではありません。

## 実際の処理を測る

Span のスライスはコピーや部分文字列の割り当てを避けられます。しかし、すべてのループがリストより速くなる保証はありません。JIT、ランタイム、データ量、処理内容に依存します。新たな文字列、配列、リストの生成では依然として割り当てが発生します。計測値には完全なコード、設定、実行結果が必要です。

非同期処理のバッファーには[配列から ReadOnlyMemory への変換](/ja/2026/05/how-to-convert-array-to-readonlymemory-in-csharp/)、解析や一時領域には[Span が性能を改善できる場面](/ja/2026/06/what-is-span-and-when-does-it-make-my-code-faster/)を参照してください。

## 出典

- [Memory and Span usage guidelines](https://learn.microsoft.com/en-us/dotnet/standard/memory-and-spans/memory-t-usage-guidelines)
- [Span<T>](https://learn.microsoft.com/en-us/dotnet/api/system.span-1?view=net-10.0)
- [CollectionsMarshal.AsSpan](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.collectionsmarshal.asspan?view=net-10.0)
- [C# 14 first-class span types](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-14.0/first-class-span-types.md)
- [C# 13 ref struct interfaces and generic arguments](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-13.0/ref-struct-interfaces.md)
