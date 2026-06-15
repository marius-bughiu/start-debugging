---
title: "Validação de minimal API vs FluentValidation no ASP.NET Core 11: qual você deve escolher?"
description: "Use a validação integrada gerada por código-fonte para regras síncronas expressáveis por atributos no ASP.NET Core 11; recorra ao FluentValidation quando precisar de regras assíncronas, lógica complexa entre campos ou manter a validação fora dos seus modelos de domínio."
pubDate: 2026-06-15
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

Se você está começando uma minimal API nova no ASP.NET Core 11, use a validação integrada: chame `AddValidation()`, anote seu record de requisição com `DataAnnotations` e um gerador de código-fonte retorna um `400 ProblemDetails` antes do seu handler executar, sem dependências e com suporte a Native AOT. Recorra ao FluentValidation (atualmente 12.1.1, Apache 2.0) apenas quando precisar de algo que o recurso integrado realmente não consegue fazer: regras assíncronas que consultam um banco de dados, lógica rica entre campos ou validação mantida inteiramente fora dos seus modelos de domínio. O eixo decisivo são as regras assíncronas e condicionais complexas. Se você precisa delas, o FluentValidation vence; se não, o recurso integrado é a opção de menor atrito. Tudo a seguir tem como alvo o .NET 11 com `Microsoft.NET.Sdk.Web` e C# 14; o recurso integrado foi lançado pela primeira vez no .NET 10 e permanece inalterado no 11.

## A matriz de recursos

Esta é a tabela que você veio buscar. Cada linha reflete o .NET 11 e o FluentValidation 12.1.1.

| Recurso                          | Integrado (`DataAnnotations`)           | FluentValidation 12                       |
| -------------------------------- | --------------------------------------- | ----------------------------------------- |
| Dependência                      | nenhuma (na caixa, .NET 10+)            | pacote NuGet, Apache 2.0                  |
| Mecanismo                        | gerador de código-fonte em compilação   | reflexão em runtime + árvores de expressão |
| Native AOT / trimming            | compatível (sem reflexão em runtime)    | exige cuidado, suporte parcial            |
| Regras assíncronas (consultas BD / HTTP) | não                             | sim (`MustAsync`, `ValidateAsync`)        |
| Regras entre campos              | `IValidatableObject` (verboso)          | de primeira classe (`RuleFor(...).When(...)`) |
| Onde as regras vivem             | no modelo, como atributos               | em uma classe de validador separada       |
| Condicional / conjuntos de regras | limitado                               | `When`/`Unless`/`WhenAsync`, conjuntos de regras |
| `400` automático em uma minimal API | sim, endpoint filter integrado       | manual: você escreve o endpoint filter    |
| Formato da resposta de erro      | `ProblemDetails` (RFC 9457) de graça    | você mapeia as falhas para uma resposta    |
| Regras compostas reutilizáveis   | `ValidationAttribute` personalizado     | `SetValidator`, encadeamento de regras, herança |

A leitura curta: o recurso integrado otimiza para "ligue e esqueça" em modelos simples, e o FluentValidation otimiza para poder expressivo nos complexos. Nenhum é estritamente melhor. As linhas que decidem a maioria dos casos são as regras assíncronas e onde as regras vivem.

## Quando escolher a validação integrada

A validação integrada, explicada passo a passo em [como validar corpos de requisição em minimal APIs sem controladores](/pt-br/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/), é o padrão certo nestes casos:

- **Minimal APIs novas no .NET 11 com regras síncronas.** Se sua validação é "este campo é obrigatório, aquele outro é um inteiro positivo, o e-mail parece um e-mail", `DataAnnotations` expressa tudo isso e o gerador de código-fonte o transforma em um endpoint filter de graça. Sem pacote, sem classes de validador, sem fiação.
- **Implantações com Native AOT ou trimming agressivo.** O recurso integrado foi projetado em torno de um gerador de código-fonte justamente para não carregar reflexão do grafo de modelo em runtime. É isso que o torna seguro sob trimming e Native AOT, a mesma razão pela qual ele se integra de forma limpa com a [pilha de minimal API com Native AOT](/pt-br/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/). O FluentValidation se apoia em reflexão e árvores de expressão compiladas, que exigem cuidado adicional para fazer trimming.
- **Você quer que o contrato `400 ProblemDetails` seja entregue a você.** A validação integrada retorna um corpo `HttpValidationProblemDetails` indexado por nome de propriedade, o mesmo formato RFC 9457 que o MVC produz, sem código da sua parte. Com o FluentValidation você decide como traduzir um `ValidationResult` em uma resposta HTTP, uma flexibilidade que talvez você não queira em um serviço pequeno.
- **Você prefere que as regras vivam no modelo.** Os atributos mantêm `[Required]` ao lado da propriedade que ele protege. Para uma equipe que gosta de ter os dados e suas restrições em um só lugar, essa co-localização é uma vantagem, não um defeito.

## Quando escolher o FluentValidation

O FluentValidation 12 ganha sua dependência quando o recurso integrado bate em uma parede:

- **Regras assíncronas.** Esta é a maior razão para recorrer a ele. `DataAnnotations` e `IValidatableObject` são síncronos, então "este nome de usuário já está em uso?" ou "este ID de produto existe no catálogo?" não podem ser expressos no recurso integrado sem vazar acesso a dados para dentro de um handler. O FluentValidation suporta `MustAsync` e `WhenAsync`, e você o invoca com `ValidateAsync`. A biblioteca é explícita ao dizer que um validador contendo regras assíncronas deve ser chamado com `ValidateAsync`, nunca com `Validate`, ou lança uma exceção.
- **Lógica rica entre campos e condicional.** "Data de fim posterior à de início" é viável com `IValidatableObject`, mas assim que você tem "se `PaymentType` for `Invoice` então `PurchaseOrderNumber` é obrigatório, a menos que o cliente seja `Internal`", a abordagem de atributos mais `IValidatableObject` vira um emaranhado de blocos `if`. O `RuleFor(x => x.PurchaseOrderNumber).NotEmpty().When(x => x.PaymentType == PaymentType.Invoice)` do FluentValidation se lê como o requisito.
- **A validação precisa ficar fora do modelo de domínio.** Em uma base de código de arquitetura limpa ou DDD, decorar um record de domínio com `[Range]` e `[EmailAddress]` acopla o modelo a uma preocupação de apresentação. O FluentValidation mantém cada regra em uma classe `AbstractValidator<T>` separada, então o modelo continua sendo um POCO sem atributos.
- **Reutilização e composição entre muitos tipos de requisição.** `SetValidator`, herança de validadores e conjuntos de regras permitem compor um `MoneyValidator` em toda requisição que carregue um preço, com uma fluência que os tipos `ValidationAttribute` personalizados não igualam quando a regra tem estrutura.

## Como cada um aparece em código

A versão integrada são as anotações que você já conhece, mais um registro de serviço:

```csharp
// .NET 11, C# 14 -- Program.cs
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

Um corpo inválido nunca chega ao handler. Ele volta como um `400` com um payload `ProblemDetails` indexado por `Sku`, `Name` e `Quantity` automaticamente.

O equivalente em FluentValidation move as regras para uma classe de validador e, como a pipeline de validação automática integrada está obsoleta (mais sobre isso abaixo), conecta tudo através de um endpoint filter que você chama explicitamente:

```csharp
// .NET 11, C# 14 -- FluentValidation 12.1.1
using FluentValidation;
using FluentValidation.Results;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddScoped<IValidator<CreateProduct>, CreateProductValidator>();
var app = builder.Build();

app.MapPost("/products", (CreateProduct product) =>
        TypedResults.Created($"/products/{product.Sku}", product))
   .AddEndpointFilter(async (ctx, next) =>
   {
       var product = ctx.GetArgument<CreateProduct>(0);
       var validator = ctx.HttpContext.RequestServices
           .GetRequiredService<IValidator<CreateProduct>>();

       ValidationResult result = await validator.ValidateAsync(product);
       if (!result.IsValid)
           return Results.ValidationProblem(result.ToDictionary());

       return await next(ctx);
   });

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

