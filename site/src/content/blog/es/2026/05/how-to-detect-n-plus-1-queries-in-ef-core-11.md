---
title: "Cómo detectar consultas N+1 en EF Core 11"
description: "Una guía práctica para identificar consultas N+1 en EF Core 11: cómo aparece el patrón en código real, cómo exponerlo mediante registros, interceptores de diagnóstico, OpenTelemetry y una prueba que rompe la compilación cuando una ruta crítica regresa."
pubDate: 2026-05-02
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "csharp"
  - "dotnet-11"
  - "performance"
  - "how-to"
lang: "es"
translationOf: "2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-05-02
---

Respuesta corta: active `LogTo` de EF Core 11 con la categoría `Microsoft.EntityFrameworkCore.Database.Command` en nivel `Information`, y luego ejecute el endpoint sospechoso una sola vez. Si ve el mismo `SELECT` con un valor de parámetro distinto disparándose 50 veces seguidas en lugar de un único `JOIN`, tiene un N+1. La solución duradera no consiste solo en agregar `Include`, sino en cablear un `DbCommandInterceptor` que cuente los comandos por solicitud y una prueba unitaria que afirme un límite superior de comandos por operación lógica, para que la regresión no pueda volver de forma silenciosa.

Este post cubre cómo el N+1 sigue apareciendo en EF Core 11 (carga diferida, acceso a navegación oculto en proyecciones y consultas divididas mal aplicadas), tres capas de detección (registros, interceptores y OpenTelemetry) y cómo bloquearlo en CI con una prueba que falla cuando un endpoint excede su presupuesto de consultas. Todos los ejemplos están en .NET 11, EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0.x) y SQL Server, pero todo excepto los nombres de eventos específicos del proveedor se aplica de forma idéntica a PostgreSQL y SQLite.

## Cómo se ve realmente un N+1 en EF Core 11

La definición de manual es "una consulta para cargar N filas padre, luego una consulta extra por cada padre para cargar una colección o referencia relacionada, para un total de N+1 viajes de ida y vuelta." En una base de código real con EF Core 11, el detonante rara vez es un `foreach` explícito sobre `Include`. Las cuatro formas que veo con más frecuencia son:

1. **La carga diferida sigue activa**: alguien añadió `UseLazyLoadingProxies()` hace años, la base de código creció, y una página Razor ahora itera 200 pedidos y accede a `order.Customer.Name`. Cada acceso dispara una consulta independiente.
2. **Una proyección que llama a un método**: `Select(o => new OrderDto(o.Id, FormatCustomer(o.Customer)))` donde `FormatCustomer` no se puede traducir a SQL, así que EF Core cae en evaluación del lado del cliente y vuelve a consultar `Customer` por cada fila.
3. **`AsSplitQuery` sobre la forma incorrecta**: un `.Include(o => o.Lines).Include(o => o.Customer).AsSplitQuery()` divide correctamente un único join padre en múltiples viajes de ida y vuelta, pero si añade `.AsSplitQuery()` dentro de un `foreach` que ya itera padres, multiplica los viajes.
4. **`IAsyncEnumerable` mezclado con acceso a navegación**: transmitir un `IAsyncEnumerable<Order>` con [IAsyncEnumerable en EF Core 11](/es/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) y luego acceder a `order.Customer.Email` en el consumidor. Cada paso de enumeración abre un nuevo viaje de ida y vuelta si la navegación aún no está cargada.

La razón por la que las cuatro son difíciles de detectar es que la API de `DbContext` nunca lanza ni advierte por defecto. El plan de consulta está bien. La única señal es la conversación en el cable, que es invisible hasta que mira.

## Una reproducción concreta

Levante un modelo diminuto y ejercítelo:

```csharp
// .NET 11, EF Core 11.0.0, C# 14
public sealed class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
}

public sealed class Order
{
    public int Id { get; set; }
    public int CustomerId { get; set; }
    public Customer Customer { get; set; } = null!;
    public decimal Total { get; set; }
}

public sealed class ShopContext(DbContextOptions<ShopContext> options)
    : DbContext(options)
{
    public DbSet<Customer> Customers => Set<Customer>();
    public DbSet<Order> Orders => Set<Order>();
}
```

