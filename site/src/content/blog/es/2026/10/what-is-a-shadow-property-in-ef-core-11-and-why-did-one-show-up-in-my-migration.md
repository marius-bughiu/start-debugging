---
title: "Qué es una shadow property en EF Core 11 y por qué apareció una en mi migración"
description: "Una shadow property es una columna que EF Core rastrea sin una propiedad CLR correspondiente. Por qué EF Core 11 las crea (propiedades FK ausentes, FK con nombre incorrecto, tipos incompatibles, relaciones duplicadas), cómo detectar las del tipo BlogId1 en una migración, cómo corregir cada causa y cómo usarlas a propósito."
pubDate: 2026-10-09
tags:
  - "ef-core"
  - "ef-core-11"
  - "dotnet-11"
  - "migrations"
  - "relationships"
lang: "es"
translationOf: "2026/10/what-is-a-shadow-property-in-ef-core-11-and-why-did-one-show-up-in-my-migration"
translatedBy: "claude"
translationDate: 2026-10-09
---

Respuesta corta: una shadow property es una propiedad que existe en el modelo de EF Core, y normalmente como columna en la base de datos, pero que no tiene una propiedad correspondiente en tu clase de entidad. EF Core 11 crea una por ti cada vez que una relación necesita una clave foránea y no encuentra ninguna propiedad CLR que usar. Cuando eso ocurre porque tu clase simplemente no tiene una propiedad FK, la columna shadow es inofensiva. Cuando ocurre porque *sí* tienes una propiedad FK que EF Core no pudo usar (nombre incorrecto, tipo incorrecto, `[NotMapped]`, o una relación configurada dos veces), obtienes una columna como `BlogId1` u `OwnerId` junto a la que querías, y la solución es indicarle a EF Core qué propiedad es la clave foránea con `HasForeignKey`.

Todo lo que sigue se ejecutó con `Microsoft.EntityFrameworkCore.Sqlite` 11.0.0-rc.1.26425.128 sobre el SDK de .NET 11 RC1 (11.0.100-rc.1.26425.128), C# 14. La salida del modelo y las advertencias están copiadas de ejecuciones reales, no parafraseadas.

## Qué significa "shadow" para EF Core

Cada propiedad de un modelo de EF Core tiene metadatos: un nombre, un tipo CLR, si admite nulos, si es clave o FK. Para la mayoría de las propiedades también hay un miembro de respaldo en la clase, una propiedad o campo de C#, que EF Core lee y escribe al materializar entidades o guardar cambios. Una shadow property tiene los metadatos pero no tiene miembro. Su valor vive solo en el change tracker.

