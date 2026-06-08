---
title: "Cómo usar los interceptores de EF Core 11 para auditoría"
description: "Marca columnas CreatedBy/ModifiedOn y escribe un rastro completo de cambios con un ISaveChangesInterceptor en EF Core 11, incluyendo los detalles de inyección de dependencias, usuario actual y ExecuteUpdate."
pubDate: 2026-06-08
template: how-to
tags:
  - "dotnet"
  - "efcore"
  - "csharp"
lang: "es"
translationOf: "2026/06/how-to-use-ef-core-11-interceptors-for-auditing"
translatedBy: "claude"
translationDate: 2026-06-08
---

Para auditar cambios en EF Core 11, implementa `ISaveChangesInterceptor` (o deriva de la clase base sin operaciones `SaveChangesInterceptor`), sobrescribe `SavingChangesAsync` para recorrer `context.ChangeTracker.Entries()` antes de que la escritura llegue a la base de datos, y regístralo con `optionsBuilder.AddInterceptors(...)`. Dentro del interceptor, o bien marcas columnas de auditoría (`CreatedBy`, `CreatedOnUtc`, `ModifiedBy`, `ModifiedOnUtc`) en las entidades que implementan un marcador `IAuditable`, o bien construyes una fila de rastro de cambios por cada propiedad modificada. Todo esto se ejecuta dentro de la misma transacción que tu `SaveChanges`, así que un fallo de auditoría revierte la escritura de negocio junto con él. Este artículo usa .NET 11, EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0) y C# 14.

Los interceptores son la herramienta correcta aquí precisamente porque se sitúan en el punto de paso obligatorio por el que debe pasar toda escritura. No puedes olvidarte de llamarlos, no puedes saltártelos desde algún método de repositorio olvidado, y ven el `ChangeTracker` completamente poblado con los valores originales y actuales de cada propiedad. Esos son exactamente los datos que necesita un registro de auditoría.

## Por qué un interceptor supera a sobrescribir SaveChanges

La respuesta folclórica a "marca mis marcas de tiempo" es sobrescribir `SaveChanges` en un `DbContext` base:

```csharp
// The pattern people reach for first -- it works, but it has problems
public override int SaveChanges()
{
    foreach (var entry in ChangeTracker.Entries<IAuditable>())
    {
        if (entry.State == EntityState.Added)
            entry.Entity.CreatedOnUtc = DateTime.UtcNow;
    }
    return base.SaveChanges();
}
```

Esto acopla la auditoría a tu subclase de `DbContext`. En el momento en que tengas un segundo contexto, una biblioteca que trae su propio contexto, o una prueba que usa un `DbContext` desnudo, el comportamiento desaparece en silencio. También te obliga a sobrescribir manualmente tanto `SaveChanges` como `SaveChangesAsync`, y no te deja un lugar limpio para inyectar el usuario actual sin hacer que el contexto sea consciente de cuestiones HTTP.

Un `ISaveChangesInterceptor` es una clase separada, comprobable y de responsabilidad única. La registras una vez, se aplica a cada contexto al que está adjunto, y EF Core llama a la variante sync o async automáticamente según qué sobrecarga de `SaveChanges` usó quien llama. La documentación oficial de EF Core describe los interceptores como el punto de enganche soportado para exactamente este tipo de cuestión transversal, consulta la [guía de interceptores de Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/interceptors).

## La superficie del interceptor que realmente usas

`ISaveChangesInterceptor` define seis métodos, tres sync y tres async:

- `SavingChanges` / `SavingChangesAsync`: se disparan antes de que EF genere y envíe el SQL. Aquí es donde va el trabajo de auditoría, porque el `ChangeTracker` aún refleja lo que estableció la aplicación.
- `SavedChanges` / `SavedChangesAsync`: se disparan tras una escritura exitosa. Úsalos para capturar valores generados por la base de datos (claves de identidad, columnas calculadas) que no se conocían antes de la escritura.
- `SaveChangesFailed` / `SaveChangesFailedAsync`: se disparan cuando la escritura lanza una excepción, para que puedas marcar como fallida una fila de auditoría en curso.

Rara vez implementas la interfaz directamente. Deriva de `SaveChangesInterceptor`, que provee implementaciones virtuales sin operaciones de los seis, y sobrescribe solo lo que necesites.

