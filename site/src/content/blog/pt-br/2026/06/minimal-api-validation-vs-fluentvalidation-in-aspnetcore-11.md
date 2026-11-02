---
title: "Validação de minimal API vs FluentValidation no ASP.NET Core 11: qual você deve escolher?"
description: "Compare validação integrada de Minimal APIs e FluentValidation: regras assíncronas, filtros de endpoints, diferenças de versão e licença."
pubDate: 2026-06-15
updatedDate: 2026-11-02
template: vs
tags:
  - "comparison"
  - "aspnetcore"
  - "dotnet-11"
  - "minimal-apis"
  - "validation"
lang: "pt-br"
translationOf: "2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-06-15
---

O ASP.NET Core 10 introduziu validação integrada para Minimal APIs com `AddValidation()`. O .NET 11 amplia esse suporte: o Preview 6 adicionou `AsyncValidationAttribute` e `IAsyncValidatableObject` às Minimal APIs. Portanto, precisar de validação assíncrona não exige, por si só, FluentValidation no .NET 11.

**Correção — 2 de novembro de 2026:** a comparação agora considera a validação assíncrona integrada do .NET 11. Os exemplos síncronos abaixo foram verificados com o SDK 10.0.302 e FluentValidation 12.1.1; não há alegação de execução no .NET 11 nem de resultados de benchmark.

## Validação integrada

DataAnnotations mantém restrições simples junto do modelo. Em um projeto com Web SDK, registre a validação e mapeie o endpoint:

```csharp
// Program.cs: Microsoft.NET.Sdk.Web, net10.0 or later.
using System.ComponentModel.DataAnnotations;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddValidation();
var app = builder.Build();

app.MapPost("/products", (CreateProduct product) =>
    TypedResults.Created($"/products/{product.Sku}", product));

app.Run();

public record CreateProduct(
    [Required, Length(3, 20)] string Sku,
    [Required, MinLength(2)] string Name,
    [Range(1, 10_000)] int Quantity);
```

Entradas inválidas geram uma resposta 400 de problemas de validação antes da execução do handler. O gerador reconhece os atributos dos parâmetros desse record posicional. Uma biblioteca de classes comum que declara modelos precisa do pacote `Microsoft.Extensions.Validation` e do registro por assembly descrito na documentação.

O pipeline integrado do .NET 10 é síncrono. Para validação assíncrona no .NET 11, use as APIs documentadas e confira a versão específica implantada. Consultas externas ainda precisam de cancelamento e limites de duração; a unicidade também deve ser garantida na gravação dos dados.

## FluentValidation com filtro de endpoint

FluentValidation coloca regras em classes próprias. Isso pode ajudar com composição, conjuntos de regras, condições ou projetos que já usam essa API. Este filtro é específico para um endpoint:

```csharp
// Program.cs: add a PackageReference to FluentValidation 12.1.1.
using FluentValidation;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddScoped<IValidator<CreateProduct>, CreateProductValidator>();
var app = builder.Build();

app.MapPost("/products", (CreateProduct product) =>
        TypedResults.Created($"/products/{product.Sku}", product))
    .AddEndpointFilter(async (context, next) =>
    {
        var product = context.GetArgument<CreateProduct>(0);
        var validator = context.HttpContext.RequestServices
            .GetRequiredService<IValidator<CreateProduct>>();
        var result = await validator.ValidateAsync(
            product, context.HttpContext.RequestAborted);
        if (!result.IsValid)
            return Results.ValidationProblem(result.ToDictionary());
        return await next(context);
    });

app.Run();

public record CreateProduct(string Sku, string Name, int Quantity);

public sealed class CreateProductValidator : AbstractValidator<CreateProduct>
{
    public CreateProductValidator()
    {
        RuleFor(x => x.Sku).NotEmpty().Length(3, 20);
        RuleFor(x => x.Name).NotEmpty().MinimumLength(2);
        RuleFor(x => x.Quantity).InclusiveBetween(1, 10_000);
    }
}
```

O filtro pressupõe que `CreateProduct` seja o argumento zero. Não o aplique sem alterações a grupos com assinaturas diferentes. Use `ValidateAsync` quando houver possibilidade de regras assíncronas e passe o token de cancelamento da requisição. Registre no DI os serviços necessários aos validadores.

Isso é diferente da antiga integração de validação automática MVC de `FluentValidation.AspNetCore`. Aquele pipeline é síncrono, não integra Minimal APIs e deixou de ser recomendado para projetos novos pela documentação do FluentValidation. Não o confunda com a validação integrada mais recente do ASP.NET Core.

## Escolha e licença

Considere manutenção e reutilização das regras, versão implantada e formato de erro exigido pelos clientes. A solução integrada é um ponto de partida adequado para modelos simples com DataAnnotations; FluentValidation oferece outra forma de organizar e combinar regras. Nenhuma opção garante melhor desempenho ou compatibilidade Native AOT de todo validador personalizado e dependência. Verifique a publicação e o comportamento real.

FluentValidation 12.1.1, usado aqui, tem licença Apache License 2.0. FluentAssertions é outro projeto; notícias sobre sua licença não determinam a licença do FluentValidation. Confira a versão exata distribuída.

Para organizar endpoints, veja [grupos de rotas com MapGroup](/pt-br/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/).

## Fontes

- [ASP.NET Core validation](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/validation?view=aspnetcore-11.0)
- [.NET 11: asynchronous Minimal API validation](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-11?view=aspnetcore-11.0#async-validation-for-minimal-apis)
- [FluentValidation: ASP.NET Core integration](https://docs.fluentvalidation.net/en/latest/aspnet.html)
- [FluentValidation: asynchronous rules](https://docs.fluentvalidation.net/en/latest/async.html)
- [FluentValidation 12.1.1 license](https://github.com/FluentValidation/FluentValidation/blob/12.1.1/License.txt)
