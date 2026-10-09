---
title: "O que é uma shadow property no EF Core 11, e por que uma apareceu na minha migração?"
description: "Uma shadow property é uma coluna que o EF Core rastreia sem uma propriedade CLR correspondente. Veja por que o EF Core 11 as cria (propriedades de FK ausentes, FKs com nome errado, tipos incompatíveis, relacionamentos duplicados), como identificar o tipo BlogId1 em uma migração, como corrigir cada causa e como usar shadow properties de propósito."
pubDate: 2026-10-09
tags:
  - "ef-core"
  - "ef-core-11"
  - "dotnet-11"
  - "migrations"
  - "relationships"
lang: "pt-br"
translationOf: "2026/10/what-is-a-shadow-property-in-ef-core-11-and-why-did-one-show-up-in-my-migration"
translatedBy: "claude"
translationDate: 2026-10-09
---

Resposta curta: uma shadow property é uma propriedade que existe no modelo do EF Core, e normalmente como coluna no banco de dados, mas não tem uma propriedade correspondente na sua classe de entidade. O EF Core 11 cria uma para você sempre que um relacionamento precisa de uma chave estrangeira e ele não encontra uma propriedade CLR para usar. Quando isso acontece porque sua classe simplesmente não tem uma propriedade de FK, a coluna shadow é inofensiva. Quando acontece porque você *tem* uma propriedade de FK que o EF Core não conseguiu usar (nome errado, tipo errado, `[NotMapped]`, ou um relacionamento configurado duas vezes), você ganha uma coluna como `BlogId1` ou `OwnerId` ao lado da que você pretendia, e a correção é dizer ao EF Core qual propriedade é a chave estrangeira com `HasForeignKey`.

Tudo abaixo foi executado com `Microsoft.EntityFrameworkCore.Sqlite` 11.0.0-rc.1.26425.128 no SDK .NET 11 RC1 (11.0.100-rc.1.26425.128), C# 14. A saída do modelo e os avisos foram copiados de execuções reais, não parafraseados.

## O que o EF Core quer dizer com "shadow"

Toda propriedade em um modelo do EF Core tem metadados: um nome, um tipo CLR, anulabilidade, se é uma chave ou FK. Para a maioria das propriedades também existe um membro de apoio na classe, uma propriedade ou campo C#, que o EF Core lê e escreve ao materializar entidades ou salvar alterações. Uma shadow property tem os metadados, mas não tem o membro. Seu valor existe apenas no change tracker.

