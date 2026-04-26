---
title: "Как добавить глобальный фильтр исключений в ASP.NET Core 11"
description: "Полное руководство по глобальной обработке исключений в ASP.NET Core 11: почему IExceptionFilter — неподходящий инструмент, как IExceptionHandler и UseExceptionHandler работают вместе, ответы ProblemDetails, цепочки из нескольких обработчиков и ломающее изменение в .NET 10 о подавлении диагностики."
pubDate: 2026-04-26
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "error-handling"
lang: "ru"
translationOf: "2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-04-26
---

Чтобы перехватывать каждое необработанное исключение в приложении ASP.NET Core 11 и превращать его в чистый HTTP-ответ, реализуйте `IExceptionHandler`, зарегистрируйте его через `services.AddExceptionHandler<T>()` и поместите `app.UseExceptionHandler()` в начало конвейера middleware. Старый `IExceptionFilter` из MVC срабатывает только для действий контроллеров, поэтому он пропускает endpoint минимальных API, исключения из middleware, ошибки model binding и всё, что выброшено до запуска MVC. Подход на основе обработчиков заменяет его в рамках всего конвейера, интегрируется с `ProblemDetails` для ответов RFC 7807 и одинаково работает на Native AOT, минимальных API и контроллерах. Всё в этом руководстве ориентируется на .NET 11 (preview 3) с `Microsoft.NET.Sdk.Web` и C# 14, но API стабильно с .NET 8, и шаблоны применимы без изменений в .NET 9 и .NET 10.

## "Фильтр исключений" — это поисковый запрос, но он почти никогда вам не нужен

Когда разработчики спрашивают, как добавить «глобальный фильтр исключений», верхний результат поисковой выдачи обычно — ответ на Stack Overflow 2017 года, указывающий на `IExceptionFilter` и `MvcOptions.Filters.Add<T>`. Этот код всё ещё компилируется и всё ещё работает, но он не является правильным ответом начиная с ASP.NET Core 8.

`IExceptionFilter` находится в `Microsoft.AspNetCore.Mvc.Filters`. Он часть конвейера MVC, что означает три вещи:

1. Он перехватывает только исключения, выброшенные внутри MVC-действия, MVC-фильтра или исполнителя результата. Всё, что выброшено раньше в конвейере (ошибки model binding, сбои аутентификации, маршрутные 404), его никогда не достигает.
2. Он не видит исключения из endpoint минимальных API (`app.MapGet("/", ...)`). Минимальные API не проходят через `MvcRoutedActionInvoker`, поэтому MVC-фильтры для них молчат.
3. Он запускается после того, как model binding уже произвёл ошибку в `ModelState`, поэтому некорректное тело запроса возвращает 400 от фреймворка прежде, чем ваш фильтр увидит исключение, которое вы хотели транслировать.

Современный эквивалент — `IExceptionHandler`, появившийся в `Microsoft.AspNetCore.Diagnostics` 8.0 и неизменный в .NET 11. Он работает изнутри middleware `UseExceptionHandler`, расположенного в самом верху конвейера, поэтому один обработчик в одном месте покрывает контроллеры, минимальные API, gRPC, согласование SignalR, статические файлы и исключения, выброшенные middleware. Это и имеют в виду, когда говорят «глобально».

Остальная часть этого руководства — путь `IExceptionHandler`. Последний раздел рассматривает редкие случаи, когда MVC-фильтр всё ещё является правильным инструментом.

## Минимальный IExceptionHandler

`IExceptionHandler` — это интерфейс с одним методом:

```csharp
// .NET 11, C# 14
namespace Microsoft.AspNetCore.Diagnostics;

public interface IExceptionHandler
{
    ValueTask<bool> TryHandleAsync(
        HttpContext httpContext,
        Exception exception,
        CancellationToken cancellationToken);
}
```

Возвращайте `true`, если вы записали ответ и хотите, чтобы middleware остановился. Возвращайте `false`, чтобы передать управление следующему обработчику в цепочке (или, если ни один не обработал, дефолтному ответу об ошибке от фреймворка).

Рабочий обработчик «трансляция любого исключения в 500 с JSON-телом» занимает около 30 строк:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

