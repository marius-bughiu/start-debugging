---
title: "Migrar IOperationFilter e ISchemaFilter do Swashbuckle para transformadores de OpenAPI no .NET 11"
description: "Uma referência de migração filtro a filtro para mover o código de IOperationFilter e ISchemaFilter do Swashbuckle para os transformadores de operação e esquema integrados no .NET 11, com o mapeamento dos objetos de contexto e as mudanças do Microsoft.OpenApi v2 que quebram a compilação."
pubDate: 2026-07-24
updatedDate: 2026-07-24
template: migration
tags:
  - "migration"
  - "swashbuckle"
  - "openapi"
  - "aspnetcore-11"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/07/migrate-swashbuckle-ioperationfilter-and-ischemafilter-to-transformers-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-07-24
---

Se você já trocou `AddSwaggerGen()` por `AddOpenApi()` no `net11.0`, o registro é a parte fácil. O trabalho que realmente consome a tarde são seus filtros personalizados: cada `IOperationFilter` e `ISchemaFilter` que você escreveu contra o Swashbuckle deixa de ser invocado no momento em que o gerador muda, porque o gerador integrado `Microsoft.AspNetCore.OpenApi` não tem o conceito de filtros. Ele tem transformadores. Este artigo é a referência de migração filtro a filtro: como as duas interfaces de filtro se mapeiam para `IOpenApiOperationTransformer` e `IOpenApiSchemaTransformer`, no que cada propriedade de contexto se transforma, e as mudanças de tipos do Microsoft.OpenApi v2 que não vão compilar até você corrigi-las. Ele mira o .NET 11 (`net11.0`, C# 14), `Microsoft.AspNetCore.OpenApi` v11 e `Microsoft.OpenApi` v2, migrando a partir do Swashbuckle.AspNetCore v10.

Para um punhado de filtros isso leva menos de uma hora. Para um serviço grande com uma dúzia de filtros, um provedor de exemplos e um filtro de polimorfismo, reserve meio dia. A forma mecânica de cada migração é quase idêntica, então o custo não é a reescrita: são os dois objetos de contexto que expõem informações diferentes, e as mudanças no modelo de tipos do Microsoft.OpenApi v2. Se você ainda não fez a troca de registro que envolve tudo isso, faça isso primeiro com [o guia completo de migração do Swashbuckle para o integrado](/pt-br/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/); tudo o que segue pressupõe que `AddOpenApi()` e `MapOpenApi()` já estão no lugar.

## Por que migrar os filtros

- Os filtros são código morto no momento em que você abandona o gerador do Swashbuckle. Eles compilam (os tipos continuam existindo enquanto o pacote for referenciado) mas nunca executam, então seu documento perde silenciosamente cada personalização que eles aplicavam.
- Os transformadores reutilizam os mesmos metadados do `System.Text.Json` com os quais o resto da sua aplicação serializa, então um transformador de esquema vê exatamente a forma de tipo que sua API emite, não uma aproximação por reflexão.
- Os transformadores são compatíveis com Native AOT. O pipeline de filtros do Swashbuckle, movido por reflexão, não é, então um serviço AOT não tem nenhuma opção de filtros.
- Um único modelo de extensibilidade cobre documento, operação e esquema em vez de três interfaces de filtro mais atributos de anotação.

## O que quebra

| Área | Swashbuckle | Integrado no .NET 11 | Severidade |
| --- | --- | --- | --- |
| Gancho de operação | `IOperationFilter.Apply(OpenApiOperation, OperationFilterContext)` | `IOpenApiOperationTransformer.TransformAsync(...)` | alta |
| Gancho de esquema | `ISchemaFilter.Apply(OpenApiSchema, SchemaFilterContext)` | `IOpenApiSchemaTransformer.TransformAsync(...)` | alta |
| Assinatura do método | `void Apply` síncrono | `Task TransformAsync(..., CancellationToken)` | média |
| Registro | `c.OperationFilter<T>(args)` / `c.SchemaFilter<T>(args)` | `options.AddOperationTransformer<T>()` / `AddSchemaTransformer<T>()` | média |
| Exemplos de esquema | `OpenApiString` / `IOpenApiAny` | `System.Text.Json.Nodes.JsonNode` | média |
| Campo de tipo do esquema | `schema.Type = "string"` string + `Nullable` | enum de flags `JsonSchemaType`, flag `Null` | média |
| Membro por reflexão | `context.MemberInfo` (`MemberInfo`) | `context.JsonPropertyInfo` (`JsonPropertyInfo`) | média |
| Geração de subesquemas | `context.SchemaGenerator.GenerateSchema(...)` | `context.GetOrCreateSchemaAsync(...)` | baixa |

## Checklist de pré-voo

1. Confirme que o SDK do .NET 11 está instalado em cada máquina de desenvolvimento e runner de CI: `dotnet --list-sdks` deve listar `11.0.x`.
2. Inventarie os filtros. Faça um grep na solução por `IOperationFilter`, `ISchemaFilter`, `IDocumentFilter`, `OperationFilter<` e `SchemaFilter<`. Essa lista é o escopo exato desta migração; nada mais muda aqui.
3. Salve um documento de referência. Com o Swashbuckle ainda conectado, requisite `/swagger/v1/swagger.json` e guarde o arquivo. Você vai comparar o documento migrado com ele, endpoint por endpoint.
4. Confirme que `AddOpenApi()` e `MapOpenApi()` já produzem um documento em `/openapi/v1.json`. Se não, migre o registro primeiro.
5. Faça o trabalho em um branch com um commit base limpo para que o rollback seja um único `git checkout`.

## Os dois objetos de contexto, mapeados

Antes das receitas, o mapeamento que torna cada migração mecânica. Um filtro do Swashbuckle e um transformador integrado entregam a você o mesmo objeto OpenAPI para mutar (`OpenApiOperation` ou `OpenApiSchema`), mas o contexto ao redor difere.

`OperationFilterContext` para `OpenApiOperationTransformerContext`:

| Swashbuckle | Integrado | Notas |
| --- | --- | --- |
| `ApiDescription` | `Description` | O mesmo tipo `ApiDescription`; propriedade renomeada. A rota, o método e `ActionDescriptor.EndpointMetadata` são preservados. |
| `MethodInfo` | `Description.ActionDescriptor` | Leia os metadados do descritor em vez do `MethodInfo` cru. |
| `SchemaRepository` | `Document` | Registre esquemas compartilhados com `Document.AddComponent(...)`. |
| `SchemaGenerator` | `GetOrCreateSchemaAsync(...)` | Agora um método do contexto, não um objeto gerador à parte. |
| `DocumentName` | `DocumentName` | Sem mudanças. |

`SchemaFilterContext` para `OpenApiSchemaTransformerContext`:

| Swashbuckle | Integrado | Notas |
| --- | --- | --- |
| `Type` | `JsonTypeInfo.Type` | O `Type` do CLR está um salto mais fundo, dentro dos metadados do `System.Text.Json`. |
| `MemberInfo` | `JsonPropertyInfo` | Não nulo apenas para um esquema de propriedade. Leia os atributos via `JsonPropertyInfo.AttributeProvider`. |
| `ParameterInfo` | `ParameterDescription` | Um `ApiParameterDescription`; nulo para um esquema de resposta. |
| `SchemaGenerator` | `GetOrCreateSchemaAsync(...)` | Igual ao acima. |
| `DocumentName` | `DocumentName` | Sem mudanças. |

Mantenha essas duas tabelas abertas enquanto migra. Noventa por cento de cada reescrita é renomear uma propriedade de contexto e ajustar para `JsonTypeInfo`.

## Passos da migração

### 1. Mapeie cada filtro para sua interface de transformador e registro

Cada `IOperationFilter` vira um `IOpenApiOperationTransformer` (ou um delegate inline `AddOperationTransformer`), e cada `ISchemaFilter` vira um `IOpenApiSchemaTransformer`. Um `void Apply` síncrono vira um `TransformAsync` assíncrono que retorna um `Task` e recebe um `CancellationToken`. O registro se move do callback de `AddSwaggerGen` para o bloco de opções de `AddOpenApi`.

```csharp
// Before -- Swashbuckle registration, ASP.NET Core 8 style
builder.Services.AddSwaggerGen(c =>
{
    c.OperationFilter<AddCorrelationHeaderFilter>();
    c.SchemaFilter<MarkMoneyFormatFilter>();
});
```

```csharp
// After -- .NET 11, C# 14
builder.Services.AddOpenApi(options =>
{
    options.AddOperationTransformer<AddCorrelationHeaderTransformer>();
    options.AddSchemaTransformer<MarkMoneyFormatTransformer>();
});
```

**Verifique:** o projeto ainda compila com as antigas classes de filtro removidas ou renomeadas, e `AddOpenApi` compila com os novos registros. Nada roda corretamente ainda; os próximos passos preenchem os corpos.

### 2. Migre um IOperationFilter que adiciona uma resposta ou um cabeçalho

Este é o filtro mais comum e a migração mais mecânica. O corpo mal muda: você muta `operation` no lugar. Proteja-se contra uma coleção `Parameters` ou `Responses` nula, que o modelo integrado deixa nula em vez de pré-alocar.

```csharp
// Before -- Swashbuckle IOperationFilter
public class AddCorrelationHeaderFilter : IOperationFilter
{
    public void Apply(OpenApiOperation operation, OperationFilterContext context)
    {
        operation.Parameters ??= new List<OpenApiParameter>();
        operation.Parameters.Add(new OpenApiParameter
        {
            Name = "X-Correlation-Id",
            In = ParameterLocation.Header,
            Required = false,
            Schema = new OpenApiSchema { Type = "string" }
        });
    }
}
```

```csharp
// After -- .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

internal sealed class AddCorrelationHeaderTransformer : IOpenApiOperationTransformer
{
    public Task TransformAsync(
        OpenApiOperation operation,
        OpenApiOperationTransformerContext context,
        CancellationToken cancellationToken)
    {
        operation.Parameters ??= [];
        operation.Parameters.Add(new OpenApiParameter
        {
            Name = "X-Correlation-Id",
            In = ParameterLocation.Header,
            Required = false,
            Schema = new OpenApiSchema { Type = JsonSchemaType.String }
        });
        return Task.CompletedTask;
    }
}
```

Duas mudanças além da assinatura: `Type = "string"` vira `Type = JsonSchemaType.String` (o tipo do esquema é um enum de flags no Microsoft.OpenApi v2, não uma string), e o namespace de `OpenApiParameter` e companhia é `Microsoft.OpenApi`, não `Microsoft.OpenApi.Models`. **Verifique:** requisite `/openapi/v1.json` e confirme que cada operação agora carrega o parâmetro de cabeçalho `X-Correlation-Id`.

### 3. Migre um IOperationFilter que lê o endpoint

Filtros condicionais baseados em rota, método HTTP ou metadados são onde o `OperationFilterContext` importava. O `ApiDescription` que você lê é o mesmo tipo; ele é exposto como `context.Description`. O padrão de farejar `EndpointMetadata` em busca de um atributo é preservado literalmente.

```csharp
// After -- .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.OpenApi;

internal sealed class ThrottleResponseTransformer : IOpenApiOperationTransformer
{
    public Task TransformAsync(
        OpenApiOperation operation,
        OpenApiOperationTransformerContext context,
        CancellationToken cancellationToken)
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
    }
}
```

Se seu antigo filtro recorria a `context.MethodInfo` para ler um atributo personalizado, prefira `context.Description.ActionDescriptor.EndpointMetadata`, já que endpoints de minimal API expõem seus metadados ali e podem não ter um `MethodInfo` significativo. **Verifique:** escolha um endpoint que carrega o atributo de limite de taxa e um que não, e confirme que apenas o primeiro mostra uma resposta `429` no documento.

### 4. Migre um ISchemaFilter que molda um tipo

O corpo do filtro de esquema muda em exatamente um ponto: `context.Type` vira `context.JsonTypeInfo.Type`. Tudo o que você fazia com `schema` permanece igual.

```csharp
// Before -- Swashbuckle ISchemaFilter
public class DescribeTodoFilter : ISchemaFilter
{
    public void Apply(OpenApiSchema schema, SchemaFilterContext context)
    {
        if (context.Type == typeof(Todo))
        {
            schema.Description = "A single task tracking item.";
        }
    }
}
```

```csharp
// After -- .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

internal sealed class DescribeTodoTransformer : IOpenApiSchemaTransformer
{
    public Task TransformAsync(
        OpenApiSchema schema,
        OpenApiSchemaTransformerContext context,
        CancellationToken cancellationToken)
    {
        if (context.JsonTypeInfo.Type == typeof(Todo))
        {
            schema.Description = "A single task tracking item.";
        }
        return Task.CompletedTask;
    }
}
```

**Verifique:** encontre o esquema `Todo` sob `components.schemas` no documento e confirme que a descrição está presente.

### 5. Migre um ISchemaFilter que mira uma propriedade

O Swashbuckle avisava que um esquema era um esquema de propriedade entregando a você um `context.MemberInfo` não nulo. O equivalente integrado é um `context.JsonPropertyInfo` não nulo. Como o gerador integrado é movido pelo `System.Text.Json`, `JsonPropertyInfo.Name` é o nome JSON serializado (já em camelCase se essa for sua política), não o nome do membro CLR, o que elimina toda uma classe de bugs de divergência de maiúsculas.

```csharp
// After -- .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

internal sealed class EmailFormatTransformer : IOpenApiSchemaTransformer
{
    public Task TransformAsync(
        OpenApiSchema schema,
        OpenApiSchemaTransformerContext context,
        CancellationToken cancellationToken)
    {
        if (context.JsonPropertyInfo?.Name == "email")
        {
            schema.Format = "email";
        }
        return Task.CompletedTask;
    }
}
```

Se seu antigo filtro lia um atributo personalizado do `MemberInfo`, obtenha-o através de `context.JsonPropertyInfo?.AttributeProvider?.GetCustomAttributes(...)`, que expõe o `PropertyInfo` subjacente. **Verifique:** confirme que cada propriedade `email` ao longo dos seus esquemas agora carrega `"format": "email"`.

### 6. Migre um provedor de exemplos

Os exemplos de esquema são o mais provável de não compilar. O Microsoft.OpenApi v2 removeu toda a hierarquia `IOpenApiAny` (`OpenApiString`, `OpenApiInteger`, `OpenApiObject`). Os exemplos agora são `System.Text.Json.Nodes.JsonNode`.

```csharp
// Before -- Swashbuckle, IOpenApiAny example
schema.Example = new OpenApiString("dev@example.com");
```

```csharp
// After -- .NET 11, C# 14
using System.Text.Json.Nodes;

schema.Example = JsonValue.Create("dev@example.com");
```

Para um exemplo composto, construa um `JsonObject` em vez de um `OpenApiObject`: `new JsonObject { ["id"] = 1, ["title"] = "Write" }`. **Verifique:** o campo `example` do esquema alvo é renderizado como JSON válido no documento e na sua interface.

### 7. Migre um filtro que precisava de argumentos de construtor ou serviços

O Swashbuckle deixava você passar argumentos de construtor no registro (`c.OperationFilter<T>(arg1, arg2)`) ou resolver serviços porque os filtros eram ativados a partir do contêiner. O registro genérico integrado `options.AddOperationTransformer<T>()` ativa o transformador a partir da injeção de dependência, então injete por meio de um construtor primário em vez de passar argumentos posicionais.

```csharp
// After -- .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

internal sealed class TosLinkTransformer(IOptions<ApiInfoOptions> options)
    : IOpenApiOperationTransformer
{
    public Task TransformAsync(
        OpenApiOperation operation,
        OpenApiOperationTransformerContext context,
        CancellationToken cancellationToken)
    {
        operation.ExternalDocs = new OpenApiExternalDocs
        {
            Url = options.Value.TermsOfServiceUrl
        };
        return Task.CompletedTask;
    }
}
```

Apenas a sobrecarga genérica participa da injeção de dependência; `AddOperationTransformer(new T(...))` e a sobrecarga de delegate não. A forma genérica é resolvida do zero a cada geração do documento e liberada em seguida, então um transformador `IDisposable` é limpo cada vez que o documento é construído. **Verifique:** o valor injetado aparece no documento, e o transformador resolve sem um erro de "no service for type" na primeira requisição.

### 8. Migre um filtro que gerava subesquemas

Os filtros mais delicados chamavam `context.SchemaGenerator.GenerateSchema(type, context.SchemaRepository)` para construir um esquema de um tipo que a operação não referenciava de outra forma, por exemplo um corpo de erro compartilhado. A substituição integrada é `context.GetOrCreateSchemaAsync(...)` mais `context.Document.AddComponent(...)`.

```csharp
// After -- .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

internal sealed class ErrorResponseTransformer : IOpenApiOperationTransformer
{
    public async Task TransformAsync(
        OpenApiOperation operation,
        OpenApiOperationTransformerContext context,
        CancellationToken cancellationToken)
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
    }
}
```

Note o tipado `OpenApiSchemaReference("Error", context.Document)` em vez de um `OpenApiReference` construído à mão. **Verifique:** o esquema `Error` aparece uma vez sob `components.schemas` e as operações o referenciam em vez de embutir uma cópia. A mecânica de transformador-primeiro do `GetOrCreateSchemaAsync` é coberta em profundidade em [personalizar OpenAPI com transformadores de operação e esquema](/pt-br/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/).

## Verificação

Rode isto antes de deletar as antigas classes de filtro:

- `dotnet build` está limpo, sem referências a `Microsoft.OpenApi.Models` nem às interfaces de filtro do `Swashbuckle.AspNetCore.SwaggerGen`.
- Compare o `/openapi/v1.json` migrado com a referência que você salvou no pré-voo. Espere que a versão da especificação e o tratamento de `nullable` difiram (3.1 vs 3.0); cada resposta, cabeçalho, descrição e exemplo que seus filtros produziam deve bater operação por operação.
- Cada propriedade que um filtro de esquema mirava ainda mostra o mesmo formato, exemplo ou descrição.
- `dotnet test` passa, incluindo qualquer teste de contrato que verificava a forma do documento.
- Se você alimenta o documento a um gerador de clientes, regenere e confirme que ainda compila. Veja [gerar código de cliente fortemente tipado a partir de uma especificação OpenAPI](/pt-br/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/).

## Plano de rollback

Esta migração é reversível até você deletar as classes de filtro. Como cada reescrita é uma nova classe de transformador ao lado do antigo filtro, o rollback mais seguro é o commit base limpo do pré-voo: faça `git checkout` do commit e readicione `c.OperationFilter<T>()` / `c.SchemaFilter<T>()` no bloco de `AddSwaggerGen`. Mantenha tanto os filtros quanto os transformadores na árvore até que o documento migrado tenha rodado em um ambiente real, depois delete os filtros em um commit à parte.

## Armadilhas que enfrentamos

**Os transformadores de esquema rodam mais de uma vez para o mesmo tipo.** Um transformador de esquema dispara por cada ocorrência do esquema, e a passagem que deduplica esquemas idênticos para `components.schemas` roda depois dos transformadores. Um tipo usado em três lugares tem seu transformador invocado três vezes, então mantenha a lógica idempotente: verifique antes de adicionar, e nunca adicione a uma lista que você pode revisitar. O `ISchemaFilter` do Swashbuckle tinha uma aresta relacionada (não era invocado para esquemas já referenciados), então não assuma que a contagem de invocações antiga se preserva.

**A ordem de execução é esquemas, depois operações, depois documentos.** Os filtros no Swashbuckle rodavam em ordem de registro dentro de cada tipo. O pipeline integrado roda todos os transformadores de esquema primeiro, depois os de operação, depois os de documento, e roda por cada geração do documento. Um transformador de operação não pode depender de um transformador de documento ter rodado, porque os documentos rodam por último. Isso tropeça quem colocou um esquema de segurança em um transformador de documento e tentou referenciá-lo a partir de um transformador de operação na mesma passagem.

**`context.Type` agora está a dois saltos.** O erro de compilação mais comum depois de um buscar-e-substituir em massa é deixar `context.Type` em um transformador de esquema. É `context.JsonTypeInfo.Type`. Um segundo próximo é `context.MemberInfo`, que é `context.JsonPropertyInfo`.

**O documento é regenerado a cada requisição.** `MapOpenApi` roda todo o pipeline de transformadores toda vez que a rota é atingida, então mantenha os transformadores baratos. Para um documento com muito tráfego, faça cache dele com `.CacheOutput()` no endpoint ou gere-o em tempo de compilação. O Swashbuckle fazia cache de forma mais agressiva, então um filtro pesado que antes estava bem pode aparecer agora como latência.

**`OpenApiSchema` é um tipo concreto no transformador, mas `IOpenApiSchema` aparece em outros lugares.** O delegate do transformador entrega a você um `OpenApiSchema` mutável. Outras APIs do v2 retornam `IOpenApiSchema`, então um método auxiliar que costumava receber `OpenApiSchema` pode precisar da interface. Se você conectou um esquema de segurança por meio de um transformador de documento e o visualizador ignora o token, isso quase sempre é um esquema malformado e não um bug do cliente, rastreado de ponta a ponta em [por que seu token Bearer é ignorado no Scalar](/pt-br/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/).

O modelo mental é pequeno quando cai a ficha: um filtro e um transformador ambos entregam a você o mesmo objeto OpenAPI para mutar, então o corpo mal muda. A migração é renomear propriedades de contexto, mudar para `JsonTypeInfo`, mover os exemplos para `JsonNode` e manter a lógica de esquema idempotente porque agora ela roda mais de uma vez. Faça filtro a filtro, compare com a referência, e o documento que você serve é o que seus consumidores já esperam.

## Leituras relacionadas

- [Migrar do Swashbuckle para o gerador de OpenAPI integrado no .NET 11](/pt-br/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/)
- [Como personalizar OpenAPI com transformadores de operação e esquema no ASP.NET Core 11](/pt-br/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/)
- [Como expor OpenAPI sem Swashbuckle no ASP.NET Core 11](/pt-br/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/)
- [Como organizar endpoints de minimal API com MapGroup no ASP.NET Core 11](/pt-br/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [Scalar no ASP.NET Core: por que seu token Bearer é ignorado](/pt-br/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/)

## Fontes

- [Personalizar documentos OpenAPI, documentação do ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/customize-openapi?view=aspnetcore-10.0)
- [OpenApiSchemaTransformerContext, referência da API do .NET](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.openapi.openapischematransformercontext)
- [IOpenApiOperationTransformer, referência da API do .NET](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.openapi.iopenapioperationtransformer)
- [Swashbuckle.AspNetCore, migração para v10](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/blob/master/docs/migrating-to-v10.md)
- [Guia de atualização do Microsoft.OpenAPI v2](https://github.com/microsoft/OpenAPI.NET/blob/main/docs/upgrade-guide-2.md)
