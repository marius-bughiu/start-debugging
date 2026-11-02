---
title: "System.Text.Json desactivar la serialización basada en reflexión"
description: "Desactiva los valores predeterminados de reflexión en System.Text.Json, explica InvalidOperationException y serializa con un contexto generado en un ejemplo ejecutable de .NET 8."
pubDate: 2023-10-21
updatedDate: 2026-11-02
tags:
  - "dotnet"
  - "dotnet-8"
lang: "es"
translationOf: "2023/10/system-text-json-disable-reflection-based-serialization"
translatedBy: "claude"
translationDate: 2026-05-01
---
A partir de .NET 8, establece `JsonSerializerIsReflectionEnabledByDefault` en `false` para desactivar el mecanismo de reflexión predeterminado de `System.Text.Json`. Después proporciona los metadatos de serialización mediante un contexto generado a partir del código fuente.

> **Corrección — 2 de noviembre de 2026:** La versión anterior indicaba una excepción incorrecta y sugería que bastaba con pasar opciones. Con los valores predeterminados de reflexión desactivados, una llamada normal de serialización lanza `InvalidOperationException`; unas opciones vacías no lo solucionan.

## Desactivar los valores predeterminados de reflexión

Añade esta propiedad dentro del archivo `.csproj`:

```xml
<PropertyGroup>
  <JsonSerializerIsReflectionEnabledByDefault>false</JsonSerializerIsReflectionEnabledByDefault>
</PropertyGroup>
```

Con esta configuración fallan tanto `JsonSerializer.Serialize(widget)` como `JsonSerializer.Serialize(widget, new JsonSerializerOptions())`. Crear un objeto de opciones no aporta los metadatos del tipo. `JsonSerializer.IsReflectionEnabledByDefault` muestra el valor efectivo del interruptor.

Este interruptor controla la ruta de reflexión predeterminada del serializador; no desactiva toda la reflexión de la aplicación. Desde .NET 8, `PublishTrimmed` también desactiva estos valores predeterminados salvo que anules explícitamente la configuración. Consulta la [nota de compatibilidad de Microsoft sobre trimming](https://learn.microsoft.com/en-us/dotnet/core/compatibility/serialization/8.0/publishtrimmed).

## Serializar y deserializar con metadatos generados

Utiliza este `Program.cs` completo en un proyecto de consola .NET 8 con la propiedad anterior:

```cs
using System.Text.Json;
using System.Text.Json.Serialization;

Console.WriteLine(JsonSerializer.IsReflectionEnabledByDefault);
var widget = new Widget(42, "Ada");
string json = JsonSerializer.Serialize(widget, DemoJsonContext.Default.Widget);
Widget restored = JsonSerializer.Deserialize(json, DemoJsonContext.Default.Widget)!;
Console.WriteLine(json);
Console.WriteLine($"Round trip: {restored.Id} {restored.Name}");

public sealed record Widget(int Id, string Name);

[JsonSerializable(typeof(Widget))]
internal partial class DemoJsonContext : JsonSerializerContext { }
```

Salida:

```text
False
{"Id":42,"Name":"Ada"}
Round trip: 42 Ada
```

`[JsonSerializable]` registra `Widget` y el contexto proporciona directamente su `JsonTypeInfo<Widget>` generado. Estas sobrecargas no requieren otra instancia de opciones.

Si una API acepta `JsonSerializerOptions`, configura su resolver de forma explícita:

```cs
var options = new JsonSerializerOptions
{
    TypeInfoResolver = DemoJsonContext.Default
};
string json = JsonSerializer.Serialize(widget, options);
```

Registra los tipos raíz que realmente serializas, incluidas las colecciones cuando corresponda. Si tus modelos contienen enumeraciones, consulta [JsonStringEnumConverter con Native AOT](/es/2023/09/net-8-how-to-use-jsonstringenumconverter-with-native-aot/). Para reutilizar opciones congeladas, consulta [MakeReadOnly y el requisito del resolver](/es/2023/09/net-8-mark-jsonserializeroptions-as-readonly/).

## Ejecutar el ejemplo verificado

[Descarga el proyecto completo de opciones de System.Text.Json](/examples/system-text-json-options.zip), descomprímelo y ejecuta:

```sh
dotnet run -c Release
```

El proyecto sin dependencias adicionales usa .NET 8 y comprueba las llamadas predeterminadas que fallan, la serialización y deserialización generadas y la ruta con el resolver de opciones. También prueba las opciones de solo lectura. Todas las comprobaciones se ejecutaron sobre los runtimes reales .NET 8.0.33 y .NET 10.0.10; el archivo incluye los comandos por separado. El mismo proyecto también se publicó y ejecutó como Native AOT de .NET 8 en macOS arm64. Las comprobaciones de fallo intencionadas y las sobrecargas sensibles a la reflexión producen advertencias de análisis, documentadas en el registro.

Consulta la [guía de generación de código de Microsoft](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/source-generation) para los tipos compatibles y la integración en aplicaciones.
