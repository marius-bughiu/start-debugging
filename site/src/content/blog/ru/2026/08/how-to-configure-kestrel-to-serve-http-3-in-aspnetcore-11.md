---
title: "Как настроить Kestrel для работы по HTTP/3 в ASP.NET Core 11"
description: "Полное руководство по включению HTTP/3 в Kestrel в ASP.NET Core 11: настройка конечной точки через HttpProtocols.Http1AndHttp2AndHttp3, требования MsQuic к платформе в Windows, Linux и macOS, почему первый запрос никогда не идёт по HTTP/3, проверка через HttpClient и middleware, настройка QuicTransportOptions и проблемы с firewall и прокси, из-за которых происходит тихий откат."
pubDate: 2026-08-02
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "kestrel"
  - "http-3"
  - "performance"
lang: "ru"
translationOf: "2026/08/how-to-configure-kestrel-to-serve-http-3-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-08-02
---

Чтобы отдавать HTTP/3 из Kestrel, нужно настроить HTTPS-конечную точку со свойством `listenOptions.Protocols = HttpProtocols.Http1AndHttp2AndHttp3`. Это вся поверхность API. Всё, что ломается дальше, относится к окружению: на хосте нет MsQuic, UDP заблокирован на порту, обратный прокси завершает соединение до того, как QUIC доходит до вас, либо вы тестируете браузером, который отказывается принимать сертификат разработки по HTTP/3. Kestrel не выбрасывает исключение ни в одном из этих случаев. Он отключает HTTP/3, продолжает отдавать HTTP/1.1 и HTTP/2, и вывод `curl` выглядит ровно так же, как до ваших правок.

Всё изложенное рассчитано на .NET 11 (проверено на Preview 6, SDK `11.0.100-preview.6.26359.118`) с `Microsoft.NET.Sdk.Web` и C# 14. HTTP/3 в Kestrel полностью поддерживается с .NET 7, поэтому приведённая ниже конфигурация без изменений работает на .NET 8, 9 и 10. Единственная по-настоящему новая часть в .NET 11 - это раннее начало обработки запросов, о котором сказано в конце.

## Шесть шагов от начала до конца

1. Настройте HTTPS-конечную точку и задайте `Protocols` значение `HttpProtocols.Http1AndHttp2AndHttp3`.
2. Убедитесь, что на хосте есть MsQuic, то есть Windows 11 либо Windows Server 2022 или новее, либо пакет `libmsquic` в Linux.
3. Откройте UDP-порт с тем же номером, что и ваш TLS-порт, на всех firewall и группах безопасности по пути следования трафика.
4. Добавьте проверку при старте, которая громко пишет в журнал, если `QuicListener.IsSupported` возвращает false, чтобы отсутствующая зависимость превращалась в строку журнала, а не в загадку.
5. Проверяйте через `HttpClient` с закреплённой версией 3.0, а не через браузер.
6. Логируйте `HttpContext.Request.Protocol` в middleware, чтобы видеть, о чём клиенты договорились на самом деле в продакшене.

Остальная часть статьи посвящена тому, как выполнить каждый из этих шагов правильно, а не просто добиться компиляции кода.

## Настройка конечной точки

Никаких пакетов NuGet ставить не нужно. Транспорт QUIC, `Microsoft.AspNetCore.Server.Kestrel.Transport.Quic`, входит в общий фреймворк ASP.NET Core. Изменить нужно только то, как объявляется конечная точка:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Server.Kestrel.Core;

var builder = WebApplication.CreateBuilder(args);

builder.WebHost.ConfigureKestrel((context, options) =>
{
    options.ListenAnyIP(5001, listenOptions =>
    {
        listenOptions.Protocols = HttpProtocols.Http1AndHttp2AndHttp3;
        listenOptions.UseHttps();
    });
});

var app = builder.Build();

app.MapGet("/ping", (HttpContext ctx) => new { protocol = ctx.Request.Protocol });

