---
title: "HybridCache in ASP.NET Core 11 mit Redis als L2-Cache verwenden"
description: "Verbinden Sie HybridCache mit einem Redis-L2 in ASP.NET Core 11: Registrieren Sie den Dienst, fügen Sie den StackExchange-Redis-Distributed-Cache hinzu und lassen Sie GetOrCreateAsync einen zweistufigen Cache mit integriertem Stampede-Schutz und Tag-Invalidierung liefern."
pubDate: 2026-06-07
template: how-to
tags:
  - "aspnetcore"
  - "dotnet"
  - "performance"
lang: "de"
translationOf: "2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache"
translatedBy: "claude"
translationDate: 2026-06-07
---

Um HybridCache mit Redis als Cache der zweiten Stufe in ASP.NET Core 11 zu verwenden, installieren Sie `Microsoft.Extensions.Caching.Hybrid`, rufen Sie `builder.Services.AddHybridCache()` auf und registrieren Sie dann einen Redis-gestützten `IDistributedCache` mit `AddStackExchangeRedisCache(...)`. HybridCache übernimmt diesen `IDistributedCache` automatisch als sein L2. Danach liest jeder `GetOrCreateAsync`-Aufruf zuerst L1 (In-Process-Speicher), greift auf L2 (Redis) zurück und ruft Ihre Factory nur bei einem vollständigen Fehlschlag auf. Sie erhalten Stampede-Schutz und Tag-basierte Invalidierung kostenlos, ohne Cache-Aside-Boilerplate. Dieser Beitrag durchläuft die vollständige Einrichtung, die Optionen, die wirklich zählen, und die Mehrinstanzen-Falle, über die viele stolpern.

Alle Beispiele zielen auf .NET 11, ASP.NET Core 11 und C# 14 ab und verwenden `Microsoft.Extensions.Caching.Hybrid` 9.x (das Paket wurde mit .NET 9 als GA veröffentlicht und ist dasselbe Paket, das Sie unter .NET 11 verwenden). Die Bibliothek selbst unterstützt Laufzeiten bis hinunter zu .NET Framework 4.7.2 und .NET Standard 2.0, sodass derselbe Code in älteren Hosts funktioniert.

## Warum HybridCache überhaupt existiert

Wenn Sie schon einmal einen Distributed Cache ausgeliefert haben, haben Sie diese Schleife von Hand geschrieben: `IMemoryCache` prüfen, Fehlschlag, `IDistributedCache` (Redis) prüfen, Fehlschlag, deserialisieren, die Datenbank aufrufen, serialisieren, in beide Schichten zurückschreiben, zurückgeben. Multiplizieren Sie das mit jedem zwischengespeicherten Wert und Sie haben einen Stapel nahezu identischen Cache-Aside-Codes, jede Kopie mit ihrem eigenen subtilen Fehler. Die beiden klassischen Fehler sind ein fehlender Stampede-Schutz (hundert Anfragen treffen gleichzeitig auf einen abgelaufenen Schlüssel und hämmern alle auf die Datenbank ein) und eine inkonsistente Serialisierung zwischen den beiden Schichten.

HybridCache reduziert das alles auf einen einzigen Aufruf. Es ist ein zweistufiger Cache: L1 ist ein In-Process-`MemoryCache` (schnell, pro Server, beim Neustart verloren), und L2 ist jeder `IDistributedCache`, den Sie registrieren (Redis, SQL Server, Postgres, Garnet). Der entscheidende Punkt für diesen Beitrag: Sie konfigurieren das L2 nicht direkt an HybridCache. HybridCache ermittelt den `IDistributedCache` aus dem Dependency-Injection-Container. Registrieren Sie einen Redis-Distributed-Cache und HybridCache verwendet ihn automatisch als L2.

## Redis als L2-Cache anbinden

Hier ist die durchgängige Einrichtung als nummerierte Prozedur.

1. Installieren Sie die beiden Pakete. Das erste bringt HybridCache; das zweite ist der StackExchange-basierte Redis-`IDistributedCache`.

   ```dotnetcli
   dotnet add package Microsoft.Extensions.Caching.Hybrid
   dotnet add package Microsoft.Extensions.Caching.StackExchangeRedis
   ```

2. Speichern Sie die Redis-Verbindungszeichenfolge in der Konfiguration. Halten Sie sie mit einer user-secrets-Datei in der Entwicklung aus der Versionsverwaltung heraus:

   ```json
   {
     "ConnectionStrings": {
       "RedisConnectionString": "localhost:6379"
     }
   }
   ```

