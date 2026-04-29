---
title: "How to share validation logic between server and Blazor WebAssembly"
description: "The single biggest source of validation drift in a Blazor WebAssembly + ASP.NET Core app is the urge to write the rules twice. This guide walks the only layout that scales in .NET 11: a Shared class library that owns the DTOs and their validators, consumed by both the WASM client (EditForm + DataAnnotationsValidator or Blazored.FluentValidation) and the server (minimal API endpoint filter or MVC model binding), with a tested round-trip that maps server-side ValidationProblemDetails back into the EditContext."
pubDate: 2026-04-29
template: how-to
tags:
  - "blazor"
  - "blazor-webassembly"
  - "aspnetcore-11"
  - "dotnet-11"
  - "validation"
  - "fluentvalidation"
  - "csharp"
---

If your Blazor WebAssembly client and your ASP.NET Core API hold separate copies of the validation rules, they drift within the first sprint and produce the worst kind of bug: the form passes on the client, the server rejects it, the user sees a 400 with no inline error. The only durable fix is to put both DTOs and their validators in a third project that the client and server both reference, and to render the server's failure response back into the same `EditContext` the client used. This guide builds that layout end to end on .NET 11 (`Microsoft.AspNetCore.App` 11.0.0, `Microsoft.AspNetCore.Components.Web` 11.0.0, C# 14), first with built-in `System.ComponentModel.DataAnnotations`, then with `FluentValidation` 12 for rules that data annotations cannot express.

## Why a Shared project, not duplicated rules or a NuGet package

The two patterns that fail are obvious in hindsight. Copy-pasting `[Required]` attributes from the DTO on the API into a near-identical view model on the client produces drift every time someone edits one and forgets the other. Putting the contracts in an external NuGet package works for big systems but is overkill for a single app: you pay version bumps, package restore latency, and an internal feed for what should be a project reference.

A `Contracts` (or `Shared`) class library inside the same solution is the right shape. It targets `net11.0`, has zero ASP.NET dependencies, and is referenced by both `WebApp.Client` (the Blazor WASM project) and `WebApp.Server` (the ASP.NET Core API). The Blazor WebAssembly project template that ships with .NET 11 (`dotnet new blazorwasm --hosted` was removed in .NET 8 and stayed gone in .NET 11; you now create the three projects yourself or use `dotnet new blazor --interactivity WebAssembly --auth Individual` for the unified Blazor template) already accepts this layout: pick whichever scaffold you use and add a third project.

```bash
# .NET 11 SDK (11.0.100)
dotnet new sln -n WebApp
dotnet new classlib -n WebApp.Contracts -f net11.0
dotnet new webapi -n WebApp.Server -f net11.0
dotnet new blazorwasm -n WebApp.Client -f net11.0
dotnet sln add WebApp.Contracts WebApp.Server WebApp.Client
dotnet add WebApp.Server reference WebApp.Contracts
dotnet add WebApp.Client reference WebApp.Contracts
```

Two rules keep `WebApp.Contracts` clean and prevent it from accidentally pulling server code into the WASM bundle:

1. The `.csproj` lists no `FrameworkReference` and no `Microsoft.AspNetCore.*` packages. If you need `IFormFile` or `HttpContext` in a contract, you are conflating wire format with server logic; split them.
2. `<IsTrimmable>true</IsTrimmable>` is set so that the WASM publish step does not warn on every reflection-using validator. We come back to this in the AOT gotcha section.

## The DTO that runs through every example

