---
title: "lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock em C#"
description: "Quatro formas de proteger uma seção crítica em C#, e uma matriz de decisão para escolher uma. Use System.Threading.Lock para exclusão mútua síncrona no .NET 9+, SemaphoreSlim quando a seção atravessa um await, e Monitor apenas quando você precisa de Wait/Pulse."
pubDate: 2026-05-24
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "concurrency"
lang: "pt-br"
translationOf: "2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp"
translatedBy: "claude"
translationDate: 2026-05-24
---

Para exclusão mútua síncrona em código novo no .NET 9 ou posterior, use `System.Threading.Lock` e escreva com a palavra-chave `lock`. Se a seção crítica tiver que aguardar (`await`) algo, nenhum dos primitivos síncronos é válido, então recorra a `SemaphoreSlim(1, 1)` e `await WaitAsync()`. Reserve o `Monitor` puro para o único caso que os outros não conseguem fazer de jeito nenhum: variáveis de condição (`Monitor.Wait` / `Pulse` / `PulseAll`). O idioma clássico `lock (object)` não está errado, ele apenas compila para um caminho de `Monitor` um pouco mais pesado do que o de `Lock`, então no .NET 9+ não há motivo para iniciar um novo bloqueio com um `object` simples.

Este artigo tem como alvo o .NET 11 (preview 4), C# 14 e a BCL como está `System.Threading` no net11.0. `System.Threading.Lock` é um tipo do .NET 9, então a recomendação se aplica igualmente ao .NET 9, .NET 10 e .NET 11. `Monitor` e a palavra-chave `lock` remontam ao .NET 1.1 e C# 1.0; `SemaphoreSlim` chegou no .NET Framework 4.0.

## Os quatro concorrentes não são realmente pares

A razão pela qual essa comparação confunde as pessoas é que os quatro nomes ficam em camadas diferentes.

`lock` é uma instrução da linguagem C#. Ela não implementa nada por si só. O compilador reduz `lock (x) { body }` a uma de duas formas conforme o tipo estático de `x`. Se `x` for um `System.Threading.Lock`, vira `using (x.EnterScope()) { body }`. Para qualquer outro tipo de referência vira um par `Monitor.Enter` / `Monitor.Exit` envolvido em um `try` / `finally`. Então "devo usar `lock` ou `Monitor`" é, na maioria das vezes, uma falsa escolha: `lock (someObject)` *é* `Monitor`, escrito de forma mais segura.

`Monitor` é a API estática por trás do idioma clássico. Ela faz exclusão mútua, mas também carrega duas características que os outros não têm: recursão (a mesma thread pode entrar duas vezes) e variáveis de condição via `Wait`, `Pulse` e `PulseAll`. Esses métodos de variáveis de condição são a única capacidade em toda esta comparação que não tem substituto entre os outros três.

`System.Threading.Lock` é o tipo dedicado à exclusão mútua introduzido no .NET 9. É o que o `Monitor` teria sido se não estivesse também atuando como implementação de suporte para `lock (object)`. Ele expõe exatamente o que um mutex precisa e nada mais. A análise aprofundada de [como o System.Threading.Lock funciona e como migrar para ele](/pt-br/2026/04/how-to-use-the-new-system-threading-lock-type-in-dotnet-11/) cobre seus mecanismos em detalhe.

`SemaphoreSlim` é um semáforo de contagem, não um mutex, mas ele se torna um mutex quando você o constrói com uma contagem de um. O que o distingue dos outros três é o `WaitAsync`: é o único primitivo aqui que você pode manter de forma válida através de um `await`.

## A matriz de decisão

Cada linha desta tabela corresponde ao comportamento do .NET 9+ / C# 13+ salvo indicação em contrário.

