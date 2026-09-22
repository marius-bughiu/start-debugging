---
title: "OpenTelemetry .NET 1.19.1 corrige la NotSupportedException de comodines en net8.0"
description: "OpenTelemetry 1.19.0 cambió su regex de fuentes con comodines a RegexOptions.NonBacktracking, que lanza una excepción en net8.0 al registrar suficientes fuentes. La 1.19.1, publicada el 21 de septiembre de 2026, vuelve a una regex compilada con un tiempo de espera de coincidencia."
pubDate: 2026-09-22
tags:
  - "dotnet"
  - "opentelemetry"
  - "observability"
  - "dotnet-8"
lang: "es"
translationOf: "2026/09/opentelemetry-dotnet-1-19-1-fixes-wildcard-notsupportedexception-on-net-8"
translatedBy: "claude"
translationDate: 2026-09-22
---

[OpenTelemetry .NET 1.19.1](https://github.com/open-telemetry/opentelemetry-dotnet/releases/tag/core-1.19.1) salió el 21 de septiembre de 2026, tres días después de la 1.19.0. Contiene exactamente un cambio relevante, y si tu aplicación apunta a `net8.0` y registra una lista larga de fuentes de actividad o medidores, es la diferencia entre un `TracerProvider` que funciona y un fallo al arrancar.

## Qué rompió la 1.19.0

El SDK convierte tus nombres de `AddSource("...")` y `AddMeter("...")` en una sola regex cuando al menos uno de ellos contiene `*` o `?`. El [PR #7760](https://github.com/open-telemetry/opentelemetry-dotnet/pull/7760), integrado para la 1.19.0, reforzó esa regex construyéndola con `RegexOptions.NonBacktracking` en .NET moderno. La intención era buena: nada de backtracking catastrófico, sin importar qué patrón termine en la lista.

El problema es que el motor sin backtracking compila el patrón en un autómata con un límite de tamaño estricto, y ese límite es de 1 000 nodos en .NET 8 (10 000 en .NET 9 y posteriores). Una rama de alternancia por fuente suma rápido. La distribución de OpenTelemetry de Grafana, que registra de antemano decenas de fuentes, lo alcanzó de inmediato, como se reportó en el [issue #7787](https://github.com/open-telemetry/opentelemetry-dotnet/issues/7787):

```text
System.NotSupportedException : The specified pattern with RegexOptions.NonBacktracking
could result in an automata as large as '1285' nodes, which is larger than the configured
limit of '1000'.
   at OpenTelemetry.WildcardHelper.GetWildcardRegex(IEnumerable`1 patterns)
   at OpenTelemetry.Trace.TracerProviderSdk..ctor(IServiceProvider serviceProvider, Boolean ownsServiceProvider)
```

Fíjate en el disparador: un solo comodín en cualquier parte de la lista mete todos los nombres de fuentes en la regex. Una configuración como esta basta en `net8.0` cuando la lista es lo bastante larga:

```csharp
builder.Services.AddOpenTelemetry()
    .WithTracing(tracing => tracing
        .AddSource("MyCompany.Orders", "MyCompany.Billing", "MyCompany.Shipping")
        .AddSource(internalSourceNames)   // a few hundred names from config
        .AddSource("AWSSDK.*")            // one wildcard switches on regex mode
        .AddOtlpExporter());
```

Las compilaciones para `net9.0`, `net10.0` y .NET Framework no sufrieron la excepción. Sin embargo, sí sufrieron el costo: el PR señala que una `Regex` sin backtracking retiene aproximadamente 35 veces más memoria que una con backtracking, así que las suites de pruebas y los hosts que construyen muchos providers durante la vida del proceso podían toparse con `OutOfMemoryException`.

## Qué hace la 1.19.1 en su lugar

El [PR #7788](https://github.com/open-telemetry/opentelemetry-dotnet/pull/7788) elimina `NonBacktracking` en todos los target frameworks y vuelve a una regex compilada, manteniendo la protección mediante un tiempo de espera de coincidencia:

```csharp
var pattern = "^(?:" + convertedPattern + ")$";

return new Regex(pattern, RegexOptions.Compiled | RegexOptions.IgnoreCase, RegexMatchTimeout);
// RegexMatchTimeout = TimeSpan.FromSeconds(1)
```

`WildcardHelper.IsMatch` captura `RegexMatchTimeoutException` y devuelve `false`, así que un patrón patológico significa que una fuente deja de escucharse en lugar de un hilo colgado. El mismo cambio aplica a los nombres de instrumentos con comodines en `AddView`, que también usaba `NonBacktracking` en .NET moderno.

## Cómo actualizar

Actualiza todos los paquetes principales de OpenTelemetry a la vez, ya que versionan en sincronía:

```bash
dotnet add package OpenTelemetry.Extensions.Hosting --version 1.19.1
dotnet add package OpenTelemetry.Exporter.OpenTelemetryProtocol --version 1.19.1
```

Si estás en la 1.18.x, puedes saltarte la 1.19.0 por completo. Si ya desplegaste la 1.19.0 en `net8.0` y no lanzó la excepción, hoy estás por debajo del límite de nodos, pero agregar unas cuantas fuentes más después lo habría disparado al arrancar, así que actualiza de todos modos. Para repasar la configuración general, mi guía sobre [cómo usar OpenTelemetry con .NET 11 y un backend gratuito](/es/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) sigue siendo válida sin cambios.

La lección más amplia vale la pena recordarla: `RegexOptions.NonBacktracking` no es un interruptor de seguridad gratuito. Cambia el riesgo de backtracking por un límite de tamaño del autómata y un mayor consumo de memoria, y en .NET 8 ese límite es lo bastante pequeño como para alcanzarlo con una configuración ordinaria.
