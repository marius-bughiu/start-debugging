---
title: "Cómo consumir una respuesta ProblemDetails de RFC 9457 desde un HttpClient tipado sin referenciar ASP.NET Core"
description: "La BCL no tiene un tipo ProblemDetails, y agregar un FrameworkReference a Microsoft.AspNetCore.App hace que tu cliente se niegue a arrancar en un contenedor que solo trae el runtime. Aquí está el modelo de 20 líneas que resuelve el problema, el DelegatingHandler que convierte problem+json en una excepción tipada, y el mito del content-type que casi todas las respuestas siguen repitiendo."
pubDate: 2026-09-07
template: how-to
tags:
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "httpclient"
  - "system-text-json"
  - "aspnetcore-11"
  - "how-to"
lang: "es"
translationOf: "2026/09/how-to-consume-an-rfc-9457-problemdetails-response-from-a-typed-httpclient"
translatedBy: "claude"
translationDate: 2026-09-07
---

Respuesta corta: no referencies ASP.NET Core. Declara una clase con cinco propiedades y un diccionario `[JsonExtensionData]` para los miembros de extensión, y deserialízala con `HttpContent.ReadFromJsonAsync<T>` de `System.Net.Http.Json`. El tipo de medio `application/problem+json` se parsea sin problemas porque `ReadFromJsonAsync` no verifica tipos de contenido desde .NET 5, y todo esto funciona en una aplicación de consola, una biblioteca de clases, Blazor WebAssembly, MAUI y un cliente con Native AOT.

Este artículo cubre por qué `Microsoft.AspNetCore.Mvc.ProblemDetails` es el tipo equivocado al que recurrir en el cliente, el fallo exacto que obtienes si recurres a él de todos modos, el modelo que hace round-trip de una respuesta de problema real de ASP.NET Core incluyendo `errors` y `traceId`, cómo conectarlo a un `HttpClient` tipado para que un 4xx se convierta en una excepción tipada, y el puñado de reglas de RFC 9457 que te van a morder si tratas `status` como algo confiable.

