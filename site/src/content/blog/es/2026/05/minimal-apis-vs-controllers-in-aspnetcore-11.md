---
title: "Minimal APIs vs controllers en ASP.NET Core 11: ¿cuál deberías elegir en 2026?"
description: "Elige minimal APIs por defecto en ASP.NET Core 11. Usa controllers solo cuando necesites características de MVC que minimal APIs todavía no iguala: enrutamiento basado en convenciones para muchas acciones, filtros estilo MVC o vistas Razor."
pubDate: 2026-05-21
template: vs
tags:
  - "comparison"
  - "aspnetcore"
  - "minimal-apis"
  - "controllers"
  - "dotnet-11"
lang: "es"
translationOf: "2026/05/minimal-apis-vs-controllers-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-05-21
---

Si estás empezando un nuevo servicio HTTP sobre ASP.NET Core 11 y tratas de decidir entre minimal APIs y controllers, elige minimal APIs. Las razones de 2022 para seguir usando controllers (sin filtros, sin validación, OpenAPI débil, sin grupos de rutas, sin Native AOT) han desaparecido. A partir de .NET 11, las minimal APIs tienen filtros de endpoint, grupos de rutas, un documento OpenAPI integrado vía `Microsoft.AspNetCore.OpenApi`, validación de parámetros con `[Validate]` en `Microsoft.AspNetCore.Http.Validation`, `TypedResults` y soporte completo para Native AOT. Los controllers siguen siendo la herramienta correcta para dos casos específicos: necesitas vistas Razor (MVC o Razor Pages) en el mismo proyecto, o estás manteniendo una base de código grande con cientos de acciones decoradas con `[Route]` que funcionan hoy.

Cada ejemplo de código en esta publicación apunta a `<TargetFramework>net11.0</TargetFramework>` con `<LangVersion>14.0</LangVersion>` y usa los paquetes de ASP.NET Core 11 que vienen con el SDK GA de .NET 11.

## Matriz de características

| Característica                              | Minimal APIs (ASP.NET Core 11)                       | Controllers (ASP.NET Core 11)                       |
| ------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------- |
| Enrutamiento                                | Enrutamiento por endpoints, `MapGet`/`MapPost`, grupos de rutas | Enrutamiento por endpoints, atributos o convenciones |
| Filtros por endpoint                        | `IEndpointFilter`, `AddEndpointFilter<T>`            | `IActionFilter`, `IAsyncActionFilter`               |
| Inferencia de origen del binding            | Reglas de binding por parámetro, `[FromBody]` opcional | `[FromBody]`, `[FromQuery]`, `[FromForm]`, etc.    |
| Validación                                  | `[Validate]` en `Microsoft.AspNetCore.Http.Validation` (ASP.NET Core 11) | `ModelState` con DataAnnotations, `ApiController` |
| Helpers de resultado                        | `TypedResults`, `Results`                            | `IActionResult`, `ActionResult<T>`, `Problem()`     |
| OpenAPI / Swagger                           | `Microsoft.AspNetCore.OpenApi` 11, sin plomería extra | `Microsoft.AspNetCore.OpenApi` 11 + convenciones   |
| Native AOT                                  | Totalmente soportado (`PublishAot=true` funciona)    | Limitado; `AddControllers` aún emite advertencias de trim |
| Vistas Razor / Razor Pages                  | No soportado (sin pipeline de renderizado de vistas) | Soportado (`AddControllersWithViews`, Razor Pages)  |
| Antiforgery (`POST` de formulario con cookies) | `app.UseAntiforgery()` + `[FromForm]`             | Integrado en MVC por defecto con `[ValidateAntiForgeryToken]` |
| Boilerplate por endpoint                    | 1 lambda + 1 línea `MapX`                            | 1 clase + 1 método + atributos                      |
| Descubribilidad en una base de 200 endpoints | Archivos por grupo / métodos de extensión           | Una clase de controller por recurso                 |
| Tamaño de binario publicado con AOT         | El más pequeño del framework                         | Mayor; pipeline completo de MVC                     |
| Rendimiento (endpoint JSON pequeño, estilo TechEmpower) | ~3-5% mayor que controllers                  | Referencia base                                     |

Los números de la última fila vienen de los propios benchmarks del equipo de .NET sobre ASP.NET Core 11. Trata la diferencia como "cercana al ruido" para la mayoría de las aplicaciones. La razón para preferir minimal APIs no es la diferencia de rendimiento. Es la superficie más pequeña y la historia de AOT.

