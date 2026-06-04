---
title: "EF Core ExecuteUpdate versus carregar entidades e SaveChanges: qual você deve usar?"
description: "Um guia de decisão e um benchmark real para o EF Core 11: use ExecuteUpdate para escritas baseadas em conjunto por predicado, e o caminho carregar-depois-SaveChanges apenas quando você precisa do rastreador de mudanças, dos interceptadores ou de um grafo de objetos complexo."
pubDate: 2026-06-04
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "ef-core-11"
  - "csharp"
  - "dotnet-11"
  - "performance"
lang: "pt-br"
translationOf: "2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges"
translatedBy: "claude"
translationDate: 2026-06-04
---

Resposta curta: se você está alterando linhas que correspondem a um predicado e não precisa das entidades em memória depois, use `ExecuteUpdateAsync`. Ele compila para um único `UPDATE` que roda inteiramente no banco de dados, sem carregar linhas e sem rastreamento de mudanças, e é uma a duas ordens de magnitude mais rápido depois que você passa de algumas centenas de linhas. Volte ao padrão carregar-depois-`SaveChanges` apenas quando você realmente precisa do que o rastreador de mudanças oferece: tokens de concorrência verificados automaticamente, interceptadores de `SaveChanges` e eventos de domínio, comportamento de cascata sobre um grafo rastreado, ou lógica detalhada por entidade que não pode ser expressa como uma única instrução SQL.

Este artigo compara as duas abordagens no `Microsoft.EntityFrameworkCore` 11.0.0 rodando sobre .NET 11 contra o SQL Server 2025, com C# 14. As duas não são ferramentas intercambiáveis que apenas diferem em velocidade: elas ficam em camadas diferentes. `SaveChanges` é a unidade de trabalho sobre entidades rastreadas; `ExecuteUpdate` é um wrapper tipado sobre uma instrução SQL baseada em conjunto. Escolher corretamente é, acima de tudo, ser honesto sobre em qual camada sua operação realmente vive.

## As duas formas, lado a lado

O caminho rastreado carrega, muta e salva:

```csharp
// .NET 11, EF Core 11.0.0 - tracked: load, mutate, save
var employees = await context.Employees
    .Where(e => e.DepartmentId == departmentId)
    .ToListAsync();

foreach (var e in employees)
{
    e.Salary += 1000;
}

await context.SaveChangesAsync();
```

O caminho baseado em conjunto descreve a mudança como um predicado mais um atribuidor:

```csharp
// .NET 11, EF Core 11.0.0 - set-based: one UPDATE, nothing loaded
await context.Employees
    .Where(e => e.DepartmentId == departmentId)
    .ExecuteUpdateAsync(s => s.SetProperty(e => e.Salary, e => e.Salary + 1000));
```

A primeira versão realiza um `SELECT` que traz cada linha correspondente ao cliente, constrói um snapshot de rastreamento de mudanças por entidade, compara cada um no `SaveChanges` e então emite um `UPDATE` por linha alterada (em lote, mas ainda parametrizado individualmente). A segunda emite uma única instrução:

```sql
UPDATE [e]
SET [e].[Salary] = [e].[Salary] + 1000
FROM [Employees] AS [e]
WHERE [e].[DepartmentId] = @departmentId
```

Para a mecânica completa dos métodos baseados em conjunto, o SQL que eles emitem, os atribuidores de várias colunas e os atribuidores delegados do EF Core 10, veja o guia complementar sobre [ExecuteUpdate e ExecuteDelete para escritas em massa](/pt-br/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/). Este artigo é sobre escolher entre eles e o caminho rastreado.

## Matriz de recursos

| Recurso | Carregar + SaveChanges | ExecuteUpdate / ExecuteDelete |
| ----------------------------- | ------------------------------------ | --------------------------------- |
| Linhas carregadas ao cliente | todas as linhas correspondentes | nenhuma |
| Snapshot do rastreador | um por entidade | nenhum |
| Idas e voltas | 1 SELECT + UPDATEs em lote | 1 |
| SQL emitido | um UPDATE por entidade (em lote) | um UPDATE baseado em conjunto |
| Tokens de concorrência automáticos | sim (`DbUpdateConcurrencyException`) | não, manual via contagem de linhas |
| Interceptadores / eventos de SaveChanges | sim | não |
| Exclusão em cascata sobre o grafo | sim (rastreado) | apenas cascata de FK no banco |
| Disponível desde | sempre | EF Core 7.0 |
| Suporte a inserção | sim (`Add`) | não, apenas atualizar e excluir |
| Atômico entre instruções | uma transação por SaveChanges | você abre a transação |

A matriz se divide de forma limpa ao longo de um eixo: tudo o que `SaveChanges` faz por você é consequência de materializar e rastrear entidades, e tudo no que `ExecuteUpdate` é mais rápido é consequência de se recusar a fazer isso.

## Quando escolher ExecuteUpdate / ExecuteDelete

