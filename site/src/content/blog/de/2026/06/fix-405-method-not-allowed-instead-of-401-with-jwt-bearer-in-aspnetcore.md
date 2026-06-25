---
title: "Fix: 405 Method Not Allowed statt 401 mit JWT Bearer in ASP.NET Core"
description: "Ein geschützter Endpunkt, der 405 statt 401 zurückgibt, bedeutet fast immer, dass das Routing das HTTP-Verb verworfen hat, bevor die Authentifizierung lief, oder dass ein Cookie-Schema die Challenge abgefangen hat. So erkennen Sie, welcher Fall vorliegt."
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
lang: "de"
translationOf: "2026/06/fix-405-method-not-allowed-instead-of-401-with-jwt-bearer-in-aspnetcore"
translatedBy: "claude"
translationDate: 2026-06-25
---

Sie haben einem Endpunkt `[Authorize]` (oder `RequireAuthorization()`) hinzugefügt, eine Anfrage ohne Token gesendet und ein sauberes `401 Unauthorized` erwartet, aber stattdessen `405 Method Not Allowed` erhalten. Die 405 ist irreführend: Sie bedeutet fast nie, dass Ihre Authentifizierung kaputt ist. Sie bedeutet, dass die Anfrage die Autorisierungsstufe gar nicht erreicht hat, weil das Endpunkt-Routing zuerst das HTTP-Verb verworfen und mit einer 405 kurzgeschlossen hat, oder, seltener, weil ein Cookie-Authentifizierungsschema die Standard-Challenge ist und anstelle des JWT-Bearer-Handlers geantwortet hat. Der Fix für den häufigen Fall besteht darin, das Verb zu senden, das der Endpunkt tatsächlich abbildet (`POST` an ein `MapPost`, nicht `GET`); der Fix für den Schema-Fall besteht darin, `DefaultChallengeScheme` auf das Bearer-Schema zu setzen. Dieser Beitrag verwendet .NET 11 mit `Microsoft.AspNetCore.Authentication.JwtBearer` 11.0.0 und C# 14, aber das Routing-Verhalten ist bis zurück zu .NET 6 identisch.

## Der Fehler im Kontext

```text
HTTP/1.1 405 Method Not Allowed
Allow: POST
Content-Length: 0
```

Dieser `Allow`-Header ist das verräterische Zeichen. Ein echter Authentifizierungsfehler liefert:

```text
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer
```

Wenn Sie `Allow` und kein `WWW-Authenticate` sehen, hat das Routing diese Antwort erzeugt, nicht der JWT-Bearer-Handler. Wenn Sie `WWW-Authenticate: Bearer` sehen, lief der Handler und Sie haben ein echtes Authentifizierungsproblem, was ein anderer Beitrag ist: [warum Ihr JWT auch mit einem gültigen Token 401 zurückgibt](/de/2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token/) behandelt diesen Weg.

## Warum das Routing gewinnt, bevor die Autorisierung läuft

Die Pipeline von ASP.NET Core ist geordnet. In einer standardmäßigen Minimal-API- oder Controller-Anwendung sieht sie so aus:

```csharp
// .NET 11, ASP.NET Core 11.0.0
var app = builder.Build();

app.UseRouting();        // 1. selects the endpoint (including method matching)
app.UseAuthentication(); // 2. reads the token, sets HttpContext.User
app.UseAuthorization();  // 3. enforces [Authorize] on the selected endpoint

app.MapControllers();
app.Run();
```

`UseRouting` läuft zuerst. Das Routing gleicht den Anfragepfad *und* die HTTP-Methode ab. Wenn ein Pfad mit einer registrierten Route übereinstimmt, die Methode aber nicht, fällt das Routing nicht auf "kein Endpunkt" zurück. Es wählt einen integrierten synthetischen Endpunkt, der von `HttpMethodMatcherPolicy` erzeugt wird und dessen einzige Aufgabe es ist, `405 Method Not Allowed` mit einem `Allow`-Header zurückzugeben, der die Verben auflistet, die für diesen Pfad *tatsächlich* abgebildet sind. Wie die Matcher-Policies die Endpunktauswahl speisen, finden Sie in der [Dokumentation zu den Routing-Grundlagen](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/routing).

