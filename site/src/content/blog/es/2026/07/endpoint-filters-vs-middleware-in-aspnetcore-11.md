---
title: "Filtros de endpoint vs. middleware en ASP.NET Core 11: ¿cuál deberías usar?"
description: "Una guía de decisión para ASP.NET Core 11: el middleware se ejecuta en cada solicitud antes de que tu handler enlace los datos, los filtros de endpoint se ejecutan solo para el endpoint que coincide, después del enlace, y pueden ver los argumentos tipados. Incluye una tabla comparativa, escenarios de cuándo elegir cada uno, las reglas de orden y los detalles que fuerzan la elección."
pubDate: 2026-07-24
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-api"
lang: "es"
translationOf: "2026/07/endpoint-filters-vs-middleware-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-24
---

Usa middleware cuando la lógica deba ejecutarse en cada solicitud, antes de o independientemente de qué endpoint coincida: manejo de excepciones, CORS, autenticación, compresión de respuestas, archivos estáticos, encabezados reenviados. Usa un filtro de endpoint cuando la lógica necesite los argumentos enlazados del handler, o deba aplicarse solo a algunos endpoints: validación de entrada, normalización de argumentos, auditoría por endpoint. La prueba más precisa: si tu código necesita el modelo tipado que el handler está a punto de recibir, quiere un filtro, porque un filtro se ejecuta después del enlace del modelo y puede leer `context.GetArgument<T>(index)`. Si necesita ejecutarse haya o no una ruta coincidente, quiere middleware, porque el middleware se ejecuta antes de que el enrutamiento resuelva un endpoint. Todo lo que sigue es el detalle detrás de esa decisión. Este artículo apunta a .NET 11 (Preview 6 al momento de escribir, GA en noviembre de 2026) con `Microsoft.NET.Sdk.Web` y C# 14, pero ambas características son estables desde ASP.NET Core 7, así que cada ejemplo aquí se ejecuta sin cambios en .NET 8, 9 y 10.

## La tabla comparativa

Esta es la tabla que viniste a buscar. Léela de arriba hacia abajo y la decisión suele tomarse sola.

| Característica                          | Filtro de endpoint                       | Middleware                               |
| -------------------------------------- | ---------------------------------------- | ---------------------------------------- |
| Se ejecuta para                        | solo el endpoint que coincide            | cada solicitud en esa rama del pipeline  |
| Posición respecto al enrutamiento      | después del enrutamiento y el enlace     | antes, durante o después (por posición)  |
| Ve los argumentos del handler          | sí, tipados vía `GetArgument<T>(index)`  | no, solo el `HttpContext` en crudo       |
| Puede mutar los argumentos enlazados   | sí, `context.Arguments` es mutable       | no, el enlace aún no ha ocurrido         |
| Mecanismo de cortocircuito             | devolver un `IResult` en lugar de `next` | no llamar a `next(context)`              |
| Control de alcance                     | por endpoint o por `MapGroup`            | por app, o por rama vía `Map`/`UseWhen`  |
| Registro                               | `.AddEndpointFilter(...)`                | `app.Use(...)` / `app.UseMiddleware<T>()` |
| Tipo de retorno                        | `ValueTask<object?>`                     | `Task`                                   |
| Se ejecuta sin endpoint coincidente    | nunca                                    | sí, si se coloca antes de la ejecución del endpoint |
| Reutilizable en controladores MVC      | sí, también en endpoints de controlador  | sí, en todo el pipeline                  |

Las filas que realmente deciden la elección son las tres primeras. El middleware se ubica en el pipeline de solicitudes y cada solicitud que fluye por ese segmento lo ejecuta, incluso una solicitud que dará 404 porque ningún endpoint coincidió. Un filtro de endpoint está ligado a un handler de ruta específico y solo se ejecuta cuando ese handler es seleccionado, lo que ocurre después de que `UseRouting` haya emparejado la solicitud y después de que el framework haya enlazado los valores de ruta, la cadena de consulta y el cuerpo de la solicitud a los parámetros del handler. Esa diferencia de momento es toda la historia.

## Qué ve el middleware, y cuándo

