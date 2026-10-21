---
title: "O que acontece com uma entrada expirada do MemoryCache, e quando ela é realmente removida da memória?"
description: "Uma entrada expirada do MemoryCache não é removida por um timer. Ela permanece no dicionário até que uma leitura a toque, uma varredura em segundo plano com limitação de frequência seja executada ou a compactação entre em ação. Veja exatamente quando cada caso acontece e como obter uma remoção imediata."
pubDate: 2026-10-21
tags:
  - "dotnet"
  - "dotnet-10"
  - "caching"
  - "memorycache"
  - "performance"
lang: "pt-br"
translationOf: "2026/10/what-happens-to-an-expired-memorycache-entry-and-when-is-it-removed"
translatedBy: "claude"
translationDate: 2026-10-21
---

Nada acontece com uma entrada expirada do `MemoryCache` no momento em que ela expira. `Microsoft.Extensions.Caching.Memory` não tem um timer por entrada nem uma thread em segundo plano vigiando o relógio, então a entrada, seu valor e tudo o que o valor referencia permanecem no dicionário do cache até que uma de três coisas a toque: uma leitura dessa chave (`TryGetValue`, `Get`, `GetOrCreate`), uma varredura em segundo plano por itens expirados que só é iniciada por alguma outra operação do cache e no máximo uma vez por `ExpirationScanFrequency` (1 minuto por padrão), ou uma compactação (`Compact()` ou o caminho de estouro de `SizeLimit`). Somente depois que a entrada sai do dicionário o GC pode recuperar o valor. A única exceção é um token de expiração como `CancellationChangeToken`: quando ele dispara, a entrada é removida imediatamente, sem precisar de leitura.

Tudo abaixo foi verificado com `Microsoft.Extensions.Caching.Memory` 10.0.13 e 11.0.0-rc.2.26504.105 no .NET 10.0.10 (SDK 10.0.302), com o código-fonte lido do branch `main` do `dotnet/runtime`. Os dois pacotes imprimiram saída idêntica em todos os cenários, e essa parte do design não muda há anos.

## Por que não existe um timer de expiração

O `MemoryCache` armazena as entradas em um `ConcurrentDictionary`. Cada `CacheEntry` conhece sua expiração absoluta, sua expiração deslizante e seus tokens de expiração, mas não agenda nada. A expiração é uma verificação preguiçosa, `CacheEntry.CheckExpired(DateTime utcNow)`, que o cache chama sempre que acontece de olhar para uma entrada:

```csharp
// dotnet/runtime main, CacheEntry.cs (abridged)
internal bool CheckExpired(DateTime utcNow)
    => EvictionReason != EvictionReason.None
        || CheckForExpiredTime(utcNow)
        || (_tokens != null && _tokens.CheckForExpiredTokens(this));
```

Isso é uma troca deliberada. Um cache com um milhão de entradas e um timer por entrada gastaria CPU e memória reais com timers. Um único timer periódico acordaria para sempre um processo que de outra forma estaria ocioso. O design preguiçoso não custa nada quando o cache está quieto, ao preço de manter dados obsoletos por mais tempo do que você poderia supor.

Então a pergunta real nunca é "quando ela expira", e sim "quando o cache vai olhar para ela". Existem quatro respostas.

## Caminho 1: uma leitura da mesma chave a remove imediatamente

`TryGetValue` (por onde passam `Get`, `GetOrCreate` e `GetOrCreateAsync`) verifica a entrada que encontrou. Se ela estiver expirada, a entrada é removida do dicionário na hora e a chamada informa um miss:

```csharp
// dotnet/runtime main, MemoryCache.PostProcessTryGetValue (abridged)
if (!entry.CheckExpired(utcNow) || entry.EvictionReason == EvictionReason.Replaced)
{
    entry.LastAccessed = utcNow;
    result = entry.Value;
    StartScanForExpiredItemsIfNeeded(utcNow);
    return true; // hit
}
else
{
    coherentState.RemoveEntry(entry, _options); // expired: removed right here
}
```

