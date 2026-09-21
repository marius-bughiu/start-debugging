---
title: "Cómo agregar elementos de forma atómica a un array jsonb de PostgreSQL con EF Core y Npgsql"
description: "Cargar una entidad, llamar a List.Add y guardar reescribe todo el documento jsonb y pierde en silencio los agregados concurrentes. Lleva el agregado a un único UPDATE con el operador jsonb ||, ya sea mediante ExecuteSqlAsync o con una función mapeada dentro de ExecuteUpdateAsync, y hazlo idempotente con una guarda @>."
pubDate: 2026-09-21
template: how-to
tags:
  - "ef-core"
  - "ef-core-10"
  - "postgresql"
  - "npgsql"
  - "json"
  - "concurrency"
  - "how-to"
lang: "es"
translationOf: "2026/09/how-to-atomically-append-to-a-postgresql-jsonb-array-with-ef-core-and-npgsql"
translatedBy: "claude"
translationDate: 2026-09-21
---

Respuesta corta: no cargues la fila, hagas `Add` a la lista y llames a `SaveChangesAsync`. EF Core envía el documento `jsonb` completo de vuelta como parámetro, así que dos solicitudes que agregan al mismo tiempo se sobrescriben entre sí. En su lugar, envía un único `UPDATE` que haga el agregado dentro de PostgreSQL: `SET "Data" = jsonb_set("Data", '{Labels}', COALESCE("Data"->'Labels', '[]') || to_jsonb(@label::text))`. Puedes emitirlo mediante `Database.ExecuteSqlAsync`, o mantenerlo en LINQ mapeando una pequeña función con `HasDbFunction` y llamándola dentro de `ExecuteUpdateAsync`, donde EF Core 10 escribe el `jsonb_set` por ti. Agrega `.Where(t => !t.Data.Labels.Contains(label))`, que Npgsql traduce a `@>`, y el agregado además se vuelve idempotente.

Todo lo que sigue se ejecutó en .NET 10 (SDK 10.0.302) con `Npgsql.EntityFrameworkCore.PostgreSQL` 10.0.3 (que trae EF Core 10.0.4), contra PostgreSQL 18.4. La columna JSON está mapeada como recomienda EF Core 10: un tipo complejo con `ToJson()`. Todo el SQL y todos los conteos citados aquí provienen de ejecuciones reales, no de reconstrucciones.

## Veinte agregados concurrentes, tres sobrevivientes

Este es el modelo. Un ticket tiene una columna `jsonb` que contiene etiquetas y un historial de eventos:

```csharp
// .NET 10, EF Core 10.0.4, Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3
public class Ticket
{
    public int Id { get; set; }
    public required string Title { get; set; }
    public required TicketData Data { get; set; }
}

public class TicketData
{
    public List<string> Labels { get; set; } = [];
    public List<TicketEvent> Events { get; set; } = [];
}

public class TicketEvent
{
    public required string Kind { get; set; }
    public DateTime At { get; set; }
}

public class AppDb : DbContext
{
    public DbSet<Ticket> Tickets => Set<Ticket>();

    protected override void OnModelCreating(ModelBuilder b)
        => b.Entity<Ticket>().ComplexProperty(t => t.Data, d => d.ToJson());
}
```

Npgsql crea `"Data" jsonb NOT NULL` para eso. Ahora, el código que la mayoría escribe primero, ejecutado desde 20 tareas en paralelo contra la misma fila, cada una con su propio `DbContext`:

```csharp
// .NET 10, EF Core 10.0.4 -- the lost-update version
await using var db = new AppDb();
var t = await db.Tickets.SingleAsync(x => x.Id == id);
t.Data.Labels.Add($"l{i}");
await db.SaveChangesAsync();
```

La fila empieza con una etiqueta, así que el resultado esperado es 21. Obtuve **3**, en tres de tres ejecuciones. La razón se ve en el SQL que envía `SaveChangesAsync`:

```sql
UPDATE "Tickets" SET "Data" = @p0
WHERE "Id" = @p1;
-- @p0='{"Labels":["hardware","urgent","via-savechanges"],"Events":[...]}'
```

EF Core no envía "agrega este elemento". Serializa el tipo complejo completo en memoria y reemplaza la columna con él. Cada tarea leyó el mismo documento inicial, agregó su propia etiqueta y escribió de vuelta un documento que no sabía nada de las otras 19. Gana el último en escribir, y la base de datos no tiene idea de que algo salió mal, porque desde su punto de vista cada `UPDATE` fue un reemplazo perfectamente válido.

