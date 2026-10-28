---
title: "Исправление: Response.Cookies.Append не устанавливает cookie в браузере в ASP.NET Core"
description: "Заголовок Set-Cookie отправляется, но браузер отклоняет его или так и не сохраняет cookie. Исправляем SameSite=None без Secure, отсутствие credentials: 'include' вместе с AllowCredentials, политику согласия и поздние вызовы Append."
pubDate: 2026-10-28
template: error-page
tags:
  - "errors"
  - "aspnetcore"
  - "dotnet"
  - "dotnet-10"
  - "cookies"
  - "cors"
lang: "ru"
translationOf: "2026/10/fix-response-cookies-append-does-not-set-the-cookie-in-aspnet-core"
translatedBy: "claude"
translationDate: 2026-10-28
---

Решение: `Response.Cookies.Append` почти никогда не дает сбой на сервере. Метод записывает заголовок `Set-Cookie`, а браузер затем молча отказывается его сохранять. В порядке убывания вероятности причины такие: запрос был кросс-доменным, и клиент не отправил `credentials: 'include'` (или сервер не вызвал `AllowCredentials()`), у cookie указан `SameSite=None` без `Secure`, проверка согласия `CookiePolicy` подавила cookie, не помеченный как `IsEssential`, или `Append` выполнился уже после того, как ответ начал отправляться. Откройте вкладку Network в DevTools браузера, выберите ответ и посмотрите на вложенную вкладку Cookies: Chromium точно сообщает, какое правило заблокировало cookie.

Все, что ниже, относится к .NET 10 и ASP.NET Core 10 (в предварительных версиях .NET 11 поведение идентично и не меняется со времен ASP.NET Core 3.1). Поведение браузеров описано для актуальных выпусков Chrome, Firefox и Safari на октябрь 2026 года.

```text
// Roughly what Chrome DevTools shows under Network > (response) > Cookies
Set-Cookie: session=abc123; path=/; samesite=none
  ⚠ This attempt to set a cookie via a Set-Cookie header was blocked because it had the
    "SameSite=None" attribute but did not have the "Secure" attribute, which is required
    in order to use "SameSite=None".
```

А в журнале ASP.NET Core, если для логгера `Microsoft.AspNetCore.Http.ResponseCookies` включен уровень `Warning`:

```text
warn: Microsoft.AspNetCore.Http.ResponseCookies
      The cookie 'session' has set 'SameSite=None' and must also set 'Secure'.
```

## Почему cookie так и не попадает в document.cookie или в следующий запрос

`Response.Cookies.Append` представляет собой тонкую обертку. В исходном коде ASP.NET Core (`src/Http/Http/src/Internal/ResponseCookies.cs`) он делает три вещи: если `SameSite` равен `None`, а `Secure` равен `false`, записывает в журнал приведенное выше предупреждение, кодирует значение для URL с помощью `Uri.EscapeDataString` и добавляет к ответу новый заголовок `Set-Cookie`. На этом все. Он не проверяет домен, не проверяет CORS и не выбрасывает исключение, когда cookie будет отклонен. Все реальные сбои происходят позже, внутри браузера, который применяет к каждому заголовку `Set-Cookie` целый набор правил:

1. **Режим учетных данных CORS.** Для кросс-доменного `fetch` или `XMLHttpRequest` браузер полностью игнорирует `Set-Cookie`, если запрос не был выполнен в режиме учетных данных (`credentials: 'include'` / `withCredentials = true`) и ответ не содержал `Access-Control-Allow-Credentials: true` с явным (не `*`) `Access-Control-Allow-Origin`.
2. **SameSite.** Cookie с `SameSite=None` без `Secure` отклоняется всеми современными браузерами. Cookie с `Lax` или `Strict`, установленный в межсайтовом ответе, отклоняется как сторонний cookie.
3. **Secure.** Cookie с `Secure`, установленный по обычному `http://`, отклоняется, с одним исключением: Chrome (начиная с 89) и Firefox (начиная с 75) считают `http://localhost` безопасным для этой цели. Safari так не делает.
4. **Domain и Path.** Атрибут `Domain`, который не соответствует хосту ответа, приводит к отклонению. Если `Path` не покрывает URL, который вы запрашиваете позже, cookie сохраняется, но никогда не отправляется обратно, и это выглядит точно так же, как "не установлен".
5. **Размер.** Отдельный cookie (имя плюс значение) больше 4096 байт отбрасывается.

