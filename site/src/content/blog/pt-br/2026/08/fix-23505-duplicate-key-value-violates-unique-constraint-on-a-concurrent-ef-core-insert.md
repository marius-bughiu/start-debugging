---
title: "Fix: 23505: duplicate key value violates unique constraint em um insert concorrente do EF Core"
description: "O verificar-depois-inserir do seu handler não é atômico. Capture PostgresException com SqlState 23505, ou colapse tudo em uma única instrução INSERT ... ON CONFLICT. EnableRetryOnFailure não vai ajudar."
pubDate: 2026-08-30
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "postgresql"
  - "npgsql"
  - "concurrency"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/08/fix-23505-duplicate-key-value-violates-unique-constraint-on-a-concurrent-ef-core-insert"
translatedBy: "claude"
translationDate: 2026-08-30
---

Seu handler consulta "esse email já existe?", não vê nada e insere. Sob carga, duas requisições fazem isso ao mesmo tempo, nenhuma vê nada, e o Postgres rejeita a perdedora no índice com `23505`. O índice único não é o bug, é a única coisa que pegou o bug. Corrija de uma de duas formas: colapse a leitura e a escrita em uma única instrução `INSERT ... ON CONFLICT` para que não exista janela entre elas, ou mantenha o insert ingênuo e capture a `DbUpdateException` cuja exceção interna seja uma `PostgresException` com `SqlState == PostgresErrorCodes.UniqueViolation`, e então releia a linha que a vencedora escreveu. Não recorra ao `EnableRetryOnFailure`: o detector de erros transitórios do Npgsql retorna `false` para `23505`, então a camada de resiliência vai repassar a exceção direto para você.

