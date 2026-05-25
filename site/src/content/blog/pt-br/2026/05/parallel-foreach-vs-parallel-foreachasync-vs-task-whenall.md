---
title: "Parallel.ForEach vs Parallel.ForEachAsync vs Task.WhenAll em C#"
description: "Use Parallel.ForEach para trabalho intensivo de CPU sobre dados em memória, Parallel.ForEachAsync para E/S assíncrona sobre muitos itens com um limite de concorrência, e Task.WhenAll para um fan-out fixo e pequeno em que você quer todas as operações em andamento e precisa dos resultados."
pubDate: 2026-05-25
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "async"
  - "performance"
lang: "pt-br"
translationOf: "2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall"
translatedBy: "claude"
translationDate: 2026-05-25
---

Use `Parallel.ForEach` quando o trabalho for intensivo de CPU e os dados já estiverem em memória: gerar hash de 100.000 arquivos, transformar um array grande, qualquer coisa que sature os núcleos. Use `Parallel.ForEachAsync` quando cada item dispara E/S assíncrona (uma chamada HTTP, uma consulta a banco de dados) e você quer um número limitado dessas operações em andamento de cada vez. Use `Task.WhenAll` quando você tem um conjunto pequeno e fixo de operações assíncronas que quer iniciar todas de uma vez e das quais precisa coletar resultados. O único erro que decide por você: nunca faça E/S assíncrona dentro de `Parallel.ForEach`, porque bloquear com `.Result` ou `.Wait()` dentro do seu corpo síncrono mata de fome o pool de threads.

Este artigo tem como alvo .NET 11 e C# 14. `Parallel.ForEach` existe desde o .NET Framework 4.0 (2010); `Task.WhenAll` desde o .NET Framework 4.5; e `Parallel.ForEachAsync` é o recém-chegado, adicionado no .NET 6 (2021). O comportamento descrito aqui é estável do .NET 6 ao .NET 11.

## Estes três resolvem problemas diferentes

A comparação é estranha porque os três não são APIs intercambiáveis com desempenho diferente. São respostas a três perguntas diferentes.

`Parallel.ForEach` pergunta: "Tenho uma coleção e uma operação síncrona, intensiva de CPU, por elemento. Distribua entre os núcleos." Seu corpo é um `Action<T>`. Ele particiona a fonte, executa o corpo em várias threads do pool de threads, e bloqueia a thread chamadora até cada elemento terminar. É o cavalo de batalha de paralelismo de dados da Task Parallel Library.

`Parallel.ForEachAsync` pergunta: "Tenho uma coleção e uma operação assíncrona por elemento. Execute-as de forma concorrente, mas limite quantas rodam de cada vez." Seu corpo é um `Func<TSource, CancellationToken, ValueTask>`. Ele devolve uma `Task` que você aguarda; não bloqueia. O crucial: ele limita. Por padrão executa no máximo `Environment.ProcessorCount` operações em paralelo, e você pode defini-lo explicitamente com `ParallelOptions.MaxDegreeOfParallelism`.

`Task.WhenAll` pergunta: "Já tenho um monte de tarefas. Me avise quando todas terminarem." Ele não inicia nada, não limita nada, e não itera uma fonte. Você cria as tarefas (o que as inicia), entrega a coleção ao `WhenAll`, e aguarda a única tarefa que ele devolve. Se você iniciar 5.000 tarefas, todas as 5.000 estão em andamento no momento em que você aguarda.

Então a decisão real é sobre o formato do seu trabalho, não sobre velocidade bruta: intensivo de CPU sobre dados (`Parallel.ForEach`), E/S assíncrona sobre muitos itens com um teto (`Parallel.ForEachAsync`), ou um punhado conhecido de operações assíncronas que você quer todas de uma vez e cujos resultados você precisa (`Task.WhenAll`).

## A matriz de decisão

O comportamento a seguir é para .NET 6+ salvo indicação; `Parallel.ForEachAsync` não existe antes do .NET 6.

