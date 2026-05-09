---
title: "Исправление: TaskCanceledException: A task was canceled в HttpClient"
description: "HttpClient выбрасывает TaskCanceledException по трём разным причинам: таймаут, отмена со стороны вызывающего кода или прерывание на уровне соединения. Различайте их с помощью InnerException и CancellationToken.IsCancellationRequested и устраняйте именно ту, что нужно."
pubDate: 2026-05-09
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "httpclient"
  - "cancellation"
lang: "ru"
translationOf: "2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient"
translatedBy: "claude"
translationDate: 2026-05-09
---

Решение: `HttpClient` выбрасывает `TaskCanceledException` (подкласс `OperationCanceledException`) по трём разным причинам, и прежде чем что-то предпринимать, эти причины нужно различить. Если `ex.InnerException is TimeoutException`, запрос упёрся в `HttpClient.Timeout` (по умолчанию 100 секунд), значит, нужно увеличить таймаут или вынести длительные вызовы на отдельный `CancellationTokenSource` для каждого запроса. Если отменён ваш собственный `CancellationToken` (`ex.CancellationToken.IsCancellationRequested == true`), это вызывающий код прекращает работу, ничего исправлять не нужно, кроме как дать исключению распространиться. Если ни то, ни другое, перед вами прерывание на транспортном уровне (DNS, TCP, TLS, сброс со стороны сервера), что обычно указывает на инфраструктуру, а не на ваш код.

```text
System.Threading.Tasks.TaskCanceledException: The request was canceled due to the configured HttpClient.Timeout of 100 seconds elapsing.
 ---> System.TimeoutException: The operation was canceled.
 ---> System.Threading.Tasks.TaskCanceledException: The operation was canceled.
   at System.Threading.Tasks.TaskCompletionSource`1.TrySetCanceled(CancellationToken cancellationToken)
   at System.Net.Http.HttpConnectionPool.SendWithVersionDetectionAndRetryAsync(...)
   at System.Net.Http.HttpClient.<SendAsync>g__Core|...
   at MyApp.Program.<Main>$(String[] args)
```

Это руководство написано для .NET 11 preview 4 и `System.Net.Http` 11.0.0-preview.4. Тип исключения и форма обёрнутого `TimeoutException` не менялись с .NET 5, но текст сообщения был уточнён в .NET 8, чтобы явно указать, какой именно таймаут сработал ("The request was canceled due to the configured `HttpClient.Timeout` of 100 seconds elapsing"). В .NET 6 и более ранних версиях вы получали лишь общее "A task was canceled.", из-за чего во многих советах до 2024 года предлагается логировать вложенное исключение вручную.

## Почему HttpClient выбрасывает TaskCanceledException на всё подряд

Конвейер `HttpClient.SendAsync` построен на `Task` и единственном параметре `CancellationToken`. Таймаут, токен вызывающего кода и внутреннее прерывание соединения объединяются в один `CancellationTokenSource` ещё до того, как запрос попадает в сокет. Когда срабатывает любой из этих источников, операция завершается одним и тем же сбоем в форме `OperationCanceledException`, независимо от того, что сработало первым.

Microsoft подтвердила это проектное решение в [dotnet/runtime#21965](https://github.com/dotnet/runtime/issues/21965): таймаут не выбрасывается напрямую как `TimeoutException`, потому что смена типа была бы бинарно-несовместимым изменением. Вместо этого в .NET 5 добавили `InnerException` типа `TimeoutException`, чтобы вызывающий код мог различать случаи, а в .NET 8 добавили явный текст сообщения. Свойство `CancellationToken` исключения, устанавливаемое средой выполнения, служит вторым средством различения.

Получается, что одно и то же исключение покрывает три совершенно разных проблемы. Реакция на "task was canceled" без проверки конкретного случая -- самая частая причина, по которой эта ошибка остаётся неисправленной неделями.

## Минимальный воспроизводимый пример для каждой причины

```csharp
// .NET 11, C# 14, System.Net.Http 11.0.0-preview.4
using System.Net.Http;

