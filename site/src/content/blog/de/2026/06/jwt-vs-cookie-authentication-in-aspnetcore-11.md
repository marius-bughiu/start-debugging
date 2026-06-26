---
title: "JWT- vs. Cookie-Authentifizierung in ASP.NET Core 11: wofür sollten Sie sich entscheiden?"
description: "Verwenden Sie Cookie-Authentifizierung für jede App, bei der der Browser der einzige Client ist, und reservieren Sie JWT-Bearer-Token für APIs, die von mobilen Apps, anderen Diensten oder Dritten aufgerufen werden. Hier ist die vollständige Entscheidungsmatrix."
pubDate: 2026-06-26
tags:
  - "comparison"
  - "aspnetcore"
  - "dotnet"
  - "authentication"
  - "security"
lang: "de"
translationOf: "2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-06-26
---

Wenn das Einzige, was Ihre ASP.NET Core 11 App aufruft, ein Browser ist, verwenden Sie Cookie-Authentifizierung. Wenn der Aufrufer eine mobile App, ein anderer Dienst oder ein Drittanbieter-Client ist, der kein Cookie halten kann, verwenden Sie JWT-Bearer-Token. Die einzige Achse, die das entscheidet, ist der Client: Cookies sind ein Browser-Sitzungsmechanismus mit serverseitigem Widerruf und eingebautem CSRF-Werkzeug, während JWTs eine zustandslose, in sich geschlossene Anmeldeinformation sind, die jeder HTTP-Client tragen kann, die Sie aber nicht vor ihrem Ablauf widerrufen können. Ein JWT für eine serverseitig gerenderte Website oder eine Single-Page-App gleichen Ursprungs zu wählen, ist der häufigste Sicherheitsfehler im .NET-Ökosystem, denn es schiebt ein langlebiges Token ohne jeden Nutzen in einen für JavaScript erreichbaren Speicher. Dieser Beitrag untermauert diese Empfehlung mit der Funktionsmatrix, der Verdrahtung für beide in .NET 11 und dem Fallstrick, der die Entscheidung erzwingt.

Alles hier zielt auf .NET 11, ASP.NET Core 11 und C# 14 ab. Beide Schemata werden serienmäßig ausgeliefert: Cookie-Authentifizierung lebt in `Microsoft.AspNetCore.Authentication.Cookies` und JWT-Bearer lebt in `Microsoft.AspNetCore.Authentication.JwtBearer`, wobei Letzteres die eine NuGet-Referenz ist, die Sie üblicherweise hinzufügen. Am Kern des Trade-offs hat sich in .NET 11 nichts geändert, aber das Framework drängt Sie weiter zum richtigen Standard: Die OAuth-Leitlinie für browserbasierte Apps und das Backend-for-Frontend-Muster haben beide den Rat verschärft, Token vollständig aus dem Browser herauszuhalten.

## Die Funktionsmatrix

| Funktion                      | Cookie-Authentifizierung              | JWT-Bearer                              |
| ----------------------------- | ------------------------------------- | --------------------------------------- |
| Getragen in                   | `Cookie`-Header (browser-verwaltet)   | `Authorization: Bearer`-Header          |
| Serverzustand                 | zustandsbehaftet (Ticket erneut prüfbar) | zustandslos (in sich geschlossene Claims) |
| Vor Ablauf widerrufbar        | ja (sofort)                           | nein (braucht Sperrliste oder kurze TTL) |
| Automatisch vom Browser gesetzt | ja                                  | nein (Client hängt es an)               |
| CSRF-Angriffsfläche           | ja, braucht Antiforgery-Token         | nein (Header wird nicht automatisch gesendet) |
| XSS-Angriffsfläche der Anmeldeinformation | gering (`HttpOnly` verbirgt es vor JS) | hoch, wenn in JS-lesbarem Speicher abgelegt |
| Funktioniert für Nicht-Browser-Clients | umständlich                  | nativ                                   |
| Domänenübergreifend / Multi-API | mühsam (Cookie-Geltungsregeln)      | einfach (jeder Host validiert die Signatur) |
| Nutzlastgröße pro Anfrage     | kleiner, undurchsichtiger ID-artiger Wert | vollständiges Token, wächst mit Claims |
| Eingebaut in .NET 11          | ja                                    | ja (`AddJwtBearer`)                     |

