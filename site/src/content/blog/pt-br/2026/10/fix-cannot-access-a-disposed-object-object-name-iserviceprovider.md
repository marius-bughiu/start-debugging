---
title: "Fix: Cannot access a disposed object. Object name: 'IServiceProvider'"
description: "O código resolveu um serviço de um escopo de DI ou do provider raiz depois que ele foi descartado. Capture IServiceScopeFactory em vez de IServiceProvider e crie um novo escopo onde o trabalho é executado."
pubDate: 2026-10-28
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-10"
  - "aspnetcore"
  - "dependency-injection"
lang: "pt-br"
translationOf: "2026/10/fix-cannot-access-a-disposed-object-object-name-iserviceprovider"
translatedBy: "claude"
translationDate: 2026-10-28
---

A correção: algo chamou `GetService`, `GetRequiredService` ou `CreateScope` em um `IServiceProvider` cujo escopo (ou o contêiner inteiro) já tinha sido descartado. Em geral é uma tarefa fire-and-forget que capturou `HttpContext.RequestServices`, um serviço que guardou o `IServiceProvider` com escopo para resolução "lazy", ou um loop em segundo plano que continua rodando depois que o host foi encerrado. Pare de guardar `IServiceProvider`. Injete `IServiceScopeFactory`, chame `CreateAsyncScope()` no ponto em que o trabalho realmente roda e resolva tudo a partir desse novo escopo.

```text
System.ObjectDisposedException: Cannot access a disposed object.
Object name: 'IServiceProvider'.
   at Microsoft.Extensions.DependencyInjection.ServiceLookup.ThrowHelper.ThrowObjectDisposedException()
   at Microsoft.Extensions.DependencyInjection.ServiceLookup.ServiceProviderEngineScope.GetService(Type serviceType)
   at Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.GetRequiredService(IServiceProvider provider, Type serviceType)
   at Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.GetRequiredService[T](IServiceProvider provider)
```

Cada trecho de código e cada linha de saída deste post vêm de um repro que executei no .NET 10 (runtime 10.0.10, `Microsoft.Extensions.DependencyInjection` como distribuído no shared framework, ASP.NET Core 10.0.10). A verificação que lança essa exceção é idêntica no branch `release/11.0` de `dotnet/runtime`, então a mesma análise vale para o .NET 11.

## Por que o contêiner lança exceção em vez de retornar null

Em `Microsoft.Extensions.DependencyInjection`, todo escopo é um `ServiceProviderEngineScope`. Ele implementa `IServiceScope`, `IServiceProvider` e `IServiceScopeFactory` ao mesmo tempo, e o `IServiceProvider` que você recebe de `scope.ServiceProvider` é o próprio objeto do escopo. Quando o escopo é descartado, ele descarta todo `IDisposable`/`IAsyncDisposable` que criou e depois define uma flag privada `_disposed`. A partir desse momento, `GetService`, `GetKeyedService` e `GetRequiredKeyedService` começam com a mesma verificação:

```csharp
// dotnet/runtime, release/10.0
// src/libraries/Microsoft.Extensions.DependencyInjection/src/ServiceLookup/ServiceProviderEngineScope.cs
public object? GetService(Type serviceType)
{
    if (_disposed)
    {
        ThrowHelper.ThrowObjectDisposedException();
    }

    return RootProvider.GetService(ServiceIdentifier.FromServiceType(serviceType), this);
}

// ThrowHelper.cs
internal static void ThrowObjectDisposedException()
{
    throw new ObjectDisposedException(nameof(IServiceProvider));
}
```

Esse `nameof(IServiceProvider)` é o motivo de o nome do objeto ser sempre `'IServiceProvider'`, seja um escopo de requisição, um escopo criado manualmente ou o `ServiceProvider` raiz. O provider raiz tem sua própria flag `_disposed` e passa pelo mesmo helper, então a mensagem sozinha não diz *qual* provider morreu. O stack trace diz: `ServiceProviderEngineScope.GetService` indica um escopo, enquanto um frame em `ServiceProvider.CreateScope` ou `ServiceProvider.GetService` indica que o contêiner raiz acabou, o que quase sempre significa que o host foi descartado.

