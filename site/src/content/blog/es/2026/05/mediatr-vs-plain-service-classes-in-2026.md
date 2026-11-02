---
title: "MediatR vs clases de servicio simples en 2026: ¿debería moverte el cambio de licencia?"
description: "Compara el despacho y los behaviors de MediatR con llamadas directas a servicios, incluida la validación DI, las condiciones de licencia y la medición del rendimiento."
pubDate: 2026-05-23
updatedDate: 2026-11-02
template: vs
tags:
  - "comparison"
  - "mediatr"
  - "dependency-injection"
  - "architecture"
  - "dotnet"
  - "dotnet-11"
lang: "es"
translationOf: "2026/05/mediatr-vs-plain-service-classes-in-2026"
translatedBy: "claude"
translationDate: 2026-05-23
---

Elige servicios directos si cada solicitud tiene un destino claro. MediatR resulta más útil cuando varios tipos de solicitud comparten behaviors o se necesitan notificaciones con varios destinatarios. Evalúa por separado las condiciones de la versión que usas.

**Corrección — 2 de noviembre de 2026:** se corrigieron la validación DI y las condiciones de licencia y se retiraron cifras sin medir de tiempo y asignaciones.

Los ejemplos apuntan a `net11.0` e ilustran los contratos de MediatR 13/14. La comprobación de validación DI descrita abajo se ejecutó en .NET 10.

## Qué cambió en realidad en julio de 2025

MediatR 12.5.0 se distribuyó bajo Apache 2.0. En julio de 2025 el autor anunció las opciones RPL-1.5 y comercial a partir de 13.0.0. Las versiones anteriores conservan sus condiciones originales.

