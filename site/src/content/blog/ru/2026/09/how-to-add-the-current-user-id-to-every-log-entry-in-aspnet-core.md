---
title: "Как добавить id текущего пользователя в каждую запись журнала в ASP.NET Core"
description: "Middleware с BeginScope пропускает запись об ошибке от обработчика исключений и строку Request finished. Зарегистрируйте ILogEnricher, который читает пользователя из IHttpContextAccessor, открывайте scope только тогда, когда работа выходит за пределы запроса, и учтите, что AddSerilog из Serilog молча отключает обогащение."
pubDate: 2026-09-21
template: how-to
tags:
  - "aspnet-core"
  - "dotnet-10"
  - "logging"
  - "observability"
  - "opentelemetry"
  - "serilog"
  - "how-to"
lang: "ru"
translationOf: "2026/09/how-to-add-the-current-user-id-to-every-log-entry-in-aspnet-core"
translatedBy: "claude"
translationDate: 2026-09-21
---

Короткий ответ: не передавайте id пользователя в каждый вызов `LogInformation` и не останавливайтесь на middleware, который оборачивает конвейер в `ILogger.BeginScope`. Такой scope охватывает только вызовы журналирования, сделанные *внутри* него, поэтому он пропускает две строки, которые нужнее всего, когда что-то ломается: ошибку от `ExceptionHandlerMiddleware` и запись хостинга "Request finished". Вместо этого добавьте `Microsoft.Extensions.Telemetry`, вызовите `builder.Logging.EnableEnrichment()` и зарегистрируйте `ILogEnricher` через `builder.Services.AddLogEnricher<UserIdEnricher>()`, который читает `ClaimTypes.NameIdentifier` из `IHttpContextAccessor`. Он выполняется один раз для каждой записи журнала, для любой категории, включая собственные категории фреймворка. Единственное место, где он не поможет, это работа, которая переживает запрос: захватите id до того, как передадите работу в `Task.Run` или очередь, и откройте scope уже там.

Всё описанное ниже запускалось на .NET 10 (SDK 10.0.302, среда выполнения ASP.NET Core 10.0.10) с `Microsoft.Extensions.Telemetry` 10.10.0, `OpenTelemetry.Extensions.Hosting` и `OpenTelemetry.Exporter.Console` 1.19.1, а также `Serilog.AspNetCore` 10.0.0. Таблица результатов получена на реальных запросах к небольшому тестовому приложению, а не из чтения документации.

## Почему middleware с BeginScope выглядит правильным, но им не является

Первый ответ, который находится на StackOverflow, это middleware вроде такого:

```csharp
// .NET 10, ASP.NET Core 10: the common approach, and its gap
app.UseExceptionHandler("/error");
app.UseAuthentication();

app.Use(async (ctx, next) =>
{
    var userId = ctx.User.FindFirstValue(ClaimTypes.NameIdentifier);
    if (userId is null) { await next(ctx); return; }

    var logger = ctx.RequestServices.GetRequiredService<ILoggerFactory>()
        .CreateLogger("UserScope");
    using (logger.BeginScope(new Dictionary<string, object?> { ["UserId"] = userId }))
    {
        await next(ctx);
    }
});

app.UseAuthorization();
```

Для вашего собственного кода он работает. `log.LogInformation("Loading orders")` внутри конечной точки выводится с `"UserId":"u-42"` в scopes. Проблема в структуре. Scopes журналирования хранятся в `AsyncLocal`, поэтому они прикрепляются к вызовам журналирования, сделанным, пока блок `using` находится в стеке. Две важные строки журнала пишутся уже после того, как этот блок освобождён:

- `UseExceptionHandler` стоит снаружи middleware со scope (так и должно быть, иначе он не поймает исключения из аутентификации). К моменту, когда он пишет "An unhandled exception has occurred while executing the request.", исключение уже раскрутилось через ваш `using`, и scope исчез.
- "Request finished ... 500" пишет `Microsoft.AspNetCore.Hosting.Diagnostics`, который оборачивает весь конвейер middleware. Ни один написанный вами middleware не может поставить scope вокруг него.

