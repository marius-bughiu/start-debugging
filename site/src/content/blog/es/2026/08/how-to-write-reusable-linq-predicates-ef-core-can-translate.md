---
title: "Cómo escribir predicados LINQ reutilizables que EF Core pueda traducir en Where, Select y OrderBy"
description: "Un método auxiliar que devuelve bool lanza \"could not be translated\". Un Expression<Func<T, bool>> no. Así se componen, anidan y reutilizan árboles de expresión en EF Core 11 sin LINQKit, con el SQL real de cada caso."
pubDate: 2026-08-23
tags:
  - "ef-core"
  - "linq"
  - "csharp"
  - "dotnet"
lang: "es"
translationOf: "2026/08/how-to-write-reusable-linq-predicates-ef-core-can-translate"
translatedBy: "claude"
translationDate: 2026-08-23
---

La regla es corta: EF Core solo puede traducir aquello que sigue siendo un árbol de expresión cuando llega al proveedor. Un método auxiliar `static bool IsActive(Customer c)` se compila como un nodo de llamada a método y lanza en tiempo de ejecución; la misma lógica guardada como `static readonly Expression<Func<Customer, bool>> IsActive` se traduce sin problemas y puede componerse, anidarse y reasignarse a otros tipos de entidad. Lo que la mayoría de las guías dice mal es que necesitas `AsExpandable()` de LINQKit para componer esos árboles. No lo necesitas: `Expression.Invoke` se traduce desde EF Core 3.1, y cada fragmento de SQL de abajo salió de EF Core 11.0.0-preview.7.26381.103 con el proveedor de SQL Server mediante `ToQueryString()`.

## Por qué el método auxiliar bool lanza y la expresión no

Empieza por la forma que casi todo el mundo escribe primero, porque se lee bien:

```csharp
// EF Core 11.0.0-preview.7, C# 14
static bool IsActiveMethod(Customer c) => !c.IsDeleted && c.Orders.Count > 0;

db.Customers.Where(c => IsActiveMethod(c));
```

El compilador de C# convierte esa lambda en un árbol de expresión cuyo cuerpo es un `MethodCallExpression` que apunta a `IsActiveMethod`. EF Core no tiene forma de mirar dentro del cuerpo de un método compilado, así que la traducción se detiene:

```
System.InvalidOperationException
The LINQ expression 'DbSet<Customer>()
    .Where(c => Helpers.IsActiveMethod(c))' could not be translated. Either rewrite
the query in a form that can be translated, or switch to client evaluation explicitly
by inserting a call to 'AsEnumerable', 'AsAsyncEnumerable', 'ToList', or 'ToListAsync'.
```

