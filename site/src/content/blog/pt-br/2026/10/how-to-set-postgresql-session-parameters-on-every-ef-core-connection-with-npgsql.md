---
title: "Como definir parâmetros de sessão do PostgreSQL, como search_path ou statement_timeout, em toda conexão do EF Core com o Npgsql"
description: "Um SET executado uma única vez é apagado pelo DISCARD ALL assim que o Npgsql devolve a conexão ao pool. Coloque search_path e statement_timeout no pacote de inicialização com as palavras-chave de connection string Search Path e Options, use ALTER ROLE ou um interceptor ConnectionOpened como alternativa, e entenda por que o UsePhysicalConnectionInitializer perde o seu SET silenciosamente."
pubDate: 2026-10-04
template: how-to
tags:
  - "ef-core"
  - "ef-core-10"
  - "postgresql"
  - "npgsql"
  - "dotnet-10"
  - "how-to"
lang: "pt-br"
translationOf: "2026/10/how-to-set-postgresql-session-parameters-on-every-ef-core-connection-with-npgsql"
translatedBy: "claude"
translationDate: 2026-10-04
---

Resposta curta: não execute `SET statement_timeout = ...` uma vez e espere que ele permaneça. O Npgsql envia `DISCARD ALL` toda vez que uma conexão do pool é reutilizada, o que redefine todas as configurações de sessão para o valor padrão. Coloque as configurações no pacote de inicialização da conexão: `Search Path=tenant_a,public` para o search path de schemas e `Options=-c statement_timeout=5s -c lock_timeout=1s` para qualquer outro parâmetro. O PostgreSQL trata parâmetros de inicialização como os padrões da sessão, então o `DISCARD ALL` volta para os *seus* valores, e o EF Core não precisa de nenhum código extra. Se você não pode mexer na connection string, use `ALTER ROLE app_user SET ...` no servidor, ou um `DbConnectionInterceptor` que execute `SET` em `ConnectionOpenedAsync` (uma ida e volta extra a cada abertura).

Tudo abaixo foi executado no .NET 10 (SDK 10.0.302) com `Npgsql.EntityFrameworkCore.PostgreSQL` 10.0.3 (EF Core 10.0.4, Npgsql 10.0.3) contra o PostgreSQL 18.4, com `log_statement=all` ativado para que cada instrução enviada pelo Npgsql apareça no log do servidor. As saídas citadas vêm dessas execuções.

## Por que um SET isolado desaparece

O Npgsql faz pool de conexões físicas. Quando você descarta um `NpgsqlConnection` (ou o EF Core fecha um depois de uma consulta), a conexão física volta para o pool e o Npgsql a marca para reset. O reset é um `DISCARD ALL`, que o PostgreSQL define como `CLOSE ALL; SET SESSION AUTHORIZATION DEFAULT; RESET ALL; DEALLOCATE ALL; UNLISTEN *; ...`. O `RESET ALL` é a parte que importa aqui: todo `SET` que você executou naquela sessão se perde.

Este é o menor exemplo para reproduzir. O pool é limitado a uma conexão, então a segunda abertura obtém garantidamente a mesma sessão física:

```csharp
// .NET 10, Npgsql 10.0.3
var ds = NpgsqlDataSource.Create(
    "Host=localhost;Port=55432;Username=postgres;Database=postgres;Maximum Pool Size=1");

int pid1, pid2;
await using (var c = await ds.OpenConnectionAsync())
{
    pid1 = c.ProcessID;
    await new NpgsqlCommand("SET search_path = tenant_a; SET statement_timeout = '1s'", c)
        .ExecuteNonQueryAsync();
}
await using (var c = await ds.OpenConnectionAsync())
{
    pid2 = c.ProcessID;
    // same physical=True search_path="$user", public statement_timeout=0
}
```

Mesmo processo de backend, e as duas configurações voltaram aos padrões do servidor. O log do servidor mostra o motivo:

```text
[95652] execute <unnamed>: SET search_path = tenant_a
[95652] execute <unnamed>: SET statement_timeout = '1s'
[95652] statement: DISCARD ALL
[95652] execute <unnamed>: SHOW search_path
```

