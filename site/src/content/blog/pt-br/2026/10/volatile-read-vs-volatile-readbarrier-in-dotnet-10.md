---
title: "Volatile.Read vs Volatile.ReadBarrier no .NET 10"
description: "Volatile.Read é uma leitura com semântica de acquire de uma única posição. Volatile.ReadBarrier, novo no .NET 10, é uma barreira que dá semântica de acquire a todas as leituras anteriores. Use Volatile.Read para flags e referências publicadas, e ReadBarrier quando precisar que um lote de leituras comuns ou não atômicas termine antes do próximo acesso à memória, como em um seqlock."
pubDate: 2026-10-02
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "concurrency"
  - "performance"
lang: "pt-br"
translationOf: "2026/10/volatile-read-vs-volatile-readbarrier-in-dotnet-10"
translatedBy: "claude"
translationDate: 2026-10-02
---

`Volatile.Read(ref x)` lê uma posição com semântica de acquire: nada que venha depois no seu código pode subir acima dessa leitura. `Volatile.ReadBarrier()`, adicionado no .NET 10, não lê nada. É uma barreira que dá semântica de acquire a **todas as leituras anteriores a ela**, de modo que um lote inteiro de leituras comuns (até não atômicas) precisa terminar antes de qualquer acesso à memória depois da barreira. Use `Volatile.Read` no caso comum de uma flag, um contador ou uma referência publicada. Recorra a `ReadBarrier` quando precisar que várias leituras comuns, ou uma leitura grande demais para ser atômica, terminem antes de uma nova verificação. O caso de livro-texto é o lado leitor de um seqlock.

Tudo abaixo foi medido no .NET 10.0.10 (SDK 10.0.302), C# 14, em um Apple M4 (arm64). As APIs de barreira existem em `System.Threading.Volatile` a partir do .NET 10; no .NET 9 e anteriores não há equivalente público além de `Interlocked.MemoryBarrier()`.

## A comparação num relance

| | `Volatile.Read(ref x)` | `Volatile.ReadBarrier()` |
| --- | --- | --- |
| Disponível desde | .NET Framework 4.5 | .NET 10 |
| Lê um valor | Sim, uma posição | Não |
| O que recebe semântica de acquire | Apenas essa leitura | Todas as leituras antes da chamada |
| Impede leituras e escritas posteriores de subirem | Sim | Sim |
| Torna a leitura atômica | Sim, para os tipos suportados (incluindo `long`/`double` em 32 bits) | Não, a atomicidade é problema seu |
| Funciona com qualquer `T`, structs, memória nativa | Não, conjunto fixo de overloads | Sim, ordena as leituras que a precedem |
| Codegen arm64 (medido, .NET 10.0.10) | `ldapur` (load-acquire) | `dmb ishld` (barreira de carga) |
| Codegen x64 | `mov` simples, apenas ordenação do compilador | nenhuma instrução, apenas ordenação do compilador |
| Uso típico | flags, inicialização com verificação dupla, referências publicadas | seqlocks, caches validados por versão, leituras em lote |

## O que as duas APIs prometem

A especificação do modelo de memória do .NET (`docs/design/specs/Memory-model.md` em dotnet/runtime) lista ambas em "volatile reads have acquire semantics", com uma nota reveladora sobre a barreira: ela "applies to all prior reads". Acquire significa que nenhuma leitura ou escrita que venha depois na ordem do programa pode executar antes da leitura com acquire.

Com `Volatile.Read(ref _version)`, o acquire fica associado à carga de `_version` e a mais nada. As leituras que aconteceram *antes* dela na ordem do programa não são restringidas de forma alguma. Elas ainda podem descer para depois dela.

