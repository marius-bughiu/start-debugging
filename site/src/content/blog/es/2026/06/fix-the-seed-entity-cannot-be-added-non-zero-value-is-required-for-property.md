---
title: "Solución: The seed entity for entity type 'X' cannot be added because a non-zero value is required for property 'Id'"
description: "HasData siembra una entidad con clave generada por el almacén pero sin valor explícito. Da a cada fila un Id estable distinto de cero, o usa UseSeeding para claves generadas."
pubDate: 2026-06-25
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
lang: "es"
translationOf: "2026/06/fix-the-seed-entity-cannot-be-added-non-zero-value-is-required-for-property"
translatedBy: "claude"
translationDate: 2026-06-25
---

La solución: llamaste a `HasData` para sembrar una entidad cuya clave primaria es generada por el almacén (una columna `IDENTITY`), pero dejaste la clave en su valor por defecto de CLR (`0` para `int`, `Guid.Empty` para `Guid`). `HasData` construye su script de inserción en tiempo de migración sin tocar la base de datos, así que no puede confiar en que la base de datos reparta las claves. Da a cada fila sembrada un valor de clave explícito, estable y distinto de cero (`new Country { Id = 1, ... }`). Si de verdad quieres que la base de datos genere la clave, no uses `HasData` en absoluto: usa `UseSeeding`/`UseAsyncSeeding` en su lugar. Esta guía está escrita para .NET 11, C# 14 y `Microsoft.EntityFrameworkCore` 11.0.0, pero el texto del mensaje y el comportamiento no han cambiado desde EF Core 2.1.

```text
System.InvalidOperationException: The seed entity for entity type 'Country' cannot be added
because a non-zero value is required for property 'Id'. Consider providing a negative value
to avoid collisions with non-seed data.
   at Microsoft.EntityFrameworkCore.Metadata.Internal.EntityType.<>c__DisplayClass...
   at Microsoft.EntityFrameworkCore.Infrastructure.ModelValidator.ValidateData(IModel model, ...)
   at Microsoft.EntityFrameworkCore.Infrastructure.ModelValidator.Validate(IModel model, ...)
   at Microsoft.EntityFrameworkCore.Metadata.Conventions.Infrastructure.ModelRuntimeInitializer.Initialize(...)
```

Este es un error de validación del modelo, no un error de consulta en tiempo de ejecución. Se dispara la primera vez que EF Core construye tu modelo: la primera consulta, el primer `SaveChanges`, el primer acceso a `context.Model` o, lo más habitual, cuando ejecutas `dotnet ef migrations add`. El nombre de tipo entre comillas es la entidad que sembraste; la propiedad entre comillas es su clave primaria. La pista "consider providing a negative value" al final es un consejo real, no relleno, y la sección de más abajo sobre colisiones explica por qué.

## Por qué HasData necesita la clave escrita de forma explícita

