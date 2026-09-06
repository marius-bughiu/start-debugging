---
title: "Cómo usar bloqueo pesimista con UPDLOCK y SELECT ... FOR UPDATE en EF Core 11"
description: "EF Core 11 sigue sin tener una API de bloqueo. Así se toma un bloqueo de fila real con FromSql: WITH (UPDLOCK, ROWLOCK) en SQL Server, FOR UPDATE en PostgreSQL, la trampa de la subconsulta que amplía el bloqueo en silencio, NOWAIT y SKIP LOCKED, reintentos ante interbloqueos, y qué hacer cuando la fila todavía no existe."
pubDate: 2026-09-06
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "concurrency"
  - "sql-server"
  - "postgresql"
  - "dotnet-11"
  - "how-to"
lang: "es"
translationOf: "2026/09/how-to-use-pessimistic-locking-with-updlock-and-select-for-update-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-09-06
---

Respuesta corta: EF Core 11 no tiene una API de bloqueo pesimista, así que tomas el bloqueo tú mismo con `FromSql` dentro de una transacción explícita. En SQL Server eso es `SELECT * FROM [Orders] WITH (UPDLOCK, ROWLOCK) WHERE [Id] = {id}`; en PostgreSQL es `SELECT * FROM "Orders" WHERE "Id" = {id} FOR UPDATE`. Dos reglas hacen que funcione y son casi siempre lo que la gente equivoca: la consulta debe ejecutarse dentro de una transacción que abriste tú (de lo contrario el bloqueo se libera en el instante en que el lector termina), y la cláusula `WHERE` debe vivir dentro de la cadena de `FromSql`, no en un `.Where()` de LINQ encadenado después.

Este artículo cubre el SQL exacto que EF Core emite para cada forma, por qué componer LINQ sobre una consulta con bloqueo amplía silenciosamente el bloqueo a toda la tabla, cómo `NOWAIT` y `SKIP LOCKED` cambian el modo de fallo, cómo reintentar un interbloqueo sin pelearte con la estrategia de resiliencia de conexión, y el caso del que nadie escribe: bloquear una fila que todavía no existe.

