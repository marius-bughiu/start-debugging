---
title: "Migra de la interpolación de cadenas en ILogger a plantillas de mensaje de registro estructurado en .NET 11"
description: "Guía paso a paso para convertir llamadas a ILogger con interpolación $ en plantillas de mensaje y métodos generados con [LoggerMessage] en .NET 11: qué se rompe, cómo barrer un código base con CA2254, cómo verificar el estado JSON y cómo revertir."
pubDate: 2026-07-25
updatedDate: 2026-07-25
template: migration
tags:
  - "migration"
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "logging"
  - "observability"
lang: "es"
translationOf: "2026/07/migrate-from-ilogger-string-interpolation-to-message-templates-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-07-25
---

Cada `_logger.LogInformation($"Order {orderId} failed for {customerId}")` de tu código base está descartando los dos campos que vas a necesitar cuando suene la alerta. Esta guía convierte un código base de .NET 11 (SDK 11.0.100-preview.6, C# 14) de llamadas de registro interpoladas a plantillas de mensaje, y después convierte las rutas calientes en métodos generados con `[LoggerMessage]`. En un servicio de tamaño medio, el barrido de plantillas es medio día de ediciones casi mecánicas guiadas por CA2254, y el paso del generador de código fuente es otro día si lo haces bien. Nada de esto es arriesgado: la corrección no genera cambios incompatibles, cada paso se puede revertir de forma independiente, y la recompensa es que tu backend de registro por fin puede filtrar por `OrderId` en lugar de buscar frases renderizadas con grep.

## Por qué la interpolación pierde los datos que realmente necesitas

- **La estructura desaparece antes de que el logger la vea.** `$"Order {orderId} failed"` se compila a una llamada a `string.Concat` o a `DefaultInterpolatedStringHandler` en el sitio de llamada. Cuando se ejecuta `ILogger.Log`, ya no hay ninguna propiedad `orderId`, solo una frase. `{OriginalFormat}` en el estado del registro termina conteniendo el texto completamente renderizado, así que cada ID de pedido distinto produce una "plantilla" distinta en tu agregador.
- **La cardinalidad explota en el lugar equivocado.** Seq, Loki, Elastic y todos los backends OTLP agrupan e indexan por la plantilla más sus propiedades con nombre. Las llamadas interpoladas te dan una plantilla única por invocación, que es exactamente la forma que peor manejan esos sistemas.
- **La cadena se construye incluso cuando el nivel está apagado.** `_logger.LogDebug($"Payload: {Serialize(request)}")` asigna la cadena y ejecuta `Serialize` en cada solicitud, en producción, con `Debug` deshabilitado. La propia [guía de Microsoft para autores de bibliotecas](https://learn.microsoft.com/en-us/dotnet/core/extensions/logging/library-guidance) lo señala de forma explícita. La propuesta de añadir sobrecargas con manejador de cadenas interpoladas a `LoggerExtensions` ([dotnet/runtime#111283](https://github.com/dotnet/runtime/issues/111283)) se cerró como no planificada, así que esto no se va a arreglar por su cuenta.
- **Las llaves en tus datos pueden lanzar excepciones.** Hay más sobre esto en los detalles finales, pero una cadena interpolada cuyo valor contiene `{` o `}` puede lanzar una `FormatException` desde dentro del pipeline de registro.

Si todavía no has decidido a dónde van los registros, resuelve eso primero. [Registro estructurado con Serilog y Seq](/es/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) y [OpenTelemetry con .NET 11 y un backend gratuito](/es/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) asumen que las plantillas de esta guía ya son correctas.

## Qué producen realmente las dos formas

Este es el caso reproducible más pequeño. La misma intención, dos estilos de llamada, pasados por el formateador `JsonConsole` en .NET 11.

```csharp
// .NET 11 preview 6, C# 14
int orderId = 4711;
string customerId = "acme-inc";

// Interpolated: the template IS the rendered sentence.
_logger.LogInformation($"Order {orderId} failed for {customerId}");

// Message template: placeholders survive as named properties.
_logger.LogInformation("Order {OrderId} failed for {CustomerId}", orderId, customerId);
```

La primera llamada emite un estado con una sola entrada inútil:

```json
{
  "LogLevel": "Information",
  "Message": "Order 4711 failed for acme-inc",
  "State": {
    "Message": "Order 4711 failed for acme-inc",
    "{OriginalFormat}": "Order 4711 failed for acme-inc"
  }
}
```

La segunda llamada emite los campos:

```json
{
  "LogLevel": "Information",
  "Message": "Order 4711 failed for acme-inc",
  "State": {
    "Message": "Order 4711 failed for acme-inc",
    "OrderId": 4711,
    "CustomerId": "acme-inc",
    "{OriginalFormat}": "Order {OrderId} failed for {CustomerId}"
  }
}
```

El `Message` renderizado es idéntico. Todo lo que hace que el registro sea consultable vive en la diferencia.

## Qué se rompe

| Área | Cambio | Severidad |
| --- | --- | --- |
| Sitios de llamada con `$"..."` | Deben convertirse en una plantilla constante más argumentos | alta (por volumen, no por riesgo) |
| Consultas y paneles de registro | Las búsquedas guardadas que coinciden con el texto renderizado siguen funcionando; los nuevos filtros por propiedad hay que construirlos | media |
| Reglas de alerta basadas en `{OriginalFormat}` | La cadena de plantilla cambia, así que las reglas de coincidencia exacta con el texto renderizado anterior dejan de coincidir | media |
| Concatenación de cadenas en plantillas | `"Order " + id + " failed"` es el mismo defecto y lo detecta la misma regla | media |
| Conversión a `[LoggerMessage]` | La clase contenedora y el método deben pasar a ser `partial`; el método debe devolver `void` | baja |
| Valores de `EventId` | Los IDs duplicados dentro del ensamblado producen advertencias del generador | baja |
| Destructuración `@` de Serilog | La semántica de `{@Order}` difiere de la enumeración de estado de `Microsoft.Extensions.Logging` | baja |

Nada de esto es un cambio incompatible en tiempo de ejecución. La regla de Roslyn que guía el barrido, [CA2254](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2254), está documentada explícitamente como una corrección no incompatible.

## Lista de comprobación previa

- .NET SDK 11.0.100-preview.6 o posterior instalado (`dotnet --list-sdks`). Todo lo de esta guía también funciona en .NET 8, 9 y 10.
- `<LangVersion>` en 9 o superior. El generador `[LoggerMessage]` se niega a ejecutarse por debajo de C# 9. En .NET 11 obtienes C# 14 por defecto.
- `Microsoft.Extensions.Logging.Abstractions` referenciado en cada proyecto que vaya a declarar métodos `[LoggerMessage]`. Los proyectos que usan `Microsoft.NET.Sdk.Web` lo obtienen de forma transitiva.
- `<EnableNETAnalyzers>true</EnableNETAnalyzers>` y `<AnalysisLevel>latest</AnalysisLevel>` en `Directory.Build.props`, de lo contrario CA2254 nunca se dispara.
- Un `git status` limpio y una ejecución de pruebas en verde antes de empezar. El barrido toca cientos de líneas y querrás una reversión trivial.

## Pasos de migración

El orden importa: primero haz que el analizador grite, corrige todo lo que encuentre, y solo entonces recurre al generador de código fuente en las rutas donde la asignación de memoria realmente te cuesta algo.

1. **Convierte CA2254 en un error de compilación.** Añade la regla a `.editorconfig` primero como `warning` para ver el alcance, y súbela a `error` cuando el conteo llegue a cero. Verifica: `dotnet build` reporta un conteo de CA2254 distinto de cero en la primera ejecución.
2. **Convierte las llamadas interpoladas y concatenadas a plantillas de mensaje.** Saca cada valor de la cadena y pásalo como argumento, con un nombre de marcador en PascalCase. Verifica: `dotnet build` reporta cero diagnósticos CA2254.
3. **Corrige el orden de los argumentos, porque el enlace es posicional.** `LoggerExtensions` enlaza los argumentos con los marcadores de izquierda a derecha, no por nombre. Verifica: ejecuta la aplicación y confirma que cada propiedad del estado JSON contiene el valor que su nombre promete.
4. **Añade métodos `[LoggerMessage]` para las rutas calientes.** Convierte las llamadas de registro por solicitud y por elemento en métodos `partial` de una clase `partial` para que la plantilla se analice una sola vez en tiempo de compilación. Verifica: `dotnet build` está limpio y el archivo generado aparece en `obj/**/Microsoft.Extensions.Logging.Generators/`.
5. **Asigna un `EventId` estable por mensaje y mantenlos únicos.** Verifica: no hay advertencias `SYSLIB` de ID de evento duplicado en el registro de compilación.
6. **Usa `SkipEnabledCheck` más una guarda manual donde evaluar los argumentos sea costoso.** Verifica: pon la categoría en `Information` y confirma que la llamada costosa no se ejecuta.
7. **Expande objetos con `[LogProperties]` en lugar de `ToString()`.** Verifica: las propiedades públicas del objeto aparecen como entradas individuales en el estado del registro, no como una única cadena aplanada.

### 1. Convierte CA2254 en un error de compilación

CA2254 está habilitada como sugerencia por defecto desde .NET 10 en adelante, lo que significa que es invisible en CI. Súbela de nivel:

```ini
# .editorconfig -- .NET 11, analyzers at latest
[*.{cs,vb}]

# CA2254: Template should be a static expression
dotnet_diagnostic.CA2254.severity = warning
```

Compila y cuenta a qué te enfrentas:

```bash
dotnet build -warnaserror:CA2254 --no-incremental
```

Todavía no habilites CA1848. Esa regla se dispara en cada llamada `LogInformation` del código base, incluidas las correctas, y va a enterrar la señal de CA2254. Vuelve en el paso 4.

### 2. Convierte a plantillas de mensaje

La transformación mecánica, en tres formas comunes:

```csharp
// .NET 11, C# 14 -- before
_logger.LogInformation($"Order {order.Id} failed for {order.CustomerId}");
_logger.LogWarning("Retry " + attempt + " of " + maxAttempts);
_logger.LogError(ex, $"Import of {file.Name} aborted after {sw.ElapsedMilliseconds} ms");

// after
_logger.LogInformation("Order {OrderId} failed for {CustomerId}", order.Id, order.CustomerId);
_logger.LogWarning("Retry {Attempt} of {MaxAttempts}", attempt, maxAttempts);
_logger.LogError(ex, "Import of {FileName} aborted after {ElapsedMs} ms", file.Name, sw.ElapsedMilliseconds);
```

Tres reglas de nomenclatura que se pagan solas más adelante:

- Marcadores en PascalCase. La propia guía de Microsoft lo recomienda, y mantiene consistentes los nombres de propiedad entre las plantillas escritas a mano y las generadas.
- El mismo concepto recibe el mismo nombre en todas partes. Si es `OrderId` en un servicio, es `OrderId` en todos, de lo contrario las consultas entre servicios necesitan una cláusula `or` por cada grafía.
- Nunca pongas la excepción en la plantilla. `LogError(ex, "...")` la pasa por el parámetro `Exception` dedicado, y el proveedor decide cómo renderizarla.

### 3. El enlace de argumentos es posicional, no por nombre

Este es el único error que el barrido puede introducir, y CA2254 no lo va a detectar:

```csharp
// .NET 11 -- compiles, no analyzer warning, WRONG
_logger.LogInformation("Order {OrderId} for {CustomerId}", customerId, orderId);
```

`Microsoft.Extensions.Logging` asigna los marcadores a los argumentos en orden. Los nombres son etiquetas para las propiedades resultantes, no una clave de enlace. La línea de registro muestra el ID de cliente bajo `OrderId` y nadie se da cuenta hasta que una consulta devuelve un sinsentido tres semanas después. Lee cada línea convertida una vez pensando en este fallo concreto, y prefiere convertir un método completo a la vez en lugar de aceptar la salida de un buscar y reemplazar masivo.

El generador `[LoggerMessage]` del paso 4 no tiene este problema: hace coincidir los marcadores de la plantilla con los nombres de los parámetros sin distinguir mayúsculas, así que el orden de los parámetros es irrelevante allí.

### 4. Añade [LoggerMessage] en las rutas calientes

Las plantillas de mensaje arreglaron la estructura. No arreglaron el costo por llamada: `LoggerExtensions.LogInformation` sigue haciendo boxing de los tipos por valor a `object`, asigna un `params object?[]` y vuelve a analizar la plantilla en cada llamada. El [generador de código fuente `[LoggerMessage]`](/es/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) elimina las tres cosas emitiendo en tiempo de compilación un envoltorio `LoggerMessage.Define` fuertemente tipado.

```csharp
// .NET 11 preview 6, C# 14
using Microsoft.Extensions.Logging;

public partial class OrderProcessor(ILogger<OrderProcessor> logger, OrderPipeline pipeline)
{
    public async Task ProcessAsync(Order order, CancellationToken ct)
    {
        try
        {
            await pipeline.RunAsync(order, ct);
            OrderProcessed(order.Id, order.CustomerId);
        }
        catch (PaymentDeclinedException ex)
        {
            OrderFailed(ex, order.Id, order.CustomerId);
        }
    }

    [LoggerMessage(
        EventId = 1001,
        Level = LogLevel.Information,
        Message = "Order {OrderId} processed for {CustomerId}")]
    private partial void OrderProcessed(int orderId, string customerId);

    [LoggerMessage(
        EventId = 1002,
        Level = LogLevel.Warning,
        Message = "Order {OrderId} failed for {CustomerId}")]
    private partial void OrderFailed(Exception ex, int orderId, string customerId);
}
```

Desde .NET 9, el generador lee el `ILogger` de un parámetro del constructor primario, que es la razón por la que el ejemplo anterior no tiene un campo `_logger` explícito. Si existen tanto un campo como un parámetro de constructor primario, gana el campo.

Las restricciones que vale la pena memorizar, según la [documentación de generación de código fuente](https://learn.microsoft.com/en-us/dotnet/core/extensions/logger-message-generator): los métodos deben ser `partial` y devolver `void`, ni los nombres ni los nombres de parámetro pueden empezar con guion bajo, y los parámetros no pueden usar `params`, `scoped` ni `out`, ni ser tipos `ref struct`. Los métodos estáticos deben recibir el `ILogger` como parámetro; añade `this` para convertirlos en métodos de extensión.

Ahora activa CA1848 en los proyectos que hayas convertido, con alcance limitado para que no inunde el resto:

```ini
# .editorconfig, in the hot-path project folder only
[*.cs]
# CA1848: Use the LoggerMessage delegates
dotnet_diagnostic.CA1848.severity = warning
```

CA1848 no está habilitada por defecto ni siquiera en .NET 10 y posteriores, y es deliberadamente agresiva: marca cada llamada del estilo `LogInformation`. Habilítala por proyecto, no para toda la solución, salvo que de verdad pretendas generar todos los mensajes con el generador.

### 5. Mantén los IDs de evento estables y únicos

`EventId` es la identidad estable de un mensaje de registro. Sobrevive a las reescrituras de la plantilla, lo que lo convierte en lo correcto para que las reglas de alerta se basen en él. Pon los IDs en un solo lugar por ensamblado para que las colisiones sean evidentes:

```csharp
// .NET 11 -- one file, one range per subsystem
internal static class LogEvents
{
    public const int OrderProcessed = 1001;
    public const int OrderFailed    = 1002;
    public const int PaymentRetried = 1003;
}
```

El generador advierte sobre IDs de evento duplicados dentro de una clase. No advierte entre clases, así que el archivo de constantes hace un trabajo real.

### 6. SkipEnabledCheck para argumentos costosos

Por defecto, el método generado llama a `ILogger.IsEnabled` antes de hacer nada, así que un nivel deshabilitado cuesta una llamada virtual. Lo que no puede hacer es impedir que quien llama calcule los argumentos. Cuando un argumento es costoso, saca la guarda fuera:

```csharp
// .NET 11, C# 14
[LoggerMessage(
    EventId = 2001,
    Level = LogLevel.Debug,
    Message = "Request body: {Body}",
    SkipEnabledCheck = true)]
private partial void RequestBody(string body);

// call site
if (logger.IsEnabled(LogLevel.Debug))
{
    RequestBody(await SerializeAsync(request, ct));  // only runs when Debug is on
}
```

Este es el patrón que recupera el rendimiento que las llamadas interpoladas a `LogDebug` te estaban costando en silencio.

### 7. Expande objetos con [LogProperties]

`Message = "Processing {Order}"` con un parámetro `Order` te da una sola propiedad que contiene la salida de `ToString()`. Para obtener los campos del objeto como propiedades separadas, añade `Microsoft.Extensions.Telemetry.Abstractions` y anota el parámetro:

```csharp
// .NET 11, Microsoft.Extensions.Telemetry.Abstractions
[LoggerMessage(
    EventId = 1004,
    Level = LogLevel.Information,
    Message = "Processing order")]
private partial void ProcessingOrder([LogProperties] Order order);
```

Cada propiedad pública de `Order` aterriza en el estado del registro como `order.Id`, `order.CustomerId`, y así sucesivamente. El mismo paquete es el que habilita la redacción de parámetros clasificados, que es la respuesta correcta cuando alguien te pide registrar un objeto de solicitud que contiene una dirección de correo.

## Verificación

Ejecuta esta lista de comprobación después de cada fase, no una sola vez al final:

- `dotnet build -warnaserror:CA2254` sale con código cero.
- `dotnet test` pasa sin nuevos fallos. Las pruebas que hacen aserciones sobre el texto renderizado del registro son la baja habitual; reescríbelas para que hagan aserciones sobre las propiedades del estado.
- Cambia el formateador de consola a JSON (`"Console": { "FormatterName": "json" }` en `appsettings.Development.json`), llama a un endpoint representativo y lee el objeto `State` emitido. Cada valor que te importe debe aparecer con su propia clave, y `{OriginalFormat}` debe contener marcadores en lugar de datos.
- Busca con grep en la salida de compilación `SYSLIB1015` (parámetro sin marcador correspondiente) y `SYSLIB0025` (excepción incluida en la plantilla). Ambas son advertencias que deberías corregir en lugar de suprimir.
- Confirma que el código fuente generado existe: `obj/Debug/net11.0/generated/Microsoft.Extensions.Logging.Generators/`. Si la carpeta está vacía, el atributo está sobre un miembro que no es `partial` y el generador no hizo nada útil en silencio.
- Implementa en staging y compara el volumen de registro. Debería ser el mismo. Una caída significa que alguna guarda de nivel se apretó por accidente.

## Plan de reversión

Cada paso se puede revertir de forma independiente con `git revert`, y ningún paso cambia una API pública ni un formato de transmisión. Hay una advertencia que vale la pena decir en voz alta: en cuanto tu backend de registro empiece a indexar los nuevos nombres de propiedad, los paneles y las alertas construidos sobre ellos se rompen si reviertes el código. Revierte primero el código, después los paneles, y mantén ambos cambios en commits separados para que el orden esté a tu disposición.

El aumento de severidad en `.editorconfig` también vale la pena conservarlo aunque reviertas los cambios de código. Dejar CA2254 en `warning` evita que lleguen nuevas llamadas interpoladas mientras decides.

## Detalles con los que tropezamos

**Las llaves en los datos lanzan una FormatException.** La forma interpolada tiene un modo de fallo que la mayoría de los equipos conocen primero en producción. `Microsoft.Extensions.Logging` trata el argumento `message` como una cadena de formato y la pasa por `LogValuesFormatter`, que reescribe `{Name}` como `{0}` y llama a `string.Format`. Si tu resultado interpolado contiene llaves, por ejemplo porque registraste una carga JSON, el formateador ve marcadores sin argumentos correspondientes y lanza una excepción (`aspnet/Logging#351` es el reporte canónico). Las plantillas de mensaje son inmunes: el JSON es un argumento, nunca parte de la cadena de formato.

```csharp
// .NET 11 -- throws FormatException at runtime when json contains { }
_logger.LogInformation($"Response: {json}");

// safe
_logger.LogInformation("Response: {Json}", json);
```

**`{@Property}` de Serilog no es una característica de Microsoft.Extensions.Logging.** Si usas Serilog, `{@Order}` destructura el objeto en un valor estructurado. El generador `[LoggerMessage]` aceptará la plantilla, pero la `@` es una convención de Serilog, gestionada por `Serilog.Extensions.Logging`. No asumas que hace algo en un proveedor OTLP o de consola simple. Usa `[LogProperties]` cuando quieras una expansión independiente del proveedor.

**Pruebas que hacen aserciones sobre el texto del registro.** `Assert.Contains("Order 4711 failed", sink.Messages)` sigue pasando durante la migración, porque el mensaje renderizado no cambia. Eso es una trampa: significa que puedes convertir el código base sin que tus pruebas demuestren nunca que las propiedades existen. Añade al menos una prueba por subsistema que haga aserciones sobre la clave del estado.

**Los propios registros de EF Core ya usan plantillas.** No los "arregles". Si lo que intentas es obtener SQL legible del proveedor, [registrar el SQL que genera EF Core 11](/es/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) es un problema de configuración, no de sitio de llamada.

**Una migración de backend es otro trabajo distinto.** Convertir sitios de llamada no mueve los registros a ninguna parte. Si el destino es OTLP, haz primero esta migración para que las plantillas queden bien, y después sigue [pasar de Serilog a registro con OpenTelemetry](/es/2026/06/migrate-from-serilog-to-opentelemetry-logging-in-dotnet-11/). Hacer las dos a la vez significa que no puedes saber qué cambio rompió un panel.

## Fuentes

- [Generación de código fuente de registro en tiempo de compilación](https://learn.microsoft.com/en-us/dotnet/core/extensions/logger-message-generator), Microsoft Learn
- [Registro de alto rendimiento en .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/logging/high-performance-logging), Microsoft Learn
- [Guía de registro para autores de bibliotecas .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/logging/library-guidance), Microsoft Learn
- [CA2254: la plantilla debe ser una expresión estática](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2254), Microsoft Learn
- [CA1848: usa los delegados de LoggerMessage](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1848), Microsoft Learn
- [Propuesta de API: sobrecargas con cadenas interpoladas para las extensiones de ILogger](https://github.com/dotnet/runtime/issues/111283), dotnet/runtime, cerrada como no planificada
- [LogInformation(string) lanza FormatException](https://github.com/aspnet/Logging/issues/351), aspnet/Logging
- [.NET 11 Preview 6 ya está disponible](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-6/), .NET Blog
