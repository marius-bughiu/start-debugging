---
title: "Migrar do MediatR para injeção de dependência simples no .NET 11"
description: "Uma lista de verificação passo a passo para remover o MediatR 12-14 e substituir os handlers de IRequest, ISender, os pipeline behaviors e INotification por classes de serviço simples e injeção por construtor."
pubDate: 2026-05-30
updatedDate: 2026-05-30
template: migration
tags:
  - "migration"
  - "mediatr"
  - "dependency-injection"
  - "dotnet"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/05/migrate-from-mediatr-to-plain-dependency-injection"
translatedBy: "claude"
translationDate: 2026-05-30
---

Remover o MediatR de uma base de código em .NET 11 é uma refatoração mecânica, não uma reescrita. Para um serviço típico com 50-150 handlers, reserve de meio dia a um dia: a maioria dos handlers se colapsa um a um em métodos sobre classes de serviço simples, as chamadas a `ISender.Send` viram chamadas diretas à interface, e a única parte que exige raciocínio de design é o pipeline. O que quebra é tudo que dependia da resolução de handlers em runtime ou do envoltório de `IPipelineBehavior<,>` em volta de cada requisição; isso vira injeção por construtor e decorators. Vale a pena fazer se você só chama `Send`, se você está acima da linha de receita de $5,000,000 da edição Community do MediatR e não quer comprar uma licença comercial, ou se você quer Native AOT e compatibilidade com trimming. Não vale a pena se seus pipeline behaviors são fundamentais em centenas de tipos de requisição.

Versões referenciadas: este guia cobre a remoção do MediatR 12.5.0 (a última versão com licença Apache 2.0), 13.0 (lançada em 2025-07-02, a primeira versão com licença dupla Reciprocal Public License 1.5 / comercial da Lucky Penny Software) e a linha atual 14.x. O código de substituição mira `<TargetFramework>net11.0</TargetFramework>` com o SDK do .NET 11 e C# 14, mais Scrutor 6.x para os decorators. Se você ainda está decidindo *se* deve sair, leia primeiro [MediatR vs classes de serviço simples em 2026](/pt-br/2026/05/mediatr-vs-plain-service-classes-in-2026/); este artigo assume que a decisão já foi tomada.

## Por que as equipes estão removendo o MediatR justamente agora

- **A licença força uma decisão acima dos $5M.** O uso open-source gratuito do MediatR 13+ é sob a RPL-1.5, uma licença copyleft recíproca projetada para fechar a brecha do SaaS. Se você distribui software comercial de código fechado acima do limiar de receita da edição Community, essa licença não serve para você, então é comprar ou sair.
- **Ir para a definição leva ao handler, não ao `Send`.** As chamadas diretas à interface restauram a navegabilidade que a indireção do mediator custa em cada salto.
- **A inicialização fica mais barata e o AOT fica mais fácil.** Remover a varredura de assemblies para o registro de handlers corta milissegundos de cold start e elimina a reflexão que briga com o trimming, o que importa ao [reduzir o tempo de cold start de um AWS Lambda em .NET 11](/pt-br/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/).
- **O cabeamento falha na inicialização, não na primeira requisição.** O registro explícito com `AddScoped` transforma uma dependência ausente em um erro em tempo de inicialização em vez de uma `InvalidOperationException` em runtime.

## O que quebra

| Área | Mudança | Severidade |
| --- | --- | --- |
| Injeção de `ISender` / `IMediator` | Substituída pela interface de serviço concreta injetada diretamente | alta |
| `IRequest<T>` + `IRequestHandler<,>` | Colapsam em uma interface + o método de implementação | alta |
| `IPipelineBehavior<,>` | Sem ponto de envoltório genérico; substituído por interface via decorators ou middleware | alta |
| `INotification` + `INotificationHandler<>` | Substituído por um `IEnumerable<IHandler>` injetado para o fan-out ou um agregador de eventos | média |
| Registro `AddMediatR(...)` | Substituído por chamadas explícitas a `AddScoped` (ou uma varredura do Scrutor) | média |
| `RequestHandlerDelegate<T>` em behaviors | Sem equivalente; a cadeia "next" desaparece | média |
| `ISender.CreateStream` (`IStreamRequest`) | Substituído por um método que retorna `IAsyncEnumerable<T>` | baixa |
| Testes unitários que mockam `ISender` | Reapontados para mockar a interface concreta | baixa |

## Lista de verificação prévia

