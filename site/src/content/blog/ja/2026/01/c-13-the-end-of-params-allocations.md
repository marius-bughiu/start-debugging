---
title: "C# 13: `params` 割り当ての終わり"
description: "C# 13 はついに params の背後にある隠れた配列割り当てを解消します。Span、ReadOnlySpan、List などのコレクション型と組み合わせて、ゼロ割り当ての可変長メソッドを使えるようになります。"
pubDate: 2026-01-02
tags:
  - "csharp-13"
  - "csharp"
  - "dotnet"
  - "dotnet-9"
lang: "ja"
translationOf: "2026/01/c-13-the-end-of-params-allocations"
translatedBy: "claude"
translationDate: 2026-05-01
---
20 年以上にわたり、C# の `params` キーワードには隠れた税金が付きまといました。暗黙の配列割り当てです。`string.Format` のようなメソッドや独自のヘルパーを可変個数の引数で呼ぶたびに、コンパイラはひそかに新しい配列を生成していました。高パフォーマンスが必要な状況 (ホットパス) では、これらの割り当てが積み重なり、不要なガベージコレクション (GC) 圧をかけていました。

C# 13 と .NET 9 で、ついにこの税金は撤廃されます。`params` を配列以外のコレクション型 (`Span<T>` や `ReadOnlySpan<T>` を含む) で使えるようになります。

## 配列の税金

C# 13 以前の典型的なロギングメソッドを考えてみましょう。

```cs
// Old C# way
public void Log(string message, params object[] args)
{
    // ... logic
}

// Usage
Log("User {0} logged in", userId); // Allocates new object[] { userId }
```

整数を 1 つ渡しただけでも、ランタイムはヒープ上に配列を割り当てる必要がありました。Serilog や ASP.NET Core のロギングのようなライブラリでは、これを避けるために創造的な回避策を考えたり、引数 1, 2, 3... 個のメソッドをオーバーロードしたりすることになりました。

## `params ReadOnlySpan<T>` でゼロ割り当て

C# 13 は、コレクション式をサポートする任意の型に対して `params` 修飾子を許可します。最も影響が大きい変更は `ReadOnlySpan<T>` のサポートです。

```cs
// C# 13 way
public void Log(string message, params ReadOnlySpan<object> args)
{
    // ... logic using span
}

// Usage
// Compiler uses stack allocation or shared buffers!
Log("User {0} logged in", userId);
```

この新しいメソッドを呼び出すと、コンパイラはスタックに割り当てられたバッファ (`stackalloc` 経由) や他の最適化を使って引数を渡せるほど賢く、ヒープを完全に回避できます。

## 配列の枠を超えて

これは性能だけの話ではありません。`params` は `List<T>`, `HashSet<T>`, `IEnumerable<T>` をサポートするようになりました。配列を強制せずにデータ構造の _意図_ を定義できるようになり、API の柔軟性が向上します。

```cs
public void ProcessTags(params HashSet<string> tags) 
{
    // O(1) lookups immediately available
}

ProcessTags("admin", "editor", "viewer");
```

## いつ移行すべきか

.NET 9 上でライブラリやパフォーマンスに敏感なアプリケーションを保守しているなら、`params` メソッドを点検してください。

1.  データを読み込むだけでよいなら、`params T[]` を `params ReadOnlySpan<T>` に変更します。
2.  遅延実行やジェネリックな柔軟性が必要なら、`params IEnumerable<T>` に変更します。

このわずかなシグネチャ変更が、アプリケーションのライフタイム全体で発生するメモリトラフィックを大きく削減します。
