---
title: "Como usar Channels em vez de BlockingCollection em C#"
description: "System.Threading.Channels é o substituto assíncrono de BlockingCollection no .NET 11. Este guia mostra como migrar, como escolher entre limitado e ilimitado, e como lidar com backpressure, cancelamento e desligamento controlado sem deadlocks."
pubDate: 2026-04-25
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "concurrency"
  - "async"
lang: "pt-br"
translationOf: "2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp"
translatedBy: "claude"
translationDate: 2026-04-25
---

Se você tem um `BlockingCollection<T>` em uma aplicação .NET escrita antes do .NET Core 3.0, o substituto moderno é `System.Threading.Channels`. Substitua `new BlockingCollection<T>(capacity)` por `Channel.CreateBounded<T>(capacity)`, troque `Add` / `Take` por `await WriteAsync` / `await ReadAsync`, e chame `channel.Writer.Complete()` em vez de `CompleteAdding()`. Os consumidores iteram com `await foreach (var item in channel.Reader.ReadAllAsync(ct))` em vez de `foreach (var item in collection.GetConsumingEnumerable(ct))`. Tudo continua thread-safe, nenhuma thread fica bloqueada esperando itens, e o backpressure funciona via `await` em vez de estacionar uma thread de trabalho.

Este guia tem como alvo o .NET 11 (preview 3) e o C# 14, mas `System.Threading.Channels` é uma API estável e in-box desde o .NET Core 3.0 e está disponível no .NET Standard 2.0 através do [pacote NuGet `System.Threading.Channels`](https://www.nuget.org/packages/System.Threading.Channels). Nada aqui é exclusivo de preview.

## Por que BlockingCollection não se encaixa mais

`BlockingCollection<T>` chegou com o .NET Framework 4.0 em 2010. Seu design assumia um mundo onde uma thread por consumidor era barata e onde async/await não existia. `Take()` estaciona a thread chamadora em uma primitiva de sincronização do kernel até que um item esteja disponível; `Add()` faz o mesmo quando a capacidade limitada está cheia. Em uma aplicação de console processando 10 itens por segundo, isso é aceitável. Em um endpoint do ASP.NET Core, em um worker service ou em qualquer código rodando sob pressão do `ThreadPool`, cada consumidor bloqueado tira uma thread de circulação. Vinte consumidores bloqueados em `Take()` são vinte threads que o runtime não pode usar, e a heurística de hill-climbing do thread pool responde gerando mais threads, que por si só são caras (cerca de 1 MB de pilha cada no Windows por padrão).