// Cause 1: HttpClient.Timeout elapsed
using var c1 = new HttpClient { Timeout = TimeSpan.FromMilliseconds(50) };
try
{
    await c1.GetAsync("https://httpbin.org/delay/3");
}
catch (TaskCanceledException ex)
{
    Console.WriteLine($"Inner: {ex.InnerException?.GetType().Name}");
    // Inner: TimeoutException
}

// Cause 2: caller's CancellationToken cancelled
using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(50));
using var c2 = new HttpClient();
try
{
    await c2.GetAsync("https://httpbin.org/delay/3", cts.Token);
}
catch (TaskCanceledException ex)
{
    Console.WriteLine($"Token cancelled: {ex.CancellationToken.IsCancellationRequested}");
    Console.WriteLine($"Linked token: {cts.Token == ex.CancellationToken}");
    // Token cancelled: True
}

// Cause 3: connection-level abort (DNS/TCP/TLS) - simulated with a closed port
using var c3 = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
try
{
    await c3.GetAsync("http://10.255.255.1/");
}
catch (TaskCanceledException ex) when (ex.InnerException is TimeoutException)
{
    Console.WriteLine("Looks like a timeout, was actually connect failure under timeout.");
}
catch (HttpRequestException ex)
{
    Console.WriteLine($"True transport failure: {ex.HttpRequestError}");
    // .NET 8+ exposes ex.HttpRequestError = ConnectionError, NameResolutionError, etc.
}
```

Третий случай интересен. Если истекает таймаут подключения, вы получаете `HttpRequestException` с `ex.HttpRequestError == HttpRequestError.ConnectionError`. Если подключение удаётся, но ответ задерживается достаточно долго, чтобы сработал `HttpClient.Timeout`, вы возвращаетесь к случаю 1. По журналам они выглядят почти одинаково, но требуют разных решений.

## Как исправить, в деталях

### 1. Сначала диагностика, через фильтр исключений

Прежде чем менять какой-либо таймаут, залогируйте, в каком вы случае. Иначе вы поднимете `Timeout` до 5 минут, а потом обнаружите, что настоящая проблема была в отмене со стороны вызывающего кода.

```csharp
// .NET 11, C# 14
try
{
    return await client.GetAsync(url, ct);
}
catch (TaskCanceledException ex) when (ex.InnerException is TimeoutException)
{
    logger.LogWarning(ex,
        "HttpClient.Timeout elapsed for {Url} (configured: {Timeout})",
        url, client.Timeout);
    throw;
}
catch (OperationCanceledException ex) when (ct.IsCancellationRequested)
{
    logger.LogInformation("Caller cancelled request to {Url}", url);
    throw;
}
catch (TaskCanceledException ex)
{
    logger.LogError(ex, "Unknown cancellation cause for {Url}", url);
    throw;
}
```

`OperationCanceledException` -- это родительский тип, и именно он вам нужен для ветки с отменой со стороны вызывающего кода, поскольку фактический тип во время выполнения может быть `OperationCanceledException` или `TaskCanceledException` в зависимости от того, в каком месте конвейера сработала отмена.

### 2. Поднимайте HttpClient.Timeout, но только для тех клиентов, которым это нужно

`HttpClient.Timeout` относится к клиенту и применяется к каждому запросу, в который не передан токен с собственным таймаутом. Значение по умолчанию в 100 секунд подходит для типовых вызовов REST. Если у вас есть длительный endpoint, выделите для него отдельного клиента.

```csharp
// .NET 11
builder.Services.AddHttpClient("LongRunning", c =>
{
    c.Timeout = TimeSpan.FromMinutes(10);
    c.BaseAddress = new Uri("https://reports.example.com/");
});

