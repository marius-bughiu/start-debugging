---
title: "Как настроить JWT bearer-аутентификацию в minimal API в ASP.NET Core 11"
description: "Полная рабочая настройка JWT bearer-аутентификации в minimal API в ASP.NET Core 11: установить пакет, подключить AddAuthentication().AddJwtBearer(), выпустить токен, защитить endpoint через RequireAuthorization, добавить политики ролей и claim, и протестировать всё это с помощью dotnet user-jwts."
pubDate: 2026-07-03
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-api"
  - "jwt"
  - "security"
lang: "ru"
translationOf: "2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-03
---

Чтобы защитить minimal API в ASP.NET Core 11 с помощью JWT bearer-токенов, вам нужны три составляющие: зарегистрировать bearer-обработчик через `builder.Services.AddAuthentication().AddJwtBearer()`, сообщить ему, как выглядит валидный токен (issuer, audience, ключ подписи), и пометить endpoint, которые вы хотите защитить, через `.RequireAuthorization()`. Хост `WebApplication` подключает middleware аутентификации и авторизации за вас, поэтому минимальная настройка действительно занимает считаные строки. Эта статья проходит весь путь от начала до конца: пакет, конфигурация, выпуск токена, защита endpoint, политики ролей и claim, и тестирование с помощью `dotnet user-jwts`. Она ориентирована на .NET 11 (Preview 5 на момент написания, GA в ноябре 2026) с `Microsoft.AspNetCore.Authentication.JwtBearer` и C# 14, но каждый шаг здесь работает без изменений вплоть до .NET 8.

## Установите единственный нужный пакет

Поддержка bearer по умолчанию не входит в общий фреймворк. Добавьте пакет:

```bash
# .NET 11 SDK
dotnet add package Microsoft.AspNetCore.Authentication.JwtBearer
```

Это подтягивает `JwtBearerHandler`, методы-расширения `AddJwtBearer` и стек токенов `Microsoft.IdentityModel`, который фактически валидирует токен. Для валидации отдельный `System.IdentityModel.Tokens.Jwt` не нужен; обработчик внутри использует более быстрый `JsonWebTokenHandler`. Тип для создания токенов вам понадобится, когда вы выпускаете токены сами, что рассмотрено ниже.

## Наименьшая конфигурация, которая аутентифицирует и авторизует

Вот полный `Program.cs`, который регистрирует схему bearer, предоставляет один открытый endpoint и один защищённый endpoint:

```csharp
// .NET 11, C# 14
// Microsoft.AspNetCore.Authentication.JwtBearer 11.0.0-preview
using System.Security.Claims;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddAuthentication()
    .AddJwtBearer(); // reads options from configuration, see below

builder.Services.AddAuthorization();

var app = builder.Build();

app.MapGet("/", () => "public, no token needed");

app.MapGet("/me", (ClaimsPrincipal user) => $"hello {user.Identity!.Name}")
    .RequireAuthorization();

app.Run();
```

Стоит отметить две вещи, потому что они сбивают с толку тех, кто пришёл со старой модели `Startup.cs`.

Во-первых, в этом файле нет ни `app.UseAuthentication()`, ни `app.UseAuthorization()`, и он всё равно работает. В минимальной модели хостинга `WebApplication` инспектирует контейнер сервисов во время сборки, и если он видит зарегистрированные сервисы аутентификации и авторизации, то вставляет оба middleware в правильном порядке за вас. Вызывать `UseAuthentication` и `UseAuthorization` вручную нужно только тогда, когда вам необходимо управлять порядком относительно другого middleware, классический случай, CORS, который должен выполняться первым. Если браузерная SPA обращается к этому API с другого origin, прочитайте [как настроить CORS для API, защищённого JWT](/ru/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/), прежде чем предполагать, что обвязка auth неправильная; preflight, съедающий заголовок, выглядит идентично плохому токену.

Во-вторых, `AddJwtBearer()` без лямбды не является неполным. Он загружает свои `TokenValidationParameters` из конфигурации, из секции `Authentication:Schemes:Bearer`. Это современный, ориентированный на конфигурацию подход, и это именно то, что `dotnet user-jwts` записывает за вас.

## Где живут правила токена: конфигурация или код

