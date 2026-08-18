---
title: "Solución: CA1873 \"Evaluation of this argument may be expensive and unnecessary if logging is disabled\""
description: "CA1873 se dispara por el arreglo params object[] implícito, así que casi toda llamada a LogDebug lo activa. Corrígelo con [LoggerMessage] o una guarda IsEnabled."
pubDate: 2026-08-18
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "logging"
  - "analyzers"
  - "performance"
lang: "es"
translationOf: "2026/08/fix-ca1873-evaluation-of-this-argument-may-be-expensive-and-unnecessary-if-logging-is-disabled"
translatedBy: "claude"
translationDate: 2026-08-18
---

CA1873 es un analizador de rendimiento que viene habilitado en el SDK de .NET 10 como **sugerencia**, no como advertencia, así que aparece en Visual Studio, Rider y `dotnet format`, pero deja limpio a `dotnet build`. Se dispara por el arreglo `params object?[]` implícito que asigna toda llamada del estilo `ILogger.LogDebug`, lo que significa que se activa prácticamente en cada llamada de logging estructurado con al menos un argumento, incluso con una cadena simple. La solución real es la generación de código fuente con `[LoggerMessage]`; la solución rápida es una guarda `IsEnabled` cuyo nivel coincida exactamente con la llamada.

El texto del diagnóstico que estás buscando:

```text
warning CA1873: Evaluation of this argument may be expensive and unnecessary if logging is disabled
```

Todo lo que sigue fue verificado contra el SDK `10.0.201`, `Microsoft.Extensions.Logging` 10.0.0 y C# 14, con el código fuente del analizador leído desde `dotnet/sdk`.

## ¿Qué hace que CA1873 sea invisible en dotnet build?

Porque su severidad predeterminada en .NET 10 es sugerencia (info), y los diagnósticos de nivel info no los imprime `dotnet build` ni los afecta `TreatWarningsAsErrors`.

Un proyecto con una docena de llamadas a `LogDebug` compila completamente limpio:

```text
    0 Warning(s)
    0 Error(s)
```

Conviértelo en una advertencia real de una de estas dos formas:

```xml
<!-- .NET 10 SDK 10.0.201: promotes every "All"-mode analyzer, CA1873 included -->
<PropertyGroup>
  <AnalysisMode>All</AnalysisMode>
</PropertyGroup>
```

```ini
# .editorconfig, targeted at just this rule
[*.{cs,vb}]
dotnet_diagnostic.CA1873.severity = warning
```

El mismo proyecto reporta entonces 12 advertencias CA1873. Si estás conectando severidades de analizadores en CI, los compromisos están cubiertos en [cómo mantener TreatWarningsAsErrors fuera de tus compilaciones de desarrollo](/es/2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10/).

## ¿Cómo puede un argumento obviamente barato activar CA1873?

Esta es la parte que manda a la gente a los buscadores. La regla no mira solo tu argumento. Mira el **arreglo `params object?[]` implícito** que el compilador crea para pasar ese argumento, y la creación de un arreglo no vacío se reporta por sí misma como costosa.

`LoggerExtensions.LogDebug` no tiene ninguna sobrecarga sin params que reciba argumentos de mensaje:

```csharp
// Microsoft.Extensions.Logging.Abstractions 10.0.0
public static void LogDebug(this ILogger logger, string? message, params object?[] args);
```

Así que `_logger.LogDebug("v {V}", x)` compila a una asignación `object[1]` sin importar qué sea `x`. La comprobación de costo del analizador trata cualquier creación de arreglo como una violación, salvo que el arreglo esté vacío:

```csharp
// dotnet/sdk, AvoidPotentiallyExpensiveCallWhenLogging.cs
static bool IsEmptyImplicitParamsArrayCreation(IArrayCreationOperation arrayCreationOperation) =>
    arrayCreationOperation.IsImplicit &&
    arrayCreationOperation.DimensionSizes.Length == 1 &&
    arrayCreationOperation.DimensionSizes[0].ConstantValue.HasValue &&
    arrayCreationOperation.DimensionSizes[0].ConstantValue.Value is int size &&
    size == 0;
```

