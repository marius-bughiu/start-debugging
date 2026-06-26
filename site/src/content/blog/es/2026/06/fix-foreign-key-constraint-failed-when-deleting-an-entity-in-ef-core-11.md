---
title: "Solución: FOREIGN KEY constraint failed al eliminar una entidad en EF Core 11"
description: "EF Core lanza FOREIGN KEY constraint failed porque el padre todavía tiene dependientes que la base de datos se niega a dejar huérfanos. Carga los hijos, haz la relación opcional o configura OnDelete."
pubDate: 2026-06-26
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
lang: "es"
translationOf: "2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-06-26
---

La solución: estás eliminando una fila principal (padre) que todavía tiene filas dependientes (hijas) apuntando a ella, y la base de datos no las dejará huérfanas. Tienes tres opciones reales, en orden: cargar los dependientes en el contexto antes de `SaveChanges` para que EF Core pueda hacer la eliminación en cascada por sí mismo; hacer la relación opcional (clave foránea anulable) para que la FK de los hijos se pueda poner en null; o configurar `OnDelete(DeleteBehavior.Cascade)` y recrear el esquema para que la base de datos elimine los hijos por ti. Elige la que coincida con lo que debería pasar con los hijos.

```text
Microsoft.EntityFrameworkCore.DbUpdateException: An error occurred while saving the entity changes. See the inner exception for details.
 ---> Microsoft.Data.Sqlite.SqliteException (0x80004005): SQLite Error 19: 'FOREIGN KEY constraint failed'.
   at Microsoft.Data.Sqlite.SqliteException.ThrowExceptionForRC(int rc, sqlite3 db)
   at Microsoft.EntityFrameworkCore.Update.ReaderModificationCommandBatch.ExecuteAsync(...)
```

Este es un error de base de datos en runtime, lanzado por `SaveChanges`/`SaveChangesAsync` y envuelto en una `DbUpdateException`. La redacción exacta es la del proveedor de SQLite. En SQL Server la misma situación produce `The DELETE statement conflicted with the REFERENCE constraint "FK_..."`, en PostgreSQL es `23503: update or delete on table "..." violates foreign key constraint`, y en MySQL es `Cannot delete or update a parent row: a foreign key constraint fails`. Texto diferente, causa idéntica. Esta guía está escrita para .NET 11, C# 14, `Microsoft.EntityFrameworkCore` 11.0.0 y `Microsoft.Data.Sqlite` 11.0.0. El comportamiento no ha cambiado desde EF Core 7, así que aplica hasta esa versión.

## Por qué la base de datos rechaza la eliminación

EF Core modela una relación con una clave foránea: la fila dependiente almacena la clave primaria de su principal. Cuando eliminas el principal, cada FK dependiente que apuntaba a él ahora referencia una fila que ya no existe. Eso es una violación de integridad referencial, y una base de datos relacional la detiene en la restricción.

Solo hay dos salidas legales, y la base de datos solo puede elegir una si le dices cuál:

1. Eliminar también los dependientes (eliminación en cascada).
2. Poner la clave foránea de los dependientes en null (solo posible si la columna es anulable).

Si eliminas el principal sin organizar ninguna de esas dos, la base de datos lanza el error. La razón por la que esto aparece tan a menudo es que la configuración *predeterminada* de EF Core depende de si la relación es requerida u opcional, y de si los dependientes están cargados en el contexto en el momento en que llamas a `SaveChanges`. Esos dos interruptores deciden si EF Core arregla las cosas en memoria antes de enviar el SQL, o si entrega el problema directamente a la base de datos, que entonces lo rechaza.

Un factor agravante sutil: SQLite no aplica claves foráneas en absoluto a menos que `PRAGMA foreign_keys = ON`, que `Microsoft.Data.Sqlite` establece de forma predeterminada. Los desarrolladores que probaron en una configuración antigua, o en el proveedor in-memory de EF Core (que no aplica restricciones), suelen sorprenderse la primera vez que una base de datos SQLite o SQL Server real rechaza la eliminación.

## La reproducción más pequeña

Una relación uno a muchos requerida: `Blog` tiene muchos `Post`, y `Post.BlogId` no es anulable, así que la relación es requerida.

