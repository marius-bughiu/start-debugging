---
title: "Cómo marcar la respuesta de una acción de controlador como anulable en el documento OpenAPI integrado de ASP.NET Core"
description: "Microsoft.AspNetCore.OpenApi solo marca una respuesta como anulable cuando la acción devuelve un T? simple (y, en .NET 10, ni siquiera con Task<T?>). ActionResult<T?> e IActionResult pierden la anotación tanto en .NET 10 como en .NET 11 RC2. Aquí está el porqué, un transformador de operación probado que lo arregla y la trampa del 204 No Content que hace que la especificación mienta si no cambias también el formatter de MVC."
pubDate: 2026-10-20
template: how-to
tags:
  - "aspnetcore"
  - "openapi"
  - "dotnet-11"
  - "dotnet-10"
  - "nullable-reference-types"
  - "how-to"
lang: "es"
translationOf: "2026/10/how-to-mark-a-controller-action-response-as-nullable-in-aspnetcore-openapi"
translatedBy: "claude"
translationDate: 2026-10-20
---

**Respuesta corta:** en .NET 10 (`Microsoft.AspNetCore.OpenApi` 10.0.13) y .NET 11 RC2 (11.0.0-rc.2.26504.105), el generador integrado envuelve el esquema de una respuesta en `oneOf: [{ "type": "null" }, ...]` solo cuando el tipo de retorno de la propia acción es anulable: `Person?`, más `Task<Person?>` en .NET 11. Nunca mira dentro de `ActionResult<Person?>`, e `IActionResult` con `[ProducesResponseType<Person>]` no tiene nada que inspeccionar, así que ambos salen como no anulables. Registra un transformador de operación que lea el `MethodInfo` de la acción con `NullabilityInfoContext`, desenvuelva `Task<>` y `ActionResult<>`, y envuelva tú mismo el esquema 2xx (código más abajo, probado en ambas versiones). Después decide qué significa realmente null en la red, porque MVC envía **204 No Content** para un resultado null por defecto, no `200` con `null`.

Me topé con esto al generar un cliente con Kiota a partir de una API con controladores: el método generado para `GET /people/{id}` devolvía un `Person` no anulable, aunque la acción estaba declarada como `ActionResult<Person?>`. Todo lo que sigue se midió contra una aplicación de prueba con el SDK 10.0.302 (runtime 10.0.10) y el SDK 11.0.100-rc.2.26504.105, volcando `/openapi/v1.json` y ejecutando curl contra cada endpoint.

## Qué emite el generador para cada forma de retorno

El controlador de prueba tiene una acción por cada forma, todas devolviendo `null`, con `<Nullable>enable</Nullable>`:

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

Este es el esquema de la respuesta `200` que produjo cada una:

| Tipo de retorno | .NET 10.0.13 | .NET 11 RC2 |
|---|---|---|
| `Person?` | anulable (`oneOf`) | anulable (`oneOf`) |
| `Task<Person?>` | **no anulable** | anulable |
| `ActionResult<Person?>` | **no anulable** | **no anulable** |
| `Task<ActionResult<Person?>>` | **no anulable** | **no anulable** |
| `IActionResult` + `[ProducesResponseType<Person>]` | **no anulable** | **no anulable** |
| `ActionResult<int?>` | `type: ["null", "integer", "string"]`, sin `oneOf` | anulable (`oneOf`) |
| Minimal API `Person? () => null` | anulable (`oneOf`) | anulable (`oneOf`) |

"Anulable" aquí significa que el esquema salió así:

```json
"schema": {
  "oneOf": [
    { "type": "null" },
    { "$ref": "#/components/schemas/Person" }
  ]
}
```

