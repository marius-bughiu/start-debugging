---
title: "Generative AI for Beginners .NET v2: перестроен для .NET 10 с Microsoft.Extensions.AI"
description: "Бесплатный курс по генеративному ИИ для .NET-разработчиков от Microsoft выпускает Версию 2, перестроенную для .NET 10 и мигрированную с Semantic Kernel на шаблон IChatClient из Microsoft.Extensions.AI."
pubDate: 2026-03-29
tags:
  - "dotnet"
  - "dotnet-10"
  - "ai"
  - "ai-agents"
  - "llm"
  - "microsoft-extensions-ai"
  - "generative-ai"
lang: "ru"
translationOf: "2026/03/generative-ai-beginners-dotnet-v2-dotnet10-meai"
translatedBy: "claude"
translationDate: 2026-04-25
---

Microsoft обновила [Generative AI for Beginners .NET](https://aka.ms/genainet) до Версии 2. Курс бесплатный, открытый, и теперь полностью перестроен для .NET 10 со значительным архитектурным изменением: Semantic Kernel убран как основная абстракция, заменён [Microsoft.Extensions.AI](https://learn.microsoft.com/en-us/dotnet/ai/microsoft-extensions-ai) (MEAI).

## Переход на Microsoft.Extensions.AI

Версия 1 опиралась на Semantic Kernel для оркестрации и доступа к моделям. Версия 2 стандартизируется на интерфейсе `IChatClient` из MEAI, который поставляется как часть .NET 10 и следует тем же соглашениям внедрения зависимостей, что и `ILogger`.

Шаблон регистрации будет знаком любому .NET-разработчику:

```csharp
var builder = Host.CreateApplicationBuilder();

// Register any IChatClient-compatible provider
builder.Services.AddChatClient(new OllamaChatClient("phi4"));

var app = builder.Build();
var client = app.Services.GetRequiredService<IChatClient>();

var response = await client.GetStreamingResponseAsync("What is AOT compilation?");
await foreach (var update in response)
    Console.Write(update.Text);
```

Интерфейс не зависит от провайдера. Замена `OllamaChatClient` на реализацию Azure OpenAI требует изменения единственной строки. Курс использует это намеренно -- навыки переносятся между провайдерами, а не запирают вас в SDK одного вендора.

## Что покрывают пять уроков

Реструктурированная программа проходит в пяти самодостаточных уроках:

1. **Основы** -- механика LLM, токены, окна контекста, и как .NET 10 интегрируется с API моделей
2. **Основные техники** -- chat completions, prompt engineering, function calling, структурированные выводы, и основы RAG
3. **Шаблоны ИИ** -- семантический поиск, генерация, дополненная извлечением, конвейеры обработки документов
4. **Агенты** -- использование инструментов, мульти-агентная оркестрация, и интеграция Model Context Protocol (MCP) с использованием встроенной поддержки MCP-клиента в .NET 10
5. **Ответственный ИИ** -- обнаружение смещений, API безопасности контента, и руководства по прозрачности

Урок об агентах особенно актуален, если вы следили за поддержкой MCP в .NET 10. Курс соединяет мульти-агентную оркестрацию напрямую с этой функциональностью с использованием MCP-клиента из `Microsoft.Extensions.AI.Abstractions`, поэтому можно запускать примеры против локальных или удалённых MCP-серверов без гимнастики с фреймворком.

## Миграция с Версии 1

Одиннадцать примеров Semantic Kernel из Версии 1 перенесены в устаревшую папку внутри репозитория -- они всё ещё работают, но больше не представлены как рекомендуемый шаблон. Если вы прошли Версию 1, ключевые концепции остаются теми же. Миграция в основном -- это замена на уровне API: замените `Kernel` и `IKernelBuilder` из Semantic Kernel на `IChatClient` и стандартные расширения `IServiceCollection`.

Репозиторий курса по адресу [github.com/microsoft/generative-ai-for-beginners-dotnet](https://github.com/microsoft/generative-ai-for-beginners-dotnet). Сам курс начинается по адресу [aka.ms/genainet](https://aka.ms/genainet).
