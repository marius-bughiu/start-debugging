---
title: "Correção: The type or namespace name 'OpenApiReference' could not be found"
description: "OpenApiReference foi removido no Microsoft.OpenApi 2.0. Trocar o using para Microsoft.OpenApi não basta: substitua cada uso por uma referência tipada como OpenApiSchemaReference."
pubDate: 2026-08-11
template: error-page
tags:
  - "errors"
  - "aspnetcore"
  - "dotnet"
  - "dotnet-10"
  - "dotnet-11"
  - "openapi"
lang: "pt-br"
translationOf: "2026/08/fix-the-type-or-namespace-name-openapireference-could-not-be-found"
translatedBy: "claude"
translationDate: 2026-08-11
---

`OpenApiReference` não existe mais. O Microsoft.OpenApi 2.0 consolidou todos os namespaces do modelo dentro de `Microsoft.OpenApi` e também removeu o tipo de referência genérico, então trocar `using Microsoft.OpenApi.Models;` por `using Microsoft.OpenApi;` resolve o erro de namespace e deixa este outro de pé. A correção é substituir cada `new OpenApiReference { Type = ..., Id = "X" }` pela classe de referência tipada do componente para o qual você apontava, por exemplo `new OpenApiSchemaReference("X", document)` ou `new OpenApiSecuritySchemeReference("Bearer", document)`. Tudo abaixo foi verificado com o SDK 10.0.201, `Microsoft.AspNetCore.OpenApi` 10.0.10 e `Microsoft.OpenApi` 2.11.0.

## O erro em contexto

Existem dois erros nessa família, e quem pesquisa chega aqui com qualquer um dos dois. Se você ainda tem as diretivas `using` antigas, o compilador reclama do namespace, não do tipo:

```
error CS0234: The type or namespace name 'Models' does not exist in the namespace 'Microsoft.OpenApi' (are you missing an assembly reference?)
error CS0234: The type or namespace name 'Any' does not exist in the namespace 'Microsoft.OpenApi' (are you missing an assembly reference?)
```

Apague esses using, ou troque por `using Microsoft.OpenApi;`, e você chega ao erro que realmente te trouxe até aqui:

```
error CS0246: The type or namespace name 'OpenApiReference' could not be found (are you missing a using directive or an assembly reference?)
error CS0246: The type or namespace name 'OpenApiString' could not be found (are you missing a using directive or an assembly reference?)
error CS0117: 'OpenApiSecurityScheme' does not contain a definition for 'Reference'
error CS0029: Cannot implicitly convert type 'string' to 'Microsoft.OpenApi.JsonSchemaType?'
error CS1061: 'OpenApiDocument' does not contain a definition for 'SerializeAsJson'
```

Esse segundo bloco é a pista. `CS0234` significa "o namespace mudou de lugar". `CS0246` sobre `OpenApiReference` significa especificamente "o tipo sumiu", e nenhuma diretiva using vai trazê-lo de volta.

## Por que isso acontece

O `Microsoft.AspNetCore.OpenApi` passou a depender rigidamente do Microsoft.OpenApi 2.x a partir da versão 10.0, e o .NET 11 mantém essa decisão. Adicione o pacote a um projeto web `net10.0` limpo e você vê a dependência transitiva:

```
> Microsoft.AspNetCore.OpenApi      10.0.10     10.0.10
   > Microsoft.OpenApi              2.0.0
```

O Microsoft.OpenApi 2.0 trouxe três mudanças que caem na mesma linha do seu código:

- **Os namespaces foram consolidados.** `Microsoft.OpenApi.Models`, `Microsoft.OpenApi.Any`, `Microsoft.OpenApi.Interfaces` e `Microsoft.OpenApi.Writers` foram fundidos em `Microsoft.OpenApi`. O assembly público expõe agora exatamente três namespaces: `Microsoft.OpenApi`, `Microsoft.OpenApi.Reader` e `Microsoft.OpenApi.MicrosoftExtensions`.
- **`OpenApiReference` foi removido**, junto com a propriedade `Reference` de todos os modelos referenciáveis. O `OpenApiSecurityScheme` não tem mais nenhum membro `Reference`, e é isso que gera o `CS0117` acima.
- **As referências viraram tipos de primeira classe.** Em vez de anexar uma referência a um modelo vazio, você constrói um objeto de referência dedicado que implementa a mesma interface daquilo para onde ele aponta.