Помимо правил браузера, в самом ASP.NET Core есть два места, где cookie может исчезнуть еще до отправки: проверка согласия в `CookiePolicyMiddleware` и граница "ответ уже начал отправляться".

## Минимальный пример: dev-сервер React вызывает API на ASP.NET Core

Именно такая конфигурация стоит за большинством вопросов "cookie не устанавливается" на Stack Overflow: SPA на одном порту, API на другом.

```csharp
// .NET 10, ASP.NET Core 10 - Program.cs (broken)
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
    p.WithOrigins("http://localhost:5173")
     .AllowAnyHeader()
     .AllowAnyMethod()));

var app = builder.Build();
app.UseCors();

app.MapPost("/login", (HttpContext ctx) =>
{
    ctx.Response.Cookies.Append("session", "abc123", new CookieOptions
    {
        HttpOnly = true,
        SameSite = SameSiteMode.None
    });
    return Results.Ok();
});

app.MapGet("/me", (HttpContext ctx) =>
    ctx.Request.Cookies.TryGetValue("session", out var s)
        ? Results.Ok(s)
        : Results.Unauthorized());

app.Run();
```

```javascript
// Vite dev server on http://localhost:5173
await fetch("https://localhost:7001/login", { method: "POST" });
const me = await fetch("https://localhost:7001/me");
console.log(me.status); // 401
```

Здесь накладываются друг на друга три отдельные ошибки. Вызовы `fetch` используют значение по умолчанию `credentials: 'same-origin'`, поэтому браузер отбрасывает `Set-Cookie` из кросс-доменного ответа и не прикрепляет cookie к `/me`. В политике CORS нет `AllowCredentials()`. А cookie имеет `SameSite=None` без `Secure`. Если исправить только одну из них, вы продолжите видеть тот же 401, и именно поэтому проблема кажется такой случайной.

## Исправление 1: отправляйте учетные данные и разрешите их в политике CORS

Для любого кросс-доменного вызова согласие должны дать обе стороны. На клиенте:

```javascript
// Browser, any framework
await fetch("https://localhost:7001/login", {
  method: "POST",
  credentials: "include"
});

// axios equivalent
axios.post("https://localhost:7001/login", null, { withCredentials: true });
```

На сервере перечислите точные источники и вызовите `AllowCredentials()`:

```csharp
// .NET 10, ASP.NET Core 10
builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
    p.WithOrigins("http://localhost:5173", "https://app.example.com")
     .AllowAnyHeader()
     .AllowAnyMethod()
     .AllowCredentials()));
```

Совместить `AllowAnyOrigin()` с `AllowCredentials()` нельзя. Спецификация CORS запрещает `Access-Control-Allow-Origin: *` в ответе с учетными данными, и ASP.NET Core обеспечивает это при построении политики, выбрасывая `InvalidOperationException: The CORS protocol does not allow specifying a wildcard (any) origin and credentials at the same time.` Если нужны динамические источники, используйте `SetIsOriginAllowed(origin => ...)` с настоящей проверкой и никогда `_ => true`, потому что отражение любого источника при включенных учетных данных представляет собой хрестоматийную дыру для CSRF. Полная настройка политики, включая кеширование preflight-запросов, описана в статье [о настройке CORS для API, защищенного JWT, в ASP.NET Core 11](/ru/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/).

Порядок middleware тоже важен: `app.UseCors()` должен выполняться до конечной точки, которая добавляет cookie, и до `UseAuthentication()` / `UseAuthorization()`.

