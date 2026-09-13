---
title: "Cómo enlazar un objeto complejo de la query string con [AsParameters] en una minimal API de ASP.NET Core 11"
description: "Pon [AsParameters] en una clase o un record para enlazar un filtro completo de la query string en una minimal API de ASP.NET Core 11. Cubre valores predeterminados, arrays, enums, objetos anidados, validación, OpenAPI y un bug del generador de Native AOT con records posicionales."
pubDate: 2026-09-13
template: how-to
tags:
  - "aspnetcore"
  - "minimal-apis"
  - "dotnet-11"
  - "csharp"
  - "how-to"
lang: "es"
translationOf: "2026/09/how-to-bind-a-complex-query-string-object-with-asparameters-in-a-minimal-api"
translatedBy: "claude"
translationDate: 2026-09-13
---

**Respuesta corta:** declara las claves de la query string como propiedades de una clase (o como parámetros del constructor de un record) y pon `[AsParameters]` en el parámetro del handler: `app.MapGet("/products", ([AsParameters] ProductFilter filter) => ...)`. ASP.NET Core aplana el tipo en parámetros individuales, así que `?search=lamp&page=2&tags=a&tags=b` se enlaza a `Search`, `Page` y `Tags` por nombre, sin distinguir mayúsculas de minúsculas. Solo maneja tipos planos: un objeto anidado necesita su propio `TryParse` o `BindAsync`, y un valor opcional debe ser anulable o tener un valor predeterminado en el constructor, porque un inicializador de propiedad como `= 1` no hace que una propiedad sea opcional.

Todo lo que sigue se ejecutó en .NET 11 RC 1 (SDK `11.0.100-rc.1.26425.128`, ASP.NET Core `11.0.0-rc.1.26425.128`). `[AsParameters]` llegó en .NET 7 y sus reglas no han cambiado desde entonces, así que el mismo código funciona en .NET 8, 9 y 10. La única excepción que vale la pena conocer, un bug del generador de código fuente en la ruta de Native AOT, también se reproduce en el SDK 10.0.302.

## Por qué `[FromQuery] ProductFilter` no funciona

