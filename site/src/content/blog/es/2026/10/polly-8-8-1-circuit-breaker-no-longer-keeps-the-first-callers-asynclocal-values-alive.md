---
title: "Polly 8.8.1: el circuit breaker ya no mantiene vivos los valores AsyncLocal del primer llamador"
description: "Polly.Core 8.8.1 inicia el bucle en segundo plano del circuit breaker bajo ExecutionContext.SuppressFlow, así que un pipeline de larga vida deja de retener los valores AsyncLocal de quien lo construyó. Una reproducción de 15 líneas muestra la fuga en 8.8.0 y la corrección en 8.8.1."
pubDate: 2026-10-27
tags:
  - "polly"
  - "resilience"
  - "dotnet"
  - "csharp"
  - "memory-leaks"
lang: "es"
translationOf: "2026/10/polly-8-8-1-circuit-breaker-no-longer-keeps-the-first-callers-asynclocal-values-alive"
translatedBy: "claude"
translationDate: 2026-10-27
---

[Polly 8.8.1](https://github.com/App-vNext/Polly/releases/tag/8.8.1) salió el 2026-10-26, y la corrección principal es una fuga de memoria que es fácil tener sin saberlo. Cada estrategia de circuit breaker construida con Polly.Core 8.8.0 o anterior mantenía vivo el `ExecutionContext` del código que la construyó durante toda la vida del pipeline. Eso incluye cada valor `AsyncLocal<T>` que estuviera asignado en ese momento.

## Por qué un circuit breaker capturaba tu contexto

El circuit breaker usa un `ScheduledTaskExecutor` interno para ejecutar sus callbacks de cambio de estado (`OnOpened`, `OnClosed`, `OnHalfOpened`) fuera de la ruta crítica. Su constructor iniciaba un bucle de procesamiento con `Task.Run(StartProcessingAsync)`. `Task.Run` propaga el `ExecutionContext` actual por defecto, y el bucle luego espera en un `SemaphoreSlim` hasta que el pipeline se libera.

Así que quien disparara la construcción donaba su estado ambiental a una tarea que nunca termina. Para un pipeline en un `ResiliencePipelineRegistry`, o uno que `Microsoft.Extensions.Http.Resilience` construye para un `HttpClient` con nombre, "la vida del pipeline" significa la vida de la aplicación. El [issue #3275](https://github.com/App-vNext/Polly/issues/3275) describe el peor caso: en una aplicación Blazor Server, el circuito del primer usuario construye el pipeline, un accessor basado en `AsyncLocal` lleva los servicios de ese circuito, y el circuito nunca se recolecta después de que el usuario se va.

## Reproducirlo en una aplicación basada en archivo

Esto funciona tal cual con `dotnet run repro.cs` en el SDK de .NET 10. Cambia la versión del paquete para comparar:

```csharp
#:package Polly.Core@8.8.0
using System.Runtime.CompilerServices;
using Polly;

AsyncLocal<object?> current = new();

var (pipeline, value) = Build();
for (int i = 0; i < 3; i++) { GC.Collect(); GC.WaitForPendingFinalizers(); }
GC.KeepAlive(pipeline);
Console.WriteLine($"alive: {value.IsAlive}");

[MethodImpl(MethodImplOptions.NoInlining)]
(ResiliencePipeline, WeakReference) Build()
{
    object payload = new byte[1024];
    current.Value = payload; // whatever the first caller's flow carries
    var p = new ResiliencePipelineBuilder().AddCircuitBreaker(new()).Build();
    current.Value = null;
    return (p, new WeakReference(payload));
}
```

En mi máquina (SDK 10.0.302), `Polly.Core@8.8.0` imprime `alive: True` y `Polly.Core@8.8.1` imprime `alive: False`. Limpiar el `AsyncLocal` después no ayuda en 8.8.0, porque la tarea en segundo plano guarda una instantánea del contexto tomada cuando arrancó, no una vista en vivo de él.

## La corrección

El [PR #3284](https://github.com/App-vNext/Polly/pull/3284) son tres líneas:

```csharp
public ScheduledTaskExecutor()
{
    using (ExecutionContext.SuppressFlow())
    {
        ProcessingTask = Task.Run(StartProcessingAsync);
    }
}
```

Hay un cambio de comportamiento que debes conocer: tus callbacks de cambio de estado ya no ven los valores `AsyncLocal` del constructor del pipeline. De todos modos nunca vieron de forma confiable los valores de la petición que realmente disparó el breaker, solo los del código que construyó el pipeline. Si dependías de eso, por ejemplo leyendo `Activity.Current` o un accessor de tenant dentro de `OnOpened`, pasa lo que necesites a través de `ResilienceContext` o de los argumentos del callback.

## Qué hacer

Actualiza `Polly.Core` (y `Polly.Extensions` si lo referencias directamente) a 8.8.1. `Microsoft.Extensions.Http.Resilience` trae Polly de forma transitiva, así que agrega una referencia explícita si tu archivo de bloqueo sigue en 8.8.0:

```xml
<PackageReference Include="Polly.Core" Version="8.8.1" />
```

Si todavía no puedes actualizar, la solución alternativa del issue es construir los pipelines de forma anticipada al arranque dentro de `ExecutionContext.SuppressFlow()`, antes de que cualquier petición pueda ser la que los construya.

La misma versión también acelera la ejecución de pipelines ([#3287](https://github.com/App-vNext/Polly/pull/3287)) y corrige un hueco de limpieza relacionado en el registro ([#3288](https://github.com/App-vNext/Polly/pull/3288)): cuando dos llamadores competían por inicializar la misma clave, el pipeline perdedor se descartaba pero conservaba sus recursos y registros de recarga. Ahora pasa por la misma ruta de liberación asíncrona que usan las recargas, lo cual importa si adoptaste [`EnableReloadsWithMonitor` de Polly 8.8](/es/2026/09/polly-8-8-reloads-a-resilience-pipeline-from-your-own-ioptionsmonitor/).
