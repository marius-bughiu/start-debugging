---
title: "Von Swashbuckle zum integrierten OpenAPI-Generator in .NET 11 migrieren"
description: "Eine Schritt-für-Schritt-Migration von Swashbuckle.AspNetCore zu Microsoft.AspNetCore.OpenApi in .NET 11: AddSwaggerGen durch AddOpenApi ersetzen, Operations-, Schema- und Dokument-Filter in Transformer umwandeln, eine UI behalten und die Breaking Changes von Microsoft.OpenApi v2, die zubeißen."
pubDate: 2026-06-16
updatedDate: 2026-06-16
template: migration
tags:
  - "migration"
  - "swashbuckle"
  - "openapi"
  - "aspnetcore-11"
  - "dotnet-11"
lang: "de"
translationOf: "2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-06-16
---

Wenn Ihr ASP.NET-Core-Projekt noch `builder.Services.AddSwaggerGen()` und `app.UseSwagger()` aufruft, verwenden Sie Swashbuckle.AspNetCore, das Paket, das die OpenAPI-Geschichte in .NET fast ein Jahrzehnt lang getragen hat. Seit .NET 9 enthalten die Web-API-Templates es nicht mehr: ein neues Projekt nutzt stattdessen das eigene Paket von Microsoft, `Microsoft.AspNetCore.OpenApi`. Dieser Artikel migriert eine bestehende Swashbuckle-Codebasis auf den integrierten Generator unter `net11.0` mit C# 14 und behandelt den Teil, den die Anleitungen für neue Projekte überspringen: was zu entfernen ist, wie jeder `IOperationFilter`, `ISchemaFilter` und `IDocumentFilter` auf einen Transformer abgebildet wird, wie eine anklickbare UI erhalten bleibt und welche Breaking Changes von Microsoft.OpenApi v2 erst kompilieren, wenn Sie sie korrigieren.

Für eine kleine API mit ein paar Filtern ist das ein Nachmittag. Für einen großen Dienst mit einem Dutzend eigener Filter, Beispiel-Providern und mehreren `SwaggerDoc`-Versionen sollten Sie einen Tag einplanen. Swashbuckle ist nicht veraltet, das hier ist also eine Wahl und kein Zwang. Der Grund, es zu tun, ist, dass der integrierte Generator mitgeliefert wird, dem Runtime Release für Release folgt, Native AOT unterstützt und standardmäßig OpenAPI 3.1 ausgibt. Der Grund zu warten ist, wenn Sie auf UI-Funktionen von Swashbuckle oder Community-Filter angewiesen sind, die noch kein Transformer-Äquivalent haben. Entscheiden Sie das vor dem Start, nicht auf halbem Weg.

## Warum jetzt migrieren

- Der Generator kommt mit dem Framework. Kein in Ihren Build gepinntes Drittanbieter-Paket, das einem .NET-Release hinterherhinkt, was genau der .NET-6-Schmerz war, der Microsoft dazu brachte, das zu übernehmen.
- Er nutzt die Schema-Unterstützung von `System.Text.Json` wieder, die der Rest Ihrer App bereits verwendet, sodass die Schemas im Dokument zu dem passen, was Ihre API tatsächlich serialisiert.
- Er ist Native-AOT-kompatibel. Die reflexionslastige Generierung von Swashbuckle ist es nicht, ein AOT-Minimal-API-Dienst musste Swashbuckle also ohnehin aufgeben.
- OpenAPI 3.1 und JSON Schema draft 2020-12 sind die Standardwerte, nicht ein Opt-in.

## Was bricht

