---
title: "Correção: CS1998 \"This async method lacks 'await' operators and will run synchronously\" em C#"
description: "CS1998 significa que um método async não tem await, então ele roda de forma síncrona. Remova o modificador async e retorne Task.FromResult, ou adicione o await que faltou."
pubDate: 2026-08-05
template: error-page
tags:
  - "errors"
  - "csharp"
  - "csharp-14"
  - "dotnet"
  - "dotnet-10"
  - "async"
lang: "pt-br"
translationOf: "2026/08/fix-cs1998-this-async-method-lacks-await-operators-and-will-run-synchronously"
translatedBy: "claude"
translationDate: 2026-08-05
---

`CS1998` aparece quando um método tem o modificador `async` mas o corpo dele não contém nenhuma expressão `await`, de modo que o método inteiro roda de forma síncrona e você paga pela maquinaria assíncrona sem receber assincronia em troca. A correção quase sempre é remover o `async` e retornar uma tarefa já concluída: `Task.CompletedTask`, `Task.FromResult(value)` ou `ValueTask.FromResult(value)`. Se o método deveria aguardar alguma coisa, adicione o `await` que está faltando. Não silencie o aviso com `await Task.CompletedTask`, porque isso mantém todos os custos dos quais o aviso reclama. Uma coisa mudou e a maioria dos resultados de busca ainda não acompanhou: a partir do SDK do .NET 10, o compilador C# não emite mais `CS1998` de jeito nenhum. Tudo abaixo foi verificado contra o SDK 10.0.201 (Roslyn 5.3.0) e o .NET 10.0.5.

## O aviso em contexto

```
warning CS1998: This async method lacks 'await' operators and will run synchronously. Consider using the 'await' operator to await non-blocking API calls, or 'await Task.Run(...)' to do CPU-bound work on a background thread.
```

É um aviso, não um erro, então a build tem sucesso a menos que você tenha `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>` no `.csproj`. A Microsoft o documenta como `WRN_AsyncLacksAwaits` na [referência de mensagens do compilador sobre async e await](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/async-await-errors), com a orientação oficial de "adicione pelo menos uma expressão `await` ao corpo do método, ou remova o modificador `async` e retorne a tarefa diretamente".

## Por que o compilador sinaliza isso

Um método `async` sem `await` nunca suspende. O corpo roda do início ao fim na thread chamadora, exatamente como um método síncrono, e então a máquina de estados gerada pelo compilador entrega ao chamador uma tarefa que já está no estado `RanToCompletion`. Nada foi para uma thread em segundo plano, nada se sobrepôs a nada. A palavra-chave `async` não tornou o método assíncrono; ela apenas mudou como o resultado e as exceções do método são empacotados.

Esse empacotamento não é de graça. Veja o que ele custa, medido no .NET 10.0.5, x64, Release, com um laço simples de `Stopwatch` sobre dois milhões de chamadas e `GC.GetAllocatedBytesForCurrentThread` para alocação. Não são números do BenchmarkDotNet, então trate-os como ordens de grandeza e não como valores precisos:

| Formato | Bytes por chamada | ns por chamada |
| --- | --- | --- |
| `async Task` sem `await` | 0 | 12,1 |
| `Task.CompletedTask` | 0 | 2,3 |
| `async Task<string>` sem `await` | 72 | 27,9 |
| `Task.FromResult("ok")` | 72 | 16,0 |
| `async ValueTask<int>` sem `await` | 0 | 15,6 |
| `ValueTask.FromResult(42)` | 0 | 3,0 |

Duas coisas chamam atenção. A coluna de alocação é idêntica em cada par, porque um método assíncrono que conclui de forma síncrona nunca faz boxing da máquina de estados (a struct fica na pilha quando não há suspensão) e o `AsyncTaskMethodBuilder` não genérico devolve uma tarefa concluída que está em cache. Então o folclore de que "async aloca" não se aplica aqui. O que você realmente paga são cerca de 10 a 15 nanossegundos de encanamento do builder por chamada. Isso é irrelevante em um método que acessa um banco de dados e significativo em um laço quente, que é exatamente por que isso era um aviso e não um erro.

