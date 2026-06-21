---
title: "Como popular um relacionamento muitos-para-muitos no EF Core 11"
description: "Popule a tabela de junção de um relacionamento muitos-para-muitos no EF Core 11: as chaves sombra implícitas que você precisa nomear por conta própria, o padrão UsingEntity HasData e a alternativa em runtime UseSeeding que funciona com skip navigations."
pubDate: 2026-06-21
template: how-to
tags:
  - "dotnet"
  - "efcore"
  - "csharp"
lang: "pt-br"
translationOf: "2026/06/how-to-seed-a-many-to-many-relationship-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-06-21
---

Para popular um relacionamento muitos-para-muitos no EF Core 11, você não popula a skip navigation. Você popula a tabela de junção diretamente, porque `HasData` não consegue preencher uma navigation. Com a junção implícita padrão (sem classe para a entidade de junção), alcance o relacionamento com `UsingEntity` e chame `HasData` na entidade de junção, passando objetos anônimos cujos nomes de propriedade são as chaves estrangeiras sombra que o EF gera -- para um relacionamento `Post.Tags` / `Tag.Posts` essas são `PostsId` e `TagsId`. Você também precisa popular ambas as pontas (`Post` e `Tag`) com valores fixos de chave primária, porque o seeding gerenciado por migração exige que cada chave seja escrita à mão. Se você preferir popular em runtime contra dados ao vivo, use `UseSeeding`/`UseAsyncSeeding` e carregue as entidades para poder adicionar à skip navigation normalmente. Este post usa .NET 11, EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0) e C# 14.

O motivo pelo qual isso confunde tanta gente é que um relacionamento muitos-para-muitos não tem uma terceira classe no modelo típico. Você escreve `Post` com uma `List<Tag>` e `Tag` com uma `List<Post>`, e o EF conjura a tabela de junção para você. Essa conveniência evapora no momento em que você quer dados de seed, porque `HasData` opera sobre tipos de entidade e suas chaves, e a "entidade" de junção que você precisa atingir é invisível no seu código.

## Por que HasData não consegue simplesmente popular a navigation

Comece com o modelo que todo mundo de fato escreve:

```csharp
// .NET 11, EF Core 11 (Microsoft.EntityFrameworkCore 11.0), C# 14
public class Post
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public List<Tag> Tags { get; } = [];
}

public class Tag
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public List<Post> Posts { get; } = [];
}
```

O EF Core mapeia isso por convenção em três tabelas: `Posts`, `Tags` e uma tabela de junção chamada `PostTag` com duas colunas, `PostsId` e `TagsId`. Esses nomes de coluna não são arbitrários. A chave estrangeira sombra que aponta de volta para a tabela `Posts` é nomeada a partir da navigation que aponta para posts (`Tag.Posts`), e da mesma forma `TagsId` vem de `Post.Tags`. Você nunca declarou essas propriedades; o EF as criou como propriedades sombra em um tipo de entidade de tipo compartilhado que ele gerencia para você.

`HasData` é o mecanismo de seeding em tempo de migração. Ele funciona anexando linhas a um tipo de entidade específico, calculando os inserts ao comparar com o snapshot do modelo. Não existe nenhum tipo de entidade no seu código para a associação entre um post e uma tag, então não há nada ao qual `HasData` possa se anexar. Você também não pode escrever `post.Tags.Add(tag)` em `OnModelCreating`: a construção do modelo configura o formato do modelo, ela não roda contra um `DbContext`, e skip navigations não são preenchidas ali. A associação vive na tabela de junção, e a tabela de junção é o que você tem que popular.

Essa é a mesma família de limitação que torna `HasData` desajeitado de modo geral: ele precisa de dados determinísticos, explicitamente com chaves, e é de propriedade das migrações em vez da sua aplicação. Se esse tradeoff é novo para você, o quadro mais amplo está em [como popular dados com UseSeeding e UseAsyncSeeding no EF Core 11](/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/), que cobre quando o `HasData` gerenciado por migração é a ferramenta completamente errada.

## Populando a junção implícita com UsingEntity e HasData

A abordagem em tempo de migração tem três partes, e pular qualquer uma delas deixa você com um seed quebrado. Aqui está o procedimento completo.

