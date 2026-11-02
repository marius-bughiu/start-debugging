---
title: "O que é ref-safe-context em C# e como o compilador o decide para locais ref?"
description: "Entenda escape de referências C# com exemplos verificados pelo compilador: locais ref, reatribuição, scoped e spans apoiados no heap ou stack."
pubDate: 2026-10-15
updatedDate: 2026-11-02
template: how-to
tags:
  - "csharp"
  - "csharp-14"
  - "dotnet-11"
  - "ref-locals"
  - "span"
  - "compiler-errors"
lang: "pt-br"
translationOf: "2026/10/what-is-ref-safe-context-in-csharp-and-how-does-the-compiler-decide-it-for-ref-locals"
translatedBy: "claude"
translationDate: 2026-10-15
---
Uma referência não pode escapar do tempo de vida do armazenamento para o qual aponta. C# verifica essa relação na compilação. Um local `ref` inicializado a partir de uma variável local do método não pode ser retornado apenas porque depois foi reatribuído a um elemento de array.

**Correção — 2 de novembro de 2026:** a afirmação anterior de testes com .NET 11 RC1 não tinha evidência preservada e foi removida. Os exemplos positivos e negativos daqui foram compilados com SDK 10.0.302, `net10.0` e `LangVersion` 14. Os códigos abaixo correspondem a essas formas exatas; expressões relacionadas podem gerar diagnósticos diferentes.

## Ref-safe-context e safe-context

`ref-safe-context` diz respeito a uma referência ao armazenamento. O `safe-context` relacionado diz respeito a um valor que pode conter referências, como `Span<T>`. A variável local que contém o span e o armazenamento descrito por ele são coisas diferentes.

A especificação descreve quatro contextos aninhados:

| Contexto | Exemplo típico |
| --- | --- |
| declaration-block | Referência a uma variável local comum |
| function-member | Parâmetro por valor ou parâmetro scoped |
| return-only | Parâmetro `ref` comum que pode ser retornado |
| caller-context | Elemento de array ou campo de classe apropriado |

Esses nomes não indicam que todo armazenamento dure até o retorno do método. Blocos aninhados e restrições `scoped` continuam importantes. A [especificação](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/variables#972-ref-safe-contexts) apresenta as regras completas, inclusive parâmetros e invocações.

## O inicializador limita um local ref sem scoped

Este exemplo negativo produz CS8157 na compilação verificada:

```csharp
class Example
{
    static ref int CannotReturn(int[] array)
    {
        int local = 1;
        ref int reference = ref local;
        reference = ref array[0];
        return ref reference; // CS8157
    }
}
```

A reatribuição posterior é permitida, mas não transforma uma referência derivada de um local em uma referência retornável. Retornar diretamente um local comum produz CS8168:

```csharp
class Example
{
    static ref int CannotReturn()
    {
        int local = 1;
        return ref local; // CS8168
    }
}
```

## Reatribuição não pode aceitar um referente mais restrito

Começar com uma referência a elemento de array e depois atribuir uma referência local produz CS8374:

```csharp
class Example
{
    static void CannotNarrow(int[] array)
    {
        ref int reference = ref array[0];
        int local = 1;
        reference = ref local; // CS8374
    }
}
```

Um parâmetro `ref` tem contrato de escape diferente de um elemento de array. Inicializar pelo array e depois atribuir o parâmetro produz CS9079:

```csharp
class Example
{
    static ref int CannotAssign(int[] array, ref int parameter)
    {
        ref int reference = ref array[0];
        reference = ref parameter; // CS9079
        return ref reference;
    }
}
```

A ordem inversa compilou com sucesso na mesma verificação:

```csharp
class Example
{
    static ref int CanReturn(int[] array, ref int parameter)
    {
        ref int reference = ref parameter;
        reference = ref array[0];
        return ref reference;
    }
}
```

Escolha um inicializador cujo contrato sirva para todos os usos pretendidos. Mover declarações ou acrescentar `scoped` não corrige universalmente todos os erros de escape.

## Referências scoped continuam locais

Esta alteração dentro do mesmo bloco compilou com sucesso:

```csharp
class Example
{
    static void LocalUse(int[] array)
    {
        scoped ref int reference = ref array[0];
        int local = 1;
        reference = ref local;
        reference = 5;
    }
}
```

Retornar essa referência scoped é rejeitado. Uma verificação separada declarou `local` em um bloco aninhado mais estreito e também rejeitou a reatribuição com CS8374. `scoped` não elimina limites de vida dos blocos nem torna uma referência retornável.

Um parâmetro scoped também pode comunicar que um argumento não escapa pelo resultado do método. É um contrato de assinatura; o compilador não precisa inspecionar a implementação de um helper arbitrário. A [proposta do C# 11](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-11.0/low-level-struct-improvements.md) detalha as regras e os casos `[UnscopedRef]`.

## Um span não é necessariamente apoiado no stack

Ambos os exemplos declaram um span local, mas apenas o primeiro resultado pode escapar:

```csharp
using System;

class Example
{
    static ref int HeapBacked()
    {
        Span<int> values = new int[2];
        return ref values[0]; // Compiles in the verified probe
    }

    static ref int StackBacked()
    {
        Span<int> values = stackalloc int[2];
        return ref values[0]; // CS8352 in this exact probe
    }
}
```

O span baseado em array descreve armazenamento no heap gerenciado. Retornar uma referência para esse armazenamento difere de retornar uma referência à própria variável local span. Referências gerenciadas mantêm os objetos referenciados alcançáveis; isso não torna objetos do heap imortais.

Para um algoritmo prático com retorno ref, use um span fornecido pelo chamador e trate a entrada vazia:

```csharp
using System;

static ref int MaxRef(Span<int> values)
{
    if (values.IsEmpty)
        throw new ArgumentException("At least one element is required", nameof(values));

    ref int best = ref values[0];
    for (int i = 1; i < values.Length; i++)
        if (values[i] > best) best = ref values[i];
    return ref best;
}

int[] data = { 3, 9, 4 };
MaxRef(data) = 0;
Console.WriteLine(string.Join(",", data)); // 3,0,4
```

## Leia o diagnóstico no contexto

As verificações distinguem retorno direto de local (CS8168), local ref não retornável (CS8157), atribuição de referência mais estreita (CS8374) e parâmetro return-only atribuído a referência mais ampla (CS9079). A expressão direta do span de stack acima produziu CS8352. Um alias ou helper adicional pode mudar o diagnóstico sem mudar o problema de tempo de vida.

Restrições de async/iteradores são outra questão: uma referência não pode ser preservada através de um ponto de suspensão quando a linguagem proíbe isso. Não explique toda rejeição do compilador apenas pela regra do inicializador.

Relacionado: [Span<T> e seu armazenamento](/pt-br/2026/06/what-is-span-and-when-does-it-make-my-code-faster/), [List versus Span versus ReadOnlySpan](/pt-br/2026/05/list-vs-span-vs-readonlyspan-in-csharp/) e [declarações de variáveis de referência](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/statements/declarations#reference-variables).
