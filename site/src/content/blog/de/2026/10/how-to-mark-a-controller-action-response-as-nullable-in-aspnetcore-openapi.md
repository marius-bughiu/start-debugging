---
title: "Wie Sie die Antwort einer Controller-Action im integrierten OpenAPI-Dokument von ASP.NET Core als nullbar markieren"
description: "Microsoft.AspNetCore.OpenApi markiert eine Antwort nur dann als nullbar, wenn die Action ein reines T? zurückgibt (und unter .NET 10 nicht einmal Task<T?>). ActionResult<T?> und IActionResult verlieren die Annotation sowohl unter .NET 10 als auch unter .NET 11 RC2. Hier steht der Grund, ein getesteter Operation Transformer, der das behebt, und die Falle mit 204 No Content, durch die die Spezifikation lügt, wenn Sie nicht auch den Formatter von MVC ändern."
pubDate: 2026-10-20
template: how-to
tags:
  - "aspnetcore"
  - "openapi"
  - "dotnet-11"
  - "dotnet-10"
  - "nullable-reference-types"
  - "how-to"
lang: "de"
translationOf: "2026/10/how-to-mark-a-controller-action-response-as-nullable-in-aspnetcore-openapi"
translatedBy: "claude"
translationDate: 2026-10-20
---

**Kurze Antwort:** Unter .NET 10 (`Microsoft.AspNetCore.OpenApi` 10.0.13) und .NET 11 RC2 (11.0.0-rc.2.26504.105) umhüllt der integrierte Generator ein Antwortschema nur dann mit `oneOf: [{ "type": "null" }, ...]`, wenn der Rückgabetyp der Action selbst nullbar ist: `Person?`, unter .NET 11 zusätzlich `Task<Person?>`. In `ActionResult<Person?>` schaut er nie hinein, und bei `IActionResult` mit `[ProducesResponseType<Person>]` gibt es nichts, was er prüfen könnte. Beide Varianten sind daher nicht nullbar. Registrieren Sie einen Operation Transformer, der die `MethodInfo` der Action mit `NullabilityInfoContext` liest, `Task<>` und `ActionResult<>` entpackt und das 2xx-Schema selbst umhüllt (Code unten, auf beiden Versionen getestet). Entscheiden Sie danach, was null auf der Leitung tatsächlich bedeutet, denn MVC sendet für ein null-Ergebnis standardmäßig **204 No Content** und nicht `200` mit `null`.

Darauf bin ich gestoßen, als ich mit Kiota einen Client für eine Controller-API generiert habe: Die generierte Methode für `GET /people/{id}` gab ein nicht nullbares `Person` zurück, obwohl die Action als `ActionResult<Person?>` deklariert war. Alles Folgende wurde an einer Scratch-App mit SDK 10.0.302 (Laufzeit 10.0.10) und SDK 11.0.100-rc.2.26504.105 gemessen, indem `/openapi/v1.json` ausgegeben und jeder Endpunkt mit curl aufgerufen wurde.

## Was der Generator für die einzelnen Rückgabeformen erzeugt

Der Test-Controller hat pro Form eine Action, alle geben `null` zurück, mit `<Nullable>enable</Nullable>`:

```csharp
// .NET 10 / .NET 11 RC2, C# 14, <Nullable>enable</Nullable>
[ApiController]
[Route("people")]
public class PeopleController : ControllerBase
{
    [HttpGet("plain")]
    public Person? GetPlain() => null;

    [HttpGet("taskplain")]
    public async Task<Person?> GetTaskPlain() { await Task.Yield(); return null; }

    [HttpGet("actionresult")]
    public ActionResult<Person?> GetActionResult() => (Person?)null;

    [HttpGet("task")]
    public async Task<ActionResult<Person?>> GetTask() { await Task.Yield(); return (Person?)null; }

    [HttpGet("attr")]
    [ProducesResponseType<Person>(StatusCodes.Status200OK)]
    public IActionResult GetAttr() => Ok(null);

    [HttpGet("arint")]
    public ActionResult<int?> GetArInt() => (int?)null;
}
```

Dies ist das jeweils erzeugte `200`-Antwortschema:

| Rückgabetyp | .NET 10.0.13 | .NET 11 RC2 |
|---|---|---|
| `Person?` | nullbar (`oneOf`) | nullbar (`oneOf`) |
| `Task<Person?>` | **nicht nullbar** | nullbar |
| `ActionResult<Person?>` | **nicht nullbar** | **nicht nullbar** |
| `Task<ActionResult<Person?>>` | **nicht nullbar** | **nicht nullbar** |
| `IActionResult` + `[ProducesResponseType<Person>]` | **nicht nullbar** | **nicht nullbar** |
| `ActionResult<int?>` | `type: ["null", "integer", "string"]`, kein `oneOf` | nullbar (`oneOf`) |
| Minimal API `Person? () => null` | nullbar (`oneOf`) | nullbar (`oneOf`) |

"Nullbar" bedeutet hier, dass das Schema so aussah:

```json
"schema": {
  "oneOf": [
    { "type": "null" },
    { "$ref": "#/components/schemas/Person" }
  ]
}
```

und "nicht nullbar" bedeutet ein reines `{ "$ref": "#/components/schemas/Person" }`. Die Komponente `Person` selbst wird nie als nullbar markiert. Das ist Absicht: Seit .NET 10 RC1 ([dotnet/aspnetcore#63301](https://github.com/dotnet/aspnetcore/pull/63301)) behält der Generator pro Typ eine gemeinsame Komponente und drückt die Nullbarkeit an der Verwendungsstelle über einen Inline-`oneOf`-Wrapper aus. So spaltet sich ein Typ, der an einem Endpunkt nullbar und an einem anderen nicht nullbar ist, nicht in zwei Komponenten auf.

## Warum ActionResult<T?> die Annotation verliert

Die Entscheidung fällt in einer einzigen internen Methode, `TypeExtensions.ShouldApplyNullableResponseSchema` in `src/OpenApi/src/Extensions/TypeExtensions.cs`. Im Tag `v10.0.0` geht sie so vor:

1. Die `MethodInfo` der Action aus dem `ControllerActionDescriptor` holen.
2. `Task<T>` oder `ValueTask<T>` aus `MethodInfo.ReturnType` entpacken.
3. Wenn dieser Typ nicht *gleich* `ApiResponseType.Type` ist (dem Typ, den ApiExplorer für die Antwort meldet), `false` zurückgeben.
4. Andernfalls `NullabilityInfoContext.Create(methodInfo.ReturnParameter)` ausführen und prüfen, ob `WriteState == Nullable` gilt.

An Schritt 3 scheitert `ActionResult<Person?>`. ApiExplorer meldet den Antworttyp als `Person`, die Methode gibt `ActionResult<Person>` zurück, die beiden Typen sind nicht gleich, fertig. Die Nullbarkeitsprüfung wird nie erreicht. Dasselbe gilt für `IActionResult` mit einem Attribut: Der Rückgabetyp ist `IActionResult`, der Antworttyp `Person`.

Schritt 4 erklärt den Fehlschlag bei `Task<Person?>` unter .NET 10. Der entpackte Typ passt, aber die Nullbarkeitsprüfung läuft auf dem *ursprünglichen* Rückgabeparameter, also `Task<Person?>`. Der `Task` selbst ist nicht nullbar, daher ist `WriteState` gleich `NotNull`.

[dotnet/aspnetcore#67661](https://github.com/dotnet/aspnetcore/pull/67661), im Juli 2026 gemergt und mit .NET 11 ausgeliefert, hat die Methode neu geschrieben. Sie bricht jetzt bei `ModelMetadata.IsNullableValueType` vorzeitig ab (das behebt `ActionResult<int?>`) und läuft bei Referenztypen über `NullabilityInfo.GenericTypeArguments[0]` durch `Task<>`/`ValueTask<>` (das behebt `Task<Person?>`). `ActionResult<>` entpackt sie nicht. Bei einem Referenztyp hört `NullabilityInfo` deshalb bei `ActionResult<Person?>` auf, was nicht null ist, und das Ergebnis bleibt `false`. Die PR-Beschreibung sagt das selbst: Die Behandlung von Referenztypen sei in diesem PR "still not handled very well". Der RC2-Tag und `main` enthalten denselben Code wie RC1, rechnen Sie also nicht damit, dass sich das vor GA ändert.

## Lösung: ein Operation Transformer, der ActionResult<T> entpackt

Die integrierte Pipeline übergibt Ihnen in einem Operation Transformer die vollständige `ApiDescription`. Das reicht, um die Prüfung korrekt neu durchzuführen. Dieser Transformer deckt zwei Fälle ab: Nullbarkeit, die sich aus dem Rückgabetyp ableiten lässt, und ein explizites Attribut `[NullableResponse(statusCode)]` für `IActionResult`-Actions, bei denen es nichts abzuleiten gibt.

```csharp
// .NET 10 and .NET 11 (Microsoft.AspNetCore.OpenApi 10.0.x / 11.0.0-rc.2)
using System.Reflection;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

[AttributeUsage(AttributeTargets.Method, AllowMultiple = true)]
public sealed class NullableResponseAttribute(int statusCode) : Attribute
{
    public int StatusCode { get; } = statusCode;
}

public sealed class NullableResponseTransformer : IOpenApiOperationTransformer
{
    public Task TransformAsync(
        OpenApiOperation operation,
        OpenApiOperationTransformerContext context,
        CancellationToken cancellationToken)
    {
        if (context.Description.ActionDescriptor is not ControllerActionDescriptor action
            || operation.Responses is null)
        {
            return Task.CompletedTask;
        }

        // 1. Explicit opt-in: [NullableResponse(200)]
        var statusCodes = action.MethodInfo
            .GetCustomAttributes<NullableResponseAttribute>()
            .Select(a => a.StatusCode)
            .ToHashSet();

        // 2. Inferred from the return type: T?, ActionResult<T?>, and their Task/ValueTask forms
        if (TryGetNullableResponseType(action.MethodInfo, out var valueType))
        {
            foreach (var responseType in context.Description.SupportedResponseTypes)
            {
                if (responseType.Type == valueType && responseType.StatusCode is >= 200 and < 300)
                {
                    statusCodes.Add(responseType.StatusCode);
                }
            }
        }

        foreach (var statusCode in statusCodes)
        {
            if (!operation.Responses.TryGetValue(statusCode.ToString(), out var response)
                || response.Content is null)
            {
                continue;
            }

            foreach (var mediaType in response.Content.Values)
            {
                // Microsoft.OpenApi 3.x (.NET 11) exposes IOpenApiMediaType with a read-only Schema.
                if (mediaType is OpenApiMediaType { Schema: { } schema } concrete && !IsNullWrapper(schema))
                {
                    concrete.Schema = new OpenApiSchema
                    {
                        OneOf = [new OpenApiSchema { Type = JsonSchemaType.Null }, schema]
                    };
                }
            }
        }

        return Task.CompletedTask;
    }

    private static bool TryGetNullableResponseType(MethodInfo method, out Type? valueType)
    {
        var type = method.ReturnType;
        var nullability = new NullabilityInfoContext().Create(method.ReturnParameter);

        if (type.IsGenericType
            && (type.GetGenericTypeDefinition() == typeof(Task<>)
                || type.GetGenericTypeDefinition() == typeof(ValueTask<>)))
        {
            type = type.GetGenericArguments()[0];
            nullability = nullability.GenericTypeArguments[0];
        }

        if (type.IsGenericType && type.GetGenericTypeDefinition() == typeof(ActionResult<>))
        {
            type = type.GetGenericArguments()[0];
            nullability = nullability.GenericTypeArguments[0];
        }

        valueType = type;
        return nullability.WriteState == NullabilityState.Nullable;
    }

    private static bool IsNullWrapper(IOpenApiSchema schema) =>
        schema.OneOf?.Any(s => s.Type == JsonSchemaType.Null) == true;
}
```

Registrieren Sie ihn für jedes Dokument, das Sie bereitstellen:

```csharp
// .NET 10 / .NET 11 RC2
builder.Services.AddControllers();
builder.Services.AddOpenApi(o => o.AddOperationTransformer<NullableResponseTransformer>());
```

Und verwenden Sie das Attribut dort, wo der Rückgabetyp nichts aussagt:

```csharp
// .NET 10 / .NET 11 RC2
[HttpGet("attr")]
[ProducesResponseType<Person>(StatusCodes.Status200OK)]
[NullableResponse(StatusCodes.Status200OK)]
public IActionResult GetAttr() => Ok(null);
```

Mit registriertem Transformer kam jede Zeile der obigen Tabelle auf beiden Versionen als `oneOf`-Wrapper heraus, einschließlich `Task<Person?>` unter .NET 10. Ein nicht nullbares `ActionResult<Person>` blieb ein einfacher `$ref`.

Einige Designentscheidungen, die erwähnenswert sind:

- **Er umhüllt die Verwendungsstelle, nicht die Komponente.** Das entspricht dem, was das Framework seit #63301 selbst tut. Wenn Sie stattdessen in einem Schema Transformer `Type |= JsonSchemaType.Null` auf der Komponente `Person` setzen, wird jeder Endpunkt, der `Person` zurückgibt, nullbar, auch die, die nie null liefern.
- **Er fasst nur 2xx-Antworten an, deren Typ zum deklarierten `T` passt.** Ein `404` mit `ProblemDetails` an derselben Action bleibt unberührt.
- **Er ist idempotent.** Hat das Framework das Schema bereits umhüllt (reines `Person?` oder `Task<Person?>` unter .NET 11), überspringt `IsNullWrapper` es, sodass kein `oneOf` in einem `oneOf` entsteht. Sobald das Framework `ActionResult<T?>` unterstützt, wird der Transformer stillschweigend zum No-op.
- **Das Muster `is OpenApiMediaType` ist für .NET 11 da.** `Microsoft.AspNetCore.OpenApi` 10.0.13 zieht `Microsoft.OpenApi` 2.x nach sich, wo die Werte von `Content` das konkrete `OpenApiMediaType` sind. Das Paket 11.0 RC2 zieht `Microsoft.OpenApi` 3.10.2 nach sich, wo `Content` ein `IDictionary<string, IOpenApiMediaType>` ist und `IOpenApiMediaType.Schema` keinen Setter hat. Eine Zuweisung über das Interface scheitert mit `CS0200: Property or indexer 'IOpenApiMediaType.Schema' cannot be assigned to -- it is read only`. Der Pattern Match lässt sich gegen beide kompilieren.

Zur allgemeinen Funktionsweise von Transformern (Reihenfolge, DI-Aktivierung, das Kontextobjekt) siehe [den ausführlichen Beitrag zu Transformern](/de/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/).

## Die Falle: Ein null-Ergebnis eines Controllers ergibt 204, nicht 200

Das haben dieselben Endpunkte tatsächlich über die Leitung geliefert, identisch unter .NET 10 und .NET 11 RC2:

```text
GET /people/actionresult   -> HTTP/1.1 204 No Content   (no body)
GET /people/plain          -> HTTP/1.1 204 No Content
GET /people/taskplain      -> HTTP/1.1 204 No Content
GET /minimal/maybe         -> HTTP/1.1 200 OK, application/json, body: null
```

MVC registriert standardmäßig `HttpNoContentOutputFormatter`, dessen Eigenschaft `TreatNullValueAsNoContent` standardmäßig `true` ist: Jedes `null`-Objektergebnis wird zu einem `204` mit leerem Body. Minimal APIs haben diesen Formatter nicht, sie senden tatsächlich `200` mit dem JSON-Literal `null`.

Das heißt für Controller: Der `oneOf`-Wrapper des Frameworks an einem reinen `Person?` beschreibt bereits eine Antwort, die der Server nie sendet. Ein aus dieser Spezifikation generierter Client erwartet `200` mit `null` und bekommt `204`. Wählen Sie also einen von zwei ehrlichen Verträgen.

### Option A: 204 beibehalten und dokumentieren

Lassen Sie MVC in Ruhe, halten Sie das `200`-Schema nicht nullbar und deklarieren Sie den `204`:

```csharp
// .NET 10 / .NET 11 RC2: null result -> 204 No Content
[HttpGet("{id:int}")]
[ProducesResponseType(StatusCodes.Status200OK)]
[ProducesResponseType(StatusCodes.Status204NoContent)]
public async Task<ActionResult<Person?>> Get(int id) => await _people.FindAsync(id);
```

In diesem Aufbau wollen Sie den Nullbar-Wrapper nicht auf `200`. Registrieren Sie den Transformer also nicht, und beachten Sie, dass ein reines `Person?` als Rückgabetyp den Wrapper trotzdem vom Framework erhält. Die meisten Client-Generatoren behandeln einen `204` ohne Body als "kein Ergebnis", was Aufrufer ohnehin meist wollen.

### Option B: 200 mit null senden und 200 als nullbar markieren

Schalten Sie die No-Content-Umwandlung ab und lassen Sie den Transformer das Ergebnis beschreiben:

```csharp
// .NET 10 / .NET 11 RC2: null result -> 200 OK with body "null"
using Microsoft.AspNetCore.Mvc.Formatters;

builder.Services.AddControllers(o =>
{
    var noContent = o.OutputFormatters.OfType<HttpNoContentOutputFormatter>().Single();
    noContent.TreatNullValueAsNoContent = false;
});
builder.Services.AddOpenApi(o => o.AddOperationTransformer<NullableResponseTransformer>());
```

Nach dieser Änderung lieferte `GET /people/actionresult` `HTTP/1.1 200 OK`, `Content-Type: application/json; charset=utf-8` und den Body `null`, genau das, was das `oneOf`-Schema aussagt. Eine `void`-Action blieb unverändert (sie lieferte vor und nach der Änderung `200` mit leerem Body). Die Seite zur Formatierung bei Microsoft Learn zeigt den anderen Weg, `o.OutputFormatters.RemoveType<HttpNoContentOutputFormatter>()`. Ich bevorzuge es, die Eigenschaft umzuschalten, weil das die Absicht ausdrückt und die übrigen Fälle des Formatters unangetastet lässt.

Verwenden Sie Option B, wenn die API von etwas genutzt wird, das bereits `200`/`null` erwartet, oder wenn Sie Endpunkte zwischen Controllern und Minimal APIs verschieben und beide gleich verhalten sollen. Verwenden Sie in allen anderen Fällen Option A. Das ist der Framework-Standard und braucht keinen Transformer.

## Stolperfallen und Sonderfälle

**Jedes `[ProducesResponseType]` entfernt die abgeleitete 200.** In meinem ersten Test habe ich nur `[ProducesResponseType(StatusCodes.Status404NotFound)]` an die Action mit `ActionResult<Person?>` gesetzt, und die `200`-Antwort verschwand vollständig aus dem Dokument, sodass der Transformer nichts zum Umhüllen hatte. Sobald eine Action explizite Antwort-Metadaten hat, fügt ApiExplorer für `ActionResult<T>` die Standard-`200` nicht mehr hinzu. Ergänzen Sie neben Ihren Fehlercodes `[ProducesResponseType(StatusCodes.Status200OK)]` (ein Typ ist nicht nötig, `T` wird eingesetzt).

**`string?` ist kein JSON.** Eine `string?`-Action, die null zurückgab, lieferte bei abgeschaltetem `TreatNullValueAsNoContent` `200` mit `Content-Type: text/plain` und leerem Body, weil bei Strings `StringOutputFormatter` gewinnt. Das Dokument bewirbt weiterhin `application/json` mit einem nullbaren String. Wenn Sie aus Controllern Strings zurückgeben, fügen Sie `[Produces("application/json")]` hinzu oder geben Sie ein kleines DTO zurück.

**Die Ausgabe für OpenAPI 3.0 sieht anders aus, bedeutet aber dasselbe.** Mit `o.OpenApiVersion = OpenApiSpecVersion.OpenApi3_0` serialisiert `Microsoft.OpenApi` den Null-Zweig als `{ "enum": [null], "nullable": true }` innerhalb des `oneOf`. Das ist in 3.0 gültig, und Generatoren verstehen es. Der Standard ist `3.1.1` unter .NET 10 und `3.2.0` unter .NET 11. Wenn Swagger UI das 3.2-Dokument ablehnt, siehe [die Swagger-UI-Lösung für .NET 11](/de/2026/08/fix-swagger-ui-unable-to-render-this-definition-after-upgrading-to-dotnet-11/).

**Der Nullable-Kontext ist wichtig.** `NullabilityInfoContext` liest die `[Nullable]`-Metadaten des Compilers. In einer Datei oder einem Projekt mit deaktivierten nullbaren Referenztypen ist `Person?` eine Warnung, und `Person` wird als `Unknown` gemeldet, nicht als `Nullable`. Weder das Framework noch der Transformer markieren dann etwas. Das ist das richtige Ergebnis: Oblivious-Code gibt in keine Richtung ein Versprechen ab.

**Typed Results sind ein eigener Codepfad.** Minimal APIs und Controller, die `Results<Ok<Person>, NotFound>` zurückgeben, beschreiben Antworten über `IEndpointMetadataProvider`, nicht über den Rückgabetyp der Methode. Ich habe sowohl eine Minimal API mit `Results<Ok<Person?>, NotFound>` als auch eine Controller-Action mit `Ok<Person?>` geprüft: Unter .NET 10 und .NET 11 RC2 war das `200`-Schema eine einfache `Person`-Referenz. Auch der obige Transformer leitet aus `Ok<T>` nichts ab. Setzen Sie daher `[NullableResponse(200)]` an diese Controller-Actions (für Minimal APIs verwenden Sie stattdessen `AddOperationTransformer` mit einer Prüfung auf die Route, da es dort keinen `ControllerActionDescriptor` gibt). Wenn Sie zwischen den Formen abwägen, zeigt [Typed Results vs IResult vs IActionResult](/de/2026/07/typed-results-vs-iresult-vs-iactionresult-in-aspnetcore-11/), was jede davon ApiExplorer mitteilt.

**Beheben Sie es nicht in einem Schema Transformer.** Es ist verlockend, `Person` global nullbar zu machen, damit jeder `$ref` null akzeptiert. Dann verlieren Sie die Unterscheidung zwischen Endpunkten, und bei OpenAPI 3.1+ hat der `oneOf`-Wrapper, den das Framework anderswo hinzufügt, danach zwei Zweige, die beide auf `null` passen. Dadurch schlägt die `oneOf`-Validierung fehl (sie verlangt genau einen Treffer). PR #67661 nennt genau diesen Grund dafür, das innere Schema nicht nullbar zu lassen.

## Weiterlesen

- [Wie Sie das OpenAPI-Dokument mit AddOperationTransformer und AddSchemaTransformer in ASP.NET Core 11 anpassen](/de/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/)
- [Typed Results (Results<>) vs IResult vs IActionResult in ASP.NET Core 11](/de/2026/07/typed-results-vs-iresult-vs-iactionresult-in-aspnetcore-11/)
- [Von Swashbuckle zum integrierten OpenAPI-Generator in .NET 11 migrieren](/de/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/)
- [Wie Sie stark typisierten Client-Code aus einer OpenAPI-Spezifikation in .NET 11 generieren](/de/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/)
- [Fix: Swagger UI zeigt Unable to render this definition nach dem Upgrade auf .NET 11](/de/2026/08/fix-swagger-ui-unable-to-render-this-definition-after-upgrading-to-dotnet-11/)

## Quellen

- [TypeExtensions.cs (`ShouldApplyNullableResponseSchema`), dotnet/aspnetcore](https://github.com/dotnet/aspnetcore/blob/main/src/OpenApi/src/Extensions/TypeExtensions.cs)
- [Fix nullability handling in OpenApi, dotnet/aspnetcore#67661](https://github.com/dotnet/aspnetcore/pull/67661)
- [Model nullable types using oneOf in OpenAPI schema, dotnet/aspnetcore#63301](https://github.com/dotnet/aspnetcore/pull/63301)
- [Model nullable types using allOf in JSON schema (tracking issue), dotnet/aspnetcore#63029](https://github.com/dotnet/aspnetcore/issues/63029)
- [Customize OpenAPI documents, Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/customize-openapi)
- [Format response data in ASP.NET Core Web API (special-case formatters), Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/web-api/advanced/formatting)
- [HttpNoContentOutputFormatter.TreatNullValueAsNoContent, .NET API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.mvc.formatters.httpnocontentoutputformatter.treatnullvalueasnocontent)
- [NullabilityInfoContext, .NET API reference](https://learn.microsoft.com/en-us/dotnet/api/system.reflection.nullabilityinfocontext)
