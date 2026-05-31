---
title: "Como usar ExecuteUpdate e ExecuteDelete para escritas em massa no EF Core 11"
description: "Um guia completo de ExecuteUpdate e ExecuteDelete no EF Core 11: o SQL que eles geram, a armadilha do rastreador de mudanças que sobrescreve sua escrita em massa silenciosamente, transações, controle de concorrência com a contagem de linhas afetadas e os setters por delegate do EF Core 10 que permitem montar atualizações condicionais com simples instruções if."
pubDate: 2026-05-31
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "csharp"
  - "dotnet-11"
  - "performance"
  - "how-to"
lang: "pt-br"
translationOf: "2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-05-31
---

Resposta curta: para atualizar ou excluir muitas linhas em uma única instrução SQL, escreva um `Where` do LINQ para escolher as linhas e então chame `ExecuteUpdateAsync` ou `ExecuteDeleteAsync` sobre a consulta resultante. O EF Core 11 traduz tudo em um único `UPDATE` ou `DELETE` que roda no banco de dados, sem carregar entidades, sem rastreador de mudanças e sem `SaveChanges`. Ambos os métodos executam imediatamente e retornam o número de linhas afetadas. A armadilha que pega todo mundo: como esses métodos nunca tocam no rastreador de mudanças, qualquer entidade que você já tenha carregado mantém seu valor desatualizado, e um `SaveChanges` posterior vai alegremente sobrescrever sua escrita em massa.

Este artigo cobre `ExecuteUpdate` e `ExecuteDelete` no `Microsoft.EntityFrameworkCore` 11.0.0 sobre .NET 11 contra o SQL Server 2025: o SQL exato que eles geram, atualizações de várias propriedades, como referenciar o valor de coluna existente, a armadilha do rastreamento de mudanças e como desviá-la, a semântica das transações, como implementar sua própria concorrência otimista com a contagem de linhas afetadas, os setters condicionais por delegate que chegaram no EF Core 10 e as limitações que te levam de volta ao `SaveChanges`. As APIs relacionais são idênticas no PostgreSQL e SQLite; só o dialeto SQL gerado difere.

## Por que o laço de SaveChanges é a ferramenta errada para escritas em massa

A forma ingênua de fazer um soft delete de cada blog com nota baixa parece razoável até você observar o SQL:

```csharp
// .NET 11, EF Core 11.0.0 - the slow way
await foreach (var blog in context.Blogs.Where(b => b.Rating < 3).AsAsyncEnumerable())
{
    context.Blogs.Remove(blog);
}

await context.SaveChangesAsync();
```

Isso consulta cada linha correspondente pela rede, materializa cada uma em uma entidade rastreada, marca como `Deleted` no rastreador de mudanças e então, no `SaveChanges`, emite um `DELETE` por linha. Se 50.000 blogs corresponderem, isso é um grande `SELECT`, 50.000 alocações e 50.000 instruções `DELETE` (agrupadas em lotes, mas ainda parametrizadas individualmente). O banco de dados faz um trabalho enorme para uma operação que conceitualmente é uma única instrução baseada em conjuntos.

`ExecuteDelete` reduz tudo isso a uma única ida e volta:

```csharp
// .NET 11, EF Core 11.0.0
int deleted = await context.Blogs
    .Where(b => b.Rating < 3)
    .ExecuteDeleteAsync();
```

O EF Core 11 traduz o predicado do LINQ para SQL exatamente como faria para uma consulta, mas emite um `DELETE` em vez de um `SELECT`:

```sql
DELETE FROM [b]
FROM [Blogs] AS [b]
WHERE [b].[Rating] < 3
```

Nada é carregado, nada é rastreado e `deleted` contém a contagem de linhas. Você pode colocar qualquer LINQ traduzível no `Where`, incluindo joins e subconsultas, igual a como faria ao selecionar as linhas.

## Atualizar no lugar com ExecuteUpdate

`ExecuteUpdate` é o irmão do `UPDATE`. Em vez de excluir os blogs com nota baixa, oculte-os:

```csharp
// .NET 11, EF Core 11.0.0
await context.Blogs
    .Where(b => b.Rating < 3)
    .ExecuteUpdateAsync(setters => setters.SetProperty(b => b.IsVisible, false));
```

O `Where` seleciona as linhas; a chamada a `SetProperty` diz qual coluna muda e para qual valor. O EF Core 11 emite:

```sql
UPDATE [b]
SET [b].[IsVisible] = CAST(0 AS bit)
FROM [Blogs] AS [b]
WHERE [b].[Rating] < 3
```