builder.Services.AddHttpClient("Default", c =>
{
    c.Timeout = TimeSpan.FromSeconds(30);
});
```

Не поднимайте `Timeout` глобального клиента только ради того, чтобы заработал один медленный вызов. Так вы скроете будущие регрессии: вызов, который должен укладываться в 200 мс, но начнёт занимать 90 с, тихо пройдёт через ослабленный порог и проявится как зависание интерфейса. Более жёсткие таймауты позволяют ловить регрессии производительности на ранней стадии. В [руководстве по модульному тестированию HttpClient](/ru/2026/04/how-to-unit-test-code-that-uses-httpclient/) показано, как проверять эти границы таймаутов в тестах, чтобы регрессия здесь не проскочила через CI.

### 3. Переходите на CancellationTokenSource на каждый запрос для тонкой настройки

`HttpClient.Timeout` -- грубый инструмент. Внутри `BackgroundService` или конвейера запроса, у которого уже есть токен, связывайте их.

```csharp
// .NET 11, C# 14
using var perCallCts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
using var linked = CancellationTokenSource.CreateLinkedTokenSource(
    perCallCts.Token, requestAborted);

try
{
    var response = await client.GetAsync(url, linked.Token);
    return await response.Content.ReadAsStringAsync(linked.Token);
}
catch (OperationCanceledException) when (perCallCts.IsCancellationRequested
                                          && !requestAborted.IsCancellationRequested)
{
    // Per-call timeout, not caller cancellation. Surface as your own timeout type.
    throw new TimeoutException($"GET {url} exceeded 15 seconds.");
}
```

Этот шаблон чисто сочетается с `IHttpClientFactory`: установите `Timeout` именованного клиента в большое значение (или `Timeout.InfiniteTimeSpan`) и применяйте реальный бюджет на стороне вызова через связанный CTS. `Timeout.InfiniteTimeSpan` здесь работает потому, что `HttpClient` добавляет свой `Timeout` к связанному токену только если значение положительное, поэтому бесконечный `Timeout` клиента означает "ответственность на вызывающем коде". В [руководстве по взаимной блокировке при отмене](/ru/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) подробнее разобран шаблон со связанными токенами, в том числе как отличать таймауты от отмен со стороны вызывающего кода на более высоких уровнях.

### 4. Используйте HttpCompletionOption.ResponseHeadersRead для потоковых тел ответа

`HttpClient.Timeout` покрывает время от `SendAsync` до "готов читать тело" только при значении по умолчанию `HttpCompletionOption.ResponseContentRead`. С `ResponseHeadersRead` таймаут применяется только до получения заголовков. За таймаут чтения тела отвечаете вы сами, что подтверждено в [документации по HttpCompletionOption](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.httpcompletionoption).

```csharp
// .NET 11, C# 14
using var cts = new CancellationTokenSource(TimeSpan.FromMinutes(2));
using var response = await client.GetAsync(
    url, HttpCompletionOption.ResponseHeadersRead, cts.Token);

response.EnsureSuccessStatusCode();
await using var stream = await response.Content.ReadAsStreamAsync(cts.Token);
await using var file = File.Create(path);
await stream.CopyToAsync(file, cts.Token);
```

Передавайте один и тот же токен везде. Частая ошибка -- передать `cts.Token` в `GetAsync`, но забыть про него в `CopyToAsync`, и тогда `HttpClient.Timeout` уже не применяется к телу, а зависший производитель данных висит вечно. В [статье про потоковую передачу из ASP.NET Core](/ru/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) разобрана симметричная ошибка на стороне сервера, когда забывают передать `CancellationToken` запроса дальше, что приводит к такому же зависанию на стороне производителя.

### 5. Настраивайте таймаут подключения отдельно в .NET 8 и более поздних версиях

`HttpClient.Timeout` покрывает весь запрос целиком, но DNS и TCP-подключение входят в этот бюджет. Если вы хотите, чтобы DNS или подключение быстро завершались с ошибкой независимо от таймаута запроса, задайте `SocketsHttpHandler.ConnectTimeout`.

```csharp
// .NET 11, C# 14
var handler = new SocketsHttpHandler
{
    ConnectTimeout = TimeSpan.FromSeconds(5),
    PooledConnectionLifetime = TimeSpan.FromMinutes(2),
};

