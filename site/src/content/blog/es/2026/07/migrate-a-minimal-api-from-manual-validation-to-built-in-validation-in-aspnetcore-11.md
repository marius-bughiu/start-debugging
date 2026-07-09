---
title: "Migrar una minimal API de comprobaciones de validación manuales a la validación integrada en ASP.NET Core 11"
description: "Guía paso a paso para reemplazar las comprobaciones manuales (if) en los handlers de una minimal API de ASP.NET Core 11 por el validador integrado basado en DataAnnotations y generación de código fuente: qué se rompe, qué reglas manuales se pueden portar y cuáles no, y cómo verificar que el contrato 400 ProblemDetails no cambia."
pubDate: 2026-07-09
updatedDate: 2026-07-09
template: migration
tags:
  - "migration"
  - "aspnetcore"
  - "dotnet-11"
  - "minimal-apis"
  - "validation"
lang: "es"
translationOf: "2026/07/migrate-a-minimal-api-from-manual-validation-to-built-in-validation-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-09
---

Si tu minimal API de ASP.NET Core es anterior a .NET 10, es probable que cada handler empiece con un bloque de comprobaciones `if (string.IsNullOrWhiteSpace(...)) return Results.BadRequest(...)`. Esta migración reemplaza esas comprobaciones hechas a mano por la validación integrada que llegó en .NET 10 y se mantiene sin cambios en .NET 11: llama a `builder.Services.AddValidation()`, mueve las reglas a tus records de solicitud como atributos `DataAnnotations` y elimina las guardas manuales. Para un servicio típico de 15 a 40 endpoints, cuenta con medio día o un día de trabajo mecánico. Lo que se rompe no es el framework, son tus suposiciones: algunas de tus reglas manuales hacían cosas que los atributos no pueden expresar (consultas asíncronas, comprobaciones entre servicios), y la forma de tu respuesta de error puede cambiar si construías payloads `BadRequest` a mano en lugar de devolver `ProblemDetails`. La migración vale la pena porque elimina código, hace la validación declarativa y reutilizable, y se mantiene segura para el recorte (trim) bajo Native AOT. Además es reversible endpoint por endpoint, así que puedes hacerla de forma incremental. Todo lo de abajo apunta a .NET 11 con `Microsoft.NET.Sdk.Web` y C# 14; la característica es idéntica en .NET 10, donde apareció por primera vez.

## Por qué abandonar las comprobaciones manuales

El patrón manual funciona, así que el argumento para migrar es sobre mantenibilidad y corrección, no "la forma antigua está rota":

- **Eliminas código y las reglas se vuelven declarativas.** Un `[Required, Length(3, 20)] string Sku` en el record reemplaza tres líneas de comprobación imperativa en cada handler que acepta un `Sku`. Escribe la restricción una vez, junto a los datos.
- **Dejas de devolver formas de error inconsistentes.** Un `Results.BadRequest("Sku is required")` hecho a mano devuelve una cadena simple en un endpoint y un objeto JSON en otro, según quién lo escribió. El validador integrado devuelve un único cuerpo `HttpValidationProblemDetails` (RFC 9457) en todas partes, con clave por nombre de propiedad.
- **La validación se mantiene segura para el recorte.** La característica es un generador de código fuente en tiempo de compilación, no reflexión en tiempo de ejecución, así que se publica limpia bajo Native AOT y recorte agresivo, la misma razón por la que se incluye en el [stack de minimal API con Native AOT](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/).
- **Los parámetros de query, ruta y cabecera también se validan.** Las comprobaciones manuales casi siempre cubren el cuerpo JSON y olvidan los parámetros de paginación. El filtro integrado valida los parámetros escalares enlazados desde la ruta y la query con los mismos atributos.

## Qué se rompe

El framework en sí no se rompe, pero estas cinco cosas cambian, y necesitas saber cuáles de tus reglas manuales sobreviven al porte:

| Área                              | Cambio                                                                                              | Severidad |
| --------------------------------- | -------------------------------------------------------------------------------------------------- | --------- |
| Cuerpo de respuesta de error      | Los cuerpos de cadena simple o `BadRequest(...)` personalizados pasan a `ProblemDetails` (RFC 9457) con clave por propiedad | alta      |
| Reglas asíncronas / de BD         | `if (await repo.SkuExists(...))` no puede convertirse en atributo; necesita otro lugar               | alta      |
| Accesibilidad del tipo de solicitud | El record debe ser `public` o el generador no emite nada y la validación silenciosamente no se ejecuta | alta      |
| Reglas entre campos               | Los bloques `if` de varias propiedades pasan a `IValidatableObject`, no a atributos                 | media     |
| Tests que verifican el texto del error | Los tests que verifican tus antiguas cadenas de mensaje personalizadas fallarán contra el nuevo `ProblemDetails` | media     |
| Tipo de retorno del handler       | Los handlers pueden eliminar su rama `BadRequest`; el filtro produce el 400 antes de que el handler se ejecute | baja      |

Las dos filas de severidad alta que deciden la forma de tu migración son el cuerpo del error y las reglas asíncronas. Si los clientes analizan el cuerpo 400 actual, planifica un cambio de contrato o una capa de compatibilidad. Si alguna comprobación manual espera E/S, esa regla no se convierte en atributo en absoluto, y pretender lo contrario es la forma más común en que esta migración sale mal.

## Lista de verificación previa

Antes de tocar un handler:

- **SDK.** Instala el SDK de .NET 10 u 11. Confírmalo con `dotnet --version` (espera `11.0.x` o `10.0.x`).
- **Web SDK.** El proyecto debe usar `Microsoft.NET.Sdk.Web`. El generador de código fuente de validación se conecta con ese SDK en cuanto llamas a `AddValidation()`.
- **Registra el contrato actual.** Captura las respuestas 400 exactas que devuelven tus endpoints hoy (unas cuantas llamadas `curl` guardadas en archivos, o un test de snapshot). Estás a punto de cambiar esta forma y quieres una foto del antes.
- **Busca la superficie con grep.** Encuentra cada comprobación manual para poder seguir el progreso: `grep -rn "return Results.BadRequest\|return TypedResults.BadRequest" src/`. Esa lista es tu backlog de migración.
- **Inventaría las comprobaciones asíncronas.** Por separado, `grep -rn "await" src/` dentro de tus handlers y marca las que condicionan un `BadRequest`. Esas son las reglas que no se convertirán en atributos.
- **Ten una suite de tests o un script de humo.** Quieres ejecutar algo después de cada endpoint para confirmar que las solicitudes válidas siguen pasando y las inválidas siguen dando 400.

## Pasos de migración

### 1. Activa la validación integrada

Registra los servicios antes de construir la app. Este es el único cableado global que necesita la migración.

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddValidation();   // registers the validation services and endpoint filter
var app = builder.Build();
```

Con el web SDK actual de .NET 10 u 11 el generador de código fuente se activa automáticamente en cuanto está presente `AddValidation()`. Si copiaste un `.csproj` recortado o tu build es anterior a la GA, añade el espacio de nombres del interceptor explícitamente:

```xml
<!-- only needed if the generator's interceptors are not picked up automatically -->
<PropertyGroup>
  <InterceptorsNamespaces>$(InterceptorsNamespaces);Microsoft.AspNetCore.Http.Validation.Generated</InterceptorsNamespaces>
</PropertyGroup>
```

**Verificar:** la app sigue compilando y arrancando. `dotnet build` reporta cero errores. Todavía no ha cambiado ningún comportamiento porque ninguno de tus tipos lleva atributos.

### 2. Mueve las reglas por campo al record de solicitud

Toma un endpoint. Lee sus comprobaciones manuales y traduce cada regla expresable como atributo a un atributo `DataAnnotations` sobre el tipo de solicitud. Aquí está el antes, un handler que lleva su validación en línea:

```csharp
// .NET 11, C# 14 -- BEFORE: manual checks
app.MapPost("/products", (CreateProduct product) =>
{
    if (string.IsNullOrWhiteSpace(product.Sku) || product.Sku.Length is < 3 or > 20)
        return Results.BadRequest("Sku must be 3 to 20 characters.");
    if (string.IsNullOrWhiteSpace(product.Name) || product.Name.Length < 2)
        return Results.BadRequest("Name is required and must be at least 2 characters.");
    if (product.Quantity is < 1 or > 10_000)
        return Results.BadRequest("Quantity must be between 1 and 10000.");

    return Results.Created($"/products/{product.Sku}", product);
});

