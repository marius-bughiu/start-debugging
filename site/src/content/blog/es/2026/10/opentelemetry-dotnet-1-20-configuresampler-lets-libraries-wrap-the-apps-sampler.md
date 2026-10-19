---
title: "OpenTelemetry .NET 1.20: ConfigureSampler permite que las bibliotecas envuelvan el sampler de la aplicación"
description: "OpenTelemetry .NET 1.20.0, publicado el 15 de octubre de 2026, agrega TracerProviderBuilder.ConfigureSampler. Ahora una biblioteca puede envolver el sampler que el SDK resolvió a partir de SetSampler, OTEL_TRACES_SAMPLER o el valor predeterminado, en lugar de sobrescribirlo en silencio."
pubDate: 2026-10-19
tags:
  - "dotnet"
  - "opentelemetry"
  - "observability"
  - "tracing"
lang: "es"
translationOf: "2026/10/opentelemetry-dotnet-1-20-configuresampler-lets-libraries-wrap-the-apps-sampler"
translatedBy: "claude"
translationDate: 2026-10-19
---

[OpenTelemetry .NET 1.20.0](https://github.com/open-telemetry/opentelemetry-dotnet/releases/tag/core-1.20.0) se publicó el 15 de octubre de 2026. La mayor parte del changelog son correcciones (una fuga del contador de referencias de `SuppressInstrumentationScope`, `ResourceBuilder.CreateDefault` que ignoraba `OTEL_SERVICE_NAME` y dos condiciones de carrera en las métricas), pero una API nueva cambia la forma en que las bibliotecas y las distros deberían tocar el muestreo: `TracerProviderBuilder.ConfigureSampler`.

## SetSampler siempre fue "gana el último en escribir"

Hasta 1.19.x, la única forma de influir en el sampler de trazas era `SetSampler`. Un sampler programático tiene prioridad sobre la variable de entorno `OTEL_TRACES_SAMPLER`, que a su vez tiene prioridad sobre el valor predeterminado `ParentBased(AlwaysOnSampler)`. Esa precedencia está bien para el código de la aplicación, pero es hostil para las bibliotecas. Un paquete que quería descartar sus propios spans ruidosos tenía que llamar a `SetSampler`, y en cuanto lo hacía, el `OTEL_TRACES_SAMPLER=traceidratio` del operador se registraba como ignorado y se descartaba. Dos bibliotecas que hacían lo mismo entraban en conflicto en silencio: ganaba la que se registraba al final.

## Qué hace ConfigureSampler

[El PR #7780](https://github.com/open-telemetry/opentelemetry-dotnet/pull/7780) agrega un callback que recibe el sampler que el SDK ya resolvió y devuelve el que se usará:

```csharp
public static TracerProviderBuilder ConfigureSampler(
    this TracerProviderBuilder tracerProviderBuilder,
    Func<IServiceProvider, Sampler, Sampler> configureSampler);
```

Las reglas, según la documentación XML:

- Los callbacks se ejecutan después de que el SDK elige un sampler a partir de `SetSampler`, `OTEL_TRACES_SAMPLER` o el valor predeterminado, sin importar si se registran antes o después de `SetSampler`.
- Cada callback se ejecuta una sola vez, durante `Build()`. Después, el sampler del proveedor permanece inmutable.
- Varios callbacks se encadenan en orden de registro, y cada uno recibe el resultado del anterior.
- Devolver `null` o lanzar una excepción hace fallar la compilación del proveedor.

Así, una biblioteca puede decorar lo que la aplicación haya configurado en lugar de reemplazarlo:

```csharp
public sealed class DropPollingSpansSampler(Sampler inner) : Sampler
{
    public override SamplingResult ShouldSample(in SamplingParameters parameters)
    {
        // The library's background poll loop creates a span every second.
        if (parameters.Name == "MyLibrary.Poll")
        {
            return new SamplingResult(SamplingDecision.Drop);
        }

        return inner.ShouldSample(parameters);
    }
}

public static class MyLibraryTracingExtensions
{
    public static TracerProviderBuilder AddMyLibrary(this TracerProviderBuilder builder) =>
        builder
            .AddSource("MyLibrary")
            .ConfigureSampler((_, resolved) => new DropPollingSpansSampler(resolved));
}
```

Con `OTEL_TRACES_SAMPLER=traceidratio` y `OTEL_TRACES_SAMPLER_ARG=0.1` definidos, la aplicación sigue muestreando el 10% de las trazas, y la biblioteca solo descarta sus spans de sondeo antes de esa decisión. Cambia la variable de entorno por un `SetSampler(new AlwaysOnSampler())` explícito en `Program.cs` y el wrapper también lo toma, sin juegos con el orden.

## La advertencia sobre la liberación de recursos

El proveedor solo libera (dispose) el sampler final. Si tu callback descarta el sampler que recibe, o lo envuelve, tú eres responsable del ciclo de vida del sampler interno. Para samplers sin estado como `TraceIdRatioBasedSampler` esto no importa. Para cualquier cosa que mantenga un temporizador o una conexión de configuración remota, reenvía `Dispose` desde tu wrapper.

## Quién debería migrar

Si mantienes una biblioteca o una distro interna que hoy llama a `SetSampler`, pasa a `ConfigureSampler` para dejar de sobrescribir la configuración del operador. El código de la aplicación puede seguir usando `SetSampler`, que conserva el lugar de mayor precedencia. El PR también presenta esto como base para el muestreo controlado de forma remota y la configuración declarativa, donde la elección del sampler sale por completo del código.

Actualiza los paquetes principales en conjunto, ya que comparten versión:

```bash
dotnet add package OpenTelemetry.Extensions.Hosting --version 1.20.0
dotnet add package OpenTelemetry.Exporter.OpenTelemetryProtocol --version 1.20.0
```

Si te saltaste el parche anterior, la [corrección de la regex con comodines de 1.19.1](/es/2026/09/opentelemetry-dotnet-1-19-1-fixes-wildcard-notsupportedexception-on-net-8/) también está incluida.
