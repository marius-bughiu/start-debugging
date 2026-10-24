---
title: "Agent Framework 1.26: endpoints AG-UI deixam de transformar agentes Scoped em singletons"
description: "O Microsoft Agent Framework 1.26.0 faz o MapAGUIServer resolver por requisição o AIAgent com chave, seu AgentSessionStore e o provedor da chave de isolamento, e adiciona uma sobrecarga com seletor que escolhe o agente a partir do HttpContext."
pubDate: 2026-10-24
tags:
  - "agent-framework"
  - "ag-ui"
  - "dotnet"
  - "aspnetcore"
  - "ai-agents"
lang: "pt-br"
translationOf: "2026/10/agent-framework-1-26-ag-ui-endpoints-resolve-scoped-agents-per-request"
translatedBy: "claude"
translationDate: 2026-10-24
---

O [Microsoft Agent Framework dotnet-1.26.0](https://github.com/microsoft/agent-framework/releases/tag/dotnet-1.26.0) foi lançado em 23 de outubro de 2026, com `Microsoft.Agents.AI.Hosting.AGUI.AspNetCore` na versão `1.26.0-preview.261023.1`. O destaque para quem hospeda agentes atrás do AG-UI é o [PR #9382](https://github.com/microsoft/agent-framework/pull/9382): o endpoint AG-UI agora respeita o tempo de vida de DI com que você registrou seu agente, e você pode escolher o agente por requisição.

## A dependência capturada na 1.25 e anteriores

Antes desta versão, `MapAGUIServer(agentName)` e `MapAGUIServer(IHostedAgentBuilder)` resolviam o `AIAgent` com chave, o `AgentSessionStore` com chave e o `AgentIsolationKeyProvider` a partir do service provider raiz, uma única vez, quando o endpoint era mapeado. O tempo de vida que você registrou era ignorado. Um agente Scoped virava um singleton na prática, e o mesmo acontecia com tudo o que ele capturava.

Isso causa problemas quando o agente depende de estado por requisição:

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

Na 1.25, o primeiro `TenantContext` resolvido vencia. Toda requisição seguinte, de qualquer tenant, recebia o mesmo agente com as mesmas instruções. É a clássica dependência capturada (captive dependency), só que escondida atrás de um mapeamento de endpoint em vez de um construtor.

A partir da 1.26, esses três serviços vêm de `HttpContext.RequestServices` a cada requisição. Agentes Scoped e Transient recebem uma instância nova por requisição. Singletons registrados via `IHostedAgentBuilder` continuam sendo resolvidos uma única vez no momento do mapeamento, então não há custo extra no caso comum. Registros ausentes continuam sendo reportados na inicialização: a verificação usa `IServiceProviderIsKeyedService`, portanto nunca resolve uma instância Scoped a partir do provider raiz.

## Escolhendo o agente a partir da requisição

O mesmo PR adiciona uma nova sobrecarga:

```csharp
public static IEndpointConventionBuilder MapAGUIServer(
    this IEndpointRouteBuilder endpoints,
    [StringSyntax("route")] string pattern,
    Func<HttpContext, AIAgent?> agentSelector)
```

O seletor roda uma vez por requisição, então o agente pode vir de um valor de rota, de um header ou de uma claim:

```csharp
app.MapAGUIServer("/agents/{agent}", ctx =>
{
    var name = ctx.GetRouteValue("agent") as string;
    return name is null
        ? null
        : ctx.RequestServices.GetKeyedService<AIAgent>(name);
});
```

Retornar `null` produz um `404 Not Found` antes de qualquer estado de sessão ser carregado. O `Name` do agente selecionado é usado como identidade de armazenamento da sessão, então uma conversa sobrevive mesmo que uma nova instância do agente seja criada a cada requisição. A documentação XML é explícita: a seleção não é uma fronteira de autorização. Coloque uma política de autorização no endpoint (`.RequireAuthorization(...)`) em vez de retornar `null` para usuários que não deveriam alcançar um agente.

## Uma mudança de comportamento para verificar

Um commit posterior no PR muda como os agentes nomeados mapeados por instância são identificados. `MapAGUIServer(pattern, AIAgent)` agora usa o nome do agente como identidade, de forma consistente com os mapeamentos nomeado, hospedado e por seletor. Antes, o mesmo agente exposto por um mapeamento nomeado e por um mapeamento de instância não compartilhava conversas. Agora compartilha. Agentes sem nome continuam usando a identidade da instância. A sobrecarga de instância também resolve seu session store por requisição agora.

A mesma versão adiciona `AgentSessionStore.DeleteSessionAsync` como método abstrato, então um store personalizado que deriva de `AgentSessionStore` não compila até você implementá-lo. Se você migrou para `MapAGUIServer` depois de [as renomeações do AG-UI .NET SDK 1.0](/pt-br/2026/09/ag-ui-dotnet-sdk-1-0-moves-agui-out-of-agent-framework/) e registra qualquer coisa que não seja agentes singleton, esta é a atualização que faz esses registros significarem o que dizem.
