---
title: "Microsoft Agent Framework 1.0: construindo agentes de IA em C# puro"
description: "Microsoft Agent Framework chega ao 1.0 com APIs estáveis, conectores multi-provedor, orquestração multi-agente, e interoperabilidade A2A/MCP. Veja como fica na prática no .NET 10."
pubDate: 2026-04-07
tags:
  - "dotnet"
  - "dotnet-10"
  - "csharp"
  - "ai"
  - "microsoft-agent-framework"
lang: "pt-br"
translationOf: "2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp"
translatedBy: "claude"
translationDate: 2026-04-25
---

Microsoft entregou o [Agent Framework 1.0](https://devblogs.microsoft.com/agent-framework/microsoft-agent-framework-version-1-0/) em 3 de abril de 2026, tanto para .NET quanto para Python. Esta é a versão pronta para produção: APIs estáveis, compromisso de suporte de longo prazo, e um caminho de upgrade claro a partir do preview que aterrissou no início deste ano.

Agent Framework unifica o encanamento empresarial do Semantic Kernel com os padrões de orquestração multi-agente do AutoGen em um único framework. Se você estava acompanhando esses dois projetos separadamente, essa divisão acabou.

## O que vem na caixa

A versão 1.0 cobre cinco áreas que antes exigiam costurar múltiplas bibliotecas:

**Conectores de serviço** de primeira mão para Azure OpenAI, OpenAI, Anthropic Claude, Amazon Bedrock, Google Gemini, e Ollama. Trocar provedores é uma mudança de uma linha porque todo conector implementa `IChatClient` de `Microsoft.Extensions.AI`.

Padrões de **orquestração multi-agente** trazidos da Microsoft Research e do AutoGen: sequencial, concorrente, handoff, group chat, e Magentic-One. Esses não são demos de brinquedo, são os mesmos padrões que a equipe AutoGen validou em ambientes de pesquisa.

**Suporte MCP** permite que agentes descubram e invoquem ferramentas expostas por qualquer servidor Model Context Protocol. O suporte ao protocolo **A2A (Agent-to-Agent)** vai além, permitindo que agentes rodando em diferentes frameworks ou runtimes se coordenem através de mensageria estruturada.

Um pipeline de **middleware** para interceptar e transformar o comportamento do agente em cada estágio de execução, mais **provedores de memória** plugáveis para histórico de conversação, estado chave-valor, e recuperação vetorial.

## Um agente mínimo em cinco linhas

O caminho mais rápido do zero a um agente em execução:

```csharp
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;
using OpenAI;

AIAgent agent = new OpenAIClient("your-api-key")
    .GetChatClient("gpt-4o-mini")
    .AsIChatClient()
    .CreateAIAgent(
        instructions: "You are a senior .NET architect. Be concise and production-focused.");

var response = await agent.RunAsync("Design a retry policy for transient SQL failures.");
Console.WriteLine(response);
```

`AsIChatClient()` faz a ponte do cliente OpenAI para a abstração `IChatClient`. `CreateAIAgent()` o envolve com contexto de instrução, registro de ferramentas, e threading de conversação. Substitua `OpenAIClient` por qualquer outro conector suportado e o resto do código permanece idêntico.

## Adicionando ferramentas

Agentes se tornam úteis quando podem chamar seu código. Registre ferramentas com `AIFunctionFactory`:

```csharp
using Microsoft.Agents.AI;

var tools = new[]
{
    AIFunctionFactory.Create((string query) =>
    {
        // search your internal docs, database, etc.
        return $"Results for: {query}";
    }, "search_docs", "Search internal documentation")
};

AIAgent agent = chatClient.CreateAIAgent(
    instructions: "Use search_docs to answer questions from internal docs.",
    tools: tools);
```

O framework cuida da descoberta de ferramentas, geração de schema, e invocação automaticamente. Ferramentas expostas por MCP funcionam da mesma forma, o agente as resolve em runtime de qualquer servidor compatível com MCP.

## Por que isso importa agora

Antes do 1.0, construir um agente .NET significava escolher entre Semantic Kernel (boa integração empresarial, orquestração limitada) ou AutoGen (padrões multi-agente poderosos, história .NET mais áspera). Agent Framework elimina essa escolha. Um pacote, um modelo de programação, pronto para produção.

Os pacotes NuGet são `Microsoft.Agents.AI` para o core e `Microsoft.Agents.AI.OpenAI` (ou a variante específica do provedor) para os conectores. Instale com:

```bash
dotnet add package Microsoft.Agents.AI.OpenAI
```

A documentação completa e amostras estão no [GitHub](https://github.com/microsoft/agent-framework) e na [Microsoft Learn](https://learn.microsoft.com/en-us/agent-framework/overview/).
