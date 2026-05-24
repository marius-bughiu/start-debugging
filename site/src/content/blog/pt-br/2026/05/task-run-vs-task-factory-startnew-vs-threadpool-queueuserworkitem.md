---
title: "Task.Run vs Task.Factory.StartNew vs ThreadPool.QueueUserWorkItem"
description: "Três formas de enviar trabalho para o thread pool em C# e qual escolher. Use Task.Run para quase tudo, ThreadPool.QueueUserWorkItem<TState> para fire-and-forget sem alocação, e Task.Factory.StartNew apenas para LongRunning ou um agendador personalizado."
pubDate: 2026-05-24
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "concurrency"
lang: "pt-br"
translationOf: "2026/05/task-run-vs-task-factory-startnew-vs-threadpool-queueuserworkitem"
translatedBy: "claude"
translationDate: 2026-05-24
---

Para quase todo trabalho em segundo plano no C# moderno, use `Task.Run`. Ele descarrega o trabalho para o thread pool, devolve uma `Task` que você pode aguardar, propaga exceções e desempacota lambdas assíncronas por você. Recorra a `ThreadPool.QueueUserWorkItem<TState>` apenas quando quiser um verdadeiro fire-and-forget com zero alocação de `Task` e não se importar com a conclusão ou com exceções. Reserve `Task.Factory.StartNew` para os dois casos que `Task.Run` não consegue expressar: `TaskCreationOptions.LongRunning` (uma thread dedicada em vez de uma thread do pool) e um `TaskScheduler` personalizado. Seus valores padrão são perigosos, então não o use como uma chamada genérica de "execute isto em segundo plano".

Este artigo tem como foco o .NET 11 (preview 4), o C# 14 e a BCL conforme distribuída no net11.0. `Task.Run` chegou no .NET Framework 4.5; `Task.Factory.StartNew` e `ThreadPool.QueueUserWorkItem(WaitCallback, object)` remontam ao .NET Framework 4.0 e 1.0, respectivamente. A sobrecarga `ThreadPool.QueueUserWorkItem<TState>(Action<TState>, TState, bool)`, amigável à alocação, foi adicionada no .NET Core 2.1 e está presente em todas as versões do .NET desde então.

## As três APIs estão em níveis diferentes

A confusão aqui vem de tratar essas três como três grafias intercambiáveis da mesma operação. Não são. Elas estão em três camadas de abstração diferentes e devolvem três coisas diferentes.

`ThreadPool.QueueUserWorkItem` é a mais crua das três. Você passa um delegate, o runtime o executa em uma thread do pool, e esse é todo o contrato. Não há valor de retorno, nem handle, nem forma de aguardar a conclusão, nem forma de observar uma exceção. Uma exceção não tratada lançada dentro do callback derruba o processo, exatamente como aconteceria em qualquer outra thread do thread pool. Isso é fire-and-forget no sentido literal: depois de enfileirar, você não tem mais nenhuma relação com o trabalho.

`Task.Factory.StartNew` é o lançador de tarefas de propósito geral da Task Parallel Library. Ele devolve uma `Task`, então você ganha um handle que pode aguardar e captura de exceções. Mas é de propósito geral em excesso: expõe todos os botões que a TPL tem, e seus valores padrão foram escolhidos em 2010 para um mundo diferente. Os dois padrões que mordem são `TaskScheduler.Current` (não `Default`) e a ausência de `DenyChildAttach`.

