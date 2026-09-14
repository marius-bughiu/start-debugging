---
title: "Solución: InvalidOperationException: Nullable object must have a value en una proyección de EF Core 11"
description: "EF Core lanza esta excepción cuando un Select lee un NULL de SQL en un int, decimal o DateTime no anulable. Convierte el miembro a su tipo anulable y agrega ?? default, o protege la navegación con una comprobación de null."
pubDate: 2026-09-14
template: error-page
tags:
  - "errors"
  - "efcore"
  - "dotnet"
  - "linq"
lang: "es"
translationOf: "2026/09/fix-nullable-object-must-have-a-value-in-an-ef-core-11-projection"
translatedBy: "claude"
translationDate: 2026-09-14
---

EF Core lanza `InvalidOperationException: Nullable object must have a value` cuando el SQL que generó para tu `Select` devuelve `NULL` en una columna que tu proyección asigna a un tipo de valor no anulable (`int`, `decimal`, `DateTime`, `Guid`, un struct). Los culpables habituales son una navegación opcional (`o.Customer.Rating` en un pedido sin cliente), `Max`/`Min`/`Average` sobre una colección vacía y un DTO completo tomado del lado vacío de un join con `DefaultIfEmpty`. La solución es hacer visible la anulabilidad en el LINQ: convierte al tipo anulable (`(int?)o.Customer.Rating`) y proporciona un valor por defecto con `?? 0`, o escribe `o.Customer == null ? 0 : o.Customer.Rating`. Todos los resultados de abajo se midieron en `Microsoft.EntityFrameworkCore` 11.0.0-rc.1.26425.128 sobre .NET 11 RC 1 y se compararon con EF Core 10.0.12. Un caso es nuevo en EF Core 11: proyectar una colección compleja JSON junto con una navegación de colección. Esa es una regresión real y tiene su propia sección.

## El error en contexto

En el caso de runtime, la excepción viene del shaper compilado, no de tu código ni del controlador de la base de datos. Eso hace que la traza de pila parezca inútil:

```
System.InvalidOperationException: Nullable object must have a value.
   at lambda_method272(Closure, QueryContext, DbDataReader, ResultContext, SingleQueryResultCoordinator)
   at Microsoft.EntityFrameworkCore.Query.Internal.SingleQueryingEnumerable`1.Enumerator.MoveNext()
   at System.Collections.Generic.List`1..ctor(IEnumerable`1 collection)
```

`lambda_method` es el materializador que EF Core compiló para tu proyección. Lee cada columna como un valor anulable y luego llama a `.Value` para ponerlo en tu miembro no anulable. Cuando la columna es `NULL`, `Nullable<T>.Value` lanza la excepción, y obtienes el mismo mensaje que verías con `((int?)null).Value` en C# puro. La consulta se tradujo bien y el SQL se ejecutó bien. Lo que falló es la conversión de fila a objeto.

Si los frames superiores son ``System.Nullable`1.get_Value()`` y `SelectExpression.ClientProjectionRemappingExpressionVisitor.VisitExtension`, la consulta falló en tiempo de compilación, antes de ejecutar cualquier SQL. Incluso `ToQueryString()` lanza la excepción. Esa es la regresión de EF Core 11 que se trata más abajo, en la sección de la colección compleja JSON.

## Por qué ocurre

LINQ-to-Objects y SQL no coinciden en lo que significa "faltante". En C#, `order.Customer.Rating` sobre un `Customer` nulo lanza una `NullReferenceException`, y `new List<decimal>().Max()` lanza `Sequence contains no elements`. En SQL, un `LEFT JOIN` sin coincidencia produce columnas `NULL`, y `MAX` sobre cero filas devuelve `NULL`. EF Core traduce a la semántica de SQL, así que no se dispara ninguna excepción en la base de datos. Luego el `NULL` vuelve a un miembro del CLR que no puede contenerlo.