- O SDK do .NET 11 está instalado: confirme com `dotnet --version` (espere `11.x`).
- Você tem um branch de git limpo e uma suíte de testes no verde *antes* de começar. Verifique com `dotnet test` e confirme zero falhas.
- Inventarie a superfície afetada. Execute uma busca e anote as contagens, porque elas dizem o tamanho do trabalho:

```bash
# .NET 11 - inventory MediatR usage before touching anything
grep -rn "IRequestHandler\|IRequest<\|: IRequest" src/      # handlers + requests
grep -rn "IPipelineBehavior" src/                            # the hard part
grep -rn "INotification" src/                                # fan-out
grep -rn "ISender\|IMediator\|\.Send(\|\.Publish(" src/      # call sites
```

- Decida *primeiro* a forma de substituição dos behaviors. Se você tem zero ocorrências de `IPipelineBehavior`, isto é um buscar-e-substituir puro. Se você tem várias, planeje se cada uma vira um decorator, middleware do ASP.NET Core ou um filtro de endpoint.
- Adicione o Scrutor se for usar decorators: `dotnet add package Scrutor` (6.x, licença MIT).

## Passos de migração

1. **Converta cada requisição e handler em uma interface de serviço e um método.**

Uma requisição do MediatR é um tipo de mensagem mais um handler separado. Substitua ambos por uma interface e uma implementação. Agrupe requisições relacionadas em um único serviço em vez de criar uma interface por requisição antiga.

```csharp
// .NET 11, C# 14, MediatR 14.x - BEFORE
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
```

```csharp
// .NET 11, C# 14 - AFTER: plain service, no MediatR reference
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
```

**Verifique:** o arquivo novo não tem `using MediatR;` e o corpo do handler é idêntico byte a byte exceto pela assinatura do método. Os parâmetros do `record` da requisição viram parâmetros do método na mesma ordem.

2. **Substitua as chamadas a `ISender.Send` por chamadas diretas à interface.**

Cada chamador que injetava `ISender` ou `IMediator` agora injeta a interface de serviço específica e chama o método.

```csharp
// .NET 11, C# 14 - BEFORE
public async Task<OrderDto> Get(int id, ISender sender, CancellationToken ct)
    => await sender.Send(new GetOrderById(id), ct);

// AFTER
public async Task<OrderDto> Get(int id, IOrderService orders, CancellationToken ct)
    => await orders.GetByIdAsync(id, ct);
```

**Verifique:** após este passo, `grep -rn "ISender\|IMediator" src/` retorna apenas linhas que você deliberadamente ainda não migrou. A contagem deve marchar em direção a zero.

3. **Registre os serviços explicitamente.**

Remova `AddMediatR(...)` e registre cada serviço. O registro explícito é seguro para trimming e falha rápido na inicialização, que é exatamente o modo de falha por trás de [Unable to resolve service for type while attempting to activate](/pt-br/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/).

```csharp
// .NET 11, C# 14 - BEFORE
builder.Services.AddMediatR(cfg =>
    cfg.RegisterServicesFromAssemblyContaining<GetOrderById>());

// AFTER - explicit, or one Scrutor scan if you prefer convention
builder.Services.AddScoped<IOrderService, OrderService>();
builder.Services.AddScoped<ICustomerService, CustomerService>();
```

Se você quer um registro baseado em convenção sem o modelo de reflexão do MediatR, o Scrutor varre pelo nome da interface:

```csharp
// .NET 11, C# 14, Scrutor 6.x - register every *Service against its interface
builder.Services.Scan(scan => scan
    .FromAssemblyOf<OrderService>()
    .AddClasses(c => c.Where(t => t.Name.EndsWith("Service")))
    .AsImplementedInterfaces()
    .WithScopedLifetime());
```

**Verifique:** a aplicação inicia. Execute-a e acesse um endpoint migrado; um registro ausente agora lança na inicialização, não na primeira requisição. Confirme que nenhum erro de serviço scoped a partir de singleton se infiltrou, a classe de bug coberta em [Cannot consume scoped service from singleton](/pt-br/2026/05/fix-cannot-consume-scoped-service-from-singleton/).

4. **Substitua os pipeline behaviors por decorators ou middleware.**

Este é o único passo que exige julgamento. Um `IPipelineBehavior<,>` envolvia cada requisição em um único lugar. Você tem duas substituições honestas.

Para concerns que são genuinamente por serviço (logging, cache, retentativas), use um decorator do Scrutor:

```csharp
// .NET 11, C# 14, Scrutor 6.x - BEFORE was a generic ValidationBehavior<TRequest,TResponse>
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

// Registration: wrap the real implementation
builder.Services.AddScoped<IOrderService, OrderService>();
builder.Services.Decorate<IOrderService, LoggingOrderService>();
```