3. Registrieren Sie den Redis-`IDistributedCache`. Dies ist das L2. `AddStackExchangeRedisCache` legt einen `IDistributedCache` in die Dependency Injection, der von Ihrer Redis-Instanz gestützt wird.

   ```csharp
   // .NET 11, ASP.NET Core 11, C# 14
   var builder = WebApplication.CreateBuilder(args);

   builder.Services.AddStackExchangeRedisCache(options =>
   {
       options.Configuration =
           builder.Configuration.GetConnectionString("RedisConnectionString");
   });
   ```

4. Registrieren Sie HybridCache. Es findet den `IDistributedCache` aus Schritt 3 und verwendet ihn als L2. Ohne registrierten `IDistributedCache` funktioniert HybridCache weiterhin als reiner L1-In-Process-Cache, sodass diese einzelne Zeile das Einzige ist, was das zweistufige Verhalten "einschaltet".

   ```csharp
   // .NET 11, ASP.NET Core 11
   builder.Services.AddHybridCache();

   var app = builder.Build();
   ```

Das ist die gesamte Verdrahtung. Die Reihenfolge zwischen den Schritten 3 und 4 spielt keine Rolle, da die Dependency Injection den `IDistributedCache` verzögert auflöst, wenn HybridCache ihn zum ersten Mal benötigt. Es gibt keinen `UseRedis()`-Aufruf an HybridCache und keine L2-Einstellung, die auf Redis zeigt. Die Ermittlung erfolgt implizit über `IDistributedCache`, was genau der Grund ist, warum derselbe HybridCache-Code gegen Redis, SQL Server oder ganz ohne L2 läuft, ohne eine Zeile zu ändern.

## Lesen und Schreiben mit GetOrCreateAsync

`GetOrCreateAsync` ist die API, die Sie zu 95 % der Zeit verwenden werden. Injizieren Sie `HybridCache` und rufen Sie es mit einem Schlüssel und einer Factory auf:

```csharp
// .NET 11, C# 14
public sealed class ProductService(HybridCache cache, ProductDbContext db)
{
    public async Task<Product?> GetProductAsync(int id, CancellationToken ct = default)
    {
        return await cache.GetOrCreateAsync(
            $"product:{id}",                       // unique cache key
            async cancel => await db.Products
                .AsNoTracking()
                .FirstOrDefaultAsync(p => p.Id == id, cancel),
            cancellationToken: ct);
    }
}
```

Beim ersten Aufruf für `product:42` verfehlt HybridCache L1, verfehlt L2, führt die Factory aus, serialisiert das Ergebnis, schreibt es sowohl in Redis als auch in den In-Process-Cache und gibt zurück. Der nächste Aufruf auf demselben Server trifft L1 und berührt Redis nie. Ein Aufruf auf einem anderen Server in Ihrem Cluster verfehlt L1, trifft aber L2 (Redis), überspringt also die Datenbank und füllt sein eigenes L1 nach. Das ist der Vorteil der zwei Stufen: Heiße Schlüssel bleiben In-Process, warme Schlüssel bleiben in Redis, und die Datenbank sieht nur dann einen Fehlschlag, wenn beide Schichten kalt sind.

Beachten Sie die interpolierte Zeichenfolge, die direkt innerhalb des Aufrufs übergeben wird. Die Dokumentation empfiehlt, den Schlüssel auf diese Weise inline zu schreiben, anstatt ihn zuerst in eine lokale Variable zu bauen, da dies künftigen Versionen der Bibliothek erlaubt, die Zeichenfolgen-Allokation in manchen Fällen zu vermeiden. Es gibt auch eine zweite `GetOrCreateAsync`-Überladung, die ein `state`-Tupel plus ein `static`-Lambda entgegennimmt, was Closure-Allokationen auf heißen Pfaden vermeidet:

```csharp
// .NET 11, C# 14 - allocation-conscious overload
return await cache.GetOrCreateAsync(
    $"product:{id}",
    (db, id),
    static async (state, cancel) => await state.db.Products
        .AsNoTracking()
        .FirstOrDefaultAsync(p => p.Id == state.id, cancel),
    cancellationToken: ct);
```

Verwenden Sie standardmäßig die zustandslose Überladung. Greifen Sie nur dann zur zustandsbehafteten, wenn ein Profiler Ihnen sagt, dass die Closure-Allokation ins Gewicht fällt, was neben den Kosten einer Datenbank-Rundreise selten ist.

