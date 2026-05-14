---
title: "Correção: SqlException: Timeout expired durante migrações do EF Core"
description: "As migrações usam o DbContext de tempo de design, não o seu CommandTimeout de runtime. Defina o timeout via UseSqlServer(o => o.CommandTimeout(...)), o Command Timeout da string de conexão, ou Database.SetCommandTimeout antes de Migrate()."
pubDate: 2026-05-14
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "migrations"
lang: "pt-br"
translationOf: "2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations"
translatedBy: "claude"
translationDate: 2026-05-14
---

A correção: `dotnet ef database update` conecta através do `DbContext` de tempo de design, executa cada passo da migração como um único comando, e herda o `CommandTimeout` padrão de 30 segundos do provedor do SQL Server. Migrações longas (`AlterColumn` grandes, reconstruções de índice, backfills) ultrapassam os 30 segundos e o SqlClient lança `Microsoft.Data.SqlClient.SqlException (0x80131904): Execution Timeout Expired`. Configure o timeout em três lugares, nesta ordem de preferência: um `o.CommandTimeout(600)` no nível do provedor em `UseSqlServer`, um `Command Timeout=600` na string de conexão usada em tempo de design, ou aplique migrações a partir da sua aplicação com `context.Database.SetCommandTimeout(TimeSpan.FromMinutes(10))` antes de chamar `Migrate()`. A CLI `dotnet ef database update` em si não tem flag `--command-timeout` no EF Core 11, e este é o único fato que mais desperdiça tempo ao caçar este erro.

```text
Microsoft.Data.SqlClient.SqlException (0x80131904): Execution Timeout Expired.
The timeout period elapsed prior to completion of the operation or the server is not responding.
 ---> System.ComponentModel.Win32Exception (258): The wait operation timed out.
   at Microsoft.Data.SqlClient.SqlCommand.<>c.<ExecuteDbDataReaderAsync>b__214_0(Task`1 result)
   at Microsoft.EntityFrameworkCore.Storage.RelationalCommand.ExecuteReader(RelationalCommandParameterObject parameterObject)
   at Microsoft.EntityFrameworkCore.Migrations.MigrationCommandExecutor.ExecuteNonQuery(IEnumerable`1 migrationCommands, IRelationalConnection connection, MigrationExecutionState executionState, Boolean commitTransaction, Nullable`1 isolationLevel)
   at Microsoft.EntityFrameworkCore.Migrations.Internal.Migrator.Migrate(String targetMigration)
   at Microsoft.EntityFrameworkCore.Design.Internal.MigrationsOperations.UpdateDatabase(String targetMigration, String connectionString, String contextType)
ClientConnectionId:7c2f9aa3-...
Error Number:-2,State:0,Class:11
```

Este guia foi escrito contra .NET 11 preview 4, `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0-preview.4, `Microsoft.Data.SqlClient` 6.0.x e `dotnet-ef` 11.0.0-preview.4. A mensagem de erro tem sido estável entre versões do SqlClient, apenas o namespace mudou de `System.Data.SqlClient` para `Microsoft.Data.SqlClient` quando o provedor mudou no EF Core 3.0. O `Error Number:-2` é o sinal canônico: um valor de `-2` em `SqlException.Number` é o timeout de comando do lado do cliente, não uma falha do lado do servidor. Se você ver `Error Number:1222` ou outro código positivo, está diante de um problema diferente (espera de lock, falha de login) que o restante deste artigo não resolve.

## Por que as migrações expiram onde as consultas em runtime não expiram

