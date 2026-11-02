---
title: "MediatR vs classes de serviço simples em 2026: a mudança de licença deveria te mover?"
description: "Compare o despacho e os behaviors do MediatR com chamadas diretas a serviços, incluindo validação de DI, critérios de licença e avaliação de desempenho."
pubDate: 2026-05-23
updatedDate: 2026-11-02
template: vs
tags:
  - "comparison"
  - "mediatr"
  - "dependency-injection"
  - "architecture"
  - "dotnet"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/05/mediatr-vs-plain-service-classes-in-2026"
translatedBy: "claude"
translationDate: 2026-05-23
---

Prefira serviços diretos quando cada requisição tem um destino claro. O MediatR ganha valor quando vários tipos de requisição compartilham behaviors ou quando há notificações com vários destinatários. Avalie separadamente as condições da versão utilizada.

**Correção — 2 de novembro de 2026:** corrigimos a comparação de validação de DI e licença e retiramos estimativas sem medição de tempo e alocações.

Os exemplos têm como destino `net11.0` e ilustram os contratos do MediatR 13/14. A verificação de DI abaixo foi executada no .NET 10.

## O que realmente mudou em julho de 2025

O MediatR 12.5.0 foi distribuído sob Apache 2.0. Em julho de 2025, o autor anunciou as opções RPL-1.5 e comercial a partir da versão 13.0.0. Versões anteriores mantêm os termos originais.

