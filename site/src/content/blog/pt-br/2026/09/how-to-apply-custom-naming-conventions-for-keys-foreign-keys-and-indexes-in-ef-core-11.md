---
title: "Como aplicar convenções de nomenclatura personalizadas para chaves primárias, chaves estrangeiras e índices nas migrações do EF Core 11"
description: "Renomeie todos os PK_, FK_, AK_ e IX_ que o EF Core 11 gera com uma única IModelFinalizingConvention, mantenha a prioridade dos nomes explícitos, respeite o limite de tamanho de identificadores e evite a reconstrução do índice clusterizado que a próxima migração gera em um banco de dados existente."
pubDate: 2026-09-19
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "migrations"
  - "sql-server"
  - "dotnet-11"
  - "how-to"
lang: "pt-br"
translationOf: "2026/09/how-to-apply-custom-naming-conventions-for-keys-foreign-keys-and-indexes-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-09-19
---

Resposta curta: escreva uma classe que implemente `IModelFinalizingConvention`, percorra as chaves, chaves estrangeiras e índices declarados de cada tipo de entidade e defina os nomes pelos builders de convenção (`key.Builder.HasName(...)`, `fk.Builder.HasConstraintName(...)`, `index.Builder.HasDatabaseName(...)`). Registre-a em `ConfigureConventions` com `configurationBuilder.Conventions.Add(_ => new ConstraintNamingConvention())`. Como os builders registram o nome com origem `Convention`, qualquer nome que você defina explicitamente com a Fluent API ou com `[Index(Name = ...)]` continua prevalecendo. Em um banco de dados novo, isso é todo o trabalho. Em um existente, a próxima migração remove e recria cada chave primária e chave estrangeira só para renomeá-la, então edite essa migração à mão para transformá-la em renomeações.

Tudo neste post foi executado no SDK do .NET 11 RC 1 (`11.0.100-rc.1.26425.128`) com `Microsoft.EntityFrameworkCore.SqlServer` `11.0.0-rc.1.26425.128`. O DDL e o SQL de migração mostrados são a saída real de `Database.GenerateCreateScript()` e `IMigrationsSqlGenerator` sobre um modelo SQL Server. Nenhum servidor de banco de dados foi usado, então não há medições de tempo aqui, apenas o SQL que o EF Core enviaria.

## Os nomes que o EF Core 11 escolhe por padrão

Comece com um modelo pequeno: um `Blog` com uma chave alternativa única `Slug`, `Post` apontando para `Blog` e opcionalmente para `Author`, um índice único em `Author.Email`, um índice composto em `Post` e um relacionamento muitos-para-muitos com skip navigation entre `Post` e `Tag`.

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
public class Blog
{
    public int Id { get; set; }
    public string Slug { get; set; } = "";
    public List<Post> Posts { get; } = [];
}

public class Post
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public int BlogId { get; set; }
    public Blog Blog { get; set; } = null!;
    public int? AuthorId { get; set; }
    public Author? Author { get; set; }
    public List<Tag> Tags { get; } = [];
}

public class Author { public int Id { get; set; } public string Email { get; set; } = ""; }
public class Tag { public int Id { get; set; } public string Name { get; set; } = ""; public List<Post> Posts { get; } = []; }

public class AppDb : DbContext
{
    public DbSet<Blog> Blogs => Set<Blog>();
    public DbSet<Post> Posts => Set<Post>();
    public DbSet<Author> Authors => Set<Author>();
    public DbSet<Tag> Tags => Set<Tag>();

