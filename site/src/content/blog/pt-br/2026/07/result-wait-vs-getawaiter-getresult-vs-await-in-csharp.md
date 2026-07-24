---
title: ".Result vs .Wait() vs GetAwaiter().GetResult() vs await em C#: qual você deve usar?"
description: "await é a resposta certa quase sempre. Quando você realmente precisa bloquear, GetAwaiter().GetResult() supera .Result e .Wait() porque lança a exceção original. Uma matriz de decisão para .NET 11 e C# 14."
pubDate: 2026-07-24
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
lang: "pt-br"
translationOf: "2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp"
translatedBy: "claude"
translationDate: 2026-07-24
---

Se você tem um `Task<T>` e quer extrair o `T` dele, você tem quatro opções: `task.Result`, `task.Wait()`, `task.GetAwaiter().GetResult()` e `await task`. Use `await`. É a única que não bloqueia uma thread, e lança exatamente a exceção que seu código lançou em vez de um invólucro. As outras três bloqueiam a thread chamadora e arriscam um deadlock; entre elas, `GetAwaiter().GetResult()` é a menos ruim porque desembrulha as exceções do mesmo jeito que `await`. Recorra a ela apenas quando você estiver preso em um método síncrono que não pode tornar `async`. Isso vale no .NET 11 (`Microsoft.NET.Sdk` 11.0.0) com C# 14, e a semântica é estável desde o .NET Framework 4.5.

## As quatro em resumo

| Comportamento                        | `await`            | `GetAwaiter().GetResult()` | `.Result`           | `.Wait()`           |
| ------------------------------------ | ------------------ | -------------------------- | ------------------- | ------------------- |
| Bloqueia a thread chamadora          | não                | sim                        | sim                 | sim                 |
| Retorna um valor                     | sim (`T`)          | sim (`T`)                  | sim (`T`)           | não (void)          |
| Funciona em `Task` não genérico      | sim                | sim                        | não (só `Task<T>`)  | sim                 |
| Exceção lançada                      | original           | original                   | `AggregateException`| `AggregateException`|
| Risco de deadlock (contexto capturado) | não              | sim                        | sim                 | sim                 |
| Inanição do thread pool sob carga    | não                | sim                        | sim                 | sim                 |
| Seguro em `ValueTask<T>`             | sim (uma vez)      | não                        | só se concluída     | n/a                 |

Leia essa tabela de cima a baixo para `await` e você tem uma coluna limpa: sem bloqueio, valor real, exceção original, sem deadlock. Qualquer outra coluna tem pelo menos um "sim" em uma linha que você não quer. Esse é o argumento inteiro. O resto deste artigo é por que cada linha é verdadeira e quando a troca realmente força a sua mão.

## Por que await vence por padrão

`await` não é um jeito mais sofisticado de chamar `.Result`. É uma operação diferente. Quando você faz `await` de uma tarefa que ainda não concluiu, o método suspende e devolve o controle ao seu chamador. Nenhuma thread fica parada esperando. O runtime agenda o resto do seu método como uma continuação que executa quando a tarefa termina. Um membro bloqueante faz o oposto: estaciona a thread atual e a segura até a tarefa concluir.

Essa única diferença é o motivo de `await` escalar e bloquear não. Em um servidor, uma thread bloqueada é uma thread do thread pool que não faz nada além de esperar, e sob carga você fica sem elas. Em uma thread de interface, uma thread bloqueada é uma janela congelada. `await` libera a thread para fazer outro trabalho (atender outra requisição, bombear o loop de mensagens) e retoma seu método depois.

```csharp
// .NET 11, C# 14 -- the default: no thread is blocked while the I/O runs
public async Task<string> GetGreetingAsync(HttpClient http)
{
    string body = await http.GetStringAsync("https://example.com/greeting");
    return body.Trim();
}
```

`await` também te dá a exceção que você realmente lançou. Se `GetStringAsync` lança um `HttpRequestException`, o `await` relança esse `HttpRequestException`, com seu stack trace original, exatamente onde você fez o await. Sem desembrulhar, sem ginástica de `catch (AggregateException)`. A menos que você tenha um motivo concreto para bloquear, a decisão termina aqui.

## Quando GetAwaiter().GetResult() é a chamada bloqueante certa

Às vezes você não pode ser assíncrono. Um construtor de classe não pode ser `async`. Um `Main` anterior ao C# 7.1, um `Dispose` (não `DisposeAsync`), um método de interface cuja assinatura você não controla, um ponto de entrada de plugin de terceiros que te entrega um delegate síncrono: essas são costuras genuinamente síncronas. Se você tem que chamar código assíncrono de dentro de uma delas e não pode reestruturar, você tem que bloquear em algo. Bloqueie em `GetAwaiter().GetResult()`.

