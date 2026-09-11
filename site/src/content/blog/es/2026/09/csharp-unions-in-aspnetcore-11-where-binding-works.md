---
title: "Uniones de C# en ASP.NET Core 11: los cuerpos, SignalR y OpenAPI funcionan, las query strings no"
description: "El equipo de ASP.NET Core trazó dónde fluyen los tipos union de C# 15 en .NET 11: cuerpos de minimal APIs y MVC, el JsonHubProtocol de SignalR, Blazor y esquemas anyOf de OpenAPI. El binding de ruta, query, headers y formularios todavía no está soportado."
pubDate: 2026-09-11
tags:
  - "csharp"
  - "csharp-15"
  - "dotnet-11"
  - "aspnetcore"
  - "openapi"
  - "signalr"
lang: "es"
translationOf: "2026/09/csharp-unions-in-aspnetcore-11-where-binding-works"
translatedBy: "claude"
translationDate: 2026-09-11
---

El 10 de septiembre, un día después de que saliera .NET 11 RC 1, el equipo de ASP.NET Core publicó [Use C# unions and closed hierarchies in ASP.NET Core](https://devblogs.microsoft.com/dotnet/unions-and-closed-hierarchies-in-aspnetcore/). Es el primer mapa completo de dónde funcionan realmente los tipos `union` de C# 15 en todo el stack web, y la respuesta es simple: todo lo que pasa por System.Text.Json funciona, y todo lo demás no.

## Uniones como cuerpos de solicitud y tipos de retorno

Como las uniones se serializan como su caso activo, sin envoltorio ni discriminador (el comportamiento que llegó en [System.Text.Json en .NET 11 Preview 6](/es/2026/07/serialize-csharp-union-types-with-system-text-json-dotnet-11-preview-6/)), una minimal API puede aceptarlas y devolverlas directamente:

```csharp
public record Cat(string Name, string Coat);
public record Dog(string Name, string Breed);

[JsonUnion(TypeClassifier = typeof(JsonUnionTypeStructuralClassifier))]
public union UnionPet(Cat, Dog);

public union UnionIntString(int, string);

app.MapPost("/pet", ([FromBody] UnionPet pet) => TypedResults.Ok(pet));
app.MapGet("/value", () => new UnionIntString(42));
```

`UnionPet` necesita el clasificador estructural porque ambos casos son objetos JSON: STJ tiene que mirar los nombres de las propiedades (`coat` vs `breed`) para elegir un caso antes de deserializar. Ese escaneo cuesta trabajo extra en cada solicitud, y renombrar una propiedad puede cambiar en silencio qué caso gana, así que trata esos nombres de propiedades como parte de tu contrato.

Los controladores MVC obtienen el mismo comportamiento a través de los formatters de entrada y salida de STJ, así que un parámetro de acción `[FromBody] UnionBoolString` o un tipo de retorno union funcionan sin configuración adicional.

## OpenAPI emite anyOf

El generador de OpenAPI integrado en .NET 11 describe una union como `anyOf` con una entrada por caso:

```json
"UnionIntString": {
  "anyOf": [
    { "type": "integer", "format": "int32" },
    { "type": "string" }
  ]
}
```

Esa es la forma que necesitan los generadores de clientes para contratos como `maxUnavailable` de Kubernetes, que acepta tanto `2` como `"25%"`. Antes de las uniones, esto se modelaba con un `JsonConverter` personalizado y un transformador de esquema escrito a mano.

## SignalR y Blazor

El `JsonHubProtocol` de SignalR soporta uniones como parámetros de métodos del hub, valores de retorno y elementos de stream `IAsyncEnumerable<T>`. Los protocolos de hub MessagePack y Newtonsoft.Json no. Blazor maneja uniones en parámetros de componentes (en proceso, sin serialización), en la interoperabilidad con JS y en el estado persistido de componentes mediante `PersistAsJson` / `TryTakeFromJson`.

## Dónde se detiene el binding

Los valores de ruta, las query strings, los headers y los campos de formulario no pasan por STJ, así que las uniones no están soportadas ahí. El razonamiento del blog es que un token de texto plano no ofrece una forma confiable de elegir un caso. `[SupplyParameterFromQuery]` de Blazor queda excluido por la misma razón. La discusión de diseño está abierta en [dotnet/aspnetcore#66648](https://github.com/dotnet/aspnetcore/issues/66648).

Hasta que eso llegue, haz binding del string crudo y construye la union tú mismo:

```csharp
app.MapGet("/rollout", (string maxUnavailable) =>
    int.TryParse(maxUnavailable, out var count)
        ? new UnionIntString(count)
        : new UnionIntString(maxUnavailable));
```

Hay una trampa más del lado del cuerpo. `JsonSerializerOptions.Web` permite leer números desde strings, así que cuando `UnionIntString` es un cuerpo de solicitud, el token JSON `"42"` coincide tanto con `int` como con `string`. Devolver esa union está bien, pero aceptarla como entrada requiere un clasificador personalizado. SignalR no tiene este problema porque `JsonHubProtocol` no trata un token de texto como un posible número.

## Uniones o jerarquías cerradas

El post también cubre las jerarquías de clases `closed` con `[JsonPolymorphic(InferClosedTypePolymorphism = true)]`, que producen un discriminador `$type` sin listar cada `[JsonDerivedType]`. La guía es útil: elige una union cuando el contrato JSON debe quedar libre de discriminador o los casos son primitivos y tipos que no controlas, y elige una jerarquía cerrada cuando estás diseñando una API nueva cuyos casos comparten un tipo base. Si ya estás en .NET 11 RC 1, ambas están listas para probar en cuerpos y respuestas. Por ahora, mantenlas fuera de tus plantillas de ruta.
