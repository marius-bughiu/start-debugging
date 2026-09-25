---
title: "Correção: ASP.NET Core retorna 400 \"The X field is required\" para uma propriedade string não anulável"
description: "Com <Nullable>enable</Nullable>, o MVC trata todo tipo de referência não anulável como [Required(AllowEmptyStrings = true)]. Marque as propriedades opcionais como string?, dê a elas um valor padrão ou defina SuppressImplicitRequiredAttributeForNonNullableReferenceTypes."
pubDate: 2026-09-25
template: error-page
tags:
  - "errors"
  - "aspnetcore"
  - "dotnet-10"
  - "validation"
  - "nullable-reference-types"
lang: "pt-br"
translationOf: "2026/09/fix-aspnetcore-400-the-field-is-required-non-nullable-string"
translatedBy: "claude"
translationDate: 2026-09-25
---

Um `400 Bad Request` com `"The Name field is required."` em uma propriedade que você nunca marcou com `[Required]` vem da regra implícita de obrigatoriedade do MVC: quando o projeto tem `<Nullable>enable</Nullable>`, todo tipo de referência não anulável em um modelo vinculado ou parâmetro de action é validado como se tivesse `[Required(AllowEmptyStrings = true)]`. Se o valor é realmente opcional, declare-o como `string?`. Se você quer o comportamento antigo em todo lugar, defina `options.SuppressImplicitRequiredAttributeForNonNullableReferenceTypes = true` em `AddControllers`. Se ele é de fato obrigatório, mantenha o erro e personalize-o com um `[Required]` explícito.

Todos os resultados abaixo foram reproduzidos no ASP.NET Core 10.0.10 (SDK 10.0.302) com um único projeto `dotnet new web` hospedando tanto controllers quanto endpoints de minimal API. A regra em si existe desde o ASP.NET Core 3.0, então a explicação vale para todas as versões, do 3.0 até o .NET 11.

## O erro em contexto

O cliente envia um corpo JSON que omite uma propriedade, ou a envia como `null`, e recebe de volta o corpo padrão `ValidationProblemDetails` antes que a sua action seja executada:

```json
{
  "type": "https://tools.ietf.org/html/rfc9110#section-15.5.1",
  "title": "One or more validation errors occurred.",
  "status": 400,
  "errors": {
    "Name": ["The Name field is required."]
  },
  "traceId": "00-41532a7ee5071512e476fa1aa31447c3-141fcd7662d71a76-00"
}
```

A mesma mensagem aparece para parâmetros de query string (`"q": ["The q field is required."]`), campos de formulário e, com muita frequência, para propriedades de navegação do EF Core em entidades vinculadas diretamente (`"Customer": ["The Customer field is required."]`). Sem `[ApiController]` você não recebe o 400 automático, mas `ModelState.IsValid` fica `false` com o mesmo erro, e é assim que Razor Pages e posts de formulário do MVC o encontram.

## Por que isso acontece

O `DataAnnotationsMetadataProvider` do MVC monta os metadados de validação para cada propriedade e parâmetro vinculado. Para cada um que é um tipo de referência e não tem `[Required]` explícito, ele pergunta ao `NullabilityInfoContext` o que o compilador registrou. Se o estado de leitura é `NotNull`, ele adiciona um `RequiredAttribute` à lista de validadores. O comentário relevante no código-fonte do ASP.NET Core é direto sobre isso: "For non-nullable reference types, treat them as-if they had an implicit [Required]."

Quatro detalhes desse código decidem quase todos os casos que você vai encontrar:

1. **O atributo implícito usa `AllowEmptyStrings = true`.** Ele só rejeita `null`, não `""`. Um corpo JSON com `"name": ""` passa na validação.
2. **Valores de formulário e de query ainda rejeitam strings vazias,** porque o model binding do MVC converte entradas vazias ou só com espaços em branco para `null` (`ConvertEmptyStringToNull` tem `true` como padrão) antes de a validação rodar. `?q=` e `?q=%20` falham ambos com "The q field is required."
3. **Parâmetros com valor padrão estão isentos.** `string sort = "name"` nunca é implicitamente obrigatório, porque o provider ignora parâmetros em que `HasDefaultValue` é true.
4. **Código oblivious está isento.** Se o tipo foi compilado com as anotações de anulabilidade desabilitadas, o estado de leitura é `Unknown`, não `NotNull`, então nada é adicionado. É por isso que o erro costuma aparecer no dia em que alguém liga `<Nullable>enable</Nullable>` em um projeto antigo, sem que nenhum modelo tenha mudado.

