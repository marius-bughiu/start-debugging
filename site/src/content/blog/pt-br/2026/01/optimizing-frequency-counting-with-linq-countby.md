---
title: "Otimizando contagem de frequência com LINQ CountBy"
description: "Substitua GroupBy por CountBy no .NET 9 para uma contagem de frequência mais limpa e eficiente. Reduz alocações de O(N) para O(K) ao pular estruturas intermediárias de agrupamento."
pubDate: 2026-01-01
tags:
  - "dotnet"
  - "dotnet-9"
lang: "pt-br"
translationOf: "2026/01/optimizing-frequency-counting-with-linq-countby"
translatedBy: "claude"
translationDate: 2026-05-01
---
Uma das operações mais comuns em processamento de dados é calcular a frequência de itens em uma coleção. Por anos, desenvolvedores C# contaram com o padrão `GroupBy` para isso. Embora funcional, ele costuma trazer sobrecarga desnecessária ao alocar objetos de bucket para grupos que são descartados imediatamente após a contagem.

Com o .NET 9, o namespace System.Linq introduz `CountBy`, um método especializado que simplifica significativamente essa operação.

## A sobrecarga legada

Antes do .NET 9, contar ocorrências geralmente exigia uma cadeia verbosa de chamadas LINQ. Você tinha que agrupar os elementos e depois projetá-los em um novo tipo contendo a chave e a contagem.

```cs
// Before: Verbose and allocates group buckets
var logLevels = new[] { "INFO", "ERROR", "INFO", "WARN", "ERROR", "INFO" };

var frequency = logLevels
    .GroupBy(level => level)
    .Select(group => new { Level = group.Key, Count = group.Count() })
    .ToDictionary(x => x.Level, x => x.Count);
```

Essa abordagem funciona, mas é pesada. O iterador `GroupBy` constrói estruturas internas para guardar os elementos de cada grupo, mesmo que só nos interesse a contagem. Para conjuntos grandes, isso impõe pressão desnecessária sobre o coletor de lixo.

## Enxugando com CountBy

O .NET 9 adiciona `CountBy` diretamente a `IEnumerable<T>`. Esse método retorna uma coleção de `KeyValuePair<TKey, int>`, dispensando estruturas intermediárias de agrupamento.

```cs
// After: Clean, intent-revealing, and efficient
var logLevels = new[] { "INFO", "ERROR", "INFO", "WARN", "ERROR", "INFO" };

foreach (var (level, count) in logLevels.CountBy(level => level))
{
    Console.WriteLine($"{level}: {count}");
}
```

A sintaxe não é apenas mais limpa; ela declara explicitamente a intenção: estamos contando por uma chave.

## Implicações de desempenho

Por baixo dos panos, `CountBy` é otimizado para evitar alocar os buckets de agrupamento que o `GroupBy` exige. Em um cenário tradicional de `GroupBy`, o runtime frequentemente cria um objeto `Grouping<TKey, TElement>` para cada chave única e mantém internamente uma coleção de elementos para essa chave. Se você tem 1 milhão de itens e 100 chaves únicas, o `GroupBy` ainda pode fazer trabalho significativo organizando esse 1 milhão de itens em listas.

`CountBy`, por outro lado, só precisa rastrear o contador. Comporta-se efetivamente como um acumulador `Dictionary<TKey, int>`. Ele itera a origem uma vez, incrementa o contador para a chave e descarta o elemento. Isso transforma uma operação com espaço O(N) (em termos de manter elementos) em algo mais próximo de O(K) de espaço, onde K é o número de chaves únicas.

Para cenários de alto throughput, como analisar logs de servidor, processar fluxos de transações ou agregar dados de sensores, essa diferença não é trivial. Ela reduz a pressão sobre o GC ao descartar imediatamente os pesados objetos de "bucket".

### Casos extremos e chaves

Como o `GroupBy`, o `CountBy` usa o comparador de igualdade padrão do tipo da chave, a menos que outro seja informado. Se você está contando por uma chave de objeto personalizada, garanta que `GetHashCode` e `Equals` estão corretamente sobrescritos, ou forneça um `IEqualityComparer<TKey>` próprio.

```cs
// Handling case-insensitivity explicitly
var frequency = logLevels.CountBy(level => level, StringComparer.OrdinalIgnoreCase);
```

### Quando manter o GroupBy

Vale notar que `CountBy` é estritamente para contagem. Se você precisa dos elementos em si (por exemplo, "me dê os 5 primeiros erros"), ainda precisa do `GroupBy`. Mas para histogramas, mapas de frequência e analytics, `CountBy` no .NET 9 é a ferramenta superior.

Ao adotar `CountBy`, você reduz a verbosidade e melhora os padrões de alocação em seus pipelines LINQ, tornando-o a escolha padrão para análise de frequência em códigos C# modernos.