В итоге запись об ошибке, та самая, которую поддержка будет искать по id пользователя, оказывается записью без id пользователя. Перенос middleware со scope выше `UseExceptionHandler` тоже не помогает, потому что пользователь неизвестен, пока не отработала аутентификация.

У того же поведения `AsyncLocal` есть и плюс, которого нет у обогатителя: scope перетекает вместе с `ExecutionContext` в `Task.Run` и другие продолжения, поэтому работа по принципу fire-and-forget, запущенная внутри запроса, сохраняет id даже после отправки ответа.

## Что на самом деле помечает каждый подход

Я выполнил три запроса от аутентифицированного пользователя `u-42` к одному и тому же приложению в каждой конфигурации: к конечной точке, которая пишет в журнал, к конечной точке, которая выбрасывает исключение, и к конечной точке, которая запускает `Task.Run`, пишущий в журнал через 300 ms после отправки ответа. Вывод шёл через `AddJsonConsole` с `IncludeScopes = true`, а затем тот же прогон был повторён с консольным экспортёром OpenTelemetry.

| Запись журнала | Middleware `BeginScope` | `ILogEnricher` | Обогатитель + scope при передаче |
| --- | --- | --- | --- |
| "Request starting" (хостинг) | нет | нет | нет |
| Собственный `LogInformation` конечной точки | да | да | да |
| Ошибка `ExceptionHandlerMiddleware` | **нет** | да | да |
| "Request finished" (хостинг) | **нет** | да | да |
| Запись `Task.Run` после ответа | да | **нет** | да |

"Request starting" не пометить в принципе: эта запись пишется до запуска аутентификации, так что пользователя ещё нет. Чтобы связать её с остальной частью запроса, опирайтесь на общий `TraceId`.

## Шаг 1: добавьте обогатитель

Обогащение журнала входит в библиотеки `dotnet/extensions`. `ILogEnricher` и `AddLogEnricher` находятся в `Microsoft.Extensions.Telemetry.Abstractions`; `EnableEnrichment()` находится в `Microsoft.Extensions.Telemetry`, который ссылается на абстракции, так что одного пакета достаточно:

```bash
dotnet add package Microsoft.Extensions.Telemetry --version 10.10.0
```

Сам обогатитель занимает несколько строк:

```csharp
// .NET 10, Microsoft.Extensions.Telemetry 10.10.0
using System.Security.Claims;
using Microsoft.Extensions.Diagnostics.Enrichment;

public sealed class UserIdEnricher(IHttpContextAccessor accessor) : ILogEnricher
{
    public void Enrich(IEnrichmentTagCollector collector)
    {
        var userId = accessor.HttpContext?.User.FindFirstValue(ClaimTypes.NameIdentifier);
        if (userId is not null)
        {
            collector.Add("user.id", userId);
        }
    }
}
```

Затем подключите его в `Program.cs`:

```csharp
// .NET 10, ASP.NET Core 10, Microsoft.Extensions.Telemetry 10.10.0
var builder = WebApplication.CreateBuilder(args);

builder.Logging.EnableEnrichment();
builder.Services.AddHttpContextAccessor();
builder.Services.AddLogEnricher<UserIdEnricher>();

builder.Services.AddAuthentication(/* your scheme */);
builder.Services.AddAuthorization();

var app = builder.Build();
app.UseExceptionHandler("/error");
app.UseAuthentication();
app.UseAuthorization();
```

Middleware не нужен. `EnableEnrichment()` заменяет стандартный `LoggerFactory` расширенным из `Microsoft.Extensions.Telemetry`, который вызывает каждый зарегистрированный `ILogEnricher` один раз для каждой записи журнала и добавляет теги в состояние записи. Поскольку обогатитель читает пользователя в момент вызова журналирования, а не в момент открытия scope, он по-прежнему находит пользователя, когда обработчик исключений и диагностика хостинга пишут свои записи: `HttpContext` жив до завершения запроса.

В JSON-выводе консоли тег появляется в `State`, рядом с параметрами шаблона сообщения, а не в `Scopes`:

```json
{"EventId":1,"LogLevel":"Error","Category":"Microsoft.AspNetCore.Diagnostics.ExceptionHandlerMiddleware","Message":"An unhandled exception has occurred while executing the request.","State":{"user.id":"u-42","exception.type":"System.InvalidOperationException","{OriginalFormat}":"An unhandled exception has occurred while executing the request."}}
```

Здесь вырезаны текст исключения и scopes. Обратите внимание на бесплатный тег `exception.type`: расширенный логгер добавляет его к любой записи, которая несёт исключение, и благодаря этому "все сбои этого пользователя, сгруппированные по типу исключения" превращаются в один запрос.

Здесь важны несколько деталей:

- `AddLogEnricher<T>` регистрирует обогатитель как **singleton** (`AddSingleton<ILogEnricher, T>()` в исходном коде). Внедряйте только singleton-сервисы. `IHttpContextAccessor` это singleton, который читает `AsyncLocal`, и именно поэтому он работает; scoped-сервис, например ваш `DbContext` или сервис пользователя на уровне запроса, будет захвачен один раз из корневого провайдера.
- Двойная регистрация приводит к двойному выполнению, потому что используется `AddSingleton`, а не `TryAddEnumerable`.
- Обогатитель выполняется для каждой записи журнала в процессе, включая запуск приложения и фоновые сервисы. Не допускайте в нём выделений памяти и позвольте ему тихо возвращаться, когда `HttpContext` равен null.

## Шаг 2: перенесите id через границу запроса

`IHttpContextAccessor.HttpContext` становится null, как только запрос завершается, поэтому обогатитель не может пометить работу, которая переживает запрос. Это последняя строка таблицы. Захватите id, пока запрос ещё доступен, и откройте scope внутри фоновой работы:

```csharp
// .NET 10, ASP.NET Core 10
app.MapPost("/reports", (HttpContext ctx, ILogger<Program> log) =>
{
    var userId = ctx.User.FindFirstValue(ClaimTypes.NameIdentifier);

    _ = Task.Run(async () =>
    {
        using var scope = log.BeginScope("user.id:{user.id}", userId);
        await Task.Delay(300);
        log.LogInformation("Background work finished");
    });

    return Results.Accepted();
});
```

После этого изменения фоновая строка вышла со scope `{"Message":"user.id:u-42","user.id":"u-42"}`, так что помечена каждая строка таблицы, кроме "Request starting". Используйте тот же ключ, что и в обогатителе, чтобы вашим запросам не понадобился `OR`.