Los [criterios Community de Lucky Penny Software](https://luckypennysoftware.com/faq) incluyen ingresos brutos anuales o presupuesto sin ánimo de lucro inferiores a 5 millones de dólares y un máximo de 10 millones de dólares de capital externo. El proveedor también establece condiciones para entidades públicas o cuasigubernamentales, usos universitarios y trabajo para clientes. Revisa los criterios aplicables a la organización y al uso.

## La matriz de características de un vistazo

| Aspecto | MediatR 13+ | Clases de servicio simples |
| ------- | ----------- | -------------------------- |
| Despacho de solicitudes | Indirección con `ISender.Send` | Llamada directa a un método de una interfaz inyectada |
| Preocupaciones transversales | `IPipelineBehavior<,>` de primera clase | Decoradores (Scrutor) o llamadas explícitas |
| Validación DI | Depende de los registros y las opciones del proveedor | Depende de los registros y las opciones del proveedor |
| Notificaciones / fan-out | Publicación `INotification` integrada | Lista de handlers hecha a mano |

La pipeline es la diferencia principal de diseño: permite compartir validación, registros, transacciones o caché entre solicitudes.

## Cómo se ve MediatR, y el equivalente simple

Esta es la forma canónica de MediatR: una solicitud, un handler y un llamador que despacha a través de `ISender`.

```csharp
// .NET 11, C# 14, MediatR 13+ - request + handler
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

// In an endpoint:
public async Task<OrderDto> Get(int id, ISender sender, CancellationToken ct)
    => await sender.Send(new GetOrderById(id), ct);
```

La versión simple colapsa la solicitud y el handler en un único método de un servicio inyectado. El llamador depende directamente de la interfaz.

```csharp
// .NET 11, C# 14 - plain service class, no MediatR
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

// In an endpoint:
public async Task<OrderDto> Get(int id, IOrderService orders, CancellationToken ct)
    => await orders.GetByIdAsync(id, ct);
```

Desde una llamada de interfaz, ir a la definición lleva al método de la interfaz y el IDE permite encontrar sus implementaciones. Desde `Send`, busca el handler asociado al tipo de solicitud.

`AddScoped` registra un servicio. Con el proveedor integrado y `ValidateOnBuild` habilitado, la construcción del host puede detectar una dependencia de constructor no registrada en un servicio registrado. Sin esa validación, el host puede construirse y fallar cuando se resuelve el servicio. Los [valores predeterminados de ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis?view=aspnetcore-10.0#validatescopes-and-validateonbuild) dependen del entorno. `ValidateScopes` comprueba por separado los ciclos de vida.

La comprobación de esta corrección registró en .NET 10 un servicio scoped con una dependencia ausente. Con los valores predeterminados, Development falló en `Build()` y Production al resolver el servicio. Establecer `ValidateOnBuild` explícitamente cambió la fase del fallo.

```csharp
// .NET 11, C# 14 - registration, side by side
// MediatR: scan an assembly, register every handler reflectively
builder.Services.AddMediatR(cfg =>
    cfg.RegisterServicesFromAssemblyContaining<GetOrderById>());

// Plain: explicitly register the scoped service
builder.Services.AddScoped<IOrderService, OrderService>();
```

## El pipeline behavior, y cómo vivir sin él

Aquí es donde MediatR se gana su sitio. Un pipeline behavior envuelve cada solicitud, lo que te da exactamente un lugar para añadir validación, registro, medición de tiempos o una transacción.

```csharp
// .NET 11, C# 14, MediatR 13+ - cross-cutting validation for ALL requests
using MediatR;

public sealed class ValidationBehavior<TRequest, TResponse>(
    IEnumerable<IValidator<TRequest>> validators)
    : IPipelineBehavior<TRequest, TResponse>
    where TRequest : notnull
{
    public async Task<TResponse> Handle(
        TRequest request,
        RequestHandlerDelegate<TResponse> next,
        CancellationToken ct)
    {
        foreach (var validator in validators)
            await validator.ValidateAndThrowAsync(request, ct);
        return await next(ct);
    }
}
```

Registrado una vez, ese behavior se ejecuta delante de cada handler. Reemplazar esto con llamadas de validación copiadas y pegadas en cada servicio simple sería una regresión, y es el mejor argumento para conservar un mediador. Pero puedes obtener la misma propiedad de "envolverlo todo" en DI simple con el patrón decorador, usando Scrutor (con licencia MIT) para registrar un decorador alrededor de una interfaz:

```csharp
// .NET 11, C# 14, Scrutor 6.x - a decorator gives you the same cross-cutting hook
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

// Registration: decorate the real implementation
builder.Services.AddScoped<IOrderService, OrderService>();
builder.Services.Decorate<IOrderService, LoggingOrderService>();
```

El intercambio es honesto: el behavior de MediatR es genérico sobre cada solicitud con un único registro, mientras que un decorador es por interfaz. Si tienes una o dos preocupaciones transversales y un puñado de interfaces de servicio, los decoradores ganan en claridad. Si tienes diez behaviors que deben aplicarse de forma uniforme a doscientos tipos de solicitud, el pipeline genérico de MediatR es genuinamente menos código, y ese es el escenario en el que quedarse (y pagar, o calificar para Community) es defendible. Para preocupaciones a nivel de solicitud que en realidad son preocupaciones de HTTP, ten en cuenta que parte de lo que la gente mete en behaviors pertenece más bien al middleware o a los filtros, la misma superficie que cubre [añadir un filtro global de excepciones en ASP.NET Core 11](/es/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/).

## Cuánto cuesta en realidad el despacho

`Send` resuelve un handler y ejecuta la pipeline configurada. Una llamada directa utiliza el servicio inyectado. Este artículo no dispone de un benchmark equivalente de ambos recorridos, por lo que no da tiempos ni asignaciones por llamada.

Si el coste del despacho influye en la decisión, mide ambos recorridos con el mismo trabajo, ciclo de vida, runtime y cadena de behaviors. Mide el registro y el arranque en frío por separado. El registro explícito puede evitar escanear handlers. Comprueba el trimming y Native AOT en la aplicación publicada.

## El detalle que decide por ti

Unas cuantas restricciones zanjan esto antes de que entre en juego el gusto arquitectónico.

Una aplicación fijada en 12.5.0 permanece en esa versión y conserva sus condiciones. Evalúa las necesidades de mantenimiento antes de fijarla a largo plazo.

**Si solo llamas alguna vez a `Send`, no necesitas un mediador.** La prueba honesta: abre tu solución y busca `IPipelineBehavior` e `INotification`. Si hay cero behaviors y no publicas notificaciones, MediatR está funcionando como una capa de indirección sobre llamadas a métodos, y eliminarlo es una refactorización mecánica que hace el código más navegable, quita una dependencia y borra la cuestión de la licencia de un solo movimiento. Este es el mismo instinto de racionalización de bibliotecas que hay detrás de elegir la opción incluida de serie en [System.Text.Json vs Newtonsoft.Json en 2026](/es/2026/05/system-text-json-vs-newtonsoft-json-in-2026/).

## La decisión, en una línea

Para una ruta directa entre llamador y servicio, elige inyección explícita. Conserva MediatR si su pipeline compartida o sus notificaciones aportan valor a varios tipos de solicitud. Si eliges servicios, sigue la [migración paso a paso](/es/2026/05/migrate-from-mediatr-to-plain-dependency-injection/).

## Relacionados

- [Minimal APIs vs controllers in ASP.NET Core 11](/es/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)
- [Fix: Unable to resolve service for type while attempting to activate](/es/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/)
- [Fix: Cannot consume scoped service from singleton](/es/2026/05/fix-cannot-consume-scoped-service-from-singleton/)
- [HttpClient vs HttpClientFactory vs Refit](/es/2026/05/httpclient-vs-httpclientfactory-vs-refit/)
- [System.Text.Json vs Newtonsoft.Json en 2026](/es/2026/05/system-text-json-vs-newtonsoft-json-in-2026/)

## Fuentes

- [AutoMapper and MediatR Commercial Editions Launch Today](https://www.jimmybogard.com/automapper-and-mediatr-commercial-editions-launch-today/) - el anuncio de lanzamiento del 2025-07-02, el límite de la v13.0 y el modelo dual RPL-1.5 / comercial.
- [Licensing FAQ - Lucky Penny Software](https://luckypennysoftware.com/faq) - los umbrales Community de 5.000.000 de ingresos y 10.000.000 de capital, el conteo de desarrolladores por "acceso programático" y la comprobación de licencia solo de registro.
- [MediatR commercial version launched (Discussion #1123)](https://github.com/LuckyPennySoftware/MediatR/discussions/1123) - confirmación de que las versiones antiguas permanecen bajo su licencia de código abierto original.
- [LuckyPennySoftware/MediatR v13.0.0 release](https://github.com/LuckyPennySoftware/MediatR/releases/tag/v13.0.0) - la primera versión con licencia dual.
- [Scrutor en GitHub](https://github.com/khellang/Scrutor) - la extensión `Decorate` con licencia MIT usada para reemplazar pipeline behaviors con decoradores.
