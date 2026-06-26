---
title: "Corrigir: FOREIGN KEY constraint failed ao excluir uma entidade no EF Core 11"
description: "O EF Core lança FOREIGN KEY constraint failed porque o pai ainda tem dependentes que o banco de dados se recusa a deixar órfãos. Carregue os filhos, torne o relacionamento opcional ou configure OnDelete."
pubDate: 2026-06-26
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
lang: "pt-br"
translationOf: "2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-06-26
---

A correção: você está excluindo uma linha principal (pai) que ainda tem linhas dependentes (filhas) apontando para ela, e o banco de dados não vai deixá-las órfãs. Você tem três opções reais, em ordem: carregar os dependentes no contexto antes do `SaveChanges` para que o EF Core possa fazer a exclusão em cascata por conta própria; tornar o relacionamento opcional (chave estrangeira anulável) para que a FK dos filhos possa ser definida como null; ou configurar `OnDelete(DeleteBehavior.Cascade)` e recriar o esquema para que o banco de dados exclua os filhos por você. Escolha a que corresponde ao que deve acontecer com os filhos.

```text
Microsoft.EntityFrameworkCore.DbUpdateException: An error occurred while saving the entity changes. See the inner exception for details.
 ---> Microsoft.Data.Sqlite.SqliteException (0x80004005): SQLite Error 19: 'FOREIGN KEY constraint failed'.
   at Microsoft.Data.Sqlite.SqliteException.ThrowExceptionForRC(int rc, sqlite3 db)
   at Microsoft.EntityFrameworkCore.Update.ReaderModificationCommandBatch.ExecuteAsync(...)
```

Este é um erro de banco de dados em tempo de execução, levantado por `SaveChanges`/`SaveChangesAsync` e encapsulado em uma `DbUpdateException`. A redação exata é a do provedor SQLite. No SQL Server, a mesma situação produz `The DELETE statement conflicted with the REFERENCE constraint "FK_..."`, no PostgreSQL é `23503: update or delete on table "..." violates foreign key constraint`, e no MySQL é `Cannot delete or update a parent row: a foreign key constraint fails`. Texto diferente, causa idêntica. Este guia foi escrito com base no .NET 11, C# 14, `Microsoft.EntityFrameworkCore` 11.0.0 e `Microsoft.Data.Sqlite` 11.0.0. O comportamento não mudou desde o EF Core 7, então se aplica até aquela versão.

## Por que o banco de dados recusa a exclusão

O EF Core modela um relacionamento com uma chave estrangeira: a linha dependente armazena a chave primária de seu principal. Quando você exclui o principal, toda FK dependente que apontava para ele agora referencia uma linha que não existe mais. Isso é uma violação de integridade referencial, e um banco de dados relacional a impede na constraint.

Existem apenas duas saídas legais, e o banco de dados só pode escolher uma se você disser qual:

1. Excluir os dependentes também (exclusão em cascata).
2. Definir a chave estrangeira dos dependentes como null (só é possível se a coluna for anulável).

Se você excluir o principal sem providenciar uma dessas opções, o banco de dados lança o erro. A razão pela qual isso aparece com tanta frequência é que a configuração *padrão* do EF Core depende de o relacionamento ser obrigatório ou opcional, e de os dependentes estarem carregados no contexto no momento em que você chama `SaveChanges`. Esses dois interruptores decidem se o EF Core ajusta as coisas em memória antes de enviar o SQL, ou se passa o problema direto para o banco de dados, que então o recusa.

Um fator agravante sutil: o SQLite não impõe chaves estrangeiras de forma alguma a menos que `PRAGMA foreign_keys = ON`, que o `Microsoft.Data.Sqlite` define por padrão. Desenvolvedores que testaram em uma configuração mais antiga, ou no provedor in-memory do EF Core (que não impõe constraints), costumam se surpreender na primeira vez que um banco de dados SQLite ou SQL Server real rejeita a exclusão.

## A menor reprodução possível

Um relacionamento obrigatório de um-para-muitos: `Blog` tem muitos `Post`, e `Post.BlogId` é não anulável, então o relacionamento é obrigatório.