Eso no es un bug de Npgsql. Es el problema común de la actualización perdida, y una columna JSON lo empeora más de lo habitual: con columnas escalares, dos solicitudes que cambian columnas *diferentes* no chocan, pero aquí cualquier cambio a una etiqueta o evento reescribe la única columna que los contiene a todos.

## Por qué un agregado dentro de la base de datos es atómico

El operador `jsonb || jsonb` de PostgreSQL concatena. Cuando el lado izquierdo es un array y el derecho es un escalar o un objeto, el lado derecho se agrega como un solo elemento:

```sql
SELECT '["a"]'::jsonb || to_jsonb('b'::text);     -- ["a", "b"]
SELECT '["a"]'::jsonb || '{"k": 1}'::jsonb;       -- ["a", {"k": 1}]
```

Lo importante no es el operador, sino de dónde viene el valor anterior. En `SET "Data" = ... "Data" || ...`, el `"Data"` del lado derecho es el valor actual de la fila en el momento en que se ejecuta el `UPDATE`. Con el aislamiento predeterminado `READ COMMITTED`, cuando dos transacciones actualizan la misma fila, la segunda se bloquea en el lock de la fila hasta que la primera confirma, luego vuelve a leer la versión *nueva* de la fila y reevalúa contra ella tanto su cláusula `WHERE` como sus expresiones `SET`. Así, cada agregado se construye sobre el anterior. Sin bucle de reintentos, sin columna de versión, sin ida y vuelta de lectura.

## Opción 1: un único UPDATE mediante ExecuteSqlAsync

La solución más directa es escribir la sentencia tú mismo:

```csharp
// .NET 10, EF Core 10.0.4, PostgreSQL 18.4
var label = "urgent";
await db.Database.ExecuteSqlAsync($$"""
    UPDATE "Tickets"
    SET "Data" = jsonb_set("Data", '{Labels}', COALESCE("Data"->'Labels', '[]'::jsonb) || to_jsonb({{label}}::text))
    WHERE "Id" = {{id}}
    """);
```

`ExecuteSqlAsync` recibe un `FormattableString`, así que `{{label}}` y `{{id}}` se convierten en parámetros reales (`@p0`, `@p1`), no en concatenación de cadenas. La cadena raw `$$` es intencional: permite que el literal de ruta jsonb `'{Labels}'` conserve sus llaves simples mientras `{{...}}` marca los huecos. Con las mismas 20 tareas en paralelo, esta versión termina con 21 etiquetas cada vez.

Cada una de tres piezas de esa sentencia existe por una razón:

- `jsonb_set(doc, '{Labels}', newArray)` reemplaza solo la clave `Labels` y conserva cualquier otra clave del documento tal como está *en este momento*, incluida una entrada de `Events` que otra solicitud agregó hace un milisegundo.
- `COALESCE("Data"->'Labels', '[]'::jsonb)` cubre las filas escritas antes de que existiera `Labels`. `NULL || anything` es `NULL`, y `jsonb_set` con un nuevo valor `NULL` devuelve `NULL` para todo el documento, lo que en una columna `NOT NULL` es un error y en una anulable es pérdida de datos.
- `::text` en el parámetro le da a `to_jsonb` un tipo concreto. Sin él, un literal que insertes tú mismo falla con `42804: could not determine polymorphic type because input has type unknown`.

Agregar un objeto, como un nuevo evento del historial, funciona igual. Serialízalo y conviértelo a `jsonb`:

```csharp
// .NET 10, EF Core 10.0.4, System.Text.Json
var ev = new TicketEvent { Kind = "escalated", At = DateTime.UtcNow };
var json = JsonSerializer.Serialize(ev);
await db.Database.ExecuteSqlAsync($$"""
    UPDATE "Tickets"
    SET "Data" = jsonb_set("Data", '{Events}', COALESCE("Data"->'Events', '[]'::jsonb) || jsonb_build_array({{json}}::jsonb))
    WHERE "Id" = {{id}}
    """);
```

El resultado fue `{"Events": [{"At": "2026-09-21T08:00:00Z", "Kind": "escalated"}], ...}`, y al leer el ticket de nuevo mediante EF, el evento se materializó con `DateTimeKind.Utc`. Usa los nombres de propiedad de EF en el JSON (aquí `Kind` y `At`, el valor predeterminado cuando no hay `HasJsonPropertyName` en el modelo), porque EF lee el documento por esas claves.