Essa é a definição completa, conforme a [documentação de shadow and indexer properties](https://learn.microsoft.com/en-us/ef/core/modeling/shadow-properties). O EF Core não se importa com a forma como a propriedade passou a existir. Você pode declarar uma deliberadamente, ou as convenções podem criar uma durante a construção do modelo. O segundo caso é o que surpreende as pessoas, porque o primeiro lugar em que ele fica visível é uma migração que adiciona uma coluna que você nunca escreveu.

Você pode ver quais propriedades são shadow properties despejando o modelo. `Model.ToDebugString()` as marca com `(no field, ...)` e `Shadow`:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
using Microsoft.EntityFrameworkCore.Infrastructure;

using var db = new AppDbContext();
Console.WriteLine(db.Model.ToDebugString(MetadataDebugStringOptions.ShortDefault));
```

Guarde essa linha. É a forma mais rápida de responder "de onde veio essa coluna?" sem ler o snapshot da migração.

## Caso 1: a navegação não tem propriedade de FK (esperado, inofensivo)

A shadow property mais comum é a que o EF Core cria quando você modela um relacionamento apenas com navegações:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
public class Blog
{
    public int Id { get; set; }
    public List<Post> Posts { get; set; } = [];
}

public class Post
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
}
```

Aqui há um relacionamento um-para-muitos, então a tabela `Post` precisa de uma coluna de chave estrangeira. `Post` não tem `BlogId`, então o EF Core inventa uma. A visão de depuração mostra:

```text
EntityType: Post
  Properties:
    Id (int) Required PK AfterSave:Throw ValueGenerated.OnAdd
    BlogId (no field, int?) Shadow FK Index
    Title (string) Required
  Foreign keys:
    Post {'BlogId'} -> Blog {'Id'} ClientSetNull ToDependent: Posts
```

E a tabela gerada:

```sql
CREATE TABLE "Post" (
    "Id" INTEGER NOT NULL CONSTRAINT "PK_Post" PRIMARY KEY AUTOINCREMENT,
    "Title" TEXT NOT NULL,
    "BlogId" INTEGER NULL,
    CONSTRAINT "FK_Post_Blogs_BlogId" FOREIGN KEY ("BlogId") REFERENCES "Blogs" ("Id")
);
```

O nome segue a convenção `<nome da navegação ou do tipo principal><nome da chave principal>`, aqui `Blog` + `Id`. Dois detalhes importam. Primeiro, a FK shadow é `int?`, então o relacionamento é opcional e o comportamento de exclusão é `ClientSetNull`, não `Cascade`. Se você esperava semântica obrigatória, adicione uma propriedade `int BlogId` de verdade ou chame `.IsRequired()` no relacionamento. Segundo, o EF Core registra isso apenas no nível Debug, como `CoreEventId.ShadowPropertyCreated` (evento 10600):

```text
The property 'Post.BlogId' was created in shadow state because there are no eligible CLR members with a matching name.
```

Você não verá isso em um log de console padrão. Isso é intencional: é uma escolha de modelagem legítima, e muitas bases de código mantêm os valores de FK fora de suas classes de domínio.

## Caso 2: a propriedade de FK tem um nome não convencional (silencioso, e errado)

Este é o que produz uma "coluna misteriosa" em uma migração, sem nenhum aviso:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
public class User
{
    public int Id { get; set; }
}

public class Post
{
    public int Id { get; set; }
    public int OwnerUserId { get; set; }
    public User Owner { get; set; } = null!;
}
```

Você queria que `OwnerUserId` fosse a chave estrangeira de `Owner`. A convenção de descoberta de FK do EF Core só reconhece nomes da forma `<nome da navegação><nome da chave principal>` (`OwnerId`), `<nome do tipo principal><nome da chave principal>` (`UserId`), ou `<nome do tipo de entidade principal>Id`. `OwnerUserId` não se encaixa em nenhuma delas, então o EF Core o trata como uma coluna `int` comum e cria uma FK shadow `OwnerId`:

```text
EntityType: Post
  Properties:
    Id (int) Required PK AfterSave:Throw ValueGenerated.OnAdd
    OwnerId (no field, int) Shadow Required FK Index
    OwnerUserId (int) Required
```

```sql
CREATE TABLE "Posts" (
    "Id" INTEGER NOT NULL CONSTRAINT "PK_Posts" PRIMARY KEY AUTOINCREMENT,
    "OwnerUserId" INTEGER NOT NULL,
    "OwnerId" INTEGER NOT NULL,
    CONSTRAINT "FK_Posts_User_OwnerId" FOREIGN KEY ("OwnerId") REFERENCES "User" ("Id") ON DELETE CASCADE
);
```

Seu código define `post.OwnerUserId = 42`, salva, e nada se conecta. O relacionamento vive em `OwnerId`, que seu código nunca toca. Mais uma vez, o EF Core registra apenas o evento `ShadowPropertyCreated` no nível Debug, então o primeiro sintoma costuma ser um join que não retorna nada ou um diff de migração que alguém por acaso leu com atenção.

A correção é nomear a FK explicitamente:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Post>()
        .HasOne(p => p.Owner)
        .WithMany()
        .HasForeignKey(p => p.OwnerUserId);
}
```

ou com a data annotation na navegação: `[ForeignKey(nameof(OwnerUserId))] public User Owner { get; set; }`. Depois disso, o modelo tem uma única FK, `OwnerUserId`, e a coluna shadow desaparece. Se uma migração com `OwnerId` já foi publicada, a próxima migração removerá `OwnerId` e adicionará a constraint de FK em `OwnerUserId`. Verifique se alguma linha foi gravada pela coluna antiga antes de deixá-la ser removida.

## Caso 3: a propriedade de FK tem o tipo errado (BlogId1)

Agora o famoso sufixo `1`:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
public class Blog
{
    public int Id { get; set; }
    public List<Post> Posts { get; set; } = [];
}

public class Post
{
    public int Id { get; set; }
    public string BlogId { get; set; } = "";   // principal key is int
    public Blog Blog { get; set; } = null!;
}
```

`BlogId` tem o nome convencional, mas é uma `string` e `Blog.Id` é um `int`. O EF Core não pode usar uma propriedade incompatível como FK. Ele também não pode chamar a shadow property de `BlogId`, porque esse nome já está em uso, então a torna única como `BlogId1`. Desta vez o EF Core registra um Warning, `CoreEventId.ShadowForeignKeyPropertyCreated` (evento 10625):

```text
warn: CoreEventId.ShadowForeignKeyPropertyCreated[10625]
      The foreign key property 'Post.BlogId1' was created in shadow state because a conflicting property
      with the simple name 'BlogId' exists in the entity type, but is either not mapped, is already used
      for another relationship, or is incompatible with the associated primary key type.
```

A mensagem lista as três causas que levam a uma FK shadow numerada. Incompatibilidade de tipo é uma delas. As outras duas vêm a seguir.

## Caso 4: o relacionamento foi configurado duas vezes (BlogId e BlogId1)

Este vem de uma Fluent API que nomeia apenas um lado do relacionamento:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
public class Post
{
    public int Id { get; set; }
    public int BlogId { get; set; }
    public Blog Blog { get; set; } = null!;
}

protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Blog>()
        .HasMany(b => b.Posts)
        .WithOne()                       // no navigation passed
        .HasForeignKey(p => p.BlogId);
}
```

`WithOne()` sem argumento diz ao EF Core "este relacionamento não tem navegação no lado de `Post`". Mas `Post.Blog` existe, então as convenções constroem um *segundo* relacionamento a partir dela. `BlogId` já é usado pelo primeiro, então o segundo recebe `BlogId1`:

```text
Foreign keys:
  Post {'BlogId'} -> Blog {'Id'} Required Cascade ToDependent: Posts
  Post {'BlogId1'} -> Blog {'Id'} Required Cascade ToPrincipal: Blog
```

```sql
CREATE TABLE "Post" (
    "Id" INTEGER NOT NULL CONSTRAINT "PK_Post" PRIMARY KEY AUTOINCREMENT,
    "BlogId" INTEGER NOT NULL,
    "BlogId1" INTEGER NOT NULL,
    CONSTRAINT "FK_Post_Blogs_BlogId" FOREIGN KEY ("BlogId") REFERENCES "Blogs" ("Id") ON DELETE CASCADE,
    CONSTRAINT "FK_Post_Blogs_BlogId1" FOREIGN KEY ("BlogId1") REFERENCES "Blogs" ("Id") ON DELETE CASCADE
);
```

Duas FKs obrigatórias para a mesma tabela, e `blog.Posts` e `post.Blog` deixam de descrever o mesmo vínculo. A correção é passar a navegação para que as duas pontas pertençam a um único relacionamento: `.WithOne(p => p.Blog)`. Com essa mudança o modelo volta a ter uma única FK `BlogId` com `Inverse: Posts`.

Uma diferença útil: se você remover a chamada `HasForeignKey(p => p.BlogId)` dessa configuração quebrada, o EF Core 11 não cria `BlogId1` silenciosamente. Em vez disso, ele lança uma exceção durante a finalização do modelo:

```text
System.InvalidOperationException: Both relationships between 'Post' and 'Blog.Posts' and between 'Post.Blog'
and 'Blog' could use {'BlogId'} as the foreign key. To resolve this, configure the foreign key properties
explicitly in 'OnModelCreating' on at least one of the relationships.
```

Então, quando você encontrar essa exceção, a reação correta não é adicionar um `HasForeignKey` até ela sumir. Isso converte a exceção no esquema com `BlogId1` mostrado acima. Encontre o relacionamento que está sem a navegação e corrija esse.

## Caso 5: a propriedade de FK não está mapeada

A terceira causa no aviso é uma propriedade que o EF Core não tem permissão para usar:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
public class Post
{
    public int Id { get; set; }
    [NotMapped] public int BlogId { get; set; }
    public Blog Blog { get; set; } = null!;
}
```

O resultado é uma tabela com apenas uma coluna `BlogId1`, mais o mesmo aviso 10625. A mesma coisa acontece com `modelBuilder.Entity<Post>().Ignore(p => p.BlogId)`. Se você quer que a propriedade CLR seja a FK, remova o ignore. Se quer que ela seja um auxiliar não mapeado, renomeie-a para que não colida com o nome convencional da FK.

## Como pegar FKs shadow acidentais antes de publicar

Ler cada diff de migração funciona até deixar de funcionar. Duas proteções mais baratas:

Transforme o aviso em exceção. Os casos 3, 4 e 5 disparam `ShadowForeignKeyPropertyCreated`, e dá para mandar o EF Core lançar uma exceção nele:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
using Microsoft.EntityFrameworkCore.Diagnostics;

protected override void OnConfiguring(DbContextOptionsBuilder options) => options
    .UseSqlite("Data Source=app.db")
    .ConfigureWarnings(w => w.Throw(CoreEventId.ShadowForeignKeyPropertyCreated));
```

Acessar `db.Model` agora falha com `An error was generated for warning 'Microsoft.EntityFrameworkCore.Model.Validation.ShadowForeignKeyPropertyCreated'`, e como `dotnet ef migrations add` também constrói o modelo, a migração ruim nunca é criada. Não faça o mesmo para `ShadowPropertyCreated` a menos que você não tenha nenhuma shadow property intencional, porque ele também dispara no caso 1, que é inofensivo.

Faça uma asserção sobre o modelo em um teste. O caso 2 nunca gera um aviso, então um teste de unidade que percorre o modelo é a única rede de segurança automática:

```csharp
// .NET 11, EF Core 11.0.0-rc.1, xUnit
[Fact]
public void No_unexpected_shadow_foreign_keys()
{
    using var db = new AppDbContext();
    var allowed = new HashSet<string> { "Post.BlogId" };   // the ones you chose on purpose

    var shadowFks = db.Model.GetEntityTypes()
        .SelectMany(e => e.GetProperties())
        .Where(p => p.IsShadowProperty() && p.IsForeignKey())
        .Select(p => $"{p.DeclaringType.ClrType.Name}.{p.Name}")
        .Where(name => !allowed.Contains(name))
        .ToList();

    Assert.Empty(shadowFks);
}
```

`IsShadowProperty()` e `IsForeignKey()` fazem parte da API pública de metadados em `IReadOnlyProperty`, então isso não precisa de acesso interno nem de banco de dados.

## Usando shadow properties de propósito

Depois que você sabe o que são, as shadow properties são uma ferramenta limpa para dados que pertencem à tabela, mas não ao objeto de domínio. Timestamps de auditoria são o caso clássico:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Post>().Property<DateTime>("LastUpdated");
}

