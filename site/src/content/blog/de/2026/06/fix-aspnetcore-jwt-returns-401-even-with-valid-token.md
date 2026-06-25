---
title: "Warum Ihr ASP.NET Core JWT trotz gültigem Token 401 zurückgibt"
description: "Ein gültiger Token, der dennoch 401 liefert, bedeutet fast immer, dass der Bearer-Handler nie lief oder unter dem falschen Schema lief. Prüfen Sie die Middleware-Reihenfolge, das Standardschema, den Schemanamen und ob der Header den Handler überhaupt erreicht hat."
pubDate: 2026-06-25
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "jwt"
  - "security"
lang: "de"
translationOf: "2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token"
translatedBy: "claude"
translationDate: 2026-06-25
---

Sie haben den Token auf [jwt.io](https://jwt.io/) dekodiert, die Signatur stimmt, das `exp` liegt Stunden in der Zukunft, das `iss` und das `aud` entsprechen genau Ihrer Konfiguration, und ASP.NET Core antwortet trotzdem mit `401 Unauthorized`. Wenn der Token selbst nachweislich korrekt ist, liegt der Fehler fast nie am Token. Es liegt daran, dass der JWT-Bearer-Handler für diese Anfrage entweder nie lief oder unter einem Schema lief, das Ihr `[Authorize]`-Attribut nicht anfordert. Die vier üblichen Verdächtigen, in der Reihenfolge, in der sie zuschlagen: `app.UseAuthentication()` fehlt oder steht nach `app.UseAuthorization()`; es ist kein Standard-Authentifizierungsschema registriert; der Schemaname bei `AddJwtBearer` stimmt nicht mit dem überein, was `[Authorize]` anfordert; oder der `Authorization`-Header hat den Handler überhaupt nie erreicht. Dieser Beitrag verwendet .NET 11 mit `Microsoft.AspNetCore.Authentication.JwtBearer` 11.0.0-preview und C# 14, doch die Diagnose ist bis zurück zu .NET 8 identisch.

Falls Sie vermuten, dass die Claims des Tokens tatsächlich falsch sind (ein fünfminütiges `ClockSkew`-Fenster, eine nicht passende Audience), dann ist das ein anderer Beitrag: [So validieren Sie Issuer, Audience und Lebensdauer eines JWT](/de/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/) geht ausführlich auf die Seite der `TokenValidationParameters` ein. Hier setzen wir voraus, dass Sie bereits nachgewiesen haben, dass der Token gültig ist, und der 401 trotzdem bestehen bleibt.

## Was der 401 Ihnen tatsächlich sagt

Die Antwort, die Sie sehen, ist absichtlich knapp:

```text
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer
```

Gemäß [RFC 9110](https://datatracker.ietf.org/doc/html/rfc9110#section-15.5.2) muss ein 401 einen `WWW-Authenticate`-Header tragen, der eine Challenge benennt, und ASP.NET Core sendet `Bearer`. Was standardmäßig nicht gesendet wird, ist eine Begründung. Wenn der Handler lief und den Token ablehnte, ist die eigentliche Ursache eine `Microsoft.IdentityModel`-Ausnahme, die der Handler verschluckt hat. Wenn der Handler nie lief, gibt es überhaupt keine Ausnahme, nur eine Autorisierungsrichtlinie, die keinen authentifizierten Benutzer fand und eine Challenge ausstellte. Diese beiden Fälle auseinanderzuhalten ist das ganze Spiel, und der schnellste Weg dorthin ist, den Handler zum Reden zu bringen (gegen Ende behandelt).

Eines lässt sich sofort ausschließen: Ein 401 bedeutet "wir wissen nicht, wer Sie sind." Ein 403 bedeutet "wir wissen, wer Sie sind, Sie dürfen nur nicht." Wenn Sie einen 403 erhalten, wurde der Token einwandfrei validiert, und Ihr Problem ist eine Richtlinien- oder Rollenprüfung, nicht die Authentifizierung. Verbringen Sie keinen Nachmittag damit, die Token-Validierung für einen 403 zu debuggen.

## Ursache 1: UseAuthentication fehlt oder steht nach UseAuthorization

Dies ist die mit Abstand häufigste Ursache und am leichtesten zu übersehen, weil beide Zeilen vorhanden sind, nur in der falschen Reihenfolge. Die Authentifizierungs-Middleware liest den `Authorization`-Header, führt den Bearer-Handler aus und setzt `HttpContext.User`. Die Autorisierungs-Middleware erzwingt `[Authorize]`. Wenn die Autorisierung zuerst läuft, ist `HttpContext.User` noch der anonyme Standard, sodass jeder geschützte Endpunkt mit einem 401 antwortet, egal wie gut der Token ist.

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

Die Regel ist mechanisch: `UseAuthentication` vor `UseAuthorization`, und beide nach `UseRouting` (im modernen minimalen Hosting-Modell wird `UseRouting` für Sie hinzugefügt, sodass Sie meist nur die beiden Auth-Aufrufe in der richtigen relativen Reihenfolge brauchen). Wenn Sie `UseAuthentication` ganz entfernt haben, etwa beim Refactoring, ist das Symptom identisch: ein universeller 401 bei allem mit `[Authorize]`. Fügen Sie es zuerst wieder hinzu, bevor Sie irgendetwas anderes anfassen.

## Ursache 2: es ist kein Standard-Authentifizierungsschema registriert

Ein `[Authorize]`-Attribut ohne benanntes Schema verwendet das *Standard-Authenticate-Schema*. Wenn Sie `AddAuthentication` nie mitgeteilt haben, was dieser Standard ist, gibt es kein Schema zum Ausführen, der Benutzer bleibt anonym, und Sie erhalten einen 401. Das bringt Leute aus dem Konzept, weil die Registrierung *vollständig aussieht*:

```csharp
// .NET 11, C# 14 -- WRONG: no default scheme, [Authorize] has nothing to run
builder.Services.AddAuthentication()
    .AddJwtBearer(options =>
    {
        options.Authority = "https://login.example.com";
        options.Audience = "api://my-api";
    });
```

`AddAuthentication()` ohne Argument registriert die Dienste, setzt aber kein Standardschema. Die Lösung besteht darin, den Schemanamen als Standard zu übergeben, was genau dem entspricht, unter dem `AddJwtBearer` registriert, wenn Sie es nicht benennen:

```csharp
// .NET 11, C# 14 -- correct: "Bearer" becomes the default scheme
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.Authority = "https://login.example.com";
        options.Audience = "api://my-api";
    });
```

`JwtBearerDefaults.AuthenticationScheme` ist die Zeichenfolge `"Bearer"`. Die Übergabe an `AddAuthentication` setzt `DefaultAuthenticateScheme` und `DefaultChallengeScheme` in einem Schritt auf `"Bearer"`, sodass ein nacktes `[Authorize]` nun weiß, dass es den Bearer-Handler ausführen soll. Wenn Sie es lieber explizit halten, setzen Sie die Eigenschaften direkt:

```csharp
// .NET 11, C# 14 -- the explicit form, equivalent to the above
builder.Services.AddAuthentication(options =>
{
    options.DefaultAuthenticateScheme = JwtBearerDefaults.AuthenticationScheme;
    options.DefaultChallengeScheme = JwtBearerDefaults.AuthenticationScheme;
})
.AddJwtBearer(options => { /* ... */ });
```

## Ursache 3: der Schemaname stimmt nicht überein

In dem Moment, in dem Sie `AddJwtBearer` einen benutzerdefinierten Schemanamen geben, haben Sie den Standard abgewählt und müssen dieses Schema nun überall namentlich anfordern. Dies ist die zweithäufigste "gültiger Token, trotzdem 401"-Falle, und sie ist heimtückisch, weil die Konfiguration ansonsten perfekt ist.

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

Sie haben zwei Auswege. Entweder machen Sie `"MyApi"` zum Standard, sodass ein nacktes `[Authorize]` es findet, oder Sie benennen das Schema bei jedem Attribut, das es verwenden soll:

```csharp
// .NET 11, C# 14 -- option A: make the named scheme the default
builder.Services.AddAuthentication("MyApi")
    .AddJwtBearer("MyApi", options => { /* ... */ });

// .NET 11, C# 14 -- option B: ask for the scheme by name
[Authorize(AuthenticationSchemes = "MyApi")]
public class OrdersController : ControllerBase { /* ... */ }
```

Das ist am wichtigsten, wenn Sie tatsächlich mehr als ein Schema betreiben, etwa ein Bearer-Schema für Ihre API plus Cookies für einen serverseitig gerenderten Admin-Bereich. Bei mehreren Schemata gibt es keinen sinnvollen einzelnen Standard, sodass die Bearer-Endpunkte `[Authorize(AuthenticationSchemes = JwtBearerDefaults.AuthenticationScheme)]` ausschreiben müssen. Lassen Sie das weg, und die Anfrage wird gegen das zufällig als Standard geltende Schema validiert, das nicht Ihres ist, und der Token wird ignoriert.

## Ursache 4: der Header erreichte den Handler nie

Wenn der Handler lief und keinen `Authorization`-Header (oder einen fehlerhaften) fand, kann er niemanden authentifizieren, und Sie erhalten einen 401, der nichts mit dem Inhalt des Tokens zu tun hat. Der Token in Ihrem Postman-Tab ist gültig; er kommt nur nicht so an, wie Sie denken.

Das Format ist strikt. Der Header-Wert muss das wörtliche Wort `Bearer` sein, ein Leerzeichen, dann der rohe Token, ohne Anführungszeichen und ohne `Basic`/`Bearer`-Verwechslung:

```text
Authorization: Bearer eyJhbGciOiJSUzI1NiIs...
```

Häufige Wege, auf denen das in der Praxis schiefgeht:

- **Der Client hängt ihn nie an.** Ein typisierter `HttpClient`, dessen `DefaultRequestHeaders.Authorization` an einer *anderen* Client-Instanz gesetzt wurde, oder ein fetch-Aufruf, der den Header bei Wiederholungen vergessen hat. Protokollieren Sie die eingehenden Header auf dem Server, um zu sehen, was tatsächlich ankam.
- **Ein CORS-Preflight wird abgelehnt, nicht Ihre eigentliche Anfrage.** Ein Browser sendet vor dem eigentlichen Aufruf einen `OPTIONS`-Preflight ohne `Authorization`-Header. Wenn CORS falsch konfiguriert ist, blockiert der Browser die eigentliche Anfrage, und Ihr Netzwerk-Tab zeigt etwas, das wie ein Authentifizierungsfehler aussieht. Die Lösung liegt auf der CORS-Seite, nicht auf der Token-Seite: siehe [So konfigurieren Sie CORS für eine JWT-geschützte API](/de/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/) für die korrekte Middleware-Reihenfolge und Richtlinie.
- **Ein Reverse-Proxy oder Load Balancer entfernt ihn.** Manche Proxys verwerfen `Authorization` beim Weiterleiten, sofern sie nicht ausdrücklich angewiesen werden, ihn zu erhalten. Wenn es lokal funktioniert und nur hinter nginx, IIS oder einem Ingress-Controller 401 liefert, verdächtigen Sie zuerst dies.
- **Ein API-Explorer lässt ihn fallen.** Swagger UI und Scalar senden Anfragen stillschweigend ohne den Token, wenn ihre Auth-Integration nicht eingerichtet ist. Wenn Ihr `curl` funktioniert, die Docs-UI aber nicht, ist das der Hinweis, behandelt in [Warum Ihr Bearer-Token in Scalar ignoriert wird](/de/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/).

## Bringen Sie den Handler dazu, Ihnen den Grund zu nennen

Hören Sie auf zu raten. Verdrahten Sie `JwtBearerEvents`, damit der Handler das tatsächliche Ergebnis protokolliert, dann wissen Sie innerhalb einer Anfrage, ob er überhaupt lief und, falls ja, welche Prüfung fehlschlug.

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

Der Entscheidungsbaum, den Ihnen das gibt, ist präzise. Wenn `OnAuthenticationFailed` ausgelöst wird, lief der Handler und lehnte einen echten Token ab; lesen Sie `ctx.Exception` für den `IDX`-Code und springen Sie zum [Leitfaden zur Token-Validierung](/de/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/). Wenn nur `OnChallenge` ohne vorausgehenden Fehlschlag ausgelöst wird, hatte der Handler nie einen Token zum Validieren, sodass Sie es mit den Ursachen 1 bis 4 oben zu tun haben, nicht mit dem Token. Wenn `OnTokenValidated` ausgelöst wird und Sie *trotzdem* einen Nicht-200 erhalten, haben Sie ein 403-förmiges Autorisierungsproblem im 401-Kostüm, und kein noch so großes Herumdrehen am Token wird helfen.

Dasselbe Signal erhalten Sie ohne Code, indem Sie die Log-Kategorie in `appsettings.Development.json` hochdrehen:

```json
{
  "Logging": {
    "LogLevel": {
      "Microsoft.AspNetCore.Authentication": "Debug"
    }
  }
}
```

Das bringt Zeilen wie "Bearer was not authenticated. Failure message: ..." direkt in der Konsole zum Vorschein, was die meisten dieser Fälle allein in unter einer Minute auflöst.

## Ein verlässlicher, garantiert gültiger Token zum Testen

Die Hälfte der für diesen Fehler aufgewendeten Zeit besteht aus Zweifeln daran, ob der Token wirklich gültig ist. Beseitigen Sie den Zweifel mit dem Tool `dotnet user-jwts`, das einen Token erzeugt, der mit einem Schlüssel signiert ist, den es auch in Ihre Entwicklungskonfiguration einbindet, sodass die Validierung nicht an einer Schlüssel-Diskrepanz scheitern kann:

```bash
# .NET 11 SDK -- creates a local-dev JWT and configures the app to accept it
dotnet user-jwts create
```

Wenn ein `user-jwts`-Token authentifiziert wird, der Token Ihres echten Anbieters aber nicht, dann sind die Claims oder der Signaturschlüssel des Tokens der Unterschied, und Sie sind zurück bei den Validierungsparametern. Wenn sogar der `user-jwts`-Token 401 liefert, war der Token nie das Problem, sondern eine der vier Verdrahtungsursachen oben. Dieses eine Experiment teilt den Suchraum sauber in zwei Hälften.

## Diagnostizieren Sie es der Reihe nach

Wenn ein gültiger Token 401 liefert, arbeiten Sie diese Checkliste von oben nach unten ab. Die frühen Schritte fangen die überwältigende Mehrheit ab, überspringen Sie also nichts.

1. **Bestätigen Sie, dass es ein 401 ist, kein 403.** Ein 403 bedeutet, dass die Authentifizierung bereits erfolgreich war; halten Sie hier inne und sehen Sie sich stattdessen Ihre Autorisierungsrichtlinien an.
2. **Prüfen Sie die Middleware-Reihenfolge.** `app.UseAuthentication()` muss vorhanden sein und vor `app.UseAuthorization()` kommen. Dies allein behebt die meisten Fälle.
3. **Prüfen Sie das Standardschema.** Übergeben Sie entweder `JwtBearerDefaults.AuthenticationScheme` an `AddAuthentication`, oder setzen Sie `DefaultAuthenticateScheme` explizit. Ein nacktes `AddAuthentication()` mit einem nackten `[Authorize]` kann nicht funktionieren.
4. **Prüfen Sie den Schemanamen.** Wenn Sie das Schema bei `AddJwtBearer("X")` benannt haben, machen Sie entweder `"X"` zum Standard oder verwenden Sie überall `[Authorize(AuthenticationSchemes = "X")]`.
5. **Bestätigen Sie, dass der Header ankommt.** Protokollieren Sie die eingehenden Anfrage-Header auf dem Server. Überprüfen Sie die exakte `Authorization: Bearer <token>`-Form und schließen Sie einen Proxy oder CORS-Preflight aus, der ihn frisst.
6. **Erzeugen Sie einen `dotnet user-jwts`-Token und versuchen Sie es erneut.** Wenn der authentifiziert wird, sind die Claims oder der Schlüssel Ihres echten Tokens das Problem; wechseln Sie zum [Leitfaden zu den Validierungsparametern](/de/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/). Wenn auch er 401 liefert, ist die Verdrahtung weiterhin falsch; prüfen Sie die Schritte 2 bis 4 erneut.
7. **Schalten Sie das `Microsoft.AspNetCore.Authentication`-Debug-Logging ein** oder verdrahten Sie `JwtBearerEvents` und lesen Sie, welches Ereignis ausgelöst wird. Das sagt Ihnen definitiv, ob der Handler lief.

## Die eine Unterscheidung, die die Suche beendet

Jedes "gültiger Token, aber 401" reduziert sich auf eine einzige Frage: Lief der Bearer-Handler und lehnte den Token ab, oder bekam er nie eine Chance zu laufen? Validierungsparameter, `ClockSkew`, Issuer- und Audience-Diskrepanzen leben alle auf dem ersten Zweig, und sie sind nur dann von Bedeutung, wenn `OnAuthenticationFailed` ausgelöst wird. Middleware-Reihenfolge, das Standardschema, der Schemaname und ein fehlender Header leben alle auf dem zweiten Zweig, wo es keinen Validierungsfehler zu finden gibt, weil es nichts zu validieren gab. Bringen Sie den Handler dazu, eine einzige Log-Zeile auszugeben, und Sie haben die Frage beantwortet; von dort an ist die Lösung mechanisch. Wenn Sie die Endpunkte absichern, hält das Gruppieren der geschützten Routen mit [MapGroup](/de/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) die Schema-Anforderung an einer Stelle, statt sie über jedes `[Authorize]` zu verstreuen, was genau der Weg ist, auf dem sich die Schemanamen-Diskrepanz überhaupt erst einschleicht.

## Quellen

- [Configure JWT bearer authentication in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/configure-jwt-bearer-authentication), Microsoft Learn, einschließlich der Aufschlüsselung von 401 vs. 403 und der Anleitung zum Standardschema.
- [Authorize with a specific scheme in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/security/authorization/limitingidentitybyscheme), Microsoft Learn, zu `[Authorize(AuthenticationSchemes = ...)]`.
- [RFC 9110, section 15.5.2](https://datatracker.ietf.org/doc/html/rfc9110#section-15.5.2), das den `WWW-Authenticate`-Header bei einem 401 vorschreibt.
- [Generate tokens with dotnet user-jwts](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/jwt-authn), Microsoft Learn.
