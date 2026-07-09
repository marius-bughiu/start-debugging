---
title: "Eine Minimal API von manuellen Validierungsprüfungen zur integrierten Validierung in ASP.NET Core 11 migrieren"
description: "Eine Schritt-für-Schritt-Anleitung, um handgeschriebene if-Prüfungen in den Handlern einer ASP.NET-Core-11-Minimal-API durch den integrierten, quellcodegenerierten DataAnnotations-Validator zu ersetzen: was bricht, welche manuellen Regeln portierbar sind und welche nicht, und wie Sie prüfen, dass der 400-ProblemDetails-Vertrag identisch bleibt."
pubDate: 2026-07-09
updatedDate: 2026-07-09
template: migration
tags:
  - "migration"
  - "aspnetcore"
  - "dotnet-11"
  - "minimal-apis"
  - "validation"
lang: "de"
translationOf: "2026/07/migrate-a-minimal-api-from-manual-validation-to-built-in-validation-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-09
---

Wenn Ihre ASP.NET-Core-Minimal-API älter als .NET 10 ist, beginnt vermutlich jeder Handler mit einem Block aus `if (string.IsNullOrWhiteSpace(...)) return Results.BadRequest(...)`-Prüfungen. Diese Migration ersetzt jene handgeschriebenen Prüfungen durch die integrierte Validierung, die in .NET 10 eingeführt wurde und in .NET 11 unverändert bleibt: Rufen Sie `builder.Services.AddValidation()` auf, verschieben Sie die Regeln als `DataAnnotations`-Attribute auf Ihre Request-Records und löschen Sie die manuellen Wächter. Für einen typischen Dienst mit 15 bis 40 Endpunkten rechnen Sie mit einem halben bis einem Tag mechanischer Arbeit. Was bricht, ist nicht das Framework, sondern Ihre Annahmen: Einige Ihrer manuellen Regeln taten Dinge, die Attribute nicht ausdrücken können (asynchrone Abfragen, dienstübergreifende Prüfungen), und die Form Ihrer Fehlerantwort kann sich verschieben, wenn Sie `BadRequest`-Payloads von Hand gebaut haben, statt `ProblemDetails` zurückzugeben. Die Migration lohnt sich, weil sie Code löscht, die Validierung deklarativ und wiederverwendbar macht und unter Native AOT trim-sicher bleibt. Sie ist außerdem Endpunkt für Endpunkt umkehrbar, sodass Sie sie inkrementell durchführen können. Alles Folgende zielt auf .NET 11 mit `Microsoft.NET.Sdk.Web` und C# 14; das Feature ist identisch in .NET 10, wo es zuerst erschien.

## Warum von manuellen Prüfungen weggehen

Das manuelle Muster funktioniert, daher geht es beim Argument für eine Migration um Wartbarkeit und Korrektheit, nicht um "der alte Weg ist kaputt":

- **Sie löschen Code und die Regeln werden deklarativ.** Ein `[Required, Length(3, 20)] string Sku` auf dem Record ersetzt drei Zeilen imperativer Prüfung in jedem Handler, der ein `Sku` annimmt. Schreiben Sie die Einschränkung einmal, direkt bei den Daten.
- **Sie geben keine inkonsistenten Fehlerformen mehr zurück.** Ein handgeschriebenes `Results.BadRequest("Sku is required")` gibt an einem Endpunkt eine reine Zeichenkette zurück und an einem anderen ein JSON-Objekt, je nachdem, wer es geschrieben hat. Der integrierte Validator gibt überall einen `HttpValidationProblemDetails`-Body (RFC 9457) zurück, mit dem Eigenschaftsnamen als Schlüssel.
- **Die Validierung bleibt trim-sicher.** Das Feature ist ein Source Generator zur Kompilierzeit, keine Reflexion zur Laufzeit, daher wird es unter Native AOT und aggressivem Trimming sauber veröffentlicht, aus demselben Grund, aus dem es dem [Native-AOT-Minimal-API-Stack](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) beiliegt.
- **Query-, Routen- und Header-Parameter werden ebenfalls validiert.** Manuelle Prüfungen decken fast immer den JSON-Body ab und vergessen die Paging-Parameter. Der integrierte Filter validiert die aus Route und Query-String gebundenen skalaren Parameter mit denselben Attributen.

## Was bricht

Das Framework selbst bricht nicht, aber diese fünf Dinge ändern sich, und Sie müssen wissen, welche Ihrer manuellen Regeln die Portierung überleben:

| Bereich                            | Änderung                                                                                            | Schweregrad |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- | ----------- |
| Fehlerantwort-Body                 | Reine Zeichenketten- oder benutzerdefinierte `BadRequest(...)`-Bodys werden zu `ProblemDetails` (RFC 9457) mit Eigenschaft als Schlüssel | hoch        |
| Asynchrone / DB-Regeln             | `if (await repo.SkuExists(...))` kann kein Attribut werden; braucht ein anderes Zuhause              | hoch        |
| Zugreifbarkeit des Request-Typs    | Der Record muss `public` sein, sonst gibt der Generator nichts aus und die Validierung läuft still nicht | hoch        |
| Feldübergreifende Regeln           | `if`-Blöcke über mehrere Eigenschaften wandern zu `IValidatableObject`, nicht zu Attributen         | mittel      |
| Tests, die auf Fehlertext prüfen   | Tests, die auf Ihre alten benutzerdefinierten Nachrichten-Strings prüfen, scheitern am neuen `ProblemDetails` | mittel      |
| Rückgabetyp des Handlers           | Handler können ihren `BadRequest`-Zweig entfernen; der Filter erzeugt den 400, bevor der Handler läuft | niedrig     |

Die beiden Zeilen mit hohem Schweregrad, die die Form Ihrer Migration bestimmen, sind der Fehler-Body und die asynchronen Regeln. Wenn Clients Ihren aktuellen 400-Body parsen, planen Sie eine Vertragsänderung oder eine Kompatibilitätsschicht. Wenn irgendeine manuelle Prüfung auf E/A wartet, wird diese Regel überhaupt kein Attribut, und das Gegenteil anzunehmen ist die häufigste Art, wie diese Migration schiefgeht.

## Vorabprüfliste

Bevor Sie einen Handler anfassen:

- **SDK.** Installieren Sie das .NET-10- oder -11-SDK. Bestätigen Sie mit `dotnet --version` (erwarten Sie `11.0.x` oder `10.0.x`).
- **Web SDK.** Das Projekt muss `Microsoft.NET.Sdk.Web` verwenden. Der Validierungs-Source-Generator wird von diesem SDK verdrahtet, sobald Sie `AddValidation()` aufrufen.
- **Grundlinie des aktuellen Vertrags erfassen.** Erfassen Sie die exakten 400-Antworten, die Ihre Endpunkte heute zurückgeben (ein paar in Dateien gespeicherte `curl`-Aufrufe oder ein Snapshot-Test). Sie sind dabei, diese Form zu ändern, und wollen ein Vorher-Bild.
- **Die Oberfläche per grep finden.** Finden Sie jede manuelle Prüfung, um den Fortschritt zu verfolgen: `grep -rn "return Results.BadRequest\|return TypedResults.BadRequest" src/`. Diese Liste ist Ihr Migrations-Backlog.
- **Asynchrone Prüfungen inventarisieren.** Separat: `grep -rn "await" src/` innerhalb Ihrer Handler und markieren Sie jene, die ein `BadRequest` steuern. Das sind die Regeln, die keine Attribute werden.
- **Eine Testsuite oder ein Smoke-Skript bereithalten.** Sie wollen nach jedem Endpunkt etwas ausführen, um zu bestätigen, dass gültige Anfragen weiterhin durchgehen und ungültige weiterhin 400 liefern.

## Migrationsschritte

### 1. Integrierte Validierung einschalten

Registrieren Sie die Dienste, bevor Sie die App bauen. Dies ist die einzige globale Verdrahtung, die die Migration benötigt.

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddValidation();   // registers the validation services and endpoint filter
var app = builder.Build();
```

Mit dem aktuellen .NET-10- oder -11-Web-SDK ist der Source Generator automatisch aktiv, sobald `AddValidation()` vorhanden ist. Wenn Sie ein getrimmtes `.csproj` kopiert haben oder Ihr Build vor der GA liegt, fügen Sie den Interceptor-Namespace explizit hinzu:

```xml
<!-- only needed if the generator's interceptors are not picked up automatically -->
<PropertyGroup>
  <InterceptorsNamespaces>$(InterceptorsNamespaces);Microsoft.AspNetCore.Http.Validation.Generated</InterceptorsNamespaces>
