---
title: "Migrar do Swashbuckle para o gerador de OpenAPI integrado no .NET 11"
description: "Uma migração passo a passo do Swashbuckle.AspNetCore para o Microsoft.AspNetCore.OpenApi no .NET 11: trocar AddSwaggerGen por AddOpenApi, converter os filtros de operação, esquema e documento em transformadores, manter uma UI e as mudanças incompatíveis do Microsoft.OpenApi v2 que pegam você."
pubDate: 2026-06-16
updatedDate: 2026-06-16
template: migration
tags:
  - "migration"
  - "swashbuckle"
  - "openapi"
  - "aspnetcore-11"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-06-16
---

Se o seu projeto ASP.NET Core ainda chama `builder.Services.AddSwaggerGen()` e `app.UseSwagger()`, você está usando o Swashbuckle.AspNetCore, o pacote que sustentou a história do OpenAPI no .NET por quase uma década. Desde o .NET 9 os templates de Web API não o incluem mais: um projeto novo usa em vez disso o pacote próprio da Microsoft, `Microsoft.AspNetCore.OpenApi`. Este artigo migra um código existente com Swashbuckle para o gerador integrado sobre `net11.0` com C# 14, cobrindo a parte que os guias para projetos novos pulam: o que remover, como cada `IOperationFilter`, `ISchemaFilter` e `IDocumentFilter` é mapeado para um transformador, como manter viva uma UI clicável e as mudanças incompatíveis do Microsoft.OpenApi v2 que não vão compilar até você corrigir.

Para uma API pequena com alguns filtros, isto é uma tarde. Para um serviço grande com uma dúzia de filtros personalizados, provedores de exemplos e várias versões com `SwaggerDoc`, reserve um dia. O Swashbuckle não está obsoleto, então isto é uma escolha e não uma marcha forçada. O motivo para fazer é que o gerador integrado vem na caixa, acompanha o runtime versão a versão, suporta Native AOT e emite OpenAPI 3.1 por padrão. O motivo para esperar é se você depende de recursos da UI do Swashbuckle ou de filtros da comunidade que ainda não têm equivalente como transformador. Decida isso antes de começar, não no meio do caminho.

## Por que migrar agora

- O gerador vem com o framework. Nenhum pacote de terceiros fixado no seu build que fica atrás de um lançamento do .NET, que é exatamente a dor do .NET 6 que levou a Microsoft a assumir isso.
- Ele reutiliza o suporte a esquemas do `System.Text.Json` que o resto do seu app já usa, de modo que os esquemas do documento batem com o que a sua API realmente serializa.
- É compatível com Native AOT. A geração do Swashbuckle, carregada de reflexão, não é, então um serviço de minimal API com AOT precisava largar o Swashbuckle de qualquer jeito.
- OpenAPI 3.1 e JSON Schema draft 2020-12 são os padrões, não uma opção a ativar.

## O que quebra

| Área | Mudança | Severidade |
| --- | --- | --- |
| `AddSwaggerGen` / `UseSwagger` | Substituídos por `AddOpenApi` / `MapOpenApi`; rota diferente (`/openapi/v1.json`, não `/swagger/v1/swagger.json`) | alta |
| `IOperationFilter` / `ISchemaFilter` / `IDocumentFilter` | Não são mais invocados; reescrever como `AddOperationTransformer` / `AddSchemaTransformer` / `AddDocumentTransformer` | alta |
| Swagger UI embutida | O framework gera apenas JSON; você adiciona uma UI (Scalar ou o pacote independente do Swagger UI) | alta |
| Namespace `Microsoft.OpenApi` | v2 move os tipos de `Microsoft.OpenApi.Models` para `Microsoft.OpenApi`; `OpenApiSchema` vira `IOpenApiSchema` | média |
| Exemplos de esquema | `OpenApiString`/`IOpenApiAny` somem; os exemplos agora são `System.Text.Json.Nodes.JsonNode` | média |
| Versão de spec padrão | O Swashbuckle usava OpenAPI 3.0 por padrão; o gerador integrado usa 3.1 | média |
| `SwaggerDoc("v1", ...)` | Substituído por `AddOpenApi("v1")` mais um transformador de documento para `Info` | baixa |
| `[SwaggerOperation]` / `EnableAnnotations` | Substituídos por metadados de minimal API (`WithSummary`, `WithDescription`, `WithTags`) | baixa |

