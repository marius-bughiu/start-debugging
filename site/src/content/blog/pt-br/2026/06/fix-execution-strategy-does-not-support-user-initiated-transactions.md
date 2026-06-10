---
title: "Correção: The configured execution strategy 'SqlServerRetryingExecutionStrategy' does not support user-initiated transactions"
description: "EnableRetryOnFailure entra em conflito com BeginTransaction. Envolva toda a transação em db.Database.CreateExecutionStrategy().ExecuteAsync(...) para que ela seja repetida como uma unidade."
pubDate: 2026-06-10
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
lang: "pt-br"
translationOf: "2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions"
translatedBy: "claude"
translationDate: 2026-06-10
---

A correção: você ativou a resiliência de conexão com `EnableRetryOnFailure()` e depois abriu sua própria transação com `BeginTransaction()` ou `BeginTransactionAsync()`. Uma estratégia de execução com novas tentativas não consegue reproduzir uma transação que ela não iniciou, então ela recusa de imediato. Obtenha a estratégia a partir de `db.Database.CreateExecutionStrategy()` e execute a transação inteira dentro de `strategy.ExecuteAsync(...)`. O delegate completo se torna uma única unidade que pode ser repetida.

```text
System.InvalidOperationException: The configured execution strategy 'SqlServerRetryingExecutionStrategy' does not support user-initiated transactions. Use the execution strategy returned by 'DbContext.Database.CreateExecutionStrategy()' to execute all the operations in the transaction as a retriable unit.
   at Microsoft.EntityFrameworkCore.Storage.ExecutionStrategy.ExecuteAsync[TState,TResult](TState state, Func`4 operation, Func`4 verifySucceeded, CancellationToken cancellationToken)
   at Microsoft.EntityFrameworkCore.SqlServer.Storage.Internal.SqlServerExecutionStrategy.Execute[TState,TResult](...)
   at Microsoft.EntityFrameworkCore.Storage.RelationalConnection.BeginTransaction()
```

Este guia foi escrito para .NET 11 e `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0, mas a mensagem e a regra subjacente estão estáveis desde o EF Core 1.1, quando a resiliência de conexão foi lançada. Se você está no EF Core 6, 8 ou 9, tudo abaixo se aplica sem alterações. O nome do tipo na mensagem depende do seu provedor: o SQL Server lança `SqlServerRetryingExecutionStrategy`, o Npgsql lança `NpgsqlRetryingExecutionStrategy`, o provedor de MySQL do Pomelo lança o seu próprio. A correção é idêntica para todos.

## Por que uma estratégia com novas tentativas recusa sua transação

A resiliência de conexão funciona envolvendo cada operação de banco de dados em um laço de novas tentativas. Quando você chama `EnableRetryOnFailure()`, o EF Core troca por uma estratégia de execução que sabe quais números de erro do SQL Server são transitórios (vítimas de deadlock, quedas de conexão, limitação do Azure SQL) e repete essas operações com recuo exponencial. A palavra-chave é *cada*. Cada consulta e cada chamada a `SaveChangesAsync()` se torna sua própria unidade que pode ser repetida. Se uma falha transitoriamente, a estratégia reproduz aquela única operação.

Uma transação quebra esse modelo. Quando você chama `BeginTransactionAsync()`, está dizendo ao EF Core que várias operações formam um único grupo atômico. Se a conexão cair no meio, repetir uma única instrução não tem sentido: o servidor já reverteu a transação, e reproduzir um único `INSERT` dentro de uma transação que não existe mais falharia ou, pior, confirmaria trabalho parcial. A estratégia de execução não tem como saber o que sua transação deveria conter, então não consegue reproduzi-la corretamente.

Em vez de repetir de forma incorreta e arriscar a corrupção de dados, o EF Core lança a exceção no momento em que você tenta iniciar uma transação definida pelo usuário enquanto uma estratégia com novas tentativas está ativa. A orientação oficial é direta sobre o que está em jogo: uma nova tentativa ingênua através de um limite de confirmação "poderia levar à corrupção de dados" se a operação depender do estado do armazenamento. A exceção é uma proteção, não um bug.

## O menor código que dispara o erro

```csharp
// .NET 11, Microsoft.EntityFrameworkCore.SqlServer 11.0.0
builder.Services.AddDbContext<AppDb>(options =>
    options.UseSqlServer(
        connectionString,
        sql => sql.EnableRetryOnFailure())); // <-- resiliency on

