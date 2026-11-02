---
title: "Cómo organizar endpoints de Minimal APIs con MapGroup"
description: "Organiza Minimal APIs mediante módulos de recursos y MapGroup: rutas anidadas, metadatos, filtros, autenticación y pruebas."
pubDate: 2026-06-07
updatedDate: 2026-11-02
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

`MapGroup` reúne un prefijo de ruta y convenciones de endpoints. Existe desde ASP.NET Core 7. Una extensión por recurso permite sacar el registro de `Program.cs` sin introducir controladores.

**Corrección — 2 de noviembre de 2026:** la versión anterior describía erróneamente la unión de barras como concatenación literal y atribuía toda la API de `WebApplication` a los grupos. El ejemplo sustituto usa SDK 10.0.302; no representa una prueba en .NET 11.

## Un módulo completo

```csharp
// Program.cs in a Microsoft.NET.Sdk.Web project targeting net10.0.
using System.Collections.Concurrent;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Routing;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton<TodoStore>();
var app = builder.Build();

app.MapGroup("/api").MapTodos();
app.Run();

public static class TodoEndpoints
{
    public static RouteGroupBuilder MapTodos(this IEndpointRouteBuilder routes)
    {
        var group = routes.MapGroup("/todos/").WithTags("Todos");
        group.MapGet("/{id:int}", GetTodo).WithName("GetTodo");
        group.MapPut("/{id:int}", PutTodo);
        return group;
    }

    private static Results<Ok<Todo>, NotFound> GetTodo(int id, TodoStore store) =>
        store.Items.TryGetValue(id, out var todo)
            ? TypedResults.Ok(todo)
            : TypedResults.NotFound();

    private static NoContent PutTodo(int id, Todo todo, TodoStore store)
    {
        store.Items[id] = todo;
        return TypedResults.NoContent();
    }
}

public sealed class TodoStore
{
    public ConcurrentDictionary<int, Todo> Items { get; } = new(
        new[] { new KeyValuePair<int, Todo>(1, new Todo("Write docs", false)) });
}

public record Todo(string Title, bool IsComplete);
```

La aplicación expone `GET /api/todos/1` y `PUT /api/todos/{id}`. El almacenamiento en memoria es demostrativo y no sobrevive a reinicios. La composición de rutas de SDK 10 une `/todos/` y `/{id:int}` sin producir `/todos//{id:int}`. Mantén un formato uniforme, pero no diagnostiques el resultado como simple concatenación de strings.

La clase puede moverse a otro archivo del mismo proyecto. La ubicación del archivo no determina por sí sola la generación de delegados de petición. Los handlers privados no son accesibles directamente desde otro ensamblado de pruebas: prueba mediante HTTP o extrae la lógica a servicios comprobables.

## Qué ofrece el grupo

`RouteGroupBuilder` implementa `IEndpointRouteBuilder` e `IEndpointConventionBuilder`. Admite rutas anidadas y convenciones como `WithTags`, `RequireAuthorization` y filtros. No ofrece toda la API de `WebApplication`: el middleware `Use...` y la vida del host corresponden a la aplicación.

Las etiquetas explícitas organizan OpenAPI, pero no generan ni sirven un documento. Configura esas herramientas según tu versión. Los nombres de endpoints deben ser únicos en toda la aplicación.

Los prefijos anidados se combinan y los parámetros externos pueden enlazarse a handlers internos. Los filtros externos envuelven a los internos y a los del endpoint. El código anterior a `await next(context)` avanza hacia el handler; el posterior vuelve en orden inverso. El orden de registro dentro de un mismo grupo sigue importando.

## Configurar las políticas

`RequireAuthorization("policy")` añade metadatos, pero no crea la política, el handler de autenticación ni las credenciales. Configura servicios y middleware adecuados. Un prefijo `/v1` tampoco implementa por sí solo una política completa de versiones.

Para validar entradas, consulta [validación integrada frente a FluentValidation](/es/2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11/). Native AOT depende de handlers, serializadores y dependencias, no solo de las rutas; revisa [la guía de AOT](/es/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/).

## Fuentes

- [ASP.NET Core route handlers and route groups](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/route-handlers?view=aspnetcore-10.0#route-groups)
- [Endpoint filters](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/min-api-filters?view=aspnetcore-10.0)
- [RoutePatternFactory.Combine source, .NET 10](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Http/Routing/src/Patterns/RoutePatternFactory.cs)
- [Minimal API security](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/security?view=aspnetcore-10.0)