É mais código, mas também é onde o poder vive. Adicione uma verificação de unicidade assíncrona e o recurso integrado simplesmente não consegue acompanhar:

```csharp
// .NET 11, C# 14 -- FluentValidation 12.1.1
public sealed class CreateProductValidator : AbstractValidator<CreateProduct>
{
    public CreateProductValidator(IProductRepository repo)
    {
        RuleFor(x => x.Sku)
            .NotEmpty()
            .Length(3, 20)
            .MustAsync(async (sku, ct) => !await repo.SkuExistsAsync(sku, ct))
            .WithMessage("A product with this SKU already exists.");
    }
}
```

`MustAsync` consulta o banco de dados durante a validação. Não existe nenhum atributo de `DataAnnotations` que faça isso sem que você abra um `DbContext` dentro da regra, e `IValidatableObject.Validate` é síncrono, então não pode aguardar nada. Esta é a parede que envia as equipes ao FluentValidation.

Você pode fatorar o código repetitivo do endpoint filter em uma pequena extensão genérica para que cada endpoint apenas encadeie `.WithValidation<CreateProduct>()`. A mecânica de compor filtros em um grupo de rotas é a mesma descrita em [organizar endpoints de minimal API com MapGroup](/pt-br/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/), então um único `MapGroup(...).AddEndpointFilter(...)` pode validar um grupo inteiro.

## O benchmark: inicialização, não estado estacionário

A história honesta de desempenho aqui não é o throughput de requisições. Para um punhado de propriedades, ambas as abordagens validam em microssegundos e o custo é ofuscado pela desserialização JSON e pelo que seu handler faz. A diferença mensurável está nas bordas: o cold start e o AOT.

Como o recurso integrado é gerado em tempo de compilação, não adiciona reflexão na inicialização. O FluentValidation constrói suas cadeias de regras com árvores de expressão que compilam no primeiro uso, então a primeira validação de cada tipo paga um custo único de JIT e compilação de expressão. Em um servidor quente esse custo é amortizado a nada. Em uma [função serverless com cold start](/pt-br/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) que atende uma requisição e congela, você o paga em uma fração significativa das invocações.

A distinção mais nítida é a publicação. Uma minimal API com Native AOT e o validador integrado publica e executa sem avisos de trimming, porque não há reflexão a preservar. A mesma aplicação usando FluentValidation fará surgir avisos de trimming a menos que você mantenha ancorados os tipos validados e seus membros, já que a biblioteca usa reflexão sobre seu modelo e sobre expressões de acesso a membros. Isso não é "o FluentValidation é lento", é "o FluentValidation custa a você trabalho de segurança de trimming que o recurso integrado não custa". Se o seu alvo de implantação é AOT, trate isso como o fator decisivo em vez de qualquer contagem de nanossegundos. Números mais antigos que este ciclo do .NET 11 devem ser remedidos antes de você confiar neles; as entranhas da validação mudaram entre o .NET 8 e o .NET 10.

## A pegadinha que decide por você: o pacote AspNetCore obsoleto

Se você for procurar a integração do FluentValidation com o ASP.NET Core, encontrará o pacote `FluentValidation.AspNetCore` e sua antiga pipeline de validação automática. Não comece por aí. Os mantenedores a marcaram como obsoleta, e a documentação é explícita: "We no longer recommend using this approach for new projects but it is still available for legacy implementations." Ela não executa validadores assíncronos (lança exceção), nunca suportou minimal APIs nem Blazor, e seu comportamento implícito é difícil de depurar. O caminho recomendado em 2026 é o manual mostrado acima: registre `IValidator<T>` no DI e chame `ValidateAsync` você mesmo, a partir de um endpoint filter para minimal APIs ou do handler. Se um tutorial mandar você chamar `AddFluentValidationAutoValidation()`, ele é anterior a esta orientação.

