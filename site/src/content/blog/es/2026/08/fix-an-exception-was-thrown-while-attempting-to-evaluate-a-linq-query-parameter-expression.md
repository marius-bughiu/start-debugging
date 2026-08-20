---
title: "Solución: \"An exception was thrown while attempting to evaluate a LINQ query parameter expression\" en EF Core 11"
description: "EF Core lanza esto cuando una parte de tu consulta evaluada en el cliente falla mientras EF la evalúa. Lee InnerException, activa EnableSensitiveDataLogging y saca la comprobación de null fuera de la lambda."
pubDate: 2026-08-19
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "dotnet"
  - "linq"
lang: "es"
translationOf: "2026/08/fix-an-exception-was-thrown-while-attempting-to-evaluate-a-linq-query-parameter-expression"
translatedBy: "claude"
translationDate: 2026-08-19
---

Esto no es un fallo de traducción. EF Core 11 lanza `An exception was thrown while attempting to evaluate a LINQ query parameter expression` cuando ya decidió que un subárbol de tu consulta es evaluable en el cliente (un "parámetro de consulta") y **tu propio código falló mientras EF lo evaluaba**. Nueve de cada diez veces el error real es un `NullReferenceException` sobre un objeto capturado, y está dentro de `InnerException`. Llama a `EnableSensitiveDataLogging()` en tu `DbContextOptionsBuilder` para que EF imprima la expresión exacta con la que se atragantó, y luego saca la comprobación de null de la lambda y llévala a la composición de la consulta. Todo lo que sigue fue verificado contra `Microsoft.EntityFrameworkCore` 10.0.11 en .NET 10; el punto donde se lanza la excepción es idéntico carácter por carácter en las versiones preliminares de EF Core 11, así que el comportamiento se traslada sin cambios.

## El error en contexto

Hay dos variantes de este mensaje, y cuál te toca depende enteramente de si el registro de datos sensibles está activado. Sin él:

```
System.InvalidOperationException: An exception was thrown while attempting to evaluate a LINQ query parameter expression. See the inner exception for more information. To show additional information call 'DbContextOptionsBuilder.EnableSensitiveDataLogging'.
 ---> System.NullReferenceException: Object reference not set to an instance of an object.
   at System.Linq.Expressions.Interpreter.Instruction.NullCheck(Object o)
   at System.Linq.Expressions.Interpreter.FuncCallInstruction`2.Run(InterpretedFrame frame)
   at System.Linq.Expressions.Interpreter.Interpreter.Run(InterpretedFrame frame)
   at System.Linq.Expressions.Interpreter.LightLambda.Run(Object[] arguments)
   at Microsoft.EntityFrameworkCore.Query.Internal.ExpressionTreeFuncletizer.<Evaluate>g__EvaluateCore|74_0(...)
   --- End of inner exception stack trace ---
   at Microsoft.EntityFrameworkCore.Query.Internal.ExpressionTreeFuncletizer.Evaluate(...)
   at Microsoft.EntityFrameworkCore.Query.Internal.ExpressionTreeFuncletizer.ProcessEvaluatableRoot(...)
   at Microsoft.EntityFrameworkCore.Query.Internal.ExpressionTreeFuncletizer.VisitBinary(BinaryExpression binary)
```

Con `EnableSensitiveDataLogging()` activado, el mensaje cambia a la variante mucho más útil que nombra la expresión:

```
System.InvalidOperationException: An exception was thrown while attempting to evaluate the LINQ query parameter expression 'value(Program+<>c__DisplayClass0_0).filter.MinRating'. See the inner exception for more information.
 ---> System.NullReferenceException: Object reference not set to an instance of an object.
