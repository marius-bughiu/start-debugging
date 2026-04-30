---
title: "SwitchMediator v3: un mediador con cero asignaciones que sigue siendo amigable con AOT"
description: "SwitchMediator v3 apunta a un dispatch sin asignaciones y compatible con AOT para servicios CQRS en .NET 9 y .NET 10. Esto es lo que significa y cómo medir tu propio mediador."
pubDate: 2026-01-08
tags:
  - "dotnet"
  - "dotnet-10"
lang: "es"
translationOf: "2026/01/switchmediator-v3-a-zero-alloc-mediator-that-stays-friendly-to-aot"
translatedBy: "claude"
translationDate: 2026-04-30
---
Si alguna vez perfilaste un código CQRS "limpio" y descubriste muerte por mil asignaciones en la capa del mediador, vale la pena mirar el lanzamiento de hoy de **SwitchMediator v3**. El autor habla explícitamente de comportamiento **sin asignaciones** y **amigable con AOT**, que es justo la combinación que quieres en servicios .NET 9 y .NET 10 que se preocupan por la latencia.

## Dónde fugan asignaciones las implementaciones típicas de mediadores

Hay algunos patrones comunes que asignan en silencio:

-   **Boxing y dispatch por interfaz**: especialmente cuando los handlers se almacenan como `object` y se castean por solicitud.
-   **Listas de pipeline behaviors**: asignan enumeradores, closures y listas intermedias.
-   **Descubrimiento de handlers por reflexión**: cómodo, pero mala combinación con trimming y native AOT.

Un mediador amigable con AOT suele hacer lo contrario: hace explícita la registración de handlers y mantiene la lógica de dispatch basada en tipos genéricos conocidos, no en reflexión en tiempo de ejecución.

## Un pequeño arnés de benchmark "antes vs después"

Aun si no adoptas SwitchMediator, deberías medir el límite de tu mediador. Este es un arnés mínimo que puedes meter en una app de consola que apunte a **.NET 10** para entender tu línea base.

```cs
using BenchmarkDotNet.Attributes;
using BenchmarkDotNet.Running;

public static class Program
{
    public static void Main() => BenchmarkRunner.Run<MediatorBench>();
}

public sealed record Ping(int Value);
public sealed record Pong(int Value);

public interface IMediator
{
    ValueTask<Pong> Send(Ping request, CancellationToken ct = default);
}

public sealed class MediatorBench
{
    private readonly IMediator _mediator = /* wire your mediator here */;

    [Benchmark]
    public async ValueTask<Pong> SendPing() => await _mediator.Send(new Ping(123));
}
```

Lo que busco:

-   **Bytes asignados por operación** deberían estar cerca de cero para solicitudes triviales.
-   **El throughput** debería escalar con el trabajo del handler, no con el overhead del dispatch.

Si ves asignaciones en el camino del dispatch, normalmente las encuentras cambiando el tipo de retorno a `ValueTask` (como arriba) y manteniendo los tipos de request/response como records o structs que sean predecibles para el JIT.

## Amigable con AOT suele significar "explícito"

Si estás experimentando con native AOT en **.NET 10**, los mediadores cargados de reflexión son una de las primeras cosas que se rompen.

La compensación arquitectónica es simple:

-   **Escaneo por reflexión**: gran experiencia de desarrollador, mala historia de trimming/AOT.
-   **Registración explícita**: un poco más de setup, pero predecible y amigable con el trimming.

La propuesta de SwitchMediator sugiere que se inclina hacia el extremo explícito del espectro. Eso encaja con cómo encaro el trabajo de rendimiento: prefiero unas pocas líneas más de cableado si me dan comportamiento predecible en producción.

Si quieres los detalles, parte del hilo del anuncio y sigue el enlace al repositorio desde allí: [https://www.reddit.com/r/dotnet/comments/1q6yl0n/switchmediator\_v3\_is\_out\_now\_a\_zeroalloc/](https://www.reddit.com/r/dotnet/comments/1q6yl0n/switchmediator_v3_is_out_now_a_zeroalloc/)
