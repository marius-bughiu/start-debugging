---
title: "C# の ref-safe-context とは何か、ref ローカルに対してコンパイラーはどう決めるのか"
description: "ref ローカル、再代入、scoped、ヒープとスタックを参照する Span のコンパイル検証例で C# の参照エスケープ規則を理解します。"
pubDate: 2026-10-15
updatedDate: 2026-11-02
template: how-to
tags:
  - "csharp"
  - "csharp-14"
  - "dotnet-11"
  - "ref-locals"
  - "span"
  - "compiler-errors"
lang: "ja"
translationOf: "2026/10/what-is-ref-safe-context-in-csharp-and-how-does-the-compiler-decide-it-for-ref-locals"
translatedBy: "claude"
translationDate: 2026-10-15
---
参照は、参照先の記憶領域の寿命を超えて外へ出てはいけません。C# はこの関係をコンパイル時に確認します。メソッドのローカル変数から初期化した `ref` ローカルを、後から配列要素へ再代入しただけで返せるようにはなりません。

**2026年11月2日訂正:** 以前の .NET 11 RC1 で検証したという記述には保存された根拠がなく、削除しました。ここにある成功例と失敗例は SDK 10.0.302、`net10.0`、`LangVersion` 14 でコンパイルしています。以下のエラーコードはこの正確なコード形状に対応し、似た式でも診断が変わることがあります。

## ref-safe-context と safe-context

`ref-safe-context` は記憶領域への参照を扱います。関連する `safe-context` は、`Span<T>` のように自身が参照を含み得る値を扱います。span を保持するローカル変数と、その span が示す記憶領域は別物です。

言語仕様には、入れ子になった4つのコンテキストがあります。

| コンテキスト | 典型例 |
| --- | --- |
| declaration-block | 通常のローカル変数への参照 |
| function-member | 値パラメーターまたは scoped パラメーター |
| return-only | 戻り値にできる通常の `ref` パラメーター |
| caller-context | 配列要素または適切なクラスのフィールド |

これらは、すべての記憶領域がメソッドの終了まで存続するという意味ではありません。入れ子のブロックや `scoped` の制限は依然として重要です。パラメーターと呼び出しを含む完全な規則は[言語仕様](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/variables#972-ref-safe-contexts)にあります。

## scoped ではない ref ローカルを初期化式が制約する

次の失敗例は検証したビルドで CS8157 になります。

```csharp
class Example
{
    static ref int CannotReturn(int[] array)
    {
        int local = 1;
        ref int reference = ref local;
        reference = ref array[0];
        return ref reference; // CS8157
    }
}
```

後の再代入は許可されますが、ローカル由来の参照を返せる参照へ変えるわけではありません。通常のローカル変数を直接返すと、代わりに CS8168 になります。

```csharp
class Example
{
    static ref int CannotReturn()
    {
        int local = 1;
        return ref local; // CS8168
    }
}
```

## 再代入でより狭い参照先を受け取れない

配列要素への参照から始め、後からローカルへの参照を代入すると CS8374 になります。

```csharp
class Example
{
    static void CannotNarrow(int[] array)
    {
        ref int reference = ref array[0];
        int local = 1;
        reference = ref local; // CS8374
    }
}
```

`ref` パラメーターのエスケープ契約は、配列要素とは異なります。配列から初期化してからパラメーターを代入すると CS9079 になります。

```csharp
class Example
{
    static ref int CannotAssign(int[] array, ref int parameter)
    {
        ref int reference = ref array[0];
        reference = ref parameter; // CS9079
        return ref reference;
    }
}
```

同じ検証で、逆の順序はコンパイルに成功しました。

```csharp
class Example
{
    static ref int CanReturn(int[] array, ref int parameter)
    {
        ref int reference = ref parameter;
        reference = ref array[0];
        return ref reference;
    }
}
```

予定するすべての用途に合う契約の初期化式を選んでください。宣言の移動や `scoped` の追加は、すべてのエスケープエラーを解決する方法ではありません。

## scoped 参照はローカルに制限される

同じブロック内の次の変更はコンパイルできました。

```csharp
class Example
{
    static void LocalUse(int[] array)
    {
        scoped ref int reference = ref array[0];
        int local = 1;
        reference = ref local;
        reference = 5;
    }
}
```

この scoped 参照を返すことは拒否されます。別の検証では、`local` をより内側の入れ子ブロックで宣言すると、再代入も CS8374 で拒否されました。`scoped` はブロックの寿命制限を消さず、参照を返せるようにもしません。

scoped パラメーターは、引数がメソッドの結果を通じてエスケープしないことも表せます。これはシグネチャの契約であり、コンパイラーが任意のヘルパーの実装を調べる必要はありません。詳細と `[UnscopedRef]` のケースは [C# 11 の設計提案](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-11.0/low-level-struct-improvements.md)を参照してください。

## span の参照先は必ずしもスタックではない

次の両方にローカル span がありますが、エスケープできるのは最初の結果だけです。

```csharp
using System;

class Example
{
    static ref int HeapBacked()
    {
        Span<int> values = new int[2];
        return ref values[0]; // Compiles in the verified probe
    }

    static ref int StackBacked()
    {
        Span<int> values = stackalloc int[2];
        return ref values[0]; // CS8352 in this exact probe
    }
}
```

配列を参照する span はマネージドヒープ上の領域を示します。そこへの参照を返すことと、ローカル span 変数自体への参照を返すことは異なります。マネージド参照は参照先オブジェクトを到達可能に保ちますが、ヒープオブジェクトが永遠に生存するという意味ではありません。

実用的な ref 戻り値のアルゴリズムでは、呼び出し側から span を受け取り、空の入力を処理します。

```csharp
using System;

static ref int MaxRef(Span<int> values)
{
    if (values.IsEmpty)
        throw new ArgumentException("At least one element is required", nameof(values));

    ref int best = ref values[0];
    for (int i = 1; i < values.Length; i++)
        if (values[i] > best) best = ref values[i];
    return ref best;
}

int[] data = { 3, 9, 4 };
MaxRef(data) = 0;
Console.WriteLine(string.Join(",", data)); // 3,0,4
```

## 文脈に応じて診断を読む

検証例では、ローカルの直接返却 (CS8168)、返却できない ref ローカル (CS8157)、より狭い参照の代入 (CS8374)、return-only パラメーターからより広い参照への代入 (CS9079) を区別しています。上の直接のスタック span 式は CS8352 になりました。別の別名やヘルパー呼び出しを挟むと、寿命の問題は同じでも診断が変わる場合があります。

async・イテレーターの制限は別の問題です。言語が禁じる中断点をまたいで参照を保持することはできません。すべてのコンパイルエラーを初期化式の規則だけで説明しないでください。

関連記事: [Span<T> と記憶領域](/ja/2026/06/what-is-span-and-when-does-it-make-my-code-faster/)、[List・Span・ReadOnlySpan](/ja/2026/05/list-vs-span-vs-readonlyspan-in-csharp/)、[参照変数の宣言](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/statements/declarations#reference-variables)。
