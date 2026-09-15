---
title: "Исправление: конечные точки API в ASP.NET Core возвращают 401 вместо перенаправления на страницу входа после обновления до .NET 10"
description: "В .NET 10 аутентификация через cookie отвечает API-подобным конечным точкам кодом 401/403 вместо перенаправления на страницу входа. Верните прежнее поведение для отдельной конечной точки, глобально или с помощью переключателя AppContext."
pubDate: 2026-09-15
template: error-page
tags:
  - "errors"
  - "aspnetcore"
  - "dotnet-10"
  - "authentication"
  - "cookies"
  - "csharp"
lang: "ru"
translationOf: "2026/09/fix-aspnetcore-api-endpoints-return-401-instead-of-redirecting-to-login-dotnet-10"
translatedBy: "claude"
translationDate: 2026-09-15
---

В ASP.NET Core 10 неаутентифицированные запросы к "API-подобным" конечным точкам, защищённым аутентификацией через cookie, получают `401` (а запрещённые запросы получают `403`) вместо `302` на ваш `LoginPath`. Это касается контроллеров с `[ApiController]`, минимальных API, которые читают или записывают JSON, обработчиков, возвращающих `TypedResults`, и SignalR. Изменение сделано намеренно. Если браузер действительно переходит на такую конечную точку, добавьте к ней `.AllowCookieRedirect()` (или `[AllowCookieRedirect]`). Чтобы вернуть поведение .NET 9 для всего приложения, переопределите `OnRedirectToLogin`/`OnRedirectToAccessDenied` или установите переключатель AppContext `Microsoft.AspNetCore.Authentication.Cookies.IgnoreRedirectMetadata`. Всё описанное ниже измерено на ASP.NET Core 10.0.10 (SDK 10.0.302) в сравнении с 9.0.20.

## Ошибка в контексте

После обновления не возникает никакого исключения, и в журнале ничего нет. Страница входа просто перестаёт появляться. Запрос, который раньше перенаправлялся на `/login`, теперь возвращает вот что:

```text
HTTP/1.1 401 Unauthorized
Content-Length: 0
Server: Kestrel
Location: http://localhost:5103/login?ReturnUrl=%2Fm%2Fdto
```

Обратите внимание, что заголовок `Location` по-прежнему присутствует. Обработчик cookie вычисляет URL входа точно так же, как раньше, и записывает его в ответ, но устанавливает статус `401` вместо `302`, поэтому ни браузеры, ни `HttpClient` по нему не переходят. С вошедшим пользователем, который не проходит политику авторизации, происходит то же самое: `403 Forbidden` с `Location: /denied?ReturnUrl=...` вместо перенаправления на `AccessDeniedPath`.

Типичные симптомы:

- Приложение на Razor Pages или MVC с несколькими конечными точками минимального API: если открыть одну из них во вкладке браузера, вместо формы входа отображается пустая страница (или собственная страница 401 браузера).
- Фронтенд-вызов `fetch`, который раньше следовал за `302`, попадал на HTML страницы входа и определял это через `res.redirected`, теперь получает `401` и выбрасывает исключение в другой ветке кода.
- Интеграционные тесты, проверявшие перенаправление на страницу входа (`302` с `AllowAutoRedirect = false` или итоговый URL на `/Account/Login` с клиентом по умолчанию), теперь падают именно для перечисленных выше конечных точек, а остальные по-прежнему проходят.

## Почему .NET 10 перестал перенаправлять для этих конечных точек

