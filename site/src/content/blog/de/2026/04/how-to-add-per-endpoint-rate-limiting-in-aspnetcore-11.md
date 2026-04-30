---
title: "Wie Sie Rate Limiting pro Endpunkt in ASP.NET Core 11 hinzufügen"
description: "Ein vollständiger Leitfaden zu Rate Limiting pro Endpunkt in ASP.NET Core 11: Wann Fixed Window vs. Sliding Window vs. Token Bucket vs. Concurrency wählen, wie sich RequireRateLimiting und [EnableRateLimiting] unterscheiden, Partitionierung nach Benutzer oder IP, der OnRejected-Callback und die Falle bei verteilter Bereitstellung, in die jeder tappt."
pubDate: 2026-04-30
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "rate-limiting"
lang: "de"
translationOf: "2026/04/how-to-add-per-endpoint-rate-limiting-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-04-30
---

Um die Rate eines bestimmten Endpunkts in ASP.NET Core 11 zu begrenzen, registrieren Sie eine benannte Policy in `AddRateLimiter`, rufen Sie `app.UseRateLimiter()` nach dem Routing auf und hängen Sie die Policy mit `RequireRateLimiting("name")` an einer minimal API oder mit `[EnableRateLimiting("name")]` an einer MVC-Action an den Endpunkt. Die Laufzeit liefert vier integrierte Algorithmen in `Microsoft.AspNetCore.RateLimiting`: Fixed Window, Sliding Window, Token Bucket und Concurrency. Die Middleware gibt `429 Too Many Requests` zurück, wenn eine Anfrage abgelehnt wird, und stellt einen `OnRejected`-Callback für angepasste Antworten bereit, einschließlich `Retry-After`. Dieser Leitfaden behandelt .NET 11 Preview 3 mit C# 14, aber die API ist seit .NET 7 stabil und jedes Codebeispiel kompiliert unverändert auf .NET 8, 9 und 10.

## Warum "globales" Rate Limiting selten das ist, was Sie wollen

Die einfachste Konfiguration, ein einzelner globaler Limiter, der Anfragen verwirft, sobald der ganze Prozess über dem Budget liegt, ist etwa zehn Sekunden lang attraktiv. Dann fällt Ihnen auf, dass der Login-Endpunkt und der statische Health-Probe sich dieses Budget teilen. Ein Botnetz, das `/login` hämmert, legt fröhlich `/health` lahm, und Ihr Load Balancer nimmt die Instanz aus der Rotation, weil der billige Probe plötzlich 429er zurückgibt.

Rate Limiting pro Endpunkt behebt das. Jeder Endpunkt deklariert seine eigene Policy mit Limits, die auf seine tatsächlichen Kosten zugeschnitten sind: `/login` bekommt einen strengen Token Bucket pro IP, `/api/search` bekommt ein großzügiges Sliding Window, der File-Upload-Endpunkt bekommt einen Concurrency-Limiter, und `/health` bekommt nichts. Der globale Limiter wird, wenn Sie einen behalten, zu einem Auffangnetz für Missbrauch auf Protokollebene statt zur primären Verteidigung.

Die Middleware `Microsoft.AspNetCore.RateLimiting` wurde in .NET 7 aus der Preview entlassen und hat seitdem nur Verbesserungen der Lebensqualität erhalten. Sie ist in .NET 11 ein vollwertiger Bestandteil des Frameworks, ohne zusätzliches NuGet-Paket zur Installation.

## Die minimale Program.cs

Hier ist die kleinste Konfiguration, die zwei verschiedene Policies pro Endpunkt hinzufügt, eine auf einen minimal-API-Endpunkt anwendet und den Rest der Anwendung ohne Drosselung laufen lässt.

