---
title: "Como personalizar o documento OpenAPI com AddOperationTransformer e AddSchemaTransformer no ASP.NET Core 11"
description: "Um mergulho profundo no pipeline de transformadores OpenAPI embutido no .NET 11: transformadores de operação versus de esquema, os objetos de contexto, a ordem de execução, transformadores ativados por DI e receitas para cabeçalhos, respostas, exemplos e ajustes por propriedade."
pubDate: 2026-07-12
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "openapi"
lang: "pt-br"
translationOf: "2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-12
---

O gerador embutido `Microsoft.AspNetCore.OpenApi` no .NET 11 é dono do documento OpenAPI, e a maneira de mudar o que ele emite é com transformadores. São três: `AddDocumentTransformer` para o documento inteiro, `AddOperationTransformer` para cada operação de caminho mais método, e `AddSchemaTransformer` para cada modelo de dados. Para adicionar um parâmetro de cabeçalho ou uma resposta compartilhada a todos os endpoints, use um transformador de operação. Para definir um formato, exemplo ou descrição em um tipo ou propriedade, use um transformador de esquema. Este post tem como alvo o .NET 11 (`net11.0`, C# 14) com `Microsoft.AspNetCore.OpenApi` e `Microsoft.OpenApi` v2, e vai além das linhas únicas para chegar aos objetos de contexto, à ordem de execução que confunde as pessoas, e às mudanças de tipo do Microsoft.OpenApi v2 que não compilarão se você copiar exemplos do .NET 8.

Se você ainda não gerou um documento, comece com [como expor OpenAPI sem Swashbuckle](/pt-br/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/); tudo abaixo pressupõe que `builder.Services.AddOpenApi()` e `app.MapOpenApi()` já estejam no lugar.

## O que cada transformador pode tocar

Os três tipos de transformador não são intercambiáveis, e escolher o errado é o erro mais comum. A regra é sobre escopo:

- Um **transformador de documento** enxerga o `OpenApiDocument` inteiro. É a ferramenta certa para `Info`, `servers`, `tags` de nível superior e esquemas de segurança, porque esses vivem na raiz.
- Um **transformador de operação** é invocado uma vez por operação, onde uma operação é um caminho único mais um método HTTP (`GET /todos/{id}` é uma operação, `POST /todos` é outra). Recorra a ele quando quiser uma mudança em cada endpoint, ou em endpoints que correspondam a uma condição que você possa ler dos metadados.
- Um **transformador de esquema** é invocado para cada esquema que o gerador produz, incluindo os aninhados. É onde você toca na forma dos corpos de requisição e resposta: formatos, exemplos, descrições, nulidade, obsolescência.

Tentar adicionar uma resposta a "todas as operações" a partir de um transformador de documento significa percorrer manualmente `document.Paths`; usando um transformador de operação, o framework entrega cada operação diretamente a você. O inverso também é verdadeiro: definir `document.Info` a partir de um transformador de operação rodaria uma vez por endpoint e se sobrescreveria. Combine o transformador com a altitude da coisa que você está mudando.

## Quatro passos para adicionar um cabeçalho global e moldar um esquema

Aqui está o procedimento central de ponta a ponta. Ele registra um transformador de operação que carimba um cabeçalho de correlation-id em cada endpoint, e um transformador de esquema que corrige o formato de um tipo.

1. **Abra o bloco de opções do `AddOpenApi`.** Todos os três métodos `Add*Transformer` pendem de `OpenApiOptions`, então você registra dentro do delegate `AddOpenApi(options => { ... })`.

2. **Registre um transformador de operação para o cabeçalho.** A assinatura do delegate é `(OpenApiOperation operation, OpenApiOperationTransformerContext context, CancellationToken ct)`. Mute `operation` no lugar e retorne uma `Task`.

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

builder.Services.AddOpenApi(options =>
{
    options.AddOperationTransformer((operation, context, cancellationToken) =>
    {
        operation.Parameters ??= [];
        operation.Parameters.Add(new OpenApiParameter
        {
            Name = "X-Correlation-Id",
            In = ParameterLocation.Header,
            Required = false,
            Description = "Client-supplied request id, echoed back in the response.",
            Schema = new OpenApiSchema { Type = JsonSchemaType.String }
        });
        return Task.CompletedTask;
    });
});
```

3. **Registre um transformador de esquema para o tipo.** Seu delegate é `(OpenApiSchema schema, OpenApiSchemaTransformerContext context, CancellationToken ct)`. O exemplo clássico é dizer aos consumidores que um `decimal` tem precisão monetária, não é um float:

```csharp
// .NET 11, C# 14
options.AddSchemaTransformer((schema, context, cancellationToken) =>
{
    if (context.JsonTypeInfo.Type == typeof(decimal))
    {
        schema.Format = "decimal";
    }
    return Task.CompletedTask;
});
```

4. **Regere e verifique.** Requisite `/openapi/v1.json`. Cada operação agora deve carregar o parâmetro de cabeçalho `X-Correlation-Id`, e cada propriedade `decimal` deve mostrar `"format": "decimal"`. Como `MapOpenApi` regera o documento a cada requisição, não há nada para reiniciar além do próprio app.

Esse é o loop inteiro. O resto deste post é o detalhe que torna esses transformadores confiáveis em vez de surpreendentes.

## Os objetos de contexto, propriedade por propriedade

Cada transformador recebe um contexto, e os contextos diferem porque cada transformador conhece coisas diferentes.

O contexto de **operação** (`OpenApiOperationTransformerContext`) expõe `DocumentName`, `Description` (a `ApiDescription` para o endpoint) e `ApplicationServices` (o `IServiceProvider`). `Description` é o importante: ele carrega a rota, o método HTTP e `ActionDescriptor.EndpointMetadata`, que é como você torna um transformador condicional. Por exemplo, adicione uma resposta `429` apenas a endpoints que realmente tenham uma política de limitação de taxa anexada:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.RateLimiting;

options.AddOperationTransformer((operation, context, cancellationToken) =>
{
    var isRateLimited = context.Description.ActionDescriptor.EndpointMetadata
        .OfType<EnableRateLimitingAttribute>()
        .Any();

    if (isRateLimited)
    {
        operation.Responses ??= new OpenApiResponses();
        operation.Responses["429"] = new OpenApiResponse
        {
            Description = "Too many requests. Retry after the window resets."
        };
    }

    return Task.CompletedTask;
});
```

O contexto de **esquema** (`OpenApiSchemaTransformerContext`) expõe `DocumentName`, `JsonTypeInfo`, `JsonPropertyInfo` e `ApplicationServices`. `JsonTypeInfo` são os metadados do `System.Text.Json` para o tipo sendo descrito, então `context.JsonTypeInfo.Type` é o `Type` CLR. `JsonPropertyInfo` é preenchido apenas quando o esquema está sendo gerado para uma propriedade específica, o que permite mirar em um membro em vez de um tipo inteiro:

```csharp
// .NET 11, C# 14
using System.Text.Json.Nodes;

options.AddSchemaTransformer((schema, context, cancellationToken) =>
{
    // Target the Email property on any type that has one.
    if (context.JsonPropertyInfo?.Name == "email")
    {
        schema.Format = "email";
        schema.Example = JsonValue.Create("dev@example.com");
    }

    return Task.CompletedTask;
});
```

O contexto de **documento** (`OpenApiDocumentTransformerContext`) expõe `DocumentName`, `DescriptionGroups` (os `ApiDescriptionGroups`) e `ApplicationServices`. Você recorre a transformadores de documento quando o alvo é a raiz do documento, na maioria das vezes o esquema de segurança, que cubro abaixo.

## A ordem de execução é esquema, depois operação, depois documento

Esta é a parte que produz relatórios de bug do tipo "minha mudança sumiu". Os transformadores não rodam na ordem que você poderia esperar ao ler o arquivo. O framework os roda nesta ordem:

- **Transformadores de esquema primeiro.** Todos os esquemas são registrados no documento antes de qualquer operação ser processada, então cada transformador de esquema roda antes de qualquer transformador de operação. Dentro dos transformadores de esquema, eles rodam na ordem de registro, e um posterior enxerga as mutações de um anterior.
- **Transformadores de operação em seguida.** Cada um roda quando sua operação é adicionada, na ordem de registro, depois que todos os esquemas existem. No momento em que um transformador de operação roda, os esquemas para os tipos daquela operação já estão moldados.
- **Transformadores de documento por último.** Eles rodam na passagem final, quando cada operação e esquema está presente. Um transformador de documento posterior enxerga as edições do anterior.

A consequência prática: se um transformador de documento precisa que um esquema já esteja moldado de determinada forma, ele estará, porque os esquemas rodaram primeiro. Mas um transformador de operação não pode contar com um transformador de documento ter rodado, porque os documentos rodam por último. Quando você gera múltiplos documentos, o pipeline inteiro roda de forma independente por documento, então um transformador registrado no documento `internal` nunca toca o `public`.

## Transformadores fortemente tipados e injeção de dependência

Delegates inline são ótimos para ajustes sem estado. Quando um transformador precisa de um serviço, implemente a interface e registre o tipo para que o framework o ative a partir da DI. As interfaces são `IOpenApiDocumentTransformer`, `IOpenApiOperationTransformer` e `IOpenApiSchemaTransformer`, cada uma com um único `TransformAsync`. Use um construtor primário para injetar:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

internal sealed class BearerSecuritySchemeTransformer(
    IAuthenticationSchemeProvider authenticationSchemeProvider) : IOpenApiDocumentTransformer
{
    public async Task TransformAsync(
        OpenApiDocument document,
        OpenApiDocumentTransformerContext context,
        CancellationToken cancellationToken)
    {
        var schemes = await authenticationSchemeProvider.GetAllSchemesAsync();
        if (schemes.Any(s => s.Name == "Bearer"))
        {
            document.Components ??= new OpenApiComponents();
            document.Components.SecuritySchemes["Bearer"] = new OpenApiSecurityScheme
            {
                Type = SecuritySchemeType.Http,
                Scheme = "bearer",
                In = ParameterLocation.Header,
                BearerFormat = "JSON Web Token"
            };
        }
    }
}

// Registration
builder.Services.AddOpenApi(options =>
{
    options.AddDocumentTransformer<BearerSecuritySchemeTransformer>();
});
```

Registre um transformador ativado por DI com a sobrecarga genérica (`AddDocumentTransformer<T>()`), uma instância pré-construída (`AddDocumentTransformer(new T())`), ou um delegate. Apenas a forma genérica participa da injeção de dependência. A forma genérica é resolvida do zero por geração de documento e descartada depois, então um transformador que implementa `IDisposable` é limpo cada vez que o documento é produzido. Esse tempo de vida por geração é o motivo pelo qual você deve manter os transformadores baratos: com um endpoint `MapOpenApi` ativo, o pipeline roda a cada requisição à rota do documento. Se o documento for caro de construir, faça cache do endpoint com `.CacheOutput()` ou gere-o em [tempo de build](/pt-br/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/) em vez disso.

Registrar um esquema de segurança é o trabalho canônico de um transformador de documento. Se você conectou um esquema mas o visualizador ainda ignora o token, a causa é quase sempre um esquema malformado no documento em vez de um bug do cliente, o que rastreei de ponta a ponta em [por que seu token Bearer é ignorado no Scalar](/pt-br/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/). Para o fluxo correspondente por endpoint no Swagger UI, veja [adicionando fluxos de autenticação OpenAPI](/pt-br/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/).

## Transformadores de operação por endpoint

Você nem sempre quer uma mudança em cada operação. Um transformador de operação registrado em um único endpoint roda apenas para aquele endpoint, via `AddOpenApiOperationTransformer` no builder do endpoint. Marcar uma rota como obsoleta é uma linha única:

```csharp
// .NET 11, C# 14
app.MapGet("/v1/report", GenerateReport)
   .AddOpenApiOperationTransformer((operation, context, cancellationToken) =>
   {
       operation.Deprecated = true;
       operation.Description = "Superseded by /v2/report. Removed in the next major version.";
       return Task.CompletedTask;
   });
```

Isso limita o escopo de forma limpa: sem farejar `context.Description`, sem correspondência de rota, apenas o endpoint ao qual você o anexou. Combina bem com o agrupamento de endpoints, já que um transformador anexado a um grupo flui para cada operação nele. Veja [organizando endpoints de minimal API com MapGroup](/pt-br/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) para esse padrão.

## Gerando um esquema em tempo de execução

Às vezes um transformador de operação precisa de um esquema para um tipo que o endpoint de outra forma não referencia, por exemplo um corpo de erro compartilhado. Desde o .NET 10, o contexto do transformador expõe `GetOrCreateSchemaAsync`, que constrói um esquema com a mesma lógica que o gerador usa, e `context.Document.AddComponent`, que o estaciona sob `components.schemas` para reúso:

```csharp
// .NET 11, C# 14
options.AddOperationTransformer(async (operation, context, cancellationToken) =>
{
    var errorSchema = await context.GetOrCreateSchemaAsync(
        typeof(ProblemDetails), null, cancellationToken);
    context.Document?.AddComponent("Error", errorSchema);

    operation.Responses ??= new OpenApiResponses();
    operation.Responses["4XX"] = new OpenApiResponse
    {
        Description = "Bad request.",
        Content = new Dictionary<string, OpenApiMediaType>
        {
            ["application/problem+json"] = new OpenApiMediaType
            {
                Schema = new OpenApiSchemaReference("Error", context.Document)
            }
        }
    };
});
```

Essa é a maneira limpa de documentar um contrato de erro consistente sem decorar cada endpoint com `Produces<ProblemDetails>`. Se você está moldando as respostas de erro em si em vez de apenas documentá-las, isso é uma preocupação separada tratada por [IProblemDetailsService](/pt-br/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/).

## Mudanças de tipo do Microsoft.OpenApi v2 que quebram exemplos antigos

O .NET 10 atualizou a dependência `Microsoft.OpenApi` para v2, e o modelo de objetos mudou de maneiras que não compilarão se você colar um transformador do .NET 8. Três mudanças mordem mais:

**`OpenApiSchema.Type` agora é um enum de flags, não uma string.** No v1 você escrevia `Type = "string"` com um `Nullable = true` separado. No v2, `Type` é um `JsonSchemaType` anulável, e a nulidade é expressa unindo a flag `Null`:

```csharp
// .NET 11, Microsoft.OpenApi v2
// A nullable string:
schema.Type = JsonSchemaType.String | JsonSchemaType.Null;
```

**Exemplos são `JsonNode`, não `OpenApiString`.** Toda a hierarquia `IOpenApiAny` (`OpenApiString`, `OpenApiInteger`, `OpenApiObject`) foi removida. Atribua um `System.Text.Json.Nodes.JsonNode` em vez disso, que é por que o exemplo de propriedade acima usou `JsonValue.Create(...)`. Para um exemplo de objeto, construa um `JsonObject`. Esta é a edição que tem mais probabilidade de falhar na compilação quando você migra filtros de esquema antigos, um ponto que aprofundo no [guia de migração de Swashbuckle para o embutido](/pt-br/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/).

**Referências são tipadas.** Em vez de construir manualmente um `OpenApiReference`, use `OpenApiSchemaReference("Name", document)` e `OpenApiSecuritySchemeReference("Bearer", document)`. Essas resolvem contra o documento que você passa, o que captura uma referência pendente na construção em vez de na serialização.

## Armadilhas que surgem depois que o documento parece correto

**Transformadores de esquema podem rodar mais de uma vez para o mesmo tipo.** Um transformador de esquema dispara por ocorrência de esquema, e a passagem que deduplica esquemas idênticos em `components.schemas` roda *depois* de todos os transformadores. Então um tipo usado em três lugares pode ter seu transformador de esquema invocado três vezes. Mantenha a lógica idempotente: verifique antes de adicionar, e nunca acrescente a uma lista que você possa revisitar.

**O reúso de esquema não é algo que você controla a partir de um transformador.** Se um esquema é embutido inline ou elevado para `components.schemas` é decidido pelo framework depois que os transformadores rodam, usando `OpenApiOptions.CreateSchemaReferenceId`. Enums são sempre referenciados; para embuti-los inline em vez disso, retorne `null` desse delegate para tipos enum:

```csharp
// .NET 11, C# 14
options.CreateSchemaReferenceId = type =>
    type.Type.IsEnum ? null : OpenApiOptions.CreateDefaultSchemaReferenceId(type);
```

**Um transformador de operação não pode enxergar o trabalho de um transformador de documento.** Como os documentos rodam por último, não coloque um esquema em um transformador de documento e tente referenciá-lo a partir de um transformador de operação na mesma execução. Registre o esquema *e* o requisito por operação a partir do mesmo transformador de documento, ou aplique o requisito por operação a partir de um transformador de documento que percorra `document.Paths` no final.

**Apenas o que o explorador de API enxerga é documentado.** Transformadores moldam o que existe; eles não podem inventar uma operação que o explorador nunca descobriu. Se uma minimal API retorna um `IResult` cru sem `Produces<T>`, não há esquema de resposta para um transformador tocar. Anote o endpoint primeiro. Esquemas precisos importam a jusante também, já que um [gerador de cliente fortemente tipado](/pt-br/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/) é tão bom quanto o documento que você lhe fornece.

O modelo mental é pequeno quando cai a ficha: os esquemas são moldados primeiro, as operações em seguida, o documento por último, e cada transformador só toca a camada para a qual foi nomeado. Escolha a altitude, mute no lugar, mantenha idempotente, e o documento que você serve é exatamente o que seus consumidores e geradores de código esperam.

## Leitura relacionada

- [Como expor OpenAPI sem Swashbuckle no ASP.NET Core 11](/pt-br/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/)
- [Migre do Swashbuckle para a geração de documento OpenAPI embutida no .NET 11](/pt-br/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/)
- [Como adicionar fluxos de autenticação OpenAPI ao Swagger UI no .NET 11](/pt-br/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/)
- [Scalar no ASP.NET Core: por que seu token Bearer é ignorado](/pt-br/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/)
- [Como organizar endpoints de minimal API com MapGroup no ASP.NET Core 11](/pt-br/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)

## Fontes

- [Customize OpenAPI documents, ASP.NET Core docs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/customize-openapi?view=aspnetcore-10.0)
- [IOpenApiOperationTransformer, .NET API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.openapi.iopenapioperationtransformer)
- [IOpenApiSchemaTransformer, .NET API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.openapi.iopenapischematransformer)
- [Breaking change: Microsoft.OpenApi upgraded to v2, ASP.NET Core docs](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/11/microsoft-openapi-3x?view=aspnetcore-10.0)
- [Microsoft.OpenAPI v2 upgrade guide](https://github.com/microsoft/OpenAPI.NET/blob/main/docs/upgrade-guide-2.md)
