---
title: "Solución: \"415 Unsupported Media Type\" desde un endpoint de minimal API en ASP.NET Core 11"
description: "Una minimal API devuelve 415 cuando el Content-Type de la solicitud no coincide con lo que enlaza el endpoint. Envía Content-Type: application/json para un tipo enlazado desde el cuerpo, o usa [FromForm] para formularios y cargas de archivos."
pubDate: 2026-07-06
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-apis"
lang: "es"
translationOf: "2026/07/fix-415-unsupported-media-type-from-a-minimal-api-endpoint-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-06
---

Un endpoint de minimal API devuelve `415 Unsupported Media Type` cuando el encabezado `Content-Type` del cuerpo de la solicitud no coincide con lo que el route handler intenta enlazar. La causa más común: un parámetro del handler es un tipo complejo enlazado desde el cuerpo, lo que requiere `Content-Type: application/json`, y el cliente no envió ningún content type, envió `text/plain` o envió datos de formulario. Soluciónalo enviando `Content-Type: application/json` para un cuerpo JSON, o anota el parámetro con `[FromForm]` cuando el cliente publica `application/x-www-form-urlencoded` o `multipart/form-data`. Esto está verificado contra ASP.NET Core 11 en .NET 11 con C# 14; el comportamiento es idéntico en .NET 8 hasta .NET 10.

## El error en contexto

A diferencia de la mayoría de las excepciones, esta nunca llega a tu código. La capa de enlace de la minimal API rechaza la solicitud antes de que se ejecute tu handler y escribe un `415` escueto de vuelta al cliente. No hay traza de pila, no hay cuerpo `ProblemDetails` por defecto, solo la línea de estado:

```
HTTP/1.1 415 Unsupported Media Type
Content-Type: application/problem+json
Date: Mon, 06 Jul 2026 09:12:44 GMT

{
  "type": "https://tools.ietf.org/html/rfc9110#section-15.5.16",
  "title": "Unsupported Media Type",
  "status": 415
}
```

Si no has configurado `AddProblemDetails()`, obtienes un cuerpo vacío con solo el estado `415`. En cualquier caso, la ausencia de una traza de pila es la señal: se trata de una falla de negociación de contenido a nivel del framework, no de algo lanzado dentro de tu handler. La referencia de enlace de parámetros de Microsoft Learn lo documenta claramente en su tabla de fallas de enlace: "Wrong content type (not `application/json`), body, 415."

## Por qué ocurre esto

Un route handler de minimal API enlaza cada parámetro desde una fuente: la ruta, la cadena de consulta, un encabezado, un servicio de DI o el cuerpo de la solicitud. Cuando un parámetro es un tipo complejo sin atributo `[From*]`, las minimal APIs infieren que proviene del cuerpo de la solicitud, y el único lector de cuerpo configurado por defecto es el lector de `System.Text.Json`. Ese lector está registrado para exactamente un media type: `application/json`.

Así que el framework hace una verificación de content type antes de siquiera llamar a `JsonSerializer`. Si el `Content-Type` entrante no es `application/json` (o un tipo compatible con sufijo `+json`), el lector de cuerpo rechaza la solicitud, y las minimal APIs cortocircuitan con `415`. No intenta adivinar. Un `Content-Type` ausente, `text/plain`, `application/x-www-form-urlencoded` o `multipart/form-data` fallan todos de la misma manera cuando el parámetro de destino espera un cuerpo JSON.

Esta es una falla diferente de un `400 Bad Request`. Un `400` significa que el content type era correcto pero la carga JSON estaba malformada o violaba la validación. Un `415` significa que el framework ni siquiera intentó leer el cuerpo porque el content type era incorrecto. Mantener esos dos separados te ahorra depurar tu JSON cuando el problema real es un encabezado. Los tres desencadenantes habituales:

- El cliente envía un cuerpo JSON pero olvida el encabezado `Content-Type: application/json` (o un proxy lo elimina).
- El cliente publica datos de formulario (`application/x-www-form-urlencoded` o `multipart/form-data`) a un handler cuyo parámetro está enlazado desde el cuerpo JSON.
- El cliente envía un content type de proveedor o decorado con charset que el lector JSON no está registrado para aceptar.