```csharp
// .NET 11, EF Core 11, C# 14
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;

public sealed class AuditableEntityInterceptor : SaveChangesInterceptor
{
    public override ValueTask<InterceptionResult<int>> SavingChangesAsync(
        DbContextEventData eventData,
        InterceptionResult<int> result,
        CancellationToken cancellationToken = default)
    {
        StampAuditColumns(eventData.Context);
        return base.SavingChangesAsync(eventData, result, cancellationToken);
    }

    public override InterceptionResult<int> SavingChanges(
        DbContextEventData eventData,
        InterceptionResult<int> result)
    {
        StampAuditColumns(eventData.Context);
        return base.SavingChanges(eventData, result);
    }

    private static void StampAuditColumns(DbContext? context)
    {
        if (context is null) return;
        // implementation below
    }
}
```

Dos detalles que confunden a la gente. Primero, `eventData.Context` es anulable, así que protégelo. Segundo, debes sobrescribir tanto `SavingChanges` como `SavingChangesAsync`; EF Core no redirige uno hacia el otro. Si solo sobrescribes la versión async y en algún lugar de tu ruta de código se llama al `SaveChanges()` síncrono, tu lógica de auditoría nunca se ejecuta. Sobrescribir ambos con un método privado compartido es la opción segura por defecto. Si quieres forzar todo hacia la ruta async, lanza `NotSupportedException` desde la sobrescritura sync para que una llamada síncrona perdida falle a las claras en lugar de saltarse la auditoría en silencio.

El valor de retorno `InterceptionResult<int>` es la forma en que suprimirías o reemplazarías el guardado. Para auditoría casi nunca quieres eso, así que pasar el `result` entrante directamente (que es lo que hace `base.Saving...`) es lo correcto.

## Marcar columnas de auditoría en entidades auditables

El patrón ligero: una interfaz marcadora más propiedades sombra o reales. Define el contrato una vez.

```csharp
// .NET 11, C# 14
public interface IAuditable
{
    DateTime CreatedOnUtc { get; set; }
    string? CreatedBy { get; set; }
    DateTime? ModifiedOnUtc { get; set; }
    string? ModifiedBy { get; set; }
}
```

Ahora completa `StampAuditColumns`. La llamada clave es `ChangeTracker.Entries<IAuditable>()`, que devuelve solo las entidades rastreadas que implementan la interfaz, ya particionadas por `EntityState`.

```csharp
// .NET 11, EF Core 11, C# 14
private void StampAuditColumns(DbContext? context)
{
    if (context is null) return;

    var now = _timeProvider.GetUtcNow().UtcDateTime; // TimeProvider, .NET 8+
    var user = _currentUser.UserId ?? "system";

    foreach (var entry in context.ChangeTracker.Entries<IAuditable>())
    {
        switch (entry.State)
        {
            case EntityState.Added:
                entry.Entity.CreatedOnUtc = now;
                entry.Entity.CreatedBy = user;
                break;

            case EntityState.Modified:
                entry.Entity.ModifiedOnUtc = now;
                entry.Entity.ModifiedBy = user;
                break;

            case EntityState.Deleted:
                // optional: convert hard delete to soft delete here
                break;
        }
    }
}
```

Un matiz que vale la pena señalar: una entidad cuya única propiedad modificada es la pertenencia a una colección propia, o cuyo cambio es a una entidad relacionada, puede aparecer aquí como `Modified`. Si quieres ignorar lo "modificado solo porque un hijo cambió", puedes comprobar además `entry.Properties.Any(p => p.IsModified)`. Para la mayoría de los casos de columnas de auditoría, la comprobación simple de `State` es lo que quieres.

Inyecta `TimeProvider` en lugar de llamar a `DateTime.UtcNow` directamente. Hace que el interceptor sea comprobable con un reloj falso, lo que importa porque la marca de tiempo es lo que más quieres verificar en las pruebas.

## Registrar el interceptor con el ciclo de vida correcto

Aquí está el detalle que genera más reportes de errores. El interceptor necesita el usuario actual, que normalmente viene de `IHttpContextAccessor`. Eso hace que el interceptor sea efectivamente scoped (por solicitud). Pero el ingenuo `AddInterceptors(new AuditableEntityInterceptor())` crea una instancia casi singleton sin inyección de dependencias.

Registra el interceptor en la inyección de dependencias y resuélvelo al configurar el contexto:

```csharp
// .NET 11, ASP.NET Core 11 -- Program.cs
builder.Services.AddHttpContextAccessor();
builder.Services.AddScoped<ICurrentUser, HttpContextCurrentUser>();
builder.Services.AddScoped<AuditableEntityInterceptor>();

builder.Services.AddDbContext<AppDbContext>((sp, options) =>
{
    options.UseSqlServer(connectionString);
    options.AddInterceptors(
        sp.GetRequiredService<AuditableEntityInterceptor>());
});
```

