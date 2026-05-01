---
title: "JsonNode のディープクローンとディープイコール"
description: ".NET 8 で追加された JsonNode の DeepClone() と DeepEquals() メソッドを使って、JSON ノードをディープクローンしたり比較したりする方法を解説します。"
pubDate: 2023-10-22
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
lang: "ja"
translationOf: "2023/10/deep-cloning-and-deep-equality-of-a-jsonnode"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 8 から、`JsonNode` クラスに、ノードのディープクローンや、ノード同士が等しいかどうかをチェックするのに役立つメソッドがいくつか追加されました。

```cs
public partial class JsonNode
{
    public JsonNode DeepClone();

    public static bool DeepEquals(JsonNode? node1, JsonNode? node2);
}
```

`DeepClone()` メソッドは、現在のノードとそのすべての子孫をディープクローンして返します。

一方、`DeepEquals()` はノードとそのすべての子孫のプロパティ値を比較し、それらの JSON 表現が同等のときのみ `true` を返します。ここで興味深い点は、`DeepEquals` は `Object.Equals(...)` のようなインスタンスメソッドでも、拡張メソッドでもないということです。そのため、`node1.DeepEquals(node2)` のようには書けません。常に `JsonNode.DeepEquals(node1, node2)` のように、静的メソッドを明示的に呼び出す必要があります。
