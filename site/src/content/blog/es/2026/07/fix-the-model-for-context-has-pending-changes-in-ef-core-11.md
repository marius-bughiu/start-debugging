---
title: "Solución: \"The model for context 'X' has pending changes\" en EF Core 11"
description: "EF Core lanza PendingModelChangesWarning cuando tu modelo ya no coincide con el último snapshot de migración. Agrega la migración o corrige el falso positivo."
pubDate: 2026-07-29
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "dotnet"
  - "dotnet-11"
  - "migration"
lang: "es"
translationOf: "2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-29
---

Ejecuta `dotnet ef migrations add <Name>` y luego `dotnet ef database update`. Desde EF Core 9.0, `Migrate()`, `MigrateAsync()` y `dotnet ef database update` comparan tu modelo actual contra el snapshot que escribió la última migración y lanzan `PendingModelChangesWarning` si difieren, y la causa abrumadoramente común es un cambio en el modelo sin una migración que lo respalde. Si la migración que acabas de generar está vacía, o es idéntica cada vez que la regeneras, tienes un falso positivo: valores no deterministas en `HasData`, un snapshot del modelo ausente, opciones de Identity que solo existen en el proyecto de inicio, o un snapshot producido por una versión anterior de EF Core. Este artículo apunta a EF Core 11.0 sobre .NET 11 (preview 6 al momento de escribir, GA en noviembre de 2026) con C# 14, y todo aplica sin cambios hasta EF Core 9.0, donde se introdujo la excepción.

## El error en contexto

La excepción en runtime, lanzada desde una llamada a `Database.Migrate()` durante el arranque:

```
Microsoft.EntityFrameworkCore.Migrations[20409]
System.InvalidOperationException: An error was generated for warning 'Microsoft.EntityFrameworkCore.Migrations.PendingModelChangesWarning': The model for context 'AppDbContext' has pending changes. Add a new migration before updating the database. See https://aka.ms/efcore-docs-pending-changes. This exception can be suppressed or logged by passing event ID 'RelationalEventId.PendingModelChangesWarning' to the 'ConfigureWarnings' method in 'DbContext.OnConfiguring' or 'AddDbContext'.
   at Microsoft.EntityFrameworkCore.Migrations.Internal.Migrator.ValidateMigrations(String targetMigration)
   at Microsoft.EntityFrameworkCore.Migrations.Internal.Migrator.Migrate(String targetMigration)
   at Microsoft.EntityFrameworkCore.RelationalDatabaseFacadeExtensions.Migrate(DatabaseFacade databaseFacade)
```

El mismo fallo desde la CLI es más corto, y el código de salida es distinto de cero:

```
Build started...
Build succeeded.
The model for context 'AppDbContext' has pending changes. Add a new migration before updating the database. See https://aka.ms/efcore-docs-pending-changes.
```

El ID de evento `20409` es `RelationalEventId.PendingModelChangesWarning` (`CoreEventId.RelationalBaseId + 409`), en la categoría de registro `Microsoft.EntityFrameworkCore.Migrations`. En EF Core 9.0.0 el mensaje no traía el enlace `aka.ms`, que es la única diferencia de redacción entre 9.0 y 11.0.

## Por qué ocurre

La verificación compara dos modelos: el modelo de tiempo de diseño que EF construye ahora mismo a partir de tu `DbContext`, y el snapshot del modelo serializado en `Migrations/AppDbContextModelSnapshot.cs` la última vez que ejecutaste `migrations add`. **No** mira tu base de datos. Eso es lo más útil que puedes saber sobre este error, porque significa que una base de datos perfectamente actualizada no te va a salvar, y una desactualizada no va a provocar el error.

La comparación es la misma que impulsa la generación de migraciones. De la propia implementación de `Migrator` en EF Core:

```csharp
// efcore/src/EFCore.Relational/Migrations/Internal/Migrator.cs, EF Core 11
public bool HasPendingModelChanges()
    => _migrationsModelDiffer.HasDifferences(
        FinalizeModel(_migrationsAssembly.ModelSnapshot?.Model)?.GetRelationalModel(),
        _designTimeModel.Model.GetRelationalModel());
```

De esa forma se desprenden dos cosas. Primero, la comparación corre sobre el modelo *relacional*, así que ve tipos de columna, longitudes, nulabilidad, índices y nombres de restricciones, no solo tus clases de entidad. Un `HasMaxLength(128)` que antes era `450` es un cambio pendiente aunque ninguna propiedad de C# haya cambiado. Segundo, si `ModelSnapshot` es `null`, el modelo de origen es `null` y cada tabla de tu modelo se lee como una diferencia.

