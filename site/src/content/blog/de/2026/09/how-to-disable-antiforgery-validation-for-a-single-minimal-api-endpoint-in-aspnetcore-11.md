---
title: "So deaktivieren Sie die Antiforgery-Validierung für einen einzelnen Minimal-API-Formularendpunkt in ASP.NET Core 11"
description: "Rufen Sie .DisableAntiforgery() auf dem einen Endpunkt oder auf einer MapGroup auf. In ASP.NET Core 11 nimmt das den Endpunkt sowohl aus der Token-Middleware als auch aus der neuen automatischen CSRF-Prüfung heraus. Gemessene Matrix, Fallen bei der Rangfolge und engere Alternativen."
pubDate: 2026-09-22
template: how-to
tags:
  - "aspnetcore"
  - "dotnet-11"
  - "minimal-apis"
  - "security"
  - "csrf"
lang: "de"
translationOf: "2026/09/how-to-disable-antiforgery-validation-for-a-single-minimal-api-endpoint-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-09-22
---

**Kurze Antwort:** Hängen Sie `.DisableAntiforgery()` an den einen `MapPost`-Aufruf an (oder an eine `MapGroup`, die nur Machine-to-Machine-Endpunkte enthält). In ASP.NET Core 11 nimmt dieser eine Aufruf den Endpunkt aus **beiden** Schichten heraus, die einen Formular-Post ablehnen können: der tokenbasierten `UseAntiforgery()`-Middleware und der neuen automatischen Cross-Origin-CSRF-Prüfung, die `WebApplication` für Sie einfügt. `[RequireAntiforgeryToken(false)]` auf dem Handler bewirkt dasselbe. Greifen Sie nicht zum app-weiten Schalter `DisableCsrfProtection`, um einen einzelnen Endpunkt zu reparieren: In einer App, die nie `UseAntiforgery()` aufruft, macht er aus jedem anderen Formularendpunkt einen `500`.

Alles Folgende wurde mit dem .NET 11 RC 1 SDK gemessen (`11.0.100-rc.1.26425.128`, ASP.NET Core `11.0.0-rc.1`), mit einem Lauf auf .NET 10.0.10 zum Vergleich. Die Anfragematrix, die Fallen bei der Rangfolge und die engeren Alternativen sind der Teil, den die Dokumentation Sie selbst herausfinden lässt.

## Warum ein Formularendpunkt unerwartet Anfragen ablehnt

Seit .NET 8 erhält jeder Minimal-API-Handler mit einem formulargebundenen Parameter (`[FromForm]`, `IFormFile`, `IFormCollection`) automatisch Antiforgery-Metadaten. Sie sehen das in `RequestDelegateFactory.InferAntiforgeryMetadata`: Wenn die Factory einen Parameter aus dem Formular bindet, fügt sie dem Endpunkt ein `IAntiforgeryMetadata` mit `RequiresValidation = true` hinzu. Sie haben nie ein Attribut geschrieben; der Parametertyp hat es für Sie erledigt.

Was diese Metadaten liest, hat sich in .NET 11 geändert.

- **.NET 8 bis 10**: Nur `app.UseAntiforgery()` reagiert darauf. Haben Sie es nie aufgerufen, wirft die Endpunkt-Middleware `InvalidOperationException: Endpoint HTTP: POST /protected contains anti-forgery metadata, but a middleware was not found that supports anti-forgery.` und jede Anfrage ist ein `500`. Haben Sie es aufgerufen, ist jeder Post ohne gültiges Token (und dessen Cookie) ein `400`.
- **.NET 11**: `WebApplication` fügt nach dem Routing zusätzlich automatisch eine `CsrfProtectionMiddleware` ein (hinzugekommen in Preview 6, siehe [ASP.NET Core 11 aktiviert automatischen CSRF-Schutz](/de/2026/07/aspnetcore-11-automatic-csrf-protection-fetch-metadata-preview-6/)). Sie liest dieselben Metadaten, prüft `Sec-Fetch-Site` und `Origin` und hält ein Urteil in `IAntiforgeryValidationFeature` fest. Der Formular-Binder setzt dieses Urteil dann mit einem `400` durch.