app.Run();
```

Две детали в этом фрагменте делают реальную работу. `UseHttps()` не опционален: HTTP/3 обязательно требует TLS 1.3, поэтому конечная точка без него никогда не сможет договориться о h3. И значение перечисления - `Http1AndHttp2AndHttp3`, а не `Http3`. По умолчанию Kestrel использует `Http1AndHttp2`, а значение с тремя протоколами - это то, что вам нужно в продакшене, потому что не каждый маршрутизатор, корпоративный прокси или мобильный оператор пропускает QUIC без проблем. `HttpProtocols.Http3` сам по себе даёт конечную точку без пути отката: на хосте, где MsQuic недоступен, Kestrel отключает HTTP/3, и этой конечной точке нечего отдавать.

Тот же параметр доступен из конфигурации, и обычно это более подходящее для него место, потому что так HTTP/3 можно включать по окружениям без пересборки:

```json
{
  "Kestrel": {
    "Endpoints": {
      "Https": {
        "Url": "https://*:5001",
        "Protocols": "Http1AndHttp2AndHttp3"
      }
    }
  }
}
```

Есть также `Kestrel:EndpointDefaults:Protocols`, если вы хотите применить настройку ко всем конечным точкам. Учитывайте правило приоритета, на котором здесь спотыкаются: явный вызов `Listen` или `ListenAnyIP` внутри `ConfigureKestrel` переопределяет `ASPNETCORE_URLS`, `--urls` и `applicationUrl` из `launchSettings.json`. Kestrel пишет предупреждение, когда это происходит ("Overriding address(es)"), и если его пропустить, вы потратите вечер на выяснение, почему приложение больше не слушает порт 7043. Выберите один механизм, а не оба сразу.

## Что MsQuic требует на каждой платформе

ASP.NET Core не реализует QUIC самостоятельно. `System.Net.Quic` привязывается к [MsQuic](https://github.com/microsoft/msquic), и матрица поддерживаемых платформ целиком наследуется от этой нативной библиотеки.

В **Windows** файл `msquic.dll` поставляется в составе среды выполнения .NET, поэтому устанавливать ничего не нужно, но операционная система должна быть Windows 11 либо Windows Server 2022 или новее. В более ранних версиях Windows нет криптографических API, которые нужны QUIC, и никакой конфигурацией это не обойти. Это самая частая причина, по которой HTTP/3 не включается на корпоративной площадке, всё ещё работающей на Windows Server 2019.

В **Linux** пакет `libmsquic` нужно установить самостоятельно. Он публикуется в репозитории пакетов Microsoft на `packages.microsoft.com`, а также присутствует в репозитории community у Alpine:

```bash
# Debian / Ubuntu, after adding the packages.microsoft.com repo
sudo apt-get install libmsquic

# Alpine 3.21 and later
sudo apk add libmsquic
```

.NET 7 и новее требуют libmsquic версии 2.2 или выше. Ветка 1.9.x, к которой был привязан .NET 6, несовместима, поэтому если вы тянете старый Dockerfile из проекта на .NET 6, проверьте, какую версию вы ставите. Отсюда же следует, что обычный образ контейнера `mcr.microsoft.com/dotnet/aspnet` **не** умеет HTTP/3 из коробки: пакет нужно добавить в собственный слой образа. Если вы собираете образы через `dotnet publish /t:PublishContainer`, это дополнительный `RUN`, который нельзя выразить одними лишь свойствами контейнера в SDK, и вам понадобится Dockerfile.

В **macOS** поддержка частичная и неофициальная. Можно выполнить `brew install libmsquic`, но среда выполнения не найдёт библиотеку, пока вы не укажете динамическому загрузчику префикс Homebrew:

```bash
DYLD_FALLBACK_LIBRARY_PATH=$DYLD_FALLBACK_LIBRARY_PATH:$(brew --prefix)/lib dotnet run
```

Считайте это удобством для локальной разработки, а не поддерживаемой продакшен-конфигурацией.

## Как сделать тихий откат громким

Поведение Kestrel с откатом - правильное значение по умолчанию для веб-сервера и худшее из возможных для отладки. Если MsQuic отсутствует, HTTP/3 отключается, а приложение стартует как обычно. Ничто в стандартном выводе журнала на уровне `Information` вам об этом не сообщит.

Решение - проверка из трёх строк при старте, обращённая к тому же свойству `IsSupported`, которое предоставляет `System.Net.Quic`:

```csharp
// .NET 11, C# 14
using System.Net.Quic;

