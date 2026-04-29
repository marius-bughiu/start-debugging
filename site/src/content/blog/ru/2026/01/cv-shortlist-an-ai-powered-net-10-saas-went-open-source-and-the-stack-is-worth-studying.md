---
title: "CV Shortlist: SaaS на .NET 10 с ИИ стал open-source, и стек стоит изучить"
description: "CV Shortlist - это open-source SaaS на .NET 10, который сочетает Azure Document Intelligence с моделью OpenAI. Стек, дисциплина конфигурации и граница интеграции с ИИ заслуживают изучения."
pubDate: 2026-01-18
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-10"
lang: "ru"
translationOf: "2026/01/cv-shortlist-an-ai-powered-net-10-saas-went-open-source-and-the-stack-is-worth-studying"
translatedBy: "claude"
translationDate: 2026-04-29
---
Пост по C#, который я сегодня сохранил в закладки, - это не "ещё одно демо-приложение". Это полноценный, мнение-имеющий SaaS, который был построен как коммерческий продукт, а затем выложен в open-source как образовательная справочная реализация: **CV Shortlist**.

Источник: [CV Shortlist repo](https://github.com/mihnea-radulescu/cvshortlist) и оригинальный [пост в r/csharp](https://www.reddit.com/r/csharp/comments/1qgbjo4/saas_educational_free_and_opensource_example_cv/).

## Полезная часть - граница интеграции, а не UI

Большинство примеров приложений с ИИ останавливаются на "вызвать LLM". Это - документирует реальную границу, от которой зависит судьба продакшен-функций:

-   **Azure Document Intelligence** извлекает структурированные данные из PDF-резюме (включая таблицы и многоколоночные макеты).
-   **OpenAI GPT-5** анализирует извлечённые данные, сопоставляет с вакансией и формирует шортлист.

Именно эту связку я продолжаю рекомендовать, когда команды спрашивают "как нам сделать RAG по документам?", не строя хрупкий OCR-пайплайн с нуля: используйте специализированный сервис извлечения, а потом рассуждайте по чистому тексту и полям.

## Современный стек .NET 10, перечисленный явно

README освежающе конкретен в отношении версий и инфраструктуры:

-   .NET 10, ASP.NET Core 10, Blazor 10, EF Core 10
-   Azure Web App, SQL Database, Blob Storage, Application Insights
-   Azure Document Intelligence и модель Azure AI Foundry (README упоминает Foundry-модель `gpt-5-mini`)
-   Self-hosted вариант, который по-прежнему зависит от двух ИИ-ресурсов

Даже если рекрутинговая область вас никогда не интересовала, это реальная справочная реализация для "сколько движущихся частей появляется, как только ИИ перестаёт быть игрушечной функцией".

## Дисциплина конфигурации: user secrets локально, переменные окружения в продакшене

Репозиторий выделяет две практики, которые я хочу видеть стандартом в каждой команде .NET 10:

-   Локальная отладка: хранить секреты в **user secrets**
-   Продакшен-развёртывания: использовать **переменные окружения**

Вот шаблон, который я ожидаю увидеть в `Program.cs` в проектах вроде этого:

```cs
var builder = WebApplication.CreateBuilder(args);

// Local debugging: dotnet user-secrets
if (builder.Environment.IsDevelopment())
{
    builder.Configuration.AddUserSecrets<Program>(optional: true);
}

builder.Services
    .AddOptions<AiSettings>()
    .Bind(builder.Configuration.GetSection("Ai"))
    .ValidateDataAnnotations()
    .ValidateOnStart();

var app = builder.Build();
app.Run();

public sealed class AiSettings
{
    public required string DocumentIntelligenceEndpoint { get; init; }
    public required string DocumentIntelligenceKey { get; init; }
    public required string FoundryModel { get; init; } // example: gpt-5-mini
}
```

Дело не в этих именно именах свойств. Дело в том, что границу с ИИ нужно трактовать как любую другую внешнюю зависимость в ASP.NET Core 10, а конфигурацию и валидацию делать скучными.

## Почему это важно (даже если вы никогда не делаете HR-софт)

Если вы пытаетесь выпускать ИИ-функции на .NET 10, вам нужны рабочие примеры, которые включают:

-   приём PDF, который не падает на реальных макетах
-   многошаговую обработку (извлечь, нормализовать, рассуждать, сохранить)
-   облачные ресурсы с ключами, ротацией, телеметрией и контролем затрат

CV Shortlist - это компактная справочная реализация "вот как это выглядит, когда вы действительно её строите". Прочтите README, пробегите по `Program.cs` и украдите дизайн границы для своей собственной области.
