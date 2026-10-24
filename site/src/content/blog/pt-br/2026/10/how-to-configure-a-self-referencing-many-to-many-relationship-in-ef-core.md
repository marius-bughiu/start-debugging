---
title: "Como configurar um relacionamento muitos-para-muitos autorreferenciado (seguidores/seguindo) no EF Core"
description: "Modele seguidores e seguindo em uma única entidade User no EF Core 11: o que a convenção constrói, por que o SQL Server transforma silenciosamente uma chave estrangeira da tabela de junção em ClientCascade, como mapear uma entidade de junção Follow explícita com timestamp e como excluir um usuário sem os erros 547 ou 1785."
pubDate: 2026-10-24
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "dotnet-11"
  - "sql-server"
  - "relationships"
  - "how-to"
lang: "pt-br"
translationOf: "2026/10/how-to-configure-a-self-referencing-many-to-many-relationship-in-ef-core"
translatedBy: "claude"
translationDate: 2026-10-24
---

**Resposta curta:** coloque duas navegações de coleção do mesmo tipo na entidade, `List<User> Followers` e `List<User> Following`, e faça o par com `HasMany(u => u.Following).WithMany(u => u.Followers)`. O EF Core mapeia isso para uma tabela de junção com duas chaves estrangeiras de volta para `Users`. Para qualquer cenário real, dê à tabela de junção a sua própria classe (`Follow` com `FollowerId`, `FolloweeId`, `CreatedAt`) por meio de `UsingEntity<Follow>` e decida você mesmo o comportamento de exclusão: o SQL Server recusa duas chaves estrangeiras em cascata de uma mesma tabela para o mesmo pai (erro 1785), então deixe `Cascade` em um lado e defina o outro como `ClientCascade`, depois exclua os usuários usando `ExecuteDeleteAsync` nas linhas de junção primeiro. Tudo abaixo foi medido com o .NET 11 SDK 11.0.100-rc.2, EF Core 11 (`Microsoft.EntityFrameworkCore.SqlServer` e `.Sqlite` 11.0.0-rc.2.26504.105) e C# 14.

O grafo de seguidores é o exemplo clássico de muitos-para-muitos autorreferenciado: qualquer usuário pode seguir qualquer quantidade de usuários, e qualquer usuário pode ser seguido por qualquer quantidade de usuários. Parece um mapeamento de duas linhas e, com as convenções do EF Core, quase é. O problema começa quando você adiciona uma migração para SQL Server, tenta excluir um usuário ou quer saber *quando* alguém seguiu alguém.

## O que a convenção constrói para Followers e Following

Comece com o menor modelo possível:

```csharp
// .NET 11, EF Core 11.0.0-rc.2, C# 14
public class User
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public List<User> Followers { get; } = [];
    public List<User> Following { get; } = [];
}

public class AppDb : DbContext
{
    public DbSet<User> Users => Set<User>();
}
```

Não há `OnModelCreating` aqui, e mesmo assim o EF Core entende que `Followers` e `Following` são as duas pontas de um único relacionamento muitos-para-muitos, porque são as duas únicas navegações de coleção em `User` que apontam para `User`. É o mesmo mecanismo que a documentação oficial mostra com `Person.Parents` e `Person.Children`. Chamar `Database.GenerateCreateScript()` com o provedor do SQL Server imprime esta tabela de junção:

```sql
-- EF Core 11.0.0-rc.2, SQL Server provider, convention-only model
CREATE TABLE [UserUser] (
    [FollowersId] int NOT NULL,
    [FollowingId] int NOT NULL,
    CONSTRAINT [PK_UserUser] PRIMARY KEY ([FollowersId], [FollowingId]),
    CONSTRAINT [FK_UserUser_Users_FollowersId] FOREIGN KEY ([FollowersId]) REFERENCES [Users] ([Id]) ON DELETE CASCADE,
    CONSTRAINT [FK_UserUser_Users_FollowingId] FOREIGN KEY ([FollowingId]) REFERENCES [Users] ([Id])
);

CREATE INDEX [IX_UserUser_FollowingId] ON [UserUser] ([FollowingId]);
```

Três coisas nessa saída merecem atenção.

