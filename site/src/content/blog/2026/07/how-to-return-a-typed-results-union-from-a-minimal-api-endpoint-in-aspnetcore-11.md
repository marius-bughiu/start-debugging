---
title: "How to return a typed Results<T1, T2> union from a minimal API endpoint in ASP.NET Core 11"
description: "Declare the handler's return type as Results<Ok<T>, NotFound> and return TypedResults.Ok / TypedResults.NotFound: the union gives compile-time checking that the handler only returns what it declares, and it self-describes to OpenAPI so you never write .Produces by hand. Covers async handlers, the six-type limit, and testing in ASP.NET Core 11."
pubDate: 2026-07-14
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-apis"
  - "openapi"
---

When a minimal API endpoint can answer with more than one shape, say a `200 OK` with the entity or a `404 Not Found` when it is missing, the tempting move is to declare the handler as returning `IResult` and call `Results.Ok(...)` or `Results.NotFound()`. That compiles, but it throws away the two things `IResult` cannot carry: the compiler no longer checks that you return only the results you meant to, and OpenAPI has no idea a `404` is even possible unless you hand-write `.Produces(404)` on the endpoint. The fix is the `Results<TResult1, TResult2, ...>` union type from `Microsoft.AspNetCore.Http.HttpResults`. Declare the handler as `Results<Ok<Todo>, NotFound>`, return the concrete `TypedResults.Ok(todo)` and `TypedResults.NotFound()` values, and the union self-describes to OpenAPI while the compiler rejects any branch that returns something you did not list. Everything below targets .NET 11 with `Microsoft.NET.Sdk.Web` and C# 14; the union has behaved identically since .NET 7, so the same code runs unchanged on .NET 10 GA.

## Why IResult loses your OpenAPI metadata

Start with the version most people write first. The handler returns `IResult` because that is the only type that fits both branches:

```csharp
// .NET 11, C# 14 -- Program.cs
app.MapGet("/todos/{id}", async (int id, TodoDb db) =>
{
    var todo = await db.Todos.FindAsync(id);
    return todo is null
        ? Results.NotFound()
        : Results.Ok(todo);
});
```

This works at runtime, and it is the reason `Results` exists: every helper on the `Results` static class returns `IResult`, so the compiler happily infers `IResult` as the delegate's return type even when the branches produce a `200` and a `404`. The cost shows up in your OpenAPI document. The framework inspects the declared return type to build the response section of the spec, and all it sees is `IResult`, an interface that says nothing about status codes or payloads. Swagger UI shows a single undocumented `200` and no `404` at all. To get an accurate spec you have to annotate the endpoint by hand:

```csharp
// .NET 11, C# 14 -- the manual annotation IResult forces on you
app.MapGet("/todos/{id}", async (int id, TodoDb db) =>
{
    var todo = await db.Todos.FindAsync(id);
    return todo is null ? Results.NotFound() : Results.Ok(todo);
})
.Produces<Todo>(StatusCodes.Status200OK)
.Produces(StatusCodes.Status404NotFound);
```

Those `.Produces` calls are pure duplication. They restate what the handler body already decides, and nothing keeps them in sync. Add a `400` branch six months later and the spec still claims the endpoint only returns `200` or `404`, because the metadata lives in a different place from the code that produces it. That drift is exactly what the typed union removes.

## Declare the union and return TypedResults

The `TypedResults` static class is the typed twin of `Results`. Where `Results.Ok(x)` returns `IResult`, `TypedResults.Ok(x)` returns the concrete `Ok<T>` from the `Microsoft.AspNetCore.Http.HttpResults` namespace, and `TypedResults.NotFound()` returns a `NotFound`. Each of those concrete types implements `IEndpointMetadataProvider`, so each one knows how to describe itself to OpenAPI. The `Results<TResult1, TResult2>` type ties them together into a single declared return type. Converting the endpoint above is three steps:

1. **Declare the handler's return type as the union.** List every result the handler can produce, in any order: `Results<Ok<Todo>, NotFound>`. For an async handler, wrap it in `Task<>`: `async Task<Results<Ok<Todo>, NotFound>>`.
2. **Return `TypedResults` helpers, not `Results`.** Swap `Results.Ok` for `TypedResults.Ok` and `Results.NotFound` for `TypedResults.NotFound`. Each returns its concrete implementation type.
3. **Delete the `.Produces` calls.** The union carries the metadata now, so the manual annotations are redundant and should go, or they will rot.

Here is the endpoint after the conversion:

```csharp
// .NET 11, C# 14 -- Program.cs
using Microsoft.AspNetCore.Http.HttpResults;

app.MapGet("/todos/{id}", async Task<Results<Ok<Todo>, NotFound>> (int id, TodoDb db) =>
{
    var todo = await db.Todos.FindAsync(id);
    return todo is null
        ? TypedResults.NotFound()
        : TypedResults.Ok(todo);
});
```

