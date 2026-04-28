---
title: "Cómo precalentar el modelo de EF Core antes de la primera consulta"
description: "EF Core construye su modelo conceptual de forma diferida en el primer acceso al DbContext, por lo que la primera consulta en un proceso recién iniciado es varios cientos de milisegundos más lenta que cualquier consulta posterior. Esta guía cubre las tres soluciones reales en EF Core 11: un IHostedService de arranque que toca Model y abre una conexión, dotnet ef dbcontext optimize para enviar un modelo precompilado, y las trampas de la clave de caché que reconstruyen el modelo silenciosamente."
pubDate: 2026-04-27
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "dotnet-11"
  - "performance"
  - "startup"
  - "csharp"
lang: "es"
translationOf: "2026/04/how-to-warm-up-ef-core-model-before-the-first-query"
translatedBy: "claude"
translationDate: 2026-04-29
---

La primera consulta a través de un `DbContext` recién creado es la más lenta que tu aplicación va a ejecutar, y no tiene nada que ver con la base de datos. EF Core no construye su modelo interno cuando arranca el host. Espera hasta la primera vez que algo lee `DbContext.Model`, ejecuta una consulta, llama a `SaveChanges` o incluso solo enumera un `DbSet`. En ese punto ejecuta toda la pipeline de convenciones contra tus tipos de entidad, lo cual en un modelo de 50 entidades con relaciones, índices y convertidores de valor puede tardar de 200 a 500 ms. Los contextos posteriores en el mismo proceso obtienen el modelo cacheado en menos de 1 ms. Esta guía muestra las tres soluciones que realmente mueven el número en EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0.0, .NET 11, C# 14): un precalentamiento explícito al arranque, un modelo precompilado producido por `dotnet ef dbcontext optimize`, y las trampas de la clave de caché del modelo que silenciosamente derrotan a las dos anteriores.

## Por qué la primera consulta es lenta aun con la base de datos caliente

`DbContext.Model` es una instancia de `IModel` construida por la pipeline de convenciones. Las convenciones son docenas de implementaciones de `IConvention` (descubrimiento de relaciones, inferencia de claves, detección de owned types, nombrado de claves foráneas, selección de convertidores de valor, mapeo de columnas JSON, etcétera) que recorren cada propiedad de cada tipo de entidad y cada navegación. La salida es un grafo de modelo inmutable que EF Core mantiene por la duración del proceso bajo una clave producida por `IModelCacheKeyFactory`.

En un registro por defecto `AddDbContext<TContext>`, ese trabajo ocurre de forma diferida. La secuencia de runtime en arranque en frío se ve así:

1. El host arranca. Se construye `IServiceProvider`. `TContext` queda registrado como scoped. Aún no se ha ejecutado nada relacionado con el modelo.
2. Llega la primera petición HTTP. El contenedor DI resuelve un `TContext`. Su constructor guarda `DbContextOptions<TContext>` y retorna. Sigue sin ejecutarse nada relacionado con el modelo.
3. Tu handler escribe `await db.Blogs.ToListAsync()`. EF Core dereferencia `Set<Blog>()`, lo que lee `Model`, lo que dispara la pipeline de convenciones. Esto es los 200 a 500 ms.
4. La consulta luego se compila (traducción de LINQ a SQL, vinculación de parámetros, caché de ejecutor), lo que añade otros 30 a 80 ms.
5. La consulta finalmente toca la base de datos.

Los pasos 3 y 4 solo ocurren una vez por proceso por tipo de `DbContext`. La quinta petición a través del mismo tipo de contexto ve ambos costos como cero. Por eso "primera petición lenta, todas las siguientes rápidas" se reproduce tan limpiamente y por eso no puedes sacudírtelo de encima con tuneo de base de datos. El trabajo está en tu proceso, no en el cable.

Si pones un cronómetro alrededor de dos consultas seguidas en un proceso recién iniciado, verás la asimetría directamente:

```csharp
// .NET 11, EF Core 11.0.0, C# 14
var sw = Stopwatch.StartNew();
await using (var db = new BloggingContext(options))
{
    _ = await db.Blogs.AsNoTracking().FirstOrDefaultAsync(b => b.Id == 1);
}
Console.WriteLine($"first:  {sw.ElapsedMilliseconds} ms");

sw.Restart();
await using (var db = new BloggingContext(options))
{
    _ = await db.Blogs.AsNoTracking().FirstOrDefaultAsync(b => b.Id == 1);
}
Console.WriteLine($"second: {sw.ElapsedMilliseconds} ms");
```