Una nota sobre versiones. .NET 11 y ASP.NET Core 11 están en versión preliminar a septiembre de 2026 y llegan a disponibilidad general el 2026-11-10, según las [notas de versión de .NET 11](https://github.com/dotnet/core/blob/main/release-notes/11.0/README.md). Nada en esta área cambia en .NET 11, y la propuesta de API que lo arreglaría de verdad apunta a .NET 12 (más sobre eso al final). Toda la salida que aparece abajo se produjo en esta máquina con el SDK de .NET 10.0.302 y los runtimes 10.0.10, contra una minimal API que usa `AddProblemDetails()`.

## Por qué el cliente no puede simplemente usar el tipo del servidor

`ProblemDetails` es una clase de datos simple con cinco propiedades anulables y un diccionario. No tiene comportamiento ni dependencias de servidor. Aun así vive en `Microsoft.AspNetCore.Http.Abstractions.dll`, que se distribuye únicamente como parte del framework compartido `Microsoft.AspNetCore.App`, así que la única forma soportada de alcanzarlo es una referencia de framework:

```xml
<!-- Contracts.csproj, .NET 10 / .NET 11 -->
<ItemGroup>
  <FrameworkReference Include="Microsoft.AspNetCore.App" />
</ItemGroup>
```

Eso compila. Y también se propaga. Agrega esa biblioteca de clases a una aplicación de consola por lo demás corriente y mira lo que el SDK escribe en `Cli.runtimeconfig.json`:

```json
{
  "runtimeOptions": {
    "tfm": "net10.0",
    "frameworks": [
      { "name": "Microsoft.NETCore.App", "version": "10.0.0" },
      { "name": "Microsoft.AspNetCore.App", "version": "10.0.0" }
    ]
  }
}
```

La aplicación de consola ahora exige de forma dura el framework compartido de ASP.NET Core al arrancar. En una máquina que lo tiene todo se ve bien, que es exactamente por qué esto llega a producción. Ejecuta el mismo binario contra una instalación de .NET que solo trae el runtime, que es lo que te da `mcr.microsoft.com/dotnet/runtime:10.0`, y el host se niega antes de que se ejecute una sola línea de tu código:

```
You must install or update .NET to run this application.

App: /app/Cli.dll
Architecture: arm64
Framework: 'Microsoft.AspNetCore.App', version '10.0.0' (arm64)

No frameworks were found.
```

Produje eso copiando solo `shared/Microsoft.NETCore.App` a un `DOTNET_ROOT` temporal y lanzando la aplicación ahí. Es el mensaje idéntico que obtienes con la imagen base equivocada, y la solución que la gente suele aplicar es cambiar a la imagen `aspnet`, que agrega cerca de 20 MB de framework de servidor a un cliente que jamás va a abrir un socket en modo escucha. Si estás dimensionando imágenes, las contrapartidas están en [Dependiente del framework vs autocontenido vs Native AOT para una imagen de contenedor de .NET 11](/es/2026/09/framework-dependent-vs-self-contained-vs-native-aot-for-a-dotnet-11-container-image/).

Los demás destinos fallan antes y más fuerte. `FrameworkReference` a `Microsoft.AspNetCore.App` no está disponible para una biblioteca `netstandard2.0` en absoluto, y un cliente de Blazor WebAssembly o MAUI no tiene por qué arrastrar Kestrel, MVC y metadatos de enrutamiento a su grafo de trimming para leer cinco cadenas JSON. La incidencia de `dotnet/aspnetcore` que pide reubicar el tipo, [#58551 "Move ProblemDetails outside of Asp.Net Core"](https://github.com/dotnet/aspnetcore/issues/58551), lleva sin asignar en el backlog desde que se abrió.

## El modelo, en cuatro pasos

1. **Declara los cinco miembros de RFC 9457 como propiedades anulables.** Cada miembro en la [sección 3.1 de RFC 9457](https://datatracker.ietf.org/doc/html/rfc9457#section-3.1) es opcional. `status` es un número JSON, así que es `int?`; los otros cuatro son cadenas.
2. **Agrega un diccionario `[JsonExtensionData]`.** La sección 3.2 de RFC 9457 permite que un tipo de problema agregue miembros en el mismo espacio de nombres plano que los estándar, y ASP.NET Core escribe su diccionario `Extensions` exactamente así. Sin esto pierdes en silencio `errors`, `traceId` y todos los campos específicos del dominio que la API haya agregado.
3. **Deserializa con `ReadFromJsonAsync<T>` sobre el `HttpContent`,** no con `GetFromJsonAsync`. Los helpers a nivel de `HttpClient` llaman a `EnsureSuccessStatusCode` por ti, que es justo lo contrario de lo que quieres aquí.
4. **Verifica el tipo de medio tú mismo,** porque nadie más lo hará.

El tipo es lo bastante corto como para pegarlo en cualquier proyecto cliente:

```csharp
// .NET 10 / .NET 11, C# 14. Only needs System.Net.Http.Json + System.Text.Json.
using System.Text.Json;
using System.Text.Json.Serialization;

public sealed class ProblemDetails
{
    public string? Type { get; set; }
    public string? Title { get; set; }
    public int? Status { get; set; }
    public string? Detail { get; set; }
    public string? Instance { get; set; }

    [JsonExtensionData]
    public IDictionary<string, JsonElement>? Extensions { get; set; }
}
```

No hacen falta atributos `[JsonPropertyName]`. `ReadFromJsonAsync` usa por defecto `JsonSerializerOptions.Web`, que establece `PropertyNamingPolicy` en camelCase y `PropertyNameCaseInsensitive` en `true`, así que `title` se enlaza a `Title` por sí solo. Contra una respuesta real de ASP.NET Core el modelo captura todo:

```
type=https://example.com/probs/insufficient-funds
title=Insufficient funds
status=402
detail=Account 12345 has a balance of 4.20 EUR.
instance=/accounts/12345/withdraw
extensions: balance=4.20, accounts=["/account/12345","/account/67890"], traceId=00-5bf0...-00
```

Ese `traceId` no es algo que el endpoint haya puesto. El `DefaultProblemDetailsWriter` de ASP.NET Core lo agrega desde `Activity.Current?.Id`, con `HttpContext.TraceIdentifier` como alternativa, en cada respuesta de problema escrita a través de `AddProblemDetails()`. Es el campo más útil del payload cuando estás correlacionando un fallo del lado del cliente con un registro del servidor, y solo sobrevive si conservaste el diccionario de extensiones.

## Los errores de validación son un miembro de extensión, no una propiedad

Un fallo de validación de ASP.NET Core se ve así en el cable:

```json
{
  "type": "https://tools.ietf.org/html/rfc9110#section-15.5.1",
  "title": "One or more validation errors occurred.",
  "status": 400,
  "errors": {
    "Sku": ["The Sku field is required."],
    "Quantity": ["The field Quantity must be between 1 and 100."]
  },
  "traceId": "00-8246...-00"
}
```

`errors` es un hermano de nivel superior de `title`, así que aterriza en `Extensions` con un `ValueKind` de `Object`. Leerlo de vuelta es un helper pequeño, y tiene que ser defensivo: la sección 3.1 de RFC 9457 dice que un miembro cuyo tipo de valor no coincide con el esperado DEBE ser ignorado, y el propio ejemplo del RFC en la sección 3 usa un **arreglo** `errors` de objetos `{detail, pointer}` en lugar del mapa por miembro de ASP.NET Core. Si llamas a una API que no es de .NET, te vas a encontrar con la otra forma.

```csharp
// .NET 10 / .NET 11, C# 14
using System.Collections.ObjectModel;

public IReadOnlyDictionary<string, string[]> GetValidationErrors()
{
    if (Extensions is null ||
        !Extensions.TryGetValue("errors", out var errors) ||
        errors.ValueKind is not JsonValueKind.Object)
    {
        return ReadOnlyDictionary<string, string[]>.Empty;
    }

    var result = new Dictionary<string, string[]>(StringComparer.Ordinal);
    foreach (var member in errors.EnumerateObject())
    {
        if (member.Value.ValueKind is not JsonValueKind.Array) continue;
        result[member.Name] = member.Value.EnumerateArray()
            .Where(e => e.ValueKind is JsonValueKind.String)
            .Select(e => e.GetString()!)
            .ToArray();
    }
    return result;
}
```

Salida verificada contra el payload de arriba:

```
Sku: The Sku field is required.
Quantity: The field Quantity must be between 1 and 100.
```

Cada rama que se rinde devuelve un diccionario vacío en lugar de lanzar, que es el comportamiento que la sección 3.2 pide a los consumidores: ignora las extensiones que no reconoces. Si además eres dueño del servidor, la forma de lo que emite está bajo tu control mediante [IProblemDetailsService y las respuestas de validación de minimal APIs](/es/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/).

## La verificación de content-type que ya no existe

La mitad de las respuestas sobre este tema advierten que `ReadFromJsonAsync` lanza `NotSupportedException: The provided ContentType is not supported` a menos que la respuesta sea `application/json`. Eso era cierto en la versión preliminar de `System.Net.Http.Json` para .NET Core 3.1 y es falso desde .NET 5: [dotnet/runtime#40594](https://github.com/dotnet/runtime/pull/40594) eliminó la validación por completo para resolver [#38713](https://github.com/dotnet/runtime/issues/38713), y no existe ningún `ValidateContent` en el código fuente actual de `HttpContentJsonExtensions`.

Medido sobre 10.0.10, a lo largo de una matriz de tipos de contenido con el mismo cuerpo problem+json:

| Content-Type | Cuerpo | Resultado |
| --- | --- | --- |
| `application/problem+json` | JSON de problema | se parsea |
| `application/problem+json; charset=utf-8` | JSON de problema | se parsea |
| `text/html` | JSON de problema | **se parsea** |
| `text/plain` | JSON de problema | se parsea |
| (ninguno) | JSON de problema | se parsea |
| `text/html` | `<html/>` | `JsonException: '<' is an invalid start of a value` |
| `application/problem+json` | vacío | `JsonException: The input does not contain any JSON tokens` |
| `application/problem+json` | `null` | devuelve `null` |

De ahí se siguen dos cosas. Primero, no necesitas ningún rodeo para leer `application/problem+json`, y nunca lo necesitaste en .NET 5 o posterior. Segundo, la red de seguridad que asumías que estaba ahí no está: si una gateway devuelve una página HTML de error 502, `ReadFromJsonAsync` va a intentar parsearla tan campante y te va a entregar una `JsonException` en lugar de una señal limpia de "esto no es un documento de problema". Por eso el paso 4 de arriba dice que verifiques el tipo de medio tú mismo, y por eso la verificación va sobre `Content.Headers.ContentType?.MediaType` y no sobre la cabecera cruda, que arrastra el parámetro `charset`.

Ya que estamos: `JsonSerializerOptions.Web` también establece `NumberHandling` en `AllowReadingFromString`, así que un servidor que escribe `"status": "402"` como cadena igual se enlaza a `int?`. Esa juega a tu favor.

## Convertir un 4xx en una excepción tipada

El lugar natural para esto es un `DelegatingHandler` sobre un cliente tipado, para que cada punto de llamada reciba el comportamiento sin un `if` por método. La excepción deriva de `HttpRequestException` para que los bloques `catch` existentes y las políticas de reintento sigan funcionando:

```csharp
// .NET 10 / .NET 11, C# 14
public sealed class ProblemDetailsException(ProblemDetails problem, HttpStatusCode status)
    : HttpRequestException(
        problem.Detail ?? problem.Title ?? "The server returned a problem response.",
        inner: null,
        statusCode: status)
{
    public ProblemDetails ProblemDetails { get; } = problem;
}

public sealed class ProblemDetailsHandler : DelegatingHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken ct)
    {
        var response = await base.SendAsync(request, ct);
        if (response.IsSuccessStatusCode) return response;

        var mediaType = response.Content.Headers.ContentType?.MediaType;
        if (!string.Equals(mediaType, "application/problem+json", StringComparison.OrdinalIgnoreCase))
            return response;

        var json = await response.Content.ReadAsStringAsync(ct);
        var problem = JsonSerializer.Deserialize<ProblemDetails>(json, JsonSerializerOptions.Web);
        if (problem is null) return response;

        throw new ProblemDetailsException(problem, response.StatusCode);
    }
}
```

El registro es `IHttpClientFactory` corriente:

```csharp
services.AddTransient<ProblemDetailsHandler>();
services.AddHttpClient<OrdersClient>(c => c.BaseAddress = new Uri("https://api.example.com"))
        .AddHttpMessageHandler<ProblemDetailsHandler>();
```

Y el punto de llamada recibe el payload completo, en un 404 que antes era un código de estado pelado:

```
ProblemDetailsException: No order with id abc.
  StatusCode=NotFound  type=https://api.example.com/probs/order-not-found
  orderId extension = abc
  is HttpRequestException: True
```

Fíjate en el `ReadAsStringAsync` dentro del handler en lugar de `ReadFromJsonAsync`. Esto no es estilístico. En 10.0.10, llamar a `ReadFromJsonAsync` sobre un `HttpContent` libera el stream almacenado en búfer, así que una segunda llamada sobre la misma respuesta lanza `ObjectDisposedException: Cannot access a closed Stream`. En un handler que a veces devuelve la respuesta en lugar de lanzar, eso significa que destruiste el cuerpo para quien llama. `ReadAsStringAsync` se puede repetir, y `ReadAsStringAsync` seguido de `ReadFromJsonAsync` también está bien; solo `ReadFromJsonAsync` dos veces falla. Si usas `HttpCompletionOption.ResponseHeadersRead` en algún punto de la cadena, llama a `LoadIntoBufferAsync()` antes de espiar el cuerpo.

Probar el handler es el ejercicio estándar del `HttpMessageHandler` falso que se cubre en [Cómo hacer pruebas unitarias de código que usa HttpClient](/es/2026/04/how-to-unit-test-code-that-uses-httpclient/). Si todavía estás decidiendo la forma del cliente en sí, [HttpClient vs HttpClientFactory vs Refit](/es/2026/05/httpclient-vs-httpclientfactory-vs-refit/) cubre dónde encaja un handler como este en cada opción.

## Cuatro reglas del RFC que te van a morder

**`status` es solo orientativo.** La sección 3.1.2 es explícita: "The 'status' member, if present, is only advisory". También es opcional. Un servidor detrás de un proxy que reescribe el estado te deja con un cuerpo que dice 409 sobre una respuesta HTTP 502. Ramifica siempre según `response.StatusCode`, y trata `ProblemDetails.Status` como un campo de diagnóstico que registras, no uno sobre el que haces switch.

**Ramifica según `type`, no según `title` ni el estado.** `type` es el identificador estable; a `title` se le permite explícitamente estar localizado, y la sección 3.1 dice que "SHOULD NOT change from occurrence to occurrence" solo para un tipo dado. Cuando `type` está ausente, la sección 3.1.1 dice que se asume que su valor es `about:blank`, lo que según la sección 4.2.1 significa "ninguna información más allá del código de estado" e implica que `title` es solo la frase del estado. Normaliza un `type` ausente o vacío a `about:blank` antes de comparar.

**`type` e `instance` son *referencias* URI, así que pueden ser relativas.** El RFC lo permite y advierte que "using relative URIs can cause confusion, and they might not be handled correctly by all implementations". Si comparas `type` contra una constante, resuélvela primero: `new Uri(response.RequestMessage!.RequestUri!, pd.Type ?? "about:blank")`.

**No deferencies `type`, y no muestres `detail` a los usuarios finales.** La sección 5 les dice a los consumidores que "SHOULD NOT automatically dereference the type URI" fuera de herramientas para desarrolladores, y el sentido entero de `detail` es que es texto del servidor específico de esa ocurrencia, que con frecuencia filtra detalles internos. Regístralo, correlaciónalo por `traceId` y muestra tu propio mensaje.

Dos más pequeñas. Las cabeceras siguen importando: un documento de problema con 429 no lleva el retraso de reintento en el cuerpo, lo lleva en `Retry-After`, así que lee la cabecera. Y una respuesta de problema no está garantizada para cada fallo. En mi matriz un 429 volvió sin tipo de contenido y con un cuerpo de longitud cero, que es exactamente el caso que la verificación de tipo de medio del handler de arriba deja pasar intacto.

## Native AOT y trimming

El modelo funciona con el generador de código fuente de `System.Text.Json`, `[JsonExtensionData]` incluido, siempre que el diccionario sea uno de `IDictionary<string, JsonElement>`, `IDictionary<string, object>`, `IDictionary<string, JsonNode>` o `JsonNode`. Cualquier otra cosa es `SYSLIB1036` en tiempo de compilación.

```csharp
// .NET 10 / .NET 11, C# 14
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(ProblemDetails))]
public partial class ProblemJsonContext : JsonSerializerContext;

// ...
var problem = await response.Content.ReadFromJsonAsync(ProblemJsonContext.Default.ProblemDetails, ct);
```

Verificado en 10.0.10: la ruta generada por código fuente parsea el mismo payload y preserva `4.20` como un decimal exacto en el diccionario de extensiones, porque `JsonElement` conserva el texto crudo. Leerlo con `GetDecimal()` te da `4.20`, no un artefacto de coma flotante. Eso importa para campos monetarios, y es una razón más para mantener las extensiones como `JsonElement` en lugar de `object`. Si necesitas reformar lo que emite el generador, [un modificador de type info resolver](/es/2026/08/how-to-customize-source-generated-system-text-json-serialization-with-a-modifier/) es el punto de enganche.

## Qué podría cambiar en .NET 12

Hay una propuesta de API abierta, [dotnet/runtime#131046](https://github.com/dotnet/runtime/issues/131046), para poner todo esto en la BCL: un modelo `ProblemDetails` en `System.Net.Http.Json`, `HttpResponseMessage.IsProblemJson()`, `ReadProblemJsonAsync()`, `ThrowIfProblemJsonAsync()` y una `ProblemDetailsException` que deriva de `HttpRequestException`. El razonamiento de la propuesta es el mismo con el que abre este artículo: referenciar el framework de servidor "pulls ASP.NET Core into console apps, MAUI apps, Blazor WASM clients, and class libraries that have no business depending on a server framework". Está etiquetada como `api-suggestion` contra el hito 12.0.0, lo que significa que no está en .NET 11 y tampoco está garantizada para .NET 12.

Hasta que llegue, las veinte líneas de arriba son la respuesta completa, y son compatibles hacia adelante: el tipo propuesto para la BCL tiene las mismas cinco propiedades y un diccionario de extensiones, así que cambiarse a él después es un cambio de espacio de nombres y un borrado.

## Relacionados

- [Cómo personalizar las respuestas de error de validación de minimal APIs con IProblemDetailsService en ASP.NET Core 11](/es/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/)
- [HttpClient vs HttpClientFactory vs Refit: ¿cuál deberías usar en .NET 11?](/es/2026/05/httpclient-vs-httpclientfactory-vs-refit/)
- [Cómo hacer pruebas unitarias de código que usa HttpClient](/es/2026/04/how-to-unit-test-code-that-uses-httpclient/)
- [Cómo personalizar la serialización de System.Text.Json generada por código fuente con un modificador de type info resolver](/es/2026/08/how-to-customize-source-generated-system-text-json-serialization-with-a-modifier/)
- [Dependiente del framework vs autocontenido vs Native AOT para una imagen de contenedor de .NET 11](/es/2026/09/framework-dependent-vs-self-contained-vs-native-aot-for-a-dotnet-11-container-image/)

## Fuentes

- [RFC 9457, Problem Details for HTTP APIs](https://datatracker.ietf.org/doc/html/rfc9457)
- [Propuesta de API: soporte de Problem Details (RFC 9457) en System.Net.Http.Json, dotnet/runtime#131046](https://github.com/dotnet/runtime/issues/131046)
- [Move ProblemDetails outside of Asp.Net Core, dotnet/aspnetcore#58551](https://github.com/dotnet/aspnetcore/issues/58551)
- [Eliminar la verificación de tipo de contenido de ReadFromJsonAsync, dotnet/runtime#40594](https://github.com/dotnet/runtime/pull/40594)
- [Referencia de la clase ProblemDetails en Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.mvc.problemdetails)
- [Código fuente de DefaultProblemDetailsWriter en dotnet/aspnetcore](https://github.com/dotnet/aspnetcore/blob/main/src/Http/Http.Extensions/src/DefaultProblemDetailsWriter.cs)
- [SYSLIB1036: requisitos de tipo para JsonExtensionData](https://learn.microsoft.com/en-US/dotnet/fundamentals/syslib-diagnostics/syslib1036)
