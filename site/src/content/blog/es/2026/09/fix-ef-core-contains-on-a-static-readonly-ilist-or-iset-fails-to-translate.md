---
title: "Solución: EF Core no pudo traducir `Contains` sobre un `IList<T>` o `ISet<T>` static readonly"
description: "EF Core 8, 9 y 10 no logran traducir Contains cuando la lista es un campo static readonly de tipo IList, ICollection, ISet o IReadOnlySet. Llama a Enumerable.Contains de forma explícita o actualiza a EF Core 11."
pubDate: 2026-09-29
template: error-page
tags:
  - "errors"
  - "efcore"
  - "dotnet"
  - "linq"
lang: "es"
translationOf: "2026/09/fix-ef-core-contains-on-a-static-readonly-ilist-or-iset-fails-to-translate"
translatedBy: "claude"
translationDate: 2026-09-29
---

Si `Where(x => AllowedCodes.Contains(x.Code))` lanza `The LINQ expression ... could not be translated` con `Translation of method 'System.Linq.Enumerable.Contains' failed`, revisa cómo está declarado `AllowedCodes`. Casi seguro es un campo `static readonly` de tipo `IList<T>`, `ICollection<T>`, `ISet<T>`, `IReadOnlySet<T>`, `IImmutableSet<T>` o `FrozenSet<T>`. La solución más rápida, que mantiene el mismo SQL, es llamar al operador LINQ de forma explícita: `Enumerable.Contains(AllowedCodes, x.Code)`. La solución real es EF Core 11, donde dotnet/efcore#36757 corrigió la comprobación de query root que rechaza estas formas. Medí cada variante a continuación con `Microsoft.EntityFrameworkCore.Sqlite` 8.0.21, 9.0.19, 10.0.12 y 11.0.0-rc.1.26425.128. Las tres primeras fallan igual. EF Core 11 RC 1 las traduce todas.

## El error en contexto

Esta es la excepción de EF Core 10.0.12 en .NET 10 para un `static readonly IList<string>`:

```
System.InvalidOperationException: The LINQ expression 'DbSet<Order>()
    .Where(o => (IList<string>)List<string> { "Open", "Pending" }
        .Contains(o.Status))' could not be translated. Additional information: Translation of method 'System.Linq.Enumerable.Contains' failed. If this method can be mapped to your custom function, see https://go.microsoft.com/fwlink/?linkid=2132413 for more information. Either rewrite the query in a form that can be translated, or switch to client evaluation explicitly by inserting a call to 'AsEnumerable', 'AsAsyncEnumerable', 'ToList', or 'ToListAsync'. See https://go.microsoft.com/fwlink/?linkid=2101038 for more information.
   at Microsoft.EntityFrameworkCore.Query.QueryableMethodTranslatingExpressionVisitor.Translate(Expression expression)
   at Microsoft.EntityFrameworkCore.Query.QueryCompilationContext.CreateQueryExecutorExpression[TResult](Expression query)
```

Ese mensaje tiene dos pistas. La primera es la conversión de tipo (cast). La colección aparece como `(IList<string>)List<string> { "Open", "Pending" }`, lo que significa que EF ya evaluó tu campo a su valor, una constante, y lo envolvió en un cast al tipo declarado. La segunda es el nombre del método. Escribiste `IList<T>.Contains`, un método de instancia, pero el mensaje nombra `Enumerable.Contains`. EF reescribe las llamadas a `ICollection<T>.Contains` al operador LINQ antes de traducirlas. Así que el método no es el problema. El problema es el argumento que EF le pasa.

Cuando el campo es de tipo `IReadOnlySet<T>` o `IImmutableSet<T>`, el nombre del método en el mensaje cambia a `System.Collections.Generic.IReadOnlySet<string>.Contains` o `System.Collections.Immutable.IImmutableSet<string>.Contains`. Esas interfaces no heredan de `ICollection<T>`, así que EF nunca reescribe la llamada. Es el mismo error con otro mensaje.

## Por qué falla un campo static readonly y una variable local no

Esto ocurre en dos pasos, y el error solo aparece cuando suceden ambos.

