---
title: "Añadir/quitar TypeInfoResolver de un JsonSerializerOptions existente"
description: "Aprende a añadir o quitar instancias de TypeInfoResolver en un JsonSerializerOptions existente usando la nueva propiedad TypeInfoResolverChain en .NET 8."
pubDate: 2023-10-19
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "es"
translationOf: "2023/10/add-remove-typeinforesolver-to-existing-jsonserializeroptions"
translatedBy: "claude"
translationDate: 2026-05-01
---
A partir de .NET 8, la clase `JsonSerializerOptions` incorpora una nueva propiedad `TypeInfoResolverChain` además de la ya existente `TypeInfoResolver`. Con esta nueva propiedad ya no estás obligado a especificar todos los resolvers en el mismo sitio. En su lugar, puedes añadirlos después según los vayas necesitando.

Veamos un ejemplo:

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

Además de añadir nuevos type resolvers a un `JsonSerializerOptions` existente, `TypeInfoResolverChain` también te permite eliminar type info resolvers de las opciones del serializador.

```cs
options.TypeInfoResolverChain.RemoveAt(0);
```

Si quieres impedir cambios en la cadena de type info resolver, puedes hacerlo [marcando la instancia de `JsonSerializerOptions` como readonly](/2023/09/net-8-mark-jsonserializeroptions-as-readonly/). Esto se hace llamando al método `MakeReadOnly()` sobre la instancia de opciones y forzará la siguiente `InvalidOperationException` si alguien intenta modificar la cadena de type info resolver más adelante.

```plaintext
Unhandled exception. System.InvalidOperationException: This JsonSerializerOptions instance is read-only or has already been used in serialization or deserialization.
   at System.Text.Json.ThrowHelper.ThrowInvalidOperationException_SerializerOptionsReadOnly(JsonSerializerContext context)
   at System.Text.Json.JsonSerializerOptions.VerifyMutable()
   at System.Text.Json.JsonSerializerOptions.OptionsBoundJsonTypeInfoResolverChain.OnCollectionModifying()
   at System.Text.Json.Serialization.ConfigurationList`1.Add(TItem item)
```