Uma observação sobre a verificação. O único SDK nesta máquina é o .NET 10.0.302, e não há servidor Postgres nela, então tudo abaixo foi conferido contra `Npgsql` 10.0.3, `Npgsql.EntityFrameworkCore.PostgreSQL` 10.0.3 e `Microsoft.EntityFrameworkCore` 10.0.4 offline (valores de constantes, o detector de exceções transitórias, o SQL gerado, o estado do change tracker), mais a documentação do PostgreSQL 18 para o comportamento do lado do servidor. O provider Npgsql 11.0 ainda está em versão prévia no momento em que escrevo isto e suas [notas de versão 11.0](https://www.npgsql.org/efcore/release-notes/11.0.html) não listam mudanças no mapeamento de erros, no batching do `SaveChanges` ou no detector de retentativas, então tudo isso vale também para o EF Core 11 e o provider 11.0. Quando uma afirmação vem da documentação do servidor e não de uma execução nesta máquina, eu digo.

## O erro em contexto

```text
Microsoft.EntityFrameworkCore.DbUpdateException: An error occurred while saving the entity changes. See the inner exception for details.
 ---> Npgsql.PostgresException (0x80004005): 23505: duplicate key value violates unique constraint "IX_Users_Email"

DETAIL: Key ("Email")=(ada@example.com) already exists.
   at Npgsql.Internal.NpgsqlConnector.ReadMessageLong(...)
   at Npgsql.NpgsqlDataReader.NextResult(...)
   at Microsoft.EntityFrameworkCore.Update.Internal.BatchExecutor.ExecuteAsync(...)
   at Microsoft.EntityFrameworkCore.Storage.RelationalDatabase.SaveChangesAsync(...)
```

Duas coisas nesse bloco merecem leitura atenta.

O nome da constraint diz qual falha você tem. `IX_Users_Email` é um índice único que você declarou, então isto é uma condição de corrida no nível da aplicação. Se aparecer `PK_Users`, você quase certamente tem uma sequência de identidade dessincronizada, que é um problema completamente diferente e está coberto mais abaixo.

A linha `DETAIL:` pode estar ausente por completo. O parâmetro de string de conexão `Include Error Detail` do Npgsql tem `false` como padrão (verificado: `new NpgsqlConnectionStringBuilder("Host=h;Database=d").IncludeErrorDetail` retorna `False` no Npgsql 10.0.3), porque o texto do detalhe contém o valor de chave conflitante e isso costuma ser dado pessoal. Adicione `Include Error Detail=true` em desenvolvimento se quiser o valor, e deixe desligado em produção a menos que você aceite chaves indo parar nos seus logs.

## Por que isso acontece

A causa dominante, e a que combina com "só acontece sob carga", é que uma verificação seguida de um insert são duas instruções com uma lacuna entre elas. Nada dentro de uma transação `READ COMMITTED` impede outra sessão de inserir nessa lacuna. A documentação do PostgreSQL sobre [verificações de unicidade de índice](https://www.postgresql.org/docs/current/index-unique-checks.html) descreve o que o servidor faz quando a outra sessão ainda não fez commit: "If a conflicting row has been inserted by an as-yet-uncommitted transaction, the would-be inserter must wait to see if that transaction commits." Se ela fizer rollback não há conflito e seu insert prossegue; se fizer commit, você recebe `23505`. É por isso que o erro vem em rajadas e por isso ele nunca reproduz no notebook de um desenvolvedor com uma única requisição em voo.

Duas outras causas produzem o mesmo SQLSTATE e vale descartá-las antes de escrever qualquer código de concorrência:

- **Uma sequência dessincronizada.** Depois de um `pg_restore`, um `COPY`, ou uma importação de dados que forneceu chaves primárias explícitas, a sequência de identidade continua apontando para 1 enquanto a tabela já tem linhas até 40.000. Então cada insert colide em `PK_<Table>`. A correção é `SELECT setval(pg_get_serial_sequence('"Users"', 'Id'), (SELECT MAX("Id") FROM "Users"));`, não um laço de retentativas.
- **Repetir `SaveChanges` no mesmo `DbContext`.** Um `SaveChangesAsync` que falhou não desanexa nada. Conferi isso diretamente: depois da exceção, `ChangeTracker.Entries()` continua reportando a entidade conflitante no estado `Added`, `DbUpdateException.Entries` tem exatamente uma entrada, e chamar `SaveChangesAsync` de novo naquele mesmo contexto lança a exceção idêntica. Qualquer retentativa tem que partir de um contexto novo.

## Reprodução mínima

```csharp
// .NET SDK 10.0.302, EF Core 10.0.4, Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3
public class User
{
    public int Id { get; set; }
    public string Email { get; set; } = "";
    public string Name { get; set; } = "";
}

protected override void OnModelCreating(ModelBuilder mb)
    => mb.Entity<User>().HasIndex(u => u.Email).IsUnique();
```

Esse modelo produz exatamente este DDL a partir do provider Npgsql (`db.Database.GenerateCreateScript()`, executado offline):

```sql
CREATE TABLE "Users" (
    "Id" integer GENERATED BY DEFAULT AS IDENTITY,
    "Email" text NOT NULL,
    "Name" text NOT NULL,
    CONSTRAINT "PK_Users" PRIMARY KEY ("Id")
);

CREATE UNIQUE INDEX "IX_Users_Email" ON "Users" ("Email");
```

E este é o handler que perde a corrida:

```csharp
// Racy: the gap between AnyAsync and SaveChangesAsync is unguarded.
public async Task<User> RegisterAsync(string email, string name, CancellationToken ct)
{
    if (await db.Users.AnyAsync(u => u.Email == email, ct))
        throw new EmailTakenException(email);

    var user = new User { Email = email, Name = name };
    db.Users.Add(user);
    await db.SaveChangesAsync(ct);   // 23505 when a second request got here first
    return user;
}
```

Envolver essas três instruções em uma transação não ajuda. Uma transação dá atomicidade, não exclusão mútua, e `READ COMMITTED` é o padrão. Elevar o nível de isolamento também não ajuda: muda o SQLSTATE que você recebe em alguns cenários, mas não faz o conflito desaparecer. A página do PostgreSQL sobre [tratamento de falhas de serialização](https://www.postgresql.org/docs/current/mvcc-serialization-failure-handling.html) trata desse padrão de frente, observando que uma falha de chave única depois de inspecionar as chaves armazenadas "is effectively a serialization failure, but the server will not detect it as such because it cannot see the connection between the inserted value and the previous reads."

## Correção 1: uma instrução só, com ON CONFLICT

Esta é a correção a buscar primeiro. `INSERT ... ON CONFLICT` é uma única instrução, então não existe janela para ninguém inserir, e a resolução do conflito acontece dentro do caminho de inserção no índice do servidor.

A sutileza está em recuperar a linha. `ON CONFLICT DO NOTHING` não retorna nada quando há conflito: a [documentação do INSERT](https://www.postgresql.org/docs/current/sql-insert.html) afirma que apenas as linhas inseridas ou atualizadas com sucesso são retornadas por `RETURNING`. Então um get-or-create que precisa saber o id usa `DO UPDATE` com uma autoatribuição, que toca a linha e portanto a torna elegível para `RETURNING`:

```csharp
// EF Core 10.0.4 / Npgsql 10.0.3. Same code compiles unchanged on EF Core 11.
public async Task<int> GetOrCreateUserIdAsync(string email, string name, CancellationToken ct)
{
    var ids = await db.Database.SqlQuery<int>($"""
        INSERT INTO "Users" ("Email", "Name")
        VALUES ({email}, {name})
        ON CONFLICT ("Email") DO UPDATE SET "Email" = EXCLUDED."Email"
        RETURNING "Id" AS "Value"
        """).ToListAsync(ct);

    return ids.Single();
}
```

Quatro detalhes desse trecho são estruturais:

1. **`AS "Value"`.** `SqlQuery<T>` para um tipo escalar lê uma coluna chamada `Value`. Sem o alias você recebe uma falha em tempo de execução por coluna ausente, não um erro de compilação.
2. **Os buracos interpolados são parâmetros, não concatenação.** `ToQueryString()` nessa consulta emite `VALUES (@p0, @p1)` com os valores reportados separadamente, então a preocupação usual com injeção não se aplica aqui.
3. **`ToListAsync`, nunca `FirstOrDefaultAsync`.** O EF Core inspeciona o SQL cru e se recusa a compor sobre uma instrução que não é um `SELECT`. Adicionar qualquer operador LINQ lança `InvalidOperationException: 'FromSql' or 'SqlQuery' was called with non-composable SQL and with a query composing over it.` Bati exatamente nisso, em `NpgsqlQuerySqlGenerator`, enquanto conferia o SQL gerado. Materialize a lista primeiro e só então escolha.
4. **`EXCLUDED` é a linha proposta.** `SET "Email" = EXCLUDED."Email"` é uma escrita deliberadamente sem efeito cujo único propósito é tornar a linha conflitante elegível para `RETURNING`.

Se você realmente não precisa do id de volta, prefira `ON CONFLICT ("Email") DO NOTHING` e evite a amplificação de escrita. A versão com autoatribuição escreve uma nova versão da linha, incrementa `xmax` e dispara qualquer trigger `BEFORE UPDATE` a cada tentativa duplicada.

Mais uma restrição que a documentação deixa explícita: `ON CONFLICT DO UPDATE` não vai tocar duas vezes a mesma linha existente dentro de uma única instrução, e lança uma violação de cardinalidade (`21000`) se sua lista `VALUES` contiver a mesma chave duas vezes. Deduplique o lote em C# antes de enviá-lo.

## Correção 2: inserir de forma otimista, capturar 23505, reler

Quando o insert está enterrado em uma unidade de trabalho maior e reescrevê-lo como SQL cru é impraticável, deixe o índice ser o seu bloqueio e trate a derrota:

```csharp
// EF Core 10.0.4 / Npgsql 10.0.3
public async Task<User> RegisterAsync(string email, string name, CancellationToken ct)
{
    var user = new User { Email = email, Name = name };
    db.Users.Add(user);

    try
    {
        await db.SaveChangesAsync(ct);
        return user;
    }
    catch (DbUpdateException ex)
        when (ex.InnerException is PostgresException
              {
                  SqlState: PostgresErrorCodes.UniqueViolation,
                  ConstraintName: "IX_Users_Email"
              })
    {
        // Someone else won. This context is poisoned: the entity is still Added.
        await using var fresh = await factory.CreateDbContextAsync(ct);
        return await fresh.Users.SingleAsync(u => u.Email == email, ct);
    }
}
```

`PostgresErrorCodes.UniqueViolation` é a string `"23505"` (verificado contra o Npgsql 10.0.3), e usar a constante é melhor que uma string mágica. Filtre também por `ConstraintName`. Um bloco catch apenas com `SqlState: "23505"` vai engolir alegremente uma colisão de chave primária causada por uma sequência dessincronizada e transformar um sinal de corrupção de dados em uma resposta silenciosa e errada.

O contexto novo importa, e é por isso que esse padrão anda junto com `IDbContextFactory<T>` em vez de um `DbContext` scoped. Se você injetar o contexto scoped e repetir nele, reenvia a mesma entidade `Added` e recebe a mesma exceção, que é o comportamento que confirmei no change tracker acima. O mesmo vale se você estiver [resolvendo um DbContext a partir de um serviço singleton](/pt-br/2026/08/how-to-use-idbcontextfactory-from-a-singleton-service-in-blazor/).

## Por que EnableRetryOnFailure não faz nada aqui

Isso confunde quem já adicionou resiliência de conexão e supõe que ela cobre o caso. Não cobre. Invoquei o detector do próprio provider diretamente por reflexão em `Npgsql.EntityFrameworkCore.PostgreSQL.Storage.Internal.NpgsqlTransientExceptionDetector` do provider 10.0.3:

```text
ShouldRetryOn(23505) = False     unique_violation
ShouldRetryOn(23503) = False     foreign_key_violation
ShouldRetryOn(40001) = True      serialization_failure
ShouldRetryOn(40P01) = True      deadlock_detected
ShouldRetryOn(53300) = True      too_many_connections
ShouldRetryOn(57P03) = True      cannot_connect_now
ShouldRetryOn(08006) = True      connection_failure
```

`PostgresException.IsTransient` concorda: `False` para `23505`, `True` para `40001` e `40P01`. Essa classificação está correta. Uma retentativa cega de um duplicado genuíno simplesmente falharia de novo, para sempre. Isso significa que a retentativa tem que ser sua, no nível onde você pode decidir o que um duplicado significa para esta operação. Se você adicionar sua própria estratégia de execução em volta de uma transação manual, fique atento ao erro [a estratégia de execução não oferece suporte a transações iniciadas pelo usuário](/pt-br/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/) que você vai encontrar no caminho.

## Correção 3: um advisory lock, quando o get-or-create abrange várias instruções

Às vezes a operação realmente não pode ser uma única instrução: você precisa criar um tenant, depois uma linha de esquema, depois uma linha de configurações padrão, e só um chamador pode fazer isso. Serialize sobre uma chave em vez de sobre a tabela:

```csharp
// EF Core 10.0.4 / Npgsql 10.0.3
await using var tx = await db.Database.BeginTransactionAsync(ct);

// Held until the transaction commits or rolls back. No explicit unlock.
await db.Database.ExecuteSqlAsync(
    $"SELECT pg_advisory_xact_lock(hashtext({email}))", ct);

var existing = await db.Users.SingleOrDefaultAsync(u => u.Email == email, ct);
if (existing is not null) { await tx.CommitAsync(ct); return existing; }

db.Users.Add(new User { Email = email, Name = name });
await db.SaveChangesAsync(ct);
await tx.CommitAsync(ct);
```

`pg_advisory_xact_lock` é liberado automaticamente no fim da transação, que é exatamente a propriedade que você quer: nenhum bloco `finally` consegue vazá-lo. Duas ressalvas. `hashtext` retorna um valor de 32 bits, então chaves distintas podem colidir e serializar entre si sem necessidade, o que é um problema de desempenho e nunca de correção. E isso só funciona se todo escritor pegar o bloqueio. Mantenha o índice único de qualquer forma: ele é a rede de segurança para o caminho de código que esquecer.

## Variantes que parecem iguais mas não são

**O insert funciona sozinho e falha em lote.** O EF Core agrupa vários inserts pendentes em uma única ida e volta dentro de uma transação, então um único duplicado em qualquer ponto do lote reverte todas as linhas que você adicionou. `DbUpdateException.Entries` diz qual entidade o servidor rejeitou; o resto fica intacto mas também não salvo. Se você está inserindo milhares de linhas, esta é uma das razões para buscar outro caminho de escrita, que eu medi em [EF Core 11 vs Dapper para inserções em massa](/pt-br/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/).

**Os ids continuam pulando depois de cada falha.** É o esperado, e não tem correção. A [documentação das funções de sequência](https://www.postgresql.org/docs/current/functions-sequence.html) é inequívoca: "the value obtained by `nextval` is not reclaimed for re-use if the calling transaction later aborts." Ela também menciona `ON CONFLICT` especificamente, porque a tupla, incluindo sua chamada a `nextval`, é calculada antes de o conflito ser detectado. Cada tentativa duplicada queima um id. Se suas chaves são visíveis ao usuário e lacunas são inaceitáveis, a resposta é outra estratégia de chaves, não uma sequência sem lacunas; veja [gerar uma chave primária a partir de uma sequência do banco de dados](/pt-br/2026/08/how-to-generate-a-primary-key-from-a-database-sequence-on-insert-in-ef-core-11/).

**Duplicados em uma coluna anulável que você achava impossíveis.** Um índice único padrão trata valores `NULL` como distintos, então qualquer quantidade de linhas pode ter `NULL` ali. Se você realmente quer no máximo uma, o PostgreSQL 15 em diante suporta `CREATE UNIQUE INDEX ... ON "Users" ("ExternalId") NULLS NOT DISTINCT`. Note que o provider Npgsql 11.0 eleva seu alvo mínimo padrão para PostgreSQL 16, então isso está disponível em qualquer servidor que o provider atual mire por padrão.

**`ON CONFLICT` falha com "there is no unique or exclusion constraint matching the ON CONFLICT specification".** O alvo do conflito é uma inferência de índice, não uma lista de colunas. Se seu índice único for parcial (`WHERE "DeletedAt" IS NULL`), você tem que repetir o predicado: `ON CONFLICT ("Email") WHERE "DeletedAt" IS NULL DO NOTHING`. Como alternativa, nomeie a constraint diretamente com `ON CONFLICT ON CONSTRAINT "IX_Users_Email"`, o que dispensa a inferência por completo.

**Isto é uma atualização concorrente, não um insert concorrente.** Se dois chamadores estão modificando uma linha existente em vez de criar uma, `23505` é a ferramenta errada e o que você quer é um token de concorrência. Esse é um mecanismo diferente com uma exceção diferente, coberto em [concorrência otimista com um token rowversion](/pt-br/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/).

## Provando isso em um teste

Uma condição de corrida que só aparece sob carga de produção é uma condição de corrida que você não consegue cobrir com teste de regressão usando um provider em memória de thread única. Você precisa de um servidor real e duas conexões. Suba um container do Postgres, resolva dois contextos a partir de `IDbContextFactory<T>`, e dispare os dois inserts contra o mesmo portão `TaskCompletionSource` para que disputem o índice no mesmo instante. Se o handler estiver correto, as duas tarefas retornam o mesmo id e nenhuma lança exceção. As compensações desse arranjo frente a um armazenamento falso estão descritas em [WebApplicationFactory vs Testcontainers](/pt-br/2026/08/webapplicationfactory-vs-testcontainers-for-aspnetcore-integration-tests/).

O hábito que vale formar é menor que todo esse código. Quando capturar uma `DbUpdateException`, olhe `SqlState` e `ConstraintName` antes de decidir o que ela significa. Um `23505` em um índice único que você projetou é seu modelo de dados fazendo o trabalho dele e avisando que um chamador perdeu uma corrida. Um `23505` em uma chave primária normalmente é o banco de dados avisando que algo está errado com a própria tabela.

## Relacionados

- [Como implementar concorrência otimista com um token rowversion no EF Core 11](/pt-br/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/)
- [Como gerar uma chave primária a partir de uma sequência do banco de dados no insert com EF Core 11](/pt-br/2026/08/how-to-generate-a-primary-key-from-a-database-sequence-on-insert-in-ef-core-11/)
- [Fix: The configured execution strategy does not support user-initiated transactions](/pt-br/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/)
- [Como usar IDbContextFactory a partir de um serviço singleton no Blazor](/pt-br/2026/08/how-to-use-idbcontextfactory-from-a-singleton-service-in-blazor/)
- [EF Core 11 vs Dapper para inserções em massa: um benchmark real](/pt-br/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/)

## Fontes

- [PostgreSQL 18: Index Uniqueness Checks](https://www.postgresql.org/docs/current/index-unique-checks.html)
- [PostgreSQL 18: Serialization Failure Handling](https://www.postgresql.org/docs/current/mvcc-serialization-failure-handling.html)
- [PostgreSQL 18: INSERT, incluindo ON CONFLICT e a inferência de índices únicos](https://www.postgresql.org/docs/current/sql-insert.html)
- [PostgreSQL 18: Sequence Manipulation Functions](https://www.postgresql.org/docs/current/functions-sequence.html)
- [PostgreSQL Error Codes: Class 23 Integrity Constraint Violation](https://www.postgresql.org/docs/current/errcodes-appendix.html)
- [Notas de versão 11.0 do provider Npgsql para EF Core](https://www.npgsql.org/efcore/release-notes/11.0.html)
- [EF Core: Connection resiliency](https://learn.microsoft.com/en-us/ef/core/miscellaneous/connection-resiliency)
