---
title: "Fix: Swagger UI zeigt Unable to render this definition nach dem Upgrade auf .NET 11"
description: "ASP.NET Core 11 gibt standardmäßig openapi 3.2.0 aus, und Swagger UI unter 10.1.5 lehnt das ab. Swashbuckle.AspNetCore.SwaggerUI aktualisieren oder OpenApiVersion auf OpenApi3_1 setzen."
pubDate: 2026-08-19
template: error-page
tags:
  - "errors"
  - "openapi"
  - "swagger"
  - "swashbuckle"
  - "aspnetcore"
  - "dotnet-11"
lang: "de"
translationOf: "2026/08/fix-swagger-ui-unable-to-render-this-definition-after-upgrading-to-dotnet-11"
translatedBy: "claude"
translationDate: 2026-08-19
---

Ihre API startet weiterhin, `/openapi/v1.json` liefert weiterhin 200, aber die Swagger-UI-Seite zeigt nur noch einen grauen Kasten mit dem Hinweis, die Definition gebe kein gültiges Versionsfeld an. Ursache ist eine geänderte Voreinstellung in .NET 11: `AddOpenApi` schreibt jetzt `"openapi": "3.2.0"` statt `"openapi": "3.1.1"`, und das Swagger-UI-Bundle in `Swashbuckle.AspNetCore.SwaggerUI` 10.1.4 und früher akzeptiert nur `3.0.x` und `3.1.x`. Aktualisieren Sie dieses Paket auf 10.1.5 oder neuer, oder setzen Sie `options.OpenApiVersion = OpenApiSpecVersion.OpenApi3_1`. An Ihren Endpunkten, Transformern oder Schemas ist nichts defekt.

Alles Folgende wurde mit dem .NET SDK `11.0.100-preview.7.26381.103` und `Microsoft.AspNetCore.OpenApi` `11.0.0-preview.7.26381.103` gemessen (das `Microsoft.OpenApi` 3.9.0 auflöst), im Vergleich zum .NET SDK 10.0.201 mit `Microsoft.AspNetCore.OpenApi` 10.0.10.

## Der Fehler im Kontext

Swagger UI ersetzt die gesamte Operationsliste durch dieses Panel:

```text
Unable to render this definition

The provided definition does not specify a valid version field.

Please indicate a valid Swagger or OpenAPI version field. Supported version
fields are swagger: "2.0" and those that match openapi: 3.x.y (for example,
openapi: 3.1.0).
```

Die Formulierung führt in zwei Punkten in die Irre. Das Dokument hat sehr wohl ein Versionsfeld, und `3.2.0` entspricht sehr wohl der Form `3.x.y`, die die Meldung beschreibt. Tatsächlich vergleicht das Bundle Major- und Minor-Komponente gegen eine feste Positivliste, und `3.2` steht in älteren Builds nicht darauf.

Es gibt keine serverseitige Ausnahme zu finden. Der Dokument-Endpunkt ist gesund:

```bash
curl -s http://localhost:5331/openapi/v1.json | head -3
```

```json
{
  "openapi": "3.2.0",
  "info": {
```

Diese erste Zeile ist der ganze Fehler. Wenn dort `3.2.0` steht und im Browser ein grauer Kasten erscheint, sind Sie auf der richtigen Seite.

## Warum .NET 11 openapi 3.2.0 ausgibt

`OpenApiOptions.OpenApiVersion` hat seine Voreinstellung in .NET 11 Preview 6 von `OpenApiSpecVersion.OpenApi3_1` auf `OpenApiSpecVersion.OpenApi3_2` geändert. Microsoft dokumentiert das als beabsichtigte Verhaltensänderung, damit Anwendungen die neueste Spezifikation ohne Zusatzkonfiguration übernehmen ([OpenApiVersion nutzt standardmäßig OpenApi3_2](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/11/openapi-version-default-3-2?view=aspnetcore-10.0)).

