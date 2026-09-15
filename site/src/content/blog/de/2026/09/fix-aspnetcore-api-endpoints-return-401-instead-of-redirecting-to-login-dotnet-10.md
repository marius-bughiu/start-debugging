---
title: "Lösung: ASP.NET Core API-Endpunkte liefern nach dem Upgrade auf .NET 10 einen 401 statt einer Weiterleitung zur Anmeldeseite"
description: "In .NET 10 beantwortet die Cookie-Authentifizierung API-artige Endpunkte mit 401/403 statt einer Login-Weiterleitung. So stellen Sie sie pro Endpunkt, global oder per AppContext-Switch wieder her."
pubDate: 2026-09-15
template: error-page
tags:
  - "errors"
  - "aspnetcore"
  - "dotnet-10"
  - "authentication"
  - "cookies"
  - "csharp"
lang: "de"
translationOf: "2026/09/fix-aspnetcore-api-endpoints-return-401-instead-of-redirecting-to-login-dotnet-10"
translatedBy: "claude"
translationDate: 2026-09-15
---

In ASP.NET Core 10 erhalten nicht authentifizierte Anfragen an "API-artige" Endpunkte hinter Cookie-Authentifizierung einen `401` (und verbotene Anfragen einen `403`) statt eines `302` auf Ihren `LoginPath`. Das betrifft `[ApiController]`-Controller, Minimal APIs, die JSON lesen oder schreiben, Rückgaben über `TypedResults` sowie SignalR. Die Änderung ist beabsichtigt. Wenn ein Browser tatsächlich zu einem solchen Endpunkt navigiert, ergänzen Sie `.AllowCookieRedirect()` (oder `[AllowCookieRedirect]`) an diesem Endpunkt. Um das Verhalten von .NET 9 für die gesamte App zurückzuholen, überschreiben Sie `OnRedirectToLogin`/`OnRedirectToAccessDenied` oder setzen den AppContext-Switch `Microsoft.AspNetCore.Authentication.Cookies.IgnoreRedirectMetadata`. Alles Folgende wurde mit ASP.NET Core 10.0.10 (SDK 10.0.302) im Vergleich zu 9.0.20 gemessen.

## Der Fehler im Kontext

Nach dem Upgrade gibt es keine Exception und keinen Log-Eintrag. Die Anmeldeseite erscheint einfach nicht mehr. Eine Anfrage, die früher auf `/login` umgeleitet wurde, kommt jetzt so zurück:

```text
HTTP/1.1 401 Unauthorized
Content-Length: 0
Server: Kestrel
Location: http://localhost:5103/login?ReturnUrl=%2Fm%2Fdto
```

Beachten Sie, dass der `Location`-Header weiterhin vorhanden ist. Der Cookie-Handler berechnet die Login-URL genau wie zuvor und schreibt sie in die Antwort, setzt den Status aber auf `401` statt `302`, sodass Browser und `HttpClient` ihr nicht folgen. Ein angemeldeter Benutzer, der an einer Autorisierungsrichtlinie scheitert, wird genauso behandelt: `403 Forbidden` mit `Location: /denied?ReturnUrl=...` statt einer Weiterleitung auf `AccessDeniedPath`.

Typische Symptome:

- Eine Razor-Pages- oder MVC-App mit einigen Minimal-API-Endpunkten: Wird einer davon im Browser-Tab geöffnet, erscheint eine leere Seite (oder die eigene 401-Seite des Browsers) statt des Anmeldeformulars.
- Ein `fetch` im Frontend, das früher dem `302` folgte, auf dem Login-HTML landete und das über `res.redirected` erkannte, erhält jetzt einen `401` und wirft in einem anderen Codepfad.
- Integrationstests, die die Login-Weiterleitung prüften (einen `302` mit `AllowAutoRedirect = false` oder eine finale URL auf `/Account/Login` mit dem Standard-Client), schlagen jetzt genau für die oben genannten Endpunkte fehl, während die übrigen weiterhin bestehen.

## Warum .NET 10 für diese Endpunkte nicht mehr weiterleitet

