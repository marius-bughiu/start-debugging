---
title: "Correção: MigrateAsync e CanConnectAsync do EF Core ficam tentando de novo por 60 segundos em 'Login failed for user'"
description: "A verificação de existência do SQL Server no EF Core repete o erro 18456 por um minuto inteiro, com ou sem EnableRetryOnFailure. Falhe rápido, limite o RetryTimeout ou aguarde o EF Core 12."
pubDate: 2026-09-15
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "dotnet-10"
  - "csharp"
lang: "pt-br"
translationOf: "2026/09/fix-migrateasync-canconnectasync-keep-retrying-on-login-failed-for-user-ef-core"
translatedBy: "claude"
translationDate: 2026-09-15
---

Se `Database.MigrateAsync()`, `EnsureCreatedAsync()` ou `CanConnectAsync()` fica travado por cerca de um minuto antes de lançar `Login failed for user` (ou antes de retornar `false`), as novas tentativas vêm do próprio EF Core, não do `EnableRetryOnFailure`. O `SqlServerDatabaseCreator` trata o erro 18456 do SQL como passível de nova tentativa na sua verificação de existência e continua reconectando a cada 500 ms até o seu `RetryTimeout` de um minuto expirar. Desligar as novas tentativas não muda nada. Existem três contornos: abrir a conexão você mesmo antes de migrar, para que uma senha errada falhe na primeira tentativa; reduzir o `RetryTimeout`; ou dar um timeout aos health checks. A correção de verdade ([dotnet/efcore#38927](https://github.com/dotnet/efcore/pull/38927)) só sai no EF Core 12. Medi tudo isso no EF Core 10.0.12 e no 11.0.0-rc.1, e os dois se comportam de forma idêntica.

## O erro em contexto

A exceção é a falha de login comum do SQL Server. O que a denuncia é o tempo que ela leva para chegar:

```text
Microsoft.Data.SqlClient.SqlException (0x80131904): Login failed for user 'app'.
Error Number:18456,State:1,Class:14
```

Sintomas típicos:

- Um contêiner que roda migrações na inicialização com uma senha errada na connection string fica 60 segundos em silêncio antes de cair, então o startup probe do orquestrador costuma matá-lo antes e você nunca vê a exceção.
- Um `/health` baseado em `AddDbContextCheck<T>()` leva um minuto inteiro para reportar `Unhealthy` quando as credenciais estão erradas, e o probe do load balancer estoura o tempo muito antes disso.
- O log de erros do SQL Server (ou a auditoria do Azure SQL) mostra uma rajada de mais de cem entradas `Login failed for user` vindas de uma única inicialização do processo.
- Testes de integração que verificam "credenciais erradas fazem `CanConnectAsync` retornar `false`" passam, mas cada um leva um minuto.

Uma consulta normal com a mesma connection string falha na primeira tentativa. O caminho lento se limita às APIs que perguntam "este banco de dados existe?"

## Por que o EF Core tenta de novo após uma falha de login

`CanConnectAsync`, `MigrateAsync`, `EnsureCreatedAsync` e `EnsureDeletedAsync` começam todos chamando `IRelationalDatabaseCreator.ExistsAsync()`. No SQL Server, isso é o [`SqlServerDatabaseCreator`](https://github.com/dotnet/efcore/blob/v10.0.12/src/EFCore.SqlServer/Storage/Internal/SqlServerDatabaseCreator.cs), e a verificação de existência dele é um loop próprio:

```csharp
// EF Core 10.0.12 and 11.0.0-rc.1, SqlServerDatabaseCreator (abridged)
public virtual TimeSpan RetryDelay { get; set; } = TimeSpan.FromMilliseconds(500);
public virtual TimeSpan RetryTimeout { get; set; } = TimeSpan.FromMinutes(1);

// inside ExistsAsync: open the connection, run SELECT 1, and on SqlException:
if (!retryOnNotExists && IsDoesNotExist(e)) // 4060, 1832, 5120
    return false;
if (DateTime.UtcNow > giveUp || !RetryOnExistsFailure(e))
    throw;
await Task.Delay(RetryDelay, ct);

private bool RetryOnExistsFailure(SqlException exception)
    => (exception.Number is 203 && exception.InnerException is Win32Exception)
       || exception.Number is 233 or -2 or 4060 or 1832 or 5120 or 18456;
```

O erro 18456 entrou nessa lista no EF Core 6.0 pelo [dotnet/efcore#25832](https://github.com/dotnet/efcore/pull/25832). Era um contorno para o [dotnet/efcore#15644](https://github.com/dotnet/efcore/issues/15644): o Azure SQL pode responder `Login failed` por alguns instantes logo depois de um `CREATE DATABASE`, então o `EnsureCreated` e o primeiro `Migrate` contra um banco de dados novo falhavam de forma aleatória. O contorno só era necessário na verificação pós-criação (`CreateAsync` chama `ExistsAsync(retryOnNotExists: true)`), mas o mesmo método é usado em todas as verificações de existência. Assim, uma senha simplesmente errada é tratada como "o banco de dados ainda está aquecendo" e recebe novas tentativas por um minuto inteiro. O [dotnet/efcore#38886](https://github.com/dotnet/efcore/issues/38886), aberto em 2026-08-31, reportou exatamente isso.

Isso também explica por que o `EnableRetryOnFailure` parece culpado, mas não é. O loop roda dentro de uma única operação da execution strategy. Quando o minuto acaba, a strategy pergunta `SqlServerTransientExceptionDetector.ShouldRetryOn(18456)`, recebe `false` (18456 não está naquela lista) e relança a exceção. Com as novas tentativas ligadas ou desligadas, o tempo é o mesmo. O `errorNumbersToAdd` também não importa, a não ser que você adicione 18456 a ele, o que só pioraria as coisas.

O `CanConnectAsync` então envolve tudo isso em um `try/catch` que transforma qualquer exceção, exceto cancelamento, em `false`. É por isso que a variante de health check nunca lança exceção: ela só leva um minuto para dizer não.

## Repro mínimo sem um SQL Server

Você não precisa de um servidor para ver isso. Um `DbConnectionInterceptor` que lança um `SqlException` com número 18456 a cada abertura física faz o papel de um servidor com credenciais erradas. O `SqlException` é construído via reflection, porque seus construtores são internos. O probe conta as tentativas de abertura e mede o tempo de cada chamada:

```csharp
// .NET 10, EF Core 10.0.12 (also run on .NET 11 RC 1 with EF Core 11.0.0-rc.1.26425.128)
public class FailingOpen(int number) : DbConnectionInterceptor
{
    int _attempts;
    public int Attempts => _attempts;

    public override ValueTask<InterceptionResult> ConnectionOpeningAsync(
        DbConnection c, ConnectionEventData e, InterceptionResult r, CancellationToken ct = default)
    {
        Interlocked.Increment(ref _attempts);
        throw FakeSql.Create(number, "Login failed for user 'app'.");
    }
}

public class Shop(FailingOpen interceptor, bool retry) : DbContext
{
    public DbSet<Product> Products => Set<Product>();

    protected override void OnConfiguring(DbContextOptionsBuilder o)
        => o.UseSqlServer(
                "Server=db.invalid;Database=Shop;User Id=app;Password=wrong;Encrypt=False",
                sql => { if (retry) sql.EnableRetryOnFailure(); })
            .AddInterceptors(interceptor);
}
```

Resultados, idênticos no EF Core 10.0.12 (SqlClient 6.0) e no EF Core 11.0.0-rc.1 (SqlClient 7.0):

| Chamada | Erro | `EnableRetryOnFailure` | Tentativas de abertura | Tempo decorrido | Resultado |
|---|---|---|---|---|---|
| `CanConnectAsync()` | 18456 | desligado | 121 | 60,4 s | `false` |
| `CanConnectAsync()` | 18456 | ligado | 121 | 60,2 s | `false` |
| `MigrateAsync()` | 18456 | ligado | 121 | 60,2 s | `SqlException` 18456 |
| `EnsureCreatedAsync()` | 18456 | ligado | 121 | 60,2 s | `SqlException` 18456 |
| `Products.ToListAsync()` | 18456 | ligado | 1 | 0,1 s | `SqlException` 18456 |
| `CanConnectAsync()` | 4060 | ligado | 1 | 0,0 s | `false` |

O interceptor falha instantaneamente, então 121 tentativas é o teto: uma a cada 500 ms durante 60 segundos. Contra um servidor real, cada tentativa também paga por uma conexão TCP, TLS e uma ida e volta de login, então você vai ver menos tentativas, mas o minuto é o mesmo. A última linha mostra a assimetria: um *banco de dados inexistente* (4060) vai direto para `false`, enquanto uma *senha errada* é o caso que recebe novas tentativas.

## A correção, em detalhes

Em ordem de preferência.

### 1. Corrija as credenciais usando o código de state do lado do servidor

O minuto de novas tentativas só torna o problema real mais lento de encontrar. O cliente sempre reporta `State:1`. O servidor grava o motivo real no seu log de erros como um código de state (no Azure SQL, a auditoria o registra):

| State | Significado |
|---|---|
| 2, 5 | O login não existe |
| 6 | Um nome de login do Windows foi usado com autenticação SQL |
| 7 | O login está desabilitado (e a senha está errada) |
| 8 | Senha errada |
| 18 | A senha precisa ser alterada |
| 38, 40 | O login é válido, mas não consegue abrir o banco de dados solicitado |
| 58 | Autenticação SQL usada contra um servidor em modo somente Windows |

A lista completa está na página [MSSQLSERVER_18456](https://learn.microsoft.com/en-us/sql/relational-databases/errors-events/mssqlserver-18456-database-engine-error). Vale a pena conhecer os states 38 e 40, porque parecem um problema de credenciais, mas na verdade são um problema de permissões ou de nome do banco de dados. Eles são primos do caso 4060 tratado no [post sobre CREATE DATABASE permission denied](/pt-br/2026/08/fix-create-database-permission-denied-in-database-master-dotnet-ef-database-update/).

### 2. Falhe rápido antes de migrar

Se você roda migrações na inicialização, abra a conexão você mesmo primeiro. O `OpenConnectionAsync` não passa pelo loop de existência, então uma senha errada lança exceção na primeira tentativa. Quando a conexão já está aberta, o `MigrateAsync` a reutiliza:

```csharp
// .NET 10, EF Core 10.0.12 / 11.0.0-rc.1
static async Task MigrateFailFastAsync(DbContext db, CancellationToken ct = default)
{
    var opened = false;
    try
    {
        await db.Database.OpenConnectionAsync(ct);
        opened = true;
    }
    catch (SqlException ex) when (ex.Number == 4060)
    {
        // Database missing (or no user for this login in it): let MigrateAsync decide.
    }

    try
    {
        await db.Database.MigrateAsync(ct);
    }
    finally
    {
        if (opened) await db.Database.CloseConnectionAsync();
    }
}
```

O probe mediu 1 tentativa e 0,0 s até o `SqlException` 18456, com o `EnableRetryOnFailure` ligado. O `catch` para 4060 importa. Se as suas migrações devem *criar* o banco de dados (desenvolvimento local, uma primeira implantação), a abertura prévia falha com 4060 porque o banco de dados ainda não existe. Engolir esse erro deixa o `MigrateAsync` seguir o caminho normal de criação, incluindo a nova tentativa pós-criação de que o Azure SQL realmente precisa. Se os seus bancos de dados são sempre provisionados separadamente, remova o `catch` e deixe o 4060 derrubar a inicialização também.

Para pipelines de produção, a melhor medida a longo prazo é tirar as migrações da inicialização da aplicação por completo e rodar um [migrations bundle](/pt-br/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) como etapa de implantação. Ele cai no mesmo loop, mas uma etapa de pipeline que falha depois de um minuto é bem menos dolorosa do que um pod em crash loop.

### 3. Limite o `RetryTimeout`

`RetryTimeout` e `RetryDelay` são propriedades públicas e graváveis do `SqlServerDatabaseCreator`, que fica em um namespace `.Internal`. Usá-lo dispara o aviso do analisador EF1001, e o seu formato pode mudar entre versões:

```csharp
// .NET 10, EF Core 10.0.12 / 11.0.0-rc.1
#pragma warning disable EF1001 // Internal EF Core API usage.
using Microsoft.EntityFrameworkCore.SqlServer.Storage.Internal;
using Microsoft.EntityFrameworkCore.Storage;

var creator = (SqlServerDatabaseCreator)db.GetService<IRelationalDatabaseCreator>();
creator.RetryTimeout = TimeSpan.FromSeconds(5);
await db.Database.MigrateAsync();
#pragma warning restore EF1001
```

Com isso no lugar, o probe mediu 11 tentativas e 5,0 s para o `MigrateAsync`. O mesmo timeout limita a verificação pós-criação, então no Azure SQL não o defina como zero se o `EnsureCreated` ou o `Migrate` criarem o banco de dados. Alguns segundos mantêm vivo o contorno do #15644 e eliminam o minuto. O creator é um serviço scoped, então configure-o em cada instância de contexto que roda migrações, e não uma única vez na inicialização.

### 4. Dê um timeout aos health checks de banco de dados

O `AddDbContextCheck<T>()` roda `CanConnectAsync` por padrão, e o [`HealthCheckRegistration.Timeout`](https://github.com/dotnet/aspnetcore/blob/main/src/HealthChecks/Abstractions/src/HealthCheckRegistration.cs) tem como padrão `Timeout.InfiniteTimeSpan`. Diferente do `AddCheck`, o `AddDbContextCheck` não tem parâmetro `timeout`, então faça duas coisas: substitua o teste por um que pule o loop de existência e defina o timeout do registro via `HealthCheckServiceOptions`:

```csharp
// .NET 10, ASP.NET Core 10.0, Microsoft.Extensions.Diagnostics.HealthChecks.EntityFrameworkCore 10.0.12
builder.Services.AddHealthChecks()
    .AddDbContextCheck<Shop>(customTestQuery: async (db, ct) =>
    {
        await db.Database.OpenConnectionAsync(ct);
        await db.Database.CloseConnectionAsync();
        return true;
    });

// The registration is named after the context type unless you pass a name.
builder.Services.Configure<HealthCheckServiceOptions>(o =>
    o.Registrations.Single(r => r.Name == nameof(Shop)).Timeout = TimeSpan.FromSeconds(5));
```

O `DbContextHealthCheck` captura o que quer que o teste lance e reporta `Unhealthy` com a exceção anexada, então uma senha errada agora aparece como `Login failed for user 'app'.` no relatório de saúde, em vez de uma falha sem detalhes um minuto depois. O timeout é a rede de segurança para todo o resto, como um servidor que aceita a conexão TCP e nunca responde. A configuração geral está em [como adicionar um endpoint de health check a uma minimal API](/pt-br/2026/07/how-to-add-a-health-check-endpoint-to-a-minimal-api-in-aspnetcore-11/).

### 5. Atualize quando o EF Core 12 sair

O [dotnet/efcore#38927](https://github.com/dotnet/efcore/pull/38927), mesclado em 2026-09-10 com milestone 12.0.0, repassa o `retryOnNotExists` para o `RetryOnExistsFailure`, de modo que o 18456 só recebe novas tentativas logo depois de o provider ter criado o banco de dados:

```csharp
// EF Core main (12.0), after dotnet/efcore#38927
|| (exception.Number is 233 or -2 or 4060 or 1832 or 5120)
|| (retryOnLoginFailure && exception.Number is 18456))
```

Até hoje, a mudança não está em `release/10.0` nem em `release/11.0` (os dois ainda têm a antiga verificação de uma linha), então o EF Core 11.0 GA muito provavelmente vai sair com a nova tentativa de um minuto. Não rodei um build diário do EF Core 12. O PR adiciona testes de regressão síncronos e assíncronos para os dois caminhos, então os contornos acima são o que você tem no 10 e no 11.

## Armadilhas e erros parecidos

**Um cancellation token muda o resultado, não só o tempo.** O `CanConnectAsync(ct)` relança o cancelamento, então com um `CancellationTokenSource` de 5 segundos o probe recebeu um `TaskCanceledException` depois de 10 tentativas, e não `false`. Código que só verifica o booleano precisa de um `catch (OperationCanceledException)`.

**O caminho síncrono bloqueia uma thread.** `Database.Migrate()` e `CanConnect()` usam `Thread.Sleep(RetryDelay)` no mesmo loop, então o minuto é gasto segurando uma thread do thread pool. Mais um motivo para rodar migrações fora do código que atende requisições.

**O erro 4060 recebe novas tentativas do `EnableRetryOnFailure`, só que não aqui.** O 4060 (`Cannot open database "Shop" requested by the login`) *está* na lista de transitórios. O `CanConnectAsync` retorna `false` para ele imediatamente, mas uma consulta normal com o `EnableRetryOnFailure()` padrão (6 novas tentativas, atraso máximo de 30 s) fez 7 tentativas ao longo de 57,9 s antes de lançar `RetryLimitExceededException`. Se um "login failed" em tempo de consulta leva cerca de um minuto, olhe o número da exceção interna antes de culpar o loop do creator. E se você já está ajustando a strategy, o [post sobre execution strategy e transações do usuário](/pt-br/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/) cobre a outra armadilha que ela prepara.

**O ruído de logins com falha tem efeitos colaterais.** Cada nova tentativa é um login com falha real no servidor. Com `CHECK_POLICY = ON`, os logins SQL seguem a política de bloqueio de contas do Windows, e a auditoria do Azure SQL registra cada tentativa. Um minuto de novas tentativas pode bloquear a conta e, depois disso, até a senha correta falha, com o erro 18486 ("the account is currently locked out") em vez de 18456.

**Timeouts são outro problema.** Se o minuto termina em `Timeout expired` em vez de `Login failed`, você está diante de timeouts de comando ou de gateway durante uma migração longa, tratados em [SqlException timeout expired durante migrações do EF Core](/pt-br/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/).

## Relacionados

- [Correção: CREATE DATABASE permission denied in database 'master' durante dotnet ef database update](/pt-br/2026/08/fix-create-database-permission-denied-in-database-master-dotnet-ef-database-update/)
- [Como aplicar migrações do EF Core 11 em produção com um migrations bundle](/pt-br/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/)
- [Correção: SqlException timeout expired durante migrações do EF Core](/pt-br/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/)
- [Correção: The configured execution strategy does not support user-initiated transactions](/pt-br/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/)
- [Como adicionar um endpoint de health check a uma minimal API no ASP.NET Core 11](/pt-br/2026/07/how-to-add-a-health-check-endpoint-to-a-minimal-api-in-aspnetcore-11/)

## Fontes

- [dotnet/efcore#38886: CanConnectAsync / MigrateAsync retries on authentication failure instead of throwing](https://github.com/dotnet/efcore/issues/38886) e a correção, [dotnet/efcore#38927: Restrict SQL Server login failure retries to post-creation checks](https://github.com/dotnet/efcore/pull/38927).
- [dotnet/efcore#25832: Update SQL Server transient error list](https://github.com/dotnet/efcore/pull/25832), que adicionou o 18456 para o [dotnet/efcore#15644](https://github.com/dotnet/efcore/issues/15644).
- [`SqlServerDatabaseCreator.cs` na v10.0.12](https://github.com/dotnet/efcore/blob/v10.0.12/src/EFCore.SqlServer/Storage/Internal/SqlServerDatabaseCreator.cs), [na v11.0.0-rc.1](https://github.com/dotnet/efcore/blob/v11.0.0-rc.1.26425.128/src/EFCore.SqlServer/Storage/Internal/SqlServerDatabaseCreator.cs) e [`SqlServerTransientExceptionDetector.cs`](https://github.com/dotnet/efcore/blob/v10.0.12/src/EFCore.SqlServer/Storage/Internal/SqlServerTransientExceptionDetector.cs).
- [Connection resiliency](https://learn.microsoft.com/en-us/ef/core/miscellaneous/connection-resiliency) (Microsoft Learn, EF Core).
- [MSSQLSERVER_18456](https://learn.microsoft.com/en-us/sql/relational-databases/errors-events/mssqlserver-18456-database-engine-error) (Microsoft Learn, SQL Server).
- [`DbContextHealthCheck.cs`](https://github.com/dotnet/aspnetcore/blob/main/src/Middleware/HealthChecks.EntityFrameworkCore/src/DbContextHealthCheck.cs) no dotnet/aspnetcore.
