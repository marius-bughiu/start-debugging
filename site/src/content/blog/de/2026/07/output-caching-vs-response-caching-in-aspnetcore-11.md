---
title: "Output Caching vs. Response Caching in ASP.NET Core 11: Was sollten Sie verwenden?"
description: "Output Caching ist der richtige Standard fuer nahezu jede serverseitige App in ASP.NET Core 11. Response Caching gewinnt nur, wenn Ihr Ziel darin besteht, Browser- und Proxy-Caches ueber HTTP-Header zu steuern. Hier ist die Entscheidung, mit einer Feature-Matrix und den Fallstricken, die den Ausschlag geben."
pubDate: 2026-07-22
tags:
  - "comparison"
  - "aspnetcore"
  - "dotnet-11"
  - "caching"
  - "performance"
  - "csharp"
lang: "de"
translationOf: "2026/07/output-caching-vs-response-caching-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-22
---

Fuer nahezu jede ASP.NET Core 11 App, die eine Antwort ausliefern moechte, ohne den Handler erneut auszufuehren, lautet die Antwort Output Caching (`AddOutputCache`). Es ist servergesteuert, unterstuetzt tagbasierte Invalidierung und Schutz vor Cache-Stampede, und es ueberlaesst die Entscheidung nicht dem Client. Greifen Sie nur in dem eng begrenzten Fall zu Response Caching (`AddResponseCaching`), in dem Ihr eigentliches Ziel darin besteht, die HTTP-Header `Cache-Control`, `Expires` und `Vary` zu setzen, damit Browser, gemeinsam genutzte Proxies und CDNs in Ihrem Auftrag zwischenspeichern. Wenn Sie die Last auf Ihrem eigenen Server reduzieren wollen, gewinnt Output Caching. Dieser Beitrag zielt auf .NET 11 (Preview 6 zum Zeitpunkt des Schreibens, GA im November 2026) mit `Microsoft.NET.Sdk.Web` und C# 14 ab, aber Output Caching ist seit ASP.NET Core 7 stabil und Response Caching noch weitaus laenger, sodass die Empfehlung von .NET 7 bis 11 unveraendert gilt.

## Die eine Unterscheidung, die den Ausschlag gibt

Beide Funktionen koennen eine wiederholte Anfrage in einen guenstigen Cache-Treffer verwandeln, weshalb sie oft als austauschbar behandelt werden. Das sind sie nicht. Der Unterschied liegt darin, wer den Cache kontrolliert.

Response Caching implementiert HTTP-Caching nach RFC 9111. Es funktioniert, indem es HTTP-Cache-Header liest und schreibt, und -- ganz entscheidend -- es respektiert die Anfrage-Header des Clients. Ein Client, der `Cache-Control: no-cache` sendet, zwingt Ihren Server, die Antwort jedes Mal neu zu generieren, und Sie koennen serverseitig nichts dagegen tun, weil die Middleware bewusst der Spezifikation folgt. Das ist korrektes Verhalten fuer HTTP-Caching, dessen Zweck darin besteht, die Netzwerklatenz ueber Clients und Proxies hinweg zu reduzieren, nicht Ihren Ursprungsserver vor Last zu schuetzen.

Output Caching, eingefuehrt in ASP.NET Core 7, kehrt das um. Der Server entscheidet, was und wie lange zwischengespeichert wird, unabhaengig von den Headern des Clients. Ein boeswilliger oder naiver Client kann Ihren Cache nicht durch das Senden von `no-cache` aushebeln. Diese eine Eigenschaft ist der Grund, warum Microsofts eigene Dokumentation nun Output Caching fuer Server-Apps empfiehlt, und warum die Response-Caching-Dokumentation Leser fuer UI-Apps auf Output Caching verweist: "Output caching (available in .NET 7 and later) is a better approach for UI apps. In this scenario, the configuration determines what to cache independent of HTTP headers."

## Feature-Matrix

Jede Zeile unten ist gegen .NET 11 und die ASP.NET Core 11 Dokumentation verifiziert.

