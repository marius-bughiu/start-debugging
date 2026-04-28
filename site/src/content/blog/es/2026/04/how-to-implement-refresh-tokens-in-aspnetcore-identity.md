---
title: "Cómo implementar refresh tokens en ASP.NET Core Identity"
description: "Dos caminos válidos en .NET 11: el endpoint /refresh integrado en MapIdentityApi y una configuración personalizada con JWT, rotación de refresh tokens, seguimiento por familia y detección de reutilización."
pubDate: 2026-04-28
tags:
  - "aspnetcore"
  - "identity"
  - "authentication"
  - "jwt"
  - "dotnet-11"
template: how-to
lang: "es"
translationOf: "2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity"
translatedBy: "claude"
translationDate: 2026-04-28
---

Si estás en .NET 8 o posterior y los bearer tokens opacos integrados te bastan, llama a `app.MapIdentityApi<TUser>()` y haz POST a `/refresh` con el `refreshToken` que devolvió el login. Recibes un nuevo access token más un nuevo refresh token, el refresh token anterior queda invalidado y el security stamp se vuelve a validar contra el almacén de usuarios. Si necesitas JWT reales, tiempos de vida configurables, revocación multi-dispositivo o detección de reutilización, los endpoints integrados no llegan. Toca implementarlo a mano: un JWT de vida corta más una fila de refresh token en el servidor, con hash en reposo, rotada en cada intercambio y con un identificador de familia para que un replay revoque toda la cadena de sesión.

Este post cubre ambos caminos, cuándo es correcto cada uno y los detalles que suelen morder en producción. Versiones referenciadas: .NET 11 GA, ASP.NET Core 11, EF Core 11, `Microsoft.AspNetCore.Identity.EntityFrameworkCore` 11.0 y `Microsoft.AspNetCore.Authentication.JwtBearer` 11.0.

## Lo que ASP.NET Core Identity realmente trae en 2026

Lo más importante que hay que interiorizar: **el ASP.NET Core Identity clásico (la UI con cookies) nunca tuvo refresh tokens**. Usa una cookie de sesión. Los refresh tokens entran en juego solo cuando autenticas con bearer token, y Identity recibió soporte de bearer de primera clase en .NET 8 vía `AddIdentityApiEndpoints` y `MapIdentityApi`. Esa historia apenas cambia en .NET 11: la superficie de API es estable, con pequeñas correcciones de bugs y una validación del security stamp más estricta.

Los Identity API endpoints registran un esquema bearer personalizado (`IdentityConstants.BearerScheme`) respaldado por `BearerTokenHandler`. El "access token" que devuelve **no** es un JWT. Es un `AuthenticationTicket` serializado y protegido por ASP.NET Data Protection. El cliente lo trata como opaco. Lo mismo con el refresh token: blob opaco protegido por Data Protection con un `ExpiresUtc` empotrado.

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

Esa única llamada a `MapIdentityApi<IdentityUser>()` cablea `/register`, `/login`, `/refresh`, `/confirmEmail`, `/resendConfirmationEmail`, `/forgotPassword`, `/resetPassword`, `/manage/2fa`, `/manage/info`. El endpoint `/login` devuelve:

```json
{
  "tokenType": "Bearer",
  "accessToken": "CfDJ8...redacted...",
  "expiresIn": 3600,
  "refreshToken": "CfDJ8...redacted..."
}
```

