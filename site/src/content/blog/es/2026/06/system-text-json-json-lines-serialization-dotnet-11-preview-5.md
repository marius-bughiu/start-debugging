---
title: "System.Text.Json por fin escribe JSON Lines en .NET 11 Preview 5"
description: ".NET 11 Preview 5 agrega JsonSerializer.SerializeAsyncEnumerable con topLevelValues: true, para que System.Text.Json pueda transmitir JSONL, no solo leerlo."
pubDate: 2026-06-10
tags:
  - "dotnet-11"
  - "csharp"
  - "system-text-json"
  - "serialization"
lang: "es"
translationOf: "2026/06/system-text-json-json-lines-serialization-dotnet-11-preview-5"
translatedBy: "claude"
translationDate: 2026-06-10
---

Las [notas de la biblioteca de .NET 11 Preview 5](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/libraries.md) cierran una brecha que estaba abierta desde .NET 9: `System.Text.Json` ahora puede serializar JSON Lines, no solo deserializarlo. El lado de lectura llegó dos versiones atrás, el lado de escritura faltaba, y cualquiera que exportara JSONL tenía que escribir a mano un bucle que emitía un documento por línea. Preview 5 lo convierte en una sola llamada.

## Qué es realmente JSON Lines

JSON Lines (JSONL) no es un arreglo JSON. Es un valor JSON independiente por línea, separados por `\n`, sin corchetes envolventes y sin comas entre los registros:

```
{"Device":"kitchen","Celsius":21.4}
{"Device":"garage","Celsius":8.1}
```

Esa forma está en todas partes en cuanto empiezas a transmitir datos: archivos de registro estructurados, exportaciones grandes de bases de datos y los formatos de entrada/salida por lotes que usan los pipelines de entrenamiento y evaluación de LLM. La ventaja es que puedes anexar un registro sin reescribir el archivo, y puedes procesar el archivo línea por línea sin tener nunca todo en memoria. Un arreglo JSON de nivel superior no te da nada de eso, porque un analizador no puede saber que el arreglo es válido hasta que ve el `]` de cierre.

## El lado de escritura que faltaba

`System.Text.Json` aprendió a *leer* varios valores de nivel superior en .NET 9, cuando `DeserializeAsyncEnumerable` recibió un parámetro `topLevelValues`. Preview 5 agrega la sobrecarga simétrica en el serializador:

```csharp
record SensorReading(string Device, double Celsius, DateTimeOffset At);

async IAsyncEnumerable<SensorReading> GetReadings()
{
    yield return new("kitchen", 21.4, DateTimeOffset.UtcNow);
    yield return new("garage", 8.1, DateTimeOffset.UtcNow);
}

await using var stream = File.Create("readings.jsonl");
await JsonSerializer.SerializeAsyncEnumerable(
    stream,
    GetReadings(),
    topLevelValues: true);
```

Con `topLevelValues: true` obtienes JSONL: cada elemento escrito como su propio documento raíz en su propia línea. Déjalo en el valor predeterminado `false` y obtienes el comportamiento anterior, un único arreglo JSON. Las nuevas sobrecargas aceptan tanto un `Stream` como un `PipeWriter`, y toman ya sea `JsonSerializerOptions` o un `JsonTypeInfo<TValue>` generado por código fuente para una serialización compatible con AOT y sin reflexión.

## Un ciclo completo limpio

Como el lado de lectura ya existe, las dos mitades ahora encajan:

```csharp
await using var input = File.OpenRead("readings.jsonl");

await foreach (var reading in JsonSerializer.DeserializeAsyncEnumerable<SensorReading>(
    input,
    topLevelValues: true))
{
    Console.WriteLine($"{reading.Device}: {reading.Celsius} C");
}
```

Observa que `GetReadings` es un `IAsyncEnumerable<T>`, así que el serializador extrae los registros a medida que los escribe. Puedes transmitir directamente desde un cursor de base de datos o una respuesta HTTP hacia un archivo JSONL sin materializar primero una `List<T>`. Ese es el objetivo completo: memoria constante sin importar cuántos registros envíes.

Esto sigue siendo una versión preliminar, así que las firmas exactas pueden cambiar antes del lanzamiento de noviembre. Pero la forma de la API refleja el lado de lectura lo suficiente como para que sea seguro empezar a diseñar en torno a ella. Si has estado pegando `Utf8JsonWriter` con saltos de línea manuales para emitir JSONL, esta es la llamada que reemplaza todo eso.