Você nunca recebe um valor expirado de volta de uma leitura, então a correção não é o problema. O problema é tudo o que você não leu.

## Caminho 2: a varredura em segundo plano com limitação de frequência

Quase toda operação do cache (um hit, um miss, um `Set`, um `Remove`, uma expiração disparada por token) termina com uma chamada a `StartScanForExpiredItemsIfNeeded`:

```csharp
// dotnet/runtime main, MemoryCache.cs
private void StartScanForExpiredItemsIfNeeded(DateTime utcNow)
{
    if (_options.ExpirationScanFrequency < utcNow - _lastExpirationScan)
    {
        _lastExpirationScan = utcNow;
        Task.Factory.StartNew(state => ((MemoryCache)state!).ScanForExpiredItems(), this,
            CancellationToken.None, TaskCreationOptions.DenyChildAttach, TaskScheduler.Default);
    }
}
```

`ScanForExpiredItems` percorre todas as entradas em uma thread do pool de threads e remove as expiradas. Duas consequências decorrem diretamente desse código:

1. **A varredura é disparada, não agendada.** Se nada chamar o cache, nenhuma varredura é iniciada. Um cache ocioso cheio de entradas expiradas mantém todas elas indefinidamente.
2. **A varredura tem limitação de frequência.** Mesmo em um cache movimentado, uma varredura completa começa no máximo uma vez por `ExpirationScanFrequency`, que por padrão é `TimeSpan.FromMinutes(1)`. Uma entrada que expira logo depois de uma varredura pode sobreviver por até um minuto de tráfego contínuo, e por um tempo arbitrariamente longo sem tráfego.

## Caminho 3: compactação

Quando você define `SizeLimit` e uma inserção faria o `Size` total ultrapassá-lo, o cache enfileira no pool de threads uma compactação por excesso de capacidade. Você também pode chamar `Compact(double percentage)` por conta própria. Ambos passam pelo mesmo método privado `Compact`, cujo primeiro passo é coletar todas as entradas expiradas para remoção antes de começar a despejar entradas vivas por prioridade (`Low`, depois `Normal`, depois `High`, cada grupo ordenado por `LastAccessed`; `NeverRemove` nunca é tocado). Portanto, `Compact(0)` remove todas as entradas expiradas e nada além disso, o que é uma varredura manual prática.

## Caminho 4: tokens de expiração são o único caminho imediato

Se uma entrada tem um `IChangeToken` com `ActiveChangeCallbacks == true` (um `CancellationChangeToken`, um token de file provider, um token de recarga de configuração), o cache registra um callback nele. Quando o token dispara, o callback enfileira um trabalho que marca a entrada com `EvictionReason.TokenExpired` e a remove do dicionário, sem precisar de leitura:

```csharp
// dotnet/runtime main, CacheEntry.cs
private static void ExpirationTokensExpired(object obj)
{
    // start a new thread to avoid issues with callbacks called from RegisterChangeCallback
    Task.Factory.StartNew(state =>
    {
        var entry = (CacheEntry)state!;
        entry.SetExpired(EvictionReason.TokenExpired);
        entry._cache.EntryExpired(entry);
    }, obj, CancellationToken.None, TaskCreationOptions.DenyChildAttach, TaskScheduler.Default);
}
```

A expiração baseada em tempo (`AbsoluteExpiration`, `AbsoluteExpirationRelativeToNow`, `SlidingExpiration`) nunca segue esse caminho.

## Uma sonda que mostra os quatro caminhos

A maneira mais fácil de ver isso sem esperar minutos é dar ao cache um relógio manual. `MemoryCacheOptions.Clock` recebe um `ISystemClock` (não um `TimeProvider`), e `MemoryCache.Count` retorna a contagem bruta do dicionário, incluindo as entradas expiradas. Salve isto como `probe.cs` e execute com `dotnet run probe.cs`:

```csharp
#:package Microsoft.Extensions.Caching.Memory@10.0.13
#:property PublishAot=false
// .NET 10, C# 14, Microsoft.Extensions.Caching.Memory 10.0.13
using System.Runtime.CompilerServices;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Internal;
using Microsoft.Extensions.Primitives;

var clock = new ManualClock();
var cache = new MemoryCache(new MemoryCacheOptions
{
    Clock = clock,
    ExpirationScanFrequency = TimeSpan.FromMinutes(1),
});

// 1. Expired entries stay until something touches them
cache.Set("a", "A", TimeSpan.FromSeconds(10));
clock.Advance(TimeSpan.FromSeconds(30));
Console.WriteLine($"[1] after expiry, Count = {cache.Count}");
Console.WriteLine($"[1] TryGetValue = {cache.TryGetValue("a", out _)}, Count = {cache.Count}");

// 2. Idle cache: nobody reads, nothing is removed
for (int i = 0; i < 1000; i++)
    cache.Set($"k{i}", new byte[1024], TimeSpan.FromSeconds(10));
clock.Advance(TimeSpan.FromMinutes(10));
Thread.Sleep(500);
Console.WriteLine($"[2] 10 min later, nobody touched the cache, Count = {cache.Count}");
cache.TryGetValue("unrelated", out _); // any operation; >1 min since last scan
Thread.Sleep(200);
Console.WriteLine($"[2] after one unrelated TryGetValue, Count = {cache.Count}");

// 3. Scan throttling: a second expiry within ExpirationScanFrequency is not scanned
cache.Set("b", "B", TimeSpan.FromSeconds(10));
clock.Advance(TimeSpan.FromSeconds(30));
cache.TryGetValue("unrelated", out _);
Thread.Sleep(200);
Console.WriteLine($"[3] 30 s later (< scan frequency), Count = {cache.Count}");
clock.Advance(TimeSpan.FromSeconds(31));
cache.TryGetValue("unrelated", out _);
Thread.Sleep(200);
Console.WriteLine($"[3] 61 s since last scan, Count = {cache.Count}");

// 4. Post-eviction callback runs later, on a thread-pool thread
var done = new ManualResetEventSlim();
int callerThread = Environment.CurrentManagedThreadId;
cache.Set("c", "C", new MemoryCacheEntryOptions()
    .SetAbsoluteExpiration(TimeSpan.FromSeconds(10))
    .RegisterPostEvictionCallback((k, v, reason, _) =>
    {
        Console.WriteLine($"[4] callback key={k} reason={reason} thread={Environment.CurrentManagedThreadId} (caller {callerThread}) pool={Thread.CurrentThread.IsThreadPoolThread}");
        done.Set();
    }));
clock.Advance(TimeSpan.FromSeconds(30));
Console.WriteLine($"[4] TryGetValue = {cache.TryGetValue("c", out _)} returned before callback ran: {!done.IsSet}");
done.Wait(2000);

// 5. Expiration token: removed eagerly, no read required
var cts = new CancellationTokenSource();
var tokenDone = new ManualResetEventSlim();
cache.Set("d", "D", new MemoryCacheEntryOptions()
    .AddExpirationToken(new CancellationChangeToken(cts.Token))
    .RegisterPostEvictionCallback((k, _, reason, _) => { Console.WriteLine($"[5] callback key={k} reason={reason}"); tokenDone.Set(); }));
int before = cache.Count;
cts.Cancel();
tokenDone.Wait(2000);
Console.WriteLine($"[5] Count before cancel = {before}, after cancel (no reads) = {cache.Count}");

// 6. Memory: the value is reachable until the entry leaves the dictionary
var weak = Store(cache, clock);
clock.Advance(TimeSpan.FromSeconds(30));
GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect();
Console.WriteLine($"[6] expired but not removed, value alive after GC = {weak.IsAlive}");
cache.TryGetValue("big", out _);
GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect();
Console.WriteLine($"[6] removed by read, value alive after GC = {weak.IsAlive}");

// 7. Sliding expiration is measured from the last read
cache.Set("s", "S", new MemoryCacheEntryOptions { SlidingExpiration = TimeSpan.FromSeconds(20) });
for (int i = 0; i < 5; i++) { clock.Advance(TimeSpan.FromSeconds(15)); cache.TryGetValue("s", out _); }
Console.WriteLine($"[7] read every 15 s for 75 s with 20 s sliding: still there = {cache.TryGetValue("s", out _)}");
clock.Advance(TimeSpan.FromSeconds(21));
Console.WriteLine($"[7] after 21 s idle: still there = {cache.TryGetValue("s", out _)}");

// 8. Compact(0) removes expired entries only
cache.Set("e1", 1, TimeSpan.FromSeconds(5));
cache.Set("e2", 2, TimeSpan.FromSeconds(5));
cache.Set("live", 3, TimeSpan.FromHours(1));
clock.Advance(TimeSpan.FromSeconds(10));
Console.WriteLine($"[8] before Compact(0): Count = {cache.Count}");
cache.Compact(0);
Console.WriteLine($"[8] after Compact(0): Count = {cache.Count}");

[MethodImpl(MethodImplOptions.NoInlining)]
static WeakReference Store(MemoryCache cache, ManualClock clock)
{
    var value = new byte[10_000_000];
    cache.Set("big", value, TimeSpan.FromSeconds(10));
    return new WeakReference(value);
}

sealed class ManualClock : ISystemClock
{
    private DateTimeOffset _now = new(2026, 10, 21, 12, 0, 0, TimeSpan.Zero);
    public DateTimeOffset UtcNow => _now;
    public void Advance(TimeSpan by) => _now += by;
}
```

