---
title: "async void vs async Task em C#: quando cada um é correto"
description: "async Task é o padrão e async void é a exceção. Use async void apenas para handlers de evento, handlers de nível superior em loops de mensagem e um punhado de callbacks de framework que exigem assinatura void. Em todo o resto, async Task vence em exceções, composição e testabilidade."
pubDate: 2026-05-20
tags:
  - "comparison"
  - "csharp"
  - "async"
  - "dotnet-10"
lang: "pt-br"
translationOf: "2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct"
translatedBy: "claude"
translationDate: 2026-05-20
---

Se você está escolhendo entre `async void` e `async Task` para um método que vai escrever em C# 14 / .NET 10, a resposta é `async Task`. As únicas razões legítimas para declarar `async void` são handlers de evento conectados a um evento via `+=`, handlers de nível superior em um loop de mensagens (um click de botão em WinForms, um handler `Loaded` em WPF, um evento de página em MAUI) e um pequeno conjunto de callbacks de framework cuja assinatura é fixada por um contrato externo (`ICommand.Execute`, certos fixtures de teste, alguns test runners). Para qualquer coisa que você mesmo chame, `async Task` é correto porque exceções se tornam capturáveis, o ponto de chamada pode aguardar a conclusão com `await`, e o método se torna composto com `Task.WhenAll`, cancelamento e testes unitários.

Este artigo é a versão longa dessa resposta. Tudo abaixo usa `<TargetFramework>net10.0</TargetFramework>` e `<LangVersion>14.0</LangVersion>` salvo indicação contrária, mas as regras não mudaram desde que async foi adicionado em C# 5.0.

## Matriz de recursos

| Recurso                                          | `async void`                                                   | `async Task`                                |
| ------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------- |
| Chamador pode usar `await`                       | não                                                            | sim                                         |
| Chamador pode usar `catch` em exceções lançadas  | não, propagadas para `SynchronizationContext` / `AppDomain`    | sim, capturadas no `Task` retornado         |
| Componível com `Task.WhenAll` / `.WhenAny`       | não                                                            | sim                                         |
| Testável para conclusão / resultado              | não, retorna imediatamente                                     | sim, faça `await` no `Task` retornado       |
| Dispara `SynchronizationContext.OperationStarted/Completed` | sim                                                | não                                         |
| Sobrevive a uma exceção não tratada              | trava o processo por padrão desde o .NET Framework 4.5         | não, a exceção fica no `Task` até ser observada |
| Assinatura compatível com eventos de C#          | sim (`EventHandler` retorna `void`)                            | não                                         |
| Legal em interfaces / overrides virtuais onde o contrato diz `void` | sim                                  | apenas se o contrato retorna `Task`         |

A tabela é o artigo. Tudo abaixo é o porquê.

## Por que `async void` é hostil aos chamadores

O compilador de C# reescreve métodos `async` em uma máquina de estados que entrega seu trabalho a um `AsyncMethodBuilder`. Para métodos `async Task` o builder é [`AsyncTaskMethodBuilder`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.asynctaskmethodbuilder), que expõe uma propriedade `Task`. Quando a máquina de estados termina, o builder chama `SetResult` ou `SetException` nessa tarefa, e qualquer chamador que segure a referência observa o resultado.

Para `async void` o builder é [`AsyncVoidMethodBuilder`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.asyncvoidmethodbuilder). Ele não tem `Task` para retornar. Disso seguem três consequências concretas.

Primeiro, o ponto de chamada não tem um handle para aguardar. Se você escreve `DoStuffAsync();` e `DoStuffAsync` retorna `void`, a linha termina quando o primeiro `await` dentro do método suspende, não quando o trabalho do método termina. A próxima instrução executa imediatamente, mesmo se o método ainda não tiver feito seu trabalho. Esta é a causa do bug clássico "os dados não estão mais lá quando eu leio".