Esa es toda la definición, según la [documentación de shadow e indexer properties](https://learn.microsoft.com/en-us/ef/core/modeling/shadow-properties). A EF Core no le importa cómo llegó a existir la propiedad. Puedes declararla deliberadamente, o las convenciones pueden crearla durante la construcción del modelo. El segundo caso es el que sorprende a la gente, porque el primer lugar donde se hace visible es una migración que agrega una columna que nunca escribiste.

Puedes ver cuáles propiedades son shadow volcando el modelo. `Model.ToDebugString()` las marca con `(no field, ...)` y `Shadow`:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
using Microsoft.EntityFrameworkCore.Infrastructure;

using var db = new AppDbContext();
Console.WriteLine(db.Model.ToDebugString(MetadataDebugStringOptions.ShortDefault));
```

Ten ese one-liner a mano. Es la forma más rápida de responder "¿de dónde salió esta columna?" sin leer el snapshot de la migración.

## Caso 1: la navegación no tiene propiedad FK (esperado, inofensivo)

La shadow property más común es la que EF Core crea cuando modelas una relación solo con navegaciones:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
public class Blog
{
    public int Id { get; set; }
    public List<Post> Posts { get; set; } = [];
}

public class Post
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
}
```

Aquí hay una relación uno a muchos, así que la tabla `Post` necesita una columna de clave foránea. `Post` no tiene `BlogId`, así que EF Core inventa una. La vista de depuración la muestra:

```text
EntityType: Post
  Properties:
    Id (int) Required PK AfterSave:Throw ValueGenerated.OnAdd
    BlogId (no field, int?) Shadow FK Index
    Title (string) Required
  Foreign keys:
    Post {'BlogId'} -> Blog {'Id'} ClientSetNull ToDependent: Posts
```

Y la tabla generada:

```sql
CREATE TABLE "Post" (
    "Id" INTEGER NOT NULL CONSTRAINT "PK_Post" PRIMARY KEY AUTOINCREMENT,
    "Title" TEXT NOT NULL,
    "BlogId" INTEGER NULL,
    CONSTRAINT "FK_Post_Blogs_BlogId" FOREIGN KEY ("BlogId") REFERENCES "Blogs" ("Id")
);
```

El nombre sigue la convención `<nombre de la navegación o del tipo principal><nombre de la clave principal>`, aquí `Blog` + `Id`. Dos detalles importan. Primero, la FK shadow es `int?`, así que la relación es opcional y el comportamiento de eliminación es `ClientSetNull`, no `Cascade`. Si esperabas semántica requerida, agrega una propiedad real `int BlogId` o llama a `.IsRequired()` en la relación. Segundo, EF Core registra esto solo en nivel Debug, como `CoreEventId.ShadowPropertyCreated` (evento 10600):

```text
The property 'Post.BlogId' was created in shadow state because there are no eligible CLR members with a matching name.
```

No verás eso en un registro de consola por defecto. Es intencional: es una decisión de modelado legítima, y muchas bases de código mantienen los valores de FK fuera de sus clases de dominio.

## Caso 2: la propiedad FK tiene un nombre no convencional (silencioso, e incorrecto)

Este es el que produce una "columna misteriosa" en una migración sin ninguna advertencia:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
public class User
{
    public int Id { get; set; }
}

public class Post
{
    public int Id { get; set; }
    public int OwnerUserId { get; set; }
    public User Owner { get; set; } = null!;
}
```

Querías que `OwnerUserId` fuera la clave foránea de `Owner`. La convención de descubrimiento de FK de EF Core solo reconoce nombres de la forma `<nombre de la navegación><nombre de la clave principal>` (`OwnerId`), `<nombre del tipo principal><nombre de la clave principal>` (`UserId`), o `<nombre del tipo de entidad principal>Id`. `OwnerUserId` no coincide con ninguna, así que EF Core la trata como una columna `int` normal y crea una FK shadow `OwnerId`:

```text
EntityType: Post
  Properties:
    Id (int) Required PK AfterSave:Throw ValueGenerated.OnAdd
    OwnerId (no field, int) Shadow Required FK Index
    OwnerUserId (int) Required
```

```sql
CREATE TABLE "Posts" (
    "Id" INTEGER NOT NULL CONSTRAINT "PK_Posts" PRIMARY KEY AUTOINCREMENT,
    "OwnerUserId" INTEGER NOT NULL,
    "OwnerId" INTEGER NOT NULL,
    CONSTRAINT "FK_Posts_User_OwnerId" FOREIGN KEY ("OwnerId") REFERENCES "User" ("Id") ON DELETE CASCADE
);
```

Tu código asigna `post.OwnerUserId = 42`, guarda, y nada se vincula. La relación vive en `OwnerId`, que tu código nunca toca. EF Core vuelve a registrar solo el evento `ShadowPropertyCreated` de nivel Debug, así que el primer síntoma suele ser un join que no devuelve nada o un diff de migración que alguien lee con mucho cuidado.

La solución es nombrar la FK explícitamente:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Post>()
        .HasOne(p => p.Owner)
        .WithMany()
        .HasForeignKey(p => p.OwnerUserId);
}
```

o con la anotación de datos en la navegación: `[ForeignKey(nameof(OwnerUserId))] public User Owner { get; set; }`. Después de eso, el modelo tiene una sola FK, `OwnerUserId`, y la columna shadow desaparece. Si ya se publicó una migración con `OwnerId`, la siguiente migración eliminará `OwnerId` y agregará la restricción FK a `OwnerUserId`. Verifica si se escribieron filas mediante la columna anterior antes de dejar que se elimine.

## Caso 3: la propiedad FK tiene el tipo incorrecto (BlogId1)

Ahora el famoso sufijo `1`:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
public class Blog
{
    public int Id { get; set; }
    public List<Post> Posts { get; set; } = [];
}

public class Post
{
    public int Id { get; set; }
    public string BlogId { get; set; } = "";   // principal key is int
    public Blog Blog { get; set; } = null!;
}
```

`BlogId` tiene el nombre convencional, pero es un `string` y `Blog.Id` es un `int`. EF Core no puede usar una propiedad incompatible como FK. Tampoco puede llamar `BlogId` a la propiedad shadow, porque ese nombre ya está tomado, así que lo hace único como `BlogId1`. Esta vez EF Core registra una advertencia, `CoreEventId.ShadowForeignKeyPropertyCreated` (evento 10625):

```text
warn: CoreEventId.ShadowForeignKeyPropertyCreated[10625]
      The foreign key property 'Post.BlogId1' was created in shadow state because a conflicting property
      with the simple name 'BlogId' exists in the entity type, but is either not mapped, is already used
      for another relationship, or is incompatible with the associated primary key type.
```

El mensaje enumera las tres causas que llevan a una FK shadow numerada. La incompatibilidad de tipos es una. Las otras dos siguen.

## Caso 4: la relación se configuró dos veces (BlogId y BlogId1)

Este viene de una Fluent API que nombra solo un lado de la relación:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
public class Post
{
    public int Id { get; set; }
    public int BlogId { get; set; }
    public Blog Blog { get; set; } = null!;
}

protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Blog>()
        .HasMany(b => b.Posts)
        .WithOne()                       // no navigation passed
        .HasForeignKey(p => p.BlogId);
}
```

`WithOne()` sin argumento le dice a EF Core "esta relación no tiene navegación en el lado de `Post`". Pero `Post.Blog` existe, así que las convenciones construyen una *segunda* relación a partir de ella. `BlogId` ya lo usa la primera, así que la segunda obtiene `BlogId1`:

```text
Foreign keys:
  Post {'BlogId'} -> Blog {'Id'} Required Cascade ToDependent: Posts
  Post {'BlogId1'} -> Blog {'Id'} Required Cascade ToPrincipal: Blog
```

```sql
CREATE TABLE "Post" (
    "Id" INTEGER NOT NULL CONSTRAINT "PK_Post" PRIMARY KEY AUTOINCREMENT,
    "BlogId" INTEGER NOT NULL,
    "BlogId1" INTEGER NOT NULL,
    CONSTRAINT "FK_Post_Blogs_BlogId" FOREIGN KEY ("BlogId") REFERENCES "Blogs" ("Id") ON DELETE CASCADE,
    CONSTRAINT "FK_Post_Blogs_BlogId1" FOREIGN KEY ("BlogId1") REFERENCES "Blogs" ("Id") ON DELETE CASCADE
);
```

Dos FK requeridas a la misma tabla, y `blog.Posts` y `post.Blog` ya no describen el mismo vínculo. La solución es pasar la navegación para que ambos extremos pertenezcan a una sola relación: `.WithOne(p => p.Blog)`. Con ese cambio el modelo vuelve a tener una única FK `BlogId` con `Inverse: Posts`.

Una diferencia útil: si quitas la llamada a `HasForeignKey(p => p.BlogId)` de esa configuración rota, EF Core 11 no crea `BlogId1` en silencio. En su lugar lanza una excepción durante la finalización del modelo:

```text
System.InvalidOperationException: Both relationships between 'Post' and 'Blog.Posts' and between 'Post.Blog'
and 'Blog' could use {'BlogId'} as the foreign key. To resolve this, configure the foreign key properties
explicitly in 'OnModelCreating' on at least one of the relationships.
```

Así que cuando te encuentres con esa excepción, la reacción correcta no es agregar un `HasForeignKey` hasta que desaparezca. Eso convierte la excepción en el esquema con `BlogId1` de arriba. Encuentra la relación a la que le falta su navegación y corrige esa.

## Caso 5: la propiedad FK no está mapeada

La tercera causa de la advertencia es una propiedad que EF Core no tiene permitido usar:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
public class Post
{
    public int Id { get; set; }
    [NotMapped] public int BlogId { get; set; }
    public Blog Blog { get; set; } = null!;
}
```

El resultado es una tabla con solo una columna `BlogId1`, más la misma advertencia 10625. Lo mismo ocurre con `modelBuilder.Entity<Post>().Ignore(p => p.BlogId)`. Si quieres que la propiedad CLR sea la FK, quita el ignore. Si quieres que sea un auxiliar sin mapear, renómbrala para que no colisione con el nombre convencional de la FK.

## Cómo detectar FK shadow accidentales antes de publicar

Leer cada diff de migración funciona hasta que deja de funcionar. Dos protecciones más baratas:

Convierte la advertencia en una excepción. Los casos 3, 4 y 5 lanzan `ShadowForeignKeyPropertyCreated`, y se le puede indicar a EF Core que lance una excepción:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
using Microsoft.EntityFrameworkCore.Diagnostics;

protected override void OnConfiguring(DbContextOptionsBuilder options) => options
    .UseSqlite("Data Source=app.db")
    .ConfigureWarnings(w => w.Throw(CoreEventId.ShadowForeignKeyPropertyCreated));
```

Acceder a `db.Model` ahora falla con `An error was generated for warning 'Microsoft.EntityFrameworkCore.Model.Validation.ShadowForeignKeyPropertyCreated'`, y como `dotnet ef migrations add` también construye el modelo, la migración incorrecta nunca llega a crearse. No hagas lo mismo con `ShadowPropertyCreated` a menos que no tengas ninguna shadow property intencional, porque también se dispara para el inofensivo Caso 1.

Haz una aserción sobre el modelo en una prueba. El Caso 2 nunca genera una advertencia, así que una prueba unitaria que recorra el modelo es la única red de seguridad automática:

```csharp
// .NET 11, EF Core 11.0.0-rc.1, xUnit
[Fact]
public void No_unexpected_shadow_foreign_keys()
{
    using var db = new AppDbContext();
    var allowed = new HashSet<string> { "Post.BlogId" };   // the ones you chose on purpose

    var shadowFks = db.Model.GetEntityTypes()
        .SelectMany(e => e.GetProperties())
        .Where(p => p.IsShadowProperty() && p.IsForeignKey())
        .Select(p => $"{p.DeclaringType.ClrType.Name}.{p.Name}")
        .Where(name => !allowed.Contains(name))
        .ToList();

    Assert.Empty(shadowFks);
}
```

`IsShadowProperty()` e `IsForeignKey()` son parte de la API pública de metadatos en `IReadOnlyProperty`, así que esto no necesita acceso interno ni base de datos.

## Usar shadow properties a propósito

Una vez que sabes qué son, las shadow properties son una herramienta limpia para datos que pertenecen a la tabla pero no al objeto de dominio. Las marcas de tiempo de auditoría son el caso clásico:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Post>().Property<DateTime>("LastUpdated");
}

