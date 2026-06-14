---
title: "HybridCache vs IMemoryCache vs IDistributedCache en .NET 11: ¿cuál deberías elegir?"
description: "Para el código de caché nuevo en .NET 11, usa HybridCache por defecto. Recurre a IMemoryCache solo cuando necesites velocidad en un único servidor sin serialización, y a IDistributedCache solo como almacén de respaldo. Aquí tienes la matriz de decisión."
pubDate: 2026-06-14
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "aspnetcore"
  - "caching"
  - "performance"
lang: "es"
translationOf: "2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-06-14
---

Para el código de caché nuevo en .NET 11, usa `HybridCache` por defecto. Te da la velocidad en proceso de `IMemoryCache`, el alcance entre servidores de `IDistributedCache`, y protección contra estampidas más invalidación por etiquetas que ninguna de las APIs antiguas tiene, todo detrás de una sola llamada a `GetOrCreateAsync`. Recurre a `IMemoryCache` puro solo cuando necesites latencia de un único servidor sin serialización y control fino de la expulsión, y recurre a `IDistributedCache` puro principalmente cuando necesites un almacén distribuido sin un nivel L1 (o como capa de respaldo de `HybridCache`). Este artículo respalda esa recomendación con la matriz de características completa, las diferencias de API que realmente importan, y el detalle que decide por ti.

Todo lo que sigue apunta a .NET 11, ASP.NET Core 11 y C# 14. `HybridCache` se distribuye en el paquete `Microsoft.Extensions.Caching.Hybrid`, que llegó a GA junto con .NET 9 y es el mismo paquete que usas en .NET 11. Es compatible con runtimes hasta .NET Framework 4.7.2 y .NET Standard 2.0, así que la comparación de abajo no se limita al TFM más reciente.

## La matriz de características

| Característica                  | IMemoryCache              | IDistributedCache               | HybridCache                          |
| ------------------------------- | ------------------------- | ------------------------------- | ------------------------------------ |
| Nivel                           | L1 (en proceso)           | L2 (fuera de proceso)           | L1 + L2 opcional                     |
| Compartido entre servidores     | No                        | Sí                              | Sí (vía L2)                          |
| Sobrevive al reinicio del proceso | No                      | Sí                              | L2 sobrevive, L1 no                  |
| Se almacena como                | objeto vivo               | `byte[]`                        | objeto en L1, serializado en L2      |
| Serialización                   | ninguna                   | la escribes tú                  | integrada (`System.Text.Json` y más) |
| Protección contra estampidas    | no                        | no                              | sí                                   |
| Invalidación por etiquetas      | no                        | no                              | sí (`RemoveByTagAsync`)              |
| Obtener-o-crear en una llamada  | solo extensión, sin guarda | no                             | sí (`GetOrCreateAsync`)              |
| Control de expiración por entrada | completo                | absoluta + deslizante           | global + local (`LocalCacheExpiration`) |
| Métricas OpenTelemetry integradas | sí (.NET 11)            | depende del backend             | sí                                   |
| Incluido (sin NuGet)            | sí                        | abstracción sí, backends no     | no (un paquete)                      |
| Runtime mínimo                  | amplio                    | amplio                          | .NET Framework 4.7.2 / netstandard2.0 |

Las tres se registran a través de DI y se resuelven por interfaz (o, para `HybridCache`, una clase abstracta). Las diferencias que importan no están en el registro, están en lo que cada una hace ante un fallo de caché y bajo concurrencia.

## Qué es realmente cada API

`IMemoryCache` almacena referencias a objetos vivos en un almacén respaldado por `ConcurrentDictionary` dentro de tu proceso. No hay serialización: metes un `Customer` y obtienes la misma referencia `Customer`. Eso lo convierte en el más rápido de los tres y el único donde un acierto de caché cuesta esencialmente una búsqueda en un diccionario. El precio es que es por proceso: dos instancias detrás de un balanceador de carga tienen dos cachés independientes, y un reinicio lo vacía.

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

