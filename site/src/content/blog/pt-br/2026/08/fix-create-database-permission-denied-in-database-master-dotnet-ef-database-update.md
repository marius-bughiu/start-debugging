---
title: "Correção: CREATE DATABASE permission denied in database 'master' ao rodar dotnet ef database update"
description: "O Migrate() do EF Core sempre verifica se o banco de dados existe e o cria se não existir, a partir de uma conexão com master fixa no código. Conceda CREATE ANY DATABASE, corrija o acesso do login ao banco existente, ou gere um script SQL idempotente."
pubDate: 2026-08-30
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "migrations"
  - "sql-server"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/08/fix-create-database-permission-denied-in-database-master-dotnet-ef-database-update"
translatedBy: "claude"
translationDate: 2026-08-30
---

O `dotnet ef database update` não está tentando criar seu banco de dados porque você pediu. Toda chamada a `Migrate()` começa com `if (!_databaseCreator.Exists()) _databaseCreator.Create()`, e não existe chave para desligar isso. Então ou seu login realmente não pode criar bancos de dados (conceda a ele `CREATE ANY DATABASE` em `master`, ou adicione-o a `##MS_DatabaseManager##`), ou o banco já existe e o login não consegue abri-lo, algo que o EF Core interpreta erroneamente como "não existe". Verifique o segundo caso primeiro: `SELECT DB_ID('YourDb')` como `sa`, depois `SELECT DB_ID('YourDb')` como o login de migração. Se o primeiro retornar um número e o segundo retornar `NULL`, a correção é um usuário de banco de dados, não uma permissão de servidor. Para produção, pare de rodar `Migrate()` com um login privilegiado e entregue a um DBA a saída de `dotnet ef migrations script --idempotent`, que não contém nenhum `CREATE DATABASE`.

Tudo abaixo foi verificado com `Microsoft.EntityFrameworkCore.SqlServer` 10.0.11 e a CLI `dotnet-ef` 10.0.11 no SDK do .NET 10.0.302. Os caminhos de código `Migrator.Migrate` e `SqlServerDatabaseCreator` citados aqui não mudaram entre EF Core 8, 9, 10 e 11, então o comportamento e todas as correções valem para as quatro versões. Quando uma afirmação vem da documentação do SQL Server em vez de uma execução nesta máquina, eu digo.

## O erro em contexto

```text
Build started...
Build succeeded.
Microsoft.Data.SqlClient.SqlException (0x80131904): CREATE DATABASE permission denied in database 'master'.
   at Microsoft.Data.SqlClient.SqlConnection.OnError(SqlException exception, Boolean breakConnection, Action`1 wrapCloseInAction)
   ...
   at Microsoft.EntityFrameworkCore.Migrations.Internal.MigrationCommandExecutor.ExecuteNonQuery(...)
   at Microsoft.EntityFrameworkCore.SqlServer.Storage.Internal.SqlServerDatabaseCreator.Create()
   at Microsoft.EntityFrameworkCore.Migrations.Internal.Migrator.Migrate(String targetMigration)