EF Core ya compensa en varios lugares. `Sum` se envuelve en `COALESCE(..., 0)`, un `FirstOrDefault()` escalar dentro de una subconsulta se envuelve en `ISNULL`, y la materialización de entidades revisa las columnas clave antes de construir un objeto. El error aparece en los huecos que no cubre. Esos huecos son los mismos en EF Core 10 y 11, salvo por una corrección y una regresión.

## Reproducción mínima

El modelo tiene pedidos con un cliente opcional, y un cliente ("Bob") sin ningún pedido:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128 (same model on EF Core 10.0.12)
public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public int Rating { get; set; }
    public List<Order> Orders { get; set; } = [];
}

public class Order
{
    public int Id { get; set; }
    public decimal Total { get; set; }
    public int? CustomerId { get; set; }     // optional relationship
    public Customer? Customer { get; set; }
}

// seed: Ana (Rating 5) with one order, Bob with none, plus one guest order with CustomerId = null
var rows = db.Orders
    .Select(o => new { o.Id, Rating = o.Customer!.Rating })
    .ToList(); // InvalidOperationException: Nullable object must have a value.
```

El `!` silencia la advertencia de anulabilidad. No hace nada en runtime. EF Core genera un `LEFT JOIN` simple:

```sql
-- EF Core 11 RC 1, SQL Server provider, via ToQueryString()
SELECT [o].[Id], [c].[Rating]
FROM [Orders] AS [o]
LEFT JOIN [Customers] AS [c] ON [o].[CustomerId] = [c].[Id]
```

La fila del pedido de invitado tiene `NULL` en `[c].[Rating]`, y el `int Rating` del tipo anónimo no puede recibirlo. Un DTO con nombre (`new OrderDto { Rating = o.Customer!.Rating }`) y un escalar suelto (`Select(o => o.Customer!.Rating)`) fallan de la misma manera.

## Soluciones, en orden de preferencia

### 1. Convierte al tipo anulable y elige un valor por defecto

Es la solución más común y la que produce el SQL más barato:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var rows = db.Orders
    .Select(o => new { o.Id, Rating = (int?)o.Customer!.Rating ?? 0 })
    .ToList(); // { Id = 1, Rating = 0 } | { Id = 2, Rating = 5 }
```

```sql
SELECT [o].[Id], ISNULL([c].[Rating], 0)
FROM [Orders] AS [o]
LEFT JOIN [Customers] AS [c] ON [o].[CustomerId] = [c].[Id]
```

Si "sin cliente" y "calificación 0" significan cosas distintas para quien llama, quita el `?? 0` y haz que el miembro del DTO sea `int?`. Así conservas la diferencia, lo que suele ser más honesto que inventar un cero.

### 2. Protege la navegación de forma explícita

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var rows = db.Orders
    .Select(o => new { o.Id, Rating = o.Customer == null ? 0 : o.Customer.Rating })
    .ToList();
```

EF Core convierte la comprobación de null en una prueba sobre la clave unida, que es la señal correcta de "¿coincidió el join?" incluso cuando el propio miembro es una columna anulable:

```sql
SELECT [o].[Id], CASE
    WHEN [c].[Id] IS NULL THEN 0
    ELSE [c].[Rating]
END
FROM [Orders] AS [o]
LEFT JOIN [Customers] AS [c] ON [o].[CustomerId] = [c].[Id]
```

Usa esta forma cuando proyectes varios miembros de la misma navegación opcional, o cuando el miembro sea un string u otro tipo de referencia y quieras una propiedad del DTO que no sea null.

### 3. Agregados sobre colecciones posiblemente vacías

`Sum` es seguro. `Max`, `Min` y `Average` no lo son. Tanto en EF Core 11 RC 1 como en 10.0.12:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
db.Customers.Select(c => new { c.Name, Biggest = c.Orders.Max(o => o.Total) });      // throws for Bob
db.Customers.Select(c => new { c.Name, Avg = c.Orders.Average(o => o.Total) });      // throws for Bob
db.Customers.Select(c => new { c.Name, Sum = c.Orders.Sum(o => o.Total) });          // Bob = 0.0
db.Customers.Select(c => new { c.Name, Last = c.Orders.OrderBy(o => o.Id)
                                                .Select(o => o.Total).FirstOrDefault() }); // Bob = 0.0
```

