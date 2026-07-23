---
title: "Typed results (Results<>) vs IResult vs IActionResult in ASP.NET Core 11"
description: "In ASP.NET Core 11, return Results<T1, TN> with TypedResults for minimal APIs and ActionResult<T> for controllers. Treat bare IResult and bare IActionResult as escape hatches: they compile for any response but describe nothing to OpenAPI, so you pay for them in hand-written ProducesResponseType attributes."
pubDate: 2026-07-23
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-apis"
---

If your endpoint has one possible response, declare that one concrete type and move on. If it has several, the sharp answer in ASP.NET Core 11 is: return `Results<TResult1, TResultN>` with `TypedResults` from a minimal API, and `ActionResult<T>` from a controller. Both give you compile-time checking that the handler only returns what it declares, and both hand the OpenAPI generator the response metadata for free. The two interface types, bare `IResult` and bare `IActionResult`, are escape hatches: they compile no matter what you return, which is exactly why they describe nothing to the framework and force you to hand-write `[ProducesResponseType]` or `.Produces` to get an accurate spec. Everything below targets .NET 11 with `Microsoft.NET.Sdk.Web` and C# 14; the `HttpResults` types have behaved the same way since .NET 7, so the same code runs on .NET 10 GA unchanged.

The three contenders in the queue title map to two different worlds. `IActionResult` is the MVC controller world. `IResult` and its typed union `Results<>` are the minimal API world built on the `Microsoft.AspNetCore.Http.HttpResults` namespace. The wrinkle that makes this comparison worth writing is that as of .NET 7 the `HttpResults` types work in controllers too, so on a controller action you now have a genuine choice between the MVC result types and the minimal API ones. Picking well means understanding what each type does and does not carry.

## The feature matrix

| Feature | `IActionResult` | `ActionResult<T>` | `IResult` (bare) | `Results<T1, TN>` |
| --- | --- | --- | --- | --- |
| Primary home | Controllers | Controllers | Minimal APIs + controllers | Minimal APIs + controllers |
| Self-describes to OpenAPI | No | Partial (infers `T`) | No | Yes |
| Needs `[ProducesResponseType]` / `.Produces` | Yes, liberally | For non-`T` status codes | Yes | No |
| Compile-time return checking | No | No | No | Yes |
| Content negotiation / formatters | Yes | Yes | No | No |
| Implicit cast from the payload type | No (interface) | Yes (`T` to `ActionResult<T>`) | No | Yes (each union arg) |
| Directly unit-testable result | Cast required | Cast required | Cast required | Concrete `.Result` |

Read the matrix top to bottom and the pattern is clear. The two interface rows are "No" on every metadata and safety column. The two typed rows earn their verbosity by turning "No" into "Yes". The one column where the interfaces and `ActionResult<T>` beat the `HttpResults` types is content negotiation, and that single row is the gotcha that occasionally picks for you. More on it below.

## When to pick Results<> (and TypedResults)

Reach for the union whenever a **minimal API** endpoint can answer with more than one shape.

- **A minimal API endpoint with a `200` and a `404`, in .NET 11.** Declare `Results<Ok<Todo>, NotFound>`, return `TypedResults.Ok(todo)` and `TypedResults.NotFound()`, and delete every `.Produces` call. The union carries the metadata now.
- **Any endpoint where the spec must stay honest.** Because the return type *is* the contract, adding a `400` branch without adding `BadRequest` to the union is a compile error, not a silently stale Swagger page.
- **Controllers where you want the same self-describing behavior.** The `HttpResults` types are legal on a controller action. `public Results<NotFound, Ok<Product>> GetById(int id)` compiles and drops all your `[ProducesResponseType]` attributes, exactly as it would in a minimal API.

Here is the canonical minimal API shape:

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

No `.Produces`, and the generated OpenAPI document lists a `200` with a `Todo` schema and a `404` with no body, both derived from the return type. The step-by-step conversion, the six-type ceiling, and the testing payoff are covered in depth in [how to return a typed Results union from a minimal API endpoint](/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/); this post is about when to choose it over the alternatives, not how to wire it.

## When to pick ActionResult<T>

Reach for `ActionResult<T>` when you are writing a **controller** action with a primary success payload and one or more error branches.

