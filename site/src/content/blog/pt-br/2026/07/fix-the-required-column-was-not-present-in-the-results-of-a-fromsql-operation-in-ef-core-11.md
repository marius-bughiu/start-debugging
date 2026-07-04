---
title: "Correção: \"The required column 'X' was not present in the results of a 'FromSql' operation\" no EF Core 11"
description: "O EF Core lança isso quando seu SQL bruto não retorna todas as colunas que a entidade mapeia, ou os nomes não coincidem. Retorne todas as colunas mapeadas com nomes coincidentes, ou consulte um tipo escalar ou sem chave."
pubDate: 2026-07-04
template: error-page
tags:
  - "errors"
  - "efcore"
  - "dotnet"
lang: "pt-br"
translationOf: "2026/07/fix-the-required-column-was-not-present-in-the-results-of-a-fromsql-operation-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-04
---

O EF Core lança `The required column 'X' was not present in the results of a 'FromSql' operation` quando o SQL bruto que você passou para `FromSql`, `FromSqlRaw` ou `FromSqlInterpolated` não retorna uma coluna que o tipo de entidade de destino mapeia. O materializador lê os resultados pelo nome da coluna mapeada, então a coluna de cada propriedade precisa estar no conjunto de resultados, escrita da forma que o EF espera. Corrija isso retornando todas as colunas mapeadas (`SELECT *` ou uma lista explícita com alias coincidentes) ou, se você só quer um subconjunto ou uma forma arbitrária, mude para `Database.SqlQuery<T>` ou um tipo de entidade sem chave em vez de uma entidade completa. Isso se aplica ao `Microsoft.EntityFrameworkCore` 11.0 no .NET 11 com C# 14, e a regra é a mesma desde o EF Core 3.0.

## O erro em contexto

A exceção completa em tempo de execução se parece com isto:

```
System.InvalidOperationException: The required column 'Description' was not present in the results of a 'FromSql' operation.
   at Microsoft.EntityFrameworkCore.Query.Internal.RelationalCommandCache...
   at lambda_method(Closure, QueryContext, DbDataReader, ResultContext, ...)
```

O tipo da exceção é `System.InvalidOperationException`, e ela é lançada enquanto os resultados estão sendo lidos, não quando você monta a consulta. Isso significa que o stack trace aponta para o pipeline de materialização do EF Core (um `lambda_method` e `RelationalCommandCache`), não para a sua string SQL. A única informação útil é o nome da coluna entre aspas: `'Description'`. Essa é a coluna mapeada que o EF procurou no leitor e não conseguiu encontrar por nome.

## Por que isso acontece

Quando `FromSql` retorna um tipo de entidade mapeado, o EF Core não lê as colunas por posição ordinal. Ele as lê por nome. Para cada propriedade da entidade, ele pede ao `DbDataReader` "me dê o ordinal da coluna chamada `Description`", e se o leitor não tem tal coluna, essa chamada falha e o EF a expõe como este erro. A documentação estabelece a restrição diretamente: a consulta SQL deve retornar dados para todas as propriedades do tipo de entidade, e os nomes das colunas no conjunto de resultados devem coincidir com os nomes das colunas às quais as propriedades estão mapeadas.

Três coisas provocam isso, em ordem aproximada de frequência:

- **A lista SELECT está sem uma coluna.** Você escreveu `SELECT Id, Title FROM Articles` mas a entidade `Article` também mapeia uma propriedade `Description`. O EF quer `Description` e ela não está lá.
- **O nome de uma coluna não coincide com o nome mapeado.** O SQL retorna `article_description` (ou uma expressão sem alias, ou `Col2` de um procedimento armazenado gerado por scaffolding) mas a propriedade mapeia para a coluna `Description`. A mesma falha, e o nome entre aspas na mensagem é o que o EF queria, não o que seu SQL produziu, e é por isso que a mensagem pode parecer enganosa.
- **Falta uma coluna de sombra ou de tipo owned.** Chaves estrangeiras sem propriedade CLR, tokens de concorrência `[Timestamp]`/rowversion e colunas de tipos owned estão todas mapeadas e todas são obrigatórias. É fácil esquecê-las porque são invisíveis na classe da entidade.

