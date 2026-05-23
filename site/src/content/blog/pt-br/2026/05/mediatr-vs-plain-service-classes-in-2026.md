---
title: "MediatR vs classes de serviço simples em 2026: a mudança de licença deveria te mover?"
description: "Para código novo, classes de serviço simples são a melhor opção padrão. A mudança de licença do MediatR de julho de 2025 só importa se você estiver acima do limite Community de 5 milhões de dólares ou recusar o copyleft da RPL-1.5. Mantenha o MediatR quando os pipeline behaviors forem essenciais."
pubDate: 2026-05-23
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

A versão curta: para código novo em .NET 11 em 2026, use por padrão **classes de serviço simples** e recorra ao MediatR somente quando você realmente se apoiar nos seus pipeline behaviors. A mudança de licença de julho de 2025 é uma razão real para reavaliar, mas não é o abismo que alguns pintaram. Se a sua empresa está abaixo de 5.000.000 de dólares de receita bruta anual, você pode continuar usando gratuitamente a versão mais recente do MediatR sob a edição Community, então a questão do licenciamento só força uma decisão para times maiores ou para qualquer um que não queira aceitar o copyleft da RPL-1.5 na licença open source gratuita. A pergunta técnica (você precisa de um mediator afinal?) é a que de fato deveria guiar a escolha, e para a maior parte do despacho de requisições é a indireção, não a biblioteca, que você pode remover.

Versões referenciadas ao longo do texto: MediatR 12.5.0 é a última versão sob a licença Apache 2.0 simples; MediatR 13.0 (lançada em 2025-07-02) e a posterior linha 14.x são distribuídas sob um modelo dual Reciprocal Public License 1.5 / comercial da Lucky Penny Software. O código tem como alvo `<TargetFramework>net11.0</TargetFramework>` com o SDK do .NET 11 e C# 14.

## O que realmente mudou em julho de 2025

MediatR e AutoMapper foram mantidos por anos por Jimmy Bogard com uma licença permissiva de código aberto. Em 2025-07-02 ele transferiu ambos para uma nova empresa, a Lucky Penny Software, e mudou o modelo de licenciamento. Os mecanismos que importam para a sua decisão:

- **As versões antigas continuam gratuitas para sempre.** MediatR 12.x e anteriores permanecem sob Apache 2.0 (MIT para alguns artefatos mais antigos) e não são relicenciados retroativamente. Você pode fixar `12.5.0` e nunca pagar. O problema é que você não recebe atualizações de segurança, nem correções, nem suporte para essa linha.
- **As versões novas têm licença dual.** MediatR 13.0 e posteriores são oferecidos sob a Reciprocal Public License 1.5 (RPL-1.5) para uso de código aberto, ou uma licença comercial paga.
- **Existe uma edição Community gratuita.** Empresas e indivíduos abaixo de 5.000.000 USD de receita bruta anual (e que não tenham recebido mais de 10.000.000 em capital externo), organizações sem fins lucrativos abaixo do mesmo orçamento, uso educacional e ambientes não produtivos qualificam todos para usar gratuitamente a versão mais recente do MediatR sob o nível Community do acordo comercial.
- **Os níveis pagos são baseados no tamanho do time.** Standard (1-10 desenvolvedores), Professional (11-50) e Enterprise (ilimitado), faturados mensal ou anualmente, contando apenas os desenvolvedores com "acesso programático" que escrevem ou compilam código que chama o MediatR.
- **A verificação de licença apenas registra.** Uma chave expirada ou ausente produz avisos no log, não uma falha em tempo de execução. Sem bloqueio de recursos, sem desempenho degradado, sem servidor de licença nem chamada de rede.

Então a bifurcação prática é esta. Uma equipe pequena abaixo de 5 M? Você pode permanecer gratuitamente na versão atual do MediatR, e o único atrito é o aviso no log até você registrar uma chave Community. Maior ou bem financiado? Você ou paga, ou aceita as obrigações recíprocas da RPL-1.5, ou sai. Esse terceiro grupo é exatamente quem deveria estar lendo uma comparação "vs classes de serviço simples".

## A matriz de recursos num relance

| Aspecto | MediatR 13+ | Classes de serviço simples |
| ------- | ----------- | -------------------------- |
| Despacho de requisições | Indireção com `ISender.Send` | Chamada direta a um método de uma interface injetada |
| Preocupações transversais | `IPipelineBehavior<,>` de primeira classe | Decoradores (Scrutor) ou chamadas explícitas |
| Ir para definição a partir do chamador | Cai em `Send`, não no handler | Cai na implementação |
| Segurança de ligação em compilação | Resolução em tempo de execução, pode falhar na primeira chamada | Injeção por construtor, falha ao iniciar |
| Notificações / fan-out | Publicação `INotification` integrada | Lista de handlers feita à mão |
| Custo de inicialização | Varredura de assemblies para registrar handlers | Nenhum além do registro normal de DI |
| Sobrecarga por chamada | Alocação de wrapper + busca em dicionário + despacho virtual | Quase zero, o JIT pode desvirtualizar |
| Native AOT / trimming | Requer cuidado, registro baseado em reflexão | Limpo |
| Licença (acima de 5 M de receita) | Compra comercial ou RPL-1.5 | Nenhuma, é o seu próprio código |
| Código novo em 2026 | Só se os behaviors forem essenciais | A opção padrão |

