---
title: "Как запустить Claude Code в GitHub Action для автономного ревью PR"
description: "Настройте anthropics/claude-code-action@v1, чтобы каждый pull request получал автономное ревью от Claude Code без триггера @claude. Включает YAML для v1, claude_args для claude-sonnet-4-6 и claude-opus-4-7, инструменты для inline-комментариев, фильтры путей, REVIEW.md и выбор между self-hosted action и предварительной исследовательской версией Code Review."
pubDate: 2026-05-01
tags:
  - "claude-code"
  - "ai-agents"
  - "github-actions"
  - "automation"
  - "anthropic-sdk"
lang: "ru"
translationOf: "2026/05/how-to-run-claude-code-in-a-github-action-for-autonomous-pr-review"
translatedBy: "claude"
translationDate: 2026-05-01
---

Открывается pull request, GitHub Actions просыпается, Claude Code читает diff в контексте остального репозитория, оставляет inline-комментарии на строках, которые ему не нравятся, и пишет резюме. Никто не вводил `@claude`. Это рабочий процесс, который данный пост настраивает от начала до конца с помощью `anthropics/claude-code-action@v1` (GA-версия, выпущенная 26 августа 2025), `claude-sonnet-4-6` для прохода ревью и опционального обновления до `claude-opus-4-7` для путей, чувствительных к безопасности. По состоянию на май 2026 года есть два способа сделать это, и они не взаимозаменяемы, поэтому пост начинается с выбора, а затем разбирает путь self-hosted Action, который работает на любом плане.

