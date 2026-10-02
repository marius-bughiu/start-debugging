---
title: "EF.Parameter vs EF.Constant en consultas de EF Core 11"
description: "EF.Constant incrusta un valor capturado como literal SQL, EF.Parameter convierte un literal en un parámetro SQL. Conserva los valores predeterminados de EF Core, usa EF.Parameter para evitar que los árboles de expresión construidos dinámicamente se recompilen en cada llamada, y usa EF.Constant solo para un valor con pocos valores distintos cuyos datos estén lo bastante sesgados como para necesitar su propio plan."
pubDate: 2026-10-02
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "dotnet"
  - "sql-server"
  - "performance"
lang: "es"
translationOf: "2026/10/ef-parameter-vs-ef-constant-in-ef-core-11-queries"
translatedBy: "claude"
translationDate: 2026-10-02
---

`EF.Constant(x)` le indica a EF Core que escriba un valor en el SQL como literal (`WHERE [Status] = N'Pending'`) aunque provenga de una variable, que EF normalmente enviaría como parámetro. `EF.Parameter(x)` hace lo contrario: obliga a que un valor que EF normalmente incrustaría, como un literal o un `Expression.Constant` en un árbol construido a mano, se envíe como parámetro (`WHERE [Status] = @p`). Los valores predeterminados son los correctos para casi todas las consultas. Recurre a `EF.Parameter` cuando construyas árboles de expresión dinámicamente, porque las constantes crudas en esos árboles fuerzan una compilación completa de la consulta por cada valor distinto. Recurre a `EF.Constant` solo cuando una columna tiene pocos valores distintos con datos muy sesgados y la base de datos necesita un plan separado por valor.

Todo lo que sigue se ejecutó en EF Core 11.0.0-rc.1.26425.128 con el SDK 11.0.100-rc.1.26425.128 en un Apple M4. Donde se indica, también probé EF Core 10.0.12 con el SDK 10.0.302, y se comportó igual. `EF.Constant` llegó en EF Core 8.0.2, `EF.Parameter` en EF Core 9, y el método específico para colecciones `EF.MultipleParameters` en EF Core 10.

## La comparación de un vistazo

| | `EF.Parameter(x)` | `EF.Constant(x)` |
| --- | --- | --- |
| Disponible desde | EF Core 9 | EF Core 8.0.2 |
| Resultado escalar en SQL | parámetro `@p` | literal, p. ej. `N'Pending'` |
| Resultado de colección en SQL (EF 10/11) | un parámetro JSON + `OPENJSON` | literales `IN (1, 2, 3, ...)` |
| Entradas en la caché de consultas de EF para N valores distintos | 1 | 1 (desde EF 9) |
| Entradas en la caché de planes de la base de datos para N valores distintos | 1 | hasta N |
| Plan ajustado al valor real | No (aplica el parameter sniffing) | Sí |
| El valor aparece en los registros de EF por defecto | No (`'?'`) | No, ocultado como `?` desde EF 10 |
| Funciona en `EF.CompileQuery` / filtros de consulta | No, lanza excepción | No, lanza excepción |
| Uso principal | árboles de expresión dinámicos, forzar un parámetro JSON de colección | columnas sesgadas de baja cardinalidad, forzar una lista `IN` incrustada |

## Qué hace EF Core por defecto

La regla de parametrización de EF es simple: todo lo que viene de fuera del árbol de expresión (una variable local capturada, un campo, un argumento de método) se convierte en parámetro, y todo lo escrito como literal dentro de la lambda se convierte en constante. Esto es lo que genera EF Core 11 RC 1 para SQL Server, directamente de `ToQueryString()`:

```csharp
// EF Core 11.0.0-rc.1, Microsoft.EntityFrameworkCore.SqlServer, .NET 11 RC 1
var status = "Pending";

db.Orders.Where(o => o.Status == status);
// DECLARE @status nvarchar(4000) = N'Pending';
// WHERE [o].[Status] = @status

db.Orders.Where(o => o.Status == "Pending");
// WHERE [o].[Status] = N'Pending'
```

