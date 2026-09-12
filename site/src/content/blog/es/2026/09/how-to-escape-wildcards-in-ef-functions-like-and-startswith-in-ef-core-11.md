---
title: "Cómo escapar los comodines % y _ en consultas con EF.Functions.Like y StartsWith en EF Core 11"
description: "StartsWith, EndsWith y Contains ya escapan % y _ por ti en EF Core 11, pero EF.Functions.Like no lo hace. Aquí tienes el SQL que genera EF, un helper de escape reutilizable y la sobrecarga con escapeCharacter que hace que funcione en SQL Server, SQLite y PostgreSQL."
pubDate: 2026-09-12
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "dotnet-11"
  - "sql-server"
  - "linq"
lang: "es"
translationOf: "2026/09/how-to-escape-wildcards-in-ef-functions-like-and-startswith-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-09-12
---

**Respuesta corta:** en EF Core 11 no necesitas escapar nada para `string.StartsWith`, `EndsWith` ni `Contains`. EF reescribe el valor de búsqueda en un patrón como `50\%%` y agrega `ESCAPE N'\'` por su cuenta. `EF.Functions.Like` es distinto: pasa tu patrón tal cual, así que un usuario que escribe `50%` o `a_b` obtiene coincidencias con comodines. Escapa tú mismo la parte que proporciona el usuario (primero la barra invertida, luego `%`, `_` y `[` en SQL Server) y llama a la sobrecarga de tres argumentos, `EF.Functions.Like(p.Name, pattern, "\\")`. Si escapas pero omites ese tercer argumento, SQL Server y SQLite tratan tus barras invertidas como caracteres literales y la consulta no devuelve nada, sin avisar.

Todo lo que sigue se midió en .NET 11 RC 1 (SDK `11.0.100-rc.1.26425.128`) con `Microsoft.EntityFrameworkCore.SqlServer` y `Microsoft.EntityFrameworkCore.Sqlite` `11.0.0-rc.1.26425.128`. La salida de SQL Server proviene de `ToQueryString()`. Las consultas de SQLite se ejecutaron realmente contra una base de datos en memoria, así que las listas de filas son resultados reales.

## Por qué un signo de porcentaje en un cuadro de búsqueda devuelve las filas equivocadas

`LIKE` de SQL tiene su propio pequeño lenguaje de patrones. En SQL Server, [la referencia de `LIKE`](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/like-transact-sql) define cuatro comodines: `%` (cualquier secuencia de caracteres), `_` (cualquier carácter individual), `[abc]` (un conjunto o rango de caracteres) y `[^abc]` (un conjunto negado). SQLite y PostgreSQL solo tienen `%` y `_`. Cualquiera de esos caracteres dentro de un término de búsqueda cambia el significado de la consulta.

Una búsqueda de productos que arma su patrón concatenando cadenas muestra el problema de inmediato:

```csharp
// .NET 11, EF Core 11.0.0-rc.1, SQLite in-memory
var term = "50%";   // what the user typed
var rows = await db.Products
    .Where(p => EF.Functions.Like(p.Name, "%" + term + "%"))
    .Select(p => p.Name)
    .ToListAsync();
```

Con las filas `50% off sale`, `500 widgets`, `done 50%` y `done 500` en la tabla, esa consulta devuelve **las cuatro**. El patrón es `%50%%`, que significa "contiene 50", y el signo de porcentaje que escribió el usuario desaparece. Un guion bajo hace lo mismo: buscar `a_b` con `$"%{term}%"` coincidió tanto con `a_b adapter` como con `axb adapter`. En SQL Server, un `[` en el término agrega un tercer comodín: `[x]` es una clase de caracteres que coincide con el carácter individual `x`, así que una búsqueda de `[x]` se convierte en `%[x]%` y encuentra todos los nombres que contienen una `x`.

Esto no es inyección SQL. El valor se sigue enviando como parámetro (`DECLARE @p nvarchar(4000) = N'%50%%'`), así que nadie puede salirse de la cadena. El problema es que el patrón significa algo distinto de lo que pidió el usuario, y nada da error cuando eso ocurre.

## Lo que EF Core 11 ya escapa por ti

