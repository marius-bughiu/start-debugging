---
title: "Retornar um Task diretamente vs repassar com async/await em um método de repositório em C#: qual usar?"
description: "Omitir async/await em um método de repasse de repositório economiza cerca de 6 ns e 72 bytes, e custa um quadro de pilha, a semântica de try/catch e o descarte seguro de recursos. Mantenha return await, a menos que o método seja um repasse puro em um caminho quente medido."
pubDate: 2026-09-01
template: vs
tags:
  - "comparison"
  - "csharp"
  - "csharp-14"
  - "dotnet"
  - "dotnet-11"
  - "async"
  - "performance"
lang: "pt-br"
translationOf: "2026/09/return-task-directly-vs-async-await-passthrough-in-a-csharp-repository-method"
translatedBy: "claude"
translationDate: 2026-09-01
---

Você tem um método de repositório que não faz nada além de repassar para o EF Core, o Dapper ou um `HttpClient`. Você pode escrevê-lo como `public Task<Order> GetAsync(int id) => _db.Orders.FindAsync(id).AsTask();` e pular a máquina de estados, ou como `public async Task<Order> GetAsync(int id) => await _db.Orders.FindAsync(id);` e mantê-la. **Mantenha o `await`.** Omiti-lo compra cerca de 6 nanossegundos e 72 bytes por chamada no .NET 10, o que é invisível ao lado de qualquer ida e volta ao banco de dados, e custa um quadro em todo stack trace mais três comportamentos que mudam silenciosamente se o método algum dia ganhar um `using`, um `try` ou um `lock`. Omita apenas quando o método for um repasse genuíno de uma linha em um caminho que você já perfilou. Todas as medições abaixo são no .NET 10.0.10 com C# 14; a história do .NET 11 (Preview 7, versão final em 2026-11-10) está no fim e enfraquece o argumento a favor da omissão, não o fortalece.

## As duas formas em resumo

| Comportamento                                        | `return await inner()` (async) | `return inner()` (omitido) |
| ---------------------------------------------------- | ------------------------------ | -------------------------- |
| Máquina de estados gerada                            | sim                            | não                        |
| Aparece no stack trace da exceção                    | sim                            | **não**                    |
| Custo, a chamada interna completa sincronamente      | 8,5 ns / 144 B                 | 2,6 ns / 72 B              |
| Custo, a chamada interna realmente suspende          | 1111 ns / 286 B                | 1010 ns / 191 B            |
| Seguro dentro de `using` / `await using`             | sim                            | **não**                    |
| O `try`/`catch` em volta da chamada funciona         | sim                            | **não**                    |
| Exceções de validação de argumentos aparecem         | no `await`                     | no local da chamada        |
| O tipo de retorno pode diferir do interno            | sim (covariância, `ValueTask`) | não (CS0029)               |
| Dá para aplicar `ConfigureAwait(false)`              | sim                            | n/d (herda o interno)      |
| Dispara CS1998 se você remover o último await        | sim                            | n/d                        |

Duas linhas dessa tabela são fatos de tempo de compilação e o resto é comportamento em tempo de execução que você só vai descobrir em produção. Essa assimetria é todo o argumento a favor do padrão.

## O que o compilador realmente emite

`async` não é uma convenção de chamada, é uma reescrita. Quando você marca um método como `async`, o Roslyn o transforma em um struct que implementa `IAsyncStateMachine`, eleva cada variável local a um campo desse struct e substitui o corpo por um switch dentro de `MoveNext()`. O próprio método vira um stub que cria um `AsyncTaskMethodBuilder<T>`, inicia a máquina e retorna `builder.Task`. Esse `Task<T>` retornado é uma tarefa **nova**, distinta da que a chamada interna produziu, e o builder é responsável por completá-la quando a tarefa interna terminar.

Omita o `async` e nada disso acontece. O método compila para uma chamada simples mais um return, e quem chamou recebe a *mesma* instância de `Task<T>` que o método interno criou. Não há builder, nem máquina de estados no heap, nem registro de continuação, nem uma segunda tarefa.