El SQL generado muestra por qué. `Sum` recibe `COALESCE(SUM([o].[Total]), 0.0)`, y la subconsulta de `FirstOrDefault` recibe `ISNULL((SELECT TOP(1) ...), 0.0)`. `MAX` y `AVG` pasan sin envolver. La solución es la misma conversión, hecha dentro del selector del agregado:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var rows = db.Customers.Select(c => new
{
    c.Name,
    Biggest  = c.Orders.Max(o => (decimal?)o.Total) ?? 0m,
    Smallest = c.Orders.Min(o => (decimal?)o.Total) ?? 0m,
    Avg      = c.Orders.Average(o => (decimal?)o.Total) ?? 0m,
}).ToList(); // Bob: 0, 0, 0
```

`c.Orders.Select(o => o.Total).DefaultIfEmpty().Max()` también funciona, pero se compila a un `LEFT JOIN` contra una tabla derivada `SELECT 1 AS empty` de una sola fila. La conversión a anulable produce un SQL más simple para la misma respuesta.

### 4. Joins con `DefaultIfEmpty` que proyectan un DTO

Esta es la forma de [dotnet/efcore#30915](https://github.com/dotnet/efcore/issues/30915): un left join manual donde el lado interno es un DTO proyectado en lugar de una entidad.

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var rows =
    (from o in db.Orders
     join c in db.Customers.Select(c => new CustomerDto { Id = c.Id, Rating = c.Rating })
         on o.CustomerId equals c.Id into cs
     from c in cs.DefaultIfEmpty()
     select new { o.Id, Customer = c })
    .ToList(); // throws on EF Core 11 RC 1 and 10.0.12
```

LINQ-to-Objects te daría `Customer = null` para el pedido de invitado. EF Core, en cambio, intenta construir un `CustomerDto` a partir de columnas todas `NULL`. Haz el join con la entidad y construye el DTO después del join, detrás de una comprobación de null:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var rows =
    (from o in db.Orders
     join c in db.Customers on o.CustomerId equals c.Id into cs
     from c in cs.DefaultIfEmpty()
     select new
     {
         o.Id,
         Customer = c == null ? null : new CustomerDto { Id = c.Id, Rating = c.Rating }
     })
    .ToList(); // { Id = 1, Customer = null } | { Id = 2, Customer = CustomerDto 1 Rating=5 }
```

Con una entidad en el lado interno, EF Core puede revisar la columna clave para decidir si la fila coincidió. Con un DTO proyectado simple no tiene nada que revisar. El equipo de EF da seguimiento a esa variante exacta en [dotnet/efcore#38608](https://github.com/dotnet/efcore/issues/38608), que sigue abierto, y dice que corregirlo requiere rehacer la expansión de navegaciones.

## Lo que EF Core 11 ya corrigió: `LeftJoin` contra un `GroupBy`

Una familia sí mejoró en EF Core 11. Un `LeftJoin` (el operador agregado en .NET 10, consulta [los operadores de join de LINQ en .NET 10 y 11](/es/2026/06/linq-fulljoin-tuple-returning-joins-dotnet-11-preview-5/)) contra un agregado agrupado, reportado como [dotnet/efcore#38055](https://github.com/dotnet/efcore/issues/38055):

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var counts = db.Orders.GroupBy(o => o.CustomerId, (k, g) => new { CustomerId = k, Count = g.Count() });

var rows = db.Customers
    .LeftJoin(counts, c => (int?)c.Id, g => g.CustomerId, (c, g) => new { c, g })
    .Select(x => new { x.c.Name, Count = x.g == null ? 0 : x.g.Count })
    .ToList();
// EF Core 10.0.12: InvalidOperationException: Nullable object must have a value.
// EF Core 11 RC 1: { Name = Ana, Count = 1 } | { Name = Bob, Count = 0 }
```

