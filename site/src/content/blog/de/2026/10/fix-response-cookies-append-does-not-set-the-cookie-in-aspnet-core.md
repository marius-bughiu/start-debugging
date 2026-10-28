---
title: "Lösung: Response.Cookies.Append setzt das Cookie im Browser nicht in ASP.NET Core"
description: "Der Set-Cookie-Header wird gesendet, aber der Browser lehnt ihn ab oder speichert ihn nie. Beheben Sie SameSite=None ohne Secure, fehlendes credentials: 'include' samt AllowCredentials, die Consent-Policy und zu späte Append-Aufrufe."
pubDate: 2026-10-28
template: error-page
tags:
  - "errors"
  - "aspnetcore"
  - "dotnet"
  - "dotnet-10"
  - "cookies"
  - "cors"
lang: "de"
translationOf: "2026/10/fix-response-cookies-append-does-not-set-the-cookie-in-aspnet-core"
translatedBy: "claude"
translationDate: 2026-10-28
---

Die Lösung: `Response.Cookies.Append` schlägt auf dem Server fast nie fehl. Die Methode schreibt einen `Set-Cookie`-Header, und der Browser weigert sich anschließend stillschweigend, ihn zu speichern. Nach Wahrscheinlichkeit geordnet ist die Ursache: Die Anfrage war Cross-Origin und der Client hat kein `credentials: 'include'` gesendet (oder der Server hat `AllowCredentials()` nicht aufgerufen), das Cookie hat `SameSite=None` ohne `Secure`, eine Consent-Prüfung von `CookiePolicy` hat ein Cookie unterdrückt, das nicht als `IsEssential` markiert ist, oder `Append` lief, nachdem die Antwort bereits begonnen hatte. Öffnen Sie in den DevTools des Browsers den Network-Tab, wählen Sie die Antwort aus und sehen Sie sich den Unter-Tab Cookies an: Chromium nennt dort genau die Regel, die das Cookie blockiert hat.

Alles Folgende bezieht sich auf .NET 10 und ASP.NET Core 10 (das Verhalten ist in den .NET-11-Previews identisch und seit ASP.NET Core 3.1 stabil). Das Browserverhalten bezieht sich auf die aktuellen Releases von Chrome, Firefox und Safari mit Stand Oktober 2026.

```text
// Roughly what Chrome DevTools shows under Network > (response) > Cookies
Set-Cookie: session=abc123; path=/; samesite=none
  ⚠ This attempt to set a cookie via a Set-Cookie header was blocked because it had the
    "SameSite=None" attribute but did not have the "Secure" attribute, which is required
    in order to use "SameSite=None".
```

Und im ASP.NET-Core-Log, wenn der Logger für `Microsoft.AspNetCore.Http.ResponseCookies` auf `Warning` aktiviert ist:

```text
warn: Microsoft.AspNetCore.Http.ResponseCookies
      The cookie 'session' has set 'SameSite=None' and must also set 'Secure'.
```

## Warum das Cookie nie in document.cookie oder in der nächsten Anfrage ankommt

`Response.Cookies.Append` ist ein dünner Wrapper. Im Quellcode von ASP.NET Core (`src/Http/Http/src/Internal/ResponseCookies.cs`) erledigt die Methode drei Dinge: Wenn `SameSite` gleich `None` und `Secure` gleich `false` ist, protokolliert sie die obige Warnung, sie kodiert den Wert per URL-Encoding mit `Uri.EscapeDataString`, und sie hängt einen neuen `Set-Cookie`-Header an die Antwort an. Das ist alles. Sie validiert weder die Domain noch prüft sie CORS, und sie wirft keine Exception, wenn das Cookie abgelehnt werden wird. Jeder der echten Fehler passiert später, im Browser, der auf jeden `Set-Cookie`-Header eine Reihe von Regeln anwendet:

1. **CORS-Credentials-Modus.** Bei einem Cross-Origin-`fetch` oder -`XMLHttpRequest` ignoriert der Browser `Set-Cookie` vollständig, es sei denn, die Anfrage wurde im Credentials-Modus gestellt (`credentials: 'include'` / `withCredentials = true`) und die Antwort enthielt `Access-Control-Allow-Credentials: true` mit einem expliziten (nicht `*`) `Access-Control-Allow-Origin`.
2. **SameSite.** Ein `SameSite=None`-Cookie ohne `Secure` wird von jedem aktuellen Browser abgelehnt. Ein `Lax`- oder `Strict`-Cookie, das in einer Cross-Site-Antwort gesetzt wird, wird als Drittanbieter-Cookie abgelehnt.
3. **Secure.** Ein `Secure`-Cookie, das über einfaches `http://` gesetzt wird, wird abgelehnt, mit einer Ausnahme: Chrome (seit 89) und Firefox (seit 75) behandeln `http://localhost` hierfür als sicher. Safari tut das nicht.
4. **Domain und Path.** Ein `Domain`-Attribut, das nicht per Domain-Match zum Host der Antwort passt, wird abgelehnt. Ein `Path`, der die später angefragte URL nicht abdeckt, bedeutet, dass das Cookie gespeichert, aber nie zurückgesendet wird, was genauso aussieht wie "nicht gesetzt".
5. **Größe.** Ein einzelnes Cookie (Name plus Wert) über 4096 Bytes wird verworfen.

Zusätzlich zu den Browserregeln gibt es in ASP.NET Core selbst zwei Stellen, an denen ein Cookie verschwinden kann, bevor es übertragen wird: die Consent-Prüfung der `CookiePolicyMiddleware` und die Grenze "Antwort hat bereits begonnen".

## Minimale Reproduktion: ein React-Dev-Server ruft eine ASP.NET-Core-API auf

Dieses Setup steckt hinter den meisten "Cookie wird nicht gesetzt"-Fragen auf Stack Overflow: eine SPA auf einem Port, eine API auf einem anderen.

```csharp
// .NET 10, ASP.NET Core 10 - Program.cs (broken)
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
    p.WithOrigins("http://localhost:5173")
     .AllowAnyHeader()
     .AllowAnyMethod()));

var app = builder.Build();
app.UseCors();

app.MapPost("/login", (HttpContext ctx) =>
{
    ctx.Response.Cookies.Append("session", "abc123", new CookieOptions
    {
        HttpOnly = true,
        SameSite = SameSiteMode.None
    });
    return Results.Ok();
});

app.MapGet("/me", (HttpContext ctx) =>
    ctx.Request.Cookies.TryGetValue("session", out var s)
        ? Results.Ok(s)
        : Results.Unauthorized());

app.Run();
```

```javascript
// Vite dev server on http://localhost:5173
await fetch("https://localhost:7001/login", { method: "POST" });
const me = await fetch("https://localhost:7001/me");
console.log(me.status); // 401
```

Hier summieren sich drei separate Fehler. Die `fetch`-Aufrufe verwenden den Standardwert `credentials: 'same-origin'`, daher verwirft der Browser `Set-Cookie` aus der Cross-Origin-Antwort und hängt keine Cookies an `/me` an. Die CORS-Policy enthält kein `AllowCredentials()`. Und das Cookie ist `SameSite=None` ohne `Secure`. Wer nur einen davon behebt, sieht weiterhin dieselbe 401, weshalb sich dieses Problem so zufällig anfühlt.

## Lösung 1: Credentials senden und in der CORS-Policy erlauben

Bei jedem Cross-Origin-Aufruf müssen beide Seiten zustimmen. Auf dem Client:

```javascript
// Browser, any framework
await fetch("https://localhost:7001/login", {
  method: "POST",
  credentials: "include"
});

// axios equivalent
axios.post("https://localhost:7001/login", null, { withCredentials: true });
```

