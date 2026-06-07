---
title: "Como validar corpos de requisição em minimal APIs sem controllers no ASP.NET Core 11"
description: "O ASP.NET Core 11 traz validação integrada para minimal APIs: chame AddValidation, anote seu record de requisição com DataAnnotations e um gerador de código-fonte valida o modelo vinculado e retorna 400 ProblemDetails antes de o seu handler rodar. Sem controllers, sem FluentValidation, sem verificações manuais."
pubDate: 2026-06-07
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-apis"
lang: "pt-br"
translationOf: "2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-06-07
---

Por anos, a resposta honesta para "como eu valido o corpo de uma requisição em uma minimal API" era "você não valida, não automaticamente." As minimal APIs nasceram sem a maquinaria de `ModelState` que os controllers ganham de graça, então você recorria ao `FluentValidation`, ao pacote `MiniValidation` ou a um bloco `if` escrito à mão em cada handler. Isso mudou no .NET 10 e permanece sem alterações no .NET 11: chame `builder.Services.AddValidation()`, decore seu tipo de requisição com os mesmos atributos de `System.ComponentModel.DataAnnotations` que você já conhece (`[Required]`, `[Range]`, `[EmailAddress]`) e um gerador de código-fonte emite um endpoint filter que valida o modelo vinculado antes de o corpo do seu handler rodar. Requisições inválidas voltam como um `400 Bad Request` com um corpo `ProblemDetails`, sem verificação de `ModelState.IsValid`, sem controller, sem pacote extra. Tudo abaixo tem como alvo o .NET 11 com `Microsoft.NET.Sdk.Web` e C# 14; o recurso é idêntico no .NET 10, onde apareceu pela primeira vez.

## Por que as minimal APIs não tinham validação para começar

Isso não foi um descuido, foi uma decisão de projeto. A validação de modelos do MVC roda por meio de um pipeline baseado em reflexão: ela percorre o grafo do modelo em runtime, descobre as instâncias de `ValidationAttribute`, as invoca e preenche o `ModelState`. Essa reflexão é exatamente o tipo de custo de inicialização e por requisição que o stack das minimal APIs foi construído para evitar, e é hostil ao trimming e ao Native AOT. Então a superfície original das minimal APIs vinculava seus parâmetros e chamava seu handler, ponto final. Se o corpo era lixo, seu handler via o lixo.

A solução do .NET 10 contorna o problema da reflexão com um gerador de código-fonte. Em tempo de compilação ele encontra cada tipo usado como parâmetro de uma minimal API, lê os atributos de `DataAnnotations` nesses tipos e gera o código de validação diretamente. Não há reflexão do grafo do modelo em runtime, que é o que torna o recurso compatível com o modelo de endpoints enxuto e amigável ao AOT. Se você ainda está pesando os dois estilos de endpoint, as escolhas mais amplas estão em [minimal APIs vs controllers no ASP.NET Core 11](/pt-br/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/); este guia assume que você já se decidiu pelas minimal APIs e quer a validação de volta.

## Três passos para ligar a validação

1. **Registre os serviços.** Chame `builder.Services.AddValidation()` antes de construir o app. Isso registra os serviços de validação e o endpoint filter que os executa.
2. **Garanta que o gerador de código-fonte esteja ativo.** Com o SDK web do .NET 10 ou .NET 11 o gerador de validação é conectado automaticamente assim que você chama `AddValidation()`. Se seu build é anterior à versão final ou você copiou um `.csproj` enxuto, o gerador emite interceptadores no namespace `Microsoft.AspNetCore.Http.Validation.Generated`; certifique-se de que esse namespace esteja incluído em `InterceptorsNamespaces` (o SDK faz isso por você nos builds atuais).
3. **Anote o tipo de requisição e torne-o `public`.** Coloque atributos de `DataAnnotations` nas propriedades ou nos parâmetros posicionais do seu record ou classe de requisição. O tipo precisa ser `public`, porque o gerador só consegue enxergar e gerar código para tipos acessíveis.

Essa é toda a configuração. Aqui está a ligação no `Program.cs`:

```csharp
// .NET 11, C# 14 -- Program.cs
using System.ComponentModel.DataAnnotations;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddValidation();          // step 1
var app = builder.Build();

app.MapPost("/products", (CreateProduct product) =>
    TypedResults.Created($"/products/{product.Sku}", product));

app.Run();

public record CreateProduct(
    [Required, Length(3, 20)] string Sku,
    [Required, MinLength(2)] string Name,
    [Range(1, 10_000)] int Quantity);
```

Se o `.csproj` em algum momento precisar da propriedade explicitamente (SDKs mais antigos), ela fica assim:

```xml
<!-- only needed if the generator's interceptors are not picked up automatically -->
<PropertyGroup>
  <InterceptorsNamespaces>$(InterceptorsNamespaces);Microsoft.AspNetCore.Http.Validation.Generated</InterceptorsNamespaces>
</PropertyGroup>
```

## O que uma requisição inválida realmente retorna

Faça um POST de um corpo que quebre duas regras e você recebe um `400` legível por máquina sem escrever uma única linha de tratamento de erro:

```bash
# .NET 11
curl -i -X POST http://localhost:5000/products \
  -H "Content-Type: application/json" \
  -d '{"sku":"x","name":"","quantity":0}'
```

```json
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json

{
  "type": "https://tools.ietf.org/html/rfc9110#section-15.5.1",
  "title": "One or more validation errors occurred.",
  "status": 400,
  "errors": {
    "Sku": ["The field Sku must be a string with a minimum length of 3 and a maximum length of 20."],
    "Name": ["The Name field is required."],
    "Quantity": ["The field Quantity must be between 1 and 10000."]
  }
}
```

Esse payload é um `HttpValidationProblemDetails`, o mesmo formato RFC 9457 / RFC 7807 que o MVC produz, então clientes existentes que já fazem o parse de `errors` continuam funcionando. O handler nunca roda. Não há `ModelState`, nem verificação de `IsValid`, nada a esquecer. O dicionário de erros é indexado por nome de propriedade, e os membros aninhados usam um caminho com pontos, o que importa quando seus modelos deixam de ser planos.

## Objetos aninhados são validados de forma recursiva

A validação entra nas propriedades complexas automaticamente. Uma requisição com um objeto de endereço valida o endereço também, e as chaves de erro refletem o caminho:

```csharp
// .NET 11, C# 14
public record CreateOrder(
    [Required, EmailAddress] string CustomerEmail,
    [Required] BillingAddress Billing);

public record BillingAddress(
    [Required, MinLength(2)] string Street,
    [Required, Length(2, 10)] string PostalCode,
    [Required, RegularExpression("^[A-Z]{2}$")] string CountryCode);
```

Faça um POST de um pedido com um código postal errado e a chave de erro é `Billing.PostalCode`, não um `PostalCode` achatado. O gerador descobriu `BillingAddress` porque `CreateOrder` o referencia; você não precisou registrar o tipo aninhado em lugar nenhum. Essa descoberta recursiva é a parte que torna o recurso genuinamente útil, e não um brinquedo para corpos de campo único.

## Quando o tipo não está diretamente na assinatura de um handler

O gerador encontra os tipos olhando os parâmetros dos handlers da minimal API e os membros alcançáveis a partir deles. Se um tipo só é referenciado por meio de uma classe base, uma interface ou polimorfismo, o gerador pode não descobri-lo. Para esses casos, anote o próprio tipo com `[ValidatableType]` de `Microsoft.AspNetCore.Http.Validation` para dizer ao gerador que emita lógica de validação para ele explicitamente:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Http.Validation;
using System.ComponentModel.DataAnnotations;

[ValidatableType]
public abstract record PaymentMethod
{
    [Required, Length(2, 40)] public string Holder { get; init; } = "";
}

public sealed record CardPayment : PaymentMethod
{
    [Required, CreditCard] public string Number { get; init; } = "";
}
```

`[ValidatableType]` é a saída de emergência manual: recorra a ele quando a validação silenciosamente não dispara em um tipo onde você a esperava, o que quase sempre significa que o gerador não conseguiu alcançá-lo a partir de um parâmetro de handler.

## Regras entre propriedades com IValidatableObject

Os atributos validam um membro por vez. Para regras que abrangem vários campos ("a data de fim deve ser posterior à de início", "se o desconto estiver definido, o motivo é obrigatório"), implemente `IValidatableObject`. Seu método `Validate` roda depois das verificações de atributos e produz entradas `ValidationResult`:

```csharp
// .NET 11, C# 14
using System.ComponentModel.DataAnnotations;

