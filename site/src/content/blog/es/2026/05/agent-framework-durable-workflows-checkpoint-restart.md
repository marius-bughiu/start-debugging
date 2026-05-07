---
title: "Los workflows de Microsoft Agent Framework ahora sobreviven a reinicios de proceso gracias al stack Durable Task"
description: "Envuelve un Workflow de Agent Framework en Microsoft.Agents.AI.DurableTask y cada paso de ejecutor queda con checkpoint. Caída, redeploy, reinicio: la ejecución continúa donde se detuvo."
pubDate: 2026-05-07
tags:
  - "dotnet"
  - "ai-agents"
  - "agent-framework"
  - "csharp"
  - "durable-task"
lang: "es"
translationOf: "2026/05/agent-framework-durable-workflows-checkpoint-restart"
translatedBy: "claude"
translationDate: 2026-05-07
---

Shyju Krishnankutty publicó [Durable Workflows in Microsoft Agent Framework](https://devblogs.microsoft.com/dotnet/durable-workflows-in-microsoft-agent-framework/) en el .NET Blog el 2026-05-06. El titular es que el modelo de programación de workflows de `Microsoft.Agents.AI.Workflows` ahora se conecta al stack Durable Task a través del paquete preliminar `Microsoft.Agents.AI.DurableTask`, de modo que una ejecución multi-paso de un agente puede hacer checkpoint después de cada ejecutor y reanudarse en otro proceso tras una caída, un evento de escalado o un redeploy. Esta es la pieza que faltaba para llevar un pipeline multi-agente de una demo en consola a algo que realmente puedas hospedar.

## La parte que ya existía

Un workflow es un grafo dirigido de nodos `Executor<TInput, TOutput>` cableados con `WorkflowBuilder`. Esta parte está en el paquete estable [Microsoft.Agents.AI.Workflows](https://www.nuget.org/packages/Microsoft.Agents.AI.Workflows) y no es nueva:

```csharp
using Microsoft.Agents.AI.Workflows;

Workflow cancelOrder = new WorkflowBuilder(orderLookup)
    .WithName("CancelOrder")
    .AddEdge(orderLookup, orderCancel)
    .AddEdge(orderCancel, sendEmail)
    .Build();

await foreach (var evt in InProcessExecution.RunStreamingAsync(cancelOrder, orderId))
{
    Console.WriteLine(evt);
}
```

`InProcessExecution.RunStreamingAsync` ejecuta el grafo en memoria. Si el host muere entre `orderCancel` y `sendEmail`, el pedido queda cancelado, el cliente nunca recibe el correo, y no hay registro de reintentos. Suficiente para muestras, peligroso para cualquier cosa que toque dinero.

## Qué cambió el 2026-05-06

`Microsoft.Agents.AI.DurableTask` permite ejecutar el mismo workflow sobre Durable Task. Cada invocación de ejecutor se convierte en una actividad Durable, así que el progreso queda con checkpoint tras cada nodo y el runtime reproduce el historial al reiniciar. Del anuncio: "Stateful, durable execution: workflows survive process restarts and failures" y "automatic checkpointing: progress is saved after each step".

Combinado con `Microsoft.Agents.AI.Hosting.AzureFunctions` y los paquetes `Microsoft.DurableTask.Client.AzureManaged` / `Microsoft.DurableTask.Worker.AzureManaged` apuntando a Durable Task Scheduler, un host de Azure Functions genera por ti el trigger HTTP, el orquestador y las funciones de actividad:

```csharp
var builder = FunctionsApplication.CreateBuilder(args);

builder.ConfigureDurableWorkflows(workflows =>
{
    workflows.AddWorkflow("CancelOrder", sp => BuildCancelOrderWorkflow(sp),
        exposeMcpToolTrigger: true);
});

builder.Build().Run();
```

`exposeMcpToolTrigger: true` es el detalle que merece destacarse por sí solo: el workflow aparece como una herramienta MCP, así que un agente Claude o Copilot puede llamar `CancelOrder` y el runtime durable se encarga del resto.

## Patrones que se vuelven más útiles cuando la durabilidad está activa

Tres características de los workflows que eran un agradable extra en proceso pasan a ser cruciales una vez que la ejecución puede durar horas:

- `AddFanOutEdge()` y `AddFanInBarrierEdge()` para subtareas en paralelo (por ejemplo, enriquecer un pedido desde tres sistemas y luego unificar), ahora reanudables de forma segura.
- `RequestPort.Create<TRequest, TResponse>()` para humano en el bucle. El workflow se aparca, persiste y solo despierta cuando llega la respuesta. Horas, días, lo que haga falta.
- `AddSwitch()` para enrutado condicional en función de la salida de un ejecutor previo, que es un patrón mucho más seguro que dejar que el LLM elija la siguiente rama.

El paquete `Microsoft.Agents.AI.DurableTask` aún es preliminar, así que fija la versión de forma explícita y vigila el [feed de Microsoft Agent Framework DevBlogs](https://devblogs.microsoft.com/agent-framework/) para detectar cambios disruptivos antes de la GA.
