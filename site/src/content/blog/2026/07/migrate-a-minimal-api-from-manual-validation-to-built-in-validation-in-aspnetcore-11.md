---
title: "Migrate a minimal API from manual validation checks to built-in validation in ASP.NET Core 11"
description: "A step-by-step migration guide for replacing hand-rolled if-checks in ASP.NET Core 11 minimal API handlers with the built-in source-generated DataAnnotations validator: what breaks, which manual rules do and do not port, and how to verify the 400 ProblemDetails contract stays identical."
pubDate: 2026-07-09
updatedDate: 2026-07-09
template: migration
tags:
  - "migration"
  - "aspnetcore"
  - "dotnet-11"
  - "minimal-apis"
  - "validation"
---

If your ASP.NET Core minimal API predates .NET 10, every handler probably opens with a block of `if (string.IsNullOrWhiteSpace(...)) return Results.BadRequest(...)` checks. This migration replaces those hand-rolled checks with the built-in validation that shipped in .NET 10 and is unchanged in .NET 11: call `builder.Services.AddValidation()`, move the rules onto your request records as `DataAnnotations` attributes, and delete the manual guards. For a typical service of 15 to 40 endpoints, expect half a day to a day of mechanical work. What breaks is not the framework, it is your assumptions: a handful of your manual rules were doing things attributes cannot express (async lookups, cross-service checks), and your error-response shape may shift if you were hand-building `BadRequest` payloads instead of returning `ProblemDetails`. The migration is worth it because it deletes code, makes validation declarative and reusable, and stays trim-safe under Native AOT. It is also reversible endpoint by endpoint, so you can do it incrementally. Everything below targets .NET 11 with `Microsoft.NET.Sdk.Web` and C# 14; the feature is identical on .NET 10, where it first shipped.

## Why move off manual checks

The manual pattern works, so the case for migrating is about maintenance and correctness, not "the old way is broken":

- **You delete code and the rules become declarative.** A `[Required, Length(3, 20)] string Sku` on the record replaces three lines of imperative checking in every handler that accepts a `Sku`. Write the constraint once, next to the data.
- **You stop returning inconsistent error shapes.** Hand-rolled `Results.BadRequest("Sku is required")` returns a bare string on one endpoint and a JSON object on another, depending on who wrote it. The built-in validator returns one `HttpValidationProblemDetails` (RFC 9457) body everywhere, keyed by property name.
- **Validation stays trim-safe.** The feature is a compile-time source generator, not runtime reflection, so it publishes clean under Native AOT and aggressive trimming, the same reason it ships with the [Native AOT minimal API stack](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/).
- **Query, route, and header parameters get validated too.** Manual checks almost always cover the JSON body and forget the paging parameters. The built-in filter validates scalar parameters bound from the route and query string with the same annotations.

## What breaks

The framework itself does not break, but these five things change, and you need to know which of your manual rules survive the port:

| Area                          | Change                                                                                          | Severity |
| ----------------------------- | ----------------------------------------------------------------------------------------------- | -------- |
| Error response body           | Bare-string or custom `BadRequest(...)` bodies become RFC 9457 `ProblemDetails` keyed by property | high     |
| Async / DB rules              | `if (await repo.SkuExists(...))` cannot become an attribute; needs a different home              | high     |
| Request type accessibility    | The record must be `public` or the generator emits nothing and validation silently does not run   | high     |
| Cross-field rules             | Multi-property `if` blocks move to `IValidatableObject`, not attributes                          | medium   |
| Tests asserting on error text | Tests that assert on your old custom message strings will fail against the new `ProblemDetails`    | medium   |
| Handler return type           | Handlers can drop their `BadRequest` union arm; the filter produces the 400 before the handler runs | low      |

The two high-severity rows that decide the shape of your migration are the error body and the async rules. If clients parse your current 400 body, plan for a contract change or a compatibility shim. If any manual check awaits I/O, that rule does not become an attribute at all, and pretending otherwise is the most common way this migration goes wrong.

## Pre-flight checklist

Before you touch a handler:

- **SDK.** Install the .NET 10 or .NET 11 SDK. Confirm with `dotnet --version` (expect `11.0.x` or `10.0.x`).
- **Web SDK.** The project must use `Microsoft.NET.Sdk.Web`. The validation source generator is wired up by that SDK once you call `AddValidation()`.
- **Baseline the current contract.** Capture the exact 400 responses your endpoints return today (a few `curl` calls saved to files, or a snapshot test). You are about to change this shape and you want a before-picture.
- **Grep for the surface area.** Find every manual check so you can track progress: `grep -rn "return Results.BadRequest\|return TypedResults.BadRequest" src/`. That list is your migration backlog.
- **Inventory async checks.** Separately, `grep -rn "await" src/` inside your handlers and flag any that gate a `BadRequest`. Those are the rules that will not become attributes.
- **Have a test suite or a smoke script.** You want to run something after each endpoint to confirm valid requests still pass and invalid ones still 400.

## Migration steps

### 1. Turn on built-in validation

Register the services before you build the app. This is the only global wiring the migration needs.

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddValidation();   // registers the validation services and endpoint filter
var app = builder.Build();
```

With the current .NET 10 or 11 web SDK the source generator is active automatically once `AddValidation()` is present. If you copied a trimmed `.csproj` or your build predates GA, add the interceptor namespace explicitly:

```xml
<!-- only needed if the generator's interceptors are not picked up automatically -->
<PropertyGroup>
  <InterceptorsNamespaces>$(InterceptorsNamespaces);Microsoft.AspNetCore.Http.Validation.Generated</InterceptorsNamespaces>
</PropertyGroup>
```

**Verify:** the app still builds and starts. `dotnet build` reports zero errors. No behavior has changed yet because none of your types carry attributes.

### 2. Move field-level rules onto the request record

Take one endpoint. Read its manual checks and translate each attribute-expressible rule to a `DataAnnotations` attribute on the request type. Here is the before, a handler carrying its validation inline:

```csharp
// .NET 11, C# 14 -- BEFORE: manual checks
app.MapPost("/products", (CreateProduct product) =>
{
    if (string.IsNullOrWhiteSpace(product.Sku) || product.Sku.Length is < 3 or > 20)
        return Results.BadRequest("Sku must be 3 to 20 characters.");
    if (string.IsNullOrWhiteSpace(product.Name) || product.Name.Length < 2)
        return Results.BadRequest("Name is required and must be at least 2 characters.");
    if (product.Quantity is < 1 or > 10_000)
        return Results.BadRequest("Quantity must be between 1 and 10000.");

    return Results.Created($"/products/{product.Sku}", product);
});

public record CreateProduct(string Sku, string Name, int Quantity);
```

And the after: the rules move to the record as attributes, the handler loses its guard block, and the type is made `public` so the generator can see it.

```csharp
// .NET 11, C# 14 -- AFTER: declarative validation
using System.ComponentModel.DataAnnotations;

app.MapPost("/products", (CreateProduct product) =>
    TypedResults.Created($"/products/{product.Sku}", product));

public record CreateProduct(
    [Required, Length(3, 20)] string Sku,
    [Required, MinLength(2)] string Name,
    [Range(1, 10_000)] int Quantity);
```

Note the type became `public`. This is the single most common reason a migrated endpoint silently stops validating: the generator can only emit code for types it can name, so a `record` left at the default file-internal accessibility gets no validation and no error.

**Verify:** `curl -i -X POST .../products -d '{"sku":"x","name":"","quantity":0}'` returns `400` with a `ProblemDetails` body listing `Sku`, `Name`, and `Quantity`. A valid body still returns `201`.

### 3. Move cross-field rules to IValidatableObject

Attributes validate one member at a time. Any manual check that compared two fields ("end after start", "discount requires a reason") does not become an attribute. Implement `IValidatableObject` on the request record instead:

```csharp
// .NET 11, C# 14 -- cross-field rule ported from a manual if-block
using System.ComponentModel.DataAnnotations;

