---
title: "Solución: The entity type 'X' requires a primary key to be defined en EF Core 11"
description: "EF Core no encuentra una clave para tu tipo. Nombra una propiedad Id o {Type}Id, agrega [Key], llama a HasKey o, si es una vista o SQL crudo, llama a HasNoKey."
pubDate: 2026-06-12
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
lang: "es"
translationOf: "2026/06/fix-the-entity-type-requires-a-primary-key-to-be-defined"
translatedBy: "claude"
translationDate: 2026-06-12
---

La solución: EF Core construye tu modelo y encuentra un tipo que cree que es una entidad pero para el que no puede hallar una clave primaria. Tienes tres opciones reales, en orden: dale una clave al tipo (nombra una propiedad `Id` o `{Type}Id`, agrega `[Key]` o llama a `modelBuilder.Entity<T>().HasKey(...)`); indícale a EF Core que el tipo es intencionalmente sin clave con `HasNoKey()` (lo correcto para vistas y resultados de SQL crudo); o evita que EF Core lo trate como entidad eliminando el `DbSet<T>` sobrante o llamando a `modelBuilder.Ignore<T>()`. Elige la que coincida con lo que el tipo realmente es.

```text
System.InvalidOperationException: The entity type 'OrderSummary' requires a primary key to be defined.
If you intended to use a keyless entity type, call 'HasNoKey' in 'OnModelCreating'.
For more information on keyless entity types, see https://go.microsoft.com/fwlink/?linkid=2141943.
   at Microsoft.EntityFrameworkCore.Infrastructure.ModelValidator.ValidateNonNullPrimaryKeys(IModel model)
   at Microsoft.EntityFrameworkCore.Infrastructure.ModelValidator.Validate(IModel model, ...)
   at Microsoft.EntityFrameworkCore.Metadata.Conventions.Infrastructure.ModelRuntimeInitializer.Initialize(...)
```

Este es un error de validación del modelo, no un error de consulta en tiempo de ejecución. Se dispara la primera vez que EF Core construye el modelo: la primera consulta, el primer `SaveChanges`, el primer comando `dotnet ef` o una llamada a `context.Model`. El nombre de tipo entre comillas es el que EF Core no pudo dotar de clave. Esta guía está escrita para .NET 11, C# 14 y `Microsoft.EntityFrameworkCore` 11.0.0. El comportamiento y el texto del mensaje no han cambiado desde EF Core 7, así que todo lo aquí descrito aplica hasta esa versión.

## Qué significa realmente "requires a primary key"

Cuando EF Core construye tu modelo ejecuta un conjunto de convenciones. Una de ellas, `KeyDiscoveryConvention`, intenta elegir una clave primaria para cada tipo de entidad buscando una propiedad llamada, sin distinguir mayúsculas, `Id` o `{EntityTypeName}Id`. Si encuentra exactamente una propiedad así, esa se convierte en la clave. Si no encuentra ninguna, la entidad queda sin clave, y entonces `ModelValidator` se ejecuta y rechaza las entidades sin clave que no fueron marcadas explícitamente como tales. Ese rechazo es la excepción que estás leyendo.

Por lo tanto, el error siempre significa una de dos cosas:

1. EF Core cree que este tipo es una entidad, pero la convención no pudo descubrir una clave y tú no configuraste ninguna.
2. EF Core no debería estar tratando este tipo como una entidad en absoluto, pero algo lo arrastró al modelo.

Toda la solución consiste en averiguar cuál de las dos es cierta. Dos preguntas lo resuelven: ¿este tipo corresponde a una tabla o vista real que leo y escribo, y tiene un identificador único natural? Si la respuesta a ambas es sí, el tipo quiere una clave. Si es una proyección, una fila de reporte o un resultado de SQL crudo, quiere `HasNoKey` o quedar fuera del modelo por completo.

## La reproducción mínima

Un `DbSet` de un tipo cuya propiedad clave no está nombrada de una forma que la convención reconozca.

```csharp
// .NET 11, C# 14, EF Core 11.0.0
public class AppDb : DbContext
{
    public DbSet<OrderSummary> OrderSummaries => Set<OrderSummary>();

    public AppDb(DbContextOptions<AppDb> options) : base(options) { }
}

public class OrderSummary
{
    public Guid Reference { get; set; }   // not "Id", not "OrderSummaryId"
    public decimal Total { get; set; }
}
```

`Reference` es un identificador perfectamente válido, pero la convención no lo sabe. Buscó `Id` o `OrderSummaryId`, no encontró ninguno, dejó el tipo sin clave y la validación falló. El mismo error aparece si mapeas una vista de SQL a una clase, devuelves filas de `FromSql` a un tipo no mapeado o expones por accidente un DTO como `DbSet`.

## Solución 1: dale una clave al tipo

Usa esto cuando el tipo es una entidad real que consultas y persistes. Tres formas, en orden creciente de explicitud.

Renombra la propiedad para que la convención la encuentre:

```csharp
// .NET 11, EF Core 11.0.0 -- convention discovers this automatically
public class OrderSummary
{
    public Guid Id { get; set; }          // discovered by KeyDiscoveryConvention
    public decimal Total { get; set; }
}
```

O conserva tu propio nombre y anótalo:

```csharp
// .NET 11, EF Core 11.0.0
public class OrderSummary
{
    [Key]
    public Guid Reference { get; set; }
    public decimal Total { get; set; }
}
```

O configúralo en `OnModelCreating`, que es el lugar correcto cuando no puedes o no quieres poner atributos en el tipo (por ejemplo, la clase vive en un proyecto de dominio que no debe referenciar EF Core):

```csharp
// .NET 11, EF Core 11.0.0
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<OrderSummary>().HasKey(o => o.Reference);
}
```

Para una clave compuesta, pasa un objeto anónimo. No existe un equivalente con atributo `[Key]` que defina el orden de columnas de forma fiable, así que prefiere la forma fluida:

```csharp
// .NET 11, EF Core 11.0.0 -- composite key, order matters for the index
modelBuilder.Entity<OrderLine>().HasKey(l => new { l.OrderId, l.LineNumber });
```

Una trampa dentro de esta solución: la propiedad clave debe ser una propiedad CLR legible y mapeada. Un **campo** público, una propiedad marcada con `[NotMapped]` o una propiedad de un tipo que EF Core no puede mapear no serán descubiertos, y seguirás recibiendo el error aunque "claramente haya un Id ahí mismo". Conviértela en una propiedad automática de un tipo mapeable (`int`, `long`, `Guid`, `string`, etc.).

## Solución 2: declara el tipo sin clave con HasNoKey

Usa esto cuando el tipo realmente no tiene clave primaria: una vista de base de datos, la forma del resultado de un procedimiento almacenado o una fila de reporte de solo lectura. Los tipos de entidad sin clave son de solo lectura, nunca son rastreados por el rastreador de cambios y no pueden participar en `SaveChanges`.

```csharp
// .NET 11, EF Core 11.0.0 -- a view with no natural key
modelBuilder.Entity<OrderSummary>()
    .HasNoKey()
    .ToView("vw_OrderSummary");
```

La forma con atributo es `[Keyless]` sobre la clase, que equivale a llamar a `HasNoKey()`:

```csharp
// .NET 11, EF Core 11.0.0
[Keyless]
public class OrderSummary
{
    public Guid Reference { get; set; }
    public decimal Total { get; set; }
}
```

Si el tipo sin clave se alimenta de SQL crudo en lugar de una vista, mapéalo a la consulta en lugar de a una tabla:

```csharp
// .NET 11, EF Core 11.0.0
modelBuilder.Entity<OrderSummary>()
    .HasNoKey()
    .ToSqlQuery("SELECT Reference, SUM(Total) AS Total FROM Orders GROUP BY Reference");
```

No recurras a `HasNoKey` solo para hacer desaparecer el error en un tipo que sí tiene identidad. Una entidad sin clave no puede actualizarse ni eliminarse a través del contexto, y EF Core no deduplica filas que comparten los mismos valores, así que puedes obtener silenciosamente duplicados en memoria. `HasNoKey` es una afirmación sobre los datos, no un atajo.

## Solución 3: evita que EF Core mapee el tipo del todo

A menudo el tipo no es una entidad y nunca debió serlo. Fue arrastrado al modelo de una de estas tres formas:

- Agregaste un `DbSet<SomeDto>` para una proyección o un view-model. Elimínalo y proyecta con `Select` hacia el DTO en su lugar.
- Una entidad mapeada tiene una propiedad de navegación que apunta al tipo, así que EF Core lo mapeó de forma transitiva. Si esa navegación no debería ser una relación, márcala con `[NotMapped]`.
- Llamaste a `modelBuilder.Entity<SomeDto>()` en algún lugar (a menudo para configurar una sola propiedad), lo que lo registra como entidad.

Para excluir un tipo de forma explícita, ignóralo:

```csharp
// .NET 11, EF Core 11.0.0
modelBuilder.Ignore<OrderSummary>();
```

O, sobre una propiedad que esté causando el mapeo transitivo:

```csharp
// .NET 11, EF Core 11.0.0
public class Order
{
    public int Id { get; set; }

    [NotMapped]
    public OrderSummary? Computed { get; set; }   // a view model, not a relationship
}
```

Para proyecciones puntuales rara vez necesitas un tipo mapeado siquiera. Proyecta directamente hacia la forma que quieres y EF Core nunca intenta darle clave:

```csharp
// .NET 11, EF Core 11.0.0 -- no DbSet, no HasNoKey, nothing to key
var summaries = await db.Orders
    .GroupBy(o => o.CustomerId)
    .Select(g => new OrderSummary { Reference = g.Key, Total = g.Sum(o => o.Total) })
    .ToListAsync();
```

