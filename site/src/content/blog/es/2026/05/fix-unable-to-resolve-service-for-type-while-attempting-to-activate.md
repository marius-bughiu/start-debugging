---
title: "Solución: Unable to resolve service for type 'X' while attempting to activate 'Y'"
description: "ASP.NET Core lanza esta excepción cuando un constructor pide un tipo que nunca se registró, se registró en el contenedor equivocado, o se agregó después de construir el host. Tres soluciones concretas cubren casi todos los casos."
pubDate: 2026-05-10
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "dependency-injection"
lang: "es"
translationOf: "2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate"
translatedBy: "claude"
translationDate: 2026-05-10
---

La solución: el `ActivatorUtilities` de ASP.NET Core recorrió el constructor de `Y`, le pidió al `IServiceProvider` un `X`, y no obtuvo nada. O bien olvidaste llamar a `services.AddScoped<X, XImpl>()` (o `AddSingleton` / `AddTransient`), registraste la implementación pero pediste una interfaz o clase base que el contenedor no conoce, o el registro vive en un `IServiceCollection` distinto del que el host realmente construyó. Agrega el registro faltante en `Program.cs` antes de `builder.Build()` y verifica que los nombres de los tipos coincidan exactamente.

```text
System.InvalidOperationException: Unable to resolve service for type 'MyApp.Data.IUserRepository' while attempting to activate 'MyApp.Api.Controllers.UsersController'.
   at Microsoft.Extensions.DependencyInjection.ActivatorUtilities.ConstructorMatcher.CreateInstance(IServiceProvider provider)
   at Microsoft.Extensions.DependencyInjection.ActivatorUtilities.CreateInstance(IServiceProvider provider, Type instanceType, Object[] parameters)
   at Microsoft.AspNetCore.Mvc.Controllers.ServiceBasedControllerActivator.Create(ControllerContext context)
   at Microsoft.AspNetCore.Mvc.Controllers.ControllerActivatorProvider.<>c__DisplayClass4_0.<CreateActivator>b__0(ControllerContext controllerContext)
   at Microsoft.AspNetCore.Mvc.Infrastructure.ControllerActionInvoker.Next(State& next, Scope& scope, Object& state, Boolean& isCompleted)
```

Esta guía está escrita contra .NET 11 preview 4, `Microsoft.AspNetCore.App` 11.0.0-preview.4 y `Microsoft.Extensions.DependencyInjection` 11.0.0-preview.4. El texto de la excepción ha sido estable desde ASP.NET Core 2.1, así que cada solución a continuación se aplica limpiamente hasta .NET Core 3.1, .NET 5, 6, 8 y 10.

Los dos nombres de tipo en el mensaje son la parte más útil: el **primer** nombre (`X`) es el tipo que el contenedor no pudo encontrar, y el **segundo** nombre (`Y`) es el consumidor que lo pidió. Léelos en ese orden antes de hacer cualquier otra cosa, porque la consulta de búsqueda que te trajo aquí va a coincidir con la mitad equivocada del mensaje la mitad de las veces.

## Por qué el contenedor no pudo encontrar el tipo

Tres causas explican casi todas las ocurrencias:

1. **No hay nada registrado para ese tipo.** Escribiste `public UsersController(IUserRepository repo)` pero nunca llamaste a `services.AddScoped<IUserRepository, UserRepository>()`. El contenedor no tiene ningún mapeo de la interfaz a la implementación.
2. **Registraste con la clave equivocada.** Llamaste a `services.AddScoped<UserRepository>()` (tipo concreto) pero el controlador pide `IUserRepository` (interfaz). El contenedor solo resuelve lo que registraste, por el tipo exacto usado como parámetro genérico o argumento `serviceType`.
3. **Registraste en un `IServiceCollection` distinto.** Común en pruebas donde el host de pruebas construye su propia colección, o en casos inusuales donde mutas `builder.Services` después de `builder.Build()`. El host hace una instantánea de la colección en el momento de la compilación.

Hay algunas variantes menos comunes que vale la pena nombrar: un tipo genérico abierto registrado sin el tipo cerrado correspondiente (`AddScoped(typeof(IRepo<>), typeof(Repo<>))` está bien; `AddScoped<IRepo<User>>(...)` no es el mismo registro), un servicio `keyed` solicitado por un consumidor sin clave, y un `Action` o delegado factory pasado a un constructor que la inyección de dependencias no puede sintetizar. Cubre primero las tres principales.

