---
title: "Cómo validar opciones al arranque con IValidateOptions<T> en .NET 11"
description: "Implementa IValidateOptions<T>, regístralo en DI y encadena ValidateOnStart para que un appsettings.json incorrecto mate el proceso en lugar de la primera solicitud que lo toque. Cubre la sobrecarga Validate<TValidator>() de .NET 11, la validación asíncrona con IAsyncValidateOptions<T> y los tres lugares donde ValidateOnStart no hace nada en silencio."
pubDate: 2026-08-03
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "configuration"
  - "dependency-injection"
lang: "es"
translationOf: "2026/08/how-to-validate-options-at-startup-with-ivalidateoptions-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-08-03
---

Para que una aplicación falle al arrancar ante una configuración incorrecta, escribe una clase que implemente `IValidateOptions<TOptions>`, regístrala en DI como singleton y encadena `.ValidateOnStart()` al `OptionsBuilder<TOptions>` de ese tipo. Sin `ValidateOnStart`, los validadores se ejecutan de forma perezosa en el primer acceso a `.Value`, lo que normalmente significa la primera solicitud que toca la configuración, en producción, a las 3 de la mañana. Con él, `Host.StartAsync` fuerza a cada tipo de opciones registrado a enlazarse y validarse antes de que arranque un solo servicio hospedado, y un fallo lanza `OptionsValidationException` desde `host.RunAsync()`. Todo lo que sigue apunta a .NET 11 con `Microsoft.Extensions.Options` 11.0.0 y C# 14. El núcleo de `IValidateOptions<T>` y `ValidateOnStart` se comporta así desde que la API se movió de `Microsoft.Extensions.Hosting.dll` a `Microsoft.Extensions.Options.dll`, así que funciona sin cambios en .NET 8 hasta .NET 10; la sobrecarga `Validate<TValidator>()` y la canalización asíncrona son nuevas en .NET 11 y se señalan explícitamente.

## La validación perezosa es la validación de la que te enteras por un cliente

`ValidateDataAnnotations()` y `Validate(delegate)` cuelgan validadores de la canalización de opciones, pero esa canalización es perezosa por diseño. `IOptions<T>` es un singleton cuyo `.Value` se calcula la primera vez que alguien lo lee. Lo que significa que este registro:

```csharp
// .NET 11, C# 14
builder.Services
    .AddOptions<PaymentOptions>()
    .Bind(builder.Configuration.GetSection("Payments"))
    .ValidateDataAnnotations();
```

produce una aplicación que arranca limpiamente con una sección `Payments` vacía, pasa su health check, sirve tráfico y luego lanza `OptionsValidationException` la primera vez que una solicitud llega al endpoint de pago. Tu implementación tuvo éxito. Tu canary estaba en verde. El fallo apareció como un 500 en la tarjeta de un cliente.

El objetivo de la validación al arranque es convertir eso en un fallo al iniciar, algo que los orquestadores ya saben manejar: el contenedor sale con código distinto de cero, el despliegue se detiene y la revisión anterior sigue sirviendo. Es un fallo mucho mejor que un proceso parcialmente roto.

## Pasos para que la validación al arranque realmente se dispare

1. **Define la clase de opciones con un nombre de sección.** Solo propiedades públicas de lectura y escritura, no abstracta, con constructor público sin parámetros. Los campos no se enlazan.
2. **Escribe el validador como una clase que implemente `IValidateOptions<TOptions>`**, devolviendo `ValidateOptionsResult.Fail` con todos los fallos en lugar del primero.
3. **Registra el validador en DI.** Usa `TryAddEnumerable` con un `ServiceDescriptor` singleton, porque la canalización resuelve `IEnumerable<IValidateOptions<TOptions>>` y un simple `AddSingleton` llamado dos veces te deja el validador duplicado.
4. **Encadena `.ValidateOnStart()`** al builder, o empieza desde `AddOptionsWithValidateOnStart<TOptions>()` para no poder olvidarlo.
5. **Ejecuta el host.** `ValidateOnStart` no hace nada hasta que se ejecuta `Host.StartAsync`. Construir el host no basta.

Aquí está todo de principio a fin.

```csharp
// .NET 11, C# 14
using System.ComponentModel.DataAnnotations;

public sealed class PaymentOptions
{
    public const string SectionName = "Payments";

    [Required]
    public required string ApiKey { get; set; }

    [Required]
    [Url]
    public required string Endpoint { get; set; }

    [Range(1, 120)]
    public int TimeoutSeconds { get; set; } = 30;

    [Range(0, 10)]
    public int MaxRetries { get; set; } = 3;
}
```

