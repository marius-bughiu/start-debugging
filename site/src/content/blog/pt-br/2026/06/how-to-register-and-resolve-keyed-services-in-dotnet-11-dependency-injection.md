---
title: "Como registrar e resolver serviços com chave na injeção de dependência do .NET 11"
description: "Registre várias implementações do mesmo tipo de serviço sob uma chave com AddKeyedSingleton/Scoped/Transient e depois resolva-as com [FromKeyedServices], GetRequiredKeyedService ou KeyedService.AnyKey. Os registros com chave e sem chave são tabelas separadas, e esse é o detalhe que pega quase todo mundo."
pubDate: 2026-06-23
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "dependency-injection"
  - "aspnetcore"
lang: "pt-br"
translationOf: "2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection"
translatedBy: "claude"
translationDate: 2026-06-23
---

O contêiner de injeção de dependência embutido no .NET pode conter várias implementações do mesmo tipo de serviço e distingui-las por uma chave. Você registra cada uma com `AddKeyedSingleton`, `AddKeyedScoped` ou `AddKeyedTransient`, passando uma chave do tipo `object` (uma string ou um enum são típicos), e recupera uma específica com `[FromKeyedServices("key")]` em um parâmetro de construtor ou de handler, ou com `provider.GetRequiredKeyedService<T>("key")`. O único fato que confunde todo mundo: os registros com chave e sem chave vivem em duas tabelas separadas. Um `GetService<T>()` comum nunca verá um registro com chave, e `[FromKeyedServices]` nunca verá um sem chave. Este guia foi escrito para o .NET 11 (preview 5 no momento da escrita, com disponibilidade geral prevista para novembro de 2026) e `Microsoft.Extensions.DependencyInjection` 11.0.0. Os serviços com chave chegaram no .NET 8 e a API tem sido estável desde então, então todos os padrões aqui também funcionam sem alterações no .NET 8 e no .NET 10.

## Por que dar uma chave a um serviço em vez de criar uma nova interface

A forma antiga de registrar duas implementações de `IPaymentGateway` era inventar duas interfaces (`IStripeGateway`, `IPayPalGateway`) ou registrar um delegate de fábrica que decidia com base em uma string. Ambas vazam o mecanismo de seleção para o seu sistema de tipos. Os serviços com chave deixam a interface no singular e movem o discriminador para o registro, que é exatamente onde uma escolha feita em tempo de implantação ou de configuração deve ficar.

Os casos canônicos:

- **Vários provedores atrás de um contrato.** Dois gateways de pagamento, três canais de notificação, um cliente HTTP principal e um de fallback, cada um registrado sob uma chave e selecionado por ponto de chamada.
- **Caches ou conexões nomeadas.** Um cache de vida curta e um de vida longa, ambos com formato de `IMemoryCache`, com chave `"short"` e `"long"`.
- **Busca de estratégias em tempo de execução.** Um dicionário de estratégias onde a chave é calculada a partir de uma requisição, resolvida por meio de `IKeyedServiceProvider` em vez de um `switch` feito à mão.

Se você só vai ter uma implementação, não recorra a uma chave. O registro com chave adiciona um discriminador que você depois precisa manter sincronizado entre o local de registro e cada local de resolução. Use-o quando a multiplicidade for real.

## Registrando serviços com chave

Cada método de registro sem chave tem um gêmeo com chave que recebe um `serviceKey` como primeiro argumento. Aqui está toda a superfície em um único bloco.

```csharp
// .NET 11, C# 14 - Program.cs
using Microsoft.Extensions.DependencyInjection;

var builder = WebApplication.CreateBuilder(args);

// Two implementations of the same interface, told apart by a string key.
builder.Services.AddKeyedSingleton<IPaymentGateway, StripeGateway>("stripe");
builder.Services.AddKeyedSingleton<IPaymentGateway, PayPalGateway>("paypal");

// Lifetimes work exactly as their non-keyed counterparts.
builder.Services.AddKeyedScoped<IReportBuilder, PdfReportBuilder>("pdf");
builder.Services.AddKeyedTransient<IReportBuilder, CsvReportBuilder>("csv");

// A factory overload gives you the key and the provider, useful when the
// implementation needs to read its own key or build from config.
builder.Services.AddKeyedSingleton<IClock>("utc", (sp, key) => new SystemClock(DateTimeKind.Utc));

var app = builder.Build();
```

