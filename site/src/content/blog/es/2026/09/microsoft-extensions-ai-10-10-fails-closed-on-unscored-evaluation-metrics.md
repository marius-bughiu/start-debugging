---
title: "Microsoft.Extensions.AI 10.10 marca como fallidas las métricas de evaluación que el juez nunca puntuó"
description: "Microsoft.Extensions.AI.Evaluation.Quality 10.10.0 ahora marca como fallidas las puntuaciones de calidad que no se pueden analizar o que están fuera de rango, y Microsoft.Extensions.AI.OpenAI 10.10.0 elimina el adaptador de Assistants. Medido antes y después sobre 10.9.0."
pubDate: 2026-09-15
tags:
  - "dotnet"
  - "ai"
  - "microsoft-extensions-ai"
  - "testing"
  - "csharp"
lang: "es"
translationOf: "2026/09/microsoft-extensions-ai-10-10-fails-closed-on-unscored-evaluation-metrics"
translatedBy: "claude"
translationDate: 2026-09-15
---

Las [notas de la versión v10.10.0](https://github.com/dotnet/extensions/releases/tag/v10.10.0) de `dotnet/extensions` se publicaron el 14 de septiembre de 2026 (los paquetes llegaron a NuGet el 9 de septiembre). La mayor parte es infraestructura, pero dos cambios pueden alterar lo que hace tu compilación: los evaluadores de calidad ahora fallan de forma cerrada, y el adaptador de OpenAI Assistants desapareció. Si condicionas tu CI a los resultados de evaluación de IA, el primero puede poner en rojo un pipeline que estaba en verde, y ese es el resultado correcto.

## Un juez que no dice nada ya no cuenta como aprobado

`CoherenceEvaluator`, `FluencyEvaluator`, `RelevanceEvaluator` y el resto de `Microsoft.Extensions.AI.Evaluation.Quality` le piden a un LLM juez una puntuación de 1 a 5 y la interpretan por su cuenta. Hasta 10.9.0, la interpretación solo marcaba una métrica como fallida cuando el valor se analizaba como un número menor que 4.0. Cuando el juez devolvía texto sin puntuación, `metric.Value` era `null`, la calificación pasaba a `Inconclusive` y `Failed` seguía en `false`. Una puntuación de 6 seguía el mismo camino. Cualquier pipeline que revisara "¿falló algo?" leía como verde una métrica que nunca se puntuó.

El [PR #7735](https://github.com/dotnet/extensions/pull/7735) (que corrige el [issue #7665](https://github.com/dotnet/extensions/issues/7665)) cierra ese hueco. Ejecuté la misma prueba contra ambas versiones, con un `IChatClient` de respuestas predefinidas como juez:

```csharp
var result = await new CoherenceEvaluator().EvaluateAsync(
    new ChatMessage(ChatRole.User, "What is 2+2?"),
    new ChatResponse(new ChatMessage(ChatRole.Assistant, "4")),
    new ChatConfiguration(new CannedJudge(reply)));

var m = result.Get<NumericMetric>(CoherenceEvaluator.CoherenceMetricName);
Console.WriteLine($"value={m.Value} rating={m.Interpretation?.Rating} failed={m.Interpretation?.Failed}");
```

| Respuesta del juez | 10.9.0 | 10.10.0 |
| --- | --- | --- |
| `<S2>5</S2>` | Excepcional, no falla | Excepcional, no falla |
| `<S2>3</S2>` | Promedio, falla | Promedio, falla |
| `<S2>6</S2>` | No concluyente, **no falla** | No concluyente, falla: "Coherence is outside the valid range." |
| "I am unable to evaluate this response." | No concluyente, **no falla** | No concluyente, falla: "Coherence has no score." |

Las puntuaciones dentro de la escala se comportan exactamente igual que antes, incluido el límite de 4.0. Lo que cambia es que un juez inestable, limitado por tasa o mal configurado ahora aparece como una falla en lugar de esconderse detrás de un aprobado. Si tu ejecución nocturna de pronto reporta fallas después de actualizar, revisa primero el texto de `Reason`: "has no score" apunta al modelo juez, no a tu aplicación.

La corrección se limita al paquete Quality. El PR señala que `InterpretContentSafetyScore` e `InterpretContentHarmScore` del paquete Safety y la interpretación de puntuaciones del paquete NLP tienen la misma forma y no se tocaron, así que no des por hecho que esos ya fallan de forma cerrada.

## El adaptador de Assistants se eliminó, no se marcó como obsoleto

OpenAI apagó la API de Assistants el 26 de agosto de 2026, y el [PR #7724](https://github.com/dotnet/extensions/pull/7724) eliminó la superficie experimental correspondiente de `Microsoft.Extensions.AI.OpenAI`: las dos sobrecargas de `AssistantClient.AsIChatClient(...)`, `OpenAIAssistantsChatClient` y `AsOpenAIAssistantsFunctionToolDefinition`. El paquete `OpenAI` 2.13.0 todavía incluye `AssistantClient`, así que la actualización falla en tiempo de compilación y no en la restauración:

```text
error CS1929: 'AssistantClient' does not contain a definition for 'AsIChatClient' and the best extension method overload 'OpenAIClientExtensions.AsIChatClient(ResponsesClient, string?)' requires a receiver of type 'OpenAI.Responses.ResponsesClient'
```

El reemplazo es el cliente de Responses: las instrucciones pasan a `ChatOptions` y el id de conversación ocupa el lugar del id de hilo. Esto compila contra 10.10.0:

```csharp
IChatClient chat = new OpenAIClient(apiKey)
    .GetResponsesClient()
    .AsIChatClient("gpt-5-mini");

var options = new ChatOptions
{
    Instructions = "You are the support assistant for Contoso.",
    ConversationId = conversationId, // previous response id, replaces the thread id
};

ChatResponse response = await chat.GetResponseAsync("Where is my order?", options);
```

Como los endpoints ya devuelven errores, cualquier código que siguiera en ese camino ya estaba roto en producción desde hace dos semanas. El error de compilación solo lo hace visible.

El resto de 10.10.0 es menor: `OpenAI` pasa a 2.13.0, los valores de `detail` de imagen no soportados ya no lanzan `ArgumentNullException`, y el almacén de resultados de Azure Storage valida los segmentos de ruta. Si adoptaste los clientes de enrutamiento de [Microsoft.Extensions.AI 10.9](/es/2026/08/microsoft-extensions-ai-10-9-routing-and-failover-chat-clients/), esta es una actualización segura, siempre que estés listo para que la puerta de evaluación empiece a decir la verdad.