Auf dem Server listen Sie die exakten Origins auf und rufen `AllowCredentials()` auf:

```csharp
// .NET 10, ASP.NET Core 10
builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
    p.WithOrigins("http://localhost:5173", "https://app.example.com")
     .AllowAnyHeader()
     .AllowAnyMethod()
     .AllowCredentials()));
```

Sie können `AllowAnyOrigin()` nicht mit `AllowCredentials()` kombinieren. Die CORS-Spezifikation verbietet `Access-Control-Allow-Origin: *` bei einer Antwort mit Credentials, und ASP.NET Core setzt das beim Aufbau der Policy durch, indem es `InvalidOperationException: The CORS protocol does not allow specifying a wildcard (any) origin and credentials at the same time.` wirft. Wenn Sie dynamische Origins benötigen, verwenden Sie `SetIsOriginAllowed(origin => ...)` mit einer echten Prüfung, niemals `_ => true`, denn jede beliebige Origin bei aktivierten Credentials zu spiegeln ist eine klassische CSRF-Lücke. Die vollständige Einrichtung der Policy, einschließlich Preflight-Caching, behandelt [CORS für eine JWT-geschützte API in ASP.NET Core 11 konfigurieren](/de/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/).

Auch die Reihenfolge der Middleware ist wichtig: `app.UseCors()` muss vor dem Endpunkt laufen, der das Cookie anhängt, und vor `UseAuthentication()` / `UseAuthorization()`.

## Lösung 2: SameSite=None mit Secure kombinieren oder SameSite=None vermeiden

Der Standardwert von `CookieOptions.SameSite` ist `SameSiteMode.Unspecified`, das heißt, ASP.NET Core gibt kein `SameSite`-Attribut aus und der Browser wendet seinen eigenen Standard an. Chromium behandelt ein fehlendes Attribut als `Lax`. Dieser Standard ist für fast jede Same-Site-App richtig, und zu `None` sollten Sie nur greifen, wenn das Cookie tatsächlich bei Cross-Site-Anfragen mitreisen muss (ein auf einer anderen Site eingebettetes iframe, ein Drittanbieter-Widget, ein Callback eines Identity Providers, der `form_post` verwendet).

Wenn Sie `None` tatsächlich benötigen, ist `Secure` Pflicht:

```csharp
// .NET 10, ASP.NET Core 10
ctx.Response.Cookies.Append("session", token, new CookieOptions
{
    HttpOnly = true,
    Secure = true,                  // required with SameSite=None
    SameSite = SameSiteMode.None,
    Path = "/",
    MaxAge = TimeSpan.FromHours(8)
});
```

Folgende Unterscheidung bringt viele durcheinander: **SameSite bezieht sich auf die Site, CORS auf die Origin.** Eine Site besteht aus dem Schema plus der registrierbaren Domain und ignoriert den Port. Ein Aufruf von `http://localhost:5173` an `http://localhost:5001` ist also Cross-Origin (CORS greift, Sie benötigen Lösung 1), aber Same-Site (`Lax`-Cookies funktionieren). Ein Aufruf von `app.example.com` an `api.example.com` ist ebenfalls Same-Site. In diesen Setups benötigen Sie `SameSite=None` überhaupt nicht; behalten Sie `Lax` und beheben Sie nur die Credentials.

Das Schema zählt allerdings. Chrome verwendet seit Chrome 89 "schemeful same-site", daher ist ein Aufruf von `http://localhost:5173` an `https://localhost:7001` Cross-Site, und ein `Lax`-Cookie, das die HTTPS-API setzt, wird bei Anfragen der HTTP-Seite nicht gesendet. Betreiben Sie entweder beide Dev-Server mit demselben Schema (das Vite-Plugin `basicSsl` oder `dotnet dev-certs https` funktionieren beide), oder stellen Sie die API hinter den Proxy des Dev-Servers, sodass der Browser immer nur mit einer Origin kommuniziert. Die Proxy-Variante ist am robustesten, weil sie die Same-Origin-Bereitstellung der Produktion nachbildet.

