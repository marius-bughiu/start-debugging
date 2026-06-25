---
title: "Исправление: 405 Method Not Allowed вместо 401 при использовании JWT bearer в ASP.NET Core"
description: "Защищённая конечная точка, возвращающая 405 вместо 401, почти всегда означает, что маршрутизация отклонила HTTP-метод до запуска аутентификации, либо схема cookie перехватила вызов проверки. Вот как определить, что именно."
pubDate: 2026-06-25
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "jwt"
  - "security"
lang: "ru"
translationOf: "2026/06/fix-405-method-not-allowed-instead-of-401-with-jwt-bearer-in-aspnetcore"
translatedBy: "claude"
translationDate: 2026-06-25
---

Вы добавили `[Authorize]` (или `RequireAuthorization()`) к конечной точке, отправили запрос без токена, ожидая аккуратный `401 Unauthorized`, и вместо этого получили `405 Method Not Allowed`. Ответ 405 вводит в заблуждение: он почти никогда не означает, что ваша аутентификация сломана. Он означает, что запрос вообще не дошёл до этапа авторизации, потому что маршрутизация конечных точек сначала отклонила HTTP-метод и завершила обработку с кодом 405, либо, что встречается реже, схема аутентификации по cookie является схемой вызова проверки по умолчанию и ответила вместо обработчика JWT bearer. Исправление для частого случая состоит в том, чтобы отправлять тот метод, на который конечная точка действительно настроена (`POST` для `MapPost`, а не `GET`); исправление для случая со схемой состоит в том, чтобы задать `DefaultChallengeScheme` равным схеме bearer. В этой статье используется .NET 11 с `Microsoft.AspNetCore.Authentication.JwtBearer` 11.0.0 и C# 14, но поведение маршрутизации идентично вплоть до .NET 6.

## Ошибка в контексте

```text
HTTP/1.1 405 Method Not Allowed
Allow: POST
Content-Length: 0
```

Заголовок `Allow` -- это и есть подсказка. Подлинный сбой аутентификации возвращает:

```text
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer
```

Если вы видите `Allow` и нет `WWW-Authenticate`, этот ответ сформировала маршрутизация, а не обработчик JWT bearer. Если вы видите `WWW-Authenticate: Bearer`, значит обработчик отработал и у вас реальная проблема с аутентификацией, а это уже тема другой статьи: [почему ваш JWT возвращает 401 даже при действительном токене](/ru/2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token/) разбирает этот путь.

## Почему маршрутизация выигрывает до запуска авторизации

Конвейер ASP.NET Core упорядочен. В стандартном приложении на minimal API или контроллерах он выглядит так:

```csharp
// .NET 11, ASP.NET Core 11.0.0
var app = builder.Build();

app.UseRouting();        // 1. selects the endpoint (including method matching)
app.UseAuthentication(); // 2. reads the token, sets HttpContext.User
app.UseAuthorization();  // 3. enforces [Authorize] on the selected endpoint

app.MapControllers();
app.Run();
```

`UseRouting` запускается первым. Маршрутизация сопоставляет запрос по пути *и* по HTTP-методу. Когда путь совпадает с зарегистрированным маршрутом, а метод нет, маршрутизация не проваливается в состояние "нет конечной точки". Она выбирает встроенную синтетическую конечную точку, создаваемую `HttpMethodMatcherPolicy`, единственная задача которой -- вернуть `405 Method Not Allowed` с заголовком `Allow`, перечисляющим методы, которые *действительно* настроены для этого пути. Смотрите [документацию по основам маршрутизации](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/routing), чтобы понять, как политики сопоставления участвуют в выборе конечной точки.

Эта синтетическая конечная точка 405 не несёт никаких метаданных авторизации. Поэтому, когда `UseAuthorization` смотрит на выбранную конечную точку, он не находит ничего, что нужно было бы применять, пропускает запрос дальше, и в ответ записывается 405. Ваше действие, помеченное `[Authorize]`, вообще не было кандидатом, потому что метод исключил его при сопоставлении. Авторизация буквально не может отработать на конечной точке, которую маршрутизация не выбрала.

Вот почему кажется, что добавление `[Authorize]` "вызывает" 405: это не так. Код 405 был там и до того, как вы добавили аутентификацию, вы просто не смотрели, потому что без `[Authorize]` запрос `GET` к конечной точке, поддерживающей только `POST`, тоже возвращает 405. Добавление `[Authorize]` меняет ваше *ожидание* на 401, что и обнажает уже существовавшее несоответствие метода.

## Минимальное воспроизведение

```csharp
// .NET 11, C# 14, ASP.NET Core 11.0.0
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(); // appsettings supplies Authority/Audience

builder.Services.AddAuthorization();

var app = builder.Build();
app.UseAuthentication();
app.UseAuthorization();

// Only POST is mapped for /orders
app.MapPost("/orders", () => Results.Ok())
   .RequireAuthorization();

app.Run();
```