`IDistributedCache` es una abstracción deliberadamente de bajo nivel sobre un almacén fuera de proceso. Su superficie es `GetAsync`, `SetAsync`, `RefreshAsync` y `RemoveAsync` (más las variantes síncronas), y cada valor es un `byte[]`. No hay `GetOrCreate`, ni modelo de objetos, ni control de concurrencia. Tú te encargas de la serialización, el nombrado de claves, la política de expiración y el patrón de lectura directa.

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

Eso es aproximadamente quince líneas de código repetitivo por valor cacheado, y cada copia es una ocasión para olvidar la expiración, gestionar mal un null, o elegir un serializador ligeramente distinto. Las implementaciones integradas incluyen en memoria (`AddDistributedMemoryCache`, solo para desarrollo y pruebas, ya que no es realmente distribuido), Redis (`AddStackExchangeRedisCache`), SQL Server (`AddDistributedSqlServerCache`), Azure Cache for Redis, y almacenes de terceros como NCache.

`HybridCache` es la abstracción que Microsoft añadió para fundir los dos patrones de arriba en uno. Mantiene un L1 en proceso (un `MemoryCache` por defecto) y, si has registrado un `IDistributedCache`, lo usa automáticamente como L2. Una llamada a `GetOrCreateAsync` comprueba L1, luego L2, luego ejecuta tu factoría y escribe de vuelta en ambos niveles. Nunca tocas la serialización a menos que quieras.

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

Mismo resultado que el bloque de `IDistributedCache`, tres líneas en lugar de quince, con protección contra estampidas y un nivel L1 que no tuviste que cablear.

## Cuándo elegir IMemoryCache directamente

- **Cachés de un único servidor o por nodo donde los datos son baratos de recalcular tras un reinicio.** Una tabla de búsqueda cargada una vez por proceso, una config analizada, un bucket de limitador de tasa. No hay beneficio en serializarlos fuera de proceso. Combínalo con el nuevo medidor OpenTelemetry integrado en .NET 11 para seguir obteniendo métricas de ratio de aciertos y expulsiones sin un sondeo personalizado, como se cubre en [el artículo sobre las métricas de MemoryCache en .NET 11](/es/2026/06/dotnet-11-memorycache-opentelemetry-metrics/).
- **Rutas críticas donde incluso una ronda de serialización es demasiado.** Como `IMemoryCache` devuelve el objeto vivo, un acierto es una lectura de diccionario. Si estás cacheando un valor leído miles de veces por segundo en una sola máquina, eso importa. Este es el mismo razonamiento detrás de mantener residente un plan de consulta, como en [las consultas compiladas para rutas críticas de EF Core](/es/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/).
- **Necesitas características de expulsión que `HybridCache` no expone.** Los límites por tamaño (`SizeLimit` más `Size` por entrada), la prioridad de expulsión y `PostEvictionCallbacks` son conceptos de `IMemoryCache`. `HybridCache` no los expone en su API.

La trampa que aceptas al ir directo: `GetOrCreateAsync` en `IMemoryCache` es un método de extensión sin guarda contra estampidas. Bajo una ráfaga con caché fría, cada llamador concurrente ejecuta la factoría.

## Cuándo elegir IDistributedCache directamente

- **Necesitas un almacén compartido pero explícitamente no quieres un nivel L1.** Si la corrección depende de que cada nodo vea el mismo valor en el instante en que cambia, un L1 en proceso con su propia expiración es un riesgo, porque invalidar una clave no llega al L1 de otros servidores (más sobre esto abajo). Ir directo a Redis elimina la ventana de obsolescencia que introduce el L1.
- **En realidad no estás cacheando.** `IDistributedCache` respalda el estado de sesión de ASP.NET Core y puede contener claves de Data Protection. Esos son casos de uso de almacenamiento, no cachés de lectura directa, y `HybridCache` tiene la forma equivocada para ellos.
- **Necesitas control total sobre los bytes serializados.** Formatos binarios personalizados, compresión que gestionas tú, o interoperabilidad con otro sistema que lee las mismas claves de Redis. `HybridCache` puede tomar un serializador personalizado, pero si los bytes son el contrato, la API de más bajo nivel es más honesta.

