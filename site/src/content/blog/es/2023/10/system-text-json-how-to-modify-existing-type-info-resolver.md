---
title: "System.Text.Json Cómo modificar un type info resolver existente"
description: "Usa el nuevo método de extensión WithAddedModifier en .NET 8 para modificar fácilmente cualquier contrato de serialización IJsonTypeInfoResolver sin crear un resolver nuevo desde cero."
pubDate: 2023-10-25
updatedDate: 2023-11-01
tags:
  - "dotnet"
  - "dotnet-8"
lang: "es"
translationOf: "2023/10/system-text-json-how-to-modify-existing-type-info-resolver"
translatedBy: "claude"
translationDate: 2026-05-01
---
Hay situaciones en las que crear un `IJsonTypeInfoResolver` completamente nuevo parece exagerado, cuando el resolver por defecto (o cualquier otro ya definido) podría hacer el trabajo con solo una o dos pequeñas modificaciones.

Hasta ahora, podías jugar con la propiedad `DefaultJsonTypeInfoResolver.Modifiers` para el type info resolver por defecto, pero no tenías nada integrado para los type info resolvers definidos por el desarrollador o los que vienen de paquetes.

Para estos casos en particular, a partir de .NET 8, tenemos un nuevo método de extensión que nos permite introducir fácilmente modificaciones en contratos de serialización `IJsonTypeInfoResolver` arbitrarios. El método de extensión se puede usar, por supuesto, también junto con el type info resolver por defecto.

```cs
public static IJsonTypeInfoResolver WithAddedModifier(
    this IJsonTypeInfoResolver resolver, 
    Action<JsonTypeInfo> modifier)
```

Esto te creará una instancia de `JsonTypeInfoResolverWithAddedModifiers` (un `IJsonTypeInfoResolver`) capaz de manejar tus modificaciones de esquema.

Veamos un ejemplo de uso sencillo, asumiendo un `MyTypeInfoResolver` cualquiera:

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
