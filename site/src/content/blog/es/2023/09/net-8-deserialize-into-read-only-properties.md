---
title: ".NET 8 deserializar en propiedades de solo lectura"
description: "Aprende a deserializar JSON en propiedades de solo lectura sin setter en .NET 8 usando JsonObjectCreationHandling o JsonSerializerOptions."
pubDate: 2023-09-03
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
lang: "es"
translationOf: "2023/09/net-8-deserialize-into-read-only-properties"
translatedBy: "claude"
translationDate: 2026-05-01
---
A partir de .NET 8 puedes deserializar en propiedades que no tienen accesor `set`. Puedes activar este comportamiento mediante `JsonSerializerOptions` o por tipo, usando el atributo `JsonObjectCreationHandling`.

## Usando el atributo JsonObjectCreationHandling

Puedes anotar tu tipo con el atributo `System.Text.Json.Serialization.JsonObjectCreationHandling`, pasando tu opción como parámetro.

```cs
[JsonObjectCreationHandling(JsonObjectCreationHandling.Populate)]
public class Foo
{
     public int Bar { get; }
}
```

## Usando JsonSerializerOptions

Puedes establecer la propiedad `JsonSerializerOptions.PreferredObjectCreationHandling` en `Populate` y pasarla al método `Deserialize`.

```cs
new JsonSerializerOptions 
{ 
    PreferredObjectCreationHandling = JsonObjectCreationHandling.Populate
};
```
