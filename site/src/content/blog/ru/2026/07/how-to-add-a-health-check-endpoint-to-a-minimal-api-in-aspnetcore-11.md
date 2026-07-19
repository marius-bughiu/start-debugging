---
title: "Как добавить endpoint health check в minimal API на ASP.NET Core 11"
description: "Полное практическое руководство по health checks в minimal API на ASP.NET Core 11: AddHealthChecks и MapHealthChecks, собственные классы IHealthCheck, возвращающие Healthy/Degraded/Unhealthy, зонд EF Core AddDbContextCheck, эндпоинты liveness и readiness на основе тегов для Kubernetes, JSON ResponseWriter, ResultStatusCodes, защита эндпоинта через RequireAuthorization и RequireHost, а также отправка результатов через IHealthCheckPublisher."
pubDate: 2026-07-19
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-api"
  - "health-checks"
lang: "ru"
translationOf: "2026/07/how-to-add-a-health-check-endpoint-to-a-minimal-api-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-19
---

Чтобы добавить endpoint health check в minimal API на ASP.NET Core 11, вы вызываете `builder.Services.AddHealthChecks()` для регистрации сервиса, при необходимости сцепляете вызовы `.AddCheck(...)`, чтобы описать, что означает "healthy" для вашего приложения, а затем вызываете `app.MapHealthChecks("/healthz")`, чтобы предоставить endpoint. Обратитесь к этому URL и получите `200 OK` с телом `Healthy`, когда все проверки проходят, или `503 Service Unavailable`, когда какая-либо проверка сообщает `Unhealthy`. Эта настройка из двух строк и есть полный минимум. Этот пост доводит его от этого минимума до конфигурации, готовой к production: собственный `IHealthCheck`, который действительно зондирует зависимость, встроенный зонд базы данных EF Core, отдельные эндпоинты liveness и readiness, подключённые для Kubernetes, тело ответа JSON, корректные коды состояния HTTP и защита эндпоинта. Он ориентирован на .NET 11 (Preview 6 на момент написания, GA в ноябре 2026 года) с `Microsoft.NET.Sdk.Web` и C# 14, но API health checks стабилен со времён ASP.NET Core 2.2, поэтому каждый пример здесь работает без изменений на .NET 8, 9 и 10.

## Для чего на самом деле нужен endpoint health check

Endpoint health check представляет собой URL, который оркестратор, балансировщик нагрузки или монитор доступности может опрашивать, чтобы спросить "стоит ли отправлять трафик на этот экземпляр?" Ответ намеренно грубый: агрегированный статус, вычисленный из набора зарегистрированных проверок и предоставленный как код состояния HTTP, чтобы всё, что говорит по HTTP, могло его потреблять без разбора тела. Kubernetes использует его, чтобы решить, перезапускать ли под или маршрутизировать ли запросы к нему. Azure App Service или target group в AWS использует его, чтобы вывести нездоровый экземпляр из ротации. Инструмент вроде Uptime Kuma использует его, чтобы оповестить вас.

Ключевой момент проектирования в том, что health check не является ни endpoint метрик, ни панелью диагностики. Он отвечает на один вопрос быстро, в идеале за несколько миллисекунд, и его проверки должны тестировать только то, что действительно определяет, может ли этот процесс обслуживать запросы: достижима ли база данных, отвечает ли критичный нижестоящий API, завершило ли приложение работу по запуску. Нагромождение медленных или несущественных зондов превращает сигнал liveness в обузу, потому что медленный health check под нагрузкой вызывает те самые каскадные перезапуски, которые он должен был предотвращать.

## Шаги для добавления endpoint health check

1. Зарегистрируйте сервис через `builder.Services.AddHealthChecks()`, который возвращает `IHealthChecksBuilder`.
2. Сцепите вызовы `.AddCheck(...)` или `.AddCheck<T>(...)` к этому builder для каждой зависимости, которую хотите зондировать.
3. Соберите приложение и вызовите `app.MapHealthChecks("/healthz")`, чтобы замапить endpoint.
4. При необходимости передайте `HealthCheckOptions`, чтобы отфильтровать проверки по тегу, сформировать ответ или переназначить коды состояния.
5. При необходимости сцепите `.RequireAuthorization()` или `.RequireHost(...)`, чтобы контролировать, кто может до него достучаться.

Остальная часть этой статьи разворачивает каждый из этих шагов в рабочий код.

## Отправная точка из двух строк

