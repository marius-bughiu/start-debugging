---
title: "Cómo generar una clave primaria desde una secuencia de base de datos al insertar en EF Core 11"
description: "Mueve una clave de IDENTITY a una secuencia de SQL Server en EF Core 11 con UseSequence: el SQL exacto que emite EF, por qué de pronto funcionan los valores de clave explícitos sin IDENTITY_INSERT, la secuencia bigint alimentando una columna int y los huecos que tienes que contemplar en el diseño."
pubDate: 2026-08-17
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "primary-keys"
  - "migrations"
  - "dotnet-11"
  - "how-to"
lang: "es"
translationOf: "2026/08/how-to-generate-a-primary-key-from-a-database-sequence-on-insert-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-08-17
---

Respuesta corta: llama a `UseSequence` sobre la propiedad de la clave. EF Core pone la propiedad en `ValueGenerated.OnAdd`, le da a la columna una restricción `DEFAULT (NEXT VALUE FOR [schema].[SequenceName])` en la migración y lee de vuelta el valor generado con una cláusula `OUTPUT` en el insert. Cuesta exactamente el mismo número de viajes de ida y vuelta que `IDENTITY`, agrupa en lotes igual, y te permite insertar valores de clave explícitos sin `SET IDENTITY_INSERT`. Las dos cosas que muerden son el tipo de la secuencia (EF crea una secuencia `bigint` a menos que la declares tú) y los huecos, que SQL Server documenta como inevitables.

```csharp
// .NET 11, C# 14, EF Core 11
modelBuilder.Entity<Order>()
    .Property(o => o.Id)
    .UseSequence("OrderNumbers", "shared");
```

El SQL de este artículo se capturó desde el propio `ICommandBatchPreparer` de EF Core y desde `GenerateCreateScript()` usando **EF Core 10.0.11 sobre el SDK de .NET 10.0.201**, porque EF Core 11 requiere el runtime de .NET 11 y esta máquina no lo tiene. Eso importa menos de lo habitual: las [notas de versión de EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) no contienen ninguna entrada sobre secuencias ni sobre generación de valores de clave, y `SqlServerPropertyBuilderExtensions.UseSequence` está sin cambios en `main`. Cada sentencia de abajo es la salida real de EF, no algo que yo haya vuelto a escribir. El comportamiento que necesita un servidor en marcha para observarse (huecos por reversión, pérdida de caché) se cita a la documentación de SQL Server y se marca como tal.

## Por qué moverías una clave fuera de IDENTITY

`IDENTITY` es el valor por defecto de SQL Server y está bien para la mayoría de las tablas. Hay tres situaciones que empujan a la gente fuera de él:

- **Dos tablas necesitan tomar de un mismo espacio de numeración.** Pedidos y facturas que nunca deben compartir un número de documento no pueden tener cada uno su propio `IDENTITY`. Una secuencia no está asociada a una tabla, así que ambas pueden tirar de ella.
- **Necesitas el valor antes del insert.** `NEXT VALUE FOR` se puede llamar por sí solo, así que puedes reservar una clave, construir un documento alrededor de ella e insertar después. `IDENTITY` solo produce un valor como efecto secundario de un insert.
- **Importas filas con claves ya asignadas.** Con `IDENTITY`, cada insert de ese tipo necesita `SET IDENTITY_INSERT dbo.Orders ON` a su alrededor, un interruptor con ámbito de conexión y de una tabla a la vez que EF no gestiona por ti. Con una secuencia, la columna es una columna normal con un valor por defecto, así que un valor explícito simplemente entra.

## La versión de dos líneas

Declara la secuencia y luego apunta la clave hacia ella:

```csharp
// .NET 11, C# 14, EF Core 11
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.HasSequence<int>("DocumentNumbers", schema: "shared")
        .StartsAt(1000)
        .IncrementsBy(1);

    modelBuilder.Entity<Order>()
        .Property(o => o.Id)
        .UseSequence("DocumentNumbers", "shared");

    modelBuilder.Entity<Invoice>()
        .Property(i => i.Id)
        .UseSequence("DocumentNumbers", "shared");
}
```

