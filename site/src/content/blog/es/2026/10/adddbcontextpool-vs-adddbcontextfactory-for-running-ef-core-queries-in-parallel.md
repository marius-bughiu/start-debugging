---
title: "AddDbContextPool vs AddDbContextFactory para ejecutar consultas de EF Core en paralelo"
description: "AddDbContextPool entrega un DbContext con ámbito por cada ámbito de DI, así que no puede ejecutar dos consultas a la vez. AddDbContextFactory y AddPooledDbContextFactory te dan un contexto por llamada, que es lo que necesitan las consultas en paralelo. Medido en EF Core 11 RC 1: la factoría con pool crea un contexto en 342 ns y 40 B frente a 17 us y 44 KB."
pubDate: 2026-10-08
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "dotnet"
  - "dotnet-11"
  - "performance"
  - "dependency-injection"
lang: "es"
translationOf: "2026/10/adddbcontextpool-vs-adddbcontextfactory-for-running-ef-core-queries-in-parallel"
translatedBy: "claude"
translationDate: 2026-10-08
---

Si quieres ejecutar consultas de EF Core en paralelo, `AddDbContextPool` por sí solo es la herramienta equivocada: registra tu `DbContext` como un servicio con ámbito (scoped), así que todo lo que ocurre en una solicitud (un ámbito de DI) comparte una única instancia, y un solo `DbContext` no puede ejecutar dos operaciones a la vez. `AddDbContextFactory` registra un `IDbContextFactory<T>` singleton que te entrega un contexto nuevo en cada llamada, que es exactamente la forma que necesita `Task.WhenAll`. Si quieres ambas cosas, registra `AddPooledDbContextFactory`: es la misma API de factoría respaldada por el mismo pool que usa `AddDbContextPool`, de modo que cada rama paralela alquila su propia instancia reciclada.

Todo lo que sigue se midió en EF Core 11.0.0-rc.1.26425.128 con el SDK 11.0.100-rc.1.26425.128 y `Microsoft.EntityFrameworkCore.Sqlite` en un Apple M4. Volví a ejecutar el mismo arnés en EF Core 10.0.12 con .NET 10.0.10: los registros, el comportamiento de reutilización y el tamaño del pool fueron idénticos, y los tiempos estuvieron dentro del mismo rango (14.3 us y 43 KB por contexto sin pool, 357 ns y 40 B con pool).

## La comparación de un vistazo

| | `AddDbContextPool<T>` | `AddDbContextFactory<T>` | `AddPooledDbContextFactory<T>` |
| --- | --- | --- | --- |
| Lo que inyectas | `T` (con ámbito) | `IDbContextFactory<T>` (singleton) | `IDbContextFactory<T>` (singleton) |
| También registra `T` con ámbito | Sí, es el servicio principal | Sí | Sí |
| Contextos por ámbito de DI | 1 | Tantos como crees | Tantos como crees |
| Seguro para `Task.WhenAll` en una solicitud | No | Sí | Sí |
| Instancias reutilizadas tras `Dispose` | Sí | No | Sí |
| Costo de crear + liberar (medido) | n/a mediante el ámbito de DI | 17 250 ns, 44 888 B | 342 ns, 40 B |
| El constructor puede recibir servicios con ámbito | No | Sí | No |
| `OnConfiguring` se ejecuta | Una vez por instancia del pool | En cada instancia | Una vez por instancia del pool |
| Tamaño de pool por defecto | 1024 | n/a | 1024 |

La fila de "seguro en paralelo" es la que trata este artículo, y la decide el tiempo de vida, no el pooling. El pooling solo decide cuán costoso es cada contexto.

## Por qué un DbContext no puede ejecutar dos consultas a la vez

Un `DbContext` es dueño de un change tracker, una conexión y, durante una consulta, un data reader abierto. Ninguno de ellos es seguro entre hilos, y EF Core no intenta que lo sea. En cambio, tiene un detector de concurrencia que lanza una excepción en cuanto empieza una segunda operación mientras la primera sigue en curso. Cubrí esa excepción en detalle en [el artículo sobre "A second operation was started on this context instance"](/es/2026/05/fix-second-operation-was-started-on-this-context-instance/), pero la versión corta importa aquí: en EF Core, paralelismo siempre significa un contexto por operación concurrente.