Esta é uma escolha de design deliberada, não um bug. O EF6 ignorava o mapeamento propriedade-coluna para SQL bruto e coincidia pelo nome da propriedade de forma frouxa; o EF Core tornou isso estrito para que uma consulta de entidade bruta se comporte exatamente como uma normal e possa ser rastreada, corrigida e composta com segurança.

## Reprodução mínima

Aqui está o menor programa que reproduz isso. A entidade mapeia três colunas; o SQL retorna duas:

```csharp
// .NET 11, EF Core 11, Microsoft.EntityFrameworkCore.SqlServer 11.0
using Microsoft.EntityFrameworkCore;

using var db = new BlogContext();

// Throws: 'Description' is mapped but not in the SELECT list.
var articles = await db.Articles
    .FromSql($"SELECT Id, Title FROM Articles")
    .ToListAsync();

public class Article
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public string Description { get; set; } = "";
}

public class BlogContext : DbContext
{
    public DbSet<Article> Articles => Set<Article>();

    protected override void OnConfiguring(DbContextOptionsBuilder options) =>
        options.UseSqlServer("Server=.;Database=Blog;Trusted_Connection=True;Encrypt=False");
}
```

O EF Core mapeia `Article` para três colunas: `Id`, `Title`, `Description`. O leitor que volta de `SELECT Id, Title` tem apenas duas delas, então a materialização falha no momento em que `ToListAsync` começa a ler linhas, com `'Description' was not present`.

## A correção, em detalhe

As correções estão ordenadas da melhor (retornar uma entidade real e completa) para as alternativas que você usa quando realmente não quer a entidade completa.

### 1. Retorne todas as colunas mapeadas

Se você quer receber entidades `Article` rastreadas, o SQL precisa produzir todas as colunas que a entidade mapeia. A forma correta mais simples é `SELECT *` contra a tabela (ou uma view/TVF cujas colunas se alinhem):

```csharp
// .NET 11, EF Core 11 -- returns Id, Title, Description: all three mapped columns
var articles = await db.Articles
    .FromSql($"SELECT * FROM Articles")
    .ToListAsync();
```

`SELECT *` funciona bem aqui justamente porque o EF coincide por nome, então a ordem das colunas não importa e colunas extras são ignoradas. Se você prefere uma lista explícita (mais segura contra a deriva de esquema e mais clara na revisão de código), liste todas as colunas mapeadas e certifique-se de que nenhuma esteja faltando:

```csharp
// .NET 11, EF Core 11 -- explicit, complete column list
var articles = await db.Articles
    .FromSql($"SELECT Id, Title, Description FROM Articles WHERE Title LIKE {'%' + term + '%'}")
    .ToListAsync();
```

Lembre-se de que "todas as colunas mapeadas" inclui colunas sem uma propriedade CLR óbvia: chaves estrangeiras de sombra, um token de concorrência `RowVersion`, colunas discriminadoras para a herança TPH. Se sua entidade tem um `[Timestamp] public byte[] RowVersion` ou um discriminador de herança, essa coluna também precisa estar no conjunto de resultados.

### 2. Dê alias às colunas para que os nomes coincidam

Quando o SQL não pode usar os nomes mapeados diretamente, por exemplo um procedimento armazenado ou uma tabela legada que retorna `article_desc`, dê alias às colunas de saída com os nomes que o EF espera. A correspondência não diferencia maiúsculas de minúsculas, mas o nome precisa estar presente:

```csharp
// .NET 11, EF Core 11 -- alias legacy names onto mapped column names
var articles = await db.Articles
    .FromSqlRaw(@"SELECT article_id AS Id,
                         article_title AS Title,
                         article_desc AS Description
                  FROM legacy_articles")
    .ToListAsync();
```

