---
title: "C#: como alterar um campo readonly com UnsafeAccessor"
description: "Exemplo executável .NET 8 de um campo readonly exposto por UnsafeAccessor, com limites explícitos de mutação e comportamento observado."
pubDate: 2023-11-02
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "pt-br"
translationOf: "2023/11/c-how-to-update-a-readonly-field-using-unsafeaccessor"
translatedBy: "claude"
translationDate: 2026-05-01
---
Um unsafe accessor do .NET 8 pode expor por referência um campo de instância, inclusive declarado `readonly`. Escrever por essa referência contorna as regras normais de atribuição do C#. Isso não muda a declaração nem estabelece garantias gerais sobre leituras otimizadas de estado imutável.

**Correção — 2 de novembro de 2026:** o exemplo indisponível foi restaurado. Foram removidos a alegação genérica de desempenho e o resultado incondicional da leitura direta; o exemplo verificado observa o valor pelo accessor.

## Exemplo executável

[Baixe o exemplo completo](/examples/unsafe-accessor.zip). Ele inclui demonstrações de membros privados e este caso readonly:

```cs
using System.Runtime.CompilerServices;

var holder = new ReadonlyHolder();
Accessors.ReadonlyField(holder) = 42;
Console.WriteLine(Accessors.ReadonlyField(holder)); // 42 in the verified run

internal sealed class ReadonlyHolder
{
    public readonly int Value = 3;
}

internal static class Accessors
{
    [UnsafeAccessor(UnsafeAccessorKind.Field, Name = "Value")]
    internal static extern ref int ReadonlyField(ReadonlyHolder instance);
}
```

Execute o projeto baixado com `dotnet run -c Release`. O exemplo completo verifica o valor inicial, faz a escrita e confere o resultado pelo accessor no .NET 8.0.33.

## O que isso demonstra

A assinatura corresponde ao tipo declarante, nome e tipo do campo. Retornar `ref int` permite a atribuição mostrada. Isso não faz escritas por outras referências, mutação concorrente ou todas as otimizações JIT/AOT se comportarem igualmente. Uma leitura direta em outro lugar não deve ser usada como promessa universal de mutação suportada.

Para estado da aplicação, prefira inicialização no construtor ou uma API explicitamente mutável. Escritas por reflexão em campos de instância e campos static readonly também têm restrições diferentes do runtime; não são casos intercambiáveis.

Veja o [guia de acesso a membros](/pt-br/2023/10/unsafe-accessor/) para accessors comuns e o [projeto benchmark](/pt-br/2023/11/net-8-performance-unsafeaccessor-vs-reflection/) para comparar caminhos de chamada. A [referência oficial](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.unsafeaccessorattribute) descreve assinaturas e limites de versão.