| Bereich | Änderung | Schweregrad |
| --- | --- | --- |
| `AddSwaggerGen` / `UseSwagger` | Ersetzt durch `AddOpenApi` / `MapOpenApi`; andere Route (`/openapi/v1.json`, nicht `/swagger/v1/swagger.json`) | hoch |
| `IOperationFilter` / `ISchemaFilter` / `IDocumentFilter` | Werden nicht mehr aufgerufen; als `AddOperationTransformer` / `AddSchemaTransformer` / `AddDocumentTransformer` neu schreiben | hoch |
| Gebündeltes Swagger UI | Das Framework generiert nur JSON; eine UI (Scalar oder das eigenständige Swagger-UI-Paket) fügen Sie selbst hinzu | hoch |
| Namespace `Microsoft.OpenApi` | v2 verschiebt Typen von `Microsoft.OpenApi.Models` nach `Microsoft.OpenApi`; `OpenApiSchema` wird zu `IOpenApiSchema` | mittel |
| Schema-Beispiele | `OpenApiString`/`IOpenApiAny` entfallen; Beispiele sind jetzt `System.Text.Json.Nodes.JsonNode` | mittel |
| Standard-Spec-Version | Swashbuckle nutzte standardmäßig OpenAPI 3.0; der integrierte Generator nutzt 3.1 | mittel |
| `SwaggerDoc("v1", ...)` | Ersetzt durch `AddOpenApi("v1")` plus einen Dokument-Transformer für `Info` | niedrig |
| `[SwaggerOperation]` / `EnableAnnotations` | Ersetzt durch Minimal-API-Metadaten (`WithSummary`, `WithDescription`, `WithTags`) | niedrig |

## Pre-Flight-Checkliste

1. Installieren Sie das .NET 11 SDK auf jeder Entwicklungsmaschine und jedem CI-Runner. Prüfen Sie mit `dotnet --list-sdks` und bestätigen Sie, dass `11.0.x` erscheint.
2. Inventarisieren Sie Ihre Swashbuckle-Oberfläche. Durchsuchen Sie die Lösung nach `AddSwaggerGen`, `OperationFilter<`, `SchemaFilter<`, `DocumentFilter<`, `SwaggerDoc`, `EnableAnnotations` und `[SwaggerOperation`. Die Liste der Filter ist der eigentliche Umfang der Migration.
3. Erfassen Sie ein Referenzdokument. Führen Sie die App aus und speichern Sie `/swagger/v1/swagger.json` in eine Datei. Am Ende vergleichen Sie das neue Dokument damit.
4. Notieren Sie jeden Consumer, der an OpenAPI 3.0 gebunden ist. Ein Client-Generator, der an 3.1 scheitert, ist die häufigste Überraschung, und Sie lösen das weiter unten mit einer Zeile.
5. Committen Sie eine saubere Basis, damit der Rollback ein einziger Befehl ist.

## Migrationsschritte

### 1. Die Pakete tauschen

Entfernen Sie das Generator-Paket und fügen Sie das des Frameworks hinzu. Wenn Sie das Aussehen von Swagger UI behalten möchten, behalten Sie nur dessen UI-Asset-Paket, das vom Generator getrennt ist.

```dotnetcli
# .NET 11
dotnet remove package Swashbuckle.AspNetCore
dotnet add package Microsoft.AspNetCore.OpenApi
```

Wenn Sie `Swashbuckle.AspNetCore.Filters` (das Community-Filter-Paket für Beispiele/Auth) verwendet haben, entfernen Sie es ebenfalls; seine Funktionen werden zu Transformern. **Prüfen:** `dotnet build` ist erfolgreich oder scheitert nur an den jetzt fehlenden `AddSwaggerGen`-/Filter-Symbolen, die Sie gleich ersetzen. Eine saubere Kompilierung hier würde bedeuten, dass Sie Swashbuckle nie wirklich verwendet haben.

### 2. Die beiden Registrierungsaufrufe ersetzen

Das ist der zentrale Tausch. Swashbuckle registrierte einen Generator und zwei Middlewares; die integrierte Version registriert einen Dienst und mappt einen Endpunkt.

