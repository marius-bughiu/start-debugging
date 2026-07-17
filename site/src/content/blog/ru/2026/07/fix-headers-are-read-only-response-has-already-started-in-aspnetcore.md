---
title: "Исправление: System.InvalidOperationException: Headers are read-only, response has already started"
description: "Вы задали заголовок, код состояния или content type после того, как тело уже было сброшено. Задавайте все заголовки до первой записи или защищайтесь через HttpResponse.HasStarted и OnStarting."
pubDate: 2026-07-17
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "aspnetcore-11"
lang: "ru"
translationOf: "2026/07/fix-headers-are-read-only-response-has-already-started-in-aspnetcore"
translatedBy: "claude"
translationDate: 2026-07-17
---

Исправление: что-то уже записало в тело ответа, из-за чего заголовки были сброшены клиенту и стали доступны только для чтения, а затем ваш код попытался задать заголовок, код состояния или content type. В ASP.NET Core `HttpResponse.StatusCode`, `HttpResponse.ContentType` и всё, что находится в `HttpResponse.Headers`, должны быть заданы **до** того, как будет записан первый байт тела. Переместите все присваивания заголовков и состояния перед любым `WriteAsync`, `Redirect` или нижестоящим middleware, которое пишет тело. Когда вы не можете контролировать порядок, защитите присваивание через `if (!context.Response.HasStarted)` или зарегистрируйте работу в `HttpResponse.OnStarting`, чтобы она выполнилась в момент прямо перед сбросом заголовков. Это руководство написано для ASP.NET Core 11 (`Microsoft.AspNetCore.App` 11.0.0-preview.4), C# 14 и Kestrel 11.0.0-preview.4; поведение идентично вплоть до ASP.NET Core 3.0.

```text
System.InvalidOperationException: Headers are read-only, response has already started.
   at Microsoft.AspNetCore.Server.Kestrel.Core.Internal.Http.HttpResponseHeaders.ThrowHeadersReadOnlyException()
   at Microsoft.AspNetCore.Server.Kestrel.Core.Internal.Http.HttpHeaders.Microsoft.AspNetCore.Http.IHeaderDictionary.set_Item(String key, StringValues value)
   at MyApp.SecurityHeadersMiddleware.InvokeAsync(HttpContext context)
   at Microsoft.AspNetCore.Server.Kestrel.Core.Internal.Http.HttpProtocol.ProcessRequests[TContext](IHttpApplication`1 application)
```

Трассировка стека почти всегда заканчивается на `ThrowHeadersReadOnlyException` внутри Kestrel (или эквивалента в HTTP.sys и IIS). Кадр непосредственно над ним является строкой, которая попыталась выполнить мутацию. Этот кадр и есть виновник: он задаёт заголовок, `StatusCode`, `ContentType` или вызывает `Redirect` после того, как ответ уже начался.

## Почему задать заголовок после первой записи невозможно

HTTP упорядочен на проводе: строка состояния, затем заголовки, затем пустая строка, затем тело. Как только сервер отправил блок заголовков клиенту, он не может его отозвать. ASP.NET Core моделирует это, делая коллекцию заголовков доступной только для чтения в момент начала ответа, и выбрасывает исключение вместо того, чтобы молча отбросить ваше изменение, потому что молча проигнорированный заголовок безопасности или content type представляет собой куда более серьёзную ошибку, чем шумное исключение.

Две вещи запускают ответ. Документация говорит прямо: "An app can't modify headers after the response has started. Once the response starts, the headers are sent to the client. A response is started by flushing the response body or calling `HttpResponse.StartAsync(CancellationToken)`." Первая из них и кусает людей, потому что она неявна. Запись тела сбрасывает его: "Unless response buffering is enabled, all write operations (for example, `WriteAsync`) flush the response body internally and mark the response as started. Response buffering is disabled by default." Поэтому первый `WriteAsync`, первый `CopyToAsync` в `Response.Body`, первый `FlushAsync` на `Response.BodyWriter` и возврат результата, который стримит контент, переводят `HttpResponse.HasStarted` в `true` и замораживают заголовки.

Вот почему `HttpResponse.StatusCode`, `HttpResponse.ContentType` и `HttpResponse.Headers` каждый задокументированы как "Must be set before writing to the response body." Это не рекомендательные заметки. Это контракт, а исключение обеспечивает его соблюдение.

## Минимальное воспроизведение

Самая маленькая версия пишет тело, а затем пытается задать заголовок:

```csharp
// ASP.NET Core 11, C# 14
using Microsoft.AspNetCore.Builder;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapGet("/broken", async (HttpContext context) =>
{
    await context.Response.WriteAsync("Processing...");   // flushes: HasStarted is now true
    context.Response.Headers["X-Trace-Id"] = "abc123";     // throws: headers are read-only
});

