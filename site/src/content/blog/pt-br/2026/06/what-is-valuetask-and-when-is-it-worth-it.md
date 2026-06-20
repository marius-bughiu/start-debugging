---
title: "O que é ValueTask<T> e quando vale a pena?"
description: "ValueTask e ValueTask<T> são structs que permitem que um método assíncrono retorne um resultado sem alocar um Task no heap quando ele completa de forma síncrona. O ganho é uma alocação a menos em hot paths que normalmente terminam sem aguardar. O custo é um contrato rígido de aguardar-apenas-uma-vez. Aqui está o que esse tipo realmente é, como funciona e o conjunto restrito de casos em que ele se justifica."
pubDate: 2026-06-20
tags:
  - "csharp"
  - "dotnet"
  - "async"
  - "performance"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/06/what-is-valuetask-and-when-is-it-worth-it"
translatedBy: "claude"
translationDate: 2026-06-20
---

`ValueTask` e `ValueTask<T>` são awaitables de tipo valor (struct) que um método assíncrono pode retornar em vez de `Task` ou `Task<T>`. Seu único propósito é evitar a alocação no heap que `Task<T>` incorre quando um método assíncrono completa de forma síncrona, que é o caso comum para um acerto de cache, uma leitura em buffer ou um cálculo memoizado. Quando o método termina sem nunca aguardar, um `ValueTask<T>` carrega o resultado inline na pilha e não aloca nada; apenas quando precisa esperar por trabalho assíncrono real é que ele recorre a envolver um `Task`. O detalhe é que essa economia vem com um contrato: você pode aguardar um `ValueTask` exatamente uma vez, e não deve bloquear nele, aguardá-lo duas vezes ou guardá-lo em um campo para aguardar depois. Por causa desse contrato, o tipo de retorno padrão para um método assíncrono ainda é `Task` / `Task<T>`. `ValueTask` é uma otimização orientada por profiler para um hot path, não um `Task` melhor.

Tudo aqui tem como alvo o .NET 11 (SDK `11.0.100`) e o C# 14, atuais em junho de 2026, mas o contrato do `ValueTask` está estável desde que foi lançado no .NET Core 2.1, então a mecânica se aplica a todas as versões a partir da 2.1.

## A alocação que o ValueTask existe para remover

Comece pelo que o `Task<T>` custa. Quando você escreve um método `async` que retorna `Task<T>`, o compilador C# constrói uma máquina de estados e, no momento em que o método de fato suspende ou precisa devolver uma operação pendente, ele aloca um objeto `Task<T>` no heap (24 bytes em 64-bit para o cabeçalho do objeto mais campos, antes de qualquer estado de continuação). O runtime faz cache de alguns resultados comuns: `Task.FromResult(true)`, `Task.FromResult(false)` e pequenos inteiros boxed reutilizam tasks singleton. Mas para um tipo de referência arbitrário como o seu `User`, cada chamada que retorna um `Task<User>` é uma nova alocação, mesmo quando o método já tinha a resposta dentro de um dicionário e nunca aguardou nada.

Para um método chamado algumas milhares de vezes por segundo, essa alocação é invisível. Para um em um hot path genuíno que quase sempre completa de forma síncrona, esses objetos `Task<T>` se tornam pressão no coletor de lixo que aparece como churn de gen-0 em um profiler. `ValueTask<T>` foi projetado exatamente para esse formato: um método que *normalmente* retorna um valor que já tem, e apenas *ocasionalmente* precisa ir para o modo assíncrono.

Aqui está o exemplo motivador canônico, um cache com um fallback lento:

```csharp
// .NET 11, C# 14
// Returns Task<User>: allocates a Task<User> even on the cache-hit fast path.
public Task<User> GetUserAsync(int id)
{
    if (_cache.TryGetValue(id, out var user))
        return Task.FromResult(user);   // heap allocation on every cache hit

    return LoadFromDbAsync(id);          // genuinely async, allocates anyway
}
```

A linha `Task.FromResult(user)` aloca um `Task<User>` em cada acerto de cache. Se sua taxa de acerto é de 99 por cento e o método roda milhões de vezes, você está alocando milhões de objetos task de vida curta para envolver um valor que você já tinha na pilha.

