---
title: "JWT-Bearer-Authentifizierung in einer Minimal API in ASP.NET Core 11 einrichten"
description: "Eine vollständige, funktionierende Einrichtung der JWT-Bearer-Authentifizierung in einer Minimal API in ASP.NET Core 11: das Paket installieren, AddAuthentication().AddJwtBearer() verdrahten, ein Token ausstellen, Endpunkte mit RequireAuthorization schützen, Rollen- und Claim-Richtlinien hinzufügen und alles mit dotnet user-jwts testen."
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
lang: "de"
translationOf: "2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-03
---

Um eine Minimal API in ASP.NET Core 11 mit JWT-Bearer-Tokens zu schützen, benötigen Sie drei bewegliche Teile: den Bearer-Handler mit `builder.Services.AddAuthentication().AddJwtBearer()` registrieren, ihm mitteilen, wie ein gültiges Token aussieht (Issuer, Audience, Signaturschlüssel), und die Endpunkte, die Sie schützen möchten, mit `.RequireAuthorization()` kennzeichnen. Der `WebApplication`-Host verdrahtet die Authentifizierungs- und Autorisierungs-Middleware für Sie, sodass eine minimale Einrichtung tatsächlich nur eine Handvoll Zeilen umfasst. Dieser Beitrag geht den vollständigen Weg von Anfang bis Ende durch: das Paket, die Konfiguration, das Ausstellen eines Tokens, das Schützen von Endpunkten, Rollen- und Claim-Richtlinien und das Testen mit `dotnet user-jwts`. Er zielt auf .NET 11 (zum Zeitpunkt des Schreibens Preview 5, GA im November 2026) mit `Microsoft.AspNetCore.Authentication.JwtBearer` und C# 14 ab, doch jeder Schritt hier funktioniert unverändert bis zurück zu .NET 8.

## Installieren Sie das eine Paket, das Sie brauchen

Bearer-Unterstützung ist standardmäßig nicht im geteilten Framework enthalten. Fügen Sie das Paket hinzu:

```bash
# .NET 11 SDK
dotnet add package Microsoft.AspNetCore.Authentication.JwtBearer
```

Dies zieht den `JwtBearerHandler`, die `AddJwtBearer`-Erweiterungsmethoden und den `Microsoft.IdentityModel`-Token-Stack ein, der das Token tatsächlich validiert. Sie benötigen `System.IdentityModel.Tokens.Jwt` für die Validierung nicht separat; der Handler verwendet intern den schnelleren `JsonWebTokenHandler`. Einen Typ zur Token-Erstellung werden Sie wollen, wenn Sie Tokens selbst ausstellen, was weiter unten behandelt wird.

## Die kleinste Konfiguration, die authentifiziert und autorisiert

Hier ist eine vollständige `Program.cs`, die das Bearer-Schema registriert, einen offenen Endpunkt und einen geschützten Endpunkt bereitstellt:

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

Zwei Dinge sind erwähnenswert, weil sie diejenigen zu Fall bringen, die vom älteren `Startup.cs`-Modell kommen.

Erstens gibt es in dieser Datei kein `app.UseAuthentication()` und kein `app.UseAuthorization()`, und sie funktioniert trotzdem. Im minimalen Hosting-Modell inspiziert `WebApplication` den Service-Container zur Build-Zeit, und wenn es die Authentifizierungs- und Autorisierungs-Services registriert sieht, fügt es beide Middleware in der richtigen Reihenfolge für Sie ein. Sie müssen `UseAuthentication` und `UseAuthorization` nur dann von Hand aufrufen, wenn Sie die Reihenfolge relativ zu anderer Middleware steuern müssen, wobei der klassische Fall CORS ist, das zuerst laufen muss. Wenn eine Browser-SPA diese API cross-origin aufruft, lesen Sie [wie man CORS für eine JWT-geschützte API konfiguriert](/de/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/), bevor Sie annehmen, dass die Auth-Verdrahtung falsch ist; ein Preflight, das den Header verschluckt, sieht identisch zu einem schlechten Token aus.