## Reproducción mínima

Esta es la API mínima de .NET 11 más pequeña que lanza la excepción:

```csharp
// .NET 11 preview 4, Microsoft.AspNetCore.App 11.0.0-preview.4
using Microsoft.AspNetCore.Builder;

var builder = WebApplication.CreateBuilder(args);

// Notice: no services.AddScoped<IUserRepository, UserRepository>();

builder.Services.AddControllers();

var app = builder.Build();
app.MapControllers();
app.Run();

public interface IUserRepository
{
    string GetName(int id);
}

public sealed class UserRepository : IUserRepository
{
    public string GetName(int id) => $"user-{id}";
}
```

```csharp
// .NET 11 preview 4
using Microsoft.AspNetCore.Mvc;

[ApiController]
[Route("users")]
public sealed class UsersController(IUserRepository repo) : ControllerBase
{
    [HttpGet("{id:int}")]
    public IActionResult Get(int id) => Ok(repo.GetName(id));
}
```

Llama a `GET /users/1` y la solicitud falla con la excepción de la sección anterior. El contenedor nunca vio `IUserRepository`, así que cuando el `ServiceBasedControllerActivator` de MVC intenta construir el controlador, el parámetro del constructor no puede satisfacerse.

## Solución uno: registra el servicio faltante

Lo primero que hay que probar, y la respuesta el 80% de las veces:

```csharp
// .NET 11 preview 4
builder.Services.AddScoped<IUserRepository, UserRepository>();
```

Elige el tiempo de vida que coincida con cómo se usa el servicio:

- `AddScoped` es el valor predeterminado adecuado para cualquier cosa que toque estado por solicitud (un `DbContext` de EF Core, un envoltorio de `HttpContext` accessor, un resolvedor de inquilinos). Una instancia por ámbito de solicitud.
- `AddSingleton` es para estado compartido sin estado o seguro para hilos (cachés, opciones, clientes HTTP a través de `IHttpClientFactory`). Una instancia por proceso.
- `AddTransient` es para objetos baratos y sin estado de los que quieres una copia nueva cada vez (`IValidator<T>`, mapeadores). Nueva instancia por resolución.

Equivócate aquí y cambias la excepción de hoy por la `InvalidOperationException: Cannot consume scoped service ... from singleton ...` de mañana, o peor, por un bug silencioso de seguridad de hilos donde dos solicitudes comparten un `DbContext`. La guía oficial en la [documentación de Microsoft.Extensions.DependencyInjection](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection-guidelines) es la referencia; usa `AddScoped` como predeterminado cuando dudes y exista un ámbito de solicitud.

## Solución dos: registra el tipo de servicio que el constructor realmente pide

Si tienes un registro pero aún así obtienes la excepción, el tipo registrado y el tipo consumido no coinciden. Verifica el constructor contra el registro:

```csharp
// Wrong: only the concrete type is registered
builder.Services.AddScoped<UserRepository>();

// Right: register both the interface and the implementation,
// or just the interface mapped to the implementation
builder.Services.AddScoped<IUserRepository, UserRepository>();
```

El contenedor no realiza inferencia de interfaces. Si `UserRepository` implementa `IUserRepository`, registrar solo `UserRepository` no registra `IUserRepository`. Si el consumidor pide la interfaz, registra la interfaz.

Si genuinamente necesitas ambos ("inyecta `UserRepository` aquí, pero `IUserRepository` allá"), registra los dos y reenvía la interfaz al concreto:

```csharp
// .NET 11 preview 4
builder.Services.AddScoped<UserRepository>();
builder.Services.AddScoped<IUserRepository>(sp => sp.GetRequiredService<UserRepository>());
```

Este patrón importa para servicios alojados y el patrón de opciones, donde los consumidores a veces piden el `MyOptions` concreto y a veces `IOptions<MyOptions>`.

## Solución tres: registra antes de que se construya el host

`builder.Build()` es la línea de corte. Cualquier cosa que agregues a `builder.Services` después de ese punto se descarta silenciosamente para el host en ejecución:

```csharp
// .NET 11 preview 4
var builder = WebApplication.CreateBuilder(args);

var app = builder.Build();

// Too late. The container was snapshotted in builder.Build().
builder.Services.AddScoped<IUserRepository, UserRepository>();

app.MapControllers();
app.Run();
```

Reordena para que cada registro se ejecute antes de `Build`. Este patrón muerde con más frecuencia cuando una refactorización mueve una llamada `Add*` a un método, y el método se llama desde el lugar equivocado. Un patrón útil es poner cada llamada `services.Add*` dentro de un método de extensión sobre `IServiceCollection` y llamarlo desde un solo lugar cerca del inicio de `Program.cs`:

```csharp
// .NET 11 preview 4
public static class DependencyInjectionExtensions
{
    public static IServiceCollection AddDataServices(this IServiceCollection services)
    {
        services.AddScoped<IUserRepository, UserRepository>();
        services.AddScoped<IOrderRepository, OrderRepository>();
        return services;
    }
}

// Program.cs
builder.Services.AddDataServices();
var app = builder.Build();
```

En las pruebas de integración contra `WebApplicationFactory<TEntryPoint>`, la regla equivalente es que `ConfigureTestServices` se ejecuta antes de que se construya el host de pruebas. Si mutas el contenedor desde el cuerpo de un método de prueba después de `factory.CreateClient()`, estás mutando una colección descartada.

## Variantes que parecen el mismo error

Varias parecidas se resuelven de manera diferente y desperdician tiempo si las tratas como el mismo bug:

- **`Cannot consume scoped service '<X>' from singleton '<Y>'`**. El registro existe, pero el tiempo de vida es incorrecto. La solución es hacer `Y` scoped, o tomar `IServiceScopeFactory` / `IServiceProvider` en `Y` y crear un ámbito a demanda. Cubierto en [el problema de captura singleton-a-scoped](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/).
- **`No service for type 'IOptions<MyOptions>' has been registered`**. La misma causa raíz, mensaje diferente: omitiste `services.Configure<MyOptions>(...)` o `services.AddOptions<MyOptions>().Bind(...)`. Agregar `Configure` registra `IOptions<MyOptions>` gratis.
- **`Implementation type 'X' can't be converted to service type 'Y'`**. Escribiste `services.AddScoped(typeof(IFoo), typeof(Bar))` y `Bar` no implementa `IFoo`. El compilador no puede atrapar esto porque ambos argumentos son `Type`. Corrige el tipo o usa la sobrecarga genérica.
- **`A suitable constructor for type 'X' could not be located`**. El tipo está registrado pero la inyección de dependencias no puede construirlo: cada parámetro de constructor público debe ser resoluble, y debe haber exactamente un constructor (o `[ActivatorUtilitiesConstructor]` en el elegido). Esto no es el error `Unable to resolve service`.
- **Servicios keyed**: en .NET 8 y posteriores, `AddKeyedScoped<IFoo, Foo>("primary")` requiere `[FromKeyedServices("primary")] IFoo foo` en el consumidor. Pedir un `IFoo` simple lanzará la excepción de resolución de servicio aunque exista un registro keyed. Los dos espacios de nombres están separados.

## Cómo confirmar que el registro está correctamente conectado

Tres comprobaciones rápidas le ganan a cualquier cantidad de adivinación:

1. **`IServiceProvider.GetService<T>()` desde la consola de desarrollo.** Coloca una sola línea justo después de `app.Build()` y antes de `app.Run()`:

   ```csharp
   // .NET 11 preview 4 - remove before commit
   using (var scope = app.Services.CreateScope())
   {
       var repo = scope.ServiceProvider.GetService<IUserRepository>();
       Console.WriteLine(repo is null ? "NOT REGISTERED" : repo.GetType().FullName);
   }
   ```

   Si `GetService<T>()` devuelve `null`, el registro falta o está scoped a un contenedor distinto. `GetRequiredService<T>()` lanzaría la misma `InvalidOperationException` que estás depurando.

2. **Valida los ámbitos al inicio.** Pasa `ValidateScopes = true` y `ValidateOnBuild = true` a la factory del proveedor de servicios y el host se negará a iniciar si algún registro está roto:

   ```csharp
   // .NET 11 preview 4
   builder.Host.UseDefaultServiceProvider(options =>
   {
       options.ValidateScopes = true;
       options.ValidateOnBuild = true;
   });
   ```

   `ValidateOnBuild` recorre cada registro una vez en el momento de la compilación y falla rápido si algún parámetro de constructor no se puede satisfacer. En el entorno de desarrollo ASP.NET Core habilita esto por ti, razón por la cual la excepción a menudo aparece en el momento en que inicias la aplicación en lugar del momento en que llegas a un endpoint.

