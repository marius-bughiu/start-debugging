---
title: "Como executar trabalho fire-and-forget com segurança no ASP.NET Core com BackgroundService"
description: "Chamar Task.Run de um controller perde trabalho ao desligar, engole exceções e captura serviços scoped já descartados. O padrão seguro é uma fila Channel limitada drenada por um BackgroundService, que abre um novo scope por item de trabalho e termina o trabalho em andamento no StopAsync."
pubDate: 2026-05-31
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "backgroundservice"
  - "async"
lang: "pt-br"
translationOf: "2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice"
translatedBy: "claude"
translationDate: 2026-05-31
---

No momento em que você quer que uma requisição HTTP retorne imediatamente enquanto algum trabalho mais lento (enviar um e-mail, gravar um registro de auditoria, chamar um webhook) continua executando, o movimento óbvio é `_ = Task.Run(() => DoTheWorkAsync())` dentro do controller. Compila, a resposta é rápida e em uma demo parece funcionar. Em produção, ele perde trabalho a cada implantação, engole todas as exceções e acessa serviços scoped que já foram descartados. A substituição segura é uma fila `Channel<T>` limitada registrada como singleton, drenada por um único `BackgroundService` que abre um novo scope de DI por item de trabalho, captura e registra as exceções por item, e termina o trabalho em andamento durante um desligamento controlado. Este guia foi escrito para o .NET 11 (preview 4 no momento da escrita, disponibilidade geral prevista para novembro de 2026), `Microsoft.Extensions.Hosting` 11.0.0 e `System.Threading.Channels` da BCL incluída. Os contratos da fila e do `BackgroundService` são estáveis desde o .NET Core 3.1, então cada padrão aqui se aplica sem alterações ao .NET 6, 8 e 10.

## Por que `Task.Run` em um manipulador de requisição é uma armadilha

O atrativo do `Task.Run` é que ele retorna instantaneamente e o framework nunca bloqueia nele. Esse é exatamente o problema: o framework nunca bloqueia nele, nunca o rastreia e nunca espera por ele.

Três falhas concretas decorrem disso:

- **Trabalho perdido ao desligar.** Quando o host desliga (uma implantação, um scale-in, um pod irmão que caiu disparando uma reinicialização gradual), ele não sabe que sua `Task` desanexada existe. Ele para de aceitar requisições, espera pelas requisições que conhece e desmonta o processo. Qualquer trabalho de `Task.Run` ainda em andamento é morto no meio da execução. Em um serviço com bastante carga, cada implantação descarta silenciosamente alguns e-mails ou linhas de auditoria.
- **Exceções engolidas.** Uma exceção não observada em uma `Task` desanexada não derruba a aplicação e não chega ao seu pipeline de log. Ela aparece, se é que aparece, na thread do finalizador como `TaskScheduler.UnobservedTaskException` muito depois de a requisição ter sumido. A primeira vez que você descobre que o trabalho está falhando é quando um cliente pergunta onde está o e-mail dele.
- **Dependências capturadas e descartadas.** Esta é a sutil. Se o seu controller captura um `DbContext` injetado ou qualquer serviço scoped, esse serviço está atrelado ao scope da requisição. O ASP.NET Core descarta o scope da requisição no instante em que a resposta é escrita. O corpo do seu `Task.Run`, ainda executando, agora toca um `DbContext` descartado e lança `ObjectDisposedException: Cannot access a disposed context instance`, ou pior, corre contra o descarte e corrompe o estado.

Há também uma dimensão de carga: um controller que dispara `Task.Run` a cada requisição compete pela mesma pool de threads que serve as suas requisições, então um pico de tráfego se transforma em starvation da pool de threads. Se você quer o detalhamento completo de como o `Task.Run` difere das outras primitivas de descarregamento, a comparação em [Task.Run vs Task.Factory.StartNew vs ThreadPool.QueueUserWorkItem](/pt-br/2026/05/task-run-vs-task-factory-startnew-vs-threadpool-queueuserworkitem/) cobre quando cada uma é apropriada. Para manipuladores de requisição, a resposta é: nenhuma delas diretamente.