Segundo, exceções lançadas dentro de um método `async void` não são armazenadas em lugar nenhum. `AsyncVoidMethodBuilder.SetException` as posta no `SynchronizationContext` que estava atual quando o método começou. Em um processo WinForms ou WPF isso significa o loop de mensagens da thread de UI, que dispara `Application.ThreadException` (WinForms) ou `Application.DispatcherUnhandledException` (WPF). Em um aplicativo de console ou em um contexto de segundo plano do ASP.NET Core o synchronization context é nulo, então a exceção é enfileirada na thread pool, que a expõe em `AppDomain.CurrentDomain.UnhandledException` e, desde o .NET Framework 4.5 e todas as releases do .NET 5+, encerra o processo. Não há `try/catch` no ponto de chamada que possa te salvar, porque a exceção nunca viaja pelo ponto de chamada.

Terceiro, o método chama [`SynchronizationContext.OperationStarted`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.synchronizationcontext.operationstarted) quando começa e `OperationCompleted` quando termina. A maioria dos contextos ignora essas chamadas. As exceções são contextos no estilo `AsyncOperationManager` usados pelo `xUnit` e alguns frameworks de teste: eles contam o trabalho assíncrono pendente para que o test runner saiba quando considerar um teste finalizado. Para um método `async void`, o runner vai esperar. Para chamadores comuns, esse trabalho é desperdiçado.

## Reprodução mínima: um crash que você não consegue capturar

```csharp
// .NET 10, C# 14, console app
using System;
using System.Threading.Tasks;

try
{
    Boom();
    await Task.Delay(100);
}
catch (Exception ex)
{
    Console.WriteLine($"caught: {ex.Message}");
}

static async void Boom()
{
    await Task.Yield();
    throw new InvalidOperationException("from async void");
}
```

Execute. A saída não é "caught: from async void". É um stack trace de exceção não tratada e o processo termina com um código diferente de zero. O bloco `catch` acima nunca vê a exceção porque a exceção é lançada no worker da thread pool que retomou a máquina de estados após `Task.Yield`, não na pilha do chamador original.

Mude uma palavra-chave:

```csharp
// .NET 10, C# 14
static async Task Boom()
{
    await Task.Yield();
    throw new InvalidOperationException("from async Task");
}
```

Agora `await Boom();` no ponto de chamada captura a exceção, e mesmo `Boom();` sem `await` não vai travar o processo: a exceção fica no `Task` não observado até alguém observar ou o `Task` ser finalizado (o que, por padrão, também não trava mais o processo desde que o padrão de `<ThrowUnobservedTaskExceptions>` virou `false` no .NET 4.5).

## Quando `async void` é correto

Há exatamente três categorias em que `async void` é apropriado. Seja rigoroso em permanecer dentro delas.

**Handlers de evento conectados a um evento CLR.** O delegate `EventHandler` retorna `void`. Você não pode fazer o método retornar `Task` e ainda se inscrever com `+=`. Se você escreve um handler `Button.Click`, um handler `Window.Loaded`, um handler MAUI `Page.Appearing`, ou qualquer assinatura da forma `void (object?, EventArgs)`, ele deve ser `async void`. O framework (WinForms, WPF, MAUI, Avalonia, Uno) dispara o evento na thread de UI, e o synchronization context posta exceções não tratadas no evento de exceção não tratada do dispatcher da thread de UI, que a maioria dos apps já registra em log. Mantenha o handler enxuto e delegue a um método `async Task` assim que tiver feito a modelagem dos argumentos:

```csharp
// .NET 10, MAUI, C# 14
private async void OnSaveClicked(object? sender, EventArgs e)
{
    try
    {
        await SaveAsync(_viewModel.Form);
    }
    catch (Exception ex)
    {
        await DisplayAlert("Save failed", ex.Message, "OK");
    }
}

private async Task SaveAsync(FormData form)
{
    using var http = _httpFactory.CreateClient("api");
    var response = await http.PostAsJsonAsync("/forms", form);
    response.EnsureSuccessStatusCode();
}
```

O `try/catch` é obrigatório no handler. O handler é o único lugar onde você tem chance de observar uma exceção antes do runtime transformá-la em um crash, então não deixe vazio.