## O que o ValueTask<T> realmente é

`ValueTask<T>` é um `readonly struct` que internamente guarda uma de três coisas: um `TResult` direto, um `Task<TResult>` ou um `IValueTaskSource<TResult>` (mais sobre isso abaixo). Quando o método completa de forma síncrona, a struct carrega o resultado diretamente e nenhum `Task` é criado. Quando o método precisa aguardar trabalho real, a struct envolve o `Task<T>` que a maquinaria assíncrona produziu. O mesmo exemplo, reescrito:

```csharp
// .NET 11, C# 14
// Returns ValueTask<User>: zero allocation on the cache-hit fast path.
public ValueTask<User> GetUserAsync(int id)
{
    if (_cache.TryGetValue(id, out var user))
        return new ValueTask<User>(user);     // no allocation, result is inline

    return new ValueTask<User>(LoadFromDbAsync(id)); // wraps the real Task
}
```

No acerto de cache, `new ValueTask<User>(user)` constrói uma struct na pilha com o user dentro dela. Nada chega ao heap. No erro de cache, ele envolve o `Task<User>` de `LoadFromDbAsync`, então o caminho assíncrono custa exatamente o que custava antes. Você também pode usar a palavra-chave `async` diretamente, e o compilador cuida do empacotamento para você:

```csharp
// .NET 11, C# 14
// The async keyword builds a state machine that returns a ValueTask<User>.
// Synchronous completion still avoids the Task<User> allocation via a pooled
// state machine box when possible.
public async ValueTask<User> GetUserAsync(int id)
{
    if (_cache.TryGetValue(id, out var user))
        return user;                     // completes synchronously

    return await LoadFromDbAsync(id);    // suspends, goes async
}
```

O `ValueTask` não genérico existe pela mesma razão em métodos que não retornam valor (`async ValueTask DoWorkAsync()`), e ele evita alocar o `Task` completo quase-singleton nos casos em que até isso importa.

## O contrato: aguarde uma vez, nunca bloqueie, nunca armazene

Tudo que torna o `ValueTask` mais barato também o torna mais perigoso, e o perigo está inteiramente em como o *chamador* o consome. Um `Task<T>` é um objeto durável que você pode aguardar quantas vezes quiser, a partir de quantas threads quiser, armazenar em um campo e bloquear com `.Result`. Um `ValueTask<T>` não garante nada disso. A partir da [documentação oficial de ValueTask&lt;TResult&gt;](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.valuetask-1), as regras são:

- **Aguarde-o no máximo uma vez.** Um `ValueTask<T>` pode envolver um `IValueTaskSource<T>` poolado que é reciclado após o primeiro await. Aguardar duas vezes pode observar um resultado que agora pertence a uma operação diferente.
- **Não o aguarde concorrentemente.** Duas threads aguardando o mesmo `ValueTask<T>` é comportamento indefinido pela mesma razão.
- **Não acesse `.Result` antes de ele completar.** Em `Task<T>`, bloquear em `.Result` é apenas um risco de deadlock; em `ValueTask<T>` é comportamento indefinido a menos que o value task já seja conhecidamente completo.
- **Não o armazene para aguardar depois.** Atribuir um `ValueTask<T>` a um campo e aguardá-lo depois que algum outro código rodou é a forma mais comum de equipes corromperem resultados sob carga.

Se você precisa fazer qualquer uma dessas coisas, chame `.AsTask()` uma vez para materializar um `Task<T>` real, e então use-o:

```csharp
// .NET 11, C# 14
// Need to await twice or fan out? Convert exactly once, then treat as a Task.
ValueTask<User> vt = repo.GetUserAsync(id);
Task<User> task = vt.AsTask();   // materialize the Task once
var a = await task;
var b = await task;              // safe: Task<T> is awaitable repeatedly
```

