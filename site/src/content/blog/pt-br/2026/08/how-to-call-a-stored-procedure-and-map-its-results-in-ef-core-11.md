---
title: "Como chamar uma stored procedure e mapear seus resultados no EF Core 11"
description: "Use FromSql em um DbSet quando a procedure retorna linhas completas de uma entidade, Database.SqlQuery<T> quando retorna uma projeção, e ExecuteSql quando não retorna nada. Nunca encadeie um operador LINQ sobre um EXEC, e nunca leia um parâmetro de saída antes de o leitor ter sido liberado."
pubDate: 2026-08-10
tags:
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "dotnet-11"
  - "how-to"
lang: "pt-br"
translationOf: "2026/08/how-to-call-a-stored-procedure-and-map-its-results-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-08-10
---

Resposta curta: o EF Core 11 oferece três pontos de entrada para chamar uma stored procedure, e escolher o errado é o que causa a maior parte da dor de cabeça. Use `FromSql` em um `DbSet<T>` quando a procedure retorna todas as colunas de uma entidade mapeada. Use `Database.SqlQuery<T>` quando ela retorna uma projeção que não é uma entidade, algo que funciona para DTOs arbitrários desde o EF Core 8. Use `Database.ExecuteSql` quando ela não retorna nenhum conjunto de resultados. Duas regras valem para os três casos: você não pode encadear um operador LINQ sobre um `EXEC`, e o `Value` de um parâmetro de saída é null até que o leitor subjacente tenha sido liberado.

Este artigo cobre as três APIs, as exceções exatas que você recebe ao usá-las errado, parâmetros de saída e de retorno, múltiplos conjuntos de resultados, e o comportamento de rastreamento que surpreende as pessoas.

Tudo abaixo foi medido contra o SQL Server 2022 (`mcr.microsoft.com/mssql/server:2022-latest`) usando o EF Core 10.0.10 no SDK do .NET 10.0.201, já que o EF Core 11 exige o runtime do .NET 11, que não está instalado nesta máquina. Isso importa menos que o normal aqui: o EF Core 11 não traz nenhuma mudança em `FromSql`, `SqlQuery` ou `ExecuteSql`, e as [notas de versão do EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) não contêm nenhuma entrada sobre stored procedures. Cada mensagem de exceção e comportamento citado aqui é idêntico no EF Core 8, 9, 10 e 11. Onde uma afirmação vem da documentação em vez de uma medição, eu digo.

O esquema para todos os exemplos:

```sql
-- SQL Server 2022
CREATE TABLE Blogs (
    Id         int NOT NULL IDENTITY PRIMARY KEY,
    Name       nvarchar(200) NOT NULL,
    Rating     int NOT NULL,
    OwnerEmail nvarchar(200) NULL
);

CREATE PROCEDURE dbo.GetTopBlogs @MinRating int AS
BEGIN
    SET NOCOUNT ON;
    SELECT Id, Name, Rating, OwnerEmail FROM Blogs
    WHERE Rating >= @MinRating ORDER BY Rating DESC;
END
```

Repare no `SET NOCOUNT ON`. Sem ele, o SQL Server emite uma mensagem de linhas afetadas antes do conjunto de resultados, que alguns drivers expõem como um conjunto de resultados vazio fantasma. Não custa nada e evita toda uma classe de bugs confusos.

## Quando a procedure retorna linhas de entidade: FromSql

`FromSql` é um método de extensão sobre `DbSet<T>`, e é a chamada certa quando o conjunto de resultados da sua procedure corresponde coluna a coluna a uma entidade mapeada:

```csharp
// .NET 11, C# 14, EF Core 11
var blogs = await context.Blogs
    .FromSql($"EXEC dbo.GetTopBlogs @MinRating = {3}")
    .ToListAsync();
```

Aquele buraco interpolado não é concatenação de strings. `FromSql` recebe um `FormattableString` e transforma cada buraco em um `DbParameter`, então isso é seguro contra injeção de SQL. Você pode ver exatamente o que é enviado chamando `ToQueryString()`:

```text
DECLARE p0 int = 3;

EXEC dbo.GetTopBlogs @MinRating = @p0
```

O EF repassou o SQL literalmente. Não há subconsulta envolvendo, que é justamente a razão de existir da próxima seção.

Os resultados voltam rastreados, exatamente como em uma consulta LINQ. Medi três entidades no rastreador de mudanças após a chamada de uma procedure de três linhas. Adicione `AsNoTracking()` para caminhos somente leitura, e ele funciona bem aqui porque não muda nada no SQL:

```csharp
// .NET 11, C# 14, EF Core 11
var blogs = await context.Blogs
    .FromSql($"EXEC dbo.GetTopBlogs @MinRating = {3}")
    .AsNoTracking()
    .ToListAsync();
```

Para parâmetros nomeados, que importam quando uma procedure tem parâmetros opcionais, envolva o valor em um `SqlParameter` e referencie-o pelo nome:

```csharp
// .NET 11, C# 14, EF Core 11
var minRating = new SqlParameter("min", 3);

var blogs = await context.Blogs
    .FromSql($"EXEC dbo.GetTopBlogs @MinRating = {minRating}")
    .AsNoTracking()
    .ToListAsync();
```

Reutilizar uma única instância de `SqlParameter` em duas execuções consecutivas funciona, ao contrário de uma crença comum herdada do ADO.NET puro, onde um parâmetro só pode pertencer à coleção de um comando. Passei a mesma instância por duas chamadas `FromSqlRaw` seguidas sem nenhuma exceção.

### O conjunto de resultados precisa conter todas as colunas mapeadas

Essa é a falha que as pessoas encontram primeiro. Remova `OwnerEmail` do `SELECT` da procedure e a consulta morre:

```text
InvalidOperationException: The required column 'OwnerEmail' was not present
in the results of a 'FromSql' operation.
```

O EF materializa a entidade completa, então o leitor precisa fornecer todas as propriedades mapeadas, incluindo propriedades de sombra e discriminadores. Os nomes das colunas precisam corresponder aos nomes das colunas mapeadas, não aos nomes das propriedades, o que é uma mudança real de comportamento em relação ao EF6. A ordem não importa e a correspondência não diferencia maiúsculas de minúsculas. Se você não puder alterar a procedure para retornar as colunas faltantes, você não está retornando uma entidade, e deveria usar `SqlQuery<T>` no lugar. Detalhei essa exceção específica com mais profundidade no [guia sobre o erro de coluna faltante no FromSql](/pt-br/2026/07/fix-the-required-column-was-not-present-in-the-results-of-a-fromsql-operation-in-ef-core-11/).

### Você não pode compor LINQ sobre um EXEC

Essa é a segunda coisa em que todo mundo tropeça. O SQL Server não consegue aninhar uma chamada de procedure dentro de uma subconsulta, então no momento em que você adiciona um operador que muda o SQL, o EF desiste:

```csharp
// .NET 11, C# 14, EF Core 11 - throws
var blogs = await context.Blogs
    .FromSql($"EXEC dbo.GetTopBlogs @MinRating = {3}")
    .Where(b => b.Rating > 4)          // composition
    .ToListAsync();
```

```text
InvalidOperationException: 'FromSql' or 'SqlQuery' was called with non-composable
SQL and with a query composing over it. Consider calling 'AsEnumerable' after the
method to perform the composition on the client side.
```

A mesma exceção dispara com `Include`, `OrderBy`, `Skip`/`Take`, e com um `First()` ou `Single()` isolado, já que todos eles acrescentam `TOP` ou `ORDER BY`. Confirmei que `Include` também a lança, então carregamento eager de uma navegação a partir de uma chamada de procedure não está disponível.

A correção é a que a própria mensagem indica. Insira `AsEnumerable()` (ou `AsAsyncEnumerable()`) logo após `FromSql` para traçar uma linha explícita entre o que o banco de dados faz e o que o seu processo faz:

```csharp
// .NET 11, C# 14, EF Core 11
var blogs = context.Blogs
    .FromSql($"EXEC dbo.GetTopBlogs @MinRating = {3}")
    .AsEnumerable()                    // everything after this runs in memory
    .Where(b => b.Rating > 4)
    .ToList();
```

Seja honesto consigo mesmo sobre o custo disso: cada linha que a procedure retorna atravessa a rede e é materializada antes de o `Where` rodar. Se a procedure retorna 200.000 linhas e você fica com quatro, empurre o filtro para dentro da procedure como um parâmetro. `AsEnumerable` é uma correção de exatidão, não de desempenho.

O rastreamento de mudanças continua valendo depois de `AsEnumerable`, o que confunde as pessoas. A fronteira do lado do cliente move apenas os operadores de consulta; a materialização já aconteceu do lado do EF. Medi três entidades rastreadas após `FromSql(...).AsEnumerable().ToList()`. Adicione `AsNoTracking()` antes de `AsEnumerable()` se não quiser isso.