Ahora escriba el peor bucle posible:

```csharp
// Triggers N+1 if Customer is not eagerly loaded
var orders = await ctx.Orders.ToListAsync();
foreach (var order in orders)
{
    Console.WriteLine($"{order.Id}: {order.Customer?.Name}");
}
```

Sin carga diferida, `order.Customer` es `null` y solo ve un `SELECT` de `Orders`. Eso es un error distinto, pérdida silenciosa de datos, pero no es N+1. Active la carga diferida y el mismo código se convierte en el antipatrón clásico:

```csharp
options.UseLazyLoadingProxies();
```

Ahora obtiene un `SELECT` de `Orders` y luego un `SELECT * FROM Customers WHERE Id = @p0` por cada pedido. Con 1000 pedidos son 1001 viajes de ida y vuelta. Lo primero que necesita es una manera de verlos.

## Capa 1: registros estructurados con LogTo y la categoría correcta

La señal de detección más rápida es el registrador de comandos integrado de EF Core. EF Core 11 expone `LogTo` en `DbContextOptionsBuilder` y enruta los eventos a través de `Microsoft.EntityFrameworkCore.Database.Command.CommandExecuting`:

```csharp
services.AddDbContext<ShopContext>(options =>
{
    options.UseSqlServer(connectionString);
    options.LogTo(
        Console.WriteLine,
        new[] { RelationalEventId.CommandExecuting },
        LogLevel.Information);
});
```

Ejecute el bucle una vez y la consola se llena con copias de la misma instrucción parametrizada. Si está mirando una aplicación real, envíelo a su registro mediante `ILoggerFactory` en su lugar:

```csharp
var loggerFactory = LoggerFactory.Create(b => b.AddConsole());
options.UseLoggerFactory(loggerFactory);
options.EnableSensitiveDataLogging(); // only in dev
```

El conmutador `EnableSensitiveDataLogging` es lo que hace visibles los valores de los parámetros. Sin él, ve el SQL pero no los valores, lo que dificulta mucho detectar "100 de estos son idénticos excepto por `@p0`". Manténgalo desactivado en producción: registra los parámetros de la consulta, que pueden incluir PII o secretos. La guía oficial sobre esto está en [los documentos de logging de EF Core](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/).

Una vez que pueda ver la manguera, la regla de detección manual es simple: para cualquier acción lógica única del usuario, el número de instrucciones SQL distintas debe estar acotado por una constante pequeña. Un endpoint de listado no debería escalar su cantidad de consultas con la cantidad de filas. Si lo hace, encontró uno.

## Capa 2: un DbCommandInterceptor que cuenta consultas por ámbito

El flujo de "registrar y buscar con grep" está bien para un solo desarrollador y es terrible para un equipo. La siguiente capa es un interceptor que mantiene un contador por solicitud y le permite afirmar sobre él. EF Core 11 incluye [`DbCommandInterceptor`](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/interceptors), que se invoca para cada comando ejecutado:

```csharp
// .NET 11, EF Core 11.0.0
public sealed class CommandCounter
{
    private int _count;
    public int Count => _count;
    public void Increment() => Interlocked.Increment(ref _count);
    public void Reset() => Interlocked.Exchange(ref _count, 0);
}

public sealed class CountingInterceptor(CommandCounter counter) : DbCommandInterceptor
{
    public override InterceptionResult<DbDataReader> ReaderExecuting(
        DbCommand command,
        CommandEventData eventData,
        InterceptionResult<DbDataReader> result)
    {
        counter.Increment();
        return base.ReaderExecuting(command, eventData, result);
    }

    public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
        DbCommand command,
        CommandEventData eventData,
        InterceptionResult<DbDataReader> result,
        CancellationToken cancellationToken = default)
    {
        counter.Increment();
        return base.ReaderExecutingAsync(command, eventData, result, cancellationToken);
    }
}
```

