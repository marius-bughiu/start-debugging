---
title: "Как настроить CORS для защищённого JWT API в ASP.NET Core 11"
description: "Полное руководство по CORS для API с токеном bearer в ASP.NET Core 11: правильный порядок UseCors относительно аутентификации, почему токен bearer в заголовке Authorization не является учётными данными CORS, почему AllowAnyHeader работает, а ручной шаблон не покрывает Authorization, и как не дать предварительному запросу завершиться сбоем."
pubDate: 2026-06-21
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "cors"
  - "jwt"
  - "security"
lang: "ru"
translationOf: "2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-06-21
---

Если ваше одностраничное приложение вызывает защищённый JWT API на ASP.NET Core с другого источника, а консоль браузера показывает "No 'Access-Control-Allow-Origin' header is present" или "Request header field authorization is not allowed", решение почти никогда не находится на стороне аутентификации. Вам нужна политика CORS, которая называет источник вашего фронтенда через `WithOrigins`, разрешает заголовок запроса `Authorization` и выполняет `app.UseCors(...)` *до* `app.UseAuthentication()` и `app.UseAuthorization()`. То, что большинство руководств понимают неправильно: токен bearer, который вы сами помещаете в заголовок `Authorization`, **не** является учётными данными CORS, поэтому для API на JWT, работающего через заголовки, вам **не** нужен `AllowCredentials()`, а его добавление вынуждает вас отказаться от `AllowAnyOrigin` без какой-либо пользы. Эта статья ориентирована на .NET 11 (preview 5 на момент написания), но API CORS и JWT bearer не менялись со времён .NET 8, 9 и 10.

## CORS и JWT — это два не связанных между собой барьера, которые отказывают одновременно

Кроссдоменный запрос с `https://app.example.com` к `https://api.example.com` проходит через две полностью независимые проверки, и путаница между ними — корень почти всех потраченных здесь впустую вечеров.

Первая — это CORS. Его обеспечивает браузер, а не ваш сервер. Браузер решает, *может ли JavaScript прочитать ответ*, на основе заголовков `Access-Control-Allow-*`, которые отправляет ваш сервер. CORS ничего не знает о том, кто вы. Его интересуют только источники, методы и заголовки запроса.

Вторая — это аутентификация. Обработчик JWT bearer в ASP.NET Core проверяет токен в заголовке `Authorization` и выдаёт 401 или `ClaimsPrincipal`. Он ничего не знает об источниках.

Ловушка в том, что неправильно настроенная политика CORS и отсутствующий токен порождают ошибки, которые выглядят одинаково в DevTools. 401 без заголовков CORS отображается в консоли как сбой CORS, потому что браузер отбрасывает ответ до того, как ваш код может его увидеть. Поэтому вы час возитесь с токеном, когда реальная проблема — порядок политики, или наоборот. Держите эти два барьера раздельно в голове: CORS решает, передаст ли браузер вам байты, аутентификация решает, произвёл ли их сервер.

## Токен bearer в заголовке Authorization не является «учётными данными» CORS

Это самый неправильно понимаемый момент, и если разобраться с ним верно, всё остальное упрощается.

В спецификации CORS «учётные данные» означают три конкретные вещи: cookie, клиентские сертификаты TLS и заголовок `Authorization`, *который агент пользователя заполняет автоматически* на основе сохранённой HTTP-аутентификации. Когда вы пишете `fetch(url, { headers: { Authorization: "Bearer " + token } })`, вы устанавливаете заголовок запроса, определённый автором. Это не запрос с учётными данными. Режим `credentials` этого fetch по-прежнему равен значению по умолчанию `"same-origin"`, что для кроссдоменного вызова означает «не отправлять cookie».

Следствие: для типичного SPA, которое хранит свой JWT в памяти или в `localStorage` и прикрепляет его вручную, вам **не** следует вызывать `AllowCredentials()`. Он нужен только тогда, когда токен (или токен обновления, или сессия) едет в cookie, потому что cookie — это настоящие учётные данные CORS, и браузер не отправит их кроссдоменно, пока ответ не скажет `Access-Control-Allow-Credentials: true`.