In .NET 11 kann ein Formular-Post also auf zwei Arten abgelehnt werden, und sie treffen unterschiedliche Clients. Die Token-Middleware lehnt alles ohne Token ab, einschließlich curl und der Server Ihres Zahlungsanbieters. Die CSRF-Prüfung lässt Nicht-Browser-Clients durch, lehnt aber Cross-Origin-Posts aus dem Browser ab. Der klassische Fall ist eine Drittanbieterseite, die ein HTML-Formular an Sie zurücksendet (eine gehostete Zahlungsseite, ein Callback im SAML-Stil, ein "Senden an"-Formular eines Partners).

## Was jeder Client tatsächlich bekommt

Ich habe eine Test-App mit fünf Endpunkten gebaut und jeden mit vier Anfrageformen in vier Pipeline-Konfigurationen aufgerufen. "plain" ist curl ohne Browser-Header, "cross-site" sendet `Sec-Fetch-Site: cross-site` plus einen fremden `Origin`, "same-origin" sendet `Sec-Fetch-Site: same-origin`, und "nur fremder Origin" ahmt einen alten Browser nach, der `Origin`, aber keine Fetch Metadata sendet.

```csharp
// .NET 11 RC 1, ASP.NET Core 11.0.0-rc.1
app.MapPost("/protected", ([FromForm] string name) => $"hello {name}");

app.MapPost("/disabled", ([FromForm] string name) => $"hello {name}")
   .DisableAntiforgery();

app.MapPost("/attr",
    [RequireAntiforgeryToken(false)] ([FromForm] string name) => $"hello {name}");

var hooks = app.MapGroup("/hooks").DisableAntiforgery();
hooks.MapPost("/payments", ([FromForm] string name) => $"hello {name}");

app.MapPost("/manual", async (HttpRequest req) =>
    $"hello {(await req.ReadFormAsync())["name"]}");
```

Standard-Pipeline von .NET 11 (kein `AddAntiforgery`, kein `UseAntiforgery`), Production-Umgebung:

| Endpunkt | plain | cross-site | same-origin | nur fremder Origin |
|---|---|---|---|---|
| `/protected` | 200 | **400** | 200 | **400** |
| `/disabled` | 200 | 200 | 200 | 200 |
| `/attr` | 200 | 200 | 200 | 200 |
| `/hooks/payments` | 200 | 200 | 200 | 200 |
| `/manual` | 200 | 200 | 200 | 200 |

Mit `builder.Services.AddAntiforgery()` und `app.UseAntiforgery()` (was Blazor- und MVC-Apps, die von .NET 8-10 aktualisiert wurden, meist haben):

| Endpunkt | plain | cross-site | same-origin | nur fremder Origin |
|---|---|---|---|---|
| `/protected` | **400** | **400** | **400** | **400** |
| `/disabled`, `/attr`, `/hooks/payments` | 200 | 200 | 200 | 200 |

Mit `DisableCsrfProtection=true` und ohne `UseAntiforgery()`: `/protected` ist für jede Anfrage ein **500**, genau wie .NET 10.0.10 ohne `UseAntiforgery()`, was ich ebenfalls gemessen habe. Die ausgenommenen Endpunkte bleiben bei 200.

Die Server-Logs verraten, welche Schicht abgelehnt hat. Die CSRF-Schicht protokolliert `Cross-origin CSRF protection marked request POST /protected from origin 'https://evil.example' as invalid.` auf `Debug` unter `Microsoft.AspNetCore.Antiforgery.CsrfProtectionMiddleware`, und der Binder protokolliert danach `Antiforgery validation failed when reading parameter "string name" from the request body as form.` mit einer inneren `CsrfValidationException`. Die Token-Schicht erzeugt dieselbe Binder-Meldung mit einer inneren `AntiforgeryValidationException: The required antiforgery cookie ".AspNetCore.Antiforgery.<suffix>" is not present.` In Production ist der Antworttext leer. Schalten Sie also `Debug` für `Microsoft.AspNetCore.Http.RequestDelegateFactory` und `Microsoft.AspNetCore.Antiforgery` ein, wenn Sie einem rätselhaften `400` nachjagen.

