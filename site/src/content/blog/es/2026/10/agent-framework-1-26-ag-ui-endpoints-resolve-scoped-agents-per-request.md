---
title: "Agent Framework 1.26: los endpoints AG-UI dejan de convertir los agentes con scope en singletons"
description: "Microsoft Agent Framework 1.26.0 hace que MapAGUIServer resuelva por solicitud el AIAgent con clave, su AgentSessionStore y el proveedor de la clave de aislamiento, y añade una sobrecarga con selector que elige el agente a partir del HttpContext."
pubDate: 2026-10-24
tags:
  - "agent-framework"
  - "ag-ui"
  - "dotnet"
  - "aspnetcore"
  - "ai-agents"
lang: "es"
translationOf: "2026/10/agent-framework-1-26-ag-ui-endpoints-resolve-scoped-agents-per-request"
translatedBy: "claude"
translationDate: 2026-10-24
---

[Microsoft Agent Framework dotnet-1.26.0](https://github.com/microsoft/agent-framework/releases/tag/dotnet-1.26.0) se publicó el 23 de octubre de 2026, con `Microsoft.Agents.AI.Hosting.AGUI.AspNetCore` en `1.26.0-preview.261023.1`. El cambio principal para quien aloja agentes detrás de AG-UI es el [PR #9382](https://github.com/microsoft/agent-framework/pull/9382): el endpoint de AG-UI ahora respeta el tiempo de vida de DI con el que registraste tu agente, y puedes elegir el agente en cada solicitud.

## La dependencia cautiva en 1.25 y versiones anteriores

Antes de esta versión, `MapAGUIServer(agentName)` y `MapAGUIServer(IHostedAgentBuilder)` resolvían el `AIAgent` con clave, su `AgentSessionStore` con clave y el `AgentIsolationKeyProvider` desde el proveedor de servicios raíz, una sola vez, al mapear el endpoint. El tiempo de vida con el que los registraste se ignoraba. Un agente Scoped se convertía en la práctica en un singleton, y también todo lo que capturaba.

Eso duele cuando el agente depende de estado por solicitud:

```csharp
builder.Services.AddScoped<TenantContext>();

builder.Services.AddKeyedScoped<AIAgent>("support", (sp, _) =>
{
    var tenant = sp.GetRequiredService<TenantContext>();
    return chatClient.AsAIAgent(
        name: "support",
        instructions: $"You answer support questions for {tenant.Name}.");
});
```

En 1.25 ganaba el primer `TenantContext` que se resolvía. Todas las solicitudes posteriores, de todos los tenants, recibían el mismo agente con las mismas instrucciones. Es la clásica dependencia cautiva, solo que escondida detrás del mapeo de un endpoint en lugar de un constructor.

Desde 1.26, esos tres servicios provienen de `HttpContext.RequestServices` en cada solicitud. Los agentes Scoped y Transient obtienen una instancia nueva por solicitud. Los singletons registrados mediante `IHostedAgentBuilder` se siguen resolviendo una sola vez al mapear, así que el caso común no tiene costo adicional. Los registros faltantes se siguen reportando al iniciar: la comprobación usa `IServiceProviderIsKeyedService`, por lo que nunca resuelve una instancia con scope desde el proveedor raíz.

## Elegir el agente a partir de la solicitud

El mismo PR añade una nueva sobrecarga:

```csharp
public static IEndpointConventionBuilder MapAGUIServer(
    this IEndpointRouteBuilder endpoints,
    [StringSyntax("route")] string pattern,
    Func<HttpContext, AIAgent?> agentSelector)
```

El selector se ejecuta una vez por solicitud, de modo que el agente puede salir de un valor de ruta, un encabezado o un claim:

```csharp
app.MapAGUIServer("/agents/{agent}", ctx =>
{
    var name = ctx.GetRouteValue("agent") as string;
    return name is null
        ? null
        : ctx.RequestServices.GetKeyedService<AIAgent>(name);
});
```

Devolver `null` produce un `404 Not Found` antes de cargar cualquier estado de sesión. El `Name` del agente seleccionado se usa como identidad de almacenamiento de la sesión, así que una conversación sobrevive aunque se construya una instancia nueva del agente en cada solicitud. La documentación XML es explícita en que la selección no es un límite de autorización: pon una política de autorización en el endpoint (`.RequireAuthorization(...)`) en lugar de devolver `null` para los usuarios que no deberían llegar a un agente.

## Un cambio de comportamiento que conviene revisar

Un commit posterior dentro del PR cambia cómo se identifican los agentes con nombre mapeados por instancia. `MapAGUIServer(pattern, AIAgent)` ahora usa el nombre del agente como identidad, igual que los mapeos con nombre, hospedados y con selector. Antes, el mismo agente expuesto mediante un mapeo con nombre y uno por instancia no compartía conversaciones. Ahora sí. Los agentes sin nombre siguen usando la identidad de instancia. La sobrecarga por instancia también resuelve ahora su almacén de sesiones por solicitud.

La misma versión añade `AgentSessionStore.DeleteSessionAsync` como método abstracto, así que un almacén personalizado que derive de `AgentSessionStore` no compilará hasta que lo implementes. Si pasaste a `MapAGUIServer` después de [los cambios de nombres del SDK 1.0 de AG-UI para .NET](/es/2026/09/ag-ui-dotnet-sdk-1-0-moves-agui-out-of-agent-framework/) y registras algo distinto de agentes singleton, esta es la actualización que hace que esos registros signifiquen lo que dicen.