Os [critérios Community da Lucky Penny Software](https://luckypennysoftware.com/faq) incluem receita bruta anual ou orçamento de organização sem fins lucrativos inferior a US$ 5 milhões e até US$ 10 milhões de capital externo. O fornecedor também estabelece condições para entidades governamentais ou quase governamentais, uso no ensino superior e trabalho para clientes. Confira os critérios da organização e da finalidade de uso.

## A matriz de recursos num relance

| Aspecto | MediatR 13+ | Classes de serviço simples |
| ------- | ----------- | -------------------------- |
| Despacho de requisições | Indireção com `ISender.Send` | Chamada direta a um método de uma interface injetada |
| Preocupações transversais | `IPipelineBehavior<,>` de primeira classe | Decoradores (Scrutor) ou chamadas explícitas |
| Validação de DI | Depende dos registros e das opções do provedor | Depende dos registros e das opções do provedor |
| Notificações / fan-out | Publicação `INotification` integrada | Lista de handlers feita à mão |

O pipeline é a principal diferença de design: oferece um ponto comum para validação, logs, transações ou cache de várias requisições.

## Como o MediatR se parece, e o equivalente simples

Esta é a forma canônica do MediatR: uma requisição, um handler e um chamador que despacha através do `ISender`.

```csharp
// .NET 11, C# 14, MediatR 13+ - request + handler
using MediatR;

public record GetOrderById(int OrderId) : IRequest<OrderDto>;

public sealed class GetOrderByIdHandler(AppDbContext db)
    : IRequestHandler<GetOrderById, OrderDto>
{
    public async Task<OrderDto> Handle(GetOrderById request, CancellationToken ct)
    {
        var order = await db.Orders.FindAsync([request.OrderId], ct)
            ?? throw new OrderNotFoundException(request.OrderId);
        return order.ToDto();
    }
}

// In an endpoint:
public async Task<OrderDto> Get(int id, ISender sender, CancellationToken ct)
    => await sender.Send(new GetOrderById(id), ct);
```

A versão simples colapsa a requisição e o handler em um único método de um serviço injetado. O chamador depende diretamente da interface.

```csharp
// .NET 11, C# 14 - plain service class, no MediatR
public interface IOrderService
{
    Task<OrderDto> GetByIdAsync(int orderId, CancellationToken ct);
}

public sealed class OrderService(AppDbContext db) : IOrderService
{
    public async Task<OrderDto> GetByIdAsync(int orderId, CancellationToken ct)
    {
        var order = await db.Orders.FindAsync([orderId], ct)
            ?? throw new OrderNotFoundException(orderId);
        return order.ToDto();
    }
}

// In an endpoint:
public async Task<OrderDto> Get(int id, IOrderService orders, CancellationToken ct)
    => await orders.GetByIdAsync(id, ct);
```

Numa chamada de interface, ir à definição leva ao método da interface, e a IDE permite localizar as implementações. A partir de `Send`, procure o handler do tipo de requisição.

`AddScoped` registra um serviço. Com o provedor integrado e `ValidateOnBuild` habilitado, a construção do host pode detectar uma dependência de construtor ausente em um serviço registrado. Sem a validação, a construção pode passar e a falha ocorrer quando o serviço é resolvido. Os [padrões de validação do ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis?view=aspnetcore-10.0#validatescopes-and-validateonbuild) dependem do ambiente. `ValidateScopes` é uma verificação separada de tempo de vida.

A verificação desta correção registrou no .NET 10 um serviço scoped com dependência ausente. Com os padrões, Development falhou em `Build()` e Production na resolução. Definir `ValidateOnBuild` explicitamente mudou a fase da falha.

```csharp
// .NET 11, C# 14 - registration, side by side
// MediatR: scan an assembly, register every handler reflectively
builder.Services.AddMediatR(cfg =>
    cfg.RegisterServicesFromAssemblyContaining<GetOrderById>());

// Plain: explicitly register the scoped service
builder.Services.AddScoped<IOrderService, OrderService>();
```

## O pipeline behavior, e como viver sem ele

Aqui é onde o MediatR conquista o seu lugar. Um pipeline behavior envolve cada requisição, o que te dá exatamente um lugar para adicionar validação, log, medição de tempo ou uma transação.

```csharp
// .NET 11, C# 14, MediatR 13+ - cross-cutting validation for ALL requests
using MediatR;

public sealed class ValidationBehavior<TRequest, TResponse>(
    IEnumerable<IValidator<TRequest>> validators)
    : IPipelineBehavior<TRequest, TResponse>
    where TRequest : notnull
{
    public async Task<TResponse> Handle(
        TRequest request,
        RequestHandlerDelegate<TResponse> next,
        CancellationToken ct)
    {
        foreach (var validator in validators)
            await validator.ValidateAndThrowAsync(request, ct);
        return await next(ct);
    }
}
```

Registrado uma vez, esse behavior executa na frente de cada handler. Substituir isso por chamadas de validação copiadas e coladas em cada serviço simples seria uma regressão, e é o melhor argumento para manter um mediator. Mas você pode obter a mesma propriedade de "envolver tudo" em DI simples com o padrão decorador, usando Scrutor (licenciado sob MIT) para registrar um decorador ao redor de uma interface:

```csharp
// .NET 11, C# 14, Scrutor 6.x - a decorator gives you the same cross-cutting hook
public sealed class LoggingOrderService(
    IOrderService inner,
    ILogger<LoggingOrderService> logger) : IOrderService
{
    public async Task<OrderDto> GetByIdAsync(int orderId, CancellationToken ct)
    {
        logger.LogInformation("Fetching order {OrderId}", orderId);
        return await inner.GetByIdAsync(orderId, ct);
    }
}

// Registration: decorate the real implementation
builder.Services.AddScoped<IOrderService, OrderService>();
builder.Services.Decorate<IOrderService, LoggingOrderService>();
```

A troca é honesta: o behavior do MediatR é genérico sobre cada requisição com um único registro, ao passo que um decorador é por interface. Se você tem uma ou duas preocupações transversais e um punhado de interfaces de serviço, os decoradores ganham em clareza. Se você tem dez behaviors que precisam se aplicar de forma uniforme a duzentos tipos de requisição, o pipeline genérico do MediatR é genuinamente menos código, e esse é o cenário em que ficar (e pagar, ou qualificar para Community) é defensável. Para preocupações no nível da requisição que na verdade são preocupações de HTTP, note que parte do que as pessoas colocam em behaviors pertence ao middleware ou aos filtros, a mesma superfície coberta por [adicionar um filtro global de exceções no ASP.NET Core 11](/pt-br/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/).

## Quanto o despacho custa de verdade

`Send` resolve um handler e executa o pipeline configurado. A chamada direta usa o serviço injetado. Este artigo não tem benchmark equivalente dos dois caminhos, por isso não informa tempos nem alocações por chamada.

Se o custo do despacho influenciar a escolha, meça os caminhos com o mesmo trabalho, tempo de vida, runtime e cadeia de behaviors. Meça o registro e a partida a frio separadamente. O registro explícito pode evitar a varredura de handlers. Verifique trimming e Native AOT na aplicação publicada.

## O detalhe que decide por você

Algumas restrições resolvem isso antes de o gosto arquitetural entrar em cena.

Uma aplicação fixada em 12.5.0 continua nessa versão e sob seus termos. Considere a manutenção antes de manter essa fixação a longo prazo.

**Se você só chama `Send`, você não precisa de um mediator.** O teste honesto: abra a sua solução e procure `IPipelineBehavior` e `INotification`. Se há zero behaviors e você não publica notificações, o MediatR está funcionando como uma camada de indireção sobre chamadas de método, e removê-lo é uma refatoração mecânica que torna o código mais navegável, remove uma dependência e apaga a questão da licença em um único movimento. Esse é o mesmo instinto de racionalização de bibliotecas por trás de escolher a opção embutida em [System.Text.Json vs Newtonsoft.Json em 2026](/pt-br/2026/05/system-text-json-vs-newtonsoft-json-in-2026/).

## A decisão, em uma linha

Para uma ligação direta entre chamador e serviço, prefira injeção explícita. Mantenha o MediatR quando o pipeline compartilhado ou as notificações forem úteis a vários tipos de requisição. Se escolher serviços, siga a [migração passo a passo](/pt-br/2026/05/migrate-from-mediatr-to-plain-dependency-injection/).

## Relacionados

- [Minimal APIs vs controllers in ASP.NET Core 11](/pt-br/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)
- [Fix: Unable to resolve service for type while attempting to activate](/pt-br/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/)
- [Fix: Cannot consume scoped service from singleton](/pt-br/2026/05/fix-cannot-consume-scoped-service-from-singleton/)
- [HttpClient vs HttpClientFactory vs Refit](/pt-br/2026/05/httpclient-vs-httpclientfactory-vs-refit/)
- [System.Text.Json vs Newtonsoft.Json em 2026](/pt-br/2026/05/system-text-json-vs-newtonsoft-json-in-2026/)

## Fontes

- [AutoMapper and MediatR Commercial Editions Launch Today](https://www.jimmybogard.com/automapper-and-mediatr-commercial-editions-launch-today/) - o anúncio de lançamento de 2025-07-02, o limite da v13.0 e o modelo dual RPL-1.5 / comercial.
- [Licensing FAQ - Lucky Penny Software](https://luckypennysoftware.com/faq) - os limites Community de 5.000.000 de receita e 10.000.000 de capital, a contagem de desenvolvedores por "acesso programático" e a verificação de licença apenas de log.
- [MediatR commercial version launched (Discussion #1123)](https://github.com/LuckyPennySoftware/MediatR/discussions/1123) - confirmação de que as versões antigas permanecem sob a sua licença de código aberto original.
- [LuckyPennySoftware/MediatR v13.0.0 release](https://github.com/LuckyPennySoftware/MediatR/releases/tag/v13.0.0) - a primeira versão com licença dual.
- [Scrutor no GitHub](https://github.com/khellang/Scrutor) - a extensão `Decorate` licenciada sob MIT usada para substituir pipeline behaviors por decoradores.
