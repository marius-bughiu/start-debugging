---
title: "Migrar do MediatR para injeção de dependência simples no .NET 11"
description: "Uma lista de verificação passo a passo para remover o MediatR 12-14 e substituir os handlers de IRequest, ISender, os pipeline behaviors e INotification por classes de serviço simples e injeção por construtor."
pubDate: 2026-05-30
updatedDate: 2026-11-02
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

Migre uma requisição por vez. Substitua seu handler por um método de serviço, atualize os chamadores e preserve validação, transações e notificações. Estime o trabalho a partir das dependências e dos pontos de chamada antes de alterar os registros.

**Correção — 2 de novembro de 2026:** corrigimos a fase da falha de DI e os critérios Community, retiramos afirmações não medidas sobre a partida a frio e ajustamos o decorador ao contrato de escrita.

Os exemplos têm como destino `net11.0` e ilustram os contratos do MediatR 13/14. A verificação de DI abaixo foi executada no .NET 10. Se a arquitetura ainda está em discussão, comece pela [comparação entre MediatR e serviços diretos](/pt-br/2026/05/mediatr-vs-plain-service-classes-in-2026/).

## Por que as equipes estão removendo o MediatR justamente agora

- Levante as versões do MediatR em uso e confira os [critérios do fornecedor](https://luckypennysoftware.com/faq), inclusive financiamento e uso institucional, antes de tratar a licença como motivo para migrar.
- Numa chamada de interface, ir à definição leva ao método da interface, e a IDE permite localizar as implementações. A partir de `Send`, procure o handler do tipo de requisição.
- Se o tempo de inicialização influencia a migração, meça a partida a frio da mesma implantação antes e depois. Verifique a aplicação publicada se precisar de trimming ou Native AOT.

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

Remova `AddMediatR(...)` após converter os handlers restantes. Registre explicitamente as interfaces e implementações substitutas. As [dependências de construtor ausentes](/pt-br/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/) aparecem na validação ou na resolução. Confira os registros no ambiente de implantação. Habilite `ValidateOnBuild` para o provedor padrão verificar os grafos de construtores registrados durante a construção do host. Em produção, sem validação, uma dependência ausente pode falhar só ao solicitar o serviço. `ValidateScopes` verifica os tempos de vida separadamente. Veja as [opções do provedor do ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis?view=aspnetcore-10.0#validatescopes-and-validateonbuild).

```csharp
// .NET 11, C# 14 - BEFORE
builder.Services.AddMediatR(cfg =>
    cfg.RegisterServicesFromAssemblyContaining<GetOrderById>());

// AFTER - explicit, or one Scrutor scan if you prefer convention
builder.Services.AddScoped<IOrderService, OrderService>();
builder.Services.AddScoped<ICustomerService, CustomerService>();
```

Para registro por convenção, o Scrutor pode examinar um assembly e selecionar nomes de classe:

```csharp
// .NET 11, C# 14, Scrutor 6.x - register every *Service against its interface
builder.Services.Scan(scan => scan
    .FromAssemblyOf<OrderService>()
    .AddClasses(c => c.Where(t => t.Name.EndsWith("Service")))
    .AsImplementedInterfaces()
    .WithScopedLifetime());
```

No teste em .NET 10, habilitar explicitamente `ValidateOnBuild` fez a construção do host falhar por uma dependência ausente. Desabilitar a opção permitiu construir o host e a falha ocorreu quando um escopo solicitou `IOrderService`. Resolva cada serviço migrado dentro de um escopo e chame o endpoint.

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

Para uma operação de escrita, dê ao decorador o contrato próprio `IOrderWriter`. O `IOrderService` de leitura pode manter `GetByIdAsync`.

```csharp
using FluentValidation;

public interface IOrderWriter
{
    Task<OrderDto> CreateAsync(CreateOrder command, CancellationToken ct);
}

public sealed class ValidatingOrderWriter(
    IOrderWriter inner,
    IValidator<CreateOrder> validator) : IOrderWriter
{
    public async Task<OrderDto> CreateAsync(CreateOrder command, CancellationToken ct)
    {
        await validator.ValidateAndThrowAsync(command, ct);
        return await inner.CreateAsync(command, ct);
    }
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
- Inicie a aplicação e chame cada endpoint migrado. Confira a resposta e a resolução dos serviços scoped.
- `grep -rn "MediatR" src/` não retorna nada.
- Nenhum aviso de licença aparece nos logs (a verificação de licença do MediatR 13+ registrava um aviso com uma chave não registrada; agora deve ter desaparecido).
- Compare a partida a frio antes e depois com o perfil de publicação que será entregue.

## Plano de rollback

Esta migração é reversível por commit mas tediosa de desfazer em bloco, então escalone-a. Mantenha cada um dos seis passos como um commit separado, e migre uma fatia vertical de cada vez (uma interface de serviço e seus chamadores) em vez de toda a solução de uma vez. MediatR e serviços simples podem coexistir durante a transição: deixe `AddMediatR` registrado para os handlers não migrados enquanto você converte o resto. Se uma fatia se comportar mal, reverta os commits dessa fatia e o resto da aplicação não é afetado. Aqui não há mudança de dados nem de esquema, então o rollback é puramente um revert de código sem migração a reverter.

## Problemas que encontramos

**A ordem de `IPipelineBehavior` não mapeia de forma limpa para decorators.** O MediatR executa os behaviors na ordem de registro em volta de um único handler. Os decorators do Scrutor se aninham na ordem em que você chama `Decorate`, e o *último* decorator registrado é o envoltório *mais externo*. Erre a ordem e seu decorator de logging executa dentro do seu decorator de validação em vez de em volta dele. Escreva um teste de ordenação por interface decorada.

Um ciclo pode aparecer na validação do grafo registrado ou na resolução dos serviços. Se `OrderService` e `CustomerService` dependem um do outro, extraia a operação compartilhada para um terceiro serviço.

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