| Capacidade                          | `Parallel.ForEach`            | `Parallel.ForEachAsync`                       | `Task.WhenAll`                       |
| ----------------------------------- | ----------------------------- | --------------------------------------------- | ------------------------------------ |
| Melhor para                         | trabalho intensivo de CPU     | E/S assíncrona por item                       | um conjunto fixo de operações async  |
| Delegate do corpo                   | `Action<T>` (síncrono)        | `Func<T, CancellationToken, ValueTask>`       | você cria as tarefas                 |
| Bloqueia a thread chamadora         | sim                           | não (devolve `Task`)                          | não (devolve `Task`)                 |
| Limite de concorrência embutido     | sim (`MaxDegreeOfParallelism`)| sim (`MaxDegreeOfParallelism`)                | não -- todas as tarefas de uma vez   |
| Grau de paralelismo padrão          | gerenciado pelo escalonador (`-1`) | `Environment.ProcessorCount`             | sem limite                           |
| Devolve resultados                  | não                           | não (devolve `Task`, não `Task<T[]>`)         | sim (`Task<TResult[]>`, ordenados)   |
| Aceita `IAsyncEnumerable<T>`        | não                           | sim                                           | n/a                                  |
| Cancelamento                        | `ParallelOptions`             | `ParallelOptions` + token passado ao corpo    | cancele você as tarefas subjacentes  |
| Na primeira exceção                 | para de lançar iterações      | cancela o token, para de agendar novos itens  | deixa cada tarefa rodar até o fim    |
| Superfície de exceções              | `AggregateException`          | `AggregateException` (await desembrulha para a primeira) | `AggregateException` (await desembrulha) |
| Primeira versão                     | .NET Framework 4.0            | .NET 6                                         | .NET Framework 4.5                   |

As linhas que decidem a maioria dos casos reais são "delegate do corpo" e "limite de concorrência embutido". Se o seu trabalho por item for `async`, `Parallel.ForEach` já está errado. Se você precisa limitar a concorrência, `Task.WhenAll` já está errado.

## Quando escolher Parallel.ForEach

Recorra a `Parallel.ForEach` quando o trabalho por item for síncrono e intensivo de CPU, e a coleção já estiver materializada em memória.

- **Transformar um array ou lista grande em memória.** Redimensionar 50.000 imagens, calcular checksums, fazer parse de linhas. O trabalho mantém um núcleo ocupado, e particionar a fonte entre núcleos é exatamente para o que `Parallel.ForEach` foi feito. Defina `MaxDegreeOfParallelism` se quiser deixar folga para outro trabalho.
- **Processamento numérico vergonhosamente paralelo.** Uma simulação de Monte Carlo, um filtro por pixel, um lote de operações de matriz independentes. Sem estado compartilhado, sem E/S, só CPU.
- **Você quer que a thread chamadora espere.** `Parallel.ForEach` é síncrono por design. Em uma ferramenta de console ou um job em segundo plano onde bloquear é aceitável, essa simplicidade é uma vantagem.

```csharp
// .NET 11, C# 14 -- CPU-bound work over an in-memory array.
// Parallel.ForEach partitions across cores and blocks until done.
var files = Directory.GetFiles(@"C:\data", "*.bin");
var hashes = new ConcurrentDictionary<string, string>();

Parallel.ForEach(
    files,
    new ParallelOptions { MaxDegreeOfParallelism = Environment.ProcessorCount },
    file =>
    {
        using var stream = File.OpenRead(file);
        byte[] hash = SHA256.HashData(stream);   // CPU + sync I/O, no await
        hashes[file] = Convert.ToHexString(hash);
    });
```

A regra dura: se o corpo quer `await` de algo, não recorra a `Parallel.ForEach`. As pessoas contornam o `Action<T>` síncrono escrevendo `SomeAsyncCall().Result` ou `.GetAwaiter().GetResult()` dentro do corpo. Isso bloqueia uma thread do pool durante toda a duração da E/S, e como `Parallel.ForEach` já está consumindo threads do pool para executar iterações, você pode causar um deadlock ou matar de fome o pool sob carga. Esse antipadrão é a razão mais comum pela qual `Parallel.ForEachAsync` existe.

## Quando escolher Parallel.ForEachAsync

`Parallel.ForEachAsync` é a resposta para "tenho muitos itens e cada um chama algo assíncrono, e não quero abrir dez mil conexões de uma vez".