- **Escritas baseadas em conjunto por predicado.** "Marcar como arquivado todo pedido com mais de 90 dias", "excluir todas as linhas marcadas como removidas", "incrementar um contador". A mudança é expressável como `WHERE` mais `SET`, e você não precisa das linhas depois. Esta é a opção padrão para trabalhos de manutenção em massa e limpeza no EF Core 11.
- **Leitura-modificação-escrita atômica sobre um único valor.** `SetProperty(b => b.Balance, b => b.Balance - amount)` calcula o novo valor no banco de dados em uma única instrução, sem janela para outra transação se infiltrar entre sua leitura e sua escrita. O caminho rastreado abre exatamente essa janela porque lê em uma ida e volta e escreve em outra.
- **Endpoints de uma única linha em caminhos quentes com um token de concorrência.** Coloque o token no `Where` e verifique a contagem de linhas afetadas. Isso costuma ser mais rápido que o caminho rastreado mesmo para uma única linha, porque pula o `SELECT` e o snapshot por completo. Combina naturalmente com as [consultas compiladas em caminhos quentes](/pt-br/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/).
- **Você já está lutando contra idas e voltas por linha.** Se você recorreu a um `foreach` sobre uma consulta de rastreamento, está fazendo a mesma coisa que torna lenta uma [consulta N+1](/pt-br/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/): trabalho linha a linha que o banco de dados poderia fazer em uma única operação baseada em conjunto.

## Quando escolher carregar + SaveChanges

- **Você precisa de concorrência otimista automática.** Com um token `[Timestamp]` / `rowversion`, `SaveChanges` o adiciona ao `WHERE`, conta as linhas afetadas e lança `DbUpdateConcurrencyException` para você resolver o conflito. `ExecuteUpdate` não fará isso por você; você tem que inspecionar a contagem por conta própria.
- **Interceptadores de `SaveChanges`, auditoria ou eventos de domínio.** Se você tem um `ISaveChangesInterceptor` carimbando `ModifiedUtc`, escrevendo uma linha de auditoria ou despachando eventos de domínio, uma instrução baseada em conjunto contorna tudo isso. A escrita acontece, mas nada da sua lógica transversal roda.
- **Grafos de objetos complexos e comportamento de cascata.** Inserir ou modificar um pai com filhos, onde o EF Core descobre a ordenação e as cascatas, é exatamente para o que serve a unidade de trabalho rastreada. Não há `ExecuteInsert`, e as cascatas que você configurou como comportamentos do EF (em vez de cascatas de FK do banco) só rodam através de `SaveChanges`.
- **Lógica por entidade que não é uma única expressão SQL.** Se o novo valor de cada linha depende de código de aplicação (chamar um serviço, ramificar com base em dados que não estão na tabela, calcular algo que o SQL não pode expressar), você tem que carregar as entidades e mutá-las em C#.

## O benchmark

Esta é uma execução do BenchmarkDotNet, .NET 11.0.0, `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0, contra o SQL Server 2025 no mesmo host (Windows 11, 12 núcleos / 32 GB, TCP local, pool de conexões aquecido). Cada iteração atualiza uma única coluna `decimal` em cada linha correspondente de uma tabela `Employees` de 200.000 linhas, variando a seletividade do predicado. O processamento em lote padrão é deixado intacto (o SQL Server limita um lote de `SaveChanges` a 42 instruções). Os tempos são a média da fase de medição do BenchmarkDotNet; menos é melhor.

| Linhas alteradas | Carregar + SaveChanges | ExecuteUpdate | Aceleração |
| ---------------- | ---------------------- | ------------- | ---------- |
| 100 | 11,4 ms | 2,1 ms | ~5x |
| 1.000 | 92 ms | 3,0 ms | ~30x |
| 10.000 | 880 ms | 8,7 ms | ~100x |
| 100.000 | 9.100 ms | 64 ms | ~140x |

A forma é a manchete, não os números exatos: o caminho rastreado escala de forma aproximadamente linear com a contagem de linhas porque paga por um snapshot materializado e um `UPDATE` parametrizado por linha, enquanto `ExecuteUpdate` permanece quase plano porque o banco de dados faz tudo em uma instrução e o cliente nunca vê as linhas. Com 100 linhas a diferença é real, mas pequena o suficiente para que outras preocupações (tokens de concorrência, interceptadores) possam legitimamente decidir por você. Com 10.000 linhas o caminho rastreado está fazendo um trabalho que a instrução baseada em conjunto simplesmente não faz, e nenhuma quantidade de ajuste de `MaxBatchSize` fecha essa lacuna, porque o custo é a materialização e as idas e voltas, não o tamanho do lote. Esses números coincidem com as diferenças de ordem de magnitude relatadas na própria [orientação sobre atualização eficiente](https://learn.microsoft.com/en-us/ef/core/performance/efficient-updating) da Microsoft e em benchmarks independentes como o [artigo sobre atualizações em massa no EF Core](https://www.milanjovanovic.tech/blog/what-you-need-to-know-about-ef-core-bulk-updates) de Milan Jovanovic. Sempre execute novamente no seu próprio esquema e hardware antes de citar um multiplicador; a seletividade, os índices e a largura da linha movem tudo.

Uma coisa que a tabela esconde: ajustar `MaxBatchSize` ajuda o caminho rastreado apenas no meio do intervalo. A documentação observa que o processamento em lote é menos eficiente abaixo de 4 instruções e o benefício se degrada após cerca de 40 para o SQL Server, e é por isso que o limite padrão é 42. Aumentá-lo para 100 reduz um pouco a coluna rastreada com 1.000 linhas e não faz nada significativo com 100.000, porque você ainda está enviando um `UPDATE` por linha pela rede.

## A pegadinha que decide por você: o rastreador de mudanças fica obsoleto

A decisão nem sempre é sobre velocidade. O bug mais comum quando esses dois caminhos se encontram é misturá-los na mesma unidade de trabalho. `ExecuteUpdate` escreve SQL diretamente e nunca diz nada ao rastreador de mudanças, então qualquer entidade que você já carregou mantém seu snapshot obsoleto:

```csharp
// .NET 11, EF Core 11.0.0 - the trap
var blog = await context.Blogs.SingleAsync(b => b.Id == id); // tracked, Rating == 5

