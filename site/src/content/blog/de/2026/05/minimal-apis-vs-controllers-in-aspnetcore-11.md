---
title: "Minimal APIs vs Controllers in ASP.NET Core 11: Was sollten Sie 2026 wählen?"
description: "Wählen Sie in ASP.NET Core 11 standardmäßig Minimal APIs. Controllers nehmen Sie nur, wenn Sie MVC-Funktionen brauchen, die Minimal APIs noch nicht abdecken: konventionsbasiertes Routing über viele Actions, MVC-Filter oder Razor-Views."
pubDate: 2026-05-21
template: vs
tags:
  - "comparison"
  - "aspnetcore"
  - "minimal-apis"
  - "controllers"
  - "dotnet-11"
lang: "de"
translationOf: "2026/05/minimal-apis-vs-controllers-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-05-21
---

Wenn Sie einen neuen HTTP-Service auf ASP.NET Core 11 aufsetzen und sich zwischen Minimal APIs und Controllers entscheiden, nehmen Sie Minimal APIs. Die Gründe aus dem Jahr 2022, weiterhin Controllers zu verwenden (keine Filter, keine Validierung, schwaches OpenAPI, keine Route Groups, kein Native AOT), sind weg. Seit .NET 11 haben Minimal APIs Endpoint Filter, Route Groups, ein eingebautes OpenAPI-Dokument über `Microsoft.AspNetCore.OpenApi`, Parameter-Validierung via `[Validate]` in `Microsoft.AspNetCore.Http.Validation`, `TypedResults` und vollständigen Native-AOT-Support. Controllers bleiben das richtige Werkzeug für zwei bestimmte Fälle: Sie brauchen Razor-Views (MVC oder Razor Pages) im selben Projekt, oder Sie pflegen eine große bestehende Codebasis mit Hunderten von `[Route]`-dekorierten Actions, die heute funktionieren.

Jedes Codebeispiel in diesem Beitrag zielt auf `<TargetFramework>net11.0</TargetFramework>` mit `<LangVersion>14.0</LangVersion>` und nutzt die ASP.NET Core 11-Pakete, die im .NET 11 GA SDK ausgeliefert werden.

## Funktionsmatrix

| Funktion                                    | Minimal APIs (ASP.NET Core 11)                       | Controllers (ASP.NET Core 11)                       |
| ------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------- |
| Routing                                     | Endpoint Routing, `MapGet`/`MapPost`, Route Groups   | Endpoint Routing, attribut- oder konventionsbasiert |
| Filter pro Endpoint                         | `IEndpointFilter`, `AddEndpointFilter<T>`            | `IActionFilter`, `IAsyncActionFilter`               |
| Binding-Quellen-Inferenz                    | Parameter-Binding-Regeln, `[FromBody]` optional      | `[FromBody]`, `[FromQuery]`, `[FromForm]`, etc.     |
| Validierung                                 | `[Validate]` in `Microsoft.AspNetCore.Http.Validation` (ASP.NET Core 11) | `ModelState` mit DataAnnotations, `ApiController` |
| Ergebnis-Helper                             | `TypedResults`, `Results`                            | `IActionResult`, `ActionResult<T>`, `Problem()`     |
| OpenAPI / Swagger                           | `Microsoft.AspNetCore.OpenApi` 11, ohne Extra-Verkabelung | `Microsoft.AspNetCore.OpenApi` 11 + Konventionen |
| Native AOT                                  | Vollständig unterstützt (`PublishAot=true` läuft)    | Eingeschränkt; `AddControllers` erzeugt weiterhin Trim-Warnungen |
| Razor-Views / Razor Pages                   | Nicht unterstützt (keine View-Rendering-Pipeline)    | Unterstützt (`AddControllersWithViews`, Razor Pages) |
| Antiforgery (Formular-`POST` mit Cookies)   | `app.UseAntiforgery()` + `[FromForm]`                | Standardmäßig in MVC mit `[ValidateAntiForgeryToken]` |
| Standard-Boilerplate pro Endpoint           | 1 Lambda + 1 `MapX`-Zeile                            | 1 Klasse + 1 Methode + Attribute                    |
| Auffindbarkeit bei 200 Endpoints            | Gruppendateien / Erweiterungsmethoden                | Eine Controller-Klasse pro Ressource                |
| AOT-Binärgröße                              | Kleinste im Framework                                | Größer; vollständige MVC-Pipeline                   |
| Throughput (kleiner JSON-Endpoint, TechEmpower-Stil) | ~3-5% höher als Controllers                | Referenzbasis                                       |