Dieser synthetische 405-Endpunkt trägt keine Autorisierungsmetadaten. Wenn `UseAuthorization` also den ausgewählten Endpunkt betrachtet, findet es nichts durchzusetzen, lässt die Anfrage durch, und die 405 wird in die Antwort geschrieben. Ihre mit `[Authorize]` versehene Action war nie ein Kandidat, weil das Verb sie beim Abgleich ausgeschlossen hat. Die Autorisierung kann buchstäblich nicht auf einem Endpunkt laufen, den das Routing nicht ausgewählt hat.

Deshalb scheint das Hinzufügen von `[Authorize]` die 405 zu "verursachen": Das tut es nicht. Die 405 war auch schon da, bevor Sie die Authentifizierung hinzugefügt haben, Sie haben nur nicht hingeschaut, denn ohne `[Authorize]` gibt ein `GET` an einen nur `POST`-Endpunkt ebenfalls 405 zurück. Das Hinzufügen von `[Authorize]` ändert Ihre *Erwartung* auf 401, was den Verb-Konflikt offenlegt, den Sie bereits hatten.

## Minimale Reproduktion

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

Rufen Sie ihn nun mit dem falschen Verb und ohne Token auf:

```bash
curl -i http://localhost:5000/orders        # implicit GET
# HTTP/1.1 405 Method Not Allowed
# Allow: POST
```

Es gibt einen `POST /orders`-Endpunkt, also stimmt der Pfad überein, aber `GET` ist nicht erlaubt, also gibt das Routing 405 zurück. Sie haben 401 erwartet, weil Sie vergessen haben, dass der Endpunkt nur `POST` annimmt. Senden Sie das richtige Verb, und die 401, die Sie wollten, erscheint:

```bash
curl -i -X POST http://localhost:5000/orders
# HTTP/1.1 401 Unauthorized
# WWW-Authenticate: Bearer
```

## Fix 1: Senden Sie das Verb, das der Endpunkt abbildet (die übliche Ursache)

In neun von zehn Fällen liegt der Fehler beim Aufrufer. Das Frontend, die Postman-Sammlung oder der Integrationstest verwendet ein Verb, das die Route nicht abbildet. Prüfen Sie, in dieser Reihenfolge:

1. **Die HTTP-Methode in der Anfrage.** Ein `fetch`, das standardmäßig `GET` gegen ein `MapPost` verwendet, ein Formular-Post, bei dem die API `PUT` erwartet, oder ein Client, der `/api/orders` mit `GET` ansteuert, obwohl der Lese-Endpunkt eigentlich `/api/orders/{id}` ist. Der `Allow`-Header sagt Ihnen genau, welche Verben der Pfad unterstützt, also lesen Sie ihn.
2. **Das Verb-Attribut an der Action.** In Controllern reagiert eine Action mit `[Route("orders")]` aber ohne `[HttpPost]` nicht auf jedes Verb so, wie Sie es unter Attribut-Routing vielleicht annehmen. Legen Sie das Verb explizit mit `[HttpPost("orders")]` fest, damit ein `GET` auf denselben Pfad eine gewollte 405 erzeugt, keine Überraschung.
3. **Route-Templates, die kollidieren.** Zwei Endpunkte auf demselben Pfad mit unterschiedlichen Verben sind in Ordnung. Aber ein `MapGet("/orders/{id}")` und ein `MapPost("/orders")` sind unterschiedliche Pfade; ein `POST /orders/5` passt zu keinem sauber, und Sie können je nach Template eine 405 oder 404 erhalten. Verwenden Sie `MapGroup`, um die Verben eines Präfixes an einer Stelle sichtbar zu halten: [Minimal-API-Endpunkte mit MapGroup organisieren](/de/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) zeigt das Muster.