- **A controller `GET` that returns a `Product` or a `404`.** `ActionResult<Product>` lets you `return product;` directly (an implicit cast wraps it in an `ObjectResult`) and `return NotFound();` on the miss.
- **You want the success type inferred into the spec without repeating it.** With `ActionResult<T>`, `[ProducesResponseType(200)]` no longer needs `Type = typeof(Product)`; the framework reads `T`. The docs put it plainly: "The action's expected return type is inferred from the `T` in `ActionResult<T>`."
- **You need content negotiation.** MVC result types flow through the configured formatters, so a client sending `Accept: application/xml` gets XML if you have the formatter registered. The `HttpResults` types do not do this at all.

```csharp
// .NET 11, C# 14 -- ProductsController.cs
[HttpGet("{id}")]
[ProducesResponseType(StatusCodes.Status200OK)]
[ProducesResponseType(StatusCodes.Status404NotFound)]
public ActionResult<Product> GetById(int id)
{
    var product = _db.Products.Find(id);
    return product is null ? NotFound() : product;   // implicit cast T -> ActionResult<T>
}
```

The reason `ActionResult<T>` exists and `IActionResult` cannot replace it is a C# rule, not a framework decision: C# does not allow implicit cast operators on interfaces. `ActionResult<T>` is a concrete generic type, so it can define the implicit conversion from `T` that lets you write `return product;`. `IActionResult` is an interface, so it never can. That is the whole ergonomic gap between the two.

## When bare IActionResult or IResult is actually correct

Neither interface is wrong, they are just narrow. Use them deliberately, not by default.

- **`IActionResult` when the action genuinely returns unrelated result types** and you accept writing `[ProducesResponseType]` for each. It remains the honest choice for an action that might return a file, a redirect, and a JSON body from three branches, where there is no single `T`.
- **`IResult` when you have a single-shape minimal API branch** and do not want to spell out a one-arm union. Returning a bare `IResult` from a handler that only ever produces one status is fine; you just add `.Produces` if you care about the doc.
- **Sharing a handler between a minimal API and a controller.** The `HttpResults` types are the one result family that compiles in both hosting models, so a shared static method returning `IResult` or a `Results<>` union is the way to write it once. That portability is the documented reason the types exist outside minimal APIs.

The bare `IResult` version in a controller looks like this, and note the attributes are back:

```csharp
// .NET 11, C# 14 -- ProductsController.cs
[HttpGet("{id}")]
[ProducesResponseType<Product>(StatusCodes.Status200OK)]
[ProducesResponseType(StatusCodes.Status404NotFound)]
public IResult GetById(int id)
{
    var product = _db.Products.Find(id);
    return product is null ? Results.NotFound() : Results.Ok(product);
}
```

Every `Results.*` helper returns `IResult`, so the compiler infers `IResult` for both branches and never complains, and the ApiExplorer sees an interface that says nothing about status codes. That is why the two `[ProducesResponseType]` lines are mandatory here and absent from the `Results<>` version: the metadata has nowhere else to come from.

## The gotcha that picks for you: content negotiation

If your API must honor `Accept` headers and return XML, CSV, or any format other than the one the result hard-codes, the `HttpResults` family is out, and that decision overrides everything above. The docs are explicit that the `HttpResults` types do "***not*** leverage the configured Formatters," and spell out the consequence: "Some features like `Content negotiation` aren't available" and "The produced `Content-Type` is decided by the `HttpResults` implementation." `TypedResults.Ok(product)` will serialize JSON regardless of what the client asked for. So an internal JSON-only API is free to use `Results<>` in a controller and enjoy the self-describing metadata, but a public API with an XML formatter registered has to stay on `ActionResult<T>` / `IActionResult` for the endpoints that negotiate. This is a capability wall, not a preference, which is why it belongs at the top of your decision and not the bottom.

The second forcing function is your hosting model. If the endpoint lives in a minimal API, `IActionResult` and `ActionResult<T>` are not even available to you; they are MVC types that depend on the controller pipeline. The choice there is only ever between `IResult` and `Results<>`, and `Results<>` wins for any multi-response endpoint. The full trade-off between the two hosting models is laid out in [minimal APIs vs controllers in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/).

## Why the typed versions do not compile by accident