Com `Volatile.ReadBarrier()`, o acquire fica associado a toda carga que precede a chamada. A proposta da API ([dotnet/runtime#98837](https://github.com/dotnet/runtime/issues/98837)) chama isso de barreira `Read-ReadWrite`: todas as leituras anteriores precisam terminar antes de qualquer operação de memória subsequente. A contraparte, `Volatile.WriteBarrier()`, é uma barreira `ReadWrite-Write`: todas as operações de memória anteriores terminam antes de qualquer escrita subsequente.

Portanto, as duas APIs não são duas intensidades da mesma coisa. Elas respondem a perguntas diferentes:

- `Volatile.Read`: "leia este valor e garanta que tudo depois dele veja a memória pelo menos tão atual quanto ele."
- `Volatile.ReadBarrier`: "garanta que tudo o que eu já li esteja concluído antes de eu tocar na memória de novo."

Nenhuma das duas é uma barreira completa. Uma `ReadBarrier` não faz nada para impedir que uma *escrita* anterior seja reordenada com uma leitura posterior (o caso store-load). Se você precisa disso, ainda precisa de `Interlocked.MemoryBarrier()` ou de uma operação `Interlocked`.

## O que o JIT realmente emite

O JIT trata os dois métodos como intrinsics. O código-fonte de `Volatile.cs` é apenas `[Intrinsic] public static void ReadBarrier() => ReadBarrier();`, e o importador substitui a chamada por um nó de barreira de memória marcado como somente de carga ([PR #107843](https://github.com/dotnet/runtime/pull/107843)). Para ver no que isso se transforma, compilei uma classe pequena com todas as otimizações e despejei o resultado com `DOTNET_JitDisasm`:

```csharp
// .NET 10.0.10, C# 14
// DOTNET_TieredCompilation=0 DOTNET_JitDisasm='Codegen:*' dotnet vb.dll
sealed class Codegen
{
    private int _x;
    private long _a, _b, _c, _d;

    [MethodImpl(MethodImplOptions.NoInlining)]
    public long AcquireFour() =>
        Volatile.Read(ref _a) + Volatile.Read(ref _b) +
        Volatile.Read(ref _c) + Volatile.Read(ref _d);

    [MethodImpl(MethodImplOptions.NoInlining)]
    public long PlainFourThenBarrier()
    {
        long sum = _a + _b + _c + _d;
        Volatile.ReadBarrier();
        return sum;
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    public void BarrierThenPlainFour(long v)
    {
        Volatile.WriteBarrier();
        _a = v; _b = v; _c = v; _d = v;
    }
}
```

No M4, as instruções interessantes foram:

```text
; AcquireFour: four separate load-acquire instructions
ldapur  x1, [x0, #0x08]
ldapur  x2, [x0, #0x10]
ldapur  x2, [x0, #0x18]
ldapur  x0, [x0, #0x20]

; PlainFourThenBarrier: two paired loads, then one load fence
ldp     x1, x2, [x0, #0x08]
ldp     x2, x0, [x0, #0x18]
dmb     ishld

; BarrierThenPlainFour: a full fence, then two paired stores
dmb     ish
stp     x1, x1, [x0, #0x08]
stp     x1, x1, [x0, #0x18]
```

Três coisas chamam a atenção.

Primeiro, `Volatile.Read` compila para `ldapur`, uma load-acquire RCpc (as extensões RCpc chegaram no ARMv8.3 e v8.4), que o M4 suporta. Núcleos sem RCpc recebem o `ldar` mais antigo. De qualquer forma, não há instrução de barreira separada.

Segundo, as leituras comuns antes de `ReadBarrier` continuam comuns, então o JIT está livre para agrupá-las em `ldp` (e, para uma cópia de struct de 32 bytes, em um par de cargas `ldp q` de 128 bits). Você perde essa liberdade com quatro cargas acquire. Esse é o argumento de eficiência da proposta: uma barreira para N leituras em vez de N leituras ordenadas.

Terceiro, `Volatile.WriteBarrier()` é um `dmb ish` completo no arm64, exatamente o que `Interlocked.MemoryBarrier()` emite. O JIT tem um comentário dizendo que atualmente não consegue emitir uma barreira somente de escrita melhor do que uma completa no arm64, então não espere que `WriteBarrier` seja mais barata que uma barreira completa ali.

No x64, ambas as barreiras não emitem instrução alguma. O comentário de codegen do PR é explícito: barreiras somente de carga e somente de escrita "are no-ops on xarch", porque o modelo TSO do x86 já mantém as cargas ordenadas com cargas e escritas posteriores, e as escritas ordenadas com operações de memória anteriores. Elas ainda importam no x64, porém: impedem o próprio JIT de reordenar, armazenar em cache ou eliminar acessos à memória através da barreira. Eu não tinha uma máquina x64 para esta rodada, então a linha x64 da tabela vem do código-fonte do JIT, não de um disassembly.

## Um seqlock: o caso para o qual ReadBarrier foi criada

O próprio runtime foi o primeiro cliente. `GenericCache` e `CastCache` no CoreLib usavam um `Interlocked.ReadMemoryBarrier()` interno e foram trocados para `Volatile.ReadBarrier()` no mesmo PR. O comentário deles descreve o padrão: "we must read in this order: version -> [entry parts] -> version".

Isso é um seqlock. Um único escritor incrementa uma versão para um número ímpar, escreve os dados e depois a incrementa para o próximo número par. Os leitores leem a versão, copiam os dados com cargas comuns e leem a versão de novo. Se as duas leituras forem iguais e pares, a cópia é consistente. Os dados podem ter qualquer tamanho: uma struct de 32 bytes não é atômica em nenhuma plataforma, e tudo bem, porque a verificação de versão pega as cópias rasgadas.

Aqui está a versão mínima, com as duas barreiras nos lugares a que pertencem:

```csharp
// .NET 10, C# 14
struct Snapshot { public long A, B, C, D; }

sealed class SeqLockBox
{
    private int _version;          // even = stable, odd = write in progress
    private Snapshot _data;

    // Single writer only.
    public void Write(long n)
    {
        int v = _version;
        _version = v + 1;          // mark "writing" (odd)
        Volatile.WriteBarrier();   // odd version is published before any data write below
        _data.A = n; _data.B = n; _data.C = n; _data.D = n;
        Volatile.Write(ref _version, v + 2); // release: data writes complete before the even version
    }

    public bool TryRead(out Snapshot snapshot)
    {
        int v1 = Volatile.Read(ref _version); // acquire: the data reads below cannot move above this
        snapshot = _data;                     // plain, non-atomic 32-byte copy
        Volatile.ReadBarrier();               // every read above completes before the re-check
        return (v1 & 1) == 0 && _version == v1;
    }
}
```

Observe como o leitor usa as duas APIs. A primeira leitura da versão é um `Volatile.Read`, porque precisamos que as leituras de dados fiquem *abaixo* dela. A cópia dos dados é comum. Depois, `ReadBarrier` mantém as leituras de dados *acima* da segunda leitura da versão. Nenhum `Volatile.Read` isolado consegue expressar essa segunda restrição, porque `Volatile.Read` só restringe o que vem depois da posição que ele lê, e aqui o que precisamos ordenar é o que veio antes.

O escritor espelha isso. `Volatile.Write` na versão par final é um release, então as escritas de dados não podem afundar para depois dele. Mas um release não faz nada para impedir que as escritas de dados subam acima da escrita anterior da versão ímpar. `WriteBarrier` cobre esse lado.

## Provando que cada metade é necessária

Executei o leitor e o escritor em duas threads por cinco segundos por cenário e contei quantos snapshots aceitos tinham `A`, `B`, `C`, `D` em desacordo. Cada cenário remove uma peça da ordenação:

```csharp
// .NET 10, C# 14: the reader variants in the stress test
public bool TryReadAcquireOnly(out Snapshot snapshot)   // no ReadBarrier
{
    int v1 = Volatile.Read(ref _version);
    snapshot = _data;
    return (v1 & 1) == 0 && _version == v1;
}

public bool TryReadBarrierOnly(out Snapshot snapshot)   // no acquire on the first read
{
    int v1 = _version;
    snapshot = _data;
    Volatile.ReadBarrier();
    return (v1 & 1) == 0 && _version == v1;
}
```

Resultados no M4, .NET 10.0.10, build Release, duas execuções:

| Cenário | Snapshots aceitos (execução 1 / execução 2) | Rasgados e aceitos (execução 1 / execução 2) |
| --- | --- | --- |
| Nenhuma ordenação (leituras comuns) | 1,014,876,206 / 1,003,303,309 | 547,804 / 515,135 |
| Apenas `Volatile.Read`, sem `ReadBarrier` | 164,358,676 / 152,032,561 | 99 / 357 |
| Apenas `ReadBarrier`, primeira leitura comum | 34,543,735 / 27,982,884 | 54 / 62 |
| Escritor sem `WriteBarrier`, leitor correto | 354,942,744 / 384,287,324 | 66,155,404 / 54,597,163 |
| Ambas as barreiras (o código acima) | 62,659,697 / 66,048,738 | 0 / 0 |

Toda meia-medida produziu dados rasgados que passaram na validação. Os raros são os perigosos: 99 leituras ruins em 164 milhões é o tipo de bug que sobrevive a todas as execuções de teste e aparece em produção em uma máquina Graviton ou Ampere. A `WriteBarrier` ausente foi a falha mais barulhenta, e o disassembly mostra por quê: os dois métodos do escritor compilam para código idêntico, exceto pelo único `dmb ish`, então cada uma daquelas mais de 54 milhões de rasgaduras é o núcleo arm64 tornando as escritas de dados visíveis antes da escrita da versão ímpar.

No x64 você provavelmente veria zero rasgaduras na maioria dessas linhas, porque o hardware não reordena nessas direções. É exatamente por isso que esses bugs chegam à produção. O código continua errado no x64, já que o JIT pode reordenar acessos comuns, e ele se torna visivelmente errado no momento em que roda no arm64.

## O JIT também reordena, não só a CPU

A primeira versão do meu harness de estresse travou para sempre, e vale mostrar por quê. O leitor quebrado fazia um loop até ver uma versão par:

```csharp
// .NET 10, C# 14: do not do this
public void WaitForEvenBroken()
{
    while ((_version & 1) != 0) { }
}
```

O JIT compilou isso para uma carga e um desvio para si mesmo:

```text
ldr     w0, [x0, #0x08]
and     w0, w0, #1
G_M000_IG03:
cbnz    w0, G_M000_IG03
```

A carga de `_version` foi içada para fora do loop, o que é legal para uma leitura comum de campo sem sincronização intermediária. Se a primeira leitura calhasse de pegar uma versão ímpar, a thread giraria para sempre. Um `Volatile.Read(ref _version)` dentro da condição resolve, e um `ReadBarrier` dentro do corpo do loop também resolveria. Essa é a parte de "volatile" que os desenvolvedores x64 realmente vivenciam, e é por isso que as barreiras não são chamadas vazias mesmo onde não emitem instrução.

## Quando escolher Volatile.Read

- **Uma flag ou um sinal de parada.** `while (!Volatile.Read(ref _stop))` é o caso canônico. Uma posição, um valor, e você quer que as leituras posteriores vejam o que o escritor publicou antes de defini-lo.
- **Publicar uma referência.** O escritor constrói um objeto e depois faz `Volatile.Write(ref _instance, obj)`; o leitor faz `Volatile.Read(ref _instance)` e depois lê os campos através dele. O acquire na leitura da referência é tudo de que você precisa.
- **Inicialização preguiçosa com verificação dupla.** Mesmo formato da publicação, e o motivo pelo qual `LazyInitializer` usa leituras volatile internamente.
- **Você tem como alvo o .NET 9 ou anterior.** `ReadBarrier` não existe ali.

Em todos esses casos, a ordenação está ancorada em uma única leitura, então `Volatile.Read` diz exatamente o que você quer dizer e não gera barreira em nenhuma das arquiteturas.

## Quando escolher Volatile.ReadBarrier

- **Leitores de seqlock e caches validados por versão.** O padrão acima, e o que `CastCache` e `GenericCache` do CoreLib usam.
- **Dados que não podem ser lidos atomicamente.** Structs maiores que um ponteiro, `Int128`, spans de bytes ou uma struct com vários campos. Não há overload de `Volatile.Read` para eles, e `ReadBarrier` permite copiá-los com cargas comuns e validar depois.
- **Leituras de memória nativa ou via `Unsafe`.** Se você lê através de um ponteiro ou `ref` para um buffer não gerenciado, pode não haver campo gerenciado para passar a `Volatile.Read`. A barreira ordena essas cargas do mesmo jeito.
- **Muitas leituras que precisam de um único ponto de ordenação.** Um `dmb ishld` depois de N cargas comuns em vez de N cargas acquire, deixando o JIT agrupar as cargas comuns.

## O custo, medido

Há duas formas corretas de escrever o leitor de seqlock sem `ReadBarrier`: tornar toda leitura de dados um `Volatile.Read`, ou usar um `Interlocked.MemoryBarrier()` completo onde a barreira vai. Comparei todas com o leitor sem ordenação (quebrado) usando BenchmarkDotNet 0.15.8. Cada invocação faz 1,024 leituras single-thread do snapshot de 32 bytes, e a tabela informa o custo por leitura:

```csharp
// .NET 10.0.10, C# 14, BenchmarkDotNet 0.15.8, Apple M4 (arm64)
[Benchmark(OperationsPerInvoke = N)]
public long VolatileReadPlusReadBarrier()
{
    long sum = 0;
    for (int i = 0; i < N; i++)
    {
        int v1 = Volatile.Read(ref _version);
        Snapshot s = _data;
        Volatile.ReadBarrier();
        if ((v1 & 1) == 0 && _version == v1) sum += s.A + s.B + s.C + s.D;
    }
    return sum;
}
```

| Leitor (por leitura de snapshot) | Média | Razão |
| --- | --- | --- |
| Sem ordenação (quebrado) | 0.916 ns | 1.00 |
| `Volatile.Read` na versão e nos quatro campos | 1.135 ns | 1.24 |
| `Volatile.Read` + `Volatile.ReadBarrier` | 0.929 ns | 1.01 |
| `Volatile.Read` + `Interlocked.MemoryBarrier` | 0.930 ns | 1.02 |

A versão com barreira custa praticamente o mesmo que a quebrada. A versão que lê tudo como volatile é cerca de 24% mais lenta, principalmente porque quatro cargas `ldapur` ordenadas não podem ser fundidas em duas cargas largas como a cópia comum pode. Aumente isso para uma struct maior e a diferença cresce com o número de campos, enquanto a barreira continua sendo uma instrução.

Duas ressalvas honestas. Este é um loop single-thread sem contenção: um `dmb` é barato quando o núcleo não tem tráfego de memória pendente para esperar, e é por isso que a barreira completa também parece de graça aqui. Sob contenção real de escrita, uma barreira completa normalmente custa mais que uma somente de carga, mas não executei um benchmark com contenção, então não vou colocar um número nisso. E tudo isso é arm64. No x64 as duas barreiras não emitem instrução, então você está apenas comparando o que o JIT tem permissão de fazer ao redor delas.

## Armadilhas que machucam

**A posição é tudo.** `ReadBarrier` ordena as leituras *antes* dela contra os acessos *depois* dela. Colocá-la no início de um leitor, onde as pessoas instintivamente colocam uma leitura "volatile", não ordena nada do que importa. Em um seqlock ela vai depois da cópia dos dados e antes da segunda leitura da versão.

**Não é uma barreira completa.** Uma escrita seguida de `ReadBarrier` seguida de uma carga ainda pode ser reordenada. Código no estilo Dekker, em que cada thread escreve sua própria flag e depois lê a da outra, precisa de `Interlocked.MemoryBarrier()` ou de uma operação `Interlocked`.

**Não torna nada atômico.** A especificação do modelo de memória é direta: a semântica volatile não implica atomicidade. Se você pular a validação de versão, uma barreira vai ordenar com prazer uma leitura rasgada.

**Não é um lock.** Um seqlock como escrito suporta exatamente um escritor. Dois escritores precisam se serializar com um `Interlocked.CompareExchange` na versão (que é o que `GenericCache` faz) ou com um lock de verdade. Se você está recorrendo a barreiras porque um lock pareceu lento, meça primeiro: o post sobre [lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock](/pt-br/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/) mostra como um lock sem contenção já é barato.

**Campos `volatile` do C# não são a mesma ferramenta.** Um campo `volatile` faz o compilador C# emitir todo acesso com o prefixo IL `volatile.`, então toda leitura é um acquire e toda escrita é um release. Isso é a semântica de `Volatile.Read`/`Volatile.Write` por acesso, nunca uma barreira sobre um lote, e desativa o agrupamento de cargas mostrado acima.

## O veredito

Use `Volatile.Read` por padrão. É a ferramenta certa para quase todo padrão lock-free de flag, publicação e inicialização preguiçosa, não custa nada no x64 e, no arm64 moderno, é uma única instrução load-acquire. Use `Volatile.ReadBarrier` (no .NET 10 e posteriores) apenas quando o que você precisa ordenar for um lote de leituras anteriores, tipicamente uma cópia não atômica que você valida depois. Quando fizer isso, combine com `Volatile.WriteBarrier` no lado do escritor, teste no arm64 e lembre-se de que no arm64 `WriteBarrier` é tão cara quanto uma barreira completa.

## Relacionados

- [Como usar o novo tipo System.Threading.Lock](/pt-br/2026/04/how-to-use-the-new-system-threading-lock-type-in-dotnet-11/), a resposta certa quando você na verdade não precisa de código lock-free.
- [lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock em C#](/pt-br/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/) para escolher uma primitiva de sincronização.
- [Como cancelar uma Task de longa duração sem causar deadlock](/pt-br/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/), onde um `Volatile.Read` fica por trás de toda verificação de cancelamento.
- [record vs class vs struct em C#](/pt-br/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/), relevante quando seu estado compartilhado é uma struct com vários campos que não pode ser lida atomicamente.

## Fontes

- [Volatile.ReadBarrier method](https://learn.microsoft.com/en-us/dotnet/api/system.threading.volatile.readbarrier?view=net-10.0) e [Volatile class](https://learn.microsoft.com/en-us/dotnet/api/system.threading.volatile?view=net-10.0) no MS Learn.
- [API proposal: Volatile barrier APIs, dotnet/runtime#98837](https://github.com/dotnet/runtime/issues/98837).
- [Implement volatile barrier APIs, dotnet/runtime#107843](https://github.com/dotnet/runtime/pull/107843), incluindo o codegen do JIT e as mudanças nos caches do CoreLib.
- [.NET memory model specification](https://github.com/dotnet/runtime/blob/main/docs/design/specs/Memory-model.md).
- [GenericCache.cs on release/10.0](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/Runtime/CompilerServices/GenericCache.cs), um leitor de seqlock de produção que usa `Volatile.ReadBarrier`.