## Opción 2: quedarse en LINQ con una función mapeada y ExecuteUpdateAsync

El SQL crudo funciona, pero fija en el código nombres de tablas y columnas que de otro modo gestiona EF. EF Core 10 agregó soporte de `ExecuteUpdateAsync` para propiedades dentro de un tipo complejo `ToJson()`, así que lo natural es intentar esto:

```csharp
// Does NOT translate in EF Core 10.0.4 / Npgsql 10.0.3
await db.Tickets.Where(t => t.Id == id).ExecuteUpdateAsync(s =>
    s.SetProperty(t => t.Data.Labels, t => t.Data.Labels.Append("x").ToList()));
```

Falla con `The LINQ expression '...AsQueryable().Append("x")' could not be translated`, y la variante `Concat(new[] { "y" }).ToList()` falla con `does not represent a valid value`. Npgsql no traduce operadores de agregado de listas sobre una colección primitiva JSON dentro de un setter.

Lo que *sí* funciona es una función definida por el usuario cuyo tipo de retorno sea el tipo de la colección. EF permite ponerla en el lado derecho de `SetProperty` y la envuelve en el `jsonb_set` por sí mismo. Crea la función en una migración:

```csharp
// EF Core 10 migration
migrationBuilder.Sql("""
    CREATE OR REPLACE FUNCTION jsonb_append_text(arr jsonb, elem text)
    RETURNS jsonb LANGUAGE sql IMMUTABLE
    AS $$ SELECT COALESCE(NULLIF(arr, 'null'::jsonb), '[]'::jsonb) || to_jsonb(elem) $$;
    """);
```

Luego declara un stub en C# y mapéalo:

```csharp
// .NET 10, EF Core 10.0.4
public static class JsonbFn
{
    public static List<string> Append(List<string> array, string element)
        => throw new InvalidOperationException("Only usable in EF Core queries.");
}

// in OnModelCreating
b.HasDbFunction(typeof(JsonbFn).GetMethod(nameof(JsonbFn.Append))!)
    .HasName("jsonb_append_text");
```

El punto de llamada ahora es EF simple y tipado:

```csharp
await db.Tickets.Where(t => t.Id == id).ExecuteUpdateAsync(s =>
    s.SetProperty(t => t.Data.Labels, t => JsonbFn.Append(t.Data.Labels, label)));
```

y el SQL que genera EF es:

```sql
UPDATE "Tickets" AS t
SET "Data" = jsonb_set(t."Data", '{Labels}', COALESCE(to_jsonb(jsonb_append_text(t."Data" -> 'Labels', @label)), 'null'::jsonb))
WHERE t."Id" = @id
```

Veinte llamadores en paralelo, 21 etiquetas, en cada ejecución. El `to_jsonb(...)` extra alrededor de un valor que ya es `jsonb` no tiene efecto; EF lo agrega para cada propiedad JSON que asigna. El `NULLIF(arr, 'null'::jsonb)` de la función cubre un documento que contiene `"Labels": null` en lugar de no tener la clave. Sin él, `'null'::jsonb || '"x"'` produce silenciosamente `[null, "x"]`.

### Lo mismo sin migración: HasTranslation

Si no puedes agregar objetos a la base de datos, puedes hacer que EF emita funciones integradas. `jsonb_insert(array, '{-1}', element, true)` inserta después del último elemento, lo cual es un agregado:

```csharp
// .NET 10, EF Core 10.0.4, Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3
using System.Linq.Expressions;
using Microsoft.EntityFrameworkCore.Query.SqlExpressions;

b.HasDbFunction(typeof(JsonbFn).GetMethod(nameof(JsonbFn.Push))!)
    .HasTranslation(a =>
    {
        var jsonb = a[0].TypeMapping;
        var arr = new SqlFunctionExpression("COALESCE",
            [
                new SqlFunctionExpression("NULLIF", [a[0], new SqlFragmentExpression("'null'::jsonb")],
                    nullable: true, argumentsPropagateNullability: [false, false], typeof(string), jsonb),
                new SqlFragmentExpression("'[]'::jsonb"),
            ],
            nullable: false, argumentsPropagateNullability: [false, false], typeof(string), jsonb);
        var elem = new SqlFunctionExpression("to_jsonb",
            [new SqlUnaryExpression(ExpressionType.Convert, a[1], typeof(string), a[1].TypeMapping)],
            nullable: true, argumentsPropagateNullability: [true], typeof(string), jsonb);
        return new SqlFunctionExpression("jsonb_insert",
            [arr, new SqlFragmentExpression("'{-1}'"), elem, new SqlFragmentExpression("true")],
            nullable: true, argumentsPropagateNullability: [false, false, true, false],
            typeof(List<string>), jsonb);
    });
```