Si vienes de los controladores de MVC, el reflejo es escribir `[FromQuery] ProductFilter filter`. En una minimal API de .NET 11 eso ni siquiera compila. El analizador [ASP0020](https://learn.microsoft.com/aspnet/core/diagnostics/asp0020) lo reporta como error de compilación:

```text
error ASP0020: Parameter 'f' of type ProductFilter should define a bool
TryParse(string, IFormatProvider, out ProductFilter) method, or implement IParsable<ProductFilter>
```

Si suprimes el analizador, la aplicación falla en el arranque, cuando se construye el endpoint:

```text
InvalidOperationException: f must have a valid TryParse method to support converting from a string.
No public static bool ProductFilter.TryParse(string, out ProductFilter) method found for f.
```

Si quitas el atributo, todo se vuelve más confuso. Un tipo complejo sin origen de enlace se infiere como el cuerpo de la solicitud, y `MapGet` rechaza los cuerpos inferidos:

```text
InvalidOperationException: Body was inferred but the method does not allow inferred body parameters.
```

Esto es así por diseño. Las minimal APIs omiten el model binder recursivo de MVC, y `[FromQuery]` significa "una clave de la query string, convertida con `TryParse`". La [documentación de enlace de parámetros](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/parameter-binding) dice que `AsParametersAttribute` "habilita el enlace simple de parámetros a tipos, no el model binding complejo o recursivo". Lo que hace es aplanar: la fábrica de request delegates trata cada miembro del tipo como un parámetro independiente del handler y luego aplica a cada miembro las reglas normales (ruta, query string, encabezado, servicios, tipos especiales). Ese modelo mental explica cada comportamiento del resto de este artículo.

## Enlazar un filtro de la query string paso a paso

1. Crea un tipo con un miembro por cada clave de la query string.
2. Haz anulable cada miembro opcional, o dale un valor predeterminado en un parámetro del constructor de un record.
3. Pon `[AsParameters]` en el parámetro del handler.
4. Renombra miembros individuales o cambia su origen con `[FromQuery(Name = ...)]`, `[FromRoute]` o `[FromHeader]`.
5. Agrega DataAnnotations y llama a `AddValidation()` si necesitas comprobaciones de rango.

Este es el filtro que usé:

```csharp
// ASP.NET Core 11 (.NET 11 RC 1), C# 15, <Nullable>enable</Nullable>
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapGet("/products", ([AsParameters] ProductFilter f) => f);

app.Run();

enum SortOrder { Asc, Desc }

class ProductFilter
{
    public string? Search { get; set; }
    public int? Page { get; set; }
    public int? PageSize { get; set; }
    public SortOrder? Sort { get; set; }
    public DateOnly? Since { get; set; }
    public string[] Tags { get; set; } = [];
    [FromQuery(Name = "q")] public string? Keyword { get; set; }
}
```

Y las respuestas reales:

```text
GET /products?search=lamp&page=2&pageSize=10&sort=Desc&since=2026-01-31&tags=a&tags=b&q=kw
200 {"search":"lamp","page":2,"pageSize":10,"sort":1,"since":"2026-01-31","tags":["a","b"],"keyword":"kw"}

GET /products?SEARCH=lamp&PAGE=3
200 {"search":"lamp","page":3,"pageSize":null,"sort":null,"since":null,"tags":[],"keyword":null}

GET /products
200 {"search":null,"page":null,"pageSize":null,"sort":null,"since":null,"tags":[],"keyword":null}
```

La clave de la query string es el nombre del miembro, comparado sin distinguir mayúsculas de minúsculas, y `[FromQuery(Name = "q")]` la sobrescribe para un miembro. Las claves repetidas llenan un array. `DateOnly` interpreta una cadena ISO `yyyy-MM-dd`. Cualquier tipo de miembro con un `TryParse` estático (todos los primitivos, `Guid`, `DateTimeOffset`, los enums y tus propios tipos `IParsable<T>`) se enlaza desde una sola clave.

## Requerido vs opcional: la trampa del inicializador de propiedad

Este es el error que veo con más frecuencia. Parece una clase con valores predeterminados razonables:

```csharp
// ASP.NET Core 11 (.NET 11 RC 1)
class RequiredFilter
{
    public int Page { get; set; } = 1;
    public bool InStock { get; set; }
    public string Search { get; set; } = "";
}
```

`GET /required` sin query string devuelve `400`:

```text
BadHttpRequestException: Required parameter "int Page" was not provided from query string.
```

La fábrica decide si un miembro es opcional a partir de su nulabilidad y, en el caso de los parámetros del constructor, de un valor predeterminado declarado. Un inicializador de propiedad es solo código dentro del constructor, invisible para la reflexión, así que una propiedad `int`, `bool` o `string` no anulable es requerida sin importar lo que le asignes. El documento OpenAPI generado coincide y marca las tres como `required: true`.

Hay dos soluciones. Haz anulables los miembros y aplica el valor predeterminado en el handler (`f.Page ?? 1`), o cambia a un record posicional, donde los valores predeterminados del constructor sí cuentan:

```csharp
// ASP.NET Core 11 (.NET 11 RC 1)
record ProductQuery(string? Search, int Page = 1, int PageSize = 20,
    SortOrder Sort = SortOrder.Asc, string[]? Tags = null);

app.MapGet("/products-record", ([AsParameters] ProductQuery q) => q);
```

```text
GET /products-record         -> {"search":null,"page":1,"pageSize":20,"sort":0,"tags":[]}
GET /products-record?page=4  -> {"search":null,"page":4,"pageSize":20,"sort":0,"tags":[]}
```

Fíjate en que `Tags` volvió como `[]`, no como `null`, a pesar del valor predeterminado `= null`: un array sin claves coincidentes se enlaza como un array vacío. Un `record struct PagingStruct(int Page = 1, int PageSize = 20)` se comporta igual y devolvió `{"page":1,"pageSize":20}`. La documentación señala que un `struct` "puede tener mejor rendimiento" que una clase `record` porque evita una asignación de memoria por solicitud; no lo medí, así que tómalo como una afirmación de la documentación.

Vale la pena saber cómo elige la fábrica los miembros. La lógica de [`PropertyAsParameterInfo.cs`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.1.26425.128/src/Shared/PropertyAsParameterInfo.cs) es esta: si el tipo tiene un único constructor público con parámetros, enlaza sus parámetros (asociados a las propiedades por nombre). Si no, usa el constructor sin parámetros y enlaza cada propiedad **escribible**. Una propiedad de solo lectura en una clase sin ese constructor se omite sin avisar. Dos constructores públicos con parámetros fallan con `Only a single public parameterized constructor is allowed for type 'TwoCtors'.`, y un tipo abstracto falla con `The abstract type 'AbstractFilter' is not supported.`

## Combinar valores de ruta, encabezados y servicios en el mismo tipo

Como cada miembro pasa por las reglas normales de enlace, un solo tipo `[AsParameters]` puede reunir toda la lista de argumentos, no solo la query string:

```csharp
// ASP.NET Core 11 (.NET 11 RC 1)
app.MapGet("/tenants/{tenantId:int}/orders", ([AsParameters] OrderRequest r) => new
{
    r.TenantId, r.Region, r.Status, r.Ids, r.UserAgent,
    Logger = r.Logger.GetType().Name,
    Path = r.Http.Request.Path.Value,
    CanCancel = r.Ct.CanBeCanceled
});

enum OrderStatus { Pending, Shipped, Cancelled }

class OrderRequest
{
    [FromRoute(Name = "tenantId")] public int TenantId { get; set; }
    [FromHeader(Name = "X-Region")] public string? Region { get; set; }
    public OrderStatus? Status { get; set; }
    public int[] Ids { get; set; } = [];
    [FromHeader(Name = "User-Agent")] public string? UserAgent { get; set; }
    public ILogger<OrderRequest> Logger { get; set; } = default!;   // from DI
    public HttpContext Http { get; set; } = default!;              // special type
    public CancellationToken Ct { get; set; }                      // RequestAborted
}
```

```text
GET /tenants/42/orders?status=Shipped&ids=1&ids=2   (X-Region: eu-west)
200 {"tenantId":42,"region":"eu-west","status":1,"ids":[1,2],"userAgent":"curl/8.7.1",
     "logger":"Logger`1","path":"/tenants/42/orders","canCancel":true}
```

Este es el caso de uso con el que abre el propio ejemplo de Microsoft: condensar una firma de handler larga (`int id, TodoDb db, ...`) en un solo tipo. Combina bien con [agrupar endpoints con `MapGroup`](/es/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/), donde el prefijo de ruta ya lleva un valor `{tenantId}`.

## Valores inválidos, enums que distinguen mayúsculas y listas separadas por comas

Un valor que falla en `TryParse` produce un `400` antes de que se ejecute tu handler:

```text
GET /products?page=abc    -> 400 Failed to bind parameter "Nullable<int> Page" from "abc".
GET /products?sort=Desc   -> 200
GET /products?sort=desc   -> 400 Failed to bind parameter "Nullable<SortOrder> Sort" from "desc".
```

El resultado del enum sorprende a la gente: el enlace usa la sobrecarga de `Enum.TryParse` que distingue mayúsculas de minúsculas, así que `desc` se rechaza mientras que `Desc` funciona. Si tus clientes envían valores en minúsculas, enlaza un `string?` y llama tú mismo a `Enum.TryParse<SortOrder>(value, ignoreCase: true, out var sort)`, o envuelve el enum en un tipo pequeño con su propio `TryParse`.

En Development, la página de excepciones para desarrolladores muestra el texto de `BadHttpRequestException` de arriba. Fuera de Development, el cliente recibe un `400` sin más y el motivo solo va al registro de depuración, así que no te apoyes en ese mensaje como contrato de tu API.

Las listas separadas por comas no se dividen:

```text
GET /products?tags=a,b              -> 200 "tags":["a,b"]   (one element)
GET /tenants/42/orders?ids=1,2      -> 400 Failed to bind parameter "int[] Ids" from "1,2".
```

Los arrays solo se enlazan desde claves repetidas (`?ids=1&ids=2`). Si tienes que aceptar `ids=1,2`, enlaza un `string?` y divídelo, o dale a un tipo personalizado un `TryParse` que haga la división.

## Los objetos anidados necesitan su propio parser

Esta es la forma que la gente realmente quiere enlazar:

```csharp
class Money { public decimal Min { get; set; } public decimal Max { get; set; } }
class NestedFilter { public string? Q { get; set; } public Money? Price { get; set; } }
```

`Price` es un tipo complejo sin origen de enlace, así que la fábrica lo infiere como el cuerpo, y en un `GET` el endpoint falla en el arranque con el mismo error `Body was inferred but the method does not allow inferred body parameters.` de antes. Las claves al estilo `?price.min=10`, que el model binder de MVC entiende, aquí no significan nada. Poner `[AsParameters]` en un miembro anidado tampoco ayuda. Lanza `NotSupportedException: Nested AsParametersAttribute is not supported and should be used only for handler parameters.`

Tienes tres opciones, en el orden en que yo recurriría a ellas.

**Aplánalo.** `decimal? MinPrice` y `decimal? MaxPrice` es aburrido, produce la mejor salida de OpenAPI y no requiere código.

**Interpreta una clave con `IParsable<T>`.** Un miembro cuyo tipo tiene un `TryParse` estático se enlaza desde una sola clave:

```csharp
// ASP.NET Core 11 (.NET 11 RC 1), C# 15
using System.Diagnostics.CodeAnalysis;
using System.Globalization;

record PriceRange(decimal Min, decimal Max) : IParsable<PriceRange>
{
    public static bool TryParse(string? s, IFormatProvider? provider,
        [MaybeNullWhen(false)] out PriceRange result)
    {
        result = null;
        if (s?.Split('-', 2) is not [var lo, var hi]) return false;
        if (!decimal.TryParse(lo, NumberStyles.Number, CultureInfo.InvariantCulture, out var min)) return false;
        if (!decimal.TryParse(hi, NumberStyles.Number, CultureInfo.InvariantCulture, out var max)) return false;
        if (min > max) return false;
        result = new PriceRange(min, max);
        return true;
    }

    public static PriceRange Parse(string s, IFormatProvider? provider) =>
        TryParse(s, provider, out var r) ? r : throw new FormatException($"'{s}' is not a price range.");
}
```

`?price=10-50` se enlaza a `{"min":10,"max":50}`, y `?price=50-10` devuelve `400 Failed to bind parameter "PriceRange Price" from "50-10".`

**Lee claves con punto usando `BindAsync`.** Si el formato de transmisión está fijado en `budget.min=5&budget.max=99`, implementa `BindAsync(HttpContext, ParameterInfo)`. Dentro de un tipo `[AsParameters]`, `parameter.Name` es el nombre de la propiedad, así que el prefijo viene gratis:

```csharp
// ASP.NET Core 11 (.NET 11 RC 1)
using System.Globalization;
using System.Reflection;

record DottedRange(decimal? Min, decimal? Max)
{
    public static ValueTask<DottedRange?> BindAsync(HttpContext context, ParameterInfo parameter)
    {
        var q = context.Request.Query;
        decimal? Read(string key) => decimal.TryParse(q[$"{parameter.Name}.{key}"],
            NumberStyles.Number, CultureInfo.InvariantCulture, out var v) ? v : null;
        var (min, max) = (Read("min"), Read("max"));
        return ValueTask.FromResult(min is null && max is null ? null : new DottedRange(min, max));
    }
}

class RangeFilter
{
    public PriceRange? Price { get; set; }
    public DottedRange? Budget { get; set; }
    public string? Q { get; set; }
}
```

```text
GET /by-range?price=10-50&budget.min=5&budget.max=99&q=chair
200 {"price":{"min":10,"max":50},"budget":{"min":5,"max":99},"q":"chair"}
```

El costo de `BindAsync` es la documentación: el generador de OpenAPI integrado listó `Price` (como string) y `Q` para este endpoint y dejó `Budget` completamente fuera. Si necesitas que aparezca documentado, agrégalo con un [operation transformer](/es/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/).

Una restricción más: el propio parámetro `[AsParameters]` no puede ser anulable. `[AsParameters] ProductFilter? f` falla con `The nullable type 'ProductFilter' is not supported, mark the parameter as non-nullable.`

## Validación y salida de OpenAPI

La validación integrada de las minimal APIs entiende los miembros de `[AsParameters]`, incluidos los parámetros del constructor de un record. Con `builder.Services.AddValidation()` registrado (la misma configuración que para [validar cuerpos de solicitud](/es/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/)):

```csharp
// ASP.NET Core 11 (.NET 11 RC 1)
using System.ComponentModel.DataAnnotations;

record ValidatedPaging([Range(1, 1000)] int Page = 1, [Range(1, 100)] int PageSize = 20);

app.MapGet("/validated", ([AsParameters] ValidatedPaging p) => p);
```

```text
GET /validated?pageSize=500
400 {"title":"One or more validation errors occurred.","status":400,
     "errors":{"PageSize":["The field PageSize must be between 1 and 100."]}}
```

`Microsoft.AspNetCore.OpenApi` 11.0.0-rc.1 convierte ese mismo tipo en parámetros de query string con `minimum`, `maximum` y `default`. En .NET 10, esta combinación exacta (un atributo de validación en un parámetro del constructor primario de un record `[AsParameters]`) hacía que la generación del documento lanzara `InvalidCastException`; era [dotnet/aspnetcore#65348](https://github.com/dotnet/aspnetcore/issues/65348), corregido para .NET 11 en el [PR #67284](https://github.com/dotnet/aspnetcore/pull/67284). Si sigues en .NET 10, pon los atributos en una clase con propiedades. Esto también muestra la trampa de los arrays de antes desde el otro lado. Un `string[] Tags { get; set; } = []` no anulable se documenta como `required: true`, aunque el runtime enlaza sin problema una clave ausente como un array vacío, así que los clientes generados insistirán en enviarlo. Declara los arrays opcionales como `string[]?` y el documento los marcará como opcionales.

## Native AOT: los records posicionales con tipos de referencia anulables no compilan

Con `<PublishAot>true</PublishAot>`, la compilación activa el [Request Delegate Generator](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/aot/request-delegate-generator/rdg), que reemplaza la fábrica en tiempo de ejecución con código generado (la pila que se cubre en [Native AOT con minimal APIs](/es/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/)). Allí, la mayoría de los errores de arranque de arriba se convierten en advertencias de compilación: `RDG009` para `[AsParameters]` anidado, `RDG010` para un parámetro anulable, `RDG005` para un tipo abstracto y `RDG008` para varios constructores. Eso es una mejora.

También tiene un bug. Este endpoint:

```csharp
// .NET 11 RC 1 and SDK 10.0.302, <PublishAot>true</PublishAot> or <EnableRequestDelegateGenerator>true</EnableRequestDelegateGenerator>
app.MapGet("/a", ([AsParameters] F f) => f.Page?.ToString() ?? "none");

record F(string? Q, int? Page);
```

no compila y produce cuatro copias de:

```text
GeneratedRouteBuilderExtensions.g.cs: error CS8639: The typeof operator cannot be used on a nullable reference type
```

El generador localiza el constructor del record emitiendo `typeof(F).GetConstructor(new[] { typeof(string?), typeof(int?) })`, y `typeof(string?)` no es C# válido. `int?` no da problemas porque es `Nullable<int>`. Compilé seis variantes del mismo endpoint con el generador activado:

| Tipo `[AsParameters]` | ¿Compila? |
| --- | --- |
| `record F(string? Q, int? Page)` | No, CS8639 |
| `record F(string[]? Tags, int? Page)` | No, CS8639 |
| `record F(string Q = "", int? Page = null)` | Sí |
| `record struct F(string? Q, int? Page)` | Sí |
| `record F { public string? Q { get; init; } ... }` | Sí |
| El mismo record posicional, generador desactivado (compilación JIT normal) | Sí |

Así que el detonante es una clase `record` posicional cuyo constructor tiene un parámetro de tipo de referencia anulable. La compilación JIT normal funciona bien, y por eso esto suele aparecer solo cuando alguien activa `PublishAot` (la documentación dice que el trimming también activa el generador). Hasta que se corrija, usa una clase con propiedades con setter, un record con propiedades `init` o un `record struct` posicional para los tipos `[AsParameters]` en proyectos AOT. No encontré un issue que lo rastree en dotnet/aspnetcore al momento de escribir esto.

## Qué leer después

- [Minimal APIs vs controladores en ASP.NET Core 11](/es/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/), incluido dónde el model binder de MVC todavía gana.
- [Uniones de C# en ASP.NET Core 11](/es/2026/09/csharp-unions-in-aspnetcore-11-where-binding-works/), otro caso en el que la query string es el único origen de enlace que no coopera.
- [Paginación por keyset (cursor) en EF Core 11](/es/2026/06/how-to-do-keyset-cursor-pagination-in-ef-core-11/), un consumidor natural del filtro de paginación construido aquí.
- [Por qué un diccionario `[FromForm]` siempre es null en una minimal API](/es/2026/08/fix-fromform-dictionary-is-always-null-in-a-minimal-api/), el primo del problema de los objetos anidados en el enlace de formularios.

## Fuentes

- Microsoft Learn, [Parameter binding in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/parameter-binding) (la sección de `[AsParameters]` y la lista de precedencia de orígenes de enlace).
- Microsoft Learn, [referencia de la API `AsParametersAttribute`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.asparametersattribute).
- Microsoft Learn, [ASP0020: Complex types referenced by route parameters must be parsable](https://learn.microsoft.com/aspnet/core/diagnostics/asp0020).
- Microsoft Learn, [diagnósticos del Request Delegate Generator RDG009](https://learn.microsoft.com/aspnet/core/fundamentals/aot/request-delegate-generator/diagnostics/RDG009) y [RDG010](https://learn.microsoft.com/aspnet/core/fundamentals/aot/request-delegate-generator/diagnostics/RDG010).
- dotnet/aspnetcore en `v11.0.0-rc.1.26425.128`: [`PropertyAsParameterInfo.cs`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.1.26425.128/src/Shared/PropertyAsParameterInfo.cs) (aplanado de miembros, comprobación de anulabilidad) y [`RequestDelegateFactory.cs`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.1.26425.128/src/Http/Http.Extensions/src/RequestDelegateFactory.cs) (comprobación de `[AsParameters]` anidado).