EF Core 11 ahora pone una columna sintética en la subconsulta interna y condiciona el objeto a ella:

```sql
SELECT [c].[Name], [o0].[CustomerId], [o0].[Count], [o0].[marker]
FROM [Customers] AS [c]
LEFT JOIN (
    SELECT [o].[CustomerId], COUNT(*) AS [Count], 1 AS [marker]
    FROM [Orders] AS [o]
    GROUP BY [o].[CustomerId]
) AS [o0] ON [c].[Id] = [o0].[CustomerId]
```

`[marker]` es `NULL` solo cuando el join no encontró coincidencia, así que `x.g == null` por fin significa lo que dice. Esto llegó en [dotnet/efcore#38479](https://github.com/dotnet/efcore/pull/38479) (fusionado en junio de 2026), con seguimientos para proyecciones de tipos de valor ([#38555](https://github.com/dotnet/efcore/pull/38555)) y joins posteriores ([#38499](https://github.com/dotnet/efcore/pull/38499)). Ninguno se portó a 10.0.x. En EF Core 10, convierte dentro de la agrupación (`Count = (int?)g.Count()`) y lee `x.g!.Count ?? 0`, lo que funciona en ambas versiones y produce `ISNULL([o0].[Count], 0)`.

## Regresión de EF Core 11 RC 1: colección compleja JSON más una navegación de colección

Este no es para nada un problema de datos. Proyectar una colección compleja mapeada a JSON (`ComplexCollection(...).ToJson()`, consulta [cómo mapear columnas JSON en EF Core 11](/es/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/)) junto con una navegación de colección en el mismo `Select` lanza la excepción mientras se compila la consulta:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
modelBuilder.Entity<Parent>(e =>
{
    e.ComplexCollection(p => p.Items).ToJson();
    e.HasMany(p => p.Links).WithMany(l => l.Parents);
});

var dtos = db.Parents
    .Select(p => new ParentDto
    {
        Name = p.Name,
        Items = p.Items,                                  // JSON complex collection
        Links = p.Links.Select(l => l.Name).ToList(),     // collection navigation
    })
    .ToList();
// EF Core 10.0.12: works
// EF Core 11 RC 1: InvalidOperationException: Nullable object must have a value.
//   at System.Nullable`1.get_Value()
//   at ...SelectExpression.ClientProjectionRemappingExpressionVisitor.VisitExtension(Expression expression)
```

Cada mitad funciona por sí sola. `AsSplitQuery()` no ayuda, porque el fallo ocurre antes de que EF Core decida cómo dividir. Es [dotnet/efcore#38928](https://github.com/dotnet/efcore/issues/38928), etiquetado como regresión desde 11.0.0-preview.1. La corrección, [dotnet/efcore#38932](https://github.com/dotnet/efcore/pull/38932), se fusionó en `main` el 2026-09-09. El backport a `release/11.0`, [#38948](https://github.com/dotnet/efcore/pull/38948), seguía abierto el 2026-09-14, así que RC 1 tiene el bug y la corrección debería llegar en un RC posterior o en GA. Mientras tanto, carga la entidad con `Include` y mapea en memoria:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var dtos = (await db.Parents.Include(p => p.Links).AsNoTracking().ToListAsync())
    .Select(p => new ParentDto { Name = p.Name, Items = p.Items, Links = p.Links.Select(l => l.Name).ToList() })
    .ToList();
```

o ejecuta dos proyecciones (una para la columna JSON y otra para la navegación) y únelas por clave. Ambas opciones funcionan en RC 1. La versión con `Include` carga todas las columnas de `Link`, así que para tablas anchas usa la versión de dos consultas.

## Errores parecidos que terminan aquí

- **`The data is NULL at ordinal 1. This method can't be called on NULL values`** (SQLite) o **`SqlNullValueException: Data is Null`** (SQL Server): una columna que es anulable en la base de datos pero está mapeada a una propiedad no anulable, algo típico en modelos database-first y vistas. El proveedor lanza la excepción al leer la columna, antes de que el shaper de EF Core la vea. Medido solo en SQLite. La solución está en el modelo: haz que la propiedad sea `int?`, o corrige la columna. Ni `(int?)p.Stock` ni `(int?)p.Stock ?? -1` en la proyección ayudan (ambos siguen lanzando la excepción en EF Core 11 RC 1), porque EF Core confía en el modelo y lee la columna con `GetInt32`.
- **`Sequence contains no elements`**: la versión de LINQ-to-Objects del mismo problema del conjunto vacío, o un `First()`/`Single()` que se ejecutó en memoria. Consulta [el artículo dedicado](/es/2026/07/fix-invalidoperationexception-sequence-contains-no-elements/).
- **`An exception was thrown while attempting to evaluate a LINQ query parameter expression`** envolviendo `Nullable object must have a value`: es tu propio `maybe!.Value` evaluándose del lado del cliente como parámetro, antes de cualquier SQL. Se trata en [el artículo sobre la evaluación de parámetros](/es/2026/08/fix-an-exception-was-thrown-while-attempting-to-evaluate-a-linq-query-parameter-expression/).

## Cómo encontrar rápido la columna problemática

La traza de pila del shaper nunca nombra el miembro. Dos formas rápidas de encontrarlo:

1. Llama a `query.ToQueryString()` y busca una columna del lado anulable de un `LEFT JOIN`, `OUTER APPLY`, o una subconsulta con `MAX`/`MIN`/`AVG` sin envolver. [Registrar el SQL que genera EF Core 11](/es/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) cubre las demás opciones.
2. Cambia temporalmente la proyección a `(int?)` / `(decimal?)` en cada miembro de tipo de valor, ejecútala y mira cuál vuelve como `null`. Ese es el miembro que debes corregir.

Si el propio `ToQueryString()` lanza la excepción, el problema está en tiempo de compilación. En EF Core 11 RC 1, revisa si tienes la forma JSON más navegación de arriba. Si lo que falla es la traducción y no la materialización, normalmente verás un mensaje distinto, que se cubre en [la guía de "could not be translated"](/es/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/).

Una nota sobre el método: cada conteo de filas y cada excepción de arriba salieron de ejecutar las consultas contra SQLite en memoria, en ambas versiones de EF Core. El SQL de SQL Server se generó con `ToQueryString()`, no se ejecutó. El materializador que lanza la excepción es independiente del proveedor, así que las mismas proyecciones fallan de forma idéntica en SQL Server, pero no ejecuté una instancia de SQL Server para este artículo.

## Fuentes

- [dotnet/efcore#38928](https://github.com/dotnet/efcore/issues/38928): regresión de colección compleja JSON más navegación de colección; corrección [#38932](https://github.com/dotnet/efcore/pull/38932), backport [#38948](https://github.com/dotnet/efcore/pull/38948).
- [dotnet/efcore#30915](https://github.com/dotnet/efcore/issues/30915) y [#38055](https://github.com/dotnet/efcore/issues/38055): proyecciones que no son entidades en left joins; corrección parcial en [#38479](https://github.com/dotnet/efcore/pull/38479).
- [dotnet/efcore#38608](https://github.com/dotnet/efcore/issues/38608): la variante de `DefaultIfEmpty` con un DTO proyectado simple que sigue abierta.
- [dotnet/efcore#33802](https://github.com/dotnet/efcore/issues/33802): comportamiento inconsistente de los agregados sobre colecciones vacías.
- [dotnet/efcore#35950](https://github.com/dotnet/efcore/issues/35950): la regresión de `COALESCE` con `DefaultIfEmpty` en EF Core 9, corregida en EF Core 10.
- [Operadores de consulta complejos en EF Core](https://learn.microsoft.com/ef/core/querying/complex-query-operators) en Microsoft Learn.
