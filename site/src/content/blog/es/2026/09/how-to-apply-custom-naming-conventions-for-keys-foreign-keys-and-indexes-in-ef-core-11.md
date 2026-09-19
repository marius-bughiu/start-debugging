---
title: "Cómo aplicar convenciones de nombres personalizadas para claves primarias, claves foráneas e índices en las migraciones de EF Core 11"
description: "Renombra cada PK_, FK_, AK_ e IX_ que genera EF Core 11 con una sola IModelFinalizingConvention, deja que los nombres explícitos sigan ganando, mantente por debajo del límite de longitud de identificadores y evita la reconstrucción del índice clúster que la siguiente migración genera sobre una base de datos existente."
pubDate: 2026-09-19
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "migrations"
  - "sql-server"
  - "dotnet-11"
  - "how-to"
lang: "es"
translationOf: "2026/09/how-to-apply-custom-naming-conventions-for-keys-foreign-keys-and-indexes-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-09-19
---

Respuesta corta: escribe una clase que implemente `IModelFinalizingConvention`, recorre las claves, claves foráneas e índices declarados de cada tipo de entidad y asigna los nombres mediante los builders de convención (`key.Builder.HasName(...)`, `fk.Builder.HasConstraintName(...)`, `index.Builder.HasDatabaseName(...)`). Regístrala en `ConfigureConventions` con `configurationBuilder.Conventions.Add(_ => new ConstraintNamingConvention())`. Como los builders registran el nombre con origen `Convention`, cualquier nombre que asignes explícitamente con la Fluent API o con `[Index(Name = ...)]` sigue ganando. En una base de datos nueva, eso es todo el trabajo. En una existente, la siguiente migración elimina y vuelve a crear cada clave primaria y cada clave foránea solo para renombrarlas, así que edita esa migración a mano para convertirlas en renombrados.

Todo lo de este artículo se ejecutó con el SDK de .NET 11 RC 1 (`11.0.100-rc.1.26425.128`) y `Microsoft.EntityFrameworkCore.SqlServer` `11.0.0-rc.1.26425.128`. El DDL y el SQL de migración que se muestran son la salida real de `Database.GenerateCreateScript()` y de `IMigrationsSqlGenerator` sobre un modelo de SQL Server. No intervino ningún servidor de base de datos, así que aquí no hay tiempos, solo el SQL que EF Core enviaría.

## Los nombres que EF Core 11 elige por defecto

Empieza con un modelo pequeño: un `Blog` con una clave alternativa única `Slug`, `Post` apuntando a `Blog` y opcionalmente a `Author`, un índice único sobre `Author.Email`, un índice compuesto sobre `Post` y una relación muchos a muchos con navegación de salto entre `Post` y `Tag`.

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
public class Blog
{
    public int Id { get; set; }
    public string Slug { get; set; } = "";
    public List<Post> Posts { get; } = [];
}

public class Post
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public int BlogId { get; set; }
    public Blog Blog { get; set; } = null!;
    public int? AuthorId { get; set; }
    public Author? Author { get; set; }
    public List<Tag> Tags { get; } = [];
}

public class Author { public int Id { get; set; } public string Email { get; set; } = ""; }
public class Tag { public int Id { get; set; } public string Name { get; set; } = ""; public List<Post> Posts { get; } = []; }

public class AppDb : DbContext
{
    public DbSet<Blog> Blogs => Set<Blog>();
    public DbSet<Post> Posts => Set<Post>();
    public DbSet<Author> Authors => Set<Author>();
    public DbSet<Tag> Tags => Set<Tag>();

