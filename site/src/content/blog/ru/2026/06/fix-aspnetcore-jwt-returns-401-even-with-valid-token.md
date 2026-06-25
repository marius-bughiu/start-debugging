---
title: "Почему ваш JWT в ASP.NET Core возвращает 401 даже с действительным токеном"
description: "Действительный токен, который всё равно даёт 401, почти всегда означает, что обработчик bearer не запускался или запустился под не той схемой. Проверьте порядок middleware, схему по умолчанию, имя схемы и дошёл ли вообще заголовок до обработчика."
pubDate: 2026-06-25
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "jwt"
  - "security"
lang: "ru"
translationOf: "2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token"
translatedBy: "claude"
translationDate: 2026-06-25
---

Вы декодировали токен на [jwt.io](https://jwt.io/), подпись сходится, до `exp` ещё несколько часов, `iss` и `aud` ровно те, что вы настроили, а ASP.NET Core всё равно отвечает `401 Unauthorized`. Когда сам токен заведомо хорош, ошибка почти никогда не в токене. Дело в том, что обработчик JWT bearer либо вообще не запускался для этого запроса, либо запустился под схемой, которую ваш атрибут `[Authorize]` не запрашивает. Четыре обычных виновника, в порядке, в котором они кусаются: отсутствует `app.UseAuthentication()` или он стоит после `app.UseAuthorization()`; не зарегистрирована схема аутентификации по умолчанию; имя схемы в `AddJwtBearer` не совпадает с тем, что вызывает `[Authorize]`; либо заголовок `Authorization` вообще не дошёл до обработчика. В этой статье используется .NET 11 с `Microsoft.AspNetCore.Authentication.JwtBearer` 11.0.0-preview и C# 14, но диагностика идентична вплоть до .NET 8.

Если вы подозреваете, что утверждения (claims) токена на самом деле неверны (пятиминутное окно `ClockSkew`, несовпадающая аудитория), это тема другой статьи: [как проверить издателя, аудиторию и срок действия JWT](/ru/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/) подробно разбирает сторону `TokenValidationParameters`. Здесь мы предполагаем, что вы уже доказали действительность токена, а 401 всё равно сохраняется.

## Что на самом деле говорит вам 401

Ответ, который вы видите, намеренно скуп:

```text
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer
```

Согласно [RFC 9110](https://datatracker.ietf.org/doc/html/rfc9110#section-15.5.2), ответ 401 должен нести заголовок `WWW-Authenticate`, называющий вызов (challenge), и ASP.NET Core отправляет `Bearer`. Чего он по умолчанию не отправляет, так это причину. Если обработчик запустился и отклонил токен, настоящая причина это исключение `Microsoft.IdentityModel`, которое обработчик проглотил. Если обработчик вообще не запускался, исключения нет вовсе, есть лишь политика авторизации, которая не нашла аутентифицированного пользователя и выдала вызов. Различить эти два случая это вся суть игры, и быстрее всего это сделать, заставив обработчик заговорить (об этом ближе к концу).

Одно нужно исключить сразу: 401 означает "мы не знаем, кто вы". 403 означает "мы знаем, кто вы, просто вам не разрешено". Если вы получаете 403, токен прошёл проверку, и ваша проблема в проверке политики или роли, а не в аутентификации. Не тратьте полдня на отладку проверки токена ради 403.

## Причина 1: UseAuthentication отсутствует или стоит после UseAuthorization

Это самая частая причина и самая лёгкая, чтобы её упустить, потому что обе строки присутствуют, просто в неправильном порядке. Middleware аутентификации это то, что читает заголовок `Authorization`, запускает обработчик bearer и устанавливает `HttpContext.User`. Middleware авторизации это то, что обеспечивает соблюдение `[Authorize]`. Если авторизация запускается первой, `HttpContext.User` всё ещё анонимный по умолчанию, поэтому каждая защищённая конечная точка выдаёт вызов с 401 независимо от того, насколько хорош токен.

```csharp
// .NET 11, C# 14 -- WRONG: authorization runs before the user is set
app.UseAuthorization();
app.UseAuthentication();   // too late, User is already anonymous
```

```csharp
// .NET 11, C# 14 -- correct order
app.UseAuthentication();   // reads the token, populates HttpContext.User
app.UseAuthorization();    // now enforces [Authorize] against a real user
```

Правило механическое: `UseAuthentication` перед `UseAuthorization`, и оба после `UseRouting` (в современной модели минимального хостинга `UseRouting` добавляется за вас, поэтому в основном вам нужно лишь два вызова auth в правильном относительном порядке). Если вы убрали `UseAuthentication` целиком, скажем при рефакторинге, симптом идентичен: повсеместный 401 на всём, что помечено `[Authorize]`. Сначала верните его на место, прежде чем трогать что-либо ещё.

## Причина 2: не зарегистрирована схема аутентификации по умолчанию

Атрибут `[Authorize]` без указанной схемы использует *схему аутентификации по умолчанию*. Если вы никогда не сообщили `AddAuthentication`, какова эта схема по умолчанию, то нет схемы для запуска, пользователь остаётся анонимным, и вы получаете 401. На этом спотыкаются, потому что регистрация *выглядит* завершённой:

```csharp
// .NET 11, C# 14 -- WRONG: no default scheme, [Authorize] has nothing to run
builder.Services.AddAuthentication()
    .AddJwtBearer(options =>
    {
        options.Authority = "https://login.example.com";
        options.Audience = "api://my-api";
    });
```

`AddAuthentication()` без аргумента регистрирует сервисы, но не задаёт схему по умолчанию. Исправление в том, чтобы передать имя схемы как значение по умолчанию, а это ровно та схема, под которой регистрируется `AddJwtBearer`, когда вы её не именуете:

```csharp
// .NET 11, C# 14 -- correct: "Bearer" becomes the default scheme
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.Authority = "https://login.example.com";
        options.Audience = "api://my-api";
    });
```

`JwtBearerDefaults.AuthenticationScheme` это строка `"Bearer"`. Передача её в `AddAuthentication` одним движением устанавливает `DefaultAuthenticateScheme` и `DefaultChallengeScheme` в `"Bearer"`, поэтому голый `[Authorize]` теперь знает, что нужно запустить обработчик bearer. Если вы предпочитаете быть явными, задайте свойства напрямую:

```csharp
// .NET 11, C# 14 -- the explicit form, equivalent to the above
builder.Services.AddAuthentication(options =>
{
    options.DefaultAuthenticateScheme = JwtBearerDefaults.AuthenticationScheme;
    options.DefaultChallengeScheme = JwtBearerDefaults.AuthenticationScheme;
})
.AddJwtBearer(options => { /* ... */ });
```

## Причина 3: имя схемы не совпадает

В тот момент, когда вы даёте `AddJwtBearer` пользовательское имя схемы, вы отказались от значения по умолчанию и теперь должны запрашивать эту схему по имени везде. Это вторая по распространённости ловушка "действительный токен, всё равно 401", и она коварна, потому что конфигурация в остальном безупречна.

```csharp
// .NET 11, C# 14 -- registers the handler under "MyApi", not "Bearer"
builder.Services.AddAuthentication()
    .AddJwtBearer("MyApi", options =>
    {
        options.Authority = "https://login.example.com";
        options.Audience = "api://my-api";
    });
```

```csharp
// .NET 11, C# 14 -- a bare [Authorize] looks for the default scheme,
// which is unset, so the "MyApi" handler never runs -> 401
[Authorize]
public class OrdersController : ControllerBase { /* ... */ }
```

У вас есть два выхода. Либо сделайте `"MyApi"` схемой по умолчанию, чтобы голый `[Authorize]` её нашёл, либо называйте схему в каждом атрибуте, который должен её использовать:

```csharp
// .NET 11, C# 14 -- option A: make the named scheme the default
builder.Services.AddAuthentication("MyApi")
    .AddJwtBearer("MyApi", options => { /* ... */ });

// .NET 11, C# 14 -- option B: ask for the scheme by name
[Authorize(AuthenticationSchemes = "MyApi")]
public class OrdersController : ControllerBase { /* ... */ }
```

Это важнее всего, когда вы действительно используете более одной схемы, скажем схему bearer для вашего API плюс cookies для серверно отрисовываемой административной зоны. При нескольких схемах нет разумной единственной схемы по умолчанию, поэтому конечные точки bearer должны явно прописывать `[Authorize(AuthenticationSchemes = JwtBearerDefaults.AuthenticationScheme)]`. Пропустите это, и запрос будет проверяться по той схеме, которая случайно оказалась схемой по умолчанию, а это не ваша, и токен игнорируется.

## Причина 4: заголовок не дошёл до обработчика

Если обработчик запустился, не нашёл заголовка `Authorization` (или нашёл искажённый), он не может никого аутентифицировать, и вы получаете 401, который не имеет ничего общего с содержимым токена. Токен в вашей вкладке Postman действителен; он просто не приходит так, как вы думаете.

Формат строгий. Значение заголовка должно быть буквальным словом `Bearer`, один пробел, затем сырой токен, без кавычек и без путаницы `Basic`/`Bearer`:

```text
Authorization: Bearer eyJhbGciOiJSUzI1NiIs...
```

Распространённые способы, которыми это идёт не так на практике:

- **Клиент вообще его не прикрепляет.** Типизированный `HttpClient`, чей `DefaultRequestHeaders.Authorization` был задан на *другом* экземпляре клиента, или вызов fetch, который забыл заголовок при повторных попытках. Залогируйте входящие заголовки на сервере, чтобы увидеть, что на самом деле пришло.
- **Отклоняется предварительный запрос CORS, а не ваш реальный запрос.** Браузер отправляет предварительный запрос `OPTIONS` без заголовка `Authorization` перед реальным вызовом. Если CORS настроен неправильно, браузер блокирует реальный запрос, и ваша вкладка сети показывает то, что выглядит как сбой аутентификации. Исправление на стороне CORS, а не токена: см. [как настроить CORS для API, защищённого JWT](/ru/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/) для правильного порядка middleware и политики.
- **Обратный прокси или балансировщик нагрузки его срезает.** Некоторые прокси отбрасывают `Authorization` при пересылке, если им явно не указано его сохранять. Если локально работает, а 401 только за nginx, IIS или ingress-контроллером, подозревайте это в первую очередь.
- **Обозреватель API его теряет.** Swagger UI и Scalar молча отправят запросы без токена, если их интеграция аутентификации не настроена. Если ваш `curl` работает, а интерфейс документации нет, это и есть подсказка, об этом в [почему ваш bearer-токен игнорируется в Scalar](/ru/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/).

## Заставьте обработчик сказать вам, почему

Перестаньте гадать. Подключите `JwtBearerEvents`, чтобы обработчик логировал фактический результат, и тогда вы за один запрос узнаете, запускался ли он вообще, а если да, то какая проверка не прошла.

```csharp
// .NET 11, C# 14
.AddJwtBearer(options =>
{
    options.Authority = "https://login.example.com";
    options.Audience = "api://my-api";

    options.Events = new JwtBearerEvents
    {
        OnAuthenticationFailed = ctx =>
        {
            // Fires only if the handler RAN and the token was rejected.
            // ctx.Exception carries the IDX code (expired, bad audience, etc.)
            var log = ctx.HttpContext.RequestServices
                .GetRequiredService<ILogger<Program>>();
            log.LogWarning(ctx.Exception, "JWT rejected");
            return Task.CompletedTask;
        },
        OnChallenge = ctx =>
        {
            // Fires whenever a 401 is about to be sent, INCLUDING the
            // "no token / handler never validated anything" case.
            var log = ctx.HttpContext.RequestServices
                .GetRequiredService<ILogger<Program>>();
            log.LogWarning("JWT challenge: {Error} {Desc}",
                ctx.Error, ctx.ErrorDescription);
            return Task.CompletedTask;
        },
        OnTokenValidated = ctx =>
        {
            // Fires when a token validated successfully. If you see THIS
            // and still get a 401, the problem is authorization, not auth.
            return Task.CompletedTask;
        },
    };
});
```

Дерево решений, которое это вам даёт, точно. Если срабатывает `OnAuthenticationFailed`, обработчик запустился и отклонил реальный токен; прочтите `ctx.Exception` для кода `IDX` и переходите к [руководству по проверке токенов](/ru/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/). Если срабатывает только `OnChallenge` без предшествующего сбоя, у обработчика не было токена для проверки, так что вы смотрите на причины с 1 по 4 выше, а не на токен. Если срабатывает `OnTokenValidated`, а вы *всё равно* получаете не-200, у вас проблема авторизации, имеющая форму 403, но переодетая в костюм 401, и никакая подстройка токена не поможет.

Тот же сигнал можно получить без кода, повысив категорию журналирования в `appsettings.Development.json`:

```json
{
  "Logging": {
    "LogLevel": {
      "Microsoft.AspNetCore.Authentication": "Debug"
    }
  }
}
```

Это выводит прямо в консоль строки вроде "Bearer was not authenticated. Failure message: ...", что само по себе разрешает большинство таких случаев меньше чем за минуту.

## Надёжный заведомо хороший токен для проверки

Половина времени, потраченного на эту ошибку, это сомнения в том, действительно ли токен действителен. Уберите сомнения с помощью инструмента `dotnet user-jwts`, который выпускает токен, подписанный ключом, который он же подключает в вашу конфигурацию разработки, поэтому проверка не может провалиться из-за несовпадения ключа:

```bash
# .NET 11 SDK -- creates a local-dev JWT and configures the app to accept it
dotnet user-jwts create
```

Если токен `user-jwts` аутентифицируется, а токен вашего реального провайдера нет, разница в утверждениях (claims) токена или ключе подписи, и вы возвращаетесь к параметрам проверки. Если даже токен `user-jwts` даёт 401, токен никогда не был проблемой, и виновата одна из четырёх причин подключения выше. Этот единственный эксперимент чисто делит пространство поиска пополам.

## Диагностируйте по порядку

Когда действительный токен даёт 401, прорабатывайте этот чек-лист сверху вниз. Ранние шаги ловят подавляющее большинство случаев, так что не перескакивайте вперёд.

1. **Убедитесь, что это 401, а не 403.** 403 означает, что аутентификация уже прошла; остановитесь здесь и посмотрите на свои политики авторизации.
2. **Проверьте порядок middleware.** `app.UseAuthentication()` должен присутствовать и должен идти перед `app.UseAuthorization()`. Это одно исправляет большинство случаев.
3. **Проверьте схему по умолчанию.** Либо передайте `JwtBearerDefaults.AuthenticationScheme` в `AddAuthentication`, либо задайте `DefaultAuthenticateScheme` явно. Голый `AddAuthentication()` с голым `[Authorize]` работать не может.
4. **Проверьте имя схемы.** Если вы именовали схему в `AddJwtBearer("X")`, либо сделайте `"X"` схемой по умолчанию, либо используйте `[Authorize(AuthenticationSchemes = "X")]` везде.
5. **Убедитесь, что заголовок приходит.** Залогируйте входящие заголовки запроса на сервере. Проверьте точную форму `Authorization: Bearer <token>` и исключите прокси или предварительный запрос CORS, поедающий его.
6. **Выпустите токен `dotnet user-jwts` и повторите попытку.** Если он аутентифицируется, проблема в утверждениях (claims) или ключе вашего реального токена; переходите к [руководству по параметрам проверки](/ru/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/). Если он тоже даёт 401, подключение всё ещё неверно; перепроверьте шаги со 2 по 4.
7. **Включите отладочное журналирование `Microsoft.AspNetCore.Authentication`** или подключите `JwtBearerEvents` и прочтите, какое событие срабатывает. Это окончательно скажет вам, запускался ли обработчик.

## Одно различие, которое завершает поиск

Каждый "действительный токен, но 401" сводится к единственному вопросу: запустился ли обработчик bearer и отклонил токен, или ему так и не выпало шанса запуститься? Параметры проверки, `ClockSkew`, несовпадения издателя и аудитории все живут на первой ветви, и они имеют значение только если срабатывает `OnAuthenticationFailed`. Порядок middleware, схема по умолчанию, имя схемы и отсутствующий заголовок все живут на второй ветви, где нет сбоя проверки, который можно найти, потому что нечего было проверять. Заставьте обработчик выдать одну строку журнала, и вы ответили на вопрос; дальше исправление механическое. Когда вы пойдёте запирать конечные точки, группировка защищённых маршрутов с помощью [MapGroup](/ru/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) держит требование схемы в одном месте, а не разбросанным по каждому `[Authorize]`, а именно так несовпадение имени схемы и проникает с самого начала.

## Источники

- [Configure JWT bearer authentication in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/configure-jwt-bearer-authentication), Microsoft Learn, включая разбор 401 против 403 и руководство по схеме по умолчанию.
- [Authorize with a specific scheme in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/security/authorization/limitingidentitybyscheme), Microsoft Learn, про `[Authorize(AuthenticationSchemes = ...)]`.
- [RFC 9110, section 15.5.2](https://datatracker.ietf.org/doc/html/rfc9110#section-15.5.2), который требует заголовок `WWW-Authenticate` на ответе 401.
- [Generate tokens with dotnet user-jwts](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/jwt-authn), Microsoft Learn.
</content>
</invoke>
