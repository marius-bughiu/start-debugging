---
title: "Filtros de consulta con nombre vs un único filtro de consulta global en EF Core 11: ¿cuál usar?"
description: "Ambos generan el mismo SQL. Recurre a los filtros con nombre solo cuando necesites desactivar un predicado de forma independiente; un único filtro combinado es más simple para una sola preocupación en EF Core 11."
pubDate: 2026-07-07
template: vs
tags:
  - "comparison"
  - "efcore"
  - "dotnet"
lang: "es"
translationOf: "2026/07/named-query-filters-vs-a-single-global-query-filter-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-07
---

Si tienes una sola preocupación de filtrado en una entidad, usa un único `HasQueryFilter(e => ...)` sin nombre. Si tienes dos o más preocupaciones que deben levantarse de forma independiente en el momento de la consulta, por ejemplo un filtro de borrado lógico y un filtro de tenant donde una pantalla de administración necesita ver las filas borradas pero nunca las filas de otro tenant, usa filtros con nombre. Esa es toda la decisión. El SQL generado es idéntico en ambos casos; lo único que cambia es si `IgnoreQueryFilters` puede desactivar la mitad de tu predicado. Los filtros de consulta con nombre llegaron en EF Core 10 y son el mecanismo estándar para múltiples filtros en EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0, .NET 11, C# 14).

Todo lo que sigue trata sobre ese único eje: la granularidad de la desactivación. Como ambos enfoques se traducen a la misma cláusula `WHERE`, aquí no hay ninguna historia de rendimiento ni de ecosistema. La comparación es puramente sobre cuánto control necesitas para desactivar filtros.

## Las dos formas, una al lado de la otra

Un filtro de consulta global es un predicado que EF Core inyecta en cada consulta LINQ de un tipo de entidad. Antes de EF Core 10 tenías exactamente uno por entidad, así que una segunda preocupación significaba `&&`:

```csharp
// EF Core 9 style -- one unnamed filter, two concerns welded with &&
// .NET 11, EF Core 11 (Microsoft.EntityFrameworkCore 11.0), C# 14
modelBuilder.Entity<Invoice>()
    .HasQueryFilter(i => !i.IsDeleted && i.TenantId == _tenantId);
```

La sobrecarga con nombre toma primero una clave de tipo string, y las llamadas repetidas se componen en lugar de sobrescribirse:

```csharp
// EF Core 11 -- two named filters on the same entity
modelBuilder.Entity<Invoice>()
    .HasQueryFilter("SoftDeletionFilter", i => !i.IsDeleted)
    .HasQueryFilter("TenantFilter",       i => i.TenantId == _tenantId);
```

Ejecuta una consulta simple contra cualquiera de las dos configuraciones y obtienes las mismas filas y el mismo SQL:

```sql
-- Identical for both the && filter and the two named filters
SELECT ... FROM Invoices WHERE NOT IsDeleted AND TenantId = @__tenantId
```

Eso es lo importante que hay que interiorizar antes de elegir: los filtros con nombre no son "filtrado más potente". Filtran exactamente igual. Lo que compras con la ceremonia adicional es un manejador con nombre que puedes tomar más tarde.

## Matriz de características

| Característica                            | Filtro global único                      | Filtros con nombre                             |
| ----------------------------------------- | ---------------------------------------- | ---------------------------------------------- |
| Filtros por entidad (EF Core 11)          | un predicado sin nombre                  | muchos, cada uno con un nombre                 |
| Combinar múltiples preocupaciones         | `&&` en una expresión                    | una llamada `HasQueryFilter` por preocupación  |
| SQL generado                              | `WHERE` unido con `AND`                  | `WHERE` idéntico unido con `AND`               |
| `IgnoreQueryFilters()` (sin argumentos)   | descarta el filtro completo              | descarta todos los filtros con nombre          |
| `IgnoreQueryFilters(["Name"])`            | no aplica                                | descarta solo ese predicado                    |
| Mezclar con y sin nombre en una entidad   | n/a                                      | lanza al construir el modelo; elige un estilo  |
| Disponible desde                          | EF Core 2.0                              | EF Core 10                                      |
| Impacto en la caché de planes de consulta | parametrizado, un plan                   | parametrizado, un plan                         |
| Ceremonia                                 | la menor                                 | constantes de nombre de filtro, helpers        |

La única fila que cambia un resultado es la fila `IgnoreQueryFilters(["Name"])`. Cualquier otra diferencia es cosmética o una restricción que resuelves una vez.

## Cuándo usar un único filtro global

Recurre al filtro simple sin nombre cuando la direccionalidad adicional no te aporte nada:

- **Una sola preocupación por entidad.** Una tabla de búsqueda de solo lectura que solo necesita `!IsArchived` no tiene nada que desactivar de forma selectiva. `HasQueryFilter(x => !x.IsArchived)` es toda la historia, y un nombre sería peso muerto.
- **Siempre quieres todo o nada.** Si el único momento en que evitas el filtro es una ruta de administración o migración que legítimamente quiere verlo todo, `IgnoreQueryFilters()` sin parámetros es exactamente lo correcto. Ponerle nombre te permitiría hacer menos de lo que quieres, no más.
- **Múltiples preocupaciones que nunca se levantan por separado.** Dos predicados combinados con `&&` están bien cuando ninguna ruta de código necesita uno activado y el otro desactivado. Un filtro `!IsDeleted && OrgId == _orgId` en una herramienta interna donde nunca expones "mostrar borrados" es más simple como una sola expresión.
- **Estás en EF Core 9 o anterior.** La sobrecarga con nombre no existe antes de EF Core 10, así que un único filtro `&&` es la única opción integrada. Si todavía combinas preocupaciones de esta forma, revisa [migrar de EF Core 6 a EF Core 11: cambios disruptivos que realmente muerden](/es/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) antes de separarlas.

La ventaja del filtro único es que no tiene cadenas mágicas. No hay ningún typo `IgnoreQueryFilters(["SoftDeletonFilter"])` esperando a desactivar nada en silencio, porque no hay ningún nombre que escribir mal.

## Cuándo usar filtros con nombre

Ponle nombre a tus filtros en el momento en que dos preocupaciones necesiten diferentes ciclos de vida en una sola consulta:

- **Borrado lógico más multi-tenancy en la misma tabla.** Este es el caso canónico. Un informe de administración necesita ver las facturas borradas, pero debe permanecer acotado al tenant actual. Con `IgnoreQueryFilters(["SoftDeletionFilter"])` el predicado del tenant sobrevive, así que no puedes convertir una pantalla de informes en una brecha de datos entre tenants. El cableado completo está en [cómo usar filtros de consulta con nombre para borrado lógico y multi-tenancy en EF Core 11](/es/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/).
- **Una preocupación "conmutable" junto a una preocupación "nunca desactivada".** Cada vez que un predicado es un límite de seguridad (tenant, propiedad, autorización a nivel de fila) y otro es una conveniencia (borrado lógico, estado publicado/borrador), el nombre te permite exponer el interruptor de conveniencia sin entregar jamás a los que llaman una forma de descartar el límite.
- **Quieres una API que revele la intención para el bypass.** Con nombres puedes envolver el ignore detrás de un método de extensión para que ningún llamante escriba una cadena de filtro:

```csharp
// EF Core 11 -- filter name hidden behind a readable call site
public static class InvoiceFilters
{
    public const string SoftDelete = nameof(SoftDelete);
    public const string Tenant     = nameof(Tenant);
}

public static IQueryable<Invoice> IncludeDeleted(this IQueryable<Invoice> q)
    => q.IgnoreQueryFilters([InvoiceFilters.SoftDelete]); // tenant filter stays on

// Reads like English, cannot leak tenants
var report = await context.Invoices.IncludeDeleted().ToListAsync();
```

- **Los filtros viven en clases de configuración separadas.** Si el borrado lógico viene de una convención `IEntityTypeConfiguration<T>` compartida y el filtro de tenant es específico de la aplicación, dos llamadas con nombre los mantienen desacoplados en lugar de forzar a una clase a ser dueña de una expresión `&&` combinada.

## Por qué no hay sección de benchmark

Un artículo de comparación normalmente te debe números. Este no, y vale la pena decirlo con claridad para que no vayas a buscar una diferencia que no existe. Ambos enfoques se reducen al mismo árbol de predicados, así que EF Core emite la misma cláusula `WHERE` y el planificador de consultas ve el mismo SQL. El valor del tenant se convierte en un parámetro de consulta en ambos casos, lo que significa que ninguno de los dos enfoques fragmenta tu caché de planes como lo haría una constante en línea. No hay coste por consulta al nombrar un filtro; el nombre existe solo en los metadatos del modelo, no en la consulta traducida. Si esperabas que los filtros con nombre fueran también una palanca de rendimiento, no lo son. Elige únicamente por el eje de granularidad de la desactivación. Si estás midiendo el número de consultas mientras añades cualquier filtro, lo que realmente mueve la aguja son los joins, tratado en [cómo detectar consultas N+1 en EF Core 11](/es/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/).

## Los detalles que deciden por ti

Tres restricciones pueden forzar la decisión sin importar cuál preferirías por razones de estilo.

**No puedes mezclar filtros con y sin nombre en una entidad.** Una vez que cualquier filtro sobre `Invoice` tiene un nombre, todos deben tenerlo. Añadir un `HasQueryFilter(i => ...)` sin nombre a una entidad que ya tiene un filtro con nombre lanza en el momento de construir el modelo. Así que la elección es por entidad, no por filtro: decide el estilo una vez, y si alguna vez esperas una segunda preocupación conmutada de forma independiente, empieza con nombres.

