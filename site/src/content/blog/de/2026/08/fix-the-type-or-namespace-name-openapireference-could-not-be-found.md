---
title: "Lösung: The type or namespace name 'OpenApiReference' could not be found"
description: "OpenApiReference wurde in Microsoft.OpenApi 2.0 entfernt. Das using auf Microsoft.OpenApi zu ändern reicht nicht: Ersetzen Sie jede Verwendung durch eine typisierte Referenz wie OpenApiSchemaReference."
pubDate: 2026-08-11
template: error-page
tags:
  - "errors"
  - "aspnetcore"
  - "dotnet"
  - "dotnet-10"
  - "dotnet-11"
  - "openapi"
lang: "de"
translationOf: "2026/08/fix-the-type-or-namespace-name-openapireference-could-not-be-found"
translatedBy: "claude"
translationDate: 2026-08-11
---

`OpenApiReference` existiert nicht mehr. Microsoft.OpenApi 2.0 hat sämtliche Modell-Namespaces in `Microsoft.OpenApi` zusammengefasst und zusätzlich den generischen Referenztyp gelöscht. Der Tausch von `using Microsoft.OpenApi.Models;` gegen `using Microsoft.OpenApi;` beseitigt daher nur den Namespace-Fehler und lässt diesen hier stehen. Die Lösung besteht darin, jedes `new OpenApiReference { Type = ..., Id = "X" }` durch die typisierte Referenzklasse der jeweiligen Komponente zu ersetzen, etwa `new OpenApiSchemaReference("X", document)` oder `new OpenApiSecuritySchemeReference("Bearer", document)`. Alles Folgende ist gegen SDK 10.0.201, `Microsoft.AspNetCore.OpenApi` 10.0.10 und `Microsoft.OpenApi` 2.11.0 verifiziert.

## Der Fehler im Kontext

Es gibt zwei Fehler in dieser Familie, und Suchende landen mit beiden hier. Wenn die alten `using`-Direktiven noch vorhanden sind, beanstandet der Compiler den Namespace, nicht den Typ:

```
error CS0234: The type or namespace name 'Models' does not exist in the namespace 'Microsoft.OpenApi' (are you missing an assembly reference?)
error CS0234: The type or namespace name 'Any' does not exist in the namespace 'Microsoft.OpenApi' (are you missing an assembly reference?)
```

Löschen Sie diese using-Direktiven oder ersetzen Sie sie durch `using Microsoft.OpenApi;`, dann erscheint der Fehler, der Sie tatsächlich hierher geführt hat:

```
error CS0246: The type or namespace name 'OpenApiReference' could not be found (are you missing a using directive or an assembly reference?)
error CS0246: The type or namespace name 'OpenApiString' could not be found (are you missing a using directive or an assembly reference?)
error CS0117: 'OpenApiSecurityScheme' does not contain a definition for 'Reference'
error CS0029: Cannot implicitly convert type 'string' to 'Microsoft.OpenApi.JsonSchemaType?'
error CS1061: 'OpenApiDocument' does not contain a definition for 'SerializeAsJson'
```

Der zweite Block ist das entscheidende Signal. `CS0234` bedeutet "der Namespace ist umgezogen". `CS0246` auf `OpenApiReference` bedeutet dagegen "der Typ ist weg", und keine using-Direktive holt ihn zurück.

## Warum das passiert

`Microsoft.AspNetCore.OpenApi` hat ab Version 10.0 eine harte Abhängigkeit zu Microsoft.OpenApi 2.x, und .NET 11 führt das fort. Fügen Sie das Paket einem leeren `net10.0`-Webprojekt hinzu, dann sehen Sie die transitive Abhängigkeit:

```
> Microsoft.AspNetCore.OpenApi      10.0.10     10.0.10
   > Microsoft.OpenApi              2.0.0
```

Microsoft.OpenApi 2.0 bringt drei Änderungen mit, die auf derselben Codezeile zusammentreffen:

- **Die Namespaces wurden zusammengeführt.** `Microsoft.OpenApi.Models`, `Microsoft.OpenApi.Any`, `Microsoft.OpenApi.Interfaces` und `Microsoft.OpenApi.Writers` sind in `Microsoft.OpenApi` aufgegangen. Das öffentliche Assembly exponiert jetzt genau drei Namespaces: `Microsoft.OpenApi`, `Microsoft.OpenApi.Reader` und `Microsoft.OpenApi.MicrosoftExtensions`.
- **`OpenApiReference` wurde entfernt**, zusammen mit der `Reference`-Eigenschaft auf jedem referenzierbaren Modell. `OpenApiSecurityScheme` hat überhaupt kein `Reference`-Member mehr, und genau das ist das `CS0117` oben.
- **Referenzen sind eigenständige Typen geworden.** Statt eine Referenz an ein leeres Modell zu hängen, konstruieren Sie ein dediziertes Referenzobjekt, das dieselbe Schnittstelle implementiert wie sein Ziel.

Wer Swashbuckle statt des eingebauten Generators verwendet, findet dieselbe Klippe ein Paket weiter. Swashbuckle.AspNetCore 9.0.6 löst `Microsoft.OpenApi` 1.6.25 auf, und alter Code kompiliert weiter; Swashbuckle.AspNetCore 10.1.0 löst `Microsoft.OpenApi` 2.3.0 auf, und er kompiliert nicht mehr. Der Bruch kommt vom Swashbuckle-Update, nicht vom SDK-Update.

## Minimale Reproduktion

Das ist die Form, die fast alle haben, meist innerhalb eines aus einem JWT-Tutorial kopierten `AddSecurityRequirement`-Aufrufs von Swagger:

```csharp
// FAILS on .NET 10/11 with Microsoft.OpenApi 2.x
using Microsoft.OpenApi.Models;
using Microsoft.OpenApi.Any;

var reference = new OpenApiReference
{
    Type = ReferenceType.SecurityScheme,
    Id = "Bearer"
};

var scheme = new OpenApiSecurityScheme
{
    Reference = reference
};

var schema = new OpenApiSchema
{
    Type = "string",
    Default = new OpenApiString("hello")
};

var json = new OpenApiDocument().SerializeAsJson(OpenApiSpecVersion.OpenApi3_0);
```

Sechs Zeilen, fünf verschiedene Breaking Changes. Sie einzeln entlang der Compilerfehler abzuarbeiten ist langsam, deshalb hilft es, das gesamte Mapping vorab zu kennen.

## Die Lösung, Schritt für Schritt

### 1. Die using-Direktiven ersetzen

Alle Modell-usings aus `Microsoft.OpenApi.*` kollabieren zu einem:

```csharp
// .NET 11, Microsoft.OpenApi 2.11.0
using Microsoft.OpenApi;
using System.Text.Json.Nodes;   // needed wherever you used IOpenApiAny
```

Ein projektweites Suchen und Ersetzen von `using Microsoft.OpenApi.Models;` durch `using Microsoft.OpenApi;` ist unbedenklich. `using Microsoft.OpenApi.Any;` und `using Microsoft.OpenApi.Interfaces;` löschen Sie einfach ersatzlos.

### 2. OpenApiReference durch die typisierte Referenz ersetzen

Das ist der Teil, den kein `using` repariert. Microsoft.OpenApi 2.x liefert eine Referenzklasse pro referenzierbarer Komponente, alle mit derselben Konstruktorform `(string referenceId, OpenApiDocument hostDocument = null, string externalResource = null)`:

| Alter `ReferenceType` | Neuer Typ |
| --- | --- |
| `ReferenceType.Schema` | `OpenApiSchemaReference` |
| `ReferenceType.SecurityScheme` | `OpenApiSecuritySchemeReference` |
| `ReferenceType.Parameter` | `OpenApiParameterReference` |
| `ReferenceType.RequestBody` | `OpenApiRequestBodyReference` |
| `ReferenceType.Response` | `OpenApiResponseReference` |
| `ReferenceType.Header` | `OpenApiHeaderReference` |
| `ReferenceType.Example` | `OpenApiExampleReference` |
| `ReferenceType.Link` | `OpenApiLinkReference` |
| `ReferenceType.Callback` | `OpenApiCallbackReference` |
| `ReferenceType.Tag` | `OpenApiTagReference` |
| `ReferenceType.PathItem` | `OpenApiPathItemReference` |

Die Referenz auf das Security Scheme wird damit zu einem einzigen Ausdruck:

```csharp
// .NET 11, Microsoft.OpenApi 2.11.0
// old: new OpenApiSecurityScheme { Reference = new OpenApiReference { Type = ReferenceType.SecurityScheme, Id = "Bearer" } }
var schemeRef = new OpenApiSecuritySchemeReference("Bearer", document);
```

Diese Referenztypen implementieren das Interface ihres Ziels (`OpenApiSchemaReference` ist ein `IOpenApiSchema`, `OpenApiSecuritySchemeReference` ist ein `IOpenApiSecurityScheme`), passen also direkt in die Collections, die früher das Modell selbst aufgenommen haben.

### 3. Den Kollateralschaden auf denselben Zeilen beheben

Drei weitere Umbenennungen tauchen meist im selben Block auf:

- `OpenApiSchema.Type` wechselte von `string` zum Flags-Enum `JsonSchemaType` mit den Membern `Null`, `Boolean`, `Integer`, `Number`, `String`, `Object` und `Array`. Da es ein `[Flags]`-Enum ist, drücken Sie die Nullbarkeit von OpenAPI 3.1 als `JsonSchemaType.String | JsonSchemaType.Null` aus statt über eine separate `Nullable`-Eigenschaft.
- Die gesamte `IOpenApiAny`-Hierarchie (`OpenApiString`, `OpenApiInteger`, `OpenApiArray`, `OpenApiObject` und der Rest) wurde zugunsten von `JsonNode` aus `System.Text.Json.Nodes` gelöscht.
- `SerializeAsJson` und `SerializeAsYaml` sind jetzt asynchrone Erweiterungsmethoden: `SerializeAsJsonAsync` und `SerializeAsYamlAsync`. `Maximum`, `Minimum`, `ExclusiveMaximum` und `ExclusiveMinimum` wechselten von `double?` zu `string?`, damit Zahlen beliebiger Genauigkeit den Roundtrip überstehen.

### 4. Die vollständige funktionierende Fassung

Hier ist die obige Reproduktion, umgeschrieben als der Dokument-Transformer, den Sie in einer .NET 11 App tatsächlich registrieren würden. Er kompiliert sauber gegen `Microsoft.AspNetCore.OpenApi` 10.0.10:

```csharp
// .NET 11, Microsoft.AspNetCore.OpenApi 10.0.10, Microsoft.OpenApi 2.11.0
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

public sealed class BearerSecuritySchemeTransformer : IOpenApiDocumentTransformer
{
    public Task TransformAsync(
        OpenApiDocument document,
        OpenApiDocumentTransformerContext context,
        CancellationToken cancellationToken)
    {
        document.Components ??= new OpenApiComponents();
        document.Components.SecuritySchemes ??= new Dictionary<string, IOpenApiSecurityScheme>();

        document.Components.SecuritySchemes["Bearer"] = new OpenApiSecurityScheme
        {
            Type = SecuritySchemeType.Http,
            Scheme = "bearer",
            BearerFormat = "JWT",
            In = ParameterLocation.Header
        };

        document.Security ??= new List<OpenApiSecurityRequirement>();
        document.Security.Add(new OpenApiSecurityRequirement
        {
            [new OpenApiSecuritySchemeReference("Bearer", document)] = new List<string>()
        });

        return Task.CompletedTask;
    }
}
```