var app = builder.Build();

if (!QuicListener.IsSupported)
{
    app.Logger.LogWarning(
        "QUIC is not supported on this host. HTTP/3 is disabled and Kestrel " +
        "will serve HTTP/1.1 and HTTP/2 only. Check for libmsquic and TLS 1.3 support.");
}
```

`QuicListener.IsSupported` возвращает false по двум важным причинам: нативная библиотека отсутствует либо TLS 1.3 недоступен. Используйте `QuicListener.IsSupported` на стороне сервера и `QuicConnection.IsSupported` на стороне клиента. Сейчас они возвращают одно и то же значение, но документированная рекомендация - проверять то свойство, которое соответствует вашей роли.

Если нужны подробности, поднимите категорию Kestrel до уровня `Debug` и понаблюдайте за привязкой:

```json
{
  "Logging": {
    "LogLevel": {
      "Microsoft.AspNetCore.Server.Kestrel": "Debug"
    }
  }
}
```

## Почему ваш первый запрос никогда не идёт по HTTP/3

Именно из-за этого люди решают, что конфигурация сломана, хотя она работает идеально.

Клиент не может узнать, что сервер говорит по HTTP/3, до подключения, потому что нет ни DNS-записи, ни расширения TLS, которые бы об этом объявляли. Обнаружение происходит через заголовок ответа [`alt-svc`](https://developer.mozilla.org/docs/Web/HTTP/Headers/Alt-Svc): клиент выполняет первый запрос по HTTP/1.1 или HTTP/2, видит заголовок с указанием конечной точки h3 и использует QUIC для последующих запросов к этому источнику. Kestrel добавляет этот заголовок автоматически, как только HTTP/3 включён на конечной точке, так что в первом ответе вы увидите примерно следующее:

```text
HTTP/2 200
alt-svc: h3=":5001"
```

Поэтому тест из одного запроса всегда покажет HTTP/2. Любое измерение должно выполнять как минимум два запроса через один и тот же экземпляр клиента, и клиент должен учитывать `alt-svc`.

IIS - исключение, о котором стоит знать. При хостинге за IIS HTTP/3 поддерживается в модели in-process, но IIS не добавляет `alt-svc` за вас. Добавляйте его сами, в начале конвейера:

```csharp
// .NET 11, C# 14 - only needed when hosting behind IIS
app.Use((context, next) =>
{
    context.Response.Headers.AltSvc = "h3=\":443\"";
    return next(context);
});
```

Кроме того, IIS нужны Windows Server 2022 или Windows 11, привязка `https` и установленный ключ реестра `EnableHttp3`. И учтите, что при хостинге out-of-process `HttpRequest.Protocol` возвращает `HTTP/1.1` даже на соединении HTTP/3, потому что именно по этому протоколу IIS проксирует запросы в Kestrel. Только модель in-process возвращает `HTTP/3`.

## Как убедиться, что всё действительно работает

Не используйте браузер. Браузеры отказываются принимать самоподписанные сертификаты по HTTP/3, включая сертификат разработки ASP.NET Core, поэтому локальный тест в браузере будет вечно показывать HTTP/2 и ничего вам не скажет.

Используйте `HttpClient` с закреплённой версией. Для теста нужен `RequestVersionExact`, потому что он падает громко, а не понижает версию молча:

```csharp
// .NET 11, C# 14
using System.Net;

using var client = new HttpClient
{
    DefaultRequestVersion = HttpVersion.Version30,
    DefaultVersionPolicy = HttpVersionPolicy.RequestVersionExact
};

var response = await client.GetAsync("https://localhost:5001/ping");