El middleware es una cadena de componentes, cada uno de los cuales recibe el `HttpContext` y un delegado `next`. Los registras en `Program.cs` en orden, y el orden es el comportamiento: las solicitudes fluyen de arriba hacia abajo, las respuestas fluyen de vuelta de abajo hacia arriba.

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.Use(async (context, next) =>
{
    // Runs for EVERY request, including ones that will 404.
    var sw = System.Diagnostics.Stopwatch.StartNew();
    await next(context);
    sw.Stop();
    app.Logger.LogInformation(
        "{Method} {Path} -> {Status} in {Elapsed}ms",
        context.Request.Method, context.Request.Path,
        context.Response.StatusCode, sw.ElapsedMilliseconds);
});

app.MapGet("/hello/{name}", (string name) => $"Hi {name}");

app.Run();
```

Ese middleware de temporización mide toda la solicitud, incluidos el enrutamiento y cualquier 404. Solo tiene acceso a `context.Request.Path` como una cadena. No puede ver que `name` se enlazó a `"world"`, porque en el punto en que se ejecuta el middleware externo, el enlace todavía no ha ocurrido. El middleware opera un nivel por debajo del sistema de tipos de tu handler.

La posición respecto a `UseRouting` importa más de lo que la gente espera. En el modelo de hosting minimal moderno, `WebApplication` inserta el enrutamiento automáticamente, pero puedes llamar a `app.UseRouting()` explícitamente para controlar dónde ocurre la división. El middleware registrado antes del enrutamiento se ejecuta antes de que siquiera se seleccione un endpoint. El middleware registrado después de `UseRouting` puede leer los metadatos del endpoint seleccionado a través de `context.GetEndpoint()`, que es como `UseAuthorization` sabe qué política aplicar. Por eso el orden canónico es `UseRouting`, luego `UseAuthentication`, luego `UseAuthorization` y luego la ejecución del endpoint: la autorización necesita los metadatos del endpoint que produjo el enrutamiento.

## Qué ve un filtro de endpoint, y cuándo

Un filtro de endpoint envuelve la invocación de un único handler de ruta. Se ejecuta después del enrutamiento y después del enlace, así que tiene lo único que el middleware no puede obtener: los argumentos reales y tipados que tu handler está a punto de recibir.

```csharp
// .NET 11, C# 14
app.MapPost("/orders", (Order order) => Results.Created($"/orders/{order.Id}", order))
    .AddEndpointFilter(async (context, next) =>
    {
        // The Order is already bound. Middleware could never see this.
        var order = context.GetArgument<Order>(0);
        if (order.Quantity < 1)
        {
            return Results.Problem("Quantity must be at least 1.");
        }
        return await next(context);
    });
