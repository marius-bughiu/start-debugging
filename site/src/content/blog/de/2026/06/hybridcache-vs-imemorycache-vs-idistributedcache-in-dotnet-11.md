---
title: "HybridCache vs IMemoryCache vs IDistributedCache in .NET 11: Was sollten Sie wählen?"
description: "Verwenden Sie für neuen Cache-Code in .NET 11 standardmäßig HybridCache. Greifen Sie nur zu IMemoryCache, wenn Sie Geschwindigkeit auf einem einzelnen Server ohne Serialisierung brauchen, und zu IDistributedCache nur als Backing Store. Hier ist die Entscheidungsmatrix."
pubDate: 2026-06-14
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "aspnetcore"
  - "caching"
  - "performance"
lang: "de"
translationOf: "2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-06-14
---

Verwenden Sie für neuen Cache-Code in .NET 11 standardmäßig `HybridCache`. Er bietet die In-Process-Geschwindigkeit von `IMemoryCache`, die serverübergreifende Reichweite von `IDistributedCache` sowie Schutz vor Cache-Stampede und Invalidierung per Tags, die keine der älteren APIs hat, alles hinter einem einzigen `GetOrCreateAsync`-Aufruf. Greifen Sie nur zu reinem `IMemoryCache`, wenn Sie Latenz auf einem einzelnen Server ohne Serialisierung und feingranulare Kontrolle über das Verdrängen brauchen, und greifen Sie zu reinem `IDistributedCache` hauptsächlich, wenn Sie einen verteilten Speicher ohne L1-Ebene benötigen (oder als Backing-Ebene von `HybridCache`). Dieser Artikel untermauert diese Empfehlung mit der vollständigen Funktionsmatrix, den API-Unterschieden, die tatsächlich relevant sind, und dem Detail, das die Entscheidung für Sie trifft.

Alles hier zielt auf .NET 11, ASP.NET Core 11 und C# 14. `HybridCache` wird im Paket `Microsoft.Extensions.Caching.Hybrid` ausgeliefert, das zusammen mit .NET 9 GA erreichte und dasselbe Paket ist, das Sie in .NET 11 verwenden. Es unterstützt Laufzeiten bis hinunter zu .NET Framework 4.7.2 und .NET Standard 2.0, sodass der Vergleich unten nicht auf das neueste TFM beschränkt ist.

## Die Funktionsmatrix

| Funktion                        | IMemoryCache              | IDistributedCache               | HybridCache                          |
| ------------------------------- | ------------------------- | ------------------------------- | ------------------------------------ |
| Ebene                           | L1 (In-Process)           | L2 (Out-of-Process)             | L1 + optionales L2                   |
| Serverübergreifend geteilt      | Nein                      | Ja                              | Ja (über L2)                         |
| Übersteht Prozess-Neustart      | Nein                      | Ja                              | L2 übersteht, L1 nicht               |
| Gespeichert als                 | lebendes Objekt           | `byte[]`                        | Objekt im L1, serialisiert im L2     |
| Serialisierung                  | keine                     | schreiben Sie selbst            | integriert (`System.Text.Json` u. a.) |
| Schutz vor Cache-Stampede       | nein                      | nein                            | ja                                   |
| Invalidierung per Tags          | nein                      | nein                            | ja (`RemoveByTagAsync`)              |
| Get-or-create in einem Aufruf   | nur Erweiterung, ungeschützt | nein                         | ja (`GetOrCreateAsync`)              |
| Ablaufsteuerung pro Eintrag     | vollständig               | absolut + gleitend              | global + lokal (`LocalCacheExpiration`) |
| Integrierte OpenTelemetry-Metriken | ja (.NET 11)           | hängt vom Backend ab            | ja                                   |
| Eingebaut (kein NuGet)          | ja                        | Abstraktion ja, Backends nein   | nein (ein Paket)                     |
| Mindestlaufzeit                 | breit                     | breit                           | .NET Framework 4.7.2 / netstandard2.0 |

Alle drei werden über Dependency Injection registriert und per Interface aufgelöst (oder, bei `HybridCache`, einer abstrakten Klasse). Die relevanten Unterschiede liegen nicht in der Registrierung, sondern darin, was jede bei einem Cache-Miss und unter Nebenläufigkeit tut.

## Was jede API tatsächlich ist