Вот наименьшее, что работает. `AddHealthChecks` без зарегистрированных проверок всё равно полезен: он даёт вам endpoint liveness, который возвращает `Healthy`, пока процесс запущен и конвейер запросов крутится.

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddHealthChecks();

var app = builder.Build();

app.MapHealthChecks("/healthz");

app.Run();
```

Теперь `GET /healthz` возвращает `200 OK` с телом в виде простого текста `Healthy`. Проверки не зарегистрированы, поэтому нечему падать. Это само по себе отвечает на вопрос "жив ли процесс и обслуживает ли HTTP", а это именно то, чего хочет liveness-зонд Kubernetes. Всё далее касается регистрации проверок, которые могут сообщать нечто иное, чем здоров, и формирования того, как endpoint сообщает.

## Написание собственной проверки с IHealthCheck

Настоящая проверка зондирует зависимость и сообщает одно из трёх состояний. Реализуйте `IHealthCheck`, единственный метод которого возвращает `HealthCheckResult`:

```csharp
// .NET 11, C# 14
using Microsoft.Extensions.Diagnostics.HealthChecks;

public sealed class QueueDepthHealthCheck : IHealthCheck
{
    private readonly IMessageQueue _queue;

    public QueueDepthHealthCheck(IMessageQueue queue) => _queue = queue;

    public async Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context,
        CancellationToken cancellationToken = default)
    {
        try
        {
            var depth = await _queue.GetApproximateDepthAsync(cancellationToken);

            if (depth > 10_000)
            {
                return HealthCheckResult.Unhealthy(
                    $"Queue backlog is {depth} messages.");
            }

            if (depth > 1_000)
            {
                // Still serving, but the backlog is a warning sign.
                return HealthCheckResult.Degraded(
                    $"Queue backlog is {depth} messages.",
                    data: new Dictionary<string, object> { ["depth"] = depth });
            }

            return HealthCheckResult.Healthy($"Queue depth {depth}.");
        }
        catch (Exception ex)
        {
            // Could not even reach the queue: that is unhealthy, not an unhandled 500.
            return HealthCheckResult.Unhealthy("Queue is unreachable.", ex);
        }
    }
}
```

Три фабричных метода соответствуют трём членам перечисления `HealthStatus`. `Healthy` означает полную работоспособность. `Unhealthy` означает, что этот экземпляр не может выполнять свою работу и должен быть выведен из ротации или перезапущен. `Degraded` представляет собой интересную середину: приложение всё ещё обслуживает запросы, но что-то не так (медленная зависимость, растущее отставание), и по умолчанию деградировавший результат всё равно возвращает `200 OK`. Это намеренно: обычно вы не хотите, чтобы оркестратор перезапускал под лишь потому, что очередь заполняется. Необязательный словарь `data` едет вместе с отчётом и появляется в теле ответа JSON, что удобно для панели без изменения решения о прохождении/провале.

Зарегистрируйте класс и дайте ему имя и, при необходимости, статус отказа и теги:

```csharp
// .NET 11, C# 14
builder.Services.AddHealthChecks()
    .AddCheck<QueueDepthHealthCheck>(
        "queue",
        failureStatus: HealthStatus.Unhealthy,
        tags: ["ready"]);
```

Зависимость конструктора (`IMessageQueue`) разрешается из внедрения зависимостей, поэтому ваша проверка может внедрять любой зарегистрированный сервис. Если нужно передать литеральные аргументы конструктора, которых нет в контейнере, используйте вместо этого `AddTypeActivatedCheck<T>(...)` и предоставьте массив `args`.

Для одноразовой inline-проверки, не заслуживающей класса, достаточно формы с лямбдой:

```csharp
// .NET 11, C# 14
builder.Services.AddHealthChecks()
    .AddCheck("self", () => HealthCheckResult.Healthy(), tags: ["live"]);
```

## Зондирование базы данных с AddDbContextCheck

Самое частое, чего команды хотят в зонде readiness, это ответ на вопрос "могу ли я достучаться до базы данных". Для этого не нужно писать `IHealthCheck`. Добавьте пакет `Microsoft.Extensions.Diagnostics.HealthChecks.EntityFrameworkCore` и используйте встроенный `AddDbContextCheck<TContext>`:

```csharp
// .NET 11, C# 14
builder.Services.AddDbContext<AppDbContext>(options =>
    options.UseSqlServer(
        builder.Configuration.GetConnectionString("DefaultConnection")));

builder.Services.AddHealthChecks()
    .AddDbContextCheck<AppDbContext>("database", tags: ["ready"]);
