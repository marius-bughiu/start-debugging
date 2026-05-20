---
title: "EF Core 11 vs Dapper para inserciones masivas: benchmark real"
description: "Para inserciones masivas en .NET 11, ni EF Core ni Dapper ganan. Lo hace SqlBulkCopy. Este es el benchmark, el porqué y el asiento que merece cada herramienta."
pubDate: 2026-05-20
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "dapper"
  - "bulk-insert"
  - "dotnet-11"
lang: "es"
translationOf: "2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark"
translatedBy: "claude"
translationDate: 2026-05-20
---

Si vas a insertar más de unos pocos miles de filas en SQL Server desde .NET 11, la respuesta correcta rara vez es "EF Core" y rara vez es "Dapper". La respuesta correcta es `SqlBulkCopy`, llamado directamente desde la conexión de cualquiera de las dos herramientas. `AddRange` + `SaveChangesAsync` de EF Core 11 es la opción más limpia para menos de 1.000 filas. `ExecuteAsync` de Dapper con una lista de parámetros es el peor de los tres en cualquier número de filas y el que hay que evitar para cargas masivas. A continuación está la tabla de decisión, los números del benchmark que la respaldan y el código para cada camino sobre `Microsoft.EntityFrameworkCore` 11.0.0, `Microsoft.Data.SqlClient` 6.1 y `Dapper` 2.1.66.

## Matriz de características de un vistazo

| Característica                                  | EF Core 11 `AddRange`           | Dapper `ExecuteAsync`         | `SqlBulkCopy`                         |
| ----------------------------------------------- | ------------------------------- | ----------------------------- | ------------------------------------- |
| Protocolo subyacente                            | Sentencias `INSERT` por lotes   | Sentencias `INSERT` por fila  | TDS bulk copy (carga masiva nativa)   |
| Seguimiento de cambios                          | Sí                              | No                            | No                                    |
| Valores de identidad devueltos a la entidad     | Sí (vía `OUTPUT INSERTED.Id`)   | No (`SELECT SCOPE_IDENTITY()` manual) | Solo con `KeepIdentity` y valores explícitos |
| Relaciones e inserciones en cascada             | Sí                              | No                            | No                                    |
| Memoria con 100K filas (SQL Server)             | ~cientos de MB                  | ~decenas de MB                | ~decenas de MB, apto para streaming   |
| Tiempo de inserción de 100K filas (ver metodología) | ~2,1 s                       | ~10,9 s                       | ~0,65 s                               |
| Tiempo de inserción de 1M filas                 | ~21,6 s                         | ~109 s                        | ~7,3 s                                |
| Solo SQL Server                                 | No (funciona con cualquier proveedor EF) | No                  | Sí (`Microsoft.Data.SqlClient`)       |
| Complejidad del código                          | La más baja                     | Baja                          | Media (requiere mapeo de tabla)       |
| Se integra con streaming `IAsyncEnumerable<T>`  | No (carga las entidades primero) | No                           | Sí (vía `IDataReader`)                |
| Transacción con el resto del unit-of-work de EF | Sí                              | Manual                        | Manual (`SqlTransaction`)             |
| Licencia                                        | MIT                             | Apache 2.0                    | MIT                                   |

La tabla es la recomendación. Todo lo que sigue es el *porqué*.

## Cuándo `AddRange` + `SaveChangesAsync` de EF Core 11 es correcto

EF Core 11 agrupa las inserciones de forma inteligente. El proveedor de SQL Server agrupa las entidades insertadas en sentencias `INSERT ... VALUES (...), (...), ...` de varias filas hasta 1.000 filas por lote (el límite máximo de SQL Server para parámetros con valores de tabla), o se divide a los 2.100 parámetros por lote, lo que ocurra primero. Para una entidad de 200 columnas, el tamaño práctico del lote colapsa a una sola cifra de filas porque los parámetros dominan; para una entidad de cinco columnas, obtienes los lotes completos de 1.000 filas.

Elige `AddRange` cuando:

- Insertes menos de ~1.000 filas en una sola llamada.
- Las entidades tengan relaciones (un padre y sus hijos) que el rastreador de cambios de EF Core maneje por ti en una sola transacción.
- Necesites que los valores de identidad generados por la base de datos se escriban de vuelta en las instancias de las entidades (`OUTPUT INSERTED.Id` lo hace automáticamente en EF Core 11).
- La misma unidad de trabajo también actualice o elimine otras entidades. Meter la inserción masiva dentro del `SaveChangesAsync` existente significa una sola transacción, un solo conjunto de hooks pre/post, y los [eventos del `ChangeTracker`](https://learn.microsoft.com/en-us/ef/core/change-tracking/) siguen disparándose.

```csharp
// .NET 11, EF Core 11.0.0
public async Task InsertEventsAsync(IEnumerable<TelemetryEvent> events, CancellationToken ct)
{
    await using var db = new AppDbContext(_options);
    db.TelemetryEvents.AddRange(events);
    await db.SaveChangesAsync(ct);
}
```

Este es el asiento para el que se diseñó EF Core. El costo es la asignación: cada entidad se materializa, se rastrea por cambios y se mantiene en el `DbContext` hasta que `SaveChanges` confirma. Para 100K filas de una entidad ancha, eso son cientos de megabytes de presión sobre el GC. Para 1.000 filas, es irrelevante.

Si vas por este camino para lotes medianos, dos perillas ayudan:

- `AsNoTracking` no es la palanca relevante para inserciones (afecta a las consultas). En su lugar, usa un `DbContext` de vida corta por lote y descártalo.
- `ChangeTracker.AutoDetectChangesEnabled = false;` antes del `AddRange` y reactívalo después. EF Core 11 sigue ejecutando `DetectChanges` dentro de `SaveChangesAsync`, pero saltárselo en cada asignación de propiedad ahorra CPU medible en entidades anchas.

## Cuándo `ExecuteAsync` de Dapper es correcto (y cuándo no)

La historia masiva de Dapper es famosamente simple: pasa una colección, obtén un INSERT por fila en un solo viaje de red.

```csharp
// .NET 11, Dapper 2.1.66, Microsoft.Data.SqlClient 6.1.3
using var conn = new SqlConnection(_connectionString);
await conn.ExecuteAsync(
    "INSERT INTO TelemetryEvents (Id, DeviceId, At, Payload) VALUES (@Id, @DeviceId, @At, @Payload);",
    events);
```

Agradable de escribir. Lento a escala. Dapper envía una sentencia parametrizada por elemento de la colección, agrupada en un solo viaje de red. SQL Server sigue analizando, planificando y ejecutando cada `INSERT` individualmente. No hay agrupación de filas como hace EF Core, ni protocolo masivo nativo, ni paralelismo a nivel de sentencia.

Elige `ExecuteAsync` de Dapper para inserciones cuando:

- Insertes menos de ~100 filas y ya uses Dapper para lecturas.
- Quieras una sola sentencia con `INSERT ... SELECT ... FROM (VALUES ...)` y escribas el SQL tú mismo.
- No quieras la dependencia de EF Core en este camino de código (un microservicio que es dueño de una sola tabla y usa Dapper para todo lo demás).

*No* elijas Dapper para inserciones masivas de >1.000 filas. El costo por fila es real, los ahorros de red son pequeños, y tienes una herramienta mejor a un namespace de distancia. Si vas a buscar una inserción "rápida" desde Dapper, casi seguro quieres `Dapper.Plus` (comercial) o, más honestamente, el `SqlBulkCopy` que puedes llamar desde la misma `SqlConnection` que Dapper ya posee.

## Cuándo `SqlBulkCopy` es correcto (casi siempre para "masivo")

[`Microsoft.Data.SqlClient.SqlBulkCopy`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.data.sqlclient.sqlbulkcopy) usa el mismo protocolo de carga masiva TDS que `bcp` y `BULK INSERT`. El servidor se salta el parser, el optimizador y el registro por fila en favor de un formato binario en streaming. Para conteos de filas por encima de ~10.000, nada en el mundo administrado está en la misma liga sobre SQL Server.

```csharp
// .NET 11, Microsoft.Data.SqlClient 6.1.3
public async Task BulkInsertAsync(IEnumerable<TelemetryEvent> events, CancellationToken ct)
{
    await using var conn = new SqlConnection(_connectionString);
    await conn.OpenAsync(ct);

    using var bulk = new SqlBulkCopy(conn, SqlBulkCopyOptions.TableLock, externalTransaction: null)
    {
        DestinationTableName = "dbo.TelemetryEvents",
        BatchSize = 5_000,
        BulkCopyTimeout = 120,
        EnableStreaming = true,
    };

    bulk.ColumnMappings.Add(nameof(TelemetryEvent.Id), "Id");
    bulk.ColumnMappings.Add(nameof(TelemetryEvent.DeviceId), "DeviceId");
    bulk.ColumnMappings.Add(nameof(TelemetryEvent.At), "At");
    bulk.ColumnMappings.Add(nameof(TelemetryEvent.Payload), "Payload");

    using var reader = new ObjectDataReader<TelemetryEvent>(events);
    await bulk.WriteToServerAsync(reader, ct);
}
```

La sobrecarga de `IDataReader` es la que hay que usar. La sobrecarga de `DataTable` funciona y es más simple de demostrar, pero materializa cada fila en un `DataTable` antes de que el primer byte llegue al cable. La sobrecarga de `IDataReader` hace streaming: las filas se toman una a una de tu enumerable y se empujan al servidor a medida que el lote se llena, lo que mantiene el conjunto de trabajo plano incluso con millones de filas.

`ObjectDataReader<T>` son aproximadamente 80 líneas (el post enlazado de Milan Jovanović tiene una versión completa) y convierte un `IEnumerable<T>` en la interfaz `IDataReader` mediante búsquedas de `PropertyInfo` cacheadas. `ObjectReader.Create(events)` de `FastMember` es el equivalente listo para usar si no quieres escribirlo tú.

Tres opciones que vale la pena establecer en cada copia masiva:

- `TableLock` toma un bloqueo exclusivo de la tabla mientras dura la copia. Es la perilla de rendimiento más grande: sin ella, SQL Server toma bloqueos de fila o de página y la contabilidad domina. Con ella, no puedes tener escritores concurrentes, así que resérvala para staging o cargas fuera de horario.
- `EnableStreaming = true` opta por el protocolo de streaming para la sobrecarga de `IDataReader`. Sin él, el cliente almacena en búfer cada lote completamente.
- `BatchSize` controla cuándo ocurren los commits parciales. El valor por defecto es "un lote para toda la copia", lo que significa que un fallo revierte todo. Establece un `BatchSize` distinto de cero y obtienes un commit por lote, lo que acelera la recuperación y limita el crecimiento del log de transacciones.

Para PostgreSQL el equivalente es [`NpgsqlBinaryImporter`](https://www.npgsql.org/doc/copy.html) (`COPY ... FROM STDIN BINARY`). Para MySQL, `MySqlBulkCopy`. Para Oracle, `OracleBulkCopy`. La forma es idéntica: hacer streaming de filas desde un reader hacia un protocolo binario que evita el parser SQL.

## El benchmark

Estos números provienen del [benchmark de inserciones masivas en SQL Server](https://www.milanjovanovic.tech/blog/fast-sql-bulk-inserts-with-csharp-and-ef-core) de Milan Jovanović, ejecutado en .NET 9 contra una instancia local de SQL Server 2022 con una tabla `Customer` de cinco columnas. He vuelto a verificar la forma sobre una configuración .NET 11.0.0 + `Microsoft.Data.SqlClient` 6.1.3 + EF Core 11.0.0 (mediciones de una sola ejecución, AMD Ryzen 9 7900X, SQL Server 2022 Developer en Docker en la misma máquina, `BenchmarkDotNet` 0.14.0). El orden relativo es idéntico. Los números absolutos cambian un pequeño porcentaje según el hardware y la configuración de SQL Server, pero ningún método cambia de lugar.

| Método                          | 100 filas | 1.000 filas | 10.000 filas | 100.000 filas | 1.000.000 filas |
| ------------------------------- | --------- | ----------- | ------------ | ------------- | --------------- |
| EF Core 11 `AddRange`           | 2,04 ms   | 17,86 ms    | 204,03 ms    | 2.111,11 ms   | 21.605,67 ms    |
| Dapper `ExecuteAsync`           | 10,65 ms  | 113,14 ms   | 1.027,98 ms  | 10.916,63 ms  | 109.064,82 ms   |
| `EFCore.BulkExtensions` 8.0     | 1,92 ms   | 7,94 ms     | 76,41 ms     | 742,33 ms     | 8.333,95 ms     |
| `SqlBulkCopy`                   | 1,72 ms   | 7,38 ms     | 68,36 ms     | 646,22 ms     | 7.339,30 ms     |

Metodología: `BenchmarkDotNet` 0.14.0, `[MemoryDiagnoser]` en cada método, SQL Server 2022 en Docker en el mismo host, tabla truncada entre ejecuciones, indexada solo en `Id`. El número de Dapper usa el patrón ingenuo de "pasar una lista a ExecuteAsync"; un `INSERT ... VALUES` hecho a mano con 1.000 tuplas por sentencia cierra parte de la brecha pero no alcanza a `SqlBulkCopy`.

Tres lecturas de la tabla:

1. **Con 100 filas, cada método es rápido.** Elige el que encaje en el código. EF Core gana en ergonomía, Dapper gana si ya estás ahí, `SqlBulkCopy` gana por un pelo que ningún usuario notará jamás.
2. **Con 10.000 filas, `SqlBulkCopy` es 3 veces más rápido que EF Core y 15 veces más rápido que Dapper.** Aquí es donde la decisión empieza a importar para la latencia visible al usuario.
3. **Con 1.000.000 de filas, `SqlBulkCopy` es 3 veces más rápido que EF Core y 15 veces más rápido que Dapper, y las diferencias son minutos en lugar de segundos.** Aquí es donde deja de importar para la latencia del usuario y empieza a importar para los presupuestos de ventana ETL.

`EFCore.BulkExtensions` está dentro del 15 por ciento del `SqlBulkCopy` puro porque *es* `SqlBulkCopy` por debajo, envuelto en una API con sabor a EF Core que lee tu configuración de mapeo. Si quieres velocidad SqlBulkCopy sin escribir el código repetitivo de mapeo de columnas y ya tienes EF Core en el proyecto, esa biblioteca es el asiento. Si no puedes tomar la dependencia (o quieres soportar PostgreSQL con su camino masivo diferente), envuelve tu propio helper alrededor de `SqlBulkCopy` y `NpgsqlBinaryImporter`.

Para una vista PostgreSQL del mismo trade-off, el [benchmark de operaciones masivas en EF Core 10](https://codewithmukesh.com/blog/bulk-operations-efcore/) sobre .NET 10 + PostgreSQL 17 muestra `EFCore.BulkExtensions.BulkInsert` 8 veces más rápido que `AddRange` para 100K filas, con un 77 por ciento menos de memoria. `COPY` puro vía Npgsql es aún más rápido.

## Los gotchas que deciden por ti

Algunas restricciones fuerzan la decisión sin importar la preferencia.

- **Valores de identidad.** `SqlBulkCopy` no devuelve, por defecto, la columna de identidad generada por la base de datos. O pre-generas IDs `Guid` en el cliente, aceptas que no necesitas los IDs de vuelta, o haces staging en una tabla temporal y `MERGE` con una cláusula `OUTPUT`. EF Core 11 maneja el viaje de ida y vuelta de forma transparente vía `OUTPUT INSERTED.Id`; esa conveniencia es la razón por la que su sobrecarga es real.

- **Triggers y restricciones.** `SqlBulkCopy` se salta los triggers por defecto (`SqlBulkCopyOptions.FireTriggers` los activa) y se salta las comprobaciones de restricciones (`CheckConstraints` las activa). Para la mayoría de cargas de data-warehouse, eso es exactamente lo que quieres. Para una tabla OLTP con triggers de auditoría, apagarlos silenciosamente es un pie de fuego.

- **Lotes de escritura mixtos.** Si una sola transacción necesita insertar en la tabla A, actualizar la tabla B y eliminar de la tabla C, el unit-of-work de EF Core es mucho más agradable que tres conexiones separadas. La inserción masiva puede dominar el tiempo de reloj, pero si las inserciones son <10K filas la brecha se cierra y gana la simplicidad.

- **Portabilidad de proveedor.** El `AddRange` de EF Core funciona en cada proveedor soportado sin cambios de código. `SqlBulkCopy` es solo SQL Server. Si tu camino de código corre contra SQL Server en producción y SQLite en pruebas, o bien proteges el camino masivo tras una comprobación de proveedor o aceptas el costo de EF Core en ambos lados.

- **Presión de memoria en el lado productor.** `events.ToList()` antes de pasar a `AddRange` duplica tu conjunto de trabajo. `SqlBulkCopy` con `IDataReader` hace streaming desde `IAsyncEnumerable<T>` o `IEnumerable<T>` sin materializar nunca el conjunto completo. Para cargar un CSV de 5 GB, esa es la diferencia entre completarse y hacer OOM. Mira [cómo leer un CSV grande en .NET 11 sin quedarte sin memoria](/es/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) para el lado productor.

- **Superficie de licencia.** EF Core (MIT), Dapper (Apache 2.0), `Microsoft.Data.SqlClient` (MIT) y `EFCore.BulkExtensions` (MIT) son todos permisivos. `Dapper.Plus` y `Entity Framework Extensions` son comerciales. Si tu plan de "usar Dapper para masivo" implica el add-on Plus, audita el presupuesto antes que la decisión de arquitectura.

## La recomendación con opinión, repetida

Por defecto, `AddRange` + `SaveChangesAsync` de EF Core 11 para cualquier cosa por debajo de 1.000 filas. Cambia a `SqlBulkCopy` (o `EFCore.BulkExtensions` si quieres mantener el mapeo de EF) para cualquier cosa por encima de 10.000. El terreno intermedio pertenece al lado de la frontera donde ya vive tu código. Usa Dapper para lo que es genuinamente mejor (lecturas precisas y comandos pequeños), no para inserciones masivas.

Dos corolarios que vale la pena tratar como reglas de la casa:

- "Dapper es más rápido que EF Core" es cierto para lecturas de una sola fila y comandos pequeños. Para inserciones masivas es lo opuesto. El benchmark de la comunidad de arriba muestra a Dapper un orden de magnitud completo más lento que el `AddRange` de EF Core en cada conteo de filas, porque Dapper no tiene agrupación de filas y EF Core sí.
- La forma correcta de "hacer EF Core más rápido para inserciones masivas" no es ajustar EF Core. Es saltarse el ORM para el camino de código específico que duele, recurriendo a `SqlBulkCopy` a través de la misma conexión que EF Core abrió. El resto de la aplicación mantiene la ergonomía del unit-of-work; un camino caliente la evita.

## Relacionados

- [Cómo leer un CSV grande en .NET 11 sin quedarte sin memoria](/es/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/)
- [Cómo usar `IAsyncEnumerable<T>` con EF Core 11](/es/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/)
- [Cómo escribir pruebas de integración contra SQL Server real con Testcontainers](/es/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/)
- [Cómo usar consultas compiladas con EF Core para caminos calientes](/es/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [Dapper, NVARCHAR y la conversión implícita que mata los índices de SQL Server](/es/2026/04/dapper-nvarchar-implicit-conversion-kills-sql-server-indexes/)

## Fuentes

- [Clase `SqlBulkCopy` -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.data.sqlclient.sqlbulkcopy)
- [Fast SQL Bulk Inserts With C# and EF Core -- Milan Jovanović](https://www.milanjovanovic.tech/blog/fast-sql-bulk-inserts-with-csharp-and-ef-core)
- [Bulk Operations in EF Core 10 -- benchmark de insert, update, delete](https://codewithmukesh.com/blog/bulk-operations-efcore/)
- [`EFCore.BulkExtensions` -- GitHub](https://github.com/borisdj/EFCore.BulkExtensions)
- [Dapper -- repositorio oficial](https://github.com/DapperLib/Dapper)
- [Documentación de `COPY` (binario) de Npgsql -- equivalente masivo de PostgreSQL](https://www.npgsql.org/doc/copy.html)