El validador. Fíjate en que recopila fallos en vez de salir con el primero, de modo que quien esté arreglando un `appsettings.json` roto obtiene la lista completa en un solo arranque en lugar de un error por reinicio:

```csharp
// .NET 11, C# 14
using Microsoft.Extensions.Options;

public sealed class ValidatePaymentOptions : IValidateOptions<PaymentOptions>
{
    public ValidateOptionsResult Validate(string? name, PaymentOptions options)
    {
        var builder = new ValidateOptionsResultBuilder();

        if (string.IsNullOrWhiteSpace(options.ApiKey))
        {
            builder.AddError("ApiKey is missing.", nameof(PaymentOptions.ApiKey));
        }
        else if (!options.ApiKey.StartsWith("pk_", StringComparison.Ordinal))
        {
            builder.AddError(
                "ApiKey must start with 'pk_'. A secret key was probably pasted by mistake.",
                nameof(PaymentOptions.ApiKey));
        }

        if (!Uri.TryCreate(options.Endpoint, UriKind.Absolute, out Uri? endpoint)
            || endpoint.Scheme != Uri.UriSchemeHttps)
        {
            builder.AddError(
                "Endpoint must be an absolute https URI.",
                nameof(PaymentOptions.Endpoint));
        }

        // Cross-property rule: nothing in DataAnnotations can express this.
        if (options.TimeoutSeconds * (options.MaxRetries + 1) > 300)
        {
            builder.AddError(
                $"TimeoutSeconds ({options.TimeoutSeconds}) times MaxRetries + 1 "
                + $"({options.MaxRetries + 1}) exceeds the 300s gateway budget.");
        }

        return builder.Build();
    }
}
```

`ValidateOptionsResultBuilder` vive en `Microsoft.Extensions.Options` y existe precisamente para que no montes a mano un `StringBuilder`. `Build()` devuelve `ValidateOptionsResult.Success` cuando no se añadió nada, así que no hay baile de nulos al final. `AddError` acepta un nombre de propiedad opcional que se antepone al mensaje, y también existen `AddResult(ValidationResult)` y `AddResults(IEnumerable<ValidationResult>)` para llevar la salida de DataAnnotations al mismo saco.

Registro:

```csharp
// .NET 11, C# 14
using Microsoft.Extensions.DependencyInjection.Extensions;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOptionsWithValidateOnStart<PaymentOptions>()
    .Bind(builder.Configuration.GetSection(PaymentOptions.SectionName))
    .ValidateDataAnnotations();

builder.Services.TryAddEnumerable(
    ServiceDescriptor.Singleton<IValidateOptions<PaymentOptions>, ValidatePaymentOptions>());

var app = builder.Build();
await app.RunAsync();
```

`AddOptionsWithValidateOnStart<TOptions>()` es simplemente `AddOptions<TOptions>().ValidateOnStart()` con el orden hecho inolvidable. También hay una sobrecarga con dos genéricos, `AddOptionsWithValidateOnStart<TOptions, TValidateOptions>()`, que registra el validador por ti y colapsa los dos registros anteriores en una sola llamada.

`ValidateDataAnnotations()` y un `IValidateOptions<T>` escrito a mano no son excluyentes. Los atributos se ocupan de la forma de cada propiedad individual; la clase se ocupa de reglas que abarcan varias propiedades o que necesitan un servicio. Todos los validadores registrados se ejecutan y todos sus fallos se recopilan.

## Qué registra realmente ValidateOnStart

`ValidateOnStart` no ejecuta nada en el momento del registro. Lee el [código fuente del runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Options/src/OptionsBuilderExtensions.cs) de .NET 11 y verás que hace tres cosas:

```csharp
optionsBuilder.Services.TryAddTransient<IStartupValidator, StartupValidator>();
optionsBuilder.Services.TryAddTransient<IAsyncStartupValidator, StartupValidator>();
optionsBuilder.Services.AddOptions<StartupValidatorOptions>()
    .Configure<IOptionsMonitor<TOptions>>((vo, options) =>
    {
        // This adds an action that resolves the options value to force evaluation
        // We don't care about the result as duplicates are not important
        vo._validators[(typeof(TOptions), optionsBuilder.Name)] = () => options.Get(optionsBuilder.Name);
    });
```