public record CreateProduct(string Sku, string Name, int Quantity);
```

Y el después: las reglas se mueven al record como atributos, el handler pierde su bloque de guarda, y el tipo se hace `public` para que el generador pueda verlo.

```csharp
// .NET 11, C# 14 -- AFTER: declarative validation
using System.ComponentModel.DataAnnotations;

app.MapPost("/products", (CreateProduct product) =>
    TypedResults.Created($"/products/{product.Sku}", product));

public record CreateProduct(
    [Required, Length(3, 20)] string Sku,
    [Required, MinLength(2)] string Name,
    [Range(1, 10_000)] int Quantity);
```

Fíjate en que el tipo pasó a ser `public`. Esta es la razón más común de que un endpoint migrado deje de validar silenciosamente: el generador solo puede emitir código para tipos que puede nombrar, así que un `record` dejado con la accesibilidad interna al archivo por defecto no obtiene validación ni error.

**Verificar:** `curl -i -X POST .../products -d '{"sku":"x","name":"","quantity":0}'` devuelve `400` con un cuerpo `ProblemDetails` que lista `Sku`, `Name` y `Quantity`. Un cuerpo válido sigue devolviendo `201`.

### 3. Mueve las reglas entre campos a IValidatableObject

Los atributos validan un miembro a la vez. Cualquier comprobación manual que compare dos campos ("fin después de inicio", "descuento requiere una razón") no se convierte en atributo. Implementa `IValidatableObject` en el record de solicitud en su lugar:

```csharp
// .NET 11, C# 14 -- cross-field rule ported from a manual if-block
using System.ComponentModel.DataAnnotations;

public record DateRange(
    [Required] DateOnly Start,
    [Required] DateOnly End) : IValidatableObject
{
    public IEnumerable<ValidationResult> Validate(ValidationContext context)
    {
        if (End <= Start)
        {
            yield return new ValidationResult(
                "End must be after Start.",
                [nameof(End)]);   // attaches the error to the End member
        }
    }
}
```

El arreglo de nombres de miembro que pasas como segundo argumento controla bajo qué clave cae el error, así que pasa el campo que tu UI debería resaltar. `Validate` se ejecuta después de las comprobaciones de atributo, así que un `Start` en `null` ya lo reporta `[Required]` antes de que se ejecute tu lógica entre campos.

**Verificar:** envía un rango donde `End <= Start` y confirma que la clave del error es `End`, no una clave vacía a nivel de modelo.

### 4. Reubica las comprobaciones asíncronas y entre servicios

Este es el paso al que alimenta el backlog de migración de tu grep de `await` previo. Una regla como "rechazar si el SKU ya existe en el catálogo" golpea la base de datos, y ni `DataAnnotations` ni `IValidatableObject` pueden esperar. Tienes dos opciones honestas:

Mantén esa comprobación específica como una llamada explícita dentro del handler, después de que el validador integrado ya haya garantizado que la forma es válida:

```csharp
// .NET 11, C# 14 -- async rule stays explicit, but shape is pre-validated
app.MapPost("/products", async (CreateProduct product, IProductRepository repo, CancellationToken ct) =>
{
    // Built-in validation already ran: Sku is non-null, 3-20 chars, Quantity in range.
    if (await repo.SkuExistsAsync(product.Sku, ct))
        return Results.Conflict($"A product with SKU {product.Sku} already exists.");

    await repo.AddAsync(product, ct);
    return TypedResults.Created($"/products/{product.Sku}", product);
});
```

O, si tienes muchas reglas asíncronas, mantén FluentValidation para exactamente esos tipos de solicitud y deja que la característica integrada se encargue de los simples. Las ventajas y desventajas están detalladas en [validación de minimal API vs FluentValidation](/2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11/); la versión corta es que las reglas asíncronas y la lógica condicional rica son las dos razones para mantener una biblioteca de validación. No intentes forzar una llamada a `DbContext` dentro de un `IValidatableObject`; es síncrono y o bien bloqueará un hilo o te empujará al territorio del interbloqueo con `.Result`.

**Verificar:** la comprobación de unicidad sigue rechazando un SKU duplicado (ahora como un `409`, o el estado que elijas), y un SKU nuevo sigue teniendo éxito.

### 5. Reutiliza una regla con un ValidationAttribute personalizado

Si la misma comprobación manual aparecía en tres handlers ("esta fecha no puede estar en el pasado"), no copies un `IValidatableObject` en tres records. Escribe un `ValidationAttribute` y el generador lo recoge como cualquier atributo integrado:

```csharp
// .NET 11, C# 14
using System.ComponentModel.DataAnnotations;

