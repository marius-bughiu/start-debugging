---
title: "O provedor Copilot do Agent Framework transforma o Copilot CLI em um AIAgent comum"
description: "Microsoft.Agents.AI.GitHub.Copilot 1.16.0 saiu em 2026-07-30. O runtime do Copilot CLI agora fica atrás da abstração AIAgent, as permissões são negadas por padrão e o Squad pluga um time inteiro de agentes como um único AIAgent."
pubDate: 2026-08-03
tags:
  - "agent-framework"
  - "github-copilot"
  - "ai-agents"
  - "dotnet"
  - "csharp"
  - "mcp"
lang: "pt-br"
translationOf: "2026/08/agent-framework-github-copilot-provider-copilot-cli-as-aiagent"
translatedBy: "claude"
translationDate: 2026-08-03
---

A Microsoft publicou o `Microsoft.Agents.AI.GitHub.Copilot` 1.16.0 no NuGet em 2026-07-30, e o [post do blog do Agent Framework que saiu no mesmo dia](https://devblogs.microsoft.com/agent-framework/building-agent-teams-with-agent-framework-github-copilot-cli-and-squad/) descreve a integração com o GitHub Copilot como totalmente suportada em C# e em Python. O efeito prático: o runtime do Copilot CLI, aquele que executa comandos de shell, edita arquivos, busca URLs e fala MCP, agora é alcançável pela abstração `AIAgent` comum.

## Duas linhas para ter um agente de código

```bash
dotnet add package Microsoft.Agents.AI.GitHub.Copilot
```

```csharp
using GitHub.Copilot;
using Microsoft.Agents.AI;

await using CopilotClient copilotClient = new();
await copilotClient.StartAsync();

AIAgent agent = copilotClient.AsAIAgent();

Console.WriteLine(await agent.RunAsync("What is Microsoft Agent Framework?"));
```

O `AsAIAgent` aceita opcionalmente `tools:` e `instructions:`, então um `AIFunction` que você já registrou em outro lugar entra direto. O que volta é um `AIAgent` padrão, o que significa que `RunStreamingAsync`, `CreateSessionAsync` para contexto de várias interações, e qualquer workflow ou orquestração que você já construiu sobre o Agent Framework funcionam com ele sem mudanças. Essa é a diferença em relação a dirigir [o Copilot SDK diretamente](/pt-br/2026/06/github-copilot-sdk-ga-embed-copilot-agent-runtime-csharp/): você para de escrever à mão o loop de eventos da sessão e trata o Copilot como mais um provedor.

## As permissões são negadas por padrão

O detalhe que vai te pegar primeiro é que o agente não pode executar comandos de shell, mexer no sistema de arquivos ou buscar URLs até você entregar um handler de permissão:

```csharp
SessionConfig sessionConfig = new()
{
    OnPermissionRequest = PromptPermission,
};

AIAgent agent = copilotClient.AsAIAgent(sessionConfig);
```

Seu handler retorna `PermissionDecision.ApproveOnce()` ou `PermissionDecision.Reject()`. Existe um atalho `PermissionHandler.ApproveAll`, e a [página do provedor no MS Learn](https://learn.microsoft.com/en-us/agent-framework/agents/providers/github-copilot) é direta ao dizer para rodar isso dentro de um contêiner ou dev container, não na sua máquina de trabalho. Servidores MCP vêm junto também, locais via stdio e remotos via HTTP, configurados por `SessionConfig.McpServers`. Interpretador de código, busca em arquivos e busca web hospedada não vêm: a documentação marca os três como não suportados para este provedor.

## O Squad monta em cima da mesma abstração

A segunda metade do anúncio é o Squad, um arranjo multiagente de código aberto em que um coordenador e alguns especialistas vivem no seu repositório como arquivos markdown dentro de `.squad/`. O pacote `Squad.Agents.AI` envolve o time inteiro como um `DelegatingAIAgent`, então todo o elenco se apresenta para a sua aplicação como um único `AIAgent`:

```csharp
builder.Services.AddSquadAgent(o =>
{
    o.SquadFolderPath = @"C:\path\to\your\team-root";
});

var squad = host.Services.GetRequiredService<AIAgent>();
var session = await squad.CreateSessionAsync();
var response = await squad.RunAsync("What can this Squad team do?", session);
```

Cada despacho para um especialista emite um span do OpenTelemetry chamado `squad.subagent {Name}`, então a ramificação aparece no Aspire ou no Jaeger sem fiação extra. O Squad ainda está em alfa (`Squad.Agents.AI` está na 0.5.5, com previews da 0.5.6) e precisa de `dotnet add package Squad.Agents.AI --prerelease` mais o pacote npm `@bradygaster/squad-cli` para criar a pasta.

O provedor é a parte que vale adotar esta semana. O Squad é a prova interessante de que, uma vez que um agente de código é apenas um `AIAgent`, um time inteiro deles também pode ser.
