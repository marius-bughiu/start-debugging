---
title: "Como marcar a resposta de uma action de controller como anulável no documento OpenAPI embutido do ASP.NET Core"
description: "O Microsoft.AspNetCore.OpenApi só marca uma resposta como anulável quando a action retorna um T? simples (e, no .NET 10, nem mesmo Task<T?>). ActionResult<T?> e IActionResult perdem a anotação tanto no .NET 10 quanto no .NET 11 RC2. Veja por quê, um operation transformer testado que resolve o problema e a armadilha do 204 No Content que faz a especificação mentir, a menos que você também mude o formatter do MVC."
pubDate: 2026-10-20
template: how-to
tags:
  - "aspnetcore"
  - "openapi"
  - "dotnet-11"
  - "dotnet-10"
  - "nullable-reference-types"
  - "how-to"
lang: "pt-br"
translationOf: "2026/10/how-to-mark-a-controller-action-response-as-nullable-in-aspnetcore-openapi"
translatedBy: "claude"
translationDate: 2026-10-20
---

**Resposta curta:** no .NET 10 (`Microsoft.AspNetCore.OpenApi` 10.0.13) e no .NET 11 RC2 (11.0.0-rc.2.26504.105), o gerador embutido envolve o schema de uma resposta em `oneOf: [{ "type": "null" }, ...]` somente quando o próprio tipo de retorno da action é anulável: `Person?`, além de `Task<Person?>` no .NET 11. Ele nunca olha dentro de `ActionResult<Person?>`, e `IActionResult` com `[ProducesResponseType<Person>]` não tem nada para inspecionar, então ambos saem não anuláveis. Registre um operation transformer que leia o `MethodInfo` da action com `NullabilityInfoContext`, desembrulhe `Task<>` e `ActionResult<>` e envolva você mesmo o schema 2xx (código abaixo, testado nas duas versões). Depois, decida o que null realmente significa na rede, porque o MVC envia **204 No Content** para um resultado nulo por padrão, e não `200` com `null`.

Encontrei isso ao gerar um cliente com Kiota a partir de uma API com controllers: o método gerado para `GET /people/{id}` retornava um `Person` não anulável, mesmo com a action declarada como `ActionResult<Person?>`. Tudo abaixo foi medido em um app de testes no SDK 10.0.302 (runtime 10.0.10) e no SDK 11.0.100-rc.2.26504.105, extraindo `/openapi/v1.json` e chamando cada endpoint com curl.

## O que o gerador emite para cada formato de retorno

O controller de teste tem uma action por formato, todas retornando `null`, com `<Nullable>enable</Nullable>`:

```csharp
// .NET 10 / .NET 11 RC2, C# 14, <Nullable>enable</Nullable>
[ApiController]
[Route("people")]
public class PeopleController : ControllerBase
{
    [HttpGet("plain")]
    public Person? GetPlain() => null;

    [HttpGet("taskplain")]
    public async Task<Person?> GetTaskPlain() { await Task.Yield(); return null; }

    [HttpGet("actionresult")]
    public ActionResult<Person?> GetActionResult() => (Person?)null;

    [HttpGet("task")]
    public async Task<ActionResult<Person?>> GetTask() { await Task.Yield(); return (Person?)null; }

    [HttpGet("attr")]
    [ProducesResponseType<Person>(StatusCodes.Status200OK)]
    public IActionResult GetAttr() => Ok(null);

    [HttpGet("arint")]
    public ActionResult<int?> GetArInt() => (int?)null;
}
```

Este é o schema da resposta `200` que cada uma produziu:

| Tipo de retorno | .NET 10.0.13 | .NET 11 RC2 |
|---|---|---|
| `Person?` | anulável (`oneOf`) | anulável (`oneOf`) |
| `Task<Person?>` | **não anulável** | anulável |
| `ActionResult<Person?>` | **não anulável** | **não anulável** |
| `Task<ActionResult<Person?>>` | **não anulável** | **não anulável** |
| `IActionResult` + `[ProducesResponseType<Person>]` | **não anulável** | **não anulável** |
| `ActionResult<int?>` | `type: ["null", "integer", "string"]`, sem `oneOf` | anulável (`oneOf`) |
| Minimal API `Person? () => null` | anulável (`oneOf`) | anulável (`oneOf`) |

"Anulável" aqui significa que o schema saiu assim:

```json
"schema": {
  "oneOf": [
    { "type": "null" },
    { "$ref": "#/components/schemas/Person" }
  ]
}
```

