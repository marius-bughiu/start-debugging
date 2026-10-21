---
title: "Исправление: HttpProtocolException: The HTTP/2 server reset the stream. HTTP/2 error code 'PROTOCOL_ERROR'"
description: "Удалённая сторона отправила RST_STREAM с PROTOCOL_ERROR для одного запроса, и HttpClient не повторяет его сам. Выясните, какой узел сбросил поток, исправьте отклонённый запрос, повторяйте только идемпотентные вызовы или переведите этот узел на HTTP/1.1."
pubDate: 2026-10-21
template: error-page
tags:
  - "errors"
  - "httpclient"
  - "http2"
  - "dotnet"
  - "dotnet-10"
lang: "ru"
translationOf: "2026/10/fix-the-http2-server-reset-the-stream-protocol-error-httpclient"
translatedBy: "claude"
translationDate: 2026-10-21
---

`HttpProtocolException: The HTTP/2 server reset the stream. HTTP/2 error code 'PROTOCOL_ERROR' (0x1)` означает, что другая сторона HTTP/2-соединения отправила для вашего запроса фрейм `RST_STREAM` с кодом ошибки 1. `HttpClient` ничего не сломал, он лишь сообщает то, что сказал собеседник, и сам никогда не повторяет запрос после `PROTOCOL_ERROR`. Исправление состоит в том, чтобы выяснить, какой узел отправил сброс (ваше приложение на Kestrel или прокси, балансировщик нагрузки либо sidecar перед ним), исправить то, что в этом конкретном запросе было отклонено, повторять идемпотентные запросы с помощью обработчика устойчивости (resilience handler) и, как крайнюю меру, использовать HTTP/1.1 на проблемном узле.

Всё ниже воспроизведено на .NET 10.0.10 (SDK 10.0.302, ASP.NET Core 10.0.10) с Kestrel и `HttpClient` в одном файловом приложении, а для раздела о повторах дополнительно использовался `Microsoft.Extensions.Http.Resilience` 10.0.0. Соответствующие участки кода одинаковы в .NET 8, 9 и 11.

## Ошибка в контексте

Если сброс приходит до заголовков ответа, `SendAsync` (или `GetAsync`, `PostAsync`) выбрасывает `HttpRequestException`, в которое обёрнуто `HttpProtocolException`:

```text
System.Net.Http.HttpRequestException: The HTTP/2 server reset the stream. HTTP/2 error code 'PROTOCOL_ERROR' (0x1). (HttpProtocolError)
 ---> System.Net.Http.HttpProtocolException: The HTTP/2 server reset the stream. HTTP/2 error code 'PROTOCOL_ERROR' (0x1). (HttpProtocolError)
   at System.Net.Http.Http2Connection.ThrowRequestAborted(Exception innerException)
   at System.Net.Http.Http2Connection.Http2Stream.CheckResponseBodyState()
   at System.Net.Http.Http2Connection.Http2Stream.TryEnsureHeaders()
   at System.Net.Http.Http2Connection.Http2Stream.ReadResponseHeadersAsync(CancellationToken cancellationToken)
   at System.Net.Http.Http2Connection.SendAsync(HttpRequestMessage request, Boolean async, CancellationToken cancellationToken)
   --- End of inner exception stack trace ---
   at System.Net.Http.Http2Connection.SendAsync(HttpRequestMessage request, Boolean async, CancellationToken cancellationToken)
   at System.Net.Http.HttpConnectionPool.SendWithVersionDetectionAndRetryAsync(HttpRequestMessage request, Boolean async, Boolean doRequestAuth, CancellationToken cancellationToken)
   at System.Net.Http.RedirectHandler.SendAsync(HttpRequestMessage request, Boolean async, CancellationToken cancellationToken)
```

Если сервер уже отправил код состояния, а сброс приходит во время чтения тела, внешнее сообщение меняется, но внутреннее исключение остаётся тем же:

```text
System.Net.Http.HttpRequestException: Error while copying content to a stream.
 ---> System.Net.Http.HttpProtocolException: The HTTP/2 server reset the stream. HTTP/2 error code 'PROTOCOL_ERROR' (0x1). (HttpProtocolError)
```

В обоих случаях `HttpRequestException.HttpRequestError` равно `HttpRequestError.HttpProtocolError`, а `HttpProtocolException.ErrorCode` равно `1`. Проверяйте в коде эти два свойства, а не текст сообщения.

Формулировка "the HTTP/2 server reset the stream" тоже важна, потому что у `SocketsHttpHandler` есть три разных сообщения об ошибках HTTP/2, и каждое указывает на свою проблему:

| Сообщение | Фрейм, полученный клиентом | Область действия |
| --- | --- | --- |
| `The HTTP/2 server reset the stream. HTTP/2 error code '...'` | `RST_STREAM` | Только этот один запрос |
| `The HTTP/2 server closed the connection. HTTP/2 error code '...'` | `GOAWAY` с ошибкой | Все потоки этого соединения |
| `The HTTP/2 server sent invalid data on the connection. HTTP/2 error code '...'` | нет, клиент сам обнаружил нарушение | Всё соединение целиком |

Этот пост посвящён первой строке. Если вы видите вторую или третью, проблема в самом соединении, и диагностика другая.

## Почему это происходит

`PROTOCOL_ERROR` это самый общий код из [RFC 9113, раздел 7](https://www.rfc-editor.org/rfc/rfc9113#section-7). Собеседник отправляет его как ошибку потока, когда один запрос (его заголовки, тело или фрейминг) нарушает какое-то правило, и нужно отклонить именно этот запрос, не разрывая общее соединение. Поэтому ошибка и выглядит случайной "под нагрузкой": одно HTTP/2-соединение несёт сотни параллельных запросов, сброс затрагивает только тот запрос, который не прошёл проверку, а остальные завершаются успешно. Чем больше трафика, тем больше запросов с редким свойством, которое срабатывает на проверке, поэтому доля сбоев растёт вместе с нагрузкой, хотя нагрузка не является причиной.

Причины, упорядоченные по тому, как часто они встречаются у .NET-клиента:

1. **Прокси по пути отклонил что-то в этом запросе.** Обратные прокси, service mesh, ingress-контроллеры и облачные балансировщики нагрузки завершают HTTP/2 и проверяют запросы по собственным правилам: недопустимые, по их мнению, символы в заголовках, многострочные значения заголовков, заголовки уровня соединения, ограничения на размер заголовков или тел. Реальные примеры: Envoy сбрасывает потоки с [некорректными символами в заголовках](https://github.com/envoyproxy/envoy/issues/7061), nginx завершает запрос с ошибкой из-за [многострочного значения заголовка](https://github.com/nginx/nginx/issues/540), ничего не записав в журнал, а сам Kestrel отклоняет [псевдозаголовки после обычных заголовков](https://github.com/dotnet/aspnetcore/issues/12190), присланные узлом Envoy.
2. **Тело запроса не совпало с `Content-Length`.** Kestrel сбрасывает поток с `PROTOCOL_ERROR`, когда получает больше или меньше байтов DATA, чем заявлено (`Http2StreamErrorMoreDataThanLength` и `Http2StreamErrorLessDataThanLength` в [`Http2Stream.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Servers/Kestrel/Core/src/Internal/Http2/Http2Stream.cs)). .NET `HttpClient` ловит собственное несоответствие раньше сервера (вы получите `Sent 5 request content bytes, but Content-Length promised 50.`), поэтому, когда Kestrel пишет такое в журнал, это обычно клиент не на .NET или прокси, который переписал тело и не исправил заголовок.
3. **Kestrel отклонил псевдозаголовки запроса.** Недопустимый `:method`, `:path`, несовпадение `:scheme`, неверный `Host`/`:authority` или некорректный extended CONNECT заканчиваются вызовом `ResetAndAbort(..., Http2ErrorCode.PROTOCOL_ERROR)` в Kestrel. `HttpClient` формирует эти заголовки сам, поэтому вы столкнётесь с этим только через прокси или самописного клиента.
4. **Код приложения сбросил поток.** Любой middleware или обработчик, вызывающий `IHttpResetFeature.Reset(1)`, даёт на клиенте именно эту ошибку. Это редкость, но некоторые шлюзы и перехватчики gRPC делают так намеренно, чтобы сигнализировать "некорректный запрос".

Одна вещь *обычно не* является причиной: .NET-клиент, отправляющий плохие заголовки прямо в Kestrel. В моём воспроизведении `TE: gzip`, `Connection: keep-alive` и пользовательский заголовок размером 300 КБ, отправленные по h2c в Kestrel 10.0.10, вернулись обычным `400 Bad Request`, а не сбросом. Если вы видите `PROTOCOL_ERROR` при обращении к бэкенду на Kestrel, в первую очередь подозревайте то, что стоит между клиентом и Kestrel.

## Минимальное воспроизведение

Самый простой способ воспроизвести именно это исключение: конечная точка Kestrel, которая сбрасывает собственный поток через `IHttpResetFeature`. С точки зрения клиента это байт в байт то же, что `RST_STREAM` от прокси.

```csharp
// .NET 10.0.10, C# 14. Run with: dotnet run repro.cs
#:sdk Microsoft.NET.Sdk.Web
#:property PublishAot=false
using System.Net;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Server.Kestrel.Core;

var hits = 0;
var builder = WebApplication.CreateBuilder();
builder.Logging.ClearProviders();
// h2c (HTTP/2 without TLS) needs an HTTP/2-only endpoint
builder.WebHost.ConfigureKestrel(k => k.ListenLocalhost(5199, o => o.Protocols = HttpProtocols.Http2));
var app = builder.Build();
app.MapGet("/reset/{code:int}", (HttpContext ctx, int code) =>
{
    Interlocked.Increment(ref hits);
    ctx.Features.Get<IHttpResetFeature>()!.Reset(code); // 1 = PROTOCOL_ERROR, 7 = REFUSED_STREAM
    return Results.Empty;
});
await app.StartAsync();

var client = new HttpClient
{
    DefaultRequestVersion = HttpVersion.Version20,
    DefaultVersionPolicy = HttpVersionPolicy.RequestVersionExact,
};

foreach (var code in new[] { 1, 7 })
{
    hits = 0;
    try { await client.GetAsync($"http://localhost:5199/reset/{code}"); }
    catch (HttpRequestException e) when (e.InnerException is HttpProtocolException p)
    {
        Console.WriteLine($"code {code}: {e.HttpRequestError}, ErrorCode={p.ErrorCode}, server hits={hits}");
        Console.WriteLine($"  outer: {e.Message}");
    }
}
await app.StopAsync();
```

Вывод:

```text
code 1: HttpProtocolError, ErrorCode=1, server hits=1
  outer: The HTTP/2 server reset the stream. HTTP/2 error code 'PROTOCOL_ERROR' (0x1). (HttpProtocolError)
code 7: HttpProtocolError, ErrorCode=7, server hits=4
  outer: The request was aborted.
```

Самое полезное здесь это значение `server hits`. Сброс `PROTOCOL_ERROR` доходит до сервера один раз и выбрасывается вам. Сброс `REFUSED_STREAM` `SocketsHttpHandler` повторяет сам, потому что RFC 9113 гарантирует, что собеседник не обработал отклонённый поток. Пул сдаётся после `MaxConnectionFailureRetries = 3` повторов, поэтому сервер увидел 4 попытки. Источник: [`Http2Stream.OnReset`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Net.Http/src/System/Net/Http/SocketsHttpHandler/Http2Stream.cs), где `canRetry` истинно только для `REFUSED_STREAM` и для потоков, которые `GOAWAY` пометил как необработанные.

## Исправление подробно

### 1. Выяснить, какой узел отправил сброс

Клиент не может сказать, кто отправил `RST_STREAM`. Он знает лишь, что фрейм пришёл от собеседника, с которым он соединён, то есть от первого HTTP/2-узла: часто это прокси, а не ваш сервис. Разберитесь с этим до изменения кода:

- **Включите отладочные журналы HTTP/2 в Kestrel на бэкенде.** Kestrel записывает каждый сброшенный им поток в категорию `Microsoft.AspNetCore.Server.Kestrel.Http2` на уровне `Debug`, с сообщениями вроде `HTTP/2 stream error "PROTOCOL_ERROR". A Reset is being sent to the stream.` (событие 35) и `HTTP/2 stream error.` (событие 30, с `Http2StreamErrorException`, содержащим точную причину, например `More data received than specified in the Content-Length header.`).

```json
// appsettings.Development.json, ASP.NET Core 10
{
  "Logging": {
    "LogLevel": {
      "Default": "Information",
      "Microsoft.AspNetCore.Server.Kestrel.Http2": "Debug",
      "Microsoft.AspNetCore.Server.Kestrel.BadRequests": "Debug"
    }
  }
}
```

- **Если Kestrel ничего не пишет о сбойном запросе, сброс пришёл от посредника.** Посмотрите в журнале доступа прокси за этот интервал времени. Envoy отмечает сбросы в флагах ответа и в деталях `upstream_reset_before_response_started`, nginx пишет проблемы с заголовками на уровне `info` в журнал ошибок (поднимите `error_log` до `info`, чтобы их увидеть), а облачные балансировщики обычно показывают код причины для каждого запроса.
- **Один раз обойдите прокси.** Обратитесь к бэкенду напрямую (port-forward, внутренний адрес) с тем же запросом. Если ошибка исчезла, вы доказали, какой узел виноват.

### 2. Исправить запрос, который узел отклонил

Когда вы знаете, какой узел и какое правило, исправление обычно в запросе, а не в транспорте. Журналируйте метод, путь, имена заголовков, длины значений заголовков и размер тела для сбойных запросов (но никогда не значения заголовков авторизации) и сравнивайте их с успешными. Обычные подозреваемые:

- Значения заголовков с символами вне видимого ASCII, со встроенными переводами строк или с пробелами в начале и конце, часто это пользовательский ввод, скопированный в собственный заголовок. `HttpClient` блокирует CR, LF и NUL, но строгие прокси отклоняют больше.
- Заголовки, имеющие смысл только в HTTP/1.1 (`Connection`, `Keep-Alive`, `Proxy-Connection`, `Transfer-Encoding`, `Upgrade` и `TE` с любым значением, кроме `trailers`). `HttpClient` позволяет добавить их через `TryAddWithoutValidation`, а посредникам разрешено сбросить поток, который их несёт.
- Запрос больше лимитов прокси: большие cookie, JWT с множеством claims, большие тела на прокси с маленькими буферами. Это классические сбои "только у некоторых пользователей".
- Собственный `HttpContent`, который задаёт `Headers.ContentLength`, а затем записывает другое число байтов, или фильтр прокси, который сжимает либо переписывает тело. Аналог этого не в .NET это прямой `PROTOCOL_ERROR` от Kestrel.

### 3. Повторять, но только безопасные для повторения запросы

Когда сброс исходит от инфраструктуры, которую вы не контролируете, добавьте повтор. Сброс `PROTOCOL_ERROR` не говорит, обработал ли сервер запрос (прокси может сбросить поток после пересылки), поэтому ограничьте повторы идемпотентными методами. С помощью `Microsoft.Extensions.Http.Resilience`:

```csharp
// .NET 10, Microsoft.Extensions.Http.Resilience 10.0.0
using System.Net;
using Microsoft.Extensions.Http.Resilience;
using Polly;

builder.Services.AddHttpClient("api", c =>
    {
        c.BaseAddress = new Uri("https://api.internal");
        c.DefaultRequestVersion = HttpVersion.Version20;
    })
    .AddResilienceHandler("h2-reset", pipeline =>
    {
        var retry = new HttpRetryStrategyOptions
        {
            MaxRetryAttempts = 2,
            Delay = TimeSpan.FromMilliseconds(50),
            ShouldHandle = args => ValueTask.FromResult(
                args.Outcome.Exception is HttpRequestException { HttpRequestError: HttpRequestError.HttpProtocolError }),
        };
        retry.DisableForUnsafeHttpMethods(); // never replay POST, PUT, PATCH, DELETE, CONNECT
        pipeline.AddRetry(retry);
    });
```

На конечной точке, которая сбрасывает первую попытку и успешно отвечает на вторую, `GET` через этот клиент вернул `ok on attempt 2 via HTTP/2`, а `POST` по-прежнему выбросил исходный `PROTOCOL_ERROR` после единственного обращения к серверу. Если вы уже используете `AddStandardResilienceHandler`, его `ShouldHandle` по умолчанию считает `HttpRequestException` временной ошибкой и тоже покрывает этот случай, но он повторяет все методы, пока вы не вызовете `DisableForUnsafeHttpMethods()` для `options.Retry`. Учтите, что `DisableForUnsafeHttpMethods` возвращает `void`, поэтому вызывайте его на объекте опций до передачи в `AddRetry`, а не в цепочке вызовов.

### 4. Перевести проблемный узел на HTTP/1.1

Если сброс исходит от посредника с ошибочной или слишком строгой реализацией HTTP/2 и вы не можете его исправить или обновить, уберите HTTP/2 с этого участка. На клиенте:

```csharp
// .NET 10: ask for HTTP/1.1 for this client only
var client = new HttpClient
{
    DefaultRequestVersion = HttpVersion.Version11,
    DefaultVersionPolicy = HttpVersionPolicy.RequestVersionOrLower,
};
```

В HTTP/1.1 потока, который можно сбросить, нет: та же конечная точка, что сбрасывала поток по HTTP/2, в воспроизведении ответила `ok on attempt 2 via HTTP/1.1`. Вы теряете мультиплексирование, поэтому под нагрузкой ожидайте больше соединений, а gRPC так сделать не сможет вообще, потому что ему требуется HTTP/2. Считайте это обходным путём с заведённым обращением к разработчикам прокси, а не исправлением.

## Подводные камни и варианты

- **`REFUSED_STREAM` похож, но это другая проблема.** Внешнее сообщение `The request was aborted.`, внутри него `HttpProtocolException` с `REFUSED_STREAM`, и вы видите его только после того, как обработчик уже повторил запрос 3 раза. Это значит, что сервер или прокси отказывается принимать новые потоки, обычно потому, что достиг лимита параллельных потоков или завершает работу. Посмотрите `SETTINGS_MAX_CONCURRENT_STREAMS` на сервере и подумайте о `SocketsHttpHandler.EnableMultipleHttp2Connections = true`.
- **`HTTP_1_1_REQUIRED` на локальной точке h2c.** Если вы настроили Kestrel с `HttpProtocols.Http1AndHttp2` на обычном `http://` и принудительно включили HTTP/2 на клиенте, вы получите `The HTTP/2 server closed the connection. HTTP/2 error code 'HTTP_1_1_REQUIRED' (0xd).` Без TLS нет ALPN для согласования протокола, поэтому для h2c нужна конечная точка только с `Http2`.
- **Сбросы посреди тела при `ResponseHeadersRead`.** Когда вы читаете ответ потоком сами, код состояния (часто `200`) уже возвращён к моменту прихода сброса. Не считайте успешный статус доказательством того, что тело полное. Чтение выбросит `Error while copying content to a stream.` либо сам `HttpProtocolException` (без обёртки `HttpRequestException`) из `ReadAsync` потока ответа.
- **Обработчики устойчивости не могут повторить сброс посреди тела.** Конвейер обработчиков возвращается, как только приходят заголовки ответа, а тело `HttpClient` буферизует уже после этого. Поэтому сброс во время тела обходит повтор из шага 3, даже при `ResponseContentRead` по умолчанию. Если тело важно, оберните всю операцию "отправить и прочитать" в собственный повтор для идемпотентных вызовов.
- **Собеседник закрыл соединение вместо сброса.** Если внутреннее исключение это `HttpIOException` с `ResponseEnded`, а не `HttpProtocolException`, соединение умерло без HTTP/2-фрейма. Это семейство проблем keep-alive и таймаута простоя, разобранное в [исправлении "the response ended prematurely"](/ru/2026/09/fix-httpioexception-the-response-ended-prematurely-httpclient/).
- **Таймауты это не сбросы.** Если вызов зависает, а затем падает с `TaskCanceledException`, поток никто не сбрасывал. Начните с [того, почему HttpClient выбрасывает "A task was canceled"](/ru/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/).

## Связанные материалы

- [Fix: HttpIOException "The response ended prematurely" in HttpClient](/ru/2026/09/fix-httpioexception-the-response-ended-prematurely-httpclient/) разбирает родственную ошибку уровня соединения.
- [Polly vs resilience handlers in .NET 11](/ru/2026/05/polly-vs-resilience-handlers-in-dotnet-11/) объясняет, где в этой схеме место повтора выше и как устроен стандартный обработчик.
- [HttpClient vs IHttpClientFactory vs Refit](/ru/2026/05/httpclient-vs-httpclientfactory-vs-refit/) показывает, как настроить именованный клиент, который используется в этом посте.
- [Fix: The SSL connection could not be established](/ru/2026/06/fix-the-ssl-connection-could-not-be-established-with-httpclient/) поможет, если сбой происходит ещё до согласования HTTP/2.
- [gRPC in containers: 4 traps you can fix](/ru/2026/01/grpc-in-containers-feels-hard-in-net-9-and-net-10-4-traps-you-can-fix/) разбирает проблемы транспорта только на HTTP/2, которые gRPC добавляет сверху.

## Источники

- [RFC 9113, HTTP/2: error codes (section 7) and stream errors (section 5.4.2)](https://www.rfc-editor.org/rfc/rfc9113#section-7)
- [`HttpProtocolException` class, Microsoft Learn](https://learn.microsoft.com/dotnet/api/system.net.http.httpprotocolexception)
- [`HttpProtocolException.cs`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Net.Http/src/System/Net/Http/HttpProtocolException.cs) и [`Http2Stream.cs`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Net.Http/src/System/Net/Http/SocketsHttpHandler/Http2Stream.cs) в dotnet/runtime v10.0.0
- [Kestrel `Http2Stream.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Servers/Kestrel/Core/src/Internal/Http2/Http2Stream.cs) и [`KestrelTrace.Http2.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Servers/Kestrel/Core/src/Internal/Infrastructure/KestrelTrace.Http2.cs) в dotnet/aspnetcore v10.0.0
- [Build resilient HTTP apps, Microsoft Learn](https://learn.microsoft.com/dotnet/core/resilience/http-resilience)
- [envoyproxy/envoy#7061](https://github.com/envoyproxy/envoy/issues/7061), [nginx/nginx#540](https://github.com/nginx/nginx/issues/540), [dotnet/aspnetcore#12190](https://github.com/dotnet/aspnetcore/issues/12190)
