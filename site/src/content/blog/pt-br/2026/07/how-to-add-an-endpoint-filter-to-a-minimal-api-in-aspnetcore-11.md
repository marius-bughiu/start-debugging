---
title: "Como adicionar um endpoint filter a uma minimal API no ASP.NET Core 11"
description: "Um guia completo e funcional de endpoint filters em uma minimal API do ASP.NET Core 11: AddEndpointFilter com um delegate em linha, classes IEndpointFilter com injeção de dependência, GetArgument e a lista Arguments, curto-circuito com Results.Problem, ordem FIFO/FILO entre vários filtros, filtros no nível do grupo com MapGroup e AddEndpointFilterFactory para filtros que dependem da assinatura."
pubDate: 2026-07-19
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-api"
  - "validation"
lang: "pt-br"
translationOf: "2026/07/how-to-add-an-endpoint-filter-to-a-minimal-api-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-19
---

Para adicionar um endpoint filter a uma minimal API no ASP.NET Core 11, você chama `.AddEndpointFilter()` no endpoint (ou no grupo de rotas) e passa um delegate em linha `async (context, next) => ...` ou uma classe que implementa `IEndpointFilter`. O filtro roda depois da vinculação do modelo e antes do seu handler, ele enxerga os argumentos vinculados através de `context.GetArgument<T>(index)`, e ou chama `await next(context)` para continuar, ou retorna um valor como `Results.Problem(...)` para curto-circuitar a requisição. Esse é o modelo inteiro. Este post o percorre de ponta a ponta: a forma em linha, a forma com classe e injeção de dependência, a ordem quando você empilha vários filtros, a aplicação de um filtro a um `MapGroup` inteiro e a saída de emergência da factory de filtros. Ele tem como alvo o .NET 11 (Preview 6 no momento em que isto foi escrito, com GA em novembro de 2026) com `Microsoft.NET.Sdk.Web` e C# 14, mas os endpoint filters são estáveis desde o ASP.NET Core 7, então cada exemplo aqui roda sem alterações no .NET 8, 9 e 10.

## O que um endpoint filter de fato envolve

Um endpoint filter é um pedaço de código que envolve a invocação de um único route handler. Diferente do middleware, que roda para toda requisição que passa por aquele ponto do pipeline, tendo uma rota correspondido ou não, um filtro roda somente quando o seu endpoint é selecionado. E diferente do middleware, um filtro roda depois do roteamento e depois da vinculação de parâmetros, então quando ele executa, o framework já analisou os valores de rota, vinculou o corpo da requisição e resolveu os argumentos do handler. Esse momento é toda a razão de existir dos filtros: você pode inspecionar e até mutar os argumentos exatos que o seu handler está prestes a receber, e você pode inspecionar ou substituir o resultado que ele produziu, tudo sem tocar no handler.

Concretamente, um filtro pode fazer três coisas:

- Rodar código antes do handler (validar argumentos, registrar em log, iniciar um cronômetro).
- Curto-circuitar: retornar um resultado em vez de chamar o handler.
- Rodar código depois do handler, incluindo inspecionar ou substituir o valor de retorno dele.

Isso se encaixa perfeitamente com validação, log por endpoint, modelagem de requisições e preocupações transversais leves que não merecem seu próprio middleware.

## Passos para adicionar um endpoint filter

1. Registre seus serviços e faça o build da aplicação como de costume com `WebApplication.CreateBuilder(args)`.
2. Mapeie um endpoint com `MapGet`, `MapPost` ou um `MapGroup`.
3. Encadeie `.AddEndpointFilter(...)` no builder retornado, passando um delegate em linha ou um tipo `IEndpointFilter`.
4. Dentro do filtro, leia os argumentos com `context.GetArgument<T>(index)` e decida se continua.
5. Chame `await next(context)` para rodar o handler, ou retorne um valor (por exemplo `Results.Problem(...)`) para curto-circuitar.

O restante deste artigo expande cada um desses pontos em código funcional.

## A forma com delegate em linha

A maneira mais rápida de adicionar um filtro é um delegate em linha. Ele recebe dois parâmetros: o `EndpointFilterInvocationContext` (que expõe o `HttpContext` e os `Arguments` vinculados) e `next`, um `EndpointFilterDelegate` que você invoca para continuar o pipeline.

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

var app = builder.Build();

