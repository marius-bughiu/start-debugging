---
title: "Debugger Agent в Visual Studio 18.5 превращает Copilot в живого напарника по охоте на баги"
description: "Visual Studio 18.5 GA поставляет гайдед workflow Debugger Agent в Copilot Chat, который формирует гипотезу, ставит breakpoints, едет вместе через repro, валидирует против runtime state и предлагает fix."
pubDate: 2026-04-21
tags:
  - "visual-studio"
  - "debugging"
  - "copilot"
  - "github-copilot"
  - "ai-agents"
  - "dotnet"
lang: "ru"
translationOf: "2026/04/visual-studio-18-5-debugger-agent-workflow"
translatedBy: "claude"
translationDate: 2026-04-24
---

Команда Visual Studio выпустила [новый Debugger Agent workflow](https://devblogs.microsoft.com/visualstudio/stop-hunting-bugs-meet-the-new-visual-studio-debugger-agent/) в Visual Studio 18.5 GA 15 апреля 2026 года. Если вы провели последний год, спрашивая Copilot "почему это null" и получая уверенную догадку, противоречащую реальному call stack, этот релиз - исправление. Agent больше не чат-бот, читающий ваши исходники. Он ведёт интерактивную debug-сессию, ставит собственные breakpoints и рассуждает против живого runtime state.

## Статического анализа было недостаточно

Предыдущие итерации [Debug with Copilot](https://devblogs.microsoft.com/visualstudio/visual-studio-2026-debugging-with-copilot/) были полезны для помощи с exceptions и промптами в стиле "объясни этот stack frame", но работали на замороженном snapshot вашего кода. Когда настоящая ошибка жила в race между двумя async continuations или в состоянии, существовавшем только после пятнадцатого клика, статическое чтение `MyService.cs` просто не могло её увидеть. VS 18.5 закрывает этот разрыв, позволяя agent участвовать в реальном repro.

## Цикл из четырёх фаз

Как только ваш solution открыт, вы переключаете Copilot Chat в режим Debugger и передаёте ему описание бага. Workflow затем проходит четыре фазы по порядку:

1. **Гипотеза и подготовка.** Agent анализирует описание плюс код и предлагает теорию root cause. Затем ставит "intelligent breakpoints" на подозрительные пути и предлагает запустить проект за вас. Если ваш startup необычный, можно запустить вручную и дать ему прикрепиться.
2. **Активное воспроизведение.** Agent остаётся на линии, пока вы кликаете через repro. Он смотрит runtime state при каждом срабатывании breakpoint, а не перечитывает файл.
3. **Валидация в реальном времени.** На каждой остановке он оценивает locals и call stack, чтобы подтвердить или отбросить гипотезу. Неправильные догадки отбрасываются по evidence, а не защищаются.
4. **Финальный fix.** Когда agent уверен, что нашёл причину, он предлагает изменение кода. Если вы одобряете, он применяет правку и перезапускает сессию, чтобы проверить, что баг ушёл.

Поддерживаемые сценарии в 18.5 GA drop - "exceptions, logic inconsistencies, and state corruption". Performance-регрессии и чисто concurrency-баги пока не в этом списке.

## Как выглядит сессия

Минимальное прохождение для классической null-ref выглядит так:

```text
You: The app throws NullReferenceException when saving a new invoice
     with no line items. Repro: open /invoices/new, click Save.

Agent: Hypothesis - Invoice.Total() dereferences LineItems before the
       collection is initialised for empty invoices.
       Setting breakpoints at InvoiceService.cs:42 and Invoice.cs:18.
       Launching IIS Express on https://localhost:7080 ...
```

Вы проходите repro. Breakpoint на `Invoice.cs:18` срабатывает, agent читает `this.LineItems` со stack frame, видит `null` вместо пустого списка и подтверждает гипотезу, не прося вас степать. Затем предлагает:

```csharp
public decimal Total() =>
    (LineItems ?? []).Sum(li => li.Quantity * li.UnitPrice);
```

Одобряете, и он перезапускает сценарий, чтобы подтвердить, что exception ушёл.

## Почему это важно

Интересный сдвиг здесь в том, что agent заземлён в runtime truth. Вы всё ещё можете его переубедить, игнорировать его breakpoints и дебажить вручную - это правильный default для всего security-sensitive или незнакомого кода. Но для длинного хвоста "у меня есть repro и stack trace, нужно побисектить state", цикл от баг-репорта до проверенного fix кардинально сокращается. Ожидайте, что больше времени отладки будет уходить на проверку evidence agent, чем на расстановку breakpoints вручную.

Фича сегодня в VS 18.5 GA. Если вы всё ещё на 17.x или раннем preview 18.x, у вас старый чат-стиль Debug with Copilot. Гайдед workflow требует 18.5.