A linha que decide a maioria das discussões é "preocupações transversais". Quase tudo o mais nessa tabela favorece as classes de serviço simples. O valor genuíno e difícil de substituir do MediatR é o pipeline: um único lugar para envolver cada requisição com validação, log, transações e cache. Se você não usa esse pipeline, está pagando o custo de indireção e de licença por um localizador de serviços glorificado.

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

A versão simples é mais curta e, o que é crucial, pressionar ir para definição em `orders.GetByIdAsync` te leva ao método que executa. Com `sender.Send(new GetOrderById(id))` você cai no `Send` do MediatR, e navega até o handler adivinhando ou com um desvio de "encontrar implementações". Em um time pequeno essa diferença é leve. Em uma base de código grande com centenas de handlers, a perda de navegabilidade direta é um imposto real e diário que o modelo do MediatR impõe em troca de desacoplar o chamador do tipo do handler. Se esse desacoplamento te traz algo depende de se alguém um dia troca um handler sem tocar no chamador, o que na prática é raro.

O registro também merece uma comparação. O MediatR varre assemblies ao iniciar; as classes de serviço simples se registram de forma explícita, e você obtém uma falha em tempo de inicialização (não na primeira requisição) se esquecer alguma, o que se relaciona diretamente com o tipo de erros por trás de [Unable to resolve service for type while attempting to activate](/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/).