## Исправление 2: используйте SameSite=None вместе с Secure или откажитесь от SameSite=None

Значение `CookieOptions.SameSite` по умолчанию равно `SameSiteMode.Unspecified`, то есть ASP.NET Core не выводит атрибут `SameSite`, и браузер применяет собственное значение по умолчанию. Chromium считает отсутствующий атрибут равным `Lax`. Такое значение по умолчанию правильно почти для любого приложения в пределах одного сайта, и прибегать к `None` стоит только тогда, когда cookie действительно должен передаваться в межсайтовых запросах (iframe, встроенный на другой сайт, сторонний виджет, обратный вызов провайдера удостоверений, использующий `form_post`).

Если `None` все же нужен, `Secure` обязателен:

```csharp
// .NET 10, ASP.NET Core 10
ctx.Response.Cookies.Append("session", token, new CookieOptions
{
    HttpOnly = true,
    Secure = true,                  // required with SameSite=None
    SameSite = SameSiteMode.None,
    Path = "/",
    MaxAge = TimeSpan.FromHours(8)
});
```

Вот различие, на котором спотыкаются многие: **SameSite касается сайта, CORS касается источника (origin).** Сайт определяется схемой и регистрируемым доменом, порт при этом игнорируется. Поэтому `http://localhost:5173`, вызывающий `http://localhost:5001`, является кросс-доменным запросом (применяется CORS, нужно исправление 1), но в пределах одного сайта (cookie с `Lax` работают). `app.example.com`, вызывающий `api.example.com`, тоже находится в пределах одного сайта. В таких конфигурациях `SameSite=None` вообще не нужен: оставьте `Lax` и просто исправьте учетные данные.

Схема, однако, учитывается. Начиная с Chrome 89 действует "schemeful same-site", поэтому `http://localhost:5173`, вызывающий `https://localhost:7001`, является межсайтовым запросом, и cookie с `Lax`, установленный HTTPS API, не будет отправляться в запросах со страницы по HTTP. Либо запускайте оба dev-сервера по одной схеме (подойдут и плагин Vite `basicSsl`, и `dotnet dev-certs https`), либо поставьте API за прокси dev-сервера, чтобы браузер всегда общался только с одним источником. Вариант с прокси самый надежный, потому что воспроизводит продакшен-развертывание с одним источником.

Настоящие межсайтовые cookie (SPA на `myapp.com`, API на `myapi.net`) являются сторонними cookie. Chrome оставил их включенными по умолчанию после того, как Google в апреле 2025 года отказался от плана по их упразднению, но Safari блокирует их полностью, а Firefox разделяет их в рамках Total Cookie Protection. Не стройте на них решение. Перенесите API под тот же регистрируемый домен или перейдите на Backend-for-Frontend, чтобы браузер хранил собственный (first-party) cookie. Если встраивание на другой сайт неизбежно, обратите внимание на секционированные cookie (CHIPS). У `CookieOptions` в ASP.NET Core 10 нет свойства `Partitioned`, но через `Extensions` атрибут можно добавить самостоятельно:

```csharp
// .NET 10, ASP.NET Core 10 - CHIPS partitioned cookie for a cross-site iframe
var options = new CookieOptions
{
    Secure = true,
    SameSite = SameSiteMode.None,
    HttpOnly = true
};
options.Extensions.Add("Partitioned");
ctx.Response.Cookies.Append("widget-state", value, options);
```

## Исправление 3: пометьте cookie как IsEssential или перестаньте требовать согласие

Если приложение вызывает `app.UseCookiePolicy()` и `CheckConsentNeeded` возвращает `true`, то `CookiePolicyMiddleware` оборачивает коллекцию cookie ответа и молча отбрасывает все cookie, не помеченные как обязательные, пока пользователь не примет cookie согласия. На уровне журналирования по умолчанию ничего не записывается, а вызов `Append` выглядит так, будто сработал. Шаблоны ASP.NET Core с 2.1 по 2.2 поставлялись с включенной проверкой, поэтому в старых проектах, которые обновлялись шаг за шагом, она часто сохраняется до сих пор.