public record DateRange(
    [Required] DateOnly Start,
    [Required] DateOnly End) : IValidatableObject
{
    public IEnumerable<ValidationResult> Validate(ValidationContext context)
    {
        if (End <= Start)
        {
            yield return new ValidationResult(
                "End must be after Start.",
                [nameof(End)]);   // attaches the error to the End member
        }
    }
}
```

The member-name array you pass as the second argument controls which key the error lands under, so pass the field your UI should highlight. `Validate` runs after the attribute checks, so a `null` `Start` is already reported by `[Required]` before your cross-field logic runs.

**Verify:** post a range where `End <= Start` and confirm the error key is `End`, not an empty model-level key.

### 4. Rehome the async and cross-service checks

This is the step the migration backlog from your pre-flight `await` grep feeds into. A rule like "reject if the SKU already exists in the catalog" hits the database, and neither `DataAnnotations` nor `IValidatableObject` can await. You have two honest options:

Keep that specific check as an explicit call inside the handler, after the built-in validator has already guaranteed the shape is valid:

```csharp
// .NET 11, C# 14 -- async rule stays explicit, but shape is pre-validated
app.MapPost("/products", async (CreateProduct product, IProductRepository repo, CancellationToken ct) =>
{
    // Built-in validation already ran: Sku is non-null, 3-20 chars, Quantity in range.
    if (await repo.SkuExistsAsync(product.Sku, ct))
        return Results.Conflict($"A product with SKU {product.Sku} already exists.");

    await repo.AddAsync(product, ct);
    return TypedResults.Created($"/products/{product.Sku}", product);
});
```

Or, if you have many async rules, keep FluentValidation for exactly those request types and let the built-in feature own the simple ones. The trade-offs are laid out in [minimal API validation vs FluentValidation](/2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11/); the short version is that async and rich conditional logic are the two reasons to keep a validation library. Do not try to force a `DbContext` call into an `IValidatableObject`; it is synchronous and will either block a thread or push you into `.Result` deadlock territory.

**Verify:** the uniqueness check still rejects a duplicate SKU (now as a `409`, or whatever status you choose), and a first-time SKU still succeeds.

### 5. Reuse a rule with a custom ValidationAttribute

If the same manual check appeared in three handlers ("this date cannot be in the past"), do not copy an `IValidatableObject` into three records. Write one `ValidationAttribute` and the generator picks it up like any built-in:

```csharp
// .NET 11, C# 14
using System.ComponentModel.DataAnnotations;

public sealed class NotInPastAttribute : ValidationAttribute
{
    protected override ValidationResult? IsValid(object? value, ValidationContext context)
    {
        if (value is DateOnly date && date < DateOnly.FromDateTime(DateTime.UtcNow.Date))
        {
            return new ValidationResult(
                ErrorMessage ?? "Date cannot be in the past.",
                [context.MemberName!]);
        }
        return ValidationResult.Success;
    }
}

public record Booking([Required, NotInPast] DateOnly When);
```

This is the attribute-based answer to duplicated `if` blocks: the rule lives once and applies wherever the type is used.

**Verify:** an endpoint that previously repeated the same date check now rejects a past date with the attribute, and the other endpoints that share the type inherit the rule.

### 6. Delete the dead guard code and simplify return types

Once an endpoint's rules are declarative, remove the manual `if` block entirely, and simplify the handler's declared return type. Because the 400 is produced by the endpoint filter before the handler body runs, a handler no longer needs a `BadRequest` arm in its `Results<...>` union:

```csharp
// .NET 11, C# 14 -- return type no longer needs BadRequest
app.MapPost("/products", (CreateProduct product)
    => TypedResults.Created($"/products/{product.Sku}", product))
   .Produces<CreateProduct>(StatusCodes.Status201Created)
   .ProducesValidationProblem();   // documents the 400 the filter produces
