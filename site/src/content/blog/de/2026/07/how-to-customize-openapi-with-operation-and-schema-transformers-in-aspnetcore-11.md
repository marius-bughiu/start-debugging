---
title: "OpenAPI-Dokument mit AddOperationTransformer und AddSchemaTransformer in ASP.NET Core 11 anpassen"
description: "Ein tiefer Einblick in die eingebaute OpenAPI-Transformer-Pipeline in .NET 11: Operation- vs. Schema-Transformer, die Kontextobjekte, die Ausführungsreihenfolge, DI-aktivierte Transformer sowie Rezepte für Header, Antworten, Beispiele und Anpassungen pro Eigenschaft."
pubDate: 2026-07-12
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "openapi"
lang: "de"
translationOf: "2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-12
---

Der eingebaute `Microsoft.AspNetCore.OpenApi`-Generator in .NET 11 verwaltet das OpenAPI-Dokument, und die Art, wie Sie ändern, was er ausgibt, sind Transformer. Es gibt drei: `AddDocumentTransformer` für das gesamte Dokument, `AddOperationTransformer` für jede Operation aus Pfad plus Methode und `AddSchemaTransformer` für jedes Datenmodell. Um allen Endpunkten einen Header-Parameter oder eine gemeinsame Antwort hinzuzufügen, verwenden Sie einen Operation-Transformer. Um ein Format, ein Beispiel oder eine Beschreibung für einen Typ oder eine Eigenschaft zu setzen, verwenden Sie einen Schema-Transformer. Dieser Beitrag richtet sich an .NET 11 (`net11.0`, C# 14) mit `Microsoft.AspNetCore.OpenApi` und `Microsoft.OpenApi` v2 und geht über die Einzeiler hinaus zu den Kontextobjekten, der Ausführungsreihenfolge, die viele stolpern lässt, und den Microsoft.OpenApi-v2-Typänderungen, die nicht kompilieren, wenn Sie .NET-8-Beispiele kopieren.

Falls Sie noch kein Dokument erzeugt haben, beginnen Sie mit [wie man OpenAPI ohne Swashbuckle bereitstellt](/de/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/); alles Folgende setzt voraus, dass `builder.Services.AddOpenApi()` und `app.MapOpenApi()` bereits vorhanden sind.

## Was jeder Transformer verändern darf

Die drei Transformer-Arten sind nicht austauschbar, und die falsche zu wählen ist der häufigste Fehler. Die Regel dreht sich um den Geltungsbereich:

- Ein **Document-Transformer** sieht das gesamte `OpenApiDocument`. Er ist das richtige Werkzeug für `Info`, `servers`, `tags` auf oberster Ebene und Sicherheitsschemata, denn diese liegen im Wurzelelement.
- Ein **Operation-Transformer** wird einmal pro Operation aufgerufen, wobei eine Operation ein eindeutiger Pfad plus HTTP-Methode ist (`GET /todos/{id}` ist eine Operation, `POST /todos` eine andere). Greifen Sie dazu, wenn Sie eine Änderung an jedem Endpunkt vornehmen wollen oder an Endpunkten, die eine Bedingung erfüllen, die Sie aus Metadaten lesen können.
- Ein **Schema-Transformer** wird für jedes Schema aufgerufen, das der Generator erzeugt, einschließlich verschachtelter. Hier verändern Sie die Form von Anfrage- und Antwortkörpern: Formate, Beispiele, Beschreibungen, Nullbarkeit, Veraltung.

Wenn Sie versuchen, aus einem Document-Transformer eine Antwort zu "allen Operationen" hinzuzufügen, müssen Sie `document.Paths` von Hand durchlaufen; mit einem Operation-Transformer reicht Ihnen das Framework jede Operation direkt. Der Umkehrschluss gilt ebenso: `document.Info` aus einem Operation-Transformer zu setzen würde einmal pro Endpunkt laufen und sich selbst überschreiben. Passen Sie den Transformer an die Ebene dessen an, was Sie ändern.

## Vier Schritte, um einen globalen Header hinzuzufügen und ein Schema zu formen

Hier ist die Kernprozedur von Anfang bis Ende. Sie registriert einen Operation-Transformer, der jedem Endpunkt einen Correlation-Id-Header aufprägt, und einen Schema-Transformer, der das Format eines Typs festlegt.

1. **Öffnen Sie den `AddOpenApi`-Optionsblock.** Alle drei `Add*Transformer`-Methoden hängen an `OpenApiOptions`, Sie registrieren also innerhalb des `AddOpenApi(options => { ... })`-Delegaten.

2. **Registrieren Sie einen Operation-Transformer für den Header.** Die Signatur des Delegaten ist `(OpenApiOperation operation, OpenApiOperationTransformerContext context, CancellationToken ct)`. Mutieren Sie `operation` an Ort und Stelle und geben Sie einen `Task` zurück.

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

builder.Services.AddOpenApi(options =>
{
    options.AddOperationTransformer((operation, context, cancellationToken) =>
    {
        operation.Parameters ??= [];
        operation.Parameters.Add(new OpenApiParameter
        {
            Name = "X-Correlation-Id",
            In = ParameterLocation.Header,
            Required = false,
            Description = "Client-supplied request id, echoed back in the response.",
            Schema = new OpenApiSchema { Type = JsonSchemaType.String }
        });
        return Task.CompletedTask;
    });
});
```

3. **Registrieren Sie einen Schema-Transformer für den Typ.** Sein Delegat ist `(OpenApiSchema schema, OpenApiSchemaTransformerContext context, CancellationToken ct)`. Das klassische Beispiel ist, Konsumenten mitzuteilen, dass ein `decimal` geldgenau ist und kein Float:

```csharp
// .NET 11, C# 14
options.AddSchemaTransformer((schema, context, cancellationToken) =>
{
    if (context.JsonTypeInfo.Type == typeof(decimal))
    {
        schema.Format = "decimal";
    }
    return Task.CompletedTask;
});
```

4. **Neu erzeugen und prüfen.** Rufen Sie `/openapi/v1.json` ab. Jede Operation sollte nun den Header-Parameter `X-Correlation-Id` tragen, und jede `decimal`-Eigenschaft sollte `"format": "decimal"` zeigen. Da `MapOpenApi` das Dokument bei jeder Anfrage neu erzeugt, gibt es nichts neu zu starten außer der App selbst.

Das ist die ganze Schleife. Der Rest dieses Beitrags ist das Detail, das diese Transformer zuverlässig statt überraschend macht.

## Die Kontextobjekte, Eigenschaft für Eigenschaft

Jeder Transformer erhält einen Kontext, und die Kontexte unterscheiden sich, weil jeder Transformer verschiedene Dinge weiß.

Der **Operation**-Kontext (`OpenApiOperationTransformerContext`) stellt `DocumentName`, `Description` (die `ApiDescription` für den Endpunkt) und `ApplicationServices` (den `IServiceProvider`) bereit. `Description` ist der wichtige: Er trägt die Route, die HTTP-Methode und `ActionDescriptor.EndpointMetadata`, womit Sie einen Transformer bedingt machen. Zum Beispiel fügen Sie eine `429`-Antwort nur den Endpunkten hinzu, an denen tatsächlich eine Rate-Limiting-Richtlinie hängt:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.RateLimiting;

options.AddOperationTransformer((operation, context, cancellationToken) =>
{
    var isRateLimited = context.Description.ActionDescriptor.EndpointMetadata
        .OfType<EnableRateLimitingAttribute>()
        .Any();

    if (isRateLimited)
    {
        operation.Responses ??= new OpenApiResponses();
        operation.Responses["429"] = new OpenApiResponse
        {
            Description = "Too many requests. Retry after the window resets."
        };
    }

    return Task.CompletedTask;
});
```

Der **Schema**-Kontext (`OpenApiSchemaTransformerContext`) stellt `DocumentName`, `JsonTypeInfo`, `JsonPropertyInfo` und `ApplicationServices` bereit. `JsonTypeInfo` sind die `System.Text.Json`-Metadaten für den beschriebenen Typ, also ist `context.JsonTypeInfo.Type` der CLR-`Type`. `JsonPropertyInfo` ist nur befüllt, wenn das Schema für eine bestimmte Eigenschaft erzeugt wird, wodurch Sie ein einzelnes Mitglied statt eines ganzen Typs ansprechen können:

```csharp
// .NET 11, C# 14
using System.Text.Json.Nodes;

options.AddSchemaTransformer((schema, context, cancellationToken) =>
{
    // Target the Email property on any type that has one.
    if (context.JsonPropertyInfo?.Name == "email")
    {
        schema.Format = "email";
        schema.Example = JsonValue.Create("dev@example.com");
    }

    return Task.CompletedTask;
});
```

Der **Document**-Kontext (`OpenApiDocumentTransformerContext`) stellt `DocumentName`, `DescriptionGroups` (die `ApiDescriptionGroups`) und `ApplicationServices` bereit. Sie greifen zu Document-Transformern, wenn das Ziel das Dokument-Wurzelelement ist, meistens das Sicherheitsschema, das ich weiter unten behandle.

## Die Ausführungsreihenfolge ist Schema, dann Operation, dann Document

Das ist der Teil, der "meine Änderung ist verschwunden"-Fehlermeldungen erzeugt. Transformer laufen nicht in der Reihenfolge, die Sie beim Lesen der Datei erwarten würden. Das Framework führt sie in dieser Reihenfolge aus:

- **Schema-Transformer zuerst.** Alle Schemata werden dem Dokument registriert, bevor irgendeine Operation verarbeitet wird, daher läuft jeder Schema-Transformer vor jedem Operation-Transformer. Innerhalb der Schema-Transformer laufen sie in Registrierungsreihenfolge, und ein späterer sieht die Mutationen eines früheren.
- **Operation-Transformer als Nächstes.** Jeder läuft, wenn seine Operation hinzugefügt wird, in Registrierungsreihenfolge, nachdem alle Schemata existieren. Wenn ein Operation-Transformer läuft, sind die Schemata für die Typen in dieser Operation bereits geformt.
- **Document-Transformer zuletzt.** Sie laufen im finalen Durchlauf, wenn jede Operation und jedes Schema vorhanden ist. Ein späterer Document-Transformer sieht die Bearbeitungen des früheren.

Die praktische Folge: Wenn ein Document-Transformer voraussetzt, dass ein Schema bereits auf eine bestimmte Weise geformt ist, dann ist es das auch, weil Schemata zuerst liefen. Aber ein Operation-Transformer kann sich nicht darauf verlassen, dass ein Document-Transformer gelaufen ist, weil Documents zuletzt laufen. Wenn Sie mehrere Dokumente erzeugen, läuft die gesamte Pipeline pro Dokument unabhängig, sodass ein auf dem `internal`-Dokument registrierter Transformer niemals `public` berührt.

## Stark typisierte Transformer und Dependency Injection

Inline-Delegaten sind für zustandslose Anpassungen in Ordnung. Wenn ein Transformer einen Dienst benötigt, implementieren Sie die Schnittstelle und registrieren den Typ, damit das Framework ihn aus der DI aktiviert. Die Schnittstellen sind `IOpenApiDocumentTransformer`, `IOpenApiOperationTransformer` und `IOpenApiSchemaTransformer`, jede mit einem einzigen `TransformAsync`. Verwenden Sie einen Primary Constructor zum Injizieren:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

internal sealed class BearerSecuritySchemeTransformer(
    IAuthenticationSchemeProvider authenticationSchemeProvider) : IOpenApiDocumentTransformer
{
    public async Task TransformAsync(
        OpenApiDocument document,
        OpenApiDocumentTransformerContext context,
        CancellationToken cancellationToken)
    {
        var schemes = await authenticationSchemeProvider.GetAllSchemesAsync();
        if (schemes.Any(s => s.Name == "Bearer"))
        {
            document.Components ??= new OpenApiComponents();
            document.Components.SecuritySchemes["Bearer"] = new OpenApiSecurityScheme
            {
                Type = SecuritySchemeType.Http,
                Scheme = "bearer",
                In = ParameterLocation.Header,
                BearerFormat = "JSON Web Token"
            };
        }
    }
}

// Registration
builder.Services.AddOpenApi(options =>
{
    options.AddDocumentTransformer<BearerSecuritySchemeTransformer>();
});
```

Registrieren Sie einen DI-aktivierten Transformer mit der generischen Überladung (`AddDocumentTransformer<T>()`), einer vorgefertigten Instanz (`AddDocumentTransformer(new T())`) oder einem Delegaten. Nur die generische Form nimmt an der Dependency Injection teil. Die generische Form wird pro Dokumenterzeugung frisch aufgelöst und danach verworfen, sodass ein Transformer, der `IDisposable` implementiert, bei jeder Dokumenterzeugung aufgeräumt wird. Diese Lebensdauer pro Erzeugung ist der Grund, warum Sie Transformer günstig halten sollten: Bei einem aktiven `MapOpenApi`-Endpunkt läuft die Pipeline bei jeder Anfrage an die Dokument-Route. Wenn das Dokument teuer zu erzeugen ist, cachen Sie den Endpunkt mit `.CacheOutput()` oder erzeugen Sie es stattdessen zur [Build-Zeit](/de/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/).

Ein Sicherheitsschema zu registrieren ist die kanonische Aufgabe eines Document-Transformers. Wenn Sie ein Schema verdrahtet haben, der Betrachter das Token aber weiterhin ignoriert, liegt die Ursache fast immer an einem fehlerhaften Schema im Dokument statt an einem Client-Fehler, was ich von Anfang bis Ende in [warum Ihr Bearer-Token in Scalar ignoriert wird](/de/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/) nachverfolgt habe. Für den passenden Swagger-UI-Ablauf pro Endpunkt siehe [OpenAPI-Authentifizierungsflüsse hinzufügen](/de/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/).

## Operation-Transformer pro Endpunkt

Sie wollen nicht immer eine Änderung an jeder Operation. Ein auf einem einzelnen Endpunkt registrierter Operation-Transformer läuft nur für diesen Endpunkt, über `AddOpenApiOperationTransformer` auf dem Endpunkt-Builder. Eine einzelne Route als veraltet zu markieren ist ein Einzeiler:

```csharp
// .NET 11, C# 14
app.MapGet("/v1/report", GenerateReport)
   .AddOpenApiOperationTransformer((operation, context, cancellationToken) =>
   {
       operation.Deprecated = true;
       operation.Description = "Superseded by /v2/report. Removed in the next major version.";
       return Task.CompletedTask;
   });
```

Das grenzt sauber ein: kein Schnüffeln an `context.Description`, kein Routenabgleich, nur der Endpunkt, an den Sie es angehängt haben. Es passt gut zur Gruppierung von Endpunkten, denn ein an eine Gruppe angehängter Transformer fließt zu jeder Operation darin. Siehe [Minimal-API-Endpunkte mit MapGroup organisieren](/de/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) für dieses Muster.

## Ein Schema zur Laufzeit erzeugen

Manchmal benötigt ein Operation-Transformer ein Schema für einen Typ, den der Endpunkt ansonsten nicht referenziert, zum Beispiel einen gemeinsamen Fehlerkörper. Seit .NET 10 stellt der Transformer-Kontext `GetOrCreateSchemaAsync` bereit, das ein Schema mit derselben Logik erzeugt, die der Generator verwendet, und `context.Document.AddComponent`, das es unter `components.schemas` zur Wiederverwendung ablegt:

```csharp
// .NET 11, C# 14
options.AddOperationTransformer(async (operation, context, cancellationToken) =>
{
    var errorSchema = await context.GetOrCreateSchemaAsync(
        typeof(ProblemDetails), null, cancellationToken);
    context.Document?.AddComponent("Error", errorSchema);

    operation.Responses ??= new OpenApiResponses();
    operation.Responses["4XX"] = new OpenApiResponse
    {
        Description = "Bad request.",
        Content = new Dictionary<string, OpenApiMediaType>
        {
            ["application/problem+json"] = new OpenApiMediaType
            {
                Schema = new OpenApiSchemaReference("Error", context.Document)
            }
        }
    };
});
```

Das ist der saubere Weg, einen konsistenten Fehlervertrag zu dokumentieren, ohne jeden Endpunkt mit `Produces<ProblemDetails>` zu dekorieren. Wenn Sie die Fehlerantworten selbst formen statt sie nur zu dokumentieren, ist das ein separates Anliegen, das von [IProblemDetailsService](/de/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/) behandelt wird.

## Microsoft.OpenApi-v2-Typänderungen, die alte Beispiele brechen

.NET 10 hat die `Microsoft.OpenApi`-Abhängigkeit auf v2 angehoben, und das Objektmodell hat sich auf Weisen geändert, die nicht kompilieren, wenn Sie einen .NET-8-Transformer einfügen. Drei Änderungen beißen am meisten:

**`OpenApiSchema.Type` ist jetzt ein Flags-Enum, kein String.** In v1 schrieben Sie `Type = "string"` mit einem separaten `Nullable = true`. In v2 ist `Type` ein nullbares `JsonSchemaType`, und Nullbarkeit wird durch Vereinigung mit dem `Null`-Flag ausgedrückt:

```csharp
// .NET 11, Microsoft.OpenApi v2
// A nullable string:
schema.Type = JsonSchemaType.String | JsonSchemaType.Null;
```

**Beispiele sind `JsonNode`, nicht `OpenApiString`.** Die gesamte `IOpenApiAny`-Hierarchie (`OpenApiString`, `OpenApiInteger`, `OpenApiObject`) wurde entfernt. Weisen Sie stattdessen ein `System.Text.Json.Nodes.JsonNode` zu, weshalb das Eigenschaftsbeispiel oben `JsonValue.Create(...)` verwendet hat. Für ein Objektbeispiel bauen Sie ein `JsonObject`. Das ist die einzelne Bearbeitung, die beim Migrieren alter Schema-Filter am ehesten nicht kompiliert, worauf ich im [Migrationsleitfaden von Swashbuckle zum Eingebauten](/de/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/) näher eingehe.

**Referenzen sind typisiert.** Statt eine `OpenApiReference` von Hand zu bauen, verwenden Sie `OpenApiSchemaReference("Name", document)` und `OpenApiSecuritySchemeReference("Bearer", document)`. Diese lösen gegen das Dokument auf, das Sie übergeben, wodurch eine hängende Referenz bei der Konstruktion statt bei der Serialisierung abgefangen wird.

## Fallstricke, die auftauchen, nachdem das Dokument richtig aussieht

**Schema-Transformer können mehr als einmal für denselben Typ laufen.** Ein Schema-Transformer feuert pro Schema-Vorkommen, und der Durchlauf, der identische Schemata in `components.schemas` dedupliziert, läuft *nach* allen Transformern. Ein an drei Stellen verwendeter Typ kann seinen Schema-Transformer also dreimal aufrufen lassen. Halten Sie die Logik idempotent: prüfen Sie, bevor Sie hinzufügen, und hängen Sie nie an eine Liste an, die Sie möglicherweise erneut besuchen.

**Schema-Wiederverwendung ist nichts, was Sie von einem Transformer aus steuern.** Ob ein Schema inline eingefügt oder in `components.schemas` gehoben wird, entscheidet das Framework, nachdem Transformer gelaufen sind, mithilfe von `OpenApiOptions.CreateSchemaReferenceId`. Enums werden immer referenziert; um sie stattdessen inline einzufügen, geben Sie aus diesem Delegaten `null` für Enum-Typen zurück:

```csharp
// .NET 11, C# 14
options.CreateSchemaReferenceId = type =>
    type.Type.IsEnum ? null : OpenApiOptions.CreateDefaultSchemaReferenceId(type);
```

**Ein Operation-Transformer kann die Arbeit eines Document-Transformers nicht sehen.** Weil Documents zuletzt laufen, legen Sie kein Schema in einen Document-Transformer und versuchen nicht, es aus einem Operation-Transformer im selben Durchlauf zu referenzieren. Registrieren Sie das Schema *und* die Anforderung pro Operation aus demselben Document-Transformer, oder wenden Sie die Anforderung pro Operation aus einem Document-Transformer an, der am Ende `document.Paths` durchläuft.

**Nur was der API-Explorer sieht, wird dokumentiert.** Transformer formen, was existiert; sie können keine Operation erfinden, die der Explorer nie entdeckt hat. Wenn eine Minimal API ein blankes `IResult` ohne `Produces<T>` zurückgibt, gibt es kein Antwortschema, das ein Transformer berühren könnte. Annotieren Sie zuerst den Endpunkt. Genaue Schemata zählen auch stromabwärts, denn ein [stark typisierter Client-Generator](/de/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/) ist nur so gut wie das Dokument, das Sie ihm zuführen.

Das mentale Modell ist klein, sobald es klickt: Schemata werden zuerst geformt, Operationen als Nächstes, das Dokument zuletzt, und jeder Transformer berührt nur die Ebene, nach der er benannt ist. Wählen Sie die Ebene, mutieren Sie an Ort und Stelle, halten Sie es idempotent, und das Dokument, das Sie ausliefern, ist genau das, das Ihre Konsumenten und Codegeneratoren erwarten.

## Weiterführende Lektüre

- [Wie man OpenAPI ohne Swashbuckle in ASP.NET Core 11 bereitstellt](/de/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/)
- [Von Swashbuckle zur eingebauten OpenAPI-Dokumenterzeugung in .NET 11 migrieren](/de/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/)
- [Wie man OpenAPI-Authentifizierungsflüsse zur Swagger UI in .NET 11 hinzufügt](/de/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/)
- [Scalar in ASP.NET Core: warum Ihr Bearer-Token ignoriert wird](/de/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/)
- [Wie man Minimal-API-Endpunkte mit MapGroup in ASP.NET Core 11 organisiert](/de/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)

## Quellen

- [Customize OpenAPI documents, ASP.NET Core docs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/customize-openapi?view=aspnetcore-10.0)
- [IOpenApiOperationTransformer, .NET API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.openapi.iopenapioperationtransformer)
- [IOpenApiSchemaTransformer, .NET API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.openapi.iopenapischematransformer)
- [Breaking change: Microsoft.OpenApi upgraded to v2, ASP.NET Core docs](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/11/microsoft-openapi-3x?view=aspnetcore-10.0)
- [Microsoft.OpenAPI v2 upgrade guide](https://github.com/microsoft/OpenAPI.NET/blob/main/docs/upgrade-guide-2.md)
