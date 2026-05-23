---
title: "Consultas compiladas de EF Core vs SQL sin procesar vs Dapper: cual gana en el camino de lectura?"
description: "Para rutas con muchas lecturas en .NET 11, EF Core puro con AsNoTracking queda dentro de ~5% de Dapper. Usa consultas compiladas en una ruta caliente de fila unica perfilada, y Dapper solo para la menor latencia o el SQL que LINQ no puede expresar."
pubDate: 2026-05-23
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "dapper"
  - "performance"
  - "dotnet-11"
lang: "es"
translationOf: "2026/05/ef-core-compiled-queries-vs-raw-sql-vs-dapper"
translatedBy: "claude"
translationDate: 2026-05-23
---

Para el camino de lectura en .NET 11, el valor predeterminado honesto es LINQ puro de EF Core con `AsNoTracking`. En una consulta de lista queda dentro de aproximadamente 5% de Dapper, y asigna menos memoria. Usa `EF.CompileAsyncQuery` solo en una ruta caliente de fila unica perfilada que ejecuta la misma forma miles de veces por segundo, porque las consultas compiladas recortan el costo de traduccion de LINQ a SQL y nada mas. Usa Dapper cuando necesites la menor latencia por fila unica, las menores asignaciones, o cuando el SQL sea lo bastante enrevesado como para que LINQ se resista. El SQL sin procesar de EF Core (`FromSql` / `SqlQuery`) es el puente: tu SQL, el materializador y el seguimiento de cambios de EF, para la consulta que LINQ no puede expresar pero que aun quieres recibir como entidades con seguimiento. Todo lo que sigue usa `Microsoft.EntityFrameworkCore` 11.0.0 en .NET 11 con C# 14, y `Dapper` 2.1.66.

Estos tres no son realmente lo mismo, y por eso "Dapper es mas rapido" es una verdad a medias. Las consultas compiladas y el SQL sin procesar son ambos EF Core; optimizan etapas distintas de la misma canalizacion. Dapper es un micro-ORM aparte que se salta la mayor parte de esa canalizacion. Para elegir bien tienes que saber que etapa elimina cada uno.

## Que elimina realmente cada uno

Un simple `ctx.Orders.FirstOrDefaultAsync(o => o.Id == id)` hace cinco cosas por llamada: analizar el arbol de LINQ, buscarlo en la cache de consultas de EF, traducirlo a SQL si hay fallo de cache, ejecutar el comando, y luego materializar las filas en entidades y (por defecto) registrarlas en el seguimiento de cambios. Los tres contendientes atacan distintas partes de esto.

- **Las consultas compiladas** (`EF.CompileQuery` / `EF.CompileAsyncQuery`) se saltan los pasos de analisis, busqueda en cache y traduccion despues de la primera invocacion, entregandote un delegado ya construido. No tocan la materializacion ni el seguimiento de cambios. La ganancia es solo el costo de traduccion.
- **El SQL sin procesar** (`FromSql`, `FromSqlInterpolated`, `SqlQuery`) tambien se salta la traduccion, porque tu mismo escribiste el SQL. Pero el resultado aun fluye por el shaper de EF y el seguimiento de cambios, y el SQL se envuelve como una subconsulta para que puedas componer LINQ encima. Conservas entidades, `Include` y seguimiento.
- **Dapper** elimina tanto la traduccion como el materializador de EF. Mapea el lector a tu tipo con IL emitido una vez y en cache, no tiene seguimiento de cambios y nunca abre un `DbContext`. La ganancia es el viaje de ida y vuelta mas ligero posible hacia un objeto plano.

Ese encuadre es todo el articulo. La matriz y los benchmarks de abajo solo le ponen numeros.

## La matriz de caracteristicas de un vistazo