O fire-and-forget só é aceitável quando perder o trabalho em uma reinicialização é genuinamente aceitável. O padrão abaixo não torna o trabalho durável (para isso você precisa de uma fila externa como Azure Storage Queues ou um armazenamento de jobs respaldado por banco de dados), mas conserta os outros três problemas e dá ao trabalho em memória um dreno limpo ao desligar.

## A forma do padrão seguro

O próprio [guia de tarefas em fila em segundo plano](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/host/hosted-services) da Microsoft descreve a estrutura canônica, e ela tem três partes:

1. Uma **fila de itens de trabalho** respaldada por um `Channel<Func<CancellationToken, ValueTask>>` limitado, registrada como singleton para que produtores e o consumidor compartilhem uma única instância.
2. Um único **consumidor `BackgroundService`** que itera, retira um item de trabalho por vez, abre um scope de DI, executa-o e captura as exceções por item.
3. **Produtores** (controllers, manipuladores de minimal API, outros serviços) que injetam a interface da fila e enfileiram um delegate em vez de executá-lo inline.

O manipulador de requisição retorna no instante em que o item de trabalho é enfileirado. O trabalho em si executa no consumidor, completamente desacoplado da vida da requisição. Vamos construir cada peça.

## Passo 1: definir e implementar a fila limitada

A fila expõe duas operações: enfileirar (chamada pelos produtores) e desenfileirar (chamada pelo consumidor). O item de trabalho é um `Func<CancellationToken, ValueTask>` para que o consumidor possa passar seu próprio token de cancelamento no momento da execução.

```csharp
// .NET 11, C# 14 - IBackgroundTaskQueue.cs
public interface IBackgroundTaskQueue
{
    ValueTask QueueBackgroundWorkItemAsync(Func<CancellationToken, ValueTask> workItem);

    ValueTask<Func<CancellationToken, ValueTask>> DequeueAsync(
        CancellationToken cancellationToken);
}
```

A implementação envolve um channel limitado. Limitar o channel não é opcional em um serviço de produção: uma fila não limitada sob um produtor que ultrapassa o consumidor é um vazamento de memória com passos extras.

```csharp
// .NET 11, C# 14 - BackgroundTaskQueue.cs
using System.Threading.Channels;

public sealed class BackgroundTaskQueue : IBackgroundTaskQueue
{
    private readonly Channel<Func<CancellationToken, ValueTask>> _queue;

    public BackgroundTaskQueue(int capacity)
    {
        // BoundedChannelFullMode.Wait makes QueueBackgroundWorkItemAsync await
        // a free slot once the queue is full, applying back pressure to producers
        // instead of dropping work or growing without bound.
        var options = new BoundedChannelOptions(capacity)
        {
            FullMode = BoundedChannelFullMode.Wait
        };
        _queue = Channel.CreateBounded<Func<CancellationToken, ValueTask>>(options);
    }

    public async ValueTask QueueBackgroundWorkItemAsync(
        Func<CancellationToken, ValueTask> workItem)
    {
        ArgumentNullException.ThrowIfNull(workItem);
        await _queue.Writer.WriteAsync(workItem);
    }

    public async ValueTask<Func<CancellationToken, ValueTask>> DequeueAsync(
        CancellationToken cancellationToken)
    {
        var workItem = await _queue.Reader.ReadAsync(cancellationToken);
        return workItem;
    }
}
```

A escolha do `BoundedChannelFullMode` é uma decisão de design real. `Wait` (acima) aplica back pressure ao produtor, o que para um manipulador de requisição significa que a chamada de enfileiramento aguarda até haver espaço. Se você preferir descartar carga em vez de fazer uma requisição esperar, use `BoundedChannelFullMode.DropWrite` e verifique o valor de retorno de `TryWrite`. Seja qual for a sua escolha, faça-a deliberadamente. Se channels são novidade para você, [usar Channels em vez de BlockingCollection](/pt-br/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) explica o modelo leitor/escritor e por que `Channel<T>` é a primitiva produtor-consumidor assíncrona correta no .NET moderno.