await context.Blogs
    .ExecuteUpdateAsync(s => s.SetProperty(b => b.Rating, b => b.Rating + 1)); // DB now 6

blog.Rating += 2;            // in-memory 7, original still recorded as 5
await context.SaveChangesAsync(); // writes 7, silently clobbering the bulk +1
```

Após a escrita em massa, a linha é `6`, mas a instância rastreada nunca soube disso. `SaveChanges` compara o valor atual `7` contra o original `5` que registrou no snapshot, decide que a propriedade mudou e escreve `7`. Seu incremento em massa some. Essa é a mesma categoria de falha que está por trás de ["the instance of entity type cannot be tracked"](/pt-br/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/): o rastreador de mudanças é contabilidade em memória com estado, e escritas por canal lateral não o atualizam.

Se você precisa fazer ambos contra as mesmas linhas, execute primeiro a escrita em massa e depois `context.ChangeTracker.Clear()` antes de consultar de novo, ou consulte as linhas afetadas com `AsNoTracking()` para que nada rastreado possa ficar obsoleto. O mesmo limite é a razão pela qual você não pode testar esses métodos por meio de um substituto em memória; é o raciocínio por trás de [simular um DbContext sem quebrar o rastreamento de mudanças](/pt-br/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/).

A segunda pegadinha são as transações. `SaveChanges` envolve todo o seu lote em uma transação; duas chamadas a `ExecuteUpdate` são duas transações independentes a menos que você abra uma você mesmo sobre `context.Database.BeginTransactionAsync()`. Se você precisa que duas instruções em massa tenham sucesso ou falhem juntas, isso fica por sua conta.

## A recomendação, reafirmada

Use por padrão `ExecuteUpdate` e `ExecuteDelete` para qualquer coisa que seja conceitualmente uma mudança baseada em conjunto: você descreve as linhas com um predicado, descreve a mudança com um atribuidor, e deixa o banco de dados fazer isso em uma instrução. A diferença de desempenho não é marginal depois que você passa de algumas centenas de linhas, e o código é mais curto e claro. Trate o caminho carregar-depois-`SaveChanges` como a escolha deliberada que você faz quando precisa dos serviços do rastreador de mudanças: detecção automática de conflitos de concorrência, interceptadores e eventos de domínio, comportamento de cascata sobre um grafo rastreado, ou lógica por linha que não se reduz a SQL. Esses são recursos reais e valiosos, e quando você precisa deles o caminho rastreado é correto independentemente da velocidade. O que você não deve fazer é recorrer ao laço de rastreamento por hábito para alterar dez mil linhas que um único `UPDATE` resolveria, e você nunca deve deixar os dois caminhos tocarem as mesmas entidades em uma unidade de trabalho sem limpar o rastreador no meio.

Para o caso de *inserção* de alto volume, nenhum dos métodos é a resposta, já que não há `ExecuteInsert`; esse tem seu próprio benchmark em [EF Core 11 versus Dapper para inserções em massa](/pt-br/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/).

## Relacionado

- [Como usar ExecuteUpdate e ExecuteDelete para escritas em massa no EF Core 11](/pt-br/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/)
- [EF Core 11 versus Dapper para inserções em massa: um benchmark real](/pt-br/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/)
- [Como detectar consultas N+1 no EF Core 11](/pt-br/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [Como usar consultas compiladas com EF Core em caminhos quentes](/pt-br/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [Correção: the instance of entity type cannot be tracked because another instance with the same key value is already being tracked](/pt-br/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/)

## Fontes

- [Atualização eficiente - EF Core (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/performance/efficient-updating)
- [ExecuteUpdate e ExecuteDelete - EF Core (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/saving/execute-insert-update-delete)
- [Visão geral de salvamento de dados - EF Core (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/saving/)
- [What you need to know about EF Core bulk updates (Milan Jovanovic)](https://www.milanjovanovic.tech/blog/what-you-need-to-know-about-ef-core-bulk-updates)
