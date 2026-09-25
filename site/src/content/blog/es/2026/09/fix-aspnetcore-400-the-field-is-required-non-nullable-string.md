---
title: "Solución: ASP.NET Core devuelve 400 \"The X field is required\" para una propiedad string no anulable"
description: "Con <Nullable>enable</Nullable>, MVC trata cada tipo de referencia no anulable como [Required(AllowEmptyStrings = true)]. Marca las propiedades opcionales como string?, dales un valor predeterminado o activa SuppressImplicitRequiredAttributeForNonNullableReferenceTypes."
pubDate: 2026-09-25
template: error-page
tags:
  - "errors"
  - "aspnetcore"
  - "dotnet-10"
  - "validation"
  - "nullable-reference-types"
lang: "es"
translationOf: "2026/09/fix-aspnetcore-400-the-field-is-required-non-nullable-string"
translatedBy: "claude"
translationDate: 2026-09-25
---

Un `400 Bad Request` con `"The Name field is required."` en una propiedad que nunca marcaste con `[Required]` proviene de la regla implícita de obligatoriedad de MVC: cuando el proyecto tiene `<Nullable>enable</Nullable>`, cada tipo de referencia no anulable en un modelo enlazado o en un parámetro de acción se valida como si tuviera `[Required(AllowEmptyStrings = true)]`. Si el valor es realmente opcional, decláralo como `string?`. Si quieres el comportamiento anterior en todas partes, establece `options.SuppressImplicitRequiredAttributeForNonNullableReferenceTypes = true` en `AddControllers`. Si de verdad es obligatorio, conserva el error y personalízalo con un `[Required]` explícito.

Cada resultado de abajo se reprodujo en ASP.NET Core 10.0.10 (SDK 10.0.302) con un único proyecto `dotnet new web` que aloja tanto controladores como endpoints de minimal API. La regla en sí existe desde ASP.NET Core 3.0, así que la explicación aplica a todas las versiones desde la 3.0 hasta .NET 11.

## El error en contexto

El cliente envía un cuerpo JSON que omite una propiedad, o la envía como `null`, y recibe el cuerpo estándar `ValidationProblemDetails` antes de que se ejecute tu acción:

```json
{
  "type": "https://tools.ietf.org/html/rfc9110#section-15.5.1",
  "title": "One or more validation errors occurred.",
  "status": 400,
  "errors": {
    "Name": ["The Name field is required."]
  },
  "traceId": "00-41532a7ee5071512e476fa1aa31447c3-141fcd7662d71a76-00"
}
```

El mismo mensaje aparece para parámetros de la cadena de consulta (`"q": ["The q field is required."]`), campos de formulario y, con mucha frecuencia, para propiedades de navegación de EF Core en entidades que se enlazan directamente (`"Customer": ["The Customer field is required."]`). Sin `[ApiController]` no obtienes el 400 automático, pero `ModelState.IsValid` es `false` con el mismo error, y así es como se lo encuentran Razor Pages y los envíos de formularios de MVC.

## Por qué ocurre

El `DataAnnotationsMetadataProvider` de MVC construye metadatos de validación para cada propiedad y parámetro enlazado. Para cada uno que sea un tipo de referencia y no tenga un `[Required]` explícito, le pregunta a `NullabilityInfoContext` qué registró el compilador. Si el estado de lectura es `NotNull`, agrega un `RequiredAttribute` a la lista de validadores. El comentario relevante en el código fuente de ASP.NET Core es directo al respecto: "For non-nullable reference types, treat them as-if they had an implicit [Required]."

Cuatro detalles de ese código deciden casi todos los casos que te vas a encontrar:

1. **El atributo implícito usa `AllowEmptyStrings = true`.** Solo rechaza `null`, no `""`. Un cuerpo JSON con `"name": ""` pasa la validación.
2. **Los valores de formulario y de consulta siguen rechazando cadenas vacías,** porque el enlace de modelos de MVC convierte la entrada vacía o compuesta solo de espacios en `null` (`ConvertEmptyStringToNull` es `true` por defecto) antes de que se ejecute la validación. `?q=` y `?q=%20` fallan ambos con "The q field is required."
3. **Los parámetros con valor predeterminado están exentos.** `string sort = "name"` nunca es obligatorio de forma implícita, porque el proveedor omite los parámetros donde `HasDefaultValue` es true.
4. **El código sin anotaciones de nulabilidad está exento.** Si el tipo se compiló con las anotaciones de nulabilidad deshabilitadas, el estado de lectura es `Unknown`, no `NotNull`, así que no se agrega nada. Por eso el error suele aparecer el día en que alguien activa `<Nullable>enable</Nullable>` en un proyecto antiguo, sin que cambie un solo modelo.

Solo MVC hace esto. Los controladores, Razor Pages y las vistas de MVC pasan todos por `DataAnnotationsMetadataProvider`. Las minimal APIs no, incluida la nueva validación generada por código fuente de `AddValidation()` en .NET 10, que se trata en los detalles a tener en cuenta más abajo.

## Reproducción mínima

```csharp
// ASP.NET Core 10.0.10, <Nullable>enable</Nullable>, Program.cs
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddControllers();
var app = builder.Build();
app.MapControllers();
app.Run();

public record CreateProduct(string Name, string? Nickname, string Sku = "");

public class Order
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public int CustomerId { get; set; }
    public Customer Customer { get; set; } = null!; // EF Core navigation
}

public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
}

[ApiController, Route("api")]
public class ProductsController : ControllerBase
{
    [HttpPost("create")] public IActionResult Create(CreateProduct p) => Ok(p);
    [HttpPost("order")]  public IActionResult Order(Order o) => Ok(o);
    [HttpGet("search")]  public IActionResult Search(string q) => Ok(q);
}
```

Lo que devolvió cada solicitud:

| Solicitud | Estado | Clave del error |
| --- | --- | --- |
| `POST /api/create` con `{}` | 400 | `Name` |
| `POST /api/create` con `{"name":null}` | 400 | `Name` |
| `POST /api/create` con `{"name":""}` | 200 | ninguna |
| `POST /api/create` con `{"name":"x"}` | 200 | ninguna |
| `POST /api/order` con `{"title":"t","customerId":1}` | 400 | `Customer` |
| `GET /api/search` | 400 | `q` |
| `GET /api/search?q=` | 400 | `q` |

`Nickname` (declarada como `string?`) y `Sku` (un parámetro con valor predeterminado) nunca produjeron un error. `Title` tampoco, porque el inicializador `= ""` hace que la deserialización JSON la deje en `""` cuando falta la propiedad, y `""` satisface `AllowEmptyStrings = true`.

La fila de `Order` es la que más confunde a la gente. `Customer` es no anulable porque EF Core lo quiere así para una relación obligatoria, `= null!` silencia [CS8618](/es/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/), y luego MVC lee la misma anotación y exige que el cliente envíe un objeto `Customer` completo en el cuerpo.

## Solución 1: declara los valores opcionales como anulables (recomendado)

Si un valor puede faltar legítimamente, el tipo debería decirlo. Eso corrige la validación y te da las comprobaciones de null del compilador dentro de la acción:

```csharp
// ASP.NET Core 10.0.10
public record CreateProduct(string Name, string? Nickname, string? Description);

[HttpGet("search")]
public IActionResult Search(string? q) => Ok(q ?? "(all)");
```

Para parámetros de consulta y de ruta que tienen un valor de respaldo sensato, un valor predeterminado también funciona y se lee mejor que una comprobación de null:

```csharp
// ASP.NET Core 10.0.10
[HttpGet("list")]
public IActionResult List(string sort = "name", int page = 1) => Ok(new { sort, page });
```

Para entidades de EF Core, la solución correcta es dejar de enlazar la entidad. Acepta un DTO de solicitud que lleve `CustomerId` y nada más, y luego mapéalo:

```csharp
// ASP.NET Core 10.0.10, EF Core 10
public record CreateOrder(string Title, int CustomerId);

[HttpPost("order")]
public async Task<IActionResult> Order(CreateOrder dto, AppDbContext db)
{
    var order = new Order { Title = dto.Title, CustomerId = dto.CustomerId };
    db.Orders.Add(order);
    await db.SaveChangesAsync();
    return CreatedAtAction(nameof(Order), new { id = order.Id }, new { order.Id });
}
```

