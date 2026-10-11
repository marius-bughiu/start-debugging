---
title: "Cómo comprobar si una entidad ya está rastreada por el DbContext antes de adjuntarla en EF Core"
description: "Usa DbSet.Local.FindEntry(key) para preguntarle al change tracker si hay una entidad rastreada con una clave dada, sin viaje a la base de datos ni recorrido. Por qué Entry(entity).State miente para esta pregunta, por qué Find consulta la base de datos y un helper AttachOrMerge probado para EF Core 10."
pubDate: 2026-10-11
template: how-to
tags:
  - "ef-core"
  - "dotnet-10"
  - "csharp"
  - "change-tracker"
  - "how-to"
lang: "es"
translationOf: "2026/10/how-to-check-whether-an-entity-is-already-tracked-by-the-dbcontext-in-ef-core"
translatedBy: "claude"
translationDate: 2026-10-11
---

**Respuesta corta:** llama a `db.Set<T>().Local.FindEntry(id)`. Devuelve el `EntityEntry<T>` rastreado para esa clave primaria, o `null` si no hay nada rastreado con esa clave, y nunca consulta la base de datos. Si devuelve una entrada, copia tus valores sobre ella con `entry.CurrentValues.SetValues(incoming)` en lugar de adjuntar. Si devuelve `null`, `Attach` o `Update` es seguro. Para claves compuestas usa `Local.FindEntryUntyped([part1, part2])`. No uses `db.Entry(incoming).State == EntityState.Detached` para esta comprobación: solo te dice algo sobre esa instancia concreta del objeto, no sobre la clave.

