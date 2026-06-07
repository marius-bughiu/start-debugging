---
title: "Cómo usar HybridCache en ASP.NET Core 11 con Redis como caché L2"
description: "Conecta HybridCache a un L2 de Redis en ASP.NET Core 11: registra el servicio, agrega la caché distribuida de StackExchange Redis y deja que GetOrCreateAsync te dé una caché de dos niveles con protección contra estampidas y invalidación por etiquetas integradas."
pubDate: 2026-06-07
template: how-to
tags:
  - "aspnetcore"
  - "dotnet"
  - "performance"
lang: "es"
translationOf: "2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache"
translatedBy: "claude"
translationDate: 2026-06-07
---

Para usar HybridCache con Redis como caché de segundo nivel en ASP.NET Core 11, instala `Microsoft.Extensions.Caching.Hybrid`, llama a `builder.Services.AddHybridCache()` y luego registra un `IDistributedCache` respaldado por Redis con `AddStackExchangeRedisCache(...)`. HybridCache toma automáticamente ese `IDistributedCache` como su L2. A partir de ahí, cada llamada a `GetOrCreateAsync` lee primero L1 (memoria en proceso), recurre a L2 (Redis) y solo llama a tu factory cuando hay un fallo completo. Obtienes protección contra estampidas de caché e invalidación basada en etiquetas sin coste, sin código repetitivo de cache-aside. Este artículo recorre la configuración completa, las opciones que de verdad importan y la trampa con múltiples instancias que confunde a mucha gente.

Todos los ejemplos apuntan a .NET 11, ASP.NET Core 11 y C# 14, usando `Microsoft.Extensions.Caching.Hybrid` 9.x (el paquete llegó a GA con .NET 9 y es el mismo paquete que usas en .NET 11). La biblioteca en sí admite runtimes hasta .NET Framework 4.7.2 y .NET Standard 2.0, así que el mismo código funciona en hosts más antiguos.

## Por qué existe HybridCache

Si has lanzado antes una caché distribuida, has escrito este bucle a mano: revisa `IMemoryCache`, fallo, revisa `IDistributedCache` (Redis), fallo, deserializa, llama a la base de datos, serializa, vuelve a escribir en ambas capas, devuelve. Multiplica eso por cada valor en caché y tienes un montón de código de cache-aside casi idéntico, cada copia con su propio error sutil. Los dos errores clásicos son una protección contra estampidas ausente (cien solicitudes llegan a una clave expirada a la vez y todas martillean la base de datos) y una serialización inconsistente entre las dos capas.

HybridCache reduce todo eso a una sola llamada. Es una caché de dos niveles: L1 es una `MemoryCache` en proceso (rápida, por servidor, perdida al reiniciar), y L2 es cualquier `IDistributedCache` que registres (Redis, SQL Server, Postgres, Garnet). El punto clave para este artículo: no configuras el L2 directamente en HybridCache. HybridCache descubre el `IDistributedCache` desde el contenedor de inyección de dependencias. Registra una caché distribuida de Redis y HybridCache la usa como L2 automáticamente.

## Conectar Redis como caché L2

Aquí está la configuración de extremo a extremo como un procedimiento numerado.

1. Instala los dos paquetes. El primero trae HybridCache; el segundo es el `IDistributedCache` de Redis basado en StackExchange.

   ```dotnetcli
   dotnet add package Microsoft.Extensions.Caching.Hybrid
   dotnet add package Microsoft.Extensions.Caching.StackExchangeRedis
   ```

2. Guarda la cadena de conexión de Redis en la configuración. Mantenla fuera del control de versiones con un archivo de user-secrets en desarrollo:

   ```json
   {
     "ConnectionStrings": {
       "RedisConnectionString": "localhost:6379"
     }
   }
   ```

3. Registra el `IDistributedCache` de Redis. Este es el L2. `AddStackExchangeRedisCache` coloca un `IDistributedCache` en la inyección de dependencias respaldado por tu instancia de Redis.

   ```csharp
   // .NET 11, ASP.NET Core 11, C# 14
   var builder = WebApplication.CreateBuilder(args);

   builder.Services.AddStackExchangeRedisCache(options =>
   {
       options.Configuration =
           builder.Configuration.GetConnectionString("RedisConnectionString");
   });
   ```

