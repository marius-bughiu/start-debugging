---
title: "В Refit 16.4 появился HttpRetryHandler, и он читает заголовки ограничения частоты запросов GitHub, Azure и AWS"
description: "Refit 16.4.0 добавляет включаемый по желанию HttpRetryHandler, который повторяет идемпотентные запросы, учитывает Retry-After и специфичные для провайдеров заголовки вроде x-ratelimit-reset и x-ms-retry-after-ms и не требует ни Polly, ни пакета resilience."
pubDate: 2026-10-18
tags:
  - "dotnet"
  - "refit"
  - "httpclient"
  - "resilience"
lang: "ru"
translationOf: "2026/10/refit-16-4-httpretryhandler-honors-retry-after-and-rate-limit-headers"
translatedBy: "claude"
translationDate: 2026-10-18
---

[Refit 16.4.0](https://github.com/reactiveui/refit/releases/tag/v16.4.0) вышел 17 октября 2026 года, и главная его возможность - обработчик повторных попыток, который находится в основном пакете `Refit`. `HttpRetryHandler` - это обычный `DelegatingHandler`, поэтому он работает и с клиентами Refit, и с любым обычным `HttpClient`, не подтягивая Polly или `Microsoft.Extensions.Http.Resilience`.

Это не очередной цикл с экспоненциальной задержкой. Самое интересное в том, как он решает, сколько ждать.

## Подсказки сервера важнее backoff

По умолчанию обработчик допускает три повтора после первой отправки, но только для `GET`, `HEAD`, `OPTIONS` и `TRACE`. Он повторяет HTTP 408, 429, 500, 502, 503 и 504, а также `HttpRequestException`. Ответ 403 повторяется только тогда, когда настроенный читатель задержки находит корректную подсказку о времени, а именно так GitHub сообщает об исчерпании основного лимита запросов.

Задержку определяет `DelayProvider`. По умолчанию он читает стандартный заголовок `Retry-After`, а `RetryDelayProviders` содержит четыре читателя для конкретных провайдеров:

- `Azure`: `x-ms-retry-after-ms`, затем `retry-after-ms`, затем `Retry-After`.
- `Aws`: `x-amz-retry-after` в миллисекундах, затем `Retry-After`.
- `GitHub`: `Retry-After` или `x-ratelimit-reset` (секунды Unix), когда оставшаяся квота равна нулю при ответе 403 или 429.
- `Jira`: `Retry-After` или `X-RateLimit-Reset` в формате ISO 8601 при ответе 429.

Если корректной подсказки нет, обработчик переходит к экспоненциальной задержке, начиная с одной секунды, с потолком в 30 секунд и полным джиттером. Джиттер никогда не сокращает подсказку сервера, а если подсказка превышает `MaxDelay`, обработчик возвращает ответ вместо того, чтобы повторить запрос слишком рано.

## Подключение к клиенту Refit

С `Refit.HttpClientFactory` обработчик встраивается в цепочку, как любой другой обработчик сообщений:

```csharp
using Refit;

services.AddRefitGeneratedClient<IGitHubApi>()
    .ConfigureHttpClient(static client =>
        client.BaseAddress = new Uri("https://api.github.com"))
    .AddHttpMessageHandler(static () => new HttpRetryHandler(new HttpRetryOptions
    {
        MaxRetries = 3,
        DelayProvider = RetryDelayProviders.GitHub,
        MaxDelay = TimeSpan.FromMinutes(2),
    }));
```

Возвращайте из фабричной лямбды новый обработчик, как в примере выше. Экземпляр обработчика принадлежит одному конвейеру.

Если ваш API использует другой заголовок, `RetryDelayProviders.ReadHeader` сам разберёт секунды, миллисекунды, метки времени Unix или даты:

```csharp
var options = new HttpRetryOptions
{
    DelayProvider = static (response, now, ct) =>
        RetryDelayProviders.ReadHeader(
            response, "X-Throttle-Reset", RetryHeaderFormat.UnixTimeSeconds, now, ct),
};
```

## Защитные ограничения

`POST`, `PUT`, `PATCH` и `DELETE` не повторяются, пока вы не установите `RetryUnsafeMethods = true`, и делать это стоит только для конечных точек, принимающих ключ идемпотентности. Каждая попытка - это новый `HttpRequestMessage` со скопированными заголовками и параметрами. Тело буферизуется один раз с ограничением по умолчанию в 1 MiB (`MaxRequestContentBufferSize`), поэтому неограниченные потоковые загрузки сюда плохо подходят.

Важны две детали порядка. Обработчик аутентификации, размещённый внутри обработчика повторов, выполняется при каждой попытке, а это именно то, что нужно для обновлённых токенов. А `HttpClient.Timeout` охватывает весь вызов, включая ожидание между повторами, поэтому тайм-аут по умолчанию в 100 секунд может оборвать двухминутное окно сброса GitHub.

Не ставьте его поверх `AddStandardResilienceHandler`. Выберите один уровень повторов. Если вы уже используете конвейер resilience от Microsoft, оставьте его. Если у вас небольшой клиент Refit, которому нужно просто вежливо вести себя с API, ограничивающим частоту запросов, теперь это изменение в две строки.

Для тестов `Refit.Testing` добавляет `RetryReply.After`, `RetryReply.Header` и `StubHttp.CreateRetryHandler`, и все они работают через `TimeProvider`, так что ожидания можно проверять без реальных пауз.

Релиз также добавляет `[Query(Name = "client_id")]` и `[Url(AllowRelative = true)]` и исправляет параметры маршрута и запроса, различающиеся только регистром. Это крупнейший выпуск Refit с тех пор, как [16.1 начал генерировать цикл постраничной загрузки с PagedEnumerable](/ru/2026/09/refit-16-1-generates-the-paging-loop-with-pagedenumerable/).