Console.WriteLine($"status: {response.StatusCode}, version: {response.Version}");
// status: OK, version: 3.0
```

В коде приложения нужна противоположная политика. Задайте версию 1.1 вместе с `HttpVersionPolicy.RequestVersionOrHigher`, чтобы клиент поднимался до HTTP/3, когда сервер это объявляет, и корректно понижался, когда нет. Закрепление `RequestVersionExact` в продакшене превращает сетевой сбой в жёсткий отказ, что близко к [ошибкам рукопожатия TLS, которые проявляются как "The SSL connection could not be established"](/ru/2026/06/fix-the-ssl-connection-could-not-be-established-with-httpclient/).

На сервере источник истины - одна строка middleware:

```csharp
// .NET 11, C# 14
app.Use(async (context, next) =>
{
    app.Logger.LogInformation("Request served over {Protocol}", context.Request.Protocol);
    await next(context);
});
```

`HttpContext.Request.Protocol` для QUIC-соединения равно строке `"HTTP/3"`. Если вы хотите ветвиться по этому значению, `HttpProtocol.IsHttp3(context.Request.Protocol)` из `Microsoft.AspNetCore.Http` избавляет от жёстко зашитого литерала. Публиковать это как измерение метрики в течение недели после выката - единственный честный способ узнать, какая доля вашего трафика реально ушла на h3, и обычно она ниже, чем вы ожидаете.

## Настройка QuicTransportOptions

У транспорта есть собственный объект параметров, который настраивается через `UseQuic` на web host builder, а не через `ConfigureKestrel`:

```csharp
// .NET 11, C# 14
builder.WebHost.UseQuic(options =>
{
    options.MaxBidirectionalStreamCount = 200;
    options.MaxUnidirectionalStreamCount = 20;
});
```

Значения по умолчанию: `MaxBidirectionalStreamCount` 100, `MaxUnidirectionalStreamCount` 10, `MaxReadBufferSize` 1 МБ, `MaxWriteBufferSize` 64 КБ и `Backlog` 512. Пересмотреть стоит именно число двунаправленных потоков: оно ограничивает количество одновременных запросов на соединение, а поскольку в QUIC нет блокировки начала очереди, клиент, который раньше открыл бы несколько соединений HTTP/2, теперь может протолкнуть всё через одно. Если перед вами разговорчивое одностраничное приложение или gRPC-клиент, 100 может стать потолком.

Если вы скопировали пример, где этот блок обёрнут в `#pragma warning disable CA2252`, это наследие времён, когда `System.Net.Quic` поставлялся как предварительная возможность. Эти API стали стабильными в .NET 9, так что прагму обычно можно убрать.

## Проблемы, которые отнимают больше всего времени

**UDP не открыт.** QUIC работает поверх UDP на том же номере порта, что и ваша TLS-конечная точка. Каждый firewall, каждая группа безопасности и каждый балансировщик нагрузки по пути должны разрешать входящий UDP на этом порту, а большинство стандартных шаблонов открывают только TCP. Это причина номер один для "у меня на машине работает, а в Azure нет".

**Что-то перед вами завершает соединение.** Если между клиентом и Kestrel стоит балансировщик уровня 7, ingress-контроллер или CDN, HTTP/3 нужно включать *там*, а участок от этого прокси до Kestrel часто в любом случае идёт по HTTP/1.1. Включение h3 в Kestrel за прокси, который не пробрасывает QUIC, не меняет вообще ничего.

**Некоторые перегрузки `UseHttps` несовместимы.** Когда в игре HTTP/3, `HandshakeTimeout` и `OnAuthenticate` в `HttpsConnectionAdapterOptions` не делают ничего, а перегрузки `UseHttps`, принимающие `ServerOptionsSelectionCallback` с таймаутом рукопожатия либо `TlsHandshakeCallbackOptions`, выбрасывают исключение. Если вы динамически выбираете сертификат по имени хоста, проверьте этот путь до включения h3.

