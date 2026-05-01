---
title: "C# Escolher itens aleatoriamente de uma lista"
description: "Em C#, você pode selecionar aleatoriamente itens de uma lista usando Random.GetItems, um método introduzido no .NET 8. Aprenda como funciona com exemplos práticos."
pubDate: 2023-11-12
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "pt-br"
translationOf: "2023/11/c-randomly-choose-items-from-a-list"
translatedBy: "claude"
translationDate: 2026-05-01
---
Em C#, você pode selecionar aleatoriamente itens de uma lista usando `Random.GetItems`, um método introduzido no .NET 8.

```cs
public T[] GetItems<T>(T[] choices, int length)
```

O método recebe dois parâmetros:

-   `choices` -- a lista de itens entre os quais escolher / a lista de possibilidades.
-   `length` -- quantos itens selecionar.

Há duas coisas importantes a observar sobre esse método:

-   a lista resultante pode conter duplicados, não é uma lista de escolhas únicas.
-   isso abre o parâmetro `length` para ser maior que o tamanho da lista de opções.

Dito isso, vejamos alguns exemplos. Vamos assumir o seguinte array de opções:

```cs
string[] fruits =
[
    "apple",
    "banana",
    "orange",
    "kiwi"
];
```

Para selecionar 2 frutas aleatórias dessa lista, simplesmente chamamos:

```cs
var chosen = Random.Shared.GetItems(fruits, 2);
```

Agora, como eu disse antes, as duas frutas escolhidas não são necessariamente únicas. Você pode acabar, por exemplo, com `[ "kiwi", "kiwi" ]` como seu array `chosen`. Você pode testar isso facilmente com um do-while:

```cs
string[] chosen = null;

do
    chosen = Random.Shared.GetItems(fruits, 2);
while (chosen[0] != chosen[1]);

// At this point, you will have the same fruit twice
```

E isso abre a possibilidade de o método selecionar mais itens do que você realmente tem na lista. No nosso exemplo temos apenas 4 frutas entre as quais escolher, mas podemos pedir ao `GetItems` que escolha 10 frutas, e ele fará isso sem problemas.

```cs
var chosen = Random.Shared.GetItems(fruits, 10);
// [ "kiwi", "banana", "kiwi", "orange", "apple", "orange", "apple", "orange", "kiwi", "apple" ]
```
