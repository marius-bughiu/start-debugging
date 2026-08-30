---
title: "Fix: 23505: duplicate key value violates unique constraint en un insert concurrente de EF Core"
description: "El comprobar-luego-insertar de tu handler no es atómico. Captura PostgresException con SqlState 23505, o colapsa todo en una sola sentencia INSERT ... ON CONFLICT. EnableRetryOnFailure no te va a ayudar."
pubDate: 2026-08-30
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "postgresql"
  - "npgsql"
  - "concurrency"
  - "dotnet-11"
lang: "es"
translationOf: "2026/08/fix-23505-duplicate-key-value-violates-unique-constraint-on-a-concurrent-ef-core-insert"
translatedBy: "claude"
translationDate: 2026-08-30
---

Tu handler consulta "¿ya existe este email?", no ve nada e inserta. Bajo carga, dos solicitudes hacen eso al mismo tiempo, ninguna ve nada, y Postgres rechaza a la perdedora en el índice con `23505`. El índice único no es el bug, es lo único que atrapó el bug. Corrígelo de una de dos formas: colapsa la lectura y la escritura en una sola sentencia `INSERT ... ON CONFLICT` para que no haya ventana entre ambas, o mantén el insert ingenuo y captura la `DbUpdateException` cuya excepción interna sea una `PostgresException` con `SqlState == PostgresErrorCodes.UniqueViolation`, y luego vuelve a leer la fila que escribió la ganadora. No recurras a `EnableRetryOnFailure`: el detector de errores transitorios de Npgsql devuelve `false` para `23505`, así que la capa de resiliencia te va a pasar la excepción directamente.

