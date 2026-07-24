---
title: "Swashbuckle IOperationFilter und ISchemaFilter zu OpenAPI-Transformern in .NET 11 migrieren"
description: "Eine Filter-für-Filter-Migrationsreferenz, um IOperationFilter- und ISchemaFilter-Code von Swashbuckle zu den integrierten Operations- und Schema-Transformern in .NET 11 zu überführen, mit dem Mapping der Kontextobjekte und den Microsoft.OpenApi-v2-Änderungen, die die Kompilierung brechen."
pubDate: 2026-07-24
updatedDate: 2026-07-24
template: migration
tags:
  - "migration"
  - "swashbuckle"
  - "openapi"
  - "aspnetcore-11"
  - "dotnet-11"
lang: "de"
translationOf: "2026/07/migrate-swashbuckle-ioperationfilter-and-ischemafilter-to-transformers-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-07-24
---

Wenn Sie `AddSwaggerGen()` auf `net11.0` bereits durch `AddOpenApi()` ersetzt haben, ist die Registrierung der einfache Teil. Die Arbeit, die den Nachmittag wirklich frisst, sind Ihre eigenen Filter: jeder `IOperationFilter` und `ISchemaFilter`, den Sie gegen Swashbuckle geschrieben haben, wird nicht mehr aufgerufen, sobald der Generator wechselt, denn der integrierte Generator `Microsoft.AspNetCore.OpenApi` kennt kein Konzept von Filtern. Er kennt Transformer. Dieser Artikel ist die Filter-für-Filter-Migrationsreferenz: wie sich die beiden Filter-Schnittstellen auf `IOpenApiOperationTransformer` und `IOpenApiSchemaTransformer` abbilden, wozu jede Kontext-Eigenschaft wird und welche Typänderungen in Microsoft.OpenApi v2 nicht kompilieren, bis Sie sie korrigieren. Er zielt auf .NET 11 (`net11.0`, C# 14), `Microsoft.AspNetCore.OpenApi` v11 und `Microsoft.OpenApi` v2 und migriert von Swashbuckle.AspNetCore v10.

Für eine Handvoll Filter dauert das unter einer Stunde. Für einen großen Dienst mit einem Dutzend Filtern, einem Beispielanbieter und einem Polymorphismus-Filter sollten Sie einen halben Tag einplanen. Die mechanische Form jeder Migration ist nahezu identisch, also liegt der Aufwand nicht im Umschreiben: es sind die beiden Kontextobjekte, die andere Informationen bereitstellen, und die Änderungen am Typmodell von Microsoft.OpenApi v2. Wenn Sie den umgebenden Registrierungswechsel noch nicht vollzogen haben, tun Sie das zuerst mit [dem vollständigen Leitfaden zur Migration von Swashbuckle zum integrierten Generator](/de/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/); alles Folgende setzt voraus, dass `AddOpenApi()` und `MapOpenApi()` bereits vorhanden sind.

## Warum die Filter überhaupt überführen

- Die Filter sind toter Code, sobald Sie den Generator von Swashbuckle fallen lassen. Sie kompilieren (die Typen existieren weiter, solange das Paket referenziert wird), laufen aber nie, sodass Ihr Dokument stillschweigend jede Anpassung verliert, die sie angewendet haben.
- Transformer nutzen dieselben `System.Text.Json`-Metadaten wieder, mit denen der Rest Ihrer Anwendung serialisiert, sodass ein Schema-Transformer genau die Typform sieht, die Ihre API ausgibt, und keine Reflexions-Näherung.
- Transformer sind Native-AOT-kompatibel. Die reflexionslastige Filter-Pipeline von Swashbuckle ist es nicht, sodass ein AOT-Dienst gar keine Filter-Option hat.
- Ein einziges Erweiterbarkeitsmodell deckt Dokument, Operation und Schema ab, statt dreier Filter-Schnittstellen plus Annotationsattribute.

## Was bricht

| Bereich | Swashbuckle | Integriert in .NET 11 | Schweregrad |
| --- | --- | --- | --- |
| Operations-Hook | `IOperationFilter.Apply(OpenApiOperation, OperationFilterContext)` | `IOpenApiOperationTransformer.TransformAsync(...)` | hoch |
| Schema-Hook | `ISchemaFilter.Apply(OpenApiSchema, SchemaFilterContext)` | `IOpenApiSchemaTransformer.TransformAsync(...)` | hoch |
| Methodensignatur | synchrones `void Apply` | `Task TransformAsync(..., CancellationToken)` | mittel |
| Registrierung | `c.OperationFilter<T>(args)` / `c.SchemaFilter<T>(args)` | `options.AddOperationTransformer<T>()` / `AddSchemaTransformer<T>()` | mittel |
| Schema-Beispiele | `OpenApiString` / `IOpenApiAny` | `System.Text.Json.Nodes.JsonNode` | mittel |
| Schema-Typfeld | `schema.Type = "string"` String + `Nullable` | `JsonSchemaType`-Flags-Enum, `Null`-Flag | mittel |
| Reflexions-Member | `context.MemberInfo` (`MemberInfo`) | `context.JsonPropertyInfo` (`JsonPropertyInfo`) | mittel |
| Erzeugung von Unterschemata | `context.SchemaGenerator.GenerateSchema(...)` | `context.GetOrCreateSchemaAsync(...)` | niedrig |

## Vorab-Checkliste

1. Stellen Sie sicher, dass das .NET-11-SDK auf jeder Entwicklermaschine und jedem CI-Runner installiert ist: `dotnet --list-sdks` sollte `11.0.x` auflisten.
2. Inventarisieren Sie die Filter. Durchsuchen Sie die Solution nach `IOperationFilter`, `ISchemaFilter`, `IDocumentFilter`, `OperationFilter<` und `SchemaFilter<`. Diese Liste ist der genaue Umfang dieser Migration; nichts anderes ändert sich hier.
3. Sichern Sie ein Referenzdokument. Fordern Sie mit noch verdrahtetem Swashbuckle `/swagger/v1/swagger.json` an und bewahren Sie die Datei auf. Sie werden das migrierte Dokument Endpunkt für Endpunkt dagegen vergleichen.
4. Bestätigen Sie, dass `AddOpenApi()` und `MapOpenApi()` bereits ein Dokument unter `/openapi/v1.json` erzeugen. Falls nicht, migrieren Sie zuerst die Registrierung.
5. Führen Sie die Arbeit auf einem Branch mit einem sauberen Basis-Commit aus, damit das Rollback ein einziges `git checkout` ist.

## Die beiden Kontextobjekte, abgebildet

Vor den Rezepten das Mapping, das jede Migration mechanisch macht. Ein Swashbuckle-Filter und ein integrierter Transformer übergeben Ihnen dasselbe OpenAPI-Objekt zum Mutieren (`OpenApiOperation` oder `OpenApiSchema`), aber der Kontext darum herum unterscheidet sich.

`OperationFilterContext` zu `OpenApiOperationTransformerContext`:

| Swashbuckle | Integriert | Hinweise |
| --- | --- | --- |
| `ApiDescription` | `Description` | Derselbe Typ `ApiDescription`; umbenannte Eigenschaft. Route, Methode und `ActionDescriptor.EndpointMetadata` bleiben erhalten. |
| `MethodInfo` | `Description.ActionDescriptor` | Lesen Sie die Metadaten vom Descriptor statt von der rohen `MethodInfo`. |
| `SchemaRepository` | `Document` | Registrieren Sie geteilte Schemata mit `Document.AddComponent(...)`. |
| `SchemaGenerator` | `GetOrCreateSchemaAsync(...)` | Jetzt eine Methode des Kontexts, kein separates Generatorobjekt. |
| `DocumentName` | `DocumentName` | Unverändert. |

`SchemaFilterContext` zu `OpenApiSchemaTransformerContext`:

| Swashbuckle | Integriert | Hinweise |
| --- | --- | --- |
| `Type` | `JsonTypeInfo.Type` | Der CLR-`Type` liegt einen Sprung tiefer, innerhalb der `System.Text.Json`-Metadaten. |
| `MemberInfo` | `JsonPropertyInfo` | Nur bei einem Eigenschaftsschema nicht null. Lesen Sie die Attribute über `JsonPropertyInfo.AttributeProvider`. |
| `ParameterInfo` | `ParameterDescription` | Eine `ApiParameterDescription`; null bei einem Antwortschema. |
| `SchemaGenerator` | `GetOrCreateSchemaAsync(...)` | Wie oben. |
| `DocumentName` | `DocumentName` | Unverändert. |

Halten Sie diese beiden Tabellen offen, während Sie migrieren. Neunzig Prozent jedes Umschreibens ist das Umbenennen einer Kontext-Eigenschaft und das Anpassen an `JsonTypeInfo`.

## Migrationsschritte

### 1. Jeden Filter auf seine Transformer-Schnittstelle und Registrierung abbilden

Jeder `IOperationFilter` wird zu einem `IOpenApiOperationTransformer` (oder einem Inline-Delegate `AddOperationTransformer`), und jeder `ISchemaFilter` wird zu einem `IOpenApiSchemaTransformer`. Ein synchrones `void Apply` wird zu einem asynchronen `TransformAsync`, das ein `Task` zurückgibt und einen `CancellationToken` entgegennimmt. Die Registrierung wandert vom `AddSwaggerGen`-Callback in den Optionsblock von `AddOpenApi`.

```csharp
// Before -- Swashbuckle registration, ASP.NET Core 8 style
builder.Services.AddSwaggerGen(c =>
{
    c.OperationFilter<AddCorrelationHeaderFilter>();
    c.SchemaFilter<MarkMoneyFormatFilter>();
});
```

```csharp
// After -- .NET 11, C# 14
builder.Services.AddOpenApi(options =>
{
    options.AddOperationTransformer<AddCorrelationHeaderTransformer>();
    options.AddSchemaTransformer<MarkMoneyFormatTransformer>();
});
```

**Prüfen:** Das Projekt kompiliert weiterhin mit den gelöschten oder umbenannten alten Filterklassen, und `AddOpenApi` kompiliert mit den neuen Registrierungen. Noch läuft nichts korrekt; die nächsten Schritte füllen die Rümpfe.

### 2. Einen IOperationFilter überführen, der eine Antwort oder einen Header hinzufügt

Dies ist der häufigste Filter und die mechanischste Migration. Der Rumpf ändert sich kaum: Sie mutieren `operation` an Ort und Stelle. Schützen Sie sich gegen eine null-`Parameters`- oder -`Responses`-Sammlung, die das integrierte Modell null lässt, statt sie vorab zu belegen.

```csharp
// Before -- Swashbuckle IOperationFilter
public class AddCorrelationHeaderFilter : IOperationFilter
{
    public void Apply(OpenApiOperation operation, OperationFilterContext context)
    {
        operation.Parameters ??= new List<OpenApiParameter>();
        operation.Parameters.Add(new OpenApiParameter
        {
            Name = "X-Correlation-Id",
            In = ParameterLocation.Header,
            Required = false,
            Schema = new OpenApiSchema { Type = "string" }
        });
    }
}
```

```csharp
// After -- .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

internal sealed class AddCorrelationHeaderTransformer : IOpenApiOperationTransformer
{
    public Task TransformAsync(
        OpenApiOperation operation,
        OpenApiOperationTransformerContext context,
        CancellationToken cancellationToken)
    {
        operation.Parameters ??= [];
        operation.Parameters.Add(new OpenApiParameter
        {
            Name = "X-Correlation-Id",
            In = ParameterLocation.Header,
            Required = false,
            Schema = new OpenApiSchema { Type = JsonSchemaType.String }
        });
        return Task.CompletedTask;
    }
}
```

Zwei Änderungen über die Signatur hinaus: `Type = "string"` wird zu `Type = JsonSchemaType.String` (der Schematyp ist in Microsoft.OpenApi v2 ein Flags-Enum, kein String), und der Namespace von `OpenApiParameter` und Konsorten ist `Microsoft.OpenApi`, nicht `Microsoft.OpenApi.Models`. **Prüfen:** Fordern Sie `/openapi/v1.json` an und bestätigen Sie, dass jede Operation jetzt den Header-Parameter `X-Correlation-Id` trägt.

### 3. Einen IOperationFilter überführen, der den Endpunkt liest

Bedingte Filter, die an Route, HTTP-Methode oder Metadaten anknüpfen, sind der Ort, an dem `OperationFilterContext` zählte. Die `ApiDescription`, die Sie lesen, ist derselbe Typ; sie wird als `context.Description` bereitgestellt. Das Muster, `EndpointMetadata` nach einem Attribut abzusuchen, überträgt sich wortwörtlich.

```csharp
// After -- .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.OpenApi;

internal sealed class ThrottleResponseTransformer : IOpenApiOperationTransformer
{
    public Task TransformAsync(
        OpenApiOperation operation,
        OpenApiOperationTransformerContext context,
        CancellationToken cancellationToken)
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
    }
}
```

Wenn Ihr alter Filter auf `context.MethodInfo` zurückgriff, um ein eigenes Attribut zu lesen, bevorzugen Sie stattdessen `context.Description.ActionDescriptor.EndpointMetadata`, da Minimal-API-Endpunkte ihre Metadaten dort bereitstellen und möglicherweise keine sinnvolle `MethodInfo` haben. **Prüfen:** Wählen Sie einen Endpunkt, der das Rate-Limiting-Attribut trägt, und einen, der es nicht trägt, und bestätigen Sie, dass nur der erste eine `429`-Antwort im Dokument zeigt.

### 4. Einen ISchemaFilter überführen, der einen Typ formt

Der Rumpf des Schemafilters ändert sich an genau einer Stelle: `context.Type` wird zu `context.JsonTypeInfo.Type`. Alles, was Sie mit `schema` gemacht haben, bleibt gleich.

```csharp
// Before -- Swashbuckle ISchemaFilter
public class DescribeTodoFilter : ISchemaFilter
{
    public void Apply(OpenApiSchema schema, SchemaFilterContext context)
    {
        if (context.Type == typeof(Todo))
        {
            schema.Description = "A single task tracking item.";
        }
    }
}
```

```csharp
// After -- .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

internal sealed class DescribeTodoTransformer : IOpenApiSchemaTransformer
{
    public Task TransformAsync(
        OpenApiSchema schema,
        OpenApiSchemaTransformerContext context,
        CancellationToken cancellationToken)
    {
        if (context.JsonTypeInfo.Type == typeof(Todo))
        {
            schema.Description = "A single task tracking item.";
        }
        return Task.CompletedTask;
    }
}
```

**Prüfen:** Finden Sie das `Todo`-Schema unter `components.schemas` im Dokument und bestätigen Sie, dass die Beschreibung vorhanden ist.

### 5. Einen ISchemaFilter überführen, der auf eine Eigenschaft zielt

Swashbuckle teilte Ihnen mit, dass ein Schema ein Eigenschaftsschema war, indem es Ihnen eine nicht-null `context.MemberInfo` übergab. Das integrierte Äquivalent ist eine nicht-null `context.JsonPropertyInfo`. Da der integrierte Generator von `System.Text.Json` angetrieben wird, ist `JsonPropertyInfo.Name` der serialisierte JSON-Name (bereits in camelCase, falls das Ihre Richtlinie ist), nicht der CLR-Membername, was eine ganze Klasse von Groß-/Kleinschreibungs-Fehlern beseitigt.

```csharp
// After -- .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

internal sealed class EmailFormatTransformer : IOpenApiSchemaTransformer
{
    public Task TransformAsync(
        OpenApiSchema schema,
        OpenApiSchemaTransformerContext context,
        CancellationToken cancellationToken)
    {
        if (context.JsonPropertyInfo?.Name == "email")
        {
            schema.Format = "email";
        }
        return Task.CompletedTask;
    }
}
```

Wenn Ihr alter Filter ein eigenes Attribut von der `MemberInfo` las, holen Sie es über `context.JsonPropertyInfo?.AttributeProvider?.GetCustomAttributes(...)`, das die zugrunde liegende `PropertyInfo` bereitstellt. **Prüfen:** Bestätigen Sie, dass jede `email`-Eigenschaft über Ihre Schemata hinweg jetzt `"format": "email"` trägt.

### 6. Einen Beispielanbieter überführen

Schema-Beispiele sind das, was am ehesten nicht kompiliert. Microsoft.OpenApi v2 hat die gesamte `IOpenApiAny`-Hierarchie entfernt (`OpenApiString`, `OpenApiInteger`, `OpenApiObject`). Beispiele sind jetzt `System.Text.Json.Nodes.JsonNode`.

```csharp
// Before -- Swashbuckle, IOpenApiAny example
schema.Example = new OpenApiString("dev@example.com");
```

```csharp
// After -- .NET 11, C# 14
using System.Text.Json.Nodes;

schema.Example = JsonValue.Create("dev@example.com");
```

Für ein zusammengesetztes Beispiel bauen Sie ein `JsonObject` statt eines `OpenApiObject`: `new JsonObject { ["id"] = 1, ["title"] = "Write" }`. **Prüfen:** Das `example`-Feld des Zielschemas wird im Dokument und in Ihrer UI als gültiges JSON dargestellt.

### 7. Einen Filter überführen, der Konstruktorargumente oder Dienste brauchte

Swashbuckle ließ Sie Konstruktorargumente bei der Registrierung übergeben (`c.OperationFilter<T>(arg1, arg2)`) oder Dienste auflösen, weil Filter aus dem Container aktiviert wurden. Die integrierte generische Registrierung `options.AddOperationTransformer<T>()` aktiviert den Transformer aus der Dependency Injection, also injizieren Sie über einen Primärkonstruktor, statt Positionsargumente zu übergeben.

```csharp
// After -- .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

internal sealed class TosLinkTransformer(IOptions<ApiInfoOptions> options)
    : IOpenApiOperationTransformer
{
    public Task TransformAsync(
        OpenApiOperation operation,
        OpenApiOperationTransformerContext context,
        CancellationToken cancellationToken)
    {
        operation.ExternalDocs = new OpenApiExternalDocs
        {
            Url = options.Value.TermsOfServiceUrl
        };
        return Task.CompletedTask;
    }
}
```

Nur die generische Überladung nimmt an der Dependency Injection teil; `AddOperationTransformer(new T(...))` und die Delegate-Überladung nicht. Die generische Form wird pro Dokumenterzeugung frisch aufgelöst und danach freigegeben, sodass ein `IDisposable`-Transformer jedes Mal aufgeräumt wird, wenn das Dokument gebaut wird. **Prüfen:** Der injizierte Wert erscheint im Dokument, und der Transformer wird ohne einen "no service for type"-Fehler bei der ersten Anfrage aufgelöst.

### 8. Einen Filter überführen, der Unterschemata erzeugte

Die kniffligsten Filter riefen `context.SchemaGenerator.GenerateSchema(type, context.SchemaRepository)` auf, um ein Schema für einen Typ zu bauen, den die Operation sonst nicht referenzierte, zum Beispiel einen geteilten Fehlerrumpf. Der integrierte Ersatz ist `context.GetOrCreateSchemaAsync(...)` plus `context.Document.AddComponent(...)`.

```csharp
// After -- .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

internal sealed class ErrorResponseTransformer : IOpenApiOperationTransformer
{
    public async Task TransformAsync(
        OpenApiOperation operation,
        OpenApiOperationTransformerContext context,
        CancellationToken cancellationToken)
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
    }
}
```

Beachten Sie das typisierte `OpenApiSchemaReference("Error", context.Document)` statt einer von Hand gebauten `OpenApiReference`. **Prüfen:** Das `Error`-Schema erscheint einmal unter `components.schemas`, und die Operationen referenzieren es, statt eine Kopie einzubetten. Die Transformer-zuerst-Mechanik von `GetOrCreateSchemaAsync` wird ausführlich in [OpenAPI mit Operations- und Schema-Transformern anpassen](/de/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/) behandelt.

## Verifikation

Führen Sie das aus, bevor Sie die alten Filterklassen löschen:

- `dotnet build` ist sauber, ohne Referenzen auf `Microsoft.OpenApi.Models` oder die Filter-Schnittstellen von `Swashbuckle.AspNetCore.SwaggerGen`.
- Vergleichen Sie das migrierte `/openapi/v1.json` mit der Referenz, die Sie im Vorab-Schritt gesichert haben. Erwarten Sie, dass sich die Spezifikationsversion und die `nullable`-Behandlung unterscheiden (3.1 vs. 3.0); jede Antwort, jeder Header, jede Beschreibung und jedes Beispiel, das Ihre Filter erzeugten, sollte Operation für Operation übereinstimmen.
- Jede Eigenschaft, auf die ein Schemafilter zielte, zeigt weiterhin dasselbe Format, Beispiel oder dieselbe Beschreibung.
- `dotnet test` besteht, einschließlich jedes Contract-Tests, der die Dokumentform festhielt.
- Wenn Sie das Dokument einem Client-Generator zuführen, generieren Sie neu und bestätigen Sie, dass er weiterhin baut. Siehe [stark typisierten Client-Code aus einer OpenAPI-Spezifikation generieren](/de/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/).

## Rollback-Plan

Diese Migration ist reversibel, bis Sie die Filterklassen löschen. Da jedes Umschreiben eine neue Transformer-Klasse neben dem alten Filter ist, ist das sicherste Rollback der saubere Git-Basis-Commit aus dem Vorab-Schritt: `git checkout` des Commits und `c.OperationFilter<T>()` / `c.SchemaFilter<T>()` im `AddSwaggerGen`-Block wieder hinzufügen. Behalten Sie sowohl die Filter als auch die Transformer im Baum, bis das migrierte Dokument in einer echten Umgebung gelaufen ist, und löschen Sie dann die Filter in einem separaten Commit.

## Stolpersteine, auf die wir stießen

**Schema-Transformer laufen mehr als einmal für denselben Typ.** Ein Schema-Transformer feuert pro Schemavorkommen, und der Durchlauf, der identische Schemata zu `components.schemas` dedupliziert, läuft nach den Transformern. Ein Typ, der an drei Stellen verwendet wird, hat seinen Transformer dreimal aufgerufen, halten Sie die Logik also idempotent: prüfen Sie, bevor Sie hinzufügen, und hängen Sie nie an eine Liste an, die Sie erneut besuchen könnten. Der `ISchemaFilter` von Swashbuckle hatte eine verwandte scharfe Kante (er wurde nicht für bereits referenzierte Schemata aufgerufen), gehen Sie also nicht davon aus, dass die alte Aufrufanzahl übertragbar ist.

**Die Ausführungsreihenfolge ist Schemata, dann Operationen, dann Dokumente.** Filter in Swashbuckle liefen in Registrierungsreihenfolge innerhalb jeder Art. Die integrierte Pipeline führt zuerst alle Schema-Transformer aus, dann die Operations-Transformer, dann die Dokument-Transformer, und sie läuft pro Dokumenterzeugung. Ein Operations-Transformer kann sich nicht darauf verlassen, dass ein Dokument-Transformer gelaufen ist, denn Dokumente laufen zuletzt. Darüber stolpert jeder, der ein Sicherheitsschema in einen Dokument-Transformer setzte und versuchte, es aus einem Operations-Transformer im selben Durchlauf zu referenzieren.

**`context.Type` ist jetzt zwei Sprünge entfernt.** Der häufigste Kompilierfehler nach einem Massen-Suchen-und-Ersetzen ist, `context.Type` in einem Schema-Transformer zu belassen. Es ist `context.JsonTypeInfo.Type`. Ein knapper zweiter ist `context.MemberInfo`, das `context.JsonPropertyInfo` ist.

**Das Dokument wird bei jeder Anfrage neu erzeugt.** `MapOpenApi` führt die gesamte Transformer-Pipeline jedes Mal aus, wenn die Route getroffen wird, halten Sie die Transformer also günstig. Für ein stark frequentiertes Dokument cachen Sie es mit `.CacheOutput()` am Endpunkt oder erzeugen Sie es zur Build-Zeit. Swashbuckle cachte aggressiver, sodass ein schwerer Filter, der vorher in Ordnung war, jetzt als Latenz auftauchen kann.

**`OpenApiSchema` ist ein konkreter Typ im Transformer, aber `IOpenApiSchema` taucht anderswo auf.** Der Transformer-Delegate übergibt Ihnen ein veränderbares `OpenApiSchema`. Andere v2-APIs geben `IOpenApiSchema` zurück, sodass eine Hilfsmethode, die früher `OpenApiSchema` nahm, die Schnittstelle benötigen kann. Wenn Sie ein Sicherheitsschema über einen Dokument-Transformer verdrahtet haben und der Viewer das Token ignoriert, ist das fast immer ein fehlerhaftes Schema und kein Client-Fehler, durchgängig nachverfolgt in [warum Ihr Bearer-Token in Scalar ignoriert wird](/de/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/).

Das mentale Modell ist klein, sobald es einrastet: ein Filter und ein Transformer übergeben Ihnen beide dasselbe OpenAPI-Objekt zum Mutieren, sodass sich der Rumpf kaum ändert. Die Migration besteht darin, Kontext-Eigenschaften umzubenennen, auf `JsonTypeInfo` umzustellen, Beispiele auf `JsonNode` zu verschieben und die Schema-Logik idempotent zu halten, weil sie jetzt mehr als einmal läuft. Machen Sie es Filter für Filter, vergleichen Sie mit der Referenz, und das Dokument, das Sie ausliefern, ist das, das Ihre Konsumenten bereits erwarten.

## Weiterführende Lektüre

- [Von Swashbuckle zum integrierten OpenAPI-Generator in .NET 11 migrieren](/de/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/)
- [OpenAPI mit Operations- und Schema-Transformern in ASP.NET Core 11 anpassen](/de/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/)
- [OpenAPI ohne Swashbuckle in ASP.NET Core 11 bereitstellen](/de/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/)
- [Minimal-API-Endpunkte mit MapGroup in ASP.NET Core 11 organisieren](/de/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [Scalar in ASP.NET Core: warum Ihr Bearer-Token ignoriert wird](/de/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/)

## Quellen

- [OpenAPI-Dokumente anpassen, ASP.NET-Core-Dokumentation](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/customize-openapi?view=aspnetcore-10.0)
- [OpenApiSchemaTransformerContext, .NET-API-Referenz](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.openapi.openapischematransformercontext)
- [IOpenApiOperationTransformer, .NET-API-Referenz](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.openapi.iopenapioperationtransformer)
- [Swashbuckle.AspNetCore, Migration auf v10](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/blob/master/docs/migrating-to-v10.md)
- [Microsoft.OpenAPI-v2-Upgrade-Leitfaden](https://github.com/microsoft/OpenAPI.NET/blob/main/docs/upgrade-guide-2.md)