Короткий ответ: используйте `anthropics/claude-code-action@v1`, запускаемый по `pull_request: [opened, synchronize]`, с prompt и `--allowedTools "mcp__github_inline_comment__create_inline_comment,Bash(gh pr comment:*),Bash(gh pr diff:*),Bash(gh pr view:*)"`. Пропустите фильтрацию по упоминанию `@claude`. Если у вашей организации план Team или Enterprise и вы не используете Zero Data Retention, [предварительная исследовательская версия Code Review](https://code.claude.com/docs/en/code-review) — это более простая альтернатива для той же задачи.

## Два примитива, две модели стоимости, одно решение

Anthropic в 2026 году поставляет два отдельных продукта "Claude ревьюит ваш PR". Снаружи они выглядят похоже, а ведут себя очень по-разному:

| Возможность                      | claude-code-action@v1                   | Managed Code Review (preview)              |
| :------------------------------- | :-------------------------------------- | :----------------------------------------- |
| Где работает                     | Ваши runners GitHub Actions             | Инфраструктура Anthropic                   |
| Что вы настраиваете              | Workflow YAML в `.github/workflows/`    | Toggle в `claude.ai/admin-settings`        |
| Поверхность триггеров            | Любое событие GitHub, которое вы можете описать | Выпадающий список по репо: opened, каждый push, manual |
| Модель                           | `--model claude-sonnet-4-6` или любой ID | Многоагентный флот, модель не выбирается пользователем |
| Inline-комментарии на строках diff | Через MCP-сервер `mcp__github_inline_comment` | Нативно, с маркерами серьёзности           |
| Стоимость                        | Токены API плюс минуты Actions          | $15-25 за ревью, оплачивается как дополнительное использование |
| Требование к плану               | Любой план с API-ключом                 | Team или Enterprise, только не-ZDR         |
| Доступно в Bedrock / Vertex      | Да (`use_bedrock: true`, `use_vertex: true`) | Нет                                      |
| Пользовательский prompt          | Свободный текст в поле `prompt`         | `CLAUDE.md` плюс `REVIEW.md`               |

Managed-продукт — правильный ответ, когда он вам доступен. Он запускает флот специализированных агентов параллельно и выполняет шаг проверки перед публикацией находки, что снижает количество ложных срабатываний. Компромисс в том, что вы не можете зафиксировать модель, а цена масштабируется с размером PR таким образом, что одно ревью за $25 на рефакторинге в 2000 строк может шокировать менеджера, ожидавшего оплату по тарифам токенов.

Action — правильный ответ, когда вам нужен полный контроль над prompt, нужно использовать Bedrock или Vertex для резидентности данных, нужно фильтровать по путям или именам веток, или вы не на плане Team или Enterprise. Всё ниже — это путь Action.

## Минимально жизнеспособный workflow автономного ревью

Начните в любом репо, где вы admin. Из терминала с установленным [Claude Code 2.x](https://code.claude.com/docs/en/setup):

```text
# Claude Code 2.x
claude
/install-github-app
```

Slash-команда проводит вас через установку [Claude GitHub App](https://github.com/apps/claude) на репо и сохранение `ANTHROPIC_API_KEY` как secret репо. Это работает только для прямых пользователей API Anthropic. Для Bedrock или Vertex вы вручную настраиваете OIDC, что [документация GitHub Actions](https://code.claude.com/docs/en/github-actions) описывает в разделе "Using with AWS Bedrock & Google Vertex AI."

Положите это в `.github/workflows/claude-review.yml`:

```yaml
# claude-code-action v1 (GA Aug 26, 2025), Claude Code 2.x
name: Claude Code Review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      id-token: write
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 1

      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          prompt: |
            REPO: ${{ github.repository }}
            PR NUMBER: ${{ github.event.pull_request.number }}

            Review the diff for correctness, security, and obvious bugs.
            Focus on logic errors, unhandled error paths, missing input
            validation, and tests that do not actually exercise the new
            behavior. Skip style nits. Post inline comments on the lines
            you have something concrete to say about, then a one-paragraph
            summary as a top-level PR comment.

          claude_args: |
            --model claude-sonnet-4-6
            --max-turns 8
            --allowedTools "mcp__github_inline_comment__create_inline_comment,Bash(gh pr comment:*),Bash(gh pr diff:*),Bash(gh pr view:*)"
```

Это всё. Никакого фильтра по триггеру `@claude`, никакого условия `if:` на тело комментария, никакого `mode: agent`. [Релиз v1](https://code.claude.com/docs/en/github-actions) Action автоматически определяет режим автоматизации всякий раз, когда вы передаёте поле `prompt` для события, не являющегося комментарием, поэтому условие вы больше сами не пишете. Блок `permissions` выдаёт ровно то, что нужно prompt: читать репо, писать комментарии PR и (для OIDC к облачным провайдерам) выпускать ID-токен.

Несколько вещей в этом YAML важны и легко допустить в них ошибку.

`actions/checkout@v6` с `fetch-depth: 1`. Action читает diff PR через `gh`, но prompt также позволяет ей открывать файлы в рабочем каталоге, чтобы проверить находку перед публикацией. Без checkout каждый ход "посмотри окружающий код" падает, и Claude либо угадывает, либо упирается в таймаут.

`--allowedTools "mcp__github_inline_comment__create_inline_comment,..."`. Action поставляет MCP-сервер, оборачивающий API ревью GitHub. Без этого allowlist у Claude нет способа прикрепить комментарий к конкретной строке. Он откатится на один большой комментарий PR верхнего уровня, что составляет половину ценности. Записи `Bash(gh pr ...)` ограничены чтением diff и публикацией итогового комментария.

`--max-turns 8`. Бюджет диалога. Восьми достаточно, чтобы модель прочитала diff, открыла три-четыре файла для контекста и опубликовала комментарии. Поднимать выше редко даёт ту победу, которой это кажется; если ревью упираются в таймаут, сузьте фильтр путей или смените модель, не тратьте больше ходов.

## v1 сломал множество beta-workflows

Если вы пришли с `claude-code-action@beta`, ваш старый YAML не запустится. [Таблица breaking changes](https://code.claude.com/docs/en/github-actions#breaking-changes-reference) в v1 — это шпаргалка по миграции:

| Beta-поле             | Эквивалент в v1                        |
| :-------------------- | :------------------------------------- |
| `mode: tag` / `agent` | Удалено, автоопределяется из события   |
| `direct_prompt`       | `prompt`                               |
| `override_prompt`     | `prompt` с переменными GitHub          |
| `custom_instructions` | `claude_args: --append-system-prompt`  |
| `max_turns: "10"`     | `claude_args: --max-turns 10`          |
| `model: ...`          | `claude_args: --model ...`             |
| `allowed_tools: ...`  | `claude_args: --allowedTools ...`      |
| `claude_env: ...`     | JSON-формат `settings`                 |

Шаблон ясен: каждая настройка в виде CLI схлопнулась в `claude_args`, а всё, что раньше различало "это поток триггера по комментарию или поток автоматизации", удалено, потому что v1 определяет это из события. Миграция механическая, но порядок имеет значение. Если вы оставите `mode: tag`, v1 упадёт с ошибкой конфигурации, а не молча запустит неправильный путь.

## Выбор модели: Sonnet 4.6 — это default не просто так

Action по умолчанию использует `claude-sonnet-4-6`, когда `--model` не задан, и это правильный default для ревью PR. Sonnet 4.6 быстрее, дешевле за токен и хорошо откалиброван для цикла "просканировать diff, найти очевидные баги", которым ревью PR на самом деле является. Opus 4.7 — это апгрейд, к которому вы тянетесь, когда diff затрагивает аутентификацию, шифрование, потоки оплаты или что-либо, где пропущенный баг стоит больше, чем ревью за $5.

Самый чистый шаблон — два workflows. Sonnet 4.6 на каждом PR, Opus 4.7 — только когда фильтр путей говорит, что трата того стоит:

```yaml
# Opus 4.7 review for security-critical paths only
on:
  pull_request:
    types: [opened, synchronize]
    paths:
      - "src/auth/**"
      - "src/billing/**"
      - "src/api/middleware/**"

jobs:
  review-opus:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      id-token: write
    steps:
      - uses: actions/checkout@v6
        with: { fetch-depth: 1 }

      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          prompt: |
            Treat this diff as security-sensitive. Flag any changes to
            authentication, session handling, secret storage, or trust
            boundaries. Cite a file:line for every claim about behavior,
            do not infer from naming.
          claude_args: |
            --model claude-opus-4-7
            --max-turns 12
            --allowedTools "mcp__github_inline_comment__create_inline_comment,Bash(gh pr diff:*),Bash(gh pr view:*),Bash(gh pr comment:*)"
```

Тот же приём работает в обратную сторону: ограничьте Sonnet workflow через `paths-ignore: ["docs/**", "*.md", "src/gen/**"]`, чтобы PR только с документацией не съедали токены.

## Добавление inline-комментариев и отслеживание прогресса

MCP-сервер `mcp__github_inline_comment__create_inline_comment` — это часть, которая переводит Claude из "пишет длинный комментарий PR" в "оставляет предложения на конкретных строках diff". Он добавляется через `--allowedTools`, и это вся необходимая обвязка. Модель сама решает, когда его вызывать.

Для более крупных ревью, где вы хотите видимый сигнал того, что запуск жив, Action поставляет поле `track_progress`. Установите `track_progress: true`, и Action опубликует комментарий-трекер с чекбоксами, отмечает их по мере того, как Claude завершает каждую часть ревью, и в конце помечает как готово. Полный шаблон из [официального примера `pr-review-comprehensive.yml`](https://github.com/anthropics/claude-code-action/tree/main/examples) выглядит так:

```yaml
- uses: anthropics/claude-code-action@v1
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    track_progress: true
    prompt: |
      REPO: ${{ github.repository }}
      PR NUMBER: ${{ github.event.pull_request.number }}

      Comprehensive review covering: code quality, security, performance,
      test coverage, documentation. Inline comments for specific issues,
      one top-level summary at the end.
    claude_args: |
      --allowedTools "mcp__github_inline_comment__create_inline_comment,Bash(gh pr comment:*),Bash(gh pr diff:*),Bash(gh pr view:*)"
```

`track_progress` — это самое близкое, что есть в v1, к старому UX `mode: agent` из беты, и это правильный выбор, когда ревью регулярно занимают больше минуты-двух, и автору PR хочется знать, что оно работает.

## Калибровка того, что флагает ревьюер

Workflow, который комментирует каждое имя переменной и каждую отсутствующую запятую, замолкнут в течение недели. Два файла в корне репо управляют тем, что модель воспринимает всерьёз: `CLAUDE.md` для общего поведения и (только для предварительной версии Managed Code Review) `REVIEW.md` для специфичных правил ревью. Action не загружает `REVIEW.md` автоматически, но читает `CLAUDE.md` так же, как локальная сессия Claude Code, и компактный `CLAUDE.md` плюс компактный `prompt` покрывают ту же территорию.

Правила, которые действительно меняют качество ревью, конкретны, специфичны для репо и кратки:

```markdown
# CLAUDE.md (excerpt)

## What "important" means here
Reserve "important" for findings that would break behavior in
production, leak data, or block a rollback: incorrect logic,
unscoped database queries, PII in logs, migrations that are not
backward compatible. Style and naming are nits at most.

## Cap the nits
Report at most five nits per review. If you found more, say
"plus N similar items" in the summary.

## Do not report
- Anything CI already enforces (lint, format, type errors)
- Generated files under `src/gen/` and any `*.lock`
- Test-only code that intentionally violates production rules

## Always check
- New API routes have an integration test
- Log lines do not include user IDs or request bodies
- Database queries are scoped to the caller's tenant
```

Вставка примерно того же содержимого в поле `prompt` тоже работает и имеет преимущество: правила версионируются вместе с файлом workflow. В любом случае рычаг, который имеет значение, — это "явно сказать нет объёму придирок", потому что голос ревью у Sonnet по умолчанию более дотошный, чем хочется большинству команд.

## Forks, secrets и ловушка `pull_request_target`

Событие по умолчанию `on: pull_request` запускается в контексте head-ветки PR. Для PR из forks это означает, что workflow запускается без доступа к секретам репо, включая `ANTHROPIC_API_KEY`. Очевидное на вид решение — переключиться на `pull_request_target`, который запускается в контексте base-ветки и имеет секреты. Не делайте этого для автономного ревью Claude, потому что `pull_request_target` по умолчанию выкатывает код base-ветки, то есть вы ревьюите не то дерево, а если вы измените checkout, чтобы получить head-ref, вы запускаете инструменты, управляемые моделью, против кода, контролируемого атакующим, с секретами в области видимости.

Поддерживаемые шаблоны таковы: оставить `on: pull_request` и принять, что PR из forks не получают ревью (используйте предварительную версию Managed Code Review, если их нужно покрыть), или запускать ручной workflow, который мейнтейнеры триггерят на PR из fork после визуальной проверки diff. Полное [руководство по безопасности](https://github.com/anthropics/claude-code-action/blob/main/docs/security.md) стоит прочитать один раз перед тем, как разворачивать это где-то за пределами приватного репо.

## Когда тянуться за Bedrock или Vertex

Если ваша организация работает через AWS Bedrock или Google Vertex AI, Action поддерживает оба варианта через `use_bedrock: true` или `use_vertex: true` плюс шаг с OIDC-аутентификацией перед запуском Action. Формат идентификатора модели меняется (Bedrock использует региональную префиксную форму, например `us.anthropic.claude-sonnet-4-6`), и документация облачных провайдеров проводит через настройку IAM и Workload Identity Federation. Шаблоны триггеров и prompt выше не меняются. Тот же подход документирован для Microsoft Foundry. Единственный продукт, управляемый Anthropic, который не поддерживает эти пути, — это исследовательская версия Code Review, что является одной из причин, почему self-hosted Action остаётся полезным даже после того, как managed-версия выйдет в GA.

## Связанное

- [Как запланировать повторяющуюся задачу Claude Code, которая сортирует issues GitHub](/ru/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/)
- [Как создать собственный MCP-сервер на TypeScript, оборачивающий CLI](/ru/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/)
- [Как добавить prompt caching в приложение на Anthropic SDK и измерить hit rate](/ru/2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate/)
- [Claude Code 2.1.119: ревью pull requests из GitLab и Bitbucket](/ru/2026/04/claude-code-2-1-119-from-pr-gitlab-bitbucket/)
- [Coding-агент GitHub Copilot на dotnet/runtime: десять месяцев данных](/ru/2026/03/copilot-coding-agent-dotnet-runtime-ten-months-data/)

## Источники

- [Документация Claude Code GitHub Actions](https://code.claude.com/docs/en/github-actions)
- [Документация Claude Code Code Review (исследовательская версия)](https://code.claude.com/docs/en/code-review)
- [`anthropics/claude-code-action` на GitHub](https://github.com/anthropics/claude-code-action)
- [Пример `pr-review-comprehensive.yml`](https://github.com/anthropics/claude-code-action/blob/main/examples/pr-review-comprehensive.yml)
- [Пример `pr-review-filtered-paths.yml`](https://github.com/anthropics/claude-code-action/blob/main/examples/pr-review-filtered-paths.yml)