Para concerns que na verdade são concerns de HTTP (logging de requisições, mapeamento de exceções para ProblemDetails, autenticação), tire-os completamente da camada de aplicação para middleware do ASP.NET Core ou um filtro de endpoint. Um behavior que capturava exceções e moldava as respostas pertence ao mesmo lugar que [um filtro de exceções global no ASP.NET Core 11](/pt-br/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/), não a um decorator.

Se você usava FluentValidation dentro de um `ValidationBehavior`, mantenha os validadores e chame-os a partir de um único decorator ou de um filtro de endpoint de minimal API:

```csharp
// .NET 11, C# 14 - a validation decorator replacing ValidationBehavior for one interface
public sealed class ValidatingOrderService(
    IOrderService inner,
    IValidator<CreateOrder> validator) : IOrderService
{
    public async Task<OrderDto> CreateAsync(CreateOrder cmd, CancellationToken ct)
    {
        await validator.ValidateAndThrowAsync(cmd, ct);
        return await inner.CreateAsync(cmd, ct);
    }

    public Task<OrderDto> GetByIdAsync(int orderId, CancellationToken ct)
        => inner.GetByIdAsync(orderId, ct);
}
```

**Verifique:** escreva ou mantenha um teste que afirme que o concern transversal ainda executa, por exemplo que um comando inválido lance `ValidationException` antes de tocar o banco de dados. Execute `dotnet test` e confirme que os testes do behavior passam.

5. **Substitua o fan-out de `INotification`.**

O `Publish` do MediatR invocava cada `INotificationHandler<T>`. Substitua-o por um `IEnumerable<T>` injetado de uma pequena interface de handler que você define, e um publicador enxuto.

```csharp
// .NET 11, C# 14 - BEFORE: INotification + handlers, AFTER: explicit fan-out
public interface IOrderPlacedHandler
{
    Task HandleAsync(OrderPlaced evt, CancellationToken ct);
}

public sealed class OrderEventPublisher(IEnumerable<IOrderPlacedHandler> handlers)
{
    public async Task PublishAsync(OrderPlaced evt, CancellationToken ct)
    {
        foreach (var handler in handlers)
            await handler.HandleAsync(evt, ct);
    }
}

// Registration - each handler registered against the interface
builder.Services.AddScoped<IOrderPlacedHandler, SendConfirmationEmail>();
builder.Services.AddScoped<IOrderPlacedHandler, UpdateInventory>();
builder.Services.AddScoped<OrderEventPublisher>();
```

O container te entrega cada handler registrado em `IEnumerable<IOrderPlacedHandler>`, então adicionar um handler é uma única linha de registro, a mesma ergonomia que o MediatR te dava. Se você publica muitos tipos de evento, gere o publicador com um `IEventPublisher<T>` genérico em vez de um por evento.

**Verifique:** afirme que publicar um evento invoca todos os handlers registrados. Um teste com dois handlers falsos que ambos registram uma chamada é suficiente.

6. **Remova o pacote e as últimas referências.**

Uma vez que as chamadas tenham desaparecido, retire a dependência.

```bash
# .NET 11 - remove the package from every project that referenced it
dotnet remove package MediatR
grep -rn "MediatR" src/ || echo "clean"
```

**Verifique:** `grep -rn "MediatR" src/` imprime `clean`. O build não tem `using MediatR;` não resolvido e `dotnet build -c Release` tem sucesso sem avisos sobre um pacote ausente.

## Verificação: o teste de fumaça após a migração

Execute esta lista de cima a baixo e não pule a linha de desempenho:

- `dotnet build -c Release` tem sucesso sem avisos.
- `dotnet test` passa com zero falhas, incluindo os testes de behavior e de fan-out que você adicionou nos passos 4 e 5.
- A aplicação inicia e cada endpoint antes despachado pelo MediatR retorna a mesma resposta que antes. Um registro ausente agora aparece aqui, na inicialização.
- `grep -rn "MediatR" src/` não retorna nada.
- Nenhum aviso de licença aparece nos logs (a verificação de licença do MediatR 13+ registrava um aviso com uma chave não registrada; agora deve ter desaparecido).
- O cold start é igual ou melhor. Se a aplicação é serverless, meça o tempo de inicialização antes e depois; remover a varredura de assemblies não deve piorá-lo.

## Plano de rollback