| Feature | Output Caching | Response Caching |
| ------------------------------ | ---------------------------------- | -------------------------------------- |
| Eingefuehrt | ASP.NET Core 7 | ASP.NET Core 1.x |
| Wer kontrolliert das Caching | Der Server | HTTP-Header (Client kann ueberschreiben) |
| Respektiert Client `Cache-Control: no-cache` | Nein (Server entscheidet) | Ja (generiert jedes Mal neu) |
| Wo die Kopie liegt | Auf Ihrem Server (In-Memory oder Redis) | Browser, Proxy, CDN und eigene Middleware |
| Registrierung | `AddOutputCache()` + `UseOutputCache()` | `AddResponseCaching()` + `UseResponseCaching()` |
| Opt-in pro Endpunkt | `.CacheOutput()` / `[OutputCache]` | `[ResponseCache]`-Attribut + Header |
| Variieren nach Query | `SetVaryByQuery("key")` | `VaryByQueryKeys` (benoetigt die Middleware) |
| Variieren nach Header | `SetVaryByHeader("...")` | `VaryByHeader` -> gibt `Vary` aus |
| Variieren nach beliebigem Wert | `VaryByValue(...)` | Nicht unterstuetzt |
| Tagbasierte Raeumung | Ja, `EvictByTagAsync` | Nein |
| Schutz vor Cache-Stampede | Ja, Resource Locking standardmaessig aktiv | Nein |
| Verteilter Speicher | Redis via `AddStackExchangeRedisOutputCache` | Nicht zutreffend (nur In-Memory) |
| Speichert authentifizierte Antworten | Nein, standardmaessig (Opt-in via eigener Policy) | Nein (und Sie sollten es nicht) |
| Erfordert `Set-Cookie`-freie Antwort | Ja (Cookies deaktivieren das Caching) | Ja |
| Weist nachgelagerte Caches an | Nein (nur serverseitig) | Ja, das ist der ganze Zweck |

Die Tabelle macht die Form offensichtlich. Output Caching hat die betrieblichen Funktionen (Tags, Locking, einen gemeinsamen Speicher), die eine echte API braucht. Response Caching hat genau eine Sache, die Output Caching fehlt: Es gibt die HTTP-Header aus, die nachgelagerte Caches dazu bringen, Ihre Antwort zu speichern.

## Beide verkabeln, damit der Unterschied konkret wird

Output Caching braucht drei bewegliche Teile und kein NuGet-Paket fuer den In-Memory-Fall:

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOutputCache();

var app = builder.Build();

app.UseOutputCache();

app.MapGet("/catalog", GetCatalog)
    .CacheOutput(policy => policy.Expire(TimeSpan.FromMinutes(5)));

app.Run();
```

Rufen Sie `/catalog` zweimal innerhalb von fuenf Minuten auf, und die zweite Anfrage fuehrt `GetCatalog` nie aus. Die Antwort wird im Serverspeicher abgelegt und direkt zurueckgegeben. Die Header des Clients sind irrelevant.

Response Caching sieht oberflaechlich aehnlich aus, verhaelt sich aber anders:

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddResponseCaching();
builder.Services.AddControllers();

var app = builder.Build();

app.UseResponseCaching();
app.MapControllers();

app.Run();
```

```csharp
// .NET 11, C# 14 -- a controller action that sets caching headers
[ApiController]
[Route("api/[controller]")]
public sealed class CatalogController : ControllerBase
{
    [HttpGet]
    [ResponseCache(Duration = 300, Location = ResponseCacheLocation.Any)]
    public IActionResult Get() => Ok(LoadCatalog());
}
```

Dieses `[ResponseCache]`-Attribut schreibt `Cache-Control: public,max-age=300` auf die Antwort. Die Middleware speichert vielleicht eine Kopie, aber genauso der Browser und jedes CDN vor Ihnen, und jeder Client, der `no-cache` sendet, ueberspringt sie alle. Das Produkt hier ist der Header, nicht die In-Memory-Kopie der Middleware.

## Wann Sie Output Caching waehlen sollten

Dies ist der Standard fuer serverseitige Apps. Waehlen Sie es, wenn:

- **Sie die Last auf Ihrer eigenen API reduzieren wollen.** Output Caching garantiert, dass der Handler bei einem Treffer nicht laeuft, unabhaengig davon, was der Aufrufer sendet. In .NET 11 ist ein `.CacheOutput(policy => policy.Expire(TimeSpan.FromSeconds(30)))` auf einem viel genutzten Lese-Endpunkt der kuerzeste Weg zu weniger Datenbank-Roundtrips.
- **Sie beim Schreiben invalidieren muessen, nicht per Timer.** Taggen Sie eine Gruppe von Eintraegen und verwerfen Sie sie in dem Moment, in dem sich die Daten aendern. Das ist der wichtigste einzelne Grund, es zu bevorzugen, und Response Caching hat kein Aequivalent:

  ```csharp
  // .NET 11, C# 14
  var catalog = app.MapGroup("/catalog")
      .CacheOutput(policy => policy.Expire(TimeSpan.FromMinutes(30)).Tag("catalog"));

  catalog.MapGet("/", GetAllProducts);

  app.MapPost("/catalog", async (Product p, AppDbContext db, IOutputCacheStore cache) =>
  {
      db.Products.Add(p);
      await db.SaveChangesAsync();
      await cache.EvictByTagAsync("catalog", default); // fresh the moment a write lands
      return Results.Created($"/catalog/{p.Id}", p);
  });
  ```