1. **Popule ambos os tipos de entidade principais** com `HasData`, dando a cada linha uma chave primária fixa. O EF não vai gerar chaves para dados de seed, então você as atribui.
2. **Alcance a entidade de junção** com `UsingEntity`, nomeando a tabela de junção explicitamente para que a configuração seja estável.
3. **Chame `HasData` na entidade de junção**, passando objetos anônimos cujos nomes de propriedade correspondam às chaves estrangeiras sombra (`PostsId`, `TagsId`).

Reunida, a configuração em `OnModelCreating` fica assim:

```csharp
// .NET 11, EF Core 11, C# 14 -- seeding an implicit (unmapped) join table
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Post>().HasData(
        new Post { Id = 1, Title = "Span<T> in depth" },
        new Post { Id = 2, Title = "EF Core 11 changes" });

    modelBuilder.Entity<Tag>().HasData(
        new Tag { Id = 1, Name = "dotnet" },
        new Tag { Id = 2, Name = "performance" },
        new Tag { Id = 3, Name = "efcore" });

    modelBuilder.Entity<Post>()
        .HasMany(p => p.Tags)
        .WithMany(t => t.Posts)
        .UsingEntity(
            "PostTag",
            r => r.HasOne(typeof(Tag)).WithMany().HasForeignKey("TagsId"),
            l => l.HasOne(typeof(Post)).WithMany().HasForeignKey("PostsId"),
            j => j.HasData(
                new { PostsId = 1, TagsId = 1 },   // "Span<T>" tagged "dotnet"
                new { PostsId = 1, TagsId = 2 },   // "Span<T>" tagged "performance"
                new { PostsId = 2, TagsId = 1 },   // "EF Core 11" tagged "dotnet"
                new { PostsId = 2, TagsId = 3 })); // "EF Core 11" tagged "efcore"
}
```

Os nomes de propriedade nos objetos anônimos são o contrato aqui. Eles precisam ser exatamente `PostsId` e `TagsId`, correspondendo às chaves estrangeiras sombra que o EF declarou. Escreva um errado, pluralize de forma diferente ou use o singular `PostId` e a geração da migração lança `The seed entity for entity type 'PostTag' cannot be added because the value 'PostId' is not present`, porque essa propriedade não existe na entidade de junção.

Execute `dotnet ef migrations add SeedPostTags` e a migração gerada insere os posts, as tags e quatro linhas em `PostTag`. A partir daí, cada `dotnet ef database update` aplica esses dados uma vez, e o EF os rastreia no snapshot do modelo para saber que não deve reinserir.

Você pode nomear a entidade de junção sem nomear a tabela passando apenas a configuração lambda, mas eu recomendo sempre passar a string de nome explícita `"PostTag"`. O nome padrão é derivado dos nomes dos seus tipos, e se você algum dia renomear `Post` para `Article`, uma junção sem nome silenciosamente renomeia a tabela e deixa seus dados existentes órfãos. Fixar o nome torna a renomeação uma mudança deliberada e revisável.

## Quando você tem uma classe de junção com payload

Se sua tabela de junção carrega colunas extras -- um timestamp `CreatedOn`, uma ordem de classificação, uma flag de "tag primária" -- você terá uma classe real para ela, e as chaves estrangeiras seguem a convenção singular `PostId` / `TagId` em vez da forma duplicada `PostsId` / `TagsId` do caso implícito. Essa diferença pega quem está saindo de uma junção implícita para uma explícita.

```csharp
// .NET 11, EF Core 11, C# 14 -- join entity with payload
public class PostTag
{
    public int PostId { get; set; }
    public int TagId { get; set; }
    public DateTime TaggedOn { get; set; }
}
```

Agora você popula a entidade de junção da mesma forma que popula qualquer entidade, porque ela é um tipo de entidade normal:

```csharp
modelBuilder.Entity<Post>()
    .HasMany(p => p.Tags)
    .WithMany(t => t.Posts)
    .UsingEntity<PostTag>();

modelBuilder.Entity<PostTag>().HasData(
    new PostTag { PostId = 1, TagId = 1, TaggedOn = new DateTime(2026, 6, 1) },
    new PostTag { PostId = 1, TagId = 2, TaggedOn = new DateTime(2026, 6, 1) },
    new PostTag { PostId = 2, TagId = 3, TaggedOn = new DateTime(2026, 6, 2) });
```