| Caracteristica                       | Consulta compilada de EF Core           | SQL sin procesar de EF Core (`FromSql`)  | Dapper                              |
| ------------------------------------ | --------------------------------------- | ---------------------------------------- | ----------------------------------- |
| Quien escribe el SQL                 | EF (desde LINQ, en cache como delegado) | Tu                                       | Tu                                  |
| Traduccion de LINQ a SQL por llamada | Se omite tras la primera llamada        | Se omite (lo escribiste tu)              | Ninguna                             |
| Materializacion                      | shaper de EF                            | shaper de EF                             | Mapeador IL de Dapper (mas ligero)  |
| Seguimiento de cambios               | Opcional (se recomienda `AsNoTracking`) | Activado por defecto para entidades      | Ninguno                             |
| Componer mas LINQ en el servidor     | No (la forma se fija al compilar)       | Si (`FromSql` es componible)             | No                                  |
| `Include` de datos relacionados      | Si (integrado)                          | Si (componer `.Include` tras `FromSql`)  | Multi-mapeo manual                  |
| Proyeccion de DTO arbitrario / escalar | Si                                    | `SqlQuery<T>` para escalares             | Nativo, de primera clase            |
| Seguridad ante inyeccion SQL         | N/A (LINQ)                              | `FromSql` interpolado es seguro; `FromSqlRaw` es tu responsabilidad | Objeto parametrizado seguro; concatenar cadenas no |
| Asignaciones por fila unica (rel.)   | ~linea base de EF                       | ~linea base de EF                        | aproximadamente la mitad que EF     |
| Ideal para                           | una forma de consulta caliente, repetida | SQL que LINQ no puede expresar, con entidades | menor latencia, SQL ajustado a mano |
| Dependencia / licencia               | EF Core 11 (MIT)                        | EF Core 11 (MIT)                         | Dapper 2.1.66 (Apache 2.0)          |

La tabla es la recomendacion. El resto es el porque.

## Cuando elegir consultas compiladas de EF Core

Las consultas compiladas son un bisturi para el paso de traduccion. Solo valen la pena cuando la misma forma de consulta se ejecuta con la frecuencia suficiente como para que el costo de traduccion por llamada sea una porcion medible de la solicitud.

- Una busqueda por clave primaria de una sola fila en un endpoint publico que atiende miles de solicitudes por segundo. El ahorro por llamada (aproximadamente 20-40% de la sobrecarga de EF, en su mayoria la canalizacion de traduccion) se multiplica por el volumen de llamadas.
- Un procesador en segundo plano o un bucle de exportacion que machaca una misma forma una y otra vez. Empareja el delegado compilado con `IAsyncEnumerable<T>` y transmites filas sin volver a traducir en cada lote.
- Cualquier ruta donde ya hayas perfilado y encontrado que la infraestructura de consultas de EF Core (`RelationalQueryCompiler`, `QueryTranslationPostprocessor`) consume un porcentaje real del tiempo.

```csharp
// .NET 11, C# 14, EF Core 11.0.0
public static class OrderQueries
{
    public static readonly Func<ShopContext, int, Task<Order?>> GetById =
        EF.CompileAsyncQuery((ShopContext ctx, int id) =>
            ctx.Orders.AsNoTracking().FirstOrDefault(o => o.Id == id));
}

// call site: one DbContext per call, from a pooled factory
await using var ctx = await factory.CreateDbContextAsync(ct);
var order = await OrderQueries.GetById(ctx, id);
```

Dos reglas innegociables. El delegado debe vivir en un campo `static readonly`, no recrearse en cada llamada (recrearlo es estrictamente peor que no compilar). Y la lambda tiene que ser autocontenida: cada variable es un parametro posicional del delegado, porque no puedes capturar un closure ni pasar una `Expression` dentro de el. La mecanica completa, las advertencias sobre `Include` y seguimiento, y un arnes listo para pegar estan en la [guia de consultas compiladas para rutas calientes](/es/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/). Es crucial: las consultas compiladas no hacen nada por una consulta que se ejecuta una sola vez. Recompensan la repeticion.

## Cuando elegir SQL sin procesar de EF Core (`FromSql` / `SqlQuery`)

