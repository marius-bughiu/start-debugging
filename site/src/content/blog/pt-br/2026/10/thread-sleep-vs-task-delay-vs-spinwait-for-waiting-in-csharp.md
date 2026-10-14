---
title: "Thread.Sleep vs Task.Delay vs SpinWait para esperar em C#"
description: "Use await Task.Delay para qualquer espera por tempo em código assíncrono, Thread.Sleep apenas em uma thread dedicada que você controla, e SpinWait apenas para esperas abaixo de um microssegundo dentro de código lock-free. Para esperar por uma condição, use um sinal (ManualResetEventSlim, SemaphoreSlim, TaskCompletionSource) em vez de qualquer um dos três. Medido no .NET 10.0.10."
pubDate: 2026-10-14
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "concurrency"
  - "async"
  - "performance"
lang: "pt-br"
translationOf: "2026/10/thread-sleep-vs-task-delay-vs-spinwait-for-waiting-in-csharp"
translatedBy: "claude"
translationDate: 2026-10-14
---

Para uma pausa por tempo, use `await Task.Delay(...)` em qualquer código assíncrono, porque ele libera a thread enquanto espera. Use `Thread.Sleep` apenas em uma thread que você mesmo criou (um loop de console, um worker dedicado), nunca em uma thread do pool ou da UI. Use `SpinWait` apenas quando você espera que a espera termine em poucos microssegundos, tipicamente dentro de código lock-free. E se você na verdade está esperando que **algo aconteça** e não que o tempo passe, nenhuma das três é a ferramenta certa: use um sinal como `ManualResetEventSlim`, `SemaphoreSlim` ou um `TaskCompletionSource`, que nas minhas medições acordaram cerca de 50 vezes mais rápido do que qualquer loop de polling.

Todos os números deste post foram medidos no .NET 10.0.10 (SDK 10.0.302), C# 14, em um Apple M4 com 10 núcleos rodando macOS 26.6. As APIs em si não mudam há anos: `Task.Delay` existe desde o .NET Framework 4.5, `SpinWait` desde o 4.0, e tudo aqui vale igualmente para o .NET 8, 9 e para os previews do .NET 11.

## A comparação em resumo

| | `Thread.Sleep` | `await Task.Delay` | `SpinWait` |
| --- | --- | --- | --- |
| Mantém a thread presa enquanto espera | Sim, bloqueada | Não, a thread volta ao pool | Sim, executando ou cedendo |
| CPU durante a espera (500 ms, medido) | 0 ms | 0 ms | 4 ms com `SpinUntil`, 500 ms com `SpinOnce(-1)` |
| Menor espera real (`1` ms solicitado, macOS) | ~1.5 ms | ~1.3 ms | ~1 us por spin inicial |
| Menor espera real no Windows (timer padrão) | ~1-15.6 ms | ~15.6 ms | ~1 us por spin inicial |
| Cancelável | Não | Sim, via `CancellationToken` | Apenas pela sua própria condição |
| Testável com tempo falso | Não | Sim, `Task.Delay(TimeSpan, TimeProvider)` (.NET 8+) | Não |
| Seguro em uma thread do pool | Não | Sim | Apenas por microssegundos |
| Seguro na thread da UI | Não, congela a UI | Sim | Não |
| Uso típico | Loops em threads dedicadas, ferramentas de console simples | Backoff de retry, throttling, polling em código assíncrono | Loops de retry lock-free, primitivas spin-then-block |

## O que cada uma realmente faz com a sua thread

`Thread.Sleep(ms)` suspende a thread do SO que o chamou. O agendador a tira da CPU e não a considera novamente até o intervalo passar. Nenhuma CPU é gasta, mas a thread continua existindo, continua segurando sua pilha e não pode fazer mais nada. Isso é aceitável para uma thread cuja única função é esperar. É um problema para uma thread que pertence a um recurso compartilhado.

`Task.Delay(ms)` retorna uma `Task` que é concluída quando um `TimerQueueTimer` interno dispara. Quando você usa `await` nela, o seu método retorna ao chamador, a thread volta ao pool (ou ao loop de mensagens da UI) e o restante do método é agendado como continuação quando o timer dispara. Enquanto o delay está pendente, nenhuma thread está associada ao seu método.

`SpinWait` mantém a thread na CPU e verifica de novo. É um struct com um método que importa, `SpinOnce()`, e o comportamento dele depende de quantas vezes você o chamou. Lendo o [código-fonte do .NET 10](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Private.CoreLib/src/System/Threading/SpinWait.cs), as constantes são `YieldThreshold = 10`, `Sleep0EveryHowManyYields = 5` e `DefaultSleep1Threshold = 20`:

- As chamadas 0 a 9 executam `Thread.SpinWait(n)`, um loop ocupado de instruções de pausa da CPU que cresce a cada iteração.
- A partir da chamada 10, uma chamada sim, outra não cede a fatia de tempo com `Thread.Yield()` ou `Thread.Sleep(0)`.
- A partir da chamada 20, toda chamada executa `Thread.Sleep(1)`.
- Em uma máquina com um único processador, ele pula o spinning por completo e cede desde a primeira chamada, porque girar ali só atrasa a thread que você está esperando.

Então "`SpinWait`" é menos um spin e mais uma escada de escalonamento. Esse detalhe decide a maior parte dos trade-offs abaixo.

## Medido: quanto tempo "esperar 1 ms" realmente leva?

Este probe mede 200 chamadas de cada uma e imprime a mediana e o percentil 99:

```csharp
// .NET 10.0.10, C# 14, dotnet run probe.cs
using System.Diagnostics;

foreach (var ms in new[] { 0, 1, 10, 15 })
{
    var sleep = new List<double>();
    for (int i = 0; i < 200; i++)
    {
        var t = Stopwatch.GetTimestamp();
        Thread.Sleep(ms);
        sleep.Add(Stopwatch.GetElapsedTime(t).TotalMilliseconds);
    }

    var delay = new List<double>();
    for (int i = 0; i < 200; i++)
    {
        var t = Stopwatch.GetTimestamp();
        await Task.Delay(ms);
        delay.Add(Stopwatch.GetElapsedTime(t).TotalMilliseconds);
    }

    sleep.Sort(); delay.Sort();
    Console.WriteLine($"{ms} ms: Sleep p50={sleep[100]:F3} | Delay p50={delay[100]:F3}");
}
```

| Solicitado | `Thread.Sleep` p50 | `Thread.Sleep` p99 | `Task.Delay` p50 | `Task.Delay` p99 |
| --- | --- | --- | --- | --- |
| 0 ms | 0.000 ms | 0.015 ms | 0.000 ms | 0.001 ms |
| 1 ms | 1.510 ms | 1.633 ms | 1.297 ms | 1.513 ms |
| 10 ms | 12.012 ms | 12.033 ms | 12.043 ms | 12.083 ms |
| 15 ms | 16.763 ms | 17.071 ms | 17.023 ms | 17.215 ms |

Duas coisas a tirar daqui. Primeiro, ambas são "pelo menos este tempo", nunca "exatamente este tempo". No macOS o excesso foi constante, entre 0,3 e 2 ms. Segundo, `Task.Delay(0)` é concluído de forma síncrona: ele retorna uma tarefa já concluída, então `await Task.Delay(0)` não cede a execução de forma alguma. Se você quer ceder em código assíncrono, `await Task.Yield()` é a API que faz isso.

