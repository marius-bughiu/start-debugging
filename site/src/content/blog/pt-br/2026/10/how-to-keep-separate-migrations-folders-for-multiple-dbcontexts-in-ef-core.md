---
title: "Como manter pastas de migrações separadas para vários DbContexts em um único projeto EF Core"
description: "Passe --output-dir uma vez por DbContext e o EF Core mantém todas as migrações seguintes nessa pasta e namespace. Por que o layout padrão é assimétrico, a colisão CS0111 de uma pasta compartilhada, como mover migrações existentes e quando separar a tabela de histórico."
pubDate: 2026-10-26
template: how-to
tags:
  - "ef-core"
  - "ef-core-10"
  - "ef-core-11"
  - "migrations"
  - "dotnet"
lang: "pt-br"
translationOf: "2026/10/how-to-keep-separate-migrations-folders-for-multiple-dbcontexts-in-ef-core"
translatedBy: "claude"
translationDate: 2026-10-26
---

**Resposta curta:** crie a primeira migração de cada contexto com seu próprio `--output-dir`, por exemplo `dotnet ef migrations add InitialCreate --context CatalogDbContext --output-dir Data/Migrations/Catalog` e o mesmo para `OrdersDbContext` com `Data/Migrations/Orders`. O EF Core deriva o namespace dessa pasta (`Shop.Data.Migrations.Catalog`), e todo `migrations add` seguinte para o mesmo contexto vai automaticamente para junto da migração e do snapshot anteriores, então você nunca mais precisa passar `--output-dir`. Não aponte dois contextos para a mesma pasta: migrações com o mesmo nome viram uma única classe parcial e a compilação falha com CS0111. Tudo abaixo foi executado no EF Core 10.0.14 com `dotnet-ef` 10.0.14 no .NET 10 (SDK 10.0.302) contra SQLite. Também comparei o código de scaffolding no branch `release/11.0`, e a lógica de pasta e namespace não mudou no EF Core 11.

## O que o EF Core faz quando você não escolhe

Muita gente nunca decide um layout. Adiciona um segundo `DbContext` ao projeto, esbarra no primeiro erro, adiciona `--context` e segue em frente. Vale ver o que isso produz, porque explica a maioria das estruturas de pastas confusas que encontro em repositórios reais.

Este é o cenário usado ao longo do post: um projeto de console chamado `Shop`, dois contextos, ambos apontando para o mesmo arquivo SQLite.

```csharp
// .NET 10, EF Core 10.0.14
// Data/Contexts.cs
using Microsoft.EntityFrameworkCore;

namespace Shop.Data;

public class Product { public int Id { get; set; } public string Name { get; set; } = ""; }
public class Order { public int Id { get; set; } public int ProductId { get; set; } public int Quantity { get; set; } }

public class CatalogDbContext(DbContextOptions<CatalogDbContext> options) : DbContext(options)
{
    public DbSet<Product> Products => Set<Product>();
}

public class OrdersDbContext(DbContextOptions<OrdersDbContext> options) : DbContext(options)
{
    public DbSet<Order> Orders => Set<Order>();
}
```

```csharp
// .NET 10, EF Core 10.0.14
// Program.cs
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Shop.Data;

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddDbContext<CatalogDbContext>(o => o.UseSqlite("Data Source=shop.db"));
builder.Services.AddDbContext<OrdersDbContext>(o => o.UseSqlite("Data Source=shop.db"));
using var host = builder.Build();
```

Sem `--context`, a ferramenta se recusa a adivinhar:

```text
$ dotnet ef migrations add InitialCreate
More than one DbContext was found. Specify which one to use. Use the '-Context' parameter for PowerShell commands and the '--context' parameter for dotnet commands.
```

Adicione `--context` para cada um e deixe o EF Core escolher a pasta:

```bash
# dotnet-ef 10.0.14
dotnet ef migrations add InitialCreate --context CatalogDbContext
dotnet ef migrations add InitialCreate --context OrdersDbContext
```

O resultado é assimétrico:

```text
Migrations/
  20261026120305_InitialCreate.cs              namespace Shop.Migrations        (Catalog)
  20261026120305_InitialCreate.Designer.cs
  CatalogDbContextModelSnapshot.cs
  OrdersDb/
    20261026120307_InitialCreate.cs            namespace Shop.Migrations.OrdersDb
    20261026120307_InitialCreate.Designer.cs
    OrdersDbContextModelSnapshot.cs
```

O primeiro contexto a receber uma migração fica com `Migrations/`. O segundo ganha uma subpasta com o nome do contexto sem o sufixo `Context`, então `OrdersDbContext` vira `OrdersDb`. Isso não é um bug, é código deliberado em `MigrationsScaffolder`: quando você não passa um diretório de saída e o namespace padrão `Migrations` já contém migrações cujo atributo `[DbContext]` aponta para outro contexto, o EF Core muda para `<RootNamespace>.Migrations.<ContextNameWithoutSuffix>`. Um contexto cujo nome não termina em `Context` recebe `<Name>Migrations`. Essa lógica existe desde o EF Core 3.1 e continua na versão 11.

Funciona, mas depende da ordem. Clone o repositório do zero, apague as migrações e rode os comandos na ordem inversa, e as pastas trocam de lugar. Além disso, a assimetria (um contexto na raiz, outro aninhado dentro dela) faz `Migrations/` parecer pertencer a ambos. Ser explícito custa uma flag, uma única vez.

## O layout explícito com --output-dir

Comece do zero e dê a cada contexto sua própria pasta na primeira migração:

```bash
# dotnet-ef 10.0.14
dotnet ef migrations add InitialCreate --context CatalogDbContext --output-dir Data/Migrations/Catalog
dotnet ef migrations add InitialCreate --context OrdersDbContext --output-dir Data/Migrations/Orders
```

```text
Data/
  Contexts.cs
  Migrations/
    Catalog/
      20261026120357_InitialCreate.cs           namespace Shop.Data.Migrations.Catalog
      20261026120357_InitialCreate.Designer.cs
      CatalogDbContextModelSnapshot.cs
    Orders/
      20261026120359_InitialCreate.cs           namespace Shop.Data.Migrations.Orders
      20261026120359_InitialCreate.Designer.cs
      OrdersDbContextModelSnapshot.cs
```

O valor de `--output-dir` é relativo ao diretório do projeto, e o EF Core transforma os segmentos do caminho no subnamespace, então `Data/Migrations/Catalog` vira `Shop.Data.Migrations.Catalog` (o namespace raiz vem do `RootNamespace` do projeto). Se você quer um namespace que não espelhe a pasta, adicione `--namespace`:

```bash
# dotnet-ef 10.0.14
dotnet ef migrations add InitialCreate --context CatalogDbContext \
  --output-dir Data/Migrations/Catalog \
  --namespace Shop.Catalog.Migrations
```

No Package Manager Console do Visual Studio, as mesmas opções são `-Context`, `-OutputDir` e `-Namespace`:

```powershell
# EF Core 10.0.14 PMC tools
Add-Migration InitialCreate -Context CatalogDbContext -OutputDir Data\Migrations\Catalog
Add-Migration InitialCreate -Context OrdersDbContext -OutputDir Data\Migrations\Orders
```

## Você só passa --output-dir uma vez

Esta é a parte que a maioria das respostas na internet omite, e é por isso que as pessoas acabam com scripts que repetem `--output-dir` para sempre. Depois da primeira migração, a pasta se mantém. Alterei a entidade `Product` e adicionei uma segunda migração sem nenhum diretório de saída:

```bash
# dotnet-ef 10.0.14
dotnet ef migrations add AddPrice --context CatalogDbContext
```

```text
Data/Migrations/Catalog/20261026120401_AddPrice.cs
Data/Migrations/Catalog/20261026120401_AddPrice.Designer.cs
```

Duas regras em `MigrationsScaffolder` fazem isso funcionar:

1. **Namespace**: quando nenhum diretório de saída é informado, a nova migração reutiliza o namespace do último tipo de migração do contexto, e o snapshot reutiliza o namespace da classe de snapshot existente.
2. **Diretório**: `Save` procura recursivamente no diretório do projeto o arquivo da migração anterior (`<PreviousMigrationId>.cs`) e grava os novos arquivos na mesma pasta. O snapshot é encontrado da mesma forma, pelo nome do arquivo `CatalogDbContextModelSnapshot.cs`.

