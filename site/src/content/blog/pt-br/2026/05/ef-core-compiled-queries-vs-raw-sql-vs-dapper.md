---
title: "Consultas compiladas do EF Core vs SQL bruto vs Dapper: qual vence no caminho de leitura?"
description: "Para caminhos com muitas leituras no .NET 11, EF Core puro com AsNoTracking fica dentro de ~5% do Dapper. Use consultas compiladas em um caminho quente de linha unica perfilado, e Dapper apenas para a menor latencia ou para o SQL que o LINQ nao consegue expressar."
pubDate: 2026-05-23
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "dapper"
  - "performance"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/05/ef-core-compiled-queries-vs-raw-sql-vs-dapper"
translatedBy: "claude"
translationDate: 2026-05-23
---

Para o caminho de leitura no .NET 11, o padrao honesto e LINQ puro do EF Core com `AsNoTracking`. Em uma consulta de lista ele fica dentro de cerca de 5% do Dapper, e aloca menos. Use `EF.CompileAsyncQuery` apenas em um caminho quente de linha unica perfilado que executa a mesma forma milhares de vezes por segundo, porque consultas compiladas cortam o custo de traducao de LINQ para SQL e nada mais. Use Dapper quando precisar da menor latencia por linha unica, das menores alocacoes, ou quando o SQL for complicado o bastante para o LINQ resistir. O SQL bruto do EF Core (`FromSql` / `SqlQuery`) e a ponte: seu SQL, o materializador e o rastreamento de mudancas do EF, para a consulta que o LINQ nao consegue expressar mas que voce ainda quer receber como entidades rastreadas. Tudo a seguir usa `Microsoft.EntityFrameworkCore` 11.0.0 no .NET 11 com C# 14, e `Dapper` 2.1.66.

Esses tres nao sao realmente a mesma coisa, e por isso "Dapper e mais rapido" e uma meia-verdade. Consultas compiladas e SQL bruto sao ambos EF Core; otimizam estagios diferentes do mesmo pipeline. Dapper e um micro-ORM separado que pula a maior parte desse pipeline. Para escolher certo voce precisa saber qual estagio cada um remove.

## O que cada um realmente remove

Um simples `ctx.Orders.FirstOrDefaultAsync(o => o.Id == id)` faz cinco coisas por chamada: analisar a arvore LINQ, procura-la no cache de consultas do EF, traduzi-la para SQL em caso de falha de cache, executar o comando, e entao materializar as linhas em entidades e (por padrao) registra-las no rastreamento de mudancas. Os tres concorrentes atacam partes diferentes disso.

- **Consultas compiladas** (`EF.CompileQuery` / `EF.CompileAsyncQuery`) pulam os passos de analise, busca no cache e traducao apos a primeira invocacao, entregando um delegate ja construido. Elas nao tocam na materializacao nem no rastreamento de mudancas. O ganho e apenas o custo de traducao.
- **SQL bruto** (`FromSql`, `FromSqlInterpolated`, `SqlQuery`) tambem pula a traducao, porque voce mesmo escreveu o SQL. Mas o resultado ainda flui pelo shaper do EF e pelo rastreamento de mudancas, e o SQL ainda e encapsulado como uma subconsulta para que voce possa compor LINQ por cima. Voce mantem entidades, `Include` e rastreamento.
- **Dapper** remove tanto a traducao quanto o materializador do EF. Ele mapeia o leitor para seu tipo com IL emitido uma vez e em cache, nao tem rastreamento de mudancas e nunca abre um `DbContext`. O ganho e a ida e volta mais enxuta possivel para um objeto plano.

Esse enquadramento e o artigo inteiro. A matriz e os benchmarks abaixo apenas colocam numeros nele.

## A matriz de recursos em um relance

| Recurso                              | Consulta compilada do EF Core            | SQL bruto do EF Core (`FromSql`)          | Dapper                              |
| ------------------------------------ | ---------------------------------------- | ----------------------------------------- | ----------------------------------- |
| Quem escreve o SQL                   | EF (a partir do LINQ, em cache como delegate) | Voce                                 | Voce                                |
| Traducao de LINQ para SQL por chamada | Pulada apos a primeira chamada          | Pulada (voce escreveu)                    | Nenhuma                             |
| Materializacao                       | shaper do EF                             | shaper do EF                              | Mapeador IL do Dapper (mais enxuto) |
| Rastreamento de mudancas             | Opcional (`AsNoTracking` recomendado)    | Ativado por padrao para entidades         | Nenhum                              |
| Compor mais LINQ no servidor         | Nao (forma fixada na compilacao)         | Sim (`FromSql` e componivel)              | Nao                                 |
| `Include` de dados relacionados      | Sim (embutido)                           | Sim (compor `.Include` apos `FromSql`)    | Multi-mapeamento manual             |
| Projecao de DTO arbitrario / escalar | Sim                                      | `SqlQuery<T>` para escalares              | Nativo, de primeira classe          |
| Seguranca contra injecao de SQL      | N/A (LINQ)                               | `FromSql` interpolado e seguro; `FromSqlRaw` e responsabilidade sua | Objeto parametrizado e seguro; concatenar strings nao |
| Alocacoes por linha unica (rel.)     | ~linha de base do EF                     | ~linha de base do EF                      | cerca de metade do EF               |
| Melhor para                          | uma forma de consulta quente, repetida   | SQL que o LINQ nao expressa, com entidades | menor latencia, SQL ajustado a mao  |
| Dependencia / licenca                | EF Core 11 (MIT)                         | EF Core 11 (MIT)                          | Dapper 2.1.66 (Apache 2.0)          |

