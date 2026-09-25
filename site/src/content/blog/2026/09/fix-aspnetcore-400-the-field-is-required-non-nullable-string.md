---
title: "Fix: ASP.NET Core returns 400 \"The X field is required\" for a non-nullable string property"
description: "With <Nullable>enable</Nullable>, MVC treats every non-nullable reference type as [Required(AllowEmptyStrings = true)]. Mark optional properties as string?, give them a default, or set SuppressImplicitRequiredAttributeForNonNullableReferenceTypes."
pubDate: 2026-09-25
template: error-page
tags:
  - "errors"
  - "aspnetcore"
  - "dotnet-10"
  - "validation"
  - "nullable-reference-types"
---

A `400 Bad Request` with `"The Name field is required."` on a property you never marked `[Required]` comes from MVC's implicit required rule: when the project has `<Nullable>enable</Nullable>`, every non-nullable reference type on a bound model or action parameter is validated as if it had `[Required(AllowEmptyStrings = true)]`. If the value is genuinely optional, declare it as `string?`. If you want the old behaviour everywhere, set `options.SuppressImplicitRequiredAttributeForNonNullableReferenceTypes = true` in `AddControllers`. If it really is required, keep the error and customize it with an explicit `[Required]`.

Every result below was reproduced on ASP.NET Core 10.0.10 (SDK 10.0.302) with a single `dotnet new web` project hosting both controllers and minimal API endpoints. The rule itself has existed since ASP.NET Core 3.0, so the explanation applies to every version from 3.0 through .NET 11.

## The error in context

The client sends a JSON body that omits a property, or sends it as `null`, and gets back the standard `ValidationProblemDetails` body before your action runs:

```json
{
  "type": "https://tools.ietf.org/html/rfc9110#section-15.5.1",
  "title": "One or more validation errors occurred.",
  "status": 400,
  "errors": {
    "Name": ["The Name field is required."]
  },
  "traceId": "00-41532a7ee5071512e476fa1aa31447c3-141fcd7662d71a76-00"
}
```

The same message shows up for query string parameters (`"q": ["The q field is required."]`), form fields, and, very often, for EF Core navigation properties on entities that are bound directly (`"Customer": ["The Customer field is required."]`). Without `[ApiController]` you do not get the automatic 400, but `ModelState.IsValid` is `false` with the same error, which is how Razor Pages and MVC form posts meet it.

## Why this happens

MVC's `DataAnnotationsMetadataProvider` builds validation metadata for every bound property and parameter. For each one that is a reference type and has no explicit `[Required]`, it asks `NullabilityInfoContext` what the compiler recorded. If the read state is `NotNull`, it adds a `RequiredAttribute` to the validator list. The relevant comment in the ASP.NET Core source is blunt about it: "For non-nullable reference types, treat them as-if they had an implicit [Required]."

Four details of that code decide almost every case you will hit:

1. **The implicit attribute uses `AllowEmptyStrings = true`.** It only rejects `null`, not `""`. A JSON body with `"name": ""` passes validation.
2. **Form and query values still reject empty strings,** because MVC's model binding converts empty and whitespace-only input to `null` (`ConvertEmptyStringToNull` defaults to `true`) before validation runs. `?q=` and `?q=%20` both fail with "The q field is required."
3. **Parameters with a default value are exempt.** `string sort = "name"` is never implicitly required, because the provider skips parameters where `HasDefaultValue` is true.
4. **Oblivious code is exempt.** If the type was compiled with nullable annotations disabled, the read state is `Unknown`, not `NotNull`, so nothing is added. This is why the error tends to appear the day someone flips `<Nullable>enable</Nullable>` on an older project, without a single model changing.

Only MVC does this. Controllers, Razor Pages, and MVC views all go through `DataAnnotationsMetadataProvider`. Minimal APIs do not, including the new source-generated validation from `AddValidation()` in .NET 10, which is covered in the gotchas below.

## Minimal repro

```csharp
// ASP.NET Core 10.0.10, <Nullable>enable</Nullable>, Program.cs
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddControllers();
var app = builder.Build();
app.MapControllers();
app.Run();

public record CreateProduct(string Name, string? Nickname, string Sku = "");

public class Order
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public int CustomerId { get; set; }
    public Customer Customer { get; set; } = null!; // EF Core navigation
}

public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
}

[ApiController, Route("api")]
public class ProductsController : ControllerBase
{
    [HttpPost("create")] public IActionResult Create(CreateProduct p) => Ok(p);
    [HttpPost("order")]  public IActionResult Order(Order o) => Ok(o);
    [HttpGet("search")]  public IActionResult Search(string q) => Ok(q);
}
```