que produce:

```sql
SET "Data" = jsonb_set(t."Data", '{Labels}', jsonb_insert(COALESCE(NULLIF(t."Data" -> 'Labels', 'null'::jsonb), '[]'::jsonb), '{-1}', to_jsonb(@lbl::text), true))
```

Dos detalles de esa traducción surgieron de fallos, no de estilo. Mi primera versión envolvía el array directamente en `COALESCE(a[0], '[]')`, y el procesador de nulabilidad de EF eliminó el `COALESCE`, porque el modelo dice que `Labels` es una colección requerida y no anulable. Envolverlo primero en `NULLIF` hace que la expresión sea anulable, así que el `COALESCE` sobrevive, y de paso maneja el `null` de JSON. El nodo `Convert` es la conversión `::text`. Sin él, una llamada con una constante (`JsonbFn.Push(t.Data.Labels, "a")`) inserta `'a'` sin tipo y cae en el mismo error `42804` de antes. Con una variable capturada funcionaba de cualquier forma, que es justo el tipo de bug que pasa la revisión de código.

La ruta de la función en una migración requiere menos código y es más fácil de leer. Usa `HasTranslation` solo cuando agregar una función a la base de datos no sea una opción.

## Hacer que el agregado sea idempotente

Los reintentos, la entrega de mensajes al menos una vez y los botones con doble clic convierten "agregar" en "agregar dos veces". Pon la guarda en la misma sentencia:

```csharp
// .NET 10, EF Core 10.0.4
var n = await db.Tickets
    .Where(t => t.Id == id && !t.Data.Labels.Contains(label))
    .ExecuteUpdateAsync(s => s.SetProperty(t => t.Data.Labels, t => JsonbFn.Push(t.Data.Labels, label)));
// n == 1 when the label was added, 0 when it was already there
```

Npgsql traduce `Contains` sobre una colección primitiva JSON al operador de contención:

```sql
WHERE t."Id" = @id AND NOT ((t."Data" -> 'Labels') @> to_jsonb(@l))
```

Como PostgreSQL reevalúa la cláusula `WHERE` después de esperar el lock de la fila, esto se sostiene bajo concurrencia, no solo de forma secuencial. Veinte tareas en paralelo agregando `"dup"` produjeron en total exactamente una fila afectada y `["hardware", "dup"]`, en cada ejecución. El conteo de filas afectadas también es tu respuesta a "¿lo agregué?", sin una segunda consulta. Si necesitas semántica de conjunto entre filas *diferentes*, por ejemplo "no hay dos tickets que compartan un id externo", eso corresponde a un índice único, no a un array JSON.

## Cuando realmente necesitas leer, modificar y escribir

A veces el nuevo elemento depende de los existentes, por ejemplo "agregar a menos que el último evento ya sea `closed`", y esa lógica no encaja bien en SQL. En ese caso conserva `SaveChangesAsync`, pero haz que las actualizaciones perdidas sean detectables con un token de concurrencia optimista. En PostgreSQL, la columna de sistema `xmin` cambia en cada actualización, y Npgsql la mapea con una propiedad `uint` marcada con `[Timestamp]`:

```csharp
// .NET 10, Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3
public class Ticket
{
    public int Id { get; set; }
    public required TicketData Data { get; set; }

    [Timestamp]
    public uint Version { get; set; }   // mapped to xmin, no migration column
}
```

Ahora una escritura obsoleta lanza `DbUpdateConcurrencyException` en lugar de ganar en silencio, y reintentas recargando. Con los mismos 20 agregadores en paralelo y un bucle de recarga y reintento, las 21 etiquetas llegaron, a costa de **167** conflictos y reintentos. Ese número es la razón por la que el agregado dentro de la base de datos es la recomendación predeterminada. La concurrencia optimista es correcta, pero con contención sobre una fila muy disputada se convierte en una tormenta de reintentos.

## Detalles a conocer antes de producción