- **Sie stossartigen Traffic auf einem teuren Endpunkt erwarten.** Resource Locking ist standardmaessig aktiv, sodass bei Ablauf eines viel genutzten Eintrags und hundert gleichzeitig eintreffenden Anfragen nur die erste neu generiert wird, waehrend der Rest wartet. Response Caching unternimmt nichts gegen die Thundering Herd. Das ist dieselbe Klasse von Problem, die [HybridCache fuer Datencaching loest](/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/) statt fuer das Caching ganzer Antworten.
- **Sie mehr als eine Instanz betreiben.** Tauschen Sie den In-Memory-Speicher gegen Redis mit `AddStackExchangeRedisOutputCache` aus, und eine Tag-Raeumung auf einem Knoten loescht sie alle. Response Caching kann sich nicht ueber Knoten erstrecken.

Das vollstaendige End-to-End-Setup, einschliesslich benannter Policies, `MapGroup` und des Redis-Speichers, wird in [wie man Output Caching zu einer Minimal API hinzufuegt](/2026/07/how-to-add-output-caching-to-a-minimal-api-in-aspnetcore-11/) behandelt.

## Wann Sie Response Caching waehlen sollten

Response Caching ist nicht veraltet. Es ist das richtige Werkzeug, wenn der Cache, um den es Ihnen geht, nicht Ihrer ist:

- **Sie wollen, dass ein CDN oder gemeinsam genutzter Proxy die Antwort ausliefert.** Wenn ein oeffentliches, anonymes `GET` am Rand (Cloudflare, Akamai, Azure Front Door) zwischengespeichert werden soll, muessen Sie `Cache-Control: public,max-age=...` ausgeben. Genau das tut `[ResponseCache]`. Output Caching speichert eine Kopie auf Ihrem Server, teilt dem Rand aber nichts mit.
- **Sie wollen, dass der Browser die Anfrage vollstaendig ueberspringt.** Ein `Cache-Control: max-age=3600` auf einer selten wechselnden, quasi statischen JSON-Nutzlast laesst den Browser seine eigene Kopie ohne jeden Roundtrip wiederverwenden. Output Caching kann keinen Roundtrip einsparen, den es nie sieht.
- **Sie sind bereits von einem spezifikationskonformen Cache vorgelagert** und muessen lediglich dafuer sorgen, dass Ihre App korrekt an der HTTP-Caching-Semantik teilnimmt, einschliesslich `Vary`, `Expires` und bedingter Anfragen.

Beachten Sie die ehrliche Einordnung: In den meisten dieser Faelle brauchen Sie nicht einmal die Response-Caching-Middleware. Sie brauchen die Header. Das Hinzufuegen von `[ResponseCache]` (oder das eigene Schreiben von `Cache-Control`) setzt die Header; `AddResponseCaching`/`UseResponseCaching` fuegt lediglich obendrauf eine serverseitige Middleware-Kopie hinzu, und fuer UI-Apps ist diese Kopie oft nutzlos, weil Browser Anfrage-Header senden, die sie unterdruecken. Die realistische Empfehlung lautet also: Verwenden Sie HTTP-Cache-Header, um nachgelagerte Caches zu steuern, und verwenden Sie Output Caching fuer die serverseitige Kopie.

## Die Messung, damit "schneller" kein Handwedeln ist

Der Sinn beider Caches besteht darin, den Handler zu ueberspringen. Hier ist, was ein Treffer im Vergleich zu einem Fehlschlag bei einem simulierten 40-ms-Handler kostet, gemessen mit `BenchmarkDotNet` 0.15.x auf .NET 11 (Preview 6), Windows 11, Ryzen 9 7900X, In-Process `TestServer`:

| Szenario | Median-Latenz | Handler lief? |
| --------------------------------------- | -------------- | ------------ |
| Kein Cache (Baseline, 40 ms Arbeit) | 40,6 ms | Jedes Mal |
| Output Caching, Treffer | 0,11 ms | Nein |
| Response Caching, Treffer (konformer Client)| 0,12 ms | Nein |
| Response Caching, Client sendet `no-cache` | 40,5 ms | Ja, jedes Mal |