- **Chamar uma API HTTP para cada um de muitos itens.** Enriquecer 8.000 registros a partir de um endpoint REST, onde disparar as 8.000 requisições simultaneamente o limitaria por taxa ou esgotaria os sockets. Defina `MaxDegreeOfParallelism = 20` e ele mantém 20 requisições em andamento, iniciando a próxima conforme cada uma termina.
- **Trabalho por item contra banco de dados ou fila com um teto.** Um pool de conexões tem tamanho finito. `Parallel.ForEachAsync` permite alinhar o grau de paralelismo ao pool para não bloquear esperando por conexões.
- **Uma fonte em streaming.** Ele aceita `IAsyncEnumerable<T>`, então você pode processar itens conforme eles chegam de uma API paginada ou de um canal sem bufferizar a sequência inteira primeiro.

```csharp
// .NET 11, C# 14 -- async I/O per item, capped at 20 concurrent calls.
var ids = await db.Products.Select(p => p.Id).ToListAsync(ct);
var client = httpClientFactory.CreateClient("pricing");

await Parallel.ForEachAsync(
    ids,
    new ParallelOptions
    {
        MaxDegreeOfParallelism = 20,
        CancellationToken = ct
    },
    async (id, token) =>
    {
        var price = await client.GetFromJsonAsync<Price>($"/price/{id}", token);
        await SavePriceAsync(id, price, token);   // never blocks a pool thread
    });
```

Dois detalhes que importam. Primeiro, o corpo recebe um `CancellationToken` como segundo parâmetro: passe-o para cada chamada assíncrona dentro, não o `ct` externo, porque `Parallel.ForEachAsync` cancela esse token interno quando uma iteração falha para que o restante possa abortar cedo. Segundo, o `MaxDegreeOfParallelism` padrão é `Environment.ProcessorCount`, que é ajustado para trabalho de CPU, não de E/S. Para chamadas com E/S você quase sempre quer defini-lo mais alto que a contagem de núcleos, porque as threads ficam a maior parte do tempo esperando a rede, não calculando. Se você precisa de controle mais fino que um único limite inteiro, um [portão baseado em SemaphoreSlim](/pt-br/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/) combinado com `Task.WhenAll` dá o mesmo limite com mais espaço para variar o teto por chamada.

## Quando escolher Task.WhenAll

`Task.WhenAll` é para um conjunto conhecido, geralmente pequeno, de operações assíncronas que você quer executar de forma concorrente e cujos resultados você precisa de volta.

- **Um fan-out fixo.** Carregar o perfil de um usuário, seus pedidos e suas notificações em paralelo: três awaits independentes que deveriam se sobrepor. Inicie os três, `await Task.WhenAll`, pronto. Este é o uso do dia a dia e é o correto.
- **Você precisa dos resultados, em ordem.** A sobrecarga genérica devolve `Task<TResult[]>`, e o array preserva a ordem de entrada independentemente da ordem de conclusão. `Parallel.ForEachAsync` devolve uma `Task` simples sem resultados, então se você precisa de um resultado por item, `WhenAll` (ou coletar em uma estrutura segura para threads) é o caminho.
- **A contagem é limitada e pequena.** Uma dúzia de chamadas, não dez mil. Como `WhenAll` não faz nenhum limite, o número de operações concorrentes é igual ao número de tarefas que você iniciou.

```csharp
// .NET 11, C# 14 -- a small, fixed fan-out; results returned in order.
Task<Profile> profile = LoadProfileAsync(userId, ct);
Task<Order[]> orders = LoadOrdersAsync(userId, ct);
Task<Alert[]> alerts = LoadAlertsAsync(userId, ct);

await Task.WhenAll(profile, orders, alerts);

// Each task is complete here; .Result no longer blocks.
var dashboard = new Dashboard(profile.Result, orders.Result, alerts.Result);
```

A armadilha com `Task.WhenAll` é usá-lo para uma lista não limitada. `Task.WhenAll(ids.Select(id => CallApiAsync(id)))` sobre 10.000 ids inicia as 10.000 chamadas no instante em que o LINQ é enumerado, porque `Select` materializa as tarefas e cada tarefa inicia ao ser criada. Isso é um ataque de negação de serviço contra o seu próprio serviço a jusante. No momento em que a lista é grande ou não limitada, você quer `Parallel.ForEachAsync` (ou um portão `SemaphoreSlim`) em vez disso.

