---
title: "Solución: [FromForm] Dictionary<string, string> siempre es null en una minimal API"
description: "Un Dictionary con [FromForm] en una minimal API se enlaza con prefijo vacío: las claves del formulario deben ser [key], no metadata[key]. Envuélvelo en una clase para conservar nombres legibles."
pubDate: 2026-08-20
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-apis"
lang: "es"
translationOf: "2026/08/fix-fromform-dictionary-is-always-null-in-a-minimal-api"
translatedBy: "claude"
translationDate: 2026-08-20
---

Un parámetro `[FromForm] Dictionary<string, string>` en una minimal API no usa el nombre del parámetro como prefijo de las claves del formulario. El mapeador de formularios empieza en la raíz del formulario, así que busca `[author]` y `[env]`, no `metadata[author]` ni `metadata.author`. Envía claves entre corchetes sin prefijo o, mejor todavía, envuelve el diccionario en una clase y envía `Metadata[author]` para que el formato en el cable siga siendo legible. No se registra nada ni se devuelve un `400` cuando las claves no coinciden: el parámetro simplemente llega como `null`.

Todo lo que sigue se midió en ASP.NET Core 10.0.5 con el SDK 10.0.201. El código de enlace relevante es idéntico en la rama `release/11.0`, así que el comportamiento se mantiene en .NET 11.

## El error en contexto

No hay ninguna excepción que buscar, y por eso mismo este problema quema una tarde entera. El handler se ejecuta, el archivo se enlaza y el diccionario es `null`:

```csharp
// .NET 10.0.201, ASP.NET Core 10.0.5
app.MapPost("/broken", ([FromForm] Dictionary<string, string> metadata, IFormFile file) =>
    Results.Text($"metadata={(metadata is null ? "null" : JsonSerializer.Serialize(metadata))}, file={file?.FileName}"))
   .DisableAntiforgery();
```

```bash
curl -X POST http://localhost:5222/broken \
  -F "metadata[author]=marius" -F "metadata[env]=prod" -F "file=@a.txt"
```

```text
metadata=null, file=a.txt
```

El mismo `null` vuelve con `metadata.author=marius`, con un simple `author=marius` y con una solicitud que omite las claves por completo. El código de estado es `200` en todos los casos.

Solo ves una excepción cuando las claves se acercan lo suficiente como para que el mapeador empiece a leerlas. Con un `Dictionary<string, int>` y un valor que no se puede parsear:

```text
Microsoft.AspNetCore.Http.BadHttpRequestException: The value 'notanint' is not valid for 'b'.
 ---> Microsoft.AspNetCore.Components.Endpoints.FormMapping.FormDataMappingException
   at Microsoft.AspNetCore.Components.Endpoints.FormMapping.DictionaryConverter`5.TryRead(...)
```

Ese stack trace es la pista. El tipo que hace el trabajo vive en `Microsoft.AspNetCore.Components.Endpoints.FormMapping`, la misma capa de mapeo de formularios que usa Blazor, y sus convenciones de claves no son las que aprendiste con MVC.

## Por qué ocurre

El enlace de formularios en minimal APIs tiene dos rutas de código completamente separadas, y cuál toma un parámetro lo decide un único predicado en `RequestDelegateFactory`:

```csharp
// dotnet/aspnetcore, src/Http/Http.Extensions/src/RequestDelegateFactory.cs, release/10.0
var useSimpleBinding = parameter.ParameterType == typeof(string) ||
    parameter.ParameterType == typeof(StringValues) ||
    parameter.ParameterType == typeof(StringValues?) ||
    ParameterBindingMethodCache.Instance.HasTryParseMethod(parameter.ParameterType) ||
    (parameter.ParameterType.IsArray && ParameterBindingMethodCache.Instance.HasTryParseMethod(parameter.ParameterType.GetElementType()!));
hasTryParse = useSimpleBinding;
return useSimpleBinding
    ? BindParameterFromFormItem(parameter, formAttribute.Name ?? parameter.Name, factoryContext)
    : BindComplexParameterFromFormItem(parameter, string.IsNullOrEmpty(formAttribute.Name) ? parameter.Name : formAttribute.Name, factoryContext);
