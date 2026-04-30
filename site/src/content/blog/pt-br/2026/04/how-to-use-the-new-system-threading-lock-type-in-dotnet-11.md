---
title: "Como usar o novo tipo System.Threading.Lock no .NET 11"
description: "System.Threading.Lock chegou no .NET 9 e é a primitiva de sincronização padrão no .NET 11 e C# 14. Este guia mostra como migrar de lock(object), como o EnterScope funciona e os problemas em torno de await, dynamic e targets antigos."
pubDate: 2026-04-30
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "concurrency"
template: "how-to"
lang: "pt-br"
translationOf: "2026/04/how-to-use-the-new-system-threading-lock-type-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-04-30
---

A resposta curta: troque `private readonly object _gate = new();` por `private readonly Lock _gate = new();`, deixe cada `lock (_gate) { ... }` exatamente como está e deixe o compilador do C# 14 ligar a palavra-chave `lock` a `Lock.EnterScope()` em vez de `Monitor.Enter`. No .NET 11 o resultado é um objeto menor, sem inflação de sync block, e um ganho mensurável de throughput em fast paths com contenção. Os únicos lugares em que você precisa pensar mais são quando um bloco precisa de `await`, quando o campo é exposto via `dynamic`, quando você tem um `using static` para `System.Threading` e quando o mesmo código precisa compilar contra `netstandard2.0`.

Este guia tem como alvo o .NET 11 (preview 4) e o C# 14. O `System.Threading.Lock` em si é um tipo do .NET 9, então tudo aqui funciona no .NET 9, .NET 10 e .NET 11. O reconhecimento de padrão a nível de compilador que faz `lock` ligar a `Lock.EnterScope()` chegou com o C# 13 no .NET 9 e não muda no C# 14.

## Por que `lock(object)` sempre foi um paliativo

Por dezenove anos, o padrão canônico em C# para "torne esta seção segura entre threads" foi um campo `object` privado mais uma instrução `lock`. O compilador traduzia isso em chamadas para [`Monitor.Enter`](https://learn.microsoft.com/dotnet/api/system.threading.monitor.enter) e `Monitor.Exit` contra a identidade do objeto. O mecanismo funcionava, mas tinha três custos estruturais.

Primeiro, cada região travada paga por uma palavra de cabeçalho de objeto. Tipos por referência no heap gerenciado do CLR carregam um `ObjHeader` mais um `MethodTable*`, totalizando 16 bytes em x64 só para existir. O `object` que você aloca para travar não tem outro propósito além de identidade. Não contribui para seu modelo de domínio e o GC ainda precisa rastreá-lo.

