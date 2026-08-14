---
title: "Microsoft.Extensions.AI 10.9 trae clientes de chat con enrutamiento y failover"
description: "Microsoft.Extensions.AI 10.9.0 agrega RoutingChatClient, OrderedFailoverChatClient y SemanticRoutingChatClient. Verificado contra el paquete real: qué hace failover, qué no, y por qué MEAI001 rompe tu compilación."
pubDate: 2026-08-14
tags:
  - "dotnet"
  - "ai"
  - "microsoft-extensions-ai"
  - "resilience"
  - "csharp"
lang: "es"
translationOf: "2026/08/microsoft-extensions-ai-10-9-routing-and-failover-chat-clients"
translatedBy: "claude"
translationDate: 2026-08-14
---

El 2026-08-13 el equipo de .NET publicó [Routing and Failover for Microsoft.Extensions.AI](https://devblogs.microsoft.com/dotnet/routing-and-failover-for-microsoft-extensions-ai/). Lo interesante es que los tipos ya están en NuGet dentro de `Microsoft.Extensions.AI` 10.9.0, así que puedes usarlos hoy mismo. Hasta ahora, enviar una solicitud a un modelo barato y caer en uno más grande implicaba escribir a mano un envoltorio `try`/`catch` alrededor de `IChatClient`. Ahora hay cuatro tipos que lo hacen: `RoutingChatClient` y `RoutingContext` en `Microsoft.Extensions.AI.Abstractions`, más `FailoverChatClient`, `OrderedFailoverChatClient` y `SemanticRoutingChatClient` en `Microsoft.Extensions.AI`.

## Una lista ordenada de clientes ahora son dos líneas

`OrderedFailoverChatClient` recorre una lista hasta que uno responda. Su constructor es `(IReadOnlyList<IChatClient> clients, bool leaveOpen = false)`, así que pasa `leaveOpen: true` cuando el contenedor es dueño de los clientes internos:

```csharp
using var failover = new OrderedFailoverChatClient(
    [primaryClient, backupClient, lastResortClient],
    leaveOpen: true);

ChatResponse response = await failover.GetResponseAsync(
    [new ChatMessage(ChatRole.User, "hi")]);
```

Si todos los clientes lanzan una excepción, recibes la última, no una agregada. Vale la pena saberlo antes de escribir un bloque `catch` que espere `AggregateException`.

## La regla de streaming que te va a morder

El failover no es gratis en las llamadas de streaming. El bucle de reintentos solo vuelve a seleccionar un cliente mientras nada se haya entregado a quien llama. Ejecuté tres casos contra un cliente falso para confirmarlo:

- El cliente primario sin streaming lanza una excepción: `SelectClientAsync` se ejecuta de nuevo, el de respaldo responde y quien llama nunca ve la falla.
- El cliente primario con streaming lanza una excepción antes del primer `ChatResponseUpdate`: lo mismo, un cambio limpio al de respaldo.
- El cliente primario con streaming lanza una excepción después de haber emitido dos actualizaciones: la excepción aparece a mitad de la enumeración y los dos fragmentos parciales quedan consumidos.

Ese tercer caso es el que hay que tener en cuenta al diseñar. Una vez que `FailoverChatClientAttempt.OutputCommitted` es `true`, no hay recuperación a mitad del stream, así que una interfaz que va agregando tokens conforme llegan necesita su propio manejo de truncamiento.

## Enrutar por costo, o por significado

Para cualquier cosa que no sea una lista ordenada, `RoutingChatClient.Create` recibe un callback:

```csharp
using var router = RoutingChatClient.Create((context, ct) =>
    new ValueTask<IChatClient>(
        context.Messages.Last().Text.Length > 20 ? powerfulClient : cheapClient));
```

`RoutingContext` expone solo `Messages` y `ChatOptions`, lo que basta para enrutar según `AdditionalProperties` en sesiones persistentes. Hereda de `FailoverChatClient` si además quieres el bucle de reintentos, y define `MaximumAttemptsPerRequest` (un `int?`) para limitarlo.

`SemanticRoutingChatClient` elige por similitud de embeddings. La firma completa tiene más opciones de las que muestra el artículo original:

```csharp
SemanticRoutingChatClient(
    IEmbeddingGenerator<string, Embedding<float>> embeddingGenerator,
    IReadOnlyDictionary<IChatClient, IReadOnlyList<string>> clientProfiles,
    IChatClient defaultClient,
    float scoreThreshold = 0.3f,
    int topK = 1,
    ScoreAggregation scoreAggregation = ScoreAggregation.Mean,
    bool leaveOpen = false)
```

`ScoreAggregation` es `Mean` o `Sum`, y todo lo que quede por debajo de `scoreThreshold` termina en `defaultClient`.

## MEAI001 es un error, no una advertencia

Todos estos tipos llevan `[Experimental("MEAI001")]`, y el compilador lo trata como error de forma predeterminada:

```
error MEAI001: 'Microsoft.Extensions.AI.OrderedFailoverChatClient' is for evaluation
purposes only and is subject to change or removal in future updates.
```

Agrega `<NoWarn>MEAI001</NoWarn>` a tu csproj para aceptarlo. Dado que la forma de la API todavía se mueve, mantén la decisión de enrutamiento detrás de tu propia interfaz. Si sigues con el SDK del proveedor sin capas intermedias, la [migración a Microsoft.Extensions.AI](https://startdebugging.net/2026/07/migrate-from-openai-sdk-to-microsoft-extensions-ai/) es el requisito previo para todo esto.