Saída, idêntica com o pacote 10.0.13 e 11.0.0-rc.2.26504.105:

```text
[1] after expiry, Count = 1
[1] TryGetValue = False, Count = 0
[2] 10 min later, nobody touched the cache, Count = 1000
[2] after one unrelated TryGetValue, Count = 0
[3] 30 s later (< scan frequency), Count = 1
[3] 61 s since last scan, Count = 0
[4] TryGetValue = False returned before callback ran: True
[4] callback key=c reason=Expired thread=4 (caller 1) pool=True
[5] callback key=d reason=TokenExpired
[5] Count before cancel = 1, after cancel (no reads) = 0
[6] expired but not removed, value alive after GC = True
[6] removed by read, value alive after GC = False
[7] read every 15 s for 75 s with 20 s sliding: still there = True
[7] after 21 s idle: still there = False
[8] before Compact(0): Count = 3
[8] after Compact(0): Count = 1
```

A linha `[2]` é a que surpreende as pessoas: mil entradas expiradas, dez minutos depois da expiração, ainda no cache, até que uma busca por uma chave completamente não relacionada dispare a varredura. A linha `[6]` é a consequência para a memória: um array de 10 MB que expirou ainda é alcançável, e um GC completo bloqueante não consegue coletá-lo, porque o dicionário do cache ainda o referencia.

## O que "removido da memória" realmente significa

A remoção do cache e a recuperação pelo GC são dois eventos separados:

1. A entrada é removida do `ConcurrentDictionary` por um dos quatro caminhos acima. A partir daí o cache não mantém mais o valor como raiz.
2. Se a entrada tem callbacks de pós-despejo, o cache os enfileira no pool de threads com `Task.Factory.StartNew`. O `CacheEntry` (e portanto seu `Value`) permanece alcançável a partir desse item de trabalho enfileirado até que todos os callbacks tenham sido executados e, é claro, por todo o tempo em que algum callback guardar o valor em algum lugar.
3. O GC recupera o valor na próxima coleta da geração em que o valor está. Um valor de cache de longa duração geralmente já foi promovido para a gen 2, ou fica no Large Object Heap se tiver 85.000 bytes ou mais, então a "próxima coleta" pode demorar em um servidor que raramente faz GCs completos.