```csharp
// Before -- Swashbuckle, ASP.NET Core 8 style
builder.Services.AddSwaggerGen(c =>
{
    c.SwaggerDoc("v1", new OpenApiInfo { Title = "Todo API", Version = "v1" });
});

var app = builder.Build();

app.UseSwagger();
app.UseSwaggerUI();
```

```csharp
// After -- .NET 11, C# 14
builder.Services.AddOpenApi();

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}
```

Das Dokument wandert von `/swagger/v1/swagger.json` nach `/openapi/v1.json`. Der Standard-Dokumentname ist `v1`, woher der Routenname stammt. Beachten Sie den `IsDevelopment()`-Filter: ein OpenAPI-Dokument ist eine vollständige Karte Ihrer Angriffsfläche, stellen Sie es also standardmäßig nicht ins öffentliche Internet. **Prüfen:** führen Sie die App aus und rufen Sie `/openapi/v1.json` ab. Sie sollten ein 3.1-Dokument erhalten, das jeden Endpunkt auflistet. Der `Info`-Block ist vorerst generisch; Schritt 4 behebt das.

### 3. Eine UI zurückbringen

Swashbuckle bündelte Swagger UI, also funktionierte `/swagger` einfach. Der integrierte Generator erzeugt nur JSON. Wählen Sie einen Viewer und richten Sie ihn auf das Dokument aus. Der Template-Standard seit .NET 9 ist Scalar:

```csharp
// .NET 11, C# 14
using Scalar.AspNetCore;

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.MapScalarApiReference();
}
```

Wenn Ihr Team an Swagger UI hängt, funktioniert es weiterhin. Installieren Sie `Swashbuckle.AspNetCore.SwaggerUi` (nur die UI-Assets, nicht den Generator) und richten Sie es auf die neue Route aus:

```csharp
// .NET 11, C# 14
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.UseSwaggerUI(options =>
    {
        options.SwaggerEndpoint("/openapi/v1.json", "v1");
    });
}
```

**Prüfen:** öffnen Sie `/scalar` (oder `/swagger`) und bestätigen Sie, dass die Operationen gerendert werden und "Try it out" Ihre API erreicht. Die Greenfield-Details zu jedem Viewer finden Sie in [OpenAPI ohne Swashbuckle in ASP.NET Core 11 bereitstellen](/de/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/).

### 4. Dokument-Metadaten in einen Transformer verschieben

`SwaggerDoc("v1", new OpenApiInfo { ... })` setzte Titel, Version und Beschreibung. Im integrierten Modell ist das ein Dokument-Transformer, der über das `OpenApiDocument` läuft, bevor es serialisiert wird.

```csharp
// .NET 11, C# 14
using Microsoft.OpenApi;

builder.Services.AddOpenApi(options =>
{
    options.AddDocumentTransformer((document, context, cancellationToken) =>
    {
        document.Info = new OpenApiInfo
        {
            Title = "Todo API",
            Version = "v1",
            Description = "Task tracking endpoints."
        };
        return Task.CompletedTask;
    });
});
```

Achten Sie auf das `using`. Mit Microsoft.OpenApi v2 (von dem nun sowohl Swashbuckle v10 als auch `Microsoft.AspNetCore.OpenApi` abhängen) wurden die Modelltypen von `Microsoft.OpenApi.Models` nach `Microsoft.OpenApi` verschoben. Wenn Sie alten `OpenApiInfo`-Code wortwörtlich kopieren, wird er nicht aufgelöst. **Prüfen:** laden Sie das Dokument neu und bestätigen Sie, dass der `info`-Block Ihren Titel und Ihre Beschreibung zeigt.

### 5. Operations-Filter in Operations-Transformer umwandeln

Ein `IOperationFilter` lief einmal pro Operation, um eine Antwort, einen Header oder eine Beschreibung hinzuzufügen. Die Signatur des Transformers ist anders, aber der Rumpf ist nahezu identisch.

