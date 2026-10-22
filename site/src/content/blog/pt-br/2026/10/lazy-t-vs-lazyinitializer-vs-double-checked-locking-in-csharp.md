---
title: "Lazy<T> vs LazyInitializer.EnsureInitialized vs double-checked locking em C#"
description: "Use Lazy<T> por padrão: ele executa a factory uma única vez, armazena exceções em cache e suas leituras são baratas demais para medir após a inicialização. Use LazyInitializer.EnsureInitialized quando você preenche de forma preguiçosa muitos campos ou posições de um array e não pode pagar um objeto extra por valor. Double-checked locking escrito à mão quase nunca compensa no .NET 10."
pubDate: 2026-10-22
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "concurrency"
  - "performance"
lang: "pt-br"
translationOf: "2026/10/lazy-t-vs-lazyinitializer-vs-double-checked-locking-in-csharp"
translatedBy: "claude"
translationDate: 2026-10-22
---

Use `Lazy<T>` por padrão. Com o modo padrão do construtor (`ExecutionAndPublication`), ele garante que a factory execute exatamente uma vez mesmo sob contenção, armazena em cache a exceção da factory e, depois que o valor existe, uma leitura é uma checagem de null mais um load de campo, barata demais para o BenchmarkDotNet medir. Recorra a `LazyInitializer.EnsureInitialized` quando você tem muitos valores criados de forma preguiçosa (um campo por propriedade em um tipo muito usado, ou posições de um array) e o objeto `Lazy<T>` extra por valor é o custo que você quer evitar. Double-checked locking escrito à mão não dá nada que `LazyInitializer.EnsureInitialized(ref field, ref syncLock, factory)` já não dê, então escreva-o apenas quando precisar de um comportamento que nenhuma das duas APIs oferece.

Tudo abaixo foi medido no .NET 10.0.10 (SDK 10.0.302), C# 14, BenchmarkDotNet 0.15.8, em um Apple M4 (arm64). As APIs em si não mudaram de forma desde o .NET Core 3.0, então o conselho vale para .NET 8, 9, 10 e 11.

## A comparação em resumo

| | `Lazy<T>` (padrão) | `LazyInitializer.EnsureInitialized(ref t, f)` | `EnsureInitialized(ref t, ref sync, f)` | Double-checked locking |
| --- | --- | --- | --- | --- |
| A factory executa no máximo uma vez sob contenção | Sim | Não, toda thread concorrente pode executá-la | Sim | Sim, se escrito corretamente |
| Exceção da factory | Em cache, relançada para sempre | Não fica em cache, a próxima chamada tenta de novo | Não fica em cache, a próxima chamada tenta de novo | O que você escrever |
| Alocação extra por valor preguiçoso | Objeto `Lazy<T>` mais um helper de lock | Nenhuma | Um objeto de lock, apenas se houver contenção ou na primeira chamada | Um objeto de lock (ou compartilhado) |
| Leitura quente após a init (medido) | abaixo de 1 ns, impossível de medir | abaixo de 1 ns | abaixo de 1 ns | abaixo de 1 ns |
| Criação + init única (medido) | 13,96 ns, 96 B | 6,19 ns, 48 B | 14,03 ns, 80 B | 8,96 ns, 72 B |
| Funciona com tipos de valor | Sim | Não (`where T : class`) | Não, use a sobrecarga com `ref bool initialized` | Sim, com um flag separado |
| A factory pode retornar `null` | Sim | Não, lança `InvalidOperationException` | Não, lança `InvalidOperationException` | Sim, com um flag separado |
| Reentrância a partir da factory | Lança `InvalidOperationException` | Stack overflow | Stack overflow (`Monitor` é reentrante) | Depende do tipo de lock |
| Linhas de código sob sua responsabilidade | 1 | 1 | 2 campos + 1 chamada | ~10 |

## O que cada opção realmente faz

### `Lazy<T>`

`Lazy<T>` envolve uma factory e um slot. Sua propriedade `Value` no .NET 10 tem uma linha:

```csharp
// System.Private.CoreLib, release/10.0, src/System/Lazy.cs
public T Value => _state == null ? _value! : CreateValue();
```

`_state` é uma referência `LazyHelper` volatile que descreve o modo e, para `ExecutionAndPublication`, serve também como objeto de lock. A primeira chamada entra em `CreateValue`, que faz `lock (executionAndPublication)`, checa de novo, executa sua factory, armazena `_value` e então define `_state = null` com uma escrita volatile. Toda chamada posterior vê `_state == null` e retorna o campo. Isso é double-checked locking, escrito uma vez, por pessoas que leram a especificação do modelo de memória com mais cuidado do que a maioria de nós.

O modo de thread safety é escolhido pelo construtor:

```csharp
// .NET 10, C# 14
var a = new Lazy<Config>(LoadConfig);                                          // ExecutionAndPublication
var b = new Lazy<Config>(LoadConfig, isThreadSafe: true);                      // ExecutionAndPublication
var c = new Lazy<Config>(LoadConfig, LazyThreadSafetyMode.PublicationOnly);    // threads race, first publish wins
var d = new Lazy<Config>(LoadConfig, LazyThreadSafetyMode.None);               // single-threaded only
```

### `LazyInitializer.EnsureInitialized`

`LazyInitializer` é uma classe estática que opera sobre um campo seu, por meio de um `ref`. Não há objeto wrapper. A sobrecarga de dois argumentos é, por inteiro:

```csharp
// System.Private.CoreLib, release/10.0, src/System/Threading/LazyInitializer.cs
public static T EnsureInitialized<T>(ref T? target, Func<T> valueFactory) where T : class =>
    Volatile.Read(ref target!) ?? EnsureInitializedCore(ref target, valueFactory);

private static T EnsureInitializedCore<T>(ref T? target, Func<T> valueFactory) where T : class
{
    T value = valueFactory() ?? throw new InvalidOperationException(SR.Lazy_StaticInit_InvalidOperation);
    Interlocked.CompareExchange(ref target, value, null!);
    return target;
}
```

Sem lock. Toda thread que vê `null` executa a factory, e `CompareExchange` decide qual resultado é armazenado. Os objetos dos perdedores são descartados (e a documentação observa que o método "will not dispose of the objects that were not stored"). Isso é a semântica de `PublicationOnly` sem o wrapper.

A sobrecarga de três argumentos, `EnsureInitialized(ref target, ref syncLock, valueFactory)`, adiciona um lock. Ela cria de forma preguiçosa um `object` simples em `syncLock` com `CompareExchange` e então faz `lock (syncLock) { if (Volatile.Read(ref target) == null) Volatile.Write(ref target, valueFactory()); }`. Isso é double-checked locking de livro-texto, e executa a factory uma vez.

Para tipos de valor, ou quando `null` é um resultado legítimo, existem sobrecargas com um flag extra `ref bool initialized`. Elas sempre passam pelo caminho com lock.

### Double-checked locking escrito à mão

A versão moderna correta no .NET 9 e posteriores, usando o tipo `System.Threading.Lock`:

```csharp
// .NET 10, C# 14
public sealed class ReportCache
{
    private volatile Report? _report;
    private readonly Lock _lock = new();

    public Report Report
    {
        get
        {
            var r = _report;               // one volatile read on the fast path
            if (r is not null) return r;
            lock (_lock)
            {
                return _report ??= BuildReport();
            }
        }
    }

    private static Report BuildReport() => new();
}

public sealed class Report;
```

O `volatile` faz um trabalho real. A especificação do modelo de memória do .NET (`docs/design/specs/Memory-model.md` em dotnet/runtime) diz que armazenar uma referência de objeto em memória compartilhada é um release e que leituras com dependência de dados através dela são ordenadas, então o clássico bug do "objeto parcialmente construído" não pode acontecer no CoreCLR. Mas ela também avisa explicitamente que os efeitos de ordenação da atribuição de referência não devem ser usados para ordenação em geral, e um campo não volatile permite que o JIT eleve ou mescle leituras de `_report`. Marque-o como `volatile`, ou leia com `Volatile.Read`, e o padrão fica correto em toda arquitetura em que o .NET roda.

