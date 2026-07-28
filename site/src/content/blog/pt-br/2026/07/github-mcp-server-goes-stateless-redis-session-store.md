---
title: "O servidor MCP do GitHub ficou sem estado e apagou seu armazenamento de sessões no Redis"
description: "Em 2026-07-23 o GitHub lançou a revisão 2026-07-28 do MCP antes da data da especificação. O que chama atenção é a subtração: sem handshake initialize, sem Mcp-Session-Id, sem Redis."
pubDate: 2026-07-28
tags:
  - "mcp"
  - "ai-agents"
  - "http"
  - "architecture"
lang: "pt-br"
translationOf: "2026/07/github-mcp-server-goes-stateless-redis-session-store"
translatedBy: "claude"
translationDate: 2026-07-28
---

Em 2026-07-23 o GitHub anunciou que [o servidor MCP do GitHub tem suporte à próxima especificação do MCP](https://github.blog/changelog/2026-07-23-github-mcp-server-supports-the-next-mcp-specification/), a revisão datada de `2026-07-28`, dias antes dessa data chegar. Colocar uma revisão ainda não publicada na frente do tráfego de produção é uma aposta. O que torna o anúncio digno de leitura é que as mudanças principais são todas subtrações: o armazenamento de sessões no Redis, a inspeção de pacotes na camada de proxy e uma escrita no banco de dados a cada conexão de cliente.

## O handshake e o cabeçalho de sessão sumiram

A revisão `2026-07-28` remove o handshake de `initialize` e `notifications/initialized`, e remove o cabeçalho `Mcp-Session-Id` do Streamable HTTP. Tudo o que o handshake estabelecia agora viaja em cada requisição individual dentro de `_meta`, espelhado em cabeçalhos HTTP para que um balanceador de carga consiga rotear sem analisar o corpo:

```http
POST /mcp HTTP/1.1
Content-Type: application/json
MCP-Protocol-Version: 2026-07-28
Mcp-Method: tools/call
Mcp-Name: get_weather

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "get_weather",
    "arguments": { "location": "Seattle, WA" },
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { "name": "ExampleClient", "version": "1.0.0" },
      "io.modelcontextprotocol/clientCapabilities": {}
    }
  }
}
```

O corpo continua sendo a fonte da verdade. Se um cabeçalho discordar dele, o servidor precisa responder `400 Bad Request` com o erro JSON-RPC `-32020` (`HeaderMismatch`), o que impede que um gateway roteie por um valor enquanto o servidor executa outro.

Essa única mudança é o motivo pelo qual a dependência do Redis pôde sair. Um armazenamento de sessões existia apenas para que a segunda requisição de um cliente encontrasse o estado criado pela primeira. Sem handshake não há estado a encontrar, então qualquer requisição pode cair em qualquer instância e a inicialização deixa de escrever em um banco de dados.

## As duas mudanças que custam trabalho de verdade

Requisições iniciadas pelo servidor acabaram. Sampling, roots e elicitation chegavam como requisições JSON-RPC enviadas pelo servidor. Com Multi Round-Trip Requests (SEP-2322), o servidor devolve `resultType: "input_required"` com um array `inputRequests`, e o cliente repete a chamada original levando `inputResponses`. O GitHub tratou as duas eras atrás de um wrapper do SDK Go em vez de quebrar clientes mais antigos.

A retomada também acabou. O cabeçalho `Last-Event-ID` e os IDs de evento SSE foram removidos, então um fluxo de resposta interrompido perde a requisição em andamento e o cliente precisa reemiti-la com um novo ID de requisição. Se o seu servidor presumia repetição na reconexão, essa premissa agora é problema seu.

Vale notar antes de planejar uma migração: Tasks saiu do núcleo para a extensão `io.modelcontextprotocol/tasks`, com `tasks/list` removido, e Roots, Sampling e Logging estão formalmente obsoletos com uma janela de doze meses.

## Onde isso deixa o seu servidor

Se você já roda Streamable HTTP sem gerador de identificador de sessão, está quase lá, o que é o argumento prático para [escolher Streamable HTTP em vez de stdio ou do transporte SSE legado](/2026/07/mcp-stdio-vs-http-vs-sse-transport-which-to-choose/) para qualquer coisa em rede. Os SDKs tier 1 lançaram suporte em beta preservando a compatibilidade retroativa, então implantações existentes não precisam de nenhuma ação para continuar funcionando. Leia a [lista completa de mudanças](https://modelcontextprotocol.io/specification/draft/changelog) antes de presumir que isso também vale para o seu próprio código.