```csharp
// Before -- Swashbuckle IOperationFilter
public class AddThrottleResponseFilter : IOperationFilter
{
    public void Apply(OpenApiOperation operation, OperationFilterContext context)
    {
        operation.Responses.TryAdd("429",
            new OpenApiResponse { Description = "Too Many Requests" });
    }
}
// registered: c.OperationFilter<AddThrottleResponseFilter>();
```

```csharp
// After -- .NET 11, C# 14
builder.Services.AddOpenApi(options =>
{
    options.AddOperationTransformer((operation, context, cancellationToken) =>
    {
        operation.Responses ??= new OpenApiResponses();
        operation.Responses["429"] = new OpenApiResponse
        {
            Description = "Too Many Requests"
        };
        return Task.CompletedTask;
    });
});
```

Der `OperationFilterContext` hatte `ApiDescription`; das `context` des Transformers stellt dasselbe `ApiDescription` bereit, jede bedingte Logik, die auf Route, HTTP-Methode oder Metadaten basiert, wird also übernommen. **Prüfen:** suchen Sie einen Endpunkt, den Ihr Filter ansprach, und bestätigen Sie, dass die `429`-Antwort (oder was Sie hinzugefügt haben) im Dokument daran erscheint.

### 6. Schema- und Dokument-Filter umwandeln

`ISchemaFilter` wird zu `AddSchemaTransformer`. Der Kontext übergibt nun ein `JsonTypeInfo` statt eines `Type`, Sie lesen also `context.JsonTypeInfo.Type`:

```csharp
// After -- .NET 11, C# 14
options.AddSchemaTransformer((schema, context, cancellationToken) =>
{
    if (context.JsonTypeInfo.Type == typeof(Todo))
    {
        schema.Description = "A single task tracking item.";
    }
    return Task.CompletedTask;
});
```

`IDocumentFilter` wird zu `AddDocumentTransformer`, demselben Hook, der in Schritt 4 für `Info` verwendet wurde. Nutzen Sie ihn für `servers`, Top-Level-Tags und Sicherheitsschemata. Ein häufiger Fall ist das Deklarieren eines Bearer-Schemas, damit die UI eine Authorize-Schaltfläche zeigt; Sie können das inline tun oder mit einem stark typisierten `IOpenApiDocumentTransformer`, wenn Sie Dienste injizieren müssen. **Prüfen:** kontrollieren Sie, dass die Schema-Beschreibung (oder das Sicherheitsschema) dort auftaucht, wo der alte Filter sie platzierte. Wenn Sie die Authorize-Schaltfläche zusätzlich an ein Sicherheitsschema knüpfen und der Viewer das Token stillschweigend ignoriert, ist es fast immer ein fehlerhaftes Schema, was ich in [warum Ihr Bearer-Token in Scalar ignoriert wird](/de/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/) durchgegangen bin.

### 7. Annotationen durch Minimal-API-Metadaten ersetzen

Wenn Sie `EnableAnnotations()` und `[SwaggerOperation(Summary = "...", Description = "...")]` verwendet haben, entfernen Sie die Attribute und drücken Sie dieselben Metadaten mit Endpunkt-Konventionen aus. Sie fließen direkt in die Operation:

```csharp
// .NET 11, C# 14
app.MapGet("/todos/{id}", (int id) => Results.Ok(new Todo(id, "Write", false)))
   .WithSummary("Get a todo by id")
   .WithDescription("Returns a single todo item, or 404 if it does not exist.")
   .WithTags("Todos")
   .Produces<Todo>(StatusCodes.Status200OK)
   .Produces(StatusCodes.Status404NotFound);
```

Bei Controllern werden die XML-Doc-Kommentare und `[ProducesResponseType]`-Attribute, die Sie bereits haben, vom API Explorer gelesen, vieles davon ist also kostenlos. Wenn Sie Endpunkte mit [MapGroup](/de/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) gruppiert halten, kann ein einziges `WithTags` an der Gruppe jede Operation darin taggen. **Prüfen:** die Zusammenfassungen und Tags werden in der UI gerendert, und `EnableAnnotations` taucht nirgends mehr im Projekt auf.

