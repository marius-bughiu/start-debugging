---
title: "How Dapper's Default nvarchar Parameters Silently Kill Your SQL Server Indexes"
description: "C# strings sent through Dapper default to nvarchar(4000), forcing SQL Server into implicit conversions and full index scans. Here's how to fix it with DbType.AnsiString."
pubDate: 2026-04-14
tags:
  - "C#"
  - ".NET"
  - "SQL Server"
  - "Dapper"
  - "Performance"
---

A query that should take milliseconds is suddenly crawling. The execution plan shows an index scan instead of a seek, and the CPU is working overtime converting every row. The culprit? A C# `string` parameter passed through Dapper against a `varchar` column.

This issue has been making the rounds in the .NET community again, and for good reason: it's subtle, common, and can make queries [up to 268x slower](https://consultwithgriff.com/dapper-nvarchar-implicit-conversion-performance-trap).

## Why nvarchar(4000) Shows Up in Your Execution Plans

When you pass a C# string to Dapper via an anonymous object, Dapper maps it to `nvarchar(4000)` by default:

```csharp
const string sql = "SELECT * FROM Products WHERE ProductCode = @productCode";
var result = await connection.QueryFirstOrDefaultAsync<Product>(
    sql, new { productCode });
```

If `ProductCode` is a `varchar(50)` column, SQL Server sees a type mismatch. Unicode `nvarchar` has higher precedence than `varchar`, so the engine applies `CONVERT_IMPLICIT` on every single row in the index to promote the column value to `nvarchar` before comparing.

That means no index seek. SQL Server scans the entire index, row by row, converting as it goes.

## Spotting the Problem

The tell-tale sign is in the execution plan. Look for a warning on the index scan operator that mentions `CONVERT_IMPLICIT`. You can also check with:

```sql
SELECT * FROM sys.dm_exec_query_stats qs
CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
WHERE st.text LIKE '%ProductCode%'
ORDER BY qs.total_worker_time DESC;
```

High `total_worker_time` on a simple lookup query is a red flag.

## Fixing It with DbType.AnsiString

The fix is straightforward: tell Dapper to use `DbType.AnsiString` instead of the default `DbType.String`:

```csharp
var parameters = new DynamicParameters();
parameters.Add("productCode", productCode, DbType.AnsiString, size: 50);

var result = await connection.QueryFirstOrDefaultAsync<Product>(
    sql, parameters);
```

By specifying `DbType.AnsiString` with the correct column size, the generated parameter matches the column type exactly. SQL Server can now use the index seek it was designed for.

## When This Matters Most

Small tables may hide the problem entirely. The performance cliff appears as data grows: a table with 100,000 rows might show a 176x slowdown, while one with a million rows is even worse. If you're using Dapper with `varchar` columns (which is common in legacy databases and systems that don't need Unicode), audit your parameter types.

A quick project-wide grep for anonymous objects passed to Dapper's `Query` and `Execute` methods is a good starting point. Any `string` parameter targeting a `varchar` column is a candidate for `DbType.AnsiString`.