## Deaktivierung für einen Endpunkt, Schritt für Schritt

1. Stellen Sie sicher, dass der Endpunkt wirklich kein Browser-Cookie-Endpunkt ist. Die einzigen sicheren Kandidaten sind Aufrufer, die sich auf andere Weise authentifizieren: ein per HMAC signierter Webhook, ein API-Schlüssel, ein Bearer-Token, mTLS. Wenn der Browser eines angemeldeten Benutzers dorthin posten kann und der Handler anhand seiner Cookie-Identität handelt, behalten Sie den Schutz bei.
2. Hängen Sie `.DisableAntiforgery()` an diesen `MapPost` an. Es ist eine Erweiterung auf jedem `IEndpointConventionBuilder` in `Microsoft.AspNetCore.Builder`, in einem Webprojekt ist also kein zusätzliches `using` nötig.
3. Ersetzen Sie den gerade entfernten Schutz durch den eigenen Nachweis des Aufrufers. Bei einem formularkodierten Webhook ist das eine Signaturprüfung über den rohen Body, erledigt in einer Middleware, damit sie läuft, bevor irgendetwas das Formular bindet.
4. Testen Sie erneut mit der Cross-Site-Anfrageform von oben (`-H 'Sec-Fetch-Site: cross-site' -H 'Origin: https://other.example'`) und mit einfachem curl, damit Sie wissen, dass beide Schichten aus dem Weg sind.

Hier das Ganze für einen Anbieter, der `application/x-www-form-urlencoded` postet und den rohen Body mit HMAC-SHA256 signiert:

```csharp
// .NET 11 RC 1, ASP.NET Core 11.0.0-rc.1
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

var secret = Encoding.UTF8.GetBytes(app.Configuration["Sms:WebhookSecret"]!);

// Verify the signature over the raw body before anything binds the form.
app.UseWhen(ctx => ctx.Request.Path.StartsWithSegments("/webhooks/sms"), branch =>
    branch.Use(async (ctx, next) =>
    {
        ctx.Request.EnableBuffering();
        using var ms = new MemoryStream();
        await ctx.Request.Body.CopyToAsync(ms);
        ctx.Request.Body.Position = 0;

        var expected = Convert.ToHexStringLower(HMACSHA256.HashData(secret, ms.ToArray()));
        var actual = ctx.Request.Headers["X-Signature"].ToString();

        if (!CryptographicOperations.FixedTimeEquals(
                Encoding.ASCII.GetBytes(expected), Encoding.ASCII.GetBytes(actual)))
        {
            ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return;
        }

        await next(ctx);
    }));

app.MapPost("/webhooks/sms", ([FromForm] SmsStatus status) =>
        Results.Ok($"{status.MessageId}: {status.Status}"))
   .DisableAntiforgery();

app.Run();

record SmsStatus(string MessageId, string Status);
```

Gemessen: Ein korrekt signierter Post lieferte 200, sowohl als einfaches curl als auch mit den Cross-Site-Browser-Headern, und eine falsche Signatur lieferte 401.

Mein erster Entwurf hat diese Prüfung stattdessen in einen Endpunktfilter gesteckt, und er ist bei jeder signierten Anfrage gescheitert. Wenn ein Endpunktfilter läuft, ist der `[FromForm]`-Parameter bereits gebunden, der Formular-Reader hat den Anfragestream geleert, und `EnableBuffering` hat an dieser Stelle nichts mehr zu puffern: Der Filter hat **0 Bytes** gehasht. Signaturprüfungen über den rohen Body gehören in eine Middleware, einer der konkreten Fälle in [Endpunktfilter vs. Middleware](/de/2026/07/endpoint-filters-vs-middleware-in-aspnetcore-11/). Ein Endpunktfilter ist für reine Header-Prüfungen wie einen API-Schlüssel in Ordnung.

## Die Attributform, für Handler in Methoden

Wenn Ihre Handler statische Methoden statt Lambdas sind, liest sich das Attribut besser und übersteht Refactorings, die das Mapping verschieben:

```csharp
// .NET 11 RC 1
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Mvc;

app.MapPost("/webhooks/payments", PaymentHooks.Handle);

static class PaymentHooks
{
    [RequireAntiforgeryToken(false)]
    public static IResult Handle([FromForm] string eventId) => Results.Ok(eventId);
}
```

`RequireAntiforgeryTokenAttribute` implementiert `IAntiforgeryMetadata` direkt, und beide Middlewares fragen den Endpunkt nach `GetMetadata<IAntiforgeryMetadata>()`, daher ist das Ergebnis identisch mit `.DisableAntiforgery()`. Für MVC-Controller ist das Äquivalent `[IgnoreAntiforgeryToken]`; der `AntiforgeryMiddlewareAuthorizationFilter` in .NET 11 respektiert das Urteil beider Middlewares.

## Deaktivierung für eine Gruppe von Webhooks

Wenn Sie mehrere Anbieter-Callbacks haben, legen Sie sie unter ein Präfix und nehmen Sie die Gruppe einmal aus:

```csharp
// .NET 11 RC 1
var hooks = app.MapGroup("/hooks").DisableAntiforgery();
hooks.MapPost("/payments", ([FromForm] string name) => Results.Ok());
hooks.MapPost("/sms", ([FromForm] string name) => Results.Ok());
```

So bleibt die Sicherheitsentscheidung an einer sichtbaren Stelle, statt über Dateien verstreut zu sein, was überhaupt das Hauptargument dafür ist, [Minimal-API-Endpunkte mit MapGroup zu organisieren](/de/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/).

## Fallen bei der Rangfolge, auf die ich im Test gestoßen bin

**Ein Opt-out auf Gruppenebene schlägt ein Opt-in auf Endpunktebene.** Ich hatte erwartet, dass dies den Schutz für einen Endpunkt innerhalb der deaktivierten Gruppe wieder einschaltet:

```csharp
// .NET 11 RC 1: does NOT re-enable validation
hooks.MapPost("/strict", ([FromForm] string name) => $"hello {name}")
     .WithMetadata(new RequireAntiforgeryTokenAttribute());
```

Tut es nicht. `/hooks/strict` lieferte für die Cross-Site-Anfrage in beiden Pipeline-Modi 200. Der Grund liegt in `DisableAntiforgery` selbst: Es registriert seine Metadaten mit `builder.Finally(...)`, das nach den eigenen Konventionen des Endpunkts läuft, und `GetMetadata<T>()` gibt das letzte passende Element zurück. Das "nicht erforderlich" der Gruppe landet zuletzt und gewinnt. Wenn ein Endpunkt unter einem Präfix geschützt bleiben muss, deaktivieren Sie nicht auf Gruppenebene; deaktivieren Sie stattdessen pro Endpunkt oder teilen Sie das Präfix in zwei Gruppen auf.

**Dieselbe `Finally`-Reihenfolge ist der Grund, warum `.DisableAntiforgery()` immer gegen die abgeleiteten Metadaten gewinnt.** Der Formular-Binder fügt `RequiresValidation = true` beim Aufbau des Endpunkts hinzu; der `Finally`-Callback fügt danach `false` hinzu. Die Reihenfolge, in der Sie Aufrufe verketten, spielt keine Rolle.

**Handler, die das Formular von Hand lesen, bekommen überhaupt keinen Schutz.** Der Endpunkt `/manual` oben liest `req.ReadFormAsync()` ohne formulargebundenen Parameter, daher werden keine Metadaten abgeleitet und keine der beiden Middlewares schaut ihn sich an: Cross-Site-Posts bekamen in jedem Modus 200. Wenn Sie dort Schutz wollen, müssen Sie sich mit `.WithMetadata(new RequireAntiforgeryTokenAttribute())` dafür entscheiden. Dann ändert sich aber das Fehlerverhalten: Ist das Urteil ungültig, weigert sich `FormFeature`, den Body zu lesen, und wirft `InvalidOperationException: This form is being accessed with a failed antiforgery validation. Validate the IAntiforgeryValidationFeature on the request before reading from the form.`, was ein 500 ist, kein 400. Prüfen Sie das Feature zuerst selbst:

```csharp
// .NET 11 RC 1
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Http.Features;

app.MapPost("/manual-protected", async (HttpContext ctx) =>
    {
        if (ctx.Features.Get<IAntiforgeryValidationFeature>() is { IsValid: false })
            return Results.BadRequest();

        var form = await ctx.Request.ReadFormAsync();
        return Results.Ok(form["name"].ToString());
    })
    .WithMetadata(new RequireAntiforgeryTokenAttribute());
```

**`DisableCsrfProtection` ist kein Werkzeug pro Endpunkt.** Es entfernt die automatisch eingefügte Middleware für die gesamte App. Diese Middleware ist auch das, was die Prüfung "a middleware was not found that supports anti-forgery" für Apps erfüllt, die nie `UseAntiforgery()` aufrufen. Wer den Schalter umlegt, um einen Webhook zu reparieren, macht also jeden anderen Formularendpunkt mit einem 500 kaputt (oben gemessen). Die Dokumentation nennt ihn einen Notausgang; behandeln Sie ihn auch so.

## Engere Alternativen, bevor Sie etwas deaktivieren

Deaktivieren ist für signierte Server-zu-Server-Aufrufe richtig. Für Browser-Traffic gibt es zwei engere Optionen.

**Einem bestimmten Cross-Origin-Aufrufer über CORS vertrauen.** Die Standardimplementierung von `ICsrfProtection` zieht die CORS-Richtlinie heran, die für den Endpunkt gilt: Wenn der `Origin` der Anfrage von einer benannten oder der Standardrichtlinie erlaubt ist, wird der Post akzeptiert, auch wenn `Sec-Fetch-Site` gleich `cross-site` ist. `AllowAnyOrigin` wird absichtlich ignoriert.

```csharp
// .NET 11 RC 1
builder.Services.AddCors(o => o.AddPolicy("partner",
    p => p.WithOrigins("https://pay.partner.example")));

var app = builder.Build();
app.UseCors();

app.MapPost("/partner-callback", ([FromForm] string orderId) => Results.Ok(orderId))
   .RequireCors("partner");
```

Gemessen auf der Standard-Pipeline: Der Partner-Origin bekam 200, ein fremder Origin und eine `same-site`-Schwesterdomain bekamen weiterhin 400, einfaches curl bekam 200. Zwei Einschränkungen. Ohne `app.UseCors()` wirft der Endpunkt `contains CORS metadata, but a middleware was not found that supports CORS` (500). Und dies lockert nur die Fetch-Metadata-Schicht: Mit `UseAntiforgery()` in der Pipeline läuft die Token-Validierung danach, überschreibt das Urteil, und der Partner-Post war wieder ein 400. Wenn Sie CORS bereits mit Cookies oder JWTs kombinieren, behandelt der Beitrag zum [CORS-Setup für eine JWT-geschützte API](/de/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/) die Richtlinienseite.

**Callbacks von Identitätsanbietern dem Framework überlassen.** OpenID Connect `response_mode=form_post` und WS-Federation-Callbacks sind konstruktionsbedingt Cross-Site-Formular-Posts. In .NET 11 unterdrücken die Remote-Authentifizierungshandler ein ungültiges Urteil, solange sie den Callback-Pfad besitzen (`RemoteAuthenticationAntiforgery` im Quellcode), weil der Parameter `state` und das Korrelations-Cookie sie bereits schützen. Sie brauchen kein `.DisableAntiforgery()` auf `/signin-oidc` und können es dort ohnehin nicht setzen, da der Handler eine Middleware ist, kein Endpunkt.

## Stolperfallen beim Upgrade von .NET 8, 9 oder 10

