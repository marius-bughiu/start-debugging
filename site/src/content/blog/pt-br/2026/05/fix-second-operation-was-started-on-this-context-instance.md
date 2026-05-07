---
title: "Correção: A second operation was started on this context instance before a previous operation completed"
description: "EF Core lança esta exceção quando dois await rodam em paralelo sobre o mesmo DbContext. Aguarde cada chamada de forma sequencial, ou obtenha um DbContext novo por unidade de trabalho concorrente via IDbContextFactory."
pubDate: 2026-05-07
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "async"
lang: "pt-br"
translationOf: "2026/05/fix-second-operation-was-started-on-this-context-instance"
translatedBy: "claude"
translationDate: 2026-05-07
---

A correção: um `DbContext` não é thread-safe e só pode ter uma consulta, um save ou um percurso do rastreador de alterações em andamento por vez. A exceção significa que duas operações na mesma instância se sobrepuseram, quase sempre porque uma `Task` foi iniciada sem `await`, porque um corpo de `Parallel.ForEachAsync` compartilhou o contexto, ou porque um campo capturado foi acessado a partir de duas requisições ao mesmo tempo. Aguarde a primeira chamada antes de iniciar a segunda, ou entregue a cada unidade de trabalho concorrente seu próprio `DbContext` via `IDbContextFactory<T>`.

```text
System.InvalidOperationException: A second operation was started on this context instance before a previous operation completed. This is usually caused by different threads concurrently using the same instance of DbContext. For more information on how to avoid threading issues with DbContext, see https://go.microsoft.com/fwlink/?linkid=2097913.
   at Microsoft.EntityFrameworkCore.Internal.ConcurrencyDetector.EnterCriticalSection()
   at Microsoft.EntityFrameworkCore.Query.Internal.QueryCompiler.ExecuteAsync[TResult](Expression query, CancellationToken cancellationToken)
   at Microsoft.EntityFrameworkCore.Query.Internal.EntityQueryProvider.ExecuteAsync[TResult](Expression expression, CancellationToken cancellationToken)
   at System.Linq.AsyncEnumerable.ToListAsync[TSource](IAsyncEnumerable`1 source, CancellationToken cancellationToken)
