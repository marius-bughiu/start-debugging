---
title: "Correção: The property 'X' is part of a key and so cannot be modified or marked as modified no EF Core"
description: "O EF Core nunca atualiza o valor de uma chave em uma entidade rastreada. Pare de copiar a chave de DTOs, use um índice único em vez de uma chave alternativa e altere uma chave de verdade inserindo uma nova linha e excluindo a antiga. Testado no EF Core 10.0.14."
pubDate: 2026-10-27
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "dotnet"
  - "csharp"
  - "change-tracker"
  - "dotnet-10"
lang: "pt-br"
translationOf: "2026/10/fix-the-property-is-part-of-a-key-and-so-cannot-be-modified-in-ef-core"
translatedBy: "claude"
translationDate: 2026-10-27
---

**Resposta curta:** o EF Core trata toda propriedade de chave (chave primária, chave alternativa e qualquer chave estrangeira que também faça parte da chave primária) como somente leitura depois que a entidade foi salva, e o change tracker lança uma exceção assim que percebe um novo valor. Descubra o que está escrevendo na chave: geralmente um mapeador de DTO ou `CurrentValues.SetValues` copiando um `Id` igual a `0`, uma coluna natural configurada com `HasAlternateKey`, ou uma linha filha com chave composta sendo movida para outro pai. Pare de escrever na chave, troque a chave alternativa por um índice único ou, quando a chave realmente precisa mudar, adicione uma nova entidade com a nova chave e remova a antiga no mesmo `SaveChanges`.

Tudo abaixo foi reproduzido no .NET 10 (SDK 10.0.302) com `Microsoft.EntityFrameworkCore.Sqlite` 10.0.14 contra um banco de dados SQLite em memória. A verificação que lança a exceção fica em `InternalEntryBase.SetPropertyModified` e continua igual no branch `main` do EF Core, que será lançado como EF Core 11, então as mesmas regras valem para os release candidates do .NET 11.

## O erro em contexto

```
System.InvalidOperationException: The property 'Blog.Id' is part of a key and so cannot be modified or marked as modified. To change the principal of an existing entity with an identifying foreign key, first delete the dependent and invoke 'SaveChanges', and then associate the dependent with the new principal.
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.InternalEntryBase.SetPropertyModified(IProperty property, Boolean changeState, Boolean isModified, Boolean isConceptualNull, Boolean acceptChanges)
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.ChangeDetector.DetectValueChange(IInternalEntry entry, IProperty property)
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.ChangeDetector.LocalDetectChanges(InternalEntryBase entry)
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.ChangeDetector.LocalDetectChanges(InternalEntityEntry entry)
```

O nome da propriedade na mensagem diz qual chave o EF está protegendo. `Blog.Id` é uma chave primária. Algo como `Blog.Slug` indica uma chave alternativa. `OrderLine.OrderId` indica uma chave estrangeira que também faz parte de uma chave primária composta, que é a "identifying foreign key" a que a segunda frase da mensagem se refere.

## Por que o EF Core se recusa a alterar uma chave