```csharp
// .NET 10, C# 14
public sealed class OrderRepository(AppDbContext db)
{
    // elided: the caller gets the exact Task instance EF Core created
    public Task<List<Order>> GetOpenAsync(CancellationToken ct) =>
        db.Orders.Where(o => o.Status == OrderStatus.Open).ToListAsync(ct);

    // await passthrough: EF Core's task is awaited, and a second task is handed out
    public async Task<List<Order>> GetOpenAwaitedAsync(CancellationToken ct) =>
        await db.Orders.Where(o => o.Status == OrderStatus.Open).ToListAsync(ct);
}
```

Os dois compilam. Os dois estão corretos *para este corpo exato*. As diferenças começam no momento em que o corpo deixa de ser exatamente este.

## Quanto o await extra realmente custa

Medi as duas formas com o BenchmarkDotNet 0.15.8 em um Apple M4 (10 núcleos), macOS 26.6.2, .NET SDK 10.0.302, runtime hospedeiro .NET 10.0.10, Arm64 RyuJIT, com `MemoryDiagnoser` ligado e GC de estação de trabalho. Dois cenários: um método interno que completa sincronamente (`Task.FromResult`, o caso de acerto no cache de primeiro nível do EF Core) e outro que realmente suspende (`await Task.Yield()`, o caso de E/S real).

| Método              | Média      | Ratio | Alocado   | Ratio aloc. |
| ------------------- | ---------- | ----- | --------- | ----------- |
| `Elided_Completed`  | 2,63 ns    | 1,00  | 72 B      | 1,00        |
| `Awaited_Completed` | 8,47 ns    | 3,22  | 144 B     | 2,00        |
| `Elided_Suspends`   | 1009,95 ns | 383,5 | 191 B     | 2,65        |
| `Awaited_Suspends`  | 1110,81 ns | 421,8 | 286 B     | 3,97        |

Leia os ratios e omitir parece uma vitória de 3x. Leia os números absolutos e são 5,8 nanossegundos e 72 bytes no caminho síncrono, 101 nanossegundos e 95 bytes no caminho que suspende. Os 72 bytes do caminho rápido são a segunda `Task<int>` que o builder aloca; os 95 bytes do caminho lento são a máquina de estados no heap mais essa tarefa.

Agora coloque isso ao lado do que um método de repositório de fato faz. Uma ida e volta a um PostgreSQL local leva de 200 a 500 microssegundos. Uma entre zonas de disponibilidade leva alguns milissegundos. 101 nanossegundos ficam entre 0,002% e 0,05% de uma única consulta. Você precisaria da ordem de dez mil repasses omitidos para recuperar o tempo de uma consulta. O caso de conclusão síncrona é o único em que o ratio não é completamente engolido, e esse caso importa exatamente onde se espera: um laço apertado sobre um valor já em cache, um caminho rápido de `ValueTask`, um laço quente de serialização. Não `GetOrderByIdAsync`.

## Onde omitir muda o comportamento silenciosamente

### O quadro de pilha desaparece

Esse é o custo que você paga todo dia e só percebe às 3 da manhã. Um método que retorna uma tarefa sem aguardá-la termina no instante em que retorna; quando a exceção é lançada, o quadro dele já sumiu há muito tempo. Stack traces em código assíncrono são um registro de continuações pendentes, não de quem chamou quem.

```csharp
// .NET 10, C# 14
static Task ElidedPassthroughAsync() => ThrowAsync();
static async Task AwaitedPassthroughAsync() => await ThrowAsync();

static async Task ThrowAsync()
{
    await Task.Yield();
    throw new InvalidOperationException("boom");
}
```

Capturar no topo e imprimir `ex.StackTrace` dá dois retratos diferentes:

```text
=== ELIDED ===
   at Program.<<Main>$>g__ThrowAsync|0_2() in Program.cs:line 16
   at Program.<Main>$(String[] args) in Program.cs:line 4

=== AWAITED ===
   at Program.<<Main>$>g__ThrowAsync|0_2() in Program.cs:line 16
   at Program.<<Main>$>g__AwaitedPassthroughAsync|0_1() in Program.cs:line 11
   at Program.<Main>$(String[] args) in Program.cs:line 7
```

`ElidedPassthroughAsync` não aparece no trace de jeito nenhum. Em um exemplo de dois métodos isso é curiosidade. Em um serviço real onde o equivalente de `ThrowAsync` (uma `SqlException` saindo de `ToListAsync`) é alcançado a partir de onze métodos de repositório diferentes, os quadros omitidos são justamente os que teriam dito qual recurso quebrou. Se você já leu sobre como o [Runtime Async no .NET 11 limpa os stack traces assíncronos](/pt-br/2026/04/dotnet-11-runtime-async-cleaner-stack-traces/), note que ele deixa muito mais legíveis os quadros que você *tem*, mas não consegue ressuscitar um quadro que nunca registrou uma continuação.

### `using` descarta antes de o trabalho terminar

Isso é o bug, não um compromisso. `using var` compila para um `try`/`finally` em volta do resto do escopo, e o `finally` roda quando o método retorna. Um método que omite o await retorna assim que a chamada interna devolve uma tarefa incompleta.

```csharp
// .NET 10, C# 14 -- broken: the resource is disposed while the task is still running
static Task<int> BadAsync()
{
    using var res = new Resource();
    return res.UseAsync();
}

// correct: the finally runs after the awaited work completes
static async Task<int> GoodAsync()
{
    using var res = new Resource();
    return await res.UseAsync();
}
```

`BadAsync` lança `ObjectDisposedException: Cannot access a disposed object. Object name: 'Resource'` todas as vezes; `GoodAsync` completa. O mesmo vale para `await using` sobre um `IAsyncDisposable`, para um `SemaphoreSlim` liberado em um `finally` e para qualquer escopo de transação. Se o seu repositório abre uma conexão, inicia uma transação ou aluga de um pool, omitir não é otimização, é uso após liberação. As regras de ordem de descarte estão detalhadas em [implementar e consumir IAsyncDisposable com await using](/pt-br/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/).

### `try`/`catch` para de capturar

Mesmo mecanismo, sintoma diferente. Um bloco `catch` só captura exceções lançadas enquanto o quadro está na pilha. Uma exceção lançada depois que o método interno suspende é entregue na tarefa retornada, muito depois de o seu bloco `try` ter saído.

```csharp
// .NET 10, C# 14
static Task<string> ElidedTryAsync()
{
    try { return ThrowAsync(); }                              // catch never runs
    catch (InvalidOperationException) { return Task.FromResult("caught"); }
}

static async Task<string> AwaitedTryAsync()
{
    try { return await ThrowAsync(); }                        // catch runs
    catch (InvalidOperationException) { return "caught"; }
}
```

A versão omitida deixa `InvalidOperationException` escapar para quem chamou; a versão com await retorna `"caught"`. Essa é a variante do bug que sobrevive à revisão de código, porque o `try`/`catch` está *bem ali* e parece estar fazendo alguma coisa.

### Exceções de validação migram para o local da chamada

Um método `async` nunca lança sincronamente. Toda exceção, inclusive uma da primeira linha, é capturada e colocada na tarefa retornada. Um método que omite o await não tem builder onde capturar, então uma cláusula de guarda lança imediatamente, na expressão de chamada, antes de quem chamou ter uma tarefa para aguardar.

```csharp
// .NET 10, C# 14
static Task<int> ElidedValidateAsync(string? id)
{
    ArgumentNullException.ThrowIfNull(id);   // throws at the call site
    return Task.FromResult(id.Length);
}

static async Task<int> AsyncValidateAsync(string? id)
{
    ArgumentNullException.ThrowIfNull(id);   // throws when the task is awaited
    await Task.Yield();
    return id.Length;
}
```

