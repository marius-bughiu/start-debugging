---
title: "Cómo registrar y resolver servicios con clave en la inyección de dependencias de .NET 11"
description: "Registra varias implementaciones del mismo tipo de servicio bajo una clave con AddKeyedSingleton/Scoped/Transient y luego resuélvelas con [FromKeyedServices], GetRequiredKeyedService o KeyedService.AnyKey. Los registros con clave y sin clave son tablas separadas, y ese es el detalle que confunde a casi todos."
pubDate: 2026-06-23
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "dependency-injection"
  - "aspnetcore"
lang: "es"
translationOf: "2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection"
translatedBy: "claude"
translationDate: 2026-06-23
---

El contenedor de inyección de dependencias integrado en .NET puede contener varias implementaciones del mismo tipo de servicio y distinguirlas por una clave. Registras cada una con `AddKeyedSingleton`, `AddKeyedScoped` o `AddKeyedTransient`, pasando una clave de tipo `object` (lo habitual es una cadena o un enum), y recuperas una concreta con `[FromKeyedServices("key")]` sobre un parámetro de constructor o de handler, o con `provider.GetRequiredKeyedService<T>("key")`. El único hecho que confunde a todo el mundo: los registros con clave y sin clave viven en dos tablas separadas. Un `GetService<T>()` normal nunca verá un registro con clave, y `[FromKeyedServices]` nunca verá uno sin clave. Esta guía está escrita contra .NET 11 (preview 5 en el momento de escribir, con disponibilidad general prevista para noviembre de 2026) y `Microsoft.Extensions.DependencyInjection` 11.0.0. Los servicios con clave llegaron en .NET 8 y la API ha sido estable desde entonces, así que todos los patrones de aquí también funcionan sin cambios en .NET 8 y .NET 10.

## Por qué darle una clave a un servicio en lugar de crear una nueva interfaz

La forma antigua de registrar dos implementaciones de `IPaymentGateway` era inventar dos interfaces (`IStripeGateway`, `IPayPalGateway`) o registrar un delegado de fábrica que decidía según una cadena. Ambas filtran el mecanismo de selección hacia tu sistema de tipos. Los servicios con clave dejan la interfaz en singular y mueven el discriminador al registro, que es exactamente donde corresponde una decisión tomada en tiempo de despliegue o de configuración.

Los casos canónicos:

- **Varios proveedores tras un mismo contrato.** Dos pasarelas de pago, tres canales de notificación, un cliente HTTP principal y otro de respaldo, cada uno registrado bajo una clave y seleccionado por punto de llamada.
- **Cachés o conexiones con nombre.** Una caché de vida corta y otra de vida larga, ambas con forma de `IMemoryCache`, con clave `"short"` y `"long"`.
- **Búsqueda de estrategias en tiempo de ejecución.** Un diccionario de estrategias donde la clave se calcula a partir de una solicitud, resuelta a través de `IKeyedServiceProvider` en lugar de un `switch` hecho a mano.

Si solo vas a tener una implementación, no recurras a una clave. El registro con clave añade un discriminador que luego tienes que mantener sincronizado entre el sitio de registro y cada sitio de resolución. Úsalo cuando la multiplicidad sea real.

## Registrar servicios con clave

Cada método de registro sin clave tiene un gemelo con clave que toma un `serviceKey` como primer argumento. Aquí tienes toda la superficie en un solo bloque.

```csharp
// .NET 11, C# 14 - Program.cs
using Microsoft.Extensions.DependencyInjection;

var builder = WebApplication.CreateBuilder(args);

// Two implementations of the same interface, told apart by a string key.
builder.Services.AddKeyedSingleton<IPaymentGateway, StripeGateway>("stripe");
builder.Services.AddKeyedSingleton<IPaymentGateway, PayPalGateway>("paypal");

// Lifetimes work exactly as their non-keyed counterparts.
builder.Services.AddKeyedScoped<IReportBuilder, PdfReportBuilder>("pdf");
builder.Services.AddKeyedTransient<IReportBuilder, CsvReportBuilder>("csv");

// A factory overload gives you the key and the provider, useful when the
// implementation needs to read its own key or build from config.
builder.Services.AddKeyedSingleton<IClock>("utc", (sp, key) => new SystemClock(DateTimeKind.Utc));

var app = builder.Build();
```