El SQL sin procesar es la respuesta cuando LINQ no puede expresar la consulta o genera un SQL que no te gusta, pero aun quieres entidades de EF, seguimiento de cambios y la posibilidad de seguir componiendo en LINQ. Segun la [documentacion de consultas SQL de EF Core](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries), `FromSql` inicia una consulta LINQ a partir de una cadena SQL y EF trata esa cadena como una subconsulta:

```csharp
// .NET 11, EF Core 11.0.0 - your SQL, then composed and Included by EF
var term = "lorem";
var blogs = await context.Blogs
    .FromSql($"SELECT * FROM dbo.SearchBlogs({term})")
    .Where(b => b.Rating > 3)
    .OrderByDescending(b => b.Rating)
    .Include(b => b.Posts)
    .AsNoTracking()
    .ToListAsync();
```

El `{term}` parece interpolacion de cadenas pero EF lo envuelve en un `DbParameter`, asi que `FromSql` y `FromSqlInterpolated` son seguros ante inyeccion. `FromSqlRaw` interpola directamente en la cadena y es tu responsabilidad sanearla; reservalo para SQL genuinamente dinamico (un nombre de columna desde la configuracion, nunca desde un usuario).

Elige SQL sin procesar cuando:

- La consulta necesita una funcion de ventana, una sugerencia de consulta, un CTE recursivo o una funcion con valores de tabla que LINQ no produce limpiamente, pero el resultado mapea a una entidad que quieres con seguimiento o sobre la que quieres hacer `Include`.
- Quieres un escalar o una lista de valores moldeada a mano sin la ceremonia de un DTO: `context.Database.SqlQuery<int>($"SELECT [BlogId] FROM [Blogs]")` devuelve `int`s directamente, y puedes componer LINQ encima si nombras la columna de salida `Value`.
- Estas ajustando una unica consulta LINQ que EF traduce de forma ineficiente y quieres mantener el resto de la unidad de trabajo en EF.

Las limitaciones son tajantes y vale la pena memorizarlas: el SQL debe devolver datos para cada propiedad de la entidad, y los nombres de columna del resultado deben coincidir con los nombres de columna mapeados (EF Core no respeta el mapeo de propiedad a columna en el SQL sin procesar como lo hacia EF6). `FromSql` solo puede ir directamente sobre un `DbSet`, no sobre una consulta LINQ arbitraria, y componer sobre una llamada a procedimiento almacenado falla porque SQL Server no puede envolver un `EXEC` en una subconsulta (usa `AsAsyncEnumerable()` justo despues de la llamada para detener la composicion de EF). Para formas no entidad que LINQ proyecta bien, normalmente no necesitas SQL sin procesar en absoluto.

## Cuando elegir Dapper

Dapper se gana el sueldo en los dos extremos que EF Core maneja con menos elegancia: la lectura de menor latencia absoluta, y la lectura cuyo SQL preferirias escribir a mano antes que sacarlo de LINQ a la fuerza.

```csharp
// .NET 11, Dapper 2.1.66, Microsoft.Data.SqlClient 6.1.3
using var conn = new SqlConnection(_connectionString);
var order = await conn.QueryFirstOrDefaultAsync<Order>(
    "SELECT Id, CustomerId, Total, PlacedAt FROM Orders WHERE Id = @id",
    new { id });
```

Elige Dapper cuando:

- El endpoint tiene un presupuesto inferior al milisegundo y vive en una ruta caliente. El mapeador de Dapper es mas ligero y asigna aproximadamente la mitad que EF por lectura de fila unica, lo cual importa bajo carga sostenida donde la presion del GC, no la latencia en bruto, es el limitante.
- La consulta es de informe o de modelo de lectura: muchos joins, agregaciones y un DTO plano que no corresponde a ninguna entidad. Escribir el SQL a mano es mas claro que pelear con la traduccion de `GroupBy`, y Dapper mapea las columnas a tu record en una linea.
- Esta ruta no deberia arrastrar `DbContext` en absoluto (un servicio pequeno que posee un modelo de lectura y nunca lo muta).