ClientConnectionId:...
Error Number:262,State:1,Class:14
CREATE DATABASE permission denied in database 'master'.
```

Esse rastreamento foi montado a partir da cadeia de chamadas do EF Core mostrada abaixo, e não capturado nesta máquina, que não tem uma instância do SQL Server; os nomes dos frames e os números de erro vêm do código-fonte publicado e dos erros documentados do SQL Server. Dois frames importam. `SqlServerDatabaseCreator.Create()` diz que o EF concluiu que o banco de dados estava faltando. `Error Number:262` é o erro de permissão do SQL Server, não um erro de conexão, o que significa que o login autenticou normalmente e chegou a executar uma instrução.

## Por que o dotnet ef database update encosta no master

Nada no seu `Program.cs` nem na sua string de conexão menciona `master`. Quem coloca isso é o EF. O código relevante é a primeira coisa que `Migrate()` faz, em [`Migrator.cs`](https://github.com/dotnet/efcore/blob/main/src/EFCore.Relational/Migrations/Internal/Migrator.cs):

```csharp
// Microsoft.EntityFrameworkCore.Relational 10.0.11, Migrator.Migrate
if (!_databaseCreator.Exists())
{
    _databaseCreator.Create();
}
```

Não há opção, nem flag no `DbContextOptionsBuilder`, nem variável de ambiente que pule isso. O `dotnet ef database update` passa exatamente por este método, e o mesmo vale para `context.Database.Migrate()` na inicialização da aplicação e para um bundle de migração produzido por `dotnet ef migrations bundle`.

O `Create()` então monta a própria conexão. De [`SqlServerConnection.cs`](https://github.com/dotnet/efcore/blob/main/src/EFCore.SqlServer/Storage/Internal/SqlServerConnection.cs):

```csharp
// Microsoft.EntityFrameworkCore.SqlServer 10.0.11
public virtual ISqlServerConnection CreateMasterConnection()
{
    var connectionStringBuilder = new SqlConnectionStringBuilder(GetValidatedConnectionString())
        { InitialCatalog = "master" };
    connectionStringBuilder.Remove("AttachDBFilename");
    ...
}
```

`InitialCatalog = "master"` está fixo no código. É daí que vem o `in database 'master'` da mensagem. Nessa conexão o EF roda o T-SQL que o próprio gerador dele emite para uma `SqlServerCreateDatabaseOperation`:

```sql
-- what EF Core 10.0.11 sends on the master connection
CREATE DATABASE [Shop];
GO
IF SERVERPROPERTY('EngineEdition') <> 5
BEGIN
    ALTER DATABASE [Shop] SET READ_COMMITTED_SNAPSHOT ON;
END;
```

O motivo de você receber um erro de *permissão* e não de *login* é que qualquer login do SQL Server consegue abrir o `master`. A permissão `CONNECT` do usuário `guest` pode ser revogada "em qualquer banco de dados que não seja `master` ou `tempdb`", segundo a [documentação de principals](https://learn.microsoft.com/en-us/sql/relational-databases/security/authentication-access/principals-database-engine). Então o EF conecta com sucesso e depois tropeça na instrução.

## A verificação de existência é mais frouxa do que você imagina

Aqui está a parte que leva a maioria das pessoas pelo caminho errado. O `SqlServerDatabaseCreator.Exists()` não consulta `sys.databases`. Ele abre uma conexão com o banco de dados alvo e roda `SELECT 1`, e trata três números de `SqlException` como prova de que o banco não existe:

```csharp
// Microsoft.EntityFrameworkCore.SqlServer 10.0.11
private static bool IsDoesNotExist(SqlException exception)
    => exception.Number is 4060 or 1832 or 5120;