```

Fíjate en el artículo: el mensaje no sensible dice "a LINQ query parameter expression", el sensible dice "the LINQ query parameter expression '...'". Si buscaste uno y llegaste aquí con el otro, sigues en el lugar correcto. Ambos vienen del mismo par de cadenas de recursos, `ExpressionParameterizationException` y `ExpressionParameterizationExceptionSensitive`.

El `<>c__DisplayClass0_0` de esa expresión es la clase de cierre generada por el compilador que contiene tus variables locales capturadas. `filter` es la variable capturada, `MinRating` es el acceso a miembro que explotó. Esa sola cadena suele bastar para encontrar la línea.

## Por qué ocurre

Antes de poder construir SQL, EF recorre tu árbol de expresión y lo divide en dos tipos de nodo: los que dependen de la raíz de la consulta (`b.Rating`, que se convierte en una columna) y los que no (`filter.MinRating`, que se convierte en un parámetro SQL). Esa segunda categoría es lo que EF llama funcletización, y la maneja `ExpressionTreeFuncletizer`. Para cada subárbol evaluable, EF compila un `Func<object>` y lo invoca:

```csharp
// Microsoft.EntityFrameworkCore 11, ExpressionTreeFuncletizer.EvaluateCore
try
{
    return Lambda<Func<object>>(Convert(expression, typeof(object)))
        .Compile(preferInterpretation: true)
        .Invoke();
}
catch (Exception exception)
{
    throw new InvalidOperationException(
        _logger.ShouldLogSensitiveData()
            ? CoreStrings.ExpressionParameterizationExceptionSensitive(expression)
            : CoreStrings.ExpressionParameterizationException,
        exception);
}
```

Ese es todo el mecanismo. Cualquier excepción que tu código lance dentro de una expresión capturada queda envuelta en este `InvalidOperationException` y se relanza. EF no se está quejando de tu consulta, está informando de que ejecutar una parte de ella falló.

Esto importa para depurarlo. El mensaje es genérico a propósito, porque el texto de la expresión puede contener datos de usuario, y por eso la variante detallada está detrás del registro de datos sensibles. El error específico siempre está en `InnerException`, y la traza de pila de la excepción interna apunta a `System.Linq.Expressions.Interpreter` en lugar de a tu código, porque EF compila con `preferInterpretation: true`. No busques tus propios frames en esa pila. Lee el tipo y el mensaje de la excepción interna.

Contrasta esto con el error hermano, `The LINQ expression could not be translated`, que se dispara cuando EF no puede convertir una construcción en SQL en absoluto. Otra etapa de la canalización, otra solución.

## Reproducción mínima

Un `DbSet<Blog>`, un DTO de filtro anulable y un `Where` que lo desreferencia:

```csharp
// .NET 10, C# 14, Microsoft.EntityFrameworkCore.Sqlite 10.0.11
using Microsoft.EntityFrameworkCore;

public class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public int Rating { get; set; }
}

public class Filter { public int MinRating { get; set; } }

public class AppDb(DbContextOptions<AppDb> o) : DbContext(o)
{
    public DbSet<Blog> Blogs => Set<Blog>();
}
```

```csharp
// .NET 10, C# 14, EF Core 10.0.11
Filter? filter = null;                                      // came back null from the request binder
var q = db.Blogs.Where(b => b.Rating >= filter!.MinRating); // no exception yet
var rows = q.ToList();                                      // throws here
```

Dos detalles que vale la pena interiorizar:

- **Componer la consulta no lanza nada.** Construir el `IQueryable` es gratis. La funcletización se ejecuta cuando la consulta se compila, lo que ocurre en el operador terminal. Lo confirmé construyendo la consulta y sin enumerarla nunca: ninguna excepción.
- **Todos los operadores terminales lanzan, incluido `ToQueryString()`.** `ToList()`, `ToListAsync()`, `Any()`, `Count()` y `ToQueryString()` pasan todos por la misma ruta de compilación. Ese último es práctico, porque significa que puedes reproducir esto sin ninguna conexión a base de datos.

Estas son las excepciones internas que medí para los desencadenantes más comunes, todas contra EF Core 10.0.11 con el proveedor SQLite:

| Lo que escribiste | `InnerException` |
| --- | --- |
| `b.Rating >= filter!.MinRating` con `filter` en null | `NullReferenceException` |
| `b.Rating >= config.MinRating` donde el getter lanza | tu propia excepción, tal cual |
| `b.Rating == maybe!.Value` con `int? maybe = null` | `InvalidOperationException: Nullable object must have a value.` |
| `b.Rating == empty.First()` sobre una `List<int>` vacía | `InvalidOperationException: Sequence contains no elements` |
| `b.Rating == int.Parse(raw)` con `raw = "not-a-number"` | `FormatException` |
| `b.Rating == map["nope"]` sobre un `Dictionary<string, int>` | `KeyNotFoundException` |
| `b.Rating >= Bad.Value` donde el inicializador estático lanza | `TargetInvocationException` envolviendo la real |
| `b.Name == s!.Trim()` con `string? s = null` | `NullReferenceException` |

La penúltima fila atrapa a la gente dos veces: un inicializador de campo estático que falla te deja tres niveles de anidamiento. El envoltorio, luego `TargetInvocationException`, y luego la excepción que de verdad te importa. Lee `ex.InnerException.InnerException` antes de concluir que el mensaje es inútil.

## Solución, en detalle

La solución siempre tiene la misma forma: asegurarte de que la expresión capturada no pueda lanzar cuando EF la evalúe. Hay cuatro maneras de lograrlo, ordenadas por preferencia.

### 1. Componer condicionalmente fuera de la lambda

Esta es la solución correcta para el caso abrumadoramente común del "filtro opcional", y además produce mejor SQL, porque el predicado desaparece por completo cuando el filtro no está:

```csharp
// .NET 10, C# 14, EF Core 10.0.11
IQueryable<Blog> q = db.Blogs;