public record DateRange(
    [Required] DateOnly Start,
    [Required] DateOnly End) : IValidatableObject
{
    public IEnumerable<ValidationResult> Validate(ValidationContext context)
    {
        if (End <= Start)
        {
            yield return new ValidationResult(
                "End must be after Start.",
                [nameof(End)]);   // attaches the error to the End member
        }
    }
}
```

O array de strings que você passa como segundo argumento controla sob qual chave o erro pousa no dicionário `errors`. Passe `[nameof(End)]` e o cliente vê `"End": ["End must be after Start."]`; omita-o e o erro vai para uma chave vazia como um erro a nível de modelo. Use o nome do membro para que sua UI possa destacar o campo certo.

## Um ValidationAttribute personalizado quando os integrados não bastam

Quando nem os atributos integrados nem o `IValidatableObject` servem, escreva um `ValidationAttribute`. O gerador de código-fonte captura os atributos personalizados da mesma forma que captura o `[Range]`:

```csharp
// .NET 11, C# 14
using System.ComponentModel.DataAnnotations;

public sealed class NotInPastAttribute : ValidationAttribute
{
    protected override ValidationResult? IsValid(object? value, ValidationContext context)
    {
        if (value is DateOnly date && date < DateOnly.FromDateTime(DateTime.UtcNow.Date))
        {
            return new ValidationResult(
                ErrorMessage ?? "Date cannot be in the past.",
                [context.MemberName!]);
        }
        return ValidationResult.Success;
    }
}

public record Booking([Required, NotInPast] DateOnly When);
```

Atributos personalizados mantêm a regra junto aos dados e reutilizável em cada endpoint que recebe um `Booking`, que é todo o propósito da validação baseada em atributos em vez de blocos `if` inline espalhados pelos handlers.

## Parâmetros de consulta, rota e cabeçalho também são validados

O recurso não se limita ao corpo JSON. Atributos em parâmetros escalares vinculados a partir da rota, da query string ou dos cabeçalhos são validados com a mesma maquinaria:

```csharp
// .NET 11, C# 14
app.MapGet("/search",
    ([Range(1, 100)] int pageSize,
     [Required, MinLength(2)] string query) =>
        TypedResults.Ok(new { pageSize, query }));
```

Uma requisição para `/search?pageSize=500&query=x` é rejeitada com um `400` antes de o handler rodar, com `pageSize` e `query` ambos listados em `errors`. Isso fecha a lacuna de validação mais comum que as pessoas encontram depois do corpo: os parâmetros de paginação e filtro que antes passavam sem verificação.

## Desligando a validação para um endpoint

Às vezes um endpoint recebe um tipo que é validado em todo lugar, mas aqui você quer o valor cru, por exemplo uma rota administrativa interna que aceita intencionalmente dados que de outra forma seriam inválidos. Encadeie `DisableValidation()` nesse único endpoint:

```csharp
// .NET 11, C# 14
app.MapPost("/internal/import", (CreateProduct product) =>
        TypedResults.Accepted($"/products/{product.Sku}", product))
    .DisableValidation();
