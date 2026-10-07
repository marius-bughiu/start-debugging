---
title: "Prefijo de clave de Redis vs base de datos separada vs instancia separada para el almacenamiento en caché multitenant en ASP.NET Core"
description: "Usa un prefijo de clave por tenant en un Redis compartido para casi cualquier app multitenant de ASP.NET Core, mueve a su propia instancia solo a los tenants con aislamiento contractual o cargas ruidosas, y evita las bases de datos numeradas: Redis Cluster, Azure Managed Redis y Redis Cloud solo tienen la base de datos 0."
pubDate: 2026-10-07
template: vs
tags:
  - "comparison"
  - "redis"
  - "aspnetcore"
  - "dotnet"
  - "caching"
  - "multi-tenancy"
lang: "es"
translationOf: "2026/10/redis-key-prefix-vs-separate-database-vs-separate-instance-for-multi-tenant-caching-in-aspnetcore"
translatedBy: "claude"
translationDate: 2026-10-07
---

Para una app multitenant de ASP.NET Core, pon a todos los tenants en un único Redis compartido y aíslalos con un prefijo de clave como `t:{tenantId}:`. Funciona en cualquier topología de Redis, se integra directamente con `HybridCache` e `IDistributedCache`, y el prefijo es algo que necesitas de todos modos porque el L1 en proceso de `HybridCache` se comparte entre tenants. Dale a un tenant su propia instancia de Redis solo cuando un contrato, un límite de cumplimiento normativo o una carga ruidosa lo exijan. Evita las bases de datos numeradas (`SELECT 3`): Redis Cluster, Azure Managed Redis y Redis Cloud solo admiten la base de datos 0, y el aislamiento que ofrecen es más débil de lo que parece.

Todo lo que sigue se verificó compilando con .NET SDK 10.0.302 con destino `net10.0`, usando `Microsoft.Extensions.Caching.StackExchangeRedis` 10.0.12, `Microsoft.Extensions.Caching.Hybrid` 10.10.0 y `StackExchange.Redis` 3.3.1. Las mismas APIs existen en los paquetes 11.0.0-rc.1 para .NET 11.

## Las tres opciones lado a lado

| | Prefijo de clave, instancia compartida | Base de datos numerada por tenant | Instancia por tenant |
| --- | --- | --- | --- |
| Cómo se separa un tenant | `t:42:` delante de cada clave | `SELECT 42` en la conexión | Host y credenciales distintos |
| Funciona en Redis Cluster / Azure Managed Redis / Redis Cloud | Sí | No, solo base de datos 0 | Sí |
| Máximo de tenants | Ilimitado | 16 por defecto (configuración `databases`) | Tu presupuesto |
| Límite de memoria y expulsión | Compartido | Compartido (`maxmemory` es por servidor) | Separado |
| Aislamiento de CPU y latencia | Ninguno | Ninguno | Total |
| Control de acceso por tenant | Patrones de clave ACL `~t:42:*` (Redis 7+) | Solo Valkey 9.1+ (regla `db=`) | Credenciales separadas |
| Borrar un tenant | `SCAN` + `DEL`, o una etiqueta de `HybridCache` | `FLUSHDB` | Eliminar la instancia |
| Funciona con un solo `AddHybridCache()` | Sí | Necesita un `IDistributedCache` de enrutamiento | Necesita un `IDistributedCache` de enrutamiento |
| Conexiones por instancia de la app | 1 multiplexor | 1 multiplexor por base de datos en uso | 1 multiplexor por tenant |
| Costo | El más bajo | El más bajo | El más alto |

Las bases de datos numeradas parecen un punto medio. En la práctica comparten todos los límites que importan con el enfoque de prefijo y añaden restricciones que el enfoque de prefijo no tiene.

## Por qué las bases de datos numeradas son una trampa