## Provando o comportamento sob contenção

A documentação diz "may run more than once". Eu queria um número. Este probe inicia 16 threads em um `Barrier`, faz todas acessarem o valor lazy ao mesmo tempo, usa uma factory que gira por cerca de 20.000 iterações para ampliar a janela da corrida e repete 200 vezes, registrando a pior rodada:

```csharp
// .NET 10.0.10, C# 14, Apple M4, 10 cores
static int Race(Func<Func<object>, Func<object>> makeAccessor)
{
    int maxCalls = 0;
    for (int r = 0; r < 200; r++)
    {
        int calls = 0;
        Func<object> factory = () =>
        {
            Interlocked.Increment(ref calls);
            Thread.SpinWait(20_000);
            return new object();
        };
        var access = makeAccessor(factory);
        using var barrier = new Barrier(16);
        var results = new object[16];
        var threads = Enumerable.Range(0, 16)
            .Select(i => new Thread(() => { barrier.SignalAndWait(); results[i] = access(); }))
            .ToArray();
        foreach (var t in threads) t.Start();
        foreach (var t in threads) t.Join();
        if (results.Distinct().Count() != 1) throw new Exception("different instances returned");
        maxCalls = Math.Max(maxCalls, calls);
    }
    return maxCalls;
}
```

Resultados, pior rodada em 200:

| Opção | Máximo de chamadas à factory em uma rodada |
| --- | --- |
| `Lazy<T>` padrão (`ExecutionAndPublication`) | 1 |
| `Lazy<T>` `PublicationOnly` | 11 |
| `LazyInitializer.EnsureInitialized(ref t, f)` | 12 |
| `LazyInitializer.EnsureInitialized(ref t, ref sync, f)` | 1 |

Toda opção retornou a mesma instância para as 16 threads em todas as rodadas, então nenhuma delas é "insegura". A diferença é trabalho desperdiçado. Se sua factory abre um socket, lê um arquivo de 40 MB ou chama uma API paga, 12 execuções paralelas são um bug real, mesmo que o valor publicado esteja correto.

## A armadilha do cache de exceções

Esta é a diferença de comportamento que machuca em produção. Mesma factory, falha na primeira chamada, tem sucesso na segunda:

```csharp
// .NET 10.0.10, C# 14
int attempts = 0;
Func<string> flaky = () => ++attempts == 1 ? throw new InvalidOperationException("transient") : "ok";

var lazy = new Lazy<string>(flaky);
// lazy.Value -> InvalidOperationException: transient
// lazy.Value -> InvalidOperationException: transient   (factory not called again)

string? field = null;
// LazyInitializer.EnsureInitialized(ref field, flaky) -> InvalidOperationException: transient
// LazyInitializer.EnsureInitialized(ref field, flaky) -> "ok"
```

O probe confirmou: o `Lazy<T>` padrão chamou a factory uma vez e lançou a mesma exceção em todo acesso depois disso. `PublicationOnly` e `LazyInitializer` a chamaram duas vezes e se recuperaram.

A tabela de exceções do MS Learn deixa a regra explícita: todo construtor de `Lazy<T>` que recebe uma `valueFactory` armazena exceções em cache, a menos que o modo seja `PublicationOnly`. O construtor sem parâmetros (que usa `Activator.CreateInstance`) não armazena. Então um `Lazy<HttpClient>` cuja factory lê um valor de configuração ausente na inicialização vai lançar durante toda a vida do processo, mesmo depois que a configuração aparecer. Se a falha puder ser transitória, use `PublicationOnly`, use `LazyInitializer` ou substitua a instância de `Lazy<T>` em um `catch`.

A mesma armadilha é duas vezes mais traiçoeira com `Lazy<Task<T>>`: a factory não lança, ela retorna uma `Task` com falha, e essa task com falha é armazenada em cache como valor bem-sucedido em todos os modos. Se você faz cache de trabalho assíncrono, verifique `IsFaulted` e troque a instância, ou use um cache de verdade.