`IMemoryCache` speichert Referenzen auf lebende Objekte in einem `ConcurrentDictionary`-gestützten Speicher innerhalb Ihres Prozesses. Es gibt keine Serialisierung: Sie legen einen `Customer` hinein und erhalten dieselbe `Customer`-Referenz zurück. Das macht ihn zum schnellsten der drei und zum einzigen, bei dem ein Cache-Treffer im Wesentlichen eine Dictionary-Suche kostet. Der Preis ist, dass er pro Prozess gilt: Zwei Instanzen hinter einem Load Balancer haben zwei unabhängige Caches, und ein Neustart leert ihn.

```csharp
// .NET 11, C# 14
builder.Services.AddMemoryCache();

public class ProductService(IMemoryCache cache, ProductDb db)
{
    public Task<Product> GetAsync(int id) =>
        cache.GetOrCreateAsync($"product:{id}", entry =>
        {
            entry.AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(5);
            return db.LoadProductAsync(id);
        })!;
}
```

`IDistributedCache` ist eine bewusst niedrigschwellige Abstraktion über einem Out-of-Process-Speicher. Seine Oberfläche besteht aus `GetAsync`, `SetAsync`, `RefreshAsync` und `RemoveAsync` (plus den synchronen Varianten), und jeder Wert ist ein `byte[]`. Es gibt kein `GetOrCreate`, kein Objektmodell und keine Nebenläufigkeitskontrolle. Sie sind für Serialisierung, Schlüsselbenennung, Ablaufrichtlinie und das Read-Through-Muster selbst verantwortlich.

```csharp
// .NET 11, C# 14
builder.Services.AddStackExchangeRedisCache(o =>
    o.Configuration = builder.Configuration.GetConnectionString("Redis"));

public class ProductService(IDistributedCache cache, ProductDb db)
{
    public async Task<Product> GetAsync(int id)
    {
        var key = $"product:{id}";
        var bytes = await cache.GetAsync(key);
        if (bytes is not null)
            return JsonSerializer.Deserialize<Product>(bytes)!;

        var product = await db.LoadProductAsync(id);
        await cache.SetAsync(key, JsonSerializer.SerializeToUtf8Bytes(product),
            new DistributedCacheEntryOptions
            {
                AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(5)
            });
        return product;
    }
}
```

Das sind etwa fünfzehn Zeilen Boilerplate pro gecachtem Wert, und jede Kopie ist eine Gelegenheit, den Ablauf zu vergessen, ein null falsch zu behandeln oder einen leicht abweichenden Serialisierer zu wählen. Die integrierten Implementierungen umfassen In-Memory (`AddDistributedMemoryCache`, nur für Entwicklung und Tests, da es nicht wirklich verteilt ist), Redis (`AddStackExchangeRedisCache`), SQL Server (`AddDistributedSqlServerCache`), Azure Cache for Redis und Drittanbieter-Speicher wie NCache.

`HybridCache` ist die Abstraktion, die Microsoft hinzugefügt hat, um die beiden obigen Muster zu einem zusammenzuführen. Er hält ein In-Process-L1 (standardmäßig ein `MemoryCache`) und nutzt, wenn Sie einen `IDistributedCache` registriert haben, diesen automatisch als L2. Ein `GetOrCreateAsync`-Aufruf prüft L1, dann L2, führt dann Ihre Factory aus und schreibt in beide Ebenen zurück. Sie berühren die Serialisierung nie, es sei denn, Sie möchten es.

```csharp
// .NET 11, C# 14
builder.Services.AddHybridCache();
// If an IDistributedCache is also registered, it becomes the L2 automatically.

public class ProductService(HybridCache cache, ProductDb db)
{
    public ValueTask<Product> GetAsync(int id, CancellationToken ct = default) =>
        cache.GetOrCreateAsync(
            $"product:{id}",
            async token => await db.LoadProductAsync(id, token),
            cancellationToken: ct);
}
```

Gleiches Ergebnis wie der `IDistributedCache`-Block, drei Zeilen statt fünfzehn, mit Schutz vor Cache-Stampede und einer L1-Ebene, die Sie nicht selbst verdrahten mussten.

## Wann Sie IMemoryCache direkt wählen