y "no anulable" significa un simple `{ "$ref": "#/components/schemas/Person" }`. El componente `Person` en sí nunca se marca como anulable. Es deliberado: desde .NET 10 RC1 ([dotnet/aspnetcore#63301](https://github.com/dotnet/aspnetcore/pull/63301)) el generador mantiene un único componente compartido por tipo y expresa la nulabilidad en el punto de uso con un envoltorio `oneOf` en línea, de modo que un tipo que es anulable en un endpoint y no anulable en otro no se bifurca en dos componentes.

## Por qué ActionResult<T?> pierde la anotación

La decisión vive en un único método interno, `TypeExtensions.ShouldApplyNullableResponseSchema`, en `src/OpenApi/src/Extensions/TypeExtensions.cs`. En la etiqueta `v10.0.0` hace lo siguiente:

1. Obtiene el `MethodInfo` de la acción a partir del `ControllerActionDescriptor`.
2. Desenvuelve `Task<T>` o `ValueTask<T>` de `MethodInfo.ReturnType`.
3. Si ese tipo no es *igual* a `ApiResponseType.Type` (el tipo que ApiExplorer informa para la respuesta), devuelve `false`.
4. En caso contrario ejecuta `NullabilityInfoContext.Create(methodInfo.ReturnParameter)` y comprueba que `WriteState == Nullable`.

El paso 3 es donde `ActionResult<Person?>` queda fuera. ApiExplorer informa el tipo de respuesta como `Person`, el método devuelve `ActionResult<Person>`, los dos tipos no son iguales y se acabó. Nunca llega a la comprobación de nulabilidad. Lo mismo ocurre con `IActionResult` y un atributo: el tipo de retorno es `IActionResult`, el tipo de respuesta es `Person`.

El paso 4 explica el fallo de `Task<Person?>` en .NET 10. El tipo desenvuelto coincide, pero la comprobación de nulabilidad se ejecuta sobre el parámetro de retorno *original*, que es `Task<Person?>`. El `Task` en sí no es anulable, así que `WriteState` es `NotNull`.

[dotnet/aspnetcore#67661](https://github.com/dotnet/aspnetcore/pull/67661), fusionado en julio de 2026 y publicado en .NET 11, reescribió el método. Ahora hace un cortocircuito con `ModelMetadata.IsNullableValueType` (lo que arregla `ActionResult<int?>`), y para los tipos de referencia recorre `NullabilityInfo.GenericTypeArguments[0]` a través de `Task<>`/`ValueTask<>` (lo que arregla `Task<Person?>`). No desenvuelve `ActionResult<>`, así que para un tipo de referencia `NullabilityInfo` se detiene en `ActionResult<Person?>`, que no es null, y el resultado sigue siendo `false`. La descripción del PR lo dice tal cual: el manejo de tipos de referencia "is still not handled very well in this PR". La etiqueta RC2 y `main` tienen el mismo código que RC1, así que no esperes que esto cambie antes de GA.

## Solución: un transformador de operación que desenvuelve ActionResult<T>

El pipeline integrado te entrega el `ApiDescription` completo en un transformador de operación, lo que basta para rehacer la comprobación correctamente. Este transformador maneja dos casos: la nulabilidad que puede inferir del tipo de retorno y un atributo explícito `[NullableResponse(statusCode)]` para las acciones `IActionResult` donde no hay nada que inferir.

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

Regístralo en cada documento que expongas:

```csharp
// .NET 10 / .NET 11 RC2
builder.Services.AddControllers();
builder.Services.AddOpenApi(o => o.AddOperationTransformer<NullableResponseTransformer>());
```

Y usa el atributo donde el tipo de retorno no dice nada:

```csharp
// .NET 10 / .NET 11 RC2
[HttpGet("attr")]
[ProducesResponseType<Person>(StatusCodes.Status200OK)]
[NullableResponse(StatusCodes.Status200OK)]
public IActionResult GetAttr() => Ok(null);
```

Con el transformador registrado, cada fila de la tabla anterior salió con el envoltorio `oneOf` en ambas versiones, incluido `Task<Person?>` en .NET 10. Un `ActionResult<Person>` no anulable siguió siendo un simple `$ref`.

Algunas decisiones de diseño que vale la pena destacar:

- **Envuelve el punto de uso, no el componente.** Eso coincide con lo que hace el propio framework desde #63301. Si en cambio estableces `Type |= JsonSchemaType.Null` en el componente `Person` desde un transformador de esquema, todos los endpoints que devuelven `Person` pasan a ser anulables, incluso los que nunca devuelven null.
- **Solo toca respuestas 2xx cuyo tipo coincide con el `T` declarado.** Un `404` con `ProblemDetails` en la misma acción no se modifica.
- **Es idempotente.** Si el framework ya envolvió el esquema (un `Person?` simple, o `Task<Person?>` en .NET 11), `IsNullWrapper` lo omite, así que no obtienes un `oneOf` dentro de otro `oneOf`. Cuando el framework se ponga al día con `ActionResult<T?>`, el transformador pasará a ser silenciosamente una operación sin efecto.
- **El patrón `is OpenApiMediaType` está ahí por .NET 11.** `Microsoft.AspNetCore.OpenApi` 10.0.13 trae `Microsoft.OpenApi` 2.x, donde los valores de `Content` son el `OpenApiMediaType` concreto. El paquete 11.0 RC2 trae `Microsoft.OpenApi` 3.10.2, donde `Content` es `IDictionary<string, IOpenApiMediaType>` y `IOpenApiMediaType.Schema` no tiene setter. Asignar a través de la interfaz falla con `CS0200: Property or indexer 'IOpenApiMediaType.Schema' cannot be assigned to -- it is read only`. La coincidencia de patrones compila contra ambas.

Para la mecánica general de los transformadores (orden, activación por DI, el objeto de contexto), consulta [el análisis a fondo de los transformadores](/es/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/).

## La trampa: un resultado null de un controlador es 204, no 200

Esto es lo que devolvieron realmente los mismos endpoints en la red, idéntico en .NET 10 y .NET 11 RC2:

```text
GET /people/actionresult   -> HTTP/1.1 204 No Content   (no body)
GET /people/plain          -> HTTP/1.1 204 No Content
GET /people/taskplain      -> HTTP/1.1 204 No Content
GET /minimal/maybe         -> HTTP/1.1 200 OK, application/json, body: null
```

MVC registra `HttpNoContentOutputFormatter` por defecto, y su propiedad `TreatNullValueAsNoContent` vale `true` por defecto: cualquier resultado de objeto `null` se convierte en un `204` con cuerpo vacío. Las Minimal APIs no tienen ese formatter, así que realmente envían `200` con el literal JSON `null`.

Eso significa que, para los controladores, el propio envoltorio `oneOf` del framework sobre un `Person?` simple ya describe una respuesta que el servidor nunca envía: un cliente generado a partir de esa especificación espera `200` con `null` y recibe `204`. Así que elige uno de dos contratos honestos.

### Opción A: mantener el 204 y documentarlo

Deja MVC como está, mantén el esquema `200` no anulable y declara el `204`:

```csharp
// .NET 10 / .NET 11 RC2: null result -> 204 No Content
[HttpGet("{id:int}")]
[ProducesResponseType(StatusCodes.Status200OK)]
[ProducesResponseType(StatusCodes.Status204NoContent)]
public async Task<ActionResult<Person?>> Get(int id) => await _people.FindAsync(id);
```

En esta configuración no quieres el envoltorio anulable en el `200`, así que no registres el transformador, y ten presente que un retorno `Person?` simple sigue recibiendo el envoltorio del framework. La mayoría de los generadores de clientes tratan un `204` sin cuerpo como "sin resultado", que normalmente es lo que los llamadores quieren de todos modos.

### Opción B: enviar 200 con null y marcar el 200 como anulable

Desactiva la conversión a no-content y deja que el transformador lo describa:

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

Tras este cambio, `GET /people/actionresult` devolvió `HTTP/1.1 200 OK`, `Content-Type: application/json; charset=utf-8`, cuerpo `null`, que es exactamente lo que dice el esquema `oneOf`. Una acción `void` no se vio afectada (devolvía `200` con cuerpo vacío antes y después del cambio). La página de formato de Microsoft Learn muestra la otra forma de hacerlo, `o.OutputFormatters.RemoveType<HttpNoContentOutputFormatter>()`; yo prefiero cambiar la propiedad porque expresa la intención y deja intactos los demás casos del formatter.

Usa la Opción B cuando la API sea consumida por algo que ya espera `200`/`null`, o cuando estés migrando endpoints entre controladores y minimal APIs y quieras que se comporten igual. Usa la Opción A para todo lo demás; es el comportamiento por defecto del framework y no necesita transformador.

## Problemas frecuentes y casos límite

**Añadir cualquier `[ProducesResponseType]` elimina el 200 inferido.** En mi primera prueba puse solo `[ProducesResponseType(StatusCodes.Status404NotFound)]` en la acción `ActionResult<Person?>`, y la respuesta `200` desapareció por completo del documento, así que el transformador no tenía nada que envolver. Una vez que una acción tiene metadatos de respuesta explícitos, ApiExplorer deja de añadir el `200` por defecto para `ActionResult<T>`. Añade `[ProducesResponseType(StatusCodes.Status200OK)]` (no hace falta el tipo, `T` se completa solo) junto a tus códigos de error.

**`string?` no es JSON.** Una acción `string?` que devolvía null respondió con `200` y `Content-Type: text/plain` con cuerpo vacío una vez desactivado `TreatNullValueAsNoContent`, porque `StringOutputFormatter` gana para los strings. El documento sigue anunciando `application/json` con un string anulable. Si devuelves strings desde controladores, añade `[Produces("application/json")]` o devuelve un DTO pequeño.

**La salida OpenAPI 3.0 se ve distinta pero significa lo mismo.** Con `o.OpenApiVersion = OpenApiSpecVersion.OpenApi3_0`, `Microsoft.OpenApi` serializa la rama null como `{ "enum": [null], "nullable": true }` dentro del `oneOf`. Eso es válido en 3.0 y los generadores lo entienden. El valor por defecto es `3.1.1` en .NET 10 y `3.2.0` en .NET 11; si Swagger UI rechaza el documento 3.2, consulta [la solución de Swagger UI para .NET 11](/es/2026/08/fix-swagger-ui-unable-to-render-this-definition-after-upgrading-to-dotnet-11/).

**El contexto de nulabilidad importa.** `NullabilityInfoContext` lee los metadatos `[Nullable]` del compilador. En un archivo o proyecto con los tipos de referencia anulables desactivados, `Person?` es una advertencia y `Person` se informa como `Unknown`, no `Nullable`, así que ni el framework ni el transformador marcan nada. Es el resultado correcto: el código oblivious no promete nada en ningún sentido.

**Los typed results son una ruta de código aparte.** Las Minimal APIs y los controladores que devuelven `Results<Ok<Person>, NotFound>` describen las respuestas a través de `IEndpointMetadataProvider`, no del tipo de retorno del método. Probé tanto una minimal API que devuelve `Results<Ok<Person?>, NotFound>` como una acción de controlador que devuelve `Ok<Person?>`: en .NET 10 y .NET 11 RC2 el esquema `200` fue una referencia simple a `Person`. El transformador anterior tampoco infiere nada a partir de `Ok<T>`, así que pon `[NullableResponse(200)]` en esas acciones de controlador (para minimal APIs, usa `AddOperationTransformer` con una comprobación sobre la ruta, ya que no existe un `ControllerActionDescriptor`). Si estás eligiendo entre las formas, [typed results vs IResult vs IActionResult](/es/2026/07/typed-results-vs-iresult-vs-iactionresult-in-aspnetcore-11/) explica qué le dice cada una a ApiExplorer.

**No lo "arregles" en un transformador de esquema.** Es tentador hacer que `Person` sea anulable globalmente para que todo `$ref` acepte null. Pierdes la distinción entre endpoints, y con OpenAPI 3.1+ el envoltorio `oneOf` que el framework añade en otros lugares pasa a tener dos ramas que coinciden con `null`, lo que hace que `oneOf` falle la validación (exige exactamente una coincidencia). El PR #67661 señala precisamente esa razón para mantener el esquema interno no anulable.

## Lecturas recomendadas

- [How to customize the OpenAPI document with AddOperationTransformer and AddSchemaTransformer in ASP.NET Core 11](/es/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/)
- [Typed results (Results<>) vs IResult vs IActionResult in ASP.NET Core 11](/es/2026/07/typed-results-vs-iresult-vs-iactionresult-in-aspnetcore-11/)
- [Migrate from Swashbuckle to the built-in OpenAPI generator in .NET 11](/es/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/)
- [How to generate strongly typed client code from an OpenAPI spec in .NET 11](/es/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/)
- [Fix: Swagger UI shows Unable to render this definition after upgrading to .NET 11](/es/2026/08/fix-swagger-ui-unable-to-render-this-definition-after-upgrading-to-dotnet-11/)

## Fuentes

- [TypeExtensions.cs (`ShouldApplyNullableResponseSchema`), dotnet/aspnetcore](https://github.com/dotnet/aspnetcore/blob/main/src/OpenApi/src/Extensions/TypeExtensions.cs)
- [Fix nullability handling in OpenApi, dotnet/aspnetcore#67661](https://github.com/dotnet/aspnetcore/pull/67661)
- [Model nullable types using oneOf in OpenAPI schema, dotnet/aspnetcore#63301](https://github.com/dotnet/aspnetcore/pull/63301)
- [Model nullable types using allOf in JSON schema (tracking issue), dotnet/aspnetcore#63029](https://github.com/dotnet/aspnetcore/issues/63029)
- [Customize OpenAPI documents, Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/customize-openapi)
- [Format response data in ASP.NET Core Web API (special-case formatters), Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/web-api/advanced/formatting)
- [HttpNoContentOutputFormatter.TreatNullValueAsNoContent, .NET API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.mvc.formatters.httpnocontentoutputformatter.treatnullvalueasnocontent)
- [NullabilityInfoContext, .NET API reference](https://learn.microsoft.com/en-us/dotnet/api/system.reflection.nullabilityinfocontext)
