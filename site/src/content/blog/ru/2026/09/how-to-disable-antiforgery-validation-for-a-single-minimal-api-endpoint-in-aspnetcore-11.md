---
title: "Как отключить проверку antiforgery для одной конечной точки формы в minimal API в ASP.NET Core 11"
description: "Вызовите .DisableAntiforgery() на этой одной конечной точке или на MapGroup. В ASP.NET Core 11 это отключает и middleware токенов, и новую автоматическую проверку CSRF. Измеренная матрица, ловушки приоритета и более узкие альтернативы."
pubDate: 2026-09-22
template: how-to
tags:
  - "aspnetcore"
  - "dotnet-11"
  - "minimal-apis"
  - "security"
  - "csrf"
lang: "ru"
translationOf: "2026/09/how-to-disable-antiforgery-validation-for-a-single-minimal-api-endpoint-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-09-22
---

**Короткий ответ:** добавьте `.DisableAntiforgery()` к нужному вызову `MapPost` (или к `MapGroup`, в котором находятся только конечные точки для межмашинного взаимодействия). В ASP.NET Core 11 этот единственный вызов исключает конечную точку из **обоих** слоёв, способных отклонить отправку формы: middleware `UseAntiforgery()` на основе токенов и новой автоматической проверки межсайтового CSRF, которую `WebApplication` внедряет за вас. Атрибут `[RequireAntiforgeryToken(false)]` на обработчике делает то же самое. Не используйте общий для всего приложения переключатель `DisableCsrfProtection`, чтобы исправить одну конечную точку: в приложении, которое никогда не вызывает `UseAntiforgery()`, он превращает каждую другую конечную точку формы в `500`.

Всё, что описано ниже, измерено на .NET 11 RC 1 SDK (`11.0.100-rc.1.26425.128`, ASP.NET Core `11.0.0-rc.1`), а для сравнения выполнен прогон на .NET 10.0.10. Матрицу запросов, ловушки приоритета и более узкие альтернативы документация оставляет вам на самостоятельное изучение.

## Почему конечная точка формы отклоняет запросы, которых вы не ожидали

Начиная с .NET 8 любой обработчик minimal API с параметром, привязываемым из формы (`[FromForm]`, `IFormFile`, `IFormCollection`), автоматически получает метаданные antiforgery. Это видно в `RequestDelegateFactory.InferAntiforgeryMetadata`: когда фабрика привязывает параметр из формы, она добавляет к конечной точке `IAntiforgeryMetadata` с `RequiresValidation = true`. Вы не писали никакого атрибута: это сделал за вас тип параметра.

В .NET 11 изменилось то, что читает эти метаданные.

- **.NET 8 по 10**: на них реагирует только `app.UseAntiforgery()`. Если вы его не вызывали, middleware конечных точек выбрасывает `InvalidOperationException: Endpoint HTTP: POST /protected contains anti-forgery metadata, but a middleware was not found that supports anti-forgery.`, и каждый запрос получает `500`. Если вызывали, каждая отправка без действительного токена (и его cookie) получает `400`.
- **.NET 11**: `WebApplication` также автоматически внедряет `CsrfProtectionMiddleware` после маршрутизации (добавлено в Preview 6, см. [ASP.NET Core 11 включает автоматическую защиту от CSRF](/ru/2026/07/aspnetcore-11-automatic-csrf-protection-fetch-metadata-preview-6/)). Он читает те же метаданные, проверяет `Sec-Fetch-Site` и `Origin` и записывает вердикт в `IAntiforgeryValidationFeature`. Затем привязчик формы применяет этот вердикт, возвращая `400`.

Таким образом, в .NET 11 отправка формы может быть отклонена двумя способами, и они срабатывают для разных клиентов. Middleware токенов отклоняет всё, что пришло без токена, включая curl и серверы вашего платёжного провайдера. Проверка CSRF пропускает небраузерных клиентов, но отклоняет межсайтовые отправки из браузера: классический случай, когда сторонняя страница отправляет HTML-форму обратно вам (размещённая платёжная страница, обратный вызов в стиле SAML, форма партнёра с отправкой на ваш адрес).

## Что на самом деле получает каждый клиент

Я собрал одно тестовое приложение с пятью конечными точками и отправил на каждую запросы четырёх видов в четырёх конфигурациях конвейера. "plain" это curl без браузерных заголовков, "cross-site" отправляет `Sec-Fetch-Site: cross-site` плюс чужой `Origin`, "same-origin" отправляет `Sec-Fetch-Site: same-origin`, а "foreign Origin only" имитирует старый браузер, который отправляет `Origin`, но не Fetch Metadata.