- **Single-Server- oder Pro-Knoten-Caches, bei denen die Daten nach einem Neustart günstig neu berechnet werden können.** Eine einmal pro Prozess geladene Lookup-Tabelle, eine geparste Config, ein Bucket eines Rate Limiters. Es bringt nichts, diese Out-of-Process zu serialisieren. Kombinieren Sie ihn mit dem neuen integrierten OpenTelemetry-Meter aus .NET 11, damit Sie weiterhin Trefferquote und Verdrängungen ohne eigenen Poller erhalten, wie in [dem Artikel zu den MemoryCache-Metriken in .NET 11](/de/2026/06/dotnet-11-memorycache-opentelemetry-metrics/) beschrieben.
- **Kritische Pfade, bei denen selbst eine Serialisierungsrunde zu viel ist.** Da `IMemoryCache` das lebende Objekt zurückgibt, ist ein Treffer eine Dictionary-Lesung. Wenn Sie einen Wert cachen, der tausende Male pro Sekunde auf einer Maschine gelesen wird, zählt das. Das ist dieselbe Überlegung wie beim Resident-Halten eines Abfrageplans, etwa in [kompilierten Abfragen für kritische Pfade von EF Core](/de/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/).
- **Sie brauchen Verdrängungsfunktionen, die `HybridCache` nicht bereitstellt.** Größenbasierte Limits (`SizeLimit` plus `Size` pro Eintrag), Verdrängungspriorität und `PostEvictionCallbacks` sind `IMemoryCache`-Konzepte. `HybridCache` stellt sie in seiner API nicht bereit.

Der Haken, den Sie beim direkten Weg in Kauf nehmen: `GetOrCreateAsync` auf `IMemoryCache` ist eine Erweiterungsmethode ohne Stampede-Schutz. Bei einem Burst mit kaltem Cache führt jeder nebenläufige Aufrufer die Factory aus.

## Wann Sie IDistributedCache direkt wählen

- **Sie brauchen einen geteilten Speicher, wollen aber ausdrücklich keine L1-Ebene.** Wenn die Korrektheit davon abhängt, dass jeder Knoten denselben Wert in dem Moment sieht, in dem er sich ändert, ist ein In-Process-L1 mit eigenem Ablauf ein Risiko, weil das Invalidieren eines Schlüssels das L1 anderer Server nicht erreicht (mehr dazu unten). Direkt zu Redis zu gehen, entfernt das Veraltungsfenster, das das L1 einführt.
- **Sie cachen eigentlich gar nicht.** `IDistributedCache` untermauert den Session-State von ASP.NET Core und kann Data-Protection-Schlüssel halten. Das sind Speicher-Anwendungsfälle, keine Read-Through-Caches, und `HybridCache` hat dafür die falsche Form.
- **Sie brauchen volle Kontrolle über die serialisierten Bytes.** Eigene Binärformate, von Ihnen verwaltete Kompression oder Interop mit einem anderen System, das dieselben Redis-Schlüssel liest. `HybridCache` kann einen eigenen Serialisierer aufnehmen, aber wenn die Bytes der Vertrag sind, ist die niedrigschwelligere API ehrlicher.

## Wann Sie HybridCache wählen (die Standardwahl)

- **Jeder neue Read-Through-Cache in einer App, die über eine Instanz hinaus skalieren könnte.** Sie erhalten heute die L1-Geschwindigkeit und die L2-Korrektheit in dem Moment, in dem Sie einen Redis-Cache registrieren, ohne Codeänderung an der Aufrufstelle. Das ist genau die Konfiguration, die in [HybridCache mit Redis als L2-Cache verwenden](/de/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/) beschrieben wird.
- **Überall dort, wo eine Cache-Stampede schaden würde.** `HybridCache` garantiert, dass für einen gegebenen Schlüssel nur ein nebenläufiger Aufrufer die Factory ausführt, während der Rest auf dieses eine Ergebnis wartet. Ein kalter Cache, der von hundert Anfragen getroffen wird, setzt eine Backing-Abfrage ab, nicht hundert, was dasselbe Problem ist, das Sie bei der Jagd auf [N+1-Abfragen in EF Core 11](/de/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) bekämpfen.
- **Sie wollen gruppierte Invalidierung.** Versehen Sie eine Menge von Einträgen mit Tags (`tags: ["product", $"category:{categoryId}"]`) und entfernen Sie sie gemeinsam mit `RemoveByTagAsync("category:42")`. Keine der älteren APIs kennt ein Tag-Konzept.

