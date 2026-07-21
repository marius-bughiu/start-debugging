---
title: "Correção: CS4014 \"Because this call is not awaited, execution of the current method continues\" em C#"
description: "CS4014 significa que você chamou um método que retorna Task sem aguardá-lo. Adicione await, ou descarte com _ = se o fire-and-forget for intencional, e trate as exceções."
pubDate: 2026-07-21
template: error-page
tags:
  - "errors"
  - "csharp"
  - "csharp-14"
  - "dotnet"
  - "dotnet-11"
  - "async"
lang: "pt-br"
translationOf: "2026/07/fix-cs4014-because-this-call-is-not-awaited-execution-continues-in-csharp"
translatedBy: "claude"
translationDate: 2026-07-21
---

`CS4014` é disparado quando você chama um método que retorna `Task` ou `Task<T>` de dentro de um método `async` mas não o aguarda com `await`. O compilador avisa que o método atual continua executando antes de a chamada terminar. Corrija adicionando `await` à chamada, que é o que você quer na grande maioria das vezes. Se o comportamento fire-and-forget for realmente intencional, torne isso explícito atribuindo o resultado a um descarte (`_ = SomeAsyncCall();`), e garanta que algo trate as exceções que a tarefa possa lançar. Isto foi verificado contra C# 14 no .NET 11; o diagnóstico se comporta assim desde que `async`/`await` chegou no C# 5, então a orientação vale para toda versão moderna do .NET.

## O erro em contexto

O compilador emite isto como um aviso, não como um erro:

```
warning CS4014: Because this call is not awaited, execution of the current method continues before the call is completed. Consider applying the 'await' operator to the result of the call.
```

Note a palavra *warning*. `CS4014` não interrompe a build por padrão, e é justamente por isso que é perigoso: é fácil de ignorar, e o bug para o qual aponta (uma tarefa executando sem ser observada, com suas exceções silenciosamente engolidas) só aparece quando você está em produção. Muitas equipes o promovem a erro com `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>` ou o mais específico `<WarningsAsErrors>CS4014</WarningsAsErrors>` no `.csproj`, exatamente para que um `await` esquecido por acidente não passe pela revisão de código.

O aviso só aparece dentro de um método `async`. O compilador raciocina que, se você se deu ao trabalho de marcar o método contêiner como `async`, uma chamada de tarefa sem aguardar é quase com certeza um descuido. Chame o mesmo método a partir de um método não `async` e você não recebe nenhum `CS4014`, o que é uma armadilha relacionada tratada mais abaixo.

## Por que isso acontece

Um método `async` que retorna `Task` começa executando de forma síncrona e retorna um objeto de tarefa no momento em que atinge seu primeiro `await` incompleto. A tarefa representa a operação ainda em andamento. Quando você escreve `DoWorkAsync();` como uma instrução solta, você joga fora esse objeto de tarefa. Duas coisas decorrem disso, e ambas são ruins.

Primeiro, a execução não espera. A linha após sua chamada roda imediatamente, antes de `DoWorkAsync` ter terminado. Qualquer código que dependa da conclusão da operação, uma escrita no banco de dados, uma descarga de arquivo, uma atualização de cache, agora corre em competição com ela. Esta é a metade "execution of the current method continues" da mensagem.

Segundo, e pior, as exceções somem. Quando você aguarda uma tarefa com `await`, qualquer exceção que ela tenha capturado é relançada dentro do seu método para que seu `try`/`catch` possa vê-la. Descarte a tarefa e não sobra nada para relançar dentro. A exceção fica sobre o objeto de tarefa descartado, sem ser observada, até que o coletor de lixo eventualmente o finalize. No .NET Framework 4.0 isso derrubava o processo; desde a 4.5 e em todo o .NET moderno o padrão é engoli-la por completo. Então uma tarefa não aguardada que falha parece exatamente um sucesso do ponto de vista de quem chamou. Essa falha silenciosa é a verdadeira razão de `CS4014` existir, e por que "simplesmente suprimir o aviso" quase nunca é o certo.