    protected override void OnModelCreating(ModelBuilder mb)
    {
        mb.Entity<Blog>().HasAlternateKey(b => b.Slug);
        mb.Entity<Author>().HasIndex(a => a.Email).IsUnique();
        mb.Entity<Post>().HasIndex(p => new { p.BlogId, p.Title });
    }
}
```

El DDL de SQL Server generado usa cuatro patrones:

```sql
-- EF Core 11.0.0-rc.1, SQL Server provider, default names
CONSTRAINT [PK_Blogs] PRIMARY KEY ([Id]),
CONSTRAINT [AK_Blogs_Slug] UNIQUE ([Slug])
CONSTRAINT [FK_Posts_Blogs_BlogId] FOREIGN KEY ([BlogId]) REFERENCES [Blogs] ([Id]) ON DELETE CASCADE
CONSTRAINT [FK_PostTag_Tags_TagsId] FOREIGN KEY ([TagsId]) REFERENCES [Tags] ([Id]) ON DELETE CASCADE
CREATE UNIQUE INDEX [IX_Authors_Email] ON [Authors] ([Email]);
CREATE INDEX [IX_Posts_BlogId_Title] ON [Posts] ([BlogId], [Title]);
```

Así que los valores por defecto son `PK_{table}`, `AK_{table}_{columns}`, `FK_{dependent table}_{principal table}_{columns}` e `IX_{table}_{columns}`, y un índice único recibe el mismo prefijo `IX_` que uno no único. Fíjate en que el patrón usa el nombre de la *tabla* (`Blogs`, del `DbSet`), no el nombre del tipo CLR. Partes de la documentación de Microsoft Learn describen el valor por defecto de la clave primaria como `PK_<type name>`, lo cual solo es cierto cuando ambos coinciden.

Los equipos suelen querer cambiar esto por una de tres razones: un estándar del DBA (`pk_`, `fk_`, `ux_` para índices únicos), una base de datos PostgreSQL donde todo lo demás está en minúsculas, o un esquema existente creado por otra herramienta cuyos nombres EF Core debería adoptar en lugar de pelearse con ellos.

## Nombres puntuales: HasName, HasConstraintName, HasDatabaseName

Si solo unos pocos objetos necesitan un nombre concreto, la Fluent API tiene un método por tipo de objeto:

```csharp
// .NET 11, EF Core 11 - per-object names
mb.Entity<Blog>().HasKey(b => b.Id).HasName("pk_blog");
mb.Entity<Blog>().HasAlternateKey(b => b.Slug).HasName("ak_blog_slug");

mb.Entity<Post>()
    .HasOne(p => p.Blog).WithMany(b => b.Posts)
    .HasForeignKey(p => p.BlogId)
    .HasConstraintName("fk_post_blog");

mb.Entity<Author>().HasIndex(a => a.Email).IsUnique().HasDatabaseName("ux_author_email");
```

Para los índices también existe la forma de atributo, `[Index(nameof(Email), IsUnique = true, Name = "ux_author_email")]`. El `Name` del atributo se convierte en el nombre en la base de datos.

Esto no escala. Cada entidad nueva necesita las mismas tres llamadas, la tabla de unión de una navegación de salto es fácil de olvidar, y el día que alguien agrega un índice sin la llamada vuelves a tener `IX_`. Para eso existe una convención.

## Una convención de finalización del modelo que nombra todo

La documentación de EF Core sobre [configuración masiva del modelo](https://learn.microsoft.com/en-us/ef/core/modeling/bulk-configuration) describe dos tipos de convenciones personalizadas. Las interactivas reaccionan a cada cambio del modelo en el momento en que ocurre. Las de *finalización del modelo* se ejecutan una sola vez, después de que `OnModelCreating` y todas las convenciones integradas hayan terminado, y ven el modelo casi final. Los nombres de las restricciones dependen de los nombres de tablas y columnas, que pueden cambiar hasta el final de la construcción del modelo, así que una convención de finalización es el punto de enganche correcto. Ejecutarla antes implica nombrar un índice según una columna que un `HasColumnName` posterior renombra.

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Microsoft.EntityFrameworkCore.Metadata.Conventions;

public sealed class ConstraintNamingConvention : IModelFinalizingConvention
{
    public void ProcessModelFinalizing(
        IConventionModelBuilder modelBuilder,
        IConventionContext<IConventionModelBuilder> context)
    {
        var maxLength = modelBuilder.Metadata.GetMaxIdentifierLength();

        foreach (var entityType in modelBuilder.Metadata.GetEntityTypes())
        {
            var table = entityType.GetTableName();
            if (table is null) continue; // views, keyless query types, TPC abstract roots
            var store = StoreObjectIdentifier.Table(table, entityType.GetSchema());

            foreach (var key in entityType.GetDeclaredKeys())
            {
                var name = key.IsPrimaryKey()
                    ? $"pk_{table}"
                    : $"ak_{table}_{Columns(key.Properties, store)}";
                key.Builder.HasName(Truncate(name, maxLength));
            }

            foreach (var fk in entityType.GetDeclaredForeignKeys())
            {
                var principalTable = fk.PrincipalEntityType.GetTableName();
                if (principalTable is null) continue;
                var name = $"fk_{table}_{principalTable}_{Columns(fk.Properties, store)}";
                fk.Builder.HasConstraintName(Truncate(name, maxLength));
            }

            foreach (var index in entityType.GetDeclaredIndexes())
            {
                var prefix = index.IsUnique ? "ux" : "ix";
                var name = $"{prefix}_{table}_{Columns(index.Properties, store)}";
                index.Builder.HasDatabaseName(Truncate(name, maxLength));
            }
        }
    }

    static string Columns(IEnumerable<IConventionPropertyBase> props, StoreObjectIdentifier store)
        => string.Join("_", props.Select(p =>
            (p as IConventionProperty)?.GetColumnName(store) ?? p.Name));

    static string Truncate(string name, int maxLength)
    {
        if (name.Length <= maxLength) return name;
        // keep names unique after truncation: prefix + 8 hex chars of a stable hash
        var hash = Convert.ToHexString(
            System.Security.Cryptography.SHA256.HashData(
                System.Text.Encoding.UTF8.GetBytes(name)))[..8].ToLowerInvariant();
        return $"{name[..(maxLength - 9)]}_{hash}";
    }
}
```