No Windows a diferença é muito maior. A [documentação de `Task.Delay`](https://learn.microsoft.com/dotnet/api/system.threading.tasks.task.delay) afirma que o delay depende do relógio do sistema, cuja resolução é de cerca de 15 ms no Windows, então `Task.Delay(1)` ali normalmente leva cerca de 15,6 ms. `Thread.Sleep(1)` no Windows pode ficar perto de 1 ms ou perto de 15,6 ms, dependendo de algum processo na máquina ter aumentado a resolução global do timer. Nenhuma das duas APIs é um timer de precisão. Se o seu loop depende de um tick de 1 ms, ele vai rodar a uma fração da taxa que você espera em um Windows com configuração padrão.

## Medido: o que `Thread.Sleep` faz com o thread pool

O verdadeiro motivo pelo qual `Thread.Sleep` é perigoso não é CPU nem precisão. É o que ele faz com um pool compartilhado. Este probe enfileira 200 itens de trabalho que esperam um segundo cada, e então mede, a partir de uma thread dedicada, quanto tempo um item de trabalho novo espera antes mesmo de começar:

```csharp
// .NET 10.0.10, C# 14, dotnet run probe3.cs -- sleep|delay
using System.Diagnostics;

string mode = args[0];
var sw = Stopwatch.StartNew();

var tasks = Enumerable.Range(0, 200).Select(_ => Task.Run(async () =>
{
    if (mode == "sleep") Thread.Sleep(1000);
    else await Task.Delay(1000);
})).ToArray();

var sampler = new Thread(() =>
{
    using var started = new ManualResetEventSlim();
    var t = Stopwatch.GetTimestamp();
    ThreadPool.UnsafeQueueUserWorkItem(_ => started.Set(), null);
    started.Wait();
    Console.WriteLine($"new work item waited {Stopwatch.GetElapsedTime(t).TotalMilliseconds:F0} ms");
});
sampler.Start();

Task.WaitAll(tasks);
sampler.Join();
Console.WriteLine($"{mode}: 200 waits done in {sw.ElapsedMilliseconds} ms, pool threads = {ThreadPool.ThreadCount}");
```

| | `Thread.Sleep(1000)` | `await Task.Delay(1000)` |
| --- | --- | --- |
| Tempo para as 200 esperas de um segundo | 18,034 ms | 1,005 ms |
| Threads do pool no final | 12 | 11 |
| Atraso até um item de trabalho não relacionado começar | 17,030 ms | 1 ms |

Com `Task.Delay`, as 200 esperas se sobrepõem e o lote inteiro leva um segundo em dez threads. Com `Thread.Sleep`, o pool só consegue executar tantos sleeps ao mesmo tempo quanto o número de threads que tem, então o lote é serializado em grupos de aproximadamente dez, e todo o outro trabalho enfileirado atrás dele, neste caso um trivial `started.Set()`, ficou na fila por **17 segundos**. Note que o pool não salvou a situação adicionando threads: itens de trabalho continuaram sendo concluídos a cada segundo, então a lógica de hill-climbing dele o fez crescer de 10 para apenas 12 threads.

Em um app ASP.NET Core, esse item de trabalho enfileirado é a próxima requisição HTTP. Este é o clássico padrão de starvation do thread pool, e um `Thread.Sleep` dentro de um handler de requisição ou de um `BackgroundService` é uma das formas mais fáceis de provocá-lo. A mesma coisa acontece com `Task.Delay(1000).Wait()`, que é só `Thread.Sleep` com alocações extras. Se esse padrão soa familiar, o post sobre [como corrigir deadlocks causados por `.Result` e `.Wait()`](/pt-br/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/) cobre o lado sync-over-async do problema.

## Medido: custo de CPU e latência de despertar do `SpinWait`

`SpinWait.SpinUntil(condition)` parece que queimaria um núcleo pelo tempo todo da espera. Graças à escada de escalonamento, isso não acontece:

| Estratégia de espera, 500 ms de tempo real | Tempo de CPU usado |
| --- | --- |
| `Thread.Sleep(500)` | 0 ms |
| `await Task.Delay(500)` | 0 ms |
| `SpinWait.SpinUntil(...)` | 4 ms |
| loop com `SpinOnce(sleep1Threshold: -1)` | 500 ms (um núcleo inteiro) |
| loop `while` vazio | 499 ms |

Os primeiros 10 spins puros levaram 9,8 us no total e os spins 10 a 19 outros 10 us. Depois disso, cada `SpinOnce()` é um `Thread.Sleep(1)`, que medi em cerca de 1.265 us cada. Passe `sleep1Threshold: -1` para desativar o estágio de `Sleep(1)` e você obtém exatamente o que o nome sugere: um núcleo no teto.

A outra metade do trade-off é a rapidez com que cada estratégia percebe que aquilo que ela espera aconteceu. Aqui uma segunda thread define uma flag após 0 a 3 ms aleatórios, e a thread principal mede o tempo entre a flag ser definida e ela ser percebida (200 execuções de cada):

```csharp
// .NET 10.0.10, C# 14
int flag = 0;
using var ev = new ManualResetEventSlim();
// setter thread: busy-waits a random 0-3 ms, then
//   Volatile.Write(ref flag, 1); ev.Set();

SpinWait.SpinUntil(() => Volatile.Read(ref flag) == 1);       // "spinuntil"
while (Volatile.Read(ref flag) == 0) Thread.Sleep(1);         // "sleep1"
while (Volatile.Read(ref flag) == 0) await Task.Delay(1);     // "delay1"
ev.Wait();                                                    // "mres"
```

| Estratégia | Atraso de despertar p50 | Atraso de despertar p90 |
| --- | --- | --- |
| `SpinWait.SpinUntil` | 745 us | 1,182 us |
| Polling com `Thread.Sleep(1)` | 710 us | 1,158 us |
| Polling com `await Task.Delay(1)` | 836 us | 1,205 us |
| `ManualResetEventSlim.Wait()` | 15 us | 37 us |

Quando a espera dura mais de cerca de 20 us, `SpinUntil` é só um loop de polling com `Thread.Sleep(1)` com um nome mais bonito, e não acorda mais rápido. A espera baseada em evento foi 50 vezes mais rápida na mediana e não usou CPU enquanto esperava. `ManualResetEventSlim` e `SemaphoreSlim` já fazem um spin breve antes de bloquear, então entregam, em uma única chamada, o caminho rápido e barato do `SpinWait` e o caminho lento e eficiente de uma espera no kernel.

## Quando escolher `await Task.Delay`

- **Retry e backoff em código assíncrono.** Um cliente HTTP tentando de novo após um 429, um loop de reconexão com o banco de dados. Passe o `CancellationToken` da requisição para que o encerramento ou a desconexão do cliente cancele a espera em vez de deixá-la pendente.
- **Trabalho periódico em um `BackgroundService`.** `await Task.Delay(interval, stoppingToken)` em um loop funciona bem. Se você quer ticks que não derivem pela duração do trabalho, `PeriodicTimer` (.NET 6+) é a opção melhor.
- **Throttling ou debouncing na thread da UI.** WPF, WinForms, MAUI e Blazor continuam responsivos porque a thread da UI fica livre enquanto o delay está pendente.
- **Qualquer coisa que você queira testar com testes unitários.** A sobrecarga `Task.Delay(TimeSpan, TimeProvider, CancellationToken)` (.NET 8+) permite que um teste avance o tempo instantaneamente com `FakeTimeProvider`, o que mostrei no post sobre [como testar código dependente de tempo com `TimeProvider`](/pt-br/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/).

```csharp
// .NET 10, C# 14
async Task<HttpResponseMessage> GetWithRetryAsync(
    HttpClient http, string url, TimeProvider time, CancellationToken ct)
{
    for (int attempt = 0; ; attempt++)
    {
        var response = await http.GetAsync(url, ct);
        if (response.StatusCode != System.Net.HttpStatusCode.TooManyRequests || attempt == 4)
            return response;

        response.Dispose();
        var backoff = TimeSpan.FromMilliseconds(200 * Math.Pow(2, attempt));
        await Task.Delay(backoff, time, ct); // cancellable, testable, holds no thread
    }
}
```

## Quando escolher `Thread.Sleep`

- **Uma thread que você criou e controla.** Um `new Thread(...)` que consulta um hardware ou um arquivo a cada segundo, onde nada mais é agendado naquela thread. Bloqueá-la não custa nada que mais alguém precise.
- **Uma ferramenta de console síncrona ou um script.** Um `Main` que não é assíncrono e só precisa pausar entre etapas. Não há pool nem thread de UI para sofrer starvation.
- **Reproduzir bloqueio de propósito.** Testes ou demos que precisam simular uma chamada síncrona lenta, como o probe de starvation do pool acima.

Mesmo em uma thread dedicada, considere `WaitHandle.WaitOne(timeout)` ou `CancellationToken.WaitHandle.WaitOne(timeout)`. Ele espera o mesmo intervalo, mas retorna antes quando alguém pede que a thread pare, algo que `Thread.Sleep` não consegue fazer:

```csharp
// .NET 10, C# 14: a dedicated worker thread that can be stopped promptly
void PollLoop(CancellationToken ct)
{
    while (!ct.IsCancellationRequested)
    {
        PollDevice();
        ct.WaitHandle.WaitOne(TimeSpan.FromSeconds(1)); // returns immediately on Cancel()
    }
}
```

## Quando escolher `SpinWait`

- **Loops de retry lock-free.** Um loop de compare-and-swap que falhou porque outra thread está no meio de uma atualização. A outra thread terminará em nanossegundos, então uma troca de contexto custaria mais do que a espera.
- **O caminho rápido da sua própria primitiva de sincronização.** Gire algumas vezes com `SpinOnce()` enquanto `NextSpinWillYield` for falso, depois recorra a uma espera bloqueante de verdade. Essa é a mesma estrutura que `ManualResetEventSlim` usa internamente.

```csharp
// .NET 10, C# 14: spin briefly, then block
var spinner = new SpinWait();
while (!IsReady())
{
    if (spinner.NextSpinWillYield)
    {
        readyEvent.Wait(); // stop spinning, let the OS park the thread
        break;
    }
    spinner.SpinOnce();
}
```

Não use `SpinWait` para esperas medidas em milissegundos, e não use `Thread.SpinWait(n)` diretamente com um `n` grande. A [documentação de `SpinWait`](https://learn.microsoft.com/dotnet/api/system.threading.spinwait) o posiciona como um bloco de construção de baixo nível para código de sincronização, e girar só compensa quando a espera esperada é menor que o custo de uma troca de contexto. Se você não está escrevendo uma estrutura de dados lock-free nem uma primitiva de sincronização, provavelmente não precisa dele. O post sobre [`lock` vs `Monitor` vs `SemaphoreSlim` vs `System.Threading.Lock`](/pt-br/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/) cobre as primitivas de nível mais alto que já fazem esse spinning para você.

## A pegadinha que decide por você: você espera por tempo ou por um evento?

A maioria das chamadas a `Thread.Sleep` e `Task.Delay` que vejo em code reviews não são esperas por tempo de verdade. São loops de polling: "dorme 100 ms, verifica se o job terminou, repete". Esse padrão sempre perde nos dois eixos. Ele soma até um intervalo de latência depois do evento e acorda à toa nesse meio tempo.

Se outra parte do seu programa causa o evento, sinalize-o diretamente:

```csharp
// .NET 10, C# 14: replace "while (!done) await Task.Delay(100);"
var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

_ = Task.Run(async () =>
{
    await DoWorkAsync();
    completion.TrySetResult();
});

await completion.Task.WaitAsync(TimeSpan.FromSeconds(30)); // a real timeout, no polling
```

`RunContinuationsAsynchronously` impede que o código que aguarda `completion.Task` rode inline na thread que chama `TrySetResult`. `WaitAsync(TimeSpan)` (.NET 6+) dá a você o timeout sem um `Task.WhenAny(task, Task.Delay(...))` escrito à mão. Para handoffs de produtor/consumidor use um `Channel<T>`, e para "no máximo N ao mesmo tempo" use `SemaphoreSlim.WaitAsync`. Só faça polling quando o evento acontece fora do seu processo e nada pode notificar você, como um endpoint de status de um job remoto. Nesse caso, `await Task.Delay` com um `CancellationToken` é o intervalo de polling certo.

## Recomendação

Use `await Task.Delay(interval, cancellationToken)` como padrão. Ele não prende thread, não usa CPU, pode ser cancelado e, com um `TimeProvider`, pode ser testado sem esperar de verdade. Na medição acima, ele concluiu 200 esperas de um segundo em 1 segundo, enquanto `Thread.Sleep` levou 18 segundos e travou trabalho não relacionado por 17 deles.

Use `Thread.Sleep` apenas em uma thread que nada mais compartilha, e prefira um `WaitHandle.WaitOne(timeout)` cancelável até mesmo ali. Use `SpinWait` apenas para esperas menores que uma troca de contexto dentro de código lock-free ou de sincronização; para qualquer coisa mais longa ele degrada para um loop de `Sleep(1)` de qualquer forma. E antes de escolher qualquer um deles, pergunte-se se você está esperando por tempo ou por algo acontecer. Se for o segundo caso, um `TaskCompletionSource`, `ManualResetEventSlim`, `SemaphoreSlim` ou `Channel<T>` vai acordar você cerca de 50 vezes mais cedo.

### Leia a seguir

- [Como aplicar timeout em uma operação assíncrona com `CancellationTokenSource.CancelAfter`](/pt-br/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/)
- [Como cancelar uma tarefa de longa duração em C# sem causar deadlock](/pt-br/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)
- [`Task.Run` vs `Task.Factory.StartNew` vs `ThreadPool.QueueUserWorkItem`](/pt-br/2026/05/task-run-vs-task-factory-startnew-vs-threadpool-queueuserworkitem/)
- [`Volatile.Read` vs `Volatile.ReadBarrier` no .NET 10](/pt-br/2026/10/volatile-read-vs-volatile-readbarrier-in-dotnet-10/)

### Fontes

- [Referência da API `Thread.Sleep`](https://learn.microsoft.com/dotnet/api/system.threading.thread.sleep), Microsoft Learn
- [Referência da API `Task.Delay`](https://learn.microsoft.com/dotnet/api/system.threading.tasks.task.delay), incluindo a nota sobre a resolução do relógio do sistema
- [Referência da API `SpinWait`](https://learn.microsoft.com/dotnet/api/system.threading.spinwait), Microsoft Learn
- [`SpinWait.cs` na v10.0.0](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Private.CoreLib/src/System/Threading/SpinWait.cs), dotnet/runtime
- [Depurar thread pool starvation](https://learn.microsoft.com/dotnet/core/diagnostics/debug-threadpool-starvation), documentação de diagnóstico do .NET
- [Visão geral de `TimeProvider`](https://learn.microsoft.com/dotnet/standard/datetime/timeprovider-overview), Microsoft Learn