```

El tipo de retorno del filtro es `ValueTask<object?>`. Devolver cualquier `IResult` (como `Results.Problem`) hace cortocircuito y escribe ese resultado en la respuesta sin llegar a llamar al handler. Devolver `await next(context)` ejecuta el handler y pasa su resultado de vuelta por la cadena, así que un filtro también puede transformar la respuesta a la salida. Como el filtro ve el `Order` enlazado, la validación vive naturalmente aquí. Un componente de middleware que intentara hacer el mismo trabajo tendría que releer y volver a deserializar el cuerpo de la solicitud por su cuenta, duplicando el trabajo que el framework ya hizo. Los detalles completos de `AddEndpointFilter`, la forma con clase basada en `IEndpointFilter` y el orden de los filtros se cubren en [cómo agregar un filtro de endpoint a una minimal API](/es/2026/07/how-to-add-an-endpoint-filter-to-a-minimal-api-in-aspnetcore-11/); este artículo trata sobre cuándo elegirlo por encima del middleware, en primer lugar.

## Cuándo elegir middleware

- **La preocupación es global e independiente de la ruta.** El manejo de excepciones (`UseExceptionHandler`), la redirección HTTPS, HSTS, CORS, la compresión de respuestas, los archivos estáticos y el procesamiento de encabezados reenviados necesitan ejecutarse en cada solicitud sin importar qué endpoint (si es que hay alguno) coincide. Un filtro no puede expresar "ejecutar para todo", porque un filtro está ligado a los endpoints, y un 404 no tiene endpoint. La compresión de respuestas en particular pertenece al pipeline, como se cubre en [agregar compresión de respuestas a una API de ASP.NET Core 11](/es/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/).
- **Necesitas ejecutar antes del enrutamiento.** Reescribir la ruta, quitar un prefijo o rechazar una solicitud antes de que el enrutador siquiera la mire es inherentemente un trabajo de middleware. Los filtros de endpoint se ejecutan después de que la ruta coincide, así que llegan demasiado tarde para influir en el enrutamiento.
- **Estás capturando excepciones en toda la app.** `UseExceptionHandler` y las páginas de excepciones para desarrolladores envuelven todo el pipeline posterior. Un filtro solo envuelve su único endpoint, así que una excepción lanzada durante el enrutamiento o en otro middleware nunca lo alcanza. El manejo global de errores es una preocupación del pipeline, que es también por qué una [configuración de filtro global de excepciones](/es/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) se registra a nivel de app en lugar de por endpoint.
- **La lógica debe ver solicitudes que darán 404.** Las métricas, el registro de solicitudes y la limitación de tasa frecuentemente necesitan contar o limitar solicitudes que nunca coinciden con un endpoint. El middleware ve esas; los filtros no.

## Cuándo elegir un filtro de endpoint

- **Necesitas los argumentos enlazados.** Validar un `Product`, verificar que un parámetro de consulta `page` esté dentro de rango o normalizar una cadena requieren todos el valor tipado. `context.GetArgument<T>(index)` y la lista mutable `context.Arguments` te dan exactamente eso, y no hay equivalente en el middleware.
- **La preocupación aplica a algunos endpoints, no a todos.** Un filtro se adjunta a un solo endpoint o, vía `MapGroup`, a un grupo de ellos. Si tu validación solo tiene sentido para `POST /products` y `PUT /products/{id}`, un filtro de grupo la limita con precisión sin contaminar el pipeline global. Esto compone con los módulos por recurso descritos en [organizar endpoints de minimal API con MapGroup](/es/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/).
- **Quieres inspeccionar o reescribir el resultado del handler.** Como el valor de retorno del filtro fluye de vuelta por la cadena, puede envolver un resultado exitoso en un envoltorio, agregar pistas de caché o traducir un resultado de dominio a un `IResult`. El middleware solo puede manipular el flujo de respuesta en crudo, lo cual es mucho más torpe una vez que el handler ha empezado a escribir.
- **Quieres la misma lógica en minimal APIs y controladores.** `AddEndpointFilter` también funciona en el generador de convenciones de endpoint de un controlador, así que un solo delegado de filtro puede proteger tanto un endpoint minimal como una acción MVC que comparten una ruta.

## El único lugar donde el rendimiento entra realmente en la decisión

Es tentador recurrir a un filtro "porque el middleware se ejecuta para todo y eso es un desperdicio". Resiste enmarcarlo como una competencia de rendimiento. Ambas características son ligeras: un filtro es un delegado que devuelve `ValueTask<object?>`, y un componente de middleware es un delegado que devuelve `Task`, y la sobrecarga por invocación de cualquiera de los dos es insignificante junto a cualquier handler real que toque una base de datos o serialice JSON. La diferencia significativa no es el costo por llamada, es cuántas llamadas ocurren. Un componente de middleware colocado temprano en el pipeline se ejecuta en cada solicitud, así que el trabajo costoso allí (una consulta a base de datos, una asignación grande) lo paga cada 404 y cada ping de health-check. El mismo trabajo en un filtro de endpoint se ejecuta solo cuando ese endpoint es seleccionado. Así que la regla de rendimiento no es "los filtros son más rápidos", es "limita el trabajo a donde se necesita". Si una preocupación transversal genuinamente aplica a cada ruta, el middleware es el hogar correcto y no más lento para ella. Si aplica a un puñado de endpoints, un filtro evita ejecutarla en las miles de solicitudes que nunca tocarán esos endpoints. Esa es una decisión de alcance disfrazada de una de rendimiento, y es la versión honesta de la afirmación.

## Los detalles que eligen por ti

Unas cuantas restricciones duras anulan la preferencia por completo.

**Un filtro no puede ejecutarse antes del enrutamiento, nunca.** Si tu requisito es "rechazar la solicitud antes de que el enrutador la vea" o "reescribir la URL", un filtro es físicamente incapaz de ello, porque vive dentro de la ejecución del endpoint, que es posterior al enrutamiento. Esto fuerza el middleware.

**El middleware no puede ver el modelo enlazado sin rehacer el trabajo.** Si tu requisito es "validar el cuerpo deserializado de la solicitud", el middleware tendría que almacenar en búfer y deserializar el cuerpo por su cuenta, y luego el framework lo deserializa de nuevo para el handler. Ese doble enlace es una señal fuerte de que querías un filtro. Esto fuerza un filtro.

**Las excepciones escapan del alcance de un filtro.** Un filtro solo envuelve su endpoint, así que no puede ser tu red de seguridad para toda la app. Si pones tu único manejo de excepciones en un filtro, una excepción lanzada en otro middleware, o durante el enrutamiento, pasa de largo y llega al manejador 500 por defecto. El manejo global de errores fuerza el middleware.

**Los modelos de orden difieren, y mezclarlos confunde a la gente.** El middleware se anida por orden de registro en `Program.cs`. Los filtros se anidan por el orden en que encadenas las llamadas `.AddEndpointFilter`: el primero registrado ejecuta su código previo a `next` primero y su código posterior a `next` al final. Cuando apilas ambos, toda la cadena de filtros de un endpoint se ejecuta dentro del punto más interno del pipeline de middleware, después de que `UseRouting`, `UseAuthentication` y `UseAuthorization` hayan ejecutado. Así que la autorización siempre se ejecuta antes que cualquier filtro de endpoint, lo cual suele ser lo que quieres, pero significa que un filtro es el lugar equivocado para implementar un esquema de autenticación. La autenticación fuerza el middleware.

**El comportamiento terminal es opuesto.** Un componente de middleware que no llama a `next` hace cortocircuito simplemente al no continuar. Un filtro hace cortocircuito devolviendo un `IResult`. Si escribes un filtro y olvidas devolver algo en la ruta de cortocircuito, obtienes un error de compilación o un resultado nulo en lugar de una solicitud silenciosamente tragada, lo cual es una pequeña pero real ventaja ergonómica para los filtros.

## La recomendación, reformulada

Por defecto, esto: las preocupaciones transversales que deben ejecutarse en cada solicitud, o antes del enrutamiento, son middleware. Las preocupaciones que necesitan los argumentos tipados del handler, o que aplican a un subconjunto de endpoints, son filtros de endpoint. La autenticación, CORS, el manejo de excepciones, la compresión y los archivos estáticos son middleware y siempre lo serán. La validación, la normalización de argumentos, la auditoría por endpoint y el moldeado de resultados son filtros de endpoint. El caso de zona gris es la lógica de autorización por endpoint: si solo necesita claims de `HttpContext.User`, cualquiera funciona, pero prefiere un filtro para que la política viva junto al endpoint que protege; si necesita los argumentos enlazados para tomar la decisión (verificaciones de acceso a nivel de fila sobre un id de entidad enlazado), debe ser un filtro. Cuando genuinamente no puedas decidir, hazte la única pregunta que resuelve casi todos los casos: ¿este código necesita ver los argumentos que mi handler recibirá? Sí significa filtro. No, y debe ejecutarse sin importar la ruta, significa middleware.

## Relacionados

- [Cómo agregar un filtro de endpoint a una minimal API en ASP.NET Core 11](/es/2026/07/how-to-add-an-endpoint-filter-to-a-minimal-api-in-aspnetcore-11/)
- [Cómo organizar endpoints de minimal API con MapGroup en ASP.NET Core 11](/es/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [Cómo agregar un filtro global de excepciones en ASP.NET Core 11](/es/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/)
- [Cómo agregar compresión de respuestas a una API de ASP.NET Core 11](/es/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/)
- [Minimal APIs vs. controladores en ASP.NET Core 11](/es/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)

## Fuentes

- [Filters in Minimal API apps (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/min-api-filters)
- [ASP.NET Core Middleware (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/middleware/)
- [ASP.NET Core Middleware order (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/middleware/#middleware-order)
- [IEndpointFilter interface (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.iendpointfilter)
