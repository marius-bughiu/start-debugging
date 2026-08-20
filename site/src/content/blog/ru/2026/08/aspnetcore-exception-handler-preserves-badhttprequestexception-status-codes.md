---
title: "ASP.NET Core перестаёт превращать 413 в 500 в UseExceptionHandler"
description: "PR, влитый в main репозитория dotnet/aspnetcore 2026-08-19, заставляет ExceptionHandlerMiddleware учитывать BadHttpRequestException.StatusCode вместо перезаписи его значением 500."
pubDate: 2026-08-20
tags:
  - "aspnetcore"
  - "dotnet"
  - "error-handling"
  - "dotnet-11"
lang: "ru"
translationOf: "2026/08/aspnetcore-exception-handler-preserves-badhttprequestexception-status-codes"
translatedBy: "claude"
translationDate: 2026-08-20
---

Если вы используете `app.UseExceptionHandler()` в продакшене, каждый запрос, который Kestrel отклоняет из-за слишком большого размера, попадает в вашу телеметрию как отказ сервера. [PR #68632](https://github.com/dotnet/aspnetcore/pull/68632) попал в ветку `main` репозитория `dotnet/aspnetcore` 2026-08-19 и исправляет это. Он закрывает [issue #43831](https://github.com/dotnet/aspnetcore/issues/43831), заведённый в сентябре 2022 года.

## Тот самый 500, который на самом деле был 413

`ExceptionHandlerMiddleware` устанавливает код состояния ответа до вызова вашего обработчика, и до этого PR он жёстко подставлял 500, когда `ExceptionHandlerOptions.StatusCodeSelector` был равен null. `BadHttpRequestException` несёт собственный `StatusCode`, и это значение отбрасывалось.

Вот как это выглядит, проверено на ASP.NET Core 10.0.0 с SDK 10.0.201:

```csharp
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddProblemDetails();
builder.WebHost.ConfigureKestrel(k => k.Limits.MaxRequestBodySize = 100);

var app = builder.Build();
app.UseExceptionHandler();

app.MapPost("/upload", async (HttpContext ctx) =>
{
    using var ms = new MemoryStream();
    await ctx.Request.Body.CopyToAsync(ms);   // throws when the body exceeds 100 bytes
    return Results.Ok(ms.Length);
});

app.Run();
```

Отправьте `POST` с 500 байтами на `/upload`. До middleware доходит исключение `BadHttpRequestException` со `StatusCode = 413` и сообщением "Request body too large. The max request body size is 100 bytes." А реально вы получаете такой ответ:

```
HTTP/1.1 500 Internal Server Error
Content-Type: application/problem+json

{"type":"https://tools.ietf.org/html/rfc9110#section-15.6.1",
 "title":"An error occurred while processing your request.","status":500,...}
```

Клиенту сообщают, что он сломал сервер. Ваши дашборды по 5xx с этим согласны. Это та же путаница, что стоит за [413 Request Entity Too Large при загрузке файла](/ru/2026/07/fix-413-request-entity-too-large-uploading-a-file-in-aspnetcore-11/), только здесь корректный статус вообще не доходит до сети.

## Что изменилось

Теперь middleware сначала выполняет сопоставление с образцом по исключению и лишь затем откатывается к 500:

```csharp
context.Response.StatusCode = _options.StatusCodeSelector?.Invoke(edi.SourceException)
    ?? (edi.SourceException switch
    {
        BadHttpRequestException badHttpRequestException => badHttpRequestException.StatusCode,
        _ => DefaultStatusCode,
    });
```

Три детали, которые стоит знать. `StatusCodeSelector` по-прежнему имеет приоритет, если вы его задали, так что существующие переопределения сохраняют своё поведение. Пользовательские делегаты `ExceptionHandler` и сервисы `IExceptionHandler` всё так же могут изменить код позже. А 404, который несёт `BadHttpRequestException`, теперь трактуется как намеренный, а не как признак неправильно настроенного обработчика, поэтому ему больше не нужен `AllowStatusCode404Response = true`, чтобы уцелеть.

Область действия намеренно узкая: переназначается только `BadHttpRequestException`. Вызов `Request.ReadFormAsync()` с телом `text/plain` бросает `InvalidOperationException` ("Incorrect Content-Type"), и это возвращает 500 и до, и после изменения. Привязка модели в minimal API тоже не затронута, потому что некорректное тело JSON превращается request delegate в голый 400 ещё до того, как какое-либо исключение вырвется наружу.

На момент написания коммит есть только в `main`. В ветку `release/11.0-rc1` он не входит, так что ждите его в более поздней сборке .NET 11, а не в RC1. Если сегодня вы на .NET 8 или вплоть до 11, обходной путь прежний: `StatusCodeSelector`, который сам разбирает исключение.