Para mudar várias colunas de uma vez, encadeie chamadas a `SetProperty`. Todas caem em uma única instrução:

```csharp
// .NET 11, EF Core 11.0.0
await context.Blogs
    .Where(b => b.Rating < 3)
    .ExecuteUpdateAsync(setters => setters
        .SetProperty(b => b.IsVisible, false)
        .SetProperty(b => b.Rating, 0));
```

```sql
UPDATE [b]
SET [b].[Rating] = 0,
    [b].[IsVisible] = CAST(0 AS bit)
FROM [Blogs] AS [b]
WHERE [b].[Rating] < 3
```

### Calcular o novo valor a partir do antigo

O segundo argumento de `SetProperty` não precisa ser uma constante. Passe um lambda e você recebe a linha atual, então pode calcular o novo valor a partir das colunas existentes. Para aumentar em um cada nota correspondente:

```csharp
// .NET 11, EF Core 11.0.0
await context.Blogs
    .Where(b => b.Rating < 3)
    .ExecuteUpdateAsync(setters =>
        setters.SetProperty(b => b.Rating, b => b.Rating + 1));
```

Dentro desse lambda, `b.Rating` é o valor de coluna anterior à atualização, e o EF Core traduz toda a expressão para SQL para que a aritmética aconteça no banco de dados, de forma atômica, sem condição de corrida de ler-modificar-escrever:

```sql
UPDATE [b]
SET [b].[Rating] = [b].[Rating] + 1
FROM [Blogs] AS [b]
WHERE [b].[Rating] < 3
```

Esse é o padrão que você quer para contadores, saldos e carimbos de versão. Fazer isso através do `SaveChanges` significa carregar a linha, mutá-la em memória e salvar, o que abre uma janela na qual outra transação pode mudar a mesma linha entre sua leitura e sua escrita. O `UPDATE` baseado em conjuntos não tem essa janela.

## A armadilha do rastreador de mudanças que engole sua escrita silenciosamente

Aqui vai a coisa mais importante a internalizar sobre ambos os métodos: eles surtem efeito imediatamente e não têm nenhuma interação com o rastreador de mudanças do EF. Essa é a fonte da velocidade deles, e também a fonte do único bug que todo mundo comete pelo menos uma vez.

Percorra esta sequência com atenção:

```csharp
// .NET 11, EF Core 11.0.0
// 1. Tracking query: this Blog is now tracked, Rating == 5 in memory.
var blog = await context.Blogs.SingleAsync(b => b.Name == "SomeBlog");

// 2. Bump every blog's rating by one in the database. Runs now.
await context.Blogs
    .ExecuteUpdateAsync(setters => setters.SetProperty(b => b.Rating, b => b.Rating + 1));

// 3. Mutate the tracked instance in memory.
blog.Rating += 2;

// 4. Persist tracked changes.
await context.SaveChangesAsync();
```

Após o passo 2, a linha do banco de dados vale `6`. Mas a instância rastreada ainda acredita que o valor original é `5`, porque `ExecuteUpdate` nunca disse nada ao rastreador de mudanças. O passo 3 fixa o valor em memória em `7`. Quando `SaveChanges` roda no passo 4, o EF compara o valor atual `7` com o *original* que registrou no passo 1 (`5`), decide que a propriedade mudou e escreve `7`. Seu `+1` em massa desaparece, sobrescrito por um `SaveChanges` que nunca soube que aconteceu.