Regístrala en el contexto:

```csharp
// .NET 11, EF Core 11
protected override void ConfigureConventions(ModelConfigurationBuilder configurationBuilder)
    => configurationBuilder.Conventions.Add(_ => new ConstraintNamingConvention());
```

`Conventions.Add` recibe una fábrica en lugar de una instancia para que una convención pueda obtener servicios del proveedor de servicios interno de EF Core. Esta no tiene dependencias, de ahí el parámetro descartado `_`.

El mismo modelo ahora produce:

```sql
-- EF Core 11.0.0-rc.1, SQL Server provider, with ConstraintNamingConvention
CONSTRAINT [pk_Blogs] PRIMARY KEY ([Id]),
CONSTRAINT [ak_Blogs_Slug] UNIQUE ([Slug])
CONSTRAINT [fk_Posts_Blogs_BlogId] FOREIGN KEY ([BlogId]) REFERENCES [Blogs] ([Id]) ON DELETE CASCADE
CONSTRAINT [pk_PostTag] PRIMARY KEY ([PostsId], [TagsId]),
CONSTRAINT [fk_PostTag_Tags_TagsId] FOREIGN KEY ([TagsId]) REFERENCES [Tags] ([Id]) ON DELETE CASCADE
CREATE INDEX [ix_Posts_BlogId_Title] ON [Posts] ([BlogId], [Title]);
CREATE INDEX [ix_PostTag_TagsId] ON [PostTag] ([TagsId]);
```

La tabla de unión implícita `PostTag` queda cubierta sin código adicional porque es un tipo de entidad real (de tipo compartido) en el modelo, y `GetEntityTypes()` la devuelve.

Algunos detalles de ese código son deliberados.

**Usa los builders de convención, no los setters.** `key.Builder.HasName(...)` asigna el nombre con `ConfigurationSource.Convention`. EF Core registra de dónde vino cada pieza de configuración, y un valor con origen de convención nunca sobrescribe uno `DataAnnotation` o `Explicit`. En la reproducción mantuve el índice único con nombre explícito `.HasDatabaseName("UX_Authors_Email_Legacy")` en `OnModelCreating`, y la salida sigue conteniendo `CREATE UNIQUE INDEX [UX_Authors_Email_Legacy]` mientras todos los demás índices recibieron el tratamiento `ix_`/`ux_`. Si en cambio llamas a los setters mutables (`IMutableKey.SetName`) en un bucle al final de `OnModelCreating`, pierdes esa precedencia y sobrescribes en silencio nombres que un colega asignó a propósito.

**Usa el nombre de columna del objeto de almacenamiento, no el nombre de la propiedad.** `GetColumnName(StoreObjectIdentifier)` devuelve lo que realmente hay en la tabla, incluidas las redefiniciones con `HasColumnName` y los prefijos de tipos owned como `Where_City`. Nombrar un índice según la propiedad CLR produce nombres que no coinciden con las columnas que cubre.