Два замечания об этом фрагменте. Во-первых, используйте перегрузку `BeginScope` с шаблоном сообщения: голый scope `Dictionary<string, object?>` работает, но консольный экспортёр и экспортёр OpenTelemetry печатают в качестве сообщения scope его `ToString()`, то есть ``System.Collections.Generic.Dictionary`2[System.String,System.Object]``. Во-вторых, `Task.Run` из конечной точки здесь лишь заменяет передачу работы. Для настоящей работы по принципу fire-and-forget положите id пользователя в элемент работы, который вы ставите в очередь для `BackgroundService`, и открывайте scope, когда воркер извлекает его из очереди. Этот паттерн и его подводные камни разобраны в статье о [безопасном выполнении fire-and-forget работы с BackgroundService](/ru/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/).

## Шаг 3: убедитесь, что ваш приёмник действительно его показывает

Куда попадает тег, зависит от провайдера.

**Консольные форматтеры.** Теги обогащения являются частью состояния, поэтому `AddJsonConsole` показывает их даже при `IncludeScopes = false`. Scope передачи из шага 2 требует `IncludeScopes = true`, а это значение по умолчанию выключено у всех консольных форматтеров. Простой консольный форматтер не печатает ни свойства состояния, ни, без `IncludeScopes`, scopes, поэтому используйте JSON-форматтер или полноценный приёмник.

**OpenTelemetry.** С `builder.Logging.AddOpenTelemetry(o => { o.IncludeScopes = true; o.AddConsoleExporter(); })` тег обогащения стал обычным атрибутом записи журнала (`LogRecord.Attributes: user.id: u-42`) в записи конечной точки, в ошибке обработчика исключений и в "Request finished", а scope передачи пришёл как `[Scope.3]:UserId: u-42` в `ScopeValues`. Без `IncludeScopes = true` значения scope отбрасываются, так что фоновая строка потеряла бы свой id. Если вы всё равно переходите на OpenTelemetry, сторону экспортёра описывает [миграция журналирования с Serilog на OpenTelemetry](/ru/2026/06/migrate-from-serilog-to-opentelemetry-logging-in-dotnet-11/).

**Serilog: ловушка.** Именно на это у меня ушло больше всего времени. `Serilog.AspNetCore` рекомендует `builder.Services.AddSerilog(...)`, который регистрирует собственный `ILoggerFactory` от Serilog. `EnableEnrichment()` тоже заменяет `ILoggerFactory`. Побеждает последняя регистрация, и ни один из них об этом не сообщает:

| Регистрация | Результат |
| --- | --- |
| `Services.AddSerilog(...)`, затем `EnableEnrichment()` | **Никакого вывода журнала вообще**: побеждает расширенная фабрика, а у неё нет провайдеров |
| `EnableEnrichment()`, затем `Services.AddSerilog(...)` | Журналирование работает, но обогатитель никогда не выполняется; `user.id` нигде нет |
| `EnableEnrichment()` плюс `builder.Logging.AddSerilog(logger)` | Работает в любом порядке; `user.id` в каждой строке, которую покрывает обогатитель |

Первая строка не преувеличение. Приложение обслуживало запросы и записало в stdout ноль байт. Рабочая комбинация регистрирует Serilog как `ILoggerProvider` под фабрикой Microsoft:

```csharp
// .NET 10, Serilog.AspNetCore 10.0.0, Microsoft.Extensions.Telemetry 10.10.0
using Serilog;
using Serilog.Formatting.Compact;

var serilog = new LoggerConfiguration()
    .MinimumLevel.Information()
    .Enrich.FromLogContext()
    .WriteTo.Console(new CompactJsonFormatter())
    .CreateLogger();