Echte Cross-Site-Cookies (die SPA auf `myapp.com`, die API auf `myapi.net`) sind Drittanbieter-Cookies. Chrome hat sie standardmäßig aktiviert gelassen, nachdem Google seinen Plan zur Abschaffung im April 2025 aufgegeben hat, aber Safari blockiert sie komplett und Firefox partitioniert sie im Rahmen von Total Cookie Protection. Bauen Sie nicht darauf. Verlegen Sie die API unter dieselbe registrierbare Domain oder wechseln Sie zu einem Backend-for-Frontend, damit der Browser ein Erstanbieter-Cookie hält. Wenn Sie Cross-Site einbetten müssen, sehen Sie sich partitionierte Cookies (CHIPS) an. `CookieOptions` hat in ASP.NET Core 10 keine `Partitioned`-Eigenschaft, aber über `Extensions` können Sie das Attribut selbst hinzufügen:

```csharp
// .NET 10, ASP.NET Core 10 - CHIPS partitioned cookie for a cross-site iframe
var options = new CookieOptions
{
    Secure = true,
    SameSite = SameSiteMode.None,
    HttpOnly = true
};
options.Extensions.Add("Partitioned");
ctx.Response.Cookies.Append("widget-state", value, options);
```

## Lösung 3: das Cookie als IsEssential markieren oder keine Einwilligung mehr verlangen

Wenn Ihre App `app.UseCookiePolicy()` aufruft und `CheckConsentNeeded` `true` zurückgibt, umhüllt die `CookiePolicyMiddleware` die Cookie-Sammlung der Antwort und verwirft stillschweigend jedes Cookie, das nicht als essenziell markiert ist, bis der Benutzer das Consent-Cookie akzeptiert hat. Auf der Standardstufe wird nichts protokolliert, und der Aufruf von `Append` sieht aus, als hätte er funktioniert. Die Templates von ASP.NET Core 2.1 bis 2.2 wurden mit dieser Einstellung ausgeliefert, daher tragen ältere Projekte, die schrittweise aktualisiert wurden, sie oft noch mit sich.

```csharp
// .NET 10, ASP.NET Core 10 - the configuration that eats cookies
builder.Services.Configure<CookiePolicyOptions>(o =>
{
    o.CheckConsentNeeded = _ => true;
    o.MinimumSameSitePolicy = SameSiteMode.Lax;
});
// ...
app.UseCookiePolicy();
```

Entweder ist das Cookie für die Funktion der App erforderlich, dann setzen Sie `IsEssential = true` (und sind in Ihrer Datenschutzerklärung ehrlich darüber), oder es ist das nicht, und das korrekte Verhalten ist, auf die Einwilligung zu warten:

```csharp
// .NET 10, ASP.NET Core 10
ctx.Response.Cookies.Append("cart", cartId, new CookieOptions
{
    IsEssential = true,
    HttpOnly = true,
    Secure = true
});
```

Den Consent-Status können Sie explizit mit `ctx.Features.Get<ITrackingConsentFeature>()` prüfen; dessen Eigenschaft `CanTrack` gibt an, ob nicht essenzielle Cookies geschrieben werden. `MinimumSameSitePolicy` in denselben Optionen kann außerdem das `SameSite` Ihres Cookies auf einen strengeren Wert umschreiben als den übergebenen. Wenn ein Cookie also mit einem anderen `SameSite` auftaucht als dem, das Sie gesetzt haben, sehen Sie hier nach.

## Lösung 4: anhängen, bevor die Antwort beginnt

