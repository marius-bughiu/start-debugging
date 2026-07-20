---
title: "Async validation lands in Minimal APIs with .NET 11 Preview 6"
description: "Preview 6 adds AsyncValidationAttribute and IAsyncValidatableObject so DataAnnotations rules can hit the database before your endpoint runs, without blocking a thread."
pubDate: 2026-07-20
tags:
  - "aspnetcore"
  - "dotnet-11"
  - "validation"
  - "minimal-apis"
  - "csharp"
---

[.NET 11 Preview 6](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-6/) closes a gap that DataAnnotations has carried since it shipped: validation was synchronous. If a rule needed to check the database (is this email already taken, is this slot still free), you either blocked a thread inside `IsValid` or gave up on DataAnnotations and reached for FluentValidation. Preview 6 adds first-class async validators and wires them into the built-in Minimal API validation introduced in .NET 10.

## The two new hooks

Two types show up in `System.ComponentModel.DataAnnotations`. The first is `AsyncValidationAttribute` for a single-member rule:

```csharp
public sealed class UniqueEmailAttribute : AsyncValidationAttribute
{
    // Still required, but throws if the attribute is async-only.
    protected override ValidationResult? IsValid(object? value, ValidationContext context)
        => throw new InvalidOperationException("Use IsValidAsync.");

    protected override async Task<ValidationResult?> IsValidAsync(
        object? value, ValidationContext context, CancellationToken cancellationToken)
    {
        var db = context.GetRequiredService<AppDbContext>();
        var exists = await db.Users.AnyAsync(u => u.Email == (string?)value, cancellationToken);
        return exists ? new ValidationResult("Email is already registered.") : ValidationResult.Success;
    }
}
```

The second is `IAsyncValidatableObject` for rules that span several properties or need the whole object. It returns an `IAsyncEnumerable<ValidationResult>`, and because it extends `IValidatableObject` you still implement the synchronous `Validate` (which throws when you only validate async):

```csharp
public class ReservationRequest : IAsyncValidatableObject
{
    public DateOnly Date { get; set; }
    public int PartySize { get; set; }

    public IEnumerable<ValidationResult> Validate(ValidationContext context)
        => throw new InvalidOperationException("Use ValidateAsync.");

    public async IAsyncEnumerable<ValidationResult> ValidateAsync(
        ValidationContext context,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var db = context.GetRequiredService<AppDbContext>();
        var taken = await db.Reservations.CountAsync(r => r.Date == Date, cancellationToken);
        if (taken + PartySize > 40)
            yield return new ValidationResult("No capacity left for that date.", [nameof(PartySize)]);
    }
}
```

## Wiring it up

There is no new opt-in beyond the `AddValidation()` call that .NET 10 already introduced. Register it, and the framework runs your async validators before the endpoint body executes:

```csharp
builder.Services.AddValidation();

app.MapPost("/reservations", (ReservationRequest request) => Results.Ok(request));
```

An invalid request short-circuits to a `400` with a `ValidationProblemDetails` payload, exactly like the synchronous path. Under the covers this rides on the new `Validator.ValidateObjectAsync` API in the base libraries, so it works outside ASP.NET Core too.

## The detail worth knowing

Async validation invites accidental serial round-trips, so the framework runs work concurrently where it can: async attributes on the same member start together, and collection items validate in parallel. It still preserves the existing member then type then `IValidatableObject` ordering, so a cheap `[Required]` check fails fast before you pay for a database call. Pair this with Preview 6's [automatic CSRF protection](/2026/07/aspnetcore-11-automatic-csrf-protection-fetch-metadata-preview-6/) and the built-in pipeline covers a lot more ground than it did a release ago.

Grab the .NET 11 Preview 6 SDK, target `net11.0`, and read the [ASP.NET Core release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/aspnetcore.md) for the full validator surface.