## Cuándo elegir HybridCache (la opción por defecto)

- **Cualquier caché de lectura directa nueva en una app que podría escalar más allá de una instancia.** Obtienes la velocidad de L1 hoy y la corrección de L2 en el momento en que registras una caché Redis, sin cambios en el código en el punto de llamada. Esta es exactamente la configuración descrita en [usar HybridCache con Redis como caché L2](/es/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/).
- **Donde una estampida de caché haría daño.** `HybridCache` garantiza que, para una clave dada, solo un llamador concurrente ejecuta la factoría mientras el resto esperan ese único resultado. Una caché fría golpeada por cien solicitudes emite una consulta de respaldo, no cien, que es el mismo problema que combates al perseguir [consultas N+1 en EF Core 11](/es/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/).
- **Quieres invalidación agrupada.** Etiqueta un conjunto de entradas (`tags: ["product", $"category:{categoryId}"]`) y elimínalas juntas con `RemoveByTagAsync("category:42")`. Ninguna de las APIs antiguas tiene concepto de etiqueta.

## El benchmark de estampida, en concreto

Esta es la diferencia que aparece en producción, así que vale la pena medirla en lugar de afirmarla. Toma una factoría que simula una lectura de base de datos de 200 ms y lanza 100 llamadas concurrentes a `GetOrCreateAsync` para la misma clave contra una caché fría.

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

Con `HybridCache`, `_factoryCalls` es **1**: un llamador ejecuta la factoría de 200 ms y los otros 99 esperan su resultado, así que toda la ráfaga se despeja en aproximadamente 200 ms con una sola llamada de respaldo. Cambia al método de extensión `GetOrCreateAsync` de `IMemoryCache` y `_factoryCalls` sube hasta **100**, porque nada serializa a los llamadores que fallan en frío. Contra una base de datos real eso es la diferencia entre una consulta y un atasco de cien en el pool de conexiones. El recuento exacto para el caso de `IMemoryCache` varía con el tiempo (algunos llamadores pueden llegar después de que la primera escritura se complete), que es precisamente el punto: no está acotado y es no determinista, mientras que `HybridCache` lo fija en uno. Cifras medidas en .NET 11 (11.0.x), Windows 11, solo con el L1 integrado y sin L2 configurado.

## Expiración: los nombres de las opciones difieren de una forma que muerde

Las tres APIs nombran la expiración de forma distinta, y confundirlos es el error de configuración más común.

`IMemoryCache` usa `MemoryCacheEntryOptions` con `AbsoluteExpiration`, `AbsoluteExpirationRelativeToNow` y `SlidingExpiration`. `IDistributedCache` usa `DistributedCacheEntryOptions` con los mismos tres nombres. `HybridCache` usa `HybridCacheEntryOptions` con dos propiedades que significan algo distinto:

```csharp
// .NET 11, C# 14
var options = new HybridCacheEntryOptions
{
    Expiration = TimeSpan.FromMinutes(5),        // overall lifetime (drives L2)
    LocalCacheExpiration = TimeSpan.FromMinutes(1) // how long the L1 copy is trusted
};
```

`Expiration` es la vida útil total de la entrada, y gobierna la copia de L2. `LocalCacheExpiration` es cuánto tiempo se considera válida la copia L1 en proceso antes de que la entrada se vuelva a obtener de L2. Establecer `LocalCacheExpiration` más corto que `Expiration` es como acotas la obsolescencia de L1 en un despliegue multiservidor: cada nodo confía en su copia local durante un minuto como máximo, luego revalida contra el L2 compartido. No hay concepto de expiración deslizante en `HybridCache`; si dependes de ventanas deslizantes, esa es una razón para quedarte con la API de más bajo nivel.

