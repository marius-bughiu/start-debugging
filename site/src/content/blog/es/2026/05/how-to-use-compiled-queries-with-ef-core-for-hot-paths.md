---
title: "Cómo usar consultas compiladas con EF Core en rutas calientes"
description: "Una guía práctica de las consultas compiladas en EF Core 11: cuándo EF.CompileAsyncQuery realmente gana, el patrón de campo estático, las trampas con Include y tracking, y cómo medir antes y después para demostrar que el ceremonial extra valió la pena."
pubDate: 2026-05-02
tags:
  - "ef-core"
  - "ef-core-11"
  - "csharp"
  - "dotnet-11"
  - "performance"
  - "how-to"
lang: "es"
translationOf: "2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths"
translatedBy: "claude"
translationDate: 2026-05-02
---

Respuesta corta: declara la consulta una vez como un campo `static readonly` mediante `EF.CompileAsyncQuery`, guarda el delegado resultante e invócalo con un `DbContext` nuevo más los parámetros en cada llamada. En un endpoint de lectura caliente que ejecuta la misma forma miles de veces por segundo, esto evita el paso de traducción de LINQ a SQL y recorta entre el 20 y el 40 % de la sobrecarga por llamada en EF Core 11. Fuera de las rutas calientes no compensa el código repetitivo, porque la caché de consultas de EF Core ya memoriza la traducción para consultas estructuralmente idénticas que se repiten.

Este artículo cubre la mecánica exacta de `EF.CompileQuery` y `EF.CompileAsyncQuery` en EF Core 11.0.x sobre .NET 11, el patrón de campo estático que hace real el ahorro, lo que las consultas compiladas no pueden hacer (sin encadenar `Include` en tiempo de ejecución, sin composición del lado del cliente, sin retornar un IQueryable) y un arnés de BenchmarkDotNet que puedes pegar en tu repo para verificar la ganancia con tu propio esquema. Todo lo de abajo usa `Microsoft.EntityFrameworkCore` 11.0.0 contra SQL Server, pero las mismas APIs funcionan idénticamente sobre PostgreSQL y SQLite.

## Qué significa realmente "consulta compilada" en EF Core 11

Cuando escribes `ctx.Orders.Where(o => o.CustomerId == id).ToListAsync()`, EF Core hace aproximadamente cinco cosas en cada llamada:

1. Parsear el árbol de expresiones LINQ.
2. Buscarlo en la caché interna de consultas (la clave de caché es la forma estructural del árbol más los tipos de los parámetros).
3. Si no está en caché, traducir el árbol a SQL y construir un delegado shaper.
4. Abrir una conexión, enviar el SQL con los parámetros enlazados.
5. Materializar las filas del resultado de vuelta en entidades.

El paso 2 es rápido, pero no es gratis. La búsqueda en la caché recorre el árbol de expresiones para calcular una clave hash. En una consulta pequeña eso son microsegundos. En un endpoint caliente que sirve 5 000 solicitudes por segundo, esos microsegundos se acumulan. `EF.CompileAsyncQuery` te permite saltarte por completo los pasos 1 al 3 en cada llamada después de la primera. Le pasas a EF el árbol de expresiones una sola vez al iniciar, este produce un delegado `Func` y, a partir de ahí, cada invocación va directo al paso 4. El coste por llamada baja a "construir un parámetro, ejecutar el shaper, devolver las filas".

La guía oficial está en [la documentación avanzada de rendimiento de EF Core](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics). El número destacado de los benchmarks del propio equipo es aproximadamente una reducción del 30 % en la sobrecarga por consulta, con la mayor parte de la ganancia en consultas pequeñas y ejecutadas con frecuencia, donde la traducción supone una fracción significativa del tiempo total.

## El patrón de campo estático

La forma más común de usar mal `EF.CompileAsyncQuery` es llamarlo desde dentro del método que ejecuta la consulta. Eso recrea el delegado en cada llamada, lo que es estrictamente peor que no compilar nada. El patrón que funciona es ponerlo en un campo estático:

```csharp
// .NET 11, C# 14, EF Core 11.0.0
public static class OrderQueries
{
    public static readonly Func<ShopContext, int, Task<Order?>> GetOrderById =
        EF.CompileAsyncQuery(
            (ShopContext ctx, int id) =>
                ctx.Orders
                    .AsNoTracking()
                    .FirstOrDefault(o => o.Id == id));

    public static readonly Func<ShopContext, int, IAsyncEnumerable<Order>> GetOrdersByCustomer =
        EF.CompileAsyncQuery(
            (ShopContext ctx, int customerId) =>
                ctx.Orders
                    .AsNoTracking()
                    .Where(o => o.CustomerId == customerId)
                    .OrderByDescending(o => o.PlacedAt));
}
```

