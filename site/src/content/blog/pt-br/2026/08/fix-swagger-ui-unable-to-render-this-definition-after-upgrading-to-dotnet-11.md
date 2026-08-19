---
title: "Correção: Swagger UI mostra Unable to render this definition após atualizar para .NET 11"
description: "O ASP.NET Core 11 emite openapi 3.2.0 por padrão e o Swagger UI abaixo de 10.1.5 o rejeita. Atualize Swashbuckle.AspNetCore.SwaggerUI ou fixe OpenApiVersion em OpenApi3_1."
pubDate: 2026-08-19
template: error-page
tags:
  - "errors"
  - "openapi"
  - "swagger"
  - "swashbuckle"
  - "aspnetcore"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/08/fix-swagger-ui-unable-to-render-this-definition-after-upgrading-to-dotnet-11"
translatedBy: "claude"
translationDate: 2026-08-19
---

Sua API continua subindo, `/openapi/v1.json` continua retornando 200, mas a página do Swagger UI mostra uma caixa cinza dizendo que a definição não especifica um campo de versão válido. A causa é uma mudança de padrão no .NET 11: `AddOpenApi` agora escreve `"openapi": "3.2.0"` em vez de `"openapi": "3.1.1"`, e o bundle do Swagger UI distribuído em `Swashbuckle.AspNetCore.SwaggerUI` 10.1.4 e anteriores só aceita `3.0.x` e `3.1.x`. Atualize esse pacote para 10.1.5 ou posterior, ou defina `options.OpenApiVersion = OpenApiSpecVersion.OpenApi3_1` e siga em frente. Nada nos seus endpoints, transformadores ou esquemas está quebrado.

Tudo abaixo foi medido no SDK do .NET `11.0.100-preview.7.26381.103` com `Microsoft.AspNetCore.OpenApi` `11.0.0-preview.7.26381.103` (que resolve `Microsoft.OpenApi` 3.9.0), comparado com o SDK do .NET 10.0.201 com `Microsoft.AspNetCore.OpenApi` 10.0.10.

## O erro em contexto

O Swagger UI substitui toda a lista de operações por este painel:

```text
Unable to render this definition

The provided definition does not specify a valid version field.

Please indicate a valid Swagger or OpenAPI version field. Supported version
fields are swagger: "2.0" and those that match openapi: 3.x.y (for example,
openapi: 3.1.0).
```

O texto engana em dois pontos. O documento tem sim um campo de versão, e `3.2.0` de fato corresponde ao formato `3.x.y` que a mensagem descreve. O que o bundle realmente faz é comparar os componentes maior e menor com uma lista fixa de permissões, e `3.2` não está nela nas compilações antigas.

Não há nenhuma exceção do lado do servidor para encontrar. O endpoint do documento está saudável:

```bash
curl -s http://localhost:5331/openapi/v1.json | head -3
```

```json
{
  "openapi": "3.2.0",
  "info": {
```

Essa primeira linha é o problema inteiro. Se você vê `3.2.0` ali e uma caixa cinza no navegador, está na página certa.

## Por que o .NET 11 emite openapi 3.2.0

`OpenApiOptions.OpenApiVersion` mudou seu padrão de `OpenApiSpecVersion.OpenApi3_1` para `OpenApiSpecVersion.OpenApi3_2` no .NET 11 Preview 6. A Microsoft documenta isso como uma mudança de comportamento intencional para que as aplicações adotem a especificação mais recente sem configuração extra ([OpenApiVersion passa a ter OpenApi3_2 como padrão](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/11/openapi-version-default-3-2?view=aspnetcore-10.0)).

Esse padrão se tornou alcançável por causa de uma segunda mudança, uma preview antes: no .NET 11 Preview 3, `Microsoft.AspNetCore.OpenApi` saiu de `Microsoft.OpenApi` 2.x para 3.x, e a linha 3.x é a que adicionou os serializadores para OpenAPI 3.2.0 ([Microsoft.OpenApi atualizado para 3.x](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/11/microsoft-openapi-3x?view=aspnetcore-10.0)). A fixação da dependência aparece no próprio pacote: `Microsoft.AspNetCore.OpenApi` 11.0.0-preview.7 declara `Microsoft.OpenApi` `[3.9.0, 4.0.0)`, enquanto 10.0.10 declarava `2.0.0`.