```csharp
// .NET 10, ASP.NET Core 10 - the configuration that eats cookies
builder.Services.Configure<CookiePolicyOptions>(o =>
{
    o.CheckConsentNeeded = _ => true;
    o.MinimumSameSitePolicy = SameSiteMode.Lax;
});
// ...
app.UseCookiePolicy();
```

Либо cookie необходим для работы приложения, и тогда установите `IsEssential = true` (и честно укажите это в политике конфиденциальности), либо нет, и тогда правильное поведение состоит в том, чтобы дождаться согласия:

```csharp
// .NET 10, ASP.NET Core 10
ctx.Response.Cookies.Append("cart", cartId, new CookieOptions
{
    IsEssential = true,
    HttpOnly = true,
    Secure = true
});
```

Состояние согласия можно проверить явно через `ctx.Features.Get<ITrackingConsentFeature>()`: его свойство `CanTrack` сообщает, будут ли записываться необязательные cookie. `MinimumSameSitePolicy` в тех же параметрах также может переписать `SameSite` вашего cookie на более строгое значение, чем переданное, поэтому если cookie появляется с другим `SameSite`, чем вы задали, ищите причину здесь.

## Исправление 4: добавляйте cookie до начала отправки ответа

Заголовки ответа отправляются в момент, когда сбрасывается первый байт тела. После этого `Response.Cookies.Append` выбрасывает `InvalidOperationException: Headers are read-only, response has already started.` Классические места, где это происходит: middleware, добавляющий cookie после `await next()`, конечная точка, которая пишет в `Response.Body`, а затем устанавливает cookie, и код внутри потокового ответа или цикла SSE.

```csharp
// .NET 10, ASP.NET Core 10 - broken: the endpoint already wrote the body
app.Use(async (ctx, next) =>
{
    await next();
    ctx.Response.Cookies.Append("last-seen", DateTimeOffset.UtcNow.ToString("O"));
});

// fixed: register a callback that runs just before headers are flushed
app.Use(async (ctx, next) =>
{
    ctx.Response.OnStarting(() =>
    {
        ctx.Response.Cookies.Append("last-seen", DateTimeOffset.UtcNow.ToString("O"));
        return Task.CompletedTask;
    });
    await next();
});
```

Если исключение где-то проглатывается (фильтр исключений, задача в режиме fire-and-forget), видимым симптомом будет лишь отсутствующий cookie, поэтому при подозрении на эту причину проверьте `ctx.Response.HasStarted` в точке останова.

## Подвохи, которые выглядят как "cookie не установлен"

**Cookie установлен, но JavaScript его не видит.** `HttpOnly = true` намеренно скрывает его от `document.cookie`. Вместо этого проверьте вкладку Application в DevTools. Именно такое поведение нужно для токенов сессии, как обсуждается в статье [JWT против аутентификации на cookie в ASP.NET Core 11](/ru/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/).

**Cookie сохранен, но не отправляется обратно.** `CookieOptions` по умолчанию задает `Path` равным `/`, и это нормально, но если указать `Path = "/api/auth"`, браузер будет прикреплять cookie только к URL под этим путем. То же касается `Domain`, заданного как родительский домен, которому не соответствует ваш dev-хост. Не задавайте `Domain`, если не нужен общий доступ для поддоменов: cookie только для хоста строже и безопаснее.

**Значение выглядит искаженным.** `Append` пропускает значение через `Uri.EscapeDataString`, поэтому `a b=c` попадает в `document.cookie` как `a%20b%3Dc`. `Request.Cookies` декодирует его за вас на сервере, а коду на JavaScript нужен `decodeURIComponent`.

**Safari работает в продакшене, но не на localhost.** Safari отклоняет cookie с `Secure` по `http://localhost`, тогда как Chrome и Firefox их принимают. Запускайте dev-сервер по HTTPS с помощью `dotnet dev-certs https --trust`.

