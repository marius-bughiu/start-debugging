---
title: "Listas de permissão de MCP chegam às configurações gerenciadas de empresa do Copilot"
description: "O changelog do GitHub de 6 de agosto de 2026 adiciona allowedMcpServers e deniedMcpServers ao copilot/managed-settings.json. Matchers por URL e argv, precedência da negação e um padrão que falha fechado, algo que o registro baseado em nomes nunca teve."
pubDate: 2026-08-09
tags:
  - "github-copilot"
  - "mcp"
  - "ai-agents"
  - "security"
lang: "pt-br"
translationOf: "2026/08/copilot-mcp-allowlists-enterprise-managed-settings"
translatedBy: "claude"
translationDate: 2026-08-09
---

Em 2026-08-06 o GitHub lançou [MCP allowlists in enterprise managed settings](https://github.blog/changelog/2026-08-06-mcp-allowlists-in-enterprise-managed-settings/). Duas chaves, `allowedMcpServers` e `deniedMcpServers`, agora decidem quais servidores Model Context Protocol um cliente do Copilot pode iniciar. Está em disponibilidade geral e vale para o app do GitHub Copilot, para o Copilot CLI e para o VS Code.

Isso fecha uma lacuna que estava aberta desde que o suporte a MCP se espalhou. A resposta anterior no nível de empresa era o [registro MCP personalizado](https://docs.github.com/en/copilot/concepts/mcp-management), ainda em versão prévia pública, que identifica servidores por nome ou ID. Nomes são rótulos definidos pelo usuário, então quem quiser um servidor bloqueado apenas o renomeia na própria máquina. A documentação do GitHub é direta sobre a consequência: os usuários podem contornar a restrição editando arquivos de configuração.

## Os matchers são a história inteira

O arquivo fica no repositório `.github-private` da empresa, em `copilot/managed-settings.json`, na branch padrão. Cada entrada identifica um servidor por exatamente um matcher.

```json
{
  "allowedMcpServers": [
    { "serverUrl": "https://api.githubcopilot.com/*" },
    { "serverCommand": ["npx", "@playwright/mcp@latest"] },
    { "serverCommand": ["cmd", "/c", "uvx", "markitdown-mcp"] }
  ],
  "deniedMcpServers": [
    { "serverUrl": "https://learn.microsoft.com/*" }
  ]
}
```

Repare que `serverCommand` é um array argv, não uma string de shell, e a correspondência é exata. `serverUrl` aceita curingas `*` e a URL é canonicalizada antes da comparação, então truques de codificação ou de barra final não compram um veredito diferente. `serverName` continua existindo, mas só como alternativa: para um servidor remoto a correspondência precisa vir de uma entrada `serverUrl`, e `serverName` só conta quando não existe nenhuma entrada `serverUrl`. A mesma relação vale entre servidores stdio e `serverCommand`. Trate isso como conveniência, não como fronteira de segurança.

## Os padrões falham fechados

A distinção entre vazio e não definido é onde os times vão tropeçar:

- `allowedMcpServers` não definido permite todos os servidores que não sejam os padrão.
- `allowedMcpServers: []` bloqueia todos eles. Esse é o seu botão de negar tudo.
- `deniedMcpServers` não definido ou vazio não bloqueia nada.
- A negação sempre vence. Um servidor que casa com as duas listas fica bloqueado.
- Servidores próprios, como o servidor MCP embutido do GitHub, ficam isentos das duas listas.

Além disso, uma configuração malformada ou não verificável é bloqueada em vez de permitida, e quando as políticas vêm de mais de uma camada o servidor precisa passar por todas elas. Esse é o modo de falha inverso ao do registro, e é a razão real para migrar.

Para times que precisam da própria lista, envolva os objetos matcher sob `overridable` no nível da empresa e depois use a sintaxe simples no arquivo de cada time. Onde houver conflito, a decisão da plataforma vence.

## Combine com controle de saída, não substitua por ele

Uma lista de permissão governa quais processos de servidor sobem e com quais endpoints MCP se conversa. Ela não diz nada sobre para onde uma ferramenta se conecta depois que já está rodando, que é uma superfície de controle separada e está coberta em [como restringir a saída de rede de um agente de código](/2026/07/how-to-lock-down-a-coding-agents-network-egress-with-a-strict-host-allowlist/). Duas camadas, dois modos de falha.

A sintaxe completa dos matchers está na [Enterprise managed settings reference](https://docs.github.com/en/copilot/reference/enterprise-managed-settings-reference).