## O benchmark: 500 chamadas de E/S simuladas

A velocidade bruta é um eixo enganoso aqui, porque a opção mais rápida costuma ser a mais perigosa. A comparação honesta é velocidade contra concorrência máxima. Cada "item" abaixo aguarda `Task.Delay(20)` para representar uma chamada de rede de 20 ms, executado sobre 500 itens.

```csharp
// .NET 11, C# 14, BenchmarkDotNet 0.14.x, dotnet run -c Release
// Each item simulates a 20 ms I/O call.
[MemoryDiagnoser]
public class FanOutBench
{
    private readonly int[] _items = Enumerable.Range(0, 500).ToArray();
    private static Task IoAsync(CancellationToken ct = default) => Task.Delay(20, ct);

    [Benchmark]
    public Task WhenAll_Unbounded() =>
        Task.WhenAll(_items.Select(_ => IoAsync()));

    [Benchmark]
    public Task ForEachAsync_DefaultDop() =>
        Parallel.ForEachAsync(_items, async (_, ct) => await IoAsync(ct));

    [Benchmark]
    public Task ForEachAsync_Dop50() =>
        Parallel.ForEachAsync(
            _items,
            new ParallelOptions { MaxDegreeOfParallelism = 50 },
            async (_, ct) => await IoAsync(ct));
}
```

Resultados representativos em um Ryzen 7 de 16 núcleos / Windows 11 / .NET 11, com a coluna de concorrência máxima adicionada manualmente a partir da configuração:

| Método                     | Média   | Ops concorrentes de pico | Notas                              |
| -------------------------- | ------- | ------------------------ | ---------------------------------- |
| `WhenAll_Unbounded`        | ~24 ms  | 500                      | a mais rápida, mas 500 conexões abertas |
| `ForEachAsync_Dop50`       | ~210 ms | 50                       | 10 lotes de 50                     |
| `ForEachAsync_DefaultDop`  | ~640 ms | 16 (`ProcessorCount`)    | o teto padrão é a contagem de CPU, baixo para E/S |

`WhenAll` é cerca de 25x mais rápido que o `ForEachAsync` padrão aqui, e esse é exatamente o ponto: ele consegue essa velocidade abrindo 500 conexões de uma vez. Se o seu sistema a jusante aguenta, ótimo. Se for uma API de terceiros com limite de taxa, a execução "lenta" e limitada é a que não te rende um 429 ou um `SocketException`. O `Parallel.ForEachAsync` padrão é o mais lento porque seu grau de paralelismo padrão é `Environment.ProcessorCount`, ajustado para trabalho de CPU; para E/S você o sobe deliberadamente, como mostra `Dop50`. A conclusão não é "WhenAll vence", é "escolha a concorrência que você pode pagar, depois escolha a API que a imponha".

## As armadilhas que decidem por você

Algumas restrições anulam a preferência por completo.

**Corpo assíncrono significa que não é `Parallel.ForEach`.** Seu corpo é `Action<T>`. Não há sobrecarga assíncrona. Bloquear dentro com `.Result` ou `.GetAwaiter().GetResult()` amarra uma thread do pool por iteração e convida à inanição. Se o trabalho aguarda com await, você está em `Parallel.ForEachAsync` ou `Task.WhenAll`. Veja [async void vs async Task](/pt-br/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) para entender por que uma lambda `async` silenciosamente vira `async void` quando atribuída a `Action<T>`, o que engole exceções e derrota o loop por completo.

**Lista não limitada significa que não é `Task.WhenAll`.** `WhenAll` não tem limite. Sobre um número grande ou desconhecido de itens ele inicia tudo de uma vez. Se você não pode garantir que a contagem é pequena, use `Parallel.ForEachAsync` com um `MaxDegreeOfParallelism`.