public override int SaveChanges()
{
    foreach (var entry in ChangeTracker.Entries<Post>()
                 .Where(e => e.State is EntityState.Added or EntityState.Modified))
    {
        entry.Property("LastUpdated").CurrentValue = DateTime.UtcNow;
    }
    return base.SaveChanges();
}
```

La clase `Post` queda libre de aspectos de persistencia, y la tabla obtiene una columna `"LastUpdated" TEXT NOT NULL` (en SQLite). La lectura y escritura pasan por el change tracker, `db.Entry(post).Property<DateTime>("LastUpdated").CurrentValue`, y las consultas pasan por `EF.Property`:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
var recent = await db.Posts
    .Where(p => EF.Property<DateTime>(p, "LastUpdated") > DateTime.UtcNow.AddDays(-1))
    .OrderBy(p => EF.Property<DateTime>(p, "LastUpdated"))
    .ToListAsync();
```

lo cual se traduce a una referencia de columna simple:

```sql
SELECT "p"."Id", "p"."LastUpdated", "p"."Title"
FROM "Posts" AS "p"
WHERE "p"."LastUpdated" > rtrim(rtrim(strftime('%Y-%m-%d %H:%M:%f', 'now', CAST(-1.0 AS TEXT) || ' days'), '0'), '.')
```