Ahí es donde `AddDbContextPool` hace tropezar a la gente. Suena como si debiera ayudar con la concurrencia ("un pool de contextos"), pero el pool se comparte entre ámbitos, no dentro de uno. Esto es lo que contiene realmente el contenedor después de cada llamada, volcado desde un `ServiceCollection` de EF Core 11 RC 1:

```text
--- AddDbContextPool
  Singleton IDbContextOptionsConfiguration<AppDb>
  Singleton DbContextOptions<AppDb>
  Singleton IDbContextPool<AppDb>
  Scoped    IScopedDbContextLease<AppDb>
  Scoped    AppDb
--- AddDbContextFactory
  Singleton IDbContextOptionsConfiguration<AppDb>
  Singleton DbContextOptions<AppDb>
  Singleton IDbContextFactorySource<AppDb>
  Singleton IDbContextFactory<AppDb>
  Scoped    AppDb
--- AddPooledDbContextFactory
  Singleton IDbContextOptionsConfiguration<AppDb>
  Singleton DbContextOptions<AppDb>
  Singleton IDbContextPool<AppDb>
  Singleton IDbContextFactory<AppDb>
  Scoped    AppDb
```

Con `AddDbContextPool`, `AppDb` tiene ámbito y se obtiene del pool mediante `IScopedDbContextLease<AppDb>`. Si lo resuelves dos veces en un mismo ámbito, obtienes el mismo objeto. No hay ningún `IDbContextFactory<AppDb>` en el contenedor, así que tampoco puedes pedir un segundo contexto.

## La consulta paralela que falla con AddDbContextPool

Este es el repro mínimo. Un controlador o endpoint de minimal API recibe el contexto con ámbito e intenta repartir el trabajo:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
builder.Services.AddDbContextPool<AppDb>(o => o.UseSqlServer(cs));

app.MapGet("/dashboard", async (AppDb db) =>
{
    // Both queries use the same pooled instance: this throws.
    var ordersTask = db.Orders.CountAsync();
    var customersTask = db.Customers.CountAsync();
    await Task.WhenAll(ordersTask, customersTask);
    return new { Orders = ordersTask.Result, Customers = customersTask.Result };
});
```

Con SQL Server o PostgreSQL, donde las llamadas asíncronas realmente ceden el control mientras esperan a la red, la segunda consulta empieza antes de que termine la primera y EF Core lanza:

```text
InvalidOperationException: A second operation was started on this context instance
before a previous operation completed. This is usually caused by different threads
concurrently using the same instance of DbContext.
```

Dos detalles de las pruebas. Primero, los métodos asíncronos de SQLite se completan de forma síncrona, así que la versión ingenua de arriba no se solapa en SQLite y "funciona", lo que hace que un conjunto de pruebas basado en SQLite sea un mal detector de este error. Tuve que envolver ambas consultas en `Task.Run` para que se solaparan. Segundo, si la carrera ocurre en el primer uso de un contexto recién creado, obtienes un mensaje distinto, "An attempt was made to use the context instance while it is being configured", porque ambos hilos intentan inicializar el contexto a la vez. Mismo error, misma solución.

## Reparto de trabajo con AddDbContextFactory

La versión con factoría da a cada rama su propia instancia:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
builder.Services.AddDbContextFactory<AppDb>(o => o.UseSqlServer(cs));

app.MapGet("/dashboard", async (IDbContextFactory<AppDb> factory, CancellationToken ct) =>
{
    async Task<int> CountOrders()
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        return await db.Orders.CountAsync(ct);
    }

    async Task<int> CountCustomers()
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        return await db.Customers.CountAsync(ct);
    }

    var orders = CountOrders();
    var customers = CountCustomers();
    await Task.WhenAll(orders, customers);
    return new { Orders = orders.Result, Customers = customers.Result };
});
```