```csharp
// .NET 11 preview 3, C# 14
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;

    options.AddFixedWindowLimiter(policyName: "search", o =>
    {
        o.PermitLimit = 30;
        o.Window = TimeSpan.FromSeconds(10);
        o.QueueLimit = 0;
    });

    options.AddTokenBucketLimiter(policyName: "login", o =>
    {
        o.TokenLimit = 5;
        o.TokensPerPeriod = 5;
        o.ReplenishmentPeriod = TimeSpan.FromMinutes(1);
        o.QueueLimit = 0;
        o.AutoReplenishment = true;
    });
});

var app = builder.Build();

app.UseRateLimiter();

app.MapGet("/api/search", (string q) => Results.Ok(new { q }))
   .RequireRateLimiting("search");

app.MapPost("/api/login", (LoginRequest body) => Results.Ok())
   .RequireRateLimiting("login");

app.MapGet("/health", () => Results.Ok("ok"));

app.Run();

record LoginRequest(string Email, string Password);
```

Zwei Dinge sind bemerkenswert. Erstens steht `RejectionStatusCode` standardmäßig auf `503 Service Unavailable`, was für fast jede öffentliche API falsch ist. Setzen Sie ihn einmal in `AddRateLimiter` auf `429` und vergessen Sie ihn dann. Zweitens muss `app.UseRateLimiter()` nach `app.UseRouting()` kommen, wenn Sie das Routing explizit aufrufen, weil die Middleware die Endpunkt-Metadaten liest, um zu entscheiden, welche Policy gilt. Das integrierte `WebApplication` fügt das Routing automatisch vor terminaler Middleware hinzu, sodass der explizite `UseRouting`-Aufruf nur erforderlich ist, wenn Sie weitere Middleware haben, die zwischen Routing und Rate Limiting sitzen muss.

## RequireRateLimiting vs. [EnableRateLimiting]

ASP.NET Core hat zwei gleichwertige Wege, eine Policy an einen Endpunkt zu hängen, und sie existieren, weil minimal APIs und MVC unterschiedliche Metadaten-Geschichten haben.

Für minimal APIs und Endpunkt-Gruppen ist die fluente Methode `RequireRateLimiting` auf `IEndpointConventionBuilder` der richtige Aufruf:

```csharp
// .NET 11, C# 14
var api = app.MapGroup("/api/v1").RequireRateLimiting("search");

api.MapGet("/products", (...) => ...);          // inherits "search"
api.MapGet("/orders", (...) => ...);            // inherits "search"
api.MapPost("/login", (...) => ...)
   .RequireRateLimiting("login");               // overrides to "login"
```

Metadaten auf Endpunkt-Ebene gewinnen gegen Metadaten auf Gruppen-Ebene, also bewirkt das Override auf `/login` das Erwartete: Es wird nur die spezifischste Policy am Endpunkt angewendet.

Für MVC-Controller ist die Attribut-Form der richtige Aufruf:

```csharp
// .NET 11, C# 14
[ApiController]
[Route("api/[controller]")]
[EnableRateLimiting("search")]
public class ProductsController : ControllerBase
{
    [HttpGet]
    public IActionResult List() => Ok(/* ... */);

    [HttpGet("{id}")]
    [EnableRateLimiting("hot")]    // narrower policy for a hot endpoint
    public IActionResult Get(int id) => Ok(/* ... */);

    [HttpPost("import")]
    [DisableRateLimiting]          // bypass entirely for an internal endpoint
    public IActionResult Import() => Ok();
}
```

`[EnableRateLimiting]` und `[DisableRateLimiting]` folgen den Standardregeln zur Attributauflösung von ASP.NET Core: Action-Ebene gewinnt gegen Controller-Ebene, und `DisableRateLimiting` gewinnt immer. Das Mischen der fluenten und der Attribut-Schreibweise ist in Ordnung, die Metadaten-Pipeline liest beide gleich.

Ein häufiger Fehler ist, `[EnableRateLimiting]` über `.WithMetadata(new EnableRateLimitingAttribute("search"))` an einen minimal-API-Endpunkt zu hängen. Es funktioniert, aber `RequireRateLimiting("search")` ist kürzer und klarer.

