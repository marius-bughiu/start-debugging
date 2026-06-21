---
title: "Cómo sembrar una relación muchos a muchos en EF Core 11"
description: "Siembra la tabla de unión de una relación muchos a muchos en EF Core 11: las claves sombra implícitas que debes nombrar tú mismo, el patrón UsingEntity HasData y la alternativa de tiempo de ejecución UseSeeding que funciona con navegaciones de salto."
pubDate: 2026-06-21
template: how-to
tags:
  - "dotnet"
  - "efcore"
  - "csharp"
lang: "es"
translationOf: "2026/06/how-to-seed-a-many-to-many-relationship-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-06-21
---

Para sembrar una relación muchos a muchos en EF Core 11, no siembras la navegación de salto. Siembras la tabla de unión directamente, porque `HasData` no puede poblar una navegación. Con la unión implícita predeterminada (sin clase para la entidad de unión), accede a la relación con `UsingEntity` y llama a `HasData` sobre la entidad de unión, pasando objetos anónimos cuyos nombres de propiedad son las claves foráneas sombra que EF genera -- para una relación `Post.Tags` / `Tag.Posts` esas son `PostsId` y `TagsId`. También debes sembrar ambos extremos (`Post` y `Tag`) con valores de clave primaria fijos, porque la siembra gestionada por migraciones requiere que cada clave se escriba a mano. Si prefieres sembrar en tiempo de ejecución contra datos en vivo, usa `UseSeeding`/`UseAsyncSeeding` y carga las entidades para poder agregar a la navegación de salto de forma normal. Esta publicación usa .NET 11, EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0) y C# 14.

La razón por la que esto confunde a tanta gente es que una relación muchos a muchos no tiene una tercera clase en el modelo típico. Escribes `Post` con una `List<Tag>` y `Tag` con una `List<Post>`, y EF conjura la tabla de unión por ti. Esa comodidad se evapora en el momento en que quieres datos de siembra, porque `HasData` opera sobre tipos de entidad y sus claves, y la "entidad" de unión a la que necesitas apuntar es invisible en tu código.

## Por qué HasData no puede simplemente sembrar la navegación

Comienza con el modelo que todos realmente escriben:

```csharp
// .NET 11, EF Core 11 (Microsoft.EntityFrameworkCore 11.0), C# 14
public class Post
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public List<Tag> Tags { get; } = [];
}

public class Tag
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public List<Post> Posts { get; } = [];
}
```

EF Core mapea esto por convención a tres tablas: `Posts`, `Tags` y una tabla de unión llamada `PostTag` con dos columnas, `PostsId` y `TagsId`. Esos nombres de columna no son arbitrarios. La clave foránea sombra que apunta de vuelta a la tabla `Posts` se nombra según la navegación que apunta a los posts (`Tag.Posts`), y de la misma forma `TagsId` proviene de `Post.Tags`. Nunca declaraste esas propiedades; EF las creó como propiedades sombra sobre un tipo de entidad de tipo compartido que gestiona por ti.

`HasData` es el mecanismo de siembra en tiempo de migración. Funciona adjuntando filas a un tipo de entidad específico, calculando las inserciones mediante la comparación contra la instantánea del modelo. No hay ningún tipo de entidad en tu código para la asociación entre un post y un tag, así que no hay nada a lo que `HasData` se pueda adjuntar. Tampoco puedes escribir `post.Tags.Add(tag)` en `OnModelCreating`: la construcción del modelo configura la forma del modelo, no se ejecuta contra un `DbContext`, y las navegaciones de salto no se pueblan ahí. La asociación vive en la tabla de unión, y la tabla de unión es lo que tienes que sembrar.

Esta es la misma familia de limitación que hace que `HasData` sea incómoda en general: necesita datos deterministas con claves explícitas y es propiedad de las migraciones en lugar de tu aplicación. Si esa contrapartida es nueva para ti, el panorama más amplio está en [cómo sembrar datos con UseSeeding y UseAsyncSeeding en EF Core 11](/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/), que cubre cuándo la `HasData` gestionada por migraciones es la herramienta equivocada por completo.

## Sembrar la unión implícita con UsingEntity y HasData

El enfoque en tiempo de migración tiene tres partes, y omitir cualquiera de ellas te deja con una siembra rota. Aquí está el procedimiento completo.