```csharp
// WebApp.Contracts/RegistrationRequest.cs
// .NET 11, C# 14, System.ComponentModel.DataAnnotations 11.0.0
using System.ComponentModel.DataAnnotations;

namespace WebApp.Contracts;

public sealed record RegistrationRequest
{
    [Required, EmailAddress, StringLength(254)]
    public required string Email { get; init; }

    [Required, StringLength(72, MinimumLength = 12)]
    public required string Password { get; init; }

    [Required, Compare(nameof(Password))]
    public required string ConfirmPassword { get; init; }

    [Range(13, 130)]
    public int Age { get; init; }

    [Required, RegularExpression(@"^[a-zA-Z0-9_]{3,20}$",
        ErrorMessage = "Username must be 3-20 letters, digits, or underscores.")]
    public required string Username { get; init; }
}
```

`required` members combined with `init`-only setters give you a record that the client can build with object initializer syntax and that `System.Text.Json` 11 can deserialize on the server without a parameterless constructor (it threads the `[JsonConstructor]`-equivalent inference through `required` members in .NET 11). The same record is the type bound by the API endpoint and by the `EditForm` model. There is exactly one place to change a rule.

## The DataAnnotations path: zero extra packages

For most CRUD apps, data annotations on the shared DTO are enough. They run on the client because Blazor's `<DataAnnotationsValidator>` (in `Microsoft.AspNetCore.Components.Forms`) reflects over the model and feeds messages into `EditContext`, and they run on the server because ASP.NET Core's model binding pipeline calls `ObjectGraphValidator` for any type marked with `[ApiController]` or any minimal API parameter that goes through the default `IValidationProblemDetailsService` (introduced as part of the Endpoint filter validation work tracked in [aspnetcore#52281](https://github.com/dotnet/aspnetcore/pull/52281)).

Server endpoint, minimal API style:

```csharp
// WebApp.Server/Program.cs
// .NET 11, ASP.NET Core 11.0.0
using Microsoft.AspNetCore.Http.HttpResults;
using WebApp.Contracts;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddProblemDetails();
builder.Services.AddValidation(); // .NET 11 endpoint filter that runs DataAnnotations

var app = builder.Build();

app.MapPost("/api/register",
    Results<Ok<RegistrationResponse>, ValidationProblem> (RegistrationRequest req) =>
    {
        // model is already validated by the endpoint filter
        return TypedResults.Ok(new RegistrationResponse(Guid.NewGuid()));
    });

app.Run();

public sealed record RegistrationResponse(Guid UserId);
```

`AddValidation()` is the .NET 11 helper that registers an endpoint filter walking each parameter's `[Validator]`-discovered or `DataAnnotations`-annotated members and short-circuiting with a `400` `ValidationProblemDetails` body before your handler runs. The shape of the response is the same one the client reads back below.

Client form, in `WebApp.Client/Pages/Register.razor`:

```razor
@* Blazor WebAssembly, .NET 11. Microsoft.AspNetCore.Components 11.0.0 *@
@page "/register"
@using System.Net.Http.Json
@using WebApp.Contracts
@inject HttpClient Http

<EditForm Model="model" OnValidSubmit="SubmitAsync" FormName="register">
    <DataAnnotationsValidator />
    <ValidationSummary />

    <label>Email <InputText @bind-Value="model.Email" /></label>
    <ValidationMessage For="() => model.Email" />

    <label>Password <InputText type="password" @bind-Value="model.Password" /></label>
    <ValidationMessage For="() => model.Password" />

    <button type="submit">Register</button>
</EditForm>

@code {
    private RegistrationRequest model = new()
    {
        Email = "", Password = "", ConfirmPassword = "", Username = ""
    };

    private async Task SubmitAsync()
    {
        var response = await Http.PostAsJsonAsync("api/register", model);
        if (!response.IsSuccessStatusCode)
        {
            await ApplyServerValidationAsync(response);
        }
    }
}
```

Two things make this a *shared* validation story rather than two parallel ones. First, the `model` is `RegistrationRequest`, the same DTO the server binds. Second, when `<DataAnnotationsValidator>` evaluates the form, it executes the exact same `Validator.TryValidateObject` pass that the server's endpoint filter does. Whatever the client accepts, the server accepts; whatever the server rejects with `EmailAddress`, the client also rejects.

## Mapping server ValidationProblemDetails back into the EditContext

Even with shared rules, two failure cases come from the server and the server only: cross-aggregate checks (the email is unique in the user table), and infrastructure failures (rate limit, database constraint). For those, the server returns `400` with `ValidationProblemDetails`, and the client must pull each field error back out and attach it to the right `FieldIdentifier` in the `EditContext` so the user sees the message inline next to the offending field, not as a generic "registration failed" alert.

```csharp
// WebApp.Client/Validation/EditContextExtensions.cs
// .NET 11, C# 14
using Microsoft.AspNetCore.Components.Forms;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;

public static class EditContextExtensions
{
    private static readonly JsonSerializerOptions Options =
        new(JsonSerializerDefaults.Web);

    public static async Task ApplyValidationProblemAsync(
        this EditContext editContext,
        HttpResponseMessage response)
    {
        if ((int)response.StatusCode != 400) return;

        var problem = await response.Content
            .ReadFromJsonAsync<ValidationProblemDetails>(Options);
        if (problem?.Errors is null) return;

        var messageStore = new ValidationMessageStore(editContext);
        messageStore.Clear();

        foreach (var (fieldName, messages) in problem.Errors)
        {
            // ASP.NET Core uses lowercase-first names by default; normalize.
            var pascal = char.ToUpperInvariant(fieldName[0]) + fieldName[1..];
            var identifier = new FieldIdentifier(editContext.Model, pascal);
            foreach (var msg in messages) messageStore.Add(identifier, msg);
        }

        editContext.NotifyValidationStateChanged();
    }
}
```

The handler in the Razor file then becomes:

```csharp
private EditContext editContext = default!;

protected override void OnInitialized() =>
    editContext = new EditContext(model);

private async Task SubmitAsync()
{
    var response = await Http.PostAsJsonAsync("api/register", model);
    if (response.StatusCode == System.Net.HttpStatusCode.BadRequest)
        await editContext.ApplyValidationProblemAsync(response);
}
```

The reason this matters is that the server is the only place where some checks can run. A "username already taken" rule cannot live in the shared library because it requires a database call. By relaying its failure into the same `EditContext`, the user gets a single mental model: every error appears next to the offending field, regardless of whether the rule fired in the browser or in the API.

## When DataAnnotations is not enough: FluentValidation 12 in the shared project

DataAnnotations cannot express conditional rules ("Postcode is required if Country is 'US'"), it cannot run async checks against a service, and its error messages are awkward to localize past one resource file per attribute. FluentValidation 12, released in 2026 with first-class .NET 11 support, lives happily in the same shared project and runs in both directions.

Add the package and write a validator alongside the DTO:

```bash
dotnet add WebApp.Contracts package FluentValidation --version 12.0.0
```

```csharp
// WebApp.Contracts/RegistrationRequestValidator.cs
// FluentValidation 12.0.0, .NET 11, C# 14
using FluentValidation;

namespace WebApp.Contracts;

public sealed class RegistrationRequestValidator : AbstractValidator<RegistrationRequest>
{
    public RegistrationRequestValidator()
    {
        RuleFor(r => r.Email).NotEmpty().EmailAddress().MaximumLength(254);
        RuleFor(r => r.Password).NotEmpty().MinimumLength(12).MaximumLength(72);
        RuleFor(r => r.ConfirmPassword).Equal(r => r.Password)
            .WithMessage("Passwords do not match.");
        RuleFor(r => r.Username).Matches(@"^[a-zA-Z0-9_]{3,20}$");
        RuleFor(r => r.Age).InclusiveBetween(13, 130);
    }
}
```

On the server, register FluentValidation as the validator source for the same `AddValidation()` filter, or call it explicitly from a minimal API filter:

```csharp
// WebApp.Server/Program.cs additions
using FluentValidation;
using WebApp.Contracts;

builder.Services.AddScoped<IValidator<RegistrationRequest>,
                           RegistrationRequestValidator>();

app.MapPost("/api/register", async (
    RegistrationRequest req,
    IValidator<RegistrationRequest> validator) =>
{
    var result = await validator.ValidateAsync(req);
    if (!result.IsValid) return Results.ValidationProblem(result.ToDictionary());
    return Results.Ok(new RegistrationResponse(Guid.NewGuid()));
});
```

`result.ToDictionary()` produces the `IDictionary<string, string[]>` shape that `Results.ValidationProblem` expects, so the wire format the client decodes is identical to the DataAnnotations path. Your `ApplyValidationProblemAsync` extension keeps working.

On the client, install `Blazored.FluentValidation` (the `aksoftware` fork is the actively maintained one in 2026, version 2.4.0, targeting `net11.0`) and replace `<DataAnnotationsValidator />` with `<FluentValidationValidator />`:

```bash
dotnet add WebApp.Client package Blazored.FluentValidation --version 2.4.0
```

```razor
@using Blazored.FluentValidation

<EditForm Model="model" OnValidSubmit="SubmitAsync">
    <FluentValidationValidator />
    <ValidationSummary />
    @* same fields as before *@
</EditForm>
```

The component finds the validator by convention (`FooValidator` for `Foo`) in the assembly that contains the model, which is `WebApp.Contracts`. Because the validator is in the shared project, the client and the server execute the same instance of the same rules. The only difference is *where* they run.

## Async rules that have to run server-only

FluentValidation lets you mix sync and async rules. The temptation is to put `MustAsync(IsUsernameAvailableAsync)` on the validator and call it a day. Don't: the client side does not have access to your `UserManager`, and a synchronous Blazor `EditForm` cannot await an async rule mid-keystroke. The pattern that works is to mark async-only rules with a `RuleSet`:

```csharp
public sealed class RegistrationRequestValidator : AbstractValidator<RegistrationRequest>
{
    public RegistrationRequestValidator(IUserUniqueness? uniqueness = null)
    {
        // rules that run everywhere
        RuleFor(r => r.Email).NotEmpty().EmailAddress();
        // ... shared rules omitted

        RuleSet("Server", () =>
        {
            if (uniqueness is null) return; // skipped on client
            RuleFor(r => r.Email).MustAsync(uniqueness.IsEmailFreeAsync)
                .WithMessage("This email is already registered.");
            RuleFor(r => r.Username).MustAsync(uniqueness.IsUsernameFreeAsync)
                .WithMessage("Username taken.");
        });
    }
}

// WebApp.Contracts/IUserUniqueness.cs - interface only, no implementation
public interface IUserUniqueness
{
    ValueTask<bool> IsEmailFreeAsync(string email, CancellationToken ct);
    ValueTask<bool> IsUsernameFreeAsync(string username, CancellationToken ct);
}
```

The interface lives in `WebApp.Contracts` so the validator can compile, but it has no implementation there. The server provides a real implementation backed by EF Core; the client does not register one, so the constructor parameter is `null` and the `Server` ruleset adds no rules. On the server, you opt in:

```csharp
await validator.ValidateAsync(req,
    options => options.IncludeRuleSets("default", "Server"));
```

That way the cross-aggregate check fires only where it can and surfaces back to the client through the same `ValidationProblemDetails` mapping you already built.

## Trim and AOT gotchas in the WASM publish step

Blazor WebAssembly publish in .NET 11 runs IL trimming by default and supports a separate AOT pass with `<RunAOTCompilation>true</RunAOTCompilation>`. Both passes warn whenever a library uses unbounded reflection, which both DataAnnotations and FluentValidation do. Three concrete things to do:

1. Mark the shared project trimmable: `<IsTrimmable>true</IsTrimmable>` and `<IsAotCompatible>true</IsAotCompatible>` in `WebApp.Contracts.csproj`. This causes the SDK to surface trim warnings inside the shared library where you can fix them, instead of silently stripping rule discovery in the consumer.
2. For DataAnnotations, the runtime ships `[DynamicallyAccessedMembers(All)]` annotations on `Validator.TryValidateObject` since .NET 8, and they are still in place in .NET 11; you do not need to do anything else as long as your DTO is `public` and is reached from a root that the trimmer can see. `EditForm` reaches the model type by generic argument, which counts.
3. For FluentValidation 12, every validator you define is reflected on at startup. The `Blazored.FluentValidation` 2.4.0 component scans the assembly with `[DynamicDependency]` annotations applied so it survives trimming, but if you publish with `RunAOTCompilation`, add `<TrimmerRootAssembly Include="WebApp.Contracts" />` to the client `.csproj`. This roots the entire shared assembly and is the simplest correct answer; the WASM size cost is small because the only public types in `WebApp.Contracts` are the DTOs and validators you are already using.

If you skip these steps, the client looks healthy in `dotnet run`, then ships a Release build where validation silently does nothing because the trimmer removed the rules it could not statically prove were used.

## Field name casing and the snake_case trap

ASP.NET Core 11's default JSON options serialize property names in `camelCase`. `ValidationProblemDetails.Errors` therefore comes back keyed by `email`, not `Email`, and `FieldIdentifier` is case-sensitive. The `pascal` normalization in `ApplyValidationProblemAsync` handles the common case but not nested members (`Address.PostalCode` becomes `address.PostalCode` if you uppercase only the first letter). For nested DTOs, split on `.`, uppercase each segment's first character, then walk into the nested object using the segments to build a chain of `FieldIdentifier(parent, propertyName)` instances. Or, if you control the JSON options, set `JsonNamingPolicy = null` for `ProblemDetails` only by writing a custom `IProblemDetailsService`. The simpler answer is to keep DTOs flat enough that the casing flip is a one-liner.

If you adopt a different naming policy globally (snake_case is popular in 2026 because of OpenAPI tooling), the same idea applies: parse the policy, invert it, and feed the corrected name into `FieldIdentifier`. There is no built-in helper for this in `Microsoft.AspNetCore.Components.Forms`; the `EditContext` was designed before `ProblemDetails` was the standard error shape, and the two have not been wired together yet.

## Related guides and source material

For the supporting plumbing this guide assumed you had: the [global exception filter pattern in ASP.NET Core 11](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) catches the non-validation failures that should never reach the user as a 500. If you want a deeper look at the endpoint that backs this form, [refresh tokens in ASP.NET Core Identity](/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/) shows the `/api/register` continuation. For typed clients generated against the same DTO so you do not type the URL by hand, see [generate strongly-typed clients from an OpenAPI spec on .NET 11](/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/). And on the JSON side, [a custom `JsonConverter` in `System.Text.Json`](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) is the right escape hatch when a single field on the shared DTO needs different shapes on the wire.

Primary sources used while writing this:

- [ASP.NET Core 11 minimal API validation endpoint filter](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/parameter-binding?view=aspnetcore-11.0#validation), MS Learn.
- [Blazor `EditForm` and `DataAnnotationsValidator`](https://learn.microsoft.com/en-us/aspnet/core/blazor/forms/validation?view=aspnetcore-11.0), MS Learn.
- [`ValidationProblemDetails` reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.mvc.validationproblemdetails), .NET API Browser.
- [FluentValidation 12 docs](https://docs.fluentvalidation.net/en/latest/blazor.html), Blazor integration page.
- [Blazored.FluentValidation 2.4.0](https://github.com/Blazored/FluentValidation), GitHub README.
- [Blazor WebAssembly trimming and AOT guidance for .NET 11](https://learn.microsoft.com/en-us/aspnet/core/blazor/host-and-deploy/configure-trimmer?view=aspnetcore-11.0), MS Learn.
