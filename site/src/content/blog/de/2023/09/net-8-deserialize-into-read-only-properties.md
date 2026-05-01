---
title: ".NET 8 In schreibgeschützte Properties deserialisieren"
description: "Erfahren Sie, wie Sie in .NET 8 mit JsonObjectCreationHandling oder JsonSerializerOptions JSON in schreibgeschützte Properties ohne Setter deserialisieren."
pubDate: 2023-09-03
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
lang: "de"
translationOf: "2023/09/net-8-deserialize-into-read-only-properties"
translatedBy: "claude"
translationDate: 2026-05-01
---
Ab .NET 8 können Sie in Properties deserialisieren, die keinen `set`-Accessor haben. Dieses Verhalten lässt sich entweder über die `JsonSerializerOptions` aktivieren oder pro Typ über das Attribut `JsonObjectCreationHandling`.

## Über das JsonObjectCreationHandling-Attribut

Versehen Sie Ihren Typ mit dem Attribut `System.Text.Json.Serialization.JsonObjectCreationHandling` und übergeben Sie Ihre Option als Parameter.

```cs
[JsonObjectCreationHandling(JsonObjectCreationHandling.Populate)]
public class Foo
{
     public int Bar { get; }
}
```

## Über JsonSerializerOptions

Setzen Sie die Eigenschaft `JsonSerializerOptions.PreferredObjectCreationHandling` auf `Populate` und übergeben Sie die Options an die `Deserialize`-Methode.

```cs
new JsonSerializerOptions 
{ 
    PreferredObjectCreationHandling = JsonObjectCreationHandling.Populate
};
```
