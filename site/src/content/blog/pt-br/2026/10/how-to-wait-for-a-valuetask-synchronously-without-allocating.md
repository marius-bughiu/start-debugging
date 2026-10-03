---
title: "Como aguardar um ValueTask de forma síncrona em um método não assíncrono sem alocar memória"
description: "Verifique IsCompleted primeiro e leia o resultado com GetAwaiter().GetResult(), que custa 0 bytes. Só recorra ao bloqueio quando o ValueTask ainda estiver pendente, e faça isso com um evento em cache e UnsafeOnCompleted em vez de AsTask(), que aloca de 72 a 208 bytes por chamada. Medido no .NET 10 e no .NET 11 RC1."
pubDate: 2026-10-03
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "async"
  - "valuetask"
  - "performance"
lang: "pt-br"
translationOf: "2026/10/how-to-wait-for-a-valuetask-synchronously-without-allocating"
translatedBy: "claude"
translationDate: 2026-10-03
---

Para ler um `ValueTask<T>` a partir de um método síncrono sem alocar memória, verifique `IsCompleted` primeiro. Se ele já terminou, chame `vt.GetAwaiter().GetResult()` uma única vez e pronto: 0 bytes, cerca de 3 ns. Se ainda estiver pendente, você precisa bloquear. `vt.AsTask().GetAwaiter().GetResult()` é a alternativa segura padrão, mas aloca um wrapper `Task<T>` a cada chamada. Um pequeno helper que gira (spin) brevemente e depois espera em um `ManualResetEventSlim` em cache via `UnsafeOnCompleted` bloqueia com zero alocações. Nunca chame `.Result` nem `.GetAwaiter().GetResult()` em um `ValueTask` que não foi concluído: para instâncias baseadas em `IValueTaskSource`, isso é comportamento indefinido e, na prática, lança `InvalidOperationException`. Todos os números abaixo foram medidos em um Apple M4 com o SDK 10.0.302 (.NET 10, C# 14) e repetidos no SDK 11.0.100-rc.1.26425.128 (.NET 11 RC1).

## Por que bloquear em um ValueTask é diferente de bloquear em um Task

Um `Task<T>` é um tipo de referência que suporta bloqueio. `Task.Wait()`, `.Result` e `GetAwaiter().GetResult()` fazem spin por um instante e depois estacionam a thread em um evento até a tarefa terminar. Chamá-los em um `Task` inacabado é lento e arriscado (deadlocks, starvation do thread pool), mas a chamada em si é definida: ela espera.

Um `ValueTask<T>` é um struct que encapsula uma de três coisas: um resultado `T` simples, um `Task<T>`, ou um `IValueTaskSource<T>` mais um token `short`. O terceiro caso é o que quebra o bloqueio. `IValueTaskSource<T>` expõe `GetStatus`, `OnCompleted` e `GetResult`, e nada nesse contrato diz que `GetResult` deve esperar. A [documentação de ValueTask&lt;TResult&gt;](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.valuetask-1) lista quatro coisas que você nunca deve fazer com uma instância, incluindo "Usar `.Result` ou `.GetAwaiter().GetResult()` quando a operação ainda não foi concluída", e diz claramente que, se você fizer isso, "os resultados são indefinidos". O [post de design sobre ValueTask](https://devblogs.microsoft.com/dotnet/understanding-the-whys-whats-and-whens-of-valuetask/) de Stephen Toub explica o motivo: a origem "não precisa suportar bloqueio até a conclusão da operação, e provavelmente não suporta".

As origens que importam na prática não suportam isso. `Socket`, `NetworkStream`, `System.IO.Pipelines` e `System.Threading.Channels` entregam `ValueTask`s apoiados por objetos `IValueTaskSource` em pool, e a maioria das origens escritas à mão usa `ManualResetValueTaskSourceCore<T>`, que lança exceção se você pedir o resultado cedo demais.

## Um repro mínimo do caso indefinido

Aqui está uma origem em pool que conclui no thread pool, com o mesmo formato que `Socket` usa internamente:

```csharp
// .NET 10 / .NET 11 RC1, C# 14
using System.Threading.Tasks.Sources;

sealed class PooledSource : IValueTaskSource<int>, IThreadPoolWorkItem
{
    private ManualResetValueTaskSourceCore<int> _core;

    public ValueTask<int> StartAsync()
    {
        _core.Reset();
        ThreadPool.UnsafeQueueUserWorkItem(this, preferLocal: false);
        return new ValueTask<int>(this, _core.Version);
    }

    void IThreadPoolWorkItem.Execute() { Thread.SpinWait(50); _core.SetResult(42); }

    public int GetResult(short token) => _core.GetResult(token);
    public ValueTaskSourceStatus GetStatus(short token) => _core.GetStatus(token);
    public void OnCompleted(Action<object?> c, object? s, short token,
        ValueTaskSourceOnCompletedFlags f) => _core.OnCompleted(c, s, token, f);
}
```

Bloqueie nela da mesma forma que você bloquearia em um `Task`:

```csharp
// .NET 10 / .NET 11 RC1, C# 14
var src = new PooledSource();
int r = src.StartAsync().GetAwaiter().GetResult();
// System.InvalidOperationException:
//   Operation is not valid due to the current state of the object.
```

Em ambos os SDKs isso lança exceção imediatamente. `ManualResetValueTaskSourceCore<T>.GetResult` verifica se a operação foi concluída e lança exceção caso contrário. Esse é o resultado amigável. Uma origem personalizada que não protege esse caso pode retornar `default(T)`, retornar o resultado de uma operação anterior que reutilizou o mesmo objeto do pool, ou corromper o próprio estado. Um código que "funciona" em desenvolvimento porque a operação por acaso termina rápido pode falhar em produção sob carga. O mesmo vale para o `ValueTask` não genérico.

## Passo 1: ler um ValueTask já concluído sem custo

A maioria das APIs com `ValueTask` existe porque normalmente conclui de forma síncrona: um acerto de cache, uma leitura em buffer, um canal que já tem um item. Quando isso é verdade, não há nada para esperar, e a documentação permite ler `.Result` ou `GetAwaiter().GetResult()` assim que a instância foi concluída. O `SocketsHttpHandler` em `System.Net.Http` usa exatamente esse caminho rápido com `IsCompletedSuccessfully`.

```csharp
// .NET 10 / .NET 11 RC1, C# 14
ValueTask<int> vt = cache.GetAsync(key);

if (vt.IsCompleted)
{
    // Allowed: the operation is finished, and we consume it exactly once.
    int value = vt.GetAwaiter().GetResult();
}
```

Prefira `IsCompleted` mais `GetAwaiter().GetResult()` a `IsCompletedSuccessfully` mais `.Result` em um helper síncrono. `IsCompleted` também é verdadeiro para instâncias com falha e canceladas, e `GetAwaiter().GetResult()` relança a exceção original (uma `InvalidOperationException` continua sendo uma `InvalidOperationException`), do mesmo jeito que `await` faria. Se você verificar apenas `IsCompletedSuccessfully`, um `ValueTask` com falha cai no seu caminho lento e é encapsulado em um `Task` só para que você possa observar a exceção.

Veja o que o caminho rápido economiza em comparação com o conselho usual de chamar `AsTask()` primeiro, para um `ValueTask<int>` que já contém o valor 42 (200.000 iterações, `GC.GetTotalAllocatedBytes(precise: true)` antes e depois):

| Abordagem, `ValueTask<int>` já concluído | .NET 10 | .NET 11 RC1 |
| --- | --- | --- |
| `vt.AsTask().GetAwaiter().GetResult()` | 72 B, ~22 ns | 72 B, ~20 ns |
| `vt.IsCompleted` e depois `vt.GetAwaiter().GetResult()` | 0 B, ~3 ns | 0 B, ~3 ns |

`AsTask()` em um `ValueTask` baseado em valor precisa fabricar um `Task<T>` por meio de `Task.FromResult`, e o runtime só mantém em cache esses objetos para um punhado de valores (`true`, `false` e inteiros pequenos de -1 a 8). Seu objeto `User`, ou o inteiro 42, recebe uma nova tarefa de 72 bytes a cada vez. Para um valor que nunca precisou de espera, essa alocação não compra nada.

## Passo 2: bloquear em um ValueTask pendente sem AsTask

Quando `IsCompleted` é falso, você precisa esperar. A opção segura documentada é `vt.AsTask().GetAwaiter().GetResult()`, que a [comparação entre .Result e GetAwaiter().GetResult()](/pt-br/2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp/) recomenda exatamente para essa situação. Ela é correta, mas, para uma instância baseada em `IValueTaskSource`, `AsTask()` aloca uma subclasse dedicada de `Task<T>` que se registra na origem, e, se a espera durar o bastante para o `Task` parar de fazer spin e estacionar a thread, a maquinaria de bloqueio aloca um segundo objeto para o evento.

Você pode evitar ambos usando o awaiter diretamente. O `UnsafeOnCompleted` do awaiter registra uma continuação `Action` simples na origem ou no task subjacente e não captura o `ExecutionContext`. Se essa `Action` for um delegate em cache apontando para um `ManualResetEventSlim.Set` em cache, registrá-la não aloca nada:

```csharp
// .NET 10 / .NET 11 RC1, C# 14
public static class ValueTaskSyncExtensions
{
    [ThreadStatic] private static ManualResetEventSlim? t_event;
    [ThreadStatic] private static Action? t_set;

    public static T WaitSync<T>(this ValueTask<T> task)
    {
        if (task.IsCompleted)
            return task.GetAwaiter().GetResult();   // fast path, 0 bytes

        // Short spin: many pending operations finish within microseconds.
        // Polling IsCompleted calls GetStatus, which may be called repeatedly.
        var spinner = new SpinWait();
        while (!task.IsCompleted && !spinner.NextSpinWillYield)
            spinner.SpinOnce();
        if (task.IsCompleted)
            return task.GetAwaiter().GetResult();

        var mres = t_event ??= new ManualResetEventSlim(false, spinCount: 0);
        var set = t_set ??= mres.Set;
        mres.Reset();

        var awaiter = task.ConfigureAwait(false).GetAwaiter();
        awaiter.UnsafeOnCompleted(set);             // no ExecutionContext capture
        mres.Wait();
        return awaiter.GetResult();                 // consume exactly once
    }

    public static void WaitSync(this ValueTask task)
    {
        if (task.IsCompleted) { task.GetAwaiter().GetResult(); return; }

        var spinner = new SpinWait();
        while (!task.IsCompleted && !spinner.NextSpinWillYield)
            spinner.SpinOnce();
        if (task.IsCompleted) { task.GetAwaiter().GetResult(); return; }

        var mres = t_event ??= new ManualResetEventSlim(false, spinCount: 0);
        var set = t_set ??= mres.Set;
        mres.Reset();

        var awaiter = task.ConfigureAwait(false).GetAwaiter();
        awaiter.UnsafeOnCompleted(set);
        mres.Wait();
        awaiter.GetResult();
    }
}
```

Os detalhes que o tornam correto:

1. **Um único consumo.** O `ValueTask` é lido exatamente uma vez, por meio de `GetResult()`, depois que a continuação disparou. Consultar `IsCompleted` repetidamente não conta como consumo; isso chama `GetStatus` na origem, que pode ser chamado várias vezes antes de o resultado ser lido.
2. **Um evento por thread.** Uma thread bloqueada só pode esperar uma coisa por vez, então um evento `[ThreadStatic]` é suficiente, e esperas aninhadas na mesma thread não podem ocorrer enquanto ela está bloqueada. O delegate `Action` em cache também é criado uma vez por thread.
3. **`ConfigureAwait(false)`.** Sem ele, a origem seria instruída a executar a continuação no `SynchronizationContext` capturado. Em uma thread de UI, esse contexto é a thread que você está bloqueando, então `Set` nunca executaria. Com `ConfigureAwait(false)`, a continuação executa onde quer que a origem conclua.
4. **`UnsafeOnCompleted`, não `OnCompleted`.** A variante segura captura e restaura o `ExecutionContext`, o que é inútil para um delegate que apenas sinaliza um evento.
5. **Spin antes de estacionar.** O bloqueio de `Task` faz spin antes de dormir, e este helper deve fazer o mesmo. Na primeira versão do meu benchmark eu estacionava imediatamente (`spinCount: 0`, sem loop de spin), e ficava cerca de duas vezes mais lento que `AsTask()` em operações curtas, porque cada espera pagava por uma transição para o kernel.

## O que os números mostram

Mesmo harness, 200.000 iterações para operações curtas e 2.000 para o caso de 1 ms, com bytes por chamada medidos em todas as threads:

| `ValueTask<int>` pendente | Abordagem | .NET 10 | .NET 11 RC1 |
| --- | --- | --- | --- |
| `IValueTaskSource`, conclui em microssegundos | `AsTask().GetAwaiter().GetResult()` | 80 B | 80 B |
| `IValueTaskSource`, conclui em microssegundos | `WaitSync()` | 0 B | 0 B |
| `IValueTaskSource`, conclui após ~1 ms | `AsTask().GetAwaiter().GetResult()` | 144 B | 208 B |
| `IValueTaskSource`, conclui após ~1 ms | `WaitSync()` | 0 B | 0 B |
| Baseado em `Task` (`Task.Run`) | `AsTask().GetAwaiter().GetResult()` | 72 B | 72 B |
| Baseado em `Task` (`Task.Run`) | `WaitSync()` | 72 B | 72 B |

Os bytes fracionários que o harness reportou para `WaitSync()` (0,1 a 0,3 B por chamada) são contabilidade interna do thread pool, não alocações por chamada. Os 72 B nas linhas baseadas em `Task` são o `Task<int>` que o próprio `Task.Run` cria. Para um `ValueTask` baseado em `Task`, `AsTask()` apenas retorna o task encapsulado, então nenhuma das abordagens acrescenta nada ali.

A latência não é onde o helper ganha. Em operações curtas, ambas as abordagens levaram entre 1 e 6 microssegundos por chamada, com ruído entre execuções maior que a diferença entre elas. No caso de 1 ms, ambas ficaram a menos de 1% uma da outra, porque a espera domina. Se o seu objetivo é velocidade e não alocações, a única coisa que realmente ajuda é o caminho rápido do Passo 1 e, depois disso, não bloquear de jeito nenhum.

Então o resumo honesto é: a verificação de `IsCompleted` é gratuita e economiza 72 bytes em cada conclusão síncrona, que é o caso comum de qualquer API que mereceu seu tipo de retorno `ValueTask`. O helper de bloqueio economiza mais 80 a 208 bytes no caminho lento, o que só importa se o próprio caminho lento for quente.

## Armadilhas e casos extremos

**Isto não resolve deadlocks de sync-over-async.** `ConfigureAwait(false)` no *seu* awaiter só controla onde *a sua* continuação executa. Se o método assíncrono em que você está bloqueando tiver um `await` sem `ConfigureAwait(false)` dentro dele, e você chamar `WaitSync()` de uma thread WPF, WinForms, MAUI ou ASP.NET clássico, essa continuação interna é enfileirada na thread que você acabou de bloquear, e você entra em deadlock exatamente como aconteceria com `.Result`. O mecanismo e as correções estão em [por que bloquear em um método assíncrono causa deadlock](/pt-br/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/).

**Também não resolve a starvation do thread pool.** Uma thread do thread pool estacionada em `mres.Wait()` é uma thread que o pool não pode usar para executar justamente a continuação que a acordaria. Zero alocações não significa zero custo. Use isto em fronteiras síncronas genuínas (um método `Dispose`, uma interface síncrona que você não controla, uma sobrescrita de `Stream.Read` implementada sobre um núcleo assíncrono), não como forma de evitar tornar uma cadeia de chamadas assíncrona. Se a fronteira puder ser movida, [migrar chamadas bloqueantes para async de ponta a ponta](/pt-br/2026/07/migrate-from-blocking-result-and-wait-calls-to-async-all-the-way-up-in-csharp/) continua sendo a correção de verdade.

**Não toque no ValueTask novamente depois de `WaitSync()`.** Depois que `GetResult` foi chamado, uma origem em pool pode já estar atendendo outra operação. Copiar o struct e fazer await na cópia depois é o mesmo bug de fazer await duas vezes. O CA2012 ("Use ValueTasks correctly") pega as versões óbvias, mas não todas, porque o analisador não consegue seguir um `ValueTask` através de um método helper como este. O [explicativo sobre ValueTask](/pt-br/2026/06/what-is-valuetask-and-when-is-it-worth-it/) cobre o contrato completo de await uma única vez.

**`Preserve()` não é um atalho.** `ValueTask<T>.Preserve()` retorna uma instância que você pode consumir várias vezes, mas, para uma instância pendente baseada em `IValueTaskSource`, ele faz isso chamando `AsTask()` internamente, então aloca o mesmo wrapper que você estava tentando evitar.

**As exceções saem sem encapsulamento.** Como o helper termina em `GetAwaiter().GetResult()`, uma operação com falha lança o tipo de exceção original, exatamente como `await`. No harness, um `ValueTask<int>` que lançou `InvalidOperationException` após um `Task.Yield()` apareceu como `InvalidOperationException` em `WaitSync()`, não como `AggregateException`.

**O cancelamento aparece como `OperationCanceledException`.** Se a operação foi cancelada, `GetResult` lança `TaskCanceledException` ou `OperationCanceledException`, dependendo da origem. Não há sobrecarga de timeout no helper acima. Se você precisar de uma, passe um timeout para `mres.Wait` e, ao estourar o timeout, não toque no `ValueTask` novamente: a continuação dele ainda está registrada e chamará `Set` no seu evento thread-static mais tarde, então você também deve substituir `t_event` e `t_set` por instâncias novas antes da próxima espera naquela thread.

**Se você é dono da API, considere se ela deveria ser `ValueTask`.** Um método que é rotineiramente consumido de forma síncrona é um método cujos chamadores estão brigando com o tipo de retorno. Ou exponha um irmão síncrono `TryGet` para o caminho rápido, ou volte para `Task<T>` como descrito em [migrar de ValueTask de volta para Task](/pt-br/2026/06/migrate-from-valuetask-back-to-task-when-and-why/).

## A decisão em ordem

1. Se você pode usar `await`, use `await`. Tudo neste post é para fronteiras síncronas que você não consegue remover.
2. Verifique `IsCompleted`. Se for verdadeiro, `GetAwaiter().GetResult()` uma vez. Zero alocações, tipo de exceção original.
3. Se estiver pendente e a chamada não for quente, `AsTask().GetAwaiter().GetResult()` é correto e sem graça. Use-o.
4. Se estiver pendente e for quente o bastante para que 80 a 208 bytes por chamada apareçam em um profiler, use o helper `WaitSync()` acima.
5. Nunca chame `.Result` nem `GetAwaiter().GetResult()` em um `ValueTask` pendente. É indefinido e, com `ManualResetValueTaskSourceCore<T>`, lança exceção.

## Relacionados

- [.Result vs .Wait() vs GetAwaiter().GetResult() vs await em C#](/pt-br/2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp/) cobre o lado `Task` da mesma pergunta.
- [O que é ValueTask e quando vale a pena](/pt-br/2026/06/what-is-valuetask-and-when-is-it-worth-it/) explica o pooling de `IValueTaskSource` e a regra do await único.
- [Migrar de ValueTask de volta para Task](/pt-br/2026/06/migrate-from-valuetask-back-to-task-when-and-why/) é a opção quando os chamadores continuam precisando de acesso síncrono.
- [Corrigir o deadlock ao chamar .Result ou .Wait() em um método assíncrono](/pt-br/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/) explica por que nada disso é seguro em uma thread de UI.

## Fontes

- [ValueTask&lt;TResult&gt; Struct](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.valuetask-1), Microsoft Learn (observações sobre uso indefinido)
- [Understanding the Whys, Whats, and Whens of ValueTask](https://devblogs.microsoft.com/dotnet/understanding-the-whys-whats-and-whens-of-valuetask/), Stephen Toub, .NET Blog
- [IValueTaskSource&lt;TResult&gt; Interface](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.sources.ivaluetasksource-1), Microsoft Learn
- [ManualResetValueTaskSourceCore&lt;TResult&gt; Struct](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.sources.manualresetvaluetasksourcecore-1), Microsoft Learn
- [CA2012: Use ValueTasks correctly](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2012), Microsoft Learn
- [ValueTask.cs in dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/Threading/Tasks/ValueTask.cs)
