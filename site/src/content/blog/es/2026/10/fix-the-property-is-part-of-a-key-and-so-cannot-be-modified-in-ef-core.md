---
title: "Solución: The property 'X' is part of a key and so cannot be modified or marked as modified en EF Core"
description: "EF Core nunca actualiza el valor de una clave en una entidad rastreada. Deja de copiar la clave desde los DTO, usa un índice único en lugar de una clave alternativa, y cambia una clave real insertando una fila nueva y eliminando la anterior. Probado en EF Core 10.0.14."
pubDate: 2026-10-27
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "dotnet"
  - "csharp"
  - "change-tracker"
  - "dotnet-10"
lang: "es"
translationOf: "2026/10/fix-the-property-is-part-of-a-key-and-so-cannot-be-modified-in-ef-core"
translatedBy: "claude"
translationDate: 2026-10-27
---

**Respuesta corta:** EF Core trata cada propiedad de clave (clave primaria, clave alternativa y cualquier clave foránea que también forme parte de la clave primaria) como de solo lectura una vez que la entidad se ha guardado, y el change tracker lanza la excepción en cuanto detecta un valor nuevo. Encuentra qué está escribiendo la clave: normalmente un mapeador de DTO o `CurrentValues.SetValues` que copia un `Id` de `0`, una columna natural configurada con `HasAlternateKey`, o una fila hija con clave compuesta que se mueve a otro padre. Deja de escribirla, cambia la clave alternativa por un índice único o, cuando la clave realmente debe cambiar, agrega una entidad nueva con la clave nueva y elimina la anterior en el mismo `SaveChanges`.

Todo lo que sigue se reprodujo en .NET 10 (SDK 10.0.302) con `Microsoft.EntityFrameworkCore.Sqlite` 10.0.14 sobre una base de datos SQLite en memoria. La comprobación que lanza la excepción vive en `InternalEntryBase.SetPropertyModified` y no ha cambiado en la rama `main` de EF Core que se publicará como EF Core 11, así que las mismas reglas se aplican a las versiones candidatas de .NET 11.

## El error en contexto

```
System.InvalidOperationException: The property 'Blog.Id' is part of a key and so cannot be modified or marked as modified. To change the principal of an existing entity with an identifying foreign key, first delete the dependent and invoke 'SaveChanges', and then associate the dependent with the new principal.
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.InternalEntryBase.SetPropertyModified(IProperty property, Boolean changeState, Boolean isModified, Boolean isConceptualNull, Boolean acceptChanges)
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.ChangeDetector.DetectValueChange(IInternalEntry entry, IProperty property)
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.ChangeDetector.LocalDetectChanges(InternalEntryBase entry)
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.ChangeDetector.LocalDetectChanges(InternalEntityEntry entry)
```

El nombre de la propiedad en el mensaje te dice qué clave está protegiendo EF. `Blog.Id` es una clave primaria. Algo como `Blog.Slug` indica una clave alternativa. `OrderLine.OrderId` indica una clave foránea que también forma parte de una clave primaria compuesta, que es la "clave foránea identificadora" de la que habla la segunda oración del mensaje.

## Por qué EF Core se niega a cambiar una clave