**`Properties` es `IConventionPropertyBase` en EF Core 11.** En EF Core 11 RC 1, `IConventionKey.Properties` está tipado como `IReadOnlyList<IConventionPropertyBase>`, así que un helper declarado como `IEnumerable<IConventionProperty>` no compila y da CS1503. El cast en `Columns` se encarga de eso y recurre al nombre del miembro para cualquier cosa que no sea una propiedad escalar simple.

## Cómo desplegarlo: base de datos nueva frente a base de datos existente

La convención de nombres cambia el modelo, así que `dotnet ef migrations add` detecta una diferencia. Lo que contiene esa diferencia es la parte que duele.

1. **Proyecto nuevo o sin base de datos implementada todavía.** Agrega la convención antes de la primera migración. `InitialCreate` contiene los nombres nuevos y no hace falta nada más.
2. **Base de datos existente, tablas pequeñas.** Genera la migración, léela y aplícala. EF Core reconstruye las claves, lo cual está bien cuando las tablas son pequeñas.
3. **Base de datos existente, tablas grandes.** Genera la migración y luego reemplaza los pares de eliminar/agregar por renombrados antes de que nadie la aplique.

Para ver exactamente de qué se trata el paso 3, comparé el modelo con nombres por defecto contra el modelo con nombres de la convención usando `IMigrationsModelDiffer`, el mismo componente que usa `migrations add`. Los índices salen como renombrados baratos:

```sql
-- EF Core 11.0.0-rc.1: RenameIndexOperation on SQL Server
EXEC sp_rename N'[Posts].[IX_Posts_BlogId_Title]', N'ix_Posts_BlogId_Title', 'INDEX';
EXEC sp_rename N'[PostTag].[IX_PostTag_TagsId]', N'ix_PostTag_TagsId', 'INDEX';
```

Las claves primarias, las claves alternativas y las claves foráneas no. No existe una operación de migración `RenamePrimaryKey` ni `RenameForeignKey`, así que el differ emite una eliminación y una creación para cada una, 24 operaciones para este modelo de cinco tablas:

```sql
-- EF Core 11.0.0-rc.1: what the scaffolded migration does to keys
ALTER TABLE [Posts] DROP CONSTRAINT [FK_Posts_Blogs_BlogId];
ALTER TABLE [Posts] DROP CONSTRAINT [PK_Posts];
ALTER TABLE [Blogs] DROP CONSTRAINT [AK_Blogs_Slug];
ALTER TABLE [Blogs] DROP CONSTRAINT [PK_Blogs];
-- ...
ALTER TABLE [Posts] ADD CONSTRAINT [pk_Posts] PRIMARY KEY ([Id]);
ALTER TABLE [Blogs] ADD CONSTRAINT [ak_Blogs_Slug] UNIQUE ([Slug]);
ALTER TABLE [Blogs] ADD CONSTRAINT [pk_Blogs] PRIMARY KEY ([Id]);
ALTER TABLE [Posts] ADD CONSTRAINT [fk_Posts_Blogs_BlogId] FOREIGN KEY ([BlogId]) REFERENCES [Blogs] ([Id]) ON DELETE CASCADE;
```

En SQL Server la clave primaria es el índice clúster por defecto. Eliminarla convierte la tabla en un heap y reescribe todos los índices no clúster; volver a agregarla ordena y reescribe la tabla otra vez, y luego reescribe los índices no clúster una segunda vez. Volver a agregar cada clave foránea valida todas las filas existentes. En una tabla con decenas de millones de filas esta es una operación larga y pesada para el log, dentro de la transacción de la migración, solo para cambiar las mayúsculas de un prefijo. El mismo patrón de eliminar y agregar aparece cuando [renombras una tabla en una migración de EF Core 11](/es/2026/08/how-to-rename-a-table-in-an-ef-core-11-migration-without-losing-data/), y la solución es la misma: renombrar las restricciones en su lugar.

En SQL Server, reemplaza en `Up` las llamadas generadas `DropForeignKey`/`DropPrimaryKey`/`DropUniqueConstraint` y las `Add*` correspondientes por `sp_rename`, que renombra una restricción como un cambio de metadatos. Renombrar una clave primaria o una restricción única con `sp_rename` también renombra el índice que la respalda.

