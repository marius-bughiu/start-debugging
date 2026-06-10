---
title: "Solución: The configured execution strategy 'SqlServerRetryingExecutionStrategy' does not support user-initiated transactions"
description: "EnableRetryOnFailure choca con BeginTransaction. Envuelve toda la transaccion en db.Database.CreateExecutionStrategy().ExecuteAsync(...) para que se reintente como una unidad."
pubDate: 2026-06-10
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
lang: "es"
translationOf: "2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions"
translatedBy: "claude"
translationDate: 2026-06-10
---

La solución: activaste la resiliencia de conexión con `EnableRetryOnFailure()` y luego abriste tu propia transaccion con `BeginTransaction()` o `BeginTransactionAsync()`. Una estrategia de ejecución con reintentos no puede reproducir una transaccion que no inició, así que se niega de entrada. Obtén la estrategia desde `db.Database.CreateExecutionStrategy()` y ejecuta toda la transaccion dentro de `strategy.ExecuteAsync(...)`. El delegado completo se convierte en una sola unidad reintentables.

```text
System.InvalidOperationException: The configured execution strategy 'SqlServerRetryingExecutionStrategy' does not support user-initiated transactions. Use the execution strategy returned by 'DbContext.Database.CreateExecutionStrategy()' to execute all the operations in the transaction as a retriable unit.
   at Microsoft.EntityFrameworkCore.Storage.ExecutionStrategy.ExecuteAsync[TState,TResult](TState state, Func`4 operation, Func`4 verifySucceeded, CancellationToken cancellationToken)
   at Microsoft.EntityFrameworkCore.SqlServer.Storage.Internal.SqlServerExecutionStrategy.Execute[TState,TResult](...)
   at Microsoft.EntityFrameworkCore.Storage.RelationalConnection.BeginTransaction()
```

Esta guía está escrita para .NET 11 y `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0, pero el mensaje y la regla subyacente han sido estables desde EF Core 1.1, cuando se introdujo la resiliencia de conexión. Si usas EF Core 6, 8 o 9, todo lo siguiente aplica sin cambios. El nombre del tipo en el mensaje depende de tu proveedor: SQL Server lanza `SqlServerRetryingExecutionStrategy`, Npgsql lanza `NpgsqlRetryingExecutionStrategy`, el proveedor de MySQL de Pomelo lanza el suyo. La solución es idéntica para todos.

## Por qué una estrategia con reintentos rechaza tu transaccion

La resiliencia de conexión funciona envolviendo cada operación de base de datos en un bucle de reintentos. Cuando llamas a `EnableRetryOnFailure()`, EF Core sustituye la estrategia de ejecución por una que sabe qué números de error de SQL Server son transitorios (víctimas de interbloqueo, caídas de conexión, limitación de Azure SQL) y reintenta esas operaciones con retroceso exponencial. La palabra clave es *cada*. Cada consulta y cada llamada a `SaveChangesAsync()` se convierte en su propia unidad reintentables. Si una falla de forma transitoria, la estrategia reproduce esa única operación.

Una transaccion rompe ese modelo. Cuando llamas a `BeginTransactionAsync()`, le estás diciendo a EF Core que varias operaciones forman un único grupo atómico. Si la conexión se cae a la mitad, reintentar una sola sentencia no tiene sentido: el servidor ya revirtió la transaccion, y reproducir un solo `INSERT` dentro de una transaccion que ya no existe fallaría o, peor, confirmaría trabajo parcial. La estrategia de ejecución no puede saber qué se suponía que contenía tu transaccion, así que no puede reproducirla correctamente.

En lugar de reintentar de forma incorrecta y arriesgar la corrupción de datos, EF Core lanza la excepción en el momento en que intentas iniciar una transaccion definida por el usuario mientras hay una estrategia con reintentos activa. La guía oficial es clara sobre lo que está en juego: un reintento ingenuo a través de un límite de confirmación "podría provocar corrupción de datos" si la operación depende del estado del almacén. La excepción es una barandilla, no un error.

## El código más pequeño que lo provoca

```csharp
// .NET 11, Microsoft.EntityFrameworkCore.SqlServer 11.0.0
builder.Services.AddDbContext<AppDb>(options =>
    options.UseSqlServer(
        connectionString,
        sql => sql.EnableRetryOnFailure())); // <-- resiliency on

