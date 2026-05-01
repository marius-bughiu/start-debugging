---
title: "Clonado profundo e igualdad profunda de un JsonNode"
description: "Aprende a usar los nuevos métodos DeepClone() y DeepEquals() de JsonNode en .NET 8 para clonar y comparar nodos JSON en profundidad."
pubDate: 2023-10-22
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
lang: "es"
translationOf: "2023/10/deep-cloning-and-deep-equality-of-a-jsonnode"
translatedBy: "claude"
translationDate: 2026-05-01
---
A partir de .NET 8 se han añadido varios métodos nuevos a la clase `JsonNode` para ayudar con la clonación profunda de nodos y para comprobar si son iguales o no.

```cs
public partial class JsonNode
{
    public JsonNode DeepClone();

    public static bool DeepEquals(JsonNode? node1, JsonNode? node2);
}
```

El método `DeepClone()` crea y devuelve una clonación profunda del nodo actual y de todos sus descendientes.

Por otro lado, `DeepEquals()` compara los valores de las propiedades del nodo y de todos sus descendientes y devuelve `true` solo cuando sus representaciones JSON son equivalentes. Algo interesante a tener en cuenta aquí es que `DeepEquals` no es un método de instancia como estarías acostumbrado con `Object.Equals(...)`, ni es un método de extensión, así que no puedes hacer simplemente `node1.DeepEquals(node2)`. Siempre tendrás que llamar explícitamente al método estático así: `JsonNode.DeepEquals(node1, node2)`.