Duas consequências desse design importam na depuração:

1. **Só a resolução lança exceção.** Uma instância que você já resolveu antes do fim do escopo continua sendo um objeto normal. Se ela tem sua própria proteção contra descarte (um `DbContext`, um `HttpClient`, um `CancellationTokenSource`), usá-la gera a `ObjectDisposedException` *daquele* tipo, com o nome de objeto dele, e não esta.
2. **O provider não está "quebrado", ele terminou.** Não há como reviver um escopo descartado. A correção é sempre usar um escopo cujo tempo de vida cubra o trabalho.

## As quatro formas que disparam o erro

Reproduzi cada uma delas em um único aplicativo de console (`Microsoft.NET.Sdk.Web`, `net10.0`). As quatro imprimiram exatamente a mensagem acima.

### 1. Um provider com escopo que escapa do seu `using`

O repro mais simples possível. A variável sobrevive ao escopo:

```csharp
// .NET 10, C# 14
var services = new ServiceCollection();
services.AddScoped<Repo>();
using var root = services.BuildServiceProvider();

IServiceProvider leaked;
using (var scope = root.CreateScope())
{
    leaked = scope.ServiceProvider;
}

leaked.GetRequiredService<Repo>(); // ObjectDisposedException: 'IServiceProvider'
```

Ninguém escreve isso de propósito, mas aparece disfarçado o tempo todo: um método auxiliar que faz `using var scope = ...; return scope.ServiceProvider;`, ou um método `async` que cria um escopo com `using var` e depois retorna uma `Task` ou `IAsyncEnumerable` que continua resolvendo a partir dele depois que a parte síncrona do método já retornou.

### 2. Uma tarefa fire-and-forget que capturou `HttpContext.RequestServices`

Este é o caso com que a maioria das pessoas chega aqui. O ASP.NET Core cria o escopo da requisição de forma lazy em `RequestServicesFeature` e registra a feature com `Response.RegisterForDisposeAsync`, então o escopo é descartado assim que a resposta termina. Uma tarefa desacoplada que pegou `RequestServices` perde a corrida:

```csharp
// .NET 10, ASP.NET Core 10.0.10 -- wrong
app.MapPost("/orders/{id}/export", (int id, HttpContext ctx) =>
{
    var sp = ctx.RequestServices;
    _ = Task.Run(async () =>
    {
        await Task.Delay(200);                       // the response is already sent
        var exporter = sp.GetRequiredService<OrderExporter>(); // throws
        await exporter.ExportAsync(id);
    });
    return Results.Accepted();
});
```

No meu repro o endpoint retornou `202`, e 200 ms depois a tarefa registrou `ObjectDisposedException: Cannot access a disposed object. Object name: 'IServiceProvider'.` Como a exceção acontece em uma tarefa não observada, muitas vezes você só a vê nos logs, ou nunca, e o sintoma é "a exportação simplesmente não acontece". O mesmo ocorre quando a tarefa captura `IServiceProvider` por injeção no construtor de um controller, ou lê `IHttpContextAccessor.HttpContext.RequestServices` mais tarde (caso em que você também pode receber `null`, porque o contexto foi reciclado).

### 3. Um serviço que guarda `IServiceProvider` para usar depois

A variante "service locator". Um serviço transient ou com escopo recebe `IServiceProvider` no construtor para resolver dependências sob demanda:

```csharp
// .NET 10, C# 14 -- wrong
class ReportBuilder(IServiceProvider sp)
{
    public void Build() => sp.GetRequiredService<Repo>().Save();
}

ReportBuilder rb;
using (var scope = root.CreateScope())
    rb = scope.ServiceProvider.GetRequiredService<ReportBuilder>();

rb.Build(); // ObjectDisposedException: 'IServiceProvider'
```