| Capacidade                              | `lock (object)`        | `Monitor`              | `SemaphoreSlim`             | `System.Threading.Lock`   |
| --------------------------------------- | ---------------------- | ---------------------- | --------------------------- | ------------------------- |
| Exclusão mútua (um único detentor)      | sim                    | sim                    | sim, com `new(1, 1)`        | sim                       |
| Limitar a N > 1 detentores concorrentes | não                    | não                    | sim, `new(N, N)`            | não                       |
| Válido usar `await` dentro da região    | não (CS1996)           | não (CS1996)           | sim, via `WaitAsync`        | não (CS1996)              |
| Variáveis de condição (`Wait`/`Pulse`)  | não                    | sim                    | não                         | não                       |
| Reentrante na mesma thread              | sim                    | sim                    | não (deadlock)              | sim                       |
| Impõe identidade de thread / detentor   | sim                    | sim                    | não                         | sim                       |
| Reduz para                              | `Monitor.Enter`/`Exit` | (ele mesmo)            | `Wait`/`Release`            | `Lock.EnterScope()`       |
| Inflação do sync block sob contenção    | sim                    | sim                    | não                         | não                       |
| Tentativa de aquisição com timeout      | `Monitor.TryEnter`     | `TryEnter(TimeSpan)`   | `Wait(TimeSpan)`            | `TryEnter(TimeSpan)`      |
| Aquisição cancelável                    | não                    | não                    | sim (`CancellationToken`)   | não                       |
| Entre processos                         | não                    | não                    | não (use `Semaphore`)       | não                       |
| `IDisposable`                           | não                    | não                    | sim                         | não                       |
| Primeira versão                         | C# 1.0                 | .NET 1.1               | .NET Framework 4.0          | .NET 9                    |

Duas linhas decidem quase todos os casos reais: "válido usar `await` dentro" e "variáveis de condição". Se você precisa da primeira, está em `SemaphoreSlim`. Se você precisa da segunda, está em `Monitor`. Todo o resto aponta para `System.Threading.Lock`.

## Quando escolher System.Threading.Lock

Esta é a opção padrão para código síncrono novo no .NET 9+.

- Você está protegendo uma seção crítica curta e limitada por CPU: a atualização de um cache em memória, um contador, uma mutação de `Dictionary`, um campo de inicialização tardia. O corpo não aguarda (`await`) nada. Isso representa 90% do bloqueio em um serviço típico.
- Você está migrando um bloqueio `lock (object)` existente e o corpo é síncrono. A mudança é de uma linha: `private readonly object _gate = new();` vira `private readonly Lock _gate = new();`. Cada instrução `lock (_gate) { ... }` permanece byte a byte igual, e o compilador a reassocia de `Monitor.Enter` para `Lock.EnterScope()`.
- Você quer uma pegada menor. Um `Lock` nunca infla um sync block a nível de processo sob contenção, então um serviço que mantém milhares de bloqueios (um por entrada de cache, por exemplo) não faz a tabela de sync blocks crescer como o `Monitor` faz.

```csharp
// .NET 11, C# 14 -- the default gate for synchronous critical sections
public sealed class Counter
{
    private readonly Lock _gate = new();
    private long _value;

    public void Increment()
    {
        lock (_gate) // lowers to using (_gate.EnterScope())
        {
            _value++;
        }
    }

    public long Read()
    {
        lock (_gate)
        {
            return _value;
        }
    }
}
```

Se você ainda não pode ir para o .NET 9, o recurso alternativo é o clássico `lock (object)`. Tem a mesma semântica, um pouco mais pesada. Não recorra ao `Monitor` explicitamente só para bloquear; a palavra-chave `lock` já envolve `Monitor.Enter` / `Exit` no `try` / `finally` correto, de modo que o bloqueio é liberado mesmo se o corpo lançar uma exceção. Um `Monitor.Enter` escrito à mão sem um `finally` é uma fonte clássica de bloqueios órfãos.

## Quando escolher SemaphoreSlim

`SemaphoreSlim` é a resposta a exatamente uma pergunta que os primitivos síncronos não conseguem responder: como serializo uma seção que contém um `await`?

