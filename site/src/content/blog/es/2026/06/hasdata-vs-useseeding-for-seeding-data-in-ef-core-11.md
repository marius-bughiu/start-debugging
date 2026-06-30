---
title: "HasData vs UseSeeding para sembrar datos en EF Core 11: cual deberias usar?"
description: "Usa HasData solo para datos de referencia fijos y propios del modelo. Usa UseSeeding y UseAsyncSeeding para todo lo demas en EF Core 11. Una comparacion lado a lado con las reglas que fuerzan la decision."
pubDate: 2026-06-30
template: vs
tags:
  - "comparison"
  - "efcore"
  - "dotnet"
lang: "es"
translationOf: "2026/06/hasdata-vs-useseeding-for-seeding-data-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-06-30
---

Para sembrar datos en EF Core 11, usa `HasData` solo para tablas de referencia pequenas, fijas y deterministas que quieras versionar dentro de tus migraciones (codigos de pais, monedas, filas de busqueda tipo enum). Usa `UseSeeding` y `UseAsyncSeeding` para todo lo demas: cualquier cosa con claves generadas por la base de datos, valores calculados o no deterministas, logica condicional, propiedades de navegacion, o filas que dependen de lo que ya hay en la base de datos. El equipo de EF renombro `HasData` como "model-managed data" precisamente para desalentar su uso como herramienta de siembra general. Este articulo usa .NET 11, EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0) y C# 14.

Si solo recuerdas una linea: `HasData` participa en el modelo y en el diff de la migracion, `UseSeeding` se ejecuta como codigo ordinario contra un `DbContext` vivo. Casi todos los errores dolorosos de siembra vienen de elegir el primero cuando necesitabas el segundo.

## La matriz de funcionalidades

Esta es la tabla por la que viniste. Cada fila es una restriccion real, no una sensacion.

| Funcionalidad                    | `HasData` (model-managed data) | `UseSeeding` / `UseAsyncSeeding` |
| -------------------------------- | ------------------------------ | -------------------------------- |
| Se configura en                  | `OnModelCreating` (el modelo)  | `DbContextOptionsBuilder`        |
| Cuando se ejecuta                | Dentro del SQL de migracion (`InsertData`) | En `Migrate`/`EnsureCreated` y `dotnet ef database update` |
| Claves primarias                 | Deben especificarse a mano     | Las claves generadas por la base de datos funcionan bien |
| Valores no deterministas         | Prohibidos (re-diff en cada compilacion) | Permitidos (`Guid.NewGuid()`, `DateTime.UtcNow`) |
| Propiedades de navegacion        | No, solo claves foraneas       | Si, insercion de grafos completos |
| Logica condicional               | No                             | Si, tu escribes el `if`          |
| Llamadas externas / transformaciones | No                         | Si (hashing, HTTP, lectura de archivos) |
| Idempotencia                     | Automatica (EF hace el diff)   | Tu escribes la comprobacion de existencia |
| Capturado en control de codigo   | Si, en el snapshot de migracion | No, es codigo de arranque        |
| Actualiza filas existentes       | Si, via diff de migracion      | Solo si escribes la actualizacion |
| Disponible desde                 | EF Core 1.0 (era `HasData`)    | EF Core 9, vigente en EF Core 11 |

La fila mas importante de todas es "valores no deterministas". `HasData` se compara contra el snapshot del modelo en cada compilacion, asi que un `DateTime.UtcNow` o un `Guid.NewGuid()` en tu siembra hace que el modelo parezca cambiado cada vez, y EF lanza `PendingModelChangesWarning` o genera un goteo interminable de migraciones inutiles. Ese es el muro contra el que choca la mayoria, normalmente durante una [migracion de EF Core 6 a EF Core 11](/es/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).

## Cuando elegir HasData

`HasData` es la herramienta correcta cuando los datos son genuinamente parte del significado de tu esquema. La prueba mental: estarias comodo codificando estas filas en una constante, y casi nunca van a cambiar?

- **Tablas de busqueda fijas.** Codigos de pais ISO, codigos de moneda, estados de EE. UU., un enum de estado de pedido respaldado por una tabla. Las claves son estables, las asignas tu mismo, y quieres que los valores se entreguen y versionen con el esquema. En EF Core 11 lo configuras en `OnModelCreating`:

```csharp
// .NET 11, EF Core 11 (Microsoft.EntityFrameworkCore 11.0), C# 14
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<OrderStatus>().HasData(
        new OrderStatus { Id = 1, Name = "Pending" },
        new OrderStatus { Id = 2, Name = "Shipped" },
        new OrderStatus { Id = 3, Name = "Delivered" });
}
```

