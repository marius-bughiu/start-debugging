---
title: "Redis-Schlüsselpräfix vs. separate Datenbank vs. separate Instanz für mandantenfähiges Caching in ASP.NET Core"
description: "Verwenden Sie für fast jede mandantenfähige ASP.NET-Core-App ein Mandanten-Schlüsselpräfix auf einer gemeinsamen Redis-Instanz, verlagern Sie nur Mandanten mit vertraglicher Isolation oder lauten Workloads auf eine eigene Instanz und verzichten Sie auf nummerierte Datenbanken: Redis Cluster, Azure Managed Redis und Redis Cloud kennen nur Datenbank 0."
pubDate: 2026-10-07
template: vs
tags:
  - "comparison"
  - "redis"
  - "aspnetcore"
  - "dotnet"
  - "caching"
  - "multi-tenancy"
lang: "de"
translationOf: "2026/10/redis-key-prefix-vs-separate-database-vs-separate-instance-for-multi-tenant-caching-in-aspnetcore"
translatedBy: "claude"
translationDate: 2026-10-07
---

Legen Sie für eine mandantenfähige ASP.NET-Core-App alle Mandanten auf eine gemeinsame Redis-Instanz und isolieren Sie sie mit einem Schlüsselpräfix wie `t:{tenantId}:`. Das funktioniert mit jeder Redis-Topologie, passt direkt zu `HybridCache` und `IDistributedCache`, und das Präfix brauchen Sie ohnehin, weil der prozessinterne L1 von `HybridCache` von allen Mandanten gemeinsam genutzt wird. Geben Sie einem Mandanten nur dann eine eigene Redis-Instanz, wenn ein Vertrag, eine Compliance-Grenze oder ein lauter Workload es verlangt. Vermeiden Sie nummerierte Datenbanken (`SELECT 3`): Redis Cluster, Azure Managed Redis und Redis Cloud unterstützen nur Datenbank 0, und die gebotene Isolation ist schwächer, als sie aussieht.

Alles Folgende wurde mit .NET SDK 10.0.302 für `net10.0` kompiliert und geprüft, mit `Microsoft.Extensions.Caching.StackExchangeRedis` 10.0.12, `Microsoft.Extensions.Caching.Hybrid` 10.10.0 und `StackExchange.Redis` 3.3.1. Dieselben APIs gibt es in den Paketen 11.0.0-rc.1 für .NET 11.

## Die drei Optionen im Überblick

| | Schlüsselpräfix, gemeinsame Instanz | Nummerierte Datenbank pro Mandant | Instanz pro Mandant |
| --- | --- | --- | --- |
| Wie ein Mandant getrennt wird | `t:42:` vor jedem Schlüssel | `SELECT 42` auf der Verbindung | Anderer Host und andere Zugangsdaten |
| Funktioniert mit Redis Cluster / Azure Managed Redis / Redis Cloud | Ja | Nein, nur Datenbank 0 | Ja |
| Maximale Mandantenzahl | Unbegrenzt | Standardmäßig 16 (Konfiguration `databases`) | Ihr Budget |
| Speicherlimit und Eviction | Gemeinsam | Gemeinsam (`maxmemory` gilt pro Server) | Getrennt |
| CPU- und Latenzisolation | Keine | Keine | Vollständig |
| Zugriffskontrolle pro Mandant | ACL-Schlüsselmuster `~t:42:*` (Redis 7+) | Nur Valkey 9.1+ (Regel `db=`) | Getrennte Zugangsdaten |
| Einen Mandanten löschen | `SCAN` + `DEL` oder `HybridCache`-Tag | `FLUSHDB` | Instanz löschen |
| Funktioniert mit einem einzigen `AddHybridCache()` | Ja | Benötigt einen routenden `IDistributedCache` | Benötigt einen routenden `IDistributedCache` |
| Verbindungen pro App-Instanz | 1 Multiplexer | 1 Multiplexer pro verwendeter Datenbank | 1 Multiplexer pro Mandant |
| Kosten | Am niedrigsten | Am niedrigsten | Am höchsten |

Nummerierte Datenbanken wirken wie ein Mittelweg. In der Praxis teilen sie alle relevanten Grenzen mit dem Präfix-Ansatz und bringen zusätzliche Einschränkungen mit, die der Präfix-Ansatz nicht hat.

