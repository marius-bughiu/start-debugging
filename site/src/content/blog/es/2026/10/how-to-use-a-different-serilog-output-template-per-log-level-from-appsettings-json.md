---
title: "Cómo usar una plantilla de salida de Serilog distinta por nivel de registro desde appsettings.json"
description: "outputTemplate es fijo por sink, así que el formato por nivel requiere un ExpressionTemplate con bloques {#if @l ...} o dos sub-loggers Logger con filtros ByIncludingOnly / ByExcluding. Ambas opciones se configuran solo desde appsettings.json, probadas en Serilog 4.4, Serilog.Settings.Configuration 10.0.1 y Serilog.Expressions 5.0."
pubDate: 2026-10-26
template: how-to
tags:
  - "dotnet"
  - "csharp"
  - "logging"
  - "serilog"
  - "aspnet-core"
lang: "es"
translationOf: "2026/10/how-to-use-a-different-serilog-output-template-per-log-level-from-appsettings-json"
translatedBy: "claude"
translationDate: 2026-10-26
---

Un `outputTemplate` de Serilog pertenece a un sink, no a un nivel, así que no existe una opción `"outputTemplate": { "Error": "..." }`. Tienes dos formas limpias de obtener un formato por nivel solo con `appsettings.json`. La primera es cambiar `outputTemplate` por un `formatter` de tipo `Serilog.Templates.ExpressionTemplate` (del paquete `Serilog.Expressions`) y ramificar dentro de la plantilla con `{#if @l in ['Error', 'Fatal']} ... {#else} ... {#end}`. La segunda es escribir en dos sub-loggers `"Name": "Logger"`, cada uno con un `Filter` (`ByIncludingOnly` / `ByExcluding` sobre `@l`) y su propio `outputTemplate` simple. No te limites a añadir un segundo sink con `restrictedToMinimumLevel`: es un límite inferior, así que cada error se escribe dos veces. Todo lo que sigue se ejecutó con el SDK de .NET 10.0.302, Serilog 4.4.0, Serilog.Settings.Configuration 10.0.1, Serilog.Expressions 5.0.0, Serilog.Sinks.Console 6.1.1 y Serilog.Sinks.File 7.0.0. El mismo JSON funciona sin cambios en .NET 11.

## Por qué outputTemplate no puede variar por nivel

`outputTemplate` es un argumento de constructor de los sinks de consola y de archivo. Internamente el sink construye un único `MessageTemplateTextFormatter` a partir de esa cadena y lo usa para cada evento que recibe. Serilog.Settings.Configuration simplemente llama a `WriteTo.Console(outputTemplate: "...")` por ti, así que lo que pongas en el JSON se corresponde uno a uno con ese único formateador. El nivel está disponible *dentro* de la plantilla como `{Level}`, pero una plantilla de mensaje clásica no tiene condicionales: puede imprimir el nivel, pero no puede cambiar de forma por culpa de él.

Por tanto, el formato por nivel necesita una de dos cosas:

1. un formateador que pueda tomar decisiones por sí mismo, que es lo que es `ExpressionTemplate`, o
2. pipelines separados, cada uno con su propio formateador, y un filtro delante de cada uno para que un evento entre exactamente en uno.

Motivos típicos para quererlo: salida corta de una sola línea para `Debug` e `Information` en la consola, pero marcas de tiempo completas, propiedades de contexto adicionales y la traza de pila para `Error` y `Fatal`; o un `errors.log` dedicado con un diseño más rico que el registro principal.

## La configuración ingenua que duplica los errores

Esta es la configuración que la mayoría prueba primero, y la razón por la que se hace esta pregunta:

```json
// appsettings.json, Serilog 4.4.0, Serilog.Settings.Configuration 10.0.1
{
  "Serilog": {
    "Using": [ "Serilog.Sinks.Console" ],
    "MinimumLevel": "Debug",
    "WriteTo": [
      { "Name": "Console", "Args": { "outputTemplate": "[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj}{NewLine}" } },
      { "Name": "Console", "Args": { "restrictedToMinimumLevel": "Error", "outputTemplate": "[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj} ({SourceContext}){NewLine}{Exception}" } }
    ]
  }
}
```

El programa de prueba registra un evento por nivel, con una excepción en el `Error`:

```csharp
// Program.cs, .NET 10, Serilog 4.4.0
using Microsoft.Extensions.Configuration;
using Serilog;

var config = new ConfigurationBuilder().AddJsonFile(args[0]).Build();
Log.Logger = new LoggerConfiguration().ReadFrom.Configuration(config).CreateLogger();

var orderId = 42;
Log.Debug("Cache warm for {Region}", "eu-west");
Log.Information("Order {OrderId} accepted", orderId);
Log.Warning("Order {OrderId} took {Elapsed} ms", orderId, 1830);
try { throw new InvalidOperationException("Payment gateway timed out"); }
catch (Exception ex) { Log.Error(ex, "Order {OrderId} failed", orderId); }
Log.Fatal("Shutting down: {Reason}", "unrecoverable");
Log.CloseAndFlush();
```

La salida:

```text
[09:04:23 DBG] Cache warm for eu-west
[09:04:23 INF] Order 42 accepted
[09:04:23 WRN] Order 42 took 1830 ms
[09:04:23 ERR] Order 42 failed
[09:04:23 ERR] Order 42 failed ()
System.InvalidOperationException: Payment gateway timed out
   at Program.<Main>$(String[] args) in .../Program.cs:line 11
[09:04:23 FTL] Shutting down: unrecoverable
[09:04:23 FTL] Shutting down: unrecoverable ()
```

`restrictedToMinimumLevel` solo significa "este nivel y superiores". El primer sink no tiene límite superior, así que `Error` y `Fatal` llegan a ambos. No existe un argumento `restrictedToMaximumLevel`. Necesitas un filtro real o un condicional real.

## Opción 1: un solo sink, un ExpressionTemplate con bloques #if

`Serilog.Expressions` incluye `ExpressionTemplate`, un `ITextFormatter` cuyo lenguaje de plantillas admite `{#if <expr>}`, `{#else if <expr>}`, `{#else}` y `{#end}`. El nivel actual es `@l`. Serilog.Settings.Configuration puede construirlo directamente desde JSON porque los sinks de consola y de archivo tienen una sobrecarga que recibe un `ITextFormatter formatter`, y el lector de configuración enlaza un objeto con una clave `type` al constructor de ese tipo.

1. Añade los paquetes:

```bash
# .NET 10 SDK; package versions as of October 2026
dotnet add package Serilog.AspNetCore --version 10.0.0
dotnet add package Serilog.Expressions --version 5.0.0
```

`Serilog.AspNetCore` 10.0.0 trae Serilog 4.x, Serilog.Settings.Configuration y los sinks de consola y de archivo. En una aplicación de consola o worker simple usa `Serilog.Extensions.Hosting` (o los paquetes individuales, como en el proyecto de prueba).

2. Reemplaza `outputTemplate` por un objeto `formatter`:

```json
// appsettings.json, Serilog.Expressions 5.0.0
{
  "Serilog": {
    "Using": [ "Serilog.Sinks.Console", "Serilog.Expressions" ],
    "MinimumLevel": "Debug",
    "WriteTo": [
      {
        "Name": "Console",
        "Args": {
          "formatter": {
            "type": "Serilog.Templates.ExpressionTemplate, Serilog.Expressions",
            "template": "{#if @l = 'Debug'}  dbg {@m}\n{#else if @l in ['Information', 'Warning']}[{@t:HH:mm:ss} {@l:u3}] {@m}\n{#else}[{@t:yyyy-MM-dd HH:mm:ss.fff} {@l:u3}] {@m} {Rest()}\n{#if @x is not null}{@x}{#end}{#end}"
          }
        }
      }
    ]
  }
}
```

3. Ejecútalo. Salen tres diseños distintos de un solo sink:

```text
  dbg Cache warm for eu-west
[09:04:47 INF] Order 42 accepted
[09:04:47 WRN] Order 42 took 1830 ms
[2026-10-26 09:04:47.048 ERR] Order 42 failed {"OrderId":42}
System.InvalidOperationException: Payment gateway timed out
   at Program.<Main>$(String[] args) in .../Program.cs:line 11
[2026-10-26 09:04:47.051 FTL] Shutting down: unrecoverable {"Reason":"unrecoverable"}
```

