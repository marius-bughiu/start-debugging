---
title: "Cómo agregar un endpoint filter a una minimal API en ASP.NET Core 11"
description: "Una guía completa y funcional de los endpoint filters en una minimal API de ASP.NET Core 11: AddEndpointFilter con un delegado en línea, clases IEndpointFilter con inyección de dependencias, GetArgument y la lista Arguments, cortocircuito con Results.Problem, orden FIFO/FILO entre varios filtros, filtros a nivel de grupo en MapGroup y AddEndpointFilterFactory para filtros que dependen de la firma."
pubDate: 2026-07-19
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-api"
  - "validation"
lang: "es"
translationOf: "2026/07/how-to-add-an-endpoint-filter-to-a-minimal-api-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-19
---

Para agregar un endpoint filter a una minimal API en ASP.NET Core 11, llamas a `.AddEndpointFilter()` sobre el endpoint (o el grupo de rutas) y le pasas un delegado en línea `async (context, next) => ...` o una clase que implemente `IEndpointFilter`. El filtro se ejecuta después del enlace del modelo y antes de tu handler, ve los argumentos enlazados a través de `context.GetArgument<T>(index)` y, o bien llama a `await next(context)` para continuar, o bien devuelve un valor como `Results.Problem(...)` para cortocircuitar la solicitud. Ese es todo el modelo. Este post lo recorre de principio a fin: la forma en línea, la forma con clase y con inyección de dependencias, el orden cuando apilas varios filtros, la aplicación de un filtro a todo un `MapGroup` y la vía de escape de la factoría de filtros. Está dirigido a .NET 11 (Preview 6 al momento de escribir esto, con GA en noviembre de 2026) con `Microsoft.NET.Sdk.Web` y C# 14, pero los endpoint filters son estables desde ASP.NET Core 7, así que cada ejemplo aquí se ejecuta sin cambios en .NET 8, 9 y 10.

## Qué envuelve realmente un endpoint filter

Un endpoint filter es un fragmento de código que envuelve la invocación de un único route handler. A diferencia del middleware, que se ejecuta para cada solicitud que atraviesa ese punto del pipeline haya coincidido una ruta o no, un filtro se ejecuta solo cuando se selecciona su endpoint. Y a diferencia del middleware, un filtro se ejecuta después del enrutamiento y después del enlace de parámetros, así que para cuando se ejecuta, el framework ya ha analizado los valores de ruta, enlazado el cuerpo de la solicitud y resuelto los argumentos del handler. Ese momento es toda la razón de existir de los filtros: puedes inspeccionar e incluso mutar los argumentos exactos que tu handler está a punto de recibir, y puedes inspeccionar o reemplazar el resultado que produjo, todo sin tocar el handler.

En concreto, un filtro puede hacer tres cosas:

- Ejecutar código antes del handler (validar argumentos, registrar, iniciar un cronómetro).
- Cortocircuitar: devolver un resultado en lugar de llamar al handler.
- Ejecutar código después del handler, incluida la inspección o el reemplazo de su valor de retorno.

Eso encaja limpiamente con la validación, el registro por endpoint, el modelado de solicitudes y las preocupaciones transversales ligeras que no merecen su propio middleware.

## Pasos para agregar un endpoint filter

1. Registra tus servicios y compila la aplicación como de costumbre con `WebApplication.CreateBuilder(args)`.
2. Mapea un endpoint con `MapGet`, `MapPost` o un `MapGroup`.
3. Encadena `.AddEndpointFilter(...)` sobre el builder devuelto, pasando un delegado en línea o un tipo `IEndpointFilter`.
4. Dentro del filtro, lee los argumentos con `context.GetArgument<T>(index)` y decide si continuar.
5. Llama a `await next(context)` para ejecutar el handler, o devuelve un valor (por ejemplo `Results.Problem(...)`) para cortocircuitar.

El resto de este artículo desarrolla cada uno de esos puntos en código funcional.

## La forma con delegado en línea

La manera más rápida de agregar un filtro es un delegado en línea. Toma dos parámetros: el `EndpointFilterInvocationContext` (que expone `HttpContext` y los `Arguments` enlazados) y `next`, un `EndpointFilterDelegate` que invocas para continuar el pipeline.

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

var app = builder.Build();

string ColorName(string color) => $"Color specified: {color}";

