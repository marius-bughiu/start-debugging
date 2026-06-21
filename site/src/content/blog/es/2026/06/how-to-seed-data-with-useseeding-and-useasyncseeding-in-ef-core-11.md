---
title: "Cómo sembrar datos con UseSeeding y UseAsyncSeeding en EF Core 11"
description: "Siembra datos de referencia de la forma correcta en EF Core 11 con UseSeeding y UseAsyncSeeding: dónde configurarlos, cuándo se ejecutan, la comprobación de idempotencia que no puedes omitir y por qué debes implementar ambos."
pubDate: 2026-06-21
template: how-to
tags:
  - "dotnet"
  - "efcore"
  - "csharp"
lang: "es"
translationOf: "2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-06-21
---

Para sembrar datos en EF Core 11, configura `UseSeeding` y `UseAsyncSeeding` en el `DbContextOptionsBuilder`, escribe una comprobación de existencia al principio de cada callback para que la inserción solo se ejecute cuando falte la fila, y dispáralos llamando a `EnsureCreated`/`EnsureCreatedAsync`, `Migrate`/`MigrateAsync` o `dotnet ef database update`. Los callbacks se ejecutan en cada una de esas operaciones, incluso cuando no se aplicó ninguna migración, así que la comprobación de existencia es lo que te protege de insertar duplicados. Implementa tanto la sobrecarga síncrona como la asíncrona con la misma lógica, porque las herramientas de EF Core solo llaman a la síncrona. Este artículo usa .NET 11, EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0) y C# 14.

`UseSeeding` y `UseAsyncSeeding` llegaron en EF Core 9 y son el mecanismo de siembra de propósito general recomendado en EF Core 11. Reemplazan la vieja costumbre de meterlo todo en `HasData`, que el equipo de EF ha renombrado desde entonces a "model managed data" precisamente porque nunca se pensó para los datos dinámicos y dependientes de la base de datos que la mayoría de las aplicaciones quieren sembrar en realidad.

## Por qué existe UseSeeding

Durante años la respuesta a "cómo coloco datos iniciales en mi base de datos" era `HasData`. Funciona, pero tiene aristas que te cortan en cuanto tus datos son algo distinto de una tabla de búsqueda fija. `HasData` está integrado en el modelo: EF calcula las inserciones, actualizaciones y eliminaciones comparando los datos en tu snapshot de migración, así que necesita cada clave primaria escrita a mano, no puede usar claves generadas por la base de datos, y cualquier valor que no sea determinista (un `DateTime.UtcNow`, un `Guid.NewGuid()`, una contraseña con hash) hace que el modelo parezca "modificado" en cada compilación. Esa última situación es una fuente frecuente del `PendingModelChangesWarning` que sorprende a la gente durante una [migración de EF Core 6 a EF Core 11](/es/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).

`UseSeeding` es código de aplicación normal que se ejecuta contra un `DbContext` activo. Consultas, ramificas, llamas a APIs externas si lo necesitas y ejecutas `SaveChanges`. No hay snapshot del modelo, ni comparación de claves, ni requisito de determinismo. Es la herramienta correcta siempre que tus datos de siembra sean uno de estos casos: fixtures de pruebas, datos que dependen de lo que ya hay en la base de datos, blobs grandes que no quieres capturar en los snapshots de migración, filas cuyas claves genera la base de datos, o cualquier cosa que requiera una transformación como el hash de contraseñas. La guía oficial lo dice con claridad: `UseSeeding` y `UseAsyncSeeding` son la forma recomendada de sembrar en EF Core, y `HasData` queda ahora reservado para datos de referencia genuinamente estáticos como códigos de país o códigos postales.

## Dónde configurar los callbacks

Los métodos cuelgan del `DbContextOptionsBuilder`, así que van donde sea que construyas tus opciones. Los dos lugares comunes son `OnConfiguring` en el propio contexto y el registro de `AddDbContext` en `Program.cs`.