Вы можете сообщить обработчику, как выглядит валидный токен, в двух местах. Выберите одно и будьте последовательны.

Подход **на основе конфигурации** держит issuer и audience вне вашего кода, в `appsettings.json`. Фреймворк ищет в `Authentication:Schemes:{SchemeName}`, а имя схемы по умолчанию для `AddJwtBearer()` это `Bearer`:

```json
{
  "Authentication": {
    "Schemes": {
      "Bearer": {
        "ValidIssuer": "https://my-api.example.com",
        "ValidAudiences": [ "https://localhost:7259" ]
      }
    }
  }
}
```

Подход **на основе кода** задаёт те же значения в лямбде, к которому вы прибегнете, когда подписываете токены собственным симметричным ключом:

```csharp
// .NET 11, C# 14
using Microsoft.IdentityModel.Tokens;
using System.Text;

var key = new SymmetricSecurityKey(
    Encoding.UTF8.GetBytes(builder.Configuration["Jwt:Secret"]!)); // >= 32 bytes for HS256

builder.Services.AddAuthentication()
    .AddJwtBearer(options =>
    {
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidIssuer = "https://my-api.example.com",

            ValidateAudience = true,
            ValidAudience = "https://localhost:7259",

            ValidateLifetime = true,
            ValidateIssuerSigningKey = true,
            IssuerSigningKey = key,
        };
    });
```

Если ваши токены приходят от внешнего провайдера OpenID Connect (Entra ID, Auth0, Keycloak, Okta, Duende IdentityServer), вы полностью пропускаете ключ подписи и задаёте `options.Authority`, и обработчик обнаруживает issuer и открытые ключи подписи из метаданных провайдера `/.well-known/openid-configuration`. Полный разбор того, что делает каждый флаг `Validate*`, и ловушка пятиминутного `ClockSkew`, из-за которой токены живут дольше своего `exp`, находится в статье [как валидировать issuer, audience и lifetime JWT](/ru/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/). Для этого руководства по настройке ключевой момент в том, что присвоение нового объекта `TokenValidationParameters` полностью заменяет значения по умолчанию, поэтому перечислите каждый важный для вас флаг.

## Задайте схему по умолчанию, иначе простой [Authorize] ничего не делает

`RequireAuthorization()` (и атрибут `[Authorize]`) бросает вызов *схеме аутентификации по умолчанию*. `AddAuthentication()` без аргумента регистрирует сервисы, но не задаёт значение по умолчанию. Если оставить так, у защищённого endpoint нет схемы для выполнения, пользователь остаётся анонимным, и каждый запрос отвечает 401 даже с идеальным токеном. Именование схемы это исправляет:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Authentication.JwtBearer;

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer();
```

`JwtBearerDefaults.AuthenticationScheme` это строка `"Bearer"`. Передача её в `AddAuthentication` задаёт и `DefaultAuthenticateScheme`, и `DefaultChallengeScheme` за один вызов, так что простой `.RequireAuthorization()` теперь знает, что нужно выполнить bearer-обработчик. Когда вы регистрируете *единственную* схему bearer, это правильное значение по умолчанию. Это семейство багов "тихий 401 при валидном токене", отсутствие схемы по умолчанию, неправильный порядок middleware, несовпадающее имя схемы, встречается достаточно часто, чтобы иметь собственное руководство: [почему ваш JWT в ASP.NET Core возвращает 401 даже с валидным токеном](/ru/2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token/).

## Выпустите токен из endpoint входа

Если ваш API сам является источником идентичности, вам нужен endpoint, который выдаёт подписанные токены после проверки учётных данных. Используйте `JsonWebTokenHandler.CreateToken` с `SecurityTokenDescriptor`:

```csharp
// .NET 11, C# 14
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;
using System.Security.Claims;
using System.Text;

app.MapPost("/login", (LoginRequest req, IConfiguration config) =>
{
    // Replace with a real credential check against your user store.
    if (req is not { Username: "demo", Password: "demo" })
        return Results.Unauthorized();

    var key = new SymmetricSecurityKey(
        Encoding.UTF8.GetBytes(config["Jwt:Secret"]!));

    var descriptor = new SecurityTokenDescriptor
    {
        Issuer = "https://my-api.example.com",
        Audience = "https://localhost:7259",
        Expires = DateTime.UtcNow.AddMinutes(15),
        SigningCredentials = new SigningCredentials(
            key, SecurityAlgorithms.HmacSha256),
        Subject = new ClaimsIdentity(new[]
        {
            new Claim(ClaimTypes.Name, req.Username),
            new Claim(ClaimTypes.Role, "user"),
        }),
    };

    var token = new JsonWebTokenHandler().CreateToken(descriptor);
    return Results.Ok(new { access_token = token });
});

