---
title: "Correção: There is already an object named 'X' in the database depois de resetar as migrações do EF Core"
description: "Depois de apagar a pasta Migrations e gerar um novo InitialCreate, o EF Core não sabe que suas tabelas existem. Descarte o banco de dados de desenvolvimento ou registre a nova migração em __EFMigrationsHistory sem executá-la."
pubDate: 2026-10-06
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-10"
  - "ef-core-11"
  - "dotnet"
lang: "pt-br"
translationOf: "2026/10/fix-there-is-already-an-object-named-in-the-database-after-resetting-ef-core-migrations"
translatedBy: "claude"
translationDate: 2026-10-06
---

Você apagou a pasta `Migrations`, rodou `dotnet ef migrations add InitialCreate` e agora `dotnet ef database update` falha com `There is already an object named 'Blogs' in the database`. O EF Core decide o que executar comparando os IDs de migração do seu assembly com as linhas de `__EFMigrationsHistory`. Seu novo `InitialCreate` tem um timestamp novo, então o EF Core o trata como pendente e tenta fazer `CREATE TABLE` em tabelas que já existem. Se o banco de dados é descartável, remova-o (`dotnet ef database drop --force`) e atualize de novo. Se ele tem dados, apague as linhas antigas do histórico e insira uma linha para o novo ID de migração, para que o EF Core a registre como aplicada sem executá-la. Tudo abaixo foi medido no EF Core 10.0.12 com `dotnet-ef` 10.0.12 no .NET 10 (SDK 10.0.302), e a lógica não muda no EF Core 11.0.0-rc.1.

## O erro em contexto

No SQL Server este é o erro de engine 2714, exposto como uma `SqlException` pelo `dotnet ef database update` ou pelo `Database.Migrate()` na inicialização. Não havia uma instância do SQL Server disponível para este post, então o bloco abaixo é a execução no SQLite com o DDL e a mensagem de engine do SQL Server substituídos:

```text
Applying migration '20261006110224_InitialCreate'.
Failed executing DbCommand (12ms) [Parameters=[], CommandType='Text', CommandTimeout='30']
CREATE TABLE [Blogs] (
    [Id] int NOT NULL IDENTITY,
    [Name] nvarchar(max) NOT NULL,
    CONSTRAINT [PK_Blogs] PRIMARY KEY ([Id])
);
Microsoft.Data.SqlClient.SqlException (0x80131904): There is already an object named 'Blogs' in the database.
```

A mesma causa raiz aparece com outro texto em outros provedores. A linha do SQLite foi copiada da reprodução deste post; as linhas do PostgreSQL e do MySQL são os erros de engine para a mesma instrução `CREATE TABLE`:

```text
SQLite:      SQLite Error 1: 'table "Blogs" already exists'.
PostgreSQL:  42P07: relation "Blogs" already exists
MySQL:       Table 'Blogs' already exists        (error 1050)
SQL Server:  There is already an object named 'Blogs' in the database.   (error 2714)
```

A linha-chave é a primeira: `Applying migration '..._InitialCreate'`. Se o EF Core está aplicando sua migração inicial em um banco de dados que já tem seu schema, você está na página certa.

## Por que o EF Core tenta criar tabelas que já existem

O EF Core não inspeciona seu schema para decidir quais migrações executar. Ele roda uma única consulta, `SELECT MigrationId FROM __EFMigrationsHistory`, e compara o resultado com as migrações compiladas no seu assembly. Qualquer migração cujo ID não está na tabela é pendente, e migrações pendentes executam o método `Up()` inteiro.

Um ID de migração é o prefixo do nome do arquivo: um timestamp UTC mais o nome que você digitou, por exemplo `20261006110224_InitialCreate`. Quando você reseta as migrações, o novo `InitialCreate` recebe um timestamp novo. As linhas antigas (`20261006110219_InitialCreate`, `20261006110221_AddPublished`) continuam na tabela de histórico, mas o EF Core ignora em silêncio as linhas que não correspondem a nenhuma migração do assembly. Ele não avisa sobre elas. Então, do ponto de vista do EF Core, o banco de dados nunca viu sua nova migração, e o primeiro `CreateTable` bate em uma tabela que já está lá.

O mesmo descompasso acontece em algumas situações que não são um reset deliberado:

1. **O banco de dados foi criado por `EnsureCreated()`**. `EnsureCreated()` monta o schema direto a partir do modelo e nunca cria `__EFMigrationsHistory`. O primeiro `Migrate()` cria uma tabela de histórico vazia, considera todas as migrações pendentes e falha na primeira tabela.
2. **O banco de dados veio de outro lugar**: um backup restaurado de outra aplicação, um schema DB-first, um script rodado por um DBA. Mesmo cenário: as tabelas existem, o histórico não.
3. **A tabela de histórico mudou de lugar**. `MigrationsHistoryTable("__MyHistory", "app")` foi adicionado ou alterado depois da implantação, ou no SQL Server um login diferente tem schema padrão que não é `dbo`. O EF Core procura no novo local, não encontra nada e começa do zero.
4. **Duas migrações criam a mesma tabela**. Duas branches adicionaram cada uma uma migração que cria `AuditLog`, e as duas foram mescladas. A primeira funciona, a segunda lança o 2714.

## Reprodução mínima no EF Core 10

Esta é a sequência exata que rodei, usando SQLite para que seja reproduzível em qualquer máquina:

```csharp
// .NET 10, EF Core 10.0.12, Microsoft.EntityFrameworkCore.Sqlite 10.0.12
using Microsoft.EntityFrameworkCore;

using var db = new AppDb();

public class Blog { public int Id { get; set; } public string Name { get; set; } = ""; }
public class Post { public int Id { get; set; } public string Title { get; set; } = ""; public int BlogId { get; set; } }

public class AppDb : DbContext
{
    public DbSet<Blog> Blogs => Set<Blog>();
    public DbSet<Post> Posts => Set<Post>();
    protected override void OnConfiguring(DbContextOptionsBuilder o) => o.UseSqlite("Data Source=app.db");
}
```

```bash
# dotnet-ef 10.0.12
dotnet ef migrations add InitialCreate
# add a DateTime Published property to Post
dotnet ef migrations add AddPublished
dotnet ef database update            # applies both, history has 2 rows

rm -rf Migrations                    # the "reset"
dotnet ef migrations add InitialCreate
dotnet ef database update            # SQLite Error 1: 'table "Blogs" already exists'.
```

Depois da falha, `dotnet ef migrations list` mostra exatamente o que o EF Core acredita:

```text
20261006110224_InitialCreate (Pending)
```

As duas linhas antigas continuam na tabela de histórico. O EF Core 10 também envolve cada migração na própria transação, então no SQLite e no SQL Server o `InitialCreate` que falhou faz rollback limpo e não deixa nada aplicado pela metade. O MySQL é a exceção, porque lá o DDL faz commit implícito.

## Correção 1: descarte o banco de dados quando os dados não importam

