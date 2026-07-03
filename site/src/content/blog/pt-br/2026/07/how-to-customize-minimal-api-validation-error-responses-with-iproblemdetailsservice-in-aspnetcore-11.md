---
title: "Como personalizar respostas de erro de validação de minimal APIs com IProblemDetailsService no ASP.NET Core 11"
description: "Chame AddProblemDetails com um callback CustomizeProblemDetails para remodelar o 400 que a validação embutida de minimal APIs retorna no ASP.NET Core 11: adicione um traceId, reescreva o title, troque 400 por 422, ou assuma o controle total com um IProblemDetailsWriter personalizado."
pubDate: 2026-07-03
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-apis"
  - "validation"
lang: "pt-br"
translationOf: "2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-03
---

A validação embutida de minimal APIs dá a você um `400 Bad Request` com um corpo `HttpValidationProblemDetails` de graça, mas o formato que ela retorna é o padrão do framework: um payload RFC 9457 com `type`, `title`, `status` e um dicionário `errors`. Se você precisa de um `traceId` para tickets de suporte, um `title` diferente, um link para sua documentação de erros, ou um `422 Unprocessable Entity` em vez de `400`, o gancho é `AddProblemDetails(options => options.CustomizeProblemDetails = ...)`. Registre-o, e o mesmo callback dispara para falhas de validação, exceções não tratadas e páginas de código de status igualmente, então cada erro que sua API emite carrega os mesmos campos. Essa é a peça que estava faltando nas primeiras versões prévias do .NET 10 e está conectada no .NET 10 GA e no .NET 11: o filtro de validação embutido agora roteia seus problem details através do `IProblemDetailsService`, então sua personalização de fato alcança os erros de validação. Tudo abaixo tem como alvo o .NET 11 com `Microsoft.NET.Sdk.Web` e C# 14; o comportamento é idêntico no .NET 10 GA.

## Como é a resposta de validação padrão

Comece pela configuração descrita em [como validar corpos de requisição em minimal APIs sem controllers](/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/): chame `AddValidation()`, anote um record de requisição e deixe o gerador de código-fonte fazer o trabalho.

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

Faça um POST de um corpo inválido e você recebe o payload padrão:

```json
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json

{
  "type": "https://tools.ietf.org/html/rfc9110#section-15.5.1",
  "title": "One or more validation errors occurred.",
  "status": 400,
  "errors": {
    "Sku": ["The field Sku must be a string with a minimum length of 3 and a maximum length of 20."],
    "Name": ["The Name field is required."]
  }
}
```

Isso está correto e é legível por máquina, mas não diz nada sobre o seu serviço. Não há um ID de correlação para colar em um relatório de bug, o `type` aponta para a RFC em vez do seu próprio catálogo de erros, e clientes que tratam `422` como "semanticamente inválido, não tente de novo" recebem um `400` que não conseguem distinguir de uma requisição malformada. A personalização corrige tudo isso em um único lugar.

## Ative o gancho de personalização

`AddProblemDetails()` registra o `IProblemDetailsService` padrão, e sua sobrecarga recebe uma configuração `ProblemDetailsOptions` onde você define `CustomizeProblemDetails`. Essa propriedade é um delegate que recebe um `ProblemDetailsContext`, que expõe tanto o `HttpContext` quanto o `ProblemDetails` mutável prestes a ser escrito.

1. **Registre problem details com o callback.** Chame `builder.Services.AddProblemDetails(options => options.CustomizeProblemDetails = ctx => { ... })` antes de `builder.Build()`.
2. **Mantenha `AddValidation()` também.** Os dois serviços são independentes: `AddValidation()` produz o `400`, `AddProblemDetails()` personaliza o corpo que ele carrega.
3. **Modifique `ctx.ProblemDetails` dentro do callback.** Adicione a `Extensions`, reescreva `Title`, `Type` ou `Detail`, ou altere `Status`.

Aqui está a ligação que adiciona um ID de correlação e um ponteiro de suporte a cada erro de validação:

```csharp
// .NET 11, C# 14 -- Program.cs
using System.Diagnostics;
using System.ComponentModel.DataAnnotations;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddValidation();
builder.Services.AddProblemDetails(options =>
{
    options.CustomizeProblemDetails = ctx =>
    {
        // Correlate with distributed tracing; fall back to the request id.
        ctx.ProblemDetails.Extensions["traceId"] =
            Activity.Current?.Id ?? ctx.HttpContext.TraceIdentifier;

        if (ctx.ProblemDetails.Status == StatusCodes.Status400BadRequest)
        {
            ctx.ProblemDetails.Title = "Your request failed validation.";
            ctx.ProblemDetails.Type = "https://api.example.com/errors/validation";
            ctx.ProblemDetails.Extensions["support"] = "support@example.com";
        }
    };
});
var app = builder.Build();

app.MapPost("/products", (CreateProduct product) =>
    TypedResults.Created($"/products/{product.Sku}", product));

app.Run();

public record CreateProduct(
    [Required, Length(3, 20)] string Sku,
    [Required, MinLength(2)] string Name,
    [Range(1, 10_000)] int Quantity);
```

O mesmo POST inválido agora retorna:

```json
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json

{
  "type": "https://api.example.com/errors/validation",
  "title": "Your request failed validation.",
  "status": 400,
  "errors": {
    "Sku": ["The field Sku must be a string with a minimum length of 3 and a maximum length of 20."],
    "Name": ["The Name field is required."]
  },
  "traceId": "00-2f0e...-b7ad...-01",
  "support": "support@example.com"
}
```

O dicionário `errors` fica intocado, então clientes existentes continuam fazendo o parse dele. Você adicionou campos, você não quebrou o contrato. Note o `traceId`: puxe-o de `Activity.Current?.Id` em vez de um novo `Guid.NewGuid()`, porque esse valor é o trace id W3C real que flui pelos seus logs e spans do OpenTelemetry. Um GUID aleatório parece um trace id, mas não se correlaciona com nada. Recorrer a `HttpContext.TraceIdentifier` cobre requisições que chegam sem um contexto de trace.

## Por que o callback alcança todo erro, não apenas a validação

A razão para preferir `CustomizeProblemDetails` em vez de editar manualmente cada endpoint é a cobertura. Quando `AddProblemDetails()` está registrado, o callback roda para problem details produzidos pela maquinaria de erros do framework: o `ExceptionHandlerMiddleware`, o `StatusCodePagesMiddleware`, a página de exceção do desenvolvedor e, desde o .NET 10 GA, o filtro de validação embutido de minimal APIs. Um callback, e seu `traceId` chega a um `400` de validação, a um `404` de uma rota não correspondida e a um `500` de uma exceção não tratada. Essa consistência é o ponto inteiro do contrato de problem details: um cliente deveria conseguir ler `traceId` de qualquer erro que sua API retorna sem tratar caso a caso qual camada o produziu.

Para obter os casos de `404` e `500` além da validação, registre os dois middlewares que preenchem respostas de erro vazias:

```csharp
// .NET 11, C# 14
app.UseExceptionHandler();   // turns unhandled exceptions into ProblemDetails
app.UseStatusCodePages();    // fills empty 4xx/5xx responses with ProblemDetails
app.Run();
```

Sem esses, um simples `Results.NotFound()` ou uma rota não correspondida retorna um corpo vazio, porque os problem details são gerados apenas "para respostas que ainda não têm conteúdo de corpo". A validação é a exceção que não precisa dessa ligação: o próprio filtro de validação chama o `IProblemDetailsService`, então seu `400` é personalizado independentemente de você adicionar ou não `UseStatusCodePages()`. Se você também quer que sua rede de segurança global capture o que a validação não captura, a mecânica do caminho de exceção é descrita em [como adicionar um filtro global de exceção no ASP.NET Core 11](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/).

## Retorne 422 em vez de 400 para validação

Uma escolha comum de design de API é distinguir "não consegui fazer o parse da sua requisição" (`400`) de "fiz o parse dela mas ela viola as regras" (`422 Unprocessable Entity`). Como o callback pode modificar `Status`, e o middleware escreve o status a partir do `ProblemDetails`, você pode promover falhas de validação para `422` em um único lugar:

```csharp
// .NET 11, C# 14
builder.Services.AddProblemDetails(options =>
{
    options.CustomizeProblemDetails = ctx =>
    {
        // Built-in validation always produces a 400 with an errors dictionary.
        if (ctx.ProblemDetails.Status == StatusCodes.Status400BadRequest
            && ctx.ProblemDetails.Extensions.ContainsKey("errors"))
        {
            ctx.ProblemDetails.Status = StatusCodes.Status422UnprocessableEntity;
            ctx.HttpContext.Response.StatusCode =
                StatusCodes.Status422UnprocessableEntity;
        }
    };
});
```

Defina tanto o campo `ProblemDetails.Status` (o que aparece no corpo JSON) quanto `HttpContext.Response.StatusCode` (a linha de status HTTP de fato). Esqueça o segundo e você entrega um corpo alegando `422` numa resposta HTTP `400`, o que é pior do que qualquer um dos dois sozinho. A verificação da chave `errors` restringe a reescrita especificamente a falhas de validação, então um `400` simples vindo de outro lugar no seu app mantém seu status.

## Assuma o controle total com um IProblemDetailsWriter personalizado

`CustomizeProblemDetails` modifica o objeto; ele não controla a serialização nem decide quando escrever. Para isso, implemente `IProblemDetailsWriter`. Um writer recebe uma barreira `CanWrite` e um `WriteAsync` que é dono do corpo da resposta, o que permite ramificar por código de status, negociação de conteúdo ou metadados do endpoint:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Http;

public sealed class ValidationProblemDetailsWriter : IProblemDetailsWriter
{
    public bool CanWrite(ProblemDetailsContext context)
        => context.ProblemDetails.Status is 400 or 422;