```

Isso remove o filtro de validação desse único endpoint sem tocar no registro global `AddValidation()`, então todos os outros endpoints que usam `CreateProduct` continuam validando.

## Detalhes que vale a pena conhecer antes de publicar

Um punhado de pontas afiadas faz as pessoas tropeçarem na primeira vez:

- **O tipo de requisição precisa ser `public`.** O gerador de código-fonte só consegue emitir código para tipos que ele pode nomear. Um `record` ou `class` declarado sem `public`, ou aninhado dentro de outro tipo sem a acessibilidade correta, silenciosamente não recebe validação. Se a validação "não está funcionando", verifique primeiro o modificador de acesso.
- **Parâmetros posicionais de record: a posição do atributo importa.** `[Required] string Name` em um parâmetro posicional de record é lido pelo gerador, mas se você também depende de que o atributo esteja na *propriedade* gerada (para ferramentas que fazem reflexão sobre ela em runtime), use o alvo explícito: `[property: Required] string Name`. O próprio gerador de validação lê a forma do parâmetro, então a maior parte do código não precisa de `property:`, mas misturar expectativas é uma fonte comum de confusão.
- **A validação roda como um endpoint filter, então a ordem dos filtros vale.** O filtro de validação é adicionado por endpoint. Se você também adicionar suas próprias chamadas `AddEndpointFilter`, fique atento a onde a validação fica na cadeia. Para saber como a ordem dos filtros se compõe entre route groups, veja [como organizar endpoints de minimal API com MapGroup no ASP.NET Core 11](/pt-br/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/).
- **Isso não substitui o FluentValidation em todos os casos.** `DataAnnotations` mais `IValidatableObject` cobre a grande maioria da validação de requisições. Se você tem um motor de regras, regras assíncronas que acessam um banco de dados ou um grande investimento existente em FluentValidation, mantenha-o. O recurso integrado é para "eu só quero que `[Required]` realmente faça alguma coisa" sem uma dependência.
- **O handler é pulado em caso de falha, então sua união de `TypedResults` não precisa de um braço `BadRequest` para a validação.** O `400` é produzido pelo filtro, antes de o seu handler retornar, então um handler tipado como `Results<Created<T>, NotFound>` está ok; falhas de validação nunca chegam a ele. O 400 ProblemDetails é gerado de forma independente dos seus tipos de retorno declarados.
- **Erros de DI em tempo de resolução não têm relação.** Se um endpoint lança ao ativar um serviço em vez de ao validar a entrada, isso é uma falha completamente diferente; veja [Unable to resolve service for type while attempting to activate](/pt-br/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/) para essa.

O modelo mental para levar consigo: a validação de minimal API no .NET 11 são as `DataAnnotations` que você já conhece, tornadas automáticas por um gerador de código-fonte em tempo de compilação e expostas por meio de um filtro por endpoint que retorna `ProblemDetails` padrão. Você anota, chama `AddValidation()` e requisições inválidas param na porta. Por ser baseada em gerador e não em reflexão, ela fica fora do caminho do trimming e do Native AOT, que é exatamente por que ela é entregue [segura para trimming com o stack de minimal API do Native AOT](/pt-br/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/). Para qualquer coisa que o filtro não captura, um [filtro global de exceções](/pt-br/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) ainda dá suporte ao resto do pipeline de requisições.

## Relacionado

- [Minimal APIs vs controllers no ASP.NET Core 11](/pt-br/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) para escolher entre os dois modelos de endpoint em primeiro lugar.
- [Como organizar endpoints de minimal API com MapGroup no ASP.NET Core 11](/pt-br/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) para saber onde o filtro de validação fica em relação aos filtros de grupo.
- [Usar Native AOT com minimal APIs do ASP.NET Core](/pt-br/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) para entender por que um validador baseado em gerador importa sob trimming.
- [Adicionar um filtro global de exceções no ASP.NET Core 11](/pt-br/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) para capturar tudo o que a validação não captura.
- [Fix: Unable to resolve service for type while attempting to activate](/pt-br/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/) para erros de ativação que parecem, mas não são, falhas de validação.

## Fontes

- Microsoft Learn, [What's new in ASP.NET Core in .NET 10](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-10.0?view=aspnetcore-10.0) (suporte de validação para minimal APIs, `AddValidation`, `[ValidatableType]`, `DisableValidation`).
- Microsoft Learn, [System.ComponentModel.DataAnnotations namespace](https://learn.microsoft.com/en-us/dotnet/api/system.componentmodel.dataannotations) (`ValidationAttribute`, `IValidatableObject`, `ValidationResult`).
- Tim Deschryver, [ASP.NET 10: Validating incoming models in Minimal APIs](https://timdeschryver.dev/blog/aspnet-10-validating-incoming-models-in-minimal-apis) (validação de objetos aninhados, formato da resposta de erro).
