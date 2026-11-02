---
title: "Migrar de MediatR a inyección de dependencias simple en .NET 11"
description: "Una lista de verificación paso a paso para eliminar MediatR 12-14 y reemplazar los handlers de IRequest, ISender, los pipeline behaviors y INotification por clases de servicio simples e inyección por constructor."
pubDate: 2026-05-30
updatedDate: 2026-11-02
template: migration
tags:
  - "migration"
  - "mediatr"
  - "dependency-injection"
  - "dotnet"
  - "dotnet-11"
lang: "es"
translationOf: "2026/05/migrate-from-mediatr-to-plain-dependency-injection"
translatedBy: "claude"
translationDate: 2026-05-30
---

Migra una solicitud cada vez. Sustituye su handler por un método de servicio, actualiza los llamadores y conserva la validación, las transacciones y las notificaciones necesarias. Estima el esfuerzo a partir de esas dependencias y llamadas antes de cambiar los registros.

**Corrección — 2 de noviembre de 2026:** se corrigieron la fase de fallo de DI y los criterios Community, se retiraron afirmaciones sin medir sobre el arranque y se ajustó el decorador al contrato de escritura.

Los ejemplos apuntan a `net11.0` e ilustran los contratos de MediatR 13/14. La comprobación de validación DI descrita abajo se ejecutó en .NET 10. Si aún estás eligiendo arquitectura, empieza por la [comparación entre MediatR y servicios directos](/es/2026/05/mediatr-vs-plain-service-classes-in-2026/).

## Por qué los equipos están eliminando MediatR justo ahora

