---
title: "Solución: \"The LINQ expression could not be translated\" en EF Core 11"
description: "EF Core 11 lanza esto cuando un Where u OrderBy llama a un método que no puede convertir en SQL. Reescribe el predicado con operadores traducibles, o trae los datos al cliente con AsEnumerable primero."
pubDate: 2026-07-04
template: error-page
tags:
  - "errors"
  - "efcore"
  - "dotnet"
lang: "es"
translationOf: "2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-04
---

EF Core 11 lanza `The LINQ expression could not be translated` cuando una parte de tu consulta fuera del `Select` final (normalmente un `Where`, `OrderBy`, `GroupBy` o `Join`) llama a un método o usa una construcción que el proveedor de base de datos no puede convertir en SQL. Corrígelo reescribiendo el predicado con operadores que EF sí puede traducir (`==`, `Contains`, `StartsWith`, `EF.Functions.*`), o, si de verdad necesitas lógica en memoria, fuerza la evaluación en el cliente de forma intencional llamando a `AsEnumerable()`, `AsAsyncEnumerable()`, `ToList()` o `ToListAsync()` antes del paso no traducible. Esto aplica a `Microsoft.EntityFrameworkCore` 11.0 en .NET 11 con C# 14, y el comportamiento no ha cambiado desde EF Core 3.0.

## El error en contexto

La excepción completa en tiempo de ejecución se ve así. EF Core imprime el árbol de expresión exacto con el que se atascó, que es la pista más útil de toda la pantalla:

```
System.InvalidOperationException: The LINQ expression 'DbSet<Order>()
    .Where(o => o.CustomerName.Equals(
        name,
        StringComparison.OrdinalIgnoreCase))' could not be translated. Either rewrite the query in a form that can be translated, or switch to client evaluation explicitly by inserting a call to 'AsEnumerable', 'AsAsyncEnumerable', 'ToList', or 'ToListAsync'. See https://go.microsoft.com/fwlink/?linkid=2101038 for more information.
```

El tipo de la excepción es `System.InvalidOperationException`, y se lanza cuando la consulta se ejecuta (en `ToList`, `First`, `foreach` o `await`), no cuando la compones. Por eso una traza de pila suele apuntar a tu repositorio o controlador en vez de al `Where` que realmente lo causó. Lee la expresión citada, no la traza de pila.

## Por qué ocurre esto

EF Core traduce la mayor parte posible de tu consulta a una sola sentencia SQL y la ejecuta en el servidor de base de datos. Desde la versión 3.0, admite evaluación parcial en el cliente en exactamente un lugar: la proyección de nivel superior, es decir, la última llamada a `Select`. Si cualquier otra parte de la consulta, un `Where`, `OrderBy`, `Skip`, `GroupBy`, `Join` o una subconsulta anidada, contiene una expresión que no puede traducir, se niega a cargar en silencio toda la tabla en memoria y filtrar ahí. En su lugar, lanza la excepción.

Esa negativa deliberada es una característica. Antes de EF Core 3.0, el framework evaluaba con gusto un `Where` no traducible en el cliente, lo que significaba que una consulta que parecía barata podía descargar en silencio un millón de filas y filtrarlas en tu proceso. El comportamiento actual cambia una excepción ruidosa en tiempo de desarrollo por una clase de desastres de rendimiento en producción que nunca ves. Cuando te topas con este error, EF Core te está diciendo que el predicado que escribiste no tiene equivalente en SQL.

Los desencadenantes habituales son:

- Llamar a un método de C# sin mapeo a SQL (un helper propio, `string.Equals` con un `StringComparison`, `Enum.HasFlag`, `decimal.Round` con un `MidpointRounding`).
- Formatear o parsear dentro de la consulta (`DateTime.ToString("yyyy-MM-dd")`, `int.Parse`, `Guid.Parse`).
- Navegar o llamar a un tipo que el proveedor no puede mapear (una propiedad calculada respaldada por lógica de C#, no por una columna mapeada).
- Comparar contra una construcción que el proveedor no admite para tu base de datos (cierta aritmética de `TimeSpan`, algunas APIs basadas en `Span`).

## Reproducción mínima

Aquí está el programa más pequeño que lo reproduce. La comparación sin distinción de mayúsculas con una sobrecarga de `StringComparison` es la causa más común del mundo real, porque se lee perfectamente en C# y es completamente no traducible:

```csharp
// .NET 11, EF Core 11, Microsoft.EntityFrameworkCore.SqlServer 11.0
using Microsoft.EntityFrameworkCore;

using var db = new ShopContext();

string name = "acme";

// Throws at ToListAsync: StringComparison has no SQL translation.
var orders = await db.Orders
    .Where(o => o.CustomerName.Equals(name, StringComparison.OrdinalIgnoreCase))
    .ToListAsync();

public class Order
{
    public int Id { get; set; }
    public string CustomerName { get; set; } = "";
    public DateTime PlacedOn { get; set; }
}

public class ShopContext : DbContext
{
    public DbSet<Order> Orders => Set<Order>();

    protected override void OnConfiguring(DbContextOptionsBuilder options) =>
        options.UseSqlServer("Server=.;Database=Shop;Trusted_Connection=True;Encrypt=False");
}
```

La llamada `Equals(name, StringComparison.OrdinalIgnoreCase)` es el problema. EF Core no tiene forma de expresar "ordinal, sin distinción de mayúsculas" como SQL, porque la distinción de mayúsculas en SQL la gobierna la intercalación de la columna, no un argumento de método. Así que lanza la excepción.

## Solución, en detalle

Las soluciones están ordenadas de la mejor (dejar el trabajo en el servidor) a la de último recurso (traer datos a memoria a propósito).

### 1. Reescribe el predicado con operadores traducibles

El noventa por ciento de las veces la solución es expresar la misma intención usando operadores que EF Core conoce. Para la comparación sin distinción de mayúsculas, elimina por completo la sobrecarga de `StringComparison`. En SQL Server la intercalación por defecto ya no distingue mayúsculas, así que un simple `==` hace lo que quieres y se traduce a un `WHERE` limpio:

```csharp
// .NET 11, EF Core 11 -- translates to WHERE [o].[CustomerName] = @name
var orders = await db.Orders
    .Where(o => o.CustomerName == name)
    .ToListAsync();
```

Si necesitas la comparación sin distinción de mayúsculas independientemente de la intercalación de la columna, usa `EF.Functions.Collate` para fijar la comparación a una intercalación sin distinción de mayúsculas, que el proveedor traduce a una cláusula `COLLATE`:

```csharp
// .NET 11, EF Core 11 -- explicit case-insensitive comparison in SQL
var orders = await db.Orders
    .Where(o => EF.Functions.Collate(o.CustomerName, "SQL_Latin1_General_CP1_CI_AS") == name)
    .ToListAsync();
```

La superficie de `EF.Functions` existe precisamente para esto: `Like`, `Collate`, `DateDiffDay`, `Contains` (texto completo), `Random` y helpers específicos del proveedor te dan construcciones SQL que el C# puro no puede expresar. Recúrrela antes de rendirte con la evaluación en el servidor. Para coincidencia de subcadenas, prefiere `Contains`, `StartsWith` y `EndsWith`, que se traducen a `LIKE`:

```csharp
// .NET 11, EF Core 11 -- translates to WHERE [o].[CustomerName] LIKE @p + '%'
var orders = await db.Orders
    .Where(o => o.CustomerName.StartsWith(name))
    .ToListAsync();
```

### 2. Calcula el valor antes de la consulta, no dentro de ella

Una gran parte de estos errores son autoinfligidos: llamas a un método dentro de la consulta cuyo resultado en realidad no depende de la fila. Súbelo a una variable local y EF Core lo convierte en un parámetro:

```csharp
// Throws: ToString() on a DateTime cannot be translated
var bad = await db.Orders
    .Where(o => o.PlacedOn.ToString("yyyy") == "2026")
    .ToListAsync();

// Fixed: compare the mapped column directly, no formatting in SQL
var year = 2026;
var good = await db.Orders
    .Where(o => o.PlacedOn.Year == year)
    .ToListAsync();
```

`DateTime.Year`, `Month`, `Day`, `Date` y similares sí se traducen (a `DATEPART` en SQL Server), mientras que `ToString(format)` no. La regla práctica: extrae el dato que necesitas con una propiedad que EF pueda mapear, en lugar de formatear el valor completo a una cadena y comparar sobre ella.

### 3. Mueve la lógica solo-cliente a la proyección de nivel superior

Recuerda que EF Core permite evaluación en el cliente en el último `Select`. Si tu método no traducible tiene que ver realmente con dar forma a la salida, no con filtrar, muévelo ahí. Esta consulta filtra y ordena en SQL, y luego ejecuta el helper de C# solo sobre las filas que volvieron:

```csharp
// .NET 11, EF Core 11 -- filter in SQL, format on the client in the projection
var rows = await db.Orders
    .Where(o => o.PlacedOn.Year == 2026)      // server
    .OrderByDescending(o => o.PlacedOn)        // server
    .Select(o => new
    {
        o.Id,
        Display = FormatCustomer(o.CustomerName) // client, allowed here
    })
    .ToListAsync();

static string FormatCustomer(string raw) => raw.Trim().ToUpperInvariant();
```

`FormatCustomer` lanzaría la excepción en un `Where`, pero en el `Select` final es legal y se ejecuta en memoria sobre el conjunto de resultados ya filtrado. Esta es la forma sancionada de combinar el filtrado en SQL con el formateo en C#.

### 4. Fuerza la evaluación en el cliente a propósito (último recurso)

Si la lógica de verdad no puede correr en SQL y debe estar en un `Where`, opta por la evaluación en el cliente de forma explícita rompiendo la consulta con `AsEnumerable` o `AsAsyncEnumerable`. Todo lo anterior a la ruptura corre en el servidor; todo lo posterior corre en memoria:

```csharp
// .NET 11, EF Core 11 -- narrow in SQL first, then filter in memory
var orders = db.Orders
    .Where(o => o.PlacedOn.Year == 2026)   // runs in SQL, cuts the row count down
    .AsAsyncEnumerable();                    // boundary: client evaluation from here

var matched = new List<Order>();
await foreach (var o in orders)
{
    if (o.CustomerName.Equals(name, StringComparison.OrdinalIgnoreCase))
        matched.Add(o);
}
```

El detalle crítico es poner el mayor filtrado posible antes del límite `AsEnumerable` para transferir la menor cantidad de filas. Llamar a `AsEnumerable()` sobre un `DbSet` pelado y filtrar después descarga toda la tabla, que es exactamente el desastre del que te protegía la excepción. Prefiere `AsAsyncEnumerable` sobre `ToList` aquí para transmitir en flujo en lugar de acumular el resultado intermedio.

## Trampas y variantes

**Funcionaba en EF Core 2.2 y se rompió al actualizar.** La evaluación en el cliente en cualquier lugar se eliminó en EF Core 3.0. Una consulta que "funcionaba" antes probablemente filtraba en memoria todo el tiempo. La actualización no rompió tu consulta, expuso un problema de rendimiento latente. Si te estás moviendo entre versiones mayores, vale la pena leer los [cambios disruptivos que de verdad muerden al migrar de EF Core 6 a EF Core 11](/es/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) antes de empezar.

**El proveedor en memoria no lanza la excepción, el real sí.** Si tus pruebas unitarias usan el proveedor en memoria, evalúan todo en el cliente y nunca ven este error, y luego producción contra SQL Server o PostgreSQL lanza la excepción con la misma consulta. Prueba contra un proveedor que traduzca. Ejecutar tu suite contra una base de datos real con algo como Testcontainers atrapa estos casos antes de que salgan.

**Un `GroupBy` que proyecta a algo que SQL no puede agregar.** Un `GroupBy` seguido de un `Select` que devuelve entidades agrupadas crudas (en vez de agregados como `Count`, `Sum`, `Max`) con frecuencia no se puede traducir. Reformula la proyección a agregados escalares, o agrupa en el cliente tras materializar.

**Propiedades de navegación y miembros calculados no mapeados.** Filtrar sobre una propiedad calculada de C# (un getter con lógica, no una columna mapeada) no se puede traducir, porque no hay ninguna columna detrás. Mapea una columna persistida/calculada, o filtra sobre las columnas subyacentes en su lugar.

**`Contains` sobre una lista local grande.** `Where(o => ids.Contains(o.Id))` sí se traduce (a `IN` o a un parámetro con valores de tabla en EF Core 11), pero puede aparecer un "could not be translated" relacionado cuando el tipo de elemento es complejo. Mantén el argumento de `Contains` como una lista simple de escalares.

**Un error distinto, el mismo desencadenante.** Si ves `The LINQ expression could not be translated` y justo debajo una nota sobre `AsSplitQuery`, estás topando con un límite de traducción en una consulta con múltiples includes de colecciones, no con un problema de evaluación en el cliente. Ese va sobre la explosión cartesiana, y la solución es la [división de consultas para evitar una explosión cartesiana en EF Core 11](/es/2026/06/how-to-use-query-splitting-to-avoid-a-cartesian-explosion-in-ef-core-11/), no reescribir un predicado.

El modelo mental que te mantiene fuera de este error para siempre: todo excepto el `Select` final tiene que convertirse en SQL. Antes de escribir un `Where`, pregúntate si la base de datos podría ejecutarlo. Si la respuesta implica un método de C# del que la base de datos nunca ha oído hablar, o bien encuentra el equivalente en `EF.Functions`, precalcula el valor, o acepta que estás trayendo filas a memoria y dilo explícitamente con `AsAsyncEnumerable`.

## Relacionado

- [Cómo detectar consultas N+1 en EF Core 11](/es/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) cubre la otra trampa silenciosa de rendimiento de consultas que sobrevive al bloqueo de la evaluación en el cliente.
- [AsNoTracking vs AsNoTrackingWithIdentityResolution en EF Core 11](/es/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/) vale la pena leerlo una vez que tus consultas de lectura se traducen limpiamente y quieres que sean más rápidas.
- [Cómo mapear y consultar columnas JSON en EF Core 11](/es/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) muestra cómo mantener los predicados JSON en el servidor en lugar de materializar y filtrar.
- [Cómo usar consultas compiladas con EF Core para rutas críticas](/es/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) ayuda una vez que tu consulta es traducible y estás afinando el rendimiento.
- [Cómo usar ExecuteUpdate y ExecuteDelete para escrituras masivas en EF Core 11](/es/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) es el equivalente del lado de escritura de mantener el trabajo en la base de datos en lugar de en memoria.

## Fuentes

- [Evaluación en cliente vs. servidor, documentación de EF Core](https://learn.microsoft.com/en-us/ef/core/querying/client-eval)
- [Cómo funcionan las consultas, documentación de EF Core](https://learn.microsoft.com/en-us/ef/core/querying/how-query-works)
- [Funciones de base de datos y EF.Functions, documentación de EF Core](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/functions)
- [dotnet/efcore issue #24318: "could not be translated" con el proveedor en memoria](https://github.com/dotnet/efcore/issues/24318)
