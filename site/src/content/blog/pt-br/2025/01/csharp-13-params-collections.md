---
title: "C# 13: Use coleções params com qualquer tipo de coleção reconhecido"
description: "C# 13 amplia params para coleções reconhecidas. Entenda elementos, chamadas normais e expandidas, requisitos dos tipos e possíveis alocações."
pubDate: 2025-01-02
updatedDate: 2026-11-02
tags:
  - "csharp-13"
  - "csharp"
  - "dotnet"
  - "dotnet-9"
lang: "pt-br"
translationOf: "2025/01/csharp-13-params-collections"
translatedBy: "claude"
translationDate: 2026-05-01
---

C# 13 amplia `params` além de arrays unidimensionais para tipos de coleção reconhecidos. A chamada expandida passa **elementos** individuais, não uma quantidade variável de spans.

**Correção — 2 de novembro de 2026:** corrigimos a explicação dos elementos e os requisitos das coleções. Passar uma lista para um parâmetro comum `IEnumerable<T>` já era possível antes do C# 13. Os dois exemplos foram verificados com SDK 10.0.302 e `LangVersion` 13.

## Parâmetros Span

```csharp
using System;

Print(1, 2, 3); // Expanded form: three int elements.
int[] data = { 4, 5 };
Print(data);    // Normal form: an existing buffer.

static void Print(params ReadOnlySpan<int> values)
{
    foreach (int value in values)
        Console.WriteLine(value);
}
```

A forma normal passa um valor existente conversível para o tipo do parâmetro. A expandida fornece elementos com os quais o compilador cria a coleção. `ReadOnlySpan<T>` pode evitar um array em chamadas adequadas, mas não garante ausência de alocações para qualquer tipo e chamada.

## Coleções aceitas

São aceitos `Span<T>`, `ReadOnlySpan<T>`, interfaces genéricas reconhecidas e tipos com builder compatíveis com expressões de coleção. Coleções construíveis precisam do construtor sem parâmetros acessível exigido, de um método de instância `Add` adequado e de suporte à enumeração. Implementar `IEnumerable<T>` e ter qualquer método chamado `Add` não basta.

As interfaces incluem `IEnumerable<T>`, `IReadOnlyCollection<T>`, `IReadOnlyList<T>`, `ICollection<T>` e `IList<T>`.

```csharp
using System;
using System.Collections.Generic;

var values = new List<int> { 1, 2, 3 };
Print(values);  // Normal form.
Print(4, 5, 6); // Expanded form: enabled by params collections in C# 13.

static void Print(params IEnumerable<int> values)
{
    foreach (int value in values)
        Console.WriteLine(value);
}
```

A primeira chamada já funcionava em versões anteriores com um parâmetro `IEnumerable<int>` sem `params`. C# 13 adiciona a forma expandida `Print(4, 5, 6)` para esse tipo. A coleção criada para a chamada pode alocar memória.

`params` deve ser o último parâmetro, sem valor padrão e sem `ref`, `in` ou `out`. Novas sobrecargas de coleções params podem alterar a resolução de sobrecargas quando consumidores recompilam; confira as chamadas reais.

Sobre propriedade e visualizações, veja [List, Span e ReadOnlySpan](/pt-br/2026/05/list-vs-span-vs-readonlyspan-in-csharp/).

## Fontes

- [C# 13 params collections specification](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-13.0/params-collections.md)
- [C# method parameters: params modifier](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/method-parameters#params-modifier)
