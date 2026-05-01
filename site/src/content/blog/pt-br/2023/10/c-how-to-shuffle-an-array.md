---
title: "C# como embaralhar um array?"
description: "A forma mais fácil de embaralhar um array em C# é usar Random.Shuffle, introduzido no .NET 8. Funciona in-place tanto em arrays quanto em spans."
pubDate: 2023-10-26
updatedDate: 2023-11-01
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "pt-br"
translationOf: "2023/10/c-how-to-shuffle-an-array"
translatedBy: "claude"
translationDate: 2026-05-01
---
A forma mais fácil de embaralhar um array em C# é usar `Random.Shuffle`. Esse método foi introduzido no .NET 8 e funciona tanto com arrays quanto com spans.

O embaralhamento acontece in-place (o próprio array/span existente é modificado, em vez de criar um novo e deixar o original intacto).

Em termos de assinaturas, temos:

```cs
public void Shuffle<T> (Span<T> values);
public void Shuffle<T> (T[] values);
```

E um exemplo simples de uso:

```cs
int[] foo = [1, 2, 3];
Random.Shared.Shuffle(foo); // [2, 1, 3]
```