## Der Stampede-Schutz ist die Funktion, die Sie wirklich kaufen

Dies ist der Teil, der von Hand schwer richtig hinzubekommen ist. Wenn ein populärer Schlüssel abläuft und ein Schub von Anfragen eintrifft, lässt ein naives Cache-Aside jede Anfrage fehlschlagen und gleichzeitig die Factory aufrufen. HybridCache garantiert, dass für einen gegebenen Schlüssel auf einem gegebenen Server nur ein Aufrufer die Factory ausführt. Der Rest wartet auf dasselbe Ergebnis.

```csharp
// 100 concurrent requests for the same cold key
// -> exactly 1 factory invocation, 99 awaiters share the result
var tasks = Enumerable.Range(0, 100)
    .Select(_ => service.GetProductAsync(42, ct));
var results = await Task.WhenAll(tasks);
```

Eine Feinheit: Der `CancellationToken`, den Sie übergeben, repräsentiert das kombinierte Abbrechen aller eingereihten Aufrufer. Die Factory läuft weiter, solange mindestens ein Aufrufer das Ergebnis noch möchte, sodass ein einzelner Client, der die Verbindung trennt, die gemeinsame Arbeit für alle anderen nicht abbricht.

Der ehrliche Vorbehalt: Dieser Schutz gilt pro Instanz. HybridCache liefert keinen verteilten Lock, sodass in einem Cluster aus drei Servern ein kalter Schlüssel bis zu drei Factory-Aufrufe auslösen kann, einen pro Server, nicht einen über die gesamte Flotte. Für die meisten Workloads ist das in Ordnung. Wenn Sie wirklich clusterweites Single-Flight benötigen, brauchen Sie einen externen verteilten Lock oder einen Drittanbieter-Cache wie FusionCache, der einen darüberlegt. Nehmen Sie nicht an, dass "Stampede-Schutz" "eine Datenbankabfrage über alle Server" bedeutet.

## Ablauf: die zwei Uhren, die Sie steuern

`HybridCacheEntryOptions` stellt zwei Ablaufeinstellungen bereit, und sie zu verwechseln ist der häufigste Konfigurationsfehler:

- `Expiration` ist die Gesamtlebensdauer, einschließlich der L2-Kopie (Redis).
- `LocalCacheExpiration` ist die Lebensdauer des In-Process-L1. Sie ist üblicherweise kürzer als `Expiration`.

```csharp
// .NET 11 - global defaults
builder.Services.AddHybridCache(options =>
{
    options.MaximumPayloadBytes = 1024 * 1024; // 1 MB, the default
    options.MaximumKeyLength = 1024;           // chars, the default
    options.DefaultEntryOptions = new HybridCacheEntryOptions
    {
        Expiration = TimeSpan.FromMinutes(5),       // L2 + overall
        LocalCacheExpiration = TimeSpan.FromMinutes(1) // L1 only
    };
});
```

`LocalCacheExpiration` kürzer als `Expiration` zu halten, ist ein bewusstes Muster: Es begrenzt, wie lange ein einzelner Server veraltete Daten aus seinem eigenen Speicher ausliefern kann, während Redis den Wert für die serverübergreifende Nutzung länger behält. Ein kurzes L1 plus ein längeres L2 bedeutet, dass das Veraltungsfenster eines Servers klein ist, der Cluster als Ganzes aber dennoch die Datenbank vermeidet. Sie können diese Werte pro Aufruf überschreiben, indem Sie ein `HybridCacheEntryOptions` an `GetOrCreateAsync` übergeben.

Die Eigenschaft `Flags` an `HybridCacheEntryOptions` erlaubt es, eine Stufe für einen bestimmten Eintrag zu deaktivieren, zum Beispiel `HybridCacheEntryFlags.DisableLocalCacheWrite`, um L1 für einen selten gelesenen, aber großen Wert zu überspringen, oder `DisableDistributedCache`, um etwas nur In-Process zu halten. Greifen Sie chirurgisch zu diesen Optionen; die Standardwerte sind für die meisten Einträge richtig.

## Invalidierung nach Schlüssel und nach Tag

Wenn sich die zugrunde liegenden Daten ändern, entfernen Sie den Eintrag. Nach Schlüssel:

```csharp
await cache.RemoveAsync($"product:{id}", ct);
```

Tags sind das mächtigere Werkzeug. Hängen Sie beim Erstellen eines Eintrags Tags an und invalidieren Sie dann eine ganze Gruppe in einem Aufruf:

```csharp
// .NET 11, C# 14
public async Task<Product?> GetProductAsync(int id, CancellationToken ct = default)
{
    var options = new HybridCacheEntryOptions
    {
        Expiration = TimeSpan.FromMinutes(10),
        LocalCacheExpiration = TimeSpan.FromMinutes(2)
    };
    var tags = new[] { "products", $"category:{await GetCategoryAsync(id, ct)}" };

    return await cache.GetOrCreateAsync(
        $"product:{id}",
        async cancel => await db.Products
            .AsNoTracking()
            .FirstOrDefaultAsync(p => p.Id == id, cancel),
        options,
        tags,
        cancellationToken: ct);
}

// Invalidate every product in one category after a bulk price update
public ValueTask InvalidateCategoryAsync(int categoryId, CancellationToken ct = default)
    => cache.RemoveByTagAsync($"category:{categoryId}", ct);
```

Das ersetzt das alte Muster, in einem separaten Dictionary nachzuhalten, welche Schlüssel zu welcher Gruppe gehören. `RemoveByTagAsync("products")` invalidiert alles, was mit `products` getaggt ist, in einem einzigen Aufruf. Es gibt einen Platzhalter: `RemoveByTagAsync("*")` invalidiert logisch den gesamten Cache, sogar Einträge ohne Tag. Glob-Abgleich wird nicht unterstützt, sodass `RemoveByTagAsync("foo*")` nicht die Schlüssel entfernt, die mit `foo` beginnen.

Hier ist die Nuance, die Leute überrascht. Weder `IMemoryCache` noch `IDistributedCache` versteht Tags, sodass die Tag-Invalidierung eine logische Operation ist, kein physisches Löschen. HybridCache greift nicht in Redis ein und löscht die getaggten Schlüssel. Stattdessen vermerkt es, dass der Tag invalidiert wurde, und behandelt beim nächsten Lesen eines Eintrags, der diesen Tag trägt, den Wert als Fehlschlag und holt ihn erneut. Die Bytes verbleiben in Redis und im Speicher, bis sie auf natürliche Weise ablaufen. Für die Korrektheit ist das in Ordnung. Für die Speicherbuchhaltung von Redis bedeutet es, dass die Tag-Invalidierung nicht sofort Speicher freigibt.

## Die Mehrinstanzen-Falle, die jeden erwischt

Lesen Sie dies zweimal, wenn Sie mehr als einen Server betreiben. Wenn Sie `RemoveAsync` oder `RemoveByTagAsync` aufrufen, wird der Eintrag auf dem aktuellen Server und im L2 (Redis) invalidiert. Er wird nicht im L1 (In-Process-Speicher) der anderen Server invalidiert. Jeder dieser Server liefert weiterhin seine eigene zwischengespeicherte Kopie aus, bis diese Kopie ihre `LocalCacheExpiration` erschöpft.

Wenn Sie also fünf Server haben und `product:42` auf Server A entfernen, können die Server B bis E das alte Produkt für bis zu `LocalCacheExpiration` weiterhin aus ihrem lokalen Speicher zurückgeben. Dies ist der wichtigste Grund, `LocalCacheExpiration` bei Daten, die explizit invalidiert werden, kurz zu halten. Wenn Sie eine nahezu sofortige serverübergreifende Invalidierung benötigen, müssen Sie sie selbst verteilen, zum Beispiel mit einer Redis-Publish/Subscribe-Nachricht, die jeder Server durch den Aufruf seines eigenen `RemoveAsync` behandelt. HybridCache übernimmt diese Verbreitung nicht von Haus aus für Sie.

## Serialisierung und große Objekte

Für die L2-Speicherung müssen Werte serialisiert werden. HybridCache behandelt `string` und `byte[]` intern und verwendet standardmäßig `System.Text.Json` für alles andere. Sie können einen typspezifischen oder allgemeinen Serializer (protobuf, MessagePack, XML) einsetzen, indem Sie ihn an `AddHybridCache` anketten:

```csharp
// .NET 11 - custom serializer for one type
builder.Services
    .AddHybridCache()
    .AddSerializer<Product, ProtobufProductSerializer>();
```

