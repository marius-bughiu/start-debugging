---
title: "Как реализовать refresh-токены в ASP.NET Core Identity"
description: "Два рабочих пути в .NET 11: встроенный эндпоинт /refresh из MapIdentityApi и собственная реализация на JWT с ротацией refresh-токенов, отслеживанием семейства и детекцией повторного использования."
pubDate: 2026-04-28
tags:
  - "aspnetcore"
  - "identity"
  - "authentication"
  - "jwt"
  - "dotnet-11"
template: how-to
lang: "ru"
translationOf: "2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity"
translatedBy: "claude"
translationDate: 2026-04-28
---

Если вы на .NET 8 или новее и встроенных непрозрачных bearer-токенов вам достаточно, вызовите `app.MapIdentityApi<TUser>()` и отправьте POST на `/refresh` с `refreshToken` из ответа на логин. Вы получите новый access-токен и новый refresh-токен, старый refresh-токен будет инвалидирован, а security stamp заново проверится по user store. Если же нужны настоящие JWT, настраиваемые сроки жизни, отзыв на отдельных устройствах или детекция повторного использования, встроенные эндпоинты до этого не дотягивают. Тогда придётся писать самому: короткоживущий JWT плюс серверная строка с refresh-токеном, хешируемая в покое, ротируемая при каждом обмене, с идентификатором семейства, чтобы реплей отзывал всю цепочку сессии.

В этом посте разобраны оба пути, когда какой из них корректен и какие нюансы кусают в продакшене. Используемые версии: .NET 11 GA, ASP.NET Core 11, EF Core 11, `Microsoft.AspNetCore.Identity.EntityFrameworkCore` 11.0 и `Microsoft.AspNetCore.Authentication.JwtBearer` 11.0.

## Что ASP.NET Core Identity реально предлагает в 2026 году

Главное, что нужно усвоить: **классический ASP.NET Core Identity (UI на cookies) никогда не имел refresh-токенов**. Он использует cookie сессии. Refresh-токены появляются только при аутентификации через bearer-токен, и Identity получил первоклассную поддержку bearer в .NET 8 через `AddIdentityApiEndpoints` и `MapIdentityApi`. В .NET 11 это почти не изменилось: поверхность API стабильна, добавлены небольшие исправления и более строгая повторная проверка security stamp.

Identity API endpoints регистрируют собственную bearer-схему (`IdentityConstants.BearerScheme`), за которой стоит `BearerTokenHandler`. Возвращаемый "access token" **не** является JWT. Это `AuthenticationTicket`, сериализованный и защищённый ASP.NET Data Protection. Клиент относится к нему как к непрозрачному. То же и с refresh-токеном: непрозрачный data-protected blob с зашитым `ExpiresUtc`.

```csharp
// Program.cs, .NET 11
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddDbContext<AppDbContext>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("Default")));

builder.Services
    .AddIdentityApiEndpoints<IdentityUser>()
    .AddEntityFrameworkStores<AppDbContext>();

builder.Services.AddAuthorization();

var app = builder.Build();
app.MapIdentityApi<IdentityUser>();
app.MapGet("/me", (ClaimsPrincipal u) => u.Identity!.Name).RequireAuthorization();
app.Run();
```

Один этот вызов `MapIdentityApi<IdentityUser>()` подключает `/register`, `/login`, `/refresh`, `/confirmEmail`, `/resendConfirmationEmail`, `/forgotPassword`, `/resetPassword`, `/manage/2fa`, `/manage/info`. Эндпоинт `/login` возвращает:

```json
{
  "tokenType": "Bearer",
  "accessToken": "CfDJ8...redacted...",
  "expiresIn": 3600,
  "refreshToken": "CfDJ8...redacted..."
}
```