Und die Entsprechungen auf der Schema-Seite:

```csharp
// .NET 11, Microsoft.OpenApi 2.11.0
var schema = new OpenApiSchema
{
    Type = JsonSchemaType.String | JsonSchemaType.Null,   // was Type = "string" + Nullable = true
    Default = (JsonNode)"hello",                          // was new OpenApiString("hello")
    Enum = new List<JsonNode> { (JsonNode)"a", (JsonNode)"b" },
    Maximum = "100"                                       // was double? Maximum = 100
};

IOpenApiSchema widgetRef = new OpenApiSchemaReference("Widget", document);

string json = await document.SerializeAsJsonAsync(OpenApiSpecVersion.OpenApi3_1);
```

Ein so aufgebautes Dokument serialisiert genau zu dem, was man erwartet: die Security-Anforderung über den Schemanamen, die Komponente unverändert:

```json
{
  "openapi": "3.1.1",
  "components": {
    "securitySchemes": {
      "Bearer": { "type": "http", "scheme": "bearer", "bearerFormat": "JWT" }
    }
  },
  "security": [ { "Bearer": [ ] } ]
}
```

## Fallstricke, die erst nach dem erfolgreichen Build zuschlagen

**Beheben Sie das nicht durch ein Upgrade von Microsoft.OpenApi auf 3.x.** Der Gedanke liegt nahe, denn 3.9.0 ist die aktuelle Version auf NuGet, während ASP.NET Core 10 auf 2.0.0 festlegt. Fügen Sie einem Projekt mit dem eingebauten Generator eine explizite `PackageReference` auf 3.9.0 hinzu, dann scheitert der Build im generierten Code von Microsoft selbst:

```
obj\Debug\net10.0\Microsoft.AspNetCore.OpenApi.SourceGenerators\...\OpenApiXmlCommentSupport.generated.cs(399,41):
error CS0200: Property or indexer 'IOpenApiMediaType.Example' cannot be assigned to -- it is read only
```

Der Source Generator für XML-Kommentare aus `Microsoft.AspNetCore.OpenApi` 10.0.10 ist gegen die 2.x-Oberfläche geschrieben. Bleiben Sie auf der 2.x-Linie, bis das ASP.NET Core Paket nachzieht.

**Fixieren Sie Microsoft.OpenApi aber auf 2.7.5 oder neuer.** Die 2.0.0, die ASP.NET Core 10.0.10 transitiv auflöst, trägt einen Hinweis mit hohem Schweregrad, und NuGet meldet das schon beim Restore:

```
warning NU1903: Package 'Microsoft.OpenApi' 2.0.0 has a known high severity vulnerability
```

Das ist CVE-2026-49451, unkontrollierte Rekursion bei zirkulären Schema-Referenzen, betroffen sind 2.0.0-preview.11 bis 2.7.4 sowie 3.0.0 bis 3.5.3. Eine explizite `<PackageReference Include="Microsoft.OpenApi" Version="2.11.0" />` beseitigt die Warnung und kompiliert weiterhin sauber gegen den Generator aus 10.0.10. Besonders relevant ist das, wenn Ihre Anwendung OpenAPI-Dokumente parst, die Sie nicht selbst verfasst haben.

**Collections initialisieren sich nicht mehr selbst.** In 1.x lieferte `new OpenApiDocument().Components` ein leeres `OpenApiComponents`. In 2.x ist es null, ebenso `Components.Schemas`, `Components.SecuritySchemes` und `Document.Tags`. `Paths` und `Servers` sind weiterhin initialisiert. Deshalb verwendet der Transformer oben auf jeder Ebene `??=` vor dem Indexzugriff, und deshalb ist das die mit Abstand häufigste `NullReferenceException` direkt nach einem erfolgreichen Upgrade-Build.

