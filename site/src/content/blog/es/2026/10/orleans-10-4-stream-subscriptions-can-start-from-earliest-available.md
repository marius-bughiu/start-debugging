---
title: "Orleans 10.4: las suscripciones a streams ahora pueden empezar desde el mensaje más antiguo en caché"
description: "Orleans 10.4.0 agrega StreamSubscriptionStartPosition.EarliestAvailable, para que un nuevo suscriptor de un stream pueda reproducir lo que aún queda en la caché de la cola del agente de extracción. La versión también cambia los IDs de los argumentos RPC en el wire, las métricas de latencia de solicitudes y los scripts de persistencia de SQLite."
pubDate: 2026-10-05
tags:
  - "orleans"
  - "dotnet"
  - "streaming"
  - "distributed-systems"
lang: "es"
translationOf: "2026/10/orleans-10-4-stream-subscriptions-can-start-from-earliest-available"
translatedBy: "claude"
translationDate: 2026-10-05
---

Orleans [v10.4.0](https://github.com/dotnet/orleans/releases/tag/v10.4.0) se lanzó el 3 de octubre de 2026. Las notas de la versión cubren mucho terreno (consistencia de la membresía en todos los proveedores de clustering, tokens de cancelación a través de las APIs del framework, codecs más amigables con NativeAOT, Hot Reload de serializadores opcional), pero el cambio que tocará la mayor parte del código de aplicación está en streaming: por fin puedes indicarle a una suscripción sin token dónde empezar.

## Lo que se perdía un suscriptor nuevo

Los suscriptores de streams persistentes en Orleans siempre han tenido dos modos. Pasas un `StreamSequenceToken` y un proveedor rebobinable reproduce desde ese punto. No pasas nada y obtienes entrega en vivo: lo que llegue después del handshake de suscripción. Todo lo que el agente de extracción ya tenía en su caché de cola para ese stream te resultaba invisible.

Esa brecha afecta a un caso común: un grain se activa en respuesta al primer evento de un stream, se suscribe y pierde justo ese evento, además de cualquier otro que haya llegado durante la activación. La solución alternativa era rastrear los tokens de secuencia por tu cuenta, algo que solo funciona si llegaste a ver un token.

## Suscribirse con EarliestAvailable

[PR #10936](https://github.com/dotnet/orleans/pull/10936) agrega el enum `StreamSubscriptionStartPosition` con dos valores, `Latest` (el valor predeterminado, igual que antes) y `EarliestAvailable`, además de sobrecargas de `SubscribeAsync` para observadores de elementos y de lotes:

```csharp
using Orleans.Streams;

public sealed class OrderProjectionGrain : Grain, IOrderProjectionGrain, IAsyncObserver<OrderEvent>
{
    public override async Task OnActivateAsync(CancellationToken cancellationToken)
    {
        var stream = this.GetStreamProvider("orders")
            .GetStream<OrderEvent>(StreamId.Create("orders", this.GetPrimaryKeyString()));

        await stream.SubscribeAsync(this, StreamSubscriptionStartPosition.EarliestAvailable);
    }

    public Task OnNextAsync(OrderEvent item, StreamSequenceToken? token = null) => Task.CompletedTask;
    public Task OnCompletedAsync() => Task.CompletedTask;
    public Task OnErrorAsync(Exception ex) => Task.CompletedTask;
}
```

`EarliestAvailable` empieza de forma inclusiva en el mensaje más antiguo que la caché de cola local todavía conserva para ese `StreamId`. Si no hay nada retenido, espera al siguiente mensaje. No llega hasta Event Hubs, SQS ni Azure Queues: la reproducción se limita a la caché y los checkpoints de los receptores no se tocan.

La precedencia es explícita: gana un token de secuencia concreto, luego la posición que pasas, luego el valor predeterminado del proveedor y por último `Latest`. El valor predeterminado del proveedor vive en `StreamPullingAgentOptions`, lo cual importa para el código heredado que se suscribe sin ningún argumento:

```csharp
siloBuilder.AddMemoryStreams("orders", streams =>
    streams.ConfigurePullingAgent(ob => ob.Configure(options =>
        options.InitialSubscriptionStartPosition =
            StreamSubscriptionStartPosition.EarliestAvailable)));
```

Las cachés integradas pooled, simple y de Event Hubs lo soportan. Un `IQueueCache` personalizado sin soporte hace fallar la suscripción de forma determinista en lugar de recurrir en silencio a la entrega en vivo. Durante una actualización gradual, actívalo solo después de que todos los silos que alojan agentes de extracción ejecuten 10.4.0.

## Tres notas de actualización que no debes omitir

La versión señala estos cambios como cambios de compatibilidad:

- **IDs de argumentos RPC**: los atributos `[Id]` a nivel de parámetro ahora controlan los IDs de los argumentos serializados, y los IDs automáticos cuentan solo los parámetros serializados. Si una interfaz de grain usa `[Id]` en parámetros o coloca `CancellationToken` en cualquier posición que no sea la última, el formato del wire difiere del de 10.3.1. Actualiza clientes y silos juntos o versiona el contrato.
- **Métricas**: la latencia de solicitudes ahora es un único `Histogram<double>` llamado `orleans-app-requests-latency` en milisegundos fraccionarios, que reemplaza a los instrumentos `-bucket`, `-count` y `-sum`. `orleans-grains` usa una dimensión `grain_type` en lugar de `type`. Los paneles y las alertas necesitan actualizarse.
- **Persistencia con SQLite**: vuelve a ejecutar los scripts `Sqlite-Main.sql` y `Sqlite-Persistence.sql` de 10.4.0 en las bases de datos existentes. Son idempotentes y corrigen la atomicidad bajo contención de escritores.

La [documentación de posiciones de inicio de suscripción](https://github.com/dotnet/orleans/blob/main/docs/site/src/content/docs/streaming/subscription-start-positions.md) tiene la semántica completa, y las notas de la versión enumeran los cambios en journaling y en la versión preliminar de Durable Jobs que se publican como `10.4.0-alpha.1`.
