---
title: "Aussteller, Zielgruppe und Gültigkeit eines JWT in ASP.NET Core 11 validieren"
description: "Ein vollständiger Leitfaden zu TokenValidationParameters in ASP.NET Core 11: wie ValidateIssuer, ValidateAudience und ValidateLifetime funktionieren, wie die Standardwerte tatsächlich aussehen, warum Authority den Aussteller und die Signaturschlüssel automatisch konfiguriert, die Falle der 5 Minuten ClockSkew und wie Sie die IDX-Fehlercodes lesen, wenn ein scheinbar gültiges Token abgelehnt wird."
pubDate: 2026-06-22
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "jwt"
  - "security"
lang: "de"
translationOf: "2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-06-22
---

Der JWT-Bearer-Handler in ASP.NET Core prüft nicht nur eine Signatur. Er führt eine Reihe unabhängiger Prüfungen aus, die von `TokenValidationParameters` gesteuert werden: den Aussteller (`iss`), die Zielgruppe (`aud`), die Gültigkeit (`exp` und `nbf`) und den Signaturschlüssel. Die gute Nachricht ist, dass `ValidateIssuer`, `ValidateAudience`, `ValidateLifetime` und `ValidateIssuerSigningKey` standardmäßig auf `true` stehen, sodass ein Token von Anfang an korrekt geprüft wird. Die schlechte Nachricht ist, dass "standardmäßig true" ohne einen konfigurierten Wert bedeutet, dass der Handler trotzdem eine Exception wirft, und der häufigste Produktionsfehler hier ist ein Token, das fünf Minuten über sein `exp` hinaus lebt, weil `ClockSkew` standardmäßig fünf Minuten beträgt. Dieser Artikel zielt auf .NET 11 (Preview 5 zum Zeitpunkt des Schreibens) mit `Microsoft.AspNetCore.Authentication.JwtBearer`, aber das Validierungsmodell ist seit .NET 8, 9 und 10 unverändert.

## Was der Bearer-Handler tatsächlich validiert

Wenn eine Anfrage mit `Authorization: Bearer <token>` eintrifft, übergibt der `JwtBearerHandler` das rohe Token an einen Token-Handler (seit .NET 8 ist der Standard der schnellere `JsonWebTokenHandler` aus `Microsoft.IdentityModel.JsonWebTokens`, nicht der ältere `JwtSecurityTokenHandler`). Dieser Handler liest `JwtBearerOptions.TokenValidationParameters` und führt jede aktivierte Prüfung nacheinander aus. Schlägt eine Prüfung fehl, wirft er eine Exception, der Handler erzeugt einen 401, und die Antwort trägt einen `WWW-Authenticate: Bearer error="invalid_token"`-Header mit einer Beschreibung.

Die vier Prüfungen, die für nahezu jede API zählen:

- **Signatur** (`ValidateIssuerSigningKey`, standardmäßig aktiv): Die Signatur des Tokens wird gegen einen Schlüssel verifiziert. Das beweist, dass das Token von jemandem mit dem privaten Schlüssel geprägt wurde und nicht manipuliert ist.
- **Aussteller** (`ValidateIssuer`, standardmäßig aktiv): Der `iss`-Claim muss mit `ValidIssuer` (oder einem von `ValidIssuers`) übereinstimmen. Das verhindert, dass ein Token von einem anderen Identitätsanbieter gegen Ihre API erneut gesendet wird.
- **Zielgruppe** (`ValidateAudience`, standardmäßig aktiv): Der `aud`-Claim muss mit `ValidAudience` (oder einem von `ValidAudiences`) übereinstimmen. Das verhindert, dass ein Token, das für eine *andere* API desselben Ausstellers geprägt wurde, von Ihrer akzeptiert wird.
- **Gültigkeit** (`ValidateLifetime`, standardmäßig aktiv): Die aktuelle Zeit muss bei oder nach `nbf` (not-before) und vor `exp` (Ablauf) liegen, innerhalb der `ClockSkew`-Toleranz.

