---
title: "Como os parâmetros nvarchar padrão do Dapper matam silenciosamente seus índices SQL Server"
description: "Strings de C# enviadas via Dapper viram nvarchar(4000) por padrão, forçando o SQL Server a conversões implícitas e scans completos de índice. Aqui como consertar com DbType.AnsiString."
pubDate: 2026-04-14
tags:
  - "csharp"
  - "dotnet"
  - "sql-server"
  - "dapper"
  - "performance"
lang: "pt-br"
translationOf: "2026/04/dapper-nvarchar-implicit-conversion-kills-sql-server-indexes"
translatedBy: "claude"
translationDate: 2026-04-24
---

Uma query que deveria levar milissegundos de repente está se arrastando. O execution plan mostra um index scan em vez de um seek, e a CPU está trabalhando horas extras convertendo cada row. O culpado? Um parâmetro `string` de C# passado via Dapper contra uma coluna `varchar`.

Esse issue tem voltado a circular na comunidade .NET, e com razão: é sutil, comum, e pode deixar queries [até 268x mais lentas](https://consultwithgriff.com/dapper-nvarchar-implicit-conversion-performance-trap).

## Por que nvarchar(4000) aparece nos seus execution plans

Quando você passa uma string C# pro Dapper via um anonymous object, Dapper mapeia pra `nvarchar(4000)` por padrão:

```csharp
const string sql = "SELECT * FROM Products WHERE ProductCode = @productCode";
var result = await connection.QueryFirstOrDefaultAsync<Product>(
    sql, new { productCode });
```

Se `ProductCode` é uma coluna `varchar(50)`, SQL Server vê um mismatch de tipo. `nvarchar` Unicode tem precedência maior que `varchar`, então o engine aplica `CONVERT_IMPLICIT` em cada linha do índice pra promover o valor da coluna pra `nvarchar` antes de comparar.

Isso significa sem index seek. SQL Server escaneia o índice inteiro, row por row, convertendo à medida que anda.

## Identificando o problema

O sinal revelador está no execution plan. Procure um aviso no operador de index scan que mencione `CONVERT_IMPLICIT`. Também dá pra checar com:

```sql
SELECT * FROM sys.dm_exec_query_stats qs
CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
WHERE st.text LIKE '%ProductCode%'
ORDER BY qs.total_worker_time DESC;
```

`total_worker_time` alto numa query simples de lookup é bandeira vermelha.

## Consertando com DbType.AnsiString

O fix é direto: diga pro Dapper usar `DbType.AnsiString` em vez do padrão `DbType.String`:

```csharp
var parameters = new DynamicParameters();
parameters.Add("productCode", productCode, DbType.AnsiString, size: 50);

var result = await connection.QueryFirstOrDefaultAsync<Product>(
    sql, parameters);
```

Especificando `DbType.AnsiString` com o size correto da coluna, o parâmetro gerado bate exatamente com o tipo da coluna. SQL Server agora pode usar o index seek pro qual foi desenhado.

## Quando isso mais importa

Tabelas pequenas podem esconder o problema completamente. O penhasco de performance aparece conforme os dados crescem: uma tabela com 100.000 rows pode mostrar um slowdown de 176x, enquanto uma com um milhão de rows é ainda pior. Se você está usando Dapper com colunas `varchar` (o que é comum em bancos legados e sistemas que não precisam de Unicode), audite seus tipos de parâmetro.

Um grep rápido pelo projeto em anonymous objects passados pros métodos `Query` e `Execute` do Dapper é um bom ponto de partida. Qualquer parâmetro `string` mirando uma coluna `varchar` é candidato pra `DbType.AnsiString`.