```

**Verify:** OpenAPI still advertises the `400` (via `ProducesValidationProblem`), and the endpoint compiles without the removed union arm.

## Verification

After migrating a batch of endpoints, run through this checklist before you call it done:

- **It builds.** `dotnet build` reports zero warnings and zero errors. Watch specifically for nothing, because a missing-`public` type fails silently, not loudly. That is what the next item catches.
- **Every migrated endpoint actually validates.** Re-run your invalid-request `curl` calls (or tests) against each migrated endpoint. An endpoint that returns `201` for a body you expect to be rejected means the generator did not see the type; check the access modifier first.
- **Valid requests still pass.** Confirm the happy path returns the same success status it did before.
- **The error contract is what clients expect.** Diff the new `ProblemDetails` body against your pre-flight baseline. If a client parses the `errors` dictionary, confirm the keys match the property names it expects.
- **The test suite is green.** `dotnet test` passes. Tests that asserted on your old custom error strings are expected to fail; update them to assert on the `ProblemDetails` shape rather than reverting the migration.
- **No perf regression at startup.** Because the feature is source-generated, startup should be flat or slightly faster (you removed code). If you kept FluentValidation for some types, its first-use expression compile still applies to those.

## Rollback plan

This migration is reversible and, better, it is incremental, so you rarely need a full rollback. Two levels:

- **Per endpoint, without reverting code.** If one migrated endpoint misbehaves in production, chain `DisableValidation()` on it to switch the filter off for that route while keeping the global registration and every other endpoint validated:

  ```csharp
  // .NET 11, C# 14 -- disable validation on a single endpoint
  app.MapPost("/internal/import", (CreateProduct product)
      => TypedResults.Accepted($"/products/{product.Sku}", product))
     .DisableValidation();
  ```

- **Full revert.** Because you migrated endpoint by endpoint, each endpoint's diff is self-contained: restore its manual `if` block and remove the attributes from the record if no other endpoint relies on them. Removing the global `AddValidation()` call turns the feature off entirely with no other code change. Nothing about this migration is one-way at the framework level.

## Gotchas we hit

Real issues that cost time, and their fixes:

- **The silent no-op from a non-`public` type.** By far the most frequent. You move the attributes onto a `record CreateProduct(...)`, the build succeeds, and validation never fires because the type is not `public`. There is no warning. If a migrated endpoint stops rejecting bad input, check the access modifier before anything else.
- **Positional record attribute targets.** On a positional record, `[Required] string Name` is read by the validation generator directly. You only need the explicit `[property: Required] string Name` target if some other tool reflects over the generated property at runtime. Mixing the two expectations is a common source of "why is this attribute ignored" confusion.
- **Nested objects validate recursively, which can surprise you.** If a request record references a `BillingAddress` record, the generator validates the address too, and the error keys use a dotted path like `Billing.PostalCode`. If your old manual code only checked the top-level object, you may now get 400s on nested fields you never validated before. That is usually correct, but it is a behavior change to expect.
- **Filter ordering.** Validation runs as a per-endpoint filter. If you already add your own `AddEndpointFilter` calls, know where validation sits in the chain, especially across route groups; the composition rules are the same ones in [organizing minimal API endpoints with MapGroup](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/).
- **Do not accidentally change the error contract silently.** If you want the migrated `ProblemDetails` to match a specific shape (a custom `type` URI, extra members), shape it centrally rather than per-endpoint; the mechanics are in [customizing minimal API validation error responses with IProblemDetailsService](/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/).

The mental model to leave with: this migration is not adopting a new framework, it is deleting imperative guard code and re-expressing the same rules declaratively on your request types. The attribute-expressible rules move to `DataAnnotations`, the cross-field ones to `IValidatableObject`, the reusable ones to a custom `ValidationAttribute`, and the async ones stay explicit in the handler after the shape is already guaranteed valid. Do it one endpoint at a time, verify each with the invalid-request call, and the `if`-block boilerplate that opened every handler simply goes away.

## Related

- [How to validate request bodies in minimal APIs without controllers in ASP.NET Core 11](/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/) for the full setup of the built-in feature you are migrating to.
- [Minimal API validation vs FluentValidation in ASP.NET Core 11](/2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11/) for deciding what to keep in a validation library versus move in-box.
- [How to customize minimal API validation error responses with IProblemDetailsService in ASP.NET Core 11](/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/) for shaping the 400 body after the migration.
- [Minimal APIs vs controllers in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) for the endpoint-model decision underneath this one.
- [How to organize minimal API endpoints with MapGroup in ASP.NET Core 11](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) for where the validation filter sits relative to group filters.

## Sources

- Microsoft Learn, [What's new in ASP.NET Core in .NET 10](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-10.0?view=aspnetcore-10.0) (built-in minimal API validation, `AddValidation`, source generator, `DisableValidation`, `ProblemDetails`).
- Microsoft Learn, [System.ComponentModel.DataAnnotations namespace](https://learn.microsoft.com/en-us/dotnet/api/system.componentmodel.dataannotations) (`ValidationAttribute`, `IValidatableObject`, `ValidationResult`).
- Tim Deschryver, [ASP.NET 10: Validating incoming models in Minimal APIs](https://timdeschryver.dev/blog/aspnet-10-validating-incoming-models-in-minimal-apis) (nested object validation, source-generator discovery, error shape).