There is one piece of friction people hit with `Results<>` and it is worth naming so it does not read as a bug. Type inference will not build the union for you. This does not compile:

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

`TypedResults.NotFound()` and `TypedResults.Ok(todo)` are different concrete types, so the compiler cannot find a common type for the ternary and the lambda has no inferable return type. The bare `IResult` version compiled only because every `Results.*` helper is already `IResult`, giving the branches an obvious shared type. With `TypedResults` you pay for the richer metadata by declaring the return type yourself: `Results<Ok<Todo>, NotFound>` for a sync handler or `Task<Results<Ok<Todo>, NotFound>>` for an async one. That declaration is not boilerplate you can shorten. It is the exact string the framework reads to build the spec, which is the entire point.

The same logic explains why `ActionResult<IEnumerable<Product>>` works but `ActionResult<T>` cannot wrap an interface you return directly: the implicit cast is defined from `T`, and C# forbids implicit casts on interfaces, so returning an `IEnumerable` instance needs an explicit `Ok(...)` wrapper. Small rule, occasionally surprising.

## The recommendation, restated with the full picture

- **New minimal API, multiple responses: `Results<T1, TN>` with `TypedResults`.** Compile-time checking plus a self-describing OpenAPI spec, no `.Produces`. This is the default and it should be your reflex.
- **New minimal API, single response: the one concrete type**, for example `Task<Ok<Todo[]>>`. Skip the union when there is nothing to disambiguate.
- **Controller, JSON-only, want the metadata for free: `Results<T1, TN>` in the controller** works and drops your attributes. Otherwise **`ActionResult<T>`** for the classic controller ergonomics.
- **Any endpoint that must negotiate content (XML, CSV, custom media types): `ActionResult<T>` or `IActionResult`.** The `HttpResults` types cannot do content negotiation, full stop.
- **Bare `IResult` / bare `IActionResult`: escape hatches only.** Reach for them for genuinely heterogeneous responses, single-shape branches you do not want to type out, or code shared across hosting models, and accept the hand-written metadata that comes with them.

The mental model to keep: an interface return type accepts anything and documents nothing, so the framework makes you re-state the contract in attributes. A typed return type, `Results<>` or `ActionResult<T>`, *is* the contract, so the compiler enforces it and the OpenAPI generator reads it. Pick the typed one unless a concrete capability, almost always content negotiation, forces the interface. For the branches that return a validation failure, feeding a `ProblemHttpResult` into the union keeps the shape consistent with the built-in pipeline described in [how to customize minimal API validation error responses with IProblemDetailsService](/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/).

## Related

- [How to return a typed Results union from a minimal API endpoint in ASP.NET Core 11](/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/) for the step-by-step conversion, the six-type ceiling, and testing.
- [Minimal APIs vs controllers in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) for the hosting-model choice that constrains which return types you even have.
- [How to expose OpenAPI without Swashbuckle in ASP.NET Core 11](/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/) for the built-in generator that reads this metadata.
- [How to customize minimal API validation error responses with IProblemDetailsService in ASP.NET Core 11](/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/) for the `ProblemHttpResult` that often joins the union.
- [How to validate request bodies in minimal APIs without controllers in ASP.NET Core 11](/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/) for where `ValidationProblem` fits in the response set.

## Sources

- Microsoft Learn, [Controller action return types in ASP.NET Core web API](https://learn.microsoft.com/en-us/aspnet/core/web-api/action-return-types?view=aspnetcore-11.0) (`IActionResult`, `ActionResult<T>` and its implicit-cast benefits, the interface implicit-cast limitation, and the `HttpResults` types in controllers including the content-negotiation caveat).
- Microsoft Learn, [Create responses in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/responses?view=aspnetcore-11.0) (`TypedResults` vs `Results`, the `Results<TResult1, TResultN>` union, implicit cast operators, compile-time checking, and self-describing metadata).
- Microsoft Learn, [Microsoft.AspNetCore.Http.HttpResults namespace](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.httpresults) (`Ok<T>`, `NotFound`, `BadRequest`, and the `Results<>` overloads).
- dotnet/aspnetcore, [Introduce way for route handler delegates to return union results (issue #40672)](https://github.com/dotnet/aspnetcore/issues/40672) (the original design of the `Results<>` union).