Há duas instâncias de `DbContext` em jogo durante uma migração. A que sua aplicação ASP.NET Core usa em runtime, configurada por `AddDbContext`, e a que o `dotnet ef` constrói em tempo de design. Elas não são a mesma instância e não necessariamente compartilham configuração. O tooling de migrações do EF Core descobre um `DbContext` através de um de três mecanismos documentados na [referência da CLI do EF Core](https://learn.microsoft.com/pt-br/ef/core/cli/dotnet): chama um `CreateHostBuilder(string[])` público estático na sua classe `Program`, procura por um `IDesignTimeDbContextFactory<TContext>`, ou recua a executar o host da sua aplicação para que `AddDbContext` registre o contexto. Em todo caminho, ele constrói um `DbContext` novo e o usa para as migrações.

O `CommandTimeout` padrão do provedor do SQL Server é o padrão subjacente do `SqlCommand`, que é 30 segundos. Um `SetCommandTimeout` que você chama em algum lugar do pipeline de requisição executa sobre a instância de runtime, não a de tempo de design. Um `AlterColumn` que demora 90 segundos porque a tabela tem 8 milhões de linhas acaba despachado como um único comando sobre um `DbCommand` cujo `CommandTimeout` é 30, e o SqlClient o cancela após 30 segundos.

Duas coisas fazem isso falhar pior do que deveria. Primeiro, uma migração registra sua linha em `__EFMigrationsHistory` somente em caso de sucesso. Se o comando expira no meio do caminho, você pode acabar com um esquema parcialmente aplicado, a linha da migração ausente, e o próximo `dotnet ef database update` tentando novamente a mesma operação longa do zero. Segundo, o EF Core 9 e posteriores envolvem cada migração em uma transação por padrão, a menos que você opte por sair. Quando o timeout do comando dispara, o SQL Server faz rollback da migração inteira, o que é o resultado mais seguro mas também o que custa outros 30 segundos de wall time na próxima tentativa.

O lado CLI da história é claro. `dotnet ef database update` aceita `--connection`, `--context`, `--project`, `--startup-project` e as opções comuns. Não há `--command-timeout`. O time do EF Core tem rastreado isso como [dotnet/efcore#6613](https://github.com/dotnet/efcore/issues/6613) há anos; a resposta canônica permanece "configure isso na configuração do `DbContext`."

## Repro mínimo

Uma tabela com linhas suficientes para que qualquer `AlterColumn` demore mais de 30 segundos é o bastante.

```csharp
// .NET 11, C# 14, EF Core 11.0.0-preview.4
public class Order
{
    public int Id { get; set; }
    public string Reference { get; set; } = "";
    public decimal Total { get; set; }
}

public class OrdersContext : DbContext
{
    public DbSet<Order> Orders => Set<Order>();

    protected override void OnConfiguring(DbContextOptionsBuilder options)
        => options.UseSqlServer(
            "Server=localhost;Database=Orders;Integrated Security=true;Encrypt=false");
}
```

Adicione uma migração que amplia `Reference` de `nvarchar(50)` para `nvarchar(450)` para que o SQL Server tenha que reescrever cada linha em vez de fazer uma mudança apenas de metadados:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-preview.4
public partial class WidenReference : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AlterColumn<string>(
            name: "Reference",
            table: "Orders",
            type: "nvarchar(450)",
            maxLength: 450,
            nullable: false,
            oldClrType: typeof(string),
            oldType: "nvarchar(50)",
            oldMaxLength: 50);
    }
}
```

Execute `dotnet ef database update` contra uma tabela `Orders` com alguns milhões de linhas. Com o timeout padrão de 30 segundos, o comando lança exatamente o stack trace do topo deste artigo.

## A correção, em detalhe

Escolha a opção que combina com como as migrações são aplicadas no seu projeto. O ranking abaixo é por manutenibilidade, não por facilidade.

### 1. Configurar CommandTimeout no provedor na sua configuração do DbContext

Esta é a correção canônica. Fixa o timeout ao `DbContext` para que cada caminho de código, tempo de design e runtime, receba o mesmo valor.

```csharp
// .NET 11, C# 14, EF Core 11.0.0-preview.4
public class OrdersContext : DbContext
{
    public OrdersContext(DbContextOptions<OrdersContext> options) : base(options) { }
}

// Program.cs
builder.Services.AddDbContext<OrdersContext>(options =>
    options.UseSqlServer(
        builder.Configuration.GetConnectionString("Orders"),
        sql => sql.CommandTimeout(600))); // 10 minutes
```

O segundo argumento de `UseSqlServer` é um `Action<SqlServerDbContextOptionsBuilder>`. `CommandTimeout(int seconds)` vive em [SqlServerDbContextOptionsBuilder](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.infrastructure.sqlserverdbcontextoptionsbuilder.commandtimeout). Define o `CommandTimeout` para cada `DbCommand` que o EF Core constrói neste contexto, incluindo os que o executor de migrações despacha.

Se você tem um `IDesignTimeDbContextFactory<OrdersContext>` para tooling, configure lá também. O `dotnet ef` prefere `IDesignTimeDbContextFactory<T>` sobre `CreateHostBuilder` quando ambos estão presentes, então este override surte efeito para execuções de tempo de design:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-preview.4
public class OrdersContextFactory : IDesignTimeDbContextFactory<OrdersContext>
{
    public OrdersContext CreateDbContext(string[] args)
    {
        var connectionString = Environment.GetEnvironmentVariable("ORDERS_CONNECTION")
            ?? "Server=localhost;Database=Orders;Integrated Security=true;Encrypt=false";

        var options = new DbContextOptionsBuilder<OrdersContext>()
            .UseSqlServer(connectionString, sql => sql.CommandTimeout(600))
            .Options;

        return new OrdersContext(options);
    }
}
```