// ...somewhere in a service:
public async Task TransferAsync(int fromId, int toId, decimal amount)
{
    await using var tx = await _db.Database.BeginTransactionAsync(); // <-- throws here

    var from = await _db.Accounts.FindAsync(fromId);
    var to = await _db.Accounts.FindAsync(toId);
    from!.Balance -= amount;
    to!.Balance += amount;

    await _db.SaveChangesAsync();
    await tx.CommitAsync();
}
```

A linha `BeginTransactionAsync()` nunca retorna uma transação. O EF Core verifica primeiro se há uma estratégia com novas tentativas ativa e lança o `InvalidOperationException`. Note que você não precisa chamar `BeginTransaction` explicitamente para cair nisso: qualquer coisa que abra uma transação de usuário conta, incluindo um `TransactionScope` que você mesmo criou.

## Correção 1: envolva a transação na estratégia de execução

Esta é a correção canônica e a que a Microsoft documenta. Peça ao contexto sua estratégia de execução e então passe um delegate que contenha a transação inteira, de `BeginTransactionAsync` até `CommitAsync`. Se uma falha transitória ocorrer em qualquer ponto interno, a estratégia executa novamente o delegate completo, transação inclusa.

```csharp
// .NET 11, Microsoft.EntityFrameworkCore.SqlServer 11.0.0
public async Task TransferAsync(int fromId, int toId, decimal amount)
{
    var strategy = _db.Database.CreateExecutionStrategy();

    await strategy.ExecuteAsync(async () =>
    {
        await using var tx = await _db.Database.BeginTransactionAsync();

        var from = await _db.Accounts.FindAsync(fromId);
        var to = await _db.Accounts.FindAsync(toId);
        from!.Balance -= amount;
        to!.Balance += amount;

        await _db.SaveChangesAsync();
        await tx.CommitAsync();
    });
}
```

`CreateExecutionStrategy()` retorna a mesma estratégia com novas tentativas que o EF Core configurou a partir da sua chamada a `EnableRetryOnFailure()`. Quando a resiliência está desativada, ela retorna uma estratégia sem efeito que executa o delegate exatamente uma vez, então este código é seguro de escrever mesmo em projetos onde as novas tentativas não estão habilitadas. Isso faz de `strategy.ExecuteAsync` um invólucro padrão razoável para qualquer transação explícita, não apenas para as de aplicativos hospedados no Azure.

Há uma regra que pega as pessoas de surpresa: o delegate precisa ser idempotente o suficiente para rodar do início mais de uma vez. Não leia um valor antes da chamada a `strategy.ExecuteAsync`, o modifique e dependa dessa leitura dentro da nova tentativa. Traga cada leitura e escrita para dentro do delegate para que uma repetição comece do zero.

## Correção 2: ExecuteInTransactionAsync quando você precisa verificar a confirmação

`strategy.ExecuteAsync` resolve o caso comum, mas tem um ponto cego. Se a conexão cair *enquanto a confirmação está em andamento*, a estratégia não sabe se o servidor realmente confirmou. Por padrão ela assume uma reversão e reproduz, o que pode inserir uma linha duplicada se você usar chaves geradas pelo armazenamento.

`ExecuteInTransactionAsync` fecha essa lacuna. Ela inicia e confirma a transação por você e aceita um delegate `verifySucceeded` que roda após uma falha de confirmação transitória para verificar se o trabalho foi aplicado.

```csharp
// .NET 11, Microsoft.EntityFrameworkCore.SqlServer 11.0.0
var strategy = _db.Database.CreateExecutionStrategy();

var blog = new Blog { Url = "https://startdebugging.net" };
_db.Blogs.Add(blog);

await strategy.ExecuteInTransactionAsync(
    _db,
    operation: (ctx, ct) => ctx.SaveChangesAsync(acceptAllChangesOnSuccess: false, ct),
    verifySucceeded: (ctx, ct) =>
        ctx.Blogs.AsNoTracking().AnyAsync(b => b.BlogId == blog.BlogId, ct));

_db.ChangeTracker.AcceptAllChanges();
```

Dois detalhes importam aqui. `SaveChangesAsync` é chamado com `acceptAllChangesOnSuccess: false` para que as entidades rastreadas permaneçam no estado `Added` até você saber que a confirmação foi aplicada; é isso que permite uma reprodução limpa. Você então chama `ChangeTracker.AcceptAllChanges()` uma vez depois que a estratégia retorna. A consulta de `verifySucceeded` usa `AsNoTracking()` para que a leitura de verificação não conflite com as entidades ainda pendentes no rastreador de mudanças.

Se você realmente não se importa com a rara falha no meio da confirmação, a opção "não fazer quase nada" da Microsoft é evitar chaves geradas pelo armazenamento (use um `Guid` do lado do cliente) para que uma reprodução cega lance uma violação de chave primária em vez de duplicar dados em silêncio. Então a Correção 1 é suficiente.

## Transações ambientais e TransactionScope

O mesmo invólucro funciona com `TransactionScope`, inclusive quando ele abrange dois contextos. Abra o escopo e chame `Complete()` dentro do delegate.

```csharp
// .NET 11, Microsoft.EntityFrameworkCore.SqlServer 11.0.0
var strategy = _db.Database.CreateExecutionStrategy();