`System.Threading.Channels` foi adicionado no .NET Core 3.0 especificamente para remover esse custo. Um consumidor aguardando em `ReadAsync` não retém uma thread: a continuação é enfileirada no thread pool apenas quando um item realmente é escrito. É o mesmo padrão de máquina de estados assíncrona que alimenta `Task` e `ValueTask`, e é por isso que um único processo do ASP.NET Core pode hospedar dezenas de milhares de consumidores de canal concorrentes sem esgotar o thread pool. A [introdução oficial aos channels](https://devblogs.microsoft.com/dotnet/an-introduction-to-system-threading-channels/) no .NET Blog faz a recomendação explícita: use channels para qualquer novo padrão produtor-consumidor que toque I/O, e reserve `BlockingCollection<T>` para cenários síncronos e CPU-bound onde bloquear uma thread seja genuinamente aceitável.

Há também uma diferença de throughput mensurável. Os benchmarks da própria Microsoft e várias comparações independentes (veja a [análise de produtor/consumidor de Michael Shpilt](https://michaelscodingspot.com/performance-of-producer-consumer/)) colocam `Channel<T>` em aproximadamente 4x o throughput de `BlockingCollection<T>` para tamanhos de mensagem típicos, porque o canal usa operações `Interlocked` lock-free no caminho rápido e evita as transições para o kernel que `BlockingCollection` incorre.

## Uma reprodução mínima do padrão BlockingCollection

Aqui está a configuração canônica de `BlockingCollection<T>` que a maioria do código legado segue. Usa uma capacidade limitada (para que produtores se autorregulem quando consumidores ficam para trás), um `CancellationToken`, e `CompleteAdding` para permitir que consumidores saiam de forma limpa.

```csharp
// .NET 11, C# 14 -- legacy pattern, do not write new code like this
using System.Collections.Concurrent;

var queue = new BlockingCollection<int>(boundedCapacity: 100);
using var cts = new CancellationTokenSource();

var producer = Task.Run(() =>
{
    for (int i = 0; i < 10_000; i++)
        queue.Add(i, cts.Token);

    queue.CompleteAdding();
});

var consumer = Task.Run(() =>
{
    foreach (int item in queue.GetConsumingEnumerable(cts.Token))
        Process(item);
});

await Task.WhenAll(producer, consumer);

static void Process(int item) { /* work */ }
```

Duas threads ficam dedicadas durante todo o tempo de vida deste pipeline. Se `Process` faz I/O, a thread do consumidor fica ociosa em cada espera equivalente a `await` e o canal pode fazer melhor. Se você escala para quatro produtores e oito consumidores, isso são doze threads consumidas.

## O equivalente em Channels

Aqui está o mesmo pipeline usando `System.Threading.Channels`. A forma do código é semelhante; a diferença é que nenhuma thread fica bloqueada.

```csharp
// .NET 11, C# 14 -- modern replacement
using System.Threading.Channels;

var channel = Channel.CreateBounded<int>(new BoundedChannelOptions(100)
{
    FullMode = BoundedChannelFullMode.Wait,
    SingleReader = false,
    SingleWriter = false
});

using var cts = new CancellationTokenSource();

var producer = Task.Run(async () =>
{
    for (int i = 0; i < 10_000; i++)
        await channel.Writer.WriteAsync(i, cts.Token);

    channel.Writer.Complete();
});

var consumer = Task.Run(async () =>
{
    await foreach (int item in channel.Reader.ReadAllAsync(cts.Token))
        await ProcessAsync(item);
});

await Task.WhenAll(producer, consumer);

static ValueTask ProcessAsync(int item) => ValueTask.CompletedTask;
```

Vale apontar três diferenças diretamente. `WriteAsync` retorna um `ValueTask` em vez de bloquear quando o buffer está cheio: a continuação do produtor retoma apenas quando há espaço. `ReadAllAsync` retorna um `IAsyncEnumerable<T>` que completa quando `Writer.Complete()` é chamado, espelhando exatamente o comportamento de `GetConsumingEnumerable` após `CompleteAdding`. E `Channel.CreateBounded` exige que você declare `FullMode` explicitamente, o que força uma decisão que `BlockingCollection` tomava silenciosamente por você (sempre bloqueava).

## Limitado vs ilimitado: escolha deliberadamente

`Channel.CreateBounded(capacity)` tem um limite superior rígido sobre os itens em buffer e aplica backpressure aos produtores quando o buffer está cheio. `Channel.CreateUnbounded()` não tem limite superior, então as escritas completam sincronicamente e nunca esperam. Canais ilimitados são tentadores porque parecem mais rápidos em um microbenchmark, mas são um vazamento de memória esperando para acontecer: se seu consumidor ficar para trás por apenas alguns segundos em um pipeline de alto throughput, o canal felizmente armazenará gigabytes de itens de trabalho antes que alguém perceba. Use `CreateBounded` por padrão. Recorra a `CreateUnbounded` apenas quando puder provar que o consumidor é mais rápido que o produtor, ou quando a taxa do produtor for intrinsecamente limitada por outra coisa (por exemplo, um receptor de webhook cujo throughput é limitado pelo emissor upstream).

`BoundedChannelFullMode` controla o que acontece quando um canal limitado está cheio e um produtor chama `WriteAsync`. As quatro opções são:

- `Wait` (padrão): o `ValueTask` do produtor não completa até que haja espaço disponível. É o equivalente direto do comportamento bloqueante de `BlockingCollection.Add` e é o padrão correto.
- `DropOldest`: o item mais antigo no buffer é removido para abrir espaço. Use para telemetria onde dados obsoletos são piores que dados ausentes.
- `DropNewest`: o item mais novo já no buffer é removido. Raramente útil.
- `DropWrite`: o novo item é descartado silenciosamente. Use para logging fire-and-forget onde descartar a nova escrita é mais barato do que aplicar backpressure ao produtor.

Se você escolher `DropOldest` / `DropNewest` / `DropWrite`, `WriteAsync` sempre completa sincronicamente, então o produtor nunca é regulado. Misturar esses modos com a expectativa de "quero backpressure" é uma fonte comum de bugs. `Wait` é o único modo que de fato aplica backpressure.

## Migrando um pipeline BlockingCollection existente

A maior parte do código BlockingCollection mapeia mecanicamente. A tabela de tradução:

- `new BlockingCollection<T>(capacity)` -> `Channel.CreateBounded<T>(new BoundedChannelOptions(capacity) { FullMode = BoundedChannelFullMode.Wait })`
- `new BlockingCollection<T>()` (ilimitado) -> `Channel.CreateUnbounded<T>()`
- `collection.Add(item, token)` -> `await channel.Writer.WriteAsync(item, token)`
- `collection.TryAdd(item)` -> `channel.Writer.TryWrite(item)` (retorna `bool`, nunca bloqueia)
- `collection.Take(token)` -> `await channel.Reader.ReadAsync(token)`
- `collection.TryTake(out var item)` -> `channel.Reader.TryRead(out var item)`
- `collection.GetConsumingEnumerable(token)` -> `channel.Reader.ReadAllAsync(token)` (com `await foreach`)
- `collection.CompleteAdding()` -> `channel.Writer.Complete()` (ou `Complete(exception)` para sinalizar falha)
- `collection.IsCompleted` -> `channel.Reader.Completion.IsCompleted`
- `BlockingCollection.AddToAny / TakeFromAny` -> sem equivalente direto, veja "armadilhas" abaixo

`TryWrite` e `TryRead` não bloqueantes são críticos para um cenário específico: caminhos de código síncronos que não podem introduzir um `await`. Eles retornam `false` em vez de aguardar, e você pode fazer polling ou recorrer a um caminho de código diferente. A maioria do código não precisa deles; prefira as formas assíncronas.

Se seus produtores rodam no thread pool e seu canal está quente, talvez você queira definir `SingleWriter = true` (ou `SingleReader = true`). Channels usam uma implementação interna diferente e mais rápida quando sabem que há exatamente um produtor ou consumidor. A verificação é apenas oportunista: o runtime não a impõe, então defina essa flag honestamente. Se você definir `SingleWriter = true` e acidentalmente tiver dois produtores, `WriteAsync` se comportará mal de formas sutis (itens perdidos, conclusão quebrada).

## Backpressure, cancelamento e desligamento controlado

O backpressure funciona através do `ValueTask` de `WriteAsync`. Quando o buffer está cheio, a tarefa do produtor fica incompleta até que o consumidor leia um item, momento no qual um único escritor em espera é liberado. É a mesma forma de um semáforo, mas com a semântica ligada ao estado do buffer em vez de a um contador separado.

O cancelamento se propaga da mesma forma que em qualquer API assíncrona. Passe um `CancellationToken` para `WriteAsync`, `ReadAsync` e `ReadAllAsync`. Quando o token dispara, o `ValueTask` em vôo lança `OperationCanceledException`. O canal em si não é cancelado pelo token: outros produtores e consumidores que não passaram esse token continuam normalmente. Se você quiser cancelar todo o pipeline, chame `channel.Writer.Complete()` (ou `Complete(exception)`), que sinaliza a todos os leitores atuais e futuros que mais nenhum dado virá. Veja [como cancelar uma Task longa em C# sem deadlocks](/pt-br/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) para o padrão mais amplo.

Desligamento controlado se parece com isto em um worker service:

```csharp
// .NET 11, C# 14
public class ImportWorker : BackgroundService
{
    private readonly Channel<ImportJob> _channel =
        Channel.CreateBounded<ImportJob>(new BoundedChannelOptions(500)
        {
            FullMode = BoundedChannelFullMode.Wait
        });

    public ChannelWriter<ImportJob> Writer => _channel.Writer;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await foreach (var job in _channel.Reader.ReadAllAsync(stoppingToken))
                await ProcessAsync(job, stoppingToken);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // expected on host shutdown
        }
        finally
        {
            _channel.Writer.TryComplete();
        }
    }

    private static ValueTask ProcessAsync(ImportJob job, CancellationToken ct)
        => ValueTask.CompletedTask;
}

public record ImportJob(string Id);
```

Duas notas. `TryComplete` (em vez de `Complete`) é idempotente e seguro de chamar a partir do `finally`. O filtro de `OperationCanceledException` só engole o cancelamento quando ele realmente vem do `stoppingToken`: um cancelamento disparado por um token diferente continua se propagando, que é o que você quer.

Se seus produtores podem falhar, prefira `channel.Writer.Complete(exception)`. A próxima chamada do consumidor a `ReadAsync` ou `ReadAllAsync` relançará essa exceção, que é o equivalente em channel a `BlockingCollection.GetConsumingEnumerable` relançar após `CompleteAdding` ter sido chamado em decorrência de uma falha.

## Armadilhas que você vai encontrar

`Channel.Writer.WriteAsync` retorna `ValueTask`, não `Task`. Se você armazenar o resultado e aguardá-lo mais de uma vez, dispara comportamento indefinido: `ValueTask` é documentado como aguardável uma única vez. O caso de 99% é `await channel.Writer.WriteAsync(item)` inline; isso só é uma preocupação se você começar a passar o valor de retorno por aí.

`Reader.Completion` é uma `Task` que completa quando `Writer.Complete` é chamado e todos os itens foram drenados. Se você quiser saber quando o canal está totalmente vazio e fechado, aguarde `Reader.Completion`. Não verifique `Reader.Count == 0`, que existe mas compete com escritas em vôo.

`ChannelReader<T>.WaitToReadAsync` retorna `false` apenas quando o canal está completado e vazio. É a primitiva correta para loops de consumidor escritos à mão onde `await foreach` não cabe, por exemplo porque você quer ler em lotes:

```csharp
// .NET 11, C# 14 -- batched consumer
while (await channel.Reader.WaitToReadAsync(ct))
{
    var batch = new List<int>(capacity: 100);
    while (batch.Count < 100 && channel.Reader.TryRead(out int item))
        batch.Add(item);

    if (batch.Count > 0)
        await ProcessBatchAsync(batch, ct);
}

static ValueTask ProcessBatchAsync(IReadOnlyList<int> items, CancellationToken ct)
    => ValueTask.CompletedTask;
```

`BlockingCollection` tinha `AddToAny` e `TakeFromAny` que operavam entre múltiplas coleções. Channels não têm equivalente direto. Se você genuinamente precisa de fan-in entre N canais, o padrão idiomático é gerar uma tarefa consumidora por canal de origem que todas escrevam em um único canal downstream; isso compõe limpamente com o modelo de cancelamento e permanece amigável a async. Se você genuinamente precisa de fan-out (um produtor alimentando N consumidores), gere N tarefas leitoras contra o mesmo `Reader`: channels são seguros para múltiplos leitores desde que você não defina `SingleReader = true`.

`System.Threading.Channels` não é um channel de serialização como o `chan` do Go nem uma primitiva de mensageria distribuída. É apenas in-process. Se você precisa de mensageria entre processos ou entre máquinas, use um broker de mensagens real (Azure Service Bus, RabbitMQ, Kafka). Channels são a ferramenta certa dentro de um único processo; são a ferramenta errada no momento em que uma rede entra em jogo.

## Quando BlockingCollection ainda é defensável

Há um caso estreito em que manter `BlockingCollection<T>` é razoável: um pool de workers síncronos CPU-bound dentro de uma aplicação de console ou job em lote, onde você controla a contagem de threads e não se importa com pressão no thread pool porque não há pressão no thread pool com a qual se preocupar. A [visão geral de Channels no Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/extensions/channels) é explícita quanto a isso. Em todos os outros lugares (ASP.NET Core, worker services, qualquer código que toque I/O, qualquer código compartilhado com consumidores cientes de async), prefira `System.Threading.Channels`.

## Relacionado

- [Como cancelar uma Task longa em C# sem deadlocks](/pt-br/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)
- [Como usar IAsyncEnumerable&lt;T&gt; com EF Core 11](/pt-br/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/)
- [Como ler um CSV grande no .NET 11 sem ficar sem memória](/pt-br/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/)
- [Como transmitir um arquivo de um endpoint ASP.NET Core sem buffering](/pt-br/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/)

## Fontes

- [An Introduction to System.Threading.Channels (Microsoft .NET Blog)](https://devblogs.microsoft.com/dotnet/an-introduction-to-system-threading-channels/)
- [Channels overview (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/core/extensions/channels)
- [BoundedChannelOptions class reference](https://learn.microsoft.com/en-us/dotnet/api/system.threading.channels.boundedchanneloptions)
- [Performance Showdown of Producer/Consumer Implementations in .NET (Michael Shpilt)](https://michaelscodingspot.com/performance-of-producer-consumer/)
- [System.Threading.Channels source on GitHub](https://github.com/dotnet/runtime/tree/main/src/libraries/System.Threading.Channels)
