---
title: "Validierungslogik zwischen Server und Blazor WebAssembly teilen"
description: "Die größte Quelle für Validierungs-Drift in einer Blazor-WebAssembly-plus-ASP.NET-Core-Anwendung ist der Drang, die Regeln zweimal zu schreiben. Diese Anleitung zeigt das einzige Layout, das in .NET 11 skaliert: eine Shared-Klassenbibliothek, der die DTOs und ihre Validatoren gehören, eingebunden vom WASM-Client (EditForm + DataAnnotationsValidator oder Blazored.FluentValidation) und vom Server (Endpoint-Filter in Minimal API oder MVC-Modellbindung), mit einem getesteten Round-Trip, der ValidationProblemDetails vom Server zurück in den EditContext überträgt."
pubDate: 2026-04-29
tags:
  - "blazor"
  - "blazor-webassembly"
  - "aspnetcore-11"
  - "dotnet-11"
  - "validation"
  - "fluentvalidation"
  - "csharp"
lang: "de"
translationOf: "2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly"
translatedBy: "claude"
translationDate: 2026-04-29
---

Wenn Ihr Blazor-WebAssembly-Client und Ihre ASP.NET-Core-API getrennte Kopien der Validierungsregeln pflegen, driften sie innerhalb des ersten Sprints auseinander und produzieren die schlimmste Sorte Bug: Das Formular besteht im Client, der Server lehnt es ab, der Benutzer sieht einen 400 ohne Inline-Fehler. Die einzige dauerhafte Lösung besteht darin, sowohl die DTOs als auch ihre Validatoren in ein drittes Projekt zu legen, das Client und Server beide referenzieren, und die Fehlerantwort des Servers in denselben `EditContext` zu rendern, den der Client benutzt hat. Diese Anleitung baut dieses Layout End-to-End in .NET 11 (`Microsoft.AspNetCore.App` 11.0.0, `Microsoft.AspNetCore.Components.Web` 11.0.0, C# 14) auf, zuerst mit dem eingebauten `System.ComponentModel.DataAnnotations`, dann mit `FluentValidation` 12 für Regeln, die Data Annotations nicht ausdrücken können.

## Warum ein Shared-Projekt, keine duplizierten Regeln und kein NuGet-Paket

Die zwei Muster, die scheitern, sind im Nachhinein offensichtlich. `[Required]`-Attribute vom DTO der API in ein nahezu identisches View-Modell auf dem Client zu kopieren erzeugt jedes Mal Drift, wenn jemand das eine bearbeitet und das andere vergisst. Die Verträge in ein externes NuGet-Paket zu legen funktioniert für große Systeme, ist aber Overkill für eine einzelne Anwendung: Sie zahlen Versions-Bumps, Paket-Restore-Latenz und einen internen Feed für etwas, das eine Projekt-Referenz sein sollte.

Eine `Contracts`- (oder `Shared`-) Klassenbibliothek innerhalb derselben Solution ist die richtige Form. Sie zielt auf `net11.0`, hat keine ASP.NET-Abhängigkeiten und wird sowohl von `WebApp.Client` (dem Blazor-WASM-Projekt) als auch von `WebApp.Server` (der ASP.NET-Core-API) referenziert. Das Blazor-WebAssembly-Projekt-Template, das mit .NET 11 ausgeliefert wird (`dotnet new blazorwasm --hosted` wurde in .NET 8 entfernt und blieb in .NET 11 entfernt; Sie erstellen die drei Projekte jetzt selbst oder verwenden `dotnet new blazor --interactivity WebAssembly --auth Individual` für das vereinheitlichte Blazor-Template) akzeptiert dieses Layout bereits: Wählen Sie das Scaffold, das Sie verwenden, und fügen Sie ein drittes Projekt hinzu.

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

Zwei Regeln halten `WebApp.Contracts` sauber und verhindern, dass es versehentlich Servercode ins WASM-Bundle zieht:

1. Die `.csproj` listet kein `FrameworkReference` und keine `Microsoft.AspNetCore.*`-Pakete auf. Wenn Sie `IFormFile` oder `HttpContext` in einem Vertrag brauchen, vermischen Sie Drahtformat mit Serverlogik; trennen Sie sie.
2. `<IsTrimmable>true</IsTrimmable>` ist gesetzt, damit der WASM-Publish-Schritt nicht bei jedem Validator warnt, der Reflection benutzt. Wir kommen darauf im AOT-Gotcha-Abschnitt zurück.

## Das DTO, das durch jedes Beispiel läuft

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

`required`-Member kombiniert mit `init`-only-Settern liefern einen Record, den der Client mit Objekt-Initialisierer-Syntax bauen kann und den `System.Text.Json` 11 auf dem Server ohne parameterlosen Konstruktor deserialisieren kann (es leitet die `[JsonConstructor]`-äquivalente Inferenz in .NET 11 durch die `required`-Member). Derselbe Record ist der Typ, den der API-Endpoint und das `EditForm`-Modell binden. Es gibt genau eine Stelle, an der eine Regel geändert wird.

## Der DataAnnotations-Pfad: keine zusätzlichen Pakete

Für die meisten CRUD-Anwendungen reichen Data Annotations am gemeinsamen DTO aus. Sie laufen auf dem Client, weil Blazors `<DataAnnotationsValidator>` (in `Microsoft.AspNetCore.Components.Forms`) das Modell per Reflection inspiziert und Meldungen in den `EditContext` einspeist, und sie laufen auf dem Server, weil die Modellbindungs-Pipeline von ASP.NET Core den `ObjectGraphValidator` für jeden Typ aufruft, der mit `[ApiController]` markiert ist, oder für jeden Minimal-API-Parameter, der durch den Standard-`IValidationProblemDetailsService` läuft (eingeführt im Rahmen der Endpoint-Filter-Validierungsarbeit, die in [aspnetcore#52281](https://github.com/dotnet/aspnetcore/pull/52281) verfolgt wird).

Server-Endpoint, Minimal-API-Stil:

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

`AddValidation()` ist der .NET-11-Helper, der einen Endpoint-Filter registriert, der die per `[Validator]` entdeckten oder per `DataAnnotations` annotierten Member jedes Parameters durchläuft und mit einem `400`-`ValidationProblemDetails`-Body abkürzt, bevor Ihr Handler läuft. Die Form der Antwort ist dieselbe, die der Client weiter unten zurückliest.

Client-Formular, in `WebApp.Client/Pages/Register.razor`:

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

Zwei Dinge machen daraus eine *gemeinsame* Validierungsgeschichte statt zweier paralleler. Erstens ist `model` `RegistrationRequest`, das DTO, das auch der Server bindet. Zweitens führt `<DataAnnotationsValidator>`, wenn es das Formular auswertet, exakt denselben `Validator.TryValidateObject`-Durchlauf aus wie der Endpoint-Filter des Servers. Was der Client akzeptiert, akzeptiert der Server; was der Server mit `EmailAddress` ablehnt, lehnt auch der Client ab.

## Server-ValidationProblemDetails zurück in den EditContext überführen

Selbst mit gemeinsamen Regeln kommen zwei Fehlerklassen ausschließlich vom Server: aggregat-übergreifende Prüfungen (die E-Mail-Adresse ist in der Benutzertabelle eindeutig) und Infrastrukturfehler (Rate Limit, Datenbank-Constraint). Dafür liefert der Server `400` mit `ValidationProblemDetails`, und der Client muss jeden Feldfehler herausziehen und an den richtigen `FieldIdentifier` im `EditContext` hängen, damit der Benutzer die Meldung inline neben dem fehlerhaften Feld sieht und nicht als generischen "Registrierung fehlgeschlagen"-Hinweis.

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

Der Handler in der Razor-Datei wird damit zu:

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

Der Grund, warum das wichtig ist: Der Server ist der einzige Ort, an dem manche Prüfungen laufen können. Eine "Username bereits vergeben"-Regel kann nicht in der gemeinsamen Bibliothek leben, weil sie einen Datenbankaufruf braucht. Indem ihre Fehlermeldung in denselben `EditContext` weitergeleitet wird, bekommt der Benutzer ein einheitliches mentales Modell: Jeder Fehler erscheint neben dem fehlerhaften Feld, unabhängig davon, ob die Regel im Browser oder in der API gefeuert hat.

## Wenn DataAnnotations nicht reicht: FluentValidation 12 im Shared-Projekt

DataAnnotations kann keine bedingten Regeln ausdrücken ("Postcode ist erforderlich, wenn Country 'US' ist"), kann keine asynchronen Prüfungen gegen einen Service laufen lassen, und seine Fehlermeldungen sind über eine Resource-Datei pro Attribut hinaus umständlich zu lokalisieren. FluentValidation 12, in 2026 mit erstklassiger .NET-11-Unterstützung veröffentlicht, lebt problemlos im selben Shared-Projekt und läuft in beide Richtungen.

Paket hinzufügen und einen Validator neben das DTO schreiben:

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

Auf dem Server registrieren Sie FluentValidation als Validator-Quelle für denselben `AddValidation()`-Filter oder rufen es explizit aus einem Minimal-API-Filter auf:

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

`result.ToDictionary()` erzeugt die `IDictionary<string, string[]>`-Form, die `Results.ValidationProblem` erwartet, sodass das Drahtformat, das der Client decodiert, identisch zum DataAnnotations-Pfad ist. Ihre `ApplyValidationProblemAsync`-Extension funktioniert weiter.

Auf dem Client installieren Sie `Blazored.FluentValidation` (der `aksoftware`-Fork ist 2026 der aktiv gepflegte, Version 2.4.0, mit Ziel `net11.0`) und ersetzen `<DataAnnotationsValidator />` durch `<FluentValidationValidator />`:

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

Die Komponente findet den Validator per Konvention (`FooValidator` für `Foo`) im Assembly, das das Modell enthält, also `WebApp.Contracts`. Da der Validator im Shared-Projekt liegt, führen Client und Server dieselbe Instanz derselben Regeln aus. Der einzige Unterschied ist, *wo* sie laufen.

## Asynchrone Regeln, die nur serverseitig laufen können

FluentValidation lässt Sie synchrone und asynchrone Regeln mischen. Die Versuchung ist, `MustAsync(IsUsernameAvailableAsync)` an den Validator zu hängen und es dabei zu belassen. Tun Sie es nicht: Die Client-Seite hat keinen Zugriff auf Ihren `UserManager`, und ein synchrones Blazor-`EditForm` kann keine asynchrone Regel mitten im Tastendruck abwarten. Das Muster, das funktioniert, ist async-only-Regeln mit einem `RuleSet` zu markieren:

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

Das Interface lebt in `WebApp.Contracts`, damit der Validator kompiliert, hat dort aber keine Implementierung. Der Server stellt eine echte, von EF Core gestützte Implementierung bereit; der Client registriert keine, sodass der Konstruktor-Parameter `null` ist und das `Server`-Ruleset keine Regeln hinzufügt. Auf dem Server aktivieren Sie es aktiv:

```csharp
await validator.ValidateAsync(req,
    options => options.IncludeRuleSets("default", "Server"));
```

So feuert die aggregat-übergreifende Prüfung nur dort, wo sie kann, und kommt über dasselbe `ValidationProblemDetails`-Mapping zum Client zurück, das Sie bereits gebaut haben.

## Trim- und AOT-Gotchas im WASM-Publish-Schritt

Blazor-WebAssembly-Publish in .NET 11 führt standardmäßig IL-Trimming aus und unterstützt einen separaten AOT-Durchlauf mit `<RunAOTCompilation>true</RunAOTCompilation>`. Beide Durchläufe warnen, wenn eine Bibliothek unbeschränkte Reflection benutzt, was sowohl DataAnnotations als auch FluentValidation tun. Drei konkrete Dinge:

1. Markieren Sie das Shared-Projekt als trimmbar: `<IsTrimmable>true</IsTrimmable>` und `<IsAotCompatible>true</IsAotCompatible>` in `WebApp.Contracts.csproj`. Dadurch zeigt das SDK Trim-Warnungen innerhalb der Shared-Bibliothek an, wo Sie sie korrigieren können, statt die Regelerkennung im Konsumenten still zu strippen.
2. Für DataAnnotations liefert die Runtime seit .NET 8 `[DynamicallyAccessedMembers(All)]`-Annotationen an `Validator.TryValidateObject`, und sie sind in .NET 11 weiterhin in Kraft; Sie müssen nichts weiter tun, solange Ihr DTO `public` ist und von einer Wurzel aus erreicht wird, die der Trimmer sehen kann. `EditForm` erreicht den Modelltyp über das Generic-Argument, was zählt.
3. Für FluentValidation 12 wird jeder definierte Validator beim Start per Reflection inspiziert. Die Komponente `Blazored.FluentValidation` 2.4.0 scannt das Assembly mit angewendeten `[DynamicDependency]`-Annotationen und überlebt damit das Trimming, aber wenn Sie mit `RunAOTCompilation` veröffentlichen, fügen Sie `<TrimmerRootAssembly Include="WebApp.Contracts" />` zur `.csproj` des Clients hinzu. Das verwurzelt das gesamte Shared-Assembly und ist die einfachste korrekte Antwort; die WASM-Größenkosten sind klein, weil die einzigen öffentlichen Typen in `WebApp.Contracts` die DTOs und Validatoren sind, die Sie ohnehin verwenden.

Wenn Sie diese Schritte überspringen, sieht der Client in `dotnet run` gesund aus und liefert dann einen Release-Build aus, in dem die Validierung still nichts tut, weil der Trimmer Regeln entfernt hat, deren Verwendung er nicht statisch beweisen konnte.

## Groß-/Kleinschreibung der Feldnamen und die snake_case-Falle

Die JSON-Standardoptionen von ASP.NET Core 11 serialisieren Property-Namen in `camelCase`. `ValidationProblemDetails.Errors` kommt deshalb mit Schlüssel `email` zurück, nicht `Email`, und `FieldIdentifier` ist case-sensitive. Die `pascal`-Normalisierung in `ApplyValidationProblemAsync` deckt den häufigen Fall ab, aber keine verschachtelten Member (`Address.PostalCode` wird zu `address.PostalCode`, wenn Sie nur den ersten Buchstaben großschreiben). Für verschachtelte DTOs splitten Sie nach `.`, schreiben den ersten Buchstaben jedes Segments groß und steigen dann ins verschachtelte Objekt ab, indem Sie mit den Segmenten eine Kette von `FieldIdentifier(parent, propertyName)`-Instanzen aufbauen. Oder, falls Sie die JSON-Optionen kontrollieren, setzen Sie `JsonNamingPolicy = null` ausschließlich für `ProblemDetails`, indem Sie einen eigenen `IProblemDetailsService` schreiben. Die einfachere Antwort ist, DTOs flach genug zu halten, sodass der Casing-Flip einzeilig bleibt.

Wenn Sie global eine andere Naming-Policy einsetzen (snake_case ist 2026 wegen OpenAPI-Tooling beliebt), gilt dieselbe Idee: Policy parsen, invertieren und den korrigierten Namen an `FieldIdentifier` übergeben. Es gibt dafür keinen eingebauten Helper in `Microsoft.AspNetCore.Components.Forms`; der `EditContext` wurde entworfen, bevor `ProblemDetails` die Standard-Fehlerform war, und beide sind noch nicht miteinander verdrahtet.

## Verwandte Anleitungen und Quellenmaterial

Für die unterstützende Klempnerei, die diese Anleitung voraussetzt: Das [globale Exception-Filter-Pattern in ASP.NET Core 11](/de/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) fängt die nicht-validierungsbezogenen Fehler ab, die nie als 500 beim Benutzer landen sollten. Wenn Sie einen tieferen Blick auf den Endpoint wollen, der dieses Formular bedient, zeigt [Refresh-Tokens in ASP.NET Core Identity](/de/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/) die Fortsetzung von `/api/register`. Für getypte Clients, die gegen dasselbe DTO generiert werden, damit Sie die URL nicht von Hand tippen, siehe [stark typisierte Clients aus einer OpenAPI-Spezifikation in .NET 11 generieren](/de/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/). Und auf der JSON-Seite ist [ein eigener `JsonConverter` in `System.Text.Json`](/de/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) der richtige Notausgang, wenn ein einzelnes Feld des Shared-DTO unterschiedliche Formen auf der Leitung braucht.

Primärquellen, die beim Schreiben verwendet wurden:

- [Validierungs-Endpoint-Filter für Minimal API in ASP.NET Core 11](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/parameter-binding?view=aspnetcore-11.0#validation), MS Learn.
- [Blazor `EditForm` und `DataAnnotationsValidator`](https://learn.microsoft.com/en-us/aspnet/core/blazor/forms/validation?view=aspnetcore-11.0), MS Learn.
- [`ValidationProblemDetails`-Referenz](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.mvc.validationproblemdetails), .NET API Browser.
- [FluentValidation-12-Doku](https://docs.fluentvalidation.net/en/latest/blazor.html), Blazor-Integrationsseite.
- [Blazored.FluentValidation 2.4.0](https://github.com/Blazored/FluentValidation), GitHub-README.
- [Trimming- und AOT-Anleitung für Blazor WebAssembly in .NET 11](https://learn.microsoft.com/en-us/aspnet/core/blazor/host-and-deploy/configure-trimmer?view=aspnetcore-11.0), MS Learn.
