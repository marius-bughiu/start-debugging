---
title: "Cómo compartir la lógica de validación entre el servidor y Blazor WebAssembly"
description: "La mayor fuente de divergencia en la validación entre un cliente Blazor WebAssembly y una API ASP.NET Core es la tentación de escribir las reglas dos veces. Esta guía recorre la única estructura que escala en .NET 11: una biblioteca de clases Shared que posee los DTO y sus validadores, consumida por el cliente WASM (EditForm + DataAnnotationsValidator o Blazored.FluentValidation) y por el servidor (filtro de endpoint en minimal API o model binding de MVC), con un viaje de ida y vuelta probado que vuelca los ValidationProblemDetails del servidor en el EditContext."
pubDate: 2026-04-29
tags:
  - "blazor"
  - "blazor-webassembly"
  - "aspnetcore-11"
  - "dotnet-11"
  - "validation"
  - "fluentvalidation"
  - "csharp"
lang: "es"
translationOf: "2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly"
translatedBy: "claude"
translationDate: 2026-04-29
---

Si tu cliente Blazor WebAssembly y tu API ASP.NET Core mantienen copias separadas de las reglas de validación, divergen dentro del primer sprint y producen el peor tipo de error: el formulario pasa en el cliente, el servidor lo rechaza, el usuario ve un 400 sin ningún mensaje en línea. La única solución duradera es colocar tanto los DTO como sus validadores en un tercer proyecto que el cliente y el servidor referencien, y volcar la respuesta de error del servidor en el mismo `EditContext` que usó el cliente. Esta guía construye esa estructura de extremo a extremo en .NET 11 (`Microsoft.AspNetCore.App` 11.0.0, `Microsoft.AspNetCore.Components.Web` 11.0.0, C# 14), primero con `System.ComponentModel.DataAnnotations` integrado, después con `FluentValidation` 12 para reglas que las anotaciones de datos no pueden expresar.

## Por qué un proyecto Shared, no reglas duplicadas ni un paquete NuGet

Los dos patrones que fallan son obvios en retrospectiva. Copiar y pegar atributos `[Required]` desde el DTO de la API a un view model casi idéntico en el cliente produce divergencia cada vez que alguien edita uno y olvida el otro. Poner los contratos en un paquete NuGec externo funciona para sistemas grandes, pero es excesivo para una sola aplicación: pagas saltos de versión, latencia de restauración de paquetes y un feed interno por algo que debería ser una referencia de proyecto.

Una biblioteca de clases `Contracts` (o `Shared`) dentro de la misma solución es la forma correcta. Apunta a `net11.0`, no tiene dependencias de ASP.NET y la referencian tanto `WebApp.Client` (el proyecto Blazor WASM) como `WebApp.Server` (la API ASP.NET Core). La plantilla de proyecto Blazor WebAssembly que viene con .NET 11 (`dotnet new blazorwasm --hosted` se eliminó en .NET 8 y siguió fuera en .NET 11; ahora creas los tres proyectos a mano o usas `dotnet new blazor --interactivity WebAssembly --auth Individual` para la plantilla unificada de Blazor) ya acepta esta estructura: elige el scaffold que uses y agrega un tercer proyecto.

```bash
# .NET 11 SDK (11.0.100)
dotnet new sln -n WebApp
dotnet new classlib -n WebApp.Contracts -f net11.0
dotnet new webapi -n WebApp.Server -f net11.0
dotnet new blazorwasm -n WebApp.Client -f net11.0
dotnet sln add WebApp.Contracts WebApp.Server WebApp.Client
dotnet add WebApp.Server reference WebApp.Contracts
dotnet add WebApp.Client reference WebApp.Contracts
```

Dos reglas mantienen `WebApp.Contracts` limpio y evitan que arrastre código del servidor al bundle WASM:

1. El `.csproj` no lista ningún `FrameworkReference` ni paquetes `Microsoft.AspNetCore.*`. Si necesitas `IFormFile` o `HttpContext` en un contrato, estás mezclando formato de cable con lógica del servidor; sepáralos.
2. Está configurado `<IsTrimmable>true</IsTrimmable>` para que el paso de publicación WASM no advierta en cada validador que use reflexión. Volveremos a esto en la sección de gotchas de AOT.

## El DTO que recorre todos los ejemplos

```csharp
// WebApp.Contracts/RegistrationRequest.cs
// .NET 11, C# 14, System.ComponentModel.DataAnnotations 11.0.0
using System.ComponentModel.DataAnnotations;

namespace WebApp.Contracts;

public sealed record RegistrationRequest
{
    [Required, EmailAddress, StringLength(254)]
    public required string Email { get; init; }

    [Required, StringLength(72, MinimumLength = 12)]
    public required string Password { get; init; }

    [Required, Compare(nameof(Password))]
    public required string ConfirmPassword { get; init; }

    [Range(13, 130)]
    public int Age { get; init; }

    [Required, RegularExpression(@"^[a-zA-Z0-9_]{3,20}$",
        ErrorMessage = "Username must be 3-20 letters, digits, or underscores.")]
    public required string Username { get; init; }
}
```

Los miembros `required` combinados con setters `init` te dan un record que el cliente puede construir con sintaxis de inicializador de objetos y que `System.Text.Json` 11 puede deserializar en el servidor sin un constructor sin parámetros (encadena la inferencia equivalente a `[JsonConstructor]` a través de los miembros `required` en .NET 11). El mismo record es el tipo enlazado por el endpoint de la API y por el modelo del `EditForm`. Hay exactamente un lugar para cambiar una regla.

## La ruta DataAnnotations: cero paquetes adicionales

Para la mayoría de las aplicaciones CRUD, las anotaciones de datos sobre el DTO compartido son suficientes. Se ejecutan en el cliente porque el componente `<DataAnnotationsValidator>` de Blazor (en `Microsoft.AspNetCore.Components.Forms`) reflexiona sobre el modelo y vuelca los mensajes en el `EditContext`, y se ejecutan en el servidor porque el pipeline de model binding de ASP.NET Core llama a `ObjectGraphValidator` para cualquier tipo marcado con `[ApiController]` o cualquier parámetro de minimal API que pase por el `IValidationProblemDetailsService` por defecto (introducido como parte del trabajo de validación con filtros de endpoint registrado en [aspnetcore#52281](https://github.com/dotnet/aspnetcore/pull/52281)).

Endpoint del servidor, estilo minimal API:

```csharp
// WebApp.Server/Program.cs
// .NET 11, ASP.NET Core 11.0.0
using Microsoft.AspNetCore.Http.HttpResults;
using WebApp.Contracts;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddProblemDetails();
builder.Services.AddValidation(); // .NET 11 endpoint filter that runs DataAnnotations

var app = builder.Build();

app.MapPost("/api/register",
    Results<Ok<RegistrationResponse>, ValidationProblem> (RegistrationRequest req) =>
    {
        // model is already validated by the endpoint filter
        return TypedResults.Ok(new RegistrationResponse(Guid.NewGuid()));
    });

app.Run();

public sealed record RegistrationResponse(Guid UserId);
```

`AddValidation()` es el helper de .NET 11 que registra un filtro de endpoint que recorre los miembros descubiertos por `[Validator]` o anotados con `DataAnnotations` de cada parámetro y termina con un `400` con cuerpo `ValidationProblemDetails` antes de que se ejecute tu handler. La forma de la respuesta es la misma que el cliente lee a continuación.

Formulario del cliente, en `WebApp.Client/Pages/Register.razor`:

```razor
@* Blazor WebAssembly, .NET 11. Microsoft.AspNetCore.Components 11.0.0 *@
@page "/register"
@using System.Net.Http.Json
@using WebApp.Contracts
@inject HttpClient Http

<EditForm Model="model" OnValidSubmit="SubmitAsync" FormName="register">
    <DataAnnotationsValidator />
    <ValidationSummary />

    <label>Email <InputText @bind-Value="model.Email" /></label>
    <ValidationMessage For="() => model.Email" />

    <label>Password <InputText type="password" @bind-Value="model.Password" /></label>
    <ValidationMessage For="() => model.Password" />

    <button type="submit">Register</button>
</EditForm>

@code {
    private RegistrationRequest model = new()
    {
        Email = "", Password = "", ConfirmPassword = "", Username = ""
    };

    private async Task SubmitAsync()
    {
        var response = await Http.PostAsJsonAsync("api/register", model);
        if (!response.IsSuccessStatusCode)
        {
            await ApplyServerValidationAsync(response);
        }
    }
}
```

Dos cosas hacen que esta sea una historia de validación *compartida* y no dos paralelas. Primero, `model` es `RegistrationRequest`, el mismo DTO que enlaza el servidor. Segundo, cuando `<DataAnnotationsValidator>` evalúa el formulario, ejecuta exactamente la misma pasada de `Validator.TryValidateObject` que el filtro de endpoint del servidor. Lo que el cliente acepta, el servidor lo acepta; lo que el servidor rechaza con `EmailAddress`, el cliente también lo rechaza.

## Volcar el ValidationProblemDetails del servidor en el EditContext

Incluso con reglas compartidas, hay dos casos de error que provienen únicamente del servidor: comprobaciones entre agregados (el correo electrónico es único en la tabla de usuarios) y fallos de infraestructura (rate limit, restricción de base de datos). Para esos casos, el servidor devuelve `400` con `ValidationProblemDetails`, y el cliente debe extraer cada error de campo y adjuntarlo al `FieldIdentifier` correcto del `EditContext` para que el usuario vea el mensaje en línea junto al campo ofensor, no como una alerta genérica de "registro fallido".

```csharp
// WebApp.Client/Validation/EditContextExtensions.cs
// .NET 11, C# 14
using Microsoft.AspNetCore.Components.Forms;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;

public static class EditContextExtensions
{
    private static readonly JsonSerializerOptions Options =
        new(JsonSerializerDefaults.Web);

    public static async Task ApplyValidationProblemAsync(
        this EditContext editContext,
        HttpResponseMessage response)
    {
        if ((int)response.StatusCode != 400) return;

        var problem = await response.Content
            .ReadFromJsonAsync<ValidationProblemDetails>(Options);
        if (problem?.Errors is null) return;

        var messageStore = new ValidationMessageStore(editContext);
        messageStore.Clear();

        foreach (var (fieldName, messages) in problem.Errors)
        {
            // ASP.NET Core uses lowercase-first names by default; normalize.
            var pascal = char.ToUpperInvariant(fieldName[0]) + fieldName[1..];
            var identifier = new FieldIdentifier(editContext.Model, pascal);
            foreach (var msg in messages) messageStore.Add(identifier, msg);
        }

        editContext.NotifyValidationStateChanged();
    }
}
```

El handler en el archivo Razor entonces queda así:

```csharp
private EditContext editContext = default!;

protected override void OnInitialized() =>
    editContext = new EditContext(model);

private async Task SubmitAsync()
{
    var response = await Http.PostAsJsonAsync("api/register", model);
    if (response.StatusCode == System.Net.HttpStatusCode.BadRequest)
        await editContext.ApplyValidationProblemAsync(response);
}
```

La razón por la que esto importa es que el servidor es el único lugar donde se pueden ejecutar ciertas comprobaciones. Una regla de "nombre de usuario ya tomado" no puede vivir en la biblioteca compartida porque requiere una llamada a la base de datos. Al transmitir su fallo al mismo `EditContext`, el usuario obtiene un único modelo mental: cada error aparece junto al campo ofensor, sin importar si la regla se disparó en el navegador o en la API.

## Cuando DataAnnotations no alcanza: FluentValidation 12 en el proyecto compartido

DataAnnotations no puede expresar reglas condicionales ("Postcode es requerido si Country es 'US'"), no puede ejecutar comprobaciones asíncronas contra un servicio, y sus mensajes de error son incómodos de localizar más allá de un archivo de recursos por atributo. FluentValidation 12, lanzado en 2026 con soporte de primera clase para .NET 11, vive sin problemas en el mismo proyecto compartido y se ejecuta en ambas direcciones.

Agrega el paquete y escribe un validador junto al DTO:

```bash
dotnet add WebApp.Contracts package FluentValidation --version 12.0.0
```

```csharp
// WebApp.Contracts/RegistrationRequestValidator.cs
// FluentValidation 12.0.0, .NET 11, C# 14
using FluentValidation;

namespace WebApp.Contracts;

public sealed class RegistrationRequestValidator : AbstractValidator<RegistrationRequest>
{
    public RegistrationRequestValidator()
    {
        RuleFor(r => r.Email).NotEmpty().EmailAddress().MaximumLength(254);
        RuleFor(r => r.Password).NotEmpty().MinimumLength(12).MaximumLength(72);
        RuleFor(r => r.ConfirmPassword).Equal(r => r.Password)
            .WithMessage("Passwords do not match.");
        RuleFor(r => r.Username).Matches(@"^[a-zA-Z0-9_]{3,20}$");
        RuleFor(r => r.Age).InclusiveBetween(13, 130);
    }
}
```

En el servidor, registra FluentValidation como la fuente de validadores para el mismo filtro `AddValidation()`, o invócalo explícitamente desde un filtro de minimal API:

```csharp
// WebApp.Server/Program.cs additions
using FluentValidation;
using WebApp.Contracts;

builder.Services.AddScoped<IValidator<RegistrationRequest>,
                           RegistrationRequestValidator>();

app.MapPost("/api/register", async (
    RegistrationRequest req,
    IValidator<RegistrationRequest> validator) =>
{
    var result = await validator.ValidateAsync(req);
    if (!result.IsValid) return Results.ValidationProblem(result.ToDictionary());
    return Results.Ok(new RegistrationResponse(Guid.NewGuid()));
});
```

`result.ToDictionary()` produce la forma `IDictionary<string, string[]>` que `Results.ValidationProblem` espera, así que el formato de cable que decodifica el cliente es idéntico al de la ruta DataAnnotations. Tu extensión `ApplyValidationProblemAsync` sigue funcionando.

En el cliente, instala `Blazored.FluentValidation` (el fork de `aksoftware` es el que se mantiene activamente en 2026, versión 2.4.0, apuntando a `net11.0`) y reemplaza `<DataAnnotationsValidator />` por `<FluentValidationValidator />`:

```bash
dotnet add WebApp.Client package Blazored.FluentValidation --version 2.4.0
```

```razor
@using Blazored.FluentValidation

<EditForm Model="model" OnValidSubmit="SubmitAsync">
    <FluentValidationValidator />
    <ValidationSummary />
    @* same fields as before *@
</EditForm>
```

El componente encuentra el validador por convención (`FooValidator` para `Foo`) en el ensamblado que contiene el modelo, que es `WebApp.Contracts`. Como el validador está en el proyecto compartido, el cliente y el servidor ejecutan la misma instancia de las mismas reglas. La única diferencia es *dónde* se ejecutan.

## Reglas asíncronas que solo pueden correr en el servidor

FluentValidation te permite mezclar reglas síncronas y asíncronas. La tentación es poner `MustAsync(IsUsernameAvailableAsync)` en el validador y darlo por hecho. No lo hagas: el lado del cliente no tiene acceso a tu `UserManager`, y un `EditForm` síncrono de Blazor no puede esperar una regla asíncrona en medio de la pulsación de teclas. El patrón que funciona es marcar las reglas exclusivamente asíncronas con un `RuleSet`:

```csharp
public sealed class RegistrationRequestValidator : AbstractValidator<RegistrationRequest>
{
    public RegistrationRequestValidator(IUserUniqueness? uniqueness = null)
    {
        // rules that run everywhere
        RuleFor(r => r.Email).NotEmpty().EmailAddress();
        // ... shared rules omitted

        RuleSet("Server", () =>
        {
            if (uniqueness is null) return; // skipped on client
            RuleFor(r => r.Email).MustAsync(uniqueness.IsEmailFreeAsync)
                .WithMessage("This email is already registered.");
            RuleFor(r => r.Username).MustAsync(uniqueness.IsUsernameFreeAsync)
                .WithMessage("Username taken.");
        });
    }
}

// WebApp.Contracts/IUserUniqueness.cs - interface only, no implementation
public interface IUserUniqueness
{
    ValueTask<bool> IsEmailFreeAsync(string email, CancellationToken ct);
    ValueTask<bool> IsUsernameFreeAsync(string username, CancellationToken ct);
}
```

La interfaz vive en `WebApp.Contracts` para que el validador compile, pero no tiene implementación allí. El servidor proporciona una implementación real respaldada por EF Core; el cliente no registra ninguna, así que el parámetro del constructor es `null` y el ruleset `Server` no agrega reglas. En el servidor optas por activarlo:

```csharp
await validator.ValidateAsync(req,
    options => options.IncludeRuleSets("default", "Server"));
```

Así, la comprobación entre agregados se dispara solo donde puede y vuelve al cliente a través del mismo mapeo de `ValidationProblemDetails` que ya construiste.

## Gotchas de trim y AOT en el paso de publicación de WASM

La publicación de Blazor WebAssembly en .NET 11 ejecuta IL trimming por defecto y soporta una pasada AOT separada con `<RunAOTCompilation>true</RunAOTCompilation>`. Ambas pasadas advierten cuando una biblioteca usa reflexión sin acotar, que es lo que hacen tanto DataAnnotations como FluentValidation. Tres cosas concretas para hacer:

1. Marca el proyecto compartido como recortable: `<IsTrimmable>true</IsTrimmable>` y `<IsAotCompatible>true</IsAotCompatible>` en `WebApp.Contracts.csproj`. Esto hace que el SDK exponga las advertencias de trim dentro de la biblioteca compartida donde puedes corregirlas, en lugar de descartar silenciosamente el descubrimiento de reglas en el consumidor.
2. Para DataAnnotations, el runtime trae anotaciones `[DynamicallyAccessedMembers(All)]` en `Validator.TryValidateObject` desde .NET 8, y siguen vigentes en .NET 11; no necesitas hacer nada más siempre que tu DTO sea `public` y se alcance desde una raíz que el trimmer pueda ver. `EditForm` alcanza el tipo del modelo a través del argumento genérico, lo cual cuenta.
3. Para FluentValidation 12, cada validador que defines se reflexiona al inicio. El componente `Blazored.FluentValidation` 2.4.0 escanea el ensamblado con anotaciones `[DynamicDependency]` aplicadas para que sobreviva al trimming, pero si publicas con `RunAOTCompilation`, agrega `<TrimmerRootAssembly Include="WebApp.Contracts" />` al `.csproj` del cliente. Esto enraíza todo el ensamblado compartido y es la respuesta correcta más simple; el costo en tamaño de WASM es pequeño porque los únicos tipos públicos en `WebApp.Contracts` son los DTO y validadores que ya estás usando.

Si te saltas estos pasos, el cliente se ve sano en `dotnet run`, luego envía una compilación Release donde la validación silenciosamente no hace nada porque el trimmer eliminó las reglas que no pudo demostrar estáticamente que se usaban.

## Mayúsculas en los nombres de campo y la trampa snake_case

Las opciones JSON por defecto de ASP.NET Core 11 serializan los nombres de propiedad en `camelCase`. Por lo tanto, `ValidationProblemDetails.Errors` regresa con clave `email`, no `Email`, y `FieldIdentifier` distingue entre mayúsculas y minúsculas. La normalización a `pascal` en `ApplyValidationProblemAsync` cubre el caso común pero no los miembros anidados (`Address.PostalCode` se convierte en `address.PostalCode` si solo pones en mayúscula la primera letra). Para DTO anidados, divide por `.`, pon en mayúscula la primera letra de cada segmento y luego entra al objeto anidado usando los segmentos para construir una cadena de instancias `FieldIdentifier(parent, propertyName)`. O, si controlas las opciones JSON, configura `JsonNamingPolicy = null` solo para `ProblemDetails` escribiendo un `IProblemDetailsService` personalizado. La respuesta más simple es mantener los DTO suficientemente planos como para que el cambio de mayúsculas sea de una sola línea.

Si adoptas una política de nombres distinta globalmente (snake_case es popular en 2026 por las herramientas de OpenAPI), la misma idea aplica: parsea la política, inviértela y pasa el nombre corregido a `FieldIdentifier`. No hay un helper integrado para esto en `Microsoft.AspNetCore.Components.Forms`; el `EditContext` se diseñó antes de que `ProblemDetails` fuera la forma estándar de los errores, y los dos aún no se han conectado entre sí.

## Guías relacionadas y material fuente

Para la plomería de soporte que esta guía asumió que tenías: el [patrón de filtro de excepciones global en ASP.NET Core 11](/es/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) atrapa los fallos no relacionados con la validación que nunca deberían llegar al usuario como un 500. Si quieres una mirada más profunda al endpoint que respalda este formulario, [refresh tokens en ASP.NET Core Identity](/es/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/) muestra la continuación de `/api/register`. Para clientes tipados generados contra el mismo DTO para que no escribas la URL a mano, mira [generar clientes fuertemente tipados desde una especificación OpenAPI en .NET 11](/es/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/). Y en el lado JSON, [un `JsonConverter` personalizado en `System.Text.Json`](/es/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) es la salida de emergencia correcta cuando un solo campo del DTO compartido necesita formas distintas en el cable.

Fuentes primarias usadas al escribir esto:

- [Filtro de validación de endpoint para minimal API en ASP.NET Core 11](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/parameter-binding?view=aspnetcore-11.0#validation), MS Learn.
- [`EditForm` de Blazor y `DataAnnotationsValidator`](https://learn.microsoft.com/en-us/aspnet/core/blazor/forms/validation?view=aspnetcore-11.0), MS Learn.
- [Referencia de `ValidationProblemDetails`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.mvc.validationproblemdetails), .NET API Browser.
- [Documentación de FluentValidation 12](https://docs.fluentvalidation.net/en/latest/blazor.html), página de integración con Blazor.
- [Blazored.FluentValidation 2.4.0](https://github.com/Blazored/FluentValidation), README de GitHub.
- [Guía de trimming y AOT para Blazor WebAssembly en .NET 11](https://learn.microsoft.com/en-us/aspnet/core/blazor/host-and-deploy/configure-trimmer?view=aspnetcore-11.0), MS Learn.