string ColorName(string color) => $"Color specified: {color}";

app.MapGet("/color/{color}", ColorName)
    .AddEndpointFilter(async (context, next) =>
    {
        var color = context.GetArgument<string>(0);

        if (color == "Red")
        {
            // Short-circuit: the handler never runs.
            return Results.Problem("Red is not allowed.");
        }

        // Continue to the next filter, or the handler if this is the last one.
        return await next(context);
    });

app.Run();
```

`context.GetArgument<string>(0)` extrai o primeiro argumento passado para `ColorName`, que é `color`. O índice é posicional: ele corresponde à ordem em que os parâmetros aparecem na declaração do handler, não à ordem dos segmentos do template de rota. Se você preferir não contar posições, `context.Arguments` é um `IList<object?>` que você pode iterar, e `GetArguments()` retorna a mesma lista.

O tipo de retorno de um filtro é `ValueTask<object?>`. Retornar `Results.Problem(...)` (ou qualquer `IResult`) curto-circuita e esse resultado é escrito na resposta. Retornar `await next(context)` roda o handler e passa o resultado dele de volta pela cadeia. Como o valor de retorno flui de volta por cada filtro, você também pode transformá-lo na saída.

## A forma com classe IEndpointFilter, com injeção de dependência

Delegates em linha são perfeitos para lógica pontual, mas um filtro que você quer reutilizar entre endpoints pertence a uma classe. Implemente `IEndpointFilter`, que tem um único método:

```csharp
// .NET 11, C# 14
public class ValidationFilter<T> : IEndpointFilter where T : class
{
    private readonly ILogger<ValidationFilter<T>> _logger;

    public ValidationFilter(ILogger<ValidationFilter<T>> logger)
    {
        _logger = logger;
    }

    public async ValueTask<object?> InvokeAsync(
        EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var model = context.Arguments.OfType<T>().FirstOrDefault();

        if (model is null)
        {
            return Results.Problem($"No {typeof(T).Name} argument found.");
        }

        var errors = Validate(model);
        if (errors.Count > 0)
        {
            _logger.LogWarning("Validation failed for {Type}", typeof(T).Name);
            return Results.ValidationProblem(errors);
        }

        return await next(context);
    }

    private static Dictionary<string, string[]> Validate(T model) => new();
}
```

Registre-o com a sobrecarga genérica:

```csharp
// .NET 11, C# 14
app.MapPost("/products", (Product product) => Results.Created($"/products/{product.Id}", product))
    .AddEndpointFilter<ValidationFilter<Product>>();
```

Duas coisas sobre como essa classe é construída importam. Primeira, as dependências do construtor do filtro (`ILogger<T>` acima) são resolvidas a partir do contêiner de injeção de dependência, então você pode injetar loggers, options ou qualquer serviço registrado. Segunda, e isso pega as pessoas de surpresa: o tipo do filtro em si não é resolvido como um serviço. Você não registra `ValidationFilter<Product>` em `builder.Services`. O framework o ativa para você e satisfaz seu construtor a partir da injeção de dependência, mas ele não é um serviço singleton ou scoped gerenciado pelo contêiner. Se você tentar `builder.Services.AddScoped<ValidationFilter<Product>>()` esperando que `AddEndpointFilter<T>()` o pegue do contêiner, esse registro é simplesmente ignorado.

Usar `Results.ValidationProblem` aqui produz um corpo de problem-details conforme a RFC 9457 com um dicionário de erros no estilo `422`. Se você quer controlar esse formato de forma centralizada em vez de por filtro, é exatamente para isso que serve uma [configuração de IProblemDetailsService](/pt-br/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/).

## Quando você empilha filtros, a ordem é FIFO na entrada e FILO na saída

Você pode anexar mais de um filtro a um endpoint, e a ordem é a parte mais confusa do recurso até você ter visto isso uma vez. A regra: o código antes de `next` roda na ordem em que você registrou os filtros (primeiro a entrar, primeiro a sair); o código depois de `next` roda na ordem inversa (primeiro a entrar, último a sair). Ele aninha como uma pilha.

```csharp
// .NET 11, C# 14
app.MapGet("/demo", () =>
    {
        app.Logger.LogInformation("        Handler");
        return "done";
    })
    .AddEndpointFilter(async (context, next) =>
    {
        app.Logger.LogInformation("Before A");
        var result = await next(context);
        app.Logger.LogInformation("After A");
        return result;
    })
    .AddEndpointFilter(async (context, next) =>
    {
        app.Logger.LogInformation("    Before B");
        var result = await next(context);
        app.Logger.LogInformation("    After B");
        return result;
    });
