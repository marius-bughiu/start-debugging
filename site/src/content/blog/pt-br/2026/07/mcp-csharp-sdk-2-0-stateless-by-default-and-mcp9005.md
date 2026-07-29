---
title: "Chegou o MCP C# SDK 2.0: sem estado por padrão e MCP9005 no seu código antigo"
description: "O ModelContextProtocol 2.0.0 saiu em 2026-07-28 com o transporte HTTP sem estado ligado por padrão, Multi Round-Trip Requests no lugar da elicitação iniciada pelo servidor, e um aviso do analisador sobre ElicitAsync e SampleAsync."
pubDate: 2026-07-29
tags:
  - "mcp"
  - "dotnet"
  - "csharp"
  - "ai-agents"
lang: "pt-br"
translationOf: "2026/07/mcp-csharp-sdk-2-0-stateless-by-default-and-mcp9005"
translatedBy: "claude"
translationDate: 2026-07-29
---

Em 2026-07-28 Jeff Handley anunciou [a v2.0 do SDK oficial do MCP para C#](https://devblogs.microsoft.com/dotnet/announcing-v20-of-the-official-mcp-csharp-sdk/), publicada no mesmo dia em que a revisão do protocolo `2026-07-28` ficou final. O `ModelContextProtocol` 2.0.0 está no NuGet como versão estável, com suporte a `net8.0`, `net9.0`, `net10.0` e `netstandard2.0`. Se você construiu um servidor sobre a 1.x, esta não é uma atualização de versão que dá para aceitar sem ler o diff.

## O handshake acabou

A mudança principal é arquitetural, e é uma subtração. Sob `2026-07-28` não existe handshake `initialize` nem `Mcp-Session-Id`. Os clientes chamam `server/discover`, e cada requisição seguinte carrega a versão do protocolo, as informações do cliente e as capacidades no `_meta` de cada requisição. Foi isso que permitiu que [o servidor MCP do GitHub apagasse seu armazenamento de sessões no Redis](/pt-br/2026/07/github-mcp-server-goes-stateless-redis-session-store/).

No SDK do C# isso aparece como uma inversão de padrão. `HttpServerTransportOptions.Stateless` agora é `true`, então um servidor que você gera hoje escala horizontalmente sem roteamento com afinidade de sessão. Você volta para sessões de forma explícita:

```csharp
builder.Services
    .AddMcpServer()
    .WithHttpTransport(options => options.Stateless = false)
    .WithToolsFromAssembly();
```

## MCP9005 é a lista de migração

Requisições iniciadas pelo servidor não sobrevivem a um transporte sem estado. `ElicitAsync`, `SampleAsync` e `RequestRootsAsync` agora estão marcados como obsoletos e produzem o diagnóstico `MCP9005`. Compile contra a 2.0.0 e a lista de avisos vira o seu plano de migração: todo ponto em que o servidor chamava de volta o cliente no meio de uma invocação de ferramenta precisa ser reescrito.

O substituto é Multi Round-Trip Requests. Em vez de o servidor chamar o cliente, a ferramenta lança uma exceção com as entradas de que precisa, o cliente resolve tudo localmente e então repete a chamada com as respostas anexadas:

```csharp
throw new InputRequiredException(
    inputRequests: new Dictionary<string, InputRequest>
    {
        ["closeReason"] = InputRequest.ForElicitation(...)
    },
    requestState: ticketId.ToString());
```

`requestState` é o truque que faz isso funcionar sem sessão: é o seu token de correlação, devolvido pelo cliente em vez de ficar parado na memória do servidor.

Os clientes ficam com a metade fácil. O `McpClient` resolve MRTR de forma transparente desde que você registre um handler:

```csharp
var client = await McpClient.CreateAsync(
    clientTransport,
    clientOptions: new()
    {
        Handlers = new McpClientHandlers
        {
            ElicitationHandler = (requestParams, ct) =>
                ValueTask.FromResult(
                    new ElicitResult { Action = "accept" })
        }
    });
```

## O que ainda conversa com pares antigos

Um cliente 2.0.0 prefere `2026-07-28` e cai automaticamente no handshake `initialize` legado quando o servidor não responde a `server/discover`. Um servidor 2.0.0 continua aceitando `initialize` de clientes 1.x. A única combinação que não funciona é um cliente antigo contra um servidor sem estado, que é justamente o caso impossível de contornar, já que MRTR contra um cliente `2025-11-25` exige estado de sessão para ser traduzido na elicitação legada.

A outra aresta afiada: o suporte experimental a Tasks das versões 1.3.x e 1.4.x sumiu, substituído por um pacote `ModelContextProtocol.Extensions.Tasks` redesenhado e alinhado com a SEP-2663. Apps e Tasks agora são pacotes opcionais em vez de embutidos no núcleo, habilitados com `.WithTasks(store)` e `.WithMcpApps()`.

Uma adição realmente boa para quem roda servidores atrás de um gateway: `[McpHeader]` promove um parâmetro de ferramenta a cabeçalho HTTP, então o seu proxy consegue rotear por ele sem fazer parsing do corpo JSON-RPC.

```csharp
public static async Task<string> GetOrderStatus(
    [McpHeader("Region")] string region,
    string orderId)
```

Comece com `dotnet add package ModelContextProtocol --version 2.0.0`, compile e leia a lista de `MCP9005` antes de mexer em qualquer outra coisa. As [notas da versão v2.0.0](https://github.com/modelcontextprotocol/csharp-sdk/releases/tag/v2.0.0) enumeram todas as 10 mudanças incompatíveis, incluindo a renumeração dos códigos de erro JSON-RPC que move `UnsupportedProtocolVersion` para `-32022`.
