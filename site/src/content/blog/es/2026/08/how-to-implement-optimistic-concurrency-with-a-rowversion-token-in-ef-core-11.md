---
title: "Cómo implementar concurrencia optimista con un token rowversion en EF Core 11"
description: "Agrega un token de concurrencia rowversion en EF Core 11: la configuración con [Timestamp] e IsRowVersion, el SQL que EF realmente emite, cómo capturar DbUpdateConcurrencyException, gana la base de datos vs gana el cliente vs fusión, APIs desconectadas con ETags y las cinco trampas que lo desactivan en silencio."
pubDate: 2026-08-03
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "concurrency"
  - "rowversion"
  - "sql-server"
  - "dotnet-11"
  - "how-to"
lang: "es"
translationOf: "2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-08-03
---

Respuesta corta: agrega una propiedad `byte[]` a la entidad, márcala con `[Timestamp]` (o llama a `.IsRowVersion()` en `OnModelCreating`), y EF Core 11 la mapea a una columna `rowversion` de SQL Server y agrega `AND [RowVersion] = @original` a cada UPDATE y DELETE que genera para esa entidad. Cuando otra persona modificó la fila mientras tanto, la sentencia afecta cero filas y `SaveChangesAsync` lanza `DbUpdateConcurrencyException`, que tú capturas y resuelves. Toda la característica son unas seis líneas de configuración. Lo difícil son las cinco formas de desactivarla accidentalmente sin recibir ningún error.

Este artículo cubre la configuración, el SQL y el texto exacto de la excepción, las tres estrategias de resolución, el viaje de ida y vuelta desconectado de una API web que la mayoría de los tutoriales omite, y las trampas que te dejan con un token que no protege nada.

Una nota sobre cómo se verificaron los detalles a continuación. EF Core 11 requiere el runtime de .NET 11, y el único SDK en esta máquina es .NET 10.0.201, así que los experimentos ejecutables se hicieron con `Microsoft.EntityFrameworkCore` 10.0.10 contra SQLite, más el generador de DDL del proveedor de SQL Server (que funciona sin conexión, sin un servidor). La API del token de concurrencia y la forma del SQL que genera no cambian entre EF Core 8 y 11: las [notas de la versión de EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) no listan cambios en los tokens de concurrencia, la detección de conflictos de `SaveChanges` ni `DbUpdateConcurrencyException`. Todo lo específico de EF Core 11 se señala explícitamente.

## Qué es realmente una columna rowversion

