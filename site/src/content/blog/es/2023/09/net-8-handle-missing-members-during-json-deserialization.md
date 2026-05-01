---
title: ".NET 8 manejar miembros no esperados al deserializar JSON"
description: "Aprende a lanzar excepciones por propiedades JSON sin mapear durante la deserialización en .NET 8 usando JsonUnmappedMemberHandling."
pubDate: 2023-09-02
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
lang: "es"
translationOf: "2023/09/net-8-handle-missing-members-during-json-deserialization"
translatedBy: "claude"
translationDate: 2026-05-01
---
Por defecto, si en un payload JSON que intentas deserializar hay propiedades adicionales, simplemente se ignoran. Pero, ¿y si quisieras que la deserialización fallase y lanzase una excepción cuando hay propiedades extra en el JSON? Eso es posible a partir de .NET 8.

Hay varias formas de optar por este comportamiento cuando usas el serializador `System.Text.Json`.

## 1\. Usando el atributo JsonUnmappedMemberHandling

Puedes anotar tu tipo con `[System.Text.Json.Serialization.JsonUnmappedMemberHandlingAttribute]`, pasando tu opción como parámetro.

```cs
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public class Foo
{
     public int Bar { get; set; }
}
```

## 2\. Usando JsonSerializerOptions

Puedes establecer la propiedad `JsonSerializerOptions.UnmappedMemberHandling` a `Disallow` y pasarla al método `Deserialize`.

```cs
new JsonSerializerOptions 
{ 
    UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow 
};
```

## Se lanza una excepción

Prepárate para atraparla. Con `JsonUnmappedMemberHandling` puesto a `Disallow`, se lanzará la siguiente excepción al deserializar un payload JSON con miembros adicionales.

> **System.Text.Json.JsonException**: 'The JSON property '<property name>' could not be mapped to any .NET member contained in type '<namespace>+<type name>'.'
