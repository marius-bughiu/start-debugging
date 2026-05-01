---
title: "C# 12 - Valores padrão para parâmetros em expressões lambda"
description: "O C# 12 permite especificar valores padrão para parâmetros e arrays params em expressões lambda, assim como em métodos e funções locais."
pubDate: 2023-05-09
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "pt-br"
translationOf: "2023/05/c-12-default-values-for-parameters-in-lambda-expressions"
translatedBy: "claude"
translationDate: 2026-05-01
---
A partir do C# 12, você pode especificar valores padrão para os parâmetros em expressões lambda. A sintaxe e as restrições para os valores padrão dos parâmetros são as mesmas dos métodos e funções locais.

Vamos a um exemplo:

```cs
var incrementBy = (int source, int increment = 1) => source + increment;
```

Essa lambda agora pode ser consumida assim:

```cs
Console.WriteLine(incrementBy(3)); 
Console.WriteLine(incrementBy(3, 2));
```

## Array params em expressões lambda

Também é possível declarar expressões lambda com um array **params** como parâmetro:

```cs
var sum = (params int[] values) =>
{
    int sum = 0;
    foreach (var value in values) 
    {
        sum += value;
    }

    return sum;
};
```

E consumi-las como qualquer outra função:

```cs
var empty = sum();
Console.WriteLine(empty); // 0

var sequence = new[] { 1, 2, 3, 4, 5 };
var total = sum(sequence);

Console.WriteLine(total); // 15
```

## Erro CS8652

> The feature 'lambda optional parameters' is currently in Preview and _unsupported_. To use Preview features, use the 'preview' language version.

Seu projeto precisa estar direcionado ao .NET 8 e C# 12 ou mais novo para usar o recurso de parâmetros opcionais em lambdas. Se não tiver certeza de como mudar para C# 12, confira este artigo: [Como mudar para o C# 12](/pt-br/2023/06/how-to-switch-to-c-12/).
