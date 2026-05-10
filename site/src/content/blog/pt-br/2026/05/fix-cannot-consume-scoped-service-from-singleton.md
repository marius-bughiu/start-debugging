---
title: "Correção: Cannot consume scoped service 'X' from singleton 'Y'"
description: "A validação de escopo do ASP.NET Core lança esta exceção quando um singleton capturaria uma dependência scoped pelo resto do processo. Torne o consumidor scoped, ou injete IServiceScopeFactory e crie um escopo sob demanda."
pubDate: 2026-05-10
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "dependency-injection"
lang: "pt-br"
translationOf: "2026/05/fix-cannot-consume-scoped-service-from-singleton"
translatedBy: "claude"
translationDate: 2026-05-10
---

A correção: o validador de escopo do ASP.NET Core bloqueou uma dependência capturada. O singleton `Y` pediu ao provedor raiz o serviço scoped `X`, o que prenderia `X` ao processo inteiro e ignoraria por completo o ciclo de vida por requisição. Mude `Y` para scoped (preferível quando `Y` é consumido dentro de um escopo de requisição), ou mantenha `Y` como singleton e injete `IServiceScopeFactory`, criando um escopo novo sempre que precisar de `X`. Para `DbContext` especificamente, use `IDbContextFactory<T>`.

```text
System.InvalidOperationException: Cannot consume scoped service 'MyApp.Data.AppDbContext' from singleton 'MyApp.Workers.OrderProcessor'.
   at Microsoft.Extensions.DependencyInjection.ServiceLookup.CallSiteValidator.ValidateCallSite(ServiceCallSite callSite)
   at Microsoft.Extensions.DependencyInjection.ServiceLookup.ServiceProviderEngineScope.GetService(Type serviceType)
   at Microsoft.Extensions.DependencyInjection.ServiceProvider.GetService(Type serviceType, ServiceProviderEngineScope serviceProviderEngineScope)
   at Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.GetRequiredService(IServiceProvider provider, Type serviceType)
   at Microsoft.Extensions.Hosting.Internal.Host.StartAsync(CancellationToken cancellationToken)
```

Este guia foi escrito para .NET 11 preview 4, `Microsoft.Extensions.DependencyInjection` 11.0.0-preview.4 e `Microsoft.Extensions.Hosting` 11.0.0-preview.4. O texto da exceção e o validador que a lança são estáveis desde o .NET Core 2.0, então toda correção abaixo se aplica a .NET Core 3.1, .NET 5, 6, 8, 10 e 11 sem alterações.

Os dois nomes de tipo na mensagem são a primeira coisa a ler: o **primeiro** nome é o serviço **scoped**, e o **segundo** nome é o consumidor **singleton** que o pediu. O erro sempre os nomeia nessa ordem, mesmo que os mecanismos de busca tendam a te jogar na metade errada da mensagem em metade dos casos.

## Por que a validação de escopo rejeita essa combinação

Um singleton vive uma vez por processo. Um serviço scoped vive uma vez por escopo de requisição (ou uma vez por chamada a `IServiceScopeFactory.CreateScope()`). Se um singleton armazenar uma referência a um serviço scoped em um campo, essa instância scoped sobrevive a todas as requisições seguintes, anulando o propósito do ciclo de vida scoped: estado por requisição, agrupamento de conexões por escopo, rastreamento de mudanças por escopo, isolamento por inquilino por escopo.

A opção `ValidateScopes` do ASP.NET Core captura isso em tempo de resolução percorrendo o grafo de call sites antes que o construtor chegue a rodar. Em `Development`, `WebApplication.CreateBuilder` ativa `ValidateScopes` automaticamente; em `Production` não, e é por isso que algumas equipes só veem a exceção localmente e enviam o bug capturado para produção, onde ele se manifesta como dados obsoletos, vazamento de conexões ou `ObjectDisposedException` em um `DbContext` que foi descartado junto com o escopo da requisição original.

Esse bug aparece em exatamente quatro formatos:

1. **Parâmetro do construtor singleton é scoped.** O caso mais comum. O construtor de `BackgroundService` (singleton) pede `IUserRepository` (scoped).
2. **Parâmetro do construtor singleton também é singleton, mas depende transitivamente de algo scoped.** Um singleton `IFooFactory` recebe um singleton `IFooDeps`, que recebe um scoped `IUnitOfWork`. O validador segue o grafo.
3. **Singleton resolve scoped diretamente do `IServiceProvider`.** `_provider.GetRequiredService<IUserRepository>()` de dentro de um singleton, onde `_provider` é o provedor **raiz**. O provedor não tem escopo, então o validador lança a exceção.
4. **Serviço hospedado / worker de fila / callback de timer rodando fora de qualquer requisição.** O host chama o singleton a partir de uma thread sem escopo ambiente, então qualquer resolução scoped vai contra o raiz.