```

Под капотом это вызывает `DbContext.Database.CanConnectAsync`, который открывает соединение и закрывает его, не выполняя запрос. Это правильное значение по умолчанию: оно дёшево и проверяет именно то, что заботит зонд readiness: что строка соединения разрешается и сервер принимает соединения. Если нужно что-то более серьёзное, у `AddDbContextCheck` есть перегрузка, принимающая собственный тестовый запрос, но для распространённого случая нужен именно `CanConnectAsync`. За более глубокой настройкой подготовки EF Core перед первым использованием обратитесь к статье [как прогреть модель EF Core перед первым запросом](/ru/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/); проверка, выполняющая `CanConnectAsync`, является естественным местом, где этот прогрев уже должен был случиться.

Пакеты сообщества под `AspNetCore.Diagnostics.HealthChecks` (проект Xabaril) предоставляют готовые проверки для Redis, RabbitMQ, PostgreSQL, blob storage и десятков других зависимостей с тем же паттерном `.Add...`, поэтому вам редко нужно писать зонд для известного сервиса вручную.

## Отдельные эндпоинты liveness и readiness

Kubernetes различает два зонда, и их смешение является самой распространённой ошибкой health check. Зонд liveness отвечает на вопрос "завис ли этот процесс и нужен ли ему перезапуск"; если он падает, Kubernetes убивает под. Зонд readiness отвечает на вопрос "готов ли этот экземпляр принимать трафик прямо сейчас"; если он падает, Kubernetes перестаёт маршрутизировать к нему, но оставляет его работать. Вы не хотите, чтобы кратковременная недоступность базы данных запускала перезапуск пода, потому что перезапуск не может починить базу данных и лишь снимает мощность. Поэтому проверка базы данных относится к readiness, а не к liveness.

Механизм составляют теги плюс `Predicate` в `HealthCheckOptions`. Зарегистрируйте проверки с тегами, затем замапьте два эндпоинта, каждый из которых фильтрует до нужного набора:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Diagnostics.HealthChecks;

app.MapHealthChecks("/health/live", new HealthCheckOptions
{
    // Liveness: run no dependency checks. If the pipeline responds, we are alive.
    Predicate = _ => false
});

app.MapHealthChecks("/health/ready", new HealthCheckOptions
{
    // Readiness: only the checks tagged "ready" (database, queue, downstreams).
    Predicate = check => check.Tags.Contains("ready")
});
```

`Predicate = _ => false` означает "не включать никаких проверок", поэтому `/health/live` замыкается на `Healthy` в тот момент, когда запрос достигает эндпоинта. `/health/ready` выполняет только те проверки, которые вы пометили тегом `ready`. Направьте `livenessProbe` Kubernetes на `/health/live`, а `readinessProbe` направьте на `/health/ready`, и две задачи останутся аккуратно разделёнными.

## Возврат JSON вместо простого текста

Тело ответа по умолчанию представляет собой одно слово `Healthy`, `Degraded` или `Unhealthy`. Этого достаточно для зонда, но бесполезно для человека, отлаживающего, почему readiness падает. Предоставьте `ResponseWriter`, чтобы выдавать JSON с детализацией по каждой проверке:

```csharp
// .NET 11, C# 14
using System.Text.Json;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.Extensions.Diagnostics.HealthChecks;

static Task WriteJsonResponse(HttpContext context, HealthReport report)
{
    context.Response.ContentType = "application/json; charset=utf-8";

    var payload = new
    {
        status = report.Status.ToString(),
        totalDurationMs = report.TotalDuration.TotalMilliseconds,
        checks = report.Entries.Select(e => new
        {
            name = e.Key,
            status = e.Value.Status.ToString(),
            description = e.Value.Description,
            durationMs = e.Value.Duration.TotalMilliseconds
        })
    };

    return context.Response.WriteAsync(JsonSerializer.Serialize(payload));
}

app.MapHealthChecks("/health/ready", new HealthCheckOptions
{
    Predicate = check => check.Tags.Contains("ready"),
    ResponseWriter = WriteJsonResponse
});
```

Теперь упавшая проверка readiness возвращает тело, которое называет проверку, её статус, её описание и то, сколько она заняла, так что вы с первого взгляда видите, что "database" является записью, которая стала `Unhealthy`. Объект `HealthReport` предоставляет `Status` (агрегат), `TotalDuration` и словарь `Entries`, индексированный по именам проверок, которые вы зарегистрировали. Обратите внимание, что код состояния управляется отдельно от тела: `503` вполне может нести этот JSON.