Cada función local crea un contexto, ejecuta una consulta y lo libera. No se comparte nada, así que no hay nada sobre lo que competir. En mi arnés de pruebas, la misma forma con cuatro ramas (`Task.WhenAll` sobre cuatro llamadas a `CountAsync`, una por región) devolvió `250,250,250,250` en cada ejecución.

Fíjate en que `AddDbContextFactory` también registró `AppDb` con ámbito. El código existente que inyecta `AppDb` directamente sigue funcionando, así que puedes cambiar el registro sin tocar todos los constructores de la aplicación, y solo los endpoints que reparten trabajo necesitan recibir la factoría.

## AddPooledDbContextFactory: ambas cosas a la vez

`AddDbContextFactory` crea un contexto completamente nuevo en cada llamada a `CreateDbContext`. Ese costo normalmente es pequeño frente a un viaje de ida y vuelta a la base de datos, pero en un endpoint muy transitado que reparte cinco o diez consultas se acumula. `AddPooledDbContextFactory` mantiene la forma de factoría y alquila las instancias de un pool:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
builder.Services.AddPooledDbContextFactory<AppDb>(o => o.UseSqlServer(cs));
```

El código que llama es idéntico al de la sección anterior, porque sigues inyectando `IDbContextFactory<AppDb>`. La implementación detrás es `PooledDbContextFactory<AppDb>` en lugar de `DbContextFactory<AppDb>`, y `Dispose` devuelve la instancia al pool en lugar de descartarla. Lo comprobé directamente: crea un contexto, libéralo, crea otro, y `ReferenceEquals` devuelve `true` con la factoría con pool y `false` con la simple.

Esto es lo que se gana, medido con un bucle simple (200 000 iteraciones para crear/liberar, 20 000 para crear/consultar/liberar, con calentamiento, un solo hilo, `GC.GetAllocatedBytesForCurrentThread` para las asignaciones):

| Operación | `AddDbContextFactory` | `AddPooledDbContextFactory` |
| --- | --- | --- |
| `CreateDbContext` + tocar `Model` + `Dispose` | 17 250 ns, 44 888 B | 342 ns, 40 B |
| Crear + `FirstOrDefault` por clave (SQLite, sin seguimiento) + `Dispose` | 49.7 us, 62 461 B | 20.0 us, 11 710 B |

Estos números son contra un archivo SQLite local, así que la parte de la base de datos es casi gratis y la configuración del contexto domina. Contra un SQL Server real a través de una red, el tiempo de la consulta ahogará los 17 us, y por eso la documentación oficial describe el pooling como algo para "high-performance scenarios". La diferencia en asignaciones no se reduce con la latencia: 44 KB de basura por contexto, por diez ramas paralelas, por tu tasa de solicitudes, es presión real sobre el GC. La [documentación de rendimiento avanzado de EF Core](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics) reporta la misma proporción contra SQL Server: 50.38 KB asignados sin pooling frente a 4.63 KB con él.

La misma documentación también señala que resolver un contexto con pool mediante DI "incurs a slight overhead" en comparación con llamar directamente a la factoría con pool, así que la factoría es la más rápida de las dos opciones con pool incluso cuando no necesitas paralelismo.

## Puedes registrar ambas y compartir un solo pool

No tienes que elegir. Llamar a `AddDbContextPool<AppDb>` y luego a `AddPooledDbContextFactory<AppDb>` con las mismas opciones funciona, y comparten el mismo `IDbContextPool<AppDb>`. Lo verifiqué alquilando un contexto de la factoría, liberándolo y luego resolviendo `AppDb` desde un ámbito nuevo: era la misma instancia. Eso permite que la mayor parte de la aplicación inyecte `AppDb` como siempre mientras los pocos endpoints que reparten trabajo inyectan la factoría, sin pagar por dos pools.

Si usas EF Core 11, también existe una sobrecarga sin parámetros `AddPooledDbContextFactory<T>()` que lee la configuración del propio `OnConfiguring` del contexto, que describí en [el artículo de EF Core 11 Preview 3 sobre RemoveDbContext y la factoría con pool](/es/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/).

## El pool no limita el paralelismo, el pool de conexiones sí

El `poolSize` por defecto es 1024 tanto para `AddDbContextPool` como para `AddPooledDbContextFactory`. Ese número es el máximo de instancias que el pool conserva, no el máximo que puedes tener vivas. Cuando configuré `poolSize: 2` y alquilé cinco contextos a la vez, obtuve cinco instancias distintas. Después de liberar los cinco y alquilar cinco de nuevo, exactamente dos provinieron del primer lote. En otras palabras, el exceso recurre a crear contextos nuevos y los sobrantes simplemente se descartan al devolverlos. El pool nunca bloquea.

El verdadero límite para las consultas en paralelo es el pool de conexiones de ADO.NET que hay debajo. EF Core abre una conexión justo antes de cada consulta y la cierra justo después, y cada consulta concurrente necesita su propia conexión. `Microsoft.Data.SqlClient` usa por defecto `Max Pool Size=100`, y Npgsql también usa 100 por defecto. Si repartes 20 consultas por solicitud con 10 solicitudes concurrentes, ya estás esperando conexiones, lo cual se manifiesta como un timeout al obtener una conexión del pool y no como un error de EF. Si repartes el trabajo sobre una lista de IDs, limita el grado de paralelismo con `Parallel.ForEachAsync` en lugar de lanzar todo con `Task.WhenAll`; las ventajas y desventajas están en [Parallel.ForEach vs Parallel.ForEachAsync vs Task.WhenAll](/es/2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall/).

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
await Parallel.ForEachAsync(regionIds,
    new ParallelOptions { MaxDegreeOfParallelism = 4, CancellationToken = ct },
    async (regionId, token) =>
    {
        await using var db = await factory.CreateDbContextAsync(token);
        totals[regionId] = await db.Orders
            .Where(o => o.RegionId == regionId)
            .SumAsync(o => o.Total, token);
    });
```

