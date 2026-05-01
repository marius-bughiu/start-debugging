---
title: ".NET 8 Unbekannte Member bei der JSON-Deserialisierung behandeln"
description: "Erfahren Sie, wie Sie in .NET 8 mit JsonUnmappedMemberHandling Exceptions für nicht zugeordnete JSON-Properties bei der Deserialisierung werfen lassen."
pubDate: 2023-09-02
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
lang: "de"
translationOf: "2023/09/net-8-handle-missing-members-during-json-deserialization"
translatedBy: "claude"
translationDate: 2026-05-01
---
Standardmäßig werden zusätzliche Properties in einem zu deserialisierenden JSON-Payload einfach ignoriert. Was aber, wenn die Deserialisierung bei zusätzlichen Properties fehlschlagen und eine Exception werfen soll? Das ist ab .NET 8 möglich.

Es gibt mehrere Wege, dieses Verhalten beim `System.Text.Json`-Serializer zu aktivieren.

## 1\. Über das Attribut JsonUnmappedMemberHandling

Versehen Sie Ihren Typ mit `[System.Text.Json.Serialization.JsonUnmappedMemberHandlingAttribute]` und übergeben Sie Ihre Option als Parameter.

```cs
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public class Foo
{
     public int Bar { get; set; }
}
```

## 2\. Über JsonSerializerOptions

Setzen Sie die Eigenschaft `JsonSerializerOptions.UnmappedMemberHandling` auf `Disallow` und übergeben Sie die Options an die `Deserialize`-Methode.

```cs
new JsonSerializerOptions 
{ 
    UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow 
};
```

## Eine Exception wird geworfen

Seien Sie bereit, sie abzufangen. Mit `JsonUnmappedMemberHandling` auf `Disallow` wird beim Deserialisieren eines JSON-Payloads mit zusätzlichen Membern die folgende Exception geworfen.

> **System.Text.Json.JsonException**: 'The JSON property '<property name>' could not be mapped to any .NET member contained in type '<namespace>+<type name>'.'