    protected override void OnModelCreating(ModelBuilder mb)
    {
        mb.Entity<Blog>().HasAlternateKey(b => b.Slug);
        mb.Entity<Author>().HasIndex(a => a.Email).IsUnique();
        mb.Entity<Post>().HasIndex(p => new { p.BlogId, p.Title });
    }
}
```

O DDL gerado para SQL Server usa quatro padrões:

```sql
-- EF Core 11.0.0-rc.1, SQL Server provider, default names
CONSTRAINT [PK_Blogs] PRIMARY KEY ([Id]),
CONSTRAINT [AK_Blogs_Slug] UNIQUE ([Slug])
CONSTRAINT [FK_Posts_Blogs_BlogId] FOREIGN KEY ([BlogId]) REFERENCES [Blogs] ([Id]) ON DELETE CASCADE
CONSTRAINT [FK_PostTag_Tags_TagsId] FOREIGN KEY ([TagsId]) REFERENCES [Tags] ([Id]) ON DELETE CASCADE
CREATE UNIQUE INDEX [IX_Authors_Email] ON [Authors] ([Email]);
CREATE INDEX [IX_Posts_BlogId_Title] ON [Posts] ([BlogId], [Title]);
```

Então os padrões são `PK_{table}`, `AK_{table}_{columns}`, `FK_{dependent table}_{principal table}_{columns}` e `IX_{table}_{columns}`, e um índice único recebe o mesmo prefixo `IX_` que um não único. Observe que o padrão usa o nome da *tabela* (`Blogs`, vindo do `DbSet`), não o nome do tipo CLR. Partes da documentação do Microsoft Learn descrevem o padrão da chave primária como `PK_<type name>`, o que só é verdade quando os dois coincidem.

As equipes normalmente querem mudar isso por um de três motivos: um padrão de DBA (`pk_`, `fk_`, `ux_` para índices únicos), um banco de dados PostgreSQL em que todo o resto está em minúsculas, ou um esquema existente criado por outra ferramenta cujos nomes o EF Core deveria adotar em vez de combater.

## Nomes pontuais: HasName, HasConstraintName, HasDatabaseName

Se apenas alguns objetos precisam de um nome específico, a Fluent API tem um método para cada tipo de objeto:

```csharp
// .NET 11, EF Core 11 - per-object names
mb.Entity<Blog>().HasKey(b => b.Id).HasName("pk_blog");
mb.Entity<Blog>().HasAlternateKey(b => b.Slug).HasName("ak_blog_slug");

mb.Entity<Post>()
    .HasOne(p => p.Blog).WithMany(b => b.Posts)
    .HasForeignKey(p => p.BlogId)
    .HasConstraintName("fk_post_blog");

mb.Entity<Author>().HasIndex(a => a.Email).IsUnique().HasDatabaseName("ux_author_email");
```

Para índices também existe a forma de atributo, `[Index(nameof(Email), IsUnique = true, Name = "ux_author_email")]`. O `Name` do atributo se torna o nome no banco de dados.

Isso não escala. Cada nova entidade precisa das mesmas três chamadas, a tabela de junção de uma skip navigation é fácil de esquecer, e no dia em que alguém adicionar um índice sem a chamada, você volta para `IX_`. É para isso que serve uma convenção.

## Uma convenção de finalização do modelo que nomeia tudo

A documentação do EF Core sobre [configuração em massa do modelo](https://learn.microsoft.com/en-us/ef/core/modeling/bulk-configuration) descreve dois tipos de convenções personalizadas. As interativas reagem a cada mudança do modelo no momento em que ela acontece. As de *finalização do modelo* rodam uma única vez, depois que `OnModelCreating` e todas as convenções internas terminaram, e enxergam o modelo praticamente final. Os nomes de restrições dependem dos nomes de tabelas e de colunas, que podem mudar até o fim da construção do modelo, então uma convenção de finalização é o ponto de extensão certo. Rodar antes significa nomear um índice a partir de uma coluna que um `HasColumnName` posterior renomeia.

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Microsoft.EntityFrameworkCore.Metadata.Conventions;

public sealed class ConstraintNamingConvention : IModelFinalizingConvention
{
    public void ProcessModelFinalizing(
        IConventionModelBuilder modelBuilder,
        IConventionContext<IConventionModelBuilder> context)
    {
        var maxLength = modelBuilder.Metadata.GetMaxIdentifierLength();

        foreach (var entityType in modelBuilder.Metadata.GetEntityTypes())
        {
            var table = entityType.GetTableName();
            if (table is null) continue; // views, keyless query types, TPC abstract roots
            var store = StoreObjectIdentifier.Table(table, entityType.GetSchema());

            foreach (var key in entityType.GetDeclaredKeys())
            {
                var name = key.IsPrimaryKey()
                    ? $"pk_{table}"
                    : $"ak_{table}_{Columns(key.Properties, store)}";
                key.Builder.HasName(Truncate(name, maxLength));
            }

            foreach (var fk in entityType.GetDeclaredForeignKeys())
            {
                var principalTable = fk.PrincipalEntityType.GetTableName();
                if (principalTable is null) continue;
                var name = $"fk_{table}_{principalTable}_{Columns(fk.Properties, store)}";
                fk.Builder.HasConstraintName(Truncate(name, maxLength));
            }

            foreach (var index in entityType.GetDeclaredIndexes())
            {
                var prefix = index.IsUnique ? "ux" : "ix";
                var name = $"{prefix}_{table}_{Columns(index.Properties, store)}";
                index.Builder.HasDatabaseName(Truncate(name, maxLength));
            }
        }
    }

    static string Columns(IEnumerable<IConventionPropertyBase> props, StoreObjectIdentifier store)
        => string.Join("_", props.Select(p =>
            (p as IConventionProperty)?.GetColumnName(store) ?? p.Name));

    static string Truncate(string name, int maxLength)
    {
        if (name.Length <= maxLength) return name;
        // keep names unique after truncation: prefix + 8 hex chars of a stable hash
        var hash = Convert.ToHexString(
            System.Security.Cryptography.SHA256.HashData(
                System.Text.Encoding.UTF8.GetBytes(name)))[..8].ToLowerInvariant();
        return $"{name[..(maxLength - 9)]}_{hash}";
    }
}
```