Cablee el interceptor con ámbito por solicitud:

```csharp
services.AddScoped<CommandCounter>();
services.AddScoped<CountingInterceptor>();
services.AddDbContext<ShopContext>((sp, options) =>
{
    options.UseSqlServer(connectionString);
    options.AddInterceptors(sp.GetRequiredService<CountingInterceptor>());
});
```

Ahora cualquier ruta de código puede preguntar "¿cuántos comandos SQL acabo de enviar?" en O(1). En ASP.NET Core 11 envuelva eso alrededor de la solicitud:

```csharp
app.Use(async (ctx, next) =>
{
    var counter = ctx.RequestServices.GetRequiredService<CommandCounter>();
    await next();
    if (counter.Count > 50)
    {
        var logger = ctx.RequestServices.GetRequiredService<ILogger<Program>>();
        logger.LogWarning(
            "{Path} executed {Count} SQL commands",
            ctx.Request.Path,
            counter.Count);
    }
});
```

Una advertencia ruidosa de "más de 50 comandos por solicitud" es suficiente para sacar a la luz a cada infractor durante una prueba de carga o una ejecución espejo en producción. También es la base de la puerta de CI más adelante.

La razón por la que esto funciona mejor que los registros en producción es el volumen. El registrador de comandos en nivel `Information` ahogará una aplicación real. Un contador es un solo entero por solicitud y una sola línea de registro condicional sobre los infractores.

## Capa 3: OpenTelemetry, donde los datos ya viven