`UseSequence` fija tres cosas en la propiedad: la estrategia de generación de valores a `SqlServerValueGenerationStrategy.Sequence`, el nombre y el esquema de la secuencia, y `ValueGenerated.OnAdd`. También limpia cualquier configuración previa de hi-lo o de semilla de identity. Volcar el modelo lo confirma:

```text
Order.Id:   ValueGenerated=OnAdd, Strategy=Sequence, DefaultValueSql=NEXT VALUE FOR [shared].[DocumentNumbers]
Invoice.Id: ValueGenerated=OnAdd, Strategy=Sequence, DefaultValueSql=NEXT VALUE FOR [shared].[DocumentNumbers]
```

Fíjate en que EF rellenó `DefaultValueSql` por ti. Tú no escribiste esa cadena, y no deberías escribirla tú cuando usas `UseSequence`.

## Qué produce la migración

`dotnet ef migrations add Initial` te da una llamada a `CreateSequence` más un `defaultValueSql` en la columna:

```csharp
// .NET 11, EF Core 11 migration output
migrationBuilder.EnsureSchema(name: "shared");

migrationBuilder.CreateSequence<int>(
    name: "DocumentNumbers",
    schema: "shared",
    startValue: 1000L);

migrationBuilder.CreateTable(
    name: "Orders",
    columns: table => new
    {
        Id = table.Column<int>(type: "int", nullable: false,
            defaultValueSql: "NEXT VALUE FOR [shared].[DocumentNumbers]"),
        Name = table.Column<string>(type: "nvarchar(max)", nullable: false)
    },
    constraints: table =>
    {
        table.PrimaryKey("PK_Orders", x => x.Id);
    });
```

Que aterriza en la base de datos como:

```sql
-- SQL Server, generated by EF Core
CREATE SEQUENCE [shared].[DocumentNumbers] AS int START WITH 1000 INCREMENT BY 1 NO CYCLE;

CREATE TABLE [Orders] (
    [Id] int NOT NULL DEFAULT (NEXT VALUE FOR [shared].[DocumentNumbers]),
    [Name] nvarchar(max) NOT NULL,
    CONSTRAINT [PK_Orders] PRIMARY KEY ([Id])
);
```

No hay `IDENTITY` en la columna. Es un `int` normal con una restricción de valor por defecto.

## El INSERT que EF envía de verdad

Esta es la parte que la gente se equivoca cuando razona desde primeros principios. Una clave por secuencia **no** cuesta un viaje de ida y vuelta extra. EF omite la columna del insert, deja que se dispare el valor por defecto y lee el valor de vuelta en la misma sentencia:

```sql
-- one Order, EF Core 11
SET IMPLICIT_TRANSACTIONS OFF;
SET NOCOUNT ON;
INSERT INTO [Orders] ([Name])
OUTPUT INSERTED.[Id]
VALUES (@p0);
```

Agrega tres pedidos en un solo `SaveChangesAsync` y EF usa la misma forma `MERGE ... OUTPUT` que usa para `IDENTITY`, de modo que las claves devueltas se pueden correlacionar con las entidades rastreadas por posición:

```sql
-- three Orders in one batch, EF Core 11
SET IMPLICIT_TRANSACTIONS OFF;
SET NOCOUNT ON;
MERGE [Orders] USING (
VALUES (@p0, 0),
(@p1, 1),
(@p2, 2)) AS i ([Name], _Position) ON 1=0
WHEN NOT MATCHED THEN
INSERT ([Name])
VALUES (i.[Name])
OUTPUT INSERTED.[Id], i._Position;
```

