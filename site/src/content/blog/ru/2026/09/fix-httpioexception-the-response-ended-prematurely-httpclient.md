---
title: "Исправление: HttpIOException: The response ended prematurely от HttpClient в .NET"
description: "HttpClient повторно использует keep-alive соединение, которое сервер только что закрыл, или сервер обрывает соединение посреди ответа. Сделайте PooledConnectionIdleTimeout меньше таймаута простоя сервера и повторяйте только идемпотентные запросы."
pubDate: 2026-09-24
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "httpclient"
  - "networking"
lang: "ru"
translationOf: "2026/09/fix-httpioexception-the-response-ended-prematurely-httpclient"
translatedBy: "claude"
translationDate: 2026-09-24
---

`HttpIOException: The response ended prematurely. (ResponseEnded)` означает, что TCP-соединение закрылось раньше, чем `HttpClient` получил полный HTTP-ответ. Самая частая причина: гонка keep-alive. `HttpClient` отправляет запрос по соединению из пула в тот самый момент, когда сервер закрывает его из-за простоя. Установите `SocketsHttpHandler.PooledConnectionIdleTimeout` заметно ниже таймаута простоя сервера (или балансировщика нагрузки) и повторяйте `ResponseEnded` только для запросов, которые безопасно отправить дважды. Если ошибка возникает на каждом запросе, вы обращаетесь не туда: `http://` на HTTPS-порт или проброс порта Docker, за которым никто не слушает.

Всё, что описано ниже, воспроизведено на .NET 10.0.10 (SDK 10.0.302) и .NET 11 RC 1 (SDK 11.0.100-rc.1.26425.128) с небольшими серверами на сырых сокетах, которые нарочно ведут себя неправильно. Обе среды выполнения дали побайтово одинаковые результаты.

## Ошибка в контексте

Исключение, которое вы видите в месте вызова, почти всегда является `HttpRequestException`, оборачивающим `HttpIOException`:

```text
System.Net.Http.HttpRequestException: An error occurred while sending the request.
 ---> System.Net.Http.HttpIOException: The response ended prematurely. (ResponseEnded)
   at System.Net.Http.HttpConnection.SendAsync(HttpRequestMessage request, Boolean async, CancellationToken cancellationToken)
   --- End of inner exception stack trace ---
   at System.Net.Http.HttpConnection.SendAsync(HttpRequestMessage request, Boolean async, CancellationToken cancellationToken)
   at System.Net.Http.HttpConnectionPool.SendWithVersionDetectionAndRetryAsync(HttpRequestMessage request, Boolean async, Boolean doRequestAuth, CancellationToken cancellationToken)
   at System.Net.Http.RedirectHandler.SendAsync(HttpRequestMessage request, Boolean async, CancellationToken cancellationToken)
   at System.Net.Http.HttpClient.<SendAsync>g__Core|83_0(HttpRequestMessage request, HttpCompletionOption completionOption, CancellationTokenSource cts, Boolean disposeCts, CancellationTokenSource pendingRequestsCts, CancellationToken originalCancellationToken)
```

Существует три варианта сообщения, и по тому, какой из них вы получили, видно, на каком этапе оборвалось соединение:

| Внешнее сообщение | Внутреннее сообщение | Что это значит |
| --- | --- | --- |
| `An error occurred while sending the request.` | `The response ended prematurely. (ResponseEnded)` | EOF до того, как пришёл хотя бы один байт строки статуса |
| `Error while copying content to a stream.` | `The response ended prematurely. (ResponseEnded)` | Заголовки пришли, тело оборвалось (буферизованное чтение) |
| нет, `HttpIOException` выбрасывается напрямую | `The response ended prematurely, with at least 90 additional bytes expected. (ResponseEnded)` | Тело оборвалось, пока вы сами читали поток |

Соединения HTTP/2 добавляют четвёртый: `The response ended prematurely while waiting for the next frame from the server.` Начиная с .NET 8, `HttpRequestException.HttpRequestError` и `HttpIOException.HttpRequestError` в каждом из этих случаев равны `HttpRequestError.ResponseEnded`, и именно это ваш код должен проверять вместо разбора строк сообщений.