## Einen Algorithmus auswählen

Die vier integrierten Algorithmen beantworten vier verschiedene Formen von "Wie oft ist zu oft", und eine falsche Wahl zeigt sich entweder als Verkehrsspitzen, die Ihr Limit durchbrechen, oder als legitime Benutzer, die während normaler Bursts 429er bekommen.

**Fixed Window** zählt Anfragen in nicht überlappenden Zeitbuckets. `PermitLimit = 100, Window = 1s` bedeutet bis zu 100 Anfragen in jeder taktgesteuerten Sekunde. Billig zu berechnen und leicht zu durchschauen, aber es erlaubt einen Burst von 200 Anfragen an der Fenstergrenze: 100 in der letzten Millisekunde eines Fensters, 100 in der ersten Millisekunde des nächsten. Verwenden Sie es für Kostenlimits, bei denen der Burst akzeptabel ist, oder für nicht-kritische Anti-Missbrauchs-Maßnahmen, bei denen Sie keine CPU für Tracking ausgeben wollen.

**Sliding Window** teilt das Fenster in Segmente und rollt sie nach vorne. `PermitLimit = 100, Window = 1s, SegmentsPerWindow = 10` bedeutet 100 Anfragen in einer beliebigen 1-Sekunden-Scheibe, ausgewertet in 100ms-Schritten. Es eliminiert den Grenz-Burst auf Kosten von mehr Buchführung pro Anfrage. Das ist die vernünftige Voreinstellung für öffentlich erreichbare Lese-Endpunkte.

**Token Bucket** füllt `TokensPerPeriod` Tokens pro `ReplenishmentPeriod` auf, bis zu `TokenLimit`. Jede Anfrage nimmt einen Token. Bursts sind bis zu `TokenLimit` erlaubt, dann pendelt sich die Rate auf der Auffüllrate ein. Das ist das richtige Modell für jeden Endpunkt, bei dem Sie einen kleinen Burst zulassen wollen (ein angemeldeter Benutzer öffnet fünf Tabs), aber die anhaltende Rate begrenzen wollen (kein Scraping). Login, Passwort-Reset und E-Mail-Versand-Endpunkte sind alle Kandidaten für Token Bucket.

**Concurrency** begrenzt die Anzahl der gleichzeitig in Bearbeitung befindlichen Anfragen, unabhängig von der Dauer. `PermitLimit = 4` bedeutet höchstens vier gleichzeitige Anfragen; die fünfte wird entweder eingereiht oder abgelehnt. Verwenden Sie es für Endpunkte, die eine langsame Downstream-Ressource ansprechen: große Datei-Uploads, teure Berichtsgenerierung oder jeden Endpunkt, bei dem die Kosten Wanduhrzeit auf einem Worker sind statt der Anzahl an Anfragen.

Die Optionen `QueueLimit` und `QueueProcessingOrder` werden über alle vier hinweg geteilt. `QueueLimit = 0` bedeutet "bei voller Kapazität sofort ablehnen", was Sie für die meisten HTTP-APIs wollen, weil Clients nach 429 sowieso einen Retry machen. Nicht-null-Queue-Limits ergeben Sinn für Concurrency-Limiter, bei denen die Arbeit kurz ist und 200ms in der Warteschlange billiger sind, als den Client durch eine Retry-Schleife zu schicken.

## Partitionierung: pro Benutzer, pro IP, pro Mandant

Ein einzelner geteilter Bucket pro Endpunkt ist selten das, was Sie wollen. Wenn `/api/search` global 30 Anfragen pro 10 Sekunden erlaubt, sperrt ein lauter Client alle anderen aus. Partitionierte Limiter geben jedem "Schlüssel" seinen eigenen Bucket.

Die fluente `AddPolicy`-Überladung nimmt einen `HttpContext` und gibt eine `RateLimitPartition<TKey>` zurück:

```csharp
// .NET 11, C# 14
options.AddPolicy("per-user-search", context =>
{
    var key = context.User.Identity?.IsAuthenticated == true
        ? context.User.FindFirst("sub")?.Value ?? "anon"
        : context.Connection.RemoteIpAddress?.ToString() ?? "unknown";

    return RateLimitPartition.GetSlidingWindowLimiter(key, _ => new SlidingWindowRateLimiterOptions
    {
        PermitLimit = 60,
        Window = TimeSpan.FromMinutes(1),
        SegmentsPerWindow = 6,
        QueueLimit = 0
    });
});
```

Die Factory wird einmal pro Partitionsschlüssel aufgerufen. Die Laufzeit cached den resultierenden Limiter in einem `PartitionedRateLimiter`, sodass spätere Anfragen mit demselben Schlüssel dieselbe Limiter-Instanz wiederverwenden. Der Speicherverbrauch skaliert mit der Anzahl an unterschiedlichen Schlüsseln, die Sie jemals sehen, weshalb Sie idle Limiter evikten sollten: Das Framework macht das automatisch, wenn ein Limiter `IdleTimeout` lang inaktiv war (Standard 1 Minute), aber Sie können es über die `RateLimitPartition.GetSlidingWindowLimiter(key, factory)`-Überladungen anpassen.

Zwei Partitionierungs-Fallstricke:

1. **`RemoteIpAddress` ist hinter einem Reverse-Proxy `null`**, es sei denn, Sie rufen `app.UseForwardedHeaders()` mit konfiguriertem `ForwardedHeaders.XForwardedFor` und einer `KnownProxies`- oder `KnownNetworks`-Liste auf. Ohne das bekommt jede Anfrage den Partitionsschlüssel `"unknown"`, und Sie haben wieder einen globalen Limiter.
2. **Authentifizierte und anonyme Benutzer mischen sich in derselben Partition**, wenn Sie nur nach `sub` schlüsseln. Verwenden Sie ein Präfix wie `"user:"` oder `"ip:"`, damit ein nicht angemeldeter Angreifer nicht mit dem Bucket eines echten Benutzers kollidieren kann.

Für komplexere Policies (pro Mandant, pro API-Key, mehrere verkettete Limiter) implementieren Sie `IRateLimiterPolicy<TKey>` und registrieren ihn mit `options.AddPolicy<string, MyPolicy>("name")`. Das Policy-Interface gibt Ihnen dieselbe `GetPartition`-Methode plus einen `OnRejected`-Callback, der auf diese Policy beschränkt ist.

## Die Ablehnungsantwort anpassen

Die standardmäßige 429-Antwort ist ein leerer Body ohne `Retry-After`-Header. Das ist für interne APIs in Ordnung, aber öffentliche Clients (Browser, SDKs, Drittanbieter-Integrationen) erwarten einen Hinweis. Der `OnRejected`-Callback läuft, nachdem der Limiter abgelehnt hat, aber bevor die Antwort geschrieben wird:

```csharp
// .NET 11, C# 14
options.OnRejected = async (context, cancellationToken) =>
{
    if (context.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retryAfter))
    {
        context.HttpContext.Response.Headers.RetryAfter =
            ((int)retryAfter.TotalSeconds).ToString();
    }

    context.HttpContext.Response.ContentType = "application/problem+json";
    await context.HttpContext.Response.WriteAsJsonAsync(new
    {
        type = "https://tools.ietf.org/html/rfc6585#section-4",
        title = "Too Many Requests",
        status = 429,
        detail = "Rate limit exceeded. Retry after the indicated period."
    }, cancellationToken);
};
```