## Reprodução mínima

O menor código que produz o aviso em qualquer SDK até o .NET 9 inclusive:

```csharp
// C# 14, .NET SDK 9.0.x or earlier
public class UserService
{
    private readonly Dictionary<int, User> _cache = new();

    public async Task<User> GetUserAsync(int id)   // CS1998
    {
        return _cache[id];
    }
}
```

O formato mais comum no mundo real é aquele que começou correto e apodreceu:

```csharp
// C# 14
public async Task<Report> BuildReportAsync(int id)
{
    // var rows = await _db.QueryAsync(id);   <- deleted during a refactor
    var rows = _cachedRows[id];
    return new Report(rows);                  // CS1998, and the method is now
}                                             // async for no reason at all
```

Ninguém escreve a primeira versão de propósito. A segunda aparece o tempo todo, e esse é todo o argumento a favor do aviso: ele é um detector de apodrecimento, não uma regra de estilo.

## Correção 1: remova o async e retorne uma tarefa concluída

Esta é a correção certa na esmagadora maioria dos casos. Remova o modificador, mantenha a assinatura que retorna `Task` e envolva o valor:

```csharp
// C# 14, .NET 10
public Task<User> GetUserAsync(int id)
{
    return Task.FromResult(_cache[id]);
}

public Task SaveAsync(User user)
{
    _cache[user.Id] = user;
    return Task.CompletedTask;          // the Task equivalent of FromResult
}

public ValueTask<int> CountAsync()
{
    return ValueTask.FromResult(_cache.Count);   // no Task allocation at all
}
```

A assinatura não muda, então nenhum chamador precisa ser tocado, e a máquina de estados desaparece. Se o método está em um caminho quente e o resultado dele normalmente já está disponível de forma síncrona, `ValueTask<T>` remove também a alocação de 72 bytes do `Task<T>`; os trade-offs estão em [o que é ValueTask e quando vale a pena](/pt-br/2026/06/what-is-valuetask-and-when-is-it-worth-it/).

Há uma mudança de comportamento que você precisa considerar, e é por isso que essa correção não é puramente mecânica. Em um método `async`, uma exceção lançada pelo corpo é capturada e colocada na tarefa retornada. Remova o `async` e a exceção é lançada de forma síncrona, no ponto da chamada, antes de o chamador sequer receber uma tarefa para aguardar. Isso é fácil de demonstrar:

```csharp
// C# 14, .NET 10.0.5
static async Task ThrowsFromTaskAsync() => throw new InvalidOperationException("boom");
static Task ThrowsAtCallSiteAsync() => throw new InvalidOperationException("boom");

var t1 = ThrowsFromTaskAsync();   // returns a faulted task, no exception here
await t1;                          // InvalidOperationException surfaces here

var t2 = ThrowsAtCallSiteAsync();  // throws right here, before any await
```

Para a maior parte do código essa diferença é invisível, porque o chamador aguarda imediatamente. Ela fica visível quando a chamada não é aguardada de imediato: ao juntar tarefas em uma lista e passá-las para `Task.WhenAll`, ao guardar uma tarefa em um campo, ou ao envolver a chamada em um `try`/`catch` que protege apenas o `await`. Se o seu método pode lançar antes de produzir um valor, mantenha a exceção dentro da tarefa:

```csharp
// C# 14, .NET 10
public Task<Stream> OpenAsync(string path)
{
    try
    {
        return Task.FromResult<Stream>(new FileStream(path, FileMode.Open));
    }
    catch (Exception ex)
    {
        return Task.FromException<Stream>(ex);   // same shape as async would produce
    }
}
```