```csharp
// .NET 11, EF Core 11 - hand-edited Up() for SQL Server
protected override void Up(MigrationBuilder migrationBuilder)
{
    migrationBuilder.Sql("EXEC sp_rename N'[dbo].[PK_Blogs]', N'pk_Blogs', 'OBJECT';");
    migrationBuilder.Sql("EXEC sp_rename N'[dbo].[AK_Blogs_Slug]', N'ak_Blogs_Slug', 'OBJECT';");
    migrationBuilder.Sql("EXEC sp_rename N'[dbo].[PK_Posts]', N'pk_Posts', 'OBJECT';");
    migrationBuilder.Sql("EXEC sp_rename N'[dbo].[FK_Posts_Blogs_BlogId]', N'fk_Posts_Blogs_BlogId', 'OBJECT';");
    // ...one line per key and foreign key

    // the scaffolded index renames are already fine, keep them
    migrationBuilder.RenameIndex(
        name: "IX_Posts_BlogId_Title", table: "Posts", newName: "ix_Posts_BlogId_Title");
}
```

En PostgreSQL el equivalente es `ALTER TABLE "Posts" RENAME CONSTRAINT "PK_Posts" TO "pk_Posts";`, que también renombra el índice detrás de una clave primaria o una restricción única. Npgsql ya genera `ALTER INDEX ... RENAME TO` para los índices simples.

Escribe también las llamadas inversas a `sp_rename` en `Down`. El `Down` generado sigue conteniendo pares de eliminar/agregar, y dejarlo así significa que una reversión ejecuta la reconstrucción que acabas de evitar. La instantánea del modelo no se ve afectada por esta edición manual: registra los nombres nuevos de todos modos, así que el siguiente `migrations add` produce una diferencia vacía. Si no es así, se te escapó una restricción, y la comprobación al inicio te lo dirá con [la excepción de cambios pendientes en el modelo](/es/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/). Aplica la migración editada mediante un script revisado o un [bundle de migraciones](/es/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/), no desde `Database.Migrate()` al iniciar la aplicación.

## Trampas: tablas compartidas, límites de longitud y el paquete de snake_case

**Nombra a partir de la tabla, nunca del tipo de entidad.** Un tipo owned almacenado en la tabla de su propietario, la división de tablas y TPH ponen varios tipos de entidad en una misma tabla, y cada uno tiene sus propios metadatos de clave primaria. Deben coincidir en el nombre de la restricción. En la reproducción cambié el patrón de la clave primaria a `pk_{entityType.ClrType.Name}` en un modelo con un `Address` owned dentro de `Media`, y la validación del modelo falló de inmediato:

```text
InvalidOperationException: The table 'Media' cannot be used for entity type 'Media' since it is being used
for entity type 'Address' and the name 'pk_Media' of the primary key {'Id'} does not match the name
'pk_Address' of the primary key {'MediaId'}.
```

Derivar el nombre de `GetTableName()` evita esto, porque todos los tipos de entidad de la tabla compartida se resuelven a la misma tabla. La misma reproducción con `pk_{table}` produjo una única restricción `pk_Media`, y las claves foráneas de TPH declaradas en los tipos derivados `Photo` y `Clip` salieron como `fk_Media_Author_PhotographerId` y `fk_Media_Author_EditorId` en la tabla compartida. La [guía de mapeo TPH](/es/2026/07/how-to-configure-table-per-hierarchy-tph-inheritance-mapping-in-ef-core-11/) explica por qué las columnas de los tipos derivados terminan siendo anulables ahí.

**Respeta el límite de longitud de identificadores y mantén únicos los nombres truncados.** `IConventionModel.GetMaxIdentifierLength()` devuelve el límite del proveedor: 128 en SQL Server y 32767 en SQLite en mi reproducción. PostgreSQL trunca los identificadores a 63 bytes. Un índice compuesto sobre columnas con nombres largos supera 63 con facilidad, y si simplemente cortas la cadena, dos índices que solo difieren al final colapsan en el mismo nombre. EF Core entonces falla la validación porque dos índices de una tabla se asignan al mismo nombre con columnas distintas. El helper `Truncate` conserva un prefijo y agrega ocho caracteres hexadecimales de un SHA-256 del nombre completo. Con un límite de 40 caracteres, `ix_customer_order_line_items_warehouse_location_id_created_at` y `..._updated_at` se convirtieron en `ix_customer_order_line_items_wa_0e2c7d55` e `ix_customer_order_line_items_wa_a5c1910c`. Usa un hash estable, nunca `string.GetHashCode()`, que en .NET se aleatoriza por proceso y produciría un nombre distinto, y una migración nueva, en cada compilación.