## Der Stampede-Benchmark, konkret

Das ist der Unterschied, der in der Produktion auftaucht, daher lohnt es sich, ihn zu messen statt zu behaupten. Nehmen Sie eine Factory, die eine 200-ms-Datenbanklesung simuliert, und feuern Sie 100 nebenläufige `GetOrCreateAsync`-Aufrufe für denselben Schlüssel gegen einen kalten Cache.

```csharp
// .NET 11, BenchmarkDotNet 0.15.x style harness (simplified)
async Task<int> Factory(CancellationToken _)
{
    Interlocked.Increment(ref _factoryCalls);
    await Task.Delay(200);          // stand-in for a DB / HTTP round trip
    return 42;
}

var tasks = Enumerable.Range(0, 100)
    .Select(_ => hybrid.GetOrCreateAsync("k", Factory).AsTask());
await Task.WhenAll(tasks);
```

Mit `HybridCache` ist `_factoryCalls` gleich **1**: Ein Aufrufer führt die 200-ms-Factory aus, und die anderen 99 warten auf deren Ergebnis, sodass der gesamte Burst in etwa 200 ms mit einem einzigen Backing-Aufruf abgearbeitet wird. Wechseln Sie zur `GetOrCreateAsync`-Erweiterung von `IMemoryCache`, und `_factoryCalls` steigt auf bis zu **100**, weil nichts die kalt verfehlenden Aufrufer serialisiert. Gegen eine echte Datenbank ist das der Unterschied zwischen einer Abfrage und einem hundertfachen Stau im Connection Pool. Die genaue Zahl im `IMemoryCache`-Fall variiert je nach Timing (einige Aufrufer landen womöglich, nachdem der erste Schreibvorgang abgeschlossen ist), was genau der Punkt ist: Sie ist unbeschränkt und nicht deterministisch, während `HybridCache` sie auf eins festnagelt. Werte gemessen auf .NET 11 (11.0.x), Windows 11, nur mit dem integrierten L1 und ohne konfiguriertes L2.

## Ablauf: Die Optionsnamen unterscheiden sich auf eine Weise, die beißt

Alle drei APIs benennen den Ablauf unterschiedlich, und sie zu verwechseln ist der häufigste Konfigurationsfehler.

`IMemoryCache` verwendet `MemoryCacheEntryOptions` mit `AbsoluteExpiration`, `AbsoluteExpirationRelativeToNow` und `SlidingExpiration`. `IDistributedCache` verwendet `DistributedCacheEntryOptions` mit denselben drei Namen. `HybridCache` verwendet `HybridCacheEntryOptions` mit zwei Eigenschaften, die etwas anderes bedeuten:

```csharp
// .NET 11, C# 14
var options = new HybridCacheEntryOptions
{
    Expiration = TimeSpan.FromMinutes(5),        // overall lifetime (drives L2)
    LocalCacheExpiration = TimeSpan.FromMinutes(1) // how long the L1 copy is trusted
};
```

`Expiration` ist die Gesamtlebensdauer des Eintrags und steuert die L2-Kopie. `LocalCacheExpiration` gibt an, wie lange die In-Process-L1-Kopie als gültig gilt, bevor der Eintrag erneut aus dem L2 geholt wird. `LocalCacheExpiration` kürzer als `Expiration` zu setzen, ist die Art, wie Sie die L1-Veraltung in einer Multi-Server-Bereitstellung begrenzen: Jeder Knoten vertraut seiner lokalen Kopie höchstens eine Minute, dann revalidiert er gegen das geteilte L2. In `HybridCache` gibt es kein Konzept gleitenden Ablaufs; wenn Sie auf gleitende Fenster angewiesen sind, ist das ein Grund, bei der niedrigschwelligeren API zu bleiben.

Weitere Standardwerte, die man kennen sollte: `HybridCacheOptions.MaximumPayloadBytes` ist standardmäßig 1 MB und `MaximumKeyLength` 1024 Zeichen. Werte oder Schlüssel über dem Limit werden protokolliert und stillschweigend nicht gecacht, was ein leiser Fehlermodus ist, wenn Sie große Blobs cachen.