```

Isso registra:

```dotnetcli
Before A
    Before B
        Handler
    After B
After A
```

Então o primeiro filtro que você adiciona é o invólucro mais externo. Se você quer que uma barreira no estilo de autenticação rode antes de um filtro de log, adicione a barreira primeiro. Se um filtro curto-circuita retornando sem chamar `next`, todo filtro registrado depois dele é ignorado, e os que estão antes dele ainda rodam seu código posterior ao `next` porque o `await next(context)` deles retorna o resultado do curto-circuito. É por isso que um filtro de validação inicial pode rejeitar uma requisição com segurança: tudo o que está a jusante, incluindo o handler, nunca roda.

## Mutando argumentos antes de o handler vê-los

Como um filtro roda depois da vinculação, ele pode alterar os argumentos no lugar e o handler recebe os valores modificados. A lista `Arguments` é mutável. Isso é genuinamente útil para normalização: aparar strings, colocar um código em maiúsculas, limitar um tamanho de página.

```csharp
// .NET 11, C# 14
app.MapGet("/search", (string q, int pageSize) => new { q, pageSize })
    .AddEndpointFilter(async (context, next) =>
    {
        // Normalize the query and clamp the page size before the handler runs.
        if (context.Arguments[0] is string q)
        {
            context.Arguments[0] = q.Trim();
        }
        if (context.Arguments[1] is int size)
        {
            context.Arguments[1] = Math.Clamp(size, 1, 100);
        }

        return await next(context);
    });
```

Mantenha uma ressalva em mente: mutar por índice posicional acopla o filtro à ordem dos parâmetros do handler. Um filtro genérico e reutilizável fica melhor se corresponder por tipo (`context.Arguments.OfType<T>()`) ou ler diretamente do `HttpContext`, que é o que torna o `ValidationFilter<T>` baseado em classe acima independente do endpoint.

## Aplicar um filtro a um grupo de rotas inteiro

Repetir `.AddEndpointFilter<...>()` em cada endpoint é ruído. Como `MapGroup` retorna um `RouteGroupBuilder` que carrega as convenções para seus filhos, um filtro adicionado ao grupo roda para cada endpoint dentro dele. Isso se compõe com os módulos de endpoints por recurso de [organizar endpoints de minimal API com MapGroup](/pt-br/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/):

```csharp
// .NET 11, C# 14
var products = app.MapGroup("/products")
    .AddEndpointFilter<ValidationFilter<Product>>();

products.MapPost("/", (Product p) => Results.Created($"/products/{p.Id}", p));
products.MapPut("/{id:int}", (int id, Product p) => Results.NoContent());
```

Filtros de grupo e filtros de endpoint se combinam, e a ordem segue a mesma regra de aninhamento com os filtros do grupo na parte externa. Um filtro no grupo envolve um filtro adicionado a um endpoint individual dentro dele. Você também pode aninhar grupos, e cada nível adiciona outra camada.

Se você quer que um filtro se aplique à aplicação inteira em vez de a um grupo nomeado, adicione-o a um grupo que cobre a raiz: `app.MapGroup("").AddEndpointFilter(...)`. Não há um registro separado de "filtro global", mas um grupo raiz é o equivalente idiomático, e ele mantém os filtros restritos aos endpoints roteados em vez de transformá-los em middleware.

## A forma de factory para filtros que dependem da assinatura

`AddEndpointFilterFactory` é a porta avançada. Em vez de uma instância de filtro, você fornece uma factory que roda uma vez por endpoint na inicialização, recebe um `EndpointFilterFactoryContext` com o `MethodInfo` do handler e retorna o delegate de filtro real. Isso permite inspecionar a assinatura do handler e construir um filtro especializado, ou cachear resultados de reflexão para que sejam calculados uma única vez em vez de por requisição.

```csharp
// .NET 11, C# 14 -- only attach the validation logic when the handler takes a Product first
app.MapPost("/products", (Product product) =>
        Results.Created($"/products/{product.Id}", product))
    .AddEndpointFilterFactory((factoryContext, next) =>
    {
        var parameters = factoryContext.MethodInfo.GetParameters();
        var isProductFirst = parameters.Length >= 1
            && parameters[0].ParameterType == typeof(Product);

        if (!isProductFirst)
        {
            // Pass-through: no per-request cost for endpoints that do not match.
            return context => next(context);
        }

        return async context =>
        {
            var product = context.GetArgument<Product>(0);
            if (string.IsNullOrWhiteSpace(product.Name))
            {
                return Results.Problem("Name is required.");
            }
            return await next(context);
        };
    });