Una entidad rastreada se identifica por su clave. El `DbContext` mantiene un mapa de identidad desde los valores de clave hasta las instancias de entidad, usa la clave original en la cláusula `WHERE` del `UPDATE` y corrige las propiedades de navegación haciendo coincidir las claves foráneas con las claves principales. Si la clave pudiera cambiar en el sitio, habría que reescribir las tres cosas a mitad del proceso, además de cada fila dependiente en la base de datos. EF Core no admite eso, y la solicitud para agregarlo, [dotnet/efcore#4073](https://github.com/dotnet/efcore/issues/4073), sigue abierta.

La protección se basa en metadatos. Cada propiedad de clave recibe `PropertySaveBehavior.Throw` como comportamiento posterior al guardado, y el change tracker lo comprueba siempre que una propiedad de una entidad `Unchanged` o `Modified` está a punto de marcarse como modificada:

```csharp
// EF Core source, src/EFCore/ChangeTracking/Internal/InternalEntryBase.cs (simplified)
if (changeState
    && !isConceptualNull
    && isModified
    && !StateManager.SavingChanges
    && property.IsKey()
    && property.GetAfterSaveBehavior() == PropertySaveBehavior.Throw)
{
    throw new InvalidOperationException(CoreStrings.KeyReadOnly(property.Name, StructuralType.DisplayName()));
}
```

Dos consecuencias importan al depurar. Primero, las entidades en estado `Added` retornan antes de esta comprobación, así que cambiar la clave de una entidad que aún no has guardado es válido. Segundo, con el seguimiento de cambios por instantáneas (el predeterminado), la excepción no se lanza en la línea que asigna la clave. Se lanza en el siguiente `DetectChanges`, que se ejecuta dentro de `SaveChanges`, `ChangeTracker.HasChanges()`, `ChangeTracker.Entries()` y llamadas similares. En mi reproducción, `blog.Id = 99;` terminó sin errores y el siguiente `db.ChangeTracker.HasChanges()` lanzó la excepción. Si tu traza de pila apunta a `SaveChangesAsync` en un repositorio, el verdadero culpable está en algún punto anterior de la solicitud.

Tampoco puedes desactivarlo. Intentar cambiar el comportamiento de guardado de una propiedad de clave falla mientras se construye el modelo:

```csharp
// .NET 10, EF Core 10.0.14
modelBuilder.Entity<Blog>().Property(b => b.Id).Metadata
    .SetAfterSaveBehavior(PropertySaveBehavior.Save);
// InvalidOperationException: The property 'Blog.Id' must be marked as read-only after it has been
// saved because it is part of a key. Key properties are always read-only once an entity has been
// saved for the first time.
```

## Reproducción mínima

```csharp
// .NET 10, C# 14, EF Core 10.0.14, Microsoft.EntityFrameworkCore.Sqlite
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;

using var conn = new SqliteConnection("Data Source=:memory:");
conn.Open();

using (var db = new AppDb(conn))
{
    db.Database.EnsureCreated();
    db.Blogs.Add(new Blog { Id = 1, Name = "Start Debugging" });
    db.SaveChanges();
}

using (var db = new AppDb(conn))
{
    var blog = db.Blogs.Single(b => b.Id == 1);
    blog.Id = 99;       // no exception here
    db.SaveChanges();   // InvalidOperationException: The property 'Blog.Id' is part of a key...
}

class AppDb(SqliteConnection c) : DbContext
{
    public DbSet<Blog> Blogs => Set<Blog>();
    protected override void OnConfiguring(DbContextOptionsBuilder o) => o.UseSqlite(c);
    protected override void OnModelCreating(ModelBuilder mb) =>
        mb.Entity<Blog>().Property(b => b.Id).ValueGeneratedNever();
}

class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
}
```

Nadie escribe `blog.Id = 99` a propósito, así que el resto de esta publicación trata sobre los cuatro lugares de los que realmente proviene la escritura, ordenados por la frecuencia con la que los veo.

## Solución 1: deja de copiar la clave desde un DTO

Esta es, con mucho, la causa más común. Un endpoint PUT carga la entidad y luego copia el modelo entrante sobre ella:

```csharp
// .NET 10, EF Core 10.0.14
public record BlogDto(int Id, string Name);

var blog = await db.Blogs.SingleAsync(b => b.Id == id);
db.Entry(blog).CurrentValues.SetValues(dto);   // dto.Id is 0 because the client never sent it
await db.SaveChangesAsync();                    // throws: 'Blog.Id' is part of a key
```

`PropertyValues.SetValues` copia todas las propiedades cuyo nombre coincide, claves incluidas. Cuando el `Id` del DTO coincide con el rastreado, nada cambia y el guardado tiene éxito; confirmé que `SetValues` con `Id = 1` sobre la fila con `Id = 1` se guarda sin problemas. Cuando el cliente omite el id del cuerpo, o el id de la ruta y el del cuerpo no coinciden, la clave cambia y EF lanza la excepción. Ten en cuenta que la traza de pila en este caso es distinta: como `SetValues` pasa directamente por el change tracker, la excepción se produce dentro del propio `SetValues` (`ChangeDetector.PropertyChanged`), no en `SaveChanges`.

Elige una única fuente de verdad para el id, normalmente la ruta, y nunca dejes que el cuerpo la sobrescriba:

```csharp
// .NET 10, EF Core 10.0.14
app.MapPut("/blogs/{id:int}", async (int id, BlogDto dto, AppDb db) =>
{
    if (dto.Id != 0 && dto.Id != id)
        return Results.BadRequest("Route id and body id differ.");

    var blog = await db.Blogs.SingleOrDefaultAsync(b => b.Id == id);
    if (blog is null) return Results.NotFound();

    db.Entry(blog).CurrentValues.SetValues(dto with { Id = id });
    await db.SaveChangesAsync();
    return Results.NoContent();
});
```

Mejor aún, usa un DTO de actualización que no tenga ninguna propiedad `Id`, de modo que no haya nada que copiar. Con AutoMapper, el equivalente es `.ForMember(d => d.Id, o => o.Ignore())` en el mapa de DTO a entidad, y conviene agregar `ForMember(...Ignore())` para cada columna de clave, incluidas las claves foráneas que forman parte de una clave compuesta.

El mismo error ocurre con los ayudantes manuales de "copiar todas las propiedades" y con los parchadores basados en reflexión. Si escribes uno, filtra `entry.Metadata.FindPrimaryKey()!.Properties` y cualquier propiedad donde `property.IsKey()` sea verdadero.

## Solución 2: usa un índice único, no una clave alternativa, para los identificadores naturales

La segunda forma es una columna que consideras "única", como un slug, un correo electrónico o un SKU, configurada como clave alternativa:

```csharp
// .NET 10, EF Core 10.0.14
modelBuilder.Entity<Blog>().HasAlternateKey(b => b.Slug);

var blog = db.Blogs.Single();
blog.Slug = "new-slug";
db.SaveChanges();   // InvalidOperationException: The property 'Blog.Slug' is part of a key...
```

Una clave alternativa es una clave en todos los sentidos que le importan a EF, así que es de solo lectura tras el guardado. La documentación de EF Core lo dice directamente: "In EF, alternate keys are read-only". Si lo único que necesitas es unicidad en la base de datos, configura un índice único:

```csharp
// .NET 10, EF Core 10.0.14
modelBuilder.Entity<Blog>().HasIndex(b => b.Slug).IsUnique();
```

Con ese cambio de una línea, el mismo código se guardó y la fila se leyó de vuelta con `Slug = "new-slug"`. La base de datos sigue garantizando la unicidad; solo pierdes la posibilidad de apuntar una clave foránea a `Slug`.

Ten cuidado con las claves alternativas que no declaraste. `HasPrincipalKey(x => x.Slug)` en una relación hace que EF cree una por convención, porque una clave foránea tiene que apuntar a una clave. Si el mensaje nombra una propiedad sobre la que nunca llamaste a `HasAlternateKey`, busca `HasPrincipalKey` en la configuración del modelo, o inspecciona `db.Model.FindEntityType(typeof(Blog))!.GetKeys()` en tiempo de ejecución. Hacer que esa relación apunte a la clave primaria es la solución limpia. En cuanto a las migraciones, pasar de una clave alternativa a un índice único reemplaza una restricción única `AK_` por un índice único `IX_`; revisa la migración generada antes de aplicarla.

## Solución 3: mueve un dependiente con clave compuesta eliminándolo y volviéndolo a agregar

La segunda oración del mensaje trata sobre este caso. Supón que una línea de pedido tiene la clave `(OrderId, LineNumber)` y `OrderId` es además la clave foránea hacia `Order`. Es una relación identificadora: la identidad de la línea incluye a su padre. Moverla a otro pedido significa cambiar su clave primaria, y todas las formas de expresarlo lanzan la excepción:

```csharp
// .NET 10, EF Core 10.0.14
modelBuilder.Entity<OrderLine>().HasKey(l => new { l.OrderId, l.LineNumber });

var line = db.OrderLines.Single();
line.OrderId = 2;                     // throws at SaveChanges
// line.Order = order2;               // throws during fix-up
// order2.Lines.Add(line);            // throws during fix-up
db.SaveChanges();
```

Las tres variantes produjeron `The property 'OrderLine.OrderId' is part of a key` en mi reproducción. Las versiones con propiedad de navegación y con colección lanzan la excepción desde la corrección de relaciones (fix-up), que es la que establece la clave foránea por ti.

La solución es tratar el movimiento como lo que realmente es: eliminar una fila e insertar otra.

```csharp
// .NET 10, EF Core 10.0.14
var line = await db.OrderLines.SingleAsync(l => l.OrderId == 1 && l.LineNumber == 1);

db.OrderLines.Remove(line);
db.OrderLines.Add(new OrderLine
{
    OrderId = 2,
    LineNumber = 1,
    Sku = line.Sku,
});

await db.SaveChangesAsync();
```

El mensaje sugiere llamar a `SaveChanges` después de eliminar y antes de insertar. En EF Core 10 eso no fue necesario en ningún caso que probé: quitar la línea anterior y agregar la nueva en un solo `SaveChanges` funcionó tanto cuando la clave nueva era distinta (`2/1`) como cuando era idéntica (`1/1` con un `Sku` nuevo), y ambas sentencias se ejecutaron en la misma transacción. Un solo `SaveChanges` también es más seguro, porque una caída entre dos guardados dejaría la línea eliminada y sin recrear.

Si las líneas se mueven entre padres con regularidad, el modelo te está diciendo algo. Dale a `OrderLine` su propia clave sustituta (`int Id`) y haz de `OrderId` una clave foránea normal, que no sea parte de la clave. Entonces `line.OrderId = 2` es una actualización ordinaria. Mantén `(OrderId, LineNumber)` como único con un índice único si necesitas esa restricción.

## Solución 4: cambia la clave de un principal insertando una copia y reapuntando a sus hijos

A veces la clave primaria misma debe cambiar: una clave natural heredada se ingresó mal, o se están fusionando dos sistemas. Dentro del change tracker el patrón es el mismo que en la solución 3, con un paso extra para los hijos:

```csharp
// .NET 10, EF Core 10.0.14
var old = await db.Blogs.Include(b => b.Posts).SingleAsync(b => b.Id == 1);

var replacement = new Blog { Id = 99, Name = old.Name, Slug = old.Slug + "-moved" };
db.Blogs.Add(replacement);

foreach (var post in old.Posts.ToList())
    post.Blog = replacement;          // Post.BlogId is a plain FK, not part of Post's key

db.Blogs.Remove(old);
await db.SaveChangesAsync();
```

EF Core determina el orden de los comandos (insertar el blog nuevo, actualizar las publicaciones, eliminar el blog anterior) y los ejecuta en una sola transacción. En la reproducción esto dejó un blog con `Id = 99` y el `BlogId` de la publicación en `99`. Ten en cuenta que el slug se cambió en la copia: si `Slug` tuviera un índice único, insertar un valor idéntico puede colisionar con la fila anterior que aún no se ha eliminado. O le das a la copia un valor temporal y lo corriges después, o usas el enfoque basado en conjuntos que se describe a continuación.

### La vía de escape basada en conjuntos: ExecuteUpdate

`ExecuteUpdate` se traduce directamente a SQL y nunca toca el change tracker, así que la protección de claves no se aplica:

```csharp
// .NET 10, EF Core 10.0.14
var rows = await db.Blogs
    .Where(b => b.Id == 1)
    .ExecuteUpdateAsync(s => s.SetProperty(b => b.Id, 99));
```

En un blog sin publicaciones esto devolvió `1` y el id de la fila pasó a ser `99`. En un blog que tenía una publicación que lo referenciaba, SQLite respondió con `SQLite Error 19: 'FOREIGN KEY constraint failed'`, que es exactamente lo que hará cualquier base de datos a menos que la clave foránea se haya declarado con `ON UPDATE CASCADE`. La API fluida de EF Core tiene `OnDelete` pero no un equivalente para actualizaciones, así que tendrías que agregar la cascada con `migrationBuilder.Sql(...)` en una migración. Para una corrección de datos puntual, normalmente no vale la pena; insertar, reapuntar y eliminar es más fácil de razonar.

Dos advertencias si usas `ExecuteUpdate` sobre claves. Cualquier entidad ya rastreada por el mismo contexto sigue teniendo la clave anterior, así que haz la actualización en un contexto nuevo o desvincula primero. Y se salta los interceptores de `SaveChanges` y la lógica de auditoría, que probablemente es el objetivo, pero debe ser una decisión deliberada.

## Casos especiales y errores parecidos

**Establecer `IsModified` en una clave lanza la excepción de inmediato.** El código que recorre `entry.Properties` y establece `IsModified = true` en todas ellas falla en la primera propiedad de clave. `db.Entry(blog).Property(b => b.Id).IsModified = true` lanzó la excepción en la reproducción sin ninguna llamada a `SaveChanges`. Omite las propiedades donde `p.Metadata.IsKey()` sea verdadero. Establecer la entrada completa en `EntityState.Modified` es válido (se guardó sin problemas en la reproducción), porque EF marca solo las propiedades que no son de clave.

**`Update()` sobre un objeto desvinculado con un id distinto es un error diferente.** `db.Update(new Blog { Id = 2, ... })` no intenta cambiar una clave. Envía `UPDATE ... WHERE Id = 2`, y cuando esa fila no existe obtienes `DbUpdateConcurrencyException: The database operation was expected to affect 1 row(s), but actually affected 0 row(s)`. Es el mismo error de fondo (un id incorrecto desde el cliente), con un síntoma distinto.

**Dos instancias con la misma clave también es un error diferente.** Si corriges este error adjuntando un segundo objeto con la clave nueva mientras el anterior sigue rastreado, es posible que te encuentres en cambio con [el error "cannot be tracked because another instance with the same key value is already being tracked"](/es/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/). [Comprobar si una entidad ya está rastreada](/es/2026/10/how-to-check-whether-an-entity-is-already-tracked-by-the-dbcontext-in-ef-core/) antes de adjuntarla evita ambos.

**Cambiar una clave en una entidad `Added` es válido.** Hasta el primer `SaveChanges`, la clave aún no está "guardada", así que `var b = new Blog { Id = 5 }; db.Add(b); b.Id = 6;` inserta una fila con `Id = 6`. Esto importa para el código que asigna un id provisional y lo corrige antes de guardar.

## Relacionado

Si terminas cambiando claves con sentencias basadas en conjuntos, la guía de [ExecuteUpdate y ExecuteDelete para escrituras masivas](/es/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) cubre la API y su interacción con las entidades rastreadas, y la comparación de [ExecuteUpdate frente a cargar entidades y llamar a SaveChanges](/2026/05/ef-core-executeupdate-vs-loading-entities-and-savechanges/) explica cuándo conviene cada herramienta. Cuando la mitad de eliminación de un cambio de clave falla porque los hijos aún apuntan a la fila anterior, consulta [la solución al error de restricción de clave foránea](/es/2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11/). Para ver exactamente qué entradas están a punto de guardarse antes de que se dispare la excepción, [`ChangeTracker.GetEntriesForState`](/es/2026/04/efcore-11-changetracker-getentriesforstate/) es la forma más económica de volcarlas.

## Fuentes

- [Cadena de recurso `KeyReadOnly`](https://github.com/dotnet/efcore/blob/main/src/EFCore/Properties/CoreStrings.resx) y [`InternalEntryBase.SetPropertyModified`](https://github.com/dotnet/efcore/blob/main/src/EFCore/ChangeTracking/Internal/InternalEntryBase.cs), código fuente de dotnet/efcore.
- [Support modifying the value of primary or alternate key properties, dotnet/efcore#4073](https://github.com/dotnet/efcore/issues/4073), solicitud de funcionalidad abierta.
- [Keys: alternate keys](https://learn.microsoft.com/en-us/ef/core/modeling/keys#alternate-keys), documentación de EF Core.
- [Indexes: index uniqueness](https://learn.microsoft.com/en-us/ef/core/modeling/indexes#index-uniqueness), documentación de EF Core.
- [Change detection and notifications](https://learn.microsoft.com/en-us/ef/core/change-tracking/change-detection), documentación de EF Core.
- [`PropertyValues.SetValues`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.changetracking.propertyvalues.setvalues), Microsoft Learn.
- [ExecuteUpdate and ExecuteDelete](https://learn.microsoft.com/en-us/ef/core/saving/execute-insert-update-delete), documentación de EF Core.