Observe que o `DISCARD ALL` não é enviado quando você fecha a conexão. O Npgsql o adia e o escreve antes do próximo comando naquela conexão física, então não há uma ida e volta extra. Ele também roda quer você tenha alterado algo ou não, então não dá para evitá-lo sendo cuidadoso.

Com o EF Core isso incomoda mais do que com ADO.NET puro, porque o EF Core abre e fecha a conexão em torno de cada operação. Um `DbContext` que executa uma consulta e depois uma chamada `SqlQueryRaw` abre a conexão duas vezes, e cada abertura pode cair em uma sessão recém-resetada.

## Opção 1: a palavra-chave Search Path da connection string

Para o search path de schemas especificamente, o Npgsql tem uma palavra-chave dedicada. Ela é enviada como parâmetro de inicialização, não como um `SET`:

```csharp
// .NET 10, Npgsql 10.0.3
var ds = NpgsqlDataSource.Create(
    "Host=localhost;Port=55432;Username=postgres;Database=postgres;Search Path=tenant_a,public");

await using var c = await ds.OpenConnectionAsync();
// SHOW search_path            -> tenant_a,public
// SELECT count(*) FROM orders -> 1 (resolves to tenant_a.orders)
```

Não há nenhum `SET` no log do servidor para essa conexão. O valor viaja no pacote de inicialização, e o PostgreSQL o usa como o padrão da sessão.

## Opção 2: Options=-c para qualquer outro parâmetro

A palavra-chave `Options` é repassada como o parâmetro de inicialização `options` do PostgreSQL, que aceita a mesma sintaxe `-c name=value` da linha de comando do `postgres`. Isso cobre `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`, `work_mem`, `search_path` e qualquer outro parâmetro que um usuário comum tenha permissão para definir com `SET`:

```csharp
// .NET 10, Npgsql 10.0.3
var cs = "Host=localhost;Port=55432;Username=postgres;Database=postgres;" +
         "Options=-c statement_timeout=2s -c search_path=tenant_a,public -c lock_timeout=500ms";
var ds = NpgsqlDataSource.Create(cs);

await using (var c = await ds.OpenConnectionAsync())
{
    // statement_timeout=2s search_path=tenant_a,public lock_timeout=500ms
    await new NpgsqlCommand("SET statement_timeout = '9s'", c).ExecuteNonQueryAsync();
    // statement_timeout=9s
}
await using (var c = await ds.OpenConnectionAsync())
{
    // statement_timeout=2s   <- DISCARD ALL reset it to the startup value, not to 0
}
```

Essa é a propriedade que faz do pacote de inicialização o lugar certo. O `RESET ALL` devolve cada parâmetro ao valor que ele teria se nenhum `SET` tivesse sido executado nesta sessão, e para um parâmetro de inicialização esse valor é o que você passou. Assim, uma requisição que aumenta o timeout temporariamente não consegue vazá-lo para a próxima, e a próxima ainda recebe o seu padrão em vez do padrão do servidor.

Se você monta connection strings em código, use `NpgsqlConnectionStringBuilder` para que as aspas sejam tratadas por você. O valor de `Options`, separado por espaços, recebe aspas:

```csharp
// .NET 10, Npgsql 10.0.3
var csb = new NpgsqlConnectionStringBuilder("Host=localhost;Port=55432;Username=postgres;Database=sp_demo")
{
    SearchPath = "tenant_b,public",
    Options = "-c statement_timeout=5s -c lock_timeout=1s",
    ApplicationName = "orders-api",
};
// Host=localhost;Port=55432;Username=postgres;Database=sp_demo;Search Path=tenant_b,public;
// Options="-c statement_timeout=5s -c lock_timeout=1s";Application Name=orders-api
```

## Integrando com o EF Core

Como as configurações ficam na connection string, o EF Core não precisa de nada especial. Passe a string para `UseNpgsql`, ou registre um `NpgsqlDataSource` e passe esse:

```csharp
// .NET 10, EF Core 10.0.4, Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3
builder.Services.AddDbContext<AppDbContext>(o => o.UseNpgsql(
    builder.Configuration.GetConnectionString("Orders")));

// appsettings.json
// "ConnectionStrings": {
//   "Orders": "Host=db;Database=orders;Username=app;Search Path=tenant_b,public;Options=-c statement_timeout=5s -c lock_timeout=1s"
// }
```

Executar uma consulta por esse contexto confirma que o timeout está em vigor em toda conexão que o EF Core abre:

```csharp
var st = await db.Database
    .SqlQueryRaw<string>("SELECT current_setting('statement_timeout') AS \"Value\"")
    .SingleAsync();
// 5s
```

Quando o timeout dispara, o PostgreSQL cancela a instrução no servidor e você recebe uma `PostgresException` com `SqlState` `57014` e a mensagem `canceling statement due to statement timeout`. A conexão continua aberta e utilizável. Isso é diferente do `Command Timeout` do próprio Npgsql (padrão de 30 segundos), que é aplicado pelo cliente: quando ele expira, o Npgsql cancela a consulta e lança uma `NpgsqlException` que encapsula uma `TimeoutException`, sem `SqlState`. Mantenha o `Command Timeout` um pouco acima do `statement_timeout` para que o limite do lado do servidor, que fornece um erro limpo e não depende de o cliente perceber, seja o que dispara.

## Opção 3: ALTER ROLE ou ALTER DATABASE no servidor

Se a connection string pertence a outra pessoa (uma equipe de plataforma, um cofre de segredos que você não pode alterar por aplicação), leve os padrões para o servidor:

```sql
-- PostgreSQL 18
ALTER ROLE app_user SET search_path = tenant_a, public;
ALTER ROLE app_user SET statement_timeout = '15s';

-- or scoped to one database
ALTER ROLE app_user IN DATABASE orders SET statement_timeout = '15s';
```

Uma nova conexão como `app_user` voltou com `search_path=tenant_a, public` e `statement_timeout=15s`, com zero configuração no cliente. Esses padrões da role também sobrevivem ao `DISCARD ALL`, já que fazem parte do estado inicial da sessão.

A precedência importa quando você combina abordagens. A mesma role conectando com `Options=-c statement_timeout=3s` obteve `3s`: parâmetros de inicialização sobrescrevem os padrões de role e de banco de dados, que por sua vez sobrescrevem o `postgresql.conf`. Isso dá uma camada útil: um padrão conservador na role e uma sobrescrita por aplicação na connection string, onde um serviço legitimamente precisa de consultas mais longas (um job de relatórios, um executor de migrações).

Evite definir `statement_timeout` globalmente no `postgresql.conf`. A documentação do PostgreSQL desaconselha isso porque ele também se aplica a sessões de manutenção, ao `pg_dump` e às suas próprias sessões do `psql`.

## Opção 4: um DbConnectionInterceptor que executa SET a cada abertura

Às vezes o valor não é estático. Uma aplicação multi-tenant que escolhe o schema por requisição, ou uma configuração derivada do usuário atual, não pode ficar em uma connection string fixa. Os [interceptors](/pt-br/2026/09/what-is-an-ef-core-interceptor-and-when-do-i-need-one/) do EF Core oferecem um gancho que roda logo após cada abertura:

```csharp
// .NET 10, EF Core 10.0.4
using System.Data.Common;
using Microsoft.EntityFrameworkCore.Diagnostics;

public sealed class SessionSettingsInterceptor : DbConnectionInterceptor
{
    const string Sql = "SET statement_timeout = '5s'; SET lock_timeout = '1s'";

    public override void ConnectionOpened(DbConnection connection, ConnectionEndEventData eventData)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = Sql;
        cmd.ExecuteNonQuery();
    }

    public override async Task ConnectionOpenedAsync(
        DbConnection connection, ConnectionEndEventData eventData, CancellationToken cancellationToken = default)
    {
        await using var cmd = connection.CreateCommand();
        cmd.CommandText = Sql;
        await cmd.ExecuteNonQueryAsync(cancellationToken);
    }
}

// registration
builder.Services.AddDbContext<AppDbContext>(o => o
    .UseNpgsql(connectionString)
    .AddInterceptors(new SessionSettingsInterceptor()));
```