**Callbacks de nível superior do loop de mensagens.** Alguns frameworks expõem pontos de hook que parecem eventos mas são na verdade delegates com assinatura `void`: um handler `Executed` de routed command, um override de `ICommand.Execute(object)` (a interface retorna `void`), um handler `BackgroundWorker.DoWork`, um handler `Timer.Elapsed` com a assinatura estilo `System.Timers.Timer`, e assim por diante. A regra é a mesma dos eventos: mantenha-os enxutos e envolva em `try/catch`.

**Callbacks de framework cujo contrato é fixo.** xUnit 2 chama `IAsyncLifetime.InitializeAsync` e `DisposeAsync` como `Task`, mas alguns hooks no estilo de atributo em test runners ainda esperam um método `void`, e alguns hooks de container de IoC (`IHostedService` do `Microsoft.Extensions.Hosting` retorna `Task`, mas o callback mais antigo `IApplicationLifetime.ApplicationStarted` retorna `void`). Se a assinatura da biblioteca de terceiros diz `void`, você não tem escolha. Documente em um comentário para que um leitor futuro não "conserte".

Todo o resto é `async Task`.

## O que você perde ao apelar para `async void`

Se um método precisa falhar barulhentamente quando algo dá errado, não retorna nada significativo, e você apela para `async void` para pular a cerimônia do `await`, você se inscreveu em:

- **Stack traces perdidos.** A exceção que aparece no synchronization context perde a pilha original do ponto de chamada. Você vê o frame relançado, não "isso foi chamado de `OnSaveClicked`".
- **Sem cancelamento.** Você não pode passar cancelamento adiante, porque o chamador não tem um `Task` para aguardar. Um argumento `CancellationToken` ainda funciona dentro do método, mas o chamador não pode reagir a um `OperationCanceledException` já que ele nunca se propaga de volta.
- **Sem timeout via `Task.WhenAny`.** Um padrão comum é `await Task.WhenAny(work, Task.Delay(timeout, ct))`. Você precisa de um `Task` para isso. `async void` não tem nenhum.
- **Sem testes para a conclusão.** xUnit, NUnit e MSTest podem aguardar um método de teste `async Task` com `await` e observar seu resultado. Eles não podem aguardar um teste `async void`. Alguns frameworks tratam de forma especial métodos de teste `async void` (NUnit antigo, MSTest v2 com peculiaridades do adapter); nenhum recomenda. Veja o padrão com mais detalhes em [como fazer testes unitários de código que usa HttpClient](/2026/04/how-to-unit-test-code-that-uses-httpclient/), onde todo teste é `async Task`.
- **Fire-and-forget que também é fire-and-crash.** Muitos padrões "fire-and-forget" silenciosamente viram chamadas `async void` quando desenvolvedores esquecem o `await`. A correção não é `async void`; a correção é um discard explícito `_ = SomeAsync();` e aceitar que o `Task` resultante não é observado, ou melhor, entregar a tarefa a um lugar conhecido que a observe (um logger, uma fila de segundo plano).

## O benchmark: `async void` economiza alguma coisa?

Às vezes o argumento para `async void` é "é mais barato porque não há alocação de `Task`". Vamos medir.

```csharp
// .NET 10, C# 14, BenchmarkDotNet 0.14.0
// dotnet add package BenchmarkDotNet
using BenchmarkDotNet.Attributes;
using BenchmarkDotNet.Running;

BenchmarkRunner.Run<AsyncShapes>();

[MemoryDiagnoser]
public class AsyncShapes
{
    [Benchmark(Baseline = true)]
    public async Task ReturnsTask()
    {
        await Task.Yield();
    }

    [Benchmark]
    public void ReturnsVoid()
    {
        DoVoid();

        static async void DoVoid() => await Task.Yield();
    }
}
```

Metodologia: BenchmarkDotNet 0.14.0, .NET 10.0.0 RTM, Windows 11 24H2, AMD Ryzen 9 7900X, harness de benchmark síncrono de thread única. Ambos os métodos executam um `Task.Yield`, que força uma continuation na thread pool.

| Método      | Média     | Alocado   |
| ----------- | --------- | --------- |
| ReturnsTask | 1.34 us   | 152 B     |
| ReturnsVoid | 1.29 us   | 136 B     |