if (filter is not null)
{
    q = q.Where(b => b.Rating >= filter.MinRating);
}

var rows = await q.ToListAsync();
```

Verificado con `filter` en null: ninguna excepción, y ninguna cláusula `WHERE` muerta en el SQL generado.

### 2. Extraer el valor a una variable local antes de la consulta

Si el valor es realmente opcional pero el predicado no lo es, proyéctalo a una variable local con un valor por defecto definido. EF entonces captura un `int`, que no puede lanzar:

```csharp
// .NET 10, C# 14, EF Core 10.0.11
var min = filter?.MinRating ?? int.MinValue;
var rows = await db.Blogs.Where(b => b.Rating >= min).ToListAsync();
```

Esta es también la solución para `int.Parse`, `Guid.Parse` y las búsquedas en diccionarios. Haz el parseo o la búsqueda antes de la consulta, donde puedes manejar el fallo correctamente, en lugar de dentro de una lambda donde el fallo llega envuelto tres capas más adentro.

### 3. Cortocircuitar dentro de la lambda

Si tienes que mantenerlo todo en una sola expresión, una guarda con `&&`, `||` o un ternario funciona. El funcletizador trata de forma especial los operadores binarios con cortocircuito y las `ConditionalExpression`, y no evalúa ansiosamente la rama muerta:

```csharp
// .NET 10, C# 14, EF Core 10.0.11
var rows = await db.Blogs
    .Where(b => filter == null || b.Rating >= filter.MinRating)
    .ToListAsync();

// the ternary form behaves identically
var rows2 = await db.Blogs
    .Where(b => filter == null ? true : b.Rating >= filter.MinRating)
    .ToListAsync();