// ...somewhere in a service:
public async Task TransferAsync(int fromId, int toId, decimal amount)
{
    await using var tx = await _db.Database.BeginTransactionAsync(); // <-- throws here

    var from = await _db.Accounts.FindAsync(fromId);
    var to = await _db.Accounts.FindAsync(toId);
    from!.Balance -= amount;
    to!.Balance += amount;

    await _db.SaveChangesAsync();
    await tx.CommitAsync();
}
```

La línea `BeginTransactionAsync()` nunca devuelve una transaccion. EF Core comprueba primero si hay una estrategia con reintentos activa y lanza el `InvalidOperationException`. Ten en cuenta que no necesitas llamar a `BeginTransaction` de forma explícita para toparte con esto: cualquier cosa que abra una transaccion de usuario cuenta, incluido un `TransactionScope` que hayas creado tú mismo.

## Solución 1: envuelve la transaccion en la estrategia de ejecución

Esta es la solución canónica y la que Microsoft documenta. Pide al contexto su estrategia de ejecución y luego pásale un delegado que contenga toda la transaccion, desde `BeginTransactionAsync` hasta `CommitAsync`. Si ocurre una falla transitoria en cualquier punto del interior, la estrategia vuelve a ejecutar el delegado completo, transaccion incluida.

```csharp
// .NET 11, Microsoft.EntityFrameworkCore.SqlServer 11.0.0
public async Task TransferAsync(int fromId, int toId, decimal amount)
{
    var strategy = _db.Database.CreateExecutionStrategy();

    await strategy.ExecuteAsync(async () =>
    {
        await using var tx = await _db.Database.BeginTransactionAsync();

        var from = await _db.Accounts.FindAsync(fromId);
        var to = await _db.Accounts.FindAsync(toId);
        from!.Balance -= amount;
        to!.Balance += amount;

        await _db.SaveChangesAsync();
        await tx.CommitAsync();
    });
}
```

`CreateExecutionStrategy()` devuelve la misma estrategia con reintentos que EF Core configuró a partir de tu llamada a `EnableRetryOnFailure()`. Cuando la resiliencia está desactivada, devuelve una estrategia sin efecto que ejecuta el delegado exactamente una vez, así que este código es seguro de escribir incluso en proyectos donde los reintentos no están habilitados. Eso hace de `strategy.ExecuteAsync` un envoltorio por defecto razonable para cualquier transaccion explícita, no solo para las de aplicaciones alojadas en Azure.

Hay una regla que pilla a la gente: el delegado debe ser lo bastante idempotente como para ejecutarse desde el principio más de una vez. No leas un valor antes de la llamada a `strategy.ExecuteAsync`, lo modifiques y dependas de esa lectura dentro del reintento. Lleva cada lectura y escritura al interior del delegado para que un reintento empiece desde cero.

## Solución 2: ExecuteInTransactionAsync cuando necesitas verificar la confirmación

`strategy.ExecuteAsync` cubre el caso común, pero tiene un punto ciego. Si la conexión se cae *mientras la confirmación está en curso*, la estrategia no sabe si el servidor realmente confirmó. Por defecto asume una reversión y reproduce, lo que puede insertar una fila duplicada si usas claves generadas por el almacén.

`ExecuteInTransactionAsync` cierra esa brecha. Inicia y confirma la transaccion por ti y acepta un delegado `verifySucceeded` que se ejecuta tras una falla de confirmación transitoria para comprobar si el trabajo se aplicó.

```csharp
// .NET 11, Microsoft.EntityFrameworkCore.SqlServer 11.0.0
var strategy = _db.Database.CreateExecutionStrategy();

var blog = new Blog { Url = "https://startdebugging.net" };
_db.Blogs.Add(blog);

await strategy.ExecuteInTransactionAsync(
    _db,
    operation: (ctx, ct) => ctx.SaveChangesAsync(acceptAllChangesOnSuccess: false, ct),
    verifySucceeded: (ctx, ct) =>
        ctx.Blogs.AsNoTracking().AnyAsync(b => b.BlogId == blog.BlogId, ct));

_db.ChangeTracker.AcceptAllChanges();
```

Aquí importan dos detalles. `SaveChangesAsync` se llama con `acceptAllChangesOnSuccess: false` para que las entidades rastreadas permanezcan en estado `Added` hasta saber que la confirmación se aplicó; eso es lo que permite una reproducción limpia. Luego llamas a `ChangeTracker.AcceptAllChanges()` una vez que la estrategia retorna. La consulta de `verifySucceeded` usa `AsNoTracking()` para que la lectura de verificación no choque con las entidades aún pendientes en el rastreador de cambios.

Si de verdad no te importa la rara falla a mitad de la confirmación, la opción de "no hacer casi nada" de Microsoft es evitar las claves generadas por el almacén (usa un `Guid` del lado del cliente) para que una reproducción ciega lance una violación de clave primaria en lugar de duplicar datos en silencio. Entonces la Solución 1 es suficiente.

## Transacciones ambientales y TransactionScope

El mismo envoltorio funciona con `TransactionScope`, incluso cuando abarca dos contextos. Abre el ámbito y llama a `Complete()` dentro del delegado.

```csharp
// .NET 11, Microsoft.EntityFrameworkCore.SqlServer 11.0.0
var strategy = _db.Database.CreateExecutionStrategy();

