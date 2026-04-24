---
title: "Como usar IAsyncEnumerable<T> com EF Core 11"
description: "As queries do EF Core 11 implementam IAsyncEnumerable<T> diretamente. Veja como fazer streaming de linhas com await foreach, quando preferir a ToListAsync, e as pegadinhas envolvendo conexões, tracking e cancelamento."
pubDate: 2026-04-22
tags:
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "ef-core-11"
  - "csharp"
lang: "pt-br"
translationOf: "2026/04/how-to-use-iasyncenumerable-with-ef-core-11"
translatedBy: "claude"
translationDate: 2026-04-24
---

Se você tem uma query no EF Core 11 que retorna muitas linhas, você não precisa materializar o conjunto todo em uma `List<T>` antes de começar a processar. Um `IQueryable<T>` do EF Core já implementa `IAsyncEnumerable<T>`, então você pode fazer `await foreach` diretamente sobre ele e cada linha é entregue conforme o banco a produz. Sem `ToListAsync`, sem iterator custom, sem o pacote `System.Linq.Async`. Essa é a resposta curta. Este post percorre a mecânica, os detalhes de versão do EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0.0, .NET 11, C# 14), e as pegadinhas que mordem quem parafusa streaming em uma base de código que não foi desenhada para ele.

## Por que o EF Core expõe `IAsyncEnumerable<T>` afinal

O pipeline de queries do EF Core é construído em volta de um data reader. Quando você chama `ToListAsync()`, o EF Core abre uma conexão, executa o comando e puxa linhas do reader para uma lista buferizada até esgotar o reader, e depois fecha tudo. Você recebe uma `List<T>`, o que é conveniente, mas o resultado inteiro agora vive na memória do seu processo e a primeira linha só fica visível para o seu código depois que a última foi lida.

`IAsyncEnumerable<T>` vira isso do avesso. Você pede linhas uma por vez. O EF Core abre a conexão, roda o comando e entrega a primeira entidade materializada assim que a primeira linha sai do cabo. Seu código começa a trabalhar imediatamente. A memória fica limitada ao que o corpo do loop retém. Para relatórios, exportações e pipelines que transformam linhas antes de gravá-las em outro lugar, esse é o padrão que você quer.

Como `DbSet<TEntity>` e o `IQueryable<TEntity>` retornado por qualquer cadeia LINQ implementam ambos `IAsyncEnumerable<TEntity>`, você não precisa de uma chamada explícita a `AsAsyncEnumerable()` para funcionar. A interface já está lá. A maquinaria do async foreach a detecta.

## O exemplo mínimo

```csharp
// .NET 11, C# 14, Microsoft.EntityFrameworkCore 11.0.0
using Microsoft.EntityFrameworkCore;

await using var db = new AppDbContext();

await foreach (var invoice in db.Invoices
    .Where(i => i.Status == InvoiceStatus.Pending)
    .OrderBy(i => i.CreatedAt))
{
    await ProcessAsync(invoice);
}
```

Isso é tudo. Sem `ToListAsync`. Sem alocação intermediária. O `DbDataReader` subjacente fica aberto durante a duração inteira do loop. Cada iteração puxa outra linha do cabo, materializa a `Invoice` e entrega ao corpo do loop.

Contraste com a versão baseada em lista:

```csharp
// Buffers every row into memory before the first ProcessAsync call
var invoices = await db.Invoices
    .Where(i => i.Status == InvoiceStatus.Pending)
    .OrderBy(i => i.CreatedAt)
    .ToListAsync();

foreach (var invoice in invoices)
{
    await ProcessAsync(invoice);
}
```

Para 50 linhas, a diferença é invisível. Para 5 milhões de linhas, a versão em streaming termina a primeira invoice antes de a versão buferizada terminar de alocar a lista.

## Passando um cancellation token do jeito certo

A sobrecarga `IQueryable<T>.GetAsyncEnumerator(CancellationToken)` aceita um token, mas quando você escreve `await foreach (var x in query)` não há lugar para passar um. O conserto é `WithCancellation`:

```csharp
public async Task ExportPendingAsync(CancellationToken ct)
{
    await foreach (var invoice in db.Invoices
        .Where(i => i.Status == InvoiceStatus.Pending)
        .AsNoTracking()
        .WithCancellation(ct))
    {
        ct.ThrowIfCancellationRequested();
        await writer.WriteAsync(invoice, ct);
    }
}
```

`WithCancellation` não envolve a sequência em outro iterator. Ele apenas enfia o token na chamada a `GetAsyncEnumerator`, que o EF Core repassa para `DbDataReader.ReadAsync`. Se o chamador cancelar o token, o `ReadAsync` pendente é cancelado, o comando é abortado no servidor e `OperationCanceledException` sobe pelo seu `await foreach`.

