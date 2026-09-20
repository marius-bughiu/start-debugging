---
title: "Cómo garantizar el procesamiento idempotente de mensajes con EF Core 11 cuando dos instancias de la app consumen el mismo mensaje"
description: "La comprobación de existencia en tu handler no es la protección que crees. Pon un índice único en la tabla inbox, escribe el marcador en el mismo SaveChanges que el cambio de negocio, y deja que la base de datos elija al ganador. Más la trampa de ExecuteUpdate que deshace todo en silencio."
pubDate: 2026-09-20
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "concurrency"
  - "messaging"
  - "idempotency"
  - "sql-server"
  - "postgresql"
  - "dotnet-11"
  - "how-to"
lang: "es"
translationOf: "2026/09/how-to-guarantee-idempotent-message-processing-in-ef-core-11-with-an-inbox-table"
translatedBy: "claude"
translationDate: 2026-09-20
---

Respuesta corta: deja de confiar en `if (await db.Inbox.AnyAsync(...)) return;`. Dos instancias pueden ejecutar esa comprobación antes de que cualquiera de las dos confirme, y ambas procesarán el mensaje. En su lugar, dale a la tabla inbox un índice único sobre la clave de deduplicación, agrega la fila marcador al change tracker junto con el cambio de negocio, y deja que un solo `SaveChangesAsync` confirme ambos o ninguno. La instancia que pierde la carrera recibe una `DbUpdateException` cuya excepción interna es una violación de unicidad, lo que significa "alguien más ya hizo esto", así que confirma el mensaje y retorna. La base de datos, y no tu `if`, es lo que hace idempotente al handler.

Este artículo cubre la carrera en detalle, la solución en cuatro pasos con el SQL que EF Core 11 emite realmente, cómo distinguir un mensaje duplicado de una violación de restricción genuina, la variante en dos fases para efectos secundarios que no pueden unirse a una transacción de base de datos, y los tres errores que desactivan todo esto en silencio.