```csharp
// .NET 11, C# 14, EF Core 11.0.0, Microsoft.Data.Sqlite 11.0.0
public class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public List<Post> Posts { get; } = new();
}

public class Post
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public int BlogId { get; set; }            // non-nullable => required relationship
    public Blog Blog { get; set; } = null!;
}

public class AppDb : DbContext
{
    public DbSet<Blog> Blogs => Set<Blog>();
    public DbSet<Post> Posts => Set<Post>();

    public AppDb(DbContextOptions<AppDb> options) : base(options) { }
}
```

Ahora elimina un blog que tiene posts, sin cargar esos posts:

```csharp
// .NET 11, EF Core 11.0.0 -- throws DbUpdateException -> "FOREIGN KEY constraint failed"
var blog = await db.Blogs.SingleAsync(b => b.Id == 1);   // no Include(b => b.Posts)
db.Blogs.Remove(blog);
await db.SaveChangesAsync();
```

EF Core solo conoce el blog. Emite un único `DELETE FROM Blogs WHERE Id = 1`. Los posts siguen referenciando el blog 1, y la base de datos aborta la sentencia. El error es correcto: pediste eliminar una fila de la que dependen otras filas, y no dijiste qué hacer con ellas.

Observa el contraste. Con una relación requerida el comportamiento de eliminación predeterminado es `Cascade`, pero la "cascada" se puede aplicar de dos formas: por EF Core (en memoria, requiere que los hijos estén cargados) o por la base de datos (requiere `ON DELETE CASCADE` en la restricción). Si el esquema se creó sin `ON DELETE CASCADE` y los hijos no están cargados, ninguno de los dos mecanismos se activa, y caes en este error.

## Solución 1: carga los dependientes para que EF Core pueda hacer la cascada

La solución más portable, y la que funciona sin importar cómo se creó la restricción de la base de datos. Trae los hijos al contexto con `Include`, y EF Core emitirá sentencias `DELETE` para ellos antes de eliminar el padre.

```csharp
// .NET 11, EF Core 11.0.0 -- EF Core deletes posts, then the blog
var blog = await db.Blogs
    .Include(b => b.Posts)
    .SingleAsync(b => b.Id == 1);

db.Blogs.Remove(blog);
await db.SaveChangesAsync();
```

Con los posts rastreados, EF Core ve que eliminar el blog corta una relación requerida, aplica la cascada en memoria y ordena el SQL correctamente: primero elimina los posts, luego el blog. Esto funciona porque EF Core "siempre aplica los comportamientos de cascada configurados a las entidades rastreadas", independientemente del esquema de la base de datos.

El costo es obvio: cargas cada fila dependiente en memoria solo para eliminarla. Para un blog con diez posts eso está bien. Para un padre con cien mil hijos es un problema de memoria y de viajes de ida y vuelta, y querrás la Solución 3 (cascada en la base de datos) o una eliminación masiva basada en conjuntos en su lugar. El [`ExecuteDelete` para escrituras masivas](/es/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) de EF Core 11 elimina hijos en una sola sentencia SQL sin materializarlos, que es la herramienta correcta cuando el conjunto de hijos es grande. Solo recuerda que `ExecuteDelete` omite el rastreador de cambios, así que eliminas los hijos explícitamente antes que el padre en lugar de depender de la cascada.

## Solución 2: haz la relación opcional para que la FK se pueda poner en null

Usa esto cuando el hijo pueda existir legítimamente sin el padre. Haz la clave foránea anulable, y el comportamiento predeterminado para una relación opcional pasa a ser `ClientSetNull`: EF Core pone la FK de los dependientes en null en lugar de eliminarlos.

```csharp
// .NET 11, EF Core 11.0.0 -- optional relationship
public class Post
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public int? BlogId { get; set; }           // nullable => optional relationship
    public Blog? Blog { get; set; }
}
```

Después de una migración que hace que la columna `BlogId` sea anulable, eliminar un blog con sus posts cargados produce `UPDATE Posts SET BlogId = NULL ...` para cada post, luego `DELETE FROM Blogs ...`. Los posts sobreviven, desvinculados de cualquier blog.

```csharp
// .NET 11, EF Core 11.0.0 -- posts kept, FK set to null
var blog = await db.Blogs.Include(b => b.Posts).SingleAsync(b => b.Id == 1);
db.Blogs.Remove(blog);
await db.SaveChangesAsync();
```