**`IgnoreQueryFilters()` sin parámetros sigue arrasando con todo.** Ponerle nombre a tus filtros no hace segura la vieja llamada sin parámetros. `context.Invoices.IgnoreQueryFilters().ToListAsync()` descarta también el filtro de tenant. En cualquier tabla que lleve una columna de tenant, trata la sobrecarga sin argumentos como un mal olor de código y pasa siempre la lista explícita de nombres que pretendes desactivar. Este único hábito es la diferencia entre un interruptor de borrado lógico y una lectura accidental entre tenants.

**Los nombres de filtro como cadenas mágicas fallan en silencio.** `IgnoreQueryFilters(["SoftDeletonFilter"])` con un typo no desactiva nada y no lanza ningún error, porque EF no tiene forma de saber que te referías a un filtro real. Si vas con nombres, fija los nombres en campos `const` (como en el fragmento anterior) para que un typo sea un error de compilación, no una fuga en producción. Un único filtro sin nombre no tiene esa trampa, lo que es un punto genuino a su favor cuando solo tienes una preocupación.

Un detalle se aplica por igual a ambos y no es un desempate: un filtro en el lado requerido de una navegación convierte `Include` en un `INNER JOIN`, así que un padre filtrado descarta en silencio a sus hijos. Ese comportamiento es idéntico tanto si el predicado tiene nombre como si se combina con `&&`. La solución, un `LEFT JOIN` vía una navegación opcional o un filtro coincidente en ambos extremos, es la misma en cualquiera de los dos mundos y se explica paso a paso en la [guía de filtros de consulta con nombre](/es/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/).

## Migrar de un filtro combinado a filtros con nombre

Si ya distribuyes un filtro `!IsDeleted && TenantId == x` y ahora necesitas exponer "mostrar borrados" sin descartar el acotamiento por tenant, la migración es mecánica. Divide la única expresión en dos llamadas con nombre:

```csharp
// Before -- one filter, cannot disable half of it
modelBuilder.Entity<Invoice>()
    .HasQueryFilter(i => !i.IsDeleted && i.TenantId == _tenantId);

// After -- two named filters, soft delete now independently ignorable
modelBuilder.Entity<Invoice>()
    .HasQueryFilter(InvoiceFilters.SoftDelete, i => !i.IsDeleted)
    .HasQueryFilter(InvoiceFilters.Tenant,     i => i.TenantId == _tenantId);
```

Nada del comportamiento de consulta por defecto cambia; vuelven las mismas filas y se genera el mismo SQL. La única capacidad nueva es que `IgnoreQueryFilters([InvoiceFilters.SoftDelete])` existe ahora como un bypass dirigido. Como no puedes mezclar estilos, haz esta división para toda la entidad en una sola edición, y audita cada llamada `IgnoreQueryFilters()` existente sobre esa entidad: cualquier llamada sin parámetros que solía significar "vista de administración con borrados" ya estaba descartando el filtro de tenant, y dividir el filtro es el momento de hacer esas llamadas explícitas.

## La decisión

Por defecto, un único filtro de consulta global sin nombre. Es la opción de menor ceremonia, no tiene cadenas mágicas, y para el caso común de una sola preocupación por entidad es estrictamente la elección correcta. Sube a filtros con nombre en el instante en que una segunda preocupación necesite conmutarse de forma independiente de la primera, lo que en la práctica casi siempre significa "borrado lógico junto a un límite de tenant o de propiedad". La regla práctica: si puedes imaginar una consulta que quiere un predicado desactivado y el otro activado, ponles nombre ahora; de lo contrario combina con `&&` y sigue adelante. El SQL no notará la diferencia, pero tu yo futuro depurando por qué un informe de administración filtró las facturas de otro tenant sí que la notará.

## Relacionados

- [Cómo usar filtros de consulta con nombre para borrado lógico y multi-tenancy en EF Core 11](/es/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/)
- [AsNoTracking vs AsNoTrackingWithIdentityResolution en EF Core 11](/es/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/)
- [Cómo usar interceptores de EF Core 11 para auditoría](/es/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/)
- [EF Core ExecuteUpdate vs cargar entidades y SaveChanges](/es/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/)
- [Cómo detectar consultas N+1 en EF Core 11](/es/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)

## Fuentes

- [Global Query Filters, documentación de EF Core (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/querying/filters)
- [What's New in EF Core 10 (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew)
- [Named Query Filters in EF 10: multiple query filters per entity, Milan Jovanovic](https://www.milanjovanovic.tech/blog/named-query-filters-in-ef-10-multiple-query-filters-per-entity/)
- [Named global query filters in Entity Framework Core 10, Tim Deschryver](https://timdeschryver.dev/blog/named-global-query-filters-in-entity-framework-core-10)
- [Add ability to configure multiple query filters on a given DbSet, dotnet/efcore issue #33432](https://github.com/dotnet/efcore/issues/33432)
