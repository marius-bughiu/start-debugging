---
title: "Глубокое клонирование и глубокое сравнение JsonNode"
description: "Узнайте, как использовать новые методы DeepClone() и DeepEquals() у JsonNode в .NET 8 для глубокого клонирования и сравнения JSON-узлов."
pubDate: 2023-10-22
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
lang: "ru"
translationOf: "2023/10/deep-cloning-and-deep-equality-of-a-jsonnode"
translatedBy: "claude"
translationDate: 2026-05-01
---
Начиная с .NET 8, к классу `JsonNode` добавили несколько новых методов, которые помогают делать глубокое клонирование узлов и проверять, равны они или нет.

```cs
public partial class JsonNode
{
    public JsonNode DeepClone();

    public static bool DeepEquals(JsonNode? node1, JsonNode? node2);
}
```

Метод `DeepClone()` создаёт и возвращает глубокую копию текущего узла и всех его потомков.

`DeepEquals()`, в свою очередь, сравнивает значения свойств узла и всех его потомков и возвращает `true` только тогда, когда их JSON-представления эквивалентны. Любопытная деталь: `DeepEquals` — это не метод экземпляра, как привычный `Object.Equals(...)`, и не метод-расширение, поэтому просто написать `node1.DeepEquals(node2)` не получится. Вызывать статический метод нужно всегда явно: `JsonNode.DeepEquals(node1, node2)`.