What each request returned:

| Request | Status | Error key |
| --- | --- | --- |
| `POST /api/create` with `{}` | 400 | `Name` |
| `POST /api/create` with `{"name":null}` | 400 | `Name` |
| `POST /api/create` with `{"name":""}` | 200 | none |
| `POST /api/create` with `{"name":"x"}` | 200 | none |
| `POST /api/order` with `{"title":"t","customerId":1}` | 400 | `Customer` |
| `GET /api/search` | 400 | `q` |
| `GET /api/search?q=` | 400 | `q` |

`Nickname` (declared `string?`) and `Sku` (a parameter with a default value) never produced an error. `Title` did not either, because the initializer `= ""` means JSON deserialization leaves it at `""` when the property is missing, and `""` satisfies `AllowEmptyStrings = true`.

The `Order` row is the one that confuses people most. `Customer` is non-nullable because EF Core wants it that way for a required relationship, `= null!` silences [CS8618](/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/), and then MVC reads the same annotation and demands that the client send a whole `Customer` object in the body.

## Fix 1: declare the optional values as nullable (recommended)

If a value can legitimately be absent, the type should say so. That fixes validation and gives you the compiler's null checks inside the action:

```csharp
// ASP.NET Core 10.0.10
public record CreateProduct(string Name, string? Nickname, string? Description);

[HttpGet("search")]
public IActionResult Search(string? q) => Ok(q ?? "(all)");
```

For query and route parameters that have a sensible fallback, a default value works too and reads better than a null check:

```csharp
// ASP.NET Core 10.0.10
[HttpGet("list")]
public IActionResult List(string sort = "name", int page = 1) => Ok(new { sort, page });
```

For EF Core entities, the right fix is to stop binding the entity. Accept a request DTO that carries `CustomerId` and nothing else, then map it:

```csharp
// ASP.NET Core 10.0.10, EF Core 10
public record CreateOrder(string Title, int CustomerId);

[HttpPost("order")]
public async Task<IActionResult> Order(CreateOrder dto, AppDbContext db)
{
    var order = new Order { Title = dto.Title, CustomerId = dto.CustomerId };
    db.Orders.Add(order);
    await db.SaveChangesAsync();
    return CreatedAtAction(nameof(Order), new { id = order.Id }, new { order.Id });
}
```

If you cannot change the entity binding right now, `[ValidateNever]` on the navigation property (from `Microsoft.AspNetCore.Mvc.ModelBinding.Validation`) tells MVC to skip validating it:

```csharp
// ASP.NET Core 10.0.10
[ValidateNever]
public Customer Customer { get; set; } = null!;
```

With it, `{"title":"t"}` bound fine and `Customer` stayed `null`. That is a patch, not a design. It still lets a client post a nested `customer` object that EF Core will happily try to insert.

## Fix 2: turn the implicit rule off globally

When you are enabling nullable reference types on a large existing API and cannot audit every model at once, suppress the inference in `AddControllers` (or `AddMvc`, `AddRazorPages().AddMvcOptions(...)`):

```csharp
// ASP.NET Core 10.0.10, Program.cs
builder.Services.AddControllers(options =>
{
    options.SuppressImplicitRequiredAttributeForNonNullableReferenceTypes = true;
});
```

With that option set, every row in the table above returned 200 except the empty query, which returned `204 No Content` because the action received `null` and `Ok(null)` becomes a 204. Note what that means: the action ran with `q == null` even though the signature says `string q`. You traded a 400 for a value the compiler swears cannot be null. Treat this as a migration switch, and plan to remove it once the models are annotated honestly.

## Fix 3: keep the rule, own the message

If the property really is required, the implicit validation is doing its job, and the only complaint is the wording. An explicit attribute replaces the implicit one (the provider only adds its own when no `[Required]` is present):

```csharp
// ASP.NET Core 10.0.10
using System.ComponentModel.DataAnnotations;

public class CreateCustomer
{
    [Required(AllowEmptyStrings = false, ErrorMessage = "Customer name is required.")]
    public string Name { get; set; } = default!;
}
```

This is also the way to make an empty JSON string fail, which the implicit rule never does. A plain `[Required]` (where `AllowEmptyStrings` defaults to `false`) rejected `{"name":""}` with a 400 in my repro. Conversely, `[Required(AllowEmptyStrings = true)]` accepted `""` in my repro, matching the implicit behaviour.