## Управление кодом состояния

По умолчанию фреймворк маппит `Healthy` и `Degraded` на `200 OK`, а `Unhealthy` на `503 Service Unavailable`. Этот маппинг соответствует тому, чего ожидают балансировщики нагрузки, поэтому меняйте его только при наличии конкретной причины. Когда меняете, регулятором служит `ResultStatusCodes`:

```csharp
// .NET 11, C# 14
app.MapHealthChecks("/health/ready", new HealthCheckOptions
{
    Predicate = check => check.Tags.Contains("ready"),
    ResultStatusCodes =
    {
        [HealthStatus.Healthy] = StatusCodes.Status200OK,
        [HealthStatus.Degraded] = StatusCodes.Status200OK,
        [HealthStatus.Unhealthy] = StatusCodes.Status503ServiceUnavailable
    }
});
```

Одна тонкость, которую стоит усвоить: поскольку `Degraded` по умолчанию возвращает `200`, балансировщик нагрузки считает деградировавший экземпляр здоровым и продолжает слать ему трафик. Обычно это правильно, но если ваше определение "деградировал" достаточно серьёзно, чтобы вы хотели вывести его из ротации, либо замаппьте здесь `Degraded` на `503`, либо возвращайте из проверки `Unhealthy` вместо `Degraded`. Не оставляйте намерение неоднозначным.

Ещё одно значение по умолчанию, которое стоит знать: ответы health check устанавливают заголовки no-cache, чтобы посредник не мог отдать устаревший `Healthy`, пока экземпляр на самом деле падает. Если вам когда-нибудь понадобится кеширование, `AllowCachingResponses = true` в опциях его отключает, но для зонда это почти никогда не нужно.

## Защита эндпоинта

Эндпоинт здоровья, возвращающий подробный JSON, представляет собой небольшую поверхность раскрытия информации: он называет ваши зависимости и может выдавать детали отказов. Есть два чистых способа ограничить его. `RequireHost` ограничивает эндпоинт конкретным хостом или портом, что является стандартным приёмом для предоставления здоровья только на внутреннем управляющем порту, который не маршрутизируется публично:

```csharp
// .NET 11, C# 14
app.MapHealthChecks("/health/ready", new HealthCheckOptions
{
    Predicate = check => check.Tags.Contains("ready")
})
.RequireHost("*:8081");
```

`RequireAuthorization` помещает эндпоинт за ваши политики авторизации, которые сочетаются с любой настроенной вами аутентификацией. Если вы уже используете аутентификацию JWT bearer, добавление её к эндпоинту здоровья выполняется одним вызовом:

```csharp
// .NET 11, C# 14
app.MapHealthChecks("/health/ready")
    .RequireAuthorization();
```

Слово предостережения: не требуйте авторизацию на эндпоинте, который опрашивает ваш оркестратор, потому что оркестратор не предоставит токен и зонд упадёт. Держите простые эндпоинты liveness/readiness открытыми (ограничивайте их вместо этого по хосту или сети) и помещайте подробный, выдающий JSON эндпоинт за авторизацию, если вообще его предоставляете. Механика настройки стороны токена рассмотрена в статье [как настроить аутентификацию JWT bearer в minimal API на ASP.NET Core 11](/ru/2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11/).

## Отправка результатов вместо ожидания опроса

Всё вышеописанное основано на pull: что-то вызывает ваш эндпоинт. Фреймворк также поддерживает отчётность на основе push через `IHealthCheckPublisher`, который выполняет зарегистрированные проверки по таймеру и передаёт агрегированный `HealthReport` в ваш код, чтобы вы могли переслать его в систему мониторинга, выдать метрику или записать оповещение:

```csharp
// .NET 11, C# 14
using Microsoft.Extensions.Diagnostics.HealthChecks;

public sealed class LoggingHealthCheckPublisher : IHealthCheckPublisher
{
    private readonly ILogger<LoggingHealthCheckPublisher> _logger;

    public LoggingHealthCheckPublisher(ILogger<LoggingHealthCheckPublisher> logger)
        => _logger = logger;

    public Task PublishAsync(HealthReport report, CancellationToken cancellationToken)
    {
        if (report.Status != HealthStatus.Healthy)
        {
            _logger.LogWarning(
                "Health degraded: {Status} across {Count} checks.",
                report.Status, report.Entries.Count);
        }
        return Task.CompletedTask;
    }
}

builder.Services.AddSingleton<IHealthCheckPublisher, LoggingHealthCheckPublisher>();
builder.Services.Configure<HealthCheckPublisherOptions>(options =>
{
    options.Delay = TimeSpan.FromSeconds(5);   // Wait before the first run.
    options.Period = TimeSpan.FromSeconds(30); // Then run every 30 seconds.
    options.Predicate = check => check.Tags.Contains("ready");
});
```

