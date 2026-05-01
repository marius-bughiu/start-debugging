---
title: "Deep clone e deep equality de um JsonNode"
description: "Veja como usar os novos métodos DeepClone() e DeepEquals() do JsonNode no .NET 8 para clonar e comparar nós JSON em profundidade."
pubDate: 2023-10-22
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
lang: "pt-br"
translationOf: "2023/10/deep-cloning-and-deep-equality-of-a-jsonnode"
translatedBy: "claude"
translationDate: 2026-05-01
---
A partir do .NET 8, a classe `JsonNode` ganhou alguns métodos novos para auxiliar no deep clone de nós e para verificar se eles são iguais ou não.

```cs
public partial class JsonNode
{
    public JsonNode DeepClone();

    public static bool DeepEquals(JsonNode? node1, JsonNode? node2);
}
```

O método `DeepClone()` cria e devolve um deep clone do nó atual e de todos os seus descendentes.

Já o `DeepEquals()` compara os valores das propriedades do nó e de todos os seus descendentes e retorna `true` somente quando as representações JSON deles são equivalentes. Um detalhe interessante: `DeepEquals` não é um método de instância como você está acostumado em `Object.Equals(...)`, nem um método de extensão, então não dá para fazer simplesmente `node1.DeepEquals(node2)`. Você sempre precisa chamar o método estático explicitamente: `JsonNode.DeepEquals(node1, node2)`.