A consequência importante é que a string de versão mudou, mas o documento não. Mais sobre isso abaixo.

## Reprodução mínima

Três linhas de API e um registro do Swagger UI bastam.

```xml
<!-- net11.0, .NET SDK 11.0.100-preview.7.26381.103 -->
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.AspNetCore.OpenApi" Version="11.0.0-preview.7.26381.103" />
    <PackageReference Include="Swashbuckle.AspNetCore.SwaggerUI" Version="9.0.6" />
  </ItemGroup>
</Project>
```

```csharp
// .NET 11, C# 14, Microsoft.AspNetCore.OpenApi 11.0.0-preview.7.26381.103
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddOpenApi();

var app = builder.Build();
app.MapOpenApi();
app.UseSwaggerUI(o => o.SwaggerEndpoint("/openapi/v1.json", "v1"));

app.MapGet("/todos/{id:int}", (int id) => new Todo(id, "write post", Status.Open, null));
app.MapPost("/todos", (Todo todo) => Results.Created($"/todos/{todo.Id}", todo));
app.Run();

internal enum Status { Open, Done }
internal record Todo(int Id, string Title, Status Status, DateTimeOffset? DueAt);
```

Carregue `/swagger` e você recebe a caixa cinza. Nada no console, nada nos logs, HTTP 200 tanto na página quanto no documento.

Note que `Swashbuckle.AspNetCore.SwaggerUI` é um pacote independente. Você não precisa do gerador do Swashbuckle para cair nisso: o documento aqui vem do gerador integrado, e apenas os recursos da interface vêm do Swashbuckle. Se você seguiu um guia sobre [expor OpenAPI sem o Swashbuckle](/pt-br/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/) mas manteve a página familiar `/swagger`, esta é exatamente a configuração que você está executando.

## Qual versão do Swagger UI renderiza pela primeira vez um documento 3.2.0

Fiz uma bisseção do pacote contra o mesmo documento 3.2.0. O limite é `Swashbuckle.AspNetCore.SwaggerUI` 10.1.5:

| Pacote SwaggerUI | swagger-ui embutido | Renderiza `openapi: 3.2.0` |
| --- | --- | --- |
| 9.0.6 | 5.29.1 | Não |
| 10.0.0 | 5.30.2 | Não |
| 10.1.0 | 5.31.0 | Não |
| 10.1.4 | 5.31.1 | Não |
| 10.1.5 | 5.32.0 | Sim |
| 10.1.7 | 5.32.1 | Sim |
| 10.2.3 | 5.32.7 | Sim |

A partir de 10.1.5 o selo do cabeçalho mostra `OAS 3.2` e todas as operações e esquemas renderizam normalmente. Então a primeira correção é subir uma linha de pacote:

```xml
<!-- first version whose bundled swagger-ui accepts 3.2.0 -->
<PackageReference Include="Swashbuckle.AspNetCore.SwaggerUI" Version="10.1.5" />
```

Prefira esta. Ela mantém seu documento na especificação mais recente e não custa nada, porque `Swashbuckle.AspNetCore.SwaggerUI` só distribui recursos estáticos e uma extensão de middleware. Se você referencia o metapacote completo `Swashbuckle.AspNetCore`, subi-lo para 10.2.x traz os mesmos recursos de interface, mas arrasta o gerador junto; leia as notas sobre [fixar a string de versão do OpenAPI que o Swashbuckle emite](/pt-br/2026/08/fix-cannot-target-openapi-3-0-after-upgrading-swashbuckle-aspnetcore/) antes de cruzar esse limite.

## Como fixar o documento de volta em OpenAPI 3.1

Se você não pode mover o pacote da interface, ou se algo mais a jusante também rejeita 3.2, defina a versão explicitamente no gerador:

```csharp
// .NET 11, C# 14. Microsoft.OpenApi 3.9.0 supplies OpenApiSpecVersion.
using Microsoft.OpenApi;

builder.Services.AddOpenApi(options =>
{
    options.OpenApiVersion = OpenApiSpecVersion.OpenApi3_1;
});
```

O `using Microsoft.OpenApi;` importa: `OpenApiSpecVersion` vive no namespace raiz plano, não em `Microsoft.OpenApi.Models`, que foi removido já na linha 2.x que veio com o .NET 10.