```csharp
// .NET 11 RC 1, ASP.NET Core 11.0.0-rc.1
app.MapPost("/protected", ([FromForm] string name) => $"hello {name}");

app.MapPost("/disabled", ([FromForm] string name) => $"hello {name}")
   .DisableAntiforgery();

app.MapPost("/attr",
    [RequireAntiforgeryToken(false)] ([FromForm] string name) => $"hello {name}");

var hooks = app.MapGroup("/hooks").DisableAntiforgery();
hooks.MapPost("/payments", ([FromForm] string name) => $"hello {name}");

app.MapPost("/manual", async (HttpRequest req) =>
    $"hello {(await req.ReadFormAsync())["name"]}");
```

Конвейер .NET 11 по умолчанию (без `AddAntiforgery`, без `UseAntiforgery`), окружение Production:

| Конечная точка | plain | cross-site | same-origin | foreign Origin only |
|---|---|---|---|---|
| `/protected` | 200 | **400** | 200 | **400** |
| `/disabled` | 200 | 200 | 200 | 200 |
| `/attr` | 200 | 200 | 200 | 200 |
| `/hooks/payments` | 200 | 200 | 200 | 200 |
| `/manual` | 200 | 200 | 200 | 200 |

С `builder.Services.AddAntiforgery()` и `app.UseAntiforgery()` (что обычно есть в приложениях Blazor и MVC, обновлённых с .NET 8-10):

| Конечная точка | plain | cross-site | same-origin | foreign Origin only |
|---|---|---|---|---|
| `/protected` | **400** | **400** | **400** | **400** |
| `/disabled`, `/attr`, `/hooks/payments` | 200 | 200 | 200 | 200 |

С `DisableCsrfProtection=true` и без `UseAntiforgery()`: `/protected` возвращает **500** на каждый запрос, в точности как .NET 10.0.10 без `UseAntiforgery()`, что я тоже измерил. Исключённые конечные точки остаются на 200.

Журналы сервера показывают, какой слой сказал "нет". Слой CSRF пишет `Cross-origin CSRF protection marked request POST /protected from origin 'https://evil.example' as invalid.` на уровне `Debug` в категории `Microsoft.AspNetCore.Antiforgery.CsrfProtectionMiddleware`, а затем привязчик пишет `Antiforgery validation failed when reading parameter "string name" from the request body as form.` с вложенным `CsrfValidationException`. Слой токенов даёт то же сообщение привязчика с вложенным `AntiforgeryValidationException: The required antiforgery cookie ".AspNetCore.Antiforgery.<suffix>" is not present.` В Production тело ответа пустое, поэтому, когда ищете причину загадочного `400`, включите `Debug` для `Microsoft.AspNetCore.Http.RequestDelegateFactory` и `Microsoft.AspNetCore.Antiforgery`.

## Отключение для одной конечной точки, шаг за шагом

1. Убедитесь, что конечная точка действительно не рассчитана на браузерные cookie. Единственные безопасные кандидаты это вызывающие стороны, которые аутентифицируются иначе: webhook с подписью HMAC, API-ключ, bearer-токен, mTLS. Если браузер вошедшего пользователя может отправлять туда данные, а обработчик действует от имени его cookie-идентичности, оставьте защиту.
2. Добавьте `.DisableAntiforgery()` к этому `MapPost`. Это метод расширения для любого `IEndpointConventionBuilder` в `Microsoft.AspNetCore.Builder`, поэтому в веб-проекте дополнительный `using` не нужен.
3. Замените снятую защиту собственным доказательством вызывающей стороны. Для webhook с данными формы это проверка подписи по сырому телу, выполняемая в middleware, чтобы она отработала до того, как что-либо привяжет форму.
4. Протестируйте снова с межсайтовым видом запроса из примера выше (`-H 'Sec-Fetch-Site: cross-site' -H 'Origin: https://other.example'`) и с обычным curl, чтобы убедиться, что оба слоя больше не мешают.

Вот полный пример для провайдера, который отправляет `application/x-www-form-urlencoded` и подписывает сырое тело с помощью HMAC-SHA256:

```csharp
// .NET 11 RC 1, ASP.NET Core 11.0.0-rc.1
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

var secret = Encoding.UTF8.GetBytes(app.Configuration["Sms:WebhookSecret"]!);

// Verify the signature over the raw body before anything binds the form.
app.UseWhen(ctx => ctx.Request.Path.StartsWithSegments("/webhooks/sms"), branch =>
    branch.Use(async (ctx, next) =>
    {
        ctx.Request.EnableBuffering();
        using var ms = new MemoryStream();
        await ctx.Request.Body.CopyToAsync(ms);
        ctx.Request.Body.Position = 0;

        var expected = Convert.ToHexStringLower(HMACSHA256.HashData(secret, ms.ToArray()));
        var actual = ctx.Request.Headers["X-Signature"].ToString();

        if (!CryptographicOperations.FixedTimeEquals(
                Encoding.ASCII.GetBytes(expected), Encoding.ASCII.GetBytes(actual)))
        {
            ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return;
        }

        await next(ctx);
    }));

app.MapPost("/webhooks/sms", ([FromForm] SmsStatus status) =>
        Results.Ok($"{status.MessageId}: {status.Status}"))
   .DisableAntiforgery();

app.Run();

record SmsStatus(string MessageId, string Status);
```

Измерено: корректно подписанная отправка вернула 200 и через обычный curl, и с межсайтовыми браузерными заголовками, а неверная подпись вернула 401.

В первом черновике я поместил эту проверку в фильтр конечной точки, и она проваливала каждый подписанный запрос. К моменту запуска фильтра конечной точки параметр `[FromForm]` уже привязан, средство чтения формы опустошило поток запроса, и `EnableBuffering` в этот момент уже нечего буферизовать: фильтр вычислял хеш по **0 байт**. Проверкам подписи по сырому телу место в middleware, и это один из конкретных случаев из статьи [фильтры конечных точек против middleware](/ru/2026/07/endpoint-filters-vs-middleware-in-aspnetcore-11/). Фильтр конечной точки вполне подходит для проверок только по заголовкам, например API-ключа.

## Вариант с атрибутом для обработчиков в виде методов

Если ваши обработчики это статические методы, а не лямбды, атрибут читается лучше и переживает рефакторинги, которые переносят сопоставление маршрутов:

```csharp
// .NET 11 RC 1
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Mvc;

app.MapPost("/webhooks/payments", PaymentHooks.Handle);

static class PaymentHooks
{
    [RequireAntiforgeryToken(false)]
    public static IResult Handle([FromForm] string eventId) => Results.Ok(eventId);
}
```

`RequireAntiforgeryTokenAttribute` напрямую реализует `IAntiforgeryMetadata`, и оба middleware запрашивают у конечной точки `GetMetadata<IAntiforgeryMetadata>()`, поэтому результат идентичен `.DisableAntiforgery()`. Для контроллеров MVC эквивалентом служит `[IgnoreAntiforgeryToken]`; `AntiforgeryMiddlewareAuthorizationFilter` в .NET 11 учитывает вердикт любого из двух middleware.

## Отключение для группы webhook

Когда у вас несколько обратных вызовов от провайдеров, поместите их под один префикс и исключите группу один раз:

```csharp
// .NET 11 RC 1
var hooks = app.MapGroup("/hooks").DisableAntiforgery();
hooks.MapPost("/payments", ([FromForm] string name) => Results.Ok());
hooks.MapPost("/sms", ([FromForm] string name) => Results.Ok());
```

Так решение о безопасности остаётся в одном видимом месте, а не разбросано по файлам, и это главный аргумент в пользу того, чтобы вообще [организовывать конечные точки minimal API с помощью MapGroup](/ru/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/).

## Ловушки приоритета, на которые я наткнулся в эксперименте

**Исключение на уровне группы побеждает включение на уровне конечной точки.** Я ожидал, что этот код снова включит защиту для одной конечной точки внутри отключённой группы:

```csharp
// .NET 11 RC 1: does NOT re-enable validation
hooks.MapPost("/strict", ([FromForm] string name) => $"hello {name}")
     .WithMetadata(new RequireAntiforgeryTokenAttribute());
```

Не включает. `/hooks/strict` вернул 200 на межсайтовый запрос в обоих режимах конвейера. Причина кроется в самом `DisableAntiforgery`: он регистрирует свои метаданные через `builder.Finally(...)`, который выполняется после собственных соглашений конечной точки, а `GetMetadata<T>()` возвращает последний подходящий элемент. "Не требуется" от группы оказывается последним и побеждает. Если одна конечная точка внутри префикса должна оставаться защищённой, не отключайте защиту на уровне группы; отключайте её для каждой конечной точки отдельно или разделите префикс на две группы.