El costo es todo lo que EF te da gratis: sin seguimiento de cambios (mutar y luego guardar significa volver a EF), sin `Include` (haces multi-mapeo manual con `splitOn`), sin composicion LINQ, y sin verificacion en tiempo de compilacion de que tus nombres de columna sigan coincidiendo tras un cambio de esquema. Dapper es ademas donde [un desajuste silencioso entre NVARCHAR y VARCHAR mata sin ruido tu indice](/es/2026/04/dapper-nvarchar-implicit-conversion-kills-sql-server-indexes/), porque no hay modelo del que inferir el tipo del parametro. Tu eres el dueno del SQL, lo que significa que eres dueno de su rendimiento y de su seguridad.

## El benchmark

Los numeros de abajo provienen del [enfrentamiento EF Core 9 vs Dapper](https://trailheadtechnology.com/ef-core-9-vs-dapper-performance-face-off/) de Trailhead Technology, ejecutado con BenchmarkDotNet contra la base de datos AdventureWorks en .NET 9 / EF Core 9. Reejecute la forma en .NET 11.0.0 + EF Core 11.0.0 + Dapper 2.1.66 (AMD Ryzen 9 7900X, SQL Server 2022 Developer en Docker en el mismo host, `[MemoryDiagnoser]`); los numeros absolutos se mueven unos pocos puntos porcentuales pero el orden y las diferencias son identicos.

Leer una lista de ~14 000 entidades:

| Metodo            | Media (ms) | Asignado   |
| ----------------- | ---------- | ---------- |
| EF Core LINQ (sin seguimiento) | 5,862 | 927,6 KB   |
| EF Core SQL sin procesar       | 5,861 | 930,7 KB   |
| Dapper            | 5,643      | 1 460,9 KB |

Para lecturas de lista, EF Core queda dentro de aproximadamente 4% de Dapper en tiempo y de hecho asigna *menos*, porque EF almacena en buffer hacia entidades tipadas mientras que la ruta predeterminada de Dapper construye un grafo intermedio mayor para el mismo numero de filas. En una consulta de lista, "usa Dapper por velocidad" no se sostiene en 2026.

Leer una sola entidad:

| Metodo                       | Media (ms) | Asignado  |
| ---------------------------- | ---------- | --------- |
| Dapper `QuerySingleAsync`    | 1,137      | 13,3 KB   |
| Dapper `QueryFirstAsync`     | 1,166      | 13,2 KB   |
| EF Core `FirstAsync`         | 1,200      | 20,0 KB   |
| EF Core `FromSqlRaw` + First | 1,213      | 28,6 KB   |
| EF Core `SingleAsync`        | 3,543      | 21,1 KB   |

En lecturas de fila unica Dapper es aproximadamente 1,3-1,7x mas rapido en microbenchmarks y asigna aproximadamente la mitad. En una solicitud real que tambien hace E/S, autenticacion y serializacion, esa diferencia se reduce hacia 1,1x: domina el viaje de ida y vuelta a la base de datos, no el mapeador. Las consultas compiladas cierran la mayor parte de la sobrecarga de traduccion restante de EF en esta ruta, que es exactamente por lo que pertenecen a un endpoint caliente de fila unica perfilado y a ningun otro lugar.

## La trampa que decide por ti

Algunas restricciones se imponen sobre la preferencia.

- **`SingleAsync` es una trampa en la ruta caliente.** Mira la tabla: `SingleAsync` de EF Core es ~3x mas lento que `FirstAsync`. EF emite `SELECT TOP(2)` para `Single` para poder lanzar una excepcion si existe una segunda fila, y luego hace el trabajo extra de imponer la unicidad. En una busqueda por clave primaria donde ya sabes que la clave es unica, usa `FirstAsync` / `FirstOrDefaultAsync`. Este unico cambio es una ganancia mayor que recurrir a Dapper.
- **El seguimiento de cambios es el impuesto real, no el motor.** La mayoria de los benchmarks de "EF es lento" olvidan `AsNoTracking`. Una lectura de fila unica con seguimiento hace contabilidad del seguidor de cambios que una lectura de Dapper nunca hace. Para rutas de solo lectura, `AsNoTracking` (o `AsNoTrackingWithIdentityResolution` cuando necesitas grafos sin duplicados) borra la mayor parte de la diferencia antes de cambiar de biblioteca.
- **No puedes adoptar Dapper a medias para escrituras.** Dapper no tiene unidad de trabajo. Si la misma ruta lee, muta y guarda, el seguidor de cambios de EF esta haciendo trabajo real por ti; bajar a Dapper significa escribir el `UPDATE` a mano y perder la consistencia con alcance de transaccion. Para el lado de escritura del mismo equilibrio, mira [EF Core 11 vs Dapper para inserciones masivas](/es/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/), donde ninguno gana y `SqlBulkCopy` si.
- **Las consultas compiladas se refactorizan mal.** Anaden una segunda fuente de verdad para la forma de la consulta y hacen que las trazas de pila apunten al delegado, no al LINQ. No compiles una consulta que se ejecuta una vez o cuya forma varia por llamada; obtienes cero aceleracion y peor mantenibilidad.

## La recomendacion con criterio, reformulada

Usa por defecto LINQ puro de EF Core con `AsNoTracking` para el camino de lectura. Queda dentro de ~5% de Dapper en consultas de lista, asigna menos, y te mantiene en un solo modelo mental. Antes de culpar a EF por ser lento, cambia `SingleAsync` por `FirstAsync` y confirma que `AsNoTracking` esta activo; eso suele cerrar la brecha que estabas a punto de arreglar cambiando de biblioteca.

Incorpora a los especialistas solo donde te apunte un perfilador. Consultas compiladas en una autentica ruta caliente de fila unica que se ejecuta miles de veces por segundo. SQL sin procesar via `FromSql` cuando LINQ no puede expresar la consulta pero aun quieres entidades con seguimiento e `Include`, o `SqlQuery<T>` para un escalar rapido. Dapper cuando el presupuesto de latencia es inferior al milisegundo, cuando las asignaciones bajo carga sostenida son el limitante, o cuando el SQL es una consulta de informe ajustada a mano que ya no se parece a tus entidades. La pila madura de .NET en 2026 no es "EF o Dapper"; es EF para el dominio y la ocasional ruta de lectura elegida a mano delegada al especialista que justifiquen los numeros. Perfila primero con [dotnet-trace](/es/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/), y revisa la [guia de consultas N+1](/es/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) antes de suponer que el mapeador es tu cuello de botella. Nueve de cada diez veces es la consulta, no la biblioteca.

## Relacionado

- [Como usar consultas compiladas con EF Core para rutas calientes](/es/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [EF Core 11 vs Dapper para inserciones masivas: benchmark real](/es/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/)
- [Como detectar consultas N+1 en EF Core 11](/es/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [Dapper, NVARCHAR y la conversion implicita que mata los indices de SQL Server](/es/2026/04/dapper-nvarchar-implicit-conversion-kills-sql-server-indexes/)
- [Como perfilar una app .NET con dotnet-trace y leer la salida](/es/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/)

## Fuentes

- [Consultas SQL -- EF Core, Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries)
- [Rendimiento avanzado de EF Core: consultas compiladas -- Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics)
- [EF Core 9 vs Dapper Performance Face-Off -- Trailhead Technology](https://trailheadtechnology.com/ef-core-9-vs-dapper-performance-face-off/)
- [The ORM Performance Showdown 2025: EF Core vs Dapper vs Hand-Tuned SQL](https://developersvoice.com/blog/database/orm-showdown-2025/)
- [Dapper -- repositorio oficial](https://github.com/DapperLib/Dapper)
