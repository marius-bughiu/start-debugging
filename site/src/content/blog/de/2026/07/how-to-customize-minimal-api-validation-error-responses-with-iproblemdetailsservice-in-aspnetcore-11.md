---
title: "Validierungsfehler-Antworten in Minimal APIs mit IProblemDetailsService in ASP.NET Core 11 anpassen"
description: "Rufen Sie AddProblemDetails mit einem CustomizeProblemDetails-Callback auf, um die 400 umzuformen, die die integrierte Minimal-API-Validierung in ASP.NET Core 11 zurückgibt: fügen Sie eine traceId hinzu, schreiben Sie den title um, wechseln Sie von 400 zu 422 oder übernehmen Sie mit einem eigenen IProblemDetailsWriter die volle Kontrolle."
pubDate: 2026-07-03
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-apis"
  - "validation"
lang: "de"
translationOf: "2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-03
---

Die integrierte Minimal-API-Validierung liefert Ihnen kostenlos einen `400 Bad Request` mit einem `HttpValidationProblemDetails`-Body, aber die zurückgegebene Form ist der Framework-Standard: ein RFC-9457-Payload mit `type`, `title`, `status` und einem `errors`-Dictionary. Wenn Sie eine `traceId` für Support-Tickets, einen anderen `title`, einen Link zu Ihrer Fehlerdokumentation oder eine `422 Unprocessable Entity` statt einer `400` benötigen, ist der Einstiegspunkt `AddProblemDetails(options => options.CustomizeProblemDetails = ...)`. Registrieren Sie ihn, und derselbe Callback wird bei Validierungsfehlern, nicht behandelten Ausnahmen und Statuscode-Seiten gleichermaßen ausgelöst, sodass jeder Fehler, den Ihre API ausgibt, dieselben Felder trägt. Das ist der Baustein, der in den frühen .NET-10-Previews fehlte und in .NET 10 GA sowie .NET 11 verdrahtet ist: der integrierte Validierungsfilter leitet seine Problem Details jetzt durch `IProblemDetailsService`, sodass Ihre Anpassung Validierungsfehler tatsächlich erreicht. Alles Folgende zielt auf .NET 11 mit `Microsoft.NET.Sdk.Web` und C# 14; das Verhalten ist auf .NET 10 GA identisch.

## Wie die Standard-Validierungsantwort aussieht

Beginnen Sie mit dem Setup, das in [Wie man Request-Bodies in Minimal APIs ohne Controller validiert](/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/) behandelt wird: rufen Sie `AddValidation()` auf, annotieren Sie einen Request-Record und lassen Sie den Source Generator die Arbeit erledigen.

```csharp
// .NET 11, C# 14 -- Program.cs
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

Senden Sie einen ungültigen Body per POST, und Sie erhalten den Standard-Payload:

```json
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json