- **Datos que quieres que se hagan diff y se migren automaticamente.** Cambia `"Shipped"` por `"Dispatched"` y el siguiente `dotnet ef migrations add` emite una llamada `UpdateData`. Obtienes cambios versionados, revisables y auditables a la siembra en el mismo lugar que el esquema. Esa es una ventaja real que `UseSeeding` no te da gratis.

- **Datos sin los cuales el esquema carece de sentido.** Si una clave foranea en otra tabla apunta a `OrderStatus.Id = 2` y la fila falta, tu aplicacion esta rota. Hornearlo en la migracion garantiza que aterrice al unisono con el esquema, dentro de la misma transaccion.

Las claves deben establecerse de forma explicita y los valores deben ser deterministas. Nada de `Guid.NewGuid()`, nada de `DateTime.Now`, ninguna propiedad de navegacion (establece la columna de clave foranea directamente). Rompe cualquiera de esas y `HasData` peleara contigo en cada compilacion.

## Cuando elegir UseSeeding y UseAsyncSeeding

`UseSeeding` es el mecanismo de proposito general recomendado en EF Core 11. Es codigo de aplicacion plano con un `DbContext` vivo, asi que los limites de `HasData` simplemente no existen. Recurre a el siempre que alguna de estas sea verdadera:

- **La base de datos genera la clave.** Columnas identity, secuencias, `newsequentialid()`: con `HasData` tendrias que inventar claves a mano y rezar para que nunca colisionen con inserciones reales. `UseSeeding` deja que la base de datos las asigne.

- **El valor es calculado o no determinista.** Hashear una contrasena de admin por defecto, estampar `CreatedAt = DateTime.UtcNow`, generar un token `Guid`. Nada de esto sobrevive al diff del modelo, asi que tiene que ejecutarse en tiempo de ejecucion:

```csharp
// .NET 11, EF Core 11 (Microsoft.EntityFrameworkCore 11.0), C# 14
services.AddDbContext<AppDbContext>(options =>
    options
        .UseSqlServer(connectionString)
        .UseAsyncSeeding(async (context, _, ct) =>
        {
            if (!await context.Set<User>().AnyAsync(u => u.Email == "admin@example.com", ct))
            {
                context.Set<User>().Add(new User
                {
                    Email = "admin@example.com",
                    PasswordHash = PasswordHasher.Hash("change-me"), // runtime transform
                    CreatedAt = DateTime.UtcNow                        // non-deterministic
                });
                await context.SaveChangesAsync(ct);
            }
        })
        .UseSeeding((context, _) =>
        {
            if (!context.Set<User>().Any(u => u.Email == "admin@example.com"))
            {
                context.Set<User>().Add(new User
                {
                    Email = "admin@example.com",
                    PasswordHash = PasswordHasher.Hash("change-me"),
                    CreatedAt = DateTime.UtcNow
                });
                context.SaveChanges();
            }
        }));
```

- **Necesitas logica condicional o dependiente de los datos.** "Sembrar un tenant de demo solo en `Development`", o "insertar estas filas solo si la tabla esta vacia". Eso es un `if` ordinario, que `HasData` no puede expresar en absoluto.

- **Estas insertando un grafo de objetos a traves de propiedades de navegacion.** Un blog con tres entradas, un pedido con lineas, o [una relacion muchos a muchos](/es/2026/06/how-to-seed-a-many-to-many-relationship-in-ef-core-11/). Con `UseSeeding` construyes el grafo en C# y dejas que `SaveChanges` resuelva las claves foraneas. Con `HasData` tendrias que cablear a mano cada fila de union.

La trampa es la que la mayoria pasa por alto: tienes que implementar **ambos** overloads, y la comprobacion de existencia corre por tu cuenta. Las herramientas de EF Core (`dotnet ef database update`) solo llaman al `UseSeeding` sincrono; tu ruta de tiempo de ejecucion llama a `UseAsyncSeeding`. Implementa uno y no el otro y la siembra no hace nada silenciosamente desde la ruta que olvidaste. Para los mecanismos completos, mira [como sembrar datos con UseSeeding y UseAsyncSeeding](/es/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/).

## Que sucede realmente en disco

La forma mas clara de ver la diferencia es mirar lo que produce cada uno.

`HasData` se materializa en tu migracion. Tras `dotnet ef migrations add SeedStatuses`, el metodo `Up` generado contiene llamadas con forma de SQL literal:

```csharp
// .NET 11, EF Core 11 generated migration
migrationBuilder.InsertData(
    table: "OrderStatuses",
    columns: new[] { "Id", "Name" },
    values: new object[,]
    {
        { 1, "Pending" },
        { 2, "Shipped" },
        { 3, "Delivered" }
    });
```

Los datos son ahora un artefacto versionado. Se ejecuta una vez, dentro de la transaccion de la migracion, y EF lo rastrea en el snapshot del modelo, asi que una edicion posterior produce un `UpdateData`. Por eso exactamente un valor no determinista es veneno aqui: el snapshot nunca coincidiria, asi que EF creeria que el modelo cambio en cada compilacion.