public sealed class NotInPastAttribute : ValidationAttribute
{
    protected override ValidationResult? IsValid(object? value, ValidationContext context)
    {
        if (value is DateOnly date && date < DateOnly.FromDateTime(DateTime.UtcNow.Date))
        {
            return new ValidationResult(
                ErrorMessage ?? "Date cannot be in the past.",
                [context.MemberName!]);
        }
        return ValidationResult.Success;
    }
}

public record Booking([Required, NotInPast] DateOnly When);
```

Esta es la respuesta basada en atributos a los bloques `if` duplicados: la regla vive una vez y se aplica dondequiera que se use el tipo.

**Verificar:** un endpoint que antes repetía la misma comprobación de fecha ahora rechaza una fecha pasada con el atributo, y los demás endpoints que comparten el tipo heredan la regla.

### 6. Elimina el código de guarda muerto y simplifica los tipos de retorno

Una vez que las reglas de un endpoint son declarativas, elimina el bloque `if` manual por completo, y simplifica el tipo de retorno declarado del handler. Como el 400 lo produce el filtro de endpoint antes de que se ejecute el cuerpo del handler, un handler ya no necesita una rama `BadRequest` en su unión `Results<...>`:

```csharp
// .NET 11, C# 14 -- return type no longer needs BadRequest
app.MapPost("/products", (CreateProduct product)
    => TypedResults.Created($"/products/{product.Sku}", product))
   .Produces<CreateProduct>(StatusCodes.Status201Created)
   .ProducesValidationProblem();   // documents the 400 the filter produces