</PropertyGroup>
```

**Prüfen:** Die App baut und startet weiterhin. `dotnet build` meldet null Fehler. Es hat sich noch kein Verhalten geändert, weil keiner Ihrer Typen Attribute trägt.

### 2. Feldbezogene Regeln auf den Request-Record verschieben

Nehmen Sie einen Endpunkt. Lesen Sie seine manuellen Prüfungen und übersetzen Sie jede als Attribut ausdrückbare Regel in ein `DataAnnotations`-Attribut auf dem Request-Typ. Hier das Vorher, ein Handler, der seine Validierung inline trägt:

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

Und das Nachher: Die Regeln wandern als Attribute auf den Record, der Handler verliert seinen Wächterblock, und der Typ wird `public`, damit der Generator ihn sehen kann.

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

Beachten Sie, dass der Typ `public` wurde. Dies ist der häufigste Grund, warum ein migrierter Endpunkt still aufhört zu validieren: Der Generator kann nur Code für Typen ausgeben, die er benennen kann, sodass ein `record`, der in der standardmäßigen dateiinternen Zugreifbarkeit belassen wird, keine Validierung und keinen Fehler erhält.

**Prüfen:** `curl -i -X POST .../products -d '{"sku":"x","name":"","quantity":0}'` gibt `400` mit einem `ProblemDetails`-Body zurück, der `Sku`, `Name` und `Quantity` auflistet. Ein gültiger Body gibt weiterhin `201` zurück.

### 3. Feldübergreifende Regeln zu IValidatableObject verschieben

Attribute validieren jeweils ein Mitglied. Jede manuelle Prüfung, die zwei Felder verglich ("Ende nach Anfang", "Rabatt erfordert einen Grund"), wird kein Attribut. Implementieren Sie stattdessen `IValidatableObject` auf dem Request-Record:

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

Das Array von Mitgliedsnamen, das Sie als zweites Argument übergeben, steuert, unter welchem Schlüssel der Fehler landet, übergeben Sie also das Feld, das Ihre UI hervorheben soll. `Validate` läuft nach den Attributprüfungen, sodass ein `null`-`Start` bereits von `[Required]` gemeldet wird, bevor Ihre feldübergreifende Logik läuft.

**Prüfen:** Posten Sie einen Bereich, in dem `End <= Start`, und bestätigen Sie, dass der Fehlerschlüssel `End` ist, nicht ein leerer Schlüssel auf Modellebene.

### 4. Die asynchronen und dienstübergreifenden Prüfungen umsiedeln

Dies ist der Schritt, in den das Migrations-Backlog aus Ihrem vorangegangenen `await`-grep einfließt. Eine Regel wie "ablehnen, wenn das SKU bereits im Katalog existiert" trifft die Datenbank, und weder `DataAnnotations` noch `IValidatableObject` können warten. Sie haben zwei ehrliche Optionen:

Behalten Sie diese spezifische Prüfung als expliziten Aufruf innerhalb des Handlers, nachdem der integrierte Validator die Form bereits als gültig garantiert hat:

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

Oder, wenn Sie viele asynchrone Regeln haben, behalten Sie FluentValidation genau für diese Request-Typen und lassen Sie das integrierte Feature die einfachen übernehmen. Die Abwägungen sind in [Minimal-API-Validierung vs FluentValidation](/2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11/) dargelegt; die Kurzfassung ist, dass asynchrone Regeln und reiche bedingte Logik die zwei Gründe sind, eine Validierungsbibliothek zu behalten. Versuchen Sie nicht, einen `DbContext`-Aufruf in ein `IValidatableObject` zu zwingen; es ist synchron und wird entweder einen Thread blockieren oder Sie in das Deadlock-Gebiet mit `.Result` treiben.

**Prüfen:** Die Eindeutigkeitsprüfung lehnt weiterhin ein doppeltes SKU ab (jetzt als `409` oder welchen Status Sie wählen), und ein erstmaliges SKU ist weiterhin erfolgreich.

### 5. Eine Regel mit einem benutzerdefinierten ValidationAttribute wiederverwenden

Wenn dieselbe manuelle Prüfung in drei Handlern auftauchte ("dieses Datum darf nicht in der Vergangenheit liegen"), kopieren Sie kein `IValidatableObject` in drei Records. Schreiben Sie ein `ValidationAttribute`, und der Generator greift es auf wie jedes eingebaute:

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

Dies ist die attributbasierte Antwort auf duplizierte `if`-Blöcke: Die Regel lebt einmal und gilt überall dort, wo der Typ verwendet wird.

**Prüfen:** Ein Endpunkt, der zuvor dieselbe Datumsprüfung wiederholte, lehnt nun ein vergangenes Datum mit dem Attribut ab, und die anderen Endpunkte, die sich den Typ teilen, erben die Regel.

### 6. Toten Wächtercode löschen und Rückgabetypen vereinfachen

Sobald die Regeln eines Endpunkts deklarativ sind, entfernen Sie den manuellen `if`-Block vollständig und vereinfachen Sie den deklarierten Rückgabetyp des Handlers. Da der 400 vom Endpunkt-Filter erzeugt wird, bevor der Handler-Body läuft, braucht ein Handler keinen `BadRequest`-Zweig mehr in seiner `Results<...>`-Union:

```csharp
// .NET 11, C# 14 -- return type no longer needs BadRequest
app.MapPost("/products", (CreateProduct product)
    => TypedResults.Created($"/products/{product.Sku}", product))
   .Produces<CreateProduct>(StatusCodes.Status201Created)
   .ProducesValidationProblem();   // documents the 400 the filter produces
