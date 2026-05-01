---
title: "System.Text.Json Wie Sie einen bestehenden Type Info Resolver anpassen"
description: "Verwenden Sie die neue WithAddedModifier-Erweiterungsmethode in .NET 8, um beliebige IJsonTypeInfoResolver-Serialisierungsverträge einfach anzupassen, ohne einen Resolver komplett neu zu schreiben."
pubDate: 2023-10-25
updatedDate: 2023-11-01
tags:
  - "dotnet"
  - "dotnet-8"
lang: "de"
translationOf: "2023/10/system-text-json-how-to-modify-existing-type-info-resolver"
translatedBy: "claude"
translationDate: 2026-05-01
---
Es gibt Situationen, in denen ein komplett neuer `IJsonTypeInfoResolver` übertrieben wirkt, etwa wenn der Standard-Resolver (oder ein anderer bereits definierter) den Job mit nur ein oder zwei kleinen Anpassungen erledigen könnte.

Bisher konnten Sie für den Standard-Resolver an der Eigenschaft `DefaultJsonTypeInfoResolver.Modifiers` ansetzen, hatten aber für selbst definierte oder aus Paketen stammende Type Info Resolver nichts Eingebautes zur Hand.

Genau für diese Fälle gibt es seit .NET 8 eine neue Erweiterungsmethode, die es einfach macht, Änderungen an beliebigen `IJsonTypeInfoResolver`-Serialisierungsverträgen einzubringen. Sie lässt sich natürlich auch zusammen mit dem Standard-Type-Info-Resolver verwenden.

```cs
public static IJsonTypeInfoResolver WithAddedModifier(
    this IJsonTypeInfoResolver resolver, 
    Action<JsonTypeInfo> modifier)
```

Damit wird für Sie eine Instanz von `JsonTypeInfoResolverWithAddedModifiers` erzeugt (ein `IJsonTypeInfoResolver`), die Ihre Schema-Anpassungen verarbeiten kann.

Sehen wir uns ein einfaches Anwendungsbeispiel an, ausgehend von einem beliebigen `MyTypeInfoResolver`:

```cs
var options = new JsonSerializerOptions
{
    TypeInfoResolver = new MyTypeInfoResolver()
        .WithAddedModifier(typeInfo =>
        {
            foreach (JsonPropertyInfo prop in typeInfo.Properties)
                prop.Name = prop.Name.ToLower();
        })
};
```
