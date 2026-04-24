---
title: "System.Text.Json en .NET 11 Preview 3 añade PascalCase y políticas de naming por miembro"
description: ".NET 11 Preview 3 termina la historia de políticas de naming en System.Text.Json: JsonNamingPolicy.PascalCase, un atributo [JsonNamingPolicy] a nivel de miembro, y un [JsonIgnore] por defecto a nivel de tipo para DTOs más limpios."
pubDate: 2026-04-18
tags:
  - ".NET 11"
  - "System.Text.Json"
  - "C#"
  - "Serialization"
lang: "es"
translationOf: "2026/04/system-text-json-11-pascalcase-per-member-naming"
translatedBy: "claude"
translationDate: 2026-04-24
---

[.NET 8 introdujo](https://startdebugging.net/2023/08/net-8-json-serialize-property-names-using-snake-case-and-kebab-case/) el primer lote de políticas de naming integradas para `System.Text.Json`: camel, snake y kebab en ambos casings. Preview 3 de .NET 11 cierra el último hueco obvio y añade dos perillas más que hacen innecesarios los `JsonConverter` artesanales para la mayoría de formas de DTO. El trabajo se entregó vía [dotnet/runtime #124644](https://github.com/dotnet/runtime/pull/124644), [#124645](https://github.com/dotnet/runtime/pull/124645), y [#124646](https://github.com/dotnet/runtime/pull/124646).

## PascalCase se une a las políticas integradas

`JsonNamingPolicy.PascalCase` es nuevo en Preview 3 y se sienta junto a los existentes `CamelCase`, `SnakeCaseLower`, `SnakeCaseUpper`, `KebabCaseLower` y `KebabCaseUpper`. Es la política que quieres cuando el lado .NET ya usa propiedades PascalCase y el contrato JSON también es PascalCase, algo común para APIs de Azure Management, gateways antiguos de SOAP a REST, y algunas formas de Microsoft Graph:

```csharp
using System.Text.Json;

var options = new JsonSerializerOptions
{
    PropertyNamingPolicy = JsonNamingPolicy.PascalCase
};

var json = JsonSerializer.Serialize(
    new { firstName = "Ada", age = 37 },
    options);
// {"FirstName":"Ada","Age":37}
```

Antes de Preview 3 o dejabas el default (sin política) o escribías una subclase custom de `JsonNamingPolicy` de una línea. Ahora encaja con los otros presets y hace round-trip limpio con el enum `JsonKnownNamingPolicy` existente.

## Sobrescribiendo el naming en un solo miembro

El cambio más interesante es que `[JsonNamingPolicy]` ahora es un atributo a nivel de miembro. Antes la política vivía en `JsonSerializerOptions` y aplicaba a todo el grafo, así que una excepción PascalCase en un contrato por lo demás camelCase significaba o un override `[JsonPropertyName]` en cada propiedad torpe o una política completamente custom. En .NET 11 Preview 3 puedes mezclar políticas dentro del mismo tipo:

```csharp
using System.Text.Json.Serialization;

public sealed class Webhook
{
    public string Url { get; set; } = "";

    [JsonNamingPolicy(JsonKnownNamingPolicy.KebabCaseLower)]
    public string RetryStrategy { get; set; } = "exponential";

    [JsonNamingPolicy(JsonKnownNamingPolicy.SnakeCaseLower)]
    public int MaxAttempts { get; set; } = 5;
}
```

Con `PropertyNamingPolicy = JsonNamingPolicy.CamelCase`, `Url` serializa a `url`, `RetryStrategy` a `retry-strategy`, y `MaxAttempts` a `max_attempts`. Eso quita mucho ruido de `[JsonPropertyName]` por propiedad cuando un único sistema externo es inconsistente.

## Defaults de [JsonIgnore] a nivel de tipo

El cambio acompañante es que `[JsonIgnore(Condition = ...)]` ahora es legal sobre el tipo mismo, no solo sobre propiedades ([dotnet/runtime #124646](https://github.com/dotnet/runtime/pull/124646)). Ponlo sobre la clase y la condición se convierte en el default para cada propiedad dentro del tipo:

```csharp
using System.Text.Json.Serialization;

[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
public sealed class PatchRequest
{
    public string? Name { get; set; }
    public string? Email { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public bool? IsActive { get; set; }
}
```

Cada propiedad nullable en `PatchRequest` ahora cae del payload cuando es null, que es exactamente lo que una forma de request de JSON Merge Patch quiere. El override de `IsActive` opta de vuelta porque un `false` explícito tiene significado ahí. El mismo patrón solía requerir `JsonIgnoreCondition.WhenWritingNull` en cada propiedad individualmente o `DefaultIgnoreCondition` en las opciones del serializer, que luego forzaba a cada otro DTO por la misma regla.

## Por qué importa la superficie pequeña

El control a nivel de atributo es lo que permite a los equipos reemplazar converters custom con `System.Text.Json` de stock. PascalCase remueve la última razón de "escribe tu propia política", naming por miembro borra una clase de boilerplate de `[JsonPropertyName]`, y `[JsonIgnore]` a nivel de tipo permite a los DTOs de PATCH y de eventos configurar su default en un solo lugar. Los tres cambios también funcionan con el source generator, así que las apps Native AOT los reciben sin configuración extra. Las [notas de librerías de Preview 3](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/libraries.md) rastrean el resto de las actualizaciones de `System.Text.Json` que se entregan este mes.