builder.Logging.ClearProviders();
builder.Logging.AddSerilog(serilog, dispose: true);
builder.Logging.EnableEnrichment();
builder.Services.AddHttpContextAccessor();
builder.Services.AddLogEnricher<UserIdEnricher>();
```

Serilog превращает тег обогащения в полноценное свойство `user.id`, а также подхватывает значения `BeginScope`, так что scope из шага 2 работает без изменений. Цена в том, что именно `Services.AddSerilog` регистрирует `IDiagnosticContext` от Serilog, который нужен `UseSerilogRequestLogging`. Если вы зависите от этого middleware, оставьте `Services.AddSerilog`, откажитесь от `EnableEnrichment` и действуйте по-серилоговски: добавляйте id через `LogContext.PushProperty("UserId", userId)` в middleware после `UseAuthentication` и включайте его в событие завершения через `options.EnrichDiagnosticContext = (dc, http) => dc.Set("UserId", http.User.FindFirstValue(ClaimTypes.NameIdentifier))`. Я отдельно проверил middleware с `PushProperty`, и у него ровно те же пробелы, что и у `BeginScope` (нет id в ошибке обработчика исключений и в "Request finished"), поэтому колбэк диагностического контекста так важен. Базовая настройка Serilog описана в статье о [структурированном журналировании с Serilog и Seq](/ru/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/).

## Подводные камни, которые проявляются в продакшене

**Id пользователя это персональные данные.** По GDPR стабильный идентификатор учётной записи, прикреплённый к каждой строке журнала, делает эти журналы персональными данными, что влияет на срок хранения и на то, кто может их читать. Пишите в журнал непрозрачный внутренний id, никогда не адрес электронной почты и не claim `name`, а если этого требует ваша служба комплаенса, хешируйте или скрывайте его на уровне журналирования. Поддержка редактирования данных в .NET умеет делать это для каждого свойства; см. [скрытие чувствительных значений с помощью LogProperties](/ru/2026/08/how-to-redact-sensitive-values-from-logs-with-logproperties-in-dotnet/).

**Выберите правильный claim.** `ClaimTypes.NameIdentifier` заполняют ASP.NET Core Identity и cookie-аутентификация. JWT bearer сопоставляет claim `sub` из токена с `NameIdentifier` только пока `JwtBearerOptions.MapInboundClaims` равен `true`, что является значением по умолчанию. Многие API отключают его, чтобы сохранить исходные имена claims из JWT, и с этого момента субъект приходит как `sub`, а приведённый выше обогатитель молча ничего не пишет. Если вы не уверены, что именно получаете, читайте `User.FindFirstValue("sub") ?? User.FindFirstValue(ClaimTypes.NameIdentifier)`.

**Аутентификация должна выполниться до вызова журналирования, а не до регистрации.** Обогатитель читает `HttpContext.User` лениво, поэтому помечает всё, что записано после того, как отработал middleware аутентификации, где бы этот middleware ни стоял. Если вы полагаетесь на автоматический middleware аутентификации, который `WebApplication` добавляет при регистрации сервисов аутентификации, и не вызываете `UseAuthentication` сами, он выполняется в начале конвейера, и вы защищены.

**Интерактивный Blazor и SignalR.** `IHttpContextAccessor` не является надёжным источником текущего пользователя в интерактивных компонентах Blazor Server; документация ASP.NET Core советует избегать его при интерактивном рендеринге. Для circuits и вызовов хабов получайте пользователя из `AuthenticationStateProvider` или `HubCallerContext.User` и вместо этого открывайте scope вокруг работы.

**Обогатители работают на уровне записи, поэтому держите их дешёвыми.** Поиск по нескольким claims обходится почти даром, но не разрешайте сервисы, не обращайтесь к базе данных и не выделяйте строки в `Enrich`. Если значение постоянно для процесса (версия, регион), используйте `IStaticLogEnricher`, который выполняется один раз.

**Не добавляйте id ещё и в шаблоны сообщений.** `LogInformation("User {UserId} loaded orders", userId)` дублирует свойство, а если ключи различаются, разбивает ваши запросы. Пусть шаблоны описывают событие; остальную часть этой дисциплины см. в статье о [переходе от интерполяции строк к шаблонам сообщений](/ru/2026/07/migrate-from-ilogger-string-interpolation-to-message-templates-in-dotnet-11/).

### Читайте также

- [Как настроить структурированное журналирование с Serilog и Seq в .NET 11](/ru/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/)
- [Миграция журналирования с Serilog на OpenTelemetry в .NET 11](/ru/2026/06/migrate-from-serilog-to-opentelemetry-logging-in-dotnet-11/)
- [Как скрывать чувствительные значения в журналах с помощью LogProperties в .NET](/ru/2026/08/how-to-redact-sensitive-values-from-logs-with-logproperties-in-dotnet/)
- [Как безопасно выполнять fire-and-forget работу в ASP.NET Core с BackgroundService](/ru/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/)

### Источники

- [Обзор обогащения журналов](https://learn.microsoft.com/dotnet/core/enrichment/overview) и [Пользовательский обогатитель журналов](https://learn.microsoft.com/dotnet/core/enrichment/custom-enricher) на Microsoft Learn
- [`EnrichmentServiceCollectionExtensions.cs`](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Telemetry.Abstractions/Enrichment/EnrichmentServiceCollectionExtensions.cs) в dotnet/extensions (регистрация как singleton)
- [Журналирование в .NET: scopes журнала](https://learn.microsoft.com/dotnet/core/extensions/logging#log-scopes)
- [Доступ к HttpContext в ASP.NET Core](https://learn.microsoft.com/aspnet/core/fundamentals/http-context) (включая рекомендации для интерактивного Blazor)
- [README Serilog.AspNetCore](https://github.com/serilog/serilog-aspnetcore)
- [Журналы OpenTelemetry .NET: IncludeScopes](https://github.com/open-telemetry/opentelemetry-dotnet/tree/main/docs/logs)