Es handelt sich um den Breaking Change [Cookie login redirects are disabled for known API endpoints](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/10/cookie-authentication-api-endpoints), eingeführt in .NET 10 Preview 7 und allgemein verfügbar seit 10.0.0 (November 2025). Er erledigt eine Anfrage aus dem Jahr 2019 ([dotnet/aspnetcore#9039, "ApiController redirects to login page"](https://github.com/dotnet/aspnetcore/issues/9039)): Eine HTML-Anmeldeseite nützt einem JSON-Client nichts.

Der Mechanismus sind Endpunkt-Metadaten. Das Standard-Delegate `OnRedirectToLogin` in `CookieAuthenticationEvents` lautet jetzt:

```csharp
// ASP.NET Core 10.0.0, src/Security/Authentication/Cookies/src/CookieAuthenticationEvents.cs (abridged)
public Func<RedirectContext<CookieAuthenticationOptions>, Task> OnRedirectToLogin { get; set; } = context =>
{
    if (IsAjaxRequest(context.Request) || IsCookieRedirectDisabledByMetadata(context.HttpContext))
    {
        context.Response.Headers.Location = context.RedirectUri;
        context.Response.StatusCode = 401;
    }
    else
    {
        context.Response.Redirect(context.RedirectUri);
    }
    return Task.CompletedTask;
};

private static bool IsCookieRedirectDisabledByMetadata(HttpContext context)
{
    if (_ignoreCookieRedirectMetadata) // AppContext switch, read once
    {
        return false;
    }
    var endpoint = context.GetEndpoint();
    return endpoint?.Metadata.GetMetadata<IDisableCookieRedirectMetadata>() is not null &&
        endpoint?.Metadata.GetMetadata<IAllowCookieRedirectMetadata>() is null;
}
```

Der Zweig `IsAjaxRequest` (ein `X-Requested-With: XMLHttpRequest`-Header) existiert schon seit Jahren. Neu ist `IDisableCookieRedirectMetadata`, das das Framework an folgenden Stellen automatisch anhängt:

- `ApiControllerAttribute` implementiert jetzt `IDisableCookieRedirectMetadata`, daher trägt jede Action eines `[ApiController]`-Controllers diese Metadaten.
- `RequestDelegateFactory` (und der für Native AOT verwendete Request Delegate Generator) fügt sie hinzu, wenn ein Minimal-API-Handler einen JSON-Body-Parameter hat oder sein Rückgabetyp als JSON serialisiert wird.
- Die API-orientierten `TypedResults`-Typen (`Ok`, `Ok<T>`, `Created`, `Accepted`, `NotFound<T>`, `BadRequest`, `Conflict`, `ValidationProblem`, `ProblemHttpResult`, `JsonHttpResult<T>`, `ServerSentEventsResult<T>` und verwandte) fügen sie in ihrem `PopulateMetadata` hinzu.
- `MapHub` und `MapConnectionHandler` fügen sie für SignalR hinzu.

Ein Detail führt bei der Suche oft in die Irre: Die Seite auf Microsoft Learn nennt das Marker-Interface noch `IApiEndpointMetadata`. So hieß es in Preview 7. Das API-Review hat es vor dem GA-Release in [dotnet/aspnetcore#63283](https://github.com/dotnet/aspnetcore/pull/63283) umbenannt. Derselbe PR hat auch das Opt-out `IAllowCookieRedirectMetadata`, die Erweiterungsmethoden `AllowCookieRedirect`/`DisableCookieRedirect` und den AppContext-Switch hinzugefügt. In einer ausgelieferten .NET 10 App existiert `IApiEndpointMetadata` nicht. Die Typen heißen `IDisableCookieRedirectMetadata` und `IAllowCookieRedirectMetadata` in `Microsoft.AspNetCore.Http.Metadata`.

## Minimale Reproduktion

Eine dateibasierte App, einmal gegen die .NET 9.0.20 Laufzeit und einmal gegen 10.0.10 ausgeführt:

```csharp
// .NET 10, ASP.NET Core 10.0.10, run with: dotnet run probe.cs
#:sdk Microsoft.NET.Sdk.Web

using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(o => { o.LoginPath = "/login"; o.AccessDeniedPath = "/denied"; });
builder.Services.AddAuthorization();
builder.Services.AddControllers();

var app = builder.Build();
app.UseAuthentication();
app.UseAuthorization();

var m = app.MapGroup("/m").RequireAuthorization();
m.MapGet("/string", () => "plain text");                          // text/plain
m.MapGet("/dto", () => new Todo(1, "json"));                       // JSON response
m.MapGet("/typed", () => TypedResults.Ok(new Todo(1, "typed")));   // TypedResults
m.MapGet("/iresult", () => Results.Ok(new Todo(1, "iresult")));    // returns IResult
m.MapPost("/body", (Todo t) => "got body");                        // JSON request body
app.MapControllers();
app.Run();

public record Todo(int Id, string Title);

[ApiController, Route("c/api"), Authorize]
public class ApiCtl : ControllerBase { [HttpGet] public Todo Get() => new(1, "api"); }

[Route("c/mvc"), Authorize]
public class MvcCtl : Controller { [HttpGet] public Todo Get() => new(1, "mvc"); }
```

Dies sind die Ergebnisse von `curl -D -` ohne Cookie. Die ersten beiden Spalten stammen aus demselben Code; die dritte ist 10.0.10 mit `IgnoreRedirectMetadata` auf `true`:

| Endpunkt | 9.0.20 | 10.0.10 | 10.0.10 + Switch |
| --- | --- | --- | --- |
| `GET /m/string` (gibt `string` zurück) | 302 | 302 | 302 |
| `GET /m/dto` (gibt einen Record zurück) | 302 | **401** | 302 |
| `GET` asynchroner Handler, der `Task<Todo>` zurückgibt | 302 | **401** | 302 |
| `GET /m/typed` (`TypedResults.Ok`) | 302 | **401** | 302 |
| `Results<Ok<Todo>, NotFound>` | 302 | **401** | 302 |
| `TypedResults.Json(...)` | 302 | **401** | 302 |
| `GET /m/iresult` (`Results.Ok`, deklariert als `IResult`) | 302 | 302 | 302 |
| `TypedResults.Text`, `TypedResults.File`, `TypedResults.Redirect` | 302 | 302 | 302 |
| `POST /m/body` (JSON-Body) | 302 | **401** | 302 |
| `[ApiController]`-Action | 302 | **401** | 302 |
| Normale `Controller`-Action (ohne `[ApiController]`) | 302 | 302 | 302 |
| Beliebiger Endpunkt mit `X-Requested-With: XMLHttpRequest` | 401 | 401 | 401 |
| Angemeldet, scheitert an `RequireRole`, JSON-Endpunkt | 302 auf `/denied` | **403** | 302 auf `/denied` |
| Angemeldet, scheitert an `RequireRole`, `string`-Endpunkt | 302 auf `/denied` | 302 auf `/denied` | 302 auf `/denied` |

Die Faustregel lautet also nicht "APIs" im architektonischen Sinn. Entscheidend sind die Metadaten am Endpunkt. `Results.Ok(...)` leitet weiterhin weiter, `TypedResults.Ok(...)` nicht, weil `IResult` den konkreten Typ vor der Metadaten-Inferenz verbirgt. Den Unterschied zwischen den beiden Factories behandelt [Typed Results vs. IResult vs. IActionResult](/de/2026/07/typed-results-vs-iresult-vs-iactionresult-in-aspnetcore-11/).

## Die Lösung im Detail

Wählen Sie die erste Option, die dazu passt, was der Endpunkt tatsächlich ist.

### 1. Der Endpunkt wird aus Code aufgerufen: den 401 behalten und den Client korrigieren

Wenn der Aufrufer `fetch`, `HttpClient` oder eine mobile App ist, ist das neue Verhalten das richtige, und der alte `302` auf eine HTML-Seite war ein Fehler, den Sie umgangen hatten. Behandeln Sie den Statuscode, statt Weiterleitungen zu erschnüffeln:

```javascript
// Browser fetch against an ASP.NET Core 10 cookie-authenticated API
const res = await fetch("/api/todos", { credentials: "same-origin" });
if (res.status === 401) {
  // Cookie missing or expired: send the user to the login page ourselves
  location.href = "/login?ReturnUrl=" + encodeURIComponent(location.pathname);
} else if (res.status === 403) {
  location.href = "/denied";
} else {
  const todos = await res.json();
}
```

Entfernen Sie dabei gleich alle Prüfungen auf `res.redirected` oder `res.url.includes("/login")`: Unter .NET 10 sind sie für diese Endpunkte toter Code. Laufen SPA und API auf unterschiedlichen Origins, sind Credentials und CORS ein eigenes Thema, behandelt in [JWT vs. Cookie-Authentifizierung in ASP.NET Core](/de/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/).

### 2. Ein Browser navigiert zum Endpunkt: per `AllowCookieRedirect` wieder aktivieren

Für die wenigen Endpunkte, die ein Benutzer tatsächlich in einem Tab öffnet (ein Export-Link, der JSON zurückgibt, ein "Rohdaten anzeigen"-Link auf einer Admin-Seite, eine `[ApiController]`-Action, auf die alte MVC-Views direkt verlinken), stellen Sie die Weiterleitung pro Endpunkt wieder her:

```csharp
// .NET 10, ASP.NET Core 10.0.10
app.MapGet("/export/orders", (OrderService s) => s.GetAll())
   .RequireAuthorization()
   .AllowCookieRedirect();

[ApiController, Route("api/reports"), Authorize]
public class ReportsController : ControllerBase
{
    [HttpGet("download"), AllowCookieRedirect]
    public ReportDto Download() => new(/* ... */);
}
```

`IAllowCookieRedirectMetadata` gewinnt unabhängig von der Reihenfolge gegen `IDisableCookieRedirectMetadata`, daher funktioniert es auch an einer Gruppe (`app.MapGroup("/export").AllowCookieRedirect()`). Im Test ging `/m/dto` mit `.AllowCookieRedirect()` zurück auf `302`, ebenso eine `[ApiController]`-Action mit `[AllowCookieRedirect]`. Die Umkehrung gibt es auch. `.DisableCookieRedirect()` lässt einen Endpunkt, der `string` zurückgibt, mit `401` antworten. Das ist nützlich für Health- oder Diagnose-Endpunkte, die niemals eine Anmeldeseite anzeigen sollen.

### 3. Gemischte App: nur echte Browser-Navigationen weiterleiten

Wenn Sie viele Endpunkte beider Arten haben, ist es sauberer, pro Anfrage statt pro Endpunkt zu entscheiden. Alle aktuellen großen Browser (Chrome, Edge, Firefox, Safari 16.4+) senden [`Sec-Fetch-Mode: navigate`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Sec-Fetch-Mode) bei einer Top-Level-Navigation und `cors`/`same-origin` bei `fetch`:

```csharp
// .NET 10, ASP.NET Core 10.0.10
builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(options =>
    {
        options.LoginPath = "/login";
        options.AccessDeniedPath = "/denied";

        options.Events.OnRedirectToLogin = context =>
        {
            if (IsBrowserNavigation(context.Request))
                context.Response.Redirect(context.RedirectUri);
            else
                context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return Task.CompletedTask;
        };
        options.Events.OnRedirectToAccessDenied = context =>
        {
            if (IsBrowserNavigation(context.Request))
                context.Response.Redirect(context.RedirectUri);
            else
                context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return Task.CompletedTask;
        };
    });

// ... app.Run();

static bool IsBrowserNavigation(HttpRequest request)
{
    var mode = request.Headers["Sec-Fetch-Mode"].ToString();
    if (mode.Length > 0)
        return mode == "navigate";

    // Clients without Fetch Metadata headers: fall back to the Accept header
    return HttpMethods.IsGet(request.Method)
        && request.Headers.Accept.ToString().Contains("text/html");
}
```

Gemessen auf 10.0.10 an der `OnRedirectToLogin`-Hälfte: `/m/dto` mit `Sec-Fetch-Mode: navigate` erhielt `302`, `/m/string` mit `Sec-Fetch-Mode: cors` erhielt `401`, und ein nacktes `curl` (ohne Fetch Metadata, `Accept: */*`) erhielt `401` auf jedem Endpunkt, auch auf denen, die das Framework weitergeleitet hätte. Da dies das Standard-Delegate ersetzt, werden die Endpunkt-Metadaten gar nicht mehr ausgewertet: Die Anfrage entscheidet, nicht der Endpunkt.

### 4. Immer weiterleiten, genau wie vorher

Dies ist das Snippet von der Breaking-Change-Seite. Verwenden Sie es, wenn die App eine serverseitig gerenderte Website ist und keiner ihrer Endpunkte einen Aufrufer außerhalb des Browsers hat:

```csharp
// .NET 10, ASP.NET Core 10.0.10
builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(options =>
    {
        options.Events.OnRedirectToLogin = context =>
        {
            context.Response.Redirect(context.RedirectUri);
            return Task.CompletedTask;
        };
        options.Events.OnRedirectToAccessDenied = context =>
        {
            context.Response.Redirect(context.RedirectUri);
            return Task.CompletedTask;
        };
    });
```

Beachten Sie, dass dies auch XHRs weiterleitet, was .NET 9 nicht tat. Wenn Sie exakt die Semantik von .NET 9 wollen (`401` für `X-Requested-With: XMLHttpRequest`, Weiterleitung für alles andere), erledigt das der Switch aus Option 5 mit einer Zeile.

### 5. Der AppContext-Switch: .NET 9 Verhalten ohne eigene Events

Der Switch steht nicht auf der Seite bei Microsoft Learn, wurde aber in 10.0.0 ausgeliefert (aus PR #63283) und ist der am wenigsten invasive Weg zurück zur Semantik von .NET 9. Setzen Sie ihn in der Projektdatei:

```xml
<!-- .NET 10, in the web project's .csproj -->
<ItemGroup>
  <RuntimeHostConfigurationOption Include="Microsoft.AspNetCore.Authentication.Cookies.IgnoreRedirectMetadata"
                                  Value="true" />
</ItemGroup>
```

oder als erste Zeile von `Program.cs`:

```csharp
// .NET 10, must run before the cookie handler is first used
AppContext.SetSwitch("Microsoft.AspNetCore.Authentication.Cookies.IgnoreRedirectMetadata", true);
```

Das Element `RuntimeHostConfigurationOption` landet als `configProperties`-Eintrag in `bin/.../<app>.runtimeconfig.json`. Ich habe sowohl diesen Eintrag als auch den Aufruf von `SetSwitch` getestet, und beide ergaben die Spalte "10.0.10 + Switch" oben: Jeder Endpunkt leitet wieder weiter, und XHRs erhalten weiterhin `401`. Betrachten Sie ihn als Krücke für die Migration, nicht als Ziel. Er schaltet die Metadaten für die gesamte App ab, einschließlich des Markers an SignalR-Hubs. Eine nicht authentifizierte Negotiate-Anfrage fällt damit auf die Regel vor .NET 10 zurück: Nur ein `X-Requested-With: XMLHttpRequest`-Header verhindert, dass sie auf eine HTML-Seite weitergeleitet wird.

## Fallstricke und ähnliche Fehler

**Sie hatten bereits ein eigenes `OnRedirectToLogin`.** Dann hat sich für Sie nichts geändert, und Sie fragen sich vielleicht, warum sich die App eines Kollegen anders verhält. Die Metadatenprüfung steckt im *Standard*-Delegate. Jede App, die `OnRedirectToLogin` ersetzt oder von `CookieAuthenticationEvents` abgeleitet und `RedirectToLogin` überschrieben hat, umgeht sie vollständig. Das gilt auch umgekehrt: Wenn Sie das neue Verhalten *und* ein eigenes Event wollen (etwa um fehlgeschlagene Anmeldungen zu protokollieren), rufen Sie Ihre Logik auf und bilden die Prüfung auf `IDisableCookieRedirectMetadata` selbst nach.

**Der Switch wird einmal gelesen.** `_ignoreCookieRedirectMetadata` ist ein `static readonly`-Feld in `CookieAuthenticationEvents`. Den Switch nach der ersten Anfrage zu setzen oder ihn in einem Test umzuschalten, nachdem der Host gestartet ist, hat keine Wirkung.

**Nur der Cookie-Handler wertet diese Metadaten aus.** Im aspnetcore-Repository ist `CookieAuthenticationEvents` der einzige Konsument von `IDisableCookieRedirectMetadata`. Ist Ihr `DefaultChallengeScheme` OpenID Connect (Microsoft.Identity.Web, Entra ID, Auth0), stellt der OIDC-Handler die Challenge aus und leitet für jeden Endpunkt weiterhin zum Identity Provider weiter. Sehen Sie dort einen `401`, ist für diesen Endpunkt das Cookie-Schema das Challenge-Schema, meist wegen eines expliziten `[Authorize(AuthenticationSchemes = ...)]` oder einer Richtlinie.

**Integrationstests.** Clients von `WebApplicationFactory` folgen Weiterleitungen standardmäßig, daher sehen Tests, die "nicht authentifizierte Anfrage landet auf der Anmeldeseite" prüften, für API-Endpunkte jetzt einen `401`. Passen Sie die Assertion an, statt `AllowCookieRedirect` nur hinzuzufügen, damit die Tests grün bleiben; die Setup-Muster finden Sie in [Integrationstests mit WebApplicationFactory](/de/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/).

**Native AOT verhält sich genauso.** Der Request Delegate Generator erzeugt eine dateilokale Klasse `DisableCookieRedirectMetadata` und fügt sie unter denselben JSON-Bedingungen hinzu wie die reflexionsbasierte Factory, sodass AOT- und JIT-Builds übereinstimmen.

**.NET 11 behält es bei.** Dieselbe Prüfung `IsCookieRedirectDisabledByMetadata` ist auf `main`. Wenn Sie also direkt von .NET 8 oder 9 auf 11 wechseln, gehört dies auf Ihre Liste neben die anderen Authentifizierungsänderungen in [der Checkliste für die Migration von .NET 8 auf .NET 11](/de/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/).

**Nicht dieses Problem: 401 mit einem Bearer-Token oder 405.** Verwendet der Endpunkt JWT Bearer und erhalten Sie `401` mit einem `WWW-Authenticate: Bearer`-Header, wird das Token selbst abgelehnt; siehe [warum ein ASP.NET Core JWT selbst mit gültigem Token 401 zurückgibt](/de/2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token/). Erhalten Sie `405` mit einem `Allow`-Header, hat das Routing das Verb abgelehnt, bevor die Authentifizierung lief; siehe [405 Method Not Allowed statt 401 mit JWT Bearer](/de/2026/06/fix-405-method-not-allowed-instead-of-401-with-jwt-bearer-in-aspnetcore/). Die Cookie-Änderung in .NET 10 erzeugt immer `401`/`403` mit einem `Location`-Header und ohne `WWW-Authenticate`-Header.

## Verwandte Artikel

- [JWT vs. Cookie-Authentifizierung in ASP.NET Core](/de/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/)
- [Typed Results vs. IResult vs. IActionResult](/de/2026/07/typed-results-vs-iresult-vs-iactionresult-in-aspnetcore-11/)
- [Integrationstests mit WebApplicationFactory schreiben](/de/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/)
- [Lösung: 405 Method Not Allowed statt 401 mit JWT Bearer](/de/2026/06/fix-405-method-not-allowed-instead-of-401-with-jwt-bearer-in-aspnetcore/)
- [Migration von .NET 8 auf .NET 11: die vollständige Checkliste](/de/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/)

## Quellen

- [Breaking change: Cookie login redirects are disabled for known API endpoints](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/10/cookie-authentication-api-endpoints) (Microsoft Learn) und die Ankündigung [aspnet/Announcements#525](https://github.com/aspnet/Announcements/issues/525).
- [dotnet/aspnetcore#62816: Avoid cookie login redirects for known API endpoints](https://github.com/dotnet/aspnetcore/pull/62816), die ursprüngliche Änderung.
- [dotnet/aspnetcore#63283: Address API review feedback for what was IApiEndpointMetadata](https://github.com/dotnet/aspnetcore/pull/63283), die Umbenennung, `AllowCookieRedirect` und der Switch `IgnoreRedirectMetadata`.
- [`CookieAuthenticationEvents.cs` at v10.0.0](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Security/Authentication/Cookies/src/CookieAuthenticationEvents.cs) und [`RequestDelegateFactory.cs` at v10.0.12](https://github.com/dotnet/aspnetcore/blob/v10.0.12/src/Http/Http.Extensions/src/RequestDelegateFactory.cs).
- [dotnet/aspnetcore#9039: ApiController redirects to login page](https://github.com/dotnet/aspnetcore/issues/9039), die Anfrage von 2019, die hinter der Änderung steht.