La motivación del equipo de EF fue directa: aplicar migraciones en silencio mientras el modelo se ha desviado más allá de ellas produce una base de datos que no coincide con el código, y ese fallo aparece mucho después como una excepción de columna faltante en producción. Antes de EF Core 9.0, `Migrate()` aplicaba las migraciones que tenía y volvía sin decir nada.

## Reproducción mínima

Dos archivos y un comando olvidado:

```csharp
// .NET 11, EF Core 11.0.0, Microsoft.EntityFrameworkCore.SqlServer 11.0.0
using Microsoft.EntityFrameworkCore;

public class Blog
{
    public int Id { get; set; }
    public required string Name { get; set; }
    public string? Slug { get; set; }   // added after the last migration
}

public class AppDbContext : DbContext
{
    public DbSet<Blog> Blogs => Set<Blog>();

    protected override void OnConfiguring(DbContextOptionsBuilder options)
        => options.UseSqlServer("Server=.;Database=Demo;Trusted_Connection=True;Encrypt=False");
}
```

```csharp
// Program.cs, .NET 11
using var db = new AppDbContext();
db.Database.Migrate();   // throws PendingModelChangesWarning
```

Agrega `Slug`, sáltate `dotnet ef migrations add AddBlogSlug`, y el siguiente `Migrate()` lanza la excepción. La base de datos es irrelevante aquí: bórrala, vuelve a crearla o apunta a un servidor nuevo, y obtendrás exactamente la misma excepción.

## Solución, en orden de probabilidad

**1. Agrega la migración que olvidaste.** Esta es la solución correcta en la gran mayoría de los casos:

```bash
dotnet ef migrations add AddBlogSlug
```

Luego aplícala con `dotnet ef database update`, o deja que `Migrate()` lo haga en el siguiente arranque. EF Core 11 también junta esos dos pasos en uno, lo cual es útil cuando la aplicación corre en un contenedor que no puedes reconstruir: `dotnet ef database update AddBlogSlug --add` genera la migración, la compila con Roslyn y la aplica en un solo comando. Eso se cubre con más detalle en el artículo sobre [crear y aplicar una migración en un solo paso](/es/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/).

**2. Regenera un snapshot ausente o editado a mano.** Si alguien escribió a mano una clase de migración, o borró `AppDbContextModelSnapshot.cs`, o resolvió un conflicto de merge en él tomando un lado completo, el snapshot ya no describe el modelo que producen las migraciones. Ejecuta `dotnet ef migrations add` una vez con las herramientas: la migración generada contendrá la desviación real, y el snapshot se reescribe como efecto secundario. Nunca edites el snapshot a mano para hacer desaparecer el error, porque la siguiente migración generada se compara contra lo que hayas dejado ahí.

**3. Reemplaza los valores no deterministas de `HasData` por constantes.** Un `Guid.NewGuid()` o un `DateTime.UtcNow` dentro de un objeto de datos iniciales se evalúa cada vez que se construye el modelo, así que el modelo realmente difiere del snapshot en cada ejecución. EF Core detecta este caso específico y acompaña el error con un segundo diagnóstico:

> The model for context '{contextType}' changes each time it is built. This is usually caused by dynamic values used in a 'HasData' call (e.g. `new DateTime()`, `Guid.NewGuid()`). Add a new migration and examine its contents to locate the cause, and replace the dynamic call with a static, hardcoded value.

La solución es fijar los valores:

```csharp
// .NET 11, EF Core 11.0.0
modelBuilder.Entity<Blog>().HasData(new Blog
{
    Id = 1,
    Name = "Start Debugging",
    // Not Guid.NewGuid(), not DateTime.UtcNow.
    PublicId = Guid.Parse("9e4f49fe-0786-44c6-9061-53d2aa84fab3"),
    CreatedUtc = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc),
});
```

Regenera la migración después de corregir el modelo, ya que la anterior capturó un valor aleatorio. Si los datos realmente tienen que ser dinámicos, no pertenecen al modelo en absoluto: muévelos a `UseSeeding`/`UseAsyncSeeding`, que corre fuera del snapshot. El procedimiento completo está en [migrar de HasData a UseAsyncSeeding](/es/2026/07/migrate-from-hasdata-seeding-to-useasyncseeding-in-ef-core-11/), y las contrapartidas están detalladas en [HasData vs UseSeeding](/es/2026/06/hasdata-vs-useseeding-for-seeding-data-in-ef-core-11/).

**4. Dale a las herramientas de EF la misma configuración que tiene tu aplicación.** ASP.NET Core Identity es el caso clásico. Opciones como `Stores.SchemaVersion` o `Stores.MaxLengthForKeys` cambian el modelo, se configuran en el contenedor de DI de la aplicación, y las herramientas de EF no las ven si las ejecutas contra el proyecto del `DbContext` por sí solo. El snapshot entonces describe un modelo distinto del que construye la aplicación en ejecución. O bien pasas la aplicación como proyecto de inicio:

```bash
dotnet ef migrations add AddBlogSlug --project src/Data --startup-project src/Web
```

o implementas `IDesignTimeDbContextFactory<T>` junto al contexto para que ambos caminos construyan el modelo de forma idéntica:

```csharp
// .NET 11, EF Core 11.0.0
public class AppDbContextDesignTimeFactory : IDesignTimeDbContextFactory<AppDbContext>
{
    public AppDbContext CreateDbContext(string[] args)
    {
        var services = new ServiceCollection();
        services.AddDefaultIdentity<ApplicationUser>(options =>
            {
                options.Stores.SchemaVersion = IdentitySchemaVersions.Version2;
                options.Stores.MaxLengthForKeys = 256;
            })
            .AddEntityFrameworkStores<AppDbContext>();

        var optionsBuilder = new DbContextOptionsBuilder<AppDbContext>();
        optionsBuilder.UseApplicationServiceProvider(services.BuildServiceProvider());
        optionsBuilder.UseSqlServer();
        return new AppDbContext(optionsBuilder.Options);
    }
}
```

**5. Regenera un snapshot escrito por una versión anterior de EF Core.** La generación de snapshots mejora entre versiones, así que un snapshot producido por EF Core 6 puede diferir de un modelo de EF Core 11 incluso sin ningún cambio de código. EF Core también detecta esto, con `RelationalEventId.OldMigrationVersion` (`20414`): "Pending model changes were detected for context '{contextType}', but the model snapshot was created with EF Core version '{efVersion}'." Agrega una migración vacía para reescribir el snapshot en la versión actual, revisa que su `Up` esté genuinamente vacío, y consérvala. Este es un paso rutinario en una [migración de EF Core 6 a EF Core 11](/es/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).

**6. Suprímelo, pero solo en los dos casos donde es un falso positivo real.** Si tus migraciones se generan o se eligen dinámicamente reemplazando servicios de EF, o has verificado que no queda nada por migrar, suprime el evento específico:

```csharp
// .NET 11, EF Core 11.0.0
builder.Services.AddDbContext<AppDbContext>(options => options
    .UseSqlServer(connectionString)
    .ConfigureWarnings(w => w.Ignore(RelationalEventId.PendingModelChangesWarning)));
```

Usa `w.Log(RelationalEventId.PendingModelChangesWarning)` en su lugar si prefieres tenerlo en el registro de eventos en vez de silenciarlo. La supresión es también la única palanca cuando la última migración se generó para un proveedor distinto del que la aplica (SQLite en local, SQL Server en producción), pero Microsoft llama a eso explícitamente no soportado y con probabilidad de dejar de funcionar, así que mejor genera un conjunto de migraciones separado por proveedor.

## Cómo saber cuál causa tienes

Empieza por el comando, no por la excepción. `dotnet ef migrations has-pending-model-changes` existe desde EF Core 8.0 y sale con un código distinto de cero cuando el modelo se ha desviado, lo que lo convierte en lo correcto para ejecutar en CI antes de una implementación:

```bash
dotnet ef migrations has-pending-model-changes
```

El equivalente programático, `context.Database.HasPendingModelChanges()`, convierte la misma verificación en una prueba que falla en el pull request que olvidó la migración:

```csharp
// .NET 11, EF Core 11.0.0, xUnit v3
[Fact]
public void Model_has_no_pending_changes()
{
    using var context = new AppDbContext();
    Assert.False(context.Database.HasPendingModelChanges());
}
```

Después genera una migración y léela. El método `Up` generado es la diferencia, en términos claros: un `AddColumn` te dice qué propiedad olvidaste, un `AlterColumn` con `maxLength: 128` contra una columna heredada `nvarchar(450)` te dice que el modelo y el esquema de la base de datos no se ponen de acuerdo en el ancho, y un `InsertData` con un GUID nuevo cada vez te dice que es la causa 3. Borra la migración con `dotnet ef migrations remove` si resulta ser espuria.

Si la migración generada está vacía y el error sigue apareciendo, la comparación propia de EF está viendo algo que el generador no emite. Replica lo que hace `HasPendingModelChanges` e imprime las operaciones en crudo:

```csharp
// .NET 11, EF Core 11.0.0. Uses EF internals: pin your EF version if you keep this.
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

using var context = new AppDbContext();

var differ = context.GetService<IMigrationsModelDiffer>();
var initializer = context.GetService<IModelRuntimeInitializer>();
var snapshot = context.GetService<IMigrationsAssembly>().ModelSnapshot?.Model;

var source = snapshot is null ? null : initializer.Initialize(snapshot).GetRelationalModel();
var target = context.GetService<IDesignTimeModel>().Model.GetRelationalModel();

foreach (var operation in differ.GetDifferences(source, target))
{
    Console.WriteLine(operation.GetType().Name);
}
```