```

O ganho aqui é que a inspeção do `MethodInfo` acontece uma vez em tempo de build, não a cada requisição, e endpoints cuja assinatura não corresponde não pagam nada além de um delegate de passagem direta. Recorra à factory somente quando um filtro simples não conseguir expressar o que você precisa; para o caso comum de validar e continuar, a forma com classe é mais simples e lê melhor.

## Filtros não são middleware, nem action filters

Duas comparações esclarecem a maior parte da confusão restante. Contra o middleware: um endpoint filter roda somente para o seu endpoint e somente depois da vinculação, então ele pode enxergar argumentos tipados; o middleware roda para um ramo inteiro do pipeline e só enxerga o `HttpContext` bruto. Se sua lógica precisa do modelo vinculado, ela quer um filtro. Se ela precisa rodar antes do roteamento ou através de muitos endpoints não relacionados, ela quer middleware. Contra os action filters do MVC (`IActionFilter`, `IAsyncActionFilter`): os endpoint filters são o equivalente em minimal API, mas são um tipo diferente em um namespace diferente. Você não pode reutilizar um action filter do MVC em um endpoint de minimal API. A única ponte que a Microsoft fornece é que `AddEndpointFilter` também funciona no `ControllerActionEndpointConventionBuilder` de um controlador, então um único delegate de endpoint filter pode ser compartilhado entre endpoints de minimal API e actions de controlador se você rotear ambos.

Mais uma nota prática: como um filtro pode curto-circuitar com um `IResult`, ele combina naturalmente com resultados tipados. Se o seu handler retorna uma [união Results tipada](/pt-br/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/), um filtro que retorna `Results.Problem` ainda se encaixa perfeitamente, já que o tipo de retorno do filtro é `object?` e qualquer `IResult` é escrito na resposta. E para validação genuinamente pesada, pese um filtro contra a [validação de requisições integrada](/pt-br/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/) que o ASP.NET Core 11 pode rodar a partir de data annotations sem nenhum filtro.

## O formato para lembrar

Adicionar um endpoint filter se resume a `.AddEndpointFilter(...)` em um endpoint ou um `MapGroup`, um delegate em linha para casos pontuais ou uma classe `IEndpointFilter` para reutilização, `context.GetArgument<T>(index)` (ou `context.Arguments`) para ler os valores vinculados, e `await next(context)` para continuar versus retornar um `IResult` para curto-circuitar. Lembre-se de que as dependências do construtor vêm da injeção de dependência mas o tipo do filtro em si não é um serviço registrado, que filtros empilhados aninham FIFO na entrada e FILO na saída, que filtros de grupo envolvem filtros de endpoint, e que `AddEndpointFilterFactory` existe para o caso raro em que você precisa inspecionar a assinatura do handler. Essa é toda a superfície, e cada linha acima roda no .NET 8 até o .NET 11 sem alterações.

## Relacionado

- [Como organizar endpoints de minimal API com MapGroup no ASP.NET Core 11](/pt-br/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [Como validar corpos de requisição em minimal APIs sem controladores no ASP.NET Core 11](/pt-br/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/)
- [Como personalizar as respostas de erro de validação de minimal API com IProblemDetailsService no ASP.NET Core 11](/pt-br/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/)
- [Como retornar uma união Results tipada de um endpoint de minimal API no ASP.NET Core 11](/pt-br/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/)
- [Minimal APIs vs controladores no ASP.NET Core 11](/pt-br/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)

## Fontes

- [Filters in Minimal API apps (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/min-api-filters)
- [IEndpointFilter interface (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.iendpointfilter)
- [EndpointFilterInvocationContext (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.endpointfilterinvocationcontext)
- [RouteHandlerBuilderExtensions.AddEndpointFilter (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.endpointfilterextensions)