Não pule o token. Um token esquecido em uma query EF Core em streaming é uma requisição pendurada em produção quando o cliente HTTP desconecta. O caminho baseado em lista falha do mesmo jeito, mas aqui dói mais porque a conexão fica segura por todo o loop, não só na materialização.

## Desligue o tracking a menos que realmente precise

`AsNoTracking()` importa mais em streaming do que em buffering. Com change tracking ligado, cada entidade entregue pelo enumerator é adicionada ao `ChangeTracker`. Essa é uma referência que o GC não pode coletar até você descartar o `DbContext`. Fazer streaming de um milhão de linhas em uma query com tracking anula a razão do streaming: memória cresce linearmente com as linhas, igual a `ToListAsync`.

```csharp
await foreach (var row in db.AuditEvents
    .AsNoTracking()
    .Where(e => e.OccurredAt >= cutoff)
    .WithCancellation(ct))
{
    await sink.WriteAsync(row, ct);
}
```

Só mantenha tracking se você pretende mutar as entidades e chamar `SaveChangesAsync` dentro do loop, o que, como a próxima seção argumenta, você quase nunca deveria fazer.

## Você não pode abrir uma segunda query no mesmo contexto enquanto uma está em streaming

Essa é a pegadinha mais comum em produção. O `DbDataReader` que o EF Core abre quando você começa a enumerar segura a conexão. Se dentro do loop você chamar outro método do EF Core que precise dessa conexão, você recebe:

```
System.InvalidOperationException: There is already an open DataReader associated
with this Connection which must be closed first.
```

No SQL Server você pode contornar ligando Multiple Active Result Sets (`MultipleActiveResultSets=True` no connection string), mas o MARS tem suas próprias contrapartidas de performance e não é suportado em todos os provedores. O padrão melhor é não misturar operações no mesmo contexto. Ou:

- Colete os IDs que você precisa primeiro, feche o stream, depois faça o trabalho complementar; ou
- Use um segundo `DbContext` para as chamadas internas.

```csharp
await foreach (var order in queryCtx.Orders
    .AsNoTracking()
    .WithCancellation(ct))
{
    await using var writeCtx = await factory.CreateDbContextAsync(ct);
    writeCtx.Orders.Attach(order);
    order.ProcessedAt = DateTime.UtcNow;
    await writeCtx.SaveChangesAsync(ct);
}
```

`IDbContextFactory<TContext>` (registrado via `AddDbContextFactory` na sua configuração de DI) é o jeito mais limpo de conseguir esse segundo contexto sem brigar com ciclos de vida scoped.

## Streaming e transações não se combinam bem

Um enumerator em streaming segura uma conexão aberta enquanto o loop roda. Se esse loop também participa de uma transação, a transação fica aberta pelo loop inteiro. Transações de longa duração são como você consegue escalação de locks, writers bloqueados e o tipo de timeout que só aparece sob carga.

Duas regras que mantêm isso são:

1. Não abra uma transação em volta de uma leitura em streaming a menos que você precise especificamente de um snapshot consistente.
2. Se você precisa de um snapshot, considere isolamento `SNAPSHOT` no SQL Server ou isolamento `REPEATABLE READ` no provedor da sua escolha, e trate o corpo do loop como caminho quente. Sem chamadas HTTP, sem esperas visíveis ao usuário.

Para jobs de processamento em lote, o formato usual é: leitura em streaming, escrita por linha ou em batches numa transação curta em contexto separado, commit, seguir em frente.

## `AsAsyncEnumerable` existe, e às vezes você precisa dele

Se você tem um método que aceita `IAsyncEnumerable<T>` e quer alimentá-lo com uma query EF Core, passar o `IQueryable<T>` direto compila, porque a interface está implementada, mas parece errado no ponto de chamada. `AsAsyncEnumerable` é um no-op em runtime que torna a intenção explícita:

```csharp
public async Task ExportAsync(IAsyncEnumerable<Invoice> source, CancellationToken ct)
{
    // Consumes a generic async sequence. Does not know it is EF.
}

await ExportAsync(
    db.Invoices.AsNoTracking().AsAsyncEnumerable(),
    ct);
```

Também força a chamada a sair do mundo `IQueryable`. Uma vez que você passa por `AsAsyncEnumerable()`, qualquer operador LINQ subsequente roda no cliente como operador de async iterator, não como SQL. Esse é o comportamento que você quer aqui, porque o método receptor não deveria acidentalmente reescrever a query.

## O que acontece se você sair do loop cedo

Async iterators limpam no dispose. Quando o `await foreach` sai, por qualquer razão (break, exceção ou conclusão), o compilador chama `DisposeAsync` no enumerator, o que fecha o `DbDataReader` e devolve a conexão ao pool. Por isso o `await using` no `DbContext` ainda importa, mas a query individual não precisa do próprio bloco using.