Segundo, no momento em que dois threads disputam o lock, o runtime infla o cabeçalho em um [SyncBlock](https://github.com/dotnet/runtime/blob/main/docs/design/coreclr/botr/sync-block-table.md). A tabela SyncBlock é uma tabela de processo com entradas `SyncBlock`, cada uma alocada sob demanda e nunca liberada até o processo terminar. Um serviço de longa duração que trava em milhões de objetos distintos termina com uma tabela SyncBlock que cresce monotonicamente. Era raro mas real, e só era diagnosticável com `dotnet-dump` e `!syncblk`.

Terceiro, `Monitor.Enter` é recursivo (a mesma thread pode entrar duas vezes e só libera quando os contadores de saída coincidem) e suporta `Monitor.Wait` / `Pulse` / `PulseAll`. A maior parte do código não precisa de nada disso. Precisa de exclusão mútua. Você estava pagando por funcionalidades que nunca usava.

`System.Threading.Lock` é o tipo que a Microsoft teria entregue em 2002 se o `Monitor` também não estivesse fazendo papel de implementação por trás do `lock`. A proposta que o introduziu ([dotnet/runtime#34812](https://github.com/dotnet/runtime/issues/34812), aceita em 2024) o descreve como "um lock mais rápido com pegada menor e semântica mais clara". É um tipo por referência selado que expõe apenas o que exclusão mútua precisa: entrar, tentar entrar, sair e checar se a thread atual segura o lock. Sem `Wait`. Sem `Pulse`. Sem mágica de cabeçalho de objeto.

## A migração mecânica

Pegue um cache legado típico:

```csharp
// .NET Framework 4.x / .NET 8, C# 12 -- the old shape
public class LegacyCache
{
    private readonly object _gate = new();
    private readonly Dictionary<string, byte[]> _store = new();

    public byte[]? Get(string key)
    {
        lock (_gate)
        {
            return _store.TryGetValue(key, out var v) ? v : null;
        }
    }

    public void Set(string key, byte[] value)
    {
        lock (_gate)
        {
            _store[key] = value;
        }
    }
}
```

Migre para .NET 11 mudando exatamente uma linha:

```csharp
// .NET 11, C# 14 -- the new shape, single-line diff
public class ModernCache
{
    private readonly Lock _gate = new();
    private readonly Dictionary<string, byte[]> _store = new();

    public byte[]? Get(string key)
    {
        lock (_gate)
        {
            return _store.TryGetValue(key, out var v) ? v : null;
        }
    }

    public void Set(string key, byte[] value)
    {
        lock (_gate)
        {
            _store[key] = value;
        }
    }
}
```

O corpo de cada `lock` permanece idêntico. O compilador vê que `_gate` é um `Lock` e reduz `lock (_gate) { body }` para:

```csharp
// What the compiler emits, simplified
using (_gate.EnterScope())
{
    // body
}
```

`EnterScope()` retorna um struct `Lock.Scope` cujo `Dispose()` libera o lock. Como `Scope` é um `ref struct`, ele não pode ser boxado, capturado por um iterador, capturado por um método async ou armazenado em um campo. Essa última restrição é o que torna o novo lock barato: sem alocação, sem despacho virtual, apenas um handle local na pilha.

Se você inverter a ordem (`Lock _gate` mas alguma ferramenta em outro lugar faz `Monitor.Enter(_gate)`), o compilador C# emite CS9216 a partir do C# 13: "A value of type `System.Threading.Lock` converted to a different type will use likely unintended monitor-based locking in `lock` statement". A conversão é permitida (um `Lock` ainda é um `object`), mas o compilador avisa porque você acabou de jogar fora todos os benefícios do novo tipo.

## O que `EnterScope` realmente devolve

Você pode usar o novo tipo sem a palavra-chave `lock` se precisar:

```csharp
// .NET 11, C# 14
public byte[] GetOrCompute(string key, Func<string, byte[]> factory)
{
    using (_gate.EnterScope())
    {
        if (_store.TryGetValue(key, out var existing))
            return existing;

        var fresh = factory(key);
        _store[key] = fresh;
        return fresh;
    }
}
```

`EnterScope()` bloqueia até o lock ser adquirido. Há também `TryEnter()` (devolve `bool`, sem `Scope`) e `TryEnter(TimeSpan)` para aquisição com tempo limite. Se você chamar `TryEnter` e ele devolver `true`, precisa chamar `Exit()` você mesmo, exatamente uma vez, na mesma thread. Pular o `Exit` significa lock vazado; o próximo a tentar adquiri-lo bloqueia para sempre.

```csharp
// .NET 11, C# 14 -- TryEnter idiom for non-blocking back-pressure
if (_gate.TryEnter())
{
    try
    {
        DoWork();
    }
    finally
    {
        _gate.Exit();
    }
}
else
{
    // back off, reschedule, drop the message, etc.
}
```

`Lock.IsHeldByCurrentThread` é uma propriedade `bool` que devolve `true` apenas quando a thread chamadora segura o lock no momento. É feita para chamadas `Debug.Assert` em invariantes; não use como mecanismo de controle de fluxo. É `O(1)` mas tem semântica acquire-release, então chamá-la em um hot loop vai custar caro.

## A armadilha do await, agora pior

Você nunca pôde fazer `await` dentro de um `lock` baseado em `Monitor`. O compilador recusava direto com [CS1996](https://learn.microsoft.com/dotnet/csharp/misc/cs1996): "Cannot await in the body of a lock statement". A razão é que o `Monitor` rastreia a posse pelo id da thread gerenciada, então retomar um `await` em outra thread liberaria o lock pelo dono errado.

`Lock` tem a mesma restrição, e o compilador a aplica do mesmo jeito. Tente isto:

```csharp
// .NET 11, C# 14 -- DOES NOT COMPILE
public async Task DoIt()
{
    lock (_gate)
    {
        await Task.Delay(100); // CS1996
    }
}
```

Sai `CS1996` de novo. Bom. A armadilha maior é o `using (_gate.EnterScope())` porque o compilador não sabe que o `Scope` veio de um `Lock`. No .NET 11 SDK 11.0.100-preview.4, este código compila:

```csharp
// .NET 11, C# 14 -- COMPILES, but is broken at runtime
public async Task Broken()
{
    using (_gate.EnterScope())
    {
        await Task.Delay(100);
        // Resumes on a thread-pool thread, which does NOT hold _gate.
        // Disposing the Scope here calls Lock.Exit on a thread that
        // never entered, throwing SynchronizationLockException.
    }
}
```

A correção é a mesma de sempre: suba o lock para envolver apenas a seção crítica síncrona, e use `SemaphoreSlim` (que é async-aware) quando você realmente precisar de exclusão mútua atravessando um `await`. `Lock` é uma primitiva síncrona rápida. Ela não é, e não tenta ser, um lock async.

## Performance: o que mudou de fato

As notas de release do .NET 9 afirmam que a aquisição com contenção é cerca de 2-3x mais rápida que o caminho equivalente do `Monitor.Enter`, e que a aquisição sem contenção é dominada por um único compare-exchange interlocked. O post [Performance Improvements in .NET 9](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-9/#system-threading) do Stephen Toub inclui microbenchmarks que mostram exatamente isso, e eles se reproduzem no .NET 11.

A economia que você consegue medir no seu próprio serviço é menor do que os números sintéticos sugerem, porque serviços reais raramente passam a maior parte do tempo dentro de um `lock`. Os lugares em que você verá diferença:

- **Working set**: cada gate vai de "um `object` mais seu sync block sob contenção" para "um `Lock`, que tem aproximadamente o tamanho de um `object` mais 8 bytes de estado". Se você tem milhares de gates (um por entrada de cache, por exemplo), a tabela de sync block deixa de crescer sob contenção.
- **Travessia do GC2**: o `Lock` continua sendo um tipo por referência, mas nunca infla uma tabela externa que o GC precise percorrer separadamente.
- **Fast path com contenção**: o novo fast path é um único `CMPXCHG` mais uma barreira de memória. O caminho antigo passava pelo `Monitor`, que executa vários branches condicionais antes da barreira.

O que não muda: o throughput da própria seção protegida, fairness (o novo `Lock` também é injusto, com uma camada pequena de prevenção de starvation) e recursão (`Lock` é recursivo na mesma thread, idêntico ao `Monitor`).

## Armadilhas que vão te morder

**`using static System.Threading;`** -- se algum arquivo no seu projeto faz isso, o nome `Lock` sem qualificador fica ambíguo com qualquer classe `Lock` que você tenha escrito. A correção é remover o `using static` ou qualificar o tipo explicitamente: `System.Threading.Lock`. O compilador avisa com [CS0104](https://learn.microsoft.com/dotnet/csharp/misc/cs0104) mas o local do erro é onde você usou `Lock`, não onde o conflito foi introduzido.

**`dynamic`** -- uma instrução `lock` sobre uma expressão `dynamic` não consegue resolver para `Lock.EnterScope()` porque o binding acontece em runtime. O compilador emite CS9216 e cai para `Monitor`. Se você tem uma daquelas raras codebases com `dynamic`, faça cast para `Lock` antes do `lock`:

```csharp
// .NET 11, C# 14
dynamic d = GetGate();
lock ((Lock)d) { /* ... */ } // cast is required
```

**Boxing para `object`** -- como `Lock` deriva de `object`, você pode passá-lo para qualquer API que aceita `object`, incluindo `Monitor.Enter`. Isso anula o caminho novo. CS9216 é seu amigo; transforme em erro no `Directory.Build.props`:

```xml
<PropertyGroup>
  <WarningsAsErrors>$(WarningsAsErrors);CS9216</WarningsAsErrors>
</PropertyGroup>
```

**Bibliotecas `netstandard2.0`** -- se sua biblioteca multi-targeta `netstandard2.0` e `net11.0`, o `Lock` não existe no lado `netstandard2.0`. Você tem duas opções. A limpa é manter um campo `object` no `netstandard2.0` e um campo `Lock` no `net11.0`, protegidos por `#if NET9_0_OR_GREATER`:

```csharp
// .NET 11, C# 14 -- multi-target gate
#if NET9_0_OR_GREATER
private readonly System.Threading.Lock _gate = new();
#else
private readonly object _gate = new();
#endif
```

A suja é fazer type-forwarding do `Lock` a partir de um pacote polyfill; não faça isso, termina mal quando o polyfill diverge da semântica do tipo real.

**`Dispatcher` do WPF e WinForms** -- a fila interna do dispatcher continua usando `Monitor`. Você não pode substituir o lock dele. Os locks da sua aplicação podem mudar; os do framework não.

**Source generators que emitem `lock(object)`** -- regere. CommunityToolkit.Mvvm 9 e vários outros migraram para `Lock` no fim de 2024. Verifique o arquivo gerado procurando `private readonly object`; se ainda estiver lá, atualize o pacote.

## Quando não usar `Lock`

Não use `Lock` (nem qualquer mutex de curta duração) quando a resposta é "nenhum lock". `ConcurrentDictionary<TKey, TValue>` não precisa de gate externo. `ImmutableArray.Builder` também não. `Channel<T>` também não. A sincronização mais rápida é a que você não escreve.

Não use `Lock` quando a seção protegida cruza um `await`. Use `SemaphoreSlim(1, 1)` e `await semaphore.WaitAsync()`. O overhead por aquisição é maior, mas é a única opção correta.

Não use `Lock` para coordenação entre processos ou entre máquinas. É só intra-processo. Use [`Mutex`](https://learn.microsoft.com/dotnet/api/system.threading.mutex) (nomeado, com suporte do kernel), um row lock de banco de dados ou um `SETNX` do Redis para isso.

## Relacionado

- [Como usar Channels em vez de BlockingCollection em C#](/pt-br/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) cobre o padrão produtor/consumidor que muitas vezes substitui locks por completo.
- [Como cancelar uma Task de longa duração em C# sem deadlock](/pt-br/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) é o complemento de cancelamento deste post.
- [.NET 9: o fim do lock(object)](/2026/01/net-9-the-end-of-lockobject/) é a introdução em estilo de notícia ao tipo, escrita quando o .NET 9 foi lançado.
- [Como escrever um source generator para INotifyPropertyChanged](/pt-br/2026/04/how-to-write-a-source-generator-for-inotifypropertychanged/) mostra o tipo de generator que você pode precisar atualizar para suportar `Lock`.

## Fontes

- [Referência da API `System.Threading.Lock`](https://learn.microsoft.com/dotnet/api/system.threading.lock) no Microsoft Learn.
- [dotnet/runtime#34812](https://github.com/dotnet/runtime/issues/34812) -- a proposta e a discussão de design.
- [Performance Improvements in .NET 9](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-9/#system-threading) por Stephen Toub.
- [Novidades em C# 13](https://learn.microsoft.com/dotnet/csharp/whats-new/csharp-13) cobre o reconhecimento de padrão a nível de compilador.
