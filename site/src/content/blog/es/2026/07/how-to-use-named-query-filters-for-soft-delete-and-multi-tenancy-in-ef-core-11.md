---
title: "Cómo usar filtros de consulta con nombre para borrado lógico y multi-tenancy en EF Core 11"
description: "Aplica dos filtros de consulta globales independientes a la misma entidad en EF Core 11: un filtro de borrado lógico y un filtro de tenant, cada uno con nombre para poder desactivar uno sin el otro con IgnoreQueryFilters."
pubDate: 2026-07-03
template: how-to
tags:
  - "dotnet"
  - "efcore"
  - "csharp"
lang: "es"
translationOf: "2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-03
---

Para ejecutar un filtro de borrado lógico y un filtro de multi-tenancy sobre la misma entidad en EF Core 11, dale un nombre a cada uno: llama a `HasQueryFilter("SoftDeletionFilter", e => !e.IsDeleted)` y a `HasQueryFilter("TenantFilter", e => e.TenantId == _tenantId)` en `OnModelCreating`. Ambos se aplican por defecto a cada consulta. Cuando una pantalla de administración necesite ver filas borradas lógicamente, desactiva solo ese filtro con `IgnoreQueryFilters(["SoftDeletionFilter"])`, y el filtro de tenant sigue activo para que nunca filtres los datos de otro tenant. Los filtros de consulta con nombre llegaron en EF Core 10 y son la forma estándar de apilar filtros en EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0, .NET 11, C# 14). Esta publicación muestra la configuración completa: conectar el id del tenant al contexto, marcar los borrados automáticamente, desactivar filtros de forma selectiva y el problema del join que descarta filas en silencio.

## Por qué un solo filtro por entidad nunca fue suficiente

Un filtro de consulta global es una cláusula `Where` extra que EF Core inyecta en cada consulta de un tipo de entidad. Dominan dos casos de uso. El borrado lógico mantiene las filas en la tabla con un indicador `IsDeleted` en lugar de emitir `DELETE`, así obtienes una traza de auditoría y una vía para deshacer. La multi-tenancy almacena filas de muchos clientes en una tabla con una columna `TenantId`, y el filtro garantiza que una consulta solo vea las filas del tenant actual. Ambos son exactamente el tipo de predicado transversal que nunca quieres escribir a mano en cada `Where`, porque el único lugar donde lo olvides es un bug de fuga de datos.

El problema antes de EF Core 10 era que cada tipo de entidad podía tener exactamente un filtro. Llamar a `HasQueryFilter` dos veces no apilaba los predicados, reemplazaba el primero en silencio:

```csharp
// EF Core 9 and earlier -- the second call WINS, soft delete is lost
modelBuilder.Entity<Invoice>().HasQueryFilter(i => !i.IsDeleted);
modelBuilder.Entity<Invoice>().HasQueryFilter(i => i.TenantId == _tenantId);
// Result: only the tenant filter is active. Deleted rows come back.
```

La solución alternativa era combinar todo con `&&` en una sola expresión:

```csharp
// EF Core 9 -- works, but the two concerns are now welded together
modelBuilder.Entity<Invoice>()
    .HasQueryFilter(i => !i.IsDeleted && i.TenantId == _tenantId);
```

Eso compila y filtra correctamente, pero tiene un filo peligroso: no puedes desactivar la mitad. `IgnoreQueryFilters()` es todo o nada. En cuanto un informe de administración necesite incluir facturas borradas lógicamente, llamas a `IgnoreQueryFilters()`, y ahora el filtro de tenant también desaparece. En un sistema multi-tenant eso no es una molestia, es un incidente de seguridad. Los filtros con nombre existen precisamente para hacer posible el "desactiva uno, mantén el otro".

## Definir dos filtros con nombre en una entidad

En EF Core 11, `HasQueryFilter` tiene una sobrecarga que toma una clave de filtro como primer argumento. Proporciona un nombre y las llamadas se componen en lugar de sobrescribirse:

```csharp
// .NET 11, EF Core 11 (Microsoft.EntityFrameworkCore 11.0), C# 14
public class Invoice
{
    public int Id { get; set; }
    public int TenantId { get; set; }
    public bool IsDeleted { get; set; }
    public decimal Amount { get; set; }
}

public class BillingContext(string tenantId) : DbContext
{
    private readonly int _tenantId = int.Parse(tenantId);

    public DbSet<Invoice> Invoices => Set<Invoice>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Invoice>()
            .HasQueryFilter("SoftDeletionFilter", i => !i.IsDeleted)
            .HasQueryFilter("TenantFilter", i => i.TenantId == _tenantId);
    }
}
```

Ahora una consulta simple queda filtrada por ambos predicados:

```csharp
// SELECT ... FROM Invoices WHERE NOT IsDeleted AND TenantId = @__tenantId
var invoices = await context.Invoices.ToListAsync();
```

Ambos predicados aterrizan en la misma cláusula SQL `WHERE`, combinados con `AND`, exactamente como producía la versión con `&&`. La diferencia está por completo en lo que puedes hacer a continuación: cada predicado ahora tiene un asa a la que puedes agarrarte por su nombre.

Una regla que el compilador no detectará: no puedes mezclar un filtro con nombre y uno sin nombre en el mismo tipo de entidad. Una vez que cualquier filtro de `Invoice` tenga nombre, todos deben tenerlo. Un `HasQueryFilter(i => ...)` sin nombre sobre una entidad que ya tiene filtros con nombre lanza una excepción al construir el modelo. Elige un estilo por entidad y mantente en él.

## Llevar el id del tenant al contexto

Un filtro de borrado lógico es una expresión constante, pero un filtro de tenant necesita un valor en tiempo de ejecución, y el filtro solo puede leer estado que viva en la instancia del contexto. La conexión más limpia es resolver el tenant actual una sola vez cuando se construye el contexto. En una aplicación ASP.NET Core, eso normalmente significa leerlo del usuario autenticado y pasarlo al contexto mediante inyección de dependencias:

```csharp
// .NET 11 -- resolve tenant per request and feed it to the context
builder.Services.AddScoped<ITenantProvider, HttpTenantProvider>();

builder.Services.AddDbContext<BillingContext>((sp, options) =>
{
    options.UseSqlServer(connectionString);
});

// A small provider that pulls the tenant from the current principal
public sealed class HttpTenantProvider(IHttpContextAccessor accessor) : ITenantProvider
{
    public int TenantId =>
        int.Parse(accessor.HttpContext!.User.FindFirstValue("tenant_id")!);
}
```

Luego referencia el proveedor desde el contexto. Leer el tenant de forma perezosa dentro del filtro (en lugar de cachearlo en un campo) importa más de lo que parece, y la siguiente sección explica por qué:

```csharp
// EF Core 11 -- the filter closes over a field EF re-reads on each query
public class BillingContext(DbContextOptions<BillingContext> options,
                            ITenantProvider tenant) : DbContext(options)
{
    private int TenantId => tenant.TenantId;

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Invoice>()
            .HasQueryFilter("SoftDeletionFilter", i => !i.IsDeleted)
            .HasQueryFilter("TenantFilter", i => i.TenantId == TenantId);
    }
}
```

EF Core evalúa la expresión del tenant en el momento de la consulta, no al construir el modelo, así que la propiedad se lee en cada consulta y se traduce a un parámetro. Eso mantiene reutilizable el plan de consulta compilado entre tenants sin dejar de aislar las filas.

### La trampa del pooling de DbContext

Si usas `AddDbContextPool`, ten cuidado: un contexto agrupado se reutiliza entre solicitudes, y su constructor no vuelve a ejecutarse al reutilizarse. Un id de tenant capturado en un campo dentro del constructor quedará obsoleto para la segunda solicitud que reciba esa instancia agrupada. O bien evita el pooling para un contexto con ámbito de tenant, o resuelve el tenant a través de un proveedor con ámbito (scoped) leído en el momento de la consulta como se muestra arriba, nunca un valor congelado en la construcción. Esta es la forma más común en la que los filtros de tenant con nombre filtran datos en producción.

## Borrado lógico sin tocar cada punto de llamada

El filtro oculta las filas borradas, pero algo todavía tiene que poner `IsDeleted = true`. No quieres eso disperso por los servicios. Sobrescribe `SaveChangesAsync` y convierte los borrados en actualizaciones en el punto de estrangulamiento por el que pasa cada escritura:

```csharp
// EF Core 11 -- intercept deletes and turn them into soft deletes
public override async Task<int> SaveChangesAsync(CancellationToken ct = default)
{
    ChangeTracker.DetectChanges();

    foreach (var entry in ChangeTracker.Entries<Invoice>()
                 .Where(e => e.State == EntityState.Deleted))
    {
        entry.State = EntityState.Modified;
        entry.CurrentValues["IsDeleted"] = true;
    }

    return await base.SaveChangesAsync(ct);
}
```

Ahora `context.Invoices.Remove(invoice)` seguido de `SaveChangesAsync` emite un `UPDATE` que cambia el indicador, y el filtro de consulta hace que la fila desaparezca de las lecturas normales. Si ya ejecutas un `ISaveChangesInterceptor` para el marcado de auditoría, ese es un hogar aún mejor para esta lógica. Consulta [cómo usar interceptores de EF Core 11 para auditoría](/es/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/) para ver la versión con interceptor, que deja `SaveChanges` intacto y sobrevive a ser invocada desde cualquier repositorio.

## Desactivar un filtro y mantener el otro

Este es todo el sentido de dar nombres. `IgnoreQueryFilters` acepta una colección de nombres de filtro, y solo esos se desactivan:

```csharp
// EF Core 11 -- see deleted invoices, but STILL scoped to the current tenant
var withDeleted = await context.Invoices
    .IgnoreQueryFilters(["SoftDeletionFilter"])
    .ToListAsync();
// SQL: WHERE TenantId = @__tenantId   (soft-delete predicate dropped, tenant kept)
```

El filtro de tenant queda intacto, así que un administrador que vea "todas las facturas incluidas las borradas" nunca ve los datos de otro cliente. El `IgnoreQueryFilters()` sin parámetros todavía existe y todavía desactiva todo, lo que casi nunca quieres en una entidad filtrada por tenant. Trata la llamada sin parámetros como un olor a código en cualquier tabla que lleve una columna de tenant.

### Nombra tus filtros con constantes, no con literales de cadena

Los nombres de filtro son cadenas mágicas, y un error tipográfico en `IgnoreQueryFilters(["SoftDeletonFilter"])` falla en silencio al no desactivar nada. Fija los nombres una sola vez:

```csharp
// EF Core 11 -- one source of truth for filter names
public static class InvoiceFilters
{
    public const string SoftDelete = nameof(SoftDelete);
    public const string Tenant = nameof(Tenant);
}

modelBuilder.Entity<Invoice>()
    .HasQueryFilter(InvoiceFilters.SoftDelete, i => !i.IsDeleted)
    .HasQueryFilter(InvoiceFilters.Tenant, i => i.TenantId == TenantId);
```

Luego envuelve la llamada a ignore en un método de extensión para que ningún consumidor escriba nunca un nombre de filtro:

```csharp
// EF Core 11 -- intent-revealing API, filter name hidden
public static IQueryable<Invoice> IncludeDeleted(this IQueryable<Invoice> query)
    => query.IgnoreQueryFilters([InvoiceFilters.SoftDelete]);

// Call site reads like English and cannot leak tenants
var report = await context.Invoices.IncludeDeleted().ToListAsync();
```

## El join de navegación requerida que descarta filas en silencio

El problema más desagradable con los filtros de consulta no tiene nada que ver con los nombres, y muerde con más fuerza en modelos multi-tenant donde cada tabla lleva un filtro. Cuando una entidad filtrada está en el lado requerido de una navegación, EF Core traduce un `Include` a un `INNER JOIN`. Si el filtro elimina la fila padre, el inner join elimina también al hijo, y obtienes menos resultados de los que esperabas.

Considera un `Blog` filtrado con hijos `Post` requeridos:

```csharp
// EF Core 11 -- required navigation plus a filter on the principal
modelBuilder.Entity<Blog>().HasMany(b => b.Posts).WithOne(p => p.Blog).IsRequired();
modelBuilder.Entity<Blog>().HasQueryFilter("UrlFilter", b => b.Url.Contains("fish"));

var allPosts = await db.Posts.ToListAsync();                       // returns 6
var withBlog = await db.Posts.Include(p => p.Blog).ToListAsync();  // returns 3
```