Una nota sobre la verificación. El único SDK en esta máquina es .NET 10.0.302, y no hay servidor de Postgres en ella, así que todo lo que sigue se comprobó contra `Npgsql` 10.0.3, `Npgsql.EntityFrameworkCore.PostgreSQL` 10.0.3 y `Microsoft.EntityFrameworkCore` 10.0.4 sin conexión (valores de constantes, el detector de excepciones transitorias, el SQL generado, el estado del change tracker), más la documentación de PostgreSQL 18 para el comportamiento del lado del servidor. El proveedor Npgsql 11.0 todavía está en versión preliminar al momento de escribir esto y sus [notas de la versión 11.0](https://www.npgsql.org/efcore/release-notes/11.0.html) no listan cambios en el mapeo de errores, en el batching de `SaveChanges`, ni en el detector de reintentos, así que todo esto aplica también a EF Core 11 y al proveedor 11.0. Cuando una afirmación viene de la documentación del servidor y no de una ejecución en esta máquina, lo digo.

## El error en contexto

```text
Microsoft.EntityFrameworkCore.DbUpdateException: An error occurred while saving the entity changes. See the inner exception for details.
 ---> Npgsql.PostgresException (0x80004005): 23505: duplicate key value violates unique constraint "IX_Users_Email"

DETAIL: Key ("Email")=(ada@example.com) already exists.
   at Npgsql.Internal.NpgsqlConnector.ReadMessageLong(...)
   at Npgsql.NpgsqlDataReader.NextResult(...)
   at Microsoft.EntityFrameworkCore.Update.Internal.BatchExecutor.ExecuteAsync(...)
   at Microsoft.EntityFrameworkCore.Storage.RelationalDatabase.SaveChangesAsync(...)
```

Dos cosas en ese bloque vale la pena leerlas con atención.

El nombre de la restricción te dice qué falla tienes. `IX_Users_Email` es un índice único que declaraste tú, así que se trata de una condición de carrera a nivel de aplicación. Si en cambio dice `PK_Users`, casi con seguridad tienes una secuencia de identidad desincronizada, que es un problema completamente distinto y se cubre más abajo.

La línea `DETAIL:` puede faltar por completo. El parámetro de cadena de conexión `Include Error Detail` de Npgsql tiene `false` por defecto (verificado: `new NpgsqlConnectionStringBuilder("Host=h;Database=d").IncludeErrorDetail` devuelve `False` en Npgsql 10.0.3), porque el texto del detalle contiene el valor de clave conflictivo y eso suele ser dato personal. Agrega `Include Error Detail=true` en desarrollo si quieres el valor, y déjalo apagado en producción salvo que te resulte aceptable que las claves terminen en tus registros.

## Por qué ocurre esto

La causa dominante, y la que encaja con "solo pasa bajo carga", es que una comprobación seguida de un insert son dos sentencias con un hueco entre ellas. Nada dentro de una transacción `READ COMMITTED` impide que otra sesión inserte en ese hueco. La documentación de PostgreSQL sobre [comprobaciones de unicidad de índices](https://www.postgresql.org/docs/current/index-unique-checks.html) describe lo que hace el servidor cuando la otra sesión todavía no ha hecho commit: "If a conflicting row has been inserted by an as-yet-uncommitted transaction, the would-be inserter must wait to see if that transaction commits." Si hace rollback no hay conflicto y tu insert continúa; si hace commit, obtienes `23505`. Por eso el error llega a ráfagas y por eso nunca se reproduce en la laptop de un desarrollador con una sola solicitud en vuelo.

Otras dos causas producen el mismo SQLSTATE y conviene descartarlas antes de escribir cualquier código de concurrencia:

- **Una secuencia desincronizada.** Después de un `pg_restore`, un `COPY`, o una importación de datos que suministró claves primarias explícitas, la secuencia de identidad sigue apuntando a 1 mientras que la tabla ya tiene filas hasta 40 000. Entonces cada insert choca en `PK_<Table>`. El arreglo es `SELECT setval(pg_get_serial_sequence('"Users"', 'Id'), (SELECT MAX("Id") FROM "Users"));`, no un bucle de reintentos.
- **Reintentar `SaveChanges` sobre el mismo `DbContext`.** Un `SaveChangesAsync` fallido no desasocia nada. Lo comprobé directamente: después de la excepción, `ChangeTracker.Entries()` sigue reportando la entidad conflictiva en estado `Added`, `DbUpdateException.Entries` tiene exactamente una entrada, y llamar de nuevo a `SaveChangesAsync` sobre ese mismo contexto lanza la excepción idéntica. Cualquier reintento tiene que partir de un contexto nuevo.

## Reproducción mínima

```csharp
// .NET SDK 10.0.302, EF Core 10.0.4, Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3
public class User
{
    public int Id { get; set; }
    public string Email { get; set; } = "";
    public string Name { get; set; } = "";
}

protected override void OnModelCreating(ModelBuilder mb)
    => mb.Entity<User>().HasIndex(u => u.Email).IsUnique();
```

Ese modelo produce exactamente este DDL desde el proveedor Npgsql (`db.Database.GenerateCreateScript()`, ejecutado sin conexión):

```sql
CREATE TABLE "Users" (
    "Id" integer GENERATED BY DEFAULT AS IDENTITY,
    "Email" text NOT NULL,
    "Name" text NOT NULL,
    CONSTRAINT "PK_Users" PRIMARY KEY ("Id")
);

CREATE UNIQUE INDEX "IX_Users_Email" ON "Users" ("Email");
```

Y este es el handler que pierde la carrera:

```csharp
// Racy: the gap between AnyAsync and SaveChangesAsync is unguarded.
public async Task<User> RegisterAsync(string email, string name, CancellationToken ct)
{
    if (await db.Users.AnyAsync(u => u.Email == email, ct))
        throw new EmailTakenException(email);

    var user = new User { Email = email, Name = name };
    db.Users.Add(user);
    await db.SaveChangesAsync(ct);   // 23505 when a second request got here first
    return user;
}
```

Envolver esas tres sentencias en una transacción no ayuda. Una transacción te da atomicidad, no exclusión mutua, y `READ COMMITTED` es el valor por defecto. Subir el nivel de aislamiento tampoco ayuda: cambia el SQLSTATE que obtienes en algunos escenarios, pero no hace desaparecer el conflicto. La página de PostgreSQL sobre [manejo de fallos de serialización](https://www.postgresql.org/docs/current/mvcc-serialization-failure-handling.html) aborda este patrón de frente, señalando que un fallo de clave única después de inspeccionar las claves almacenadas "is effectively a serialization failure, but the server will not detect it as such because it cannot see the connection between the inserted value and the previous reads."

## Arreglo 1: una sola sentencia, con ON CONFLICT

Este es el arreglo al que hay que recurrir primero. `INSERT ... ON CONFLICT` es una sola sentencia, así que no hay ventana en la que nadie pueda insertar, y la resolución del conflicto ocurre dentro de la ruta de inserción en el índice del servidor.

La sutileza está en recuperar la fila. `ON CONFLICT DO NOTHING` no devuelve nada cuando hay conflicto: la [documentación de INSERT](https://www.postgresql.org/docs/current/sql-insert.html) indica que `RETURNING` solo devuelve las filas insertadas o actualizadas con éxito. Así que un get-or-create que necesita conocer el id usa `DO UPDATE` con una autoasignación, que toca la fila y por lo tanto la hace elegible para `RETURNING`:

```csharp
// EF Core 10.0.4 / Npgsql 10.0.3. Same code compiles unchanged on EF Core 11.
public async Task<int> GetOrCreateUserIdAsync(string email, string name, CancellationToken ct)
{
    var ids = await db.Database.SqlQuery<int>($"""
        INSERT INTO "Users" ("Email", "Name")
        VALUES ({email}, {name})
        ON CONFLICT ("Email") DO UPDATE SET "Email" = EXCLUDED."Email"
        RETURNING "Id" AS "Value"
        """).ToListAsync(ct);

    return ids.Single();
}
```

Cuatro detalles de ese fragmento son estructurales:

1. **`AS "Value"`.** `SqlQuery<T>` para un tipo escalar lee una columna llamada `Value`. Sin el alias obtienes un fallo en tiempo de ejecución por una columna faltante, no un error de compilación.
2. **Los huecos interpolados son parámetros, no concatenación.** `ToQueryString()` sobre esa consulta emite `VALUES (@p0, @p1)` con los valores reportados por separado, así que la preocupación habitual de inyección no aplica aquí.
3. **`ToListAsync`, nunca `FirstOrDefaultAsync`.** EF Core inspecciona el SQL crudo y se niega a componer sobre una sentencia que no es un `SELECT`. Agregar cualquier operador LINQ lanza `InvalidOperationException: 'FromSql' or 'SqlQuery' was called with non-composable SQL and with a query composing over it.` Me topé exactamente con esto, en `NpgsqlQuerySqlGenerator`, mientras revisaba el SQL generado. Materializa la lista primero y después elige.
4. **`EXCLUDED` es la fila propuesta.** `SET "Email" = EXCLUDED."Email"` es una escritura deliberadamente sin efecto cuyo único propósito es hacer que la fila conflictiva sea elegible para `RETURNING`.

Si de verdad no necesitas el id de vuelta, prefiere `ON CONFLICT ("Email") DO NOTHING` y evita la amplificación de escritura. La versión con autoasignación escribe una nueva versión de la fila, incrementa `xmax` y dispara cualquier trigger `BEFORE UPDATE` en cada intento duplicado.

Una restricción más que la documentación deja explícita: `ON CONFLICT DO UPDATE` no tocará dos veces la misma fila existente dentro de una sola sentencia, y lanza una violación de cardinalidad (`21000`) si tu lista `VALUES` contiene la misma clave dos veces. Deduplica el lote en C# antes de enviarlo.

## Arreglo 2: insertar de forma optimista, capturar 23505, releer

Cuando el insert está enterrado en una unidad de trabajo mayor y reescribirlo como SQL crudo es poco práctico, deja que el índice sea tu candado y maneja la derrota:

```csharp
// EF Core 10.0.4 / Npgsql 10.0.3
public async Task<User> RegisterAsync(string email, string name, CancellationToken ct)
{
    var user = new User { Email = email, Name = name };
    db.Users.Add(user);

    try
    {
        await db.SaveChangesAsync(ct);
        return user;
    }
    catch (DbUpdateException ex)
        when (ex.InnerException is PostgresException
              {
                  SqlState: PostgresErrorCodes.UniqueViolation,
                  ConstraintName: "IX_Users_Email"
              })
    {
        // Someone else won. This context is poisoned: the entity is still Added.
        await using var fresh = await factory.CreateDbContextAsync(ct);
        return await fresh.Users.SingleAsync(u => u.Email == email, ct);
    }
}
```

`PostgresErrorCodes.UniqueViolation` es la cadena `"23505"` (verificado contra Npgsql 10.0.3), y usar la constante es mejor que una cadena mágica. Filtra también por `ConstraintName`. Un bloque catch con solo `SqlState: "23505"` se tragará alegremente una colisión de clave primaria causada por una secuencia desincronizada y convertirá una señal de corrupción de datos en una respuesta silenciosa y equivocada.

El contexto nuevo importa, y es la razón por la que este patrón va de la mano con `IDbContextFactory<T>` en lugar de un `DbContext` con ámbito scoped. Si inyectas el contexto scoped y reintentas sobre él, vuelves a enviar la misma entidad `Added` y obtienes la misma excepción, que es el comportamiento que confirmé arriba en el change tracker. Lo mismo aplica si estás [resolviendo un DbContext desde un servicio singleton](/es/2026/08/how-to-use-idbcontextfactory-from-a-singleton-service-in-blazor/).

## Por qué EnableRetryOnFailure no hace nada aquí

Esto confunde a quienes ya agregaron resiliencia de conexión y suponen que cubre el caso. No lo cubre. Invoqué el detector propio del proveedor directamente por reflexión sobre `Npgsql.EntityFrameworkCore.PostgreSQL.Storage.Internal.NpgsqlTransientExceptionDetector` del proveedor 10.0.3:

```text
ShouldRetryOn(23505) = False     unique_violation
ShouldRetryOn(23503) = False     foreign_key_violation
ShouldRetryOn(40001) = True      serialization_failure
ShouldRetryOn(40P01) = True      deadlock_detected
ShouldRetryOn(53300) = True      too_many_connections
ShouldRetryOn(57P03) = True      cannot_connect_now
ShouldRetryOn(08006) = True      connection_failure
```

`PostgresException.IsTransient` coincide: `False` para `23505`, `True` para `40001` y `40P01`. Esa clasificación es correcta. Un reintento ciego de un duplicado genuino simplemente fallaría de nuevo, para siempre. Sí implica que el reintento tiene que ser tuyo, en el nivel donde puedes decidir qué significa un duplicado para esta operación. Si agregas tu propia estrategia de ejecución alrededor de una transacción manual, ten presente el error [la estrategia de ejecución no admite transacciones iniciadas por el usuario](/es/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/) con el que te vas a encontrar en el camino.

## Arreglo 3: un advisory lock, cuando el get-or-create abarca varias sentencias

A veces la operación de verdad no puede ser una sola sentencia: necesitas crear un tenant, después una fila de esquema, después una fila de configuración por defecto, y solo un llamador puede hacerlo. Serializa sobre una clave en lugar de sobre la tabla:

```csharp
// EF Core 10.0.4 / Npgsql 10.0.3
await using var tx = await db.Database.BeginTransactionAsync(ct);

// Held until the transaction commits or rolls back. No explicit unlock.
await db.Database.ExecuteSqlAsync(
    $"SELECT pg_advisory_xact_lock(hashtext({email}))", ct);

var existing = await db.Users.SingleOrDefaultAsync(u => u.Email == email, ct);
if (existing is not null) { await tx.CommitAsync(ct); return existing; }

db.Users.Add(new User { Email = email, Name = name });
await db.SaveChangesAsync(ct);
await tx.CommitAsync(ct);
```

`pg_advisory_xact_lock` se libera automáticamente al final de la transacción, que es justo la propiedad que quieres: ningún bloque `finally` puede filtrarlo. Dos advertencias. `hashtext` devuelve un valor de 32 bits, así que claves distintas pueden colisionar y serializarse entre sí sin necesidad, lo cual es un problema de rendimiento y nunca de corrección. Y esto solo funciona si todos los escritores toman el candado. Mantén el índice único de todas formas: es la red de seguridad para la ruta de código que se olvide.

## Variantes que parecen lo mismo pero no lo son

**El insert funciona solo y falla en lote.** EF Core agrupa varios inserts pendientes en un único viaje de ida y vuelta dentro de una transacción, así que un único duplicado en cualquier lugar del lote revierte todas las filas que agregaste. `DbUpdateException.Entries` te dice qué entidad rechazó el servidor; el resto queda intacto pero tampoco guardado. Si estás insertando miles de filas, esta es una de las razones para recurrir a otra ruta de escritura, que medí en [EF Core 11 vs Dapper para inserciones masivas](/es/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/).

**Los ids siguen saltando después de cada fallo.** Es lo esperado, y no se arregla. La [documentación de funciones de secuencia](https://www.postgresql.org/docs/current/functions-sequence.html) es inequívoca: "the value obtained by `nextval` is not reclaimed for re-use if the calling transaction later aborts." También menciona `ON CONFLICT` específicamente, porque la tupla incluida su llamada a `nextval` se calcula antes de detectar el conflicto. Cada intento duplicado quema un id. Si tus claves son visibles para el usuario y los huecos son inaceptables, la respuesta es otra estrategia de claves, no una secuencia sin huecos; consulta [generar una clave primaria a partir de una secuencia de base de datos](/es/2026/08/how-to-generate-a-primary-key-from-a-database-sequence-on-insert-in-ef-core-11/).

**Duplicados en una columna anulable que creías imposibles.** Un índice único estándar trata los valores `NULL` como distintos, así que cualquier cantidad de filas puede tener `NULL` ahí. Si de verdad quieres como máximo una, PostgreSQL 15 y posteriores admiten `CREATE UNIQUE INDEX ... ON "Users" ("ExternalId") NULLS NOT DISTINCT`. Ten en cuenta que el proveedor Npgsql 11.0 sube su objetivo mínimo por defecto a PostgreSQL 16, así que esto está disponible en cualquier servidor al que apunte por defecto el proveedor actual.

**`ON CONFLICT` falla con "there is no unique or exclusion constraint matching the ON CONFLICT specification".** El objetivo del conflicto es una inferencia de índice, no una lista de columnas. Si tu índice único es parcial (`WHERE "DeletedAt" IS NULL`), tienes que repetir el predicado: `ON CONFLICT ("Email") WHERE "DeletedAt" IS NULL DO NOTHING`. Como alternativa, nombra la restricción directamente con `ON CONFLICT ON CONSTRAINT "IX_Users_Email"`, lo que esquiva la inferencia por completo.

**Esto es una actualización concurrente, no un insert concurrente.** Si dos llamadores están modificando una fila existente en lugar de crear una, `23505` es la herramienta equivocada y lo que quieres es un token de concurrencia. Ese es un mecanismo distinto con una excepción distinta, cubierto en [concurrencia optimista con un token rowversion](/es/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/).

## Demostrarlo en una prueba

Una condición de carrera que solo aparece bajo carga de producción es una condición de carrera que no puedes cubrir con una prueba de regresión usando un proveedor en memoria de un solo hilo. Necesitas un servidor real y dos conexiones. Levanta un contenedor de Postgres, resuelve dos contextos desde `IDbContextFactory<T>`, y dispara ambos inserts contra la misma compuerta `TaskCompletionSource` para que compitan en el índice en el mismo instante. Si el handler es correcto, ambas tareas devuelven el mismo id y ninguna lanza excepción. Las ventajas y desventajas de ese montaje frente a un almacén de respaldo simulado están expuestas en [WebApplicationFactory vs Testcontainers](/es/2026/08/webapplicationfactory-vs-testcontainers-for-aspnetcore-integration-tests/).

El hábito que vale la pena formar es más pequeño que todo este código. Cuando captures una `DbUpdateException`, mira `SqlState` y `ConstraintName` antes de decidir qué significa. Un `23505` sobre un índice único que diseñaste tú es tu modelo de datos haciendo su trabajo y avisándote de que un llamador perdió una carrera. Un `23505` sobre una clave primaria suele ser la base de datos avisándote de que algo anda mal con la tabla misma.

## Relacionados

- [Cómo implementar concurrencia optimista con un token rowversion en EF Core 11](/es/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/)
- [Cómo generar una clave primaria a partir de una secuencia de base de datos al insertar en EF Core 11](/es/2026/08/how-to-generate-a-primary-key-from-a-database-sequence-on-insert-in-ef-core-11/)
- [Fix: The configured execution strategy does not support user-initiated transactions](/es/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/)
- [Cómo usar IDbContextFactory desde un servicio singleton en Blazor](/es/2026/08/how-to-use-idbcontextfactory-from-a-singleton-service-in-blazor/)
- [EF Core 11 vs Dapper para inserciones masivas: un benchmark real](/es/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/)

## Fuentes

- [PostgreSQL 18: Index Uniqueness Checks](https://www.postgresql.org/docs/current/index-unique-checks.html)
- [PostgreSQL 18: Serialization Failure Handling](https://www.postgresql.org/docs/current/mvcc-serialization-failure-handling.html)
- [PostgreSQL 18: INSERT, incluyendo ON CONFLICT y la inferencia de índices únicos](https://www.postgresql.org/docs/current/sql-insert.html)
- [PostgreSQL 18: Sequence Manipulation Functions](https://www.postgresql.org/docs/current/functions-sequence.html)
- [PostgreSQL Error Codes: Class 23 Integrity Constraint Violation](https://www.postgresql.org/docs/current/errcodes-appendix.html)
- [Notas de la versión 11.0 del proveedor Npgsql para EF Core](https://www.npgsql.org/efcore/release-notes/11.0.html)
- [EF Core: Connection resiliency](https://learn.microsoft.com/en-us/ef/core/miscellaneous/connection-resiliency)
