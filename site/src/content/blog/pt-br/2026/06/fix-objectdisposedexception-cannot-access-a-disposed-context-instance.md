---
title: "Correção: ObjectDisposedException: Cannot access a disposed context instance"
description: "Sua tarefa fire-and-forget capturou um DbContext com escopo de requisição que o escopo de DI já havia liberado. Resolva um contexto novo dentro da tarefa com IServiceScopeFactory ou IDbContextFactory."
pubDate: 2026-06-02
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "async"
lang: "pt-br"
translationOf: "2026/06/fix-objectdisposedexception-cannot-access-a-disposed-context-instance"
translatedBy: "claude"
translationDate: 2026-06-02
---

A correção: uma `Task` fire-and-forget capturou um `DbContext` (ou outro serviço com escopo) que vivia em um escopo de DI que foi liberado antes de a tarefa terminar. A requisição retornou, o ASP.NET Core liberou o escopo e seu `DbContext`, e sua tarefa desacoplada então tocou a instância morta. Não capture o contexto com escopo: dentro da tarefa, crie seu próprio escopo com `IServiceScopeFactory.CreateAsyncScope` e resolva um novo `DbContext` a partir dele, ou injete `IDbContextFactory<T>` e chame `CreateDbContextAsync`.

```text
System.ObjectDisposedException: Cannot access a disposed context instance. A common cause of this error is disposing a context instance that was resolved from dependency injection and then later trying to use the same context instance elsewhere in your application. This may occur if you are calling Dispose() on the context instance, or wrapping it in a using statement. If you are using dependency injection, you should let the dependency injection container take care of disposing context instances.
Object name: 'AppDb'.
   at Microsoft.EntityFrameworkCore.DbContext.CheckDisposed()
   at Microsoft.EntityFrameworkCore.DbContext.get_DbContextDependencies()
   at Microsoft.EntityFrameworkCore.DbContext.Set[TEntity]()
   at Microsoft.EntityFrameworkCore.Internal.InternalDbSet`1.get_EntityQueryable()
