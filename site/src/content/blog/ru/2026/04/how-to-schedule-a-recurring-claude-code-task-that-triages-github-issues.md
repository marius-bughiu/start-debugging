---
title: "Как запланировать повторяющуюся задачу Claude Code, которая классифицирует issues GitHub"
description: "Три способа поставить Claude Code на расписание, классифицирующее issues GitHub без присмотра в 2026: облачные Routines (новая /schedule), claude-code-action v1 с cron + issues.opened и /loop в рамках сессии. Включает запускаемый prompt Routine, полный YAML GitHub Actions, ловушки jitter и identity, и когда выбирать что."
pubDate: 2026-04-27
tags:
  - "claude-code"
  - "ai-agents"
  - "github-actions"
  - "automation"
  - "anthropic-sdk"
lang: "ru"
translationOf: "2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues"
translatedBy: "claude"
translationDate: 2026-04-29
---

Запланированный проход триажа по бэклогу GitHub -- одна из самых полезных вещей, которые можно поручить агенту кодирования, и одна из самых простых, которые легко сделать неправильно. По состоянию на апрель 2026 существует три разных примитива "запланировать задачу Claude Code", они живут в разных runtime и имеют очень разные режимы отказа. Этот пост проходит по всем трём для одной и той же работы -- "каждое утро рабочего дня в 8:00 пометить и направить каждый новый issue в моём репозитории" -- используя **Claude Code v2.1.x**, GitHub Action **`anthropics/claude-code-action@v1`** и **research preview routines**, который Anthropic выпустил [14 апреля 2026](https://claude.com/blog/introducing-routines-in-claude-code). Модель -- `claude-sonnet-4-6` для prompt триажа и `claude-opus-4-7` для прохода дедупликации.

Короткий ответ: используйте **облачную Routine** с триггером расписания и триггером GitHub `issues.opened`, если в вашей учётной записи включён Claude Code в вебе. Откатывайтесь к workflow GitHub Actions с **schedule + workflow_dispatch + issues.opened**, если он нужен на Bedrock, Vertex или своих runner. Используйте **`/loop`** только для опроса ad-hoc, пока сессия открыта, никогда -- для триажа без присмотра.

## Почему существуют три варианта и какой выбрать

Anthropic намеренно поставляет три разных планировщика, потому что компромиссы реальны. Официальная [документация по scheduling](https://code.claude.com/docs/en/scheduled-tasks) кладёт их на одну страницу:

| Возможность                  | Routines (облако)        | GitHub Actions          | `/loop` (сессия)          |
| :--------------------------- | :----------------------- | :---------------------- | :------------------------ |
| Где работает                 | Инфраструктура Anthropic | Runner, размещённый GitHub | Ваш терминал           |
| Переживает закрытый ноутбук  | Да                       | Да                      | Нет                       |
| Триггер `issue.opened`       | Да (нативно)             | Да (событие workflow)   | Нет                       |
| Доступ к локальным файлам    | Нет (свежий клон)        | Да (checkout)           | Да (текущий cwd)         |
| Минимальный интервал         | 1 час                    | 5 минут (особенность cron) | 1 минута               |
| Автоматический срок          | Нет                      | Нет                     | 7 дней                    |
| Запросы разрешений           | Нет (автономно)          | Нет (`claude_args`)     | Унаследованы от сессии    |
| Требование к плану           | Pro / Max / Team / Ent.  | Любой план с API key    | Локальный CLI             |

Для "классифицировать каждый новый issue и запускать ежедневный sweep" облачная routine -- правильный примитив. У неё нативный триггер GitHub, поэтому не нужно подключать `actions/checkout`, prompt редактируется из веб-UI без PR, а запуски не съедают ваши минуты GitHub Actions. Единственная причина пропустить -- если ваша организация запускает Claude через AWS Bedrock или Google Vertex AI, в этом случае облачные routines пока недоступны и вы откатываетесь на action.

## Triage routine целиком

Routine -- это "сохранённая конфигурация Claude Code: prompt, один или несколько репозиториев и набор connectors, упакованных один раз и запускаемых автоматически". Каждый запуск -- автономная облачная сессия Claude Code без запросов разрешений, которая клонирует ваш репозиторий с дефолтной ветки и записывает любые правки кода в ветку с префиксом `claude/` по умолчанию.

Создайте её из любой сессии Claude Code:

```text
# Claude Code 2.1.x
/schedule weekdays at 8am triage new GitHub issues in marius-bughiu/start-debugging
```

`/schedule` проводит вас по той же форме, которую показывает [веб-UI на claude.ai/code/routines](https://claude.ai/code/routines): имя, prompt, репозитории, окружение, connectors и триггеры. Всё, что вы выставили в CLI, редактируется в вебе, и одна и та же routine появляется в Desktop, web и CLI сразу. Одно важное ограничение: `/schedule` подвешивает только триггеры **расписания**. Чтобы добавить триггер GitHub `issues.opened`, делающий триаж почти мгновенным, отредактируйте routine в вебе после создания.

### Prompt

Routine выполняется без человека в петле, так что prompt должен быть самодостаточным. Пример формулировки самой команды Anthropic в [документации routines](https://code.claude.com/docs/en/web-scheduled-tasks): "применяет ярлыки, назначает владельцев на основе области кода, упомянутой в issue, и публикует сводку в Slack, чтобы команда начала день с упорядоченной очередью". Конкретно:

```markdown
# Routine prompt: daily-issue-triage
# Model: claude-sonnet-4-6
# Repos: marius-bughiu/start-debugging

You are the issue triage bot for this repository. Every run, do the following.

1. List every issue opened or updated since the last successful run of this
   routine, using `gh issue list --search "updated:>=YYYY-MM-DD"` with the
   timestamp of the previous run from the routine's session history. If you
   cannot find a previous run, scope to the last 24 hours.

2. For each issue, classify it as exactly one of: bug, feature, docs,
   question, support, spam. Apply that label with `gh issue edit`.

3. Assess priority as one of: p0, p1, p2, p3. Apply that label too.
   p0 only when the issue describes a production-affecting regression
   with a reproducer.

4. Look up the touched code area. Use `gh search code --repo` and `rg`
   against the cloned working copy to find the most likely owner via
   the `CODEOWNERS` file. Assign that user. If there is no CODEOWNERS
   match, leave it unassigned and apply the `needs-triage` label.

5. Run a duplicate check. Use `gh issue list --search "<title keywords>
   in:title is:open"` to find similar open issues. If you find one with
   high confidence, post a comment on the new issue: "This looks like
   a duplicate of #N. Closing in favor of that thread; please reopen
   if I got it wrong." and then `gh issue close`.

6. Post a single Slack message to #engineering-triage via the connector
   summarizing what you did: counts per label, p0 issues by number, and
   any issue that you could not classify with confidence above 0.7.

Do not push any commits. Do not modify code. The only writes this routine
performs are GitHub label/assign/comment/close calls and one Slack message.
```

Две неочевидные детали, которые стоит закрепить:

- **Трюк "timestamp предыдущего запуска".** Routines не имеют состояния между запусками. Каждая сессия -- свежий клон. Чтобы не помечать один issue дважды, prompt должен выводить отсечку из чего-то долговременного. Либо (a) использовать GitHub identity routine для применения ярлыка `triaged-YYYY-MM-DD` и пропускать всё, что с этим ярлыком, либо (b) читать timestamp из предыдущего сообщения сводки в Slack через connector. Оба способа надёжны. Просить модель "помни, когда ты в последний раз запускалась" -- нет.
- **Правила автономного режима.** Routines работают без запросов разрешений. Сессия может выполнять shell-команды, использовать любой инструмент любого подключённого connector и вызывать `gh`. Относитесь к prompt как к политике сервисного аккаунта: проговаривайте именно то, какие записи разрешены.

### Триггеры

В форме редактирования routine подвесьте два триггера:

1. **Расписание, рабочие дни в 08:00.** Время указывается в вашей локальной зоне и преобразуется в UTC на стороне сервера, поэтому расписание US-Pacific и расписание CET сработают в одно и то же настенное время, где бы ни приземлилась облачная сессия. Routines добавляют детерминированный stagger до нескольких минут на учётную запись, поэтому не ставьте расписание на `0 8`, если важно точное время; ставьте `:03` или `:07`.
2. **Событие GitHub `issues.opened`.** Это заставляет routine срабатывать через секунды после каждого нового issue, в дополнение к sweep в 8:00. Они не дублируют друг друга: триггер расписания ловит всё, что приземляется, пока GitHub App на паузе или превысил почасовой кап на учётную запись, а триггер события не даёт свежим issues остыть на рабочий день.

Чтобы подвесить триггер `issues.opened`, [Claude GitHub App](https://github.com/apps/claude) должно быть установлено на репозитории. `/web-setup` из CLI даёт только доступ к клонированию и не включает доставку webhook, поэтому установка app через веб-UI обязательна.

### Кастомное cron-выражение

Пресеты расписания: ежечасно, ежедневно, рабочие дни и еженедельно. Для всего прочего выберите ближайший пресет в форме, а затем перейдите в CLI:

```text
/schedule update
```

Пройдите по подсказкам до раздела расписания и предоставьте кастомное 5-польное cron-выражение. Единственное жёсткое правило -- **минимальный интервал один час**; выражение типа `*/15 * * * *` отклоняется при сохранении. Если вам действительно нужна более плотная каденция, это сигнал, что вы хотите путь GitHub Actions или триггер события, а не триггер расписания.

## Запасной вариант через GitHub Actions

Если ваша команда на Bedrock или Vertex или вы просто предпочитаете аудит-трейл логов запусков Actions, та же работа выполняется как workflow с `claude-code-action@v1`. Action вышла GA 26 августа 2025, и поверхность v1 унифицирована вокруг двух входов: `prompt` и строка `claude_args`, передающая любой флаг прямо в CLI Claude Code. Полная таблица обновлений с beta-поверхности живёт в [документации GitHub Actions](https://code.claude.com/docs/en/github-actions#breaking-changes-reference).

```yaml
# .github/workflows/issue-triage.yml
# claude-code-action v1, claude-sonnet-4-6, schedule + issues.opened + manual
name: Issue triage

on:
  schedule:
    - cron: "3 8 * * 1-5"  # weekdays 08:03 UTC, off the :00 boundary
  issues:
    types: [opened]
  workflow_dispatch:        # manual run from the Actions tab

permissions:
  contents: read
  issues: write
  pull-requests: read
  id-token: write

jobs:
  triage:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4

      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          prompt: |
            REPO: ${{ github.repository }}
            EVENT: ${{ github.event_name }}
            ISSUE: ${{ github.event.issue.number }}

            On a schedule run, list open issues updated in the last 24 hours
            and triage each one. On an `issues.opened` event, triage only
            the single issue ${{ github.event.issue.number }}.

            For each issue:
            1. Classify as bug / feature / docs / question / support / spam.
            2. Assess priority p0 / p1 / p2 / p3.
            3. Apply both labels with `gh issue edit`.
            4. Resolve the touched area via CODEOWNERS and assign the owner,
               or apply `needs-triage` if no match.
            5. Search for duplicates by title keywords. Comment and close
               only if confidence is high.

            Do not edit code. Do not push. Only GitHub label / assign /
            comment / close calls are allowed.
          claude_args: |
            --model claude-sonnet-4-6
            --max-turns 12
            --allowedTools "Bash(gh:*),Read,Grep"
```

Три вещи, которые этот workflow делает правильно и которые самописный cron не делает. **`workflow_dispatch`** рядом с `schedule` ставит кнопку "Run workflow" во вкладку Actions, чтобы можно было тестировать, не дожидаясь 8:00. **`--allowedTools "Bash(gh:*),Read,Grep"`** использует тот же gating, что и локальный CLI; без него у action также был бы доступ к `Edit` и `Write`. **Минута `:03`** обходит широкую недетерминированную задержку, которую GitHub Actions добавляет к cron-триггерам free-tier в часы пик. По сути, это [пример issue triage](https://github.com/anthropics/claude-code-action/blob/main/docs/solutions.md) из руководства решений action, с триггером расписания и более узким allowlist инструментов.

## Когда `/loop` -- правильный примитив

`/loop` -- третий вариант и тот, к которому стоит обращаться **меньше всего** для триаж-работы. [Документация scheduled-tasks](https://code.claude.com/docs/en/scheduled-tasks) перечисляет ограничения:

- Задачи срабатывают только пока Claude Code запущен и простаивает. Закрытие терминала их останавливает.
- Повторяющиеся задачи истекают через 7 дней после создания.
- Сессия может одновременно держать до 50 запланированных задач.
- Cron соблюдается с гранулярностью в одну минуту, с jitter до 10%, ограниченным 15 минутами.

Правильное использование `/loop` -- нянчить triage routine, которую вы ещё настраиваете, а не запускать сам триаж. Внутри открытой сессии, направленной на репозиторий:

```text
/loop 30m check the last 5 runs of the daily-issue-triage routine on
claude.ai/code/routines and tell me which ones produced label edits
that look wrong. Skip silently if nothing has changed.
```

Claude преобразует `30m` в cron-выражение, планирует prompt под сгенерированным 8-символьным ID и перезапускает между вашими ходами, пока вы не нажмёте `Esc` или не пройдёт семь дней. Это действительно полезно для петли обратной связи "не дрейфует ли routine?" пока человек у клавиатуры. Это неподходящая форма для "работать вечно без присмотра".

## Подводные камни, о которых стоит знать перед первым запуском

Несколько вещей укусят вас при первом запланированном запуске, если не подготовиться.

**Identity.** Routines принадлежат вашему индивидуальному аккаунту claude.ai, и всё, что routine делает через подключённую GitHub identity, выглядит как сделанное вами. Для open-source репозитория устанавливайте routine от выделенного бот-аккаунта, либо используйте путь GitHub Actions с отдельной установкой бота [Claude GitHub App](https://github.com/anthropics/claude-code-action).

**Дневной лимит запусков.** У routines дневной лимит на план (Pro 5, Max 15, Team и Enterprise 25). Каждое событие `issues.opened` -- один запуск, поэтому репо, получающее 30 issues в день, упирается в лимит до обеда, если не включить дополнительное использование в billing. Routine только с расписанием и путь GitHub Actions оба обходят это; второй биллится против API-токенов.

**Безопасность push в ветки.** По умолчанию routine может пушить только в ветки с префиксом `claude/`. Triage prompt выше вообще ничего не пушит, но расширение его до открытия PR с фиксом означает либо принять префикс, либо включить **Allow unrestricted branch pushes** на репозиторий. Не щёлкайте этим переключателем рассеянно.

**Beta-заголовок `experimental-cc-routine-2026-04-01`.** Endpoint `/fire`, на котором держится API-триггер, сегодня поставляется под этим заголовком. Anthropic поддерживает рабочими две последние датированные версии при поломках, поэтому встройте заголовок в константу и ротируйте на сменах версий, а не в каждом webhook.

**Stagger и отсутствие catch-up.** Оба runtime добавляют детерминированный сдвиг (до 10% периода для routines, гораздо шире для Actions free-tier в часы пик), и ни один не воспроизводит пропущенные срабатывания. Связка `schedule + issues.opened` лучше справляется с дырой catch-up, чем только schedule, потому что триггер события покрывает мёртвую зону.

## Связанное чтение

- Полный релиз Claude Code, открывший `--from-pr` для GitLab и Bitbucket, хорошо сочетается с облачными routines: см. [Claude Code 2.1.119: PR из GitLab, Bitbucket и GHE](/2026/04/claude-code-2-1-119-from-pr-gitlab-bitbucket/).
- Если вы хотите, чтобы routine читала из бизнес-системы на `.NET` во время триажа, сначала откройте её через MCP. Прохождение в [Как создать собственный MCP-сервер на C# на .NET 11](/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/).
- Для эквивалента в формате GitHub Copilot версия с agent skills в [Visual Studio 2026 Copilot agent skills](/ru/2026/04/visual-studio-2026-copilot-agent-skills/).
- Для C#-разработчиков, строящих agent runner со стороны Microsoft, а не Anthropic, [Microsoft Agent Framework 1.0](/ru/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) -- готовая к продакшену точка входа.
- А по экономике bring-your-own-key, если вы предпочитаете платить за токены против другой модели, см. [GitHub Copilot в VS Code с BYOK Anthropic, Ollama и Foundry Local](/ru/2026/04/github-copilot-vs-code-byok-anthropic-ollama-foundry-local/).

Routines пока в research preview, поэтому точный UI и beta-заголовок `/fire` будут двигаться. Однако модель, на которую всё это нацелено, стабильна: самодостаточный prompt, ограниченный доступ к инструментам, детерминированные триггеры и аудит-трейл на каждый запуск. Это та часть, которую стоит проектировать тщательно. Runtime -- та часть, которую можно поменять.