## Das Detail, das die Entscheidung für Sie trifft

Die Invalidierung per Tags und per Schlüssel in `HybridCache` erreicht das L1 anderer Server nicht. Wenn Sie `RemoveByTagAsync` oder `RemoveAsync` aufrufen, wird der Eintrag aus dem lokalen L1 und dem geteilten L2 entfernt, aber jeder andere Knoten serviert weiterhin seine eigene L1-Kopie, bis diese Kopie nach ihrer eigenen `LocalCacheExpiration` abläuft. Die Dokumentation ist eindeutig: Die Tag-Invalidierung ist eine logische Operation, die künftige Lesungen als Misses markiert, sie purgt andere Knoten nicht aktiv.

Dieses eine Verhalten entscheidet über mehrere Designs:

- Wenn Sie ein begrenztes Veraltungsfenster tolerieren können (setzen Sie `LocalCacheExpiration` auf das von Ihnen akzeptierte Fenster), ist `HybridCache` ideal und Sie behalten die L1-Geschwindigkeit.
- Wenn Sie kein Fenster tolerieren können, weil ein veralteter Autorisierungs- oder Preiswert ein Korrektheitsfehler ist, dann ist eine L1-Ebene das falsche Werkzeug, und Sie sollten direkt zu `IDistributedCache` gehen (oder `LocalCacheExpiration` auf null setzen, was den Zweck des L1 weitgehend zunichtemacht).

Die andere zwingende Funktion ist die **Serialisierungssicherheit**. `HybridCache` deserialisiert standardmäßig pro Aufrufer ein frisches Objekt, um die Thread-Sicherheitsgarantien von `IDistributedCache` zu wahren. Wenn Ihr gecachter Typ unveränderlich ist, können Sie die Instanz-Wiederverwendung aktivieren, indem Sie den Typ sealed machen und `[ImmutableObject(true)]` anwenden, was den Deserialisierungs-Overhead pro Aufruf beseitigt. Wenn Ihre gecachten Objekte veränderlich und geteilt sind, wenden Sie dieses Attribut nicht an, sonst führen Sie Race Conditions ein.

## Die Empfehlung, erneut formuliert

Schreiben Sie in .NET 11 neuen Cache-Code gegen `HybridCache`, sofern Sie keinen spezifischen Grund dagegen haben. Er ist ein nahezu direkter Ersatz für beide älteren APIs, beseitigt die Cache-Aside-Boilerplate, die `IDistributedCache` Ihnen aufzwingt, und schließt das Stampede-Loch, das das ungeschützte `IMemoryCache.GetOrCreateAsync` offenlässt. Steigen Sie auf reines `IMemoryCache` herab, wenn Sie Single-Server-Geschwindigkeit, null Serialisierung oder Verdrängungsfunktionen (Größenlimits, Priorität, Verdrängungs-Callbacks) brauchen, die `HybridCache` nicht bereitstellt. Steigen Sie auf reines `IDistributedCache` herab, wenn Sie einen geteilten Speicher ohne L1-Veraltungsfenster brauchen, wenn die serialisierten Bytes ein Vertrag mit einem anderen System sind, oder wenn Sie es für Session- und Schlüsselspeicherung statt zum Cachen verwenden. Für alles dazwischen, also das meiste Caching, ist `HybridCache` die Antwort.

## Verwandt

- [HybridCache in ASP.NET Core 11 mit Redis als L2-Cache verwenden](/de/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/)
- [.NET 11 gibt MemoryCache erstklassige OpenTelemetry-Metriken](/de/2026/06/dotnet-11-memorycache-opentelemetry-metrics/)
- [N+1-Abfragen in EF Core 11 erkennen](/de/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [Kompilierte Abfragen mit EF Core für kritische Pfade verwenden](/de/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)

## Quellen

- [HybridCache-Bibliothek in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/hybrid?view=aspnetcore-10.0)
- [Verteiltes Caching in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/distributed?view=aspnetcore-10.0)
- [In-Memory-Caching in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/memory?view=aspnetcore-10.0)
- [Hello HybridCache! (Microsoft .NET Blog, GA-Ankündigung)](https://devblogs.microsoft.com/dotnet/hybrid-cache-is-now-ga/)
- [Übersicht über Caching in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/overview?view=aspnetcore-10.0)