4. Registra HybridCache. Encontrará el `IDistributedCache` del paso 3 y lo usará como L2. Sin un `IDistributedCache` registrado, HybridCache aún funciona como una caché en proceso solo de L1, así que esta única línea es lo único que "activa" el comportamiento de dos niveles.

   ```csharp
   // .NET 11, ASP.NET Core 11
   builder.Services.AddHybridCache();

   var app = builder.Build();
   ```

Ese es todo el cableado. El orden no importa entre los pasos 3 y 4 porque la inyección de dependencias resuelve el `IDistributedCache` de forma diferida cuando HybridCache lo necesita por primera vez. No hay una llamada `UseRedis()` en HybridCache ni una opción de L2 para apuntar a Redis. El descubrimiento es implícito a través de `IDistributedCache`, que es exactamente por qué el mismo código de HybridCache se ejecuta contra Redis, SQL Server o sin L2 en absoluto sin cambiar una línea.

## Leer y escribir con GetOrCreateAsync

`GetOrCreateAsync` es la API que usarás el 95% del tiempo. Inyecta `HybridCache` y llámala con una clave y un factory:

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

En la primera llamada para `product:42`, HybridCache falla en L1, falla en L2, ejecuta el factory, serializa el resultado, lo escribe tanto en Redis como en la caché en proceso y devuelve. La siguiente llamada en el mismo servidor acierta en L1 y nunca toca Redis. Una llamada en un servidor diferente de tu clúster falla en L1 pero acierta en L2 (Redis), así que se salta la base de datos y rellena su propio L1. Esa es la ventaja de los dos niveles: las claves calientes se quedan en proceso, las claves tibias se quedan en Redis y la base de datos solo ve un fallo cuando ambas capas están frías.

Observa la cadena interpolada pasada directamente dentro de la llamada. La documentación recomienda escribir la clave en línea así en lugar de construirla primero en una variable local, porque permite que versiones futuras de la biblioteca eviten la asignación de la cadena en algunos casos. También hay una segunda sobrecarga de `GetOrCreateAsync` que toma una tupla `state` más una lambda `static`, lo que evita asignaciones de clausura en rutas calientes:

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

Usa la sobrecarga sin estado por defecto. Recurre a la que tiene estado solo cuando un profiler te diga que la asignación de la clausura importa, lo cual es raro frente al coste de un viaje de ida y vuelta a la base de datos.

## La protección contra estampidas es la función que realmente compras

Esta es la parte difícil de acertar a mano. Cuando una clave popular expira y llega una ráfaga de solicitudes, un cache-aside ingenuo deja que cada solicitud falle y llame al factory a la vez. HybridCache garantiza que para una clave dada en un servidor dado, solo un llamador ejecuta el factory. El resto espera el mismo resultado.

```csharp
// 100 concurrent requests for the same cold key
// -> exactly 1 factory invocation, 99 awaiters share the result
var tasks = Enumerable.Range(0, 100)
    .Select(_ => service.GetProductAsync(42, ct));
var results = await Task.WhenAll(tasks);
```

Una sutileza: el `CancellationToken` que pasas representa la cancelación combinada de todos los llamadores en cola. El factory sigue ejecutándose mientras al menos un llamador todavía quiera el resultado, así que un solo cliente que se desconecta no cancelará el trabajo compartido para todos los demás.

La advertencia honesta: esta protección es por instancia. HybridCache no incluye un bloqueo distribuido, así que en un clúster de tres servidores una clave fría puede desencadenar hasta tres llamadas al factory, una por servidor, no una en toda la flota. Para la mayoría de las cargas de trabajo eso está bien. Si de verdad necesitas un single-flight a nivel de clúster, necesitas un bloqueo distribuido externo o una caché de terceros como FusionCache que añada una capa con uno. No asumas que "protección contra estampidas" significa "una consulta a la base de datos en todos los servidores".

## Expiración: los dos relojes que controlas

`HybridCacheEntryOptions` expone dos ajustes de expiración, y confundirlos es el error de configuración más común:

- `Expiration` es la vida útil total, incluyendo la copia de L2 (Redis).
- `LocalCacheExpiration` es la vida útil de L1 en proceso. Suele ser más corta que `Expiration`.

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

Mantener `LocalCacheExpiration` más corta que `Expiration` es un patrón deliberado: limita cuánto tiempo puede un servidor servir datos obsoletos desde su propia memoria, mientras deja que Redis retenga el valor más tiempo para compartirlo entre servidores. Un L1 corto más un L2 más largo significa que la ventana de datos obsoletos de un servidor es pequeña, pero el clúster en su conjunto aún evita la base de datos. Puedes anular estos valores por llamada pasando un `HybridCacheEntryOptions` a `GetOrCreateAsync`.

La propiedad `Flags` en `HybridCacheEntryOptions` te permite deshabilitar un nivel para una entrada específica, por ejemplo `HybridCacheEntryFlags.DisableLocalCacheWrite` para saltar L1 en un valor grande que se lee pocas veces, o `DisableDistributedCache` para mantener algo solo en proceso. Recurre a estas opciones de forma quirúrgica; los valores predeterminados son los correctos para la mayoría de las entradas.

## Invalidar por clave y por etiqueta

Cuando los datos subyacentes cambian, desaloja la entrada. Por clave:

```csharp
await cache.RemoveAsync($"product:{id}", ct);
```

Las etiquetas son la herramienta más potente. Adjunta etiquetas al crear una entrada y luego invalida un grupo entero en una sola llamada:

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

Esto reemplaza el viejo patrón de rastrear qué claves pertenecen a qué grupo en un diccionario aparte. `RemoveByTagAsync("products")` invalida todo lo etiquetado como `products` en una sola llamada. Hay un comodín: `RemoveByTagAsync("*")` invalida lógicamente toda la caché, incluso las entradas sin etiqueta. La coincidencia glob no es compatible, así que `RemoveByTagAsync("foo*")` no elimina las claves que empiezan por `foo`.

Aquí está el matiz que sorprende a la gente. Ni `IMemoryCache` ni `IDistributedCache` entienden las etiquetas, así que la invalidación por etiqueta es una operación lógica, no un borrado físico. HybridCache no entra en Redis y borra las claves etiquetadas. En su lugar, registra que la etiqueta fue invalidada y, en la próxima lectura de cualquier entrada que lleve esa etiqueta, trata el valor como un fallo y lo vuelve a obtener. Los bytes permanecen en Redis y en memoria hasta que expiran de forma natural. Para la corrección esto está bien. Para la contabilidad de memoria de Redis significa que la invalidación por etiqueta no libera espacio de inmediato.

## La trampa con múltiples instancias que pilla a todos

Lee esto dos veces si ejecutas más de un servidor. Cuando llamas a `RemoveAsync` o `RemoveByTagAsync`, la entrada se invalida en el servidor actual y en el L2 (Redis). No se invalida en el L1 (memoria en proceso) de los otros servidores. Cada uno de esos servidores seguirá sirviendo su propia copia en caché hasta que esa copia agote su `LocalCacheExpiration`.

Así que si tienes cinco servidores y eliminas `product:42` en el servidor A, los servidores B a E todavía pueden devolver el producto antiguo desde su memoria local hasta `LocalCacheExpiration`. Esta es la razón más importante para mantener `LocalCacheExpiration` corta en datos que se invalidan explícitamente. Si necesitas una invalidación entre servidores casi instantánea, tienes que difundirla tú mismo, por ejemplo con un mensaje de publicación/suscripción de Redis que cada servidor maneje llamando a su propio `RemoveAsync`. HybridCache no hace esta propagación por ti de fábrica.

## Serialización y objetos grandes

Para el almacenamiento en L2, los valores deben serializarse. HybridCache maneja `string` y `byte[]` internamente y usa `System.Text.Json` para todo lo demás por defecto. Puedes cambiar a un serializador específico de tipo o general (protobuf, MessagePack, XML) encadenándolo a `AddHybridCache`:

```csharp
// .NET 11 - custom serializer for one type
builder.Services
    .AddHybridCache()
    .AddSerializer<Product, ProtobufProductSerializer>();
```