A versão `async void` economiza 16 bytes (uma instância de `Task`) e é cerca de 4% mais rápida, o que é insignificante ao lado do salto na thread pool. Runtimes modernos fazem pooling de `AsyncTaskMethodBuilder.Task` para tarefas concluídas não-genéricas, então a diferença de alocação em regime estável é ainda menor do que o microbenchmark mostra. O argumento de desempenho para `async void` não é real.

## A pegadinha que decide por você

Se você está tentado por `async void` para um método que não é de evento, duas coisas deveriam mudar sua opinião imediatamente.

A primeira são tarefas fire-and-forget que abrangem o ciclo de vida de uma requisição. ASP.NET Core não te dá um `SynchronizationContext` por padrão, então uma exceção em um `async void` sobe para `ThreadPool.UnobservedExceptionEvent` e, dependendo dos ajustes de `<ServerGarbageCollection>`, pode derrubar o worker process junto. No momento em que você decide "iniciar algum trabalho em segundo plano a partir de um controller", mude para `IHostedService` ou, para um disparo único, retorne o `Task` para o framework via algo que o observe (`BackgroundService`, uma fila ciente de `IHostApplicationLifetime`, [Channels](/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/)).

A segunda são interfaces. Se você quiser que um método seja mockável ou parte de um contrato, ele tem que retornar algo. `Task` é o tipo de retorno padrão para uma operação assíncrona que não produz valor. `void` não pode ser aguardado com `await` por um mock ou fake, e você não conseguirá coordenar a configuração de teste em torno dele. O padrão de mocking em [como mockar DbContext sem quebrar o rastreamento de mudanças](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) se apoia em membros que retornam `Task` pela mesma razão.

## A recomendação opinativa, de novo

Por padrão use `async Task`. Use `async void` para as três categorias exatas acima: handlers de evento CLR, callbacks no estilo loop de mensagens ou de comando cuja assinatura é fixada pelo framework, e hooks de terceiros que exigem `void`. Envolva todo `async void` em `try/catch` e delegue a um helper `async Task` assim que tiver modelado os argumentos da chamada. Se você vir `async void` em um método que você mesmo escreveu por qualquer outra razão, trate como um crash de processo latente e mude.

Dois corolários que vale a pena fixar na memória muscular:

- Um `async void` que executa `I/O` e esquece o `try/catch` é um crash esperando o `await`. A máquina de estados não tem onde colocar uma exceção lançada exceto no synchronization context, e a maioria dos contextos no .NET moderno trata isso como fatal.
- Um `async Task` que você nunca aguarda com `await` não é o mesmo que `async void`. O `Task` ainda captura a exceção; ela apenas fica lá até a observação ou finalização. Use `_ = SomeAsync();` apenas quando você tiver certeza do ciclo de vida, e prefira entregar o `Task` para uma infraestrutura de fila de segundo plano que seja sua dona.

## Relacionado

- [Como cancelar uma Task de longa duração em C# sem causar deadlock](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)
- [Como usar Channels em vez de BlockingCollection em C#](/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/)
- [Como fazer testes unitários de código que usa HttpClient](/2026/04/how-to-unit-test-code-that-uses-httpclient/)
- [Fix: TaskCanceledException: A task was canceled em HttpClient](/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/)
- [Fix: InvalidOperationException: Synchronous operations are disallowed em ASP.NET Core](/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed/)

## Fontes

- [Tipos de retorno async -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/asynchronous-programming/async-return-types)
- [Stephen Cleary, "Async/Await -- Best Practices in Asynchronous Programming"](https://learn.microsoft.com/en-us/archive/msdn-magazine/2013/march/async-await-best-practices-in-asynchronous-programming)
- [Stephen Cleary, "Async OOP 5: Events"](https://blog.stephencleary.com/2013/02/async-oop-5-events.html)
- [Referência de `AsyncVoidMethodBuilder`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.asyncvoidmethodbuilder)
- [Referência de `AsyncTaskMethodBuilder`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.asynctaskmethodbuilder)
- [Referência de `SynchronizationContext.OperationStarted`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.synchronizationcontext.operationstarted)
