---
title: "Solución: The complex type collection must be initialized to a non-null value"
description: "En EF Core 10.0.x, poner en null una propiedad compleja que contiene una colección de dos elementos dentro de una colección compleja ToJson rompe DetectChanges. Corregido en 11.0.0-rc.1."
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
translationOf: "2026/09/fix-the-complex-type-collection-must-be-initialized-to-a-non-null-value"
translatedBy: "claude"
translationDate: 2026-09-09
---

`The complex type collection '...' must be initialized to a non-null value before the elements can be accessed.` tiene dos causas que comparten un mismo mensaje. Si la ruta del mensaje nombra una propiedad que simplemente nunca asignaste, inicialízala (`public List<Entry> Entries { get; set; } = new();`) y listo. Si la propiedad está inicializada y la excepción sale de `DetectChanges` o `SaveChanges`, te topaste con [dotnet/efcore#38632](https://github.com/dotnet/efcore/issues/38632): en EF Core 10.0.0 hasta 10.0.12, asignar `null` a una propiedad compleja anulable cuyo tipo contiene una colección de dos o más elementos, dentro de una colección compleja mapeada con `ToJson()`, hace fallar la detección de cambios antes de que se genere SQL alguno. La corrección ya está integrada y llega en `11.0.0-rc.1`; el backport a 10.0.x tiene el hito 10.0.13 y todavía no salió.

## El error en contexto

El mensaje proviene de `CoreStrings.ComplexCollectionNotInitialized`, y conviene leerlo carácter por carácter, porque otros cuatro mensajes de este rincón del rastreador de cambios se ven casi iguales:

```
System.InvalidOperationException: The complex type collection 'Root[]Group[]Item.Meta.Entries'
must be initialized to a non-null value before the elements can be accessed.
```

En el caso del bug, los marcos que importan van, del más interno al más externo, de `InternalComplexCollectionEntry.GetEntry` a `InternalComplexEntry.set_Ordinal`, luego a `InternalComplexCollectionEntry.RemoveEntry` y finalmente a `ChangeDetector.DetectComplexCollectionChanges`. Si tu traza de pila contiene `RemoveEntry` y `set_Ordinal`, estás ante el bug de EF, no ante un null propio. Si en cambio la cima de la pila es tu propia llamada a `EntityEntry.ComplexCollection(...)`, estás ante la causa 1 de más abajo.

La ruta de la propiedad es una cadena aplanada, no una expresión de C#. `[]` marca un salto a través de una colección compleja y va seguido del tipo del elemento, así que `Root[]Group[]Item.Meta.Entries` se lee como "la colección `Entries` de `Meta`, que cuelga de un elemento `Item`, que vive dentro de un elemento `Group`, que vive en una colección de `Root`". Esa ruta es la vía más rápida para encontrar la propiedad culpable en un modelo profundo.

## Por qué el rastreador de cambios no acepta una colección nula

Las colecciones complejas llegaron en EF Core 10, y en proveedores relacionales [deben mapearse a una única columna JSON con `ToJson()`](https://learn.microsoft.com/en-us/ef/core/modeling/complex-types). No pueden ir a una tabla propia. Esa restricción es la razón misma de que exista este mensaje: sin tabla y sin clave, EF no puede identificar un elemento por su clave primaria como hace con una entidad de propiedad. Lo identifica por su **posición en la lista de CLR**.

Por eso `InternalComplexCollectionEntry` mantiene dos listas paralelas de entradas, una para valores actuales y otra para valores originales, y cada entrada que entrega deriva de la colección de CLR que está realmente en el objeto. `GetEntry` no puede inventar una posición en una lista que no existe:

```csharp
// EF Core 10 and 11, InternalEntryBase.InternalComplexCollectionEntry.GetEntry
if (original)
{
    if (_containingEntry.GetOriginalValue(_complexCollection) == null)
    {
        throw new InvalidOperationException(
            CoreStrings.ComplexCollectionEntryOriginalNull(
                _complexCollection.DeclaringType.ShortNameChain(), _complexCollection.Name));
    }
}
else
{
    if (_containingEntry[_complexCollection] == null)
    {
        throw new InvalidOperationException(
            CoreStrings.ComplexCollectionNotInitialized(
                _complexCollection.DeclaringType.ShortNameChain(), _complexCollection.Name));
    }
}
```

Dos ramas, dos mensajes distintos. `ComplexCollectionNotInitialized` es la rama del valor actual. Si en su lugar obtienes `The original entries cannot be accessed for the complex type collection '...' as it was originally 'null'`, la colección era `null` cuando se materializó la fila y la inicializaste después.

Fíjate en lo que hace `ChangeDetector`, porque explica por qué una colección nula no siempre explota. `DetectComplexCollectionChanges` lee ambos lados y trata una diferencia de nulabilidad como un cambio, no como un error:

```csharp
// EF Core 11, ChangeDetector.DetectComplexCollectionChanges
var currentCollection = (IList?)entry[complexProperty];
var originalCollection = (IList?)entry.GetOriginalValue(complexProperty);
var changesFound = currentCollection == null != (originalCollection == null);
```

Ambos bucles de elementos están protegidos por `!= null`. Así que una colección nula a secas sobrevive a la detección de cambios; solo falla cuando algo intenta alcanzar un *elemento*.

## Causa 1: la propiedad de colección realmente es null

Aquí el mensaje está haciendo su trabajo. Se dispara en cuanto indexas la entrada del rastreador de cambios para una colección que nunca fue asignada:

```csharp
// .NET 10, EF Core 10.0.12. Throws ComplexCollectionNotInitialized.
public class Distributor
{
    public int Id { get; set; }
    public required string Name { get; set; }
    public List<Address> ShippingCenters { get; set; } = null!;  // never assigned
}

var entry = db.Entry(distributor).ComplexCollection(d => d.ShippingCenters)[0];
```

La guía de Microsoft es tajante al respecto: inicializa la colección en línea para que la propiedad nunca pueda ser null.

```csharp
// .NET 10, EF Core 10.0.12. The documented shape.
public List<Address> ShippingCenters { get; set; } = new();
```

A diferencia de una colección de navegación, EF no crea la lista por ti, y no hay proxy de carga diferida que disimule el problema. Vale la pena revisar dos variantes de la misma causa antes de salir a cazar un bug:

- **Una propiedad de colección anulable.** Si declaraste `List<Address>? ShippingCenters` y la columna JSON contiene `NULL` de SQL, la materialización te devuelve `null` fielmente, y el primer acceso a un elemento falla. O bien haces la propiedad no anulable y rellenas la columna con `'[]'`, o bien compruebas el null antes de tocar el rastreador de cambios.
- **Una propiedad compleja anulable en la ruta.** En `Root[]Group[]Item.Meta.Entries`, puede que `Entries` esté inicializada en cada `Meta` que construyes, pero si `Meta` es `null` no hay ninguna `Entries` que leer. Esa es exactamente la forma del bug de EF que viene abajo, y también una forma que puedes provocar tú al indexar el rastreador sobre un elemento cuyo `Meta` acabas de limpiar.

Si este estilo de mapeo es nuevo para ti, [tipos complejos frente a entidades de propiedad en EF Core 11](/es/2026/07/complex-types-vs-owned-entities-in-ef-core-11/) explica por qué los tipos complejos se comportan distinto de los grafos de entidades de propiedad que la mayoría está abandonando, y la [guía de mapeo paso a paso](/es/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/) cubre la configuración en sí.

## Causa 2: dotnet/efcore#38632, la ruta de reindexado

El caso interesante es aquel en el que todas las colecciones de tu modelo están inicializadas y aun así la excepción sale de `SaveChangesAsync`. Tienen que alinearse cuatro condiciones, y son lo bastante comunes en un modelo real como para que la gente caiga en esto sin hacer nada raro.

```csharp
// .NET 10, EF Core 10.0.12. Complex types are never discovered by convention,
// so every value type here carries [ComplexType].
public class Root
{
    public int Id { get; set; }
    public required string Name { get; set; }
    public List<Group> Groups { get; set; } = new();
}

[ComplexType]
public class Group
{
    public required string Title { get; set; }
    public List<Item> Items { get; set; } = new();
}

[ComplexType]
public class Item
{
    public required string Sku { get; set; }
    public Meta? Meta { get; set; }               // nullable complex property
}

[ComplexType]
public class Meta
{
    public required string Kind { get; set; }     // optional complex types need one required property
    public List<Entry> Entries { get; set; } = new();
}

[ComplexType]
public class Entry
{
    public required string Key { get; set; }
    public string? Value { get; set; }
}
```

```csharp
// .NET 10, EF Core 10.0.12. On relational providers a complex collection must be JSON.
modelBuilder.Entity<Root>()
    .ComplexCollection(r => r.Groups, g => g.ToJson());
```

Y la mutación, que es más o menos lo más ordinario que puede ser un cargar-modificar-guardar:

```csharp
// .NET 10, EF Core 10.0.12. Throws inside DetectChanges, before any SQL is sent.
var root = await db.Roots.SingleAsync(r => r.Id == 1);

var item = root.Groups[0].Items[0];
// item.Meta.Entries came back from the JSON column with two elements.
item.Meta = null;

await db.SaveChangesAsync();
```

Poner `Meta` en null elimina la entrada compleja contenedora. La eliminación dispara un reindexado de las entradas que quedaban detrás, y ese reindexado asigna `Ordinal` en cada entrada superviviente, lo que vuelve a entrar en `GetEntry` para `Meta.Entries`. Para entonces `Meta` ya es `null`, así que la rama del valor actual de más arriba lanza la excepción. Con un elemento o ninguno en `Entries` no hay nada que reindexar y ese mismo código guarda sin problemas, que es la razón por la que el bug parece tan arbitrario visto desde fuera.

Quien lo reportó lo vio en 10.0.9 y 10.0.10, un comentarista lo volvió a confirmar en 10.0.11 el 2026-08-15, y el issue sigue abierto contra 10.0.12, el parche estable actual. Es independiente del proveedor, confirmado tanto en Npgsql como en SQLite, porque el fallo está en el rastreador de cambios compartido, por encima de la abstracción del proveedor. Subir solo la versión del proveedor no ayuda.

## Solución, en detalle

### Pasar a EF Core 11 RC1

El [PR #38667](https://github.com/dotnet/efcore/pull/38667) se integró en `main` el 2026-07-20 con el hito 11.0-rc1, así que la corrección ya está hoy en los paquetes `11.0.0-rc.1.26425.128`. El cambio es una reordenación, no lógica nueva: las entradas rastreadas se devuelven ahora antes de comprobar si la colección de CLR es null, de modo que el reindexado durante la limpieza funciona incluso cuando el valor complejo padre ya pasó a `null`.

```csharp
// EF Core 11, InternalEntryBase.InternalComplexCollectionEntry.GetEntry
// Must check tracked entries first to allow reindexing during cleanup when the parent is null.
var existingEntries = original ? _originalEntries : _entries;
if (existingEntries != null
    && (uint)ordinal < (uint)existingEntries.Count
    && existingEntries[ordinal] is { } existingEntry)
{
    return existingEntry;
}
```

```xml
<!-- .NET 10 or .NET 11. Bump the provider package to a matching 11.0.0-rc.1 too. -->
<PackageReference Include="Microsoft.EntityFrameworkCore" Version="11.0.0-rc.1.26425.128" />
```

EF Core 11 pasa a estable junto con .NET 11 en noviembre de 2026, así que esta es una ventana corta de versión preliminar y no algo indefinido. Aun así es una versión preliminar, así que lee el resto de las notas de la versión de EF Core 11 antes de llevarlo a producción.

### Sigue el 10.0.13 si necesitas una versión de servicing

El issue se reabrió después de la corrección en `main` justamente para seguir el backport a `release/10.0`, y lleva el hito 10.0.13. Si estás en una banda de servicing soportada y no puedes tomar una versión preliminar, esa es la versión que hay que vigilar. Hasta entonces, actualizar dentro de 10.0.x no lo resuelve.

### Divide la mutación en dos SaveChanges

El disparador necesita dos o más elementos en la colección anidada en el momento en que el padre pasa a null. Reducir la colección en su propio guardado, de modo que tanto la instantánea actual como la original estén vacías antes de anular el padre, evita el reindexado por completo:

```csharp
// .NET 10, EF Core 10.0.12. Two round trips, no reindex over a null parent.
var root = await db.Roots.SingleAsync(r => r.Id == 1);
var item = root.Groups[0].Items[0];

item.Meta!.Entries.Clear();
await db.SaveChangesAsync();   // original values are accepted here

item.Meta = null;
await db.SaveChangesAsync();
```

Esto es la lista minimizada de disparadores de quien reportó el bug puesta del revés, no una garantía del equipo de EF, y te cuesta un viaje extra a la base de datos y la atomicidad de un único guardado. Envuelve ambas llamadas en una transacción explícita si el estado intermedio no es uno que quieras que vea otro lector, y confírmalo contra tu propio modelo antes de depender de ello.

### Escribe la columna JSON sin el rastreador de cambios

El fallo vive por completo en la detección de cambios, y `ExecuteUpdateAsync` nunca se acerca a ella. EF Core 10 puede apuntar directamente a una colección compleja mapeada a JSON:

```csharp
// .NET 10, EF Core 10.0.12. Untracked read, then a set-based write.
var groups = await db.Roots
    .AsNoTracking()
    .Where(r => r.Id == id)
    .Select(r => r.Groups)
    .SingleAsync();

groups[0].Items[0].Meta = null;

await db.Roots
    .Where(r => r.Id == id)
    .ExecuteUpdateAsync(s => s.SetProperty(r => r.Groups, groups));
```

Renuncias a las garantías habituales de `SaveChanges` para esta escritura: sin comprobación de concurrencia optimista, sin interceptores de `SaveChanges`, y se reescribe el documento JSON completo en lugar de la única ruta cambiada. Si vas a recurrir a este patrón de forma más general, los compromisos están analizados en [ExecuteUpdate frente a cargar entidades y SaveChanges](/es/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/).

## Mensajes parecidos que aterrizan en esta página

Hay otras cuatro cadenas en `CoreStrings` que mencionan colecciones complejas y valores nulos, y no tienen nada que ver con #38632.

**`The original entries cannot be accessed for the complex type collection '...' as it was originally 'null'.`** Es `ComplexCollectionEntryOriginalNull`, la rama hermana del mismo `if`. La colección era `null` cuando se materializó la fila. Leer valores originales de una colección que nunca los tuvo no es un bug, es una pregunta sin respuesta. Refresca la entidad o deja de leer valores originales por esa ruta.

**`The value for the property '...' cannot be set, because it's on the complex type collection element '...[N]' that contains a 'null' value.`** Es `ComplexCollectionNullElementSetter`. La colección existe, pero uno de sus *elementos* es `null`. Un arreglo JSON de la forma `[{...}, null]` lo provoca. Filtra los nulos antes de guardar, o deja de escribirlos en el arreglo.

**`Complex entry original ordinal '-1' is invalid for property '...' as it's outside of the collection of length 'N'.`** Un bug distinto con una corrección distinta, tratado en [Complex entry original ordinal '-1' is invalid al guardar una colección compleja ToJson](/es/2026/09/fix-complex-entry-original-ordinal-is-invalid-when-saving-a-tojson-complex-collection/). Fíjate en la redacción: *original ordinal*, y *for property*. Ese se corrigió en 10.0.10, así que a diferencia de este, actualizar dentro de 10.0.x sí lo resuelve.

**`The complex type collection '...' cannot be configured because complex value type collections are not supported.`** Es `ComplexValueTypeCollection`, lanzado al construir el modelo, no al guardar. Los elementos de una colección compleja deben ser tipos de referencia; una `List<Coordinate>` donde `Coordinate` es un `readonly record struct` no se mapea. Sigue [dotnet/efcore#31411](https://github.com/dotnet/efcore/issues/31411) si lo necesitas.

Si tu error menciona `AS JSON option can be specified only for column of nvarchar(max)` en su lugar, eso es un problema de tipo de columna de SQL Server y no del rastreador de cambios, y se trata aparte en [la solución de AS JSON en Azure SQL](/es/2026/09/fix-as-json-option-can-be-specified-only-for-column-of-nvarchar-max-on-azure-sql/). Para la historia general del mapeo, [cómo mapear y consultar columnas JSON en EF Core 11](/es/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) es el punto de partida.

## Fuentes

- [dotnet/efcore#38632: ComplexCollection + ToJson(): DetectChanges throws "must be initialized to a non-null value"](https://github.com/dotnet/efcore/issues/38632)
- [dotnet/efcore#38667: la corrección, integrada el 2026-07-20](https://github.com/dotnet/efcore/pull/38667)
- [Tipos complejos, documentación de EF Core](https://learn.microsoft.com/en-us/ef/core/modeling/complex-types)
- [Versiones y planificación de EF Core](https://learn.microsoft.com/en-us/ef/core/what-is-new/)
- [InternalEntryBase.InternalComplexCollectionEntry.cs, dotnet/efcore](https://github.com/dotnet/efcore/blob/main/src/EFCore/ChangeTracking/Internal/InternalEntryBase.InternalComplexCollectionEntry.cs)
- [ChangeDetector.cs, dotnet/efcore](https://github.com/dotnet/efcore/blob/main/src/EFCore/ChangeTracking/Internal/ChangeDetector.cs)
- [CoreStrings.resx, dotnet/efcore](https://github.com/dotnet/efcore/blob/main/src/EFCore/Properties/CoreStrings.resx)