3. **Imprime los registros.** Cuando el registro parece correcto pero la excepción sigue dispararse, vuelca la colección misma antes de `Build`:

   ```csharp
   // .NET 11 preview 4
   foreach (var sd in builder.Services.Where(s => s.ServiceType.Name.Contains("UserRepository")))
   {
       Console.WriteLine($"{sd.Lifetime}: {sd.ServiceType.FullName} -> {sd.ImplementationType?.FullName ?? "factory"}");
   }
   ```

   Esto atrapa el caso donde registraste `MyApp.OldNamespace.IUserRepository` y el controlador importa `MyApp.NewNamespace.IUserRepository`. El mensaje de la excepción muestra el espacio de nombres completo, pero el ojo se desliza por encima.

## Casos límite que atrapan a desarrolladores experimentados

Algunos patrones disparan esta excepción en código que parece correcto a la inspección:

- **`IConfiguration` inyectado en una callback `Configure<TOptions>`**. La callback se ejecuta perezosamente. Si referencias un servicio dentro de la callback que más tarde se elimina, la excepción se dispara la primera vez que se resuelven las opciones, no al inicio.
- **Servicios en segundo plano que resuelven dependencias scoped en su constructor**. Un `BackgroundService` es un singleton. Su constructor no puede pedir un `IUserRepository` si este último es scoped. Inyecta `IServiceScopeFactory`, crea un ámbito dentro de `ExecuteAsync` y resuelve desde el ámbito.
- **Servicios alojados genéricos**. `services.AddHostedService<MyHostedService<MyArg>>()` requiere que el genérico cerrado `MyHostedService<MyArg>` sea construible por inyección de dependencias, lo que significa que `MyArg` también debe ser resoluble. Los genéricos abiertos necesitan `services.AddTransient(typeof(IRepo<>), typeof(Repo<>))`.
- **Contenedores de inyección de dependencias generados por código fuente**. Strawberry Shake, Refit y los generadores de código fuente de gRPC a veces registran sus propios clientes con `IServiceCollection`. Si llamas a su extensión `Add*` después de `Build`, se aplica la misma regla de descarte silencioso.
- **Compilaciones Native AOT**. El contenedor predeterminado compatible con trimming en .NET 11 todavía resuelve a través de reflexión por defecto. Si publicas con `<PublishTrimmed>true</PublishTrimmed>` y el trimmer elimina el tipo de implementación, verás la excepción de resolución de servicio en tiempo de ejecución aunque el código compile bien. La solución es `[DynamicDependency]` o registrar el tipo a través de una factory tipada.

## Relacionado

- Conectar el registro de eventos y la inyección de dependencias juntos limpiamente: [registro estructurado con Serilog y Seq en .NET 11](/es/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/).
- La siguiente excepción que vas a encontrar después de esta si eliges el tiempo de vida equivocado: [singleton consumiendo DbContext scoped](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/).
- Un mal uso relacionado de EF Core que aparece cuando la inyección de dependencias entrega el mismo `DbContext` a dos solicitudes: [a second operation was started on this context instance](/es/2026/05/fix-second-operation-was-started-on-this-context-instance/).
- Intercambios de inyección de dependencias en pruebas que evitan esta excepción registrando un fake: [factory de DbContext en pool en pruebas de EF Core 11](/es/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/).
- Para el modo de fallo relacionado de `IConfiguration`: [no connection string named 'DefaultConnection' could be found](/es/2026/05/fix-no-connection-string-named-defaultconnection/).

## Fuentes

- Microsoft Learn, [Dependency injection in .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection).
- Microsoft Learn, [Dependency injection guidelines](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection-guidelines).
- Microsoft Learn, [Keyed services in .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection#keyed-services).
- Microsoft Learn, [Use scope validation](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection-usage#scope-validation).
- ASP.NET Core source, [`ActivatorUtilities.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.DependencyInjection.Abstractions/src/ActivatorUtilities.cs) donde se lanza la excepción.