## O benchmark

Duas perguntas: quanto custa uma leitura depois que o valor existe, e quanto cada opção custa por instância quando você cria o dono e toca o valor uma vez. Metodologia: BenchmarkDotNet 0.15.8, job padrão, `[MemoryDiagnoser]`, .NET 10.0.10 arm64 RyuJIT, Apple M4, macOS. Cada classe holder expõe uma propriedade `Value`; `Expensive` é uma classe minúscula, de modo que a medição é a maquinaria lazy, não a factory. O código completo são as classes `HotPath` e `ColdPath` abaixo.

```csharp
// .NET 10.0.10, C# 14, BenchmarkDotNet 0.15.8
public sealed class LazyHolder
{
    private readonly Lazy<Expensive> _value = new(() => new Expensive());
    public Expensive Value => _value.Value;
}

public sealed class LazyInitHolder
{
    private Expensive? _value;
    public Expensive Value => LazyInitializer.EnsureInitialized(ref _value, static () => new Expensive());
}

public sealed class LazyInitLockHolder
{
    private Expensive? _value;
    private object? _sync;
    public Expensive Value => LazyInitializer.EnsureInitialized(ref _value, ref _sync, static () => new Expensive());
}

[MemoryDiagnoser]
public class ColdPath
{
    [Benchmark(Baseline = true)] public int Plain() => new PlainHolder().Value.Id;
    [Benchmark] public int Lazy_ExecutionAndPublication() => new LazyHolder().Value.Id;
    [Benchmark] public int LazyInitializer_Factory() => new LazyInitHolder().Value.Id;
    [Benchmark] public int LazyInitializer_SyncLock() => new LazyInitLockHolder().Value.Id;
    [Benchmark] public int DoubleChecked_Lock() => new DoubleCheckedHolder().Value.Id;
    [Benchmark] public int Lazy_NeverTouched() => new LazyHolder() is null ? 0 : 1;
}
```

Caminho quente (valor já criado, uma leitura):

| Método (.NET 10.0.10, arm64) | Média | Alocado |
| --- | --- | --- |
| Campo simples (`??=`, não thread-safe) | 0,000 ns | 0 B |
| `Lazy<T>` `ExecutionAndPublication` | 0,000 ns | 0 B |
| `Lazy<T>` `PublicationOnly` | 0,000 ns | 0 B |
| `LazyInitializer.EnsureInitialized(ref t, f)` | 0,495 ns | 0 B |
| `LazyInitializer.EnsureInitialized(ref t, ref sync, f)` | 0,289 ns | 0 B |
| Double-checked locking (`volatile` + `Lock`) | 0,314 ns | 0 B |

Caminho frio (aloca o dono, lê o valor uma vez):

| Método (.NET 10.0.10, arm64) | Média | Razão | Alocado |
| --- | --- | --- | --- |
| Campo simples (`??=`, não thread-safe) | 1,53 ns | 1,00 | 24 B |
| `LazyInitializer.EnsureInitialized(ref t, f)` | 6,19 ns | 4,04 | 48 B |
| Double-checked locking (`volatile` + `Lock`) | 8,96 ns | 5,85 | 72 B |
| `Lazy<T>` `PublicationOnly` | 9,68 ns | 6,32 | 64 B |
| `Lazy<T>` `ExecutionAndPublication` | 13,96 ns | 9,12 | 96 B |
| `LazyInitializer.EnsureInitialized(ref t, ref sync, f)` | 14,03 ns | 9,16 | 80 B |
| `Lazy<T>` criado, `Value` nunca lido | 6,17 ns | 4,03 | 72 B |

O caminho quente é um empate. Toda opção fica abaixo da resolução do BenchmarkDotNet depois que o valor existe: o JIT de tier 1 faz inline de `Lazy<T>.Value` até uma checagem de null em `_state` e um load de campo, e o BenchmarkDotNet o reporta como indistinguível de um método vazio. Os números abaixo de um nanossegundo das outras linhas estão dentro do ruído. Se alguém disser para trocar `Lazy<T>` por código feito à mão "por desempenho de leitura", a medição diz que não há nada a ganhar.