`rowversion` es un tipo de dato de SQL Server, no un concepto de EF Core. Según la [documentación de rowversion](https://learn.microsoft.com/en-us/sql/t-sql/data-types/rowversion-transact-sql), son 8 bytes de datos binarios únicos generados automáticamente. Tres propiedades importan para trabajar con concurrencia:

- **Es un contador, no un reloj.** No preserva ninguna fecha ni hora. Cada base de datos tiene un único contador que se incrementa ante cualquier inserción o actualización sobre cualquier tabla que contenga una columna `rowversion`. Dos filas de tablas distintas nunca pueden compartir un valor, pero no puedes restar dos valores y obtener un tiempo transcurrido.
- **Una tabla puede tener exactamente una.** Por eso un token rowversion protege la fila completa, nunca un subconjunto de columnas.
- **Cualquier UPDATE lo incrementa, incluso uno sin efecto.** La documentación es explícita: asignar a una columna el valor que ya tiene cuenta como actualización e incrementa la versión. Un "guardado" que no cambia nada igualmente invalida el token de todos los demás lectores.

`timestamp` es un sinónimo obsoleto del mismo tipo. Usa `rowversion` en el DDL. Confusamente, el atributo de EF Core sigue llamándose `[Timestamp]`, porque es anterior al cambio de nombre.

## La configuración, en cuatro pasos

1. **Agrega una propiedad `byte[]` a la entidad.** El tipo CLR tiene que ser `byte[]` para que el proveedor de SQL Server la mapee a `rowversion`. Ponle el nombre que quieras; `RowVersion` y `Version` son las opciones habituales.
2. **Márcala como versión de fila.** Con `[Timestamp]` como anotación de datos, o con `.Property(p => p.RowVersion).IsRowVersion()` en `OnModelCreating`. Ambas son equivalentes.
3. **Agrega una migración y aplícala.** EF emite `[RowVersion] rowversion NOT NULL`, y SQL Server rellena cada fila existente en su siguiente actualización.
4. **Captura `DbUpdateConcurrencyException` en cada punto de llamada que guarde esa entidad.** Sin este paso solo cambiaste una actualización perdida silenciosa por una respuesta 500, lo cual es mejor pero no por mucho.

Aquí está la entidad, de las dos formas:

```csharp
// .NET 11, C# 14, Microsoft.EntityFrameworkCore.SqlServer 11.0.0
public class Product
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public decimal Price { get; set; }

    [Timestamp]
    public byte[] RowVersion { get; set; } = default!;
}
```

```csharp
// Fluent equivalent, no attribute needed on the entity
protected override void OnModelCreating(ModelBuilder modelBuilder)
    => modelBuilder.Entity<Product>()
        .Property(p => p.RowVersion)
        .IsRowVersion();
```

Ejecutar el generador de scripts de creación del proveedor de SQL Server sobre ese modelo produce:

```sql
CREATE TABLE [Products] (
    [Id] int NOT NULL IDENTITY,
    [Name] nvarchar(max) NOT NULL,
    [Price] decimal(18,2) NOT NULL,
    [RowVersion] rowversion NOT NULL,
    CONSTRAINT [PK_Products] PRIMARY KEY ([Id])
);
```

Lo interesante no es el DDL, son los metadatos del modelo que EF deriva de él. Volcar `IProperty` para esa columna da `colType=rowversion`, `IsConcurrencyToken=True`, `ValueGenerated=OnAddOrUpdate`. Esa última bandera es la que hay que recordar: EF Core nunca escribirá un valor en esta columna. La excluye de INSERT y UPDATE, y lee el nuevo valor después. La base de datos es dueña total de ella.

## El SQL que emite EF Core, y la excepción cuando falla

Una vez que la propiedad es un token de concurrencia, cada UPDATE que EF genera para la entidad lleva el valor original en su cláusula `WHERE` junto a la clave. En SQLite con un token gestionado por la aplicación, la forma es exactamente esta (capturada con `LogTo` filtrado a `RelationalEventId.CommandExecuted`):

```sql
UPDATE "Products" SET "Price" = @p0, "Version" = @p1
WHERE "Id" = @p2 AND "Version" = @p3
RETURNING 1;
```

En SQL Server la sentencia además tiene que releer el `rowversion` regenerado, ya que la columna es `ValueGenerated.OnAddOrUpdate`. La forma documentada en el [tutorial de concurrencia con Razor Pages](https://learn.microsoft.com/en-us/aspnet/core/data/ef-rp/concurrency) combina el UPDATE protegido con un SELECT condicionado por `@@ROWCOUNT`:

```sql
SET NOCOUNT ON;
UPDATE [Products] SET [Price] = @p0
WHERE [Id] = @p1 AND [RowVersion] = @p2;
SELECT [RowVersion]
FROM [Products]
WHERE @@ROWCOUNT = 1 AND [Id] = @p1;
```

La forma exacta de la sentencia ha cambiado entre versiones de EF Core y entre proveedores, y seguirá cambiando. Lo que sí es estable, y lo que deberías verificar en una prueba, es la semántica: el token aparece en el `WHERE`, y un resultado de cero filas se convierte en una excepción.

Si otra persona modificó la fila después de que la cargaste, el predicado no encuentra nada, vuelven cero filas y EF lanza la excepción. Vale la pena memorizar el mensaje porque es lo que vas a buscar en tus registros:

```text
The database operation was expected to affect 1 row(s), but actually affected
0 row(s); data may have been modified or deleted since entities were loaded.
```

Dos cosas que la gente entiende mal sobre cuándo se dispara. Primero, se lanza en actualizaciones *y* eliminaciones, pero prácticamente nunca en inserciones. Una inserción duplicada produce en su lugar una excepción de restricción única específica del proveedor. Segundo, "afectó 0 filas" no distingue entre "alguien la cambió" y "alguien la eliminó". Eso tienes que averiguarlo durante la resolución.

Si el SQL de arriba no se parece a lo que tu aplicación está enviando, la forma más rápida de descubrir qué *sí* está enviando es [registrar el SQL que genera EF Core 11](/es/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) y leer la cláusula `WHERE` directamente. Un `AND [RowVersion] = ...` ausente significa que el token no está configurado en la ruta que crees.

## Resolver el conflicto: tres estrategias, un bucle

`DbUpdateConcurrencyException` expone `Entries`, la lista de objetos `EntityEntry` cuyos comandos devolvieron un número de filas incorrecto. Cada entrada te da tres conjuntos de valores:

- `CurrentValues`: lo que intentaste escribir.
- `OriginalValues`: lo que leíste, antes de tus ediciones. Aquí vive el token obsoleto.
- `GetDatabaseValuesAsync()`: lo que hay en la base de datos ahora mismo, consultado de nuevo.

Cada estrategia de resolución es una regla para combinar esos tres, seguida de refrescar `OriginalValues` para que la cláusula `WHERE` del reintento use el token actual.

**Gana la base de datos** es la más simple y el valor por omisión correcto para cualquier cosa que un humano esté mirando: descarta el intento, recarga, avisa al usuario. `entry.ReloadAsync()` lo hace en una sola llamada.

**Gana el cliente** sobrescribe lo que haya aterrizado en el medio. Correcto solo cuando tu escritura es autoritativa (una anulación administrativa, la reproducción de un evento canónico), y un verdadero error en todos los demás casos:

```csharp
// .NET 11, C# 14, EF Core 11
catch (DbUpdateConcurrencyException ex)
{
    foreach (var entry in ex.Entries)
    {
        var databaseValues = await entry.GetDatabaseValuesAsync();
        if (databaseValues is null)
        {
            // The row is gone. There is nothing to overwrite.
            throw new InvalidOperationException("Product was deleted by another user.");
        }

        // Keep CurrentValues as-is, but adopt the database's token so the
        // retried UPDATE targets the row as it exists now.
        entry.OriginalValues.SetValues(databaseValues);
    }

    await context.SaveChangesAsync();
}
```

**Fusión** es la versión que vale la pena escribir cuando la entidad tiene campos independientes. Toma el valor de la base de datos para cualquier propiedad que no tocaste, conserva el tuyo para las que sí, y escala solo ante un solapamiento real:

```csharp
// .NET 11, C# 14, EF Core 11
var saved = false;
while (!saved)
{
    try
    {
        await context.SaveChangesAsync();
        saved = true;
    }
    catch (DbUpdateConcurrencyException ex)
    {
        foreach (var entry in ex.Entries)
        {
            if (entry.Entity is not Product)
            {
                throw new NotSupportedException(
                    $"No conflict policy for {entry.Metadata.Name}.");
            }

            var proposed = entry.CurrentValues;
            var database = await entry.GetDatabaseValuesAsync()
                ?? throw new InvalidOperationException("Row was deleted.");
            var original = entry.OriginalValues;

            foreach (var property in proposed.Properties)
            {
                // Skip the token itself: it is byte[], so Equals compares
                // references, and it is refreshed wholesale below anyway.
                if (property.IsConcurrencyToken) continue;

                var mine = proposed[property];
                var theirs = database[property];
                var wasLoaded = original[property];

                // I did not touch this column: take theirs.
                if (Equals(mine, wasLoaded))
                {
                    proposed[property] = theirs;
                }
                // Both of us changed it to different values: real conflict.
                else if (!Equals(theirs, wasLoaded) && !Equals(mine, theirs))
                {
                    throw new InvalidOperationException(
                        $"Conflicting edits to {property.Name}.");
                }
            }

            entry.OriginalValues.SetValues(database);
        }
    }
}
```

Ese bucle `while (!saved)` es la forma que recomienda la [documentación de concurrencia de EF Core](https://learn.microsoft.com/en-us/ef/core/saving/concurrency), y es un bucle de verdad: tu reintento puede perder la carrera una segunda vez. Ponle un número máximo de intentos en producción, porque un reintento sin límite contra una fila muy solicitada es un livelock.

Una interacción a vigilar: si habilitaste `EnableRetryOnFailure`, el reintento ocurre dentro de un `SqlServerRetryingExecutionStrategy`, y envolver este bucle en un `BeginTransaction` manual fallará con el error descrito en [la estrategia de ejecución no admite transacciones iniciadas por el usuario](/es/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/). Usa `strategy.ExecuteAsync(...)` alrededor de toda la unidad de trabajo en su lugar.

## El viaje de ida y vuelta desconectado, que es donde esto suele fallar

El ejemplo de un solo contexto de arriba no es lo que hace tu API. Tu API carga un producto en una solicitud, se lo entrega a un navegador y recibe una edición diez minutos después en un `DbContext` completamente distinto. El token tiene que sobrevivir a ese viaje.

`byte[]` se serializa a base64 en `System.Text.Json`, así que pasarlo por un DTO funciona sin ningún tratamiento especial. La forma HTTP idiomática es un ETag: devuelve el token en base64 como encabezado de respuesta `ETag` en el GET, exígelo como `If-Match` en el PUT, y responde `412 Precondition Failed` cuando no coincida.

En el lado de escritura, la línea crucial es asignar `OriginalValue` explícitamente. EF no tiene forma de saber cómo lucía la fila cuando el cliente la leyó, así que tienes que decírselo:

```csharp
// .NET 11, C# 14, EF Core 11
app.MapPut("/products/{id:int}", async (
    int id, ProductDto dto, [FromHeader(Name = "If-Match")] string? ifMatch,
    AppDbContext db) =>
{
    if (string.IsNullOrEmpty(ifMatch)) return Results.BadRequest("If-Match required.");

    var product = await db.Products.FindAsync(id);
    if (product is null) return Results.NotFound();

    product.Name = dto.Name;
    product.Price = dto.Price;

    // Overwrite the token EF loaded with the one the client actually saw.
    db.Entry(product).Property(p => p.RowVersion).OriginalValue =
        Convert.FromBase64String(ifMatch.Trim('"'));

    try
    {
        await db.SaveChangesAsync();
        return Results.Ok(new { eTag = Convert.ToBase64String(product.RowVersion) });
    }
    catch (DbUpdateConcurrencyException)
    {
        return Results.StatusCode(StatusCodes.Status412PreconditionFailed);
    }
});
```

Nota que esto consulta la fila primero de forma deliberada. Puedes saltarte la consulta con `Attach` más `EntityState.Modified`, que es un viaje menos, pero entonces se escribe cada columna haya cambiado o no. Verifiqué que ambas rutas se comportan igual respecto al token: en la reproducción con SQLite, asignar `OriginalValue` sobre una entidad adjuntada y nunca consultada produjo la misma cláusula `WHERE` protegida por el token que la ruta que consulta primero, y guardó sin problemas.

## Cinco formas de desactivar en silencio tu token de concurrencia

**Olvidar arrastrar el token original.** Si llega una entidad desconectada con un token por omisión o vacío y llamas a `context.Update(entity)`, EF toma el valor que está *en el objeto* como el original. El SQL emitido queda `WHERE "Id" = @p3 AND "Version" = @p4` con un `@p4` todo en ceros, que no coincide con nada, y absolutamente cada guardado lanza `DbUpdateConcurrencyException`. Reproduje exactamente esto en EF Core 10.0.10. El modo de fallo es ruidoso, lo cual es una suerte, porque el error opuesto es silencioso.

**Usar un proveedor que no tiene rowversion.** Este no da ningún error. En SQLite, `[Timestamp]` sobre un `byte[]` produce una columna `BLOB NULL` marcada como `IsConcurrencyToken=True`, `ValueGenerated=OnAddOrUpdate`. Por lo tanto EF nunca la escribe, SQLite nunca la genera, y el valor se queda en `null` para siempre. El UPDATE generado degenera en:

```sql
UPDATE "Products" SET "Price" = @p0
WHERE "Id" = @p1 AND "RowVersion" IS NULL
RETURNING "RowVersion";
```

`IS NULL` coincide siempre. Obtienes una columna con forma de token, cero protección y ninguna advertencia. Verificado en EF Core 10.0.10 con `Microsoft.EntityFrameworkCore.Sqlite`. Si tus pruebas de integración corren sobre SQLite mientras producción corre sobre SQL Server, tus pruebas de concurrencia están pasando por la razón equivocada.

La solución para proveedores sin una columna nativa que se actualice sola es un token gestionado por la aplicación: un `Guid` marcado con `[ConcurrencyCheck]` (o `.IsConcurrencyToken()`), que tú mismo asignas en cada guardado. PostgreSQL es la excepción que no necesita ninguno de los dos: Npgsql mapea una propiedad `uint` marcada con `[Timestamp]` o configurada con `.IsRowVersion()` sobre la columna de sistema `xmin`, que el motor actualiza automáticamente.

**Poner `[Timestamp]` sobre el tipo CLR equivocado.** EF Core no valida esto al construir el modelo. Puse `[Timestamp]` sobre un `long` y el proveedor de SQL Server emitió alegremente `[RowVersion] bigint NOT NULL` con `IsConcurrencyToken=True` y `ValueGenerated=OnAddOrUpdate`. SQL Server no mantiene columnas `bigint` normales, y a EF se le dijo que no las escriba, así que nada mueve nunca ese valor. Solo `byte[]` se mapea al tipo `rowversion` real.

**Escribir a través de `ExecuteUpdate` o `ExecuteDelete`.** Estos evitan por completo el seguimiento de cambios, y con él la comprobación de concurrencia. El SQL que emiten contiene solo tu predicado:

```sql
UPDATE "Products" AS "p"
SET "Price" = ef_add("p"."Price", '1.0')
WHERE "p"."Name" = 'B'
```

Sin token, sin excepción, una fila afectada. Si quieres concurrencia optimista en una ruta masiva tienes que hacerlo a mano: pon el token en el `Where` y compara el número de filas afectadas devuelto con el que esperabas. Ese compromiso, y cuándo cada ruta de escritura es la correcta, es el tema de [ExecuteUpdate vs cargar entidades y SaveChanges](/es/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/).

**Comparar tokens con `==` en C#.** `byte[]` usa igualdad por referencia. Dos arreglos con bytes idénticos no son iguales. Usa `SequenceEqual`, o compara las cadenas base64, siempre que necesites verificar un token en código de aplicación. EF compara en SQL, así que esto solo muerde en tu propia lógica de validación.

## Cuándo un token a nivel de fila es demasiado grueso

Un `rowversion` protege la fila entera. Dos usuarios editando campos genuinamente independientes del mismo registro (uno corrige un error de tipeo en la descripción, el otro ajusta el conteo de existencias) chocan, aunque nada esté realmente en conflicto. En un registro muy solicitado eso es un flujo constante de 412 espurios.

Dos salidas. Usa la estrategia de fusión de arriba para que los conflictos falsos se resuelvan automáticamente y solo emerjan los solapamientos reales. O baja a un token gestionado por la aplicación que regeneras solo cuando cambian las propiedades que te importan, algo que puedes centralizar en un interceptor de `SaveChanges` del tipo descrito en [interceptores de EF Core 11 para auditoría](/es/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/). El costo de la segunda opción es que ahora eres dueño de la decisión "¿este cambio importa?", para siempre, para cada propiedad que agregues.

La alternativa de más alto nivel es un nivel de aislamiento de transacción. Snapshot en SQL Server, o repeatable read en PostgreSQL, levantará un error de serialización cuando la escritura de tu transacción entre en conflicto con una ya confirmada, sin ningún token en el modelo. Es más simple, y es la herramienta equivocada en el momento en que hay un humano en el bucle, porque la transacción tendría que quedar abierta durante el tiempo de reflexión del usuario. Los tokens de concurrencia existen precisamente para que la "transacción" pueda abarcar un viaje HTTP de ida y vuelta y una pausa para el café.

## Relacionado

- [ExecuteUpdate vs cargar entidades y SaveChanges en EF Core](/es/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/)
- [Cómo registrar el SQL que genera EF Core 11](/es/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [Cómo usar interceptores de EF Core 11 para auditoría](/es/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/)
- [Fix: la estrategia de ejecución no admite transacciones iniciadas por el usuario](/es/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/)
- [Fix: la instancia del tipo de entidad no puede rastrearse porque ya se está rastreando otra instancia con el mismo valor de clave](/es/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/)

## Fuentes

- [Handling concurrency conflicts](https://learn.microsoft.com/en-us/ef/core/saving/concurrency) en Microsoft Learn, para la semántica del token, los tres conjuntos de valores y el bucle de reintento.
- [rowversion (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/data-types/rowversion-transact-sql) para el contador de 8 bytes, la regla de uno por tabla, el comportamiento del UPDATE sin efecto y la obsolescencia de `timestamp`.
- [Disconnected entities](https://learn.microsoft.com/en-us/ef/core/saving/disconnected-entities) para `Update` frente a `Attach` y `CurrentValues.SetValues`.
- [What's new in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew), que confirma que EF11 requiere el runtime de .NET 11 y no lista cambios en los tokens de concurrencia.
- [Npgsql concurrency tokens](https://www.npgsql.org/efcore/modeling/concurrency.html) para el mapeo de `xmin` en PostgreSQL.
