---
title: "Como implementar concorrência otimista com um token rowversion no EF Core 11"
description: "Adicione um token de concorrência rowversion no EF Core 11: a configuração com [Timestamp] e IsRowVersion, o SQL que o EF realmente emite, como capturar DbUpdateConcurrencyException, banco vence vs cliente vence vs mesclagem, APIs desconectadas com ETags e as cinco armadilhas que desativam tudo silenciosamente."
pubDate: 2026-08-03
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "concurrency"
  - "rowversion"
  - "sql-server"
  - "dotnet-11"
  - "how-to"
lang: "pt-br"
translationOf: "2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-08-03
---

Resposta curta: coloque uma propriedade `byte[]` na entidade, marque com `[Timestamp]` (ou chame `.IsRowVersion()` no `OnModelCreating`), e o EF Core 11 a mapeia para uma coluna `rowversion` do SQL Server e adiciona `AND [RowVersion] = @original` a todo UPDATE e DELETE que gera para aquela entidade. Quando outra pessoa alterou a linha nesse meio-tempo, o comando afeta zero linhas e o `SaveChangesAsync` lança `DbUpdateConcurrencyException`, que você captura e resolve. O recurso inteiro são cerca de seis linhas de configuração. O difícil são as cinco maneiras de desligá-lo acidentalmente sem receber erro nenhum.

Este artigo cobre a configuração, o SQL e o texto exato da exceção, as três estratégias de resolução, a ida e volta desconectada de uma API web que a maioria dos tutoriais pula, e as armadilhas que deixam você com um token que não protege nada.

Uma nota sobre como os detalhes abaixo foram verificados. O EF Core 11 exige o runtime do .NET 11, e o único SDK nesta máquina é o .NET 10.0.201, então os experimentos executáveis foram feitos com `Microsoft.EntityFrameworkCore` 10.0.10 contra SQLite, mais o gerador de DDL do provedor do SQL Server (que roda offline, sem servidor). A API do token de concorrência e o formato do SQL gerado não mudaram entre o EF Core 8 e o 11: as [notas de versão do EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) não listam mudanças em tokens de concorrência, na detecção de conflitos do `SaveChanges` nem no `DbUpdateConcurrencyException`. Tudo que é específico do EF Core 11 está sinalizado como tal.

## O que uma coluna rowversion realmente é

