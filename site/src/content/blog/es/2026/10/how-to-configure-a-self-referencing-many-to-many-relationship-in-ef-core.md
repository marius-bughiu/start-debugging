---
title: "Cómo configurar una relación muchos a muchos autorreferenciada (seguidores/seguidos) en EF Core"
description: "Modela seguidores y seguidos en una sola entidad User en EF Core 11: qué construye la convención, por qué SQL Server convierte en silencio una clave foránea de la tabla de unión en ClientCascade, cómo mapear una entidad de unión Follow explícita con una marca de tiempo y cómo eliminar un usuario sin los errores 547 o 1785."
pubDate: 2026-10-24
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "dotnet-11"
  - "sql-server"
  - "relationships"
  - "how-to"
lang: "es"
translationOf: "2026/10/how-to-configure-a-self-referencing-many-to-many-relationship-in-ef-core"
translatedBy: "claude"
translationDate: 2026-10-24
---

**Respuesta corta:** pon dos navegaciones de colección del mismo tipo en la entidad, `List<User> Followers` y `List<User> Following`, y empárejalas con `HasMany(u => u.Following).WithMany(u => u.Followers)`. EF Core lo mapea a una tabla de unión con dos claves foráneas hacia `Users`. Para cualquier caso real, dale a la tabla de unión su propia clase (`Follow` con `FollowerId`, `FolloweeId`, `CreatedAt`) mediante `UsingEntity<Follow>` y decide tú el comportamiento de eliminación: SQL Server rechaza dos claves foráneas en cascada desde una misma tabla hacia el mismo padre (error 1785), así que deja `Cascade` en un lado y pon el otro en `ClientCascade`, y luego elimina los usuarios con `ExecuteDeleteAsync` sobre las filas de unión primero. Todo lo que sigue se midió con .NET 11 SDK 11.0.100-rc.2, EF Core 11 (`Microsoft.EntityFrameworkCore.SqlServer` y `.Sqlite` 11.0.0-rc.2.26504.105) y C# 14.

El grafo de seguidores es el ejemplo de manual de una relación muchos a muchos autorreferenciada: cualquier usuario puede seguir a cualquier cantidad de usuarios, y cualquier usuario puede ser seguido por cualquier cantidad de usuarios. Parece un mapeo de dos líneas, y con las convenciones de EF Core casi lo es. Los problemas empiezan cuando agregas una migración para SQL Server, intentas eliminar un usuario o quieres saber *cuándo* alguien siguió a alguien.

## Qué construye la convención para Followers y Following

Empieza con el modelo más pequeño:

```csharp
// .NET 11, EF Core 11.0.0-rc.2, C# 14
public class User
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public List<User> Followers { get; } = [];
    public List<User> Following { get; } = [];
}

public class AppDb : DbContext
{
    public DbSet<User> Users => Set<User>();
}
```

Aquí no hay `OnModelCreating`, y aun así EF Core deduce que `Followers` y `Following` son los dos extremos de una única relación muchos a muchos, porque son las únicas dos navegaciones de colección en `User` que apuntan a `User`. Es el mismo mecanismo que muestra la documentación oficial con `Person.Parents` y `Person.Children`. Al llamar a `Database.GenerateCreateScript()` con el proveedor de SQL Server se imprime esta tabla de unión:

```sql
-- EF Core 11.0.0-rc.2, SQL Server provider, convention-only model
CREATE TABLE [UserUser] (
    [FollowersId] int NOT NULL,
    [FollowingId] int NOT NULL,
    CONSTRAINT [PK_UserUser] PRIMARY KEY ([FollowersId], [FollowingId]),
    CONSTRAINT [FK_UserUser_Users_FollowersId] FOREIGN KEY ([FollowersId]) REFERENCES [Users] ([Id]) ON DELETE CASCADE,
    CONSTRAINT [FK_UserUser_Users_FollowingId] FOREIGN KEY ([FollowingId]) REFERENCES [Users] ([Id])
);

CREATE INDEX [IX_UserUser_FollowingId] ON [UserUser] ([FollowingId]);
```

Tres cosas de esa salida merecen que te detengas.

