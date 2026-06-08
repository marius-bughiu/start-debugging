---
title: "Como expor OpenAPI sem Swashbuckle no ASP.NET Core 11"
description: "O Swashbuckle saiu dos templates do ASP.NET Core. Veja como gerar e servir um documento OpenAPI no .NET 11 com o pacote integrado Microsoft.AspNetCore.OpenApi: AddOpenApi, MapOpenApi, transformadores, múltiplos documentos, geração em tempo de build e uma interface por cima."
pubDate: 2026-06-08
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "openapi"
lang: "pt-br"
translationOf: "2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-06-08
---

Se você criou uma Web API do ASP.NET Core recentemente e foi procurar `AddSwaggerGen` e `UseSwagger`, eles não estavam lá. Desde o .NET 9, os templates de Web API incluem o gerador de OpenAPI próprio da Microsoft no lugar do Swashbuckle. Para expor um documento OpenAPI no .NET 11 você instala `Microsoft.AspNetCore.OpenApi`, chama `builder.Services.AddOpenApi()` e chama `app.MapOpenApi()`. Isso serve o documento em `/openapi/v1.json`. Não há interface inclusa: se você quer uma página interativa, adiciona Scalar ou Swagger UI separadamente e aponta para esse endpoint JSON. Tudo abaixo tem como alvo o .NET 11 com `Microsoft.NET.Sdk.Web` e C# 14, mas a mesma API existe no .NET 9 e 10.

## Por que o Swashbuckle saiu do template

O Swashbuckle.AspNetCore foi por anos a história padrão de OpenAPI, mas era um pacote de terceiros fixado nos templates oficiais, e ficava muito atrás das versões do .NET. A era do .NET 6 é o caso de alerta: a manutenção do Swashbuckle estagnou, o pacote ficou sem uma versão estável que tivesse como alvo o runtime mais recente, e equipes que atualizavam para uma nova versão do .NET ficavam presas esperando uma dependência que não controlavam. A Microsoft decidiu que a geração de OpenAPI era essencial o suficiente para incluir na caixa, do mesmo jeito que o serializador JSON e o contêiner de injeção de dependência.

