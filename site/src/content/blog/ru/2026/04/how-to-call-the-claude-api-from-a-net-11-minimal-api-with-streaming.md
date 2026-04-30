---
title: "Как вызвать Claude API из Minimal API на .NET 11 со стримингом"
description: "Стримьте ответы Claude из minimal API на ASP.NET Core 11 от начала до конца: официальный Anthropic .NET SDK, TypedResults.ServerSentEvents, SseItem, IAsyncEnumerable, поток отмены и подводные камни, которые молча буферизуют ваши токены. С примерами для Claude Sonnet 4.6 и Opus 4.7."
pubDate: 2026-04-30
tags:
  - "llm"
  - "ai-agents"
  - "anthropic-sdk"
  - "aspnet-core"
  - "dotnet-11"
  - "streaming"
lang: "ru"
translationOf: "2026/04/how-to-call-the-claude-api-from-a-net-11-minimal-api-with-streaming"
translatedBy: "claude"
translationDate: 2026-04-30
---

Если вы подключите Claude к minimal API на ASP.NET Core 11 очевидным способом, то получите запрос, который "работает", и вывод, прибывающий одним медленным куском через двенадцать секунд. API Anthropic стримит ответ по мере генерации каждого токена. Ваш endpoint собирает их, JSON-сериализует полное сообщение и отправляет всё разом, когда модель скажет `message_stop`. Каждый сервер, прокси и браузер между Kestrel и пользователем буферизует это, потому что им никто не сказал, что это стрим.

Это руководство показывает правильное соединение на текущем стеке: ASP.NET Core 11 (preview 3 на апрель 2026, RTM позже в этом году), официальный Anthropic .NET SDK (`Anthropic` в NuGet), Claude Sonnet 4.6 (`claude-sonnet-4-6`) и Claude Opus 4.7 (`claude-opus-4-7`), и `TypedResults.ServerSentEvents` из `Microsoft.AspNetCore.Http`. Мы пройдём от обычного endpoint, который буферизует, до endpoint `IAsyncEnumerable<string>`, стримящего текст по чанкам, и далее до типизированного endpoint `SseItem<T>`, выпускающего корректные SSE-события, которые `EventSource` в браузере может прочитать. Затем разберёмся с отменой, ошибками, вызовами инструментов и прокси, которые тихо ломают всё это.

## Почему "просто await ответа" здесь неправильно

Не стриминговый вызов Claude возвращает полное сообщение `Message` после того, как модель закончила. Для ответа в 1500 токенов на Sonnet 4.6 это примерно от шести до двенадцати секунд мёртвого воздуха. Это плохой UX в чат-интерфейсе и хуже на медленном соединении, потому что пользователь ничего не видит, пока всё не пришло. Также это стоит вам тех же входных токенов, стримите вы или нет, поэтому преимущества буферизации нет.