O `IServiceProvider` injetado em um serviço com escopo ou transient é o escopo de onde ele foi resolvido, não a raiz. No momento em que `ReportBuilder` é entregue a qualquer coisa que sobreviva ao escopo (um cache singleton, uma assinatura de evento em um singleton, um campo estático, um `Lazy<T>`, uma factory `Func<T>` registrada com `sp => () => sp.GetRequiredService<T>()`), a próxima resolução lazy lança exceção. Se você já viu o [erro de dependência capturada, "Cannot consume scoped service from singleton"](/pt-br/2026/05/fix-cannot-consume-scoped-service-from-singleton/), este é o primo de runtime dele: a validação de escopo detecta *serviços* capturados em tempo de build, mas não consegue enxergar um *provider* capturado.

### 4. Um loop em segundo plano que sobrevive ao host

O provider raiz é descartado quando o host é descartado. `BackgroundService.StopAsync` cancela o token de parada e aguarda `ExecuteAsync`, mas só até `HostOptions.ShutdownTimeout` (30 segundos por padrão desde o .NET 6) expirar. Um loop que ignora o token continua rodando depois que o host segue em frente e descarta o contêiner:

```csharp
// .NET 10 -- wrong: ignores stoppingToken
class StubbornWorker(IServiceScopeFactory scopes) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (true)
        {
            using var scope = scopes.CreateScope(); // throws once the host is disposed
            scope.ServiceProvider.GetRequiredService<Repo>().Save();
            await Task.Delay(250);
        }
    }
}
```

Com `ShutdownTimeout` definido como 1 segundo, `StopAsync` retornou, `host.Dispose()` rodou e a iteração seguinte imprimiu `ObjectDisposedException: Cannot access a disposed object. Object name: 'IServiceProvider'.`. Note que esse worker faz tudo certo em relação a escopos. O bug está só no token de cancelamento ignorado. A mesma falha aparece em callbacks de `System.Threading.Timer`, consumidores de `Channel` iniciados com `Task.Run` e handlers de message bus que continuam consumindo depois do encerramento. Em testes, aparece quando um `WebApplicationFactory<T>` ou uma fixture de host é descartado enquanto um teste (ou uma tarefa em segundo plano iniciada pelo teste) ainda está resolvendo serviços a partir de `factory.Services`.

## Correção 1: capture `IServiceScopeFactory`, não `IServiceProvider`

Para as formas 2 e 3, esta é a correção. `IServiceScopeFactory` é especial no contêiner: `ServiceProvider` o registra como um call site constante apontando para o escopo **raiz**, então não importa de onde você o resolve. Até um `IServiceScopeFactory` injetado em um endpoint com escopo de requisição está vinculado ao contêiner raiz e continua funcionando depois que a requisição termina. Crie o escopo dentro do trabalho desacoplado, para que o tempo de vida do escopo seja exatamente o tempo de vida do trabalho:

```csharp
// .NET 10, ASP.NET Core 10.0.10 -- right
app.MapPost("/orders/{id}/export", (int id, IServiceScopeFactory scopes) =>
{
    _ = Task.Run(async () =>
    {
        await using var scope = scopes.CreateAsyncScope();
        var exporter = scope.ServiceProvider.GetRequiredService<OrderExporter>();
        await exporter.ExportAsync(id);
    });
    return Results.Accepted();
});
```

No repro, o mesmo atraso de 200 ms que quebrou a versão com `RequestServices` registrou `good: ok` aqui. Prefira `CreateAsyncScope()` com `await using`: se algum serviço no escopo implementar apenas `IAsyncDisposable`, um `Dispose()` síncrono no escopo lança `InvalidOperationException` dizendo para usar `DisposeAsync`. O [guia de `IAsyncDisposable` e `await using`](/pt-br/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/) explica o motivo.

