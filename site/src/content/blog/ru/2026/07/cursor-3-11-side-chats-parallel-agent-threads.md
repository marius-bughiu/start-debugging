---
title: "Side-chaty v Cursor 3.11: otvetvit vopros, ne sbivaya s kursa osnovnogo agenta"
description: "Cursor 3.11 (10 iyulya 2026 goda) dobavlyaet side-chaty: postoyannye parallelnye tsepochki agenta, kotorye vy otkryvaete komandami /side ili /btw i vozvrashchaete v osnovnoy razgovor cherez upominanie. Plyus poisk po transkriptam cherez Cmd+K i novye khuki oblachnykh agentov."
pubDate: 2026-07-12
tags:
  - "cursor"
  - "ai-agents"
  - "llm"
  - "productivity"
lang: "ru"
translationOf: "2026/07/cursor-3-11-side-chats-parallel-agent-threads"
translatedBy: "claude"
translationDate: 2026-07-12
---

Cursor 3.11 вышел 10 июля 2026 года, и его главная функция решает конкретное неудобство: вы глубоко погружены в задачу агента, вам приходит в голову отступление ("постойте, а этот репозиторий вообще где-нибудь использует `IAsyncEnumerable`?"), и этот вопрос сбивает цепочку, которую вы выстраивали. Side-чаты дают вам место, чтобы задать такой вопрос, не трогая основной разговор.

## Side-чат: это полноценный агент, а не черновик

Важная деталь в том, что side-чат не является легковесным всплывающим окном. Это полноценный и постоянный разговор с агентом, который идёт рядом с вашим основным чатом. Вы можете продолжить его, закрыть и вернуться к нему позже, и он всё это время хранит собственный контекст. Это отличает его от очистки промпта и повторного набора: отступление становится собственной постоянной цепочкой, к которой можно вернуться.

Открыть его можно тремя способами: командой `/side`, сокращением `/btw` или кнопкой с плюсом вверху панели чата.

```text
# In the middle of a refactor, spin off a question without losing your place:
/btw where do we register the JWT bearer handler?

# Or explicitly:
/side compare our current retry policy to Polly's default
```

Side-чаты склоняются к чтению, поиску и ответам, пока ваш основной агент сохраняет собственное состояние нетронутым. Основная задача не теряет свой план из-за того, что вы отправились искать ответ.

## Возврат ответа через упоминание

То, что делает это чем-то большим, чем вторая вкладка, это путь назад. Как только side-чат что-то выяснил, вы упоминаете его через @ из основной цепочки, чтобы вернуть этот контекст обратно:

```text
# Back in the main chat, fold the side chat's findings into the real work:
@side-chat: retry-policy apply that Polly comparison to OrderService
```

Итак, рабочий процесс такой: ответвиться, исследовать в изоляции, а затем привить вывод обратно в основного агента, ничего не объясняя заново. Изоляция сохраняет основной контекст чистым, пока вы исследуете; упоминание означает, что исследование не пропало зря.

## Остальное в 3.11

Стоит знать ещё о двух изменениях. Поиск по разговорам теперь работает на локальном индексе: `Cmd+K` ищет по тысячам прошлых транскриптов агента, а `Cmd+F` перемещается между совпадениями внутри одного разговора. Средства выбора репозитория и проекта переработаны, чтобы ограничивать область по расположению (This Computer, Cloud, Remote Machines) и позволять создать проект или подключить GitHub/GitLab, не покидая окно выбора.

Для тех, кто программирует поведение агента, в 3.11 также появляются хуки облачных агентов, такие как `beforeSubmitPrompt` и `afterAgentResponse`, которые позволяют наблюдать и контролировать рассуждения агента и поведение его субагентов:

```json
{
  "hooks": {
    "beforeSubmitPrompt": "./scripts/inject-guardrails.sh",
    "afterAgentResponse": "./scripts/lint-agent-output.sh"
  }
}
```

Если вы уже запускаете параллельных workers, side-чаты находятся на уровень ниже: это не ещё один агент, выполняющий работу, а место, где можно размышлять вслух так, чтобы основной агент не слышал этого, пока вы не решите, что должен. О том, как более тяжёлая история с несколькими workers сравнивается между инструментами, читайте в [Субагенты Cursor против субагентов Claude Code](/2026/07/cursor-subagents-vs-claude-code-subagents/). Полные заметки в [changelog Cursor](https://cursor.com/changelog).