No `.Produces`, and the OpenAPI document now lists a `200` with a `Todo` schema and a `404` with no body, generated straight from the return type. The official docs put the trade-off plainly: using `TypedResults` with the union is more verbose than returning `IResult`, "but that's the trade-off for having the type information be statically available and thus capable of self-describing to OpenAPI." If you are running the built-in OpenAPI document generator covered in [how to expose OpenAPI without Swashbuckle in ASP.NET Core 11](/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/), this metadata flows into the generated JSON with zero extra configuration.

## How the union actually compiles

The part that makes this ergonomic instead of painful is the implicit conversion. `Results<Ok<Todo>, NotFound>` defines an implicit cast operator from each of its generic arguments to the union itself. When your handler returns `TypedResults.Ok(todo)`, which is an `Ok<Todo>`, the compiler implicitly converts it to the union. You never construct a `Results<...>` yourself, and you never write a cast; you return the concrete result and the conversion is invisible. That is why the ternary in the example works: both branches produce a type the union can absorb, so the whole expression types as the union.

This is also where the compile-time safety comes from. Because the union only defines conversions from the types you listed, returning anything else is a compilation error, not a runtime surprise. Add a branch that returns `TypedResults.BadRequest()` without adding `BadRequest` to the union and the build fails:

```csharp
// .NET 11, C# 14 -- does NOT compile
app.MapGet("/orders/{id}", Results<Ok<Order>, NotFound> (int id) =>
{
    if (id < 0)
        return TypedResults.BadRequest();   // error: BadRequest is not in the union
    return id > 999 ? TypedResults.NotFound() : TypedResults.Ok(new Order(id));
});
```

The compiler tells you the declared results and the returned results disagree, so the endpoint's contract and its implementation can never silently drift apart. Fix it by adding the type you actually return:

```csharp
// .NET 11, C# 14 -- compiles, and OpenAPI now shows 200, 404, and 400
app.MapGet("/orders/{id}", Results<Ok<Order>, NotFound, BadRequest> (int id) =>
{
    if (id < 0)
        return TypedResults.BadRequest();
    return id > 999 ? TypedResults.NotFound() : TypedResults.Ok(new Order(id));
});
```

Note the synchronous handler here needs no `Task<>` wrapper, but it still must declare the full union return type explicitly. The compiler will not infer a "best common type" across `Ok<Order>`, `NotFound`, and `BadRequest` on its own, which is precisely why the endpoint that returned `IResult` compiled without complaint and this one requires you to spell out the union.

## Why the synchronous version needs the type declared

It is worth understanding the failure you will hit if you try to let type inference do the work. This does not compile:

```csharp
// .NET 11, C# 14 -- does NOT compile
app.MapGet("/todos/{id}", async (int id, TodoDb db) =>
{
    var todo = await db.Todos.FindAsync(id);
    return todo is null
        ? TypedResults.NotFound()   // NotFound
        : TypedResults.Ok(todo);    // Ok<Todo>
});
```

`TypedResults.Ok` and `TypedResults.NotFound` return different concrete types, and the compiler refuses to infer a shared type for the conditional expression, so the lambda has no inferable return type. The `Results` version of the same code compiled only because every `Results` helper is already typed as `IResult`, giving the ternary an obvious common type. With `TypedResults` you pay for the richer type information by declaring the return type yourself, either `Results<Ok<Todo>, NotFound>` for a sync handler or `Task<Results<Ok<Todo>, NotFound>>` for an async one. That declaration is not boilerplate you can skip; it is the thing the framework reads to build your OpenAPI spec.

## The testing payoff

Because the handler now returns a concrete type instead of `IResult`, unit tests can assert on the exact result without spinning up an HTTP server or casting. Extract the handler into a named static method so a test can call it directly:

```csharp
// .NET 11, C# 14 -- TodoEndpoints.cs
public static async Task<Results<Ok<Todo>, NotFound>> GetTodo(int id, TodoDb db)
{
    var todo = await db.Todos.FindAsync(id);
    return todo is null
        ? TypedResults.NotFound()
        : TypedResults.Ok(todo);
}
```

A test then checks the concrete type and reaches straight into its typed `Value`, no reflection over `IResult` and no HTTP round trip:

```csharp
// .NET 11, C# 14 -- xUnit
[Fact]
public async Task GetTodo_ReturnsOk_WhenFound()
{
    await using var db = new MockDb().CreateDbContext();
    db.Todos.Add(new Todo { Id = 1, Title = "Write the union post" });
    await db.SaveChangesAsync();

    var result = await TodoEndpoints.GetTodo(1, db);

    var ok = Assert.IsType<Ok<Todo>>(result.Result);
    Assert.Equal(1, ok.Value!.Id);
}
```

The union exposes the actual result through its `Result` property, and `Ok<Todo>` exposes the payload through a strongly typed `Value`. That is the "improve unit testing" advantage the docs list for `TypedResults`: with `Results` you would first have to convert the `IResult` back into a concrete type before you could assert anything about it. Here the type is already concrete, so the assertion is a one-liner. If your handler is small enough to inline in `MapGet`, extracting it into a static method purely to make it testable is a reasonable refactor; the [minimal APIs vs controllers in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) comparison walks through when that structure pays off.