Una nota sobre versiones y verificación. EF Core 11 requiere el runtime de .NET 11 y se lanza junto con .NET 11 en noviembre de 2026, según la [página de versiones de EF Core](https://learn.microsoft.com/en-us/ef/core/what-is-new/). Todo lo que sigue se ejecutó con `Microsoft.EntityFrameworkCore` 11.0.0-rc.1.26425.128 sobre el SDK de .NET 11 RC 1. En esta máquina no hay SQL Server ni PostgreSQL, así que las ejecuciones de concurrencia van contra el proveedor de SQLite con dos conexiones al mismo archivo de base de datos, y la salida de SQL Server se produjo sin conexión con `GenerateCreateScript()` y un interceptor que suprime la conexión. Donde una afirmación depende de comportamiento del servidor que no pude ejecutar, lo digo y cito la documentación del proveedor en su lugar.

## Por qué la comprobación de existencia no es una protección

At-least-once es la garantía de entrega que te dan Azure Service Bus, RabbitMQ, Kafka y SQS. La página del [patrón Idempotent Consumer](https://learn.microsoft.com/en-us/azure/architecture/patterns/idempotent-consumer) de Microsoft enumera tres formas en que te llega un duplicado: el productor reintentó un envío cuya confirmación se perdió, el broker reentregó después de que expiró tu bloqueo, o tu proceso se cayó entre la escritura en la base de datos y la confirmación.

Ninguna de esas es exótica. El reinicio de un pod durante una implementación progresiva produce las tres. Y como corres más de una réplica, la reentrega no vuelve a la misma instancia; va al consumidor que esté libre, que puede estar procesando la copia original en ese preciso momento.

Este es el handler que casi todo el mundo escribe primero:

```csharp
// EF Core 11.0.0-rc.1, .NET 11. This is the version that does not work.
public async Task Handle(CreditRequested msg, CancellationToken ct)
{
    if (await db.Inbox.AnyAsync(m => m.MessageId == msg.MessageId && m.Consumer == "credit", ct))
        return;

    db.Credits.Add(new Credit { Amount = msg.Amount });
    db.Inbox.Add(new InboxMessage
    {
        MessageId = msg.MessageId,
        Consumer = "credit",
        ReceivedUtc = DateTime.UtcNow
    });

    await db.SaveChangesAsync(ct);
}
```

Dos instancias, un mismo id de mensaje, una brecha de 50 ms entre la comprobación y el guardado, y la tabla inbox con un índice simple no único:

```text
### 1. check-then-insert, no unique index, two concurrent consumers
  B: committed
  A: committed
  credits applied = 2, total = 200.0
  inbox rows = 2
```

Ambos lectores vieron un inbox vacío, ambos escribieron un marcador, ambos acreditaron la cuenta. La tabla de marcadores ahora miente activamente: dice que el mensaje se procesó, dos veces.

## La solución, en cuatro pasos

1. Dale a la tabla inbox un índice único sobre el id del mensaje más la identidad del consumidor, para que la base de datos pueda rechazar al segundo escritor.
2. Agrega la fila marcador y el cambio de negocio al mismo `DbContext` y confírmalos con un solo `SaveChangesAsync`, para que aterricen juntos o no aterricen.
3. Captura la `DbUpdateException` cuya excepción interna es una violación de unicidad sobre ese índice concreto, y trátala como "otra instancia ya procesó este mensaje".
4. Confirma el mensaje tanto en la ruta del commit como en la del duplicado capturado, y abandónalo solo ante una excepción no controlada.

### 1. Dale a la tabla inbox un índice único sobre la clave de deduplicación

La clave es la identidad del mensaje más la identidad del consumidor. La parte del consumidor importa cuando varios handlers independientes se suscriben al mismo canal: con la clave puesta solo sobre el mensaje, el primer handler que registra un marcador suprime a todos los demás.

```csharp
// EF Core 11.0.0-rc.1
public class InboxMessage
{
    public long Id { get; set; }               // surrogate, keeps the clustered index sequential
    public Guid MessageId { get; set; }
    public string Consumer { get; set; }
    public DateTime ReceivedUtc { get; set; }
    public DateTime? ProcessedUtc { get; set; }
}

protected override void OnModelCreating(ModelBuilder b)
{
    var inbox = b.Entity<InboxMessage>();
    inbox.HasKey(m => m.Id);
    inbox.Property(m => m.Consumer).HasMaxLength(200).IsRequired();
    inbox.HasIndex(m => new { m.MessageId, m.Consumer }).IsUnique();
}
```

`GenerateCreateScript()` sobre el proveedor de SQL Server da esto:

```sql
CREATE TABLE [Inbox] (
    [Id] bigint NOT NULL IDENTITY,
    [MessageId] uniqueidentifier NOT NULL,
    [Consumer] nvarchar(200) NOT NULL,
    [ReceivedUtc] datetime2 NOT NULL,
    [ProcessedUtc] datetime2 NULL,
    CONSTRAINT [PK_Inbox] PRIMARY KEY ([Id])
);
CREATE UNIQUE INDEX [IX_Inbox_MessageId_Consumer] ON [Inbox] ([MessageId], [Consumer]);
```

Resiste la tentación de hacer de `MessageId` la clave primaria. En SQL Server la clave primaria es clustered por defecto, y un índice clustered sobre un `uniqueidentifier` aleatorio fragmenta la tabla en cada inserción. Una clave `bigint IDENTITY` con la unicidad impuesta por un índice aparte mantiene las inserciones al final del montón. Esta es exactamente la forma que usa [MassTransit](https://masstransit.massient.com/documentation/configuration/middleware/outbox) para su propia entidad `InboxState`: un `long Id` descrito en el código fuente como "Primary key for table, to have ordered clustered index", con el par de deduplicación declarado mediante `HasAlternateKey(p => new { p.MessageId, p.ConsumerId })`.

### 2. Escribe el marcador en el mismo SaveChanges que el cambio de negocio

Ni antes ni después. La [documentación de transacciones de EF Core](https://learn.microsoft.com/en-us/ef/core/saving/transactions) es explícita: "todos los cambios de una única llamada a `SaveChanges` se aplican dentro de una transacción. Si alguno de los cambios falla, la transacción se revierte y ninguno de los cambios se aplica a la base de datos".

Lo comprobé con un `DbTransactionInterceptor`. Un solo `SaveChangesAsync` que actualiza una cuenta e inserta el marcador produce `BEGIN, COMMIT` alrededor de este par de sentencias en SQLite:

```sql
UPDATE "Accounts" SET "Balance" = @p0
WHERE "Id" = @p1
RETURNING 1;

INSERT INTO "Inbox" ("Consumer", "MessageId", "ProcessedUtc", "ReceivedUtc")
VALUES (@p0, @p1, @p2, @p3)
RETURNING "Id";
```

En SQL Server el mismo guardado envía:

```sql
SET IMPLICIT_TRANSACTIONS OFF;
SET NOCOUNT ON;
INSERT INTO [Inbox] ([Consumer], [MessageId], [ProcessedUtc], [ReceivedUtc])
OUTPUT INSERTED.[Id]
VALUES (@p0, @p1, @p2, @p3);
```

Para demostrar la parte de todo o nada en lugar de asumirla, puse en el mismo guardado una inserción condenada a fallar. El marcador nunca aterrizó:

```text
### 3. marker + business write in one SaveChanges: all or nothing
  SaveChanges threw SqliteException
  inbox rows after failure = 0 (marker rolled back with the business write)
```

Una advertencia que vale la pena conocer: el valor por defecto `AutoTransactionBehavior.WhenNeeded` significa que EF solo abre una transacción explícita cuando un guardado necesita más de una sentencia. Ese es el valor por defecto correcto, pero implica que la atomicidad de la que dependes viene de que EF decida que hace falta una transacción. Si configuras `AutoTransactionBehavior.Never`, la documentación advierte que "puede que comandos anteriores ya se hayan confirmado, dejando cambios parciales en la base de datos". No lo configures en un handler de mensajes.

### 3. Captura la violación de unicidad y trátala como "ya procesado"

Conserva la comprobación de existencia barata al inicio. Es una ruta rápida para el caso común en que la reentrega llega minutos después, y te ahorra una transacción revertida. Simplemente no es la garantía de correctitud. La garantía es el bloque catch:

```csharp
// EF Core 11.0.0-rc.1, SQL Server + PostgreSQL
try
{
    await db.SaveChangesAsync(ct);
}
catch (DbUpdateException ex) when (IsInboxDuplicate(ex))
{
    // another instance committed this message first; its transaction already
    // applied the business change, so there is nothing left to do
    return;
}

static bool IsInboxDuplicate(DbUpdateException ex) => ex.InnerException switch
{
    SqlException s => (s.Number == 2601 || s.Number == 2627)
                      && s.Message.Contains("IX_Inbox_MessageId_Consumer", StringComparison.Ordinal),
    PostgresException p => p.SqlState == PostgresErrorCodes.UniqueViolation
                           && p.ConstraintName == "IX_Inbox_MessageId_Consumer",
    _ => false
};
```

Al ejecutar el handler corregido contra la misma carrera de dos instancias:

```text
### 2. same handler, unique index on (MessageId, Consumer)
  A: committed
  B: DbUpdateException / SqliteException code=19 ext=2067
         inner message: SQLite Error 19: 'UNIQUE constraint failed: Inbox.MessageId, Inbox.Consumer'.
  credits applied = 1, total = 100.0
  inbox rows = 1
```

Un crédito, un marcador, y el perdedor se enteró de forma limpia.

### 4. Confirma el mensaje en ambas rutas

Tanto el commit como el duplicado capturado son resultados terminales: completa el mensaje. Solo una excepción no controlada debería abandonarlo para que el broker lo reentregue. Hacerlo al revés, abandonar ante el duplicado, produce un mensaje que rebota una y otra vez hasta acabar en la dead-letter queue.

## Qué hace la base de datos mientras ambas instancias insertan

El caso interesante no es el que muestra mi ejecución con SQLite, donde el perdedor falla de inmediato. Es aquel en que las dos inserciones se solapan: la instancia A insertó el marcador pero no ha confirmado, y la instancia B intenta insertar el mismo par.

La documentación de [comprobaciones de índices únicos](https://www.postgresql.org/docs/18/index-unique-checks.html) de PostgreSQL describe exactamente lo que ocurre: "Si una fila en conflicto fue insertada por una transacción aún no confirmada, quien intenta insertar debe esperar a ver si esa transacción confirma. Si se revierte, no hay conflicto. Si confirma sin borrar de nuevo la fila en conflicto, hay una violación de unicidad".

Ese bloqueo es la característica, no un problema que haya que ajustar hasta hacerlo desaparecer. B no conoce su destino hasta que la transacción de A se resuelve. Si A confirma, B recibe `23505` y puede omitir el mensaje con seguridad, sabiendo que el cambio de negocio es durable. Si A se revierte, porque el handler lanzó una excepción o el pod murió a mitad de la transacción, la inserción de B tiene éxito y B procesa el mensaje, que es exactamente lo que quieres. SQL Server se comporta igual bajo su aislamiento read-committed por defecto, reteniendo a B en el bloqueo de la clave del índice hasta que A se resuelva. Aquí no pude ejecutar ninguno de los dos servidores, así que toma esas dos frases como comportamiento documentado y no como algo que yo haya medido.

## Distinguir un mensaje duplicado de un error real

La comprobación `IsInboxDuplicate` de arriba coincide por el nombre del índice, y eso es deliberado. Un handler de mensajes que escribe filas de negocio suele escribir en tablas que tienen sus propias restricciones únicas: un número de pedido, una dirección de correo, una clave de idempotencia en un pago. Si tu bloque catch se traga toda violación de unicidad, un error de datos genuino en la escritura de negocio se le reporta al broker como "ya procesado" y el mensaje desaparece.

La ayuda que te da el proveedor varía. Usé reflexión sobre los tipos de excepción:

```text
### 10. does the provider exception name the constraint?
  SqliteException: SqliteErrorCode, SqliteExtendedErrorCode, SqlState
  SqlException: Errors, Number, SqlState
```

Npgsql es el generoso. `PostgresException` expone `SqlState`, `TableName`, `ColumnName` y `ConstraintName` (verificado en Npgsql 10.0.3), así que puedes identificar la restricción por nombre sin parsear cadenas. `SqlException` te da `Number` y nada más estructurado, así que terminas buscando el nombre del índice dentro del texto del mensaje. `SqliteException` te da `SqliteErrorCode` 19 y `SqliteExtendedErrorCode` 2067, con la lista de columnas solo en el mensaje.

Sobre los dos números de error de SQL Server: 2601 es "Cannot insert duplicate key row in object '%.\*ls' with unique index '%.\*ls'" y 2627 es "Violation of %ls constraint '%.\*ls'. Cannot insert duplicate key in object '%.\*ls'", según la [referencia de errores de replicación](https://learn.microsoft.com/en-us/previous-versions/SQL/SQL-server-2008/ms151779(v=sql.100)) de Microsoft. Cuál de los dos recibes depende de cómo declaraste la unicidad. `HasIndex(...).IsUnique()` emite `CREATE UNIQUE INDEX`, mientras que `HasAlternateKey(...)` emite una restricción de tabla:

```sql
CONSTRAINT [AK_Inbox_MessageId_Consumer] UNIQUE ([MessageId], [Consumer])
```

Captura ambos números y verifica el nombre, y no tendrás que preocuparte por cuál de los dos produjo tu modelo.

## Tres formas de romper esto en silencio

**`ExecuteUpdate` y `ExecuteDelete` no forman parte del guardado.** Emiten su propia sentencia de inmediato, fuera de cualquier transacción que `SaveChanges` abra después. Un handler que acredita una cuenta con `ExecuteUpdateAsync` y luego agrega el marcador del inbox no tiene atomicidad alguna:

```text
### 9. ExecuteUpdate commits on its own, before SaveChanges runs
  marker rejected as duplicate
  balance = 100 (the credit stuck even though the marker was rejected)
```

La detección de duplicados funcionó a la perfección y el dinero se movió igual. Si quieres el rendimiento de la actualización masiva, abre una transacción explícita con `BeginTransactionAsync`, ejecuta dentro de ella el `ExecuteUpdateAsync` y el `SaveChangesAsync`, y confirma una sola vez.

**Reintentar sobre el mismo `DbContext` reintenta la misma inserción condenada.** Tras un guardado fallido, el change tracker mantiene cada entidad en su estado previo al guardado:

```text
### 4. change-tracker state after a duplicate-key failure
  InboxMessage  state = Added
  Account       state = Modified
  retry on same context: threw again (SqliteException)
```

Cualquier reintento tiene que partir de un scope nuevo y un contexto nuevo. En la práctica eso significa que el reintento vive en el nivel del message pump, no dentro del handler.

**Una estrategia de ejecución con reintentos más una transacción explícita lanza una excepción.** En el momento en que recurres a `BeginTransactionAsync` para resolver el problema de `ExecuteUpdate` de arriba, `EnableRetryOnFailure` empieza a quejarse. Ese fallo tiene su propio artículo: [la estrategia de ejecución configurada no admite transacciones iniciadas por el usuario](/es/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/). La solución es `ExecuteAsync` sobre la estrategia, envolviendo toda la transacción para que el reintento la reproduzca completa.

## Efectos secundarios que no pueden unirse a la transacción

Enviar un correo, cobrar una tarjeta o escribir en blob storage no se pueden revertir junto con tu transacción de base de datos. El patrón que funciona es una reclamación en dos fases: inserta el marcador y confirma, luego haz el trabajo externo, y luego registra el resultado.

```csharp
// EF Core 11.0.0-rc.1
db.Inbox.Add(new InboxMessage { MessageId = msg.MessageId, Consumer = "email", ReceivedUtc = DateTime.UtcNow });
try
{
    await db.SaveChangesAsync(ct);          // phase 1: claim the message
}
catch (DbUpdateException ex) when (IsInboxDuplicate(ex))
{
    return;                                  // someone else owns this one
}

await emailer.SendAsync(msg, ct);            // the side effect, outside any transaction

await db.Inbox
    .Where(m => m.MessageId == msg.MessageId && m.Consumer == "email")
    .ExecuteUpdateAsync(s => s.SetProperty(m => m.ProcessedUtc, DateTime.UtcNow), ct);
```

Dos instancias concurrentes, una sola llamada externa:

```text
### 7. two-phase claim: insert marker, commit, then call the API
  A: won the claim, called the API, marked processed (rows=1)
  B: lost the claim, skipping the API call
  external API calls = 1
```

Fíjate en lo que esto te da y en lo que no. Elimina la llamada duplicada. No sobrevive a una caída entre el commit y el envío: te quedas con una fila reclamada cuyo `ProcessedUtc` es null y sin forma de saber si el correo salió. La guía de Microsoft es que un registro en curso "indica que un intento anterior podría haberse completado parcialmente", y que deberías reconciliar los registros obsoletos o derivarlos para intervención. La respuesta práctica es hacer idempotente también la llamada aguas abajo, enviando el mismo `MessageId` como clave de idempotencia del proveedor, y después dejar que un proceso de barrido reintente las reclamaciones más antiguas que cierto umbral.

## Elegir la clave, y la limpieza

La clave de deduplicación tiene que ser estable entre reentregas. El `MessageId` de Azure Service Bus y el par `source` más `id` de CloudEvents califican. `CorrelationId` no, porque identifica una conversación y varios mensajes la comparten. Tampoco los contadores de intentos de entrega ni las marcas de tiempo de recepción. En Kafka, donde no hay un id de mensaje asignado por el broker, la tripleta de topic, partición y offset es estable para un registro dado; una cabecera puesta por el productor es mejor, si la tienes.

La tabla inbox crece para siempre a menos que la purgues, y purgarla demasiado pronto vuelve a abrir la ventana. Conserva una fila por más tiempo del que el broker pueda seguir reentregando el original: eso es el tiempo de espera del bloqueo o de visibilidad multiplicado por el número máximo de entregas, más el time-to-live del mensaje, más un margen para los mensajes que un operador reenvía desde la dead-letter queue semanas después. Un `ExecuteDeleteAsync` nocturno sobre `ReceivedUtc < cutoff` basta, y es uno de los raros lugares donde que `ExecuteDelete` corra fuera de una transacción es exactamente lo que quieres.

Nada de esto es gratis de mantener, y por eso vale la pena saltarse el patrón cuando la operación ya es idempotente por naturaleza. Un upsert con clave sobre un identificador de negocio, o una escritura que fija un valor absoluto en lugar de aplicar un delta, no necesita inbox alguno. Si ya usas MassTransit, `AddInboxStateEntity()` y compañía te dan la misma maquinaria con un `DuplicateDetectionWindow` configurable y un servicio de entrega, en `MassTransit.EntityFrameworkCore` 9.2.2.

Hacerlo a mano son una tabla, un índice, un bloque catch y un trabajo de limpieza. La parte que la gente equivoca nunca es la tabla. Es creer que el `if` al inicio del handler estaba haciendo el trabajo.

### Lee a continuación

- [Fix: 23505: duplicate key value violates unique constraint en un insert concurrente de EF Core](/es/2026/08/fix-23505-duplicate-key-value-violates-unique-constraint-on-a-concurrent-ef-core-insert/)
- [Cómo implementar concurrencia optimista con un token rowversion en EF Core 11](/es/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/)
- [Cómo usar bloqueo pesimista con UPDLOCK y SELECT ... FOR UPDATE en EF Core 11](/es/2026/09/how-to-use-pessimistic-locking-with-updlock-and-select-for-update-in-ef-core-11/)
- [Fix: la estrategia de ejecución configurada no admite transacciones iniciadas por el usuario](/es/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/)
- [BackgroundService vs IHostedService vs Hangfire para tareas en segundo plano en .NET 11](/es/2026/06/backgroundservice-vs-ihostedservice-vs-hangfire-for-background-jobs-in-dotnet-11/)

### Fuentes

- [Patrón Idempotent Consumer](https://learn.microsoft.com/en-us/azure/architecture/patterns/idempotent-consumer), Azure Architecture Center
- [Transactions in EF Core](https://learn.microsoft.com/en-us/ef/core/saving/transactions), documentación de EF Core
- [What's New in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew), documentación de EF Core
- [PostgreSQL 18: Unique Index Checks](https://www.postgresql.org/docs/18/index-unique-checks.html)
- [Errores 2601 y 2627 en la referencia de errores de replicación](https://learn.microsoft.com/en-us/previous-versions/SQL/SQL-server-2008/ms151779(v=sql.100)), Microsoft Learn
- [Transactional Outbox configuration](https://masstransit.massient.com/documentation/configuration/middleware/outbox), documentación de MassTransit
- [`InboxState.cs`](https://github.com/MassTransit/MassTransit/blob/develop/src/Persistence/MassTransit.EntityFrameworkCoreIntegration/EntityFrameworkCoreIntegration/InboxState.cs), MassTransit