Note que o `DateTime` é uma constante codificada, não `DateTime.UtcNow`. Dados de seed precisam ser determinísticos: um valor que muda a cada build faz o modelo parecer modificado, e o EF emite um `PendingModelChangesWarning` e quer gerar uma nova migração toda vez. Essa é uma das arestas que incomodam durante uma [migração do EF Core 6 para o EF Core 11](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/), onde a detecção mais rígida de mudanças no modelo transforma o re-seed silencioso de ontem em um aviso de build. Se você precisa de um timestamp de inserção, configure um valor padrão de banco de dados com `HasDefaultValueSql("GETUTCDATE()")` na propriedade e deixe-o completamente de fora do objeto de seed.

## Uma ressalva sobre o tipo de junção implícito

A equipe do EF é explícita sobre isso na documentação: a entidade de junção implícita é atualmente representada por `Dictionary<string, object>`, mas você não deve depender disso. Uma versão futura do EF Core pode mudar o tipo em runtime por desempenho. Isso importa para o seeding de uma forma prática. Não tente popular construindo um `Dictionary<string, object>` você mesmo ou referenciando o tipo diretamente. Mantenha-se na forma de objeto anônimo dentro de `UsingEntity(...).HasData(...)`. O objeto anônimo é correspondido por nome de propriedade contra as propriedades da entidade de junção, então ele fica isolado de qualquer que seja o tipo CLR concreto que o EF use por baixo dos panos.

Se você se perceber querendo referenciar o tipo de junção, esse é o sinal para promovê-lo a uma classe real como na seção anterior. Uma classe nomeada é a forma suportada de obter uma entidade de junção estável e referenciável, e ela torna o seeding, as consultas e a adição de colunas de payload diretos.

## Populando em runtime com UseSeeding em vez disso

O `HasData` gerenciado por migração é a ferramenta certa para associações de referência pequenas e fixas que acompanham seu schema -- um conjunto conhecido de tags de sistema vinculadas a posts conhecidos. É a ferramenta errada para qualquer coisa dinâmica, qualquer coisa com chave gerada pelo banco de dados, ou qualquer coisa que você preferiria expressar como "adicione esta tag a este post" contra objetos ao vivo. Para isso, popule em runtime com `UseSeeding` e `UseAsyncSeeding`, onde você tem um `DbContext` real e pode usar a skip navigation da forma como ela foi feita para ser usada.

```csharp
// Program.cs -- .NET 11, ASP.NET Core 11, EF Core 11
builder.Services.AddDbContext<AppDbContext>(options =>
    options
        .UseSqlServer(builder.Configuration.GetConnectionString("Default"))
        .UseSeeding((context, _) => SeedPostTags(context))
        .UseAsyncSeeding(async (context, _, ct) => await SeedPostTagsAsync(context, ct)));

static void SeedPostTags(DbContext context)
{
    var post = context.Set<Post>()
        .Include(p => p.Tags)
        .FirstOrDefault(p => p.Title == "EF Core 11 changes");
    if (post is null) return;

    var efcore = context.Set<Tag>().FirstOrDefault(t => t.Name == "efcore");
    if (efcore is not null && !post.Tags.Any(t => t.Id == efcore.Id))
    {
        post.Tags.Add(efcore);   // EF inserts the join row for you
        context.SaveChanges();
    }
}

static async Task SeedPostTagsAsync(DbContext context, CancellationToken ct)
{
    var post = await context.Set<Post>()
        .Include(p => p.Tags)
        .FirstOrDefaultAsync(p => p.Title == "EF Core 11 changes", ct);
    if (post is null) return;

    var efcore = await context.Set<Tag>().FirstOrDefaultAsync(t => t.Name == "efcore", ct);
    if (efcore is not null && !post.Tags.Any(t => t.Id == efcore.Id))
    {
        post.Tags.Add(efcore);
        await context.SaveChangesAsync(ct);
    }
}
```