builder.Services.AddHttpClient("Api", c =>
{
    c.Timeout = TimeSpan.FromSeconds(30);
    c.BaseAddress = new Uri("https://api.example.com/");
}).ConfigurePrimaryHttpMessageHandler(() => handler);
```

Короткий таймаут подключения превращает "ждите 30 секунд впустую" в "падение через 5 секунд, повтор на другой endpoint". Различение таймаутов подключения и таймаутов ответа -- это разница между размыкателем цепи Polly, который открывается быстро, и тем, который протаскивает каждого вызывающего через всё окно таймаута.

## Распространённые ситуации, в которых это срабатывает

### Типизированный клиент IHttpClientFactory с неправильным Timeout

Типизированный клиент берёт `Timeout` из `AddHttpClient`, а не из свойства, которое вы установили на `HttpClient` позднее. Код, который выполняет `_client.Timeout = TimeSpan.FromMinutes(5)` из конструктора через внедрение зависимостей, выбросит `InvalidOperationException`, как только через клиент пройдёт хотя бы один запрос. Фабрика переиспользует базовый обработчик, но экземпляр `HttpClient` для целей `Timeout` одноразовый. Настраивайте таймаут в `AddHttpClient`, а не в конструкторе типизированного клиента.

### Task.WhenAll с несогласованными токенами

Когда вы веером раздаёте N HTTP-вызовов через `Task.WhenAll(tasks)` и один из них отменяется, исключение бросает только этот один. Остальные продолжают работу и тоже могут наткнуться на таймауты. Если ваш код пробрасывает первую отмену дальше, оставшиеся задачи становятся ненаблюдаемыми, и их исключения всплывают в `TaskScheduler.UnobservedTaskException`. Используйте `Task.WhenAll` с общим связанным CTS, который вы отменяете при первом сбое, чтобы остальные запросы тоже остановились.

### Политика повторов Polly скрывает вложенный таймаут

Обработчик повторов Polly, который проглатывает `TaskCanceledException` и повторяет запрос, может полностью замаскировать настоящий таймаут. Если внешний сервис действительно медленный, вы превращаете одно ожидание в 100 секунд в три ожидания по 100 секунд, после чего сдаётесь. Настройте Polly так, чтобы он коротко замыкался при вложенном `TimeoutException` и оставлял решение за вызывающим кодом.

```csharp
// .NET 11, Microsoft.Extensions.Http.Resilience 11.0.0-preview.4
builder.Services.AddHttpClient("Api")
    .AddStandardResilienceHandler(options =>
    {
        options.AttemptTimeout.Timeout = TimeSpan.FromSeconds(10);
        options.TotalRequestTimeout.Timeout = TimeSpan.FromSeconds(30);
        options.Retry.ShouldHandle = args => args.Outcome switch
        {
            { Exception: HttpRequestException } => PredicateResult.True(),
            { Exception: TaskCanceledException tce } when tce.InnerException is TimeoutException
                => PredicateResult.False(),
            _ => PredicateResult.False(),
        };
    });
