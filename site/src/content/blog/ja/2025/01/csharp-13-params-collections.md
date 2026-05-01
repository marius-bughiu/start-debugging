---
title: "C# 13: 認識される任意のコレクション型で params コレクションを使う"
description: "C# 13 では params 修飾子が配列を超えて Span、ReadOnlySpan、IEnumerable、その他のコレクション型をサポートするように拡張され、ボイラープレートが減って柔軟性が向上します。"
pubDate: 2025-01-02
updatedDate: 2025-01-07
tags:
  - "csharp-13"
  - "csharp"
  - "dotnet"
  - "dotnet-9"
lang: "ja"
translationOf: "2025/01/csharp-13-params-collections"
translatedBy: "claude"
translationDate: 2026-05-01
---
C# の `params` 修飾子は伝統的に配列型に関連付けられており、メソッドが可変数の引数を受け入れることを可能にしてきました。しかし、[C# 13 から](/ja/2025/01/how-to-switch-to-c-13/)、さまざまなコレクション型で params コレクションを使えるようになり、適用範囲が広がってコードがさらに汎用的になります。

## サポートされるコレクション型

`params` 修飾子は、次のような認識されるいくつかのコレクション型で動作するようになりました:

-   `System.Span<T>`
-   `System.ReadOnlySpan<T>`
-   `System.Collections.Generic.IEnumerable<T>` を実装し、かつ `Add` メソッドを持つ型

さらに、次のシステムインターフェースで `params` を使うこともできます:

-   `System.Collections.Generic.IEnumerable<T>`
-   `System.Collections.Generic.IReadOnlyCollection<T>`
-   `System.Collections.Generic.IReadOnlyList<T>`
-   `System.Collections.Generic.ICollection<T>`
-   `System.Collections.Generic.IList<T>`

## 実用例: `params` で Span を使う

この拡張で得られるエキサイティングな可能性の一つは、span を `params` パラメーターとして使えることです。次の例を見てください:

```cs
public void Concat<T>(params ReadOnlySpan<T> items)
{
    for (int i = 0; i < items.Length; i++)
    {
        Console.Write(items[i]);
        Console.Write(" ");
    }

    Console.WriteLine();
}
```

このメソッドでは、`params` によって `Concat` メソッドに可変数の span を渡せます。メソッドは各 span を順番に処理し、`params` 修飾子の拡張された柔軟性を示します。

## C# 12.0 との比較

以前のバージョンの C# では `params` キーワードは配列のみをサポートしていたため、開発者は他のコレクション型を `params` を使ったメソッドに渡す前に手動で配列に変換する必要がありました。この処理では、一時的な配列を作成したり明示的に変換メソッドを呼び出したりするなど、不要なボイラープレートコードが追加されていました。

**新機能なし (C# 13 以前) の例**

```cs
void PrintValues(params int[] values)
{
    foreach (var value in values)
    {
        Console.WriteLine(value);
    }
}

var list = new List<int> { 1, 2, 3 };

// Manual conversion to array
PrintValues(list.ToArray());
```

**新機能あり (C# 13) の例**

```cs
void PrintValues(params IEnumerable<int> values)
{
    foreach (var value in values)
    {
        Console.WriteLine(value);
    }
}

var list = new List<int> { 1, 2, 3 };

// No conversion needed
PrintValues(list);
```

新機能は次の方法でボイラープレートを削減します:

1.  **手動変換の排除** – `List<T>` や `IEnumerable<T>` のようなコレクションを明示的に配列に変換する必要がありません。
2.  **コードをより**シンプルに – メソッド呼び出しがすっきりして読みやすくなり、互換性のあるコレクション型を直接受け入れます。
3.  **保守性の向上** – 変換処理ではなくロジックのみに集中することで、繰り返しが多くエラーが発生しやすいコードを減らします。

## コンパイラの挙動とオーバーロード解決

params コレクションの導入により、特にオーバーロード解決に関してコンパイラの挙動が調整されます。メソッドが配列以外のコレクション型の `params` パラメーターを含む場合、コンパイラはそのメソッドの通常形式と拡張形式の両方の適用可能性を評価します。

## エラー処理とベストプラクティス

`params` を使うときは、よくあるエラーを防ぐためにベストプラクティスを守ることが重要です:

-   **パラメーターの位置** – `params` パラメーターが正式なパラメーターリストの最後にあることを確認してください
-   **修飾子の制限** – `params` を `in`、`ref`、`out` などの修飾子と組み合わせないでください
-   **デフォルト値** – `params` パラメーターにデフォルト値を割り当てないでください。これは許可されていません

詳細は[機能仕様](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-13.0/params-collections)を確認してください。