La clave es un `object`, comparado con `Equals`. Las cadenas son la opción habitual porque sobreviven a un ida y vuelta por `appsettings.json`, pero un enum es más limpio cuando el conjunto es cerrado y conocido en tiempo de compilación:

```csharp
// .NET 11, C# 14 - enum keys avoid stringly-typed lookups
public enum Channel { Email, Sms, Push }

builder.Services.AddKeyedScoped<INotifier, EmailNotifier>(Channel.Email);
builder.Services.AddKeyedScoped<INotifier, SmsNotifier>(Channel.Sms);
builder.Services.AddKeyedScoped<INotifier, PushNotifier>(Channel.Push);
```

Puedes registrar el mismo tipo de implementación bajo varias claves, y puedes registrar más de una implementación bajo la **misma** clave. El segundo caso se convierte en una resolución de `IEnumerable<T>`, que se cubre más abajo.

## Resolver un servicio con clave de tres formas

### Inyección por constructor con `[FromKeyedServices]`

El atributo vive en `Microsoft.Extensions.DependencyInjection` y marca un único parámetro de constructor para que el contenedor lo resuelva desde la tabla con clave. Esta es la forma que quieres en servicios y controladores ordinarios porque mantiene al consumidor libre de cualquier referencia a `IServiceProvider`.

```csharp
// .NET 11, C# 14
public sealed class CheckoutService(
    [FromKeyedServices("stripe")] IPaymentGateway gateway)
{
    public Task<string> ChargeAsync(decimal amount) => gateway.ChargeAsync(amount);
}
```

El mismo atributo funciona sobre un parámetro de handler de una minimal API, que es la forma más limpia de enlazar una dependencia con clave a un endpoint:

```csharp
// .NET 11, C# 14 - keyed dependency straight into a minimal API handler
app.MapPost("/charge/{provider}",
    ([FromKeyedServices("stripe")] IPaymentGateway gateway, decimal amount)
        => gateway.ChargeAsync(amount));
```

También funciona sobre un parámetro de acción de un controlador MVC y sobre un parámetro de constructor de un controlador, en ambos casos sin ningún registro adicional.

### Resolución imperativa con `GetRequiredKeyedService`

Cuando la clave solo se conoce en tiempo de ejecución (calculada a partir de una solicitud, leída desde configuración), no puedes usar un atributo de tiempo de compilación. Inyecta `IServiceProvider` y llama a los métodos de extensión con clave. El proveedor producido por `Build()` implementa `IKeyedServiceProvider`, así que estos siempre funcionan contra el contenedor por defecto.

```csharp
// .NET 11, C# 14 - the key is decided at runtime
public sealed class PaymentRouter(IServiceProvider services)
{
    public Task<string> ChargeAsync(string providerKey, decimal amount)
    {
        // Throws InvalidOperationException if nothing is registered under the key.
        var gateway = services.GetRequiredKeyedService<IPaymentGateway>(providerKey);
        return gateway.ChargeAsync(amount);
    }
}
```

Usa `GetKeyedService<T>(key)` (sin "Required") cuando un registro ausente sea un resultado normal y no excepcional; devuelve `null` en lugar de lanzar. Dentro de un consumidor scoped, resuelve desde el proveedor scoped para que la instancia scoped con clave tenga el alcance correcto. Si estás recurriendo a un scope dentro de un singleton como un `BackgroundService`, se aplica la misma disciplina de `IServiceScopeFactory` que para cualquier [servicio scoped dentro de un BackgroundService](/es/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/): el hecho de que el registro tenga clave no cambia las reglas de tiempo de vida.

### Resolver todas las implementaciones bajo una clave

Registra más de una implementación bajo la misma clave y resuélvelas como un conjunto:

```csharp
// .NET 11, C# 14
builder.Services.AddKeyedSingleton<IValidationRule, NotEmptyRule>("order");
builder.Services.AddKeyedSingleton<IValidationRule, PositiveAmountRule>("order");

public sealed class OrderValidator(
    [FromKeyedServices("order")] IEnumerable<IValidationRule> rules)
{
    public bool IsValid(Order o) => rules.All(r => r.Check(o));
}
```

`GetKeyedServices<IValidationRule>("order")` es el equivalente imperativo y devuelve ambas implementaciones en orden de registro.

## Coincidir con cualquier clave usando `KeyedService.AnyKey`

A veces quieres un registro que responda por *cada* clave, con la implementación leyendo la clave bajo la que fue resuelta. Para eso está `KeyedService.AnyKey`. Combínalo con un parámetro `[ServiceKey]` para que la implementación reciba la clave real en tiempo de construcción.