internal sealed class GlobalExceptionHandler(
    ILogger<GlobalExceptionHandler> logger,
    IProblemDetailsService problemDetailsService) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(
        HttpContext httpContext,
        Exception exception,
        CancellationToken cancellationToken)
    {
        logger.LogError(exception, "Unhandled exception on {Path}", httpContext.Request.Path);

        httpContext.Response.StatusCode = StatusCodes.Status500InternalServerError;

        return await problemDetailsService.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = httpContext,
            Exception = exception,
            ProblemDetails = new ProblemDetails
            {
                Type = "https://tools.ietf.org/html/rfc9110#section-15.6.1",
                Title = "An unexpected error occurred",
                Status = StatusCodes.Status500InternalServerError,
            },
        });
    }
}
```

Здесь важны две детали. Во-первых, обработчик помечен `sealed` и использует внедрение через первичный конструктор — идиома C# 12+. Во-вторых, мы делегируем формирование тела ответа `IProblemDetailsService` вместо того чтобы вызывать `httpContext.Response.WriteAsJsonAsync(...)` самостоятельно. Именно это изменение заставляет ответ учитывать заголовок `Accept` клиента, набор зарегистрированных `IProblemDetailsWriter` и любой настроенный callback `CustomizeProblemDetails`. К этому мы вернёмся в разделе про ProblemDetails.

## Подключение обработчика в Program.cs

Три строки добавляют обработчик. Порядок middleware важен:

```csharp
// .NET 11, C# 14, Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddProblemDetails();
builder.Services.AddExceptionHandler<GlobalExceptionHandler>();

var app = builder.Build();

app.UseExceptionHandler();   // must come before UseAuthorization, MapControllers, etc.
app.UseStatusCodePages();    // optional, formats 4xx the same way

app.MapControllers();
app.Run();
```

`AddExceptionHandler<T>` регистрирует обработчик как singleton, и это требование обеспечивается фреймворком. Если обработчику нужны scoped-сервисы (`DbContext`, request-scoped logger), внедряйте `IServiceProvider` и создавайте scope на каждый вызов, а не получайте scoped-сервис в конструкторе:

```csharp
// .NET 11, C# 14
internal sealed class DbBackedExceptionHandler(IServiceScopeFactory scopes) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(
        HttpContext ctx, Exception ex, CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AuditDbContext>();
        db.Failures.Add(new FailureRecord(ctx.TraceIdentifier, ex.GetType().FullName!));
        await db.SaveChangesAsync(ct);
        return false; // let another handler write the response
    }
}
```

`UseExceptionHandler()` без аргументов использует зарегистрированную цепочку `IExceptionHandler`. Перегрузка, принимающая `string` с путём или `Action<IApplicationBuilder>`, — это старая модель «только middleware», и она обходит цепочку обработчиков. Выбирайте одно или другое, не оба.

## ProblemDetails бесплатно, когда вы его подключаете

`AddProblemDetails()` регистрирует стандартный `IProblemDetailsService` и один `IProblemDetailsWriter` для `application/problem+json`. После регистрации автоматически происходят три вещи:

1. `UseExceptionHandler()` пишет тело `ProblemDetails` для необработанных исключений, когда ни один `IExceptionHandler` не претендует на ответ.
2. `UseStatusCodePages()` пишет тело `ProblemDetails` для 4xx-ответов без тела.
3. Ваш собственный обработчик может вызвать `problemDetailsService.TryWriteAsync(...)` и бесплатно получить ту же согласование контента и кастомизацию.

Самая полезная точка кастомизации — `CustomizeProblemDetails`, которая выполняется после того как ваш обработчик собрал объект, и до его записи. Типичный сайт добавляет trace identifier, чтобы поддержка могла соотнести ошибку, видимую пользователю, с записью в журнале:

```csharp
// .NET 11, C# 14
builder.Services.AddProblemDetails(options =>
{
    options.CustomizeProblemDetails = ctx =>
    {
        ctx.ProblemDetails.Extensions["traceId"] = ctx.HttpContext.TraceIdentifier;
        ctx.ProblemDetails.Extensions["requestId"] =
            Activity.Current?.Id ?? ctx.HttpContext.TraceIdentifier;
    };
});
```

Не помещайте сообщения исключений и трассировки стека в ответ в production. Они выдают внутреннюю структуру (имена таблиц, пути к файлам, URL сторонних API), которую злоумышленник может связать в более точечную атаку. Любой вывод `ex.Message` ставьте в зависимость от `IHostEnvironment.IsDevelopment()`.

## Несколько обработчиков, упорядоченных по типу исключения

Middleware исключений итерирует зарегистрированные обработчики в порядке регистрации, пока один из них не вернёт `true`. Это правильное место для трансляции по типу исключения:

```csharp
// .NET 11, C# 14
internal sealed class ValidationExceptionHandler(IProblemDetailsService pds) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(
        HttpContext ctx, Exception ex, CancellationToken ct)
    {
        if (ex is not FluentValidation.ValidationException ve) return false;

        ctx.Response.StatusCode = StatusCodes.Status400BadRequest;

        var errors = ve.Errors
            .GroupBy(e => e.PropertyName)
            .ToDictionary(g => g.Key, g => g.Select(e => e.ErrorMessage).ToArray());

        return await pds.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = ctx,
            Exception = ex,
            ProblemDetails = new HttpValidationProblemDetails(errors)
            {
                Type = "https://tools.ietf.org/html/rfc9110#section-15.5.1",
                Title = "One or more validation errors occurred",
                Status = StatusCodes.Status400BadRequest,
            },
        });
    }
}