`UseSeeding` no produce nada en disco. Es un callback que se dispara despues de que el esquema esta al dia, en cada `Migrate`, `EnsureCreated` o `dotnet ef database update`, incluidas las ejecuciones en las que no se aplico ninguna migracion. Como se ejecuta de forma incondicional, la comprobacion de existencia no es tarea opcional de mantenimiento, es lo unico que se interpone entre ti y las filas duplicadas. EF Core 11 si protege el callback con el mismo mecanismo de bloqueo de migracion que usa para las migraciones, asi que dos instancias de la aplicacion arrancando a la vez no ejecutaran ambas la siembra de forma concurrente, pero el bloqueo no hace idempotente a un `if` que falta.

## El detalle que decide por ti

Unas pocas restricciones anulan la preferencia por completo. Si alguna de estas aplica, la decision esta tomada por ti:

- **Las claves generadas por la base de datos fuerzan `UseSeeding`.** Si no puedes o no quieres codificar claves primarias a mano, `HasData` queda descartado. No tiene forma de sembrar una fila cuya clave asigna la base de datos.

- **Los valores no deterministas o calculados fuerzan `UseSeeding`.** Una contrasena hasheada, una marca de tiempo, un token aleatorio: en el momento en que aparece uno, `HasData` convierte cada compilacion en una migracion fantasma. Esta es la razon mas comun por la que los equipos arrancan `HasData`.

- **Una tabla-enum fija a la que apuntan otras filas favorece `HasData`.** Cuando la integridad referencial depende de que la siembra exista antes de cualquier dato real, la quieres dentro de la transaccion de migracion, no en un callback de arranque que podria fallar y dejar el esquema sembrado a medias.

- **Una clave requerida y generada por la base de datos con una fila `HasData` dispara un error.** Si intentas sembrar una entidad a traves de `HasData` sin suministrar su clave, EF lanza `The seed entity for entity type 'X' cannot be added because a non-zero value is required for property 'Id'`. Ese error es EF diciendote que elegiste el mecanismo equivocado: mira [la solucion para ese mensaje exacto](/es/2026/06/fix-the-seed-entity-cannot-be-added-non-zero-value-is-required-for-property/).

Puedes usar ambos en una sola aplicacion sin problema. Una division comun y sana: `HasData` para las tres tablas de busqueda sin las que tu esquema no puede funcionar, y `UseSeeding` para los datos de demo, el admin por defecto y cualquier cosa especifica de tenant. No entran en conflicto, porque se ejecutan en etapas distintas.

## La recomendacion, repetida

Por defecto usa `UseSeeding` y `UseAsyncSeeding` en EF Core 11. Son el mecanismo recomendado, manejan los datos dinamicos, con clave generada y condicionales que las aplicaciones reales realmente siembran, y fallan ruidosamente en lugar de corromper silenciosamente tu historial de migraciones. Reserva `HasData` para el caso estrecho al que fue renombrado para servir: datos de referencia pequenos, fijos y deterministas con claves asignadas a mano que genuinamente quieras versionar y diffear junto a tu esquema.

La trampa a evitar es el valor por defecto historico. Durante anos `HasData` fue la unica opcion integrada, asi que las bases de codigo recurrian a el por reflejo y luego se ahogaban en migraciones fantasma y `PendingModelChangesWarning`. Si empiezas desde cero en EF Core 11, invierte ese instinto: `UseSeeding` primero, `HasData` solo cuando puedas nombrar por que los datos pertenecen al modelo. Si mantienes entidades basadas en `records`, la misma division aplica limpiamente, ya que [los records funcionan bien con EF Core 11](/es/2026/04/how-to-use-records-with-ef-core-11-correctly/) bajo ambos mecanismos.

## Relacionado

- [Como sembrar datos con UseSeeding y UseAsyncSeeding en EF Core 11](/es/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/)
- [Como sembrar una relacion muchos a muchos en EF Core 11](/es/2026/06/how-to-seed-a-many-to-many-relationship-in-ef-core-11/)
- [Solucion: the seed entity cannot be added because a non-zero value is required for property Id](/es/2026/06/fix-the-seed-entity-cannot-be-added-non-zero-value-is-required-for-property/)
- [Migrar EF Core 6 a EF Core 11: los cambios incompatibles que de verdad muerden](/es/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)
- [Como usar records con EF Core 11 correctamente](/es/2026/04/how-to-use-records-with-ef-core-11-correctly/)

## Fuentes

- [Data Seeding - EF Core, Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/modeling/data-seeding)
- [What's New in EF Core 9: UseSeeding and UseAsyncSeeding, Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/whatsnew)
- [DbContextOptionsBuilder.UseSeeding, API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.dbcontextoptionsbuilder.useseeding)
