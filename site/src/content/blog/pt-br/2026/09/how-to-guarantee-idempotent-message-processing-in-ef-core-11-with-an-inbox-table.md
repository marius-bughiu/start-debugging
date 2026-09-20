---
title: "Como garantir processamento idempotente de mensagens com o EF Core 11 quando duas instâncias do app consomem a mesma mensagem"
description: "A verificação de existência no seu handler não é a proteção que você imagina. Coloque um índice único na tabela de inbox, grave o marcador no mesmo SaveChanges da mudança de negócio e deixe o banco de dados escolher o vencedor. Mais a armadilha do ExecuteUpdate que desfaz tudo isso em silêncio."
pubDate: 2026-09-20
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "concurrency"
  - "messaging"
  - "idempotency"
  - "sql-server"
  - "postgresql"
  - "dotnet-11"
  - "how-to"
lang: "pt-br"
translationOf: "2026/09/how-to-guarantee-idempotent-message-processing-in-ef-core-11-with-an-inbox-table"
translatedBy: "claude"
translationDate: 2026-09-20
---

Resposta curta: pare de confiar em `if (await db.Inbox.AnyAsync(...)) return;`. Duas instâncias podem executar essa verificação antes de qualquer uma delas commitar, e as duas vão processar a mensagem. Em vez disso, dê à tabela de inbox um índice único sobre a chave de deduplicação, adicione a linha do marcador ao change tracker junto com a mudança de negócio e deixe um único `SaveChangesAsync` commitar as duas coisas ou nenhuma. A instância que perde a corrida recebe uma `DbUpdateException` cuja inner exception é uma violação de unicidade, o que significa "outra instância já fez isso", então ela confirma a mensagem e retorna. O banco de dados, e não o seu `if`, é o que torna o handler idempotente.

Este post cobre a condição de corrida em detalhe, a correção em quatro passos com o SQL que o EF Core 11 realmente emite, como diferenciar uma mensagem duplicada de uma violação de constraint legítima, a variante em duas fases para efeitos colaterais que não podem entrar em uma transação de banco de dados, e os três erros que desativam tudo isso em silêncio.

