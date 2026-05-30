---
title: "Migrar de MediatR a inyección de dependencias simple en .NET 11"
description: "Una lista de verificación paso a paso para eliminar MediatR 12-14 y reemplazar los handlers de IRequest, ISender, los pipeline behaviors y INotification por clases de servicio simples e inyección por constructor."
pubDate: 2026-05-30
updatedDate: 2026-05-30
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

Eliminar MediatR de una base de código en .NET 11 es una refactorización mecánica, no una reescritura. Para un servicio típico con 50-150 handlers, calcula entre medio día y un día: la mayoría de los handlers se colapsan uno a uno en métodos sobre clases de servicio simples, las llamadas a `ISender.Send` se convierten en llamadas directas a la interfaz, y la única parte que requiere reflexión de diseño es el pipeline. Lo que se rompe es todo lo que dependía de la resolución de handlers en runtime o del envoltorio de `IPipelineBehavior<,>` alrededor de cada solicitud; eso se convierte en inyección por constructor y decoradores. Vale la pena hacerlo si solo llamas a `Send`, si estás por encima de la línea de ingresos de $5,000,000 de la edición Community de MediatR y no quieres comprar una licencia comercial, o si quieres Native AOT y compatibilidad con trimming. No vale la pena si tus pipeline behaviors son fundamentales en cientos de tipos de solicitud.

Versiones referenciadas: esta guía cubre la eliminación de MediatR 12.5.0 (la última versión con licencia Apache 2.0), 13.0 (lanzada el 2025-07-02, la primera versión con doble licencia Reciprocal Public License 1.5 / comercial de Lucky Penny Software) y la línea actual 14.x. El código de reemplazo apunta a `<TargetFramework>net11.0</TargetFramework>` con el SDK de .NET 11 y C# 14, más Scrutor 6.x para los decoradores. Si todavía estás decidiendo *si* deberías irte, lee primero [MediatR vs clases de servicio simples en 2026](/es/2026/05/mediatr-vs-plain-service-classes-in-2026/); este artículo asume que la decisión ya está tomada.

## Por qué los equipos están eliminando MediatR justo ahora

- **La licencia fuerza una decisión por encima de los $5M.** El uso open-source gratuito de MediatR 13+ es bajo la RPL-1.5, una licencia copyleft recíproca diseñada para cerrar el resquicio del SaaS. Si distribuyes software comercial de código cerrado por encima del umbral de ingresos de la edición Community, esa licencia no te sirve, así que es comprar o irse.
- **Ir a la definición lleva al handler, no a `Send`.** Las llamadas directas a la interfaz restauran la navegabilidad que la indirección del mediador te cuesta en cada salto.
- **El arranque se abarata y AOT se simplifica.** Eliminar el escaneo de ensamblados para el registro de handlers recorta milisegundos de arranque en frío y elimina la reflexión que pelea con el trimming, lo que importa al [reducir el tiempo de arranque en frío de un AWS Lambda en .NET 11](/es/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/).
- **El cableado falla en el arranque, no en la primera solicitud.** El registro explícito con `AddScoped` convierte una dependencia faltante en un error en tiempo de arranque en lugar de una `InvalidOperationException` en runtime.

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

Elimina `AddMediatR(...)` y registra cada servicio. El registro explícito es seguro para trimming y falla rápido en el arranque, que es exactamente el modo de fallo detrás de [Unable to resolve service for type while attempting to activate](/es/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/).

```csharp
// .NET 11, C# 14 - BEFORE
builder.Services.AddMediatR(cfg =>
    cfg.RegisterServicesFromAssemblyContaining<GetOrderById>());

// AFTER - explicit, or one Scrutor scan if you prefer convention
builder.Services.AddScoped<IOrderService, OrderService>();
builder.Services.AddScoped<ICustomerService, CustomerService>();
```

Si quieres un registro basado en convenciones sin el modelo de reflexión de MediatR, Scrutor escanea por el nombre de la interfaz:

```csharp
// .NET 11, C# 14, Scrutor 6.x - register every *Service against its interface
builder.Services.Scan(scan => scan
    .FromAssemblyOf<OrderService>()
    .AddClasses(c => c.Where(t => t.Name.EndsWith("Service")))
    .AsImplementedInterfaces()
    .WithScopedLifetime());
```

**Verifica:** la aplicación arranca. Ejecútala y golpea un endpoint migrado; un registro faltante ahora lanza en el arranque, no en la primera solicitud. Confirma que no se han colado errores de servicio scoped desde singleton, la clase de bug cubierta en [Cannot consume scoped service from singleton](/es/2026/05/fix-cannot-consume-scoped-service-from-singleton/).

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

Si usabas FluentValidation dentro de un `ValidationBehavior`, conserva los validadores y llámalos desde un único decorador o desde un filtro de endpoint de minimal API:

```csharp
// .NET 11, C# 14 - a validation decorator replacing ValidationBehavior for one interface
public sealed class ValidatingOrderService(
    IOrderService inner,
    IValidator<CreateOrder> validator) : IOrderService
{
    public async Task<OrderDto> CreateAsync(CreateOrder cmd, CancellationToken ct)
    {
        await validator.ValidateAndThrowAsync(cmd, ct);
        return await inner.CreateAsync(cmd, ct);
    }

    public Task<OrderDto> GetByIdAsync(int orderId, CancellationToken ct)
        => inner.GetByIdAsync(orderId, ct);
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
- La aplicación arranca y cada endpoint antes despachado por MediatR devuelve la misma respuesta que antes. Un registro faltante ahora aparece aquí, en el arranque.
- `grep -rn "MediatR" src/` no devuelve nada.
- No aparece ninguna advertencia de licencia en los logs (la verificación de licencia de MediatR 13+ registraba una advertencia con una clave no registrada; ahora debería haber desaparecido).
- El arranque en frío es igual o mejor. Si la aplicación es serverless, mide el tiempo de arranque antes y después; eliminar el escaneo de ensamblados no debería empeorarlo.

## Plan de reversión

Esta migración es reversible por commit pero tediosa de deshacer en bloque, así que escalónala. Mantén cada uno de los seis pasos como un commit separado, y migra una rebanada vertical a la vez (una interfaz de servicio y sus llamadores) en lugar de toda la solución de golpe. MediatR y los servicios simples pueden coexistir durante la transición: deja `AddMediatR` registrado para los handlers no migrados mientras conviertes el resto. Si una rebanada se comporta mal, revierte los commits de esa rebanada y el resto de la aplicación no se ve afectado. Aquí no hay cambios de datos ni de esquema, así que la reversión es puramente un revert de código sin migración que revertir.

## Problemas que encontramos

**El orden de `IPipelineBehavior` no se mapea limpiamente a decoradores.** MediatR ejecuta los behaviors en el orden de registro alrededor de un único handler. Los decoradores de Scrutor se anidan en el orden en que llamas a `Decorate`, y el *último* decorador registrado es el envoltorio *más externo*. Si te equivocas en el orden, tu decorador de logging se ejecuta dentro de tu decorador de validación en lugar de alrededor de él. Escribe una prueba de ordenamiento por cada interfaz decorada.

**Un `ISender` dentro de un handler que llama a otro handler se convierte en una llamada directa al servicio, y eso puede exponer un ciclo.** La indirección de MediatR ocultaba las dependencias entre handlers. Cuando `OrderService` inyecta `ICustomerService` y `CustomerService` inyecta `IOrderService`, el contenedor lanza en el arranque con una dependencia circular. Eso es la migración sacando a la luz un problema de diseño que MediatR estaba enmascarando; rompe el ciclo extrayendo la lógica compartida a un tercer servicio.

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
