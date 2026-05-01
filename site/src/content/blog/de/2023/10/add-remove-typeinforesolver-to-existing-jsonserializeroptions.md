---
title: "TypeInfoResolver zu bestehenden JsonSerializerOptions hinzufügen/entfernen"
description: "Erfahren Sie, wie Sie TypeInfoResolver-Instanzen mit der neuen TypeInfoResolverChain-Eigenschaft in .NET 8 zu bestehenden JsonSerializerOptions hinzufügen oder daraus entfernen."
pubDate: 2023-10-19
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "de"
translationOf: "2023/10/add-remove-typeinforesolver-to-existing-jsonserializeroptions"
translatedBy: "claude"
translationDate: 2026-05-01
---
Ab .NET 8 verfügt die Klasse `JsonSerializerOptions` zusätzlich zur bestehenden Eigenschaft `TypeInfoResolver` über eine neue Eigenschaft `TypeInfoResolverChain`. Mit dieser neuen Eigenschaft müssen Sie nicht mehr alle Resolver an derselben Stelle angeben. Stattdessen können Sie sie nach Bedarf später hinzufügen.

Sehen wir uns ein Beispiel an:

```cs
var options = new JsonSerializerOptions
{
    TypeInfoResolver = JsonTypeInfoResolver.Combine(
        new ResolverA(), 
        new ResolverB()
    );
};

options.TypeInfoResolverChain.Add(new ResolverC());
```

Neben dem Hinzufügen neuer Type Resolver zu bestehenden `JsonSerializerOptions` lässt sich mit `TypeInfoResolverChain` auch ein Type Info Resolver wieder entfernen.

```cs
options.TypeInfoResolverChain.RemoveAt(0);
```

Wenn Sie Änderungen an der Type-Info-Resolver-Kette verhindern möchten, geht das, indem Sie [die `JsonSerializerOptions`-Instanz als readonly markieren](/2023/09/net-8-mark-jsonserializeroptions-as-readonly/). Dazu rufen Sie die Methode `MakeReadOnly()` auf der Options-Instanz auf. Danach erzwingt jeder spätere Versuch, die Kette zu verändern, die folgende `InvalidOperationException`.

```plaintext
Unhandled exception. System.InvalidOperationException: This JsonSerializerOptions instance is read-only or has already been used in serialization or deserialization.
   at System.Text.Json.ThrowHelper.ThrowInvalidOperationException_SerializerOptionsReadOnly(JsonSerializerContext context)
   at System.Text.Json.JsonSerializerOptions.VerifyMutable()
   at System.Text.Json.JsonSerializerOptions.OptionsBoundJsonTypeInfoResolverChain.OnCollectionModifying()
   at System.Text.Json.Serialization.ConfigurationList`1.Add(TItem item)
```
