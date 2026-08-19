---
title: "Lösung: OpenAPI 3.0 lässt sich nach dem Update auf Swashbuckle.AspNetCore v9 nicht mehr erzeugen"
description: "Swashbuckle 8 und neuer geben openapi 3.0.4 aus, nicht 3.0.1, und es gibt keine OpenApiSpecVersion für Patch-Versionen. Warum sich das geändert hat und vier Wege, die erwartete Zeichenkette zu erzwingen."
pubDate: 2026-08-19
template: error-page
tags:
  - "errors"
  - "swashbuckle"
  - "openapi"
  - "aspnetcore"
  - "dotnet-11"
lang: "de"
translationOf: "2026/08/fix-cannot-target-openapi-3-0-after-upgrading-swashbuckle-aspnetcore"
translatedBy: "claude"
translationDate: 2026-08-19
---

Sie haben `Swashbuckle.AspNetCore` auf 9.x aktualisiert, im Code steht weiterhin `OpenApiSpecVersion.OpenApi3_0`, und das erzeugte Dokument enthält jetzt `"openapi": "3.0.4"` statt `"openapi": "3.0.1"`. Nachgelagerte Werkzeuge lehnen es ab, und es gibt kein `OpenApi3_0_1` im Enum, das Sie auswählen könnten. Die Versionszeichenkette ist ein fest einkompiliertes Literal in `Microsoft.OpenApi`, keine Swashbuckle-Einstellung: 1.6.22 und älter schreiben `3.0.1`, 1.6.23 und neuer schreiben `3.0.4`. Swashbuckle 8.0.0 war das Release, das die Abhängigkeit auf 1.6.23 gezogen hat, deshalb trifft die Änderung jeden, der die 7.x-Grenze überschreitet. Die Lösungen unten in dieser Reihenfolge: den Konsumenten aktualisieren, die Eigenschaft selbst in einer Middleware überschreiben, oder den gesamten Swashbuckle-Stack auf 7.2.0 festnageln.

Alles hier wurde mit dem .NET SDK 10.0.201 auf `net10.0` gemessen, mit Swashbuckle.AspNetCore 6.5.0, 7.2.0, 8.1.4, 9.0.6 und 10.2.3.

## Die Fehler im Kontext

Wenn Sie die CLI direkt nach der Patch-Version fragen:

```text
System.NotSupportedException: The specified OpenAPI version "3.0.1" is not supported.
   at Swashbuckle.AspNetCore.Cli.Program.<>c.<Main>b__1_5(IDictionary`2 namedArgs)
   at Swashbuckle.AspNetCore.Cli.CommandRunner.Run(IEnumerable`1 args)
   at Swashbuckle.AspNetCore.Cli.Program.Main(String[] args)
```

Wenn Sie `Microsoft.OpenApi` zurückhalten und Swashbuckle 9 behalten wollen:

```text
error NU1605: Warning As Error: Detected package downgrade: Microsoft.OpenApi from 1.6.25 to 1.6.22.
  Reference the package directly from the project to select a different version.
   MyApi -> Swashbuckle.AspNetCore 9.0.6 -> Swashbuckle.AspNetCore.Swagger 9.0.6 -> Microsoft.OpenApi (>= 1.6.25)
   MyApi -> Microsoft.OpenApi (>= 1.6.22)
```

Und wenn Sie NU1605 unterdrücken und es trotzdem versuchen:

```text
error CS1705: Assembly 'Swashbuckle.AspNetCore.SwaggerGen' with identity
'Swashbuckle.AspNetCore.SwaggerGen, Version=9.0.6.0, ...' uses 'Microsoft.OpenApi, Version=1.6.25.0, ...'
which has a higher version than referenced assembly 'Microsoft.OpenApi' with identity
'Microsoft.OpenApi, Version=1.6.22.0, ...'
```

Ältere Swagger-UI-Builds stellen das Dokument so dar:

```text
Unable to render this definition
The provided definition does not specify a valid version field.
Please indicate a valid Swagger or OpenAPI version field. Supported version fields are
swagger: "2.0" and those that match openapi: 3.x.y (for example, openapi: 3.1.0).
```

## Warum lautet die Versionszeichenkette 3.0.4 und nicht etwas Steuerbares?

`OpenApiSpecVersion` ist ein kleines Enum, und keines seiner Mitglieder trägt eine Patch-Nummer. In `Microsoft.OpenApi` 1.6.25, wovon Swashbuckle 9.0.6 abhängt, hat es genau zwei Mitglieder:

```text
OpenApi2_0
OpenApi3_0
```

In `Microsoft.OpenApi` 2.7.5, wovon Swashbuckle 10.2.3 abhängt, kommt eines dazu:

```text
OpenApi2_0
OpenApi3_0
OpenApi3_1
```

Es gibt kein Mitglied 3.0.1, 3.0.3 oder 3.0.4, weil die Patch-Version keine Serialisierungsoption ist. `OpenApiDocument.SerializeAsV3` schreibt eine Konstante aus der Kompilierzeit. Die Änderung wird an einem String-Dump der ausgelieferten Assemblies sichtbar:

```text
strings -a -e l on lib/netstandard2.0/Microsoft.OpenApi.dll:
  1.2.3   -> 3.0.1
  1.6.22  -> 3.0.1
  1.6.23  -> 3.0.4
  1.6.25  -> 3.0.4
  2.7.5   -> 3.0.4 and 3.1.1
```

Die Anhebung kam mit [OpenAPI.NET PR #2011](https://github.com/microsoft/OpenAPI.NET/pull/2011), gemerged am 2024-12-20, der das v2-Verhalten in die v1-Linie zurückportiert hat. Es ist kein Fehler: OpenAPI 3.0.4 ist ein echtes Patch-Release der Spezifikation, und den neuesten Patch auszugeben ist das korrekte Standardverhalten. Das Problem ist, dass viele Konsumenten das Feld `openapi` gegen eine fest verdrahtete Liste erlaubter Werte prüfen statt gegen ein `3.0.x`-Muster.

## Welche Swashbuckle-Version gibt welche Patch-Version aus?

Das Feld `openapi` folgt dem tatsächlich aufgelösten `Microsoft.OpenApi`-Assembly, nicht der Swashbuckle-Version, die in der csproj steht:

| Swashbuckle.AspNetCore | Microsoft.OpenApi (deklariert) | Feld `openapi` |
| --- | --- | --- |
| 6.5.0 | 1.2.3 | `3.0.1` |
| 7.2.0 | 1.6.22 | `3.0.1` |
| 8.0.0 bis 8.1.4 | 1.6.23 | `3.0.4` |
| 9.0.0 bis 9.0.6 | 1.6.23 bis 1.6.25 | `3.0.4` |
| 10.0.0 bis 10.2.3 | 2.3.0 bis 2.7.5 | `3.0.4`, oder `3.1.1` mit `OpenApi3_1` |

Zwei Punkte dazu. Erstens ist 8.0.0 die eigentliche Grenze, nicht 9.0.0: wer von 7.x direkt auf 9.x gesprungen ist, hat sie unbemerkt überschritten. Zweitens ist die NuGet-Abhängigkeit eine Untergrenze, keine Festlegung. Ein Projekt auf Swashbuckle 7.2.0, das zusätzlich etwas referenziert, das `Microsoft.OpenApi` 1.6.23 oder neuer mitzieht, löst auf das neuere Assembly auf und gibt plötzlich `3.0.4` aus, ganz ohne Swashbuckle-Änderung. Wenn sich Ihr Dokument geändert hat, Ihre Swashbuckle-Version aber nicht, führen Sie das hier zuerst aus:

```bash
dotnet list package --include-transitive
```

## Minimale Reproduktion auf net10.0

```csharp
// .NET SDK 10.0.201, net10.0, Swashbuckle.AspNetCore 9.0.6
using Microsoft.OpenApi;
using Microsoft.OpenApi.Models;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen(o =>
    o.SwaggerDoc("v1", new OpenApiInfo { Title = "Demo", Version = "v1" }));

var app = builder.Build();
app.UseSwagger(o => o.OpenApiVersion = OpenApiSpecVersion.OpenApi3_0);
app.MapGet("/orders/{id}", (int id) => new Order(id, "open", null)).WithName("GetOrder");
app.Run();

record Order(int Id, string Status, string? Note);
```

`GET /swagger/v1/swagger.json` liefert:

```json
{
  "openapi": "3.0.4",
  "info": { "title": "Demo", "version": "v1" },
  "paths": { }
}
```

`OpenApiVersion` explizit zu setzen ändert hier nichts, denn `OpenApi3_0` ist bereits der Standard, und das Enum bietet keine feinere Abstufung.

## Kann ich der CLI stattdessen eine Patch-Version übergeben?

Nein. `dotnet swagger tofile` prüft `--openapiversion` gegen eine geschlossene Menge von drei Zeichenketten. Aus dem Quelltext von v10.2.3:

```csharp
// Swashbuckle.AspNetCore.Cli/Program.cs, v10.2.3
specVersion = versionArg switch
{
    "2.0" => OpenApiSpecVersion.OpenApi2_0,
    "3.0" => OpenApiSpecVersion.OpenApi3_0,
    "3.1" => OpenApiSpecVersion.OpenApi3_1,
    _ => throw new NotSupportedException($"The specified OpenAPI version \"{versionArg}\" is not supported."),
};
```

In 9.0.6 fehlt der Zweig `"3.1"` ebenfalls, also bleiben `2.0` und `3.0` als einzige Eingaben. Gemessene Ausgabe je akzeptiertem Wert in 10.2.3: `2.0` ergibt `"swagger": "2.0"`, `3.0` ergibt `"openapi": "3.0.4"`, `3.1` ergibt `"openapi": "3.1.1"`. Alles andere, einschließlich `3.0.1` und `3.1.1`, wirft eine Ausnahme.

Eine Randnotiz zur CLI: das Werkzeug 9.0.6 liefert einen `net9.0`-Apphost aus und startet daher nicht auf einer Maschine, die nur die .NET-10-Laufzeit hat. Setzen Sie `DOTNET_ROLL_FORWARD=Major` vor dem Aufruf, oder installieren Sie die passende Laufzeit.

## Hilft ein Downgrade von Microsoft.OpenApi auf 1.6.22?

Nicht unter Swashbuckle 9 oder 10, und genau das ist der Rat, den Sie in alten Issue-Threads am häufigsten finden. Eine direkte Referenz löst zuerst NU1605 aus, was NuGet standardmäßig als Fehler behandelt. Unterdrücken Sie das mit `<WarningsNotAsErrors>NU1605</WarningsNotAsErrors>`, löst der Restore auf 1.6.22 auf, und danach scheitert die Kompilierung mit `CS1705`, weil `Swashbuckle.AspNetCore.Swagger` 9.0.6 gegen die Assembly-Identität 1.6.25 gebaut wurde. Beide Fehler reproduzieren sich in einem frischen `net10.0`-Projekt.

Der Weg über feste Versionen funktioniert nur, wenn Sie den gesamten Stack zurücknehmen:

```xml
<!-- net10.0, verified: emits "openapi": "3.0.1" -->
<ItemGroup>
  <PackageReference Include="Swashbuckle.AspNetCore" Version="7.2.0" />
  <PackageReference Include="Microsoft.OpenApi" Version="1.6.22" />
</ItemGroup>
```

Swashbuckle 7.2.0 zielt weiterhin auf `netstandard2.0` und läuft problemlos auf `net10.0`, und es löst `Microsoft.OpenApi` 1.6.22 auf. Die explizite `Microsoft.OpenApi`-Referenz verhindert, dass eine transitive Anhebung Sie erneut nach vorne schiebt. Betrachten Sie das als Übergangslösung mit Ablaufdatum, nicht als Fix: Sie frieren einen OpenAPI-Generator zwei Hauptversionen zurück ein, und 8.x sowie 9.x enthalten Korrekturen an der Schema-Erzeugung, die Sie irgendwann brauchen werden.

## Wie überschreibe ich die Versionszeichenkette unter Swashbuckle 9 oder 10?

Es gibt keinen Hook. Die Swashbuckle-Maintainer haben das in [Issue #3540](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/issues/3540) so gesagt: `SwaggerMiddleware` serialisiert direkt in den Response-Stream, ohne etwas dazwischen. Der von ihnen vorgeschlagene Workaround, und der einzige, der wirklich trägt, ist die Antwort zu puffern und die Eigenschaft zu bearbeiten. Das funktioniert unter 9.0.6 und 10.2.3 identisch, weil es das Objektmodell nie berührt:

```csharp
// net10.0, Swashbuckle.AspNetCore 9.0.6 and 10.2.3, both verified
app.UseWhen(
    ctx => ctx.Request.Path.StartsWithSegments("/swagger")
        && ctx.Request.Path.Value!.EndsWith(".json"),
    branch => branch.Use(async (ctx, next) =>
    {
        var original = ctx.Response.Body;
        using var buffer = new MemoryStream();
        ctx.Response.Body = buffer;

        await next();

        ctx.Response.Body = original;
        if (ctx.Response.StatusCode != StatusCodes.Status200OK)
        {
            buffer.Position = 0;
            await buffer.CopyToAsync(original);
            return;
        }

        var json = Encoding.UTF8.GetString(buffer.ToArray())
            .Replace("\"openapi\": \"3.0.4\"", "\"openapi\": \"3.0.1\"", StringComparison.Ordinal);
        var bytes = Encoding.UTF8.GetBytes(json);
        ctx.Response.ContentLength = bytes.Length;
        await original.WriteAsync(bytes);
    }));

app.UseSwagger(o => o.OpenApiVersion = OpenApiSpecVersion.OpenApi3_0);
app.UseSwaggerUI();
```

Registrieren Sie das vor `UseSwagger`. Swagger UI funktioniert weiter, `/swagger/index.html` liefert weiterhin 200, und der JSON-Endpunkt gibt `3.0.1` zurück. Zwei Details sind wichtig: `ctx.Response.Body` vor dem Schreiben auf den ursprünglichen Stream zurücksetzen, und `ContentLength` nach dem Überschreiben setzen, weil die Ersetzung die Byte-Anzahl ändert. Der Filter `.EndsWith(".json")` hält die Pufferung von den statischen Dateien der UI fern. Wenn Sie zusätzlich YAML ausliefern, ergänzen Sie einen Zweig dafür, denn dort wird die Eigenschaft als `openapi: '3.0.4'` geschrieben, und die JSON-Ersetzung greift nicht.

Wenn Sie lieber nicht puffern möchten, ersetzen Sie den Endpunkt vollständig und serialisieren das Dokument selbst:

```csharp
// net10.0, Swashbuckle.AspNetCore 9.0.6
app.MapGet("/swagger/v1/swagger.json", (ISwaggerProvider provider) =>
{
    var document = provider.GetSwagger("v1");
    var node = JsonNode.Parse(document.SerializeAsJson(OpenApiSpecVersion.OpenApi3_0))!;
    node["openapi"] = "3.0.1";
    return Results.Text(
        node.ToJsonString(new JsonSerializerOptions { WriteIndented = true }),
        "application/json");
}).ExcludeFromDescription();
```

`ExcludeFromDescription()` ist nicht optional. Ohne den Aufruf entdeckt der Endpunkt sich selbst, und `/swagger/v1/swagger.json` taucht als dokumentierter Pfad in seiner eigenen Ausgabe auf. `SerializeAsJson` liegt in der 1.6.x-Linie in `Microsoft.OpenApi.Extensions`; unter Swashbuckle 10 mit `Microsoft.OpenApi` 2.x gibt es diese Erweiterung nicht mehr, dort ist die Middleware also vorzuziehen.

Für ein zur Buildzeit erzeugtes Dokument aus `dotnet swagger tofile` oder `OpenApiGenerateDocumentsOnBuild` gehört nichts davon in den Code. Erzeugen Sie es mit `--openapiversion 3.0` und korrigieren Sie die Datei als Build-Schritt:

```bash
jq '.openapi = "3.0.1"' swagger.json > swagger.tmp && mv swagger.tmp swagger.json
```

## Swagger UI lehnt die Definition weiterhin ab, was nun?

Zeigt der Browser "The provided definition does not specify a valid version field", ist das Dokument in Ordnung und die UI veraltet. swagger-ui hat 3.0.4-Unterstützung in [v5.19.0](https://github.com/swagger-api/swagger-ui/releases/tag/v5.19.0) erhalten, veröffentlicht am 2025-02-17, über [PR #10247](https://github.com/swagger-api/swagger-ui/pull/10247). Swashbuckle hat das in `Swashbuckle.AspNetCore.SwaggerUI` 7.3.0 übernommen. Alles Ältere zeigt den Fehler gegen ein vollkommen gültiges 3.0.4-Dokument.

Die Falle ist der Versionsversatz innerhalb einer Solution. `Swashbuckle.AspNetCore.SwaggerUI` ist ein eigenes Paket, und Projekte, die die drei Teilpakete einzeln referenzieren, heben oft `Swagger` und `SwaggerGen` an und lassen `SwaggerUI` zurück. Prüfen Sie alle drei und laden Sie den Browser danach mit geleertem Cache neu, denn das mitgelieferte `swagger-ui-bundle.js` wird aggressiv zwischengespeichert.

Wenn das Problem beim Renderer und nicht beim Dokument liegt, ist das auch ein guter Moment, sich [die Auslieferung der Dokumentation mit Scalar](/de/2026/08/how-to-serve-openapi-docs-with-scalar-instead-of-swagger-ui-in-aspnetcore-11/) anzusehen, das 3.0.4 und 3.1 anstandslos liest.

## Was, wenn ich tatsächlich 3.1 will?

Dann brauchen Sie Swashbuckle 10 oder neuer, denn `Microsoft.OpenApi` 1.6.x hat überhaupt kein `OpenApi3_1`-Mitglied. In 10.x ist es opt-in, der Standard bleibt also 3.0.4, und Sie fordern 3.1 explizit an:

```csharp
// net10.0, Swashbuckle.AspNetCore 10.2.3, emits "openapi": "3.1.1"
app.UseSwagger(o => o.OpenApiVersion = OpenApiSpecVersion.OpenApi3_1);
```

Planen Sie Zeit für das Update ein. Swashbuckle 10 wechselt auf `Microsoft.OpenApi` v2, das die Namespaces verflacht, deshalb trifft Sie zuerst:

```text
error CS0234: The type or namespace name 'Models' does not exist in the namespace 'Microsoft.OpenApi'
```

Entfernen Sie `using Microsoft.OpenApi.Models;`, da die Typen jetzt direkt in `Microsoft.OpenApi` liegen. Darüber hinaus werden konkrete Modelltypen zu Interfaces (`OpenApiSchema` wird zu `IOpenApiSchema`), Typnamen als Zeichenketten werden zu Werten des Enums `JsonSchemaType`, und `WithOpenApi()` wird nicht mehr unterstützt. Der [v10-Migrationsleitfaden](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/blob/master/docs/migrating-to-v10.md) empfiehlt, zuerst über 9.0.6 zu gehen, und das ist guter Rat: es trennt die Breaking Changes von 9.x (kein `netstandard2.0` mehr, entfernte obsolete Mitglieder, entferntes `--serializeasv2`) von denen aus OpenAPI.NET v2.

## Welche Lösung sollte ich wählen?

Sortiert danach, was ich tatsächlich tun würde:

1. Den Konsumenten aktualisieren. `3.0.4` ist gültiges OpenAPI 3.0, und jeder aktuelle Validator, Generator und jedes Gateway akzeptiert es. Die meisten dieser Meldungen laufen auf ein Werkzeug hinaus, das drei Versionen zurückliegt.
2. Lässt sich der Konsument als Fremdprodukt nicht bewegen, ergänzen Sie das Überschreiben in der Middleware. Das sind 20 Zeilen, es ist versionsunabhängig und friert Ihren Abhängigkeitsgraphen nicht ein.
3. Korrigieren Sie die Datei in der CI mit `jq`, wenn das Dokument zur Buildzeit erzeugt und nicht zur Laufzeit ausgeliefert wird.
4. Swashbuckle nur als Notlösung auf 7.2.0 festnageln, mit einem Ticket zum Entfernen.

Was nicht funktioniert, egal was die Suchergebnisse behaupten: `Microsoft.OpenApi` unter einem aktuellen Swashbuckle herunterzustufen, oder nach einem `OpenApiSpecVersion`-Mitglied zu suchen, das die Patch-Version kodiert.

## Verwandt

- [Von Swashbuckle zum eingebauten OpenAPI-Generator migrieren](/de/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/) deckt die Gegenrichtung ab, falls Sie Swashbuckle lieber hinter sich lassen als dessen Versionsdynamik zu verwalten.
- [Der Compilerfehler 'OpenApiReference' could not be found](/de/2026/08/fix-the-type-or-namespace-name-openapireference-could-not-be-found/) ist der Geschwisterfehler aus derselben Namespace-Verflachung in `Microsoft.OpenApi` v2.
- [IOperationFilter und ISchemaFilter auf Transformer abbilden](/de/2026/07/migrate-swashbuckle-ioperationfilter-and-ischemafilter-to-transformers-in-dotnet-11/) ist der Teil der Migration, der am längsten dauert.
- [Scalar und Swagger UI im Vergleich](/de/2026/08/scalar-vs-swagger-ui-for-openapi-documentation-in-aspnetcore-11/) lohnt sich, wenn die Versionsablehnung vom Renderer kam und nicht von einem nachgelagerten Dienst.
- [Stark typisierte Clients aus einer OpenAPI-Spezifikation erzeugen](/de/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/) ist relevant, wenn der ablehnende Konsument ein Codegenerator ist.

## Quellen

- [OpenAPI.NET PR #2011: bumps v3 patch version to 3.0.4](https://github.com/microsoft/OpenAPI.NET/pull/2011)
- [Swashbuckle.AspNetCore issue #3540: changing the openapi version in swagger.json](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/issues/3540)
- [Swashbuckle.AspNetCore issue #3216: 7.2.0 json doc says openapi 3.0.4](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/issues/3216)
- [Swashbuckle.AspNetCore issue #3265: add support for OpenAPI 3.0.4](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/issues/3265)
- [Swashbuckle.AspNetCore v9.0.0 Release Notes](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/releases/tag/v9.0.0)
- [Swashbuckle.AspNetCore v10.0.0 Release Notes](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/releases/tag/v10.0.0)
- [Swashbuckle.AspNetCore v10-Migrationsleitfaden](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/blob/master/docs/migrating-to-v10.md)
- [swagger-ui v5.19.0 Release Notes](https://github.com/swagger-api/swagger-ui/releases/tag/v5.19.0)
