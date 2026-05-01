---
title: ".NET 10 パフォーマンス: SearchValues"
description: ".NET 10 で SearchValues を使い、高性能なマルチ文字列検索を実現します。foreach ループを Aho-Corasick および Teddy アルゴリズムによる SIMD 加速のマッチングに置き換えます。"
pubDate: 2026-01-04
tags:
  - "dotnet"
  - "dotnet-10"
lang: "ja"
translationOf: "2026/01/net-10-performance-searchvalues"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 8 で Microsoft は `SearchValues<T>` を導入しました。これは span 内の値の _集合_ (バイトや char など) の検索を最適化する特殊な型です。検索をベクトル化することで、`IndexOfAny` よりも大幅に高速化されました。

.NET 10 では、この機能が文字列にまで拡張されました。`SearchValues<string>` を使うと、複数のサブ文字列を同時に、驚くべきパフォーマンスで検索できます。

## ユースケース: パースとフィルタリング

特定の禁止ワードやトークンのリストにテキストが該当するかを確認する必要があるパーサーやサニタイザーを書いている状況を想像してください。

**従来の方法 (遅い)**

```cs
private static readonly string[] Forbidden = { "drop", "delete", "truncate" };

public bool ContainsSqlInjection(ReadOnlySpan<char> input)
{
    foreach (var word in Forbidden)
    {
        if (input.Contains(word, StringComparison.OrdinalIgnoreCase))
            return true;
    }
    return false;
}
```

これは O(N \* M) です (N は入力の長さ、M は単語数)。文字列を繰り返しスキャンすることになります。

## 新しい方法: SearchValues

.NET 10 では、検索戦略を事前に計算できます。

```cs
using System.Buffers;

// 1. Create the optimized searcher (do this once, statically)
private static readonly SearchValues<string> SqlTokens = 
    SearchValues.Create(["drop", "delete", "truncate"], StringComparison.OrdinalIgnoreCase);

public bool ContainsSqlInjection(ReadOnlySpan<char> input)
{
    // 2. Search for ANY of them in one pass
    return input.ContainsAny(SqlTokens);
}
```

## パフォーマンスへの影響

内部的に、`SearchValues.Create` はパターンを解析します。

-   共通のプレフィックスがある場合は、trie 風の構造を構築します。
-   パターンの密度に応じて Aho-Corasick または Teddy アルゴリズムを使用します。
-   SIMD (AVX-512) を活用して複数の文字を並列にマッチングします。

10〜20 個のキーワードの集合に対しては、`SearchValues` はループや Regex に比べて **50 倍高速** になることがあります。

## 位置の特定

ブール値のチェックだけに限定されません。マッチが _どこで_ 発生したかを見つけることもできます。

```cs
int index = input.IndexOfAny(SqlTokens);
if (index >= 0)
{
    Console.WriteLine($"Found distinct token at index {index}");
}
```

## まとめ

.NET 10 の `SearchValues<string>` は、外部ライブラリに頼ることなく、高性能なテキスト検索を広く利用可能にします。テキスト処理、ログ解析、セキュリティフィルタリングなどを行っているなら、`foreach` ループを今すぐ `SearchValues` に置き換えましょう。