```csharp
// .NET 11, C# 14 - registration, side by side
// MediatR: scan an assembly, register every handler reflectively
builder.Services.AddMediatR(cfg =>
    cfg.RegisterServicesFromAssemblyContaining<GetOrderById>());

// Plain: explicit, trim-friendly, fails fast at startup if a dep is missing
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

A troca é honesta: o behavior do MediatR é genérico sobre cada requisição com um único registro, ao passo que um decorador é por interface. Se você tem uma ou duas preocupações transversais e um punhado de interfaces de serviço, os decoradores ganham em clareza. Se você tem dez behaviors que precisam se aplicar de forma uniforme a duzentos tipos de requisição, o pipeline genérico do MediatR é genuinamente menos código, e esse é o cenário em que ficar (e pagar, ou qualificar para Community) é defensável. Para preocupações no nível da requisição que na verdade são preocupações de HTTP, note que parte do que as pessoas colocam em behaviors pertence ao middleware ou aos filtros, a mesma superfície coberta por [adicionar um filtro global de exceções no ASP.NET Core 11](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/).

## Quanto o despacho custa de verdade

O desempenho é o argumento mais fraco em qualquer direção, e você não deveria escolher só por ele, mas vale a pena saber onde o custo vive para que ninguém faça afirmações vagas. Uma chamada a uma interface simples é um único despacho virtual que o JIT muitas vezes pode desvirtualizar e colocar inline; não aloca nada e custa da ordem de um nanossegundo. Um `Send` do MediatR faz mais trabalho por chamada: ele procura o tipo da requisição em um cache de handlers, constrói ou recupera um `RequestHandlerWrapper`, percorre a cadeia de behaviors via delegates e resolve o handler a partir do contêiner. Isso é da ordem de dezenas de nanossegundos mais uma pequena alocação por envio, antes de o corpo do seu handler executar.

| Aspecto | `Send` do MediatR | Chamada a interface simples |
| ------- | ----------------- | --------------------------- |
| Resolução tipo-para-handler | Busca em dicionário por chamada | Nenhuma, ligada na injeção |
| Cadeia wrapper / delegate | Alocada por envio | Nenhuma |
| Desvirtualização pelo JIT | Não | Frequentemente sim |
| Varredura de assemblies ao iniciar | Sim, cresce com o número de handlers | Nenhuma |
| Ordem de grandeza por chamada | Dezenas de ns + pequena alocação | ~1 ns, zero alocação |

A honestidade metodológica aqui: contra um handler que toca um banco de dados ou a rede, dezenas de nanossegundos são invisíveis, e você deveria medir as suas próprias formas de objeto com BenchmarkDotNet em vez de confiar em um número genérico. O custo que de fato aparece na prática é a inicialização. Varrer assemblies para registrar centenas de handlers adiciona milissegundos mensuráveis à inicialização a frio, o que importa para serverless e é o tipo de coisa contra a qual você luta ao [reduzir o tempo de inicialização a frio de uma AWS Lambda com .NET 11](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/). O registro explícito e simples evita isso por completo e é mais amigável com o trimming e o Native AOT, porque não há descoberta reflexiva para manter segura ao trimming.

## O detalhe que decide por você

Algumas restrições resolvem isso antes de o gosto arquitetural entrar em cena.

**A RPL-1.5 é a verdadeira força decisória, não o preço.** A opção gratuita de código aberto no MediatR 13+ é a Reciprocal Public License 1.5, que carrega obrigações de copyleft recíprocas: ela é projetada para fechar a brecha do SaaS, então implantar um serviço de rede construído sobre código licenciado sob RPL pode te obrigar a disponibilizar o seu código-fonte. Se você distribui software comercial de código fechado e está acima do limite Community, a licença OSS gratuita não é realmente utilizável para você, e "o MediatR ainda é open source" é enganoso no seu caso. Você ou compra a licença comercial ou sai. Para um despachador fino que você na verdade não estava usando, sair é fácil.

**A linha de 5 M de receita e 10 M de capital é generosa.** A maioria dos times de produto pequenos, consultorias e startups fica abaixo dela e pode continuar usando gratuitamente a versão mais nova do MediatR sob a edição Community. Se esse é você, a licença não é razão para arrancar nada; registre uma chave Community, silencie o aviso e siga em frente. Gastar um sprint removendo o MediatR para evitar uma conta que você não deve é a troca errada.

**Fixar 12.5.0 é uma opção real com um custo real.** Apache 2.0 na última versão gratuita não expira. Mas você congela em uma versão que não recebe patches de segurança, e herda você mesmo o risco de manutenção. Isso é aceitável para um app interno estável e perigoso para qualquer coisa exposta à internet.

**Se você só chama `Send`, você não precisa de um mediator.** O teste honesto: abra a sua solução e procure `IPipelineBehavior` e `INotification`. Se há zero behaviors e você não publica notificações, o MediatR está funcionando como uma camada de indireção sobre chamadas de método, e removê-lo é uma refatoração mecânica que torna o código mais navegável, remove uma dependência e apaga a questão da licença em um único movimento. Esse é o mesmo instinto de racionalização de bibliotecas por trás de escolher a opção embutida em [System.Text.Json vs Newtonsoft.Json em 2026](/2026/05/system-text-json-vs-newtonsoft-json-in-2026/).

## A decisão, em uma linha

Para código novo em .NET 11 em 2026, escreva classes de serviço simples e injete as interfaces diretamente: você ganha ir para definição, ligação de inicialização que falha rápido, sem sobrecarga por chamada, amizade com o trimming e zero exposição a licenças. Mantenha o MediatR só quando os seus pipeline behaviors estiverem fazendo trabalho real e uniforme através de muitos tipos de requisição, e nesse caso decida deliberadamente: fique gratuitamente sob a edição Community se você está abaixo de 5 M, pague se você está acima e o pipeline justifica a conta, e fixe 12.5.0 apenas como medida paliativa. O erro é tratar "o MediatR ficou comercial" ou como um não-evento ou como um alarme de cinco sinos. Não é nenhum dos dois. É um aviso para perguntar se você precisava do mediator em primeiro lugar, e para a maior parte do código de despacho de requisições a resposta sempre foi não.

## Relacionados

- [Minimal APIs vs controllers in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)
- [Fix: Unable to resolve service for type while attempting to activate](/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/)
- [Fix: Cannot consume scoped service from singleton](/2026/05/fix-cannot-consume-scoped-service-from-singleton/)
- [HttpClient vs HttpClientFactory vs Refit](/2026/05/httpclient-vs-httpclientfactory-vs-refit/)
- [System.Text.Json vs Newtonsoft.Json em 2026](/2026/05/system-text-json-vs-newtonsoft-json-in-2026/)

## Fontes

- [AutoMapper and MediatR Commercial Editions Launch Today](https://www.jimmybogard.com/automapper-and-mediatr-commercial-editions-launch-today/) - o anúncio de lançamento de 2025-07-02, o limite da v13.0 e o modelo dual RPL-1.5 / comercial.
- [Licensing FAQ - Lucky Penny Software](https://luckypennysoftware.com/faq) - os limites Community de 5.000.000 de receita e 10.000.000 de capital, a contagem de desenvolvedores por "acesso programático" e a verificação de licença apenas de log.
- [MediatR commercial version launched (Discussion #1123)](https://github.com/LuckyPennySoftware/MediatR/discussions/1123) - confirmação de que as versões antigas permanecem sob a sua licença de código aberto original.
- [LuckyPennySoftware/MediatR v13.0.0 release](https://github.com/LuckyPennySoftware/MediatR/releases/tag/v13.0.0) - a primeira versão com licença dual.
- [Scrutor no GitHub](https://github.com/khellang/Scrutor) - a extensão `Decorate` licenciada sob MIT usada para substituir pipeline behaviors por decoradores.
</content>