Die Zeilen, die reale Designs entscheiden, sind Widerruf, CSRF und XSS. Alles andere ist Verdrahtung.

## Was jedes Schema tatsächlich ist

Cookie-Authentifizierung stellt nach der Anmeldung ein verschlüsseltes Authentifizierungs-Ticket aus und speichert es in einem Cookie, das die Data-Protection-Schicht von ASP.NET Core signiert und verschlüsselt. Der Browser hängt dieses Cookie automatisch an jede Anfrage gleicher Site an. Der Server entschlüsselt es, baut den `ClaimsPrincipal` wieder auf und kann bei jeder Anfrage `OnValidatePrincipal` ausführen, um den Benutzer erneut gegen die Datenbank zu prüfen. So widerrufen Sie eine Sitzung in dem Moment, in dem ein Benutzer deaktiviert wird.

```csharp
// .NET 11, C# 14
builder.Services
    .AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(options =>
    {
        options.Cookie.HttpOnly = true;                 // hidden from document.cookie
        options.Cookie.SecurePolicy = CookieSecurePolicy.Always;
        options.Cookie.SameSite = SameSiteMode.Strict;  // blocks most CSRF by default
        options.ExpireTimeSpan = TimeSpan.FromHours(8);
        options.SlidingExpiration = true;
        options.LoginPath = "/login";
    });
```

Die bestimmende Eigenschaft ist, dass der Cookie-Wert für JavaScript undurchsichtig ist, wenn `HttpOnly` gesetzt ist, und dass der Server genug Kontext hält (die Data-Protection-Schlüssel, optional einen Hintergrundspeicher), um ihn zu invalidieren. Der Preis ist, dass Sie CSRF erben, weil der Browser das Cookie bei seitenübergreifenden Anfragen automatisch sendet, und sich mit Antiforgery-Token dagegen verteidigen müssen.

JWT-Bearer-Authentifizierung validiert ein in sich geschlossenes Token im `Authorization`-Header. Das Token ist ein signierter (und optional verschlüsselter) Block von Claims. Es gibt keine serverseitige Sitzung: Die Validierung ist reine Signatur-plus-Claims-Rechnung, sodass beliebig viele Dienste dasselbe Token akzeptieren können, indem sie den Signierschlüssel oder den öffentlichen Schlüssel des Ausstellers kennen. Der Client ist dafür verantwortlich, das Token zu speichern und es an jede Anfrage anzuhängen.

```csharp
// .NET 11, C# 14
builder.Services
    .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.Authority = "https://login.example.com";   // for key discovery
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidIssuer = "https://login.example.com",
            ValidateAudience = true,
            ValidAudience = "my-api",
            ValidateLifetime = true,
            ValidateIssuerSigningKey = true
        };
    });
```

Diese `TokenValidationParameters` richtig hinzubekommen ist der Ort, an dem die meisten JWT-Bugs leben; wenn Sie ein Token debuggen, das das Framework ablehnt, siehe [wie Sie Aussteller, Zielgruppe und Lebensdauer eines JWT in ASP.NET Core 11 validieren](/de/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/). Die Kehrseite ist, dass Sie ein gültiges Token nicht zurücknehmen können: Sobald es signiert und in den Händen des Clients ist, wird es akzeptiert, bis `exp` überschritten ist, ganz gleich, was mit dem Benutzerkonto geschieht.

## Wann Sie sich für Cookie-Authentifizierung entscheiden sollten