internal sealed class NotFoundExceptionHandler(IProblemDetailsService pds) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(
        HttpContext ctx, Exception ex, CancellationToken ct)
    {
        if (ex is not EntityNotFoundException) return false;

        ctx.Response.StatusCode = StatusCodes.Status404NotFound;
        return await pds.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = ctx,
            Exception = ex,
            ProblemDetails = new ProblemDetails
            {
                Type = "https://tools.ietf.org/html/rfc9110#section-15.5.5",
                Title = "Resource not found",
                Status = StatusCodes.Status404NotFound,
            },
        });
    }
}
```

Регистрируйте их по порядку приоритета. Catch-all-обработчик для 500 идёт последним:

```csharp
// .NET 11, C# 14
builder.Services.AddExceptionHandler<ValidationExceptionHandler>();
builder.Services.AddExceptionHandler<NotFoundExceptionHandler>();
builder.Services.AddExceptionHandler<GlobalExceptionHandler>();
```

Middleware итерирует singletons именно в этом порядке. Если `ValidationExceptionHandler` возвращает `false`, спрашивается следующий обработчик. Если `GlobalExceptionHandler` возвращает `true`, последующие обработчики не запускаются.

Не поддавайтесь искушению писать один мега-обработчик с гигантским `switch`. Обработчики на каждый тип исключения проще unit-тестировать (каждый — это маленький класс, принимающий один fake), проще удалять, когда тип исключения исчезает, и проще регистрировать условно (например, `ValidationExceptionHandler` регистрировать только когда FluentValidation присутствует в проекте).

## Порядок middleware, ломающий обработчик

Самая частая ошибка — поместить `UseExceptionHandler()` не туда. Правило такое: он должен идти раньше любого middleware, которое может выбросить исключение, которое вы хотите перехватить. На практике это означает, что он должен быть первым middleware, не связанным с окружением.

```csharp
// Wrong: a NullReferenceException from authentication never reaches the handler.
app.UseAuthentication();
app.UseAuthorization();
app.UseExceptionHandler();   // too late
app.MapControllers();