Aquí `totals` debería ser un `ConcurrentDictionary<int, decimal>` o un arreglo con tamaño predefinido, ya que el cuerpo del bucle se ejecuta de forma concurrente.

## Trampas que solo afectan a las variantes con pool

### Las dependencias con ámbito del constructor se resuelven desde el proveedor raíz

Esto me sorprendió. Un contexto con pool se crea una vez y se reutiliza entre ámbitos, así que las dependencias de su constructor no pueden venir del ámbito de la solicitud. En EF Core 11 RC 1, un contexto con pool con un constructor como `TenantDb(DbContextOptions<TenantDb> options, Tenant tenant)`, donde `Tenant` tiene ámbito, se comporta así:

- Con la validación de ámbitos activada (el valor por defecto en el entorno `Development`), resolverlo lanza `InvalidOperationException: Cannot resolve scoped service 'Tenant' from root provider.`
- Con la validación de ámbitos desactivada (el valor por defecto en `Production`), tiene éxito en silencio. El contexto recibe una instancia de `Tenant` del proveedor raíz, que no coincide con el `Tenant` que resuelve el ámbito de la solicitud, y esa misma instancia capturada acompaña al contexto con pool en todas las solicitudes posteriores.

Así, el error que nunca ves en local se convierte en una fuga de datos entre inquilinos en producción. El `AddDbContextFactory` simple no tiene este problema porque construye un contexto nuevo cada vez. Si necesitas estado por solicitud con pooling, el patrón documentado es una factoría envoltorio con ámbito que alquila de la factoría con pool y asigna una propiedad:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
public sealed class TenantDbFactory(
    IDbContextFactory<TenantDb> pooled, ITenant tenant) : IDbContextFactory<TenantDb>
{
    public TenantDb CreateDbContext()
    {
        var db = pooled.CreateDbContext();
        db.TenantId = tenant.Id; // reset on every rent, never trust the previous value
        return db;
    }
}