Стриминговый endpoint, описанный в [справке по стримингу Anthropic](https://platform.claude.com/docs/en/build-with-claude/streaming), использует Server-Sent Events. Каждый чанк это SSE-кадр с именованным событием (`message_start`, `content_block_delta`, `message_stop` и т. д.) и JSON-полезной нагрузкой. .NET SDK оборачивает это в `IAsyncEnumerable`, чтобы вам не пришлось парсить SSE самостоятельно при вызове Anthropic. Сложнее половина это сторона *вывода*: как переотправить эти чанки в браузер, не давая фреймворку услужливо их буферизовать?

ASP.NET Core 8 получил нативный стриминг `IAsyncEnumerable<T>` для minimal API. ASP.NET Core 10 добавил `TypedResults.ServerSentEvents` и `SseItem<T>`, чтобы вы могли возвращать корректный SSE без ручной сборки `text/event-stream`. Оба входят в 11. Вместе они покрывают две формы, которые вам действительно нужны.

## Буферизованная версия, которую не стоит выпускать

Вот наивный endpoint, просто чтобы у нас была отправная точка для разбора.

```csharp
// .NET 11 preview 3, Anthropic 0.2.0-alpha (NuGet: Anthropic)
using Anthropic;
using Anthropic.Models.Messages;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton(_ => new AnthropicClient());
var app = builder.Build();

app.MapPost("/chat", async (ChatRequest req, AnthropicClient client) =>
{
    var parameters = new MessageCreateParams
    {
        Model = Model.ClaudeSonnet4_6,
        MaxTokens = 1024,
        Messages = [new() { Role = Role.User, Content = req.Prompt }]
    };

    var message = await client.Messages.Create(parameters);
    return Results.Ok(new { text = message.Content[0].Text });
});

app.Run();

record ChatRequest(string Prompt);
```

Это работает. Это также блокирует весь ответ, пока Claude не закончит. Исправление в двух изменениях: переключить вызов SDK на `CreateStreaming` и передать ASP.NET перечислитель вместо `Task<T>`.

## Стриминг текстовых чанков с IAsyncEnumerable<string>

Anthropic .NET SDK предоставляет `client.Messages.CreateStreaming(parameters)`, возвращающий асинхронный enumerable текстовых дельт. Сочетайте это с endpoint minimal API, возвращающим `IAsyncEnumerable<string>`, и ASP.NET Core будет стримить его как `application/json` (JSON-массив, записываемый инкрементально) без буферизации.

```csharp
// .NET 11 preview 3, Anthropic 0.2.0-alpha
using System.Runtime.CompilerServices;
using Anthropic;
using Anthropic.Models.Messages;

app.MapPost("/chat/stream", (ChatRequest req,
                              AnthropicClient client,
                              CancellationToken ct) =>
{
    return StreamChat(req.Prompt, client, ct);

    static async IAsyncEnumerable<string> StreamChat(
        string prompt,
        AnthropicClient client,
        [EnumeratorCancellation] CancellationToken ct)
    {
        var parameters = new MessageCreateParams
        {
            Model = Model.ClaudeSonnet4_6,
            MaxTokens = 1024,
            Messages = [new() { Role = Role.User, Content = prompt }]
        };

        await foreach (var chunk in client.Messages.CreateStreaming(parameters)
                                                    .WithCancellation(ct))
        {
            yield return chunk;
        }
    }
});
```

Здесь важны три детали:

1. **Локальная функция**, не лямбда. Компилятор C# не позволяет `yield return` внутри лямбд или анонимных методов, поэтому делегат minimal API вызывает локальный async-метод-итератор. Это спотыкает всех, кто пишет minimal API со времён .NET 6, потому что любая другая форма endpoint работает как лямбда.
2. **`[EnumeratorCancellation]`** на параметре `CancellationToken` итератора. Без него токен прерывания запроса от ASP.NET не будет передан в перечислитель, и закрытое соединение не остановит SDK, который радостно продолжит стрим и сожжёт ваши выходные токены. Компилятор не предупреждает об этом. Добавьте атрибут или проверьте профайлером, что закрытие вкладки действительно отменяет запрос.
3. **`.WithCancellation(ct)`** на enumerable SDK. Подстраховка, но это делает отмену явной на той границе, которая вас интересует.

Формат на проводе у этого endpoint это JSON-массив. Браузер не получает дружелюбный к `EventSource` стрим, но `fetch` с читателем `ReadableStream` работает нормально, как и любой потребитель, умеющий обрабатывать чанковый JSON-массив. Если ваш клиент это хаб SignalR или серверно-управляемый UI-фреймворк, обычно это та форма, которую вы хотите.

## Стриминг корректного SSE с TypedResults.ServerSentEvents

Если ваш клиент это браузер, использующий `EventSource`, или сторонний инструмент, ожидающий `text/event-stream`, вам нужен SSE, а не JSON. ASP.NET Core 10 добавил `TypedResults.ServerSentEvents`, который принимает `IAsyncEnumerable<SseItem<T>>` и пишет настоящий SSE-ответ с правильным content type, no-cache заголовками и корректным фреймингом.

`SseItem<T>` находится в `System.Net.ServerSentEvents`. Каждый item несёт тип события, опциональный ID, опциональный интервал переподключения и полезную нагрузку `Data` типа `T`. ASP.NET сериализует полезную нагрузку как JSON, если только вы не отправляете строку, в этом случае она проходит как есть.

```csharp
// .NET 11 preview 3, Anthropic 0.2.0-alpha
using System.Net.ServerSentEvents;
using System.Runtime.CompilerServices;
using Anthropic;
using Anthropic.Models.Messages;
using Microsoft.AspNetCore.Http;

app.MapPost("/chat/sse", (ChatRequest req,
                           AnthropicClient client,
                           CancellationToken ct) =>
{
    return TypedResults.ServerSentEvents(StreamChat(req.Prompt, client, ct));

    static async IAsyncEnumerable<SseItem<string>> StreamChat(
        string prompt,
        AnthropicClient client,
        [EnumeratorCancellation] CancellationToken ct)
    {
        var parameters = new MessageCreateParams
        {
            Model = Model.ClaudeSonnet4_6,
            MaxTokens = 1024,
            Messages = [new() { Role = Role.User, Content = prompt }]
        };

        await foreach (var chunk in client.Messages.CreateStreaming(parameters)
                                                    .WithCancellation(ct))
        {
            yield return new SseItem<string>(chunk, eventType: "delta");
        }

        yield return new SseItem<string>("", eventType: "done");
    }
});
```

Теперь браузер может сделать так:

```javascript
// Browser, native EventSource (still GET-only) or fetch-event-source for POST.
const es = new EventSource("/chat/sse?prompt=...");
es.addEventListener("delta", (e) => append(e.data));
es.addEventListener("done", () => es.close());
```

Фрейминг на проводе это стандартная форма SSE:

```
event: delta
data: "Hello"

event: delta
data: " world"

event: done
data: ""

```

Две заметки о выборе между двумя endpoint. Если клиент это браузер, использующий `EventSource`, вам нужен SSE. Если что-то другое, включая ваш собственный фронтенд с читателем `fetch`, endpoint `IAsyncEnumerable<string>` проще, лучше кешируется в конфиге CDN и сохраняет форму тела очевидной. API `TypedResults.ServerSentEvents` описан в [Create responses in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/responses?view=aspnetcore-10.0).

## Закрепление ID моделей и стоимость

Для стриминга в стиле чата правильные значения по умолчанию в апреле 2026 это:

- **Claude Sonnet 4.6 (`claude-sonnet-4-6`)** для общего чата. $3 / миллион входных токенов, $15 / миллион выходных. Задержка до первого байта около 400-600 мс в `us-east-1`. Контекстное окно 200k.
- **Claude Opus 4.7 (`claude-opus-4-7`)** для сложных рассуждений. $15 / $75. Первый байт медленнее, 800 мс-1.2 с. Контекстное окно 200k, 1M с бетой длинного контекста.
- **Claude Haiku 4.5 (`claude-haiku-4-5`)** для дешёвых вызовов с высокой пропускной способностью. $1 / $5. Первый байт менее 300 мс.

Указывайте ID модели в коде, никогда не через строку конфигурации, которую фронтенд может переопределить. Константы SDK (`Model.ClaudeSonnet4_6`, `Model.ClaudeOpus4_7`, `Model.ClaudeHaiku4_5`) убирают риск опечаток на этапе компиляции. Цены на [странице цен Claude API](https://www.anthropic.com/pricing); проверяйте, прежде чем что-либо выставлять в счёт.

Если вы собираетесь поставить длинный системный prompt или каталог инструментов перед каждым запросом, вам также нужно включить prompt caching, потому что стриминг и кеширование чисто компонуются. Подробности в [Как добавить prompt caching в приложение Anthropic SDK и измерить долю попаданий](/ru/2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate/).

## Что SDK скрывает от вас

Строковые чанки, выходящие из `CreateStreaming`, это дружелюбное представление SDK для сырого SSE-потока событий. Реальные события, которые вы увидели бы, если бы парсили провод сами:

- `message_start`: оболочка `Message` с пустым `content`. Несёт ID сообщения и начальный `usage`.
- `content_block_start`: открывает блок контента (text, tool_use или thinking).
- `content_block_delta`: инкрементальные обновления. `delta.type` это один из `text_delta`, `input_json_delta`, `thinking_delta` или `signature_delta`.
- `content_block_stop`: закрывает текущий блок.
- `message_delta`: обновления верхнего уровня, включая `stop_reason` и кумулятивное использование выходных токенов.
- `message_stop`: конец стрима.
- `ping`: заполнитель, отправляемый, чтобы прокси не убивали неактивные соединения. Игнорировать.

SDK сворачивает всё это в выход итератора, который вы видите, но вы получите более богатое представление, если попросите. Проверьте перегрузку SDK, возвращающую сырые события, или удержите накопленное `Message` после цикла через `.GetFinalMessage()`, чтобы прочитать настоящий `usage` (кумулятивный в `message_delta`, финальный в `message_stop`). Для цикла агента почти всегда нужно финальное сообщение: там SDK даёт вам `stop_reason`, собранные вызовы инструментов и счётчики входных/выходных токенов, нужные для биллинга.

## Отмена, которая действительно отменяет

Это баг, который никто не ловит на dev и все ловят в prod. Пользователь закрывает вкладку. ASP.NET срабатывает токен прерывания запроса. Ваш `IAsyncEnumerable` endpoint должен остановиться, SDK должен остановиться, нижележащий HTTP-стрим к Anthropic должен закрыться. Каждое звено этой цепи должно уважать токен, и любое его нарушающее оставляет вас генерировать токены, которые никто не читает.

Три места для проверки:

1. Атрибут `[EnumeratorCancellation]` на параметре токена вашего итератора. Без него токен, переданный ASP.NET через `WithCancellation`, не становится `ct` итератора.
2. Вызов `CreateStreaming` нуждается в токене. Передайте через `.WithCancellation(ct)` или через опции вызова SDK, если у вас версия, принимающая токен напрямую.
3. Браузерная сторона должна действительно закрыться. `EventSource` переподключается по умолчанию. Если вы не вызываете `es.close()` с клиента, навигация прочь может запустить новый запрос через несколько секунд. Для долгих completion это может стоить реальных денег.

Самый чистый тест это вызвать endpoint с `curl`, убить его Ctrl-C посреди стрима и наблюдать панель Anthropic или собственные логи запросов. Соединение с Anthropic должно закрыться в течение секунды после отключения клиента. Если нет, ваш токен где-то не течёт.

Для более длинного разбора отмены в IO-циклах в целом смотрите [Как отменить долгую задачу в C# без взаимной блокировки](/ru/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/).

## Ошибки в середине стрима

Стриминговый ответ, который уже начался, не может вернуть 500. Вы зафиксировали 200 в момент, когда Kestrel сбросил первый байт. Ошибки после этого момента должны течь как данные, а не как HTTP-статус. Шаблон, сохраняющий клиентов в здравом уме:

```csharp
static async IAsyncEnumerable<SseItem<string>> StreamChat(
    string prompt,
    AnthropicClient client,
    [EnumeratorCancellation] CancellationToken ct)
{
    var parameters = new MessageCreateParams
    {
        Model = Model.ClaudeSonnet4_6,
        MaxTokens = 1024,
        Messages = [new() { Role = Role.User, Content = prompt }]
    };

    IAsyncEnumerator<string>? enumerator = null;
    try
    {
        enumerator = client.Messages.CreateStreaming(parameters)
                                     .WithCancellation(ct)
                                     .GetAsyncEnumerator();
    }
    catch (Exception ex)
    {
        yield return new SseItem<string>(ex.Message, eventType: "error");
        yield break;
    }

    while (true)
    {
        bool moved;
        try
        {
            moved = await enumerator.MoveNextAsync();
        }
        catch (OperationCanceledException) { yield break; }
        catch (Exception ex)
        {
            yield return new SseItem<string>(ex.Message, eventType: "error");
            yield break;
        }

        if (!moved) break;
        yield return new SseItem<string>(enumerator.Current, eventType: "delta");
    }

    yield return new SseItem<string>("", eventType: "done");
}
```

Это уродливее счастливого пути, но это правильная форма. `try` не может обернуть `yield return`, поэтому вы разделяете итерацию на ручной цикл `MoveNextAsync`. Сбои в середине стрима (rate limits, перегрузка модели, сетевые икоты) становятся событием `error`, которое клиент может отрисовать. Чистые завершения становятся событием `done`. Отмены выходят молча, потому что запрос уже ушёл.

Две конкретные ошибки Anthropic заслуживают отдельной обработки на стороне клиента: `overloaded_error` (модель временно без ёмкости, повторите с backoff) и `rate_limit_error` (вы достигли минутного или дневного лимита организации). Обе приходят как исключения от SDK на стороне .NET, с типизированным `AnthropicException`, по которому можно сделать сопоставление с образцом.

## Вызовы инструментов в стриме

Если ваш endpoint может производить блоки контента `tool_use`, SDK всё равно даёт вам строкотипизированный итератор для текстовых дельт, но вы теряете полезную нагрузку вызова инструмента, если только также не подпишетесь на события, её несущие. Более низкоуровневый `Messages.CreateStreamingRaw` (или эквивалент в вашей версии SDK) выставляет типизированные события. Шаблон: маршрутизировать `text_delta` в ваш SSE-канал дельт, маршрутизировать `input_json_delta` (фрагменты аргументов вызова инструмента) в отдельный канал `tool` и позволять клиенту решать, что отрисовывать.

На практике большинство чат-интерфейсов не нуждаются в отрисовке JSON-аргументов по мере их поступления. Они ждут `content_block_stop` на блоке инструмента, затем показывают "Calling get_weather..." и результат. Стриминг аргументов инструмента токен за токеном это в основном помощь при отладке.

Если вы уже подключаете вызовы инструментов, то, вероятно, также выставляете сервисы Claude как MCP-инструменты. Серверный шаблон на стороне .NET в [Как построить кастомный MCP-сервер на C# на .NET 11](/ru/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/). Стриминговый endpoint здесь это *клиент* этих инструментов, не сервер.

## Буферизация прокси, которая ломает всё

Вы соединили всё правильно. Бьёте по нему с `localhost`. Стримит. Вы развёртываете за nginx, Cloudflare или Azure Front Door, и ответ возвращается одним большим буферизованным куском. Три настройки, о которых нужно знать, в порядке приоритета:

- **nginx**: установите `proxy_buffering off;` на SSE-локации, или добавьте `X-Accel-Buffering: no` как заголовок ответа от вашего endpoint. Трюк с заголовком переносим и переживает смены обратного прокси. Добавьте его в middleware для любого endpoint, возвращающего `text/event-stream` или `application/json` с `IAsyncEnumerable`.
- **Cloudflare**: включите [Streaming responses](https://developers.cloudflare.com/) на соответствующем маршруте. Поведение по умолчанию сохраняет чанки на большинстве планов, но enterprise WAF-правила могут буферизовать. Тестируйте сначала трюком с заголовком ответа.
- **Сжатие**: middleware сжатия ответов может собирать чанки, чтобы сжать их более крупными блоками. Либо отключите сжатие для `text/event-stream`, либо используйте `application/json` с chunked transfer; сжатие ответов ASP.NET знает оба, но кастомное middleware, упорядоченное перед стриминговым endpoint, может его побороть.

Добавьте этот фильтр к стриминговым endpoint, чтобы убедиться в наличии заголовка:

```csharp
app.MapPost("/chat/sse", ...)
   .AddEndpointFilter(async (ctx, next) =>
   {
       ctx.HttpContext.Response.Headers["X-Accel-Buffering"] = "no";
       return await next(ctx);
   });
```

Подробнее о безопасном стриминге тел из ASP.NET Core смотрите [Как стримить файл из endpoint ASP.NET Core без буферизации](/ru/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/). Урок "не давайте middleware собирать ваши чанки" применим идентично к LLM-стримам.

## Наблюдаемость стримингового endpoint

Стриминговый вызов Claude имеет два значения задержки, стоящих отслеживания: время до первого токена (задержка, ощущаемая пользователем) и общее время до завершения. Оба должны попадать в ваши трейсы. Нативная поддержка OpenTelemetry в ASP.NET Core 11 делает это лёгким без зависимости от пакетов `Diagnostics.Otel`. Настройка в [Нативная трассировка OpenTelemetry в ASP.NET Core 11](/ru/2026/04/aspnetcore-11-native-opentelemetry-tracing/).

Захватите три кастомных атрибута на span запроса: ID модели, счётчик входных токенов (из финального `Message` SDK) и счётчик выходных токенов. Реконструкция стоимости только из логов иначе болезненна. Гистограммы задержек, сгруппированные по модели, делают очевидным, когда стоит откатиться с Opus 4.7 на Sonnet 4.6 для рутинного трафика.

## Что насчёт Microsoft.Extensions.AI

Если вы предпочитаете кодить против провайдер-нейтральных абстракций, `IChatClient.GetStreamingResponseAsync` из Microsoft.Extensions.AI возвращает `IAsyncEnumerable<ChatResponseUpdate>` и работает так же на HTTP-границе. Оберните адаптер `IChatClient` от Anthropic, спроецируйте обновления в текст или `SseItem<T>`, и остаток статьи применим без изменений. Компромисс это слой абстракции в обмен на возможность переключиться на OpenAI или локальную модель позже. Для кода агентов вам также нужна версия фреймворка, смотрите [Microsoft Agent Framework 1.0: ИИ-агенты на C#](/ru/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/), который строится поверх тех же абстракций.

Для угла BYOK (передачи того же ключа Anthropic в GitHub Copilot в VS Code) настройка отражает то, что вы делаете здесь: те же ID моделей, тот же ключ, другой потребитель. Смотрите [GitHub Copilot в VS Code: BYOK с Anthropic, Ollama и Foundry Local](/ru/2026/04/github-copilot-vs-code-byok-anthropic-ollama-foundry-local/).

## Источники

- [Streaming Messages, Claude API docs](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [Anthropic .NET SDK on GitHub](https://github.com/anthropics/anthropic-sdk-csharp)
- [Anthropic NuGet package](https://www.nuget.org/packages/Anthropic/)
- [Create responses in Minimal API applications, ASP.NET Core docs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/responses?view=aspnetcore-10.0)
- [System.Net.ServerSentEvents.SseItem<T>](https://learn.microsoft.com/en-us/dotnet/api/system.net.serversentevents.sseitem-1)
- [Claude API pricing](https://www.anthropic.com/pricing)
