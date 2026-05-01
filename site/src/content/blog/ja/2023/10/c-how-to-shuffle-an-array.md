---
title: "C# 配列をシャッフルするには?"
description: "C# で配列をシャッフルするいちばん簡単な方法は、.NET 8 で導入された Random.Shuffle を使うことです。配列にも Span にも、in-place で動作します。"
pubDate: 2023-10-26
updatedDate: 2023-11-01
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "ja"
translationOf: "2023/10/c-how-to-shuffle-an-array"
translatedBy: "claude"
translationDate: 2026-05-01
---
C# で配列をシャッフルするいちばん簡単な方法は `Random.Shuffle` を使うことです。このメソッドは .NET 8 で導入され、配列にも Span にも対応しています。

シャッフルは in-place で行われます (新しい配列を作って元のものを残すのではなく、既存の配列や Span が直接変更されます) 。

シグネチャは次のとおりです。

```cs
public void Shuffle<T> (Span<T> values);
public void Shuffle<T> (T[] values);
```

シンプルな使用例はこちら。

```cs
int[] foo = [1, 2, 3];
Random.Shared.Shuffle(foo); // [2, 1, 3]
```