Como `AddDbContext` es scoped por defecto y el callback de configuración recibe el `IServiceProvider` con ámbito de solicitud, resolver aquí un interceptor scoped le da a cada solicitud su propia instancia con el `ICurrentUser` correcto. Si registras el interceptor como singleton mientras depende de `IHttpContextAccessor`, o bien capturarás un `HttpContext` obsoleto o dispararás la validación "Cannot consume scoped service from singleton". Si has visto ese mensaje exacto, la [solución para no poder consumir un servicio scoped desde un singleton](/es/2026/05/fix-cannot-consume-scoped-service-from-singleton/) explica por qué el contenedor lo rechaza.

Lee el usuario a través del accessor en el momento en que se ejecuta `SavingChanges`, no en el constructor, para que la búsqueda siempre refleje la solicitud activa:

```csharp
// .NET 11, C# 14
public sealed class HttpContextCurrentUser(IHttpContextAccessor accessor) : ICurrentUser
{
    public string? UserId =>
        accessor.HttpContext?.User.FindFirst("sub")?.Value;
}
```

## Escribir un rastro completo de cambios, no solo marcas de tiempo

Marcar columnas responde a "quién tocó esta fila y cuándo". Un rastro de cambios responde a "qué cambió exactamente". Para eso recorres las propiedades modificadas y registras los valores original frente a actual. EF Core te da ambos a través de `PropertyEntry`.

```csharp
// .NET 11, EF Core 11, C# 14
private static List<AuditTrail> BuildTrail(DbContext context, DateTime now, string user)
{
    var trail = new List<AuditTrail>();

    foreach (var entry in context.ChangeTracker.Entries())
    {
        if (entry.Entity is AuditTrail) continue; // never audit the audit table
        if (entry.State is EntityState.Detached or EntityState.Unchanged) continue;

        var record = new AuditTrail
        {
            TableName = entry.Metadata.GetTableName(),
            Action = entry.State.ToString(),
            UserId = user,
            TimestampUtc = now,
            Changes = new Dictionary<string, object?>()
        };

        foreach (var prop in entry.Properties)
        {
            if (entry.State == EntityState.Added)
                record.Changes[prop.Metadata.Name] = prop.CurrentValue;
            else if (entry.State == EntityState.Modified && prop.IsModified)
                record.Changes[prop.Metadata.Name] =
                    new { Old = prop.OriginalValue, New = prop.CurrentValue };
            else if (entry.State == EntityState.Deleted)
                record.Changes[prop.Metadata.Name] = prop.OriginalValue;
        }

        trail.Add(record);
    }

    return trail;
}
```

Serializa `Changes` a una columna JSON y tendrás un historial consultable. Ten en cuenta que `entry.Properties` solo enumera propiedades escalares; las navegaciones y los tipos propios necesitan `entry.References` y `entry.Collections` si te importan.

## El problema de la clave temporal y por qué existe SavedChanges

Para las filas insertadas con claves generadas por la base de datos, `prop.CurrentValue` durante `SavingChanges` es un marcador de posición temporal, no el valor de identidad real. EF Core aún no ha hablado con la base de datos. Si tu rastro de auditoría registra la clave primaria de las filas nuevas, capturarla en `SavingChanges` escribe el valor equivocado.

Esta es la razón entera por la que existe `SavedChanges`. El patrón limpio es de dos fases: construye las filas de auditoría en `SavingChanges`, mantenlas en la instancia del interceptor, luego resuelve los valores de clave ya reales y persiste el rastro en `SavedChangesAsync`.

```csharp
// .NET 11, EF Core 11, C# 14
private readonly List<(EntityEntry Entry, AuditTrail Record)> _pending = [];

public override ValueTask<InterceptionResult<int>> SavingChangesAsync(
    DbContextEventData eventData, InterceptionResult<int> result,
    CancellationToken ct = default)
{
    _pending.Clear();
    var ctx = eventData.Context!;
    foreach (var entry in ctx.ChangeTracker.Entries())
        // ... stash (entry, partial record) into _pending
    return base.SavingChangesAsync(eventData, result, ct);
}

public override async ValueTask<int> SavedChangesAsync(
    SaveChangesCompletedEventData eventData, int result,
    CancellationToken ct = default)
{
    foreach (var (entry, record) in _pending)
        record.EntityId = entry.Property("Id").CurrentValue?.ToString();

    // persist _pending to the audit store now that keys are real
    return await base.SavedChangesAsync(eventData, result, ct);
}
```

