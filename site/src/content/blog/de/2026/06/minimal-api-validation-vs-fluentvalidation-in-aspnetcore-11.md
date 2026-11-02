---
title: "Minimal-API-Validierung vs FluentValidation in ASP.NET Core 11: Was sollten Sie wählen?"
description: "Integrierte Minimal-API-Validierung und FluentValidation vergleichen: asynchrone Regeln, Endpoint-Filter, Versionsunterschiede und Lizenz."
pubDate: 2026-06-15
updatedDate: 2026-11-02
template: vs
tags:
  - "comparison"
  - "aspnetcore"
  - "dotnet-11"
  - "minimal-apis"
  - "validation"
lang: "de"
translationOf: "2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-06-15
---

ASP.NET Core 10 führte mit `AddValidation()` integrierte Validierung für Minimal APIs ein. .NET 11 erweitert sie: Seit Preview 6 unterstützen Minimal APIs `AsyncValidationAttribute` und `IAsyncValidatableObject`. Asynchrone Validierung allein macht FluentValidation unter .NET 11 daher nicht erforderlich.

**Korrektur — 2. November 2026:** Der Vergleich berücksichtigt jetzt die integrierte asynchrone Validierung von .NET 11. Die folgenden synchronen Beispiele wurden mit SDK 10.0.302 und FluentValidation 12.1.1 geprüft. Eine Ausführung unter .NET 11 oder Benchmark-Ergebnisse werden nicht behauptet.

## Integrierte Validierung

DataAnnotations halten einfache Eingaberegeln am Modell. In einem Projekt mit Web SDK wird die Validierung registriert und der Endpunkt zugeordnet:

```csharp
// Program.cs: Microsoft.NET.Sdk.Web, net10.0 or later.
using System.ComponentModel.DataAnnotations;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddValidation();
var app = builder.Build();

app.MapPost("/products", (CreateProduct product) =>
    TypedResults.Created($"/products/{product.Sku}", product));

app.Run();

public record CreateProduct(
    [Required, Length(3, 20)] string Sku,
    [Required, MinLength(2)] string Name,
    [Range(1, 10_000)] int Quantity);
```

Ungültige Eingaben ergeben vor Ausführung des Handlers eine 400-Antwort im Validation-Problem-Format. Die Attribute an den Parametern dieses positional record werden vom Validierungsgenerator unterstützt. Eine gewöhnliche Klassenbibliothek mit Modellen benötigt das Paket `Microsoft.Extensions.Validation` und die in der Dokumentation beschriebene Registrierung für die jeweilige Assembly.

Die integrierte Pipeline von .NET 10 ist synchron. Für asynchrone Validierung unter .NET 11 sind die dokumentierten Async-APIs und die konkret eingesetzte Preview- oder Release-Version maßgeblich. Externe Prüfungen brauchen weiterhin Abbruchunterstützung und begrenzte Laufzeiten; Eindeutigkeit muss auch beim Speichern abgesichert werden.

## FluentValidation mit Endpoint-Filter

FluentValidation trennt Regeln in eigene Validator-Klassen. Das eignet sich etwa für gemeinsam genutzte Regeln, Rule Sets, Bedingungen oder Projekte, die diese API bereits einsetzen. Dieser Filter gilt ausdrücklich für einen einzelnen Endpunkt:

```csharp
// Program.cs: add a PackageReference to FluentValidation 12.1.1.
using FluentValidation;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddScoped<IValidator<CreateProduct>, CreateProductValidator>();
var app = builder.Build();

app.MapPost("/products", (CreateProduct product) =>
        TypedResults.Created($"/products/{product.Sku}", product))
    .AddEndpointFilter(async (context, next) =>
    {
        var product = context.GetArgument<CreateProduct>(0);
        var validator = context.HttpContext.RequestServices
            .GetRequiredService<IValidator<CreateProduct>>();
        var result = await validator.ValidateAsync(
            product, context.HttpContext.RequestAborted);
        if (!result.IsValid)
            return Results.ValidationProblem(result.ToDictionary());
        return await next(context);
    });

app.Run();

public record CreateProduct(string Sku, string Name, int Quantity);

public sealed class CreateProductValidator : AbstractValidator<CreateProduct>
{
    public CreateProductValidator()
    {
        RuleFor(x => x.Sku).NotEmpty().Length(3, 20);
        RuleFor(x => x.Name).NotEmpty().MinimumLength(2);
        RuleFor(x => x.Quantity).InclusiveBetween(1, 10_000);
    }
}
```

Der Filter setzt voraus, dass `CreateProduct` das Argument mit Index null ist. Er darf nicht unverändert auf Gruppen mit anderen Handler-Signaturen übertragen werden. Bei potenziell asynchronen Regeln `ValidateAsync` und das Abbruchtoken der Anfrage verwenden; benötigte Dienste in DI registrieren.

Dies ist nicht die ältere automatische MVC-Integration aus `FluentValidation.AspNetCore`. Deren Pipeline arbeitet synchron, integriert keine Minimal APIs und wird laut FluentValidation-Dokumentation für neue Projekte nicht mehr empfohlen. Sie ist von der neueren integrierten Minimal-API-Validierung zu unterscheiden.

## Auswahl und Lizenz

Entscheidend sind Wartbarkeit und Wiederverwendung der Regeln, die eingesetzte Framework-Version und das erwartete Fehlerformat. Für einfache DataAnnotations-Modelle ist die integrierte Lösung ein sinnvoller Ausgangspunkt; FluentValidation bietet andere Möglichkeiten zur Organisation und Kombination von Regeln. Keine Variante garantiert bessere Leistung oder Native-AOT-Kompatibilität beliebiger Validatoren und Abhängigkeiten. Publish-Ausgabe und Verhalten der bereitgestellten Anwendung prüfen.

Die hier verwendete Version FluentValidation 12.1.1 steht unter Apache License 2.0. FluentAssertions ist ein anderes Projekt; dessen Lizenzmeldungen sagen nichts über die Lizenz von FluentValidation aus. Maßgeblich ist die tatsächlich ausgelieferte Version.

Zur Organisation siehe [Routengruppen mit MapGroup](/de/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/).

## Quellen

- [ASP.NET Core validation](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/validation?view=aspnetcore-11.0)
- [.NET 11: asynchronous Minimal API validation](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-11?view=aspnetcore-11.0#async-validation-for-minimal-apis)
- [FluentValidation: ASP.NET Core integration](https://docs.fluentvalidation.net/en/latest/aspnet.html)
- [FluentValidation: asynchronous rules](https://docs.fluentvalidation.net/en/latest/async.html)
- [FluentValidation 12.1.1 license](https://github.com/FluentValidation/FluentValidation/blob/12.1.1/License.txt)