### 2. Colocar `Command Timeout` na string de conexão

Se você não pode editar o `DbContext` (está migrando o pacote de outra pessoa, ou seu descoberta de tempo de design usa uma string de conexão passada pelo CI), configure o timeout na string de conexão e o SqlClient o aplica a cada comando:

```text
Server=tcp:prod-sql.contoso.com;Database=Orders;Authentication=Active Directory Default;Encrypt=true;Command Timeout=600
```

A palavra-chave `Command Timeout` é suportada por `Microsoft.Data.SqlClient` e propaga para `SqlCommand.CommandTimeout`. Pipelines de CI que enviam um bundle de migração e passam `--connection` recebem isso de graça:

```bash
./efbundle --connection "Server=...;Command Timeout=600"
```

O executável do bundle não tem sua própria flag `--timeout` (veja [a referência de `dotnet ef migrations bundle`](https://learn.microsoft.com/pt-br/ef/core/cli/dotnet#dotnet-ef-migrations-bundle)). A string de conexão é o único botão que o bundle expõe.

### 3. Aplicar migrações a partir de código com `SetCommandTimeout`

Se você chama `context.Database.Migrate()` a partir da sua aplicação (um padrão comum para serviços auto-hospedados e testes de integração), configure o timeout sobre a fachada `Database` ativa logo antes da chamada. `SetCommandTimeout` muta o timeout de comando em runtime sobre a conexão do contexto:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-preview.4
using var scope = app.Services.CreateScope();
var db = scope.ServiceProvider.GetRequiredService<OrdersContext>();

db.Database.SetCommandTimeout(TimeSpan.FromMinutes(10));
await db.Database.MigrateAsync();
```

`Database.SetCommandTimeout` está documentado em [RelationalDatabaseFacadeExtensions](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.relationaldatabasefacadeextensions.setcommandtimeout). Aceita um `int` (segundos) ou `TimeSpan`. O valor persiste durante o tempo de vida do contexto, então um único set basta para cobrir uma chamada `MigrateAsync` inteira. Este é o padrão certo para [testes de integração que sobem um SQL Server real com Testcontainers](/pt-br/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/), já que o orquestrador de testes é dono da aplicação da migração.

## Detalhes e variantes que o tráfego de busca mistura

### "Timeout expired" com `Error Number != -2`

Se `SqlException.Number` não é `-2`, seu problema não é um timeout de comando do lado do cliente. As duas alternativas mais comuns que vêm com o mesmo texto são:

- `Error Number:1222` é um timeout de espera de lock. Outra sessão sustenta um lock no objeto que você tenta alterar e a configuração `LOCK_TIMEOUT` do SQL Server disparou. Aumentar `CommandTimeout` baterá na mesma parede; a correção é encontrar o bloqueador (`sp_who2`, `sys.dm_exec_requests`).
- `Error Number:-2` com `State:0,Class:11` e um `ClientConnectionId` é o timeout canônico de comando do cliente SqlClient que este artigo corrige.

### Connection Timeout vs Command Timeout

`Connection Timeout=30` (também escrito `Connect Timeout`) na string de conexão é quanto tempo o SqlClient espera para abrir a conexão TCP. Não afeta quanto tempo um único comando pode executar. Se você só mudou `Connection Timeout` e não `Command Timeout`, mexeu no botão errado. Documentação anterior ao EF Core 11 às vezes usa os dois de forma intercambiável em prosa; os nomes reais das propriedades são inequívocos.

### Migrações que envolvem múltiplas chamadas `AlterColumn`

O EF Core agrupa as operações de um único método `Up` em uma transação por padrão. O temporizador de 30 segundos é por `DbCommand`, não por migração, mas um único `AlterColumn` sobre uma tabela quente é facilmente um comando longo. Se você tem várias operações longas em uma migração, aumentar `CommandTimeout` uma vez é suficiente; você não precisa dividir a migração. Quando você quer dividi-la, os [comandos de migração de passo único do EF Core 11 como `dotnet ef migrations update --add`](/pt-br/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/) permitem encadear o trabalho de forma mais limpa.

### Azure SQL estrangula a migração longa

Se você aumenta o timeout para 30 minutos e a migração ainda falha em torno dos 60 segundos com a mesma mensagem, você não está batendo no timeout do cliente, está batendo no gateway do Azure SQL. O gateway sustenta sessões TCP ociosas, mas pode descartar sessões durante failover, throttling ou atualizações de serviço. Duas mitigações: transforme a operação em uma reconstrução de índice online com `WITH (ONLINE = ON)` para que o lock longo se quebre em outros mais curtos, e habilite [`EnableRetryOnFailure`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.infrastructure.sqlserverdbcontextoptionsbuilder.enableretryonfailure) para que o executor de migrações tente novamente a operação sob a mesma política de falha transitória que sua aplicação já usa:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-preview.4
options.UseSqlServer(connectionString, sql =>
{
    sql.CommandTimeout(1800);              // 30 minutes
    sql.EnableRetryOnFailure(
        maxRetryCount: 3,
        maxRetryDelay: TimeSpan.FromSeconds(30),
        errorNumbersToAdd: null);
});
```

### "Funciona na minha máquina, falha no CI"

Duas causas específicas. Primeiro, seu SQL Server local é pequeno e a tabela tem 200 linhas, então o `AlterColumn` completa em 200 ms. CI roda contra um banco de dados de staging com a contagem real de linhas, onde o mesmo comando demora minutos. Segundo, sua aplicação local usa a configuração do `DbContext` de runtime com um `CommandTimeout` generoso, enquanto CI executa `dotnet ef database update` e descobre um `DbContext` de tempo de design diferente que não tem seu override. As [regras de descoberta do `DbContext` de tempo de design](/pt-br/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/) explicam por que o CI acaba com um contexto diferente do que sua aplicação usa em runtime.

### Comportamento do timeout async vs sync

`SqlException.Number == -2` dispara identicamente para `ExecuteNonQuery` e `ExecuteNonQueryAsync`. Mudar para `MigrateAsync` não te salva, só libera a thread chamadora. `SetCommandTimeout` é o único botão que importa aqui.

### A tabela de histórico de migrações fica pela metade

Se o comando matou a conexão no meio do voo e você está travado na próxima execução porque o EF Core pensa que a migração foi aplicada, olhe `__EFMigrationsHistory`. Se a linha falta mas a mudança de coluna está parcialmente aplicada, você pode fazer rollback manual do DDL parcial com um único `ALTER` e rodar a migração novamente, ou inserir a linha em `__EFMigrationsHistory` e escrever uma migração de acompanhamento que termine o trabalho. Não delete linhas não relacionadas dessa tabela, o EF Core as usa para descobrir quais operações `Down()` executar.

## Relacionados

- [Correção: dotnet ef migrations add falha com "Unable to create an object of type DbContext"](/pt-br/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/) para o problema de descoberta de tempo de design upstream.
- [Migrações de passo único do EF Core 11 com dotnet ef migrations update --add](/pt-br/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/) se uma migração longa é mais fácil de dividir do que aumentar o timeout.
- [Escrever testes de integração contra um SQL Server real com Testcontainers](/pt-br/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/), já que `Database.SetCommandTimeout` mais `MigrateAsync` é o padrão de setup de testes.
- [Correção: A second operation was started on this context instance](/pt-br/2026/05/fix-second-operation-was-started-on-this-context-instance/) para outra exceção em forma de timing que muitas vezes é buscada junto com esta.
- [Como detectar consultas N+1 no EF Core 11](/pt-br/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) para o tipo de regressão de runtime que coloca tanta carga no banco que até migrações pequenas começam a expirar.

## Fontes

- [Referência da CLI do EF Core](https://learn.microsoft.com/en-us/ef/core/cli/dotnet) - a lista canônica de opções de `dotnet ef`.
- [SqlServerDbContextOptionsBuilder.CommandTimeout](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.infrastructure.sqlserverdbcontextoptionsbuilder.commandtimeout) documentação de API.
- [RelationalDatabaseFacadeExtensions.SetCommandTimeout](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.relationaldatabasefacadeextensions.setcommandtimeout) documentação de API.
- [dotnet/efcore#6613](https://github.com/dotnet/efcore/issues/6613) "Allow customizing migration commands timeout" rastreia por que não existe flag CLI.
- [dotnet/efcore#22887](https://github.com/dotnet/efcore/issues/22887) cobre o caso do bundle de migração e a solução alternativa com a string de conexão.