app.Run();
```

Вызов `WriteAsync` сбрасывает тело и отправляет заголовки. Следующая строка пытается добавить `X-Trace-Id`, и Kestrel выбрасывает `InvalidOperationException: Headers are read-only, response has already started`. Та же форма появляется с кодом состояния:

```csharp
// ASP.NET Core 11, C# 14
app.MapGet("/broken-status", async (HttpContext context) =>
{
    await context.Response.WriteAsync("partial output");
    context.Response.StatusCode = 500;   // throws for the same reason
});
```

И она появляется с редиректом, потому что `Redirect` задаёт как заголовок `Location`, так и статус 302:

```csharp
// ASP.NET Core 11, C# 14
app.MapGet("/broken-redirect", async (HttpContext context) =>
{
    await context.Response.WriteAsync("about to redirect");
    context.Response.Redirect("/login");   // throws: Location header is read-only
});
```

## Переупорядочьте так, чтобы заголовки шли первыми

Основное исправление, к которому следует прибегать всякий раз, когда код под вашим контролем, состоит в том, чтобы задавать каждый заголовок, код состояния и content type до того, как что-либо записать в тело. В эндпоинте или контроллере это обычно перемещение одной строки:

```csharp
// ASP.NET Core 11, C# 14 -- correct order
app.MapGet("/fixed", async (HttpContext context) =>
{
    context.Response.StatusCode = 200;
    context.Response.ContentType = "text/plain";
    context.Response.Headers["X-Trace-Id"] = "abc123";   // set before any write

    await context.Response.WriteAsync("Processing...");  // now safe to flush
});
```

Предпочитайте возврат `IResult` (minimal APIs) или `IActionResult` (MVC) записи в `Response.Body` вручную. `Results.Text`, `Results.Json`, `Results.File` и `TypedResults` строят весь ответ, включая заголовки, и только затем пишут, поэтому они никогда не спотыкаются об эту ошибку. Обращение к [типизированному объединению Results из эндпоинта minimal API](/ru/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/) держит состояние и заголовки декларативными и полностью устраняет опасность ручного порядка.

## Защитите middleware через HasStarted

Более сложный случай представляет middleware, которое выполняет `await next(context)`, а затем хочет тронуть ответ. К моменту возврата `next` нижестоящий эндпоинт обычно уже записал тело, поэтому ответ начался, и любое изменение заголовка выбрасывает исключение. Это самый частый источник этой ошибки, а классическим нарушителем выступает middleware «security headers» или «correlation id», написанное так:

```csharp
// ASP.NET Core 11, C# 14 -- broken middleware
app.Use(async (context, next) =>
{
    await next(context);   // endpoint writes the body here; response starts
    context.Response.Headers["X-Frame-Options"] = "DENY";   // throws
});
```

Есть два правильных паттерна, и выбор зависит от того, должны ли вы задать заголовок безусловно.

**Зарегистрируйте работу в `OnStarting`.** `HttpResponse.OnStarting` принимает callback, который сервер выполняет ровно один раз, прямо перед сбросом заголовков, независимо от того, пишет ли тело ваше middleware или что-то нижестоящее. Зарегистрируйте его до вызова `next`, и заголовок будет записан в последний безопасный момент:

```csharp
// ASP.NET Core 11, C# 14 -- correct: set headers just before they flush
app.Use(async (context, next) =>
{
    context.Response.OnStarting(() =>
    {
        context.Response.Headers["X-Frame-Options"] = "DENY";
        context.Response.Headers["X-Content-Type-Options"] = "nosniff";
        return Task.CompletedTask;
    });

    await next(context);
});
```

Это правильный инструмент для сквозных заголовков ответа, потому что он работает даже тогда, когда нижестоящий код начинает стримить немедленно. Это тот же механизм, который собственное middleware заголовков ASP.NET Core использует внутри.

**Защитите через `HasStarted`.** Когда заголовок важен только в том случае, если ответ ещё не зафиксирован (например, обработчик исключений, который хочет превратить сбой в 500), сначала проверьте `HttpResponse.HasStarted` и пропустите мутацию, когда он `true`:

```csharp
// ASP.NET Core 11, C# 14 -- defensive guard
app.Use(async (context, next) =>
{
    try
    {
        await next(context);
    }
    catch (Exception)
    {
        if (!context.Response.HasStarted)
        {
            context.Response.Clear();
            context.Response.StatusCode = 500;
            await context.Response.WriteAsync("Something went wrong.");
        }
        throw;   // nothing safe to do if the response already started
    }
});
```

`HttpResponse.Clear()` сбрасывает код состояния, заголовки и любое буферизованное тело, но работает только пока `HasStarted` равен `false`. Как только тело начало стримиться, вы действительно ничего не можете сделать, чтобы изменить состояние или заголовки, и честный ход состоит в том, чтобы дать исключению распространиться или вызвать `HttpContext.Abort()`, чтобы разорвать соединение, чтобы клиент увидел сломанный ответ, а не ложь. Вот почему встроенный обработчик исключений и [глобальный фильтр исключений в ASP.NET Core 11](/ru/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) оба проверяют `HasStarted` перед записью тела problem-details и перебрасывают исключение, когда уже слишком поздно.

## Буферизуйте тело, когда middleware должно его переписать

Некоторому middleware действительно нужно прочитать или преобразовать нижестоящий ответ, минифицировать HTML, внедрить тег script или сжать контент, и только затем задать заголовок `Content-Length` или `Content-Encoding`. Вы не можете сделать это, если тело уже сброшено клиенту. Исправление состоит в том, чтобы подменить тело ответа буфером, дать нижестоящему коду писать в буфер, затем задать ваши заголовки и скопировать буфер в настоящее тело:

```csharp
// ASP.NET Core 11, C# 14 -- buffer downstream output, then set headers
app.Use(async (context, next) =>
{
    var originalBody = context.Response.Body;
    using var buffer = new MemoryStream();
    context.Response.Body = buffer;

    await next(context);   // downstream writes into the MemoryStream, not the socket

    // Response has NOT started: the real body was never touched.
    context.Response.Headers["Content-Length"] = buffer.Length.ToString();
    buffer.Position = 0;
    context.Response.Body = originalBody;
    await buffer.CopyToAsync(originalBody);
});
```

Поскольку нижестоящая запись пошла в `MemoryStream`, а не в соединение, `HasStarted` остаётся `false`, и присваивания заголовков успешны. Это ручная версия того, что делает middleware, преобразующее ответы; поддерживаемый framework-ом путь состоит в том, чтобы работать через `IHttpResponseBodyFeature`, а не присваивать `Response.Body` напрямую, но принцип буферизации тот же. Если ваша цель именно сжатие, не пишите это вручную: обратитесь к [сжатию ответов в ASP.NET Core 11 API](/ru/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/), которое берёт на себя согласование и заголовок `Content-Encoding` без буферизации всего ответа в памяти.

## Подводные камни и похожие ошибки

**`Response.Redirect` считается записью заголовка.** Редирект задаёт заголовок `Location` и статус 3xx, поэтому его вызов после любой записи тела выбрасывает именно это исключение. Если вы обнаружили, что перенаправляете изнутри действия, которое уже записало вывод, настоящая ошибка в том, что решение о перенаправлении было принято слишком поздно; переместите его перед первой записью.

**У стриминговых эндпоинтов крошечное окно для заголовков.** Когда вы [стримите файл из эндпоинта без буферизации](/2026/07/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/), ответ начинается в момент сброса первого чанка. Любой `Content-Disposition` или `Content-Type`, который вам нужен, должен быть задан до этого первого `WriteAsync`. Если ошибка возникает посреди стрима, вы не можете переключиться на 500, потому что блок заголовков 200 уже на проводе; соединение просто обрывается. Проектируйте стриминговые обработчики так, чтобы они валидировали всё и задавали все заголовки заранее.

**Это не ошибка синхронного I/O.** `Headers are read-only, response has already started` относится к *порядку*, а не к синхронности против асинхронности. Если ваше сообщение вместо этого гласит `Synchronous operations are disallowed`, это другая проблема с другим исправлением, разобранная в [InvalidOperationException: Synchronous operations are disallowed](/ru/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed). Не путайте их; смена `WriteAsync` на `Write` здесь не поможет, а переупорядочивание не поможет там.

**Blazor и Identity выявляют это косвенно.** Интерактивные компоненты Blazor и потоки ASP.NET Core Identity иногда вызывают это из кода framework-а, обычно когда компонент пытается задать cookie или перенаправить после начала рендера, или когда несоответствие render mode форсирует вывод до того, как выполнится аутентификация. Если трассировка стека указывает на рендер Blazor, а не на ваше собственное middleware, ищите `NavigationManager.NavigateTo` или запись cookie, происходящую после первого рендера, и смотрите [a render mode is not supported by the parent component's render mode](/ru/2026/06/fix-render-mode-is-not-supported-by-the-parent-components-render-mode-blazor) для соседней проблемы render mode.

**Порядок middleware решает, кто победит.** Middleware, задающее заголовки, работает только если оно регистрирует свой callback `OnStarting` или задаёт свои заголовки до того, как терминальное middleware запишет тело. Если ваше пользовательское middleware заголовков для путей, которые в него попадают, находится *после* `UseStaticFiles` или middleware эндпоинтов в конвейере, уже слишком поздно. Регистрируйте сквозное middleware ответа рано в `Program.cs`.

**Двойные записи на путях исключений.** Частым производственным триггером выступает код, который пишет ответ частичного успеха, затем натыкается на исключение, и внешний обработчик пытается перезаписать его ошибкой. Первая запись уже начала ответ. Валидируйте и собирайте всё, что может провалиться, до того как запишете первый байт, чтобы запись была последним, что делает обработчик, а не первым.

## Похожие материалы

- [Как добавить глобальный фильтр исключений в ASP.NET Core 11](/ru/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) показывает защиту через `HasStarted` в реальном обработчике исключений.
- [Как стримить файл из эндпоинта ASP.NET Core без буферизации](/2026/07/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) объясняет, когда именно стримящийся ответ фиксирует свои заголовки.
- [Как добавить сжатие ответов в ASP.NET Core 11 API](/ru/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/) представляет поддерживаемый способ преобразовать тело без ручной буферизации.
- [Как вернуть типизированное объединение Results из эндпоинта minimal API](/ru/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/) держит состояние и заголовки декларативными, чтобы порядок не мог пойти не так.
- [Исправление: InvalidOperationException: Synchronous operations are disallowed](/ru/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed) описывает другое InvalidOperationException, которое выглядит похоже, но им не является.

## Источники

- [Use HttpContext in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/use-http-context?view=aspnetcore-10.0), Microsoft Learn, для правила, что заголовки, `StatusCode` и `ContentType` должны быть заданы до записи, точного текста исключения и заметки о том, что `WriteAsync` сбрасывает и начинает ответ, потому что буферизация отключена по умолчанию.
- [HttpResponse.HasStarted](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.httpresponse.hasstarted), документация API .NET, об определении того, зафиксирован ли ответ.
- [HttpResponse.OnStarting](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.httpresponse.onstarting), документация API .NET, о регистрации работы, которая выполняется прямо перед сбросом заголовков.
- [Write custom ASP.NET Core middleware](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/middleware/write?view=aspnetcore-10.0), Microsoft Learn, о порядке конвейера, который определяет, кто пишет тело первым.
