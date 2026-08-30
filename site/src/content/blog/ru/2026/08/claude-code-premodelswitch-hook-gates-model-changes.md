---
title: "PreModelSwitch: Claude Code теперь может наложить вето на смену модели"
description: "В Claude Code 2.1.251 появились события хуков PreModelSwitch и PostModelSwitch. Matcher срабатывает по каноническому имени модели, на которую вы переключаетесь, а код выхода 2 отменяет переключение."
pubDate: 2026-08-30
tags:
  - "claude-code"
  - "ai-agents"
  - "devops"
lang: "ru"
translationOf: "2026/08/claude-code-premodelswitch-hook-gates-model-changes"
translatedBy: "claude"
translationDate: 2026-08-30
---

Все события хуков, которые Claude Code выпускал до этой недели, охраняли то, что делает модель: `PreToolUse` видит команду Bash до её запуска, `PermissionRequest` видит запрос до того, как вы на него ответите, `PreCompact` видит транскрипт до того, как его свернут. Версия 2.1.251, вышедшая 2026-08-28, добавила первую пару, которая охраняет саму модель. `PreModelSwitch` и `PostModelSwitch` срабатывают, когда сессия меняет то, какие веса отвечают.

## Почему смена модели заслуживает контроля

Модель сессии это не предпочтение, а входные данные. Замените Opus на Haiku посреди рефакторинга, и следующий вызов инструмента будет спланирован другим рассуждающим механизмом поверх того же транскрипта. Командам это важно по трём отдельным причинам: стоимость (переключение `/model` вверх способно многократно увеличить счёт за оставшиеся ходы), воспроизводимость (баг-репорт со словами "Claude сделал X" невозможно проверить, если модель сменилась посреди сессии) и политики (некоторым организациям разрешено отправлять код только определённым моделям).

До 2.1.251 не было шва, в котором хоть что-то из этого можно было применить. Теперь он есть.

## Блокировка переключения

Зарегистрируйте хук в `settings.json`. Matcher здесь это не имя инструмента: он сопоставляется с каноническим именем модели, *на которую* переключается сессия:

```json
{
  "hooks": {
    "PreModelSwitch": [
      {
        "matcher": "claude-opus-5",
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/check-model-switch.sh",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

Matcher это регулярные выражения, поэтому и `claude-opus-4-6|claude-opus-5`, и `.*opus.*` сработают, если нужно поймать целое семейство, а не один ID.

Хук читает событие из stdin. `PreModelSwitch` и `PostModelSwitch` получают `from_model` и `to_model` вместо обычных полей инструмента, а также `session_id`, `prompt_id`, `transcript_path` и `cwd`:

```bash
#!/usr/bin/env bash
to_model=$(jq -r '.to_model')

if [ -n "$OPUS_BUDGET_EXHAUSTED" ]; then
  cat <<JSON
{
  "hookSpecificOutput": {
    "hookEventName": "PreModelSwitch",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Opus budget for this repo is spent. Staying on $to_model is blocked until the cycle resets."
  }
}
JSON
fi
exit 0
```

Выход с кодом 2 тоже блокирует переключение, это однострочный вариант, если выдавать JSON не хочется. Острый угол, о котором стоит знать: хук `PreModelSwitch`, отменённый по своему `timeout`, тоже блокирует переключение. Это событие отказывает в закрытом режиме, в отличие от большей части жизненного цикла.

## PostModelSwitch срабатывает и без вашего участия

`PostModelSwitch` это аудиторская половина, и она покрывает больше, чем ваши собственные вызовы `/model`. Согласно документации, оно выполняется "after the session's model changes, including changes Claude Code makes on its own, such as restoring the model when you resume a session". Именно этот случай делает вопрос "какая модель это написала" трудным для ответа задним числом, поэтому дописывание `from_model`, `to_model` и `session_id` в файл журнала здесь это самая дешёвая наблюдаемость, которую вы добавите за всю неделю.

В той же версии также исправлены запросы к Opus 5, падавшие с "effort is not supported when thinking is disabled" при effort xhigh или max, и закрыты [четыре разных способа обойти проверку разрешений](/ru/2026/08/claude-code-2-1-251-four-ways-around-the-permission-check/). Полные подробности в [справочнике по хукам](https://code.claude.com/docs/en/hooks).