`IMigrationsModelDiffer` es una interfaz pública pero un servicio de uso interno, así que trátalo como una herramienta de depuración y no como código de producción.

## Detalles y variantes

**Revertir dejó de dispararlo en 9.0.2.** EF Core 9.0.0 y 9.0.1 lanzaban `PendingModelChangesWarning` incluso cuando apuntabas a una migración anterior explícita, lo que hacía imposible la reversión sin suprimir la advertencia. Eso se corrigió en 9.0.2: la verificación ahora solo corre cuando no se especifica una migración destino, así que `dotnet ef database update AddBlogSlug` y `dotnet ef database update 0` funcionan con cambios pendientes presentes.

**"No migrations were found in assembly" es el hermano en EF Core 11, no el mismo error.** `RelationalEventId.MigrationsNotFound` (`20406`) solía ser un registro informativo y lanza excepción por defecto a partir de EF Core 11.0. Se dispara cuando no hay migraciones en absoluto, típicamente porque llamas a `Migrate()` por costumbre mientras gestionas el esquema con DACPACs o SQL escrito a mano. Elimina la llamada a `Migrate()`, o suprime ese evento aparte con `w.Ignore(RelationalEventId.MigrationsNotFound)`.

**Cada tipo `DbContext` necesita su propia migración.** Agregar una migración para `AppDbContext` no hace nada por `AuditDbContext`. La excepción nombra el contexto, así que léela: `dotnet ef migrations add <Name> --context AuditDbContext`.

**Los proyectos multi-target necesitan `--framework` desde EF Core 10.** Si tu proyecto usa `<TargetFrameworks>`, las herramientas fallan con "The project targets multiple frameworks" antes siquiera de llegar a la comparación del modelo. Pasa `--framework net11.0`.

**`EnsureCreated()` nunca lanza esto.** No usa migraciones en absoluto, así que ni lee el snapshot ni aplica el historial de migraciones. Si mezclas `EnsureCreated()` en las pruebas con `Migrate()` en producción, solo falla el camino de producción.

**El esquema de la base de datos sigue sin verificarse.** Pasar esta verificación significa que tu modelo coincide con tu última migración. No dice nada sobre si la migración se aplicó, ni sobre si alguien editó a mano una columna en producción. Aplicar los cambios de esquema como un paso de implementación discreto, como se describe en [aplicar migraciones de EF Core 11 con un migration bundle](/es/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/), es lo que cierra esa brecha.

## Relacionados

- [Aplicar migraciones de EF Core 11 en producción con un migration bundle](/es/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) - dónde encaja la verificación `has-pending-model-changes` en una tubería de implementación.
- [Crear y aplicar una migración en un solo comando](/es/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/) - la opción `--add` de EF Core 11.
- [Migrar de HasData a UseAsyncSeeding](/es/2026/07/migrate-from-hasdata-seeding-to-useasyncseeding-in-ef-core-11/) - la solución permanente para datos iniciales que vuelven a disparar este error.
- [HasData vs UseSeeding en EF Core 11](/es/2026/06/hasdata-vs-useseeding-for-seeding-data-in-ef-core-11/) - qué mecanismo de datos iniciales pertenece al modelo y cuál no.
- [Migrar de EF Core 6 a EF Core 11](/es/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) - los otros cambios disruptivos que aparecen durante la misma actualización.

## Fuentes

- [Cambios disruptivos en EF Core 9: se lanza una excepción al aplicar migraciones si hay cambios pendientes en el modelo](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/breaking-changes) - la lista autoritativa de causas y mitigaciones, incluido el ejemplo de la factoría de tiempo de diseño para Identity.
- [Cambios disruptivos en EF Core 11: EF Core ahora lanza excepción por defecto cuando no encuentra migraciones](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/breaking-changes) - el cambio de `MigrationsNotFound`.
- [Gestionar migraciones: comprobar si hay cambios pendientes en el modelo](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/managing) - `has-pending-model-changes` y `HasPendingModelChanges()`.
- [dotnet/efcore#35285: contexto e información sobre el error PendingModelChangesWarning de 9.0](https://github.com/dotnet/efcore/issues/35285) - el propio análisis del equipo de EF sobre los falsos positivos.
- [dotnet/efcore#35342](https://github.com/dotnet/efcore/issues/35342) y su corrección en 9.0.2 - la regresión de la reversión.
- [Migrator.cs en dotnet/efcore](https://github.com/dotnet/efcore/blob/main/src/EFCore.Relational/Migrations/Internal/Migrator.cs) y [RelationalStrings.resx](https://github.com/dotnet/efcore/blob/main/src/EFCore.Relational/Properties/RelationalStrings.resx) - la comparación en sí y el texto exacto del mensaje.