`HasData` (la documentación ahora lo llama [model managed data](https://learn.microsoft.com/en-us/ef/core/modeling/data-seeding), ya que "seeding" prometía más de lo que hace) pertenece a las migraciones. Cuando agregas una migración, EF Core compara las filas sembradas en tu modelo actual con las filas que registró en la última instantánea del modelo, y emite llamadas a `InsertData`, `UpdateData` o `DeleteData` para conciliarlas. Esa comparación ocurre en tiempo de diseño, en tu máquina, sin conexión a la base de datos.

La clave primaria es lo que hace posible la comparación. EF Core la usa para reconocer "esta es la misma fila que inserté en la migración anterior, pero cambió el Name" frente a "esta es una fila completamente nueva". Sin un valor de clave estable, no tiene nada con qué emparejar entre migraciones. Por eso el validador del modelo impone una regla estricta: cada fila de `HasData` debe llevar un valor explícito para su clave primaria, incluso cuando esa clave esté configurada como generada por el almacén.

Cuando la clave es generada por el almacén y la dejas en el valor por defecto de CLR, EF Core no puede distinguir entre "el desarrollador olvidó establecer la clave" y "el desarrollador quiere la clave 0". En vez de insertar silenciosamente una fila con `Id = 0` (que choca de forma grave con las columnas identity), lanza una excepción. La [lista de limitaciones de model managed data](https://learn.microsoft.com/en-us/ef/core/modeling/data-seeding) lo pone primero: "El valor de la clave primaria debe especificarse aunque normalmente lo genere la base de datos. Se usará para detectar cambios de datos entre migraciones."

## El repro más pequeño

Una sola entidad con un `Id` convencional y una llamada a `HasData` que lo omite.

```csharp
// .NET 11, C# 14, Microsoft.EntityFrameworkCore 11.0.0
public class Country
{
    public int Id { get; set; }      // conventional PK -> store-generated IDENTITY
    public string Name { get; set; } = "";
}

public class AppDbContext : DbContext
{
    public DbSet<Country> Countries => Set<Country>();

    protected override void OnConfiguring(DbContextOptionsBuilder options)
        => options.UseSqlServer("Server=(localdb)\\mssqllocaldb;Database=SeedRepro;Trusted_Connection=True");

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Country>().HasData(
            new Country { Name = "USA" },      // no Id -> Id stays 0 -> throws
            new Country { Name = "Canada" });
    }
}
```

Ejecuta `dotnet ef migrations add Seed` contra esto y obtienes la excepción. Las propiedades `Id` valen `0`, EF Core trata `0` como "sin valor" para una clave `int` generada por el almacén, y la validación falla antes de que se escriba ningún código de migración.

## Solución 1: da a cada fila sembrada una clave explícita y estable

Esta es la solución correcta para datos de referencia genuinos: tablas de búsqueda pequeñas y fijas que solo cambian a través de migraciones (países, monedas, roles, estados). Asigna a cada fila un valor de clave a mano y nunca lo reutilices ni lo renumeres.

```csharp
// .NET 11, C# 14, EF Core 11.0.0
modelBuilder.Entity<Country>().HasData(
    new Country { Id = 1, Name = "USA" },
    new Country { Id = 2, Name = "Canada" },
    new Country { Id = 3, Name = "Mexico" });
```

Dos reglas mantienen esto funcionando con el tiempo:

1. **Los valores de clave ahora forman parte del historial de tu esquema.** Trátalos como inmutables. Si cambias la fila 2 de `Id = 2` a `Id = 22`, la siguiente migración emite un `DeleteData` para `2` y un `InsertData` para `22`, lo que descarta la fila antigua y todo lo que la referenciaba por clave foránea.
2. **Elige los valores de forma explícita, no dejes que cambien solos.** Las constantes codificadas a mano están bien. Lo que no debes hacer es calcularlas a partir de algo no determinista (un contador de bucle que depende del orden de la colección, `DateTime.Now`, una llamada a `Guid.NewGuid()`), porque la comparación de la migración debe producir los mismos valores en cada máquina.

Si la clave es un `Guid`, se aplica la misma regla: proporciona un `Guid` fijo y codificado a mano, no `Guid.NewGuid()`. Un GUID recién generado en cada compilación hace que cada migración crea que la fila cambió.

```csharp
// .NET 11, C# 14, EF Core 11.0.0 - fixed GUIDs, not Guid.NewGuid()
modelBuilder.Entity<Role>().HasData(
    new Role { Id = new Guid("3f2504e0-4f89-41d3-9a0c-0305e82c3301"), Name = "Admin" },
    new Role { Id = new Guid("3f2504e0-4f89-41d3-9a0c-0305e82c3302"), Name = "User" });
```

## Solución 2: usa claves negativas para esquivar colisiones de identity

La propia pista de la excepción, "consider providing a negative value to avoid collisions with non-seed data", resuelve un problema que aparece más adelante, no el que tienes delante. Cuando siembras `Id = 1, 2, 3` en una columna `IDENTITY` de SQL Server, el contador de identity no sabe nada de tus filas sembradas. El primer `INSERT` real tras la siembra empieza el contador en `1`, intenta usar una clave que tu siembra ya tomó, y falla con una violación de clave primaria, o se involucra la maquinaria de `IDENTITY_INSERT` y todo se complica.

Las claves negativas para los datos sembrados evitan esto. Las filas reales generadas por el usuario cuentan hacia arriba desde `1`; tus filas de referencia sembradas viven por debajo de `0` y nunca se solapan.

```csharp
// .NET 11, C# 14, EF Core 11.0.0
modelBuilder.Entity<Country>().HasData(
    new Country { Id = -1, Name = "USA" },
    new Country { Id = -2, Name = "Canada" },
    new Country { Id = -3, Name = "Mexico" });
```

Esta es la recomendación de larga data del equipo de EF Core para tablas de búsqueda respaldadas por `IDENTITY` que también reciben inserciones en tiempo de ejecución. Es excesivo para una tabla que *solo* se siembra (una tabla de búsqueda pura en la que la aplicación nunca inserta), donde las claves positivas se leen de forma más natural.

## Solución 3: deja de usar HasData para estos datos

Si tu razón para recurrir a `HasData` era "solo quiero algunas filas iniciales en la base de datos", probablemente no quieres model managed data en absoluto. `HasData` está hecho para datos estáticos, deterministas y propiedad de las migraciones, y nada más. Para datos que deban usar claves generadas por la base de datos, dependan de otras filas, o sean simplemente datos de arranque convenientes, el equipo de EF Core ahora recomienda [UseSeeding y UseAsyncSeeding](/es/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/), introducidos en EF Core 9. Estos ejecutan un `SaveChanges` real contra una base de datos en vivo, así que la base de datos genera las claves y la regla de no-cero nunca se aplica.

```csharp
// .NET 11, C# 14, EF Core 11.0.0
protected override void OnConfiguring(DbContextOptionsBuilder options)
    => options
        .UseSqlServer(connectionString)
        .UseSeeding((context, _) =>
        {
            if (!context.Set<Country>().Any())
            {
                // No Id set: the database generates it on SaveChanges. No error.
                context.Set<Country>().AddRange(
                    new Country { Name = "USA" },
                    new Country { Name = "Canada" });
                context.SaveChanges();
            }
        })
        .UseAsyncSeeding(async (context, _, ct) =>
        {
            if (!await context.Set<Country>().AnyAsync(ct))
            {
                context.Set<Country>().AddRange(
                    new Country { Name = "USA" },
                    new Country { Name = "Canada" });
                await context.SaveChangesAsync(ct);
            }
        });
```

`UseSeeding` se llama desde `EnsureCreated` y `Migrate` y desde `dotnet ef database update`, incluso cuando no hay migraciones pendientes. Implementa ambas sobrecargas, la sync y la async: las herramientas de EF Core llaman a la síncrona, y omitirá la siembra silenciosamente si solo existe la versión async. Como el cuerpo de la siembra se ejecuta como código de aplicación sin el requisito de clave en tiempo de diseño, omitir `Id` es exactamente lo correcto aquí: la base de datos lo asigna.

## Variantes que producen el mismo error

La redacción del mensaje es idéntica en todos estos casos, así que el tráfico de búsqueda aterriza aquí para todos ellos. La causa es siempre la misma (una fila de `HasData` a la que le falta un valor de clave explícito generado por el almacén), pero la superficie difiere.

- **Entidades propiedad (owned) y tipos complejos.** `OwnsOne(...).HasData(...)` necesita la clave del *propietario* en cada fila sembrada, suministrada mediante un objeto anónimo: `new { CountryId = 1, ... }`. Omítela y obtienes el error de no-cero contra la propiedad de clave del propietario.
- **Filas de tabla de unión muchos-a-muchos.** Sembrar la tabla de unión con `UsingEntity(...).HasData(...)` requiere ambas claves foráneas en cada fila. Un lado faltante o en cero lanza este mismo error. Consulta [cómo sembrar una relación muchos-a-muchos en EF Core 11](/es/2026/06/how-to-seed-a-many-to-many-relationship-in-ef-core-11/) para la configuración completa de la entidad de unión.
- **Claves compuestas.** Cada columna de la clave compuesta debe estar establecida en cada fila sembrada. Un cero en cualquiera de las partes dispara el error para esa propiedad.
- **Claves con conversión de valor.** Un ID fuertemente tipado (un `record struct CountryId(int Value)`) respaldado por un conversor de valor sigue necesitando un valor distinto del por defecto. La instancia por defecto se convierte al valor por defecto del almacén, que cuenta como "sin valor".

Un error distinto pero fácil de confundir es `The seed entity for entity type 'X' cannot be added because there was no value provided for the required property 'Y'`, donde `Y` es una propiedad requerida que no es clave, como `Name`. Ese significa que una columna `[Required]` o `IsRequired()` quedó nula en una fila sembrada, no que falte la clave. La solución allí es rellenar la propiedad no clave que falta.

Si el modelo nunca llega a construirse lo suficiente como para validar los datos sembrados porque EF Core ni siquiera encuentra una clave para el tipo, estás ante un problema distinto: consulta la solución para [the entity type requires a primary key to be defined](/es/2026/06/fix-the-entity-type-requires-a-primary-key-to-be-defined/).

## Por qué "simplemente pon Id = 0 de forma explícita" no funciona

Una falsa solución tentadora es escribir `new Country { Id = 0, Name = "USA" }` y suponer que ser explícito satisface al validador. No lo hace. Para una clave generada por el almacén, EF Core compara el valor con el valor por defecto de CLR, y `0` *es* el valor por defecto para `int`. El validador no puede distinguir tu `0` deliberado de un campo sin establecer, así que sigue lanzando la excepción. Los únicos valores que pasan son los distintos del por defecto: cualquier `int` distinto de cero, cualquier `Guid` no vacío, cualquier compuesto distinto del por defecto. Si de verdad necesitas una fila con clave `0`, es señal de que la clave no debería ser generada por el almacén; márcala con `ValueGeneratedNever()` y el validador deja de aplicar la regla de no-cero, porque la clave ahora es enteramente tu responsabilidad.

```csharp
// .NET 11, C# 14, EF Core 11.0.0 - opt out of store generation, then 0 is allowed
modelBuilder.Entity<Country>(b =>
{
    b.Property(c => c.Id).ValueGeneratedNever();
    b.HasData(new Country { Id = 0, Name = "Unknown" });   // now valid
});
```

Ese es un patrón real para una fila centinela "desconocido", pero hazlo de forma deliberada: una vez que la clave sea `ValueGeneratedNever`, cada inserción futura en esa tabla debe suministrar su propia clave, incluidas las inserciones en tiempo de ejecución desde tu aplicación.

## Relacionados

- [Cómo sembrar datos con UseSeeding y UseAsyncSeeding en EF Core 11](/es/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/) cubre la ruta moderna de siembra en tiempo de ejecución que evita este error por completo.
- [Cómo sembrar una relación muchos-a-muchos en EF Core 11](/es/2026/06/how-to-seed-a-many-to-many-relationship-in-ef-core-11/) recorre el `HasData` de la entidad de unión donde este error suele aparecer.
- [Solución: The entity type 'X' requires a primary key to be defined](/es/2026/06/fix-the-entity-type-requires-a-primary-key-to-be-defined/) es el error previo cuando EF Core ni siquiera puede descubrir una clave.
- [Migrar de EF Core 6 a EF Core 11: cambios disruptivos que de verdad muerden](/es/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) cubre qué más cambió si estás actualizando una configuración de siembra antigua.

## Fuentes

- La [documentación de data seeding](https://learn.microsoft.com/en-us/ef/core/modeling/data-seeding) de EF Core en Microsoft Learn: la sección de "model managed data", su lista de limitaciones ("el valor de la clave primaria debe especificarse aunque normalmente lo genere la base de datos"), y la alternativa `UseSeeding`/`UseAsyncSeeding`.
- [dotnet/efcore #27871, "Warn when seeding with a 0 key"](https://github.com/dotnet/efcore/issues/27871): la discusión del equipo sobre el caso de clave cero detrás de esta excepción.
- [dotnet/EntityFramework.Docs #1528](https://github.com/dotnet/EntityFramework.Docs/issues/1528): la justificación de las claves de siembra negativas en tablas respaldadas por `IDENTITY`.