## Reproducción mínima

Aquí está el endpoint más pequeño que produce el error. `CreateProduct` es un tipo complejo sin atributo de enlace, así que las minimal APIs lo enlazan desde el cuerpo JSON:

```csharp
// .NET 11, ASP.NET Core 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddProblemDetails();   // so the 415 comes back as problem+json
var app = builder.Build();

app.MapPost("/products", (CreateProduct product) =>
    TypedResults.Created($"/products/{product.Sku}", product));

app.Run();

public record CreateProduct(string Sku, string Name, int Quantity);
```

Ahora publica un cuerpo sin el encabezado de content type. Cada una de estas devuelve `415`:

```bash
# .NET 11 -- no Content-Type header at all
curl -i -X POST http://localhost:5000/products \
  -d '{"sku":"A-100","name":"Widget","quantity":5}'

# .NET 11 -- wrong Content-Type (curl defaults -d to x-www-form-urlencoded)
curl -i -X POST http://localhost:5000/products \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d 'sku=A-100&name=Widget&quantity=5'

# .NET 11 -- text/plain, even though the payload is valid JSON
curl -i -X POST http://localhost:5000/products \
  -H "Content-Type: text/plain" \
  -d '{"sku":"A-100","name":"Widget","quantity":5}'
```

La carga en la primera y tercera llamadas es JSON perfectamente válido. No importa. El lector se controla por el encabezado, no por los bytes.

## La solución, en detalle

Trabaja estos en orden. El primero resuelve la gran mayoría de los casos.

### 1. Envía `Content-Type: application/json` para un tipo enlazado desde el cuerpo

Si tu handler enlaza un tipo complejo desde el cuerpo, el cliente debe declarar un content type JSON. Con `curl`, la trampa es que `-d` (o `--data`) establece silenciosamente `application/x-www-form-urlencoded`. Usa `--json`, o establece el encabezado explícitamente:

```bash
# .NET 11 -- curl 7.82+ has a --json shortcut that sets the header for you
curl -i -X POST http://localhost:5000/products \
  --json '{"sku":"A-100","name":"Widget","quantity":5}'

# .NET 11 -- or set it by hand
curl -i -X POST http://localhost:5000/products \
  -H "Content-Type: application/json" \
  -d '{"sku":"A-100","name":"Widget","quantity":5}'
```

Desde un `HttpClient` tipado, usa `PostAsJsonAsync`, que establece el encabezado y serializa en una sola llamada. Esta es la forma más común de arreglar o romper accidentalmente el encabezado:

```csharp
// .NET 11, C# 14 -- sets Content-Type: application/json automatically
using System.Net.Http.Json;

var http = new HttpClient { BaseAddress = new Uri("http://localhost:5000") };
var response = await http.PostAsJsonAsync(
    "/products",
    new { sku = "A-100", name = "Widget", quantity = 5 });

response.EnsureSuccessStatusCode();   // 201 Created, no 415
```

Si construyes a mano el `HttpContent`, usa `JsonContent.Create(...)` o un `StringContent` con el media type establecido. Un `new StringContent(json)` sin media type usa `text/plain` por defecto y te da un `415`:

```csharp
// .NET 11, C# 14
// WRONG -- StringContent defaults to text/plain -> 415
var bad = new StringContent(json);

// RIGHT -- declare the media type
var good = new StringContent(json, System.Text.Encoding.UTF8, "application/json");
```

En JavaScript `fetch`, establece el encabezado explícitamente; `fetch` no lo agrega por ti cuando el cuerpo es una cadena:

```javascript
// browser fetch -- must set Content-Type or you get 415
await fetch("/products", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ sku: "A-100", name: "Widget", quantity: 5 }),
});
```

### 2. Usa `[FromForm]` para publicaciones de formularios y cargas de archivos