O caminho frio é onde as opções diferem, e é principalmente alocação. As linhas de `Lazy<T>` contam a história: um `Lazy<T>` custa 72 bytes antes de qualquer um lê-lo (o próprio objeto `Lazy<T>` mais o `LazyHelper` que `ExecutionAndPublication` aloca no construtor para usar como lock), e cerca de 14 ns para criar e inicializar uma vez. `PublicationOnly` dispensa o helper, então é 8 bytes e 4 ns mais barato. A sobrecarga lock-free de `LazyInitializer` é a opção thread-safe mais barata, com 6,2 ns, porque não aloca nada além do valor. A sobrecarga com `ref syncLock` paga pelo objeto de lock que cria na primeira chamada, então seu custo único fica ao lado do de `Lazy<T>`.

Uma ressalva sobre a coluna `Allocated`: a escape analysis do .NET 10 aloca na stack os objetos holder que comprovadamente não escapam, e é por isso que a baseline simples mostra apenas 24 bytes. Leia a coluna em relação à baseline, não como tamanhos absolutos de objeto.

Em termos absolutos, 8 ns e 48 bytes por valor preguiçoso só importam quando você cria milhões de donos. Um serviço com um campo `Lazy<T>` construído uma única vez na inicialização nunca vai notar.

## Quando escolher `Lazy<T>`

- **Uma dependência quase singleton dentro de uma classe**: uma configuração já parseada, um `Regex` compilado, um cliente construído a partir de opções. Um campo `Lazy<T>`, uma linha, a factory executa uma vez.
- **Factories caras ou com efeitos colaterais**: qualquer coisa que abra uma conexão ou chame uma API. O modo padrão é a única opção sem esforço que garante uma única execução.
- **Tipos de valor ou resultados `null`**: `Lazy<int>` e `Lazy<string?>` simplesmente funcionam. O probe confirmou que `new Lazy<string?>(() => null).Value` retorna `null` com `IsValueCreated == true`.
- **Você quer um erro claro em caso de recursão**: uma factory que toca seu próprio `Value` recebe `InvalidOperationException: ValueFactory attempted to access the Value property of this instance.` em vez de um stack overflow.

## Quando escolher `LazyInitializer.EnsureInitialized`

- **Muitos campos preguiçosos em um tipo com muitas instâncias**: o wrapper `Lazy<T>` é um objeto por valor, e é criado mesmo que ninguém jamais o leia (72 bytes na linha "nunca lido" da tabela do caminho frio). Esse é o caso que a orientação do MS Learn destaca para `LazyInitializer`: inicialização preguiçosa "without the overhead of a class".
- **Arrays de entradas construídas de forma preguiçosa**: `LazyInitializer.EnsureInitialized(ref _slots[i], () => Build(i))` funciona em elementos de array porque eles aceitam `ref`. Não existe um equivalente de `Lazy<T>[]` que não aloque um wrapper por slot de antemão.
- **Factories baratas e puras**: se executar a factory duas vezes numa corrida não custa nada, a sobrecarga lock-free de dois argumentos é a opção correta mais barata.
- **Você quer tentar de novo após uma falha**: nenhuma sobrecarga armazena exceções em cache.

Use a sobrecarga com `ref syncLock` quando a factory precisar executar uma vez. Passe um campo do tipo `object?` que começa como `null`: ele só é alocado na primeira chamada que chega ao caminho lento.

## Quando o double-checked locking escrito à mão ainda se justifica

Raramente. Dois casos de que eu realmente precisei:

- **Você precisa redefinir ou trocar o valor**. Nem `Lazy<T>` nem `LazyInitializer` permitem invalidar um valor. Um cache que se reconstrói a partir de um sinal precisa do próprio lock e de um campo volatile.
- **O caminho lento precisa de mais do que uma factory**: inicializar dois campos de forma atômica, ou chamar uma API assíncrona sob um `SemaphoreSlim`. Nesse ponto já não é bem inicialização preguiçosa, é uma pequena máquina de estados, e você deve escrevê-la de forma explícita.