{
  "type": "https://tools.ietf.org/html/rfc9110#section-15.5.1",
  "title": "One or more validation errors occurred.",
  "status": 400,
  "errors": {
    "Sku": ["The field Sku must be a string with a minimum length of 3 and a maximum length of 20."],
    "Name": ["The Name field is required."]
  }
}
```

Das ist korrekt und maschinenlesbar, aber es sagt nichts über Ihren Dienst aus. Es gibt keine Korrelations-ID, die man in einen Fehlerbericht einfügen könnte, der `type` verweist auf den RFC statt auf Ihren eigenen Fehlerkatalog, und Clients, die `422` als "semantisch ungültig, nicht erneut versuchen" behandeln, erhalten eine `400`, die sie nicht von einer fehlerhaften Anfrage unterscheiden können. Die Anpassung behebt all das an einer einzigen Stelle.

## Den Anpassungs-Hook aktivieren

`AddProblemDetails()` registriert den standardmäßigen `IProblemDetailsService`, und seine Überladung nimmt eine `ProblemDetailsOptions`-Konfiguration entgegen, in der Sie `CustomizeProblemDetails` setzen. Diese Eigenschaft ist ein Delegate, der einen `ProblemDetailsContext` empfängt, der sowohl den `HttpContext` als auch die veränderbaren `ProblemDetails` freilegt, die geschrieben werden sollen.

1. **Registrieren Sie Problem Details mit dem Callback.** Rufen Sie `builder.Services.AddProblemDetails(options => options.CustomizeProblemDetails = ctx => { ... })` vor `builder.Build()` auf.
2. **Behalten Sie auch `AddValidation()`.** Die beiden Dienste sind unabhängig: `AddValidation()` erzeugt die `400`, `AddProblemDetails()` passt den Body an, den sie trägt.
3. **Verändern Sie `ctx.ProblemDetails` innerhalb des Callbacks.** Fügen Sie zu `Extensions` hinzu, schreiben Sie `Title`, `Type` oder `Detail` um oder ändern Sie `Status`.

Hier ist die Verdrahtung, die jedem Validierungsfehler eine Korrelations-ID und einen Support-Verweis hinzufügt:

```csharp
// .NET 11, C# 14 -- Program.cs
using System.Diagnostics;
using System.ComponentModel.DataAnnotations;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddValidation();
builder.Services.AddProblemDetails(options =>
{
    options.CustomizeProblemDetails = ctx =>
    {
        // Correlate with distributed tracing; fall back to the request id.
        ctx.ProblemDetails.Extensions["traceId"] =
            Activity.Current?.Id ?? ctx.HttpContext.TraceIdentifier;

        if (ctx.ProblemDetails.Status == StatusCodes.Status400BadRequest)
        {
            ctx.ProblemDetails.Title = "Your request failed validation.";
            ctx.ProblemDetails.Type = "https://api.example.com/errors/validation";
            ctx.ProblemDetails.Extensions["support"] = "support@example.com";
        }
    };
});
var app = builder.Build();

app.MapPost("/products", (CreateProduct product) =>
    TypedResults.Created($"/products/{product.Sku}", product));

app.Run();

public record CreateProduct(
    [Required, Length(3, 20)] string Sku,
    [Required, MinLength(2)] string Name,
    [Range(1, 10_000)] int Quantity);
```

Derselbe ungültige POST gibt jetzt zurück:

```json
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json

