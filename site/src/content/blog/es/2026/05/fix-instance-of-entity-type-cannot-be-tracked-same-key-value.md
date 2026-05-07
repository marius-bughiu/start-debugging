---
title: "Solución: The instance of entity type cannot be tracked because another instance with the same key value is already being tracked"
description: "EF Core 11 lanza esta excepción cuando dos objetos comparten clave primaria dentro de un DbContext. Desvincula el viejo o actualízalo en el lugar. AsNoTracking en la lectura previene la colisión."
pubDate: 2026-05-07
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "change-tracker"
lang: "es"
translationOf: "2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value"
translatedBy: "claude"
translationDate: 2026-05-07
---

La solución: un `DbContext` ya tiene una entidad con esta clave primaria en su rastreador de cambios, y le pasaste una segunda instancia con la misma clave. O bien actualiza la instancia rastreada en el lugar con `SetValues`, desvincúlala antes de adjuntar la tuya, o lee con `AsNoTracking` para que nada quede rastreado desde el principio. Los contextos de larga duración y los patrones "cargar y luego `Update(newDto)`" son los culpables habituales.

```text
System.InvalidOperationException: The instance of entity type 'Customer' cannot be tracked because another instance with the same key value for {'Id'} is already being tracked. When attaching existing entities, ensure that only one entity instance with a given key value is attached. Consider using 'DbContextOptions.EnableSensitiveDataLogging' to see the conflicting key values.
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.IdentityMap`1.ThrowIdentityConflict(InternalEntityEntry entry)
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.IdentityMap`1.Add(...)
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.StateManager.StartTracking(...)
   at Microsoft.EntityFrameworkCore.DbContext.SetEntityState(...)
   at Microsoft.EntityFrameworkCore.DbContext.Update[TEntity](TEntity entity)
```

Esta guía está escrita contra .NET 11 preview 4 y `Microsoft.EntityFrameworkCore` 11.0.0-preview.4. El comportamiento ha sido idéntico desde EF Core 2.0; solo cambian los detalles internos de la traza de pila entre versiones. La excepción viene del invariante de `IdentityMap<T>`: un `DbContext` mantiene como máximo una instancia rastreada por par `(EntityType, PrimaryKey)`, y cualquier segunda instancia se rechaza de inmediato.

## Por qué existe el mapa de identidad

El rastreador de cambios de EF Core se construye alrededor de una sola regla: para cada tipo de entidad, cada valor de clave primaria mapea como máximo a un objeto CLR. Esa regla es lo que permite a `SaveChanges` decidir si una fila está `Added`, `Modified` o `Unchanged` sin ambigüedad, y lo que hace funcionar la corrección de navegación cuando cargas datos relacionados por partes. Dos objetos con la misma clave significarían dos respuestas en competencia para "¿cuál es el estado actual del cliente 42?", así que el rastreador de cambios se niega a aceptar el segundo. La excepción que estás viendo es ese rechazo, y se lanza antes de que tu llamada a `SaveChanges` se ejecute, en el momento en que el `DbContext` detecta el conflicto durante `Attach`, `Update`, `Add` o cualquier operación que recorra un grafo.

## Una reproducción mínima

El modo de fallo casi siempre tiene esta forma: un manejador HTTP lee una entidad para validar una solicitud, luego recrea la misma entidad desde un DTO y le pide a EF Core que la actualice.

```csharp
// .NET 11, C# 14, EF Core 11.0.0
public record CustomerDto(int Id, string Name, string Email);

public class CustomersController(AppDb db) : ControllerBase
{
    [HttpPut("{id:int}")]
    public async Task<IActionResult> Update(int id, CustomerDto dto)
    {
        var existing = await db.Customers.FirstOrDefaultAsync(c => c.Id == id);
        if (existing is null) return NotFound();

        var updated = new Customer
        {
            Id = dto.Id,
            Name = dto.Name,
            Email = dto.Email
        };

        db.Update(updated); // throws: id is already tracked from the read above
        await db.SaveChangesAsync();
        return NoContent();
    }
}
```

La primera llamada a `FirstOrDefaultAsync` adjunta `existing` (id 42) en estado `Unchanged`. Luego `db.Update(updated)` intenta adjuntar un objeto CLR distinto con id 42. El rastreador de cambios lo rechaza. El texto de la excepción menciona "another instance with the same key value", lo cual es preciso pero fácil de leer mal en una tarde de cansancio: las "dos instancias" son la que EF Core ya conoce y la que le estás pasando ahora.

## Tres soluciones, ordenadas