Sobrescreva tanto o método síncrono quanto o assíncrono. O EF Core chama o que corresponde à API que você usou, e esquecer o síncrono significa que `db.Orders.Count()` roda silenciosamente sem as suas configurações.

Isso funciona, e o log mostra exatamente quanto custa. Duas instâncias de `DbContext`, cada uma executando uma consulta LINQ e uma consulta SQL bruta, produziram quatro aberturas e quatro pares de `SET`:

```text
[95655] execute <unnamed>: SET statement_timeout = '5s'
[95655] execute <unnamed>: SET lock_timeout = '1s'
[95655] execute <unnamed>: SELECT count(*)::int ...
[95655] statement: DISCARD ALL
[95655] execute <unnamed>: SET statement_timeout = '5s'
[95655] execute <unnamed>: SET lock_timeout = '1s'
[95655] execute <unnamed>: SELECT s."Value" ...
```

Cada abertura paga uma ida e volta extra. Em um socket local isso é ruído; contra um banco de dados gerenciado em outra zona de disponibilidade, pode ter a mesma ordem de grandeza da própria consulta. Para valores estáticos, as Opções 1 a 3 são estritamente melhores. Para valores por requisição, avalie se o parâmetro realmente precisa valer para a sessão inteira, ou se um `SET LOCAL` dentro da transação que você já está executando é suficiente.

## A armadilha: UsePhysicalConnectionInitializer

O `NpgsqlDataSourceBuilder.UsePhysicalConnectionInitializer` parece a escolha óbvia. Ele executa um callback uma vez, quando uma conexão física é criada pela primeira vez, o que soa como "uma vez por sessão, sem custo por abertura". Veja o que realmente acontece:

```csharp
// .NET 10, Npgsql 10.0.3
var b = new NpgsqlDataSourceBuilder(
    "Host=localhost;Port=55432;Username=postgres;Database=postgres;Maximum Pool Size=1");
b.UsePhysicalConnectionInitializer(
    conn => { using var cmd = new NpgsqlCommand("SET statement_timeout = '4s'", conn); cmd.ExecuteNonQuery(); },
    async conn => { await using var cmd = new NpgsqlCommand("SET statement_timeout = '4s'", conn); await cmd.ExecuteNonQueryAsync(); });
var ds = b.Build();

// open 0: statement_timeout=4s inits=1
// open 1: statement_timeout=0  inits=1
// open 2: statement_timeout=0  inits=1
```

O inicializador roda uma vez, como prometido, e a primeira abertura enxerga `4s`. Depois a conexão volta ao pool, o `DISCARD ALL` apaga o `SET`, e o inicializador nunca mais roda porque a conexão física ainda existe. Toda requisição depois da primeira roda sem timeout. A própria documentação XML do Npgsql sobre o método avisa disso: as configurações aplicadas ali são revertidas pelo `DISCARD ALL`, a menos que você desligue o reset.

A correção é combiná-lo com `No Reset On Close=true`. No EF Core, `ConfigureDataSource` permite alcançar o builder sem sair de `UseNpgsql`:

```csharp
// .NET 10, EF Core 10.0.4, Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3
options.UseNpgsql(
    "Host=localhost;Port=55432;Username=postgres;Database=sp_demo;No Reset On Close=true",
    o => o.ConfigureDataSource(ds => ds.UsePhysicalConnectionInitializer(
        conn => { using var cmd = new NpgsqlCommand("SET search_path = tenant_b, public", conn); cmd.ExecuteNonQuery(); },
        async conn => { await using var cmd = new NpgsqlCommand("SET search_path = tenant_b, public", conn); await cmd.ExecuteNonQueryAsync(); })));

// ctx 0: widgets=1 search_path=tenant_b, public inits=1
// ctx 1: widgets=1 search_path=tenant_b, public inits=1
// ctx 2: widgets=1 search_path=tenant_b, public inits=1
```

