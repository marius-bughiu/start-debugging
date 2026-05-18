---
title: "GPT-5.3-Codex становится базовой моделью Copilot Business и Enterprise"
description: "17 мая 2026 года GitHub переключил модель Copilot по умолчанию на тарифах Business и Enterprise с GPT-4.1 на GPT-5.3-Codex. GPT-4.1 остаётся бесплатной до 1 июня, затем переходит на тарификацию по использованию. Что меняется для зафиксированных моделей в репозитории и CI."
pubDate: 2026-05-18
tags:
  - "github-copilot"
  - "ai-agents"
  - "openai"
lang: "ru"
translationOf: "2026/05/copilot-business-gpt-5-3-codex-base-model"
translatedBy: "claude"
translationDate: 2026-05-18
---

GitHub начал [выкатывать GPT-5.3-Codex в качестве новой базовой модели для тарифов Copilot Business и Enterprise 17 мая 2026 года](https://github.blog/changelog/2026-05-17-gpt-5-3-codex-is-now-the-base-model-for-copilot-business-and-enterprise/). Она заменяет GPT-4.1 в качестве модели по умолчанию для всего уровня тарифа и является первой моделью с долгосрочной поддержкой (LTS) от GitHub и OpenAI в Copilot: окно LTS гарантирует, что модель останется выбираемой до 2027-02-04.

Индивидуальные подписки (Copilot Pro, Pro+, Free) изменения не затрагивают. Переключение касается только умолчания для Business и Enterprise.

## Что на самом деле задаёт "базовая модель"

Базовая модель -- это та, которую Copilot использует, когда запрос не закрепляет конкретную модель. Везде, где вы прописали `model: gpt-4.1` в конфигурации Copilot, пока ничего не меняется. Везде, где выбор оставлен за Copilot, ответ только что сместился с GPT-4.1 на GPT-5.3-Codex.

У GPT-5.3-Codex множитель premium request равен 1x, как и у GPT-4.1, поэтому стоимость одного запроса в SKU Business и Enterprise при этой замене не сдвигается. Inline-дополнения, Chat без закреплённой модели и режим `auto` cloud-агента переключаются одновременно.

## Что меняется для репозиториев, закрепивших старое умолчание

Два места, которые нужно проверить до 2026-06-01. После этой даты запросы, всё ещё закреплённые за `gpt-4.1`, начнут тарифицироваться по счётчику использования вместо того, чтобы быть включёнными в подписку.

```bash
# 1. Workflow files that pin a Copilot model
grep -RE "model:\s*gpt-4\.1" .github/ 2>/dev/null

# 2. Copilot agent and Chat custom instructions
grep -R "gpt-4.1" .copilot/ .github/copilot-instructions.md 2>/dev/null
```

Если CI проекта запускает Copilot CLI или задачи cloud-агента против закреплённого GPT-4.1, есть два варианта: поднять pin до `gpt-5.3-codex` либо принять отдельную строку в счёте с 1 июня. YAML-pin под новое умолчание выглядит точно так же:

```yaml
# .github/workflows/copilot-review.yml
- uses: github/copilot-action@v1
  with:
    model: gpt-5.3-codex
    effort: high
```

## Почему GitHub выбрал вариант Codex для слота LTS

GPT-5.3-Codex -- это код-тюнингованный родственник в семействе GPT-5.3. В качестве заявленной метрики в посте о выкатке GitHub упомянул code survival rate, долю принятых подсказок, которые остаются в файле после последующих правок и merge-PR. В changelog сообщается о существенно более высокой ставке у клиентов Business и Enterprise в когорте выкатки по сравнению с GPT-4.1, и это обоснование для назначения её LTS-базой вместо универсальной GPT-5.3.

Сама LTS-метка важнее, чем смена модели. GitHub устаревает модели на скользящей основе и с коротким предупреждением. [Claude Sonnet 4 был удалён со всех поверхностей Copilot одиннадцатью днями ранее](/ru/2026/05/copilot-deprecates-claude-sonnet-4-may-2026/) с changelog из двух абзацев и без окна миграции. LTS-обязательство по Codex -- это первая гарантированная по дате доступность модели Copilot от GitHub, и для остальных моделей такой гарантии нет.

Доступ к GPT-4.1 продолжается без доплаты до 2026-06-01. После этой даты счётчик запускается.
