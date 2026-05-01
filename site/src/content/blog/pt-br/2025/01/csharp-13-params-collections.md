---
title: "C# 13: Use coleções params com qualquer tipo de coleção reconhecido"
description: "C# 13 estende o modificador params para além de arrays e suporta Span, ReadOnlySpan, IEnumerable e outros tipos de coleção, reduzindo boilerplate e melhorando a flexibilidade."
pubDate: 2025-01-02
updatedDate: 2025-01-07
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
O modificador `params` no C# foi tradicionalmente associado a tipos array, permitindo que métodos aceitassem um número variável de argumentos. No entanto, [a partir do C# 13](/pt-br/2025/01/how-to-switch-to-c-13/), você pode usar coleções params com uma variedade de tipos de coleção, ampliando sua aplicabilidade e tornando seu código ainda mais versátil.

## Tipos de coleção suportados

O modificador `params` agora funciona com diversos tipos de coleção reconhecidos, incluindo:

-   `System.Span<T>`
-   `System.ReadOnlySpan<T>`
-   tipos que implementam `System.Collections.Generic.IEnumerable<T>` e que também têm um método `Add`.

Além disso, você pode usar `params` com as seguintes interfaces do sistema:

-   `System.Collections.Generic.IEnumerable<T>`
-   `System.Collections.Generic.IReadOnlyCollection<T>`
-   `System.Collections.Generic.IReadOnlyList<T>`
-   `System.Collections.Generic.ICollection<T>`
-   `System.Collections.Generic.IList<T>`

## Um exemplo prático: usando Spans com `params`

Uma das possibilidades empolgantes com este aprimoramento é a capacidade de usar spans como parâmetros `params`. Aqui está um exemplo:

```cs
public void Concat<T>(params ReadOnlySpan<T> items)
{
    for (int i = 0; i < items.Length; i++)
    {
        Console.Write(items[i]);
        Console.Write(" ");
    }

    Console.WriteLine();
}
```

Neste método, `params` permite passar um número variável de spans para o método `Concat`. O método processa cada span em sequência, demonstrando a flexibilidade aprimorada do modificador `params`.

## Comparação com o C# 12.0

Em versões anteriores do C#, a palavra-chave `params` só suportava arrays, exigindo que os desenvolvedores convertessem manualmente outros tipos de coleção em arrays antes de passá-los para um método que usasse `params`. Esse processo adicionava boilerplate desnecessário, como criar arrays temporários ou chamar métodos de conversão explicitamente.

**Exemplo sem o novo recurso (Pré-C# 13)**

```cs
void PrintValues(params int[] values)
{
    foreach (var value in values)
    {
        Console.WriteLine(value);
    }
}

var list = new List<int> { 1, 2, 3 };

// Manual conversion to array
PrintValues(list.ToArray());
```

**Exemplo com o novo recurso (C# 13)**

```cs
void PrintValues(params IEnumerable<int> values)
{
    foreach (var value in values)
    {
        Console.WriteLine(value);
    }
}

var list = new List<int> { 1, 2, 3 };

// No conversion needed
PrintValues(list);
```

O novo recurso reduz boilerplate ao:

1.  **Eliminar a conversão manual** – não é necessário converter explicitamente coleções como `List<T>` ou `IEnumerable<T>` em arrays.
2.  **Tornar o código** **mais simples** – chamadas de método ficam mais limpas e legíveis, aceitando diretamente tipos de coleção compatíveis.
3.  **Melhorar a manutenibilidade** – reduz código repetitivo e propenso a erros, focando apenas na lógica em vez de lidar com conversões.

## Comportamento do compilador e resolução de sobrecarga

A introdução de coleções params significa ajustes no comportamento do compilador, particularmente no que diz respeito à resolução de sobrecarga. Quando um método inclui um parâmetro `params` de um tipo de coleção não-array, o compilador avalia a aplicabilidade tanto da forma normal quanto da forma expandida do método.

## Tratamento de erros e melhores práticas

Sempre que usar `params`, é importante seguir as melhores práticas para evitar erros comuns:

-   **posicionamento do parâmetro** – garanta que o parâmetro `params` seja o último na lista formal de parâmetros
-   **restrições de modificadores** – evite combinar `params` com modificadores como `in`, `ref` ou `out`
-   **valores padrão** – não atribua valores padrão a parâmetros `params`, pois isso não é permitido

Para mais detalhes, você pode consultar a [especificação do recurso](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-13.0/params-collections).
