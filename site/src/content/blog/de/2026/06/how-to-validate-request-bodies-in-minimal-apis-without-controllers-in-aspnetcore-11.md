---
title: "Request-Bodies in Minimal APIs ohne Controller validieren in ASP.NET Core 11"
description: "ASP.NET Core 11 bietet eingebaute Validierung für Minimal APIs: Rufen Sie AddValidation auf, annotieren Sie Ihren Request-Record mit DataAnnotations, und ein Source Generator validiert das gebundene Modell und gibt 400 ProblemDetails zurück, bevor Ihr Handler läuft. Ohne Controller, ohne FluentValidation, ohne manuelle Prüfungen."
pubDate: 2026-06-07
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-apis"
lang: "de"
translationOf: "2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-06-07
---

Jahrelang lautete die ehrliche Antwort auf "Wie validiere ich einen Request-Body in einer Minimal API" schlicht "gar nicht, jedenfalls nicht automatisch." Minimal APIs kamen ohne die `ModelState`-Maschinerie, die Controller gratis erhalten, also griffen Sie zu `FluentValidation`, zum Paket `MiniValidation` oder zu einem handgeschriebenen `if`-Block in jedem Handler. Das hat sich in .NET 10 geändert und gilt unverändert in .NET 11: Rufen Sie `builder.Services.AddValidation()` auf, dekorieren Sie Ihren Request-Typ mit denselben `System.ComponentModel.DataAnnotations`-Attributen, die Sie bereits kennen (`[Required]`, `[Range]`, `[EmailAddress]`), und ein Source Generator erzeugt einen Endpoint Filter, der das gebundene Modell validiert, bevor der Rumpf Ihres Handlers läuft. Ungültige Anfragen kommen als `400 Bad Request` mit einem `ProblemDetails`-Body zurück, ohne `ModelState.IsValid`-Prüfung, ohne Controller, ohne zusätzliches Paket. Alles unten zielt auf .NET 11 mit `Microsoft.NET.Sdk.Web` und C# 14; die Funktion ist identisch in .NET 10, wo sie zuerst erschien.

## Warum Minimal APIs anfangs keine Validierung hatten

Das war kein Versehen, sondern eine Designentscheidung. Die Modellvalidierung von MVC läuft über eine reflexionsbasierte Pipeline: Sie durchläuft den Modellgraphen zur Laufzeit, entdeckt die `ValidationAttribute`-Instanzen, ruft sie auf und füllt den `ModelState`. Genau diese Reflexion ist die Art von Start- und Pro-Anfrage-Kosten, die der Stack der Minimal APIs vermeiden sollte, und sie ist feindlich gegenüber Trimming und Native AOT. Die ursprüngliche Minimal-API-Oberfläche band also Ihre Parameter und rief Ihren Handler auf, fertig. War der Body Unsinn, sah Ihr Handler den Unsinn.

Die Lösung in .NET 10 umgeht das Reflexionsproblem mit einem Source Generator. Zur Kompilierzeit findet er jeden Typ, der als Minimal-API-Parameter verwendet wird, liest die `DataAnnotations`-Attribute an diesen Typen und erzeugt den Validierungscode direkt. Es gibt keine Modellgraph-Reflexion zur Laufzeit, und genau das macht die Funktion mit dem schlanken, AOT-freundlichen Endpoint-Modell kompatibel. Falls Sie noch zwischen den beiden Endpoint-Stilen abwägen, finden Sie die umfassenderen Abwägungen in [Minimal APIs vs Controller in ASP.NET Core 11](/de/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/); diese Anleitung setzt voraus, dass Sie sich für Minimal APIs entschieden haben und die Validierung zurückwollen.

## Drei Schritte, um die Validierung einzuschalten

1. **Registrieren Sie die Services.** Rufen Sie `builder.Services.AddValidation()` auf, bevor Sie die App bauen. Damit werden die Validierungsservices und der Endpoint Filter registriert, der sie ausführt.
2. **Stellen Sie sicher, dass der Source Generator aktiv ist.** Mit dem Web-SDK von .NET 10 oder .NET 11 wird der Validierungsgenerator automatisch verdrahtet, sobald Sie `AddValidation()` aufrufen. Wenn Ihr Build älter als die finale Version ist oder Sie eine abgespeckte `.csproj` kopiert haben, erzeugt der Generator Interceptoren im Namespace `Microsoft.AspNetCore.Http.Validation.Generated`; stellen Sie sicher, dass dieser Namespace in `InterceptorsNamespaces` enthalten ist (das SDK erledigt das in aktuellen Builds für Sie).
3. **Annotieren Sie den Request-Typ und machen Sie ihn `public`.** Setzen Sie `DataAnnotations`-Attribute an die Eigenschaften oder die positionellen Parameter Ihres Request-Records oder Ihrer Klasse. Der Typ muss `public` sein, denn der Generator kann nur für zugängliche Typen Code sehen und erzeugen.