Antes de escribir un helper de escape, comprueba si lo necesitas. Los métodos de cadena de LINQ normales ya se manejan por ti. Esto es lo que EF Core 11 RC 1 genera en SQL Server cuando el valor de búsqueda es una variable capturada:

```csharp
// .NET 11, EF Core 11.0.0-rc.1, Microsoft.EntityFrameworkCore.SqlServer
var term = "50%";
var q = db.Products.Where(p => p.Name.StartsWith(term));
Console.WriteLine(q.ToQueryString());
```

```sql
DECLARE @term_startswith nvarchar(4000) = N'50\%%';

SELECT [p].[Id], [p].[Name], [p].[Sku]
FROM [Products] AS [p]
WHERE [p].[Name] LIKE @term_startswith ESCAPE N'\'
```

EF evaluó la variable en el cliente, la escapó, le añadió el `%` y envió el resultado como un nuevo parámetro llamado `@term_startswith`. `EndsWith` te da `N'%50\%'` en `@term_endswith`, y `Contains` te da `N'%a\_b%'` en `@under_contains`. Una constante como `StartsWith("50%")` se escapa de la misma forma y se inserta en línea como `LIKE N'50\%%' ESCAPE N'\'`.

El escape vive en `SqlServerSqlTranslatingExpressionVisitor`. En el [tag `v11.0.0-rc.1.26425.128`](https://github.com/dotnet/efcore/blob/v11.0.0-rc.1.26425.128/src/EFCore.SqlServer/Query/Internal/SqlServerSqlTranslatingExpressionVisitor.cs), el conjunto de caracteres especiales ocupa una sola línea:

```csharp
// EF Core 11.0.0-rc.1, SqlServerSqlTranslatingExpressionVisitor.cs
private static bool IsLikeWildChar(char c)
    => c is '%' or '_' or '['; // See https://docs.microsoft.com/en-us/sql/t-sql/language-elements/like-transact-sql
```

`EscapeLikePattern` antepone una barra invertida a cada uno de esos caracteres y a cualquier barra invertida que ya esté en el valor. El proveedor de SQLite tiene el mismo código, salvo que su `IsLikeWildChar` solo incluye `%` o `_`, porque SQLite no tiene clases con corchetes.

Dos detalles de los proveedores pueden sorprenderte:

- **SQLite no usa `LIKE` para `Contains` en absoluto.** Traduce `p.Name.Contains(term)` a `instr("p"."Name", @term) > 0`, así que ahí no hace falta escapar nada. `StartsWith` y `EndsWith` siguen convirtiéndose en `LIKE ... ESCAPE '\'`.
- **Las comparaciones entre columnas se saltan `LIKE`.** `p.Name.StartsWith(p.Sku)` se convierte en `LEFT([p].[Name], LEN([p].[Sku])) = [p].[Sku]` en SQL Server y en `substr(...)` en SQLite. Como el patrón no se conoce hasta que se lee la fila, no hay nada que escapar. Un comentario en el código fuente de EF advierte que esta forma es "less efficient than LIKE (i.e. StartsWith does an index scan instead of seek)".

Si lo único que necesitas es "empieza con", "termina con" o "contiene" sobre la entrada del usuario, usa los métodos de cadena y no sigas. Solo necesitas `EF.Functions.Like` cuando quieres comodines que colocaste tú mismo, como `abc%def`, o el texto del usuario en medio de un patrón más grande.

## Por qué EF.Functions.Like no escapa tu entrada

`EF.Functions.Like(matchExpression, pattern)` es un mapeo directo: la [página de mapeos de funciones de SQL Server](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/functions) lo lista como `@matchExpression LIKE @pattern`, sin ningún paso de escape. Es intencional. Se supone que el patrón contiene comodines, y EF no tiene forma de saber qué caracteres `%` pusiste a propósito y cuáles vinieron del usuario. Una solicitud para que EF escapara automáticamente la entrada de `Like`, [dotnet/efcore#19118](https://github.com/dotnet/efcore/issues/19118), se cerró como no planificada, y EF Core 11 sigue sin incluir un helper de escape público. La sobrecarga que necesitas es la que tiene un tercer argumento:

```csharp
public static bool Like(this DbFunctions _, string? matchExpression, string? pattern, string? escapeCharacter);
```

Esa sobrecarga se traduce a `@matchExpression LIKE @pattern ESCAPE @escapeCharacter`. Así que el trabajo se divide en dos: escapar el texto del usuario en C# y luego decirle a la base de datos qué carácter de escape usaste.

## Cómo escapar la entrada del usuario para EF.Functions.Like paso a paso

1. **Elige un único carácter de escape y úsalo en todas partes.** Una barra invertida coincide con lo que EF usa internamente, así que el SQL que ves en los registros se ve igual para `StartsWith` y para `Like`. Cualquier carácter individual sirve, siempre que el helper de escape y el argumento `escapeCharacter` coincidan.
2. **Escapa primero el carácter de escape.** Si escapas `%` primero y luego duplicas cada barra invertida, duplicas las barras invertidas que acabas de agregar. El orden tiene que ser: carácter de escape, luego comodines.
3. **Escapa `%` y `_` en todos los proveedores, y `[` en SQL Server.** Escapar `[` no hace daño en otros lugares: SQLite y PostgreSQL tratan un carácter ordinario escapado como ese mismo carácter, así que un solo helper funciona en los tres.
4. **Agrega tus propios comodines después de escapar.** Solo el texto del usuario pasa por el helper. Los caracteres `%` que agregas alrededor siguen funcionando como comodines.
5. **Pasa siempre `escapeCharacter`.** Sin él, SQL Server y SQLite no tienen ningún carácter de escape.

Una pequeña clase estática cubre los cinco puntos:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
public static class LikePattern
{
    public const string EscapeCharacter = "\\";

    public static string Escape(string value, char escape = '\\')
    {
        ArgumentNullException.ThrowIfNull(value);
        return value
            .Replace(escape.ToString(), $"{escape}{escape}") // must be first
            .Replace("%", $"{escape}%")
            .Replace("_", $"{escape}_")
            .Replace("[", $"{escape}[");                      // SQL Server bracket classes
    }

    public static string Contains(string value) => $"%{Escape(value)}%";
    public static string StartsWith(string value) => $"{Escape(value)}%";
    public static string EndsWith(string value) => $"%{Escape(value)}";
}
```

Úsala así:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
var term = "a_b";
var rows = await db.Products
    .Where(p => EF.Functions.Like(p.Name, LikePattern.Contains(term), LikePattern.EscapeCharacter))
    .Select(p => p.Name)
    .ToListAsync();
```

En SQLite esto produce `.param set @Contains '%a\_b%'` y `WHERE "p"."Name" LIKE @Contains ESCAPE '\'`, y devuelve solo `a_b adapter`. El mismo código contra SQL Server genera `LIKE @Contains ESCAPE N'\'`. Así salieron el resto de los casos de prueba:

| Término de búsqueda | Filas con `Like` ingenuo (SQLite) | Filas con `Like` escapado (SQLite) |
| --- | --- | --- |
| `50%` | `50% off sale`, `500 widgets`, `done 50%`, `done 500` | `50% off sale`, `done 50%` |
| `a_b` | `a_b adapter`, `axb adapter` | `a_b adapter` |

La versión escapada también devolvió solo `[x] marked` para `[x]` (patrón `%\[x]%`), y solo `C:\temp\logs` para `C:\temp` (patrón `%C:\\temp%`, donde la barra invertida de la ruta se duplicó y no coincidió con `C:tempxlogs`).

Puedes llamar al helper dentro de la lambda. La extracción de parámetros de EF evalúa en el cliente cualquier subárbol que no toque una columna, así que `LikePattern.Contains(term)` se ejecuta una vez en .NET y su resultado se convierte en un parámetro, con el nombre del método (`@Contains`). Nada del helper necesita ser traducible. Si prefieres nombres de parámetros legibles en tus [registros de SQL](/es/2026/07/how-to-log-the-sql-that-ef-core-11-generates/), calcula primero el patrón en una variable local. `var pattern = LikePattern.Contains(term);` aparece como `@pattern`.

## Olvidar escapeCharacter devuelve cero filas sin avisar

Una vez que la gente descubre el problema del escape, un error habitual a continuación es escapar el término y luego llamar a la sobrecarga de dos argumentos:

```csharp
// .NET 11, EF Core 11.0.0-rc.1, SQLite -- WRONG
db.Products.Where(p => EF.Functions.Like(p.Name, "%" + LikePattern.Escape("a_b") + "%"));
```

```sql
WHERE "p"."Name" LIKE '%a\_b%'
```

Sin cláusula `ESCAPE`, la barra invertida es un carácter ordinario, así que la base de datos busca un `a\_b` literal (con `_` todavía como comodín) y no encuentra nada. La [documentación de expresiones de SQLite](https://www.sqlite.org/lang_expr.html#like) deja claro que no hay carácter de escape predeterminado, y la referencia de SQL Server dice que el carácter de escape "no tiene valor predeterminado". La consulta no falla, simplemente devuelve una lista vacía, lo que hace que este bug sea difícil de detectar en una revisión de código.

PostgreSQL es la excepción. Su `LIKE` [trata la barra invertida como carácter de escape predeterminado](https://www.postgresql.org/docs/current/functions-matching.html#FUNCTIONS-LIKE), así que el mismo código funciona ahí por casualidad. Esa es la peor combinación: las pruebas contra un PostgreSQL local pasan, y producción en SQL Server no devuelve nada. Pasar `escapeCharacter` de forma explícita te da el mismo comportamiento en los tres.

## Cómo elegir otro carácter de escape

La barra invertida no es especial para `LIKE`, es solo una convención. Si tus datos están llenos de rutas de Windows o fragmentos de expresiones regulares, elige algo menos común. El helper y el argumento tienen que coincidir:

```csharp
// .NET 11, EF Core 11.0.0-rc.1, SQLite
var term = "!%";
db.Products.Where(p => EF.Functions.Like(p.Name, "%" + LikePattern.Escape(term, '!') + "%", "!"));
// .param set @p '%!!!%%'
// WHERE "p"."Name" LIKE @p ESCAPE '!'
// ROWS: Promo!%
```

`!%` se convirtió en `!!!%`: el `!` literal se duplicó a `!!`, y luego el `%` se convirtió en `!%`. El argumento `escapeCharacter` tiene que ser exactamente un carácter. Pasar `"ab"` se traduce sin problemas, pero falla al ejecutar la consulta, con el `SqliteException: SQLite Error 1: 'ESCAPE expression must be a single character'` de SQLite. SQL Server también lo rechaza, ya que su carácter de escape "debe evaluarse como un único carácter". Conviértelo en una `const`, como hace `LikePattern.EscapeCharacter`, para que nadie pueda pasar un valor incorrecto.

## Trampas que no tienen que ver con el escape

**La distinción entre mayúsculas y minúsculas la decide la base de datos.** En SQL Server, que `LIKE` distinga mayúsculas de minúsculas depende de la intercalación de la columna, y el escape no tiene nada que ver. SQLite tiene una trampa que aparece en la prueba anterior. `StartsWith` se convierte en `LIKE`, que SQLite compara sin distinguir mayúsculas y minúsculas para ASCII, mientras que `Contains` se convierte en `instr`, que sí las distingue. Buscar `50% OFF` con `StartsWith` encontró `50% off sale`, pero `Contains` con el mismo término no encontró nada. Si pruebas contra SQLite e implementas en SQL Server, ten en cuenta que cada método sigue reglas distintas de mayúsculas y minúsculas.

**Un `%` al inicio impide las búsquedas por índice (seek).** Un `LIKE @p ESCAPE N'\'` parametrizado cuyo valor empieza con un prefijo literal puede usar un índice en SQL Server. `%term%` no puede, lo escapes o no. Para requisitos reales de "buscar en cualquier parte del texto" en tablas grandes, considera la búsqueda de texto completo de SQL Server (`EF.Functions.Contains` / `FreeText`) en lugar de cargar más trabajo sobre `LIKE`.

**Reutilizar una variable en dos métodos de cadena.** EF Core 8.0.0 tenía un bug por el que `b.Name.StartsWith(s) || b.Body.Contains(s)` enviaba el patrón de `Contains` a ambas comparaciones ([dotnet/efcore#32432](https://github.com/dotnet/efcore/issues/32432), corregido en 8.0.2). EF Core 11 genera dos parámetros separados, `@term_startswith = N'50\%%'` y `@term_contains = N'%50\%%'`. Si sigues en 8.0.0 u 8.0.1, actualiza el paquete.

**Las sobrecargas con `StringComparison` no se traducen.** `p.Name.StartsWith(term, StringComparison.OrdinalIgnoreCase)` lanza `InvalidOperationException: The LINQ expression ... could not be translated` en ambos proveedores en RC 1. La [guía de fallos de traducción](/es/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/) cubre las reescrituras. Para este caso, la respuesta es la sobrecarga simple más una intercalación que no distinga mayúsculas y minúsculas, o `EF.Functions.Collate`.

**Las consultas compiladas funcionan bien.** Tanto el escape automático de `StartsWith` como el helper `LikePattern` producen parámetros ordinarios, así que funcionan con `EF.CompileAsyncQuery`. El escape ocurre en cada ejecución, no cuando se compila la consulta. Consulta [consultas compiladas para rutas críticas](/es/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) si tienes un endpoint de búsqueda.

**Agentes y herramientas que construyen filtros.** Si una herramienta de LLM o un servidor MCP convierte texto libre en llamadas a `EF.Functions.Like`, como en el [ejemplo de EF Core sobre MCP](/2026/05/how-to-expose-an-ef-core-database-to-an-ai-agent-via-mcp/), trata los argumentos del modelo como cualquier otra entrada del usuario y pásalos por el mismo helper.

## Cómo elegir la herramienta adecuada para cada búsqueda

- Coincidencia exacta de prefijo, sufijo o subcadena sobre la entrada del usuario: `StartsWith` / `EndsWith` / `Contains`. EF Core 11 lo escapa por ti.
- Un patrón con comodines que tú controlas, alrededor del texto del usuario: `EF.Functions.Like(col, LikePattern.Contains(term), LikePattern.EscapeCharacter)`.
- Un patrón que el usuario escribe a propósito: `EF.Functions.Like` de dos argumentos, pero valida la entrada y piensa en qué hace un `[` suelto en SQL Server.
- Búsqueda de texto ordenada por relevancia: búsqueda de texto completo, no `LIKE`.

Antes de publicar, revisa el SQL generado una vez por cada proveedor que uses. `ToQueryString()` ocupa una línea, y habría detectado cada bug de este artículo antes que producción.

### Para leer a continuación

- [Cómo registrar el SQL que genera EF Core 11](/es/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [Solución: "The LINQ expression could not be translated" en EF Core 11](/es/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)
- [Cómo usar consultas compiladas con EF Core para rutas críticas](/es/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [Cómo almacenar un enum como cadena en EF Core 11 con un value converter](/es/2026/08/how-to-store-an-enum-as-a-string-in-ef-core-11-with-a-value-converter/)

### Fuentes

- [LIKE (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/like-transact-sql), Microsoft Learn
- [Mapeos de funciones, proveedor de SQL Server](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/functions), documentación de EF Core
- [`SqlServerSqlTranslatingExpressionVisitor.cs` en v11.0.0-rc.1.26425.128](https://github.com/dotnet/efcore/blob/v11.0.0-rc.1.26425.128/src/EFCore.SqlServer/Query/Internal/SqlServerSqlTranslatingExpressionVisitor.cs), dotnet/efcore
- [dotnet/efcore#19118: Escape provider-specific symbols in user input when using EF.Functions.Like](https://github.com/dotnet/efcore/issues/19118)
- [dotnet/efcore#32432: Incorrect parameter rewriting for StartsWith/EndsWith/Contains](https://github.com/dotnet/efcore/issues/32432)
- [SQLite: el operador LIKE](https://www.sqlite.org/lang_expr.html#like)
- [PostgreSQL: coincidencia de patrones con LIKE](https://www.postgresql.org/docs/current/functions-matching.html#FUNCTIONS-LIKE)