Em contraste, um `SELECT` componível é envolvido e empurrado para baixo, que é o que torna `FromSql` genuinamente útil para SQL que não seja uma procedure:

```csharp
// .NET 11, C# 14, EF Core 11
var q = context.Blogs
    .FromSql($"SELECT * FROM Blogs WHERE Rating >= {3}")
    .Where(b => b.Name.StartsWith("S"));
```

```sql
SELECT [b].[Id], [b].[Name], [b].[OwnerEmail], [b].[Rating]
FROM (
    SELECT * FROM Blogs WHERE Rating >= @p0
) AS [b]
WHERE [b].[Name] LIKE N'S%'
```

É toda a distinção. SQL componível começa com `SELECT` e sobrevive a virar uma subconsulta; `EXEC` não.

## Quando a procedure retorna uma projeção: SqlQuery&lt;T&gt;

A maioria das stored procedures reais não retorna linhas de entidade. Elas retornam um formato de relatório: um join, um `GROUP BY`, algumas colunas calculadas. Para esses casos, `Database.SqlQuery<T>` mapeia o conjunto de resultados para um tipo CLR simples que não está no seu modelo. Essa é a API que a maioria dos artigos sobre o tema ainda descreve como exclusiva para escalares; isso deixou de ser verdade no EF Core 8, que a estendeu para [qualquer tipo CLR mapeável](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/whatsnew#raw-sql-queries-for-unmapped-types).

```sql
CREATE PROCEDURE dbo.GetBlogStats @MinViews int AS
BEGIN
    SET NOCOUNT ON;
    SELECT b.Name AS BlogName, COUNT(p.Id) AS PostCount, SUM(p.Views) AS TotalViews
    FROM Blogs b JOIN Posts p ON p.BlogId = b.Id
    WHERE p.Views >= @MinViews
    GROUP BY b.Name;
END
```

```csharp
// .NET 11, C# 14, EF Core 11
public class BlogStat
{
    public string BlogName { get; set; } = "";
    public int PostCount { get; set; }
    public int TotalViews { get; set; }
}

var stats = await context.Database
    .SqlQuery<BlogStat>($"EXEC dbo.GetBlogStats @MinViews = {10}")
    .ToListAsync();
```

`BlogStat` não precisa de `DbSet`, de entrada no `OnModelCreating` nem de atributos. Coisas que verifiquei sobre como o mapeamento se comporta:

- **A correspondência é por nome de coluna, não por posição.** Retornei as três colunas em ordem embaralhada e cada propriedade caiu no lugar certo.
- **A correspondência não diferencia maiúsculas de minúsculas.** Tanto `blogname` quanto `POSTCOUNT` fizeram o vínculo corretamente.
- **Colunas extras no conjunto de resultados são ignoradas.** Adicionar uma quarta coluna `Surprise` não lançou exceção, apesar de a documentação dizer que o tipo "precisa ter uma propriedade para cada valor no conjunto de resultados". Não se apoie nisso; é comportamento não documentado, não um contrato.
- **Uma coluna faltante é fatal.** Remova `TotalViews` do `SELECT` e você recebe a mesma mensagem `The required column 'TotalViews' was not present in the results of a 'FromSql' operation.` do caminho de entidade.
- **Null em uma propriedade não anulável lança** `SqlNullValueException: Data is Null. This method or property cannot be called on Null values.` Modele a propriedade como anulável, ou use `COALESCE` no SQL.

Use `[Column("...")]` quando o nome de uma coluna do resultado não puder corresponder ao nome da sua propriedade:

```csharp
// .NET 11, C# 14, EF Core 11
public class BlogStat
{
    [Column("blog_name")]
    public string BlogName { get; set; } = "";
    public int PostCount { get; set; }
}
```

A regra de não componibilidade vale aqui de forma idêntica. `SqlQuery<T>(...).Where(...)` sobre um `EXEC` lança exatamente a mesma exceção de não componibilidade, e `AsEnumerable()` é a mesma correção.

Para um único escalar, `SqlQuery<T>` com um tipo primitivo funciona direto:

```csharp
// .NET 11, C# 14, EF Core 11
var count = (await context.Database
    .SqlQuery<int>($"EXEC dbo.GetBlogCount")
    .ToListAsync()).Single();
```

A documentação do EF Core manda você dar o alias `AS Value` à coluna de saída para um `SqlQuery` escalar. Esse requisito só vale quando você compõe LINQ sobre a consulta, porque o EF precisa de um nome para referenciar a partir do `SELECT` externo que ele gera. Chamar uma procedure sem composição não precisa de alias; confirmei que um `SELECT COUNT(*)` sem alias faz o vínculo normalmente.

### A alternativa do tipo de entidade sem chave

Antes do EF Core 8, a única forma de mapear um formato de resultado que não fosse uma entidade era um tipo de entidade sem chave, e ele continua sendo a melhor escolha quando o formato faz parte do seu domínio e você quer consultá-lo como um `DbSet`:

```csharp
// .NET 11, C# 14, EF Core 11
protected override void OnModelCreating(ModelBuilder b)
{
    b.Entity<BlogStat>().HasNoKey().ToView(null);
}

var stats = await context.Set<BlogStat>()
    .FromSql($"EXEC dbo.GetBlogStats @MinViews = {10}")
    .ToListAsync();
```

`ToView(null)` diz ao EF que o tipo não tem tabela de apoio, então as migrações não vão tentar criar uma. Tipos sem chave nunca têm rastreamento de mudanças, o que confirmei: zero entradas após materializar três linhas. Recorra a `SqlQuery<T>` para relatórios pontuais e a um tipo sem chave quando o formato é reutilizado na aplicação inteira ou precisa de [uma consulta gerada pelo EF além de uma procedure](https://learn.microsoft.com/en-us/ef/core/modeling/keyless-entity-types).

## Quando a procedure não retorna nada: ExecuteSql

Para uma procedure que só escreve, use `ExecuteSql`. Ela retorna o número de linhas afetadas, não algo que a procedure tenha calculado:

```csharp
// .NET 11, C# 14, EF Core 11
var rowsAffected = await context.Database
    .ExecuteSqlAsync($"EXEC dbo.BumpRatings @By = {1}");
```

`ExecuteSql` parametriza como `FromSql`; `ExecuteSqlRaw` é a válvula de escape para quando você precisa montar SQL dinamicamente. Essa é uma ferramenta diferente de [`ExecuteUpdate` e `ExecuteDelete` para escritas em massa](/pt-br/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/), que geram SQL a partir de LINQ em vez de chamar algo que você escreveu.

Uma ressalva importante: `ExecuteSql` roda fora do rastreador de mudanças. As linhas que ela modifica no banco de dados não se refletem nas entidades que o contexto já carregou, então um `SaveChanges` posterior pode gravar valores desatualizados por cima delas. Chame-a antes de carregar, ou use `Reload()` nas entradas afetadas depois.

## Parâmetros de saída, e o problema de timing que morde todo mundo

Uma procedure que retorna tanto um conjunto de resultados quanto um parâmetro de saída é um padrão comum para paginação:

```sql
CREATE PROCEDURE dbo.GetTopBlogsWithCount @MinRating int, @TotalCount int OUTPUT AS
BEGIN
    SET NOCOUNT ON;
    SELECT @TotalCount = COUNT(*) FROM Blogs;
    SELECT Id, Name, Rating, OwnerEmail FROM Blogs WHERE Rating >= @MinRating;
END
```

Parâmetros de saída precisam de instâncias explícitas de `SqlParameter` e de `FromSqlRaw`, porque você precisa definir o `Direction` você mesmo:

```csharp
// .NET 11, C# 14, EF Core 11
var minRating = new SqlParameter("MinRating", SqlDbType.Int) { Value = 3 };
var totalCount = new SqlParameter("TotalCount", SqlDbType.Int)
{
    Direction = ParameterDirection.Output
};

var blogs = await context.Blogs
    .FromSqlRaw("EXEC dbo.GetTopBlogsWithCount @MinRating, @TotalCount OUTPUT",
        minRating, totalCount)
    .ToListAsync();

var total = (int)totalCount.Value;   // only valid after ToListAsync
```

Repare na palavra-chave `OUTPUT` no texto SQL. Omita-a e o SQL Server trata o parâmetro como somente entrada e não devolve nada, em silêncio.

Agora a parte que custa uma tarde às pessoas. `totalCount.Value` é `null` até o `DbDataReader` ser fechado, porque é aí que o SQL Server envia os valores dos parâmetros de saída pela rede. Medido diretamente:

```text
before enumeration:  total.Value = null
mid-enumeration:     total.Value = null
after dispose:       total.Value = 5
```

Ler `totalCount.Value` na linha seguinte à construção da consulta te dá `null` e uma `NullReferenceException` no cast. Isso precisa vir depois de a enumeração terminar. `ToListAsync()`, `First()` sobre um `AsEnumerable()`, e `await foreach` sobre `AsAsyncEnumerable()` funcionam, porque cada um libera o leitor.

O corolário é pior. Se você pega um enumerador e nunca o libera, recebe duas falhas de uma vez:

```csharp
// .NET 11, C# 14, EF Core 11 - do not do this
var e = context.Blogs
    .FromSqlRaw("EXEC dbo.ManyRowsWithCount @Total OUTPUT", total)
    .AsEnumerable().GetEnumerator();
e.MoveNext();                        // reader is open and never closed
```

`total.Value` continua `null`, e a próxima consulta naquele `DbContext` falha com `InvalidOperationException: There is already an open DataReader associated with this Connection which must be closed first.` Bati nisso acidentalmente durante os testes e quebrou todas as consultas seguintes no contexto. Se você enumerar manualmente, envolva em um `using`.

## Obtendo o valor de RETURN, que não é o parâmetro de saída

Um `RETURN 42` do T-SQL é um terceiro canal, separado dos parâmetros de saída e dos conjuntos de resultados. A abordagem óbvia não funciona:

```csharp
// .NET 11, C# 14, EF Core 11 - throws
var ret = new SqlParameter("ret", SqlDbType.Int)
{
    Direction = ParameterDirection.ReturnValue
};
context.Database.ExecuteSqlRaw("EXEC @ret = dbo.BumpRatings @By", ret, by);
```

```text
SqlException: Must declare the scalar variable "@ret".
```

`ParameterDirection.ReturnValue` só é compreendido quando o comando é um `CommandType.StoredProcedure` de verdade, e o EF sempre envia `CommandType.Text`. Duas coisas funcionam. A mais simples é declarar o parâmetro como `Output` e deixar a sintaxe `EXEC @ret =` fazer o vínculo:

```csharp
// .NET 11, C# 14, EF Core 11
var ret = new SqlParameter("ret", SqlDbType.Int)
{
    Direction = ParameterDirection.Output
};
var by = new SqlParameter("By", SqlDbType.Int) { Value = 1 };

context.Database.ExecuteSqlRaw("EXEC @ret = dbo.BumpRatings @By", ret, by);
var returnValue = (int)ret.Value;   // 42
```

A outra é descer para um `DbCommand` puro na conexão do EF, o que também te dá `CommandType.StoredProcedure` e, portanto, suporte real a `ReturnValue`:

```csharp
// .NET 11, C# 14, EF Core 11
var conn = context.Database.GetDbConnection();
if (conn.State != ConnectionState.Open) await conn.OpenAsync();

await using var cmd = conn.CreateCommand();
cmd.CommandText = "dbo.BumpRatings";
cmd.CommandType = CommandType.StoredProcedure;
cmd.Parameters.Add(new SqlParameter("@By", SqlDbType.Int) { Value = 1 });
var ret = new SqlParameter("@ret", SqlDbType.Int)
{
    Direction = ParameterDirection.ReturnValue
};
cmd.Parameters.Add(ret);

await cmd.ExecuteNonQueryAsync();
var returnValue = (int)ret.Value;   // 42
```

Ambos retornaram 42. Use o primeiro, a menos que você precise de `CommandType.StoredProcedure` por outro motivo. Se você abrir a conexão manualmente, lembre-se de que o EF não vai fechá-la para você.

## Múltiplos conjuntos de resultados ainda não são suportados

Se a sua procedure retorna dois conjuntos de resultados, o EF lê o primeiro e descarta o resto em silêncio. Sem exceção, sem aviso. Chamei uma procedure que retornava blogs e posts via `FromSql` e recebi três blogs de volta, com os cinco posts jogados fora.

[FromSql: Support multiple resultsets](https://github.com/dotnet/efcore/issues/8127) está aberta desde abril de 2017 e fica no marco Backlog, então não vai chegar no EF Core 11. A alternativa é um `DbDataReader` puro e `NextResult()`:

```csharp
// .NET 11, C# 14, EF Core 11
var conn = context.Database.GetDbConnection();
if (conn.State != ConnectionState.Open) await conn.OpenAsync();

await using var cmd = conn.CreateCommand();
cmd.CommandText = "dbo.TwoResultSets";
cmd.CommandType = CommandType.StoredProcedure;

await using var reader = await cmd.ExecuteReaderAsync();

var blogs = new List<Blog>();
while (await reader.ReadAsync())
    blogs.Add(new Blog { Id = reader.GetInt32(0), Name = reader.GetString(1) });

await reader.NextResultAsync();

var posts = new List<Post>();
while (await reader.ReadAsync())
    posts.Add(new Post { Id = reader.GetInt32(0), Title = reader.GetString(2) });
```

Isso retornou três blogs e cinco posts, corretamente separados. Você perde a materialização e o rastreamento do EF; se quiser rastreamento, anexe os resultados manualmente. Nesse nível de trabalho manual, o `QueryMultiple` do Dapper é algo razoável a considerar, e os trade-offs são os que medi em [consultas compiladas vs SQL puro vs Dapper](/pt-br/2026/05/ef-core-compiled-queries-vs-raw-sql-vs-dapper/).

## Mapeando inserções, atualizações e exclusões para procedures

Tudo acima trata de consultar. A direção inversa, fazer o `SaveChanges` chamar suas procedures em vez de gerar `INSERT`/`UPDATE`/`DELETE`, é um recurso separado adicionado no EF Core 7 e inalterado no 11:

```csharp
// .NET 11, C# 14, EF Core 11
modelBuilder.Entity<Person>()
    .InsertUsingStoredProcedure(
        "People_Insert",
        spb =>
        {
            spb.HasParameter(p => p.Name);
            spb.HasResultColumn(p => p.Id);
        })
    .DeleteUsingStoredProcedure(
        "People_Delete",
        spb =>
        {
            spb.HasOriginalValueParameter(p => p.Id);
            spb.HasRowsAffectedResultColumn();
        });
```

Vale conhecer duas coisas da documentação antes de se comprometer com isso. Os parâmetros precisam ser declarados na mesma ordem em que aparecem na definição da procedure, porque o EF sempre invoca posicionalmente, e não por nome. E parâmetros de valor original são obrigatórios para valores de chave em procedures de atualização e exclusão. Não exercitei esse caminho contra um banco de dados, então trate o exemplo como vindo da documentação.

O time do EF é direto sobre o recurso nas próprias notas de versão: o suporte ao mapeamento de stored procedures não implica que stored procedures sejam recomendadas.

## Escolhendo a API certa

Se a procedure retorna linhas completas de entidade, use `FromSql` no `DbSet` e aceite o rastreamento. Se ela retorna uma projeção, use `Database.SqlQuery<T>` com um DTO simples, ou um tipo de entidade sem chave quando o formato é reutilizado. Se não retorna nada, use `ExecuteSql`. Se retorna múltiplos conjuntos de resultados ou um valor de `RETURN` de que você precisa, desça para um `DbCommand`.

Seja qual for a escolha, coloque `AsEnumerable()` depois da chamada assim que quiser filtrar, e leia parâmetros de saída somente depois de a enumeração ter terminado. Essas duas regras cobrem a maior parte das dúvidas sobre o assunto.

## Relacionados

- [Fix: a coluna obrigatória não estava presente nos resultados de uma operação FromSql](/pt-br/2026/07/fix-the-required-column-was-not-present-in-the-results-of-a-fromsql-operation-in-ef-core-11/)
- [Consultas compiladas do EF Core vs SQL puro vs Dapper](/pt-br/2026/05/ef-core-compiled-queries-vs-raw-sql-vs-dapper/)
- [Fix: a expressão LINQ não pôde ser traduzida no EF Core 11](/pt-br/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)
- [Como registrar em log o SQL que o EF Core 11 gera](/pt-br/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [Como usar ExecuteUpdate e ExecuteDelete para escritas em massa no EF Core 11](/pt-br/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/)

## Fontes

- [SQL Queries, documentação do EF Core](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries)
- [Raw SQL queries for unmapped types, novidades do EF Core 8](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/whatsnew#raw-sql-queries-for-unmapped-types)
- [Keyless entity types, documentação do EF Core](https://learn.microsoft.com/en-us/ef/core/modeling/keyless-entity-types)
- [Stored procedure mapping, novidades do EF Core 7](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-7.0/whatsnew#stored-procedure-mapping)
- [Novidades do EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [dotnet/efcore#8127, FromSql: Support multiple resultsets](https://github.com/dotnet/efcore/issues/8127)
- [RelationalStrings.FromSqlNonComposable](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.diagnostics.relationalstrings.fromsqlnoncomposable)
