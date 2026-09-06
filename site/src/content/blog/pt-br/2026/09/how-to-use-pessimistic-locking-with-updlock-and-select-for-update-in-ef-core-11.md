---
title: "Como usar bloqueio pessimista com UPDLOCK e SELECT ... FOR UPDATE no EF Core 11"
description: "O EF Core 11 continua sem uma API de bloqueio. Veja como obter um bloqueio de linha real com FromSql: WITH (UPDLOCK, ROWLOCK) no SQL Server, FOR UPDATE no PostgreSQL, a armadilha da subconsulta que amplia o bloqueio em silêncio, NOWAIT e SKIP LOCKED, retentativas de deadlock e o que fazer quando a linha ainda não existe."
pubDate: 2026-09-06
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "concurrency"
  - "sql-server"
  - "postgresql"
  - "dotnet-11"
  - "how-to"
lang: "pt-br"
translationOf: "2026/09/how-to-use-pessimistic-locking-with-updlock-and-select-for-update-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-09-06
---

Resposta curta: o EF Core 11 não tem uma API de bloqueio pessimista, então você obtém o bloqueio manualmente com `FromSql` dentro de uma transação explícita. No SQL Server isso é `SELECT * FROM [Orders] WITH (UPDLOCK, ROWLOCK) WHERE [Id] = {id}`; no PostgreSQL é `SELECT * FROM "Orders" WHERE "Id" = {id} FOR UPDATE`. Duas regras fazem isso funcionar e são quase sempre o que as pessoas erram: a consulta precisa rodar dentro de uma transação que você mesmo abriu (caso contrário o bloqueio é liberado no instante em que o leitor termina), e a cláusula `WHERE` precisa ficar dentro da string do `FromSql`, não em um `.Where()` do LINQ encadeado depois.

Este artigo cobre o SQL exato que o EF Core emite para cada formato, por que compor LINQ sobre uma consulta com bloqueio amplia silenciosamente o bloqueio para a tabela inteira, como `NOWAIT` e `SKIP LOCKED` mudam o modo de falha, como repetir um deadlock sem brigar com a estratégia de resiliência de conexão, e o caso sobre o qual ninguém escreve: bloquear uma linha que ainda não existe.