Ou seja, a fonte da verdade é o lugar onde os arquivos estão no momento. Isso tem duas consequências práticas. Primeiro, não há necessidade de colocar um diretório de saída em um script nem no `.config/dotnet-ef.json` do EF Core 11 (que de qualquer forma não tem uma chave output-dir). Segundo, você pode mover as migrações depois e o EF Core acompanha, que é a próxima seção.

Se você passar `--output-dir` explicitamente em uma migração posterior, ele vale para os arquivos da migração, mas o snapshot continua sendo gravado onde o arquivo de snapshot existente está. Apontar uma migração posterior para outro lugar, portanto, divide um contexto em duas pastas. Evite isso.

## Não compartilhe uma pasta entre contextos

E se você passar o mesmo `--output-dir` para os dois contextos? O EF Core permite, com um aviso:

```bash
# dotnet-ef 10.0.14
dotnet ef migrations add InitialCreate --context CatalogDbContext --output-dir Migrations
dotnet ef migrations add InitialCreate --context OrdersDbContext --output-dir Migrations
```

```text
The namespace 'Shop.Migrations' contains migrations for a different DbContext. This can result in conflicting migration names. It's recommend to put migrations for different DbContext classes into different namespaces.
Done. To undo this action, use 'ef migrations remove'
```

O aviso subestima o problema. Os dois contextos agora têm uma `partial class InitialCreate` em `Shop.Migrations`. Os nomes dos arquivos diferem porque os timestamps diferem, mas o C# junta as declarações parciais em uma só classe, e a próxima compilação falha:

```text
error CS0111: Type 'InitialCreate' already defines a member called 'Up' with the same parameter types
error CS0111: Type 'InitialCreate' already defines a member called 'Down' with the same parameter types
error CS0111: Type 'InitialCreate' already defines a member called 'BuildTargetModel' with the same parameter types
error CS0579: Duplicate 'Migration' attribute
```

A verificação de nome duplicado do próprio EF Core (`The name 'InitialCreate' is used by an existing migration.`) só olha as migrações do mesmo contexto, então não consegue pegar isso. Você vai esbarrar nisso com qualquer nome que as duas equipes escolham por coincidência: `InitialCreate`, `AddIndexes`, `Cleanup`. Uma pasta e um namespace por contexto tornam a colisão impossível.

## Movendo as migrações que você já tem

Se o seu projeto já tem o layout padrão assimétrico, ou tudo em uma única pasta, você pode reorganizar sem tocar no banco de dados. O EF Core encontra as migrações por reflexão: qualquer tipo que derive de `Migration` com um atributo `[DbContext(typeof(X))]` e um atributo `[Migration("<id>")]` pertence ao contexto `X`. Pasta e namespace são irrelevantes em tempo de execução, e o ID da migração na tabela de histórico não muda.

Os passos para cada contexto:

1. Mova os arquivos de migração do contexto (`<id>_<Name>.cs` e `<id>_<Name>.Designer.cs`) e o seu `<Context>ModelSnapshot.cs` para a nova pasta. O arquivo `.cs` simples não tem o atributo `[DbContext]`, então faça a correspondência pelo ID da migração em vez de procurar o nome do contexto com grep, ou você deixará metade de cada migração para trás.
2. Altere a linha `namespace` em cada arquivo movido, incluindo o snapshot, para o novo namespace.
3. Compile e execute `dotnet ef migrations list --context <Context>` para confirmar que os mesmos IDs aparecem.
4. Adicione a próxima migração sem `--output-dir` e verifique se ela cai na nova pasta.

Fiz exatamente isso no projeto com pasta compartilhada quebrado acima: movi os três arquivos de `OrdersDbContext` para `Migrations/Orders`, troquei `namespace Shop.Migrations` por `namespace Shop.Migrations.Orders`, e a compilação voltou a passar. `migrations list --context OrdersDbContext` ainda listava `20261026120430_InitialCreate`, e uma nova migração `AddPlacedAt` foi parar em `Migrations/Orders` com o namespace `Shop.Migrations.Orders` sem nenhuma flag extra.

Faça a mudança em um único commit, sem outras alterações, para que o diff seja apenas renomeações mais edições de namespace de uma linha. A revisão de código fica trivial e `git log --follow` continua funcionando.