```csharp
// .NET 11, C# 14, EF Core 11.0.0, Microsoft.Data.Sqlite 11.0.0
public class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public List<Post> Posts { get; } = new();
}

public class Post
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public int BlogId { get; set; }            // non-nullable => required relationship
    public Blog Blog { get; set; } = null!;
}

public class AppDb : DbContext
{
    public DbSet<Blog> Blogs => Set<Blog>();
    public DbSet<Post> Posts => Set<Post>();

    public AppDb(DbContextOptions<AppDb> options) : base(options) { }
}
```

Agora exclua um blog que tem posts, sem carregar esses posts:

```csharp
// .NET 11, EF Core 11.0.0 -- throws DbUpdateException -> "FOREIGN KEY constraint failed"
var blog = await db.Blogs.SingleAsync(b => b.Id == 1);   // no Include(b => b.Posts)
db.Blogs.Remove(blog);
await db.SaveChangesAsync();
```

O EF Core só conhece o blog. Ele emite um único `DELETE FROM Blogs WHERE Id = 1`. Os posts ainda referenciam o blog 1, e o banco de dados aborta a instrução. O erro está correto: você pediu para excluir uma linha da qual outras linhas dependem, e não disse o que fazer com elas.

Observe o contraste. Com um relacionamento obrigatório, o comportamento de exclusão padrão é `Cascade`, mas "cascade" pode ser aplicado de duas maneiras: pelo EF Core (em memória, exige que os filhos estejam carregados) ou pelo banco de dados (exige `ON DELETE CASCADE` na constraint). Se o esquema foi criado sem `ON DELETE CASCADE` e os filhos não estão carregados, nenhum dos mecanismos dispara, e você cai neste erro.

## Correção 1: carregue os dependentes para que o EF Core possa fazer cascata

A correção mais portável, e a que funciona independentemente de como a constraint do banco de dados foi criada. Traga os filhos para o contexto com `Include`, e o EF Core emitirá instruções `DELETE` para eles antes de excluir o pai.

```csharp
// .NET 11, EF Core 11.0.0 -- EF Core deletes posts, then the blog
var blog = await db.Blogs
    .Include(b => b.Posts)
    .SingleAsync(b => b.Id == 1);

db.Blogs.Remove(blog);
await db.SaveChangesAsync();
```

Com os posts rastreados, o EF Core percebe que excluir o blog rompe um relacionamento obrigatório, aplica a cascata em memória e ordena o SQL corretamente: exclui os posts primeiro, depois o blog. Isso funciona porque o EF Core "sempre aplica os comportamentos de cascata configurados às entidades rastreadas", independentemente do esquema do banco de dados.

O custo é óbvio: você carrega cada linha dependente na memória só para excluí-la. Para um blog com dez posts, tudo bem. Para um pai com cem mil filhos, isso é um problema de memória e de viagens de ida e volta, e você vai querer a Correção 3 (cascata no banco de dados) ou uma exclusão em massa baseada em conjunto. O [`ExecuteDelete` para escritas em massa](/pt-br/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) do EF Core 11 exclui os filhos em uma única instrução SQL sem materializá-los, que é a ferramenta certa quando o conjunto de filhos é grande. Apenas lembre-se de que `ExecuteDelete` ignora o rastreador de mudanças, então você exclui os filhos explicitamente antes do pai em vez de confiar na cascata.

## Correção 2: torne o relacionamento opcional para que a FK possa ser anulada

Use isto quando o filho pode legitimamente existir sem o pai. Torne a chave estrangeira anulável, e o comportamento padrão para um relacionamento opcional passa a ser `ClientSetNull`: o EF Core define a FK dos dependentes como null em vez de excluí-los.

```csharp
// .NET 11, EF Core 11.0.0 -- optional relationship
public class Post
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public int? BlogId { get; set; }           // nullable => optional relationship
    public Blog? Blog { get; set; }
}
```

Após uma migração que torna a coluna `BlogId` anulável, excluir um blog com seus posts carregados produz `UPDATE Posts SET BlogId = NULL ...` para cada post, depois `DELETE FROM Blogs ...`. Os posts sobrevivem, desvinculados de qualquer blog.

```csharp
// .NET 11, EF Core 11.0.0 -- posts kept, FK set to null
var blog = await db.Blogs.Include(b => b.Posts).SingleAsync(b => b.Id == 1);
db.Blogs.Remove(blog);
await db.SaveChangesAsync();
```

