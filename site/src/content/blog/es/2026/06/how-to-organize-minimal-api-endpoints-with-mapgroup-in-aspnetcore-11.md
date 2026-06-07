---
title: "Cómo organizar endpoints de minimal API con MapGroup en ASP.NET Core 11"
description: "Una guía completa para estructurar minimal APIs en ASP.NET Core 11 con MapGroup: módulos de endpoints por recurso como métodos de extensión, grupos anidados, filtros y autenticación compartidos, prefijos con parámetros de ruta, etiquetas OpenAPI y las reglas de orden de filtros que sorprenden."
pubDate: 2026-06-07
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-apis"
lang: "es"
translationOf: "2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-06-07
---

Para evitar que una minimal API convierta `Program.cs` en un muro de mil líneas de llamadas `app.MapGet(...)`, agrupa los endpoints relacionados con `app.MapGroup("/prefix")`, que devuelve un `RouteGroupBuilder` que comparte un prefijo de ruta y cualquier convención (filtros, autenticación, etiquetas OpenAPI) que le asocies. El patrón duradero es un método de extensión por recurso: `public static IEndpointRouteBuilder MapTodos(this IEndpointRouteBuilder routes)` construye su propio grupo internamente, y `Program.cs` se reduce a una lista de llamadas `app.MapTodos();`. `MapGroup` es estable desde ASP.NET Core 7 y no cambió en .NET 11. Todo lo de abajo apunta a .NET 11 con `Microsoft.NET.Sdk.Web` y C# 14, pero la API es idéntica en .NET 8, 9 y 10.

## Por qué Program.cs se pudre

Las minimal APIs vienen con una demo seductora: toda la app en un solo archivo. Eso es genial para un ejemplo y terrible para un servicio real. Para cuando tienes un puñado de recursos, cada uno con los cinco verbos CRUD más un par de subrutas, `Program.cs` son unos cientos de líneas de route handlers entremezclados con el registro de DI, el cableado del middleware y `app.Run()`. Te desplazas más allá de la configuración de autenticación para encontrar el `MapPut` que querías editar. Tres handlers empiezan todos con `/api/v1/orders` y uno de ellos tiene un error tipográfico en el prefijo que nadie nota hasta que aparece un 404 en producción.

La solución no es "volver a los controllers". Los controllers resuelven la organización por convención (una clase por recurso, atributos para el ruteo) a costa del pipeline de MVC basado en reflexión. Las minimal APIs lo resuelven con `MapGroup` más métodos de extensión sencillos de C#, y conservas el modelo de endpoints ligero y compatible con AOT. Si todavía estás decidiendo entre los dos modelos, las ventajas y desventajas están detalladas en [minimal APIs vs controllers en ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/). Esta guía asume que ya elegiste las minimal APIs y quieres que escalen.

## MapGroup devuelve un RouteGroupBuilder

`MapGroup` es un método de extensión sobre `IEndpointRouteBuilder`. Recibe un prefijo de ruta y devuelve un `RouteGroupBuilder`:

```csharp
// .NET 11, C# 14
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

RouteGroupBuilder todos = app.MapGroup("/todos");

todos.MapGet("/", () => "all todos");        // GET  /todos/
todos.MapGet("/{id:int}", (int id) => $"todo {id}"); // GET  /todos/42
todos.MapPost("/", () => "created");          // POST /todos/

app.Run();
```

Cada llamada `Map{Verb}` sobre el grupo hereda el prefijo `/todos`, así que los patrones que escribes en el grupo son relativos. `RouteGroupBuilder` implementa `IEndpointRouteBuilder`, que es el detalle que hace funcionar todo lo demás: cualquier cosa que puedas llamar sobre `app` (incluido el propio `MapGroup`) la puedes llamar sobre un grupo. Así es como el anidamiento sale gratis.

El prefijo se combina por simple concatenación. `app.MapGroup("/api").MapGroup("/v1").MapGet("/todos", ...)` registra `GET /api/v1/todos`. No hay magia de normalización más allá de unir los segmentos, así que no dupliques las barras: un prefijo de grupo `/todos/` más un patrón de handler `/{id}` produce `/todos//{id}`, que no coincidirá con lo que esperas.

## Un método de extensión por recurso

El patrón que escala es darle a cada recurso su propia clase estática con un método `Map`, y que ese método cree su propio grupo. El tipo de retorno debe ser `IEndpointRouteBuilder` (o `RouteGroupBuilder`) para que las llamadas se encadenen:

```csharp
// .NET 11, C# 14 -- Endpoints/TodoEndpoints.cs
public static class TodoEndpoints
{
    public static IEndpointRouteBuilder MapTodos(this IEndpointRouteBuilder routes)
    {
        var group = routes.MapGroup("/todos")
            .WithTags("Todos");

        group.MapGet("/", GetAll);
        group.MapGet("/{id:int}", GetById).WithName("GetTodoById");
        group.MapPost("/", Create);
        group.MapPut("/{id:int}", Update);
        group.MapDelete("/{id:int}", Delete);

        return routes;
    }

    private static async Task<Ok<List<Todo>>> GetAll(TodoDb db) =>
        TypedResults.Ok(await db.Todos.ToListAsync());

    private static async Task<Results<Ok<Todo>, NotFound>> GetById(int id, TodoDb db) =>
        await db.Todos.FindAsync(id) is { } todo
            ? TypedResults.Ok(todo)
            : TypedResults.NotFound();

    private static async Task<Created<Todo>> Create(Todo todo, TodoDb db)
    {
        db.Todos.Add(todo);
        await db.SaveChangesAsync();
        return TypedResults.Created($"/todos/{todo.Id}", todo);
    }

    private static async Task<Results<NoContent, NotFound>> Update(int id, Todo input, TodoDb db)
    {
        var todo = await db.Todos.FindAsync(id);
        if (todo is null) return TypedResults.NotFound();
        todo.Title = input.Title;
        todo.Done = input.Done;
        await db.SaveChangesAsync();
        return TypedResults.NoContent();
    }

    private static async Task<Results<NoContent, NotFound>> Delete(int id, TodoDb db)
    {
        var rows = await db.Todos.Where(t => t.Id == id).ExecuteDeleteAsync();
        return rows > 0 ? TypedResults.NoContent() : TypedResults.NotFound();
    }
}
```

Ahora `Program.cs` es una tabla de contenidos:

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddDbContext<TodoDb>(o => o.UseSqlServer(/* ... */));
builder.Services.AddOpenApi();

var app = builder.Build();

app.MapTodos();
app.MapOrders();
app.MapCustomers();

app.MapOpenApi();
app.Run();
```

Dos cosas hacen agradable este idioma. Primero, los handlers son métodos `private static` con nombre en lugar de lambdas, así que cada uno tiene un nombre real en las trazas de pila y es trivial de probar de forma aislada. Segundo, devolver `IEndpointRouteBuilder` desde `MapTodos` te permite seguir encadenando si quieres (`app.MapTodos().MapOrders();`), aunque una llamada por línea se lee mejor.

Una nota sobre el tipo de retorno: si la única tarea de un método es construir un grupo y quieres que el *llamador* le asocie más convenciones a ese grupo, devuelve `RouteGroupBuilder` en su lugar. Si el método registra endpoints y el llamador no debería tocar el grupo después, devuelve `IEndpointRouteBuilder`. Mezclar los dos es la fuente más común de la confusión "por qué no compila mi `.RequireAuthorization()`".

## Filtros, autenticación y metadatos compartidos en una sola llamada

La recompensa de un grupo es que una convención aplicada al grupo se aplica a todos los endpoints debajo de él. Aquí es donde `MapGroup` se gana su lugar frente a copiar y pegar `.RequireAuthorization()` en veinte handlers:

```csharp
// .NET 11, C# 14
var admin = app.MapGroup("/admin")
    .RequireAuthorization("AdminPolicy")   // every endpoint requires the policy
    .WithTags("Admin")                     // one OpenAPI tag for the whole group
    .AddEndpointFilter<AuditFilter>();     // runs for every endpoint in the group

admin.MapGet("/users", ListUsers);
admin.MapDelete("/users/{id:int}", DeleteUser);
```

`RequireAuthorization`, `WithTags`, `WithMetadata`, `RequireRateLimiting`, `AddEndpointFilter` y `AddEndpointFilterFactory` son todos métodos de `IEndpointConventionBuilder`, y `RouteGroupBuilder` implementa esa interfaz, así que todos fluyen hacia los miembros. Si necesitas rate limiting por endpoint particionado por la ruta dentro de un grupo, la [guía de rate limiting por endpoint](/2026/04/how-to-add-per-endpoint-rate-limiting-in-aspnetcore-11/) cubre cómo `RequireRateLimiting` se compone con la política de un grupo.

Hay una sutileza que vale la pena interiorizar: `AddEndpointFilter` sobre un grupo **no** es middleware. No se ejecuta una vez por solicitud al prefijo. Se aplica al pipeline de filtros de cada endpoint de forma individual, en tiempo de compilación. La diferencia práctica es que el filtro solo se ejecuta cuando un endpoint del grupo realmente coincide. Una solicitud a `/admin/nonexistent` que da 404 nunca invoca `AuditFilter`, mientras que un middleware sobre el segmento de ruta `/admin` sí lo haría. Si quieres middleware real acotado a una ruta, usa `app.UseWhen(ctx => ctx.Request.Path.StartsWithSegments("/admin"), ...)` en su lugar.

## Grupos anidados y parámetros de ruta en el prefijo

Como un grupo es a su vez un `IEndpointRouteBuilder`, anidas llamando a `MapGroup` sobre un grupo. Los prefijos pueden contener parámetros de ruta y restricciones, y un handler a cualquier profundidad puede enlazar parámetros declarados en cualquier prefijo ancestro:

```csharp
// .NET 11, C# 14
var orgs = app.MapGroup("/orgs/{orgId:int}");
var projects = orgs.MapGroup("/projects/{projectId:int}");