## A tabela compartilhada __EFMigrationsHistory

As pastas são uma preocupação de código-fonte. No banco de dados, os dois contextos gravam na mesma tabela de histórico por padrão, porque o nome da tabela não depende do contexto. Depois de aplicar ambos:

```bash
# dotnet-ef 10.0.14
dotnet ef database update --context CatalogDbContext
dotnet ef database update --context OrdersDbContext
```

```text
sqlite> select * from __EFMigrationsHistory;
20261026120357_InitialCreate|10.0.14
20261026120401_AddPrice|10.0.14
20261026120359_InitialCreate|10.0.14
```

Não existe uma coluna de contexto. Cada contexto lê todas as linhas e só se importa com os IDs que correspondem às suas próprias migrações, e é por isso que isso funciona bem na maioria das vezes. O formato do ID é `yyyyMMddHHmmss_Name`, com resolução de um segundo, então dois contextos só colidem se alguém gerar o scaffold do mesmo nome de migração para ambos no mesmo segundo, o que um script que percorre os contextos em loop pode fazer.

Se você quer o histórico separado, por exemplo porque os dois contextos mapeiam para esquemas diferentes ou pertencem a equipes diferentes, configure uma tabela por contexto:

```csharp
// .NET 10, EF Core 10.0.14
builder.Services.AddDbContext<CatalogDbContext>(o => o.UseSqlite("Data Source=shop.db",
    sql => sql.MigrationsHistoryTable("__CatalogMigrationsHistory")));
```

`MigrationsHistoryTable` também aceita um esquema em provedores que suportam esquemas, como o SQL Server: `sql.MigrationsHistoryTable("__EFMigrationsHistory", "catalog")`.

Aqui está a armadilha: fazer isso em um banco de dados que já tem migrações aplicadas. A nova tabela está vazia, então o EF Core acha que nada foi executado e reaplica `InitialCreate`:

```text
$ dotnet ef database update --context CatalogDbContext
SQLite Error 1: 'table "Products" already exists'.
```

Copie as linhas do contexto para a nova tabela antes de atualizar. No SQLite:

```sql
-- SQLite, run once per database before deploying the history table change
CREATE TABLE "__CatalogMigrationsHistory" (
    "MigrationId" TEXT NOT NULL CONSTRAINT "PK___CatalogMigrationsHistory" PRIMARY KEY,
    "ProductVersion" TEXT NOT NULL);

INSERT INTO "__CatalogMigrationsHistory"
SELECT "MigrationId", "ProductVersion" FROM "__EFMigrationsHistory"
WHERE "MigrationId" IN ('20261026120357_InitialCreate', '20261026120401_AddPrice');

DELETE FROM "__EFMigrationsHistory"
WHERE "MigrationId" IN ('20261026120357_InitialCreate', '20261026120401_AddPrice');
```

Depois disso, `database update --context CatalogDbContext` não faz nada e `migrations list` mostra as duas migrações como aplicadas. Em um banco de dados novo, nada de especial é necessário: o script gerado começa com `CREATE TABLE IF NOT EXISTS "__CatalogMigrationsHistory"`. Se você faz a implantação com um script idempotente ou um bundle de migrações, execute a cópia antes dele, em todos os ambientes.

## Quando os dois contextos mapeiam a mesma tabela

Pastas separadas não impedem que dois contextos gerem DDL para a mesma tabela. Suponha que `OrdersDbContext` precise de acesso de leitura aos produtos e você adicione `public DbSet<Product> Products => Set<Product>();` a ele. A próxima migração de `OrdersDbContext` contém um `CreateTable(name: "Products", ...)`, que falha na implantação porque `CatalogDbContext` já criou a tabela.

Escolha um dono e exclua a tabela das migrações do outro contexto:

```csharp
// .NET 10, EF Core 10.0.14
public class OrdersDbContext(DbContextOptions<OrdersDbContext> options) : DbContext(options)
{
    public DbSet<Order> Orders => Set<Order>();
    public DbSet<Product> Products => Set<Product>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
        => modelBuilder.Entity<Product>()
            .ToTable("Products", t => t.ExcludeFromMigrations());
}
```