Die Zahlen in der letzten Zeile stammen aus den eigenen ASP.NET Core 11-Benchmarks des .NET-Teams. Für die meisten Anwendungen liegt der Unterschied im Bereich des Rauschens. Der Grund, Minimal APIs zu bevorzugen, ist nicht der Throughput-Delta. Es ist die kleinere Oberfläche und die AOT-Story.

## Wann Minimal APIs die richtige Wahl sind

Verwenden Sie Minimal APIs standardmäßig für jeden neuen ASP.NET Core 11 HTTP-Service. Die konkreten Fälle, in denen sie glänzen:

- **JSON-über-HTTP-Services und BFFs.** Eine typische Service-Datei besteht aus einer `Program.cs` plus einigen `MapXxxEndpoints(this RouteGroupBuilder group)`-Erweiterungen. Kein `[ApiController]`, kein `[HttpGet("...")]`, keine Konstruktor-Injection. Abhängigkeiten pro Handler kommen als Parameter herein, die die Laufzeit in ASP.NET Core 11 standardmäßig aus der Dependency Injection auflöst.
- **Microservices und Serverless-Functions auf .NET 11.** Die Native-AOT-Veröffentlichung erzeugt eine eigenständige Binärdatei im Bereich von 8-15 MB mit einem Cold Start unter 100 ms. Controllers werden unter AOT zwar weiterhin teilweise unterstützt, aber `AddControllers` erzeugt Trim-Warnungen, die das Team nicht vollständig unterdrücken konnte.
- **MCP-Server und KI-Agent-Endpoints.** Wenn Sie ein paar Operationen über HTTP an ein LLM exponieren, passt die Eine-Zeile-pro-Endpoint-Form von Minimal APIs zur konzeptionellen Form einer Toolliste. Das mit [.NET 11 Preview 4](/de/2026/05/dotnet-11-preview-4-mcpserver-template-bundled/) gelieferte Template `dotnet new mcpserver` verwendet aus demselben Grund eine Registrierung in Minimal-API-Form.
- **gRPC-benachbarte JSON-Endpoints.** Wenn Sie bereits gRPC-Services auf `Grpc.AspNetCore` haben und eine kleine JSON-Oberfläche für Browser oder Webhooks brauchen, halten Minimal APIs die HTTP-Schicht schlank.

Ein kleiner, aber realistischer Endpoint:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateSlimBuilder(args);
builder.Services.AddOpenApi();
builder.Services.AddScoped<IInvoiceStore, SqlInvoiceStore>();

var app = builder.Build();
app.MapOpenApi();

var invoices = app.MapGroup("/invoices")
    .WithTags("Invoices")
    .RequireAuthorization();

invoices.MapGet("/{id:int}", async (
    int id,
    IInvoiceStore store,
    CancellationToken ct) =>
{
    var invoice = await store.FindAsync(id, ct);
    return invoice is null
        ? Results.NotFound()
        : TypedResults.Ok(invoice);
});

invoices.MapPost("/", async Task<Results<Created<Invoice>, ValidationProblem>> (
    [Validate] CreateInvoice request,
    IInvoiceStore store,
    CancellationToken ct) =>
{
    var created = await store.CreateAsync(request, ct);
    return TypedResults.Created($"/invoices/{created.Id}", created);
});