Zwei leicht zu übersehende Details. Erstens wird `MetadataName.RetryAfter` nur von Token-Bucket-Limitern und auffüllenden Limitern befüllt, nicht von Fixed-Window oder Sliding-Window. Sliding-Window-Limiter können einen Retry-After aus `Window / SegmentsPerWindow` berechnen, aber die Rechnung müssen Sie selbst machen. Zweitens läuft der `OnRejected`-Callback auf dem Pfad der Rate-Limiter-Middleware, nicht im Endpunkt, daher funktioniert der Zugriff auf endpunktspezifische Services über `context.HttpContext.RequestServices`, der Zugriff auf Controller-Filter oder Action-Context dagegen nicht, sie sind noch nicht gebunden.

Wenn Sie ein `OnRejected` pro Policy statt eines globalen wollen, implementieren Sie `IRateLimiterPolicy<TKey>` und überschreiben `OnRejected` auf der Policy. Der Callback auf Policy-Ebene läuft zusätzlich zum globalen, achten Sie also darauf, den Antwort-Body nicht zweimal zu schreiben.

## Die Falle bei verteilter Bereitstellung

Jedes obige Codebeispiel speichert den Rate-Limit-State im Prozessspeicher. Das ist in Ordnung, wenn Sie eine einzelne Instanz betreiben, und katastrophal, wenn Sie horizontal skalieren. Drei Replicas hinter einem Load Balancer mit `PermitLimit = 100` pro 10 Sekunden erlauben in Wirklichkeit 300 Anfragen pro 10 Sekunden, weil jede Replica unabhängig zählt. Sticky Sessions helfen nur, wenn Ihr Hash die Partitionsschlüssel gleichmäßig verteilt, was er typischerweise nicht tut.

Es gibt keinen integrierten verteilten Rate Limiter in `Microsoft.AspNetCore.RateLimiting`. Die gepflegten Optionen mit Stand .NET 11 sind:

- **Schieben Sie das Limit zum Load Balancer.** NGINX `limit_req`, AWS-WAF-Rate-basierte Regeln, Azure Front Door Rate Limiting, Cloudflare Rate Limiting Rules. Das ist die richtige Antwort für grobe Anti-Missbrauchs-Maßnahmen am Netzwerkrand.
- **Verwenden Sie eine Redis-gestützte Bibliothek.** `RateLimit.Redis` (Microsoft-Sample auf GitHub) und `AspNetCoreRateLimit.Redis` implementieren beide `PartitionedRateLimiter<HttpContext>` gegen einen Redis-Sorted-Set oder ein atomares Increment. Der Redis-Roundtrip fügt 0,5-2ms pro Anfrage hinzu, was für Endpunkte akzeptabel ist, die nicht im Hot Path liegen.
- **Kombinieren Sie beides.** Der Edge erzwingt ein großzügiges Limit; die Anwendung erzwingt ein Limit pro Benutzer in Redis; In-Process bleibt für Backpressure auf langsame Downstreams via Concurrency-Limiter reserviert.

