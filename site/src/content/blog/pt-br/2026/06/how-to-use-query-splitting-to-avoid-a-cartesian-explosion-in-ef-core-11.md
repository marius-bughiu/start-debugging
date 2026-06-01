---
title: "Como usar a divisão de consultas para evitar uma explosão cartesiana no EF Core 11"
description: "Quando você faz Include de duas coleções irmãs, o EF Core 11 retorna o produto cartesiano e a contagem de linhas explode. Veja como o AsSplitQuery resolve isso, como ativá-lo globalmente e os detalhes de consistência e ordenação que você deve observar."
pubDate: 2026-06-01
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "csharp"
  - "dotnet-11"
  - "performance"
  - "sql-server"
  - "how-to"
lang: "pt-br"
translationOf: "2026/06/how-to-use-query-splitting-to-avoid-a-cartesian-explosion-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-06-01
---

Resposta curta: quando uma única consulta LINQ carrega duas ou mais navegações de coleção no mesmo nível (`.Include(b => b.Posts).Include(b => b.Contributors)`), o EF Core a traduz em uma única instrução SQL com JOINs irmãos, e o banco de dados retorna o produto cartesiano de ambas as coleções. Um blog com 50 posts e 20 contribuidores volta como 1000 linhas. Chame `.AsSplitQuery()` e o EF Core 11 emite uma consulta por coleção em vez disso, então você obtém 50 + 20 = 70 linhas distribuídas em viagens de ida e volta separadas. A correção é uma única chamada de método, mas há três coisas que pegam as pessoas: a consistência dos dados entre as consultas divididas, os joins de referência extras repetidos em cada consulta, e a correção da ordenação com `Skip`/`Take`.

Este post é sobre .NET 11 e EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0.x) contra o SQL Server, mas a mecânica da explosão cartesiana e a API `AsSplitQuery` são idênticas no PostgreSQL e no SQLite. Vou mostrar o SQL explodido, o SQL dividido, como definir o comportamento por consulta e globalmente, e como decidir entre os dois.

## O que é realmente uma explosão cartesiana

Um JOIN relacional entre um pai e uma única coleção filha é tranquilo. O problema começa quando você faz JOIN de um pai a duas coleções filhas que pendem do mesmo pai. Pegue o modelo canônico de blog:

```csharp
// .NET 11, EF Core 11.0.0, C# 14
public sealed class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public List<Post> Posts { get; set; } = [];
    public List<Contributor> Contributors { get; set; } = [];
}

public sealed class Post
{
    public int Id { get; set; }
    public int BlogId { get; set; }
    public string Title { get; set; } = "";
}

public sealed class Contributor
{
    public int Id { get; set; }
    public int BlogId { get; set; }
    public string FirstName { get; set; } = "";
}
```

Agora carregue um blog com ambas as coleções em uma única consulta:

```csharp
var blogs = await ctx.Blogs
    .Include(b => b.Posts)
    .Include(b => b.Contributors)
    .ToListAsync();
```

O EF Core 11 produz uma única instrução com dois `LEFT JOIN`s no mesmo nível:

```sql
SELECT [b].[Id], [b].[Name],
       [p].[Id], [p].[BlogId], [p].[Title],
       [c].[Id], [c].[BlogId], [c].[FirstName]
FROM [Blogs] AS [b]
LEFT JOIN [Posts] AS [p] ON [b].[Id] = [p].[BlogId]
LEFT JOIN [Contributors] AS [c] ON [b].[Id] = [c].[BlogId]
ORDER BY [b].[Id], [p].[Id]
```

Como `Posts` e `Contributors` são ambas coleções de `Blog`, o banco de dados não tem escolha a não ser retornar um produto cartesiano: cada linha de post é emparelhada com cada linha de contribuidor daquele blog. Um blog com 50 posts e 20 contribuidores produz 50 * 20 = 1000 linhas, e cada uma dessas linhas repete todas as colunas de `Blog` e as colunas de post e as colunas de contribuidor. O EF Core de-duplica os objetos materializados no cliente, então você ainda obtém um `Blog` com 50 posts e 20 contribuidores, mas a rede pagou por 1000 linhas de dados redundantes.

