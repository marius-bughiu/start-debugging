---
title: "Correção: Invalid column name 'Value' ao usar SqlQueryRaw<T> para um resultado escalar no EF Core"
description: "O EF Core envolve um SqlQuery<T> escalar em uma subconsulta e seleciona uma coluna chamada Value assim que você adiciona First, Where, Max ou Single. Dê o alias AS Value à coluna do seu SQL, ou materialize antes."
pubDate: 2026-10-06
template: error-page
tags:
  - "errors"
  - "efcore"
  - "ef-core-11"
  - "dotnet"
lang: "pt-br"
translationOf: "2026/10/fix-invalid-column-name-value-when-using-sqlqueryraw-for-a-scalar-in-ef-core"
translatedBy: "claude"
translationDate: 2026-10-06
---

`Database.SqlQueryRaw<int>("SELECT COUNT(*) FROM Blogs").First()` falha com `Invalid column name 'Value'` porque qualquer operador LINQ encadeado em um `SqlQuery<T>` ou `SqlQueryRaw<T>` escalar faz o EF Core envolver o seu SQL em uma subconsulta e selecionar dela uma coluna chamada literalmente `Value`. Corrija dando um alias à única coluna de saída: `SELECT COUNT(*) AS Value FROM Blogs`, com aspas como `AS "Value"` no PostgreSQL. Se você não pode alterar o SQL, materialize primeiro (`ToListAsync()`, depois escolha a linha em memória). Tudo abaixo foi medido no EF Core 10.0.12 e no EF Core 11.0.0-rc.1, que se comportam de forma idêntica aqui, e a regra existe desde que o `SqlQuery<T>` foi lançado no EF Core 7.0.

## O erro em contexto

No SQL Server a exceção é uma `SqlException`, número 207:

```text
Microsoft.Data.SqlClient.SqlException (0x80131904): Invalid column name 'Value'.
```

O mesmo bug aparece de forma diferente em cada provider, e é por isso que é difícil de pesquisar. As mensagens do SQLite e do PostgreSQL foram copiadas das execuções de laboratório abaixo; as linhas do SQL Server são os erros do engine para o SQL que o EF envia (nenhuma instância do SQL Server estava disponível para este post):

```text
SQLite:      SQLite Error 1: 'no such column: s.Value'.
PostgreSQL:  42703: column s.Value does not exist
SQL Server:  Invalid column name 'Value'.                       (error 207)
SQL Server:  No column name was specified for column 1 of 's'.  (error 8155, unaliased COUNT(*), MAX(...) etc.)
```

A variante do SQL Server que você recebe depende do seu SQL. Se a consulta retorna uma coluna com nome, como `SELECT Id FROM Blogs`, o SQL Server reclama que `Value` não existe. Se ela retorna uma expressão sem nome algum, como `COUNT(*)`, o SQL Server falha antes, porque uma tabela derivada não pode conter uma coluna sem nome. Ambos têm a mesma correção.

## Por que o EF Core pede uma coluna chamada Value

O `SqlQuery<T>` para um `T` escalar é traduzido em `RelationalQueryableMethodTranslatingExpressionVisitor`. No código-fonte do EF Core 11 RC 1, o tradutor cria uma `FromSqlExpression` para o seu SQL com o alias de tabela `s` (gerado a partir de `"sql"`) e uma coluna de projeção cujo nome vem de uma constante fixa no código:

```csharp
// EF Core 11.0.0-rc.1, src/EFCore.Relational/Query/RelationalQueryableMethodTranslatingExpressionVisitor.cs
private const string SqlQuerySingleColumnAlias = "Value";
```

Não existe API para mudar esse nome. Enquanto nada é composto por cima, o EF envia o seu SQL sem alterações e lê a primeira coluna por posição, então o nome da coluna não importa e `ToList()` funciona. No momento em que você adiciona um operador que precisa referenciar a coluna no SQL, o EF gera um `SELECT [s].[Value] FROM (<your SQL>) AS [s]` externo e o banco de dados procura uma coluna que não está lá.