La sintaxis de la plantilla no es la clásica, así que traduce sobre la marcha:

| `outputTemplate` clásico | `ExpressionTemplate` |
| --- | --- |
| `{Timestamp:HH:mm:ss}` | `{@t:HH:mm:ss}` |
| `{Level:u3}` | `{@l:u3}` |
| `{Message:lj}` | `{@m}` (ya muestra las cadenas sin comillas) |
| `{Exception}` | `{@x}` |
| `{NewLine}` | un `\n` literal en la cadena JSON |
| `{Properties:j}` | `{Rest()}` o `{Rest(true)}` |
| `{SourceContext}` | `{SourceContext}` (sin cambios) |

Dos detalles de esa tabla importan en la práctica. `{NewLine}` no existe en las plantillas de expresión; el `\n` en la cadena JSON es un salto de línea real tras analizar el JSON, que es exactamente lo que quieres, así que no lo escapes dos veces. Y `{@x}` ya termina con un salto de línea, por lo que `{@x}\n` imprime una línea vacía después de cada traza de pila.

### Mostrar propiedades de contexto solo cuando las hay

`Rest()` devuelve las propiedades del evento que la *plantilla de expresión* no referenció. Aun así incluye las que aparecen en el texto del mensaje, por eso `{"OrderId":42}` aparece arriba aunque el mensaje ya diga "Order 42". `Rest(true)` también excluye las propiedades referenciadas en la plantilla del mensaje, y puedes protegerlo para que nunca se imprima un `{}` vacío:

```json
"template": "{#if @l in ['Error', 'Fatal']}[{@t:HH:mm:ss.fff} {@l:u3}] {@m}{#if Rest(true) <> {}} {Rest(true)}{#end}\n{@x}{#else}[{@t:HH:mm:ss} {@l:u3}] {@m}\n{#end}"
```

Con un `TenantId` insertado mediante `LogContext` alrededor de la llamada a `Log.Error`, el resultado es:

```text
[09:05:30 DBG] Cache warm for eu-west
[09:05:30 INF] Order 42 accepted
[09:05:30 WRN] Order 42 took 1830 ms
[09:05:30.374 ERR] Order 42 failed {"TenantId":"acme"}
System.InvalidOperationException: Payment gateway timed out
   at Program.<Main>$(String[] args) in .../Program.cs:line 13
[09:05:30.383 FTL] Shutting down: unrecoverable
```

La línea `Fatal` no tiene llaves al final porque su única propiedad, `Reason`, ya está en el mensaje.

## Opción 2: dos sub-loggers, cada uno con su propio outputTemplate

Si quieres conservar las cadenas `outputTemplate` clásicas, o los dos diseños van a sinks distintos (consola vs archivo, Seq vs archivo), usa el sink `Logger`. Crea un sub-logger con sus propias secciones `Filter`, `WriteTo` y `Enrich`. Las expresiones de filtro vuelven a venir de `Serilog.Expressions`, que añade `ByIncludingOnly(string expression)` y `ByExcluding(string expression)`.

1. Haz que los dos filtros sean complementarios para que cada evento vaya exactamente a un sub-logger:

```json
// appsettings.json, Serilog.Settings.Configuration 10.0.1, Serilog.Expressions 5.0.0
{
  "Serilog": {
    "Using": [ "Serilog.Sinks.Console", "Serilog.Expressions" ],
    "MinimumLevel": "Debug",
    "WriteTo": [
      {
        "Name": "Logger",
        "Args": {
          "configureLogger": {
            "Filter": [ { "Name": "ByExcluding", "Args": { "expression": "@l in ['Error', 'Fatal']" } } ],
            "WriteTo": [ { "Name": "Console", "Args": { "outputTemplate": "[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj}{NewLine}" } } ]
          }
        }
      },
      {
        "Name": "Logger",
        "Args": {
          "configureLogger": {
            "Filter": [ { "Name": "ByIncludingOnly", "Args": { "expression": "@l in ['Error', 'Fatal']" } } ],
            "WriteTo": [ { "Name": "Console", "Args": { "outputTemplate": "[{Timestamp:HH:mm:ss.fff} {Level:u3}] {Message:lj} {Properties:j}{NewLine}{Exception}" } } ]
          }
        }
      }
    ]
  }
}
```