e "não anulável" significa um `{ "$ref": "#/components/schemas/Person" }` simples. O componente `Person` em si nunca é marcado como anulável. Isso é proposital: desde o .NET 10 RC1 ([dotnet/aspnetcore#63301](https://github.com/dotnet/aspnetcore/pull/63301)) o gerador mantém um único componente por tipo e expressa a anulabilidade no ponto de uso, com um wrapper `oneOf` inline, para que um tipo anulável em um endpoint e não anulável em outro não se divida em dois componentes.

## Por que ActionResult<T?> perde a anotação

A decisão está em um único método interno, `TypeExtensions.ShouldApplyNullableResponseSchema`, em `src/OpenApi/src/Extensions/TypeExtensions.cs`. Na tag `v10.0.0`, ele faz o seguinte:

1. Obtém o `MethodInfo` da action a partir do `ControllerActionDescriptor`.
2. Desembrulha `Task<T>` ou `ValueTask<T>` de `MethodInfo.ReturnType`.
3. Se esse tipo não for *igual* a `ApiResponseType.Type` (o tipo que o ApiExplorer informa para a resposta), retorna `false`.
4. Caso contrário, executa `NullabilityInfoContext.Create(methodInfo.ReturnParameter)` e verifica se `WriteState == Nullable`.

É no passo 3 que `ActionResult<Person?>` fica de fora. O ApiExplorer informa o tipo da resposta como `Person`, o método retorna `ActionResult<Person>`, os dois tipos não são iguais, e acabou. Nunca chega à verificação de anulabilidade. O mesmo vale para `IActionResult` com um atributo: o tipo de retorno é `IActionResult`, o tipo da resposta é `Person`.

O passo 4 explica a falha de `Task<Person?>` no .NET 10. O tipo desembrulhado coincide, mas a verificação de anulabilidade roda no parâmetro de retorno *original*, que é `Task<Person?>`. O próprio `Task` não é anulável, então `WriteState` é `NotNull`.

O [dotnet/aspnetcore#67661](https://github.com/dotnet/aspnetcore/pull/67661), mesclado em julho de 2026 e incluído no .NET 11, reescreveu o método. Agora ele faz um curto-circuito em `ModelMetadata.IsNullableValueType` (o que corrige `ActionResult<int?>`) e, para tipos de referência, percorre `NullabilityInfo.GenericTypeArguments[0]` através de `Task<>`/`ValueTask<>` (o que corrige `Task<Person?>`). Ele não desembrulha `ActionResult<>`, então, para um tipo de referência, o `NullabilityInfo` para em `ActionResult<Person?>`, que não é nulo, e o resultado continua sendo `false`. A descrição do PR diz isso mesmo: o tratamento de tipos de referência "is still not handled very well in this PR". A tag RC2 e a `main` têm o mesmo código do RC1, então não espere mudança antes do GA.

## Correção: um operation transformer que desembrulha ActionResult<T>

O pipeline embutido entrega o `ApiDescription` completo a um operation transformer, o que basta para refazer a verificação corretamente. Este transformer trata dois casos: a anulabilidade que ele consegue inferir do tipo de retorno e um atributo explícito `[NullableResponse(statusCode)]` para actions `IActionResult`, em que não há nada para inferir.

```csharp
// .NET 10 and .NET 11 (Microsoft.AspNetCore.OpenApi 10.0.x / 11.0.0-rc.2)
using System.Reflection;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

[AttributeUsage(AttributeTargets.Method, AllowMultiple = true)]
public sealed class NullableResponseAttribute(int statusCode) : Attribute
{
    public int StatusCode { get; } = statusCode;
}

public sealed class NullableResponseTransformer : IOpenApiOperationTransformer
{
    public Task TransformAsync(
        OpenApiOperation operation,
        OpenApiOperationTransformerContext context,
        CancellationToken cancellationToken)
    {
        if (context.Description.ActionDescriptor is not ControllerActionDescriptor action
            || operation.Responses is null)
        {
            return Task.CompletedTask;
        }

        // 1. Explicit opt-in: [NullableResponse(200)]
        var statusCodes = action.MethodInfo
            .GetCustomAttributes<NullableResponseAttribute>()
            .Select(a => a.StatusCode)
            .ToHashSet();

        // 2. Inferred from the return type: T?, ActionResult<T?>, and their Task/ValueTask forms
        if (TryGetNullableResponseType(action.MethodInfo, out var valueType))
        {
            foreach (var responseType in context.Description.SupportedResponseTypes)
            {
                if (responseType.Type == valueType && responseType.StatusCode is >= 200 and < 300)
                {
                    statusCodes.Add(responseType.StatusCode);
                }
            }
        }

        foreach (var statusCode in statusCodes)
        {
            if (!operation.Responses.TryGetValue(statusCode.ToString(), out var response)
                || response.Content is null)
            {
                continue;
            }

            foreach (var mediaType in response.Content.Values)
            {
                // Microsoft.OpenApi 3.x (.NET 11) exposes IOpenApiMediaType with a read-only Schema.
                if (mediaType is OpenApiMediaType { Schema: { } schema } concrete && !IsNullWrapper(schema))
                {
                    concrete.Schema = new OpenApiSchema
                    {
                        OneOf = [new OpenApiSchema { Type = JsonSchemaType.Null }, schema]
                    };
                }
            }
        }

        return Task.CompletedTask;
    }

    private static bool TryGetNullableResponseType(MethodInfo method, out Type? valueType)
    {
        var type = method.ReturnType;
        var nullability = new NullabilityInfoContext().Create(method.ReturnParameter);

        if (type.IsGenericType
            && (type.GetGenericTypeDefinition() == typeof(Task<>)
                || type.GetGenericTypeDefinition() == typeof(ValueTask<>)))
        {
            type = type.GetGenericArguments()[0];
            nullability = nullability.GenericTypeArguments[0];
        }

        if (type.IsGenericType && type.GetGenericTypeDefinition() == typeof(ActionResult<>))
        {
            type = type.GetGenericArguments()[0];
            nullability = nullability.GenericTypeArguments[0];
        }

        valueType = type;
        return nullability.WriteState == NullabilityState.Nullable;
    }

    private static bool IsNullWrapper(IOpenApiSchema schema) =>
        schema.OneOf?.Any(s => s.Type == JsonSchemaType.Null) == true;
}
```

Registre-o em todo documento que você expõe:

```csharp
// .NET 10 / .NET 11 RC2
builder.Services.AddControllers();
builder.Services.AddOpenApi(o => o.AddOperationTransformer<NullableResponseTransformer>());
```

E use o atributo onde o tipo de retorno não diz nada:

```csharp
// .NET 10 / .NET 11 RC2
[HttpGet("attr")]
[ProducesResponseType<Person>(StatusCodes.Status200OK)]
[NullableResponse(StatusCodes.Status200OK)]
public IActionResult GetAttr() => Ok(null);
```

Com o transformer registrado, todas as linhas da tabela acima saíram com o wrapper `oneOf` nas duas versões, inclusive `Task<Person?>` no .NET 10. Um `ActionResult<Person>` não anulável continuou sendo um `$ref` simples.

Algumas decisões de projeto que vale destacar:

- **Ele envolve o ponto de uso, não o componente.** Isso é o que o próprio framework faz desde o #63301. Se, em vez disso, você definir `Type |= JsonSchemaType.Null` no componente `Person` em um schema transformer, todo endpoint que retorna `Person` passa a ser anulável, inclusive os que nunca retornam null.
- **Ele só toca em respostas 2xx cujo tipo coincide com o `T` declarado.** Um `404` com `ProblemDetails` na mesma action é deixado em paz.
- **Ele é idempotente.** Se o framework já tiver envolvido o schema (um `Person?` simples, ou `Task<Person?>` no .NET 11), `IsNullWrapper` o ignora, então você não ganha um `oneOf` dentro de outro `oneOf`. Quando o framework passar a tratar `ActionResult<T?>`, o transformer vira silenciosamente um no-op.
- **O padrão `is OpenApiMediaType` existe por causa do .NET 11.** O `Microsoft.AspNetCore.OpenApi` 10.0.13 traz o `Microsoft.OpenApi` 2.x, em que os valores de `Content` são o `OpenApiMediaType` concreto. O pacote 11.0 RC2 traz o `Microsoft.OpenApi` 3.10.2, em que `Content` é `IDictionary<string, IOpenApiMediaType>` e `IOpenApiMediaType.Schema` não tem setter. Atribuir pela interface falha com `CS0200: Property or indexer 'IOpenApiMediaType.Schema' cannot be assigned to -- it is read only`. O pattern matching compila nas duas versões.

Para a mecânica geral dos transformers (ordem, ativação via DI, o objeto de contexto), veja [o aprofundamento sobre transformers](/pt-br/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/).

## A armadilha: um resultado nulo de controller é 204, não 200

Veja o que os mesmos endpoints realmente retornaram na rede, de forma idêntica no .NET 10 e no .NET 11 RC2:

```text
GET /people/actionresult   -> HTTP/1.1 204 No Content   (no body)
GET /people/plain          -> HTTP/1.1 204 No Content
GET /people/taskplain      -> HTTP/1.1 204 No Content
GET /minimal/maybe         -> HTTP/1.1 200 OK, application/json, body: null
```

O MVC registra o `HttpNoContentOutputFormatter` por padrão, e a propriedade `TreatNullValueAsNoContent` dele vem como `true`: qualquer resultado de objeto `null` vira um `204` com corpo vazio. As Minimal APIs não têm esse formatter, então elas realmente enviam `200` com o literal JSON `null`.

Isso significa que, para controllers, o wrapper `oneOf` do próprio framework em um `Person?` simples já descreve uma resposta que o servidor nunca envia: um cliente gerado a partir dessa especificação espera `200` com `null` e recebe `204`. Então escolha um entre dois contratos honestos.

### Opção A: manter o 204 e documentá-lo

Deixe o MVC como está, mantenha o schema do `200` não anulável e declare o `204`:

```csharp
// .NET 10 / .NET 11 RC2: null result -> 204 No Content
[HttpGet("{id:int}")]
[ProducesResponseType(StatusCodes.Status200OK)]
[ProducesResponseType(StatusCodes.Status204NoContent)]
public async Task<ActionResult<Person?>> Get(int id) => await _people.FindAsync(id);
```

Nesta configuração você não quer o wrapper anulável no `200`, então não registre o transformer, e tenha em mente que um retorno `Person?` simples ainda recebe o wrapper do framework. A maioria dos geradores de cliente trata um `204` sem corpo como "sem resultado", que normalmente é o que quem chama quer de qualquer forma.

### Opção B: enviar 200 com null e marcar o 200 como anulável

Desative a conversão para no-content e deixe o transformer descrever o resultado:

```csharp
// .NET 10 / .NET 11 RC2: null result -> 200 OK with body "null"
using Microsoft.AspNetCore.Mvc.Formatters;

builder.Services.AddControllers(o =>
{
    var noContent = o.OutputFormatters.OfType<HttpNoContentOutputFormatter>().Single();
    noContent.TreatNullValueAsNoContent = false;
});
builder.Services.AddOpenApi(o => o.AddOperationTransformer<NullableResponseTransformer>());
```

Depois dessa mudança, `GET /people/actionresult` retornou `HTTP/1.1 200 OK`, `Content-Type: application/json; charset=utf-8`, corpo `null`, que é exatamente o que o schema `oneOf` diz. Uma action `void` não foi afetada (ela retornava `200` com corpo vazio antes e depois da mudança). A página de formatação do Microsoft Learn mostra a outra forma de fazer isso, `o.OutputFormatters.RemoveType<HttpNoContentOutputFormatter>()`; prefiro alternar a propriedade porque ela declara a intenção e deixa os outros casos do formatter intactos.

Use a Opção B quando a API for consumida por algo que já espera `200`/`null`, ou quando você estiver migrando endpoints entre controllers e minimal APIs e quiser que se comportem da mesma forma. Use a Opção A para todo o resto; é o padrão do framework e não precisa de transformer.

## Armadilhas e casos extremos

**Adicionar qualquer `[ProducesResponseType]` descarta o 200 inferido.** No meu primeiro teste, coloquei apenas `[ProducesResponseType(StatusCodes.Status404NotFound)]` na action `ActionResult<Person?>`, e a resposta `200` desapareceu do documento por completo, então o transformer não tinha nada para envolver. Quando uma action tem metadados de resposta explícitos, o ApiExplorer deixa de adicionar o `200` padrão para `ActionResult<T>`. Adicione `[ProducesResponseType(StatusCodes.Status200OK)]` (não precisa de tipo, o `T` é preenchido) ao lado dos seus códigos de erro.

**`string?` não é JSON.** Uma action `string?` que retornava null voltou como `200` com `Content-Type: text/plain` e corpo vazio depois que `TreatNullValueAsNoContent` foi desativado, porque o `StringOutputFormatter` tem prioridade para strings. O documento continua anunciando `application/json` com uma string anulável. Se você retorna strings de controllers, adicione `[Produces("application/json")]` ou retorne um DTO pequeno.

**A saída em OpenAPI 3.0 parece diferente, mas significa a mesma coisa.** Com `o.OpenApiVersion = OpenApiSpecVersion.OpenApi3_0`, o `Microsoft.OpenApi` serializa o ramo nulo como `{ "enum": [null], "nullable": true }` dentro do `oneOf`. Isso é válido no 3.0 e os geradores entendem. O padrão é `3.1.1` no .NET 10 e `3.2.0` no .NET 11; se o Swagger UI recusar o documento 3.2, veja [a correção do Swagger UI para o .NET 11](/pt-br/2026/08/fix-swagger-ui-unable-to-render-this-definition-after-upgrading-to-dotnet-11/).

**O contexto de anulabilidade importa.** O `NullabilityInfoContext` lê os metadados `[Nullable]` do compilador. Em um arquivo ou projeto com tipos de referência anuláveis desativados, `Person?` é um aviso e `Person` é reportado como `Unknown`, não `Nullable`, então nem o framework nem o transformer marcam nada. Esse é o resultado correto: código oblivious não promete nada nem para um lado nem para o outro.

**Typed results são outro caminho de código.** Minimal APIs e controllers que retornam `Results<Ok<Person>, NotFound>` descrevem as respostas por meio de `IEndpointMetadataProvider`, e não pelo tipo de retorno do método. Verifiquei tanto uma minimal API retornando `Results<Ok<Person?>, NotFound>` quanto uma action de controller retornando `Ok<Person?>`: no .NET 10 e no .NET 11 RC2, o schema do `200` era uma referência simples a `Person`. O transformer acima também não infere nada a partir de `Ok<T>`, então coloque `[NullableResponse(200)]` nessas actions de controller (para minimal APIs, use `AddOperationTransformer` com uma verificação na rota, já que não há `ControllerActionDescriptor`). Se você está escolhendo entre os formatos, [typed results vs IResult vs IActionResult](/pt-br/2026/07/typed-results-vs-iresult-vs-iactionresult-in-aspnetcore-11/) explica o que cada um informa ao ApiExplorer.

**Não "corrija" isso em um schema transformer.** É tentador tornar `Person` anulável globalmente para que todo `$ref` aceite null. Você perde a distinção entre endpoints e, com o OpenAPI 3.1+, o wrapper `oneOf` que o framework adiciona em outros lugares passa a ter dois ramos que ambos aceitam `null`, o que faz o `oneOf` falhar na validação (ele exige exatamente uma correspondência). O PR #67661 aponta exatamente esse motivo para manter o schema interno não anulável.

## Leia a seguir

- [How to customize the OpenAPI document with AddOperationTransformer and AddSchemaTransformer in ASP.NET Core 11](/pt-br/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/)
- [Typed results (Results<>) vs IResult vs IActionResult in ASP.NET Core 11](/pt-br/2026/07/typed-results-vs-iresult-vs-iactionresult-in-aspnetcore-11/)
- [Migrate from Swashbuckle to the built-in OpenAPI generator in .NET 11](/pt-br/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/)
- [How to generate strongly typed client code from an OpenAPI spec in .NET 11](/pt-br/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/)
- [Fix: Swagger UI shows Unable to render this definition after upgrading to .NET 11](/pt-br/2026/08/fix-swagger-ui-unable-to-render-this-definition-after-upgrading-to-dotnet-11/)

## Fontes

- [TypeExtensions.cs (`ShouldApplyNullableResponseSchema`), dotnet/aspnetcore](https://github.com/dotnet/aspnetcore/blob/main/src/OpenApi/src/Extensions/TypeExtensions.cs)
- [Fix nullability handling in OpenApi, dotnet/aspnetcore#67661](https://github.com/dotnet/aspnetcore/pull/67661)
- [Model nullable types using oneOf in OpenAPI schema, dotnet/aspnetcore#63301](https://github.com/dotnet/aspnetcore/pull/63301)
- [Model nullable types using allOf in JSON schema (tracking issue), dotnet/aspnetcore#63029](https://github.com/dotnet/aspnetcore/issues/63029)
- [Customize OpenAPI documents, Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/customize-openapi)
- [Format response data in ASP.NET Core Web API (special-case formatters), Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/web-api/advanced/formatting)
- [HttpNoContentOutputFormatter.TreatNullValueAsNoContent, .NET API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.mvc.formatters.httpnocontentoutputformatter.treatnullvalueasnocontent)
- [NullabilityInfoContext, .NET API reference](https://learn.microsoft.com/en-us/dotnet/api/system.reflection.nullabilityinfocontext)