**Referenzen werden verzögert über den Workspace des Dokuments aufgelöst.** Wenn Sie ein Dokument von Hand aufbauen, statt es von ASP.NET Core bauen zu lassen, bleibt das `Target` einer Referenz null und ihre durchgereichten Eigenschaften bleiben leer, bis die Komponenten registriert sind:

```csharp
// .NET 11, Microsoft.OpenApi 2.11.0
var reference = new OpenApiSchemaReference("Widget", document);
// reference.Target is null here, reference.Description is empty

document.Workspace.RegisterComponents(document);
// reference.Target is now resolved, reference.Description reads through to the target
```

Die Auflösung erfolgt verzögert, eine vor dem `RegisterComponents`-Aufruf erzeugte Referenz löst danach also korrekt auf. Die Serialisierung schreibt den `$ref` ohnehin; überraschend sind die Lesezugriffe über den Proxy.

**Achten Sie auf die Interface-Typen in den Transformer-Signaturen.** `Components.Schemas` ist ein `IDictionary<string, IOpenApiSchema>` und `Components.SecuritySchemes` ein `IDictionary<string, IOpenApiSecurityScheme>`, nicht die konkreten Klassen. Code, der den konkreten Typ vorausgesetzt hat, braucht nun eine Umwandlung oder ein Pattern Matching, denn der Wert kann ein Referenzobjekt statt eines Inline-Schemas sein.

**`OpenApiSecuritySchemeReference` wird nicht als `$ref` gerendert.** Sein `Reference.ReferenceV3` ist schlicht `Bearer`, während das von `OpenApiSchemaReference("Widget")` `#/components/schemas/Widget` lautet. Das entspricht der OpenAPI-Spezifikation: Eine Security-Anforderung adressiert das Schema über seinen Namen. Suchen Sie also nicht nach einem fehlenden `$ref` in der Ausgabe.

## Verwandte Beiträge

Wer ein größeres OpenAPI-Upgrade durcharbeitet, findet die Nachbarthemen hier: Der Weg weg von Swashbuckle steht in [Migration von Swashbuckle zum eingebauten OpenAPI-Generator](/de/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/), und das meist gleichzeitig anfallende Umschreiben der Filter auf Transformer in [IOperationFilter und ISchemaFilter auf OpenAPI-Transformer portieren](/de/2026/07/migrate-swashbuckle-ioperationfilter-and-ischemafilter-to-transformers-in-dotnet-11/). Zur Transformer-API selbst siehe [das Dokument mit AddOperationTransformer und AddSchemaTransformer anpassen](/de/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/). Sobald das Dokument wieder baut, brauchen Sie noch eine Darstellung dafür, beschrieben in [OpenAPI-Dokumentation mit Scalar ausliefern](/de/2026/08/how-to-serve-openapi-docs-with-scalar-instead-of-swagger-ui-in-aspnetcore-11/). Und falls dieser Fehler Teil eines größeren Sprungs war, listet die [Checkliste von .NET 8 auf .NET 11](/de/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) die übrigen Pakete auf, die sich zur selben Zeit bewegt haben.

## Quellen

- [OpenAPI.NET 2.0 Upgrade-Leitfaden](https://github.com/microsoft/OpenAPI.NET/blob/main/docs/upgrade-guide-2.md), die maßgebliche Liste entfernter Typen und umbenannter Eigenschaften.
- [dotnet/aspnetcore Issue 61123](https://github.com/dotnet/aspnetcore/issues/61123), die Meldung zum Verschwinden von `OpenApiSecurityScheme.Reference` in .NET 10 Preview 2.
- [Swashbuckle.AspNetCore Issue 3522](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/issues/3522), die Namespace-Änderung aus Sicht der Swashbuckle-Nutzer.
- [GHSA-v5pm-xwqc-g5wc](https://github.com/advisories/GHSA-v5pm-xwqc-g5wc) / CVE-2026-49451, der Hinweis hinter der `NU1903`-Warnung.