1. **Siembra ambos tipos de entidad principales** con `HasData`, dándole a cada fila una clave primaria fija. EF no generará claves para los datos de siembra, así que tú las asignas.
2. **Accede a la entidad de unión** con `UsingEntity`, nombrando la tabla de unión explícitamente para que la configuración sea estable.
3. **Llama a `HasData` sobre la entidad de unión**, pasando objetos anónimos cuyos nombres de propiedad coincidan con las claves foráneas sombra (`PostsId`, `TagsId`).

Reunido todo, la configuración en `OnModelCreating` se ve así:

```csharp
// .NET 11, EF Core 11, C# 14 -- seeding an implicit (unmapped) join table
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Post>().HasData(
        new Post { Id = 1, Title = "Span<T> in depth" },
        new Post { Id = 2, Title = "EF Core 11 changes" });

    modelBuilder.Entity<Tag>().HasData(
        new Tag { Id = 1, Name = "dotnet" },
        new Tag { Id = 2, Name = "performance" },
        new Tag { Id = 3, Name = "efcore" });

    modelBuilder.Entity<Post>()
        .HasMany(p => p.Tags)
        .WithMany(t => t.Posts)
        .UsingEntity(
            "PostTag",
            r => r.HasOne(typeof(Tag)).WithMany().HasForeignKey("TagsId"),
            l => l.HasOne(typeof(Post)).WithMany().HasForeignKey("PostsId"),
            j => j.HasData(
                new { PostsId = 1, TagsId = 1 },   // "Span<T>" tagged "dotnet"
                new { PostsId = 1, TagsId = 2 },   // "Span<T>" tagged "performance"
                new { PostsId = 2, TagsId = 1 },   // "EF Core 11" tagged "dotnet"
                new { PostsId = 2, TagsId = 3 })); // "EF Core 11" tagged "efcore"
}
```

Los nombres de propiedad en los objetos anónimos son el contrato aquí. Deben ser exactamente `PostsId` y `TagsId`, coincidiendo con las claves foráneas sombra que EF declaró. Escribe mal una, pluralízala de forma distinta o usa el singular `PostId` y la generación de la migración lanza `The seed entity for entity type 'PostTag' cannot be added because the value 'PostId' is not present`, porque esa propiedad no existe en la entidad de unión.

Ejecuta `dotnet ef migrations add SeedPostTags` y la migración generada inserta los posts, los tags y cuatro filas en `PostTag`. A partir de ahí, cada `dotnet ef database update` aplica esos datos una vez, y EF los rastrea en la instantánea del modelo para saber que no debe reinsertarlos.

Puedes nombrar la entidad de unión sin nombrar la tabla pasando solo la configuración lambda, pero recomiendo pasar siempre la cadena de nombre explícita `"PostTag"`. El nombre predeterminado se deriva de los nombres de tus tipos, y si alguna vez renombras `Post` a `Article`, una unión sin nombre renombra silenciosamente la tabla y deja huérfanos tus datos existentes. Fijar el nombre hace que el renombrado sea un cambio deliberado y revisable.

## Cuando tienes una clase de unión con carga útil

Si tu tabla de unión lleva columnas adicionales -- una marca de tiempo `CreatedOn`, un orden de clasificación, una bandera de "tag principal" -- tendrás una clase real para ella, y las claves foráneas siguen la convención singular `PostId` / `TagId` en lugar de las dobladas `PostsId` / `TagsId` del caso implícito. Esa diferencia atrapa a quienes pasan de una unión implícita a una explícita.

```csharp
// .NET 11, EF Core 11, C# 14 -- join entity with payload
public class PostTag
{
    public int PostId { get; set; }
    public int TagId { get; set; }
    public DateTime TaggedOn { get; set; }
}
```

Ahora siembras la entidad de unión de la misma forma que siembras cualquier entidad, porque es un tipo de entidad normal:

```csharp
modelBuilder.Entity<Post>()
    .HasMany(p => p.Tags)
    .WithMany(t => t.Posts)
    .UsingEntity<PostTag>();

modelBuilder.Entity<PostTag>().HasData(
    new PostTag { PostId = 1, TagId = 1, TaggedOn = new DateTime(2026, 6, 1) },
    new PostTag { PostId = 1, TagId = 2, TaggedOn = new DateTime(2026, 6, 1) },
    new PostTag { PostId = 2, TagId = 3, TaggedOn = new DateTime(2026, 6, 2) });
```