Se você prefere mudar o mapeamento em vez do SQL, mapeie a propriedade para o nome real da coluna com `[Column("article_desc")]` ou `HasColumnName("article_desc")` em `OnModelCreating`, e então o SQL bruto que retorna `article_desc` coincide sem alias. Escolha um lado; não brigue consigo mesmo nos dois.

### 3. Consulte um escalar ou projeção com `SqlQuery<T>`

Se você só quer alguns campos, não force uma entidade completa. `Database.SqlQuery<T>` (EF Core 7.0+, ainda a API atual no 11.0) lê um tipo arbitrário sem a regra de "todas as colunas mapeadas". Para uma única coluna escalar:

```csharp
// .NET 11, EF Core 11 -- no entity involved, so no missing-column rule
var titles = await db.Database
    .SqlQuery<string>($"SELECT Title FROM Articles WHERE Id > {minId}")
    .ToListAsync();
```

Para uma forma de várias colunas, declare um record simples cujos nomes de propriedade coincidam com as colunas de resultado (possivelmente com alias) e consulte-o. Esse tipo não faz parte do seu modelo, então o EF não exige nada sobre completude:

```csharp
// .NET 11, EF Core 11 -- lightweight read model, matched by name
public record ArticleSummary(int Id, string Title);

var summaries = await db.Database
    .SqlQuery<ArticleSummary>($"SELECT Id, Title FROM Articles")
    .ToListAsync();
```

`SqlQuery<T>` nunca rastreia resultados, que é exatamente o que você quer para um resumo somente leitura. É a ferramenta certa no momento em que você se pega querendo uma entidade parcial.

### 4. Modele o resultado como um tipo de entidade sem chave

Para uma forma que você reutiliza em toda a aplicação, especialmente a saída de uma view ou de um procedimento armazenado de relatórios, declare um tipo de entidade sem chave. Ele participa do modelo (então você pode usar `Include` e compor sobre ele em alguns casos) mas não tem chave e nunca é rastreado. Configure-o com `HasNoKey`:

```csharp
// .NET 11, EF Core 11 -- keyless type mapped to a reporting shape
public class ArticleStat
{
    public string Title { get; set; } = "";
    public int ViewCount { get; set; }
}

// in OnModelCreating:
modelBuilder.Entity<ArticleStat>().HasNoKey().ToView(null);

// query:
var stats = await db.Set<ArticleStat>()
    .FromSql($"SELECT Title, COUNT(*) AS ViewCount FROM Views GROUP BY Title")
    .ToListAsync();
```

Um tipo de entidade sem chave ainda exige que suas próprias colunas mapeadas estejam presentes, mas você controla esse mapeamento, então o dimensiona exatamente para as colunas que seu SQL retorna, em vez de para uma entidade de tabela completa.

## Detalhes e variantes