```

Este guia foi escrito contra .NET 11 preview 4 e `Microsoft.EntityFrameworkCore` 11.0.0-preview.4. O texto e o `ConcurrencyDetector` subjacente são os mesmos desde o EF Core 2.0; os detalhes internos da pilha em volta mudam entre versões. A exceção é lançada de `ConcurrencyDetector.EnterCriticalSection`, que protege todas as APIs assíncronas públicas do `DbContext`. Não há condição de corrida do lado do EF Core, o detector está correto: ele percebeu que você está tentando conduzir duas operações por um único mapa de identidade e um único comando aberto.

## Por que um DbContext é single-threaded por design

`DbContext` mantém uma máquina de estados privada: um mapa de identidade das entidades rastreadas, uma lista pendente de mudanças, uma `DbConnection` aberta, e no máximo um `DbCommand` em andamento. Os providers ADO.NET não permitem dois comandos na mesma conexão a menos que MARS esteja ativo, e mesmo com MARS, mutações do rastreador de alterações entre duas consultas competiriam entre si de formas arbitrárias. Em vez de sincronizar tudo internamente e pagar o custo em cada chamada, o EF Core diz não: uma operação por vez por instância. O `ConcurrencyDetector` é uma aplicação amigável para depuração desse contrato, não a causa do problema.

Esse contrato vale em todo método `*Async`: `ToListAsync`, `FirstOrDefaultAsync`, `SaveChangesAsync`, `AnyAsync`, `CountAsync`, `Database.ExecuteSqlAsync`, mais os irmãos síncronos se você misturar `.Result` ou `.GetAwaiter().GetResult()` no mesmo ponto de chamada. Se duas dessas se sobrepuserem no mesmo `DbContext`, a segunda lança.

## Uma reprodução mínima

A reprodução mais curta e confiável é `Task.WhenAll` no mesmo contexto:

```csharp
// .NET 11, C# 14, EF Core 11.0.0
public class Report(AppDb db)
{
    public async Task<(int customers, int orders)> Counts()
    {
        var customersTask = db.Customers.CountAsync();
        var ordersTask = db.Orders.CountAsync();

        await Task.WhenAll(customersTask, ordersTask); // throws
        return (await customersTask, await ordersTask);
    }
}
```

Ambas as chamadas a `CountAsync` começam quase simultaneamente; a segunda entra em `ConcurrencyDetector.EnterCriticalSection` enquanto a primeira ainda está dentro, e o detector lança. A correção não é introduzir locking, é reconhecer que você queria duas unidades de trabalho independentes e tinha apenas uma ferramenta.

Uma reprodução mais sutil é esquecer um `await`:

```csharp
// .NET 11, EF Core 11.0.0 -- still wrong
public async Task ProcessOrder(int id)
{
    var orderTask = db.Orders.FirstOrDefaultAsync(o => o.Id == id);
    var auditTask = db.AuditLog.AddAsync(new AuditEntry(id)); // no await
    await db.SaveChangesAsync(); // throws
}
```

`AddAsync` retorna um `ValueTask`. Sem aguardá-lo, você não terminou de fato de adicionar, mas a chamada já tocou o rastreador de alterações. Aí `SaveChangesAsync` roda contra um rastreador em meio a uma mutação e o detector dispara. Mesma causa raiz: duas operações se sobrepõem na mesma instância.

## Três correções, em ordem de preferência

Aplique-as nesta ordem. A primeira é a resposta certa em 90% dos casos; a terceira é a saída de emergência para trabalho genuinamente concorrente.

### 1. Aguarde de forma sequencial quando você só precisa de uma conexão

Se você não precisa de fato que as consultas rodem em paralelo, não as inicie em paralelo. O custo de relógio de duas chamadas sequenciais a `CountAsync` raramente compensa o bug:

```csharp
// .NET 11, EF Core 11.0.0
public async Task<(int customers, int orders)> Counts()
{
    var customers = await db.Customers.CountAsync();
    var orders = await db.Orders.CountAsync();
    return (customers, orders);
}
```

Para um handler de requisição falando com um único banco de dados, isso é quase sempre o correto. A segunda consulta roda na mesma conexão já aberta, então não há custo de um segundo round-trip além da consulta em si. Recorra a paralelismo apenas quando você tiver medido que duas consultas no mesmo backend economizam tempo real, o que é incomum porque o próprio banco serializa comandos por conexão de qualquer forma.

### 2. Use IDbContextFactory para unidades de trabalho realmente concorrentes

Quando você precisa de duas consultas rodando ao mesmo tempo (mais comumente em um `BackgroundService`, um job do `Hangfire`, uma ferramenta CLI processando lotes, ou cenários de fan-out), entregue a cada task seu próprio `DbContext`:

```csharp
// .NET 11, EF Core 11.0.0
builder.Services.AddDbContextFactory<AppDb>(o => o.UseSqlServer(cs));

public class Report(IDbContextFactory<AppDb> factory)
{
    public async Task<(int customers, int orders)> Counts()
    {
        var customersTask = CountAsync(db => db.Customers);
        var ordersTask = CountAsync(db => db.Orders);

        await Task.WhenAll(customersTask, ordersTask);
        return (await customersTask, await ordersTask);
    }