A chave é um `object`, comparada com `Equals`. Strings são a escolha comum porque sobrevivem a uma ida e volta pelo `appsettings.json`, mas um enum é mais limpo quando o conjunto é fechado e conhecido em tempo de compilação:

```csharp
// .NET 11, C# 14 - enum keys avoid stringly-typed lookups
public enum Channel { Email, Sms, Push }

builder.Services.AddKeyedScoped<INotifier, EmailNotifier>(Channel.Email);
builder.Services.AddKeyedScoped<INotifier, SmsNotifier>(Channel.Sms);
builder.Services.AddKeyedScoped<INotifier, PushNotifier>(Channel.Push);
```

Você pode registrar o mesmo tipo de implementação sob várias chaves, e pode registrar mais de uma implementação sob a **mesma** chave. O segundo caso vira uma resolução de `IEnumerable<T>`, abordada mais abaixo.

## Resolvendo um serviço com chave de três formas

### Injeção por construtor com `[FromKeyedServices]`

O atributo vive em `Microsoft.Extensions.DependencyInjection` e marca um único parâmetro de construtor para que o contêiner o resolva a partir da tabela com chave. Esta é a forma que você quer em serviços e controllers comuns porque mantém o consumidor livre de qualquer referência a `IServiceProvider`.

```csharp
// .NET 11, C# 14
public sealed class CheckoutService(
    [FromKeyedServices("stripe")] IPaymentGateway gateway)
{
    public Task<string> ChargeAsync(decimal amount) => gateway.ChargeAsync(amount);
}
```

O mesmo atributo funciona em um parâmetro de handler de minimal API, que é a forma mais limpa de vincular uma dependência com chave a um endpoint:

```csharp
// .NET 11, C# 14 - keyed dependency straight into a minimal API handler
app.MapPost("/charge/{provider}",
    ([FromKeyedServices("stripe")] IPaymentGateway gateway, decimal amount)
        => gateway.ChargeAsync(amount));
```

Ele também funciona em um parâmetro de action de um controller MVC e em um parâmetro de construtor de um controller, em ambos os casos sem nenhum registro extra.

### Resolução imperativa com `GetRequiredKeyedService`

Quando a chave só é conhecida em tempo de execução (calculada a partir de uma requisição, lida da configuração), você não pode usar um atributo de tempo de compilação. Injete `IServiceProvider` e chame os métodos de extensão com chave. O provider produzido por `Build()` implementa `IKeyedServiceProvider`, então estes sempre funcionam contra o contêiner padrão.

```csharp
// .NET 11, C# 14 - the key is decided at runtime
public sealed class PaymentRouter(IServiceProvider services)
{
    public Task<string> ChargeAsync(string providerKey, decimal amount)
    {
        // Throws InvalidOperationException if nothing is registered under the key.
        var gateway = services.GetRequiredKeyedService<IPaymentGateway>(providerKey);
        return gateway.ChargeAsync(amount);
    }
}
```

Use `GetKeyedService<T>(key)` (sem "Required") quando um registro ausente for um resultado normal e não excepcional; ele retorna `null` em vez de lançar. Dentro de um consumidor scoped, resolva a partir do provider scoped para que a instância scoped com chave tenha o escopo correto. Se você está recorrendo a um escopo dentro de um singleton como um `BackgroundService`, vale a mesma disciplina de `IServiceScopeFactory` que para qualquer [serviço scoped dentro de um BackgroundService](/pt-br/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/): o fato de o registro ter chave não muda as regras de tempo de vida.

### Resolvendo todas as implementações sob uma chave

Registre mais de uma implementação sob a mesma chave e resolva-as como um conjunto:

```csharp
// .NET 11, C# 14
builder.Services.AddKeyedSingleton<IValidationRule, NotEmptyRule>("order");
builder.Services.AddKeyedSingleton<IValidationRule, PositiveAmountRule>("order");

public sealed class OrderValidator(
    [FromKeyedServices("order")] IEnumerable<IValidationRule> rules)
{
    public bool IsValid(Order o) => rules.All(r => r.Check(o));
}
```

`GetKeyedServices<IValidationRule>("order")` é o equivalente imperativo e retorna ambas as implementações na ordem de registro.

## Combinando com qualquer chave usando `KeyedService.AnyKey`

Às vezes você quer um registro que responda por *todas* as chaves, com a implementação lendo a chave sob a qual foi resolvida. É para isso que serve `KeyedService.AnyKey`. Combine-o com um parâmetro `[ServiceKey]` para que a implementação receba a chave real em tempo de construção.

