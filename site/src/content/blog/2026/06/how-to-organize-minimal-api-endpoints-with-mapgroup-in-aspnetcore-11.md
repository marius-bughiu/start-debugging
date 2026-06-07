---
title: "How to organize minimal API endpoints with MapGroup in ASP.NET Core 11"
description: "A complete guide to structuring minimal APIs in ASP.NET Core 11 with MapGroup: per-resource endpoint modules as extension methods, nested groups, shared filters and auth, route-parameter prefixes, OpenAPI tags, and the filter-ordering rules that surprise people."
pubDate: 2026-06-07
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-apis"
---

To keep a minimal API from turning `Program.cs` into a thousand-line wall of `app.MapGet(...)` calls, group related endpoints with `app.MapGroup("/prefix")`, which returns a `RouteGroupBuilder` that shares a route prefix and any conventions (filters, auth, OpenAPI tags) you attach to it. The durable pattern is one extension method per resource: `public static IEndpointRouteBuilder MapTodos(this IEndpointRouteBuilder routes)` builds its own group internally, and `Program.cs` shrinks to a list of `app.MapTodos();` calls. `MapGroup` has been stable since ASP.NET Core 7 and is unchanged in .NET 11. Everything below targets .NET 11 with `Microsoft.NET.Sdk.Web` and C# 14, but the API is identical on .NET 8, 9, and 10.

## Why Program.cs rots

Minimal APIs ship with a seductive demo: the whole app in one file. That is great for a sample and terrible for a real service. By the time you have a handful of resources, each with the five CRUD verbs plus a couple of sub-routes, `Program.cs` is a few hundred lines of route handlers interleaved with DI registration, middleware wiring, and `app.Run()`. You scroll past authentication setup to find the `MapPut` you wanted to edit. Three handlers all start with `/api/v1/orders` and one of them has a typo in the prefix that nobody notices until a 404 in production.

The fix is not "go back to controllers". Controllers solve organization by convention (one class per resource, attributes for routing) at the cost of the reflection-based MVC pipeline. Minimal APIs solve it with `MapGroup` plus plain C# extension methods, and you keep the lean, AOT-friendly endpoint model. If you are still deciding between the two models, the trade-offs are laid out in [minimal APIs vs controllers in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/). This guide assumes you have picked minimal APIs and want them to scale.

## MapGroup returns a RouteGroupBuilder

`MapGroup` is an extension method on `IEndpointRouteBuilder`. It takes a route prefix and returns a `RouteGroupBuilder`:

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

Every `Map{Verb}` call on the group inherits the `/todos` prefix, so the patterns you write on the group are relative. `RouteGroupBuilder` implements `IEndpointRouteBuilder`, which is the detail that makes everything else work: anything you can call on `app` (including `MapGroup` itself), you can call on a group. That is how nesting falls out for free.

The prefix combines by simple concatenation. `app.MapGroup("/api").MapGroup("/v1").MapGet("/todos", ...)` registers `GET /api/v1/todos`. There is no normalization magic beyond joining the segments, so do not double up slashes: a group prefix of `/todos/` plus a handler pattern of `/{id}` yields `/todos//{id}`, which will not match what you expect.

## One extension method per resource

The pattern that scales is to give each resource its own static class with one `Map` method, and have that method create its own group. The return type should be `IEndpointRouteBuilder` (or `RouteGroupBuilder`) so calls chain:

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

Now `Program.cs` is a table of contents:

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

Two things make this idiom pleasant. First, the handlers are named `private static` methods instead of lambdas, so each one has a real name in stack traces and is trivially unit-testable in isolation. Second, returning `IEndpointRouteBuilder` from `MapTodos` lets you keep chaining if you want (`app.MapTodos().MapOrders();`), though one call per line reads better.

A note on the return type: if a method's whole job is to build a group and you want the *caller* to attach more conventions to that group, return `RouteGroupBuilder` instead. If the method registers endpoints and the caller should not touch the group afterward, return `IEndpointRouteBuilder`. Mixing the two is the most common source of "why doesn't my `.RequireAuthorization()` compile" confusion.