Dos cosas a tener en cuenta. Primero, la lista de parámetros es posicional y los tipos quedan fijados: `int id` forma parte de la firma del delegado. No puedes pasarle más adelante un `Expression<Func<Order, bool>>` arbitrario, porque eso anularía todo el propósito. Segundo, el delegado se invoca con una instancia de `DbContext` por llamada:

```csharp
public sealed class OrderService(IDbContextFactory<ShopContext> factory)
{
    public async Task<Order?> Get(int id)
    {
        await using var ctx = await factory.CreateDbContextAsync();
        return await OrderQueries.GetOrderById(ctx, id);
    }
}
```

El patrón de fábrica importa aquí. Las consultas compiladas son seguras para hilos entre contextos, pero el `DbContext` en sí no lo es. Si compartes un contexto entre hilos y ejecutas consultas compiladas concurrentemente, obtendrás las mismas condiciones de carrera que con cualquier otro uso concurrente de EF Core. Usa [una fábrica de DbContext con pooling](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/#using-a-dbcontext-factory-eg-for-blazor) para la instancia por llamada. Si no lo haces, el coste de asignar y configurar un contexto nuevo por llamada se comerá lo que ahorraste compilando la consulta.

## Las dos variantes y cuándo gana cada una

EF Core 11 incluye dos métodos estáticos en `EF`:

- `EF.CompileQuery` devuelve un `Func<,...>` síncrono. El tipo del resultado es `T`, `IEnumerable<T>` o `IQueryable<T>` según la lambda.
- `EF.CompileAsyncQuery` devuelve `Task<T>` para operadores terminales de una sola fila (`First`, `FirstOrDefault`, `Single`, `Count`, `Any`, etc.) o `IAsyncEnumerable<T>` para consultas de streaming.

Para cargas de trabajo de servidor, la variante asíncrona es casi siempre lo que quieres. La variante síncrona bloquea el hilo que llama mientras dura el viaje de ida y vuelta a la base de datos, lo cual está bien en una aplicación de consola o en un cliente de escritorio, pero matará el thread pool en ASP.NET Core bajo carga. La única excepción es una migración de inicio o una herramienta CLI donde realmente quieras bloquear.

Un detalle sutil: `EF.CompileAsyncQuery` no acepta un parámetro `CancellationToken` directamente. El token lo captura la maquinaria asíncrona circundante. Si necesitas cancelar una consulta compilada de larga duración, sigue aplicando el patrón de [la guía de cancelación para tareas de larga duración](/es/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/): registra un `CancellationToken` en el ámbito de la solicitud y deja que el `DbCommand` lo respete a través de la conexión. Las consultas compiladas propagan el token por la misma ruta de `DbCommand.ExecuteReaderAsync` que una consulta no compilada.

## Una reproducción que muestra la ganancia

Construye el modelo más pequeño que puedas:

```csharp
// .NET 11, EF Core 11.0.0
public sealed class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
}

public sealed class Order
{
    public int Id { get; set; }
    public int CustomerId { get; set; }
    public decimal Total { get; set; }
    public DateTime PlacedAt { get; set; }
}

public sealed class ShopContext(DbContextOptions<ShopContext> options)
    : DbContext(options)
{
    public DbSet<Customer> Customers => Set<Customer>();
    public DbSet<Order> Orders => Set<Order>();
}
```

Ahora escribe dos implementaciones de la misma búsqueda, una compilada y otra no:

```csharp
// .NET 11, EF Core 11.0.0
public static class Bench
{
    public static readonly Func<ShopContext, int, Task<Order?>> Compiled =
        EF.CompileAsyncQuery(
            (ShopContext ctx, int id) =>
                ctx.Orders
                    .AsNoTracking()
                    .FirstOrDefault(o => o.Id == id));

    public static Task<Order?> NotCompiled(ShopContext ctx, int id) =>
        ctx.Orders
            .AsNoTracking()
            .FirstOrDefaultAsync(o => o.Id == id);
}
```

Mete las dos en BenchmarkDotNet 0.14 con un SQL Server respaldado por Testcontainers, el mismo arnés que usarías de [la guía de tests de integración con Testcontainers](/es/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/):

```csharp
// .NET 11, BenchmarkDotNet 0.14.0, Testcontainers 4.11
[MemoryDiagnoser]
public class CompiledQueryBench
{
    private IDbContextFactory<ShopContext> _factory = null!;

    [GlobalSetup]
    public async Task Setup()
    {
        // Initialise the container, run migrations, seed N rows.
        // Resolve the IDbContextFactory<ShopContext> from your service provider.
    }

    [Benchmark(Baseline = true)]
    public async Task<Order?> NotCompiled()
    {
        await using var ctx = await _factory.CreateDbContextAsync();
        return await Bench.NotCompiled(ctx, 42);
    }

    [Benchmark]
    public async Task<Order?> Compiled()
    {
        await using var ctx = await _factory.CreateDbContextAsync();
        return await Bench.Compiled(ctx, 42);
    }
}
```

En un portátil de 2024 contra un contenedor local de SQL Server 2025, la versión compilada queda alrededor de un 25 % más rápida en ejecuciones en caliente, con un perfil de asignaciones más pequeño porque el pipeline de traducción de LINQ no se ejecuta. El número exacto depende mucho del número de filas y de la forma de las columnas, pero en una búsqueda por clave primaria de una sola fila puedes esperar una ganancia significativa.

El resultado interesante es lo que pasa con una consulta que solo se ejecuta una vez: no hay ganancia. La versión compilada hace el mismo trabajo de traducción la primera vez que invocas el delegado. Si tu ruta caliente es "una forma distinta por llamada", las consultas compiladas no son la herramienta correcta. Premian la repetición.

## Lo que las consultas compiladas no pueden hacer

Las consultas compiladas son análisis estático sobre un árbol de expresiones fijo. Eso significa que varios patrones comunes de LINQ quedan fuera de los límites:

- **Sin `Include` condicional**. No puedes hacer `query.Include(o => o.Customer).If(includeLines, q => q.Include(o => o.Lines))` dentro de la lambda. La forma queda fija en tiempo de compilación.
- **Sin retorno de `IQueryable` para componer más adelante**. Si retornas `IAsyncEnumerable<Order>` puedes hacer `await foreach` sobre él, pero no puedes encadenar `.Where(...)` sobre el resultado y esperar que ese filtro se ejecute en el servidor. Se ejecuta del lado del cliente, lo cual anula la ganancia.
- **Sin captura de estado por closure**. La lambda pasada a `EF.CompileAsyncQuery` debe ser autocontenida. Capturar una variable local o un campo de servicio del ámbito que la rodea lanza en tiempo de ejecución: "An expression tree may not contain a closure-captured variable in a compiled query." La solución es añadir el valor como parámetro a la firma del delegado.
- **Sin `Skip` ni `Take` con valores tipados como `Expression`**. Deben ser parámetros `int` en el delegado. EF Core 8 añadió soporte para paginación dirigida por parámetros, EF Core 11 lo mantiene, pero no puedes pasarle un `Expression<Func<int>>`.
- **Sin métodos evaluables del lado del cliente**. Si tu `Where` llama a `MyHelper.Format(x)`, EF no puede traducirlo. En una consulta no compilada obtendrías un aviso en tiempo de ejecución. En una consulta compilada obtienes una excepción dura en tiempo de compilación, lo cual en realidad es un mejor modo de fallo.

Estas restricciones son la contrapartida que aceptas para conseguir la mejora de velocidad. Si tu consulta real necesita una forma con bifurcaciones, escribe una consulta LINQ normal y deja que la caché de consultas de EF Core haga su trabajo. La caché es buena. Solo que no es gratis.

## Tracking, AsNoTracking, y por qué importa aquí

Casi todos los ejemplos de este artículo usan `AsNoTracking()`. No es decorativo. Las consultas compiladas sobre entidades con tracking siguen pasando por el change tracker en la materialización, lo cual vuelve a añadir una parte de la sobrecarga que acabas de quitar. Para rutas calientes de solo lectura, `AsNoTracking` es el valor por defecto que quieres.

Si realmente necesitas tracking (el usuario va a mutar la entidad y a llamar a `SaveChangesAsync`), las cuentas cambian. El trabajo del change tracker domina el coste por llamada, y la rebanada que ganas con consultas compiladas es más pequeña. En ese caso la ganancia es más bien del 5 al 10 %, lo cual rara vez compensa el código repetitivo.

Hay un corolario en la [guía de detección de N+1](/es/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/): si compilas una consulta que usa `Include` para una navegación, la explosión cartesiana queda horneada en el SQL compilado. No puedes aplicar `AsSplitQuery` de forma oportunista más tarde. Decide una vez y elige la forma que encaje con el sitio de la llamada.

## Calentamiento y la primera invocación

El trabajo de compilación se difiere hasta la primera llamada al delegado, no hasta la asignación al campo estático. Si tu servicio tiene un objetivo estricto de latencia P99 en arranques en frío, la primera solicitud que toque una ruta de código con consulta compilada pagará el coste de traducción además de la sobrecarga normal de la primera solicitud.

La solución más limpia es calentar tanto el modelo de EF Core como las consultas compiladas durante el arranque de la aplicación, la misma idea que cubre [la guía de calentamiento de EF Core](/es/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/):

```csharp
// .NET 11, ASP.NET Core 11
var app = builder.Build();

await using (var scope = app.Services.CreateAsyncScope())
{
    var factory = scope.ServiceProvider
        .GetRequiredService<IDbContextFactory<ShopContext>>();
    await using var ctx = await factory.CreateDbContextAsync();

    // Touch the model
    _ = ctx.Model;

    // Trigger compilation by invoking each hot-path delegate once
    _ = await OrderQueries.GetOrderById(ctx, 0);
}

await app.RunAsync();
```

La consulta contra `Id == 0` retorna `null`, pero fuerza la traducción. Después de este bloque, tu primera solicitud real golpea la base de datos con el SQL ya cacheado en el delegado.

## Cuándo saltarse las consultas compiladas por completo

Existe la tentación de compilar todas las consultas del código base. Resístela. La propia guía del equipo de EF Core dice que uses las consultas compiladas "con moderación, solo en situaciones donde realmente se necesiten microoptimizaciones". Las razones:

- La caché interna de consultas ya memoriza traducciones para consultas estructuralmente idénticas que se repiten. Para la mayoría de las cargas, la tasa de aciertos en caché tras el calentamiento supera el 99 %.
- Las consultas compiladas añaden una segunda fuente de verdad para la forma de la consulta (el campo estático más el sitio de llamada), lo que hace más doloroso el refactor.
- Las trazas de pila se vuelven menos útiles: una excepción en una consulta compilada apunta al sitio donde se invoca el delegado, no a la expresión LINQ original.

La regla honesta de decisión es: perfila primero. Ejecuta el endpoint con carga realista usando [`dotnet-trace`](/es/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) y mira cuánto del tiempo está en la infraestructura de consultas de EF Core. Si está en un solo dígito como porcentaje del tiempo total de la solicitud, déjalo en paz. Si ves un 20 % o más en `RelationalQueryCompiler`, `QueryTranslationPostprocessor` o `QueryCompilationContext`, eso es un candidato para consulta compilada.

## Dos patrones que componen bien

La consulta compilada es más útil en bucles ajustados o procesadores en segundo plano que martillean la misma forma:

```csharp
// .NET 11, EF Core 11.0.0 - a streaming export
public static readonly Func<ShopContext, DateTime, IAsyncEnumerable<Order>> OrdersSince =
    EF.CompileAsyncQuery(
        (ShopContext ctx, DateTime since) =>
            ctx.Orders
                .AsNoTracking()
                .Where(o => o.PlacedAt >= since)
                .OrderBy(o => o.PlacedAt));

await foreach (var order in OrdersSince(ctx, cutoff).WithCancellation(ct))
{
    await writer.WriteRowAsync(order, ct);
}
```

Empareja esto con [`IAsyncEnumerable<T>` en EF Core 11](/es/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) y obtienes una exportación en streaming que no almacena en buffer el conjunto de resultados, no asigna una lista y reutiliza el SQL compilado en cada lote. Para un trabajo de exportación que se ejecuta cada noche sobre millones de filas, esa combinación reduce de forma medible tanto la latencia como la presión sobre la memoria.

El otro patrón es el endpoint de búsqueda de alta cardinalidad: un fetch por clave primaria de una sola fila en una API pública donde la tasa de solicitudes está en los miles por segundo. Ahí el ahorro por llamada se multiplica por el volumen de llamadas, y una consulta compilada sobre un `FirstOrDefault` emparejada con [response caching](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/response) te da lo más cercano a una lectura "gratis" que tiene EF Core.

Para todo lo demás, escribe la consulta en LINQ plano, apóyate en la caché de consultas y vuelve a revisarlo solo cuando el profiler te diga que el paso de traducción es el cuello de botella. Las consultas compiladas son un bisturí, no un mazo.