Почему это важно помимо педантизма? Потому что `AllowCredentials()` несовместим с `AllowAnyOrigin()`. В тот момент, когда вы добавляете учётные данные, спецификация CORS запрещает шаблон источника `*`, и ASP.NET Core обеспечивает это, выбрасывая исключение при запуске:

```csharp
// .NET 11, C# 14
// This throws ArgumentException at app build time:
// "The CORS protocol does not allow specifying a wildcard (any) origin
//  and credentials at the same time."
options.AddPolicy("bad", policy => policy
    .AllowAnyOrigin()
    .AllowCredentials());
```

Поэтому, если вы рефлекторно добавляете `AllowCredentials()` в API на bearer, работающий через заголовки, вы взяли на себя ограничение по фиксации источников без каких-либо преимуществ. Оставьте его в стороне, пока вы действительно не используете cookie.

## Политика, которая работает

Вот полная корректная настройка для minimal API, которое проверяет JWT и вызывается из одного или нескольких известных источников фронтенда. Если вы всё ещё выбираете между minimal API и моделью MVC, компромиссы описаны в [minimal API против контроллеров в ASP.NET Core 11](/ru/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/); CORS одинаков в обоих случаях.

```csharp
// .NET 11, C# 14
var builder = WebApplication.CreateBuilder(args);

const string SpaCors = "spa";

builder.Services.AddCors(options =>
{
    options.AddPolicy(SpaCors, policy => policy
        .WithOrigins("https://app.example.com", "http://localhost:5173")
        .WithHeaders("Authorization", "Content-Type")
        .WithMethods("GET", "POST", "PUT", "DELETE")
        .SetPreflightMaxAge(TimeSpan.FromMinutes(10)));
});

builder.Services.AddAuthentication("Bearer")
    .AddJwtBearer(options =>
    {
        options.Authority = "https://login.example.com";
        options.Audience = "api://my-api";
        // TokenValidationParameters tuned for your issuer here.
    });

builder.Services.AddAuthorization();

var app = builder.Build();

// Order is load-bearing. See the next section.
app.UseCors(SpaCors);
app.UseAuthentication();
app.UseAuthorization();

app.MapGet("/me", (ClaimsPrincipal user) => user.Identity!.Name)
    .RequireAuthorization();

app.Run();
```

Три осознанных решения в этой политике:

- `WithOrigins` перечисляет точные источники, включая схему и порт. `http://localhost:5173` и `https://localhost:5173` — это разные источники, как и тот же хост на другом порту.
- `WithHeaders("Authorization", "Content-Type")` разрешает два заголовка запроса, которые вызов JSON+JWT действительно отправляет. `Content-Type: application/json` не входит в безопасный список CORS, поэтому сам по себе вызывает предварительный запрос.
- `WithMethods` перечисляет глаголы, которые предоставляет API. `PUT` или `DELETE` всегда вызывают предварительный запрос.

Без `AllowCredentials()`, потому что это API на bearer, работающее через заголовки.

## Почему UseCors должен выполняться до UseAuthentication

