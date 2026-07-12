---
title: "Output Caching zu einer Minimal API in ASP.NET Core 11 hinzufügen"
description: "Ein vollständiger, funktionierender Leitfaden zum Output Caching in einer ASP.NET Core 11 Minimal API: AddOutputCache und UseOutputCache, CacheOutput an Endpunkten und MapGroup, benannte und Basis-Policies, Expire, VaryByQuery und VaryByHeader, Tag-basierte Invalidierung mit EvictByTagAsync, Schutz vor Cache-Stampede, ETag-Revalidierung und ein Redis-Backing-Store."
pubDate: 2026-07-12
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-api"
  - "performance"
  - "caching"
lang: "de"
translationOf: "2026/07/how-to-add-output-caching-to-a-minimal-api-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-12
---

Um Output Caching zu einer Minimal API in ASP.NET Core 11 hinzuzufügen, benötigen Sie genau drei bewegliche Teile: die Services mit `builder.Services.AddOutputCache()` registrieren, die Middleware mit `app.UseOutputCache()` hinzufügen und die Endpunkte, die Sie cachen möchten, mit `.CacheOutput()` markieren. Das genügt, um eine ganze HTTP-Antwort im Speicher zu cachen und zurückzuliefern, ohne Ihren Handler erneut auszuführen. Alles darüber hinaus (Ablaufzeiten, Cache-Schlüssel pro Abfrage, Tag-basierte Invalidierung, ein Redis-Backing-Store) ist Feinschliff. Dieser Beitrag geht den kompletten Weg von Anfang bis Ende durch. Er zielt auf .NET 11 (Preview 5 zum Zeitpunkt des Schreibens, GA im November 2026) mit `Microsoft.NET.Sdk.Web` und C# 14, aber die Output-Caching-API ist seit ASP.NET Core 7 stabil, sodass jeder Schritt hier unverändert auf .NET 8, 9 und 10 funktioniert.

## Output Caching ist nicht Response Caching

Das Erste, was man richtig verstehen muss, weil es fast jeden stolpern lässt: Output Caching und Response Caching sind unterschiedliche Funktionen, die unterschiedliche Probleme lösen.

Response Caching (`AddResponseCaching`) ist die ältere Middleware. Sie beteiligt sich am HTTP-Caching: Sie liest und schreibt die Header `Cache-Control`, `Vary` und `Expires`, und sie cacht nur, wenn die Antwort sich mit den richtigen Headern dafür entscheidet. Sie ist im Grunde ein Shared-Proxy-Cache, der innerhalb Ihrer App lebt, und man macht leicht etwas falsch, weil ein versehentliches `Set-Cookie` oder ein fehlendes `Cache-Control: public` sie stillschweigend deaktiviert.

Output Caching (`AddOutputCache`, hinzugefügt in ASP.NET Core 7) ist servergesteuert. Der Server entscheidet, was gecacht wird und für wie lange, unabhängig von den Request-Headern des Clients. Es unterstützt die Variation des Cache-Schlüssels auf beliebigen Werten, Tag-basierte Invalidierung, sodass Sie eine Gruppe von Einträgen löschen können, wenn sich die zugrunde liegenden Daten ändern, und einen eingebauten Schutz gegen Cache-Stampede. Für eine API, bei der Ihnen beide Enden gehören, ist Output Caching fast immer die Variante, die Sie wollen. Dieser Beitrag dreht sich ausschließlich um Output Caching.

## Die drei beweglichen Teile verdrahten

Output Caching lebt im Shared Framework, es gibt also kein NuGet-Paket, das für den In-Memory-Fall installiert werden muss. Registrieren Sie die Services und fügen Sie die Middleware hinzu:

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOutputCache();

var app = builder.Build();

app.UseOutputCache();

app.MapGet("/time", () => new { now = DateTime.UtcNow })
    .CacheOutput();