Registre-a no contexto:

```csharp
// .NET 11, EF Core 11
protected override void ConfigureConventions(ModelConfigurationBuilder configurationBuilder)
    => configurationBuilder.Conventions.Add(_ => new ConstraintNamingConvention());
```

`Conventions.Add` recebe uma factory em vez de uma instância para que uma convenção possa obter serviços do provedor de serviços interno do EF Core. Esta não tem dependências, daí o parâmetro descartado `_`.

O mesmo modelo agora produz:

```sql
-- EF Core 11.0.0-rc.1, SQL Server provider, with ConstraintNamingConvention
CONSTRAINT [pk_Blogs] PRIMARY KEY ([Id]),
CONSTRAINT [ak_Blogs_Slug] UNIQUE ([Slug])
CONSTRAINT [fk_Posts_Blogs_BlogId] FOREIGN KEY ([BlogId]) REFERENCES [Blogs] ([Id]) ON DELETE CASCADE
CONSTRAINT [pk_PostTag] PRIMARY KEY ([PostsId], [TagsId]),
CONSTRAINT [fk_PostTag_Tags_TagsId] FOREIGN KEY ([TagsId]) REFERENCES [Tags] ([Id]) ON DELETE CASCADE
CREATE INDEX [ix_Posts_BlogId_Title] ON [Posts] ([BlogId], [Title]);
CREATE INDEX [ix_PostTag_TagsId] ON [PostTag] ([TagsId]);
```

A tabela de junção implícita `PostTag` é coberta sem nenhum código extra porque ela é um tipo de entidade real (de tipo compartilhado) no modelo, e `GetEntityTypes()` a retorna.

Alguns detalhes nesse código são intencionais.

**Use os builders de convenção, não os setters.** `key.Builder.HasName(...)` define o nome com `ConfigurationSource.Convention`. O EF Core rastreia de onde veio cada parte da configuração, e um valor com origem em convenção nunca sobrescreve um valor `DataAnnotation` ou `Explicit`. Na reprodução, mantive o índice único nomeado explicitamente com `.HasDatabaseName("UX_Authors_Email_Legacy")` em `OnModelCreating`, e a saída ainda contém `CREATE UNIQUE INDEX [UX_Authors_Email_Legacy]`, enquanto todos os outros índices receberam o tratamento `ix_`/`ux_`. Se em vez disso você chamar os setters mutáveis (`IMutableKey.SetName`) em um loop no final de `OnModelCreating`, perde essa precedência e sobrescreve silenciosamente nomes que um colega definiu de propósito.

**Use o nome da coluna para o objeto de armazenamento, não o nome da propriedade.** `GetColumnName(StoreObjectIdentifier)` retorna o que realmente está na tabela, incluindo substituições feitas com `HasColumnName` e prefixos de tipos owned como `Where_City`. Nomear um índice a partir da propriedade CLR gera nomes que não correspondem às colunas que ele cobre.