Erreichbar wurde diese Voreinstellung durch eine zweite Änderung eine Preview früher: In .NET 11 Preview 3 wechselte `Microsoft.AspNetCore.OpenApi` von `Microsoft.OpenApi` 2.x auf 3.x, und erst die 3.x-Linie brachte die Serialisierer für OpenAPI 3.2.0 ([Microsoft.OpenApi auf 3.x aktualisiert](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/11/microsoft-openapi-3x?view=aspnetcore-10.0)). Die Abhängigkeitsfixierung steht im Paket selbst: `Microsoft.AspNetCore.OpenApi` 11.0.0-preview.7 deklariert `Microsoft.OpenApi` `[3.9.0, 4.0.0)`, während 10.0.10 noch `2.0.0` deklarierte.

Die wichtige Folge: Die Versionszeichenfolge hat sich geändert, das Dokument nicht. Dazu unten mehr.

## Minimale Reproduktion

Drei Zeilen API und eine Swagger-UI-Registrierung genügen.

```xml
<!-- net11.0, .NET SDK 11.0.100-preview.7.26381.103 -->
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.AspNetCore.OpenApi" Version="11.0.0-preview.7.26381.103" />
    <PackageReference Include="Swashbuckle.AspNetCore.SwaggerUI" Version="9.0.6" />
  </ItemGroup>
</Project>
```

```csharp
// .NET 11, C# 14, Microsoft.AspNetCore.OpenApi 11.0.0-preview.7.26381.103
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddOpenApi();

var app = builder.Build();
app.MapOpenApi();
app.UseSwaggerUI(o => o.SwaggerEndpoint("/openapi/v1.json", "v1"));

app.MapGet("/todos/{id:int}", (int id) => new Todo(id, "write post", Status.Open, null));
app.MapPost("/todos", (Todo todo) => Results.Created($"/todos/{todo.Id}", todo));
app.Run();

internal enum Status { Open, Done }
internal record Todo(int Id, string Title, Status Status, DateTimeOffset? DueAt);
```

`/swagger` laden, und der graue Kasten erscheint. Nichts in der Konsole, nichts in den Logs, HTTP 200 sowohl auf der Seite als auch auf dem Dokument.

Beachten Sie: `Swashbuckle.AspNetCore.SwaggerUI` ist ein eigenständiges Paket. Sie brauchen den Swashbuckle-Generator nicht, um darauf zu stoßen: Das Dokument stammt hier vom eingebauten Generator, nur die UI-Assets kommen von Swashbuckle. Wenn Sie einer Anleitung zum [Bereitstellen von OpenAPI ohne Swashbuckle](/de/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/) gefolgt sind, aber die gewohnte Seite `/swagger` behalten haben, läuft bei Ihnen genau diese Konfiguration.

## Welche Swagger-UI-Version ein 3.2.0-Dokument zuerst rendert

Ich habe das Paket gegen dasselbe 3.2.0-Dokument bisektiert. Die Grenze liegt bei `Swashbuckle.AspNetCore.SwaggerUI` 10.1.5:

| SwaggerUI-Paket | Enthaltenes swagger-ui | Rendert `openapi: 3.2.0` |
| --- | --- | --- |
| 9.0.6 | 5.29.1 | Nein |
| 10.0.0 | 5.30.2 | Nein |
| 10.1.0 | 5.31.0 | Nein |
| 10.1.4 | 5.31.1 | Nein |
| 10.1.5 | 5.32.0 | Ja |
| 10.1.7 | 5.32.1 | Ja |
| 10.2.3 | 5.32.7 | Ja |

Ab 10.1.5 zeigt das Kopfzeilen-Badge `OAS 3.2`, und alle Operationen und Schemas rendern normal. Der erste Fix ist also ein einzeiliges Paket-Upgrade:

```xml
<!-- first version whose bundled swagger-ui accepts 3.2.0 -->
<PackageReference Include="Swashbuckle.AspNetCore.SwaggerUI" Version="10.1.5" />
```

Bevorzugen Sie diesen Weg. Er hält Ihr Dokument auf der neuesten Spezifikation und kostet nichts, weil `Swashbuckle.AspNetCore.SwaggerUI` nur statische Assets und eine Middleware-Erweiterung liefert. Wenn Sie stattdessen das vollständige Metapaket `Swashbuckle.AspNetCore` referenzieren, bringt ein Upgrade auf 10.2.x dieselben UI-Assets, zieht aber auch den Generator mit; lesen Sie die Hinweise zum [Fixieren der von Swashbuckle ausgegebenen OpenAPI-Versionszeichenfolge](/de/2026/08/fix-cannot-target-openapi-3-0-after-upgrading-swashbuckle-aspnetcore/), bevor Sie diese Grenze überschreiten.

## Wie Sie das Dokument auf OpenAPI 3.1 zurücksetzen

Wenn Sie das UI-Paket nicht bewegen können oder etwas anderes weiter unten in der Kette 3.2 ebenfalls ablehnt, setzen Sie die Version explizit am Generator:

```csharp
// .NET 11, C# 14. Microsoft.OpenApi 3.9.0 supplies OpenApiSpecVersion.
using Microsoft.OpenApi;

builder.Services.AddOpenApi(options =>
{
    options.OpenApiVersion = OpenApiSpecVersion.OpenApi3_1;
});
```

Das `using Microsoft.OpenApi;` ist wichtig: `OpenApiSpecVersion` liegt im flachen Wurzelnamespace, nicht in `Microsoft.OpenApi.Models`, das bereits in der mit .NET 10 ausgelieferten 2.x-Linie entfernt wurde.

Mit dieser Option schreibt .NET 11 `"openapi": "3.1.2"`, und `Swashbuckle.AspNetCore.SwaggerUI` 9.0.6 rendert es mit einem `OAS 3.1`-Badge. Achten Sie auf die Patch-Komponente: .NET 10 schrieb `3.1.1`, .NET 11 schreibt mit demselben Enum-Wert `3.1.2`. Konsumenten, die die vollständige Versionszeichenfolge statt Major und Minor vergleichen, stolpern weiterhin. `OpenApiSpecVersion.OpenApi3_0` wird ebenfalls weiterhin akzeptiert und erzeugt `3.0.4`.

Sie können mehrere benannte Dokumente registrieren, wenn unterschiedliche Konsumenten unterschiedliche Versionen brauchen:

```csharp
// .NET 11, C# 14
builder.Services.AddOpenApi("v1");                                   // 3.2.0
builder.Services.AddOpenApi("v1-31", o =>
    o.OpenApiVersion = OpenApiSpecVersion.OpenApi3_1);               // 3.1.2
```

Das ergibt `/openapi/v1.json` und `/openapi/v1-31.json` aus denselben Endpunkt-Metadaten, sodass ein alter Client-Generator weiter 3.1 konsumieren kann, während die UI und neuere Clients 3.2 lesen.

## Was tatsächlich im 3.2.0-Dokument enthalten ist

Diesen Punkt sollten Sie verinnerlichen, bevor Sie einen Nachmittag mit dem Prüfen von Transformern verbringen: Für eine normale Minimal API sind das 3.2.0-Dokument und das 3.1.2-Dokument bis auf die Versionszeichenfolge identisch.

Ich habe alle drei Versionen aus einer Anwendung erzeugt (ein Record mit int, string, enum, einem nullbaren `DateTimeOffset` sowie einem Upload per `IFormFile`) und sie verglichen. Der Unterschied zwischen 3.1 und 3.2 waren zwei Zeilen, beide das Feld `openapi` und der Dokumenttitel. Kein einziges Schema, kein Parameter, keine Antwort, keine Komponente hat sich geändert.