Aquí está la forma con `OnConfiguring` directamente desde una clase de contexto:

```csharp
// .NET 11, EF Core 11 (Microsoft.EntityFrameworkCore 11.0), C# 14
protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
    => optionsBuilder
        .UseSqlServer(connectionString)
        .UseSeeding((context, _) =>
        {
            var admin = context.Set<Role>().FirstOrDefault(r => r.Name == "Admin");
            if (admin is null)
            {
                context.Set<Role>().Add(new Role { Name = "Admin" });
                context.SaveChanges();
            }
        })
        .UseAsyncSeeding(async (context, _, cancellationToken) =>
        {
            var admin = await context.Set<Role>()
                .FirstOrDefaultAsync(r => r.Name == "Admin", cancellationToken);
            if (admin is null)
            {
                context.Set<Role>().Add(new Role { Name = "Admin" });
                await context.SaveChangesAsync(cancellationToken);
            }
        });
```

El `context` que recibe el callback es un `DbContext` totalmente funcional, así que `context.Set<T>()` te da la misma superficie de consulta y seguimiento que usas en todas partes. El parámetro descartado `_` es un `bool` que te indica si EF creó la base de datos durante esta operación; la mayoría de los sembradores lo ignoran.

En una aplicación ASP.NET Core típica configuras lo mismo durante el registro de la inyección de dependencias. Fíjate en que las firmas son idénticas; solo cambia el anfitrión:

```csharp
// Program.cs -- .NET 11, ASP.NET Core 11, EF Core 11
builder.Services.AddDbContext<AppDbContext>(options =>
    options
        .UseSqlServer(builder.Configuration.GetConnectionString("Default"))
        .UseSeeding((context, _) => SeedRoles(context))
        .UseAsyncSeeding(async (context, _, ct) => await SeedRolesAsync(context, ct)));
```

Mover el cuerpo a métodos con nombre (`SeedRoles`, `SeedRolesAsync`) mantiene el registro legible y te da un lugar obvio donde vive toda la lógica de siembra, que era gran parte del propósito de la característica.

## Cuándo se ejecutan realmente los callbacks

Este es el detalle que confunde a la gente, así que vale la pena enunciarlo con precisión. Los callbacks de siembra se invocan como parte de:

- `context.Database.EnsureCreated()` llama a `UseSeeding`.
- `context.Database.EnsureCreatedAsync()` llama a `UseAsyncSeeding`.
- `context.Database.Migrate()` y `MigrateAsync()` los llaman.
- `dotnet ef database update` los llama.

Lo crucial es que se ejecutan en **cada** invocación de esas operaciones, incluso cuando no hubo cambios en el modelo ni se aplicaron migraciones. Llamar a `Migrate()` sobre una base de datos ya actualizada dispara igualmente el callback de siembra. Esto es intencional, y es lo más importante que debes interiorizar: el framework no recuerda que sembró la última vez para saltarte. Tu callback es responsable de decidir si hay algo que hacer.

Por eso cada ejemplo de arriba empieza con una consulta. La forma es siempre la misma: busca la fila, inserta solo si está ausente. Omite la comprobación e insertarás "Admin" en cada arranque que llame a `Migrate`, y en una semana tendrás una tabla llena de roles de administrador duplicados.

## La comprobación de idempotencia no es opcional

Como el callback se vuelve a ejecutar, tu lógica de siembra debe ser idempotente: ejecutarla una vez y ejecutarla diez veces tiene que dejar la base de datos en el mismo estado. La guarda `FirstOrDefault`/`if (x is null)` de los ejemplos es la forma mínima. Para un lote de filas, consulta el conjunto que ya tienes e inserta solo la diferencia:

```csharp
// .NET 11, EF Core 11, C# 14 -- idempotent batch seed
static void SeedRoles(DbContext context)
{
    string[] required = ["Admin", "Editor", "Viewer"];

    var existing = context.Set<Role>()
        .Where(r => required.Contains(r.Name))
        .Select(r => r.Name)
        .ToHashSet();

    var missing = required
        .Where(name => !existing.Contains(name))
        .Select(name => new Role { Name = name })
        .ToList();

    if (missing.Count > 0)
    {
        context.Set<Role>().AddRange(missing);
        context.SaveChanges();
    }
}
```

Un viaje de ida y vuelta para leer lo que existe, uno para escribir solo lo nuevo, y nada en absoluto ocurre una vez que la tabla está completamente poblada. Esa última propiedad importa: un sembrador que ejecuta un `SaveChanges` en cada arranque, aunque sea sin efecto, es un desperdicio y ensucia tus registros. Calcula primero la diferencia, escribe solo cuando `missing.Count > 0`.

No te apoyes en un índice único más una excepción tragada como tu "idempotencia". Eso convierte cada reinicio después del primero en una `DbUpdateException` capturada, que es lenta, contamina los registros y oculta fallos reales. Consulta primero.

## Por qué debes implementar ambas sobrecargas

La nota en la documentación es fácil de pasar por alto y cara de ignorar: las herramientas de EF Core dependen actualmente del método **síncrono** `UseSeeding`, y no sembrarán correctamente si solo implementas `UseAsyncSeeding`. Así que cuando ejecutas `dotnet ef database update`, es el callback síncrono el que se dispara, sin importar lo asíncrono que sea el código de tu aplicación.

Lo contrario también se cumple. Si tu aplicación arranca con `await context.Database.MigrateAsync()` (el arranque asíncrono idiomático), esa ruta llama a `UseAsyncSeeding`, no a `UseSeeding`. Implementa solo el síncrono y la siembra del propio arranque de tu aplicación no hará nada en silencio mientras tu siembra desde la CLI funciona, o viceversa.

La regla segura: implementa ambos, con lógica idéntica. Factoriza el cuerpo en un método compartido para que los dos callbacks no puedan divergir:

```csharp
// .NET 11, EF Core 11, C# 14
options
    .UseSeeding((context, _) => SeedRoles(context))
    .UseAsyncSeeding((context, _, ct) => SeedRolesAsync(context, ct));

// sync and async bodies kept in lockstep
static void SeedRoles(DbContext context) { /* query, branch, SaveChanges */ }

static async Task SeedRolesAsync(DbContext context, CancellationToken ct)
{
    // same query, same branch, SaveChangesAsync(ct)
}
```

Resiste la tentación de implementar uno bloqueando sobre el otro (`SeedRolesAsync(context, ct).GetAwaiter().GetResult()` dentro del callback síncrono, o `Task.Run` alrededor del cuerpo síncrono en el asíncrono). El sync-over-async invita a interbloqueos bajo algunos contextos de sincronización, y el async-over-sync simplemente miente sobre ser asíncrono. Escribe los dos cuerpos por separado; son cortos.

## La concurrencia está resuelta, pero solo para el cuerpo de la siembra

Una propiedad genuinamente agradable: el código dentro de `UseSeeding` y `UseAsyncSeeding` está protegido por el mecanismo de bloqueo de migraciones de EF Core. Cuando dos instancias de tu aplicación arrancan en el mismo momento y ambas llaman a `Migrate`, el bloqueo las serializa, de modo que no pasan ambas más allá de la comprobación de existencia ni hacen una doble inserción. Esta es una ventaja real sobre la siembra de arranque hecha a mano, donde tendrías que construir esa coordinación tú mismo.

La protección cubre el callback de siembra en concreto. No convierte toda tu aplicación en un sistema de un solo escritor, ni protege datos que escribas fuera de la ruta de siembra. Trátala exactamente por lo que es: una guarda que hace que el paso de siembra sea seguro de ejecutar desde muchas instancias de forma concurrente.

## Cuándo UseSeeding es la elección equivocada

`UseSeeding` no es un martillo para todo clavo. Dos casos te empujan a otra parte.