**A coluna entre aspas não é a que está faltando no seu SQL.** Como o EF coincide por nome, se seu SQL retorna `Desc` e a entidade mapeia `Description`, a mensagem diz `'Description' was not present`, não `'Desc' was unexpected`. Compare a lista de colunas que sua consulta realmente retorna com as colunas mapeadas da entidade, e procure a divergência em vez de confiar que a coluna nomeada está literalmente ausente. Essa confusão exata está registrada na [dotnet/efcore issue #33748](https://github.com/dotnet/efcore/issues/33748).

**Procedimentos armazenados gerados por scaffolding produzem `Col1`, `Col2`.** Quando um procedimento armazenado retorna uma coluna calculada sem nome (`SELECT COUNT(*)` em vez de `SELECT COUNT(*) AS Total`), as ferramentas de engenharia reversa a nomeiam `Col0`, `Col1`, e assim por diante, e então o tipo de resultado gerado espera esses nomes. Dê um alias explícito a cada coluna no procedimento e o problema desaparece na origem.

**Um procedimento armazenado que projeta um subconjunto.** `EXECUTE dbo.GetArticleTitles` retornando apenas `Id, Title` não pode materializar um `Article` completo. Não o passe por `context.Articles.FromSql`; passe-o por `Database.SqlQuery<T>` ou um tipo sem chave dimensionado para o que o procedimento retorna. Lembre-se também de que você não pode compor LINQ sobre uma chamada de procedimento armazenado, então adicione `AsEnumerable()` logo depois de `FromSql` se precisar de mais trabalho em memória.

**Tipos owned e divisão de tabela.** Se `Article` possui um objeto de valor do tipo `Address` armazenado na mesma tabela, as colunas do tipo owned fazem parte da entidade e precisam estar no conjunto de resultados. Omiti-las gera o mesmo erro para uma coluna que você talvez nem perceba que existe. Inclua-as ou divida a leitura em uma projeção sem chave.

**Funcionava antes de uma atualização a partir do EF6.** O EF6 coincidia os resultados de SQL bruto pelo nome da propriedade e era frouxo com colunas faltantes ou mal nomeadas. O EF Core é estrito. Se você está movendo uma base de código através dessa fronteira, este é um de vários comportamentos de SQL bruto que mudaram, e ele anda junto com o conjunto mais amplo de [mudanças disruptivas que realmente mordem ao migrar do EF Core 6 para o EF Core 11](/pt-br/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).

**Um `NULL` em uma coluna não anulável é um erro diferente.** Se a coluna está presente mas o valor é `NULL` e a propriedade é um tipo de valor não anulável, você recebe uma `System.Data.SqlTypes.SqlNullValueException` ou um erro de materialização sobre converter null, não este. Esse é um problema de dados, não de forma; torne a propriedade anulável ou use `ISNULL`/`COALESCE` no SQL.

O modelo mental que te mantém fora desse erro para sempre: `FromSql` em um `DbSet<T>` é uma promessa de retornar um `T` completo e corretamente nomeado. Se você não pode ou não quer manter essa promessa, não use uma entidade. Use `SqlQuery<T>` para escalares e records ad-hoc, ou um tipo sem chave para uma forma que você nomeia e reutiliza. Reserve `context.Set<T>().FromSql` para o caso em que o SQL realmente hidrata a entidade inteira.

## Relacionados

- [Correção: "The LINQ expression could not be translated" no EF Core 11](/pt-br/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/) é o erro irmão que você encontra quando vai pelo outro caminho e fica no LINQ.
- [Consultas compiladas do EF Core vs SQL bruto vs Dapper](/pt-br/2026/05/ef-core-compiled-queries-vs-raw-sql-vs-dapper/) pesa quando o SQL bruto vale suas arestas afiadas que você acabou de conhecer.
- [Como mapear e consultar colunas JSON no EF Core 11](/pt-br/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) cobre outro caso onde a forma do resultado e o mapeamento da entidade precisam se alinhar.
- [AsNoTracking vs AsNoTrackingWithIdentityResolution no EF Core 11](/pt-br/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/) importa quando sua consulta de entidade bruta funciona e você quer que a leitura seja barata.
- [Como detectar consultas N+1 no EF Core 11](/pt-br/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) vale uma passada quando o SQL bruto é sua resposta a uma consulta que o EF gerou mal.

## Fontes

- [Consultas SQL brutas, documentação do EF Core](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries) (veja a seção "Limitations": todas as colunas mapeadas precisam ser retornadas e os nomes devem coincidir)
- [Tipos de entidade sem chave, documentação do EF Core](https://learn.microsoft.com/en-us/ef/core/modeling/keyless-entity-types)
- [RelationalDatabaseFacadeExtensions.SqlQuery, referência da API](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.relationaldatabasefacadeextensions.sqlquery)
- [dotnet/efcore issue #33748: texto enganoso de "missing column" para uma coluna errada](https://github.com/dotnet/efcore/issues/33748)