Der Unterschied zwischen 3.0 und 3.1 ist dagegen real, denn dort landete die Angleichung an JSON Schema:

```json
// OpenAPI 3.0.4
"dueAt": { "type": "string", "format": "date-time", "nullable": true }
```

```json
// OpenAPI 3.1.2 and 3.2.0
"dueAt": { "type": ["null", "string"], "format": "date-time" }
```

Wenn also ein Client-Generator nach dem Upgrade auf .NET 11 bricht und Sie das mit einem Rückfall auf `OpenApi3_0` "reparieren", haben Sie die Nullbarkeitskodierung jeder optionalen Eigenschaft in Ihrem Vertrag geändert. Fallen Sie stattdessen auf `OpenApi3_1` zurück: Das ist die Version, deren Payload byteweise dem entspricht, was Sie unter .NET 10 bereits ausgeliefert haben.

## Hat Scalar dasselbe Problem

Wenn Sie Ihre Referenz mit [Scalar statt Swagger UI](/de/2026/08/how-to-serve-openapi-docs-with-scalar-instead-of-swagger-ui-in-aspnetcore-11/) ausliefern, erreicht Sie dieser Fehler nicht. Ich habe dieselbe .NET-11-Anwendung gegen `Scalar.AspNetCore` 2.16.20 und 2.14.14 laufen lassen, und beide haben das 3.2.0-Dokument gerendert und `OpenAPI 3.2.0` in der Kopfzeile ausgegeben.

Das gilt, obwohl der NuGet-Graph alarmierend aussieht. `Scalar.AspNetCore.Microsoft` 2.16.20 hat überhaupt keine `net11.0`-Zielgruppe, also löst ein `net11.0`-Projekt die `net10.0`-Assets auf, die gegen `Microsoft.OpenApi` 2.7.5 kompiliert wurden und zur Laufzeit gegen die vereinheitlichte 3.9.0-Assembly geladen werden. Genau davor warnt der Breaking-Change-Hinweis zu Microsoft.OpenApi 3.x, und hier ist es harmlos: `AddScalarTransformers()` und `ExcludeFromApiReference()` funktionierten und gaben die erwartete Erweiterung `x-scalar-ignore` aus.

Dasselbe gilt für handgeschriebene Transformer. Ein Dokumenttransformer, der ein Bearer-Sicherheitsschema registriert, und ein Schematransformer, der `x-schema-id` setzt, beide für .NET 10 gegen `Microsoft.OpenApi` 2.x geschrieben, kompilierten und liefen unverändert unter .NET 11 mit 3.9.0. Wenn Ihre Transformer überwiegend lesen oder nur Erweiterungen und Sicherheitsschemas setzen, planen Sie null Aufwand für den Wechsel von 2.x auf 3.x ein. Wenn sie verschachtelte Schemas durchlaufen, Referenzen konstruieren oder die entfernte `ParseNode`-Parsing-Infrastruktur genutzt haben, lesen Sie zuerst die [Referenz zur Transformer-Pipeline](/de/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/) und die Migrationshinweise von OpenAPI.NET.

## Welche ähnlichen Fehler nicht dieser Fehler sind

**Eine leere Seite ganz ohne grauen Kasten.** Das ist ein anderer Fehler: Die UI hat nie ein Dokument erhalten. Prüfen Sie die Route. `MapOpenApi` liefert `/openapi/{documentName}.json`, und wenn Sie das Muster geändert haben, müssen Sie es der UI mitteilen, entweder mit `SwaggerEndpoint` oder mit `WithOpenApiRoutePattern` von Scalar. Rufen Sie die JSON-URL, die die Seite tatsächlich anfordert, per curl ab, bevor Sie die Versionen verdächtigen.

