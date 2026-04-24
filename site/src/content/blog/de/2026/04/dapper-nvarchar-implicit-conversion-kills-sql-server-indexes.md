---
title: "Wie Dappers standardmäßige nvarchar-Parameter Ihre SQL-Server-Indizes still killen"
description: "C#-Strings, die durch Dapper gesendet werden, fallen standardmäßig auf nvarchar(4000), was SQL Server zu impliziten Konvertierungen und vollen Index-Scans zwingt. Hier, wie man es mit DbType.AnsiString behebt."
pubDate: 2026-04-14
tags:
  - "csharp"
  - "dotnet"
  - "sql-server"
  - "dapper"
  - "performance"
lang: "de"
translationOf: "2026/04/dapper-nvarchar-implicit-conversion-kills-sql-server-indexes"
translatedBy: "claude"
translationDate: 2026-04-24
---

Eine Query, die Millisekunden dauern sollte, kriecht plötzlich. Der Execution Plan zeigt einen Index-Scan statt eines Seeks, und die CPU arbeitet Überstunden beim Konvertieren jeder Zeile. Der Übeltäter? Ein C#-`string`-Parameter, der durch Dapper gegen eine `varchar`-Spalte übergeben wird.

Dieses Problem macht in der .NET-Community wieder die Runde, und aus gutem Grund: Es ist subtil, verbreitet und kann Queries [bis zu 268x langsamer](https://consultwithgriff.com/dapper-nvarchar-implicit-conversion-performance-trap) machen.

## Warum nvarchar(4000) in Ihren Execution Plans auftaucht

Wenn Sie einen C#-String über ein Anonymous Object an Dapper übergeben, mappt Dapper ihn standardmäßig auf `nvarchar(4000)`:

```csharp
const string sql = "SELECT * FROM Products WHERE ProductCode = @productCode";
var result = await connection.QueryFirstOrDefaultAsync<Product>(
    sql, new { productCode });
```

Wenn `ProductCode` eine `varchar(50)`-Spalte ist, sieht SQL Server einen Typen-Mismatch. Unicode-`nvarchar` hat höhere Präzedenz als `varchar`, also wendet die Engine `CONVERT_IMPLICIT` auf jede einzelne Zeile im Index an, um den Spaltenwert vor dem Vergleich zu `nvarchar` zu promoten.

Das heißt kein Index-Seek. SQL Server scannt den gesamten Index Zeile für Zeile und konvertiert dabei.

## Das Problem erkennen

Das verräterische Zeichen liegt im Execution Plan. Suchen Sie nach einer Warnung am Index-Scan-Operator, die `CONVERT_IMPLICIT` erwähnt. Sie können auch prüfen mit:

```sql
SELECT * FROM sys.dm_exec_query_stats qs
CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
WHERE st.text LIKE '%ProductCode%'
ORDER BY qs.total_worker_time DESC;
```

Hoher `total_worker_time` bei einer einfachen Lookup-Query ist ein rotes Tuch.

## Beheben mit DbType.AnsiString

Der Fix ist schlicht: Sagen Sie Dapper, `DbType.AnsiString` statt des Defaults `DbType.String` zu nutzen:

```csharp
var parameters = new DynamicParameters();
parameters.Add("productCode", productCode, DbType.AnsiString, size: 50);

var result = await connection.QueryFirstOrDefaultAsync<Product>(
    sql, parameters);
```

Indem man `DbType.AnsiString` mit der korrekten Spaltengröße spezifiziert, matcht der generierte Parameter den Spaltentyp exakt. SQL Server kann jetzt den Index-Seek nutzen, für den er gebaut wurde.

## Wann das am meisten zählt

Kleine Tabellen können das Problem komplett verbergen. Die Performance-Klippe erscheint, wenn Daten wachsen: Eine Tabelle mit 100.000 Zeilen könnte ein 176x-Slowdown zeigen, während eine mit einer Million Zeilen noch schlechter ist. Wenn Sie Dapper mit `varchar`-Spalten verwenden (was bei Legacy-Datenbanken und Systemen, die kein Unicode brauchen, üblich ist), auditieren Sie Ihre Parameter-Typen.

Ein schneller projektweiter Grep nach Anonymous Objects, die an Dappers `Query`- und `Execute`-Methoden übergeben werden, ist ein guter Ausgangspunkt. Jeder `string`-Parameter, der auf eine `varchar`-Spalte zielt, ist ein Kandidat für `DbType.AnsiString`.