Para refrescar, haz POST `{ "refreshToken": "..." }` a `/refresh`. El handler desprotege el ticket, comprueba `ExpiresUtc` contra `TimeProvider.GetUtcNow()`, llama a `signInManager.ValidateSecurityStampAsync` para que un cambio de contraseña fuerce un nuevo login, reconstruye el principal vía `CreateUserPrincipalAsync(user)` y devuelve un par fresco access + refresh con `TypedResults.SignIn`. Si algo falla devuelve `401 Unauthorized`. El código exacto vive en [IdentityApiEndpointRouteBuilderExtensions.cs](https://github.com/dotnet/aspnetcore/blob/main/src/Identity/Core/src/IdentityApiEndpointRouteBuilderExtensions.cs).

## Cuándo basta MapIdentityApi y cuándo no

El flujo integrado va bien para una SPA de primera parte o una app móvil donde tú controlas la API y la capa de almacenamiento, los tokens son opacos para todos menos tu servidor y no necesitas inspeccionarlos como JWT. **No** va bien si se cumple alguna de estas condiciones:

- Necesitas compartir un token entre varios servidores de recursos que validan por firma, no por clave de Data Protection.
- Quieres JWT que servicios o gateways downstream puedan introspectar.
- Necesitas revocar sesiones individuales ("ciérrame la sesión solo en este iPad") sin romper el security stamp del usuario y sacar a todos los dispositivos a la vez.
- Necesitas visibilidad en el servidor de qué refresh tokens están vivos: quién, cuándo, desde qué IP, cuándo se rotó por última vez.
- Necesitas rotación de refresh tokens con detección de reutilización.

El refresh ticket de Data Protection es opaco para ti. No hay una fila en tu base de datos. Una vez emitido, la única manera de invalidarlo antes de su `ExpiresUtc` es cambiar el security stamp del usuario vía `UserManager.UpdateSecurityStampAsync`, lo que lo desconecta de todos los dispositivos. Eso solo descalifica el camino integrado para la mayoría de apps multi-dispositivo. El equipo de dotnet/aspnetcore lo reconoció en el [issue #50009](https://github.com/dotnet/aspnetcore/issues/50009) y el [#55792](https://github.com/dotnet/aspnetcore/issues/55792); una extensibilidad más fina es una petición que lleva tiempo en la lista.

## Un flujo personalizado, listo para producción, con JWT y refresh tokens rotados

El patrón de abajo es donde aterrizan la mayoría de los códigos en producción de .NET 11. El usuario se autentica con usuario + contraseña contra `UserManager`. Si va bien, emites un JWT de vida corta (típico: 5 a 15 minutos) más un refresh token de vida larga (7 a 30 días). El refresh token se almacena en el servidor en una tabla dedicada y **solo se persiste el hash SHA-256**. En el refresh, encuentras la fila por hash, la marcas como consumida y emites un par nuevo.

### El esquema

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

`FamilyId` es la idea clave. Cada refresh token emitido a partir del mismo login se enlaza en una familia. Cuando rotas la cadena, el nuevo token hereda el `FamilyId` del padre. Si alguien presenta un refresh token cuya fila ya tiene `ConsumedUtc != null`, eso es reutilización, casi siempre robo, y la única respuesta segura es revocar la familia entera (cada fila con el mismo `FamilyId`).

Indexa con generosidad: `(UserId, ExpiresUtc)` para limpieza, e índice único sobre `TokenHash`. Hash, no cifrado: aunque tu base de datos se filtre, el atacante no puede presentar el token en bruto.

### Emitiendo el par

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

`RandomNumberGenerator.Fill` por encima de `Guid.NewGuid().ToString()` no es negociable. Los Guid son 122 bits de aleatoriedad, filtran pistas de orden en algunas plataformas y nunca se diseñaron para ser inadivinables. 64 bytes del CSPRNG del SO es el suelo.

El claim `stamp` es una copia defensiva del `SecurityStamp` del usuario. Lo comprobarás en cada refresh: si el stamp persistido ya no coincide, el usuario cambió su contraseña o lo deslogueaste a la fuerza, y rechazas el refresh.

### El endpoint /refresh con detección de reutilización

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

Repasa los casos de fallo. Token no está en la base de datos: 401, sin pista para el llamador del porqué. Token ya consumido: 401 más una revocación de familia, porque o bien el original fue robado o el cliente legítimo reintentó y perdió la respuesta. En cualquier caso, fuerza al usuario a re-autenticarse. Token expirado: 401, sin necesidad de revocar. Usuario inexistente: 401.

El `ExecuteUpdateAsync` sobre la familia es un único UPDATE de SQL en EF Core 11: no carga las filas en memoria ni ejecuta change tracking. Eso importa porque, en una carrera disputada, quieres que la revocación sea barata y atómica.

### Validación del JWT en el lado de la API

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

El `ClockSkew` por defecto es de cinco minutos, lo que significa que un access token "de cinco minutos" en la práctica vive diez. Bájalo a treinta segundos salvo que tengas una buena razón. El patrón de pegar a tu endpoint de refresh con un access token aparentemente válido por culpa del skew es una fuente real de ventanas de replay sutiles.

## Dónde guardar el refresh token en el cliente

Tres opciones, en orden decreciente de cuánto las recomiendo.

**Cookie HttpOnly, Secure, SameSite=Strict puesta por el servidor.** El mejor valor por defecto para SPA en navegador. JavaScript no puede leerla, así que XSS no la puede exfiltrar. CSRF solo importa en el endpoint de refresh, y lo mitigas con `SameSite=Strict` más un header anti-forgery explícito. Devuelve el access token en el cuerpo JSON para que la SPA lo guarde en memoria; nunca lo persistas.

**Almacenamiento seguro nativo en móvil.** iOS Keychain, Android Keystore, accedidos a través de `SecureStorage` de MAUI. El SO custodia el secreto detrás del desbloqueo del dispositivo.

**LocalStorage / sessionStorage.** Fácil y mal. Cualquier XSS se lleva ambos tokens.

Devolver el refresh token en el cuerpo JSON, como hace `MapIdentityApi`, es una decisión defendible cuando el cliente es una app nativa o tu SPA está endurecida con una CSP estricta. Es la decisión equivocada si tienes scripts de terceros en la página.

## Detalles que muerden

**Condiciones de carrera en la rotación.** Una red móvil inestable suele reintentar la llamada de refresh. Sin idempotencia, la segunda llamada cae sobre un token ya consumido y revocas la familia. Dos arreglos funcionan en la práctica: una ventana de gracia corta (acepta un token con `ConsumedUtc` si `ConsumedUtc + 30s > now` y la misma huella de cliente lo está presentando) o hacer que la respuesta del refresh sea cacheable por unos segundos en el cliente, con clave del token de la solicitud. La mayoría de equipos eligen la ventana de gracia.

**Tormentas de refresh en segundo plano.** Una SPA con varias pestañas abiertas detecta a la vez que el access token está a punto de expirar y todas pegan a `/refresh` con el mismo refresh token. Misma carrera, mismo arreglo. Una elección de líder basada en `BroadcastChannel` en el navegador es la respuesta más limpia cuando controlas la SPA.

**Olvidarse de la limpieza.** Un cron o un `IHostedService` debería correr cada noche: `db.RefreshTokens.Where(t => t.ExpiresUtc < cutoff || t.ConsumedUtc < cutoff).ExecuteDeleteAsync()`. Sin ello, la tabla crece linealmente con los usuarios activos. El `ExecuteDeleteAsync` de EF Core 11 lo deja en una sola sentencia.

**Mezclar los dos flujos.** Si llamas a `MapIdentityApi` y además implementas tu propio `/auth/refresh`, ahora tienes dos esquemas bearer incompatibles y `[Authorize]` resolverá al que sea por defecto. Elige uno. Si adoptas el flujo personalizado, no registres `AddIdentityApiEndpoints`; usa `AddIdentity` (variante sin cookies) más `AddJwtBearer`.

**Deriva del security stamp.** Si embebes `SecurityStamp` en el JWT, debes re-comprobarlo en el refresh contra el valor actual en la base de datos. Si no, un reset de contraseña no invalida los access tokens vivos hasta que expiren, lo que pueden ser 15 minutos de acceso no autorizado. El `MapIdentityApi` integrado lo hace por ti vía el bearer handler; el flujo personalizado no, salvo que lo escribas.

**Pon rate limit a `/auth/refresh`.** Es un endpoint público con una forma adivinable y hace una lookup de base de datos por llamada. El [rate limiter por endpoint](/es/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) de ASP.NET Core 11 lo deja en una línea. Un token-bucket de 10 por minuto por IP es generoso y para los ataques tontos.

## Relacionado

- [Cómo testear código que usa HttpClient](/es/2026/04/how-to-unit-test-code-that-uses-httpclient/) cubre cómo testear el lado cliente de un `DelegatingHandler` consciente de tokens, que es exactamente donde vive la lógica de refresh en la mayoría de los consumidores.
- [Cómo añadir un filtro global de excepciones en ASP.NET Core 11](/es/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) es un buen sitio para traducir `SecurityTokenExpiredException` a un 401 con la pista de refrescar.
- [Cómo mockear DbContext sin romper el change tracking](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) importa aquí porque la lógica de rotación es el sitio donde más quieres un test de integración real con EF Core.
- [Scalar en ASP.NET Core: por qué tu bearer token es ignorado en .NET 10](/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/) es la madriguera donde caen muchos la primera vez que el flujo nuevo no se comporta como Swashbuckle.

## Fuentes

- [IdentityApiEndpointRouteBuilderExtensions.cs en dotnet/aspnetcore](https://github.com/dotnet/aspnetcore/blob/main/src/Identity/Core/src/IdentityApiEndpointRouteBuilderExtensions.cs): la implementación real de `/refresh`.
- [Use Identity to secure a Web API backend for SPAs (MS Learn)](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/identity-api-authorization).
- [dotnet/aspnetcore #50009: MapIdentityApi HTTP endpoints](https://github.com/dotnet/aspnetcore/issues/50009) y [#55792: split MapIdentityApi into multiple APIs](https://github.com/dotnet/aspnetcore/issues/55792) para los huecos de extensibilidad de larga data.
- [Andrew Lock: introducing the Identity API endpoints](https://andrewlock.net/exploring-the-dotnet-8-preview-introducing-the-identity-api-endpoints/) para el racional del diseño.
- [OWASP cheat sheet on JSON Web Tokens](https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_for_Java_Cheat_Sheet.html) para la guía sobre almacenamiento y rotación.