Duas coisas para notar. Primeiro, você faz `Include(p => p.Tags)` para que as associações existentes sejam carregadas; sem isso, o guarda `!post.Tags.Any(...)` vê uma coleção vazia e você corre o risco de um insert de chave duplicada na tabela de junção. Segundo, a verificação de existência é obrigatória, porque esses callbacks rodam a cada `Migrate`, `EnsureCreated` ou `dotnet ef database update`, não apenas na primeira vez. Adicione a tag incondicionalmente e você vai bater em uma violação de chave primária em `PostTag` na segunda vez que o seeder rodar. As regras completas de quando esses callbacks disparam, e por que você tem que implementar tanto a sobrecarga síncrona quanto a assíncrona, estão no [mergulho profundo em UseSeeding](/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/).

O ganho é que `post.Tags.Add(efcore)` é a API natural. O change tracker do EF vê uma nova entrada na skip navigation e emite o insert na tabela de junção por conta própria. Você nunca nomeia `PostsId` ou `TagsId`, nunca constrói um objeto anônimo, e o código se lê como o resto da sua aplicação. O custo é que isso roda na inicialização contra um banco de dados ao vivo em vez de ser embutido em uma migração, então é melhor para desenvolvimento, testes e dados de referência idempotentes do que para dados de produção versionados pelo schema.

## Erros que produzem mensagens confusas

Alguns modos de falha recorrem, e as mensagens de erro nem sempre apontam para a causa real.

Popular apenas as linhas de junção e esquecer de popular os principais dá a você uma violação de chave estrangeira no momento do `database update`, porque `PostsId = 1` referencia uma linha em `Posts` que não existe. Sempre popule ambas as pontas com as mesmas chaves fixas que você referencia na junção.

Usar os nomes errados de chave sombra -- `PostId` em vez de `PostsId` para a junção implícita -- falha na geração da migração com uma mensagem sobre uma propriedade que não está presente na entidade de junção. A forma duplicada (`PostsId`, `TagsId`) é para a junção implícita e não mapeada; a forma singular (`PostId`, `TagId`) é para uma classe de junção explícita. Elas não são intercambiáveis.

Deixar uma coluna de payload assumir como padrão um valor não determinístico como `DateTime.UtcNow` no objeto de seed produz um fluxo interminável de migrações de "modelo alterado". Codifique o valor ou empurre-o para um valor padrão do banco de dados.

Por fim, se sua entidade principal não tem nenhuma chave definida -- um tipo sem chave ou mal configurado -- o seed nem chega tão longe; você verá primeiro [the entity type requires a primary key to be defined](/2026/06/fix-the-entity-type-requires-a-primary-key-to-be-defined/). Conserte o modelo antes de se preocupar com os dados de seed.

A decisão entre as duas abordagens se resume à propriedade. Se as associações fazem parte da identidade do seu schema e devem viajar dentro das migrações, popule a entidade de junção com `UsingEntity(...).HasData(...)` e aceite a contabilidade manual de chaves. Se elas são dados em runtime que você preferiria expressar contra objetos ao vivo, use `UseSeeding` e adicione à skip navigation. A maioria das aplicações reais acaba usando `HasData` para um punhado de associações de sistema e `UseSeeding` para todo o resto, e essa divisão é exatamente o que a equipe do EF projetou os dois mecanismos para cobrir.

Fontes: a [documentação de relacionamentos muitos-para-muitos](https://learn.microsoft.com/en-us/ef/core/modeling/relationships/many-to-many) do EF Core no Microsoft Learn detalha a junção implícita, as chaves sombra `PostsId`/`TagsId`, as sobrecargas de `UsingEntity` e o aviso contra depender de `Dictionary<string, object>`; a [documentação de seeding de dados](https://learn.microsoft.com/en-us/ef/core/modeling/data-seeding) do EF Core cobre `HasData` versus `UseSeeding`/`UseAsyncSeeding` e o requisito de determinismo; a discussão no GitHub em [dotnet/efcore#23363](https://github.com/dotnet/efcore/issues/23363) mostra o padrão `UsingEntity(...).HasData(...)` confirmado pela comunidade para popular a tabela de junção.