Die Standardwerte liegen in `Microsoft.IdentityModel.Tokens.TokenValidationParameters`, und Sie können sie im [Quellcode](https://github.com/AzureAD/azure-activedirectory-identitymodel-extensions-for-dotnet/blob/dev/src/Microsoft.IdentityModel.Tokens/TokenValidationParameters.cs) bestätigen: Jedes `Validate*`-Flag wird mit `true` initialisiert, und `RequireExpirationTime` sowie `RequireSignedTokens` sind ebenfalls `true`. Sie schalten die Validierung nicht *ein*. Sie liefern die Werte, gegen die sie validiert.

## Die schnellste korrekte Konfiguration: auf eine Authority verweisen

Wenn Ihre Token von einem OpenID-Connect-Anbieter stammen (Entra ID, Auth0, Keycloak, Okta, eine IdentityServer-/Duende-Instanz), setzen Sie den Signaturschlüssel oder den Aussteller fast nie von Hand. Sie setzen `Authority`, und der Handler entdeckt alles Übrige aus den Metadaten des Anbieters.

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

Zwei Dinge geschehen im Hintergrund, wenn Sie `Authority` setzen:

1. Ein `ConfigurationManager` ruft `{Authority}/.well-known/openid-configuration` ab und daraus den JWKS-Endpunkt (JSON Web Key Set). Die dort zurückgegebenen öffentlichen Signaturschlüssel werden zu den `IssuerSigningKeys`, und der `issuer`-Wert der Metadaten wird zum `ValidIssuer`. Der Manager cacht dies und aktualisiert es periodisch, sodass die Schlüsselrotation beim Anbieter ohne ein erneutes Deployment gehandhabt wird.
2. `JwtBearerOptions.Audience` wird in `TokenValidationParameters.ValidAudience` kopiert.

Deshalb validiert eine minimale Konfiguration aus `Authority` + `Audience` vollständig: Aussteller, Zielgruppe, Gültigkeit und Signatur sind alle abgedeckt. Wenn Ihr Anbieter Metadaten nur über HTTPS bereitstellt (das sollte er), behalten Sie `options.RequireHttpsMetadata = true` bei, was außerhalb von `Development` der Standard ist.

## Ein selbst signiertes Token validieren (symmetrischer Schlüssel)

Wenn Sie Token in derselben Anwendung prägen, etwa eine kleine eigene API, die ihre eigenen Access-Token ausstellt, gibt es keine OIDC-Metadaten zu entdecken. Sie liefern Aussteller, Zielgruppe und Signaturschlüssel explizit.

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

Beachten Sie, dass die Zuweisung eines völlig neuen `TokenValidationParameters` die Standardwerte vollständig ersetzt, listen Sie also jedes Flag auf, das Ihnen wichtig ist. Das HMAC-Secret muss für `HS256` mindestens 256 Bit (32 Bytes) lang sein, sonst wirft die Signaturschicht `IDX10720` beim Erstellen des Tokens.

## Die Fünf-Minuten-Falle von ClockSkew

Dies ist das überraschendste Verhalten, und es trifft jene, die einen Test schreiben, der erwartet, dass ein Token in dem Augenblick abgelehnt wird, in dem es abläuft.

`TokenValidationParameters.ClockSkew` beträgt standardmäßig **fünf Minuten** (`DefaultClockSkew = TimeSpan.FromMinutes(5)`). Es existiert, um die Uhrabweichung zwischen der Maschine, die das Token ausgestellt hat, und der, die es validiert, abzufedern: ohne es könnte ein Unterschied von einer Sekunde in den Systemuhren jedes frisch geprägte Token als "noch nicht gültig" ablehnen oder es inkonsistent akzeptieren und ablehnen. Der Preis ist, dass ein Token mit `exp` von 12:00:00 auf dem validierenden Server noch bis 12:05:00 akzeptiert wird.

Für die meisten APIs sind fünf Minuten Kulanz bei einem Access-Token harmlos und der richtige Standard. Aber wenn Sie kurzlebige Token ausstellen (etwa 60-Sekunden-Access-Token, abgesichert durch einen Refresh-Flow, das Muster aus [wie man Refresh-Token in ASP.NET Core Identity implementiert](/de/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/)), dominiert der Skew die Gültigkeit, und das Token lebt effektiv sechs Minuten, nicht eine. Stellen Sie es bewusst enger:

```csharp
// .NET 11, C# 14
// Strict expiry. Only safe if your servers run NTP-synced clocks.
options.TokenValidationParameters.ClockSkew = TimeSpan.Zero;
```

Setzen Sie `ClockSkew = TimeSpan.Zero` nur, wenn Ihr Aussteller und Ihre API synchronisierte Uhren haben (NTP auf beiden, was in jeder Cloud-Umgebung normal ist). Können sie abdriften, ist ein kleiner Wert ungleich null wie 30 Sekunden der sinnvolle Mittelweg. "Reparieren" Sie eine unerwartete Token-Ablehnung nicht durch *Erhöhen* des Skews. Ein Token, das wirklich abgelaufen ist, sollte abgelehnt werden; den Skew zu erhöhen, um ein Uhrproblem zu verbergen, vergrößert nur Ihr Replay-Fenster.

## Warum ValidateAudience = true ohne Zielgruppe eine Mine beim Start ist

Ein häufiger Fehler ist, `ValidateAudience = true` (den Standard) zu belassen, während `Audience` / `ValidAudience` nie gesetzt wird. Der Handler hat nichts, womit er `aud` vergleichen kann, also wirft er bei der ersten Anfrage:

```text
IDX10208: Unable to validate audience. The 'audience' is null or whitespace
and validationParameters.ValidAudiences is also null or empty.
```

Sie haben zwei richtige Antworten und genau eine falsche:

- **Richtig und bevorzugt**: Setzen Sie `Audience` (oder `ValidAudiences` für mehrere). Die Zielgruppenvalidierung ist eine echte Sicherheitskontrolle. Sie verhindert, dass ein für `api://billing` in Ihrem geteilten Entra-Tenant ausgestelltes Token gegen `api://reporting` erneut gesendet wird.
- **Richtig, nur wenn Sie wirklich keinen Audience-Claim haben**: Setzen Sie `ValidateAudience = false` *explizit*, und schreiben Sie einen Kommentar, der erklärt, warum. Manche Alt-Aussteller prägen kein `aud`.
- **Falsch**: die Exception durch Abfangen zum Schweigen bringen oder `ValidAudience` auf einen Wert zeigen lassen, den Sie nicht kontrollieren.

Die gleiche Form gilt für `ValidateIssuer = true` ohne `ValidIssuer` und ohne `Authority`: Sie erhalten `IDX10204` ("Unable to validate issuer"). Das Setzen von `Authority` füllt `ValidIssuer` aus den Metadaten, weshalb der OIDC-Weg selten darauf stößt.

## Mehr als einen Aussteller oder eine Zielgruppe akzeptieren

Während einer Migration zwischen Identitätsanbietern, oder wenn eine API Clients bedient, die unter mehreren Zielgruppennamen geprägt wurden, verwenden Sie die Plural-Sammlungen. Sie sind additiv zu allem, was aus `Authority` entdeckt wurde.

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

Ein Token besteht, wenn sein `iss` mit *irgendeinem* Eintrag in `ValidIssuers` und sein `aud` mit *irgendeinem* Eintrag in `ValidAudiences` übereinstimmt. So können Sie beide Aussteller während eines Umstiegs parallel betreiben und den alten entfernen, sobald der Datenverkehr abgeflossen ist, ohne ein Zeitfenster, in dem Token abgelehnt werden.

## Den Fehler lesen: die IDX-Codes einschalten

Wenn ein scheinbar korrektes Token einen 401 erhält, ist der Antwortkörper leer und der `WWW-Authenticate`-Header knapp. Der wahre Grund liegt in der Exception, die der Handler verschluckt hat. Verdrahten Sie `OnAuthenticationFailed`, um sie beim Debuggen offenzulegen:

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

Die `IDX`-Codes von `Microsoft.IdentityModel` entsprechen direkt den vier Prüfungen, und sie zu kennen beendet die meisten Debugging-Sitzungen in Sekunden:

- `IDX10223`: Die Gültigkeitsvalidierung schlug fehl, das Token ist abgelaufen. Prüfen Sie `exp` und `ClockSkew`.
- `IDX10205` / `IDX10204`: Der Aussteller ist ungültig oder konnte nicht validiert werden. Der `iss`-Claim stimmt nicht mit `ValidIssuer`/`ValidIssuers` überein, oder es wurde keiner konfiguriert.
- `IDX10214` / `IDX10208`: Die Zielgruppe ist ungültig oder konnte nicht validiert werden. Der `aud`-Claim stimmt nicht überein, oder es wurde keine konfiguriert.
- `IDX10503` / `IDX10500`: Die Signaturvalidierung schlug fehl, oft ein Schlüssel, den die API nicht hat. Mit `Authority` bedeutet dies meist einen veralteten Metadaten-Cache oder einen Anbieter, der Schlüssel rotiert hat; die Aktualisierung des `ConfigurationManager` löst es.

Wenn das Token validiert, aber `User.Identity?.Name` null ist oder Ihre `[Authorize(Roles = ...)]`-Prüfungen fehlschlagen, liegt das Problem beim Claim-Mapping, nicht bei der Validierung. `JwtBearerOptions.MapInboundClaims` steht standardmäßig auf `true`, was kurze JWT-Claim-Namen wie `sub` und `role` in die langen WS-*-URIs umschreibt. Setzen Sie `options.MapInboundClaims = false`, um die ursprünglichen Kurznamen zu behalten, und setzen Sie dann `TokenValidationParameters.NameClaimType` und `RoleClaimType` auf das, was Ihre Token tatsächlich verwenden.

## Alles zusammengefügt, Schritt für Schritt

1. Wählen Sie Ihren Vertrauensanker. Bei einem OIDC-Anbieter setzen Sie `options.Authority`; Aussteller und Signaturschlüssel kommen aus den Metadaten. Bei selbst signierten Token setzen Sie `ValidIssuer` und `IssuerSigningKey` von Hand.
2. Setzen Sie die Zielgruppe. Weisen Sie `options.Audience` (oder `ValidAudiences`) zu, damit `ValidateAudience = true` etwas zu prüfen hat. Deaktivieren Sie die Zielgruppenvalidierung nicht, es sei denn, Ihre Token tragen wirklich kein `aud`.
3. Lassen Sie `ValidateIssuer`, `ValidateAudience`, `ValidateLifetime` und `ValidateIssuerSigningKey` auf ihrem Standard `true`. Sie konfigurieren Werte, keine Schalter.
4. Setzen Sie `ClockSkew` passend zur Gültigkeit Ihres Tokens. Behalten Sie den 5-Minuten-Standard für normale Access-Token; senken Sie auf `TimeSpan.Zero` oder 30 Sekunden für kurzlebige Token auf NTP-synchronisierten Uhren.
5. Für Multi-Anbieter- oder Multi-Zielgruppen-Szenarien verwenden Sie die Plural-Sammlungen `ValidIssuers` / `ValidAudiences` während des Umstiegs.
6. Fügen Sie außerhalb der Produktion Logging über `JwtBearerEvents.OnAuthenticationFailed` hinzu, damit der `IDX`-Code Ihnen sagt, welche der vier Prüfungen fehlschlug.
7. Platzieren Sie `app.UseAuthentication()` vor `app.UseAuthorization()`, und wenn eine Browser-SPA die API cross-origin aufruft, bringen Sie die Middleware-Reihenfolge gemäß [wie man CORS für eine JWT-geschützte API konfiguriert](/de/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/) in Ordnung.

## Wenn die Validierung besteht, die Anfrage aber dennoch fehlschlägt

Sobald die vier Prüfungen bestehen, ist jeder verbleibende Fehler kein Token-Validierungsproblem mehr. Ein 403 (kein 401) bedeutet, dass das Token gültig war, aber eine Autorisierungsrichtlinie oder eine Rollenanforderung nicht erfüllt wurde, was eine völlig andere Schicht ist. Eine Anfrage, die im Code funktioniert, aber aus einer Dokumentations-UI fehlschlägt, ist meist das Werkzeug, das den Header verwirft, behandelt in [warum Ihr Bearer-Token in Scalar ignoriert wird](/de/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/) und in [OpenAPI-Authentifizierungs-Flows zur Swagger UI hinzufügen](/de/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/). Und wenn Sie Authentifizierung an eine Minimal API anbinden, gruppieren Sie die geschützten Endpunkte, damit die Richtlinie an einer Stelle gilt, wie gezeigt in [Minimal-API-Endpunkte mit MapGroup organisieren](/de/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/).

Das mentale Modell, das dies einfach hält: `TokenValidationParameters` sind vier unabhängige Fragen, die der Handler jedem Token stellt. Wer hat es signiert? Wer hat es ausgestellt? Für wen ist es? Ist es noch gültig? Die Standardwerte machen alle vier verpflichtend, Ihre einzige Aufgabe ist also, jeder einen korrekten Wert zu geben und sich zu merken, dass "noch gültig" einen Puffer von fünf Minuten trägt, bis Sie etwas anderes festlegen.

Quellen: [TokenValidationParameters source - AzureAD/azure-activedirectory-identitymodel-extensions-for-dotnet](https://github.com/AzureAD/azure-activedirectory-identitymodel-extensions-for-dotnet/blob/dev/src/Microsoft.IdentityModel.Tokens/TokenValidationParameters.cs), [Configure JWT bearer authentication in ASP.NET Core - Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/configure-jwt-bearer-authentication), [JwtBearerOptions - Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.authentication.jwtbearer.jwtbeareroptions), [Microsoft.AspNetCore.Authentication.JwtBearer - NuGet](https://www.nuget.org/packages/Microsoft.AspNetCore.Authentication.JwtBearer).