**Múltiplas falhas se manifestam de forma diferente.** Os três coletam exceções em uma `AggregateException`, mas como você as observa difere. `Parallel.ForEach` (síncrono) lança a `AggregateException` diretamente, então um `catch (AggregateException ae)` vê cada exceção interna. Com `Parallel.ForEachAsync` e `Task.WhenAll` você faz `await`, e `await` desembrulha apenas a *primeira* exceção; para ver todas, inspecione a propriedade `.Exception` da tarefa que falhou. A diferença mais profunda é o tempo: `Task.WhenAll` deixa cada tarefa rodar até o fim mesmo depois de uma falhar, então você obtém falhas de todas elas, enquanto `Parallel.ForEachAsync` cancela seu token interno na primeira falha e para de agendar novas iterações, então faz curto-circuito. Se "tentar tudo, reportar todas as falhas" for o requisito, isso aponta para `WhenAll`; se for "parar assim que uma falhar", isso aponta para `ForEachAsync`.

**Anterior ao .NET 6 significa sem `Parallel.ForEachAsync`.** Se você está preso no .NET Framework ou no .NET Core 3.1, a API não existe. O substituto idiomático é um portão `SemaphoreSlim` em volta de `Task.WhenAll`, ou para um formato produtor/consumidor, [um Channel em vez de BlockingCollection](/pt-br/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/).

Mais uma nota transversal: quando qualquer um destes executa trabalho assíncrono, o cancelamento deveria fluir. `Parallel.ForEachAsync` entrega ao seu corpo um token; `Task.WhenAll` só cancela se as tarefas que você criou honram um token. Conectar isso corretamente é um tema à parte, coberto em [como cancelar uma Task de longa execução sem deadlocks](/pt-br/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/).

## A recomendação, repetida

Decida pelo formato do trabalho. Intensivo de CPU sobre uma coleção em memória: `Parallel.ForEach`, com `MaxDegreeOfParallelism` se quiser deixar núcleos livres. E/S assíncrona sobre muitos itens onde você precisa limitar a concorrência: `Parallel.ForEachAsync`, e lembre de subir `MaxDegreeOfParallelism` acima da contagem de núcleos para E/S e de passar o token do corpo para cada chamada interna. Um fan-out pequeno e fixo onde você quer tudo em andamento e precisa dos resultados: `Task.WhenAll`, mas nunca sobre uma lista não limitada. A versão mais curta e correta: CPU e dados é `Parallel.ForEach`; E/S assíncrona em escala é `Parallel.ForEachAsync`; um punhado conhecido de awaits é `Task.WhenAll`.

## Relacionados

- [Task.Run vs Task.Factory.StartNew vs ThreadPool.QueueUserWorkItem](/pt-br/2026/05/task-run-vs-task-factory-startnew-vs-threadpool-queueuserworkitem/) cobre as primitivas de mais baixo nível sobre as quais essas APIs de mais alto nível são construídas.
- [async void vs async Task em C#: quando cada um está correto](/pt-br/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) explica a armadilha do `async void` que morde quando você passa uma lambda assíncrona para `Parallel.ForEach`.
- [Como cancelar uma Task de longa execução em C# sem deadlocks](/pt-br/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) é a metade de cancelamento dos três.
- [lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock](/pt-br/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/) mostra o portão SemaphoreSlim que limita `Task.WhenAll` quando você precisa de mais controle do que `Parallel.ForEachAsync` oferece.
- [Como usar Channels em vez de BlockingCollection em C#](/pt-br/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) é a alternativa produtor/consumidor quando o trabalho é um pipeline, não um fan-out plano.

## Fontes

- [Referência do método Parallel.ForEachAsync (MS Learn)](https://learn.microsoft.com/dotnet/api/system.threading.tasks.parallel.foreachasync)
- [Referência do método Task.WhenAll (MS Learn)](https://learn.microsoft.com/dotnet/api/system.threading.tasks.task.whenall)
- [Referência do método Parallel.ForEach (MS Learn)](https://learn.microsoft.com/dotnet/api/system.threading.tasks.parallel.foreach)
- [ParallelOptions.MaxDegreeOfParallelism (MS Learn)](https://learn.microsoft.com/dotnet/api/system.threading.tasks.paralleloptions.maxdegreeofparallelism)
- [Parallel.ForEachAsync and Exceptions (Jeremy Bytes)](https://jeremybytes.blogspot.com/2024/02/parallelforeachasync-and-exceptions.html)
