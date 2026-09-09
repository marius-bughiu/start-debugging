---
title: "Solución: Complex entry original ordinal '-1' is invalid al guardar una colección compleja con ToJson"
description: "Actualiza Microsoft.EntityFrameworkCore a 10.0.10 o posterior. Antes de eso, hacer crecer una colección anidada bajo una segunda propiedad compleja con ToJson rompía SaveChanges."
pubDate: 2026-09-09
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "complex-types"
  - "change-tracker"
  - "json"
  - "dotnet-10"
lang: "es"
translationOf: "2026/09/fix-complex-entry-original-ordinal-is-invalid-when-saving-a-tojson-complex-collection"
translatedBy: "claude"
translationDate: 2026-09-09
---

Actualiza `Microsoft.EntityFrameworkCore` a 10.0.10 o posterior. Entre 10.0.0 y 10.0.9, si una entidad mapeaba dos o más propiedades complejas con `ToJson()` y una colección anidada dentro de una de ellas ganaba un elemento entre la carga y el guardado, el rastreador de cambios forzaba a `Modified` o `Unchanged` a todas las entradas complejas aplanadas, incluidas las que legítimamente estaban en `Added`. Un elemento `Added` tiene un ordinal original de `-1` por diseño, así que la transición de estado chocaba de frente con `ValidateOrdinal` y lanzaba la excepción. La corrección es una guarda de una línea en `InternalEntryBase`, es independiente del proveedor y no hay ninguna configuración que debas cambiar después de actualizar.

## El error en contexto

La excepción aparece desde `SaveChanges` o `SaveChangesAsync`, antes de que se envíe ningún SQL:

```
System.InvalidOperationException: Complex entry original ordinal '-1' is invalid for property
'XWidget.XDeepData.XMiddleData[]XDeepItem[]XInnerEntry.Inner' as it's outside of the collection
of length '1'.
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.InternalEntryBase.
      InternalComplexCollectionEntry.ValidateOrdinal(InternalComplexEntry entry, Boolean original)
```

La ruta de la propiedad en el mensaje es una cadena aplanada, no una expresión de C#. `[]` marca un salto a través de una colección compleja, así que `XWidget.XDeepData.XMiddleData[]XDeepItem[]XInnerEntry.Inner` se lee como "la colección `Inner` de `XInnerEntry`, que vive dentro de un elemento `XDeepItem`, que vive dentro de un elemento `XMiddleData`, que cuelga de `XDeepData` en `XWidget`". Esa ruta es tu camino más rápido a la propiedad culpable.

Hay dos detalles que conviene revisar antes de seguir, porque distinguen este error de sus parecidos. Primero, el mensaje dice **original ordinal** y **for property**. El mensaje hermano dice **ordinal** y **for the collection**, y tiene una causa raíz distinta. Segundo, el número al final es el tamaño de la colección *original*, la que EF cargó de la base de datos, no el tamaño de la colección que intentas guardar.

## Por qué el ordinal es -1: qué rastrea realmente EF Core en una colección compleja

Las colecciones complejas llegaron en EF Core 10 y, en proveedores relacionales, deben mapearse a una única columna JSON con `ToJson()`. No pueden ir a una tabla aparte. Esa restricción importa aquí: como no hay tabla ni clave, EF no puede identificar un elemento por su clave primaria como hace con una entidad owned. Lo identifica por su **posición en el arreglo**.

Por eso el rastreador de cambios guarda dos posiciones por elemento, en `InternalComplexEntry`:

```csharp
// EF Core 10.0 / 11.0, src/EFCore/ChangeTracking/Internal/InternalComplexEntry.cs
public int Ordinal
{
    // -1 is used to indicate that the entry is deleted
    get;
    set { /* ... */ }
}

public int OriginalOrdinal
{
    // -1 is used to indicate that the entry is added
    get;
    set { /* ... */ }
}
```

`Ordinal` es la posición del elemento en la colección que estás a punto de guardar. `OriginalOrdinal` es la posición que ocupaba en la colección que EF materializó. Los dos valores centinela son toda la historia:

