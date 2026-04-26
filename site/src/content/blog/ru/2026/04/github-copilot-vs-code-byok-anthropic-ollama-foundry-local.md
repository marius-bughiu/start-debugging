---
title: "BYOK в GitHub Copilot Chat вышел в GA в VS Code: Anthropic, Ollama, Foundry Local"
description: "GitHub Copilot для VS Code выпустил Bring Your Own Key 22 апреля 2026 года. Подключите свою учётную запись Anthropic, OpenAI, Gemini, OpenRouter или Azure к Chat либо укажите локальную модель через Ollama или Foundry Local. Биллинг минует квоту Copilot и идёт напрямую к провайдеру."
pubDate: 2026-04-26
tags:
  - "github-copilot"
  - "vscode"
  - "ai-agents"
  - "ollama"
lang: "ru"
translationOf: "2026/04/github-copilot-vs-code-byok-anthropic-ollama-foundry-local"
translatedBy: "claude"
translationDate: 2026-04-26
---

[GitHub выпустил BYOK в GA для Copilot Chat в VS Code 22 апреля 2026 года](https://github.blog/changelog/2026-04-22-bring-your-own-language-model-key-in-vs-code-now-available/). Кратко: теперь вы можете подключить свой ключ Anthropic, OpenAI, Gemini, OpenRouter или Azure к интерфейсу Copilot Chat и переложить оплату запросов на провайдера, не расходуя квоту Copilot. Локальные модели тоже работают, через Ollama или Foundry Local. Возможность доступна в GA для Copilot Business и Enterprise и охватывает Chat, plan agents и custom agents, но не inline completions.

## Почему это меняет арифметику цены Copilot

До этого релиза Copilot Chat работал на пуле моделей, размещённом Microsoft, и каждый запрос списывался из месячного лимита вашего seat. Это делало неудобной разведочную работу с агентами на дешёвых быстрых моделях и использование frontier-модели, контракт на которую у организации уже есть. С BYOK существующий счёт организации в Anthropic или Azure OpenAI поглощает стоимость, а seat Copilot остаётся для того, что он умеет лучше всего: code completions, которые по-прежнему работают на моделях GitHub. Из release notes: "BYOK does not apply to code completions" и "usage doesn't consume GitHub Copilot quota allocations."

Второе важное послабление - локальное. До сих пор запуск Copilot Chat против изолированного Ollama или против Foundry Local на ноутбуке разработчика был исследовательским проектом. Теперь эта возможность встроена.

## Подключение провайдера

Откройте панель Chat, нажмите на селектор модели и выполните **Manage Models** (или вызовите `Chat: Manage Language Models` из Command Palette). VS Code откроет редактор Language Models, в котором вы выбираете провайдера, вставляете ключ и выбираете модель. Модели сразу появляются в селекторе чата.

Для OpenAI-совместимых endpoint, которых нет в встроенном списке (LiteLLM-шлюзы, on-prem inference-прокси или развертывания Azure OpenAI за кастомным URL), эквивалентная запись в `settings.json` выглядит так:

```jsonc
{
  "github.copilot.chat.customOAIModels": {
    "claude-sonnet-4-6-via-litellm": {
      "name": "claude-sonnet-4-6",
      "url": "https://gateway.internal/v1/chat/completions",
      "toolCalling": true,
      "vision": false,
      "thinking": false,
      "maxInputTokens": 200000,
      "maxOutputTokens": 16384
    }
  },
  "inlineChat.defaultModel": "claude-sonnet-4-6-via-litellm"
}
```

Ключ по-прежнему хранится в защищённом хранилище, а не в `settings.json`. Настройка лишь описывает форму модели, чтобы VS Code знал, какие возможности включить в селекторе (tool calling, vision, extended thinking).

Для Ollama укажите провайдеру `http://localhost:11434` и тег вроде `qwen2.5-coder:14b` или `phi-4:14b`. У Foundry Local OpenAI-совместимый endpoint по умолчанию -- `http://localhost:5273/v1`, как только `foundry service start` запущен.

## Что это значит для инструментов .NET-команд

Два практических следствия для команд, уже стандартизировавших Copilot:

1. Настройка `github.copilot.chat.customOAIModels` находится в пользовательском `settings.json`, но это обычная настройка VS Code: её можно положить в шаблон `.vscode/settings.json` в репозитории или в образ [Dev Container](https://code.visualstudio.com/docs/devcontainers/containers). Это значит, что `dotnet new` template может заранее подключить модель по умолчанию для всей команды.
2. Администраторы организации могут отключить BYOK в Copilot policy settings на github.com, если требования compliance предписывают, чтобы весь трафик оставался на моделях GitHub. Если для регулируемых нагрузок это нужно отключить, сделайте это до того, как rollout дойдёт до ваших seats; в Business- и Enterprise-тенантах политика по умолчанию активируется автоматически.

Если вы откладывали знакомство с [Copilot agent skills в Visual Studio 2026](/ru/2026/04/visual-studio-2026-copilot-agent-skills/), не желая привязывать всю команду к биллингу GitHub, теперь это снято. Та же агентская поверхность, ваш счёт, ваша модель.