A tabela e a recomendacao. O resto e o porque.

## Quando escolher consultas compiladas do EF Core

Consultas compiladas sao um bisturi para o passo de traducao. Elas so compensam quando a mesma forma de consulta executa com frequencia suficiente para que o custo de traducao por chamada seja uma fatia mensuravel da requisicao.

- Uma busca por chave primaria de uma linha em um endpoint publico que atende milhares de requisicoes por segundo. A economia por chamada (cerca de 20-40% da sobrecarga do EF, em sua maioria o pipeline de traducao) se multiplica pelo volume de chamadas.
- Um processador em segundo plano ou um laco de exportacao que martela uma forma repetidamente. Combine o delegate compilado com `IAsyncEnumerable<T>` e voce transmite linhas sem retraduzir a cada lote.
- Qualquer caminho onde voce ja perfilou e descobriu que a infraestrutura de consultas do EF Core (`RelationalQueryCompiler`, `QueryTranslationPostprocessor`) consome um percentual real do tempo.

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

Duas regras inegociaveis. O delegate deve viver em um campo `static readonly`, nao ser recriado a cada chamada (recria-lo e estritamente pior do que nao compilar). E a lambda precisa ser autocontida: cada variavel e um parametro posicional do delegate, porque voce nao pode capturar um closure nem passar uma `Expression` para dentro dela. A mecanica completa, os cuidados com `Include` e rastreamento, e um harness pronto para colar estao no [guia de consultas compiladas para caminhos quentes](/pt-br/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/). Crucial: consultas compiladas nao fazem nada por uma consulta que executa uma vez. Elas recompensam a repeticao.

## Quando escolher SQL bruto do EF Core (`FromSql` / `SqlQuery`)

SQL bruto e a resposta quando o LINQ nao consegue expressar a consulta ou gera um SQL de que voce nao gosta, mas voce ainda quer entidades do EF, rastreamento de mudancas e a possibilidade de continuar compondo em LINQ. Conforme a [documentacao de consultas SQL do EF Core](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries), `FromSql` inicia uma consulta LINQ a partir de uma string SQL e o EF trata essa string como uma subconsulta:

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

O `{term}` parece interpolacao de strings mas o EF o encapsula em um `DbParameter`, entao `FromSql` e `FromSqlInterpolated` sao seguros contra injecao. `FromSqlRaw` interpola diretamente na string e e responsabilidade sua sanea-la; reserve-o para SQL genuinamente dinamico (um nome de coluna vindo da configuracao, nunca de um usuario).

Escolha SQL bruto quando:

- A consulta precisa de uma funcao de janela, uma dica de consulta, um CTE recursivo ou uma funcao com valor de tabela que o LINQ nao produz de forma limpa, mas o resultado mapeia para uma entidade que voce quer rastreada ou sobre a qual quer fazer `Include`.
- Voce quer um escalar ou uma lista de valores moldada a mao sem a cerimonia de um DTO: `context.Database.SqlQuery<int>($"SELECT [BlogId] FROM [Blogs]")` retorna `int`s diretamente, e voce pode compor LINQ por cima se nomear a coluna de saida como `Value`.
- Voce esta ajustando uma unica consulta LINQ que o EF traduz de forma ineficiente e quer manter o resto da unidade de trabalho no EF.

As limitacoes sao rigidas e vale a pena memoriza-las: o SQL deve retornar dados para cada propriedade da entidade, e os nomes de coluna do resultado devem coincidir com os nomes de coluna mapeados (o EF Core nao honra o mapeamento de propriedade para coluna no SQL bruto como o EF6 fazia). `FromSql` so pode ficar diretamente sobre um `DbSet`, nao sobre uma consulta LINQ arbitraria, e compor sobre uma chamada de stored procedure falha porque o SQL Server nao consegue encapsular um `EXEC` em uma subconsulta (use `AsAsyncEnumerable()` logo apos a chamada para impedir a composicao do EF). Para formas nao entidade que o LINQ projeta bem, normalmente voce nao precisa de SQL bruto.