Se um heap dump mostra o seu tipo em cache dominando a memória muito tempo depois de você esperar que ele expirasse, verifique as raízes: um caminho passando por `MemoryCache` e `CoherentState` significa que a entrada simplesmente ainda está no dicionário, o que é um problema de varredura, não um vazamento de memória. O [passo a passo de dotnet-gcdump e dotnet-dump](/pt-br/2026/07/how-to-diagnose-a-managed-memory-leak-with-dotnet-gcdump-and-dotnet-dump/) mostra como ler esses caminhos de raiz.

## Callbacks de pós-despejo são tardios e rodam em outra thread

`RegisterPostEvictionCallback` é a forma usual de tentar observar a expiração, e ele herda toda a preguiça descrita acima. Um callback de uma entrada expirada por tempo não dispara no horário da expiração. Ele dispara quando a entrada é realmente removida, o que acontece durante uma leitura, uma varredura ou uma compactação, e mesmo então ele roda depois, em uma thread do pool de threads (linha `[4]`: a leitura retornou um miss antes de o callback ter rodado). O callback recebe o `EvictionReason`: `Expired` para expiração por tempo, `TokenExpired` para tokens, `Capacity` para compactação por tamanho, `Removed` para um `Remove` explícito e `Replaced` quando você chama `Set` na mesma chave novamente.

Exceções lançadas de dentro de um callback são capturadas e registradas como `EvictionCallback invoked failed` pelo `ILogger` do cache, então nunca derrubam o processo, mas também nunca aparecem a menos que você olhe os logs.

Não construa um "recarregar ao expirar" em cima desses callbacks com expiração baseada em tempo. Em um servidor quieto, o recarregamento só aconteceria quando alguma requisição observasse o miss pela primeira vez, o que anula o objetivo.

## Obtendo uma remoção imediata e no horário

Se você precisa que uma entrada saia do cache perto do seu horário de expiração, sem depender de tráfego, anexe um token que dispara em um timer. Um `CancellationTokenSource` com atraso é o mais simples:

```csharp
// .NET 10, C# 14, Microsoft.Extensions.Caching.Memory 10.0.13
public static void SetWithEagerExpiry<T>(IMemoryCache cache, object key, T value, TimeSpan ttl)
{
    var cts = new CancellationTokenSource(ttl);
    var options = new MemoryCacheEntryOptions()
        .SetAbsoluteExpiration(ttl) // still enforced lazily on reads
        .AddExpirationToken(new CancellationChangeToken(cts.Token))
        .RegisterPostEvictionCallback(static (_, _, _, state) => ((CancellationTokenSource)state!).Dispose(), cts);

    cache.Set(key, value, options);
}
```

Quando o atraso termina, o token dispara, o cache remove a entrada e o callback de pós-despejo descarta o `CancellationTokenSource` (ele também roda se a entrada for substituída ou removida antes, para que o timer não vaze). O custo é um timer por entrada, então use isso para as poucas entradas grandes ou sensíveis que precisam sair no horário, não para um cache com um milhão de itens pequenos.

Para todo o resto, dois ajustes geralmente bastam:

- **Reduza `ExpirationScanFrequency`.** No ASP.NET Core, `services.AddMemoryCache(o => o.ExpirationScanFrequency = TimeSpan.FromSeconds(10));`. Cada varredura percorre o dicionário inteiro, então em um cache muito grande isso troca CPU por rapidez. Ainda é necessária alguma operação para disparar a varredura.
- **Varra no seu próprio agendamento.** Um `BackgroundService` ou `PeriodicTimer` que chama `cache.Compact(0)` a cada N segundos remove todas as entradas expiradas mesmo quando o cache está ocioso. `Compact` é definido na classe concreta `MemoryCache`, não em `IMemoryCache`, então faça um cast ou injete `MemoryCache`.

## Pegadinhas que vale conhecer

**`Count` inclui entradas expiradas.** `MemoryCache.Count`, `MemoryCache.Keys` (adicionado no .NET 9) e `GetCurrentStatistics().CurrentEntryCount` informam o dicionário bruto, então um dashboard pode mostrar milhares de entradas "vivas" que estão todas além da expiração. O medidor OpenTelemetry integrado descrito no [post sobre as métricas do MemoryCache no .NET 11](/pt-br/2026/06/dotnet-11-memorycache-opentelemetry-metrics/) lê as mesmas estatísticas, com a mesma ressalva.