**Las convenciones de finalización se ejecutan en el orden en que las agregas.** Si también tienes una convención que renombra tablas o columnas (por ejemplo a snake_case), agrégala *antes* de la convención de nombres de restricciones en `ConfigureConventions`. De lo contrario, los nombres de las restricciones se calculan a partir de los nombres de tabla antiguos.

**`EFCore.NamingConventions` todavía no es un paquete para EF Core 11.** El popular paquete de la comunidad que convierte todo a snake_case, incluidos los nombres de claves e índices, está en la 10.0.1 a día de hoy, y su nuspec fija `Microsoft.EntityFrameworkCore.Relational` a `[10.0.1, 11.0.0)`. Referenciarlo junto a EF Core 11 te da la advertencia NU1608 de NuGet, "outside of dependency constraint", y un paquete que nunca se probó contra la API de metadatos de 11.0, la cual, como muestra el cambio de `IConventionPropertyBase`, sí cambió. Una convención de 60 líneas que controlas tú no tiene ese problema.

**Los modelos generados (database-first) ignoran todo esto.** `dotnet ef dbcontext scaffold` lee los nombres reales de la base de datos y escribe llamadas explícitas a `HasName`/`HasDatabaseName`, y lo explícito gana sobre la convención. Ese es el comportamiento correcto, pero no esperes que la convención "arregle" un modelo obtenido por ingeniería inversa.

**Comprueba el resultado, no el código.** `Database.GenerateCreateScript()` sobre un contexto con una cadena de conexión ficticia imprime el DDL completo sin tocar un servidor, y `dotnet ef migrations script` muestra lo que ejecutará una migración pendiente. Ambos son más rápidos que leer la instantánea del modelo. Para el lado del runtime, [registrar el SQL que genera EF Core 11](/es/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) muestra los nombres de las restricciones en cualquier `DbUpdateException` que haga referencia a ellas.

## Relacionados

- [Cómo renombrar una tabla en una migración de EF Core 11 sin perder datos](/es/2026/08/how-to-rename-a-table-in-an-ef-core-11-migration-without-losing-data/)
- [Solución: el modelo del contexto 'X' tiene cambios pendientes en EF Core 11](/es/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/)
- [Cómo aplicar migraciones de EF Core 11 en producción con bundles de migraciones](/es/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/)
- [Cómo configurar el mapeo de herencia tabla por jerarquía (TPH) en EF Core 11](/es/2026/07/how-to-configure-table-per-hierarchy-tph-inheritance-mapping-in-ef-core-11/)
- [Tipos complejos frente a entidades owned en EF Core 11](/es/2026/07/complex-types-vs-owned-entities-in-ef-core-11/)

## Fuentes

- [Model bulk configuration](https://learn.microsoft.com/en-us/ef/core/modeling/bulk-configuration) en Microsoft Learn: `ConfigureConventions`, `IModelFinalizingConvention`, orígenes de configuración y builders de convención
- [Keys](https://learn.microsoft.com/en-us/ef/core/modeling/keys) e [Indexes and constraints](https://learn.microsoft.com/en-us/ef/core/modeling/indexes) en Microsoft Learn para `HasName` y `HasDatabaseName`
- [sys.sp_rename](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-rename-transact-sql) para renombrar restricciones en su lugar en SQL Server
- [ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html) (`RENAME CONSTRAINT`) y [longitud de identificadores](https://www.postgresql.org/docs/current/sql-syntax-lexical.html#SQL-SYNTAX-IDENTIFIERS) en la documentación de PostgreSQL
- [EFCore.NamingConventions en NuGet](https://www.nuget.org/packages/EFCore.NamingConventions), rangos de dependencias de la versión 10.0.1
