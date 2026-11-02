---
title: "O que é Span<T> em C# e quando ele realmente deixa seu código mais rápido?"
description: "Span<T> pode evitar cópias e alocações temporárias ao analisar ou formatar memória contígua. Entenda os limites de duração e o que medir."
pubDate: 2026-06-20
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
  - "performance"
  - "memory"
lang: "pt-br"
translationOf: "2026/06/what-is-span-and-when-does-it-make-my-code-faster"
translatedBy: "claude"
translationDate: 2026-06-20
---

`Span<T>` é uma visualização de tamanho fixo sobre memória contígua: arrays, memória de pilha ou memória não gerenciada com duração controlada corretamente. `ReadOnlySpan<T>` permite leitura pela visualização. Strings oferecem `ReadOnlySpan<char>`, não `Span<char>` mutável.

Criar uma visualização não cria nem transfere a propriedade do armazenamento. Isso não torna toda a operação livre de alocações nem garante mais velocidade.

**Correção — 2 de novembro de 2026:** foram removidos tempos sem comprovação e uma promessa universal de aceleração. Corrigimos o tipo do literal UTF-8, os limites de retorno e as descrições de alocação. Os exemplos foram verificados com SDK 10.0.302 e C# 14, sem benchmark de desempenho.

## Evitar substrings temporárias

Parsers que aceitam spans podem dispensar strings intermediárias. Este exemplo interpreta um formato exato sem criar substrings para ano, mês e dia:

```csharp
using System;
using System.Globalization;

string input = "2026-06-01";
DateOnly date = ParseIsoDate(input.AsSpan());
Console.WriteLine(date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture));

static DateOnly ParseIsoDate(ReadOnlySpan<char> input) =>
    DateOnly.ParseExact(input, "yyyy-MM-dd", CultureInfo.InvariantCulture);
```

`ParseExact` valida a data e lança uma exceção para entrada inválida. Use `TryParseExact` se esse caso for esperado. Chamadas isoladas a `int.Parse(input.Slice(...))` não validam separadores nem datas do calendário por si só.

## Usar um buffer temporário limitado

```csharp
using System;
using System.Globalization;

Span<char> scratch = stackalloc char[32];
if (12345.TryFormat(scratch, out int written, provider: CultureInfo.InvariantCulture))
{
    ReadOnlySpan<char> formatted = scratch[..written];
    Console.Out.WriteLine(formatted); // 12345
    string owned = new string(formatted); // Allocates the resulting string.
    Console.WriteLine(owned);
}

ReadOnlySpan<byte> method = "GET"u8;
Console.WriteLine(method.SequenceEqual(new byte[] { 71, 69, 84 })); // True
```

O buffer evita um array temporário de caracteres. Criar a `string` final ainda aloca memória. O array de bytes da comparação também aloca: ele mostra os valores e não é um benchmark. `"GET"u8` tem tipo `ReadOnlySpan<byte>`.

Mantenha `stackalloc` pequeno e limitado. Alocações grandes ou repetidas em loops podem esgotar a pilha. Não derive o tamanho de uma entrada não validada; use arrays ou buffers de pool gerenciados corretamente para dados maiores.

## Armazenamento compartilhado e duração

Fatiar um span não copia elementos. Um span sobre array pode ser retornado se o armazenamento continuar válido; um span sobre buffer local de pilha não pode escapar do método. Campos Span são permitidos em outro `ref struct`, mas não em classes ou structs comuns. Desde C# 13, variáveis ref-struct podem existir em métodos async se não atravessarem `await`; para isso use `Memory<T>`.

`ReadOnlySpan<T>` não congela o buffer. Ao usar `CollectionsMarshal.AsSpan(list)`, não adicione nem remova elementos, mesmo com capacidade disponível.

## Medir uma melhoria concreta

Procure uma cópia ou alocação que possa remover: substrings, fatias copiadas ou arrays temporários de formatação. Loops comuns sobre arrays e listas podem estar bem otimizados. Eliminação de verificações e desempenho dependem do runtime e da carga; não há um multiplicador fixo confiável.

Meça trabalho equivalente em Release, no runtime implantado e com entradas representativas. Deixe a preparação fora da medição, inclua alocações e preserve código e saída. Este artigo não apresenta novos tempos medidos.

Conversões implícitas básicas de arrays para spans antecedem C# 14. C# 14 veio com .NET 10 e ampliou sua integração na linguagem. `allows ref struct`, do C# 13, só habilita APIs genéricas que aceitam o recurso explicitamente.

Para escolher o modelo de propriedade, veja [List, Span e ReadOnlySpan](/pt-br/2026/05/list-vs-span-vs-readonlyspan-in-csharp/). Para armazenamento async, [ReadOnlyMemory a partir de um array](/pt-br/2026/05/how-to-convert-array-to-readonlymemory-in-csharp/).

## Fontes

- [Memory and Span usage guidelines](https://learn.microsoft.com/en-us/dotnet/standard/memory-and-spans/memory-t-usage-guidelines)
- [Span<T>](https://learn.microsoft.com/en-us/dotnet/api/system.span-1?view=net-10.0)
- [CollectionsMarshal.AsSpan](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.collectionsmarshal.asspan?view=net-10.0)
- [C# 14 first-class span types](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-14.0/first-class-span-types.md)
- [C# 13 ref struct interfaces and generic arguments](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-13.0/ref-struct-interfaces.md)