Uma observação sobre versões. O EF Core 11 está em preview em setembro de 2026 e sai junto com o .NET 11 em novembro de 2026, conforme a [página de versões e planejamento do EF Core](https://learn.microsoft.com/en-us/ef/core/what-is-new/). O EF11 exige o runtime do .NET 11. Como o único SDK nesta máquina é o .NET 10.0.302, cada trecho de SQL gerado abaixo foi produzido com `ToQueryString()` sobre `Microsoft.EntityFrameworkCore.SqlServer` 10.0.10 e `Npgsql.EntityFrameworkCore.PostgreSQL` 10.0.3. Nada nessa área mudou no EF11: a página [What's New in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) não lista mudanças em `FromSql`, transações ou bloqueios.

## O EF Core continua sem uma API de bloqueio, e isso é proposital

O pedido está aberto desde setembro de 2021 como [dotnet/efcore#26042, "Support SELECT FOR UPDATE / UPDLOCK (pessimistic concurrency)"](https://github.com/dotnet/efcore/issues/26042). Está marcado como `needs-design` e fica no marco Backlog, sem versão alvo. O EF Core 11 não o fecha.

O motivo pelo qual uma API genérica é difícil aparece no resto deste artigo: o SQL Server expressa o bloqueio como uma dica de tabela anexada a uma referência de tabela, o PostgreSQL o expressa como uma cláusula no nível da instrução com quatro intensidades diferentes, e os dois discordam sobre o que acontece com joins, `LIMIT` e linhas que não existem. Não há um formato que mapeie bem nos dois. Então você escreve o SQL.

A alternativa, à qual você deveria recorrer primeiro, é um token de concorrência `rowversion`. Bloqueio pessimista é a ferramenta certa apenas quando o trabalho conflitante acontece dentro de uma única transação curta no servidor. Se houver uma pessoa no meio do ciclo ler-modificar-escrever, use [um token de concorrência rowversion no EF Core 11](/pt-br/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/): você não consegue manter uma transação de banco de dados aberta durante a pausa para o café de um usuário.

## A configuração, em quatro passos

1. **Abra uma transação explícita.** `await using var tx = await context.Database.BeginTransactionAsync();`. Todo bloqueio de linha vive e morre com uma transação. Sem ela, o EF Core envolve a leitura na própria transação implícita, que faz commit assim que o leitor se esgota, e o bloqueio some microssegundos depois.
2. **Leia a linha por meio de `FromSql`, com o filtro dentro da string SQL.** A sintaxe de bloqueio precisa estar sobre a referência de tabela que é realmente percorrida.
3. **Altere a entidade rastreada e chame `SaveChangesAsync`.** Resultados de `FromSql` são rastreados por padrão, exatamente como qualquer outra consulta LINQ, então o update é gerado para você.
4. **Faça commit.** O bloqueio é liberado no commit ou no rollback, e não antes.

Aqui está a versão do SQL Server de ponta a ponta:

```csharp
// EF Core 11 (verified on EF Core 10.0.10), .NET 11, C# 14
await using var tx = await context.Database.BeginTransactionAsync();

var order = await context.Orders
    .FromSql($"SELECT * FROM [Orders] WITH (UPDLOCK, ROWLOCK) WHERE [Id] = {orderId}")
    .SingleAsync();

order.Status = "Confirmed";
await context.SaveChangesAsync();

await tx.CommitAsync();
```

E a versão do PostgreSQL, que é o mesmo código com outra string:

```csharp
// Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3
await using var tx = await context.Database.BeginTransactionAsync();

var order = await context.Orders
    .FromSql($"""SELECT * FROM "Orders" WHERE "Id" = {orderId} FOR UPDATE""")
    .SingleAsync();

order.Status = "Confirmed";
await context.SaveChangesAsync();

await tx.CommitAsync();
```

A interpolação do `FromSql` não é concatenação de string. O espaço `{orderId}` vira um `DbParameter`, e é por isso que isso é seguro contra injeção. O `ToQueryString()` confirma:

```sql
-- SQL Server, from ToQueryString()
DECLARE p0 int = 42;

SELECT * FROM [Orders] WITH (UPDLOCK, ROWLOCK) WHERE [Id] = @p0
```

Uma restrição da [documentação de consultas SQL do EF Core](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries): o conjunto de resultados precisa conter uma coluna para cada propriedade mapeada da entidade, com os nomes de coluna mapeados. `SELECT *` atende a isso. Um conjunto de colunas escrito à mão que esqueça uma propriedade lança erro na materialização, que é o assunto de [a coluna obrigatória não estava presente nos resultados de uma operação FromSql](/pt-br/2026/07/fix-the-required-column-was-not-present-in-the-results-of-a-fromsql-operation-in-ef-core-11/).

## O que o UPDLOCK realmente traz no SQL Server

`UPDLOCK` obtém bloqueios de atualização (U) em vez de bloqueios compartilhados (S) e, conforme a [referência de dicas de tabela](https://learn.microsoft.com/en-us/sql/t-sql/queries/hints-transact-sql-table), os mantém até a transação terminar. Essa segunda metade é o ponto inteiro. Um `SELECT` simples sob `READ COMMITTED` obtém bloqueios compartilhados e os solta assim que a linha foi lida, então duas transações podem ambas ler, ambas decidir escrever, e então entrar em deadlock enquanto cada uma tenta converter seu bloqueio S em um bloqueio X. Bloqueios U não são compatíveis entre si, então o segundo leitor bloqueia na leitura em vez de causar deadlock na escrita. Esse deadlock de conversão é o sintoma clássico que leva as pessoas a procurar esse recurso.

Três detalhes que valem ser internalizados:

- **`ROWLOCK` é um pedido de granularidade, não uma garantia.** Ele pede bloqueios de linha onde o SQL Server normalmente obteria bloqueios de página ou de tabela. Adicione-o para que a varredura de algumas poucas linhas não escale para um bloqueio de página sobre linhas que você nunca tocou. Se `UPDLOCK` acabar combinado com `TABLOCK` por qualquer motivo, a documentação diz que você recebe um bloqueio exclusivo de tabela, o que raramente é o que se queria.
- **`UPDLOCK` sozinho não impede inserts.** Ele bloqueia as linhas que existem. Se sua lógica é "some as linhas deste pedido e então insira mais uma", outra transação pode inserir uma linha que muda a soma. Adicione `HOLDLOCK`, que a documentação descreve como equivalente a `SERIALIZABLE`, para obter bloqueios de faixa de chaves sobre o predicado durante toda a transação: `WITH (UPDLOCK, HOLDLOCK, ROWLOCK)`.
- **Os bloqueios podem cair em chaves de índice, não em linhas de dados.** A seção de observações é explícita: se um índice não clusterizado de cobertura responde à consulta, o bloqueio é obtido sobre a chave do índice. Normalmente invisível, ocasionalmente o motivo pelo qual duas consultas que você achava disjuntas se bloqueiam.

Note também a descontinuação: dicas de tabela sem a palavra-chave `WITH` ainda são interpretadas, mas a Microsoft marcou esse formato para remoção. Escreva `WITH (UPDLOCK, ROWLOCK)`, com vírgulas entre as dicas, não `(UPDLOCK ROWLOCK)`.

## O PostgreSQL tem quatro intensidades de bloqueio, e FOR UPDATE é a mais forte

A [documentação da cláusula de bloqueio do SELECT](https://www.postgresql.org/docs/current/sql-select.html) define `FOR UPDATE`, `FOR NO KEY UPDATE`, `FOR SHARE` e `FOR KEY SHARE`, em intensidade decrescente. `FOR UPDATE` bloqueia todos os outros que queiram bloquear, além de `UPDATE` e `DELETE`. `FOR NO KEY UPDATE` é o que um `UPDATE` simples que não toca em coluna de chave obtém por conta própria, e é a escolha certa quando você só altera colunas que não são chave e não quer bloquear as verificações de chave estrangeira de tabelas filhas, que obtêm `FOR KEY SHARE`.

O padrão que pega as pessoas é `FOR UPDATE` combinado com `Include`. O PostgreSQL se recusa a bloquear o lado anulável de um outer join: "FOR UPDATE cannot be applied to the nullable side of an outer join". A correção é `FOR UPDATE OF "Orders"`, nomeando apenas a tabela que você realmente quer bloquear. No EF Core esse problema quase se resolve sozinho, porque o `Include` compõe sobre o seu `FromSql` como uma subconsulta e o join fica fora dela:

```sql
-- Npgsql, FromSql with FOR UPDATE plus .Include(o => o.Lines)
SELECT o."Id", o."Status", o."Total", o0."Id", o0."OrderId", o0."Quantity"
FROM (
    SELECT * FROM "Orders" WHERE "Id" = @p0 FOR UPDATE
) AS o
LEFT JOIN "OrderLines" AS o0 ON o."Id" = o0."OrderId"
ORDER BY o."Id"
```

A linha de `Orders` fica bloqueada, as linhas de `OrderLines` não. Se você precisar bloquear as linhas também, bloqueie-as em um segundo `FromSql` contra `OrderLines`, em uma ordem consistente.

## A armadilha da subconsulta que amplia seu bloqueio em silêncio

Este é o modo de falha que eu apostaria dinheiro que existe em código de produção. `FromSql` compõe: qualquer operador LINQ encadeado depois transforma seu SQL em uma tabela derivada. Tire o filtro da string e coloque-o em `.Where()`, e é isto que o EF Core gera:

```sql
-- Npgsql: .FromSql($"""SELECT * FROM "Orders" FOR UPDATE""").Where(o => o.Status == "Pending")
SELECT o."Id", o."Status", o."Total"
FROM (
    SELECT * FROM "Orders" FOR UPDATE
) AS o
WHERE o."Status" = 'Pending'
```

O `FOR UPDATE` agora está preso a uma varredura sem filtro de `Orders`. O PostgreSQL não empurra o predicado externo para dentro de uma subconsulta que carrega uma cláusula de bloqueio, porque isso mudaria quais linhas seriam bloqueadas. A documentação faz a mesma observação na solução alternativa para `ORDER BY`: `SELECT * FROM (SELECT * FROM mytable FOR UPDATE) ss ORDER BY column1` "bloqueia todas as linhas". Ou seja, essa consulta bloqueia todas as linhas da tabela e trava todos os outros escritores, e faz isso sem erro, sem aviso e sem nada no plano de consulta que pareça obviamente errado.

O SQL Server produz o mesmo formato e um problema mais sutil:

```sql
-- SQL Server: .FromSql($"SELECT * FROM [Orders] WITH (UPDLOCK, ROWLOCK)").Where(o => o.Status == "Pending")
SELECT [o].[Id], [o].[Status], [o].[Total]
FROM (
    SELECT * FROM [Orders] WITH (UPDLOCK, ROWLOCK)
) AS [o]
WHERE [o].[Status] = N'Pending'
```

Uma tabela derivada não é uma barreira de otimização no T-SQL, então o otimizador pode ou não empurrar o predicado para dentro dela. Quais linhas acabam bloqueadas vira uma propriedade do plano escolhido, e não do seu código. Esse não é um bug que você queira depurar às 3 da manhã.

A regra: tudo que reduz o conjunto de linhas vai dentro da string do `FromSql`. Encadeie LINQ depois apenas para coisas que não possam ampliar o bloqueio, como `Include` ou uma projeção. E verifique uma vez, com `ToQueryString()` em um teste ou [registrando em log o SQL que o EF Core 11 gera](/pt-br/2026/07/how-to-log-the-sql-that-ef-core-11-generates/).

## NOWAIT e SKIP LOCKED: escolhendo sua falha

Por padrão, um pedido de bloqueio travado espera. Os dois bancos oferecem duas alternativas.

**Falhar rápido.** O `FOR UPDATE NOWAIT` do PostgreSQL lança o SQLSTATE `55P03` (`lock_not_available`) imediatamente, em vez de esperar. A dica de tabela `NOWAIT` do SQL Server é documentada como equivalente a `SET LOCK_TIMEOUT 0` para aquela tabela, e aparece como o erro 1222, "Lock request time out period exceeded". De qualquer forma você obtém uma exceção que pode traduzir em um 409, em vez de uma requisição parada em uma thread por trinta segundos:

```csharp
// Npgsql: fail immediately rather than queue behind another worker
try
{
    var order = await context.Orders
        .FromSql($"""SELECT * FROM "Orders" WHERE "Id" = {orderId} FOR UPDATE NOWAIT""")
        .SingleAsync();
}
catch (PostgresException ex) when (ex.SqlState == "55P03")
{
    return Results.Conflict("Order is being modified by another request.");
}
```

**Pular as linhas disputadas.** Este é o padrão de fila de jobs, e é o único caso em que o bloqueio pessimista é inequivocamente o design certo. O PostgreSQL escreve isso como `SKIP LOCKED`; o SQL Server escreve como `READPAST`, que a documentação descreve como construído justamente "para reduzir a contenção de bloqueios ao implementar uma fila de trabalho que usa uma tabela do SQL Server".

```csharp
// SQL Server: claim up to 10 unclaimed jobs, skipping rows other workers hold
await using var tx = await context.Database.BeginTransactionAsync();

var jobs = await context.Jobs
    .FromSql($"""
        SELECT TOP (10) * FROM [Jobs] WITH (UPDLOCK, READPAST, ROWLOCK)
        WHERE [Status] = 'Queued' ORDER BY [Id]
        """)
    .ToListAsync();

foreach (var job in jobs)
{
    job.Status = "Running";
}

await context.SaveChangesAsync();
await tx.CommitAsync();
```

Duas restrições sobre o `READPAST`. Ele pula bloqueios em nível de linha, mas não em nível de página, o que é mais um motivo para combiná-lo com `ROWLOCK`. E ele não pode ser usado quando `READ_COMMITTED_SNAPSHOT` está `ON` e o nível de isolamento da sessão é `READ COMMITTED`; nessa configuração você precisa adicionar a dica `READCOMMITTEDLOCK`. No PostgreSQL, `SKIP LOCKED` te dá uma visão deliberadamente inconsistente, o que serve para uma fila e é errado para qualquer coisa que você pretenda agregar.

## Deadlocks continuam acontecendo, então tenha retentativa

O bloqueio pessimista converte a maioria dos conflitos de escrita em espera, mas não elimina deadlocks: duas transações que bloqueiam as linhas A e depois B, e B e depois A, ainda entram em deadlock (erro 1205 do SQL Server, SQLSTATE `40P01` do PostgreSQL). A correção estrutural barata é sempre adquirir os bloqueios em uma ordem determinística, o que normalmente significa ordenar por chave primária antes de começar a bloquear.

Para o resto, tente de novo. Se você habilitou `EnableRetryOnFailure`, note que a estratégia de execução com retentativas se recusa a envolver uma transação que você mesmo abriu e lança `InvalidOperationException`. A unidade de trabalho inteira precisa passar pela estratégia, o que é coberto em detalhe em [a estratégia de execução não dá suporte a transações iniciadas pelo usuário](/pt-br/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/):

```csharp
var strategy = context.Database.CreateExecutionStrategy();

await strategy.ExecuteAsync(async () =>
{
    await using var tx = await context.Database.BeginTransactionAsync();

    var order = await context.Orders
        .FromSql($"SELECT * FROM [Orders] WITH (UPDLOCK, ROWLOCK) WHERE [Id] = {orderId}")
        .SingleAsync();

    order.Status = "Confirmed";
    await context.SaveChangesAsync();
    await tx.CommitAsync();
});
```

Uma ressalva: a `SqlServerRetryingExecutionStrategy` padrão do EF repete uma lista específica de números de erro transitórios do SQL Server. Verifique se os deadlocks estão no conjunto que interessa a você, ou forneça seu próprio `errorNumbersToAdd`, em vez de assumir que o 1205 é tratado.

## Você não consegue bloquear uma linha que não existe

A maior limitação de todas. `SELECT ... FOR UPDATE` sobre uma linha que ainda não foi inserida retorna zero linhas e não bloqueia nada, então a clássica corrida de "verifique se este nome de usuário já existe e então insira" fica completamente desprotegida por bloqueios de linha. Duas transações veem nada, ambas inserem, e uma delas recebe uma violação de restrição única, que é exatamente o cenário de [fix 23505 duplicate key value violates unique constraint em um insert concorrente do EF Core](/pt-br/2026/08/fix-23505-duplicate-key-value-violates-unique-constraint-on-a-concurrent-ef-core-insert/).

Três saídas, em ordem crescente de quanto você deveria gostar delas:

- **Um índice único mais uma exceção capturada.** O banco de dados garante, você traduz a exceção do provedor em um erro de domínio. Chato, correto e a resposta padrão.
- **Um bloqueio de predicado.** No SQL Server, `WITH (UPDLOCK, HOLDLOCK)` sobre o `WHERE` que teria correspondido obtém um bloqueio de faixa de chaves e de fato trava o insert concorrente. O PostgreSQL não tem equivalente direto além do nível de isolamento `SERIALIZABLE`.
- **Um bloqueio consultivo com chave no valor.** O `pg_advisory_xact_lock(key)` do PostgreSQL obtém um bloqueio sobre um número arbitrário de 64 bits que é liberado automaticamente no fim da transação (ao contrário do `pg_advisory_lock`, que tem escopo de sessão e sobrevive a um rollback). O equivalente do SQL Server é `sys.sp_getapplock` com `@LockOwner = 'Transaction'` e um nome de recurso em string, retornando `0` ou `1` em caso de sucesso e `-1` para timeout, `-3` para vítima de deadlock.

```csharp
// PostgreSQL: serialise on a logical key rather than a row
await using var tx = await context.Database.BeginTransactionAsync();
await context.Database.ExecuteSqlAsync($"SELECT pg_advisory_xact_lock({tenantId})");
// ... read, decide, insert ...
await tx.CommitAsync();
```

Bloqueios consultivos são a ferramenta certa quando o que você está serializando é uma decisão, e não uma linha: "apenas um worker pode rodar a consolidação noturna deste tenant".

## Quando recorrer a algo totalmente diferente

Se a operação inteira é uma única atualização aritmética, não bloqueie nada. `UPDATE Accounts SET Balance = Balance - 10 WHERE Id = 1 AND Balance >= 10` é atômica, obtém seu próprio bloqueio exclusivo pela duração da instrução, e informa pela contagem de linhas afetadas se a pré-condição valia. No EF Core isso é `ExecuteUpdateAsync`, e as trocas em relação a carregar a entidade estão cobertas em [ExecuteUpdate versus carregar entidades e SaveChanges](/pt-br/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/). Um bloqueio pessimista só se justifica quando há lógica real entre a leitura e a escrita que o SQL não consegue expressar.

E mantenha a transação curta. Tudo que você fizer entre `BeginTransactionAsync` e `CommitAsync` é tempo que outras requisições passam travadas. Uma chamada HTTP a um provedor de pagamentos dentro de uma transação que segura bloqueios é como uma única dependência lenta derruba uma tabela inteira.

### Leia a seguir

- [Como implementar concorrência otimista com um token rowversion no EF Core 11](/pt-br/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/)
- [Fix: a estratégia de execução não dá suporte a transações iniciadas pelo usuário](/pt-br/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/)
- [Fix: a coluna obrigatória não estava presente nos resultados de uma operação FromSql no EF Core 11](/pt-br/2026/07/fix-the-required-column-was-not-present-in-the-results-of-a-fromsql-operation-in-ef-core-11/)
- [Como registrar em log o SQL que o EF Core 11 gera](/pt-br/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [ExecuteUpdate versus carregar entidades e SaveChanges no EF Core](/pt-br/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/)

## Fontes

- [Support SELECT FOR UPDATE / UPDLOCK (pessimistic concurrency), dotnet/efcore#26042](https://github.com/dotnet/efcore/issues/26042), aberta desde 2021 e ainda no marco Backlog.
- [Table hints (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/queries/hints-transact-sql-table) para `UPDLOCK`, `HOLDLOCK`, `ROWLOCK`, `READPAST`, `NOWAIT`, a descontinuação da palavra-chave `WITH` e o bloqueio em chaves de índice.
- [SELECT, The Locking Clause](https://www.postgresql.org/docs/current/sql-select.html) para as quatro intensidades de bloqueio, `NOWAIT`, `SKIP LOCKED`, a lista `OF table` e a nota sobre bloqueio em subconsultas.
- [Explicit locking, documentação do PostgreSQL](https://www.postgresql.org/docs/current/explicit-locking.html) para a matriz de conflitos de bloqueios de linha e os bloqueios consultivos com escopo de transação.
- [SQL queries in EF Core](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries) para a parametrização do `FromSql`, a componibilidade, o encapsulamento em subconsulta e o rastreamento de mudanças.
- [sys.sp_getapplock (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-getapplock-transact-sql) para os modos de bloqueio, a propriedade por transação versus por sessão e os códigos de retorno.
- [What's New in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew), que confirma que o EF11 exige o runtime do .NET 11 e não lista mudanças de bloqueio ou de `FromSql`.