Uma entidade rastreada é identificada pela sua chave. O `DbContext` mantém um mapa de identidade dos valores de chave para as instâncias de entidade, usa a chave original na cláusula `WHERE` do `UPDATE` e corrige as navegações combinando chaves estrangeiras com chaves principais. Se a chave pudesse mudar no lugar, os três mecanismos teriam de ser reescritos no meio do processo, além de toda linha dependente no banco de dados. O EF Core não oferece suporte a isso, e o pedido para adicioná-lo, [dotnet/efcore#4073](https://github.com/dotnet/efcore/issues/4073), continua aberto.

A proteção é guiada por metadados. Toda propriedade de chave recebe `PropertySaveBehavior.Throw` como comportamento após o salvamento, e o change tracker o verifica sempre que uma propriedade de uma entidade `Unchanged` ou `Modified` está prestes a ser marcada como modificada:

```csharp
// EF Core source, src/EFCore/ChangeTracking/Internal/InternalEntryBase.cs (simplified)
if (changeState
    && !isConceptualNull
    && isModified
    && !StateManager.SavingChanges
    && property.IsKey()
    && property.GetAfterSaveBehavior() == PropertySaveBehavior.Throw)
{
    throw new InvalidOperationException(CoreStrings.KeyReadOnly(property.Name, StructuralType.DisplayName()));
}
```

Duas consequências importam para a depuração. Primeiro, entidades no estado `Added` retornam antes dessa verificação, então alterar a chave de uma entidade que você ainda não salvou é permitido. Segundo, com o rastreamento de alterações por snapshot (o padrão), a exceção não é lançada na linha que atribui a chave. Ela é lançada no próximo `DetectChanges`, que roda dentro de `SaveChanges`, `ChangeTracker.HasChanges()`, `ChangeTracker.Entries()` e chamadas semelhantes. No meu repro, `blog.Id = 99;` terminou silenciosamente e o `db.ChangeTracker.HasChanges()` logo em seguida lançou a exceção. Se o seu stack trace aponta para `SaveChangesAsync` em um repositório, o verdadeiro culpado está em algum ponto anterior da requisição.

Também não há como desativar isso. Tentar alterar o comportamento de salvamento de uma propriedade de chave falha durante a construção do modelo:

```csharp
// .NET 10, EF Core 10.0.14
modelBuilder.Entity<Blog>().Property(b => b.Id).Metadata
    .SetAfterSaveBehavior(PropertySaveBehavior.Save);
// InvalidOperationException: The property 'Blog.Id' must be marked as read-only after it has been
// saved because it is part of a key. Key properties are always read-only once an entity has been
// saved for the first time.
```

## Repro mínimo

```csharp
// .NET 10, C# 14, EF Core 10.0.14, Microsoft.EntityFrameworkCore.Sqlite
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;

using var conn = new SqliteConnection("Data Source=:memory:");
conn.Open();

using (var db = new AppDb(conn))
{
    db.Database.EnsureCreated();
    db.Blogs.Add(new Blog { Id = 1, Name = "Start Debugging" });
    db.SaveChanges();
}

using (var db = new AppDb(conn))
{
    var blog = db.Blogs.Single(b => b.Id == 1);
    blog.Id = 99;       // no exception here
    db.SaveChanges();   // InvalidOperationException: The property 'Blog.Id' is part of a key...
}

class AppDb(SqliteConnection c) : DbContext
{
    public DbSet<Blog> Blogs => Set<Blog>();
    protected override void OnConfiguring(DbContextOptionsBuilder o) => o.UseSqlite(c);
    protected override void OnModelCreating(ModelBuilder mb) =>
        mb.Entity<Blog>().Property(b => b.Id).ValueGeneratedNever();
}

class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
}
```

Ninguém escreve `blog.Id = 99` de propósito, então o restante deste post trata dos quatro lugares de onde a escrita realmente vem, ordenados por frequência com que os vejo.

## Correção 1: pare de copiar a chave de um DTO

Esta é, de longe, a causa mais comum. Um endpoint PUT carrega a entidade e depois copia o modelo recebido por cima dela:

```csharp
// .NET 10, EF Core 10.0.14
public record BlogDto(int Id, string Name);

var blog = await db.Blogs.SingleAsync(b => b.Id == id);
db.Entry(blog).CurrentValues.SetValues(dto);   // dto.Id is 0 because the client never sent it
await db.SaveChangesAsync();                    // throws: 'Blog.Id' is part of a key
```

`PropertyValues.SetValues` copia toda propriedade cujo nome coincide, chaves incluídas. Quando o `Id` do DTO é igual ao da entidade rastreada, nada muda e o salvamento tem sucesso; confirmei que `SetValues` com `Id = 1` na linha com `Id = 1` salva sem problemas. Quando o cliente omite o id do corpo, ou o id da rota e o id do corpo divergem, a chave muda e o EF lança a exceção. Observe que o stack trace nesse caso é diferente: como `SetValues` passa direto pelo change tracker, a exceção é levantada dentro do próprio `SetValues` (`ChangeDetector.PropertyChanged`), não em `SaveChanges`.

Escolha uma única fonte de verdade para o id, geralmente a rota, e nunca deixe o corpo sobrescrevê-lo:

```csharp
// .NET 10, EF Core 10.0.14
app.MapPut("/blogs/{id:int}", async (int id, BlogDto dto, AppDb db) =>
{
    if (dto.Id != 0 && dto.Id != id)
        return Results.BadRequest("Route id and body id differ.");

    var blog = await db.Blogs.SingleOrDefaultAsync(b => b.Id == id);
    if (blog is null) return Results.NotFound();

    db.Entry(blog).CurrentValues.SetValues(dto with { Id = id });
    await db.SaveChangesAsync();
    return Results.NoContent();
});
```

Melhor ainda é usar um DTO de atualização que não tenha nenhuma propriedade `Id`, de modo que não haja nada para copiar. Com o AutoMapper, o equivalente é `.ForMember(d => d.Id, o => o.Ignore())` no mapeamento de DTO para entidade, e vale adicionar `ForMember(...Ignore())` para toda coluna de chave, incluindo chaves estrangeiras que fazem parte de uma chave composta.

O mesmo erro acontece com helpers manuais de "copiar todas as propriedades" e com patchers baseados em reflexão. Se você escrever um, filtre `entry.Metadata.FindPrimaryKey()!.Properties` e tudo em que `property.IsKey()` seja verdadeiro.

## Correção 2: use um índice único, não uma chave alternativa, para identificadores naturais

O segundo formato é uma coluna que você considera "única", como um slug, um e-mail ou um SKU, configurada como chave alternativa:

```csharp
// .NET 10, EF Core 10.0.14
modelBuilder.Entity<Blog>().HasAlternateKey(b => b.Slug);

var blog = db.Blogs.Single();
blog.Slug = "new-slug";
db.SaveChanges();   // InvalidOperationException: The property 'Blog.Slug' is part of a key...
```

Uma chave alternativa é uma chave em todos os sentidos que importam para o EF, então ela é somente leitura depois do salvamento. A documentação do EF Core diz isso diretamente: "In EF, alternate keys are read-only". Se tudo o que você precisa é de unicidade no banco de dados, configure um índice único:

```csharp
// .NET 10, EF Core 10.0.14
modelBuilder.Entity<Blog>().HasIndex(b => b.Slug).IsUnique();
```

Com essa mudança de uma linha, o mesmo código salvou e a linha foi lida de volta com `Slug = "new-slug"`. O banco de dados continua garantindo a unicidade; você apenas perde a capacidade de apontar uma chave estrangeira para `Slug`.

Fique atento a chaves alternativas que você não declarou. `HasPrincipalKey(x => x.Slug)` em um relacionamento faz o EF criar uma por convenção, porque uma chave estrangeira precisa apontar para uma chave. Se a mensagem citar uma propriedade na qual você nunca chamou `HasAlternateKey`, procure `HasPrincipalKey` na configuração do modelo ou inspecione `db.Model.FindEntityType(typeof(Blog))!.GetKeys()` em tempo de execução. Fazer esse relacionamento apontar para a chave primária é a correção limpa. Quanto às migrações, passar de chave alternativa para índice único substitui uma constraint única `AK_` por um índice único `IX_`; verifique a migração gerada antes de aplicá-la.

## Correção 3: mova um dependente com chave composta excluindo e adicionando de novo

A segunda frase da mensagem trata deste caso. Digamos que uma linha de pedido tenha a chave `(OrderId, LineNumber)` e que `OrderId` seja também a chave estrangeira para `Order`. Isso é um relacionamento identificador: a identidade da linha inclui o seu pai. Movê-la para outro pedido significa alterar a chave primária, e todas as formas de expressar isso lançam exceção:

```csharp
// .NET 10, EF Core 10.0.14
modelBuilder.Entity<OrderLine>().HasKey(l => new { l.OrderId, l.LineNumber });

var line = db.OrderLines.Single();
line.OrderId = 2;                     // throws at SaveChanges
// line.Order = order2;               // throws during fix-up
// order2.Lines.Add(line);            // throws during fix-up
db.SaveChanges();
```

As três variantes produziram `The property 'OrderLine.OrderId' is part of a key` no meu repro. As versões com navegação e com coleção lançam a exceção a partir do fix-up de relacionamento, que define a chave estrangeira por você.

A correção é tratar a mudança pelo que ela realmente é: a exclusão de uma linha e a inserção de outra.

```csharp
// .NET 10, EF Core 10.0.14
var line = await db.OrderLines.SingleAsync(l => l.OrderId == 1 && l.LineNumber == 1);

db.OrderLines.Remove(line);
db.OrderLines.Add(new OrderLine
{
    OrderId = 2,
    LineNumber = 1,
    Sku = line.Sku,
});

await db.SaveChangesAsync();
```

A mensagem sugere chamar `SaveChanges` depois da exclusão e antes da inserção. No EF Core 10 isso não foi necessário em nenhum caso que testei: remover a linha antiga e adicionar a nova em um único `SaveChanges` funcionou tanto quando a nova chave era diferente (`2/1`) quanto quando era idêntica (`1/1` com um novo `Sku`), e os dois comandos rodaram na mesma transação. Um único `SaveChanges` também é mais seguro, porque uma falha entre dois salvamentos deixaria a linha excluída e não recriada.

Se as linhas mudam de pai com frequência, o modelo está lhe dizendo algo. Dê a `OrderLine` uma chave substituta própria (`int Id`) e faça de `OrderId` uma chave estrangeira normal, que não faz parte da chave. Assim, `line.OrderId = 2` passa a ser uma atualização comum. Mantenha `(OrderId, LineNumber)` único com um índice único se você precisar dessa restrição.

## Correção 4: troque a chave de uma entidade principal inserindo uma cópia e reapontando os filhos

Às vezes a própria chave primária precisa mudar: uma chave natural legada foi digitada errada, ou dois sistemas estão sendo mesclados. Dentro do change tracker, o padrão é o mesmo da correção 3, com uma etapa extra para os filhos:

```csharp
// .NET 10, EF Core 10.0.14
var old = await db.Blogs.Include(b => b.Posts).SingleAsync(b => b.Id == 1);

var replacement = new Blog { Id = 99, Name = old.Name, Slug = old.Slug + "-moved" };
db.Blogs.Add(replacement);

foreach (var post in old.Posts.ToList())
    post.Blog = replacement;          // Post.BlogId is a plain FK, not part of Post's key

db.Blogs.Remove(old);
await db.SaveChangesAsync();
```

O EF Core determina a ordem dos comandos (inserir o novo blog, atualizar os posts, excluir o blog antigo) e os executa em uma única transação. No repro, isso deixou um blog com `Id = 99` e o `BlogId` do post definido como `99`. Observe que o slug foi alterado na cópia: se `Slug` tivesse um índice único, a inserção de um valor idêntico poderia colidir com a linha antiga, que ainda não foi excluída. Dê à cópia um valor temporário e corrija-o depois, ou use a abordagem baseada em conjuntos abaixo.

### A saída baseada em conjuntos: ExecuteUpdate

`ExecuteUpdate` é traduzido direto para SQL e nunca toca o change tracker, então a proteção de chave não se aplica:

```csharp
// .NET 10, EF Core 10.0.14
var rows = await db.Blogs
    .Where(b => b.Id == 1)
    .ExecuteUpdateAsync(s => s.SetProperty(b => b.Id, 99));
```

Em um blog sem posts, isso retornou `1` e o id da linha passou a ser `99`. Em um blog que tinha um post referenciando-o, o SQLite respondeu com `SQLite Error 19: 'FOREIGN KEY constraint failed'`, que é exatamente o que qualquer banco de dados fará, a menos que a chave estrangeira tenha sido declarada com `ON UPDATE CASCADE`. A fluent API do EF Core tem `OnDelete`, mas nenhum equivalente para atualizações, então você teria de adicionar o cascade com `migrationBuilder.Sql(...)` em uma migração. Para uma correção pontual de dados, isso normalmente não vale a pena; inserir, reapontar e excluir é mais fácil de raciocinar.

Duas ressalvas se você usar `ExecuteUpdate` em chaves. Qualquer entidade já rastreada pelo mesmo contexto continua com a chave antiga, então faça a atualização em um contexto novo ou desanexe antes. E ele ignora interceptors de `SaveChanges` e a lógica de auditoria, o que provavelmente é o objetivo, mas deve ser uma escolha deliberada.

## Armadilhas e casos parecidos

**Definir `IsModified` em uma chave lança a exceção imediatamente.** Código que percorre `entry.Properties` e define `IsModified = true` em todas elas falha na primeira propriedade de chave. `db.Entry(blog).Property(b => b.Id).IsModified = true` lançou a exceção no repro sem nenhuma chamada a `SaveChanges`. Ignore as propriedades em que `p.Metadata.IsKey()` seja verdadeiro. Definir a entrada inteira como `EntityState.Modified` funciona (salvou sem problemas no repro), porque o EF marca apenas as propriedades que não são chave.

**`Update()` em um objeto desanexado com outro id é um erro diferente.** `db.Update(new Blog { Id = 2, ... })` não tenta alterar uma chave. Ele envia `UPDATE ... WHERE Id = 2` e, quando essa linha não existe, você recebe `DbUpdateConcurrencyException: The database operation was expected to affect 1 row(s), but actually affected 0 row(s)`. É o mesmo erro de origem (id errado vindo do cliente), com um sintoma diferente.

**Duas instâncias com a mesma chave também são um erro diferente.** Se você corrigir este erro anexando um segundo objeto com a nova chave enquanto o antigo ainda está rastreado, pode acabar encontrando [o erro "cannot be tracked because another instance with the same key value is already being tracked"](/pt-br/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/). [Verificar se uma entidade já está rastreada](/pt-br/2026/10/how-to-check-whether-an-entity-is-already-tracked-by-the-dbcontext-in-ef-core/) antes de anexar evita os dois.

**Alterar a chave de uma entidade `Added` é permitido.** Até o primeiro `SaveChanges`, a chave ainda não foi "salva", então `var b = new Blog { Id = 5 }; db.Add(b); b.Id = 6;` insere uma linha com `Id = 6`. Isso importa para código que atribui um id provisório e o corrige antes de salvar.

## Relacionado

Se você acabar alterando chaves com instruções baseadas em conjuntos, o passo a passo de [ExecuteUpdate e ExecuteDelete para gravações em massa](/pt-br/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) cobre a API e sua interação com entidades rastreadas, e a comparação entre [ExecuteUpdate e carregar entidades e chamar SaveChanges](/2026/05/ef-core-executeupdate-vs-loading-entities-and-savechanges/) explica quando cada um é a ferramenta certa. Quando a metade de exclusão de uma troca de chave falha porque filhos ainda apontam para a linha antiga, veja [a correção para foreign key constraint failed](/pt-br/2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11/). Para ver exatamente quais entradas estão prestes a ser salvas antes de a exceção ser disparada, [`ChangeTracker.GetEntriesForState`](/pt-br/2026/04/efcore-11-changetracker-getentriesforstate/) é a forma mais barata de listá-las.

## Fontes

- [`KeyReadOnly` resource string](https://github.com/dotnet/efcore/blob/main/src/EFCore/Properties/CoreStrings.resx) e [`InternalEntryBase.SetPropertyModified`](https://github.com/dotnet/efcore/blob/main/src/EFCore/ChangeTracking/Internal/InternalEntryBase.cs), código-fonte do dotnet/efcore.
- [Support modifying the value of primary or alternate key properties, dotnet/efcore#4073](https://github.com/dotnet/efcore/issues/4073), solicitação de recurso em aberto.
- [Keys: alternate keys](https://learn.microsoft.com/en-us/ef/core/modeling/keys#alternate-keys), documentação do EF Core.
- [Indexes: index uniqueness](https://learn.microsoft.com/en-us/ef/core/modeling/indexes#index-uniqueness), documentação do EF Core.
- [Change detection and notifications](https://learn.microsoft.com/en-us/ef/core/change-tracking/change-detection), documentação do EF Core.
- [`PropertyValues.SetValues`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.changetracking.propertyvalues.setvalues), Microsoft Learn.
- [ExecuteUpdate and ExecuteDelete](https://learn.microsoft.com/en-us/ef/core/saving/execute-insert-update-delete), documentação do EF Core.
