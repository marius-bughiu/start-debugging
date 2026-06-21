---
title: "CORS für eine JWT-geschützte API in ASP.NET Core 11 konfigurieren"
description: "Ein vollständiger Leitfaden zu CORS für eine API mit Bearer-Token in ASP.NET Core 11: die korrekte Reihenfolge von UseCors gegenüber der Authentifizierung, warum ein Bearer-Token im Authorization-Header keine CORS-Anmeldeinformation ist, warum AllowAnyHeader funktioniert, ein manueller Platzhalter Authorization aber nicht abdeckt, und wie Sie verhindern, dass der Preflight fehlschlägt."
pubDate: 2026-06-21
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "cors"
  - "jwt"
  - "security"
lang: "de"
translationOf: "2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-06-21
---

Wenn Ihre Single-Page-App eine JWT-geschützte ASP.NET Core API von einem anderen Ursprung aus aufruft und die Browser-Konsole "No 'Access-Control-Allow-Origin' header is present" oder "Request header field authorization is not allowed" anzeigt, liegt die Lösung fast nie auf der Authentifizierungsseite. Sie benötigen eine CORS-Richtlinie, die den Ursprung Ihres Front-Ends mit `WithOrigins` benennt, den Anfrage-Header `Authorization` zulässt und `app.UseCors(...)` *vor* `app.UseAuthentication()` und `app.UseAuthorization()` ausführt. Was die meisten Leitfäden falsch machen: Ein Bearer-Token, das Sie selbst in den `Authorization`-Header setzen, ist **keine** CORS-Anmeldeinformation, daher benötigen Sie für eine Header-basierte JWT-API **kein** `AllowCredentials()`, und das Hinzufügen zwingt Sie ohne Nutzen dazu, auf `AllowAnyOrigin` zu verzichten. Dieser Beitrag bezieht sich auf .NET 11 (zum Zeitpunkt des Schreibens Preview 5), aber die CORS- und JWT-Bearer-APIs sind seit .NET 8, 9 und 10 unverändert.

## CORS und JWT sind zwei voneinander unabhängige Tore, die gleichzeitig versagen

Eine ursprungsübergreifende Anfrage von `https://app.example.com` an `https://api.example.com` durchläuft zwei vollständig unabhängige Prüfungen, und sie zu verwechseln ist die Wurzel fast aller hier verschwendeten Nachmittage.

Die erste ist CORS. Sie wird vom Browser durchgesetzt, nicht von Ihrem Server. Der Browser entscheidet anhand der `Access-Control-Allow-*`-Header, die Ihr Server sendet, ob JavaScript *die Antwort lesen darf*. CORS weiß nichts darüber, wer Sie sind. Es interessiert sich nur für Ursprünge, Methoden und Anfrage-Header.

Die zweite ist die Authentifizierung. Der JWT-Bearer-Handler von ASP.NET Core validiert das Token im `Authorization`-Header und erzeugt einen 401 oder einen `ClaimsPrincipal`. Er weiß nichts über Ursprünge.

Die Falle besteht darin, dass eine falsch konfigurierte CORS-Richtlinie und ein fehlendes Token in den DevTools ähnliche Fehler erzeugen. Ein 401 ohne CORS-Header erscheint in der Konsole als CORS-Fehler, weil der Browser die Antwort verwirft, bevor Ihr Code sie sehen kann. So verbringen Sie eine Stunde mit dem Token, obwohl das eigentliche Problem die Reihenfolge der Richtlinie ist, oder umgekehrt. Halten Sie die beiden Tore in Ihrem Kopf getrennt: CORS entscheidet, ob der Browser Ihnen die Bytes übergibt, die Authentifizierung entscheidet, ob der Server sie erzeugt hat.

## Ein Bearer-Token im Authorization-Header ist keine CORS-"Anmeldeinformation"

Dies ist der am meisten missverstandene Punkt, und ihn richtig zu verstehen vereinfacht alles Weitere.