```csharp
// .NET 11, C# 14 - one registration that serves any key
builder.Services.AddKeyedSingleton<ITenantStore>(
    KeyedService.AnyKey,
    (sp, key) => new TenantStore((string)key!));

public sealed class TenantStore : ITenantStore
{
    public TenantStore(string tenantId) => TenantId = tenantId;
    public string TenantId { get; }
}

// A consumer can ask for any tenant; the key flows into the factory.
var acme = app.Services.GetRequiredKeyedService<ITenantStore>("acme");
var globex = app.Services.GetRequiredKeyedService<ITenantStore>("globex");
```

El atributo `[ServiceKey]` sobre un parámetro de constructor funciona también sin la sobrecarga de fábrica. El contenedor inyecta la clave que se usó para resolver la instancia:

```csharp
// .NET 11, C# 14 - the implementation discovers its own key
public sealed class TenantStore(
    [ServiceKey] string tenantId,
    AppDbContext db) : ITenantStore
{
    public string TenantId => tenantId;
}

builder.Services.AddKeyedScoped<ITenantStore, TenantStore>(KeyedService.AnyKey);
```

Dos reglas gobiernan `AnyKey`. Primera: un registro con clave exacta gana sobre el registro `AnyKey` cuando ambos existen. Segunda: no puedes *resolver* con `KeyedService.AnyKey` como clave; es un centinela solo del lado del registro. Pedir `GetRequiredKeyedService<T>(KeyedService.AnyKey)` lanza una excepción.

## La separación que causa más confusión

Los registros con clave y sin clave son dos tablas distintas dentro del contenedor. Este único hecho explica casi todos los reportes de bugs del tipo "pero si lo registré":

```csharp
// .NET 11, C# 14
builder.Services.AddKeyedSingleton<IPaymentGateway, StripeGateway>("stripe");

var sp = builder.Services.BuildServiceProvider();

sp.GetService<IPaymentGateway>();                 // null - no NON-keyed registration
sp.GetKeyedService<IPaymentGateway>("stripe");    // the StripeGateway
sp.GetKeyedService<IPaymentGateway>("paypal");    // null - nothing under that key
```

Un parámetro de constructor normal `IPaymentGateway gateway` (sin atributo) resuelve solo desde la tabla sin clave y no encontrará un registro con clave. Si quieres que un servicio sea alcanzable de ambas formas, regístralo dos veces, una con clave y otra sin. La trampa inversa es igual de común: `[FromKeyedServices("stripe")]` contra un servicio registrado con un `AddSingleton` simple no resuelve a nada, porque el atributo lee solo la tabla con clave.

Esta separación es también por la que `GetServices<T>()` (el enumerable sin clave) no incluye los registros con clave. Si dependes de enumerar "todas las implementaciones", decide de antemano si tienen clave o no y mantente coherente.

## Detalles que conviene conocer antes de desplegar

**`ActivatorUtilities.CreateInstance` respeta `[FromKeyedServices]`, pero solo para los tipos que activa.** Un tipo creado por el contenedor (o por `ActivatorUtilities`) recibe sus parámetros con clave rellenados. Un tipo que tú instancias con `new` no recibe nada inyectado, ni con clave ni sin ella. Esto importa para el código de fábrica y para cualquier cosa fuera del grafo de DI.

**El `Equals` y el `GetHashCode` de la clave deben ser estables.** Las cadenas y los enums están bien. Una clave de tipo referencia mutable, o una con igualdad basada en valor que cambia con el tiempo, fallará silenciosamente en coincidir. Prefiere claves inmutables.

**La inyección con `ServiceKey` requiere el tipo correcto.** Si registras bajo una clave `string` y declaras `[ServiceKey] int id`, la construcción lanza una excepción en tiempo de resolución. Mantén el tipo del parámetro declarado asignable desde la clave con la que registraste.

**La validación corre por registro, no por clave.** Cuando `ValidateOnBuild` está activo (lo está por defecto en `Development` bajo `WebApplication.CreateBuilder`), el validador de sitios de llamada comprueba el grafo de cada registro con clave igual que el de uno sin clave. Un servicio scoped con clave capturado por un singleton sigue lanzando `Cannot consume scoped service from singleton`; tener clave no te exime de las reglas de tiempo de vida. Si llegas a chocar con un fallo de resolución, el mensaje se lee igual que en el caso sin clave, y el [fix de unable to resolve service while attempting to activate](/es/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/) recorre cómo leerlo; solo recuerda que la tabla con clave es separada cuando compruebes si el registro existe.