Añade un thunk a un diccionario interno de `StartupValidatorOptions`, indexado por `(Type, name)`. El thunk llama a `IOptionsMonitor<TOptions>.Get(name)`, que es lo que fuerza a `OptionsFactory<TOptions>.Create` a ejecutar la cadena de `IConfigureOptions<T>`, luego la de `IPostConfigureOptions<T>` y luego cada `IValidateOptions<T>`. La validación es un efecto secundario de forzar el enlace.

El `TryAdd` importa. En versiones anteriores esto era `AddTransient`, así que llamar a `ValidateOnStart` sobre diez tipos de opciones metía diez copias de `StartupValidator` en el contenedor. La clave del diccionario también explica una vieja arista: indexar por `(Type, name)` es lo que hace que cada instancia con nombre tenga su propia entrada en lugar de que la última sobrescriba al resto.

El disparador está en `Host.StartAsync`, después de `IHostLifetime.WaitForStartAsync` y antes de que arranque cualquier servicio hospedado:

```csharp
IStartupValidator? validator = Services.GetService<IStartupValidator>();
validator?.Validate();

IAsyncStartupValidator? asyncValidator = Services.GetService<IAsyncStartupValidator>();
if (asyncValidator is not null)
{
    await asyncValidator.ValidateAsync(cancellationToken).ConfigureAwait(false);
}
```

Dos consecuencias que conviene interiorizar. Primera, la validación corre antes de `IHostedLifecycleService.StartingAsync`, así que un `BackgroundService` nunca observa una configuración a medio validar. Segunda, si falla más de un tipo de opciones, `StartupValidator` recopila las excepciones y las relanza como una `AggregateException`, de modo que ves todas las secciones rotas en una sola línea de registro en lugar de ir apagando fuegos entre reinicios.

## La sobrecarga Validate<TValidator>() de .NET 11