Os três primeiros falham na inicialização ou na primeira chamada. O quarto falha no momento em que o timer dispara. Mesma exceção, caminhos de depuração diferentes.

## Reprodução mínima

O menor app de console .NET 11 que lança a exceção:

```csharp
// .NET 11 preview 4, Microsoft.Extensions.Hosting 11.0.0-preview.4
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

var builder = Host.CreateApplicationBuilder(args);

builder.Services.AddScoped<IUserRepository, UserRepository>();
builder.Services.AddHostedService<OrderProcessor>();

var host = builder.Build();
await host.RunAsync();

public interface IUserRepository
{
    string GetName(int id);
}

public sealed class UserRepository : IUserRepository
{
    public string GetName(int id) => $"user-{id}";
}

public sealed class OrderProcessor(IUserRepository repo) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            Console.WriteLine(repo.GetName(1));
            await Task.Delay(TimeSpan.FromSeconds(1), stoppingToken);
        }
    }
}
```

`AddHostedService<T>` registra `OrderProcessor` como singleton. O construtor exige `IUserRepository`, que é scoped. O builder do host chama `GetRequiredService` no provedor raiz durante `StartAsync`, o validador percorre o call site, vê a aresta scoped-para-singleton e lança a exceção.

## Correção um: torne o consumidor scoped, quando o consumidor cabe em uma requisição

A correção mais limpa quando o consumidor é alcançado **por requisição**. Um controller, um handler de minimal API, um filtro MVC, um método de hub do SignalR: todos rodam dentro de um escopo existente. Se você os registrou como singleton por engano, mude o registro:

```csharp
// .NET 11 preview 4
// Wrong: pulls AppDbContext into a process-wide singleton
builder.Services.AddSingleton<IOrderService, OrderService>();

// Right: scoped matches DbContext lifetime
builder.Services.AddScoped<IOrderService, OrderService>();
```

Esta correção não funciona para serviços hospedados, timers ou filas em segundo plano. Eles não têm um escopo ao redor, então deixá-los scoped não muda nada (o host continua resolvendo a partir do raiz). Para esses casos use a correção dois.

Quando você muda um registro de singleton para scoped, audite os locais de chamada em busca de referências guardadas em campos. Qualquer outro singleton que recebia `IOrderService` no construtor agora vai falhar a validação de escopo, e a corrente se desenrola para cima até chegar a um serviço que cabe num escopo de requisição.

## Correção dois: injete IServiceScopeFactory e abra um escopo por unidade de trabalho

Quando o consumidor **precisa** continuar singleton, receba `IServiceScopeFactory` e crie um escopo novo a cada vez que faz trabalho. Esse é o padrão canônico para `BackgroundService` e qualquer consumidor a nível de processo:

```csharp
// .NET 11 preview 4
public sealed class OrderProcessor(IServiceScopeFactory scopeFactory) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            using var scope = scopeFactory.CreateScope();
            var repo = scope.ServiceProvider.GetRequiredService<IUserRepository>();

            Console.WriteLine(repo.GetName(1));

            await Task.Delay(TimeSpan.FromSeconds(1), stoppingToken);
        }
    }
}
```

Três regras para aplicar esse padrão corretamente:

- **Um escopo por unidade de trabalho**, não um escopo por processo. O ponto é que cada iteração receba um `DbContext` novo, change tracker novo e conexão nova. Descartar o escopo no fim da iteração libera os serviços scoped.
- **Resolva pelo `ServiceProvider` do escopo**, não pelo provedor raiz capturado. `scope.ServiceProvider.GetRequiredService<T>()` é correto; `_rootProvider.GetRequiredService<T>()` é o bug original.
- **Não armazene serviços scoped em campos** do singleton. A instância que você resolve dentro do escopo não pode sobreviver ao escopo. Se precisar passá-la para outro método, passe como parâmetro e deixe sair de escopo com o `using`.

Para serviços `IAsyncDisposable` no .NET 11 (a maioria das configurações modernas de `DbContext`), prefira a forma assíncrona descartável:

```csharp
// .NET 11 preview 4
await using var scope = scopeFactory.CreateAsyncScope();
var repo = scope.ServiceProvider.GetRequiredService<IUserRepository>();
```