Dos advertencias. Primero, esto es una decisión semántica, no un truco para silenciar el error: solo haz una relación opcional si un hijo huérfano es genuinamente válido en tu dominio. Un `Post` sin `Blog` puede no tener sentido. Segundo, con `ClientSetNull` (el predeterminado) EF Core todavía necesita los dependientes cargados para poner sus FK en null; si no están cargados, obtienes una `DbUpdateException` de nuevo. Para empujar la puesta en null hacia la base de datos de modo que funcione sin cargar, configura `OnDelete(DeleteBehavior.SetNull)`, que emite `ON DELETE SET NULL` en la restricción.

```csharp
// .NET 11, EF Core 11.0.0 -- database nulls the FK on delete, no need to load children
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Blog>()
        .HasMany(b => b.Posts)
        .WithOne(p => p.Blog)
        .HasForeignKey(p => p.BlogId)
        .OnDelete(DeleteBehavior.SetNull);
}
```

## Solución 3: configura la base de datos para que haga la cascada de la eliminación

Usa esto cuando los hijos deban morir con el padre y no quieras cargarlos primero. Configura `DeleteBehavior.Cascade` y crea o migra el esquema para que la restricción lleve `ON DELETE CASCADE`. Entonces la base de datos elimina los dependientes por sí misma cuando eliminas el principal.

```csharp
// .NET 11, EF Core 11.0.0 -- ON DELETE CASCADE in the database
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Blog>()
        .HasMany(b => b.Posts)
        .WithOne(p => p.Blog)
        .HasForeignKey(p => p.BlogId)
        .OnDelete(DeleteBehavior.Cascade);
}
```

Para una relación requerida esto ya es el valor predeterminado por convención, pero la restricción solo lleva `ON DELETE CASCADE` si la base de datos fue *creada o migrada con esa configuración ya en su lugar*. Esta es la trampa que atrapa a la mayoría: agregan `OnDelete(Cascade)` (o dependen del predeterminado), la compilación tiene éxito, y la eliminación sigue fallando, porque la base de datos en ejecución se creó antes de que se configurara la cascada y la restricción existente no tiene cláusula de cascada. La configuración en `OnModelCreating` cambia el modelo, no la base de datos en vivo. Debes generar y aplicar una migración:

```bash
# .NET 11 SDK, EF Core tools 11.0.0
dotnet ef migrations add ConfigurePostCascade
dotnet ef database update
```

Verifica que la restricción realmente lleve la cascada. En SQLite, inspecciona la lista de claves foráneas:

```sql
-- run against the SQLite database file
SELECT * FROM pragma_foreign_key_list('Posts');
-- the "on_delete" column should read CASCADE, not NO ACTION
```

Después de eso, `db.Blogs.Remove(blog); await db.SaveChangesAsync();` elimina el blog sin ningún `Include`, y la base de datos elimina los posts en la misma operación.

Una limitación de plataforma que vale la pena conocer antes de recurrir a la cascada en todas partes: SQL Server rechaza múltiples rutas de cascada hacia la misma tabla. Si dos relaciones requeridas harían eliminación en cascada hacia una misma tabla, crear el esquema falla con `Introducing FOREIGN KEY constraint '...' on table '...' may cause cycles or multiple cascade paths`. La solución ahí es hacer una relación opcional, o establecer una en `ClientCascade` para que EF Core (no SQL Server) maneje ese tramo de la cascada con los hijos cargados. SQLite y PostgreSQL no tienen esta restricción.

## Variantes que caen en este mismo error

### Jerarquías autorreferenciadas (tablas de árbol)

Una `Category` con un `ParentId` anulable que apunta de vuelta a `Category` choca con esto constantemente. Eliminar una categoría padre cuyos hijos no están cargados falla la verificación de FK. Como SQL Server prohíbe una cascada autorreferenciada que pueda formar ciclos, normalmente no puedes depender de `ON DELETE CASCADE` aquí en absoluto; carga el subárbol y deja que EF Core lo elimine, o elimina de abajo hacia arriba con `ExecuteDelete`.

### Filas de unión de muchos a muchos

Con una skip navigation (`Blog` tiene muchos `Tag` a través de una tabla de unión implícita), eliminar un `Blog` requiere que las filas de unión se vayan primero. EF Core maneja esto automáticamente cuando el blog se carga con sus `Tags`, pero un `Remove` simple sin cargar la navegación deja las filas de unión huérfanas y la eliminación falla. O bien carga la skip navigation o aplica `ExecuteDelete` a las filas de unión. La mecánica de las entidades de unión se cubre en [sembrar una relación de muchos a muchos en EF Core 11](/es/2026/06/how-to-seed-a-many-to-many-relationship-in-ef-core-11/).