Das ist die gesamte Einrichtung. So sieht die Verdrahtung in `Program.cs` aus:

```csharp
// .NET 11, C# 14 -- Program.cs
using System.ComponentModel.DataAnnotations;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddValidation();          // step 1
var app = builder.Build();

app.MapPost("/products", (CreateProduct product) =>
    TypedResults.Created($"/products/{product.Sku}", product));

app.Run();

public record CreateProduct(
    [Required, Length(3, 20)] string Sku,
    [Required, MinLength(2)] string Name,
    [Range(1, 10_000)] int Quantity);
```

Falls die `.csproj` die Eigenschaft jemals explizit benötigt (ältere SDKs), sieht sie so aus:

```xml
<!-- only needed if the generator's interceptors are not picked up automatically -->
<PropertyGroup>
  <InterceptorsNamespaces>$(InterceptorsNamespaces);Microsoft.AspNetCore.Http.Validation.Generated</InterceptorsNamespaces>
</PropertyGroup>
```

## Was eine ungültige Anfrage tatsächlich zurückgibt

Senden Sie per POST einen Body, der zwei Regeln verletzt, und Sie erhalten ein maschinenlesbares `400`, ohne eine einzige Zeile Fehlerbehandlung zu schreiben:

```bash
# .NET 11
curl -i -X POST http://localhost:5000/products \
  -H "Content-Type: application/json" \
  -d '{"sku":"x","name":"","quantity":0}'
```

```json
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json

{
  "type": "https://tools.ietf.org/html/rfc9110#section-15.5.1",
  "title": "One or more validation errors occurred.",
  "status": 400,
  "errors": {
    "Sku": ["The field Sku must be a string with a minimum length of 3 and a maximum length of 20."],
    "Name": ["The Name field is required."],
    "Quantity": ["The field Quantity must be between 1 and 10000."]
  }
}
```

Dieses Payload ist ein `HttpValidationProblemDetails`, dieselbe RFC-9457-/RFC-7807-Form, die MVC produziert, sodass bestehende Clients, die `errors` bereits parsen, weiterhin funktionieren. Der Handler läuft nie. Es gibt keinen `ModelState`, keine `IsValid`-Prüfung, nichts zu vergessen. Das Fehler-Dictionary ist nach Eigenschaftsnamen indexiert, und verschachtelte Member verwenden einen Pfad mit Punkten, was wichtig wird, sobald Ihre Modelle nicht mehr flach sind.

## Verschachtelte Objekte werden rekursiv validiert

Die Validierung steigt automatisch in komplexe Eigenschaften hinab. Eine Anfrage mit einem Adressobjekt validiert auch die Adresse, und die Fehlerschlüssel spiegeln den Pfad wider:

```csharp
// .NET 11, C# 14
public record CreateOrder(
    [Required, EmailAddress] string CustomerEmail,
    [Required] BillingAddress Billing);

public record BillingAddress(
    [Required, MinLength(2)] string Street,
    [Required, Length(2, 10)] string PostalCode,
    [Required, RegularExpression("^[A-Z]{2}$")] string CountryCode);
```

Senden Sie per POST eine Bestellung mit einer falschen Postleitzahl, und der Fehlerschlüssel ist `Billing.PostalCode`, nicht ein flachgeklopftes `PostalCode`. Der Generator hat `BillingAddress` entdeckt, weil `CreateOrder` ihn referenziert; Sie mussten den verschachtelten Typ nirgends registrieren. Diese rekursive Entdeckung ist der Teil, der die Funktion wirklich nützlich macht statt zum Spielzeug für Bodies mit einem einzigen Feld.

## Wenn der Typ nicht direkt in einer Handler-Signatur steht

Der Generator findet Typen, indem er die Parameter der Minimal-API-Handler und die von ihnen aus erreichbaren Member betrachtet. Wird ein Typ nur über eine Basisklasse, ein Interface oder Polymorphie referenziert, entdeckt der Generator ihn möglicherweise nicht. Annotieren Sie für solche Fälle den Typ selbst mit `[ValidatableType]` aus `Microsoft.AspNetCore.Http.Validation`, um dem Generator mitzuteilen, dass er explizit Validierungslogik dafür erzeugen soll:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Http.Validation;
using System.ComponentModel.DataAnnotations;

