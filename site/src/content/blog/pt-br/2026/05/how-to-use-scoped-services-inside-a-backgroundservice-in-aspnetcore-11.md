---
title: "Como usar serviços scoped dentro de um BackgroundService no ASP.NET Core 11"
description: "Um BackgroundService é um singleton, então não pode injetar diretamente um serviço scoped como um DbContext. Receba IServiceScopeFactory, abra um scope por unidade de trabalho com CreateAsyncScope, resolva dentro dele e descarte-o quando o trabalho terminar."
pubDate: 2026-05-31
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "dependency-injection"
  - "backgroundservice"
lang: "pt-br"
translationOf: "2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-05-31
---

Um `BackgroundService` é registrado como singleton, então injetar diretamente no seu construtor um serviço scoped como um `DbContext` ou lança `Cannot consume scoped service 'X' from singleton 'Y'` na inicialização ou, pior ainda, prende essa instância scoped ao tempo de vida de todo o seu processo. A solução é receber `IServiceScopeFactory`, abrir um scope novo com `CreateAsyncScope()` para cada unidade de trabalho dentro de `ExecuteAsync`, resolver o serviço scoped a partir do provider desse scope e descartar o scope quando o trabalho terminar. Este guia foi escrito para o .NET 11 (preview 4 no momento da escrita, com disponibilidade geral prevista para novembro de 2026), `Microsoft.Extensions.Hosting` 11.0.0 e EF Core 11. Os contratos de `BackgroundService` e `IServiceScopeFactory` são estáveis desde o .NET Core 3.1, então todos os padrões daqui também se aplicam sem alterações ao .NET 6, 8 e 10.

## Por que um BackgroundService não pode simplesmente injetar um serviço scoped

Todo serviço hospedado que você registra com `AddHostedService<T>` é um singleton. Esse não é um padrão que você possa sobrescrever: `AddHostedService<T>` e `AddSingleton<IHostedService, T>` resolvem para o mesmo registro, e o host obtém a instância a partir do provider **raiz** durante `StartAsync`. O provider raiz não tem nenhum scope ambiental.

Um serviço scoped, por definição, vive uma vez por scope. Em uma requisição web esse scope é criado e descartado por requisição. Um `BackgroundService` é executado durante todo o tempo de vida do host, completamente fora de qualquer requisição. Então não há scope contra o qual o runtime possa resolver uma dependência scoped. Se você escrever um construtor como `OrderWorker(AppDbContext db)`, uma de duas coisas acontece:

- No `Development`, `WebApplication.CreateBuilder` ativa `ValidateScopes`, o validador de call sites percorre o grafo durante o build, vê um serviço scoped fluindo para um singleton e lança `Cannot consume scoped service ...`. Se essa for a exceção exata com a qual você chegou aqui, o guia dedicado de [não é possível consumir um serviço scoped a partir de um singleton](/pt-br/2026/05/fix-cannot-consume-scoped-service-from-singleton/) percorre cada variante.
- No `Production`, a validação de scopes está desativada por padrão, então o mesmo código compila e executa. O `DbContext` fica capturado pela vida do processo. Seu change tracker acumula cada entidade que você já carregou, sua conexão nunca volta de forma limpa ao pool e cedo ou tarde você esbarra em `ObjectDisposedException` ou leituras obsoletas.

Nenhum dos dois resultados é o que você quer. O modelo correto é: o worker singleton é dono do loop e do cancelamento, e cada iteração toma emprestado um scope de vida curta para fazer o trabalho real.

## Configure a resolução scoped em quatro passos