A [documentação de SQL bruto do EF Core](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries#querying-scalar-non-entity-types) declara a regra em uma frase: ao compor LINQ sobre uma consulta SQL escalar, "you must name the output column `Value`". A armadilha é que métodos como `First()` e `Single()` não parecem composição, mas são.

## Repro mínimo

O console app a seguir reproduz o problema com SQLite em memória, então não precisa de servidor. As instruções do SQL Server citadas mais adiante foram capturadas do provider do SQL Server com um interceptor que suprime a conexão e registra `DbCommand.CommandText`, então são exatamente as instruções que o EF envia; nenhuma instância do SQL Server foi envolvida.

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128 (identical on .NET 10 + EF Core 10.0.12)
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;

var conn = new SqliteConnection("Data Source=:memory:");
conn.Open();
var db = new Db(new DbContextOptionsBuilder<Db>().UseSqlite(conn).Options);
db.Database.EnsureCreated();
db.Blogs.AddRange(new Blog { Name = "a", Views = 5 }, new Blog { Name = "b", Views = 50 });
db.SaveChanges();

// Works: no composition, EF reads column 0 by position.
var all = db.Database.SqlQueryRaw<int>("SELECT COUNT(*) FROM Blogs").ToList();

// Throws: SQLite Error 1: 'no such column: s.Value'.
var count = db.Database.SqlQueryRaw<int>("SELECT COUNT(*) FROM Blogs").First();

class Blog { public int Id { get; set; } public string Name { get; set; } = ""; public int Views { get; set; } }
class Db(DbContextOptions<Db> o) : DbContext(o) { public DbSet<Blog> Blogs => Set<Blog>(); }
```

Para a chamada `First()`, o provider do SQL Server envia:

```sql
-- EF Core 11.0.0-rc.1, SQL Server provider, captured CommandText
SELECT TOP(1) [s].[Value]
FROM (
    SELECT COUNT(*) FROM Blogs
) AS [s]
```

## Quais operadores disparam o erro

Executei cada operador contra um `SELECT Id FROM Blogs` sem alias nas duas versões do EF. A tabela é o resultado no SQLite; a coluna de SQL mostra o que o provider do SQL Server gerou para a mesma consulta.

| Chamada em `SqlQueryRaw<int>(...)` | SQL externo gerado (SQL Server) | Resultado sem alias |
|---|---|---|
| `ToList()` / `ToListAsync()` | nenhum, o seu SQL é enviado como está | funciona |
| `AsEnumerable().First()` | nenhum, `First` roda em memória | funciona |
| `First()` / `FirstOrDefault()` | `SELECT TOP(1) [s].[Value] FROM (...) AS [s]` | falha |
| `Single()` / `SingleOrDefault()` | `SELECT TOP(2) [s].[Value] FROM (...) AS [s]` | falha |
| `Where(x => x > 1)` | `SELECT [s].[Value] ... WHERE [s].[Value] > 1` | falha |
| `Max()` / `Min()` | `SELECT MAX([s].[Value]) FROM (...) AS [s]` | falha |
| `Count()` | `SELECT COUNT(*) FROM (...) AS [s]` | funciona |
| `Any()` | `SELECT CASE WHEN EXISTS (SELECT 1 FROM (...) AS [s]) ...` | funciona |

`Count()` e `Any()` também envolvem o seu SQL, mas nunca referenciam a coluna, então escapam. É assim que o código sobrevive à revisão: o caminho com `Count()` é testado, aí alguém o troca por `FirstOrDefault()` e a produção começa a lançar exceções.

## Correção 1: dê o alias AS Value à coluna de saída

Esta é a correção que a documentação recomenda, e ela mantém a composição no servidor:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var count = await db.Database
    .SqlQueryRaw<int>("SELECT COUNT(*) AS Value FROM Blogs")
    .FirstAsync();

var bigIds = await db.Database
    .SqlQuery<int>($"SELECT Id AS Value FROM Blogs")
    .Where(id => id > 1)
    .OrderBy(id => id)
    .ToListAsync();
```

Agora as duas rodam, e a segunda é filtrada e ordenada no banco de dados:

```sql
-- EF Core 11.0.0-rc.1, SQL Server provider
SELECT [s].[Value]
FROM (
    SELECT Id AS Value FROM Blogs
) AS [s]
WHERE [s].[Value] > 1
ORDER BY [s].[Value]
```

Uma pequena diferença entre as versões apareceu aqui: o EF Core 10.0.12 emite `ORDER BY CAST([s].[Value] AS int)` para a mesma consulta, e o EF Core 11 RC 1 elimina o cast redundante. Isso não muda o resultado, mas muda o texto do plano se você compara consultas durante uma atualização de versão.

O alias funciona da mesma forma para todo tipo escalar que o EF consegue mapear, incluindo `string`, `DateTime`, `Guid` e tipos anuláveis como `int?`. Para uma agregação que pode retornar `NULL`, mapeie para o tipo anulável. Em uma tabela vazia, `SqlQueryRaw<int>("SELECT MAX(Views) AS Value FROM Blogs")` lança `Nullable object must have a value.`, com ou sem composição, enquanto a versão com `int?` retorna `null`:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
int? maxViews = await db.Database
    .SqlQueryRaw<int?>("SELECT MAX(Views) AS Value FROM Blogs")
    .FirstOrDefaultAsync();
```

## Correção 2: use aspas no alias no PostgreSQL

O PostgreSQL converte identificadores sem aspas para minúsculas, e o Npgsql coloca aspas na coluna que gera. Então `AS Value` cria uma coluna chamada `value`, o EF pede `s."Value"` e você recebe o mesmo erro mesmo tendo seguido a documentação. Isto foi medido no Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3 e 11.0.0-rc.1.1 contra o PostgreSQL 18:

```csharp
// .NET 11 RC 1, Npgsql.EntityFrameworkCore.PostgreSQL 11.0.0-rc.1.1
// Throws: 42703: column s.Value does not exist
await db.Database.SqlQueryRaw<int>("SELECT count(*)::int AS Value FROM \"Blogs\"").FirstAsync();

// Works
await db.Database.SqlQueryRaw<int>("SELECT count(*)::int AS \"Value\" FROM \"Blogs\"").FirstAsync();
```

Em um raw string literal do C# 11+, as aspas continuam legíveis:

```csharp
// .NET 11 RC 1, C# 14
var count = await db.Database.SqlQuery<int>($"""
    SELECT count(*)::int AS "Value" FROM "Blogs"
    """).FirstAsync();
```

O SQLite compara nomes de coluna sem diferenciar maiúsculas de minúsculas, então `AS value` funciona lá, e o SQL Server segue a collation do banco de dados, que por padrão não diferencia maiúsculas de minúsculas. Escreva `"Value"` com V maiúsculo em todo lugar e a consulta continua portável.

## Correção 3: materialize primeiro quando você não pode mexer no SQL

Se o SQL vem de uma stored procedure, de uma view que não é sua ou de uma constante compartilhada, traga as linhas para o cliente e termine lá:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var count = (await db.Database
        .SqlQueryRaw<int>("SELECT COUNT(*) FROM Blogs")
        .ToListAsync())
    .Single();

// or, synchronously
var count2 = db.Database.SqlQueryRaw<int>("SELECT COUNT(*) FROM Blogs").AsEnumerable().Single();
```

Nenhuma das duas gera uma subconsulta, então o nome da coluna é irrelevante. Faça isso apenas para consultas que retornam um punhado de linhas. `AsEnumerable().Where(...)` transmite o resultado inteiro para o cliente antes de filtrar, que é exatamente o que compor no servidor deveria evitar.

Esta também é a única opção para uma stored procedure, porque um `EXEC` não pode ser usado como subconsulta de forma alguma. Compor sobre ele lança um erro diferente antes de qualquer coisa chegar ao servidor; cobri esse caso no guia sobre [chamar uma stored procedure e mapear seus resultados](/pt-br/2026/08/how-to-call-a-stored-procedure-and-map-its-results-in-ef-core-11/).

## Pegadinhas e erros parecidos

**`ORDER BY` dentro do seu SQL mais `First()` no SQL Server.** Mesmo com o alias, `SqlQueryRaw<int>("SELECT Views AS Value FROM Blogs ORDER BY Views DESC").First()` gera `SELECT TOP(1) [s].[Value] FROM (SELECT Views AS Value FROM Blogs ORDER BY Views DESC) AS [s]`. O SQLite aceita isso, mas o SQL Server rejeita com o erro 1033 ("The ORDER BY clause is invalid in views, inline functions, derived tables, subqueries, and common table expressions, unless TOP, OFFSET or FOR XML is also specified"). Mesmo que o SQL Server aceitasse, um `ORDER BY` dentro de uma tabela derivada não garante a ordem da consulta externa. Mova a ordenação para o LINQ: `SqlQueryRaw<int>("SELECT Views AS Value FROM Blogs").OrderByDescending(v => v).First()`.

**Um DTO em vez de um escalar.** Para `SqlQuery<BlogStat>` (tipos não mapeados, EF Core 8+), o EF não usa `Value`; ele referencia uma coluna por propriedade, pelo nome da propriedade. `SELECT Name AS BlogName, Views FROM Blogs` composto com `.Where(b => b.Views > 10)` falha com `no such column: b.Name` no SQLite (o alias agora é `b`, vindo do nome do tipo), e a mesma consulta sem composição falha com `The required column 'Name' was not present in the results of a 'FromSql' operation`. A correção é dar a cada coluna um alias com o nome da sua propriedade. A segunda mensagem é o assunto de um guia próprio: [the required column was not present in the results of a FromSql operation](/pt-br/2026/07/fix-the-required-column-was-not-present-in-the-results-of-a-fromsql-operation-in-ef-core-11/).

**`FromSql` em um `DbSet`.** Consultas de entidade nunca usam `Value`. Se você encontrar `Invalid column name` ali, o nome na mensagem é uma das suas colunas mapeadas, e a causa é uma coluna ausente na sua lista de `SELECT`.

**Sua própria coluna se chama literalmente `Value`.** Nesse caso `SELECT Value FROM Settings` compõe sem problemas e sem alias, e é por isso que alguns exemplos na internet parecem funcionar sem ele. Renomeie a coluna da tabela e esses exemplos quebram.

**Vendo o SQL real.** `ToQueryString()` no `SqlQueryRaw<int>(...)` sem composição imprime apenas o seu próprio SQL, e você não pode chamá-lo depois de `First()`. Em vez disso, registre os comandos executados em log (`LogTo` com `RelationalEventId.CommandExecuted`, ou um interceptor), como descrito no post sobre [registrar em log o SQL que o EF Core 11 gera](/pt-br/2026/07/how-to-log-the-sql-that-ef-core-11-generates/). O `SELECT [s].[Value]` externo fica óbvio quando você o vê.

## Quando SQL bruto é a ferramenta errada

A maior parte do SQL escalar bruto que vejo em revisões de código é um `COUNT`, `MAX` ou `EXISTS` que o LINQ expressa diretamente: `db.Blogs.CountAsync()`, `db.Blogs.MaxAsync(b => (int?)b.Views)`, `db.Blogs.AnyAsync(...)`. Esses nunca encontram este erro e são traduzidos pelo provider com as aspas corretas para cada banco de dados. Reserve o `SqlQuery<T>` para consultas que o LINQ não consegue expressar, e se você está decidindo entre SQL bruto, consultas compiladas e Dapper para um caminho crítico, a [comparação de consultas compiladas do EF Core vs SQL bruto vs Dapper](/pt-br/2026/05/ef-core-compiled-queries-vs-raw-sql-vs-dapper/) tem os números. Se você recorreu ao SQL bruto porque uma consulta LINQ falhou na tradução, o guia para [corrigir "The LINQ expression could not be translated"](/pt-br/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/) geralmente leva você de volta ao LINQ.

## Relacionados

- [Correção: The required column 'X' was not present in the results of a 'FromSql' operation no EF Core 11](/pt-br/2026/07/fix-the-required-column-was-not-present-in-the-results-of-a-fromsql-operation-in-ef-core-11/)
- [Como chamar uma stored procedure e mapear seus resultados no EF Core 11](/pt-br/2026/08/how-to-call-a-stored-procedure-and-map-its-results-in-ef-core-11/)
- [Como registrar em log o SQL que o EF Core 11 gera](/pt-br/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [Consultas compiladas do EF Core vs SQL bruto vs Dapper](/pt-br/2026/05/ef-core-compiled-queries-vs-raw-sql-vs-dapper/)
- [Correção: The LINQ expression could not be translated no EF Core 11](/pt-br/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)

## Fontes

- [SQL Queries: querying scalar (non-entity) types](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries#querying-scalar-non-entity-types), documentação do EF Core
- [SQL Queries: composing with LINQ](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries#composing-with-linq), incluindo a restrição de `ORDER BY` do SQL Server
- [`RelationalQueryableMethodTranslatingExpressionVisitor.cs` at v11.0.0-rc.1.26425.128](https://github.com/dotnet/efcore/blob/v11.0.0-rc.1.26425.128/src/EFCore.Relational/Query/RelationalQueryableMethodTranslatingExpressionVisitor.cs), dotnet/efcore
- [`RelationalDatabaseFacadeExtensions.SqlQueryRaw<TResult>`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.relationaldatabasefacadeextensions.sqlqueryraw), referência da API
- [Database engine errors](https://learn.microsoft.com/en-us/sql/relational-databases/errors-events/database-engine-events-and-errors), documentação do SQL Server (207, 1033, 8155)
