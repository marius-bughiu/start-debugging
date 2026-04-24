---
title: "Como cancelar uma Task de longa duração em C# sem causar deadlock"
description: "Cancelamento cooperativo com CancellationToken, CancelAsync, Task.WaitAsync e tokens ligados no .NET 11. Mais os padrões de bloqueio que transformam um cancelamento limpo em deadlock."
pubDate: 2026-04-23
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
  - "cancellation"
lang: "pt-br"
translationOf: "2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking"
translatedBy: "claude"
translationDate: 2026-04-24
---

Você tem uma `Task` que roda por muito tempo, o usuário clica em Cancelar, e ou o app trava ou a task continua rodando até terminar sozinha. Os dois resultados apontam para o mesmo mal-entendido: no .NET, o cancelamento é cooperativo, e as peças que o fazem funcionar são `CancellationTokenSource`, `CancellationToken`, e sua disposição de de fato checar o token. Este post mostra como configurar isso de forma limpa no .NET 11 (`Microsoft.NET.Sdk` 11.0.0, C# 14), e como evitar os padrões de bloqueio que transformam um cancelamento limpo em deadlock por `Wait`. Todo exemplo compila contra o .NET 11.

## Cancelamento cooperativo, o modelo mental em um parágrafo

O .NET não tem `Task.Kill()`. O CLR não vai arrancar uma thread do meio do seu código. Quando você quer cancelar trabalho, cria um `CancellationTokenSource`, entrega o `Token` dele para cada função na cadeia de chamadas, e essas funções ou checam `token.IsCancellationRequested`, chamam `token.ThrowIfCancellationRequested()`, ou passam o token para uma API assíncrona que o respeita. Quando `cts.Cancel()` (ou `await cts.CancelAsync()`) dispara, o token vira e cada ponto de checagem reage. Nada é cancelado sem ter sido pedido para checar.

É por isso que `Task.Run(() => LongLoop())` sem um token não pode ser cancelado. O compilador não injeta cancelamento para você.

## O padrão mínimo correto

```csharp
// .NET 11, C# 14
using var cts = new CancellationTokenSource();

Task work = DoWorkAsync(cts.Token);

// Later, from a Cancel button, a timeout, whatever:
await cts.CancelAsync();

try
{
    await work;
}
catch (OperationCanceledException)
{
    // Expected when cts triggers. Not an error.
}

static async Task DoWorkAsync(CancellationToken ct)
{
    for (int i = 0; i < 1_000_000; i++)
    {
        ct.ThrowIfCancellationRequested();
        await Task.Delay(10, ct); // async APIs should take the token
    }
}
```

Três regras estão trabalhando aqui:

1. O `CancellationTokenSource` é descartado (`using var`) para que seu timer interno e wait handle sejam liberados.
2. Cada nível da cadeia de chamadas aceita um `CancellationToken` e o checa ou repassa.
3. O chamador faz `await` na task e captura `OperationCanceledException`. O cancelamento vem à tona como exceção para que a limpeza em blocos `finally` continue executando.

## Loops CPU-bound: ThrowIfCancellationRequested

Para trabalho CPU-bound, salpique `ct.ThrowIfCancellationRequested()` em uma taxa que torne a responsividade aceitável sem transformar a checagem no caminho quente. A checagem é barata (`Volatile.Read` em um `int`), mas dentro de um loop interno apertado processando dezenas de milhões de itens ela ainda aparece no profile. Um bom default é uma vez por iteração externa do loop que faz "uma unidade de trabalho".

```csharp
// .NET 11, C# 14
static long SumPrimes(int max, CancellationToken ct)
{
    long sum = 0;
    for (int n = 2; n <= max; n++)
    {
        if ((n & 0xFFFF) == 0) ct.ThrowIfCancellationRequested(); // every 65536 iterations
        if (IsPrime(n)) sum += n;
    }
    return sum;
}
```

Quando o trabalho vive em uma thread de fundo iniciada com `Task.Run`, passe o token também para o próprio `Task.Run`:

```csharp
var task = Task.Run(() => SumPrimes(10_000_000, cts.Token), cts.Token);
```

Passar o token para `Task.Run` significa que, se o token for cancelado **antes** do delegate começar a rodar, a task transiciona direto para `Canceled` sem executar. Sem ele, o delegate roda até o fim e só a checagem interna o pararia.

## Trabalho I/O-bound: repasse o token para cada API assíncrona

Toda API moderna de I/O do .NET aceita um `CancellationToken`. `HttpClient.GetAsync`, `Stream.ReadAsync`, `DbCommand.ExecuteReaderAsync`, `SqlConnection.OpenAsync`, `File.ReadAllTextAsync`, `Channel.Reader.ReadAsync`. Se você não descer o token, o cancelamento para na sua camada e o I/O subjacente continua até o SO ou o lado remoto desistirem.

```csharp
// .NET 11, C# 14
static async Task<string> FetchWithTimeoutAsync(string url, TimeSpan timeout, CancellationToken outer)
{
    using var http = new HttpClient();
    using var linked = CancellationTokenSource.CreateLinkedTokenSource(outer);
    linked.CancelAfter(timeout);

    using HttpResponseMessage resp = await http.GetAsync(url, linked.Token);
    resp.EnsureSuccessStatusCode();
    return await resp.Content.ReadAsStringAsync(linked.Token);
}
```

Dois pontos vale destacar nesse trecho. `CreateLinkedTokenSource` combina "o chamador quer cancelar" com "desistimos após `timeout`" em um único token. E `CancelAfter` é a forma correta de expressar um timeout, não `Task.Delay` competindo com o trabalho, porque usa uma única entrada na fila do timer em vez de alocar uma `Task` inteira.

## As armadilhas de deadlock, em ordem de frequência

### Armadilha 1: bloquear em um método async a partir de um contexto que captura

```csharp
// BAD on WinForms, WPF, or any SynchronizationContext that runs on one thread
string html = FetchAsync(url).Result;
```

`FetchAsync` faz `await` por dentro, o que posta a continuação de volta no `SynchronizationContext` capturado. Esse contexto é a thread de UI. A thread de UI está bloqueada no `.Result`. A continuação não pode rodar. Deadlock. Cancelamento não ajuda aqui, porque a task nunca vai completar.

A correção não é `ConfigureAwait(false)` no seu código. A correção é não bloquear, primeiro de tudo. Torne o chamador async:

```csharp
string html = await FetchAsync(url);
```

Se você absolutamente não pode fazer `await` (por exemplo, em um construtor), use `Task.Run` para sair do contexto capturado antes. Isso é uma rendição, não uma solução.

### Armadilha 2: ConfigureAwait(false) só no await externo

Um autor de biblioteca envolve uma chamada em `ConfigureAwait(false)`, vê o deadlock desaparecer no teste unitário, e publica. Aí um chamador envolve tudo em `.Result` e o deadlock volta, porque um `await` interno em um callee capturou o contexto sim.

`ConfigureAwait(false)` é uma configuração por `await`. Ou todo `await` em todo método de biblioteca usa, ou nenhum. O mundo das anotações `Nullable` tem vida fácil; esse aqui não. No .NET 11 com C# 14, você pode ligar o analyzer `CA2007` para forçar `ConfigureAwait(false)` em bibliotecas, e usar `ConfigureAwaitOptions.SuppressThrowing` quando quiser aguardar uma task só pela finalização sem se importar com a exceção dela.

### Armadilha 3: CancellationTokenSource.Cancel() chamado de um callback registrado no mesmo token

`CancellationTokenSource.Cancel()` executa os callbacks registrados **de forma síncrona** na thread chamadora por padrão. Se um desses callbacks chamar `Cancel()` na mesma fonte, ou bloquear em um lock que outro callback segura, você tem um deadlock recursivo ou reentrante. No .NET 11, prefira `await cts.CancelAsync()` quando estiver segurando qualquer lock, quando estiver em um `SynchronizationContext`, ou quando os callbacks forem não-triviais. `CancelAsync` despacha os callbacks de forma assíncrona, então `Cancel` retorna para você primeiro.

```csharp
// .NET 11, C# 14
lock (_state)
{
    _state.MarkStopping();
}
await _cts.CancelAsync(); // callbacks fire after we are out of the lock
```

### Armadilha 4: uma task que ignora o próprio token

A causa mais comum de "o cancelamento não faz nada" não é deadlock, é uma task que nunca checa. Corrija na fonte:

```csharp
static async Task BadAsync(CancellationToken ct)
{
    await Task.Delay(5000); // no token, so unaffected by cancel
}

static async Task GoodAsync(CancellationToken ct)
{
    await Task.Delay(5000, ct); // throws OperationCanceledException on cancel
}
```

Se você não pode modificar o callee (código de terceiros sem parâmetro de token), `Task.WaitAsync(CancellationToken)` do .NET 6+ dá uma saída: a espera se torna cancelável mesmo que o trabalho subjacente não seja.

```csharp
// .NET 11, C# 14
Task<string> hardcoded = LegacyFetchThatIgnoresTokensAsync();
string result = await hardcoded.WaitAsync(ct); // returns immediately on cancel; the underlying work keeps running
```

Seja honesto sobre o que isso faz: desbloqueia você, não para o trabalho. No .NET 11 o `HttpClient`, o handle de arquivo ou o que quer que o código legacy esteja fazendo continua até terminar, e o resultado é descartado. Para um loop de longa duração que segura recursos exclusivos, isso é vazamento, não cancelamento.

## Tokens ligados: cancel do chamador + timeout + shutdown

Um endpoint de servidor realista quer cancelar por três razões: o chamador se desconectou, o timeout por request estourou, ou o host está encerrando. `CreateLinkedTokenSource` compõe todos eles.

```csharp
// .NET 11, C# 14 - ASP.NET Core 11 minimal API
app.MapGet("/report", async (HttpContext ctx, IHostApplicationLifetime life, CancellationToken requestCt) =>
{
    using var linked = CancellationTokenSource.CreateLinkedTokenSource(requestCt, life.ApplicationStopping);
    linked.CancelAfter(TimeSpan.FromSeconds(30));

    string report = await BuildReportAsync(linked.Token);
    return Results.Text(report);
});
```

O ASP.NET Core já dá `HttpContext.RequestAborted` (exposto como o parâmetro `CancellationToken` quando você o aceita). Ligue-o com `IHostApplicationLifetime.ApplicationStopping` para que um shutdown gracioso também cancele o trabalho em andamento, e adicione um timeout por endpoint em cima. Se qualquer um dos três disparar, `linked.Token` vira.

## OperationCanceledException vs TaskCanceledException

Ambas existem. `TaskCanceledException` herda de `OperationCanceledException`. Capture `OperationCanceledException` a menos que você precise especificamente distinguir "a task foi cancelada" de "o chamador cancelou uma operação diferente". Na prática, capture sempre a classe base.

Um ponto sutil: quando você faz `await` em uma task que foi cancelada, a exceção que volta pode não carregar o token original. Se precisa saber qual token disparou, cheque `ex.CancellationToken == ct` em vez de inspecionar qual token você passou para qual API.

## Descarte seu CancellationTokenSource, sobretudo quando usar CancelAfter

`CancellationTokenSource.CancelAfter` agenda trabalho no timer interno. Esquecer de descartar o CTS mantém essa entrada do timer viva até o GC alcançá-la, o que em um servidor ocupado é vazamento de memória e timer que não derruba nada mas aparece como crescimento lento no `dotnet-counters`. Use `using var cts = ...;` ou `using (var cts = ...) { ... }` sempre.

Se você quer passar o CTS para um dono em background, garanta que exatamente um ponto é responsável por descartá-lo, e só descarte depois que todos que seguram o token dele tenham soltado.

## Background services: stoppingToken é seu amigo

Em um `BackgroundService`, `ExecuteAsync` recebe um `CancellationToken stoppingToken` que vira quando o host começa o shutdown. Use-o como raiz de toda cadeia de cancelamento dentro do serviço. Não crie CTS novos desconectados do shutdown, ou um `Ctrl+C` gracioso vai dar timeout e o host vai derrubar o processo no braço.

```csharp
// .NET 11, C# 14
public sealed class Crawler(IHttpClientFactory http, ILogger<Crawler> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                using var perItem = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
                perItem.CancelAfter(TimeSpan.FromSeconds(10));

                await CrawlNextAsync(http.CreateClient(), perItem.Token);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break; // host is stopping; exit cleanly
            }
            catch (OperationCanceledException)
            {
                log.LogWarning("Per-item timeout elapsed, continuing.");
            }
        }
    }
}
```

O `catch` com filtro `when` distingue "estamos encerrando" de "demos timeout em uma única unidade de trabalho". Shutdown quebra o loop externo. Um timeout por item loga e segue.

## E quanto a Thread.Abort, Task.Dispose, ou um kill na marra?

`Thread.Abort` não é suportado no .NET Core e lança `PlatformNotSupportedException` no .NET 11. `Task.Dispose` existe mas não é o que você pensa, só libera um `WaitHandle`, não cancela a task. Não existe API "mata essa task" por design. A válvula de escape mais próxima é rodar trabalho realmente não-cancelável em um processo separado (`Process.Start` + `Process.Kill`) e conviver com o overhead entre processos. Para todo o resto, cancelamento cooperativo é a API.

## Juntando tudo

Um botão de cancelar que funciona é, nove em cada dez vezes, resultado de três pequenos hábitos: todo método async recebe um `CancellationToken` e o repassa, todo loop longo chama `ThrowIfCancellationRequested` em cadência razoável, e nada em nenhum ponto da cadeia bloqueia em `.Result` ou `.Wait()`. Adicione `using` no seu CTS, `CancelAfter` para timeouts, `await CancelAsync()` dentro de locks, e `WaitAsync` como saída para código que você não pode mudar.

## Leituras relacionadas

- [Streaming de linhas do banco com IAsyncEnumerable](/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/), que se apoia fortemente na mesma encanação de tokens.
- [Stack traces async mais limpos no runtime do .NET 11](/2026/04/dotnet-11-runtime-async-cleaner-stack-traces/), útil quando um `OperationCanceledException` aparece lá no fundo de um pipeline.
- [Como retornar múltiplos valores de um método em C# 14](/pt-br/2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14/) combina bem com métodos async que querem retornar "resultado ou motivo do cancelamento".
- [O fim de `lock (object)` no .NET 9](/2026/01/net-9-the-end-of-lockobject/) para o contexto mais amplo de threading em que seu código de cancelamento roda.

## Links de fonte

- [Task Cancellation](https://learn.microsoft.com/en-us/dotnet/standard/parallel-programming/task-cancellation), MS Learn.
- [Cancellation in Managed Threads](https://learn.microsoft.com/en-us/dotnet/standard/threading/cancellation-in-managed-threads), MS Learn.
- [Coalesce cancellation tokens from timeouts](https://learn.microsoft.com/en-us/dotnet/standard/asynchronous-programming-patterns/coalesce-cancellation-tokens-from-timeouts), MS Learn.
- [`CancellationTokenSource.CancelAsync`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.cancellationtokensource.cancelasync), referência de API.
- [`Task.WaitAsync(CancellationToken)`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.task.waitasync), referência de API.
