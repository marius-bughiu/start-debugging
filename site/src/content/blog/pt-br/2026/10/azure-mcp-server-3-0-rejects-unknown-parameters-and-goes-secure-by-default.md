---
title: "Azure MCP Server 3.0 rejeita parâmetros desconhecidos e cria recursos seguros por padrão"
description: "O Azure MCP Server 3.0.0 foi lançado em 12 de outubro de 2026. Chamadas de ferramenta com parâmetros desconhecidos agora falham, opções como subscription e tenant foram removidas de várias ferramentas, novas contas Storage desabilitam a autenticação Shared Key e o servidor fala o protocolo MCP stateless 2026-07-28."
pubDate: 2026-10-13
tags:
  - "mcp"
  - "azure"
  - "dotnet"
  - "ai-agents"
lang: "pt-br"
translationOf: "2026/10/azure-mcp-server-3-0-rejects-unknown-parameters-and-goes-secure-by-default"
translatedBy: "claude"
translationDate: 2026-10-13
---

O [Azure MCP Server 3.0.0](https://github.com/microsoft/mcp/releases/tag/Azure.Mcp.Server-3.0.0) foi lançado em 12 de outubro de 2026, depois de 50 builds beta. O destaque é uma pilha de novos namespaces (`azurebackup`, `resiliency`, `sreagent`, `azureterraform`, `advisor`, `iothub`), mas o que pode quebrar uma configuração que funciona hoje é mais discreto: os contratos das ferramentas ficaram mais rígidos, e os recursos criados pelo servidor agora vêm protegidos por padrão.

## Parâmetros desconhecidos agora são um erro

Na 2.x, uma ferramenta ignorava em silêncio as opções que não usava. A 3.0 remove parâmetros não utilizados como `subscription`, `resource-group`, `tenant`, `auth-method`, `user` e `sender-name` das ferramentas de quase todos os namespaces (Key Vault, Storage, SQL, Redis, Service Bus, AKS e outros) e, em seguida, rejeita qualquer chamada que ainda os envie. As opções personalizadas de política de retry também sumiram; valem os padrões de retry do Azure SDK.

Isso importa se você aciona o `azmcp` por scripts, ou se tem prompts e instruções de agente salvos que mandam o modelo sempre informar uma subscription. Uma chamada que funcionava na 2.x assim:

```bash
azmcp keyvault secret get --subscription 00000000-0000-0000-0000-000000000000 \
  --vault my-vault --secret db-password --retry-max-retries 5
```

agora falha na validação da 3.0: `keyvault secret get` aceita apenas `--vault` e um `--secret` opcional, e as opções globais `--retry-*` não existem mais. Remova-as e consulte a [referência de comandos](https://github.com/microsoft/mcp/blob/release/azure/3.x/servers/Azure.Mcp.Server/docs/azmcp-commands.md) para ver o que cada ferramenta realmente aceita. Alguns payloads de resultado também foram normalizados em objetos nomeados (`{ servers }`, `{ results }`, `{ guidance }`), então parsers que leem os formatos antigos precisam de uma revisão.

Duas renomeações a observar: `monitor healthmodels entity get` virou `list` e `get`, e o código do servidor passou de `Azure.Mcp.Core.*` para `Microsoft.Mcp.Core.*`. As categorias de logger seguem os namespaces, então uma entrada `Logging:LogLevel:Azure.Mcp.Core` na sua configuração deixa de corresponder a qualquer coisa.

## Criação de recursos segura por padrão

Quando um agente cria recursos por meio do servidor, os padrões mudaram:

- Contas Storage desabilitam a autenticação Shared Key (HTTPS, TLS 1.2 e nenhum acesso anônimo a blobs continuam ativos).
- Namespaces do Event Hubs desabilitam a autenticação local.
- Compartilhamentos de arquivos NFS usam `RootSquash` por padrão, com trânsito criptografado.
- `compute vm create` e `compute vmss create` exigem `--image`; os aliases `Win2019Datacenter` e `Ubuntu2004` foram removidos.

Se o código downstream se conecta com uma chave de conta ou com um SAS assinado por ela, receberá um 403 em uma conta recém-criada. Esse é o objetivo: use Entra ID e `DefaultAzureCredential`.

As ferramentas `database query` de MySQL e PostgreSQL mudaram na direção oposta. Agora são marcadas como destrutivas, não filtram mais instruções pelo verbo SQL e dependem das permissões de banco de dados do usuário autenticado. Execute o servidor com `--read-only` ou use um login de banco somente leitura se o agente deve apenas consultar.

## Protocolo stateless e saída estruturada

A 3.0 passa para o protocolo stateless `2026-07-28` do MCP e mantém compatibilidade com clientes na `2025-11-25`. Se você não acompanhou essa revisão, cobri o que desaparece (sem handshake `initialize`, sem `Mcp-Session-Id`) em [servidores MCP stateful vs stateless](/2026/08/stateful-vs-stateless-mcp-servers-what-breaks-when-the-session-goes-away/).

As ferramentas agora também podem retornar `outputSchema` e `structuredContent`, ativados por uma flag. Com o `dnx` do .NET 10, a entrada do `mcp.json` fica assim:

```json
{
  "mcpServers": {
    "azure-mcp-server": {
      "command": "dnx",
      "args": [
        "Azure.Mcp", "--version", "3.0.0", "--yes", "--",
        "azmcp", "server", "start",
        "--read-only",
        "--structured-output-mode", "compact"
      ],
      "type": "stdio"
    }
  }
}
```

`compact` envia um texto curto em `content` e o resultado completo em `structuredContent`; `duplicated` envia o resultado completo nos dois. Ative apenas se o seu cliente entender esses campos.

## Correções menores que justificam a atualização

Mensagens de log e exceções que vazavam para o stdout (e podiam corromper a saída JSON-RPC) agora vão para o stderr, erros de não encontrado retornam 404 em vez de 500, e o wrapper npm não edita mais o `package.json` do projeto chamador quando instala automaticamente um pacote de plataforma. Fixe `Azure.Mcp` 3.0.0 ou `@azure/mcp@3.0.0` explicitamente em vez de `@latest` até que seus scripts e prompts estejam limpos.
