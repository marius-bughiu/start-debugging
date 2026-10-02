---
title: "Agent Framework 1.23: el middleware de funciones por fin puede cambiar la herramienta que invoca"
description: "Microsoft Agent Framework .NET 1.23.0 respeta las asignaciones a FunctionInvocationContext.Function, así que un middleware puede redirigir una llamada de herramienta a otra AIFunction. El nuevo helper WrapWithPendingMiddleware mantiene al resto de la cadena involucrado."
pubDate: 2026-10-02
tags:
  - "agent-framework"
  - "dotnet"
  - "ai-agents"
  - "microsoft-extensions-ai"
lang: "es"
translationOf: "2026/10/agent-framework-1-23-function-middleware-can-now-swap-the-tool"
translatedBy: "claude"
translationDate: 2026-10-02
---

Microsoft Agent Framework [dotnet-1.23.0](https://github.com/microsoft/agent-framework/releases/tag/dotnet-1.23.0) salió el 1 de octubre de 2026 con una larga lista de correcciones y cinco cambios marcados como BREAKING. El que quiero destacar no está marcado, porque los mantenedores lo tratan como una corrección de bug: [PR #8615](https://github.com/microsoft/agent-framework/pull/8615) hace que el middleware de funciones realmente pueda reemplazar la función que está a punto de invocar.

## El setter que no hacía nada

El middleware de llamadas a funciones registrado con `AIAgentBuilder.Use(...)` recibe un `FunctionInvocationContext`. Su propiedad `Function` tiene un setter público, y nada te impedía asignar otra `AIFunction` antes de llamar a `next`. Hasta la 1.22, esa asignación se ignoraba en silencio. Los cambios en `context.Arguments` sí se respetaban, pero la continuación siempre invocaba la función que el wrapper había capturado al construir la lista de herramientas.

Eso bloqueaba toda una clase de patrones: enrutar una llamada riesgosa a una implementación protegida, cambiar la implementación por tenant en tiempo de ejecución o sustituir un stub en una prueba de integración sin reconstruir el agente. El workaround habitual era no llamar a `next` e invocar la otra función tú mismo, lo que se saltaba todo middleware registrado después del tuyo.

## Redirigir una llamada en la 1.23

`FunctionInvocationDelegatingAgent` ahora captura el destino antes de que corra tu callback y despacha según lo que contenga `context.Function` después. Si no lo tocaste, el comportamiento es idéntico al de la 1.22. Si lo reemplazaste, se ejecuta el reemplazo:

```csharp
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;

AIFunction sandboxedDelete = AIFunctionFactory.Create(
    (string customerId) => $"Queued deletion of {customerId} for human review.",
    "delete_customer",
    "Deletes a customer record.");

async ValueTask<object?> RouteDestructiveCalls(
    AIAgent agent,
    FunctionInvocationContext context,
    Func<FunctionInvocationContext, CancellationToken, ValueTask<object?>> next,
    CancellationToken cancellationToken)
{
    if (context.Function.Name == "delete_customer")
    {
#pragma warning disable MAAI001
        context.Function = context.WrapWithPendingMiddleware(sandboxedDelete);
#pragma warning restore MAAI001
    }

    return await next(context, cancellationToken);
}

AIAgent agent = baseAgent
    .AsBuilder()
        .Use(RouteDestructiveCalls)
        .Use(AuditMiddleware)
    .Build();
```

El modelo pidió `delete_customer`, los argumentos pasan sin cambios y la versión en sandbox produce el resultado de la herramienta.

## Por qué existe WrapWithPendingMiddleware

Un reemplazo se invoca directamente. Sin el helper, `AuditMiddleware` en el ejemplo anterior nunca vería la llamada redirigida. El nuevo `FunctionInvocationContextExtensions.WrapWithPendingMiddleware(context, function)` envuelve tu reemplazo con los callbacks que todavía no han corrido para esta invocación, así el resto de la cadena sigue observándola.

Tres reglas del código fuente:

- Llámalo desde un callback en ejecución, antes de llamar a `next`. Una vez que la continuación corrió, ya no queda nada pendiente y el helper lanza `InvalidOperationException`.
- Si no hay callbacks pendientes, devuelve tu función sin cambios.
- Está marcado como `[Experimental]` con el diagnóstico `MAAI001`, de ahí el pragma.

Algo que el reemplazo no cambia: la aprobación de herramientas y la telemetría siguen reflejando la función que el modelo pidió originalmente, porque la llamada se resuelve antes de que corra cualquier callback. Si `delete_customer` requiere aprobación, el usuario sigue aprobando `delete_customer`, aunque tu middleware después ejecute otra cosa. Es el valor por defecto correcto para auditoría, pero no confíes en un cambio de función para esquivar una aprobación.

## El resto de la 1.23, en breve

Si vas a actualizar, busca también estas entradas BREAKING: validación de nombres de herramientas y manejo de llamadas pendientes cuando la lista de herramientas cambia entre ejecuciones ([#8754](https://github.com/microsoft/agent-framework/pull/8754)), un enlace más estricto de las respuestas de aprobación ([#8641](https://github.com/microsoft/agent-framework/pull/8641)) y una lista de permitidos para claves de configuración y de entorno en workflows declarativos, con el fallback a variables de entorno del proceso desactivado salvo que configures `AllowProcessEnvironmentVariableFallback = true` ([#8200](https://github.com/microsoft/agent-framework/pull/8200)). La versión también sube `Microsoft.Extensions.AI` a 10.10.1 y OpenAI a 2.14.0.

¿Vienes de la 1.21 o anterior? Empieza por [lo que cambió la 1.22 con AsIChatClient y las herramientas por ejecución](/es/2026/09/agent-framework-1-22-asichatclient-exposes-an-agent-as-an-ichatclient/), y luego pasa a `Microsoft.Agents.AI` 1.23.0.