`rowversion` é um tipo de dado do SQL Server, não um conceito do EF Core. Segundo a [documentação do rowversion](https://learn.microsoft.com/en-us/sql/t-sql/data-types/rowversion-transact-sql), são 8 bytes de dados binários únicos gerados automaticamente. Três propriedades importam para trabalhar com concorrência:

- **É um contador, não um relógio.** Não preserva data nem hora. Cada banco de dados tem um único contador que é incrementado a cada inserção ou atualização em qualquer tabela que contenha uma coluna `rowversion`. Duas linhas em tabelas diferentes nunca compartilham um valor, mas você não pode subtrair dois valores e obter um tempo decorrido.
- **Uma tabela pode ter exatamente uma.** É por isso que um token rowversion protege a linha inteira, nunca um subconjunto de colunas.
- **Qualquer UPDATE o incrementa, inclusive um sem efeito.** A documentação é explícita: atribuir a uma coluna o valor que ela já tem conta como atualização e incrementa a versão. Um "salvamento" que não muda nada mesmo assim invalida o token de todos os outros leitores.

`timestamp` é um sinônimo obsoleto do mesmo tipo. Use `rowversion` no DDL. De forma confusa, o atributo do EF Core continua se chamando `[Timestamp]`, porque é anterior à renomeação.

## A configuração, em quatro passos

1. **Adicione uma propriedade `byte[]` à entidade.** O tipo CLR precisa ser `byte[]` para que o provedor do SQL Server a mapeie para `rowversion`. Dê o nome que quiser; `RowVersion` e `Version` são as escolhas comuns.
2. **Marque como versão de linha.** Ou `[Timestamp]` como data annotation, ou `.Property(p => p.RowVersion).IsRowVersion()` no `OnModelCreating`. As duas são equivalentes.
3. **Adicione uma migração e aplique.** O EF emite `[RowVersion] rowversion NOT NULL`, e o SQL Server preenche cada linha existente na próxima atualização dela.
4. **Capture `DbUpdateConcurrencyException` em todo ponto de chamada que salva aquela entidade.** Sem este passo você apenas trocou uma atualização perdida silenciosa por uma resposta 500, o que é melhor, mas não muito.

Aqui está a entidade, das duas formas:

```csharp
// .NET 11, C# 14, Microsoft.EntityFrameworkCore.SqlServer 11.0.0
public class Product
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public decimal Price { get; set; }

    [Timestamp]
    public byte[] RowVersion { get; set; } = default!;
}
```

```csharp
// Fluent equivalent, no attribute needed on the entity
protected override void OnModelCreating(ModelBuilder modelBuilder)
    => modelBuilder.Entity<Product>()
        .Property(p => p.RowVersion)
        .IsRowVersion();
```

Rodar o gerador de script de criação do provedor do SQL Server sobre esse modelo produz:

```sql
CREATE TABLE [Products] (
    [Id] int NOT NULL IDENTITY,
    [Name] nvarchar(max) NOT NULL,
    [Price] decimal(18,2) NOT NULL,
    [RowVersion] rowversion NOT NULL,
    CONSTRAINT [PK_Products] PRIMARY KEY ([Id])
);
```

O interessante não é o DDL, são os metadados do modelo que o EF deriva dele. Despejar o `IProperty` dessa coluna dá `colType=rowversion`, `IsConcurrencyToken=True`, `ValueGenerated=OnAddOrUpdate`. Esse último sinalizador é o que se deve lembrar: o EF Core nunca vai escrever um valor nesta coluna. Ele a exclui do INSERT e do UPDATE, e lê o novo valor depois. O banco de dados é dono dela por completo.

## O SQL que o EF Core emite, e a exceção quando falha

Uma vez que a propriedade é um token de concorrência, todo UPDATE que o EF gera para a entidade carrega o valor original na cláusula `WHERE`, ao lado da chave. No SQLite, com um token gerenciado pela aplicação, o formato é exatamente este (capturado com `LogTo` filtrado para `RelationalEventId.CommandExecuted`):

```sql
UPDATE "Products" SET "Price" = @p0, "Version" = @p1
WHERE "Id" = @p2 AND "Version" = @p3
RETURNING 1;
```

No SQL Server o comando também precisa reler o `rowversion` regenerado, já que a coluna é `ValueGenerated.OnAddOrUpdate`. O formato documentado no [tutorial de concorrência com Razor Pages](https://learn.microsoft.com/en-us/aspnet/core/data/ef-rp/concurrency) combina o UPDATE protegido com um SELECT condicionado por `@@ROWCOUNT`:

```sql
SET NOCOUNT ON;
UPDATE [Products] SET [Price] = @p0
WHERE [Id] = @p1 AND [RowVersion] = @p2;
SELECT [RowVersion]
FROM [Products]
WHERE @@ROWCOUNT = 1 AND [Id] = @p1;
```

O formato exato do comando mudou entre versões do EF Core e entre provedores, e vai continuar mudando. O que é estável, e o que você deveria verificar em um teste, é a semântica: o token aparece no `WHERE`, e um resultado de zero linhas vira uma exceção.

Se outra pessoa alterou a linha depois que você a carregou, o predicado não encontra nada, voltam zero linhas e o EF lança a exceção. Vale a pena memorizar a mensagem porque é o que você vai procurar nos seus logs:

```text
The database operation was expected to affect 1 row(s), but actually affected
0 row(s); data may have been modified or deleted since entities were loaded.
```

Duas coisas que as pessoas erram sobre quando isso dispara. Primeiro, é lançada em atualizações *e* exclusões, mas praticamente nunca em inserções. Uma inserção duplicada produz uma exceção de restrição de unicidade específica do provedor. Segundo, "afetou 0 linhas" não distingue "alguém alterou" de "alguém excluiu". Isso você precisa descobrir durante a resolução.

Se o SQL acima não se parece com o que sua aplicação está enviando, o jeito mais rápido de descobrir o que ela *está* enviando é [registrar o SQL que o EF Core 11 gera](/pt-br/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) e ler a cláusula `WHERE` diretamente. Um `AND [RowVersion] = ...` ausente significa que o token não está configurado no caminho que você imagina.

## Resolvendo o conflito: três estratégias, um laço

`DbUpdateConcurrencyException` expõe `Entries`, a lista de objetos `EntityEntry` cujos comandos voltaram com a contagem de linhas errada. Cada entrada te dá três conjuntos de valores:

- `CurrentValues`: o que você tentou escrever.
- `OriginalValues`: o que você leu, antes das suas edições. É aqui que vive o token obsoleto.
- `GetDatabaseValuesAsync()`: o que está no banco de dados agora, consultado de novo.

Toda estratégia de resolução é uma regra para combinar esses três, seguida de atualizar `OriginalValues` para que a cláusula `WHERE` da nova tentativa use o token atual.

**Banco vence** é a mais simples e o padrão correto para qualquer coisa que um humano esteja olhando: descarte a tentativa, recarregue, avise o usuário. `entry.ReloadAsync()` faz isso em uma chamada.

**Cliente vence** sobrescreve o que quer que tenha chegado no meio do caminho. Correto apenas quando sua escrita é autoritativa (uma sobreposição administrativa, o replay de um evento canônico), e um erro genuíno em todos os outros casos:

```csharp
// .NET 11, C# 14, EF Core 11
catch (DbUpdateConcurrencyException ex)
{
    foreach (var entry in ex.Entries)
    {
        var databaseValues = await entry.GetDatabaseValuesAsync();
        if (databaseValues is null)
        {
            // The row is gone. There is nothing to overwrite.
            throw new InvalidOperationException("Product was deleted by another user.");
        }

        // Keep CurrentValues as-is, but adopt the database's token so the
        // retried UPDATE targets the row as it exists now.
        entry.OriginalValues.SetValues(databaseValues);
    }

    await context.SaveChangesAsync();
}
```

**Mesclagem** é a versão que vale a pena escrever quando a entidade tem campos independentes. Pegue o valor do banco para qualquer propriedade que você não tocou, mantenha o seu para as que tocou, e escale apenas em uma sobreposição real:

```csharp
// .NET 11, C# 14, EF Core 11
var saved = false;
while (!saved)
{
    try
    {
        await context.SaveChangesAsync();
        saved = true;
    }
    catch (DbUpdateConcurrencyException ex)
    {
        foreach (var entry in ex.Entries)
        {
            if (entry.Entity is not Product)
            {
                throw new NotSupportedException(
                    $"No conflict policy for {entry.Metadata.Name}.");
            }

            var proposed = entry.CurrentValues;
            var database = await entry.GetDatabaseValuesAsync()
                ?? throw new InvalidOperationException("Row was deleted.");
            var original = entry.OriginalValues;

            foreach (var property in proposed.Properties)
            {
                // Skip the token itself: it is byte[], so Equals compares
                // references, and it is refreshed wholesale below anyway.
                if (property.IsConcurrencyToken) continue;

                var mine = proposed[property];
                var theirs = database[property];
                var wasLoaded = original[property];

                // I did not touch this column: take theirs.
                if (Equals(mine, wasLoaded))
                {
                    proposed[property] = theirs;
                }
                // Both of us changed it to different values: real conflict.
                else if (!Equals(theirs, wasLoaded) && !Equals(mine, theirs))
                {
                    throw new InvalidOperationException(
                        $"Conflicting edits to {property.Name}.");
                }
            }

            entry.OriginalValues.SetValues(database);
        }
    }
}
```

Esse laço `while (!saved)` é o formato que a [documentação de concorrência do EF Core](https://learn.microsoft.com/en-us/ef/core/saving/concurrency) recomenda, e é um laço de verdade: sua nova tentativa pode perder a corrida uma segunda vez. Coloque um limite de tentativas em produção, porque uma repetição sem limite contra uma linha muito disputada é um livelock.

Uma interação para ficar de olho: se você habilitou `EnableRetryOnFailure`, a repetição acontece dentro de um `SqlServerRetryingExecutionStrategy`, e envolver este laço em um `BeginTransaction` manual vai falhar com o erro descrito em [a estratégia de execução não suporta transações iniciadas pelo usuário](/pt-br/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/). Use `strategy.ExecuteAsync(...)` em volta de toda a unidade de trabalho.

## A ida e volta desconectada, que é onde isso costuma dar errado

O exemplo de contexto único acima não é o que sua API faz. Sua API carrega um produto em uma requisição, entrega ao navegador e recebe uma edição dez minutos depois em um `DbContext` completamente diferente. O token precisa sobreviver a essa viagem.

`byte[]` é serializado como base64 no `System.Text.Json`, então passá-lo por um DTO funciona sem nenhum tratamento especial. O formato HTTP idiomático é um ETag: devolva o token em base64 como cabeçalho de resposta `ETag` no GET, exija como `If-Match` no PUT, e responda `412 Precondition Failed` quando não bater.

Do lado da escrita, a linha crucial é definir `OriginalValue` explicitamente. O EF não tem como saber como a linha estava quando o cliente a leu, então você precisa contar:

```csharp
// .NET 11, C# 14, EF Core 11
app.MapPut("/products/{id:int}", async (
    int id, ProductDto dto, [FromHeader(Name = "If-Match")] string? ifMatch,
    AppDbContext db) =>
{
    if (string.IsNullOrEmpty(ifMatch)) return Results.BadRequest("If-Match required.");

    var product = await db.Products.FindAsync(id);
    if (product is null) return Results.NotFound();

    product.Name = dto.Name;
    product.Price = dto.Price;

    // Overwrite the token EF loaded with the one the client actually saw.
    db.Entry(product).Property(p => p.RowVersion).OriginalValue =
        Convert.FromBase64String(ifMatch.Trim('"'));

    try
    {
        await db.SaveChangesAsync();
        return Results.Ok(new { eTag = Convert.ToBase64String(product.RowVersion) });
    }
    catch (DbUpdateConcurrencyException)
    {
        return Results.StatusCode(StatusCodes.Status412PreconditionFailed);
    }
});
```

Note que isso consulta a linha primeiro, de propósito. Você pode pular a consulta com `Attach` mais `EntityState.Modified`, o que economiza uma viagem, mas aí toda coluna é escrita tendo mudado ou não. Verifiquei que os dois caminhos se comportam de forma idêntica em relação ao token: na reprodução com SQLite, definir `OriginalValue` em uma entidade anexada e nunca consultada produziu a mesma cláusula `WHERE` protegida pelo token que o caminho que consulta primeiro, e salvou sem problemas.

## Cinco maneiras de desativar silenciosamente seu token de concorrência

**Esquecer de carregar o token original.** Se uma entidade desconectada chega com um token padrão ou vazio e você chama `context.Update(entity)`, o EF pega o valor que está *no objeto* como o original. O SQL emitido vira `WHERE "Id" = @p3 AND "Version" = @p4` com um `@p4` todo zerado, que não bate com nada, e absolutamente todo salvamento lança `DbUpdateConcurrencyException`. Reproduzi exatamente isso no EF Core 10.0.10. O modo de falha é barulhento, o que é sorte, porque o erro oposto é silencioso.

**Usar um provedor que não tem rowversion.** Esse não dá erro nenhum. No SQLite, `[Timestamp]` sobre um `byte[]` produz uma coluna `BLOB NULL` marcada como `IsConcurrencyToken=True`, `ValueGenerated=OnAddOrUpdate`. O EF portanto nunca a escreve, o SQLite nunca a gera, e o valor fica `null` para sempre. O UPDATE gerado degenera para:

```sql
UPDATE "Products" SET "Price" = @p0
WHERE "Id" = @p1 AND "RowVersion" IS NULL
RETURNING "RowVersion";
```

`IS NULL` bate sempre. Você fica com uma coluna em formato de token, zero proteção e nenhum aviso. Verificado no EF Core 10.0.10 com `Microsoft.EntityFrameworkCore.Sqlite`. Se seus testes de integração rodam em SQLite enquanto produção roda em SQL Server, seus testes de concorrência estão passando pelo motivo errado.

A correção para provedores sem uma coluna nativa que se atualize sozinha é um token gerenciado pela aplicação: um `Guid` marcado com `[ConcurrencyCheck]` (ou `.IsConcurrencyToken()`), que você mesmo atribui a cada salvamento. O PostgreSQL é a exceção que não precisa de nenhum dos dois: o Npgsql mapeia uma propriedade `uint` marcada com `[Timestamp]` ou configurada com `.IsRowVersion()` para a coluna de sistema `xmin`, que o motor atualiza automaticamente.

**Colocar `[Timestamp]` no tipo CLR errado.** O EF Core não valida isso na construção do modelo. Coloquei `[Timestamp]` em um `long` e o provedor do SQL Server alegremente emitiu `[RowVersion] bigint NOT NULL` com `IsConcurrencyToken=True` e `ValueGenerated=OnAddOrUpdate`. O SQL Server não mantém colunas `bigint` comuns, e o EF foi instruído a não escrevê-las, então nada nunca move esse valor. Só `byte[]` mapeia para o tipo `rowversion` de verdade.

**Escrever via `ExecuteUpdate` ou `ExecuteDelete`.** Eles ignoram por completo o rastreamento de mudanças, e junto com ele a verificação de concorrência. O SQL que emitem contém apenas o seu predicado:

```sql
UPDATE "Products" AS "p"
SET "Price" = ef_add("p"."Price", '1.0')
WHERE "p"."Name" = 'B'
```

Sem token, sem exceção, uma linha afetada. Se você quer concorrência otimista em um caminho em massa, precisa fazer na mão: coloque o token no `Where` e compare a contagem de linhas afetadas retornada com o que você esperava. Esse trade-off, e quando cada caminho de escrita é o certo, é o assunto de [ExecuteUpdate vs carregar entidades e SaveChanges](/pt-br/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/).

**Comparar tokens com `==` em C#.** `byte[]` usa igualdade por referência. Dois arrays com bytes idênticos não são iguais. Use `SequenceEqual`, ou compare as strings base64, sempre que precisar checar um token em código de aplicação. O próprio EF compara em SQL, então isso só morde na sua lógica de validação.

## Quando um token de linha inteira é grosseiro demais

Um `rowversion` protege a linha inteira. Dois usuários editando campos genuinamente independentes do mesmo registro (um corrige um erro de digitação na descrição, o outro ajusta a quantidade em estoque) colidem, mesmo que nada esteja de fato em conflito. Em um registro muito disputado isso vira um fluxo de 412 espúrios.

Duas saídas. Use a estratégia de mesclagem acima para que os conflitos falsos se resolvam automaticamente e só as sobreposições reais apareçam. Ou desça para um token gerenciado pela aplicação que você regenera apenas quando mudam as propriedades que importam, algo que pode ser centralizado em um interceptor de `SaveChanges` do tipo descrito em [interceptores do EF Core 11 para auditoria](/pt-br/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/). O custo da segunda opção é que agora você é dono da decisão "essa mudança importa?", para sempre, para cada propriedade que adicionar.

A alternativa de nível mais alto é um nível de isolamento de transação. Snapshot no SQL Server, ou repeatable read no PostgreSQL, levanta um erro de serialização quando a escrita da sua transação conflita com uma já confirmada, sem token nenhum no modelo. É mais simples, e é a ferramenta errada no instante em que existe um humano no meio, porque a transação teria que ficar aberta durante o tempo de reflexão do usuário. Tokens de concorrência existem justamente para que a "transação" possa abranger uma ida e volta HTTP e uma pausa para o café.

## Relacionados

- [ExecuteUpdate vs carregar entidades e SaveChanges no EF Core](/pt-br/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/)
- [Como registrar o SQL que o EF Core 11 gera](/pt-br/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [Como usar interceptores do EF Core 11 para auditoria](/pt-br/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/)
- [Fix: a estratégia de execução não suporta transações iniciadas pelo usuário](/pt-br/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/)
- [Fix: a instância do tipo de entidade não pode ser rastreada porque outra instância com o mesmo valor de chave já está sendo rastreada](/pt-br/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/)

## Fontes

- [Handling concurrency conflicts](https://learn.microsoft.com/en-us/ef/core/saving/concurrency) no Microsoft Learn, para a semântica do token, os três conjuntos de valores e o laço de repetição.
- [rowversion (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/data-types/rowversion-transact-sql) para o contador de 8 bytes, a regra de um por tabela, o comportamento do UPDATE sem efeito e a obsolescência de `timestamp`.
- [Disconnected entities](https://learn.microsoft.com/en-us/ef/core/saving/disconnected-entities) para `Update` versus `Attach` e `CurrentValues.SetValues`.
- [What's new in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew), que confirma que o EF11 exige o runtime do .NET 11 e não lista mudanças em tokens de concorrência.
- [Npgsql concurrency tokens](https://www.npgsql.org/efcore/modeling/concurrency.html) para o mapeamento de `xmin` no PostgreSQL.