{
  "type": "https://api.example.com/errors/validation",
  "title": "Your request failed validation.",
  "status": 400,
  "errors": {
    "Sku": ["The field Sku must be a string with a minimum length of 3 and a maximum length of 20."],
    "Name": ["The Name field is required."]
  },
  "traceId": "00-2f0e...-b7ad...-01",
  "support": "support@example.com"
}
```

Das `errors`-Dictionary bleibt unangetastet, sodass bestehende Clients es weiterhin parsen können. Sie haben Felder hinzugefügt, ohne den Vertrag zu brechen. Beachten Sie die `traceId`: ziehen Sie sie aus `Activity.Current?.Id` statt aus einer frischen `Guid.NewGuid()`, denn dieser Wert ist die tatsächliche W3C-Trace-ID, die durch Ihre Logs und OpenTelemetry-Spans fließt. Eine zufällige GUID sieht aus wie eine Trace-ID, korreliert aber mit nichts. Der Rückgriff auf `HttpContext.TraceIdentifier` deckt Anfragen ab, die ohne Trace-Kontext eintreffen.

## Warum der Callback jeden Fehler erreicht, nicht nur die Validierung

Der Grund, `CustomizeProblemDetails` dem manuellen Editieren jedes Endpunkts vorzuziehen, ist die Abdeckung. Wenn `AddProblemDetails()` registriert ist, läuft der Callback für Problem Details, die von der Fehlermaschinerie des Frameworks erzeugt werden: die `ExceptionHandlerMiddleware`, die `StatusCodePagesMiddleware`, die Entwickler-Ausnahmeseite und, seit .NET 10 GA, der integrierte Minimal-API-Validierungsfilter. Ein Callback, und Ihre `traceId` landet auf einer `400` aus der Validierung, einer `404` aus einer nicht zugeordneten Route und einer `500` aus einer nicht behandelten Ausnahme. Diese Konsistenz ist der ganze Sinn des Problem-Details-Vertrags: ein Client sollte in der Lage sein, `traceId` aus jedem Fehler auszulesen, den Ihre API zurückgibt, ohne einen Sonderfall dafür machen zu müssen, welche Schicht ihn erzeugt hat.

Um neben der Validierung auch die Fälle `404` und `500` zu erhalten, registrieren Sie die beiden Middleware, die leere Fehlerantworten füllen:

```csharp
// .NET 11, C# 14
app.UseExceptionHandler();   // turns unhandled exceptions into ProblemDetails
app.UseStatusCodePages();    // fills empty 4xx/5xx responses with ProblemDetails
app.Run();
```

Ohne diese gibt ein nacktes `Results.NotFound()` oder eine nicht zugeordnete Route einen leeren Body zurück, weil Problem Details nur "for responses that do not have body content yet" erzeugt werden. Die Validierung ist die Ausnahme, die diese Verdrahtung nicht benötigt: der Validierungsfilter selbst ruft `IProblemDetailsService` auf, sodass seine `400` angepasst wird, unabhängig davon, ob Sie `UseStatusCodePages()` hinzufügen oder nicht. Wenn Sie außerdem möchten, dass Ihr globaler Rückhalt abfängt, was die Validierung nicht abfängt, wird die Mechanik des Ausnahmepfads in [Wie man einen globalen Exception-Filter in ASP.NET Core 11 hinzufügt](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) behandelt.

## Statt 400 eine 422 für die Validierung zurückgeben

Eine gängige API-Design-Entscheidung ist die Unterscheidung zwischen "Ich konnte Ihre Anfrage nicht parsen" (`400`) und "Ich habe sie geparst, aber sie verletzt die Regeln" (`422 Unprocessable Entity`). Da der Callback `Status` verändern kann und die Middleware den Status aus den `ProblemDetails` schreibt, können Sie Validierungsfehler an einer einzigen Stelle zu `422` hochstufen:

```csharp
// .NET 11, C# 14
builder.Services.AddProblemDetails(options =>
{
    options.CustomizeProblemDetails = ctx =>
    {
        // Built-in validation always produces a 400 with an errors dictionary.
        if (ctx.ProblemDetails.Status == StatusCodes.Status400BadRequest
            && ctx.ProblemDetails.Extensions.ContainsKey("errors"))
        {
            ctx.ProblemDetails.Status = StatusCodes.Status422UnprocessableEntity;
            ctx.HttpContext.Response.StatusCode =
                StatusCodes.Status422UnprocessableEntity;
        }
    };
});
```

Setzen Sie sowohl das Feld `ProblemDetails.Status` (das, was im JSON-Body erscheint) als auch `HttpContext.Response.StatusCode` (die tatsächliche HTTP-Statuszeile). Vergessen Sie das zweite, und Sie liefern einen Body, der `422` behauptet, auf einer HTTP-`400`-Antwort aus, was schlimmer ist als jedes von beiden allein. Die Prüfung des `errors`-Schlüssels grenzt die Umschreibung speziell auf Validierungsfehler ein, sodass eine einfache `400` von anderswo in Ihrer App ihren Status behält.

## Volle Kontrolle mit einem eigenen IProblemDetailsWriter übernehmen

`CustomizeProblemDetails` verändert das Objekt; es steuert weder die Serialisierung noch entscheidet es, wann geschrieben wird. Dafür implementieren Sie `IProblemDetailsWriter`. Ein Writer erhält ein `CanWrite`-Gate und ein `WriteAsync`, das den Response-Body besitzt, was Ihnen erlaubt, nach Statuscode, Content Negotiation oder Endpunkt-Metadaten zu verzweigen:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Http;

public sealed class ValidationProblemDetailsWriter : IProblemDetailsWriter
{
    public bool CanWrite(ProblemDetailsContext context)
        => context.ProblemDetails.Status is 400 or 422;

    public ValueTask WriteAsync(ProblemDetailsContext context)
    {
        context.ProblemDetails.Extensions["apiVersion"] = "2026-07";
        return new ValueTask(
            context.HttpContext.Response.WriteAsJsonAsync(
                context.ProblemDetails,
                context.ProblemDetails.GetType(),
                options: null,
                contentType: "application/problem+json"));
    }
}
```