O multiplicador é o produto dos tamanhos das coleções, não a soma. Adicione uma terceira coleção irmã com 10 linhas e você estará em 50 * 20 * 10 = 10.000 linhas para um único pai. É por isso que uma consulta que parece inocente em desenvolvimento, onde cada blog tem dois posts, pode transferir centenas de megabytes em produção onde os blogs têm centenas de posts. O [guia oficial de consultas únicas vs. divididas do EF Core](https://learn.microsoft.com/en-us/ef/core/querying/single-split-queries) documenta um caso real onde a contagem de linhas caiu de mais de 133.000 para pouco mais de 1000 após a divisão.

Um caso importante que não se aplica: includes aninhados em níveis diferentes não explodem. `.Include(b => b.Posts).ThenInclude(p => p.Comments)` é `Comments` pendendo de `Post`, não de `Blog`, então cada comentário mapeia para exatamente uma linha e não há produto cartesiano. A explosão cartesiana trata especificamente de coleções irmãs no mesmo nível.

## O aviso que o EF Core já lhe dá

O EF Core 11 não deixa isso acontecer em silêncio sem uma dica. Quando detecta uma consulta que carrega múltiplas coleções e você não escolheu um comportamento de divisão, ele lança `MultipleCollectionIncludeWarning` através do pipeline de log. Por padrão é registrado em log, não lançado, então é fácil perdê-lo em um log barulhento. Você pode promovê-lo a uma exceção para que falhe rápido em desenvolvimento:

```csharp
// .NET 11, EF Core 11.0.0
services.AddDbContext<BloggingContext>(options =>
{
    options.UseSqlServer(connectionString);
    options.ConfigureWarnings(w =>
        w.Throw(RelationalEventId.MultipleCollectionIncludeWarning));
});
```

Com isso no lugar, qualquer consulta que inclua duas coleções irmãs sem um `AsSingleQuery()` ou `AsSplitQuery()` explícito lança em tempo de execução, forçando o autor a tomar uma decisão deliberada. Esta é a mesma postura defensiva que recomendo para caçar regressões de desempenho no [guia para detectar consultas N+1 no EF Core 11](/pt-br/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/): faça o framework ser barulhento sobre os padrões que escalam mal, em vez de descobri-los sob carga.

## A correção: AsSplitQuery

Adicione um operador à consulta:

```csharp
var blogs = await ctx.Blogs
    .Include(b => b.Posts)
    .Include(b => b.Contributors)
    .AsSplitQuery()
    .ToListAsync();
```

O EF Core 11 agora emite três instruções SQL separadas sobre a mesma conexão: a consulta raiz para os blogs, uma consulta para os posts, e uma para os contribuidores.

```sql
-- Query 1: the roots
SELECT [b].[Id], [b].[Name]
FROM [Blogs] AS [b]
ORDER BY [b].[Id]

-- Query 2: posts, correlated back to the roots
SELECT [p].[Id], [p].[BlogId], [p].[Title], [b].[Id]
FROM [Blogs] AS [b]
INNER JOIN [Posts] AS [p] ON [b].[Id] = [p].[BlogId]
ORDER BY [b].[Id]

-- Query 3: contributors, correlated back to the roots
SELECT [c].[Id], [c].[BlogId], [c].[FirstName], [b].[Id]
FROM [Blogs] AS [b]
INNER JOIN [Contributors] AS [c] ON [b].[Id] = [c].[BlogId]
ORDER BY [b].[Id]
```

O mesmo blog agora custa 50 linhas de post mais 20 linhas de contribuidor mais 1 linha raiz, 71 linhas no total em vez de 1000. Nenhum dado é duplicado, porque as colunas do blog aparecem uma vez na consulta 1 em vez de serem estampadas em cada linha do produto cartesiano. O EF Core costura os três conjuntos de resultados de volta no cliente usando a chave de correlação, e é por isso que cada consulta filha reseleciona `[b].[Id]` e ordena por ela.

O grafo de objetos retornado é idêntico byte por byte à versão de consulta única. `AsSplitQuery` muda apenas como os dados viajam, nunca o que você obtém de volta. Isso o torna um substituto seguro para qualquer consulta de leitura onde o pai tem múltiplas coleções grandes.

## Ativando a divisão de consultas globalmente

Se a maioria das suas consultas se abre em múltiplas coleções, mudar o padrão é mais limpo do que espalhar `AsSplitQuery()` por toda parte. Configure-o nas opções do provedor com `UseQuerySplittingBehavior`:

```csharp
// .NET 11, EF Core 11.0.0
services.AddDbContext<BloggingContext>(options =>
{
    options.UseSqlServer(connectionString,
        sql => sql.UseQuerySplittingBehavior(QuerySplittingBehavior.SplitQuery));
});
```

O enum `QuerySplittingBehavior` tem dois valores: `SingleQuery` (o padrão do framework, fazer JOIN de tudo em uma única instrução) e `SplitQuery` (uma instrução por coleção). Uma vez que o padrão global é `SplitQuery`, você opta consultas individuais de volta para uma única instrução com `AsSingleQuery()`:

```csharp
var blog = await ctx.Blogs
    .Include(b => b.Posts)
    .AsSingleQuery()       // override the global SplitQuery default
    .FirstAsync(b => b.Id == id);
```

Uma regra prática razoável: use `AsSingleQuery` para consultas que carregam exatamente uma coleção (nenhuma explosão é possível, e você economiza uma viagem de ida e volta), e deixe o padrão global `SplitQuery` lidar com tudo com duas ou mais. Definir o padrão global também silencia `MultipleCollectionIncludeWarning`, porque você agora tomou uma decisão explícita para todo o contexto.

## Quando a divisão de consultas é a escolha errada

Dividir não é uma vitória gratuita, e tratá-la como tal é como você troca um problema de largura de banda por um problema de latência ou de correção. Três desvantagens a ponderar:

**Cada divisão é uma viagem de ida e volta separada.** Três coleções significam três viagens de ida e volta ao banco de dados. Em uma rede local de baixa latência isso é invisível, mas contra um banco de dados na nuvem com 15 ms de latência de ida e volta, três consultas sequenciais adicionam 45 ms de pura espera antes que qualquer trabalho comece. Se suas coleções são pequenas (um punhado de linhas cada), o produto cartesiano é minúsculo e uma única consulta com JOIN que paga uma viagem de ida e volta é mais rápida do que três consultas divididas que cada uma paga a sua. As consultas divididas vencem quando as coleções são grandes o suficiente para que a contagem de linhas do produto cartesiano ofusque o custo da viagem de ida e volta.

**Não há consistência transacional entre as divisões por padrão.** Uma única instrução SQL vê um instantâneo consistente do banco de dados. As consultas divididas são múltiplas instruções, e se outra transação confirma entre a consulta 1 e a consulta 2, os posts que você carrega podem não corresponder ao estado do blog que você carregou. A correção, conforme a documentação oficial, é envolver as leituras em uma transação serializável ou de instantâneo:

```csharp
// .NET 11, EF Core 11.0.0
using var tx = await ctx.Database.BeginTransactionAsync(
    System.Data.IsolationLevel.Snapshot);

var blogs = await ctx.Blogs
    .Include(b => b.Posts)
    .Include(b => b.Contributors)
    .AsSplitQuery()
    .ToListAsync();

await tx.CommitAsync();
```

Para a maioria dos caminhos de leitura a breve janela de inconsistência não importa, mas se você está calculando um total entre coleções que deve concordar, recorra ao isolamento de instantâneo.

**As navegações de referência são unidas em cada divisão.** Se você também faz `Include` de uma navegação para-um junto às suas coleções, cada consulta dividida repete o join àquela tabela de referência. No EF Core 10 e anteriores isso era puro desperdício. O EF Core 11 corrigiu: como abordado no [post sobre o EF Core 11 podando os joins de referência em consultas divididas](/pt-br/2026/04/efcore-11-preview-3-prunes-reference-joins-split-queries/), o runtime agora descarta os joins de referência das consultas filhas que não os projetam, então uma busca de `BlogType` não é mais re-unida na consulta de posts. Note que as referências um-para-um e muitos-para-um são sempre carregadas via JOIN mesmo no modo dividido, porque uma referência não pode multiplicar linhas, então não há nada para dividir.

## O detalhe da ordenação com Skip e Take

A armadilha sutil de correção é a paginação. As consultas divididas correlacionam seus conjuntos de resultados ordenando por uma chave compartilhada, e se sua ordenação não for totalmente única, cada consulta dividida pode escolher um subconjunto de linhas diferente quando combinada com `Skip`/`Take`. Suponha que você ordene os blogs por `CreatedDate` e dois blogs compartilhem a mesma data:

```csharp
// Risky on older EF: non-unique ordering with paging
var page = await ctx.Blogs
    .OrderBy(b => b.CreatedDate)
    .Skip(20).Take(10)
    .Include(b => b.Posts)
    .Include(b => b.Contributors)
    .AsSplitQuery()
    .ToListAsync();
```

Como os bancos de dados relacionais não aplicam uma ordenação inerente, a consulta raiz e as consultas filhas poderiam resolver cada uma o empate de forma diferente, retornando posts para um blog que não está na sua página. O EF Core 10 e 11 reforçam isso adicionando automaticamente a chave primária ao `ORDER BY` gerado para que a chave de correlação seja única, mas o hábito seguro é fazer sua própria ordenação determinística independentemente da versão do EF:

```csharp
// .NET 11, EF Core 11.0.0 -- fully unique ordering
var page = await ctx.Blogs
    .OrderBy(b => b.CreatedDate)
    .ThenBy(b => b.Id)            // tie-breaker makes the order total
    .Skip(20).Take(10)
    .Include(b => b.Posts)
    .Include(b => b.Contributors)
    .AsSplitQuery()
    .ToListAsync();
```

Adicionar `ThenBy(b => b.Id)` torna a ordenação total, então cada consulta dividida concorda sobre quais 10 blogs estão na página. Isso não custa nada e elimina uma classe de bug que só aparece quando duas linhas empatam por acaso.

## Uma lista de verificação rápida para decidir

Quando você se deparar com uma consulta que inclui múltiplas coleções, percorra isto:

1. **A consulta carrega duas ou mais coleções irmãs?** Se não, você não pode ter uma explosão cartesiana. Deixe-a como uma única consulta.
2. **As coleções são grandes em produção?** Se cada pai tem centenas de linhas por coleção, o produto cartesiano é o custo dominante. Divida-a.
3. **A latência do banco de dados é alta (nuvem, entre regiões)?** Se sim e as coleções são pequenas, as viagens de ida e volta extras podem custar mais do que a explosão. Meça antes de dividir.
4. **A leitura precisa de um instantâneo consistente?** Se você calcula agregados entre coleções, envolva a divisão em uma transação de instantâneo ou serializável.
5. **Há paginação?** Faça o `OrderBy` ser totalmente único com um desempate por chave primária.

Para caminhos quentes onde a consulta roda milhares de vezes por segundo, combine a divisão com [consultas compiladas no EF Core](/pt-br/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) para que a tradução de LINQ para SQL seja armazenada em cache. E quando a leitura está genuinamente no caminho crítico e a sobrecarga do EF Core importa, vale a pena dar uma olhada na comparação em [EF Core 11 vs Dapper para operações em massa](/pt-br/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/), embora para o carregamento ordinário de coleções `AsSplitQuery` feche a maior parte da lacuna. Se você transmite os resultados em vez de materializar uma lista, as mesmas regras de divisão se aplicam às [consultas IAsyncEnumerable no EF Core 11](/pt-br/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/).

A explosão cartesiana é um dos poucos problemas de desempenho do EF Core com uma correção de uma linha e um conjunto de resultados idêntico. A parte difícil não é a chamada a `AsSplitQuery()`, é saber que ela está acontecendo. Transforme `MultipleCollectionIncludeWarning` em uma exceção em desenvolvimento, e o framework lhe dirá exatamente quais consultas precisam do tratamento antes que elas cheguem à produção.

Fonte: [Consultas únicas vs. divididas, documentação do EF Core](https://learn.microsoft.com/en-us/ef/core/querying/single-split-queries), e as [notas de novidades do EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew).