- **Serverseitig gerenderte Apps: MVC, Razor Pages oder Blazor Server in .NET 11.** Der Browser ist der einzige Client, er verwaltet das Cookie für Sie, und `HttpOnly` hält die Anmeldeinformation außer Reichweite jedes injizierten Skripts. Es gibt kein Token, das JavaScript durchsickern lassen könnte.
- **Eine Single-Page-App gleichen Ursprungs, die mit ihrem eigenen Backend spricht.** Das ist der Fall, den Leute am häufigsten falsch machen. Wenn Ihre React- oder Angular-App vom selben Ursprung ausgeliefert wird und ihn aufruft, ist ein Cookie sowohl einfacher als auch sicherer, als ein JWT zu prägen und es in `localStorage` zu verstauen. Die Leitlinie der OAuth-Arbeitsgruppe für browserbasierte Apps lenkt Erstanbieter-SPAs ausdrücklich zu einem cookie-gestützten Backend-for-Frontend statt zu Token im Browser.
- **Sie brauchen sofortigen Widerruf.** Das Deaktivieren eines Benutzers, das Rotieren eines Passworts oder das Erzwingen einer globalen Abmeldung muss jetzt wirksam werden. Mit Cookies validieren Sie den Principal pro Anfrage erneut (`OnValidatePrincipal`) oder ändern den Data-Protection-Schlüssel, und die nächste Anfrage ist nicht authentifiziert. Es gibt kein Warten darauf, dass ein Token abläuft.
- **Sie verwenden ASP.NET Core Identity mit lokalen Konten.** Die Standard-UI von Identity und `SignInManager` sind cookie-basiert, und das ist der unterstützte Erstanbieter-Weg.

Die Steuer, die Sie mit Cookies akzeptieren, ist CSRF. Weil der Browser das Cookie bei seitenübergreifenden Formular-Posts sendet, brauchen Sie Antiforgery-Schutz an zustandsändernden Endpunkten. `SameSite=Strict` oder `Lax` blockiert die gängigen Fälle, und die Antiforgery-Token von ASP.NET Core schließen den Rest. Wenn diese Token nach einer Bereitstellung nicht mehr validieren, ist das üblicherweise ein Problem mit dem Data-Protection-Schlüsselbund, behandelt in [warum das Antiforgery-Token nicht entschlüsselt werden konnte](/de/2026/06/fix-the-antiforgery-token-could-not-be-decrypted-in-aspnetcore/).

## Wann Sie sich für JWT-Bearer entscheiden sollten

- **Eine REST- oder gRPC-API, die von einer mobilen oder Desktop-App konsumiert wird.** Ein nativer Client hat kein an Ihre Domäne gebundenes Cookie-Glas und kann ein Token im OS-Schlüsselbund oder sicheren Speicher ablegen, was ein sichereres Zuhause als ein Browser ist. Bearer-Token sind die natürliche Wahl.
- **Dienst-zu-Dienst-Aufrufe und Microservices.** Ein von einem zentralen Identitätsanbieter signiertes Token kann unabhängig von einem Dutzend Diensten validiert werden, die nie einen Sitzungsspeicher teilen. Das ist das Szenario, in dem Zustandslosigkeit eine Funktion und keine Belastung ist.
- **Drittanbieter-API-Zugriff, bei dem Sie den Client nicht kontrollieren.** Öffentliche APIs, Partnerintegrationen und alles, was von OAuth-2.0-Client-Credentials- oder Authorization-Code-Flows angetrieben wird, leben von Natur aus auf Bearer-Token.
- **Domänenübergreifende Aufrufe, die ein Cookie nicht sauber erreichen kann.** Wenn `app.com` `api.other.com` aufrufen muss, kämpft die Cookie-Geltung gegen Sie, während ein Bearer-Token sich nicht um den Ursprung schert. Wenn Sie einen JWT-geschützten API-Aufruf von einem Browser auf einem anderen Ursprung routen, ist der schwierige Teil üblicherweise der Preflight, nicht das Token; siehe [wie Sie CORS für eine JWT-geschützte API in ASP.NET Core 11 konfigurieren](/de/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/).

Die Steuer, die Sie mit JWTs akzeptieren, ist der Widerruf. Ein durchgesickertes oder gestohlenes Token ist gültig, bis es abläuft, daher ist die Standardabschwächung kurzlebige Access-Token (5 bis 15 Minuten) gepaart mit länger lebenden Refresh-Token, die Sie serverseitig widerrufen können. Wenn Sie Ihre eigenen Token ausstellen, überspringen Sie diese Maschinerie nicht; [wie Sie Refresh-Token in ASP.NET Core Identity implementieren](/de/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/) führt durch die Rotations- und Widerrufsteile.

