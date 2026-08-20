---
title: "ASP.NET Core para de transformar 413 em 500 no UseExceptionHandler"
description: "Um PR integrado à main do dotnet/aspnetcore em 2026-08-19 faz o ExceptionHandlerMiddleware respeitar BadHttpRequestException.StatusCode em vez de sobrescrevê-lo com 500."
pubDate: 2026-08-20
tags:
  - "aspnetcore"
  - "dotnet"
  - "error-handling"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/08/aspnetcore-exception-handler-preserves-badhttprequestexception-status-codes"
translatedBy: "claude"
translationDate: 2026-08-20
---

Se você usa `app.UseExceptionHandler()` em produção, toda requisição que o Kestrel rejeita por ser grande demais vem aparecendo na sua telemetria como falha do servidor. O [PR #68632](https://github.com/dotnet/aspnetcore/pull/68632) entrou na `main` do `dotnet/aspnetcore` em 2026-08-19 e corrige isso. Ele fecha a [issue #43831](https://github.com/dotnet/aspnetcore/issues/43831), aberta em setembro de 2022.

## O 500 que na verdade era um 413

O `ExceptionHandlerMiddleware` define o código de status da resposta antes de invocar o seu handler e, até este PR, fixava 500 sempre que `ExceptionHandlerOptions.StatusCodeSelector` era null. A `BadHttpRequestException` carrega o próprio `StatusCode`, e esse valor era descartado.

O formato é este, verificado contra o ASP.NET Core 10.0.0 no SDK 10.0.201:

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

Faça um `POST` de 500 bytes para `/upload`. A exceção que chega ao middleware é `BadHttpRequestException` com `StatusCode = 413` e a mensagem "Request body too large. The max request body size is 100 bytes." A resposta que você realmente recebe é:

```
HTTP/1.1 500 Internal Server Error
Content-Type: application/problem+json

{"type":"https://tools.ietf.org/html/rfc9110#section-15.6.1",
 "title":"An error occurred while processing your request.","status":500,...}
```

O cliente é informado de que quebrou o servidor. Seus painéis de 5xx concordam. É a mesma classe de confusão por trás de [413 Request Entity Too Large ao enviar um arquivo](/pt-br/2026/07/fix-413-request-entity-too-large-uploading-a-file-in-aspnetcore-11/), só que aqui o status correto nunca chega à rede.

## O que mudou

Agora o middleware faz correspondência de padrões na exceção antes de cair no 500:

```csharp
context.Response.StatusCode = _options.StatusCodeSelector?.Invoke(edi.SourceException)
    ?? (edi.SourceException switch
    {
        BadHttpRequestException badHttpRequestException => badHttpRequestException.StatusCode,
        _ => DefaultStatusCode,
    });
```

Três detalhes que vale conhecer. O `StatusCodeSelector` continua tendo prioridade se você definir um, então sobrescritas existentes mantêm o comportamento. Delegates `ExceptionHandler` personalizados e serviços `IExceptionHandler` ainda podem alterar o código depois. E um 404 carregado por uma `BadHttpRequestException` passa a ser tratado como deliberado, e não como handler mal configurado, então não precisa mais de `AllowStatusCode404Response = true` para sobreviver.

O escopo é estreito de propósito: apenas `BadHttpRequestException` é remapeada. Chamar `Request.ReadFormAsync()` com um corpo `text/plain` lança `InvalidOperationException` ("Incorrect Content-Type"), e isso continua devolvendo 500 antes e depois. O model binding das minimal APIs também não é afetado, porque um corpo JSON malformado vira um 400 seco pelo request delegate antes que qualquer exceção escape.

No momento em que escrevo, o commit está apenas na `main`. Ele não está no branch `release/11.0-rc1`, então espere-o em um build posterior do .NET 11, e não no RC1. Se você está hoje no .NET 8 até 11, a alternativa continua sendo um `StatusCodeSelector` que desempacote a exceção por conta própria.