Uma segunda pegadinha corta no sentido oposto, a favor do FluentValidation: o medo de licenciamento é equivocado aqui. O FluentValidation continua sendo Apache 2.0 e gratuito, inclusive para uso comercial. A biblioteca que mudou para uma licença paga restritiva em janeiro de 2025 foi a Fluent Assertions, um projeto diferente com um nome confusamente parecido. Eles não têm relação, e escolher o FluentValidation não o expõe a uma taxa por assento. Se um revisor de políticas sinalizar "Fluent*" na sua lista de dependências, essa é a distinção a fazer.

A última é uma armadilha de correção exclusiva do FluentValidation: se qualquer regra de um validador for assíncrona, todo local de chamada deve usar `ValidateAsync`. Um `Validate()` síncrono perdido em um validador que contém uma regra `MustAsync` lança uma exceção em runtime, não em compilação, então pode passar em testes que nunca exercitam aquele caminho e falhar em produção. Padronize `ValidateAsync` em todo lugar para evitar a armadilha por completo.

## A recomendação, repetida

Use por padrão a validação integrada no ASP.NET Core 11. É gratuita, é compatível com AOT, entrega a você um contrato `ProblemDetails` padrão e, para as regras síncronas e com forma de atributo que compõem a maior parte da validação de requisições, é estritamente menos trabalho do que adicionar uma dependência. Escolha o FluentValidation deliberadamente, quando tiver batido em um limite específico: regras assíncronas que precisam de E/S, lógica condicional entre campos que `IValidatableObject` deixa feia, ou uma regra arquitetural de que a validação não deve tocar nos seus modelos de domínio. Muitos sistemas reais acabam com os dois, e tudo bem: deixe o recurso integrado guardar os DTOs simples e deixe o FluentValidation cuidar do punhado de tipos de requisição com regras genuinamente complexas. O erro é recorrer a uma biblioteca de validação em um serviço novo de .NET 11 por hábito, antes de ter uma regra que o framework já não consiga expressar de graça.

## Relacionados

- [Como validar corpos de requisição em minimal APIs sem controladores no ASP.NET Core 11](/pt-br/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/) para a configuração completa do recurso integrado.
- [Minimal APIs vs controladores no ASP.NET Core 11](/pt-br/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) para a decisão de modelo de endpoint que está por baixo desta.
- [Como organizar endpoints de minimal API com MapGroup no ASP.NET Core 11](/pt-br/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) para aplicar um filtro de validação a um grupo de rotas inteiro.
- [Usar Native AOT com minimal APIs do ASP.NET Core](/pt-br/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) para entender por que um validador baseado em gerador importa sob trimming.
- [Como adicionar um filtro global de exceções no ASP.NET Core 11](/pt-br/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) para respaldar tudo o que a validação não captura.

## Fontes

- Microsoft Learn, [What's new in ASP.NET Core in .NET 10](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-10.0?view=aspnetcore-10.0) (validação integrada de minimal API, `AddValidation`, gerador de código-fonte, `ProblemDetails`).
- Documentação do FluentValidation, [ASP.NET Core integration](https://docs.fluentvalidation.net/en/latest/aspnet.html) (obsolescência da validação automática, abordagem manual recomendada com `IValidator<T>`).
- Documentação do FluentValidation, [Asynchronous Validation](https://docs.fluentvalidation.net/en/latest/async.html) (`MustAsync`, `WhenAsync`, o requisito do `ValidateAsync`).
- FluentValidation, [Deprecation of the FluentValidation.AspNetCore package (issue #1960)](https://github.com/FluentValidation/FluentValidation/issues/1960).
- NuGet, [FluentValidation 12.1.1](https://www.nuget.org/packages/fluentvalidation/) (versão atual, licença Apache 2.0).
- DevClass, [Another open source project shifts to restrictive license: Fluent Assertions](https://www.devclass.com/development/2025/01/16/another-open-source-project-shifts-to-restrictive-license-fluent-assertions-following-xceed-partnership/) (a mudança de licença foi da Fluent Assertions, não do FluentValidation).
</content>