Primero, los datos de referencia genuinamente estáticos que nunca cambian fuera de una migración de esquema -- siendo el ejemplo canónico una tabla de códigos postales o códigos de país ISO -- siguen siendo mejor atendidos por `HasData`. Viajan con la migración, quedan versionados junto al esquema y no requieren una consulta en tiempo de ejecución en cada arranque. Recurre a `HasData` cuando los datos sean fijos, deterministas, pequeños y te parezca bien que sean propiedad de las migraciones.

Segundo, la siembra que necesita dos instancias distintas de `DbContext` dentro de una transacción no puede expresarse limpiamente en un único callback de `UseSeeding`, que recibe un solo contexto. Para eso, la documentación te remite de nuevo a la lógica de inicialización personalizada normal: abre los contextos tú mismo, ejecuta el trabajo y, sobre todo, mantenlo fuera de la ruta normal de las solicitudes para no toparte con problemas de concurrencia ni exigir que la aplicación en ejecución tenga permisos para modificar el esquema.

```csharp
// .NET 11, EF Core 11 -- custom initialization, run once at deploy time
await using var context = new AppDbContext();
await context.Database.MigrateAsync();

if (!await context.Roles.AnyAsync())
{
    context.Roles.AddRange(new Role { Name = "Admin" }, new Role { Name = "Viewer" });
    await context.SaveChangesAsync();
}
```

Vale la pena repetir la advertencia de la documentación: la siembra en general no debería ser parte de la ejecución normal de la aplicación. Ejecutarla en el arranque de cada instancia significa que cada instancia necesita permiso de escritura y que estás confiando en el bloqueo para la corrección. En producción, un paso de inicialización dedicado de una sola vez en el momento del despliegue es más limpio. `UseSeeding` brilla para el desarrollo local, las pruebas y el tipo de datos de referencia pequeños e idempotentes donde la consulta por arranque es barata.

## Juntándolo todo

El modelo mental es corto. `UseSeeding` y `UseAsyncSeeding` son código de aplicación que EF Core llama en `EnsureCreated`, `Migrate` y `dotnet ef database update`. Se ejecutan cada vez, así que tu primera línea es siempre una comprobación de existencia y tu escritura solo ocurre para las filas que faltan. Implementas ambas sobrecargas porque las herramientas y tu ruta de arranque asíncrona llaman a diferentes. El cuerpo de la siembra está protegido por bloqueo para que los arranques concurrentes no colisionen. Y `HasData` sigue ahí para el caso estrecho de datos de referencia estáticos, deterministas y propiedad de las migraciones.

Si estás afinando el resto de tu capa de datos de EF Core 11, el mismo cuidado sobre qué se ejecuta y cuándo aparece en otros lugares: mira cómo los [interceptores de EF Core 11 manejan la auditoría](/es/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/) en el punto de estrangulamiento de `SaveChanges`, cuándo preferir [ExecuteUpdate frente a cargar entidades y llamar a SaveChanges](/es/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) para escrituras masivas, y por qué [AsNoTracking frente a AsNoTrackingWithIdentityResolution](/es/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/) importa en consultas con muchas lecturas. Si tu inserción de siembra alguna vez tropieza con [el tipo de entidad requiere que se defina una clave primaria](/es/2026/06/fix-the-entity-type-requires-a-primary-key-to-be-defined/), ese es un problema de modelado que hay que arreglar antes de que el sembrador se ejecute.

Fuentes: la [documentación de siembra de datos](https://learn.microsoft.com/en-us/ef/core/modeling/data-seeding) de EF Core en Microsoft Learn cubre la API de `UseSeeding`/`UseAsyncSeeding`, los tiempos de ejecución, el requisito de ambas sobrecargas y la garantía del bloqueo de migración; la referencia de la API de [DbContextOptionsBuilder.UseSeeding](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.dbcontextoptionsbuilder.useseeding) documenta las firmas exactas.