[ValidatableType]
public abstract record PaymentMethod
{
    [Required, Length(2, 40)] public string Holder { get; init; } = "";
}

public sealed record CardPayment : PaymentMethod
{
    [Required, CreditCard] public string Number { get; init; } = "";
}
```

`[ValidatableType]` ist die manuelle Notausstiegsluke: Greifen Sie dazu, wenn die Validierung bei einem Typ, bei dem Sie sie erwarteten, stillschweigend nicht auslöst, was fast immer bedeutet, dass der Generator ihn von einem Handler-Parameter aus nicht erreichen konnte.

## Regeln über mehrere Eigenschaften mit IValidatableObject

Attribute validieren einen Member nach dem anderen. Für Regeln über mehrere Felder ("das Enddatum muss nach dem Startdatum liegen", "wenn der Rabatt gesetzt ist, ist der Grund erforderlich") implementieren Sie `IValidatableObject`. Seine `Validate`-Methode läuft nach den Attributprüfungen und liefert `ValidationResult`-Einträge:

```csharp
// .NET 11, C# 14
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

Das String-Array, das Sie als zweites Argument übergeben, steuert, unter welchem Schlüssel der Fehler im `errors`-Dictionary landet. Übergeben Sie `[nameof(End)]`, sieht der Client `"End": ["End must be after Start."]`; lassen Sie es weg, landet der Fehler unter einem leeren Schlüssel als Fehler auf Modellebene. Verwenden Sie den Membernamen, damit Ihre UI das richtige Feld hervorheben kann.

## Ein eigenes ValidationAttribute, wenn die eingebauten nicht reichen

Wenn weder die eingebauten Attribute noch `IValidatableObject` passen, schreiben Sie ein `ValidationAttribute`. Der Source Generator erfasst eigene Attribute genauso wie `[Range]`:

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

Eigene Attribute halten die Regel nah an den Daten und über jeden Endpoint hinweg wiederverwendbar, der ein `Booking` entgegennimmt, und genau das ist der Sinn der attributbasierten Validierung gegenüber inline-`if`-Blöcken, die über die Handler verstreut sind.

## Query-, Routen- und Header-Parameter werden ebenfalls validiert

Die Funktion ist nicht auf den JSON-Body beschränkt. Attribute an skalaren Parametern, die aus der Route, der Query-Zeichenkette oder den Headern gebunden werden, werden mit derselben Maschinerie validiert:

```csharp
// .NET 11, C# 14
app.MapGet("/search",
    ([Range(1, 100)] int pageSize,
     [Required, MinLength(2)] string query) =>
        TypedResults.Ok(new { pageSize, query }));
```

Eine Anfrage an `/search?pageSize=500&query=x` wird mit einem `400` abgelehnt, bevor der Handler läuft, wobei sowohl `pageSize` als auch `query` in `errors` aufgeführt sind. Das schließt die häufigste Validierungslücke, auf die man nach dem Body stößt: die Paging- und Filterparameter, die zuvor ungeprüft durchrutschten.

## Validierung für einen Endpoint ausschalten

Manchmal nimmt ein Endpoint einen Typ entgegen, der überall sonst validiert wird, aber hier wollen Sie den Rohwert, etwa eine interne Admin-Route, die bewusst andernfalls ungültige Daten akzeptiert. Verketten Sie `DisableValidation()` an genau diesem einen Endpoint:

```csharp
// .NET 11, C# 14
app.MapPost("/internal/import", (CreateProduct product) =>
        TypedResults.Accepted($"/products/{product.Sku}", product))
    .DisableValidation();
```

Das entfernt den Validierungsfilter von diesem einen Endpoint, ohne die globale `AddValidation()`-Registrierung anzutasten, sodass alle anderen Endpoints, die `CreateProduct` verwenden, weiterhin validieren.

## Details, die man vor dem Ausliefern kennen sollte

Eine Handvoll scharfer Kanten lassen einen beim ersten Mal stolpern:

- **Der Request-Typ muss `public` sein.** Der Source Generator kann nur Code für Typen erzeugen, die er benennen kann. Ein `record` oder eine `class`, die ohne `public` deklariert oder ohne die richtige Zugänglichkeit in einen anderen Typ verschachtelt ist, erhält stillschweigend keine Validierung. Wenn die Validierung "nicht funktioniert", prüfen Sie zuerst den Zugriffsmodifizierer.
- **Positionelle Record-Parameter: die Platzierung des Attributs zählt.** `[Required] string Name` an einem positionellen Record-Parameter wird vom Generator gelesen, aber wenn Sie zusätzlich darauf angewiesen sind, dass das Attribut an der generierten *Eigenschaft* sitzt (für Tooling, das zur Laufzeit darüber reflektiert), verwenden Sie das explizite Ziel: `[property: Required] string Name`. Der Validierungsgenerator selbst liest die Parameterform, sodass der meiste Code kein `property:` braucht, aber das Vermischen von Erwartungen ist eine häufige Quelle der Verwirrung.
- **Die Validierung läuft als Endpoint Filter, also gilt die Filterreihenfolge.** Der Validierungsfilter wird pro Endpoint hinzugefügt. Wenn Sie zusätzlich eigene `AddEndpointFilter`-Aufrufe hinzufügen, achten Sie darauf, wo die Validierung in der Kette sitzt. Wie sich die Filterreihenfolge über Route Groups hinweg zusammensetzt, zeigt [Minimal-API-Endpoints mit MapGroup in ASP.NET Core 11 organisieren](/de/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/).
- **Das ersetzt FluentValidation nicht in jedem Fall.** `DataAnnotations` plus `IValidatableObject` deckt die große Mehrheit der Request-Validierung ab. Wenn Sie eine Regel-Engine, asynchrone Regeln mit Datenbankzugriff oder eine große bestehende FluentValidation-Investition haben, behalten Sie diese. Die eingebaute Funktion ist für "ich will einfach, dass `[Required]` tatsächlich etwas tut" ohne eine Abhängigkeit.
- **Der Handler wird bei Fehlschlag übersprungen, sodass Ihre `TypedResults`-Union keinen `BadRequest`-Zweig für die Validierung braucht.** Das `400` wird vom Filter erzeugt, bevor Ihr Handler zurückkehrt, sodass ein Handler vom Typ `Results<Created<T>, NotFound>` in Ordnung ist; Validierungsfehler erreichen ihn nie. Das 400 ProblemDetails wird unabhängig von Ihren deklarierten Rückgabetypen erzeugt.
- **DI-Fehler zur Auflösungszeit sind unabhängig.** Wirft ein Endpoint beim Aktivieren eines Service statt beim Validieren der Eingabe, ist das ein völlig anderer Fehler; siehe [Unable to resolve service for type while attempting to activate](/de/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/) dafür.

Das mentale Modell, das Sie mitnehmen sollten: Minimal-API-Validierung in .NET 11 sind die `DataAnnotations`, die Sie bereits kennen, durch einen Source Generator zur Kompilierzeit automatisch gemacht und über einen Filter pro Endpoint freigelegt, der Standard-`ProblemDetails` zurückgibt. Sie annotieren, Sie rufen `AddValidation()` auf, und ungültige Anfragen werden an der Tür gestoppt. Da sie generatorbasiert statt reflexionsbasiert ist, bleibt sie Trimming und Native AOT aus dem Weg, und genau deshalb wird sie [trim-sicher mit dem Native-AOT-Minimal-API-Stack](/de/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) ausgeliefert. Für alles, was der Filter nicht abfängt, sichert ein [globaler Exception-Filter](/de/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) den Rest der Request-Pipeline ab.

## Verwandt

- [Minimal APIs vs Controller in ASP.NET Core 11](/de/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) für die grundsätzliche Wahl zwischen den beiden Endpoint-Modellen.
- [Minimal-API-Endpoints mit MapGroup in ASP.NET Core 11 organisieren](/de/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) dazu, wo der Validierungsfilter relativ zu den Gruppenfiltern sitzt.
- [Native AOT mit ASP.NET Core Minimal APIs verwenden](/de/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) dazu, warum ein generatorbasierter Validator unter Trimming wichtig ist.
- [Einen globalen Exception-Filter in ASP.NET Core 11 hinzufügen](/de/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) um alles abzufangen, was die Validierung nicht abfängt.
- [Fix: Unable to resolve service for type while attempting to activate](/de/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/) für Aktivierungsfehler, die wie Validierungsfehler aussehen, aber keine sind.

## Quellen

- Microsoft Learn, [What's new in ASP.NET Core in .NET 10](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-10.0?view=aspnetcore-10.0) (Validierungsunterstützung für Minimal APIs, `AddValidation`, `[ValidatableType]`, `DisableValidation`).
- Microsoft Learn, [System.ComponentModel.DataAnnotations namespace](https://learn.microsoft.com/en-us/dotnet/api/system.componentmodel.dataannotations) (`ValidationAttribute`, `IValidatableObject`, `ValidationResult`).
- Tim Deschryver, [ASP.NET 10: Validating incoming models in Minimal APIs](https://timdeschryver.dev/blog/aspnet-10-validating-incoming-models-in-minimal-apis) (Validierung verschachtelter Objekte, Form der Fehlerantwort).