Publisher работает на размещённом фоновом сервисе, который фреймворк регистрирует, как только любой `IHealthCheckPublisher` оказывается в контейнере, так что вы получаете периодическое выполнение без подключения собственного таймера. Это идиоматичное место для подачи здоровья в конвейер метрик; если вы уже экспортируете телеметрию, сочетайте его с [OpenTelemetry в .NET 11](/ru/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/), чтобы деградировавший статус появлялся рядом с вашими трассировками. Он также хорошо ладит с любым [мониторингом фоновых задач](/ru/2026/01/monitor-background-jobs-in-net-9-and-net-10-without-hangfire-health-metrics-alerts/), который вы уже выполняете, поскольку publisher является просто ещё одним потребителем того же отчёта.

## MapHealthChecks против UseHealthChecks и где выполняются проверки

Старые руководства используют `app.UseHealthChecks("/healthz")`, который является middleware, замыкающим конвейер при совпадении пути. `MapHealthChecks` является эквивалентом, осведомлённым о маршрутизации, и тем, который следует предпочитать в любом современном minimal API, потому что он участвует в маршрутизации эндпоинтов, что и заставляет `RequireAuthorization`, `RequireHost` и `RequireCors` вообще работать. Эти соглашения об эндпоинтах не имеют смысла в форме middleware. На .NET 8 и новее вы также можете сцепить `.ShortCircuit()` с замапленным эндпоинтом здоровья, чтобы пропустить остаток конвейера middleware для этого запроса, срезав немного накладных расходов на высокочастотном зонде.

Одно эксплуатационное напоминание: проверки выполняются внутри запроса, попавшего на эндпоинт, используя scoped-сервисы, разрешённые для этого запроса. Если проверке нужна scoped-зависимость вроде `DbContext`, это разрешение просто работает, потому что эндпоинт выполняется в области запроса. Это та же самая забота об областях, которая кусает тех, кто тянет scoped-сервисы из долгоживущих singleton; это та самая ловушка, которую призвано решить [использование scoped-сервисов внутри BackgroundService](/ru/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/); health check никогда её не задевает, потому что у него уже есть область запроса.

## Форма, которую стоит запомнить

Endpoint health check сводится к `AddHealthChecks()` для регистрации сервиса, `.AddCheck<T>(...)` (или `.AddDbContextCheck<T>()`, или лямбда) для каждой стоящей зондирования зависимости и `MapHealthChecks("/path")` для его предоставления. Возвращайте `Healthy`, `Degraded` или `Unhealthy` из каждой проверки и помните, что `Unhealthy` возвращает `503`, тогда как оба других по умолчанию `200`. Разделяйте liveness и readiness с помощью тегов и `Predicate`, чтобы нестабильная база данных никогда не перезапускала здоровый под, добавляйте `ResponseWriter`, когда результат должен прочитать человек, защищайте эндпоинт через `RequireHost`, а не авторизацией на пути зонда, и берите `IHealthCheckPublisher`, когда хотите push вместо pull. Это полная поверхность, и каждая строка выше работает на .NET 8 вплоть до .NET 11 без изменений.

## Связанное

- [Как использовать scoped-сервисы внутри BackgroundService в ASP.NET Core 11](/ru/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/)
- [Как организовать эндпоинты minimal API с помощью MapGroup в ASP.NET Core 11](/ru/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [Как настроить аутентификацию JWT bearer в minimal API на ASP.NET Core 11](/ru/2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11/)
- [Как использовать OpenTelemetry с .NET 11 и бесплатным бэкендом](/ru/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/)
- [Как прогреть модель EF Core перед первым запросом](/ru/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/)

## Источники

- [Health checks in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/health-checks)
- [IHealthCheck interface (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.diagnostics.healthchecks.ihealthcheck)
- [HealthCheckOptions (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.diagnostics.healthchecks.healthcheckoptions)
- [AddDbContextCheck extension (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.entityframeworkcorehealthchecksbuilderextensions.adddbcontextcheck)
- [AspNetCore.Diagnostics.HealthChecks (Xabaril, GitHub)](https://github.com/Xabaril/AspNetCore.Diagnostics.HealthChecks)