## Variantes que terminan en este mismo error

### Mapear un record sin Id

Un `record` posicional funciona bien como entidad, pero solo si uno de sus parámetros se convierte en una clave descubrible. `public record OrderSummary(Guid Reference, decimal Total);` cae en este error por la misma razón que la clase: `Reference` no es `Id`. Nombra el primer parámetro `Id`, agrega `[property: Key]` al parámetro posicional o configura `HasKey` en `OnModelCreating`. Los mecanismos de mapear records, incluidas las propiedades init-only y la igualdad por valor, se cubren en la guía sobre [usar records con EF Core 11 correctamente](/2026/04/how-to-use-records-with-ef-core-11-correctly/).

### Tipos de resultado de Database.SqlQuery<T> y FromSql

`db.Database.SqlQuery<OrderSummary>($"...")` mapea `OrderSummary` como un tipo implícito sin clave en el momento de la consulta, y ese camino no necesita ninguna configuración. Pero si además llamas a `modelBuilder.Entity<OrderSummary>()` para el mismo tipo en otro lugar, ya lo has registrado como una entidad normal, y la convención exige una clave. O bien mantén el tipo fuera de `OnModelCreating` por completo (deja que `SqlQuery` lo maneje), o regístralo explícitamente con `HasNoKey()`. Esta es la causa raíz detrás de [dotnet/efcore#35575](https://github.com/dotnet/efcore/issues/35575), donde un tipo de consulta colisionó con una entidad configurada del mismo nombre.

### El error nombra un tipo que no escribiste

Si el tipo entre comillas es un tipo del framework o de una biblioteca, una navegación lo arrastró. Encuentra la entidad que lo referencia y decide: relación real (configura la clave en el tipo referenciado) o no (marca la navegación con `[NotMapped]` o haz `Ignore<T>()` del tipo). Esto suele aparecer con columnas JSON fuertemente tipadas y claves foráneas entre esquemas, como en [dotnet/efcore#36614](https://github.com/dotnet/efcore/issues/36614).

### Solo falla con dotnet ef, no en tiempo de ejecución

`dotnet ef migrations add` y `dotnet ef database update` construyen el modelo completo, así que sacan a la luz errores de modelo que un camino de código en tiempo de ejecución más acotado quizá no haya disparado todavía. El error es real; las herramientas simplemente lo encontraron primero. Si la compilación en tiempo de diseño ni siquiera puede construir tu contexto, verás un mensaje distinto primero; ese se cubre en [por qué dotnet ef migrations add no puede crear tu DbContext](/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/).

### Una clave anulable o eclipsada

Si tu propiedad clave es anulable (`int?`), EF Core la descubrirá pero `ModelValidator` rechaza las claves primarias nulas con un mensaje muy relacionado. Haz la clave no anulable. De igual modo, si una clase base y una clase derivada declaran ambas `Id`, el miembro eclipsado puede confundir el descubrimiento; declara la clave una sola vez en el tipo que EF Core mapea.

## Confirmar la solución

Después de aplicar una de las tres soluciones, fuerza una construcción del modelo sin ejecutar tu aplicación para que el ciclo de retroalimentación sea rápido:

```bash
# .NET 11 SDK, EF Core tools 11.0.0
dotnet ef dbcontext info --startup-project ./Api
```

Si el modelo es válido, esto imprime el proveedor y los detalles del contexto. Si un tipo sigue sin clave y sin marcar, lanza la misma excepción, y el mensaje te dice exactamente qué tipo queda sin resolver. Resuélvelos de uno en uno; un modelo con varios tipos de vista o DTO puede lanzar una vez por tipo hasta que cada uno esté tratado.

El modelo mental que vale la pena conservar: este error es EF Core pidiéndote que clasifiques un tipo. Entidad con identidad, forma de solo lectura sin clave, o no-una-entidad. Una vez que respondes eso, la solución es mecánica. Cuando conectas estos tipos en tus pruebas y quieres que el rastreo de cambios se comporte, los patrones de [simular DbContext sin romper el rastreo de cambios](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) y [precalentar el modelo de EF Core antes de la primera consulta](/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/) combinan bien con tener tus claves correctas.

## Fuentes

- [Keyless entity types](https://learn.microsoft.com/en-us/ef/core/modeling/keyless-entity-types), documentación de EF Core, sobre `HasNoKey`, `[Keyless]` y las restricciones de solo lectura.
- [Keys](https://learn.microsoft.com/en-us/ef/core/modeling/keys), documentación de EF Core, sobre el descubrimiento por convención, `[Key]` y las claves compuestas.
- [Model validation and conventions](https://learn.microsoft.com/en-us/ef/core/modeling/), documentación de EF Core.
- [dotnet/efcore#29198](https://github.com/dotnet/efcore/issues/29198) y [dotnet/efcore#35575](https://github.com/dotnet/efcore/issues/35575), los issues canónicos detrás de este mensaje.