Construí una matriz para confirmar qué lo activa realmente. Cada una de estas produjo CA1873 en el SDK 10.0.201:

```csharp
// .NET 10, C# 14, Microsoft.Extensions.Logging.Abstractions 10.0.0
public void StringProp(Order o) => _logger.LogDebug("v {V}", o.Name);      // CA1873
public void IntProp(Order o)    => _logger.LogDebug("v {V}", o.Id);        // CA1873
public void StringField()       => _logger.LogDebug("v {V}", _nameField);  // CA1873
public void StringLocal()       { var s = "a"; _logger.LogDebug("v {V}", s); }  // CA1873
public void StringParam(string s) => _logger.LogDebug("v {V}", s);         // CA1873
public void ConstInt()          => _logger.LogDebug("v {V}", 42);          // CA1873
```

Solo escapa una llamada sin ningún argumento de mensaje, porque entonces el arreglo params implícito tiene longitud cero:

```csharp
public void LiteralOnly() => _logger.LogDebug("nothing to see");           // clean
```

Esa es toda la sorpresa. No hay nada malo con `o.Name`. Un cambio de noviembre de 2025 titulado "Reduce noise from CA1873" eximió específicamente los accesos a propiedades, `GetType`, `GetHashCode` y `Stopwatch.GetTimestamp` de la comprobación de costo, pero esa exención aplica a los *elementos* del arreglo, mientras que la asignación del arreglo en sí sigue marcada. Para las sobrecargas basadas en params, la reducción de ruido es invisible.

## ¿Cuál es la reproducción mínima?

```csharp
// .NET 10 (SDK 10.0.201), C# 14
// dotnet new console + Microsoft.Extensions.Logging.Abstractions 10.0.0
using Microsoft.Extensions.Logging;

public class OrderService(ILogger<OrderService> logger)
{
    public void Process(Order order)
    {
        // CA1873: Evaluation of this argument may be expensive
        // and unnecessary if logging is disabled
        logger.LogDebug("Order {OrderId} for {Customer}", order.Id, order.Customer);
    }
}
```

Con `<AnalysisMode>All</AnalysisMode>` o una severidad explícita en `.editorconfig`, esa sola llamada reporta CA1873.

## ¿Cómo corrijo CA1873 correctamente?

Usa el generador de código fuente `[LoggerMessage]`. Emite un método fuertemente tipado sin arreglo params y sin boxing, así que no queda nada para que el analizador marque ni nada para que el runtime asigne cuando el nivel está deshabilitado.

```csharp
// .NET 10, C# 14. The class must be partial.
public partial class OrderService(ILogger<OrderService> logger)
{
    public void Process(Order order) => LogOrder(order.Id, order.Customer);

    [LoggerMessage(Level = LogLevel.Debug, Message = "Order {OrderId} for {Customer}")]
    private partial void LogOrder(int orderId, string customer);
}
```

El método generado comprueba `IsEnabled` antes de tocar sus argumentos, así que el analizador se queda callado y la llamada sale gratis cuando Debug está apagado. Este es el mismo mecanismo detrás de [reemplazar new Regex(...) con el generador de código fuente GeneratedRegex](/es/2026/08/how-to-replace-new-regex-with-the-generatedregex-source-generator-in-dotnet-11/); si el patrón no te resulta familiar, empieza por [qué es un generador de código fuente y cuándo lo necesitas](/es/2026/06/what-is-a-source-generator-and-when-do-i-need-one/).

## ¿Cuándo basta con una guarda IsEnabled?

Cuando quieres un cambio de una línea y no quieres reestructurar la clase en un tipo partial. El analizador reconoce la guarda y suprime el diagnóstico:

```csharp
// .NET 10, C# 14
if (logger.IsEnabled(LogLevel.Debug))
{
    logger.LogDebug("Order {OrderId} for {Customer}", order.Id, order.Customer);
}
```

Dos restricciones, y verifiqué que ambas producen un diagnóstico cuando se incumplen:

**El nivel debe coincidir exactamente.** Proteger un `LogDebug` con `IsEnabled(LogLevel.Information)` sigue reportando CA1873, porque el analizador compara la constante de la guarda contra el nivel de la llamada:

```csharp
if (logger.IsEnabled(LogLevel.Information))
{
    logger.LogDebug("v {V}", order.Describe());   // CA1873, levels differ
}
```

**La guarda debe estar en línea.** Moverla detrás de una propiedad o un método auxiliar anula la comprobación por completo, porque el analizador recorre las operaciones contenedoras buscando una invocación literal de `ILogger.IsEnabled`:

```csharp
private bool DebugOn => logger.IsEnabled(LogLevel.Debug);

public void Process(Order order)
{
    if (DebugOn) { logger.LogDebug("v {V}", order.Describe()); }   // CA1873
}
```

## ¿Cuánto cuesta realmente la llamada sin proteger?

Lo suficiente para importar en una ruta caliente, y nada fuera de ella. Medido con BenchmarkDotNet 0.15.4 en .NET 10.0.5, Intel Core Ultra 7 265KF, con el nivel mínimo puesto en `Information` para que la llamada Debug esté deshabilitada:

| Método | Media | Ratio | Asignado |
| --- | ---: | ---: | ---: |
| Unguarded | 13.22 ns | 1.00 | 64 B |
| Guarded | 0.27 ns | 0.02 | 0 B |
| SourceGenerated | 0.51 ns | 0.04 | 0 B |

Los 64 bytes son el arreglo `object[2]` más el `int` boxeado. Ambas soluciones lo bajan a cero. Fíjate en el ratio, no solo en los nanosegundos: 13 ns por llamada es irrelevante en un manejador de solicitudes que ejecuta una consulta a base de datos, y muy relevante en un bucle que corre un millón de veces. Por eso exactamente la regla se envía como sugerencia y no como advertencia.

## ¿Qué niveles de log comprueba CA1873?

De forma predeterminada, Information y por debajo. La justificación de diseño, tomada del propio historial de commits del analizador, es que las rutas calientes registran en Debug y Trace, mientras que Warning y Error son lo bastante raros como para que la sobrecarga por llamada no importe.

También hay una perilla no documentada en `.editorconfig` para cambiar el umbral:

```ini
# Not listed on the CA1873 docs page. Values: trace, debug, information, warning, error, critical
[*.{cs,vb}]
dotnet_code_quality.CA1873.max_log_level = warning
```

Barrer todos los valores en el SDK 10.0.201 da esto, y expone un error:

| `max_log_level` | Niveles que reportan CA1873 |
| --- | --- |
| `trace` | Trace, **Critical** |
| `debug` | Trace, Debug, **Critical** |
| `information` (predeterminado) | Trace, Debug, Information, **Critical** |
| `warning` | Trace, Debug, Information, Warning, Critical |
| `error` | los seis |

`LogCritical` reporta en todos los umbrales, incluido `trace`. Eso es un error de desplazamiento por uno: la comparación que se envió excluye a Critical del rango del que se sale anticipadamente.

```csharp
// dotnet/sdk commit 574cda32, "CA1873: Fix log level comparison"
-                    logLevel < LogLevelCritical &&
+                    logLevel <= LogLevelCritical &&
```

La corrección llegó a `dotnet/sdk` el 2026-06-19, después de que se publicara el SDK 10.0.201. Hasta que te muevas a un SDK que la incluya, las llamadas a `LogCritical` seguirán reportando CA1873 sin importar cómo configures `max_log_level`. Suprime esas individualmente en lugar de deshabilitar la regla.

## Falso positivo conocido: llamadas generadas protegidas por una guarda

Si envuelves un método de log generado por código fuente en una comprobación `IsEnabled`, el analizador sigue reportando CA1873. Esto está registrado como una incidencia abierta contra el analizador, y se reproduce en el SDK 10.0.201:

