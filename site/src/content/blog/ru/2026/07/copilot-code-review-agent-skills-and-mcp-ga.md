---
title: "Copilot code review теперь читает вашу папку .github/skills"
description: "Agent skills и MCP-серверы в GitHub Copilot code review стали общедоступными 2026-07-29. Где лежат файлы, почему skills загружаются из head-ветки и почему любой вызов MCP-инструмента в ревью доступен только на чтение."
pubDate: 2026-07-31
tags:
  - "github-copilot"
  - "agent-skills"
  - "mcp"
  - "code-review"
  - "ai-agents"
lang: "ru"
translationOf: "2026/07/copilot-code-review-agent-skills-and-mcp-ga"
translatedBy: "claude"
translationDate: 2026-07-31
---

2026-07-29 GitHub перевёл [agent skills и поддержку MCP в Copilot code review](https://github.blog/changelog/2026-07-29-copilot-code-review-agent-skills-and-mcp-now-generally-available/) в статус общедоступных для Copilot Pro, Pro+, Business и Enterprise. До сих пор ревьюер читал ваш diff и ваши пользовательские инструкции, и этим контекстное окно исчерпывалось. Теперь он может подтягивать те же папки skills, которые использует ваш агент для кода, плюс контекст только для чтения из MCP-серверов.

Это закрывает самый раздражающий пробел автоматического ревью: бот мог сказать, что не хватает проверки на `null`, но не имел представления о том, что ваша команда требует непустой `Down()` в каждой миграции EF Core, и не мог посмотреть, не был ли issue, который закрывает этот PR, уже откачен в прошлом спринте.

## Skills это папки, и ревьюер выбирает их сам

Skill представляет собой каталог внутри `.github/skills` с файлом `SKILL.md`. Copilot сопоставляет задачу с полем `description` каждой skill и загружает только то, что выглядит уместным, поэтому skill для ревью нуждается в имени каталога и описании, которые звучат как работа ревьюера.

```md
---
name: ef-core-migration-review
description: Review EF Core migrations for a non-empty Down(), no data loss on column drops, and an explicit index name. Use when the diff touches Migrations/.
---

## What to flag

- A `Down()` method with only `// no-op` or an empty body. Every migration must be reversible.
- `DropColumn` without a preceding data copy. Comment with the backfill snippet from `references/backfill.md`.
- `CreateIndex` without an explicit `name:` argument.
```

Деталь, которую стоит знать: Copilot code review читает инструкции и skills из **head-ветки**, а не из базовой. Отредактируйте skill и откройте PR, и этот же PR будет проверен уже отредактированной skill. Итерировать правила ревью можно, не вливая их заранее, что противоположно поведению большинства конфигураций линтеров в CI.

## MCP включён по умолчанию и по замыслу работает только на чтение

MCP-серверы для ревью настраиваются в настройках репозитория, в разделе Copilot > MCP servers, тем же JSON, который использует облачный агент. Серверы GitHub и Playwright включены изначально.

```json
{
  "mcpServers": {
    "issue-tracker": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer $COPILOT_MCP_TRACKER_TOKEN" },
      "tools": ["search_issues", "get_issue"]
    }
  }
}
```

Токены хранятся в настройках репозитория, в разделе Secrets and variables > Agents, и подставляются как `$COPILOT_MCP_*`. Любой вызов MCP-инструмента во время ревью ограничен чтением, и это правильное решение: ревьюер, способный писать в ваш issue tracker, это ревьюер, которым можно управлять через prompt injection из тела pull request. Учтите, что `"tools": ["*"]` по-прежнему принимается, но сам GitHub рекомендует разрешать конкретные инструменты, поскольку агент применяет их автономно, без шага подтверждения.

Если вы предпочитаете оставить MCP только облачному агенту, настройка репозитория "Allow Copilot to use MCP tools when reviewing pull requests" включена по умолчанию и её можно отключить. Комментарии ревью, опирающиеся на skill или на MCP-инструмент, теперь снабжаются указанием источника, так что видно, какое правило породило какое замечание.

Если в вашем репозитории всё ещё есть папка `.github/prompts/`, это повод довести до конца [миграцию prompt-файлов на agent skills](/2026/07/migrate-copilot-prompt-files-to-agent-skills/): один и тот же `SKILL.md` теперь питает IDE, облачного агента и ревьюера.
