---
title: "Solución: Cannot consume scoped service 'X' from singleton 'Y'"
description: "La validación de ámbitos de ASP.NET Core lanza esto cuando un singleton capturaría una dependencia scoped durante todo el proceso. Haz que el consumidor sea scoped, o toma IServiceScopeFactory y crea un ámbito bajo demanda."
pubDate: 2026-05-10
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "dependency-injection"
lang: "es"
translationOf: "2026/05/fix-cannot-consume-scoped-service-from-singleton"
translatedBy: "claude"
translationDate: 2026-05-10
---

La solución: el validador de ámbitos de ASP.NET Core bloqueó una dependencia capturada. El singleton `Y` solicitó al proveedor raíz el servicio scoped `X`, lo que ataría `X` a todo el proceso y omitiría por completo el ciclo de vida por solicitud. Cambia `Y` a scoped (preferible cuando `Y` se consume dentro de un ámbito de solicitud), o mantén `Y` como singleton e inyecta `IServiceScopeFactory`, creando un ámbito nuevo cada vez que necesites `X`. Para `DbContext` específicamente, usa `IDbContextFactory<T>`.

```text
System.InvalidOperationException: Cannot consume scoped service 'MyApp.Data.AppDbContext' from singleton 'MyApp.Workers.OrderProcessor'.
   at Microsoft.Extensions.DependencyInjection.ServiceLookup.CallSiteValidator.ValidateCallSite(ServiceCallSite callSite)
   at Microsoft.Extensions.DependencyInjection.ServiceLookup.ServiceProviderEngineScope.GetService(Type serviceType)
   at Microsoft.Extensions.DependencyInjection.ServiceProvider.GetService(Type serviceType, ServiceProviderEngineScope serviceProviderEngineScope)
   at Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.GetRequiredService(IServiceProvider provider, Type serviceType)
   at Microsoft.Extensions.Hosting.Internal.Host.StartAsync(CancellationToken cancellationToken)
```

Esta guía está escrita para .NET 11 versión preliminar 4, `Microsoft.Extensions.DependencyInjection` 11.0.0-preview.4 y `Microsoft.Extensions.Hosting` 11.0.0-preview.4. El texto de la excepción y el validador que la lanza son estables desde .NET Core 2.0, así que toda solución a continuación se aplica a .NET Core 3.1, .NET 5, 6, 8, 10 y 11 sin cambios.

Los dos nombres de tipo en el mensaje son la primera parte que tienes que leer: el **primer** nombre es el servicio **scoped**, y el **segundo** nombre es el consumidor **singleton** que lo pidió. El error siempre los nombra en ese orden, aunque los buscadores te lleven a la mitad equivocada del mensaje la mitad de las veces.

## Por qué la validación de ámbitos rechaza esta combinación

Un singleton vive una sola vez por proceso. Un servicio scoped vive una vez por ámbito de solicitud (o una vez por llamada a `IServiceScopeFactory.CreateScope()`). Si un singleton guarda una referencia a un servicio scoped en un campo, esa instancia scoped sobrevive a todas las solicitudes posteriores, anulando el propósito del ciclo de vida scoped: estado por solicitud, agrupación de conexiones por ámbito, seguimiento de cambios por ámbito, aislamiento por inquilino por ámbito.

La opción `ValidateScopes` de ASP.NET Core detecta esto en tiempo de resolución recorriendo el grafo de sitios de llamada antes de que el constructor llegue a ejecutarse. En `Development`, `WebApplication.CreateBuilder` activa `ValidateScopes` automáticamente; en `Production` no, y por eso algunos equipos solo ven la excepción en local y envían el bug capturado a producción, donde se manifiesta como datos obsoletos, fugas de conexiones o `ObjectDisposedException` en un `DbContext` que se desechó con el ámbito de la solicitud original.

Este bug toma exactamente cuatro formas:

1. **Un parámetro del constructor singleton es scoped.** El caso más común. El constructor de `BackgroundService` (singleton) pide `IUserRepository` (scoped).
2. **El parámetro del constructor singleton es a su vez singleton, pero depende transitivamente de algo scoped.** Un singleton `IFooFactory` toma un singleton `IFooDeps`, que toma un scoped `IUnitOfWork`. El validador sigue el grafo.
3. **El singleton resuelve un scoped directamente desde `IServiceProvider`.** `_provider.GetRequiredService<IUserRepository>()` desde dentro de un singleton, donde `_provider` es el proveedor **raíz**. El proveedor no tiene ámbito, así que el validador lanza la excepción.
4. **Servicio hospedado / worker de cola / callback de timer ejecutándose fuera de cualquier solicitud.** El host llama al singleton desde un hilo que no tiene ámbito ambiente, así que cualquier resolución scoped va contra el raíz.