**Тот же порядок `Finally` объясняет, почему `.DisableAntiforgery()` всегда побеждает выведенные метаданные.** Привязчик формы добавляет `RequiresValidation = true` при построении конечной точки; обратный вызов `Finally` добавляет `false` после него. О порядке, в котором вы выстраиваете цепочку вызовов, беспокоиться не нужно.

**Обработчики, читающие форму вручную, не получают никакой защиты.** Конечная точка `/manual` выше читает `req.ReadFormAsync()` без параметра, привязываемого из формы, поэтому метаданные не выводятся, и ни один middleware её не проверяет: межсайтовые отправки получали 200 во всех режимах. Если там нужна защита, её придётся включить явно через `.WithMetadata(new RequireAntiforgeryTokenAttribute())`. Но тогда меняется характер отказа: при недействительном вердикте `FormFeature` отказывается читать тело и выбрасывает `InvalidOperationException: This form is being accessed with a failed antiforgery validation. Validate the IAntiforgeryValidationFeature on the request before reading from the form.`, а это 500, а не 400. Сначала проверьте feature самостоятельно:

```csharp
// .NET 11 RC 1
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Http.Features;

app.MapPost("/manual-protected", async (HttpContext ctx) =>
    {
        if (ctx.Features.Get<IAntiforgeryValidationFeature>() is { IsValid: false })
            return Results.BadRequest();

        var form = await ctx.Request.ReadFormAsync();
        return Results.Ok(form["name"].ToString());
    })
    .WithMetadata(new RequireAntiforgeryTokenAttribute());
```

**`DisableCsrfProtection` не инструмент для отдельной конечной точки.** Он удаляет автоматически внедряемый middleware для всего приложения. Этот же middleware удовлетворяет проверке "a middleware was not found that supports anti-forgery" в приложениях, которые никогда не вызывают `UseAntiforgery()`, поэтому переключение флага ради одного webhook ломает каждую другую конечную точку формы, возвращая 500 (измерено выше). Документация называет его аварийным выходом; так к нему и относитесь.

## Более узкие альтернативы, прежде чем что-либо отключать

Отключение уместно для подписанных вызовов между серверами. Для браузерного трафика есть два более точных варианта.

**Доверяйте конкретной межсайтовой вызывающей стороне через CORS.** Реализация `ICsrfProtection` по умолчанию сверяется с политикой CORS, применяемой к конечной точке: если `Origin` запроса разрешён именованной политикой или политикой по умолчанию, отправка принимается даже при `Sec-Fetch-Site`, равном `cross-site`. `AllowAnyOrigin` намеренно игнорируется.

```csharp
// .NET 11 RC 1
builder.Services.AddCors(o => o.AddPolicy("partner",
    p => p.WithOrigins("https://pay.partner.example")));

var app = builder.Build();
app.UseCors();

app.MapPost("/partner-callback", ([FromForm] string orderId) => Results.Ok(orderId))
   .RequireCors("partner");
```

Измерено на конвейере по умолчанию: origin партнёра получил 200, чужой origin и соседний `same-site` по-прежнему получали 400, обычный curl получил 200. Две оговорки. Без `app.UseCors()` конечная точка выбрасывает `contains CORS metadata, but a middleware was not found that supports CORS` (500). И это ослабляет только слой Fetch Metadata: при наличии `UseAntiforgery()` в конвейере проверка токенов выполняется после, переопределяет вердикт, и отправка партнёра снова получила 400. Если вы уже сочетаете CORS с cookie или JWT, сторону политики описывает статья [о настройке CORS для API, защищённого JWT](/ru/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/).

**Доверьте фреймворку обратные вызовы от провайдеров идентификации.** Обратные вызовы OpenID Connect с `response_mode=form_post` и WS-Federation по своей природе являются межсайтовыми отправками форм. В .NET 11 обработчики удалённой аутентификации подавляют недействительный вердикт, пока обслуживают путь обратного вызова (`RemoteAuthenticationAntiforgery` в исходниках), потому что параметр `state` и correlation cookie уже защищают их. Вам не нужен `.DisableAntiforgery()` на `/signin-oidc`, да и поставить его туда нельзя, поскольку обработчик является middleware, а не конечной точкой.