```csharp
// .NET 10, C# 14. Guarded, source-generated, still reports CA1873.
if (logger.IsEnabled(LogLevel.Information))
{
    LogKeys([.. dictionary.Select(p => p.Key)]);
}

[LoggerMessage(Level = LogLevel.Information, Message = "keys {Keys}")]
private partial void LogKeys(string[] keys);
```

La guarda solo cuenta cuando envuelve una llamada de `ILogger` reconocida. Un método generado es un método ordinario en lo que respecta al analizador, así que el argumento de expresión de colección se evalúa por sus propios méritos y se marca. Suprime este localmente hasta que llegue la corrección:

```csharp
#pragma warning disable CA1873
    LogKeys([.. dictionary.Select(p => p.Key)]);
#pragma warning restore CA1873
```

## Parecidos que aterrizan en esta página por error

**CA1848** ("For improved performance, use the LoggerMessage delegates") se dispara en los mismos sitios de llamada y tiene la misma solución, pero trata sobre el costo de analizar la plantilla del mensaje en cada llamada, no sobre la evaluación de argumentos. Normalmente verás ambos juntos, y `[LoggerMessage]` limpia los dos.

**CA2254** ("The logging message template should not vary between calls") trata sobre la interpolación de cadenas destruyendo tus campos estructurados. Si eso es lo que en realidad estás persiguiendo, mira [migrar de la interpolación de cadenas con ILogger a plantillas de mensaje](/es/2026/07/migrate-from-ilogger-string-interpolation-to-message-templates-in-dotnet-11/), que también cubre `SkipEnabledCheck` y `[LogProperties]`.

## ¿Deberías simplemente apagarla?

Para una base de código que registra en Information en las rutas de solicitud y no tiene bucles calientes medidos, sí. Ponla en `none` y vuelve a revisarlo cuando tengas un perfil que diga que la sobrecarga de logging importa:

```ini
[*.{cs,vb}]
dotnet_diagnostic.CA1873.severity = none
```

El término medio más útil es dejarla en su severidad predeterminada de sugerencia y aplicar `[LoggerMessage]` de forma oportunista. Obtienes el empujón del IDE en los sitios de llamada que tocas, nada de ruido en CI, y el logging sin asignaciones se acumula con el tiempo en lugar de llegar como una refactorización de 400 archivos. La ganancia en asignaciones es real, solo que no es urgente, y el arreglo params que hay detrás es el mismo que C# 13 [empezó a eliminar para otras APIs](/es/2026/01/c-13-the-end-of-params-allocations/).

## Relacionado

- [Migrar de la interpolación de cadenas con ILogger a plantillas de mensaje de logging estructurado en .NET 11](/es/2026/07/migrate-from-ilogger-string-interpolation-to-message-templates-in-dotnet-11/)
- [Cómo redactar valores sensibles de los logs con LogProperties en .NET](/es/2026/08/how-to-redact-sensitive-values-from-logs-with-logproperties-in-dotnet/)
- [¿Qué es un generador de código fuente y cuándo lo necesito?](/es/2026/06/what-is-a-source-generator-and-when-do-i-need-one/)
- [TreatWarningsAsErrors sin sabotear las compilaciones de desarrollo (.NET 10)](/es/2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10/)
- [C# 13: el fin de las asignaciones de params](/es/2026/01/c-13-the-end-of-params-allocations/)

## Fuentes

- [CA1873: Avoid potentially expensive logging](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1873) en MS Learn
- [Add CA1873: Avoid potentially expensive logging](https://github.com/dotnet/roslyn-analyzers/pull/7290), el PR original del analizador
- [Reduce noise from CA1873](https://github.com/dotnet/sdk/commit/bb4aee4d), que añadió la opción `max_log_level` y la exención de accesos a propiedades
- [CA1873: Fix log level comparison](https://github.com/dotnet/sdk/commit/574cda32), la corrección del desplazamiento por uno de `LogCritical`
- [Falsos positivos de CA1873 cuando el mensaje de log está envuelto en una comprobación IsEnabled](https://github.com/dotnet/roslyn-analyzers/issues/7690)
- [Referencia de la API LoggerMessageAttribute](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.logging.loggermessageattribute)
