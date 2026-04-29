---
title: "Microsoft `mcp`: ligando servidores Model Context Protocol a partir de C# no .NET 10"
description: "Como ligar servidores Model Context Protocol (MCP) em C# no .NET 10 usando microsoft/mcp. Cobre contratos de ferramentas, validação de entrada, autenticação, observabilidade e padrões prontos para produção."
pubDate: 2026-01-10
tags:
  - "csharp-14"
  - "csharp"
  - "dotnet"
  - "dotnet-10"
  - "mcp"
  - "ai-agents"
lang: "pt-br"
translationOf: "2026/01/microsoft-mcp-wiring-model-context-protocol-servers-from-c-on-net-10"
translatedBy: "claude"
translationDate: 2026-04-30
---
O GitHub Trending de hoje (C#, diário) inclui **`microsoft/mcp`**, o repositório da Microsoft para o Model Context Protocol (MCP). Se você está construindo ferramentas internas em **.NET 10** e quer uma fronteira limpa entre um cliente de LLM e seus sistemas reais (arquivos, tickets, bancos de dados, CI), MCP é o formato a observar.

Fonte: [microsoft/mcp](https://github.com/microsoft/mcp)

## A mudança útil: ferramentas viram um contrato, não cola ad hoc

A maioria das "integrações de IA" começa como código de cola ad hoc: templates de prompt, algumas chamadas HTTP e uma pilha crescente de "só mais uma ferramenta". No momento em que você precisa de confiabilidade, auditoria ou uma história local de desenvolvedor, você quer um contrato:

-   um conjunto descobrível de ferramentas,
-   entradas e saídas tipadas,
-   transporte previsível,
-   logs sobre os quais você consiga raciocinar.

É para isso que o MCP aponta: uma fronteira de protocolo para que cliente e servidor possam evoluir independentemente.

## A forma de um servidor MCP minúsculo em C# (o que você vai implementar de fato)

A superfície exata da API depende de qual biblioteca C# para MCP você escolher (e ainda é cedo). Já o formato do servidor é estável: definir ferramentas, validar entradas, executar, retornar saída estruturada.

Aqui vai um exemplo mínimo em estilo C# 14 para .NET 10 mostrando a abordagem "contrato primeiro". Trate-o como um template para o formato dos seus handlers.

```cs
using System.Text.Json;

public static class CiTools
{
    public static string GetBuildStatus(JsonElement args)
    {
        if (!args.TryGetProperty("pipeline", out var pipelineProp) || pipelineProp.ValueKind != JsonValueKind.String)
            throw new ArgumentException("Missing required string argument: pipeline");

        var pipeline = pipelineProp.GetString()!;

        // Replace with your real implementation (Azure DevOps, GitHub, Jenkins).
        var status = new
        {
            pipeline,
            state = "green",
            lastRunUtc = DateTimeOffset.UtcNow.AddMinutes(-7),
        };

        return JsonSerializer.Serialize(status);
    }
}
```

As partes importantes não são os detalhes do parse de JSON. As partes importantes são:

-   **Validação de entrada explícita**: o MCP facilita esquecer que você está construindo uma API. Trate-o como tal.
-   **Sem estado ambiente implícito**: passe dependências, logue tudo.
-   **Resultados estruturados**: retorne formatos estáveis, não strings impossíveis de comparar.

## Onde isso aterrissa em uma base de código real de .NET 10

Se você adotar MCP em produção, vai se importar com as mesmas coisas que se importa em qualquer serviço:

-   **Autenticação**: o servidor deve impor a identidade, não o cliente.
-   **Privilégio mínimo**: as ferramentas devem expor a menor superfície possível.
-   **Observabilidade**: IDs de requisição, logs de invocação de ferramentas e métricas de falha.
-   **Determinismo**: as ferramentas devem ser seguras para chamar várias vezes, e idempotentes quando possível.

Se você fizer apenas uma coisa nesta semana: clone o repositório, dê uma olhada nos documentos do protocolo e rascunhe uma lista de 5 ferramentas que você implementa hoje como "cola de prompt". Essa lista costuma ser o bastante para justificar uma fronteira MCP de verdade.

Recurso: [microsoft/mcp](https://github.com/microsoft/mcp)