## Подводные камни при обновлении с .NET 8, 9 или 10

- **Приложения, которые уже вызывают `UseAntiforgery()`, не видят изменений для трафика с того же origin**, потому что проверка токенов главенствует и перезаписывает вердикт CSRF. Уже имеющиеся вызовы `.DisableAntiforgery()` продолжают работать без изменений.
- **Приложения, которые никогда не вызывали `UseAntiforgery()`, перестают выбрасывать 500** на конечных точках форм в .NET 11 (middleware CSRF удовлетворяет проверке конечной точки), но начинают возвращать 400 на межсайтовые отправки из браузера. Это может выглядеть как случайная регрессия в форме, в которую отправляет данные соседний поддомен, поскольку `same-site` тоже отклоняется.
- **400 от конечной точки формы не всегда связан с antiforgery.** Отсутствующий или неверный `Content-Type` даёт [415 Unsupported Media Type](/ru/2026/07/fix-415-unsupported-media-type-from-a-minimal-api-endpoint-in-aspnetcore-11/), а ошибки в форме привязки дают null, как в случае со [словарём `[FromForm]`, который всегда null](/ru/2026/08/fix-fromform-dictionary-is-always-null-in-a-minimal-api/). Проверьте категорию журнала, прежде чем что-либо отключать.
- **Ошибки токенов после развёртывания это другая ошибка.** Если формы с того же origin отказывают только после масштабирования или перезапуска, дело в ключах Data Protection, которые разобраны в статье [the antiforgery token could not be decrypted](/ru/2026/06/fix-the-antiforgery-token-could-not-be-decrypted-in-aspnetcore/), а не в отсутствующем исключении.
- **Маршруты с коротким замыканием не могут нести обязательные метаданные antiforgery.** `.ShortCircuit()` на конечной точке формы, которая всё ещё требует проверки, даёт 500 во время запроса (`contains anti-forgery metadata, but this endpoint is marked with short circuit and it will execute on Routing Middleware`). Как только защита для конечной точки отключена, эта проверка больше не применяется.

## Связанные материалы

- [ASP.NET Core 11 Preview 6 включает автоматическую защиту от CSRF](/ru/2026/07/aspnetcore-11-automatic-csrf-protection-fetch-metadata-preview-6/)
- [Как организовать конечные точки minimal API с помощью MapGroup в ASP.NET Core 11](/ru/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [Фильтры конечных точек против middleware в ASP.NET Core 11](/ru/2026/07/endpoint-filters-vs-middleware-in-aspnetcore-11/)
- [Исправление: "415 Unsupported Media Type" от конечной точки minimal API в ASP.NET Core 11](/ru/2026/07/fix-415-unsupported-media-type-from-a-minimal-api-endpoint-in-aspnetcore-11/)
- [Исправление: The antiforgery token could not be decrypted в ASP.NET Core](/ru/2026/06/fix-the-antiforgery-token-could-not-be-decrypted-in-aspnetcore/)

## Источники

- [Prevent Cross-Site Request Forgery (XSRF/CSRF) attacks in ASP.NET Core](https://learn.microsoft.com/aspnet/core/security/anti-request-forgery) (MS Learn, разделы об автоматической защите от CSRF и исключении для отдельных конечных точек)
- [Заметки о выпуске ASP.NET Core в .NET 11 Preview 6: автоматическая межсайтовая защита (CSRF)](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/aspnetcore.md)
- [dotnet/aspnetcore #66585](https://github.com/dotnet/aspnetcore/pull/66585) и [#67082](https://github.com/dotnet/aspnetcore/pull/67082), PR с middleware CSRF
- Исходный код на теге `v11.0.0-rc.1.26425.128`: [`CsrfProtectionMiddleware.cs`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.1.26425.128/src/DefaultBuilder/src/Internal/CsrfProtectionMiddleware.cs), [`DefaultCsrfProtection.cs`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.1.26425.128/src/DefaultBuilder/src/Internal/DefaultCsrfProtection.cs), [`RoutingEndpointConventionBuilderExtensions.cs`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.1.26425.128/src/Http/Routing/src/Builder/RoutingEndpointConventionBuilderExtensions.cs), [`RequireAntiforgeryTokenAttribute.cs`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.1.26425.128/src/Antiforgery/src/RequireAntiforgeryTokenAttribute.cs)