Se você usa Swashbuckle em vez do gerador integrado, o mesmo penhasco existe um pacote adiante. O Swashbuckle.AspNetCore 9.0.6 resolve `Microsoft.OpenApi` 1.6.25 e seu código antigo continua compilando; o Swashbuckle.AspNetCore 10.1.0 resolve `Microsoft.OpenApi` 2.3.0 e para de compilar. O que quebra você é atualizar o Swashbuckle, não atualizar o SDK.

## Reprodução mínima

Este é o formato que quase todo mundo tem, normalmente dentro de uma chamada `AddSecurityRequirement` do Swagger copiada de algum tutorial de JWT:

```csharp
// FAILS on .NET 10/11 with Microsoft.OpenApi 2.x
using Microsoft.OpenApi.Models;
using Microsoft.OpenApi.Any;

var reference = new OpenApiReference
{
    Type = ReferenceType.SecurityScheme,
    Id = "Bearer"
};

var scheme = new OpenApiSecurityScheme
{
    Reference = reference
};

var schema = new OpenApiSchema
{
    Type = "string",
    Default = new OpenApiString("hello")
};

var json = new OpenApiDocument().SerializeAsJson(OpenApiSpecVersion.OpenApi3_0);
```

Seis linhas, cinco mudanças incompatíveis distintas. Corrigir uma de cada vez, seguindo os erros do compilador, é lento, então ajuda conhecer o mapeamento inteiro de antemão.

## A correção, passo a passo

### 1. Troque as diretivas using

Todos os using de modelos `Microsoft.OpenApi.*` colapsam em um só:

```csharp
// .NET 11, Microsoft.OpenApi 2.11.0
using Microsoft.OpenApi;
using System.Text.Json.Nodes;   // needed wherever you used IOpenApiAny
```

Um localizar e substituir de `using Microsoft.OpenApi.Models;` por `using Microsoft.OpenApi;` no projeto inteiro é seguro. Basta apagar `using Microsoft.OpenApi.Any;` e `using Microsoft.OpenApi.Interfaces;`.

### 2. Substitua OpenApiReference pela referência tipada

Esta é a parte que nenhum `using` resolve. O Microsoft.OpenApi 2.x traz uma classe de referência por componente referenciável, todas com a mesma assinatura de construtor `(string referenceId, OpenApiDocument hostDocument = null, string externalResource = null)`:

| `ReferenceType` antigo | Tipo novo |
| --- | --- |
| `ReferenceType.Schema` | `OpenApiSchemaReference` |
| `ReferenceType.SecurityScheme` | `OpenApiSecuritySchemeReference` |
| `ReferenceType.Parameter` | `OpenApiParameterReference` |
| `ReferenceType.RequestBody` | `OpenApiRequestBodyReference` |
| `ReferenceType.Response` | `OpenApiResponseReference` |
| `ReferenceType.Header` | `OpenApiHeaderReference` |
| `ReferenceType.Example` | `OpenApiExampleReference` |
| `ReferenceType.Link` | `OpenApiLinkReference` |
| `ReferenceType.Callback` | `OpenApiCallbackReference` |
| `ReferenceType.Tag` | `OpenApiTagReference` |
| `ReferenceType.PathItem` | `OpenApiPathItemReference` |

Assim, a referência ao esquema de segurança vira uma única expressão:

```csharp
// .NET 11, Microsoft.OpenApi 2.11.0
// old: new OpenApiSecurityScheme { Reference = new OpenApiReference { Type = ReferenceType.SecurityScheme, Id = "Bearer" } }
var schemeRef = new OpenApiSecuritySchemeReference("Bearer", document);
```

Esses tipos de referência implementam a interface do seu destino (`OpenApiSchemaReference` é um `IOpenApiSchema`, `OpenApiSecuritySchemeReference` é um `IOpenApiSecurityScheme`), então eles entram direto nas coleções que antes recebiam o próprio modelo.

### 3. Corrija o dano colateral nas mesmas linhas

Mais três renomeações costumam aparecer no mesmo bloco:

- `OpenApiSchema.Type` saiu de `string` para o enum de flags `JsonSchemaType`, cujos membros são `Null`, `Boolean`, `Integer`, `Number`, `String`, `Object` e `Array`. Como é um enum `[Flags]`, você expressa a nulidade do OpenAPI 3.1 como `JsonSchemaType.String | JsonSchemaType.Null` em vez de uma propriedade `Nullable` separada.
- Toda a hierarquia `IOpenApiAny` (`OpenApiString`, `OpenApiInteger`, `OpenApiArray`, `OpenApiObject` e o resto) foi removida em favor de `JsonNode`, de `System.Text.Json.Nodes`.
- `SerializeAsJson` e `SerializeAsYaml` agora são métodos de extensão assíncronos: `SerializeAsJsonAsync` e `SerializeAsYamlAsync`. `Maximum`, `Minimum`, `ExclusiveMaximum` e `ExclusiveMinimum` mudaram de `double?` para `string?` para que números de precisão arbitrária sobrevivam ao ida e volta.

### 4. A versão completa que funciona

Aqui está a reprodução acima, reescrita como o transformador de documento que você de fato registraria em uma app .NET 11. Ela compila limpa com `Microsoft.AspNetCore.OpenApi` 10.0.10:

```csharp
// .NET 11, Microsoft.AspNetCore.OpenApi 10.0.10, Microsoft.OpenApi 2.11.0
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

public sealed class BearerSecuritySchemeTransformer : IOpenApiDocumentTransformer
{
    public Task TransformAsync(
        OpenApiDocument document,
        OpenApiDocumentTransformerContext context,
        CancellationToken cancellationToken)
    {
        document.Components ??= new OpenApiComponents();
        document.Components.SecuritySchemes ??= new Dictionary<string, IOpenApiSecurityScheme>();

        document.Components.SecuritySchemes["Bearer"] = new OpenApiSecurityScheme
        {
            Type = SecuritySchemeType.Http,
            Scheme = "bearer",
            BearerFormat = "JWT",
            In = ParameterLocation.Header
        };

        document.Security ??= new List<OpenApiSecurityRequirement>();
        document.Security.Add(new OpenApiSecurityRequirement
        {
            [new OpenApiSecuritySchemeReference("Bearer", document)] = new List<string>()
        });

        return Task.CompletedTask;
    }
}
```

E os equivalentes do lado dos esquemas:

```csharp
// .NET 11, Microsoft.OpenApi 2.11.0
var schema = new OpenApiSchema
{
    Type = JsonSchemaType.String | JsonSchemaType.Null,   // was Type = "string" + Nullable = true
    Default = (JsonNode)"hello",                          // was new OpenApiString("hello")
    Enum = new List<JsonNode> { (JsonNode)"a", (JsonNode)"b" },
    Maximum = "100"                                       // was double? Maximum = 100
};

IOpenApiSchema widgetRef = new OpenApiSchemaReference("Widget", document);

string json = await document.SerializeAsJsonAsync(OpenApiSpecVersion.OpenApi3_1);
```

Serializar um documento montado assim produz exatamente o que você espera, com o requisito de segurança expresso por nome de esquema e o componente intacto:

```json
{
  "openapi": "3.1.1",
  "components": {
    "securitySchemes": {
      "Bearer": { "type": "http", "scheme": "bearer", "bearerFormat": "JWT" }
    }
  },
  "security": [ { "Bearer": [ ] } ]
}
```

## Detalhes que mordem depois que o código já compila

**Não "conserte" isso atualizando o Microsoft.OpenApi para 3.x.** É tentador, porque a 3.9.0 é a versão atual no NuGet enquanto o ASP.NET Core 10 fixa a 2.0.0. Adicione um `PackageReference` explícito para 3.9.0 em um projeto que usa o gerador integrado e a compilação falha dentro do próprio código gerado pela Microsoft:

```
obj\Debug\net10.0\Microsoft.AspNetCore.OpenApi.SourceGenerators\...\OpenApiXmlCommentSupport.generated.cs(399,41):
error CS0200: Property or indexer 'IOpenApiMediaType.Example' cannot be assigned to -- it is read only
```

O gerador de código-fonte de comentários XML que acompanha o `Microsoft.AspNetCore.OpenApi` 10.0.10 foi escrito contra a superfície 2.x. Fique na linha 2.x até o pacote do ASP.NET Core se mover.

**Mas fixe o Microsoft.OpenApi em 2.7.5 ou posterior.** A 2.0.0 que o ASP.NET Core 10.0.10 resolve transitivamente carrega um aviso de severidade alta, e o NuGet avisa no restore:

```
warning NU1903: Package 'Microsoft.OpenApi' 2.0.0 has a known high severity vulnerability
```

