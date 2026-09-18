---
title: "Polly 8.8 recarga un pipeline de resiliencia desde tu propio IOptionsMonitor"
description: "Polly 8.8.0 agrega EnableReloadsWithMonitor, para que un pipeline de resiliencia se recargue en caliente desde un monitor de feature flags o de configuración remota que no está registrado en DI. Una prueba muestra la reconstrucción, y hay una trampa: context.GetOptions sigue leyendo el monitor de DI y devuelve valores por defecto."
pubDate: 2026-09-18
tags:
  - "polly"
  - "resilience"
  - "dotnet"
  - "csharp"
  - "configuration"
lang: "es"
translationOf: "2026/09/polly-8-8-reloads-a-resilience-pipeline-from-your-own-ioptionsmonitor"
translatedBy: "claude"
translationDate: 2026-09-18
---

[Polly 8.8.0](https://github.com/App-vNext/Polly/releases/tag/8.8.0) salió el 2026-09-14, y su cambio principal es pequeño pero cubre un hueco real en `Polly.Extensions`. Hasta ahora, la única forma de recargar en caliente un pipeline de resiliencia registrado en DI era `context.EnableReloads<TOptions>()`, que resuelve `IOptionsMonitor<TOptions>` desde el contenedor. Si tus conteos de reintentos o tus timeouts vienen de un SDK de feature flags, de un cliente de configuración remota o de un monitor que construyes tú mismo, tenías que registrarlo primero en DI o renunciar a las recargas.

## La nueva sobrecarga

[PR #3140](https://github.com/App-vNext/Polly/pull/3140) agrega `EnableReloadsWithMonitor<TOptions>(IOptionsMonitor<TOptions> monitor, string? name = null)` en `AddResiliencePipelineContext<TKey>`. El antiguo `EnableReloads<TOptions>()` ahora es una sola línea que resuelve el monitor desde DI y llama al nuevo método. Ambos terminan en el mismo lugar: el registro se suscribe a `monitor.OnChange` y reconstruye el pipeline cuando se dispara.

Esta es una versión mínima con un monitor hecho a mano que hace las veces de servicio de flags:

```csharp
var flags = new FlagMonitor<RetryFlags>(new RetryFlags { MaxRetries = 1 });

services.AddResiliencePipeline("orders", (builder, context) =>
{
    context.EnableReloadsWithMonitor(flags);

    var opts = flags.CurrentValue;
    builder.AddRetry(new() { MaxRetryAttempts = opts.MaxRetries, Delay = TimeSpan.Zero });
});

public sealed class FlagMonitor<T>(T initial) : IOptionsMonitor<T>
{
    private readonly List<Action<T, string?>> _listeners = [];
    public T CurrentValue { get; private set; } = initial;
    public T Get(string? name) => CurrentValue;

    public IDisposable OnChange(Action<T, string?> listener)
    {
        _listeners.Add(listener);
        return new Unsub(() => _listeners.Remove(listener));
    }

    public void Set(T value)
    {
        CurrentValue = value;
        foreach (var l in _listeners.ToArray()) l(value, Options.DefaultName);
    }

    private sealed class Unsub(Action a) : IDisposable { public void Dispose() => a(); }
}
```

Lo ejecuté como una aplicación basada en archivo con el SDK 10.0.302 contra `Polly.Extensions` 8.8.0. El pipeline siempre lanza una excepción, así que el número de intentos muestra la configuración de reintentos que está activa:

```text
building pipeline with MaxRetries=1
attempts: 2
building pipeline with MaxRetries=4
attempts after change: 5
same instance: True
```

Después de `flags.Set(...)`, el callback de configuración se ejecutó de nuevo y la siguiente llamada hizo cinco intentos. El `ResiliencePipeline` que obtuviste de `GetPipeline("orders")` sigue siendo el mismo objeto. Polly reemplaza el pipeline interno detrás de él, así que el código que guardó el pipeline en un campo recibe el cambio sin tener que pedirlo otra vez. En 8.7.0 el mismo archivo falla con CS1061, porque el método no existe ahí.

## La trampa de GetOptions

El callback de configuración también tiene `context.GetOptions<TOptions>()`, y es tentador usarlo junto al nuevo método. No lo hagas. `GetOptions` sigue resolviendo `IOptionsMonitor<TOptions>` desde el contenedor, y `AddResiliencePipeline` registra la infraestructura de options, así que no lanza ninguna excepción. Te entrega una instancia construida por defecto. En la prueba, `context.GetOptions<RetryFlags>().MaxRetries` devolvió `0` en ambas compilaciones del pipeline, mientras que el monitor personalizado decía `1` y luego `4`. Un pipeline construido con ese valor habría dejado de reintentar sin avisar.

Cuando pases tu propio monitor, lee los valores de ese mismo monitor (`flags.CurrentValue` o `flags.Get(name)`) dentro del callback.

## También en 8.8.0

[PR #3220](https://github.com/App-vNext/Polly/pull/3220) corrige un bug de Simmy: un `FaultGenerator` vacío, o uno cuyos pesos suman cero, lanzaba `InvalidOperationException: Nullable object must have a value` en lugar de no inyectar nada. Ahora el generador devuelve `null` y la estrategia de caos deja pasar la llamada. La versión también incluye trabajo de "preparación para .NET 11" y una migración a xunit v3 en la suite de pruebas.

Si todavía necesitas decidir si quieres pipelines de Polly o handlers de `Microsoft.Extensions.Http.Resilience`, [Polly vs resilience handlers en .NET 11](/es/2026/05/polly-vs-resilience-handlers-in-dotnet-11/) explica las ventajas y desventajas.