Se for escrevê-lo, use `System.Threading.Lock` no .NET 9+, mantenha o campo `volatile`, leia-o em uma variável local uma vez no caminho rápido e nunca faça lock em `this`.

## A pegadinha que escolhe por você

Para valores lazy **estáticos**, você provavelmente não precisa de nenhuma das três. Um campo `static readonly` inicializado pelo inicializador de tipo é preguiçoso (o runtime o executa antes do primeiro acesso ao campo), thread-safe e gratuito no caminho quente, porque o JIT de tier 1 trata campos `static readonly` de uma classe já inicializada como constantes:

```csharp
// .NET 10, C# 14
public static class Pricing
{
    public static readonly FrozenDictionary<string, decimal> Table = LoadTable();
    private static FrozenDictionary<string, decimal> LoadTable() => /* ... */ FrozenDictionary<string, decimal>.Empty;
}
```

O problema: se `LoadTable` lançar, o tipo fica quebrado durante toda a vida do processo e todo acesso lança `TypeInitializationException`. É o mesmo comportamento de cache de `Lazy<T>`, só que mais difícil de recuperar. Use um `Lazy<T>` estático quando precisar da semântica de nova tentativa de `PublicationOnly` ou quando o tipo tiver outros membros estáticos que você quer manter utilizáveis mesmo que o carregamento falhe.

## A recomendação, mais uma vez

Comece com `Lazy<T>` e o modo padrão. Ele executa a factory uma vez, é uma única checagem de null no caminho quente, e sua única desvantagem real (exceções em cache) pode ser evitada com `PublicationOnly`. Passe para `LazyInitializer.EnsureInitialized` quando o profiling mostrar que as alocações do wrapper importam, o que na prática significa muitas instâncias com vários campos preguiçosos cada. Use a sobrecarga com `ref syncLock` se a factory precisar executar uma vez. Escreva o double-checked locking você mesmo apenas quando precisar redefinir o valor ou inicializar mais de uma coisa de forma atômica.

## Relacionados

- Se você está escrevendo o caminho lento com lock por conta própria, [lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock](/pt-br/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/) explica qual primitiva escolher.
- O [passo a passo do tipo System.Threading.Lock](/pt-br/2026/04/how-to-use-the-new-system-threading-lock-type-in-dotnet-11/) explica por que `lock` em um campo `Lock` é mais rápido do que fazer lock em um `object`.
- Para saber o que `volatile` e `Volatile.Read` realmente emitem em arm64, veja [Volatile.Read vs Volatile.ReadBarrier no .NET 10](/pt-br/2026/10/volatile-read-vs-volatile-readbarrier-in-dotnet-10/).
- Quando o valor lazy é, na verdade, uma entrada de cache que deveria expirar ou ser assíncrona, [HybridCache vs IMemoryCache vs IDistributedCache](/pt-br/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/) é a ferramenta melhor.
- Um `Lazy<T>` dentro de um singleton que captura um serviço scoped é o mesmo bug de captive dependency descrito em [corrigindo "Cannot consume scoped service from singleton"](/pt-br/2026/05/fix-cannot-consume-scoped-service-from-singleton/).

## Fontes

- [Lazy initialization](https://learn.microsoft.com/en-us/dotnet/framework/performance/lazy-initialization) no MS Learn, incluindo a tabela de cache de exceções.
- Referência da API [`LazyInitializer.EnsureInitialized`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.lazyinitializer.ensureinitialized).
- Referência da API [`LazyThreadSafetyMode`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.lazythreadsafetymode).
- [`Lazy.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/Lazy.cs) e [`LazyInitializer.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/Threading/LazyInitializer.cs) no dotnet/runtime `release/10.0`.
- [Especificação do modelo de memória do .NET](https://github.com/dotnet/runtime/blob/main/docs/design/specs/Memory-model.md), seções "Object assignment" e "Data-dependent reads are ordered".