projects.MapGet("/issues", (int orgId, int projectId) =>
    $"issues for org {orgId}, project {projectId}");
// matches GET /orgs/7/projects/3/issues
```

El handler enlaza tanto `orgId` como `projectId` aunque cada uno esté declarado un nivel más arriba. Esta es la forma limpia de modelar recursos jerárquicos: cada nivel de la URL es un grupo, y los handlers hoja se mantienen cortos porque los valores de ruta compartidos los captura la estructura en lugar de repetirlos en cada patrón.

El prefijo también puede estar vacío. `app.MapGroup("")` no agrega ningún segmento de ruta, que es el truco para asociar una convención o filtro a una franja de endpoints sin cambiar sus URLs:

```csharp
// .NET 11, C# 14
var versioned = app.MapGroup("").WithOpenApi();
var v1 = versioned.MapGroup("/v1");
var v2 = versioned.MapGroup("/v2");
```

## La regla de orden de filtros que confunde a la gente

Cuando los filtros viven en grupos anidados, el orden en que se ejecutan lo determina el anidamiento de grupos, **el más externo primero**, no el orden en que escribiste las llamadas `AddEndpointFilter`. Este es el comportamiento más contraintuitivo de los grupos de rutas, y está documentado pero es fácil de pasar por alto.

```csharp
// .NET 11, C# 14
var outer = app.MapGroup("/outer");
var inner = outer.MapGroup("/inner");

inner.AddEndpointFilter((ctx, next) =>
{
    app.Logger.LogInformation("inner group filter");
    return next(ctx);
});

outer.AddEndpointFilter((ctx, next) =>   // added second, runs first
{
    app.Logger.LogInformation("outer group filter");
    return next(ctx);
});

inner.MapGet("/", () => "Hi!").AddEndpointFilter((ctx, next) =>
{
    app.Logger.LogInformation("endpoint filter");
    return next(ctx);
});
```

Una solicitud a `/outer/inner/` registra, en orden:

```text
outer group filter
inner group filter
endpoint filter
```

El filtro externo se ejecuta antes que el interno aunque se haya agregado en segundo lugar, porque los filtros se aplican desde el grupo más externo hacia adentro, y luego los propios filtros del endpoint al final. El orden relativo de las llamadas `AddEndpointFilter` solo importa cuando están asociadas al *mismo* builder. Entre grupos distintos, gana el anidamiento. Si tienes un filtro de estilo autenticación que debe ejecutarse antes de un filtro de logging, pon la autenticación en el grupo externo, no solo más arriba en el archivo.

## Versionar una minimal API con grupos

Una razón común para recurrir a grupos anidados es el versionado de la API por segmento de URL. Cada versión es un grupo, y cada módulo de recurso se monta bajo el builder de versión que reciba:

```csharp
// .NET 11, C# 14
public static class TodoEndpoints
{
    public static IEndpointRouteBuilder MapTodos(this IEndpointRouteBuilder routes, int version)
    {
        var group = routes.MapGroup($"/todos").WithTags($"Todos v{version}");
        group.MapGet("/", GetAll);
        // v2-only endpoint
        if (version >= 2) group.MapGet("/search", Search);
        return routes;
    }
}

// Program.cs
var v1 = app.MapGroup("/api/v1");
var v2 = app.MapGroup("/api/v2");

