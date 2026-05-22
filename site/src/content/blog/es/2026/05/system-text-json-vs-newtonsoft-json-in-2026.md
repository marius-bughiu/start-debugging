---
title: "System.Text.Json vs Newtonsoft.Json en 2026: ¿cuál deberías elegir?"
description: "Elige System.Text.Json para código nuevo en .NET 11: viene integrado, es aproximadamente 2 veces más rápido y es el único que funciona con Native AOT. Recurre a Newtonsoft.Json solo para JSONPath, TypeNameHandling o JSON realmente permisivo."
pubDate: 2026-05-22
tags:
  - "comparison"
  - "system-text-json"
  - "newtonsoft-json"
  - "dotnet"
  - "dotnet-11"
lang: "es"
translationOf: "2026/05/system-text-json-vs-newtonsoft-json-in-2026"
translatedBy: "claude"
translationDate: 2026-05-22
---

Si estás empezando código nuevo en .NET 11 en 2026, usa **System.Text.Json**. Viene integrado con el runtime, serializa aproximadamente al doble de velocidad con una fracción de las asignaciones de memoria y es el único de los dos que se ejecuta bajo Native AOT. Recurre a **Newtonsoft.Json** solo cuando dependas de una característica que System.Text.Json todavía no tiene: consultas JSONPath, incrustación de tipos al estilo `TypeNameHandling`, o el análisis de JSON realmente malformado (comillas simples, claves sin comillas). Ambas bibliotecas siguen vivas en 2026, pero ya no son equivalentes para trabajo nuevo.

Cada ejemplo aquí apunta a `<TargetFramework>net11.0</TargetFramework>` con el SDK de .NET 11 y C# 14. System.Text.Json es la versión integrada que viene con .NET 11. Newtonsoft.Json se refiere a la versión 13.0.4, publicada el 2025-12-30, la estable actual en NuGet.

## La matriz de características de un vistazo

Esta es la tabla que viniste a buscar. Es la versión práctica de la [guía oficial de migración de Microsoft](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/migrate-from-newtonsoft), reducida a las decisiones que de verdad cambian a qué paquete haces referencia.

| Aspecto | System.Text.Json (.NET 11) | Newtonsoft.Json 13.0.4 |
| ------- | -------------------------- | ---------------------- |
| Viene integrado | Sí, parte del runtime | No, paquete de NuGet |
| Rendimiento (serializar) | Base, el más rápido | ~2x más lento |
| Asignaciones de memoria | Basadas en Span, bajas | Más altas |
| Native AOT / trimming | Sí, vía generador de código fuente | No |
| Permisividad por defecto | Estricta (RFC 8259) | Permisiva |
| Comentarios / comas finales | Opcional | Activado por defecto |
| Coincidencia sin distinción de mayúsculas | Opcional (activado en ASP.NET Core) | Activado por defecto |
| (De)serialización polimórfica | Sí, desde .NET 7 (`[JsonDerivedType]`) | Sí (`TypeNameHandling`) |
| `TypeNameHandling.All` (incrustar tipo CLR) | No, por diseño | Sí |
| JSONPath / `SelectToken` | No | Sí |
| DOM LINQ-to-JSON | `JsonNode` / `JsonDocument` | `JObject` / `JArray` |
| `DataTable`, `ExpandoObject`, `BigInteger` | Requiere convertidor personalizado | Integrado |
| Comillas simples, claves sin comillas | Rechazadas, por diseño | Aceptadas |
| Estado de mantenimiento | Desarrollo activo | Modo de mantenimiento |
| Licencia | MIT | MIT |

El titular es que las filas donde Newtonsoft.Json todavía gana son estrechas y específicas, mientras que las filas donde gana System.Text.Json (integrado, AOT, velocidad) se aplican a casi cualquier proyecto nuevo.

## Cuándo elegir System.Text.Json

Elígelo como opción por defecto para cualquier cosa nueva en .NET 11. En concreto:

- **APIs de ASP.NET Core.** El framework ya usa System.Text.Json internamente y configura por ti los valores por defecto amigables para la web: nombres de propiedad en camelCase, coincidencia sin distinción de mayúsculas y soporte de números entre comillas. Agregar `Microsoft.AspNetCore.Mvc.NewtonsoftJson` para recuperar el comportamiento antiguo es un paso atrás a menos que una característica específica te obligue.
- **Cualquier cosa que se ejecute bajo Native AOT o trimming agresivo.** Esto no es una preferencia, es un requisito estricto. System.Text.Json tiene un [generador de código fuente](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) que emite los metadatos de serialización en tiempo de compilación, así que no se necesita reflexión en tiempo de ejecución. Newtonsoft.Json se construye sobre reflexión en tiempo de ejecución y `Reflection.Emit`, que AOT no permite. Si te interesan las concesiones ahí, consulta el desglose de [Native AOT vs ReadyToRun vs JIT](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/).
- **Rutas de alto rendimiento o sensibles a la memoria.** Serializadores, agentes de envío de logs, consumidores de buses de mensajes, cualquier cosa que se ejecute en un bucle ajustado. System.Text.Json trabaja sobre `ReadOnlySpan<byte>` y UTF-8 directamente, evitando las asignaciones de cadenas intermedias que hace Newtonsoft.Json.
- **Quieres una salida determinista y conforme a la especificación.** System.Text.Json sigue RFC 8259 de forma estricta. Escapa los caracteres sensibles para HTML por defecto como medida de defensa en profundidad contra XSS y divulgación de información, lo que importa cuando el JSON se incrusta en una página.

Un contexto generado por código fuente es el patrón que desbloquea AOT y el arranque más rápido:

```csharp
// .NET 11, C# 14 - compile-time metadata, no runtime reflection
using System.Text.Json;
using System.Text.Json.Serialization;

[JsonSerializable(typeof(WeatherForecast))]
public partial class AppJsonContext : JsonSerializerContext;

var forecast = new WeatherForecast(DateOnly.FromDateTime(DateTime.Now), 22, "Mild");

// Pass the generated TypeInfo, not the raw type, to stay reflection-free
string json = JsonSerializer.Serialize(forecast, AppJsonContext.Default.WeatherForecast);

public record WeatherForecast(DateOnly Date, int TemperatureC, string Summary);
```

System.Text.Json también ha cerrado la mayoría de las brechas históricas. Desde .NET 7 hace (de)serialización polimórfica mediante `[JsonDerivedType]`, y .NET 9 agregó varias opciones largamente solicitadas: `RespectNullableAnnotations` para respetar los tipos de referencia no anulables, el atributo `JsonStringEnumMemberName` para renombrar valores de enum, y `JsonSchemaExporter` para producir un esquema JSON a partir de un tipo de .NET. .NET 10 agregó la deserialización directa desde un `PipeReader` y un preset estricto de una línea:

```csharp
// .NET 10 and later - the strict, spec-compliant defaults in one preset
var options = JsonSerializerOptions.Strict;

// .NET 10 and later - deserialize straight from a PipeReader, no stream adapter
WeatherForecast? f = await JsonSerializer.DeserializeAsync<WeatherForecast>(pipeReader);
```

## Cuándo elegir Newtonsoft.Json

Todavía hay razones reales para recurrir a él. Elige Newtonsoft.Json cuando te topes con una de estas:

- **Necesitas consultas JSONPath.** `SelectToken("$.store.book[0].title")` no tiene equivalente integrado en System.Text.Json. `JsonNode` te permite navegar por indexador, pero no hay un motor de consultas por ruta. Si analizas documentos arbitrarios y extraes valores por ruta, Newtonsoft.Json es mucho menos código.
- **Dependes de `TypeNameHandling`.** Newtonsoft.Json puede incrustar el nombre del tipo CLR en la carga útil (`$type`) y reconstruir el tipo exacto en tiempo de ejecución al volver. System.Text.Json se niega a hacer esto por diseño, porque deserializar un nombre de tipo controlado por un atacante es un vector de ejecución remota de código bien conocido. Si tienes un protocolo interno existente que depende de ello, la migración no es un indicador de configuración, es un rediseño.
- **Analizas JSON realmente permisivo o no estándar.** Las cadenas con comillas simples, los nombres de propiedad sin comillas y otras entradas que no cumplen RFC son aceptadas por Newtonsoft.Json y rechazadas por System.Text.Json por diseño. Los comentarios y las comas finales son opcionales en System.Text.Json (`ReadCommentHandling`, `AllowTrailingCommas`) pero las comillas simples y las claves desnudas no se pueden habilitar en absoluto.
- **Serializas tipos sin soporte integrado.** `DataTable`, `ExpandoObject`, `TimeZoneInfo`, `BigInteger`, `DBNull` y `ValueTuple` necesitan todos un convertidor personalizado en System.Text.Json. Newtonsoft.Json los maneja de forma nativa.

La diferencia de permisividad por defecto es la que muerde durante una migración. La misma carga útil se comporta de forma distinta:

```csharp
// Newtonsoft.Json 13.0.4 - lenient by default, this parses fine
using Newtonsoft.Json;

var config = JsonConvert.DeserializeObject<Config>("""
{
    "Name": "api", // inline comment
    "Retries": 3,
}
""");

public record Config(string Name, int Retries);
```

```csharp
// .NET 11, System.Text.Json - strict by default, the same input throws JsonException
using System.Text.Json;

// You must opt in to match Newtonsoft.Json's leniency
var options = new JsonSerializerOptions
{
    ReadCommentHandling = JsonCommentHandling.Skip,
    AllowTrailingCommas = true,
    PropertyNameCaseInsensitive = true
};
var config = JsonSerializer.Deserialize<Config>(input, options);
```

Esa rigurosidad es la fuente más común de la sorpresa posterior a la migración en la que una carga útil que funcionó durante años de repente lanza una excepción, que es también la razón por la que errores como un [valor JSON que no se pudo convertir](/2026/05/fix-jsonexception-the-json-value-could-not-be-converted/) o un [DateTime que no se analiza](/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) aparecen justo después de un cambio.

## Qué muestran realmente los benchmarks

El rendimiento es la afirmación más fácil de despachar con vaguedades, así que aquí van números concretos en lugar de la palabra "más rápido". Ejecuciones publicadas de BenchmarkDotNet en .NET 10 serializando una colección de 10 000 objetos POCO simples muestran que System.Text.Json termina en alrededor de 3.7 ms asignando 3.4 MB, frente a Newtonsoft.Json en alrededor de 7.6 ms y 8.1 MB para la misma carga de trabajo.

| Métrica (serializar 10 000 POCOs) | System.Text.Json | Newtonsoft.Json 13.x |
| --------------------------------- | ---------------- | -------------------- |
| Tiempo medio | ~3.7 ms | ~7.6 ms |
| Asignado | ~3.4 MB | ~8.1 MB |
| Relativo | 1.0x (base) | ~2.0x más lento, ~2.4x memoria |

La metodología y las advertencias importan, así que lee estos números con honestidad:

- Las cifras anteriores provienen de un benchmark público de .NET 10 (BenchmarkDotNet, configuración de release por defecto) y son representativas, no dogma. Ejecuta BenchmarkDotNet contra tus propias formas de objeto antes de citar un número en una revisión de diseño.
- La brecha es mayor para POCOs simples y colecciones grandes, exactamente la forma que domina las APIs web y los pipelines de mensajes.
- Para cargas útiles diminutas (un único objeto pequeño por solicitud) la diferencia absoluta es de microsegundos y rara vez es el cuello de botella. Elige por los otros aspectos en ese caso.
- La generación de código fuente amplía aún más la brecha a favor de System.Text.Json porque elimina la reflexión por llamada. Newtonsoft.Json no tiene equivalente.

El resumen es consistente en cada benchmark creíble de 2025 y 2026: System.Text.Json es aproximadamente el doble de rápido y asigna entre la mitad y un tercio para el caso común. El margen no se ha estrechado a favor de Newtonsoft.Json.

## Los detalles que deciden por ti