public override int SaveChanges()
{
    foreach (var entry in ChangeTracker.Entries<Post>()
                 .Where(e => e.State is EntityState.Added or EntityState.Modified))
    {
        entry.Property("LastUpdated").CurrentValue = DateTime.UtcNow;
    }
    return base.SaveChanges();
}
```

A classe `Post` fica livre de preocupações de persistência, e a tabela ganha uma coluna `"LastUpdated" TEXT NOT NULL` (no SQLite). A leitura e a escrita passam pelo change tracker, `db.Entry(post).Property<DateTime>("LastUpdated").CurrentValue`, e a consulta passa por `EF.Property`:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
var recent = await db.Posts
    .Where(p => EF.Property<DateTime>(p, "LastUpdated") > DateTime.UtcNow.AddDays(-1))
    .OrderBy(p => EF.Property<DateTime>(p, "LastUpdated"))
    .ToListAsync();
```

que é traduzida para uma referência de coluna simples:

```sql
SELECT "p"."Id", "p"."LastUpdated", "p"."Title"
FROM "Posts" AS "p"
WHERE "p"."LastUpdated" > rtrim(rtrim(strftime('%Y-%m-%d %H:%M:%f', 'now', CAST(-1.0 AS TEXT) || ' days'), '0'), '.')
```