Ese es el comportamiento documentado: EF Core admite evaluación parcial en el cliente solo en la proyección de nivel superior, y lanza para cualquier cosa no traducible en el resto de la consulta, según la [guía de evaluación en cliente frente a servidor](https://learn.microsoft.com/en-us/ef/core/querying/client-eval). Si ya te topaste con esto en otras formas, la lista completa de diagnóstico está en [el artículo sobre "The LINQ expression could not be translated"](/es/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/).

Guarda la misma lógica como expresión y nada cambia en el sitio de llamada:

```csharp
static readonly Expression<Func<Customer, bool>> IsActive =
    c => !c.IsDeleted && c.Orders.Count > 0;

db.Customers.Where(IsActive);
```

```sql
SELECT [c].[Id], [c].[Country], [c].[IsDeleted], [c].[Name]
FROM [Customers] AS [c]
WHERE [c].[IsDeleted] = CAST(0 AS bit) AND EXISTS (
    SELECT 1
    FROM [Orders] AS [o]
    WHERE [c].[Id] = [o].[CustomerId])
```

`Queryable.Where` recibe `Expression<Func<T, bool>>`, así que pasar el campo directamente le entrega a EF el árbol completo. Lo mismo vale cuando el predicado llega como parámetro de un método, que es la base de toda abstracción tipo specification:

```csharp
static IQueryable<Customer> Filter(IQueryable<Customer> q, Expression<Func<Customer, bool>> p)
    => q.Where(p);
```

Eso produjo el mismo SQL en la prueba. En el momento en que el predicado pasa a ser un `Func<>` en vez de un `Expression<Func<>>`, vuelves a la excepción.

## Componer predicados: Expression.Invoke se traduce en EF Core 11

El caso interesante es combinar dos predicados escritos de forma independiente. El intento obvio falla:

```csharp
db.Customers.Where(c => IsActive.Compile()(c) && c.Country == "NL");
```

```
The LINQ expression 'DbSet<Customer>()
    .Where(c => Invoke(Func<Customer, bool>, c) && c.Country == "NL")'
could not be translated.
```

`Compile()` se ejecuta al construir la consulta y deja una constante `Func<Customer, bool>` dentro del árbol. EF ve un delegado opaco y se rinde. Este es el fallo que empuja a la gente hacia LINQKit.

Pero construir la invocación como nodo de expresión, en vez de como llamada a delegado, funciona hoy:

```csharp
static Expression<Func<T, bool>> And<T>(
    Expression<Func<T, bool>> a, Expression<Func<T, bool>> b)
{
    var p = Expression.Parameter(typeof(T), "x");
    return Expression.Lambda<Func<T, bool>>(
        Expression.AndAlso(Expression.Invoke(a, p), Expression.Invoke(b, p)), p);
}

static Expression<Func<Customer, bool>> InCountry(string country) => c => c.Country == country;

db.Customers.Where(And(IsActive, InCountry("NL")));
```

```sql
DECLARE @c nvarchar(4000) = N'NL';

SELECT [c].[Id], [c].[Country], [c].[IsDeleted], [c].[Name]
FROM [Customers] AS [c]
WHERE [c].[IsDeleted] = CAST(0 AS bit) AND EXISTS (
    SELECT 1
    FROM [Orders] AS [o]
    WHERE [c].[Id] = [o].[CustomerId]) AND [c].[Country] = @c
```

Sin `AsExpandable()`, sin paquete extra. La canalización de consultas de EF Core reduce los nodos `InvocationExpression` antes de traducir. La regresión que rompió esto en EF Core 3.0 se registró como [dotnet/efcore#17791](https://github.com/dotnet/efcore/issues/17791) y se corrigió para 3.1, pero mucho del consejo que circula en la web es anterior a esa corrección.

Dos detalles que conviene saber sobre ese ayudante `And`. Primero, una semilla `true` o `false`, eso de lo que parte `PredicateBuilder`, no cuesta nada: `And<Customer>(c => true, InCountry("NL"))` y `Or<Customer>(c => false, InCountry("NL"))` emitieron exactamente el `WHERE [c].[Country] = @c` de arriba, sin residuo `1 = 1`. El simplificador de expresiones de EF pliega la constante, así que puedes escribir el bucle acumulador de forma ingenua.

Segundo, `Expression.Invoke` no es tu única opción. Reasignar los parámetros con un `ExpressionVisitor` produce un árbol más plano:

```csharp
sealed class Rebind(ParameterExpression from, Expression to) : ExpressionVisitor
{
    protected override Expression VisitParameter(ParameterExpression node)
        => node == from ? to : base.VisitParameter(node);
}

public static Expression<Func<T, bool>> And<T>(
    this Expression<Func<T, bool>> a, Expression<Func<T, bool>> b)
{
    var p = a.Parameters[0];
    var right = new Rebind(b.Parameters[0], p).Visit(b.Body)!;
    return Expression.Lambda<Func<T, bool>>(Expression.AndAlso(a.Body, right), p);
}
```

Ambas versiones generaron SQL idéntico byte a byte en la prueba. Prefiere el visitor cuando quieras inspeccionar o seguir transformando el árbol combinado tú mismo, porque no hay una capa de invocación en medio. Prefiere `Expression.Invoke` cuando quieras doce líneas menos.

## Reasignar un predicado a otro tipo de entidad

El visitor se paga solo en cuanto quieres aplicar un predicado de `Customer` a una consulta de `Order`. Aquí no estás componiendo dos predicados sobre el mismo parámetro, estás sustituyendo el parámetro por una ruta de miembros:

```csharp
public static Expression<Func<TOuter, bool>> On<TOuter, TInner>(
    this Expression<Func<TInner, bool>> inner,
    Expression<Func<TOuter, TInner>> path)
{
    var body = new Rebind(inner.Parameters[0], path.Body).Visit(inner.Body)!;
    return Expression.Lambda<Func<TOuter, bool>>(body, path.Parameters[0]);
}

db.Orders.Where(IsActive.On((Order o) => o.Customer));
```

```sql
SELECT [o].[Id], [o].[CustomerId], [o].[Total]
FROM [Orders] AS [o]
INNER JOIN [Customers] AS [c] ON [o].[CustomerId] = [c].[Id]
WHERE [c].[IsDeleted] = CAST(0 AS bit) AND EXISTS (
    SELECT 1
    FROM [Orders] AS [o0]
    WHERE [c].[Id] = [o0].[CustomerId])
```

Una sola definición de "cliente activo", aplicada desde ambas direcciones, con el join escrito por ti. Si la regla se parece más a un filtro permanente que a un bloque reutilizable, evalúa si pertenece a [un filtro de consulta con nombre](/es/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/), para que quien llame no pueda olvidarlo.

## Proyecciones reutilizables en Select

Las proyecciones siguen la misma regla, con un modo de fallo adicional. Pasar la expresión directamente a `Select` funciona:

```csharp
static readonly Expression<Func<Customer, CustomerDto>> ToDto =
    c => new CustomerDto(c.Id, c.Name, c.Orders.Count);

db.Customers.Select(ToDto);
```

```sql
SELECT [c].[Id], [c].[Name], (
    SELECT COUNT(*)
    FROM [Orders] AS [o]
    WHERE [c].[Id] = [o].[CustomerId])
FROM [Customers] AS [c]
```

Anidarla dentro de una proyección mayor con `Compile()` no funciona, y la excepción es distinta a la de `Where` porque las proyecciones sí permiten evaluación parcial en el cliente:

```csharp
db.Orders.Select(o => new { o.Id, Cust = ToDto.Compile()(o.Customer) });
```

```
System.InvalidOperationException
The client projection contains a reference to a constant expression of
'System.Func<Customer, CustomerDto>'. This could potentially cause a memory leak;
consider assigning this constant to a local variable and using the variable in the
query instead.
```

Eso es EF diciéndote que el plan de consulta compilado capturaría tu delegado para siempre. Construye el anidamiento como nodo de expresión y se traduce:

```csharp
var p = Expression.Parameter(typeof(Order), "o");
var ctor = typeof(OrderDto).GetConstructor([typeof(int), typeof(CustomerDto)])!;
var body = Expression.New(ctor,
    Expression.Property(p, nameof(Order.Id)),
    Expression.Invoke(ToDto, Expression.Property(p, nameof(Order.Customer))));

db.Orders.Select(Expression.Lambda<Func<Order, OrderDto>>(body, p));
```

```sql
SELECT [o].[Id], [c].[Id], [c].[Name], (
    SELECT COUNT(*)
    FROM [Orders] AS [o0]
    WHERE [c].[Id] = [o0].[CustomerId])
FROM [Orders] AS [o]
INNER JOIN [Customers] AS [c] ON [o].[CustomerId] = [c].[Id]
```

El idioma `Expression.Invoke(ToDto, memberPath)` es todo el truco: aplica una lambda reutilizable a una subexpresión en lugar de al parámetro raíz.

## Aplicar un predicado reutilizable dentro de una navegación con AsQueryable()

`ICollection<T>.Any(Func<T, bool>)` es la sobrecarga de `IEnumerable`, así que pasar una expresión guardada a una propiedad de navegación no compila, y pasar un método bool sí compila pero no se traduce:

```csharp
db.Customers.Where(c => c.Orders.Any(o => IsBigOrderMethod(o)));
// InvalidOperationException: ... .Any(o => Helpers.IsBigOrderMethod(o))' could not be translated
```

Inserta `AsQueryable()` y obtienes la sobrecarga de `Queryable`, que recibe una expresión:

```csharp
static readonly Expression<Func<Order, bool>> IsBigOrder = o => o.Total > 1000m;

db.Customers.Where(c => c.Orders.AsQueryable().Any(IsBigOrder));
```

```sql
SELECT [c].[Id], [c].[Country], [c].[IsDeleted], [c].[Name]
FROM [Customers] AS [c]
WHERE EXISTS (
    SELECT 1
    FROM [Orders] AS [o]
    WHERE [c].[Id] = [o].[CustomerId] AND [o].[Total] > 1000.0)
```

`AsQueryable()` sobre una navegación es gratis dentro de un árbol de consulta: EF lo elimina durante la traducción. El mismo truco vale para `All`, `Count` y `Select` sobre la colección. `All(IsBigOrder)` se tradujo a `NOT EXISTS (... AND [o].[Total] <= 1000.0)`, `Count(IsBigOrder)` a un `COUNT(*)` correlacionado con filtro, y `Select(OrderDtoExpr).ToList()` a un `LEFT JOIN` con un `ORDER BY [c].[Id]` para el shaper de la colección.

## Claves de ordenamiento como parámetros, incluido el caso del boxing

Ordenar es donde reutilizar suele significar "la columna viene de un query string". `Queryable.OrderBy` es genérico sobre el tipo de la clave, así que un ayudante de paso mantiene la clave fuertemente tipada:

```csharp
public static IOrderedQueryable<T> OrderByKey<T, TKey>(
    this IQueryable<T> q, Expression<Func<T, TKey>> key) => q.OrderBy(key);

static readonly Dictionary<string, Expression<Func<Customer, string>>> SortKeys = new()
{
    ["name"] = c => c.Name,
    ["country"] = c => c.Country,
};

db.Customers.OrderByKey(SortKeys["name"]);   // ORDER BY [c].[Name]
```

Si las columnas tienen tipos CLR distintos te va a tentar `Expression<Func<T, object>>`, que fuerza un nodo `Convert(c.Id, Object)` para los tipos por valor. EF Core 11 sí lo maneja:

```csharp
Expression<Func<Customer, object>> key = c => c.Id;
db.Customers.OrderBy(key);   // ORDER BY [c].[Id]
```

La conversión de boxing se elimina durante la traducción. Aun así conviene evitarla, porque las claves `object` aceptan en silencio cosas que no se van a traducir y pierdes la verificación en tiempo de compilación sobre el tipo de la clave. Un `Dictionary<string, Expression<Func<T, TKey>>>` por tipo de clave, o un switch pequeño que llame a `OrderByKey` con el argumento genérico correcto, hace imposible el error. Si el ordenamiento alimenta un endpoint paginado, ten en cuenta que un orden estable es requisito indispensable para [la paginación por keyset](/es/2026/06/how-to-do-keyset-cursor-pagination-in-ef-core-11/).

## La trampa de Expression.Constant que inserta tus parámetros en línea

Este es el bug que solo aparece en producción, y solo en la caché de planes de consulta. Cuando escribes una fábrica como lambda, el argumento capturado se convierte en un campo de closure y EF lo parametriza:

```csharp
static Expression<Func<Customer, bool>> InCountry(string c) => x => x.Country == c;
// WHERE [c].[Country] = @c   with DECLARE @c nvarchar(4000) = N'NL';
```

Cuando construyes el mismo árbol a mano, lo natural es escribir `Expression.Constant(c)`, y EF emite fielmente un literal:

```csharp
var body = Expression.Equal(
    Expression.Property(p, nameof(Customer.Country)),
    Expression.Constant(c));       // <- inlined, not parameterized
// WHERE [c].[Country] = N'NL'
```

Ahora cada país distinto produce una cadena SQL distinta, una entrada distinta en la caché de consultas de EF y un plan distinto en SQL Server. En un constructor de filtros dinámico eso es una inundación de la caché de planes. Dos soluciones, ambas verificadas contra EF Core 11:

```csharp
// 1. EF.Parameter<T>, added in EF Core 9, forces parameterization of a constant
var efParameter = typeof(EF).GetMethod(nameof(EF.Parameter))!.MakeGenericMethod(typeof(string));
var value = Expression.Call(efParameter, Expression.Constant(c));
// WHERE [c].[Country] = @p

// 2. read the value through a field on a captured object, exactly like a compiler closure
sealed class Box { public string? Value; }
var value = Expression.Field(Expression.Constant(new Box { Value = c }), nameof(Box.Value));
// WHERE [c].[Country] = @Value
```

`EF.Constant<T>` (EF Core 8.0.2) hace lo contrario cuando de verdad quieres el literal, por ejemplo para que el optimizador vea un valor selectivo. El par está documentado en [las novedades de EF Core 9](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/whatsnew). Cuando no tengas claro de qué lado caíste, la comprobación más rápida es [registrar el SQL que genera EF Core](/es/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) y buscar `DECLARE @`.

## Compile() va fuera de la consulta, y es caro

El único uso legítimo de `Compile()` es ejecutar el mismo predicado contra objetos en memoria, por ejemplo para validar un cambio antes de guardarlo. Compilar no es barato. En un bucle `Stopwatch` con calentamiento sobre .NET 11.0.100-preview.7 (mediciones de bucle aproximadas, no BenchmarkDotNet), llamar a `pred.Compile()(customer)` costó unos 47.7 microsegundos por operación, mientras que invocar un delegado compilado una sola vez costó unos 2.7 nanosegundos. Las cifras exactas se moverán en tu hardware; los cuatro órdenes de magnitud no. Guarda el delegado en caché junto a la expresión:

```csharp
public static class CustomerRules
{
    public static readonly Expression<Func<Customer, bool>> IsActive =
        c => !c.IsDeleted && c.Orders.Count > 0;

    public static readonly Func<Customer, bool> IsActiveFunc = IsActive.Compile();
}
```

Usa `IsActive` para `IQueryable<Customer>` e `IsActiveFunc` para todo lo que ya esté en memoria. Esa separación es la versión práctica del límite entre `IEnumerable` y `IQueryable` descrito en [cómo elegir el tipo de retorno correcto](/es/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/), y también es la razón por la que una propiedad de entidad como `public bool IsActive => !IsDeleted && Orders.Count > 0` lanza "Translation of member 'IsActive' on entity type 'Customer' failed" la primera vez que alguien la usa en un `Where`. Las propiedades CLR calculadas no tienen árbol que EF pueda leer.

Una última nota sobre planes. Cada forma distinta de árbol de expresión es una entrada distinta en la caché de consultas compiladas de EF, así que un constructor de predicados que ensambla un árbol diferente por petición no reutilizará un plan aunque el texto SQL termine siendo idéntico. Si una consulta compuesta concreta domina una ruta caliente, fíjala con [una consulta compilada](/es/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) en lugar de reconstruir el árbol en cada llamada.

## Dónde encajan estas piezas en un código real

Dos formas cubren casi todo, y la elección depende de quién es dueño de la regla.

Si la regla pertenece a la entidad, basta con una clase estática al lado. `CustomerRules.IsActive`, `OrderRules.IsBig`, un archivo, sin interfaces. Quien llame escribe `db.Customers.Where(CustomerRules.IsActive)` y la definición tiene exactamente un hogar. Esta es la versión por la que hay que empezar, y la mayoría de los equipos nunca necesita más.

Si la regla pertenece a un caso de uso y no a una entidad, un objeto specification se gana su lugar: un tipo pequeño que expone `Expression<Func<T, bool>> Criteria` más includes y ordenamiento opcionales, con `And`, `Or` y `Not` implementados sobre los ayudantes de composición de arriba. El valor no está en la abstracción, está en que un caso de uso se puede pasar de un lado a otro, probar unitariamente contra objetos en memoria mediante el delegado `Compile()` cacheado, y traducir a SQL con el mismo árbol.

Elijas lo que elijas, no construyas una abstracción sobre `Where` en sí. Las llamadas encadenadas ya componen:

```csharp
db.Customers.Where(IsActive).Where(InCountry("NL"));
```

Eso emitió exactamente el mismo SQL que el predicado único compuesto con `And`, hasta el nombre del parámetro. Cada `Where` envuelve al anterior en el árbol, y EF aplana la cadena en un solo `WHERE` con `AND`. Así que los ayudantes de composición solo hacen falta cuando el operador es `Or`, cuando reasignas a otro tipo de entidad, o cuando armas un predicado a partir de una colección cuya longitud no se conoce en tiempo de compilación. Los métodos de extensión sobre `IQueryable<T>` cubren el caso simple de `And` sin nada de código de expresiones:

```csharp
public static IQueryable<Customer> ActiveOnly(this IQueryable<Customer> q)
    => q.Where(c => !c.IsDeleted && c.Orders.Count > 0);

public static IQueryable<Customer> InCountry(this IQueryable<Customer> q, string country)
    => q.Where(c => c.Country == country);

db.Customers.ActiveOnly().InCountry("NL");
```

El mismo SQL otra vez. Lo único que pierdes es la capacidad de extraer el predicado y usarlo contra una lista en memoria, que es justo la ventaja que te compra la versión con `Expression<Func<T, bool>>`.

## Relacionados

- [Fix: "The LINQ expression could not be translated" en EF Core 11](/es/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)
- [Cómo usar filtros de consulta con nombre para soft delete y multi-tenancy en EF Core 11](/es/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/)
- [Cómo registrar el SQL que genera EF Core 11](/es/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [Cómo usar consultas compiladas con EF Core para rutas calientes](/es/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [IEnumerable vs IAsyncEnumerable vs IQueryable en C#](/es/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/)

## Fuentes

- [Evaluación en cliente frente a servidor](https://learn.microsoft.com/en-us/ef/core/querying/client-eval), documentación de EF Core
- [dotnet/efcore#17791: regresión de 3.0, traducir Expression.Invoke](https://github.com/dotnet/efcore/issues/17791)
- [Novedades de EF Core 9: EF.Parameter y EF.Constant](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/whatsnew)
- [Queryable.Where y Queryable.OrderBy](https://learn.microsoft.com/en-us/dotnet/api/system.linq.queryable), referencia de API de .NET
- Todo el SQL fue capturado con `ToQueryString()` contra `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0-preview.7.26381.103 sobre el SDK de .NET 11.0.100-preview.7.26381.103, sin necesidad de conexión a base de datos
