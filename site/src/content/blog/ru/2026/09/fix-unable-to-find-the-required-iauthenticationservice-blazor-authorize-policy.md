---
title: "Исправление: Unable to find the required 'IAuthenticationService' service с [Authorize(Policy = ...)] в Blazor"
description: "Страница Blazor Web App с [Authorize] становится конечной точкой, которую проверяет AuthorizationMiddleware, а неудачная проверка вызывает ChallengeAsync, для которого нужен AddAuthentication. Зарегистрируйте настоящую схему или пропускайте конечные точки компонентов дальше, к AuthorizeRouteView."
pubDate: 2026-09-24
template: error-page
tags:
  - "errors"
  - "blazor"
  - "aspnetcore"
  - "dotnet-10"
  - "authorization"
lang: "ru"
translationOf: "2026/09/fix-unable-to-find-the-required-iauthenticationservice-blazor-authorize-policy"
translatedBy: "claude"
translationDate: 2026-09-24
---

`Unable to find the required 'IAuthenticationService' service` на странице Blazor с `@attribute [Authorize(Policy = "...")]` означает, что `AuthorizationMiddleware` из ASP.NET Core проверил вашу политику для HTTP-запроса, проверка не прошла, и middleware попытался вызвать `HttpContext.ChallengeAsync()`, хотя сервисы аутентификации не зарегистрированы. Настоящее исправление: `builder.Services.AddAuthentication(...)` со схемой (обычно cookie), чтобы challenge было куда направить. Если приложение аутентифицирует пользователей исключительно через собственный `AuthenticationStateProvider`, зарегистрируйте `IAuthorizationMiddlewareResultHandler`, который пропускает конечные точки Razor-компонентов, и предоставьте проверку политики `AuthorizeRouteView`.

Всё описанное ниже воспроизведено на .NET 10.0.10 (SDK 10.0.302) и .NET 11 RC 1 (SDK 11.0.100-rc.1.26425.128) со стандартным шаблоном `dotnet new blazor -int Server`. Обе среды выполнения дали одинаковые результаты во всех сценариях.

## Ошибка в контексте

Браузер получает 500 на первый запрос к защищённой странице. Журнал показывает, что challenge исходит от middleware авторизации, а не от Blazor:

```text
fail: Microsoft.AspNetCore.Diagnostics.DeveloperExceptionPageMiddleware[1]
      An unhandled exception has occurred while executing the request.
      System.InvalidOperationException: Unable to find the required 'IAuthenticationService' service. Please add all the required services by calling 'IServiceCollection.AddAuthentication' in the application startup code.
         at Microsoft.AspNetCore.Authentication.AuthenticationHttpContextExtensions.GetAuthenticationService(HttpContext context)
         at Microsoft.AspNetCore.Authentication.AuthenticationHttpContextExtensions.ChallengeAsync(HttpContext context)
         at Microsoft.AspNetCore.Authorization.Policy.AuthorizationMiddlewareResultHandler.<>c__DisplayClass0_0.<<HandleAsync>g__Handle|0>d.MoveNext()
      --- End of stack trace from previous location ---
         at Microsoft.AspNetCore.Authorization.AuthorizationMiddleware.Invoke(HttpContext context)
         at Microsoft.AspNetCore.Diagnostics.DeveloperExceptionPageMiddlewareImpl.Invoke(HttpContext context)
```