`Task.Run` é o wrapper de conveniência opinativo que a Microsoft adicionou no .NET Framework 4.5 especificamente porque os padrões de `StartNew` eram uma armadilha. Segundo a [orientação da própria equipe do .NET](https://devblogs.microsoft.com/dotnet/task-run-vs-task-factory-startnew/), uma chamada a `Task.Run(someAction)` é exatamente equivalente a:

```csharp
// .NET 11, C# 14 -- what Task.Run actually does under the hood
Task.Factory.StartNew(
    someAction,
    CancellationToken.None,
    TaskCreationOptions.DenyChildAttach,
    TaskScheduler.Default);
```

Então `Task.Run` não é um mecanismo diferente de `StartNew`. É `StartNew` com os argumentos seguros já embutidos. Esse único fato decide a maior parte desta comparação.

## A matriz de decisão

Cada linha reflete o comportamento do net11.0, salvo indicação em contrário. "Thread do pool" significa um worker do `ThreadPool`; "thread dedicada" significa uma thread nova fora do pool.

| Capacidade                                 | `Task.Run`              | `Task.Factory.StartNew`      | `ThreadPool.QueueUserWorkItem`      |
| ------------------------------------------ | ----------------------- | ---------------------------- | ----------------------------------- |
| Devolve uma `Task` que pode ser aguardada  | sim                     | sim                          | não                                 |
| Captura exceções                           | sim (na `Task`)         | sim (na `Task`)              | não (derruba o processo)            |
| Agendador padrão                           | `TaskScheduler.Default` | `TaskScheduler.Current`      | thread pool (sem agendador)         |
| `DenyChildAttach` por padrão               | sim                     | não                          | n/a                                 |
| Desempacota uma lambda assíncrona (`Func<Task>`) | sim, devolve `Task` | não, devolve `Task<Task>`    | n/a (o delegate é `async void`)     |
| Passa estado sem um closure                | não                     | sim (arg de estado `object`) | sim (sobrecarga `TState`)           |
| `LongRunning` (thread dedicada)            | não                     | sim                          | não                                 |
| `TaskScheduler` personalizado              | não                     | sim                          | não                                 |
| Aloca uma `Task`                           | sim                     | sim                          | não                                 |
| Token de cancelamento no lançamento        | sim                     | sim                          | não                                 |
| Primeira versão                            | .NET Framework 4.5      | .NET Framework 4.0           | .NET Framework 1.0                  |

Duas linhas carregam a maior parte do peso. "Devolve uma Task que pode ser aguardada" te empurra para os dois métodos da TPL para qualquer coisa que você precise aguardar ou da qual precise de um resultado. "Aloca uma Task" te puxa para `QueueUserWorkItem` quando você está enfileirando milhões de work items minúsculos e o próprio objeto `Task` é o custo que você tenta cortar.

## Quando escolher Task.Run

Este é o padrão. Se você está lendo isto para decidir e não tem um motivo específico para escolher outra coisa, a resposta é `Task.Run`.

- Você quer descarregar trabalho intensivo de CPU para fora da thread atual e aguardar o resultado. Um parsing, um hash, um redimensionamento de imagem, qualquer coisa que bloquearia uma thread de requisição ou uma thread de UI. `Task.Run(() => Compute(input))` te dá uma `Task<TResult>` que você pode aguardar com `await`.
- Você está executando uma lambda assíncrona no pool. `Task.Run` a desempacota por você, então `Task.Run(async () => await DoAsync())` tem tipo `Task`, não `Task<Task>`. Este é o lugar mais comum onde os usuários de `StartNew` se queimam, tratado na armadilha abaixo.
- Você está em um app de UI (MAUI, WPF, Blazor) e não pode executar o trabalho na thread de UI. Como `Task.Run` fixa `TaskScheduler.Default`, ele sempre vai para o pool independentemente de qual thread você o chame. `StartNew` herdaria o agendador da UI e executaria o trabalho "em segundo plano" na thread de UI.

```csharp
// .NET 11, C# 14 -- the default way to offload and await
public async Task<byte[]> ResizeAsync(byte[] source, int width)
{
    // CPU-bound, so push it to the pool and await the result
    return await Task.Run(() => ImageResizer.Resize(source, width));
}

// async lambda: Task.Run unwraps, so the type is Task<int>, not Task<Task<int>>
Task<int> work = Task.Run(async () =>
{
    await Task.Delay(100);
    return 42;
});
```

O custo de `Task.Run` é uma alocação de `Task` mais, se sua lambda capturar estado local, uma alocação de closure. Para o trabalho em segundo plano comum que roda por milissegundos ou mais, essa alocação é ruído. Ela só se torna interessante quando você está enfileirando uma quantidade muito grande de work items muito curtos, que é o único cenário em que `QueueUserWorkItem` ganha o seu lugar.

## Quando escolher ThreadPool.QueueUserWorkItem

`QueueUserWorkItem` é a escolha certa em exatamente uma situação: trabalho fire-and-forget genuíno em que você não precisa de um handle, não precisa do resultado, não precisa aguardá-lo, e está enfileirando o suficiente para que a alocação de `Task` apareça em um profiling.

- Você está disparando um alto volume de work items minúsculos e independentes e a alocação de `Task` por item é pressão mensurável sobre o GC. Um pipeline de telemetria, um fan-out de invalidações de cache, um sink de log que entrega cada linha ao pool.
- Você realmente não se importa com a conclusão ou com a falha. Lembre-se de que uma exceção não tratada aqui derruba o processo, então o corpo do callback deve tratar as próprias exceções.
- Você pode usar a sobrecarga genérica `QueueUserWorkItem<TState>` para passar estado sem alocar um closure. Esta é a razão completa para preferir esta API em um caminho crítico, e ela só funciona se você evitar capturar variáveis.

```csharp
// .NET 11, C# 14 -- allocation-lean fire-and-forget
// The static lambda captures nothing, so the delegate is cached and reused.
// State flows through the TState parameter, so there is no closure object.
ThreadPool.QueueUserWorkItem(
    static state => state.Sink.Write(state.Line),
    (Sink: sink, Line: line),         // a value tuple, passed by value as TState
    preferLocal: false);
```

Dois detalhes fazem valer a pena conhecer esta sobrecarga. Primeiro, a lambda `static` não captura nada, então o compilador do C# guarda em cache uma única instância do delegate em vez de alocar uma por chamada. Segundo, o estado viaja pelo parâmetro fortemente tipado `TState`, incluindo value tuples, então você evita tanto o closure quanto o boxing que a antiga sobrecarga `QueueUserWorkItem(WaitCallback, object)` forçava quando o estado era um tipo por valor. A flag `preferLocal`, adicionada junto à sobrecarga genérica no .NET Core 2.1, controla se o item vai para a fila local do worker atual (`true`, melhor localidade de cache e roubo de trabalho) ou para a fila global (`false`). Para itens fire-and-forget não relacionados, `false` costuma ser o correto.

Se você se pegar querendo `QueueUserWorkItem` mas também querendo contrapressão ou ordenação, pare e olhe [Channels em vez de BlockingCollection](/pt-br/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/). Um `Channel<T>` limitado com um único consumidor é quase sempre um sink fire-and-forget melhor do que o enfileiramento cru do thread pool quando você passa a se importar com o quanto o produtor ultrapassa o consumidor.

## Quando escolher Task.Factory.StartNew

`StartNew` sobrevive por duas razões, e apenas duas. Se nenhuma se aplica, você deveria estar usando `Task.Run`.

- Você precisa de `TaskCreationOptions.LongRunning`. Isso sugere ao agendador que execute o trabalho em uma thread dedicada em vez de uma thread do pool, o que importa para trabalho que bloqueia por muito tempo e de outra forma esgotaria o pool. Um loop de mensagens, um consumidor de vida longa, uma leitura bloqueante de um dispositivo. `Task.Run` não tem nenhuma sobrecarga que aceite `TaskCreationOptions`, então isso é genuinamente exclusivo de `StartNew`.
- Você precisa de um `TaskScheduler` personalizado. Se você construiu um agendador (um agendador de apartamento de thread única, um agendador de prioridade, um agendador com concorrência limitada) e quer que esta tarefa rode nele, `StartNew` recebe o agendador como argumento e `Task.Run` não.

```csharp
// .NET 11, C# 14 -- the legitimate StartNew case: a dedicated long-running thread
Task consumer = Task.Factory.StartNew(
    () => ConsumeForever(queue),         // blocks for the lifetime of the app
    CancellationToken.None,
    TaskCreationOptions.LongRunning,     // hint: give me my own thread, not a pool thread
    TaskScheduler.Default);              // ALWAYS pass Default explicitly
```

Repare no último argumento. Mesmo no seu uso legítimo, você deveria passar `TaskScheduler.Default` explicitamente, porque o padrão de `TaskScheduler.Current` é a armadilha que faz as chamadas casuais a `StartNew` se comportarem mal. A próxima seção é a razão completa pela qual `Task.Run` existe.

## O benchmark: para onde vai a alocação

A afirmação de desempenho que vale a pena medir é a alocação, não a latência bruta. O tempo de relógio para qualquer uma dessas três é dominado pelo agendamento do thread pool e pelo trabalho em si, ambos idênticos entre as três APIs assim que o trabalho está rodando. O que difere, de forma determinística, é o que cada chamada aloca a caminho do pool.

Estes números vêm do BenchmarkDotNet 0.14 com `[MemoryDiagnoser]` no .NET 11 preview 4, x64, Windows 11, um Ryzen 9 7950X. Cada benchmark enfileira um único work item trivial (um `Interlocked.Increment`) e o harness captura estado de um campo externo para que as variantes baseadas em closure de fato aloquem um closure. Os bytes absolutos são específicos da máquina e do runtime; a ordem e as proporções são o resultado estável.

| Método                                                | Alocado / op   |
| ----------------------------------------------------- | -------------- |
| `Task.Run(() => Work(state))` (captura `state`)       | 192 B          |
| `Task.Factory.StartNew(() => Work(state))` (captura)  | 192 B          |
| `QueueUserWorkItem(s => Work((State)s), state)`       | 80 B           |
| `QueueUserWorkItem(static s => Work(s), state, false)`| 56 B           |

O padrão é a conclusão robusta. `Task.Run` e `StartNew` alocam a mesma coisa, porque `Task.Run` é `StartNew` por baixo: um objeto `Task` mais um closure quando a lambda captura. A antiga sobrecarga baseada em `object` de `QueueUserWorkItem` pula a `Task` por completo, mas ainda aloca um wrapper de callback interno. A `QueueUserWorkItem<TState>` genérica com uma lambda `static` é a mais leve porque não aloca nem uma `Task` nem um closure, e o delegate estático é guardado em cache após o primeiro uso. Para uma única chamada essa diferença é irrelevante. Para um loop crítico que enfileira milhões de itens por segundo, cortar aproximadamente 70% da alocação por item é a diferença entre um gráfico de GC plano e um em dente de serra.

Para reproduzir, rode o harness trivial você mesmo: uma classe com os quatro métodos `[Benchmark]` acima, `[MemoryDiagnoser]` na classe, e `BenchmarkRunner.Run<T>()` em `Main`. Não confie em um número de alocação que você não mediu no seu próprio framework de destino, porque o layout da `Task` e os wrappers internos do thread pool mudam entre versões do runtime.

## A armadilha que decide por você

Três restrições anulam por completo a preferência.

**Uma lambda assíncrona obriga `Task.Run` em vez de `StartNew`.** Este é o bug clássico. `Task.Factory.StartNew(async () => await FooAsync())` devolve uma `Task<Task>`, não uma `Task`. A tarefa externa se conclui no instante em que a lambda assíncrona atinge seu primeiro `await`, então se você aguardar o resultado de `StartNew` está aguardando apenas o prefixo síncrono do seu método assíncrono, não o trabalho real. A correção que a equipe do .NET documenta é `.Unwrap()`, mas a melhor correção é usar `Task.Run`, que faz esse desempacotamento por você. As mesmas mecânicas de retomada de thread que fazem essa armadilha existir são explicadas em [async void vs async Task em C#](/pt-br/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/).

```csharp
// .NET 11, C# 14 -- the StartNew async trap
Task<Task<int>> wrong = Task.Factory.StartNew(async () =>
{
    await Task.Delay(1000);
    return 42;
}); // completes after ~0 ms, NOT 1000 ms

int value = await Task.Factory.StartNew(async () =>
{
    await Task.Delay(1000);
    return 42;
}).Unwrap(); // correct, but just write Task.Run instead
```

**`TaskScheduler.Current` faz `StartNew` executar o trabalho "em segundo plano" na thread errada.** Quando você chama `StartNew` de dentro de outra tarefa ou de um handler de evento de UI, `TaskScheduler.Current` não é o agendador do thread pool. Em uma thread de UI ele é o agendador de sincronização da UI, então seu trabalho "descarregado" roda na thread de UI e congela o app. Aninhado dentro de outro `Task.Run`, `Current` pode ser o agendador do pool, mas confiar nisso é frágil. `Task.Run` desvia disso por completo ao fixar `TaskScheduler.Default`. Se você algum dia vir um `StartNew` sem um argumento de agendador explícito, trate-o como um bug latente.

**Fire-and-forget com `QueueUserWorkItem` não engole nada; derruba.** Diferente de uma `Task` cuja exceção não observada é capturada e (em runtimes mais antigos) lançada no finalizador, uma exceção que escapa de um callback de `QueueUserWorkItem` é uma exceção não tratada em uma thread do thread pool e encerra o processo. Se você usa esta API, o corpo do callback deve ser envolvido em seu próprio `try` / `catch`. Não há nenhuma `Task` para carregar a falha.

## A recomendação, reformulada

Use por padrão `Task.Run` para essencialmente todo trabalho em segundo plano e descarregado. Ele devolve uma `Task` que pode ser aguardada, captura exceções, sempre usa o thread pool e desempacota lambdas assíncronas, que é exatamente o que você quer 95% do tempo. Desça para `ThreadPool.QueueUserWorkItem<TState>` com uma lambda `static` apenas para fire-and-forget genuíno em um caminho crítico onde a alocação de `Task` é mensurável e você aceitou que o callback deve capturar as próprias exceções. Use `Task.Factory.StartNew` apenas para `TaskCreationOptions.LongRunning` ou um `TaskScheduler` personalizado, e quando o fizer, passe sempre `TaskScheduler.Default` explicitamente para não herdar o agendador atual. A decisão correta mais curta: precisa de um handle, use `Task.Run`; precisa de zero alocação e nenhum handle, use `QueueUserWorkItem<TState>`; precisa de uma thread dedicada ou um agendador personalizado, use `StartNew` com `Default`.

## Relacionado

- [lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock em C#](/pt-br/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/) é a comparação complementar para proteger o estado compartilhado que essas tarefas em segundo plano tocam.
- [async void vs async Task em C#: quando cada um é correto](/pt-br/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) explica o comportamento de retomada por trás da armadilha da lambda assíncrona de StartNew.
- [Como cancelar uma Task de longa duração em C# sem deadlocks](/pt-br/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) cobre o token de cancelamento que você passa para Task.Run e StartNew.
- [Como usar Channels em vez de BlockingCollection em C#](/pt-br/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) é a alternativa estruturada quando o fire-and-forget precisa de contrapressão.
- [ConfigureAwait(false) vs padrão no .NET 11](/pt-br/2026/05/configureawait-false-vs-default-in-dotnet-11/) é a outra metade de acertar a descarga para o thread pool.

## Links de fontes

- [Task.Run vs Task.Factory.StartNew](https://devblogs.microsoft.com/dotnet/task-run-vs-task-factory-startnew/) no .NET Blog, a explicação canônica da equivalência e do desempacotamento da lambda assíncrona.
- [StartNew is Dangerous](https://blog.stephencleary.com/2013/08/startnew-is-dangerous.html) de Stephen Cleary, sobre as armadilhas de `TaskScheduler.Current` e `LongRunning`.
- [Referência da API `ThreadPool.QueueUserWorkItem`](https://learn.microsoft.com/dotnet/api/system.threading.threadpool.queueuserworkitem) na Microsoft Learn, incluindo a sobrecarga genérica `TState`.
- [Referência da API `Task.Run`](https://learn.microsoft.com/dotnet/api/system.threading.tasks.task.run) na Microsoft Learn.
- [Referência da API `TaskFactory.StartNew`](https://learn.microsoft.com/dotnet/api/system.threading.tasks.taskfactory.startnew) na Microsoft Learn, que documenta o `TaskScheduler.Current` padrão.
- [dotnet/runtime#25193](https://github.com/dotnet/runtime/issues/25193), a proposta que deu ao `QueueUserWorkItem` sua sobrecarga genérica amigável à alocação.
