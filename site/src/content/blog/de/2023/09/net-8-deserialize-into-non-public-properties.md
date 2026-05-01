---
title: ".NET 8 In nicht-öffentliche Properties deserialisieren"
description: "Erfahren Sie, wie Sie in .NET 8 mit dem Attribut JsonInclude und parameterisierten Konstruktoren JSON in nicht-öffentliche Properties deserialisieren."
pubDate: 2023-09-21
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "de"
translationOf: "2023/09/net-8-deserialize-into-non-public-properties"
translatedBy: "claude"
translationDate: 2026-05-01
---
Ähnlich wie beim [Serialisieren in nicht-öffentliche Member](/2023/09/net-8-include-non-public-members-in-json-serialization/) können Sie in nicht-öffentliche Member deserialisieren, indem Sie einen Konstruktor mit Parametern bereitstellen, deren Namen den nicht-öffentlichen Membern entsprechen, und die Member mit dem `JsonInclude`-Attribut versehen.

Springen wir direkt zu einem Beispiel:

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

Beachten Sie: `PublicProperty` haben wir nicht annotiert und auch nicht in den Konstruktor aufgenommen. Das ist nicht nötig, weil die Property öffentlich ist und einen öffentlichen Setter hat, sich also nach dem Erzeugen der Instanz zuweisen lässt.

Um die Deserialisierung in den oben definierten Typ auszuprobieren, können wir das tun:

```cs
string json = "{\"PrivateProperty\":1,\"ProtectedProperty\":2,\"InternalProperty\":3,\"PublicProperty\":4}";
var myObj = JsonSerializer.Deserialize<MyClass>(json);
```

## Mehrere Konstruktoren bei der Deserialisierung

Hat Ihre Klasse mehrere Konstruktoren, müssen Sie dem Deserializer mit dem [JsonConstructorAttribute](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonconstructorattribute.-ctor?view=net-8.0) den richtigen weisen.

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