app.Run();
```

Drei Dinge sind zu beachten. Erstens: `AddOutputCache()` und `UseOutputCache()` allein bewirken nichts. Sie machen Caching verfügbar, cachen aber nichts, bis sich ein Endpunkt dafür entscheidet. Zweitens: `.CacheOutput()` ohne Argumente wendet die Standard-Policy an, die für 60 Sekunden cacht. Rufen Sie `/time` zweimal innerhalb einer Minute auf, und Sie erhalten denselben Zeitstempel zurück, weil der zweite Request Ihre Lambda nie ausführt.

Drittens, und das ist der Punkt, der Bugs in Produktion verursacht: Die Reihenfolge der Middleware ist wichtig. `UseOutputCache()` muss nach `UseCors()`, nach `UseAuthentication()` und nach `UseAuthorization()` stehen. Läuft sie vor der Autorisierung, kann die Middleware eine für einen anonymen Benutzer gecachte Antwort an einen authentifizierten ausliefern oder umgekehrt. In Razor-Pages- und Controller-Apps muss sie außerdem nach `UseRouting()` kommen. Der minimale `WebApplication`-Host verdrahtet das Routing für Sie, aber wenn Sie Authentifizierung hinzufügen, sind Sie für die Reihenfolge verantwortlich:

```csharp
// .NET 11, C# 14 -- correct ordering with auth
app.UseAuthentication();
app.UseAuthorization();
app.UseOutputCache();   // after auth, not before
```

## Eine Ablaufzeit mit einer benannten Policy festlegen

Das standardmäßige 60-Sekunden-Fenster ist selten das, was Sie wollen. Um es zu steuern, rufen Sie `.CacheOutput()` mit einem Inline-Builder auf oder definieren einmalig eine benannte Policy und referenzieren sie über den Namen. Benannte Policies halten `Program.cs` lesbar, wenn mehrere Endpunkte dieselben Einstellungen teilen:

```csharp
// .NET 11, C# 14
builder.Services.AddOutputCache(options =>
{
    options.AddPolicy("Short", policy => policy.Expire(TimeSpan.FromSeconds(10)));
    options.AddPolicy("Long", policy => policy.Expire(TimeSpan.FromMinutes(30)));
});
```

Wählen Sie dann pro Endpunkt eine Policy über den Namen aus:

```csharp
// .NET 11, C# 14
app.MapGet("/prices", GetPrices).CacheOutput("Short");
app.MapGet("/catalog", GetCatalog).CacheOutput("Long");
```

Wenn Sie die Konfiguration lieber direkt beim Endpunkt behalten möchten, macht die Inline-Form dasselbe ohne registrierte Policy:

```csharp
// .NET 11, C# 14
app.MapGet("/prices", GetPrices)
    .CacheOutput(policy => policy.Expire(TimeSpan.FromSeconds(10)));
```

Es gibt auch ein `[OutputCache]`-Attribut, falls Sie Attribute an einem Handler bevorzugen, was die Form ist, die Controller verwenden. An einem Minimal-API-Endpunkt sieht es aus wie `app.MapGet("/x", [OutputCache(PolicyName = "Short")] () => ...)`, aber das fluente `.CacheOutput("Short")` liest sich besser und ist die Konvention, der die meiste Minimal-API-Codebasis folgt.

## Eine ganze Route-Gruppe auf einmal cachen

Das Wiederholen von `.CacheOutput()` an jedem Endpunkt wird schnell mühsam. Da `MapGroup` einen `RouteGroupBuilder` zurückgibt, der Konventionen teilt, können Sie Output Caching an die Gruppe anhängen, und jeder Endpunkt darin erbt es. Das lässt sich sauber mit den Endpunkt-Modulen pro Ressource kombinieren, die in [Minimal-API-Endpunkte mit MapGroup organisieren](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) behandelt werden:

```csharp
// .NET 11, C# 14
var catalog = app.MapGroup("/catalog")
    .CacheOutput(policy => policy.Expire(TimeSpan.FromMinutes(5)).Tag("catalog"));