**`Properties` é `IConventionPropertyBase` no EF Core 11.** No EF Core 11 RC 1, `IConventionKey.Properties` é tipado como `IReadOnlyList<IConventionPropertyBase>`, então um método auxiliar declarado como `IEnumerable<IConventionProperty>` falha ao compilar com CS1503. O cast em `Columns` resolve isso e recorre ao nome do membro para qualquer coisa que não seja uma propriedade escalar simples.

## Colocando em produção: banco de dados novo vs banco de dados existente

A convenção de nomenclatura altera o modelo, então `dotnet ef migrations add` enxerga uma diferença. O conteúdo dessa diferença é a parte que dá problema.

1. **Projeto novo ou nenhum banco de dados implantado ainda.** Adicione a convenção antes da primeira migração. `InitialCreate` contém os novos nomes e nada mais precisa ser feito.
2. **Banco de dados existente, tabelas pequenas.** Gere a migração, leia-a e aplique-a. O EF Core reconstrói as chaves, o que não é problema quando as tabelas são pequenas.
3. **Banco de dados existente, tabelas grandes.** Gere a migração e, antes que alguém a aplique, substitua os pares de remoção/adição por renomeações.

Para ver exatamente do que se trata o passo 3, comparei o modelo com nomes padrão ao modelo com nomes da convenção usando `IMigrationsModelDiffer`, o mesmo componente que `migrations add` usa. Os índices saem como renomeações baratas:

```sql
-- EF Core 11.0.0-rc.1: RenameIndexOperation on SQL Server
EXEC sp_rename N'[Posts].[IX_Posts_BlogId_Title]', N'ix_Posts_BlogId_Title', 'INDEX';
EXEC sp_rename N'[PostTag].[IX_PostTag_TagsId]', N'ix_PostTag_TagsId', 'INDEX';
```

Chaves primárias, chaves alternativas e chaves estrangeiras não. Não existe operação de migração `RenamePrimaryKey` ou `RenameForeignKey`, então o differ emite uma remoção e uma adição para cada uma, 24 operações para este modelo de cinco tabelas:

```sql
-- EF Core 11.0.0-rc.1: what the scaffolded migration does to keys
ALTER TABLE [Posts] DROP CONSTRAINT [FK_Posts_Blogs_BlogId];
ALTER TABLE [Posts] DROP CONSTRAINT [PK_Posts];
ALTER TABLE [Blogs] DROP CONSTRAINT [AK_Blogs_Slug];
ALTER TABLE [Blogs] DROP CONSTRAINT [PK_Blogs];
-- ...
ALTER TABLE [Posts] ADD CONSTRAINT [pk_Posts] PRIMARY KEY ([Id]);
ALTER TABLE [Blogs] ADD CONSTRAINT [ak_Blogs_Slug] UNIQUE ([Slug]);
ALTER TABLE [Blogs] ADD CONSTRAINT [pk_Blogs] PRIMARY KEY ([Id]);
ALTER TABLE [Posts] ADD CONSTRAINT [fk_Posts_Blogs_BlogId] FOREIGN KEY ([BlogId]) REFERENCES [Blogs] ([Id]) ON DELETE CASCADE;
```

No SQL Server, a chave primária é o índice clusterizado por padrão. Removê-la converte a tabela em um heap e reescreve todos os índices não clusterizados; adicioná-la de volta ordena e reescreve a tabela novamente, e depois reescreve os índices não clusterizados uma segunda vez. Recriar cada chave estrangeira valida todas as linhas existentes. Em uma tabela com dezenas de milhões de linhas, essa é uma operação longa e pesada no log, dentro da transação da migração, só para mudar a caixa de um prefixo. O mesmo padrão de remover e adicionar aparece quando você [renomeia uma tabela em uma migração do EF Core 11](/pt-br/2026/08/how-to-rename-a-table-in-an-ef-core-11-migration-without-losing-data/), e a solução é a mesma: renomear as restrições no lugar.

No SQL Server, substitua as chamadas `DropForeignKey`/`DropPrimaryKey`/`DropUniqueConstraint` geradas e as chamadas `Add*` correspondentes em `Up` por `sp_rename`, que renomeia uma restrição como uma alteração apenas de metadados. Renomear uma chave primária ou restrição única com `sp_rename` também renomeia o índice que a sustenta.