## Shared filters, auth, and metadata in one call

The payoff of a group is that a convention applied to the group applies to every endpoint under it. This is where `MapGroup` earns its keep over copy-pasting `.RequireAuthorization()` onto twenty handlers:

```csharp
// .NET 11, C# 14
var admin = app.MapGroup("/admin")
    .RequireAuthorization("AdminPolicy")   // every endpoint requires the policy
    .WithTags("Admin")                     // one OpenAPI tag for the whole group
    .AddEndpointFilter<AuditFilter>();     // runs for every endpoint in the group

admin.MapGet("/users", ListUsers);
admin.MapDelete("/users/{id:int}", DeleteUser);
```

`RequireAuthorization`, `WithTags`, `WithMetadata`, `RequireRateLimiting`, `AddEndpointFilter`, and `AddEndpointFilterFactory` are all `IEndpointConventionBuilder` methods, and `RouteGroupBuilder` implements that interface, so they all flow down to the members. If you need per-endpoint rate limiting partitioned by the route under a group, the [per-endpoint rate limiting guide](/2026/04/how-to-add-per-endpoint-rate-limiting-in-aspnetcore-11/) covers how `RequireRateLimiting` composes with a group's policy.

There is one subtlety worth internalizing: `AddEndpointFilter` on a group is **not** middleware. It does not run once per request to the prefix. It is applied to each endpoint's filter pipeline individually, at build time. The practical difference is that the filter only runs when an endpoint in the group actually matches. A request to `/admin/nonexistent` that 404s never invokes `AuditFilter`, whereas middleware on the `/admin` path segment would. If you want true middleware scoped to a path, use `app.UseWhen(ctx => ctx.Request.Path.StartsWithSegments("/admin"), ...)` instead.

## Nested groups and route parameters in the prefix

Because a group is itself an `IEndpointRouteBuilder`, you nest by calling `MapGroup` on a group. Prefixes can contain route parameters and constraints, and a handler at any depth can bind parameters declared in any ancestor prefix:

```csharp
// .NET 11, C# 14
var orgs = app.MapGroup("/orgs/{orgId:int}");
var projects = orgs.MapGroup("/projects/{projectId:int}");

projects.MapGet("/issues", (int orgId, int projectId) =>
    $"issues for org {orgId}, project {projectId}");
// matches GET /orgs/7/projects/3/issues
```

The handler binds both `orgId` and `projectId` even though each is declared one level up. This is the clean way to model hierarchical resources: each level of the URL is a group, and the leaf handlers stay short because the shared route values are captured by the structure rather than repeated in every pattern.

The prefix can also be empty. `app.MapGroup("")` adds no path segment, which is the trick for attaching a convention or filter to a band of endpoints without changing their URLs:

```csharp
// .NET 11, C# 14
var versioned = app.MapGroup("").WithOpenApi();
var v1 = versioned.MapGroup("/v1");
var v2 = versioned.MapGroup("/v2");
```

## The filter ordering rule that trips people up

When filters live on nested groups, the order they run in is determined by group nesting, **outer first**, not by the order you wrote the `AddEndpointFilter` calls. This is the single most counterintuitive behavior of route groups, and it is documented but easy to miss.

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

A request to `/outer/inner/` logs, in order:

```text
outer group filter
inner group filter
endpoint filter
```

The outer filter runs before the inner one even though it was added second, because filters apply from the outermost group inward, then the endpoint's own filters last. The relative order of `AddEndpointFilter` calls only matters when they are attached to the *same* builder. Across different groups, nesting wins. If you have an auth-style filter that must run before a logging filter, put auth on the outer group, not just earlier in the file.

## Versioning a minimal API with groups

A common reason to reach for nested groups is API versioning by URL segment. Each version is a group, and each resource module mounts itself under whichever version builder it is handed:

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