Byte a byte, eso es lo que produce también una clave `IDENTITY`. Cambiar a una secuencia no cambia nada en la estrategia de lotes de EF, así que si te preocupaba un `SELECT NEXT VALUE FOR` por fila, olvídalo. Eso solo pasa con `UseHiLo`, que es una estrategia distinta (más sobre eso abajo). Si quieres verlo en tu propio modelo, [registrar el SQL que genera EF Core](/es/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) son unas cuatro líneas de configuración.

## Valores de clave explícitos, la razón por la que cambian la mayoría de los equipos

Fija la clave tú mismo y EF nota que la propiedad ya no está en su valor por defecto de CLR, incluye la columna en el insert y quita la cláusula `OUTPUT`:

```csharp
// .NET 11, C# 14, EF Core 11
db.Orders.Add(new Order { Id = 5000, Name = "imported" });
await db.SaveChangesAsync();
```

```sql
INSERT INTO [Orders] ([Id], [Name])
VALUES (@p0, @p1);
```

Una clave `IDENTITY` genera la sentencia *idéntica*, y SQL Server la rechaza con `Cannot insert explicit value for identity column in table 'Orders' when IDENTITY_INSERT is set to OFF` a menos que tú mismo conmutes `IDENTITY_INSERT` alrededor de la llamada. Contra una columna respaldada por una secuencia no hay nada que conmutar: la columna tiene un valor por defecto, y proporcionar un valor simplemente lo sobrescribe. Esa es la diferencia práctica, y es la razón por la que el código de importación y de migración de datos se acorta mucho tras el cambio.

Dos advertencias sobre esto:

**Cero no es un valor explícito.** EF decide "el usuario fijó la clave" comparando contra el valor por defecto de CLR. `new Order { Id = 0 }` es indistinguible de `new Order { }`, así que la secuencia se dispara:

```sql
-- Order { Id = 0, Name = "zero" }
INSERT INTO [Orders] ([Name])
OUTPUT INSERTED.[Id]
VALUES (@p0);
```

Si cero es una clave legítima en tus datos, haz la propiedad anulable en el modelo o usa un valor que no sea el valor por defecto de CLR.

**Mezclar ambos parte el lote.** Agrega una entidad con clave explícita y otra sin ella, y EF emite dos sentencias separadas en vez de un `MERGE`, con la fila generada primero:

```sql
SET NOCOUNT ON;
INSERT INTO [Orders] ([Name])
OUTPUT INSERTED.[Id]
VALUES (@p0);
INSERT INTO [Orders] ([Id], [Name])
VALUES (@p1, @p2);
```

Sigue siendo un viaje de ida y vuelta, pero la ganancia del lote se ha perdido. Para una importación masiva, mantén los inserts con clave explícita en su propia llamada a `SaveChanges`. Si el rendimiento es todo el objetivo, vale la pena mirar los números de [EF Core 11 vs Dapper para inserciones masivas](/es/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/) antes de afinar más esto.

## La secuencia bigint que alimenta una columna int

Este es el filo. `UseSequence` nombrará tan tranquilo una secuencia que nunca declaraste, y EF la crea por ti con el tipo por defecto de SQL Server, que es `bigint`:

```csharp
// no HasSequence call anywhere in the model
modelBuilder.Entity<Doc>().Property(d => d.Id).UseSequence("OrderNumbers");
```

```sql
CREATE SEQUENCE [OrderNumbers] START WITH 1 INCREMENT BY 1 NO CYCLE;

CREATE TABLE [Docs] (
    [Id] int NOT NULL DEFAULT (NEXT VALUE FOR [OrderNumbers]),
    ...
);
```

Sin `AS int`. La [documentación de CREATE SEQUENCE](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-sequence-transact-sql) es explícita: "If no data type is provided, the bigint data type is used as the default." Una secuencia `bigint` alimentando una columna `int` funciona bien durante los primeros 2 147 483 647 valores y luego empieza a entregarle a la columna números que no puede almacenar. Para la mayoría de las tablas eso queda muy lejos, pero mientras tanto es una configuración incorrecta silenciosa, y no va a aparecer en ninguna prueba.