O resultado é o `Microsoft.AspNetCore.OpenApi`. Ele gera documentos [OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.1.html) por padrão, usa [JSON Schema draft 2020-12](https://json-schema.org/specification-links#2020-12), reutiliza o suporte a schema do `System.Text.Json` em que o resto do framework já se apoia e é compatível com Native AOT. A única coisa que ele deliberadamente não faz é renderizar uma interface. O Swashbuckle empacotava ao mesmo tempo o gerador de documentos e os recursos web do Swagger UI; a Microsoft separou essas responsabilidades. O framework produz a especificação e você escolhe o visualizador.

## As duas chamadas que geram o documento

Adicione o pacote:

```dotnetcli
dotnet add package Microsoft.AspNetCore.OpenApi
```

Depois registre os serviços e mapeie o endpoint:

```csharp
// .NET 11, C# 14
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOpenApi();

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

app.MapGet("/todos/{id}", (int id) => new Todo(id, "Write the spec", false));

app.Run();

record Todo(int Id, string Title, bool Done);
```

Execute a aplicação e requisite `https://localhost:{port}/openapi/v1.json`. Você recebe um documento OpenAPI 3.1 completo descrevendo cada endpoint que o explorador de API consegue ver, com schemas inferidos a partir dos tipos dos seus parâmetros e de retorno. `AddOpenApi()` registra os serviços do documento e `MapOpenApi()` adiciona o route handler que serializa o documento sob demanda.

O nome de documento padrão é `v1`, por isso a rota é `/openapi/v1.json`. O template de rota do `MapOpenApi` é `/openapi/{documentName}.json`. Duas coisas merecem atenção no trecho acima. Primeiro, o endpoint do documento está protegido atrás de `IsDevelopment()`. Essa é a recomendação do próprio framework: um documento OpenAPI é um mapa completo da sua superfície de ataque, então não o sirva para a internet pública por padrão. Segundo, ainda não há interface. Acessar `/openapi/v1.json` te dá JSON cru, que é exatamente o que as ferramentas querem, mas não o que um humano quer percorrer clicando.

## Traga a sua própria interface

Esta é a parte que confunde quem vem do Swashbuckle, onde `/swagger` simplesmente funcionava. No .NET 11 você escolhe um visualizador e o conecta à rota do documento.

O padrão do template desde o .NET 9 pende para o Scalar. Instale `Scalar.AspNetCore` e mapeie:

```csharp
// .NET 11, C# 14
using Scalar.AspNetCore;

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.MapScalarApiReference();
}
```

Navegue para `https://localhost:{port}/scalar` e você recebe uma interface de referência interativa que lê o documento `/openapi/v1.json`. O Scalar detecta automaticamente a rota padrão, então não há mais nada a configurar no caso comum.

Se a sua equipe é apegada ao Swagger UI, ele continua funcionando. Instale `Swashbuckle.AspNetCore.SwaggerUi` (só os recursos da interface, não o gerador) e aponte para o documento:

```csharp
// .NET 11, C# 14
var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();

    app.UseSwaggerUI(options =>
    {
        options.SwaggerEndpoint("/openapi/v1.json", "v1");
    });
}
```

Isso serve o Swagger UI em `/swagger`, lendo o documento gerado pelo framework em vez de um gerado pelo Swashbuckle. O ReDoc funciona do mesmo jeito: sirva a interface estática e dê a ela a URL `/openapi/v1.json`. O framework não se importa com qual visualizador você usa porque ele só é dono do JSON. Como nota de segurança, mantenha as três interfaces atrás de uma verificação de apenas desenvolvimento pela mesma razão que você protege o próprio documento.

## Adicione títulos, descrições e metadados

Um documento básico tem um título genérico e nenhuma descrição. Você o enriquece em dois lugares: metadados por endpoint e transformadores no nível do documento.

Os metadados por endpoint usam as mesmas convenções de minimal API que você já usa para roteamento. `WithSummary`, `WithDescription` e `WithTags` fluem direto para a operação:

```csharp
// .NET 11, C# 14
app.MapGet("/todos/{id}", (int id) => Results.Ok(new Todo(id, "Write", false)))
   .WithSummary("Get a todo by id")
   .WithDescription("Returns a single todo item, or 404 if it does not exist.")
   .WithTags("Todos")
   .Produces<Todo>(StatusCodes.Status200OK)
   .Produces(StatusCodes.Status404NotFound);
```

Para informação no nível do documento como o título da API, a versão e o contato, registre um transformador de documento. Um transformador roda sobre o `OpenApiDocument` gerado antes de ele ser serializado, então você pode definir ou reescrever qualquer coisa:

```csharp
// .NET 11, C# 14
using Microsoft.OpenApi.Models;

builder.Services.AddOpenApi(options =>
{
    options.AddDocumentTransformer((document, context, cancellationToken) =>
    {
        document.Info = new OpenApiInfo
        {
            Title = "Todo API",
            Version = "v1",
            Description = "Task tracking endpoints for the Start Debugging sample.",
            Contact = new OpenApiContact { Name = "API team", Email = "api@example.com" }
        };
        return Task.CompletedTask;
    });
});
```

Os transformadores são o ponto de extensão que substitui a maior parte do que você fazia com os filtros do Swashbuckle. Há três tipos, e eles rodam na ordem em que você os registra:

- `AddDocumentTransformer` modifica o documento inteiro. Use para `Info`, `servers`, esquemas de segurança de nível superior e tags.
- `AddOperationTransformer` roda uma vez por operação. Use para adicionar uma resposta comum, um parâmetro de cabeçalho ou uma descrição a cada endpoint.
- `AddSchemaTransformer` roda uma vez por schema gerado. Use para adicionar exemplos, ajustar formatos ou marcar propriedades.

Uma tarefa real comum é declarar um esquema de segurança Bearer para que a interface mostre um botão de Authorize. Isso é um transformador de documento que adiciona o esquema e um requisito global. Se você esbarrou no caso em que o visualizador ignora o token silenciosamente, a causa quase sempre é um esquema de segurança ausente ou malformado no documento, o que cobri em detalhe em [por que o seu token Bearer é ignorado no Scalar](/pt-br/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/).

Para um transformador fortemente tipado você implementa `IOpenApiDocumentTransformer` (ou os equivalentes de operação e schema) e registra o tipo. Isso permite injetar serviços, por exemplo para ler os esquemas de autenticação registrados e emitir definições de segurança correspondentes:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi.Models;

internal sealed class BearerSecuritySchemeTransformer : IOpenApiDocumentTransformer
{
    public Task TransformAsync(
        OpenApiDocument document,
        OpenApiDocumentTransformerContext context,
        CancellationToken cancellationToken)
    {
        document.Components ??= new OpenApiComponents();
        document.Components.SecuritySchemes["Bearer"] = new OpenApiSecurityScheme
        {
            Type = SecuritySchemeType.Http,
            Scheme = "bearer",
            BearerFormat = "JWT",
            In = ParameterLocation.Header
        };
        return Task.CompletedTask;
    }
}

// Registration
builder.Services.AddOpenApi(options =>
{
    options.AddDocumentTransformer<BearerSecuritySchemeTransformer>();
});
```

## Gere mais de um documento

O Swashbuckle lidava com "v1 e v2" ou "público e interno" com várias chamadas a `SwaggerDoc`. O gerador integrado faz isso com várias chamadas a `AddOpenApi`, cada uma com seu próprio nome e opções:

```csharp
// .NET 11, C# 14
builder.Services.AddOpenApi("public");
builder.Services.AddOpenApi("internal");
```

Cada documento nomeado recebe sua própria rota: `/openapi/public.json` e `/openapi/internal.json`. Quais endpoints caem em qual documento é decidido pelo delegate `ShouldInclude` em `OpenApiOptions`. Por padrão ele usa o nome do grupo do endpoint, definido com `WithGroupName` ou o atributo `[EndpointGroupName]`, e qualquer endpoint sem nome de grupo é incluído em todos os documentos. Você pode substituir `ShouldInclude` por qualquer predicado sobre o `ApiDescription`:

```csharp
// .NET 11, C# 14
builder.Services.AddOpenApi("public", options =>
{
    options.ShouldInclude = description =>
        description.GroupName is null || description.GroupName == "public";
});
```

Se você tem versionamento de API rodando, as bibliotecas de versionamento se integram com esse mesmo modelo de documento em vez de brigar com ele, o que é uma melhoria real em relação à configuração antiga. Veja [Asp.Versioning com OpenAPI integrado](/pt-br/2026/04/api-versioning-openapi-dotnet-10/) para o padrão de um documento por versão.

## Gere o documento em tempo de build

Servir o documento sobre HTTP é ótimo para desenvolvimento, mas às vezes você quer o arquivo JSON como artefato de build: para confirmá-lo no controle de versão, para rodar testes de contrato contra ele, para alimentar um [gerador de código de cliente](/pt-br/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/), ou para servi-lo como arquivo estático em produção em vez de expor um endpoint ativo. Para isso, adicione o pacote de tempo de build:

```dotnetcli
dotnet add package Microsoft.Extensions.ApiDescription.Server
```

Com o pacote instalado, `dotnet build` emite o documento em `obj/` com o nome do projeto. Para controlar onde ele aterrissa e se é gerado, defina propriedades de MSBuild no `.csproj`:

```xml
<PropertyGroup>
  <OpenApiGenerateDocuments>true</OpenApiGenerateDocuments>
  <OpenApiDocumentsDirectory>$(MSBuildProjectDirectory)</OpenApiDocumentsDirectory>
</PropertyGroup>
```

`OpenApiDocumentsDirectory` é resolvido relativo ao arquivo de projeto, então o valor acima deixa o JSON junto do `.csproj`. Para renomear o arquivo ou selecionar um único documento quando você gera vários, use `OpenApiGenerateDocumentsOptions`:

```xml
<PropertyGroup>
  <OpenApiGenerateDocumentsOptions>--file-name my-api --document-name public</OpenApiGenerateDocumentsOptions>
</PropertyGroup>
```

A geração em tempo de build funciona lançando o ponto de entrada da sua aplicação contra um servidor simulado, então o seu `Program.cs` realmente roda. Isso significa que o código de inicialização, as leituras de configuração e os registros de injeção de dependência são todos executados durante o build. Se algo na inicialização não deveria rodar nesse contexto, por exemplo conectar a um banco de dados, proteja com base no nome do assembly de entrada:

```csharp
// .NET 11, C# 14
using System.Reflection;

if (Assembly.GetEntryAssembly()?.GetName().Name != "GetDocument.Insider")
{
    builder.Services.AddDbContext<AppDbContext>(/* ... */);
}
```

Uma limitação atual: a geração em tempo de build produz só JSON. A saída YAML é suportada em tempo de execução (dê ao `MapOpenApi` uma rota `.yaml`) mas ainda não em tempo de build.

## Detalhes que vale conhecer antes de publicar

**O documento é regenerado a cada requisição.** `MapOpenApi` roda toda a pipeline de geração cada vez que o endpoint é acessado, de propósito, para que os transformadores possam reagir ao estado em tempo real. Para um documento muito requisitado você pode cacheá-lo com cache de saída e `.CacheOutput()` no endpoint, ou simplesmente apoiar-se na geração em tempo de build e servir um arquivo estático.

**A versão de especificação padrão é a 3.1, e isso pode quebrar ferramentas antigas.** Alguns consumidores ainda entendem apenas OpenAPI 3.0. Se um gerador a jusante engasga com um documento 3.1, rebaixe a versão explicitamente:

```csharp
// .NET 11, C# 14
using Microsoft.OpenApi;

builder.Services.AddOpenApi(options =>
{
    options.OpenApiVersion = OpenApiSpecVersion.OpenApi3_0;
});
```

Em tempo de build o equivalente é `<OpenApiGenerateDocumentsOptions>--openapi-version OpenApi3_1</OpenApiGenerateDocumentsOptions>`.

**O endpoint não tem autorização por padrão.** Se você expuser o documento fora de desenvolvimento, proteja-o. `MapOpenApi()` retorna um endpoint convention builder, então `app.MapOpenApi().RequireAuthorization("SomePolicy")` funciona igual a qualquer minimal endpoint.

**Ele só documenta o que o explorador de API vê.** Os endpoints de minimal API são descobertos automaticamente, mas se você retorna `IResult` sem uma sobrecarga tipada ou uma chamada a `Produces`, o gerador não consegue inferir o schema da resposta. Anote com `Produces<T>` e `Accepts<T>` para que o documento seja preciso. Essa é a mesma disciplina que as minimal API recompensam em outros lugares, e combina bem com manter os endpoints organizados via [MapGroup](/pt-br/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/), já que convenções no nível de grupo como `WithTags` fluem para cada operação do grupo.

A mudança mental em relação ao Swashbuckle é pequena depois que você a internaliza: o framework é dono do documento, os transformadores substituem os filtros, e a interface é uma responsabilidade separada e intercambiável. Você escreve duas linhas para obter JSON, mais uma linha para obter um visualizador, e um punhado de transformadores para deixar o documento apresentável. Nada está preso a um pacote que publica no calendário de outra pessoa.

## Leitura relacionada

- [Como organizar endpoints de minimal API com MapGroup no ASP.NET Core 11](/pt-br/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [Como adicionar fluxos de autenticação OpenAPI ao Swagger UI no .NET 11](/pt-br/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/)
- [Como gerar código de cliente fortemente tipado a partir de uma especificação OpenAPI no .NET 11](/pt-br/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/)
- [Scalar no ASP.NET Core: por que o seu token Bearer é ignorado](/pt-br/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/)
- [Minimal APIs vs controllers no ASP.NET Core 11](/pt-br/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)

## Fontes

- [Generate OpenAPI documents, documentação do ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/aspnetcore-openapi?view=aspnetcore-10.0)
- [Use the generated OpenAPI documents, documentação do ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/using-openapi-documents?view=aspnetcore-10.0)
- [Customize OpenAPI documents, documentação do ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/customize-openapi?view=aspnetcore-10.0)
- [Microsoft.AspNetCore.OpenApi no NuGet](https://www.nuget.org/packages/Microsoft.AspNetCore.OpenApi/)
- [Microsoft.Extensions.ApiDescription.Server no NuGet](https://www.nuget.org/packages/Microsoft.Extensions.ApiDescription.Server)
</content>
