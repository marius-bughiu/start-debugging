---
title: "Как валидировать издателя, аудиторию и срок действия JWT в ASP.NET Core 11"
description: "Полное руководство по TokenValidationParameters в ASP.NET Core 11: как работают ValidateIssuer, ValidateAudience и ValidateLifetime, какие на самом деле значения по умолчанию, почему Authority автоматически настраивает издателя и ключи подписи, ловушка ClockSkew в 5 минут и как читать коды ошибок IDX, когда отклоняется на вид валидный токен."
pubDate: 2026-06-22
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "jwt"
  - "security"
lang: "ru"
translationOf: "2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-06-22
---

Обработчик JWT bearer в ASP.NET Core не просто проверяет подпись. Он выполняет серию независимых проверок, управляемых через `TokenValidationParameters`: издателя (`iss`), аудиторию (`aud`), срок действия (`exp` и `nbf`) и ключ подписи. Хорошая новость в том, что `ValidateIssuer`, `ValidateAudience`, `ValidateLifetime` и `ValidateIssuerSigningKey` по умолчанию равны `true`, так что токен проверяется правильно сразу из коробки. Плохая новость в том, что "по умолчанию true" без настроенного значения означает, что обработчик всё равно выбрасывает исключение, и самая распространённая ошибка в продакшене здесь -- это токен, который живёт ещё пять минут после своего `exp`, потому что `ClockSkew` по умолчанию равен пяти минутам. Эта статья ориентирована на .NET 11 (preview 5 на момент написания) с `Microsoft.AspNetCore.Authentication.JwtBearer`, но модель валидации не менялась с .NET 8, 9 и 10.

## Что на самом деле валидирует обработчик bearer

Когда приходит запрос с `Authorization: Bearer <token>`, `JwtBearerHandler` передаёт сырой токен обработчику токенов (начиная с .NET 8 по умолчанию используется более быстрый `JsonWebTokenHandler` из `Microsoft.IdentityModel.JsonWebTokens`, а не старый `JwtSecurityTokenHandler`). Этот обработчик читает `JwtBearerOptions.TokenValidationParameters` и выполняет каждую включённую проверку по очереди. Если какая-либо проверка не проходит, он выбрасывает исключение, обработчик выдаёт 401, а ответ несёт заголовок `WWW-Authenticate: Bearer error="invalid_token"` с описанием.

Четыре проверки, которые важны почти для любого API:

- **Подпись** (`ValidateIssuerSigningKey`, включена по умолчанию): подпись токена проверяется против ключа. Это доказывает, что токен был создан тем, кто владеет приватным ключом, и не был подделан.
- **Издатель** (`ValidateIssuer`, включена по умолчанию): claim `iss` должен совпадать с `ValidIssuer` (или с одним из `ValidIssuers`). Это не даёт переотправить токен от другого поставщика идентификации против вашего API.
- **Аудитория** (`ValidateAudience`, включена по умолчанию): claim `aud` должен совпадать с `ValidAudience` (или с одним из `ValidAudiences`). Это не даёт принять вашим API токен, созданный для *другого* API того же издателя.
- **Срок действия** (`ValidateLifetime`, включена по умолчанию): текущее время должно быть на уровне или после `nbf` (not-before) и до `exp` (истечение), в пределах допуска `ClockSkew`.