```csharp
// .NET 11, EF Core 11 - hand-edited Up() for SQL Server
protected override void Up(MigrationBuilder migrationBuilder)
{
    migrationBuilder.Sql("EXEC sp_rename N'[dbo].[PK_Blogs]', N'pk_Blogs', 'OBJECT';");
    migrationBuilder.Sql("EXEC sp_rename N'[dbo].[AK_Blogs_Slug]', N'ak_Blogs_Slug', 'OBJECT';");
    migrationBuilder.Sql("EXEC sp_rename N'[dbo].[PK_Posts]', N'pk_Posts', 'OBJECT';");
    migrationBuilder.Sql("EXEC sp_rename N'[dbo].[FK_Posts_Blogs_BlogId]', N'fk_Posts_Blogs_BlogId', 'OBJECT';");
    // ...one line per key and foreign key

    // the scaffolded index renames are already fine, keep them
    migrationBuilder.RenameIndex(
        name: "IX_Posts_BlogId_Title", table: "Posts", newName: "ix_Posts_BlogId_Title");
}
```

No PostgreSQL, o equivalente é `ALTER TABLE "Posts" RENAME CONSTRAINT "PK_Posts" TO "pk_Posts";`, que também renomeia o índice por trás de uma chave primária ou restrição única. O Npgsql já gera `ALTER INDEX ... RENAME TO` para os índices comuns.

Escreva também as chamadas inversas de `sp_rename` em `Down`. O `Down` gerado ainda contém pares de remoção/adição, e deixá-lo assim significa que um rollback executa a reconstrução que você acabou de evitar. O snapshot do modelo não é afetado por essa edição manual: ele registra os novos nomes de qualquer forma, então o próximo `migrations add` produz uma diferença vazia. Se não produzir, você esqueceu uma restrição, e a verificação na inicialização vai avisar com [a exceção de alterações pendentes no modelo](/pt-br/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/). Aplique a migração editada por meio de um script revisado ou de um [migrations bundle](/pt-br/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/), não a partir de `Database.Migrate()` na inicialização do app.

## Armadilhas: tabelas compartilhadas, limites de tamanho e o pacote snake_case

**Derive o nome da tabela, nunca do tipo de entidade.** Um tipo owned armazenado na tabela do seu dono, table splitting e TPH colocam vários tipos de entidade em uma mesma tabela, e cada um deles tem seus próprios metadados de chave primária. Eles precisam concordar quanto ao nome da restrição. Na reprodução, troquei o padrão da chave primária para `pk_{entityType.ClrType.Name}` em um modelo com um `Address` owned dentro de `Media`, e a validação do modelo falhou imediatamente:

```text
InvalidOperationException: The table 'Media' cannot be used for entity type 'Media' since it is being used
for entity type 'Address' and the name 'pk_Media' of the primary key {'Id'} does not match the name
'pk_Address' of the primary key {'MediaId'}.
```

Derivar o nome de `GetTableName()` evita isso, porque todo tipo de entidade na tabela compartilhada resolve para a mesma tabela. A mesma reprodução com `pk_{table}` produziu uma única restrição `pk_Media`, e as chaves estrangeiras de TPH declaradas nos tipos derivados `Photo` e `Clip` saíram como `fk_Media_Author_PhotographerId` e `fk_Media_Author_EditorId` na tabela compartilhada. O [guia de mapeamento TPH](/pt-br/2026/07/how-to-configure-table-per-hierarchy-tph-inheritance-mapping-in-ef-core-11/) explica por que as colunas de tipos derivados acabam anuláveis ali.