Uma consequência não óbvia: se você faz `break` depois da primeira linha de uma query de 10 milhões de linhas, o EF Core não lê as outras linhas, mas o banco pode já ter spoolado muitas delas. O plano de query não sabe que você perdeu o interesse. Para SQL Server, o `DbDataReader.Close` do lado cliente manda um cancel pelo stream TDS e o servidor desiste, mas para contagens enormes você ainda pode ver alguns segundos de trabalho no servidor depois do loop sair. Isso quase nunca é problema, mas vale saber quando um depurador mostra uma query rodando no servidor depois do seu teste já ter passado.

## Não use `ToListAsync` em cima de uma fonte em streaming

De vez em quando alguém escreve isso:

```csharp
// Pointless: materializes the whole thing, then streams it
var all = await db.Invoices.ToListAsync(ct);
await foreach (var item in all.ToAsyncEnumerable()) { }
```

Não tem benefício. Se você quer streaming, vá direto do `IQueryable` para o `await foreach`. Se você quer buffering, mantenha a `List<T>` e use um `foreach` normal. Misturar sempre revela alguém que não tinha certeza do que queria.

Da mesma forma, chamar `.ToAsyncEnumerable()` numa query EF Core é redundante no EF Core 11: a fonte já implementa a interface. Compila e funciona, mas não adicione.

## Avaliação no cliente ainda se enfia

O tradutor de queries do EF Core é bom, mas nem toda expressão LINQ traduz para SQL. Se não puder, o EF Core 11 lança por padrão no operador final (ao contrário do client-eval silencioso do EF Core 2.x). Streaming não muda isso: se seu filtro `.Where` referenciar um método que o EF Core não consegue traduzir, a query inteira falha em tempo de enumeração, não no início do `await foreach`.

A surpresa é que com `await foreach`, a exceção aflora no primeiro `MoveNextAsync`, que está dentro do cabeçalho do loop, não antes. Envolva o setup em `try` se você quer distinguir erros de setup de erros de processamento:

```csharp
try
{
    await foreach (var row in query.WithCancellation(ct))
    {
        try { await ProcessAsync(row, ct); }
        catch (Exception ex) { log.LogWarning(ex, "Row {Id} failed", row.Id); }
    }
}
catch (Exception ex)
{
    log.LogError(ex, "Query failed before first row");
    throw;
}
```

## Quando `ToListAsync` ainda é a resposta certa

Streaming não é universalmente melhor. Recorra a `ToListAsync` quando:

- O resultado é pequeno e limitado (digamos, abaixo de alguns milhares de linhas).
- Você precisa iterar o resultado mais de uma vez.
- Você precisa de `Count`, indexação, ou qualquer outra operação de `IList<T>`.
- Você planeja fazer bind do resultado em um controle de UI ou serializá-lo em um corpo de resposta que espera uma coleção materializada.

Streaming vence quando o resultado é grande, quando memória importa, quando o consumidor é ele mesmo async (um `PipeWriter`, um `IBufferWriter<T>`, um `Channel<T>`, um barramento de mensagens), ou quando latência de primeiro byte importa mais que throughput total.

## Checklist rápido para streaming no EF Core 11

- `await foreach` direto sobre um `IQueryable<T>`. Sem `ToListAsync`.
- Sempre `AsNoTracking()` a menos que você tenha uma razão concreta para não.
- Sempre `WithCancellation(ct)`.
- Use `IDbContextFactory<TContext>` se precisar de um segundo contexto para escritas dentro do loop.
- Não envolva uma leitura em streaming em uma transação longa.
- Não abra um segundo reader no mesmo contexto sem MARS.
- Espere que o primeiro `MoveNextAsync` aflore erros de tradução e de conexão.

## Relacionados

- [Como usar records com EF Core 11 corretamente](/2026/04/how-to-use-records-with-ef-core-11-correctly/) combina bem com leituras em streaming quando suas entidades são imutáveis.
- [Migrations em passo único no EF Core 11 com `dotnet ef update add`](/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/) cobre o lado de tooling da mesma release.
- [Streaming de tasks com Task.WhenEach no .NET 9](/2026/01/streaming-tasks-with-net-9-task-wheneach/) para o outro padrão principal de `IAsyncEnumerable<T>` no .NET moderno.
- [HttpClient GetFromJsonAsAsyncEnumerable](/2023/10/httpclient-get-json-as-asyncenumerable/) mostra o mesmo formato de streaming no lado HTTP.
- [EF Core 11 preview 3 poda reference joins em split queries](/2026/04/efcore-11-preview-3-prunes-reference-joins-split-queries/) para o contexto de performance da mesma release.

## Fontes

- [EF Core Async Queries, MS Learn](https://learn.microsoft.com/en-us/ef/core/miscellaneous/async).
- [Ciclo de vida e pooling de `DbContext`, MS Learn](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/).
- [`IDbContextFactory<TContext>`, MS Learn](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/#using-a-dbcontext-factory-eg-for-blazor).
- [`AsyncEnumerableReader` no código-fonte do EF Core no GitHub](https://github.com/dotnet/efcore).