Todo lo que sigue se ejecutó con EF Core 10.0.12 (`Microsoft.EntityFrameworkCore.Sqlite` 10.0.12) en el SDK de .NET 10 10.0.302. La familia `LocalView<T>.FindEntry` se añadió en EF Core 8 ([dotnet/efcore#29686](https://github.com/dotnet/efcore/pull/29686)), así que el mismo código funciona en EF Core 8, 9, 10 y en las versiones candidatas de EF Core 11.

## Por qué "¿está rastreada?" es una pregunta sobre claves, no sobre objetos

El change tracker mantiene un mapa de identidad: para cada tipo de entidad, una única instancia CLR rastreada por valor de clave primaria. Cuando llamas a `Attach`, `Update` o `Add` con una segunda instancia cuya clave ya está en el mapa, EF Core lanza la conocida excepción [`The instance of entity type cannot be tracked because another instance with the same key value is already being tracked`](/es/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/).

Así que la pregunta que realmente necesitas responder antes de adjuntar es "¿el mapa de identidad ya contiene *alguna* instancia con esta clave?". Es una pregunta distinta de "¿está rastreada *esta* instancia?", y la comprobación que se sugiere con más frecuencia responde la segunda.

## Un repro mínimo de la trampa

```csharp
// .NET 10, EF Core 10.0.12, Microsoft.EntityFrameworkCore.Sqlite
using var db = new Shop(options);

var tracked  = db.Customers.First(c => c.Id == 1);           // tracked, Unchanged
var incoming = new Customer { Id = 1, Name = "changed" };    // e.g. deserialized from a request

Console.WriteLine(db.Entry(tracked).State);   // Unchanged
Console.WriteLine(db.Entry(incoming).State);  // Detached  <-- looks "safe"

db.Attach(incoming);
// InvalidOperationException: The instance of entity type 'Customer' cannot be tracked
// because another instance with the same key value for {'Id'} is already being tracked.
```

`db.Entry(incoming)` devuelve sin problema una entrada en estado `Detached`, porque `incoming` realmente no está rastreada. No lanza excepción y no empieza a rastrear el objeto (el change tracker seguía teniendo exactamente una entrada después, en mi ejecución). El código que hace `if (db.Entry(x).State == EntityState.Detached) db.Attach(x);` pasa la comprobación y luego lanza la excepción en la línea siguiente. Ese patrón sirve para "¿ya adjunté este mismo objeto?", y es incorrecto en escenarios desconectados donde el objeto vino de un DTO, una caché o un cuerpo JSON.

## Las opciones, medidas

Conecté un contador a `CoreEventId.DetectChangesStarting` y un `DbCommandInterceptor` que cuenta los readers ejecutados, y luego ejecuté cada candidato contra un contexto que rastreaba un `Customer`:

| Comprobación | ¿Responde la pregunta de la clave? | Pasadas de `DetectChanges` | Consultas a la base de datos |
| --- | --- | --- | --- |
| `db.Entry(incoming).State` | No, solo sobre esa instancia | 0 | 0 |
| `db.ChangeTracker.Entries<Customer>().Any(e => e.Entity.Id == 1)` | Sí, mediante recorrido lineal | 1 | 0 |
| `db.Customers.Find(1)` (rastreada) | Sí, devuelve la instancia rastreada | 0 | 0 |
| `db.Customers.Find(2)` (no rastreada) | No es una comprobación: carga la fila | 0 | 1 |
| `db.Customers.Local.FindEntry(1)` | Sí, mediante búsqueda en el mapa de identidad | 1 (por el getter de `Local`) | 0 |
| `cachedLocal.FindEntry(1)` | Sí | 0 | 0 |

Algunas cosas destacan.

**`Find` no es una comprobación de rastreo.** Busca primero en el mapa de identidad, por eso el caso rastreado no cuesta nada, pero cuando la clave no está rastreada va a la base de datos y empieza a rastrear lo que encuentre. Si usas `Find` para decidir si adjuntar, o bien cargas una fila que no querías, o bien obtienes una instancia rastreada y luego adjuntas tu propia copia encima, lo cual lanza una excepción.

**`ChangeTracker.Entries<T>()` funciona pero recorre.** Ejecuta primero `DetectChanges` y luego enumera todas las entradas rastreadas de ese tipo. Con diez entidades es ruido. Con un contexto de larga duración en una aplicación de escritorio o un trabajo por lotes con decenas de miles de entradas, hacerlo una vez por cada elemento entrante es cuadrático. (En EF Core 11, la [API `GetEntriesForState`](/es/2026/04/efcore-11-changetracker-getentriesforstate/) se salta la pasada de `DetectChanges` pero sigue siendo una enumeración.)

**`Local.FindEntry` es la API pensada para esto.** Resuelve la clave a través del mismo mapa de identidad que comprueba `Attach`, así que da exactamente la respuesta sobre la que `Attach` va a actuar. El único `DetectChanges` de la tabla viene del getter de la propiedad `DbSet<T>.Local`, no de `FindEntry`: cuando guardé el `LocalView<Customer>` en una variable y llamé a `FindEntry` sobre ella, el contador se quedó en cero. La [documentación de la API](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.changetracking.localview-1.findentry) dice lo mismo y recomienda reutilizar el objeto `Local` para búsquedas repetidas.

## Comprobar, luego adjuntar o fusionar

Este es el procedimiento para una actualización desconectada, el escenario donde suele surgir esta pregunta:

1. Obtén la vista local una sola vez: `var local = db.Customers.Local;`.
2. Busca la clave con `local.FindEntry(incoming.Id)`.
3. Si devuelve una entrada, copia los valores entrantes sobre la instancia rastreada con `entry.CurrentValues.SetValues(incoming)`. EF Core marca como modificadas solo las propiedades cuyos valores realmente cambiaron.
4. Si devuelve `null`, nada tiene esa clave, así que `Update(incoming)` (o `Attach` más indicadores `IsModified` explícitos) es seguro.
5. Llama a `SaveChanges` una sola vez al final.

Como helper:

```csharp
// .NET 10, EF Core 10.0.12
static Customer AttachOrMerge(Shop db, Customer incoming)
{
    var existing = db.Customers.Local.FindEntry(incoming.Id);
    if (existing is null)
    {
        db.Customers.Update(incoming);   // nothing tracked with this key
        return incoming;
    }

    existing.CurrentValues.SetValues(incoming);  // merge into the tracked instance
    return existing.Entity;
}
```

Ejecutándolo contra el contexto que ya rastrea al cliente 1:

```text
Helper: same=True state=Modified name=merged modifiedProps=Name
```

El objeto devuelto es la instancia que el contexto ya estaba rastreando, su estado pasó de `Unchanged` a `Modified`, y solo `Name` está marcada, así que el `UPDATE` generado toca una sola columna. Devuelve la instancia rastreada a quien llama en lugar de `incoming`: tras la fusión, `incoming` sigue siendo un objeto desconectado del que EF Core no sabe nada.

## Una versión genérica para cualquier tipo de entidad

Rara vez quieres un helper por entidad. `FindEntryUntyped` recibe los valores de la clave como `IEnumerable<object?>` en el orden de la clave, y el modelo te dice qué propiedades forman la clave primaria:

```csharp
// .NET 10, EF Core 10.0.12
static EntityEntry<T>? FindTrackedEntry<T>(DbContext db, T entity) where T : class
{
    var key = db.Model.FindEntityType(typeof(T))!.FindPrimaryKey()!;
    var entry = db.Entry(entity);   // Detached entry, does not start tracking
    var keyValues = key.Properties
        .Select(p => entry.Property(p.Name).CurrentValue)
        .ToArray();

    return db.Set<T>().Local.FindEntryUntyped(keyValues);
}

static bool IsTracked<T>(DbContext db, params object?[] keyValues) where T : class
    => db.Set<T>().Local.FindEntryUntyped(keyValues) is not null;
```

Leer la clave mediante `db.Entry(entity).Property(...)` en lugar de reflexión hace que las claves de propiedades sombra y las claves mapeadas a campos funcionen sin casos especiales. En el repro, `FindTrackedEntry(db, incoming)` encontró al cliente rastreado aunque `incoming` fuera un objeto distinto, que es justo el comportamiento que le falta a la comprobación con `Entry(...).State`.

## Detalles que te van a morder

### Las claves compuestas necesitan `FindEntryUntyped`, no `FindEntry`

`FindEntry` es genérico, `FindEntry<TKey>(TKey keyValue)`. Si le pasas un arreglo o una lista, el compilador enlaza felizmente `TKey` a `object[]` o `List<object?>`, y luego EF Core trata todo eso como un único valor de clave:

```csharp
// .NET 10, EF Core 10.0.12. OrderLine has HasKey(x => new { x.OrderId, x.LineNo })
db.OrderLines.Local.FindEntry(new object[] { 10, 1 });
// ArgumentException: Entity type 'OrderLine' is defined with a 2-part composite key,
// but 1 values were passed to the 'Find' method.

db.OrderLines.Local.FindEntryUntyped([10, 1]);   // works, returns the tracked entry
```

También probé con una variable de tipo `IEnumerable<object?>`, esperando caer en una sobrecarga no genérica. Misma excepción: no existe una sobrecarga `FindEntry(IEnumerable<object?>)` para claves primarias, la versión sin tipo tiene su propio nombre.

### El tipo de la clave debe coincidir exactamente

`FindEntry<TKey>` no convierte. Con una clave `int`:

```text
FindEntry(1L): ArgumentException: Property 'Customer.Id' is of type 'int' but the generic type provided is of type 'long'.
```

`FindEntryUntyped` no es más permisivo, comprueba el tipo del valor empaquetado:

```text
FindEntryUntyped([1L]): ArgumentException: The 'FindEntry' or 'GetEntries' method was passed a 'long' value for the 'Id' property, when a 'int' value was expected.
```

Esto aparece cuando la clave llega desde un valor de ruta o un repositorio genérico tipado como `long` u `object`. Convierte al tipo CLR de la propiedad de la clave (`key.Properties[i].ClrType`) antes de la llamada.

### Las entidades eliminadas siguen rastreadas

Después de `db.Customers.Remove(customer2)`:

```text
FindEntry(2) after Remove: Deleted; Local.Count=1; Find(2)=entity
```

La *colección* local oculta las entidades `Deleted` (`Local.Count` bajó a 1, como [describe la documentación](https://learn.microsoft.com/en-us/ef/core/change-tracking/entity-entries#the-local-view)), pero `FindEntry` sigue devolviendo la entrada, y `Find` también. Eso es correcto para nuestro propósito, ya que la clave sigue en el mapa de identidad y `Attach` seguiría lanzando excepción. Pero si tu lógica de fusión asume que "encontrada" significa "viva", comprueba `entry.State` antes de llamar a `SetValues`, o acabarás aplicando cambios de propiedades a una fila que `SaveChanges` está a punto de eliminar.

### "No rastreada" no significa "existe en la base de datos"

Cuando `FindEntry` devuelve `null`, el helper llama a `Update`, que marca todas las propiedades como modificadas y genera un `UPDATE`. Para una clave que no existe en la tabla, `SaveChanges` afecta cero filas y lanza `DbUpdateConcurrencyException`. En el repro, `AttachOrMerge(db, new Customer { Id = 3 })` dejó la entidad en `Modified`, no en `Added`. Si el objeto entrante puede ser nuevo, decídelo a partir de tus propios datos (una clave por defecto, una columna de versión, un indicador explícito) antes de elegir entre `Add` y `Update`. Otra opción es evitar el rastreo por completo y usar [`ExecuteUpdate`](/es/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) para la escritura.

### Valores de clave por defecto en claves generadas por el almacén

Adjuntar un `Customer` cuyo `Id` es `0` no lanza excepción ni colisiona: EF Core ve una clave generada por el almacén sin asignar y rastrea la entidad como `Added` con un valor temporal. Comprobar `FindEntry(0)` primero no te dice nada útil ahí. Bifurca según `entry.IsKeySet` (o `id == default`) antes de hacer la búsqueda.

### Búsquedas por clave alterna o clave foránea

`LocalView<T>` también tiene `FindEntry<TProperty>(string propertyName, TProperty value)` y `GetEntries(...)` para búsquedas que no son por clave primaria, por ejemplo `Local.FindEntry(nameof(Customer.Email), email)`. Son rápidas cuando la propiedad es una clave alterna o una clave foránea, porque EF Core ya mantiene búsquedas para ellas. Para propiedades ordinarias recurren a recorrer las entradas rastreadas. En el repro, `Local.FindEntry(nameof(Customer.Name), "a")` devolvió la entrada correcta, pero `Name` no es una clave, así que fue un recorrido.

### Desactivar AutoDetectChanges

Con `db.ChangeTracker.AutoDetectChangesEnabled = false`, ni el getter de `Local` ni `Entries<T>()` disparan `DetectChanges` (contador en 0 para ambos). Las búsquedas en el mapa de identidad no se ven afectadas, ya que las claves no pueden cambiar en una entidad rastreada. Si desactivas la detección automática para un bucle de importación masiva, llama tú mismo a `db.ChangeTracker.DetectChanges()` antes de `SaveChanges` cuando modifiques directamente entidades rastreadas.

## Cuando la mejor solución es no rastrear en absoluto

Si la comprobación está en tu código porque una lectura anterior en el mismo contexto rastreó la entidad que ahora quieres actualizar, la solución más limpia suele estar aguas arriba. Lee con `AsNoTracking()` cuando el resultado solo se muestra o se mapea a un DTO (la [comparación de AsNoTracking y AsNoTrackingWithIdentityResolution](/es/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/) explica cuál elegir), y mantén los contextos de corta duración para que una unidad de trabajo no herede las entidades rastreadas de otra. `FindEntry` es la herramienta adecuada cuando un contexto ve legítimamente la misma clave desde dos direcciones: una aplicación de escritorio con un contexto de larga duración, un trabajo por lotes que fusiona registros de varios archivos, o un grafo que llega con entidades parcialmente superpuestas con las que ya cargaste.

La misma búsqueda es útil en las pruebas. Si reemplazaste el proveedor con un falso y tus aserciones dependen de lo que está rastreado, `Local.FindEntry` lee el mapa de identidad real, lo que te mantiene honesto de la manera descrita en [simular un DbContext sin romper el rastreo de cambios](/es/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/).

### Lee a continuación

- [Fix: The instance of entity type cannot be tracked because another instance with the same key value is already being tracked](/es/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/)
- [EF Core 11 adds GetEntriesForState to skip DetectChanges](/es/2026/04/efcore-11-changetracker-getentriesforstate/)
- [AsNoTracking vs AsNoTrackingWithIdentityResolution in EF Core 11](/es/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/)
- [ExecuteUpdate vs loading entities and SaveChanges](/es/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/)

## Fuentes

- [`LocalView<TEntity>.FindEntry` method](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.changetracking.localview-1.findentry), Microsoft Learn.
- [`LocalView<TEntity>.FindEntryUntyped` method](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.changetracking.localview-1.findentryuntyped), Microsoft Learn.
- [Accessing tracked entities](https://learn.microsoft.com/en-us/ef/core/change-tracking/entity-entries), documentación de EF Core (Entry, Find, Entries, la vista local y su costo de `DetectChanges`).
- [Lookup entities by primary key, alternate key, or foreign key](https://github.com/dotnet/efcore/pull/29686), PR #29686 de dotnet/efcore (fusionado en diciembre de 2022, incluido en EF Core 8).
- [Disconnected entities](https://learn.microsoft.com/en-us/ef/core/saving/disconnected-entities), documentación de EF Core.