Antes de .NET 11, conectar un validador significaba dos instrucciones que debían concordar entre sí: un `AddSingleton` para el validador y una cadena `AddOptions` aparte. .NET 11 añade una sobrecarga genérica [`OptionsBuilder<TOptions>.Validate<TValidator>()`](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/libraries#options-builder-validation-improvements) que toma un parámetro de tipo en lugar de un delegado:

```csharp
// .NET 11 only
services.AddSingleton<IValidateOptions<MyOptions>, MyOptionsValidator>();
services.AddOptions<MyOptions>()
    .Bind(configuration.GetSection("MyOptions"))
    .Validate<MyOptionsValidator>();
```

El tipo del validador debe implementar `IValidateOptions<TOptions>` y ya estar registrado en el contenedor, y ese es justamente el punto: el validador se resuelve desde DI, así que puede recibir dependencias por constructor como `IHostEnvironment`, un `TimeProvider` o un `HttpClient`. Antes eso era incómodo porque las sobrecargas con delegado de `Validate` solo te dan la instancia de opciones, mientras que hasta cinco servicios inyectados solo estaban disponibles del lado de `Configure`.

No te saltes el `AddSingleton`. La sobrecarga resuelve el tipo; no lo registra.

## Validación asíncrona con IAsyncValidateOptions<T>

La incorporación interesante de .NET 11 es que la validación al arranque ya puede hacer E/S. Cierta configuración solo está mal de formas que no puedes ver sin preguntar a alguien: una cadena de conexión que se analiza bien pero apunta a una base de datos que no existe, una autoridad OIDC cuyo documento de discovery devuelve 404, un contenedor de blobs que la identidad administrada no puede leer. Antes de .NET 11 las únicas opciones honestas eran bloquear un hilo dentro de `Validate` o rendirse y comprobarlo en el primer uso.

`IAsyncValidateOptions<TOptions>` es el gemelo asíncrono de `IValidateOptions<TOptions>`:

```csharp
namespace Microsoft.Extensions.Options;

public interface IAsyncValidateOptions<in TOptions> where TOptions : class
{
    Task<ValidateOptionsResult> ValidateAsync(
        string? name, TOptions options, CancellationToken cancellationToken = default);
}
```

Una implementación que demuestra que el endpoint de pago es realmente alcanzable:

```csharp
// .NET 11 only
using Microsoft.Extensions.Options;

public sealed class ValidatePaymentEndpointAsync(IHttpClientFactory httpClientFactory)
    : IAsyncValidateOptions<PaymentOptions>
{
    public async Task<ValidateOptionsResult> ValidateAsync(
        string? name, PaymentOptions options, CancellationToken cancellationToken = default)
    {
        using HttpClient client = httpClientFactory.CreateClient();
        client.Timeout = TimeSpan.FromSeconds(5);

        try
        {
            using HttpResponseMessage response = await client.GetAsync(
                new Uri(new Uri(options.Endpoint), "/.well-known/health"), cancellationToken);

            return response.IsSuccessStatusCode
                ? ValidateOptionsResult.Success
                : ValidateOptionsResult.Fail(
                    $"Payment endpoint {options.Endpoint} returned {(int)response.StatusCode}.");
        }
        catch (HttpRequestException ex)
        {
            return ValidateOptionsResult.Fail(
                $"Payment endpoint {options.Endpoint} is unreachable: {ex.Message}");
        }
    }
}
```

Regístralo igual que el síncrono, con `TryAddEnumerable` contra `IAsyncValidateOptions<PaymentOptions>`, y mantén la llamada a `ValidateOnStart()`. El registro en `OptionsBuilderExtensions` materializa cualquier `IAsyncValidateOptions<TOptions>` registrado en un segundo diccionario, `_asyncValidators`, y solo instala el delegado asíncrono si existe al menos uno. Si no hay ninguno registrado, nada cambia y no hay coste asíncrono.

Dos comportamientos que conviene prever. Los validadores asíncronos solo se ejecutan al arranque: la canalización asíncrona cuelga de `IAsyncStartupValidator`, no de `IOptionsFactory`, así que un acceso perezoso posterior a `.Value` nunca los dispara. Y la etapa 2 solo corre si la etapa 1 tuvo éxito, lo cual es deliberado. No tiene sentido gastar cinco segundos en sondeos de red cuando la URL del endpoint ya falló su atributo `[Url]`.

El trabajo correspondiente en DataAnnotations llegó al mismo tiempo: `AsyncValidationAttribute` con un `IsValidAsync` sobrescribible, `IAsyncValidatableObject` en el modelo, y `Validator.ValidateObjectAsync` / `TryValidateObjectAsync` / `ValidatePropertyAsync` / `ValidateValueAsync`. Recurre a esos si quieres expresar la regla como un atributo sobre la propiedad en lugar de como una clase aparte.

## Sáltate el validador escrito a mano con [OptionsValidator]

Si todas tus reglas son atributos de DataAnnotations, no escribas el método `Validate` en absoluto. El generador de código fuente de validación de opciones escribe una implementación de `IValidateOptions<T>` por ti en tiempo de compilación:

```csharp
// .NET 8 and later
using Microsoft.Extensions.Options;

[OptionsValidator]
public sealed partial class ValidatePaymentOptions : IValidateOptions<PaymentOptions>
{
}
```

Una clase parcial vacía más el atributo, y el generador emite un `Validate(string?, PaymentOptions)` que llama a `Validator.TryValidateValue` por cada propiedad con instancias estáticas de atributos preasignadas, recopilando en un `ValidateOptionsResultBuilder`. Sin reflexión sobre el tipo de opciones en runtime, que es por lo que esta es la forma correcta para Native AOT. El generador está activo por defecto siempre que el proyecto referencie `Microsoft.Extensions.Options` 8.0 o posterior, y `ValidateDataAnnotations()` se vuelve redundante en cuanto lo usas. También sustituye `RangeAttribute`, `MinLengthAttribute`, `MaxLengthAttribute` y `LengthAttribute` por equivalentes sin reflexión en el código generado. Si quieres más contexto sobre lo que un generador hace con tu compilación, mira el recorrido sobre [qué es un generador de código fuente y cuándo lo necesitas](/es/2026/06/what-is-a-source-generator-and-when-do-i-need-one/), y las notas sobre [código seguro para el recorte](/es/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/) para entender por qué importa validar sin reflexión.

Por defecto la validación de DataAnnotations no es recursiva. Un objeto de opciones anidado o una `List<T>` de subopciones no se valida a menos que lo indiques, con `[ValidateObjectMembers]` y `[ValidateEnumeratedItems]` respectivamente. Ambos funcionan con el generador.

## Dónde ValidateOnStart no hace nada en silencio

El modo de fallo que nadie detecta en revisión es que `ValidateOnStart` esté registrado pero nunca se ejecute. Tres casos:

**Nunca arrancas el host.** Una prueba o herramienta que llama a `builder.Build()` y resuelve servicios desde `host.Services` sin `StartAsync` se salta la validación por completo. Si quieres una comprobación en una prueba de integración, resuelve las opciones explícitamente con `GetRequiredService<IOptions<T>>().Value` dentro de un `try`, o llama directamente a `host.Services.GetService<IStartupValidator>()?.Validate()`.

**El host no es el de `Microsoft.Extensions.Hosting`.** El punto de llamada citado arriba vive en `Host.StartAsync`. Los runtimes que construyen su propio host, el más famoso el modelo in-process de Azure Functions, nunca llegan ahí, que es exactamente [dotnet/runtime#96034](https://github.com/dotnet/runtime/issues/96034). El modelo de worker aislado es un host genérico normal y funciona. En cualquier cosa poco habitual, verifícalo con una sección rota a propósito en lugar de asumirlo.

**Registraste el validador pero no el builder.** `services.Configure<T>(section)` más un registro de validador solo te da validación perezosa. `Configure<T>` no crea un `OptionsBuilder<T>`, así que no hay nada a lo que encadenar `ValidateOnStart`. Necesitas `AddOptions<T>().Bind(section)` o `AddOptionsWithValidateOnStart<T>().Bind(section)`.

Uno más que no es silencioso pero es fácil de malinterpretar: los validadores se ejecutan por instancia con nombre. Si tienes tres `PaymentOptions` con nombre y solo llamas a `AddOptions<PaymentOptions>("primary").ValidateOnStart()`, las otras dos se validan de forma perezosa. Cada nombre necesita su propia cadena. Cuando conectas varias variantes de la misma clase de configuración, esto encaja de forma natural con los [servicios con clave en la DI de .NET 11](/es/2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection/) para los consumidores.

## Qué hacer con la excepción

`OptionsValidationException` lleva `OptionsType`, `OptionsName` y `Failures` como un `IEnumerable<string>`. Su `Message` son los fallos unidos por `;`, lo cual está bien en el registro de un contenedor y es ilegible en una terminal. Si la aplicación es una CLI o un servicio orientado a desarrolladores, capturarla en la parte alta de `Main` y escribir un fallo por línea es una pequeña cortesía:

```csharp
// .NET 11, C# 14
try
{
    await app.RunAsync();
}
catch (OptionsValidationException ex)
{
    Console.Error.WriteLine($"Invalid configuration for {ex.OptionsType.Name}:");
    foreach (string failure in ex.Failures)
    {
        Console.Error.WriteLine($"  - {failure}");
    }
    return 78; // EX_CONFIG
}
```

Envuélvelo también en un `catch (AggregateException agg)` si validas más de un tipo de opciones, ya que así es como `StartupValidator` expone varios fallos.

La validación al arranque es el trabajo de fiabilidad más barato disponible en una aplicación .NET. Es una llamada a un método sobre un builder que ya tienes, y convierte toda una categoría de incidente en producción, el despliegue mal configurado, en un fallo de arranque que tu proceso de despliegue ya sabe manejar.

## Relacionados

- [IOptions&lt;T&gt; vs IOptionsSnapshot&lt;T&gt; vs IOptionsMonitor&lt;T&gt; en .NET 11](/es/2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11/) elige el accesor correcto antes de validarlo.
- [Fix: Cannot consume scoped service from singleton](/es/2026/05/fix-cannot-consume-scoped-service-from-singleton/) cubre el error de dependencia cautiva con el que te toparás si un validador recibe una dependencia scoped.
- [Fix: No connection string named 'DefaultConnection' could be found](/es/2026/05/fix-no-connection-string-named-defaultconnection/) es el fallo clásico de configuración perezosa que la validación al arranque previene.
- [¿Qué es un generador de código fuente y cuándo lo necesito?](/es/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) explica qué hace `[OptionsValidator]` en tiempo de compilación.
- [¿Qué es el contrato IHostedService y cuándo lo uso?](/es/2026/07/what-is-the-ihostedservice-contract-and-when-do-i-use-it/) muestra qué se ejecuta justo después de que pasa la validación.

## Fuentes

- [Options pattern in .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/options) en MS Learn, para `ValidateOnStart`, `AddOptionsWithValidateOnStart` y los atributos de validación recursiva.
- [Compile-time options validation source generation](https://learn.microsoft.com/en-us/dotnet/core/extensions/options-validation-generator) para `[OptionsValidator]` y la salida generada.
- [What's new in .NET libraries for .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/libraries) para la sobrecarga `Validate<TValidator>()` y la validación asíncrona con DataAnnotations.
- [`OptionsBuilderExtensions.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Options/src/OptionsBuilderExtensions.cs) e [`IAsyncValidateOptions.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Options/src/IAsyncValidateOptions.cs) en dotnet/runtime.
- [dotnet/runtime#96034](https://github.com/dotnet/runtime/issues/96034), `ValidateOnStart()` does not work in Azure Functions.