Zweitens ist `AddJwtBearer()` ohne Lambda nicht unvollständig. Es lädt seine `TokenValidationParameters` aus der Konfiguration, unter dem Abschnitt `Authentication:Schemes:Bearer`. Das ist das moderne, konfigurationsorientierte Muster, und es ist genau das, was `dotnet user-jwts` für Sie schreibt.

## Wo die Token-Regeln leben: Konfiguration vs. Code

Sie können dem Handler an zwei Stellen mitteilen, wie ein gültiges Token aussieht. Wählen Sie eine und bleiben Sie konsistent.

Der **konfigurationsorientierte** Ansatz hält Issuer und Audience aus Ihrem Code heraus und in der `appsettings.json`. Das Framework sucht unter `Authentication:Schemes:{SchemeName}`, und der Standard-Schemaname für `AddJwtBearer()` ist `Bearer`:

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

Der **codeorientierte** Ansatz setzt dieselben Werte im Lambda, zu dem Sie greifen, wenn Sie Tokens mit Ihrem eigenen symmetrischen Schlüssel signieren:

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

Wenn Ihre Tokens von einem externen OpenID-Connect-Anbieter stammen (Entra ID, Auth0, Keycloak, Okta, Duende IdentityServer), überspringen Sie den Signaturschlüssel vollständig und setzen `options.Authority`, und der Handler ermittelt den Issuer und die öffentlichen Signaturschlüssel aus den `/.well-known/openid-configuration`-Metadaten des Anbieters. Die vollständige Aufschlüsselung dessen, was jedes `Validate*`-Flag tut, und die Fünf-Minuten-`ClockSkew`-Falle, die Tokens über ihr `exp` hinaus leben lässt, finden Sie in [wie man Issuer, Audience und Lifetime eines JWT validiert](/de/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/). Für diese Einrichtungsanleitung ist der entscheidende Punkt, dass das Zuweisen eines brandneuen `TokenValidationParameters`-Objekts die Standardwerte vollständig ersetzt, listen Sie also jedes Flag auf, das Ihnen wichtig ist.

## Setzen Sie ein Standardschema, sonst tut ein einfaches [Authorize] nichts