builder.Services.AddPooledDbContextFactory<TenantDb>(o => o.UseSqlServer(cs));
builder.Services.AddScoped<TenantDbFactory>();
```

La misma trampa de un servicio con ámbito dentro de un singleton aparece también fuera de EF; [el artículo sobre "Cannot consume scoped service from singleton"](/es/2026/05/fix-cannot-consume-scoped-service-from-singleton/) explica por qué el contenedor lo rechaza.

### Tus propios campos no se restablecen

EF Core restablece su propio estado cuando un contexto con pool vuelve: el change tracker se limpia (agregué una entidad, liberé, alquilé de nuevo y `ChangeTracker.Entries()` estaba vacío). Los campos y propiedades que agregaste a tu subclase de `DbContext` no se tocan. Un `public string? Note` que asigné a `"dirty"` antes de liberar seguía siendo `"dirty"` en el siguiente alquiler. Todo lo que sea por solicitud debe asignarse en cada alquiler, como en el envoltorio de arriba. Lo mismo aplica a un `DbConnection` que abriste manualmente: ciérralo antes de que el contexto vuelva.

### OnConfiguring se ejecuta una vez

Como la instancia se reutiliza, `OnConfiguring` solo se ejecuta la primera vez que se crea una instancia del pool. No leas ahí el usuario, el inquilino ni la cultura actuales.

### Dispose es lo que devuelve la instancia

Con la factoría con pool, un contexto que olvidas liberar nunca se devuelve. No es una fuga en el sentido clásico, ya que el GC lo sigue recolectando, pero pierdes el beneficio del pooling y el pool se llena en silencio de instancias nuevas. Usa siempre `await using`.

## Cuándo elegir cada una

- **Solo consultas secuenciales, aplicación ordinaria**: `AddDbContext` o `AddDbContextPool`. Inyecta `AppDb`, espera cada consulta por turno. El pooling es una ganancia barata si tu contexto no tiene dependencias en el constructor ni estado por solicitud.
- **Algunos endpoints reparten el trabajo en paralelo**: registra `AddPooledDbContextFactory` (o `AddDbContextPool` más `AddPooledDbContextFactory` con las mismas opciones). Inyecta `AppDb` donde trabajes de forma secuencial e `IDbContextFactory<AppDb>` donde repartas el trabajo.
- **El contexto necesita servicios con ámbito en su constructor**: `AddDbContextFactory`, sin pool. O mueve ese estado a una propiedad asignada por un envoltorio con ámbito y conserva el pooling.
- **Singletons, servicios hospedados, componentes de Blazor Server**: la factoría, por las razones de [usar IDbContextFactory desde un singleton en Blazor](/es/2026/08/how-to-use-idbcontextfactory-from-a-singleton-service-in-blazor/). Con pool si el contexto lo permite.

Una última alternativa si ya usas `AddDbContextPool` y no quieres un segundo registro: crea un ámbito hijo por cada rama paralela con `IServiceScopeFactory.CreateAsyncScope()` y resuelve `AppDb` desde él. Cada ámbito alquila su propia instancia del pool, y mi prueba de cuatro ramas devolvió el mismo `250,250,250,250`. Funciona, pero es más ceremonia que inyectar la factoría, y además cada rama resuelve todo lo demás de ese ámbito.

La regla general: el paralelismo necesita un contexto por operación, y solo las dos factorías te lo dan directamente. El pooling es una decisión independiente sobre cuán barato es cada uno de esos contextos, y en EF Core 11 la factoría con pool hace que crear uno sea unas 50 veces más barato, siempre que tu contexto no lleve estado por solicitud en su constructor.

## Fuentes

- [Advanced Performance Topics: DbContext pooling (EF Core docs)](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics)
- [DbContext Lifetime, Configuration, and Initialization: using a DbContext factory](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/)
- [`EntityFrameworkServiceCollectionExtensions` API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.entityframeworkservicecollectionextensions)
- [Sample: AspNetContextPoolingWithState (dotnet/EntityFramework.Docs)](https://github.com/dotnet/EntityFramework.Docs/tree/main/samples/core/Performance/AspNetContextPoolingWithState)
- [SQL Server connection pooling (ADO.NET)](https://learn.microsoft.com/en-us/sql/connect/ado-net/sql-server-connection-pooling)