```

**Prüfen:** OpenAPI bewirbt weiterhin den `400` (über `ProducesValidationProblem`), und der Endpunkt kompiliert ohne den entfernten Union-Zweig.

## Verifikation

Nachdem Sie eine Charge von Endpunkten migriert haben, gehen Sie diese Liste durch, bevor Sie es für erledigt erklären:

- **Es baut.** `dotnet build` meldet null Warnungen und null Fehler. Achten Sie speziell darauf, dass nichts kommt, denn ein Typ, dem `public` fehlt, scheitert still, nicht laut. Das fängt der nächste Punkt ab.
- **Jeder migrierte Endpunkt validiert tatsächlich.** Führen Sie Ihre `curl`-Aufrufe für ungültige Anfragen (oder Tests) erneut gegen jeden migrierten Endpunkt aus. Ein Endpunkt, der `201` für einen Body zurückgibt, den Sie als abgelehnt erwarten, bedeutet, dass der Generator den Typ nicht gesehen hat; prüfen Sie zuerst den Zugriffsmodifikator.
- **Gültige Anfragen gehen weiterhin durch.** Bestätigen Sie, dass der Erfolgspfad denselben Erfolgsstatus wie zuvor zurückgibt.
- **Der Fehlervertrag ist das, was Clients erwarten.** Vergleichen Sie den neuen `ProblemDetails`-Body mit Ihrer Vorher-Grundlinie. Wenn ein Client das `errors`-Dictionary parst, bestätigen Sie, dass die Schlüssel mit den erwarteten Eigenschaftsnamen übereinstimmen.
- **Die Testsuite ist grün.** `dotnet test` besteht. Tests, die auf Ihre alten benutzerdefinierten Fehler-Strings prüften, scheitern erwartungsgemäß; aktualisieren Sie sie so, dass sie auf die `ProblemDetails`-Form prüfen, statt die Migration rückgängig zu machen.
- **Keine Leistungsregression beim Start.** Da das Feature quellcodegeneriert ist, sollte der Start flach oder leicht schneller sein (Sie haben Code entfernt). Wenn Sie FluentValidation für einige Typen behalten haben, gilt dessen Ausdruckskompilierung beim ersten Gebrauch weiterhin für diese Typen.

## Rollback-Plan

Diese Migration ist umkehrbar und, besser noch, inkrementell, sodass Sie selten einen vollständigen Rollback brauchen. Zwei Ebenen:

- **Pro Endpunkt, ohne Code zurückzunehmen.** Wenn sich ein migrierter Endpunkt in der Produktion falsch verhält, verketten Sie `DisableValidation()` an ihm, um den Filter für diese Route abzuschalten, während Sie die globale Registrierung und jeden anderen validierten Endpunkt behalten:

  ```csharp
  // .NET 11, C# 14 -- disable validation on a single endpoint
  app.MapPost("/internal/import", (CreateProduct product)
      => TypedResults.Accepted($"/products/{product.Sku}", product))
     .DisableValidation();
  ```

- **Vollständiger Rückbau.** Da Sie Endpunkt für Endpunkt migriert haben, ist der Diff jedes Endpunkts in sich geschlossen: Stellen Sie seinen manuellen `if`-Block wieder her und entfernen Sie die Attribute vom Record, wenn kein anderer Endpunkt darauf angewiesen ist. Das Entfernen des globalen `AddValidation()`-Aufrufs schaltet das Feature vollständig ab, ohne jede andere Codeänderung. Nichts an dieser Migration ist auf Framework-Ebene ein Einbahnstraße.

## Stolpersteine, die uns begegnet sind

Reale Probleme, die Zeit gekostet haben, und ihre Lösungen:

- **Der stille No-op eines nicht-`public`-Typs.** Bei Weitem der häufigste. Sie verschieben die Attribute auf ein `record CreateProduct(...)`, der Build gelingt, und die Validierung feuert nie, weil der Typ nicht `public` ist. Es gibt keine Warnung. Wenn ein migrierter Endpunkt aufhört, schlechte Eingaben abzulehnen, prüfen Sie den Zugriffsmodifikator zuerst.
- **Attributziele bei positionalen Records.** Bei einem positionalen Record wird `[Required] string Name` direkt vom Validierungsgenerator gelesen. Sie brauchen das explizite Ziel `[property: Required] string Name` nur, wenn ein anderes Werkzeug zur Laufzeit über die generierte Eigenschaft reflektiert. Das Vermischen der beiden Erwartungen ist eine häufige Quelle von Verwirrung der Art "warum wird dieses Attribut ignoriert".
- **Verschachtelte Objekte validieren rekursiv, was Sie überraschen kann.** Wenn ein Request-Record einen `BillingAddress`-Record referenziert, validiert der Generator auch die Adresse, und die Fehlerschlüssel verwenden einen Punktpfad wie `Billing.PostalCode`. Wenn Ihr alter manueller Code nur das oberste Objekt prüfte, erhalten Sie nun möglicherweise 400 bei verschachtelten Feldern, die Sie zuvor nie validiert haben. Das ist meist korrekt, aber eine zu erwartende Verhaltensänderung.
- **Filterreihenfolge.** Die Validierung läuft als Filter pro Endpunkt. Wenn Sie bereits eigene `AddEndpointFilter`-Aufrufe hinzufügen, wissen Sie, wo die Validierung in der Kette sitzt, besonders über Routengruppen hinweg; die Kompositionsregeln sind dieselben wie in [Minimal-API-Endpunkte mit MapGroup organisieren](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/).
- **Ändern Sie den Fehlervertrag nicht versehentlich still.** Wenn Sie wollen, dass die migrierten `ProblemDetails` einer bestimmten Form entsprechen (einer benutzerdefinierten `type`-URI, zusätzlichen Mitgliedern), formen Sie sie zentral statt pro Endpunkt; die Mechanik steht in [Minimal-API-Validierungsfehlerantworten mit IProblemDetailsService anpassen](/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/).

Das mentale Modell zum Mitnehmen: Diese Migration ist nicht die Übernahme eines neuen Frameworks, sie ist das Löschen imperativen Wächtercodes und das erneute Ausdrücken derselben Regeln deklarativ auf Ihren Request-Typen. Die als Attribut ausdrückbaren Regeln wandern zu `DataAnnotations`, die feldübergreifenden zu `IValidatableObject`, die wiederverwendbaren zu einem benutzerdefinierten `ValidationAttribute`, und die asynchronen bleiben explizit im Handler, nachdem die Form bereits als gültig garantiert ist. Machen Sie es Endpunkt für Endpunkt, prüfen Sie jeden mit dem Aufruf der ungültigen Anfrage, und der `if`-Block-Boilerplate, der jeden Handler eröffnete, verschwindet einfach.

## Verwandtes

- [Wie man Request-Bodys in Minimal APIs ohne Controller in ASP.NET Core 11 validiert](/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/) für die vollständige Einrichtung des integrierten Features, zu dem Sie migrieren.
- [Minimal-API-Validierung vs FluentValidation in ASP.NET Core 11](/2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11/) für die Entscheidung, was in einer Validierungsbibliothek zu behalten und was in die Box zu verschieben ist.
- [Wie man Minimal-API-Validierungsfehlerantworten mit IProblemDetailsService in ASP.NET Core 11 anpasst](/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/) für das Formen des 400-Bodys nach der Migration.
- [Minimal APIs vs Controller in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) für die Endpunktmodell-Entscheidung, die dieser zugrunde liegt.
- [Wie man Minimal-API-Endpunkte mit MapGroup in ASP.NET Core 11 organisiert](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) dafür, wo der Validierungsfilter relativ zu Gruppenfiltern sitzt.

## Quellen

- Microsoft Learn, [What's new in ASP.NET Core in .NET 10](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-10.0?view=aspnetcore-10.0) (integrierte Minimal-API-Validierung, `AddValidation`, Source Generator, `DisableValidation`, `ProblemDetails`).
- Microsoft Learn, [System.ComponentModel.DataAnnotations namespace](https://learn.microsoft.com/en-us/dotnet/api/system.componentmodel.dataannotations) (`ValidationAttribute`, `IValidatableObject`, `ValidationResult`).
- Tim Deschryver, [ASP.NET 10: Validating incoming models in Minimal APIs](https://timdeschryver.dev/blog/aspnet-10-validating-incoming-models-in-minimal-apis) (Validierung verschachtelter Objekte, Generator-Erkennung, Fehlerform).