```

Las tres variantes (`filter != null && ...`, `filter == null || ...` y el ternario) devolvieron limpiamente en mi reproducción con `filter` en null. Aun así, ponla en tercer lugar por dos razones: envía a la base de datos una cláusula `WHERE` siempre verdadera cuando el filtro no está, y se apoya en un comportamiento del funcletizador que ha cambiado entre versiones mayores. El issue [dotnet/efcore#34883](https://github.com/dotnet/efcore/issues/34883) es exactamente esta forma, un condicional que mezcla una condición del cliente con una de la base de datos, y sufrió una regresión a un error interno de `unbound variable` durante el ciclo de EF Core 9 antes de ser parcheado.

### 4. Arreglar lo que lanza

Si el culpable es un getter de propiedad que lanza porque un servicio todavía no está inicializado (el caso clásico es un resolvedor de inquilinos que lee un ámbito ambiental vacío), nada de lo anterior ayuda. La consulta está bien; tu raíz de composición está rota. Haz que el getter devuelva un valor, o que falle antes con un mensaje que diga algo útil.

## Trampas y variantes

**Los filtros de consulta no quedan envueltos.** Si tu lambda de `HasQueryFilter` lee un campo del `DbContext` y esa lectura lanza, obtienes tu excepción en crudo, no esta. Monté un contexto con `HasQueryFilter(b => b.TenantId == _tenant.Current)` donde `_tenant.Current` lanza, y `db.Blogs.ToList()` mostró `InvalidOperationException: no tenant in scope` directamente. La razón está en el funcletizador: las expresiones que tocan el contexto van por la ruta de acceso al contexto, que devuelve una `Lambda` diferida en lugar de invocarla dentro de ese bloque `try`. Así que si estás depurando una configuración multiinquilino y sí ves el envoltorio de parametrización, la captura culpable está en un `Where` normal, no en el filtro. Llamar a `IgnoreQueryFilters()` hace que la consulta funcione y es una forma rápida de confirmar cuál de las dos tienes.

**Una colección en null dentro de `Contains` no lanza. Devuelve silenciosamente nada.** Esta es la variante más peligrosa de la página, porque parece una solución:

```csharp
// .NET 10, C# 14, EF Core 10.0.11, SQLite provider
List<string>? names = null;
var rows = db.Blogs.Where(b => names!.Contains(b.Name)).ToList();
// rows.Count == 0, no exception
// SELECT "b"."Id", "b"."Name", "b"."Rating" FROM "Blogs" AS "b" WHERE 0
```

EF traduce una colección parametrizada en null a un predicado siempre falso, exactamente como hace con una vacía. No obtienes un error, obtienes cero filas, y el bug se publica. Si en tu dominio una lista en null significa "sin filtro", dilo explícitamente con una guarda `names is null ||`, o compón condicionalmente como en la solución 1.

**`EF.Constant` no te salva.** Envolver la captura como `EF.Constant(filter!.MinRating)` sigue lanzando. La desreferencia ocurre mientras se evalúa el argumento, antes de que EF llegue a ver el método marcador.

**Un `NullReferenceException` en crudo en lugar del envoltorio significa que el fallo estuvo en tu código, no en el de EF.** `db.Blogs.Take(filter!.MinRating)` lanza un `NullReferenceException` simple, porque `Take` acepta un `int`: el compilador de C# evalúa ese argumento en el punto de llamada y nunca llega a formar parte de un árbol de expresión. Lo mismo con `Skip`, y con cualquier cosa que interpoles en una cadena antes de pasarla. Solo las lambdas reciben el envoltorio.

**Encadenar no ayuda.** Dividirlo en `db.Blogs.Where(b => b.Id == 0).Where(b => b.Rating >= filter!.MinRating)` sigue lanzando. La funcletización recorre todo el árbol compuesto en tiempo de compilación, no operador por operador, así que un filtro anterior no puede cortocircuitar una captura posterior.

**Lanza en cada ejecución, no solo en la primera.** La caché de consultas compiladas se indexa por la forma de la consulta, y la funcletización se ejecuta antes de la búsqueda en caché para extraer los valores de los parámetros. Aquí no existe el "funcionó una vez y luego empezó a fallar".

## Relacionado

- La otra excepción de EF Core en tiempo de consulta con la que se confunde esta está cubierta en [por qué EF Core dice que la expresión LINQ no se pudo traducir](/es/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/), que trata de construcciones que EF no puede convertir en SQL en absoluto.
- Cuando la excepción interna es `Sequence contains no elements`, vale la pena leer el comportamiento del operador LINQ subyacente en [qué lanza realmente First y Single](/es/2026/07/fix-invalidoperationexception-sequence-contains-no-elements/).
- Activar la variante sensible de este mensaje es una línea de la configuración más amplia descrita en [cómo ver el SQL que genera EF Core](/es/2026/07/how-to-log-the-sql-that-ef-core-11-generates/).
- Si te topas con esto mientras montas multiinquilinato, [los filtros de consulta con nombre para borrado lógico y multiinquilinato](/es/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/) cubren cómo llevar el id de inquilino al contexto sin un getter que lance.
- La parametrización también gobierna el comportamiento de la caché, lo cual importa cuando persigues rendimiento de consultas con [consultas compiladas en rutas calientes](/es/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/).

## Fuentes

- [CoreStrings.ExpressionParameterizationException](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.diagnostics.corestrings.expressionparameterizationexception) en MS Learn, para la cadena de recursos exacta.
- [ExpressionTreeFuncletizer.cs](https://github.com/dotnet/efcore/blob/main/src/EFCore/Query/Internal/ExpressionTreeFuncletizer.cs) en dotnet/efcore, donde vive el try/catch que envuelve.
- [Evaluación en cliente frente a servidor](https://learn.microsoft.com/en-us/ef/core/querying/client-eval) en la documentación de EF Core, sobre cómo EF divide un árbol de consulta.
- [DbContextOptionsBuilder.EnableSensitiveDataLogging](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.dbcontextoptionsbuilder.enablesensitivedatalogging), que activa la variante del mensaje que nombra la expresión.
- [dotnet/efcore#34883](https://github.com/dotnet/efcore/issues/34883), la regresión de EF Core 9 donde un condicional mixto de cliente y base de datos producía esta excepción con un error interno de `unbound variable`.
- [Discusión #792 de Finbuckle.MultiTenant](https://github.com/Finbuckle/Finbuckle.MultiTenant/discussions/792), un reporte representativo de este error en un contexto multiinquilino.
