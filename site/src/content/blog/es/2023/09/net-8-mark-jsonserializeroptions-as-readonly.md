---
title: ".NET 8 marcar JsonSerializerOptions como readonly"
description: "Congela JsonSerializerOptions con MakeReadOnly, corrige el TypeInfoResolver ausente y crea una copia modificable en un ejemplo ejecutable de .NET 8."
pubDate: 2023-09-11
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "es"
translationOf: "2023/09/net-8-mark-jsonserializeroptions-as-readonly"
translatedBy: "claude"
translationDate: 2026-05-01
---
A partir de .NET 8, `JsonSerializerOptions.MakeReadOnly()` congela una instancia de opciones. Configura primero su `TypeInfoResolver`: un objeto de opciones nuevo no tiene resolver y llamar inmediatamente al método sin parámetros lanza `InvalidOperationException`.

> **Corrección — 2 de noviembre de 2026:** El ejemplo anterior omitía el resolver y fallaba en `MakeReadOnly()`. El siguiente usa metadatos generados y funciona también con los valores predeterminados de reflexión desactivados.

## Congelar opciones configuradas

Este `Program.cs` completo usa un resolver generado, serializa con las opciones congeladas, rechaza un cambio posterior y crea una copia configurable de forma independiente:

```cs
using System.Text.Json;
using System.Text.Json.Serialization;

var options = new JsonSerializerOptions
{
    TypeInfoResolver = DemoJsonContext.Default,
    PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseUpper
};
options.MakeReadOnly();
Console.WriteLine(options.IsReadOnly);
Console.WriteLine(JsonSerializer.Serialize(new Widget(42, "Ada"), options));

try
{
    options.WriteIndented = true;
}
catch (InvalidOperationException)
{
    Console.WriteLine("Mutation rejected");
}

var copy = new JsonSerializerOptions(options);
Console.WriteLine(copy.IsReadOnly);
copy.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
Console.WriteLine(JsonSerializer.Serialize(new Widget(42, "Ada"), copy));

public sealed record Widget(int Id, string Name);

[JsonSerializable(typeof(Widget))]
internal partial class DemoJsonContext : JsonSerializerContext { }
```

Salida:

```text
True
{"ID":42,"NAME":"Ada"}
Mutation rejected
False
{"id":42,"name":"Ada"}
```

`IsReadOnly` pasa a `true` tras congelar las opciones. Repetir `MakeReadOnly()` es válido. Cambiar después una propiedad lanza `InvalidOperationException`. La serialización o deserialización también convierte las opciones en solo lectura.

El constructor de copia conserva la configuración original, incluido el resolver, pero crea una instancia modificable. Configúrala antes del primer uso; al serializar con ella, también quedará congelada.

## ¿Por qué MakeReadOnly falla sin resolver?

`new JsonSerializerOptions().MakeReadOnly()` no elige un resolver automáticamente. Proporciona uno explícito, como arriba, o usa `MakeReadOnly(populateMissingResolver: true)` cuando pretendas usar serialización por reflexión y esta esté activada.

Esta sobrecarga rellena un resolver ausente con el predeterminado basado en reflexión. Si los valores predeterminados de reflexión están desactivados, no puede completar ese hueco y lanza `InvalidOperationException`. No sustituye los metadatos generados en aplicaciones trimmed o Native AOT. Consulta [cómo desactivar la reflexión predeterminada y configurar un contexto](/es/2023/10/system-text-json-disable-reflection-based-serialization/) y el [contrato de la API MakeReadOnly](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializeroptions.makereadonly?view=net-8.0).

## Ejecutar el ejemplo verificado

[Descarga el proyecto completo de opciones de System.Text.Json](/examples/system-text-json-options.zip), descomprímelo y ejecuta:

```sh
dotnet run -c Release
```

El proyecto .NET 8 sin dependencias adicionales comprueba resolvers ausentes, congelación repetida, modificaciones rechazadas, serialización generada y copias. También prueba `populateMissingResolver` por separado con los valores predeterminados de reflexión desactivados y activados. Todas las comprobaciones pasaron en los runtimes reales .NET 8.0.33 y .NET 10.0.10; los comandos y resultados constan en el registro de verificación del archivo.