Si ya sigue la configuración de [la guía de OpenTelemetry para .NET 11](/es/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/), no necesita un contador separado en absoluto. El paquete [`OpenTelemetry.Instrumentation.EntityFrameworkCore`](https://www.nuget.org/packages/OpenTelemetry.Instrumentation.EntityFrameworkCore) emite un span por cada comando ejecutado con el SQL como `db.statement`:

```csharp
services.AddOpenTelemetry()
    .WithTracing(t => t
        .AddAspNetCoreInstrumentation()
        .AddEntityFrameworkCoreInstrumentation(o =>
        {
            o.SetDbStatementForText = true;
        })
        .AddOtlpExporter());
```

En cualquier backend que agrupa los spans hijos bajo su HTTP padre (panel de Aspire, Jaeger, Honeycomb, Grafana Tempo), un endpoint con N+1 aparece como un gráfico de llamas con una única raíz HTTP y una pila de spans SQL de forma idéntica. La señal visual es inconfundible: un bloque cuadrado de spans hijos repetidos es N+1, siempre. Una vez que tiene esto, en realidad no necesita la capa de registro para el triaje cotidiano.

Tenga cuidado con `SetDbStatementForText = true` en producción: envía el SQL renderizado a su recolector, que podría incluir valores identificables de las cláusulas `WHERE`. La mayoría de los equipos lo dejan activo en no producción y lo desactivan (o lo limpian) en producción.

## Capa 4: una prueba que rompe la compilación

La detección en desarrollo y en producción es necesaria, pero lo único que evita una regresión lenta de vuelta a N+1 es una prueba. El patrón usa el mismo interceptor contador y una [prueba de integración basada en Testcontainers](/es/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) que golpea una base de datos real:

```csharp
// .NET 11, xUnit 2.9, EF Core 11.0.0, Testcontainers 4.11
[Fact]
public async Task Get_orders_endpoint_executes_at_most_two_commands()
{
    await using var factory = new ShopFactory(); // WebApplicationFactory<Program>
    var counter = factory.Services.GetRequiredService<CommandCounter>();
    counter.Reset();

    var client = factory.CreateClient();
    var response = await client.GetAsync("/orders?take=100");

    response.EnsureSuccessStatusCode();
    Assert.InRange(counter.Count, 1, 2);
}
```

El presupuesto de "1 a 2" refleja la forma realista: un `SELECT` para `Orders`, opcionalmente uno para `Customers` si lo incluye con `Include`. Si un cambio futuro convierte el `Include` en una carga diferida, el conteo salta a 101 y la prueba falla. La prueba no necesita conocer SQL ni preocuparse por el texto exacto. Solo aplica un contrato por endpoint.

Una sutileza: el contador tiene ámbito, pero `WebApplicationFactory` lo resuelve desde el proveedor raíz en versiones anteriores de EF Core. En EF Core 11 el patrón seguro es exponer el contador a través de un middleware por solicitud que lo guarda en `HttpContext.Items` y luego leerlo desde `factory.Services` solo en pruebas donde controla el ciclo de vida. De lo contrario, corre el riesgo de leer un contador que pertenece a una solicitud diferente.

## Por qué `ConfigureWarnings` no es la historia completa

EF Core ha tenido `ConfigureWarnings` desde la versión 3, y muchas guías le dirán que lance excepción en `RelationalEventId.MultipleCollectionIncludeWarning` o `CoreEventId.LazyLoadOnDisposedContextWarning`. Ambas son útiles, pero ninguna captura el N+1 directamente. Capturan formas específicas:

- `MultipleCollectionIncludeWarning` se dispara cuando hace `Include` de dos colecciones hermanas en una única consulta no dividida y advierte sobre una explosión cartesiana. Ese es un problema diferente (una consulta grande que devuelve demasiadas filas) y la solución es `AsSplitQuery`, que en sí mismo puede convertirse en N+1 si se usa mal.
- `LazyLoadOnDisposedContextWarning` solo se dispara después de que el `DbContext` ya no existe. No captura la carga diferida en contexto que produce el N+1 clásico.

No hay una sola advertencia que diga "acabas de hacer la misma consulta 100 veces." Por eso el enfoque del contador es crítico: observa el comportamiento, no la configuración.

## Patrones de solución una vez que ha detectado uno

La detección es la mitad del trabajo. Una vez que la prueba del contador falla, la solución suele encajar en una de estas formas:

- **Agregar un `Include`**. La solución más simple cuando la navegación siempre es necesaria.
- **Cambiar a una proyección**. `Select(o => new OrderListDto(o.Id, o.Customer.Name))` se traduce a un único `JOIN` SQL y evita materializar el grafo completo.
- **Usar `AsSplitQuery`** cuando el padre tiene varias colecciones grandes. Un viaje de ida y vuelta por colección sigue escalando `O(1)` en padres.
- **Precarga masiva**. Si tiene una lista de claves foráneas después de la consulta padre, haga un único seguimiento `WHERE Id IN (...)` en lugar de una búsqueda por fila. La traducción de listas de parámetros de EF Core 11 hace que esto sea conciso.
- **Desactivar la carga diferida por completo**. `UseLazyLoadingProxies` rara vez vale la sorpresa en tiempo de ejecución. El análisis estático y el `Include` explícito encuentran más errores en el momento del PR que a las 3 de la mañana.

Si simula `DbContext` en pruebas unitarias, nada de esto aflora. Esa es una razón más para apoyarse en pruebas de integración contra una base de datos real, el mismo argumento que aparece en [el post sobre simular DbContext](/es/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/): los simuladores hacen que el rastreador de cambios se comporte, pero no pueden reproducir la conversación de cable que hace visible al N+1.

## Dónde mirar a continuación

Los patrones anteriores capturarán más del 95% de los N+1, pero dos herramientas de nicho cubren las esquinas. El perfil `database` de `dotnet-trace` registra cada comando ADO.NET para revisión sin conexión, lo cual es útil cuando la regresión solo se reproduce en una prueba de carga (consulte [la guía de dotnet-trace](/es/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) para conocer el flujo). Y [`MiniProfiler`](https://miniprofiler.com/) sigue funcionando bien como una superposición de UI por solicitud si quiere una insignia mirada al desarrollador que diga "esta página ejecutó 47 consultas SQL."

Lo que todas comparten es la misma idea: exponer la actividad del cable lo suficientemente temprano como para que el desarrollador que introdujo la regresión la vea antes del merge. EF Core 11 hace eso más fácil que cualquier versión anterior, pero solo si activa la opción. El valor predeterminado es el silencio.