- **`ExecuteSqlRawAsync` y `SqlQueryRaw` tratan las llaves como huecos de formato, incluso con cero parámetros.** `ExecuteSqlRawAsync("... jsonb_set(\"Data\", '{Labels}', ...)")` lanza `FormatException: Input string was not in a correct format` antes de que nada llegue a PostgreSQL. Duplica las llaves (`'{{Labels}}'`) o usa el `ExecuteSqlAsync` interpolado con una cadena raw `$$` como se mostró arriba.
- **Agregar un array agrega sus elementos, no el array.** `'["a"]' || '["b"]'` es `["a", "b"]`. Si el elemento que agregas puede ser a su vez un array, envuélvelo: `|| jsonb_build_array(@x::jsonb)`.
- **`to_jsonb` de una cadena JSON te da una cadena.** `'["a"]' || to_jsonb('{"k":1}'::text)` agrega el *texto* `"{\"k\":1}"`. Los objetos serializados necesitan `::jsonb`, no `to_jsonb`.
- **`jsonb_set` no crea los padres que faltan.** `jsonb_set('{}', '{A,B}', '[1]')` devuelve `{}` sin cambios. Para una ruta anidada, asegúrate de que el objeto padre exista, o constrúyelo con `jsonb_set` un nivel a la vez.
- **Las colecciones complejas no pueden ser el tipo de retorno de una función mapeada.** Mapear `List<TicketEvent> PushEvent(List<TicketEvent>, string)` falla al construir el modelo con `The DbFunction 'JsonbFn.PushEvent(...)' has an invalid return type 'List<TicketEvent>'`. Para arrays de objetos, usa la Opción 1.
- **El orden es el orden de confirmación, no el orden de llamada.** Los agregados concurrentes quedan en el orden en que se confirman sus transacciones, así que `l11` puede ir antes que `l10`. Si el orden importa, agrega una marca de tiempo o un número de secuencia y ordena al leer.
- **Vigila el tamaño del documento.** Cada agregado reescribe todo el valor `jsonb` en disco (PostgreSQL no tiene actualización de JSON en el lugar, y los valores grandes pasan por TOAST). Un historial que crece sin límite merece su propia tabla.
- **Los tipos owned no tienen esto.** El soporte de `ExecuteUpdate` para JSON en EF Core requiere `ComplexProperty(...).ToJson()`. Si todavía usas `OwnsOne(...).ToJson()`, solo aplica la Opción 1.

### Lecturas recomendadas

- [Cómo mapear y consultar columnas JSON en EF Core 11](/es/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) cubre el mapeo `ToJson()` sobre el que se construye este artículo.
- [Tipos complejos vs entidades owned en EF Core 11](/es/2026/07/complex-types-vs-owned-entities-in-ef-core-11/) explica por qué `ExecuteUpdate` sobre JSON solo funciona con tipos complejos.
- [Cómo usar ExecuteUpdate y ExecuteDelete para escrituras masivas en EF Core 11](/es/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) profundiza en las actualizaciones basadas en conjuntos, incluidos sus puntos ciegos respecto al change tracker.
- [EF Core ExecuteUpdate vs cargar entidades y SaveChanges](/es/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) compara las dos rutas de escritura en general.
- [Cómo implementar concurrencia optimista con un token rowversion en EF Core 11](/es/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/) es la contraparte en SQL Server del enfoque con `xmin` de arriba.

### Fuentes

- [JSON Functions and Operators](https://www.postgresql.org/docs/current/functions-json.html), documentación de PostgreSQL (`||`, `@>`, `jsonb_set`, `jsonb_insert`)
- [Transaction Isolation: Read Committed](https://www.postgresql.org/docs/current/transaction-iso.html#XACT-READ-COMMITTED), documentación de PostgreSQL
- [JSON Mapping](https://www.npgsql.org/efcore/mapping/json.html), documentación del proveedor Npgsql para EF Core
- [Concurrency Tokens](https://www.npgsql.org/efcore/modeling/concurrency.html), documentación del proveedor Npgsql para EF Core (`xmin`)
- [What's New in EF Core 10: ExecuteUpdate support for relational JSON columns](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew#executeupdate-support-for-relational-json-columns), Microsoft Learn
- [User-defined function mapping](https://learn.microsoft.com/en-us/ef/core/querying/user-defined-function-mapping), documentación de EF Core
- [`NpgsqlQuerySqlGenerator.cs` at `v10.0.3`](https://github.com/npgsql/efcore.pg/blob/v10.0.3/src/EFCore.PG/Query/Internal/NpgsqlQuerySqlGenerator.cs), npgsql/efcore.pg