Esta migração é reversível por commit mas tediosa de desfazer em bloco, então escalone-a. Mantenha cada um dos seis passos como um commit separado, e migre uma fatia vertical de cada vez (uma interface de serviço e seus chamadores) em vez de toda a solução de uma vez. MediatR e serviços simples podem coexistir durante a transição: deixe `AddMediatR` registrado para os handlers não migrados enquanto você converte o resto. Se uma fatia se comportar mal, reverta os commits dessa fatia e o resto da aplicação não é afetado. Aqui não há mudança de dados nem de esquema, então o rollback é puramente um revert de código sem migração a reverter.

## Problemas que encontramos

**A ordem de `IPipelineBehavior` não mapeia de forma limpa para decorators.** O MediatR executa os behaviors na ordem de registro em volta de um único handler. Os decorators do Scrutor se aninham na ordem em que você chama `Decorate`, e o *último* decorator registrado é o envoltório *mais externo*. Erre a ordem e seu decorator de logging executa dentro do seu decorator de validação em vez de em volta dele. Escreva um teste de ordenação por interface decorada.

**Um `ISender` dentro de um handler que chama outro handler vira uma chamada direta ao serviço, e isso pode expor um ciclo.** A indireção do MediatR escondia as dependências entre handlers. Quando `OrderService` injeta `ICustomerService` e `CustomerService` injeta `IOrderService`, o container lança na inicialização com uma dependência circular. Isso é a migração trazendo à tona um problema de design que o MediatR estava mascarando; quebre o ciclo extraindo a lógica compartilhada para um terceiro serviço.

**Requisições de streaming precisam de `IAsyncEnumerable<T>`, não `Task<T>`.** Se você usava `IStreamRequest<T>` e `CreateStream`, o método de substituição retorna `IAsyncEnumerable<T>` e usa `yield return`. Não o colapse em um `Task<List<T>>`; isso muda a semântica de streaming e pode estourar a memória em resultados grandes, a mesma armadilha descrita em [ler um CSV grande no .NET 11 sem ficar sem memória](/pt-br/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/).

**Testes que mockavam `ISender` passam silenciosamente contra nada.** Um teste que configurava `sender.Send(...)` para retornar um valor dará erro de compilação assim que `ISender` desaparecer, o que é bom. Mas um teste que injetava um `IMediator` real e afirmava o comportamento através dele precisa ser reapontado para a interface concreta. Execute novamente a suíte completa, não confie só em um build no verde.

Este é o tipo de racionalização de dependências que compensa da mesma forma que escolher o serializador embutido compensa em [System.Text.Json vs Newtonsoft.Json em 2026](/pt-br/2026/05/system-text-json-vs-newtonsoft-json-in-2026/): uma biblioteca de terceiros a menos no caminho quente, uma pergunta de licenciamento a menos, e código que um colega novo pode navegar sem ter que aprender primeiro uma convenção de despacho.

## Relacionados

- [MediatR vs classes de serviço simples em 2026: a mudança de licença deve te mover?](/pt-br/2026/05/mediatr-vs-plain-service-classes-in-2026/)
- [Migrar do Newtonsoft.Json para System.Text.Json em uma base de código grande](/pt-br/2026/05/migrate-from-newtonsoft-json-to-system-text-json-in-a-large-codebase/)
- [Minimal APIs vs controllers no ASP.NET Core 11](/pt-br/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)
- [Fix: Unable to resolve service for type while attempting to activate](/pt-br/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/)
- [Fix: Cannot consume scoped service from singleton](/pt-br/2026/05/fix-cannot-consume-scoped-service-from-singleton/)

## Fontes

- [AutoMapper and MediatR Commercial Editions Launch Today](https://www.jimmybogard.com/automapper-and-mediatr-commercial-editions-launch-today/) - a mudança de licença de 2025-07-02, o limite da v13.0 e o modelo de licença dupla RPL-1.5 / comercial.
- [Licensing FAQ - Lucky Penny Software](https://luckypennysoftware.com/faq) - os limiares da edição Community de $5,000,000 de receita e $10,000,000 de capital e a verificação de licença que apenas registra no log.
- [LuckyPennySoftware/MediatR no GitHub](https://github.com/LuckyPennySoftware/MediatR) - o código-fonte atual da 14.x, os contratos `IPipelineBehavior` e `INotification` que estão sendo substituídos.
- [Scrutor no GitHub](https://github.com/khellang/Scrutor) - as extensões `Decorate` e `Scan` com licença MIT usadas para substituir behaviors e registrar serviços por convenção.
- [Injeção de dependência no .NET - Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection) - os lifetimes de serviço e a resolução de `IEnumerable<T>` usados para o fan-out de notificações.