- Un elemento que **eliminaste** no tiene posición en la colección actual, así que su `Ordinal` es `-1`.
- Un elemento que **agregaste** no tiene posición en la colección original, así que su `OriginalOrdinal` es `-1`.

Cada transición de estado hacia un estado rastreado pasa el ordinal correspondiente por una comprobación de límites:

```csharp
// EF Core 10.0, InternalEntryBase.InternalComplexCollectionEntry.ValidateOrdinal
public readonly int ValidateOrdinal(InternalComplexEntry entry, bool original, List<InternalComplexEntry?> entries)
{
    var ordinal = original ? entry.OriginalOrdinal : entry.Ordinal;
    if (ordinal < 0 || ordinal >= entries.Count)
    {
        var property = entry.ComplexProperty;
        throw new InvalidOperationException(
            original
                ? CoreStrings.ComplexCollectionEntryOriginalOrdinalInvalid(/* ... */)
                : CoreStrings.ComplexCollectionEntryOrdinalInvalid(/* ... */));
    }
    // ...
}
```

Esa comprobación es correcta por sí sola. `-1` realmente está fuera de rango. El error estaba en que algo más arriba le pedía a una entrada `Added` que pasara a `Modified`, y `Added -> Modified` es exactamente la transición que valida el ordinal original. Una entrada que debía tener `OriginalOrdinal == -1` era empujada por una ruta de código que lo prohíbe.

El llamador de arriba era `SetComplexCollectionModified`. Cuando la detección de cambios decidía que una colección compleja había cambiado, recorría `GetFlattenedComplexEntries()`, que devuelve todas las entradas complejas del grafo anidado completo de la entidad, y ponía cada una en `Modified` o `Unchanged`. Los elementos recién agregados quedaban arrastrados junto con el resto.

## Reproducción mínima: dos propiedades complejas JSON y una colección anidada que crece