Com essa opção definida, o .NET 11 escreve `"openapi": "3.1.2"`, e `Swashbuckle.AspNetCore.SwaggerUI` 9.0.6 o renderiza com um selo `OAS 3.1`. Repare no componente de patch: o .NET 10 escrevia `3.1.1`, e o .NET 11, com o mesmo valor de enumeração, escreve `3.1.2`. Consumidores que comparam a string de versão completa em vez do maior e do menor ainda vão tropeçar. `OpenApiSpecVersion.OpenApi3_0` também continua aceito e produz `3.0.4`.

Você pode registrar mais de um documento nomeado se consumidores diferentes precisarem de versões diferentes:

```csharp
// .NET 11, C# 14
builder.Services.AddOpenApi("v1");                                   // 3.2.0
builder.Services.AddOpenApi("v1-31", o =>
    o.OpenApiVersion = OpenApiSpecVersion.OpenApi3_1);               // 3.1.2
```

Isso te dá `/openapi/v1.json` e `/openapi/v1-31.json` a partir dos mesmos metadados de endpoint, de modo que um gerador de clientes legado pode continuar consumindo 3.1 enquanto a interface e os clientes mais novos leem 3.2.

## O que há realmente dentro do documento 3.2.0

Esta é a parte que vale internalizar antes de gastar uma tarde auditando transformadores: para uma minimal API normal, o documento 3.2.0 e o documento 3.1.2 são idênticos, exceto pela string de versão.

Gerei as três versões a partir de uma mesma aplicação (um record com um int, uma string, um enum, um `DateTimeOffset` anulável, mais um upload com `IFormFile`) e as comparei. A diferença entre 3.1 e 3.2 foram duas linhas, ambas o campo `openapi` e o título do documento. Nenhum esquema, parâmetro, resposta ou componente mudou.

A diferença entre 3.0 e 3.1, por outro lado, é real, porque é ali que a alinhamento com JSON Schema aterrissou:

```json
// OpenAPI 3.0.4
"dueAt": { "type": "string", "format": "date-time", "nullable": true }
```

```json
// OpenAPI 3.1.2 and 3.2.0
"dueAt": { "type": ["null", "string"], "format": "date-time" }
```

Então, se um gerador de clientes quebrar depois que você atualizar para o .NET 11 e você "consertar" caindo para `OpenApi3_0`, você mudou a codificação de nulabilidade de todas as propriedades opcionais do seu contrato. Caia para `OpenApi3_1`: essa é a versão cujo payload é byte a byte o que você já vinha publicando no .NET 10.

## O Scalar tem o mesmo problema

Se você serve sua referência com [Scalar em vez do Swagger UI](/pt-br/2026/08/how-to-serve-openapi-docs-with-scalar-instead-of-swagger-ui-in-aspnetcore-11/), este erro não chega até você. Rodei a mesma aplicação .NET 11 contra `Scalar.AspNetCore` 2.16.20 e 2.14.14, e ambas renderizaram o documento 3.2.0, imprimindo `OpenAPI 3.2.0` no cabeçalho.

Isso vale mesmo com o grafo do NuGet parecendo alarmante. `Scalar.AspNetCore.Microsoft` 2.16.20 não tem nenhum grupo de destino `net11.0`, então um projeto `net11.0` resolve os recursos `net10.0`, que foram compilados contra `Microsoft.OpenApi` 2.7.5 e depois são carregados contra o assembly unificado 3.9.0 em tempo de execução. Esse é exatamente o risco de compatibilidade binária sobre o qual a nota de mudança disruptiva do Microsoft.OpenApi 3.x alerta, e aqui ele é inofensivo: `AddScalarTransformers()` e `ExcludeFromApiReference()` funcionaram, emitindo a extensão `x-scalar-ignore` esperada.

O mesmo vale para transformadores escritos à mão. Um transformador de documento que registra um esquema de segurança bearer e um transformador de esquema que carimba `x-schema-id`, ambos escritos para o .NET 10 contra `Microsoft.OpenApi` 2.x, compilaram e rodaram sem alteração no .NET 11 com 3.9.0. Se seus transformadores apenas leem, ou só definem extensões e esquemas de segurança, orce zero para a migração de 2.x para 3.x. Se eles percorrem esquemas aninhados, constroem referências ou usavam a infraestrutura de parsing `ParseNode` já removida, leia primeiro a [referência do pipeline de transformadores](/pt-br/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/) e as notas de migração do OpenAPI.NET.