## Почему это происходит

`SocketsHttpHandler` выбрасывает `ResponseEnded` всякий раз, когда чтение из сокета возвращает 0 байт (корректный FIN с другой стороны), а он всё ещё ожидает данные. В исходниках это две строки в `HttpConnection.cs`: пустой буфер чтения после отправки запроса или `bytesRead == 0` внутри `FillAsync`. Ничто в .NET не решало завершиться ошибкой. Соединение закрыла другая сторона. Вопрос в том, почему, и вот причины в порядке частоты:

1. **Гонка keep-alive.** Сервер (или прокси, или облачный балансировщик нагрузки) закрывает простаивающие соединения через N секунд. `HttpClient` по умолчанию держит простаивающие соединения 60 секунд. Если N меньше, рано или поздно запрос уходит по соединению, которое сервер закрывает именно в этот момент. Это нерегулярная версия, которая "работает в 99% случаев".
2. **Реально никто не слушает.** Docker Desktop, `kubectl port-forward`, SSH-туннели и некоторые обратные прокси сами принимают TCP-соединение, а затем закрывают его, если бэкенда нет. Вы получаете `ResponseEnded` вместо `Connection refused`.
3. **Неверный протокол на порту.** Отправка обычного `http://` на порт, работающий только по TLS (частая путаница в `launchSettings.json` у Kestrel), приводит к тому, что сервер проваливает рукопожатие и закрывает сокет.
4. **Сервер упал или сдался посреди ответа.** Процесс, который умирает во время потоковой передачи, прокси, упёршийся в ограничение по размеру или времени, или обработчик, выставивший `Content-Length` больше, чем он записывает. Это даёт варианты, возникающие на этапе тела.

## Минимальное воспроизведение

Это приложение из одного файла запускает сырой TCP-сервер, который отвечает на первый запрос в каждом соединении и закрывает соединение, не отвечая на второй. Именно так выглядит срабатывание таймаута простоя на стороне сервера во время вашего запроса.

```csharp
// .NET 10.0.10, C# 14. Run with: dotnet run repro.cs
using System.Net;
using System.Net.Sockets;
using System.Text;

var listener = new TcpListener(IPAddress.Loopback, 0);
listener.Start();
int port = ((IPEndPoint)listener.LocalEndpoint).Port;
int connections = 0;

_ = Task.Run(async () =>
{
    while (true)
    {
        var tcp = await listener.AcceptTcpClientAsync();
        int connectionId = Interlocked.Increment(ref connections);
        _ = Task.Run(async () =>
        {
            using (tcp)
            {
                var stream = tcp.GetStream();
                for (int requestNo = 1; ; requestNo++)
                {
                    if (!await ReadRequestAsync(stream)) return;
                    Console.WriteLine($"  server: connection {connectionId}, request {requestNo}");
                    if (requestNo == 2) return; // idle timeout fires: close, no response
                    await stream.WriteAsync("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"u8.ToArray());
                }
            }
        });
    }
});

using var client = new HttpClient();
foreach (var method in new[] { HttpMethod.Get, HttpMethod.Post })
{
    for (int i = 1; i <= 2; i++)
    {
        try
        {
            using var request = new HttpRequestMessage(method, $"http://127.0.0.1:{port}/");
            if (method == HttpMethod.Post) request.Content = new StringContent("{}");
            using var response = await client.SendAsync(request);
            Console.WriteLine($"{method} #{i}: {await response.Content.ReadAsStringAsync()}");
        }
        catch (HttpRequestException ex)
        {
            Console.WriteLine($"{method} #{i}: {ex.HttpRequestError} / {ex.InnerException?.Message}");
        }
    }
}

// Reads one request: headers up to the blank line, then Content-Length bytes of body.
static async Task<bool> ReadRequestAsync(NetworkStream stream)
{
    var data = new List<byte>();
    var buffer = new byte[8192];
    int headerEnd;
    while ((headerEnd = Encoding.ASCII.GetString(data.ToArray()).IndexOf("\r\n\r\n")) < 0)
    {
        int read = await stream.ReadAsync(buffer);
        if (read == 0) return false;
        data.AddRange(buffer.AsSpan(0, read));
    }
    var headers = Encoding.ASCII.GetString(data.ToArray(), 0, headerEnd);
    var lengthLine = headers.Split("\r\n")
        .FirstOrDefault(h => h.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase));
    int remaining = (lengthLine is null ? 0 : int.Parse(lengthLine[15..])) - (data.Count - headerEnd - 4);
    while (remaining > 0)
    {
        int read = await stream.ReadAsync(buffer);
        if (read == 0) return false;
        remaining -= read;
    }
    return true;
}
```