catalog.MapGet("/", GetAllProducts);
catalog.MapGet("/{id:int}", GetProduct);
```

Beide Endpunkte cachen nun für fünf Minuten und tragen den Tag `catalog`, was für den Invalidierungsschritt weiter unten wichtig ist.

## Den Cache-Schlüssel steuern, damit Sie nicht die falsche Antwort ausliefern

Standardmäßig ist der Cache-Schlüssel die vollständige URL: Schema, Host, Port, Pfad und der gesamte Query-String. Das bedeutet, dass `/search?q=widgets` und `/search?q=gadgets` automatisch separate Einträge sind, was in der Regel korrekt ist. Zwei Fälle benötigen jedoch eine explizite Behandlung.

Der erste: Sie möchten auf einem bestimmten Query-Wert variieren und den Rest ignorieren. `SetVaryByQuery` beschränkt den Schlüssel auf die von Ihnen benannten Query-Schlüssel, sodass Tracking-Parameter wie `utm_source` Ihren Cache nicht in Tausende nahezu identischer Einträge zersplittern:

```csharp
// .NET 11, C# 14 -- cache per culture, ignore everything else in the query
app.MapGet("/articles", GetArticles)
    .CacheOutput(policy => policy
        .Expire(TimeSpan.FromMinutes(10))
        .SetVaryByQuery("culture"));
```

Der zweite: Sie liefern unterschiedliche Inhalte basierend auf einem Request-Header aus, etwa `Accept-Language` oder einen benutzerdefinierten API-Versions-Header. Verwenden Sie `SetVaryByHeader`, damit jeder Header-Wert seinen eigenen Eintrag erhält:

```csharp
// .NET 11, C# 14
app.MapGet("/articles", GetArticles)
    .CacheOutput(policy => policy.SetVaryByHeader("Accept-Language"));
```

Für alles, was URL und Header nicht ausdrücken können, lässt `VaryByValue` Sie ein Schlüsselfragment aus dem `HttpContext` berechnen. So variieren Sie auf einer aus einem Claim aufgelösten Tenant-ID oder auf einem A/B-Bucket:

```csharp
// .NET 11, C# 14 -- separate cache entry per tenant
app.MapGet("/dashboard", GetDashboard)
    .CacheOutput(policy => policy.VaryByValue(context =>
        new KeyValuePair<string, string>(
            "tenant", context.User.FindFirst("tenant")?.Value ?? "public")));