Um `SET`, nenhum `DISCARD ALL` no log, e a configuração se mantém entre contextos. O preço é que *nada* mais é resetado. Se qualquer caminho de código executar um `SET` (um auxiliar de migração, uma consulta de diagnóstico, uma biblioteca), esse valor agora vaza para todo usuário posterior daquela conexão física, junto com tabelas temporárias e registros de `LISTEN`. Use essa combinação apenas quando você controla cada instrução que roda no pool. Se tudo de que você precisa é um valor estático, a connection string é mais simples e mais segura.

## Sobrescritas por consulta com SET LOCAL

Aumentar o timeout para uma operação sabidamente lenta não exige nenhuma mudança de sessão. O `SET LOCAL` dura até o fim da transação atual:

```csharp
// .NET 10, EF Core 10.0.4
await using var tx = await db.Database.BeginTransactionAsync();
await db.Database.ExecuteSqlRawAsync("SET LOCAL statement_timeout = '60s'");
await db.Database.ExecuteSqlRawAsync("REFRESH MATERIALIZED VIEW sales_summary");
await tx.CommitAsync();
// after commit: statement_timeout is back to the session default
```

No teste, `SHOW statement_timeout` retornou `100ms` dentro da transação e `0` logo após o commit, na mesma conexão, sem precisar de `DISCARD ALL`. Esta também é a única abordagem que funciona através do PgBouncer em modo de transação, tratado a seguir.

## Armadilhas com poolers, migrações e timeouts

**O PgBouncer rejeita parâmetros de inicialização desconhecidos.** Por padrão, o PgBouncer só aceita os parâmetros de inicialização que ele rastreia e gera um erro para todo o resto, incluindo `options`. Você pode adicionar `options` a `ignore_startup_parameters` (e então o PgBouncer descarta suas configurações silenciosamente) ou mover os padrões para `ALTER ROLE`. O PostgreSQL 18 reporta o `search_path` de volta ao cliente, então o PgBouncer o rastreia por padrão na 18. Em modo de transação ou de instrução, a documentação do Npgsql também diz para definir `No Reset On Close=true`, porque o `DISCARD ALL` não faz sentido quando o PgBouncer pode entregar a próxima transação a um backend diferente. Nesse modo, qualquer `SET` fora de uma transação é efetivamente aleatório, então use `SET LOCAL` ou padrões de role.

**O search_path decide onde as tabelas sem qualificação são criadas.** Com `Search Path=tenant_b,public` e sem `HasDefaultSchema`, o `EnsureCreatedAsync` criou `Widgets` em `tenant_b`. O provedor Npgsql também cria `__EFMigrationsHistory` com `CREATE TABLE IF NOT EXISTS` sem qualificação, então um executor de migrações cuja connection string carrega um `search_path` diferente do da aplicação vai criar uma segunda tabela de histórico e tentar reexecutar todas as migrações. Fixe o schema no modelo (`modelBuilder.HasDefaultSchema("tenant_b")` e `MigrationsHistoryTable("__EFMigrationsHistory", "tenant_b")`) ou garanta que o executor use exatamente a mesma connection string. Observe também que o `EnsureCreated` verifica se o banco de dados tem *alguma* tabela de usuário, não apenas as do seu search path: em um banco de dados que já tinha `tenant_a.orders`, ele pulou a criação por completo e o primeiro insert falhou com `42P01: relation "Widgets" does not exist`.

**As migrações precisam do próprio timeout.** Um `statement_timeout` de 5 segundos na connection string compartilhada vai matar um `CREATE INDEX` demorado durante a implantação. Dê ao executor de migrações a sua própria connection string com `Options=-c statement_timeout=0` (parâmetros de inicialização vencem os padrões de role), e veja [o guia sobre timeouts de migração do EF Core](/pt-br/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/) para a metade do problema que fica no cliente.

**O lock_timeout costuma ser o que você realmente quer.** Uma consulta presa atrás de um lock é o incidente de produção mais comum, e o `statement_timeout` só o captura depois que todo o orçamento é gasto. `lock_timeout=1s` falha rápido com `55P03` e deixa consultas legitimamente longas rodarem. O PostgreSQL 17 também adicionou `transaction_timeout`, que limita a transação inteira em vez de cada instrução.

