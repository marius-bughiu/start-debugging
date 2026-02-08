---
title: "Deep cloning and deep equality of a JsonNode"
description: "Starting with .NET 8, several new methods have been added to the JsonNode class to help with the deep cloning of nodes and checking whether they are equal or not. The DeepClone() method will create and return a deep clone of the current node and all of its descendants. On the other hand, DeepEquals() will…"
pubDate: 2023-10-22
updatedDate: 2023-11-05
tags:
  - "net"
  - "net-8"
---
Starting with .NET 8, several new methods have been added to the `JsonNode` class to help with the deep cloning of nodes and checking whether they are equal or not.

```cs
public partial class JsonNode
{
    public JsonNode DeepClone();

    public static bool DeepEquals(JsonNode? node1, JsonNode? node2);
}
```

The `DeepClone()` method will create and return a deep clone of the current node and all of its descendants.

On the other hand, `DeepEquals()` will compare the property values of the node and all of it’s descendants and return `true` only when their JSON representations are equivalent. An interesting thing to note here is that `DeepEquals` is not an instance method like you would have been used to with `Object.Equals(...)`, nor is it an extension method – so you cannot simply `node1.DeepEquals(node2)`. You will always need to explicitly call the static method like this: `JsonNode.DeepEquals(node1, node2)`.