- A seção crítica atravessa um `await`. Você está chamando uma API assíncrona (uma requisição de `HttpClient`, uma consulta de EF Core, uma escrita de arquivo) e precisa de apenas um chamador dentro da região por vez. `lock`, `Monitor` e `Lock` todos proíbem `await` na região mantida. `SemaphoreSlim` não.
- Você quer limitar a concorrência a N maior que um. Um limitador que permite três chamadas de saída concorrentes é `new SemaphoreSlim(3, 3)`. Nenhum mutex consegue expressar isso.
- Você precisa de uma aquisição cancelável ou com tempo limite em um caminho assíncrono. `WaitAsync(CancellationToken)` e `WaitAsync(TimeSpan)` se integram com o resto da sua história de cancelamento.

```csharp
// .NET 11, C# 14 -- async-safe mutual exclusion across an await
public sealed class AsyncCache : IDisposable
{
    private readonly SemaphoreSlim _gate = new(1, 1); // count 1 == mutex
    private readonly Dictionary<string, byte[]> _store = new();

    public async Task<byte[]> GetOrAddAsync(string key, Func<string, Task<byte[]>> factory)
    {
        await _gate.WaitAsync();
        try
        {
            if (_store.TryGetValue(key, out var existing))
                return existing;

            var fresh = await factory(key); // legal: we are holding a semaphore, not a lock
            _store[key] = fresh;
            return fresh;
        }
        finally
        {
            _gate.Release(); // ALWAYS in finally
        }
    }

    public void Dispose() => _gate.Dispose();
}
```