Para qualquer coisa além de uma única entidade, coloque a lógica de carimbo em um `SaveChangesInterceptor` em vez de sobrescrever `SaveChanges` em cada contexto.

## Pegadinhas que vale conhecer

- **Valores shadow são perdidos ao desanexar.** O valor existe apenas no change tracker. Consultas com `AsNoTracking()` ainda retornam colunas shadow no SQL, mas você não tem como lê-las a partir do objeto materializado. Projete-as explicitamente com `EF.Property` em um `Select` se precisar delas.
- **FKs shadow e grafos desconectados.** Se você anexa um `Post` apenas com uma navegação definida, o EF Core preenche a FK shadow a partir da navegação no `SaveChanges`. Se anexa um `Post` sem navegação e sem propriedade de FK, não há nada para preenchê-la, e você deve defini-la com `Entry(...).Property("BlogId").CurrentValue`.
- **Correções de renomeação são migrações, não apenas código.** Corrigir os casos 2, 3 ou 4 altera o esquema. O EF Core vai gerar um drop da coluna shadow. Se dados de produção foram gravados por ela, copie-os para a coluna de FK real dentro da migração antes do drop.
- **Indexer properties são parentes, não a mesma coisa.** Property bags (tipos de entidade `Dictionary<string, object>`) usam indexer properties, que têm um acessador CLR, o indexador. Elas não são shadow properties, mesmo que também não tenham uma propriedade C# nomeada.

