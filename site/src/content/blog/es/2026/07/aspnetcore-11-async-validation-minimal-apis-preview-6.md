---
title: "La validación asíncrona llega a las Minimal APIs con .NET 11 Preview 6"
description: "Preview 6 agrega AsyncValidationAttribute e IAsyncValidatableObject para que las reglas de DataAnnotations consulten la base de datos antes de ejecutar tu endpoint, sin bloquear un hilo."
pubDate: 2026-07-20
tags:
  - "aspnetcore"
  - "dotnet-11"
  - "validation"
  - "minimal-apis"
  - "csharp"
lang: "es"
translationOf: "2026/07/aspnetcore-11-async-validation-minimal-apis-preview-6"
translatedBy: "claude"
translationDate: 2026-07-20
---

[.NET 11 Preview 6](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-6/) cierra una brecha que DataAnnotations ha arrastrado desde su lanzamiento: la validación era síncrona. Si una regla necesitaba consultar la base de datos (¿este correo ya está en uso, este espacio sigue libre?), bloqueabas un hilo dentro de `IsValid` o abandonabas DataAnnotations y recurrías a FluentValidation. Preview 6 agrega validadores asíncronos de primera clase y los conecta a la validación integrada de Minimal APIs introducida en .NET 10.

## Los dos nuevos puntos de enganche

Aparecen dos tipos en `System.ComponentModel.DataAnnotations`. El primero es `AsyncValidationAttribute` para una regla sobre un solo miembro:

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

El segundo es `IAsyncValidatableObject` para reglas que abarcan varias propiedades o necesitan el objeto completo. Devuelve un `IAsyncEnumerable<ValidationResult>`, y como extiende `IValidatableObject` aún implementas el `Validate` síncrono (que lanza una excepción cuando solo validas de forma asíncrona):

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

## Cómo conectarlo

No hay una nueva activación más allá de la llamada `AddValidation()` que .NET 10 ya introdujo. Regístrala, y el framework ejecuta tus validadores asíncronos antes de que se ejecute el cuerpo del endpoint:

```csharp
builder.Services.AddValidation();

app.MapPost("/reservations", (ReservationRequest request) => Results.Ok(request));
```

Una solicitud inválida se corta con un `400` y una carga útil `ValidationProblemDetails`, exactamente igual que la ruta síncrona. Por debajo, esto se apoya en la nueva API `Validator.ValidateObjectAsync` de las bibliotecas base, así que también funciona fuera de ASP.NET Core.

## El detalle que vale la pena conocer

La validación asíncrona invita a viajes de ida y vuelta en serie por accidente, así que el framework ejecuta el trabajo de forma concurrente cuando puede: los atributos asíncronos sobre el mismo miembro arrancan juntos, y los elementos de una colección se validan en paralelo. Aun así conserva el orden existente entre miembro, tipo e `IValidatableObject`, de modo que una comprobación barata de `[Required]` falla rápido antes de que pagues por una consulta a la base de datos. Combina esto con la [protección CSRF automática](/es/2026/07/aspnetcore-11-automatic-csrf-protection-fetch-metadata-preview-6/) de Preview 6 y el pipeline integrado cubre mucho más terreno que hace una versión.

Descarga el SDK de .NET 11 Preview 6, apunta a `net11.0` y lee las [notas de la versión de ASP.NET Core](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/aspnetcore.md) para conocer toda la superficie de validadores.