```

Eine Warnung bei `VaryByValue` mit benutzerspezifischen Daten: Output Caching weigert sich standardmäßig, Antworten auf authentifizierte Requests überhaupt zu cachen, gerade um zu vermeiden, dass die Antwort eines Benutzers an einen anderen durchsickert. Wenn Sie das bewusst überschreiben (siehe den Abschnitt zur benutzerdefinierten Policy), ist die Variation auf einem benutzerspezifischen Wert das, was die Einträge getrennt hält, und es falsch zu machen ist ein Datenleck-Bug, kein Performance-Bug. Behandeln Sie authentifiziertes Output Caching als fortgeschrittenen Fall und testen Sie es gründlich.

## Bei Bedarf mit Tags invalidieren

Zeitbasierter Ablauf ist ein grobes Werkzeug. Wenn sich Ihr Katalog zweimal am Tag ändert, Sie aber fünf Minuten cachen, liefern Sie jedes Mal bis zu fünf Minuten lang veraltete Daten aus und laden die restliche Zeit sinnlos neu. Tags beheben das: Hängen Sie einen Tag an die Cache-Einträge an und invalidieren Sie dann per Tag in dem Moment, in dem sich die zugrunde liegenden Daten ändern.

Sie haben oben `.Tag("catalog")` an der Gruppe gesehen. Um sie zu löschen, injizieren Sie `IOutputCacheStore` und rufen `EvictByTagAsync` auf. Der natürliche Ort dafür ist innerhalb der Schreiboperation, die die Daten geändert hat, nicht ein separater Admin-Endpunkt:

```csharp
// .NET 11, C# 14
app.MapPost("/catalog", async (Product product, AppDbContext db, IOutputCacheStore cache) =>
{
    db.Products.Add(product);
    await db.SaveChangesAsync();

    // The catalog changed, so drop every cached catalog response.
    await cache.EvictByTagAsync("catalog", default);

    return Results.Created($"/catalog/{product.Id}", product);
});
```

Nun liefert der Cache sofortige Lesevorgänge und bleibt frisch: Ein Ablauf von fünf Minuten (oder sogar einer Stunde) ist ein Sicherheitsnetz, und die echte Invalidierung geschieht genau dann, wenn ein Schreibvorgang landet. Wenn Sie den `EvictByTagAsync`-Aufruf an denselben `SaveChanges` binden, der die Zeile mutiert, sehen Leser nie Daten, die älter sind als der letzte erfolgreiche Schreibvorgang. Das passt gut dazu, die Abfragen hinter diesen Schreibvorgängen aufzuspüren; wenn ein Lese-Endpunkt langsam genug ist, dass Sie zum Caching greifen, lohnt es sich, zuerst eine [N+1-Abfrage in EF Core](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) auszuschließen, denn das Cachen einer langsamen Abfrage verbirgt nur das Problem.

Sie können Tags auch deklarativ an einer Basis-Policy registrieren, was jeden passenden Endpunkt taggt, ohne jeden einzelnen anzufassen:

```csharp
// .NET 11, C# 14
builder.Services.AddOutputCache(options =>
{
    options.AddBasePolicy(policy => policy
        .With(c => c.HttpContext.Request.Path.StartsWithSegments("/catalog"))
        .Tag("catalog"));
});
```

## Basis-Policies gelten standardmäßig überall

`AddBasePolicy` unterscheidet sich von `AddPolicy` in einem wichtigen Punkt: Eine Basis-Policy gilt für alle Endpunkte (oder alle Endpunkte, die auf ihr `With`-Prädikat passen), ohne irgendeinen `.CacheOutput()`-Aufruf am Endpunkt. So legen Sie einen Standardablauf oder ein Tagging-Schema für die gesamte App fest:

```csharp
// .NET 11, C# 14 -- cache everything for 30 seconds unless overridden
builder.Services.AddOutputCache(options =>
{
    options.AddBasePolicy(policy => policy.Expire(TimeSpan.FromSeconds(30)));
});
```

Gehen Sie hier bewusst vor. Eine pauschale Basis-Policy cacht bereitwillig Endpunkte, die Sie nie cachen wollten. Beschränken Sie sie mit `.With(...)` auf ein Pfadpräfix oder bevorzugen Sie explizite `.CacheOutput()`-Aufrufe pro Endpunkt, wenn Ihre API cachebare Lesevorgänge und nicht cachebare Schreibvorgänge mischt, was die meisten tun.

## Was die Standard-Policy cacht und was nicht

Selbst nachdem Sie einen Endpunkt aktiviert haben, wendet Output Caching Schutzmechanismen an. Von Haus aus cacht es nur, wenn:

- Der Antwortstatus `HTTP 200` ist.
- Die Request-Methode `GET` oder `HEAD` ist.
- Die Antwort keine Cookies setzt (jedes `Set-Cookie` deaktiviert das Caching für diese Antwort).
- Der Request nicht authentifiziert ist.

Diese Regeln sind der Grund, warum `.CacheOutput()` an einem `POST`-Endpunkt scheinbar nichts tut: `POST` ist standardmäßig ausgeschlossen. Sie existieren, um Sie davor zu bewahren, versehentlich etwas Unsicheres zu cachen. Wenn Sie tatsächlich einen `POST` cachen müssen oder `301`-Antworten cachen oder authentifizierte Antworten cachen möchten, schreiben Sie eine benutzerdefinierte `IOutputCachePolicy` und aktivieren sie explizit:

```csharp
// .NET 11, C# 14 -- excerpt of a custom policy that allows POST
public sealed class CachePostPolicy : IOutputCachePolicy
{
    public static readonly CachePostPolicy Instance = new();