Quem faz `var t = repo.GetAsync(null); /* ... */ await t;`, ou entrega o método a `Task.WhenAll` dentro de um `Select`, se comporta de forma diferente entre as duas. Com a forma omitida, `Select(x => repo.GetAsync(x)).ToList()` pode lançar *durante a materialização*, antes mesmo de chegar ao `WhenAll`, e nenhuma das tarefas já iniciadas é observada. Nenhum dos dois comportamentos é errado isoladamente, mas alternar entre eles adicionando ou removendo um `await` não é uma refatoração que os leitores esperam.

## Os casos em que omitir nem compila

`Task<T>` é uma classe, portanto é invariante. `Task<Dog>` não é um `Task<Animal>`, e o compilador vai avisar:

```text
error CS0029: Cannot implicitly convert type 'System.Threading.Tasks.Task<Dog>'
              to 'System.Threading.Tasks.Task<Animal>'
```

O mesmo muro aparece quando o método interno retorna `ValueTask<int>` e o seu contrato é `Task<int>`, algo comum assim que você toca em `FindAsync` ou em qualquer ponte com `IAsyncEnumerable`:

```text
error CS0029: Cannot implicitly convert type 'System.Threading.Tasks.ValueTask<int>'
              to 'System.Threading.Tasks.Task<int>'
```

O `await` faz a conversão de graça. Sem ele você precisa de `.AsTask()` (uma alocação, que apaga a economia) ou de uma conversão explícita que não existe. Como uma interface de repositório quase sempre expõe a abstração (`Task<IReadOnlyList<Order>>`) em vez do tipo de retorno concreto do provedor (`Task<List<Order>>`), isso não é caso limite, é a maior parte da interface. E se você estava considerando empurrar `ValueTask` para cima entre as camadas, leia antes [quando ValueTask vale a pena](/pt-br/2026/06/what-is-valuetask-and-when-is-it-worth-it/): as restrições custam mais do que a alocação.

Omitir também remove a costura onde você colocaria `ConfigureAwait(false)`. Em uma biblioteca que ainda mira um hospedeiro com `SynchronizationContext`, um repasse omitido herda o que o método interno tiver configurado, que pode ser nada. É um lugar a menos para anotar, mas também um lugar a menos para corrigir. Se essa costura ainda vale a pena em 2026 é discutido em [ConfigureAwait(false) versus o padrão no .NET 11](/pt-br/2026/05/configureawait-false-vs-default-in-dotnet-11/).

## O que o runtime async do .NET 11 faz com esse balanço

O runtime async, que não precisa mais de `<EnablePreviewFeatures>` em projetos `net11.0`, tira a suspensão das máquinas de estados geradas pelo compilador e a leva para o CLR. O Preview 7 acrescentou duas coisas que atingem diretamente esta comparação. Métodos assíncronos agora passam pela compilação em camadas em vez de rodar permanentemente o código de tier0, e o JIT ganhou uma **otimização de tail-await**: quando o último ato de um método assíncrono é aguardar uma chamada cuja tarefa retornada corresponde ao tipo de retorno do próprio método, o runtime pode emitir uma chamada de cauda implícita, "reduzindo significativamente o tamanho do código e a contagem de instruções". Essa otimização descreve exatamente `async Task<T> M() => await Inner();`. É a omissão, aplicada pelo runtime, sem que o seu código-fonte abra mão da semântica do quadro.

As mesmas notas de versão relatam que o trabalho de tail-await no tier0 derrubou a taxa máxima de alocação durante o aquecimento do TechEmpower `platform-json` de 110.580.952 B/s para 8.030.616 B/s. A direção é inequívoca: o runtime está fechando a lacuna que você estaria otimizando à mão. Escrever `return inner()` hoje para economizar 72 bytes é descartar uma otimização do compilador que chega em novembro, mantendo permanentemente todos os riscos de comportamento.

## Os analisadores que vão te empurrar na direção errada