A veces una sola restricción zanja la decisión antes de que entren las preferencias.

**Native AOT es una puerta cerrada.** Si tu objetivo de despliegue requiere AOT (un contenedor recortado, una función con escalado a cero, una build de iOS), Newtonsoft.Json simplemente no es una opción. Depende de reflexión en tiempo de ejecución que AOT no proporciona. Este único hecho lo descalifica para toda una clase de cargas de trabajo modernas de .NET.

**Trayectoria de mantenimiento.** Newtonsoft.Json no está muerto ni obsoleto. James Newton-King, que ahora trabaja en Microsoft en el propio System.Text.Json, todavía publica versiones de seguridad y corrección de errores (la 13.0.4 llegó el 2025-12-30). Pero está explícitamente en modo de mantenimiento: ningún trabajo importante de características, ninguna estrategia de AOT en camino. System.Text.Json recibe nuevas capacidades en cada versión de .NET. Apostar el código nuevo a la biblioteca que evoluciona activamente es la opción de menor riesgo para un sistema que mantendrás durante años.

**El manejo de referencias y los ciclos de objetos difieren.** Newtonsoft.Json tiene `ReferenceLoopHandling` y `PreserveReferencesHandling`. System.Text.Json los mapea a `ReferenceHandler.IgnoreCycles` y `ReferenceHandler.Preserve`, pero el comportamiento no es idéntico (`IgnoreCycles` escribe `null` donde Newtonsoft.Json descarta la propiedad). Si serializas grafos de entidades de EF Core, esta es la diferencia entre una carga útil limpia y una [excepción de posible ciclo de objetos](/2026/05/fix-possible-object-cycle-was-detected-system-text-json/). Sabe qué manejador necesitas antes de migrar.

**Las licencias son idénticas.** Ambas se distribuyen bajo MIT, así que a diferencia de la situación de MediatR o AutoMapper, la licencia no es un factor aquí. No dejes que "¿sigue siendo gratis Newtonsoft.Json?" conduzca la decisión: lo es, y System.Text.Json también.

## La decisión, en una línea

Para código nuevo en .NET 11 en 2026: usa System.Text.Json por defecto, y agrega Newtonsoft.Json solo cuando te topes con una característica concreta y con nombre que no puede hacer (JSONPath, `TypeNameHandling`, análisis permisivo, o un tipo no soportado sin convertidor). Viene integrado, es más rápido, está listo para AOT y es el que Microsoft sigue construyendo. Mantén Newtonsoft.Json en sistemas existentes que dependan de su flexibilidad; no apresures una migración que no tiene recompensa, pero tampoco empieces ahí. El valor por defecto estratégico cambió hace años, y en 2026 la brecha es lo bastante amplia como para que la carga de la prueba recaiga en elegir Newtonsoft.Json, no en elegir la biblioteca integrada.

## Relacionado

- [How to write a custom JsonConverter in System.Text.Json](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/)
- [Fix: a possible object cycle was detected with System.Text.Json](/2026/05/fix-possible-object-cycle-was-detected-system-text-json/)
- [Fix: the JSON value could not be converted](/2026/05/fix-jsonexception-the-json-value-could-not-be-converted/)
- [Fix: the JSON value could not be converted to System.DateTime](/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/)
- [Native AOT vs ReadyToRun vs JIT in .NET 11](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)

## Fuentes

- [Migrate from Newtonsoft.Json to System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/migrate-from-newtonsoft) - la tabla autoritativa de diferencias de características y la lista de comportamientos por defecto.
- [What's new in System.Text.Json in .NET 9](https://devblogs.microsoft.com/dotnet/system-text-json-in-dotnet-9/) - anotaciones de nulabilidad, nombres de miembros de enum, exportador de esquemas.
- [JsonSerializer.DeserializeAsync (PipeReader overload)](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializer.deserializeasync?view=net-10.0) - la API de streaming de .NET 10.
- [Newtonsoft.Json releases](https://github.com/JamesNK/Newtonsoft.Json/releases) - la versión 13.0.4 y la cadencia de mantenimiento actual.
