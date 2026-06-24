---
title: "Cursor 3.9 упаковывает конфигурацию вашего агента в переносимые плагины"
description: "Cursor 3.9 добавляет систему плагинов и единую страницу Customize, чтобы skills, правила, серверы MCP, команды и hooks перемещались вместе как одна версионируемая единица."
pubDate: 2026-06-24
tags:
  - "cursor"
  - "ai-agents"
  - "mcp"
lang: "ru"
translationOf: "2026/06/cursor-3-9-plugins-bundle-skills-rules-mcps-hooks"
translatedBy: "claude"
translationDate: 2026-06-24
---

Cursor 3.9 вышел 22 июня 2026 года, и главное здесь не смена модели и не более быстрый apply. Это инфраструктура: настоящий формат плагина плюс единая страница Customize, которая собирает плагины, skills, MCP, субагентов, правила, команды и hooks на одном экране, управляемом на уровне пользователя, команды или workspace.

Если вы настраивали агента Cursor для команды, вы понимаете, почему это важно. Части, которые делают агента полезным в вашей базе кода, раньше жили в разных местах: правила в файлах `.mdc`, серверы MCP в собственной конфигурации, команды где-то ещё, hooks прикручены в конце. Подключение коллеги означало воспроизведение всего этого вручную. Плагин превращает этот набор в один версионируемый и распространяемый артефакт.

## Что такое плагин на самом деле

Плагин -- это каталог с манифестом по пути `.cursor-plugin/plugin.json`. Всё остальное -- соглашение:

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

Манифест требует только `name` (kebab-case в нижнем регистре). Каждый путь к компоненту необязателен, и если его опустить, Cursor автоматически обнаружит папки по умолчанию, указанные выше:

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

Серверы MCP используют ту же форму, которую вы уже знаете по Cursor и Claude Desktop, поэтому существующие конфигурации подходят напрямую:

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

Hooks тоже входят в комплект. Плагин может принудительно запускать форматирование после каждой правки или блокировать опасные вызовы shell без того, чтобы кто-то редактировал локальные настройки:

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

## Распространение -- вот настоящая возможность

Страница Customize показывает рейтинг самых используемых плагинов, skills и MCP в вашей команде, и любой из них устанавливается в один клик. Командные маркетплейсы теперь импортируют репозитории плагинов из GitLab, BitBucket или Azure DevOps, а не только из GitHub, поэтому внутренний реестр компании больше не вынуждает выбирать поставщика. Плагины также могут нести готовые canvases -- общие шаблоны настройки, которые коллега открывает и переиспользует, с canvases Hex и Atlassian в качестве первых примеров.

Этот подход отражает то, куда движутся Claude Code и более широкий инструментарий для агентов: единицей переиспользования становится не отдельный файл правил, а переносимый комплект, который кодирует, как ваша команда хочет, чтобы агент себя вёл. Если вы копировали блоки MCP и правила `.mdc` между машинами, закрепите их в плагине и прекратите это делать.

Полный список полей смотрите в [справочнике по плагинам](https://cursor.com/docs/reference/plugins) и в [changelog 3.9](https://cursor.com/changelog).
