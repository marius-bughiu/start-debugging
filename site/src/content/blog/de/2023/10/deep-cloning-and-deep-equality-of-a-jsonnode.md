---
title: "Deep Clone und Deep Equality eines JsonNode"
description: "Erfahren Sie, wie Sie die neuen Methoden DeepClone() und DeepEquals() auf JsonNode in .NET 8 für tiefes Klonen und Vergleichen von JSON-Knoten verwenden."
pubDate: 2023-10-22
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
lang: "de"
translationOf: "2023/10/deep-cloning-and-deep-equality-of-a-jsonnode"
translatedBy: "claude"
translationDate: 2026-05-01
---
Mit .NET 8 wurden der Klasse `JsonNode` mehrere neue Methoden hinzugefügt, die beim tiefen Klonen von Knoten und beim Prüfen, ob sie gleich sind, helfen.

```cs
public partial class JsonNode
{
    public JsonNode DeepClone();

    public static bool DeepEquals(JsonNode? node1, JsonNode? node2);
}
```

Die Methode `DeepClone()` erstellt einen tiefen Klon des aktuellen Knotens samt aller Nachfahren und gibt diesen zurück.

`DeepEquals()` hingegen vergleicht die Property-Werte des Knotens und aller Nachfahren und gibt nur dann `true` zurück, wenn ihre JSON-Repräsentationen gleichwertig sind. Interessant zu wissen: `DeepEquals` ist weder eine Instanzmethode wie etwa `Object.Equals(...)`, noch eine Erweiterungsmethode. Sie können also nicht einfach `node1.DeepEquals(node2)` schreiben. Sie müssen die statische Methode immer explizit so aufrufen: `JsonNode.DeepEquals(node1, node2)`.
