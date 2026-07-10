---
title: "O que e o contrato IHostedService e quando devo usa-lo?"
description: "IHostedService e a interface de dois metodos (StartAsync/StopAsync) que o host generico do .NET chama na inicializacao e no encerramento gracioso. Aqui esta o que o contrato promete, quando implementa-lo diretamente e as mudancas de comportamento do .NET 10 e 11 que pegam as pessoas de surpresa."
pubDate: 2026-07-10
tags:
  - "dotnet"
  - "aspnetcore"
  - "csharp"
lang: "pt-br"
translationOf: "2026/07/what-is-the-ihostedservice-contract-and-when-do-i-use-it"
translatedBy: "claude"
translationDate: 2026-07-10
---

`IHostedService` e a interface de dois metodos que o host generico do .NET usa para iniciar e parar trabalho de longa duracao junto com a sua aplicacao. Ela tem exatamente dois membros, `StartAsync(CancellationToken)` e `StopAsync(CancellationToken)`, e o host os chama em pontos bem definidos: `StartAsync` antes de a app comecar a atender requisicoes, `StopAsync` durante o encerramento gracioso. Voce a implementa diretamente quando precisa de controle preciso sobre etapas ordenadas de inicializacao ou encerramento. Para loops continuos voce quase sempre vai querer `BackgroundService`, uma pequena classe abstrata que implementa `IHostedService` para voce. Este artigo explica o que o contrato realmente garante, quando recorrer a interface crua e as mudancas de comportamento do .NET 10 e .NET 11 que fazem as pessoas tropecarem.

Tudo aqui tem como alvo o .NET 11 e o C# 14, com `Microsoft.Extensions.Hosting` 11.0.x. Onde o comportamento mudou em uma versao especifica, eu destaco.

## O contrato sao dois metodos e uma promessa de sequenciamento

Esta e a interface inteira:

```csharp
// .NET 11, C# 14 -- Microsoft.Extensions.Hosting.Abstractions
public interface IHostedService
{
    Task StartAsync(CancellationToken cancellationToken);
    Task StopAsync(CancellationToken cancellationToken);
}
```

Essa e toda a superficie. O que a torna util nao e o formato dos metodos, mas as garantias que o host envolve em torno deles:

- O host aguarda (`await`) o `StartAsync` de cada servico hospedado registrado **antes** de considerar a aplicacao iniciada. Em uma app ASP.NET Core, isso significa antes de o Kestrel aceitar a primeira requisicao.
- Por padrao, os servicos iniciam **de forma sequencial, na ordem de registro**. O host nao chama o `StartAsync` do proximo servico ate que o `Task` retornado pelo atual se complete.
- No encerramento, o host chama `StopAsync` em cada servico, na ordem **inversa** de registro, e aguarda ate `HostOptions.ShutdownTimeout` (30 segundos por padrao) para que terminem.

A promessa de sequenciamento e o motivo para se importar. Se voce precisa de "aqueca este cache antes que qualquer requisicao possa atingir um caminho frio" ou "abra esta conexao antes de o consumidor da fila iniciar", `StartAsync` e o gancho correto, porque o host nao prossegue ate ele retornar.

## Por que StartAsync deve ser rapido

Como a inicializacao e sequencial por padrao, um `StartAsync` lento atrasa todos os servicos registrados depois dele e atrasa toda a aplicacao a ficar online. Este e o erro mais comum com a interface crua: colocar um loop de longa duracao diretamente dentro de `StartAsync` e nunca retornar.

```csharp
// .NET 11, C# 14 -- WRONG: the host never finishes starting
public sealed class BrokenWorker : IHostedService
{
    public async Task StartAsync(CancellationToken ct)
    {
        // This loop never returns, so StartAsync never completes,
        // so the host never starts, so no requests are served.
        while (!ct.IsCancellationRequested)
        {
            await DoWorkAsync();
            await Task.Delay(TimeSpan.FromSeconds(5), ct);
        }
    }

    public Task StopAsync(CancellationToken ct) => Task.CompletedTask;
}
```

A correcao e tratar `StartAsync` como "dispare o trabalho e retorne". Inicie o loop como um `Task` em segundo plano, guarde uma referencia a ele e aguarde essa referencia no `StopAsync`:

```csharp
// .NET 11, C# 14 -- correct raw IHostedService with a background loop
public sealed class QueueDrainService(ILogger<QueueDrainService> logger) : IHostedService
{
    private readonly CancellationTokenSource _stopping = new();
    private Task? _loop;

    public Task StartAsync(CancellationToken ct)
    {
        // Return quickly. Capture the loop task; do not await it here.
        _loop = RunAsync(_stopping.Token);
        return Task.CompletedTask;
    }

    private async Task RunAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try { await DrainOnceAsync(ct); }
            catch (OperationCanceledException) { break; }
            catch (Exception ex) { logger.LogError(ex, "Drain failed; retrying"); }
            await Task.Delay(TimeSpan.FromSeconds(5), ct);
        }
    }

    public async Task StopAsync(CancellationToken ct)
    {
        _stopping.Cancel();
        // Wait for the loop to unwind, but respect the shutdown deadline.
        if (_loop is not null)
            await _loop.WaitAsync(ct).ConfigureAwait(false);
    }

    private static Task DrainOnceAsync(CancellationToken ct) => Task.CompletedTask;
}
```

Se esse padrao parece codigo repetitivo, esse e exatamente o ponto: e o codigo repetitivo que `BackgroundService` existe para remover.

## Onde o BackgroundService se encaixa

`BackgroundService` e uma classe abstrata no mesmo namespace que implementa `IHostedService` e da a voce um unico metodo para sobrescrever:

```csharp
// .NET 11, C# 14 -- the shape BackgroundService hands you
public sealed class QueueDrainService(ILogger<QueueDrainService> logger)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await DrainOnceAsync(stoppingToken); }
            catch (OperationCanceledException) { break; }
            catch (Exception ex) { logger.LogError(ex, "Drain failed; retrying"); }
            await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
        }
    }

    private static Task DrainOnceAsync(CancellationToken ct) => Task.CompletedTask;
}
```

A classe base armazena a tarefa retornada por `ExecuteAsync`, cancela o `stoppingToken` quando o host para e aguarda o seu loop no seu proprio `StopAsync`. E o mesmo ciclo de vida do exemplo cru acima, menos o encanamento.

Entao a regra pratica e: **implemente `IHostedService` diretamente apenas quando precisar que um trabalho se complete dentro de `StartAsync` antes de a app ficar online, ou trabalho ordenado de encerramento dentro de `StopAsync`.** Para um loop continuo que so precisa rodar enquanto a app roda, use `BackgroundService`. Se quiser a comparacao mais aprofundada que inclui sistemas de jobs duraveis, veja [a matriz de decisao entre BackgroundService, IHostedService e Hangfire](/pt-br/2026/06/backgroundservice-vs-ihostedservice-vs-hangfire-for-background-jobs-in-dotnet-11/).

## A mudanca do .NET 10 que moveu ExecuteAsync para fora da thread principal

Antes do .NET 10 havia uma armadilha sutil no `BackgroundService`: a porcao sincrona de `ExecuteAsync`, ou seja tudo antes do primeiro `await`, rodava na thread principal durante a inicializacao e bloqueava outros servicos de iniciar. Apenas o codigo apos o primeiro `await` passava para uma thread em segundo plano.