Una nota sobre versiones. EF Core 11 está en versión preliminar a septiembre de 2026 y se lanza con .NET 11 en noviembre de 2026, según la [página de versiones y planificación de EF Core](https://learn.microsoft.com/en-us/ef/core/what-is-new/). EF11 requiere el runtime de .NET 11. Como el único SDK en esta máquina es .NET 10.0.302, cada fragmento de SQL generado que aparece abajo se produjo con `ToQueryString()` sobre `Microsoft.EntityFrameworkCore.SqlServer` 10.0.10 y `Npgsql.EntityFrameworkCore.PostgreSQL` 10.0.3. Nada en esta área cambió en EF11: la página [What's New in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) no lista cambios en `FromSql`, transacciones ni bloqueos.

## EF Core sigue sin una API de bloqueo, y es deliberado

La solicitud lleva abierta desde septiembre de 2021 como [dotnet/efcore#26042, "Support SELECT FOR UPDATE / UPDLOCK (pessimistic concurrency)"](https://github.com/dotnet/efcore/issues/26042). Está etiquetada como `needs-design` y vive en el hito Backlog sin versión objetivo. EF Core 11 no la cierra.

La razón por la que una API genérica es difícil se ve en el resto de este artículo: SQL Server expresa el bloqueo como una sugerencia de tabla adjunta a una referencia de tabla, PostgreSQL lo expresa como una cláusula a nivel de sentencia con cuatro intensidades distintas, y ambos discrepan sobre qué pasa con los joins, `LIMIT` y las filas que no existen. No hay una forma que se mapee limpiamente a las dos. Así que escribes el SQL.

La alternativa, a la que deberías recurrir primero, es un token de concurrencia `rowversion`. El bloqueo pesimista es la herramienta correcta solo cuando el trabajo en conflicto ocurre dentro de una única transacción corta en el servidor. Si hay una persona en medio del ciclo leer-modificar-escribir, usa [un token de concurrencia rowversion en EF Core 11](/es/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/) en su lugar: no puedes mantener abierta una transacción de base de datos durante la pausa para el café de un usuario.

## La configuración, en cuatro pasos

1. **Abre una transacción explícita.** `await using var tx = await context.Database.BeginTransactionAsync();`. Todo bloqueo de fila vive y muere con una transacción. Sin ella, EF Core envuelve la lectura en su propia transacción implícita que hace commit en cuanto el lector se agota, y el bloqueo desaparece microsegundos después.
2. **Lee la fila mediante `FromSql`, con el filtro dentro de la cadena SQL.** La sintaxis de bloqueo tiene que estar sobre la referencia de tabla que realmente se recorre.
3. **Muta la entidad rastreada y llama a `SaveChangesAsync`.** Los resultados de `FromSql` se rastrean de forma predeterminada, exactamente como cualquier otra consulta LINQ, así que la actualización se genera sola.
4. **Haz commit.** El bloqueo se libera en el commit o el rollback, y no antes.

Aquí está la versión de SQL Server de principio a fin:

```csharp
// EF Core 11 (verified on EF Core 10.0.10), .NET 11, C# 14
await using var tx = await context.Database.BeginTransactionAsync();

var order = await context.Orders
    .FromSql($"SELECT * FROM [Orders] WITH (UPDLOCK, ROWLOCK) WHERE [Id] = {orderId}")
    .SingleAsync();

order.Status = "Confirmed";
await context.SaveChangesAsync();

await tx.CommitAsync();
```

Y la versión de PostgreSQL, que es el mismo código con otra cadena:

```csharp
// Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3
await using var tx = await context.Database.BeginTransactionAsync();

var order = await context.Orders
    .FromSql($"""SELECT * FROM "Orders" WHERE "Id" = {orderId} FOR UPDATE""")
    .SingleAsync();

order.Status = "Confirmed";
await context.SaveChangesAsync();

await tx.CommitAsync();
```

La interpolación de `FromSql` no es concatenación de cadenas. El hueco `{orderId}` se convierte en un `DbParameter`, que es por lo que esto es seguro frente a inyección. `ToQueryString()` lo confirma:

```sql
-- SQL Server, from ToQueryString()
DECLARE p0 int = 42;

SELECT * FROM [Orders] WITH (UPDLOCK, ROWLOCK) WHERE [Id] = @p0
```

Una restricción de la [documentación de consultas SQL de EF Core](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries): el conjunto de resultados debe contener una columna por cada propiedad mapeada de la entidad, con los nombres de columna mapeados. `SELECT *` cumple eso. Un conjunto de columnas escrito a mano que olvide una propiedad falla en la materialización, que es el tema de [la columna requerida no estaba presente en los resultados de una operación FromSql](/es/2026/07/fix-the-required-column-was-not-present-in-the-results-of-a-fromsql-operation-in-ef-core-11/).

## Qué te da realmente UPDLOCK en SQL Server

`UPDLOCK` toma bloqueos de actualización (U) en lugar de bloqueos compartidos (S) y, según la [referencia de sugerencias de tabla](https://learn.microsoft.com/en-us/sql/t-sql/queries/hints-transact-sql-table), los mantiene hasta que la transacción termina. Esa segunda mitad es todo el punto. Un `SELECT` simple bajo `READ COMMITTED` toma bloqueos compartidos y los suelta en cuanto ha leído la fila, así que dos transacciones pueden leer ambas, decidir ambas escribir, y luego caer en interbloqueo mientras cada una intenta convertir su bloqueo S en un bloqueo X. Los bloqueos U no son compatibles entre sí, así que el segundo lector se bloquea en la lectura en vez de interbloquearse en la escritura. Ese interbloqueo por conversión es el síntoma clásico que lleva a la gente a buscar esta funcionalidad.

Tres detalles que vale la pena interiorizar:

- **`ROWLOCK` es una petición de granularidad, no una garantía.** Pide bloqueos de fila donde SQL Server tomaría normalmente bloqueos de página o de tabla. Añádelo para que un recorrido de unas pocas filas no escale a un bloqueo de página sobre filas que nunca tocaste. Si `UPDLOCK` acaba combinado con `TABLOCK` por cualquier motivo, la documentación dice que obtienes un bloqueo exclusivo de tabla, que rara vez es lo que querías.
- **`UPDLOCK` por sí solo no detiene los inserts.** Bloquea las filas que existen. Si tu lógica es "suma las líneas de este pedido y luego inserta una más", otra transacción puede insertar una línea que cambie la suma. Añade `HOLDLOCK`, que la documentación describe como equivalente a `SERIALIZABLE`, para obtener bloqueos de rango de claves sobre el predicado durante toda la transacción: `WITH (UPDLOCK, HOLDLOCK, ROWLOCK)`.
- **Los bloqueos pueden caer sobre claves de índice, no sobre filas de datos.** La sección de observaciones es explícita: si un índice no agrupado de cobertura responde la consulta, el bloqueo se toma sobre la clave del índice. Normalmente invisible, ocasionalmente la razón por la que dos consultas que creías disjuntas se bloquean mutuamente.

Ten en cuenta también la obsolescencia: las sugerencias de tabla sin la palabra clave `WITH` todavía se analizan, pero Microsoft ha marcado esa forma para eliminación. Escribe `WITH (UPDLOCK, ROWLOCK)`, con comas entre sugerencias, no `(UPDLOCK ROWLOCK)`.

## PostgreSQL tiene cuatro intensidades de bloqueo, y FOR UPDATE es la más fuerte

La [documentación de la cláusula de bloqueo de SELECT](https://www.postgresql.org/docs/current/sql-select.html) define `FOR UPDATE`, `FOR NO KEY UPDATE`, `FOR SHARE` y `FOR KEY SHARE`, en intensidad descendente. `FOR UPDATE` bloquea a todos los demás que quieran bloquear, más `UPDATE` y `DELETE`. `FOR NO KEY UPDATE` es lo que un `UPDATE` simple que no toca una columna de clave toma por su cuenta, y es la elección correcta cuando solo cambias columnas que no son clave y no quieres bloquear las comprobaciones de clave foránea de tablas hijas, que toman `FOR KEY SHARE`.

El patrón que atrapa a la gente es `FOR UPDATE` combinado con `Include`. PostgreSQL se niega a bloquear el lado anulable de un outer join: "FOR UPDATE cannot be applied to the nullable side of an outer join". El arreglo es `FOR UPDATE OF "Orders"`, nombrando solo la tabla que realmente quieres bloquear. En EF Core este problema se resuelve casi solo, porque `Include` se compone sobre tu `FromSql` como una subconsulta y el join queda fuera de ella:

```sql
-- Npgsql, FromSql with FOR UPDATE plus .Include(o => o.Lines)
SELECT o."Id", o."Status", o."Total", o0."Id", o0."OrderId", o0."Quantity"
FROM (
    SELECT * FROM "Orders" WHERE "Id" = @p0 FOR UPDATE
) AS o
LEFT JOIN "OrderLines" AS o0 ON o."Id" = o0."OrderId"
ORDER BY o."Id"
```

La fila de `Orders` queda bloqueada, las filas de `OrderLines` no. Si necesitas bloquear también las líneas, bloquéalas en un segundo `FromSql` contra `OrderLines`, en un orden consistente.

## La trampa de la subconsulta que amplía tu bloqueo en silencio

Este es el modo de fallo que apostaría dinero a ver en código de producción. `FromSql` se compone: cualquier operador LINQ que encadenes después convierte tu SQL en una tabla derivada. Saca el filtro de la cadena y ponlo en `.Where()`, y esto es lo que genera EF Core:

```sql
-- Npgsql: .FromSql($"""SELECT * FROM "Orders" FOR UPDATE""").Where(o => o.Status == "Pending")
SELECT o."Id", o."Status", o."Total"
FROM (
    SELECT * FROM "Orders" FOR UPDATE
) AS o
WHERE o."Status" = 'Pending'
```

El `FOR UPDATE` ahora está adjunto a un recorrido sin filtrar de `Orders`. PostgreSQL no empujará el predicado externo hacia dentro de una subconsulta que lleva una cláusula de bloqueo, porque hacerlo cambiaría qué filas se bloquean. La documentación hace el mismo señalamiento en su solución alternativa para `ORDER BY`: `SELECT * FROM (SELECT * FROM mytable FOR UPDATE) ss ORDER BY column1` "bloquea todas las filas". Así que esta consulta bloquea todas las filas de la tabla y bloquea a todos los demás escritores, y lo hace sin un error, sin una advertencia y sin nada en el plan de consulta que parezca obviamente mal.

SQL Server produce la misma forma y un problema más sutil:

```sql
-- SQL Server: .FromSql($"SELECT * FROM [Orders] WITH (UPDLOCK, ROWLOCK)").Where(o => o.Status == "Pending")
SELECT [o].[Id], [o].[Status], [o].[Total]
FROM (
    SELECT * FROM [Orders] WITH (UPDLOCK, ROWLOCK)
) AS [o]
WHERE [o].[Status] = N'Pending'
```

Una tabla derivada no es una barrera de optimización en T-SQL, así que el optimizador puede empujar o no el predicado dentro de ella. Qué filas acaban bloqueadas se vuelve una propiedad del plan elegido en vez de una propiedad de tu código. Ese no es un bug que quieras depurar a las 3 de la madrugada.

La regla: todo lo que reduzca el conjunto de filas va dentro de la cadena de `FromSql`. Encadena LINQ después solo para cosas que no puedan ampliar el bloqueo, como `Include` o una proyección. Y verifícalo una vez, con `ToQueryString()` en un test o [registrando el SQL que genera EF Core 11](/es/2026/07/how-to-log-the-sql-that-ef-core-11-generates/).

## NOWAIT y SKIP LOCKED: elegir tu forma de fallar

De forma predeterminada, una petición de bloqueo bloqueada espera. Ambas bases de datos te dan dos alternativas.

**Fallar rápido.** El `FOR UPDATE NOWAIT` de PostgreSQL lanza el SQLSTATE `55P03` (`lock_not_available`) inmediatamente en vez de esperar. La sugerencia de tabla `NOWAIT` de SQL Server está documentada como equivalente a `SET LOCK_TIMEOUT 0` para esa tabla, y aflora como el error 1222, "Lock request time out period exceeded". En cualquier caso obtienes una excepción que puedes traducir a un 409 en vez de una petición que se queda sentada en un hilo treinta segundos:

```csharp
// Npgsql: fail immediately rather than queue behind another worker
try
{
    var order = await context.Orders
        .FromSql($"""SELECT * FROM "Orders" WHERE "Id" = {orderId} FOR UPDATE NOWAIT""")
        .SingleAsync();
}
catch (PostgresException ex) when (ex.SqlState == "55P03")
{
    return Results.Conflict("Order is being modified by another request.");
}
```

**Saltarse las filas en disputa.** Este es el patrón de cola de trabajos, y es el único caso en el que el bloqueo pesimista es inequívocamente el diseño correcto. PostgreSQL lo escribe `SKIP LOCKED`; SQL Server lo escribe `READPAST`, que la documentación describe como construido precisamente "para reducir la contención de bloqueos al implementar una cola de trabajo que usa una tabla de SQL Server".

```csharp
// SQL Server: claim up to 10 unclaimed jobs, skipping rows other workers hold
await using var tx = await context.Database.BeginTransactionAsync();

var jobs = await context.Jobs
    .FromSql($"""
        SELECT TOP (10) * FROM [Jobs] WITH (UPDLOCK, READPAST, ROWLOCK)
        WHERE [Status] = 'Queued' ORDER BY [Id]
        """)
    .ToListAsync();

foreach (var job in jobs)
{
    job.Status = "Running";
}

await context.SaveChangesAsync();
await tx.CommitAsync();
```

Dos restricciones sobre `READPAST`. Se salta los bloqueos de nivel fila pero no los de nivel página, que es otra razón para emparejarlo con `ROWLOCK`. Y no puede usarse cuando `READ_COMMITTED_SNAPSHOT` está en `ON` y el nivel de aislamiento de la sesión es `READ COMMITTED`; en esa configuración tienes que añadir la sugerencia `READCOMMITTEDLOCK`. En PostgreSQL, `SKIP LOCKED` te da una vista deliberadamente inconsistente, lo cual está bien para una cola y está mal para cualquier cosa que pienses agregar.

## Los interbloqueos siguen ocurriendo, así que reintenta

El bloqueo pesimista convierte la mayoría de los conflictos de escritura en espera, pero no elimina los interbloqueos: dos transacciones que bloquean las filas A y luego B, y B y luego A, seguirán interbloqueándose (error 1205 de SQL Server, SQLSTATE `40P01` de PostgreSQL). El arreglo estructural barato es adquirir siempre los bloqueos en un orden determinista, lo que normalmente significa ordenar por clave primaria antes de empezar a bloquear.

Para el resto, reintenta. Si has habilitado `EnableRetryOnFailure`, ten en cuenta que la estrategia de ejecución con reintentos se niega a envolver una transacción que abriste tú y lanza `InvalidOperationException`. Toda la unidad de trabajo tiene que pasar por la estrategia, algo cubierto en detalle en [la estrategia de ejecución no admite transacciones iniciadas por el usuario](/es/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/):

```csharp
var strategy = context.Database.CreateExecutionStrategy();

await strategy.ExecuteAsync(async () =>
{
    await using var tx = await context.Database.BeginTransactionAsync();

    var order = await context.Orders
        .FromSql($"SELECT * FROM [Orders] WITH (UPDLOCK, ROWLOCK) WHERE [Id] = {orderId}")
        .SingleAsync();

    order.Status = "Confirmed";
    await context.SaveChangesAsync();
    await tx.CommitAsync();
});
```

Una advertencia: la `SqlServerRetryingExecutionStrategy` predeterminada de EF reintenta una lista específica de números de error transitorios de SQL Server. Verifica que los interbloqueos estén en el conjunto que te importa, o proporciona tu propio `errorNumbersToAdd`, en vez de asumir que el 1205 está cubierto.

## No puedes bloquear una fila que no existe

La mayor limitación, con diferencia. `SELECT ... FOR UPDATE` sobre una fila que no ha sido insertada devuelve cero filas y no bloquea nada, así que la clásica carrera de "comprueba si este nombre de usuario está tomado y luego insértalo" queda completamente desprotegida por los bloqueos de fila. Dos transacciones ven ambas nada, insertan ambas, y una obtiene una violación de restricción única, que es exactamente el escenario de [fix 23505 duplicate key value violates unique constraint en un insert concurrente de EF Core](/es/2026/08/fix-23505-duplicate-key-value-violates-unique-constraint-on-a-concurrent-ef-core-insert/).

Tres salidas, en orden creciente de cuánto deberían gustarte:

- **Un índice único más una excepción capturada.** La base de datos lo impone, tú traduces la excepción del proveedor a un error de dominio. Aburrido, correcto y la respuesta por defecto.
- **Un bloqueo de predicado.** En SQL Server, `WITH (UPDLOCK, HOLDLOCK)` sobre el `WHERE` que habría coincidido toma un bloqueo de rango de claves y sí bloquea el insert competidor. PostgreSQL no tiene equivalente directo salvo el nivel de aislamiento `SERIALIZABLE`.
- **Un bloqueo consultivo con clave sobre el valor.** El `pg_advisory_xact_lock(key)` de PostgreSQL toma un bloqueo sobre un número arbitrario de 64 bits que se libera automáticamente al final de la transacción (a diferencia de `pg_advisory_lock`, que tiene alcance de sesión y sobrevive a un rollback). El equivalente de SQL Server es `sys.sp_getapplock` con `@LockOwner = 'Transaction'` y un nombre de recurso en forma de cadena, que devuelve `0` o `1` en caso de éxito y `-1` por timeout, `-3` por ser víctima de un interbloqueo.

```csharp
// PostgreSQL: serialise on a logical key rather than a row
await using var tx = await context.Database.BeginTransactionAsync();
await context.Database.ExecuteSqlAsync($"SELECT pg_advisory_xact_lock({tenantId})");
// ... read, decide, insert ...
await tx.CommitAsync();
```

Los bloqueos consultivos son la herramienta correcta cuando lo que estás serializando es una decisión y no una fila: "solo un worker puede ejecutar el resumen nocturno para este inquilino".

## Cuándo recurrir a algo completamente distinto

Si toda la operación es una única actualización aritmética, no bloquees nada. `UPDATE Accounts SET Balance = Balance - 10 WHERE Id = 1 AND Balance >= 10` es atómica, toma su propio bloqueo exclusivo mientras dura la sentencia, y te dice mediante el número de filas afectadas si la precondición se cumplió. En EF Core eso es `ExecuteUpdateAsync`, y las contrapartidas frente a cargar la entidad están cubiertas en [ExecuteUpdate frente a cargar entidades y SaveChanges](/es/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/). Un bloqueo pesimista solo se gana su sitio cuando hay lógica real entre la lectura y la escritura que SQL no puede expresar.

Y mantén la transacción corta. Todo lo que hagas entre `BeginTransactionAsync` y `CommitAsync` es tiempo que otras peticiones pasan bloqueadas. Una llamada HTTP a un proveedor de pagos dentro de una transacción que mantiene bloqueos es la forma en que una sola dependencia lenta tumba una tabla entera.

### Lee a continuación

- [Cómo implementar concurrencia optimista con un token rowversion en EF Core 11](/es/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/)
- [Fix: la estrategia de ejecución no admite transacciones iniciadas por el usuario](/es/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/)
- [Fix: la columna requerida no estaba presente en los resultados de una operación FromSql en EF Core 11](/es/2026/07/fix-the-required-column-was-not-present-in-the-results-of-a-fromsql-operation-in-ef-core-11/)
- [Cómo registrar el SQL que genera EF Core 11](/es/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [ExecuteUpdate frente a cargar entidades y SaveChanges en EF Core](/es/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/)

## Fuentes

- [Support SELECT FOR UPDATE / UPDLOCK (pessimistic concurrency), dotnet/efcore#26042](https://github.com/dotnet/efcore/issues/26042), abierta desde 2021 y todavía en el hito Backlog.
- [Table hints (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/queries/hints-transact-sql-table) para `UPDLOCK`, `HOLDLOCK`, `ROWLOCK`, `READPAST`, `NOWAIT`, la obsolescencia de la palabra clave `WITH` y el bloqueo sobre claves de índice.
- [SELECT, The Locking Clause](https://www.postgresql.org/docs/current/sql-select.html) para las cuatro intensidades de bloqueo, `NOWAIT`, `SKIP LOCKED`, la lista `OF table` y la nota sobre bloqueo en subconsultas.
- [Explicit locking, documentación de PostgreSQL](https://www.postgresql.org/docs/current/explicit-locking.html) para la matriz de conflictos de bloqueos de fila y los bloqueos consultivos con alcance de transacción.
- [SQL queries in EF Core](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries) para la parametrización de `FromSql`, la componibilidad, el envoltorio en subconsulta y el seguimiento de cambios.
- [sys.sp_getapplock (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-getapplock-transact-sql) para los modos de bloqueo, la propiedad por transacción frente a por sesión y los códigos de retorno.
- [What's New in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew), que confirma que EF11 requiere el runtime de .NET 11 y no lista cambios en bloqueos ni en `FromSql`.
