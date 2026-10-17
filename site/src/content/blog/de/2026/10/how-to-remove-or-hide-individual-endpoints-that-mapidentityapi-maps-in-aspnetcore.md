---
title: "Einzelne von MapIdentityApi abgebildete Endpunkte in ASP.NET Core entfernen oder ausblenden"
description: "MapIdentityApi<TUser>() bildet zehn Endpunkte ab und bietet keinen Schalter, um einen davon auszulassen. Hier sind vier gemessene Wege unter .NET 11: einen Endpunkt aus OpenAPI ausblenden, ihn 404 zurückgeben lassen, ihn überlagern oder ihn komplett aus dem Routing entfernen, plus die /confirmEmail-Falle, die die Registrierung in einen 500-Fehler verwandelt."
pubDate: 2026-10-17
template: how-to
tags:
  - "aspnetcore"
  - "aspnetcore-11"
  - "identity"
  - "minimal-apis"
  - "openapi"
  - "dotnet-11"
lang: "de"
translationOf: "2026/10/how-to-remove-or-hide-individual-endpoints-that-mapidentityapi-maps-in-aspnetcore"
translatedBy: "claude"
translationDate: 2026-10-17
---

**Kurzantwort:** `MapIdentityApi<TUser>()` hat keinen Parameter zur Auswahl von Endpunkten, und das gilt auch in .NET 11 RC 2 weiterhin. Zurück erhalten Sie einen `IEndpointConventionBuilder`, dessen Konventionen für jeden Endpunkt mit dem finalen Routenmuster ausgeführt werden. Sie können `/register` oder `/manage/2fa` also anhand des Musters erkennen. Um einen Endpunkt nur aus dem OpenAPI-Dokument auszublenden, fügen Sie in einer Konvention `ExcludeFromDescriptionAttribute` hinzu. Um ihn unbenutzbar zu machen, ersetzen Sie zusätzlich `EndpointBuilder.RequestDelegate` durch ein Delegate, das 404 zurückgibt. Um ihn vollständig aus dem Routing zu entfernen, bilden Sie Identity in einen privaten `IEndpointRouteBuilder` ab und stellen dessen Endpunkte über eine filternde `EndpointDataSource` wieder bereit (etwa 30 Zeilen, unten gezeigt). Entfernen Sie `/confirmEmail` niemals, solange `/register` oder `/resendConfirmationEmail` aktiv sind: Beide werfen `NotSupportedException` und liefern 500.

Alles Folgende wurde unter macOS mit SDK 11.0.100-rc.1.26425.128, `Microsoft.AspNetCore.Identity.EntityFrameworkCore` 11.0.0-rc.1.26425.128 und einem EF-Core-InMemory-Store ausgeführt. Ich habe `IdentityApiEndpointRouteBuilderExtensions.cs` zwischen den Tags `v8.0.0`, `v11.0.0-rc.1.26425.128` und `v11.0.0-rc.2.26504.105` verglichen: Die Routenliste ist in allen dreien identisch, und die Datei hat sich zwischen RC 1 und RC 2 nicht geändert. Die Techniken gelten also für .NET 8, 9, 10 und 11.

## Warum es keine eingebaute Möglichkeit gibt, einen Endpunkt auszulassen

`MapIdentityApi<TUser>()` ist eine einzelne Erweiterungsmethode, die eine leere Routengruppe erzeugt und alles darin abbildet:

| Methode | Route | Erfordert Authentifizierung |
| --- | --- | --- |
| POST | `/register` | nein |
| POST | `/login` | nein |
| POST | `/refresh` | nein |
| GET | `/confirmEmail` | nein |
| POST | `/resendConfirmationEmail` | nein |
| POST | `/forgotPassword` | nein |
| POST | `/resetPassword` | nein |
| POST | `/manage/2fa` | ja |
| GET | `/manage/info` | ja |
| POST | `/manage/info` | ja |

Der Quellcode verpackt die Gruppe anschließend in einen privaten Typ `IdentityEndpointsConventionBuilder`, mit einem Kommentar, dass dies geschieht, "to avoid a potential future behavioral breaking change". Den Rückgabewert können Sie nicht zurück in `RouteGroupBuilder` casten, und die Handler sind Lambdas innerhalb der Methode, sodass Sie sie auch nicht selbst aufrufen können.