await strategy.ExecuteAsync(async () =>
{
    using var scope = new TransactionScope(
        TransactionScopeAsyncFlowOption.Enabled); // required for await inside

    _db.Orders.Add(order);
    await _db.SaveChangesAsync();

    await _auditDb.SaveChangesAsync();

    scope.Complete();
});
```

Sem `TransactionScopeAsyncFlowOption.Enabled`, a transação ambiental não flui através do `await`, e você recebe um `TransactionAbortedException` separado e difícil de diagnosticar. É um erro diferente, mas aparece exatamente no mesmo caminho de código, então ative a opção sempre que misturar `TransactionScope` com chamadas assíncronas do EF Core.

## Armadilhas e casos parecidos

**Pode disparar em uma consulta simples, não só em uma escrita.** A issue do GitHub [dotnet/efcore#29396](https://github.com/dotnet/efcore/issues/29396) registra relatos da mensagem aparecendo em um simples `SELECT`. A causa habitual é um `TransactionScope` externo que você esqueceu (muitas vezes aberto em um repositório base, uma infraestrutura de testes ou um invólucro de unidade de trabalho), então a consulta "simples" na verdade roda dentro de uma transação de usuário. Procure na sua pilha de chamadas por qualquer `BeginTransaction` ou `new TransactionScope` acima da linha que falha.

**O Azure SQL pode ativar isso sem você pedir.** A partir do EF Core 8, aproximadamente, o provedor de SQL Server passou a usar por padrão uma estratégia com novas tentativas quando detecta uma string de conexão do Azure SQL (veja [dotnet/efcore#32165](https://github.com/dotnet/efcore/issues/32165)). Código que funcionava localmente contra o LocalDB de repente falha no Azure porque a resiliência agora está ativa. Se você vê isso apenas no seu ambiente em nuvem, é por isso. A correção é o mesmo invólucro; você não precisa desativar o padrão.

**Não apague `EnableRetryOnFailure` só para o erro sumir.** Isso remove o erro removendo a resiliência que você presumivelmente queria. Envolva a transação em vez disso. Se você realmente precisa contornar a resiliência para uma operação isolada, a saída mais limpa discutida em [dotnet/efcore#24922](https://github.com/dotnet/efcore/issues/24922) é usar um segundo contexto configurado separadamente sem novas tentativas, não retirá-la do seu contexto principal.

**Isto não é o mesmo que "A second operation was started on this context instance".** Esse erro é sobre o uso concorrente de um `DbContext`, não sobre transações e novas tentativas. Se a sua mensagem fala de concorrência em vez de estratégias de execução, veja a correção para [uma segunda operação iniciada neste contexto](/pt-br/2026/05/fix-second-operation-was-started-on-this-context-instance/).

## Relacionado

- [Correção: SqlException: Timeout expired durante migrações do EF Core](/pt-br/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/) cobre a família de falhas transitórias pelo lado das migrações.
- [Correção: ObjectDisposedException: Cannot access a disposed context instance](/pt-br/2026/06/fix-objectdisposedexception-cannot-access-a-disposed-context-instance/) é a outra armadilha de ciclo de vida do EF Core que afeta código assíncrono.
- [EF Core ExecuteUpdate vs carregar entidades e SaveChanges](/pt-br/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) mostra quando você pode evitar uma transação explícita por completo.
- [Como usar interceptores do EF Core 11 para auditoria](/pt-br/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/) para se conectar ao pipeline de salvamento sem transações manuais.
- [Migrar do EF Core 6 para o EF Core 11: mudanças que realmente machucam](/pt-br/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) sinaliza o padrão de novas tentativas do Azure SQL, entre outras surpresas.

## Fontes

- [Connection Resiliency, EF Core](https://learn.microsoft.com/en-us/ef/core/miscellaneous/connection-resiliency) - o guia canônico sobre `CreateExecutionStrategy`, `ExecuteInTransactionAsync` e o problema de idempotência.
- [Implement resilient Entity Framework Core SQL connections](https://learn.microsoft.com/en-us/dotnet/architecture/microservices/implement-resilient-applications/implement-resilient-entity-framework-core-sql-connections) - a versão do mesmo padrão na arquitetura de microsserviços do .NET.
- [dotnet/efcore#32165: padrão de estratégia de novas tentativas no Azure SQL](https://github.com/dotnet/efcore/issues/32165)
- [dotnet/efcore#29396: erro em um SELECT simples](https://github.com/dotnet/efcore/issues/29396)
- [dotnet/efcore#24922: suspender a estratégia de execução configurada](https://github.com/dotnet/efcore/issues/24922)