```

`AddStandardResilienceHandler` из пакета `Microsoft.Extensions.Http.Resilience` чисто разделяет таймауты на попытку и на весь запрос, и это аккуратная замена самописному коду на Polly со связанным CTS.

### Синхронный Wait или Result на вызове HttpClient

`client.GetAsync(url).Result` приводит к взаимной блокировке в однопоточном контексте синхронизации (классический ASP.NET, WPF) и проявляется как `TaskCanceledException`, когда `HttpClient.Timeout` наконец срабатывает спустя 100 секунд. Решение -- `await`, и точка. Из-за взаимной блокировки запрос так и не начинает фазу получения ответа, таймер в итоге срабатывает, и симптом выглядит как сетевой таймаут. Если вы видите "task was canceled" без какого-либо исходящего сетевого трафика в трассировках, ищите блокирующие синхронные вызовы в стеке вызовов. В [статье про шаблон BackgroundService](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/) разобрано правило "асинхронность до самого низа" для размещённых служб, где это бьёт сильнее всего.

### Повторное использование HttpRequestMessage

`HttpRequestMessage` нельзя отправить дважды. Второй `SendAsync` выбросит `InvalidOperationException: The request message was already sent`. Некоторые библиотеки повторов это маскируют, и сбой проявляется как отмена другого запроса, который делил токен с упавшим. Всегда создавайте новый `HttpRequestMessage` на каждую попытку.

## Варианты, похожие на эту ошибку, но не являющиеся ею

### "The operation was canceled" без вложенного исключения, в .NET Framework 4.8

В .NET Framework `InnerException` редко бывает `TimeoutException`. Шаблон различения из шага 1 работает только в .NET 5 и более поздних версиях. Если вы всё ещё на Framework, лучший сигнал -- сравнивать `ex.CancellationToken` с тем токеном, который вы передавали, и записывать прошедшее время до выбрасывания. Эргономика этого случая -- одна из лучших причин завершить миграцию с Framework скорее, чем позже.

### "An error occurred while sending the request", оборачивающее SocketException

Совершенно другой класс исключения (`HttpRequestException`), почти всегда транспортная проблема (DNS, TCP RST, сбой TLS-рукопожатия). В .NET 8+ свойство `ex.HttpRequestError` перечисляет причину: `ConnectionError`, `NameResolutionError`, `SecureConnectionError` и т. д. Решение лежит в DNS, файрволе или конфигурации сертификатов, а не в вашем коде.

### "The SSL connection could not be established"

Вложенное исключение -- `AuthenticationException` из `System.Net.Security`. Это сбой TLS-согласования, а не таймаут, хотя он может занимать несколько секунд и поверхностно выглядеть похоже. Проверьте цепочку сертификатов, хост SNI и версию протокола TLS (`SslProtocols.Tls12 | SslProtocols.Tls13` -- значение по умолчанию в .NET 11).

### "A connection attempt failed because the connected party did not properly respond"

`SocketException` с `ErrorCode == 10060` (WSAETIMEDOUT). Срабатывает, когда не приходит syn-ack. Обычно сброс на сетевом файрволе. Появляется в виде `TaskCanceledException` только тогда, когда обёртывающий `HttpClient.Timeout` короче, чем таймаут подключения на уровне ОС, в противном случае вы получаете `HttpRequestException`.

### "Request was forcibly aborted" через CancelPendingRequests

Вызов `HttpClient.CancelPendingRequests` отменяет все выполняющиеся запросы на этом клиенте, а не только один. Если ваше приложение переиспользует клиента, и один компонент вызывает `CancelPendingRequests`, ожидающий запрос каждого другого компонента упадёт с тем же `TaskCanceledException`. Это одна из самых веских причин использовать `IHttpClientFactory` вместо долгоживущего статического клиента. Типизированные клиенты фабрики на каждый вызов -- это короткоживущие фасады, поэтому случайный `CancelPendingRequests` затрагивает только вызывающего.

## Связанное

Полный шаблон отмены разобран в [руководстве по отмене длительной задачи](/ru/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/), где разобраны `CancellationToken`, `Task.WaitAsync` и форма со связанным токеном, использованная выше. В [руководстве по модульному тестированию HttpClient](/ru/2026/04/how-to-unit-test-code-that-uses-httpclient/) показано, как подделывать таймауты в тестах, чтобы ветки с таймаутами действительно проверялись. Для потоковых загрузок [статья про потоковую передачу из ASP.NET Core](/ru/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) описывает соответствующую серверную сторону с пробросом отмены. Если эти вызовы делают ваши фоновые рабочие процессы, в [руководстве по BackgroundService](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/) разобраны правила времени жизни и отмены, благодаря которым шаблон со связанным токеном остаётся корректным при остановке хоста.

## Источники

- [Свойство `HttpClient.Timeout`](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.httpclient.timeout), Microsoft Learn.
- [Перечисление `HttpCompletionOption`](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.httpcompletionoption), Microsoft Learn.
- [`SocketsHttpHandler.ConnectTimeout`](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.socketshttphandler.connecttimeout), Microsoft Learn.
- [Перечисление `HttpRequestError`](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.httprequesterror), Microsoft Learn.
- [HttpClient throws TaskCanceledException on timeout](https://github.com/dotnet/runtime/issues/21965), задача в dotnet/runtime.
- [How to identify HttpClient connect timeout errors?](https://github.com/dotnet/runtime/issues/78070), задача в dotnet/runtime.
- [Стандартный обработчик `Microsoft.Extensions.Http.Resilience`](https://learn.microsoft.com/en-us/dotnet/core/resilience/http-resilience), Microsoft Learn.
