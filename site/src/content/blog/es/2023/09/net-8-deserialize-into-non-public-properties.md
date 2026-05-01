---
title: ".NET 8 deserializar en propiedades no públicas"
description: "Aprende a deserializar JSON en propiedades no públicas en .NET 8 usando el atributo JsonInclude y constructores parametrizados."
pubDate: 2023-09-21
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "es"
translationOf: "2023/09/net-8-deserialize-into-non-public-properties"
translatedBy: "claude"
translationDate: 2026-05-01
---
De forma similar a [serializar a miembros no públicos](/2023/09/net-8-include-non-public-members-in-json-serialization/), puedes deserializar en miembros no públicos proporcionando un constructor con parámetros que coincidan con los nombres de los miembros no públicos y anotando dichos miembros con el atributo `JsonInclude`.

Vayamos directamente a un ejemplo:

```cs
public class MyClass
{
    public MyClass(int privateProperty, int protectedProperty, int internalProperty)
    {
        PrivateProperty = privateProperty;
        ProtectedProperty = protectedProperty;
        InternalProperty = internalProperty;
    }

    [JsonInclude]
    private int PrivateProperty { get; }

    [JsonInclude]
    protected int ProtectedProperty { get; }

    [JsonInclude]
    internal int InternalProperty { get; }

    public int PublicProperty { get; set; }
}
```

Fíjate en que no hemos anotado `PublicProperty` de ninguna forma y tampoco la hemos incluido en el constructor. No es necesario, porque la propiedad es pública y tiene un setter público, así que se puede asignar después de crear la instancia del objeto.

Para probar la deserialización en el tipo definido arriba, podemos hacer esto:

```cs
string json = "{\"PrivateProperty\":1,\"ProtectedProperty\":2,\"InternalProperty\":3,\"PublicProperty\":4}";
var myObj = JsonSerializer.Deserialize<MyClass>(json);
```

## Manejar múltiples constructores durante la deserialización

En caso de que tu clase tenga varios constructores, tendrás que guiar al deserializador hacia el correcto usando [JsonConstructorAttribute](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonconstructorattribute.-ctor?view=net-8.0).

```cs
public MyClass() { }

[JsonConstructor]
public MyClass(int privateProperty, int protectedProperty, int internalProperty)
{
    PrivateProperty = privateProperty;
    ProtectedProperty = protectedProperty;
    InternalProperty = internalProperty;
}
```
