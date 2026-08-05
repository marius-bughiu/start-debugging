---
title: "Correção: AggregateException \"One or more errors occurred\" ao aguardar Task.WhenAll em C#"
description: "await Task.WhenAll relança apenas uma das falhas. Guarde a task do WhenAll em uma variável e leia Exception.InnerExceptions para ver todos os erros, e não apenas um."
pubDate: 2026-08-05
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
lang: "pt-br"
translationOf: "2026/08/fix-aggregateexception-one-or-more-errors-occurred-when-awaiting-task-whenall"
translatedBy: "claude"
translationDate: 2026-08-05
---

Se várias tasks de um `Task.WhenAll` falham, a task retornada termina com falha em uma `AggregateException` cuja mensagem é "One or more errors occurred", mas o `await` a desembrulha e relança exatamente uma das exceções internas. Todas as outras falhas são descartadas silenciosamente e nunca chegam ao seu bloco `catch`. A correção é guardar em uma variável local a task que `Task.WhenAll` retorna, aguardá-la dentro de um `try` e ler `whenAll.Exception.InnerExceptions` no `catch` para obter todas elas. Se você está vendo o tipo `AggregateException` literal em um `catch`, é porque está bloqueando com `.Wait()` ou `.Result` em vez de aguardar, o que é um problema separado e pior. Verificado em .NET 11 (`Microsoft.NET.Sdk` 11.0.0, C# 14), com o comportamento de runtime medido em .NET 10.0.5; o código de runtime relevante é idêntico byte a byte nos branches `release/10.0` e `main`.

## O erro em contexto

Bloquear na task do `WhenAll` entrega o invólucro diretamente:

```
Unhandled exception. System.AggregateException: One or more errors occurred. (Connection refused) (The operation has timed out.)
 ---> System.Net.Http.HttpRequestException: Connection refused
   at OrderSync.FetchAsync(String url)
   --- End of inner exception stack trace ---
   at System.Threading.Tasks.Task.ThrowIfExceptional(Boolean includeTaskCanceledExceptions)
   at System.Threading.Tasks.Task.Wait(Int32 millisecondsTimeout, CancellationToken cancellationToken)
```

Aguardá-la não devolve nenhuma `AggregateException`, apenas uma das exceções internas:

```
Unhandled exception. System.Net.Http.HttpRequestException: Connection refused
   at OrderSync.FetchAsync(String url)
   at OrderSync.SyncAllAsync()
```

As duas são a mesma situação de fundo. Essas duas formas são o motivo de as buscas por esse erro caírem em conselhos contraditórios.

## Por que o await esconde todas as falhas menos uma

A documentação de `Task.WhenAll` diz que a task termina no estado `Faulted` "onde suas exceções conterão a agregação do conjunto de exceções desembrulhadas de cada uma das tasks fornecidas". Essa agregação vive na propriedade `Exception` da task retornada, e ela realmente contém todas as falhas.

A perda acontece uma camada acima. O `await` é especificado para relançar a exceção de uma task já desembrulhada, então você captura `HttpRequestException` em vez de `AggregateException` quando uma única task falha. Esse desembrulho é o padrão correto: quase toda API assíncrona produz no máximo um erro, e escrever `catch (AggregateException ae) { ae.InnerException ... }` em volta de cada await seria insuportável. `Task.WhenAll` é a principal API onde essa suposição quebra, e o awaiter não tem como sinalizar "foram quatro". Ele pega um exception dispatch info da lista e o relança. Isso foi levantado como [dotnet/runtime#31494](https://github.com/dotnet/runtime/issues/31494) e novamente como [dotnet/runtime#47605](https://github.com/dotnet/runtime/issues/47605), pedindo um await opcional que propagasse o agregado inteiro. Nenhum dos dois foi lançado, então a alternativa abaixo continua sendo a resposta.

O corolário importa para suas cláusulas `catch`: depois de `await Task.WhenAll(...)`, um `catch (AggregateException)` nunca dispara. Se você escreveu um, ele é código morto e a exceção real passa direto por ele.

## Reprodução mínima

```csharp
// .NET 11, C# 14
static async Task FailAsync(string message)
{
    await Task.Delay(10);
    throw new InvalidOperationException(message);
}

try
{
    await Task.WhenAll(FailAsync("first"), FailAsync("second"), FailAsync("third"));
}
catch (Exception ex)
{
    Console.WriteLine(ex.Message);   // prints one message, not three
}
```

Entram três falhas, sai uma. Nada dentro do bloco `catch` consegue recuperar as outras duas, porque a única referência ao agregado era o temporário que `Task.WhenAll` retornou e o `await` consumiu.

## Correção 1: guarde a task do WhenAll e leia InnerExceptions

Esta é a correção para a esmagadora maioria dos casos, e a única mudança é uma variável local:

```csharp
// .NET 11, C# 14
Task whenAll = Task.WhenAll(FailAsync("first"), FailAsync("second"), FailAsync("third"));

try
{
    await whenAll;
}
catch
{
    // whenAll.Exception is the AggregateException the await threw away
    foreach (Exception inner in whenAll.Exception!.InnerExceptions)
    {
        _logger.LogError(inner, "Sync step failed");
    }
    throw;
}
```

`whenAll.Exception` é não nulo exatamente quando `whenAll.Status == TaskStatus.Faulted`, e sua coleção `InnerExceptions` guarda uma entrada por task que falhou, cada uma com o stack trace original intacto. O `catch` vazio com um `throw` preserva o comportamento existente para quem chama (continua vendo uma única exceção desembrulhada) e ao mesmo tempo dá fidelidade total no log.

Dois detalhes tornam isso seguro de aplicar mecanicamente. Primeiro, não coloque a chamada de `Task.WhenAll(...)` dentro do `try`: quem lança é o `await`, não a chamada, mas deixar a atribuição fora torna a variável visível no `catch`. Segundo, use `catch` ou `catch (Exception)`, não `catch (AggregateException)`, pelo motivo da seção anterior.

## Correção 2: nunca deixe a task do WhenAll falhar

Se o seu fan-out é um lote em que falha parcial é normal, o desenho mais limpo é impedir que exceções escapem das tasks individuais. Envolva cada unidade de trabalho para que ela devolva o resultado em vez de lançar:

```csharp
// .NET 11, C# 14
static async Task<(int Id, Exception? Error)> RunSafeAsync(int id, Func<Task> work)
{
    try
    {
        await work();
        return (id, null);
    }
    catch (Exception ex)
    {
        return (id, ex);
    }
}

var results = await Task.WhenAll(orders.Select(o => RunSafeAsync(o.Id, () => SyncAsync(o))));

foreach (var (id, error) in results.Where(r => r.Error is not null))
{
    _logger.LogError(error, "Order {OrderId} failed", id);
}
```

`Task.WhenAll` agora sempre chega ao fim, então não há agregado a desempacotar, nenhum filtro de exceção para acertar, e a associação entre cada falha e o item que a causou sobrevive. Essa associação é justamente o que a Correção 1 não consegue dar: `InnerExceptions` é uma lista plana de exceções sem referência de volta à task que as produziu. Quando você precisa repetir as falhas ou reportar quais registros foram rejeitados, use este formato.

O custo é que um erro genuinamente fatal deixa de se propagar sozinho. Decida explicitamente o que fazer quando `results` contiver erros, ou você terá construído uma falha silenciosa.

## Correção 3: relance o agregado inteiro de propósito

Quando quem chama realmente deve ver todas as falhas, relance o agregado em vez de deixar o `await` escolher uma. `ExceptionDispatchInfo` preserva os stack traces originais:

```csharp
// .NET 11, C# 14
using System.Runtime.ExceptionServices;

public static async Task WhenAllWithAggregateAsync(IEnumerable<Task> tasks)
{
    Task whenAll = Task.WhenAll(tasks);
    try
    {
        await whenAll;
    }
    catch
    {
        ExceptionDispatchInfo.Capture(whenAll.Exception!).Throw();
    }
}
```

Quem chamar esse helper recebe uma `AggregateException` com todas as exceções internas, que é o que as pessoas geralmente querem quando escrevem `catch (AggregateException)` depois de um `await`. Use isso em uma fronteira onde uma única operação lógica realmente falhou de várias maneiras ao mesmo tempo, como uma importação em lote que precisa reportar todos os erros de validação. Não faça disso o seu padrão: empurra o tratamento de `AggregateException` para todos os chamadores, que é exatamente o problema de ergonomia que o desembrulho do `await` veio eliminar.

## Qual exceção o await realmente lança?

É aqui que a maioria das respostas existentes erra, inclusive as que dizem "a primeira exceção". Depende de qual sobrecarga você chamou, e a diferença é determinística.

```csharp
// .NET 10.0.5, C# 14 -- three tasks that fail at staggered times,
// slowest one first in argument order
static async Task FailAfterAsync(int ms, string message)
{
    await Task.Delay(ms);
    throw new InvalidOperationException(message);
}

static async Task<int> FailAfterIntAsync(int ms, string message)
{
    await Task.Delay(ms);
    throw new InvalidOperationException(message);
}

// non-generic overload -> Task
var nonGeneric = Task.WhenAll(
    FailAfterAsync(150, "index0-slow"),
    FailAfterAsync(80,  "index1-medium"),
    FailAfterAsync(10,  "index2-fast"));
// await throws:    index2-fast
// InnerExceptions: index2-fast, index1-medium, index0-slow

// generic overload -> Task<int[]>
var generic = Task.WhenAll(
    FailAfterIntAsync(150, "index0-slow"),
    FailAfterIntAsync(80,  "index1-medium"),
    FailAfterIntAsync(10,  "index2-fast"));
// await throws:    index0-slow
// InnerExceptions: index0-slow, index1-medium, index2-fast
```

O `Task.WhenAll` não genérico ordena `InnerExceptions` por **tempo de conclusão**. O genérico `Task.WhenAll<TResult>` as ordena por **posição do argumento**. Ambos lançam `InnerExceptions[0]`. Esse resultado se manteve estável em execuções repetidas no .NET 10.0.5.

A causa está visível no código-fonte do runtime. As duas promises estão em [`Task.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/Threading/Tasks/Task.cs). A `WhenAllPromise` não genérica deliberadamente não retém o array de entrada; seu callback de conclusão `Invoke` acrescenta cada task que falhou a uma lista conforme ela termina, e depois percorre essa lista:

```csharp
// dotnet/runtime, Task.WhenAllPromise.Invoke
if (failedOrCanceled is List<Task> list)
{
    foreach (Task task in list) { HandleTask(task); }
}
```

A `WhenAllPromise<T>` genérica mantém o array porque precisa produzir os resultados `T[]` em ordem, e o percorre por índice:

```csharp
// dotnet/runtime, Task.WhenAllPromise<T>.Invoke
for (int i = 0; i < m_tasks.Length; i++)
{
    Task<T>? task = m_tasks[i];
    if (task.IsFaulted) { observedExceptions ??= new(); observedExceptions.AddRange(task.GetExceptionDispatchInfos()); }
    ...
}
```

Essa divergência apareceu no .NET 8 e foi reportada como [dotnet/runtime#93504](https://github.com/dotnet/runtime/issues/93504) depois que o caminho não genérico foi reescrito por motivos de alocação. Foi fechada como "not planned" e não está na documentação de mudanças incompatíveis. Na prática: nunca escreva código que dependa de qual falha aflora de um `await Task.WhenAll`. Leia a lista inteira, conforme a Correção 1.

## O cancelamento desaparece quando algo falha

A outra perda silenciosa é o cancelamento. Se uma task é cancelada e outra falha, a cancelada não contribui com nada:

```csharp
// .NET 10.0.5
var mixed = Task.WhenAll(canceledTask, faultingTask);
try { await mixed; } catch (Exception ex) { /* InvalidOperationException */ }

// mixed.Status                          -> Faulted
// mixed.Exception.InnerExceptions.Count -> 1   (the cancellation is gone)
```

As duas implementações da promise registram `canceledTask` em uma variável local separada e só chamam `TrySetCanceled` quando a lista de exceções está vazia, o que bate com a regra documentada: falha ganha de cancelamento, e cancelamento ganha de sucesso. Se nada falhar e pelo menos uma task for cancelada, a task do `WhenAll` termina em `Canceled`, sua propriedade `Exception` é `null` e o `await` lança uma `TaskCanceledException`. Código que faz `whenAll.Exception!.InnerExceptions` sem checar `Status` vai bater em uma `NullReferenceException` exatamente nesse caso, então proteja-o:

```csharp
// .NET 11, C# 14
catch (Exception ex)
{
    if (whenAll.Exception is { } aggregate)
    {
        foreach (var inner in aggregate.InnerExceptions) _logger.LogError(inner, "Step failed");
    }
    else
    {
        _logger.LogWarning(ex, "Batch was canceled");
    }
    throw;
}
```

Distinguir um cancelamento genuíno de um timeout disfarçado de cancelamento é uma armadilha à parte, coberta em [por que o HttpClient lança TaskCanceledException](/pt-br/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/).

## Armadilhas e variantes

- **Você está capturando `AggregateException` e funciona.** Então você não está aguardando. `.Wait()`, `.Result` e `Task.WaitAll` lançam o invólucro como está, e esse é o único motivo pelo qual o nome do tipo aparece em um `catch`. Isso também significa que você está bloqueando uma thread, com tudo o que isso implica: veja [.Result vs .Wait() vs GetAwaiter().GetResult() vs await](/pt-br/2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp/).

- **`Flatten()` não faz nada aqui.** `AggregateException.Flatten` existe para agregados aninhados, mas `Task.WhenAll` já desembrulha seus componentes, então até um `WhenAll` sobre outro `WhenAll` produz uma lista plana. Verificado: três falhas aninhadas em dois níveis deram três exceções internas antes e depois de `Flatten()`. Guarde `Flatten()` para `Parallel.ForEach` e PLINQ, onde o aninhamento é real.

- **Uma consulta LINQ preguiçosa enumerada duas vezes inicia o trabalho duas vezes.** `Enumerable.Range(0, 3).Select(_ => DoAsync())` é uma consulta, não uma lista. `Task.WhenAll` a enumera uma vez, mas passar a mesma consulta a um segundo `WhenAll` (ou a `.Count()` para uma linha de log) executa tudo de novo. Medido: três tasks iniciadas depois do primeiro `WhenAll`, seis depois do segundo. Chame `.ToArray()` antes de passar uma projeção para `WhenAll`.

- **`Task.WhenAll` não para na primeira falha.** Cada task roda até o fim mesmo depois de uma lançar, e é por isso que você recebe várias exceções. Se quiser que o fan-out abandone o resto, precisa de um `CancellationTokenSource` que as tasks respeitem, ligado como em [propagar um CancellationToken por métodos assíncronos](/pt-br/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/).

- **`Task.WhenAll` não tem limite de concorrência.** Se o agregado está cheio de exceções de socket e timeouts, o bug real pode ser que você disparou 5.000 requisições de uma vez. As alternativas com teto de concorrência são comparadas em [Parallel.ForEach vs Parallel.ForEachAsync vs Task.WhenAll](/pt-br/2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall/).

- **As falhas chegam tarde.** `WhenAll` não conta nada até a task mais lenta terminar, então uma falha rápida fica invisível atrás de um sucesso lento. Se quiser reagir a cada resultado conforme ele chega, [Task.WhenEach](/pt-br/2026/01/streaming-tasks-with-net-9-task-wheneach/) devolve um `IAsyncEnumerable<Task>` em ordem de conclusão.

- **Uma coleção vazia tem sucesso.** `Task.WhenAll(Array.Empty<Task>())` passa direto para `RanToCompletion`. Um job em lote que reporta sucesso com entrada vazia costuma ser um bug de filtragem mais acima, não um bug do `WhenAll`.

- **Aguardar a task do `WhenAll` observa todas as exceções internas.** Você não vai receber um `TaskScheduler.UnobservedTaskException` pelas falhas que não viu, porque o `WhenAll` já as observou por você. Conveniente, e também o motivo de as perdas serem tão silenciosas.

O modelo mental de uma linha: `Task.WhenAll` coleta todas as falhas fielmente, e o `await` é o passo que perde informação. Dê um nome à task retornada e nada se perde.

## Relacionados

- [Parallel.ForEach vs Parallel.ForEachAsync vs Task.WhenAll em C#](/pt-br/2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall/) para escolher a primitiva de fan-out certa e limitar a concorrência.
- [.Result vs .Wait() vs GetAwaiter().GetResult() vs await em C#](/pt-br/2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp/) para entender por que bloquear é o que expõe a `AggregateException` crua.
- [Correção: TaskCanceledException: A task was canceled no HttpClient](/pt-br/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) para o caso de cancelamento que um `WhenAll` com falha engole.
- [Streaming de tasks com Task.WhenEach do .NET 9](/pt-br/2026/01/streaming-tasks-with-net-9-task-wheneach/) para tratar cada resultado conforme ele conclui em vez de esperar o mais lento.
- [Como propagar um CancellationToken por métodos assíncronos no .NET 11](/pt-br/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/) para fazer um fan-out abandonar o trabalho restante.

## Fontes

- Microsoft Learn, [método Task.WhenAll](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.task.whenall) (as regras de falha, cancelamento e `RanToCompletion` citadas acima).
- Microsoft Learn, [classe AggregateException](https://learn.microsoft.com/en-us/dotnet/api/system.aggregateexception) (`InnerExceptions`, `Flatten`, `Handle` e a mensagem "One or more errors occurred").
- Microsoft Learn, [tratamento de exceções em Task](https://learn.microsoft.com/en-us/dotnet/standard/asynchronous-programming-patterns/task-exception-handling) e [tratamento de exceções na TPL](https://learn.microsoft.com/en-us/dotnet/standard/parallel-programming/exception-handling-task-parallel-library).
- dotnet/runtime, [`Task.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/Threading/Tasks/Task.cs) (`WhenAllPromise` e `WhenAllPromise<T>`, a diferença entre ordem de conclusão e ordem de argumentos).
- dotnet/runtime, [Issue #93504: Awaiting nongeneric Task.WhenAll changes behavior in .NET 8](https://github.com/dotnet/runtime/issues/93504) (fechada como "not planned", não documentada).
- dotnet/runtime, [Issue #31494: Task.WhenAll inner exceptions are lost](https://github.com/dotnet/runtime/issues/31494) e [Issue #47605: Configure an await to propagate all errors](https://github.com/dotnet/runtime/issues/47605).