A partir do .NET 10, [o `BackgroundService` roda a totalidade de `ExecuteAsync` em uma thread em segundo plano](https://learn.microsoft.com/en-us/dotnet/core/compatibility/extensions/10.0/backgroundservice-executeasync-task), entao nenhuma parte dele bloqueia outros servicos de iniciar. E uma correcao bem-vinda, mas muda uma suposicao da qual algum codigo dependia. Se voce fazia deliberadamente trabalho de configuracao antes do primeiro `await` para que rodasse durante a inicializacao, esse trabalho agora esta fora do caminho de inicializacao.

Se voce precisa que algo rode de forma sincrona durante a inicializacao novamente, a documentacao detalha as opcoes: faca isso no construtor, sobrescreva `StartAsync` e rode antes de `base.StartAsync`, implemente `IHostedLifecycleService` (mais abaixo) ou desca para um `IHostedService` cru. A interface crua nunca teve essa ambiguidade, o que e mais um motivo para usa-la quando a ordem de inicializacao realmente importa.

## IHostedLifecycleService para ganchos mais granulares

Quando dois ganchos `StartAsync` nao bastam, o .NET 8 adicionou `IHostedLifecycleService`, que estende `IHostedService` com mais quatro callbacks:

```csharp
// .NET 11, C# 14 -- extends IHostedService with pre/post hooks
public interface IHostedLifecycleService : IHostedService
{
    Task StartingAsync(CancellationToken cancellationToken);
    Task StartedAsync(CancellationToken cancellationToken);
    Task StoppingAsync(CancellationToken cancellationToken);
    Task StoppedAsync(CancellationToken cancellationToken);
}
```

O host os invoca em torno dos dois metodos centrais nesta ordem: `StartingAsync` em todos os servicos, depois `StartAsync` em todos os servicos, depois `StartedAsync` em todos os servicos. O encerramento espelha isso: `StoppingAsync`, depois `StopAsync`, depois `StoppedAsync`. A distincao em relacao ao `IHostedService` simples e que essas fases rodam como *lotes* atraves de cada servico, entao `StartingAsync` e o lugar para rodar trabalho que deve acontecer antes do `StartAsync` de **qualquer** servico, nao apenas do proprio.

Voce raramente precisa disso. Recorra a ele quando tiver restricoes de ordem entre servicos, como "cada servico deve ter terminado seu trabalho de pre-inicio antes que qualquer um deles abra um listener de rede". Para o caso comum, `IHostedService` simples ou `BackgroundService` basta.

## Registrando servicos hospedados

O registro e uma unica linha, e o tempo de vida de DI e fixo:

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddHostedService<QueueDrainService>();
builder.Services.AddHostedService<CacheWarmer>();

var app = builder.Build();
app.Run();
```

`AddHostedService<T>` registra o tipo como um `IHostedService` **singleton**. Isso tem uma consequencia com a qual as pessoas esbarram constantemente: voce nao pode injetar um servico com escopo (scoped, como um `DbContext` de pool) diretamente no construtor de um servico hospedado, porque um singleton nao pode depender de um servico com escopo. Injete `IServiceScopeFactory` e crie um escopo por unidade de trabalho em vez disso. Essa armadilha especifica, e sua mensagem de excecao exata, e coberta em [por que voce nao pode consumir um servico com escopo a partir de um singleton](/pt-br/2026/05/fix-cannot-consume-scoped-service-from-singleton/), e o padrao de escopo correto esta em [como usar servicos com escopo dentro de um BackgroundService](/pt-br/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/).

A ordem de registro e a ordem das chamadas a `StartAsync` e a ordem inversa das chamadas a `StopAsync`, entao registre primeiro os servicos de cuja inicializacao outros dependem.

## Honrando os tokens de cancelamento

Ambos os metodos recebem um `CancellationToken`, e eles significam coisas diferentes.

O token passado para `StartAsync` sinaliza que a inicializacao esta sendo abortada. Na pratica ele raramente e disparado, mas ainda assim voce deve propaga-lo por qualquer chamada assincrona que fizer, para que um Ctrl+C durante uma inicializacao lenta realmente a cancele.

O token passado para `StopAsync` e o que importa. Ele e cancelado quando o prazo de encerramento gracioso (`HostOptions.ShutdownTimeout`, 30 segundos por padrao) se esgota. Se o seu `StopAsync` o ignora e continua esperando, o host acabara desmontando o processo de qualquer forma, e o trabalho em andamento e perdido. Entao a sua logica de encerramento deve parar *prontamente* quando esse token disparar, descarregando ou marcando um checkpoint do que puder em vez de tentar terminar tudo.

```csharp
// .NET 11, C# 14 -- extend the shutdown window when your drain is slow
builder.Services.Configure<HostOptions>(o =>
    o.ShutdownTimeout = TimeSpan.FromSeconds(60));
```

Aumente o tempo limite apenas se o seu trabalho realmente precisar de mais para se esvaziar de forma limpa. Cancelar corretamente pelo token e o habito mais importante, e ele anda junto com acertar o cancelamento no restante do seu codigo assincrono, o que e um topico proprio em [como cancelar um Task de longa duracao sem deadlock](/pt-br/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/).

## A mudanca do .NET 11 nos codigos de saida diante de falhas

Aqui esta a mudanca de comportamento com maior probabilidade de te surpreender ao atualizar. Quando um `BackgroundService` lanca uma excecao nao tratada a partir de `ExecuteAsync`, e `HostOptions.BackgroundServiceExceptionBehavior` fica em seu valor padrao `StopHost`, o host para. Esse padrao esta em vigor desde o .NET 6 (antes disso, o padrao era `Ignore`, que silenciosamente te deixava com um host zumbi que parecia vivo mas nao fazia trabalho).

O que mudou no .NET 11 Preview 3 e o codigo de saida. Antes, a tarefa retornada por `RunAsync`, `StopAsync` ou `WaitForShutdownAsync` se completava com *sucesso* mesmo que um servico tivesse falhado, entao o processo geralmente saia com codigo zero e o seu orquestrador achava que estava tudo bem. A partir do .NET 11, [esses metodos agora falham com uma excecao](https://learn.microsoft.com/en-us/dotnet/core/compatibility/extensions/11/ihost-runasync-stopasync-throw-backgroundservice-failure) para que o processo saia com codigo diferente de zero. Um unico servico que falha relanca sua excecao; multiplas falhas retornam como um `AggregateException`.

Este e quase sempre o comportamento que voce quer: um worker em segundo plano que falhou nao deveria reportar sucesso. Mas se voce tinha codigo que dependia do antigo comportamento de sucesso silencioso, agora vera uma saida diferente de zero e possivelmente uma excecao nao tratada no topo de `Program.cs`. A acao recomendada pela Microsoft e nao fazer nada e deixar falhar ruidosamente. Se voce realmente precisa do antigo comportamento, envolva o `await host.RunAsync()` em um try/catch, ou coloque o comportamento de excecao de volta em `Ignore` e aceite a contrapartida:

```csharp
// .NET 11, C# 14 -- opt back into the old, quieter behavior (usually a mistake)
builder.Services.Configure<HostOptions>(o =>
    o.BackgroundServiceExceptionBehavior =
        BackgroundServiceExceptionBehavior.Ignore);
```

Eu nao recorreria a `Ignore`. Um servico hospedado que pode falhar e deixar o host rodando mas ocioso e muito mais dificil de diagnosticar do que um que derruba o processo e e reiniciado pelo seu orquestrador. A melhor correcao e capturar e registrar dentro do seu loop, como os exemplos anteriores fazem, para que uma unica iteracao com falha nunca se torne uma excecao nao tratada.

## Quando a interface crua e a escolha certa

Juntando tudo, implemente `IHostedService` diretamente quando:

- Voce tem trabalho de inicializacao que **deve se completar antes de a app atender trafego**: aquecer um cache, rodar uma verificacao de esquema ou de migracao, estabelecer um pool de conexoes. Coloque em `StartAsync` e deixe a garantia de inicializacao sequencial fazer o seu trabalho.
- Voce tem trabalho de encerramento que deve rodar em uma **ordem especifica**: descarregar um buffer, cancelar o registro em um endpoint de descoberta de servicos, enviar uma metrica final. Coloque em `StopAsync`.
- Voce quer que o encanamento seja explicito porque o ciclo de vida e incomum e voce prefere le-lo a confiar na classe base.

Use `BackgroundService` para o caso muito mais comum de um loop que roda por toda a vida da app. Use `IHostedLifecycleService` apenas quando precisar de fases de pre-inicio ou pos-encerramento em lote atraves de multiplos servicos. E o que quer que voce escolha, honre os tokens de cancelamento, mantenha `StartAsync` rapido e deixe as falhas virem a tona. Para padroes relacionados, veja [como rodar trabalho fire-and-forget com seguranca com BackgroundService](/pt-br/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/).

## Fontes

- [IHostedService Interface -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.hosting.ihostedservice)
- [IHostedLifecycleService Interface -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.hosting.ihostedlifecycleservice)
- [Breaking change: BackgroundService runs all of ExecuteAsync as a Task (.NET 10)](https://learn.microsoft.com/en-us/dotnet/core/compatibility/extensions/10.0/backgroundservice-executeasync-task)
- [Breaking change: IHost.RunAsync and IHost.StopAsync throw when a BackgroundService fails (.NET 11)](https://learn.microsoft.com/en-us/dotnet/core/compatibility/extensions/11/ihost-runasync-stopasync-throw-backgroundservice-failure)
- [BackgroundServiceExceptionBehavior Enum -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.hosting.backgroundserviceexceptionbehavior)
