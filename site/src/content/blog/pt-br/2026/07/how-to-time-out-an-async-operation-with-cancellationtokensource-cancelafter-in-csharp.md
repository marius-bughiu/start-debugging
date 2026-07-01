---
title: "Como definir um tempo limite em uma operação assíncrona com CancellationTokenSource.CancelAfter em C#"
description: "Use CancellationTokenSource.CancelAfter para aplicar um prazo em operações assíncronas no .NET 11: construtor vs CancelAfter, tokens vinculados, tratamento de exceções, Task.WaitAsync, TryReset para pooling e timeouts testáveis com TimeProvider."
pubDate: 2026-07-01
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
  - "cancellation"
lang: "pt-br"
translationOf: "2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp"
translatedBy: "claude"
translationDate: 2026-07-01
---

Definir um prazo em uma operação assíncrona requer três coisas: um `CancellationTokenSource`, uma chamada a `cts.CancelAfter(TimeSpan.FromSeconds(5))`, e passar `cts.Token` para cada método assíncrono na cadeia. Quando o prazo expira, o token é acionado, qualquer `await` subsequente lança `OperationCanceledException`, e você a captura. Este artigo cobre o padrão completo no .NET 11 (`Microsoft.NET.Sdk` 11.0.0, C# 14): quando usar a sobrecarga do construtor em vez de `CancelAfter`, como combinar um timeout com um `CancellationToken` externo, como distinguir um timeout de um cancelamento do chamador, `Task.WaitAsync` para código que você não pode modificar, `TryReset` para pooling, e como tornar timeouts testáveis com `TimeProvider`.

## A operação que trava para sempre

Uma chamada de `HttpClient` sem um prazo explícito aguarda o tempo que o servidor precisar. `HttpClient.Timeout` tem um padrão de 100 segundos -- tempo suficiente para saturar uma fila de requisições sob carga. Além disso, `HttpClient.Timeout` não pode ser combinado com o `CancellationToken` de um chamador, e quando é acionado lança `TaskCanceledException` com um `InnerException` do tipo `TimeoutException` -- uma forma diferente de um cancelamento cooperativo. O padrão manual de `CancelAfter` oferece tanto a aplicação do prazo quanto a composição.

```csharp
// .NET 11, C# 14 -- perigoso: HttpClient.Timeout tem padrão de 100 segundos
using HttpClient http = new();
string json = await http.GetStringAsync("https://slow-api.example.com/data");
```

## CancelAfter em um único passo

```csharp
// .NET 11, C# 14
using var cts = new CancellationTokenSource();
cts.CancelAfter(TimeSpan.FromSeconds(5));

try
{
    using HttpClient http = new();
    string json = await http.GetStringAsync(
        "https://slow-api.example.com/data", cts.Token);
    Console.WriteLine(json);
}
catch (OperationCanceledException) when (cts.IsCancellationRequested)
{
    Console.WriteLine("Requisição expirou após 5 segundos.");
}
```

`CancelAfter` agenda um timer interno de disparo único. Quando o timer é acionado, ele chama `Cancel()` no CTS, o que muda o estado do token de "não solicitado" para "solicitado". Qualquer `await` dentro de `GetStringAsync` que verifique o token lança `OperationCanceledException`. A cláusula `when` garante que você só capture a exceção se o seu próprio CTS foi o acionado -- não se algum outro cancelamento injetado pelo framework ou por um chamador chegar.

## Sobrecarga do construtor vs CancelAfter

```csharp
// .NET 11, C# 14 -- equivalentes para um prazo fixo de disparo único:
using var cts1 = new CancellationTokenSource(TimeSpan.FromSeconds(5));

using var cts2 = new CancellationTokenSource();
cts2.CancelAfter(TimeSpan.FromSeconds(5));
```

Use a sobrecarga do construtor quando o prazo é fixo no momento da criação do objeto e não mudará. Prefira `CancelAfter` quando você cria o CTS antecipadamente e decide o prazo mais tarde, ou quando precisa redefini-lo durante a operação -- por exemplo, um watchdog que renova sua janela em cada heartbeat bem-sucedido:

```csharp
// .NET 11, C# 14 -- padrão watchdog que reinicia o prazo em cada pacote
using var cts = new CancellationTokenSource();
cts.CancelAfter(TimeSpan.FromSeconds(10));

await foreach (Packet packet in ReadPacketsAsync(cts.Token))
{
    Process(packet);
    cts.CancelAfter(TimeSpan.FromSeconds(10));  // reinicia a janela de 10 segundos
}
```

Cada chamada a `CancelAfter` substitui o tempo agendado anteriormente usando `ITimer.Change` internamente -- sem nova alocação de memória. A nova contagem regressiva começa a partir do momento da chamada.

## Combinando um timeout com um CancellationToken externo

No ASP.NET Core, `HttpContext.RequestAborted` é acionado quando o cliente se desconecta. Em um `BackgroundService`, `stoppingToken` é acionado no desligamento. Seu timeout deve cancelar se o prazo expirar ou se o chamador cancelar. Use `CancellationTokenSource.CreateLinkedTokenSource`:

```csharp
// .NET 11, C# 14
public async Task<string> FetchWithDeadlineAsync(
    string url,
    CancellationToken callerToken = default)
{
    using var timeoutCts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
    using var linked = CancellationTokenSource.CreateLinkedTokenSource(
        callerToken, timeoutCts.Token);

    using HttpClient http = new();
    return await http.GetStringAsync(url, linked.Token);
}
```

Passe `linked.Token` para cada chamada subsequente. O token vinculado é cancelado se qualquer fonte for acionada. `CreateLinkedTokenSource` aceita qualquer número de tokens; o CTS retornado é cancelado assim que qualquer um deles é cancelado.

Sempre faça `Dispose` tanto do CTS de timeout quanto do CTS vinculado. Instâncias de CTS não descartadas com timers pendentes não são coletadas pelo coletor de lixo até que o timer seja acionado.

## Distinguindo um timeout de um cancelamento do chamador

Ambos os caminhos lançam `OperationCanceledException`. Para fornecer informações de erro significativas aos chamadores, converta um timeout real em um `TimeoutException`:

```csharp
// .NET 11, C# 14
catch (OperationCanceledException ex)
{
    if (timeoutCts.IsCancellationRequested)
        throw new TimeoutException(
            "A operação expirou após 5 segundos.", ex);

    // Chamador cancelou -- relança sem encapsular para que o token do chamador
    // se propague sem alterações
    throw;
}
```

Isso importa quando o código chamador não conhece o `CancellationTokenSource` interno. Um chamador que captura `TimeoutException` não precisa inspecionar tokens que nunca criou.

Ao usar um CTS vinculado, verifique `timeoutCts.IsCancellationRequested` diretamente. Não compare `ex.CancellationToken` com o token vinculado -- `ex.CancellationToken` contém o token constitutivo que foi acionado primeiro (chamador, timeout ou vinculado), o que varia conforme a condição de corrida.

## Task.WaitAsync para código sem parâmetro de token

Nem toda API aceita um `CancellationToken`. O .NET 6 adicionou `Task.WaitAsync` para esse caso:

```csharp
// .NET 11, C# 14 -- encapsulando uma API legada sem token
Task<string> slowWork = LegacyApiAsync();

try
{
    string result = await slowWork.WaitAsync(TimeSpan.FromSeconds(5));
}
catch (TimeoutException)
{
    // Prazo expirado. slowWork AINDA ESTÁ SENDO EXECUTADO em segundo plano.
    Console.WriteLine("Desistimos de aguardar após 5 segundos.");
}
```

`WaitAsync(TimeSpan)` lança `TimeoutException` (não `OperationCanceledException`) e não cancela o `Task` subjacente. O trabalho continua até ser concluído por conta própria. Use `WaitAsync` apenas quando não puder passar um token para o código chamado; o consumo de recursos continua de qualquer forma.

Uma sobrecarga combinada aceita tanto um prazo quanto um `CancellationToken`:

```csharp
// .NET 11, C# 14 -- cancelável E com limite de tempo
await slowWork.WaitAsync(TimeSpan.FromSeconds(5), callerToken);
```

Esta sobrecarga lança `TimeoutException` se o prazo expirar primeiro, ou `TaskCanceledException` (subclasse de `OperationCanceledException`) se o token for acionado primeiro.

## Redefinindo e desabilitando um timeout existente

`CancelAfter` pode ser chamado várias vezes. Cada chamada substitui o prazo agendado anteriormente:

```csharp
// .NET 11, C# 14
using var cts = new CancellationTokenSource();
cts.CancelAfter(TimeSpan.FromSeconds(10));   // prazo inicial: 10s

// Estender: reinicia o timer com uma janela de 5 segundos a partir de agora
cts.CancelAfter(TimeSpan.FromSeconds(5));

// Desabilitar o timeout completamente sem cancelar o CTS:
cts.CancelAfter(Timeout.InfiniteTimeSpan);   // não será mais acionado
```

`Timeout.InfiniteTimeSpan` equivale a `-1` milissegundos, o que desabilita o timer interno sem colocar o CTS no estado cancelado.

Uma vez que um CTS tenha sido cancelado, chamar `CancelAfter` não tem efeito. Verifique `IsCancellationRequested` primeiro se o cancelamento pode já ter ocorrido.

## TryReset para pooling

Em código de alto throughput que emite muitas operações curtas, criar um novo `CancellationTokenSource` por requisição gera alocações. O .NET 6 adicionou `TryReset` para reutilização:

```csharp
// .NET 11, C# 14 -- padrão de CTS em pool
private CancellationTokenSource _cts = new();

public async Task ProcessRequestAsync()
{
    if (!_cts.TryReset())
        _cts = new CancellationTokenSource();

    _cts.CancelAfter(TimeSpan.FromSeconds(5));

    await DoWorkAsync(_cts.Token);
}
```

`TryReset` retorna `true` se o CTS não foi cancelado e pode ser reutilizado com segurança; `false` se foi cancelado e uma nova instância é necessária. Não é thread-safe com solicitações de cancelamento concorrentes -- chame-o apenas depois que a operação anterior tiver sido concluída, de um único proprietário. O ASP.NET Core usa esse padrão internamente no Kestrel.

## Timeouts testáveis com TimeProvider

Aguardar 5 segundos reais em um teste unitário é lento e instável. `TimeProvider`, introduzido no .NET 8 e estável no .NET 11, torna o timer interno injetável:

```csharp
// .NET 11, C# 14
public async Task<string> FetchAsync(
    string url,
    TimeProvider? clock = null)
{
    clock ??= TimeProvider.System;
    using var cts = clock.CreateCancellationTokenSource(TimeSpan.FromSeconds(5));

    using HttpClient http = new();
    return await http.GetStringAsync(url, cts.Token);
}
```

Nos testes, injete `FakeTimeProvider` do pacote NuGet `Microsoft.Extensions.TimeProvider.Testing`:

```csharp
// xUnit, .NET 11, C# 14
[Fact]
public async Task FetchAsync_ThrowsOnTimeout()
{
    var clock = new FakeTimeProvider();
    Task<string> fetch = FetchAsync("https://slow.example.com", clock);

    clock.Advance(TimeSpan.FromSeconds(10));  // avança 10 segundos instantaneamente

    await Assert.ThrowsAsync<OperationCanceledException>(() => fetch);
}
```

O cancelamento é acionado de forma síncrona quando você avança o relógio. Sem `Task.Delay`. Sem tempo de teste instável.

## Descarte o CTS

`CancellationTokenSource` implementa `IDisposable`, não `IAsyncDisposable`. Não há `DisposeAsync`. Quando você chama `CancelAfter`, um timer é registrado na fila de timers do thread pool. Esse timer mantém uma referência ao CTS, impedindo a coleta de lixo até que seja acionado.

Sempre descarte:

```csharp
// Correto: limpeza garantida mesmo se uma exceção for lançada
using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
await DoWorkAsync(cts.Token);
// cts.Dispose() é chamado aqui; o timer é cancelado e liberado
```

O descarte cancela o timer pendente, libera os wait handles e remove o CTS de qualquer cadeia de `CreateLinkedTokenSource` à qual pertença. Em um servidor que lida com milhares de requisições concorrentes, vazamentos de instâncias de CTS causam acúmulo de timers.

## Armadilhas comuns

**HttpClient.Timeout compete com seu token.** `HttpClient.Timeout` tem padrão de 100 segundos. Se você também passar um token com `CancelAfter`, ambos os timers estão em execução. Quando `HttpClient.Timeout` é acionado, lança `TaskCanceledException` onde `ex.InnerException is TimeoutException`; quando seu token é acionado, lança `OperationCanceledException` onde `ex.CancellationToken == cts.Token`. Desabilite um dos dois: defina `HttpClient.Timeout` como `Timeout.InfiniteTimeSpan` e gerencie o prazo você mesmo, ou confie em `HttpClient.Timeout` e omita o CTS manual. Consulte [Fix: TaskCanceledException em HttpClient](/pt-br/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) para a desambiguação completa.

**CancelAfter após Cancel não tem efeito.** Uma vez que um CTS esteja no estado cancelado, chamar `CancelAfter` não faz nada. O cancelamento é uma transição unidirecional.

**Marshaling para a thread de UI.** No WinForms, WPF ou MAUI, a continuação após um `await` cancelado é executada na thread do pool que captura a conclusão -- não na thread de UI. Se você atualizar elementos de UI no bloco catch, retorne explicitamente para a thread correta. No ASP.NET Core não há `SynchronizationContext` instalado, portanto [ConfigureAwait(false) não tem efeito](/pt-br/2026/05/configureawait-false-vs-default-in-dotnet-11/).

**Não compartilhe um token entre branches paralelos sem intenção.** Se você distribuir trabalho com `Task.WhenAll` e passar o mesmo `cts.Token` para todos os branches, o primeiro cancelamento cancela todos os outros. Geralmente é o que você quer para um prazo compartilhado, mas seja deliberado.

## Relacionados

- Propagar um único `CancellationToken` por cada camada assíncrona: [Como propagar um CancellationToken por métodos assíncronos no .NET 11](/pt-br/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/)
- Cancelamento manual sem prazo: [Como cancelar uma tarefa de longa duração em C# sem deadlock](/pt-br/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)
- Três motivos pelos quais o HttpClient lança TaskCanceledException: [Fix: TaskCanceledException em HttpClient](/pt-br/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/)
- ConfigureAwait(false) em código de biblioteca: [ConfigureAwait(false) vs padrão no .NET 11](/pt-br/2026/05/configureawait-false-vs-default-in-dotnet-11/)
- async void vs async Task -- qual pode propagar exceções: [async void vs async Task em C#: quando cada um é correto](/pt-br/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)

## Fontes

- [CancellationTokenSource.CancelAfter -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.threading.cancellationtokensource.cancelafter)
- [CancellationTokenSource.TryReset -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.threading.cancellationtokensource.tryreset)
- [Task.WaitAsync -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.task.waitasync)
- [TimeProvider.CreateCancellationTokenSource -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.timeprovider.createcancellationtokensource)
- [Microsoft.Extensions.TimeProvider.Testing no NuGet](https://www.nuget.org/packages/Microsoft.Extensions.TimeProvider.Testing)