Вывод на .NET 10.0.10 и .NET 11 RC 1:

```text
  server: connection 1, request 1
GET #1: ok
  server: connection 1, request 2
  server: connection 2, request 1
GET #2: ok
  server: connection 2, request 2
POST #1: ResponseEnded / The response ended prematurely. (ResponseEnded)
  server: connection 3, request 1
POST #2: ok
```

Посмотрите на строки сервера. `GET #2` тоже попал на мёртвое соединение (connection 1, request 2), и `SocketsHttpHandler` молча отправил его заново по совершенно новому соединению 2. Затем `POST #1` повторно использовал соединение 2, был оборван тем же способом и выбросил исключение. Обработчик повторно отправляет неудавшийся запрос, только если тот ушёл по повторно используемому соединению из пула и не имел тела либо его тело было придержано через `Expect: 100-continue` (флаг `_canRetry` в `HttpConnection.SendAsync`). `POST` с содержимым никогда не отправляется повторно, потому что обработчик не может знать, успел ли сервер его обработать. Поэтому в журналах эта ошибка появляется для ваших операций записи и почти никогда для операций чтения.

## Исправление 1: держите простаивающие соединения меньше, чем сервер

Надёжное исправление для нерегулярной версии: сделать так, чтобы `HttpClient` выбрасывал простаивающее соединение раньше, чем это сделает сервер. Найдите самый короткий таймаут простоя на пути: сам сервис, любой обратный прокси и балансировщик нагрузки. Некоторые реальные значения по умолчанию:

- Kestrel `KeepAliveTimeout`: 130 секунд, больше, чем значение по умолчанию у клиента, поэтому связка .NET с .NET работает без настройки.
- Node.js 26 `http.Server`: `keepAliveTimeout` 5 секунд, `keepAliveTimeoutBuffer` 1 секунда.
- uvicorn: `--timeout-keep-alive` 5 секунд. Gunicorn: `keepalive` 2 секунды.
- AWS Application Load Balancer: таймаут простоя 60 секунд, столько же, сколько значение по умолчанию у клиента, из-за чего гонка возможна на каждом соединении, простоявшем около минуты.

Затем настройте обработчик ниже этого числа. С `IHttpClientFactory`:

```csharp
// .NET 10, Microsoft.Extensions.Http 10.0.12
builder.Services.AddHttpClient<OrdersClient>(c => c.BaseAddress = new Uri("https://orders.internal/"))
    .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler
    {
        // Server or load balancer closes idle connections after 60s (AWS ALB default).
        PooledConnectionIdleTimeout = TimeSpan.FromSeconds(30),
        // Also recycle connections so DNS changes are picked up.
        PooledConnectionLifetime = TimeSpan.FromMinutes(5),
    });
```

Оставляйте реальный запас. `PooledConnectionIdleTimeout` не проверяется, когда соединение берётся из пула. Его применяет фоновый таймер очистки, который срабатывает каждые `PooledConnectionIdleTimeout / 4`, но не чаще раза в секунду (`HttpConnectionPoolManager.cs`). Поэтому соединение может прожить примерно до 1.25 от настроенного таймаута простоя, а для малых значений до таймаута простоя плюс одна секунда. Половина таймаута сервера: безопасное правило.