Los tres primeros fallan al iniciar o en la primera llamada. El cuarto falla en cuanto se dispara el timer. Misma excepción, distintas rutas de depuración.

## Reproducción mínima

La aplicación de consola .NET 11 más pequeña que lanza la excepción:

```csharp
// .NET 11 preview 4, Microsoft.Extensions.Hosting 11.0.0-preview.4
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

var builder = Host.CreateApplicationBuilder(args);

builder.Services.AddScoped<IUserRepository, UserRepository>();
builder.Services.AddHostedService<OrderProcessor>();

var host = builder.Build();
await host.RunAsync();

public interface IUserRepository
{
    string GetName(int id);
}

public sealed class UserRepository : IUserRepository
{
    public string GetName(int id) => $"user-{id}";
}

public sealed class OrderProcessor(IUserRepository repo) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            Console.WriteLine(repo.GetName(1));
            await Task.Delay(TimeSpan.FromSeconds(1), stoppingToken);
        }
    }
}
```

`AddHostedService<T>` registra `OrderProcessor` como singleton. El constructor exige `IUserRepository`, que es scoped. El generador del host llama a `GetRequiredService` sobre el proveedor raíz durante `StartAsync`, el validador recorre el sitio de llamada, ve la arista de scoped a singleton y lanza la excepción.

## Solución uno: haz que el consumidor sea scoped, cuando el consumidor cabe en una solicitud

La solución más limpia cuando el consumidor se alcanza **por solicitud**. Un controlador, un manejador de endpoint de minimal API, un filtro MVC, un método de hub de SignalR: todos se ejecutan dentro de un ámbito existente. Si los registraste como singleton por accidente, cambia el registro:

```csharp
// .NET 11 preview 4
// Wrong: pulls AppDbContext into a process-wide singleton
builder.Services.AddSingleton<IOrderService, OrderService>();

// Right: scoped matches DbContext lifetime
builder.Services.AddScoped<IOrderService, OrderService>();
```

Esta solución no funciona para servicios hospedados, timers ni colas en segundo plano. No tienen un ámbito que los rodee, así que volverlos scoped no cambia nada (el host sigue resolviéndolos desde el raíz). Para esos casos usa la solución dos.

Cuando cambias un registro de singleton a scoped, audita los puntos de llamada por referencias guardadas en campos. Cualquier otro singleton que tomara `IOrderService` en su constructor fallará ahora la validación de ámbito a su vez, y la cadena se desenreda hacia arriba hasta llegar a un servicio que cabe en un ámbito de solicitud.

## Solución dos: inyecta IServiceScopeFactory y abre un ámbito por unidad de trabajo

Cuando el consumidor **debe** seguir siendo singleton, toma `IServiceScopeFactory` y crea un ámbito nuevo cada vez que hagas trabajo. Este es el patrón canónico para `BackgroundService` y cualquier consumidor a nivel de proceso:

```csharp
// .NET 11 preview 4
public sealed class OrderProcessor(IServiceScopeFactory scopeFactory) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            using var scope = scopeFactory.CreateScope();
            var repo = scope.ServiceProvider.GetRequiredService<IUserRepository>();

            Console.WriteLine(repo.GetName(1));

            await Task.Delay(TimeSpan.FromSeconds(1), stoppingToken);
        }
    }
}
```

Tres reglas para aplicar este patrón correctamente:

- **Un ámbito por unidad de trabajo**, no un ámbito por proceso. El sentido es que cada iteración reciba un `DbContext` nuevo, un seguimiento de cambios nuevo y una conexión nueva. Desechar el ámbito al final de la iteración libera los servicios scoped.
- **Resuelve desde el `ServiceProvider` del ámbito**, no desde el proveedor raíz capturado. `scope.ServiceProvider.GetRequiredService<T>()` es correcto; `_rootProvider.GetRequiredService<T>()` es el bug original.
- **No guardes servicios scoped en campos** del singleton. La instancia que resuelves dentro del ámbito no debe sobrevivir al ámbito. Si tienes que pasarla a otro método, hazlo como parámetro y deja que salga de ámbito con el `using`.

Para servicios `IAsyncDisposable` en .NET 11 (la mayoría de configuraciones modernas de `DbContext`), prefiere la forma asíncrona desechable:

```csharp
// .NET 11 preview 4
await using var scope = scopeFactory.CreateAsyncScope();
var repo = scope.ServiceProvider.GetRequiredService<IUserRepository>();
```