Wenn Sie wollen, dass eine geschützte Ressource für *jedes* Verb mit 401 antwortet, das ein Client versuchen könnte, einschließlich nicht abgebildeter, müssen Sie einen Catch-all abbilden. Das ist selten das, was Sie wollen, aber es ist möglich mit `MapMethods`, das die Verben abdeckt, die Sie interessieren, plus einem Fallback.

## Fix 2: Verhindern Sie, dass ein Cookie-Schema die Challenge beantwortet

Die zweite Ursache zeigt sich, wenn Sie ASP.NET Core Identity (das Cookie-Authentifizierung registriert) mit JWT Bearer kombinieren und nie einen expliziten Standard setzen. Wie in diesem [Microsoft-Q&A-Thread](https://learn.microsoft.com/en-us/answers/questions/2136683/issue-with-405-method-not-allowed-instead-of-401-u) dokumentiert, läuft die Challenge dann über den Identity-Cookie-Handler statt über den Bearer-Handler. Die Challenge des Cookie-Handlers ist eine Weiterleitung zu einer Login-Seite, und wenn diese Login-Route das Verb der ursprünglichen Anfrage nicht akzeptiert, landen Sie auf einer 405 statt auf der 401 des Bearers.

Der Fix besteht darin, explizit anzugeben, welches Schema authentifiziert und welches Schema die Challenge auslöst:

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

Wenn `DefaultChallengeScheme` auf das Bearer-Schema gesetzt ist, erhält eine nicht authentifizierte Anfrage `401 Unauthorized` mit `WWW-Authenticate: Bearer`, keine Cookie-Weiterleitung, die zu einer 405 degeneriert. Wenn Sie tatsächlich beide Schemata haben und einige Endpunkte gezielt Bearer verwenden sollen, benennen Sie das Schema am Attribut, anstatt sich auf den Standard zu verlassen: `[Authorize(AuthenticationSchemes = JwtBearerDefaults.AuthenticationScheme)]`. Dieselbe Schema-Konflikt-Falle ist die Grundursache hinter vielen [gültigen Tokens, die trotzdem 401 liefern](/de/2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token/), daher lohnt es sich, die Standards einmal richtig zu setzen.

## Mit Logs bestätigen, welche Ursache vorliegt

Sie müssen nicht raten. Erhöhen Sie die Protokollierung für Routing und Autorisierung, und die Quelle der Antwort wird offensichtlich:

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

Wenn das Verb falsch ist, sehen Sie, wie das Routing den Method-Not-Allowed-Endpunkt auswählt und *keine* Authentifizierungs-Logzeilen, weil der Handler nie lief:

```text
dbug: Microsoft.AspNetCore.Routing.Matching.DfaMatcher
      Endpoint selection: 405 HTTP Method Not Supported
```

Wenn ein Cookie-Schema die Challenge auslöst, sehen Sie den Cookie-Handler explizit benannt:

```text
dbug: Microsoft.AspNetCore.Authentication.Cookies.CookieAuthenticationHandler
      AuthenticationScheme: Identity.Application was challenged.
```

Diese eine Zeile sagt Ihnen, dass der Bearer-Handler nicht Ihr Standard-Challenge-Schema ist, was direkt auf Fix 2 verweist.

## Fallstricke und Doppelgänger

**CORS-Preflight gibt 405 zurück.** Ein Browser sendet einen `OPTIONS`-Preflight vor einem Cross-Origin-`POST` oder -`PUT`. Wenn Sie `app.UseCors(...)` nie mit einer Policy aufgerufen haben, die die Methode erlaubt, hat das Routing keinen `OPTIONS`-Endpunkt für den Pfad und antwortet mit 405, was der Browser als CORS-Fehler darstellt. Der Fix ist die Konfiguration von CORS, nicht der Authentifizierung: [CORS für eine JWT-geschützte API konfigurieren](/de/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/) führt durch die Policy und die Middleware-Reihenfolge. Beachten Sie, dass der Preflight-`OPTIONS` absichtlich nicht authentifiziert ist; stellen Sie kein `[Authorize]` davor.

**HEAD-Anfragen an einen nur GET-Endpunkt.** `MapGet` beantwortet `HEAD` nicht automatisch. Ein Health-Check oder ein CDN, das mit `HEAD` gegen eine `MapGet`-Route prüft, erhält 405. Bilden Sie beide Verben mit `app.MapMethods("/health", new[] { "GET", "HEAD" }, handler)` ab, gemäß der [Dokumentation zu Route-Handlern](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/route-handlers). Das ist ein Verb-Konflikt, kein Authentifizierungsproblem.

**403 ist nicht 405.** Wenn Sie sich erfolgreich authentifiziert haben, aber eine erforderliche Rolle oder einen Policy-Claim nicht besitzen, erhalten Sie `403 Forbidden`, nicht 405 und nicht 401. Eine 403 bedeutet, dass das Token validiert wurde und der Handler lief; Ihr Problem ist eine Policy- oder Rollenprüfung, behandelt, wenn Sie [Issuer, Audience und Lebensdauer eines JWT validieren](/de/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/) und die Claims, die es trägt.

**Eine benutzerdefinierte Middleware, die vor dem Routing kurzschließt.** Wenn Sie Middleware geschrieben haben, die vor `UseRouting` läuft und eine 405 schreibt (zum Beispiel eine selbstgebaute Methoden-Allowlist), maskiert sie alles weiter unten. Alles, was `context.Response.StatusCode = 405` vor dem Routing aufruft, erzeugt dieses Symptom ohne `Allow`-Header vom Matcher.

Der rote Faden: 405 ist in ASP.NET Core ein *Routing*-Status, der entschieden wird, bevor Authentifizierung und Autorisierung die Anfrage überhaupt betrachten. Wenn Sie 401 erwartet und 405 erhalten haben, beginnen Sie beim Verb und beim `Allow`-Header, nicht bei Ihrem Token. Heben Sie das Authentifizierungs-Debugging für den Fall auf, in dem Sie tatsächlich `WWW-Authenticate: Bearer` sehen.

## Verwandt

- [Warum Ihr ASP.NET Core JWT auch mit einem gültigen Token 401 zurückgibt](/de/2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token/)
- [Issuer, Audience und Lebensdauer eines JWT in ASP.NET Core 11 validieren](/de/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/)
- [CORS für eine JWT-geschützte API in ASP.NET Core 11 konfigurieren](/de/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/)
- [Minimal-API-Endpunkte mit MapGroup in ASP.NET Core 11 organisieren](/de/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [Anfrage-Bodies in Minimal APIs ohne Controller in ASP.NET Core 11 validieren](/de/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/)

## Quellen

- [ASP.NET Core routing fundamentals](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/routing) - Endpunktabgleich und Method-Matcher-Policies
- [Route handlers in minimal API apps](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/route-handlers) - `MapMethods`, HEAD und OPTIONS
- [Microsoft Q&A: 405 Method Not Allowed instead of 401 with JWT](https://learn.microsoft.com/en-us/answers/questions/2136683/issue-with-405-method-not-allowed-instead-of-401-u) - die Ursache und der Fix mit dem Cookie-Standardschema
- [RFC 9110, Abschnitt 15.5.6 (405 Method Not Allowed)](https://datatracker.ietf.org/doc/html/rfc9110#section-15.5.6) und [15.5.2 (401 Unauthorized)](https://datatracker.ietf.org/doc/html/rfc9110#section-15.5.2)