Что действительно проверяется при взятии из пула, так это собственный заголовок ответа сервера `Keep-Alive: timeout=N`. `HttpConnection.PrepareForReuse` вызывает `CheckKeepAliveTimeoutExceeded()` и отбрасывает соединение, если оно простаивало N секунд или дольше, как на HTTP/1.1, так и на 1.0. Поэтому сервисы на Node.js редко вызывают эту ошибку: Node объявляет `timeout=5`, а фактически закрывает через 6. Если сервер ваш, отправка заголовка `Keep-Alive` со значением меньше реального таймаута становится исправлением, которое защищает всех клиентов, а не только .NET.

Я измерил все три варианта на сервере, который закрывает соединения ровно через 2000 мс простоя, с клиентом, отправляющим `POST` каждые 1990-2010 мс (по 150 запросов, .NET 10.0.10):

| Конфигурация клиента/сервера | Успешно | `ResponseEnded` |
| --- | --- | --- |
| По умолчанию (`PooledConnectionIdleTimeout` 60 s) | 147 | 3 |
| `PooledConnectionIdleTimeout = 800 ms` | 150 | 0 |
| Сервер отправляет `Keep-Alive: timeout=1` | 150 | 0 |

Три сбоя из 150: именно это делает ошибку такой неприятной в продакшене. Она достаточно редка, чтобы пройти все тесты, и достаточно часта, чтобы кого-то разбудить ночью. Чаще всего FIN от сервера приходит раньше следующего запроса, и `PrepareForReuse` видит закрытое соединение и тихо открывает новое. Ошибка проявляется, только когда закрытие попадает в те несколько миллисекунд между этой проверкой и отправкой запроса. Оба исправления полностью её устранили. Таймаут простоя 800 мс работает, потому что очистка (при такой настройке она выполняется каждую секунду) удаляет соединения до срабатывания серверного таймаута в 2000 мс. Заголовок работает, потому что клиент синхронно проверяет его при каждом взятии из пула.

## Исправление 2: повторяйте `ResponseEnded`, но только когда вторая попытка безопасна

Таймауты уменьшают гонку, но не могут её устранить: сервер всё равно может перезапуститься, уменьшить число экземпляров или оборвать соединение по своим причинам. Поэтому считайте `ResponseEnded` временной ошибкой, с одним условием. Сервер мог получить и обработать запрос до того, как закрыл сокет. Мой сервер для воспроизведения прочитал полное тело каждого запроса, который затем оборвал. Для `POST`, создающего заказ, слепой повтор может создать два заказа.

`AddStandardResilienceHandler()` не делает это различие за вас. Его `ShouldHandle` по умолчанию (`HttpClientResiliencePredicates.IsTransient`) считает любой `HttpRequestException` временной ошибкой для любого HTTP-метода. Либо вызовите `options.Retry.DisableForUnsafeHttpMethods()`, либо напишите предикат, который повторяет небезопасные методы, только если запрос несёт ключ идемпотентности, по которому сервер устраняет дубликаты:

```csharp
// .NET 10, Microsoft.Extensions.Http.Resilience 10.10.0
builder.Services.AddHttpClient<OrdersClient>()
    .AddResilienceHandler("stale-connection", pipeline => pipeline.AddRetry(new HttpRetryStrategyOptions
    {
        MaxRetryAttempts = 1,
        Delay = TimeSpan.Zero, // a new connection is all we need, no backoff
        ShouldHandle = args => ValueTask.FromResult(
            args.Outcome.Exception is HttpRequestException { HttpRequestError: HttpRequestError.ResponseEnded }
            && args.Context.GetRequestMessage() is { } request
            && (request.Method == HttpMethod.Get
                || request.Method == HttpMethod.Put
                || request.Method == HttpMethod.Delete
                || request.Headers.Contains("Idempotency-Key"))),
    }));
```

И в месте вызова:

```csharp
// .NET 10
using var request = new HttpRequestMessage(HttpMethod.Post, "orders") { Content = JsonContent.Create(order) };
request.Headers.Add("Idempotency-Key", order.ClientRequestId.ToString());
using var response = await http.SendAsync(request, ct);
```

На сервере для воспроизведения (который обрывает второй запрос в каждом соединении) три `POST` с этим обработчиком вернули `200 ok`, со вторым и третьим было по одному повтору. Сервер увидел пять запросов по трём соединениям, и в этом суть: два оборванных запроса до него действительно дошли. Если ваш повтор находится в `DelegatingHandler`, учитывайте, [где этот обработчик выполняется относительно цикла повторов](/ru/2026/09/fix-delegatinghandler-not-running-on-each-retry-with-addstandardresiliencehandler/), и прочитайте [Polly против встроенных обработчиков устойчивости](/ru/2026/05/polly-vs-resilience-handlers-in-dotnet-11/), если выбираете между этими двумя API.

## Исправление 3: когда сбой происходит на каждом запросе

Стабильный `ResponseEnded` на первом запросе только что запущенного процесса не является гонкой. Моя проверка дала абсолютно одинаковое исключение в обоих этих случаях:

**`http://` на TLS-конечную точку.** Сервер, который говорит только по TLS, получает `GET / HTTP/1.1` как мусорный ClientHello, проваливает рукопожатие и закрывает соединение. Сверьте схему и порт с `launchSettings.json` (профиль Kestrel по умолчанию слушает порт `https` и порт `http`, и их легко перепутать) или с `ASPNETCORE_URLS`. Обратная ошибка, `https://` на обычный HTTP-порт, вместо этого даёт [the SSL connection could not be established](/ru/2026/06/fix-the-ssl-connection-could-not-be-established-with-httpclient/).

**Слушатель, за которым ничего нет.** Docker публикует порты через собственный прокси. Если приложение внутри контейнера слушает `localhost` вместо `0.0.0.0` (для ASP.NET Core это исправляет `ASPNETCORE_URLS=http://+:8080`) или упало, прокси принимает ваше соединение и сразу его закрывает. Выполните `curl -v http://localhost:8080/` с той же машины. Если curl сообщает `Empty reply from server`, проблема не в вашем коде на .NET.

## Исправление 4: когда обрывается тело

Если внешнее сообщение `Error while copying content to a stream.` или вы сами читаете поток и видите `with at least N additional bytes expected`, значит, строка статуса и заголовки пришли, а соединение закрылось на середине тела. Ответ нужно искать в журналах на стороне сервера:

- Вышестоящий процесс упал или был убит (OOM, вытеснение пода, развёртывание) во время потоковой передачи.
- Прокси обрезал ответ по ограничению размера или длительности. nginx `proxy_read_timeout`, ограничение ответа CDN или лимит полезной нагрузки API-шлюза заканчиваются именно так.
- Сервер объявил `Content-Length` больше, чем записал байт. Обычно это middleware, изменившее тело (сжатие, перезапись) после установки заголовка. .NET точно сообщает недостачу: 90 байт в моём воспроизведении, где заголовок указывал 100, а сервер отправил 10.
- Ответ с chunked-кодированием закончился без завершающего чанка нулевой длины, что тоже даёт вариант `copying content`.

Повторять запрос с обрезанным телом безопасно только по тем же правилам идемпотентности, что и в исправлении 2, потому что сервер этот запрос точно обработал.

## Подводные камни и похожие ошибки

**`HttpRequestError` существует только в .NET 8 и новее.** В .NET 6 и 7 внутреннее исключение представляет собой обычный `IOException` с сообщением `The response ended prematurely.`, и перечисления для проверки нет. Поведение keep-alive и все исправления выше те же.

**`Connection reset by peer` это та же гонка, только на шаг позже.** Если сервер закрывает сокет, в буфере приёма которого остались непрочитанные данные запроса, ядро отправляет RST вместо FIN, и вы получаете `HttpRequestException`, оборачивающий `IOException: Unable to read data from the transport connection: Connection reset by peer` (`An existing connection was forcibly closed by the remote host` в Windows). Исправления идентичны.