## Checklist de pré-voo

1. Instale o SDK do .NET 11 em cada máquina de desenvolvimento e runner de CI. Verifique com `dotnet --list-sdks` e confirme que `11.0.x` aparece.
2. Inventarie a sua superfície do Swashbuckle. Faça grep na solução por `AddSwaggerGen`, `OperationFilter<`, `SchemaFilter<`, `DocumentFilter<`, `SwaggerDoc`, `EnableAnnotations` e `[SwaggerOperation`. A lista de filtros é o escopo real da migração.
3. Capture um documento de referência. Execute o app e salve `/swagger/v1/swagger.json` em um arquivo. Você vai comparar o novo documento com ele no fim.
4. Anote qualquer consumidor preso ao OpenAPI 3.0. Um gerador de cliente que engasga no 3.1 é a surpresa mais comum, e você resolve com uma linha, mais abaixo.
5. Faça um commit de uma base limpa para que a reversão seja um único comando.

## Passos da migração

### 1. Troque os pacotes

Remova o pacote do gerador e adicione o do framework. Se quiser manter a aparência do Swagger UI, mantenha apenas o pacote de recursos de UI dele, que é separado do gerador.

```dotnetcli
# .NET 11
dotnet remove package Swashbuckle.AspNetCore
dotnet add package Microsoft.AspNetCore.OpenApi
```

Se você usava `Swashbuckle.AspNetCore.Filters` (o pacote de filtros de exemplo/auth da comunidade), remova-o também; os recursos dele viram transformadores. **Verifique:** `dotnet build` tem sucesso ou falha apenas nos símbolos `AddSwaggerGen`/de filtro que agora estão faltando e que você vai substituir. Uma compilação limpa aqui significaria que você nunca usou o Swashbuckle de verdade.

### 2. Substitua as duas chamadas de registro

Esta é a troca central. O Swashbuckle registrava um gerador e dois middlewares; a versão integrada registra um serviço e mapeia um endpoint.

```csharp
// Before -- Swashbuckle, ASP.NET Core 8 style
builder.Services.AddSwaggerGen(c =>
{
    c.SwaggerDoc("v1", new OpenApiInfo { Title = "Todo API", Version = "v1" });
});

var app = builder.Build();

app.UseSwagger();
app.UseSwaggerUI();
```

```csharp
// After -- .NET 11, C# 14
builder.Services.AddOpenApi();

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}
```

O documento muda de `/swagger/v1/swagger.json` para `/openapi/v1.json`. O nome de documento padrão é `v1`, de onde vem o nome da rota. Repare no filtro `IsDevelopment()`: um documento OpenAPI é um mapa completo da sua superfície de ataque, então não o sirva para a internet pública por padrão. **Verifique:** execute o app e solicite `/openapi/v1.json`. Você deve obter um documento 3.1 listando cada endpoint. O bloco `Info` está genérico por enquanto; o passo 4 conserta isso.

### 3. Traga uma UI de volta

O Swashbuckle embutia o Swagger UI, então `/swagger` simplesmente funcionava. O gerador integrado produz apenas JSON. Escolha um visualizador e aponte-o para o documento. O padrão do template desde o .NET 9 é o Scalar:

```csharp
// .NET 11, C# 14
using Scalar.AspNetCore;

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.MapScalarApiReference();
}
```

Se a sua equipe é apegada ao Swagger UI, ele ainda funciona. Instale `Swashbuckle.AspNetCore.SwaggerUi` (apenas os recursos de UI, não o gerador) e aponte-o para a nova rota:

```csharp
// .NET 11, C# 14
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.UseSwaggerUI(options =>
    {
        options.SwaggerEndpoint("/openapi/v1.json", "v1");
    });
}
```

**Verifique:** navegue até `/scalar` (ou `/swagger`) e confirme que as operações renderizam e que "Try it out" alcança a sua API. Os detalhes para projeto novo de cada visualizador estão em [expor OpenAPI sem Swashbuckle no ASP.NET Core 11](/pt-br/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/).

### 4. Mova os metadados do documento para um transformador

`SwaggerDoc("v1", new OpenApiInfo { ... })` definia o título, a versão e a descrição. No modelo integrado isso é um transformador de documento, que roda sobre o `OpenApiDocument` antes de serializá-lo.

```csharp
// .NET 11, C# 14
using Microsoft.OpenApi;

builder.Services.AddOpenApi(options =>
{
    options.AddDocumentTransformer((document, context, cancellationToken) =>
    {
        document.Info = new OpenApiInfo
        {
            Title = "Todo API",
            Version = "v1",
            Description = "Task tracking endpoints."
        };
        return Task.CompletedTask;
    });
});
```

Atenção ao `using`. Com o Microsoft.OpenApi v2 (do qual agora dependem tanto o Swashbuckle v10 quanto o `Microsoft.AspNetCore.OpenApi`) os tipos do modelo se moveram de `Microsoft.OpenApi.Models` para `Microsoft.OpenApi`. Se você copiar código antigo de `OpenApiInfo` literalmente, ele não vai resolver. **Verifique:** recarregue o documento e confirme que o bloco `info` mostra o seu título e descrição.

### 5. Converta filtros de operação em transformadores de operação

Um `IOperationFilter` rodava uma vez por operação para adicionar uma resposta, um cabeçalho ou uma descrição. A assinatura do transformador é diferente, mas o corpo é quase idêntico.

```csharp
// Before -- Swashbuckle IOperationFilter
public class AddThrottleResponseFilter : IOperationFilter
{
    public void Apply(OpenApiOperation operation, OperationFilterContext context)
    {
        operation.Responses.TryAdd("429",
            new OpenApiResponse { Description = "Too Many Requests" });
    }
}
// registered: c.OperationFilter<AddThrottleResponseFilter>();
```

```csharp
// After -- .NET 11, C# 14
builder.Services.AddOpenApi(options =>
{
    options.AddOperationTransformer((operation, context, cancellationToken) =>
    {
        operation.Responses ??= new OpenApiResponses();
        operation.Responses["429"] = new OpenApiResponse
        {
            Description = "Too Many Requests"
        };
        return Task.CompletedTask;
    });
});
```

O `OperationFilterContext` tinha `ApiDescription`; o `context` do transformador expõe o mesmo `ApiDescription`, então qualquer lógica condicional baseada na rota, no método HTTP ou nos metadados se transfere igual. **Verifique:** encontre um endpoint que o seu filtro mirava e confirme que a resposta `429` (ou o que você adicionou) aparece nele no documento.

### 6. Converta filtros de esquema e de documento

`ISchemaFilter` vira `AddSchemaTransformer`. O contexto agora entrega um `JsonTypeInfo` em vez de um `Type`, então você lê `context.JsonTypeInfo.Type`:

```csharp
// After -- .NET 11, C# 14
options.AddSchemaTransformer((schema, context, cancellationToken) =>
{
    if (context.JsonTypeInfo.Type == typeof(Todo))
    {
        schema.Description = "A single task tracking item.";
    }
    return Task.CompletedTask;
});
```

`IDocumentFilter` vira `AddDocumentTransformer`, o mesmo hook usado para `Info` no passo 4. Use-o para `servers`, tags de nível superior e esquemas de segurança. Um comum é declarar um esquema Bearer para que a UI mostre um botão Authorize; você pode fazer isso inline ou com um `IOpenApiDocumentTransformer` fortemente tipado quando precisar injetar serviços. **Verifique:** confira que a descrição do esquema (ou o esquema de segurança) aparece onde o filtro antigo a colocava. Se você também condiciona o botão Authorize a um esquema de segurança e o visualizador ignora o token em silêncio, quase sempre é um esquema malformado, algo que detalhei em [por que o seu token Bearer é ignorado no Scalar](/pt-br/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/).

