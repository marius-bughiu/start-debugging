---
title: "Asynchrone Validierung erreicht Minimal APIs mit .NET 11 Preview 6"
description: "Preview 6 ergänzt AsyncValidationAttribute und IAsyncValidatableObject, damit DataAnnotations-Regeln die Datenbank abfragen können, bevor Ihr Endpunkt läuft, ohne einen Thread zu blockieren."
pubDate: 2026-07-20
tags:
  - "aspnetcore"
  - "dotnet-11"
  - "validation"
  - "minimal-apis"
  - "csharp"
lang: "de"
translationOf: "2026/07/aspnetcore-11-async-validation-minimal-apis-preview-6"
translatedBy: "claude"
translationDate: 2026-07-20
---

[.NET 11 Preview 6](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-6/) schließt eine Lücke, die DataAnnotations seit der Auslieferung mit sich trägt: Die Validierung war synchron. Musste eine Regel die Datenbank prüfen (ist diese E-Mail bereits vergeben, ist dieser Slot noch frei?), blockierten Sie entweder einen Thread innerhalb von `IsValid` oder gaben DataAnnotations auf und griffen zu FluentValidation. Preview 6 ergänzt erstklassige asynchrone Validatoren und bindet sie in die integrierte Minimal-API-Validierung ein, die mit .NET 10 eingeführt wurde.

## Die zwei neuen Ansatzpunkte

Zwei Typen tauchen in `System.ComponentModel.DataAnnotations` auf. Der erste ist `AsyncValidationAttribute` für eine Regel auf einem einzelnen Member:

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

Der zweite ist `IAsyncValidatableObject` für Regeln, die mehrere Eigenschaften umfassen oder das gesamte Objekt benötigen. Er gibt ein `IAsyncEnumerable<ValidationResult>` zurück, und da er `IValidatableObject` erweitert, implementieren Sie weiterhin das synchrone `Validate` (das eine Ausnahme wirft, wenn Sie nur asynchron validieren):

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

## Die Verdrahtung

Es gibt keine neue Aktivierung über den Aufruf `AddValidation()` hinaus, den .NET 10 bereits eingeführt hat. Registrieren Sie ihn, und das Framework führt Ihre asynchronen Validatoren aus, bevor der Endpunkt-Rumpf ausgeführt wird:

```csharp
builder.Services.AddValidation();

app.MapPost("/reservations", (ReservationRequest request) => Results.Ok(request));
```

Eine ungültige Anfrage wird mit einem `400` und einem `ValidationProblemDetails`-Payload kurzgeschlossen, genau wie beim synchronen Pfad. Darunter setzt das auf der neuen API `Validator.ValidateObjectAsync` in den Basisbibliotheken auf, sodass es auch außerhalb von ASP.NET Core funktioniert.

## Das Detail, das man kennen sollte

Asynchrone Validierung lädt versehentlich zu seriellen Roundtrips ein, daher führt das Framework die Arbeit nebenläufig aus, wo es kann: asynchrone Attribute auf demselben Member starten gemeinsam, und die Elemente einer Sammlung werden parallel validiert. Trotzdem bleibt die bestehende Reihenfolge zwischen Member, Typ und `IValidatableObject` erhalten, sodass eine günstige `[Required]`-Prüfung schnell fehlschlägt, bevor Sie für eine Datenbankabfrage bezahlen. Kombinieren Sie das mit dem [automatischen CSRF-Schutz](/de/2026/07/aspnetcore-11-automatic-csrf-protection-fetch-metadata-preview-6/) von Preview 6, und die integrierte Pipeline deckt deutlich mehr ab als noch eine Version zuvor.

Laden Sie das .NET 11 Preview 6 SDK, zielen Sie auf `net11.0` und lesen Sie die [ASP.NET Core Release Notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/aspnetcore.md) für die vollständige Validator-Oberfläche.