**Paso 1: EF incrusta los campos `static readonly` como constantes.** Antes de traducir, el funcletizer de EF recorre la consulta y evalúa todo lo que no depende de la base de datos. Las variables locales capturadas, los campos de instancia y las propiedades estáticas se convierten en parámetros de la consulta. Un campo estático que es `readonly` (`FieldInfo.IsInitOnly`) se trata como un valor que no puede cambiar, así que EF lo evalúa una vez y lo incrusta como constante. En EF Core 10 puedes verlo en [`ExpressionTreeFuncletizer.VisitMember`](https://github.com/dotnet/efcore/blob/release/10.0/src/EFCore/Query/Internal/ExpressionTreeFuncletizer.cs): el miembro estático se marca como variable capturada "unless the captured variable is init-only". Cuando EF construye esa constante, le asigna el tipo de runtime del valor (`List<string>`) y luego agrega un nodo `Convert` de vuelta al tipo declarado (`IList<string>`) siempre que ambos difieran.

**Paso 2: la comprobación de query root solo elimina un tipo de cast.** Para traducir `Contains` sobre una colección en memoria, EF convierte la colección en un query root en línea y luego en `IN (...)`. En EF Core 8, 9 y 10, [`QueryRootProcessor.VisitQueryRootCandidate`](https://github.com/dotnet/efcore/blob/release/10.0/src/EFCore/Query/QueryRootProcessor.cs) desenvuelve un `Convert` solo cuando el tipo destino es exactamente `IEnumerable<T>`:

```csharp
// EF Core 10.0.x, src/EFCore/Query/QueryRootProcessor.cs
if (expression is UnaryExpression { NodeType: ExpressionType.Convert } convertExpression
    && convertExpression.Type.GetGenericTypeDefinition() == typeof(IEnumerable<>))
{
    candidateExpression = convertExpression.Operand;
}
```

Un `Convert` a `IList<string>` no coincide, así que la colección nunca se reconoce como query root y el `Contains` cae en "could not be translated".

Con esto en mente, el patrón de éxito y fallo tiene sentido:

- Los campos `List<T>`, `HashSet<T>` y `T[]` funcionan porque el tipo declarado es igual al tipo de runtime. EF no agrega ningún `Convert`.
- Los campos `IEnumerable<T>`, `IReadOnlyList<T>` e `IReadOnlyCollection<T>` funcionan porque ninguno declara su propio `Contains`. La llamada se enlaza a `Enumerable.Contains`, el compilador convierte el argumento a `IEnumerable<T>`, y la constante que produce EF se convierte a `IEnumerable<T>`, la única forma que acepta la comprobación antigua.
- `IList<T>`, `ICollection<T>`, `ISet<T>`, `IReadOnlySet<T>` e `IImmutableSet<T>` fallan porque declaran `Contains`. C# prefiere el método de instancia sobre el método de extensión, así que el cast se queda en el tipo de la interfaz.
- `FrozenSet<T>` falla aunque sea una clase concreta, porque es abstracta. El valor en runtime es una subclase interna, lo que de nuevo produce un `Convert`. Ese fue el caso reportado en dotnet/efcore#36496, y el PR que lo corrigió también corrigió las interfaces.
- Una variable local capturada, un campo estático no readonly y una propiedad estática funcionan porque se convierten en parámetros, no en constantes, y la ruta de parámetros nunca tuvo este error.

Esto no es una regresión. El reporte original de la variante con `IReadOnlySet<T>` se remonta a EF Core 7, y dotnet/efcore#38839 lo reproduce en 7.0.20 hasta 10.0.11.

## Reproducción mínima

```csharp
// .NET 10, C# 14, Microsoft.EntityFrameworkCore.Sqlite 10.0.12
using Microsoft.EntityFrameworkCore;

using var db = new ShopContext();
db.Database.EnsureDeleted();
db.Database.EnsureCreated();
db.Orders.AddRange(
    new Order { Status = "Open" },
    new Order { Status = "Pending" },
    new Order { Status = "Shipped" });
db.SaveChanges();

// Throws InvalidOperationException on EF Core 8, 9 and 10
var active = db.Orders
    .Where(o => OrderRules.ActiveStatuses.Contains(o.Status))
    .ToList();

Console.WriteLine(active.Count);

public static class OrderRules
{
    public static readonly IList<string> ActiveStatuses = new List<string> { "Open", "Pending" };
}

public class Order
{
    public int Id { get; set; }
    public string Status { get; set; } = "";
}

public class ShopContext : DbContext
{
    public DbSet<Order> Orders => Set<Order>();

    protected override void OnConfiguring(DbContextOptionsBuilder options)
        => options.UseSqlite("Data Source=shop.db");
}
```

Cambia `IList<string>` por `List<string>`, quita `readonly` o convierte el campo en una propiedad `{ get; }`, y la misma consulta funciona. Así suele descubrirse el error: una revisión de código sugiere "expón la interfaz, no el tipo concreto" o "haz ese campo readonly", y una consulta que funcionó durante meses se rompe.

## Qué hace cada declaración en EF Core 8, 9, 10 y 11

Ejecuté una prueba por cada forma contra SQLite en cada versión de EF. Los paquetes de EF Core 8 y 9 se ejecutaron en el runtime de .NET 10. EF Core 11 RC 1 se ejecutó en .NET 11 RC 1. "Constante" significa que EF incrustó los valores en el SQL. "Parámetro" significa que los envió como parámetros.

| Declaración | EF 8.0.21 | EF 9.0.19 | EF 10.0.12 | EF 11 RC 1 |
|---|---|---|---|---|
| `static readonly IList<T>` | falla | falla | falla | constante |
| `static readonly ICollection<T>` | falla | falla | falla | constante |
| `static readonly ISet<T>` | falla | falla | falla | constante |
| `static readonly IReadOnlySet<T>` | falla | falla | falla | constante |
| `static readonly IImmutableSet<T>` | falla | falla | falla | constante |
| `static readonly FrozenSet<T>` | falla | falla | falla | constante |
| `static readonly IReadOnlyList<T>`, `IReadOnlyCollection<T>`, `IEnumerable<T>` | constante | constante | constante | constante |
| `static readonly List<T>`, `HashSet<T>`, `T[]` | constante | constante | constante | constante |
| `static IList<T>` (no readonly) o propiedad estática | parámetro | parámetro | parámetro | parámetro |
| `IList<T>` local capturada | parámetro | parámetro | parámetro | parámetro |
| `EF.Constant(localIList).Contains(...)` | falla | constante | constante | constante |

La última fila es un caso parecido que vale la pena conocer. En EF Core 8, forzar un `IList<T>` local a constante con `EF.Constant` cae en el mismo error. Desde EF Core 9, `EF.Constant` pasa por otra ruta y funciona.

## Las soluciones, en orden de preferencia

### 1. Actualizar a EF Core 11

La corrección es [dotnet/efcore#36757](https://github.com/dotnet/efcore/pull/36757), integrada en `main` el 2025-09-24 y publicada en EF Core 11. Cambia la comprobación para desenvolver cualquier `Convert` cuyo destino sea asignable a `IEnumerable`, y lo hace de forma recursiva:

```csharp
// EF Core 11.0, src/EFCore/Query/QueryRootProcessor.cs
if (expression is UnaryExpression { NodeType: ExpressionType.Convert } convertExpression
    && convertExpression.Type.IsAssignableTo(typeof(IEnumerable)))
{
    return VisitQueryRootCandidate(convertExpression.Operand, elementClrType);
}
```

No se hizo backport. La rama `release/10.0` todavía tiene la comparación con `typeof(IEnumerable<>)`, y 10.0.12 sigue fallando. dotnet/efcore#35024 (el reporte de `IList`/`ICollection`) tiene el hito 11.0.0, y #38839 se cerró como duplicado de este. Si estás en EF Core 10 LTS, planea usar una de las reescrituras siguientes hasta que pases a 11.

### 2. Llamar a `Enumerable.Contains` de forma explícita

Esta es la solución de una línea que recomiendo en EF Core 8, 9 y 10, porque mantiene exactamente el SQL que obtendrías en EF Core 11:

```csharp
// .NET 10, Microsoft.EntityFrameworkCore.Sqlite 10.0.12
var active = db.Orders
    .Where(o => Enumerable.Contains(OrderRules.ActiveStatuses, o.Status))
    .ToList();

// WHERE "o"."Status" IN ('Open', 'Pending')
```

Al llamar directamente al método estático, el compilador convierte el campo a `IEnumerable<string>`, así que la constante de EF llega con cast a `IEnumerable<T>` y pasa la comprobación antigua. Funcionó en las seis formas que fallaban en mis pruebas, incluidas `IReadOnlySet<T>` e `IImmutableSet<T>`. `OrderRules.ActiveStatuses.AsEnumerable().Contains(o.Status)` hace lo mismo si prefieres la sintaxis de método. `OrderRules.ActiveStatuses.Any(s => s == o.Status)` también se traduce a la misma lista `IN`, pero se lee peor y no lo usaría solo para sortear esto.

Una contrapartida: en un `ISet<T>` o `FrozenSet<T>`, `Enumerable.Contains` en LINQ to Objects normal se saltaría la búsqueda por hash. Dentro de una consulta de EF eso no importa, porque la llamada nunca se ejecuta en .NET. Solo describe el SQL.

### 3. Cambiar el tipo declarado

Si la colección solo se usa en consultas, decláralo como `IReadOnlyCollection<T>`, `IReadOnlyList<T>` o un arreglo. Los tres son de solo lectura y los tres se traducen en todas las versiones:

```csharp
// .NET 10, Microsoft.EntityFrameworkCore 10.0.12
public static class OrderRules
{
    public static readonly IReadOnlyList<string> ActiveStatuses = ["Open", "Pending"];
}
```

No cambies a `FrozenSet<T>` para obtener inmutabilidad "real". En EF Core 8 a 10 falla por la razón descrita arriba.

### 4. Dejar que EF parametrice los valores

Copiar el campo a una variable local, o convertirlo en una propiedad `static`, hace que EF envíe los valores como parámetros en lugar de constantes:

```csharp
// .NET 10, Microsoft.EntityFrameworkCore.Sqlite 10.0.12
var statuses = OrderRules.ActiveStatuses;
var active = db.Orders.Where(o => statuses.Contains(o.Status)).ToList();

// EF Core 10: WHERE "o"."Status" IN (@statuses1, @statuses2)
// EF Core 8/9 on SQLite: WHERE "o"."Status" IN (SELECT "s"."value" FROM json_each(@__statuses_0) AS "s")
```

Esto funciona, pero cambia el SQL. Recuerda por qué existe la ruta de constantes: los valores nunca cambian, así que incrustarlos le da a la base de datos una lista fija de literales, que es la mejor forma para el uso de índices y el almacenamiento en caché de planes. Para una lista corta de códigos de estado, las constantes dan mejor SQL. Usa esta opción cuando la lista realmente pueda cambiar en runtime, no solo para esquivar el error de traducción. Si quieres ver qué genera EF en cada caso, [registra el SQL que genera EF Core](/es/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) antes y después del cambio.

## Variantes que llegan a esta página por error

- **`Translation of method 'System.MemoryExtensions.Contains' failed`** en un arreglo después de pasar a C# 14. Es el cambio de resolución de sobrecargas de span de primera clase, no este error. Consulta [la solución al cambio de resolución de sobrecargas con spans en C# 14](/es/2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans/).
- **Un "could not be translated" genérico en un método que escribiste tú**, como `ids.HasItem(x.Id)`. EF no puede ver dentro de tu método, sin importar el tipo de colección. Las causas generales y las reescrituras están en [the LINQ expression could not be translated en EF Core 11](/es/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/), y la forma de reutilizar lógica de predicados de manera segura está en [escribir predicados LINQ reutilizables que EF Core pueda traducir](/es/2026/08/how-to-write-reusable-linq-predicates-ef-core-can-translate/).
- **`An exception was thrown while attempting to evaluate a LINQ query parameter expression`**. Ocurre cuando el funcletizer ejecuta el getter de tu campo o propiedad y el getter lanza una excepción. Falla en la misma etapa pero por otra razón. Consulta [la solución a la evaluación de la expresión de parámetro](/es/2026/08/fix-an-exception-was-thrown-while-attempting-to-evaluate-a-linq-query-parameter-expression/).
- **El mismo `static readonly IList<T>` dentro de una consulta compilada** (`EF.CompileQuery`). Las consultas compiladas pasan por los mismos pasos de funcletizer y query root. Confirmé que fallan igual en EF Core 10.0.12, y `Enumerable.Contains` también las corrige. Consulta [cómo usar consultas compiladas en rutas críticas](/es/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/).

## Relacionado

- [Fix: The LINQ expression could not be translated in EF Core 11](/es/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)
- [How to write reusable LINQ predicates EF Core can translate](/es/2026/08/how-to-write-reusable-linq-predicates-ef-core-can-translate/)
- [How to log the SQL that EF Core 11 generates](/es/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [Fix the C# 14 overload resolution breaking change with spans](/es/2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans/)
- [How to use compiled queries with EF Core for hot paths](/es/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)

## Fuentes

- [dotnet/efcore#35024: Query could not be translated when using a static ICollection/IList field](https://github.com/dotnet/efcore/issues/35024), hito 11.0.0.
- [dotnet/efcore#38839: Contains on a constant collection fails when declared as ICollection/IList/ISet/IReadOnlySet/IImmutableSet](https://github.com/dotnet/efcore/issues/38839), cerrado como duplicado, con una matriz de versiones de 7.0.20 a 10.0.11.
- [dotnet/efcore#36757: Fix handling of readonly fields using abstract classes (i.e. FrozenSet) in parameters for primitive collections](https://github.com/dotnet/efcore/pull/36757), la corrección, integrada el 2025-09-24.
- [`QueryRootProcessor.cs` en `release/10.0`](https://github.com/dotnet/efcore/blob/release/10.0/src/EFCore/Query/QueryRootProcessor.cs) y [`ExpressionTreeFuncletizer.cs` en `release/10.0`](https://github.com/dotnet/efcore/blob/release/10.0/src/EFCore/Query/Internal/ExpressionTreeFuncletizer.cs).
- [What's new in EF Core 10: improved translation for parameterized collections](https://learn.microsoft.com/ef/core/what-is-new/ef-core-10.0/whatsnew#improved-translation-for-parameterized-collection).