## Veja também

- Se a coluna shadow apareceu primeiro como uma migração inexplicável, [corrigir "the model for context has pending changes" no EF Core 11](/pt-br/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/) explica como funciona o diff do snapshot.
- Para o padrão de auditoria feito direito, veja [usando interceptors do EF Core 11 para auditoria](/pt-br/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/).
- Para ver a coluna `BlogId1` no SQL que o EF Core realmente emite, [registrar em log o SQL que o EF Core 11 gera](/pt-br/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) mostra todas as opções.
- Uma FK shadow obrigatória com `Cascade` muda o comportamento de exclusão; [corrigir FOREIGN KEY constraint failed na exclusão](/pt-br/2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11/) explica como o EF Core o escolhe.
- Se você vai renomear FKs de qualquer forma, [convenções de nomenclatura personalizadas para chaves, chaves estrangeiras e índices no EF Core 11](/pt-br/2026/09/how-to-apply-custom-naming-conventions-for-keys-foreign-keys-and-indexes-in-ef-core-11/) mostra como fazer isso em todo o modelo.

## Fontes

- [Shadow and Indexer Properties](https://learn.microsoft.com/en-us/ef/core/modeling/shadow-properties), documentação do EF Core.
- [Foreign and principal keys in relationships](https://learn.microsoft.com/en-us/ef/core/modeling/relationships/foreign-and-principal-keys), documentação do EF Core, para as regras de nomenclatura da descoberta de FK.
- [CoreEventId.ShadowForeignKeyPropertyCreated](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.diagnostics.coreeventid.shadowforeignkeypropertycreated), referência da API.
- [Microsoft.EntityFrameworkCore 11.0.0-rc.1.26425.128](https://www.nuget.org/packages/Microsoft.EntityFrameworkCore/11.0.0-rc.1.26425.128) no NuGet, a versão usada em todas as execuções deste post.
