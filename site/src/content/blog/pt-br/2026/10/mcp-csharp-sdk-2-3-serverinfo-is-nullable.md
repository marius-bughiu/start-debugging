---
title: "MCP C# SDK 2.3: McpClient.ServerInfo agora é anulável, e o seu build pode perceber"
description: "O ModelContextProtocol 2.3.0, lançado em 20 de outubro de 2026, muda McpClient.ServerInfo de Implementation para Implementation? porque servidores 2026-07-28 podem omitir a própria identidade em server/discover. Veja o motivo, o que quebra com warnings como erros e a correção de uma linha."
pubDate: 2026-10-21
tags:
  - "mcp"
  - "dotnet"
  - "csharp"
  - "ai-agents"
lang: "pt-br"
translationOf: "2026/10/mcp-csharp-sdk-2-3-serverinfo-is-nullable"
translatedBy: "claude"
translationDate: 2026-10-21
---

O [MCP C# SDK 2.3.0](https://github.com/modelcontextprotocol/csharp-sdk/releases/tag/v2.3.0) foi lançado em 20 de outubro de 2026 e traz uma mudança que uma versão minor normalmente não traria: `McpClient.ServerInfo` agora é anotado como `Implementation?` em vez de `Implementation`. A assinatura no CLR é idêntica, então nada quebra em runtime nem para chamadores já compilados. O que quebra é qualquer projeto com `<Nullable>enable</Nullable>` e `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>` que acesse a propriedade diretamente.

## Por que um servidor conectado pode não ter identidade

Na revisão `2026-07-28` do protocolo, o handshake é `server/discover` em vez do `initialize` legado. Na descoberta, o metadado `io.modelcontextprotocol/serverInfo` é opcional. Um servidor pode responder à descoberta, anunciar suas ferramentas e atender chamadas sem nunca dizer quem é.

Antes da 2.3.0, o SDK não modelava isso. Conectar a um servidor assim funcionava, mas ler `ServerInfo` depois lançava `InvalidOperationException`, a mesma exceção que você recebe quando o cliente nem está conectado. Um servidor perfeitamente válido parecia uma conexão quebrada. O [PR #1903](https://github.com/modelcontextprotocol/csharp-sdk/pull/1903) corrigiu isso retornando `null`:

```csharp
public override Implementation? ServerInfo => _serverCapabilities is null
    ? throw new InvalidOperationException("The client is not connected.")
    : _serverInfo;
```

Disso saem três regras:

- Ainda não conectado: continua lançando `InvalidOperationException`.
- Conectado via `2026-07-28` e o servidor omitiu a identidade: `null`.
- Conectado via `initialize` legado: nunca `null`, porque esse caminho ainda exige `serverInfo`.

Metadados malformados ainda fazem a conexão falhar com uma `JsonException`, então `null` realmente significa "não informado", não "lixo".

## A correção no código do cliente

Código como este agora gera CS8602 no acesso a `.Name`:

```csharp
await using var client = await McpClient.CreateAsync(transport);

logger.LogInformation("Connected to {Server} {Version}",
    client.ServerInfo.Name, client.ServerInfo.Version);
```

Trate o caso nulo explicitamente:

```csharp
await using var client = await McpClient.CreateAsync(transport);

var name = client.ServerInfo?.Name ?? "Unknown server";
var version = client.ServerInfo?.Version ?? "n/a";

logger.LogInformation("Connected to {Server} {Version}", name, version);
```

Resista ao operador `!`. Ele silencia o aviso e traz de volta uma `NullReferenceException` na primeira vez que alguém apontar seu cliente para um servidor que só faz descoberta. As notas de versão também são diretas ao dizer que essa identidade autodeclarada "não deve ser usada para decisões de segurança". Se o seu código libera acesso a ferramentas com base em `ServerInfo.Name`, isso já estava errado, e um `null` aqui é um bom momento para trocar por uma configuração que você controla.

## O restante da 2.3.0

A versão traz principalmente trabalho de interoperabilidade e confiabilidade que vale a pena adotar de qualquer forma:

- `McpClientOptions.TimeProvider` permite que os testes controlem os timeouts do cliente com `FakeTimeProvider` em vez de esperas reais. O OAuth agora fica fora do orçamento curto de `DiscoverProbeTimeout`, mas continua limitado por `InitializationTimeout`.
- Ferramentas, prompts e recursos são listados na ordem de registro (#1924), então a saída de `tools/list` é estável entre execuções.
- As respostas Streamable HTTP modernas esperam a primeira mensagem do protocolo antes de enviar os cabeçalhos. Um handler que fica em silêncio por muito tempo pode agora precisar de notificações de progresso ou de um timeout HTTP maior.
- Clientes stdio fecham o stdin do servidor antes de aguardar um encerramento gracioso, e as respostas POST do SSE legado são descartadas de forma determinística.
- As respostas 400 do Streamable HTTP incluem o erro de parse do JSON, o que torna muito mais rápido depurar payloads malformados do cliente.

Atualizar é só trocar a versão do pacote:

```bash
dotnet add package ModelContextProtocol --version 2.3.0
```

Se você ainda está na 1.x, faça primeiro a [migração da 1.x para a 2.x](/2026/09/migrate-mcp-csharp-sdk-1-x-to-2-0-without-breaking-old-clients/), depois compile com warnings como erros e deixe o compilador mostrar cada acesso a `ServerInfo`.
