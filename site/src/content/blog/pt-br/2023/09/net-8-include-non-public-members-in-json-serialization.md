---
title: ".NET 8 incluindo membros não públicos na serialização JSON"
description: "Aprenda a incluir propriedades private, protected e internal na serialização JSON no .NET 8 usando o atributo JsonInclude."
pubDate: 2023-09-05
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "pt-br"
translationOf: "2023/09/net-8-include-non-public-members-in-json-serialization"
translatedBy: "claude"
translationDate: 2026-05-01
---
A partir do .NET 8, você pode incluir propriedades não públicas na serialização quando usa `System.Text.Json`. Para isso, basta decorar a propriedade não pública com o atributo [JsonIncludeAttribute](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonincludeattribute?view=net-8.0).

```cs
[System.AttributeUsage(System.AttributeTargets.Field | System.AttributeTargets.Property, AllowMultiple=false)]
public sealed class JsonIncludeAttribute : System.Text.Json.Serialization.JsonAttribute
```

O atributo funciona com qualquer modificador não público, como `private`, `protected` ou `internal`. Veja um exemplo:

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

Como esperado, isso produz a seguinte saída:

```json
{"PrivateProperty":1,"ProtectedProperty":2,"InternalProperty":3}
```