Três armadilhas vêm com o `SemaphoreSlim`, e todas as três remontam à mesma raiz: ele não rastreia quem o mantém. Conforme a [documentação do SemaphoreSlim](https://learn.microsoft.com/dotnet/api/system.threading.semaphoreslim), a classe "não impõe identidade de thread ou tarefa nas chamadas aos métodos Wait, WaitAsync e Release".

1. **Sem reentrância.** Se um método que mantém o semáforo chama outro método que também aguarda no mesmo semáforo, você cai em deadlock. `Monitor` e `Lock` permitiriam à mesma thread reentrar; `SemaphoreSlim` não consegue, porque não tem o conceito de uma thread detentora para comparar.
2. **Release não é protegido.** Nada impede você de chamar `Release` mais vezes do que chamou `Wait`, o que silenciosamente empurra `CurrentCount` acima da contagem inicial e quebra a invariante. Sempre emparelhe `Wait` / `WaitAsync` com `Release` em um `finally`.
3. **É `IDisposable`.** Diferentemente dos outros três, um `SemaphoreSlim` possui um `WaitHandle` alocado de forma tardia e precisa ser descartado. Um semáforo a nível de campo significa que sua classe agora também é `IDisposable`.

A sobrecarga por aquisição é maior do que a de um `Lock`. Esse é o preço do suporte assíncrono. Não use `SemaphoreSlim` para um caminho rápido puramente síncrono só porque já tem um em escopo.

## Quando escolher Monitor explicitamente

Quase nunca, com uma exceção real: você precisa de uma variável de condição.

`Monitor.Wait`, `Monitor.Pulse` e `Monitor.PulseAll` permitem que uma thread libere o bloqueio, durma até que outra thread sinalize uma mudança de estado e readquira ao acordar. Este é o primitivo clássico de coordenação de buffer limitado / produtor-consumidor. Nenhum outro tipo nesta comparação o expõe. `System.Threading.Lock` o descartou deliberadamente; `SemaphoreSlim` nunca o teve.

```csharp
// .NET 11, C# 14 -- the one job only Monitor can do: condition variables
public sealed class BoundedBuffer<T>
{
    private readonly object _gate = new();
    private readonly Queue<T> _items = new();
    private readonly int _capacity;

    public BoundedBuffer(int capacity) => _capacity = capacity;

    public void Add(T item)
    {
        lock (_gate)
        {
            while (_items.Count == _capacity)
                Monitor.Wait(_gate);     // release + sleep until pulsed

            _items.Enqueue(item);
            Monitor.PulseAll(_gate);     // wake any waiting consumers
        }
    }

    public T Take()
    {
        lock (_gate)
        {
            while (_items.Count == 0)
                Monitor.Wait(_gate);

            var item = _items.Dequeue();
            Monitor.PulseAll(_gate);
            return item;
        }
    }
}
```

Note que o bloqueio aqui é um `object` simples, não um `Lock`: `Monitor.Wait`/`Pulse` operam sobre o sync block de um objeto e não estão disponíveis em `System.Threading.Lock`. Esse é o trade-off. Se você se pegar escrevendo esse padrão do zero em 2026, pare e verifique se um [`Channel<T>` substituiria a coisa toda](/pt-br/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/). `System.Threading.Channels` te dá uma fila produtor/consumidor limitada e amigável a assíncrono, com backpressure embutida, e você nunca mais toca em `Monitor.Wait`. O buffer limitado feito à mão hoje é, em sua maioria, de interesse histórico e educacional.

O outro lugar onde você poderia chamar `Monitor` diretamente é `Monitor.TryEnter` para uma tentativa não bloqueante, mas `System.Threading.Lock` também tem `TryEnter`, então no .NET 9+ esse motivo evapora.

## O benchmark: o que o Lock realmente economiza em relação ao Monitor

A afirmação de desempenho é especificamente que `System.Threading.Lock` é mais rápido do que o `lock (object)` apoiado em `Monitor` tanto para o caminho rápido sem contenção quanto para o caminho com contenção. O artigo de Stephen Toub [Performance Improvements in .NET 9](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-9/#system-threading) mede isso com o BenchmarkDotNet. A aquisição sem contenção se reduz a uma única troca-comparação interbloqueada mais uma barreira; a aquisição com contenção é aproximadamente 2-3x mais rápida do que o caminho de `Monitor.Enter` porque o `Monitor` executa várias ramificações condicionais antes de sua barreira.

O que os números sintéticos não te contam é o quão pouco isso importa em um serviço real, porque serviços reais passam quase nada do seu tempo de relógio dentro de `lock`. Os ganhos mensuráveis em produção são estruturais, não de throughput:

- **Working set.** Cada bloqueio passa de "um `object` mais um sync block sob contenção" para "um `Lock`, aproximadamente do tamanho de um objeto mais alguns bytes de estado". Com milhares de bloqueios, a tabela de sync blocks para de crescer sob carga.
- **Travessia do GC.** O `Lock` continua sendo um tipo de referência que o GC rastreia, mas ele nunca infla uma tabela separada a nível de processo que o GC tenha que percorrer.

O que *não* muda entre `Monitor` e `Lock`: o throughput da seção protegida em si, a justiça (ambos são injustos com uma leve anti-inanição) e o comportamento de recursão (ambos são reentrantes na mesma thread).

`SemaphoreSlim` está em uma classe completamente diferente e a comparação não é de igual para igual: um `WaitAsync` que completa de forma síncrona ainda é notavelmente mais caro do que um `Lock.EnterScope`, e um que completa de forma assíncrona aloca memória e faz um ida-e-volta pelo pool de threads. Você não escolhe `SemaphoreSlim` por velocidade. Você o escolhe porque é a única opção correta através de um `await`, e a correção vence a contagem de ciclos toda vez.

## A armadilha que decide por você

Três restrições anulam completamente a preferência:

**Um `await` na seção crítica obriga a usar `SemaphoreSlim`.** Isso não é uma escolha de estilo. `lock`, `Monitor` e `Lock` rastreiam a propriedade por thread gerenciada, e um `await` pode retomar em uma thread diferente, o que liberaria o bloqueio do detentor errado. O compilador C# recusa `await` dentro de `lock` com [CS1996](https://learn.microsoft.com/dotnet/csharp/misc/cs1996). A variante traiçoeira é `using (_gate.EnterScope())` em volta de um `await`: isso pode compilar, mas lança `SynchronizationLockException` em tempo de execução quando a continuação tenta descartar o scope em uma thread que nunca entrou. Se o corpo aguarda, você está em `SemaphoreSlim`. Ponto final. Este é o mesmo raciocínio por trás de [por que async void e async Task se comportam de forma tão diferente](/pt-br/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) por baixo dos panos.

**Variáveis de condição obrigam a usar `Monitor`.** Se sua coordenação realmente precisa da semântica de "dormir até ser sinalizado" e um `Channel<T>` não encaixa, somente `Monitor.Wait` / `Pulse` farão isso.

**Um alvo anterior ao .NET 9 descarta o `Lock`.** Se sua biblioteca tem múltiplos alvos incluindo `netstandard2.0`, `System.Threading.Lock` não existe naquele lado. Proteja-o com `#if NET9_0_OR_GREATER` e mantenha um bloqueio `object` no caminho de versão inferior. Não faça forward do tipo `Lock` a partir de um polyfill; a semântica vai divergir do tipo real.

## A recomendação, reformulada

Use `System.Threading.Lock` por padrão para exclusão mútua síncrona no .NET 9+, e escreva-o por meio da palavra-chave `lock` para que o compilador gerencie o `try` / `finally` por você. Desça para um bloqueio `object` simples apenas quando precisar ter como alvo um runtime anterior ao .NET 9, onde `lock (object)` te dá semântica idêntica a um custo um pouco maior. Mude para `SemaphoreSlim(1, 1)` no momento em que a região protegida contiver um `await`, e use `SemaphoreSlim(N, N)` quando quiser limitar a concorrência acima de um. Toque no `Monitor` diretamente apenas para variáveis de condição `Wait` / `Pulse`, e antes pergunte-se se um `Channel<T>` faz toda a coordenação feita à mão desaparecer. A decisão correta mais curta: síncrono e curto significa `Lock`; assíncrono significa `SemaphoreSlim`; sinalização significa `Monitor`.

## Relacionados

- [Como usar o novo tipo System.Threading.Lock no .NET 11](/pt-br/2026/04/how-to-use-the-new-system-threading-lock-type-in-dotnet-11/) é a análise aprofundada sobre migrar para e usar o novo tipo.
- [.NET 9: O fim do lock(object)](/pt-br/2026/01/net-9-the-end-of-lockobject/) é a introdução original em formato de notícia ao `System.Threading.Lock`.
- [Como usar Channels em vez de BlockingCollection em C#](/pt-br/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) mostra o padrão produtor/consumidor que substitui a coordenação `Monitor.Wait` feita à mão.
- [async void vs async Task em C#: quando cada um é correto](/pt-br/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) explica o comportamento de retomada de threads por trás da regra de não usar await em um lock.
- [Como cancelar uma Task de longa duração em C# sem deadlocks](/pt-br/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) faz par com as sobrecargas canceláveis de `WaitAsync`.

## Links de fontes

- [Referência da API de `System.Threading.Lock`](https://learn.microsoft.com/dotnet/api/system.threading.lock) no Microsoft Learn.
- [Referência da classe `SemaphoreSlim`](https://learn.microsoft.com/dotnet/api/system.threading.semaphoreslim) no Microsoft Learn, incluindo a nota sobre identidade de thread.
- [Referência da classe `Monitor`](https://learn.microsoft.com/dotnet/api/system.threading.monitor), cobrindo `Wait`, `Pulse` e `PulseAll`.
- [Performance Improvements in .NET 9](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-9/#system-threading) de Stephen Toub, com os microbenchmarks de `Lock` vs `Monitor`.
- [dotnet/runtime#34812](https://github.com/dotnet/runtime/issues/34812), a proposta que introduziu o `System.Threading.Lock`.