Também não passe *dados* vinculados à requisição pelo escopo. Copie o que você precisa (IDs, o nome do usuário, um ID de correlação) para variáveis locais antes de iniciar a tarefa. O próprio `HttpContext` não é seguro de acessar depois que a resposta termina.

Para a forma service locator, injete `IServiceScopeFactory` em `ReportBuilder` e crie um escopo a cada chamada de `Build()` ou, melhor ainda, injete `Repo` diretamente e deixe o contêiner gerenciar os tempos de vida. Se a dependência é realmente opcional ou cara, um registro keyed ou por factory que resolve a partir de um novo escopo é mais limpo do que guardar o provider.

## Correção 2: mova o trabalho para um mecanismo real de segundo plano

`Task.Run` a partir de um handler de requisição é o problema raiz na forma 2. Nada rastreia a tarefa, nada observa sua exceção e nada a interrompe no encerramento. Coloque o item de trabalho em um `Channel<T>` e consuma-o em um `BackgroundService` que cria um escopo por item:

```csharp
// .NET 10, C# 14
public sealed class ExportQueue
{
    private readonly Channel<int> _channel = Channel.CreateUnbounded<int>();
    public ValueTask EnqueueAsync(int orderId) => _channel.Writer.WriteAsync(orderId);
    public IAsyncEnumerable<int> ReadAllAsync(CancellationToken ct) => _channel.Reader.ReadAllAsync(ct);
}

public sealed class ExportWorker(ExportQueue queue, IServiceScopeFactory scopes, ILogger<ExportWorker> log)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var id in queue.ReadAllAsync(stoppingToken))
        {
            try
            {
                await using var scope = scopes.CreateAsyncScope();
                await scope.ServiceProvider.GetRequiredService<OrderExporter>().ExportAsync(id, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                log.LogError(ex, "Export of order {OrderId} failed", id);
            }
        }
    }
}

// Program.cs
builder.Services.AddSingleton<ExportQueue>();
builder.Services.AddHostedService<ExportWorker>();
app.MapPost("/orders/{id}/export", async (int id, ExportQueue queue) =>
{
    await queue.EnqueueAsync(id);
    return Results.Accepted();
});
```

O padrão completo, incluindo canais com limite e back-pressure, está em [como executar trabalho fire-and-forget com segurança usando BackgroundService](/pt-br/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/). A parte do escopo por iteração é abordada em profundidade em [usar serviços com escopo dentro de um BackgroundService](/pt-br/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/).

## Correção 3: respeite o token de parada para que nada rode após o descarte

Para a forma 4, o código de escopo está correto e o bug é o tempo de vida do loop. Passe `stoppingToken` para cada await e condição do loop, para que o loop termine antes de `ShutdownTimeout` expirar:

```csharp
// .NET 10 -- right
protected override async Task ExecuteAsync(CancellationToken stoppingToken)
{
    using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(250));
    while (await timer.WaitForNextTickAsync(stoppingToken))
    {
        await using var scope = scopes.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<Repo>().SaveAsync(stoppingToken);
    }
}
```

`PeriodicTimer.WaitForNextTickAsync` lança `OperationCanceledException` no cancelamento, e o `BackgroundService` trata um cancelamento que corresponde ao token de parada como uma saída limpa. Se uma única unidade de trabalho legitimamente leva mais de 30 segundos, aumente `HostOptions.ShutdownTimeout` em vez de ignorar o token; caso contrário, o host vai descartar o contêiner debaixo dos seus pés. O [post sobre o contrato de IHostedService](/pt-br/2026/07/what-is-the-ihostedservice-contract-and-when-do-i-use-it/) detalha a ordem exata de início e parada.

Em testes de integração, garanta que o teste aguarde toda tarefa que iniciou antes de o `DisposeAsync` da fixture rodar, e resolva os serviços de cada teste a partir de `factory.Services.CreateAsyncScope()` em vez de diretamente de `factory.Services`.

## Armadilhas e erros parecidos