### 7. Substitua anotações por metadados de minimal API

Se você usava `EnableAnnotations()` e `[SwaggerOperation(Summary = "...", Description = "...")]`, remova os atributos e expresse os mesmos metadados com convenções de endpoint. Eles fluem direto para a operação:

```csharp
// .NET 11, C# 14
app.MapGet("/todos/{id}", (int id) => Results.Ok(new Todo(id, "Write", false)))
   .WithSummary("Get a todo by id")
   .WithDescription("Returns a single todo item, or 404 if it does not exist.")
   .WithTags("Todos")
   .Produces<Todo>(StatusCodes.Status200OK)
   .Produces(StatusCodes.Status404NotFound);
```

Para controllers, os comentários de documentação XML e os atributos `[ProducesResponseType]` que você já tem são lidos pelo explorador de API, então muito disso vem de graça. Manter os endpoints agrupados com [MapGroup](/pt-br/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) permite que um único `WithTags` no grupo marque cada operação dele. **Verifique:** os resumos e as tags renderizam na UI, e `EnableAnnotations` não aparece mais em lugar nenhum do projeto.

### 8. Lide com vários documentos e versionamento

O `SwaggerDoc("v1", ...)` / `SwaggerDoc("v2", ...)` repetido do Swashbuckle vira chamadas repetidas a `AddOpenApi`, cada uma com o próprio nome e opções. Quais endpoints vão para qual documento é decidido por `ShouldInclude`:

```csharp
// .NET 11, C# 14
builder.Services.AddOpenApi("public", options =>
{
    options.ShouldInclude = description =>
        description.GroupName is null || description.GroupName == "public";
});
builder.Services.AddOpenApi("internal");
```

Cada nome ganha a própria rota: `/openapi/public.json` e `/openapi/internal.json`. Se você usa `Asp.Versioning`, ele se integra com este modelo de documentos em vez de brigar com ele. **Verifique:** solicite cada rota de documento e confirme que os endpoints corretos aparecem em cada uma.

## Verificação

Rode este checklist antes de apagar o caminho de código antigo:

- `dotnet build` está limpo, com zero avisos, incluindo referências remanescentes a `Microsoft.OpenApi.Models`.
- `dotnet test` passa, especialmente qualquer teste de contrato que fixava a rota antiga `/swagger/v1/swagger.json`; atualize-os para `/openapi/v1.json`.
- Compare o novo `/openapi/v1.json` com a referência que você salvou no pré-voo. Espere que a linha de versão mude de `3.0.x` para `3.1.x` e que o tratamento de `nullable` nos esquemas difira; todo o resto deve bater operação por operação.
- Cada endpoint que os seus filtros antigos tocavam ainda carrega as mesmas respostas, cabeçalhos e descrições.
- A UI carrega e "Try it out" alcança um endpoint real.
- Se você gera um cliente a partir do spec, regenere-o e confirme que ele ainda compila. Veja [gerar um cliente fortemente tipado a partir de um spec de OpenAPI](/pt-br/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/).

## Plano de reversão

Esta migração é reversível até você começar a apagar as classes de filtro. Para reverter, `dotnet remove package Microsoft.AspNetCore.OpenApi`, adicione de novo `Swashbuckle.AspNetCore` e restaure `AddSwaggerGen` / `UseSwagger` / `UseSwaggerUI`. Como as reescritas de filtro para transformador são edições no local, o commit limpo do pré-voo é a sua verdadeira reversão: faça `git checkout` do commit e você volta ao Swashbuckle em um passo. Faça a migração em uma branch e guarde o commit de referência até o novo documento ter rodado em um ambiente real.