Declara la secuencia con el tipo que quieres y el desajuste desaparece:

```csharp
// .NET 11, C# 14, EF Core 11
modelBuilder.HasSequence<int>("OrderNumbers").StartsAt(1000);
modelBuilder.Entity<Doc>().Property(d => d.Id).UseSequence("OrderNumbers");
```

```sql
CREATE SEQUENCE [OrderNumbers] AS int START WITH 1000 INCREMENT BY 1 NO CYCLE;
```

Regla práctica: nunca dejes que `UseSequence` cree la secuencia implícitamente. Emparéjalo siempre con un `HasSequence<T>` que nombre la misma secuencia.

## Nombres, y una línea equivocada en la documentación

Llama a `UseSequence()` sin argumentos y EF nombra la secuencia por ti:

```csharp
modelBuilder.Entity<Doc>().Property(d => d.Id).UseSequence();
// -> CREATE SEQUENCE [DocSequence] ...
```

La documentación XML del parámetro `nameSuffix` dice que es "the name that will suffix the table name". No lo es. Renombra la tabla y el nombre de la secuencia no se mueve:

```csharp
modelBuilder.Entity<Doc>().ToTable("ArchivedDocuments");
modelBuilder.Entity<Doc>().Property(d => d.Id).UseSequence();
// -> CREATE SEQUENCE [DocSequence]
// -> CREATE TABLE [ArchivedDocuments] ([Id] int NOT NULL DEFAULT (NEXT VALUE FOR [DocSequence]), ...)
```

El nombre viene del nombre corto del tipo de entidad CLR más el sufijo, que por defecto es `"Sequence"`. Renombra la clase y el nombre de tu secuencia cambia bajo tus pies, que es exactamente el tipo de cosa que produce un par sorpresa de `DropSequence` más `CreateSequence` en una migración. Nombra tus secuencias explícitamente.

También hay un interruptor a nivel de modelo, que le da a cada clave su propia secuencia:

```csharp
// .NET 11, C# 14, EF Core 11
modelBuilder.UseKeySequences();
// -> CREATE SEQUENCE [DocSequence] ...
// -> CREATE SEQUENCE [NoteSequence] ...
// -> [Docs].[Id]  int    DEFAULT (NEXT VALUE FOR [DocSequence])
// -> [Notes].[Id] bigint DEFAULT (NEXT VALUE FOR [NoteSequence])
```

La misma advertencia sobre `bigint` aplica a cada secuencia que crea.

## UseSequence vs HasDefaultValueSql