Quien reportó [dotnet/efcore#38299](https://github.com/dotnet/efcore/issues/38299) redujo el disparador a cuatro condiciones que deben cumplirse a la vez:

1. La entidad mapea dos o más propiedades complejas con `ToJson()`.
2. Uno de esos documentos JSON contiene objetos anidados que a su vez tienen colecciones.
3. El tipo de elemento de una colección anidada declara dos o más propiedades de sub-colección `List<T>`.
4. Una de esas sub-colecciones crece entre la carga y el guardado.

Si falta cualquiera de ellas, la entidad se guarda sin problema, y por eso esto parece intermitente en una base de código real. Este es el modelo más pequeño que satisface las cuatro:

```csharp
// .NET 10, EF Core 10.0.7, Npgsql.EntityFrameworkCore.PostgreSQL 10.0.1
public class Widget
{
    public int Id { get; set; }
    public required FlatData Flat { get; set; }   // JSON column 1
    public required DeepData Deep { get; set; }   // JSON column 2
}

public class FlatData
{
    public string? Note { get; set; }
}

public class DeepData
{
    public List<MiddleData> Middle { get; set; } = [];
}

public class MiddleData
{
    public string Name { get; set; } = "";
    public List<InnerEntry> Inner { get; set; } = [];   // sub-collection 1
    public List<InnerEntry> Extra { get; set; } = [];   // sub-collection 2
}

public class InnerEntry
{
    public string Value { get; set; } = "";
}
```

El mapeo usa `ComplexProperty` para las dos raíces y `ComplexCollection` para todo lo anidado. Basta con `ToJson()` en la raíz; las colecciones anidadas heredan el mapeo JSON:

```csharp
// .NET 10, EF Core 10.0.7
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Widget>(b =>
    {
        b.ComplexProperty(w => w.Flat, c => c.ToJson());

        b.ComplexProperty(w => w.Deep, c =>
        {
            c.ToJson();
            c.ComplexCollection(d => d.Middle, m =>
            {
                m.ComplexCollection(x => x.Inner);
                m.ComplexCollection(x => x.Extra);
            });
        });
    });
}
```

Y las dos líneas que revientan:

```csharp
// .NET 10, EF Core 10.0.7. Throws on SaveChangesAsync, before any SQL is generated.
var widget = await db.Widgets.SingleAsync(w => w.Id == 1);
widget.Deep.Middle[0].Inner.Add(new InnerEntry { Value = "added" });
await db.SaveChangesAsync();
```

Nada de esto es exótico. Es la forma en la que aterrizas en cuanto sigues el propio consejo de Microsoft y mueves un grafo de entidades owned mapeado a JSON hacia tipos complejos, y por eso los reportes se agrupan en equipos que están haciendo esa migración. Si estás evaluando ese cambio, [tipos complejos frente a entidades owned en EF Core 11](/es/2026/07/complex-types-vs-owned-entities-in-ef-core-11/) cubre las compensaciones, y la [guía de mapeo paso a paso](/es/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/) cubre la configuración.

## Solución, en detalle

### Actualiza a EF Core 10.0.10 o posterior

Esta es la corrección real, publicada en el [PR #38373](https://github.com/dotnet/efcore/pull/38373) contra `release/10.0`. Sube todos los paquetes de EF Core a la vez, incluido el proveedor:

```xml
<!-- .NET 10. Bump the provider package to a matching 10.0.x too. -->
<PackageReference Include="Microsoft.EntityFrameworkCore" Version="10.0.12" />
<PackageReference Include="Microsoft.EntityFrameworkCore.Relational" Version="10.0.12" />
```

El cambio le enseña al recorrido recursivo a dejar en paz a las entradas `Added`:

```csharp
// EF Core 10.0.10+, InternalEntryBase.SetComplexCollectionModified
if (recurse)
{
    var newElementState = isModified ? EntityState.Modified : EntityState.Unchanged;
    foreach (var complexEntry in GetFlattenedComplexEntries())
    {
        // Added elements represent pending additions with no original ordinal, so forcing them to
        // Modified/Unchanged is incorrect and would fail the original ordinal validation. Leave their
        // state (computed by change detection) untouched, mirroring the bulk state-change logic in
        // InternalComplexCollectionEntry.SetState.
        if (!UseOldBehavior38299
            && complexEntry.EntityState is EntityState.Added)
        {
            continue;
        }

        complexEntry.SetEntityState(newElementState, modifyProperties: true);
    }
}
```

De leer el parche se siguen dos cosas. La guarda vive en el rastreador de cambios compartido, por encima de la abstracción del proveedor, así que arregla SQL Server, Npgsql y SQLite de una sola vez; si esperabas que subir solo el proveedor ayudara, no lo hará. Y la misma guarda está presente en el código de EF Core 11 sin la bandera `UseOldBehavior38299`, así que actualizar a EF Core 11 también lo resuelve.

### Si estás fijado por debajo de 10.0.10, escribe la columna JSON sin el rastreador de cambios

El fallo vive por completo en el rastreo de cambios. `ExecuteUpdateAsync` nunca se acerca a él, y EF Core 10 puede apuntar directamente a una propiedad compleja mapeada a JSON:

```csharp
// .NET 10, EF Core 10.0.7. Untracked read, then a set-based write.
var deep = await db.Widgets
    .AsNoTracking()
    .Where(w => w.Id == id)
    .Select(w => w.Deep)
    .SingleAsync();

deep.Middle[0].Inner.Add(new InnerEntry { Value = "added" });

await db.Widgets
    .Where(w => w.Id == id)
    .ExecuteUpdateAsync(s => s.SetProperty(w => w.Deep, deep));
```

A cambio pierdes las garantías habituales de `SaveChanges`: no hay comprobación del token de concurrencia optimista, no hay interceptores sobre la escritura, y se reescribe el documento JSON completo en lugar de la única ruta modificada. Verifica la traducción contra tu proveedor antes de comprometerte con esto, y si estás recurriendo a `ExecuteUpdate` de forma más amplia, las compensaciones están trabajadas en [ExecuteUpdate frente a cargar entidades y SaveChanges](/es/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/).

### Si puedes cambiar el modelo, rompe una de las cuatro condiciones

La condición 1 es la más barata de eliminar. El recorrido solo produce el emparejamiento malo de `Added` y `-1` cuando la entidad lleva más de una propiedad compleja JSON, así que mapear la segunda con table splitting la saca del cuadro:

```csharp
// .NET 10, EF Core 10.0.7. Flat becomes Flat_Note on the Widgets table.
b.ComplexProperty(w => w.Flat);   // no ToJson()
```

Esto necesita una migración y cambia tu forma de almacenamiento, así que trátalo como último recurso y no como un desbloqueo rápido. La condición 3 es el otro objetivo blando: si el tipo de elemento anidado solo declara una `List<T>`, la forma cae fuera del disparador reportado. Ninguna de las dos es una garantía del equipo de EF, son la lista minimizada del reportante puesta del revés, así que confírmalas contra tu propio modelo antes de apoyarte en ellas.

## Detalles y variantes: los otros errores de ordinal de esta familia

Otros tres mensajes salen de este mismo rincón del rastreador de cambios y se confunden con este.

**`Complex entry ordinal '-1' is invalid for the collection '...' as it's outside of the collection of length 'N'.`** Fíjate en la redacción: *ordinal*, no *original ordinal*, y *for the collection*, no *for property*. Este se dispara cuando mueves una entidad de `Deleted` de vuelta a `Unchanged`, que es el baile clásico del borrado lógico hecho a mano. Fue [dotnet/efcore#37724](https://github.com/dotnet/efcore/issues/37724), corregido en **10.0.6** restaurando el ordinal actual a partir del original:

```csharp
// EF Core 10.0.6+, InternalComplexEntry.SetEntityState
if (oldState is EntityState.Detached or EntityState.Deleted
    && newState is not EntityState.Detached and not EntityState.Deleted)
{
    if (!UseOldBehavior37724 && Ordinal == -1)
    {
        Ordinal = OriginalOrdinal;
    }

    ContainingEntry.ValidateOrdinal(this, original: false);
}
```

Si estás escribiendo borrado lógico cambiando `EntityState` a mano, considera no hacerlo en absoluto: los [filtros de consulta con nombre](/es/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/) expresan la misma intención sin tocar el rastreador de cambios.

**`Index was out of range. Must be non-negative and less than the size of the collection.`** Una `ArgumentOutOfRangeException`, no una `InvalidOperationException`, lanzada después de que la actualización de la base de datos ya tuvo éxito, durante la fase de aceptación de cambios. Ese es [dotnet/efcore#37585](https://github.com/dotnet/efcore/issues/37585), disparado al quitar un elemento de una colección compleja cuyos elementos contienen sus propias listas. También corregido en **10.0.6**.

**`The complex type collection '...' must be initialized to a non-null value before the elements can be accessed.`** Poner en `null` una propiedad compleja anulable que contiene una colección, sobre una entidad rastreada, donde la colección anidada tiene dos o más elementos. Ese es [dotnet/efcore#38632](https://github.com/dotnet/efcore/issues/38632), planificado para **10.0.13**. A fecha de EF Core 10.0.12, el último parche estable, sigue abierto, así que si este es el mensaje que estás viendo, actualizar todavía no ayuda.

También hay un caso en el que el error de ordinal es realmente culpa tuya y no de EF. `ComplexCollectionEntry` expone un indexador y `GetOriginalEntry(int)`, y ambos validan:

```csharp
// .NET 10, EF Core 10.0.12. Throws if the collection has fewer than 4 elements.
var entry = db.Entry(widget).ComplexCollection(w => w.Deep.Middle)[3];

// Throws if the collection loaded from the database had fewer than 4 elements,
// even when the current collection is longer.
var original = db.Entry(widget).ComplexCollection(w => w.Deep.Middle).GetOriginalEntry(3);
```

La segunda línea es la trampa. Leer una entrada original en un índice que solo existe después de tus adiciones en memoria produce la misma redacción de *original ordinal* que el error de arriba, pero con un ordinal positivo en lugar de `-1`. Si el ordinal de tu mensaje no es `-1`, estás mirando tu propia aritmética de índices.

## ¿Qué hace realmente el switch Microsoft.EntityFrameworkCore.Issue38299?

Cada uno de estos parches se publica detrás de un switch de compatibilidad de `AppContext` en la rama `release/10.0`:

```csharp
// EF Core 10.0.x, InternalEntryBase.InternalComplexCollectionEntry.cs
internal static readonly bool UseOldBehavior37724 =
    AppContext.TryGetSwitch("Microsoft.EntityFrameworkCore.Issue37724", out var enabled) && enabled;

internal static readonly bool UseOldBehavior38299 =
    AppContext.TryGetSwitch("Microsoft.EntityFrameworkCore.Issue38299", out var enabled) && enabled;
```

Lee bien la dirección, porque es al revés de lo que el nombre sugiere a la mayoría. Poner el switch en `true` **restaura el comportamiento viejo y roto**. Existe para que un equipo que construyó una solución alternativa encima del error pueda tomar una versión de parche sin que su solución se rompa. No es una corrección, y activarlo reintroducirá exactamente la excepción que te trajo aquí.

Si de verdad necesitas fijar el comportamiento viejo de forma temporal, va en el archivo de proyecto y no en el código, para que quede establecido antes de que se cargue cualquier tipo de EF:

```xml
<!-- .NET 10. Restores pre-10.0.10 behaviour. Do not use this to "fix" the crash. -->
<ItemGroup>
  <RuntimeHostConfigurationOption Include="Microsoft.EntityFrameworkCore.Issue38299" Value="true" />
</ItemGroup>
```

Los switches sirven además como registro de cambios. Busca con `grep` la cadena `UseOldBehavior` en `src/EFCore/ChangeTracking/Internal/` y obtienes la lista completa de lo que se movió en el rastreo de colecciones complejas a lo largo de la línea de parches 10.0: `37724` y `38299` en `InternalEntryBase`, `37585` y `38632` dentro del struct anidado `InternalComplexCollectionEntry`.

Como los cuatro errores viven en el rastreo de cambios y no en la generación de SQL, ninguno aparece en un registro de consultas, en una traza de profiler ni en un diff de `dotnet ef migrations script`. La primera señal es siempre una excepción en `SaveChanges` con un marco `ValidateOrdinal` cerca de la cima de la pila. Si ves ese marco, deja de leer la configuración de tu modelo y ve directo a las versiones de tus paquetes.

## Relacionados

- [Tipos complejos frente a entidades owned en EF Core 11: ¿cuál elegir?](/es/2026/07/complex-types-vs-owned-entities-in-ef-core-11/)
- [Cómo mapear un tipo complejo en lugar de una entidad owned en EF Core 11](/es/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/)
- [Cómo mapear y consultar columnas JSON en EF Core 11](/es/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/)
- [Solución: AS JSON option can be specified only for column of nvarchar(max) type in WITH clause](/es/2026/09/fix-as-json-option-can-be-specified-only-for-column-of-nvarchar-max-on-azure-sql/)
- [Cómo usar filtros de consulta con nombre para borrado lógico y multi-tenancy en EF Core 11](/es/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/)

## Fuentes

- [dotnet/efcore#38299: ComplexProperty ToJson(): SaveChangesAsync throws "ordinal -1 is invalid" when nested sub-collection grows](https://github.com/dotnet/efcore/issues/38299)
- [dotnet/efcore#38373: la corrección, contra release/10.0](https://github.com/dotnet/efcore/pull/38373)
- [dotnet/efcore#37724: Can't change state of entity with complex collection](https://github.com/dotnet/efcore/issues/37724)
- [dotnet/efcore#37585: Deleting an item from a ComplexCollection that contains an array results in Error](https://github.com/dotnet/efcore/issues/37585)
- [dotnet/efcore#38632: DetectChanges throws "must be initialized to a non-null value"](https://github.com/dotnet/efcore/issues/38632)
- [Tipos complejos, documentación de EF Core](https://learn.microsoft.com/en-us/ef/core/modeling/complex-types)
- [InternalComplexEntry.cs, dotnet/efcore](https://github.com/dotnet/efcore/blob/main/src/EFCore/ChangeTracking/Internal/InternalComplexEntry.cs)
- [InternalEntryBase.InternalComplexCollectionEntry.cs, dotnet/efcore](https://github.com/dotnet/efcore/blob/main/src/EFCore/ChangeTracking/Internal/InternalEntryBase.InternalComplexCollectionEntry.cs)
