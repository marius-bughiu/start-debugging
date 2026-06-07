---
title: "GitHub Copilot SDK chega ao GA: incorpore o runtime de agente do Copilot nos seus próprios apps C#"
description: "No Build 2026 o GitHub lançou o Copilot SDK 1.0 GA com um pacote .NET de primeira classe. Agora você pode controlar a partir de código C# o mesmo runtime de agente com planejamento, chamadas de ferramentas e sessões multi-turno, BYOK incluído."
pubDate: 2026-06-07
tags:
  - "github-copilot"
  - "copilot-sdk"
  - "ai-agents"
  - "dotnet"
  - "csharp"
  - "mcp"
lang: "pt-br"
translationOf: "2026/06/github-copilot-sdk-ga-embed-copilot-agent-runtime-csharp"
translatedBy: "claude"
translationDate: 2026-06-07
---

O GitHub anunciou que o [GitHub Copilot SDK chegou à disponibilidade geral](https://github.blog/changelog/2026-06-02-copilot-sdk-is-now-generally-available/) em 2 de junho de 2026 no Build, e a parte que merece sua atenção como desenvolvedor .NET é o pacote `GitHub.Copilot.SDK`. Ele dá acesso direto e programático ao mesmo runtime de agente que está por trás do Copilot no editor: planejamento, invocação de ferramentas, edição de arquivos, streaming e sessões multi-turno. O ponto de venda é que você não precisa construir a camada de orquestração sozinho. O runtime que já processa milhões de turnos de agente por dia agora é uma dependência do NuGet.

## O que você realmente ganha

O SDK chegou em seis linguagens no GA (`@github/copilot-sdk`, `github-copilot-sdk` para Python, Go, Rust, Java e `GitHub.Copilot.SDK` para .NET). Para Node.js, Python e .NET a CLI do Copilot é incluída automaticamente como dependência transitiva, então não há um binário separado para instalar ou manter no PATH. Você adiciona um pacote e já tem um host de agente:

```bash
dotnet add package GitHub.Copilot.SDK
```

Uma sessão é a unidade de trabalho. Você inicia um cliente, abre uma sessão contra um modelo e escuta eventos tipados em vez de fazer polling. Aqui está o ciclo completo para um único prompt:

```csharp
using GitHub.Copilot;

await using var client = new CopilotClient();
await client.StartAsync();

await using var session = await client.CreateSessionAsync(new SessionConfig
{
    Model = "gpt-5",
    OnPermissionRequest = PermissionHandler.ApproveAll,
});

var done = new TaskCompletionSource();

session.On<SessionEvent>(evt =>
{
    if (evt is AssistantMessageEvent msg)
        Console.WriteLine(msg.Data.Content);
    else if (evt is SessionIdleEvent)
        done.SetResult();
});

await session.SendAsync(new MessageOptions { Prompt = "What is 2+2?" });
await done.Task;
```

O streaming é uma flag, não uma API diferente: defina `Streaming = true` no `SessionConfig` e você recebe fragmentos `AssistantMessageDeltaEvent` que acumula até o `AssistantMessageEvent` final.

## Ferramentas são métodos comuns, e o MCP já vem integrado

A peça que torna isto mais do que um wrapper de chat são as ferramentas personalizadas. `CopilotTool.DefineTool` recebe um delegate e reaproveita a factory de funções do `Microsoft.Extensions.AI`, então uma ferramenta é apenas um método C# tipado com um `[Description]` em cada parâmetro:

```csharp
using Microsoft.Extensions.AI;
using System.ComponentModel;

var session = await client.CreateSessionAsync(new SessionConfig
{
    Model = "gpt-5",
    Tools =
    [
        CopilotTool.DefineTool(
            async ([Description("Issue ID")] string id) => await FetchIssueAsync(id),
            factoryOptions: new AIFunctionFactoryOptions
            {
                Name = "lookup_issue",
                Description = "Fetch issue details",
            }),
    ],
});
```

Se você já construiu [um servidor MCP personalizado em C#](/pt-br/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/), o agente pode se conectar a ele diretamente, então suas ferramentas existentes vêm junto sem reescrita.

## BYOK para não ficar preso à cobrança do GitHub

A autenticação é o outro motivo para olhar. De fábrica, o SDK pega seu login da CLI `copilot` ou os tokens de ambiente (`COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`). Mas bring-your-own-key funciona com OpenAI, Microsoft Foundry, Anthropic e outros provedores, então você pode apontar o runtime para um modelo que já paga:

```csharp
var session = await client.CreateSessionAsync(new SessionConfig
{
    Provider = new ProviderConfig
    {
        Type = "openai",
        BaseUrl = "https://api.openai.com/v1",
        ApiKey = "your-api-key",
    },
});
```

Ele também traz tracing OpenTelemetry com propagação de contexto de trace W3C, então as chamadas de ferramentas e os turnos do agente aparecem nos mesmos traces que o resto do seu serviço. Para quem vem escrevendo à mão um loop de ferramentas sobre um cliente de chat cru, o pacote GA é a primeira vez que o próprio runtime de agente do GitHub é algo que você pode fazer `dotnet add` e colocar em produção. O [cookbook de .NET e o guia de introdução](https://github.com/github/copilot-sdk) são o próximo lugar para onde ir.
