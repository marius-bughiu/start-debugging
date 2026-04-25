---
title: "Microsoft Agent Framework 1.0: создание ИИ-агентов на чистом C#"
description: "Microsoft Agent Framework достигает 1.0 со стабильными API, мульти-провайдерными коннекторами, мульти-агентной оркестрацией и совместимостью A2A/MCP. Вот как это выглядит на практике в .NET 10."
pubDate: 2026-04-07
tags:
  - "dotnet"
  - "dotnet-10"
  - "csharp"
  - "ai"
  - "microsoft-agent-framework"
lang: "ru"
translationOf: "2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp"
translatedBy: "claude"
translationDate: 2026-04-25
---

Microsoft выпустила [Agent Framework 1.0](https://devblogs.microsoft.com/agent-framework/microsoft-agent-framework-version-1-0/) 3 апреля 2026 года, как для .NET, так и для Python. Это релиз, готовый к продакшну: стабильные API, обязательство долгосрочной поддержки и чёткий путь обновления с превью, которое появилось ранее в этом году.

Agent Framework объединяет корпоративную сантехнику Semantic Kernel с шаблонами мульти-агентной оркестрации из AutoGen в единый фреймворк. Если вы отслеживали эти два проекта по отдельности, этот раскол окончен.

## Что поставляется в коробке

Релиз 1.0 покрывает пять областей, которые ранее требовали сшивания нескольких библиотек:

Первичные **сервисные коннекторы** для Azure OpenAI, OpenAI, Anthropic Claude, Amazon Bedrock, Google Gemini и Ollama. Смена провайдеров -- это однострочное изменение, потому что каждый коннектор реализует `IChatClient` из `Microsoft.Extensions.AI`.

Шаблоны **мульти-агентной оркестрации**, перенесённые из Microsoft Research и AutoGen: последовательный, параллельный, handoff, group chat и Magentic-One. Это не игрушечные демки, а те же шаблоны, которые команда AutoGen валидировала в исследовательских окружениях.

**Поддержка MCP** позволяет агентам обнаруживать и вызывать инструменты, предоставляемые любым сервером Model Context Protocol. Поддержка протокола **A2A (Agent-to-Agent)** идёт дальше, позволяя агентам, работающим в разных фреймворках или средах выполнения, координироваться через структурированный обмен сообщениями.

Конвейер **middleware** для перехвата и преобразования поведения агента на каждом этапе выполнения, плюс подключаемые **поставщики памяти** для истории разговоров, состояния "ключ-значение" и векторного извлечения.

## Минимальный агент в пять строк

Самый быстрый путь от нуля до работающего агента:

```csharp
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;
using OpenAI;

AIAgent agent = new OpenAIClient("your-api-key")
    .GetChatClient("gpt-4o-mini")
    .AsIChatClient()
    .CreateAIAgent(
        instructions: "You are a senior .NET architect. Be concise and production-focused.");

var response = await agent.RunAsync("Design a retry policy for transient SQL failures.");
Console.WriteLine(response);
```

`AsIChatClient()` мостит клиента OpenAI к абстракции `IChatClient`. `CreateAIAgent()` оборачивает его контекстом инструкций, регистрацией инструментов и потоком разговора. Замените `OpenAIClient` любым другим поддерживаемым коннектором, и остальная часть кода останется идентичной.

## Добавление инструментов

Агенты становятся полезными, когда могут вызывать ваш код. Регистрируйте инструменты с помощью `AIFunctionFactory`:

```csharp
using Microsoft.Agents.AI;

var tools = new[]
{
    AIFunctionFactory.Create((string query) =>
    {
        // search your internal docs, database, etc.
        return $"Results for: {query}";
    }, "search_docs", "Search internal documentation")
};

AIAgent agent = chatClient.CreateAIAgent(
    instructions: "Use search_docs to answer questions from internal docs.",
    tools: tools);
```

Фреймворк обрабатывает обнаружение инструментов, генерацию схемы и вызов автоматически. Инструменты, предоставляемые через MCP, работают так же -- агент разрешает их во время выполнения с любого MCP-совместимого сервера.

## Почему это важно сейчас

До 1.0 создание .NET-агента означало выбор между Semantic Kernel (хорошая корпоративная интеграция, ограниченная оркестрация) или AutoGen (мощные мульти-агентные шаблоны, более грубая .NET-история). Agent Framework устраняет этот выбор. Один пакет, одна модель программирования, готов к продакшну.

Пакеты NuGet -- `Microsoft.Agents.AI` для ядра и `Microsoft.Agents.AI.OpenAI` (или специфичный для провайдера вариант) для коннекторов. Установка:

```bash
dotnet add package Microsoft.Agents.AI.OpenAI
```

Полная документация и примеры на [GitHub](https://github.com/microsoft/agent-framework) и [Microsoft Learn](https://learn.microsoft.com/en-us/agent-framework/overview/).