Duas ressalvas. Primeiro, esta é uma decisão semântica, não um truque para silenciar o erro: só torne um relacionamento opcional se um filho órfão for genuinamente válido no seu domínio. Um `Post` sem `Blog` pode não fazer sentido. Segundo, com `ClientSetNull` (o padrão) o EF Core ainda precisa dos dependentes carregados para anular suas FKs; se não estiverem carregados, você recebe uma `DbUpdateException` de novo. Para empurrar a anulação para o banco de dados, de modo que funcione sem carregar, configure `OnDelete(DeleteBehavior.SetNull)`, que emite `ON DELETE SET NULL` na constraint.

```csharp
// .NET 11, EF Core 11.0.0 -- database nulls the FK on delete, no need to load children
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Blog>()
        .HasMany(b => b.Posts)
        .WithOne(p => p.Blog)
        .HasForeignKey(p => p.BlogId)
        .OnDelete(DeleteBehavior.SetNull);
}
```

## Correção 3: configure o banco de dados para fazer a exclusão em cascata

Use isto quando os filhos devem morrer junto com o pai e você não quer carregá-los primeiro. Configure `DeleteBehavior.Cascade` e crie ou migre o esquema para que a constraint carregue `ON DELETE CASCADE`. O banco de dados então exclui os dependentes por conta própria quando você exclui o principal.

```csharp
// .NET 11, EF Core 11.0.0 -- ON DELETE CASCADE in the database
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Blog>()
        .HasMany(b => b.Posts)
        .WithOne(p => p.Blog)
        .HasForeignKey(p => p.BlogId)
        .OnDelete(DeleteBehavior.Cascade);
}
```

Para um relacionamento obrigatório, isso já é o padrão por convenção, mas a constraint só carrega `ON DELETE CASCADE` se o banco de dados foi *criado ou migrado com essa configuração já em vigor*. Esta é a armadilha que pega a maioria das pessoas: elas adicionam `OnDelete(Cascade)` (ou confiam no padrão), o build é bem-sucedido, e a exclusão ainda falha, porque o banco de dados em execução foi criado antes de a cascata ser configurada e a constraint existente não tem cláusula de cascata. A configuração em `OnModelCreating` muda o modelo, não o banco de dados ativo. Você precisa gerar e aplicar uma migração:

```bash
# .NET 11 SDK, EF Core tools 11.0.0
dotnet ef migrations add ConfigurePostCascade
dotnet ef database update
```

Verifique se a constraint realmente carrega a cascata. No SQLite, inspecione a lista de chaves estrangeiras:

```sql
-- run against the SQLite database file
SELECT * FROM pragma_foreign_key_list('Posts');
-- the "on_delete" column should read CASCADE, not NO ACTION
```

Depois disso, `db.Blogs.Remove(blog); await db.SaveChangesAsync();` exclui o blog sem nenhum `Include`, e o banco de dados remove os posts na mesma operação.

Uma limitação de plataforma que vale a pena conhecer antes de recorrer à cascata em todo lugar: o SQL Server rejeita múltiplos caminhos de cascata para a mesma tabela. Se dois relacionamentos obrigatórios fizessem cascata-exclusão para uma mesma tabela, criar o esquema falha com `Introducing FOREIGN KEY constraint '...' on table '...' may cause cycles or multiple cascade paths`. A correção aí é tornar um relacionamento opcional, ou definir um como `ClientCascade` para que o EF Core (não o SQL Server) cuide daquela parte da cascata com os filhos carregados. SQLite e PostgreSQL não têm essa restrição.

## Variantes que caem neste mesmo erro

### Hierarquias auto-referenciadas (tabelas em árvore)

Uma `Category` com um `ParentId` anulável apontando de volta para `Category` esbarra nisso constantemente. Excluir uma categoria pai cujos filhos não estão carregados falha na verificação de FK. Como o SQL Server proíbe uma cascata auto-referenciada que poderia formar ciclo, em geral você não pode confiar em `ON DELETE CASCADE` aqui de jeito nenhum; carregue a subárvore e deixe o EF Core excluí-la, ou exclua de baixo para cima com `ExecuteDelete`.

### Linhas de junção de muitos-para-muitos

Com uma navegação de salto (`Blog` tem muitas `Tag` através de uma tabela de junção implícita), excluir um `Blog` exige que as linhas de junção saiam primeiro. O EF Core lida com isso automaticamente quando o blog é carregado com suas `Tags`, mas um `Remove` simples sem carregar a navegação deixa as linhas de junção órfãs e a exclusão falha. Ou carregue a navegação de salto ou use `ExecuteDelete` nas linhas de junção. A mecânica das entidades de junção é abordada em [como semear um relacionamento de muitos-para-muitos no EF Core 11](/pt-br/2026/06/how-to-seed-a-many-to-many-relationship-in-ef-core-11/).