```

El enlace simple lee `HttpContext.Request.Form[key]` donde `key` es el nombre del parámetro. Ese es el comportamiento que todo el mundo espera, y es el que obtienes para `string`, `int`, `Guid`, `DateOnly` y cualquier otro tipo con un `TryParse`.

`Dictionary<string, string>` no tiene `TryParse`, así que cae en `BindComplexParameterFromFormItem`, que entrega el formulario completo al mapeador compartido:

```csharp
// FormDataMapper.Map<Dictionary<string, string>>(name_reader, FormDataMapperOptions);
var invokeMapMethodExpr = Expression.Call(
    FormDataMapperMapMethod.MakeGenericMethod(parameter.ParameterType),
    formReader,
    Expression.Constant(formDataMapperOptions));
```

Mira los argumentos: el lector y las opciones. No hay prefijo. La `key` calculada en la línea anterior solo se usa como clave de diccionario en `factoryContext.TrackedParameters`, nunca se coloca en la pila de prefijos del lector. Por eso el mapeador lee el diccionario desde la raíz del formulario, y una entrada de diccionario en la raíz se escribe `[author]`.

Ese es todo el problema: el parámetro se llama `metadata`, pero al mapeador de formularios nunca le dijeron ese nombre.

Esto también explica por qué el comportamiento parece una regresión cuando mueves un endpoint desde controladores. El model binder de MVC prueba el nombre del parámetro como prefijo y luego cae al prefijo vacío, así que una acción de controlador acepta las dos formas:

```csharp
// .NET 10.0.201, controller action, both curl shapes below return the same result
[HttpPost("dict")]
public IActionResult Dict([FromForm] Dictionary<string, string> metadata, IFormFile file)
    => Content($"count={metadata?.Count}");
```

```text
curl -F "metadata[author]=marius" -F "file=@a.txt"   ->  count=1
curl -F "[author]=marius"         -F "file=@a.txt"   ->  count=1
```

Las minimal APIs solo aceptan la segunda. Si estás sopesando los dos modelos de hosting en general, [minimal APIs vs controladores en ASP.NET Core 11](/es/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) cubre los demás puntos en los que su semántica de enlace diverge.

## Repro mínima

Una aplicación completa, más las formas de solicitud que funcionan y las que no:

```csharp
// .NET 10.0.201, ASP.NET Core 10.0.5
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddAntiforgery();
var app = builder.Build();
app.UseAntiforgery();

app.MapPost("/dict", ([FromForm] Dictionary<string, string> metadata, IFormFile file) =>
    Results.Text($"metadata={(metadata is null ? "null" : JsonSerializer.Serialize(metadata))}, file={file?.FileName}"))
   .DisableAntiforgery();

app.MapPost("/list", ([FromForm] List<string> tags, IFormFile file) =>
    Results.Text($"tags={(tags is null ? "null" : JsonSerializer.Serialize(tags))}"))
   .DisableAntiforgery();

app.Run();
```

Resultados medidos contra esa aplicación:

| Solicitud | Resultado |
| --- | --- |
| `-F "metadata[author]=marius"` | `metadata=null` |
| `-F "metadata.author=marius"` | `metadata=null` |
| `-F "author=marius"` | `metadata=null` |
| `-F "[author]=marius" -F "[env]=prod"` | `metadata={"author":"marius","env":"prod"}` |
| `-F "tags=a" -F "tags=b"` | `tags=null` |
| `-F "tags[0]=a" -F "tags[1]=b"` | `tags=null` |
| `-F "[0]=a" -F "[1]=b"` | `tags=["a","b"]` |

El patrón es consistente: un parámetro de colección `[FromForm]` de nivel superior se direcciona con prefijo vacío, así que los diccionarios usan `[key]` y las listas usan `[0]`, `[1]`, y así sucesivamente. El nombre del parámetro es peso muerto.

## La solución, en detalle

Cuatro opciones, en el orden en que yo las tomaría.

### 1. Envuelve el diccionario en una clase

Esta es la solución que vale la pena llevar a producción. Una propiedad de una clase sí obtiene prefijo, porque el mapeador coloca el nombre de la propiedad en su pila de prefijos mientras desciende, así que el formato en el cable vuelve a ser algo que una persona puede leer y que una librería cliente puede generar.

```csharp
// .NET 10.0.201, ASP.NET Core 10.0.5
app.MapPost("/upload", ([FromForm] UploadRequest request, IFormFile file) =>
    Results.Text($"request={JsonSerializer.Serialize(request)}, file={file?.FileName}"))
   .DisableAntiforgery();

