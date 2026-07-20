---
title: "Solução: deadlock ao chamar .Result ou .Wait() em um método async em C#"
description: "Bloquear uma Task async com .Result ou .Wait() causa deadlock quando existe um SynchronizationContext presente. Aqui explico por que trava e como resolver no .NET 11 e C# 14."
pubDate: 2026-07-20
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
  - "deadlock"
lang: "pt-br"
translationOf: "2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp"
translatedBy: "claude"
translationDate: 2026-07-20
---

Se uma chamada a `task.Result`, `task.Wait()` ou `task.GetAwaiter().GetResult()` trava para sempre e nunca lança uma exceção, você tem um deadlock do tipo sync sobre async. Ele acontece quando você bloqueia uma thread que possui um `SynchronizationContext` de thread única (uma thread de UI do WPF ou WinForms, uma thread de requisição do ASP.NET clássico) enquanto o método async que você está bloqueando tenta retomar sua continuação de volta nessa mesma thread. A thread está travada esperando pela tarefa; a tarefa está travada esperando pela thread. A solução é parar de bloquear: tornar toda a cadeia de chamadas assíncrona de ponta a ponta, de modo que você use `await` em vez de `.Result`. Este artigo explica o mecanismo no .NET 11 (`Microsoft.NET.Sdk` 11.0.0, C# 14) e percorre cada solução em ordem de preferência, incluindo as que parecem certas mas não funcionam.

## Por que a thread espera por si mesma

Um `await` faz duas coisas que as pessoas esquecem. Antes de se suspender, ele captura o `SynchronizationContext` atual (via `SynchronizationContext.Current`). Quando a tarefa aguardada é concluída, ela não retoma simplesmente em qualquer thread: por padrão, ela posta a continuação, o código após o `await`, de volta nesse contexto capturado. Em uma thread de trabalho genérica do pool de threads não há contexto, então a continuação roda em qualquer thread livre do pool e nada de especial acontece. Mas em uma thread de UI ou em uma requisição do ASP.NET clássico, o contexto é de thread única. Ele tem exatamente uma thread autorizada a executar seu trabalho enfileirado.

Agora coloque esses dois fatos ao lado de uma chamada bloqueante:

1. Sua thread de UI chama `GetDataAsync().Result`. Isso bloqueia a thread de UI e a retém.
2. Dentro de `GetDataAsync`, um `await SomeIoAsync()` capturou o `SynchronizationContext` da UI antes de se suspender.
3. `SomeIoAsync` termina. O runtime tenta postar a continuação de `GetDataAsync` de volta no contexto da UI para poder executar o resto do método e concluir a tarefa.
4. O contexto da UI tem uma thread. Essa thread está bloqueada no passo 1, esperando a tarefa ser concluída. Ela nunca vai pegar a continuação.
5. A tarefa não pode ser concluída até que a continuação seja executada. A continuação não pode ser executada até que a thread seja liberada. A thread não será liberada até que a tarefa seja concluída. Deadlock.

Stephen Cleary nomeou esse padrão anos atrás em [Don't Block on Async Code](https://blog.stephencleary.com/2012/07/dont-block-on-async-code.html), e o mecanismo não mudou. O runtime não tem bug. Bloquear em uma tarefa cuja continuação precisa da thread que você está bloqueando é uma espera circular genuína.

## A menor reprodução que trava

Você precisa de duas coisas: um `SynchronizationContext` de thread única e uma chamada bloqueante sobre um `await` que o capture. Um manipulador de botão do WinForms é a reprodução clássica, mas você não precisa de um projeto de UI. Você pode instalar um contexto de thread única na mão e vê-lo travar.

```csharp
// .NET 11, C# 14 -- this deadlocks
using System.Threading;

var context = new SingleThreadedSyncContext();
SynchronizationContext.SetSynchronizationContext(context);

// Block on an async method from the context-owning thread:
string result = GetGreetingAsync().Result;   // hangs forever
Console.WriteLine(result);

static async Task<string> GetGreetingAsync()
{
    // Captures the current (single-threaded) context here:
    await Task.Delay(100);
    // The runtime tries to post THIS line back to the captured context,
    // but that thread is blocked on .Result above.
    return "hello";
}
```

Em uma aplicação WPF ou WinForms real você não escreve `SetSynchronizationContext` você mesmo. O framework instala um `DispatcherSynchronizationContext` (WPF) ou um `WindowsFormsSynchronizationContext` (WinForms) na thread de UI antes que seus manipuladores de evento rodem, então qualquer manipulador que faça `SomethingAsync().Result` reproduz isso instantaneamente. O ASP.NET clássico (System.Web, não ASP.NET Core) instala `AspNetSynchronizationContext` na thread de requisição com o mesmo comportamento de thread única.

## A única solução real: assíncrono de ponta a ponta

O deadlock existe porque você bloqueou. Remova o bloqueio e ele some. Propague `async`/`await` para cima na cadeia de chamadas até que o chamador mais externo possa usar `await` em vez de ler `.Result`.

```csharp
// .NET 11, C# 14 -- no block, no deadlock
private async void OnLoadClick(object sender, EventArgs e)
{
    string greeting = await GetGreetingAsync();   // await, not .Result
    label.Text = greeting;
}
```

Aqui `await` ainda captura o contexto da UI, mas nada bloqueia a thread de UI. O manipulador se suspende, a thread de UI volta ao loop de mensagens e permanece livre, e quando `GetGreetingAsync` é concluída sua continuação é postada de volta e roda de forma limpa na thread de UI agora ociosa. É exatamente para isso que serve um `SynchronizationContext` de UI. A continuação aterrissa de volta na thread de UI, então você pode tocar `label.Text` sem marshalling.

Manipuladores de evento são o único lugar autorizado para `async void` precisamente porque estão no topo da pilha de chamadas e não têm um chamador para aguardá-los. Tudo abaixo deles deve ser `async Task`. Se você não tem certeza de onde `async void` é legítimo e onde é um bug, a distinção é coberta em [quando async void é correto e quando é uma armadilha](/pt-br/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/).

A mesma regra se aplica no servidor. Uma action do ASP.NET MVC clássico, um manipulador de Razor Page, um método de hub do SignalR: torne-os `async Task` e use `await` no trabalho em vez de bloquear. Aqui não há crédito parcial. Um único `.Result` em qualquer ponto do caminho síncrono pode reintroduzir o deadlock mesmo que todas as outras camadas sejam assíncronas.

## A solução de biblioteca: ConfigureAwait(false)

Às vezes você não pode tornar toda a cadeia async, porque a chamada bloqueante vive em código que você não possui. Se você é o autor da biblioteca async sobre a qual se bloqueia, você pode desarmar o deadlock do seu lado dizendo a cada `await` para não capturar o contexto:

```csharp
// .NET 11, C# 14 -- library code that stays deadlock-safe under a blocking caller
public async Task<string> GetGreetingAsync()
{
    await Task.Delay(100).ConfigureAwait(false);
    // No captured context, so this continuation runs on a thread pool
    // thread, not the caller's blocked UI/request thread.
    return "hello";
}
```

`ConfigureAwait(false)` diz "não preciso retomar no contexto capturado." A continuação roda em vez disso em uma thread do pool de threads, que não é a bloqueada, então a espera circular nunca se forma e a tarefa pode ser concluída. É por isso que a orientação para bibliotecas compartilhadas é colocar `.ConfigureAwait(false)` em cada await, como a Microsoft detalha no [ConfigureAwait FAQ](https://devblogs.microsoft.com/dotnet/configureawait-faq/).

Duas ressalvas impedem que isso seja uma cura geral. Primeiro, só ajuda se aplicado em cada `await` em todo o fechamento transitivo da chamada bloqueada. Esqueça um único await no fundo de uma dependência e o deadlock volta, que é exatamente por que é uma disciplina de biblioteca e não uma solução que você espalha no local da chamada. Segundo, no seu próprio código de aplicação você não deveria estar bloqueando em primeiro lugar, então `ConfigureAwait(false)` no código de aplicação é tratar um sintoma. A nuance de quando ainda importa, e quando os analisadores do compilador te empurram na direção dele, está em [ConfigureAwait(false) versus o comportamento padrão no .NET 11](/pt-br/2026/05/configureawait-false-vs-default-in-dotnet-11/).

## Soluções que parecem certas mas não funcionam

**Trocar `.Result` por `.GetAwaiter().GetResult()`.** As pessoas recorrem a isso porque ele desembrulha a exceção em vez de envolvê-la em `AggregateException`. Não muda nada sobre o deadlock. `GetAwaiter().GetResult()` ainda bloqueia a thread chamadora até que a tarefa seja concluída, e a tarefa ainda não pode ser concluída porque sua continuação está enfileirada atrás do bloqueio. Melhores exceções, travamento idêntico.

**Adicionar um tempo limite com `Wait(TimeSpan)`.** `task.Wait(5000)` retornará `false` após cinco segundos em vez de travar para sempre, mas isso não é uma solução, é uma falha mais lenta. A operação ainda não foi concluída, e agora você tapou um problema de design com um número mágico. A continuação subjacente ainda está travada.

**Envolver o método async em `Task.Run` e bloquear sobre isso.** Este de fato quebra o deadlock, e é por isso que é perigoso. `Task.Run(() => GetGreetingAsync()).GetAwaiter().GetResult()` inicia o método async em uma thread do pool de threads, que não tem um contexto de thread única, então suas continuações não miram mais na sua thread de UI bloqueada. O travamento desaparece.

```csharp
// .NET 11, C# 14 -- avoids the deadlock, but it is a smell, not a solution
string greeting = Task.Run(() => GetGreetingAsync()).GetAwaiter().GetResult();
```

Funciona, mas agora você está queimando uma thread do pool de threads para bloquear outra thread, você perdeu o contexto da UI para qualquer continuação que legitimamente precisava dele, e você escondeu o fato de que a chamada deveria ter sido assíncrona. A Microsoft documenta esse padrão de descarga sob [wrappers síncronos para métodos assíncronos](https://learn.microsoft.com/en-us/dotnet/standard/asynchronous-programming-patterns/synchronous-wrappers-for-asynchronous-methods) com o mesmo aviso: trate-o como um último recurso para um ponto de entrada genuinamente só-síncrono, não como uma forma de continuar escrevendo código bloqueante.

## Por que o ASP.NET Core não dá deadlock aqui (e como ele morde de outra forma)

Se você migrou do ASP.NET clássico para o ASP.NET Core e seus antigos deadlocks sumiram, este é o motivo: o ASP.NET Core não tem `SynchronizationContext`. `SynchronizationContext.Current` é `null` dentro de uma requisição, então `await` nunca captura um contexto de thread única, as continuações sempre rodam em threads do pool de threads, e a espera circular específica descrita acima não pode se formar. É por isso também que `ConfigureAwait(false)` não tem efeito em um manipulador de requisição do ASP.NET Core: não há contexto do qual sair.

Isso não torna o bloqueio seguro no ASP.NET Core. Ele troca um deadlock determinístico por um probabilístico chamado inanição do pool de threads. Cada requisição que se bloqueia sobre `.Result` estaciona uma thread do pool de threads sem fazer nada além de esperar. Sob carga, o pool distribui threads mais rápido do que a taxa de injeção (por padrão, gradual) consegue repor as estacionadas, então novas requisições entram na fila sem nenhuma thread para rodar. A aplicação não trava na requisição um; ela cai em uma concorrência que você não consegue reproduzir no seu notebook. A cura é idêntica: não bloqueie, vá assíncrono de ponta a ponta. Se seu bloqueio estava lá para limitar uma operação longa, faça isso com cancelamento em vez disso, como em [cancelar uma Task de longa duração sem deadlock](/pt-br/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/), e garanta que o token realmente chegue à chamada folha [propagando o CancellationToken pela cadeia](/pt-br/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/).

## Uma lista de verificação para caçar o bloqueio que trava

Quando algo trava e você suspeita disto, procure o bloqueio, não o método async:

1. **Procure no caminho síncrono por `.Result`, `.Wait(` e `.GetAwaiter().GetResult()`.** Um deles está em uma thread que possui um contexto. Esse é o seu culpado, não o inocente `await` que ele está bloqueando.
2. **Confirme que há um contexto de thread única em jogo.** Thread de UI, requisição do ASP.NET clássico ou um contexto personalizado. Se você está no ASP.NET Core ou em uma aplicação de console simples sem contexto instalado, o sintoma é inanição ou uma resposta lenta, não um travamento total.
3. **Substitua o bloqueio por `await` e torne o método envolvente `async Task`.** Repita para cima na pilha até chegar a um ponto de entrada que possa ser assíncrono (um manipulador de eventos, um `Main`, uma action de controller).
4. **Se uma camada genuinamente não pode ser async**, e você possui a biblioteca async, adicione `ConfigureAwait(false)` em toda essa biblioteca. Se você não a possui, a descarga com `Task.Run` é o último recurso, com os custos acima.
5. **Nunca "resolva" isso com um tempo limite.** Um `Wait(timeout)` que retorna false é um deadlock que desiste, não um design que funciona.

A linha condutora é simples: código async quer continuar async. No momento em que você o bloqueia a partir de uma thread que sua continuação precisa, você construiu uma espera circular na mão. Pare de bloquear e o deadlock não pode existir. Todo o resto nesta página é controle de danos para os casos em que você ainda não pode parar de bloquear.

## Related

- [Quando async void é correto e quando é uma armadilha em C#](/pt-br/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)
- [ConfigureAwait(false) versus o comportamento padrão no .NET 11: ainda importa?](/pt-br/2026/05/configureawait-false-vs-default-in-dotnet-11/)
- [Como cancelar uma Task de longa duração em C# sem deadlock](/pt-br/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)
- [Como propagar um CancellationToken através de métodos async no .NET 11](/pt-br/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/)

## Sources

- [Don't Block on Async Code](https://blog.stephencleary.com/2012/07/dont-block-on-async-code.html) -- Stephen Cleary
- [ConfigureAwait FAQ](https://devblogs.microsoft.com/dotnet/configureawait-faq/) -- .NET Blog
- [ASP.NET Core SynchronizationContext](https://blog.stephencleary.com/2017/03/aspnetcore-synchronization-context.html) -- Stephen Cleary
- [Synchronous wrappers for asynchronous methods](https://learn.microsoft.com/en-us/dotnet/standard/asynchronous-programming-patterns/synchronous-wrappers-for-asynchronous-methods) -- Microsoft Learn
- [CA2007: Do not directly await a Task](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2007) -- Microsoft Learn