La [documentación de secuencias de EF Core](https://learn.microsoft.com/en-us/ef/core/modeling/sequences) muestra el enfoque más antiguo, escribiendo la expresión por defecto a mano:

```csharp
modelBuilder.HasSequence<int>("OrderNumbers").StartsAt(1000);
modelBuilder.Entity<Doc>()
    .Property(d => d.Id)
    .HasDefaultValueSql("NEXT VALUE FOR OrderNumbers");
```

El SQL de inserción es idéntico byte a byte al de `UseSequence`. Las diferencias están en el modelo:

| | `UseSequence` | `HasDefaultValueSql` |
| --- | --- | --- |
| `ValueGenerated` | `OnAdd` | `OnAdd` |
| Estrategia | `Sequence` | `None` |
| SQL por defecto | lo genera EF, delimitado | el tuyo, emitido literalmente |
| Renombrar la secuencia | actualiza una llamada a `HasSequence` | actualiza también la cadena, en todos los sitios |

Esa fila de "emitido literalmente" importa. Tu cadena aterriza en el DDL exactamente como la escribiste, sin delimitadores:

```sql
[Id] int NOT NULL DEFAULT (NEXT VALUE FOR OrderNumbers)
```

Lo cual se rompe en cuanto la secuencia vive en un esquema con un nombre que necesita delimitarse, o alguien mete un espacio. `UseSequence` produce `NEXT VALUE FOR [shared].[DocumentNumbers]` con los corchetes ya puestos. Prefiere `UseSequence` para claves. Reserva `HasDefaultValueSql` para columnas que no son clave, que `UseSequence` no soporta.

## Columnas que no son clave: números de pedido y de factura

Una variante común es una clave sustituta `IDENTITY` más un número visible para humanos que sale de una secuencia. `HasDefaultValueSql` es la herramienta correcta aquí:

```csharp
// .NET 11, C# 14, EF Core 11
modelBuilder.HasSequence<int>("TicketNumbers").StartsAt(500).IncrementsBy(10);

modelBuilder.Entity<Ticket>()
    .Property(t => t.TicketNumber)
    .HasDefaultValueSql("NEXT VALUE FOR TicketNumbers");
```

EF agrega la columna a la lista de `OUTPUT` cuando la dejas sin fijar, y la mueve a la lista de columnas cuando la fijas:

```sql
-- new Ticket { Name = "t1" }
INSERT INTO [Tickets] ([Name])
OUTPUT INSERTED.[Id], INSERTED.[TicketNumber]
VALUES (@p0);

-- new Ticket { Name = "t2", TicketNumber = 42 }
INSERT INTO [Tickets] ([Name], [TicketNumber])
OUTPUT INSERTED.[Id]
VALUES (@p0, @p1);
```

Misma regla del valor por defecto de CLR: `TicketNumber = 0` se lee como no fijado.

## Los huecos están garantizados, así que diséñalos

Si alguna parte de tu sistema trata la clave como un contador sin huecos, una secuencia lo va a romper, e `IDENTITY` también lo haría. La [documentación de CREATE SEQUENCE](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-sequence-transact-sql) lo dice sin rodeos: "Sequence numbers are generated outside the scope of the current transaction. They're consumed whether the transaction using the sequence number is committed or rolled back."

Hay una segunda fuente de huecos. Las secuencias van por defecto con `CACHE`, y SQL Server preasigna un bloque de valores en memoria, persistiendo solo el límite del bloque. Según la misma documentación, "an unexpected shutdown (such as a power failure) might result in the loss of sequence numbers remaining in the cache." Una caída puede, por tanto, quemar un bloque de caché entero.

`NO CACHE` estrecha la ventana a costa de una escritura en tabla de sistema por valor, y aun así la documentación señala que "gaps can still occur if numbers are requested using the NEXT VALUE FOR or sp_sequence_get_range functions, but then the numbers are either not used or are used in uncommitted transactions."

La API fluida de EF no puede expresar esto. `SequenceBuilder` expone `StartsAt`, `IncrementsBy`, `HasMin`, `HasMax` e `IsCyclic`, y nada más. Recurre a SQL crudo en la migración:

```csharp
// .NET 11, EF Core 11
migrationBuilder.Sql("ALTER SEQUENCE [shared].[DocumentNumbers] NO CACHE;");
```

Haz esto solo donde lo pida un regulador, no por defecto. Si necesitas un número de documento legal realmente sin huecos, genéralo en una tabla transaccional aparte, no desde una secuencia.

## UseSequence vs UseHiLo

`UseHiLo` es la otra estrategia respaldada por secuencias y se comporta de forma completamente distinta:

```csharp
modelBuilder.Entity<HiLoOrder>().Property(h => h.Id).UseHiLo("HiLoOrderSequence");
// -> CREATE SEQUENCE [HiLoOrderSequence] START WITH 1 INCREMENT BY 10 NO CYCLE;
// -> [HiLoOrders].[Id] int NOT NULL   (no default constraint)
```

La columna no recibe valor por defecto. EF llama a la secuencia una vez para reservar un bloque de diez y luego reparte claves de ese bloque en el cliente. Eso significa que las claves se conocen antes del insert (útil cuando estás construyendo un grafo de objetos en memoria), a costa de un viaje de ida y vuelta aparte cada vez que se agota un bloque, y de huecos mucho mayores cada vez que se libera un `DbContext` a mitad de bloque. `UseSequence` mantiene la generación en el servidor; `UseHiLo` la mueve al cliente. Elige `UseSequence` salvo que necesites específicamente tener la clave en la mano antes de `SaveChanges`.

## Reconvertir una tabla IDENTITY existente

`ALTER TABLE ... ALTER COLUMN` no puede agregar ni quitar la propiedad `IDENTITY`. La [restricción documentada](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-table-transact-sql) solo permite cambiar el tipo de una columna identity existente, a otro tipo que soporte la propiedad identity. Así que no hay migración in situ; hay que reemplazar la columna. Pasos:

1. Lee la marca de agua actual con `SELECT ISNULL(MAX(Id), 0) FROM dbo.Orders`, y añade un margen de seguridad para las filas insertadas entre la lectura y el corte.
2. Agrega `modelBuilder.HasSequence<int>("DocumentNumbers", "shared").StartsAt(<high-water mark + margin>)` y `UseSequence("DocumentNumbers", "shared")` sobre la clave, y luego genera una migración.
3. Reemplaza el cuerpo generado con SQL que cree la secuencia, construya una tabla nueva cuyo `Id` tenga el valor por defecto de la secuencia, copie las filas con `INSERT INTO ... SELECT`, elimine la tabla vieja y renombre la nueva. Las claves foráneas que apuntan a la tabla hay que eliminarlas y recrearlas alrededor del intercambio.
4. Ejecuta la migración dentro de una transacción y verifica después que `SELECT current_value FROM sys.sequences WHERE name = 'DocumentNumbers'` queda por encima de la clave existente más grande.

Dos detalles que vale la pena conocer. El sembrado con `HasData` no encaja en este modelo, porque EF exige valores de clave literales en los datos de siembra y no permite sembrar implícitamente una clave generada por el almacén, que es el origen de [la entidad de siembra no se puede agregar porque se requiere un valor distinto de cero](/es/2026/06/fix-the-seed-entity-cannot-be-added-non-zero-value-is-required-for-property/); con una secuencia puedes simplemente proporcionar las claves, ya que los valores explícitos son legales. Y si ya vas a escribir SQL de migración editado a mano para el intercambio de tablas, aplica el mismo cuidado que al [renombrar una tabla en una migración de EF Core 11 sin perder datos](/es/2026/08/how-to-rename-a-table-in-an-ef-core-11-migration-without-losing-data/): la salida generada para cambios estructurales es un punto de partida, no la respuesta.

Una última cosa que comprobar después de todo esto: ejecuta `dotnet ef migrations add` otra vez y confirma que produce una migración vacía. Una secuencia cuyo tipo en el modelo no coincide con su tipo en la base de datos, o una secuencia con nombre implícito que se movió cuando se renombró una clase, aparece como un `DropSequence` más `CreateSequence` fantasma en cada generación. Las columnas `rowversion` producen la misma clase de diferencia fantasma por la misma razón, y el recorrido en [concurrencia optimista con un token rowversion en EF Core 11](/es/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/) cubre cómo leer las anotaciones en vez del DDL cuando estás rastreando una.

## Fuentes

- [Secuencias, documentación de EF Core](https://learn.microsoft.com/en-us/ef/core/modeling/sequences)
- [Generación de valores en SQL Server, documentación de EF Core](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/value-generation)
- [CREATE SEQUENCE (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-sequence-transact-sql)
- [ALTER TABLE (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-table-transact-sql)
- [Novedades de EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [Código fuente de `SqlServerPropertyBuilderExtensions.UseSequence`](https://github.com/dotnet/efcore/blob/main/src/EFCore.SqlServer/Extensions/SqlServerPropertyBuilderExtensions.cs)
- [Código fuente de `SqlServerModelBuilderExtensions.UseKeySequences`](https://github.com/dotnet/efcore/blob/main/src/EFCore.SqlServer/Extensions/SqlServerModelBuilderExtensions.cs)