Dos límites que recordar. `MaximumPayloadBytes` tiene un valor predeterminado de 1 MB; los valores mayores que eso se registran y silenciosamente no se almacenan en caché, así que un objeto sobredimensionado se convierte en un fallo permanente que siempre llega a tu factory. `MaximumKeyLength` tiene un valor predeterminado de 1024 caracteres; las claves más largas evitan la caché por completo. Si construyes claves a partir de la entrada del usuario, limita su longitud y nunca confíes en cadenas de usuario en bruto como claves, tanto para mantenerte bajo el límite como para evitar un ataque de denegación de servicio por inundación de caché.

Si tu tipo en caché es inmutable, puedes decirle a HybridCache que se salte la deserialización defensiva por llamada y entregue una instancia compartida, lo que reduce CPU y asignaciones para objetos grandes o calientes. Marca el tipo como `sealed` y aplica `[ImmutableObject(true)]`:

```csharp
// .NET 11, C# 14 - safe to reuse the same instance across callers
[ImmutableObject(true)]
public sealed record Product(int Id, string Name, decimal Price);
```

Haz esto solo cuando el objeto verdaderamente nunca se muta tras su creación; de lo contrario, reintroduces los errores de concurrencia de los que te protege el comportamiento predeterminado. Para Redis en concreto, el paquete `Microsoft.Extensions.Caching.StackExchangeRedis` puede implementar `IBufferDistributedCache`, que permite a HybridCache evitar asignaciones de `byte[]` en la ruta de L2. Eso vale la pena habilitarlo en servicios de alto rendimiento.

## Dónde encaja HybridCache junto a lo que ya usas

HybridCache no reemplaza a `IMemoryCache` ni a `IDistributedCache`; se sitúa por encima de ellos y orquesta ambos. Si todavía haces cache-aside a mano sobre `IMemoryCache`, o vigilas la tasa de aciertos de caché con el nuevo medidor integrado descrito en [las métricas de OpenTelemetry de primera clase para MemoryCache en .NET 11](/es/2026/06/dotnet-11-memorycache-opentelemetry-metrics/), HybridCache es la capa que une los niveles en proceso y distribuido con una sola API consistente. Combina de forma natural con la historia de resiliencia en [Polly frente a los controladores de resiliencia integrados en .NET 11](/es/2026/05/polly-vs-resilience-handlers-in-dotnet-11/), ya que tanto el almacenamiento en caché como el reintento protegen una dependencia lenta.

El almacenamiento en caché es también la solución más barata para los problemas de consulta que puedes ver en [detectar consultas N+1 en EF Core 11](/es/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/): una vez que una consulta es correcta, almacenar su resultado la mantiene fuera de la ruta caliente, lo que complementa a [las consultas compiladas para rutas calientes de EF Core](/es/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/). Y como la serialización de L2 pasa por `System.Text.Json` de forma predeterminada, las mismas reglas de [escribir un JsonConverter personalizado en System.Text.Json](/es/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) aplican a cualquier cosa que almacenes en caché que necesite serialización personalizada.

El modelo mental que conviene retener: HybridCache te da una caché de dos niveles, protección contra estampidas por servidor e invalidación lógica por etiquetas, todo detrás de `GetOrCreateAsync`. Redis se convierte en el L2 en el momento en que registras un `IDistributedCache`. Las dos cosas que no hace, single-flight a nivel de clúster e invalidación de L1 entre servidores, son exactamente las dos cosas que debes diseñar con cuidado: con un `LocalCacheExpiration` corto y, si lo necesitas, tu propia invalidación por publicación/suscripción.

## Fuentes

- [Biblioteca HybridCache en ASP.NET Core, Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/hybrid?view=aspnetcore-10.0)
- [Hello HybridCache! Streamlining Cache Management for ASP.NET Core Applications, .NET Blog](https://devblogs.microsoft.com/dotnet/hybrid-cache-is-now-ga/)
- [Referencia de la API IBufferDistributedCache](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.caching.distributed.ibufferdistributedcache)
- [Integración de FusionCache con HybridCache](https://github.com/ZiggyCreatures/FusionCache/blob/main/docs/MicrosoftHybridCache.md)
</content>
