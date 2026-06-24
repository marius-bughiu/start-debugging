---
title: "Cursor 3.9 empacota a configuração do seu agente em plugins portáteis"
description: "O Cursor 3.9 traz um sistema de plugins e uma página Customize unificada para que skills, regras, servidores MCP, comandos e hooks andem juntos como uma unidade versionada."
pubDate: 2026-06-24
tags:
  - "cursor"
  - "ai-agents"
  - "mcp"
lang: "pt-br"
translationOf: "2026/06/cursor-3-9-plugins-bundle-skills-rules-mcps-hooks"
translatedBy: "claude"
translationDate: 2026-06-24
---

O Cursor 3.9 chegou em 22 de junho de 2026, e o destaque não é uma troca de modelo nem um apply mais rápido. É infraestrutura: um formato de plugin de verdade mais uma única página Customize que reúne plugins, skills, MCP, subagentes, regras, comandos e hooks em uma só tela que você administra no nível de usuário, equipe ou workspace.

Se você já configurou um agente do Cursor para uma equipe, sabe por que isso importa. As peças que tornam um agente útil na sua base de código costumavam viver em lugares separados: as regras em arquivos `.mdc`, os servidores MCP na própria configuração, os comandos em outro canto, os hooks aparafusados no fim. Integrar um colega significava replicar tudo na mão. Um plugin transforma esse conjunto em um único artefato versionado e compartilhável.

## O que um plugin realmente é

Um plugin é um diretório com um manifesto em `.cursor-plugin/plugin.json`. Todo o resto é convenção:

```
my-stack/
├── .cursor-plugin/
│   └── plugin.json     # manifest
├── skills/             # subdirs with SKILL.md
├── rules/              # .mdc rule files
├── commands/           # slash commands
├── hooks/hooks.json
└── mcp.json            # MCP server definitions
```

O manifesto só exige `name` (kebab-case em minúsculas). Cada caminho de componente é opcional, e se você omiti-lo o Cursor descobre automaticamente as pastas padrão acima:

```json
{
  "name": "enterprise-plugin",
  "version": "1.2.0",
  "description": "Security scanning and compliance checks",
  "author": { "name": "ACME DevTools", "email": "devtools@acme.com" },
  "keywords": ["enterprise", "security", "compliance"],
  "rules": "rules/",
  "skills": "skills/",
  "commands": "commands/",
  "hooks": "hooks/hooks.json",
  "mcpServers": "mcp.json"
}
```

Os servidores MCP usam o mesmo formato que você já conhece do Cursor e do Claude Desktop, então as configurações existentes encaixam direto:

```json
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres"],
      "env": { "POSTGRES_CONNECTION_STRING": "${POSTGRES_URL}" }
    }
  }
}
```

Os hooks também vão no pacote. Um plugin pode forçar uma passagem de formatação após cada edição ou bloquear chamadas perigosas ao shell sem ninguém editar as configurações locais:

```json
{
  "hooks": {
    "afterFileEdit": [{ "command": "./scripts/format-code.sh" }],
    "beforeShellExecution": [
      { "command": "./scripts/validate-shell.sh", "matcher": "rm|curl|wget" }
    ]
  }
}
```

## A distribuição é o recurso de verdade

A página Customize mostra um ranking dos plugins, skills e MCP mais usados na sua equipe, e qualquer um deles é instalado com um clique. Os marketplaces de equipe agora importam repositórios de plugins do GitLab, BitBucket ou Azure DevOps, não só do GitHub, então um registro interno da empresa não obriga mais a escolher um fornecedor. Os plugins também podem trazer canvases prontos, modelos de configuração compartilhados que um colega abre e reutiliza, com os canvases do Hex e do Atlassian como primeiros exemplos.

O padrão reflete para onde o Claude Code e o ferramental mais amplo de agentes estão indo: a unidade de reuso deixa de ser um único arquivo de regras e passa a ser um pacote portátil que codifica como sua equipe quer que o agente se comporte. Se você vem copiando e colando blocos MCP e regras `.mdc` entre máquinas, fixe-os em um plugin e pare.

Veja a [referência de plugins](https://cursor.com/docs/reference/plugins) e o [changelog do 3.9](https://cursor.com/changelog) para a lista completa de campos.