`RequireAuthorization()` (und das `[Authorize]`-Attribut) fordert das *Standard*-Authentifizierungsschema heraus. `AddAuthentication()` ohne Argument registriert Services, setzt aber keinen Standard. Wenn Sie es so belassen, hat ein geschützter Endpunkt kein Schema zum Ausführen, der Benutzer bleibt anonym, und jede Anfrage antwortet mit 401, selbst mit einem perfekten Token. Das Benennen des Schemas behebt dies:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Authentication.JwtBearer;

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer();
```

`JwtBearerDefaults.AuthenticationScheme` ist die Zeichenfolge `"Bearer"`. Sie an `AddAuthentication` zu übergeben, setzt sowohl `DefaultAuthenticateScheme` als auch `DefaultChallengeScheme` in einem Aufruf, sodass ein einfaches `.RequireAuthorization()` nun weiß, dass es den Bearer-Handler ausführen soll. Wenn Sie ein *einzelnes* Bearer-Schema registrieren, ist dies der korrekte Standard. Diese Familie von "stiller 401 mit einem gültigen Token"-Bugs, fehlendes Standardschema, falsche Middleware-Reihenfolge, nicht übereinstimmender Schemaname, ist häufig genug, um eine eigene Anleitung zu haben: [warum Ihr ASP.NET-Core-JWT selbst mit einem gültigen Token 401 zurückgibt](/de/2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token/).

## Stellen Sie ein Token von einem Login-Endpunkt aus

Wenn Ihre API ihre eigene Identitätsquelle ist, benötigen Sie einen Endpunkt, der nach der Prüfung eines Anmeldedatensatzes signierte Tokens ausgibt. Verwenden Sie `JsonWebTokenHandler.CreateToken` mit einem `SecurityTokenDescriptor`:

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

Das HMAC-Geheimnis muss mindestens 256 Bit (32 Byte) für `HS256` haben, sonst wirft die Signaturschicht `IDX10720`. Halten Sie es aus dem Quellcode heraus: Verwenden Sie User Secrets in der Entwicklung (`dotnet user-secrets set "Jwt:Secret" "<a-long-random-string>"`) und einen echten Secret-Store in der Produktion. Dies ist ein selbst ausgestelltes Access-Token mit einer Lifetime von 15 Minuten; wenn der Client darüber hinaus angemeldet bleiben soll, ohne die Anmeldedaten erneut einzugeben, kombinieren Sie es mit einem Refresh-Flow, wie in [wie man Refresh-Tokens in ASP.NET Core Identity implementiert](/de/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/) beschrieben.

## Schützen Sie Endpunkte und lesen Sie die Claims des Aufrufers

`.RequireAuthorization()` ohne Argument bedeutet "jeder authentifizierte Benutzer". Injizieren Sie im Handler `ClaimsPrincipal`, um zu lesen, wer der Aufrufer ist:

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

Eine Feinheit zu Claim-Namen: `JwtBearerOptions.MapInboundClaims` ist standardmäßig `true`, was kurze JWT-Claim-Namen wie `sub` und `role` in die langen WS-*-URIs umschreibt (`ClaimTypes.NameIdentifier`, `ClaimTypes.Role`). Wenn Sie lieber mit den rohen Kurznamen arbeiten, setzen Sie `options.MapInboundClaims = false` und richten Sie dann `TokenValidationParameters.NameClaimType` und `RoleClaimType` auf das aus, was Ihre Tokens tatsächlich tragen. Diese Zuordnung ist der Grund, warum `user.Identity.Name` selbst bei einem gültigen Token null sein kann: Das Token hatte keinen Claim, der dem konfigurierten `NameClaimType` entsprach.

## Fügen Sie Rollen- und Claim-Richtlinien für feineren Zugriff hinzu

"Jeder authentifizierte Benutzer" reicht selten aus. Für alles jenseits einer pauschalen Sperre definieren Sie benannte Richtlinien einmal und hängen sie per Name an. `AddAuthorizationBuilder` ist der Minimal-API-freundliche Weg:

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

Eine Richtlinie ist ein Satz von Anforderungen, die der Aufrufer erfüllen muss. `RequireRole` prüft den Rollen-Claim; `RequireClaim("scope", "orders_api")` prüft, dass ein `scope`-Claim mit diesem Wert vorhanden ist. Ein Aufrufer, der sich authentifiziert, aber die Richtlinie nicht erfüllt, erhält ein **403**, kein 401. Diese Unterscheidung ist beim Debuggen wichtig: 401 bedeutet "wir wissen nicht, wer Sie sind" (Authentifizierung), 403 bedeutet "wir wissen es, und Sie sind nicht berechtigt" (Autorisierung). Wenn Sie ein 403 sehen, hören Sie auf, das Token anzuschauen, und schauen Sie die Richtlinie an.

Wenn mehrere Endpunkte eine Richtlinie teilen, wiederholen Sie nicht `.RequireAuthorization("...")` an jedem einzelnen. Gruppieren Sie sie, damit die Anforderung an einer einzigen Stelle lebt, was auch verhindert, dass ein Schema oder eine Richtlinie still zwischen Routen abdriftet:

```csharp
// .NET 11, C# 14
var admin = app.MapGroup("/admin").RequireAuthorization("admin_only");
admin.MapGet("/stats", () => "admin stats");
admin.MapDelete("/orders/{id}", (int id) => Results.NoContent());
```

Die Gruppierungsmuster, einschließlich verschachtelter Gruppen und Filter pro Gruppe, werden in [wie man Minimal-API-Endpunkte mit MapGroup organisiert](/de/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) behandelt.

## Testen Sie es, ohne eine Login-Oberfläche zu bauen

Sie brauchen weder einen Client noch einen echten Identitätsanbieter, um die Einrichtung zu prüfen. Das Werkzeug `dotnet user-jwts` prägt ein Token, das mit einem Schlüssel signiert ist, den es zugleich in Ihre Entwicklungskonfiguration einbindet, sodass die Validierung nicht an einer Schlüsselabweichung scheitern kann:

```bash
# .NET 11 SDK, run in the project directory
dotnet user-jwts create
```

Gegen ein Projekt ausgeführt, schreibt das Werkzeug die passenden Validierungsoptionen (einen `ValidIssuer` von `dotnet-user-jwts` sowie die URLs Ihrer App als `ValidAudiences`) in die `appsettings.Development.json` und gibt ein einsatzbereites Token aus. Um ein Token zu prägen, das die von Ihren Richtlinien geforderte Rolle und den geforderten Scope trägt:

```bash
# .NET 11 SDK
dotnet user-jwts create --role "admin" --scope "orders_api"
```

Dann senden Sie es:

```bash
# {token} is the value dotnet user-jwts printed
curl -i -H "Authorization: Bearer {token}" https://localhost:7259/orders
```

Das Header-Format ist strikt: das wörtliche Wort `Bearer`, ein Leerzeichen und dann das rohe Token, ohne Anführungszeichen. Wenn sich ein `user-jwts`-Token authentifiziert, das Ihres echten Anbieters aber nicht, liegt der Unterschied in den Claims des Tokens oder im Signaturschlüssel, nicht in Ihrer Verdrahtung. Wenn selbst das `user-jwts`-Token 401 antwortet, ist die Verdrahtung weiterhin falsch; prüfen Sie erneut das Standardschema und die Middleware-Reihenfolge.

## Die Einrichtung in sieben Schritten

Um den gesamten Ablauf als Checkliste zusammenzufassen:

1. Fügen Sie das Paket hinzu: `dotnet add package Microsoft.AspNetCore.Authentication.JwtBearer`.
2. Registrieren Sie das Schema und machen Sie es zum Standard: `builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme).AddJwtBearer();`.
3. Fügen Sie Autorisierung hinzu: `builder.Services.AddAuthorization();` (oder `AddAuthorizationBuilder()`, wenn Sie Richtlinien definieren).
4. Konfigurieren Sie, wie ein gültiges Token aussieht, entweder im Konfigurationsabschnitt `Authentication:Schemes:Bearer`, über `options.Authority` für einen OIDC-Anbieter oder über `TokenValidationParameters` im Code für selbst signierte Tokens.
5. Schützen Sie Endpunkte mit `.RequireAuthorization()` und fügen Sie einen Richtliniennamen für Rollen- oder Claim-Anforderungen hinzu.
6. Lassen Sie `WebApplication` die Middleware automatisch hinzufügen, oder rufen Sie `UseAuthentication` und dann `UseAuthorization` nur dann von Hand auf, wenn die Reihenfolge (zum Beispiel CORS) es erfordert.
7. Testen Sie mit `dotnet user-jwts create` und einer `curl`-Anfrage mit dem `Authorization: Bearer`-Header.

Das ist der gesamte Happy Path. Das mentale Modell, das dies klar hält: Die Authentifizierung entscheidet, *wer* der Aufrufer ist, indem sie das Token validiert und `HttpContext.User` befüllt, und die Autorisierung entscheidet, *ob* dieser Aufrufer fortfahren darf, indem sie Richtlinien auswertet. Halten Sie diese beiden Aufgaben in Ihrem Kopf getrennt, und fast jedes JWT-Problem ordnet sich selbst in "das Token ist falsch" (ein Validierungsproblem) oder "die Verdrahtung ist falsch" (ein Schema-, Middleware- oder Richtlinienproblem) ein. Wenn Sie noch entscheiden, ob Bearer-Tokens für Ihre App gegenüber serverseitigen Sitzungen überhaupt die richtige Wahl sind, wägen Sie die Kompromisse in [JWT vs. Cookie-Authentifizierung in ASP.NET Core 11](/de/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/) ab.

## Quellen

- [Authentication and authorization in Minimal APIs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/security), Microsoft Learn, für die automatische Middleware-Registrierung, `AddAuthorizationBuilder` und das Verhalten von `dotnet user-jwts`.
- [Configure JWT bearer authentication in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/configure-jwt-bearer-authentication), Microsoft Learn.
- [Generate tokens with dotnet user-jwts](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/jwt-authn), Microsoft Learn.
- [Microsoft.AspNetCore.Authentication.JwtBearer auf NuGet](https://www.nuget.org/packages/Microsoft.AspNetCore.Authentication.JwtBearer).
- [.NET 11 Preview 5 is now available](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-5/), .NET Blog, für die aktuelle Preview und das GA-Ziel im November 2026.