Como el interceptor ahora mantiene estado por guardado en `_pending`, debe ser scoped o transient, nunca un singleton compartido. Un singleton entrelazaría `_pending` entre solicitudes concurrentes y corrompería el rastro. Esa es una razón más por la que el registro de inyección de dependencias de arriba usa `AddScoped`.

Si recorres el `ChangeTracker` en una ruta caliente y al perfilar has visto aparecer `DetectChanges`, la [API `GetEntriesForState` de EF Core 11 omite el escaneo completo de DetectChanges](/es/2026/04/efcore-11-changetracker-getentriesforstate/) cuando solo necesitas las entradas en un estado específico.

## El detalle que se salta tu auditoría en silencio: ExecuteUpdate y ExecuteDelete

`SaveChangesInterceptor` solo se dispara para `SaveChanges` y `SaveChangesAsync`. Las operaciones masivas `ExecuteUpdate` y `ExecuteDelete` se traducen directamente a una sola sentencia SQL y nunca cargan entidades en el `ChangeTracker`, así que se saltan por completo tu interceptor de auditoría. Esto es por diseño y es una fuente frecuente de confusión del tipo "por qué este cambio no está en el registro de auditoría".

```csharp
// This UPDATE is NOT audited -- it never touches the ChangeTracker
await db.Orders
    .Where(o => o.Status == OrderStatus.Pending)
    .ExecuteUpdateAsync(s => s.SetProperty(o => o.Status, OrderStatus.Cancelled));
```

Si una ruta de código debe ser auditada, o bien la enrutas a través de entidades rastreadas y `SaveChanges`, o bien auditas la operación masiva explícitamente en el sitio de la llamada. Los compromisos entre los dos estilos de escritura se cubren en la guía sobre [ExecuteUpdate y ExecuteDelete para escrituras masivas en EF Core 11](/es/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/). Elige la ruta masiva por rendimiento, acepta que está fuera del interceptor, y haz que eso sea una decisión explícita en lugar de una sorpresa.

## Borrados lógicos desde el mismo punto de enganche

Como el interceptor ve las entradas `EntityState.Deleted` antes de que se genere el SQL, es el lugar natural para convertir un borrado físico en un borrado lógico. Cambia el estado a `Modified` y establece tu bandera:

```csharp
// .NET 11, EF Core 11, C# 14
case EntityState.Deleted when entry.Entity is ISoftDeletable sd:
    entry.State = EntityState.Modified;
    sd.IsDeleted = true;
    sd.DeletedOnUtc = now;
    sd.DeletedBy = user;
    break;
```

Combina esto con un filtro de consulta global (`modelBuilder.Entity<T>().HasQueryFilter(e => !e.IsDeleted)`) para que las filas borradas lógicamente desaparezcan de las consultas normales. Solo recuerda que el interceptor y el filtro son dos mitades de una sola característica: el interceptor escribe la bandera, el filtro la oculta.

## Verificar que funciona

Los interceptores son fáciles de probar unitariamente porque son clases simples. Construye uno con un `TimeProvider` y un `ICurrentUser` falsos, añade una entidad a un contexto configurado con el interceptor, llama a `SaveChangesAsync` y verifica los valores marcados. Para cobertura de extremo a extremo, un contexto en memoria o SQLite con el interceptor registrado a través de `AddInterceptors` ejercita el pipeline real de EF. Si construyes ese arnés de pruebas alrededor de un contexto falsificado, las reglas para mantener intacto el rastreo de cambios están en [cómo simular DbContext sin romper el rastreo de cambios](/es/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/), y si tus escrituras de auditoría empiezan a lanzar excepciones sobre uso concurrente del contexto, consulta [se inició una segunda operación en esta instancia de contexto](/es/2026/05/fix-second-operation-was-started-on-this-context-instance/).

La versión corta: deriva de `SaveChangesInterceptor`, sobrescribe tanto `SavingChanges` como `SavingChangesAsync`, recorre `ChangeTracker.Entries()` para los datos, registra el interceptor como scoped a través de la inyección de dependencias para que pueda leer el usuario actual, usa `SavedChangesAsync` cuando necesites claves reales, y recuerda que `ExecuteUpdate`/`ExecuteDelete` rodean todo el mecanismo. Eso cubre la gran mayoría de los requisitos reales de auditoría en .NET sin que una sola línea de código de auditoría se filtre en tu lógica de dominio.

Fuente primaria: la [documentación de interceptores de EF Core](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/interceptors) en Microsoft Learn, que incluye el ejemplo canónico de base de datos de auditoría separada sobre el que se construye este artículo.
