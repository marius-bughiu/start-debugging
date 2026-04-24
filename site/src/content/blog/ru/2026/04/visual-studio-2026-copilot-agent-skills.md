---
title: "Agent Skills приходят в Visual Studio 2026 18.5: Copilot автоматически находит SKILL.md в вашем репозитории"
description: "Visual Studio 2026 18.5.0 позволяет GitHub Copilot подгружать Agent Skills из .github/skills, .claude/skills и ~/.copilot/skills. Переиспользуемые пакеты инструкций SKILL.md путешествуют вместе с репозиторием."
pubDate: 2026-04-20
tags:
  - "visual-studio"
  - "github-copilot"
  - "agent-skills"
  - "dotnet"
lang: "ru"
translationOf: "2026/04/visual-studio-2026-copilot-agent-skills"
translatedBy: "claude"
translationDate: 2026-04-24
---

Релиз Visual Studio 2026 от 14 апреля 2026 (версия 18.5.0) тихо добавил одну из самых полезных фич Copilot за год: [Agent Skills](https://learn.microsoft.com/en-us/visualstudio/releases/2026/release-notes). Если вы последние полгода копировали один и тот же абзац «вот как мы ревьюим pull requests в этом репозитории» в Copilot Chat - можно остановиться. Agent Skills - это переиспользуемые пакеты инструкций, живущие рядом с кодом, и Copilot в Visual Studio теперь находит их автоматически.

## Где Visual Studio ищет skills

Skill - это просто папка с файлом `SKILL.md` внутри. Visual Studio 2026 18.5 сканирует шесть известных мест: три привязаны к workspace, три - к вашему пользовательскому профилю:

- Workspace: `.github/skills/`, `.claude/skills/`, `.agents/skills/`
- Личное: `~/.copilot/skills/`, `~/.claude/skills/`, `~/.agents/skills/`

Дублирование сделано намеренно. [Спецификация agentskills.io](https://agentskills.io/specification) - открытый формат, и те же папки читают GitHub Copilot CLI, облачный агент Copilot и VS Code. Положите skill в `.github/skills/` - и его увидит каждая поверхность Copilot, которую использует ваша команда, а не только IDE на вашей машине.

## Как на самом деле выглядит SKILL.md

Файл - это Markdown с YAML frontmatter в шапке. У frontmatter два обязательных поля, `name` и `description`, плюс несколько необязательных, описывающих, как skill вызывается:

```markdown
---
name: efcore-migration-review
description: Reviews EF Core migration files in this repo. Use whenever the user asks Copilot to add, squash, or review a migration under src/Infrastructure/Migrations.
argument-hint: [migration file path]
user-invocable: true
disable-model-invocation: false
---

# EF Core migration review

When reviewing a migration under `src/Infrastructure/Migrations`:

1. Reject any migration that drops a column without a corresponding data backfill step.
2. Flag `AlterColumn` calls that change nullability on tables with more than 10M rows. Point at `docs/ops/large-table-playbook.md`.
3. Require a matching `Down()` that is a true inverse, not an empty stub.

Reference implementation: see `examples/add-index-migration.md` in this skill folder.
```

Поле `name` должно быть в нижнем регистре, через дефис, не длиннее 64 символов и должно совпадать с именем папки. Поле `description` - это то, по чему Copilot решает, загружать ли skill, поэтому стоит писать его как retrieval-запрос, а не как слоган. Максимальная длина - 1024 символа, и стоит их использовать.

## Почему это меняет умолчание

Раньше обычным шаблоном был раздутый `.github/copilot-instructions.md` или кастомный агент, определённый в `.agent.md`. Agent Skills уже по дизайну: каждый skill - это одна забота, загружаемая по запросу, и в контекстное окно попадает только её тело, когда description совпадает. Для .NET-монорепозитория с миграциями EF Core, кодом платформы MAUI и контроллерами ASP.NET Core можно поставить три отдельных skill вместо одного гигантского файла инструкций и перестать жечь токены на наставления, нерелевантные текущей задаче.

Skills также композируются с Custom Agents. Файл `.agent.md` может ограничивать, какие skills он подтягивает - так команды и приходят к агенту «backend-reviewer», видящему только skills EF Core и ASP.NET Core, и агенту «mobile-reviewer», видящему MAUI и Flutter.

Microsoft отмечает, что UI для просмотра и создания ещё появится в одном из последующих обновлений 18.x, так что пока это текстовые файлы в папках. Это нормально. Текстовые файлы в папках - именно то, для чего нужна система контроля версий.