Foi exatamente esse cenário que Stephen Toub levantou em [dotnet/roslyn#77001](https://github.com/dotnet/roslyn/issues/77001) ao argumentar que uma reescrita ingênua com `Task.FromResult` costuma estar incorreta.

## Correção 2: adicione o await que você queria escrever

Se o aviso apareceu depois de uma refatoração, a correção honesta geralmente é restaurar a chamada que deveria ser aguardada:

```csharp
// C# 14, .NET 10
public async Task<Report> BuildReportAsync(int id, CancellationToken ct)
{
    var rows = await _db.QueryAsync(id, ct);
    return new Report(rows);
}
```

Procure um [CS4014 "because this call is not awaited"](/pt-br/2026/07/fix-cs4014-because-this-call-is-not-awaited-execution-continues-in-csharp/) irmão no mesmo arquivo. Os dois avisos juntos, um dizendo que você não tem nenhum await e outro dizendo que você descartou uma tarefa, são um sinal quase certo de que um `await` sumiu, e não de que o método nunca foi assíncrono.

## Correção 3: Task.Run, e por que a sugestão da própria mensagem geralmente está errada

O texto do aviso sugere `await Task.Run(...)` para trabalho intensivo de CPU. Esse conselho é correto para um cliente desktop, onde o objetivo é tirar o trabalho da thread de interface:

```csharp
// C# 14, .NET 10, WPF or MAUI
private async void OnCalculateClicked(object sender, EventArgs e)
{
    var result = await Task.Run(() => CrunchNumbers(_input));   // UI stays responsive
    ResultLabel.Text = result.ToString();
}
```

É um conselho ruim dentro do ASP.NET Core. Não existe thread de interface para liberar, e a requisição já roda em uma thread do pool; `Task.Run` apenas passa o trabalho para outra thread do mesmo pool e adiciona uma troca de contexto mais uma alocação de tarefa, enquanto encolhe o pool disponível para atender outras requisições. Em uma aplicação de servidor, um método síncrono deve continuar síncrono, ou se tornar genuinamente assíncrono aguardando E/S real.

## Correção 4: implementações de interface e sobrescritas que você não pode mudar

O caso que o aviso tratava pior é um membro de interface ou método virtual que precisa retornar `Task` mesmo que a sua implementação específica não tenha nada a aguardar:

```csharp
// C# 14, .NET 10
public interface INotifier
{
    Task NotifyAsync(string message);
}

public sealed class NullNotifier : INotifier
{
    public Task NotifyAsync(string message) => Task.CompletedTask;   // no async, no warning
}
```

Remover o `async` continua sendo a resposta. Onde isso for realmente impossível, suprima de forma pontual em vez de global:

```csharp
// C# 14, .NET SDK 9.0.x or earlier
#pragma warning disable CS1998 // required by INotifier, nothing to await here
public async Task NotifyAsync(string message) { _log.Info(message); }
#pragma warning restore CS1998
```

Prefira `#pragma` com um comentário explicando o motivo a `<NoWarn>$(NoWarn);CS1998</NoWarn>` no arquivo de projeto. A supressão no nível do projeto esconde todas as ocorrências futuras, inclusive o caso de apodrecimento por refatoração que o aviso realmente detecta bem.

## Para onde o aviso foi no .NET 10

Se você está lendo isto porque o aviso parou de aparecer, e não porque ele apareceu, esta é a resposta: ele foi removido do compilador. O [dotnet/roslyn#80144](https://github.com/dotnet/roslyn/pull/80144), integrado em 2025-09-19 para o marco 18.0 P2, removeu `WRN_AsyncLacksAwaits` inteiramente, junto com os provedores de correção de código do C# "Remove async modifier" e "Make method synchronous". O raciocínio, vindo do [dotnet/roslyn#77001](https://github.com/dotnet/roslyn/issues/77001), é que o aviso empurrava as pessoas para um código pior: obrigadas a satisfazer um contrato que retorna `Task`, elas escreviam `await Task.FromResult(result)` para silenciá-lo, o que mantém a máquina de estados, adiciona um await e deixa o método estritamente mais caro sem torná-lo mais seguro. A decisão que encerrou aquela discussão foi direta: depois de debater, e especialmente por causa do runtime async, a equipe removeria esse aviso por completo.

Você pode verificar a remoção com uma única build. Este projeto compila limpo no SDK 10.0.201:

```csharp
// C# 14, .NET SDK 10.0.201 -> 0 warnings
public class C
{
    public async Task Empty() { }
    public async Task<int> Value() { return 42; }
    public async void VoidMethod() { }
    public async IAsyncEnumerable<int> Stream() { yield return 1; }
}
```

Nenhum deles produz um diagnóstico, e nem `-warnaserror:CS1998` nem `dotnet_diagnostic.CS1998.severity = error` no `.editorconfig` o trazem de volta, porque não sobrou diagnóstico algum para elevar. `CS4014` continua sendo emitido pelo mesmo compilador, então isso é específico do `CS1998` e não uma perda geral de avisos sobre async.

O recurso voltou como analisadores de IDE opcionais no [dotnet/roslyn#81835](https://github.com/dotnet/roslyn/pull/81835), integrado em 2026-01-07 para o marco 18.4, deliberadamente dividido em dois identificadores de diagnóstico para que o caso das implementações de interface possa ser ajustado separadamente:

- `IDE0390` (`RemoveUnnecessaryAsyncModifier`): métodos normais e lambdas.
- `IDE0391` (`RemoveUnnecessaryAsyncModifierInterfaceImplementationOrOverride`): métodos que implementam um membro de interface ou sobrescrevem um método base.

Ambos aparecem como "Make method synchronous" com a mensagem "Method can be made synchronous", e nenhum vem habilitado por padrão. Para recuperar o comportamento antigo onde você quiser:

```ini
# .editorconfig
[*.cs]
dotnet_diagnostic.IDE0390.severity = warning
dotnet_diagnostic.IDE0391.severity = suggestion
```

```xml
<!-- .csproj: required to see IDE rules in dotnet build, not just in the IDE -->
<PropertyGroup>
  <EnforceCodeStyleInBuild>true</EnforceCodeStyleInBuild>
</PropertyGroup>
```

Uma ressalva vinda dos testes: no SDK 10.0.201 os dois analisadores ainda não estão presentes. A configuração acima não produz nada, enquanto uma regra de controle como `IDE0161` configurada do mesmo jeito reporta normalmente, então o encanamento está certo e as regras simplesmente não foram distribuídas naquela faixa do SDK. Elas miram o marco 18.4, então é preciso um SDK mais novo ou uma atualização do Visual Studio 2026.

## Pegadinhas e variantes

- **A CI falha, a build local passa.** Um `global.json` fixando o SDK 9 no agente de build continua emitindo `CS1998`, e com `TreatWarningsAsErrors` isso é uma build vermelha para um código que compila limpo em uma máquina de desenvolvimento com SDK 10. Alinhe a faixa do SDK antes de caçar qualquer coisa mais exótica.

- **ReSharper e Rider continuam reportando.** A análise da JetBrains é independente da do Roslyn, então a inspeção pode persistir no editor depois que o compilador parou de emitir o aviso. Desligue-a nas configurações de inspeção do ReSharper em vez de esperar que uma chave do compilador afete isso.

- **`await Task.CompletedTask` é o pior silenciador possível.** Ele elimina o aviso adicionando um `await` de verdade, o que significa manter a máquina de estados, manter o custo do builder e ainda somar uma ida e volta do awaiter. É estritamente mais caro que o código que disparou o aviso. O mesmo vale para `await Task.FromResult(value)`.

- **`async void` sem awaits.** Remover o `async` de `async void SomeHandler()` é ganho puro: se não há nada a aguardar, nada se beneficia da máquina de estados, e você perde o [comportamento de exceções do async void](/pt-br/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/), em que uma falha é relançada no contexto de sincronização e pode derrubar o processo.

- **Nunca significou "este método bloqueia".** `CS1998` diz que não há `await`, não que o corpo bloqueia. Um método que chama `.Result` ou `.Wait()` dentro de um corpo `async` silencia o aviso apenas se existir algum outro `await`, e é um problema bem pior: veja [o deadlock que você ganha ao chamar .Result ou .Wait()](/pt-br/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/).

- **Iteradores assíncronos.** Um método `async IAsyncEnumerable<T>` com `yield return` e sem `await` continua sendo um fluxo assíncrono legítimo, e a remoção do aviso pelo compilador é um alívio ali. Se você consome um deles, note que um `await foreach` sobre um fluxo que nunca aguarda de fato não dá concorrência, apenas uma interface.

O modelo mental que sobrevive à remoção do aviso: `async` é uma estratégia de compilação, não um contrato de API. O contrato é a assinatura que retorna `Task`. Quando não há nada a aguardar, mantenha o contrato e descarte a estratégia, tomando cuidado para que tudo que possa lançar continue falhando a tarefa em vez de lançar no ponto da chamada. Essa era a resposta certa quando `CS1998` gritava com você, e continua sendo a resposta certa agora que ele ficou quieto.

## Relacionados

- [Correção: CS4014 "Because this call is not awaited, execution of the current method continues" em C#](/pt-br/2026/07/fix-cs4014-because-this-call-is-not-awaited-execution-continues-in-csharp/) para o aviso que costuma aparecer junto de um `await` esquecido.
- [async void vs async Task em C#: quando cada um está certo](/pt-br/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) para entender por que um método `async void` sem awaits merece ser corrigido primeiro.
- [O que é ValueTask e quando vale a pena?](/pt-br/2026/06/what-is-valuetask-and-when-is-it-worth-it/) para o caso de conclusão síncrona em que `ValueTask.FromResult` ganha de `Task.FromResult`.
- [Correção: deadlock ao chamar .Result ou .Wait() em um método async em C#](/pt-br/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/) para a variante realmente perigosa de "este método async não é assíncrono de verdade".
- [.NET 11 runtime async dispensa a flag EnablePreviewFeatures](/pt-br/2026/07/dotnet-11-runtime-async-no-longer-needs-enablepreviewfeatures/) para a mudança no nível do runtime que deixou o time do compilador confortável para descartar este aviso.

## Fontes

- Microsoft Learn, [Resolve errors and warnings that involve async, await and the task-asynchronous protocol](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/async-await-errors) (texto exato do `CS1998` e a orientação oficial de adicionar await ou remover async).
- dotnet/roslyn, [PR #80144: Remove CS1998 warning entirely and remove dependent C# code fix providers](https://github.com/dotnet/roslyn/pull/80144) (integrado em 2025-09-19, marco 18.0 P2).
- dotnet/roslyn, [Issue #77001: Consider not emitting CS1998 for interface implementations / method overrides](https://github.com/dotnet/roslyn/issues/77001) (o antipadrão `await Task.FromResult` e a decisão de remover o aviso).
- dotnet/roslyn, [PR #81835: Add back async fixers](https://github.com/dotnet/roslyn/pull/81835) (os analisadores opcionais `IDE0390` e `IDE0391`, integrados em 2026-01-07, marco 18.4).
- dotnet/roslyn, [Issue #82692: Warnings (at least CS1998) are not showing with SDK 10 compared to SDK 9](https://github.com/dotnet/roslyn/issues/82692) (confirmação de que a mudança de comportamento vem com o SDK, não com o target framework).
- Microsoft Learn, [Task.FromException method](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.task.fromexception) (como produzir uma tarefa falha sem um método `async`).