```

Este guia foi escrito contra o .NET 11 preview 4 e o `Microsoft.EntityFrameworkCore` 11.0.0-preview.4, mas o texto da mensagem e a verificação `CheckDisposed` permaneceram estáveis desde o EF Core 3.0. A exceção é lançada de `DbContext.CheckDisposed()`, que roda no topo de cada membro público: `Set<T>`, `SaveChangesAsync`, `Database`, o rastreador de mudanças, tudo. Quando você a vê, o objeto já se foi de fato. O EF Core não está em condição de corrida nem se comportando mal; algo liberou o contexto e então o código foi atrás dele mesmo assim.

## O que "liberado" realmente significa aqui

Um `DbContext` resolvido a partir de injeção de dependência pertence ao escopo de onde foi resolvido. No ASP.NET Core, o framework cria um escopo de DI por requisição HTTP e o libera quando a resposta termina. Liberar o escopo libera todo `IDisposable` que ele criou, incluindo seu `DbContext`. Depois disso, o provedor de serviços interno do contexto é desmontado, sua `DbConnection` volta ao pool e `_disposed` é definido como `true`. Qualquer chamada posterior alcança `CheckDisposed()` e lança a exceção.

O erro quase nunca tem a ver com você escrever `using` ou chamar `Dispose()` por conta própria (embora essa seja a outra maneira de provocá-lo). Na prática, tem a ver com ciclo de vida: o código sobreviveu ao escopo que era dono do contexto. A forma de longe mais comum é uma tarefa fire-and-forget iniciada a partir de uma requisição que capturou o contexto daquela requisição.

## O repro mínimo

Um controller dispara trabalho em segundo plano sem aguardá-lo, e o lambda fecha sobre o `DbContext` injetado:

```csharp
// .NET 11, C# 14, EF Core 11.0.0 -- wrong
public class OrdersController(AppDb db) : ControllerBase
{
    [HttpPost("orders")]
    public IActionResult Create(OrderDto dto)
    {
        var order = new Order(dto);
        db.Orders.Add(order);

        // fire-and-forget: not awaited, escapes the request lifetime
        _ = Task.Run(async () =>
        {
            await Task.Delay(2000);            // simulate slow work
            db.AuditLog.Add(new Audit(order)); // db is disposed by now
            await db.SaveChangesAsync();        // throws ObjectDisposedException
        });

        return Accepted();
    }
}
```

A sequência: `Create` retorna `Accepted()` quase imediatamente, o ASP.NET Core libera o escopo da requisição (e `db` junto com ele), e dois segundos depois a tarefa desacoplada acorda e chama um contexto cuja flag `_disposed` já está definida. O `Add` pode até parecer que teve sucesso dependendo do timing, mas `SaveChangesAsync` lança a exceção de forma confiável porque toca as dependências liberadas.

A mesma coisa acontece com `ContinueWith`, com um manipulador de eventos `async void` que captura o contexto, com um callback de `Timer` que fecha sobre ele e com um `BackgroundService` que resolveu um contexto com escopo uma vez no construtor e o reutiliza para sempre.

## Correção 1: crie um escopo dentro da tarefa e resolva um contexto novo

Esta é a resposta certa quando o trabalho em segundo plano precisa de serviços com escopo além do puro acesso a dados. Injete `IServiceScopeFactory` (um singleton, sempre seguro de capturar) e abra um escopo dentro do corpo da tarefa:

```csharp
// .NET 11, C# 14, EF Core 11.0.0
public class OrdersController(AppDb db, IServiceScopeFactory scopeFactory)
    : ControllerBase
{
    [HttpPost("orders")]
    public async Task<IActionResult> Create(OrderDto dto)
    {
        var order = new Order(dto);
        db.Orders.Add(order);
        await db.SaveChangesAsync();     // the request's own work, awaited

        var orderId = order.Id;          // capture a value, not the context

        _ = Task.Run(async () =>
        {
            await using var scope = scopeFactory.CreateAsyncScope();
            var bgDb = scope.ServiceProvider.GetRequiredService<AppDb>();
            bgDb.AuditLog.Add(new Audit(orderId));
            await bgDb.SaveChangesAsync();
        });

        return Accepted();
    }
}
```

Duas coisas mudaram. A tarefa captura `orderId` (um `int`), não o `DbContext`. E ela resolve um `AppDb` totalmente novo a partir de um escopo do qual é dona, então a liberação desse escopo está atrelada ao término da tarefa, não à requisição HTTP. `CreateAsyncScope` (em vez do síncrono `CreateScope`) importa porque `DbContext` implementa `IAsyncDisposable`; usar o escopo assíncrono o libera pelo caminho assíncrono e evita um aviso de sync-over-async sob os analisadores.

Nunca capture instâncias de entidade através da fronteira também. O objeto `order` é rastreado pelo contexto da requisição; passá-lo para o contexto do novo escopo convida à colisão "instance of entity type cannot be tracked". Passe a chave e recarregue ou reanexe dentro da tarefa.

## Correção 2: injete IDbContextFactory quando o trabalho é puro acesso a dados

Se o trabalho desacoplado só precisa de um `DbContext` e nada mais com escopo, `IDbContextFactory<T>` é mais limpo do que levantar um escopo de DI inteiro. Registre-o ao lado de (ou no lugar de) o contexto com escopo:

```csharp
// .NET 11, EF Core 11.0.0 -- Program.cs
builder.Services.AddDbContextFactory<AppDb>(o => o.UseSqlServer(cs));
```

```csharp
// .NET 11, C# 14, EF Core 11.0.0
public class OrdersController(IDbContextFactory<AppDb> factory) : ControllerBase
{
    [HttpPost("orders")]
    public async Task<IActionResult> Create(OrderDto dto)
    {
        int orderId;
        await using (var db = await factory.CreateDbContextAsync())
        {
            var order = new Order(dto);
            db.Orders.Add(order);
            await db.SaveChangesAsync();
            orderId = order.Id;
        }

        _ = Task.Run(async () =>
        {
            await using var bgDb = await factory.CreateDbContextAsync();
            bgDb.AuditLog.Add(new Audit(orderId));
            await bgDb.SaveChangesAsync();
        });

        return Accepted();
    }
}
```

`IDbContextFactory<T>` é registrado como singleton, então capturá-lo no closure é seguro. Cada `CreateDbContextAsync` te entrega um contexto cujo ciclo de vida você controla com `await using`. A factory contorna o escopo da requisição por completo, que é exatamente o que uma tarefa desacoplada quer. Se você também chamar `AddDbContextFactory`, note que no EF Core 11 o mesmo registro pode satisfazer tanto a injeção de `AppDb` com escopo quanto a injeção da factory, então você não precisa escolher uma globalmente. Recorra a `AddPooledDbContextFactory` se o custo de criação aparecer em um profile, mas redefina qualquer estado por contexto entre os aluguéis.

## Correção 3: pare de disparar e esquecer -- entregue o trabalho a um mecanismo real de segundo plano

`Task.Run` a partir de um manipulador de requisição é a ferramenta errada mesmo quando você conserta o ciclo de vida do contexto: o trabalho não tem retentativa, nem contrapressão, nem tratamento de desligamento gracioso, e a thread em que ele roda compete com o processamento de requisições. A correção duradoura é enfileirar uma mensagem e deixar um hosted service drená-la em seu próprio escopo. Um `Channel<T>` é a opção em processo mais leve:

```csharp
// .NET 11, C# 14, EF Core 11.0.0
public sealed record AuditWork(int OrderId);