**`PooledConnectionIdleTimeout = TimeSpan.Zero` отключает пул.** Это действительно делает гонку невозможной, и в моей проверке падающий `POST` стал успешным, но тогда каждый запрос платит за новое TCP- (и TLS-) рукопожатие. Используйте это только для диагностики: если ошибка с этой настройкой исчезает, вы подтвердили гонку keep-alive.

**`TaskCanceledException` это другой сбой.** Запрос, упёршийся в `HttpClient.Timeout`, заканчивается ошибкой [a task was canceled](/ru/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/), а не `ResponseEnded`. Если вы видите обе, сервер, вероятно, медленный, а что-то перед ним закрывает соединения, которые ждут слишком долго.

**Создание нового `HttpClient` на каждый запрос не исправляет ошибку.** Оно скрывает гонку keep-alive, поскольку соединения никогда не используются повторно, и меняет её на исчерпание сокетов под нагрузкой. В статье [HttpClient vs HttpClientFactory vs Refit](/ru/2026/05/httpclient-vs-httpclientfactory-vs-refit/) описаны правила времени жизни, которые действительно работают.

## Связанные материалы

- [Исправление: TaskCanceledException: A task was canceled с HttpClient](/ru/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/), аналог этой ошибки для таймаутов.
- [Исправление: The SSL connection could not be established](/ru/2026/06/fix-the-ssl-connection-could-not-be-established-with-httpclient/), для путаницы со схемой в обратную сторону.
- [Почему DelegatingHandler не выполняется при каждом повторе с AddStandardResilienceHandler](/ru/2026/09/fix-delegatinghandler-not-running-on-each-retry-with-addstandardresiliencehandler/).
- [Polly против обработчиков устойчивости в .NET 11](/ru/2026/05/polly-vs-resilience-handlers-in-dotnet-11/).
- [Как писать модульные тесты для кода, использующего HttpClient](/ru/2026/04/how-to-unit-test-code-that-uses-httpclient/), если вам нужен тест, выбрасывающий `HttpRequestException` с `HttpRequestError.ResponseEnded`, чтобы покрыть ваш предикат повтора.

## Источники

- [`HttpConnection.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Net.Http/src/System/Net/Http/SocketsHttpHandler/HttpConnection.cs) (`SendAsync`, `FillAsync`, `PrepareForReuse`, `CheckKeepAliveTimeoutExceeded`) и [`HttpConnectionPoolManager.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Net.Http/src/System/Net/Http/SocketsHttpHandler/HttpConnectionPoolManager.cs) (период очистки) в ветке `release/10.0` репозитория dotnet/runtime.
- [`ContentLengthReadStream.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Net.Http/src/System/Net/Http/SocketsHttpHandler/ContentLengthReadStream.cs) и [строковые ресурсы System.Net.Http](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Net.Http/src/Resources/Strings.resx) с точными текстами сообщений.
- [Перечисление `HttpRequestError`](https://learn.microsoft.com/dotnet/api/system.net.http.httprequesterror) и [`SocketsHttpHandler.PooledConnectionIdleTimeout`](https://learn.microsoft.com/dotnet/api/system.net.http.socketshttphandler.pooledconnectionidletimeout) на Microsoft Learn.
- [Рекомендации по HttpClient для .NET](https://learn.microsoft.com/dotnet/fundamentals/networking/http/httpclient-guidelines), о времени жизни соединений в пуле и повторном использовании клиента.
- [`HttpClientResiliencePredicates.cs`](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Http.Resilience/Polly/HttpClientResiliencePredicates.cs) и [`HttpRetryStrategyOptionsExtensions.cs`](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Http.Resilience/Polly/HttpRetryStrategyOptionsExtensions.cs) в dotnet/extensions.
- [Node.js `server.keepAliveTimeout`](https://nodejs.org/api/http.html#serverkeepalivetimeout) и [таймаут простоя соединения AWS ALB](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html#connection-idle-timeout).