### 8. Mehrere Dokumente und Versionierung behandeln

Das wiederholte `SwaggerDoc("v1", ...)` / `SwaggerDoc("v2", ...)` von Swashbuckle wird zu wiederholten `AddOpenApi`-Aufrufen, jeder mit eigenem Namen und eigenen Optionen. Welche Endpunkte in welches Dokument gelangen, entscheidet `ShouldInclude`:

```csharp
// .NET 11, C# 14
builder.Services.AddOpenApi("public", options =>
{
    options.ShouldInclude = description =>
        description.GroupName is null || description.GroupName == "public";
});
builder.Services.AddOpenApi("internal");
```

Jeder Name erhält seine eigene Route: `/openapi/public.json` und `/openapi/internal.json`. Wenn Sie `Asp.Versioning` einsetzen, integriert es sich mit diesem Dokumentmodell, statt dagegen zu kämpfen. **Prüfen:** rufen Sie jede Dokumentroute ab und bestätigen Sie, dass in jeder die richtigen Endpunkte erscheinen.

## Verifizierung

Führen Sie diese Checkliste aus, bevor Sie den alten Codepfad löschen:

- `dotnet build` ist sauber mit null Warnungen, einschließlich verbliebener `Microsoft.OpenApi.Models`-Verweise.
- `dotnet test` läuft durch, insbesondere jeder Vertragstest, der den alten Pfad `/swagger/v1/swagger.json` festgepinnt hatte; aktualisieren Sie diese auf `/openapi/v1.json`.
- Vergleichen Sie das neue `/openapi/v1.json` mit der Referenz, die Sie im Pre-Flight gespeichert haben. Erwarten Sie, dass sich die Versionszeile von `3.0.x` auf `3.1.x` ändert und die `nullable`-Behandlung in den Schemas abweicht; alles Übrige sollte Operation für Operation übereinstimmen.
- Jeder Endpunkt, den Ihre alten Filter berührten, trägt weiterhin dieselben Antworten, Header und Beschreibungen.
- Die UI lädt und "Try it out" erreicht einen echten Endpunkt.
- Wenn Sie einen Client aus dem Spec generieren, generieren Sie ihn neu und bestätigen Sie, dass er weiterhin kompiliert. Siehe [einen stark typisierten Client aus einem OpenAPI-Spec generieren](/de/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/).

## Rollback-Plan

Diese Migration ist umkehrbar, bis Sie anfangen, die Filterklassen zu löschen. Zum Zurückrollen `dotnet remove package Microsoft.AspNetCore.OpenApi`, fügen Sie `Swashbuckle.AspNetCore` wieder hinzu und stellen Sie `AddSwaggerGen` / `UseSwagger` / `UseSwaggerUI` wieder her. Da die Umschreibungen von Filter zu Transformer In-Place-Bearbeitungen sind, ist der saubere Commit aus dem Pre-Flight Ihr eigentlicher Rollback: `git checkout` des Commits und Sie sind in einem Schritt zurück bei Swashbuckle. Führen Sie die Migration auf einem Branch durch und behalten Sie den Referenz-Commit, bis das neue Dokument in einer echten Umgebung gelaufen ist.

## Stolpersteine, auf die wir trafen

**Der OpenAPI-3.1-Standard bricht Tooling, das nur 3.0 versteht.** Das ist das häufigste Ticket nach der Migration. Wenn ein nachgelagerter Generator das Dokument ablehnt, senken Sie die Version explizit, statt die gesamte Migration zurückzunehmen:

```csharp
// .NET 11, C# 14
using Microsoft.OpenApi;

builder.Services.AddOpenApi(options =>
{
    options.OpenApiVersion = OpenApiSpecVersion.OpenApi3_0;
});
```