Это критическое изменение [Cookie login redirects are disabled for known API endpoints](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/10/cookie-authentication-api-endpoints), появившееся в .NET 10 Preview 7 и общедоступное начиная с 10.0.0 (ноябрь 2025). Оно закрывает запрос, который тянется с 2019 года ([dotnet/aspnetcore#9039, "ApiController redirects to login page"](https://github.com/dotnet/aspnetcore/issues/9039)): HTML-страница входа бесполезна для JSON-клиента.

Механизм основан на метаданных конечной точки. Делегат `OnRedirectToLogin` по умолчанию в `CookieAuthenticationEvents` теперь выглядит так:

```csharp
// ASP.NET Core 10.0.0, src/Security/Authentication/Cookies/src/CookieAuthenticationEvents.cs (abridged)
public Func<RedirectContext<CookieAuthenticationOptions>, Task> OnRedirectToLogin { get; set; } = context =>
{
    if (IsAjaxRequest(context.Request) || IsCookieRedirectDisabledByMetadata(context.HttpContext))
    {
        context.Response.Headers.Location = context.RedirectUri;
        context.Response.StatusCode = 401;
    }
    else
    {
        context.Response.Redirect(context.RedirectUri);
    }
    return Task.CompletedTask;
};

private static bool IsCookieRedirectDisabledByMetadata(HttpContext context)
{
    if (_ignoreCookieRedirectMetadata) // AppContext switch, read once
    {
        return false;
    }
    var endpoint = context.GetEndpoint();
    return endpoint?.Metadata.GetMetadata<IDisableCookieRedirectMetadata>() is not null &&
        endpoint?.Metadata.GetMetadata<IAllowCookieRedirectMetadata>() is null;
}
```

Ветка `IsAjaxRequest` (заголовок `X-Requested-With: XMLHttpRequest`) существует уже много лет. Новое здесь метаданные `IDisableCookieRedirectMetadata`, которые фреймворк автоматически добавляет в следующих местах:

- `ApiControllerAttribute` теперь реализует `IDisableCookieRedirectMetadata`, поэтому их несёт каждое действие контроллера с `[ApiController]`.
- `RequestDelegateFactory` (и Request Delegate Generator, используемый для Native AOT) добавляет их, когда у обработчика минимального API есть параметр тела в формате JSON или когда его возвращаемый тип сериализуется в JSON.
- API-ориентированные типы `TypedResults` (`Ok`, `Ok<T>`, `Created`, `Accepted`, `NotFound<T>`, `BadRequest`, `Conflict`, `ValidationProblem`, `ProblemHttpResult`, `JsonHttpResult<T>`, `ServerSentEventsResult<T>` и им подобные) добавляют их в своём `PopulateMetadata`.
- `MapHub` и `MapConnectionHandler` добавляют их для SignalR.

Одна деталь сбивает с толку тех, кто ищет информацию об этом: страница Microsoft Learn до сих пор называет интерфейс-маркер `IApiEndpointMetadata`. Так он назывался в Preview 7. На ревью API его переименовали до GA в [dotnet/aspnetcore#63283](https://github.com/dotnet/aspnetcore/pull/63283), где также добавили механизм отказа `IAllowCookieRedirectMetadata`, методы расширения `AllowCookieRedirect`/`DisableCookieRedirect` и переключатель AppContext. В выпущенном приложении на .NET 10 `IApiEndpointMetadata` не существует. Типы называются `IDisableCookieRedirectMetadata` и `IAllowCookieRedirectMetadata` и находятся в `Microsoft.AspNetCore.Http.Metadata`.

## Минимальное воспроизведение

Одно файловое приложение, запущенное один раз на среде выполнения .NET 9.0.20 и один раз на 10.0.10:

```csharp
// .NET 10, ASP.NET Core 10.0.10, run with: dotnet run probe.cs
#:sdk Microsoft.NET.Sdk.Web

using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(o => { o.LoginPath = "/login"; o.AccessDeniedPath = "/denied"; });
builder.Services.AddAuthorization();
builder.Services.AddControllers();

var app = builder.Build();
app.UseAuthentication();
app.UseAuthorization();

var m = app.MapGroup("/m").RequireAuthorization();
m.MapGet("/string", () => "plain text");                          // text/plain
m.MapGet("/dto", () => new Todo(1, "json"));                       // JSON response
m.MapGet("/typed", () => TypedResults.Ok(new Todo(1, "typed")));   // TypedResults
m.MapGet("/iresult", () => Results.Ok(new Todo(1, "iresult")));    // returns IResult
m.MapPost("/body", (Todo t) => "got body");                        // JSON request body
app.MapControllers();
app.Run();

public record Todo(int Id, string Title);

[ApiController, Route("c/api"), Authorize]
public class ApiCtl : ControllerBase { [HttpGet] public Todo Get() => new(1, "api"); }

[Route("c/mvc"), Authorize]
public class MvcCtl : Controller { [HttpGet] public Todo Get() => new(1, "mvc"); }
```

Ниже результаты `curl -D -` без cookie. Первые два столбца получены на одном и том же коде; третий соответствует 10.0.10 с `IgnoreRedirectMetadata`, установленным в `true`:

| Конечная точка | 9.0.20 | 10.0.10 | 10.0.10 + переключатель |
| --- | --- | --- | --- |
| `GET /m/string` (возвращает `string`) | 302 | 302 | 302 |
| `GET /m/dto` (возвращает record) | 302 | **401** | 302 |
| `GET` асинхронный обработчик, возвращающий `Task<Todo>` | 302 | **401** | 302 |
| `GET /m/typed` (`TypedResults.Ok`) | 302 | **401** | 302 |
| `Results<Ok<Todo>, NotFound>` | 302 | **401** | 302 |
| `TypedResults.Json(...)` | 302 | **401** | 302 |
| `GET /m/iresult` (`Results.Ok`, объявлен как `IResult`) | 302 | 302 | 302 |
| `TypedResults.Text`, `TypedResults.File`, `TypedResults.Redirect` | 302 | 302 | 302 |
| `POST /m/body` (тело в JSON) | 302 | **401** | 302 |
| Действие `[ApiController]` | 302 | **401** | 302 |
| Действие обычного `Controller` (без `[ApiController]`) | 302 | 302 | 302 |
| Любая конечная точка с `X-Requested-With: XMLHttpRequest` | 401 | 401 | 401 |
| Пользователь вошёл, не проходит `RequireRole`, JSON-конечная точка | 302 на `/denied` | **403** | 302 на `/denied` |
| Пользователь вошёл, не проходит `RequireRole`, конечная точка со `string` | 302 на `/denied` | 302 на `/denied` | 302 на `/denied` |

Так что эмпирическое правило вовсе не про "API" в каком-либо архитектурном смысле. Значение имеют метаданные конечной точки. `Results.Ok(...)` продолжает перенаправлять, а `TypedResults.Ok(...)` нет, потому что `IResult` скрывает конкретный тип от вывода метаданных. Разница между этими двумя фабриками разобрана в статье [typed results vs IResult vs IActionResult](/ru/2026/07/typed-results-vs-iresult-vs-iactionresult-in-aspnetcore-11/).

## Исправление в деталях

Выберите первый вариант, который соответствует тому, чем конечная точка является на самом деле.

### 1. Конечная точка вызывается из кода: оставьте 401 и исправьте клиент

Если вызывающая сторона это `fetch`, `HttpClient` или мобильное приложение, новое поведение правильное, а старый `302` на HTML-страницу был ошибкой, которую вы обходили. Обрабатывайте код состояния вместо того, чтобы угадывать по перенаправлениям:

```javascript
// Browser fetch against an ASP.NET Core 10 cookie-authenticated API
const res = await fetch("/api/todos", { credentials: "same-origin" });
if (res.status === 401) {
  // Cookie missing or expired: send the user to the login page ourselves
  location.href = "/login?ReturnUrl=" + encodeURIComponent(location.pathname);
} else if (res.status === 403) {
  location.href = "/denied";
} else {
  const todos = await res.json();
}
```

Заодно удалите все проверки `res.redirected` или `res.url.includes("/login")`: в .NET 10 для этих конечных точек это мёртвый код. Если ваше SPA и API работают на разных источниках (origin), вопросы учётных данных и CORS это отдельная тема, разобранная в статье [JWT vs cookie authentication in ASP.NET Core](/ru/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/).

### 2. Браузер переходит на конечную точку: включите перенаправление обратно с `AllowCookieRedirect`

Для тех немногих конечных точек, которые пользователь действительно открывает во вкладке (ссылка на экспорт, возвращающая JSON, ссылка "просмотреть исходные данные" на странице администратора, действие `[ApiController]`, на которое напрямую ссылаются старые представления MVC), восстановите перенаправление для отдельной конечной точки:

```csharp
// .NET 10, ASP.NET Core 10.0.10
app.MapGet("/export/orders", (OrderService s) => s.GetAll())
   .RequireAuthorization()
   .AllowCookieRedirect();

[ApiController, Route("api/reports"), Authorize]
public class ReportsController : ControllerBase
{
    [HttpGet("download"), AllowCookieRedirect]
    public ReportDto Download() => new(/* ... */);
}
```

`IAllowCookieRedirectMetadata` имеет приоритет над `IDisableCookieRedirectMetadata` независимо от порядка, поэтому это работает и для группы (`app.MapGroup("/export").AllowCookieRedirect()`). В тестовом приложении `/m/dto` с `.AllowCookieRedirect()` вернулась к `302`, как и действие `[ApiController]` с `[AllowCookieRedirect]`. Существует и обратный вариант. `.DisableCookieRedirect()` заставляет конечную точку, возвращающую `string`, отвечать `401`, что полезно для конечных точек проверки работоспособности или диагностики, которые никогда не должны показывать страницу входа.

### 3. Смешанное приложение: перенаправляйте только настоящие переходы браузера

Если у вас много конечных точек обоих видов, аккуратнее принимать решение для каждого запроса, а не для каждой конечной точки. Все современные основные браузеры (Chrome, Edge, Firefox, Safari 16.4+) отправляют [`Sec-Fetch-Mode: navigate`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Sec-Fetch-Mode) при переходе верхнего уровня и `cors`/`same-origin` при `fetch`:

```csharp
// .NET 10, ASP.NET Core 10.0.10
builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(options =>
    {
        options.LoginPath = "/login";
        options.AccessDeniedPath = "/denied";

        options.Events.OnRedirectToLogin = context =>
        {
            if (IsBrowserNavigation(context.Request))
                context.Response.Redirect(context.RedirectUri);
            else
                context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return Task.CompletedTask;
        };
        options.Events.OnRedirectToAccessDenied = context =>
        {
            if (IsBrowserNavigation(context.Request))
                context.Response.Redirect(context.RedirectUri);
            else
                context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return Task.CompletedTask;
        };
    });

// ... app.Run();

static bool IsBrowserNavigation(HttpRequest request)
{
    var mode = request.Headers["Sec-Fetch-Mode"].ToString();
    if (mode.Length > 0)
        return mode == "navigate";

    // Clients without Fetch Metadata headers: fall back to the Accept header
    return HttpMethods.IsGet(request.Method)
        && request.Headers.Accept.ToString().Contains("text/html");
}
```

Замеры на 10.0.10 для части с `OnRedirectToLogin`: `/m/dto` с `Sec-Fetch-Mode: navigate` получила `302`, `/m/string` с `Sec-Fetch-Mode: cors` получила `401`, а голый `curl` (без Fetch Metadata, `Accept: */*`) получил `401` на каждой конечной точке, включая те, которые фреймворк перенаправил бы. Поскольку этот код заменяет делегат по умолчанию, метаданные конечной точки больше вообще не учитываются: решает запрос, а не конечная точка.

### 4. Всегда перенаправлять, в точности как раньше

Это фрагмент со страницы критического изменения. Используйте его, когда приложение представляет собой сайт с серверным рендерингом и ни у одной из его конечных точек нет вызывающей стороны, кроме браузера:

```csharp
// .NET 10, ASP.NET Core 10.0.10
builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(options =>
    {
        options.Events.OnRedirectToLogin = context =>
        {
            context.Response.Redirect(context.RedirectUri);
            return Task.CompletedTask;
        };
        options.Events.OnRedirectToAccessDenied = context =>
        {
            context.Response.Redirect(context.RedirectUri);
            return Task.CompletedTask;
        };
    });
```

Учтите, что так перенаправляются и XHR-запросы, чего .NET 9 не делал. Если нужна точная семантика .NET 9 (`401` для `X-Requested-With: XMLHttpRequest`, перенаправление для всего остального), переключатель из варианта 5 делает это одной строкой.

### 5. Переключатель AppContext: поведение .NET 9 без написания событий

Переключателя нет на странице Microsoft Learn, но он выпущен в 10.0.0 (из PR #63283) и представляет собой наименее инвазивный способ вернуться к семантике .NET 9. Задайте его в файле проекта:

```xml
<!-- .NET 10, in the web project's .csproj -->
<ItemGroup>
  <RuntimeHostConfigurationOption Include="Microsoft.AspNetCore.Authentication.Cookies.IgnoreRedirectMetadata"
                                  Value="true" />
</ItemGroup>
```

или первой строкой `Program.cs`:

```csharp
// .NET 10, must run before the cookie handler is first used
AppContext.SetSwitch("Microsoft.AspNetCore.Authentication.Cookies.IgnoreRedirectMetadata", true);
```

Элемент `RuntimeHostConfigurationOption` превращается в запись `configProperties` в `bin/.../<app>.runtimeconfig.json`. Я проверил и эту запись, и вызов `SetSwitch`, и каждый из них дал столбец "10.0.10 + переключатель" из таблицы выше: все конечные точки снова перенаправляют, а XHR-запросы по-прежнему получают `401`. Относитесь к нему как к временной подпорке на время миграции, а не как к конечной цели. Он отключает метаданные для всего приложения, включая маркер на хабах SignalR, поэтому неаутентифицированный запрос negotiate возвращается к правилу до .NET 10: от перенаправления на HTML-страницу его удерживает только заголовок `X-Requested-With: XMLHttpRequest`.

## Подводные камни и похожие проблемы

**У вас уже был собственный `OnRedirectToLogin`.** Тогда для вас ничего не изменилось, и вы можете удивляться, почему приложение коллеги ведёт себя иначе. Проверка метаданных находится внутри делегата *по умолчанию*. Любое приложение, заменившее `OnRedirectToLogin` или унаследовавшееся от `CookieAuthenticationEvents` с переопределением `RedirectToLogin`, полностью её обходит. Это работает и в обратную сторону: если вам нужно новое поведение *и* собственное событие (например, для журналирования неудачных входов), вызовите свою логику, а затем самостоятельно воспроизведите проверку `IDisableCookieRedirectMetadata`.

**Переключатель читается один раз.** `_ignoreCookieRedirectMetadata` это поле `static readonly` в `CookieAuthenticationEvents`. Установка переключателя после первого запроса или его изменение в тесте после запуска хоста ни на что не влияет.

**Эти метаданные учитывает только обработчик cookie.** В репозитории aspnetcore единственный потребитель `IDisableCookieRedirectMetadata` это `CookieAuthenticationEvents`. Если ваша `DefaultChallengeScheme` это OpenID Connect (Microsoft.Identity.Web, Entra ID, Auth0), challenge выполняет обработчик OIDC, и он по-прежнему перенаправляет к поставщику удостоверений для каждой конечной точки. Если вы видите там `401`, значит, для этой конечной точки схемой challenge является схема cookie, обычно из-за явного `[Authorize(AuthenticationSchemes = ...)]` или политики.

**Интеграционные тесты.** Клиенты `WebApplicationFactory` по умолчанию следуют за перенаправлениями, поэтому тесты, проверявшие, что "неаутентифицированный запрос оказывается на странице входа", теперь видят `401` для конечных точек API. Обновите проверку, а не добавляйте `AllowCookieRedirect` только ради того, чтобы тесты оставались зелёными; шаблоны настройки описаны в статье [интеграционные тесты с WebApplicationFactory](/ru/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/).

**Native AOT ведёт себя так же.** Request Delegate Generator генерирует локальный для файла класс `DisableCookieRedirectMetadata` и добавляет его при тех же условиях, связанных с JSON, что и фабрика на основе рефлексии, поэтому сборки AOT и JIT ведут себя одинаково.

**.NET 11 это сохраняет.** Та же проверка `IsCookieRedirectDisabledByMetadata` есть в `main`, поэтому если вы переходите с .NET 8 или 9 сразу на 11, этот пункт должен быть в вашем списке рядом с другими изменениями аутентификации из [чек-листа миграции с .NET 8 на .NET 11](/ru/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/).

**Не эта проблема: 401 с bearer-токеном или 405.** Если конечная точка использует JWT bearer и вы получаете `401` с заголовком `WWW-Authenticate: Bearer`, отклоняется сам токен; см. статью [почему JWT в ASP.NET Core возвращает 401 даже с действительным токеном](/ru/2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token/). Если вы получаете `405` с заголовком `Allow`, маршрутизация отклонила HTTP-метод ещё до запуска аутентификации; см. статью [405 Method Not Allowed вместо 401 с JWT bearer](/ru/2026/06/fix-405-method-not-allowed-instead-of-401-with-jwt-bearer-in-aspnetcore/). Изменение cookie в .NET 10 всегда даёт `401`/`403` с заголовком `Location` и без заголовка `WWW-Authenticate`.

## Связанные материалы

- [JWT vs cookie authentication in ASP.NET Core](/ru/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/)
- [Typed results vs IResult vs IActionResult](/ru/2026/07/typed-results-vs-iresult-vs-iactionresult-in-aspnetcore-11/)
- [Как писать интеграционные тесты с WebApplicationFactory](/ru/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/)
- [Исправление: 405 Method Not Allowed вместо 401 с JWT bearer](/ru/2026/06/fix-405-method-not-allowed-instead-of-401-with-jwt-bearer-in-aspnetcore/)
- [Миграция с .NET 8 на .NET 11: полный чек-лист](/ru/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/)

## Источники

- [Breaking change: Cookie login redirects are disabled for known API endpoints](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/10/cookie-authentication-api-endpoints) (Microsoft Learn) и объявление [aspnet/Announcements#525](https://github.com/aspnet/Announcements/issues/525).
- [dotnet/aspnetcore#62816: Avoid cookie login redirects for known API endpoints](https://github.com/dotnet/aspnetcore/pull/62816), исходное изменение.
- [dotnet/aspnetcore#63283: Address API review feedback for what was IApiEndpointMetadata](https://github.com/dotnet/aspnetcore/pull/63283), переименование, `AllowCookieRedirect` и переключатель `IgnoreRedirectMetadata`.
- [`CookieAuthenticationEvents.cs` на v10.0.0](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Security/Authentication/Cookies/src/CookieAuthenticationEvents.cs) и [`RequestDelegateFactory.cs` на v10.0.12](https://github.com/dotnet/aspnetcore/blob/v10.0.12/src/Http/Http.Extensions/src/RequestDelegateFactory.cs).
- [dotnet/aspnetcore#9039: ApiController redirects to login page](https://github.com/dotnet/aspnetcore/issues/9039), запрос 2019 года, стоящий за этим изменением.