Aplícalas en este orden. Las dos primeras evitan el problema por completo; la tercera es para casos en los que realmente no puedes.

### 1. Actualiza la entidad rastreada en el lugar con SetValues

Si ya cargaste la fila, el rastreador de cambios es tu aliado. Muta la instancia rastreada y deja que EF Core calcule el diff:

```csharp
// .NET 11, EF Core 11.0.0
[HttpPut("{id:int}")]
public async Task<IActionResult> Update(int id, CustomerDto dto)
{
    var existing = await db.Customers.FirstOrDefaultAsync(c => c.Id == id);
    if (existing is null) return NotFound();

    db.Entry(existing).CurrentValues.SetValues(dto);
    await db.SaveChangesAsync();
    return NoContent();
}
```

`CurrentValues.SetValues` copia los nombres de propiedad coincidentes desde el objeto fuente sobre la entidad rastreada y marca como `Modified` solo las columnas que realmente cambiaron. La sentencia `UPDATE` generada toca únicamente columnas sucias. Este es el patrón más limpio para "editar una fila existente desde un DTO" porque se mantiene dentro del mapa de identidad y produce SQL mínimo.

### 2. Lee con AsNoTracking, luego Update

Si solo cargaste la fila para verificar la existencia, hazlo sin rastreo:

```csharp
// .NET 11, EF Core 11.0.0
[HttpPut("{id:int}")]
public async Task<IActionResult> Update(int id, CustomerDto dto)
{
    var exists = await db.Customers
        .AsNoTracking()
        .AnyAsync(c => c.Id == id);
    if (!exists) return NotFound();

    var updated = new Customer { Id = dto.Id, Name = dto.Name, Email = dto.Email };
    db.Update(updated);
    await db.SaveChangesAsync();
    return NoContent();
}
```

`AnyAsync` no materializa una entidad, así que nada queda rastreado. `db.Update(updated)` adjunta la nueva instancia en estado `Modified` y EF Core escribe cada propiedad como un único viaje de ida y vuelta de `UPDATE`. La compensación frente a la solución 1 es que cada columna se escribe en el cable, sucia o no, porque EF Core no tiene valores originales contra los que diferenciar. Para tablas anchas esto desperdicia; para tablas estrechas es el código más simple.

Para patrones más amplios sobre qué se rastrea y qué no, revisa el resumen en [la API de entradas del rastreador de cambios](/2026/04/efcore-11-changetracker-getentriesforstate/).

### 3. Desvincula la entidad existente, luego adjunta la tuya

Cuando no puedes evitar la situación de doble instancia (un contexto de larga duración, una biblioteca de terceros que carga sin que lo sepas), desvincula primero la entrada en conflicto:

```csharp
// .NET 11, EF Core 11.0.0
public async Task ReplaceCustomer(int id, Customer incoming)
{
    var local = db.ChangeTracker.Entries<Customer>()
        .FirstOrDefault(e => e.Entity.Id == id);

    if (local is not null)
        local.State = EntityState.Detached;

    db.Update(incoming);
    await db.SaveChangesAsync();
}
```

`ChangeTracker.Entries<T>()` es en memoria y no toca la base de datos. Asignar `State = Detached` quita la entrada del mapa de identidad, lo que libera la clave para la nueva instancia. Esta es la salida de emergencia, no la opción por defecto, porque te obliga a razonar sobre qué instancia "gana" si cualquier otro código mantiene una referencia a la desvinculada.

EF Core 11 también expone `db.Entry(local.Entity).State = EntityState.Detached` directamente cuando ya tienes el objeto culpable en mano. Ambas formas hacen lo mismo: sacan la entrada del mapa de identidad.

## Formas comunes que disparan esto

### Un DbContext registrado como Singleton o capturado en un Singleton

La gran mayoría de los reportes de "pero mi código solo actualiza una vez" resultan ser un desajuste de tiempo de vida del `DbContext`. Un `DbContext` está pensado para ser `Scoped`, es decir, uno por solicitud. Si está registrado como `Singleton` (o inyectado en uno), cada solicitud apila entidades sobre el mismo mapa de identidad y la segunda actualización de la misma clave lanza la excepción.

```csharp
// Bad: long-lived AppDb captures the change tracker for the lifetime of the host
builder.Services.AddSingleton<AppDb>();

// Good: scoped per request, change tracker resets between requests
builder.Services.AddDbContext<AppDb>(o => o.UseSqlServer(cs));
```

Si genuinamente necesitas un contexto dentro de un `Singleton` (por ejemplo, un `BackgroundService` o un trabajo de Hangfire), inyecta `IDbContextFactory<AppDb>` y crea un contexto fresco por unidad de trabajo:

```csharp
// .NET 11, EF Core 11.0.0
builder.Services.AddDbContextFactory<AppDb>(o => o.UseSqlServer(cs));

public class CustomerSyncService(IDbContextFactory<AppDb> factory) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            await using var db = await factory.CreateDbContextAsync(ct);
            // ... work with db ...
        }
    }
}
```

### Grafos cargados con eager loading que se cruzan con una entidad adjuntada manualmente

Si cargas un cliente con sus pedidos en eager loading, y luego intentas `Attach(customer)` desde otro lado (otro resultado de consulta, un cuerpo de solicitud serializado, un acierto de caché), el grafo de pedidos colisiona con cualquier cosa ya rastreada. O bajas la consulta del lado de lectura a `AsNoTracking()` para que el grafo no esté en el mapa, o usas `db.Entry(customer).State = EntityState.Modified` solo en la raíz y recorres los hijos explícitamente.

### DbContext mockeado en pruebas

Si estás usando un `DbContext` mockeado para escribir pruebas, el mock a menudo no implementa el mapa de identidad correctamente, así que producción golpea este error y las pruebas pasan. Lo opuesto también ocurre: un proveedor en memoria real rastrea entidades que el mock no rastreaba, y la prueba falla por razones que nada tienen que ver con el sistema bajo prueba. La solución es probar contra un proveedor real; la guía de [trampas al mockear DbContext](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) cubre lo que el mock sí da y lo que no.

### EnableSensitiveDataLogging es tu depurador

El mensaje de excepción dice "Consider using `DbContextOptions.EnableSensitiveDataLogging` to see the conflicting key values" por una razón. Sin él, EF Core oculta la clave primaria real en el error para evitar filtrar PII en los registros. Habilítalo localmente para ver qué fila es la duplicada:

```csharp
// .NET 11, EF Core 11.0.0 -- development only
builder.Services.AddDbContext<AppDb>(o => o
    .UseSqlServer(cs)
    .EnableSensitiveDataLogging()
    .EnableDetailedErrors());
```

Nunca despliegues esto en producción; el mismo flag imprimirá los valores de los parámetros en tus registros con cada comando.

## Variantes que parecen este error pero no lo son

### "Cannot insert explicit value for identity column"

Excepción distinta, causa distinta: SQL Server rechaza una clave primaria distinta de cero en una columna `IDENTITY`. La solución es `SET IDENTITY_INSERT ON` o, más comúnmente, no asignar la clave en el insert. El rastreador de cambios no está involucrado.

### "An attempt was made to use the model while it was being created"

Este es un bug de orden en el arranque, típicamente causado por un campo estático de `DbContext` o por leer del modelo dentro de `OnModelCreating`. El mapa de identidad tampoco está involucrado.

### "A second operation was started on this context instance before a previous operation completed"

Esto es concurrencia, no conflicto de clave. Un `DbContext` con scope no es thread-safe; dos `await` paralelos sobre la misma instancia producen esta excepción. Error distinto, y solución distinta (`IDbContextFactory` de nuevo, o serializa el trabajo).

## Relacionado

Para el contexto más amplio de EF Core, revisa el resumen sobre [detección de consultas N+1](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/), la guía de [consultas compiladas en rutas calientes](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) y el recorrido de [records como entidades de EF Core](/2026/04/how-to-use-records-with-ef-core-11-correctly/) que tiene sus propias trampas del mapa de identidad alrededor de las expresiones `with`. Cuando golpeas este error en código de arranque y no en un manejador de solicitudes, la [lista de verificación de DefaultConnection](/2026/05/fix-no-connection-string-named-defaultconnection/) cubre el lado de la configuración. Para fixtures de prueba que pasan una base de datos real a tu código, el [recorrido de Testcontainers](/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) es la configuración más limpia.

## Fuentes

- [Tracking and No-Tracking Queries](https://learn.microsoft.com/en-us/ef/core/querying/tracking), documentación de EF Core.
- [Change Tracker API](https://learn.microsoft.com/en-us/ef/core/change-tracking/), documentación de EF Core.
- [Working with disconnected entity graphs](https://learn.microsoft.com/en-us/ef/core/saving/disconnected-entities), documentación de EF Core.
- [Interfaz `IDbContextFactory<TContext>`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.idbcontextfactory-1), Microsoft Learn.
- [Método `PropertyValues.SetValues`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.changetracking.propertyvalues.setvalues), Microsoft Learn.