Observa que el `DateTime` es una constante codificada, no `DateTime.UtcNow`. Los datos de siembra deben ser deterministas: un valor que cambia en cada compilación hace que el modelo parezca modificado, y EF emite una `PendingModelChangesWarning` y quiere generar una nueva migración cada vez. Esta es una de las asperezas que muerden durante una [migración de EF Core 6 a EF Core 11](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/), donde la detección más estricta de cambios en el modelo convierte la resiembra silenciosa de ayer en una advertencia de compilación. Si necesitas una marca de tiempo de inserción, configura un valor predeterminado de base de datos con `HasDefaultValueSql("GETUTCDATE()")` en la propiedad y déjalo fuera del objeto de siembra por completo.

## Una salvedad sobre el tipo de unión implícito

El equipo de EF es explícito sobre esto en la documentación: la entidad de unión implícita está representada actualmente por `Dictionary<string, object>`, pero no debes depender de eso. Una versión futura de EF Core podría cambiar el tipo en tiempo de ejecución por rendimiento. Esto importa para la siembra de una manera práctica. No intentes sembrar construyendo tú mismo un `Dictionary<string, object>` ni referenciando el tipo directamente. Apégate a la forma de objeto anónimo dentro de `UsingEntity(...).HasData(...)`. El objeto anónimo se compara por nombre de propiedad contra las propiedades de la entidad de unión, así que está aislado de cualquiera que sea el tipo CLR concreto que EF use por debajo.

Si te encuentras queriendo referenciar el tipo de unión, esa es la señal para promoverlo a una clase real como en la sección anterior. Una clase con nombre es la forma soportada de obtener una entidad de unión estable y referenciable, y hace que sembrar, consultar y agregar columnas de carga útil sea sencillo.

## Sembrar en tiempo de ejecución con UseSeeding en su lugar

La `HasData` gestionada por migraciones es la herramienta correcta para asociaciones de referencia pequeñas y fijas que se distribuyen con tu esquema -- un conjunto conocido de tags del sistema conectados a posts conocidos. Es la herramienta equivocada para cualquier cosa dinámica, cualquier cosa con claves de la base de datos, o cualquier cosa que prefieras expresar como "agrega este tag a este post" contra objetos en vivo. Para eso, siembra en tiempo de ejecución con `UseSeeding` y `UseAsyncSeeding`, donde tienes un `DbContext` real y puedes usar la navegación de salto de la forma en que estaba pensada para usarse.

```csharp
// Program.cs -- .NET 11, ASP.NET Core 11, EF Core 11
builder.Services.AddDbContext<AppDbContext>(options =>
    options
        .UseSqlServer(builder.Configuration.GetConnectionString("Default"))
        .UseSeeding((context, _) => SeedPostTags(context))
        .UseAsyncSeeding(async (context, _, ct) => await SeedPostTagsAsync(context, ct)));

static void SeedPostTags(DbContext context)
{
    var post = context.Set<Post>()
        .Include(p => p.Tags)
        .FirstOrDefault(p => p.Title == "EF Core 11 changes");
    if (post is null) return;

    var efcore = context.Set<Tag>().FirstOrDefault(t => t.Name == "efcore");
    if (efcore is not null && !post.Tags.Any(t => t.Id == efcore.Id))
    {
        post.Tags.Add(efcore);   // EF inserts the join row for you
        context.SaveChanges();
    }
}

static async Task SeedPostTagsAsync(DbContext context, CancellationToken ct)
{
    var post = await context.Set<Post>()
        .Include(p => p.Tags)
        .FirstOrDefaultAsync(p => p.Title == "EF Core 11 changes", ct);
    if (post is null) return;

    var efcore = await context.Set<Tag>().FirstOrDefaultAsync(t => t.Name == "efcore", ct);
    if (efcore is not null && !post.Tags.Any(t => t.Id == efcore.Id))
    {
        post.Tags.Add(efcore);
        await context.SaveChangesAsync(ct);
    }
}
```