Si el cliente genuinamente envía datos de formulario (un envío de `<form>` HTML, o una carga de archivo), no lo fuerces a JSON. Indícale al handler que enlace desde el formulario en lugar del cuerpo anotando cada parámetro con `[FromForm]`. Esto cambia el content type esperado del endpoint a `application/x-www-form-urlencoded` y `multipart/form-data`:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
app.MapPost("/products",
    ([FromForm] string sku, [FromForm] string name, [FromForm] int quantity) =>
        TypedResults.Created($"/products/{sku}", new { sku, name, quantity }));
```

Para cargas de archivos, un parámetro `IFormFile` requiere `multipart/form-data`. Según la documentación de minimal API, las minimal APIs no enlazan el cuerpo completo de la solicitud directamente a un `IFormFile`; el campo debe llegar a través de codificación de formulario, y el nombre del parámetro debe coincidir con el nombre del campo del formulario:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
app.MapPost("/upload",
    async ([FromForm] string title, IFormFile file, HttpContext ctx) =>
    {
        await using var stream = File.Create(Path.Combine("uploads", file.FileName));
        await file.CopyToAsync(stream);
        return TypedResults.Ok(new { title, file.FileName, file.Length });
    })
    .DisableAntiforgery();   // see the gotcha below before you copy this line
```

Publícalo como multipart y el `415` desaparece:

```bash
# .NET 11 -- multipart, matches the [FromForm] + IFormFile handler
curl -i -X POST http://localhost:5000/upload \
  -F "title=Spec sheet" \
  -F "file=@./spec.pdf"
```

### 3. Elimina el charset o sufijo de proveedor que el lector JSON rechaza

Un content type como `application/json; charset=utf-8` se acepta, pero un tipo de proveedor escueto como `application/vnd.myapp+json` puede que no, dependiendo de cómo estén configurados los media types del lector. Si controlas un cliente que envía un media type `+json` personalizado y no puedes cambiarlo, registra ese media type para que el lector de cuerpo JSON lo reconozca. En las minimal APIs esto se hace configurando los content types de solicitud aceptados del endpoint con `Accepts`, que también alimenta tu documento OpenAPI:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
app.MapPost("/products", (CreateProduct product) =>
        TypedResults.Created($"/products/{product.Sku}", product))
    .Accepts<CreateProduct>("application/json", "application/vnd.myapp+json");
