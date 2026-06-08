---
title: "OpenAPI ohne Swashbuckle in ASP.NET Core 11 bereitstellen"
description: "Swashbuckle ist aus den ASP.NET-Core-Templates verschwunden. So generieren und servieren Sie in .NET 11 ein OpenAPI-Dokument mit dem integrierten Paket Microsoft.AspNetCore.OpenApi: AddOpenApi, MapOpenApi, Transformer, mehrere Dokumente, Generierung zur Build-Zeit und eine Oberfläche darüber."
pubDate: 2026-06-08
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "openapi"
lang: "de"
translationOf: "2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-06-08
---

Wenn Sie kürzlich eine ASP.NET Core Web API erstellt und nach `AddSwaggerGen` und `UseSwagger` gesucht haben, waren sie nicht da. Seit .NET 9 enthalten die Web-API-Templates den eigenen OpenAPI-Generator von Microsoft anstelle von Swashbuckle. Um in .NET 11 ein OpenAPI-Dokument bereitzustellen, installieren Sie `Microsoft.AspNetCore.OpenApi`, rufen `builder.Services.AddOpenApi()` auf und rufen `app.MapOpenApi()` auf. Das serviert das Dokument unter `/openapi/v1.json`. Eine Oberfläche ist nicht enthalten: Wenn Sie eine interaktive Seite möchten, fügen Sie Scalar oder Swagger UI separat hinzu und richten es auf diesen JSON-Endpunkt aus. Alles Folgende zielt auf .NET 11 mit `Microsoft.NET.Sdk.Web` und C# 14 ab, aber dieselbe API existiert in .NET 9 und 10.

## Warum Swashbuckle das Template verlassen hat

Swashbuckle.AspNetCore war jahrelang die Standard-OpenAPI-Lösung, aber es war ein Drittanbieter-Paket, das in die offiziellen Templates eingebunden war, und es hinkte den .NET-Releases deutlich hinterher. Die .NET-6-Ära ist das mahnende Beispiel: Die Wartung von Swashbuckle geriet ins Stocken, das Paket blieb ohne eine stabile Version, die auf die neueste Laufzeit abzielte, und Teams, die auf eine neue .NET-Version aktualisierten, hingen an einer Abhängigkeit fest, die ihnen nicht gehörte. Microsoft entschied, dass die OpenAPI-Generierung wichtig genug war, um sie mitzuliefern, genauso wie der JSON-Serializer und der Dependency-Injection-Container.

