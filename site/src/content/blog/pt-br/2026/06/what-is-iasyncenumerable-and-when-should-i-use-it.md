---
title: "O que é IAsyncEnumerable<T> e quando você deve usá-lo?"
description: "IAsyncEnumerable<T> é a interface para fluxos assíncronos: uma sequência cujos elementos chegam ao longo do tempo e onde cada um pode exigir um await. Veja o que ele realmente é, como await foreach e yield o impulsionam, e a regra para saber quando escolhê-lo em vez de Task<List<T>>."
pubDate: 2026-06-19
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
  - "iasyncenumerable"
lang: "pt-br"
translationOf: "2026/06/what-is-iasyncenumerable-and-when-should-i-use-it"
translatedBy: "claude"
translationDate: 2026-06-19
---

`IAsyncEnumerable<T>` é a interface para um fluxo assíncrono: uma sequência que você percorre um elemento de cada vez, onde produzir cada elemento pode exigir aguardar algo (uma leitura de rede, uma linha de banco de dados, um pedaço de arquivo). É o irmão assíncrono de `IEnumerable<T>`. Você o produz com um método iterador que combina `yield return` e `await`, e o consome com `await foreach`. Recorra a ele quando tiver muitos elementos que chegam ao longo do tempo e você não quiser armazenar todos em memória antes de processar o primeiro. Se você só produz um único resultado, ou se toda a coleção já está em memória, você não precisa dele. Esta publicação (válida a partir do .NET 11, C# 14) explica a mecânica, o motivo pelo qual as alternativas óbvias falham, e a regra de decisão.

## A lacuna que `Task<T>` e `IEnumerable<T>` deixam aberta

Alinhe as quatro formas e a célula que falta fica evidente:

| | valor único | muitos valores |
| --- | --- | --- |
| **síncrono** | `T` | `IEnumerable<T>` |
| **assíncrono** | `Task<T>` | `IAsyncEnumerable<T>` |

`Task<T>` te dá um valor, mais tarde. `IEnumerable<T>` te dá muitos valores, mas o ato de buscar cada um é síncrono: `MoveNext()` retorna um `bool`, não algo que você possa aguardar. Por anos a célula inferior direita não teve um tipo de primeira classe, e as pessoas a fingiam com duas soluções ruins.

A primeira é `Task<IEnumerable<T>>` (ou `Task<List<T>>`). Isso aguarda uma vez, e então te entrega a coleção inteira. Funciona, mas anula o propósito do streaming: nada fica visível para o seu código até que tudo tenha sido buscado. Uma consulta que retorna cinco milhões de linhas aloca uma lista de cinco milhões antes de o corpo do seu laço executar uma única vez.

A segunda é `IEnumerable<Task<T>>`. Isso é pior. É uma sequência síncrona de tarefas, o que significa que o iterador decide o conjunto completo de trabalho antecipadamente, e você não tem uma forma natural de aplicar contrapressão nem de parar de produzir tarefas quando um consumidor perde o interesse. Você também não pode fazer `await` dentro do `MoveNext` que produz a próxima tarefa, então qualquer latência por elemento bloqueia a thread.

`IAsyncEnumerable<T>`, adicionado no C# 8 e no .NET Core 3.0, preenche a célula corretamente. Cada passo da iteração é, ele próprio, aguardável, então o produtor pode aguardar entre elementos e o consumidor busca o próximo elemento apenas quando está pronto para ele.

## Como a interface realmente é

Não há mágica aqui. O contrato é pequeno:

```csharp
// System.Collections.Generic
public interface IAsyncEnumerable<out T>
{
    IAsyncEnumerator<T> GetAsyncEnumerator(
        CancellationToken cancellationToken = default);
}

public interface IAsyncEnumerator<out T> : IAsyncDisposable
{
    T Current { get; }
    ValueTask<bool> MoveNextAsync();
    ValueTask DisposeAsync();
}
```

Dois detalhes carregam todo o design.

`MoveNextAsync` retorna `ValueTask<bool>` em vez de `Task<bool>`. Essa escolha é deliberada. Você chama `MoveNextAsync` uma vez por elemento, então um fluxo de 100.000 itens significa 100.000 chamadas. Se cada uma alocasse um objeto `Task` no heap, fluxos assíncronos seriam um desastre de alocação. `ValueTask<bool>` não aloca nada quando o resultado já está disponível de forma síncrona (uma linha em buffer, por exemplo), que é o caso comum em um produtor rápido. Você só paga o custo do heap quando um elemento genuinamente tem que aguardar.

`IAsyncEnumerator<T>` implementa `IAsyncDisposable`, não `IDisposable`. A limpeza é assíncrona porque fechar o recurso subjacente (um socket, um `DbDataReader`) pode ele próprio exigir E/S. É por isso que o laço consumidor precisa de `await foreach` e não de um `foreach` simples: o descarte ao fim da iteração tem que ser aguardado.

Você quase nunca chama esses membros à mão. O compilador faz isso por você em ambas as pontas.

## Produzir um fluxo: `yield return` encontra `await`

Um método iterador assíncrono é um que retorna `IAsyncEnumerable<T>` e contém tanto `await` quanto `yield return`. O compilador o reescreve em uma máquina de estados que sabe como suspender em cada `await` e retomar no próximo `MoveNextAsync`:

```csharp
// .NET 11, C# 14
public static async IAsyncEnumerable<string> ReadLinesAsync(
    string path,
    [EnumeratorCancellation] CancellationToken ct = default)
{
    using var reader = new StreamReader(path);
    while (await reader.ReadLineAsync(ct) is { } line)
    {
        yield return line;
    }
}
```

Leia o que isso te dá. Cada linha é lida de forma assíncrona, e então entregue imediatamente. O chamador pode processar a linha um enquanto a linha dois ainda está sendo lida do disco. A memória nunca retém mais do que uma única linha mais o buffer interno do leitor, independentemente de o arquivo ter 10 linhas ou 10 gigabytes. O `using` sobre o leitor é honrado por meio do `DisposeAsync` gerado, então o handle de arquivo fecha quando a iteração termina, inclusive quando o consumidor sai antecipadamente ou uma exceção desenrola o laço.

O atributo `[EnumeratorCancellation]` sobre o parâmetro do token é a parte que as pessoas esquecem. Ele diz ao compilador que esse parâmetro deve receber o token que um consumidor passa via `WithCancellation`, encaminhando o cancelamento externo para dentro do corpo do iterador. Sem ele, o parâmetro é apenas um argumento comum que assume por padrão `CancellationToken.None` e ignora o que quer que o consumidor tenha fornecido. Mais sobre isso abaixo, porque é o bug de correção mais comum com fluxos assíncronos.

## Consumir um fluxo: `await foreach`

O lado do consumidor é uma palavra-chave mais longo do que um laço normal:

```csharp
// .NET 11, C# 14
await foreach (var line in ReadLinesAsync("huge.log", ct))
{
    if (line.Contains("ERROR"))
        await alertSink.WriteAsync(line, ct);
}
```

O compilador expande isso em chamadas a `GetAsyncEnumerator`, um laço de `await MoveNextAsync()` lendo `Current` a cada volta, e um `await DisposeAsync()` em um bloco finally. O laço é totalmente sequencial: o elemento N+1 não é solicitado até o seu corpo terminar com o elemento N. Essa forma sequencial, dirigida pela demanda, é o recurso, não uma limitação. É o que limita a memória e te dá contrapressão natural: um consumidor lento desacelera automaticamente o produtor, porque o próximo `await` do produtor não é retomado até a próxima chamada a `MoveNextAsync`.

Se a ordem de iteração não importa e você quer concorrência, `await foreach` é a ferramenta errada. Use [Parallel.ForEachAsync](/2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall/), que pode consumir um `IAsyncEnumerable<T>` e executar o corpo para vários elementos de uma vez com um limite de grau de paralelismo. `await foreach` é para processamento ordenado, um de cada vez.

## Cancelamento: o par `WithCancellation` mais `[EnumeratorCancellation]`

Um `await foreach (var x in stream)` pelado não te dá lugar nenhum para passar um token, porque a sintaxe da linguagem não tem espaço para isso. As duas peças que fecham o ciclo são `WithCancellation` no consumidor e `[EnumeratorCancellation]` no produtor:

```csharp
// Producer: token parameter is tagged
public static async IAsyncEnumerable<int> ProduceAsync(
    [EnumeratorCancellation] CancellationToken ct = default)
{
    for (var i = 0; ; i++)
    {
        await Task.Delay(100, ct);
        yield return i;
    }
}

// Consumer: token is forwarded into GetAsyncEnumerator
await foreach (var n in ProduceAsync().WithCancellation(ct))
{
    Console.WriteLine(n);
}
```

`WithCancellation` não envolve a sequência em outro iterador nem adiciona sobrecarga. Ele só registra o token de modo que, quando o compilador chama `GetAsyncEnumerator(token)`, o token flui para dentro, e `[EnumeratorCancellation]` o encaminha para o parâmetro do produtor. Cancele o token e o `await Task.Delay` pendente lança `OperationCanceledException`, que se propaga para fora através do seu `await foreach`.

Pular o token é como você obtém trabalhos em segundo plano travados e requisições presas em produção: um fluxo sobre uma rede ou um banco de dados retém uma conexão durante todo o laço, e sem um token não há como abortá-lo quando o chamador vai embora. Trate `WithCancellation(ct)` como obrigatório em qualquer fluxo apoiado por E/S.

## `ConfigureAwait` também funciona sobre o laço

`await foreach` aguarda internamente, então ele capta a captura do contexto de sincronização da mesma forma que um `await` normal. Em código de biblioteca que não deveria voltar para um contexto capturado, aplique `ConfigureAwait(false)` ao laço inteiro com `ConfigureAwait`:

```csharp
await foreach (var item in stream.ConfigureAwait(false))
{
    Process(item);
}
```

Isso configura tanto os `await` de `MoveNextAsync` quanto o `await` final de `DisposeAsync`. Em uma aplicação moderna de ASP.NET Core não há contexto de sincronização para capturar, então ali é uma operação nula, mas ainda importa para código de biblioteca, hosts de console e qualquer coisa que possa rodar sob um contexto de interface ou legado. As compensações são as mesmas de todo o resto do código assíncrono, cobertas em [se ConfigureAwait ainda importa no .NET 11](/2026/05/configureawait-false-vs-default-in-dotnet-11/).

## LINQ sobre fluxos assíncronos agora vem incluído

Uma aspereza de longa data era que `IAsyncEnumerable<T>` não tinha LINQ. Para escrever `stream.Where(...).Select(...)` você trazia o pacote NuGet comunitário `System.Linq.Async`. A partir do .NET 10 isso mudou: o runtime inclui `System.Linq.AsyncEnumerable` na BCL, então os operadores padrão funcionam sobre qualquer `IAsyncEnumerable<T>` sem referência a pacote, e o .NET 11 herda isso.

```csharp
// .NET 11: Where/Select/Take resolve from the BCL, no NuGet package
var firstTenErrors = ReadLinesAsync("huge.log", ct)
    .Where(l => l.Contains("ERROR"))
    .Take(10);

await foreach (var line in firstTenErrors.WithCancellation(ct))
    Console.WriteLine(line);
```

Se você está migrando um projeto mais antigo, remova a referência explícita a `System.Linq.Async` quando mudar para o .NET 10 ou posterior; mantê-la causa erros de sobrecarga ambígua contra os métodos agora integrados. Uma mudança de nome a conhecer: os antigos operadores `SelectAwait`/`WhereAwait` que recebiam lambdas assíncronas sumiram, e você passa o delegate assíncrono para o `Select`/`Where` regular em vez disso. Código que tem como alvo vários runtimes mais antigos deveria referenciar o pacote `System.Linq.AsyncEnumerable` em vez de `System.Linq.Async`.

## Quando você deve recorrer a ele

Use `IAsyncEnumerable<T>` quando estas três condições forem verdadeiras:

1. Há **muitos** elementos, ou um número desconhecido ou não limitado.
2. Produzir cada elemento envolve **E/S assíncrona** (banco de dados, rede, arquivo, fila de mensagens).
3. Você quer **começar a processar antes de o último elemento chegar**, ou não pode se dar ao luxo de retê-los todos em memória de uma vez.

Casos concretos que se encaixam: transmitir linhas de um banco de dados para uma exportação, como coberto em [usar IAsyncEnumerable com EF Core 11](/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/); ler uma API paginada página por página e entregar cada elemento à medida que as páginas chegam; acompanhar um log ou um fluxo de mensagens que nunca termina; canalizar dados para dentro de um [Channel](/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) ou um `PipeWriter`. No ASP.NET Core, retornar `IAsyncEnumerable<T>` de uma minimal API ou ação de controller transmite o array JSON ao cliente elemento por elemento em vez de armazenar em buffer a resposta inteira.

## Quando você não deve

Fluxos assíncronos não são gratuitos, e nem sempre são a forma certa:

- **Os dados já estão em memória.** Iterar uma `List<T>` ou um array? Use `foreach`. Envolver uma coleção em memória em um fluxo assíncrono adiciona sobrecarga de máquina de estados e não compra nada, porque nenhum elemento de fato aguarda.
- **Há exatamente um resultado.** Um método que retorna um único registro deveria retornar `Task<T>`. Um fluxo de um é só cerimônia.
- **O conjunto é pequeno e limitado e você precisa de acesso aleatório, `Count` ou várias passagens.** `Task<List<T>>` (via `ToListAsync`) é mais simples e te permite indexar, contar e reenumerar. O streaming te dá uma sequência de avanço único, de passagem única; se você precisa de mais que isso, materialize-a.
- **Você precisa de paralelismo verdadeiro sobre os elementos.** Um único `await foreach` é sequencial por design. Para fan-out, use `Parallel.ForEachAsync` ou colete tarefas e `Task.WhenAll`.

Uma regra prática útil: se você se pega chamando `ToListAsync()` sobre o fluxo imediatamente, você não queria um fluxo, queria a lista. E se você sente a tentação de envolver uma lista em memória como `IAsyncEnumerable<T>` só para satisfazer uma assinatura de método, reconsidere a assinatura.

## Uma nota sobre descarte e saída antecipada

Como o enumerador é `IAsyncDisposable`, o `await foreach` garante que `DisposeAsync` execute quando o laço termina por qualquer motivo: conclusão normal, um `break`, ou uma exceção atravessando o corpo. É isso que torna seguro o `using` dentro de um iterador assíncrono. A consequência sutil é que sair antecipadamente não necessariamente para a fonte subjacente instantaneamente. Um banco de dados pode já ter armazenado linhas do lado do servidor; um leitor de rede com buffer pode ter feito prefetch do próximo pedaço. O descarte envia o sinal de cancelamento, mas um pouco de trabalho já em andamento ainda pode se completar. Isso quase nunca é um problema, mas explica o ocasional momento de "por que essa consulta ainda está rodando depois que meu laço saiu?" em um profiler.

Fluxos assíncronos transformaram a desconfortável célula inferior direita da matriz valor/coleção em um recurso de linguagem de primeira classe. O modelo mental é o jogo inteiro: é `IEnumerable<T>` onde cada passo pode fazer `await`, dirigido por `await foreach`, e vale a pena usá-lo exatamente quando os elementos chegam ao longo do tempo e você preferiria processá-los à medida que chegam em vez de esperar por todos eles.

## Relacionado

- [How to use IAsyncEnumerable<T> with EF Core 11](/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) aplica tudo isso a transmitir linhas de banco de dados.
- [IEnumerable vs IAsyncEnumerable vs IQueryable in C#](/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/) é o guia de decisão comparativo para as três interfaces de sequência.
- [How to stream a file from an ASP.NET Core endpoint without buffering](/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) é a contraparte de resposta HTTP para produzir um fluxo.
- [How to cancel a long-running Task in C# without deadlocking](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) aprofunda nos tokens de cancelamento dos quais os fluxos assíncronos dependem.
- [Streaming tasks with .NET 9 Task.WhenEach](/2026/01/streaming-tasks-with-net-9-task-wheneach/) é a outra forma principal de consumir resultados à medida que se completam.

## Fontes

- [IAsyncEnumerable<T> interface, .NET API reference](https://learn.microsoft.com/en-us/dotnet/api/system.collections.generic.iasyncenumerable-1?view=net-10.0).
- [Generate and consume async streams, C# docs](https://learn.microsoft.com/en-us/dotnet/csharp/asynchronous-programming/generate-consume-asynchronous-stream).
- [EnumeratorCancellationAttribute class, .NET API reference](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.enumeratorcancellationattribute?view=net-10.0).
- [Breaking change: System.Linq.AsyncEnumerable in .NET 10, MS Learn](https://learn.microsoft.com/en-us/dotnet/core/compatibility/core-libraries/10.0/asyncenumerable).
- [async-streams design doc, dotnet/roslyn on GitHub](https://github.com/dotnet/roslyn/blob/main/docs/features/async-streams.md).