Implementieren Sie keinen eigenen verteilten Limiter auf `IDistributedCache` und `INCRBY`, es sei denn, Sie haben [den Cloudflare-Blogpost zu verteilten Sliding-Window-Zählern](https://blog.cloudflare.com/counting-things-a-lot-of-different-things/) gelesen und haben eine starke Meinung zu Uhrenversatz.

## Endpunkte mit Rate Limit testen

Integrationstests mit `WebApplicationFactory<TEntryPoint>` funktionieren, aber der Rate Limiter wird zwischen Tests standardmäßig nicht zurückgesetzt. Zwei Strategien:

1. **Überschreiben Sie die Policy im Test-Host.** Injizieren Sie einen permissiven Limiter (`PermitLimit = int.MaxValue`) für die Testumgebung und schreiben Sie eine separate Test-Suite, die den Limiter explizit mit einer realen Policy beansprucht.
2. **Deaktivieren Sie den Limiter für den Endpunkt unter Test.** Umschließen Sie Ihre `MapGroup`/`RequireRateLimiting`-Aufrufe mit `if (!env.IsEnvironment("Testing"))` oder verwenden Sie `[DisableRateLimiting]` in Test-Overrides.

Die Middleware stellt außerdem `RateLimiterOptions.GlobalLimiter` für einen partitionierten Top-Level-Limiter bereit, der bei jeder Anfrage vor den endpunktspezifischen Policies läuft. Es ist der richtige Ort für ein Pro-IP-Tor vom Typ "du bist offensichtlich ein Bot" und der richtige Ort, um bei jeder Ablehnung einen `Retry-After`-Header hinzuzufügen, unabhängig davon, welche benannte Policy gefeuert hat. Verwenden Sie ihn nicht als Ersatz für endpunktspezifische Policies; die beiden komponieren, sie ersetzen sich nicht gegenseitig.

## Wenn die integrierte Middleware nicht ausreicht

Die Middleware deckt 90 % der Fälle ab. Die restlichen 10 % betreffen meist eines der folgenden:

- **Kostenbasierte Limits**: Jede Anfrage verbraucht N Tokens je nach berechneten Kosten (eine Suche mit 5 Facetten kostet mehr als eine flache Liste). Die Middleware hat keinen Hook für variablen Tokenverbrauch, daher umschließen Sie den Endpunkt im Handler mit einem manuellen `RateLimiter.AcquireAsync(permitCount)`-Aufruf.
- **Soft-Limits mit Degradation**: Anstatt 429 zurückzugeben, liefern Sie eine gecachte oder herunterskalierte Antwort. Implementieren Sie das im Endpunkt, nicht in der Middleware: prüfen Sie `context.Features.Get<IRateLimitFeature>()` (in .NET 9 von der Middleware hinzugefügt) und verzweigen Sie darauf.
- **Metrik-Ausgabe pro Route**: Die Middleware gibt `aspnetcore.rate_limiting.request_lease.duration` und ähnliche Metriken über den Meter `Microsoft.AspNetCore.RateLimiting` aus. Schließen Sie das via `OpenTelemetry` an, um Pro-Policy-429-Zähler in Ihrem Dashboard zu sehen. Die integrierten Counter brechen nicht nach Endpunkt auf; wenn Sie das brauchen, taggen Sie den Meter selbst in `OnRejected`.

## Verwandt

- [Wie Sie einen globalen Exception-Filter in ASP.NET Core 11 hinzufügen](/de/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) behandelt die Middleware-Reihenfolge-Regeln, die auch für `UseRateLimiter` gelten.
- [Wie Sie Native AOT mit ASP.NET-Core-Minimal-APIs verwenden](/de/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) für die Trim-Sicherheitsimplikationen von `IRateLimiterPolicy<T>`.
- [Wie Sie Code testen, der HttpClient verwendet](/de/2026/04/how-to-unit-test-code-that-uses-httpclient/) für das oben referenzierte Test-Host-Muster.
- [Wie Sie OpenAPI-Authentifizierungsflüsse zur Swagger UI in .NET 11 hinzufügen](/de/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/) für die Partitionsschlüssel-Geschichte, wenn API-Keys die Benutzeridentität tragen.
- [Wie Sie stark typisierten Client-Code aus einer OpenAPI-Spezifikation in .NET 11 generieren](/de/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/) für die Konsumentenseite des 429-Vertrags.

## Quellen

- [Rate-Limiting-Middleware in ASP.NET Core](https://learn.microsoft.com/aspnet/core/performance/rate-limit) auf MS Learn.
- [API-Referenz `Microsoft.AspNetCore.RateLimiting`](https://learn.microsoft.com/dotnet/api/microsoft.aspnetcore.ratelimiting).
- [Quellcode des Pakets `System.Threading.RateLimiting`](https://github.com/dotnet/runtime/tree/main/src/libraries/System.Threading.RateLimiting) für die zugrunde liegenden Limiter-Primitive.
- [RFC 6585 Abschnitt 4](https://www.rfc-editor.org/rfc/rfc6585#section-4) für die kanonische Definition von `429 Too Many Requests` und dem `Retry-After`-Header.