La segunda consulta descarta todos los posts cuyo blog fue filtrado, porque el `INNER JOIN` exige una fila de blog coincidente. La documentación de Microsoft lo señala directamente: usar una navegación requerida para alcanzar una entidad que tiene un filtro de consulta global "puede llevar a resultados inesperados". Hay dos soluciones. Haz la navegación opcional para que EF emita un `LEFT JOIN`:

```csharp
// EF Core 11 -- LEFT JOIN keeps the children even when the parent is filtered
modelBuilder.Entity<Blog>().HasMany(b => b.Posts).WithOne(p => p.Blog).IsRequired(false);
```

O, mejor para la multi-tenancy, aplica el mismo filtro de forma consistente a ambos extremos para que las filas hijas que quedarían colgando se eliminen en su origen:

```csharp
// EF Core 11 -- matching filters on both entities keep the two queries in sync
modelBuilder.Entity<Blog>().HasQueryFilter("UrlFilter", b => b.Url.Contains("fish"));
modelBuilder.Entity<Post>().HasQueryFilter("UrlFilter", p => p.Blog.Url.Contains("fish"));
```

El enfoque del filtro consistente es el valor por defecto correcto cuando tu columna de tenant vive en cada tabla: un `TenantFilter` tanto en `Blog` como en `Post` significa que ni un `INNER JOIN` ni un `LEFT JOIN` pueden hacer aparecer una fila de otro tenant.

## Límites que conviene conocer antes de comprometerte

Unas pocas restricciones dan forma a hasta dónde puedes llevar esto. Los filtros solo pueden definirse en el tipo de entidad raíz de una jerarquía de herencia, así que no puedes poner un filtro distinto en cada tipo derivado de un mapeo tabla por jerarquía. EF Core no detecta ciclos en las definiciones de filtros, así que un filtro sobre `Blog` que referencia a `Post` cuyo filtro referencia a `Blog` puede quedar en bucle infinito durante la traducción, así que defínelos con cuidado. Y si configuras las entidades mediante clases `IEntityTypeConfiguration<T>` en lugar de directamente en `OnModelCreating`, no hay ninguna instancia del contexto de la que leer el tenant dentro de `Configure`; la solución documentada es añadir un campo de contexto privado a la clase de configuración y referenciarlo desde la expresión del filtro.

Una nota de rendimiento: como el valor del tenant se convierte en un parámetro de consulta, los predicados de borrado lógico y de tenant no fragmentan tu caché de planes de consulta como lo haría una constante insertada en línea. Eso mantiene baratos los filtros con nombre incluso bajo mucha carga multi-tenant. Si estás auditando el número de consultas mientras añades filtros, contrasta con [cómo detectar consultas N+1 en EF Core 11](/es/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/), ya que un filtro que atraviesa una navegación puede añadir un join que no habías planeado.

Los filtros de consulta con nombre convierten los filtros globales de un instrumento contundente en uno componible. Dos predicados, dos nombres y la capacidad de levantar exactamente uno de ellos para exactamente una consulta es la diferencia entre un interruptor de borrado lógico y una brecha de tenant accidental.

## Relacionado

- [Cómo usar interceptores de EF Core 11 para auditoría](/es/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/)
- [Cómo usar ExecuteUpdate y ExecuteDelete para escrituras masivas en EF Core 11](/es/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/)
- [Fix: FOREIGN KEY constraint failed al borrar una entidad en EF Core 11](/es/2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11/)
- [AsNoTracking vs AsNoTrackingWithIdentityResolution en EF Core 11](/es/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/)
- [Cómo hacer paginación por keyset (cursor) en EF Core 11](/es/2026/06/how-to-do-keyset-cursor-pagination-in-ef-core-11/)

## Fuentes

- [Global Query Filters, documentación de EF Core (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/querying/filters)
- [What's New in EF Core 10 (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew)
- [Named Query Filters in EF 10, Milan Jovanovic](https://www.milanjovanovic.tech/blog/named-query-filters-in-ef-10-multiple-query-filters-per-entity/)