O motivo de ela superar `.Result` e `.Wait()` é a fidelidade das exceções. `Task.Result` e `Task.Wait()` são anteriores a `async`/`await`; vêm da Task Parallel Library do .NET 4.0, onde um único `Task` (pense em `Task.WhenAll`) podia falhar com várias exceções de uma vez. Para representar isso, elas embrulham o que deu errado em um `AggregateException`, mesmo quando há exatamente uma exceção interna. `GetAwaiter().GetResult()` foi adicionado com `async`/`await` no .NET 4.5 e segue a convenção do `await`: lança a primeira exceção diretamente, sem embrulho.

```csharp
// .NET 11, C# 14 -- same failing task, three different exceptions surfaced
static async Task<int> FailAsync()
{
    await Task.Yield();
    throw new InvalidOperationException("boom");
}

// .Result -> throws AggregateException wrapping InvalidOperationException
try { _ = FailAsync().Result; }
catch (Exception ex) { Console.WriteLine(ex.GetType().Name); } // AggregateException

// GetAwaiter().GetResult() -> throws InvalidOperationException directly
try { _ = FailAsync().GetAwaiter().GetResult(); }
catch (Exception ex) { Console.WriteLine(ex.GetType().Name); } // InvalidOperationException
```

Se seus blocos `catch` estão escritos para `InvalidOperationException` (como deveriam), `.Result` os contorna silenciosamente porque a exceção chega embrulhada. Você acaba capturando `AggregateException` e chamando `.InnerException`, ou pior, a exceção fica sem tratamento porque ninguém esperava o invólucro. `GetAwaiter().GetResult()` evita tudo isso. É por isso que a orientação padrão, que remonta à série "A Tour of Task" de Stephen Cleary, é: se você não tem escolha a não ser bloquear, bloqueie com `GetAwaiter().GetResult()`.

Ela também funciona em um `Task` não genérico, então é a única chamada bloqueante que cobre tanto "execute isto e espere" quanto "execute isto e me dê o valor":

```csharp
// .NET 11, C# 14 -- blocks and unwraps, whether or not there is a return value
SaveAsync().GetAwaiter().GetResult();               // Task, no value
int count = CountAsync().GetAwaiter().GetResult();   // Task<int>, value
```

## Por que .Result e .Wait() são estritamente piores

`.Result` e `.Wait()` fazem tudo o que `GetAwaiter().GetResult()` faz (bloquear a thread, a mesma exposição a deadlock) e adicionam o invólucro `AggregateException` por cima. Não há cenário em que o invólucro te ajude quando a tarefa é uma única operação lógica. O único lugar onde `.Result` se lê de forma aceitável é em uma tarefa que você já sabe que concluiu, onde ela não bloqueará:

```csharp
// .NET 11, C# 14 -- .Result on a known-completed task does not block
if (task.IsCompletedSuccessfully)
{
    var value = task.Result;   // safe: completed, so no wait, no deadlock
}
```

Mesmo ali, `GetAwaiter().GetResult()` é um substituto perfeito e mantém seu tratamento de exceções uniforme se a suposição sobre a conclusão algum dia se mostrar errada. `.Wait()` tem o uso legítimo mais estreito: esperar em um `Task` do tipo dispare-e-esqueça onde você deliberadamente não quer um valor de retorno e está tratando `AggregateException` explicitamente. Na prática isso é raro, e geralmente é sinal de que o trabalho deveria ter sido estruturado como um job de segundo plano próprio. Se você está rodando trabalho fora da thread de requisição, faça isso com os padrões de [executar trabalho dispare-e-esqueça com segurança usando BackgroundService](/pt-br/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/) em vez de bloquear em uma tarefa solta.

Existe uma armadilha real com `.Wait(timeout)` e `.Wait(cancellationToken)`. Elas fazem a espera desistir mais cedo, o que parece resiliência mas não é. Um `Wait(5000)` que retorna `false` não cancelou a operação subjacente; a tarefa ainda está rodando, sua continuação ainda está na fila, e você simplesmente parou de esperar por ela. Você tapou um travamento com um número mágico. Se você precisa limitar uma operação, cancele-a corretamente, como abordado em [dar timeout em uma operação assíncrona com CancellationTokenSource.CancelAfter](/pt-br/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/).

## O detalhe que decide por você: deadlocks e ValueTask

Duas coisas podem tirar a escolha completamente de você.

**Um `SynchronizationContext` capturado.** Se a thread na qual você bloqueia possui um contexto de thread única (uma thread de interface do WPF ou WinForms, uma thread de requisição do ASP.NET clássico), toda opção bloqueante desta comparação pode causar deadlock, e trocar entre elas não ajuda. `GetAwaiter().GetResult()` trava exatamente no mesmo ponto que `.Result`; o melhor comportamento de exceções é um consolo pequeno quando a aplicação trava. O mecanismo, e cada correção em ordem de preferência, está em [por que bloquear em um método assíncrono causa deadlock e como corrigir](/pt-br/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/). A versão curta: em uma thread de interface ou de ASP.NET clássico, não bloqueie de jeito nenhum. No ASP.NET Core não há `SynchronizationContext`, então você não terá esse deadlock específico, mas bloquear ainda causa inanição do thread pool sob carga, o que é mais difícil de diagnosticar porque só aparece com concorrência.

