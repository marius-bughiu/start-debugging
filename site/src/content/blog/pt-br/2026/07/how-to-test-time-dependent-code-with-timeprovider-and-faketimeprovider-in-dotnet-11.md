---
title: "Como testar código dependente de tempo com TimeProvider e FakeTimeProvider no .NET 11"
description: "Substitua DateTime.UtcNow, Stopwatch e Task.Delay por System.TimeProvider para que os testes controlem o relógio: registro na injeção de dependência, FakeTimeProvider.Advance e SetUtcNow, testes de timeouts e de um BackgroundService baseado em PeriodicTimer, além das armadilhas do Advance com continuações e do xUnit v2."
pubDate: 2026-07-26
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "testing"
  - "async"
  - "timeprovider"
lang: "pt-br"
translationOf: "2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-07-26
---

Para testar código dependente de tempo no .NET 11, pare de chamar `DateTime.UtcNow`, `Stopwatch` e `Task.Delay(...)` diretamente e receba um `System.TimeProvider` pelo construtor. Em produção você registra `TimeProvider.System` como singleton; nos testes você passa um `FakeTimeProvider` do pacote `Microsoft.Extensions.TimeProvider.Testing` e controla o relógio você mesmo com `Advance(TimeSpan)` e `SetUtcNow(DateTimeOffset)`. Uma verificação de expiração de período de teste que antes exigia esperar 14 dias vira um teste de duas linhas. Este artigo cobre o padrão inteiro no .NET 11 (Preview 6 no momento em que este texto foi escrito, versão final em novembro de 2026) com C# 14 e `Microsoft.Extensions.TimeProvider.Testing` 10.8.0, incluindo as partes que doem: avançar vários períodos de timer de uma só vez, continuações que não executam depois do `Advance` e o travamento causado pelo contexto de sincronização do xUnit v2.

O `TimeProvider` veio embutido no .NET 8 (`System.Runtime.dll`), então tudo aqui também roda sem alterações no .NET 8, 9 e 10. Para .NET Framework 4.6.2+, .NET 5-7 e netstandard2.0 existe o pacote `Microsoft.Bcl.TimeProvider`, com uma diferença de API coberta no final.

## Por que um relógio estático torna um teste impossível de executar

Este é o código que toda base de código tem em algum lugar:

```csharp
// .NET 11, C# 14 -- untestable
public sealed class TrialService
{
    private static readonly TimeSpan TrialLength = TimeSpan.FromDays(14);

    public bool IsTrialExpired(User user) =>
        DateTimeOffset.UtcNow - user.SignedUpAt >= TrialLength;
}
```

`DateTimeOffset.UtcNow` é uma propriedade estática sustentada pelo relógio do sistema operacional. Não existe ponto de extensão. Para exercitar o ramo de expiração você tem três opções ruins: esperar duas semanas, retroceder o `user.SignedUpAt` (o que testa a subtração mas nunca o momento da transição), ou recorrer a um framework de mocking que faz patch de estáticos, o que arrasta um interceptador baseado em profiler e deixa a suíte inteira mais lenta.

O limite é onde os bugs moram. O dia 14 já expirou ou ainda está ativo? O que acontece exatamente em `SignedUpAt + 14 days`? E na transição de horário de verão no fuso local do usuário? Nenhuma dessas perguntas tem resposta enquanto o relógio pertencer à máquina.

## O que o TimeProvider realmente abstrai

`TimeProvider` é uma classe abstrata com cinco capacidades, e vale conhecer todas porque a maioria das pessoas adota só a primeira:

- `GetUtcNow()` e `GetLocalNow()` retornam um `DateTimeOffset`. Isso substitui `DateTimeOffset.UtcNow` e `DateTime.Now`.
- `GetTimestamp()` retorna uma contagem de ticks de alta frequência, e `GetElapsedTime(long)` / `GetElapsedTime(long, long)` transformam dois desses valores em um `TimeSpan`. Isso substitui o `Stopwatch`.
- `CreateTimer(TimerCallback, object?, TimeSpan, TimeSpan)` retorna um `ITimer`. Isso substitui o `System.Threading.Timer`.
- `LocalTimeZone` retorna um `TimeZoneInfo`. Isso substitui `TimeZoneInfo.Local`.
- `TimestampFrequency` informa a taxa de ticks por trás de `GetTimestamp()`.