If you want to change the response shape rather than the message, that is a problem-details concern, not a validation one. The approach in [customizing validation error responses with IProblemDetailsService](/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/) works for controllers too.

## Gotchas and lookalikes

**Minimal APIs behave differently.** The same `CreateProduct` record bound in a minimal API endpoint accepted `{}` and `{"name":null}` with a 200 and `Name == null`, even with `builder.Services.AddValidation()` registered and a `[StringLength(20)]` on another property (which did produce a 400 when violated, so the validator was running). The .NET 10 validation source generator honours attributes but does not infer `[Required]` from nullability. If you are [validating request bodies in minimal APIs](/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/), add `[Required]` explicitly. Minimal API *parameters* are a separate story: a missing non-nullable `string q` query parameter returns 400 from the parameter binder itself, and in Development the exception page shows `BadHttpRequestException: Required parameter "string q" was not provided from query string.`

**The C# `required` keyword is a different error.** A `public required string Name { get; set; }` is enforced by System.Text.Json during deserialization, before MVC validation. The body in my repro was:

```json
{
  "$": ["JSON deserialization for type 'ReqKw' was missing required properties including: 'name'."],
  "o": ["The o field is required."]
}
```

The second entry, keyed by the action parameter name, is the implicit rule again: deserialization failed, the parameter stayed `null`, and the non-nullable parameter `ReqKw o` was then flagged. Declaring the parameter as `[FromBody] ReqKw? o` removes that noise entry. The `required` keyword and `[JsonRequired]` interact in their own ways, covered in [making System.Text.Json ignore a required property](/2026/08/how-to-make-system-text-json-ignore-a-property-with-the-required-modifier/) and [CS9035](/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/).

**"The p field is required" with an empty body.** Posting no body at all to `Create(CreateProduct p)` returned two errors: `"": ["A non-empty request body is required."]` and `"p": ["The p field is required."]`. Making the parameter `CreateProduct? p` turns the empty body into a successful binding with `p == null` (the action returned 204 from `Ok(null)`), so only do that if an empty body is valid for the endpoint. `MvcOptions.AllowEmptyInputInBodyModelBinding` is the global switch for the first message.

**Nullable context in a different assembly.** The rule reads the annotations of the assembly that declares the model, not the web project. Models in a shared library compiled with `<Nullable>disable</Nullable>` never get the implicit attribute, even if the API project enables nullable. The reverse also holds: enabling nullable in the shared library changes API behaviour without touching the API project.

**Inherited properties.** The annotation is read from the member that declares the property. If a DTO derives from a base class in another project, the base class's nullable context decides, not the derived type's. When a property you believe is `string?` still reports "required", find where it is actually declared.

**Value types need a different fix.** A missing `int` does not trigger this rule at all (value types are skipped). It defaults to `0` silently. If you need "must be supplied", use `int?` with `[Required]`.

## Related

- [How to validate request bodies in minimal APIs without controllers in ASP.NET Core 11](/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/), where attributes are the only source of required-ness.
- [Minimal API validation vs FluentValidation in ASP.NET Core 11](/2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11/), if you are deciding where rules like this should live.
- [Fix CS8618: non-nullable property must contain a non-null value](/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/), the compiler side of the same annotations.
- [How to consume an RFC 9457 ProblemDetails response from a typed HttpClient](/2026/09/how-to-consume-an-rfc-9457-problemdetails-response-from-a-typed-httpclient/), for clients reading the `errors` dictionary above.

## Sources

- [Non-nullable reference types and [Required] attribute](https://learn.microsoft.com/aspnet/core/mvc/models/validation#non-nullable-reference-types-and-required-attribute) in "Model validation in ASP.NET Core MVC and Razor Pages" on Microsoft Learn.
- [`MvcOptions.SuppressImplicitRequiredAttributeForNonNullableReferenceTypes`](https://learn.microsoft.com/dotnet/api/microsoft.aspnetcore.mvc.mvcoptions.suppressimplicitrequiredattributefornonnullablereferencetypes) API reference.
- [`DataAnnotationsMetadataProvider.cs`](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Mvc/Mvc.DataAnnotations/src/DataAnnotationsMetadataProvider.cs) on the `release/10.0` branch, for the `AllowEmptyStrings = true` inference and the `HasDefaultValue` exemption.
- [dotnet/aspnetcore#16654](https://github.com/dotnet/aspnetcore/issues/16654), an early report of the rule surprising users on inherited properties.