**Вы измеряете не то.** Выигрыш HTTP/3 - это меньше циклов рукопожатия и отсутствие блокировки начала очереди при потере пакетов. На соединении с низкой задержкой и без потерь между двумя машинами в одном центре обработки данных он будет выглядеть так же, как HTTP/2, а бенчмарк на loopback не покажет ничего. Измеряйте в реальной мобильной сети или в сети с потерями, либо не измеряйте вовсе. Размер ответа по-прежнему определяет большую часть бюджета задержки любого API, и именно поэтому [сжатие ответов](/ru/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/) обычно даёт больший и более дешёвый выигрыш, чем смена версии протокола.

## Что изменилось в .NET 11

До .NET 11 Kestrel ждал получения управляющего потока QUIC от партнёра и его начального кадра `SETTINGS`, прежде чем передать в обработку хотя бы один поток запроса. Это стоило примерно одного дополнительного логического цикла на каждом новом соединении, то есть ровно в том сценарии, где HTTP/3 должен обыгрывать уже прогретое соединение HTTP/2. В .NET 11 Kestrel передаёт потоки запросов в обработку сразу по прибытии и применяет настройки партнёра, когда управляющий поток догоняет. Настраивать нечего, изменений в коде обработчиков не требуется: это изменение поведения на уровне протокола, которое вы получаете при обновлении, и подробнее оно разобрано в статье про [раннюю обработку запросов HTTP/3 в Kestrel](/ru/2026/04/aspnetcore-11-kestrel-http3-early-request-processing/).

Помнить стоит одно: Kestrel по-прежнему учитывает итоговое значение `SETTINGS_MAX_FIELD_SECTION_SIZE` от партнёра, прежде чем сериализовать заголовки ответа. Держите заголовки ответа на первом запросе небольшими, и вы получите полный эффект.

Если вы поднимаете новый сервис и решаете, какую часть хоста настраивать явно, параметр протокола - одна из немногих ручек, которая склоняет к собственноручно собранному хосту вместо стандартного; компромиссы разобраны в сравнении [CreateBuilder, CreateSlimBuilder и CreateEmptyBuilder](/ru/2026/07/webapplication-createbuilder-vs-createslimbuilder-vs-createemptybuilder-in-aspnetcore-11/).

## Связанные статьи

- [Kestrel начинает обрабатывать запросы HTTP/3 до кадра SETTINGS в .NET 11](/ru/2026/04/aspnetcore-11-kestrel-http3-early-request-processing/)
- [Как добавить сжатие ответов в API на ASP.NET Core 11](/ru/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/)
- [Fix: The SSL connection could not be established при использовании HttpClient](/ru/2026/06/fix-the-ssl-connection-could-not-be-established-with-httpclient/)
- [Как опубликовать приложение .NET 11 как образ контейнера через dotnet publish /t:PublishContainer](/ru/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/)
- [WebApplication.CreateBuilder vs CreateSlimBuilder vs CreateEmptyBuilder в ASP.NET Core 11](/ru/2026/07/webapplication-createbuilder-vs-createslimbuilder-vs-createemptybuilder-in-aspnetcore-11/)

## Источники

- [Use HTTP/3 with the ASP.NET Core Kestrel web server](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/servers/kestrel/http3), Microsoft Learn
- [Configure endpoints for the ASP.NET Core Kestrel web server](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/servers/kestrel/endpoints), Microsoft Learn
- [QUIC support in .NET, platform dependencies](https://learn.microsoft.com/en-us/dotnet/fundamentals/networking/quic/quic-overview#platform-dependencies), Microsoft Learn
- [Use HTTP/3 with HttpClient](https://learn.microsoft.com/en-us/dotnet/core/extensions/httpclient-http3), Microsoft Learn
- [Use ASP.NET Core with HTTP/3 on IIS](https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/iis/http3), Microsoft Learn
- [RFC 9114: HTTP/3](https://www.rfc-editor.org/rfc/rfc9114), IETF
- [RFC 9000: QUIC, a UDP-based multiplexed and secure transport](https://www.rfc-editor.org/rfc/rfc9000), IETF
- [microsoft/msquic](https://github.com/microsoft/msquic), GitHub