    ValueTask IOutputCachePolicy.CacheRequestAsync(
        OutputCacheContext context, CancellationToken cancellationToken)
    {
        var request = context.HttpContext.Request;
        var attempt = HttpMethods.IsGet(request.Method)
                   || HttpMethods.IsHead(request.Method)
                   || HttpMethods.IsPost(request.Method);

        context.EnableOutputCaching = true;
        context.AllowCacheLookup = attempt;
        context.AllowCacheStorage = attempt;
        context.AllowLocking = true;
        context.CacheVaryByRules.QueryKeys = "*";
        return ValueTask.CompletedTask;
    }

    ValueTask IOutputCachePolicy.ServeFromCacheAsync(
        OutputCacheContext context, CancellationToken cancellationToken)
        => ValueTask.CompletedTask;

    ValueTask IOutputCachePolicy.ServeResponseAsync(
        OutputCacheContext context, CancellationToken cancellationToken)
        => ValueTask.CompletedTask;
}
```

Registrieren Sie sie als benannte Policy mit `options.AddPolicy("CachePost", CachePostPolicy.Instance)` und wählen Sie sie mit `.CacheOutput("CachePost")` aus. Einen `POST` zu cachen ist ungewöhnlich, und Sie sollten einen konkreten Grund haben, aber der Erweiterungspunkt ist vorhanden.

## Stampede-Schutz ist standardmäßig aktiv

Wenn ein heißer Cache-Eintrag abläuft und hundert Requests gleichzeitig eintreffen, lässt ein naiver Cache alle hundert einen Miss haben und gleichzeitig Ihre Datenbank hämmern. Das ist eine Cache-Stampede oder ein Thundering Herd. Output Caching mildert das mit Resource Locking: Wenn ein Eintrag gerade generiert wird, warten gleichzeitige Requests für denselben Schlüssel darauf, dass der erste fertig wird, anstatt dass jeder seinen eigenen generiert. Das ist standardmäßig aktiv und einer der konkreten Vorteile gegenüber handgeschriebenem `IMemoryCache`-Code, der das nicht tut, es sei denn, Sie bauen es selbst.

Sie können das Locking pro Policy mit `SetLocking(false)` ausschalten, wenn ein Endpunkt günstig zu generieren ist und Sie es vorziehen, dass Requests nicht warten:

```csharp
// .NET 11, C# 14
app.MapGet("/cheap", GetCheapThing)
    .CacheOutput(policy => policy.Expire(TimeSpan.FromSeconds(5)).SetLocking(false));
```

Lassen Sie es für alles Aufwändige aktiv. Stampede-Schutz ist genau das, was Sie unter Last wollen, und es ist dieselbe Klasse von Problem, die [HybridCache](/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/) für Datencaching statt Caching ganzer Antworten löst.

## Günstige Revalidierung mit ETags

Output Caching arbeitet außerdem mit bedingten HTTP-Requests zusammen. Wenn Ihr Handler einen `ETag`-Header setzt, beantwortet die Middleware ein passendes `If-None-Match` mit einem `304 Not Modified` und einem leeren Body, anstatt die gesamte Nutzlast erneut zu senden. Für eine große Antwort, die an einen Client ausgeliefert wird, der sie bereits hat, verwandelt das eine vollständige Übertragung in ein paar Bytes:

```csharp
// .NET 11, C# 14
app.MapGet("/report", async (HttpContext context) =>
{
    context.Response.Headers.ETag = $"\"{ComputeReportVersion()}\"";
    await WriteReport(context);
}).CacheOutput();
```

Über die Aktivierung von Output Caching hinaus ist keine zusätzliche Konfiguration nötig. Dasselbe funktioniert mit `If-Modified-Since` gegen die Erstellungszeit des Cache-Eintrags.

## Die Limits abstimmen und, wenn Sie horizontal skalieren, zu Redis wechseln

Zwei `OutputCacheOptions`-Limits sollten Sie kennen, bevor Sie ausliefern. `MaximumBodySize` ist standardmäßig 64 MB: Eine Antwort, die größer ist, wird nie gecacht, was ein sinnvoller Standard ist, aber ein stiller, falls Sie sich fragten, warum ein großer Export nie cacht. `SizeLimit` ist standardmäßig 100 MB an gesamtem Cache-Speicher, ab dem neue Einträge darauf warten, dass alte verdrängt werden. `DefaultExpirationTimeSpan` sind die 60 Sekunden, die Sie erhalten, wenn eine Policy kein explizites `Expire` setzt.

Der Standard-Store ist In-Process-Speicher, was bedeutet, dass jede Serverinstanz ihren eigenen Cache hat und dieser bei einem Neustart verdampft. Hinter einem Load Balancer mit mehreren Instanzen ist das für leselastige Endpunkte oft in Ordnung, aber es bedeutet, dass eine `tag`-Invalidierung auf einem Knoten die anderen nicht löscht. Wenn Sie einen geteilten Cache benötigen, der Neustarts überlebt und über Knoten hinweg konsistent invalidiert, fügen Sie den Redis-Store hinzu. Es ist ein separates Paket:

```bash
dotnet add package Microsoft.AspNetCore.OutputCaching.StackExchangeRedis
```

```csharp
// .NET 11, C# 14
builder.Services.AddStackExchangeRedisOutputCache(options =>
{
    options.Configuration = builder.Configuration.GetConnectionString("Redis");
    options.InstanceName = "MyApp";
});