### "Funcionaba en el proveedor in-memory"

La base de datos in-memory de EF Core no aplica claves foráneas ni eliminaciones en cascada, así que una eliminación que "pasa" en una prueba unitaria puede fallar contra una base de datos SQLite o SQL Server real. Esta es una de varias razones por las que el proveedor in-memory es un mal sustituto del comportamiento relacional; prefiere SQLite in-memory o una base de datos real para las pruebas de la ruta de eliminación. Consulta [simular DbContext sin romper el rastreo de cambios](/es/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) para patrones de prueba conscientes del rastreo, y ten en cuenta que las reglas de fixup de relaciones aquí interactúan con [AsNoTracking vs AsNoTrackingWithIdentityResolution](/es/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/): una consulta sin rastreo no dejará que EF Core haga la cascada en memoria, porque no hay nada rastreado para hacer la cascada.

### El error solo se dispara después de una actualización

Si una eliminación que solía funcionar empieza a lanzar errores después de cambiar las versiones del runtime o del proveedor, comprueba si un `DeleteBehavior` predeterminado o la nulabilidad de una FK cambió en el snapshot de tu modelo. La superficie de cambios incompatibles está catalogada en [migrar de EF Core 6 a EF Core 11](/es/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/); compara tus migraciones generadas para ver si la cláusula de cascada se movió.

### La eliminación está dentro de una estrategia de ejecución con reintentos

Si envuelves la eliminación en una transacción manual mientras usas `EnableRetryOnFailure`, puedes obtener una excepción *diferente* que enmascara esta. Esa interacción es su propio error, cubierto en [la estrategia de ejecución no admite transacciones iniciadas por el usuario](/es/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/).

## Confirmar la solución

Reproduce la eliminación contra el proveedor real, no el in-memory, y observa el SQL generado. Activa el registro sensible en desarrollo para que los valores de los parámetros y el orden de las sentencias sean visibles:

```csharp
// .NET 11, EF Core 11.0.0 -- dev only; never enable sensitive logging in production
var options = new DbContextOptionsBuilder<AppDb>()
    .UseSqlite("Data Source=app.db")
    .LogTo(Console.WriteLine, LogLevel.Information)
    .EnableSensitiveDataLogging()
    .Options;
```

Si la solución funcionó verás o bien `DELETE FROM Posts ...` antes de `DELETE FROM Blogs ...` (Solución 1 o Solución 3) o bien `UPDATE Posts SET BlogId = NULL ...` antes de la eliminación del blog (Solución 2). Si todavía ves un `DELETE FROM Blogs ...` solitario seguido de la excepción, los dependientes no fueron ni cargados ni manejados por la base de datos, y has aplicado la configuración al modelo pero no al esquema en vivo. Vuelve a ejecutar `dotnet ef database update` y vuelve a comprobar `pragma_foreign_key_list`.

El modelo mental que vale la pena tener: este error es la base de datos pidiéndote que decidas el destino de los hijos antes de eliminar el padre. Elimínalos con él (cascada), consérvalos y corta el vínculo (poner en null), o tráelos al contexto para que EF Core pueda decidir fila por fila. El error no es EF Core poniéndose difícil; es la integridad referencial haciendo exactamente su trabajo.

## Fuentes

- [Cascade Delete](https://learn.microsoft.com/en-us/ef/core/saving/cascade-delete), documentación de EF Core, sobre `DeleteBehavior`, los predeterminados de requerido vs opcional, y las tablas de comportamiento de cargado vs no cargado.
- [Relationships](https://learn.microsoft.com/en-us/ef/core/modeling/relationships), documentación de EF Core, sobre cómo las relaciones requeridas y opcionales se infieren de la nulabilidad de la FK.
- [Microsoft.Data.Sqlite foreign keys](https://learn.microsoft.com/en-us/dotnet/standard/data/sqlite/foreign-keys), sobre la aplicación de `PRAGMA foreign_keys`.
- [SQLite result and error codes](https://www.sqlite.org/rescode.html), sobre `SQLITE_CONSTRAINT_FOREIGNKEY` (código extendido 787).