- Inventaría las versiones de MediatR en uso y revisa los [criterios del proveedor](https://luckypennysoftware.com/faq), incluidos financiación y uso institucional, antes de tratar la licencia como motivo para migrar.
- Desde una llamada de interfaz, ir a la definición lleva al método de la interfaz y el IDE permite encontrar sus implementaciones. Desde `Send`, busca el handler asociado al tipo de solicitud.
- Si el arranque influye en la migración, mide el arranque en frío del mismo despliegue antes y después. Verifica la aplicación publicada si necesitas trimming o Native AOT.

## Qué se rompe

| Área | Cambio | Severidad |
| --- | --- | --- |
| Inyección de `ISender` / `IMediator` | Reemplazada por la interfaz de servicio concreta inyectada directamente | alta |
| `IRequest<T>` + `IRequestHandler<,>` | Se colapsan en una interfaz + el método de implementación | alta |
| `IPipelineBehavior<,>` | Sin punto de envoltura genérico; reemplazado por interfaz mediante decoradores o middleware | alta |
| `INotification` + `INotificationHandler<>` | Reemplazado por un `IEnumerable<IHandler>` inyectado para el fan-out o un agregador de eventos | media |
| Registro `AddMediatR(...)` | Reemplazado por llamadas explícitas a `AddScoped` (o un escaneo de Scrutor) | media |
| `RequestHandlerDelegate<T>` en behaviors | Sin equivalente; la cadena "next" desaparece | media |
| `ISender.CreateStream` (`IStreamRequest`) | Reemplazado por un método que devuelve `IAsyncEnumerable<T>` | baja |
| Pruebas unitarias que mockean `ISender` | Reapuntadas para mockear la interfaz concreta | baja |

## Lista de verificación previa

- El SDK de .NET 11 está instalado: confírmalo con `dotnet --version` (espera `11.x`).
- Tienes una rama de git limpia y una suite de pruebas en verde *antes* de empezar. Verifícalo con `dotnet test` y confirma cero fallos.
- Inventaría la superficie afectada. Ejecuta una búsqueda y anota los conteos, porque te dicen el tamaño del trabajo:

```bash
# .NET 11 - inventory MediatR usage before touching anything
grep -rn "IRequestHandler\|IRequest<\|: IRequest" src/      # handlers + requests
grep -rn "IPipelineBehavior" src/                            # the hard part
grep -rn "INotification" src/                                # fan-out
grep -rn "ISender\|IMediator\|\.Send(\|\.Publish(" src/      # call sites
```

- Decide *primero* la forma de reemplazo de los behaviors. Si tienes cero coincidencias de `IPipelineBehavior`, esto es un buscar-y-reemplazar puro. Si tienes varias, planifica si cada una se convierte en un decorador, middleware de ASP.NET Core o un filtro de endpoint.
- Agrega Scrutor si vas a usar decoradores: `dotnet add package Scrutor` (6.x, licencia MIT).

## Pasos de migración

1. **Convierte cada solicitud y handler en una interfaz de servicio y un método.**

Una solicitud de MediatR es un tipo de mensaje más un handler separado. Reemplaza ambos con una interfaz y una implementación. Agrupa solicitudes relacionadas en un único servicio en lugar de crear una interfaz por cada solicitud antigua.

```csharp
// .NET 11, C# 14, MediatR 14.x - BEFORE
using MediatR;

public record GetOrderById(int OrderId) : IRequest<OrderDto>;

public sealed class GetOrderByIdHandler(AppDbContext db)
    : IRequestHandler<GetOrderById, OrderDto>
{
    public async Task<OrderDto> Handle(GetOrderById request, CancellationToken ct)
    {
        var order = await db.Orders.FindAsync([request.OrderId], ct)
            ?? throw new OrderNotFoundException(request.OrderId);
        return order.ToDto();
    }
}
```

```csharp
// .NET 11, C# 14 - AFTER: plain service, no MediatR reference
public interface IOrderService
{
    Task<OrderDto> GetByIdAsync(int orderId, CancellationToken ct);
}

public sealed class OrderService(AppDbContext db) : IOrderService
{
    public async Task<OrderDto> GetByIdAsync(int orderId, CancellationToken ct)
    {
        var order = await db.Orders.FindAsync([orderId], ct)
            ?? throw new OrderNotFoundException(orderId);
        return order.ToDto();
    }
}
```

**Verifica:** el archivo nuevo no tiene `using MediatR;` y el cuerpo del handler es idéntico byte a byte salvo por la firma del método. Los parámetros del `record` de la solicitud se convierten en parámetros del método en el mismo orden.

2. **Reemplaza las llamadas a `ISender.Send` por llamadas directas a la interfaz.**

Cada llamador que inyectaba `ISender` o `IMediator` ahora inyecta la interfaz de servicio específica y llama al método.

```csharp
// .NET 11, C# 14 - BEFORE
public async Task<OrderDto> Get(int id, ISender sender, CancellationToken ct)
    => await sender.Send(new GetOrderById(id), ct);

// AFTER
public async Task<OrderDto> Get(int id, IOrderService orders, CancellationToken ct)
    => await orders.GetByIdAsync(id, ct);
```

**Verifica:** tras este paso, `grep -rn "ISender\|IMediator" src/` solo devuelve líneas que deliberadamente aún no has migrado. El conteo debe avanzar hacia cero.

3. **Registra los servicios explícitamente.**

Elimina `AddMediatR(...)` cuando hayas convertido sus handlers restantes. Registra explícitamente las interfaces de reemplazo y sus implementaciones. Las [dependencias de constructor ausentes](/es/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/) se detectan al validar o resolver. Comprueba los registros en el entorno de despliegue. Activa `ValidateOnBuild` para que el proveedor predeterminado valide los grafos de constructores registrados al construir el host. En producción, sin validación, una dependencia ausente puede fallar al solicitar el servicio. `ValidateScopes` comprueba aparte los ciclos de vida. Consulta las [opciones del proveedor de ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis?view=aspnetcore-10.0#validatescopes-and-validateonbuild).

```csharp
// .NET 11, C# 14 - BEFORE
builder.Services.AddMediatR(cfg =>
    cfg.RegisterServicesFromAssemblyContaining<GetOrderById>());

// AFTER - explicit, or one Scrutor scan if you prefer convention
builder.Services.AddScoped<IOrderService, OrderService>();
builder.Services.AddScoped<ICustomerService, CustomerService>();
```

Si prefieres registrar por convención, Scrutor puede escanear un ensamblado y seleccionar nombres de clase:

```csharp
// .NET 11, C# 14, Scrutor 6.x - register every *Service against its interface
builder.Services.Scan(scan => scan
    .FromAssemblyOf<OrderService>()
    .AddClasses(c => c.Where(t => t.Name.EndsWith("Service")))
    .AsImplementedInterfaces()
    .WithScopedLifetime());
```

En una prueba de .NET 10, habilitar explícitamente `ValidateOnBuild` produjo un fallo al construir el host por una dependencia de constructor ausente. Al deshabilitarlo, el host se construyó y el fallo llegó cuando un ámbito solicitó `IOrderService`. Resuelve cada servicio migrado dentro de un ámbito y llama a su endpoint.

4. **Reemplaza los pipeline behaviors por decoradores o middleware.**

Este es el único paso que requiere criterio. Un `IPipelineBehavior<,>` envolvía cada solicitud en un único lugar. Tienes dos reemplazos honestos.

Para concerns que son genuinamente por servicio (logging, caché, reintentos), usa un decorador de Scrutor:

```csharp
// .NET 11, C# 14, Scrutor 6.x - BEFORE was a generic ValidationBehavior<TRequest,TResponse>
public sealed class LoggingOrderService(
    IOrderService inner,
    ILogger<LoggingOrderService> logger) : IOrderService
{
    public async Task<OrderDto> GetByIdAsync(int orderId, CancellationToken ct)
    {
        logger.LogInformation("Fetching order {OrderId}", orderId);
        return await inner.GetByIdAsync(orderId, ct);
    }
}

// Registration: wrap the real implementation
builder.Services.AddScoped<IOrderService, OrderService>();
builder.Services.Decorate<IOrderService, LoggingOrderService>();
```

Para concerns que en realidad son concerns de HTTP (logging de solicitudes, mapeo de excepciones a ProblemDetails, autenticación), sácalos por completo de la capa de aplicación hacia middleware de ASP.NET Core o un filtro de endpoint. Un behavior que capturaba excepciones y daba forma a las respuestas pertenece al mismo lugar que [un filtro de excepciones global en ASP.NET Core 11](/es/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/), no a un decorador.

Para una operación de escritura, da al decorador su propio contrato `IOrderWriter`. El `IOrderService` de lectura anterior puede conservar `GetByIdAsync`.

```csharp
using FluentValidation;

public interface IOrderWriter
{
    Task<OrderDto> CreateAsync(CreateOrder command, CancellationToken ct);
}

public sealed class ValidatingOrderWriter(
    IOrderWriter inner,
    IValidator<CreateOrder> validator) : IOrderWriter
{
    public async Task<OrderDto> CreateAsync(CreateOrder command, CancellationToken ct)
    {
        await validator.ValidateAndThrowAsync(command, ct);
        return await inner.CreateAsync(command, ct);
    }
}
```

**Verifica:** escribe o conserva una prueba que afirme que el concern transversal sigue ejecutándose, por ejemplo que un comando inválido lance `ValidationException` antes de tocar la base de datos. Ejecuta `dotnet test` y confirma que las pruebas del behavior pasan.

5. **Reemplaza el fan-out de `INotification`.**

El `Publish` de MediatR invocaba cada `INotificationHandler<T>`. Reemplázalo con un `IEnumerable<T>` inyectado de una pequeña interfaz de handler que tú defines, y un publicador delgado.

```csharp
// .NET 11, C# 14 - BEFORE: INotification + handlers, AFTER: explicit fan-out
public interface IOrderPlacedHandler
{
    Task HandleAsync(OrderPlaced evt, CancellationToken ct);
}

public sealed class OrderEventPublisher(IEnumerable<IOrderPlacedHandler> handlers)
{
    public async Task PublishAsync(OrderPlaced evt, CancellationToken ct)
    {
        foreach (var handler in handlers)
            await handler.HandleAsync(evt, ct);
    }
}

// Registration - each handler registered against the interface
builder.Services.AddScoped<IOrderPlacedHandler, SendConfirmationEmail>();
builder.Services.AddScoped<IOrderPlacedHandler, UpdateInventory>();
builder.Services.AddScoped<OrderEventPublisher>();
```

El contenedor te entrega cada handler registrado en `IEnumerable<IOrderPlacedHandler>`, así que agregar un handler es una sola línea de registro, la misma ergonomía que te daba MediatR. Si publicas muchos tipos de evento, genera el publicador con un `IEventPublisher<T>` genérico en lugar de uno por evento.

**Verifica:** afirma que publicar un evento invoca a todos los handlers registrados. Una prueba con dos handlers falsos que ambos registran una llamada es suficiente.

6. **Elimina el paquete y las últimas referencias.**

Una vez que las llamadas hayan desaparecido, quita la dependencia.

```bash
# .NET 11 - remove the package from every project that referenced it
dotnet remove package MediatR
grep -rn "MediatR" src/ || echo "clean"
```

**Verifica:** `grep -rn "MediatR" src/` imprime `clean`. La compilación no tiene `using MediatR;` sin resolver y `dotnet build -c Release` tiene éxito sin advertencias sobre un paquete faltante.

## Verificación: la prueba de humo tras la migración

Ejecuta esta lista de arriba abajo y no te saltes la línea de rendimiento:

- `dotnet build -c Release` tiene éxito sin advertencias.
- `dotnet test` pasa con cero fallos, incluidas las pruebas de behavior y de fan-out que agregaste en los pasos 4 y 5.
- Inicia la aplicación y llama a cada endpoint migrado. Comprueba la respuesta y que sus servicios scoped se resuelven.
- `grep -rn "MediatR" src/` no devuelve nada.
- No aparece ninguna advertencia de licencia en los logs (la verificación de licencia de MediatR 13+ registraba una advertencia con una clave no registrada; ahora debería haber desaparecido).
- Compara el arranque en frío antes y después con el perfil de publicación que usarás.

## Plan de reversión

Esta migración es reversible por commit pero tediosa de deshacer en bloque, así que escalónala. Mantén cada uno de los seis pasos como un commit separado, y migra una rebanada vertical a la vez (una interfaz de servicio y sus llamadores) en lugar de toda la solución de golpe. MediatR y los servicios simples pueden coexistir durante la transición: deja `AddMediatR` registrado para los handlers no migrados mientras conviertes el resto. Si una rebanada se comporta mal, revierte los commits de esa rebanada y el resto de la aplicación no se ve afectado. Aquí no hay cambios de datos ni de esquema, así que la reversión es puramente un revert de código sin migración que revertir.

## Problemas que encontramos

**El orden de `IPipelineBehavior` no se mapea limpiamente a decoradores.** MediatR ejecuta los behaviors en el orden de registro alrededor de un único handler. Los decoradores de Scrutor se anidan en el orden en que llamas a `Decorate`, y el *último* decorador registrado es el envoltorio *más externo*. Si te equivocas en el orden, tu decorador de logging se ejecuta dentro de tu decorador de validación en lugar de alrededor de él. Escribe una prueba de ordenamiento por cada interfaz decorada.

Un ciclo puede aparecer al validar el grafo registrado o al resolver los servicios. Si `OrderService` y `CustomerService` dependen uno de otro, extrae la operación común a un tercer servicio.

**Las solicitudes de streaming necesitan `IAsyncEnumerable<T>`, no `Task<T>`.** Si usabas `IStreamRequest<T>` y `CreateStream`, el método de reemplazo devuelve `IAsyncEnumerable<T>` y usa `yield return`. No lo colapses en un `Task<List<T>>`; eso cambia la semántica de streaming y puede agotar la memoria en resultados grandes, la misma trampa descrita en [leer un CSV grande en .NET 11 sin quedarse sin memoria](/es/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/).

**Las pruebas que mockeaban `ISender` pasan silenciosamente contra nada.** Una prueba que configuraba `sender.Send(...)` para devolver un valor dará error de compilación una vez que `ISender` desaparezca, lo cual es bueno. Pero una prueba que inyectaba un `IMediator` real y afirmaba el comportamiento a través de él necesita reapuntarse a la interfaz concreta. Vuelve a ejecutar la suite completa, no confíes solo en una compilación en verde.

Este es el tipo de racionalización de dependencias que rinde de la misma manera que elegir el serializador integrado lo hace en [System.Text.Json vs Newtonsoft.Json en 2026](/es/2026/05/system-text-json-vs-newtonsoft-json-in-2026/): una biblioteca de terceros menos en la ruta caliente, una pregunta de licencias menos, y código que un compañero nuevo puede navegar sin tener que aprender primero una convención de despacho.

## Relacionados

- [MediatR vs clases de servicio simples en 2026: ¿debería moverte el cambio de licencia?](/es/2026/05/mediatr-vs-plain-service-classes-in-2026/)
- [Migrar de Newtonsoft.Json a System.Text.Json en una base de código grande](/es/2026/05/migrate-from-newtonsoft-json-to-system-text-json-in-a-large-codebase/)
- [Minimal APIs vs controllers en ASP.NET Core 11](/es/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)
- [Fix: Unable to resolve service for type while attempting to activate](/es/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/)
- [Fix: Cannot consume scoped service from singleton](/es/2026/05/fix-cannot-consume-scoped-service-from-singleton/)

## Fuentes

- [AutoMapper and MediatR Commercial Editions Launch Today](https://www.jimmybogard.com/automapper-and-mediatr-commercial-editions-launch-today/) - el cambio de licencia del 2025-07-02, el límite de la v13.0 y el modelo de doble licencia RPL-1.5 / comercial.
- [Licensing FAQ - Lucky Penny Software](https://luckypennysoftware.com/faq) - los umbrales de la edición Community de $5,000,000 de ingresos y $10,000,000 de capital y la verificación de licencia que solo registra en el log.
- [LuckyPennySoftware/MediatR en GitHub](https://github.com/LuckyPennySoftware/MediatR) - el código fuente actual de la 14.x, los contratos `IPipelineBehavior` e `INotification` que se reemplazan.
- [Scrutor en GitHub](https://github.com/khellang/Scrutor) - las extensiones `Decorate` y `Scan` con licencia MIT usadas para reemplazar behaviors y registrar servicios por convención.
- [Inyección de dependencias en .NET - Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection) - los lifetimes de servicio y la resolución de `IEnumerable<T>` usados para el fan-out de notificaciones.