É a CVE-2026-49451, recursão não controlada em referências circulares de esquema, afetando de 2.0.0-preview.11 até 2.7.4 e de 3.0.0 até 3.5.3. Adicionar um `<PackageReference Include="Microsoft.OpenApi" Version="2.11.0" />` explícito elimina o aviso e continua compilando limpo com o gerador da 10.0.10. Isso importa principalmente se sua app analisa documentos OpenAPI que não foram escritos por você.

**Coleções não se inicializam mais sozinhas.** Na 1.x, `new OpenApiDocument().Components` devolvia um `OpenApiComponents` vazio. Na 2.x é null, assim como `Components.Schemas`, `Components.SecuritySchemes` e `Document.Tags`. `Paths` e `Servers` continuam inicializados. É por isso que o transformador acima usa `??=` em cada nível antes de indexar, e é a `NullReferenceException` mais comum logo depois de uma atualização que compilou com sucesso.

**Referências são resolvidas de forma preguiçosa pelo workspace do documento.** Se você monta um documento na mão em vez de deixar o ASP.NET Core montá-lo, o `Target` de uma referência continua null e suas propriedades delegadas voltam vazias até os componentes serem registrados:

```csharp
// .NET 11, Microsoft.OpenApi 2.11.0
var reference = new OpenApiSchemaReference("Widget", document);
// reference.Target is null here, reference.Description is empty

document.Workspace.RegisterComponents(document);
// reference.Target is now resolved, reference.Description reads through to the target
```

A resolução é preguiçosa, então uma referência criada antes da chamada a `RegisterComponents` passa a resolver corretamente depois. A serialização emite o `$ref` de qualquer jeito; o que surpreende são as leituras através do proxy.

**Preste atenção nos tipos de interface nas assinaturas dos transformadores.** `Components.Schemas` é um `IDictionary<string, IOpenApiSchema>` e `Components.SecuritySchemes` é um `IDictionary<string, IOpenApiSecurityScheme>`, não as classes concretas. Código que assumia o tipo concreto agora precisa de um cast ou de um pattern match, porque o valor pode ser um objeto de referência em vez de um esquema inline.

**`OpenApiSecuritySchemeReference` não é renderizado como `$ref`.** O `Reference.ReferenceV3` dele é apenas `Bearer`, enquanto o de `OpenApiSchemaReference("Widget")` é `#/components/schemas/Widget`. Isso está correto pela especificação OpenAPI: um requisito de segurança é identificado pelo nome do esquema. Não saia procurando um `$ref` faltando na saída.

## Relacionados

Se você está resolvendo uma atualização maior de OpenAPI, estes cobrem as peças vizinhas: a saída do Swashbuckle está detalhada em [migrar do Swashbuckle para o gerador de OpenAPI integrado](/pt-br/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/), e a reescrita de filtros para transformadores que costuma acompanhá-la está em [portar IOperationFilter e ISchemaFilter para transformadores de OpenAPI](/pt-br/2026/07/migrate-swashbuckle-ioperationfilter-and-ischemafilter-to-transformers-in-dotnet-11/). Para a API de transformadores em si, veja [personalizar o documento com AddOperationTransformer e AddSchemaTransformer](/pt-br/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/). Depois que o documento volta a compilar, você ainda precisa de algum lugar para exibi-lo, o que está em [servir documentação OpenAPI com Scalar](/pt-br/2026/08/how-to-serve-openapi-docs-with-scalar-instead-of-swagger-ui-in-aspnetcore-11/). E se esse erro apareceu como parte de um salto maior, o [checklist do .NET 8 para o .NET 11](/pt-br/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) lista os outros pacotes que se moveram na mesma época.

## Fontes

- [Guia de atualização do OpenAPI.NET 2.0](https://github.com/microsoft/OpenAPI.NET/blob/main/docs/upgrade-guide-2.md), a lista oficial de tipos removidos e propriedades renomeadas.
- [Issue 61123 do dotnet/aspnetcore](https://github.com/dotnet/aspnetcore/issues/61123), o relato do sumiço de `OpenApiSecurityScheme.Reference` no .NET 10 Preview 2.
- [Issue 3522 do Swashbuckle.AspNetCore](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/issues/3522), a mudança de namespaces como ela atingiu os usuários do Swashbuckle.
- [GHSA-v5pm-xwqc-g5wc](https://github.com/advisories/GHSA-v5pm-xwqc-g5wc) / CVE-2026-49451, o aviso por trás do warning `NU1903`.