Zwei Grenzwerte zum Merken. `MaximumPayloadBytes` hat einen Standardwert von 1 MB; größere Werte werden protokolliert und stillschweigend nicht zwischengespeichert, sodass ein überdimensioniertes Objekt zu einem dauerhaften Fehlschlag wird, der immer Ihre Factory trifft. `MaximumKeyLength` hat einen Standardwert von 1024 Zeichen; längere Schlüssel umgehen den Cache vollständig. Wenn Sie Schlüssel aus Benutzereingaben bauen, begrenzen Sie deren Länge und vertrauen Sie niemals rohen Benutzerzeichenfolgen als Schlüsseln, sowohl um unter dem Grenzwert zu bleiben als auch um einen Denial-of-Service-Angriff durch Cache-Flutung zu vermeiden.

Wenn Ihr zwischengespeicherter Typ unveränderlich ist, können Sie HybridCache anweisen, die defensive Deserialisierung pro Aufruf zu überspringen und eine gemeinsam genutzte Instanz auszuliefern, was CPU und Allokationen für große oder heiße Objekte einspart. Markieren Sie den Typ als `sealed` und wenden Sie `[ImmutableObject(true)]` an:

```csharp
// .NET 11, C# 14 - safe to reuse the same instance across callers
[ImmutableObject(true)]
public sealed record Product(int Id, string Name, decimal Price);
```

Tun Sie dies nur, wenn das Objekt nach der Erstellung wirklich nie verändert wird; andernfalls führen Sie die Nebenläufigkeitsfehler wieder ein, vor denen das Standardverhalten Sie schützt. Speziell für Redis kann das Paket `Microsoft.Extensions.Caching.StackExchangeRedis` `IBufferDistributedCache` implementieren, was HybridCache erlaubt, `byte[]`-Allokationen auf dem L2-Pfad zu vermeiden. Das zu aktivieren lohnt sich bei Diensten mit hohem Durchsatz.

## Wo HybridCache neben dem passt, was Sie bereits verwenden

HybridCache ersetzt weder `IMemoryCache` noch `IDistributedCache`; es sitzt darüber und orchestriert beide. Wenn Sie noch Cache-Aside von Hand über `IMemoryCache` machen oder die Cache-Trefferquote mit dem neuen integrierten Meter beobachten, der in [den erstklassigen OpenTelemetry-Metriken für MemoryCache in .NET 11](/de/2026/06/dotnet-11-memorycache-opentelemetry-metrics/) beschrieben ist, ist HybridCache die Schicht, die die In-Process- und die verteilte Stufe mit einer einzigen konsistenten API verbindet. Es passt natürlich zur Resilienzgeschichte in [Polly gegen die integrierten Resilienz-Handler in .NET 11](/de/2026/05/polly-vs-resilience-handlers-in-dotnet-11/), da sowohl Caching als auch Retry eine langsame Abhängigkeit schützen.

Caching ist außerdem die günstigste Lösung für die Abfrageprobleme, die Sie in [N+1-Abfragen in EF Core 11 erkennen](/de/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) sehen können: Sobald eine Abfrage korrekt ist, hält das Zwischenspeichern ihres Ergebnisses sie vom heißen Pfad fern, was [kompilierte Abfragen für EF-Core-Hot-Paths](/de/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) ergänzt. Und da die L2-Serialisierung standardmäßig über `System.Text.Json` läuft, gelten dieselben Regeln aus [einen benutzerdefinierten JsonConverter in System.Text.Json schreiben](/de/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) für alles, was Sie zwischenspeichern und das eine benutzerdefinierte Serialisierung benötigt.

Das mentale Modell zum Behalten: HybridCache gibt Ihnen einen zweistufigen Cache, Stampede-Schutz pro Server und logische Tag-Invalidierung, alles hinter `GetOrCreateAsync`. Redis wird in dem Moment zum L2, in dem Sie einen `IDistributedCache` registrieren. Die beiden Dinge, die es nicht tut, clusterweites Single-Flight und serverübergreifende L1-Invalidierung, sind genau die beiden Dinge, um die herum Sie entwerfen sollten: mit einer kurzen `LocalCacheExpiration` und, falls nötig, Ihrer eigenen Publish/Subscribe-Invalidierung.

## Quellen

- [HybridCache-Bibliothek in ASP.NET Core, Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/hybrid?view=aspnetcore-10.0)
- [Hello HybridCache! Streamlining Cache Management for ASP.NET Core Applications, .NET Blog](https://devblogs.microsoft.com/dotnet/hybrid-cache-is-now-ga/)
- [IBufferDistributedCache API-Referenz](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.caching.distributed.ibufferdistributedcache)
- [FusionCache-Integration mit HybridCache](https://github.com/ZiggyCreatures/FusionCache/blob/main/docs/MicrosoftHybridCache.md)
</content>
