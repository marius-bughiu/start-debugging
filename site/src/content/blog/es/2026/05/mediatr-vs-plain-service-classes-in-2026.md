---
title: "MediatR vs clases de servicio simples en 2026: ¿debería moverte el cambio de licencia?"
description: "Para código nuevo, las clases de servicio simples son la mejor opción por defecto. El cambio de licencia de MediatR de julio de 2025 importa solo si superas el umbral Community de 5 millones de dólares o rechazas el copyleft de la RPL-1.5. Conserva MediatR cuando los pipeline behaviors sean esenciales."
pubDate: 2026-05-23
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

La versión corta: para código nuevo en .NET 11 en 2026, opta por defecto por **clases de servicio simples** y recurre a MediatR solo cuando realmente te apoyes en sus pipeline behaviors. El cambio de licencia de julio de 2025 es una razón real para reevaluar, pero no es el precipicio que algunos pintaron. Si tu empresa está por debajo de los 5.000.000 de dólares de ingresos brutos anuales puedes seguir usando gratis la última versión de MediatR bajo la edición Community, así que la cuestión de la licencia solo fuerza una decisión para equipos más grandes o para cualquiera que no quiera aceptar el copyleft de la RPL-1.5 en la licencia open source gratuita. La pregunta técnica (¿necesitas un mediador siquiera?) es la que de verdad debería guiar la elección, y para la mayoría del despacho de solicitudes es la indirección, no la biblioteca, lo que puedes eliminar.

Versiones a las que se hace referencia a lo largo del texto: MediatR 12.5.0 es la última versión bajo la licencia Apache 2.0 simple; MediatR 13.0 (publicada el 2025-07-02) y la posterior línea 14.x se distribuyen bajo un modelo dual Reciprocal Public License 1.5 / comercial de Lucky Penny Software. El código tiene como objetivo `<TargetFramework>net11.0</TargetFramework>` con el SDK de .NET 11 y C# 14.

## Qué cambió en realidad en julio de 2025

MediatR y AutoMapper fueron mantenidos durante años por Jimmy Bogard con una licencia permisiva de código abierto. El 2025-07-02 trasladó ambos a una nueva empresa, Lucky Penny Software, y cambió el modelo de licencia. Los mecanismos que importan para tu decisión:

- **Las versiones antiguas siguen siendo gratis para siempre.** MediatR 12.x y anteriores permanecen bajo Apache 2.0 (MIT para algunos artefactos más antiguos) y no se relicencian retroactivamente. Puedes fijar `12.5.0` y no pagar nunca. La pega es que no recibes actualizaciones de seguridad, ni correcciones, ni soporte para esa línea.
- **Las versiones nuevas tienen licencia dual.** MediatR 13.0 y posteriores se ofrecen bajo la Reciprocal Public License 1.5 (RPL-1.5) para uso de código abierto, o una licencia comercial de pago.
- **Existe una edición Community gratuita.** Empresas e individuos por debajo de 5.000.000 USD de ingresos brutos anuales (y que no hayan recibido más de 10.000.000 en capital externo), organizaciones sin fines de lucro por debajo del mismo presupuesto, uso educativo y entornos no productivos califican todos para usar gratis la última versión de MediatR bajo el nivel Community del acuerdo comercial.
- **Los niveles de pago se basan en el tamaño del equipo.** Standard (1-10 desarrolladores), Professional (11-50) y Enterprise (ilimitado), facturados mensual o anualmente, contando solo a los desarrolladores con "acceso programático" que escriben o compilan código que llama a MediatR.
- **La comprobación de licencia solo registra.** Una clave caducada o ausente produce avisos en el registro, no un fallo en tiempo de ejecución. Sin bloqueo de funcionalidades, sin rendimiento degradado, sin servidor de licencias ni llamada de red.

Así que la bifurcación práctica es esta. ¿Un taller pequeño por debajo de 5 M? Puedes quedarte gratis en la versión actual de MediatR, y la única fricción es el aviso en el registro hasta que registres una clave Community. ¿Más grande o bien financiado? O pagas, o aceptas las obligaciones recíprocas de la RPL-1.5, o te vas. Ese tercer grupo es exactamente quien debería estar leyendo una comparativa "vs clases de servicio simples".

## La matriz de características de un vistazo

| Aspecto | MediatR 13+ | Clases de servicio simples |
| ------- | ----------- | -------------------------- |
| Despacho de solicitudes | Indirección con `ISender.Send` | Llamada directa a un método de una interfaz inyectada |
| Preocupaciones transversales | `IPipelineBehavior<,>` de primera clase | Decoradores (Scrutor) o llamadas explícitas |
| Ir a definición desde el llamador | Aterriza en `Send`, no en el handler | Aterriza en la implementación |
| Seguridad de cableado en compilación | Resolución en tiempo de ejecución, puede fallar en la primera llamada | Inyección por constructor, falla al arrancar |
| Notificaciones / fan-out | Publicación `INotification` integrada | Lista de handlers hecha a mano |
| Coste de arranque | Escaneo de ensamblados para registrar handlers | Ninguno más allá del registro normal de DI |
| Sobrecarga por llamada | Asignación de wrapper + búsqueda en diccionario + despacho virtual | Casi cero, el JIT puede desvirtualizar |
| Native AOT / trimming | Requiere cuidado, registro basado en reflexión | Limpio |
| Licencia (por encima de 5 M de ingresos) | Compra comercial o RPL-1.5 | Ninguna, es tu propio código |
| Código nuevo en 2026 | Solo si los behaviors son esenciales | La opción por defecto |