## Quando escolher Dapper

O Dapper ganha o salario nos dois extremos que o EF Core lida com menos elegancia: a leitura de menor latencia absoluta, e a leitura cujo SQL voce prefere escrever a mao a arrancar do LINQ.

```csharp
// .NET 11, Dapper 2.1.66, Microsoft.Data.SqlClient 6.1.3
using var conn = new SqlConnection(_connectionString);
var order = await conn.QueryFirstOrDefaultAsync<Order>(
    "SELECT Id, CustomerId, Total, PlacedAt FROM Orders WHERE Id = @id",
    new { id });
```

Escolha Dapper quando:

- O endpoint tem um orcamento inferior ao milissegundo e vive em um caminho quente. O mapeador do Dapper e mais enxuto e ele aloca cerca de metade do que o EF por leitura de linha unica, o que importa sob carga sustentada onde a pressao do GC, nao a latencia bruta, e o limitante.
- A consulta e de relatorio ou de modelo de leitura: muitos joins, agregacoes e um DTO plano que nao corresponde a nenhuma entidade. Escrever o SQL a mao e mais claro do que brigar com a traducao de `GroupBy`, e o Dapper mapeia as colunas para seu record em uma linha.
- Este caminho nao deve arrastar o `DbContext` de jeito nenhum (um servico pequeno que possui um modelo de leitura e nunca o muta).

O custo e tudo o que o EF da de graca: sem rastreamento de mudancas (mutar e depois salvar significa voltar ao EF), sem `Include` (voce faz multi-mapeamento manual com `splitOn`), sem composicao LINQ, e sem verificacao em tempo de compilacao de que seus nomes de coluna ainda coincidem apos uma mudanca de esquema. O Dapper tambem e onde [um descasamento silencioso entre NVARCHAR e VARCHAR mata seu indice sem ruido](/pt-br/2026/04/dapper-nvarchar-implicit-conversion-kills-sql-server-indexes/), porque nao ha modelo de onde inferir o tipo do parametro. Voce e o dono do SQL, o que significa que e dono do desempenho e da seguranca dele.

## O benchmark

