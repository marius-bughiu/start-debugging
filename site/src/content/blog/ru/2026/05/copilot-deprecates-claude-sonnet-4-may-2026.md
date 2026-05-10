---
title: "GitHub Copilot убирает Claude Sonnet 4 со всех поверхностей"
description: "GitHub отказался от claude-sonnet-4 6 мая 2026 года в Copilot Chat, inline-редактировании, режимах ask и agent, а также в автодополнении кода. Рекомендуемая цель миграции -- Claude Sonnet 4.6. Что искать grep-ом в репозитории, прежде чем следующий зафиксированный выбор модели тихо сломается."
pubDate: 2026-05-10
tags:
  - "github-copilot"
  - "ai-agents"
  - "claude"
lang: "ru"
translationOf: "2026/05/copilot-deprecates-claude-sonnet-4-may-2026"
translatedBy: "claude"
translationDate: 2026-05-10
---

GitHub [убрал Claude Sonnet 4 со всех поверхностей Copilot 6 мая 2026 года](https://github.blog/changelog/2026-05-07-claude-sonnet-4-deprecated/). Не только из выбора модели в Chat. Прекращение поддержки охватывает Copilot Chat, inline-редактирование, режим ask, режим agent и автодополнение кода. Рекомендуемая цель миграции -- Claude Sonnet 4.6 (`claude-sonnet-4-6`).

Сам changelog состоит из двух коротких абзацев. Интересная часть -- это то, чего он не говорит.

## Что на самом деле охватывает анонс

Дословно: "We have deprecated the following model across all GitHub Copilot experiences (including Copilot Chat, inline edits, ask and agent modes, and code completions) on May 6, 2026."

Это полный список названных поверхностей. Copilot CLI не перечислен. Custom instructions не перечислены. Будут ли запросы, зафиксированные на `claude-sonnet-4`, автоматически перенаправлены на преемника или просто завершатся неудачей -- не указано. "Please update your workflows and integrations to use supported models" -- единственное предложенное руководство по миграции.

Если у вас Sonnet 4 запущен где-либо, где его можно было выбрать, считайте его убранным и планируйте соответственно. Не предполагайте, что автоматическое перенаправление работает.

## Где Sonnet 4 прячется в типичном репозитории

Селектор модели в IDE выбирает одно место. Зафиксированная модель в конфигурации вашего репозитория выбирает другое, и именно она тихо перестаёт работать. Три места, по которым стоит пройти grep-ом, прежде чем вы отправите следующее изменение:

```bash
# 1. VS Code workspace and user settings
grep -R "claude-sonnet-4" .vscode/ "$HOME/.config/Code/User/settings.json" 2>/dev/null

# 2. Copilot custom agent / skill manifests
grep -R "claude-sonnet-4" .github/copilot/ .github/agents/ 2>/dev/null

# 3. Workflow files that invoke Copilot CLI or the Copilot agent
grep -R "claude-sonnet-4" .github/workflows/
```

Искать нужно буквальный идентификатор модели `claude-sonnet-4`. Не `claude-sonnet-4-5` и не `claude-sonnet-4-6`, оба по-прежнему поддерживаются. Поиск-и-замена с границей слова -- безопасный ход:

```bash
# Replace only the bare id, leave 4-5 and 4-6 alone
git ls-files | xargs sed -i 's/\bclaude-sonnet-4\b/claude-sonnet-4-6/g'
```

В файле скилла Copilot-агента или custom instruction изменение обычно выглядит так:

```yaml
# .github/copilot/agents/review.yml
- name: code-review
-   model: claude-sonnet-4
+   model: claude-sonnet-4-6
    instructions: |
      Review the diff against the project conventions.
```

## Почему Sonnet 4.6 -- правильное значение по умолчанию, а не Opus 4.7

Sonnet 4.6 -- то же семейство, схожий профиль задержек и заметно сильнее на бенчмарках длинного контекста и agent-loop, под которые был настроен Sonnet 4. Для ревью PR, inline-правок и циклов в режиме agent, где вы делаете много дешёвых вызовов, Sonnet 4.6 -- прямая замена. Прибегайте к [Claude Opus 4.7 только на работе, оправдывающей расходы](/ru/2026/05/how-to-run-claude-code-in-a-github-action-for-autonomous-pr-review/), вроде критичных по безопасности диффов или сложных рефакторингов.

Если вы поддерживаете развёртывание Copilot для команды, отправьте ссылку на анонс, выполните grep и обновите зафиксированную модель в том же PR. Тихие прекращения поддержки, которые "работают большую часть времени, потому что никто не зафиксировал id", -- это те, что кусают вас во вторник утром, когда пайплайн одного инженера внезапно оказывается единственной красной сборкой.