Порядок middleware не эстетический. `app.UseCors(...)` должен идти после `UseRouting` (который `WebApplication` вызывает неявно) и **до** `UseAuthentication` и `UseAuthorization`. [Документация по CORS](https://learn.microsoft.com/en-us/aspnet/core/security/cors) от Microsoft устанавливает это правило; вот что действительно ломается, если его игнорировать.

Предварительный запрос CORS — это запрос `OPTIONS`, и браузер отправляет его **без** заголовка `Authorization`. Это сделано намеренно: предварительный запрос спрашивает «можно ли мне сделать этот запрос?» до того, как будут прикреплены какие-либо учётные данные. Если аутентификация или проверка `[Authorize]`/`RequireAuthorization` выполняется до middleware CORS, неаутентифицированный запрос `OPTIONS` получает 401, браузер так и не получает заголовки `Access-Control-Allow-*`, и реальный запрос так и не отправляется. Вы увидите сбой предварительного запроса во вкладке Network и ошибочно заключите, что ваш токен испорчен.

Если `UseCors` поставлен первым, middleware CORS распознаёт предварительный запрос, отвечает на него кодом 204 и правильными заголовками и замыкает цепочку до того, как вообще выполнится аутентификация. Следующий за ним реальный `GET`/`POST` несёт токен и нормально проходит через аутентификацию.

Тот же порядок также устраняет проблему «401 без заголовков CORS» для реальных запросов. Когда токен отсутствует или просрочен, вы *хотите*, чтобы 401 по-прежнему нёс `Access-Control-Allow-Origin`, чтобы браузер раскрыл ответ, а ваше SPA могло прочитать статус и перенаправить на вход. Это происходит только если CORS выполняется до middleware аутентификации, который порождает 401. Именно этот пробел был предметом давней проблемы в ASP.NET Core ([dotnet/aspnetcore#16584](https://github.com/dotnet/aspnetcore/issues/16584)), и порядок является её решением.

## Ловушка с шаблоном в заголовке Authorization

Эта ловушка бьёт по тем, кто пытается быть либеральным при разработке, а затем закручивает гайки. Согласно [стандарту Fetch](https://fetch.spec.whatwg.org/) и документации на [MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Access-Control-Allow-Headers), шаблон в `Access-Control-Allow-Headers: *` **не** покрывает заголовок `Authorization`. Браузер обрабатывает `Authorization` как особый случай: он должен быть назван явно, иначе предварительный запрос для любого запроса, несущего токен bearer, завершается ошибкой "Request header field authorization is not allowed by Access-Control-Allow-Headers".

Поэтому, если вы реализуете CORS вручную в собственном middleware с буквальным `Access-Control-Allow-Headers: *`, ваши вызовы JWT ломаются, хотя шаблон выглядит так, будто разрешает всё.

Вот успокаивающая часть для пользователей ASP.NET Core: встроенный `AllowAnyHeader()` **не** выдаёт буквальный `*`. `CorsService` возвращает ровно те заголовки, которые браузер запросил в `Access-Control-Request-Headers`, что означает, что `Authorization` отражается и предварительный запрос проходит успешно. Это можно проверить в [исходном коде CorsService](https://github.com/dotnet/aspnetcore/blob/main/src/Middleware/CORS/src/Infrastructure/CorsService.cs): значение разрешённых заголовков берётся из `GetCommaSeparatedValues(CorsConstants.AccessControlRequestHeaders)`, а не из постоянного `*`.

Практическое правило, которое из этого следует:

- `AllowAnyHeader()` отлично работает для токенов bearer, потому что ASP.NET Core отражает заголовки, а не использует шаблон.
- `WithHeaders(...)` работает, только если вы включаете `"Authorization"` в список. Забыть его — самый частый сбой CORS, нанесённый себе самому, в API на JWT, потому что один `Content-Type` выглядит полным, а ошибка 403/предварительного запроса неконкретна.

В случае сомнений перечислите `Authorization` явно. Это ничего не стоит и устраняет целый класс багов.

## Правильная настройка, шаг за шагом

1. Зарегистрируйте CORS с именованной политикой в `AddCors`, фиксируя источники вашего фронтенда через `WithOrigins` (точные схема, хост и порт).
2. Разрешите заголовки запроса, которые отправляет ваш клиент. Включите `"Authorization"` и `"Content-Type"` явно через `WithHeaders` или используйте `AllowAnyHeader()` и положитесь на отражение заголовков в ASP.NET Core.
3. Разрешите HTTP-методы, которые предоставляют ваши конечные точки, через `WithMethods`, включая глаголы (`PUT`, `DELETE`), которые всегда вызывают предварительный запрос.
4. Примите решение об учётных данных: опустите `AllowCredentials()` для токена bearer, работающего через заголовки; добавляйте его только если задействован cookie, и в этом случае замените `AllowAnyOrigin` явным `WithOrigins`.
5. Поместите `app.UseCors("policy")` после маршрутизации и до `app.UseAuthentication()` и `app.UseAuthorization()`.
6. Применяйте политику глобально через `app.UseCors(...)` или для каждой конечной точки через `.RequireCors("policy")` (или `[EnableCors("policy")]` на контроллерах). Не смешивайте глобальный CORS через middleware с атрибутом в одном приложении.

## Cookie, токены обновления и случай с учётными данными

Если в вашем дизайне токен доступа хранится в памяти, но токен обновления хранится в cookie `HttpOnly` (распространённый и надёжный паттерн, см. [как реализовать токены обновления в ASP.NET Core Identity](/ru/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/)), то вызов обновления *действительно* несёт учётные данные, и правила переворачиваются:

```csharp
// .NET 11, C# 14
options.AddPolicy("spa-with-cookie", policy => policy
    .WithOrigins("https://app.example.com") // exact origins only, no AllowAnyOrigin
    .WithHeaders("Authorization", "Content-Type")
    .WithMethods("GET", "POST", "PUT", "DELETE")
    .AllowCredentials());                    // required so the browser sends the cookie
```

На клиенте именно этой конечной точке нужен `fetch(url, { credentials: "include" })`. Сервер должен ответить конкретным `Access-Control-Allow-Origin` (никогда `*`) и `Access-Control-Allow-Credentials: true`, что в точности и порождает приведённая выше политика. ASP.NET Core по-прежнему отражает разрешённые заголовки, а не использует шаблон, поэтому `Authorization` продолжает работать и в случае с учётными данными. Вывод: ограничьте `AllowCredentials()` той политикой, которая действительно касается cookie, а не всему вашему API.

## Уменьшение болтовни предварительных запросов

Каждый кроссдоменный запрос с непростым методом или заголовком оплачивает накладные расходы на круговой рейс предварительного запроса. `SetPreflightMaxAge(TimeSpan.FromMinutes(10))` сообщает браузеру, что он может кешировать результат предварительного запроса, так что повторные вызовы той же конечной точки пропускают переход `OPTIONS`. Браузеры ограничивают это значение (Chromium учитывает до двух часов, Firefox до 24, и у обоих есть свои потолки), поэтому относитесь к нему как к подсказке, а не как к гарантии. Тем не менее, для болтливого API его стоит установить.

Если вам нужно лишь несколько источников фронтенда и одна и та же политика повсюду, `AddDefaultPolicy` плюс `app.UseCors()` без параметров чуть менее церемонны, чем именованная политика. Для более крупного API, где у разных групп конечных точек разные правила, объедините именованную политику с `.RequireCors(...)` на `MapGroup`, что естественно сочетается со структурой, описанной в [организация конечных точек minimal API с MapGroup](/ru/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/).

## Когда токен отклонён, а CORS ни при чём

Как только предварительный запрос проходит и реальный запрос несёт `Access-Control-Allow-Origin`, любой оставшийся 401 — это настоящий сбой аутентификации, и вам следует перестать смотреть на CORS. Обычные подозреваемые — несовпадающие `Audience` или `Authority`, рассинхронизация часов по времени жизни токена или инструменты, которые молча отбрасывают заголовок. Если интерфейс вроде Scalar или Swagger отправляет запросы без токена bearer, хотя вы его вставили, это отдельная, хорошо задокументированная проблема, рассмотренная в [почему ваш токен bearer игнорируется в Scalar](/ru/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/) и в [добавление потоков аутентификации OpenAPI в Swagger UI](/ru/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/).

Ментальная модель, которая удерживает вас от неприятностей: CORS — это браузер, спрашивающий «разрешён ли этот кроссдоменный вызов и могу ли я прочитать ответ?», а JWT bearer — это сервер, спрашивающий «доверяю ли я этому токену?». Настройте политику так, чтобы она называла ваши источники и заголовок `Authorization`, выполняйте `UseCors` до middleware аутентификации, опускайте `AllowCredentials`, пока в игре нет cookie, и эти два барьера перестанут мешать друг другу.

Источники: [Enable Cross-Origin Requests (CORS) in ASP.NET Core - Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/security/cors), [Access-Control-Allow-Headers - MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Access-Control-Allow-Headers), [Fetch Standard - WHATWG](https://fetch.spec.whatwg.org/), [CorsService source - dotnet/aspnetcore](https://github.com/dotnet/aspnetcore/blob/main/src/Middleware/CORS/src/Infrastructure/CorsService.cs), [aspnetcore#16584 - CORS headers and JWT bearer 401](https://github.com/dotnet/aspnetcore/issues/16584).
