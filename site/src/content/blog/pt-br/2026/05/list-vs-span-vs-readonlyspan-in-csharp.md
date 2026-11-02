---
title: "List<T> vs Span<T> vs ReadOnlySpan<T> em C#: quando usar cada um"
description: "Escolha List<T> para coleções expansíveis, Span<T> para visualizações mutáveis e ReadOnlySpan<T> para leitura. Entenda duração e limites de async."
pubDate: 2026-05-25
updatedDate: 2026-11-02
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "performance"
  - "memory"
lang: "pt-br"
translationOf: "2026/05/list-vs-span-vs-readonlyspan-in-csharp"
translatedBy: "claude"
translationDate: 2026-05-25
---

`List<T>` gerencia uma coleção expansível. `Span<T>` é uma visualização de tamanho fixo sobre memória contígua; `ReadOnlySpan<T>` impede gravações por essa visualização. Uma visualização não substitui a propriedade nem o gerenciamento da duração do buffer.

**Correção — 2 de novembro de 2026:** foram removidos números de benchmark do .NET 11 sem comprovação e corrigidas afirmações sobre retornos, campos e versões. Os exemplos foram verificados com SDK 10.0.302 e C# 14. Não há promessa de aceleração universal.

## Escolha pela propriedade e duração

| Necessidade | Ponto de partida |
| --- | --- |
| Acrescentar elementos a uma coleção | `List<T>` |
| Ler ou alterar uma região contígua de forma síncrona | `Span<T>` |
| Ler sem gravar pela visualização | `ReadOnlySpan<T>` |
| Manter uma visualização em uma classe ou através de `await` | `Memory<T>` / `ReadOnlyMemory<T>` |

Um span não é proprietário do buffer. É possível retornar um span respaldado por array com duração válida; não é possível retornar um span sobre um `stackalloc` local. Spans podem ser campos de outro `ref struct`, mas não de classes ou structs comuns. Não podem sofrer boxing nem ser capturados por lambdas.

Desde C# 13, variáveis ref-struct locais podem existir em métodos async quando não permanecem ativas através de um `await`. Use Memory quando precisarem atravessar essa fronteira. Uma visualização somente leitura não torna o buffer imutável: outro alias pode alterá-lo.

## Alterar sem copiar

```csharp
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

var values = new List<int> { 3, 9, 4 };
Span<int> view = CollectionsMarshal.AsSpan(values);
view[1] = 20;
Console.WriteLine(values[1]); // 20

int[] array = { 10, 20, 30 };
Span<int> tail = Tail(array);
tail[0] = 99;
Console.WriteLine(array[1]); // 99

static Span<int> Tail(int[] source) => source.AsSpan(1);
```

As visualizações compartilham o armazenamento original. `Tail` retorna um span válido sobre um array, não um buffer local da pilha. Enquanto usar a visualização de `CollectionsMarshal.AsSpan`, não adicione nem remova itens da lista, mesmo sem redimensionamento do array interno. Prefira a API normal da lista até haver uma necessidade demonstrada por medição.

## Entrada somente leitura

```csharp
using System;

ReadOnlySpan<char> text = "2026-05-25".AsSpan(0, 4);
ReadOnlySpan<byte> method = "GET"u8;
Console.WriteLine(int.Parse(text)); // 2026
Console.WriteLine(method.Length);   // 3
```

Strings fornecem `ReadOnlySpan<char>`; literais UTF-8 fornecem `ReadOnlySpan<byte>`. Um span mutável pode virar somente leitura, mas o caminho inverso não existe. Peça o parâmetro somente leitura quando não precisar alterar elementos.

C# 14 chegou com .NET 10. Conversões implícitas básicas de arrays para spans já existiam; C# 14 ampliou o suporte na inferência genérica e nos receptores de métodos de extensão. `allows ref struct`, do C# 13, só permite esses argumentos genéricos quando a API aceita explicitamente. Não torna `List<Span<int>>` válido.

## Meça a operação concreta

Fatiar spans pode evitar cópias e alocações de substrings. Não garante que qualquer loop supere uma lista: JIT, runtime, tamanho e trabalho executado importam. Criar uma string, array ou lista ainda pode alocar memória. Publique tempos com o código completo, configuração e saída do benchmark.

Para buffers async, veja [converter arrays em ReadOnlyMemory](/pt-br/2026/05/how-to-convert-array-to-readonlymemory-in-csharp/). Para processamento e buffers temporários, veja [quando spans podem melhorar o desempenho](/pt-br/2026/06/what-is-span-and-when-does-it-make-my-code-faster/).

## Fontes

- [Memory and Span usage guidelines](https://learn.microsoft.com/en-us/dotnet/standard/memory-and-spans/memory-t-usage-guidelines)
- [Span<T>](https://learn.microsoft.com/en-us/dotnet/api/system.span-1?view=net-10.0)
- [CollectionsMarshal.AsSpan](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.collectionsmarshal.asspan?view=net-10.0)
- [C# 14 first-class span types](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-14.0/first-class-span-types.md)
- [C# 13 ref struct interfaces and generic arguments](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-13.0/ref-struct-interfaces.md)