**HTTP 500 auf der Dokument-URL.** Dann hat ein Transformer eine Ausnahme geworfen, und es gab nichts zu rendern. Der häufigste Fall ist keinerlei .NET-11-Regression: `OpenApiSchema.Extensions` ist `null`, bis Sie zuweisen, sowohl in `Microsoft.OpenApi` 2.x als auch in 3.x, also wirft `schema.Extensions["x-foo"] = ...` unter .NET 10 wie unter .NET 11 eine `NullReferenceException`. Sichern Sie das ab:

```csharp
// .NET 11, C# 14, Microsoft.OpenApi 3.9.0
options.AddSchemaTransformer((schema, context, ct) =>
{
    schema.Extensions ??= new Dictionary<string, IOpenApiExtension>();
    schema.Extensions["x-schema-id"] =
        new JsonNodeExtension(JsonValue.Create(context.JsonTypeInfo.Type.Name));
    return Task.CompletedTask;
});
```

**`error CS0200: Property or indexer 'IOpenApiMediaType.Example' cannot be assigned to -- it is read only`.** Das ist ein echter Nebeneffekt von .NET 11 und tritt in gemischten Solutions auf. Wenn ein `net10.0`-Projekt am Ende `Microsoft.OpenApi` 3.9.0 auflöst, sei es über zentrale Paketverwaltung, eine gleitende Version oder eine gemeinsame Referenz aus einer `net11.0`-Anwendung, scheitert der OpenAPI-XML-Kommentar-Quellgenerator des .NET-10-SDK an der Kompilierung gegen das 3.x-Objektmodell. Halten Sie die `net10.0`-Projekte auf `Microsoft.OpenApi` 2.x, statt die ganze Solution auf eine Version zu heben.

**`System.MissingMethodException: Method not found: '... Microsoft.OpenApi.OpenApiOperation.get_Extensions()'`.** Das ist der binärkompatible Fehlerfall und bedeutet, dass eine Bibliothek in Ihrem Graph gegen eine `Microsoft.OpenApi`-Oberfläche kompiliert wurde, die zur Laufzeit nicht mehr existiert. Das Upgrade auf .NET 11 allein verursacht das nicht; suchen Sie nach einem Paket, das weit hinter dem Rest fixiert ist, oder nach einer expliziten `Microsoft.OpenApi`-Referenz in Ihrer eigenen csproj, die gegen die transitive kämpft.

## Verwandt

- [OpenAPI ohne Swashbuckle in ASP.NET Core 11 bereitstellen](/de/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/)
- [Fix: OpenAPI 3.0 lässt sich nach dem Upgrade von Swashbuckle.AspNetCore auf v9 nicht mehr ansteuern](/de/2026/08/fix-cannot-target-openapi-3-0-after-upgrading-swashbuckle-aspnetcore/)
- [Das OpenAPI-Dokument mit AddOperationTransformer und AddSchemaTransformer anpassen](/de/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/)
- [OpenAPI-Dokumentation mit Scalar statt Swagger UI ausliefern](/de/2026/08/how-to-serve-openapi-docs-with-scalar-instead-of-swagger-ui-in-aspnetcore-11/)
- [Von Swashbuckle zum eingebauten OpenAPI-Generator in .NET 11 migrieren](/de/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/)

## Quellen

- [Breaking Change: OpenApiVersion nutzt standardmäßig OpenApi3_2](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/11/openapi-version-default-3-2?view=aspnetcore-10.0), Microsoft Learn
- [Breaking Change: Microsoft.OpenApi auf 3.x aktualisiert](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/11/microsoft-openapi-3x?view=aspnetcore-10.0), Microsoft Learn
- [OpenAPI-Dokumente erzeugen](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/aspnetcore-openapi?view=aspnetcore-10.0), Microsoft Learn
- [OpenAPI.NET Release Notes](https://github.com/microsoft/OpenAPI.NET/releases), microsoft/OpenAPI.NET auf GitHub
- [Scalar.AspNetCore.Microsoft scheitert an Transformern](https://github.com/scalar/scalar/issues/6020), scalar/scalar Issue 6020