Otros valores por defecto que conviene conocer: `HybridCacheOptions.MaximumPayloadBytes` tiene por defecto 1 MB y `MaximumKeyLength` 1024 caracteres. Los valores o claves por encima del límite se registran y silenciosamente no se cachean, lo cual es un modo de fallo silencioso si cacheas blobs grandes.

## El detalle que decide por ti

La invalidación por etiquetas y por clave en `HybridCache` no llega al L1 de otros servidores. Cuando llamas a `RemoveByTagAsync` o `RemoveAsync`, la entrada se elimina del L1 local y del L2 compartido, pero cada otro nodo sigue sirviendo su propia copia L1 hasta que esa copia expire por su propio `LocalCacheExpiration`. La documentación es explícita: la invalidación por etiquetas es una operación lógica que marca las lecturas futuras como fallos, no purga activamente otros nodos.

Ese único comportamiento decide varios diseños:

- Si puedes tolerar una ventana de obsolescencia acotada (establece `LocalCacheExpiration` a la ventana que aceptas), `HybridCache` es ideal y conservas la velocidad de L1.
- Si no puedes tolerar ninguna ventana, porque un valor de autorización o de precio obsoleto es un error de corrección, entonces un nivel L1 es la herramienta equivocada, y deberías ir directo a `IDistributedCache` (o establecer `LocalCacheExpiration` a cero, lo que en gran medida anula el propósito del L1).

La otra función forzosa es la **seguridad de serialización**. `HybridCache` deserializa un objeto nuevo por llamador por defecto para preservar las garantías de seguridad para hilos de `IDistributedCache`. Si tu tipo cacheado es inmutable, puedes optar por la reutilización de instancias sellando el tipo y aplicando `[ImmutableObject(true)]`, lo que elimina la sobrecarga de deserialización por llamada. Si tus objetos cacheados son mutables y compartidos, no apliques ese atributo, o introducirás condiciones de carrera.

## La recomendación, reafirmada

En .NET 11, escribe el código de caché nuevo contra `HybridCache` a menos que tengas una razón específica para no hacerlo. Es casi un reemplazo directo de ambas APIs antiguas, elimina el código repetitivo de cache-aside que `IDistributedCache` te impone, y cierra el agujero de estampida que deja abierto el `IMemoryCache.GetOrCreateAsync` sin guarda. Baja a `IMemoryCache` puro cuando necesites velocidad de un único servidor, cero serialización, o características de expulsión (límites de tamaño, prioridad, callbacks de expulsión) que `HybridCache` no expone. Baja a `IDistributedCache` puro cuando necesites un almacén compartido sin ventana de obsolescencia de L1, cuando los bytes serializados sean un contrato con otro sistema, o cuando lo uses para almacenamiento de sesión y claves en lugar de caché. Para todo lo demás, que es la mayoría del caché, `HybridCache` es la respuesta.

## Relacionado

- [Cómo usar HybridCache en ASP.NET Core 11 con Redis como caché L2](/es/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/)
- [.NET 11 da a MemoryCache métricas OpenTelemetry de primera clase](/es/2026/06/dotnet-11-memorycache-opentelemetry-metrics/)
- [Cómo detectar consultas N+1 en EF Core 11](/es/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [Cómo usar consultas compiladas con EF Core para rutas críticas](/es/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)

## Fuentes

- [Biblioteca HybridCache en ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/hybrid?view=aspnetcore-10.0)
- [Caché distribuida en ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/distributed?view=aspnetcore-10.0)
- [Caché en memoria en ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/memory?view=aspnetcore-10.0)
- [Hello HybridCache! (Blog de .NET de Microsoft, anuncio de GA)](https://devblogs.microsoft.com/dotnet/hybrid-cache-is-now-ga/)
- [Resumen de caché en ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/overview?view=aspnetcore-10.0)