La propia [documentación de `SELECT`](https://redis.io/docs/latest/commands/select/) de Redis es tajante: las bases de datos sirven para separar claves "within the same application", no para ejecutar cargas de trabajo no relacionadas en un mismo servidor. Luego añade que "Redis Cluster only supports database zero". Esa única frase descarta buena parte del mercado de servicios administrados:

- **Azure Managed Redis** está "internally configured to use clustering, across all tiers and SKUs" según su [página de arquitectura](https://learn.microsoft.com/en-us/azure/redis/architecture), y se ejecuta sobre Redis Enterprise.
- **Redis Software y Redis Cloud** no admiten bases de datos compartidas en absoluto. La página de `SELECT` dice que el comando se "supported solely for compatibility" y que no realiza ninguna operación allí. Si tu código depende de `SELECT` para aislar y migras a uno de ellos, todos los tenants acaban en silencio en el mismo espacio de claves. Es el peor modo de fallo posible en multitenencia: ningún error, solo datos que se filtran entre tenants.
- **Redis OSS en modo cluster** (incluidas la mayoría de las ofertas administradas en modo cluster) rechaza cualquier base de datos distinta de la 0.

La única excepción es Valkey: [Valkey 9.0](https://www.linuxfoundation.org/press/valkey-9.0-delivers-performance-and-resiliency-for-real-time-workloads) añadió bases de datos numeradas en modo cluster, y [Valkey 9.1 añadió reglas ACL `db=`](https://valkey.io/commands/acl-setuser/) para restringir a un usuario a bases de datos concretas. Si ejecutas Valkey 9.1+ y nunca piensas salir de él, las bases de datos se vuelven defendibles. En cualquier otro caso, elegir bases de datos ata tu modelo de tenencia a una única topología de alojamiento.

Incluso donde las bases de datos funcionan, no aíslan aquello por lo que los tenants realmente compiten. `maxmemory` y la política de expulsión se aplican a todo el servidor, así que un tenant que llena su base de datos expulsa claves de todos los demás. Redis ejecuta los comandos en un solo hilo principal, así que un tenant que ejecuta un `KEYS *` lento bloquea todas las bases de datos. Y con el valor por defecto `databases 16`, te quedas sin tenants disponibles antes de quedarte sin clientes.

El otro problema práctico está del lado de .NET. `RedisCache`, la implementación de `IDistributedCache` detrás de `AddStackExchangeRedisCache`, llama a `connection.GetDatabase()` sin argumentos, como puedes ver en [RedisCache.cs](https://github.com/dotnet/aspnetcore/blob/main/src/Caching/StackExchangeRedis/src/RedisCache.cs). Siempre habla con la `DefaultDatabase` de la conexión. Para llegar a la base de datos 7 necesitas un `RedisCache` construido a partir de un `ConfigurationOptions` con `DefaultDatabase = 7`, lo que implica un `ConnectionMultiplexer` separado por cada base de datos en uso, justo la sobrecarga que el multiplexor compartido pretende evitar.

## El enfoque de prefijo de clave, bien hecho

`RedisCacheOptions.InstanceName` está documentado como una forma de particionar "a single backend cache for use with multiple apps/services". Es un prefijo de todo el proceso, así que úsalo para el nombre de la app y pon el tenant en cada clave:

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

El tenant proviene de una fuente de confianza, nunca de una cabecera o cadena de consulta que controle el cliente. Aquí es una claim del usuario autenticado:

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

Lo importante es que el código de la aplicación nunca construye una clave de caché sin procesar. Pasa por un envoltorio con ámbito que añade el tenant cada vez, de modo que un desarrollador no pueda olvidarlo:

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

En Redis, la entrada de producto del tenant 42 termina como el hash `myapp:t:42:product:7`. Las etiquetas también llevan prefijo: las etiquetas de `HybridCache` son cadenas globales, así que un `RemoveByTagAsync("products")` sin prefijo desde un tenant invalidaría las entradas de producto de todos los tenants.

Si usas `IDatabase` directamente para contadores, bloqueos o conjuntos, StackExchange.Redis tiene la misma idea integrada mediante `StackExchange.Redis.KeyspaceIsolation`:

```csharp
// StackExchange.Redis 3.3.1
using StackExchange.Redis.KeyspaceIsolation;

IDatabase tenantDb = mux.GetDatabase().WithKeyPrefix($"myapp:t:{tenantId}:");
await tenantDb.StringIncrementAsync("logins"); // writes myapp:t:42:logins
```

## El problema del L1 que zanja el debate

Este es el detalle que hace obligatorio el prefijo, elijas la opción que elijas. `HybridCache` es una caché de dos niveles, y su L1 es un `MemoryCache` en proceso compartido por todas las solicitudes del proceso. Supón que enrutas al tenant 42 a su propia instancia de Redis y mantienes la clave de caché como un simple `product:7`. La búsqueda en L2 va al servidor correcto, pero la búsqueda en L1 ocurre primero, y el `product:7` del tenant 41 ya está en memoria. El tenant 42 recibe el producto del tenant 41.

Así que las bases de datos separadas y las instancias separadas no eliminan la necesidad de claves con ámbito de tenant. Añaden un segundo mecanismo de aislamiento sobre el que de todos modos tienes que construir. Una vez que existe el prefijo, la única pregunta restante es si algunos tenants necesitan más que separación a nivel de clave.

Lo mismo aplica a la caché de salida. `AddStackExchangeRedisOutputCache` tiene su propio `InstanceName`, y la clave de caché debe variar por tenant (`VaryByValue` sobre la claim del tenant) sin importar dónde se almacenen las entradas.

## Cuándo una instancia separada es la decisión correcta

Un Redis por tenant no es la opción por defecto, pero es un nivel legítimo. Elígelo cuando:

- **Un contrato o un regulador lo exige.** Residencia de datos en una región específica, una clave de cifrado administrada por el cliente, o "sin infraestructura compartida" en un acuerdo empresarial. Los prefijos de clave no satisfacen a un auditor que pide separación física.
- **La carga de un tenant es lo bastante grande como para perjudicar a los demás.** Un tenant con 40 GB de datos calientes o un trabajo por lotes con ráfagas expulsará las claves de todos los demás bajo un `maxmemory` compartido. Sacarlo restaura tasas de acierto predecibles para el resto.
- **Necesitas una política de expulsión o persistencia por tenant.** `maxmemory-policy` y la configuración de AOF y RDB son de todo el servidor.
- **La baja de un tenant debe ser demostrablemente completa.** Eliminar una instancia es más fácil de demostrar que "escaneamos y borramos todas las claves".

La forma habitual es un modelo de pool con un silo premium: todos en la instancia compartida con prefijo, y una lista corta de tenants asignada a instancias dedicadas. Como `AddHybridCache()` conecta exactamente un L2, el enrutamiento tiene que vivir en un `IDistributedCache` que elija el backend en cada llamada:

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

Registra el `RedisCache` compartido como un servicio con clave y el enrutador como el `IDistributedCache` sin clave que resuelve `HybridCache`. Las claves siguen llevando el prefijo del tenant desde `TenantCache`, lo que mantiene seguro el L1. Dos cosas que debes saber sobre este enrutador: depende de `HttpContext`, así que los trabajos en segundo plano deben establecer el tenant de otra forma (sirve un `AsyncLocal` asignado por el ejecutor del trabajo), y se salta la vía rápida `IBufferDistributedCache` de `RedisCache` porque solo implementa la interfaz base. Para un puñado de tenants premium, ese compromiso es aceptable.

Cada `RedisCache` dedicado posee un multiplexor. Un multiplexor está diseñado para compartirse y vivir mucho tiempo, así que mantén estas instancias en caché durante toda la vida del proceso y nunca las crees por solicitud. Con 20 tenants dedicados y 10 pods de la app tienes 200 conexiones extra a Redis, que es el punto donde el modelo de instancia por tenant deja de escalar y la razón por la que debe seguir siendo un nivel y no la opción por defecto.

## Trampas del prefijo de clave

**Termina siempre el prefijo con un delimitador.** `RedisCache` concatena `InstanceName` y la clave sin separador. La [guía de claves de HybridCache](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/hybrid) da el ejemplo clásico: `order{customerId}{orderId}` hace que el cliente 42 con el pedido 123 y el cliente 421 con el pedido 23 resulten ambos en `order42123`. Lo mismo ocurre con los tenants: el tenant `7` con la clave `42:profile` y el tenant `74` con la clave `2:profile` colisionan si escribes `t{tenant}{key}`. Usa `t:{tenant}:` y asegúrate de que los ids de tenant no puedan contener `:`.

**Borrar las claves de un tenant es un escaneo, no un comando.** `RemoveByTagAsync($"tenant:{id}")` es la opción barata, pero es una invalidación lógica: la documentación dice que los valores permanecen en Redis "until they expire in the usual way". Cuando debas eliminar datos físicamente (baja de un tenant, borrado por RGPD), escanea cada primario:

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

`KeysAsync` usa `SCAN` internamente, y en un cluster solo ve las claves de ese nodo, por eso el bucle recorre todos los endpoints. La [documentación de StackExchange.Redis](https://seredis.dev/KeysScan) sigue advirtiendo contra ejecutarlo en servidores de producción con carga, así que hazlo en un trabajo en segundo plano con un tamaño de página modesto.

**No uses hash tags para los tenants.** Escribir las claves como `{t:42}:product:7` fuerza todas las claves de un tenant a un único hash slot, lo que permite operaciones de varias claves pero también ancla al tenant completo a un solo shard. Tu tenant más grande se convierte en un shard caliente. Deja el tenant fuera de las llaves a menos que realmente necesites transacciones entre claves.

**Añade ACL si los tenants tienen acceso directo a Redis.** Normalmente solo tu app habla con Redis, así que el prefijo se hace cumplir mediante revisión de código y el envoltorio `TenantCache`. Si un worker específico de un tenant recibe sus propias credenciales, los patrones de clave ACL de Redis 7 hacen cumplir el prefijo en el servidor: `ACL SETUSER tenant42 on >secret ~myapp:t:42:* +@read +@write`.

**La longitud del prefijo es sobrecarga en cada clave.** `myapp:t:` más un id de tenant GUID son 44 bytes antes de la clave real. En una caché con decenas de millones de entradas pequeñas, eso es memoria real. Un id de tenant entero corto o en base 36 la mantiene insignificante, y te deja lejos del `MaximumKeyLength` de 1024 caracteres de `HybridCache`.

## La recomendación, con sus razones

Usa un prefijo de clave en un Redis compartido. Funciona en cualquier topología, desde un contenedor local hasta Azure Managed Redis con clustering OSS, es la única opción que se combina con una sola llamada a `AddHybridCache()`, y el tenant tiene que estar en la clave de todos modos por el L1 compartido. Añade un nivel de instancia dedicada, enrutado a través de un `IDistributedCache` como el anterior, para los tenants cuyos contratos o cargas justifiquen pagar por el aislamiento. Evita las bases de datos numeradas a menos que estés comprometido con Valkey 9.1+: te dan `FLUSHDB` y conteos de claves por base de datos en `INFO keyspace`, pero comparten memoria y CPU con todos los demás tenants y desaparecen en el momento en que pasas a un Redis en cluster o enterprise.

## Relacionado

- [How to use HybridCache in ASP.NET Core 11 with Redis as the L2 cache](/es/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/) cubre la configuración base sobre la que se apoya este artículo.
- [HybridCache vs IMemoryCache vs IDistributedCache in .NET 11](/es/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/) explica la división L1/L2 que vuelve obligatorias las claves de tenant.
- [Output caching in a minimal API](/es/2026/07/how-to-add-output-caching-to-a-minimal-api-in-aspnetcore-11/) muestra `VaryByValue` para entradas de caché de salida por tenant.
- [Keyed services in .NET dependency injection](/es/2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection/) es cómo se registran lado a lado las cachés compartida y enrutada.
- [Named query filters in EF Core 11](/es/2026/07/named-query-filters-vs-a-single-global-query-filter-in-ef-core-11/) es la contraparte del lado de la base de datos para el aislamiento de tenants.

## Fuentes

- [Comando `SELECT` de Redis](https://redis.io/docs/latest/commands/select/), incluidas las notas sobre cluster y Redis Software.
- [Arquitectura de Azure Managed Redis](https://learn.microsoft.com/en-us/azure/redis/architecture) para los detalles de clustering y política de cluster.
- [Valkey `ACL SETUSER`](https://valkey.io/commands/acl-setuser/) para los patrones de clave y las reglas `db=` de 9.1.
- [RedisCacheOptions.cs](https://github.com/dotnet/aspnetcore/blob/main/src/Caching/StackExchangeRedis/src/RedisCacheOptions.cs) y [RedisCache.cs](https://github.com/dotnet/aspnetcore/blob/main/src/Caching/StackExchangeRedis/src/RedisCache.cs) para ver cómo se aplican `InstanceName` y la base de datos.
- [Biblioteca HybridCache en ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/hybrid) para la guía de claves y la semántica de invalidación por etiquetas.
- [StackExchange.Redis: KEYS, SCAN, FLUSHDB etc](https://seredis.dev/KeysScan) para el escaneo en clusters.