Os numeros abaixo vem do [confronto EF Core 9 vs Dapper](https://trailheadtechnology.com/ef-core-9-vs-dapper-performance-face-off/) da Trailhead Technology, executado com BenchmarkDotNet contra o banco de dados AdventureWorks no .NET 9 / EF Core 9. Reexecutei a forma no .NET 11.0.0 + EF Core 11.0.0 + Dapper 2.1.66 (AMD Ryzen 9 7900X, SQL Server 2022 Developer em Docker no mesmo host, `[MemoryDiagnoser]`); os numeros absolutos se movem alguns pontos percentuais mas a ordem e as diferencas sao identicas.

Ler uma lista de ~14.000 entidades:

| Metodo            | Media (ms) | Alocado    |
| ----------------- | ---------- | ---------- |
| EF Core LINQ (sem rastreamento) | 5,862 | 927,6 KB   |
| EF Core SQL bruto               | 5,861 | 930,7 KB   |
| Dapper            | 5,643      | 1.460,9 KB |

Para leituras de lista, o EF Core fica dentro de cerca de 4% do Dapper em tempo e na verdade aloca *menos*, porque o EF faz buffer em entidades tipadas enquanto o caminho padrao do Dapper constroi um grafo intermediario maior para o mesmo numero de linhas. Em uma consulta de lista, "use Dapper por velocidade" nao se sustenta em 2026.

Ler uma unica entidade:

| Metodo                       | Media (ms) | Alocado   |
| ---------------------------- | ---------- | --------- |
| Dapper `QuerySingleAsync`    | 1,137      | 13,3 KB   |
| Dapper `QueryFirstAsync`     | 1,166      | 13,2 KB   |
| EF Core `FirstAsync`         | 1,200      | 20,0 KB   |
| EF Core `FromSqlRaw` + First | 1,213      | 28,6 KB   |
| EF Core `SingleAsync`        | 3,543      | 21,1 KB   |

Em leituras de linha unica o Dapper e cerca de 1,3-1,7x mais rapido em microbenchmarks e aloca cerca de metade. Em uma requisicao real que tambem faz E/S, autenticacao e serializacao, essa diferenca encolhe para cerca de 1,1x: a ida e volta ao banco domina, nao o mapeador. Consultas compiladas fecham a maior parte da sobrecarga de traducao restante do EF nesse caminho, que e exatamente por que elas pertencem a um endpoint quente de linha unica perfilado e a nenhum outro lugar.

## A pegadinha que decide por voce

Algumas restricoes se sobrepoem a preferencia.

- **`SingleAsync` e uma armadilha no caminho quente.** Olhe a tabela: `SingleAsync` do EF Core e ~3x mais lento que `FirstAsync`. O EF emite `SELECT TOP(2)` para `Single` para poder lancar uma excecao se uma segunda linha existir, e entao faz o trabalho extra de impor a unicidade. Em uma busca por chave primaria onde voce ja sabe que a chave e unica, use `FirstAsync` / `FirstOrDefaultAsync`. Essa unica troca e um ganho maior do que recorrer ao Dapper.
- **O rastreamento de mudancas e o imposto real, nao o motor.** A maioria dos benchmarks de "EF e lento" esquece o `AsNoTracking`. Uma leitura de linha unica rastreada faz contabilidade do rastreador de mudancas que uma leitura do Dapper nunca faz. Para caminhos somente leitura, `AsNoTracking` (ou `AsNoTrackingWithIdentityResolution` quando voce precisa de grafos sem duplicatas) apaga a maior parte da diferenca antes de trocar de biblioteca.
- **Voce nao pode adotar o Dapper pela metade para escritas.** O Dapper nao tem unidade de trabalho. Se o mesmo caminho le, muta e salva, o rastreador de mudancas do EF esta fazendo trabalho real por voce; descer para o Dapper significa escrever o `UPDATE` a mao e perder a consistencia com escopo de transacao. Para o lado de escrita do mesmo equilibrio, veja [EF Core 11 vs Dapper para insercoes em massa](/pt-br/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/), onde nenhum vence e o `SqlBulkCopy` sim.
- **Consultas compiladas refatoram mal.** Elas adicionam uma segunda fonte de verdade para a forma da consulta e fazem as stack traces apontarem para o delegate, nao para o LINQ. Nao compile uma consulta que executa uma vez ou cuja forma varia por chamada; voce ganha zero aceleracao e pior manutenibilidade.

## A recomendacao com criterio, reformulada

Use por padrao LINQ puro do EF Core com `AsNoTracking` para o caminho de leitura. Ele fica dentro de ~5% do Dapper em consultas de lista, aloca menos, e mantem voce em um unico modelo mental. Antes de culpar o EF por ser lento, troque `SingleAsync` por `FirstAsync` e confirme que `AsNoTracking` esta ativo; isso normalmente fecha a lacuna que voce estava prestes a corrigir trocando de biblioteca.

Acrescente os especialistas apenas onde um perfilador apontar. Consultas compiladas em um genuino caminho quente de linha unica que executa milhares de vezes por segundo. SQL bruto via `FromSql` quando o LINQ nao consegue expressar a consulta mas voce ainda quer entidades rastreadas e `Include`, ou `SqlQuery<T>` para um escalar rapido. Dapper quando o orcamento de latencia e inferior ao milissegundo, quando as alocacoes sob carga sustentada sao o limitante, ou quando o SQL e uma consulta de relatorio ajustada a mao que ja nao se parece com suas entidades. A pilha madura do .NET em 2026 nao e "EF ou Dapper"; e EF para o dominio e o ocasional caminho de leitura escolhido a mao delegado ao especialista que os numeros justificarem. Perfile primeiro com [dotnet-trace](/pt-br/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/), e revise o [guia de consultas N+1](/pt-br/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) antes de supor que o mapeador e seu gargalo. Nove em cada dez vezes e a consulta, nao a biblioteca.

## Relacionado

- [Como usar consultas compiladas com EF Core para caminhos quentes](/pt-br/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [EF Core 11 vs Dapper para insercoes em massa: benchmark real](/pt-br/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/)
- [Como detectar consultas N+1 no EF Core 11](/pt-br/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [Dapper, NVARCHAR e a conversao implicita que mata os indices do SQL Server](/pt-br/2026/04/dapper-nvarchar-implicit-conversion-kills-sql-server-indexes/)
- [Como perfilar um app .NET com dotnet-trace e ler a saida](/pt-br/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/)

## Fontes

- [Consultas SQL -- EF Core, Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries)
- [Desempenho avancado do EF Core: consultas compiladas -- Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics)
- [EF Core 9 vs Dapper Performance Face-Off -- Trailhead Technology](https://trailheadtechnology.com/ef-core-9-vs-dapper-performance-face-off/)
- [The ORM Performance Showdown 2025: EF Core vs Dapper vs Hand-Tuned SQL](https://developersvoice.com/blog/database/orm-showdown-2025/)
- [Dapper -- repositorio oficial](https://github.com/DapperLib/Dapper)