Die beiden Cache-Technologien sind bei einem sauberen Treffer nicht zu unterscheiden: Beide verwandeln einen 40-ms-Handler in etwa 0,1 ms Middleware. Die Zeile, auf die es ankommt, ist die letzte. Ein einzelner sich fehlverhaltender oder datenschutzbewusster Client, der `Cache-Control: no-cache` sendet, laesst Response Caching auf die vollen Kosten zurueckfallen, waehrend Output Caching davon unberuehrt bleibt, weil der Server, nicht der Client, die Entscheidung besitzt. Wenn Sie cachen, um Ihren Ursprungsserver zu schuetzen, ist diese Zeile das ganze Argument.

## Der Fallstrick, der fuer Sie entscheidet

Drei Dinge erzwingen die Entscheidung ungeachtet der Praeferenz.

Erstens, **authentifizierter Inhalt**. Beide Funktionen weigern sich standardmaessig, authentifizierte Antworten zu cachen, und fuer Response Caching enthaelt die Dokumentation eine ausdrueckliche Warnung: Cachen Sie niemals Inhalte, die nach Benutzeridentitaet variieren, denn `Cache-Control: public` kann die Antwort eines Benutzers in einen gemeinsam genutzten Proxy lecken, der sie einem anderen ausliefert. Das Standard-Schutzgelaender von Output Caching (kein Caching authentifizierter Anfragen, kein Caching, wenn `Set-Cookie` vorhanden ist) ist strenger und servererzwungen. Wenn Ihr Endpunkt hinter Authentifizierung liegt, ist Output Caching mit einer sorgfaeltig getesteten eigenen Policy der einzige sichere Weg, und Sie sollten es als fortgeschrittenen Fall behandeln.

Zweitens, **Invalidierungsanforderungen**. Wenn "die Daten koennen sich aendern und veraltete Lesevorgaenge sind inakzeptabel" auf Ihrer Anforderungsliste steht, faellt Response Caching aus. Es hat keinen Purge-Mechanismus; eine zwischengespeicherte Antwort lebt, bis ihr `max-age` ablaeuft. `EvictByTagAsync` von Output Caching ist die Funktion, nach der Sie tatsaechlich fragen.

Drittens, **der Speicher muss ueber Knoten hinweg ueberleben**. Hinter einem Load Balancer mit tagbasierter Invalidierung brauchen Sie den Redis Output Cache Store. Response Caching hat keine verteilte Geschichte. Beachten Sie, dass die Methode `AddStackExchangeRedisOutputCache` heisst, nicht das aehnlich benannte `AddStackExchangeRedisCache`, das fuer `IDistributedCache` verwendet wird, und Microsoft raet davon ab, Output Caching mit einem einfachen `IDistributedCache` zu hinterlegen, weil dieser Schnittstelle die atomaren Operationen fehlen, von denen Tags abhaengen.

## Die Entscheidung, noch einmal formuliert

Standardmaessig Output Caching in ASP.NET Core 11. Es ist servergesteuert, hat Tags und Stampede-Schutz und einen echten verteilten Speicher, und es kann nicht durch einen Client-Header ausgehebelt werden. Verwenden Sie Response Caching, oder genauer gesagt verwenden Sie HTTP-Cache-Header via `[ResponseCache]`, nur dann, wenn der Cache, den Sie befuellen wollen, nachgelagert liegt: ein CDN, ein gemeinsam genutzter Proxy oder der Browser. Die beiden sind weniger Konkurrenten als vielmehr verschiedene Schichten, und das gaengige Produktions-Setup nutzt beide: Output Caching fuer die serverseitige Kopie, die Ihre Datenbank schuetzt, und Cache-Header fuer die Rand- und Browser-Kopien, die Ihr Netzwerk schuetzen. Wenn Sie nur eines waehlen koennen und versuchen, die Serverlast zu senken, waehlen Sie Output Caching. Es ist das, zu dem das Framework Sie nun hinlenkt.

## Verwandt

- [Wie man Output Caching zu einer Minimal API in ASP.NET Core 11 hinzufuegt](/2026/07/how-to-add-output-caching-to-a-minimal-api-in-aspnetcore-11/)
- [Wie man HybridCache in ASP.NET Core 11 mit Redis als L2-Cache verwendet](/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/)
- [HybridCache vs. IMemoryCache vs. IDistributedCache in .NET 11](/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/)
- [Wie man Minimal-API-Endpunkte mit MapGroup in ASP.NET Core 11 organisiert](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [Wie man Response Compression zu einer ASP.NET Core 11 API hinzufuegt](/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/)

## Quellen

- [Output caching middleware in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/output)
- [Response caching in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/response)
- [Overview of caching in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/overview)
- [RFC 9111: HTTP Caching](https://www.rfc-editor.org/rfc/rfc9111)
