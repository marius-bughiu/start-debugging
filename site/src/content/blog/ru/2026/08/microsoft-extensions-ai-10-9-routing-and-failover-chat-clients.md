---
title: "В Microsoft.Extensions.AI 10.9 появились чат-клиенты с маршрутизацией и failover"
description: "Microsoft.Extensions.AI 10.9.0 добавляет RoutingChatClient, OrderedFailoverChatClient и SemanticRoutingChatClient. Проверено на реальном пакете: что переключается по failover, что нет и почему MEAI001 ломает сборку."
pubDate: 2026-08-14
tags:
  - "dotnet"
  - "ai"
  - "microsoft-extensions-ai"
  - "resilience"
  - "csharp"
lang: "ru"
translationOf: "2026/08/microsoft-extensions-ai-10-9-routing-and-failover-chat-clients"
translatedBy: "claude"
translationDate: 2026-08-14
---

2026-08-13 команда .NET опубликовала статью [Routing and Failover for Microsoft.Extensions.AI](https://devblogs.microsoft.com/dotnet/routing-and-failover-for-microsoft-extensions-ai/). Интереснее всего то, что эти типы уже лежат на NuGet в пакете `Microsoft.Extensions.AI` 10.9.0, так что взять их можно уже сегодня. До сих пор отправить запрос в дешёвую модель и откатиться на более крупную означало вручную писать обёртку `try`/`catch` вокруг `IChatClient`. Теперь для этого есть четыре типа: `RoutingChatClient` и `RoutingContext` в `Microsoft.Extensions.AI.Abstractions`, а также `FailoverChatClient`, `OrderedFailoverChatClient` и `SemanticRoutingChatClient` в `Microsoft.Extensions.AI`.

## Упорядоченный список клиентов теперь занимает две строки

`OrderedFailoverChatClient` перебирает список, пока один из клиентов не отработает успешно. Его конструктор выглядит так: `(IReadOnlyList<IChatClient> clients, bool leaveOpen = false)`, поэтому передавайте `leaveOpen: true`, когда внутренними клиентами владеет контейнер:

```csharp
using var failover = new OrderedFailoverChatClient(
    [primaryClient, backupClient, lastResortClient],
    leaveOpen: true);

ChatResponse response = await failover.GetResponseAsync(
    [new ChatMessage(ChatRole.User, "hi")]);
```

Если исключение бросают все клиенты, вы получите последнее, а не агрегированное. Это стоит знать до того, как писать блок `catch`, рассчитанный на `AggregateException`.

## Правило стриминга, на котором вы споткнётесь

При потоковых вызовах failover уже не бесплатен. Цикл повторных попыток выбирает нового клиента только до тех пор, пока вызывающей стороне ещё ничего не отдано. Чтобы это подтвердить, я прогнал три сценария на фиктивном клиенте:

- Основной клиент без стриминга бросает исключение: `SelectClientAsync` вызывается снова, отвечает резервный клиент, вызывающая сторона сбоя вообще не видит.
- Основной клиент со стримингом бросает исключение до первого `ChatResponseUpdate`: то же самое, чистое переключение на резервный.
- Основной клиент со стримингом бросает исключение после того, как уже отдал два обновления: исключение всплывает посреди перечисления, а два частичных фрагмента остаются потреблёнными.

Именно третий сценарий нужно закладывать в архитектуру. Как только `FailoverChatClientAttempt.OutputCommitted` становится `true`, восстановления посреди потока не будет, поэтому интерфейсу, который дописывает токены по мере поступления, нужна собственная обработка обрыва.

## Маршрутизация по стоимости или по смыслу

Для всего, что сложнее упорядоченного списка, `RoutingChatClient.Create` принимает колбэк:

```csharp
using var router = RoutingChatClient.Create((context, ct) =>
    new ValueTask<IChatClient>(
        context.Messages.Last().Text.Length > 20 ? powerfulClient : cheapClient));
```

`RoutingContext` предоставляет только `Messages` и `ChatOptions`, и этого достаточно, чтобы маршрутизировать по `AdditionalProperties` для закреплённых сессий. Наследуйтесь от `FailoverChatClient`, если нужен ещё и цикл повторов, и задайте `MaximumAttemptsPerRequest` (тип `int?`), чтобы его ограничить.

`SemanticRoutingChatClient` выбирает клиента по близости эмбеддингов. В полной сигнатуре параметров больше, чем показано в исходной статье:

```csharp
SemanticRoutingChatClient(
    IEmbeddingGenerator<string, Embedding<float>> embeddingGenerator,
    IReadOnlyDictionary<IChatClient, IReadOnlyList<string>> clientProfiles,
    IChatClient defaultClient,
    float scoreThreshold = 0.3f,
    int topK = 1,
    ScoreAggregation scoreAggregation = ScoreAggregation.Mean,
    bool leaveOpen = false)
```

`ScoreAggregation` принимает значения `Mean` или `Sum`, а всё, что ниже `scoreThreshold`, уходит в `defaultClient`.

## MEAI001 это ошибка, а не предупреждение

Все эти типы помечены атрибутом `[Experimental("MEAI001")]`, и компилятор по умолчанию считает его ошибкой:

```
error MEAI001: 'Microsoft.Extensions.AI.OrderedFailoverChatClient' is for evaluation
purposes only and is subject to change or removal in future updates.
```

Добавьте `<NoWarn>MEAI001</NoWarn>` в csproj, чтобы сознательно включить эти типы. Поскольку форма API ещё меняется, держите решение о маршрутизации за собственным интерфейсом. Если вы всё ещё работаете напрямую с SDK провайдера, то [переход на Microsoft.Extensions.AI](https://startdebugging.net/2026/07/migrate-from-openai-sdk-to-microsoft-extensions-ai/) это обязательный первый шаг.