Die Anfrage, die Methode aufzuteilen, ist seit 2024 als [dotnet/aspnetcore#55792](https://github.com/dotnet/aspnetcore/issues/55792) offen ("Split MapIdentityApi<TUser>() into multiple APIs and allow selective end points to be enabled"), und das allgemeinere [dotnet/aspnetcore#50303](https://github.com/dotnet/aspnetcore/issues/50303) zur Erweiterbarkeit reicht bis zu den .NET-8-Previews zurück. Beide liegen im Backlog-Meilenstein. Bis eines davon ausgeliefert wird, müssen die üblichen Gründe (öffentliche Registrierung muss aus sein, 2FA wird anderswo gehandhabt, das OpenAPI-Dokument soll das Zurücksetzen von Passwörtern nicht bewerben) alle von außen gelöst werden.

## Das Test-Setup

Dies ist die App, in die sich jede der folgenden Varianten einklinkt. Die Identity-Endpunkte liegen unter `/account`, weil die meisten echten Apps sie so einhängen und weil das beeinflusst, wie Sie Routen abgleichen:

```csharp
// .NET 11 RC 1, Microsoft.AspNetCore.Identity.EntityFrameworkCore 11.0.0-rc.1.26425.128
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddDbContext<AppDbContext>(o => o.UseInMemoryDatabase("ids"));
builder.Services.AddAuthorization();
builder.Services.AddIdentityApiEndpoints<IdentityUser>()
    .AddEntityFrameworkStores<AppDbContext>();
builder.Services.AddOpenApi();

var app = builder.Build();
app.MapOpenApi();

var account = app.MapGroup("/account");
account.MapIdentityApi<IdentityUser>();

app.Run();

class AppDbContext(DbContextOptions<AppDbContext> options)
    : IdentityDbContext<IdentityUser>(options);
```

Ohne Änderungen listet `/openapi/v1.json` alle zehn Routen unter `/account`, `POST /account/register` liefert 200, und ein anonymes `POST /account/manage/2fa` liefert 401.

Ein Detail ist für jede der folgenden Techniken wichtig: Innerhalb einer Konvention ist `RouteEndpointBuilder.RoutePattern.RawText` das **finale** Muster, einschließlich des Gruppenpräfixes. Wenn Sie es aus einer Konvention protokollieren, erscheint `/account/register`, `/account/manage/2fa` und so weiter, nicht `/register`. Identity selbst verlässt sich darauf, wenn es den Confirm-Email-Endpunkt benennt. Gleichen Sie deshalb mit `EndsWith` ab oder vergleichen Sie gegen den vollständigen Pfad mit Präfix:

```csharp
// .NET 11 RC 1
string[] blocked = ["/register", "/manage/2fa"];

bool IsBlocked(EndpointBuilder b) =>
    b is RouteEndpointBuilder rb &&
    blocked.Any(p => rb.RoutePattern.RawText!.EndsWith(p, StringComparison.OrdinalIgnoreCase));
```

## Option 1: Einen Endpunkt nur aus dem OpenAPI-Dokument ausblenden

Wenn der Endpunkt weiter funktionieren, aber nicht in Ihrem veröffentlichten Vertrag stehen soll (üblich bei `/refresh` oder `/manage/info` in einem öffentlichen API-Dokument), fügen Sie dieselben Metadaten hinzu, die `.ExcludeFromDescription()` hinzufügt:

```csharp
// .NET 11 RC 1
account.MapIdentityApi<IdentityUser>().Add(b =>
{
    if (IsBlocked(b))
        b.Metadata.Add(new ExcludeFromDescriptionAttribute());
});
```

Gemessenes Ergebnis: `/account/register` und `/account/manage/2fa` verschwinden aus `/openapi/v1.json`, und `POST /account/register` liefert weiterhin 200. Das ist der Zweck dieser Option und zugleich ihre Grenze. Ausblenden ist Dokumentation, keine Zugriffskontrolle. Wer die Identity-Dokumentation gelesen hat, weiß, dass die Route existiert.

`ExcludeFromDescriptionAttribute` liegt in `Microsoft.AspNetCore.Routing` und implementiert `IExcludeFromDescriptionMetadata`, das sowohl der eingebaute Generator `Microsoft.AspNetCore.OpenApi` als auch der API Explorer von Swashbuckle berücksichtigen. Wenn Sie das alles an einer Stelle halten möchten, können Sie dieselbe Filterung in einem Dokument-Transformer vornehmen, wie im [Beitrag zu OpenAPI-Operation- und Schema-Transformern](/de/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/) gezeigt. Der Metadaten-Ansatz ist aber einfacher und deckt auch andere API-Explorer-Consumer ab.

## Option 2: Die Route behalten, aber 404 zurückgeben lassen

Um einen Endpunkt tatsächlich abzuschalten, ersetzen Sie in derselben Konvention sein Request Delegate. Konventionen erhalten den `EndpointBuilder`, bevor der `RouteEndpoint` gebaut wird, und `RequestDelegate` ist eine setzbare Eigenschaft:

```csharp
// .NET 11 RC 1
account.MapIdentityApi<IdentityUser>().Add(b =>
{
    if (!IsBlocked(b)) return;

    b.Metadata.Add(new ExcludeFromDescriptionAttribute());
    b.RequestDelegate = ctx =>
    {
        ctx.Response.StatusCode = StatusCodes.Status404NotFound;
        return Task.CompletedTask;
    };
});
```

Gemessenes Ergebnis: `POST /account/register` liefert 404, beide Routen sind aus dem OpenAPI-Dokument verschwunden, und jeder andere Endpunkt verhält sich wie zuvor. Dasselbe Ergebnis erhielt ich mit `.Finally(...)` statt `.Add(...)`. `Finally`-Konventionen laufen nach allen anderen Konventionen, was die sicherere Wahl ist, falls etwas anderes in Ihrer Pipeline ebenfalls `RequestDelegate` anfasst.

Der Haken: Der Endpunkt existiert für Routing und Autorisierung weiterhin. Er behält alle seine Metadaten, einschließlich des `RequireAuthorization()`, das Identity auf die Gruppe `/manage` setzt. Die Autorisierungs-Middleware läuft vor dem Delegate des Endpunkts, daher liefert ein anonymes `POST /account/manage/2fa` weiterhin **401**, nicht 404. Nur authentifizierte Aufrufer erreichen Ihr 404. Wenn das Ziel lautet "nicht verraten, dass es existiert", ist dieser Unterschied von außen sichtbar.

Ein [Endpoint Filter](/de/2026/07/how-to-add-an-endpoint-filter-to-a-minimal-api-in-aspnetcore-11/) führt zum selben Ziel, weil `AddEndpointFilter` auf jedem `IEndpointConventionBuilder` funktioniert:

```csharp
// .NET 11 RC 1
account.MapIdentityApi<IdentityUser>().AddEndpointFilter(async (ctx, next) =>
{
    var route = (ctx.HttpContext.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText ?? "";
    if (blocked.Any(p => route.EndsWith(p))) return Results.NotFound();
    return await next(ctx);
});
```

Auch dieser lieferte 404 für `/account/register`, ist hier aber eindeutig schlechter: Der Filter läuft bei jeder Identity-Anfrage, die Endpunkte bleiben im OpenAPI-Dokument, sofern Sie nicht zusätzlich die Metadaten hinzufügen, und das Model Binding des Anfragekörpers hat bereits stattgefunden, wenn der Filter läuft. Der [Vergleich von Endpoint Filters und Middleware](/de/2026/07/endpoint-filters-vs-middleware-in-aspnetcore-11/) erklärt diese Reihenfolge ausführlicher. Verwenden Sie den Delegate-Austausch.

## Option 3: Die Route mit einem Endpunkt höherer Priorität überlagern

Viele Antworten im Netz schlagen vor, einen eigenen Endpunkt auf derselben Route abzubilden. Naiv umgesetzt, mit `account.MapPost("/register", () => Results.NotFound())` nach `MapIdentityApi`, bewirkt das nichts Nützliches: Ich erwartete eine `AmbiguousMatchException`, aber ein JSON-`POST /account/register` lieferte weiterhin 200 vom Handler von Identity. Der Endpunkt von Identity bindet einen `[FromBody]`-Parameter und trägt daher `application/json`-Accepts-Metadaten, und die Content-Type-Matcher-Policy stuft ihn über Ihrem Endpunkt ein, der nichts deklariert. Ihr Endpunkt läuft stillschweigend nie. Geben Sie ihm einen niedrigeren `Order`, und der Matcher bevorzugt ihn, bevor irgendeine dieser Auflösungen greift:

```csharp
// .NET 11 RC 1
account.MapIdentityApi<IdentityUser>();
account.MapPost("/register", () => Results.NotFound())
    .WithOrder(-1)
    .ExcludeFromDescription();
```

Gemessenes Ergebnis: `POST /account/register` liefert 404, und die Endpunktliste enthält nun sowohl `POST /account/register order=0` als auch `POST /account/register order=-1`. Der ursprüngliche Endpunkt steht weiterhin im OpenAPI-Dokument, weil `ExcludeFromDescription()` nur auf Ihren Schatten-Endpunkt wirkt. Um ihn auszublenden, brauchen Sie zusätzlich Option 1.

Das Überlagern ist das richtige Werkzeug, wenn Sie einen Endpunkt **ersetzen** statt entfernen wollen, etwa ein `/register`, das zusätzlich einen Einladungscode verlangt, während der Rest von `MapIdentityApi` unverändert bleibt. Zum reinen Entfernen ist es die unsauberste der vier Optionen.

## Option 4: Endpunkte vollständig aus dem Routing entfernen

Damit ein Endpunkt wirklich nicht existiert (keine Route, kein OpenAPI-Eintrag, kein 401 für anonyme Aufrufer, nur dasselbe 404 wie bei jeder unbekannten URL), muss verhindert werden, dass sein `RouteEndpoint` das Routingsystem erreicht. `MapIdentityApi` verwendet nur zwei Member des übergebenen `IEndpointRouteBuilder`: `ServiceProvider`, um seine Dienste aufzulösen, und `DataSources`, wo `MapGroup("")` seine Endpunktquelle hinzufügt. Daraus ergibt sich eine Nahtstelle:

1. Übergeben Sie `MapIdentityApi` einen kleinen eigenen `IEndpointRouteBuilder`, dessen `DataSources`-Sammlung privat ist.
2. Umhüllen Sie diese private Sammlung mit einer `EndpointDataSource`, die die ungewollten Endpunkte verwirft.
3. Fügen Sie den Wrapper den `DataSources` des echten Route Builders hinzu.

```csharp
// .NET 11 RC 1, works the same on .NET 8, 9 and 10
using Microsoft.Extensions.Primitives;

static class IdentityApiExceptExtensions
{
    public static IEndpointConventionBuilder MapIdentityApiExcept<TUser>(
        this IEndpointRouteBuilder endpoints, params string[] excludedRoutes)
        where TUser : class, new()
    {
        var capture = new CapturingRouteBuilder(endpoints);
        var conventions = capture.MapIdentityApi<TUser>();

        bool Keep(Endpoint e) =>
            e is not RouteEndpoint re ||
            !excludedRoutes.Any(r =>
                re.RoutePattern.RawText!.EndsWith(r, StringComparison.OrdinalIgnoreCase));

        endpoints.DataSources.Add(new FilteringEndpointDataSource(capture.DataSources, Keep));
        return conventions;
    }

    private sealed class CapturingRouteBuilder(IEndpointRouteBuilder inner) : IEndpointRouteBuilder
    {
        public ICollection<EndpointDataSource> DataSources { get; } = new List<EndpointDataSource>();
        public IServiceProvider ServiceProvider => inner.ServiceProvider;
        public IApplicationBuilder CreateApplicationBuilder() => inner.CreateApplicationBuilder();
    }

    private sealed class FilteringEndpointDataSource(
        ICollection<EndpointDataSource> sources, Func<Endpoint, bool> keep) : EndpointDataSource
    {
        private readonly CompositeEndpointDataSource _inner = new(sources);

        public override IReadOnlyList<Endpoint> Endpoints =>
            _inner.Endpoints.Where(keep).ToList();

        public override IReadOnlyList<Endpoint> GetGroupedEndpoints(RouteGroupContext context) =>
            _inner.GetGroupedEndpoints(context).Where(keep).ToList();

        public override IChangeToken GetChangeToken() => _inner.GetChangeToken();
    }
}
```

Die Verwendung ist eine Änderung in einer Zeile:

```csharp
// .NET 11 RC 1
var account = app.MapGroup("/account");
account.MapIdentityApiExcept<IdentityUser>("/register", "/manage/2fa");
```

Gemessenes Ergebnis: Die Endpunktliste hat acht statt zehn Einträge, `/openapi/v1.json` listet acht Pfade, und sowohl `POST /account/register` als auch ein anonymes `POST /account/manage/2fa` liefern 404. Die übrigen acht Endpunkte funktionieren wie zuvor, und der zurückgegebene Convention Builder wirkt weiterhin auf sie, sodass `.RequireRateLimiting(...)` oder `.WithTags(...)`, auf das Ergebnis verkettet, wie gewohnt funktioniert.

Zwei Teile dieses Codes lassen sich leicht falsch machen:

- **`GetGroupedEndpoints` überschreiben.** Wenn Sie die Erweiterung auf einer Gruppe wie `account` aufrufen, liest die äußere Gruppe nicht `Endpoints`. Sie ruft `GetGroupedEndpoints` mit dem Präfix und den Konventionen der Gruppe auf. Indem Sie diesen Aufruf an die inneren Quellen delegieren, bauen diese jeden Endpunkt einmal mit dem vollständigen Präfix und allen angewendeten Konventionen, statt sich darauf zu verlassen, dass die Basisklasse bereits ohne Präfix gebaute Endpunkte erneut umhüllt. Deshalb trägt `RawText` bereits `/account`, wenn `Keep` läuft.
- **Das Change Token durchreichen.** Die Endpunkte von Identity sind statisch, aber ein echtes Token aus dem inneren Composite zurückzugeben hält die Datenquelle korrekt, falls je etwas anderes Endpunkte zur erfassten Sammlung hinzufügt.

Das setzt voraus, dass `MapIdentityApi` nur `ServiceProvider` und `DataSources` verwendet. Das stimmt für jede Version von 8.0 bis 11 RC 2, ist aber ein Implementierungsdetail. Eine künftige Version, die etwa `CreateApplicationBuilder()` aufruft, würde dank der obigen Delegation weiterhin funktionieren. Eine, die in einen anderen Builder abbildet, nicht. Ein Test, der die erwartete Routenliste prüft (der `IEnumerable<EndpointDataSource>`-Dump, den ich verwendet habe, besteht aus drei Zeilen), fängt das beim Upgrade ab.

## Die `/confirmEmail`-Falle

Der eine Endpunkt, den Sie nicht allein entfernen können, ist `GET /confirmEmail`. `/register`, `/resendConfirmationEmail` und der E-Mail-Änderungszweig von `POST /manage/info` erzeugen den Bestätigungslink alle über den Endpunktnamen mit `LinkGenerator.GetUriByName`. Der Name wird in einer `Finally`-Konvention auf `/confirmEmail` vergeben, als `MapIdentityApi-` gefolgt vom finalen Routenmuster.

Mit Option 4 und `MapIdentityApiExcept<IdentityUser>("/confirmEmail")` läuft die Konvention weiterhin (der Endpunkt wird gebaut und dann herausgefiltert), der Name wird also gesetzt, aber der Link Generator findet keinen Endpunkt mit diesem Namen. Die Registrierung schlägt dann fehl:

```text
System.NotSupportedException: Could not find endpoint named 'MapIdentityApi-/account/confirmEmail'.
```

Gemessenes Ergebnis: `POST /account/register` liefert **500**, ebenso `POST /account/resendConfirmationEmail`, während `/login` weiter funktioniert. Wenn Sie über diese API gar keine E-Mail-Bestätigung wollen, entfernen Sie `/register` und `/resendConfirmationEmail` zusammen mit `/confirmEmail`, oder lassen Sie `/confirmEmail` geroutet und blenden es nur mit Option 1 aus OpenAPI aus.

Option 2 hat dieses Problem nicht, weil der Endpunkt für die Link-Erzeugung weiterhin existiert. Er antwortet nur mit 404.

## Welche Option Sie verwenden sollten

- **Der Endpunkt ist in Ordnung, soll aber nicht im veröffentlichten Dokument stehen:** Option 1.
- **Der Endpunkt darf nicht funktionieren, und ein 401 für anonyme Aufrufer auf `/manage/*` ist akzeptabel:** Option 2 mit dem Delegate-Austausch in `Finally`. Das sind wenige Zeilen und hängt nicht von Identity-Interna ab.
- **Der Endpunkt darf überhaupt nicht existieren:** Option 4.
- **Sie brauchen eine andere Implementierung eines Endpunkts:** Option 3, plus Option 1, um das Original auszublenden.
- **Sie müssen das Verhalten in mehreren Endpunkten ändern** (zusätzliche Registrierungsfelder, Login per Benutzername, andere Token-Antworten): Kopieren Sie [`IdentityApiEndpointRouteBuilderExtensions.cs`](https://github.com/dotnet/aspnetcore/blob/main/src/Identity/Core/src/IdentityApiEndpointRouteBuilderExtensions.cs) in Ihr Projekt und bearbeiten Sie sie. Sie steht unter MIT-Lizenz, umfasst etwa 490 Zeilen, und die verwendeten Request- und Response-DTOs (`RegisterRequest`, `LoginRequest`, `AccessTokenResponse` und so weiter) sind öffentliche Typen in `Microsoft.AspNetCore.Identity.Data`. Sie verlieren automatische Korrekturen aus künftigen Framework-Updates, beobachten Sie also beim Upgrade den Verlauf der Datei.

Wenn Sie ohnehin mehrere Endpunkte ersetzen, vergleichen Sie zuerst die Abwägungen in [JWT vs. Cookie-Authentifizierung in ASP.NET Core 11](/de/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/). Die Bearer-Tokens, die `MapIdentityApi` ausstellt, sind undurchsichtige Data-Protection-Tokens, keine JWTs, und das ist oft der eigentliche Grund, warum ein Team diesen Endpunkten entwächst.

## Stolperfallen

- **Gleichen Sie die vollständige Route ab oder verwenden Sie `EndsWith` mit Bedacht.** `EndsWith("/info")` trifft sowohl `GET` als auch `POST /manage/info`. Wenn Sie nur das `POST` blockieren wollen (es kann E-Mail und Passwort ändern), prüfen Sie in der Konvention zusätzlich `b.Metadata.OfType<HttpMethodMetadata>()`, bzw. in Option 4 `re.Metadata.GetMetadata<HttpMethodMetadata>()`.
- **`/login` und `/refresh` gehören zusammen.** Wer `/refresh` entfernt und `/login` behält, lässt Clients mit einem `refreshToken` zurück, den sie nie verwenden können. Die [Anleitung zu Refresh Tokens](/de/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/) behandelt, was `/refresh` tatsächlich validiert.
- **Das Entfernen von `/register` verhindert nicht das Anlegen von Konten.** `UserManager<TUser>.CreateAsync` steht Ihrem eigenen Code weiterhin zur Verfügung, und externe Login-Abläufe können weiterhin Benutzer anlegen. Das Blockieren des Endpunkts entfernt nur die anonyme, öffentliche Registrierungsroute.
- **Greifen Sie nicht zuerst zu pfadbasierter Middleware.** Eine Middleware, die für Pfade mit dem Anfang `/account/register` 404 zurückgibt, funktioniert, codiert aber das Gruppenpräfix fest ein, läuft für jede Anfrage der App und lässt den OpenAPI-Eintrag bestehen. Endpunktkonventionen kennen das finale Muster und laufen einmal, wenn die Endpunkte gebaut werden.
- **Hängen Sie Identity in eine eigene Gruppe ein.** Ruft man `MapIdentityApi` direkt auf `app` auf, landen `/login` und `/register` im Stamm Ihrer API. Eine eigene Gruppe, wie in [Minimal-API-Endpunkte mit `MapGroup` organisieren](/de/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) beschrieben, erlaubt es zudem, Rate Limiting und Tags nur an Identity anzubringen.

## Verwandte Beiträge

- [Refresh Tokens in ASP.NET Core Identity implementieren](/de/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/), einschließlich der Frage, wann `MapIdentityApi` nicht mehr ausreicht.
- [Minimal-API-Endpunkte mit `MapGroup` in ASP.NET Core 11 organisieren](/de/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [OpenAPI mit Operation- und Schema-Transformern in ASP.NET Core 11 anpassen](/de/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/)
- [Endpoint Filters vs. Middleware in ASP.NET Core 11](/de/2026/07/endpoint-filters-vs-middleware-in-aspnetcore-11/)
- [JWT vs. Cookie-Authentifizierung in ASP.NET Core 11](/de/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/)

## Quellen

- [`IdentityApiEndpointRouteBuilderExtensions.cs` at `v11.0.0-rc.2.26504.105`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.2.26504.105/src/Identity/Core/src/IdentityApiEndpointRouteBuilderExtensions.cs), dotnet/aspnetcore.
- [dotnet/aspnetcore#55792: Split MapIdentityApi<TUser>() into multiple APIs and allow selective end points to be enabled](https://github.com/dotnet/aspnetcore/issues/55792)
- [dotnet/aspnetcore#50303: Extensibility for Identity Endpoints](https://github.com/dotnet/aspnetcore/issues/50303)
- [Use Identity to secure a Web API backend for SPAs](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/identity-api-authorization), Microsoft Learn.
- [Route groups and endpoint conventions in minimal APIs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/route-handlers#route-groups), Microsoft Learn.
- [`EndpointDataSource` class](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.routing.endpointdatasource), Microsoft Learn.
