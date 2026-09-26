---
title: "Microsoft.Extensions.AI.OpenAI 10.10.1 исправляет TypeLoadException с OpenAI 2.14"
description: "OpenAI 2.14.0 переименовал GlobalMcpToolCallApprovalPolicy, и из-за этого сломался каждый вызов Responses API с инструментами через Microsoft.Extensions.AI.OpenAI 10.10.0. Версия 10.10.1 переходит на OpenAI 2.14.0 и заодно получает исправление null-статуса reasoning для OpenAI-совместимых эндпоинтов."
pubDate: 2026-09-26
tags:
  - "dotnet"
  - "ai"
  - "microsoft-extensions-ai"
  - "openai"
  - "csharp"
lang: "ru"
translationOf: "2026/09/microsoft-extensions-ai-10-10-1-fixes-openai-2-14-typeloadexception"
translatedBy: "claude"
translationDate: 2026-09-26
---

`Microsoft.Extensions.AI.OpenAI` 10.10.1 появился в NuGet 25 сентября 2026 года, и [заметки о выпуске](https://github.com/dotnet/extensions/releases/tag/v10.10.1) состоят из одной строки: "Upgrade OpenAI SDK to 2.14.0". За этой строкой скрывается падение во время выполнения. Если ваше приложение ссылается на `Microsoft.Extensions.AI.OpenAI` 10.10.0, а что-то в графе зависимостей подняло `OpenAI` до 2.14.0 (бамп от Dependabot, прямая ссылка, другой пакет), то с 15 сентября каждый вызов Responses API с инструментом падает с `TypeLoadException`.

## Переименованный экспериментальный тип, который разрешается при JIT-компиляции

`OpenAI` 2.14.0 вышел 15 сентября. Среди изменений экспериментальная структура `OpenAI.Responses.GlobalMcpToolCallApprovalPolicy` стала `DefaultMcpToolCallApprovalPolicy`, а свойство `GlobalPolicy` у `McpToolCallApprovalPolicy` стало `DefaultPolicy`. Экспериментальным API (`OPENAI001`) ломаться разрешено, но `Microsoft.Extensions.AI.OpenAI` 10.10.0 был скомпилирован со старым именем внутри `OpenAIResponsesChatClient.ToResponseTool`, метода, который превращает каждый `AITool` в инструмент Responses.

nuspec версии 10.10.0 объявляет `OpenAI` с минимальной версией `2.13.0`, поэтому NuGet спокойно разрешает 2.14.0, если её запрашивает кто-то другой. Сборка проходит без ошибок. Первый вызов с инструментами в `ChatOptions` падает, когда JIT компилирует `ToResponseTool`:

```text
System.TypeLoadException: Could not load type 'OpenAI.Responses.GlobalMcpToolCallApprovalPolicy'
from assembly 'OpenAI, Version=2.14.0.0, Culture=neutral, PublicKeyToken=b4187f3e65366280'.
   at Microsoft.Extensions.AI.OpenAIResponsesChatClient.ToResponseTool(AITool tool, ChatOptions options, ToolSearchLookup toolSearchLookup)
   at Microsoft.Extensions.AI.OpenAIResponsesChatClient.AsCreateResponseOptions(...)
   at Microsoft.Extensions.AI.OpenAIResponsesChatClient.GetStreamingResponseAsync(...)
```

Используете ли вы MCP, неважно. Метод ссылается на тип, поэтому ошибку вызывает и обычная `AIFunction`. В [issue #7760](https://github.com/dotnet/extensions/issues/7760) проблема описана для `Microsoft.Agents.AI.OpenAI` 1.21.0 на .NET 10.

## Почему остаться на OpenAI 2.13.0 было не лучшим обходным путём

Если закрепить `OpenAI` на 2.13.0, падения не будет, но у 2.13.0 есть свой баг: десериализация `ReasoningResponseItem` вызывает `ToReasoningStatus()` для JSON-значения `null`. Сторонние OpenAI-совместимые бэкенды, которые сериализуют элемент reasoning как `"status": null` вместо того, чтобы опустить поле, обрывают весь SSE-поток с `ArgumentOutOfRangeException: Unknown ReasoningStatus value`. В OpenAI 2.14.0 появилась проверка на null. Так что целую неделю приходилось выбирать, с каким из багов жить.

[PR #7761](https://github.com/dotnet/extensions/pull/7761) решает обе проблемы: поднимает `OpenAI` до 2.14.0, сопоставляет `HostedMcpServerToolAlwaysRequireApprovalMode` и `HostedMcpServerToolNeverRequireApprovalMode` с `DefaultMcpToolCallApprovalPolicy` и добавляет регрессионный тест стриминга для случая `status` null.

## Обновление

Обновляйте оба пакета вместе. `Microsoft.Extensions.AI.OpenAI` 10.10.1 теперь требует `OpenAI` 2.14.0, поэтому если вы закрепили 2.13.0 в качестве обходного пути, уберите это закрепление, иначе получите ошибку понижения версии `NU1605`:

```xml
<ItemGroup>
  <PackageReference Include="Microsoft.Extensions.AI.OpenAI" Version="10.10.1" />
  <PackageReference Include="OpenAI" Version="2.14.0" />
</ItemGroup>
```

Затем проверьте, что реально разрешилось, ведь фреймворки агентов и обёртки над SDK часто подтягивают эти пакеты транзитивно:

```bash
dotnet list package --include-transitive | grep -E "OpenAI|Extensions.AI"
```

Если ваш собственный код напрямую использует типы подтверждения MCP, переименование касается и вас:

```csharp
#pragma warning disable OPENAI001
var policy = new McpToolCallApprovalPolicy(DefaultMcpToolCallApprovalPolicy.NeverRequireApproval);
var mode = policy.DefaultPolicy; // was policy.GlobalPolicy in OpenAI 2.13.0
#pragma warning restore OPENAI001
```

Общий вывод: зависимость библиотеки с минимальной версией от пакета с экспериментальными API на практике открыта для ломающих изменений. Если в продакшене работает агент на базе Responses, smoke-тест, отправляющий один запрос с инструментом после каждого обновления зависимостей, поймал бы это в CI, а не во время выполнения. Об остальных изменениях в этой линейке выпусков читайте в предыдущей статье о том, как [Microsoft.Extensions.AI 10.10 проваливает метрики оценки без оценки](/ru/2026/09/microsoft-extensions-ai-10-10-fails-closed-on-unscored-evaluation-metrics/).