    public ValueTask WriteAsync(ProblemDetailsContext context)
    {
        context.ProblemDetails.Extensions["apiVersion"] = "2026-07";
        return new ValueTask(
            context.HttpContext.Response.WriteAsJsonAsync(
                context.ProblemDetails,
                context.ProblemDetails.GetType(),
                options: null,
                contentType: "application/problem+json"));
    }
}
```

Registre-o na DI, e registre-o antes de `AddControllers()` ou `AddRazorPages()` se você usar algum dos dois, porque eles registram seus próprios writers e a ordem decide qual vence:

```csharp
// .NET 11, C# 14
builder.Services.AddTransient<IProblemDetailsWriter, ValidationProblemDetailsWriter>();
```

Recorra a um writer apenas quando o callback não for suficiente: serialização diferente para clientes diferentes, XML ao lado de JSON, ou emitir um schema completamente diferente para um único código de status. Para adicionar campos e ajustar texto, `CustomizeProblemDetails` é menos código e menos coisa para errar.

## Personalizando um único endpoint em vez do app inteiro

Tudo acima é global. Quando você quer que a resposta de validação de um único endpoint seja moldada de forma diferente, retorne os problem details você mesmo a partir do handler com `TypedResults.ValidationProblem`, que aceita um dicionário `extensions` diretamente:

```csharp
// .NET 11, C# 14
app.MapPost("/legacy/products", (CreateProduct product) =>
{
    var errors = new Dictionary<string, string[]>();
    if (product.Quantity <= 0)
        errors["Quantity"] = ["Quantity must be positive on the legacy endpoint."];

    if (errors.Count > 0)
        return TypedResults.ValidationProblem(
            errors,
            extensions: new Dictionary<string, object?>
            {
                ["legacy"] = true
            });

    return TypedResults.Created($"/products/{product.Sku}", product);
});
```

Há uma armadilha aqui que vale afirmar claramente: um `ProblemDetails` que você constrói e retorna diretamente de um handler, seja através de `TypedResults.ValidationProblem`, `Results.Problem` ou `TypedResults.Problem`, é serializado direto para a resposta e **não** passa pelo `IProblemDetailsService`. Seu callback global `CustomizeProblemDetails` não vai rodar para ele, então o `traceId` que você adicionou de forma centralizada vai estar ausente. Se você misturar personalização global com problems retornados pelo handler, ou adicione os campos compartilhados no handler também, ou mantenha a validação no filtro embutido, que de fato roteia através do serviço. Essa é a surpresa mais comum de todas: o callback cobre problem details gerados pelo framework, não os que você mesmo instancia.

## Pegadinhas que mordem em produção

- **O cabeçalho `Accept` controla se você recebe JSON afinal.** O `DefaultProblemDetailsWriter` escreve para `application/json`, `application/problem+json` e curingas como `*/*` e `application/*`. Um cliente enviando `Accept: text/html` ou `application/xml` aciona o caminho de fallback e não recebe nenhum corpo de problem details. Se seus consumidores são navegadores ou clientes SOAP, leve isso em conta em vez de assumir que o JSON sempre é entregue.
- **`CustomizeProblemDetails` não era chamado para validação nas primeiras versões prévias do .NET 10.** Isso foi rastreado como [dotnet/aspnetcore#62723](https://github.com/dotnet/aspnetcore/issues/62723): o filtro de validação ignorava o `IProblemDetailsService`. Ele está conectado através do serviço no .NET 10 GA e no .NET 11. Se seu callback dispara para exceções mas silenciosamente pula erros de validação, você está em um SDK de versão prévia desatualizado; atualize-o.
- **A ordem importa quando você também usa controllers.** O MVC produz problem details de validação através de `ProblemDetailsFactory` e `InvalidModelStateResponseFactory`, não através de `CustomizeProblemDetails` sozinho. Um app misto com endpoints de minimal API e controllers precisa de ambos os caminhos configurados, ou seus controllers e suas minimal APIs vão discordar sobre o formato do erro.
- **Não vaze detalhes internos para `Detail`.** É tentador enfiar uma mensagem de exceção em `ProblemDetails.Detail` dentro do callback. Em produção isso expõe fragmentos de stack trace e nomes de tipos internos. Mantenha `Detail` seguro para o cliente e coloque a informação de diagnóstico atrás do seu `traceId` nos logs em vez disso.
- **O callback roda no caminho crítico de todo erro.** Mantenha-o barato. Ler `Activity.Current` e definir chaves de dicionário está ok; abrir uma conexão de banco de dados ou chamar um serviço remoto dentro de `CustomizeProblemDetails` não está, porque ele roda de forma síncrona enquanto escreve a resposta.

O modelo a guardar: `AddValidation()` decide o que é inválido, `AddProblemDetails()` decide como a invalidez é descrita, e `CustomizeProblemDetails` é o único lugar para moldar essa descrição para todo erro gerado pelo framework de uma vez. Adicione seu `traceId` ali, reescreva o `title` ali, promova para `422` ali, e recorra a um `IProblemDetailsWriter` personalizado apenas quando precisar ser dono da serialização. Para qualquer coisa que o filtro de validação não capture, o [filtro global de exceção](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) leva a mesma personalização adiante, e se você ainda está decidindo se o validador embutido cobre suas regras afinal, [validação de minimal API vs FluentValidation](/2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11/) traça essa linha.

## Relacionados

- [Como validar corpos de requisição em minimal APIs sem controllers no ASP.NET Core 11](/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/) para a configuração de `AddValidation()` que este post personaliza.
- [Validação de minimal API vs FluentValidation no ASP.NET Core 11](/2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11/) para saber se o validador embutido se encaixa nas suas regras antes de você personalizar sua saída.
- [Como adicionar um filtro global de exceção no ASP.NET Core 11](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) para capturar o que a validação não captura, com o mesmo formato de `ProblemDetails`.
- [Como organizar endpoints de minimal API com MapGroup no ASP.NET Core 11](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) para aplicar validação e seus problem details em um grupo inteiro de rotas.
- [Minimal APIs vs controllers no ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) para como o tratamento de erros difere entre os dois modelos de endpoint.

## Fontes

- Microsoft Learn, [Handle errors in ASP.NET Core APIs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/error-handling-api?view=aspnetcore-10.0) (`AddProblemDetails`, os middlewares que geram problem details, `CustomizeProblemDetails`, fallback do `IProblemDetailsService` e tipos de mídia suportados).
- Microsoft Learn, [Create responses in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/responses?view=aspnetcore-10.0) (personalizando respostas de erro de validação de minimal APIs com `IProblemDetailsService`, `TypedResults.ValidationProblem`).
- Microsoft Learn, [ProblemDetailsOptions.CustomizeProblemDetails](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.problemdetailsoptions.customizeproblemdetails) (assinatura do callback e `ProblemDetailsContext`).
- dotnet/aspnetcore, [CustomizeProblemDetails not invoked for minimal API validation (issue #62723)](https://github.com/dotnet/aspnetcore/issues/62723) (a lacuna da era das versões prévias, resolvida para o .NET 10 GA).