```

### 4. Lee un cuerpo no JSON tú mismo con HttpRequest

Cuando la carga no es JSON en absoluto (bytes crudos, CSV, un formato de texto personalizado), deja de enlazar un tipo complejo y lee el stream directamente. Enlaza `HttpRequest` (o `Stream`, o `PipeReader`), que las minimal APIs proporcionan sin ninguna verificación de content type, y analiza el cuerpo en tus propios términos:

```csharp
// .NET 11, ASP.NET Core 11, C# 14 -- accepts any content type
app.MapPost("/import", async (HttpRequest request) =>
{
    using var reader = new StreamReader(request.Body);
    var raw = await reader.ReadToEndAsync();
    // parse `raw` (CSV, custom format, whatever) here
    return TypedResults.Ok(new { bytes = raw.Length });
});
```

Como nunca le pediste al framework que deserializara el cuerpo en un parámetro tipado, no hay control de content type, y el `415` no puede ocurrir en este endpoint.

## Detalles y variantes

Un puñado de casos parecidos envían a la gente a esta página por error, y algunos filos afilados muerden incluso después de la solución:

- **`415` no es `406`.** `415 Unsupported Media Type` trata sobre el `Content-Type` del cuerpo de la solicitud. `406 Not Acceptable` trata sobre el encabezado `Accept` del cliente para la respuesta. Si estás obteniendo `406`, estás en la página equivocada: el servidor no puede producir una representación que el cliente acepte, lo cual es un problema de formateador a la salida, no a la entrada.

- **`415` no es `400`.** Si el content type es correcto pero el JSON está malformado o falla la validación, obtienes un `400`, no un `415`. Para ese camino, consulta [cómo validar cuerpos de solicitud en minimal APIs sin controllers](/es/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/), y si necesitas remodelar la carga del `400`, [personaliza las respuestas de error de validación de minimal API con IProblemDetailsService](/es/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/). Una variante específica de JSON malformado, una cadena de fecha que el serializador no puede analizar, se cubre en [the JSON value could not be converted](/es/2026/05/fix-jsonexception-the-json-value-could-not-be-converted/).

- **Los endpoints con `[FromForm]` requieren un token antiforgery por defecto.** Desde .NET 8, los parámetros de minimal API enlazados desde formularios activan la validación antiforgery. Un cliente programático (curl, `HttpClient`) que publica un formulario sin un token válido es rechazado, lo cual se lee como un problema de content type pero no lo es. O bien envía el token antiforgery, o llama a `.DisableAntiforgery()` en los endpoints que no son controlados por navegador, como en el ejemplo de carga anterior. No lo deshabilites de forma general en endpoints a los que un navegador publica.

- **Un `Content-Type` ausente se comporta como uno incorrecto.** Algunos clientes HTTP omiten el encabezado por completo para un `POST` con cuerpo. Desde la perspectiva del framework un content type ausente no es `application/json`, así que falla la misma verificación `415`. Establece siempre el encabezado explícitamente en lugar de confiar en un valor por defecto del cliente.

- **Los proxies inversos y los API gateways pueden reescribir o eliminar el encabezado.** Si la misma solicitud funciona contra Kestrel directamente pero devuelve `415` detrás de nginx, YARP o un API gateway, inspecciona qué `Content-Type` llega realmente a la app. Registra `HttpContext.Request.ContentType` al inicio del pipeline para ver el valor real en lugar del que crees que enviaste.

- **La inferencia de `[ApiController]` es un concepto de controllers, no de minimal API.** Si migraste desde controllers, recuerda que las minimal APIs infieren el enlace desde el cuerpo para tipos complejos de la misma manera, pero no hay un atributo `[Consumes]` que filtre media types a menos que agregues `Accepts`. Es la fuente de enlace, no un atributo, lo que controla el content type.

El modelo mental que hay que mantener: un `415` de minimal API es una discrepancia entre el `Content-Type` que envió el cliente y el lector de cuerpo que el endpoint espera. Decide qué debería aceptar el endpoint, cuerpo JSON, formulario, archivo o stream crudo, luego haz que el encabezado del cliente y el enlace del handler coincidan. Cuando coinciden, el `415` desaparece y vuelves al territorio normal de `400`/`200`.

## Relacionado

- [Cómo validar cuerpos de solicitud en minimal APIs sin controllers en ASP.NET Core 11](/es/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/) para el camino del `400` una vez que el content type es correcto.
- [Cómo personalizar las respuestas de error de validación de minimal API con IProblemDetailsService en ASP.NET Core 11](/es/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/) para dar forma al cuerpo de error que ve el cliente.
- [Cómo organizar endpoints de minimal API con MapGroup en ASP.NET Core 11](/es/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) para aplicar `Accepts` y filtros a través de un grupo de endpoints.
- [Minimal APIs vs controllers en ASP.NET Core 11](/es/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) para saber cómo difiere el manejo de content type entre los dos modelos.
- [Cómo configurar la autenticación JWT bearer en una minimal API en ASP.NET Core 11](/es/2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11/) para la capa de autenticación que se sitúa frente a estos endpoints.

## Fuentes

- Microsoft Learn, [Parameter binding in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/parameter-binding?view=aspnetcore-9.0) (tabla de fallas de enlace: un content type incorrecto en un parámetro de cuerpo devuelve 415; requisitos de `[FromForm]`, `IFormFile` y `multipart/form-data`; antiforgery en el enlace de formularios).
- Microsoft Learn, [Minimal APIs quick reference](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis?view=aspnetcore-9.0) (metadatos de `Accepts`, fuentes de enlace desde cuerpo vs formulario).
- MDN, [415 Unsupported Media Type](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/415) (la semántica HTTP: el servidor rechaza el media type de la carga de la solicitud).