## Quais falhas parecidas não são este bug

**Uma página em branco sem caixa cinza nenhuma.** Essa é outra falha: a interface nunca recebeu um documento. Verifique a rota. `MapOpenApi` serve `/openapi/{documentName}.json`, e se você mudou o padrão precisa avisar a interface, seja com `SwaggerEndpoint` ou com `WithOpenApiRoutePattern` do Scalar. Faça curl na URL do JSON que a página está realmente pedindo antes de culpar as versões.

**HTTP 500 na URL do documento.** Então um transformador lançou exceção e não havia nada para renderizar. O caso mais comum não é regressão do .NET 11: `OpenApiSchema.Extensions` é `null` até você atribuir algo, tanto em `Microsoft.OpenApi` 2.x quanto em 3.x, então `schema.Extensions["x-foo"] = ...` lança uma `NullReferenceException` igualmente no .NET 10 e no .NET 11. Proteja isso:

```csharp
// .NET 11, C# 14, Microsoft.OpenApi 3.9.0
options.AddSchemaTransformer((schema, context, ct) =>
{
    schema.Extensions ??= new Dictionary<string, IOpenApiExtension>();
    schema.Extensions["x-schema-id"] =
        new JsonNodeExtension(JsonValue.Create(context.JsonTypeInfo.Type.Name));
    return Task.CompletedTask;
});
```

**`error CS0200: Property or indexer 'IOpenApiMediaType.Example' cannot be assigned to -- it is read only`.** Esse é um efeito colateral genuíno do .NET 11, e aparece em soluções mistas. Se um projeto `net10.0` acabar resolvendo `Microsoft.OpenApi` 3.9.0, via gerenciamento centralizado de pacotes, uma versão flutuante ou uma referência compartilhada de uma aplicação `net11.0`, o gerador de código-fonte de comentários XML do OpenAPI do SDK do .NET 10 falha ao compilar contra o modelo de objetos 3.x. Mantenha os projetos `net10.0` em `Microsoft.OpenApi` 2.x em vez de flutuar a solução inteira para uma única versão.

**`System.MissingMethodException: Method not found: '... Microsoft.OpenApi.OpenApiOperation.get_Extensions()'`.** Esse é o modo de falha de compatibilidade binária, e significa que alguma biblioteca no seu grafo foi compilada contra uma superfície de `Microsoft.OpenApi` que não existe mais em tempo de execução. A atualização para o .NET 11 não o causa sozinha; procure um pacote fixado bem atrás do resto, ou uma referência explícita a `Microsoft.OpenApi` no seu próprio csproj brigando com a transitiva.

## Relacionado

- [Como expor OpenAPI sem o Swashbuckle no ASP.NET Core 11](/pt-br/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/)
- [Correção: não é possível mirar OpenAPI 3.0 após atualizar o Swashbuckle.AspNetCore para v9](/pt-br/2026/08/fix-cannot-target-openapi-3-0-after-upgrading-swashbuckle-aspnetcore/)
- [Como personalizar o documento OpenAPI com AddOperationTransformer e AddSchemaTransformer](/pt-br/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/)
- [Como servir documentação OpenAPI com Scalar em vez do Swagger UI](/pt-br/2026/08/how-to-serve-openapi-docs-with-scalar-instead-of-swagger-ui-in-aspnetcore-11/)
- [Migrar do Swashbuckle para o gerador OpenAPI integrado no .NET 11](/pt-br/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/)

## Fontes

- [Mudança disruptiva: OpenApiVersion passa a ter OpenApi3_2 como padrão](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/11/openapi-version-default-3-2?view=aspnetcore-10.0), Microsoft Learn
- [Mudança disruptiva: Microsoft.OpenApi atualizado para 3.x](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/11/microsoft-openapi-3x?view=aspnetcore-10.0), Microsoft Learn
- [Gerar documentos OpenAPI](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/aspnetcore-openapi?view=aspnetcore-10.0), Microsoft Learn
- [Notas de versão do OpenAPI.NET](https://github.com/microsoft/OpenAPI.NET/releases), microsoft/OpenAPI.NET no GitHub
- [Scalar.AspNetCore.Microsoft falha com transformadores](https://github.com/scalar/scalar/issues/6020), issue 6020 de scalar/scalar