Essa chamada `.AsTask()` aloca exatamente o `Task<T>` que você estava tentando evitar, o que é justamente o ponto: se o seu call site precisa da semântica de `Task`, você nunca ia conseguir a economia, e o `ValueTask` era puro risco. O mesmo atrito aparece com combinadores. `Task.WhenAll` e `Task.WhenAny` recebem `Task`, então uma API que retorna `ValueTask` força todo chamador que faz fan-out a escrever `.AsTask()` primeiro, alocando por item e apagando o benefício.

## O analisador que pega as violações

Você não precisa fiscalizar o contrato a olho nu. O .NET SDK traz o **CA2012 ("Use ValueTasks correctly")**, que sinaliza double-awaits, value tasks armazenados e acesso direto a `.Result`. Ele vem habilitado como sugestão por padrão no .NET 10 e posteriores. Promova-o a warning para que o build falhe em um uso incorreto:

```ini
# .editorconfig - .NET 11 SDK, CA2012 ships in the built-in analyzers
[*.cs]
dotnet_diagnostic.CA2012.severity = warning
```

Se você adotar `ValueTask` em qualquer lugar, transformar o CA2012 em warning não é opcional. É a proteção que torna o tipo seguro de usar em uma equipe onde nem todos leram as regras do Stephen Toub. Um codebase que retorna `ValueTask` sem o CA2012 promovido está a um double-await descuidado de distância de um heisenbug que só aparece sob concorrência.

## IValueTaskSource<T>: o pooling que faz realmente compensar

A terceira coisa que um `ValueTask<T>` pode envolver é um `IValueTaskSource<T>`. Este é o caso avançado e o que entrega o maior ganho: um único objeto de apoio, implementando `IValueTaskSource<T>`, pode ser reutilizado por muitas operações, de modo que até o caminho assíncrono não aloca nada por chamada. O runtime usa isso internamente para `Socket`, `NetworkStream` e a maquinaria de `System.IO.Pipelines`, onde uma conexão realiza milhões de leituras e você não pode arcar com um `Task` por leitura.

Você raramente escreve um à mão. Quando o faz, `ManualResetValueTaskSourceCore<T>` é o auxiliar que implementa as partes difíceis (agendamento de continuação, versionamento de token para impor o aguardar-uma-vez):

```csharp
// .NET 11, C# 14
// A reusable async signal: one backing source serves many awaits over its
// lifetime, allocation-free per operation. ManualResetValueTaskSourceCore
// handles version tokens so a stale await throws instead of silently aliasing.
public sealed class Signaller : IValueTaskSource<int>
{
    private ManualResetValueTaskSourceCore<int> _core;

    public ValueTask<int> WaitAsync() => new(this, _core.Version);

    public void Complete(int value) => _core.SetResult(value);

    public int GetResult(short token) => _core.GetResult(token);
    public ValueTaskSourceStatus GetStatus(short token) => _core.GetStatus(token);
    public void OnCompleted(Action<object?> cont, object? state, short token,
        ValueTaskSourceOnCompletedFlags flags)
        => _core.OnCompleted(cont, state, token, flags);
}
```

Este é o único contexto em que o `ValueTask` confiavelmente supera o `Task` também no caminho *assíncrono*, não apenas no caminho rápido síncrono. Se você não está poolando uma source assim, o ramo assíncrono do seu método aloca um `Task` de qualquer forma e a única coisa que o `ValueTask` te economizou foi a alocação da conclusão síncrona.

## Quando vale a pena, concretamente

Recorra ao `ValueTask<T>` apenas quando todas estas condições forem verdadeiras:

1. **Um profiler mostra que a alocação de `Task<T>` é um custo real neste caminho.** Não "pode ser", mas uma linha de gen-0 em um rastreamento de memória. `ValueTask` é uma otimização que você aplica depois de medir, exatamente como você não recorreria a `Span<T>` ou ao [Native AOT](/pt-br/2026/06/what-is-native-aot-and-what-does-it-cost-you/) sem um motivo.
2. **A conclusão síncrona é o caso comum.** Acertos de cache, leituras em buffer, resultados memoizados. Se o método normalmente aguarda I/O real, você aloca um `Task` de apoio na maioria das chamadas de qualquer jeito e não ganha nada.
3. **Os call sites são awaits simples.** Um único `await` em cada consumidor, sem fan-out, sem fazer cache do awaitable, sem bloquear. No momento em que um chamador precisa de `.AsTask()`, a economia se foi.
4. **Você promoveu o CA2012 a warning.** Para que um futuro contribuidor não possa quebrar o contrato silenciosamente.