**A corrida dentro da resolução.** `ServiceProviderEngineScope.CaptureDisposable` verifica `_disposed` sob um lock depois de construir um serviço descartável. Se o escopo foi descartado *enquanto* seu serviço estava sendo criado em outra thread, o contêiner descarta a instância recém-construída e então lança essa mesma exceção. Assim você pode vê-la em um caminho de código que parecia correto um microssegundo antes. É o mesmo bug: duas threads discordam sobre o tempo de vida do escopo.

**`app.Services` depois que `app.Run` retorna.** Qualquer coisa em `Program.cs` que rode depois de `app.Run()` ou `await app.RunAsync()` (código de limpeza, um flush final) roda depois que o host foi descartado. Resolva o que precisa antes de chamar `Run`, ou mova a lógica para um callback de `IHostApplicationLifetime.ApplicationStopping`.

**`IServiceProvider` em um singleton é a raiz.** Injetar `IServiceProvider` em um singleton entrega o provider raiz, que só é descartado junto com o host, então ele não lança essa exceção durante a operação normal. Em compensação, ele entrega serviços com escopo a partir do escopo raiz sem reclamar se `ValidateScopes` estiver desligado, o que os transforma em singletons acidentais. Use `IServiceScopeFactory` ali também.

**"Cannot access a disposed context instance".** Se o nome do objeto na sua mensagem é o tipo do seu `DbContext` (`Object name: 'AppDb'`), os serviços do escopo foram descartados, não o provider, e a correção é um contexto novo por operação: veja [o guia sobre DbContext descartado](/pt-br/2026/06/fix-objectdisposedexception-cannot-access-a-disposed-context-instance/).

**`Object name: 'System.Net.Http.HttpClient'` ou um `CancellationTokenSource`.** Mesmo tipo de exceção, outro dono. Elas vêm de descartar uma instância que você resolveu, não de resolver depois do descarte.

## Veja também

- [Fix: Cannot consume scoped service from singleton](/pt-br/2026/05/fix-cannot-consume-scoped-service-from-singleton/) para a versão em tempo de build de tempos de vida capturados.
- [Como usar serviços com escopo dentro de um BackgroundService](/pt-br/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/) para o padrão de escopo por unidade de trabalho.
- [Como executar trabalho fire-and-forget com segurança usando BackgroundService](/pt-br/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/) para substituir `Task.Run` em handlers.
- [Fix: Cannot access a disposed context instance](/pt-br/2026/06/fix-objectdisposedexception-cannot-access-a-disposed-context-instance/) para a versão do EF Core do mesmo bug de tempo de vida.
- [Como escrever testes de integração com WebApplicationFactory](/pt-br/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/) para tempos de vida de fixtures em testes.

## Fontes

- [`ServiceProviderEngineScope.cs` em `release/10.0`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/Microsoft.Extensions.DependencyInjection/src/ServiceLookup/ServiceProviderEngineScope.cs) (a verificação `_disposed` e `CaptureDisposable`).
- [`ThrowHelper.cs` em `release/10.0`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/Microsoft.Extensions.DependencyInjection/src/ServiceLookup/ThrowHelper.cs) (`new ObjectDisposedException(nameof(IServiceProvider))`).
- [`ServiceProvider.cs` em `release/10.0`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/Microsoft.Extensions.DependencyInjection/src/ServiceProvider.cs) (`IServiceScopeFactory` registrado como constante vinculada ao escopo raiz).
- [`RequestServicesFeature.cs` em `release/10.0`](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Http/Http/src/Features/RequestServicesFeature.cs) (escopo da requisição descartado via `RegisterForDisposeAsync`).
- [Diretrizes de injeção de dependência](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection-guidelines) no Microsoft Learn.
- [Usar serviços com escopo dentro de um BackgroundService](https://learn.microsoft.com/en-us/dotnet/core/extensions/scoped-service) no Microsoft Learn.
- Referência da API [`HostOptions.ShutdownTimeout`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.hosting.hostoptions.shutdowntimeout).