Теперь вызовите её с неправильным методом и без токена:

```bash
curl -i http://localhost:5000/orders        # implicit GET
# HTTP/1.1 405 Method Not Allowed
# Allow: POST
```

Конечная точка `POST /orders` существует, поэтому путь совпадает, но `GET` не разрешён, поэтому маршрутизация возвращает 405. Вы ожидали 401, потому что забыли, что конечная точка принимает только `POST`. Отправьте правильный метод, и появится нужный вам 401:

```bash
curl -i -X POST http://localhost:5000/orders
# HTTP/1.1 401 Unauthorized
# WWW-Authenticate: Bearer
```

## Исправление 1: отправляйте метод, на который настроена конечная точка (обычная причина)

В девяти случаях из десяти ошибка на стороне вызывающего. Фронтенд, коллекция Postman или интеграционный тест используют метод, на который маршрут не настроен. Проверьте по порядку:

1. **HTTP-метод в запросе.** `fetch`, по умолчанию использующий `GET` против `MapPost`, отправка формы там, где API ожидает `PUT`, или клиент, обращающийся к `/api/orders` с `GET`, когда конечная точка чтения на самом деле `/api/orders/{id}`. Заголовок `Allow` сообщает вам ровно то, какие методы поддерживает путь, поэтому читайте его.
2. **Атрибут метода у действия.** В контроллерах действие с `[Route("orders")]`, но без `[HttpPost]`, не отвечает на каждый метод так, как вы можете предполагать при маршрутизации на основе атрибутов. Закрепите метод явно с помощью `[HttpPost("orders")]`, чтобы `GET` по тому же пути давал намеренный 405, а не сюрприз.
3. **Конфликтующие шаблоны маршрутов.** Две конечные точки на одном пути с разными методами -- это нормально. Но `MapGet("/orders/{id}")` и `MapPost("/orders")` -- это разные пути; запрос `POST /orders/5` не совпадает чисто ни с одним из них, и вы можете получить 405 или 404 в зависимости от шаблона. Используйте `MapGroup`, чтобы держать методы префикса видимыми в одном месте: [организация конечных точек minimal API с помощью MapGroup](/ru/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) показывает этот приём.

Если вы хотите, чтобы защищённый ресурс отвечал 401 на *любой* метод, который может попробовать клиент, включая ненастроенные, вам придётся настроить обработчик, перехватывающий все методы. Это редко то, что вам нужно, но это возможно с помощью `MapMethods`, охватывающего интересующие вас методы плюс резервный вариант.

## Исправление 2: не дайте схеме cookie отвечать на вызов проверки