Só o MVC faz isso. Controllers, Razor Pages e views do MVC passam todos pelo `DataAnnotationsMetadataProvider`. Minimal APIs não, incluindo a nova validação gerada por código-fonte de `AddValidation()` no .NET 10, que é tratada nas armadilhas abaixo.

## Reprodução mínima

```csharp
// ASP.NET Core 10.0.10, <Nullable>enable</Nullable>, Program.cs
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddControllers();
var app = builder.Build();
app.MapControllers();
app.Run();

public record CreateProduct(string Name, string? Nickname, string Sku = "");

public class Order
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public int CustomerId { get; set; }
    public Customer Customer { get; set; } = null!; // EF Core navigation
}

public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
}

[ApiController, Route("api")]
public class ProductsController : ControllerBase
{
    [HttpPost("create")] public IActionResult Create(CreateProduct p) => Ok(p);
    [HttpPost("order")]  public IActionResult Order(Order o) => Ok(o);
    [HttpGet("search")]  public IActionResult Search(string q) => Ok(q);
}
```

O que cada requisição retornou:

| Requisição | Status | Chave do erro |
| --- | --- | --- |
| `POST /api/create` com `{}` | 400 | `Name` |
| `POST /api/create` com `{"name":null}` | 400 | `Name` |
| `POST /api/create` com `{"name":""}` | 200 | nenhuma |
| `POST /api/create` com `{"name":"x"}` | 200 | nenhuma |
| `POST /api/order` com `{"title":"t","customerId":1}` | 400 | `Customer` |
| `GET /api/search` | 400 | `q` |
| `GET /api/search?q=` | 400 | `q` |

`Nickname` (declarado como `string?`) e `Sku` (um parâmetro com valor padrão) nunca produziram erro. `Title` também não, porque o inicializador `= ""` faz com que a desserialização JSON o deixe em `""` quando a propriedade está ausente, e `""` satisfaz `AllowEmptyStrings = true`.

A linha de `Order` é a que mais confunde as pessoas. `Customer` é não anulável porque o EF Core quer assim para um relacionamento obrigatório, `= null!` silencia o [CS8618](/pt-br/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/), e então o MVC lê a mesma anotação e exige que o cliente envie um objeto `Customer` inteiro no corpo.

## Correção 1: declare os valores opcionais como anuláveis (recomendado)

Se um valor pode legitimamente estar ausente, o tipo deve dizer isso. Isso corrige a validação e dá a você as verificações de null do compilador dentro da action:

```csharp
// ASP.NET Core 10.0.10
public record CreateProduct(string Name, string? Nickname, string? Description);

[HttpGet("search")]
public IActionResult Search(string? q) => Ok(q ?? "(all)");
```

Para parâmetros de query e de rota que têm um fallback sensato, um valor padrão também funciona e fica mais legível do que uma verificação de null:

```csharp
// ASP.NET Core 10.0.10
[HttpGet("list")]
public IActionResult List(string sort = "name", int page = 1) => Ok(new { sort, page });
```

Para entidades do EF Core, a correção certa é parar de vincular a entidade. Aceite um DTO de requisição que carrega `CustomerId` e nada mais, e depois faça o mapeamento:

```csharp
// ASP.NET Core 10.0.10, EF Core 10
public record CreateOrder(string Title, int CustomerId);

[HttpPost("order")]
public async Task<IActionResult> Order(CreateOrder dto, AppDbContext db)
{
    var order = new Order { Title = dto.Title, CustomerId = dto.CustomerId };
    db.Orders.Add(order);
    await db.SaveChangesAsync();
    return CreatedAtAction(nameof(Order), new { id = order.Id }, new { order.Id });
}
```