public class UploadRequest
{
    public Dictionary<string, string> Metadata { get; set; } = new();
}
```

```bash
curl -X POST http://localhost:5222/upload \
  -F "Metadata[author]=marius" -F "Metadata[env]=prod" -F "file=@a.txt"
```

```text
request={"Metadata":{"author":"marius","env":"prod"}}, file=a.txt
```

La coincidencia de claves no distingue mayúsculas de minúsculas, así que `metadata[author]` también se enlaza a la propiedad `Metadata`. El diccionario anidado puede estar incluso más profundo: `Meta.Tags[a]=1` se enlaza bien si `Meta` es a su vez una propiedad.

Puedes meter el archivo en la misma clase, lo que deja la firma del endpoint en un solo parámetro:

```csharp
// .NET 10.0.201, ASP.NET Core 10.0.5
app.MapPost("/upload", ([FromForm] UploadWithFile request) =>
    Results.Text($"metadata={JsonSerializer.Serialize(request.Metadata)}, file={request.File?.FileName}"))
   .DisableAntiforgery();

public class UploadWithFile
{
    public Dictionary<string, string> Metadata { get; set; } = new();
    public IFormFile? File { get; set; }
}
```

Enviar `-F "Metadata[author]=marius" -F "File=@a.txt"` enlaza ambos. La propiedad del archivo se empareja por nombre de propiedad, la misma regla que aplica a un parámetro `IFormFile` de nivel superior.

### 2. Conserva el parámetro diccionario y arregla el cliente

Si el cliente es tuyo y la firma del endpoint está fija, envía simplemente claves entre corchetes en la raíz:

```bash
curl -X POST http://localhost:5222/dict \
  -F "[author]=marius" -F "[env]=prod" -F "file=@a.txt"
```

Funciona, y es un carácter de cambio por clave. También es la forma que nadie va a adivinar cuando lea el handler dentro de seis meses, y no sobrevive a un segundo parámetro diccionario (mira las trampas más abajo). Tómalo como un parche temporal.

### 3. Lee el formulario tú mismo

La opción más explícita, y la única que sobrevive al Request Delegate Generator. `IFormCollection` se enlaza como parámetro de formulario completo sin ninguna capa de mapeo de por medio, así que la convención de claves es tuya:

```csharp
// .NET 10.0.201, ASP.NET Core 10.0.5
app.MapPost("/upload", (IFormCollection form) =>
{
    var metadata = form
        .Where(kv => kv.Key.StartsWith("metadata[", StringComparison.Ordinal) && kv.Key.EndsWith(']'))
        .ToDictionary(kv => kv.Key[9..^1], kv => kv.Value.ToString());

    return Results.Text($"metadata={JsonSerializer.Serialize(metadata)}, files={form.Files.Count}");
}).DisableAntiforgery();
```

```text
metadata={"author":"marius","env":"prod"}, files=1
```

Es verboso, pero acepta `metadata[author]` directamente y te da una ruta de error real cuando una clave está mal formada, en lugar de un `null` silencioso.

### 4. Envía los metadatos como un único campo JSON

Si los metadatos son realmente abiertos, deja de modelarlos como claves de formulario. Un único campo de formulario que contenga un documento JSON se enlaza por la ruta simple, porque `string` cortocircuita el predicado de arriba:

```csharp
// .NET 10.0.201, ASP.NET Core 10.0.5
app.MapPost("/upload", ([FromForm] string metadata, IFormFile file) =>
{
    var parsed = JsonSerializer.Deserialize<Dictionary<string, string>>(metadata);
    return Results.Text($"metadata={JsonSerializer.Serialize(parsed)}, file={file?.FileName}");
}).DisableAntiforgery();
```

```bash
curl -X POST http://localhost:5222/upload \
  -F 'metadata={"author":"marius","env":"prod"}' -F "file=@a.txt"