Registrieren Sie ihn in der DI und registrieren Sie ihn vor `AddControllers()` oder `AddRazorPages()`, falls Sie eines von beiden verwenden, denn diese registrieren ihre eigenen Writer, und die Reihenfolge entscheidet, welcher gewinnt:

```csharp
// .NET 11, C# 14
builder.Services.AddTransient<IProblemDetailsWriter, ValidationProblemDetailsWriter>();
```

Greifen Sie nur dann zu einem Writer, wenn der Callback nicht ausreicht: unterschiedliche Serialisierung für unterschiedliche Clients, XML neben JSON oder das Ausgeben eines völlig anderen Schemas für einen Statuscode. Zum Hinzufügen von Feldern und Anpassen von Text ist `CustomizeProblemDetails` weniger Code und weniger, das man falsch machen kann.

## Einen einzelnen Endpunkt statt der gesamten App anpassen

Alles Vorherige ist global. Wenn Sie die Validierungsantwort eines einzelnen Endpunkts anders formen möchten, geben Sie die Problem Details selbst aus dem Handler mit `TypedResults.ValidationProblem` zurück, das ein `extensions`-Dictionary direkt akzeptiert:

```csharp
// .NET 11, C# 14
app.MapPost("/legacy/products", (CreateProduct product) =>
{
    var errors = new Dictionary<string, string[]>();
    if (product.Quantity <= 0)
        errors["Quantity"] = ["Quantity must be positive on the legacy endpoint."];

    if (errors.Count > 0)
        return TypedResults.ValidationProblem(
            errors,
            extensions: new Dictionary<string, object?>
            {
                ["legacy"] = true
            });

    return TypedResults.Created($"/products/{product.Sku}", product);
});
```

Es gibt hier eine scharfe Kante, die klar ausgesprochen werden sollte: eine `ProblemDetails`, die Sie direkt aus einem Handler konstruieren und zurückgeben, sei es über `TypedResults.ValidationProblem`, `Results.Problem` oder `TypedResults.Problem`, wird direkt in die Antwort serialisiert und läuft **nicht** durch `IProblemDetailsService`. Ihr globaler `CustomizeProblemDetails`-Callback wird dafür nicht ausgeführt, sodass die zentral hinzugefügte `traceId` fehlt. Wenn Sie globale Anpassung mit vom Handler zurückgegebenen Problemen mischen, fügen Sie entweder die gemeinsamen Felder auch im Handler hinzu oder belassen die Validierung beim integrierten Filter, der durch den Dienst leitet. Das ist die mit Abstand häufigste Überraschung: der Callback deckt vom Framework erzeugte Problem Details ab, nicht die, die Sie selbst instanziieren.

## Fallstricke, die in der Produktion zuschlagen