O único caso em que o compilador não pode te ajudar: `async void`. Se `DoWorkAsync` retorna `void` em vez de `Task`, não há tarefa para aguardar e não há `CS4014`, mas todos os mesmos problemas se aplicam mais um adicional: uma exceção de um método `async void` é lançada sobre o contexto de sincronização e normalmente derruba o processo. Esse é um diagnóstico à parte, tratado em [async void vs async Task em C#](/pt-br/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/).

## Reprodução mínima

O menor código que dispara `CS4014`:

```csharp
// .NET 11, C# 14
public class OrderService
{
    public async Task PlaceOrderAsync(Order order)
    {
        SaveAsync(order);          // CS4014: not awaited
        Console.WriteLine("Order placed");   // runs before SaveAsync finishes
    }

    private async Task SaveAsync(Order order)
    {
        await Task.Delay(100);     // stand-in for a real DB write
        throw new InvalidOperationException("DB down");
    }
}
```

Dois bugs em quatro linhas. `"Order placed"` é impresso antes de a escrita ter rodado, e a `InvalidOperationException` não é vista por ninguém: `PlaceOrderAsync` se completa com sucesso até onde quem chamou consegue perceber. O aviso é o único sinal que você recebe em tempo de compilação de que o pedido nunca foi de fato salvo.

Uma variante comum esconde a chamada dentro de um `Task.Run` ou de um manipulador de eventos, onde é mais fácil deixá-la passar:

```csharp
// .NET 11, C# 14
button.Clicked += async (s, e) =>
{
    RefreshAsync();   // CS4014: fire-and-forget by accident
};
```

## Correção, em detalhe

Percorra estas em ordem. A primeira é correta para quase toda ocorrência real; o restante é para as exceções genuínas.

### 1. Adicionar await (a correção que você quer 95% das vezes)

Se você está dentro de um método `async`, a intenção quase sempre é aguardar a chamada. Adicione `await`:

```csharp
// .NET 11, C# 14
public async Task PlaceOrderAsync(Order order)
{
    await SaveAsync(order);        // waits, and re-throws any exception
    Console.WriteLine("Order placed");
}
```

Agora `"Order placed"` é impresso somente depois de a escrita se completar, e se `SaveAsync` lançar, a exceção se propaga para fora de `PlaceOrderAsync` para que um `try`/`catch` de quem chamou (ou o pipeline do ASP.NET Core) possa tratá-la. Essa única mudança corrige de uma vez o bug de ordem e o bug da exceção engolida. Recorra às outras opções apenas quando você conseguir articular por que aguardar está errado.

### 2. Aguardar várias chamadas juntas com Task.WhenAll

Se a razão de você não ter aguardado com `await` foi que você queria que várias operações rodassem de forma concorrente, não descarte as tarefas: colete-as e aguarde-as juntas:

```csharp
// .NET 11, C# 14
public async Task NotifyAllAsync(IEnumerable<User> users)
{
    var tasks = users.Select(u => SendEmailAsync(u));
    await Task.WhenAll(tasks);     // all run concurrently, all awaited
}
```

`Task.WhenAll` te dá a concorrência sem abrir mão da observação: ele inicia cada tarefa, depois se completa quando a última termina, e relança se qualquer uma delas falhou. Este é o padrão correto para trabalho de fan-out e ele elimina `CS4014` porque as tarefas são aguardadas. Para os prós e contras entre este e outras abordagens paralelas, veja [Parallel.ForEach vs Parallel.ForEachAsync vs Task.WhenAll](/pt-br/2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall/).

### 3. Retornar a tarefa em vez de aguardá-la

Se seu método é um simples repasse que não faz nada após a chamada, muitas vezes você não precisa de `async`/`await` de forma alguma. Remova ambos e retorne a tarefa:

```csharp
// .NET 11, C# 14
public Task PlaceOrderAsync(Order order)
{
    return SaveAsync(order);       // caller awaits; no state machine here
}
```

Isso remove o modificador `async`, então `CS4014` não se aplica mais (o aviso só é gerado dentro de métodos `async`), e evita o custo de gerar uma máquina de estados para um método que não precisa dela. Quem chamou ainda recebe uma tarefa para aguardar com `await`. A única ressalva: sem `await`, as exceções afloram quando quem chamou aguarda a tarefa retornada em vez de no ponto da chamada, e um bloco `using` liberaria seu recurso antes de a tarefa retornada se completar. Use isto apenas para repasses genuínos.

### 4. Descartar de forma explícita, apenas quando o fire-and-forget for realmente intencional

Às vezes você realmente quer iniciar trabalho e não esperar: registrar uma métrica, aquecer um cache, disparar uma notificação de melhor esforço. Nesse caso, deixe a intenção inequívoca com um descarte, e trate você mesmo as exceções para que elas não se percam:

```csharp
// .NET 11, C# 14
public void OnUserLoggedIn(User user)
{
    _ = LogAnalyticsAsync(user);   // intentional fire-and-forget, warning cleared
}

private async Task LogAnalyticsAsync(User user)
{
    try
    {
        await _analytics.RecordAsync(user.Id);
    }
    catch (Exception ex)
    {
        _logger.LogError(ex, "Analytics failed for {UserId}", user.Id);
    }
}
```

O descarte `_ =` diz tanto ao compilador quanto ao próximo leitor "sim, eu quis não aguardar isto". Fundamental: o descarte elimina o aviso mas *não* corrige o problema da exceção engolida, então o `try`/`catch` dentro de `LogAnalyticsAsync` é quem faz o trabalho de verdade. Uma tarefa fire-and-forget sem tratamento interno de exceções é uma queda ou um bug silencioso de perda de dados esperando para acontecer.

Mesmo com um descarte, o fire-and-forget cru em uma aplicação web é frágil: a requisição pode se completar e o host pode começar a desligar enquanto sua tarefa está no meio do caminho, cancelando-a ou matando-a. Para qualquer coisa que precise realmente terminar, não faça fire-and-forget a partir de uma requisição de forma alguma; entregue o trabalho a uma fila em segundo plano. Esse padrão é coberto em [como executar trabalho fire-and-forget com segurança no ASP.NET Core com BackgroundService](/pt-br/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/).

## Armadilhas e variantes

Algumas situações produzem `CS4014`, ou o escondem, por razões que a mensagem não detalha:

- **Sem aviso fora de um método `async`.** A mesma chamada sem aguardar em um método comum (não `async`) não produz nenhum `CS4014`. O compilador presume que um método não async pode estar iniciando trabalho em segundo plano de forma legítima. É por isso que bugs se infiltram quando alguém remove um `await` e o modificador `async` contêiner ao mesmo tempo: o aviso que o teria capturado some junto com o modificador. Se você depende do aviso como rede de segurança, mantenha `<WarningsAsErrors>CS4014</WarningsAsErrors>` ativo e desconfie de qualquer chamada solta que retorne Task.

- **O descarte silencia o aviso mas não o bug.** `_ = DoAsync();` elimina `CS4014`, mas se `DoAsync` lançar e nada dentro capturar, a exceção ainda se perde. O descarte é uma declaração de intenção, não uma correção para exceções não observadas. Acompanhe sempre o fire-and-forget com um `try`/`catch` interno.

- **Bloquear com `.Result` ou `.Wait()` não é a correção.** Substituir o `await` faltante por `SaveAsync(order).Result` faz o aviso sumir e bloqueia até a tarefa terminar, mas em um contexto de sincronização de UI ou de ASP.NET clássico causa um deadlock, e em qualquer outro lugar desperdiça uma thread. Se você está tentado a bloquear porque não consegue tornar quem chama `async`, leia primeiro [o deadlock que você obtém ao chamar .Result ou .Wait() sobre um método async](/pt-br/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/).

- **`Task.Run(() => FooAsync())` engole a tarefa interna.** Passar uma lambda `async` para `Task.Run` onde o delegate retorna `void` (uma lambda `async void`) te dá uma `Task` que se completa quando a lambda *inicia* seu primeiro await, não quando o trabalho interno termina. Prefira `Task.Run(FooAsync)` ou `Task.Run(async () => await FooAsync())` para que a tarefa retornada rastreie o trabalho real, e então aguarde essa tarefa com `await`.

- **Um `CancellationToken` que você nunca propaga.** Uma causa frequente de uma tarefa fire-and-forget persistente é que o método não tem como ser cancelado, então ele continua rodando depois que quem chamou já seguiu em frente. Se sua chamada sem aguardar é trabalho em segundo plano, passe um token para ela para que possa ser interrompida de forma limpa; veja [como propagar um CancellationToken através de métodos async](/pt-br/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/).

- **Sobreposição do analisador com CA2012 e VSTHRD110.** Além do `CS4014` do compilador, os analisadores do .NET (`CA2012` para `ValueTask`) e os analisadores de threading do Visual Studio (`VSTHRD110`, "observe the awaitable result") marcam a mesma classe de descuido em mais lugares, incluindo alguns métodos não `async` onde `CS4014` permanece em silêncio. Se você quer a verificação de tarefa sem aguardar em todos os lugares, não apenas dentro de métodos `async`, ativar esses analisadores fecha a lacuna que o aviso do compilador deixa.

O modelo mental para guardar: `CS4014` é o compilador te dizendo que uma tarefa está prestes a executar sem ser observada. Decida qual é de fato o caso, e então aja de acordo. Você quis aguardar (adicione `await`), você quis rodar várias coisas de forma concorrente (`Task.WhenAll`), o método é um repasse (retorne a tarefa), ou você realmente quer fire-and-forget (descarte com `_ =` e trate as exceções dentro). Suprimir o aviso com um descarte enquanto deixa as exceções sem tratamento apenas converte um empurrão em tempo de compilação em uma falha silenciosa em tempo de execução, que é exatamente o bug que o aviso existe para prevenir.

## Relacionados

- [async void vs async Task em C#: quando cada um está correto](/pt-br/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) para entender por que a versão que retorna `void` desta chamada é ainda mais perigosa e não produz aviso.
- [Correção: deadlock ao chamar .Result ou .Wait() sobre um método async em C#](/pt-br/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/) para entender por que bloquear não é uma forma válida de silenciar CS4014.
- [Como executar trabalho fire-and-forget com segurança no ASP.NET Core com BackgroundService](/pt-br/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/) para a forma correta de iniciar trabalho que deve sobreviver a uma requisição.
- [Parallel.ForEach vs Parallel.ForEachAsync vs Task.WhenAll](/pt-br/2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall/) para escolher como executar muitas operações assíncronas de forma concorrente.
- [Como propagar um CancellationToken através de métodos async no .NET 11](/pt-br/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/) para tornar o trabalho em segundo plano cancelável em vez de órfão.

## Fontes

- Microsoft Learn, [Resolve errors and warnings that involve async, await and the task-asynchronous protocol (C# reference)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/cs4014) (texto exato de `CS4014` e a orientação de aguardar com await ou descartar de forma explícita com `_ =`).
- Microsoft Learn, [Asynchronous programming with async and await](https://learn.microsoft.com/en-us/dotnet/csharp/asynchronous-programming/) (como um método async que retorna Task executa e onde as exceções são capturadas).
- Microsoft Learn, [Task.WhenAll method](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.task.whenall) (completar-se quando todas as tarefas aguardadas terminam e relançar as falhas agregadas).
- Microsoft Learn, [CA2012: Use ValueTasks correctly](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2012) (o analisador que captura os awaitables não observados que o aviso do compilador deixa passar).