```

O erro 4060 é `Cannot open database "Shop" requested by the login. The login failed.` O SQL Server o levanta tanto quando o banco está faltando **quanto** quando o login não tem um usuário mapeado em um banco que existe, ou quando o banco está offline, restaurando, ou em modo `SINGLE_USER`. O EF não consegue distinguir esses casos, então conclui que o banco está faltando e sai para criá-lo. Aí você recebe o erro 262 sobre `master`, quando o problema real é um `CREATE USER` faltando em `Shop`.

Distinga os dois casos antes de mexer em qualquer permissão. Conecte-se como administrador e rode:

```sql
-- as sa or a sysadmin
SELECT DB_ID('Shop') AS db_id, state_desc, user_access_desc
FROM sys.databases WHERE name = 'Shop';
```

Depois conecte-se com as credenciais exatas da string de conexão de migração e rode:

```sql
-- as the migration login
SELECT DB_ID('Shop') AS visible_to_me;
```

Uma linha na primeira consulta mais `NULL` na segunda significa que o banco existe e seu login não consegue vê-lo. Isso é a próxima seção. Nada na primeira consulta significa que ele realmente está faltando, que é a seção seguinte.

## Correção 1: o banco existe, o login não consegue abri-lo

Este é o formato comum em CI e em ambientes recém-restaurados: alguém restaurou um `.bak` ou criou o banco a partir de um script, e o login em nível de servidor existe mas não tem um usuário de banco correspondente, ou tem um órfão por SID depois de uma restauração.

```sql
-- SQL Server 2019+ / Azure SQL MI; run in the target database
USE [Shop];
GO
CREATE USER [app] FOR LOGIN [app];
ALTER ROLE db_ddladmin ADD MEMBER [app];   -- schema changes
ALTER ROLE db_datareader ADD MEMBER [app];
ALTER ROLE db_datawriter ADD MEMBER [app];
GO
```

Se o usuário já existe mas ficou órfão depois de uma restauração, aponte-o de volta para o login em vez de recriá-lo:

```sql
USE [Shop];
GO
ALTER USER [app] WITH LOGIN = [app];
GO
```

`db_ddladmin` é o que as migrações precisam: `CREATE TABLE`, `ALTER TABLE`, `CREATE INDEX`, e a tabela `__EFMigrationsHistory` que o EF cria na primeira execução. `db_owner` também funciona e é para onde a maioria corre, mas dá mais do que as migrações exigem.

Duas variantes levantam 4060 por razões que um usuário de banco não resolve. Se `state_desc` não for `ONLINE`, coloque o banco online. Se `user_access_desc` for `SINGLE_USER`, rode `ALTER DATABASE [Shop] SET MULTI_USER;`. Nos dois casos o EF continuará tentando criar um banco de dados que está bem ali.

## Correção 2: o banco realmente não existe e você quer que o EF o crie

Esta é a correção certa para uma máquina de desenvolvimento, um contêiner descartável de CI, ou qualquer ambiente onde o login de migração tem permissão para ser dono do próprio banco.

A opção de menor privilégio no SQL Server 2022 (16.x) e posteriores, e no Azure SQL Database, é a role fixa de servidor `##MS_DatabaseManager##`. Segundo a [documentação de roles em nível de servidor](https://learn.microsoft.com/en-us/sql/relational-databases/security/authentication-access/server-level-roles), seus membros "can create databases, and delete databases they own", e ela carrega as permissões de nível de servidor `CREATE ANY DATABASE` e `ALTER ANY DATABASE`:

```sql
-- SQL Server 2022 (16.x)+ and Azure SQL Database
ALTER SERVER ROLE [##MS_DatabaseManager##] ADD MEMBER [app];
```

No SQL Server 2019 (15.x) e anteriores essa role não existe, então conceda a permissão de nível de servidor diretamente. Esta é a versão a preferir em vez de `dbcreator`, porque os membros de `dbcreator` "can create, alter, drop, and restore **any** database", inclusive os que sua migração não tem por que tocar:

```sql
-- SQL Server 2016 (13.x) and later, including 2019 (15.x) where no role exists
USE master;
GO
GRANT CREATE ANY DATABASE TO [app];
GO
```

`CREATE DATABASE` e `CREATE ANY DATABASE` não são intercambiáveis, e confundir os dois é uma segunda falha comum. `CREATE DATABASE` é uma permissão de *escopo de banco de dados* em `master`, então só pode ser concedida a um usuário de banco, o que significa que o login precisa antes de um usuário em `master`:

```sql
-- the CREATE DATABASE variant needs a user in master
USE master;
GO
CREATE USER [app] FOR LOGIN [app];
GRANT CREATE DATABASE TO [app];
GO
```

`CREATE ANY DATABASE` tem escopo de servidor e é concedida ao próprio login, e por isso não precisa de usuário em `master`. A [documentação do CREATE DATABASE](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-database-transact-sql) lista `CREATE DATABASE`, `CREATE ANY DATABASE` ou `ALTER ANY DATABASE` como suficientes.

No Azure SQL Database o caminho antigo é a role de banco `dbmanager` em `master`, que a documentação ainda lista como principal válido para `CREATE DATABASE`:

```sql
-- Azure SQL Database, connected to master
CREATE USER [app] FROM LOGIN [app];
ALTER ROLE dbmanager ADD MEMBER [app];
GO
```