```

Es la única opción que te da valores anidados, arreglos y tipos que no son cadenas sin pelear con la sintaxis de claves, y funciona igual bajo AOT.

## Trampas y variantes

- **`null` no es un fallo de validación.** El tipo del parámetro es `Dictionary<string, string>` no anulable y el handler igualmente recibe `null`, con una respuesta `200` y nada en los logs. El mapeador devuelve `default(T)` cuando no encuentra ninguna clave que coincida, y un parámetro complejo enlazado desde formulario nunca se trata como obligatorio. Comprueba el `null`, o haz el parámetro anulable para que el compilador te lo recuerde. Un inicializador de propiedad como `= new()` tampoco te salva: el propio objeto envoltorio vuelve como `null` cuando ninguna clave coincide con su prefijo.

- **`[FromForm(Name = "metadata")]` no establece el prefijo.** Parece la solución y no lo es. El nombre se usa para buscar parámetros rastreados y luego se descarta antes de que corra el mapeador. `[FromForm(Name = "metadata")] Dictionary<string, string> metadata` se sigue enlazando desde `[author]`, no desde `metadata[author]`.

- **Dos parámetros complejos de formulario chocan.** Como ambos se enlazan con prefijo vacío, leen las mismas claves. Un endpoint que recibe `[FromForm] Dictionary<string, string> first, [FromForm] Dictionary<string, string> second` con `[a]=1&[b]=2` devuelve `first={"a":"1","b":"2"} second={"a":"1","b":"2"}`. No hay ninguna advertencia. Solo por esto ya conviene preferir la clase envoltorio.

- **Los arreglos y las listas se comportan distinto entre sí.** `List<string> tags` es un tipo complejo y necesita `[0]`, `[1]`. `int[] ids` tiene un tipo de elemento con `TryParse`, así que toma la ruta simple y se enlaza desde `ids=1&ids=2` repetido. Y `[FromForm] string[] tags` falla al arrancar en .NET 10 con `InvalidOperationException: TryParse method found on string with incorrect format`, porque `string` ahora expone un `TryParse` basado en spans que la caché de métodos de enlace rechaza en vez de ignorar. Ese es [dotnet/aspnetcore#62326](https://github.com/dotnet/aspnetcore/issues/62326), corregido por el [PR #63072](https://github.com/dotnet/aspnetcore/pull/63072); el commit de merge es ancestro de todas las etiquetas `v11.0.0-preview` y de ninguna de `v10.0.0` ni `v10.0.5`, así que el fallo te acompaña durante todo el ciclo de vida de .NET 10.

- **Dos límites distintos con el mismo valor por defecto de 1024.** Envía 1025 claves y obtienes `InvalidDataException: Form value count limit 1024 exceeded` desde `FormPipeReader`, que es `FormOptions.ValueCountLimit`. Súbelo con `services.Configure<FormOptions>(o => o.ValueCountLimit = 5000)` y chocas con el siguiente muro: `The number of elements in the dictionary exceeded the maximum number of '1024' elements allowed`, que es el tope propio del mapeador. Ese es por endpoint: `.WithFormMappingOptions(maxCollectionSize: 5000)`. Necesitas los dos, y subir solo uno parece que la solución no hizo nada. Si tus cargas son grandes en bytes en vez de en número de claves, [413 Request Entity Too Large al subir un archivo](/es/2026/07/fix-413-request-entity-too-large-uploading-a-file-in-aspnetcore-11/) cubre los límites por tamaño.

- **El enlace de formularios exige configurar antiforgery.** Cualquier endpoint de minimal API con un parámetro enlazado desde formulario lleva metadatos de antiforgery. Si la aplicación nunca llama a `app.UseAntiforgery()`, la solicitud falla con `InvalidOperationException: Endpoint HTTP: POST /upload contains anti-forgery metadata, but a middleware was not found that supports anti-forgery` y un `500`. Agrega el middleware, o llama a `.DisableAntiforgery()` en endpoints máquina a máquina. No lo desactives de forma general en endpoints a los que envía un navegador.

- **El Request Delegate Generator rechaza todo esto.** Compila con `EnableRequestDelegateGenerator` en `true`, o con `PublishAot`, y tanto el parámetro diccionario como la clase envoltorio producen `warning RDG003: Unable to statically resolve parameter named 'metadata' for endpoint`. El endpoint cae a generación en tiempo de ejecución, que es justo lo que AOT no puede hacer. `IFormCollection` no produce advertencia, así que la opción 3 es la forma segura para AOT. Mira [cómo usar Native AOT con minimal APIs de ASP.NET Core](/es/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) para el resto de diagnósticos de RDG.

- **Un `Content-Type` incorrecto parece el mismo problema.** Si la solicitud llega como `application/json` en vez de `multipart/form-data` o `application/x-www-form-urlencoded`, obtienes un `415` en lugar de un `null` silencioso. Ese es otro fallo con otra solución, cubierto en [415 Unsupported Media Type desde un endpoint de minimal API](/es/2026/07/fix-415-unsupported-media-type-from-a-minimal-api-endpoint-in-aspnetcore-11/).

La regla que hay que recordar es corta: en una minimal API, un parámetro `[FromForm]` se direcciona por nombre solo si su tipo se puede parsear desde una única cadena. Todo lo demás pasa por el mapeador de formularios de Blazor, que empieza en la raíz del formulario y no sabe cómo se llama tu parámetro. Dale una clase por la que descender y los nombres vuelven.

## Relacionados

- [Solución: "415 Unsupported Media Type" desde un endpoint de minimal API en ASP.NET Core 11](/es/2026/07/fix-415-unsupported-media-type-from-a-minimal-api-endpoint-in-aspnetcore-11/) para cuando el formulario ni siquiera llega al binder.
- [Solución: "413 Request Entity Too Large" al subir un archivo a un endpoint de ASP.NET Core](/es/2026/07/fix-413-request-entity-too-large-uploading-a-file-in-aspnetcore-11/) para los límites de tamaño en bytes que se aplican antes del parseo del formulario.
- [Cómo usar Native AOT con minimal APIs de ASP.NET Core](/es/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) para saber qué puede y qué no puede enlazar el Request Delegate Generator.
- [Minimal APIs vs controladores en ASP.NET Core 11](/es/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) para el conjunto más amplio de diferencias de enlace entre los dos modelos.
- [Cómo subir un archivo grande con streaming a Azure Blob Storage](/es/2026/04/how-to-upload-a-large-file-with-streaming-to-azure-blob-storage/) para dejar atrás el buffering de `IFormFile` cuando las cargas crecen.

## Fuentes

- Microsoft Learn, [Parameter binding in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/parameter-binding?view=aspnetcore-10.0) (enlace de formularios a colecciones y tipos complejos, la tabla de colecciones `IFormFile`, y la nota de que el enlace de formularios a tipos complejos y colecciones no está soportado bajo el Request Delegate Generator).
- dotnet/aspnetcore, [RequestDelegateFactory.cs](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Http/Http.Extensions/src/RequestDelegateFactory.cs) (el predicado `useSimpleBinding` y `BindComplexParameterFromFormItem`, que llama a `FormDataMapper.Map<T>` sin prefijo).
- Issue [#62326](https://github.com/dotnet/aspnetcore/issues/62326) y PR [#63072](https://github.com/dotnet/aspnetcore/pull/63072) de dotnet/aspnetcore (`[FromForm] string[]` fallando al arrancar, y la corrección de enlace simple que llegó en .NET 11).
- Microsoft Learn, [RDG003: Unable to statically resolve parameter](https://learn.microsoft.com/aspnet/core/fundamentals/aot/request-delegate-generator/diagnostics/RDG003) (el diagnóstico en tiempo de compilación para parámetros mapeados desde formulario bajo AOT).