En un modelo demo de 30 entidades apuntando a SQL Server 2025 con EF Core 11.0.0 sobre un portátil caliente, la primera iteración imprime alrededor de `380 ms` y la segunda alrededor de `4 ms`. La construcción del modelo domina. Si el mismo código se ejecuta contra un AWS Lambda en frío donde el host se levanta por invocación, esos 380 ms aterrizan directamente en la latencia p99 visible al usuario, que es exactamente la clase de problema cubierta en [reducir el tiempo de arranque en frío de un AWS Lambda con .NET 11](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/).

## Solución uno: precalentar el modelo al arranque con IHostedService

La solución más barata mueve el costo de "primera petición" a "arranque del host" sin tocar ningún camino de código de producción. Registra un `IHostedService` cuyo único trabajo sea resolver un contexto, forzar la materialización del modelo y salir. El host bloquea en `StartAsync` antes de abrir el socket de escucha, así que cuando Kestrel acepta una petición, la pipeline de convenciones ya ha corrido y la `IModel` cacheada está en la instancia de opciones.

```csharp
// .NET 11, EF Core 11.0.0, C# 14
public sealed class EfCoreWarmup(IServiceProvider sp, ILogger<EfCoreWarmup> log) : IHostedService
{
    public async Task StartAsync(CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        await using var scope = sp.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<BloggingContext>();

        // Forces the conventions pipeline to run and the IModel to be cached.
        _ = db.Model;

        // Forces the relational connection-string parsing and the SqlClient pool
        // to allocate one physical connection. ADO.NET keeps it warm in the pool.
        await db.Database.OpenConnectionAsync(ct);
        await db.Database.CloseConnectionAsync();

        log.LogInformation("EF Core warm-up done in {Elapsed} ms", sw.ElapsedMilliseconds);
    }

    public Task StopAsync(CancellationToken ct) => Task.CompletedTask;
}
```

Conéctalo después de `AddDbContext`:

```csharp
// Program.cs, .NET 11, ASP.NET Core 11
builder.Services.AddDbContext<BloggingContext>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("Db")));
builder.Services.AddHostedService<EfCoreWarmup>();
```

Tres cosas que esto hace bien y que los precalentamientos hechos a mano suelen errar:

1. Pone el contexto en scope. `AddDbContext` registra `TContext` como scoped, así que resolverlo desde el provider raíz lanza una excepción. `CreateAsyncScope` es el patrón documentado.
2. Lee `db.Model`, no `db.Set<Blog>().FirstOrDefault()`. Leer `Model` dispara la pipeline de convenciones sin compilar ninguna consulta LINQ, lo que mantiene el precalentamiento libre de viajes de ida y vuelta a la base de datos que podrían fallar porque el esquema aún no está listo (piensa en el orden `WaitFor` de Aspire, o migraciones que se ejecutan después de levantar el host).
3. Abre y cierra una conexión para que el pool de SqlClient se cebe. El pool mantiene conexiones físicas inactivas durante una ventana corta, así que la primera petición real no paga la configuración de TCP y TLS encima de la construcción del modelo.

Un registro de contexto en pool (`AddDbContextPool<TContext>`) necesita el mismo precalentamiento, solo que resuelto desde el pool. Cualquier patrón funciona, pero si además tienes que mutar el registro para cambiar modelos en pruebas, consulta [el swap de RemoveDbContext y pooled factory en EF Core 11 para tests](/es/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/) para la forma soportada de hacerlo sin reconstruir todo el service provider.

Esta solución basta para la mayoría de apps ASP.NET Core. El modelo todavía se construye en runtime, solo has escondido el costo en la ventana de arranque del host, que normalmente es gratis o casi gratis. La solución que realmente elimina el costo está más abajo.

## Solución dos: enviar un modelo precompilado con dotnet ef dbcontext optimize

EF Core 6 introdujo la característica de modelos compilados, EF Core 7 la hizo estable, y EF Core 11 arregló suficientes limitaciones restantes para que sea el valor por defecto correcto en cualquier servicio que se preocupe por el arranque en frío. La idea: en lugar de ejecutar la pipeline de convenciones en runtime, ejecutarla en tiempo de compilación y emitir una `IModel` escrita a mano como C# generado. En runtime el contexto carga directamente el modelo precompilado y se salta las convenciones por completo.