**Respeite o limite de tamanho de identificadores e mantenha únicos os nomes truncados.** `IConventionModel.GetMaxIdentifierLength()` retorna o limite do provedor: 128 no SQL Server e 32767 no SQLite na minha reprodução. O PostgreSQL trunca identificadores em 63 bytes. Um índice composto sobre nomes de coluna longos passa de 63 com facilidade, e se você simplesmente cortar a string, dois índices que diferem só no final colapsam para o mesmo nome. O EF Core então falha na validação porque dois índices em uma mesma tabela mapeiam para o mesmo nome com colunas diferentes. O método auxiliar `Truncate` mantém um prefixo e acrescenta oito caracteres hexadecimais de um SHA-256 do nome completo. Com um limite de 40 caracteres, `ix_customer_order_line_items_warehouse_location_id_created_at` e `..._updated_at` viraram `ix_customer_order_line_items_wa_0e2c7d55` e `ix_customer_order_line_items_wa_a5c1910c`. Use um hash estável, nunca `string.GetHashCode()`, que é aleatorizado por processo no .NET e produziria um nome diferente, e uma nova migração, a cada build.

**As convenções de finalização rodam na ordem em que você as adiciona.** Se você também tem uma convenção que renomeia tabelas ou colunas (por exemplo, para snake_case), adicione-a *antes* da convenção de nomenclatura de restrições em `ConfigureConventions`. Caso contrário, os nomes das restrições são calculados a partir dos nomes antigos das tabelas.

**`EFCore.NamingConventions` ainda não é um pacote para EF Core 11.** O popular pacote da comunidade que transforma tudo em snake_case, incluindo nomes de chaves e índices, está na versão 10.0.1 até hoje, e seu nuspec fixa `Microsoft.EntityFrameworkCore.Relational` em `[10.0.1, 11.0.0)`. Referenciá-lo junto com o EF Core 11 gera o aviso NU1608 do NuGet, "outside of dependency constraint", e um pacote que nunca foi testado com a API de metadados do 11.0, que, como mostra a mudança para `IConventionPropertyBase`, de fato mudou. Uma convenção de 60 linhas que é sua não tem esse problema.

**Modelos gerados por scaffolding (database-first) ignoram tudo isso.** `dotnet ef dbcontext scaffold` lê os nomes reais do banco de dados e escreve chamadas explícitas de `HasName`/`HasDatabaseName`, e explícito vence convenção. Esse é o comportamento correto, mas não espere que a convenção "conserte" um modelo obtido por engenharia reversa.

**Verifique o resultado, não o código.** `Database.GenerateCreateScript()` em um contexto com uma connection string fictícia imprime o DDL completo sem tocar em um servidor, e `dotnet ef migrations script` mostra o que uma migração pendente vai executar. Ambos são mais rápidos do que ler o snapshot do modelo. Do lado do runtime, [registrar em log o SQL que o EF Core 11 gera](/pt-br/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) mostra os nomes das restrições em qualquer `DbUpdateException` que as referencie.

## Relacionados

- [Como renomear uma tabela em uma migração do EF Core 11 sem perder dados](/pt-br/2026/08/how-to-rename-a-table-in-an-ef-core-11-migration-without-losing-data/)
- [Correção: o modelo do contexto 'X' tem alterações pendentes no EF Core 11](/pt-br/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/)
- [Como aplicar migrações do EF Core 11 em produção com migrations bundles](/pt-br/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/)
- [Como configurar o mapeamento de herança table-per-hierarchy (TPH) no EF Core 11](/pt-br/2026/07/how-to-configure-table-per-hierarchy-tph-inheritance-mapping-in-ef-core-11/)
- [Complex types vs entidades owned no EF Core 11](/pt-br/2026/07/complex-types-vs-owned-entities-in-ef-core-11/)

## Fontes

- [Model bulk configuration](https://learn.microsoft.com/en-us/ef/core/modeling/bulk-configuration) no Microsoft Learn: `ConfigureConventions`, `IModelFinalizingConvention`, origens de configuração e builders de convenção
- [Keys](https://learn.microsoft.com/en-us/ef/core/modeling/keys) e [Indexes and constraints](https://learn.microsoft.com/en-us/ef/core/modeling/indexes) no Microsoft Learn para `HasName` e `HasDatabaseName`
- [sys.sp_rename](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-rename-transact-sql) para renomear restrições no lugar no SQL Server
- [ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html) (`RENAME CONSTRAINT`) e [tamanho de identificadores](https://www.postgresql.org/docs/current/sql-syntax-lexical.html#SQL-SYNTAX-IDENTIFIERS) na documentação do PostgreSQL
- [EFCore.NamingConventions no NuGet](https://www.nuget.org/packages/EFCore.NamingConventions), faixas de dependência da versão 10.0.1
