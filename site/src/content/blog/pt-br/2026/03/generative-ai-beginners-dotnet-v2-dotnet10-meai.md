---
title: "Generative AI for Beginners .NET v2: reconstruído para .NET 10 com Microsoft.Extensions.AI"
description: "O curso gratuito de IA generativa para desenvolvedores .NET da Microsoft entrega a Versão 2, reconstruída para .NET 10 e migrada do Semantic Kernel para o padrão IChatClient do Microsoft.Extensions.AI."
pubDate: 2026-03-29
tags:
  - "dotnet"
  - "dotnet-10"
  - "ai"
  - "ai-agents"
  - "llm"
  - "microsoft-extensions-ai"
  - "generative-ai"
lang: "pt-br"
translationOf: "2026/03/generative-ai-beginners-dotnet-v2-dotnet10-meai"
translatedBy: "claude"
translationDate: 2026-04-25
---

A Microsoft atualizou o [Generative AI for Beginners .NET](https://aka.ms/genainet) para a Versão 2. O curso é gratuito, de código aberto, e agora reconstruído inteiramente para .NET 10 com uma mudança arquitetural significativa: Semantic Kernel sai como a abstração principal, substituído pelo [Microsoft.Extensions.AI](https://learn.microsoft.com/en-us/dotnet/ai/microsoft-extensions-ai) (MEAI).

## A mudança para Microsoft.Extensions.AI

A Versão 1 apoiava-se no Semantic Kernel para orquestração e acesso a modelos. A Versão 2 padroniza na interface `IChatClient` do MEAI, que é entregue como parte do .NET 10 e segue as mesmas convenções de injeção de dependência que o `ILogger`.

O padrão de registro será familiar a qualquer desenvolvedor .NET:

```csharp
var builder = Host.CreateApplicationBuilder();

// Register any IChatClient-compatible provider
builder.Services.AddChatClient(new OllamaChatClient("phi4"));

var app = builder.Build();
var client = app.Services.GetRequiredService<IChatClient>();

var response = await client.GetStreamingResponseAsync("What is AOT compilation?");
await foreach (var update in response)
    Console.Write(update.Text);
```

A interface é agnóstica de provedor. Trocar `OllamaChatClient` por uma implementação de Azure OpenAI requer mudar uma única linha. O curso usa isso deliberadamente -- as habilidades se transferem entre provedores em vez de te trancar no SDK de um único vendor.

## O que as cinco lições cobrem

O currículo reestruturado roda em cinco lições autocontidas:

1. **Fundamentos** -- mecânicas de LLM, tokens, janelas de contexto, e como o .NET 10 se integra com APIs de modelos
2. **Técnicas centrais** -- completions de chat, prompt engineering, function calling, saídas estruturadas, e básicos de RAG
3. **Padrões de IA** -- busca semântica, geração aumentada por recuperação, pipelines de processamento de documentos
4. **Agentes** -- uso de ferramentas, orquestração multi-agente, e integração Model Context Protocol (MCP) usando o suporte a cliente MCP embutido do .NET 10
5. **IA responsável** -- detecção de viés, APIs de segurança de conteúdo, e diretrizes de transparência

A lição de agentes é particularmente relevante se você tem acompanhado o suporte a MCP do .NET 10. O curso conecta a orquestração multi-agente diretamente a esse recurso usando o cliente MCP do `Microsoft.Extensions.AI.Abstractions`, então você pode rodar amostras contra servidores MCP locais ou remotos sem ginástica de framework.

## Migrando da Versão 1

As onze amostras de Semantic Kernel da Versão 1 são movidas para uma pasta depreciada dentro do repo -- elas ainda rodam, mas não são mais apresentadas como o padrão recomendado. Se você passou pela Versão 1, os conceitos centrais permanecem os mesmos. A migração é principalmente uma troca na camada de API: substitua `Kernel` e `IKernelBuilder` do Semantic Kernel por `IChatClient` e as extensões padrão `IServiceCollection`.

O repositório do curso está em [github.com/microsoft/generative-ai-for-beginners-dotnet](https://github.com/microsoft/generative-ai-for-beginners-dotnet). O próprio curso começa em [aka.ms/genainet](https://aka.ms/genainet).