Dois analisadores populares marcam `return await` como redundante. O **RCS1174 "Remove redundant async/await"** do Roslynator é o primeiro que você vai encontrar, e existe um pedido antigo para desligá-lo por padrão justamente porque Stephen Cleary e o time do .NET consideram a transformação insegura como regra geral. O **AsyncFixer01 "Unnecessary async/await usage"** faz a mesma sugestão. Nenhum dos dois consegue ver se o seu método vai ganhar um `using` na próxima sprint, e nenhum sabe que você depende daquele quadro nos traces de produção.

O ajuste prático é deixar os dois desligados, ou colocá-los em `suggestion` e nunca aplicar a correção automática na solução inteira. Um "aplicar RCS1174 a todos os documentos" em massa é uma das poucas refatorações capazes de introduzir `ObjectDisposedException` em uma base de código que funcionava. Note que essa é a direção oposta à do CS1998: aquele aviso dispara quando um método `async` *não tem* nenhum `await`, e ali a correção certa realmente é remover o modificador, como descrito em [como corrigir CS1998 sem quebrar o método](/pt-br/2026/08/fix-cs1998-this-async-method-lacks-await-operators-and-will-run-synchronously/).

## A regra que uso no código de repositório

- **Por padrão, `return await`.** Os 6 nanossegundos não são reais; o quadro de pilha ausente e o risco de descarte são.
- **Omita só quando as quatro condições valerem**: o corpo do método é exatamente um `return`, não há `using`, `try`, `lock` nem `finally` em lugar nenhum dele, o tipo de retorno é idêntico ao da chamada interna, e você tem um perfil mostrando o repasse em um caminho quente. Três dá para checar lendo; a quarta é a que as pessoas pulam.
- **Nunca aplique RCS1174 ou AsyncFixer01 em massa.** Suprima no nível do projeto em vez de corrigir método a método.
- **No .NET 11, pare de omitir de vez.** A otimização de tail-await entrega a geração de código de graça, e a forma omitida abre mão de quadros que o runtime teria mantido.

A parte incômoda desta comparação é que a forma omitida não é mais lenta, mais feia nem errada. Ela é genuinamente mais rápida, por uma quantidade que nenhum repositório vai perceber, em troca de um método cuja semântica muda se alguém o editar. Essa é uma troca ruim a qualquer câmbio, e o .NET 11 está prestes a zerar o numerador.

## Relacionados

- [O Runtime Async do .NET 11 substitui máquinas de estados e limpa os stack traces](/pt-br/2026/04/dotnet-11-runtime-async-cleaner-stack-traces/)
- [Como corrigir CS1998 "This async method lacks 'await' operators and will run synchronously"](/pt-br/2026/08/fix-cs1998-this-async-method-lacks-await-operators-and-will-run-synchronously/)
- [ConfigureAwait(false) versus o padrão no .NET 11: ainda importa?](/pt-br/2026/05/configureawait-false-vs-default-in-dotnet-11/)
- [O que é ValueTask e quando vale a pena?](/pt-br/2026/06/what-is-valuetask-and-when-is-it-worth-it/)
- [Como implementar e consumir IAsyncDisposable com await using em C#](/pt-br/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/)
- [.Result vs .Wait() vs GetAwaiter().GetResult() vs await em C#](/pt-br/2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp/)

## Fontes

- [Eliding Async and Await](https://blog.stephencleary.com/2016/12/eliding-async-await.html) -- Stephen Cleary
- [Notas de versão do runtime do .NET 11 Preview 7: runtime-async tiering and tail-await optimizations](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview7/runtime.md) -- dotnet/core
- [.NET 11 Preview 7 is now available](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-7/) -- .NET Blog
- [RCS1174: Remove redundant async/await](https://josefpihrt.github.io/docs/roslynator/analyzers/RCS1174/) -- Roslynator
- [Disable by default RCS1174 (issue #429)](https://github.com/JosefPihrt/Roslynator/issues/429) -- dotnet/roslynator
- [AsyncFixer: async/await analyzers and code fixes](https://github.com/semihokur/AsyncFixer) -- semihokur
- [Referência de mensagens do compilador sobre async e await](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/async-await-errors) -- Microsoft Learn