```csharp
// .NET 11, C# 14 - one registration that serves any key
builder.Services.AddKeyedSingleton<ITenantStore>(
    KeyedService.AnyKey,
    (sp, key) => new TenantStore((string)key!));

public sealed class TenantStore : ITenantStore
{
    public TenantStore(string tenantId) => TenantId = tenantId;
    public string TenantId { get; }
}

// A consumer can ask for any tenant; the key flows into the factory.
var acme = app.Services.GetRequiredKeyedService<ITenantStore>("acme");
var globex = app.Services.GetRequiredKeyedService<ITenantStore>("globex");
```

O atributo `[ServiceKey]` em um parâmetro de construtor também funciona sem a sobrecarga de fábrica. O contêiner injeta a chave que foi usada para resolver a instância:

```csharp
// .NET 11, C# 14 - the implementation discovers its own key
public sealed class TenantStore(
    [ServiceKey] string tenantId,
    AppDbContext db) : ITenantStore
{
    public string TenantId => tenantId;
}

builder.Services.AddKeyedScoped<ITenantStore, TenantStore>(KeyedService.AnyKey);
```

Duas regras governam o `AnyKey`. Primeira: um registro com chave exata vence o registro `AnyKey` quando ambos existem. Segunda: você não pode *resolver* com `KeyedService.AnyKey` como chave; é uma sentinela apenas do lado do registro. Pedir `GetRequiredKeyedService<T>(KeyedService.AnyKey)` lança uma exceção.

## A separação que mais causa confusão

Os registros com chave e sem chave são duas tabelas distintas dentro do contêiner. Esse único fato explica quase todos os relatos de bug do tipo "mas eu registrei":

```csharp
// .NET 11, C# 14
builder.Services.AddKeyedSingleton<IPaymentGateway, StripeGateway>("stripe");

var sp = builder.Services.BuildServiceProvider();

sp.GetService<IPaymentGateway>();                 // null - no NON-keyed registration
sp.GetKeyedService<IPaymentGateway>("stripe");    // the StripeGateway
sp.GetKeyedService<IPaymentGateway>("paypal");    // null - nothing under that key
```

Um parâmetro de construtor comum `IPaymentGateway gateway` (sem atributo) resolve apenas a partir da tabela sem chave e não encontrará um registro com chave. Se você quer que um serviço seja alcançável das duas formas, registre-o duas vezes, uma com chave e uma sem. A armadilha inversa é igualmente comum: `[FromKeyedServices("stripe")]` contra um serviço registrado com um `AddSingleton` simples não resolve nada, porque o atributo lê apenas a tabela com chave.

Essa separação é também a razão pela qual `GetServices<T>()` (o enumerável sem chave) não inclui os registros com chave. Se você depende de enumerar "todas as implementações", decida de antemão se elas têm chave ou não e mantenha a coerência.

## Detalhes que vale conhecer antes de colocar em produção

**`ActivatorUtilities.CreateInstance` respeita `[FromKeyedServices]`, mas apenas para os tipos que ele ativa.** Um tipo criado pelo contêiner (ou por `ActivatorUtilities`) tem seus parâmetros com chave preenchidos. Um tipo que você instancia com `new` não recebe nada injetado, com ou sem chave. Isso importa para código de fábrica e para qualquer coisa fora do grafo de DI.

**O `Equals` e o `GetHashCode` da chave precisam ser estáveis.** Strings e enums estão bem. Uma chave de tipo referência mutável, ou uma com igualdade baseada em valor que muda ao longo do tempo, vai falhar silenciosamente na correspondência. Prefira chaves imutáveis.

**A injeção com `ServiceKey` exige o tipo certo.** Se você registra sob uma chave `string` e declara `[ServiceKey] int id`, a construção lança uma exceção em tempo de resolução. Mantenha o tipo do parâmetro declarado atribuível a partir da chave com a qual você registrou.

**A validação roda por registro, não por chave.** Quando `ValidateOnBuild` está ligado (o padrão em `Development` sob `WebApplication.CreateBuilder`), o validador de pontos de chamada verifica o grafo de cada registro com chave da mesma forma que um sem chave. Um serviço scoped com chave capturado por um singleton ainda lança `Cannot consume scoped service from singleton`; ter chave não isenta você das regras de tempo de vida. Se você esbarrar em uma falha de resolução, a mensagem é lida igual ao caso sem chave, e o [fix de unable to resolve service while attempting to activate](/pt-br/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/) percorre como lê-la; apenas lembre que a tabela com chave é separada quando você for verificar se o registro existe.