Cuidado com esta no Azure. O EF emite um `CREATE DATABASE [Shop];` puro, sem `EDITION` nem `SERVICE_OBJECTIVE`, então o servidor escolhe o tier padrão e começa a cobrar por ele. É exatamente essa a reclamação de [dotnet/efcore#29251](https://github.com/dotnet/efcore/issues/29251), "EF Core automatically creates expensive database when executing migrations", que o time fechou como não planejado. Não conceda direitos de criação de banco a um login de implantação apontado para um servidor Azure SQL a menos que você esteja tranquilo com um erro de digitação no nome de um banco provisionando um novo banco cobrável.

## Correção 3: tire o passo de criação da implantação por completo

Se o login é sem privilégios de propósito, nenhuma quantidade de permissões concedidas é a resposta certa. Pare de rodar `Migrate()` nesse ambiente e aplique SQL no lugar. O script gerado nunca contém `CREATE DATABASE`, porque o gerador de scripts opera só sobre migrações e nunca chama `IRelationalDatabaseCreator`:

```bash
dotnet ef migrations script --idempotent --output migrate.sql
```

No EF Core 10.0.11 isso produz exatamente o seguinte para uma única migração inicial:

```sql
IF OBJECT_ID(N'[__EFMigrationsHistory]') IS NULL
BEGIN
    CREATE TABLE [__EFMigrationsHistory] (
        [MigrationId] nvarchar(150) NOT NULL,
        [ProductVersion] nvarchar(32) NOT NULL,
        CONSTRAINT [PK___EFMigrationsHistory] PRIMARY KEY ([MigrationId])
    );
END;
GO

BEGIN TRANSACTION;
IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20260830061302_InitialCreate'
)
BEGIN
    CREATE TABLE [Customers] (
        [Id] int NOT NULL IDENTITY,
        [Name] nvarchar(max) NOT NULL,
        CONSTRAINT [PK_Customers] PRIMARY KEY ([Id])
    );
END;
...
COMMIT;
GO
```

Nenhuma referência a `master`. A flag `--idempotent` torna o script seguro para rodar contra um banco em qualquer nível de migração, que é o que você quer quando um DBA o aplica na mão. O time do EF diz isso na [documentação sobre aplicar migrações](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/applying): o `dotnet ef database update` "applies SQL commands directly by the tool, without giving the developer a chance to inspect or modify them", e a documentação sinaliza explicitamente que chamar `Migrate()` na inicialização "requires elevated access to modify the database schema", o que conflita com o menor privilégio em produção.

O fluxo passa a ser: criar o banco uma vez, na mão ou via Terraform ou Bicep, conceder ao login da aplicação `db_ddladmin` dentro dele, e aplicar `migrate.sql` no pipeline de release. O login da aplicação nunca precisa de uma única permissão em `master`.

## Bundles de migração não te livram disso

Um mal-entendido comum é que `dotnet ef migrations bundle` contorna o problema por ser um executável autônomo sem dependência do SDK. Não contorna. O bundle chama `Migrate()`, então roda o mesmo par `Exists()`/`Create()` e falha com o mesmo erro 262 sob um login sem privilégios. Bundles resolvem o problema de "não há SDK no agente de implantação", não o problema de permissão. Se seu ambiente alvo proíbe `CREATE DATABASE`, os bundles precisam do mesmo tratamento que a CLI: faça o banco existir primeiro e faça o login conseguir abri-lo. A mecânica desse pipeline está em [aplicar migrações do EF Core 11 em produção com dotnet ef migrations bundle](/pt-br/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/).

## Variantes que produzem um erro parecido

**`CREATE TABLE permission denied in database 'master'.`** Mesmo número de erro, instrução diferente. Este significa que sua string de conexão não tem `Database=` nem `Initial Catalog=`, então o SQL Server te jogou no banco padrão do login, que para o `sa` é `master`. O EF não está criando nada; está rodando sua migração contra o `master`. Adicione o banco à string de conexão.

**`EnsureCreated()` em vez de migrações.** O `Database.EnsureCreated()` levanta o erro idêntico pelo motivo idêntico, e é pior: ele cria o schema sem uma tabela `__EFMigrationsHistory`, então migrações nunca poderão ser aplicadas àquele banco depois. Se você encontrar uma chamada a `EnsureCreated()` no `Program.cs` ao lado de uma pasta de migrações, apague-a.

**LocalDB.** O `(localdb)\MSSQLLocalDB` roda como sua conta do Windows, que é dona da instância, então um 262 ali quase sempre significa que você está conectado a uma instância compartilhada ou a um SQL Server real que você achava que era LocalDB. Confira o nome do servidor na string de conexão que a ferramenta realmente carregou, com `dotnet ef database update -v`.

**Um timeout que parece falha de permissão.** Se a mensagem for `Execution Timeout Expired` em vez do erro 262, o login está bem e a migração em si é lenta. Esse é outro problema, coberto em [SqlException: Timeout expired durante migrações do EF Core](/pt-br/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/).

**Nenhuma conexão.** Se o `dotnet ef` nunca chega ao SQL Server, você verá `Unable to create an object of type 'DbContext'` no lugar, que é uma falha de descoberta em tempo de design e não de permissão. Isso está coberto em [dotnet ef migrations add falha com "Unable to create an object of type DbContext"](/pt-br/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/).

A lição mais ampla é que o pipeline de migrações do EF Core foi projetado para o ciclo interno do desenvolvedor, onde ser dono do próprio banco é o caso normal, e o passo de criação automática nunca foi tornado opcional. O [dotnet/efcore#18839](https://github.com/dotnet/efcore/issues/18839), que pedia exatamente isso para que uma aplicação de migração não precisasse de direitos de criação de banco, foi fechado como não planejado. Trate `Migrate()` como uma conveniência de desenvolvimento e scripts SQL como o mecanismo de implantação, e o erro 262 deixa de ser algo que você possa encontrar em produção.

## Relacionados

- [Como aplicar migrações do EF Core 11 em produção com dotnet ef migrations bundle](/pt-br/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/)
- [Correção: SqlException: Timeout expired durante migrações do EF Core](/pt-br/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/)
- [Correção: dotnet ef migrations add falha com "Unable to create an object of type DbContext"](/pt-br/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/)
- [Correção: dotnet tool install --global dotnet-ef lança um erro](/pt-br/2026/08/fix-dotnet-tool-install-global-dotnet-ef-throws-an-error/)
- [Como renomear uma tabela em uma migração do EF Core 11 sem perder dados](/pt-br/2026/08/how-to-rename-a-table-in-an-ef-core-11-migration-without-losing-data/)

## Fontes

- [Migrator.cs, `Migrate(string? targetMigration)`](https://github.com/dotnet/efcore/blob/main/src/EFCore.Relational/Migrations/Internal/Migrator.cs) - o par incondicional `Exists()`/`Create()`
- [SqlServerDatabaseCreator.cs](https://github.com/dotnet/efcore/blob/main/src/EFCore.SqlServer/Storage/Internal/SqlServerDatabaseCreator.cs) - o `IsDoesNotExist` e a sonda de existência com `SELECT 1`
- [SqlServerConnection.cs, `CreateMasterConnection`](https://github.com/dotnet/efcore/blob/main/src/EFCore.SqlServer/Storage/Internal/SqlServerConnection.cs) - o `InitialCatalog = "master"` fixo no código
- [CREATE DATABASE (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-database-transact-sql) - permissões exigidas no SQL Server e no Azure SQL Database
- [Server-level roles](https://learn.microsoft.com/en-us/sql/relational-databases/security/authentication-access/server-level-roles) - `##MS_DatabaseManager##` e `dbcreator`
- [Principals (Database Engine)](https://learn.microsoft.com/en-us/sql/relational-databases/security/authentication-access/principals-database-engine) - por que o `guest` não pode ser revogado no `master`
- [Applying migrations - EF Core](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/applying) - scripts, bundles e o aviso sobre menor privilégio
- [dotnet/efcore#18839](https://github.com/dotnet/efcore/issues/18839) - "Database Migrate fails to execute for manually created database", fechado como não planejado
- [dotnet/efcore#29251](https://github.com/dotnet/efcore/issues/29251) - "EF Core automatically creates expensive database when executing migrations", fechado como não planejado