**A expiração deslizante é reiniciada por leituras, não por varreduras.** Cada hit atualiza `LastAccessed`, que é o que a expiração deslizante usa como referência (linha `[7]`). Uma varredura não conta como acesso, mas remove a entrada quando a janela deslizante passou.

**Definir uma entrada já expirada não a adiciona.** Se as opções que você passa para `Set` já estiverem expiradas no momento da inserção (por exemplo, uma expiração absoluta no passado), a entrada nunca entra no dicionário e seus callbacks disparam imediatamente com `EvictionReason.Expired`.

**A compactação por `SizeLimit` também é assíncrona.** A inserção que ultrapassa o limite é rejeitada (seus callbacks disparam com `EvictionReason.Capacity`), e a compactação é enfileirada no pool de threads. Até que ela rode, outras inserções que não couberem também são rejeitadas. As entradas expiradas são removidas primeiro, então um cache cheio de entradas obsoletas é recuperado antes de qualquer entrada viva ser despejada.

**Testar a expiração com `FakeTimeProvider` não se encaixa diretamente.** `MemoryCacheOptions.Clock` é um `ISystemClock` (de `Microsoft.Extensions.Internal`), não um `TimeProvider`. Um adaptador de cinco linhas como o `ManualClock` acima, ou um que envolva `FakeTimeProvider.GetUtcNow()`, é a ponte; [testar código dependente de tempo com TimeProvider e FakeTimeProvider](/pt-br/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/) cobre o resto desse conjunto de ferramentas. Lembre-se de que a varredura e os callbacks ainda rodam no pool de threads real, então os testes precisam de uma pequena espera ou de um sinal, como a sonda faz.

**O HybridCache não muda nada disso para o L1.** O nível em processo padrão do `HybridCache` é construído sobre o `IMemoryCache`, então entradas expiradas do L1 seguem exatamente o mesmo ciclo de vida. Se você está escolhendo entre as APIs, a [comparação entre HybridCache, IMemoryCache e IDistributedCache](/pt-br/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/) explica quais controles de despejo cada uma expõe.

## Relacionados

- [HybridCache vs IMemoryCache vs IDistributedCache no .NET 11](/pt-br/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/)
- [.NET 11 adiciona métricas do OpenTelemetry ao MemoryCache](/pt-br/2026/06/dotnet-11-memorycache-opentelemetry-metrics/)
- [Como usar o HybridCache no ASP.NET Core 11 com Redis como cache L2](/pt-br/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/)
- [Como diagnosticar um vazamento de memória gerenciada com dotnet-gcdump e dotnet-dump](/pt-br/2026/07/how-to-diagnose-a-managed-memory-leak-with-dotnet-gcdump-and-dotnet-dump/)
- [Como testar código dependente de tempo com TimeProvider e FakeTimeProvider no .NET 11](/pt-br/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/)

## Fontes

- [`MemoryCache.cs` no dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Caching.Memory/src/MemoryCache.cs) (`PostProcessTryGetValue`, `StartScanForExpiredItemsIfNeeded`, `ScanForExpiredItems`, `Compact`)
- [`CacheEntry.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Caching.Memory/src/CacheEntry.cs) e [`CacheEntry.CacheEntryTokens.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Caching.Memory/src/CacheEntry.CacheEntryTokens.cs) (`CheckExpired`, callbacks de token, despacho de callbacks de pós-despejo)
- [`MemoryCacheOptions.ExpirationScanFrequency`](https://learn.microsoft.com/dotnet/api/microsoft.extensions.caching.memory.memorycacheoptions.expirationscanfrequency) no MS Learn
- [Caching in .NET](https://learn.microsoft.com/dotnet/core/extensions/caching) no MS Learn
- [Microsoft.Extensions.Caching.Memory no NuGet](https://www.nuget.org/packages/Microsoft.Extensions.Caching.Memory)