A implementação padrão é a propriedade estática `TimeProvider.System`: o UTC vem de `DateTimeOffset.UtcNow`, o fuso de `TimeZoneInfo.Local`, os timestamps do `Stopwatch` e os timers do `System.Threading.Timer`. Usá-la não custa nada em relação às APIs diretas, porque é uma camada fina de encaminhamento sobre exatamente essas chamadas.

O motivo de `CreateTimer` importar é que a BCL também ligou o `TimeProvider` às primitivas assíncronas. Estas sobrecargas recebem um `TimeProvider` e roteiam o timer interno por ele:

- `Task.Delay(TimeSpan, TimeProvider)` e `Task.Delay(TimeSpan, TimeProvider, CancellationToken)`
- `Task.WaitAsync(TimeSpan, TimeProvider)` e sua sobrecarga com `CancellationToken`
- `new CancellationTokenSource(TimeSpan, TimeProvider)`
- `new PeriodicTimer(TimeSpan, TimeProvider)`

Então um laço de retentativas com backoff, um prazo de requisição e um serviço em segundo plano que faz polling são todos controláveis a partir de um teste sem um único `Thread.Sleep`.

## Passos para tornar testável uma classe dependente de tempo

1. Adicione um parâmetro `TimeProvider` ao construtor da classe que lê o relógio. Não dê a ele um valor padrão de `TimeProvider.System`, ou o caminho não testável continua alcançável por acidente.
2. Substitua dentro dessa classe cada `DateTime.UtcNow`, `DateTimeOffset.Now`, `Stopwatch.StartNew()`, `new Timer(...)` e `Task.Delay(...)` solto pelo equivalente do `TimeProvider`.
3. Registre o relógio real na raiz de composição: `builder.Services.AddSingleton(TimeProvider.System);`.
4. Adicione `Microsoft.Extensions.TimeProvider.Testing` ao projeto de testes.
5. Em cada teste, construa um `FakeTimeProvider`, fixe o instante inicial e mova o relógio com `Advance` ou `SetUtcNow` entre as asserções.

O resto do artigo expande cada um desses passos em código funcional.

## Reescrevendo o serviço para receber um relógio

```csharp
// .NET 11, C# 14
public sealed class TrialService(TimeProvider timeProvider)
{
    private static readonly TimeSpan TrialLength = TimeSpan.FromDays(14);

    public bool IsTrialExpired(User user) =>
        timeProvider.GetUtcNow() - user.SignedUpAt >= TrialLength;
}
```

Essa é toda a mudança em produção. O construtor primário captura o provedor, e a única diferença no ponto de uso é `timeProvider.GetUtcNow()` em vez de `DateTimeOffset.UtcNow`.

O registro tem uma linha, porque `TimeProvider.System` é um singleton seguro para compartilhar em toda a aplicação:

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddScoped<TrialService>();

var app = builder.Build();
```

Os próprios componentes do ASP.NET Core já procuram esse registro. Desde o .NET 8, `ISystemClock` está obsoleto em toda a pilha de autenticação e Identity, e as classes de opções expõem em seu lugar uma propriedade `TimeProvider` atribuível, que é resolvida pelo contêiner quando você registrou uma. Registrar `TimeProvider.System` portanto também torna testáveis a validação de tempo de vida de tokens e a expiração de cookies.

## O primeiro teste com FakeTimeProvider

```
dotnet add package Microsoft.Extensions.TimeProvider.Testing
```

A versão 10.8.0 é a atual em julho de 2026. Ela tem como alvo .NET 8.0 e posteriores mais .NET Framework 4.6.2 e posteriores, e não carrega dependências no .NET moderno.

```csharp
// .NET 11, C# 14, xUnit v3, Microsoft.Extensions.TimeProvider.Testing 10.8.0
using Microsoft.Extensions.Time.Testing;

