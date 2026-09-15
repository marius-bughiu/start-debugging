---
title: "Microsoft.Extensions.AI 10.10 проваливает метрики оценки, которым судья не выставил балл"
description: "Microsoft.Extensions.AI.Evaluation.Quality 10.10.0 теперь помечает нераспознанные и выходящие за диапазон оценки качества как проваленные, а Microsoft.Extensions.AI.OpenAI 10.10.0 удаляет адаптер Assistants. Измерено до и после на 10.9.0."
pubDate: 2026-09-15
tags:
  - "dotnet"
  - "ai"
  - "microsoft-extensions-ai"
  - "testing"
  - "csharp"
lang: "ru"
translationOf: "2026/09/microsoft-extensions-ai-10-10-fails-closed-on-unscored-evaluation-metrics"
translatedBy: "claude"
translationDate: 2026-09-15
---

[Примечания к выпуску v10.10.0](https://github.com/dotnet/extensions/releases/tag/v10.10.0) репозитория `dotnet/extensions` вышли 14 сентября 2026 года (сами пакеты появились в NuGet 9 сентября). Большая часть изменений касается внутренней инфраструктуры, но два из них могут повлиять на поведение вашей сборки: оценщики качества теперь по умолчанию считают неясный результат провалом (fail closed), а адаптер OpenAI Assistants удалён. Если CI у вас зависит от результатов оценки ИИ, первое изменение может сделать зелёный конвейер красным, и это правильный исход.

## Молчание судьи больше не считается успехом

`CoherenceEvaluator`, `FluencyEvaluator`, `RelevanceEvaluator` и остальные оценщики из `Microsoft.Extensions.AI.Evaluation.Quality` запрашивают у LLM-судьи оценку от 1 до 5 и сами её интерпретируют. До версии 10.9.0 интерпретация проваливала метрику, только если значение разбиралось в число меньше 4.0. Когда судья возвращал текст без оценки, `metric.Value` был `null`, рейтинг становился `Inconclusive`, а `Failed` оставался `false`. Оценка 6 шла тем же путём. Любой конвейер, проверяющий "провалилось ли что-нибудь?", считал метрику, которую никто не оценил, зелёной.

[PR #7735](https://github.com/dotnet/extensions/pull/7735) (исправление [issue #7665](https://github.com/dotnet/extensions/issues/7665)) закрывает эту дыру. Я запустил одну и ту же проверку на обеих версиях, используя в качестве судьи `IChatClient` с заготовленными ответами:

```csharp
var result = await new CoherenceEvaluator().EvaluateAsync(
    new ChatMessage(ChatRole.User, "What is 2+2?"),
    new ChatResponse(new ChatMessage(ChatRole.Assistant, "4")),
    new ChatConfiguration(new CannedJudge(reply)));

var m = result.Get<NumericMetric>(CoherenceEvaluator.CoherenceMetricName);
Console.WriteLine($"value={m.Value} rating={m.Interpretation?.Rating} failed={m.Interpretation?.Failed}");
```

| Ответ судьи | 10.9.0 | 10.10.0 |
| --- | --- | --- |
| `<S2>5</S2>` | Exceptional, не провалена | Exceptional, не провалена |
| `<S2>3</S2>` | Average, провалена | Average, провалена |
| `<S2>6</S2>` | Inconclusive, **не провалена** | Inconclusive, провалена: "Coherence is outside the valid range." |
| "I am unable to evaluate this response." | Inconclusive, **не провалена** | Inconclusive, провалена: "Coherence has no score." |

Оценки внутри шкалы ведут себя точно так же, как раньше, включая границу 4.0. Меняется другое: нестабильный, упёршийся в ограничение частоты запросов или неправильно настроенный судья теперь проявляется как провал, а не прячется за успехом. Если после обновления ночной прогон вдруг начал сообщать о провалах, сначала посмотрите на текст `Reason`: "has no score" указывает на модель-судью, а не на ваше приложение.

Исправление ограничено пакетом Quality. В PR отмечается, что `InterpretContentSafetyScore` и `InterpretContentHarmScore` из пакета Safety, а также интерпретация оценок в пакете NLP устроены так же и остались без изменений, так что не рассчитывайте, что они уже считают неясный результат провалом.

## Адаптер Assistants удалён, а не объявлен устаревшим

OpenAI отключила Assistants API 26 августа 2026 года, и [PR #7724](https://github.com/dotnet/extensions/pull/7724) удалил соответствующий экспериментальный API из `Microsoft.Extensions.AI.OpenAI`: обе перегрузки `AssistantClient.AsIChatClient(...)`, `OpenAIAssistantsChatClient` и `AsOpenAIAssistantsFunctionToolDefinition`. Пакет `OpenAI` 2.13.0 по-прежнему содержит `AssistantClient`, поэтому обновление ломается на этапе компиляции, а не при восстановлении пакетов:

```text
error CS1929: 'AssistantClient' does not contain a definition for 'AsIChatClient' and the best extension method overload 'OpenAIClientExtensions.AsIChatClient(ResponsesClient, string?)' requires a receiver of type 'OpenAI.Responses.ResponsesClient'
```

Замена: клиент Responses, при этом инструкции переезжают в `ChatOptions`, а идентификатор беседы заменяет идентификатор потока (thread id). Этот код компилируется с 10.10.0:

```csharp
IChatClient chat = new OpenAIClient(apiKey)
    .GetResponsesClient()
    .AsIChatClient("gpt-5-mini");

var options = new ChatOptions
{
    Instructions = "You are the support assistant for Contoso.",
    ConversationId = conversationId, // previous response id, replaces the thread id
};

ChatResponse response = await chat.GetResponseAsync("Where is my order?", options);
```

Поскольку конечные точки уже возвращают ошибки, любой код, всё ещё идущий по этому пути, сломался в продакшене две недели назад. Ошибка компиляции лишь делает это заметным.

Остальные изменения в 10.10.0 мельче: `OpenAI` обновлён до 2.13.0, неподдерживаемые значения `detail` для изображений больше не выбрасывают `ArgumentNullException`, а хранилище результатов в Azure Storage проверяет сегменты пути. Если вы уже взяли маршрутизирующие клиенты из [Microsoft.Extensions.AI 10.9](/ru/2026/08/microsoft-extensions-ai-10-9-routing-and-failover-chat-clients/), это безопасное обновление, если вы готовы к тому, что шлюз оценки начнёт говорить правду.