**Alguns parâmetros não podem ser definidos assim.** Parâmetros de escopo do servidor são rejeitados em `options`: `-c shared_buffers=1GB` falha com `55P02 parameter "shared_buffers" cannot be changed without restarting the server`, e um parâmetro `sighup` como `log_checkpoints` falha com `55P02 ... cannot be changed now`. Parâmetros exclusivos de superusuário falham para uma role normal: `-c log_statement=none` como `app_user` resultou em `42501 permission denied to set parameter "log_statement"`. Em todos os casos o `OpenAsync` lança uma exceção, então você descobre na primeira requisição em vez de rodar silenciosamente com as configurações erradas.

## Escolhendo a abordagem

Para um valor fixo, use a connection string: `Search Path` para schemas, `Options=-c ...` para todo o resto. Ela não custa nada por abertura, sobrevive ao reset do pool e funciona para EF Core, Dapper e Npgsql puro. Use `ALTER ROLE ... SET` quando a connection string não é sua, ou como rede de segurança por baixo. Recorra a um interceptor `ConnectionOpened` apenas quando o valor depende de estado em runtime, e aceite a ida e volta extra. O `UsePhysicalConnectionInitializer` com `No Reset On Close=true` é uma ferramenta de nicho para pools em que você controla todas as instruções.

### Leia a seguir

- [O que é um interceptor do EF Core e quando preciso de um?](/pt-br/2026/09/what-is-an-ef-core-interceptor-and-when-do-i-need-one/) explica o pipeline de interceptors no qual a abordagem `ConnectionOpened` se conecta.
- [Como usar interceptors do EF Core 11 para auditoria](/pt-br/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/) mostra um interceptor de `SaveChanges` de ponta a ponta.
- [Como usar filtros de consulta nomeados para soft delete e multi-tenancy no EF Core 11](/pt-br/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/) é a alternativa em nível de linha à troca de `search_path` com um schema por tenant.
- [Como registrar em log o SQL que o EF Core 11 gera](/pt-br/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) ajuda a confirmar o que chega ao servidor, do lado do cliente.
- [Como adicionar atomicamente a um array jsonb do PostgreSQL com EF Core e Npgsql](/pt-br/2026/09/how-to-atomically-append-to-a-postgresql-jsonb-array-with-ef-core-and-npgsql/) é outro padrão específico do Npgsql testado contra o PostgreSQL 18.

### Fontes

- [Connection String Parameters](https://www.npgsql.org/doc/connection-string-parameters.html), documentação do Npgsql (`Search Path`, `Options`, `No Reset On Close`, `Command Timeout`)
- [Compatibility notes: pgbouncer](https://www.npgsql.org/doc/compatibility.html), documentação do Npgsql
- [`NpgsqlDataSourceBuilder.UsePhysicalConnectionInitializer`](https://github.com/npgsql/npgsql/blob/main/src/Npgsql/NpgsqlDataSourceBuilder.cs), npgsql/npgsql (comentários XML sobre `DISCARD ALL`)
- [`NpgsqlHistoryRepository.cs` at `v10.0.3`](https://github.com/npgsql/efcore.pg/blob/v10.0.3/src/EFCore.PG/Migrations/Internal/NpgsqlHistoryRepository.cs), npgsql/efcore.pg
- [DISCARD](https://www.postgresql.org/docs/current/sql-discard.html), documentação do PostgreSQL
- [Client Connection Defaults](https://www.postgresql.org/docs/current/runtime-config-client.html), documentação do PostgreSQL (`statement_timeout`, `lock_timeout`, `transaction_timeout`, `search_path`)
- [ALTER ROLE](https://www.postgresql.org/docs/current/sql-alterrole.html), documentação do PostgreSQL
- [Connection interception](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/interceptors#connection-interception), documentação do EF Core
- [PgBouncer configuration](https://www.pgbouncer.org/config.html) (`track_extra_parameters`, `ignore_startup_parameters`)