Para um banco de dados de desenvolvimento local, o reset que você realmente queria é "migrações e banco de dados recomeçam juntos". A [documentação oficial](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/managing#resetting-all-migrations) descreve exatamente isso: apagar a pasta `Migrations` e descartar o banco de dados.

```bash
# dotnet-ef 10.0.12
dotnet ef database drop --force
dotnet ef database update
```

Essa é a resposta certa para um banco de dados no seu notebook ou um container descartável. Não use em nada compartilhado: ela apaga o banco de dados, dados incluídos.

## Correção 2: registre a nova linha de base sem executá-la

Se o banco de dados tem dados importantes, você quer o oposto: manter o schema e dizer ao EF Core que o novo `InitialCreate` já está aplicado. É o que a documentação chama de compactar (squash) migrações. O EF Core não tem um comando embutido para isso (o pedido está aberto há anos como [dotnet/efcore#2174](https://github.com/dotnet/efcore/issues/2174)), então é uma edição manual da tabela de histórico.

1. Faça backup do banco de dados.
2. Garanta que o banco de dados está na **última migração antiga** antes de resetar. Se estiver atrasado, aplique primeiro as migrações antigas que faltam, usando o código antigo do controle de versão. Uma linha de base só funciona se o novo `InitialCreate` descrever o schema que realmente está lá.
3. Apague a pasta `Migrations` e rode `dotnet ef migrations add InitialCreate`.
4. Rode `dotnet ef migrations script 0 InitialCreate` e copie a instrução `INSERT INTO [__EFMigrationsHistory]` do fim da saída. Ela tem o ID de migração e a versão do produto exatos.
5. Substitua as linhas antigas do histórico por essa única linha.

No SQL Server, o passo 5 fica assim:

```sql
-- SQL Server, EF Core 10.0.12 history table
BEGIN TRANSACTION;

DELETE FROM [__EFMigrationsHistory];

INSERT INTO [__EFMigrationsHistory] ([MigrationId], [ProductVersion])
VALUES (N'20261006110224_InitialCreate', N'10.0.12');

COMMIT;
```

Depois confirme que o EF Core concorda:

```bash
# dotnet-ef 10.0.12
dotnet ef migrations list                      # 20261006110224_InitialCreate, no "(Pending)"
dotnet ef migrations has-pending-model-changes # "No changes have been made to the model since the last migration."
```

Na minha reprodução, depois da linha de base adicionei uma propriedade `Url` em `Blog`, gerei `AddBlogUrl`, e `dotnet ef database update` aplicou só essa migração. É o estado que você quer: o histórico tem uma linha de base e as novas migrações seguem normalmente por cima dela.

Apagar as linhas antigas não é estritamente necessário, porque o EF Core ignora linhas que não reconhece. Apague mesmo assim. Se alguém depois fizer checkout de um commit antigo e rodar `database update` contra este banco de dados, as linhas obsoletas fazem o EF Core achar que as migrações antigas estão aplicadas, e essa falha é confusa de depurar.

## Linha de base em mais de um ambiente

Compactar é fácil em um banco de dados e sujeito a erros em cinco. Cada ambiente existente precisa da troca de linhas, e cada ambiente novo precisa que o `InitialCreate` completo rode. O jeito mais seguro de ter as duas coisas é uma guarda que só reescreve o histórico quando encontra a cadeia antiga, e não faz nada caso contrário.

Como um script SQL que você roda uma vez por ambiente, antes de implantar o código compactado:

```sql
-- SQL Server, run before deploying the squashed migrations
BEGIN TRANSACTION;

IF EXISTS (SELECT 1 FROM [__EFMigrationsHistory]
           WHERE [MigrationId] = N'20261006110221_AddPublished')
   AND NOT EXISTS (SELECT 1 FROM [__EFMigrationsHistory]
                   WHERE [MigrationId] = N'20261006110224_InitialCreate')
BEGIN
    DELETE FROM [__EFMigrationsHistory];
    INSERT INTO [__EFMigrationsHistory] ([MigrationId], [ProductVersion])
    VALUES (N'20261006110224_InitialCreate', N'10.0.12');
END;

COMMIT;
```

A guarda fica na **última** migração antiga, não na primeira. Um banco de dados que nunca chegou a `AddPublished` não tem o schema que seu novo `InitialCreate` descreve, então não deve receber a linha de base. Ele precisa ser atualizado com o código antigo primeiro.

Se você aplica migrações a partir da aplicação na inicialização, a mesma guarda cabe antes do `Migrate()`. Testei contra três bancos de dados: um no estado antigo `AddPublished`, o mesmo banco de dados numa segunda execução e um arquivo novo vazio. Os três terminaram com `InitialCreate, AddBlogUrl` aplicadas e o schema correto.

```csharp
// .NET 10, EF Core 10.0.12
using Microsoft.EntityFrameworkCore;

using var db = new AppDb();
BaselineSquashedMigrations(db);
db.Database.Migrate();

static void BaselineSquashedMigrations(AppDb db)
{
    const string lastOldMigration = "20261006110221_AddPublished";
    const string newBaseline = "20261006110224_InitialCreate";

    // Returns every row in __EFMigrationsHistory, including IDs that no longer exist in the assembly.
    // Returns an empty list when the history table does not exist yet (fresh database).
    var applied = db.Database.GetAppliedMigrations().ToHashSet();
    if (!applied.Contains(lastOldMigration) || applied.Contains(newBaseline))
        return;

    using var tx = db.Database.BeginTransaction();
    db.Database.ExecuteSql($"DELETE FROM __EFMigrationsHistory");
    db.Database.ExecuteSql(
        $"INSERT INTO __EFMigrationsHistory (MigrationId, ProductVersion) VALUES ({newBaseline}, {"10.0.12"})");
    tx.Commit();
}
```

O nome da tabela está sem aspas para que o mesmo código funcione no SQL Server e no SQLite. No PostgreSQL ele precisa ser citado como `"__EFMigrationsHistory"`, porque lá o identificador diferencia maiúsculas de minúsculas. Rode isso em um único passo de migração (um job, um init container ou uma única instância), não em cada réplica. `Migrate()` adquire um lock de migração desde o EF Core 9, mas este helper roda antes desse lock ser adquirido. Se você implanta com bundles, rode a versão SQL antes do bundle, como explicado em [aplicar migrações do EF Core em produção com migration bundles](/pt-br/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/). Remova o helper quando todos os ambientes tiverem a linha de base.

## O truque do Up() vazio, e por que eu o evito

Uma resposta comum no Stack Overflow diz: comente o corpo de `Up()` no novo `InitialCreate`, rode `database update` para a linha ser registrada e depois restaure o corpo. Funciona para um banco de dados em uma máquina. Também é exatamente assim que uma migração quebrada vai parar num commit: esqueça de restaurar o corpo e todo ambiente novo recebe um schema vazio com uma linha de histórico dizendo que está completo. A linha de base em SQL faz a mesma coisa no banco de dados sem tocar no arquivo de migração, então não há nada para esquecer.

## Armadilhas e erros parecidos

**O código customizado das migrações antigas some.** Qualquer `migrationBuilder.Sql(...)` que você escreveu para views, stored procedures, triggers ou linhas de seed vivia nos arquivos apagados. O novo `InitialCreate` só contém o que o modelo conhece. Copie esses blocos manualmente para a nova migração, ou ambientes novos vão ficar sem objetos que a produção tem.

**O drift do schema faz a linha de base mentir.** Se alguém adicionou um índice ou uma coluna direto em produção, o novo `InitialCreate` não o contém, e a linha de base registra um schema que não bate. Antes de criar a linha de base, compare a saída de `dotnet ef migrations script 0 InitialCreate` com o schema real (schema compare do SSMS, `pg_dump --schema-only` ou `sqlite3 .schema`).

**`EnsureCreated()` ao lado de `Migrate()`.** Se você chegou aqui porque o banco de dados foi criado por `EnsureCreated()`, remova essa chamada antes de qualquer outra coisa. Ela nunca cria a tabela de histórico, então os dois não podem coexistir. O mesmo conselho aparece no post sobre [`CREATE DATABASE permission denied` durante `dotnet ef database update`](/pt-br/2026/08/fix-create-database-permission-denied-in-database-master-dotnet-ef-database-update/), que é outro sintoma de misturar os dois.

**A inicialização lança outro erro primeiro.** Desde o EF Core 9, `Migrate()` se recusa a rodar quando o modelo tem alterações não capturadas em uma migração. Se em vez disso você vir `The model for context has pending changes`, resolva isso primeiro, como descrito no [post sobre alterações de modelo pendentes](/pt-br/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/), e depois volte.

**Migração aplicada pela metade depois de um timeout.** Se o 2714 aparece em uma migração que não é a inicial, a causa pode ser uma migração que morreu no meio. Esse caso está em [como corrigir timeouts de SqlException durante migrações do EF Core](/pt-br/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/), incluindo como reparar a linha do histórico.

**Scripts `--idempotent` não salvam você.** `dotnet ef migrations script --idempotent` envolve cada migração em `IF NOT EXISTS (SELECT * FROM [__EFMigrationsHistory] WHERE [MigrationId] = N'...')`. Ele verifica o ID da migração, não a tabela, então um novo ID de `InitialCreate` ainda roda seu `CREATE TABLE` e falha do mesmo jeito.

**`dotnet ef migrations add` falha antes de você chegar aqui.** Se a ferramenta não consegue construir seu contexto durante o reset, é um problema de configuração em tempo de design, coberto em [como corrigir "Unable to create an object of type DbContext"](/pt-br/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/).

## Relacionados

- [Como aplicar migrações do EF Core 11 em produção com dotnet ef migrations bundle](/pt-br/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/)
- [Correção: The model for context has pending changes no EF Core 11](/pt-br/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/)
- [Correção: SqlException: Timeout expired durante migrações do EF Core](/pt-br/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/)
- [Correção: CREATE DATABASE permission denied in database 'master'](/pt-br/2026/08/fix-create-database-permission-denied-in-database-master-dotnet-ef-database-update/)
- [Correção: dotnet ef migrations add "Unable to create an object of type DbContext"](/pt-br/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/)

## Fontes

- [Managing Migrations: Resetting all migrations](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/managing#resetting-all-migrations), Microsoft Learn.
- [Custom Migrations History Table](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/history-table), Microsoft Learn.
- [Applying Migrations](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/applying), Microsoft Learn.
- [dotnet/efcore#2174](https://github.com/dotnet/efcore/issues/2174), o pedido de funcionalidade aberto para compactar migrações.
- [`HistoryRepository.cs` na branch release/10.0](https://github.com/dotnet/efcore/blob/release/10.0/src/EFCore.Relational/Migrations/HistoryRepository.cs), que mostra os padrões de nome e schema da tabela de histórico.