A maquinaria de async streams é o único lugar onde o `ValueTask` é correto por padrão em vez de por medição: `IAsyncEnumerator<T>.MoveNextAsync` retorna `ValueTask<bool>` e `DisposeAsync` retorna `ValueTask`, precisamente porque um enumerador reutiliza uma source de apoio em cada iteração. Se você trabalha com streams de alguma forma, [usar IAsyncEnumerable<T> com EF Core 11](/pt-br/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/) mostra o padrão em contexto, e você nunca deve "reverter" essas assinaturas para `Task`.

## Quando permanecer em Task<T>

Para a esmagadora maioria dos métodos assíncronos, retorne `Task` / `Task<T>`. O canônico [Understanding the Whys, Whats, and Whens of ValueTask](https://devblogs.microsoft.com/dotnet/understanding-the-whys-whats-and-whens-of-valuetask/) do Stephen Toub coloca de forma direta: "a escolha padrão ainda é `Task` / `Task<TResult>`." Sinais concretos de que você está recorrendo ao `ValueTask` por reflexo em vez de por evidência:

- O método faz I/O real na maioria das chamadas. Você está alocando um `Task` no caminho comum de qualquer forma, então a struct não compra nada e custa cautela.
- Os chamadores precisam aguardar duas vezes, fazer cache do resultado ou fazer fan-out com `Task.WhenAll`. Cada `.AsTask()` reintroduz a alocação e adiciona uma linha de código.
- Você nunca rodou uma passagem de `BenchmarkDotNet` com `[MemoryDiagnoser]` para confirmar que havia uma alocação a remover. Se os números estão estáveis, o tipo é puro overhead.
- O método é API pública em um pacote NuGet. Mudar `ValueTask` de volta para `Task` depois é uma quebra binária, então não se comprometa com isso sem dados.

Se você já tem `ValueTask` em um codebase e os dados não o justificam, o caminho inverso é uma edição segura e mecânica: [migrando ValueTask<T> de volta para Task<T>](/pt-br/2026/06/migrate-from-valuetask-back-to-task-when-and-why/) percorre o checklist completo, incluindo o que fazer com qualquer `IValueTaskSource<T>` escrito à mão. E qualquer que seja o tipo que você retorne, as regras para não bloquear o thread pool são as mesmas: veja [como cancelar um Task de longa duração sem deadlock](/pt-br/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) e a ainda relevante questão de se [ConfigureAwait(false) importa no .NET 11](/pt-br/2026/05/configureawait-false-vs-default-in-dotnet-11/).

## A decisão em uma linha

`ValueTask<T>` remove uma alocação de `Task<T>` no caminho de conclusão síncrona, ao preço de um contrato de aguardar-uma-vez que toda a sua equipe precisa respeitar. Use-o quando um profiler provar que aquela alocação importa e que a conclusão síncrona é o caso comum, apoie-se em `IValueTaskSource<T>` se você puder poolar uma source de apoio, transforme o CA2012 em warning e mantenha-o em async streams onde ele é correto por design. Em todo o resto, retorne `Task<T>` e gaste seu orçamento de cautela em algo que realmente mexa em um número.

## Fontes

- [ValueTask&lt;TResult&gt; Struct -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.valuetask-1)
- [Understanding the Whys, Whats, and Whens of ValueTask -- .NET Blog (Stephen Toub)](https://devblogs.microsoft.com/dotnet/understanding-the-whys-whats-and-whens-of-valuetask/)
- [CA2012: Use ValueTasks correctly -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2012)
- [ManualResetValueTaskSourceCore&lt;TResult&gt; -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.sources.manualresetvaluetasksourcecore-1)
- [ValueTask Restrictions -- Stephen Cleary](https://blog.stephencleary.com/2020/03/valuetask.html)