### "Funcionou no provedor in-memory"

O banco de dados in-memory do EF Core não impõe chaves estrangeiras nem exclusões em cascata, então uma exclusão que "passa" em um teste de unidade pode falhar contra um banco de dados SQLite ou SQL Server real. Esta é uma das várias razões pelas quais o provedor in-memory é um substituto ruim para o comportamento relacional; prefira o SQLite in-memory ou um banco de dados real para testes do caminho de exclusão. Veja [como simular o DbContext sem quebrar o rastreamento de mudanças](/pt-br/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) para padrões de teste cientes do rastreamento, e observe que as regras de ajuste de relacionamento aqui interagem com [AsNoTracking vs AsNoTrackingWithIdentityResolution](/pt-br/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/): uma consulta sem rastreamento não permitirá que o EF Core faça cascata em memória, porque não há nada rastreado para colocar em cascata.

### O erro só dispara após uma atualização

Se uma exclusão que costumava funcionar começa a lançar erro depois de mudar as versões do runtime ou do provedor, verifique se um `DeleteBehavior` padrão ou uma nulabilidade de FK mudou no snapshot do seu modelo. A superfície de mudanças que quebram compatibilidade está catalogada em [migrando do EF Core 6 para o EF Core 11](/pt-br/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/); compare suas migrações geradas para ver se a cláusula de cascata se moveu.

### A exclusão está dentro de uma estratégia de execução com novas tentativas

Se você envolver a exclusão em uma transação manual enquanto usa `EnableRetryOnFailure`, você pode obter uma exceção *diferente* que mascara esta. Essa interação é um erro próprio, abordado em [the execution strategy does not support user-initiated transactions](/pt-br/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/).

## Confirmando a correção

Reproduza a exclusão contra o provedor real, não o in-memory, e observe o SQL gerado. Ative o log sensível em desenvolvimento para que os valores dos parâmetros e a ordem das instruções fiquem visíveis:

```csharp
// .NET 11, EF Core 11.0.0 -- dev only; never enable sensitive logging in production
var options = new DbContextOptionsBuilder<AppDb>()
    .UseSqlite("Data Source=app.db")
    .LogTo(Console.WriteLine, LogLevel.Information)
    .EnableSensitiveDataLogging()
    .Options;
```

Se a correção funcionou, você verá ou `DELETE FROM Posts ...` antes de `DELETE FROM Blogs ...` (Correção 1 ou Correção 3) ou `UPDATE Posts SET BlogId = NULL ...` antes da exclusão do blog (Correção 2). Se você ainda vir um `DELETE FROM Blogs ...` sozinho seguido da exceção, os dependentes não foram nem carregados nem tratados pelo banco de dados, e você aplicou a configuração ao modelo mas não ao esquema ativo. Execute novamente `dotnet ef database update` e verifique de novo `pragma_foreign_key_list`.

O modelo mental que vale a pena manter: este erro é o banco de dados pedindo que você decida o destino dos filhos antes de excluir o pai. Exclua-os junto com ele (cascata), mantenha-os e corte o vínculo (set null), ou traga-os para o contexto para que o EF Core possa decidir linha por linha. O erro não é o EF Core sendo difícil; é a integridade referencial fazendo exatamente o seu trabalho.

## Fontes

- [Cascade Delete](https://learn.microsoft.com/en-us/ef/core/saving/cascade-delete), documentação do EF Core, sobre `DeleteBehavior`, padrões obrigatório vs opcional, e as tabelas de comportamento carregado-vs-não-carregado.
- [Relationships](https://learn.microsoft.com/en-us/ef/core/modeling/relationships), documentação do EF Core, sobre como relacionamentos obrigatórios e opcionais são inferidos a partir da nulabilidade da FK.
- [Microsoft.Data.Sqlite foreign keys](https://learn.microsoft.com/en-us/dotnet/standard/data/sqlite/foreign-keys), sobre a imposição de `PRAGMA foreign_keys`.
- [SQLite result and error codes](https://www.sqlite.org/rescode.html), sobre `SQLITE_CONSTRAINT_FOREIGNKEY` (código estendido 787).