- **Der `Accept`-Header steuert, ob Sie überhaupt JSON erhalten.** Der `DefaultProblemDetailsWriter` schreibt für `application/json`, `application/problem+json` und Wildcards wie `*/*` und `application/*`. Ein Client, der `Accept: text/html` oder `application/xml` sendet, löst den Fallback-Pfad aus und erhält keinen Problem-Details-Body. Wenn Ihre Konsumenten Browser oder SOAP-Clients sind, berücksichtigen Sie das, statt anzunehmen, dass das JSON immer geliefert wird.
- **`CustomizeProblemDetails` wurde in frühen .NET-10-Previews nicht für die Validierung aufgerufen.** Dies wurde als [dotnet/aspnetcore#62723](https://github.com/dotnet/aspnetcore/issues/62723) erfasst: der Validierungsfilter umging `IProblemDetailsService`. In .NET 10 GA und .NET 11 ist er durch den Dienst verdrahtet. Wenn Ihr Callback bei Ausnahmen ausgelöst wird, aber Validierungsfehler stillschweigend überspringt, verwenden Sie ein veraltetes Preview-SDK; aktualisieren Sie es.
- **Die Reihenfolge zählt, wenn Sie auch Controller verwenden.** MVC erzeugt Validierungs-Problem-Details über `ProblemDetailsFactory` und `InvalidModelStateResponseFactory`, nicht allein über `CustomizeProblemDetails`. Eine gemischte App mit sowohl Minimal-API-Endpunkten als auch Controllern benötigt beide Pfade konfiguriert, sonst sind sich Ihre Controller und Ihre Minimal APIs über die Fehlerform uneinig.
- **Lassen Sie keine Interna in `Detail` durchsickern.** Es ist verlockend, eine Ausnahmenachricht innerhalb des Callbacks in `ProblemDetails.Detail` zu stopfen. In der Produktion legt das Stack-Trace-Fragmente und interne Typnamen offen. Halten Sie `Detail` client-sicher und legen Sie die Diagnoseinformationen stattdessen hinter Ihrer `traceId` in den Logs ab.
- **Der Callback läuft auf dem Hot Path jedes Fehlers.** Halten Sie ihn günstig. `Activity.Current` zu lesen und Dictionary-Schlüssel zu setzen ist in Ordnung; das Öffnen einer Datenbankverbindung oder das Aufrufen eines Remote-Dienstes innerhalb von `CustomizeProblemDetails` nicht, weil er synchron läuft, während die Antwort geschrieben wird.

Das Modell, das man behalten sollte: `AddValidation()` entscheidet, was ungültig ist, `AddProblemDetails()` entscheidet, wie die Ungültigkeit beschrieben wird, und `CustomizeProblemDetails` ist die eine Stelle, um diese Beschreibung für jeden vom Framework erzeugten Fehler auf einmal zu formen. Fügen Sie Ihre `traceId` dort hinzu, schreiben Sie den `title` dort um, stufen Sie dort zu `422` hoch und greifen Sie nur dann zu einem eigenen `IProblemDetailsWriter`, wenn Sie die Serialisierung selbst besitzen müssen. Für alles, was der Validierungsfilter nicht abfängt, trägt der [globale Exception-Filter](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) dieselbe Anpassung weiter, und falls Sie noch entscheiden, ob der integrierte Validator Ihre Regeln überhaupt abdeckt, zieht [Minimal-API-Validierung vs. FluentValidation](/2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11/) diese Grenze.

## Verwandt

- [Wie man Request-Bodies in Minimal APIs ohne Controller in ASP.NET Core 11 validiert](/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/) für das `AddValidation()`-Setup, das dieser Beitrag anpasst.
- [Minimal-API-Validierung vs. FluentValidation in ASP.NET Core 11](/2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11/) dafür, ob der integrierte Validator zu Ihren Regeln passt, bevor Sie seine Ausgabe anpassen.
- [Wie man einen globalen Exception-Filter in ASP.NET Core 11 hinzufügt](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) für das Abfangen dessen, was die Validierung nicht abfängt, mit derselben `ProblemDetails`-Form.
- [Wie man Minimal-API-Endpunkte mit MapGroup in ASP.NET Core 11 organisiert](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) für das Anwenden von Validierung und ihren Problem Details über eine ganze Routengruppe.
- [Minimal APIs vs. Controller in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) dafür, wie sich die Fehlerbehandlung zwischen den beiden Endpunktmodellen unterscheidet.

## Quellen

- Microsoft Learn, [Handle errors in ASP.NET Core APIs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/error-handling-api?view=aspnetcore-10.0) (`AddProblemDetails`, die Middleware, die Problem Details erzeugen, `CustomizeProblemDetails`, `IProblemDetailsService`-Fallback und unterstützte Medientypen).
- Microsoft Learn, [Create responses in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/responses?view=aspnetcore-10.0) (Anpassen von Minimal-API-Validierungsfehler-Antworten mit `IProblemDetailsService`, `TypedResults.ValidationProblem`).
- Microsoft Learn, [ProblemDetailsOptions.CustomizeProblemDetails](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.problemdetailsoptions.customizeproblemdetails) (Callback-Signatur und `ProblemDetailsContext`).
- dotnet/aspnetcore, [CustomizeProblemDetails not invoked for minimal API validation (issue #62723)](https://github.com/dotnet/aspnetcore/issues/62723) (die Lücke in der Preview-Ära, gelöst für .NET 10 GA).