Характерный признак, из-за которого люди идут на Stack Overflow и в [dotnet/aspnetcore#55678](https://github.com/dotnet/aspnetcore/issues/55678): переход на страницу изнутри приложения работает, а обновление страницы, открытие закладки или открытие её первой страницей сеанса приводит к сбою.

## Почему это происходит

Исключение возникает из-за сочетания трёх частей ASP.NET Core.

1. **Маршрутизируемый компонент является HTTP-конечной точкой.** Начиная с .NET 8, `MapRazorComponents<App>()` создаёт по одной конечной точке на каждый `@page`. `RazorComponentEndpointFactory` копирует все атрибуты типа компонента в метаданные конечной точки, включая `[Authorize]` (см. комментарий "All attributes defined for the type are included as metadata" в исходном коде).
2. **`UseAuthorization()` добавляется за вас.** `WebApplicationBuilder` автоматически вставляет middleware авторизации, когда зарегистрирован `IAuthorizationHandlerProvider`, а его регистрирует `AddAuthorizationCore()`. Вызывать `app.UseAuthorization()` для этого не нужно; мой пример воспроизведения его вообще не вызывает.
3. **Неудачная проверка политики превращается в challenge.** Стандартный `AuthorizationMiddlewareResultHandler` вызывает `context.ChallengeAsync()` для анонимного пользователя и `context.ForbidAsync()` для аутентифицированного, не прошедшего политику. Обоим нужен `IAuthenticationService`, который регистрирует только `AddAuthentication()`.

Итак, middleware проверяет вашу политику на `HttpContext.User`. Ваш собственный `AuthenticationStateProvider` на этом пути вообще не используется, поэтому следующий момент удивляет многих: **ошибка возникает и для пользователей, которых ваш провайдер считает вошедшими в систему**. В моём примере провайдер, возвращающий principal с ролью `Admin`, всё равно получал 500 на `/admin`, потому что `HttpContext.User` был анонимным.

Клиентская навигация внутри интерактивного circuit никогда не выполняет HTTP-запрос, поэтому middleware её не видит. Там `[Authorize]` проверяет `AuthorizeRouteView` с помощью `AuthenticationStateProvider`. Этим полностью объясняется поведение "работает при клике по ссылке, падает при F5".

В Blazor Server на .NET 7 это работало, потому что единственной конечной точкой был `_Host.cshtml`, а компоненты никогда не сопоставлялись по отдельности. [Миграция на Blazor Web App](/ru/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/) как раз и есть момент, когда большинство людей встречает эту ошибку.

## Минимальное воспроизведение

Blazor Web App, который аутентифицирует пользователя через внешний API и отдаёт результат только через собственный `AuthenticationStateProvider`, без схемы аутентификации ASP.NET Core:

```csharp
// .NET 10.0.10 / .NET 11 RC 1, Program.cs
using System.Security.Claims;
using AuthRepro.Components;
using Microsoft.AspNetCore.Components.Authorization;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddRazorComponents().AddInteractiveServerComponents();
builder.Services.AddCascadingAuthenticationState();
builder.Services.AddScoped<AuthenticationStateProvider, ApiTokenAuthStateProvider>();
builder.Services.AddAuthorizationCore(o =>
    o.AddPolicy("Admins", p => p.RequireRole("Admin")));

var app = builder.Build();
app.UseAntiforgery();
app.MapStaticAssets();
app.MapRazorComponents<App>().AddInteractiveServerRenderMode();
app.Run();

class ApiTokenAuthStateProvider : AuthenticationStateProvider
{
    public override Task<AuthenticationState> GetAuthenticationStateAsync() =>
        Task.FromResult(new AuthenticationState(new ClaimsPrincipal(new ClaimsIdentity())));
}
```

```razor
@* .NET 10 / 11, Components/Pages/Admin.razor *@
@page "/admin"
@attribute [Authorize(Policy = "Admins")]
<h1>Admin area</h1>
```

`Routes.razor` использует `<AuthorizeRouteView>` с блоком `<NotAuthorized>`. Запросы curl к запущенному приложению дают:

| Запрос | Результат |
| --- | --- |
| `GET /` | 200 |
| `GET /admin` | 500, исключение `IAuthenticationService` |
| `GET /admin`, провайдер возвращает Admin | 500, то же исключение |

## Исправление 1: зарегистрировать настоящую схему аутентификации (рекомендуется)

Если пользователи вообще входят в ваше приложение, дайте ASP.NET Core схему, которая знает, кто они, на уровне HTTP-запроса. Для Blazor-приложения с серверной отрисовкой это почти всегда cookie:

```csharp
// .NET 10 / 11, Program.cs
using Microsoft.AspNetCore.Authentication.Cookies;

builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(o =>
    {
        o.LoginPath = "/login";
        o.AccessDeniedPath = "/access-denied";
    });

builder.Services.AddAuthorization(o =>
    o.AddPolicy("Admins", p => p.RequireRole("Admin")));
```

После этого `GET /admin` от анонимного пользователя возвращает `302` на `/login?ReturnUrl=%2Fadmin` вместо исключения. Вошедший пользователь без нужной роли перенаправляется на `AccessDeniedPath`.

Два дополнительных шага делают решение правильным, а не просто бесшумным:

- **Выполняйте вход через cookie.** Если ваш процесс входа вызывает внешний API и получает токен, завершайте его вызовом `HttpContext.SignInAsync(CookieAuthenticationDefaults.AuthenticationScheme, principal)` со статической SSR-страницы или конечной точки minimal API, передавая нужные claims (роли, идентификатор пользователя). Токен API можно сохранить в `AuthenticationProperties` cookie, если он понадобится для последующих вызовов.
- **Уберите собственный `AuthenticationStateProvider`, если он лишь дублировал эту работу.** Встроенный в Blazor `ServerAuthenticationStateProvider` читает `HttpContext.User` во время предварительной отрисовки и передаёт его в circuit, так что страницы, `AuthorizeView` и middleware сходятся в том, кто пользователь.

Если вы не уверены, что лучше подходит вашему приложению, cookie или токены, статья [JWT или cookie-аутентификация в ASP.NET Core](/ru/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/) разбирает этот компромисс. Для Blazor Web App, который сам отдаёт свой UI, cookie выигрывают почти всегда.

Полезная деталь: начиная с .NET 7, если зарегистрирована ровно одна схема, она автоматически становится схемой по умолчанию. `AddAuthentication().AddCookie()` без аргумента схемы по умолчанию тоже сработал в моём примере, перенаправляя на стандартный для обработчика cookie `/Account/Login`. Как только вы добавите вторую схему (OpenID Connect, JWT bearer), явно укажите схемы по умолчанию, иначе вы смените эту ошибку на `No authenticationScheme was specified, and there was no DefaultChallengeScheme found`.

## Исправление 2: пропускать конечные точки компонентов к AuthorizeRouteView

У некоторых приложений действительно нет идентичности на уровне HTTP: приложение Blazor Server вызывает отдельный Web API, хранит токен в состоянии circuit и отдаёт пользователя только через собственный `AuthenticationStateProvider`. Добавление cookie-схемы в таком случае означает переделку процесса входа. Альтернатива: изменить поведение middleware авторизации при неудачной проверке политики с помощью документированной точки расширения [`IAuthorizationMiddlewareResultHandler`](https://learn.microsoft.com/aspnet/core/security/authorization/customizingauthorizationmiddlewareresponse):

```csharp
// .NET 10 / 11, Program.cs
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Policy;
using Microsoft.AspNetCore.Components.Endpoints;

builder.Services.AddSingleton<IAuthorizationMiddlewareResultHandler,
    BlazorAuthorizationMiddlewareResultHandler>();

sealed class BlazorAuthorizationMiddlewareResultHandler : IAuthorizationMiddlewareResultHandler
{
    private readonly AuthorizationMiddlewareResultHandler _default = new();

    public Task HandleAsync(RequestDelegate next, HttpContext context,
        AuthorizationPolicy policy, PolicyAuthorizationResult authorizeResult)
    {
        // Razor component pages: let the request through. AuthorizeRouteView
        // re-checks [Authorize] against the AuthenticationStateProvider.
        if (context.GetEndpoint()?.Metadata.GetMetadata<ComponentTypeMetadata>() is not null)
            return next(context);

        return _default.HandleAsync(next, context, policy, authorizeResult);
    }
}
```

`ComponentTypeMetadata` (публичный, в `Microsoft.AspNetCore.Components.Endpoints`) прикрепляется к каждой конечной точке, которую создаёт `MapRazorComponents`, поэтому пропуск действует только для страниц. Всё остальное сохраняет поведение по умолчанию.

Измеренные результаты с этим обработчиком и без вызова `AddAuthentication()`:

| Запрос | Пользователь провайдера | Результат |
| --- | --- | --- |
| `GET /admin` | анонимный | 200, отрисовано содержимое `<NotAuthorized>` |
| `GET /admin` | с ролью `Admin` | 200, страница отрисована |
| `GET /api/secret` (`RequireAuthorization("Admins")`) | любой | 500, исключение `IAuthenticationService` |

Поймите, на что вы соглашаетесь с этим исправлением:

- **Страницу защищает `AuthorizeRouteView`, а не middleware.** Он отрисовывает `<NotAuthorized>` вместо страницы, как при предварительной отрисовке, так и в circuit. Ваш `Routes.razor` должен использовать `AuthorizeRouteView` (обычный `RouteView` игнорирует `[Authorize]`), а содержимое `<NotAuthorized>` это то, что видят анонимные пользователи, так что разместите там ссылку для входа.
- **Ответ 200, а не 401 или 302.** Поисковые роботы и мониторинг доступности видят успешную страницу. Если нужен редирект, выполните его из блока `<NotAuthorized>` через `NavigationManager.NavigateTo("/login")` или используйте исправление 1.
- **Конечным точкам, не являющимся компонентами, всё равно нужно исправление 1.** Последняя строка таблицы не случайна: у minimal API или контроллера за политикой нет `AuthorizeRouteView`, на который можно положиться. Если такие у вас есть, настоящая схема нужна в любом случае.

Не "исправляйте" это регистрацией пустого обработчика аутентификации, чей challenge ничего не делает. Middleware прерывает конвейер после challenge, и пользователи получают пустую страницу 200 без объяснений, что хуже исключения.

## Исправление 3: перенести проверку в компонент

Если ограничен доступ только к части страницы, атрибут не подходит. Уберите `@attribute [Authorize(...)]` и оберните защищённую разметку:

```razor
@* .NET 10 / 11 *@
@page "/admin"

<AuthorizeView Policy="Admins">
    <Authorized><h1>Admin area</h1></Authorized>
    <NotAuthorized><p>You need the Admin role.</p></NotAuthorized>
</AuthorizeView>
```

Ни метаданных конечной точки, ни проверки в middleware, ни исключения: в том же примере (по-прежнему без `AddAuthentication()`) эта страница возвращала 200 с содержимым `<NotAuthorized>` для анонимного пользователя и разметку администратора для Admin. Это совпадает с наблюдением автора #55678, что `<AuthorizeView>` на первой странице никогда не падал. Для скрытия элементов UI это подходит, но помните: всё, что отрисовано на сервере, отправляется пользователям, прошедшим проверку, поэтому доступ к данным в компоненте тоже должен проверять авторизацию, а не только разметка.

## Подводные камни и похожие ошибки

**`FallbackPolicy` ломает все страницы, включая главную.** `AddAuthorization(o => o.FallbackPolicy = ...RequireAuthenticatedUser()...)` применяется ко всем конечным точкам без собственных метаданных авторизации. В моём примере `GET /` сменил 200 на 500 с тем же исключением. Классические приложения Blazor Server, которые всё ещё используют `_Host.cshtml` и `MapBlazorHub()`, получают ошибку именно так (или через `MapBlazorHub().RequireAuthorization()`), поскольку их компоненты не являются отдельными конечными точками.

**Дело не в `AddAuthorizationCore()` или `AddAuthorization()`.** Оба регистрируют провайдер обработчиков, из-за которого `WebApplicationBuilder` вставляет `UseAuthorization()`. Переключение между ними здесь ничего не меняет.

**Автономный Blazor WebAssembly никогда не показывает эту ошибку.** На клиенте нет конвейера ASP.NET Core. Если WebAssembly-приложение считает пользователя анонимным после входа, это другая проблема, описанная в статье [IsAuthenticated равен false после обновления MSAL](/ru/2026/09/fix-isauthenticated-false-remoteuseraccount-null-blazor-webassembly-msal-upgrade/).

**Режим отрисовки не имеет значения.** Падающий запрос это начальный HTTP GET, который отдаёт страницу, ещё до начала интерактивности. Страницы Static SSR, Interactive Server, WebAssembly и Auto ведут себя одинаково. Если режимы отрисовки всё ещё кажутся туманными, статья [какой режим отрисовки выполняет мой компонент](/ru/2026/09/what-is-a-blazor-render-mode-and-which-one-runs-my-component/) объясняет, где выполняется каждый из них.

**Пользователь из `AuthenticationStateProvider` не попадает в `HttpContext.User`.** Поток идёт только в обратную сторону: `ServerAuthenticationStateProvider` читает из `HttpContext`. Всё, что выполняется до отрисовки компонентов (middleware, фильтры конечных точек, ограничение частоты запросов с разбиением по пользователю), видит только то, что туда положил обработчик аутентификации.

## Связанные материалы

- [Миграция приложения Blazor Server на Blazor Web App в .NET 11](/ru/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/), миграция, во время которой обычно и всплывает эта ошибка.
- [JWT или cookie-аутентификация в ASP.NET Core 11](/ru/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/), для выбора схемы в исправлении 1.
- [Что такое режим отрисовки Blazor и какой из них выполняет мой компонент?](/ru/2026/09/what-is-a-blazor-render-mode-and-which-one-runs-my-component/)
- [Исправление: JavaScript interop calls cannot be issued at this time во время предварительной отрисовки Blazor](/ru/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/), ещё одна ошибка, которая появляется только на первом HTTP-запросе.

## Источники

- [dotnet/aspnetcore#55678](https://github.com/dotnet/aspnetcore/issues/55678), "Exception triggered by AuthorizeAttribute on the first page loaded in a circuit", и [#53732](https://github.com/dotnet/aspnetcore/issues/53732) об `AddAuthorizationCore` без аутентификации в Blazor Web Apps на .NET 8.
- [`RazorComponentEndpointFactory.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Components/Endpoints/src/Builder/RazorComponentEndpointFactory.cs) и [`ComponentTypeMetadata.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Components/Endpoints/src/Builder/ComponentTypeMetadata.cs) на теге `v10.0.0`.
- [`WebApplicationBuilder.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/DefaultBuilder/src/WebApplicationBuilder.cs) (автоматические `UseAuthentication` / `UseAuthorization`) и [`AuthorizationMiddlewareResultHandler.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Security/Authorization/Policy/src/AuthorizationMiddlewareResultHandler.cs).
- [Настройка поведения AuthorizationMiddleware](https://learn.microsoft.com/aspnet/core/security/authorization/customizingauthorizationmiddlewareresponse) и [Аутентификация и авторизация в ASP.NET Core Blazor](https://learn.microsoft.com/aspnet/core/blazor/security/) на Microsoft Learn.
- [Authentication uses single scheme as DefaultScheme](https://learn.microsoft.com/aspnet/core/release-notes/aspnetcore-7.0#authentication-uses-single-scheme-as-defaultscheme) в разделе What's new in ASP.NET Core 7.0.