## Warum "JWT in localStorage" der falsche Standard für Browser ist

Der Grund, warum dieser Vergleich wichtig ist, liegt darin, dass das beliebte SPA-Tutorial-Muster, beim Login ein JWT zu prägen und es in `localStorage` zu speichern, ein Nicht-Problem gegen ein echtes eintauscht. Eine SPA gleichen Ursprungs braucht keine Zustandslosigkeit; ihr Backend ist direkt da und kann eine Sitzung halten. Was sie im Tausch gegen das Token bekommt, ist eine per XSS exfiltrierbare Anmeldeinformation. Jedes Skript, das auf Ihrer Seite läuft, einschließlich eines, das über eine kompromittierte npm-Abhängigkeit hereingezogen wurde, kann `localStorage` lesen, das Token abgreifen und es von überall wiedergeben, bis es abläuft.

Ein Cookie mit `HttpOnly` kann von `document.cookie` überhaupt nicht gelesen werden, sodass dasselbe XSS, das ein `localStorage`-Token leersaugt, ein Cookie nicht direkt stehlen kann. Das ist der gesamte Grund, warum die Branche sich zum Backend-for-Frontend-Muster bewegte: Die SPA authentifiziert sich gegen ihr eigenes Backend mit einem sicheren, `HttpOnly`-, `SameSite`-Cookie, und das Backend hält etwaige vorgelagerte OAuth-Token serverseitig, ohne sie je an JavaScript zu übergeben. Der aktuelle IETF-Entwurf für browserbasierte Apps empfiehlt genau das, und Duendes BFF-Framework verpackt es für ASP.NET Core. Die Kurzfassung: Token gehören nur dann in den Browser, wenn es keinen Server gibt, der sie für Sie hält, was bei einer Erstanbieter-App nie der Fall ist.

## Beide Schemata in einer App betreiben

Ein Schema global zu wählen bedeutet nicht, dass Sie nur eines verwenden können. Eine gängige reale Form ist eine serverseitig gerenderte Website plus eine JSON-API im selben Host: Cookies für die Seiten, JWT für die API. Registrieren Sie beide und wählen Sie pro Endpunkt.

```csharp
// .NET 11, C# 14
builder.Services
    .AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie()
    .AddJwtBearer();   // second scheme, not the default

// Pages use the default cookie scheme:
app.MapGet("/dashboard", () => Results.Ok("hello"))
   .RequireAuthorization();

// The API explicitly requires the bearer scheme:
app.MapGet("/api/orders", () => Results.Ok(orders))
   .RequireAuthorization(new AuthorizeAttribute
   {
       AuthenticationSchemes = JwtBearerDefaults.AuthenticationScheme
   });
```

Das entscheidende Detail: Das Schema, das Sie `AddAuthentication` als Erstes übergeben, ist der Standard, und jedes `[Authorize]` ohne explizites Schema verwendet es. Endpunkte, die ein Bearer-Token akzeptieren sollen, müssen `JwtBearerDefaults.AuthenticationScheme` ausdrücklich benennen, sonst versucht das Framework, ein Cookie zu validieren, findet keins und fordert mit einer Umleitung zur Login-Seite heraus, statt `401` zurückzugeben. Diese Diskrepanz, eine API, die eine HTML-Login-Umleitung statt eines sauberen `401` zurückgibt, ist ein häufiges Symptom eines falsch konfigurierten Standard-Schemas. Eine verwandte Variante, bei der die API mit `405` statt `401` antwortet, und die breitere Klasse von "gültiges Token trotzdem abgelehnt"-Problemen sind es wert, bekannt zu sein, bevor Sie ein gemischtes Setup ausliefern: siehe [warum ein ASP.NET Core JWT 401 zurückgibt, selbst mit gültigem Token](/de/2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token/).

## Der Fallstrick, der für Sie entscheidet

Die Widerrufslatenz ist die treibende Funktion. Stellen Sie eine Frage: Wenn der Zugriff eines Benutzers abgeschnitten werden muss, wie lange können Sie tolerieren, dass die alte Anmeldeinformation noch funktioniert?