Esa división es deliberada. Un literal en el código fuente no puede cambiar entre ejecuciones, así que incrustarlo no cuesta nada y le da al optimizador de consultas el valor real para estimar. Una variable capturada puede cambiar en cada llamada, así que incrustarla produciría una cadena SQL distinta por cada valor, y cada cadena distinta obtiene su propia entrada en la caché de planes de la base de datos. En un SQL Server con mucha carga eso significa una caché de planes inflada y una compilación por cada valor nuevo.

`EF.Constant` y `EF.Parameter` existen para anular esa regla en cualquiera de las dos direcciones.

## EF.Constant: forzar un literal

```csharp
// EF Core 11.0.0-rc.1
var status = "Pending";
db.Orders.Where(o => o.Status == EF.Constant(status));
// WHERE [o].[Status] = N'Pending'

var name = "O'Brien";
db.Orders.Where(o => o.Customer == EF.Constant(name));
// WHERE [o].[Customer] = N'O''Brien'
```

La segunda consulta importa si te preocupa la inyección SQL: EF sigue generando el literal a través del mapeo de tipos del proveedor, así que la comilla se escapa. `EF.Constant` no es concatenación de cadenas.

La razón para hacerlo es el parameter sniffing. SQL Server compila un plan parametrizado con el primer valor que ve y reutiliza ese plan para todos los valores posteriores. Si `Status = 'Archived'` coincide con 40 millones de filas y `Status = 'Pending'` con 200, un plan compilado para uno es incorrecto para el otro. Con un literal, cada valor obtiene su propio plan con su propia estimación de cardinalidad. Ese intercambio solo compensa cuando la columna tiene un conjunto pequeño y fijo de valores. Si envuelves un ID de usuario o un número de pedido en `EF.Constant`, has reconstruido el problema de la caché de planes que los valores predeterminados de EF fueron diseñados para evitar.

### EF.Constant ya no cuesta una recompilación de EF

En EF Core 8 la implementación insertaba la constante al principio del pipeline, antes de la búsqueda en la caché de consultas de EF, así que cada valor nuevo provocaba una compilación completa de LINQ a SQL. La [página de cambios importantes de EF Core 9](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/breaking-changes) describe la reescritura: el método ahora se procesa en una etapa posterior, después de la caché. Lo comprobé contando el evento de registro de depuración `Compiling query expression` a lo largo de 500 ejecuciones con 500 valores distintos, tras un calentamiento de 50 consultas, en SQLite en memoria:

```csharp
// EF Core 11.0.0-rc.1, Microsoft.EntityFrameworkCore.Sqlite
for (int i = 0; i < 500; i++)
{
    using var db = new Ctx(conn, log: s => { if (s.Contains("Compiling query expression")) compiles++; });
    var value = "S" + i;
    db.Orders.Where(o => o.Status == EF.Constant(value)).ToList();
}
```

El resultado fue cero compilaciones adicionales: EF reutiliza su consulta compilada y solo vuelve a generar el texto SQL. El costo de `EF.Constant` hoy está por completo en el lado de la base de datos, un plan por cada cadena SQL distinta.

## EF.Parameter: forzar un parámetro

```csharp
// EF Core 11.0.0-rc.1
db.Orders.Where(o => o.Status == EF.Parameter("Pending"));
// DECLARE @p nvarchar(4000) = N'Pending';
// WHERE [o].[Status] = @p
```

Envolver un literal escrito a mano rara vez es útil por sí solo. Donde `EF.Parameter` gana su lugar es en la construcción dinámica de consultas. Cuando construyes un predicado con `System.Linq.Expressions`, lo natural es escribir `Expression.Constant(value)`, y EF lo trata exactamente igual que un literal en el código fuente:

```csharp
// EF Core 11.0.0-rc.1, .NET 11 RC 1
static Expression<Func<T, bool>> Eq<T>(string property, string value, bool wrap)
{
    var p = Expression.Parameter(typeof(T), "e");
    Expression v = Expression.Constant(value);
    if (wrap)
        v = Expression.Call(typeof(EF), nameof(EF.Parameter), [typeof(string)], v);
    return Expression.Lambda<Func<T, bool>>(
        Expression.Equal(Expression.Property(p, property), v), p);
}

db.Orders.Where(Eq<Order>("Status", "Shipped", wrap: false));
// WHERE [o].[Status] = N'Shipped'

db.Orders.Where(Eq<Order>("Status", "Shipped", wrap: true));
// DECLARE @p nvarchar(4000) = N'Shipped';
// WHERE [o].[Status] = @p
```

A diferencia de `EF.Constant`, un `Expression.Constant` crudo forma parte del árbol que EF usa como clave de caché, así que cada valor distinto es un fallo de caché y una compilación completa. Aquí es donde aparece el costo medible. Mismo arnés que antes, 500 valores distintos, un proceso por variante, tras el calentamiento:

| Variante (EF Core 11 RC 1, SQLite en memoria, M4) | Compilaciones de EF | Tiempo para 500 consultas |
| --- | --- | --- |
| Variable capturada (por defecto) | 0 | 186-292 ms |
| `EF.Constant(variable)` | 0 | 188-226 ms |
| `Expression.Constant` crudo en un árbol construido | 500 | 2201-2261 ms |
| `Expression.Constant` envuelto en `EF.Parameter` | 0 | 202-355 ms |

Los rangos corresponden a dos ejecuciones cada uno. La tabla está vacía, así que esto aísla la sobrecarga propia de EF: unos 4 ms de compilación por consulta, antes de que la base de datos haya hecho nada. En SQL Server sumarías además una compilación de plan en la base de datos por cada cadena distinta. Una sola llamada `Expression.Call` a `EF.Parameter` devuelve el árbol dinámico al costo de una consulta LINQ normal.

La otra forma de llegar ahí es capturar el valor en un objeto de cierre y usar `Expression.Property(Expression.Constant(holder), "Value")`, que es lo que hace el compilador de C# con una lambda. Funciona, pero `EF.Parameter` es más corto y hace visible la intención. Cubrí el truco del cierre con más detalle en [cómo escribir predicados LINQ reutilizables que EF Core pueda traducir](/es/2026/08/how-to-write-reusable-linq-predicates-ef-core-can-translate/).

## Colecciones: tres estrategias, tres marcadores

Para un escalar, la elección es binaria. Para una colección usada en `Contains`, EF Core 10 y 11 tienen tres traducciones, y cada método marcador elige una por consulta:

```csharp
// EF Core 11.0.0-rc.1, SQL Server provider
int[] ids = [1, 2, 3, 4, 5, 6, 7, 8];

db.Orders.Where(o => ids.Contains(o.Id));
// DECLARE @ids1 int = 1; ... DECLARE @ids8 int = 8;
// DECLARE @ids9 int = 8; DECLARE @ids10 int = 8;
// WHERE [o].[Id] IN (@ids1, @ids2, ..., @ids10)

db.Orders.Where(o => EF.Constant(ids).Contains(o.Id));
// WHERE [o].[Id] IN (1, 2, 3, 4, 5, 6, 7, 8)

db.Orders.Where(o => EF.Parameter(ids).Contains(o.Id));
// DECLARE @ids nvarchar(4000) = N'[1,2,3,4,5,6,7,8]';
// WHERE [o].[Id] IN (
//     SELECT [i].[value]
//     FROM OPENJSON(@ids) WITH ([value] int '$') AS [i]
// )

db.Orders.Where(o => EF.MultipleParameters(ids).Contains(o.Id));
// same padded IN (@ids1, ..., @ids10) as the default
```

El comportamiento predeterminado desde EF Core 10 es un parámetro escalar por elemento, con relleno para que 8 valores produzcan 10 parámetros (se repite el último valor). Eso mantiene bajo el número de cadenas SQL distintas y a la vez le dice al optimizador aproximadamente cuántos valores hay. `EF.Parameter` sobre una colección te devuelve el comportamiento de EF Core 8 y 9: un único parámetro JSON desempaquetado con `OPENJSON`, una sola cadena SQL para cualquier longitud de lista, pero sin información de cardinalidad para el planificador. `EF.Constant` incrusta los valores, que es el comportamiento de EF Core 7.