record LoginRequest(string Username, string Password);
```

Секрет HMAC должен быть не менее 256 бит (32 байта) для `HS256`, иначе слой подписи бросит `IDX10720`. Держите его вне исходного кода: используйте user secrets в разработке (`dotnet user-secrets set "Jwt:Secret" "<a-long-random-string>"`) и настоящее хранилище секретов в продакшене. Это самостоятельно выпущенный access-токен с временем жизни 15 минут; когда вы хотите, чтобы клиент оставался авторизованным дольше без повторного ввода учётных данных, сочетайте его с потоком refresh, как описано в [как реализовать refresh-токены в ASP.NET Core Identity](/ru/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/).

## Защитите endpoint и прочитайте claim вызывающего

`.RequireAuthorization()` без аргумента означает "любой аутентифицированный пользователь". Внутри обработчика внедрите `ClaimsPrincipal`, чтобы прочитать, кто вызывающий:

```csharp
// .NET 11, C# 14
app.MapGet("/orders", (ClaimsPrincipal user) =>
{
    var name = user.Identity!.Name;               // ClaimTypes.Name
    var isAdmin = user.IsInRole("admin");         // ClaimTypes.Role
    var sub = user.FindFirstValue(ClaimTypes.NameIdentifier);
    return Results.Ok(new { name, isAdmin, sub });
})
.RequireAuthorization();
```

Одна тонкость по поводу имён claim: `JwtBearerOptions.MapInboundClaims` по умолчанию равен `true`, что переписывает короткие имена claim JWT вроде `sub` и `role` в длинные URI WS-* (`ClaimTypes.NameIdentifier`, `ClaimTypes.Role`). Если вы предпочитаете работать с исходными короткими именами, задайте `options.MapInboundClaims = false`, а затем укажите `TokenValidationParameters.NameClaimType` и `RoleClaimType` на то, что реально несут ваши токены. Именно из-за этого сопоставления `user.Identity.Name` может быть null даже при валидном токене: у токена не было claim, соответствующего настроенному `NameClaimType`.

## Добавьте политики ролей и claim для более тонкого доступа

"Любой аутентифицированный пользователь" редко достаточно. Для всего, что выходит за рамки сплошного барьера, определите именованные политики один раз и подключайте их по имени. `AddAuthorizationBuilder` это дружественный к minimal API способ:

```csharp
// .NET 11, C# 14
builder.Services.AddAuthorizationBuilder()
    .AddPolicy("admin_only", policy =>
        policy.RequireRole("admin"))
    .AddPolicy("can_write_orders", policy =>
        policy
            .RequireRole("admin")
            .RequireClaim("scope", "orders_api"));

// ...

app.MapDelete("/orders/{id}", (int id) => Results.NoContent())
    .RequireAuthorization("admin_only");

app.MapPost("/orders", (object order) => Results.Created())
    .RequireAuthorization("can_write_orders");
