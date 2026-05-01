---
title: ".NET 8 incluir miembros no públicos en la serialización JSON"
description: "Aprende a incluir propiedades private, protected e internal en la serialización JSON en .NET 8 usando el atributo JsonInclude."
pubDate: 2023-09-05
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "es"
translationOf: "2023/09/net-8-include-non-public-members-in-json-serialization"
translatedBy: "claude"
translationDate: 2026-05-01
---
A partir de .NET 8 puedes incluir propiedades no públicas en la serialización al usar `System.Text.Json`. Para ello, simplemente decora la propiedad no pública con el atributo [JsonIncludeAttribute](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonincludeattribute?view=net-8.0).

```cs
[System.AttributeUsage(System.AttributeTargets.Field | System.AttributeTargets.Property, AllowMultiple=false)]
public sealed class JsonIncludeAttribute : System.Text.Json.Serialization.JsonAttribute
```

El atributo funciona con cualquier modificador no público, como `private`, `protected` o `internal`. Veamos un ejemplo:

```cs
string json = JsonSerializer.Serialize(new MyClass(1, 2, 3));

Console.WriteLine(json);

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
}
```

Como cabría esperar, esto producirá la siguiente salida:

```json
{"PrivateProperty":1,"ProtectedProperty":2,"InternalProperty":3}
```