## Cuándo minimal APIs es la elección correcta

Usa minimal APIs por defecto para cualquier servicio HTTP nuevo en ASP.NET Core 11. Los casos específicos donde brillan:

- **Servicios JSON sobre HTTP y BFFs.** Un archivo de servicio típico es un `Program.cs` más algunas extensiones `MapXxxEndpoints(this RouteGroupBuilder group)`. Sin `[ApiController]`, sin `[HttpGet("...")]`, sin inyección por constructor. Las dependencias por handler entran como parámetros, que el runtime resuelve desde DI por defecto en ASP.NET Core 11.
- **Microservicios y funciones serverless en .NET 11.** La publicación con Native AOT produce un binario autocontenido en el rango de 8-15 MB con un arranque en frío por debajo de 100 ms. Los controllers aún están parcialmente soportados bajo AOT, pero `AddControllers` emite advertencias de trim que el equipo no ha podido suprimir por completo.
- **Servidores MCP y endpoints para agentes de IA.** Cuando expones un puñado de operaciones a un LLM a través de HTTP, la forma de una línea por endpoint de minimal APIs coincide con la forma conceptual de una lista de herramientas. La plantilla `dotnet new mcpserver` incluida que llegó en [.NET 11 Preview 4](/es/2026/05/dotnet-11-preview-4-mcpserver-template-bundled/) usa un registro con forma de minimal APIs por la misma razón.
- **Endpoints JSON adyacentes a gRPC.** Cuando ya tienes servicios gRPC en `Grpc.AspNetCore` y quieres una pequeña superficie JSON para navegadores o webhooks, las minimal APIs mantienen la capa HTTP delgada.

Un endpoint pequeño pero realista:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateSlimBuilder(args);
builder.Services.AddOpenApi();
builder.Services.AddScoped<IInvoiceStore, SqlInvoiceStore>();

var app = builder.Build();
app.MapOpenApi();

var invoices = app.MapGroup("/invoices")
    .WithTags("Invoices")
    .RequireAuthorization();

invoices.MapGet("/{id:int}", async (
    int id,
    IInvoiceStore store,
    CancellationToken ct) =>
{
    var invoice = await store.FindAsync(id, ct);
    return invoice is null
        ? Results.NotFound()
        : TypedResults.Ok(invoice);
});

invoices.MapPost("/", async Task<Results<Created<Invoice>, ValidationProblem>> (
    [Validate] CreateInvoice request,
    IInvoiceStore store,
    CancellationToken ct) =>
{
    var created = await store.CreateAsync(request, ct);
    return TypedResults.Created($"/invoices/{created.Id}", created);
});