public class TrialServiceTests
{
    [Fact]
    public void Trial_is_active_on_day_13_and_expired_on_day_14()
    {
        var time = new FakeTimeProvider(
            new DateTimeOffset(2026, 7, 26, 12, 0, 0, TimeSpan.Zero));

        var user = new User(SignedUpAt: time.GetUtcNow());
        var sut = new TrialService(time);

        time.Advance(TimeSpan.FromDays(13));
        Assert.False(sut.IsTrialExpired(user));

        time.Advance(TimeSpan.FromDays(1));
        Assert.True(sut.IsTrialExpired(user));
    }
}
```

Sem dormir, sem retroceder datas, e o limite do dia 14 é afirmado explicitamente. Três detalhes do `FakeTimeProvider` valem ser internalizados agora:

**O construtor sem parâmetros começa à meia-noite de 1 de janeiro de 2000 UTC.** Isso é deliberado: um instante fixo e obviamente sintético que nunca coincide por acidente com "hoje". Passe um `DateTimeOffset` ao construtor quando a data em si fizer parte do comportamento sob teste, por exemplo um 29 de fevereiro ou uma virada de fim de mês.

**`LocalTimeZone` tem como padrão `TimeZoneInfo.Utc`, não o fuso da máquina.** Então `GetLocalNow()` é igual a `GetUtcNow()` até você chamar `SetLocalTimeZone(...)`. É isso que torna determinísticos os testes sensíveis a fuso em um agente de build em outra região que a sua:

```csharp
// .NET 11, C# 14 -- pin the zone so a CI agent in UTC behaves like a user in Bucharest
var time = new FakeTimeProvider(new DateTimeOffset(2026, 10, 25, 3, 30, 0, TimeSpan.Zero));
time.SetLocalTimeZone(TimeZoneInfo.FindSystemTimeZoneById("Europe/Bucharest"));