public class AuditQueue
{
    private readonly Channel<AuditWork> _channel =
        Channel.CreateUnbounded<AuditWork>();

    public ValueTask Enqueue(AuditWork work) => _channel.Writer.WriteAsync(work);
    public IAsyncEnumerable<AuditWork> Reader(CancellationToken ct) =>
        _channel.Reader.ReadAllAsync(ct);
}

public class AuditWorker(AuditQueue queue, IServiceScopeFactory scopeFactory)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var work in queue.Reader(stoppingToken))
        {
            await using var scope = scopeFactory.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDb>();
            db.AuditLog.Add(new Audit(work.OrderId));
            await db.SaveChangesAsync(stoppingToken);
        }
    }
}
```

Registre `AuditQueue` como singleton e `AuditWorker` com `AddHostedService`. O controller agora só chama `await queue.Enqueue(new AuditWork(orderId))` e retorna. Cada unidade de trabalho recebe seu próprio escopo e seu próprio contexto dentro do worker, o trabalho sobrevive ao retorno da requisição, e o desligamento drena de forma limpa porque o laço respeita `stoppingToken`. Este é o padrão que o [guia de fire-and-forget seguro com BackgroundService](/pt-br/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/) cobre por completo, e o [guia de Channels como substituto de BlockingCollection](/pt-br/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) explica o lado da fila em profundidade.

## Por que um BackgroundService que injeta DbContext falha na inicialização

Uma versão mais sutil: você injeta `AppDb` direto no construtor de um `BackgroundService` e recebe um erro diferente primeiro.

```csharp
// .NET 11, EF Core 11.0.0 -- wrong, fails to start
public class AuditWorker(AppDb db) : BackgroundService { /* ... */ }
```

Um `BackgroundService` é um singleton. Injetar um `AppDb` com escopo em um singleton dispara o validador de escopo de DI na inicialização com "Cannot consume scoped service 'AppDb' from singleton". Se você de alguma forma suprimir isso (não deveria), o singleton manteria um contexto durante toda a vida do processo e você voltaria a `ObjectDisposedException` ou a erros de thread na primeira vez que duas iterações se sobrepusessem. A correção é o mesmo padrão `CreateAsyncScope` da Correção 1. O post sobre o [erro de serviço com escopo a partir de um singleton](/pt-br/2026/05/fix-cannot-consume-scoped-service-from-singleton/) e o [guia de serviços com escopo dentro de um BackgroundService](/pt-br/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/) explicam ambos por que singletons não podem manter estado com escopo.

## Liberação que você mesmo provocou

Duas formas que não são fire-and-forget produzem a mensagem idêntica:

Você envolveu um contexto resolvido por DI em `using`. Se `AppDb` veio de injeção por construtor, o contêiner é seu dono; um bloco `using` o libera cedo demais, e a próxima chamada de membro na mesma requisição lança a exceção. Deixe o contêiner liberá-lo: remova o `using`. Só libere contextos que você mesmo criou com `new` ou via uma factory.

Você retornou um `IEnumerable<T>` ou `IQueryable<T>` de um método e o chamador o enumera depois que o contexto já se foi. LINQ adiado não executa até a enumeração; se o contexto do método estava limitado a um `using` ou a uma requisição que já terminou, a enumeração alcança um contexto liberado. Materialize dentro do método com `ToListAsync`, ou mantenha o contexto vivo durante a enumeração.

## Variantes que parecem isto mas não são

### "A second operation was started on this context instance before a previous operation completed"

A mesma família, causa diferente: duas operações se sobrepuseram em um contexto vivo (não liberado), normalmente um `await` esquecido ou um `Task.WhenAll` sobre um único contexto. A correção também é um contexto por operação, detalhada no [guia de second-operation-started](/pt-br/2026/05/fix-second-operation-was-started-on-this-context-instance/).

### "Cannot access a disposed object. Object name: 'IServiceProvider'"

O escopo inteiro ou o provedor raiz foi liberado, não só o contexto. A mesma causa raiz (ciclo de vida), mas significa que você capturou um `IServiceProvider`/`IServiceScope` e o usou depois de liberá-lo. Resolva tudo de que precisa antes de o escopo terminar, ou mantenha o escopo vivo durante o trabalho.

### "The ConnectionString property has not been initialized"

Um contexto criado com `new` sem provedor configurado, não um problema de liberação. Você contornou a DI e esqueceu `OnConfiguring` ou as opções. Use a factory ou a DI em vez de `new AppDb()`.

### "ObjectDisposedException" em um CancellationTokenSource

Um `CancellationTokenSource` liberado enquanto um token dele ainda está em uso. Sem relação com o EF Core, mesmo que o tipo da exceção coincida. Olhe a linha `Object name:` -- ela nomeia o objeto liberado, e esse é seu sinal de triagem mais rápido.

## Relacionados

Para o panorama mais amplo de rodar trabalho desacoplado sem vazar estado com escopo, os guias de [padrões de fire-and-forget seguro](/pt-br/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/) e [serviços com escopo dentro de um BackgroundService](/pt-br/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/) são os dois para ler em seguida. Se seu fire-and-forget começou como um `async void`, a [análise de async void vs async Task](/pt-br/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) explica por que isso engole a exceção por completo. E quando a tarefa desacoplada precisa parar de forma limpa no desligamento, o [guia de cancelamento sem deadlock](/pt-br/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) cobre a disciplina de tokens.

## Fontes

- [DbContext lifetime, configuration, and initialization](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/), documentação do EF Core.
- [`IDbContextFactory<TContext>` interface](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.idbcontextfactory-1), Microsoft Learn.
- [`DbContext.CheckDisposed` source](https://github.com/dotnet/efcore/blob/main/src/EFCore/DbContext.cs), dotnet/efcore no GitHub.
- [Consuming a scoped service in a background task](https://learn.microsoft.com/en-us/dotnet/core/extensions/scoped-service), documentação do .NET.
- [`ServiceProviderServiceExtensions.CreateAsyncScope`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.serviceproviderserviceextensions.createasyncscope), Microsoft Learn.