La fila que decide la mayoría de las discusiones es "preocupaciones transversales". Casi todo lo demás en esa tabla favorece a las clases de servicio simples. El valor genuino y difícil de reemplazar de MediatR es el pipeline: un único lugar para envolver cada solicitud con validación, registro, transacciones y caché. Si no usas ese pipeline, estás pagando el coste de indirección y de licencia por un localizador de servicios glorificado.

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

La versión simple es más corta y, lo que es crucial, pulsar ir a definición sobre `orders.GetByIdAsync` te lleva al método que se ejecuta. Con `sender.Send(new GetOrderById(id))` aterrizas en el `Send` de MediatR, y navegas al handler adivinando o con un rodeo de "buscar implementaciones". En un equipo pequeño esa diferencia es leve. En una base de código grande con cientos de handlers, la pérdida de navegabilidad directa es un impuesto real y diario que el modelo de MediatR impone a cambio de desacoplar al llamador del tipo del handler. Si ese desacoplamiento te aporta algo depende de si alguien alguna vez intercambia un handler sin tocar al llamador, lo cual en la práctica es raro.

El registro también merece una comparación. MediatR escanea ensamblados al arrancar; las clases de servicio simples se registran de forma explícita, y obtienes un fallo en tiempo de arranque (no en la primera solicitud) si olvidas alguno, lo que se relaciona directamente con la clase de errores detrás de [Unable to resolve service for type while attempting to activate](/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/).