`CreateAsyncScope` retorna um `AsyncServiceScope`, que descarta serviços scoped via `DisposeAsync` quando implementam essa interface. Para instâncias agrupadas de `DbContext` isso importa: o descarte síncrono de um recurso somente assíncrono lança exceção no .NET 11 por padrão.

## Correção três: use IDbContextFactory especificamente para DbContext

O EF Core inclui uma fábrica tipada exatamente para esse cenário. Registre-a no lugar de (ou junto com) o `DbContext` scoped:

```csharp
// .NET 11 preview 4, Microsoft.EntityFrameworkCore 11.0.0-preview.4
builder.Services.AddDbContextFactory<AppDbContext>(options =>
    options.UseSqlServer(builder.Configuration.GetConnectionString("Default")));
```

```csharp
// .NET 11 preview 4
public sealed class OrderProcessor(IDbContextFactory<AppDbContext> dbFactory) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            await using var db = await dbFactory.CreateDbContextAsync(stoppingToken);

            var pending = await db.Orders
                .Where(o => o.Status == OrderStatus.Pending)
                .ToListAsync(stoppingToken);

            // process pending...

            await Task.Delay(TimeSpan.FromSeconds(1), stoppingToken);
        }
    }
}
```

`AddDbContextFactory` registra `IDbContextFactory<AppDbContext>` como **singleton**, e a fábrica entrega instâncias frescas de `DbContext` sob demanda. Sem desencontro de escopo, sem `DbContext` capturado, sem cerimônia de escopo no seu worker. Esse é o padrão que a Microsoft recomenda para Blazor Server, serviços hospedados e qualquer código fora do ciclo de requisição que converse com EF Core. Veja a [documentação da fábrica de DbContext](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/#using-a-dbcontext-factory-eg-for-blazor) para a orientação completa.

Você pode registrar `AddDbContext` e `AddDbContextFactory` ao mesmo tempo se tiver uma mistura de consumidores ligados e não ligados à requisição. Use `AddDbContextFactory<T>(..., ServiceLifetime.Scoped)` para tornar a própria fábrica scoped quando precisar de pooling junto com escopo, mas verifique se os ciclos de vida batem no consumidor.

## Correção quatro: ValidateOnBuild captura isso na inicialização, não na primeira requisição

Depois de aplicar uma correção real acima, ative a validação em tempo de build para que a próxima dependência capturada falhe rápido:

```csharp
// .NET 11 preview 4
builder.Host.UseDefaultServiceProvider(options =>
{
    options.ValidateScopes = true;
    options.ValidateOnBuild = true;
});
```

`ValidateScopes = true` força o runtime a passar cada resolução pelo validador de call site, mesmo em produção. `ValidateOnBuild = true` faz isso **uma vez** no momento de `host.Build()` para cada registro do contêiner. O host se recusa a iniciar se algum registro lançasse exceção na primeira resolução.

O custo é uma única passagem de validação na inicialização. O benefício é que a próxima pessoa a introduzir uma dependência capturada vê a falha durante o startup local ou no CI, e não no tráfego de produção.

O que você **não** deve fazer, mesmo que os resultados de busca sugiram: desligar `ValidateScopes` para silenciar a exceção. Desativar a verificação não corrige o bug. Ele apenas é escondido. O serviço scoped continua preso ao ciclo de vida do singleton; você só para de ser avisado. Dados obsoletos, vazamento de conexões e `ObjectDisposedException` mais adiante no processo são garantidos.

## Variantes que parecem o mesmo erro mas têm correção diferente

Algumas mensagens de erro têm parentesco e fazem você perder tempo se forem tratadas igual:

- **`Unable to resolve service for type 'X' while attempting to activate 'Y'`**: registro ausente, e não desencontro de ciclo de vida. Causa diferente, correção diferente. Cobertura em [unable to resolve service for type while attempting to activate](/pt-br/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/).
- **`Cannot resolve scoped service 'X' from root provider`**: o consumidor pediu diretamente ao `IServiceProvider` **raiz** (`app.Services.GetRequiredService<X>()` para um `X` scoped). A correção é a mesma do caso do singleton: abra um escopo primeiro.
- **`A circular dependency was detected for the service of type 'X'`**: o ciclo de vida está ok, mas o grafo de call sites tem um ciclo. Procure um serviço que pega a si mesmo ou um primo no construtor.
- **`Cannot access a disposed object. Object name: 'AppDbContext'`**: um serviço scoped capturado que **já** escapou da validação de escopo (porque ela estava desligada ou o serviço foi resolvido por uma rota não validada) e agora é usado depois que o escopo original foi descartado. A correção é abrir um escopo novo no ponto de uso.

## Por que isso atinge serviços hospedados mais do que qualquer outra coisa

`AddHostedService<T>` e `AddSingleton<IHostedService, T>` são o mesmo registro: todo serviço hospedado é singleton. O host os resolve a partir do provedor raiz durante `StartAsync`. Se o construtor do seu serviço hospedado recebe qualquer coisa que toque o banco de dados, fale com um resolvedor de inquilino ou envolva `HttpContext`, será scoped, e o validador vai lançar.

A mesma armadilha existe para:

- **Consumidores de `IHttpClientFactory` que resolvem delegating handlers scoped a partir de um singleton.** O próprio `IHttpClientFactory` é singleton, mas handlers por requisição podem ser registrados como scoped. Resolver o named client a partir de um singleton dispara o validador.
- **Pipelines de resiliência do Polly** registrados como scoped (que é o padrão no .NET 11) e consumidos a partir de um singleton.
- **`IOptionsSnapshot<T>`**, que é **scoped**. Um singleton que dependa de `IOptionsSnapshot<T>` falha a validação. Use `IOptionsMonitor<T>` (singleton) no lugar. A mudança é uma linha no construtor.
- **MediatR / `ISender` registrado como scoped.** `Mediator.Send` a partir de um serviço hospedado precisa rodar dentro de um escopo.
- **Interceptadores do EF Core** que retêm um `IServiceProvider` capturado. Use as sobrecargas de registro compatíveis com escopo, e não um provedor raiz capturado.

## Casos extremos que vale nomear

- **`IServiceProvider` injetado em um singleton**. É legal, mas o provedor que você recebe é o provedor **raiz**. Resolver qualquer coisa scoped a partir dele dispara a mesma exceção. Se precisa resolver scoped, peça `IServiceScopeFactory` no lugar e chame `CreateScope()`.
- **Fábricas `Func<T>` registradas manualmente**. Se `T` é scoped e a fábrica é capturada por um singleton, ela parece ok à inspeção mas explode na primeira invocação fora de um escopo. Substitua a fábrica manual por `IServiceScopeFactory` mais `GetRequiredService<T>()`.
- **Hosts de teste que desligam a validação de escopo**. `WebApplicationFactory<T>` mantém a validação ligada por padrão no .NET 8+. Se seus testes passam e produção falha, verifique se você não adicionou `ValidateScopes = false` no host de teste.
- **Builds Native AOT e com trimming**. A validação de escopo roda no mesmo contêiner padrão, então AOT não muda essa regra. O trimmer pode remover um tipo usado apenas via reflexão dentro de uma fábrica capturada; o sintoma aí é `Unable to resolve`, não a exceção de captura.
- **Serviços hospedados genéricos**. `AddHostedService<MyHostedService<MyArg>>()` continua singleton. O validador inspeciona o construtor do genérico fechado, então um parâmetro `IRepo<MyArg>` registrado como scoped dispara o mesmo caminho de erro.

## Relacionados

- O erro complementar de registro a este: [unable to resolve service for type while attempting to activate](/pt-br/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/).
- Um exemplo prático do padrão singleton-com-fábrica-de-escopo: [running a Semantic Kernel plugin from a BackgroundService](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/).
- A próxima exceção do EF Core que você vê quando um `DbContext` sobrevive ao escopo por engano: [a second operation was started on this context instance](/pt-br/2026/05/fix-second-operation-was-started-on-this-context-instance/).
- Trocas de DI em testes sem quebrar a validação de escopo: [integration tests against a real SQL Server with Testcontainers](/pt-br/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/).
- Um modo de falha de configuração que costuma andar lado a lado com bugs de ciclo de vida: [no connection string named 'DefaultConnection' could be found](/pt-br/2026/05/fix-no-connection-string-named-defaultconnection/).

## Fontes

- Microsoft Learn, [Dependency injection guidelines: scope validation](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection-guidelines#scope-validation).
- Microsoft Learn, [Dependency injection in .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection).
- Microsoft Learn, [Using a DbContext factory](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/#using-a-dbcontext-factory-eg-for-blazor).
- Código-fonte do ASP.NET Core, [`CallSiteValidator.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.DependencyInjection/src/ServiceLookup/CallSiteValidator.cs) onde a verificação de dependência capturada dispara.
- Código-fonte do ASP.NET Core, [`ServiceProviderEngineScope.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.DependencyInjection/src/ServiceLookup/ServiceProviderEngineScope.cs) onde a distinção raiz vs escopo é aplicada.