```

Политика это набор требований, которые должен удовлетворить вызывающий. `RequireRole` проверяет claim роли; `RequireClaim("scope", "orders_api")` проверяет, что присутствует claim `scope` с этим значением. Вызывающий, который аутентифицировался, но не прошёл политику, получает **403**, а не 401. Это различие важно при отладке: 401 означает "мы не знаем, кто вы" (аутентификация), 403 означает "мы знаем, и вам не разрешено" (авторизация). Если вы видите 403, перестаньте смотреть на токен и посмотрите на политику.

Когда несколько endpoint используют одну политику, не повторяйте `.RequireAuthorization("...")` на каждом. Сгруппируйте их, чтобы требование жило в одном месте, что также предотвращает тихий разброс схемы или политики между маршрутами:

```csharp
// .NET 11, C# 14
var admin = app.MapGroup("/admin").RequireAuthorization("admin_only");
admin.MapGet("/stats", () => "admin stats");
admin.MapDelete("/orders/{id}", (int id) => Results.NoContent());
```

Паттерны группировки, включая вложенные группы и фильтры на группу, рассмотрены в статье [как организовать endpoint minimal API с помощью MapGroup](/ru/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/).

## Протестируйте без создания интерфейса входа

Чтобы проверить настройку, вам не нужен ни клиент, ни реальный провайдер идентичности. Инструмент `dotnet user-jwts` чеканит токен, подписанный ключом, который он также подключает в вашу конфигурацию разработки, так что валидация не может провалиться из-за несовпадения ключа:

```bash
# .NET 11 SDK, run in the project directory
dotnet user-jwts create
```

Запущенный в проекте, инструмент записывает соответствующие параметры валидации (`ValidIssuer` равный `dotnet-user-jwts` плюс URL вашего приложения как `ValidAudiences`) в `appsettings.Development.json` и выводит готовый к использованию токен. Чтобы отчеканить токен, несущий роль и scope, которые требуют ваши политики:

```bash
# .NET 11 SDK
dotnet user-jwts create --role "admin" --scope "orders_api"
```

Затем отправьте его:

```bash
# {token} is the value dotnet user-jwts printed
curl -i -H "Authorization: Bearer {token}" https://localhost:7259/orders
```

Формат заголовка строгий: буквальное слово `Bearer`, один пробел, затем сырой токен, без кавычек. Если токен `user-jwts` аутентифицируется, а токен вашего реального провайдера нет, разница в claim токена или в ключе подписи, а не в вашей обвязке. Если даже токен `user-jwts` отвечает 401, обвязка всё ещё неправильная; перепроверьте схему по умолчанию и порядок middleware.

## Настройка за семь шагов

Чтобы подытожить весь процесс в виде контрольного списка:

1. Добавьте пакет: `dotnet add package Microsoft.AspNetCore.Authentication.JwtBearer`.
2. Зарегистрируйте схему и сделайте её значением по умолчанию: `builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme).AddJwtBearer();`.
3. Добавьте авторизацию: `builder.Services.AddAuthorization();` (или `AddAuthorizationBuilder()`, если вы определяете политики).
4. Настройте, как выглядит валидный токен, либо в секции конфигурации `Authentication:Schemes:Bearer`, либо через `options.Authority` для провайдера OIDC, либо через `TokenValidationParameters` в коде для самоподписанных токенов.
5. Защитите endpoint через `.RequireAuthorization()`, добавив имя политики для требований роли или claim.
6. Позвольте `WebApplication` добавить middleware автоматически или вызовите `UseAuthentication`, а затем `UseAuthorization` вручную только тогда, когда порядок (например, CORS) этого требует.
7. Протестируйте с помощью `dotnet user-jwts create` и запроса `curl` с заголовком `Authorization: Bearer`.

Это весь счастливый путь. Ментальная модель, которая держит всё в ясности: аутентификация решает, *кто* вызывающий, валидируя токен и заполняя `HttpContext.User`, а авторизация решает, *может* ли этот вызывающий продолжить, оценивая политики. Держите эти две задачи раздельно в голове, и почти любая проблема с JWT раскладывается на "токен неправильный" (проблема валидации) или "обвязка неправильная" (проблема схемы, middleware или политики). Если вы всё ещё решаете, подходят ли bearer-токены для вашего приложения по сравнению с серверными сессиями, взвесьте компромиссы в статье [JWT против cookie-аутентификации в ASP.NET Core 11](/ru/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/).

## Источники

- [Authentication and authorization in Minimal APIs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/security), Microsoft Learn, об автоматической регистрации middleware, `AddAuthorizationBuilder` и поведении `dotnet user-jwts`.
- [Configure JWT bearer authentication in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/configure-jwt-bearer-authentication), Microsoft Learn.
- [Generate tokens with dotnet user-jwts](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/jwt-authn), Microsoft Learn.
- [Microsoft.AspNetCore.Authentication.JwtBearer на NuGet](https://www.nuget.org/packages/Microsoft.AspNetCore.Authentication.JwtBearer).
- [.NET 11 Preview 5 is now available](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-5/), .NET Blog, о текущей preview и цели GA в ноябре 2026.