Uma nota sobre versões e verificação. O EF Core 11 exige o runtime do .NET 11 e é lançado junto com o .NET 11 em novembro de 2026, conforme a [página de releases do EF Core](https://learn.microsoft.com/en-us/ef/core/what-is-new/). Tudo abaixo foi executado com `Microsoft.EntityFrameworkCore` 11.0.0-rc.1.26425.128 no SDK do .NET 11 RC 1. Não há SQL Server nem PostgreSQL nesta máquina, então as execuções de concorrência usam o provider do SQLite com duas conexões para o mesmo arquivo de banco de dados, e a saída do SQL Server foi produzida offline com `GenerateCreateScript()` e um interceptor que suprime a conexão. Onde uma afirmação depende de comportamento do servidor que eu não pude executar, eu digo isso e cito a documentação do fornecedor.

## Por que a verificação de existência não é uma proteção

At-least-once é a garantia de entrega que você recebe do Azure Service Bus, RabbitMQ, Kafka e SQS. A página da Microsoft sobre o [padrão Idempotent Consumer](https://learn.microsoft.com/en-us/azure/architecture/patterns/idempotent-consumer) lista três formas de uma duplicata chegar até você: o produtor repetiu um envio cuja confirmação se perdeu, o broker reentregou depois que o seu lock expirou, ou o seu processo caiu entre a escrita no banco de dados e a confirmação.

Nada disso é exótico. Um restart de pod durante um rolling deploy produz as três. E como você roda mais de uma réplica, a reentrega não volta para a mesma instância; ela vai para o consumidor que estiver livre, que pode estar processando a cópia original naquele exato momento.

Este é o handler que quase todo mundo escreve primeiro:

```csharp
// EF Core 11.0.0-rc.1, .NET 11. This is the version that does not work.
public async Task Handle(CreditRequested msg, CancellationToken ct)
{
    if (await db.Inbox.AnyAsync(m => m.MessageId == msg.MessageId && m.Consumer == "credit", ct))
        return;

    db.Credits.Add(new Credit { Amount = msg.Amount });
    db.Inbox.Add(new InboxMessage
    {
        MessageId = msg.MessageId,
        Consumer = "credit",
        ReceivedUtc = DateTime.UtcNow
    });

    await db.SaveChangesAsync(ct);
}
```

Duas instâncias, um único id de mensagem, um intervalo de 50 ms entre a verificação e o save, e a tabela de inbox com um índice comum, não único:

```text
### 1. check-then-insert, no unique index, two concurrent consumers
  B: committed
  A: committed
  credits applied = 2, total = 200.0
  inbox rows = 2
```

Os dois leitores viram um inbox vazio, os dois gravaram um marcador, os dois creditaram a conta. A tabela de marcadores agora está mentindo ativamente: ela diz que a mensagem foi processada, duas vezes.

## A correção, em quatro passos

1. Dê à tabela de inbox um índice único sobre o id da mensagem mais a identidade do consumidor, para que o banco de dados possa rejeitar o segundo escritor.
2. Adicione a linha do marcador e a mudança de negócio ao mesmo `DbContext` e commite as duas com um único `SaveChangesAsync`, para que elas cheguem juntas ou não cheguem.
3. Capture a `DbUpdateException` cuja inner exception é uma violação de unicidade naquele índice específico, e trate isso como "outra instância já processou esta mensagem".
4. Confirme a mensagem tanto no caminho do commit quanto no caminho da duplicata capturada, e só a abandone em uma exceção não tratada.

### 1. Dê à tabela de inbox um índice único sobre a chave de deduplicação

A chave é a identidade da mensagem mais a identidade do consumidor. A parte do consumidor importa quando vários handlers independentes assinam o mesmo canal: com a chave apenas na mensagem, o primeiro handler a registrar um marcador suprime todos os outros.

```csharp
// EF Core 11.0.0-rc.1
public class InboxMessage
{
    public long Id { get; set; }               // surrogate, keeps the clustered index sequential
    public Guid MessageId { get; set; }
    public string Consumer { get; set; }
    public DateTime ReceivedUtc { get; set; }
    public DateTime? ProcessedUtc { get; set; }
}

protected override void OnModelCreating(ModelBuilder b)
{
    var inbox = b.Entity<InboxMessage>();
    inbox.HasKey(m => m.Id);
    inbox.Property(m => m.Consumer).HasMaxLength(200).IsRequired();
    inbox.HasIndex(m => new { m.MessageId, m.Consumer }).IsUnique();
}
```

`GenerateCreateScript()` no provider do SQL Server dá isto:

```sql
CREATE TABLE [Inbox] (
    [Id] bigint NOT NULL IDENTITY,
    [MessageId] uniqueidentifier NOT NULL,
    [Consumer] nvarchar(200) NOT NULL,
    [ReceivedUtc] datetime2 NOT NULL,
    [ProcessedUtc] datetime2 NULL,
    CONSTRAINT [PK_Inbox] PRIMARY KEY ([Id])
);
CREATE UNIQUE INDEX [IX_Inbox_MessageId_Consumer] ON [Inbox] ([MessageId], [Consumer]);
```

Resista à vontade de tornar `MessageId` a chave primária. No SQL Server a chave primária é clustered por padrão, e um índice clustered sobre um `uniqueidentifier` aleatório fragmenta a tabela a cada insert. Uma chave `bigint IDENTITY` com a unicidade garantida por um índice separado mantém os inserts no fim do heap. É exatamente esse o formato que o [MassTransit](https://masstransit.massient.com/documentation/configuration/middleware/outbox) usa na própria entidade `InboxState`: um `long Id` descrito no código-fonte como "Primary key for table, to have ordered clustered index", com o par de deduplicação declarado por meio de `HasAlternateKey(p => new { p.MessageId, p.ConsumerId })`.

### 2. Grave o marcador no mesmo SaveChanges da mudança de negócio

Nem antes, nem depois. A [documentação de transações do EF Core](https://learn.microsoft.com/en-us/ef/core/saving/transactions) é explícita: "todas as alterações em uma única chamada a `SaveChanges` são aplicadas em uma transação. Se alguma das alterações falhar, a transação sofre rollback e nenhuma das alterações é aplicada ao banco de dados."

Eu verifiquei isso com um `DbTransactionInterceptor`. Um único `SaveChangesAsync` que atualiza uma conta e insere o marcador produz `BEGIN, COMMIT` em torno deste par de comandos no SQLite:

```sql
UPDATE "Accounts" SET "Balance" = @p0
WHERE "Id" = @p1
RETURNING 1;

INSERT INTO "Inbox" ("Consumer", "MessageId", "ProcessedUtc", "ReceivedUtc")
VALUES (@p0, @p1, @p2, @p3)
RETURNING "Id";
```

No SQL Server o mesmo save envia:

```sql
SET IMPLICIT_TRANSACTIONS OFF;
SET NOCOUNT ON;
INSERT INTO [Inbox] ([Consumer], [MessageId], [ProcessedUtc], [ReceivedUtc])
OUTPUT INSERTED.[Id]
VALUES (@p0, @p1, @p2, @p3);
```

Para provar a parte do tudo ou nada em vez de supor, eu coloquei um insert fadado a falhar no mesmo save. O marcador nunca chegou:

```text
### 3. marker + business write in one SaveChanges: all or nothing
  SaveChanges threw SqliteException
  inbox rows after failure = 0 (marker rolled back with the business write)
```

Uma ressalva que vale conhecer: o padrão `AutoTransactionBehavior.WhenNeeded` significa que o EF só abre uma transação explícita quando um save precisa de mais de um comando. Esse é o padrão certo, mas significa que a atomicidade da qual você depende vem de o EF decidir que uma transação é necessária. Se você definir `AutoTransactionBehavior.Never`, a documentação avisa que "comandos anteriores podem já ter sido commitados, deixando alterações parciais no banco de dados". Não use isso em um handler de mensagens.

### 3. Capture a violação de unicidade e trate como "já processada"

Mantenha a verificação de existência barata no topo. Ela é um caminho rápido para o caso comum em que a reentrega chega minutos depois, e evita uma transação revertida. Ela só não é a garantia de correção. A garantia é o bloco catch:

```csharp
// EF Core 11.0.0-rc.1, SQL Server + PostgreSQL
try
{
    await db.SaveChangesAsync(ct);
}
catch (DbUpdateException ex) when (IsInboxDuplicate(ex))
{
    // another instance committed this message first; its transaction already
    // applied the business change, so there is nothing left to do
    return;
}

static bool IsInboxDuplicate(DbUpdateException ex) => ex.InnerException switch
{
    SqlException s => (s.Number == 2601 || s.Number == 2627)
                      && s.Message.Contains("IX_Inbox_MessageId_Consumer", StringComparison.Ordinal),
    PostgresException p => p.SqlState == PostgresErrorCodes.UniqueViolation
                           && p.ConstraintName == "IX_Inbox_MessageId_Consumer",
    _ => false
};
```

Rodando o handler corrigido contra a mesma corrida entre duas instâncias:

```text
### 2. same handler, unique index on (MessageId, Consumer)
  A: committed
  B: DbUpdateException / SqliteException code=19 ext=2067
         inner message: SQLite Error 19: 'UNIQUE constraint failed: Inbox.MessageId, Inbox.Consumer'.
  credits applied = 1, total = 100.0
  inbox rows = 1
```

Um crédito, um marcador, e o perdedor descobriu de forma limpa.

### 4. Confirme a mensagem nos dois caminhos

Tanto o commit quanto a duplicata capturada são desfechos terminais: complete a mensagem. Só uma exceção não tratada deve abandoná-la para que o broker reentregue. Inverter isso, abandonando na duplicata, produz uma mensagem que fica indo e voltando até cair na dead-letter.

## O que o banco de dados faz enquanto as duas instâncias inserem

O caso interessante não é o que a minha execução no SQLite mostra, em que o perdedor falha imediatamente. É aquele em que os dois inserts se sobrepõem: a instância A inseriu o marcador mas ainda não commitou, e a instância B tenta inserir o mesmo par.

A documentação do PostgreSQL sobre [verificações de índice único](https://www.postgresql.org/docs/18/index-unique-checks.html) descreve exatamente o que acontece: "Se uma linha conflitante foi inserida por uma transação ainda não commitada, quem está tentando inserir precisa esperar para ver se aquela transação commita. Se ela sofrer rollback, então não há conflito. Se ela commitar sem apagar a linha conflitante de novo, há uma violação de unicidade."

Esse bloqueio é o recurso, não um problema para ajustar. B não descobre o seu destino até a transação de A se resolver. Se A commitar, B recebe `23505` e pode pular com segurança, sabendo que a mudança de negócio está durável. Se A sofrer rollback, porque o handler lançou uma exceção ou o pod morreu no meio da transação, o insert de B tem sucesso e B processa a mensagem, que é exatamente o que você quer. O SQL Server se comporta da mesma forma sob o isolamento read committed padrão, segurando B no lock da chave do índice até A se resolver. Eu não pude executar nenhum dos dois servidores aqui, então tome essas duas frases como comportamento documentado e não como algo que eu medi.

## Diferenciar uma mensagem duplicada de um bug real

A verificação `IsInboxDuplicate` acima casa pelo nome do índice, e isso é proposital. Um handler de mensagens que grava linhas de negócio normalmente grava em tabelas que têm as próprias constraints de unicidade, um número de pedido, um endereço de e-mail, uma chave de idempotência em um pagamento. Se o seu bloco catch engolir toda violação de unicidade, um bug de dados legítimo na escrita de negócio é reportado ao broker como "já processada" e a mensagem desaparece.

A ajuda que o provider dá varia. Eu usei reflection sobre os tipos de exceção:

```text
### 10. does the provider exception name the constraint?
  SqliteException: SqliteErrorCode, SqliteExtendedErrorCode, SqlState
  SqlException: Errors, Number, SqlState
```

O Npgsql é o generoso. `PostgresException` expõe `SqlState`, `TableName`, `ColumnName` e `ConstraintName` (verificado no Npgsql 10.0.3), então você pode casar a constraint pelo nome sem nenhum parsing de string. `SqlException` te dá `Number` e mais nada estruturado, então você acaba casando pelo nome do índice dentro do texto da mensagem. `SqliteException` te dá `SqliteErrorCode` 19 e `SqliteExtendedErrorCode` 2067, com a lista de colunas apenas na mensagem.

Sobre os dois números de erro do SQL Server: 2601 é "Cannot insert duplicate key row in object '%.\*ls' with unique index '%.\*ls'" e 2627 é "Violation of %ls constraint '%.\*ls'. Cannot insert duplicate key in object '%.\*ls'", conforme a [referência de erros de replicação](https://learn.microsoft.com/en-us/previous-versions/SQL/SQL-server-2008/ms151779(v=sql.100)) da Microsoft. Qual deles você recebe depende de como você declarou a unicidade. `HasIndex(...).IsUnique()` emite `CREATE UNIQUE INDEX`, enquanto `HasAlternateKey(...)` emite uma constraint de tabela:

```sql
CONSTRAINT [AK_Inbox_MessageId_Consumer] UNIQUE ([MessageId], [Consumer])
```

Capture os dois números e case pelo nome, e você não precisa se importar com qual deles o seu modelo produziu.

## Três formas de quebrar isso em silêncio

**`ExecuteUpdate` e `ExecuteDelete` não fazem parte do save.** Eles emitem o próprio comando imediatamente, fora de qualquer transação que o `SaveChanges` venha a abrir depois. Um handler que credita uma conta com `ExecuteUpdateAsync` e então adiciona o marcador do inbox não tem atomicidade nenhuma:

```text
### 9. ExecuteUpdate commits on its own, before SaveChanges runs
  marker rejected as duplicate
  balance = 100 (the credit stuck even though the marker was rejected)
```

A detecção de duplicatas funcionou perfeitamente e o dinheiro se moveu mesmo assim. Se você quer o desempenho da atualização em massa, abra uma transação explícita com `BeginTransactionAsync`, execute o `ExecuteUpdateAsync` e o `SaveChangesAsync` dentro dela, e commite uma vez só.

**Tentar de novo no mesmo `DbContext` repete o mesmo insert fadado a falhar.** Depois de um save que falhou, o change tracker mantém toda entidade no estado anterior ao save:

```text
### 4. change-tracker state after a duplicate-key failure
  InboxMessage  state = Added
  Account       state = Modified
  retry on same context: threw again (SqliteException)
```

Qualquer nova tentativa precisa começar de um escopo novo e de um contexto novo. Na prática isso significa que a nova tentativa fica no nível do message pump, não dentro do handler.

**Uma execution strategy com retry mais uma transação explícita lança exceção.** No momento em que você recorre a `BeginTransactionAsync` para resolver o problema do `ExecuteUpdate` acima, o `EnableRetryOnFailure` começa a reclamar. Essa falha tem o próprio texto: [the configured execution strategy does not support user-initiated transactions](/pt-br/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/). A correção é o `ExecuteAsync` na strategy, envolvendo a transação inteira para que a nova tentativa reexecute tudo.

## Efeitos colaterais que não podem entrar na transação

Enviar um e-mail, cobrar um cartão ou gravar em blob storage não sofrem rollback junto com a sua transação de banco de dados. O padrão que funciona é uma reivindicação em duas fases: insira o marcador e commite, depois faça o trabalho externo, depois registre o resultado.

```csharp
// EF Core 11.0.0-rc.1
db.Inbox.Add(new InboxMessage { MessageId = msg.MessageId, Consumer = "email", ReceivedUtc = DateTime.UtcNow });
try
{
    await db.SaveChangesAsync(ct);          // phase 1: claim the message
}
catch (DbUpdateException ex) when (IsInboxDuplicate(ex))
{
    return;                                  // someone else owns this one
}

await emailer.SendAsync(msg, ct);            // the side effect, outside any transaction

await db.Inbox
    .Where(m => m.MessageId == msg.MessageId && m.Consumer == "email")
    .ExecuteUpdateAsync(s => s.SetProperty(m => m.ProcessedUtc, DateTime.UtcNow), ct);
```

Duas instâncias concorrentes, uma única chamada externa:

```text
### 7. two-phase claim: insert marker, commit, then call the API
  A: won the claim, called the API, marked processed (rows=1)
  B: lost the claim, skipping the API call
  external API calls = 1
```

Repare no que isso resolve e no que não resolve. Elimina a chamada duplicada. Não sobrevive a uma queda entre o commit e o envio: você fica com uma linha reivindicada cujo `ProcessedUtc` é nulo e sem nenhuma forma de saber se o e-mail saiu. A orientação da Microsoft é que um registro em andamento "sinaliza que uma tentativa anterior pode ter sido parcialmente concluída", e que você deve reconciliar registros obsoletos ou encaminhá-los para intervenção. A resposta prática é tornar a chamada downstream idempotente também, enviando o mesmo `MessageId` como chave de idempotência do provedor, e então deixar um sweeper retentar reivindicações mais antigas que um limite.

## Escolher a chave, e fazer a limpeza

A chave de deduplicação precisa ser estável entre reentregas. O `MessageId` do Azure Service Bus e o par `source` mais `id` do CloudEvents servem. `CorrelationId` não serve, porque identifica uma conversa e várias mensagens o compartilham. Contadores de tentativa de entrega e timestamps de recebimento também não. No Kafka, onde não existe id de mensagem atribuído pelo broker, a tripla topic, partition e offset é estável para um dado registro; um header definido pelo produtor é melhor, se você tiver um.

A tabela de inbox cresce para sempre se você não podá-la, e podar cedo demais reabre a janela. Mantenha uma linha por mais tempo do que o broker ainda pode reentregar a original: isso é o timeout de lock ou de visibilidade vezes a contagem máxima de entregas, mais o time-to-live da mensagem, mais uma margem para mensagens que um operador reenvia da dead-letter queue semanas depois. Um `ExecuteDeleteAsync` noturno sobre `ReceivedUtc < cutoff` é suficiente, e é um dos raros lugares em que o `ExecuteDelete` rodando fora de uma transação é exatamente o que você quer.

Nada disso é de graça para manter, e é por isso que vale pular o padrão quando a operação já é naturalmente idempotente. Um upsert com chave em um identificador de negócio, ou uma escrita que define um valor absoluto em vez de aplicar um delta, não precisa de inbox nenhum. Se você já usa MassTransit, `AddInboxStateEntity()` e companhia te dão a mesma maquinaria com um `DuplicateDetectionWindow` configurável e um serviço de entrega, no `MassTransit.EntityFrameworkCore` 9.2.2.

Fazer na mão é uma tabela, um índice, um bloco catch e um job de limpeza. A parte que as pessoas erram nunca é a tabela. É acreditar que o `if` no topo do handler estava fazendo o trabalho.

### Leia em seguida

- [Fix: 23505: duplicate key value violates unique constraint em um insert concorrente do EF Core](/pt-br/2026/08/fix-23505-duplicate-key-value-violates-unique-constraint-on-a-concurrent-ef-core-insert/)
- [Como implementar concorrência otimista com um token rowversion no EF Core 11](/pt-br/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/)
- [Como usar bloqueio pessimista com UPDLOCK e SELECT ... FOR UPDATE no EF Core 11](/pt-br/2026/09/how-to-use-pessimistic-locking-with-updlock-and-select-for-update-in-ef-core-11/)
- [Correção: The configured execution strategy does not support user-initiated transactions](/pt-br/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/)
- [BackgroundService vs IHostedService vs Hangfire para tarefas em segundo plano no .NET 11](/pt-br/2026/06/backgroundservice-vs-ihostedservice-vs-hangfire-for-background-jobs-in-dotnet-11/)

### Fontes

- [Padrão Idempotent Consumer](https://learn.microsoft.com/en-us/azure/architecture/patterns/idempotent-consumer), Azure Architecture Center
- [Transações no EF Core](https://learn.microsoft.com/en-us/ef/core/saving/transactions), documentação do EF Core
- [Novidades no EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew), documentação do EF Core
- [PostgreSQL 18: verificações de índice único](https://www.postgresql.org/docs/18/index-unique-checks.html)
- [Erros 2601 e 2627 na referência de erros de replicação](https://learn.microsoft.com/en-us/previous-versions/SQL/SQL-server-2008/ms151779(v=sql.100)), Microsoft Learn
- [Configuração do Transactional Outbox](https://masstransit.massient.com/documentation/configuration/middleware/outbox), documentação do MassTransit
- [`InboxState.cs`](https://github.com/MassTransit/MassTransit/blob/develop/src/Persistence/MassTransit.EntityFrameworkCoreIntegration/EntityFrameworkCoreIntegration/InboxState.cs), documentação do MassTransit