A orientação oficial da [documentação de ExecuteUpdate e ExecuteDelete do EF Core](https://learn.microsoft.com/en-us/ef/core/saving/execute-insert-update-delete) é direta: evite misturar modificações rastreadas de `SaveChanges` com modificações não rastreadas via `ExecuteUpdate`/`ExecuteDelete` sobre as mesmas entidades na mesma unidade de trabalho. Na prática há duas formas limpas de evitar problemas:

1. Rode a escrita em massa contra um contexto cuja consulta dessas linhas tenha usado `AsNoTracking()`, de modo que nada rastreado possa ficar desatualizado.
2. Se você precisar ler entidades, rode a escrita em massa e então chame `context.ChangeTracker.Clear()` antes de consultar de novo, para que a próxima leitura seja repovoada a partir do banco de dados com valores frescos.

```csharp
// .NET 11, EF Core 11.0.0 - re-read fresh after a bulk write
await context.Blogs
    .Where(b => b.Rating < 3)
    .ExecuteUpdateAsync(s => s.SetProperty(b => b.IsVisible, false));

context.ChangeTracker.Clear();

var hidden = await context.Blogs
    .AsNoTracking()
    .Where(b => !b.IsVisible)
    .ToListAsync();
```

O modelo mental mais limpo: trate `ExecuteUpdate`/`ExecuteDelete` como se pertencessem a uma camada de acesso a dados distinta e de mais baixo nível que por acaso compartilha seu `DbContext`. Eles falam SQL, não entidades. É o mesmo limite que você respeita quando [faz mock de um DbContext sem quebrar o rastreamento de mudanças](/pt-br/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/): o rastreador de mudanças é algo com estado em memória, e escritas por canal lateral não o atualizam.

## Transações: nada é implícito

Nenhum dos dois métodos abre uma transação para você. Cada chamada é a sua própria ida e volta e, a menos que você a envolva, a sua própria transação implícita. Esta sequência são quatro transações separadas:

```csharp
// .NET 11, EF Core 11.0.0 - four independent transactions, NOT atomic
await context.Blogs.ExecuteUpdateAsync(/* update A */);
await context.Blogs.ExecuteUpdateAsync(/* update B */);

var blog = await context.Blogs.SingleAsync(b => b.Name == "SomeBlog");
blog.Rating += 2;
await context.SaveChangesAsync();
```

Se a atualização B lançar uma exceção, a atualização A já está confirmada. Não há rollback, porque nunca houve uma transação compartilhada. Quando duas ou mais escritas em massa precisam ter sucesso ou falhar juntas, inicie uma transação explícita sobre o [DatabaseFacade](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.infrastructure.databasefacade):

```csharp
// .NET 11, EF Core 11.0.0 - one atomic unit
await using var tx = await context.Database.BeginTransactionAsync();

await context.Blogs
    .Where(b => b.Rating < 0)
    .ExecuteUpdateAsync(s => s.SetProperty(b => b.Rating, 0));

await context.Posts
    .Where(p => p.IsOrphaned)
    .ExecuteDeleteAsync();

await tx.CommitAsync();
```

Agora ambas as instruções compartilham uma transação e fazem rollback juntas em caso de falha. Se uma delas rodar contra uma tabela lenta e você esbarrar em uma [SqlException: Timeout expired](/pt-br/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/), a transação explícita é também o lugar onde você definiria um tempo limite de comando maior para o lote.

## Implemente seu próprio controle de concorrência com a contagem de linhas

`SaveChanges` te dá concorrência otimista de graça por meio de tokens de concorrência: adiciona o token à cláusula `WHERE` e lança `DbUpdateConcurrencyException` se nenhuma linha corresponder. `ExecuteUpdate` e `ExecuteDelete` não tocam no rastreador de mudanças, então não conseguem fazer isso automaticamente. Em vez disso, eles te dão a matéria-prima: a contagem de linhas afetadas.

Coloque o token de concorrência no seu próprio `Where` e inspecione o valor retornado:

```csharp
// .NET 11, EF Core 11.0.0 - hand-rolled optimistic concurrency
int updated = await context.Blogs
    .Where(b => b.Id == id && b.Version == expectedVersion)
    .ExecuteUpdateAsync(setters => setters
        .SetProperty(b => b.Title, newTitle)
        .SetProperty(b => b.Version, b => b.Version + 1));

if (updated == 0)
{
    // Either the row is gone or someone else bumped Version first.
    throw new DbUpdateConcurrencyException("Blog was modified concurrently.");
}
```

Como a verificação de `Version` faz parte do `WHERE` do SQL, a comparação e a escrita são uma única instrução atômica. Nenhuma linha corresponde se outra transação já incrementou `Version`, `updated` volta como `0` e você reage. Isso costuma ser *mais rápido* que o caminho rastreado para atualizações de uma única linha em endpoints muito movimentados, e compõe bem com os padrões do lado de leitura em [consultas compiladas para caminhos quentes](/pt-br/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/).

## Setters condicionais sem árvores de expressão (EF Core 10 e posteriores)

Antes do EF Core 10, o argumento dos setters era uma árvore de expressão, o que tornava dolorosas as atualizações dinâmicas: você não podia colocar uma instrução `if` no meio de uma cadeia fluente, então atualizações condicionais significavam ramificar a chamada inteira ou montar árvores de expressão à mão. A partir do EF Core 10, e herdado no EF Core 11, há uma sobrecarga cujo argumento de setters é um delegate comum com corpo de instruções. Você pode usar o fluxo de controle normal do C#:

```csharp
// .NET 11, EF Core 11.0.0 - conditional setters with normal control flow
await context.Blogs
    .Where(b => b.Id == id)
    .ExecuteUpdateAsync(setters =>
    {
        setters.SetProperty(b => b.Title, newTitle);

        if (rankChanged)
        {
            setters.SetProperty(b => b.Rating, newRating);
        }

        foreach (var (column, value) in extraFlags)
        {
            // build setters in a loop, one per flag that actually changed
            setters.SetProperty(column, value);
        }
    });
```

O corpo do delegate roda uma vez, em C#, para montar a lista de colunas a definir; o EF Core 11 então traduz isso em um único `UPDATE`. Essa é a forma idiomática de implementar um endpoint PATCH onde o cliente envia apenas os campos que quer mudar. Você monta exatamente os setters de que precisa e emite uma única instrução, em vez de atualizar todas as colunas ou recorrer a carregar-mutar-salvar. A antiga sobrecarga baseada em expressões ainda existe e é adequada para o caso estático de sempre-as-mesmas-colunas.

## Referenciar entidades relacionadas, e os limites

`ExecuteUpdate` não pode referenciar uma navegação diretamente dentro de `SetProperty`. Isto não traduz:

```csharp
// .NET 11, EF Core 11.0.0 - does NOT work
await context.Blogs.ExecuteUpdateAsync(
    setters => setters.SetProperty(b => b.Rating, b => b.Posts.Average(p => p.Rating)));
```

A solução alternativa é fazer um `Select` para uma projeção anônima que calcule o valor primeiro e então chamar `ExecuteUpdate` sobre essa projeção:

```csharp
// .NET 11, EF Core 11.0.0 - set each Blog's rating to the average of its Posts
await context.Blogs
    .Select(b => new { Blog = b, NewRating = b.Posts.Average(p => p.Rating) })
    .ExecuteUpdateAsync(setters => setters.SetProperty(x => x.Blog.Rating, x => x.NewRating));
```

O EF Core 11 converte a média em uma subconsulta correlacionada dentro do `UPDATE`:

```sql
UPDATE [b]
SET [b].[Rating] = CAST((
    SELECT AVG(CAST([p].[Rating] AS float))
    FROM [Post] AS [p]
    WHERE [b].[Id] = [p].[BlogId]) AS int)
FROM [Blogs] AS [b]
```

Além das navegações, mantenha estas restrições em mente:

- **Apenas atualizar e excluir.** Não existe `ExecuteInsert`. Inserções ainda passam por `Add` mais `SaveChanges`.
- **Não retorna os valores antigos.** O SQL pode retornar as linhas que tocou, mas o EF Core 11 não expõe isso; você só recebe a contagem.
- **Não agrupa em lote entre chamadas.** Duas chamadas a `ExecuteUpdate` são duas idas e voltas. Não há equivalente de acumular mudanças e descarregar de uma vez.
- **Uma tabela por instrução.** Igual ao `UPDATE`/`DELETE` de SQL bruto, uma única chamada mira uma única tabela. Atualizar por meio de uma hierarquia de herança TPT que abrange várias tabelas não é expressável em uma única chamada.
- **Apenas provedores relacionais.** São métodos de extensão sobre o provedor de consultas relacional; o provedor em memória não os tem.

A primeira merece atenção: se seu caminho quente são *inserções* de alto volume, nenhum dos dois métodos ajuda. Esse é um problema distinto com sua própria resposta, medido em [EF Core 11 vs Dapper para inserções em massa](/pt-br/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/).

## Quando escolher qual

A decisão depende em grande parte de você precisar das entidades. Se você está excluindo ou atualizando linhas por um predicado e não precisa dos objetos afetados em memória depois, `ExecuteDelete`/`ExecuteUpdate` é quase sempre a escolha certa: uma instrução, sem materialização, sem sobrecarga de rastreamento. É o mesmo instinto que te faz caçar e eliminar uma [consulta N+1 no EF Core 11](/pt-br/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/), ou seja, recusar idas e voltas por linha quando o banco de dados pode fazer o trabalho inteiro em uma única operação baseada em conjuntos.

Volte ao `SaveChanges` quando você realmente precisar do rastreador de mudanças: grafos de objetos complexos, comportamentos em cascata que dependem do estado rastreado, tokens de concorrência automáticos, ou interceptores e eventos de domínio conectados ao `SaveChanges`. E sempre que você misturar os dois, lembre do limite. Os métodos em massa escrevem SQL diretamente e deixam suas entidades rastreadas congeladas no passado. Limpe o rastreador ou consulte com `AsNoTracking()` após uma escrita em massa, envolva o trabalho de várias instruções em uma transação explícita e verifique a contagem de linhas retornada quando a correção depender de quantas linhas realmente mudaram.