// Right: the handler wraps everything that follows.
app.UseExceptionHandler();
app.UseAuthentication();
app.UseAuthorization();
app.MapControllers();
```

Единственное, что легитимно работает раньше `UseExceptionHandler`, — это developer exception page в непродакшен-окружениях:

```csharp
// .NET 11, C# 14
if (app.Environment.IsDevelopment())
{
    app.UseDeveloperExceptionPage();
}
else
{
    app.UseExceptionHandler();
    app.UseHsts();
}
```

Если вы регистрируете оба, в dev побеждает developer page, потому что она замыкает запрос до того как middleware обработчика выполнится. Обычно вы этого и хотите: dev-страница показывает трассировку стека и фрагмент исходника, что и есть весь смысл локального запуска.

## Ломающее изменение в .NET 10 о подавлении диагностики

В .NET 8 и 9 `UseExceptionHandler` всегда логировал необработанное исключение на уровне `Error` и эмитировал activity `Microsoft.AspNetCore.Diagnostics.HandlerException`, независимо от того, возвращал ли ваш `IExceptionHandler` `true`. Это легко приводило к двойному логированию: ваш обработчик логировал, и фреймворк тоже.

Начиная с .NET 10 (и сохранено в .NET 11) фреймворк подавляет собственную диагностику для любого исключения, которое обработчик присвоил, вернув `true`. Теперь ваш обработчик единолично отвечает за логирование в этом случае. Исключения, прошедшие необработанными, по-прежнему эмитируют лог фреймворка.

Это изменение поведения, которое можно получить незаметно. Если у вас есть алерт в Grafana на `aspnetcore.diagnostics.handler.unhandled_exceptions`, и вы обновляетесь до .NET 10 или новее, метрика обрушится в ноль для обработанных исключений и ваш дашборд станет плоским. Решение:

```csharp
// Opt back in to the .NET 8/9 behaviour.
app.UseExceptionHandler(new ExceptionHandlerOptions
{
    SuppressDiagnosticsCallback = _ => false,
});
```

Или, что предпочтительнее, удалить дашборд и полагаться на логирование, которое делает ваш обработчик. Двойной счёт всегда был багом.

Callback получает `ExceptionHandlerDiagnosticsContext` с исключением, запросом и флагом, заявил ли обработчик ответ, поэтому подавлять можно избирательно — например, не логировать `OperationCanceledException` от запроса, который клиент прервал:

```csharp
// .NET 11, C# 14
app.UseExceptionHandler(new ExceptionHandlerOptions
{
    SuppressDiagnosticsCallback = ctx =>
        ctx.Exception is OperationCanceledException &&
        ctx.HttpContext.RequestAborted.IsCancellationRequested,
});
```

Точную семантику смотрите в [заметке о ломающем изменении на Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/compatibility/aspnet-core/10/exception-handler-diagnostics-suppressed).

## Когда IExceptionFilter всё ещё правильный инструмент

Есть два узких случая, в которых MVC-`IExceptionFilter` всё ещё корректен:

1. Вы хотите транслировать исключение только для конкретного контроллера или действия, и вы хотите, чтобы фильтр был обнаруживаем в атрибутах действия. `[TypeFilter(typeof(MyExceptionFilter))]` на классе контроллера ограничивает поведение, не загрязняя глобальный конвейер. Это скорее action filter для одного странного endpoint, чем настоящая «глобальная» вещь.
2. Вам нужен доступ к MVC `ActionContext` (например, к `IModelMetadataProvider` для параметров действия). `IExceptionHandler` видит только `HttpContext`, поэтому эти метаданные там недоступны.

За пределами этого побеждает `IExceptionHandler`. Он работает для минимальных API, выполняется до MVC и чисто компонуется с несколькими зарегистрированными обработчиками. Относитесь к MVC-фильтру как к инструменту с областью действия action, а не как к глобальному.

## Частая ошибка: бросать исключение внутри пользовательского IProblemDetailsWriter

Если вы реализуете пользовательский `IProblemDetailsWriter` (например, чтобы выдавать вендор-специфичный конверт ошибки), не бросайте из `WriteAsync`. Middleware исключений ловит и это исключение, рекурсивно возвращается в ту же цепочку обработчиков, и вы получаете либо переполнение стека, либо, если повезёт, пустой 500 без тела. Оборачивайте логику записи тела в try/catch и возвращайте `false` из `CanWrite`, если writer в плохом состоянии. То же правило относится к коду обработчика: не бросайте изнутри `TryHandleAsync`. Возвращайте `false`.

Безопасная форма:

```csharp
// .NET 11, C# 14
public async ValueTask<bool> TryHandleAsync(
    HttpContext ctx, Exception ex, CancellationToken ct)
{
    try
    {
        ctx.Response.StatusCode = MapStatus(ex);
        await pds.TryWriteAsync(BuildContext(ctx, ex));
        return true;
    }
    catch
    {
        return false; // let the framework default kick in
    }
}
```

## Связанное

- [Пользовательский JsonConverter в System.Text.Json](/ru/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) для сериализации словаря `ProblemDetails.Extensions` так, как ожидают ваши клиенты.
- [Стриминг файла из endpoint ASP.NET Core без буферизации](/ru/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) рассматривает ещё одну тонкость порядка middleware в том же конвейере.
- [Отмена долгоживущей Task без взаимной блокировки](/ru/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) для шаблонов `OperationCanceledException`, на которые опирается callback диагностики выше.
- [Генерация строго типизированных клиентов из спецификации OpenAPI в .NET 11](/ru/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/), если вы публикуете схему `ProblemDetails` потребителям.

## Источники

- Microsoft Learn, [Обработка ошибок в ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/error-handling?view=aspnetcore-10.0).
- Microsoft Learn, [Обработка ошибок в API ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/error-handling-api?view=aspnetcore-10.0).
- Ломающее изменение в Microsoft Learn, [Диагностика исключений подавляется, когда IExceptionHandler.TryHandleAsync возвращает true](https://learn.microsoft.com/en-us/dotnet/core/compatibility/aspnet-core/10/exception-handler-diagnostics-suppressed).
- Заметки о выпуске ASP.NET Core, [.NET 10 preview 7 ASP.NET Core](https://github.com/dotnet/core/blob/main/release-notes/10.0/preview/preview7/aspnetcore.md).
- Обсуждение на GitHub, [IExceptionHandler в .NET 8 для глобальной обработки исключений](https://github.com/dotnet/aspnetcore/discussions/54613).
