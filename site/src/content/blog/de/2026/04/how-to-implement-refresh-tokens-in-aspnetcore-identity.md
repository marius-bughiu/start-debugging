---
title: "Refresh Tokens in ASP.NET Core Identity implementieren"
description: "Zwei tragfähige Wege in .NET 11: der eingebaute /refresh-Endpunkt von MapIdentityApi und ein eigener Aufbau mit JWT, Refresh-Token-Rotation, Family-Tracking und Reuse-Detection."
pubDate: 2026-04-28
tags:
  - "aspnetcore"
  - "identity"
  - "authentication"
  - "jwt"
  - "dotnet-11"
template: how-to
lang: "de"
translationOf: "2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity"
translatedBy: "claude"
translationDate: 2026-04-28
---

Wenn Sie auf .NET 8 oder neuer sind und die eingebauten opaken Bearer-Tokens reichen, rufen Sie `app.MapIdentityApi<TUser>()` auf und schicken einen POST an `/refresh` mit dem `refreshToken` aus der Login-Antwort. Sie erhalten ein neues Access-Token plus ein neues Refresh-Token, das alte Refresh-Token wird invalidiert, und der Security Stamp wird gegen den User Store erneut geprüft. Falls Sie echte JWTs, konfigurierbare Lifetimes, geräte-spezifische Revocation oder Reuse-Detection brauchen, kommen Sie mit den eingebauten Endpunkten nicht ans Ziel. Dann führt kein Weg am Eigenbau vorbei: ein kurzlebiges JWT plus eine serverseitige Refresh-Token-Zeile, gehasht im Speicher, bei jedem Tausch rotiert, mit einer Family-ID, sodass ein Replay die ganze Sitzungskette revoziert.

Dieser Beitrag deckt beide Wege ab, wann welcher der richtige ist und welche Details in der Produktion typischerweise zubeißen. Referenzierte Versionen: .NET 11 GA, ASP.NET Core 11, EF Core 11, `Microsoft.AspNetCore.Identity.EntityFrameworkCore` 11.0 und `Microsoft.AspNetCore.Authentication.JwtBearer` 11.0.

## Was ASP.NET Core Identity 2026 tatsächlich liefert

Der wichtigste Punkt zum Verinnerlichen: **Klassisches ASP.NET Core Identity (die cookie-basierte UI) hatte nie Refresh Tokens**. Es nutzt ein Session-Cookie. Refresh Tokens kommen erst ins Spiel, wenn Sie über Bearer-Token authentifizieren, und Identity bekam erstklassige Bearer-Unterstützung in .NET 8 über `AddIdentityApiEndpoints` und `MapIdentityApi`. Daran hat sich in .NET 11 wenig geändert: Die API-Oberfläche ist stabil, mit kleinen Bugfixes und einer strikteren Security-Stamp-Revalidierung.

Die Identity-API-Endpunkte registrieren ein eigenes Bearer-Schema (`IdentityConstants.BearerScheme`), gestützt vom `BearerTokenHandler`. Das zurückgegebene "Access Token" ist **kein** JWT. Es ist ein `AuthenticationTicket`, serialisiert und durch ASP.NET Data Protection geschützt. Der Client behandelt es als opak. Gleiches gilt für das Refresh Token: opaker, von Data Protection geschützter Blob mit eingebautem `ExpiresUtc`.

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

Dieser eine Aufruf von `MapIdentityApi<IdentityUser>()` verdrahtet `/register`, `/login`, `/refresh`, `/confirmEmail`, `/resendConfirmationEmail`, `/forgotPassword`, `/resetPassword`, `/manage/2fa`, `/manage/info`. Der `/login`-Endpunkt liefert:

```json
{
  "tokenType": "Bearer",
  "accessToken": "CfDJ8...redacted...",
  "expiresIn": 3600,
  "refreshToken": "CfDJ8...redacted..."
}
```