In der CORS-Spezifikation bedeutet "Anmeldeinformationen" drei konkrete Dinge: Cookies, TLS-Client-Zertifikate und den `Authorization`-Header, *den der User-Agent automatisch* aus einer gespeicherten HTTP-Authentifizierung befüllt. Wenn Sie `fetch(url, { headers: { Authorization: "Bearer " + token } })` schreiben, setzen Sie einen vom Autor definierten Anfrage-Header. Das ist keine Anfrage mit Anmeldeinformationen. Der `credentials`-Modus dieses Fetch ist weiterhin der Standardwert `"same-origin"`, was bei einem ursprungsübergreifenden Aufruf "keine Cookies senden" bedeutet.

Die Konsequenz: Für eine typische SPA, die ihr JWT im Speicher oder im `localStorage` ablegt und es manuell anhängt, sollten Sie `AllowCredentials()` **nicht** aufrufen. Sie benötigen es nur, wenn das Token (oder ein Refresh-Token oder eine Sitzung) in einem Cookie mitgeführt wird, denn Cookies sind echte CORS-Anmeldeinformationen, und der Browser sendet sie ursprungsübergreifend nicht, sofern die Antwort nicht `Access-Control-Allow-Credentials: true` enthält.

Warum ist das über Pedanterie hinaus wichtig? Weil `AllowCredentials()` mit `AllowAnyOrigin()` unvereinbar ist. Sobald Sie Anmeldeinformationen hinzufügen, verbietet die CORS-Spezifikation den Ursprungs-Platzhalter `*`, und ASP.NET Core erzwingt dies, indem es beim Start eine Ausnahme wirft:

```csharp
// .NET 11, C# 14
// This throws ArgumentException at app build time:
// "The CORS protocol does not allow specifying a wildcard (any) origin
//  and credentials at the same time."
options.AddPolicy("bad", policy => policy
    .AllowAnyOrigin()
    .AllowCredentials());
```

Wenn Sie also bei einer Header-basierten Bearer-API reflexartig `AllowCredentials()` hinzufügen, haben Sie die Einschränkung der Ursprungsfixierung übernommen, ohne einen der Vorteile zu erhalten. Lassen Sie es weg, sofern Sie nicht tatsächlich Cookies verwenden.

## Die Richtlinie, die funktioniert

Hier ist die vollständige, korrekte Konfiguration für eine Minimal API, die JWTs validiert und von einem oder mehreren bekannten Front-End-Ursprüngen aufgerufen wird. Falls Sie noch zwischen den Minimal APIs und dem MVC-Modell wählen, werden die Abwägungen in [Minimal APIs vs. Controller in ASP.NET Core 11](/de/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) behandelt; CORS ist in beiden Fällen identisch.

```csharp
// .NET 11, C# 14
var builder = WebApplication.CreateBuilder(args);

const string SpaCors = "spa";

builder.Services.AddCors(options =>
{
    options.AddPolicy(SpaCors, policy => policy
        .WithOrigins("https://app.example.com", "http://localhost:5173")
        .WithHeaders("Authorization", "Content-Type")
        .WithMethods("GET", "POST", "PUT", "DELETE")
        .SetPreflightMaxAge(TimeSpan.FromMinutes(10)));
});

builder.Services.AddAuthentication("Bearer")
    .AddJwtBearer(options =>
    {
        options.Authority = "https://login.example.com";
        options.Audience = "api://my-api";
        // TokenValidationParameters tuned for your issuer here.
    });

builder.Services.AddAuthorization();

var app = builder.Build();

// Order is load-bearing. See the next section.
app.UseCors(SpaCors);
app.UseAuthentication();
app.UseAuthorization();

app.MapGet("/me", (ClaimsPrincipal user) => user.Identity!.Name)
    .RequireAuthorization();

app.Run();
```

Drei bewusste Entscheidungen in dieser Richtlinie:

- `WithOrigins` listet exakte Ursprünge auf, einschließlich Schema und Port. `http://localhost:5173` und `https://localhost:5173` sind unterschiedliche Ursprünge, ebenso derselbe Host an einem anderen Port.
- `WithHeaders("Authorization", "Content-Type")` lässt die beiden Anfrage-Header zu, die ein JSON+JWT-Aufruf tatsächlich sendet. `Content-Type: application/json` ist kein in der CORS-Safelist enthaltener Wert und löst daher von sich aus einen Preflight aus.
- `WithMethods` listet die Verben auf, die die API bereitstellt. Ein `PUT` oder `DELETE` löst immer einen Preflight aus.

Kein `AllowCredentials()`, denn dies ist eine Header-basierte Bearer-API.

## Warum UseCors vor UseAuthentication ausgeführt werden muss

Die Reihenfolge der Middleware ist nicht stilistisch. `app.UseCors(...)` muss nach `UseRouting` (das `WebApplication` implizit aufruft) und **vor** `UseAuthentication` und `UseAuthorization` stehen. Die [CORS-Dokumentation](https://learn.microsoft.com/en-us/aspnet/core/security/cors) von Microsoft legt die Regel fest; hier ist, was tatsächlich kaputtgeht, wenn Sie sie ignorieren.

Ein CORS-Preflight ist eine `OPTIONS`-Anfrage, und der Browser sendet sie **ohne** den `Authorization`-Header. Das ist beabsichtigt: Der Preflight fragt "darf ich diese Anfrage stellen?", bevor irgendwelche Anmeldeinformationen angehängt werden. Wenn die Authentifizierung oder eine `[Authorize]`/`RequireAuthorization`-Prüfung vor der CORS-Middleware ausgeführt wird, erhält die nicht authentifizierte `OPTIONS`-Anfrage einen 401, der Browser erhält nie die `Access-Control-Allow-*`-Header, und die eigentliche Anfrage wird nie gesendet. Sie sehen einen Preflight-Fehler im Network-Tab und schließen fälschlicherweise, dass Ihr Token fehlerhaft ist.

Wenn `UseCors` zuerst platziert wird, erkennt die CORS-Middleware den Preflight, beantwortet ihn mit einem 204 und den richtigen Headern und bricht ab, bevor die Authentifizierung überhaupt ausgeführt wird. Das anschließende eigentliche `GET`/`POST` führt das Token mit und durchläuft die Authentifizierung normal.

Dieselbe Reihenfolge behebt auch das Problem "401 ohne CORS-Header" für echte Anfragen. Wenn ein Token fehlt oder abgelaufen ist, *wollen* Sie, dass der 401 weiterhin `Access-Control-Allow-Origin` mitführt, damit der Browser die Antwort offenlegt und Ihre SPA den Status lesen und zur Anmeldung umleiten kann. Das geschieht nur, wenn CORS vor der Authentifizierungs-Middleware ausgeführt wird, die den 401 erzeugt. Genau diese Lücke war Gegenstand eines langjährigen ASP.NET-Core-Problems ([dotnet/aspnetcore#16584](https://github.com/dotnet/aspnetcore/issues/16584)), und die Reihenfolge ist die Lösung.

## Die Platzhalter-Falle beim Authorization-Header

Diese trifft Personen, die in der Entwicklung großzügig sein wollen und später nachschärfen. Gemäß dem [Fetch-Standard](https://fetch.spec.whatwg.org/) und dokumentiert auf [MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Access-Control-Allow-Headers) deckt der Platzhalter in `Access-Control-Allow-Headers: *` den `Authorization`-Header **nicht** ab. Der Browser behandelt `Authorization` als Sonderfall: Er muss explizit benannt werden, sonst schlägt der Preflight für jede Anfrage mit Bearer-Token mit "Request header field authorization is not allowed by Access-Control-Allow-Headers" fehl.

Wenn Sie also CORS in einer benutzerdefinierten Middleware mit einem literalen `Access-Control-Allow-Headers: *` von Hand umsetzen, brechen Ihre JWT-Aufrufe, obwohl der Platzhalter alles zuzulassen scheint.

Hier ist der beruhigende Teil für ASP.NET-Core-Nutzer: Das integrierte `AllowAnyHeader()` gibt **keinen** literalen `*` aus. Der `CorsService` gibt genau die Header zurück, die der Browser in `Access-Control-Request-Headers` angefordert hat, was bedeutet, dass `Authorization` zurückgespiegelt wird und der Preflight erfolgreich ist. Sie können das im [CorsService-Quellcode](https://github.com/dotnet/aspnetcore/blob/main/src/Middleware/CORS/src/Infrastructure/CorsService.cs) überprüfen: Der Wert der zulässigen Header stammt aus `GetCommaSeparatedValues(CorsConstants.AccessControlRequestHeaders)`, nicht aus einem konstanten `*`.

Die praktische Regel, die daraus folgt:

- `AllowAnyHeader()` funktioniert für Bearer-Token einwandfrei, weil ASP.NET Core zurückspiegelt statt zu wildcarden.
- `WithHeaders(...)` funktioniert nur, wenn Sie `"Authorization"` in die Liste aufnehmen. Es zu vergessen ist der häufigste selbstverschuldete CORS-Fehler bei einer JWT-API, weil `Content-Type` allein vollständig aussieht und der 403-/Preflight-Fehler wenig aussagekräftig ist.

Im Zweifelsfall listen Sie `Authorization` explizit auf. Es kostet nichts und beseitigt eine ganze Klasse von Bugs.

## Korrekte Konfiguration, Schritt für Schritt

1. Registrieren Sie CORS mit einer benannten Richtlinie in `AddCors` und fixieren Sie die Ursprünge Ihres Front-Ends mit `WithOrigins` (exaktes Schema, Host und Port).
2. Lassen Sie die Anfrage-Header zu, die Ihr Client sendet. Nehmen Sie `"Authorization"` und `"Content-Type"` explizit mit `WithHeaders` auf, oder verwenden Sie `AllowAnyHeader()` und verlassen Sie sich auf das Header-Echo von ASP.NET Core.
3. Lassen Sie die HTTP-Methoden zu, die Ihre Endpunkte bereitstellen, mit `WithMethods`, einschließlich der Verben (`PUT`, `DELETE`), die immer einen Preflight auslösen.
4. Entscheiden Sie über Anmeldeinformationen: Lassen Sie `AllowCredentials()` für ein Header-basiertes Bearer-Token weg; fügen Sie es nur hinzu, wenn ein Cookie beteiligt ist, und ersetzen Sie in diesem Fall `AllowAnyOrigin` durch explizite `WithOrigins`.
5. Platzieren Sie `app.UseCors("policy")` nach dem Routing und vor `app.UseAuthentication()` und `app.UseAuthorization()`.
6. Wenden Sie die Richtlinie global mit `app.UseCors(...)` an oder pro Endpunkt mit `.RequireCors("policy")` (oder `[EnableCors("policy")]` bei Controllern). Mischen Sie nicht globales Middleware-CORS mit dem Attribut in derselben App.

## Cookies, Refresh-Tokens und der Fall mit Anmeldeinformationen

Wenn Ihr Entwurf das Access-Token im Speicher hält, aber ein Refresh-Token in einem `HttpOnly`-Cookie speichert (ein verbreitetes und solides Muster, siehe [wie man Refresh-Tokens in ASP.NET Core Identity implementiert](/de/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/)), dann ist der Refresh-Aufruf *tatsächlich* mit Anmeldeinformationen versehen, und die Regeln kehren sich um:

```csharp
// .NET 11, C# 14
options.AddPolicy("spa-with-cookie", policy => policy
    .WithOrigins("https://app.example.com") // exact origins only, no AllowAnyOrigin
    .WithHeaders("Authorization", "Content-Type")
    .WithMethods("GET", "POST", "PUT", "DELETE")
    .AllowCredentials());                    // required so the browser sends the cookie
```

Auf dem Client benötigt genau dieser Endpunkt `fetch(url, { credentials: "include" })`. Der Server muss mit einem konkreten `Access-Control-Allow-Origin` (niemals `*`) und `Access-Control-Allow-Credentials: true` antworten, was genau das ist, was die obige Richtlinie erzeugt. ASP.NET Core spiegelt die zulässigen Header weiterhin zurück, statt sie zu wildcarden, sodass `Authorization` auch im Fall mit Anmeldeinformationen weiterhin funktioniert. Die Erkenntnis: Beschränken Sie `AllowCredentials()` auf die Richtlinie, die tatsächlich Cookies berührt, nicht auf Ihre gesamte API.

## Preflight-Geplauder reduzieren

Jede ursprungsübergreifende Anfrage mit einer nicht einfachen Methode oder einem nicht einfachen Header bezahlt einen Preflight-Hin-und-Rückweg. `SetPreflightMaxAge(TimeSpan.FromMinutes(10))` teilt dem Browser mit, dass er das Preflight-Ergebnis zwischenspeichern darf, sodass wiederholte Aufrufe desselben Endpunkts den `OPTIONS`-Hop überspringen. Browser begrenzen diesen Wert (Chromium honoriert bis zu zwei Stunden, Firefox bis zu 24, und beide haben ihre eigenen Obergrenzen), behandeln Sie ihn also als Hinweis und nicht als Garantie. Bei einer gesprächigen API lohnt es sich dennoch, ihn zu setzen.

Wenn Sie nur einige wenige Front-End-Ursprünge und überall dieselbe Richtlinie benötigen, ist `AddDefaultPolicy` zusammen mit einem parameterlosen `app.UseCors()` etwas weniger umständlich als eine benannte Richtlinie. Für eine größere API, bei der verschiedene Endpunktgruppen unterschiedliche Regeln haben, kombinieren Sie eine benannte Richtlinie mit `.RequireCors(...)` an einer `MapGroup`, was sich natürlich mit der in [Minimal-API-Endpunkte mit MapGroup organisieren](/de/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) beschriebenen Struktur kombinieren lässt.

## Wenn das Token abgelehnt wird und CORS nicht das Problem ist

Sobald der Preflight passiert und die eigentliche Anfrage `Access-Control-Allow-Origin` mitführt, ist jeder verbleibende 401 ein echter Authentifizierungsfehler, und Sie sollten aufhören, auf CORS zu schauen. Die üblichen Verdächtigen sind ein nicht übereinstimmender `Audience` oder `Authority`, eine Uhrenabweichung bei der Token-Lebensdauer oder Werkzeuge, die den Header stillschweigend verwerfen. Wenn eine Oberfläche wie Scalar oder Swagger Anfragen ohne das Bearer-Token sendet, obwohl Sie es eingefügt haben, ist das ein separates, gut dokumentiertes Problem, das in [warum Ihr Bearer-Token in Scalar ignoriert wird](/de/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/) und in [OpenAPI-Authentifizierungsflüsse zur Swagger UI hinzufügen](/de/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/) behandelt wird.

Das mentale Modell, das Sie aus Schwierigkeiten heraushält: CORS ist der Browser, der fragt "ist dieser ursprungsübergreifende Aufruf erlaubt, und darf ich die Antwort lesen?", und JWT-Bearer ist der Server, der fragt "vertraue ich diesem Token?". Konfigurieren Sie die Richtlinie so, dass sie Ihre Ursprünge und den `Authorization`-Header benennt, führen Sie `UseCors` vor der Authentifizierungs-Middleware aus, lassen Sie `AllowCredentials` weg, sofern kein Cookie im Spiel ist, und die beiden Tore stören sich nicht mehr gegenseitig.

Quellen: [Enable Cross-Origin Requests (CORS) in ASP.NET Core - Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/security/cors), [Access-Control-Allow-Headers - MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Access-Control-Allow-Headers), [Fetch Standard - WHATWG](https://fetch.spec.whatwg.org/), [CorsService source - dotnet/aspnetcore](https://github.com/dotnet/aspnetcore/blob/main/src/Middleware/CORS/src/Infrastructure/CorsService.cs), [aspnetcore#16584 - CORS headers and JWT bearer 401](https://github.com/dotnet/aspnetcore/issues/16584).