Primeiro, os nomes. A tabela se chama `UserUser` e as colunas recebem o nome das navegações, o que parece invertido. Quando Alice (Id 1) adiciona Bob (Id 2) a `alice.Following`, a linha que chega à tabela é `FollowersId = 1, FollowingId = 2`. Ou seja, `FollowersId` guarda o seguidor e `FollowingId` guarda a pessoa que está sendo seguida. Está correto, mas ninguém que abrir a tabela no SSMS daqui a seis meses vai adivinhar isso.

Segundo, apenas uma chave estrangeira tem `ON DELETE CASCADE`. No SQLite, o mesmo modelo produz cascade nas duas. A diferença vem de `SqlServerOnDeleteConvention`, que o provedor do SQL Server carrega desde o EF Core 5 ([dotnet/efcore#21959](https://github.com/dotnet/efcore/pull/21959)). Quando as duas chaves estrangeiras de uma tabela de junção apontam para a mesma tabela, ela mantém `Cascade` em uma e rebaixa a outra para `DeleteBehavior.ClientCascade`. Qual delas vence é decidido por uma comparação ordinal de strings entre os nomes das duas navegações, e não por algo que você escolheria de propósito. Dá para ver isso no modelo:

```csharp
// .NET 11, EF Core 11.0.0-rc.2
foreach (var fk in db.Model.FindEntityType("UserUser")!.GetForeignKeys())
    Console.WriteLine($"{fk.Properties[0].Name}: {fk.DeleteBehavior}");

// SQL Server provider:  FollowersId: Cascade, FollowingId: ClientCascade
// SQLite provider:      FollowersId: Cascade, FollowingId: Cascade
```

Terceiro, a entidade de junção é uma entidade de tipo compartilhado apoiada por `Dictionary<string, object>`. Não há onde colocar uma coluna `CreatedAt`, e a documentação avisa explicitamente para não depender desse tipo de dicionário. Se a nomeação de colunas é a mesma armadilha que você já encontrou com outras convenções, o post sobre [por que uma shadow property apareceu na minha migração](/pt-br/2026/10/what-is-a-shadow-property-in-ef-core-11-and-why-did-one-show-up-in-my-migration/) explica como o EF inventa essas propriedades.

## Por que o SQL Server precisa que um lado pare de propagar em cascata

Se as duas chaves estrangeiras propagassem em cascata, excluir uma linha em `Users` poderia chegar à mesma linha de `UserUser` por dois caminhos (uma vez como seguidor, outra como seguido). O SQL Server não permite isso e rejeita o `CREATE TABLE` com o erro 1785: *Introducing FOREIGN KEY constraint ... may cause cycles or multiple cascade paths. Specify ON DELETE NO ACTION or ON UPDATE NO ACTION, or modify other FOREIGN KEY constraints.*

Com o modelo apenas por convenção você nunca vê esse erro, porque o provedor já o evitou. Você o vê assim que assume o controle da entidade de junção e escreve a configuração "óbvia":

```csharp
// .NET 11, EF Core 11.0.0-rc.2 -- DON'T: explicit Cascade beats the convention
.UsingEntity<Follow>(
    r => r.HasOne<User>().WithMany().HasForeignKey(f => f.FolloweeId).OnDelete(DeleteBehavior.Cascade),
    l => l.HasOne<User>().WithMany().HasForeignKey(f => f.FollowerId).OnDelete(DeleteBehavior.Cascade));
```

A configuração explícita sempre tem precedência sobre uma convenção, então `SqlServerOnDeleteConvention` recua e o DDL gerado passa a ter `ON DELETE CASCADE` nas duas constraints. O `dotnet ef database update` falha no SQL Server com o erro 1785, enquanto a mesma migração roda bem no SQLite e no PostgreSQL. Essa diferença entre provedores é o motivo pelo qual o bug costuma aparecer só no CI ou no ambiente de staging.

A outra metade do trade-off é o que `ClientCascade` significa em tempo de execução. A constraint no banco de dados vira `NO ACTION`, e o EF Core promete excluir as linhas dependentes *somente se elas estiverem rastreadas*. Exclua um usuário cujas linhas de junção do lado `ClientCascade` não estão carregadas e o SQL Server responde com o erro 547 (*The DELETE statement conflicted with the REFERENCE constraint*). No SQLite, a mesma situação aparece como `SQLite Error 19: 'FOREIGN KEY constraint failed'`. Mais sobre isso na seção de exclusão abaixo, e a versão geral do problema está em [corrigir FOREIGN KEY constraint failed ao excluir uma entidade](/pt-br/2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11/).

## Mapeie uma entidade de junção Follow explícita

Para um grafo de seguidores, quase sempre você quer uma classe de junção explícita: ela dá nomes de colunas legíveis, um lugar para `CreatedAt` (ou `Muted`, `NotificationsEnabled` e assim por diante) e um `DbSet` que você pode consultar e excluir em lote sem carregar usuários. Aqui está o mapeamento completo, passo a passo:

1. Adicione uma classe `Follow` com `FollowerId`, `FolloweeId`, as colunas de dados e navegações de referência para os dois usuários.
2. Mantenha as skip navigations (`Followers`, `Following`) em `User` para que o código do dia a dia continue natural, e adicione as navegações de junção (`FollowerLinks`, `FollowingLinks`) para quando você precisar dos dados da junção.
3. Faça o par das skip navigations com `HasMany(...).WithMany(...)` e passe `Follow` para `UsingEntity<Follow>`, configurando explicitamente a chave estrangeira de cada lado para que nem o nome nem a direção fiquem a cargo da convenção.
4. Defina `Cascade` em uma chave estrangeira e `ClientCascade` na outra, de propósito.
5. Adicione a chave composta, um índice na segunda coluna de chave, um valor padrão para `CreatedAt` e uma check constraint que proíba seguir a si mesmo.

```csharp
// .NET 11, EF Core 11.0.0-rc.2, C# 14
public class User
{
    public int Id { get; set; }
    public string Name { get; set; } = "";

    // skip navigations
    public List<User> Followers { get; } = [];
    public List<User> Following { get; } = [];

    // navigations to the join entity
    public List<Follow> FollowerLinks { get; } = [];   // rows where I am the followee
    public List<Follow> FollowingLinks { get; } = [];  // rows where I am the follower
}

public class Follow
{
    public int FollowerId { get; set; }
    public int FolloweeId { get; set; }
    public DateTime CreatedAt { get; set; }
    public User Follower { get; set; } = null!;
    public User Followee { get; set; } = null!;
}

public class AppDb(DbContextOptions<AppDb> options) : DbContext(options)
{
    public DbSet<User> Users => Set<User>();
    public DbSet<Follow> Follows => Set<Follow>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<User>()
            .HasMany(u => u.Following)
            .WithMany(u => u.Followers)
            .UsingEntity<Follow>(
                r => r.HasOne(f => f.Followee).WithMany(u => u.FollowerLinks)
                      .HasForeignKey(f => f.FolloweeId)
                      .OnDelete(DeleteBehavior.Cascade),
                l => l.HasOne(f => f.Follower).WithMany(u => u.FollowingLinks)
                      .HasForeignKey(f => f.FollowerId)
                      .OnDelete(DeleteBehavior.ClientCascade),
                j =>
                {
                    j.ToTable("Follows", t => t.HasCheckConstraint(
                        "CK_Follows_NoSelfFollow", "FollowerId <> FolloweeId"));
                    j.HasKey(f => new { f.FollowerId, f.FolloweeId });
                    j.HasIndex(f => f.FolloweeId);
                    j.Property(f => f.CreatedAt).HasDefaultValueSql("SYSUTCDATETIME()");
                });
    }
}
```

A lambda `r` configura o relacionamento com o lado *direito* de `HasMany(...).WithMany(...)`, que é a entidade alcançada por `Following`, ou seja, o seguido. A lambda `l` é o lado *esquerdo*, o usuário dono de `Following`, ou seja, o seguidor. Trocar as duas compila normalmente e inverte silenciosamente o seu grafo inteiro, por isso eu sempre verifico a direção uma vez em um teste (mostrado abaixo).

O DDL do SQL Server que isso produz:

```sql
-- EF Core 11.0.0-rc.2, SQL Server provider, explicit Follow join entity
CREATE TABLE [Follows] (
    [FollowerId] int NOT NULL,
    [FolloweeId] int NOT NULL,
    [CreatedAt] datetime2 NOT NULL DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT [PK_Follows] PRIMARY KEY ([FollowerId], [FolloweeId]),
    CONSTRAINT [CK_Follows_NoSelfFollow] CHECK (FollowerId <> FolloweeId),
    CONSTRAINT [FK_Follows_Users_FolloweeId] FOREIGN KEY ([FolloweeId]) REFERENCES [Users] ([Id]) ON DELETE CASCADE,
    CONSTRAINT [FK_Follows_Users_FollowerId] FOREIGN KEY ([FollowerId]) REFERENCES [Users] ([Id])
);

CREATE INDEX [IX_Follows_FolloweeId] ON [Follows] ([FolloweeId]);
```

A chave primária composta `(FollowerId, FolloweeId)` já atende consultas do tipo "quem X segue?". O índice extra em `FolloweeId` atende "quem segue X?", que é a consulta por trás de toda contagem de seguidores, então não o remova. No SQLite, troque `SYSUTCDATETIME()` por `CURRENT_TIMESTAMP`.

## Seguir, deixar de seguir e verificar a direção

Você pode gravar tanto pela skip navigation quanto pela entidade de junção. Pela skip navigation, o EF cria a linha `Follow` para você e o banco preenche `CreatedAt`:

```csharp
// .NET 11, EF Core 11.0.0-rc.2
var dave = await db.Users.Include(u => u.Followers).SingleAsync(u => u.Name == "dave");
var alice = await db.Users.SingleAsync(u => u.Name == "alice");

dave.Followers.Add(alice);   // alice follows dave
await db.SaveChangesAsync();

var row = await db.Follows.SingleAsync(f => f.FollowerId == alice.Id && f.FolloweeId == dave.Id);
// row.FollowerId == alice.Id, row.FolloweeId == dave.Id, row.CreatedAt populated
```

Essa ida e volta é o meu teste de direção: se `FollowerId` voltar com o id de Dave, as lambdas `r` e `l` estão trocadas.

Em handlers de requisição, porém, carregar um usuário mais uma coleção inteira de seguidores só para inserir uma linha é um desperdício. Passe pela entidade de junção, que não precisa carregar nada:

```csharp
// .NET 11, EF Core 11.0.0-rc.2
db.Follows.Add(new Follow { FollowerId = currentUserId, FolloweeId = targetId });
await db.SaveChangesAsync();

// unfollow, one DELETE statement, no tracking
await db.Follows
    .Where(f => f.FollowerId == currentUserId && f.FolloweeId == targetId)
    .ExecuteDeleteAsync();
```

As duas proteções do mapeamento disparam como erros reais do banco de dados. No SQLite, seguir a si mesmo falha com `CHECK constraint failed: CK_Follows_NoSelfFollow`, e seguir alguém duas vezes falha com `UNIQUE constraint failed: Follows.FollowerId, Follows.FolloweeId`. No SQL Server, o segundo caso é uma violação de chave primária (erro 2627). Com cliques duplos concorrentes você vai cair nele, então trate-o como "já está seguindo" em vez de um 500; o mesmo padrão é descrito para o PostgreSQL em [tratar uma chave duplicada em uma inserção concorrente do EF Core](/pt-br/2026/08/fix-23505-duplicate-key-value-violates-unique-constraint-on-a-concurrent-ef-core-insert/).

## Consultando contagens, seguidores mútuos e sugestões

As skip navigations são traduzidas em joins através de `Follows`, então as contagens nunca carregam as coleções:

```csharp
// .NET 11, EF Core 11.0.0-rc.2
var profile = await db.Users
    .Where(u => u.Id == userId)
    .Select(u => new { u.Name, Followers = u.Followers.Count, Following = u.Following.Count })
    .SingleAsync();
```

```sql
-- SQL Server, from ToQueryString()
SELECT [u].[Name], (
    SELECT COUNT(*)
    FROM [Follows] AS [f]
    WHERE [u].[Id] = [f].[FolloweeId]) AS [Followers], (
    SELECT COUNT(*)
    FROM [Follows] AS [f0]
    WHERE [u].[Id] = [f0].[FollowerId]) AS [Following]
FROM [Users] AS [u]
WHERE [u].[Id] = @userId
```

"Seguidores mútuos" (pessoas que eu sigo e que me seguem de volta) se lê naturalmente com skip navigations:

```csharp
// .NET 11, EF Core 11.0.0-rc.2
var mutual = await db.Users
    .Where(u => u.Id == userId)
    .SelectMany(u => u.Following.Where(f => f.Following.Any(x => x.Id == userId)))
    .Select(f => f.Name)
    .ToListAsync();
```

Isso funciona, mas o SQL emitido faz join com `Users` três vezes, porque cada salto de skip navigation passa pela tabela de usuários. Para consultas de grafo mais pesadas, escreva diretamente contra `Follows`. Aqui está "pessoas seguidas por quem eu sigo, que eu ainda não sigo", ordenadas por quantos dos meus seguidos levam até elas:

```csharp
// .NET 11, EF Core 11.0.0-rc.2
var suggestions = await db.Follows
    .Where(f => db.Follows.Any(a => a.FollowerId == userId && a.FolloweeId == f.FollowerId)
             && f.FolloweeId != userId
             && !db.Follows.Any(a => a.FollowerId == userId && a.FolloweeId == f.FolloweeId))
    .GroupBy(f => f.Followee.Name)
    .Select(g => new { Name = g.Key, Via = g.Count() })
    .OrderByDescending(x => x.Via)
    .ToListAsync();
```

Com o grafo de exemplo alice -> bob, alice -> carol, bob -> alice, carol -> dave, bob -> dave, a consulta de contagens retorna `{ Name = alice, Followers = 1, Following = 2 }`, os seguidores mútuos de Alice retornam `bob` e as sugestões retornam `dave via 2`. Essa consulta é compilada em um único `SELECT ... GROUP BY` com duas subconsultas `EXISTS` e sem joins extras de usuários. Para listas de seguidores que precisam de paginação, use o par `(FolloweeId, CreatedAt)` com [paginação por keyset](/pt-br/2026/06/how-to-do-keyset-cursor-pagination-in-ef-core-11/) em vez de `Skip`.

## Excluindo um usuário sem o erro 547

É aqui que o lado `ClientCascade` morde. No mapeamento acima, as linhas em que o usuário excluído é o *seguido* somem por meio do cascade do banco de dados. As linhas em que o usuário excluído é o *seguidor* dependem do EF Core, e o EF só exclui o que rastreia. Medi três variações no SQLite com as mesmas constraints:

```csharp
// .NET 11, EF Core 11.0.0-rc.2

// 1. Join rows on the ClientCascade side NOT loaded -> fails
var bob = await db.Users.SingleAsync(u => u.Name == "bob");
db.Remove(bob);
await db.SaveChangesAsync();
// SQLite: SQLite Error 19: 'FOREIGN KEY constraint failed'
// SQL Server: error 547, DELETE conflicted with the REFERENCE constraint

// 2. Load the ClientCascade side first -> works
var carol = await db.Users.Include(u => u.FollowingLinks).SingleAsync(u => u.Name == "carol");
db.Remove(carol);
await db.SaveChangesAsync();
// EF deletes carol -> dave itself, the database cascade deletes alice -> carol
```

A opção 2 serve para uma tela de administração, mas carregar todas as linhas de follow de um usuário com 200.000 seguidos no change tracker só para excluí-las não serve. A abordagem que uso em produção ignora o rastreamento por completo e roda em uma única transação:

```csharp
// .NET 11, EF Core 11.0.0-rc.2
// 3. Bulk-delete the join rows, then the user
await using var tx = await db.Database.BeginTransactionAsync();

await db.Follows
    .Where(f => f.FollowerId == userId || f.FolloweeId == userId)
    .ExecuteDeleteAsync();

await db.Users
    .Where(u => u.Id == userId)
    .ExecuteDeleteAsync();

await tx.CommitAsync();
```

Para Bob no grafo de exemplo, isso excluiu três linhas de follow e um usuário, deixando apenas os follows que nunca o envolveram. Lembre-se de que `ExecuteDeleteAsync` ignora o change tracker, então qualquer instância de `Follow` ou `User` já rastreada por este contexto fica desatualizada depois. Os trade-offs são tratados com mais profundidade em [ExecuteUpdate e ExecuteDelete para gravações em lote](/pt-br/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/).

Se o seu app faz soft delete de usuários, nada disso se aplica à exclusão em si: a linha do usuário permanece, assim como as linhas de junção, e você decide nas suas consultas se uma conta desativada ainda conta como seguidor.

## Armadilhas que vale conhecer antes da primeira migração

- **Mudar da convenção para uma entidade de junção explícita renomeia a tabela.** `UserUser` com `FollowersId`/`FollowingId` vira `Follows` com `FollowerId`/`FolloweeId`. A migração gerada remove e recria a tabela, o que perde todos os follows. Edite a migração para usar `RenameTable` e `RenameColumn`, da mesma forma que você faria ao [renomear uma tabela sem perder dados](/pt-br/2026/08/how-to-rename-a-table-in-an-ef-core-11-migration-without-losing-data/).
- **Um relacionamento simétrico de "amigos" tem outro formato.** Com uma única navegação `List<User> Friends` não há inverso para formar o par. A documentação recomenda mapeá-la como unidirecional (`HasMany(u => u.Friends).WithMany()`) e adicionar você mesmo cada pessoa à coleção da outra, ou armazenar as duas direções como duas linhas.
- **Uma terceira navegação `List<User>` remove silenciosamente todas elas.** Adicione `Blocked` ao lado de `Followers` e `Following` e o EF não consegue mais saber quais duas formam um par. No EF Core 11 RC 2 ele não lança exceção: `Model.ToDebugString()` mostra `User` apenas com seu `Id` e nenhum relacionamento, e as coleções simplesmente nunca são carregadas. Configure cada par explicitamente com `HasMany(...).WithMany(...)` no momento em que uma terceira coleção do mesmo tipo aparecer.
- **Semear follows exige a entidade de junção.** `HasData` não consegue preencher skip navigations; semeie linhas `Follow` com chaves fixas, como explicado em [semear um relacionamento muitos-para-muitos no EF Core 11](/pt-br/2026/06/how-to-seed-a-many-to-many-relationship-in-ef-core-11/).
- **`Include(u => u.Followers)` em uma conta popular é uma armadilha.** Ele materializa todos os seguidores. Projete contagens ou pagine por `Follows`.

## Leia a seguir

- [How to seed a many-to-many relationship in EF Core 11](/pt-br/2026/06/how-to-seed-a-many-to-many-relationship-in-ef-core-11/)
- [Fix FOREIGN KEY constraint failed when deleting an entity in EF Core 11](/pt-br/2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11/)
- [How to use ExecuteUpdate and ExecuteDelete for bulk writes in EF Core 11](/pt-br/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/)
- [What is a shadow property in EF Core 11, and why did one show up in my migration?](/pt-br/2026/10/what-is-a-shadow-property-in-ef-core-11-and-why-did-one-show-up-in-my-migration/)

Fontes: a [documentação de relacionamentos muitos-para-muitos](https://learn.microsoft.com/en-us/ef/core/modeling/relationships/many-to-many) do EF Core (seções de autorreferência e simétrico, overloads de `UsingEntity`), a [documentação de exclusão em cascata](https://learn.microsoft.com/en-us/ef/core/saving/cascade-delete) para a semântica de `ClientCascade`, o [código-fonte de `SqlServerOnDeleteConvention`](https://github.com/dotnet/efcore/blob/main/src/EFCore.SqlServer/Metadata/Conventions/SqlServerOnDeleteConvention.cs) e o PR que o introduziu, [dotnet/efcore#21959](https://github.com/dotnet/efcore/pull/21959), e a documentação do SQL Server sobre [integridade referencial em cascata](https://learn.microsoft.com/en-us/sql/relational-databases/tables/primary-and-foreign-key-constraints).