El comando CLI es de un disparo:

```bash
# .NET 11 SDK, dotnet-ef 11.0.0
dotnet ef dbcontext optimize \
  --output-dir GeneratedModel \
  --namespace MyApp.Data.GeneratedModel \
  --context BloggingContext
```

Eso escribe una carpeta de archivos como `BloggingContextModel.cs`, `BlogEntityType.cs`, `PostEntityType.cs`. Añade la carpeta al control de versiones, apunta `UseModel` al singleton generado, y la construcción del modelo en runtime desaparece:

```csharp
// .NET 11, EF Core 11.0.0
builder.Services.AddDbContext<BloggingContext>(o => o
    .UseSqlServer(builder.Configuration.GetConnectionString("Db"))
    .UseModel(MyApp.Data.GeneratedModel.BloggingContextModel.Instance));
```

En el mismo modelo demo de 30 entidades, la primera consulta cae de 380 ms a aproximadamente 18 ms tras este cambio. El costo restante es la traducción de LINQ a SQL para la forma específica de la consulta, que es por forma de consulta y que la segunda invocación de la misma consulta ya cachea. Si la consulta es la misma que ejecutas en cada petición, la caché de consultas de EF se come el costo en la iteración dos y la primera petición es efectivamente tan rápida como el estado estable.

Tres detalles que muerden la primera vez que haces esto:

1. **Regenera cuando cambia el modelo.** El modelo optimizado es una instantánea. Añadir una propiedad, un índice o una regla de `OnModelCreating` y enviar sin re-ejecutar `dotnet ef dbcontext optimize` produce una incongruencia en runtime que EF Core detecta y lanza. Conecta el comando al build (`<Target Name="OptimizeEfModel" BeforeTargets="BeforeBuild">`) o al mismo paso que ejecuta migraciones, para que no pueda desincronizarse.
2. **El flag `--precompile-queries` existe en preview de EF Core 11.** Extiende la optimización a la capa de LINQ a SQL para consultas conocidas. A día de hoy con `Microsoft.EntityFrameworkCore.Tools` 11.0.0 está documentado como preview y emite atributos que puedes leer en la [documentación oficial de consultas precompiladas](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics#compiled-queries). Úsalo para apps atadas a AOT donde la reflexión está restringida, o para caminos calientes donde los marginales 30 a 80 ms aún importan.
3. **Un modelo precompilado es obligatorio para Native AOT.** `OnModelCreating` ejecuta caminos de reflexión que el trimmer de AOT no puede analizar estáticamente, así que sin un modelo precompilado la app publicada se cae la primera vez que toca `DbContext`. Si también estás mirando AOT para el resto del host, las mismas restricciones de [usar Native AOT con APIs mínimas de ASP.NET Core](/es/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) se aplican a EF Core.

Para un servicio que ya ejecuta `dotnet ef migrations` en CI, añadir `dotnet ef dbcontext optimize` al mismo paso son dos líneas de YAML y se paga en cada arranque en frío para siempre.

## La trampa de la clave de caché del modelo que derrota ambas soluciones

Hay una categoría de bug donde el precalentamiento corre limpio, el modelo precompilado carga limpio, y la primera consulta visible al usuario *sigue* siendo lenta. La causa casi siempre es `IModelCacheKeyFactory`. EF Core cachea el `IModel` materializado en un diccionario estático con clave en un objeto que devuelve el factory. El factory por defecto devuelve una clave que es solo el tipo del contexto. Si tu `OnModelCreating` consulta estado en runtime (un id de tenant, una cultura, una feature flag), el modelo tiene que cachearse por separado por valor de ese estado, y tienes que decírselo a EF Core reemplazando el factory.

```csharp
// .NET 11, EF Core 11.0.0
public sealed class TenantBloggingContext(
    DbContextOptions<TenantBloggingContext> options,
    ITenantProvider tenant) : DbContext(options)
{
    public string Tenant { get; } = tenant.CurrentTenant;

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<Blog>().ToTable($"Blogs_{Tenant}");
    }
}

public sealed class TenantModelCacheKeyFactory : IModelCacheKeyFactory
{
    public object Create(DbContext context, bool designTime) =>
        context is TenantBloggingContext t ? (context.GetType(), t.Tenant, designTime) : context.GetType();
}
```

Registra el reemplazo en las opciones:

```csharp
builder.Services.AddDbContext<TenantBloggingContext>(o => o
    .UseSqlServer(connStr)
    .ReplaceService<IModelCacheKeyFactory, TenantModelCacheKeyFactory>());
```

Dos cosas salen mal aquí sin la solución de precalentamiento:

- La primera petición para el tenant `acme` reconstruye el modelo en la clave de caché `(TenantBloggingContext, "acme", false)`. La primera petición para el tenant `globex` lo reconstruye otra vez en `(TenantBloggingContext, "globex", false)`. Cada clave de caché distinta toca la pipeline de convenciones una vez. Un precalentamiento ingenuo que solo resuelve un tenant solo precalienta una de N cachés.
- Un factory de clave de caché que cierra sobre más estado del necesario (por ejemplo, la instantánea entera de `IConfiguration`) fragmenta la caché. Si descubres que el modelo se reconstruye en cada petición, registra el valor de retorno de `IModelCacheKeyFactory.Create` y comprueba si es inestable.

La solución de precalentamiento del principio sigue aplicando, solo tienes que iterarla por las dimensiones de la clave de caché que te importan: en el hosted service, resuelve un contexto por cada tenant conocido antes de declarar el arranque hecho. Si el conjunto de tenants no está acotado (subdominios por cliente en un SaaS multi-tenant) la solución del modelo precompilado tampoco te salva, porque `dotnet ef dbcontext optimize` produce una instantánea, no una familia por tenant. En ese caso, acepta el costo del primer hit por tenant y en su lugar pónle un tope con `UseQuerySplittingBehavior` más estricto y las pequeñas mejoras relacionales de consulta cubiertas en [cómo EF Core 11 elimina los joins de referencia en split queries](/es/2026/04/efcore-11-preview-3-prunes-reference-joins-split-queries/).

## Un orden de operaciones pragmático

Si viniste por "qué debería hacer y en qué orden", esta es la secuencia que ejecuto en un servicio real:

1. Mide. Cronometra las primeras tres consultas en un proceso recién iniciado. Si la primera es menor a 50 ms, no hagas nada.
2. Añade el `IHostedService` `EfCoreWarmup`. Son 30 líneas de código y convierte un visible al usuario de 300 ms en un 300 ms al arranque del host.
3. Si el tiempo de arranque mismo importa (Lambda, Cloud Run, autoscaler), ejecuta `dotnet ef dbcontext optimize` y `UseModel(...)`. Añade el comando a CI.
4. Si tienes un `IModelCacheKeyFactory` personalizado, audita lo que captura. Asegúrate de que el conjunto de claves sea enumerable y precalienta cada entrada. Si no está acotado, acepta el costo por clave y deja de pelear con eso.
5. Si la segunda consulta también es lenta, el costo está en la traducción LINQ, no en la construcción del modelo. Investiga `DbContextOptionsBuilder.EnableSensitiveDataLogging` más `LogTo` filtrado a `RelationalEventId.QueryExecuting`, o precompila la consulta.

Esta es la misma forma que precalentar cualquier caché: averigua dónde vive el costo, muévelo antes y verifica el movimiento con un cronómetro.

## Relacionado

- [Cómo simular DbContext sin romper el seguimiento de cambios](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/)
- [Cómo usar IAsyncEnumerable con EF Core 11](/es/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/)
- [Cómo reducir el tiempo de arranque en frío de un AWS Lambda con .NET 11](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/)
- [EF Core 11: RemoveDbContext y el swap de pooled factory en pruebas](/es/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/)
- [EF Core 11 preview 3 elimina joins de referencia en split queries](/es/2026/04/efcore-11-preview-3-prunes-reference-joins-split-queries/)

## Fuentes

- [Modelos compilados de EF Core](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics#compiled-models) - Microsoft Learn
- [Temas avanzados de rendimiento de EF Core: consultas compiladas](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics#compiled-queries) - Microsoft Learn
- [Referencia de `dotnet ef dbcontext optimize`](https://learn.microsoft.com/en-us/ef/core/cli/dotnet#dotnet-ef-dbcontext-optimize) - Microsoft Learn
- [Referencia de la API `IModelCacheKeyFactory`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.infrastructure.imodelcachekeyfactory) - Microsoft Learn
- [Estrategias de pruebas con EF Core](https://learn.microsoft.com/en-us/ef/core/testing/choosing-a-testing-strategy) - Microsoft Learn