app.MapGet("/color/{color}", ColorName)
    .AddEndpointFilter(async (context, next) =>
    {
        var color = context.GetArgument<string>(0);

        if (color == "Red")
        {
            // Short-circuit: the handler never runs.
            return Results.Problem("Red is not allowed.");
        }

        // Continue to the next filter, or the handler if this is the last one.
        return await next(context);
    });

app.Run();
```

`context.GetArgument<string>(0)` extrae el primer argumento pasado a `ColorName`, que es `color`. El índice es posicional: coincide con el orden en que aparecen los parámetros en la declaración del handler, no con el orden de los segmentos de la plantilla de ruta. Si prefieres no contar posiciones, `context.Arguments` es un `IList<object?>` que puedes recorrer, y `GetArguments()` devuelve la misma lista.

El tipo de retorno de un filtro es `ValueTask<object?>`. Devolver `Results.Problem(...)` (o cualquier `IResult`) cortocircuita y ese resultado se escribe en la respuesta. Devolver `await next(context)` ejecuta el handler y pasa su resultado hacia arriba en la cadena. Como el valor de retorno fluye de vuelta a través de cada filtro, también puedes transformarlo a la salida.

## La forma con clase IEndpointFilter, con inyección de dependencias

Los delegados en línea son perfectos para lógica puntual, pero un filtro que quieras reutilizar entre endpoints pertenece a una clase. Implementa `IEndpointFilter`, que tiene un único método:

```csharp
// .NET 11, C# 14
public class ValidationFilter<T> : IEndpointFilter where T : class
{
    private readonly ILogger<ValidationFilter<T>> _logger;

    public ValidationFilter(ILogger<ValidationFilter<T>> logger)
    {
        _logger = logger;
    }

    public async ValueTask<object?> InvokeAsync(
        EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var model = context.Arguments.OfType<T>().FirstOrDefault();

        if (model is null)
        {
            return Results.Problem($"No {typeof(T).Name} argument found.");
        }

        var errors = Validate(model);
        if (errors.Count > 0)
        {
            _logger.LogWarning("Validation failed for {Type}", typeof(T).Name);
            return Results.ValidationProblem(errors);
        }

        return await next(context);
    }

    private static Dictionary<string, string[]> Validate(T model) => new();
}
```

Regístralo con la sobrecarga genérica:

```csharp
// .NET 11, C# 14
app.MapPost("/products", (Product product) => Results.Created($"/products/{product.Id}", product))
    .AddEndpointFilter<ValidationFilter<Product>>();
```

Dos cosas sobre cómo se construye esta clase importan. Primera, las dependencias del constructor del filtro (`ILogger<T>` arriba) se resuelven desde el contenedor de inyección de dependencias, así que puedes inyectar loggers, opciones o cualquier servicio registrado. Segunda, y esto pilla a la gente: el tipo del filtro en sí no se resuelve como servicio. No registras `ValidationFilter<Product>` en `builder.Services`. El framework lo activa por ti y satisface su constructor desde la inyección de dependencias, pero no es un servicio singleton ni scoped gestionado por el contenedor. Si intentas `builder.Services.AddScoped<ValidationFilter<Product>>()` esperando que `AddEndpointFilter<T>()` lo obtenga del contenedor, ese registro simplemente se ignora.

Usar `Results.ValidationProblem` aquí produce un cuerpo de problem-details según RFC 9457 con un diccionario de errores de estilo `422`. Si quieres controlar esa forma de manera central en lugar de por filtro, para eso sirve exactamente una [configuración de IProblemDetailsService](/es/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/).

## Cuando apilas filtros, el orden es FIFO al entrar y FILO al salir

Puedes adjuntar más de un filtro a un endpoint, y el orden es la parte más confusa de la característica hasta que lo has visto una vez. La regla: el código antes de `next` se ejecuta en el orden en que registraste los filtros (primero en entrar, primero en salir); el código después de `next` se ejecuta en orden inverso (primero en entrar, último en salir). Se anida como una pila.

```csharp
// .NET 11, C# 14
app.MapGet("/demo", () =>
    {
        app.Logger.LogInformation("        Handler");
        return "done";
    })
    .AddEndpointFilter(async (context, next) =>
    {
        app.Logger.LogInformation("Before A");
        var result = await next(context);
        app.Logger.LogInformation("After A");
        return result;
    })
    .AddEndpointFilter(async (context, next) =>
    {
        app.Logger.LogInformation("    Before B");
        var result = await next(context);
        app.Logger.LogInformation("    After B");
        return result;
    });