## The six-type ceiling and how to stay under it

`Results<>` is defined with two through six generic parameters, so a single endpoint can declare at most six distinct result types. In practice that is plenty: an endpoint returning `Ok`, `Created`, `NotFound`, `BadRequest`, `Conflict`, and `ValidationProblem` is already at the limit and probably doing too much. Extending the ceiling has been requested (tracked as [dotnet/aspnetcore#61706](https://github.com/dotnet/aspnetcore/issues/61706)), but for now six is the wall.

If you genuinely hit it, you have two reasonable escapes. The first is to collapse related failures into one problem type: rather than listing `BadRequest`, `Conflict`, and `UnprocessableEntity` separately, return `ProblemHttpResult` via `TypedResults.Problem(...)` and encode the distinction in the RFC 9457 payload, which is the same shape the built-in validation covered in [how to customize minimal API validation error responses](/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/) already emits. The second is to fall back to `IResult` for that one endpoint and add the `.Produces` annotations by hand, accepting the manual metadata as the price of more than six branches. Do not reach for either until you have actually exceeded six; most endpoints live comfortably at two or three.

## Gotchas that trip people up

- **`Ok` and `Ok<T>` are different types.** `TypedResults.Ok()` with no argument returns `Ok` (a `200` with no body); `TypedResults.Ok(value)` returns `Ok<T>`. If your union lists `Ok<Todo>` but a branch calls the parameterless `TypedResults.Ok()`, it will not compile, because `Ok` is not `Ok<Todo>`. List the exact variant each branch produces.
- **The union return type must be spelled out in full.** There is no shorthand and no inference. `async Task<Results<Ok<Todo>, NotFound>>` is verbose, and that is intentional: the framework reads that exact declaration to build the spec, so abbreviating it is not an option.
- **A handler-returned `Problem` still bypasses `CustomizeProblemDetails`.** Putting `ProblemHttpResult` in the union documents the response, but a `ProblemDetails` you construct and return from the handler is serialized directly and does not pass through `IProblemDetailsService`. If you rely on a global `CustomizeProblemDetails` callback to stamp a `traceId`, it will not fire for these; that mechanic is spelled out in the [IProblemDetailsService customization post](/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/).
- **Order in the generic list does not matter, but it is your documentation.** `Results<Ok<Todo>, NotFound>` and `Results<NotFound, Ok<Todo>>` behave identically. Pick a consistent order (success first is the common convention) so a reader can scan an endpoint's contract at a glance.
- **You still add non-status metadata explicitly.** The union covers response types and status codes. Things like `.WithName`, `.WithTags`, `.RequireAuthorization`, or a custom `Produces` content type for a non-default media type are separate concerns and still go on the endpoint builder, exactly as they would with any other endpoint, including the JWT setup in [how to set up JWT bearer authentication in a minimal API](/2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11/).

The mental model to keep: `IResult` is the escape hatch that returns anything and documents nothing, while `Results<T1, TN>` is a declared contract the compiler enforces and OpenAPI reads. Reach for the union whenever an endpoint has more than one possible response, return the matching `TypedResults` helper from each branch, and let the type system keep your handler, your tests, and your spec in agreement. When an endpoint truly has a single response shape, skip the union and declare that one concrete type directly, for example `Task<Ok<Todo[]>>`; the union earns its verbosity only when there is more than one branch to document.

## Related

- [How to customize minimal API validation error responses with IProblemDetailsService in ASP.NET Core 11](/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/) for shaping the `ProblemHttpResult` you put in the union.
- [How to expose OpenAPI without Swashbuckle in ASP.NET Core 11](/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/) for the built-in generator that reads this metadata.
- [How to validate request bodies in minimal APIs without controllers in ASP.NET Core 11](/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/) for the `ValidationProblem` result that often joins the union.
- [How to organize minimal API endpoints with MapGroup in ASP.NET Core 11](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) for grouping typed endpoints and applying shared metadata.
- [Minimal APIs vs controllers in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) for how return-type conventions differ between the two models.

## Sources

- Microsoft Learn, [Create responses in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/responses?view=aspnetcore-11.0) (`TypedResults` vs `Results`, `Results<TResult1, TResultN>` union, implicit cast operators, compile-time checking, the async `Task<>` requirement, and the unit-testing example).
- Microsoft Learn, [Microsoft.AspNetCore.Http.HttpResults namespace](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.httpresults) (`Ok<T>`, `NotFound`, `BadRequest`, `Results<TResult1, TResult2>` through the six-parameter overload).
- dotnet/aspnetcore, [Introduce way for route handler delegates to return union results (issue #40672)](https://github.com/dotnet/aspnetcore/issues/40672) (the original design of the `Results<>` union).
- dotnet/aspnetcore, [Extend Results in TypedResults to support more than 6 types (issue #61706)](https://github.com/dotnet/aspnetcore/issues/61706) (the six-type ceiling and the request to raise it).