builder.Services.AddOutputCache(options =>
{
    options.AddBasePolicy(policy => policy.Expire(TimeSpan.FromSeconds(30)));
});
```

Beachten Sie, dass die Methode `AddStackExchangeRedisOutputCache` heißt, nicht das ähnlich benannte `AddStackExchangeRedisCache`, das für `IDistributedCache` verwendet wird. Diese Unterscheidung ist wichtig, denn Microsoft rät ausdrücklich davon ab, Output Caching mit einem einfachen `IDistributedCache` zu hinterlegen: Diesem Interface fehlen die atomaren Operationen, von denen Tag-basierte Invalidierung abhängt, sodass Tags nicht zuverlässig invalidieren würden. Verwenden Sie den eingebauten Redis-Output-Cache-Store oder einen benutzerdefinierten `IOutputCacheStore`, nicht `IDistributedCache`.

## Die Form zum Merken

Output Caching in einer Minimal API läuft auf einen kleinen, komponierbaren Satz von Teilen hinaus. Registrieren mit `AddOutputCache`, `UseOutputCache` nach Ihrer Auth-Middleware einfügen und Endpunkte mit `.CacheOutput()` oder einem `.CacheOutput()` auf Gruppenebene aktivieren. Greifen Sie zu `Expire`, um das Fenster festzulegen, zu `SetVaryByQuery` und `SetVaryByHeader`, um die Schlüssel korrekt zu halten, und zu `Tag` plus `EvictByTagAsync`, um in dem Moment zu invalidieren, in dem sich Ihre Daten ändern, statt einen Timer abzuwarten. Lassen Sie den Stampede-Schutz für aufwändige Arbeit aktiv, respektieren Sie die standardmäßigen Schutzmechanismen, die authentifizierte und Cookie-tragende Antworten aus dem Cache heraushalten, und tauschen Sie den In-Memory-Store nur dann gegen Redis, wenn Sie tatsächlich mehr als eine Instanz betreiben. Das deckt die große Mehrheit realer APIs ab, und jede Zeile oben läuft unverändert auf .NET 8 bis .NET 11.

## Verwandt

- [Minimal-API-Endpunkte mit MapGroup in ASP.NET Core 11 organisieren](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [HybridCache in ASP.NET Core 11 mit Redis als L2-Cache verwenden](/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/)
- [HybridCache vs. IMemoryCache vs. IDistributedCache in .NET 11](/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/)
- [N+1-Abfragen in EF Core 11 erkennen](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [Pro-Endpunkt-Rate-Limiting in ASP.NET Core 11 hinzufügen](/2026/04/how-to-add-per-endpoint-rate-limiting-in-aspnetcore-11/)

## Quellen

- [Output caching middleware in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/output)
- [Overview of caching in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/overview)
- [IOutputCacheStore.EvictByTagAsync (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.outputcaching.ioutputcachestore.evictbytagasync)
- [OutputCachePolicyBuilder (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.outputcaching.outputcachepolicybuilder)