**Native AOT y el trimming son compatibles.** Los servicios con clave se diseñaron para ser amigables con AOT: la resolución no depende de reflexión en tiempo de ejecución sobre tus tipos, así que sobreviven al trimming sin anotaciones `DynamicallyAccessedMembers` adicionales. Si estás sopesando el modelo de despliegue, las compensaciones de [Native AOT vs ReadyToRun vs JIT](/es/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) se aplican sin cambios con registros con clave en el grafo.

**No todos los contenedores de terceros admiten claves.** El contenedor integrado sí. Si has cambiado a una versión antigua de Autofac, Lamar o DryIoc, confirma su puente de servicios con clave antes de depender de `[FromKeyedServices]`; la funcionalidad es un contrato de `Microsoft.Extensions.DependencyInjection.Abstractions` que cada contenedor tiene que implementar.

## Un ejemplo completo y funcional

Aquí está la forma de extremo a extremo: dos pasarelas con clave por nombre, un router que elige una en tiempo de ejecución a partir de la ruta, y una por defecto inyectada directamente en un handler.

```csharp
// .NET 11, C# 14 - Program.cs
using Microsoft.Extensions.DependencyInjection;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddKeyedSingleton<IPaymentGateway, StripeGateway>("stripe");
builder.Services.AddKeyedSingleton<IPaymentGateway, PayPalGateway>("paypal");
builder.Services.AddScoped<PaymentRouter>();

var app = builder.Build();

// Runtime selection: the provider name comes from the URL.
app.MapPost("/charge/{provider}",
    (string provider, decimal amount, PaymentRouter router)
        => router.ChargeAsync(provider, amount));

// Compile-time selection: this endpoint always uses Stripe.
app.MapPost("/charge-stripe",
    ([FromKeyedServices("stripe")] IPaymentGateway gateway, decimal amount)
        => gateway.ChargeAsync(amount));

app.Run();

public interface IPaymentGateway { Task<string> ChargeAsync(decimal amount); }

public sealed class PaymentRouter(IServiceProvider services)
{
    public Task<string> ChargeAsync(string key, decimal amount)
    {
        var gateway = services.GetKeyedService<IPaymentGateway>(key)
            ?? throw new ArgumentException($"Unknown gateway '{key}'", nameof(key));
        return gateway.ChargeAsync(amount);
    }
}
```

La división es intencional: el endpoint `/charge/{provider}` necesita `IServiceProvider` porque la clave es un dato, mientras que `/charge-stripe` usa el atributo porque la clave es una constante. Recurre a `[FromKeyedServices]` siempre que la clave se conozca en tiempo de compilación, y vuelve a `GetKeyedService`/`GetRequiredKeyedService` solo cuando realmente no sea así.

## Dónde encajan los servicios con clave a continuación

La DI con clave es la herramienta adecuada cuando un contrato tiene varias implementaciones reales seleccionadas por configuración o por solicitud. Es la herramienta equivocada para una sola implementación, para preocupaciones transversales mejor manejadas por el patrón options, o para una lógica de selección lo bastante compleja como para merecer su propia abstracción de fábrica. Cuando recurras a ella, mantén las claves inmutables, registra una vez por cada ruta de resolución prevista y recuerda que las tablas con clave y sin clave nunca se ven entre sí.

Para patrones adyacentes: decidir de dónde obtienen sus dependencias los endpoints forma parte de la decisión más amplia de [minimal APIs vs controladores](/es/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/), y el registro con clave combina bien con [HybridCache en ASP.NET Core 11](/es/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/) cuando quieres instancias de caché con nombre tras una sola interfaz.

## Fuentes

- [Dependency injection in .NET - keyed services](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection#keyed-services), MS Learn.
- [`ServiceCollectionServiceExtensions` keyed methods](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.servicecollectionserviceextensions), referencia de la API de .NET.
- [`FromKeyedServicesAttribute`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.fromkeyedservicesattribute) y [`ServiceKeyAttribute`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.servicekeyattribute), referencia de la API de .NET.
- [`IKeyedServiceProvider`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.ikeyedserviceprovider) y [`KeyedService.AnyKey`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.keyedservice.anykey), referencia de la API de .NET.