## Warum nummerierte Datenbanken eine Falle sind

Die [`SELECT`-Dokumentation](https://redis.io/docs/latest/commands/select/) von Redis selbst ist deutlich: Datenbanken dienen dazu, Schlüssel "within the same application" zu trennen, nicht dazu, unabhängige Workloads auf einem Server zu betreiben. Dann fügt sie hinzu, dass "Redis Cluster only supports database zero". Dieser eine Satz schließt einen großen Teil des Managed-Marktes aus:

- **Azure Managed Redis** ist laut seiner [Architekturseite](https://learn.microsoft.com/en-us/azure/redis/architecture) "internally configured to use clustering, across all tiers and SKUs" und läuft auf Redis Enterprise.
- **Redis Software und Redis Cloud** unterstützen gemeinsam genutzte Datenbanken überhaupt nicht. Die `SELECT`-Seite sagt, der Befehl werde "supported solely for compatibility" und führe dort keine Operationen aus. Wenn Ihr Code für die Isolation auf `SELECT` setzt und Sie zu einem dieser Dienste migrieren, landen alle Mandanten stillschweigend im selben Schlüsselraum. Das ist der schlimmstmögliche Fehlermodus für Mandantenfähigkeit: kein Fehler, nur Daten, die zwischen Mandanten durchsickern.
- **Redis OSS im Cluster-Modus** (einschließlich der meisten Managed-Angebote im Cluster-Modus) lehnt alles außer Datenbank 0 ab.

Die einzige Ausnahme ist Valkey: [Valkey 9.0](https://www.linuxfoundation.org/press/valkey-9.0-delivers-performance-and-resiliency-for-real-time-workloads) hat nummerierte Datenbanken im Cluster-Modus eingeführt, und [Valkey 9.1 hat `db=`-ACL-Regeln ergänzt](https://valkey.io/commands/acl-setuser/), sodass ein Benutzer auf bestimmte Datenbanken beschränkt werden kann. Wenn Sie Valkey 9.1+ betreiben und nie von dort wegziehen wollen, sind Datenbanken vertretbar. Überall sonst bindet die Wahl von Datenbanken Ihr Mandantenmodell an eine einzige Hosting-Topologie.

Selbst dort, wo Datenbanken funktionieren, isolieren sie nicht das, worum Mandanten tatsächlich konkurrieren. `maxmemory` und die Eviction-Richtlinie gelten für den ganzen Server, sodass ein Mandant, der seine Datenbank füllt, Schlüssel aller anderen verdrängt. Redis führt Befehle auf einem einzigen Haupt-Thread aus, daher legt ein Mandant mit einem langsamen `KEYS *` alle Datenbanken lahm. Und mit dem Standardwert `databases 16` gehen Ihnen die Mandanten-Slots aus, lange bevor die Kunden ausgehen.

Das andere praktische Problem liegt auf der .NET-Seite. `RedisCache`, die `IDistributedCache`-Implementierung hinter `AddStackExchangeRedisCache`, ruft `connection.GetDatabase()` ohne Argument auf, wie Sie in [RedisCache.cs](https://github.com/dotnet/aspnetcore/blob/main/src/Caching/StackExchangeRedis/src/RedisCache.cs) sehen können. Sie spricht immer mit der `DefaultDatabase` der Verbindung. Um Datenbank 7 zu erreichen, brauchen Sie einen `RedisCache`, der aus einer `ConfigurationOptions` mit `DefaultDatabase = 7` aufgebaut wird. Das bedeutet einen eigenen `ConnectionMultiplexer` pro verwendeter Datenbank, genau den Overhead, den der gemeinsame Multiplexer vermeiden soll.

## Der Schlüsselpräfix-Ansatz, richtig umgesetzt

`RedisCacheOptions.InstanceName` ist dokumentiert als Möglichkeit, "a single backend cache for use with multiple apps/services" zu partitionieren. Es ist ein prozessweites Präfix, verwenden Sie es also für den App-Namen und legen Sie den Mandanten in jeden Schlüssel:

```csharp
// .NET 10, ASP.NET Core 10
// Microsoft.Extensions.Caching.StackExchangeRedis 10.0.12
// Microsoft.Extensions.Caching.Hybrid 10.10.0, StackExchange.Redis 3.3.1
using Microsoft.Extensions.Caching.Hybrid;
using StackExchange.Redis;

var builder = WebApplication.CreateBuilder(args);

var mux = await ConnectionMultiplexer.ConnectAsync(
    builder.Configuration.GetConnectionString("redis")!);
builder.Services.AddSingleton<IConnectionMultiplexer>(mux);

builder.Services.AddStackExchangeRedisCache(o =>
{
    // share the multiplexer instead of opening a second connection
    o.ConnectionMultiplexerFactory = () => Task.FromResult<IConnectionMultiplexer>(mux);
    o.InstanceName = "myapp:"; // note the trailing delimiter
});
builder.Services.AddHybridCache();

builder.Services.AddHttpContextAccessor();
builder.Services.AddScoped<ITenantContext, ClaimTenantContext>();
builder.Services.AddScoped<TenantCache>();

var app = builder.Build();

app.MapGet("/products/{id:int}", async (int id, TenantCache cache) =>
    await cache.GetOrCreateAsync($"product:{id}",
        ct => ValueTask.FromResult($"product {id}")));

app.Run();
```

Der Mandant stammt aus einer vertrauenswürdigen Quelle, niemals aus einem Header oder Query-String, den der Client kontrolliert. Hier ist es ein Claim des authentifizierten Benutzers:

```csharp
// .NET 10, C# 14
public interface ITenantContext { string TenantId { get; } }

public sealed class ClaimTenantContext(IHttpContextAccessor accessor) : ITenantContext
{
    public string TenantId =>
        accessor.HttpContext?.User.FindFirst("tenant_id")?.Value
        ?? throw new InvalidOperationException("No tenant on this request.");
}
```

Entscheidend ist, dass Anwendungscode nie einen rohen Cache-Schlüssel baut. Er läuft über einen Scoped-Wrapper, der den Mandanten jedes Mal hinzufügt, sodass ihn kein Entwickler vergessen kann:

```csharp
// .NET 10, C# 14, Microsoft.Extensions.Caching.Hybrid 10.10.0
public sealed class TenantCache(HybridCache cache, ITenantContext tenant)
{
    private string Key(string key) => $"t:{tenant.TenantId}:{key}";
    private string TenantTag => $"tenant:{tenant.TenantId}";

    public ValueTask<T> GetOrCreateAsync<T>(
        string key,
        Func<CancellationToken, ValueTask<T>> factory,
        HybridCacheEntryOptions? options = null,
        IEnumerable<string>? tags = null,
        CancellationToken ct = default) =>
        cache.GetOrCreateAsync(
            Key(key),
            factory,
            static (f, c) => f(c),
            options,
            [TenantTag, .. (tags ?? []).Select(t => $"{TenantTag}:{t}")],
            ct);

    public ValueTask RemoveAsync(string key, CancellationToken ct = default) =>
        cache.RemoveAsync(Key(key), ct);

    // logical wipe of everything this tenant cached
    public ValueTask InvalidateTenantAsync(CancellationToken ct = default) =>
        cache.RemoveByTagAsync(TenantTag, ct);
}
```

In Redis landet der Produkteintrag für Mandant 42 als Hash `myapp:t:42:product:7`. Auch Tags erhalten ein Präfix: `HybridCache`-Tags sind globale Strings, daher würde ein unpräfixiertes `RemoveByTagAsync("products")` eines Mandanten die Produkteinträge aller Mandanten ungültig machen.

Wenn Sie `IDatabase` direkt für Zähler, Sperren oder Sets verwenden, bringt StackExchange.Redis dieselbe Idee über `StackExchange.Redis.KeyspaceIsolation` bereits mit:

```csharp
// StackExchange.Redis 3.3.1
using StackExchange.Redis.KeyspaceIsolation;

IDatabase tenantDb = mux.GetDatabase().WithKeyPrefix($"myapp:t:{tenantId}:");
await tenantDb.StringIncrementAsync("logins"); // writes myapp:t:42:logins
```

## Das L1-Problem, das die Debatte entscheidet

Hier ist das Detail, das das Präfix zur Pflicht macht, egal welche Option Sie wählen. `HybridCache` ist ein zweistufiger Cache, und sein L1 ist ein prozessinterner `MemoryCache`, den alle Anfragen im Prozess gemeinsam nutzen. Angenommen, Sie leiten Mandant 42 auf eine eigene Redis-Instanz um und behalten den Cache-Schlüssel als schlichtes `product:7`. Die L2-Abfrage geht an den richtigen Server, aber die L1-Abfrage erfolgt zuerst, und `product:7` von Mandant 41 liegt bereits im Speicher. Mandant 42 erhält das Produkt von Mandant 41.

Separate Datenbanken und separate Instanzen machen mandantenbezogene Schlüssel also nicht überflüssig. Sie fügen einen zweiten Isolationsmechanismus zu dem hinzu, den Sie ohnehin bauen müssen. Sobald das Präfix existiert, bleibt nur noch die Frage, ob manche Mandanten mehr brauchen als Trennung auf Schlüsselebene.

Dasselbe gilt für Output Caching. `AddStackExchangeRedisOutputCache` hat einen eigenen `InstanceName`, und der Cache-Schlüssel muss unabhängig vom Speicherort der Einträge nach Mandant variieren (`VaryByValue` auf dem Mandanten-Claim).

## Wann eine separate Instanz die richtige Wahl ist

Ein eigenes Redis pro Mandant ist nicht der Standard, aber eine legitime Stufe. Wählen Sie es, wenn:

- **Ein Vertrag oder eine Aufsichtsbehörde es verlangt.** Datenresidenz in einer bestimmten Region, ein kundenverwalteter Verschlüsselungsschlüssel oder "keine gemeinsame Infrastruktur" in einem Enterprise-Vertrag. Schlüsselpräfixe genügen einem Prüfer nicht, der physische Trennung verlangt.
- **Der Workload eines Mandanten groß genug ist, um die anderen zu beeinträchtigen.** Ein Mandant mit 40 GB heißer Daten oder einem stoßweisen Batch-Job verdrängt bei einem gemeinsamen `maxmemory` die Schlüssel aller anderen. Wird er ausgelagert, sind die Trefferquoten für den Rest wieder vorhersagbar.
- **Sie eine Eviction-Richtlinie oder Persistenz pro Mandant brauchen.** `maxmemory-policy` sowie AOF- und RDB-Einstellungen gelten serverweit.
- **Das Offboarding eines Mandanten nachweisbar vollständig sein muss.** Das Löschen einer Instanz lässt sich leichter belegen als "wir haben jeden Schlüssel gescannt und gelöscht".

Die übliche Form ist ein Pool-Modell mit Premium-Silo: alle auf der gemeinsamen, präfixierten Instanz, eine kurze Liste von Mandanten auf dedizierten Instanzen. Weil `AddHybridCache()` genau einen L2 verdrahtet, muss das Routing in einem `IDistributedCache` stattfinden, der das Backend pro Aufruf auswählt:

```csharp
// .NET 10, C# 14, Microsoft.Extensions.Caching.StackExchangeRedis 10.0.12
using System.Collections.Concurrent;
using Microsoft.Extensions.Caching.Distributed;
using Microsoft.Extensions.Caching.StackExchangeRedis;

public sealed class TenantRoutingCache(
    IHttpContextAccessor accessor,
    IConfiguration config,
    [FromKeyedServices("shared")] IDistributedCache shared) : IDistributedCache
{
    private readonly ConcurrentDictionary<string, IDistributedCache> _dedicated = new();

    private IDistributedCache Current()
    {
        var tenant = accessor.HttpContext?.User.FindFirst("tenant_id")?.Value;
        var cs = tenant is null ? null : config[$"Tenants:{tenant}:Redis"];
        if (cs is null) return shared;

        return _dedicated.GetOrAdd(tenant!, _ => new RedisCache(
            new RedisCacheOptions { Configuration = cs, InstanceName = "myapp:" }));
    }

    public byte[]? Get(string key) => Current().Get(key);
    public Task<byte[]?> GetAsync(string key, CancellationToken token = default) =>
        Current().GetAsync(key, token);
    public void Set(string key, byte[] value, DistributedCacheEntryOptions options) =>
        Current().Set(key, value, options);
    public Task SetAsync(string key, byte[] value, DistributedCacheEntryOptions options,
        CancellationToken token = default) => Current().SetAsync(key, value, options, token);
    public void Refresh(string key) => Current().Refresh(key);
    public Task RefreshAsync(string key, CancellationToken token = default) =>
        Current().RefreshAsync(key, token);
    public void Remove(string key) => Current().Remove(key);
    public Task RemoveAsync(string key, CancellationToken token = default) =>
        Current().RemoveAsync(key, token);
}
```

Registrieren Sie den gemeinsamen `RedisCache` als Keyed Service und den Router als ungekeyten `IDistributedCache`, den `HybridCache` auflöst. Die Schlüssel tragen weiterhin das Mandantenpräfix aus `TenantCache`, was L1 absichert. Zwei Dinge sind bei diesem Router zu beachten: Er hängt von `HttpContext` ab, daher müssen Hintergrundjobs den Mandanten auf anderem Weg festlegen (ein vom Job-Runner gesetzter `AsyncLocal` funktioniert), und er umgeht den Fast Path von `IBufferDistributedCache` in `RedisCache`, weil er nur die Basisschnittstelle implementiert. Für eine Handvoll Premium-Mandanten ist dieser Kompromiss vertretbar.

Jeder dedizierte `RedisCache` besitzt einen Multiplexer. Ein Multiplexer ist dafür gedacht, gemeinsam genutzt und langlebig zu sein. Halten Sie diese Instanzen daher für die Lebensdauer des Prozesses im Cache und erzeugen Sie sie nie pro Anfrage. Mit 20 dedizierten Mandanten und 10 App-Pods halten Sie 200 zusätzliche Redis-Verbindungen. Hier hört das Modell der Instanz pro Mandant auf zu skalieren, und deshalb sollte es eine Stufe bleiben und nicht der Standard werden.

## Stolperfallen bei Schlüsselpräfixen

**Beenden Sie das Präfix immer mit einem Trennzeichen.** `RedisCache` verkettet `InstanceName` und den Schlüssel ohne Trennzeichen. Die [HybridCache-Schlüsselrichtlinie](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/hybrid) nennt das klassische Beispiel: `order{customerId}{orderId}` ergibt für Kunde 42 mit Bestellung 123 und Kunde 421 mit Bestellung 23 beide Male `order42123`. Dasselbe passiert mit Mandanten: Mandant `7` plus Schlüssel `42:profile` und Mandant `74` plus Schlüssel `2:profile` kollidieren, wenn Sie `t{tenant}{key}` schreiben. Verwenden Sie `t:{tenant}:` und stellen Sie sicher, dass Mandanten-IDs kein `:` enthalten können.

**Das Löschen der Schlüssel eines Mandanten ist ein Scan, kein Befehl.** `RemoveByTagAsync($"tenant:{id}")` ist die günstige Option, aber es ist eine logische Invalidierung: Laut Dokumentation bleiben Werte in Redis, "until they expire in the usual way". Wenn Sie Daten physisch entfernen müssen (Offboarding, DSGVO-Löschung), scannen Sie jeden Primary:

```csharp
// StackExchange.Redis 3.3.1
public static async Task<long> PurgeTenantAsync(IConnectionMultiplexer mux, string tenantId)
{
    var db = mux.GetDatabase();
    long deleted = 0;
    foreach (var endpoint in mux.GetEndPoints())
    {
        var server = mux.GetServer(endpoint);
        if (server.IsReplica) continue;

        await foreach (var key in server.KeysAsync(pattern: $"myapp:t:{tenantId}:*", pageSize: 500))
        {
            // one DEL per key: in a cluster, keys from one node can span many hash slots
            if (await db.KeyDeleteAsync(key)) deleted++;
        }
    }
    return deleted;
}
```

`KeysAsync` verwendet intern `SCAN` und sieht in einem Cluster nur die Schlüssel des jeweiligen Knotens, weshalb die Schleife über jeden Endpunkt läuft. Die [StackExchange.Redis-Dokumentation](https://seredis.dev/KeysScan) warnt weiterhin davor, es auf ausgelasteten Produktionsservern auszuführen. Führen Sie es daher in einem Hintergrundjob mit moderater Seitengröße aus.

**Verwenden Sie keine Hash Tags für Mandanten.** Schlüssel wie `{t:42}:product:7` zwingen alle Schlüssel eines Mandanten in einen einzigen Hash Slot. Das erlaubt Operationen über mehrere Schlüssel, nagelt aber auch den ganzen Mandanten auf einen Shard fest. Ihr größter Mandant wird zum heißen Shard. Lassen Sie den Mandanten aus den geschweiften Klammern heraus, außer Sie brauchen wirklich schlüsselübergreifende Transaktionen.

**Ergänzen Sie ACLs, wenn Mandanten direkten Redis-Zugriff haben.** Normalerweise spricht nur Ihre App mit Redis, das Präfix wird also durch Code-Review und den `TenantCache`-Wrapper durchgesetzt. Erhält ein mandantenspezifischer Worker eigene Zugangsdaten, erzwingen die ACL-Schlüsselmuster von Redis 7 das Präfix serverseitig: `ACL SETUSER tenant42 on >secret ~myapp:t:42:* +@read +@write`.

**Die Präfixlänge ist Overhead bei jedem Schlüssel.** `myapp:t:` plus eine GUID als Mandanten-ID sind 44 Bytes, noch bevor der eigentliche Schlüssel kommt. Bei einem Cache mit zig Millionen kleiner Einträge ist das echter Speicher. Eine kurze Ganzzahl oder eine Base-36-Mandanten-ID hält ihn vernachlässigbar und hält Sie weit von der `MaximumKeyLength` von `HybridCache` mit 1024 Zeichen entfernt.

## Die Empfehlung samt Begründung

Verwenden Sie ein Schlüsselpräfix auf einem gemeinsamen Redis. Es läuft auf jeder Topologie, vom lokalen Container bis zu Azure Managed Redis mit OSS-Clustering, es ist die einzige Option, die sich mit einem einzigen Aufruf von `AddHybridCache()` verträgt, und der Mandant muss wegen des gemeinsamen L1 ohnehin im Schlüssel stehen. Ergänzen Sie eine Stufe mit dedizierten Instanzen, geroutet über einen `IDistributedCache` wie den obigen, für die Mandanten, deren Verträge oder Workloads die Kosten für Isolation rechtfertigen. Verzichten Sie auf nummerierte Datenbanken, sofern Sie sich nicht auf Valkey 9.1+ festgelegt haben: Sie bieten `FLUSHDB` und Schlüsselzahlen pro Datenbank in `INFO keyspace`, teilen aber Speicher und CPU mit jedem anderen Mandanten und verschwinden in dem Moment, in dem Sie auf ein geclustertes oder Enterprise-Redis wechseln.

## Verwandte Artikel

- [How to use HybridCache in ASP.NET Core 11 with Redis as the L2 cache](/de/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/) behandelt die Grundverdrahtung, auf der dieser Beitrag aufbaut.
- [HybridCache vs IMemoryCache vs IDistributedCache in .NET 11](/de/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/) erklärt die Aufteilung in L1 und L2, die Mandantenschlüssel zwingend macht.
- [Output caching in a minimal API](/de/2026/07/how-to-add-output-caching-to-a-minimal-api-in-aspnetcore-11/) zeigt `VaryByValue` für Output-Cache-Einträge pro Mandant.
- [Keyed services in .NET dependency injection](/de/2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection/) zeigt, wie der gemeinsame und der geroutete Cache nebeneinander registriert werden.
- [Named query filters in EF Core 11](/de/2026/07/named-query-filters-vs-a-single-global-query-filter-in-ef-core-11/) ist das datenbankseitige Gegenstück zur Mandantenisolation.

## Quellen

- [Redis-Befehl `SELECT`](https://redis.io/docs/latest/commands/select/), einschließlich der Hinweise zu Cluster und Redis Software.
- [Azure Managed Redis architecture](https://learn.microsoft.com/en-us/azure/redis/architecture) für Details zu Clustering und Cluster-Richtlinie.
- [Valkey `ACL SETUSER`](https://valkey.io/commands/acl-setuser/) für Schlüsselmuster und die `db=`-Regeln ab 9.1.
- [RedisCacheOptions.cs](https://github.com/dotnet/aspnetcore/blob/main/src/Caching/StackExchangeRedis/src/RedisCacheOptions.cs) und [RedisCache.cs](https://github.com/dotnet/aspnetcore/blob/main/src/Caching/StackExchangeRedis/src/RedisCache.cs) dazu, wie `InstanceName` und die Datenbank angewendet werden.
- [HybridCache library in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/hybrid) für Schlüsselrichtlinien und die Semantik der Tag-Invalidierung.
- [StackExchange.Redis: KEYS, SCAN, FLUSHDB etc](https://seredis.dev/KeysScan) zum Scannen in Clustern.