**Native AOT e trimming são suportados.** Os serviços com chave foram projetados para serem amigáveis ao AOT: a resolução não depende de reflexão em tempo de execução sobre os seus tipos, então eles sobrevivem ao trimming sem anotações `DynamicallyAccessedMembers` adicionais. Se você está pesando o modelo de implantação, os trade-offs de [Native AOT vs ReadyToRun vs JIT](/pt-br/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) se aplicam sem mudanças com registros com chave no grafo.

**Nem todo contêiner de terceiros suporta chaves.** O contêiner embutido suporta. Se você trocou para uma versão antiga de Autofac, Lamar ou DryIoc, confirme a ponte de serviços com chave dela antes de depender de `[FromKeyedServices]`; o recurso é um contrato de `Microsoft.Extensions.DependencyInjection.Abstractions` que cada contêiner precisa implementar.

## Um exemplo completo e funcional

Aqui está o formato de ponta a ponta: dois gateways com chave por nome, um router que escolhe um em tempo de execução a partir da rota, e um padrão injetado diretamente em um handler.

```csharp
// .NET 11, C# 14 - Program.cs
using Microsoft.Extensions.DependencyInjection;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddKeyedSingleton<IPaymentGateway, StripeGateway>("stripe");
builder.Services.AddKeyedSingleton<IPaymentGateway, PayPalGateway>("paypal");
builder.Services.AddScoped<PaymentRouter>();

var app = builder.Build();

// Runtime selection: the provider name comes from the URL.
app.MapPost("/charge/{provider}",
    (string provider, decimal amount, PaymentRouter router)
        => router.ChargeAsync(provider, amount));

// Compile-time selection: this endpoint always uses Stripe.
app.MapPost("/charge-stripe",
    ([FromKeyedServices("stripe")] IPaymentGateway gateway, decimal amount)
        => gateway.ChargeAsync(amount));

app.Run();

public interface IPaymentGateway { Task<string> ChargeAsync(decimal amount); }

public sealed class PaymentRouter(IServiceProvider services)
{
    public Task<string> ChargeAsync(string key, decimal amount)
    {
        var gateway = services.GetKeyedService<IPaymentGateway>(key)
            ?? throw new ArgumentException($"Unknown gateway '{key}'", nameof(key));
        return gateway.ChargeAsync(amount);
    }
}
```

A divisão é intencional: o endpoint `/charge/{provider}` precisa de `IServiceProvider` porque a chave é dado, enquanto `/charge-stripe` usa o atributo porque a chave é uma constante. Recorra a `[FromKeyedServices]` sempre que a chave for conhecida em tempo de compilação, e volte a `GetKeyedService`/`GetRequiredKeyedService` apenas quando ela genuinamente não for.

## Onde os serviços com chave se encaixam em seguida

A DI com chave é a ferramenta certa quando um contrato tem várias implementações reais selecionadas por configuração ou por requisição. É a ferramenta errada para uma única implementação, para preocupações transversais melhor tratadas pelo padrão options, ou para uma lógica de seleção complexa o suficiente para merecer sua própria abstração de fábrica. Quando recorrer a ela, mantenha as chaves imutáveis, registre uma vez para cada caminho de resolução pretendido e lembre-se de que as tabelas com chave e sem chave nunca se enxergam.

Para padrões adjacentes: decidir de onde os endpoints obtêm suas dependências faz parte da escolha mais ampla de [minimal APIs vs controllers](/pt-br/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/), e o registro com chave combina bem com [HybridCache no ASP.NET Core 11](/pt-br/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/) quando você quer instâncias de cache nomeadas atrás de uma única interface.

## Fontes

- [Dependency injection in .NET - keyed services](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection#keyed-services), MS Learn.
- [`ServiceCollectionServiceExtensions` keyed methods](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.servicecollectionserviceextensions), referência da API do .NET.
- [`FromKeyedServicesAttribute`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.fromkeyedservicesattribute) e [`ServiceKeyAttribute`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.servicekeyattribute), referência da API do .NET.
- [`IKeyedServiceProvider`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.ikeyedserviceprovider) e [`KeyedService.AnyKey`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.keyedservice.anykey), referência da API do .NET.