Se você não pode mudar o binding da entidade agora, `[ValidateNever]` na propriedade de navegação (de `Microsoft.AspNetCore.Mvc.ModelBinding.Validation`) diz ao MVC para pular a validação dela:

```csharp
// ASP.NET Core 10.0.10
[ValidateNever]
public Customer Customer { get; set; } = null!;
```

Com ele, `{"title":"t"}` foi vinculado sem problemas e `Customer` ficou `null`. Isso é um remendo, não um design. Ainda permite que um cliente envie um objeto `customer` aninhado que o EF Core vai tentar inserir de bom grado.

## Correção 2: desligue a regra implícita globalmente

Quando você está habilitando tipos de referência anuláveis em uma API grande já existente e não consegue auditar todos os modelos de uma vez, suprima a inferência em `AddControllers` (ou `AddMvc`, `AddRazorPages().AddMvcOptions(...)`):

```csharp
// ASP.NET Core 10.0.10, Program.cs
builder.Services.AddControllers(options =>
{
    options.SuppressImplicitRequiredAttributeForNonNullableReferenceTypes = true;
});
```

Com essa opção definida, todas as linhas da tabela acima retornaram 200, exceto a query vazia, que retornou `204 No Content` porque a action recebeu `null` e `Ok(null)` vira um 204. Repare no que isso significa: a action rodou com `q == null` mesmo que a assinatura diga `string q`. Você trocou um 400 por um valor que o compilador jura que não pode ser null. Trate isso como uma chave de migração e planeje removê-la assim que os modelos estiverem anotados de forma honesta.

## Correção 3: mantenha a regra, controle a mensagem

Se a propriedade é de fato obrigatória, a validação implícita está fazendo o trabalho dela, e a única reclamação é o texto. Um atributo explícito substitui o implícito (o provider só adiciona o seu quando não há nenhum `[Required]` presente):

```csharp
// ASP.NET Core 10.0.10
using System.ComponentModel.DataAnnotations;

public class CreateCustomer
{
    [Required(AllowEmptyStrings = false, ErrorMessage = "Customer name is required.")]
    public string Name { get; set; } = default!;
}
```

Essa também é a forma de fazer uma string JSON vazia falhar, o que a regra implícita nunca faz. Um `[Required]` simples (em que `AllowEmptyStrings` tem `false` como padrão) rejeitou `{"name":""}` com um 400 na minha reprodução. Por outro lado, `[Required(AllowEmptyStrings = true)]` aceitou `""` na minha reprodução, igual ao comportamento implícito.

Se você quer mudar o formato da resposta em vez da mensagem, isso é uma questão de problem details, não de validação. A abordagem de [personalizar respostas de erro de validação com IProblemDetailsService](/pt-br/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/) funciona para controllers também.

## Armadilhas e erros parecidos

**Minimal APIs se comportam de forma diferente.** O mesmo record `CreateProduct` vinculado em um endpoint de minimal API aceitou `{}` e `{"name":null}` com um 200 e `Name == null`, mesmo com `builder.Services.AddValidation()` registrado e um `[StringLength(20)]` em outra propriedade (que de fato produziu um 400 quando violado, então o validador estava rodando). O gerador de código-fonte de validação do .NET 10 respeita atributos, mas não infere `[Required]` a partir da anulabilidade. Se você está [validando corpos de requisição em minimal APIs](/pt-br/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/), adicione `[Required]` explicitamente. *Parâmetros* de minimal API são outra história: um parâmetro de query `string q` não anulável ausente retorna 400 do próprio binder de parâmetros, e em Development a página de exceção mostra `BadHttpRequestException: Required parameter "string q" was not provided from query string.`

**A palavra-chave `required` do C# é um erro diferente.** Um `public required string Name { get; set; }` é imposto pelo System.Text.Json durante a desserialização, antes da validação do MVC. O corpo na minha reprodução foi:

```json
{
  "$": ["JSON deserialization for type 'ReqKw' was missing required properties including: 'name'."],
  "o": ["The o field is required."]
}
```

A segunda entrada, cuja chave é o nome do parâmetro da action, é a regra implícita de novo: a desserialização falhou, o parâmetro ficou `null`, e o parâmetro não anulável `ReqKw o` foi então sinalizado. Declarar o parâmetro como `[FromBody] ReqKw? o` remove essa entrada de ruído. A palavra-chave `required` e `[JsonRequired]` interagem de maneiras próprias, cobertas em [fazer o System.Text.Json ignorar uma propriedade required](/pt-br/2026/08/how-to-make-system-text-json-ignore-a-property-with-the-required-modifier/) e no [CS9035](/pt-br/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/).

**"The p field is required" com corpo vazio.** Enviar nenhum corpo para `Create(CreateProduct p)` retornou dois erros: `"": ["A non-empty request body is required."]` e `"p": ["The p field is required."]`. Tornar o parâmetro `CreateProduct? p` transforma o corpo vazio em um binding bem-sucedido com `p == null` (a action retornou 204 a partir de `Ok(null)`), então só faça isso se um corpo vazio for válido para o endpoint. `MvcOptions.AllowEmptyInputInBodyModelBinding` é a chave global para a primeira mensagem.

**Contexto de anulabilidade em outro assembly.** A regra lê as anotações do assembly que declara o modelo, não do projeto web. Modelos em uma biblioteca compartilhada compilada com `<Nullable>disable</Nullable>` nunca recebem o atributo implícito, mesmo que o projeto da API habilite nullable. O inverso também vale: habilitar nullable na biblioteca compartilhada muda o comportamento da API sem tocar no projeto da API.

**Propriedades herdadas.** A anotação é lida do membro que declara a propriedade. Se um DTO deriva de uma classe base em outro projeto, quem decide é o contexto de anulabilidade da classe base, não o do tipo derivado. Quando uma propriedade que você acredita ser `string?` ainda reporta "required", descubra onde ela é realmente declarada.

**Tipos de valor precisam de outra correção.** Um `int` ausente não dispara essa regra de jeito nenhum (tipos de valor são ignorados). Ele assume `0` silenciosamente como padrão. Se você precisa de "deve ser informado", use `int?` com `[Required]`.

## Relacionados

- [Como validar corpos de requisição em minimal APIs sem controllers no ASP.NET Core 11](/pt-br/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/), onde atributos são a única fonte de obrigatoriedade.
- [Validação de minimal API vs FluentValidation no ASP.NET Core 11](/pt-br/2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11/), se você está decidindo onde regras como esta devem ficar.
- [Correção do CS8618: propriedade não anulável deve conter um valor não nulo](/pt-br/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/), o lado do compilador das mesmas anotações.
- [Como consumir uma resposta ProblemDetails RFC 9457 a partir de um HttpClient tipado](/pt-br/2026/09/how-to-consume-an-rfc-9457-problemdetails-response-from-a-typed-httpclient/), para clientes que leem o dicionário `errors` acima.

## Fontes

- [Non-nullable reference types and [Required] attribute](https://learn.microsoft.com/aspnet/core/mvc/models/validation#non-nullable-reference-types-and-required-attribute) em "Model validation in ASP.NET Core MVC and Razor Pages" no Microsoft Learn.
- Referência de API de [`MvcOptions.SuppressImplicitRequiredAttributeForNonNullableReferenceTypes`](https://learn.microsoft.com/dotnet/api/microsoft.aspnetcore.mvc.mvcoptions.suppressimplicitrequiredattributefornonnullablereferencetypes).
- [`DataAnnotationsMetadataProvider.cs`](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Mvc/Mvc.DataAnnotations/src/DataAnnotationsMetadataProvider.cs) no branch `release/10.0`, para a inferência de `AllowEmptyStrings = true` e a isenção por `HasDefaultValue`.
- [dotnet/aspnetcore#16654](https://github.com/dotnet/aspnetcore/issues/16654), um relato antigo da regra surpreendendo usuários em propriedades herdadas.