Zum Refresh schicken Sie POST `{ "refreshToken": "..." }` an `/refresh`. Der Handler entpackt das Ticket, prüft `ExpiresUtc` gegen `TimeProvider.GetUtcNow()`, ruft `signInManager.ValidateSecurityStampAsync` auf, sodass eine Passwortänderung einen neuen Login erzwingt, baut den Principal über `CreateUserPrincipalAsync(user)` neu auf und liefert ein frisches Access-/Refresh-Paar über `TypedResults.SignIn` zurück. Bei einem Fehler kommt `401 Unauthorized`. Der genaue Code liegt in [IdentityApiEndpointRouteBuilderExtensions.cs](https://github.com/dotnet/aspnetcore/blob/main/src/Identity/Core/src/IdentityApiEndpointRouteBuilderExtensions.cs).

## Wann MapIdentityApi reicht und wann nicht

Der eingebaute Flow taugt für eine Erst-Partei-SPA oder mobile App, bei der Sie API und Speicherschicht kontrollieren, die Tokens für alle außer Ihrem Server opak sind und Sie sie nicht als JWT inspizieren müssen. Er taugt **nicht**, wenn eines der folgenden Punkte zutrifft:

- Sie müssen ein Token zwischen mehreren Resource-Servern teilen, die per Signatur und nicht per Data-Protection-Schlüssel validieren.
- Sie wollen JWTs, die nachgelagerte Dienste oder Gateways introspectieren können.
- Sie müssen einzelne Sitzungen revozieren ("logge mich nur auf diesem iPad aus"), ohne den Security Stamp des Nutzers zu ändern und alle Geräte gleichzeitig auszuloggen.
- Sie brauchen serverseitige Sicht darauf, welche Refresh Tokens leben: wer, wann, von welcher IP, wann zuletzt rotiert.
- Sie brauchen Refresh-Token-Rotation mit Reuse-Detection.

Das Data-Protection-Refresh-Ticket ist für Sie opak. Es gibt keine Zeile in Ihrer Datenbank dazu. Einmal ausgegeben, bleibt nur ein Weg, es vor seiner `ExpiresUtc` zu invalidieren: den Security Stamp des Nutzers über `UserManager.UpdateSecurityStampAsync` zu ändern, was ihn auf jedem Gerät ausloggt. Allein das disqualifiziert den eingebauten Weg für die meisten Multi-Device-Apps. Das dotnet/aspnetcore-Team hat das im [Issue #50009](https://github.com/dotnet/aspnetcore/issues/50009) und [#55792](https://github.com/dotnet/aspnetcore/issues/55792) anerkannt; feinere Erweiterbarkeit ist ein langjähriger Wunsch.

## Ein produktionsreifer eigener Flow mit JWT und rotierten Refresh Tokens

Das untenstehende Muster ist das, wo die meisten produktiven .NET-11-Codebases landen. Der Nutzer authentifiziert per Username + Passwort gegen den `UserManager`. Bei Erfolg geben Sie ein kurzlebiges JWT aus (typisch: 5 bis 15 Minuten) plus ein langlebiges Refresh Token (7 bis 30 Tage). Das Refresh Token wird serverseitig in einer eigenen Tabelle gespeichert, und **nur der SHA-256-Hash wird persistiert**. Beim Refresh suchen Sie die Zeile per Hash, markieren sie als verbraucht und geben ein neues Paar aus.

### Das Schema

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

`FamilyId` ist die Schlüsselidee. Jedes Refresh Token, das aus demselben Login entsteht, gehört zu einer Family. Beim Rotieren der Kette erbt das neue Token die `FamilyId` des Vorgängers. Wenn jemand ein Refresh Token vorlegt, dessen Zeile bereits `ConsumedUtc != null` hat, ist das Reuse, fast immer Diebstahl, und die einzige sichere Antwort ist, die ganze Family zu revozieren (jede Zeile mit derselben `FamilyId`).

Indizieren Sie aggressiv: `(UserId, ExpiresUtc)` für die Aufräumarbeit, ein eindeutiger Index auf `TokenHash`. Hashen, nicht verschlüsseln: Selbst bei einem DB-Leak kann ein Angreifer das Roh-Token nicht vorlegen.

### Das Paar ausgeben

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

`RandomNumberGenerator.Fill` statt `Guid.NewGuid().ToString()` ist nicht verhandelbar. Guids haben 122 Bit Zufall, lecken auf manchen Plattformen Reihenfolgehinweise und waren nie als unerratbar konzipiert. 64 Byte aus dem CSPRNG des Betriebssystems sind die Untergrenze.

Der `stamp`-Claim ist eine defensive Kopie des `SecurityStamp` des Nutzers. Sie prüfen ihn bei jedem Refresh: Wenn der persistierte Stamp nicht mehr passt, hat der Nutzer sein Passwort geändert oder wurde zwangsausgeloggt, und Sie weisen den Refresh ab.

### Der /refresh-Endpunkt mit Reuse-Detection

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

Gehen Sie die Fehlerfälle durch. Token nicht in der DB: 401, ohne dem Aufrufer den Grund zu verraten. Token bereits verbraucht: 401 plus Family-Revocation, denn entweder wurde das Original gestohlen oder der legitime Client hat retried und die Antwort verloren. So oder so: Den Nutzer zur erneuten Authentifizierung zwingen. Token abgelaufen: 401, ohne Revocation. Nutzer fehlt: 401.

Das `ExecuteUpdateAsync` auf der Family ist in EF Core 11 ein einziges SQL-UPDATE; es lädt die Zeilen nicht in den Speicher und führt kein Change Tracking aus. Das ist wichtig, weil Sie in einem umkämpften Race wollen, dass die Revocation billig und atomar ist.

### JWT-Validierung auf der API-Seite

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

Der Standardwert von `ClockSkew` beträgt fünf Minuten, was bedeutet, dass ein "Fünf-Minuten-Access-Token" in der Praxis zehn Minuten gilt. Setzen Sie ihn auf 30 Sekunden, wenn Sie keinen guten Grund für mehr haben. Das Muster, durch Skew mit einem scheinbar noch gültigen Access Token den Refresh-Endpunkt zu treffen, ist eine reale Quelle subtiler Replay-Fenster.

## Wo das Refresh Token clientseitig gespeichert wird

Drei Optionen, in absteigender Reihenfolge meines Vertrauens.

**HttpOnly, Secure, SameSite=Strict-Cookie, vom Server gesetzt.** Bester Default für Browser-SPAs. JavaScript kann es nicht lesen, also exfiltriert XSS nichts. CSRF zählt nur am Refresh-Endpunkt, abgemildert durch `SameSite=Strict` plus einen expliziten Anti-Forgery-Header. Geben Sie das Access Token im JSON-Body zurück, damit die SPA es im Speicher hält; persistieren Sie es nie.

**Native Secure Storage auf Mobile.** iOS Keychain, Android Keystore, über `SecureStorage` von MAUI angesprochen. Das OS schützt das Geheimnis hinter dem Geräte-Unlock.

**LocalStorage / sessionStorage.** Einfach und falsch. Jedes XSS hebt beide Tokens.

Das Refresh Token wie `MapIdentityApi` im JSON-Body zurückzugeben, ist verteidigbar, wenn der Client eine native App ist oder Ihre SPA mit einer strikten CSP gehärtet wurde. Es ist die falsche Wahl, sobald irgendein Drittskript auf der Seite läuft.

## Details, die zubeißen

**Race Conditions bei der Rotation.** Ein wackeliges Mobilfunknetz wiederholt den Refresh-Aufruf gerne. Ohne Idempotenz landet der zweite Aufruf auf einem bereits verbrauchten Token, und Sie revozieren die Family. Zwei Lösungen funktionieren in der Praxis: ein kurzes Gnadenfenster (akzeptieren Sie ein Token mit `ConsumedUtc`, falls `ConsumedUtc + 30s > now` und derselbe Client-Fingerprint es vorlegt), oder die Refresh-Antwort clientseitig für ein paar Sekunden cachebar machen, geschlüsselt am Request-Token. Die meisten Teams nehmen das Gnadenfenster.

**Hintergrund-Refresh-Stürme.** Eine SPA mit mehreren offenen Tabs bemerkt parallel, dass das Access Token gleich abläuft, und alle treffen `/refresh` mit demselben Refresh Token. Gleicher Race, gleiche Lösung. Eine `BroadcastChannel`-basierte Leader-Election im Browser ist die sauberste Antwort, wenn Sie die SPA kontrollieren.

**Aufräumen vergessen.** Ein Cron oder ein `IHostedService` sollte nachts laufen: `db.RefreshTokens.Where(t => t.ExpiresUtc < cutoff || t.ConsumedUtc < cutoff).ExecuteDeleteAsync()`. Sonst wächst die Tabelle linear mit aktiven Nutzern. `ExecuteDeleteAsync` in EF Core 11 macht daraus eine einzige Anweisung.

**Beide Flows mischen.** Wenn Sie `MapIdentityApi` aufrufen und gleichzeitig ein eigenes `/auth/refresh` implementieren, haben Sie zwei inkompatible Bearer-Schemata, und `[Authorize]` löst auf das auf, das gerade Default ist. Wählen Sie eines. Wenn Sie auf den eigenen Flow setzen, registrieren Sie nicht `AddIdentityApiEndpoints`; nehmen Sie `AddIdentity` (Variante ohne Cookies) plus `AddJwtBearer`.

**Security-Stamp-Drift.** Wenn Sie `SecurityStamp` ins JWT einbetten, müssen Sie ihn beim Refresh gegen den aktuellen DB-Wert prüfen. Sonst invalidiert ein Passwort-Reset die laufenden Access Tokens nicht bis zu deren Ablauf, was 15 Minuten unbefugten Zugriff bedeuten kann. Das eingebaute `MapIdentityApi` macht das über den Bearer-Handler für Sie; der eigene Flow nicht, sofern Sie es nicht selbst schreiben.

**Rate Limit auf `/auth/refresh`.** Es ist ein öffentlicher Endpunkt mit erratbarer Form, der pro Aufruf eine DB-Suche macht. Der [Per-Endpoint-Rate-Limiter](/de/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) in ASP.NET Core 11 macht das zur Einzeiler-Sache. Ein Token-Bucket von 10 pro Minute pro IP ist großzügig und stoppt die naiven Angriffe.

## Verwandt

- [HttpClient-Code mit Unit-Tests prüfen](/de/2026/04/how-to-unit-test-code-that-uses-httpclient/) deckt das Testen der Client-Seite eines token-bewussten `DelegatingHandler` ab, also genau dort, wo bei den meisten Konsumenten die Refresh-Logik lebt.
- [Globalen Exception-Filter in ASP.NET Core 11 hinzufügen](/de/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) ist ein sauberer Ort, um `SecurityTokenExpiredException` in eine 401 mit Refresh-Hinweis zu übersetzen.
- [DbContext mocken, ohne Change Tracking zu zerstören](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) ist hier wichtig, weil die Rotationslogik die Stelle ist, an der Sie am dringendsten einen echten EF-Core-Integrationstest haben wollen.
- [Scalar in ASP.NET Core: warum Ihr Bearer Token in .NET 10 ignoriert wird](/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/) ist das Kaninchenloch, in das viele beim ersten Mal fallen, wenn der neue Flow sich nicht wie Swashbuckle verhält.

## Quellen

- [IdentityApiEndpointRouteBuilderExtensions.cs in dotnet/aspnetcore](https://github.com/dotnet/aspnetcore/blob/main/src/Identity/Core/src/IdentityApiEndpointRouteBuilderExtensions.cs): die echte `/refresh`-Implementierung.
- [Use Identity to secure a Web API backend for SPAs (MS Learn)](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/identity-api-authorization).
- [dotnet/aspnetcore #50009: MapIdentityApi HTTP endpoints](https://github.com/dotnet/aspnetcore/issues/50009) und [#55792: split MapIdentityApi into multiple APIs](https://github.com/dotnet/aspnetcore/issues/55792) zu den langjährigen Erweiterbarkeitslücken.
- [Andrew Lock: introducing the Identity API endpoints](https://andrewlock.net/exploring-the-dotnet-8-preview-introducing-the-identity-api-endpoints/) zur Designbegründung.
- [OWASP cheat sheet on JSON Web Tokens](https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_for_Java_Cheat_Sheet.html) zur Speicher- und Rotationsempfehlung.