Dos cosas que notar. Primero, haces `Include(p => p.Tags)` para que las asociaciones existentes se carguen; sin eso, la guarda `!post.Tags.Any(...)` ve una colección vacía y arriesgas una inserción con clave duplicada en la tabla de unión. Segundo, la comprobación de existencia es obligatoria, porque estos callbacks se ejecutan en cada `Migrate`, `EnsureCreated` o `dotnet ef database update`, no solo la primera vez. Agrega el tag de forma incondicional y obtendrás una violación de clave primaria en `PostTag` la segunda vez que el sembrador se ejecute. Las reglas completas de cuándo se disparan estos callbacks, y por qué tienes que implementar tanto la sobrecarga síncrona como la asíncrona, están en el [análisis profundo de UseSeeding](/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/).

La recompensa es que `post.Tags.Add(efcore)` es la API natural. El rastreador de cambios de EF ve una nueva entrada en la navegación de salto y emite él mismo la inserción en la tabla de unión. Nunca nombras `PostsId` ni `TagsId`, nunca construyes un objeto anónimo, y el código se lee como el resto de tu aplicación. El costo es que esto se ejecuta al inicio contra una base de datos en vivo en lugar de estar incorporado en una migración, así que es mejor para desarrollo, pruebas y datos de referencia idempotentes en lugar de datos versionados por esquema en producción.

## Errores que producen mensajes confusos

Algunos modos de fallo recurren, y los mensajes de error no siempre apuntan a la causa real.

Sembrar solo las filas de unión y olvidar sembrar los principales te da una violación de clave foránea en el momento de `database update`, porque `PostsId = 1` referencia una fila de `Posts` que no existe. Siempre siembra ambos extremos con las mismas claves fijas que referencias en la unión.

Usar los nombres de clave sombra equivocados -- `PostId` en lugar de `PostsId` para la unión implícita -- falla en la generación de la migración con un mensaje sobre una propiedad que no está presente en la entidad de unión. La forma doblada (`PostsId`, `TagsId`) es para la unión implícita y sin mapear; la forma singular (`PostId`, `TagId`) es para una clase de unión explícita. No son intercambiables.

Dejar que una columna de carga útil tome por defecto un valor no determinista como `DateTime.UtcNow` en el objeto de siembra produce un flujo interminable de migraciones de "modelo cambiado". Codifica el valor o empújalo a un valor predeterminado de base de datos.

Por último, si tu entidad principal no tiene ninguna clave definida en absoluto -- un tipo sin clave o mal configurado -- la siembra nunca llega tan lejos; verás primero [the entity type requires a primary key to be defined](/2026/06/fix-the-entity-type-requires-a-primary-key-to-be-defined/). Arregla el modelo antes de preocuparte por los datos de siembra.

La decisión entre los dos enfoques se reduce a la propiedad. Si las asociaciones son parte de la identidad de tu esquema y deberían viajar dentro de las migraciones, siembra la entidad de unión con `UsingEntity(...).HasData(...)` y acepta la contabilidad manual de claves. Si son datos de tiempo de ejecución que preferirías expresar contra objetos en vivo, usa `UseSeeding` y agrega a la navegación de salto. La mayoría de las aplicaciones reales terminan usando `HasData` para un puñado de asociaciones del sistema y `UseSeeding` para todo lo demás, y esa división es exactamente lo que el equipo de EF diseñó para que los dos mecanismos cubrieran.

Fuentes: la [documentación de relaciones muchos a muchos](https://learn.microsoft.com/en-us/ef/core/modeling/relationships/many-to-many) de EF Core en Microsoft Learn detalla la unión implícita, las claves sombra `PostsId`/`TagsId`, las sobrecargas de `UsingEntity` y la advertencia contra depender de `Dictionary<string, object>`; la [documentación de siembra de datos](https://learn.microsoft.com/en-us/ef/core/modeling/data-seeding) de EF Core cubre `HasData` frente a `UseSeeding`/`UseAsyncSeeding` y el requisito de determinismo; la discusión de GitHub en [dotnet/efcore#23363](https://github.com/dotnet/efcore/issues/23363) muestra el patrón `UsingEntity(...).HasData(...)` confirmado por la comunidad para sembrar la tabla de unión.