O próprio [guia de serviços worker da Microsoft](https://learn.microsoft.com/en-us/dotnet/core/extensions/scoped-service) recomenda delegar o trabalho real a um serviço scoped e manter o próprio `BackgroundService` enxuto. Aqui está a forma completa em quatro passos.

1. **Registre o serviço scoped** com `AddScoped`, exatamente como você faria para um consumidor ligado a uma requisição. Nada de especial é necessário porque ele é usado em um contexto de fundo.
2. **Registre o worker** com `AddHostedService<T>`. Ele continua sendo um singleton; não tente torná-lo scoped.
3. **Receba `IServiceScopeFactory`** (não o serviço scoped, nem `IServiceProvider`) no construtor do worker.
4. **Abra um scope por unidade de trabalho** dentro de `ExecuteAsync` com `CreateAsyncScope()`, resolva o serviço scoped a partir de `scope.ServiceProvider`, faça o trabalho e deixe o `await using` descartar o scope.

### Passos 1 e 2: registro

```csharp
// .NET 11, C# 14 - Program.cs
using App.Workers;

var builder = WebApplication.CreateBuilder(args);

// The scoped unit of work. Registered exactly like any request-scoped service.
builder.Services.AddScoped<IOrderProcessor, OrderProcessor>();

// The worker stays a singleton. AddHostedService always registers a singleton.
builder.Services.AddHostedService<OrderWorker>();

var app = builder.Build();
app.Run();
```

### Passos 3 e 4: o worker

```csharp
// .NET 11, C# 14
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace App.Workers;

public sealed class OrderWorker(
    IServiceScopeFactory scopeFactory,
    ILogger<OrderWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("OrderWorker started.");

        while (!stoppingToken.IsCancellationRequested)
        {
            // One scope per iteration: a fresh DbContext, change tracker, and
            // connection scope every time, disposed at the end of the block.
            await using var scope = scopeFactory.CreateAsyncScope();

            var processor = scope.ServiceProvider
                .GetRequiredService<IOrderProcessor>();

            await processor.ProcessPendingAsync(stoppingToken);

            await Task.Delay(TimeSpan.FromSeconds(10), stoppingToken);
        }
    }
}
```

O serviço scoped que contém toda a lógica real e as dependências scoped:

```csharp
// .NET 11, C# 14
namespace App.Workers;

public interface IOrderProcessor
{
    Task ProcessPendingAsync(CancellationToken cancellationToken);
}

public sealed class OrderProcessor(
    AppDbContext db,                 // scoped, injected normally now
    ILogger<OrderProcessor> logger) : IOrderProcessor
{
    public async Task ProcessPendingAsync(CancellationToken cancellationToken)
    {
        var pending = await db.Orders
            .Where(o => o.Status == OrderStatus.Pending)
            .ToListAsync(cancellationToken);

        foreach (var order in pending)
        {
            order.Status = OrderStatus.Processed;
        }

        await db.SaveChangesAsync(cancellationToken);
        logger.LogInformation("Processed {Count} orders.", pending.Count);
    }
}
```

`OrderProcessor` injeta `AppDbContext` diretamente porque ele mesmo é scoped e só é resolvido de dentro de um scope. O worker singleton nunca vê o `DbContext`. Essa separação é todo o truque: o descompasso de tempos de vida desaparece no momento em que o grafo scoped é resolvido a partir de um scope real em vez da raiz.

## CreateAsyncScope versus CreateScope

Use `CreateAsyncScope()`, não `CreateScope()`, para quase todo código moderno. A diferença está no descarte.

`CreateScope()` retorna um `IServiceScope` que descarta seus serviços scoped de forma síncrona via `IDisposable.Dispose()`. `CreateAsyncScope()` retorna um `AsyncServiceScope` que descarta via `IAsyncDisposable.DisposeAsync()` quando o serviço o implementa, e recorre ao descarte síncrono quando não.

Isso importa porque o `DbContext` do EF Core no .NET 11 implementa `IAsyncDisposable`, e várias configurações (contextos pooled, contextos que mantêm aberta uma `DbConnection`) lançarão exceção se descartados de forma síncrona. Se você escrever `using var scope = scopeFactory.CreateScope();` e o scope contiver um contexto que exige descarte assíncrono, você recebe uma exceção no fim do bloco que não tem nada a ver com o seu trabalho real.

```csharp
// .NET 11 - prefer this
await using var scope = scopeFactory.CreateAsyncScope();

// Only use the sync form when nothing in the scope needs async disposal
using var syncScope = scopeFactory.CreateScope();
```

O custo de `CreateAsyncScope()` em relação a `CreateScope()` é praticamente zero quando nada precisa de descarte assíncrono, então não há razão para recorrer à versão síncrona por padrão.

## Um scope por unidade de trabalho, não um por processo

O erro mais comum depois de mudar para `IServiceScopeFactory` é tirar o scope para fora do loop:

```csharp
// .NET 11 - WRONG. The scope lives for the whole process.
protected override async Task ExecuteAsync(CancellationToken stoppingToken)
{
    await using var scope = scopeFactory.CreateAsyncScope();      // created once
    var processor = scope.ServiceProvider.GetRequiredService<IOrderProcessor>();

    while (!stoppingToken.IsCancellationRequested)
    {
        await processor.ProcessPendingAsync(stoppingToken);       // same DbContext forever
        await Task.Delay(TimeSpan.FromSeconds(10), stoppingToken);
    }
}
```

Isso compila, passa pela validação de scopes e reintroduz exatamente o bug que você estava tentando corrigir. O `DbContext` resolvido uma única vez agora vive por toda a vida do worker. Seu change tracker cresce sem limite a cada iteração, as consultas ficam mais lentas à medida que o grafo rastreado se expande, e um único `SaveChanges` que falhe pode deixar o contexto em um estado que envenena cada iteração seguinte. Você também reabre a porta para [o erro da segunda operação na instância do contexto](/pt-br/2026/05/fix-second-operation-was-started-on-this-context-instance/) no momento em que duas iterações se sobrepõem.

Crie o scope **dentro** do loop. Um scope é barato. O sentido do padrão é que cada unidade de trabalho receba uma lousa limpa: um contexto novo, um change tracker novo e uma conexão tirada do pool e devolvida no fim da iteração.

## Serviços scoped em um worker que drena uma fila

O scope por iteração se generaliza naturalmente para um worker que drena um `Channel<T>`. Cada item retirado da fila é sua própria unidade de trabalho, então cada um recebe seu próprio scope:

```csharp
// .NET 11, C# 14
using System.Threading.Channels;

public sealed class OrderQueueWorker(
    Channel<int> queue,
    IServiceScopeFactory scopeFactory) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var orderId in queue.Reader.ReadAllAsync(stoppingToken))
        {
            await using var scope = scopeFactory.CreateAsyncScope();
            var processor = scope.ServiceProvider
                .GetRequiredService<IOrderProcessor>();

            await processor.ProcessOneAsync(orderId, stoppingToken);
        }
    }
}
```

`ReadAllAsync` já respeita o token de cancelamento, então o loop se desfaz de forma limpa no desligamento. Cada mensagem é processada de forma isolada, e uma mensagem envenenada que lança exceção dentro de um scope não corrompe o contexto usado no próximo.

## EF Core: IServiceScopeFactory versus IDbContextFactory

Quando a única dependência scoped de que você precisa é um `DbContext`, o EF Core lhe dá uma ferramenta mais direta: `IDbContextFactory<T>`. Registre-a com `AddDbContextFactory`, que registra a factory como singleton, e injete a factory diretamente no worker:

```csharp
// .NET 11, EF Core 11 - Program.cs
builder.Services.AddDbContextFactory<AppDbContext>(options =>
    options.UseSqlServer(builder.Configuration.GetConnectionString("Default")));
```

```csharp
// .NET 11, EF Core 11
public sealed class OrderWorker(
    IDbContextFactory<AppDbContext> dbFactory) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            await using var db = await dbFactory.CreateDbContextAsync(stoppingToken);

            var pending = await db.Orders
                .Where(o => o.Status == OrderStatus.Pending)
                .ToListAsync(stoppingToken);

            // process...
            await db.SaveChangesAsync(stoppingToken);

            await Task.Delay(TimeSpan.FromSeconds(10), stoppingToken);
        }
    }
}
```

A regra de decisão é simples. Se sua unidade de trabalho precisa **apenas** de um `DbContext`, use `IDbContextFactory<T>`: não há cerimônia de scope, e a factory lhe entrega um contexto novo e corretamente descartado a cada chamada. Se sua unidade de trabalho precisa de um grafo de serviços scoped (um repositório, um resolvedor de tenant, um `IOptionsSnapshot<T>`, um serviço de domínio que por sua vez depende do contexto), use `IServiceScopeFactory` para que todo o grafo seja resolvido de forma consistente dentro de um único scope. Você pode registrar `AddDbContext` para código ligado a requisições e `AddDbContextFactory` para o worker no mesmo aplicativo.

## Um scope não é thread-safe: o paralelismo precisa de um scope por tarefa

Se você processa itens em paralelo, não compartilhe um único scope entre as tarefas paralelas. Um `DbContext` não é thread-safe, e a resolução de um scope também não. Dê a cada ramo paralelo seu próprio scope:

```csharp
// .NET 11, C# 14
await Parallel.ForEachAsync(
    orderIds,
    new ParallelOptions
    {
        MaxDegreeOfParallelism = 4,
        CancellationToken = stoppingToken
    },
    async (orderId, ct) =>
    {
        await using var scope = scopeFactory.CreateAsyncScope();
        var processor = scope.ServiceProvider
            .GetRequiredService<IOrderProcessor>();
        await processor.ProcessOneAsync(orderId, ct);
    });
```

Cada invocação do corpo recebe um scope independente, um `DbContext` independente e um change tracker independente, que é exatamente o isolamento de que você precisa para trabalho concorrente.

## Desligamento gracioso e StopAsync

`stoppingToken` é sinalizado quando o host começa a desligar. Passá-lo para cada chamada assíncrona dentro do scope (a consulta, o `SaveChanges`, o `Task.Delay`) é o que permite que o worker pare prontamente em vez de bloquear o desligamento até o tempo limite de desligamento do host (30 segundos por padrão).

Se você precisa fazer limpeza quando o host para, sobrescreva `StopAsync` e chame a implementação base:

```csharp
// .NET 11, C# 14
public override async Task StopAsync(CancellationToken cancellationToken)
{
    logger.LogInformation("OrderWorker stopping, draining in-flight work.");
    await base.StopAsync(cancellationToken);
}
```

Uma sutileza: uma chamada bloqueante longa dentro do loop que ignore `stoppingToken` não será interrompida, e o host espera o tempo de desligamento completo antes de derrubar o processo. Se sua unidade de trabalho pode rodar por muito tempo, propague o token de ponta a ponta. Para a questão relacionada de parar trabalho que não coopera com o cancelamento, veja [cancelar uma Task de longa duração em C# sem causar deadlocks](/pt-br/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking).

## Erros que sobrevivem à validação de scopes

Todos estes compilam e passam pelo `ValidateScopes`, e é por isso que vale a pena nomeá-los:

- **Injetar `IServiceProvider` em vez de `IServiceScopeFactory`.** O provider injetado em um singleton é o provider raiz. Resolver um serviço scoped a partir dele lança exceção ou o captura, dependendo da configuração de validação. Sempre injete `IServiceScopeFactory` e chame `CreateAsyncScope()`.
- **Resolver a partir do provider raiz capturado dentro do scope.** Escreva `scope.ServiceProvider.GetRequiredService<T>()`, nunca `_rootProvider.GetRequiredService<T>()`. Resolver a partir da raiz dentro de um scope que você abriu anula o scope por completo.
- **Armazenar um serviço scoped resolvido em um campo.** A instância não deve sobreviver ao scope. Passe-a como parâmetro de método e deixe-a sair do scope com o `await using`.
- **Esquecer o `await using`.** Um simples `var scope = scopeFactory.CreateAsyncScope();` sem descarte vaza o scope e cada serviço que ele contém por toda a vida do processo.

Para workers que você pretende rodar em produção, combine este padrão com observabilidade adequada para que um loop travado ou que falha em silêncio venha à tona; a abordagem em [monitorar tarefas em segundo plano sem Hangfire](/pt-br/2026/01/monitor-background-jobs-in-net-9-and-net-10-without-hangfire-health-metrics-alerts) se aplica diretamente. E para um exemplo completo do mesmo padrão de scope factory em torno de uma dependência não trivial, veja [executar um plugin do Semantic Kernel a partir de um BackgroundService](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/).

O modelo mental que mantém isso correto: o singleton é dono do loop e do cancelamento; o scope é dono do trabalho e do estado por unidade. Mantenha essas duas responsabilidades separadas e os erros de tempo de vida nunca aparecerão.

## Fontes

- Microsoft Learn, [Use scoped services within a BackgroundService](https://learn.microsoft.com/en-us/dotnet/core/extensions/scoped-service) (atualizado em 2026-05-27), o tutorial canônico de serviços worker.
- Microsoft Learn, [Dependency injection in .NET: service lifetimes](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection#service-lifetimes).
- Microsoft Learn, [`AsyncServiceScope` and `CreateAsyncScope`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.serviceproviderserviceextensions.createasyncscope).
- Microsoft Learn, [Using a DbContext factory](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/#using-a-dbcontext-factory-eg-for-blazor).
- .NET Blog, [.NET 11 Preview 1 is now available](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-1/).