Antwort-Header werden in dem Moment gesendet, in dem das erste Byte des Bodys geflusht wird. Ab diesem Punkt wirft `Response.Cookies.Append` die Exception `InvalidOperationException: Headers are read-only, response has already started.` Die klassischen Stellen dafür sind Middleware, die nach `await next()` ein Cookie anhängt, ein Endpunkt, der in `Response.Body` schreibt und danach ein Cookie setzt, sowie Code innerhalb einer Streaming-Antwort oder einer SSE-Schleife.

```csharp
// .NET 10, ASP.NET Core 10 - broken: the endpoint already wrote the body
app.Use(async (ctx, next) =>
{
    await next();
    ctx.Response.Cookies.Append("last-seen", DateTimeOffset.UtcNow.ToString("O"));
});

// fixed: register a callback that runs just before headers are flushed
app.Use(async (ctx, next) =>
{
    ctx.Response.OnStarting(() =>
    {
        ctx.Response.Cookies.Append("last-seen", DateTimeOffset.UtcNow.ToString("O"));
        return Task.CompletedTask;
    });
    await next();
});
```

Wenn die Exception irgendwo verschluckt wird (ein Exception-Filter, ein Fire-and-Forget-Task), ist das sichtbare Symptom nur ein fehlendes Cookie. Prüfen Sie daher bei diesem Verdacht `ctx.Response.HasStarted` an einem Haltepunkt.

## Stolperfallen, die wie "das Cookie wurde nicht gesetzt" aussehen

**Das Cookie ist gesetzt, aber Ihr JavaScript sieht es nicht.** `HttpOnly = true` verbirgt es absichtlich vor `document.cookie`. Prüfen Sie stattdessen den Application-Tab in den DevTools. Das ist das gewünschte Verhalten für Session-Tokens, wie in [JWT vs. Cookie-Authentifizierung in ASP.NET Core 11](/de/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/) beschrieben.

**Das Cookie wird gespeichert, aber nicht zurückgesendet.** `CookieOptions` setzt `Path` standardmäßig auf `/`, was in Ordnung ist. Wenn Sie aber `Path = "/api/auth"` setzen, hängt der Browser es nur an URLs unterhalb dieses Pfads an. Dasselbe gilt für eine `Domain`, die auf eine übergeordnete Domain gesetzt ist, zu der Ihr Dev-Host nicht passt. Lassen Sie `Domain` ungesetzt, sofern Sie das Cookie nicht über Subdomains teilen müssen; ein Host-only-Cookie ist strenger und sicherer.

**Der Wert sieht verstümmelt aus.** `Append` schickt den Wert durch `Uri.EscapeDataString`, daher kommt `a b=c` in `document.cookie` als `a%20b%3Dc` an. `Request.Cookies` dekodiert ihn auf dem Server für Sie; JavaScript-Code benötigt `decodeURIComponent`.

**Safari funktioniert in Produktion, aber nicht auf localhost.** Safari lehnt `Secure`-Cookies über `http://localhost` ab, während Chrome und Firefox sie akzeptieren. Betreiben Sie den Dev-Server über HTTPS mit `dotnet dev-certs https --trust`.

**Interaktive Blazor-Komponenten.** In Blazor Server oder interaktiven Render-Modi läuft die Komponente über einen SignalR-Circuit, nachdem die ursprüngliche HTTP-Antwort bereits weg ist. Es gibt also keine Antwort, an die man etwas anhängen könnte, und `HttpContext` ist null oder veraltet. Setzen Sie Cookies aus einer Razor Page, einem Minimal-API-Endpunkt, den der Client aufruft, oder einem Formular-Post mit statischem SSR. Dieselbe Einschränkung bestimmt das Design hinter [`[SupplyParameterFromSession]` in static SSR](/de/2026/06/blazor-supplyparameterfromsession-static-ssr-dotnet-11-preview-5/).

