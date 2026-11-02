---
title: "How to organize Minimal API endpoints with MapGroup"
description: "Organize Minimal APIs into resource extension methods with MapGroup. Understand nested routes, shared metadata, filters, authentication and testing."
pubDate: 2026-06-07
updatedDate: 2026-11-02
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-apis"
---

`MapGroup` creates a shared route prefix and a place to attach endpoint conventions. It has been available since ASP.NET Core 7. A resource extension method can keep route registration out of `Program.cs` without introducing controllers.

**Correction — November 2, 2026:** the earlier guide incorrectly described slash joining as literal concatenation and treated every `WebApplication` API as available on a group. The replacement sample uses SDK 10.0.302; it is not presented as a .NET 11 runtime test.

## A complete resource module

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

The application exposes `GET /api/todos/1` and `PUT /api/todos/{id}`. The in-memory store is for this demonstration; it does not persist across process restarts. SDK 10 route-pattern composition joins the trailing slash in `/todos/` with the leading slash in `/{id:int}` without producing `/todos//{id:int}`. Use consistent route formatting, but do not diagnose a duplicate separator based on string concatenation alone.

The endpoint class can be moved to another file in the same project. File placement itself does not determine whether request-delegate generation runs. These private handlers are not directly callable from a separate test assembly; test them through HTTP, or move business behavior into independently testable services.

## What a group provides

`RouteGroupBuilder` implements `IEndpointRouteBuilder` and `IEndpointConventionBuilder`. It supports nested route registration and conventions such as `WithTags`, `RequireAuthorization` and endpoint filters. It does not expose the entire `WebApplication` API: application middleware such as `Use...` and host lifetime belong on the application.

Explicit tags make OpenAPI grouping intentional; tags alone do not generate or serve an OpenAPI document. Register the document tooling appropriate to your framework version separately. Endpoint names must remain unique across the application.

Nested group prefixes compose, and route parameters declared by an outer group can bind to an inner handler. Outer-group filters wrap inner-group and endpoint filters. Code before `await next(context)` runs toward the handler; code after it runs in reverse on the way out. Registration order within one group still matters.

## Add policies deliberately

`RequireAuthorization("policy")` adds endpoint metadata. It does not create the named policy, register an authentication handler or configure credentials. Configure authentication and authorization services and the relevant middleware for your application. Groups also do not implement a complete API-versioning policy merely by including `/v1` in the path.

For request checks, see [built-in validation versus FluentValidation](/2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11/). Native AOT depends on handlers, serializers and dependencies as well as route organization; consult [the AOT setup guide](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) before claiming a grouped application supports it.

## Sources

- [ASP.NET Core route handlers and route groups](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/route-handlers?view=aspnetcore-10.0#route-groups)
- [Endpoint filters](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/min-api-filters?view=aspnetcore-10.0)
- [RoutePatternFactory.Combine source, .NET 10](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Http/Routing/src/Patterns/RoutePatternFactory.cs)
- [Minimal API security](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/security?view=aspnetcore-10.0)
