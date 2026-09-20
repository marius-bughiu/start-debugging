---
title: "Agent Framework 1.22: AsIChatClient deixa um AIAgent se passar por um IChatClient"
description: "O Microsoft Agent Framework .NET 1.22.0 adiciona AIAgent.AsIChatClient(), fechando o caminho de volta iniciado por IChatClient.AsAIAgent(). Seu agente, com instruções e ferramentas intactas, agora se encaixa em qualquer API que receba um IChatClient."
pubDate: 2026-09-20
tags:
  - "agent-framework"
  - "dotnet"
  - "ai-agents"
  - "microsoft-extensions-ai"
lang: "pt-br"
translationOf: "2026/09/agent-framework-1-22-asichatclient-exposes-an-agent-as-an-ichatclient"
translatedBy: "claude"
translationDate: 2026-09-20
---

O Microsoft Agent Framework [dotnet-1.22.0](https://github.com/microsoft/agent-framework/releases/tag/dotnet-1.22.0) saiu em 2026-09-18, e o item que merece sua atenção é o [PR #7687](https://github.com/microsoft/agent-framework/pull/7687): `AsIChatClient`. O `Microsoft.Extensions.AI` já tinha há algum tempo o `ChatClientExtensions.AsAIAgent()`, que transforma um cliente de chat em um agente. O caminho inverso não existia. Agora existe, e o ciclo se fecha.

## Por que a direção que faltava doía

A lista de APIs do .NET que aceitam um `IChatClient` só cresce: os avaliadores de `Microsoft.Extensions.AI.Evaluation`, o middleware de cache e de telemetria, tudo o que é construído sobre o pipeline do `ChatClientBuilder`. Um `AIAgent` é o objeto mais rico. Ele carrega instruções, um conjunto de ferramentas, uma sessão e todo o middleware que você tenha colocado em volta. Entregar a uma dessas APIs um `IChatClient` cru significava reconstruir tudo isso na mão, ou dar ao avaliador que faz o papel de juiz um modelo sem nada do system prompt que o torna um juiz.

O `AsIChatClient` fica em `Microsoft.Agents.AI` e tem esta forma:

```csharp
public static IChatClient AsIChatClient(
    this AIAgent agent,
    AgentSession? session = null,
    string? conversationId = null,
    bool allowNonChatClientAgents = false)
```

Assim, um agente juiz vira um cliente de chat juiz em uma única chamada:

```csharp
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;

AIAgent judge = chatClient.CreateAIAgent(
    instructions: "You score answers for factual accuracy. Reply with JSON only.",
    name: "Judge");

IChatClient judgeClient = judge.AsIChatClient();
```

O adaptador é um `AIAgentChatClient` interno que mapeia `GetResponseAsync` e `GetStreamingResponseAsync` sobre `RunAsync` e `RunStreamingAsync`, e leva suas `ChatOptions` adiante como `ChatClientAgentRunOptions`. O cancelamento atravessa a ponte, e um `GetService<IChatClient>()` sem chave devolve o adaptador, enquanto qualquer outra solicitação de serviço é repassada ao agente.

## A proteção, e quando desligá-la

Por padrão a chamada lança `InvalidOperationException` a menos que o agente seja um `ChatClientAgent` ou devolva um a partir de um `GetService<ChatClientAgent>()` sem chave. Decoradores construídos sobre `DelegatingAIAgent` repassam essa solicitação, então um agente embrulhado continua passando.

Defina `allowNonChatClientAgents: true` e qualquer tipo de agente será embrulhado, mas leia as letras miúdas: só `ChatOptions.ResponseFormat` sobrevive à travessia. Temperatura, ferramentas e o resto são ignorados em silêncio, porque um agente de workflow ou um agente A2A remoto não tem opções de chat onde aplicá-los.

As sessões são a outra ponta afiada. No modo sem estado padrão, um `ChatOptions.ConversationId` não vazio lança exceção, e os ids crus de resposta são limpos nas cópias que você recebe de volta. Passe uma `session` e o cliente reporta um único id de conversa estável em toda resposta: o que você forneceu, ou um id gerado por instância. Ele nunca vaza o id do lado do serviço, o que mantém o estado de conversa do provedor dentro da sessão, onde ele pertence. Qualquer outro id não vazio lança exceção como desconhecido.

A API está marcada com `[Experimental]`, então espere um erro de compilação até suprimir o diagnóstico para o qual ela aponta.

Mais uma linha da mesma versão merece um grep no seu código: o [PR #8531](https://github.com/microsoft/agent-framework/pull/8531) agora passa as ferramentas do `ChatClientAgent` por execução, em vez de defini-las no cliente de chat subjacente que invoca funções, o que impede que ferramentas se dupliquem ou vazem entre agentes que compartilham um cliente. Isso está marcado como BREAKING, assim como a promoção de `AgentSessionStore` para `Microsoft.Agents.AI.Abstractions`.

Atualize para o `Microsoft.Agents.AI` 1.22.0 e, se você pulou a versão da semana passada, confira [o que a 1.21 mudou no LocalCodeAct e no ambiente do seu host](/pt-br/2026/09/agent-framework-1-21-localcodeact-stops-inheriting-host-environment/) antes de seguir em frente.