Assert.Equal(new TimeSpan(2, 0, 0), time.GetLocalNow().Offset); // after the DST fall-back
```

**`SetUtcNow` só anda para frente.** Passar um valor anterior ao tempo atual lança `ArgumentOutOfRangeException` com a mensagem "Cannot go back in time.". Se você realmente precisa simular um operador ou um daemon NTP colocando o relógio para trás, use `AdjustTime(DateTimeOffset)`. `AdjustTime` desloca o tempo atual sem disparar nenhum timer pendente, e desloca o ponto de disparo de cada timer pendente pelo mesmo delta, que é o que uma mudança real do relógio do sistema faz.

## Testando um timeout em vez de esperar por ele

Os casos interessantes não são os timestamps, são as esperas. Uma política de retentativas com backoff exponencial normalmente leva segundos de tempo real para ser testada. Roteie a espera dela pelo provedor e ela leva microssegundos:

```csharp
// .NET 11, C# 14
public sealed class RetryingFetcher(HttpClient http, TimeProvider timeProvider)
{
    public async Task<string> FetchAsync(string url, CancellationToken ct = default)
    {
        for (int attempt = 0; ; attempt++)
        {
            try
            {
                return await http.GetStringAsync(url, ct);
            }
            catch (HttpRequestException) when (attempt < 3)
            {
                var backoff = TimeSpan.FromSeconds(Math.Pow(2, attempt));
                await Task.Delay(backoff, timeProvider, ct);
            }
        }
    }
}
```

Prazos funcionam do mesmo jeito. `new CancellationTokenSource(TimeSpan, TimeProvider)` dá a você uma fonte de tokens cujo timer interno é conduzido pelo relógio falso, então todo o padrão de `CancelAfter` para impor um prazo assíncrono passa a ser verificável:

```csharp
// .NET 11, C# 14
[Fact]
public async Task Deadline_fires_after_five_seconds()
{
    var time = new FakeTimeProvider();
    using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5), time);

    Assert.False(cts.IsCancellationRequested);

    time.Advance(TimeSpan.FromSeconds(5));

    Assert.True(cts.IsCancellationRequested);
}
```

## Testando um BackgroundService que faz polling em um timer

Um worker de polling construído sobre `PeriodicTimer` é o componente clássico do "isso a gente não testa com teste unitário". Com a sobrecarga de `TimeProvider` ele é código comum:

```csharp
// .NET 11, C# 14
public sealed class ExpiryWorker(IExpiryStore store, TimeProvider timeProvider)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(5), timeProvider);

        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            await store.PurgeExpiredAsync(timeProvider.GetUtcNow(), stoppingToken);
        }
    }
}
```

O teste tem uma sutileza: o worker precisa chegar ao `WaitForNextTickAsync` e registrar o timer dele antes de você avançar, senão você avança além de um tick que nunca foi agendado. Não resolva isso com `Thread.Sleep`. Ceda primeiro, depois avance, depois aguarde um sinal de que o trabalho realmente aconteceu:

```csharp
// .NET 11, C# 14, xUnit v3
[Fact]
public async Task Worker_purges_once_per_five_minute_tick()
{
    var time = new FakeTimeProvider();
    var store = new RecordingExpiryStore(); // sets a TaskCompletionSource on each call
    var worker = new ExpiryWorker(store, time);

    await worker.StartAsync(CancellationToken.None);
    await Task.Yield(); // let ExecuteAsync reach WaitForNextTickAsync

    time.Advance(TimeSpan.FromMinutes(5));
    await store.NextPurge; // completes when PurgeExpiredAsync is entered

    Assert.Equal(1, store.PurgeCount);

    await worker.StopAsync(CancellationToken.None);
}
```

Aguardar um sinal que o código de produção emite, em vez de aguardar tempo de relógio, é o que impede este teste de ficar instável em um agente de CI sobrecarregado. A mesma disciplina vale quando o worker sob teste usa [serviços com escopo dentro de um BackgroundService](/pt-br/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/): resolva o escopo dentro do laço e depois faça as asserções sobre o que aquele escopo produziu.

## Advance dispara timers periódicos uma vez por período decorrido

Este é o comportamento que mais surpreende. `FakeTimeProvider.Advance` percorre a lista de esperas, invoca cada callback cujo ponto de disparo já passou e, para um timer periódico, soma o período ao ponto de disparo e verifica de novo. Uma única chamada portanto dispara doze vezes um timer de cinco minutos:

```csharp
// .NET 11, C# 14 -- twelve ticks, not one
time.Advance(TimeSpan.FromHours(1)); // PeriodicTimer period = 5 minutes
```

Para o `PeriodicTimer` especificamente isso não significa doze iterações do laço, porque `WaitForNextTickAsync` funde os ticks que chegam enquanto ninguém está aguardando. Mas para um `ITimer` cru vindo de `CreateTimer` com período não infinito, você vai receber doze invocações do callback, de forma síncrona, na thread que chamou `Advance`. Se você quer exatamente um tick, avance exatamente um período.

A parte síncrona importa por um segundo motivo: qualquer exceção lançada dentro de um callback de timer se propaga para fora da sua chamada de `Advance`, e não em alguma thread de fundo onde seria engolida. Isso normalmente é um presente, mas significa que uma linha de `Advance` pode lançar uma falha de asserção originada em código várias camadas adiante.

## Continuações que não executam depois do Advance

O problema mais relatado do `FakeTimeProvider` é um teste que trava ou afirma cedo demais depois do `Advance`, registrado como [dotnet/extensions#5326](https://github.com/dotnet/extensions/issues/5326). O formato é este:

```csharp
// .NET 11, C# 14 -- flaky: the continuation may not have run yet
var delayTask = Task.Delay(TimeSpan.FromSeconds(30), time);
time.Advance(TimeSpan.FromSeconds(30));
Assert.True(delayTask.IsCompleted); // not guaranteed
```

O `Advance` completa a tarefa subjacente, mas a continuação anexada por um `await` em outro lugar fica agendada, não executada inline. A correção é aguardar aquilo que interessa em vez de consultar uma flag:

```csharp
// .NET 11, C# 14 -- deterministic
var delayTask = Task.Delay(TimeSpan.FromSeconds(30), time);
time.Advance(TimeSpan.FromSeconds(30));
await delayTask; // returns immediately, and orders the continuation
```

Você vai ver `await Task.Delay(1)` depois do `Advance` em muito código de exemplo. Funciona porque dá um turno real ao escalonador, mas reintroduz uma dependência de tempo real em um teste cujo objetivo inteiro era remover uma. Aguarde a operação em vez disso, ou aguarde um `TaskCompletionSource` que o código de produção completa.

A armadilha relacionada é o `AutoAdvanceAmount`. Defini-lo faz o relógio avançar a cada *leitura* de `GetUtcNow()` ou `GetTimestamp()`, o que é conveniente para código que mede o tempo decorrido entre duas leituras:

```csharp
// .NET 11, C# 14 -- every clock read advances by 100ms
var time = new FakeTimeProvider { AutoAdvanceAmount = TimeSpan.FromMilliseconds(100) };

long start = time.GetTimestamp();
long end = time.GetTimestamp();