- Wenn die Antwort "null, es muss sofort stoppen" lautet (Banking, Admin-Konsolen, alles, wo ein kompromittiertes oder gekündigtes Konto eine aktive Bedrohung ist), gewinnen Cookies, weil Sie die Sitzung bei der nächsten Anfrage invalidieren können. Um dasselbe Verhalten von JWTs zu bekommen, müssen Sie eine serverseitige Sperrliste anflanschen, was genau die zustandsbehaftete Abfrage wieder einführt, der Sie mit JWTs entgehen wollten.
- Wenn die Antwort "ein paar Minuten sind in Ordnung" lautet, sind kurzlebige JWTs mit Refresh-Token akzeptabel, und Sie behalten die Zustandslosigkeit, die sie über Dienste hinweg attraktiv macht.

Die zweite treibende Funktion ist der Client. Ein Cookie ist ein Browser-Konstrukt. In dem Moment, in dem sich ein Nicht-Browser-Client authentifizieren muss, hört ein Cookie auf, natürlich zu sein, und ein Bearer-Token wird zum offensichtlichen Träger. Wenn Ihre App beide Arten von Aufrufer hat, ist das kein Unentschieden, sondern ein Signal, beide Schemata wie oben gezeigt zu betreiben, jedes an den Endpunkten, zu denen es passt.

## Die Empfehlung, neu formuliert

Für eine App, deren einziger Client ein Browser ist, einschließlich einer SPA gleichen Ursprungs, verwenden Sie Cookie-Authentifizierung: `HttpOnly`, `Secure`, `SameSite`, mit Antiforgery an zustandsändernden Endpunkten. Sie erhalten eine Anmeldeinformation, die JavaScript nicht lesen kann, und einen Widerruf, der bei der nächsten Anfrage wirksam wird, und Sie geben nichts auf, was eine Erstanbieter-Web-App tatsächlich braucht. Greifen Sie zu JWT-Bearer, wenn der Aufrufer eine mobile oder Desktop-App, ein anderer Dienst oder ein Drittanbieter ist, wo Zustandslosigkeit ein echter Vorteil ist und es keine serverseitige Sitzung gibt, auf die man sich stützen könnte. Wenn beide Arten von Client existieren, registrieren Sie beide Schemata und wählen Sie pro Endpunkt, statt eines zu zwingen, die Arbeit des anderen zu erledigen. Die Entscheidung dreht sich nicht darum, welche Technologie moderner ist; sie dreht sich darum, wer die Anmeldeinformation hält und wie schnell Sie sie wieder entziehen müssen.

## Verwandt

- [Wie Sie Aussteller, Zielgruppe und Lebensdauer eines JWT in ASP.NET Core 11 validieren](/de/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/)
- [Warum ein ASP.NET Core JWT 401 zurückgibt, selbst mit gültigem Token](/de/2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token/)
- [Wie Sie CORS für eine JWT-geschützte API in ASP.NET Core 11 konfigurieren](/de/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/)
- [Wie Sie Refresh-Token in ASP.NET Core Identity implementieren](/de/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/)
- [Warum das Antiforgery-Token in ASP.NET Core nicht entschlüsselt werden konnte](/de/2026/06/fix-the-antiforgery-token-could-not-be-decrypted-in-aspnetcore/)

## Quellen

- [Overview of ASP.NET Core authentication (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/?view=aspnetcore-10.0)
- [Use cookie authentication without ASP.NET Core Identity (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/cookie?view=aspnetcore-10.0)
- [Authentication and authorization in minimal APIs / JWT bearer (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/configure-jwt-bearer-authentication?view=aspnetcore-10.0)
- [Prevent Cross-Site Request Forgery (XSRF/CSRF) attacks (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/security/anti-request-forgery?view=aspnetcore-10.0)
- [OAuth 2.0 for Browser-Based Apps (IETF draft)](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-browser-based-apps)
- [Securing SPAs using the BFF Pattern (Duende Software)](https://duendesoftware.com/blog/20210326-bff)