```

Eso registra:

```dotnetcli
Before A
    Before B
        Handler
    After B
After A
```

Así que el primer filtro que agregas es el envoltorio más externo. Si quieres que una compuerta al estilo de autenticación se ejecute antes que un filtro de registro, agrega la compuerta primero. Si un filtro cortocircuita devolviendo sin llamar a `next`, se omite cada filtro registrado después de él, y los que están antes de él aún ejecutan su código posterior a `next` porque su `await next(context)` devuelve el resultado del cortocircuito. Por eso un filtro de validación temprano puede rechazar una solicitud de forma segura: todo lo que está aguas abajo, incluido el handler, nunca se ejecuta.

## Mutar argumentos antes de que el handler los vea

Como un filtro se ejecuta después del enlace, puede cambiar los argumentos in situ y el handler recibe los valores modificados. La lista `Arguments` es mutable. Esto es genuinamente útil para la normalización: recortar cadenas, poner un código en mayúsculas, limitar un tamaño de página.

```csharp
// .NET 11, C# 14
app.MapGet("/search", (string q, int pageSize) => new { q, pageSize })
    .AddEndpointFilter(async (context, next) =>
    {
        // Normalize the query and clamp the page size before the handler runs.
        if (context.Arguments[0] is string q)
        {
            context.Arguments[0] = q.Trim();
        }
        if (context.Arguments[1] is int size)
        {
            context.Arguments[1] = Math.Clamp(size, 1, 100);
        }

        return await next(context);
    });
```

Ten presente una precaución: mutar por índice posicional acopla el filtro al orden de parámetros del handler. Un filtro genérico y reutilizable está mejor si coincide por tipo (`context.Arguments.OfType<T>()`) o lee directamente de `HttpContext`, que es lo que hace que el `ValidationFilter<T>` basado en clase de arriba sea independiente del endpoint.

## Aplicar un filtro a todo un grupo de rutas

Repetir `.AddEndpointFilter<...>()` en cada endpoint es ruido. Como `MapGroup` devuelve un `RouteGroupBuilder` que traslada las convenciones a sus hijos, un filtro agregado al grupo se ejecuta para cada endpoint dentro de él. Esto se compone con los módulos de endpoints por recurso de [organizar endpoints de minimal API con MapGroup](/es/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/):

```csharp
// .NET 11, C# 14
var products = app.MapGroup("/products")
    .AddEndpointFilter<ValidationFilter<Product>>();

products.MapPost("/", (Product p) => Results.Created($"/products/{p.Id}", p));
products.MapPut("/{id:int}", (int id, Product p) => Results.NoContent());
```

Los filtros de grupo y los filtros de endpoint se combinan, y el orden sigue la misma regla de anidamiento con los filtros del grupo en la parte externa. Un filtro en el grupo envuelve un filtro agregado a un endpoint individual dentro de él. También puedes anidar grupos, y cada nivel añade otra capa.

Si quieres que un filtro se aplique a toda la aplicación en lugar de a un grupo con nombre, agrégalo a un grupo que cubra la raíz: `app.MapGroup("").AddEndpointFilter(...)`. No hay un registro separado de "filtro global", pero un grupo raíz es el equivalente idiomático, y mantiene los filtros acotados a los endpoints enrutados en lugar de convertirlos en middleware.

## La forma de factoría para filtros que dependen de la firma

`AddEndpointFilterFactory` es la puerta avanzada. En lugar de una instancia de filtro, proporcionas una factoría que se ejecuta una vez por endpoint al arrancar, recibe un `EndpointFilterFactoryContext` con el `MethodInfo` del handler y devuelve el delegado de filtro real. Esto te permite inspeccionar la firma del handler y construir un filtro especializado, o cachear resultados de reflexión para que se calculen una sola vez en lugar de por solicitud.

```csharp
// .NET 11, C# 14 -- only attach the validation logic when the handler takes a Product first
app.MapPost("/products", (Product product) =>
        Results.Created($"/products/{product.Id}", product))
    .AddEndpointFilterFactory((factoryContext, next) =>
    {
        var parameters = factoryContext.MethodInfo.GetParameters();
        var isProductFirst = parameters.Length >= 1
            && parameters[0].ParameterType == typeof(Product);

        if (!isProductFirst)
        {
            // Pass-through: no per-request cost for endpoints that do not match.
            return context => next(context);
        }

        return async context =>
        {
            var product = context.GetArgument<Product>(0);
            if (string.IsNullOrWhiteSpace(product.Name))
            {
                return Results.Problem("Name is required.");
            }
            return await next(context);
        };
    });