Para algo más que una sola entidad, pon la lógica de marcado en un `SaveChangesInterceptor` en lugar de sobrescribir `SaveChanges` en cada contexto.

## Detalles que conviene conocer

- **Los valores shadow se pierden al desasociar.** El valor solo existe en el change tracker. Las consultas con `AsNoTracking()` siguen devolviendo columnas shadow en el SQL, pero no hay forma de leerlas desde el objeto materializado. Proyéctalas explícitamente con `EF.Property` en un `Select` si las necesitas.
- **FK shadow y grafos desconectados.** Si asocias un `Post` con solo una navegación asignada, EF Core completa la FK shadow a partir de la navegación en `SaveChanges`. Si asocias un `Post` sin navegación y sin propiedad FK, no hay con qué completarla, y debes asignarla mediante `Entry(...).Property("BlogId").CurrentValue`.
- **Las correcciones de nombres son migraciones, no solo código.** Corregir el Caso 2, 3 o 4 cambia el esquema. EF Core generará un drop de la columna shadow. Si se escribieron datos de producción mediante ella, cópialos a la columna FK real dentro de la migración antes del drop.
- **Las indexer properties son primas, no lo mismo.** Los property bags (tipos de entidad `Dictionary<string, object>`) usan indexer properties, que tienen un acceso CLR, el indexador. No son shadow properties, aunque tampoco tengan una propiedad de C# con nombre.

