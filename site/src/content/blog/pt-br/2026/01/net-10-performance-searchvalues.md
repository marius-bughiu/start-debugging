---
title: "Desempenho no .NET 10: SearchValues"
description: "Use SearchValues no .NET 10 para busca multi-string de alto desempenho. Substitui loops foreach por correspondência acelerada por SIMD usando os algoritmos Aho-Corasick e Teddy."
pubDate: 2026-01-04
tags:
  - "dotnet"
  - "dotnet-10"
lang: "pt-br"
translationOf: "2026/01/net-10-performance-searchvalues"
translatedBy: "claude"
translationDate: 2026-05-01
---
No .NET 8, a Microsoft introduziu `SearchValues<T>`, um tipo especializado que otimizava a busca de um _conjunto_ de valores (como bytes ou chars) dentro de um span. Ele vetorizava a busca, tornando-a significativamente mais rápida que `IndexOfAny`.

No .NET 10, esse poder foi estendido para strings. `SearchValues<string>` permite buscar várias substrings simultaneamente com desempenho impressionante.

## O caso de uso: parsing e filtragem

Imagine que você está escrevendo um parser ou um sanitizador que precisa verificar se um texto contém alguma palavra ou token de uma lista específica de proibidos.

**A forma antiga (lenta)**

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

Isso é O(N \* M), onde N é o comprimento da entrada e M é o número de palavras. Ele varre a string repetidamente.

## A forma nova: SearchValues

Com o .NET 10, você pode pré-computar a estratégia de busca.

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

## Impacto no desempenho

Por baixo dos panos, `SearchValues.Create` analisa os padrões.

-   Se compartilharem prefixos comuns, ele constrói uma estrutura semelhante a trie.
-   Usa os algoritmos Aho-Corasick ou Teddy dependendo da densidade do padrão.
-   Aproveita SIMD (AVX-512) para corresponder múltiplos caracteres em paralelo.

Para um conjunto de 10 a 20 palavras-chave, `SearchValues` pode ser **50 vezes mais rápido** que um loop ou uma Regex.

## Encontrando a posição

Você não está limitado a uma verificação booleana. Você pode encontrar _onde_ a correspondência ocorreu:

```cs
int index = input.IndexOfAny(SqlTokens);
if (index >= 0)
{
    Console.WriteLine($"Found distinct token at index {index}");
}
```

## Resumo

`SearchValues<string>` no .NET 10 traz busca de texto de alto desempenho para todos sem exigir bibliotecas externas. Se você está fazendo qualquer tipo de processamento de texto, análise de log ou filtragem de segurança, substitua seus loops `foreach` por `SearchValues` imediatamente.