await strategy.ExecuteAsync(async () =>
{
    using var scope = new TransactionScope(
        TransactionScopeAsyncFlowOption.Enabled); // required for await inside

    _db.Orders.Add(order);
    await _db.SaveChangesAsync();

    await _auditDb.SaveChangesAsync();

    scope.Complete();
});
```

Sin `TransactionScopeAsyncFlowOption.Enabled`, la transaccion ambiental no fluye a través del `await`, y obtienes un `TransactionAbortedException` separado y difícil de diagnosticar. Es un error distinto, pero aparece exactamente en la misma ruta de código, así que activa la opción siempre que mezcles `TransactionScope` con llamadas asíncronas de EF Core.

## Trampas y casos parecidos

**Puede dispararse en una consulta simple, no solo en una escritura.** El issue de GitHub [dotnet/efcore#29396](https://github.com/dotnet/efcore/issues/29396) registra casos en los que el mensaje aparece en un simple `SELECT`. La causa habitual es un `TransactionScope` externo que olvidaste (a menudo abierto en un repositorio base, una infraestructura de pruebas o un envoltorio de unidad de trabajo), así que la consulta "simple" en realidad se ejecuta dentro de una transaccion de usuario. Busca en tu pila de llamadas cualquier `BeginTransaction` o `new TransactionScope` por encima de la línea que falla.

**Azure SQL puede activar esto sin que lo pidas.** A partir de EF Core 8 aproximadamente, el proveedor de SQL Server empezó a usar por defecto una estrategia con reintentos cuando detecta una cadena de conexión de Azure SQL (consulta [dotnet/efcore#32165](https://github.com/dotnet/efcore/issues/32165)). Código que funcionaba localmente contra LocalDB de repente falla en Azure porque la resiliencia ahora está activa. Si solo ves esto en tu entorno en la nube, esa es la razón. La solución es el mismo envoltorio; no necesitas desactivar el comportamiento por defecto.

**No borres `EnableRetryOnFailure` para que desaparezca.** Eso elimina el error eliminando la resiliencia que presumiblemente querías. Envuelve la transaccion en su lugar. Si de verdad necesitas omitir la resiliencia para una operación aislada, la vía de escape más limpia que se comenta en [dotnet/efcore#24922](https://github.com/dotnet/efcore/issues/24922) es usar un segundo contexto configurado por separado sin reintentos, no quitarla de tu contexto principal.

**Esto no es lo mismo que "A second operation was started on this context instance".** Ese error trata del uso concurrente de un `DbContext`, no de transacciones y reintentos. Si tu mensaje habla de concurrencia y no de estrategias de ejecución, consulta la solución para [una segunda operación iniciada en este contexto](/es/2026/05/fix-second-operation-was-started-on-this-context-instance/).

## Relacionado

- [Solución: SqlException: Timeout expired durante migraciones de EF Core](/es/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/) cubre la familia de fallas transitorias desde el lado de las migraciones.
- [Solución: ObjectDisposedException: Cannot access a disposed context instance](/es/2026/06/fix-objectdisposedexception-cannot-access-a-disposed-context-instance/) es la otra trampa de ciclo de vida de EF Core que afecta al código asíncrono.
- [EF Core ExecuteUpdate vs cargar entidades y SaveChanges](/es/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) muestra cuándo puedes evitar una transaccion explícita por completo.
- [Cómo usar interceptores de EF Core 11 para auditoría](/es/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/) para engancharte al canal de guardado sin transacciones manuales.
- [Migrar de EF Core 6 a EF Core 11: cambios disruptivos que de verdad muerden](/es/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) señala el valor por defecto de reintentos de Azure SQL, entre otras sorpresas.

## Fuentes

- [Connection Resiliency, EF Core](https://learn.microsoft.com/en-us/ef/core/miscellaneous/connection-resiliency) - la guía canónica sobre `CreateExecutionStrategy`, `ExecuteInTransactionAsync` y el problema de idempotencia.
- [Implement resilient Entity Framework Core SQL connections](https://learn.microsoft.com/en-us/dotnet/architecture/microservices/implement-resilient-applications/implement-resilient-entity-framework-core-sql-connections) - la versión del mismo patrón en la arquitectura de microservicios de .NET.
- [dotnet/efcore#32165: estrategia de reintentos por defecto en Azure SQL](https://github.com/dotnet/efcore/issues/32165)
- [dotnet/efcore#29396: error en un SELECT simple](https://github.com/dotnet/efcore/issues/29396)
- [dotnet/efcore#24922: suspender la estrategia de ejecución configurada](https://github.com/dotnet/efcore/issues/24922)