## Relacionado

- Si la columna shadow apareció primero como una migración inexplicable, [corregir "the model for context has pending changes" en EF Core 11](/es/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/) explica cómo funciona el diff del snapshot.
- Para el patrón de auditoría bien hecho, consulta [usar interceptores de EF Core 11 para auditoría](/es/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/).
- Para ver la columna `BlogId1` en el SQL real que emite EF Core, [registrar el SQL que genera EF Core 11](/es/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) muestra todas las opciones.
- Una FK shadow requerida con `Cascade` cambia el comportamiento de eliminación; [corregir FOREIGN KEY constraint failed al eliminar](/es/2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11/) explica cómo la elige EF Core.
- Si de todas formas vas a renombrar FK, [convenciones de nombres personalizadas para claves, claves foráneas e índices en EF Core 11](/es/2026/09/how-to-apply-custom-naming-conventions-for-keys-foreign-keys-and-indexes-in-ef-core-11/) muestra cómo hacerlo en todo el modelo.

## Fuentes

- [Shadow and Indexer Properties](https://learn.microsoft.com/en-us/ef/core/modeling/shadow-properties), documentación de EF Core.
- [Foreign and principal keys in relationships](https://learn.microsoft.com/en-us/ef/core/modeling/relationships/foreign-and-principal-keys), documentación de EF Core, para las reglas de nombres del descubrimiento de FK.
- [CoreEventId.ShadowForeignKeyPropertyCreated](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.diagnostics.coreeventid.shadowforeignkeypropertycreated), referencia de la API.
- [Microsoft.EntityFrameworkCore 11.0.0-rc.1.26425.128](https://www.nuget.org/packages/Microsoft.EntityFrameworkCore/11.0.0-rc.1.26425.128) en NuGet, la versión usada en cada ejecución de este artículo.