```

La ventaja aquí es que la inspección de `MethodInfo` ocurre una vez en tiempo de compilación, no en cada solicitud, y los endpoints cuya firma no coincide no pagan nada más allá de un delegado de paso directo. Recurre a la factoría solo cuando un filtro simple no pueda expresar lo que necesitas; para el caso común de validar y continuar, la forma con clase es más simple y se lee mejor.

## Los filtros no son middleware, ni action filters

Dos comparaciones aclaran la mayor parte de la confusión restante. Frente al middleware: un endpoint filter se ejecuta solo para su endpoint y solo después del enlace, así que puede ver argumentos tipados; el middleware se ejecuta para toda una rama del pipeline y solo ve el `HttpContext` en bruto. Si tu lógica necesita el modelo enlazado, quiere un filtro. Si necesita ejecutarse antes del enrutamiento o a través de muchos endpoints no relacionados, quiere middleware. Frente a los action filters de MVC (`IActionFilter`, `IAsyncActionFilter`): los endpoint filters son el equivalente en minimal API, pero son un tipo diferente en un namespace diferente. No puedes reutilizar un action filter de MVC en un endpoint de minimal API. El único puente que Microsoft proporciona es que `AddEndpointFilter` también funciona sobre el `ControllerActionEndpointConventionBuilder` de un controlador, así que un único delegado de endpoint filter puede compartirse entre endpoints de minimal API y actions de controlador si enrutas ambos.

Una nota práctica más: como un filtro puede cortocircuitar con un `IResult`, se combina de forma natural con los resultados tipados. Si tu handler devuelve una [unión Results tipada](/es/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/), un filtro que devuelve `Results.Problem` aún encaja limpiamente, ya que el tipo de retorno del filtro es `object?` y cualquier `IResult` se escribe en la respuesta. Y para una validación genuinamente pesada, sopesa un filtro frente a la [validación de solicitudes integrada](/es/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/) que ASP.NET Core 11 puede ejecutar a partir de data annotations sin ningún filtro.

## La forma que hay que recordar

Agregar un endpoint filter se reduce a `.AddEndpointFilter(...)` sobre un endpoint o un `MapGroup`, un delegado en línea para casos puntuales o una clase `IEndpointFilter` para la reutilización, `context.GetArgument<T>(index)` (o `context.Arguments`) para leer los valores enlazados, y `await next(context)` para continuar frente a devolver un `IResult` para cortocircuitar. Recuerda que las dependencias del constructor vienen de la inyección de dependencias pero el tipo del filtro en sí no es un servicio registrado, que los filtros apilados se anidan FIFO al entrar y FILO al salir, que los filtros de grupo envuelven a los filtros de endpoint, y que `AddEndpointFilterFactory` existe para el caso raro en que necesites inspeccionar la firma del handler. Esa es toda la superficie, y cada línea de arriba se ejecuta en .NET 8 hasta .NET 11 sin cambios.

## Relacionado

- [Cómo organizar endpoints de minimal API con MapGroup en ASP.NET Core 11](/es/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [Cómo validar cuerpos de solicitud en minimal APIs sin controladores en ASP.NET Core 11](/es/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/)
- [Cómo personalizar las respuestas de error de validación de minimal API con IProblemDetailsService en ASP.NET Core 11](/es/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/)
- [Cómo devolver una unión Results tipada desde un endpoint de minimal API en ASP.NET Core 11](/es/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/)
- [Minimal APIs vs controladores en ASP.NET Core 11](/es/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)

## Fuentes

- [Filters in Minimal API apps (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/min-api-filters)
- [IEndpointFilter interface (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.iendpointfilter)
- [EndpointFilterInvocationContext (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.endpointfilterinvocationcontext)
- [RouteHandlerBuilderExtensions.AddEndpointFilter (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.endpointfilterextensions)