**Das Cookie ist zu groß.** Browser verwerfen ein Cookie, dessen Name plus Wert 4096 Bytes überschreitet. Der Cookie-Authentifizierungs-Handler von ASP.NET Core verteilt große Tickets über `ChunkingCookieManager` automatisch auf `.AspNetCore.Cookies`, `C1`, `C2`, ein einfaches `Response.Cookies.Append` tut das jedoch nicht. Wenn Sie ein JWT mit vielen Claims in ein Cookie stopfen, kürzen Sie entweder die Claims oder behalten Sie das Token auf dem Server und legen nur ein kurzes Handle in das Cookie. Refresh-Token-Flows sind eine häufige Quelle dafür; siehe [Refresh-Tokens in ASP.NET Core Identity implementieren](/de/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/) für einen Aufbau, der Cookies klein hält.

**Antiforgery-Cookies, die nach einer Bereitstellung verschwinden**, sind ein anderes Problem mit demselben Symptom. Das Cookie ist gesetzt, kann aber von der nächsten Instanz nicht entschlüsselt werden. Das behandelt [Lösung für "The antiforgery token could not be decrypted"](/de/2026/06/fix-the-antiforgery-token-could-not-be-decrypted-in-aspnetcore/).

## Eine Checkliste, die die Ursache in unter einer Minute findet

Wenn ein Cookie nicht hängen bleibt, gehen Sie diese Punkte der Reihe nach durch. Jeder Schritt findet entweder den Fehler oder schließt eine ganze Kategorie aus:

1. Öffnen Sie die DevTools, den Network-Tab, wählen Sie die Antwort aus, die das Cookie setzen soll, und bestätigen Sie, dass der `Set-Cookie`-Header vorhanden ist. Fehlt er, liegt das Problem auf dem Server: Consent-Policy, eine Exception nach Beginn der Antwort, oder der Codepfad wurde nie ausgeführt.
2. Ist der Header vorhanden, öffnen Sie den Unter-Tab Cookies dieser Anfrage. Chromium kennzeichnet blockierte Cookies mit einem Warnsymbol und dem genauen Grund (SameSite, Secure, Domain oder Blockierung von Drittanbieter-Cookies).
3. Ist der Aufruf Cross-Origin, prüfen Sie die Anfrage auf `credentials: 'include'` und die Antwort auf `Access-Control-Allow-Credentials: true` plus ein konkretes `Access-Control-Allow-Origin`.
4. Wird das Cookie gespeichert, fehlt aber in der nächsten Anfrage, vergleichen Sie dessen `Path`, `Domain`, `SameSite` und `Secure` mit der URL und dem Schema dieser nächsten Anfrage.
5. Funktioniert es in Chrome und scheitert in Safari, ist es entweder `Secure` über `http://localhost` oder ein Drittanbieter-Cookie.

Der Servercode ist selten der Fehler. Betrachten Sie `Append` als "bitte erwäge, das zu speichern", und debuggen Sie die Antwort des Browsers.

## Quellen

- [ResponseCookies.cs in dotnet/aspnetcore](https://github.com/dotnet/aspnetcore/blob/main/src/Http/Http/src/Internal/ResponseCookies.cs) (die `SameSite=None`-Warnung und die Kodierung des Werts)
- [CookieOptions-Klasse auf MS Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.cookieoptions)
- [CORS in ASP.NET Core aktivieren: Credentials in Cross-Origin-Anfragen](https://learn.microsoft.com/en-us/aspnet/core/security/cors#credentials-in-cross-origin-requests)
- [Unterstützung der EU-Datenschutz-Grundverordnung (DSGVO) in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/security/gdpr)
- [Mit SameSite-Cookies in ASP.NET Core arbeiten](https://learn.microsoft.com/en-us/aspnet/core/security/samesite)
- [MDN: Set-Cookie](https://developer.mozilla.org/docs/Web/HTTP/Headers/Set-Cookie)
- [dotnet/aspnetcore#55370: Unterstützung für partitionierte Cookies hinzufügen](https://github.com/dotnet/aspnetcore/issues/55370)
