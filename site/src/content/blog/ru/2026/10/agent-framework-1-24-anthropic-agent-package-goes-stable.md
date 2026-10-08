---
title: "Agent Framework 1.24: пакет Anthropic Agent стал стабильным, кроме бета-сервисов"
description: "Microsoft.Agents.AI.Anthropic 1.24.0 теряет суффикс preview и зависит от Anthropic 12.53.0. Агенты, созданные из IAnthropicClient, теперь входят в стабильный API, а расширения client.Beta помечены как экспериментальные под MAAIANTHROPIC001, который не срабатывает при вызове через синтаксис методов расширения."
pubDate: 2026-10-08
tags:
  - "agent-framework"
  - "dotnet"
  - "anthropic"
  - "ai-agents"
lang: "ru"
translationOf: "2026/10/agent-framework-1-24-anthropic-agent-package-goes-stable"
translatedBy: "claude"
translationDate: 2026-10-08
---

Microsoft Agent Framework [dotnet-1.24.0](https://github.com/microsoft/agent-framework/releases/tag/dotnet-1.24.0) вышел 7 октября 2026 года, и если вы запускаете в .NET агентов на базе Claude, одна строка в списке изменений важнее остальных: [PR #9111](https://github.com/microsoft/agent-framework/pull/9111), "Stabilize Anthropic agent package". До прошлой недели `Microsoft.Agents.AI.Anthropic` существовал только в виде предварительных сборок (последней была `1.23.0-preview.260928.1`). В NuGet теперь лежит обычная версия `1.24.0`, опубликованная вместе с остальным фреймворком.

## Что именно стало стабильным

В пакете два класса расширений, и обошлись с ними по-разному.

`AnthropicClientExtensions`, который добавляет `AsAIAgent` к `IAnthropicClient`, теперь является выпущенным публичным API. PR добавляет базовые файлы `PublicAPI.Shipped.txt` для каждой целевой платформы, под которую собирается пакет (`net10.0`, `net9.0`, `net8.0`, `netstandard2.0`, `net472`), так что проверка пакета теперь будет сообщать об изменениях, ломающих совместимость. Зависимость также обновилась с `Anthropic` 12.45.0 до 12.53.0, то есть до официального C# SDK от Anthropic, который сам уже GA.

`AnthropicBetaServiceExtensions`, то есть перегрузки `AsAIAgent` для `IBetaService` (то, что вы получаете из `client.Beta`), является исключением. Весь класс теперь помечен `[Experimental("MAAIANTHROPIC001")]` с пометкой в документации, что он "may change in non-major releases as the underlying beta services evolve". Логика в [issue #9110](https://github.com/microsoft/agent-framework/issues/9110) простая: Anthropic SDK это GA, а его бета-поверхность нет, и Agent Framework не хочет обещать контракт совместимости, которого нет у вышестоящей библиотеки.

## Что меняется в вашем коде

Если вы создаёте агентов из обычного клиента, меняется только версия пакета:

```xml
<PackageReference Include="Microsoft.Agents.AI.Anthropic" Version="1.24.0" />
```

```csharp
using Anthropic;
using Microsoft.Agents.AI;

AnthropicClient client = new() { ApiKey = Environment.GetEnvironmentVariable("ANTHROPIC_API_KEY") };

ChatClientAgent agent = client.AsAIAgent(
    model: "claude-sonnet-5-5",
    instructions: "You review C# pull requests and answer in short bullet points.",
    name: "reviewer");

Console.WriteLine(await agent.RunAsync("Is `async void` ever fine in an ASP.NET Core handler?"));
```

С бета-путём всё тоньше. Я проверил компиляцию на SDK 10.0.302 с пакетом 1.24.0. Во-первых, перегрузки находятся в пространстве имён `Anthropic.Services`, поэтому `client.Beta.AsAIAgent(...)` не разрешается, пока вы не добавите этот `using`. Во-вторых, атрибут стоит на классе, а не на методах, и C# сообщает о `[Experimental]` на уровне класса только тогда, когда имя типа встречается в вашем коде. Синтаксис метода расширения имя типа не называет, поэтому этот код компилируется чисто, без единой диагностики:

```csharp
using Anthropic.Services;

ChatClientAgent agent = client.Beta.AsAIAgent(
    model: "claude-sonnet-5-5",
    instructions: "You create PowerPoint presentations.",
    tools: [pptxSkill.AsAITool()]);
```

Если назвать класс напрямую, например при статическом вызове или при настройке общего бюджета токенов по умолчанию, вы получите ошибку, потому что диагностики `[Experimental]` по умолчанию являются ошибками:

```csharp
AnthropicBetaServiceExtensions.DefaultMaxTokens = 8000;
```

```text
error MAAIANTHROPIC001: 'Anthropic.Services.AnthropicBetaServiceExtensions' is for evaluation purposes only and is subject to change or removal in future updates. Suppress this diagnostic to proceed.
```

Собственный пример фреймворка со skills подавляет её в начале файла через `#pragma warning disable MAAIANTHROPIC001`. Если бета-возможности входят в ваш дизайн, а не являются экспериментом, подавите диагностику один раз для всего проекта:

```xml
<PropertyGroup>
  <NoWarn>$(NoWarn);MAAIANTHROPIC001</NoWarn>
</PropertyGroup>
```

## Почему такое разделение правильно

Закреплённый в продакшене предварительный пакет часто становится причиной, по которой Claude-агентов не делают на Agent Framework, а подключают `IChatClient` вручную (компромиссы разобраны в моём [сравнении Anthropic SDK и Microsoft.Extensions.AI](/2026/06/anthropic-sdk-vs-microsoft-extensions-ai-for-calling-claude-from-dotnet/)). Для стабильного пути этот довод больше не работает. Только не принимайте диагностику за аудит. Поскольку вызов через метод расширения её обходит, чистая сборка не означает, что вы вышли за пределы бета-поверхности: найдите через grep `client.Beta` и `IBetaService`, чтобы увидеть места вызова, которые могут сломаться при минорном обновлении Agent Framework или Anthropic SDK.

Остальное в 1.24.0 это укрепление безопасности: проверка возможностей `LocalCodeAct`, отклонение чувствительных идентификаторов в декларативных агентах и привязка заголовков подтверждения MCP к одобренному вызову. Если вы пропустили 1.23, перед обновлением начните с его [изменения function middleware](/ru/2026/10/agent-framework-1-23-function-middleware-can-now-swap-the-tool/).