Значения по умолчанию живут в `Microsoft.IdentityModel.Tokens.TokenValidationParameters`, и вы можете подтвердить их в [исходном коде](https://github.com/AzureAD/azure-activedirectory-identitymodel-extensions-for-dotnet/blob/dev/src/Microsoft.IdentityModel.Tokens/TokenValidationParameters.cs): каждый флаг `Validate*` инициализируется в `true`, а `RequireExpirationTime` и `RequireSignedTokens` тоже равны `true`. Вы не *включаете* валидацию. Вы поставляете значения, против которых она валидирует.

## Самая быстрая корректная настройка: указать на authority

Если ваши токены приходят от поставщика OpenID Connect (Entra ID, Auth0, Keycloak, Okta, экземпляр IdentityServer/Duende), вы почти никогда не задаёте ключ подписи или издателя вручную. Вы задаёте `Authority`, и обработчик обнаруживает всё остальное из метаданных поставщика.

```csharp
// .NET 11, C# 14
// Microsoft.AspNetCore.Authentication.JwtBearer 11.0.0-preview
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddAuthentication("Bearer")
    .AddJwtBearer(options =>
    {
        // Discovers issuer + JWKS signing keys from
        // {Authority}/.well-known/openid-configuration
        options.Authority = "https://login.example.com";

        // Maps to TokenValidationParameters.ValidAudience
        options.Audience = "api://my-api";

        // Everything below is already the default, shown for clarity:
        options.TokenValidationParameters.ValidateIssuer = true;
        options.TokenValidationParameters.ValidateAudience = true;
        options.TokenValidationParameters.ValidateLifetime = true;
        options.TokenValidationParameters.ValidateIssuerSigningKey = true;
    });

builder.Services.AddAuthorization();

var app = builder.Build();
app.UseAuthentication();
app.UseAuthorization();

app.MapGet("/me", (ClaimsPrincipal user) => user.Identity!.Name)
    .RequireAuthorization();

app.Run();
```

Когда вы задаёте `Authority`, за кулисами происходят две вещи:

1. `ConfigurationManager` загружает `{Authority}/.well-known/openid-configuration` и из него -- эндпоинт JWKS (JSON Web Key Set). Публичные ключи подписи, возвращённые там, становятся `IssuerSigningKeys`, а значение `issuer` из метаданных становится `ValidIssuer`. Менеджер кеширует это и периодически обновляет, так что ротация ключей у поставщика обрабатывается без повторного развёртывания.
2. `JwtBearerOptions.Audience` копируется в `TokenValidationParameters.ValidAudience`.

Вот почему минимальная конфигурация `Authority` + `Audience` валидирует полностью: издатель, аудитория, срок действия и подпись -- всё покрыто. Если ваш поставщик отдаёт метаданные только по HTTPS (так и должно быть), оставьте `options.RequireHttpsMetadata = true`, что является значением по умолчанию вне `Development`.

## Валидация токена, который вы подписали сами (симметричный ключ)

Если вы создаёте токены в том же приложении, например небольшой собственный API, выпускающий собственные токены доступа, то обнаруживать нечего -- метаданных OIDC нет. Вы поставляете издателя, аудиторию и ключ подписи явно.

```csharp
// .NET 11, C# 14
var key = new SymmetricSecurityKey(
    Encoding.UTF8.GetBytes(builder.Configuration["Jwt:Secret"]!)); // >= 32 bytes for HS256

builder.Services.AddAuthentication("Bearer")
    .AddJwtBearer(options =>
    {
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidIssuer = "https://my-api.example.com",

            ValidateAudience = true,
            ValidAudience = "my-api-clients",

            ValidateLifetime = true,

            ValidateIssuerSigningKey = true,
            IssuerSigningKey = key,

            // Default is 5 minutes. See the next section.
            ClockSkew = TimeSpan.FromSeconds(30),
        };
    });
```

Учтите, что присваивание совершенно нового `TokenValidationParameters` заменяет значения по умолчанию целиком, так что перечислите каждый флаг, который вам важен. Секрет HMAC должен быть не менее 256 бит (32 байта) для `HS256`, иначе слой подписи выбросит `IDX10720` при создании токена.

## Ловушка ClockSkew в пять минут

Это самое неожиданное поведение, и оно кусает тех, кто пишет тест, ожидающий, что токен будет отклонён в момент его истечения.

`TokenValidationParameters.ClockSkew` по умолчанию равен **пяти минутам** (`DefaultClockSkew = TimeSpan.FromMinutes(5)`). Он существует, чтобы поглощать расхождение часов между машиной, выпустившей токен, и машиной, которая его валидирует: без него разница в одну секунду в системных часах могла бы отклонять каждый только что созданный токен как "ещё не действительный" или принимать-затем-отклонять его непоследовательно. Цена в том, что токен с `exp` в 12:00:00 всё ещё принимается до 12:05:00 на валидирующем сервере.

Для большинства API пять минут поблажки для токена доступа безвредны и являются правильным значением по умолчанию. Но если вы выпускаете короткоживущие токены (скажем, 60-секундные токены доступа, подкреплённые потоком обновления, паттерн, описанный в [как реализовать токены обновления в ASP.NET Core Identity](/ru/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/)), skew доминирует над сроком действия, и токен фактически живёт шесть минут, а не одну. Затяните его осознанно:

```csharp
// .NET 11, C# 14
// Strict expiry. Only safe if your servers run NTP-synced clocks.
options.TokenValidationParameters.ClockSkew = TimeSpan.Zero;
```

Задавайте `ClockSkew = TimeSpan.Zero` только тогда, когда у вашего издателя и API синхронизированные часы (NTP на обоих, что нормально в любой облачной среде). Если они могут расходиться, небольшое ненулевое значение вроде 30 секунд -- разумная золотая середина. Не "чините" неожиданное отклонение токена *повышением* skew. Токен, который действительно истёк, должен быть отклонён; повышение skew, чтобы скрыть проблему с часами, лишь расширяет ваше окно для повторной отправки.

## Почему ValidateAudience = true без аудитории -- мина при запуске

Распространённая ошибка -- оставить `ValidateAudience = true` (значение по умолчанию), так и не задав `Audience` / `ValidAudience`. Обработчику не с чем сравнивать `aud`, поэтому он выбрасывает исключение на первом же запросе:

```text
IDX10208: Unable to validate audience. The 'audience' is null or whitespace
and validationParameters.ValidAudiences is also null or empty.
```

У вас есть два корректных ответа и ровно один неправильный:

- **Корректный и предпочтительный**: задайте `Audience` (или `ValidAudiences` для нескольких). Валидация аудитории -- это реальный контроль безопасности. Именно она не даёт переотправить токен, выпущенный для `api://billing` в вашем общем тенанте Entra, против `api://reporting`.
- **Корректный, только когда у вас действительно нет claim аудитории**: задайте `ValidateAudience = false` *явно* и напишите комментарий с объяснением почему. Некоторые устаревшие издатели не проставляют `aud`.
- **Неправильный**: глушить исключение, перехватывая его, или направлять `ValidAudience` на значение, которое вы не контролируете.

Та же форма применима к `ValidateIssuer = true` без `ValidIssuer` и без `Authority`: вы получаете `IDX10204` ("Unable to validate issuer"). Задание `Authority` заполняет `ValidIssuer` из метаданных, поэтому путь OIDC редко на это натыкается.

## Принимать более одного издателя или аудитории

Во время миграции между поставщиками идентификации, или когда один API обслуживает клиентов, созданных под несколькими именами аудитории, используйте коллекции во множественном числе. Они аддитивны ко всему, что обнаружено из `Authority`.

```csharp
// .NET 11, C# 14
options.TokenValidationParameters.ValidIssuers = new[]
{
    "https://old-idp.example.com",
    "https://login.example.com",
};
options.TokenValidationParameters.ValidAudiences = new[]
{
    "api://my-api",
    "api://my-api-legacy",
};
```

Токен проходит, если его `iss` совпадает с *любой* записью в `ValidIssuers`, а его `aud` совпадает с *любой* записью в `ValidAudiences`. Это позволяет запускать обоих издателей параллельно во время переключения и удалить старого, как только трафик иссякнет, без окна, в котором токены отклоняются.

## Чтение сбоя: включите коды IDX

Когда на вид нормальный токен получает 401, тело ответа пустое, а заголовок `WWW-Authenticate` лаконичен. Настоящая причина -- в исключении, которое обработчик проглотил. Подключите `OnAuthenticationFailed`, чтобы вывести её во время отладки:

```csharp
// .NET 11, C# 14
options.Events = new JwtBearerEvents
{
    OnAuthenticationFailed = context =>
    {
        // Logs the underlying SecurityTokenException, e.g. IDX10223
        context.NoResult();
        var logger = context.HttpContext.RequestServices
            .GetRequiredService<ILogger<Program>>();
        logger.LogWarning(context.Exception, "JWT validation failed");
        return Task.CompletedTask;
    },
};
```

Коды `IDX` из `Microsoft.IdentityModel` напрямую соответствуют четырём проверкам, и знание их завершает большинство сессий отладки за секунды:

- `IDX10223`: валидация срока действия не прошла, токен истёк. Проверьте `exp` и `ClockSkew`.
- `IDX10205` / `IDX10204`: издатель недействителен или не может быть валидирован. Claim `iss` не совпадает с `ValidIssuer`/`ValidIssuers`, или ни один не настроен.
- `IDX10214` / `IDX10208`: аудитория недействительна или не может быть валидирована. Claim `aud` не совпадает, или ни одна не настроена.
- `IDX10503` / `IDX10500`: валидация подписи не прошла, часто ключ, которого у API нет. С `Authority` это обычно означает устаревший кеш метаданных или поставщика, ротировавшего ключи; обновление `ConfigurationManager` это решает.

Если токен валидируется, но `User.Identity?.Name` равен null или ваши проверки `[Authorize(Roles = ...)]` не проходят, проблема в маппинге claim-ов, а не в валидации. `JwtBearerOptions.MapInboundClaims` по умолчанию равен `true`, что переписывает короткие имена claim-ов вроде `sub` и `role` в длинные URI WS-*. Задайте `options.MapInboundClaims = false`, чтобы сохранить исходные короткие имена, а затем задайте `TokenValidationParameters.NameClaimType` и `RoleClaimType` на то, что ваши токены действительно используют.

## Собираем всё вместе, шаг за шагом

1. Выберите якорь доверия. Для поставщика OIDC задайте `options.Authority`; издатель и ключи подписи приходят из метаданных. Для самоподписанных токенов задайте `ValidIssuer` и `IssuerSigningKey` вручную.
2. Задайте аудиторию. Присвойте `options.Audience` (или `ValidAudiences`), чтобы у `ValidateAudience = true` было что проверять. Не отключайте валидацию аудитории, если только ваши токены действительно не несут `aud`.
3. Оставьте `ValidateIssuer`, `ValidateAudience`, `ValidateLifetime` и `ValidateIssuerSigningKey` на их значении по умолчанию `true`. Вы настраиваете значения, а не переключатели.
4. Задайте `ClockSkew` под срок действия вашего токена. Сохраните значение по умолчанию в 5 минут для обычных токенов доступа; снизьте до `TimeSpan.Zero` или 30 секунд для короткоживущих токенов на синхронизированных по NTP часах.
5. Для сценариев с несколькими поставщиками или аудиториями используйте коллекции во множественном числе `ValidIssuers` / `ValidAudiences` во время переключения.
6. Добавьте логирование `JwtBearerEvents.OnAuthenticationFailed` вне продакшена, чтобы код `IDX` сообщал, какая из четырёх проверок не прошла.
7. Разместите `app.UseAuthentication()` перед `app.UseAuthorization()`, и если браузерное SPA вызывает API с другого источника, выстройте порядок middleware согласно [как настроить CORS для защищённого JWT API](/ru/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/).

## Когда валидация проходит, но запрос всё равно падает

Как только четыре проверки пройдены, любой оставшийся сбой -- это уже не проблема валидации токена. 403 (а не 401) означает, что токен был валиден, но не выполнено требование политики авторизации или роли, что является совершенно отдельным слоем. Запрос, который работает в коде, но падает из UI документации, обычно вызван тем, что инструмент отбрасывает заголовок, что рассмотрено в [почему ваш bearer-токен игнорируется в Scalar](/ru/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/) и в [добавление потоков аутентификации OpenAPI в Swagger UI](/ru/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/). А если вы подключаете аутентификацию к minimal API, сгруппируйте защищённые эндпоинты, чтобы политика применялась в одном месте, как показано в [организация эндпоинтов minimal API с помощью MapGroup](/ru/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/).

Ментальная модель, которая удерживает всё это простым: `TokenValidationParameters` -- это четыре независимых вопроса, которые обработчик задаёт каждому токену. Кто его подписал? Кто его выпустил? Для кого он? Действует ли он ещё? Значения по умолчанию делают все четыре обязательными, так что ваша единственная задача -- дать каждому корректное значение и помнить, что "действует ещё" несёт пятиминутный запас, пока вы не скажете иное.

Источники: [TokenValidationParameters source - AzureAD/azure-activedirectory-identitymodel-extensions-for-dotnet](https://github.com/AzureAD/azure-activedirectory-identitymodel-extensions-for-dotnet/blob/dev/src/Microsoft.IdentityModel.Tokens/TokenValidationParameters.cs), [Configure JWT bearer authentication in ASP.NET Core - Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/configure-jwt-bearer-authentication), [JwtBearerOptions - Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.authentication.jwtbearer.jwtbeareroptions), [Microsoft.AspNetCore.Authentication.JwtBearer - NuGet](https://www.nuget.org/packages/Microsoft.AspNetCore.Authentication.JwtBearer).