**Schema-Beispiele sind jetzt `JsonNode`, nicht `OpenApiString`.** Microsoft.OpenApi v2 hat die `IOpenApiAny`-Hierarchie fallen lassen. Wenn ein Schema-Filter `schema.Example = new OpenApiString("...")` setzte, weist das Transformer-Äquivalent ein `System.Text.Json.Nodes.JsonNode` zu, zum Beispiel `JsonValue.Create("...")` oder ein `JsonObject`. Das ist die einzelne Bearbeitung, die während des Umschreibens am wahrscheinlichsten nicht kompiliert.

**Das Dokument wird bei jeder Anfrage neu generiert.** `MapOpenApi` führt die vollständige Pipeline bei jedem Treffer auf den Endpunkt aus, absichtlich, damit Transformer auf Live-Zustand reagieren können. Für ein stark frequentiertes Dokument cachen Sie es mit `.CacheOutput()` am Endpunkt oder generieren Sie es zur Buildzeit mit `Microsoft.Extensions.ApiDescription.Server` und liefern Sie eine statische Datei aus. Die Buildzeit-Generierung führt Ihre `Program.cs` aus, schützen Sie also Startup-Code (wie das Öffnen einer Datenbankverbindung) über den Namen des Einstiegsassemblys, wenn er während des Builds nicht laufen soll.

**Abgeleitete Schemas sind strenger als die von Swashbuckle.** Der integrierte Generator dokumentiert nur, was der API Explorer sieht. Wenn ein Minimal-Endpunkt `IResult` ohne typisierte Überladung oder `Produces<T>`-Aufruf zurückgibt, fehlt das Antwortschema. Swashbuckle übertünchte das manchmal mit Reflexion; der neue Generator will die Annotation. Fügen Sie `Produces<T>` und `Accepts<T>` hinzu, wo das Schema verschwindet.

**`OpenApiSchema` ist jetzt eine Schnittstelle.** Code, der `OpenApiSchema schema` als Parameter oder lokale Variable deklarierte, benötigt möglicherweise `IOpenApiSchema`, und die Eigenschaft `Nullable` ist zugunsten von `JsonSchemaType.Null` entfallen. Wenn Sie aufwendige Schema-Filter geschrieben haben, landen hier die meisten Kompilierfehler.

Das mentale Modell ist klein, sobald es einrastet: das Framework besitzt das Dokument, Transformer ersetzen Filter, und die UI ist ein separates, austauschbares Anliegen. Der Großteil der Arbeit sind die Umschreibungen von Filter zu Transformer sowie die Namespace- und Typänderungen von Microsoft.OpenApi v2; der Registrierungstausch selbst sind zwei Zeilen.

## Verwandte Lektüre

- [OpenAPI ohne Swashbuckle in ASP.NET Core 11 bereitstellen](/de/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/)
- [Minimal-API-Endpunkte mit MapGroup in ASP.NET Core 11 organisieren](/de/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [Stark typisierten Client-Code aus einem OpenAPI-Spec in .NET 11 generieren](/de/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/)
- [Scalar in ASP.NET Core: warum Ihr Bearer-Token ignoriert wird](/de/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/)
- [Von .NET 8 auf .NET 11 migrieren: die vollständige Checkliste](/de/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/)

## Quellen

- [Generate OpenAPI documents, ASP.NET-Core-Dokumentation](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/aspnetcore-openapi?view=aspnetcore-10.0)
- [Customize OpenAPI documents, ASP.NET-Core-Dokumentation](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/customize-openapi?view=aspnetcore-10.0)
- [Swashbuckle.AspNetCore migrating to v10](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/blob/master/docs/migrating-to-v10.md)
- [Microsoft.AspNetCore.OpenApi auf NuGet](https://www.nuget.org/packages/Microsoft.AspNetCore.OpenApi/)
- [Microsoft.Extensions.ApiDescription.Server auf NuGet](https://www.nuget.org/packages/Microsoft.Extensions.ApiDescription.Server)
</content>
