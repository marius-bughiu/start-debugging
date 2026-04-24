---
title: "Cómo los parámetros nvarchar default de Dapper matan silenciosamente tus índices de SQL Server"
description: "Los strings de C# enviados vía Dapper hacen default a nvarchar(4000), forzando a SQL Server a implicit conversions y scans completos de índice. Acá cómo arreglarlo con DbType.AnsiString."
pubDate: 2026-04-14
tags:
  - "csharp"
  - "dotnet"
  - "sql-server"
  - "dapper"
  - "performance"
lang: "es"
translationOf: "2026/04/dapper-nvarchar-implicit-conversion-kills-sql-server-indexes"
translatedBy: "claude"
translationDate: 2026-04-24
---

Una query que debería tomar milisegundos de repente se arrastra. El execution plan muestra un index scan en lugar de un seek, y la CPU trabaja extra convirtiendo cada row. ¿El culpable? Un parámetro `string` de C# pasado a través de Dapper contra una columna `varchar`.

Este issue ha estado dando vueltas en la comunidad .NET de nuevo, y con razón: es sutil, común, y puede hacer queries [hasta 268x más lentas](https://consultwithgriff.com/dapper-nvarchar-implicit-conversion-performance-trap).

## Por qué aparece nvarchar(4000) en tus execution plans

Cuando pasas un string de C# a Dapper vía un anonymous object, Dapper lo mapea a `nvarchar(4000)` por default:

```csharp
const string sql = "SELECT * FROM Products WHERE ProductCode = @productCode";
var result = await connection.QueryFirstOrDefaultAsync<Product>(
    sql, new { productCode });
```

Si `ProductCode` es una columna `varchar(50)`, SQL Server ve un mismatch de tipo. El `nvarchar` Unicode tiene mayor precedence que `varchar`, así que el engine aplica `CONVERT_IMPLICIT` en cada row del índice para promover el valor de la columna a `nvarchar` antes de comparar.

Eso significa sin index seek. SQL Server escanea todo el índice, row por row, convirtiendo a medida que va.

## Detectando el problema

El signo revelador está en el execution plan. Busca una advertencia en el operador de index scan que mencione `CONVERT_IMPLICIT`. También puedes chequear con:

```sql
SELECT * FROM sys.dm_exec_query_stats qs
CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
WHERE st.text LIKE '%ProductCode%'
ORDER BY qs.total_worker_time DESC;
```

`total_worker_time` alto en una query simple de lookup es una bandera roja.

## Arreglándolo con DbType.AnsiString

El fix es directo: dile a Dapper que use `DbType.AnsiString` en lugar del default `DbType.String`:

```csharp
var parameters = new DynamicParameters();
parameters.Add("productCode", productCode, DbType.AnsiString, size: 50);

var result = await connection.QueryFirstOrDefaultAsync<Product>(
    sql, parameters);
```

Al especificar `DbType.AnsiString` con el size correcto de columna, el parámetro generado matchea el tipo de columna exactamente. SQL Server ahora puede usar el index seek para el que fue diseñado.

## Cuándo importa más

Tablas pequeñas pueden ocultar el problema enteramente. El acantilado de performance aparece a medida que los datos crecen: una tabla con 100.000 rows podría mostrar un slowdown de 176x, mientras que una con un millón de rows es incluso peor. Si estás usando Dapper con columnas `varchar` (que es común en databases legacy y sistemas que no necesitan Unicode), audita tus tipos de parámetros.

Un grep rápido project-wide por anonymous objects pasados a los métodos `Query` y `Execute` de Dapper es un buen punto de partida. Cualquier parámetro `string` apuntando a una columna `varchar` es candidato para `DbType.AnsiString`.