```csharp
// .NET 11, C# 14 - registration, side by side
// MediatR: scan an assembly, register every handler reflectively
builder.Services.AddMediatR(cfg =>
    cfg.RegisterServicesFromAssemblyContaining<GetOrderById>());

// Plain: explicit, trim-friendly, fails fast at startup if a dep is missing
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

El intercambio es honesto: el behavior de MediatR es genérico sobre cada solicitud con un único registro, mientras que un decorador es por interfaz. Si tienes una o dos preocupaciones transversales y un puñado de interfaces de servicio, los decoradores ganan en claridad. Si tienes diez behaviors que deben aplicarse de forma uniforme a doscientos tipos de solicitud, el pipeline genérico de MediatR es genuinamente menos código, y ese es el escenario en el que quedarse (y pagar, o calificar para Community) es defendible. Para preocupaciones a nivel de solicitud que en realidad son preocupaciones de HTTP, ten en cuenta que parte de lo que la gente mete en behaviors pertenece más bien al middleware o a los filtros, la misma superficie que cubre [añadir un filtro global de excepciones en ASP.NET Core 11](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/).

## Cuánto cuesta en realidad el despacho

El rendimiento es el argumento más débil en cualquier dirección, y no deberías elegir basándote solo en él, pero merece la pena saber dónde vive el coste para que nadie haga afirmaciones vagas. Una llamada a una interfaz simple es un único despacho virtual que el JIT a menudo puede desvirtualizar y poner inline; no asigna nada y cuesta del orden de un nanosegundo. Un `Send` de MediatR hace más trabajo por llamada: busca el tipo de solicitud en una caché de handlers, construye o recupera un `RequestHandlerWrapper`, recorre la cadena de behaviors mediante delegados y resuelve el handler desde el contenedor. Eso es del orden de decenas de nanosegundos más una pequeña asignación por envío, antes de que se ejecute el cuerpo de tu handler.

| Aspecto | `Send` de MediatR | Llamada a interfaz simple |
| ------- | ----------------- | ------------------------- |
| Resolución tipo-a-handler | Búsqueda en diccionario por llamada | Ninguna, fijada en la inyección |
| Cadena wrapper / delegado | Asignada por envío | Ninguna |
| Desvirtualización por el JIT | No | A menudo sí |
| Escaneo de ensamblados al arrancar | Sí, crece con el número de handlers | Ninguno |
| Orden de magnitud por llamada | Decenas de ns + pequeña asignación | ~1 ns, cero asignación |

La honestidad metodológica aquí: contra un handler que toca una base de datos o la red, decenas de nanosegundos son invisibles, y deberías medir tus propias formas de objeto con BenchmarkDotNet en lugar de fiarte de una cifra genérica. El coste que sí aparece en la práctica es el arranque. Escanear ensamblados para registrar cientos de handlers añade milisegundos medibles al arranque en frío, lo que importa para serverless y es el tipo de cosa contra la que luchas al [reducir el tiempo de arranque en frío de una AWS Lambda con .NET 11](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/). El registro explícito y simple lo evita por completo y es más amable con el trimming y Native AOT, porque no hay descubrimiento reflexivo que mantener a salvo del trimming.

## El detalle que decide por ti

Unas cuantas restricciones zanjan esto antes de que entre en juego el gusto arquitectónico.

**La RPL-1.5 es la verdadera fuerza decisoria, no el precio.** La opción gratuita de código abierto en MediatR 13+ es la Reciprocal Public License 1.5, que conlleva obligaciones de copyleft recíprocas: está diseñada para cerrar el resquicio del SaaS, así que desplegar un servicio de red construido sobre código con licencia RPL puede obligarte a poner tu código fuente a disposición. Si distribuyes software comercial de código cerrado y estás por encima del umbral Community, la licencia OSS gratuita no es realmente utilizable para ti, y "MediatR sigue siendo open source" es engañoso en tu caso. O compras la licencia comercial o te vas. Para un despachador delgado que en realidad no estabas usando, irse es fácil.

**La línea de 5 M de ingresos y 10 M de capital es generosa.** La mayoría de los equipos de producto pequeños, las consultoras y las startups caen por debajo de ella y pueden seguir usando gratis la versión más nueva de MediatR bajo la edición Community. Si ese eres tú, la licencia no es razón para arrancar nada; registra una clave Community, silencia el aviso y sigue adelante. Gastar un sprint en eliminar MediatR para evitar una factura que no debes es el intercambio equivocado.

**Fijar 12.5.0 es una opción real con un coste real.** Apache 2.0 en la última versión gratuita no caduca. Pero te congelas en una versión que no recibe parches de seguridad, y heredas tú mismo el riesgo de mantenimiento. Eso está bien para una app interna estable y es peligroso para cualquier cosa expuesta a internet.

**Si solo llamas alguna vez a `Send`, no necesitas un mediador.** La prueba honesta: abre tu solución y busca `IPipelineBehavior` e `INotification`. Si hay cero behaviors y no publicas notificaciones, MediatR está funcionando como una capa de indirección sobre llamadas a métodos, y eliminarlo es una refactorización mecánica que hace el código más navegable, quita una dependencia y borra la cuestión de la licencia de un solo movimiento. Este es el mismo instinto de racionalización de bibliotecas que hay detrás de elegir la opción incluida de serie en [System.Text.Json vs Newtonsoft.Json en 2026](/2026/05/system-text-json-vs-newtonsoft-json-in-2026/).

## La decisión, en una línea

Para código nuevo en .NET 11 en 2026, escribe clases de servicio simples e inyecta las interfaces directamente: obtienes ir a definición, cableado de arranque que falla rápido, sin sobrecarga por llamada, amabilidad con el trimming y cero exposición a licencias. Conserva MediatR solo cuando sus pipeline behaviors estén haciendo un trabajo real y uniforme a través de muchos tipos de solicitud, y en ese caso decide deliberadamente: quédate gratis bajo la edición Community si estás por debajo de 5 M, paga si estás por encima y el pipeline justifica la factura, y fija 12.5.0 solo como medida provisional. El error es tratar "MediatR se volvió comercial" o como un no-evento o como una alarma de cinco campanas. No es ninguna de las dos. Es un aviso para preguntarte si necesitabas el mediador en primer lugar, y para la mayoría del código de despacho de solicitudes la respuesta siempre fue no.

## Relacionados

- [Minimal APIs vs controllers in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)
- [Fix: Unable to resolve service for type while attempting to activate](/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/)
- [Fix: Cannot consume scoped service from singleton](/2026/05/fix-cannot-consume-scoped-service-from-singleton/)
- [HttpClient vs HttpClientFactory vs Refit](/2026/05/httpclient-vs-httpclientfactory-vs-refit/)
- [System.Text.Json vs Newtonsoft.Json en 2026](/2026/05/system-text-json-vs-newtonsoft-json-in-2026/)

## Fuentes

- [AutoMapper and MediatR Commercial Editions Launch Today](https://www.jimmybogard.com/automapper-and-mediatr-commercial-editions-launch-today/) - el anuncio de lanzamiento del 2025-07-02, el límite de la v13.0 y el modelo dual RPL-1.5 / comercial.
- [Licensing FAQ - Lucky Penny Software](https://luckypennysoftware.com/faq) - los umbrales Community de 5.000.000 de ingresos y 10.000.000 de capital, el conteo de desarrolladores por "acceso programático" y la comprobación de licencia solo de registro.
- [MediatR commercial version launched (Discussion #1123)](https://github.com/LuckyPennySoftware/MediatR/discussions/1123) - confirmación de que las versiones antiguas permanecen bajo su licencia de código abierto original.
- [LuckyPennySoftware/MediatR v13.0.0 release](https://github.com/LuckyPennySoftware/MediatR/releases/tag/v13.0.0) - la primera versión con licencia dual.
- [Scrutor en GitHub](https://github.com/khellang/Scrutor) - la extensión `Decorate` con licencia MIT usada para reemplazar pipeline behaviors con decoradores.
</content>