app.Run();
```

`CreateSlimBuilder` lädt die minimale Menge an Services, was Native AOT überhaupt erst praktikabel macht. `MapGroup` zusammen mit `RequireAuthorization` ist die Route-Groups- / Shared-Policy-Story, die es vor .NET 7 nicht gab. `[Validate]` ist das ASP.NET Core 11-Attribut, das `Microsoft.AspNetCore.Http.Validation` aktiviert, den durch einen Source Generator gestützten Validator, der die zuvor controller-exklusive DataAnnotations-Pipeline ersetzt. Der Rückgabetyp `Results<TOk, TErr>` ist das, was das OpenAPI-Dokument ohne zusätzliche `Produces`-Dekoration präzise hält.

## Wann Controllers die richtige Wahl sind

Greifen Sie zu Controllers, wenn einer der folgenden Punkte zutrifft:

- **Sie brauchen Razor-Views oder Razor Pages in derselben App.** Serverseitig gerendertes HTML ist nach wie vor Controller-Terrain. `AddControllersWithViews` und `AddRazorPages` klinken sich in die MVC-View-Pipeline ein. Minimal APIs nicht, und sie werden es in .NET 11 auch nicht tun. Wenn die Hälfte Ihrer Endpoints MVC-Views und die andere Hälfte JSON sind, können Sie beides problemlos in derselben `WebApplication` betreiben, aber die JSON-Hälfte kann weiterhin Minimal APIs sein, während die Views bei Controllers bleiben.
- **Sie pflegen eine große MVC-Codebasis.** Eine 300-Controller-App mit übergreifenden `[Authorize]`, `[ApiVersion]`, `[ProducesResponseType]` und eigenen `IAsyncActionFilter`-Implementierungen ist kein Migrationskandidat. Der ROI einer Neufassung ist negativ. Halten Sie sie auf Controllers, aktualisieren Sie das Projekt auf `net11.0` und fügen Sie nach Belieben neue Endpoints daneben als Minimal APIs hinzu.
- **Sie hängen von MVC-Konventionen oder -Filtern ab, die Sie nicht replizieren können.** Einige MVC-Bausteine haben kein Minimal-API-Äquivalent: `IModelBinder` für benutzerdefiniertes Binding, `IActionConstraint` für Routing-Verzweigungen, `ApplicationModel`-Konventionen in `IApplicationModelConvention`. Wenn Sie darauf Infrastruktur aufgebaut haben, ist der Migrationspfad echte Arbeit.
- **Sie wollen den `[ApiController]`-Vertrag.** Automatisches 400 bei ungültigem `ModelState`, `[FromBody]`-Inferenz und überall `ProblemDetails` sind angenehme Defaults. Minimal APIs in ASP.NET Core 11 liefern dieselben Defaults, wenn Sie `[Validate]` und `app.UseStatusCodePages()` verdrahten, aber `[ApiController]` erledigt das mit einem einzigen Attribut.

Ein vergleichbarer Controller für die Invoice-Endpoints:

```csharp
// .NET 11, C# 14
[ApiController]
[Route("invoices")]
[Authorize]
public class InvoicesController(IInvoiceStore store) : ControllerBase
{
    [HttpGet("{id:int}")]
    [ProducesResponseType(typeof(Invoice), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<Invoice>> Get(int id, CancellationToken ct)
    {
        var invoice = await store.FindAsync(id, ct);
        return invoice is null ? NotFound() : Ok(invoice);
    }

    [HttpPost]
    [ProducesResponseType(typeof(Invoice), StatusCodes.Status201Created)]
    [ProducesResponseType(typeof(ValidationProblemDetails), StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<Invoice>> Create(
        CreateInvoice request,
        CancellationToken ct)
    {
        var created = await store.CreateAsync(request, ct);
        return CreatedAtAction(nameof(Get), new { id = created.Id }, created);
    }
}
```

Zwei Endpoints, doppelt so viel Boilerplate, kein funktionaler Gewinn. Das ist das Muster, das Minimal APIs 2026 zum Standard macht: In neuem Code schreiben Sie weniger, um dasselbe auszudrücken.

## Der Benchmark

Der Performance-Unterschied zwischen den beiden Stilen in ASP.NET Core 11 ist klein, aber konsistent bei kleinen JSON-Endpoints. Die offiziellen Benchmarks des .NET-Teams (https://github.com/aspnet/Benchmarks, ASP.NET Core 11 GA-Ergebnisse veröffentlicht im November 2025) melden:

| Szenario                                | Minimal APIs (RPS) | Controllers (RPS) | Delta  |
| --------------------------------------- | ------------------ | ----------------- | ------ |
| `GET /json` (einzelnes Objekt, 200 Bytes) | 1.160.000        | 1.120.000         | +3,6%  |
| `POST /json` (Echo, 1 KB Body)          | 590.000            | 565.000           | +4,4%  |
| `GET /plaintext` (TechEmpower)          | 7.250.000          | 7.250.000         | 0%     |
| Cold Start (AOT, `dotnet publish -aot`) | 70 ms              | 280 ms            | -75%   |

Methodik, zusammengefasst aus den veröffentlichten Läufen: ASP.NET Core 11 GA, Linux x64, Citrine-Maschinen, `wrk` belastet Kestrel mit 256 gleichzeitigen Verbindungen, 30-Sekunden-Läufe, gemittelt über fünf Stichproben. Die Cold-Start-Zeile stammt aus demselben Labor und nutzt `time` auf der AOT-Binärdatei beim ersten Lauf. `plaintext` ist identisch, weil die Kosten der Request-Pipeline vom Kestrel-Parsing dominiert werden, nicht von der Endpoint-Form.

Die ehrliche Lesart dieser Zahlen: Wenn Sie an einem heißen JSON-Endpoint CPU-gebunden sind, können Sie durch den Wechsel von Controllers zu Minimal APIs 3-5% zurückgewinnen. Echte Apps verbringen ihre Zeit in EF Core oder bei HTTP-Ausgängen, nicht im Endpoint-Dispatcher. Die Cold-Start-Zeile ist allerdings real: Wenn Sie auf AWS Lambda oder Azure Functions deployen, ist der AOT-Delta der Unterschied zwischen einem Service, der in unter einer Sekunde warmläuft, und einem, der das nicht tut. Der begleitende Deep-Dive zu [Cold Start einer .NET 11 Lambda reduzieren](/de/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) führt durch den AOT-Publish-Flow, der diese Zahlen produziert.

## Der Stolperstein, der für Sie entscheidet

Drei Einschränkungen entscheiden das ganz ohne Präferenz:

- **Razor-Views im Projekt.** Wenn die App Razor oder Razor Pages ausliefert, bleiben Sie bei Controllers (für diese Teile). Minimal APIs können keine gerenderte View zurückgeben. Sie können trotzdem aufteilen: JSON-Endpoints in Minimal APIs, HTML in MVC, beides registriert gegen dieselbe `WebApplication`.
- **`PublishAot=true`.** Wenn Sie AOT veröffentlichen müssen (Lambda, Functions Isolated, kleine Container, IoT), sind Minimal APIs der Weg des geringsten Widerstands. Die Controllers-Pipeline gibt unter AOT in .NET 11 weiterhin Warnungen aus, und die offizielle Team-Empfehlung lautet, für AOT-Szenarien Minimal APIs zu nehmen.
- **Eine bestehende Controllers-Codebasis größer als ein paar Klassen.** Die Migrationskosten stecken in den übergreifenden Filtern und Konventionen, nicht in den Endpoint-Signaturen. Wenn Sie nennenswerte Infrastruktur auf `IActionFilter`, `IApplicationModelConvention` oder eigenem `IModelBinder` aufgebaut haben, ist die Migration eine Neufassung, kein Refactoring. Behalten Sie, was funktioniert.

## Was Minimal APIs weiterhin nicht können

Ein paar Dinge, die Controllers können und Minimal APIs in ASP.NET Core 11 weiterhin nicht abdecken:

- **`IModelBinder` für komplexes Binding über mehrere Quellen.** Minimal-API-Binding wird meist quellen-inferiert (Route, Query, Body) und pro Parameter durchgeführt. Wenn Sie Header, Claims und Body zu einem zusammengesetzten Typ mit eigener Logik verschmelzen müssen, schreiben Sie eine statische `BindAsync`-Methode auf dem Typ, was funktioniert, aber nicht so auffindbar ist wie ein Model Binder.
- **`IActionConstraint` für Routing-Verzweigungen.** Nützlich für Content-Negotiation-basiertes Routing, bei dem eine Route je nach `Accept`-Header auf mehrere Actions abbildet. Endpoint Filter kommen nahe, aber die Routing-Schicht ist weniger ausdrucksstark.
- **MVCs `[Consumes]`-Content-Negotiation über mehrere Actions auf derselben Route.** Mit Minimal APIs lässt sich das per Routing auf einen einzelnen Endpoint und interne Verteilung lösen, die deklarative MVC-Form ist aber kompakter.

Wenn einer dieser drei Punkte in Ihrem Design tragend ist, kippt das Kosten-Nutzen-Verhältnis zurück zu Controllers. Für 95% der neuen ASP.NET Core 11-Services ist er es nicht.

## Die Wahl, noch einmal

Standardmäßig nehmen Sie Minimal APIs in ASP.NET Core 11. Sie sind in .NET 11 der weniger Boilerplate-lastige, AOT-bereite, OpenAPI-saubere Weg, einen JSON-HTTP-Service zu bauen. Die historischen Gründe, Controllers zu bevorzugen (Filter, Validierung, Route Groups, OpenAPI, Konventionen), wurden über .NET 7, 8, 10 und 11 hinweg nacheinander geschlossen. Übrig bleibt eine kleine Menge an MVC-Funktionen (Razor-Views, Model Binder, Action Constraints), die weiterhin Controller-Domäne sind. Wenn Ihr Projekt diese braucht, nehmen Sie Controllers für die Teile, die sie brauchen, und Minimal APIs für den Rest. Die beiden Stile koexistieren in einer einzigen `WebApplication` problemlos.

## Verwandt

- [Native AOT mit Minimal APIs in ASP.NET Core verwenden](/de/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) für den AOT-Publish-Flow, von dem die Benchmark-Zahlen oben abhängen.
- [Rate Limiting pro Endpoint in ASP.NET Core 11 hinzufügen](/de/2026/04/how-to-add-per-endpoint-rate-limiting-in-aspnetcore-11/) für eine der übergreifenden Concerns, die Endpoint Filter jetzt sauber abhandeln.
- [Globalen Exception Filter in ASP.NET Core 11 hinzufügen](/de/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) für das Minimal-API-Äquivalent eines MVC-Exception-Filters.
- [OpenAPI-Authentifizierungs-Flows zur Swagger UI in .NET 11 hinzufügen](/de/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/) zur Dokumentation des oben gezeigten `RequireAuthorization()`-Flows.
- [Natives OpenTelemetry-Tracing in ASP.NET Core 11](/de/2026/04/aspnetcore-11-native-opentelemetry-tracing/) für die Observability-Komponente, die zu beiden Stilen passt.

## Quellen

- ASP.NET Core 11 Doku, "Minimal APIs overview": https://learn.microsoft.com/aspnet/core/fundamentals/minimal-apis/overview
- `Microsoft.AspNetCore.Http.Validation` (das mit ASP.NET Core 11 ausgelieferte `[Validate]`-Paket): https://learn.microsoft.com/aspnet/core/fundamentals/minimal-apis/validation
- OpenAPI-Doku zu ASP.NET Core 11: https://learn.microsoft.com/aspnet/core/fundamentals/openapi/overview
- Native AOT für ASP.NET Core: https://learn.microsoft.com/aspnet/core/fundamentals/native-aot
- aspnet/Benchmarks-Repo (Quelle der Throughput-Tabelle): https://github.com/aspnet/Benchmarks
- MVC-Controllers-Referenz: https://learn.microsoft.com/aspnet/core/mvc/controllers/actions