## Passo 2: o BackgroundService que drena a fila

O consumidor é um único `BackgroundService`. Sua única tarefa é puxar um item de trabalho por vez e executá-lo dentro de um try/catch para que um único item de trabalho envenenado não possa matar o loop.

```csharp
// .NET 11, C# 14 - QueuedHostedService.cs
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

public sealed class QueuedHostedService(
    IBackgroundTaskQueue taskQueue,
    ILogger<QueuedHostedService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("Queued hosted service is running.");
        await BackgroundProcessing(stoppingToken);
    }

    private async Task BackgroundProcessing(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            var workItem = await taskQueue.DequeueAsync(stoppingToken);

            try
            {
                await workItem(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                // Expected during shutdown; let the loop unwind.
                break;
            }
            catch (Exception ex)
            {
                // The whole point: one failing item is logged, not lost, and the
                // loop survives to process the next item.
                logger.LogError(ex, "Error occurred executing background work item.");
            }
        }
    }

    public override async Task StopAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("Queued hosted service is stopping.");
        await base.StopAsync(stoppingToken);
    }
}
```

O try/catch por item é a diferença entre isto e o `Task.Run`. Com `Task.Run`, uma exceção fica não observada. Aqui, cada falha cai no `ILogger` com um stack trace, e o consumidor continua drenando. Esta é também a razão pela qual o item de trabalho é um `Func` que retorna `ValueTask` em vez de um delegate `async void`: um corpo `async void` lança no vazio e você volta às exceções engolidas. Se a distinção entre `async void` e `async Task` está confusa, [async void vs async Task em C#](/pt-br/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) expõe exatamente por que `async void` fica reservado para manipuladores de eventos e nada mais.

## Passo 3: registrar tudo

A fila é um singleton (uma única instância compartilhada), o consumidor é um serviço hospedado e você escolhe uma capacidade. A capacidade deve refletir quanto trabalho você está disposto a manter em memória de uma vez.

```csharp
// .NET 11, C# 14 - Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddHostedService<QueuedHostedService>();
builder.Services.AddSingleton<IBackgroundTaskQueue>(_ =>
{
    // Tune to your workload. 100 means at most 100 queued items before
    // producers start waiting (with BoundedChannelFullMode.Wait).
    const int queueCapacity = 100;
    return new BackgroundTaskQueue(queueCapacity);
});

builder.Services.AddControllers();

var app = builder.Build();
app.MapControllers();
app.Run();
```

## Passo 4: enfileirar a partir de um manipulador de requisição, com um scope por item de trabalho

Agora o produtor. Um controller injeta `IBackgroundTaskQueue` e enfileira um delegate. O detalhe crítico: o delegate **não** deve capturar nenhum serviço scoped da requisição. O scope da requisição já sumiu no momento em que o trabalho executa. Em vez disso, capture apenas dados simples (um id de pedido, uma string), e resolva os serviços scoped a partir de um novo scope dentro do delegate usando `IServiceScopeFactory`.

```csharp
// .NET 11, C# 14 - OrdersController.cs
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;

[ApiController]
[Route("orders")]
public sealed class OrdersController(
    IBackgroundTaskQueue queue,
    IServiceScopeFactory scopeFactory) : ControllerBase
{
    [HttpPost("{id:int}/confirm")]
    public async Task<IActionResult> Confirm(int id)
    {
        // Capture only the id - a value type, not a scoped service.
        await queue.QueueBackgroundWorkItemAsync(async token =>
        {
            // Fresh scope per work item: a clean DbContext, resolved and disposed here.
            await using var scope = scopeFactory.CreateAsyncScope();
            var processor = scope.ServiceProvider.GetRequiredService<IOrderProcessor>();
            await processor.ConfirmAsync(id, token);
        });

        // Returns immediately; the confirmation runs on the consumer.
        return Accepted();
    }
}
```

`HTTP 202 Accepted` é o código de status honesto aqui: você aceitou a requisição para processamento, não a concluiu. Retornar `200 OK` implicaria que o trabalho está feito, o que não é o caso.

A regra de um scope por item de trabalho é a mesma disciplina que você precisa em qualquer lugar onde um singleton toca serviços scoped. Abrir um `CreateAsyncScope()` por unidade de trabalho, resolver dentro dele e descartá-lo quando o trabalho termina é coberto em profundidade em [usar serviços scoped dentro de um BackgroundService](/pt-br/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/). A razão pela qual `await using` e `CreateAsyncScope()` importam (em vez do `CreateScope()` síncrono) é que o `DbContext` do EF Core implementa `IAsyncDisposable` e pode lançar se for descartado de forma síncrona.

Se você pular o scope e em vez disso capturar o `DbContext` da requisição diretamente no delegate, você reproduz exatamente o bug da dependência descartada do início deste artigo, e frequentemente [o erro de segunda operação na instância do contexto](/pt-br/2026/05/fix-second-operation-was-started-on-this-context-instance/) quando uma requisição posterior reutiliza um contexto que o framework acha que liberou. E se você tentar injetar o serviço scoped diretamente em um consumidor singleton para "simplificar" as coisas, você esbarra em [não é possível consumir um serviço scoped a partir de um singleton](/pt-br/2026/05/fix-cannot-consume-scoped-service-from-singleton/) ao iniciar.

## Desligamento controlado: drenar versus abandonar

É aqui que o padrão prova seu valor sobre o `Task.Run`. O `BackgroundService` participa da sequência de desligamento do host. Quando o host para, ele sinaliza `stoppingToken`, e o host aguarda até o tempo limite de desligamento (30 segundos por padrão) para que `StopAsync` retorne.

Vale a pena ser deliberado quanto a dois comportamentos:

**Parar de aceitar, terminar o item atual.** Com o loop acima, `DequeueAsync(stoppingToken)` lança `OperationCanceledException` assim que o token dispara, o loop quebra, e qualquer item de trabalho em execução no momento termina (porque fazemos `await workItem(stoppingToken)` antes de voltar ao loop). Itens ainda parados no channel são abandonados. Para o fire-and-forget em memória, esse é o trade-off aceito.

**Dar tempo suficiente ao trabalho em andamento.** Se seus itens de trabalho podem executar por mais de alguns segundos, aumente o tempo limite de desligamento para que o host não mate um item pela metade:

```csharp
// .NET 11, C# 14 - Program.cs
builder.Services.Configure<HostOptions>(options =>
{
    options.ShutdownTimeout = TimeSpan.FromSeconds(60);
});
```

Um produtor que precisa que o trabalho esteja atrelado à vida da aplicação em vez de a uma requisição pode receber `IHostApplicationLifetime` e enfileirar contra `ApplicationStopping`, mas para o trabalho originado de uma requisição o `stoppingToken` do consumidor é o sinal correto. Faça o que fizer, propague o token até o fim do seu item de trabalho. Um item de trabalho que ignora o token e bloqueia vai manter todo o desligamento refém pelo tempo limite completo. Para o trabalho que genuinamente não pode ser cancelado de forma cooperativa, [cancelar uma Task de longa execução sem deadlock](/pt-br/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) cobre as opções.

## Processar itens em paralelo sem compartilhar um scope

O loop de consumidor único processa um item por vez. Se seus itens de trabalho são independentes e você quer throughput, pode executar vários concorrentemente, mas cada item concorrente deve receber seu próprio scope, porque um `DbContext` e um scope de DI não são thread-safe. Limite a concorrência com um `SemaphoreSlim` para que uma rajada de enfileiramentos não possa saturar a pool de threads:

```csharp
// .NET 11, C# 14 - inside BackgroundProcessing
private readonly SemaphoreSlim _concurrency = new(initialCount: 4);

private async Task BackgroundProcessing(CancellationToken stoppingToken)
{
    while (!stoppingToken.IsCancellationRequested)
    {
        var workItem = await taskQueue.DequeueAsync(stoppingToken);
        await _concurrency.WaitAsync(stoppingToken);

        // Fire each item on its own task; the semaphore caps concurrency at 4.
        _ = Task.Run(async () =>
        {
            try
            {
                await workItem(stoppingToken);
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Error executing background work item.");
            }
            finally
            {
                _concurrency.Release();
            }
        }, stoppingToken);
    }
}
```

Note que o `Task.Run` aqui é aceitável de uma forma que não era no controller: ele está dentro de um `BackgroundService` rastreado, cada exceção é capturada e registrada, a concorrência é limitada, e cada item de trabalho já cria seu próprio scope internamente. O que tornava o `Task.Run` perigoso em um manipulador de requisição (sem rastreamento, sem tratamento de exceções, scope da requisição capturado) está ausente aqui. O trade-off é que o processamento em paralelo complica a história do desligamento, porque os itens em andamento não são mais aguardados pelo loop. Se você precisa tanto de paralelismo quanto de um dreno limpo, rastreie as tarefas pendentes em uma `List<Task>` e faça `await Task.WhenAll` sobre elas no `StopAsync`.

## Quando uma fila Channel não é suficiente

Este padrão mantém tudo na memória do processo. Essa é a sua força (zero infraestrutura externa) e o seu limite. Recorra a algo mais pesado quando:

- **O trabalho precisa sobreviver a uma reinicialização.** Se perder o trabalho enfileirado em uma implantação é inaceitável, você precisa de uma durabilidade que o channel não pode dar. Persista o job em uma tabela de banco de dados ou empurre-o para Azure Storage Queues / Amazon SQS, e faça o `BackgroundService` (ou um processo de trabalho separado) puxar de lá. A forma de enfileirar/consumir permanece idêntica; apenas o armazenamento de respaldo muda.
- **Você executa múltiplas instâncias e precisa de exatamente uma vez.** Uma fila em memória é por instância. Três pods significam três filas independentes. Uma fila durável compartilhada com um lease de tempo de visibilidade é a maneira de coordenar.
- **Você precisa de retentativas, agendamento ou painéis.** Nesse ponto, uma biblioteca como o Hangfire ou uma plataforma de jobs hospedada justifica sua complexidade. Não reconstrua um agendador de jobs sobre um channel.

Para os workers de longa vida que você mantém em produção, combine a fila com observabilidade para que um consumidor travado ou que falha silenciosamente venha à tona antes que os usuários percebam; a abordagem em [monitorar jobs em segundo plano sem Hangfire](/pt-br/2026/01/monitor-background-jobs-in-net-9-and-net-10-without-hangfire-health-metrics-alerts/) se aplica diretamente a este consumidor.

O modelo mental que mantém tudo isso correto: a tarefa do manipulador de requisição é *aceitar* trabalho e retornar, o consumidor singleton *é dono do loop e do cancelamento*, e cada item de trabalho *é dono de um novo scope para o seu próprio estado*. No instante em que você colapsa essas responsabilidades (executando o trabalho inline, capturando o scope da requisição, ou desanexando uma `Task` não rastreada), uma das três falhas do início deste artigo volta.

## Fontes

- Microsoft Learn, [Background tasks with hosted services in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/host/hosted-services) (atualizado 2026-05-05), o padrão canônico de tarefas em fila em segundo plano sobre o qual este post é construído.
- Microsoft Learn, [System.Threading.Channels](https://learn.microsoft.com/en-us/dotnet/core/extensions/channels) para `BoundedChannelOptions` e `BoundedChannelFullMode`.
- Microsoft Learn, [`HostOptions.ShutdownTimeout`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.hosting.hostoptions.shutdowntimeout) para ajustar a janela de desligamento controlado.
- Microsoft Learn, [`AsyncServiceScope` e `CreateAsyncScope`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.serviceproviderserviceextensions.createasyncscope) para o descarte de scope por item de trabalho.