Si ahora mismo no puedes cambiar el enlace de la entidad, `[ValidateNever]` en la propiedad de navegación (de `Microsoft.AspNetCore.Mvc.ModelBinding.Validation`) le indica a MVC que omita su validación:

```csharp
// ASP.NET Core 10.0.10
[ValidateNever]
public Customer Customer { get; set; } = null!;
```

Con él, `{"title":"t"}` se enlazó sin problemas y `Customer` se quedó en `null`. Es un parche, no un diseño. Sigue permitiendo que un cliente envíe un objeto `customer` anidado que EF Core intentará insertar sin reparos.

## Solución 2: desactiva la regla implícita de forma global

Cuando estás habilitando los tipos de referencia anulables en una API grande ya existente y no puedes auditar todos los modelos a la vez, suprime la inferencia en `AddControllers` (o `AddMvc`, `AddRazorPages().AddMvcOptions(...)`):

```csharp
// ASP.NET Core 10.0.10, Program.cs
builder.Services.AddControllers(options =>
{
    options.SuppressImplicitRequiredAttributeForNonNullableReferenceTypes = true;
});
```

Con esa opción activada, cada fila de la tabla anterior devolvió 200 excepto la consulta vacía, que devolvió `204 No Content` porque la acción recibió `null` y `Ok(null)` se convierte en un 204. Fíjate en lo que eso significa: la acción se ejecutó con `q == null` aunque la firma dice `string q`. Cambiaste un 400 por un valor que el compilador jura que no puede ser null. Trata esto como un interruptor de migración y planea quitarlo una vez que los modelos estén anotados con honestidad.

## Solución 3: conserva la regla, controla el mensaje

Si la propiedad realmente es obligatoria, la validación implícita está haciendo su trabajo, y la única queja es la redacción. Un atributo explícito reemplaza al implícito (el proveedor solo agrega el suyo cuando no hay un `[Required]` presente):

```csharp
// ASP.NET Core 10.0.10
using System.ComponentModel.DataAnnotations;

public class CreateCustomer
{
    [Required(AllowEmptyStrings = false, ErrorMessage = "Customer name is required.")]
    public string Name { get; set; } = default!;
}
```

Esta es también la forma de hacer que falle una cadena JSON vacía, algo que la regla implícita nunca hace. Un `[Required]` simple (donde `AllowEmptyStrings` es `false` por defecto) rechazó `{"name":""}` con un 400 en mi reproducción. A la inversa, `[Required(AllowEmptyStrings = true)]` aceptó `""` en mi reproducción, igual que el comportamiento implícito.

Si lo que quieres cambiar es la forma de la respuesta y no el mensaje, eso es un asunto de problem details, no de validación. El enfoque de [personalizar las respuestas de error de validación con IProblemDetailsService](/es/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/) también funciona para controladores.

## Detalles a tener en cuenta y errores parecidos

**Las minimal APIs se comportan distinto.** El mismo record `CreateProduct` enlazado en un endpoint de minimal API aceptó `{}` y `{"name":null}` con un 200 y `Name == null`, incluso con `builder.Services.AddValidation()` registrado y un `[StringLength(20)]` en otra propiedad (que sí produjo un 400 al incumplirse, así que el validador se estaba ejecutando). El generador de código fuente de validación de .NET 10 respeta los atributos, pero no infiere `[Required]` a partir de la nulabilidad. Si estás [validando cuerpos de solicitud en minimal APIs](/es/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/), agrega `[Required]` explícitamente. Los *parámetros* de minimal API son otra historia: un parámetro de consulta `string q` no anulable que falta devuelve 400 desde el propio enlazador de parámetros, y en Development la página de excepciones muestra `BadHttpRequestException: Required parameter "string q" was not provided from query string.`

**La palabra clave `required` de C# es un error distinto.** Un `public required string Name { get; set; }` lo hace cumplir System.Text.Json durante la deserialización, antes de la validación de MVC. El cuerpo en mi reproducción fue:

```json
{
  "$": ["JSON deserialization for type 'ReqKw' was missing required properties including: 'name'."],
  "o": ["The o field is required."]
}
```

La segunda entrada, con el nombre del parámetro de la acción como clave, es otra vez la regla implícita: la deserialización falló, el parámetro se quedó en `null`, y entonces se marcó el parámetro no anulable `ReqKw o`. Declarar el parámetro como `[FromBody] ReqKw? o` elimina esa entrada de ruido. La palabra clave `required` y `[JsonRequired]` interactúan a su manera, algo que se trata en [hacer que System.Text.Json ignore una propiedad required](/es/2026/08/how-to-make-system-text-json-ignore-a-property-with-the-required-modifier/) y en [CS9035](/es/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/).

**"The p field is required" con un cuerpo vacío.** Enviar una solicitud sin cuerpo a `Create(CreateProduct p)` devolvió dos errores: `"": ["A non-empty request body is required."]` y `"p": ["The p field is required."]`. Declarar el parámetro como `CreateProduct? p` convierte el cuerpo vacío en un enlace exitoso con `p == null` (la acción devolvió 204 desde `Ok(null)`), así que hazlo solo si un cuerpo vacío es válido para el endpoint. `MvcOptions.AllowEmptyInputInBodyModelBinding` es el interruptor global para el primer mensaje.

**Contexto de nulabilidad en otro ensamblado.** La regla lee las anotaciones del ensamblado que declara el modelo, no las del proyecto web. Los modelos de una biblioteca compartida compilada con `<Nullable>disable</Nullable>` nunca reciben el atributo implícito, aunque el proyecto de la API habilite la nulabilidad. Lo contrario también se cumple: habilitar la nulabilidad en la biblioteca compartida cambia el comportamiento de la API sin tocar el proyecto de la API.

**Propiedades heredadas.** La anotación se lee del miembro que declara la propiedad. Si un DTO deriva de una clase base de otro proyecto, decide el contexto de nulabilidad de la clase base, no el del tipo derivado. Cuando una propiedad que crees que es `string?` sigue informando "required", busca dónde está declarada realmente.

**Los tipos de valor necesitan otra solución.** Un `int` que falta no activa esta regla en absoluto (los tipos de valor se omiten). Toma el valor `0` en silencio. Si necesitas "debe proporcionarse", usa `int?` con `[Required]`.

## Relacionado

- [Cómo validar cuerpos de solicitud en minimal APIs sin controladores en ASP.NET Core 11](/es/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/), donde los atributos son la única fuente de obligatoriedad.
- [Validación de minimal API frente a FluentValidation en ASP.NET Core 11](/es/2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11/), si estás decidiendo dónde deberían vivir reglas como esta.
- [Solución a CS8618: una propiedad no anulable debe contener un valor no null](/es/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/), el lado del compilador de las mismas anotaciones.
- [Cómo consumir una respuesta ProblemDetails RFC 9457 desde un HttpClient tipado](/es/2026/09/how-to-consume-an-rfc-9457-problemdetails-response-from-a-typed-httpclient/), para clientes que leen el diccionario `errors` de arriba.

## Fuentes

- [Non-nullable reference types and [Required] attribute](https://learn.microsoft.com/aspnet/core/mvc/models/validation#non-nullable-reference-types-and-required-attribute) en "Model validation in ASP.NET Core MVC and Razor Pages" en Microsoft Learn.
- Referencia de la API [`MvcOptions.SuppressImplicitRequiredAttributeForNonNullableReferenceTypes`](https://learn.microsoft.com/dotnet/api/microsoft.aspnetcore.mvc.mvcoptions.suppressimplicitrequiredattributefornonnullablereferencetypes).
- [`DataAnnotationsMetadataProvider.cs`](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Mvc/Mvc.DataAnnotations/src/DataAnnotationsMetadataProvider.cs) en la rama `release/10.0`, para la inferencia de `AllowEmptyStrings = true` y la exención de `HasDefaultValue`.
- [dotnet/aspnetcore#16654](https://github.com/dotnet/aspnetcore/issues/16654), uno de los primeros reportes de la regla sorprendiendo a usuarios en propiedades heredadas.