Вторая причина проявляется, когда вы сочетаете ASP.NET Core Identity (которая регистрирует аутентификацию по cookie) с JWT bearer и не задаёте явную схему по умолчанию. Как описано в этой [ветке Microsoft Q&A](https://learn.microsoft.com/en-us/answers/questions/2136683/issue-with-405-method-not-allowed-instead-of-401-u), вызов проверки тогда проходит через обработчик cookie из Identity вместо обработчика bearer. Вызов проверки у обработчика cookie -- это перенаправление на страницу входа, и когда маршрут входа не принимает метод исходного запроса, вы попадаете на 405 вместо 401 от bearer.

Исправление состоит в том, чтобы явно указать, какая схема аутентифицирует и какая схема выполняет вызов проверки:

```csharp
// .NET 11, C# 14
builder.Services.AddAuthentication(options =>
{
    options.DefaultAuthenticateScheme = JwtBearerDefaults.AuthenticationScheme;
    options.DefaultChallengeScheme = JwtBearerDefaults.AuthenticationScheme;
})
.AddJwtBearer(options =>
{
    options.TokenValidationParameters = new TokenValidationParameters
    {
        ValidateIssuer = true,
        ValidateAudience = true,
        ValidateLifetime = true,
        ValidateIssuerSigningKey = true,
        ValidIssuer = builder.Configuration["Jwt:Issuer"],
        ValidAudience = builder.Configuration["Jwt:Audience"],
        IssuerSigningKey = new SymmetricSecurityKey(
            Encoding.UTF8.GetBytes(builder.Configuration["Jwt:Key"]!))
    };
});
```

Когда `DefaultChallengeScheme` задан равным схеме bearer, неаутентифицированный запрос получает `401 Unauthorized` с `WWW-Authenticate: Bearer`, а не перенаправление на cookie, которое вырождается в 405. Если у вас законно есть обе схемы и некоторые конечные точки должны использовать именно bearer, укажите схему в атрибуте, а не полагайтесь на схему по умолчанию: `[Authorize(AuthenticationSchemes = JwtBearerDefaults.AuthenticationScheme)]`. Та же ловушка с несоответствием схем является первопричиной множества случаев [действительных токенов, которые всё равно возвращают 401](/ru/2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token/), так что стоит один раз правильно настроить значения по умолчанию.

## Определение причины с помощью журналов

Гадать не обязательно. Повысьте уровень журналирования для маршрутизации и авторизации, и источник ответа станет очевидным:

```json
// appsettings.Development.json - .NET 11
{
  "Logging": {
    "LogLevel": {
      "Microsoft.AspNetCore.Routing": "Debug",
      "Microsoft.AspNetCore.Authentication": "Debug",
      "Microsoft.AspNetCore.Authorization": "Debug"
    }
  }
}
```

Если метод неправильный, вы увидите, что маршрутизация выбирает конечную точку method-not-allowed, и *никаких* строк журнала аутентификации, потому что обработчик так и не отработал:

```text
dbug: Microsoft.AspNetCore.Routing.Matching.DfaMatcher
      Endpoint selection: 405 HTTP Method Not Supported
```

Если вызов проверки выполняет схема cookie, вы увидите обработчик cookie, названный явно:

```text
dbug: Microsoft.AspNetCore.Authentication.Cookies.CookieAuthenticationHandler
      AuthenticationScheme: Identity.Application was challenged.
```

Эта единственная строка говорит вам, что обработчик bearer не является вашей схемой вызова проверки по умолчанию, что указывает прямо на Исправление 2.

## Подводные камни и похожие случаи

**Предварительный запрос CORS возвращает 405.** Браузер отправляет предварительный запрос `OPTIONS` перед кросс-доменным `POST` или `PUT`. Если вы никогда не вызывали `app.UseCors(...)` с политикой, разрешающей этот метод, у маршрутизации нет конечной точки `OPTIONS` для этого пути и она отвечает 405, что браузер преподносит как сбой CORS. Исправление состоит в настройке CORS, а не аутентификации: [настройка CORS для API, защищённого JWT](/ru/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/) разбирает политику и порядок middleware. Учтите, что предварительный запрос `OPTIONS` намеренно не аутентифицируется; не ставьте перед ним `[Authorize]`.

**Запросы HEAD к конечной точке, поддерживающей только GET.** `MapGet` не отвечает на `HEAD` автоматически. Проверка работоспособности или CDN, зондирующий с помощью `HEAD` маршрут `MapGet`, получает 405. Настройте оба метода с помощью `app.MapMethods("/health", new[] { "GET", "HEAD" }, handler)` согласно [документации по обработчикам маршрутов](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/route-handlers). Это несоответствие метода, а не проблема аутентификации.

**403 -- это не 405.** Если вы успешно аутентифицировались, но вам не хватает требуемой роли или заявки политики, вы получаете `403 Forbidden`, а не 405 и не 401. Код 403 означает, что токен прошёл проверку и обработчик отработал; ваша проблема -- проверка политики или роли, которая разбирается в статье о том, как [проверить издателя, аудиторию и срок действия JWT](/ru/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/) и заявки, которые он несёт.

**Пользовательский middleware, завершающий обработку до маршрутизации.** Если вы написали middleware, который запускается до `UseRouting` и записывает 405 (например, самодельный список разрешённых методов), он замаскирует всё, что находится ниже по конвейеру. Всё, что вызывает `context.Response.StatusCode = 405` перед маршрутизацией, даёт этот симптом без заголовка `Allow` от механизма сопоставления.

Сквозная мысль: 405 -- это статус *маршрутизации* в ASP.NET Core, определяемый ещё до того, как аутентификация и авторизация вообще посмотрят на запрос. Когда вы ожидали 401, а получили 405, начинайте с метода и заголовка `Allow`, а не с вашего токена. Отладку аутентификации приберегите для случая, когда вы действительно видите `WWW-Authenticate: Bearer`.

## Связанные статьи

- [Почему ваш JWT в ASP.NET Core возвращает 401 даже при действительном токене](/ru/2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token/)
- [Как проверить издателя, аудиторию и срок действия JWT в ASP.NET Core 11](/ru/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/)
- [Как настроить CORS для API, защищённого JWT, в ASP.NET Core 11](/ru/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/)
- [Как организовать конечные точки minimal API с помощью MapGroup в ASP.NET Core 11](/ru/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [Как проверять тела запросов в minimal API без контроллеров в ASP.NET Core 11](/ru/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/)

## Источники

- [Основы маршрутизации ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/routing) - сопоставление конечных точек и политики сопоставления методов
- [Обработчики маршрутов в приложениях minimal API](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/route-handlers) - `MapMethods`, HEAD и OPTIONS
- [Microsoft Q&A: 405 Method Not Allowed вместо 401 при JWT](https://learn.microsoft.com/en-us/answers/questions/2136683/issue-with-405-method-not-allowed-instead-of-401-u) - причина с cookie-схемой по умолчанию и её исправление
- [RFC 9110, раздел 15.5.6 (405 Method Not Allowed)](https://datatracker.ietf.org/doc/html/rfc9110#section-15.5.6) и [15.5.2 (401 Unauthorized)](https://datatracker.ietf.org/doc/html/rfc9110#section-15.5.2)