**Um `ValueTask<T>`.** Se o método retorna `ValueTask<T>` em vez de `Task<T>`, nenhum dos membros bloqueantes é seguro de usar diretamente. Um `ValueTask` pode ser respaldado por um `IValueTaskSource` que pode ser reutilizado depois que o valor é consumido, e ele só pode ser consumido uma vez. Chamar `.Result` ou `.GetAwaiter().GetResult()` em um `ValueTask` que não concluiu é comportamento indefinido, e fazer await dele duas vezes é um bug. Se você recebe um `ValueTask<T>` e realmente não pode fazer await dele, converta-o primeiro em um `Task<T>` com `.AsTask()` e bloqueie nisso:

```csharp
// .NET 11, C# 14 -- never block a ValueTask directly; materialize a Task first
ValueTask<int> vt = ReadValueAsync();
int value = vt.AsTask().GetAwaiter().GetResult();   // safe
// int bad = vt.Result;                              // undefined if not completed
```

A regra mais limpa é: faça `await` de um `ValueTask` exatamente uma vez e nunca o armazene. Bloquear em um é um cheiro de design em cima de outro cheiro de design. Para o conjunto completo de restrições, veja a nota sobre [quando ValueTask vale a pena](/pt-br/2026/06/what-is-valuetask-and-when-is-it-worth-it/).

## Tornando o bloqueio desnecessário

Na maioria das vezes a correção honesta é apagar a chamada bloqueante, não escolher a menos prejudicial. Bloquear quase sempre existe porque alguém parou de propagar `async` em uma camada que poderia ter continuado. Uma action de controller síncrona chamando um repositório assíncrono, um manipulador de eventos `void` que "só precisa do valor agora": ambos normalmente podem virar `async Task` (ou `async void` para o manipulador, o único lugar onde é legítimo). O limite entre um `async void` correto e um bug está detalhado em [quando async void é correto e quando é uma armadilha](/pt-br/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/).

Quando você torna uma cadeia assíncrona de cima a baixo, toda a comparação deste artigo evapora. Você nunca toca em `.Result`, `.Wait()` nem `GetAwaiter().GetResult()`, porque sempre tem um `await` disponível. Essa é a recomendação real escondida atrás da matriz de decisão: a melhor chamada bloqueante é aquela que você refatorou para fora.

## A recomendação, reafirmada

- **Use `await` por padrão.** Não bloqueia, escala, e lança a exceção original. Se o método envolvente pode ser `async`, essa é a resposta, ponto final.
- **Se você realmente não pode ser assíncrono, bloqueie com `GetAwaiter().GetResult()`.** Bloqueia como as outras mas lança a exceção real em vez de um `AggregateException`, e funciona tanto em `Task` quanto em `Task<T>`.
- **Evite `.Result` e `.Wait()`** exceto em uma tarefa que você já sabe que concluiu. Elas adicionam o invólucro `AggregateException` sem benefício em operações individuais.
- **Nunca bloqueie em uma thread de interface ou de ASP.NET clássico**, e nunca bloqueie um `ValueTask` diretamente. A primeira causa deadlock; o segundo é comportamento indefinido. Converta o `ValueTask` em um `Task` com `.AsTask()` se você não tiver alternativa.

Trate cada chamada bloqueante como um `TODO` para tornar o chamador assíncrono. A versão do seu código que nunca bloqueia é mais rápida, à prova de deadlock, e tem exceções mais limpas de graça.

## Relacionados

- [Fix: deadlock ao chamar .Result ou .Wait() em um método assíncrono em C#](/pt-br/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/)
- [Quando async void é correto e quando é uma armadilha em C#](/pt-br/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)
- [ConfigureAwait(false) versus o padrão no .NET 11: ainda importa?](/pt-br/2026/05/configureawait-false-vs-default-in-dotnet-11/)
- [O que é ValueTask e quando vale a pena?](/pt-br/2026/06/what-is-valuetask-and-when-is-it-worth-it/)
- [Como dar timeout em uma operação assíncrona com CancellationTokenSource.CancelAfter em C#](/pt-br/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/)

## Fontes

- [A Tour of Task, Part 6: Results](https://blog.stephencleary.com/2014/12/a-tour-of-task-part-6-results.html) -- Stephen Cleary
- [Don't Block on Async Code](https://blog.stephencleary.com/2012/07/dont-block-on-async-code.html) -- Stephen Cleary
- [TaskAwaiter.GetResult Method](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.taskawaiter.getresult) -- Microsoft Learn
- [Task exception handling in .NET](https://learn.microsoft.com/en-us/dotnet/standard/asynchronous-programming-patterns/task-exception-handling) -- Microsoft Learn
- [ValueTask Restrictions](https://blog.stephencleary.com/2020/03/valuetask.html) -- Stephen Cleary