v1.MapTodos(version: 1);
v2.MapTodos(version: 2);
```

Para cualquier cosa más allá del versionado por URL hecho a mano (versionado por media-type o por encabezado, encabezados de deprecación, version sets), el paquete `Asp.Versioning` se integra con `MapGroup` a través de `HasApiVersion` sobre el grupo, pero para el caso común de "prefijos de ruta v1 y v2" el anidamiento simple de arriba es suficiente y no agrega ninguna dependencia extra.

## Agrupar en el documento OpenAPI

`WithTags` sobre un grupo es lo que produce las secciones plegables en Swagger UI o Scalar. Etiqueta el grupo una vez y cada endpoint cae bajo esa etiqueta:

```csharp
// .NET 11, C# 14
var todos = app.MapGroup("/todos").WithTags("Todos");
```

Sin una etiqueta, el generador de OpenAPI integrado recurre a usar el primer segmento de ruta como etiqueta, lo cual normalmente funciona pero conviene establecerlo explícitamente para que una refactorización del prefijo no renombre silenciosamente las secciones de tu API. Si además expones flujos de autenticación en la especificación, el grupo es el lugar correcto para asociar el requisito de seguridad de modo que aparezca en cada operación, consulta [agregar flujos de autenticación OpenAPI a Swagger UI en .NET 11](/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/) para el cableado de `WithOpenApi` y los esquemas de seguridad.

## Detalles a tener en cuenta antes de refactorizar

Algunos filos cortantes que es fácil topar cuando reestructuras por primera vez un archivo plano en grupos:

- **`MapGroup` debe llamarse sobre un builder, no después de `app.Run()`.** Como todo registro de endpoints, tiene que ocurrir antes de que la app empiece a atender solicitudes. Agregar un grupo desde dentro de un request handler no hace nada.
- **Un prefijo de grupo no es una restricción sobre toda la ruta.** `MapGroup("/api")` no impide que otras llamadas `MapGet("/api/...")` de nivel superior en otra parte coincidan. El grupo solo gobierna los endpoints que registres *a través* de él.
- **`RequireAuthorization()` sobre un grupo es aditivo, no sobrescribe.** Si un grupo interno o un endpoint también llaman a `RequireAuthorization` con una política distinta, ambas políticas se aplican (la solicitud debe satisfacer todas). No hay una semántica de "gana el interno".
- **`AddEndpointFilterFactory` se ejecuta una vez en tiempo de compilación, por endpoint, no por solicitud.** La fábrica inspecciona `MethodInfo` y devuelve el delegado real por solicitud. Poner lógica costosa por solicitud en el cuerpo de la fábrica (en lugar de en el delegado devuelto) significa que nunca se ejecuta en tiempo de solicitud. Este es el mismo patrón de fábrica que la documentación usa para poner un `DbContext` en modo de consulta privada para un grupo de endpoints.
- **Native AOT funciona bien con todo esto.** Los grupos, los módulos por método de extensión y los filtros son parte de la superficie de minimal API compatible con AOT; nada de esto fuerza un fallback a reflexión. Si publicas con trimming o AOT, consulta [usar Native AOT con minimal APIs de ASP.NET Core](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) para los detalles del generador de request delegates que hacen que los handlers agrupados se generen por fuente limpiamente.

El modelo mental con el que quedarte: un `RouteGroupBuilder` es solo un `IEndpointRouteBuilder` con un prefijo recordado y un conjunto recordado de convenciones. Cada truco organizativo, módulos, anidamiento, versionado, autenticación compartida, se deriva de ese único hecho. Empieza extrayendo un método de extensión `MapXxx` por recurso, colapsa `Program.cs` a una lista de llamadas, y recurre a grupos anidados solo cuando la jerarquía de URLs realmente se anida.

## Relacionado

- [Minimal APIs vs controllers en ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) si todavía estás eligiendo entre los dos modelos de endpoints.
- [Agregar un filtro global de excepciones en ASP.NET Core 11](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) para capturar excepciones en cada endpoint agrupado en un solo lugar.
- [Agregar rate limiting por endpoint en ASP.NET Core 11](/2026/04/how-to-add-per-endpoint-rate-limiting-in-aspnetcore-11/) para componer `RequireRateLimiting` con una política de grupo.
- [Agregar flujos de autenticación OpenAPI a Swagger UI en .NET 11](/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/) para asociar esquemas de seguridad a la etiqueta de un grupo.
- [Usar Native AOT con minimal APIs de ASP.NET Core](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) para publicar endpoints agrupados con trimming y AOT.

## Fuentes

- Microsoft Learn, [Route handlers in Minimal API apps](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/route-handlers?view=aspnetcore-10.0) (grupos de rutas, anidamiento, orden de filtros).
- Microsoft Learn, [Filters in Minimal API apps](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/min-api-filters?view=aspnetcore-10.0) (`AddEndpointFilter`, `AddEndpointFilterFactory`).
- Microsoft Learn, [Organizing ASP.NET Core Minimal APIs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/organizing-apis?view=aspnetcore-10.0).
- Referencia de la API, [EndpointRouteBuilderExtensions.MapGroup](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.builder.endpointroutebuilderextensions.mapgroup).