`CreateAsyncScope` devuelve un `AsyncServiceScope`, que desecha los servicios scoped a través de `DisposeAsync` si lo implementan. Para instancias agrupadas de `DbContext` esto importa: el desecho síncrono de un recurso solo asíncrono lanza una excepción en .NET 11 por defecto.

## Solución tres: usa IDbContextFactory específicamente para DbContext

EF Core incluye una fábrica tipada exactamente para este escenario. Regístrala en lugar de (o junto a) el `DbContext` scoped:

```csharp
// .NET 11 preview 4, Microsoft.EntityFrameworkCore 11.0.0-preview.4
builder.Services.AddDbContextFactory<AppDbContext>(options =>
    options.UseSqlServer(builder.Configuration.GetConnectionString("Default")));
```

```csharp
// .NET 11 preview 4
public sealed class OrderProcessor(IDbContextFactory<AppDbContext> dbFactory) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            await using var db = await dbFactory.CreateDbContextAsync(stoppingToken);

            var pending = await db.Orders
                .Where(o => o.Status == OrderStatus.Pending)
                .ToListAsync(stoppingToken);

            // process pending...

            await Task.Delay(TimeSpan.FromSeconds(1), stoppingToken);
        }
    }
}
```

`AddDbContextFactory` registra `IDbContextFactory<AppDbContext>` como **singleton**, y la fábrica entrega instancias frescas de `DbContext` bajo demanda. Sin desajuste de ámbito, sin `DbContext` capturado, sin ceremonia de ámbitos en tu worker. Este es el patrón que Microsoft recomienda para Blazor Server, servicios hospedados y cualquier código no atado a una solicitud que hable con EF Core. Mira la [documentación de la fábrica de DbContext](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/#using-a-dbcontext-factory-eg-for-blazor) para la guía completa.

Puedes registrar a la vez `AddDbContext` y `AddDbContextFactory` si tienes una mezcla de consumidores atados y no atados a solicitudes. Usa `AddDbContextFactory<T>(..., ServiceLifetime.Scoped)` para que la propia fábrica sea scoped si necesitas agrupación junto con scope, pero verifica que los ciclos de vida cuadren en el consumidor.

## Solución cuatro: ValidateOnBuild detecta esto al iniciar, no en la primera solicitud

Una vez que hayas aplicado una solución real arriba, activa la validación en tiempo de compilación para que el siguiente bug capturado falle rápido:

```csharp
// .NET 11 preview 4
builder.Host.UseDefaultServiceProvider(options =>
{
    options.ValidateScopes = true;
    options.ValidateOnBuild = true;
});
```

`ValidateScopes = true` fuerza al runtime a pasar cada resolución por el validador de sitios de llamada, incluso en producción. `ValidateOnBuild = true` lo hace **una vez** en el momento de `host.Build()` para cada registro del contenedor. El host se niega a iniciar si algún registro fuera a lanzar excepción en la primera resolución.

El coste es una pasada de validación una sola vez al arrancar. El beneficio es que la siguiente persona que introduzca una dependencia capturada vea el fallo durante el arranque local o en CI, no en el tráfico de producción.

Lo que **no** debes hacer, aunque los resultados de búsqueda lo sugieran: desactivar `ValidateScopes` para silenciar la excepción. Apagar la comprobación no soluciona el bug. Lo oculta. El servicio scoped se sigue atando al ciclo de vida del singleton; lo único que pasa es que dejan de avisarte. Datos obsoletos, fugas de conexiones y `ObjectDisposedException` más adelante en el proceso están garantizados.

## Variantes que parecen el mismo error pero se resuelven distinto

Algunos mensajes de error tienen aire de familia y hacen perder tiempo si los tratas igual:

- **`Unable to resolve service for type 'X' while attempting to activate 'Y'`**: falta un registro, no hay desajuste de ciclo de vida. Causa distinta, solución distinta. Se cubre en [el artículo sobre unable to resolve service](/es/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/).
- **`Cannot resolve scoped service 'X' from root provider`**: el consumidor preguntó al `IServiceProvider` **raíz** directamente (`app.Services.GetRequiredService<X>()` para un `X` scoped). La solución es la misma que para el caso del singleton: abre un ámbito primero.
- **`A circular dependency was detected for the service of type 'X'`**: el ciclo de vida está bien, pero el grafo de sitios de llamada contiene un ciclo. Busca un servicio que se tome a sí mismo o a un primo en su constructor.
- **`Cannot access a disposed object. Object name: 'AppDbContext'`**: un servicio scoped capturado que **ya** escapó de la validación de ámbitos (porque la validación estaba desactivada o el servicio se resolvió por una ruta no validada) y ahora se usa después de que el ámbito original se desechó. La solución es abrir un ámbito nuevo en el punto de llamada.

## Por qué esto golpea a los servicios hospedados más que a nada

`AddHostedService<T>` y `AddSingleton<IHostedService, T>` son el mismo registro: todo servicio hospedado es singleton. El host los resuelve desde el proveedor raíz durante `StartAsync`. Si el constructor de tu servicio hospedado toma cualquier cosa que toque la base de datos, hable con un resolutor de inquilino o envuelva `HttpContext`, será scoped, y el validador lanzará la excepción.

La misma trampa existe para:

- **Consumidores de `IHttpClientFactory` que resuelven manejadores delegantes scoped desde un singleton.** El propio `IHttpClientFactory` es singleton, pero los manejadores por solicitud pueden registrarse como scoped. Resolver el cliente nombrado desde un singleton dispara el validador.
- **Pipelines de resiliencia de Polly** registrados como scoped (que es lo predeterminado en .NET 11) y consumidos desde un singleton.
- **`IOptionsSnapshot<T>`**, que es **scoped**. Un singleton que dependa de `IOptionsSnapshot<T>` fallará la validación. Usa `IOptionsMonitor<T>` (singleton) en su lugar. El cambio es una edición de una línea en el constructor.
- **MediatR / `ISender` registrado como scoped.** `Mediator.Send` desde un servicio hospedado debe ejecutarse a través de un ámbito.
- **Interceptores de EF Core** que retienen un `IServiceProvider` capturado. Usa las sobrecargas de registro compatibles con ámbitos, no un proveedor raíz capturado.

## Casos límite que merece la pena nombrar

- **`IServiceProvider` inyectado en un singleton**. Es legal, pero el proveedor que recibes es el proveedor **raíz**. Resolver cualquier cosa scoped desde él dispara la misma excepción. Si necesitas resolver scoped, pide en su lugar `IServiceScopeFactory` y llama a `CreateScope()`.
- **Fábricas `Func<T>` registradas a mano**. Si `T` es scoped y la fábrica queda capturada por un singleton, la fábrica luce bien al inspeccionarla pero revienta la primera vez que se invoca fuera de un ámbito. Reemplaza la fábrica manual por `IServiceScopeFactory` más `GetRequiredService<T>()`.
- **Hosts de prueba que desactivan la validación de ámbitos**. `WebApplicationFactory<T>` mantiene la validación activa por defecto en .NET 8+. Si tus pruebas pasan y producción falla, comprueba que no añadiste `ValidateScopes = false` al host de pruebas.
- **Compilaciones Native AOT y con trimming**. La validación de ámbitos corre sobre el mismo contenedor predeterminado, así que AOT no cambia esta regla. El trimmer puede eliminar un tipo usado solo por reflexión en una fábrica capturada; ese síntoma es `Unable to resolve`, no la excepción de captura.
- **Servicios hospedados genéricos**. `AddHostedService<MyHostedService<MyArg>>()` sigue siendo singleton. El validador inspecciona el constructor del genérico cerrado, así que un parámetro de constructor `IRepo<MyArg>` registrado como scoped dispara la misma ruta de error.

## Relacionados

- El error de registro complementario a este: [unable to resolve service for type while attempting to activate](/es/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/).
- Un ejemplo práctico del patrón singleton-con-fábrica-de-ámbitos: [running a Semantic Kernel plugin from a BackgroundService](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/).
- La siguiente excepción de EF Core que aparece cuando un `DbContext` sobrevive a su ámbito por accidente: [a second operation was started on this context instance](/es/2026/05/fix-second-operation-was-started-on-this-context-instance/).
- Reemplazos de inyección de dependencias en pruebas sin romper la validación de ámbitos: [integration tests against a real SQL Server with Testcontainers](/es/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/).
- Un modo de fallo de configuración que suele ir junto a los bugs de ciclo de vida: [no connection string named 'DefaultConnection' could be found](/es/2026/05/fix-no-connection-string-named-defaultconnection/).

## Fuentes

- Microsoft Learn, [Dependency injection guidelines: scope validation](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection-guidelines#scope-validation).
- Microsoft Learn, [Dependency injection in .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection).
- Microsoft Learn, [Using a DbContext factory](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/#using-a-dbcontext-factory-eg-for-blazor).
- Código fuente de ASP.NET Core, [`CallSiteValidator.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.DependencyInjection/src/ServiceLookup/CallSiteValidator.cs) donde dispara la comprobación de dependencia capturada.
- Código fuente de ASP.NET Core, [`ServiceProviderEngineScope.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.DependencyInjection/src/ServiceLookup/ServiceProviderEngineScope.cs) donde se aplica la distinción raíz vs ámbito.