Assert.Equal(TimeSpan.FromMilliseconds(100), time.GetElapsedTime(start, end));
```

Mas o avanço automático não conduz timers, porque nada lê o relógio em nome de um timer. Um `Task.Delay(TimeSpan, TimeProvider)` nunca vai completar só com avanço automático; você ainda precisa de um `Advance` explícito. Vale lembrar essa distinção antes de gastar uma tarde nela.

## O travamento pelo contexto de sincronização do xUnit v2

Se o seu projeto de testes ainda está no xUnit v2 e o código sob teste usa `ConfigureAwait(false)`, um teste com `FakeTimeProvider` pode entrar em deadlock. O xUnit v2 instala um `AsyncTestSyncContext` durante cada teste, e a interação entre esse contexto e os callbacks de timer executados inline deixa o teste parado para sempre. O README do pacote documenta a solução alternativa:

```csharp
// .NET 11, C# 14 -- xUnit v2 only
SynchronizationContext.SetSynchronizationContext(null);
```

Coloque isso no topo do teste afetado, ou no construtor do fixture. O xUnit v3 removeu o `AsyncTestSyncContext` por completo, então o problema não existe lá. Se você está escolhendo framework de testes para um projeto novo, esse é mais um pequeno argumento a favor do v3.

## O que não converter

`TimeProvider` é um ponto de extensão, não uma religião. Duas regras evitam que ele se espalhe:

Injete-o na classe que toma uma *decisão* baseada em tempo, não em toda classe que por acaso repassa um timestamp. Um DTO carregando um `CreatedAt` não precisa de relógio; a fábrica que o carimba precisa.

Não leia o relógio duas vezes no mesmo método esperando o mesmo valor. `timeProvider.GetUtcNow()` é uma chamada de método, não uma propriedade em cache, e com `AutoAdvanceAmount` definido ele deliberadamente devolve algo diferente a cada vez. Leia uma vez para uma variável local e use a local, o que já é boa prática com `DateTime.UtcNow` e aqui vira requisito de corretude.

Por fim, no .NET Framework e no netstandard2.0 via `Microsoft.Bcl.TimeProvider`, as sobrecargas assíncronas não existem como métodos de instância. Use no lugar os métodos de extensão de `System.Threading.Tasks.TimeProviderTaskExtensions`: `timeProvider.Delay(...)`, `timeProvider.CreateCancellationTokenSource(...)` e `task.WaitAsync(timeout, timeProvider, ct)`. O comportamento é o mesmo; só o formato da chamada muda, então uma biblioteca multi-target precisa de um pequeno `#if` ou de um helper compartilhado.

## Relacionado

- A mecânica de timeout que este artigo torna testável está coberta por completo no guia sobre [impor um prazo assíncrono com CancellationTokenSource.CancelAfter](/pt-br/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/).
- Cada um desses testes depende de um token chegar até a operação, que é o tema de [propagar um CancellationToken por métodos assíncronos](/pt-br/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/).
- Quando o código sob teste precisa de um banco de dados real em vez de um relógio falso, veja [testes de integração contra um SQL Server real com Testcontainers](/pt-br/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/).
- Escolher onde o laço de polling vive em primeiro lugar é o assunto de [BackgroundService vs IHostedService vs Hangfire](/pt-br/2026/06/backgroundservice-vs-ihostedservice-vs-hangfire-for-background-jobs-in-dotnet-11/).
- Bloquear em uma chamada assíncrona é o jeito mais rápido de travar um teste com `FakeTimeProvider` por razões que nada têm a ver com o relógio: veja [o deadlock ao chamar .Result ou .Wait()](/pt-br/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/).

## Fontes

- [TimeProvider Class](https://learn.microsoft.com/en-us/dotnet/api/system.timeprovider) no Microsoft Learn
- [What is the TimeProvider class](https://learn.microsoft.com/en-us/dotnet/standard/datetime/timeprovider-overview) na documentação de fundamentos do .NET
- [Referência da API FakeTimeProvider](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.time.testing.faketimeprovider)
- [README do Microsoft.Extensions.TimeProvider.Testing](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.TimeProvider.Testing/README.md) em dotnet/extensions
- [Código-fonte de FakeTimeProvider.cs](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.TimeProvider.Testing/FakeTimeProvider.cs)
- [dotnet/extensions#5326: continuações do Task.Delay não executam quando Advance é chamado](https://github.com/dotnet/extensions/issues/5326)
- [Mudança significativa: ISystemClock está obsoleto](https://learn.microsoft.com/en-us/dotnet/core/compatibility/aspnet-core/8.0/isystemclock-obsolete)
