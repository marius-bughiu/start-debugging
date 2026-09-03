---
title: "Claude Code 2.1.259 adiciona managedMcpServers: distribua servidores MCP sem MDM"
description: "Até agora, a única forma de entregar os mesmos servidores MCP a todo desenvolvedor era o managed-mcp.json, um arquivo em um caminho do sistema que assume controle exclusivo do MCP. O Claude Code 2.1.259 adiciona uma configuração managedMcpServers para servidores HTTP e SSE e, de quebra, reduz o alcance do allowedMcpServers."
pubDate: 2026-09-03
tags:
  - "claude-code"
  - "mcp"
  - "ai-agents"
  - "security"
lang: "pt-br"
translationOf: "2026/09/claude-code-2-1-259-managed-mcp-servers-without-mdm"
translatedBy: "claude"
translationDate: 2026-09-03
---

O Claude Code 2.1.259 saiu em 2026-09-02 com uma entrada de uma linha no changelog que resolve um problema que os administradores vêm contornando há meses: uma configuração gerenciada `managedMcpServers` que permite a uma organização fornecer servidores MCP HTTP e SSE a todos os usuários. A mesma versão alterou o `allowedMcpServers` para governar apenas os servidores que os usuários adicionam por conta própria. Essas duas linhas juntas reorganizam como funciona a governança de MCP, e a segunda remove uma proteção em que algumas equipes confiam hoje.

## Por que o managed-mcp.json era a ferramenta errada para "todo mundo recebe o Sentry"

Antes do 2.1.259 havia dois mecanismos e nenhum deles fazia distribuição direito. Listas de permissão filtram, elas não implantam: a [documentação de MCP gerenciado](https://code.claude.com/docs/en/managed-mcp) é explícita ao dizer que `allowedMcpServers` e `deniedMcpServers` "não são um registro" e que um servidor ainda precisa ser adicionado por um usuário, por um plugin ou pelo `managed-mcp.json` antes que qualquer uma das listas se aplique a ele.

Resta o `managed-mcp.json`, que de fato implanta servidores, mas vem com duas condições pesadas. É um arquivo autônomo em um caminho do sistema, então exige Jamf, Intune, Group Policy ou outra coisa com direitos de administrador na máquina:

```json
{
  "mcpServers": {
    "sentry": { "type": "http", "url": "https://mcp.sentry.dev/mcp" }
  }
}
```

Implante isso e o Claude Code carrega apenas o que o arquivo define. Servidores de plugin param de carregar. Servidores passados com `--mcp-config` são recusados. Conectores do claude.ai são suprimidos, a menos que você também defina `allowAllClaudeAiMcps`. É um mecanismo de bloqueio que por acaso distribui servidores, não um mecanismo de distribuição. E, segundo a [documentação de configurações gerenciadas pelo servidor](https://code.claude.com/docs/en/server-managed-settings), ele "não pode ser distribuído por configurações gerenciadas pelo servidor", então uma organização sem MDM não tinha caminho nenhum.

O `managedMcpServers` é uma chave de configuração em vez de um arquivo autônomo, o que significa que ele trafega pelo canal normal de configurações gerenciadas, incluindo o console de administração do claude.ai:

```json
{
  "managedMcpServers": {
    "sentry": { "type": "http", "url": "https://mcp.sentry.dev/mcp" }
  }
}
```

A restrição a HTTP e SSE é a decisão de design interessante. Uma entrada stdio seria um array argv executado em cada máquina de desenvolvimento, entregue pela rede a partir de um servidor. Limitar a chave a transportes remotos impede que uma carga de configurações vire execução remota de código.

## A lista de permissão deixou de ser uma proteção

A segunda linha do changelog importa mais do que parece. A documentação atual ainda diz que `allowedMcpServers` e `deniedMcpServers` "também se aplicam a servidores gerenciados, então um servidor gerenciado que não passar por elas não será carregado". No 2.1.259 a lista de permissão governa apenas os servidores que os usuários adicionam. Servidores enviados pelo administrador já são uma decisão do administrador, então revalidá-los contra a própria lista do administrador era redundante, mas se você escreveu uma lista estrita de `serverUrl` como verificação extra sobre tudo que carrega, ela não cobre mais o conjunto gerenciado. As listas de bloqueio não mudaram e continuam sendo mescladas de todos os escopos, e essa é a alavanca que vale manter.

A referência de configurações ainda não incorporou a nova chave, então confirme o formato da entrada em uma máquina com `claude mcp list` antes de implantar para toda a frota. Se você ainda está montando o lado de filtragem, [como controlar centralmente quais servidores MCP sua equipe pode executar](/2026/08/centrally-control-which-mcp-servers-a-team-can-run/) cobre a precedência de correspondência que derruba a maioria das primeiras implantações.

Detalhes completos no [changelog do Claude Code](https://code.claude.com/docs/en/changelog).