- **Apps, die bereits `UseAntiforgery()` aufrufen, sehen für Same-Origin-Traffic keine Änderung**, weil die Token-Validierung maßgeblich ist und das CSRF-Urteil überschreibt. Ihre vorhandenen `.DisableAntiforgery()`-Aufrufe funktionieren unverändert weiter.
- **Apps, die nie `UseAntiforgery()` aufgerufen haben, werfen in .NET 11 keine 500er mehr** auf Formularendpunkten (die CSRF-Middleware erfüllt die Endpunktprüfung), geben aber für Cross-Origin-Posts aus dem Browser nun 400 zurück. Das kann wie eine zufällige Regression in einem Formular aussehen, an das eine Schwester-Subdomain postet, da auch `same-site` abgelehnt wird.
- **Ein 400 von einem Formularendpunkt ist nicht immer Antiforgery.** Ein fehlender oder falscher `Content-Type` ergibt [415 Unsupported Media Type](/de/2026/07/fix-415-unsupported-media-type-from-a-minimal-api-endpoint-in-aspnetcore-11/), und Fehler in der Binding-Form ergeben Nullwerte, wie bei [dem `[FromForm]`-Dictionary, das immer null ist](/de/2026/08/fix-fromform-dictionary-is-always-null-in-a-minimal-api/). Prüfen Sie die Log-Kategorie, bevor Sie etwas deaktivieren.
- **Token-Fehler nach einem Deployment sind ein anderer Bug.** Wenn Same-Origin-Formulare erst nach dem Hochskalieren oder einem Neustart scheitern, haben Sie es mit Data-Protection-Schlüsseln zu tun, behandelt in [das Antiforgery-Token konnte nicht entschlüsselt werden](/de/2026/06/fix-the-antiforgery-token-could-not-be-decrypted-in-aspnetcore/), nicht mit einem fehlenden Opt-out.
- **Kurzgeschlossene Routen können keine erforderlichen Antiforgery-Metadaten tragen.** `.ShortCircuit()` auf einem Formularendpunkt, der weiterhin Validierung verlangt, ist zur Anfragezeit ein 500 (`contains anti-forgery metadata, but this endpoint is marked with short circuit and it will execute on Routing Middleware`). Sobald der Endpunkt deaktiviert ist, entfällt die Prüfung.

## Verwandte Beiträge

- [ASP.NET Core 11 Preview 6 aktiviert automatischen CSRF-Schutz](/de/2026/07/aspnetcore-11-automatic-csrf-protection-fetch-metadata-preview-6/)
- [So organisieren Sie Minimal-API-Endpunkte mit MapGroup in ASP.NET Core 11](/de/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [Endpunktfilter vs. Middleware in ASP.NET Core 11](/de/2026/07/endpoint-filters-vs-middleware-in-aspnetcore-11/)
- [Lösung: "415 Unsupported Media Type" von einem Minimal-API-Endpunkt in ASP.NET Core 11](/de/2026/07/fix-415-unsupported-media-type-from-a-minimal-api-endpoint-in-aspnetcore-11/)
- [Lösung: The antiforgery token could not be decrypted in ASP.NET Core](/de/2026/06/fix-the-antiforgery-token-could-not-be-decrypted-in-aspnetcore/)

## Quellen

- [Prevent Cross-Site Request Forgery (XSRF/CSRF) attacks in ASP.NET Core](https://learn.microsoft.com/aspnet/core/security/anti-request-forgery) (MS Learn, Abschnitte zum automatischen CSRF-Schutz und zum Opt-out pro Endpunkt)
- [ASP.NET Core in .NET 11 Preview 6 release notes: automatic cross-origin (CSRF) protection](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/aspnetcore.md)
- [dotnet/aspnetcore #66585](https://github.com/dotnet/aspnetcore/pull/66585) und [#67082](https://github.com/dotnet/aspnetcore/pull/67082), die PRs zur CSRF-Middleware
- Quellcode beim Tag `v11.0.0-rc.1.26425.128`: [`CsrfProtectionMiddleware.cs`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.1.26425.128/src/DefaultBuilder/src/Internal/CsrfProtectionMiddleware.cs), [`DefaultCsrfProtection.cs`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.1.26425.128/src/DefaultBuilder/src/Internal/DefaultCsrfProtection.cs), [`RoutingEndpointConventionBuilderExtensions.cs`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.1.26425.128/src/Http/Routing/src/Builder/RoutingEndpointConventionBuilderExtensions.cs), [`RequireAntiforgeryTokenAttribute.cs`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.1.26425.128/src/Antiforgery/src/RequireAntiforgeryTokenAttribute.cs)