    private async Task<int> CountAsync<T>(Func<AppDb, IQueryable<T>> set)
    {
        await using var db = await factory.CreateDbContextAsync();
        return await set(db).CountAsync();
    }
}
```

Cada operação concorrente agora ganha seu próprio contexto, sua própria conexão do pool e seu próprio rastreador de alterações. Não há estado mutável compartilhado, então o detector não tem do que reclamar. `AddDbContextFactory` é o registro suportado; não tente fazer `new` manualmente em um `DbContext` para escapar do ciclo de vida, isso ignora a resolução de opções e o pooling.

Se você também quiser instâncias do pool para criação barata, registre `AddPooledDbContextFactory` no lugar. Para os trade-offs de fábricas com pool em setups de teste, [o padrão de troca de fábrica com pool removível](/pt-br/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/) cobre a pegadinha do estado vazando entre alugueis.

### 3. Resolva um scope novo por operação

No ciclo de vida scoped gerenciado pelo framework (o padrão para ASP.NET Core), a correção é criar um scope filho para cada ramo paralelo:

```csharp
// .NET 11, EF Core 11.0.0
public class Report(IServiceScopeFactory scopes)
{
    public async Task ProcessAll(IEnumerable<int> ids)
    {
        await Parallel.ForEachAsync(ids, async (id, ct) =>
        {
            await using var scope = scopes.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDb>();
            var order = await db.Orders.FirstOrDefaultAsync(o => o.Id == id, ct);
            // ... process order ...
        });
    }
}
```

`CreateAsyncScope` constrói um scope de DI novo, então resolver `AppDb` a partir dele retorna uma instância diferente do scope da requisição externa e de cada outra iteração. Esse é o formato certo para `Parallel.ForEachAsync` contra EF Core. O padrão de fábrica da correção 2 é preferível quando o trabalho é puramente acesso a dados; o padrão de scope é melhor quando o corpo do loop também precisa de outros serviços scoped.

## Padrões comuns que disparam isso

### Compartilhar o DbContext da requisição com Task.Run

Um erro clássico do ASP.NET Core: um handler de requisição dispara uma task fire-and-forget que captura o `DbContext` com scope de requisição:

```csharp
// .NET 11, EF Core 11.0.0 -- wrong
[HttpPost]
public IActionResult QueueWork()
{
    _ = Task.Run(async () =>
    {
        await db.AuditLog.AddAsync(new AuditEntry("queued"));
        await db.SaveChangesAsync();
    });
    return Accepted();
}
```

Aqui se sobrepõem dois modos de falha. Primeiro, a requisição retorna e o scope de DI descarta o `DbContext` enquanto a task de fundo ainda está rodando, então você também vê `ObjectDisposedException`. Segundo, se qualquer outro caminho de código na requisição ainda usa o contexto, ambas as threads disputam por ele e o detector lança. A correção é a mesma de #2: injete `IDbContextFactory<AppDb>`, ou entregue o trabalho a um mecanismo de fundo real (`IHostedService`, channels, uma fila de jobs) que possua seu próprio scope. [O passo a passo de Channels como substituto de BlockingCollection](/pt-br/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) cobre o padrão de fila in-process.

### Fazer streaming de um IAsyncEnumerable através de uma fronteira HTTP

Se você retorna `IAsyncEnumerable<T>` de um controller respaldado por uma consulta EF Core, o ASP.NET Core o enumera enquanto serializa a resposta. Se qualquer outra coisa nesse scope bater no mesmo `DbContext` enquanto a serialização está em curso, o detector lança. Fácil de cair quando um middleware depois adiciona uma linha de auditoria em um callback `OnStarting` enquanto o body ainda está fazendo streaming.

A correção é materializar o enumerable, ou garantir que o endpoint de streaming detenha o único acesso àquele contexto pelo ciclo de vida da resposta. [O passo a passo de `IAsyncEnumerable` com EF Core](/pt-br/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) percorre o modelo de streaming e os ciclos de vida que funcionam com ele.

### DbContext capturado em um event handler ou campo estático

Um `DbContext` armazenado como campo estático, ou capturado em um event handler assinado no startup, será reusado em todo evento. Dois eventos chegando próximos vão se sobrepor sobre ele. Mesma correção: injete a fábrica, não capture.

### DbContext com scope Singleton

Um `DbContext` registrado como `Singleton` (por engano ou via `AddSingleton<MyService>` onde `MyService` injeta `AppDb`) acaba compartilhado entre requisições. A concorrência então está garantida sob qualquer carga real. [O guia de colisão do mapa de identidade](/pt-br/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/) percorre a mesma armadilha Singleton/Scoped pelo ângulo da chave duplicada; ambos os erros vêm da mesma causa raiz.

### Misturar sync e async no mesmo ponto de chamada

`db.SaveChanges()` seguido de uma consulta assíncrona em curso iniciada antes (e não aguardada) vai disparar o detector quando você finalmente fizer `await` na assíncrona. Isso normalmente aparece em caminhos de código legados onde alguém adicionou um `_ = SomethingAsync()` para suprimir o aviso do compilador. Suprimir o aviso suprimiu o bug também; a correção é dar `await` nele.

### Reusar um DbContext entre tentativas de retry do Polly

Se você envolver uma chamada em `Polly` e o retry rodar enquanto a `Task` da tentativa anterior ainda está viva (o cancelamento não se propagou de forma limpa), ambas as tentativas tocam o mesmo contexto. Pareie retries com `IDbContextFactory<T>` para que cada tentativa receba um contexto novo, ou garanta que a tentativa anterior está totalmente cancelada (`ct.ThrowIfCancellationRequested()` percorrendo a chamada do EF Core) antes de retentar. [O guia de cancelar sem deadlock](/pt-br/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) cobre a disciplina de cancelamento que torna isso seguro.

## Variantes que parecem este erro mas não são

### "There is already an open DataReader associated with this Connection which must be closed first"

Exceção diferente, mesma família. Esta vem do ADO.NET quando MARS está desligado e você tentou iniciar um segundo reader na mesma conexão. EF Core esconde isso na maior parte do tempo, mas trabalho cru com `db.Database.GetDbConnection()` contorna o detector e mostra o erro subjacente em vez disso. A correção tem o mesmo formato (uma operação por vez, ou uma conexão por operação), mas ligar `MultipleActiveResultSets=True` na sua connection string do SQL Server permite executar readers aninhados se você realmente precisar.

### "ObjectDisposedException: Cannot access a disposed context"

Significa que o scope de DI já descartou o `DbContext` enquanto uma task capturada tentou usá-lo. Geralmente um `Task.Run` fire-and-forget de um handler HTTP, ou um `BackgroundService` que capturou um contexto scoped no startup. A correção é resolver o contexto dentro da task, não fora.

### "The instance of entity type cannot be tracked because another instance with the same key value is already being tracked"

Conflito do mapa de identidade, uma forma single-threaded. Dois objetos CLR, mesma chave primária, mesmo contexto. Percorre a correção em detalhes [no guia de rastreamento de entidades](/pt-br/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/).

### "InvalidOperationException: Synchronous operations are disallowed"

Kestrel rejeitando `Stream.Read` em vez de `Stream.ReadAsync` no body da resposta. Pilha diferente, correção diferente (`AllowSynchronousIO = true` ou migrar para APIs assíncronas). Não é problema de `DbContext`.

## Relacionados

Para higiene mais ampla de EF Core, veja [o passo a passo de detecção de N+1](/pt-br/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) e [o guia de consultas compiladas em hot paths](/pt-br/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) para o design de consultas depois que o modelo de concorrência estiver certo. Para fixtures de teste que entregam um banco de dados real ao seu código sem compartilhar um contexto entre threads, [o passo a passo de Testcontainers contra SQL Server real](/pt-br/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) é o setup mais limpo. [O post de detecção de N+1](/pt-br/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) também cobre os hooks do logger do EF Core 11 que você pode reaproveitar para sinalizar `await` esquecidos no CI.

## Fontes

- [Avoiding DbContext threading issues](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/#avoiding-dbcontext-threading-issues), documentação do EF Core.
- [`IDbContextFactory<TContext>` interface](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.idbcontextfactory-1), Microsoft Learn.
- [`AddDbContextFactory` extension](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.entityframeworkservicecollectionextensions.adddbcontextfactory), Microsoft Learn.
- [`ConcurrencyDetector` source](https://github.com/dotnet/efcore/blob/main/src/EFCore/Internal/ConcurrencyDetector.cs), dotnet/efcore no GitHub.
- [`IServiceScopeFactory.CreateAsyncScope`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.serviceproviderserviceextensions.createasyncscope), Microsoft Learn.