El interruptor global es `UseParameterizedCollectionMode`:

```csharp
// EF Core 11.0.0-rc.1
options.UseSqlServer(connectionString,
    o => o.UseParameterizedCollectionMode(ParameterTranslationMode.Constant));
```

Con eso configurado, un simple `ids.Contains(...)` produce `IN (1, 2, ...)`, `EF.MultipleParameters(ids)` devuelve una consulta concreta a los parámetros con relleno, y `EF.Parameter(ids)` la pasa a `OPENJSON`. El modo solo afecta a las colecciones: una variable escalar capturada sigue siendo `@status` en todos los modos. Los métodos de EF Core 9 `TranslateParameterizedCollectionsToConstants()` y `TranslateParameterizedCollectionsToParameters()` se marcaron como `[Obsolete]` en EF Core 10 y ya no están en el código fuente de EF Core 11 RC 1, así que un proyecto que actualiza desde EF 9 tiene que migrar a `UseParameterizedCollectionMode`. La [guía de cambios importantes de EF Core 6 a 11](/es/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) cubre el resto de esa ruta de actualización.

## Problemas que encontré al probar

### El marcador tiene que estar dentro de la lambda

`EF.Constant` y `EF.Parameter` son marcadores, no funciones. Sus cuerpos reales lanzan una excepción. Solo funcionan dentro de un árbol de expresión que EF traduce. Esto compila pero falla en tiempo de ejecución:

```csharp
// EF Core 11.0.0-rc.1
db.Orders.OrderBy(o => o.Id).Take(EF.Constant(10));
// InvalidOperationException: The 'EF.Constant<T>' method may only be used
// within Entity Framework LINQ queries.
```

`Take(int)` recibe un `int` simple, no una `Expression`, así que C# evalúa `EF.Constant(10)` de inmediato, fuera de cualquier consulta. Lo mismo aplica a cualquier argumento de operador que no sea una lambda.

### No en consultas compiladas ni en filtros de consulta

Desde EF Core 9, ambos métodos lanzan excepción dentro de `EF.CompileQuery` y `EF.CompileAsyncQuery`. En EF Core 11 RC 1 el mensaje es más claro que el `InvalidCastException` documentado para EF 9:

```text
InvalidOperationException: 'EF.Constant<T>' is not supported when using compiled queries or query filters.
InvalidOperationException: 'EF.Parameter<T>' is not supported when using compiled queries or query filters.
```

Si necesitas una constante en una ruta crítica, escribe el literal en la lambda de la consulta compilada. Si necesitas planes por valor, una consulta compilada es la herramienta equivocada de todos modos, porque fija una única cadena SQL. La [guía de consultas compiladas](/es/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) explica cuándo valen la pena. El mensaje también descarta los filtros de consulta globales, lo que importa si esperabas incrustar un ID de inquilino en un [filtro de consulta con nombre](/es/2026/07/named-query-filters-vs-a-single-global-query-filter-in-ef-core-11/).

### Los valores incrustados se ocultan en los registros

Antes de EF Core 10, una constante incrustada era visible en el SQL registrado, a diferencia del valor de un parámetro. Desde EF Core 10, EF la oculta. Del registro de EF Core 11 RC 1, con el registro de datos sensibles desactivado:

```text
Executed DbCommand (20ms) [Parameters=[@secret='?' (Size = 17)], ...]
WHERE "o"."Customer" = @secret

Executed DbCommand (0ms) [Parameters=[], ...]
WHERE "o"."Customer" = ?
```

La base de datos sigue recibiendo el literal real. Solo se enmascara la línea del registro. Ese `?` puede resultar confuso la primera vez que [registras el SQL que genera EF Core](/es/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) e intentas pegarlo en SSMS. Activa `EnableSensitiveDataLogging()` en desarrollo para ver el valor.

### El modo de colección no forma parte de la clave de la caché de consultas

Esto me sorprendió. Dos contextos del mismo tipo, uno configurado con `ParameterTranslationMode.Constant` y otro con el valor predeterminado, comparten un proveedor de servicios interno y una caché de consultas compiladas. Quien ejecute primero una forma de consulta determina el SQL para ambos:

```csharp
// EF Core 11.0.0-rc.1 and 10.0.12, same process
using (var a = new Ctx(ParameterTranslationMode.Constant))
    a.Orders.Where(o => ids.Contains(o.Id)).ToQueryString();
// WHERE [o].[Id] IN (1, 2, 3)

using (var b = new Ctx(mode: null))   // default MultipleParameters
    b.Orders.Where(o => ids.Contains(o.Id)).ToQueryString();
// WHERE [o].[Id] IN (1, 2, 3)   <- cached translation from context a
```

El código fuente lo explica. `RelationalOptionsExtension` devuelve `0` desde `GetServiceProviderHashCode()`, y `RelationalCompiledQueryCacheKey` incluye `UseRelationalNulls` y `QuerySplittingBehavior`, pero no el modo de colección. En una aplicación normal con una sola configuración esto nunca importa. Sí importa si registras el mismo `DbContext` dos veces con modos distintos, o si cambias el modo en un fixture de pruebas y esperas que la siguiente prueba vea SQL distinto. En ese caso usa los marcadores por consulta, ya que forman parte del árbol de expresión y por tanto de la clave de caché.

## Cuándo elegir EF.Parameter

- Construyes predicados con `System.Linq.Expressions` (constructores de filtros, búsqueda en cuadrículas, endpoints tipo OData). Envuelve en `EF.Parameter` cada `Expression.Constant` que lleve entrada del usuario, o pagarás una compilación completa por cada valor distinto.
- Quieres la traducción con `OPENJSON` para una consulta cuya longitud de lista varía enormemente (de 1 a 2 000 ids), de modo que la base de datos tenga un plan en lugar de muchas variantes con relleno.
- Has configurado el modo global de colecciones en `Constant` y una consulta necesita volver a salirse de él.

## Cuándo elegir EF.Constant

- Una columna con un puñado de valores y datos muy sesgados, como un estado o un discriminador de tipo, donde los planes medidos difieren según el valor. Confirma antes la regresión con el plan de ejecución real.
- Una lista corta y estable de valores en `Contains` (un conjunto fijo de roles o regiones) donde el optimizador se beneficia de ver los literales, y sabes que el conjunto de combinaciones es pequeño.
- Nunca para IDs, entrada del usuario con variedad ilimitada, ni nada dentro de una consulta compilada.

## La recomendación

Deja en paz los valores predeterminados de EF Core 11 hasta que tengas una medición. La mayor parte del beneficio real viene de `EF.Parameter`, porque un árbol construido dinámicamente con constantes crudas es un error fácil de cometer que cuesta unos 4 ms de compilación de EF por llamada antes de que la base de datos siquiera lo vea. `EF.Constant` es una corrección dirigida para el parameter sniffing en columnas sesgadas de baja cardinalidad. Ya no cuesta una recompilación de EF, pero cada valor distinto sigue costando un plan en la base de datos. Si no estás seguro de cuál de los dos obtuviste, `ToQueryString()` lo muestra de inmediato. Busca `DECLARE @`. Y si una consulta empeoró tras una actualización, revisa [qué cambia el nivel de compatibilidad de SQL Server para EF Core 11](/es/2026/09/sql-server-compatibility-level-150-vs-160-what-changes-for-ef-core-11-queries/) antes de recurrir a cualquiera de los dos marcadores.

## Fuentes

- [What's new in EF Core 9: force or prevent query parameterization](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/whatsnew)
- [What's new in EF Core 10: improved translation for parameterized collections, redacting inlined constants](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew)
- [Breaking changes in EF Core 9: EF.Constant and EF.Parameter in compiled queries](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/breaking-changes)
- [`EF.cs`, `EFExtensions.cs` and `ParameterTranslationMode.cs` in dotnet/efcore](https://github.com/dotnet/efcore/tree/main/src/EFCore)
- [dotnet/efcore#13617, the original plan cache issue for inlined collections](https://github.com/dotnet/efcore/issues/13617)