2. Ejecútalo. Sin duplicados, y la rama de errores obtiene milisegundos, propiedades y la excepción:

```text
[09:04:23 DBG] Cache warm for eu-west
[09:04:23 INF] Order 42 accepted
[09:04:23 WRN] Order 42 took 1830 ms
[09:04:23.840 ERR] Order 42 failed {}
System.InvalidOperationException: Payment gateway timed out
   at Program.<Main>$(String[] args) in .../Program.cs:line 11
[09:04:23.842 FTL] Shutting down: unrecoverable {}
```

El `{}` es el comportamiento clásico de `{Properties:j}`: lista solo las propiedades que no están ya en el mensaje, y aquí no hay ninguna. A diferencia de `Rest(true)`, no se puede hacer condicional, que es una razón práctica para preferir la Opción 1 en la salida de consola.

### Cuando restrictedToMinimumLevel basta por sí solo

Si el segundo diseño solo necesita "este nivel y superiores" *y* va a un destino distinto, no hace falta ningún filtro. Un archivo de errores dedicado es el caso común:

```json
// appsettings.json, Serilog.Sinks.File 7.0.0
{
  "Name": "File",
  "Args": {
    "path": "logs/errors-.log",
    "rollingInterval": "Day",
    "restrictedToMinimumLevel": "Error",
    "outputTemplate": "{Timestamp:o} [{Level:u3}] {Message:lj}{NewLine}{Properties:j}{NewLine}{Exception}"
  }
}
```

El problema de duplicación de la configuración ingenua solo existe cuando ambas salidas terminan en el mismo lugar.

## Conectarlo en ASP.NET Core o en un worker

Nada de la elección de plantilla cambia el código de hosting. Con Serilog.AspNetCore 10.0.0:

```csharp
// Program.cs, ASP.NET Core on .NET 10 / .NET 11, Serilog.AspNetCore 10.0.0
using Serilog;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSerilog((services, lc) => lc
    .ReadFrom.Configuration(builder.Configuration)
    .ReadFrom.Services(services));

var app = builder.Build();
app.MapGet("/", (ILogger<Program> log) =>
{
    log.LogError("Something failed for {OrderId}", 42);
    return "ok";
});
app.Run();
```

Como el formateador vive en la configuración, puedes darle a `appsettings.Development.json` una plantilla compacta de una sola línea y a `appsettings.Production.json` un formateador JSON, sin tocar el código. El [artículo sobre Serilog y Seq](/es/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) cubre el bootstrap logger y `Log.CloseAndFlush()` en torno a esto.

## Detalles que encontré durante las pruebas

**Las comparaciones de nivel distinguen mayúsculas y minúsculas.** `@l = 'error'` es `false` para un evento `Error`. Usa los nombres exactos `Verbose`, `Debug`, `Information`, `Warning`, `Error`, `Fatal`, o añade el modificador `ci`: `@l = 'error' ci` se evaluó como `true` en la prueba. Además, `{#if}` necesita un Booleano `true` real; un valor no Booleano no es "verdadero".

**Un sub-logger no puede ser más detallado que su padre.** Con el `"MinimumLevel": "Information"` en la raíz y `"MinimumLevel": "Debug"` dentro de `configureLogger`, el sub-logger siguió sin imprimir nada por debajo de `INF`. El logger raíz descarta los eventos antes de que el sink `Logger` los vea. Fija el mínimo raíz en el nivel más bajo que necesite cualquier rama y súbelo por rama.

**Las propiedades ausentes dejan atrás el texto que las rodea.** Ambos estilos de plantilla muestran una propiedad que el evento no tiene como nada: el `({SourceContext})` de la configuración ingenua imprimió `()`, y en un `ExpressionTemplate`, `(OrderId={OrderId})` en el evento `Fatal` imprimió `(OrderId=)`. Solo la plantilla de expresión puede arreglarlo: envuelve las propiedades opcionales en `{#if OrderId is not null} ... {#end}`.

**Los nombres desconocidos fallan en silencio.** `"Enrich": [ "WithMachineName" ]` sin el paquete `Serilog.Enrichers.Environment` instalado no lanzó ninguna excepción. El único rastro fue este, tras habilitar `Serilog.Debugging.SelfLog.Enable(Console.Error)`:

```text
Unable to find a method called WithMachineName. Candidate methods are:
...
```

Lo mismo aplica a un nombre de sink mal escrito o a un nombre de filtro cuando no se referencia `Serilog.Expressions`. Activa `SelfLog` la primera vez que un cambio de plantilla parezca no hacer nada.

**Conserva la sección `Using` si publicas como archivo único.** Serilog.Settings.Configuration descubre automáticamente cualquier dependencia con "Serilog" en el nombre a través del `.deps.json`, así que el proyecto de prueba funcionó sin `Using`. El README del proyecto indica que el descubrimiento automático no funciona en modo empaquetado (archivo único), así que lista `"Serilog.Expressions"` y cada ensamblado de sink de forma explícita.

**Las variables de entorno sobrescriben las entradas de arreglo por índice.** Una plantilla por nivel es una cadena larga en `WriteTo:0:Args:formatter:template`. Sobrescribirla desde un contenedor usa `Serilog__WriteTo__0__Args__formatter__template`, y el índice cambia si alguien reordena `WriteTo`. Si las plantillas difieren por entorno, prefiere un archivo `appsettings.{Environment}.json`.

## Qué opción elegir

Usa `ExpressionTemplate` cuando los diseños comparten un destino, normalmente la consola. Es un sink, una pasada sobre el evento, y puede hacer cosas que los sub-loggers no, como ocultar conjuntos de propiedades vacíos. Usa sub-loggers cuando los diseños van a sinks distintos o necesitan enriquecedores distintos, o cuando un equipo prefiere plantillas clásicas que todos pueden leer. En cualquier caso, el filtro o la condición debe escribirse sobre `@l`; no hay ninguna opción de plantilla indexada por nivel que buscar.

## Lecturas relacionadas

- Empieza por el [registro estructurado con Serilog y Seq en .NET 11](/es/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) si Serilog aún no está integrado.
- Para que el formato por nivel muestre quién desencadenó un error, [añade el ID del usuario actual a cada entrada de registro en ASP.NET Core](/es/2026/09/how-to-add-the-current-user-id-to-every-log-entry-in-aspnet-core/) con `LogContext`.
- Las propiedades que aparecen en `Rest()` o `{Properties:j}` pueden filtrar secretos; [redacta los valores sensibles con `[LogProperties]`](/es/2026/08/how-to-redact-sensitive-values-from-logs-with-logproperties-in-dotnet/) antes de que lleguen a cualquier plantilla.
- `{@m}` y `{Message:lj}` solo se mantienen estructurados si los puntos de llamada usan plantillas de mensaje, que es lo que arregla [migrar de la interpolación de cadenas de `ILogger` a plantillas de mensaje](/es/2026/07/migrate-from-ilogger-string-interpolation-to-message-templates-in-dotnet-11/).
- Si dejas Serilog por OpenTelemetry, consulta [migrar de Serilog al registro de OpenTelemetry](/es/2026/06/migrate-from-serilog-to-opentelemetry-logging-in-dotnet-11/).

## Fuentes

- [README de Serilog.Expressions](https://github.com/serilog/serilog-expressions): `ExpressionTemplate`, los elementos integrados `@l`/`@x`, `#if`/`#else if`, `Rest([deep])` y el modificador `ci`.
- [README de Serilog.Settings.Configuration](https://github.com/serilog/serilog-settings-configuration): `Using` y el descubrimiento automático (incluida la limitación del modo empaquetado), el enlace de `formatter` complejo con `type` y la configuración de sub-loggers.
- [Wiki de Serilog: Configuration Basics](https://github.com/serilog/serilog/wiki/Configuration-Basics): sub-loggers y por qué no pueden reducir el nivel mínimo del padre.
- [Serilog.Sinks.Console](https://github.com/serilog/serilog-sinks-console) y [Serilog.Sinks.File](https://github.com/serilog/serilog-sinks-file): los parámetros `outputTemplate`, `formatter` y `restrictedToMinimumLevel`.
- [Serilog.AspNetCore](https://github.com/serilog/serilog-aspnetcore): `AddSerilog` con `ReadFrom.Configuration` y `ReadFrom.Services`.