For anything beyond hand-rolled URL versioning (media-type or header versioning, deprecation headers, version sets), the `Asp.Versioning` package integrates with `MapGroup` through `HasApiVersion` on the group, but for the common "v1 and v2 path prefixes" case the plain nesting above is enough and ships zero extra dependencies.

## Grouping in the OpenAPI document

`WithTags` on a group is what produces the collapsible sections in Swagger UI or Scalar. Tag the group once and every endpoint lands under that tag:

```csharp
// .NET 11, C# 14
var todos = app.MapGroup("/todos").WithTags("Todos");
```

Without a tag, the built-in OpenAPI generator falls back to using the first route segment as the tag, which usually works but is worth setting explicitly so a refactor of the prefix does not silently rename your API sections. If you also expose authentication flows in the spec, the group is the right place to attach the security requirement so it shows on every operation, see [adding OpenAPI authentication flows to Swagger UI in .NET 11](/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/) for the `WithOpenApi` and security-scheme wiring.

## Gotchas worth knowing before you refactor

A few sharp edges that are easy to hit when you first restructure a flat file into groups:

- **`MapGroup` must be called on a builder, not after `app.Run()`.** Like all endpoint registration, it has to happen before the app starts handling requests. Adding a group from inside a request handler does nothing.
- **A group prefix is not a constraint on the whole path.** `MapGroup("/api")` does not stop other top-level `MapGet("/api/...")` calls elsewhere from matching. The group only governs the endpoints you register *through* it.
- **`RequireAuthorization()` on a group is additive, not overriding.** If an inner group or endpoint also calls `RequireAuthorization` with a different policy, both policies apply (the request must satisfy all of them). There is no "the inner one wins" semantics.
- **`AddEndpointFilterFactory` runs once at build time, per endpoint, not per request.** The factory inspects `MethodInfo` and returns the actual per-request delegate. Putting expensive per-request logic in the factory body (rather than in the returned delegate) means it never runs at request time. This is the same factory pattern the docs use to flip a `DbContext` into a private-query mode for one group of endpoints.
- **Native AOT is fine with all of this.** Groups, extension-method modules, and filters are all part of the AOT-friendly minimal API surface; nothing here forces a reflection fallback. If you are publishing trimmed or AOT, see [using Native AOT with ASP.NET Core minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) for the request-delegate-generator details that make the grouped handlers source-generate cleanly.

The mental model to leave with: a `RouteGroupBuilder` is just an `IEndpointRouteBuilder` with a remembered prefix and a remembered set of conventions. Every organizational trick, modules, nesting, versioning, shared auth, follows from that one fact. Start by extracting one `MapXxx` extension method per resource, collapse `Program.cs` to a list of calls, and reach for nested groups only when the URL hierarchy genuinely nests.

## Related

- [Minimal APIs vs controllers in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) if you are still choosing between the two endpoint models.
- [Add a global exception filter in ASP.NET Core 11](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) for catching exceptions across every grouped endpoint in one place.
- [Add per-endpoint rate limiting in ASP.NET Core 11](/2026/04/how-to-add-per-endpoint-rate-limiting-in-aspnetcore-11/) for composing `RequireRateLimiting` with a group policy.
- [Add OpenAPI authentication flows to Swagger UI in .NET 11](/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/) for attaching security schemes to a group's tag.
- [Use Native AOT with ASP.NET Core minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) for publishing grouped endpoints trimmed and AOT.

## Sources

- Microsoft Learn, [Route handlers in Minimal API apps](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/route-handlers?view=aspnetcore-10.0) (route groups, nesting, filter ordering).
- Microsoft Learn, [Filters in Minimal API apps](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/min-api-filters?view=aspnetcore-10.0) (`AddEndpointFilter`, `AddEndpointFilterFactory`).
- Microsoft Learn, [Organizing ASP.NET Core Minimal APIs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/organizing-apis?view=aspnetcore-10.0).
- API reference, [EndpointRouteBuilderExtensions.MapGroup](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.builder.endpointroutebuilderextensions.mapgroup).