**Интерактивные компоненты Blazor.** В Blazor Server или интерактивных режимах рендеринга компонент работает через канал SignalR уже после того, как исходный HTTP-ответ завершен, поэтому добавлять cookie не к чему, а `HttpContext` равен null или устарел. Устанавливайте cookie из Razor Page, из конечной точки minimal API, которую вызывает клиент, или через отправку формы в статическом SSR. То же ограничение определяет устройство [`[SupplyParameterFromSession]` в статическом SSR](/ru/2026/06/blazor-supplyparameterfromsession-static-ssr-dotnet-11-preview-5/).

**Cookie слишком большой.** Браузеры отбрасывают cookie, у которого имя плюс значение превышают 4096 байт. Обработчик аутентификации на cookie в ASP.NET Core автоматически разбивает большие билеты на части `.AspNetCore.Cookies`, `C1`, `C2` через `ChunkingCookieManager`, но простой `Response.Cookies.Append` этого не делает. Если вы запихиваете в cookie JWT с множеством утверждений (claims), либо сократите их число, либо храните токен на сервере, а в cookie кладите короткий идентификатор. Частый источник этой проблемы представляют собой схемы с refresh-токенами; схему, при которой cookie остаются небольшими, смотрите в статье [о реализации refresh-токенов в ASP.NET Core Identity](/ru/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/).

**Исчезновение antiforgery cookie после развертывания** представляет собой другую проблему с тем же симптомом. Cookie установлен, но следующий экземпляр не может его расшифровать. Этот случай разобран в статье [об исправлении "The antiforgery token could not be decrypted"](/ru/2026/06/fix-the-antiforgery-token-could-not-be-decrypted-in-aspnetcore/).

## Чек-лист, который находит причину меньше чем за минуту

Когда cookie не сохраняется, пройдите эти шаги по порядку. Каждый шаг либо находит ошибку, либо исключает целую категорию причин:

1. Откройте DevTools, вкладку Network, выберите ответ, который должен устанавливать cookie, и убедитесь, что заголовок `Set-Cookie` присутствует. Если его нет, проблема на стороне сервера: политика согласия, исключение после начала отправки ответа или этот путь кода вообще не выполнялся.
2. Если заголовок присутствует, откройте вложенную вкладку Cookies этого запроса. Chromium отмечает заблокированные cookie значком предупреждения и указывает точную причину (SameSite, Secure, Domain или блокировка сторонних cookie).
3. Если вызов кросс-доменный, проверьте наличие `credentials: 'include'` в запросе и `Access-Control-Allow-Credentials: true` вместе с конкретным `Access-Control-Allow-Origin` в ответе.
4. Если cookie сохранен, но в следующем запросе отсутствует, сравните его `Path`, `Domain`, `SameSite` и `Secure` с URL и схемой этого следующего запроса.
5. Если в Chrome работает, а в Safari нет, причина либо в `Secure` по `http://localhost`, либо в стороннем cookie.

Ошибка редко кроется в серверном коде. Воспринимайте `Append` как "пожалуйста, рассмотри возможность сохранить это" и отлаживайте ответ браузера.

## Источники

- [ResponseCookies.cs в dotnet/aspnetcore](https://github.com/dotnet/aspnetcore/blob/main/src/Http/Http/src/Internal/ResponseCookies.cs) (предупреждение `SameSite=None` и кодирование значения)
- [Класс CookieOptions на MS Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.cookieoptions)
- [Enable CORS in ASP.NET Core: credentials in cross-origin requests](https://learn.microsoft.com/en-us/aspnet/core/security/cors#credentials-in-cross-origin-requests)
- [EU General Data Protection Regulation (GDPR) support in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/security/gdpr)
- [Work with SameSite cookies in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/security/samesite)
- [MDN: Set-Cookie](https://developer.mozilla.org/docs/Web/HTTP/Headers/Set-Cookie)
- [dotnet/aspnetcore#55370: Add support for Partitioned cookies](https://github.com/dotnet/aspnetcore/issues/55370)