Primero, los nombres. La tabla se llama `UserUser` y las columnas se nombran según las navegaciones, lo que se lee al revés. Cuando Alice (Id 1) agrega a Bob (Id 2) a `alice.Following`, la fila que llega a la tabla es `FollowersId = 1, FollowingId = 2`. Es decir, `FollowersId` contiene al seguidor y `FollowingId` contiene a la persona seguida. Es correcto, pero nadie que lea la tabla en SSMS dentro de seis meses lo va a adivinar.

Segundo, solo una clave foránea tiene `ON DELETE CASCADE`. En SQLite el mismo modelo produce cascada en ambas. La diferencia viene de `SqlServerOnDeleteConvention`, que el proveedor de SQL Server incluye desde EF Core 5 ([dotnet/efcore#21959](https://github.com/dotnet/efcore/pull/21959)). Cuando las dos claves foráneas de una tabla de unión apuntan a la misma tabla, conserva `Cascade` en una y degrada la otra a `DeleteBehavior.ClientCascade`. Cuál gana se decide por una comparación ordinal de cadenas de los dos nombres de navegación, no por algo que tú elegirías a propósito. Puedes verlo en el modelo:

```csharp
// .NET 11, EF Core 11.0.0-rc.2
foreach (var fk in db.Model.FindEntityType("UserUser")!.GetForeignKeys())
    Console.WriteLine($"{fk.Properties[0].Name}: {fk.DeleteBehavior}");

// SQL Server provider:  FollowersId: Cascade, FollowingId: ClientCascade
// SQLite provider:      FollowersId: Cascade, FollowingId: Cascade
```

Tercero, la entidad de unión es una entidad de tipo compartido respaldada por `Dictionary<string, object>`. No hay dónde poner una columna `CreatedAt`, y la documentación advierte explícitamente que no dependas de ese tipo de diccionario. Si el nombre de las columnas es la misma trampa que has encontrado con otras convenciones, el artículo sobre [por qué apareció una propiedad sombra en mi migración](/es/2026/10/what-is-a-shadow-property-in-ef-core-11-and-why-did-one-show-up-in-my-migration/) explica cómo EF inventa estas propiedades.

## Por qué SQL Server necesita que un lado deje de hacer cascada

Si ambas claves foráneas hicieran cascada, eliminar una fila de `Users` podría llegar a la misma fila de `UserUser` por dos caminos (una vez como seguidor, otra como seguido). SQL Server no lo permite y rechaza el `CREATE TABLE` con el error 1785: *Introducing FOREIGN KEY constraint ... may cause cycles or multiple cascade paths. Specify ON DELETE NO ACTION or ON UPDATE NO ACTION, or modify other FOREIGN KEY constraints.*

Con el modelo basado solo en convenciones nunca ves este error, porque el proveedor ya lo evitó. Lo ves en cuanto tomas el control de la entidad de unión y escribes la configuración "obvia":

```csharp
// .NET 11, EF Core 11.0.0-rc.2 -- DON'T: explicit Cascade beats the convention
.UsingEntity<Follow>(
    r => r.HasOne<User>().WithMany().HasForeignKey(f => f.FolloweeId).OnDelete(DeleteBehavior.Cascade),
    l => l.HasOne<User>().WithMany().HasForeignKey(f => f.FollowerId).OnDelete(DeleteBehavior.Cascade));
```

La configuración explícita siempre tiene más prioridad que una convención, así que `SqlServerOnDeleteConvention` se retira y el DDL generado ahora tiene `ON DELETE CASCADE` en ambas restricciones. `dotnet ef database update` falla en SQL Server con el 1785, mientras que la misma migración se ejecuta sin problemas en SQLite y PostgreSQL. Esa diferencia entre proveedores es la razón por la que el error suele aparecer solo en CI o en staging.

La otra mitad del compromiso es lo que significa `ClientCascade` en tiempo de ejecución. La restricción de la base de datos pasa a ser `NO ACTION`, y EF Core promete eliminar las filas dependientes *solo si están rastreadas*. Si eliminas un usuario cuyas filas de unión del lado `ClientCascade` no están cargadas, SQL Server responde con el error 547 (*The DELETE statement conflicted with the REFERENCE constraint*). En SQLite la misma situación aparece como `SQLite Error 19: 'FOREIGN KEY constraint failed'`. Más sobre esto en la sección de eliminación más abajo, y la versión general del problema está en [cómo arreglar FOREIGN KEY constraint failed al eliminar una entidad](/es/2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11/).

## Mapea una entidad de unión Follow explícita

Para un grafo de seguidores casi siempre quieres una clase de unión explícita: te da nombres de columna legibles, un lugar para `CreatedAt` (o `Muted`, `NotificationsEnabled`, etcétera) y un `DbSet` que puedes consultar y eliminar en bloque sin cargar usuarios. Este es el mapeo completo, paso a paso:

1. Agrega una clase `Follow` con `FollowerId`, `FolloweeId`, las columnas de datos y navegaciones de referencia hacia ambos usuarios.
2. Conserva las navegaciones de omisión (`Followers`, `Following`) en `User` para que el código cotidiano siga siendo natural, y agrega las navegaciones de unión (`FollowerLinks`, `FollowingLinks`) para cuando necesites los datos adicionales.
3. Empareja las navegaciones de omisión con `HasMany(...).WithMany(...)` y pasa `Follow` a `UsingEntity<Follow>`, configurando explícitamente la clave foránea de cada lado para que ni el nombre ni la dirección queden en manos de la convención.
4. Pon `Cascade` en una clave foránea y `ClientCascade` en la otra, a propósito.
5. Agrega la clave compuesta, un índice sobre la segunda columna de la clave, un valor por defecto para `CreatedAt` y una restricción check que prohíba seguirse a uno mismo.

```csharp
// .NET 11, EF Core 11.0.0-rc.2, C# 14
public class User
{
    public int Id { get; set; }
    public string Name { get; set; } = "";

    // skip navigations
    public List<User> Followers { get; } = [];
    public List<User> Following { get; } = [];

    // navigations to the join entity
    public List<Follow> FollowerLinks { get; } = [];   // rows where I am the followee
    public List<Follow> FollowingLinks { get; } = [];  // rows where I am the follower
}

public class Follow
{
    public int FollowerId { get; set; }
    public int FolloweeId { get; set; }
    public DateTime CreatedAt { get; set; }
    public User Follower { get; set; } = null!;
    public User Followee { get; set; } = null!;
}

public class AppDb(DbContextOptions<AppDb> options) : DbContext(options)
{
    public DbSet<User> Users => Set<User>();
    public DbSet<Follow> Follows => Set<Follow>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<User>()
            .HasMany(u => u.Following)
            .WithMany(u => u.Followers)
            .UsingEntity<Follow>(
                r => r.HasOne(f => f.Followee).WithMany(u => u.FollowerLinks)
                      .HasForeignKey(f => f.FolloweeId)
                      .OnDelete(DeleteBehavior.Cascade),
                l => l.HasOne(f => f.Follower).WithMany(u => u.FollowingLinks)
                      .HasForeignKey(f => f.FollowerId)
                      .OnDelete(DeleteBehavior.ClientCascade),
                j =>
                {
                    j.ToTable("Follows", t => t.HasCheckConstraint(
                        "CK_Follows_NoSelfFollow", "FollowerId <> FolloweeId"));
                    j.HasKey(f => new { f.FollowerId, f.FolloweeId });
                    j.HasIndex(f => f.FolloweeId);
                    j.Property(f => f.CreatedAt).HasDefaultValueSql("SYSUTCDATETIME()");
                });
    }
}
```

La lambda `r` configura la relación hacia el lado *derecho* de `HasMany(...).WithMany(...)`, que es la entidad a la que se llega por `Following`, es decir, el seguido. La lambda `l` es el lado *izquierdo*, el usuario que posee `Following`, es decir, el seguidor. Si las intercambias, compila sin problemas e invierte todo tu grafo en silencio, así que siempre verifico la dirección una vez en una prueba (se muestra más abajo).

El DDL de SQL Server que esto produce:

```sql
-- EF Core 11.0.0-rc.2, SQL Server provider, explicit Follow join entity
CREATE TABLE [Follows] (
    [FollowerId] int NOT NULL,
    [FolloweeId] int NOT NULL,
    [CreatedAt] datetime2 NOT NULL DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT [PK_Follows] PRIMARY KEY ([FollowerId], [FolloweeId]),
    CONSTRAINT [CK_Follows_NoSelfFollow] CHECK (FollowerId <> FolloweeId),
    CONSTRAINT [FK_Follows_Users_FolloweeId] FOREIGN KEY ([FolloweeId]) REFERENCES [Users] ([Id]) ON DELETE CASCADE,
    CONSTRAINT [FK_Follows_Users_FollowerId] FOREIGN KEY ([FollowerId]) REFERENCES [Users] ([Id])
);

CREATE INDEX [IX_Follows_FolloweeId] ON [Follows] ([FolloweeId]);
```

La clave primaria compuesta `(FollowerId, FolloweeId)` ya sirve para las búsquedas de "¿a quién sigue X?". El índice adicional sobre `FolloweeId` sirve para "¿quién sigue a X?", que es la consulta detrás de cada contador de seguidores, así que no lo elimines. En SQLite, cambia `SYSUTCDATETIME()` por `CURRENT_TIMESTAMP`.

## Seguir, dejar de seguir y comprobar la dirección

Puedes escribir a través de la navegación de omisión o de la entidad de unión. A través de la navegación de omisión, EF crea la fila `Follow` por ti y la base de datos rellena `CreatedAt`:

```csharp
// .NET 11, EF Core 11.0.0-rc.2
var dave = await db.Users.Include(u => u.Followers).SingleAsync(u => u.Name == "dave");
var alice = await db.Users.SingleAsync(u => u.Name == "alice");

dave.Followers.Add(alice);   // alice follows dave
await db.SaveChangesAsync();

var row = await db.Follows.SingleAsync(f => f.FollowerId == alice.Id && f.FolloweeId == dave.Id);
// row.FollowerId == alice.Id, row.FolloweeId == dave.Id, row.CreatedAt populated
```

Ese viaje de ida y vuelta es mi prueba de dirección: si `FollowerId` regresa con el id de Dave, las lambdas `r` y `l` están intercambiadas.

En los manejadores de solicitudes, sin embargo, cargar un usuario más una colección completa de seguidores solo para insertar una fila es un desperdicio. Usa en su lugar la entidad de unión, que no necesita cargar nada:

```csharp
// .NET 11, EF Core 11.0.0-rc.2
db.Follows.Add(new Follow { FollowerId = currentUserId, FolloweeId = targetId });
await db.SaveChangesAsync();

// unfollow, one DELETE statement, no tracking
await db.Follows
    .Where(f => f.FollowerId == currentUserId && f.FolloweeId == targetId)
    .ExecuteDeleteAsync();
```

Las dos salvaguardas del mapeo se disparan como errores reales de la base de datos. En SQLite, seguirte a ti mismo falla con `CHECK constraint failed: CK_Follows_NoSelfFollow`, y seguir a alguien dos veces falla con `UNIQUE constraint failed: Follows.FollowerId, Follows.FolloweeId`. En SQL Server, la segunda es una violación de clave primaria (error 2627). Con dobles clics concurrentes te la vas a encontrar, así que trátala como "ya lo sigues" en lugar de un 500; el mismo patrón se describe para PostgreSQL en [cómo manejar una clave duplicada en una inserción concurrente de EF Core](/es/2026/08/fix-23505-duplicate-key-value-violates-unique-constraint-on-a-concurrent-ef-core-insert/).

## Consultar contadores, seguimientos mutuos y sugerencias

Las navegaciones de omisión se traducen a joins a través de `Follows`, así que los contadores nunca cargan las colecciones:

```csharp
// .NET 11, EF Core 11.0.0-rc.2
var profile = await db.Users
    .Where(u => u.Id == userId)
    .Select(u => new { u.Name, Followers = u.Followers.Count, Following = u.Following.Count })
    .SingleAsync();
```

```sql
-- SQL Server, from ToQueryString()
SELECT [u].[Name], (
    SELECT COUNT(*)
    FROM [Follows] AS [f]
    WHERE [u].[Id] = [f].[FolloweeId]) AS [Followers], (
    SELECT COUNT(*)
    FROM [Follows] AS [f0]
    WHERE [u].[Id] = [f0].[FollowerId]) AS [Following]
FROM [Users] AS [u]
WHERE [u].[Id] = @userId
```

Los "seguimientos mutuos" (personas a las que sigo y que me siguen de vuelta) se leen de forma natural con navegaciones de omisión:

```csharp
// .NET 11, EF Core 11.0.0-rc.2
var mutual = await db.Users
    .Where(u => u.Id == userId)
    .SelectMany(u => u.Following.Where(f => f.Following.Any(x => x.Id == userId)))
    .Select(f => f.Name)
    .ToListAsync();
```

Funciona, pero el SQL que emite une `Users` tres veces porque cada salto por una navegación de omisión pasa por la tabla de usuarios. Para consultas de grafo más pesadas, escribe directamente contra `Follows`. Aquí van "las personas seguidas por las personas que sigo, a las que todavía no sigo", ordenadas por cuántos de mis seguidos llevan hasta ahí:

```csharp
// .NET 11, EF Core 11.0.0-rc.2
var suggestions = await db.Follows
    .Where(f => db.Follows.Any(a => a.FollowerId == userId && a.FolloweeId == f.FollowerId)
             && f.FolloweeId != userId
             && !db.Follows.Any(a => a.FollowerId == userId && a.FolloweeId == f.FolloweeId))
    .GroupBy(f => f.Followee.Name)
    .Select(g => new { Name = g.Key, Via = g.Count() })
    .OrderByDescending(x => x.Via)
    .ToListAsync();
```

Con el grafo de ejemplo alice -> bob, alice -> carol, bob -> alice, carol -> dave, bob -> dave, la consulta de contadores devuelve `{ Name = alice, Followers = 1, Following = 2 }`, los seguimientos mutuos de Alice devuelven `bob` y las sugerencias devuelven `dave via 2`. Esa consulta se compila a un solo `SELECT ... GROUP BY` con dos subconsultas `EXISTS` y sin joins adicionales a usuarios. Para listas de seguidores que necesiten paginación, usa el par `(FolloweeId, CreatedAt)` con [paginación por keyset](/es/2026/06/how-to-do-keyset-cursor-pagination-in-ef-core-11/) en lugar de `Skip`.

## Eliminar un usuario sin el error 547

Aquí es donde muerde el lado `ClientCascade`. En el mapeo de arriba, las filas donde el usuario eliminado es el *seguido* desaparecen mediante la cascada de la base de datos. Las filas donde el usuario eliminado es el *seguidor* dependen de EF Core, y EF solo elimina lo que rastrea. Medí tres variaciones contra SQLite con las mismas restricciones:

```csharp
// .NET 11, EF Core 11.0.0-rc.2

// 1. Join rows on the ClientCascade side NOT loaded -> fails
var bob = await db.Users.SingleAsync(u => u.Name == "bob");
db.Remove(bob);
await db.SaveChangesAsync();
// SQLite: SQLite Error 19: 'FOREIGN KEY constraint failed'
// SQL Server: error 547, DELETE conflicted with the REFERENCE constraint

// 2. Load the ClientCascade side first -> works
var carol = await db.Users.Include(u => u.FollowingLinks).SingleAsync(u => u.Name == "carol");
db.Remove(carol);
await db.SaveChangesAsync();
// EF deletes carol -> dave itself, the database cascade deletes alice -> carol
```

La opción 2 está bien para una pantalla de administración, pero cargar en el rastreador de cambios todas las filas de seguimiento de un usuario con 200 000 seguidos para eliminarlas no lo está. El enfoque que uso en producción omite el rastreo por completo y se ejecuta en una sola transacción:

```csharp
// .NET 11, EF Core 11.0.0-rc.2
// 3. Bulk-delete the join rows, then the user
await using var tx = await db.Database.BeginTransactionAsync();

await db.Follows
    .Where(f => f.FollowerId == userId || f.FolloweeId == userId)
    .ExecuteDeleteAsync();

await db.Users
    .Where(u => u.Id == userId)
    .ExecuteDeleteAsync();

await tx.CommitAsync();
```

Para Bob en el grafo de ejemplo eso eliminó tres filas de seguimiento y un usuario, y dejó solo los seguimientos que nunca lo tocaron. Recuerda que `ExecuteDeleteAsync` omite el rastreador de cambios, así que cualquier instancia de `Follow` o `User` que ya estuviera rastreada por este contexto queda obsoleta después. Los compromisos se tratan con más profundidad en [ExecuteUpdate y ExecuteDelete para escrituras en bloque](/es/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/).

Si tu aplicación elimina usuarios de forma lógica (soft delete), nada de esto aplica a la eliminación en sí: la fila del usuario permanece, y también las filas de unión, y tú decides en tus consultas si una cuenta desactivada sigue contando como seguidor.

## Detalles que conviene conocer antes de la primera migración

- **Pasar de la convención a una entidad de unión explícita cambia el nombre de la tabla.** `UserUser` con `FollowersId`/`FollowingId` se convierte en `Follows` con `FollowerId`/`FolloweeId`. La migración generada elimina y recrea la tabla, lo que pierde todos los seguimientos. Edita la migración para usar `RenameTable` y `RenameColumn` en su lugar, igual que harías al [renombrar una tabla sin perder datos](/es/2026/08/how-to-rename-a-table-in-an-ef-core-11-migration-without-losing-data/).
- **Una relación simétrica de "amigos" tiene otra forma.** Con una sola navegación `List<User> Friends` no hay inversa con la cual emparejarla. La documentación recomienda mapearla como unidireccional (`HasMany(u => u.Friends).WithMany()`) y agregar tú mismo a cada persona a la colección de la otra, o almacenar ambas direcciones como dos filas.
- **Una tercera navegación `List<User>` elimina todas en silencio.** Agrega `Blocked` junto a `Followers` y `Following` y EF ya no puede saber cuáles dos van juntas. En EF Core 11 RC 2 no lanza excepción: `Model.ToDebugString()` muestra `User` solo con su `Id` y sin ninguna relación, y las colecciones simplemente nunca se cargan. Configura cada par explícitamente con `HasMany(...).WithMany(...)` en el momento en que aparezca una tercera colección del mismo tipo.
- **Sembrar seguimientos requiere la entidad de unión.** `HasData` no puede llenar navegaciones de omisión; siembra filas `Follow` con claves fijas, como se explica en [sembrar una relación muchos a muchos en EF Core 11](/es/2026/06/how-to-seed-a-many-to-many-relationship-in-ef-core-11/).
- **`Include(u => u.Followers)` en una cuenta popular es una trampa.** Materializa a todos los seguidores. Proyecta contadores o pagina a través de `Follows` en su lugar.

## Lee a continuación

- [Cómo sembrar una relación muchos a muchos en EF Core 11](/es/2026/06/how-to-seed-a-many-to-many-relationship-in-ef-core-11/)
- [Arreglar FOREIGN KEY constraint failed al eliminar una entidad en EF Core 11](/es/2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11/)
- [Cómo usar ExecuteUpdate y ExecuteDelete para escrituras en bloque en EF Core 11](/es/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/)
- [Qué es una propiedad sombra en EF Core 11 y por qué apareció una en mi migración](/es/2026/10/what-is-a-shadow-property-in-ef-core-11-and-why-did-one-show-up-in-my-migration/)

Fuentes: la [documentación de relaciones muchos a muchos](https://learn.microsoft.com/en-us/ef/core/modeling/relationships/many-to-many) de EF Core (secciones de autorreferencia y simétricas, sobrecargas de `UsingEntity`), la [documentación de eliminación en cascada](https://learn.microsoft.com/en-us/ef/core/saving/cascade-delete) para la semántica de `ClientCascade`, el [código fuente de `SqlServerOnDeleteConvention`](https://github.com/dotnet/efcore/blob/main/src/EFCore.SqlServer/Metadata/Conventions/SqlServerOnDeleteConvention.cs) y el PR que la introdujo, [dotnet/efcore#21959](https://github.com/dotnet/efcore/pull/21959), y la documentación de SQL Server sobre la [integridad referencial en cascada](https://learn.microsoft.com/en-us/sql/relational-databases/tables/primary-and-foreign-key-constraints).