## Tropeços que tivemos

**O padrão OpenAPI 3.1 quebra o tooling que só entende 3.0.** Este é o ticket pós-migração mais comum. Se um gerador downstream rejeitar o documento, rebaixe a versão explicitamente em vez de reverter toda a migração:

```csharp
// .NET 11, C# 14
using Microsoft.OpenApi;

builder.Services.AddOpenApi(options =>
{
    options.OpenApiVersion = OpenApiSpecVersion.OpenApi3_0;
});
```

**Os exemplos de esquema agora são `JsonNode`, não `OpenApiString`.** O Microsoft.OpenApi v2 removeu a hierarquia `IOpenApiAny`. Se um filtro de esquema definia `schema.Example = new OpenApiString("...")`, o equivalente do transformador atribui um `System.Text.Json.Nodes.JsonNode`, por exemplo `JsonValue.Create("...")` ou um `JsonObject`. Esta é a edição com maior chance de não compilar durante a reescrita.

**O documento é regenerado a cada requisição.** `MapOpenApi` roda o pipeline completo toda vez que o endpoint é atingido, de propósito, para que os transformadores possam reagir ao estado em tempo real. Para um documento muito requisitado, faça cache com `.CacheOutput()` no endpoint, ou gere-o em tempo de build com `Microsoft.Extensions.ApiDescription.Server` e sirva um arquivo estático. A geração em tempo de build roda o seu `Program.cs`, então proteja o código de inicialização (como abrir uma conexão de banco de dados) pelo nome do assembly de entrada quando ele não deve rodar durante o build.

**Os esquemas inferidos são mais rígidos que os do Swashbuckle.** O gerador integrado só documenta o que o explorador de API vê. Se um endpoint mínimo retorna `IResult` sem uma sobrecarga tipada ou uma chamada a `Produces<T>`, o esquema de resposta some. O Swashbuckle às vezes mascarava isso com reflexão; o novo gerador quer a anotação. Adicione `Produces<T>` e `Accepts<T>` onde o esquema sumir.

**`OpenApiSchema` agora é uma interface.** Código que declarava `OpenApiSchema schema` como parâmetro ou variável local pode precisar de `IOpenApiSchema`, e a propriedade `Nullable` sumiu em favor de `JsonSchemaType.Null`. Se você escreveu filtros de esquema elaborados, é aqui que a maioria dos erros de compilação cai.

O modelo mental é pequeno depois que ele encaixa: o framework é dono do documento, os transformadores substituem os filtros e a UI é uma preocupação separada e intercambiável. O grosso do trabalho são as reescritas de filtro para transformador e as mudanças de namespace e tipos do Microsoft.OpenApi v2; a troca de registro em si são duas linhas.

## Leituras relacionadas

- [Como expor OpenAPI sem Swashbuckle no ASP.NET Core 11](/pt-br/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/)
- [Como organizar endpoints de minimal API com MapGroup no ASP.NET Core 11](/pt-br/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [Como gerar código de cliente fortemente tipado a partir de um spec de OpenAPI no .NET 11](/pt-br/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/)
- [Scalar no ASP.NET Core: por que o seu token Bearer é ignorado](/pt-br/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/)
- [Migrar do .NET 8 para o .NET 11: o checklist completo](/pt-br/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/)

## Fontes

- [Generate OpenAPI documents, documentação do ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/aspnetcore-openapi?view=aspnetcore-10.0)
- [Customize OpenAPI documents, documentação do ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/customize-openapi?view=aspnetcore-10.0)
- [Swashbuckle.AspNetCore migrating to v10](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/blob/master/docs/migrating-to-v10.md)
- [Microsoft.AspNetCore.OpenApi no NuGet](https://www.nuget.org/packages/Microsoft.AspNetCore.OpenApi/)
- [Microsoft.Extensions.ApiDescription.Server no NuGet](https://www.nuget.org/packages/Microsoft.Extensions.ApiDescription.Server)
</content>