Чтобы обновить токен, отправьте POST `{ "refreshToken": "..." }` на `/refresh`. Хендлер расшифровывает тикет, сверяет `ExpiresUtc` с `TimeProvider.GetUtcNow()`, вызывает `signInManager.ValidateSecurityStampAsync`, чтобы смена пароля гарантированно требовала нового логина, пересобирает principal через `CreateUserPrincipalAsync(user)` и возвращает свежую пару access + refresh через `TypedResults.SignIn`. При любой ошибке возвращается `401 Unauthorized`. Точный код лежит в [IdentityApiEndpointRouteBuilderExtensions.cs](https://github.com/dotnet/aspnetcore/blob/main/src/Identity/Core/src/IdentityApiEndpointRouteBuilderExtensions.cs).

## Когда MapIdentityApi достаточно, а когда нет

Встроенный поток годится для собственной SPA или мобильного приложения, где вы контролируете API и слой хранения, токены непрозрачны для всех, кроме вашего сервера, и проверять их как JWT не нужно. Он **не** годится, если выполняется хотя бы одно из:

- Нужно делиться токеном между несколькими resource-серверами, которые валидируют по подписи, а не по ключу Data Protection.
- Нужны JWT, которые downstream-сервисы или шлюзы могут самостоятельно интроспектировать.
- Нужно отзывать отдельные сессии ("разлогинь меня только на этом iPad") без обнуления security stamp пользователя и принудительного выхода со всех устройств сразу.
- Нужна серверная видимость живых refresh-токенов: кто, когда, с какого IP, когда последний раз ротировался.
- Нужна ротация refresh-токенов с детекцией повторного использования.

Refresh-тикет Data Protection для вас непрозрачен. Никакой строки в базе. Раз выпустив, вы можете инвалидировать его до `ExpiresUtc` лишь сменив security stamp пользователя через `UserManager.UpdateSecurityStampAsync`, что разлогинивает пользователя на всех устройствах. Уже одно это дисквалифицирует встроенный путь для большинства мульти-девайсных приложений. Команда dotnet/aspnetcore это признала в [issue #50009](https://github.com/dotnet/aspnetcore/issues/50009) и [#55792](https://github.com/dotnet/aspnetcore/issues/55792); более тонкая расширяемость остаётся давним запросом.

## Боеспособный собственный поток с JWT и ротируемыми refresh-токенами

Шаблон ниже это то, к чему приходит большинство продакшен-кодовых баз .NET 11. Пользователь аутентифицируется по логину и паролю через `UserManager`. При успехе вы выдаёте короткоживущий JWT (типично 5--15 минут) плюс долгоживущий refresh-токен (7--30 дней). Refresh-токен хранится на сервере в отдельной таблице, причём **в базе лежит только SHA-256 хеш**. При обновлении вы находите строку по хешу, помечаете её как использованную и выдаёте новую пару.

### Схема

```csharp
// .NET 11, EF Core 11
public class RefreshToken
{
    public Guid Id { get; set; }
    public string UserId { get; set; } = default!;
    public string TokenHash { get; set; } = default!; // SHA-256 of opaque token
    public Guid FamilyId { get; set; }                // shared across one chain
    public DateTime CreatedUtc { get; set; }
    public DateTime ExpiresUtc { get; set; }
    public DateTime? ConsumedUtc { get; set; }        // set when rotated
    public DateTime? RevokedUtc { get; set; }
    public Guid? ReplacedByTokenId { get; set; }
    public string? CreatedByIp { get; set; }
}
```

`FamilyId` это ключевая идея. Каждый refresh-токен, выпущенный из одного логина, привязан к одному семейству. Когда вы ротируете цепочку, новый токен наследует `FamilyId` родителя. Если кто-то предъявляет refresh-токен, у строки которого уже выставлен `ConsumedUtc != null`, это повторное использование, почти всегда кража, и единственный безопасный ответ это отозвать всё семейство (каждую строку с тем же `FamilyId`).

Индексируйте агрессивно: `(UserId, ExpiresUtc)` для очистки и уникальный индекс по `TokenHash`. Хешируйте, не шифруйте: даже при утечке БД атакующий не сможет предъявить сырой токен.

### Выпуск пары

```csharp
// .NET 11, C# 14
public sealed class TokenService(
    IOptions<JwtOptions> jwtOptions,
    AppDbContext db,
    TimeProvider time)
{
    public async Task<TokenPair> IssueAsync(IdentityUser user, Guid? existingFamily, string? ip, CancellationToken ct)
    {
        var now = time.GetUtcNow().UtcDateTime;
        var jwt = BuildJwt(user, now);
        var raw = GenerateRefreshToken();
        var family = existingFamily ?? Guid.NewGuid();

        db.RefreshTokens.Add(new RefreshToken
        {
            Id = Guid.NewGuid(),
            UserId = user.Id,
            TokenHash = Sha256(raw),
            FamilyId = family,
            CreatedUtc = now,
            ExpiresUtc = now.AddDays(jwtOptions.Value.RefreshDays),
            CreatedByIp = ip,
        });
        await db.SaveChangesAsync(ct);

        return new TokenPair(jwt, raw, jwtOptions.Value.AccessMinutes * 60);
    }

    private static string GenerateRefreshToken()
    {
        Span<byte> bytes = stackalloc byte[64]; // 512 bits, well above guidance floor
        RandomNumberGenerator.Fill(bytes);
        return Convert.ToBase64String(bytes);
    }

    private static string Sha256(string raw)
    {
        Span<byte> hash = stackalloc byte[32];
        SHA256.HashData(Encoding.UTF8.GetBytes(raw), hash);
        return Convert.ToHexString(hash);
    }

    private string BuildJwt(IdentityUser user, DateTime now)
    {
        var opts = jwtOptions.Value;
        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, user.Id),
            new(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString("N")),
            new("name", user.UserName ?? string.Empty),
            new("stamp", user.SecurityStamp ?? string.Empty),
        };

        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(opts.SigningKey));
        var creds = new SigningCredentials(key, SecurityAlgorithms.HmacSha256);
        var token = new JwtSecurityToken(
            issuer: opts.Issuer,
            audience: opts.Audience,
            claims: claims,
            notBefore: now,
            expires: now.AddMinutes(opts.AccessMinutes),
            signingCredentials: creds);
        return new JwtSecurityTokenHandler().WriteToken(token);
    }
}

public record TokenPair(string AccessToken, string RefreshToken, int ExpiresInSeconds);
```

`RandomNumberGenerator.Fill` вместо `Guid.NewGuid().ToString()` это не предмет торга. Guid имеет 122 бита случайности, на ряде платформ выдаёт подсказки порядка и никогда не задумывался как неугадываемый. 64 байта из CSPRNG операционной системы это нижняя граница.

Клейм `stamp` это защитная копия `SecurityStamp` пользователя. Вы будете проверять её при каждом обновлении: если сохранённый stamp больше не совпадает, значит пользователь сменил пароль или его принудительно разлогинили, и обновление надо отклонить.

### Эндпоинт /refresh с детекцией повторного использования

```csharp
// .NET 11, ASP.NET Core 11
app.MapPost("/auth/refresh", async (
    RefreshRequest request,
    AppDbContext db,
    UserManager<IdentityUser> users,
    TokenService tokens,
    TimeProvider time,
    HttpContext http,
    CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(request.RefreshToken))
        return Results.Unauthorized();

    var hash = Sha256(request.RefreshToken);
    var existing = await db.RefreshTokens.FirstOrDefaultAsync(t => t.TokenHash == hash, ct);
    if (existing is null)
        return Results.Unauthorized();

    var now = time.GetUtcNow().UtcDateTime;

    // Reuse detection: a consumed token presented again means theft.
    if (existing.ConsumedUtc is not null || existing.RevokedUtc is not null)
    {
        await db.RefreshTokens
            .Where(t => t.FamilyId == existing.FamilyId && t.RevokedUtc == null)
            .ExecuteUpdateAsync(s => s.SetProperty(t => t.RevokedUtc, now), ct);
        return Results.Unauthorized();
    }

    if (existing.ExpiresUtc <= now)
        return Results.Unauthorized();

    var user = await users.FindByIdAsync(existing.UserId);
    if (user is null) return Results.Unauthorized();

    var pair = await tokens.IssueAsync(user, existing.FamilyId, http.Connection.RemoteIpAddress?.ToString(), ct);

    existing.ConsumedUtc = now;
    existing.ReplacedByTokenId = await db.RefreshTokens
        .Where(t => t.UserId == user.Id && t.CreatedUtc == now)
        .Select(t => (Guid?)t.Id).FirstAsync(ct);
    await db.SaveChangesAsync(ct);

    return Results.Ok(pair);
});

public record RefreshRequest(string RefreshToken);
```

Пройдитесь по случаям отказа. Токена нет в БД: 401, без подсказки клиенту о причине. Токен уже использован: 401 плюс отзыв семейства, потому что либо оригинал украли, либо легитимный клиент сделал ретрай и потерял ответ. В любом случае пользователь должен пройти аутентификацию заново. Токен истёк: 401, без отзыва. Пользователь отсутствует: 401.

`ExecuteUpdateAsync` по семейству в EF Core 11 это один SQL UPDATE: строки в память не загружаются и change tracking не выполняется. Это важно, потому что в гонке вы хотите, чтобы отзыв был дешёвым и атомарным.

### Валидация JWT на стороне API

```csharp
// .NET 11
builder.Services
    .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(o =>
    {
        var jwt = builder.Configuration.GetSection("Jwt").Get<JwtOptions>()!;
        o.TokenValidationParameters = new TokenValidationParameters
        {
            ValidIssuer = jwt.Issuer,
            ValidAudience = jwt.Audience,
            IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwt.SigningKey)),
            ValidateIssuer = true,
            ValidateAudience = true,
            ValidateLifetime = true,
            ValidateIssuerSigningKey = true,
            ClockSkew = TimeSpan.FromSeconds(30),
        };
    });
```

Значение `ClockSkew` по умолчанию пять минут, то есть "пятиминутный" access-токен на практике живёт десять. Зафиксируйте его на тридцати секундах, если у вас нет веской причины. Сценарий, когда вы попадаете в эндпоинт обновления с ещё якобы валидным access-токеном из-за skew, является реальным источником тонких окон для повторного воспроизведения.

## Где хранить refresh-токен на клиенте

Три варианта в порядке убывающего доверия.

**HttpOnly, Secure, SameSite=Strict cookie, выставляемая сервером.** Лучший выбор по умолчанию для браузерной SPA. JavaScript не может его прочитать, поэтому XSS его не вытащит. CSRF имеет значение только для эндпоинта обновления и парируется через `SameSite=Strict` плюс явный anti-forgery заголовок. Access-токен возвращайте в JSON-теле, чтобы SPA держала его в памяти; никогда его не сохраняйте.

**Нативное защищённое хранилище на мобильном.** iOS Keychain, Android Keystore, доступные через `SecureStorage` в MAUI. ОС хранит секрет за разблокировкой устройства.

**LocalStorage / sessionStorage.** Просто и неправильно. Любой XSS уносит оба токена.

Возвращать refresh-токен в JSON-теле, как делает `MapIdentityApi`, защитимое решение, если клиент это нативное приложение или ваша SPA закалена строгой CSP. Это неправильное решение, если на странице есть хоть один сторонний скрипт.

## Нюансы, которые кусают

**Гонки при ротации.** Нестабильная мобильная сеть часто повторяет вызов обновления. Без идемпотентности второй вызов попадёт на уже использованный токен, и вы отзовёте семейство. На практике работают два решения: короткое окно толерантности (принимать токен с `ConsumedUtc`, если `ConsumedUtc + 30s > now` и тот же отпечаток клиента предъявляет его), либо делать ответ обновления кешируемым у клиента на несколько секунд по ключу токена запроса. Большинство команд выбирают окно толерантности.

**Шквал фоновых обновлений.** SPA с несколькими открытыми вкладками одновременно замечает приближение истечения access-токена, и все они стучатся на `/refresh` с одним и тем же refresh-токеном. Та же гонка, то же лекарство. Выбор лидера через `BroadcastChannel` в браузере это самый чистый ответ, если вы контролируете SPA.

**Забыть про очистку.** Cron или `IHostedService` должен ночью запускать `db.RefreshTokens.Where(t => t.ExpiresUtc < cutoff || t.ConsumedUtc < cutoff).ExecuteDeleteAsync()`. Без этого таблица растёт линейно по числу активных пользователей. `ExecuteDeleteAsync` в EF Core 11 это один оператор.

**Смешивание двух потоков.** Если вы вызываете `MapIdentityApi` и одновременно реализуете свой `/auth/refresh`, у вас два несовместимых bearer-схемы, и `[Authorize]` будет резолвиться к той, что задана по умолчанию. Выберите одно. Если идёте по своему пути, не регистрируйте `AddIdentityApiEndpoints`; используйте `AddIdentity` (вариант без cookies) плюс `AddJwtBearer`.

**Расхождение security stamp.** Если вы кладёте `SecurityStamp` в JWT, обязательно перепроверяйте его на обновлении против текущего значения в БД. Иначе сброс пароля не инвалидирует живые access-токены до их истечения, что может быть 15 минут несанкционированного доступа. Встроенный `MapIdentityApi` это делает за вас через bearer-хендлер; собственный поток нет, если вы это не напишете.

**Лимитируйте `/auth/refresh`.** Это публичный эндпоинт с угадываемой формой, который на каждый вызов делает поиск в БД. [Per-endpoint rate limiter](/ru/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) в ASP.NET Core 11 решает это в одну строку. Token bucket из 10 в минуту на IP щедр и останавливает глупые атаки.

## Связанное

- [Как тестировать код, использующий HttpClient](/ru/2026/04/how-to-unit-test-code-that-uses-httpclient/) разбирает тестирование клиентской стороны токен-осведомлённого `DelegatingHandler`, где у большинства потребителей и живёт логика обновления.
- [Как добавить глобальный фильтр исключений в ASP.NET Core 11](/ru/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) удобное место, чтобы превращать `SecurityTokenExpiredException` в 401 с подсказкой обновить токен.
- [Как мокать DbContext, не ломая change tracking](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) важно тут, потому что логика ротации это самое место, где вам сильнее всего нужен реальный интеграционный тест с EF Core.
- [Scalar в ASP.NET Core: почему ваш bearer token игнорируется в .NET 10](/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/) кроличья нора, в которую падают, когда новый поток ведёт себя не так, как Swashbuckle.

## Источники

- [IdentityApiEndpointRouteBuilderExtensions.cs в dotnet/aspnetcore](https://github.com/dotnet/aspnetcore/blob/main/src/Identity/Core/src/IdentityApiEndpointRouteBuilderExtensions.cs) реальная реализация `/refresh`.
- [Use Identity to secure a Web API backend for SPAs (MS Learn)](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/identity-api-authorization).
- [dotnet/aspnetcore #50009: MapIdentityApi HTTP endpoints](https://github.com/dotnet/aspnetcore/issues/50009) и [#55792: split MapIdentityApi into multiple APIs](https://github.com/dotnet/aspnetcore/issues/55792) о давних пробелах в расширяемости.
- [Andrew Lock: introducing the Identity API endpoints](https://andrewlock.net/exploring-the-dotnet-8-preview-introducing-the-identity-api-endpoints/) о замысле.
- [OWASP cheat sheet on JSON Web Tokens](https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_for_Java_Cheat_Sheet.html) про хранение и ротацию.