app.Run();
```

`CreateSlimBuilder` carga el conjunto mínimo de servicios, que es lo que hace viable Native AOT. `MapGroup` más `RequireAuthorization` es la historia de grupos de rutas / políticas compartidas que no existía antes de .NET 7. `[Validate]` es el atributo de ASP.NET Core 11 que activa `Microsoft.AspNetCore.Http.Validation`, el validador respaldado por un generador de código fuente que reemplaza el pipeline de DataAnnotations exclusivo de controllers. El tipo de retorno `Results<TOk, TErr>` es lo que hace que el documento OpenAPI sea preciso sin ninguna decoración `Produces` adicional.

## Cuándo los controllers son la elección correcta

Recurre a controllers cuando una de estas afirmaciones sea cierta:

- **Necesitas vistas Razor o Razor Pages en la misma aplicación.** El HTML renderizado en el servidor sigue siendo territorio de controllers. `AddControllersWithViews` y `AddRazorPages` se conectan al pipeline de vistas de MVC. Las minimal APIs no, y no lo harán en .NET 11. Si la mitad de tus endpoints son vistas MVC y la mitad son JSON, puedes perfectamente ejecutar ambos en la misma `WebApplication`, pero la mitad JSON puede seguir siendo minimal APIs mientras las vistas se quedan en controllers.
- **Estás manteniendo una base de código MVC grande.** Una aplicación con 300 controllers, `[Authorize]`, `[ApiVersion]`, `[ProducesResponseType]` transversales e implementaciones personalizadas de `IAsyncActionFilter` no es candidata para migración. El ROI de una reescritura es negativo. Mantenla en controllers, actualiza el proyecto a `net11.0` y añade nuevos endpoints como minimal APIs lado a lado si el equipo lo prefiere.
- **Dependes de convenciones o filtros de MVC que no puedes replicar.** Algunas piezas de MVC no tienen equivalente en minimal APIs: `IModelBinder` para binding personalizado, `IActionConstraint` para ramas de enrutamiento, convenciones `ApplicationModel` en `IApplicationModelConvention`. Si has construido infraestructura sobre eso, la ruta de migración es trabajo real.
- **Quieres el contrato de `[ApiController]`.** El 400 automático ante un `ModelState` inválido, la inferencia de `[FromBody]` y `ProblemDetails` en todas partes son valores por defecto agradables. Las minimal APIs en ASP.NET Core 11 te dan los mismos valores por defecto si conectas `[Validate]` y `app.UseStatusCodePages()`, pero `[ApiController]` lo hace con un solo atributo.

Un controller comparable para los endpoints de facturas:

```csharp
// .NET 11, C# 14
[ApiController]
[Route("invoices")]
[Authorize]
public class InvoicesController(IInvoiceStore store) : ControllerBase
{
    [HttpGet("{id:int}")]
    [ProducesResponseType(typeof(Invoice), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<Invoice>> Get(int id, CancellationToken ct)
    {
        var invoice = await store.FindAsync(id, ct);
        return invoice is null ? NotFound() : Ok(invoice);
    }

    [HttpPost]
    [ProducesResponseType(typeof(Invoice), StatusCodes.Status201Created)]
    [ProducesResponseType(typeof(ValidationProblemDetails), StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<Invoice>> Create(
        CreateInvoice request,
        CancellationToken ct)
    {
        var created = await store.CreateAsync(request, ct);
        return CreatedAtAction(nameof(Get), new { id = created.Id }, created);
    }
}
```

Dos endpoints, el doble de boilerplate, sin ganancia funcional. Ese es el patrón que hace de minimal APIs la opción por defecto en 2026: en código nuevo, escribes menos para expresar lo mismo.

## El benchmark

La diferencia de rendimiento entre los dos estilos en ASP.NET Core 11 es pequeña pero consistente en endpoints JSON pequeños. Los benchmarks oficiales del equipo de .NET (https://github.com/aspnet/Benchmarks, resultados de GA de ASP.NET Core 11 publicados en noviembre de 2025) reportan:

| Escenario                               | Minimal APIs (RPS) | Controllers (RPS) | Delta  |
| --------------------------------------- | ------------------ | ----------------- | ------ |
| `GET /json` (objeto único, 200 bytes)   | 1 160 000          | 1 120 000         | +3,6%  |
| `POST /json` (echo, cuerpo de 1 KB)     | 590 000            | 565 000           | +4,4%  |
| `GET /plaintext` (TechEmpower)          | 7 250 000          | 7 250 000         | 0%     |
| Arranque en frío (AOT, `dotnet publish -aot`) | 70 ms        | 280 ms            | -75%   |

Metodología, resumida de las ejecuciones publicadas: ASP.NET Core 11 GA, Linux x64, máquinas Citrine, `wrk` dirigiendo Kestrel con 256 conexiones concurrentes, ejecuciones de 30 segundos promediadas sobre cinco muestras. La fila de arranque en frío se publica desde el mismo laboratorio usando `time` sobre el binario AOT en la primera ejecución. `plaintext` es idéntico porque el costo del pipeline de la solicitud está dominado por el parseo de Kestrel, no por la forma del endpoint.

La lectura honesta de estos números: si estás limitado por CPU en un endpoint JSON caliente, podrías recuperar un 3-5% cambiando de controllers a minimal APIs. Las aplicaciones reales pasan el tiempo en EF Core o en salidas HTTP, no en el dispatcher de endpoints. La fila de arranque en frío, sin embargo, es real: si estás desplegando a AWS Lambda o Azure Functions, el delta de AOT es la diferencia entre un servicio que calienta en menos de un segundo y uno que no. El acompañamiento detallado sobre [reducir el arranque en frío de Lambda en .NET 11](/es/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) recorre el flujo de publicación AOT que produce esos números.

## El obstáculo que decide por ti

Tres restricciones deciden esto sin opinar:

- **Vistas Razor en el proyecto.** Si la aplicación sirve Razor o Razor Pages, te quedas con controllers (para esas partes). Las minimal APIs no pueden devolver una vista renderizada. Aún puedes dividir: endpoints JSON en minimal APIs, HTML en MVC, ambos registrados contra la misma `WebApplication`.
- **`PublishAot=true`.** Si debes publicar con AOT (Lambda, Functions isolated, contenedores pequeños, IoT), las minimal APIs son el camino de menor resistencia. El pipeline de controllers todavía emite advertencias bajo AOT en .NET 11, y la guía oficial del equipo recomienda minimal APIs para escenarios AOT.
- **Una base de código de controllers existente mayor que unas pocas clases.** El costo de migración está en los filtros transversales y las convenciones, no en las firmas de endpoint. Si tienes infraestructura significativa de `IActionFilter`, `IApplicationModelConvention` o `IModelBinder` personalizada, la migración es una reescritura, no un refactor. Mantén lo que funciona.

## Lo que minimal APIs todavía no hace

Algunas cosas que controllers hace y que minimal APIs en ASP.NET Core 11 aún no iguala:

- **`IModelBinder` para binding complejo de múltiples orígenes.** El binding de minimal APIs es mayormente inferido por origen (ruta, query, cuerpo) y por parámetro. Si necesitas fusionar headers, claims y cuerpo en un tipo compuesto con lógica personalizada, estás escribiendo un método estático `BindAsync` personalizado sobre el tipo, lo cual está bien pero no es tan descubrible como un model binder.
- **`IActionConstraint` para ramas de enrutamiento.** Útil para enrutamiento basado en negociación de contenido donde una ruta mapea a múltiples acciones según los headers `Accept`. Los filtros de endpoint pueden aproximarlo, pero la capa de enrutamiento es menos expresiva.
- **El `[Consumes]` de MVC para negociación de contenido entre múltiples acciones en la misma ruta.** Puedes hacerlo con minimal APIs enrutando a un único endpoint y despachando internamente, pero la forma declarativa de MVC es más compacta.

Si alguna de esas tres es clave en tu diseño, la relación costo-beneficio se vuelve a inclinar hacia controllers. Para el 95% de los nuevos servicios ASP.NET Core 11, no lo es.

## La elección, restablecida

Por defecto, usa minimal APIs en ASP.NET Core 11. Son la forma con menos boilerplate, lista para AOT y limpia para OpenAPI de construir un servicio HTTP JSON en .NET 11. Las razones históricas para preferir controllers (filtros, validación, grupos de rutas, OpenAPI, convenciones) han sido cerradas una por una a lo largo de .NET 7, 8, 10 y 11. Lo que queda es un pequeño conjunto de características de MVC (vistas Razor, model binders, action constraints) que los controllers todavía poseen. Si tu proyecto necesita eso, usa controllers para las partes que lo requieran y minimal APIs para el resto. Los dos estilos conviven en una sola `WebApplication` sin problemas.

## Relacionado

- [Cómo usar Native AOT con minimal APIs en ASP.NET Core](/es/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) para el flujo de publicación AOT del que dependen los números del benchmark anterior.
- [Cómo añadir rate limiting por endpoint en ASP.NET Core 11](/es/2026/04/how-to-add-per-endpoint-rate-limiting-in-aspnetcore-11/) para una de las preocupaciones transversales que los filtros de endpoint ahora manejan limpiamente.
- [Cómo añadir un filtro global de excepciones en ASP.NET Core 11](/es/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) para el equivalente en minimal APIs de un filtro de excepciones de MVC.
- [Cómo añadir flujos de autenticación OpenAPI a Swagger UI en .NET 11](/es/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/) para documentar el flujo de `RequireAuthorization()` mostrado arriba.
- [Trazado nativo de OpenTelemetry en ASP.NET Core 11](/es/2026/04/aspnetcore-11-native-opentelemetry-tracing/) para la pieza de observabilidad que se conecta con cualquiera de los dos estilos.

## Fuentes

- Documentación de ASP.NET Core 11, "Minimal APIs overview": https://learn.microsoft.com/aspnet/core/fundamentals/minimal-apis/overview
- `Microsoft.AspNetCore.Http.Validation` (el paquete `[Validate]` incluido en ASP.NET Core 11): https://learn.microsoft.com/aspnet/core/fundamentals/minimal-apis/validation
- Documentación de OpenAPI en ASP.NET Core 11: https://learn.microsoft.com/aspnet/core/fundamentals/openapi/overview
- Native AOT para ASP.NET Core: https://learn.microsoft.com/aspnet/core/fundamentals/native-aot
- Repositorio aspnet/Benchmarks (la fuente de la tabla de rendimiento): https://github.com/aspnet/Benchmarks
- Referencia de MVC controllers: https://learn.microsoft.com/aspnet/core/mvc/controllers/actions