Das Ergebnis ist `Microsoft.AspNetCore.OpenApi`. Es generiert standardmäßig [OpenAPI-3.1](https://spec.openapis.org/oas/v3.1.1.html)-Dokumente, verwendet [JSON Schema draft 2020-12](https://json-schema.org/specification-links#2020-12), nutzt die `System.Text.Json`-Schema-Unterstützung wieder, auf die sich der Rest des Frameworks ohnehin stützt, und ist mit Native AOT kompatibel. Das Einzige, was es bewusst nicht tut, ist eine Oberfläche zu rendern. Swashbuckle bündelte sowohl den Dokumentgenerator als auch die Swagger-UI-Web-Assets; Microsoft hat diese Belange getrennt. Das Framework erzeugt die Spezifikation, und Sie wählen den Viewer.

## Die zwei Aufrufe, die das Dokument generieren

Fügen Sie das Paket hinzu:

```dotnetcli
dotnet add package Microsoft.AspNetCore.OpenApi
```

Registrieren Sie dann die Dienste und mappen Sie den Endpunkt:

```csharp
// .NET 11, C# 14
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOpenApi();

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

app.MapGet("/todos/{id}", (int id) => new Todo(id, "Write the spec", false));

app.Run();

record Todo(int Id, string Title, bool Done);
```

Starten Sie die Anwendung und rufen Sie `https://localhost:{port}/openapi/v1.json` auf. Sie erhalten ein vollständiges OpenAPI-3.1-Dokument, das jeden Endpunkt beschreibt, den der API-Explorer sehen kann, mit Schemas, die aus Ihren Parameter- und Rückgabetypen abgeleitet werden. `AddOpenApi()` registriert die Dokumentdienste und `MapOpenApi()` fügt den Route-Handler hinzu, der das Dokument auf Anfrage serialisiert.

Der Standard-Dokumentname ist `v1`, weshalb die Route `/openapi/v1.json` lautet. Das Routen-Template von `MapOpenApi` ist `/openapi/{documentName}.json`. Zwei Dinge sind im obigen Codeausschnitt beachtenswert. Erstens ist der Dokument-Endpunkt hinter `IsDevelopment()` abgesichert. Das ist die eigene Empfehlung des Frameworks: Ein OpenAPI-Dokument ist eine vollständige Karte Ihrer Angriffsfläche, servieren Sie es also standardmäßig nicht ins öffentliche Internet. Zweitens gibt es noch keine Oberfläche. Der Aufruf von `/openapi/v1.json` liefert rohes JSON, genau das, was Werkzeuge möchten, aber nicht das, was ein Mensch durchklicken möchte.

## Bringen Sie Ihre eigene Oberfläche mit

Das ist der Teil, der Umsteiger von Swashbuckle stolpern lässt, wo `/swagger` einfach funktionierte. In .NET 11 wählen Sie einen Viewer und verdrahten ihn mit der Dokumentroute.

Der Template-Standard tendiert seit .NET 9 zu Scalar. Installieren Sie `Scalar.AspNetCore` und mappen Sie es:

```csharp
// .NET 11, C# 14
using Scalar.AspNetCore;

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.MapScalarApiReference();
}
```

Navigieren Sie zu `https://localhost:{port}/scalar` und Sie erhalten eine interaktive Referenzoberfläche, die das Dokument `/openapi/v1.json` liest. Scalar erkennt die Standardroute automatisch, sodass für den Normalfall nichts weiter zu konfigurieren ist.

Wenn Ihr Team an Swagger UI hängt, funktioniert es weiterhin. Installieren Sie `Swashbuckle.AspNetCore.SwaggerUi` (nur die UI-Assets, nicht den Generator) und richten Sie es auf das Dokument aus:

```csharp
// .NET 11, C# 14
var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();

    app.UseSwaggerUI(options =>
    {
        options.SwaggerEndpoint("/openapi/v1.json", "v1");
    });
}
```

Das serviert Swagger UI unter `/swagger` und liest das vom Framework generierte Dokument statt eines von Swashbuckle generierten. ReDoc funktioniert auf dieselbe Weise: Servieren Sie die statische Oberfläche und geben Sie ihr die URL `/openapi/v1.json`. Dem Framework ist egal, welchen Viewer Sie verwenden, weil es nur das JSON besitzt. Als Sicherheitshinweis: Halten Sie alle drei Oberflächen hinter einer Nur-Entwicklung-Prüfung, aus demselben Grund, aus dem Sie das Dokument selbst absichern.

## Titel, Beschreibungen und Metadaten hinzufügen

Ein nacktes Dokument hat einen generischen Titel und keine Beschreibungen. Sie reichern es an zwei Stellen an: Metadaten pro Endpunkt und dokumentweite Transformer.

Metadaten pro Endpunkt verwenden dieselben Minimal-API-Konventionen, die Sie bereits für das Routing nutzen. `WithSummary`, `WithDescription` und `WithTags` fließen direkt in die Operation:

```csharp
// .NET 11, C# 14
app.MapGet("/todos/{id}", (int id) => Results.Ok(new Todo(id, "Write", false)))
   .WithSummary("Get a todo by id")
   .WithDescription("Returns a single todo item, or 404 if it does not exist.")
   .WithTags("Todos")
   .Produces<Todo>(StatusCodes.Status200OK)
   .Produces(StatusCodes.Status404NotFound);
```

Für Informationen auf Dokumentebene wie API-Titel, Version und Kontakt registrieren Sie einen Document Transformer. Ein Transformer läuft über das generierte `OpenApiDocument`, bevor es serialisiert wird, sodass Sie alles setzen oder umschreiben können:

```csharp
// .NET 11, C# 14
using Microsoft.OpenApi.Models;

builder.Services.AddOpenApi(options =>
{
    options.AddDocumentTransformer((document, context, cancellationToken) =>
    {
        document.Info = new OpenApiInfo
        {
            Title = "Todo API",
            Version = "v1",
            Description = "Task tracking endpoints for the Start Debugging sample.",
            Contact = new OpenApiContact { Name = "API team", Email = "api@example.com" }
        };
        return Task.CompletedTask;
    });
});
```

Transformer sind der Erweiterungspunkt, der das meiste ersetzt, was Sie mit Swashbuckle-Filtern gemacht haben. Es gibt drei Arten, und sie laufen in der Reihenfolge, in der Sie sie registrieren:

- `AddDocumentTransformer` modifiziert das gesamte Dokument. Verwenden Sie es für `Info`, `servers`, Sicherheitsschemata der obersten Ebene und Tags.
- `AddOperationTransformer` läuft einmal pro Operation. Verwenden Sie es, um eine gemeinsame Antwort, einen Header-Parameter oder eine Beschreibung zu jedem Endpunkt hinzuzufügen.
- `AddSchemaTransformer` läuft einmal pro generiertem Schema. Verwenden Sie es, um Beispiele hinzuzufügen, Formate anzupassen oder Eigenschaften zu markieren.

Eine häufige reale Aufgabe ist die Deklaration eines Bearer-Sicherheitsschemas, damit die Oberfläche eine Authorize-Schaltfläche anzeigt. Das ist ein Document Transformer, der das Schema und eine globale Anforderung hinzufügt. Wenn Sie auf den Fall gestoßen sind, dass der Viewer das Token stillschweigend ignoriert, ist die Ursache fast immer ein fehlendes oder fehlerhaftes Sicherheitsschema im Dokument, was ich ausführlich in [warum Ihr Bearer-Token in Scalar ignoriert wird](/de/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/) behandelt habe.

Für einen stark typisierten Transformer implementieren Sie `IOpenApiDocumentTransformer` (oder die Operations- und Schema-Äquivalente) und registrieren den Typ. Das ermöglicht es, Dienste zu injizieren, etwa um die registrierten Authentifizierungsschemata zu lesen und passende Sicherheitsdefinitionen zu emittieren:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi.Models;

internal sealed class BearerSecuritySchemeTransformer : IOpenApiDocumentTransformer
{
    public Task TransformAsync(
        OpenApiDocument document,
        OpenApiDocumentTransformerContext context,
        CancellationToken cancellationToken)
    {
        document.Components ??= new OpenApiComponents();
        document.Components.SecuritySchemes["Bearer"] = new OpenApiSecurityScheme
        {
            Type = SecuritySchemeType.Http,
            Scheme = "bearer",
            BearerFormat = "JWT",
            In = ParameterLocation.Header
        };
        return Task.CompletedTask;
    }
}

// Registration
builder.Services.AddOpenApi(options =>
{
    options.AddDocumentTransformer<BearerSecuritySchemeTransformer>();
});
```

## Mehr als ein Dokument generieren

Swashbuckle behandelte "v1 und v2" oder "öffentlich und intern" mit mehreren `SwaggerDoc`-Aufrufen. Der integrierte Generator macht das mit mehreren `AddOpenApi`-Aufrufen, jeder mit eigenem Namen und eigenen Optionen:

```csharp
// .NET 11, C# 14
builder.Services.AddOpenApi("public");
builder.Services.AddOpenApi("internal");
```

Jedes benannte Dokument erhält seine eigene Route: `/openapi/public.json` und `/openapi/internal.json`. Welche Endpunkte in welchem Dokument landen, entscheidet das `ShouldInclude`-Delegate auf `OpenApiOptions`. Standardmäßig verwendet es den Gruppennamen des Endpunkts, gesetzt mit `WithGroupName` oder dem Attribut `[EndpointGroupName]`, und jeder Endpunkt ohne Gruppennamen wird in jedes Dokument aufgenommen. Sie können `ShouldInclude` durch ein beliebiges Prädikat über die `ApiDescription` ersetzen:

```csharp
// .NET 11, C# 14
builder.Services.AddOpenApi("public", options =>
{
    options.ShouldInclude = description =>
        description.GroupName is null || description.GroupName == "public";
});
```

Wenn Sie API-Versionierung im Einsatz haben, integrieren sich die Versionierungsbibliotheken in dasselbe Dokumentmodell, statt dagegen anzukämpfen, was eine echte Verbesserung gegenüber dem alten Setup ist. Siehe [Asp.Versioning mit integriertem OpenAPI](/de/2026/04/api-versioning-openapi-dotnet-10/) für das Muster eines Dokuments pro Version.

## Das Dokument zur Build-Zeit generieren

Das Dokument über HTTP zu servieren ist für die Entwicklung in Ordnung, aber manchmal möchten Sie die JSON-Datei als Build-Artefakt: um sie in die Versionskontrolle einzuchecken, um Vertragstests dagegen laufen zu lassen, um einen [Client-Code-Generator](/de/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/) zu speisen oder um sie in der Produktion als statische Datei zu servieren, statt einen Live-Endpunkt freizugeben. Fügen Sie dafür das Build-Zeit-Paket hinzu:

```dotnetcli
dotnet add package Microsoft.Extensions.ApiDescription.Server
```

Mit installiertem Paket emittiert `dotnet build` das Dokument in `obj/`, benannt nach dem Projekt. Um zu steuern, wo es landet und ob es generiert wird, setzen Sie MSBuild-Eigenschaften in der `.csproj`:

```xml
<PropertyGroup>
  <OpenApiGenerateDocuments>true</OpenApiGenerateDocuments>
  <OpenApiDocumentsDirectory>$(MSBuildProjectDirectory)</OpenApiDocumentsDirectory>
</PropertyGroup>
```

`OpenApiDocumentsDirectory` wird relativ zur Projektdatei aufgelöst, sodass der obige Wert das JSON neben die `.csproj` legt. Um die Datei umzubenennen oder ein einzelnes Dokument auszuwählen, wenn Sie mehrere generieren, verwenden Sie `OpenApiGenerateDocumentsOptions`:

```xml
<PropertyGroup>
  <OpenApiGenerateDocumentsOptions>--file-name my-api --document-name public</OpenApiGenerateDocumentsOptions>
</PropertyGroup>
```

Die Build-Zeit-Generierung funktioniert, indem der Einstiegspunkt Ihrer Anwendung gegen einen Mock-Server gestartet wird, sodass Ihre `Program.cs` tatsächlich läuft. Das bedeutet, dass Startcode, Konfigurationslesevorgänge und Dependency-Injection-Registrierungen alle während des Builds ausgeführt werden. Wenn etwas im Start in diesem Kontext nicht laufen sollte, etwa eine Verbindung zu einer Datenbank, schützen Sie es anhand des Namens des Einstiegs-Assemblys:

```csharp
// .NET 11, C# 14
using System.Reflection;

if (Assembly.GetEntryAssembly()?.GetName().Name != "GetDocument.Insider")
{
    builder.Services.AddDbContext<AppDbContext>(/* ... */);
}
```

Eine aktuelle Einschränkung: Die Build-Zeit-Generierung erzeugt nur JSON. YAML-Ausgabe wird zur Laufzeit unterstützt (geben Sie `MapOpenApi` eine `.yaml`-Route), aber noch nicht zur Build-Zeit.

## Details, die Sie vor dem Veröffentlichen kennen sollten

**Das Dokument wird bei jeder Anfrage neu generiert.** `MapOpenApi` durchläuft die gesamte Generierungspipeline jedes Mal, wenn der Endpunkt aufgerufen wird, absichtlich, damit Transformer auf den Live-Zustand reagieren können. Für ein stark frequentiertes Dokument können Sie es mit Output-Caching und `.CacheOutput()` am Endpunkt zwischenspeichern oder sich einfach auf die Build-Zeit-Generierung stützen und eine statische Datei servieren.

**Die Standard-Spezifikationsversion ist 3.1, und das kann alte Werkzeuge brechen.** Manche Konsumenten verstehen noch ausschließlich OpenAPI 3.0. Wenn ein nachgelagerter Generator an einem 3.1-Dokument scheitert, stufen Sie die Version explizit herunter:

```csharp
// .NET 11, C# 14
using Microsoft.OpenApi;

builder.Services.AddOpenApi(options =>
{
    options.OpenApiVersion = OpenApiSpecVersion.OpenApi3_0;
});
```

Zur Build-Zeit ist das Äquivalent `<OpenApiGenerateDocumentsOptions>--openapi-version OpenApi3_1</OpenApiGenerateDocumentsOptions>`.

**Der Endpunkt hat standardmäßig keine Autorisierung.** Wenn Sie das Dokument außerhalb der Entwicklung freigeben, sichern Sie es ab. `MapOpenApi()` gibt einen Endpoint Convention Builder zurück, sodass `app.MapOpenApi().RequireAuthorization("SomePolicy")` genauso funktioniert wie bei jedem Minimal-Endpunkt.

**Es dokumentiert nur, was der API-Explorer sieht.** Minimal-API-Endpunkte werden automatisch erkannt, aber wenn Sie `IResult` ohne eine typisierte Überladung oder einen `Produces`-Aufruf zurückgeben, kann der Generator das Antwort-Schema nicht ableiten. Annotieren Sie mit `Produces<T>` und `Accepts<T>`, damit das Dokument korrekt ist. Das ist dieselbe Disziplin, die Minimal-APIs an anderer Stelle belohnen, und sie passt gut dazu, die Endpunkte über [MapGroup](/de/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) organisiert zu halten, da Konventionen auf Gruppenebene wie `WithTags` in jede Operation der Gruppe fließen.

Der mentale Wechsel weg von Swashbuckle ist klein, sobald Sie ihn verinnerlicht haben: Das Framework besitzt das Dokument, Transformer ersetzen Filter, und die Oberfläche ist ein separater, austauschbarer Belang. Sie schreiben zwei Zeilen für JSON, eine weitere Zeile für einen Viewer und eine Handvoll Transformer, um das Dokument ansehnlich zu machen. Nichts ist an ein Paket gebunden, das nach dem Zeitplan eines anderen erscheint.

## Weiterführende Lektüre

- [Minimal-API-Endpunkte mit MapGroup in ASP.NET Core 11 organisieren](/de/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [OpenAPI-Authentifizierungsflüsse zu Swagger UI in .NET 11 hinzufügen](/de/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/)
- [Stark typisierten Client-Code aus einer OpenAPI-Spezifikation in .NET 11 generieren](/de/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/)
- [Scalar in ASP.NET Core: warum Ihr Bearer-Token ignoriert wird](/de/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/)
- [Minimal APIs vs. Controller in ASP.NET Core 11](/de/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)

## Quellen

- [Generate OpenAPI documents, ASP.NET-Core-Dokumentation](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/aspnetcore-openapi?view=aspnetcore-10.0)
- [Use the generated OpenAPI documents, ASP.NET-Core-Dokumentation](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/using-openapi-documents?view=aspnetcore-10.0)
- [Customize OpenAPI documents, ASP.NET-Core-Dokumentation](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/customize-openapi?view=aspnetcore-10.0)
- [Microsoft.AspNetCore.OpenApi auf NuGet](https://www.nuget.org/packages/Microsoft.AspNetCore.OpenApi/)
- [Microsoft.Extensions.ApiDescription.Server auf NuGet](https://www.nuget.org/packages/Microsoft.Extensions.ApiDescription.Server)
</content>