```

**Verificar:** OpenAPI sigue anunciando el `400` (vía `ProducesValidationProblem`), y el endpoint compila sin la rama de unión eliminada.

## Verificación

Después de migrar un lote de endpoints, repasa esta lista antes de darla por terminada:

- **Compila.** `dotnet build` reporta cero advertencias y cero errores. Vigila específicamente que no haya nada, porque un tipo que le falta `public` falla en silencio, no de forma ruidosa. Eso lo captura el siguiente punto.
- **Cada endpoint migrado realmente valida.** Vuelve a ejecutar tus llamadas `curl` de solicitud inválida (o tests) contra cada endpoint migrado. Un endpoint que devuelve `201` para un cuerpo que esperas que sea rechazado significa que el generador no vio el tipo; comprueba primero el modificador de acceso.
- **Las solicitudes válidas siguen pasando.** Confirma que el camino feliz devuelve el mismo estado de éxito que antes.
- **El contrato de error es el que los clientes esperan.** Compara el nuevo cuerpo `ProblemDetails` con tu foto previa. Si un cliente analiza el diccionario `errors`, confirma que las claves coinciden con los nombres de propiedad que espera.
- **La suite de tests está en verde.** `dotnet test` pasa. Se espera que fallen los tests que verificaban tus antiguas cadenas de error personalizadas; actualízalos para que verifiquen la forma `ProblemDetails` en lugar de revertir la migración.
- **Sin regresión de rendimiento en el arranque.** Como la característica se genera en código fuente, el arranque debería ser plano o ligeramente más rápido (eliminaste código). Si mantuviste FluentValidation para algunos tipos, su compilación de expresión en el primer uso sigue aplicándose a esos tipos.

## Plan de reversión

Esta migración es reversible y, mejor aún, es incremental, así que rara vez necesitas una reversión completa. Dos niveles:

- **Por endpoint, sin revertir código.** Si un endpoint migrado se comporta mal en producción, encadena `DisableValidation()` en él para apagar el filtro para esa ruta mientras mantienes el registro global y todos los demás endpoints validados:

  ```csharp
  // .NET 11, C# 14 -- disable validation on a single endpoint
  app.MapPost("/internal/import", (CreateProduct product)
      => TypedResults.Accepted($"/products/{product.Sku}", product))
     .DisableValidation();
  ```

- **Reversión completa.** Como migraste endpoint por endpoint, el diff de cada endpoint es autónomo: restaura su bloque `if` manual y elimina los atributos del record si ningún otro endpoint depende de ellos. Eliminar la llamada global `AddValidation()` apaga la característica por completo sin ningún otro cambio de código. Nada en esta migración es de un solo sentido a nivel del framework.

## Problemas que nos encontramos

Problemas reales que costaron tiempo, y sus soluciones:

- **El no-op silencioso de un tipo que no es `public`.** De lejos el más frecuente. Mueves los atributos a un `record CreateProduct(...)`, el build tiene éxito, y la validación nunca se dispara porque el tipo no es `public`. No hay advertencia. Si un endpoint migrado deja de rechazar entradas malas, comprueba el modificador de acceso antes que nada.
- **Objetivos de atributo en records posicionales.** En un record posicional, `[Required] string Name` lo lee directamente el generador de validación. Solo necesitas el objetivo explícito `[property: Required] string Name` si alguna otra herramienta refleja sobre la propiedad generada en tiempo de ejecución. Mezclar las dos expectativas es una fuente común de confusión de tipo "por qué se ignora este atributo".
- **Los objetos anidados se validan recursivamente, lo que puede sorprenderte.** Si un record de solicitud referencia a un record `BillingAddress`, el generador valida también la dirección, y las claves de error usan una ruta con puntos como `Billing.PostalCode`. Si tu antiguo código manual solo comprobaba el objeto de nivel superior, ahora puedes obtener 400 en campos anidados que nunca validaste antes. Eso suele ser correcto, pero es un cambio de comportamiento que hay que esperar.
- **Orden de los filtros.** La validación se ejecuta como un filtro por endpoint. Si ya añades tus propias llamadas `AddEndpointFilter`, ten en cuenta dónde se sitúa la validación en la cadena, especialmente entre grupos de rutas; las reglas de composición son las mismas de [organizar endpoints de minimal API con MapGroup](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/).
- **No cambies el contrato de error en silencio por accidente.** Si quieres que el `ProblemDetails` migrado coincida con una forma específica (un `type` URI personalizado, miembros adicionales), dale forma de forma centralizada en lugar de por endpoint; la mecánica está en [personalizar las respuestas de error de validación de minimal API con IProblemDetailsService](/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/).

El modelo mental con el que quedarte: esta migración no es adoptar un framework nuevo, es eliminar código de guarda imperativo y volver a expresar las mismas reglas de forma declarativa sobre tus tipos de solicitud. Las reglas expresables como atributo pasan a `DataAnnotations`, las de entre campos a `IValidatableObject`, las reutilizables a un `ValidationAttribute` personalizado, y las asíncronas se quedan explícitas en el handler después de que la forma ya esté garantizada como válida. Hazla un endpoint a la vez, verifica cada uno con la llamada de solicitud inválida, y el código repetitivo de bloques `if` que abría cada handler simplemente desaparece.

## Relacionados

- [Cómo validar cuerpos de solicitud en minimal APIs sin controladores en ASP.NET Core 11](/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/) para la configuración completa de la característica integrada a la que estás migrando.
- [Validación de minimal API vs FluentValidation en ASP.NET Core 11](/2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11/) para decidir qué mantener en una biblioteca de validación frente a mover a la caja.
- [Cómo personalizar las respuestas de error de validación de minimal API con IProblemDetailsService en ASP.NET Core 11](/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/) para dar forma al cuerpo 400 después de la migración.
- [Minimal APIs vs controladores en ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) para la decisión del modelo de endpoint que subyace a esta.
- [Cómo organizar endpoints de minimal API con MapGroup en ASP.NET Core 11](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) para dónde se sitúa el filtro de validación respecto a los filtros de grupo.

## Fuentes

- Microsoft Learn, [What's new in ASP.NET Core in .NET 10](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-10.0?view=aspnetcore-10.0) (validación integrada de minimal API, `AddValidation`, generador de código fuente, `DisableValidation`, `ProblemDetails`).
- Microsoft Learn, [System.ComponentModel.DataAnnotations namespace](https://learn.microsoft.com/en-us/dotnet/api/system.componentmodel.dataannotations) (`ValidationAttribute`, `IValidatableObject`, `ValidationResult`).
- Tim Deschryver, [ASP.NET 10: Validating incoming models in Minimal APIs](https://timdeschryver.dev/blog/aspnet-10-validating-incoming-models-in-minimal-apis) (validación de objetos anidados, descubrimiento del generador de código fuente, forma del error).