Com isso, o mesmo `migrations add` produziu um método `Up` vazio. A entidade continua fazendo parte do modelo, então as consultas e o rastreamento de alterações funcionam; apenas as migrações ignoram a tabela. Lembre-se de que uma mudança de esquema em `Product` agora precisa ser migrada por meio de `CatalogDbContext`, e `OrdersDbContext` a incorpora pela classe de entidade compartilhada.

## Os outros comandos também precisam de --context

Todo comando de migrações opera sobre um único contexto, então, havendo dois, `--context` é obrigatório em todos eles, não só em `add`:

```bash
# dotnet-ef 10.0.14
dotnet ef migrations list   --context OrdersDbContext
dotnet ef migrations remove --context OrdersDbContext
dotnet ef migrations script --context OrdersDbContext --idempotent -o orders.sql
dotnet ef migrations bundle --context OrdersDbContext -o efbundle-orders
dotnet ef database update   --context OrdersDbContext
```

`migrations remove` apaga os arquivos da última migração onde quer que estejam (ele procura no projeto pelo nome do arquivo) e reescreve o snapshot na pasta em que ele já está, então também respeita o seu layout. Em tempo de execução, chame `Database.MigrateAsync()` uma vez por contexto, na ordem que o seu esquema exigir (o dono das tabelas compartilhadas primeiro).

Se digitar `--context` cansa, o EF Core 11 pode ler um `context` padrão de `.config/dotnet-ef.json`. As flags continuam tendo precedência, então você definiria o contexto que mais migra e passaria `--context` para o outro.

## Um projeto de migrações separado por contexto

Pastas dentro de um único projeto bastam para a maioria dos aplicativos. Quando os contextos são implantados separadamente, ou quando uma equipe não pode ter acesso às migrações da outra, mova as migrações de cada contexto para a sua própria biblioteca de classes e diga ao EF Core onde encontrá-las:

```csharp
// .NET 10, EF Core 10.0.14
builder.Services.AddDbContext<CatalogDbContext>(o => o.UseSqlServer(catalogConnection,
    sql => sql.MigrationsAssembly("Shop.Migrations.Catalog")));
```

Depois execute `dotnet ef migrations add` com `--project Shop.Migrations.Catalog --startup-project Shop --context CatalogDbContext`. A contrapartida é um projeto a mais por contexto e uma referência do projeto de inicialização a cada projeto de migrações, de modo que eles são carregados em tempo de execução. O [guia oficial de um projeto de migrações separado](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/projects) cobre a configuração.

## Relacionados

- [Fix: The model for context has pending changes in EF Core 11](/pt-br/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/), que também pega você quando adiciona uma migração para o contexto errado.
- [Stop retyping --project and --startup-project with .config/dotnet-ef.json](/pt-br/2026/06/efcore-11-dotnet-ef-json-config-file/) no EF Core 11.
- [How to apply EF Core 11 migrations in production with migration bundles](/pt-br/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/), um bundle por contexto.
- [Fix: There is already an object named 'X' in the database after resetting migrations](/pt-br/2026/10/fix-there-is-already-an-object-named-in-the-database-after-resetting-ef-core-migrations/), a mesma mecânica da tabela de histórico por outro ângulo.
- [Fix: dotnet ef migrations add "Unable to create an object of type DbContext"](/pt-br/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/) para quando as ferramentas de tempo de design não conseguem compilar nenhum dos contextos.

## Fontes

- [EF Core tools reference (.NET CLI)](https://learn.microsoft.com/en-us/ef/core/cli/dotnet), Microsoft Learn: `--context`, `--output-dir`, `--namespace`.
- [Using a Separate Migrations Project](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/projects), Microsoft Learn.
- [Custom Migrations History Table](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/history-table), Microsoft Learn.
- [Entity types: excluding from migrations](https://learn.microsoft.com/en-us/ef/core/modeling/entity-types#excluding-from-migrations), Microsoft Learn.
- [`MigrationsScaffolder.cs` on release/10.0](https://github.com/dotnet/efcore/blob/release/10.0/src/EFCore.Design/Migrations/Design/MigrationsScaffolder.cs), o padrão de namespace, a verificação de migrações de outros contextos e a reutilização de diretório descritos acima.
