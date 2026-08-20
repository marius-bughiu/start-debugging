---
title: "Fix: [FromForm] Dictionary<string, string> ist in einer Minimal API immer null"
description: "Ein Dictionary mit [FromForm] bindet in einer Minimal API mit leerem Präfix: die Formularschlüssel müssen [key] heißen, nicht metadata[key]. Kapseln Sie es in einer Klasse für lesbare Namen."
pubDate: 2026-08-20
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-apis"
lang: "de"
translationOf: "2026/08/fix-fromform-dictionary-is-always-null-in-a-minimal-api"
translatedBy: "claude"
translationDate: 2026-08-20
---

Ein Parameter `[FromForm] Dictionary<string, string>` in einer Minimal API verwendet den Parameternamen nicht als Präfix für die Formularschlüssel. Der Form-Mapper beginnt an der Wurzel des Formulars und sucht deshalb nach `[author]` und `[env]`, nicht nach `metadata[author]` oder `metadata.author`. Senden Sie Schlüssel in eckigen Klammern ohne Präfix oder, besser, kapseln Sie das Dictionary in einer Klasse und senden Sie `Metadata[author]`, damit das Format auf der Leitung lesbar bleibt. Wenn die Schlüssel nicht passen, wird nichts protokolliert und kein `400` zurückgegeben: der Parameter kommt schlicht als `null` an.

Alles Folgende wurde mit ASP.NET Core 10.0.5 und SDK 10.0.201 gemessen. Der relevante Bindungscode ist im Branch `release/11.0` identisch, das Verhalten gilt also auch in .NET 11.

## Der Fehler im Kontext

Es gibt keine Exception, nach der man suchen könnte, und genau deshalb kostet dieser Fall einen ganzen Nachmittag. Der Handler läuft, die Datei wird gebunden, und das Dictionary ist `null`:

```csharp
// .NET 10.0.201, ASP.NET Core 10.0.5
app.MapPost("/broken", ([FromForm] Dictionary<string, string> metadata, IFormFile file) =>
    Results.Text($"metadata={(metadata is null ? "null" : JsonSerializer.Serialize(metadata))}, file={file?.FileName}"))
   .DisableAntiforgery();
```

```bash
curl -X POST http://localhost:5222/broken \
  -F "metadata[author]=marius" -F "metadata[env]=prod" -F "file=@a.txt"
```

```text
metadata=null, file=a.txt
```

Dasselbe `null` kommt bei `metadata.author=marius` zurück, bei einem einfachen `author=marius` und bei einer Anfrage, die die Schlüssel ganz weglässt. Der Statuscode ist jedes Mal `200`.

Eine Exception sehen Sie erst, wenn die Schlüssel nahe genug sind, dass der Mapper sie überhaupt liest. Mit einem `Dictionary<string, int>` und einem Wert, der sich nicht parsen lässt:

```text
Microsoft.AspNetCore.Http.BadHttpRequestException: The value 'notanint' is not valid for 'b'.
 ---> Microsoft.AspNetCore.Components.Endpoints.FormMapping.FormDataMappingException
   at Microsoft.AspNetCore.Components.Endpoints.FormMapping.DictionaryConverter`5.TryRead(...)
```

Dieser Stack Trace ist der Hinweis. Der Typ, der die Arbeit macht, liegt in `Microsoft.AspNetCore.Components.Endpoints.FormMapping`, derselben Form-Mapping-Schicht, die auch Blazor nutzt, und ihre Schlüsselkonventionen sind nicht die, die Sie von MVC kennen.

## Warum das passiert

Die Formularbindung in Minimal APIs hat zwei vollständig getrennte Codepfade, und welchen ein Parameter nimmt, entscheidet ein einziges Prädikat in `RequestDelegateFactory`:

```csharp
// dotnet/aspnetcore, src/Http/Http.Extensions/src/RequestDelegateFactory.cs, release/10.0
var useSimpleBinding = parameter.ParameterType == typeof(string) ||
    parameter.ParameterType == typeof(StringValues) ||
    parameter.ParameterType == typeof(StringValues?) ||
    ParameterBindingMethodCache.Instance.HasTryParseMethod(parameter.ParameterType) ||
    (parameter.ParameterType.IsArray && ParameterBindingMethodCache.Instance.HasTryParseMethod(parameter.ParameterType.GetElementType()!));
hasTryParse = useSimpleBinding;
return useSimpleBinding
    ? BindParameterFromFormItem(parameter, formAttribute.Name ?? parameter.Name, factoryContext)
    : BindComplexParameterFromFormItem(parameter, string.IsNullOrEmpty(formAttribute.Name) ? parameter.Name : formAttribute.Name, factoryContext);
```

Die einfache Bindung liest `HttpContext.Request.Form[key]`, wobei `key` der Parametername ist. Das ist das Verhalten, das alle erwarten, und Sie bekommen es für `string`, `int`, `Guid`, `DateOnly` und jeden anderen Typ mit einem `TryParse`.

`Dictionary<string, string>` hat kein `TryParse` und landet daher in `BindComplexParameterFromFormItem`, das das gesamte Formular an den gemeinsamen Mapper übergibt:

```csharp
// FormDataMapper.Map<Dictionary<string, string>>(name_reader, FormDataMapperOptions);
var invokeMapMethodExpr = Expression.Call(
    FormDataMapperMapMethod.MakeGenericMethod(parameter.ParameterType),
    formReader,
    Expression.Constant(formDataMapperOptions));
```

Sehen Sie sich die Argumente an: den Reader und die Optionen. Es gibt kein Präfix. Der `key` aus der Zeile darüber dient nur als Dictionary-Schlüssel in `factoryContext.TrackedParameters` und wird nie auf den Präfix-Stack des Readers gelegt. Der Mapper liest das Dictionary deshalb ab der Wurzel des Formulars, und ein Dictionary-Eintrag auf Wurzelebene schreibt sich `[author]`.

Das ist der gesamte Fehler: der Parameter heißt `metadata`, aber dem Form-Mapper wurde dieser Name nie mitgeteilt.

Das erklärt auch, warum sich das Verhalten wie eine Regression anfühlt, wenn Sie einen Endpunkt von Controllern umziehen. Der Model Binder von MVC probiert zuerst den Parameternamen als Präfix und fällt dann auf das leere Präfix zurück, eine Controller-Action akzeptiert also beide Schreibweisen:

```csharp
// .NET 10.0.201, controller action, both curl shapes below return the same result
[HttpPost("dict")]
public IActionResult Dict([FromForm] Dictionary<string, string> metadata, IFormFile file)
    => Content($"count={metadata?.Count}");
```

```text
curl -F "metadata[author]=marius" -F "file=@a.txt"   ->  count=1
curl -F "[author]=marius"         -F "file=@a.txt"   ->  count=1
```

Minimal APIs akzeptieren nur die zweite. Wenn Sie die beiden Hosting-Modelle grundsätzlicher abwägen, behandelt [Minimal APIs vs Controller in ASP.NET Core 11](/de/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) die weiteren Stellen, an denen ihre Bindungssemantik auseinandergeht.

## Minimale Reproduktion

Eine vollständige Anwendung, dazu die Anfrageformen, die funktionieren, und die, die es nicht tun:

```csharp
// .NET 10.0.201, ASP.NET Core 10.0.5
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddAntiforgery();
var app = builder.Build();
app.UseAntiforgery();

app.MapPost("/dict", ([FromForm] Dictionary<string, string> metadata, IFormFile file) =>
    Results.Text($"metadata={(metadata is null ? "null" : JsonSerializer.Serialize(metadata))}, file={file?.FileName}"))
   .DisableAntiforgery();

app.MapPost("/list", ([FromForm] List<string> tags, IFormFile file) =>
    Results.Text($"tags={(tags is null ? "null" : JsonSerializer.Serialize(tags))}"))
   .DisableAntiforgery();

app.Run();
```

Gemessene Ergebnisse gegen diese Anwendung:

| Anfrage | Ergebnis |
| --- | --- |
| `-F "metadata[author]=marius"` | `metadata=null` |
| `-F "metadata.author=marius"` | `metadata=null` |
| `-F "author=marius"` | `metadata=null` |
| `-F "[author]=marius" -F "[env]=prod"` | `metadata={"author":"marius","env":"prod"}` |
| `-F "tags=a" -F "tags=b"` | `tags=null` |
| `-F "tags[0]=a" -F "tags[1]=b"` | `tags=null` |
| `-F "[0]=a" -F "[1]=b"` | `tags=["a","b"]` |

Das Muster ist konsistent: ein `[FromForm]`-Sammlungsparameter auf oberster Ebene wird mit leerem Präfix adressiert, Dictionaries verwenden also `[key]` und Listen `[0]`, `[1]` und so weiter. Der Parametername ist totes Gewicht.

## Der Fix im Detail

Vier Optionen, in der Reihenfolge, in der ich zu ihnen greifen würde.

### 1. Kapseln Sie das Dictionary in einer Klasse

Das ist der Fix, den man ausliefern sollte. Eine Eigenschaft einer Klasse bekommt sehr wohl ein Präfix, weil der Mapper den Eigenschaftsnamen beim Abstieg auf seinen Präfix-Stack legt. Das Format auf der Leitung wird dadurch wieder etwas, das ein Mensch lesen und eine Client-Bibliothek erzeugen kann.

```csharp
// .NET 10.0.201, ASP.NET Core 10.0.5
app.MapPost("/upload", ([FromForm] UploadRequest request, IFormFile file) =>
    Results.Text($"request={JsonSerializer.Serialize(request)}, file={file?.FileName}"))
   .DisableAntiforgery();

public class UploadRequest
{
    public Dictionary<string, string> Metadata { get; set; } = new();
}
```

```bash
curl -X POST http://localhost:5222/upload \
  -F "Metadata[author]=marius" -F "Metadata[env]=prod" -F "file=@a.txt"
```

```text
request={"Metadata":{"author":"marius","env":"prod"}}, file=a.txt
```

Der Schlüsselabgleich ist unabhängig von Groß- und Kleinschreibung, `metadata[author]` bindet also ebenfalls an die Eigenschaft `Metadata`. Das verschachtelte Dictionary darf auch tiefer liegen: `Meta.Tags[a]=1` bindet problemlos, wenn `Meta` selbst eine Eigenschaft ist.

Sie können die Datei in dieselbe Klasse ziehen, damit die Endpunktsignatur bei einem einzigen Parameter bleibt:

```csharp
// .NET 10.0.201, ASP.NET Core 10.0.5
app.MapPost("/upload", ([FromForm] UploadWithFile request) =>
    Results.Text($"metadata={JsonSerializer.Serialize(request.Metadata)}, file={request.File?.FileName}"))
   .DisableAntiforgery();

public class UploadWithFile
{
    public Dictionary<string, string> Metadata { get; set; } = new();
    public IFormFile? File { get; set; }
}
```

Ein Post mit `-F "Metadata[author]=marius" -F "File=@a.txt"` bindet beides. Die Datei-Eigenschaft wird über den Eigenschaftsnamen zugeordnet, dieselbe Regel gilt für einen `IFormFile`-Parameter auf oberster Ebene.

### 2. Dictionary-Parameter behalten und den Client anpassen

Wenn der Client Ihnen gehört und die Endpunktsignatur feststeht, senden Sie einfach Klammer-Schlüssel auf Wurzelebene:

```bash
curl -X POST http://localhost:5222/dict \
  -F "[author]=marius" -F "[env]=prod" -F "file=@a.txt"
```

Das funktioniert und kostet ein Zeichen pro Schlüssel. Es ist aber auch die Form, die niemand errät, der den Handler in sechs Monaten liest, und sie überlebt keinen zweiten Dictionary-Parameter (siehe die Fallstricke). Betrachten Sie es als Übergangslösung.

### 3. Lesen Sie das Formular selbst

Die expliziteste Option und die einzige, die den Request Delegate Generator überlebt. `IFormCollection` wird als Parameter für das gesamte Formular gebunden, ganz ohne Mapping-Schicht, die Schlüsselkonvention gehört also Ihnen:

```csharp
// .NET 10.0.201, ASP.NET Core 10.0.5
app.MapPost("/upload", (IFormCollection form) =>
{
    var metadata = form
        .Where(kv => kv.Key.StartsWith("metadata[", StringComparison.Ordinal) && kv.Key.EndsWith(']'))
        .ToDictionary(kv => kv.Key[9..^1], kv => kv.Value.ToString());

    return Results.Text($"metadata={JsonSerializer.Serialize(metadata)}, files={form.Files.Count}");
}).DisableAntiforgery();
```

```text
metadata={"author":"marius","env":"prod"}, files=1
```

Ausführlich, aber es akzeptiert `metadata[author]` direkt und liefert einen echten Fehlerpfad bei einem fehlerhaften Schlüssel statt eines stillen `null`.

### 4. Die Metadaten als ein einzelnes JSON-Feld senden

Wenn die Metadaten wirklich offen sind, modellieren Sie sie nicht länger als Formularschlüssel. Ein einzelnes Formularfeld mit einem JSON-Dokument bindet über den einfachen Pfad, weil `string` das obige Prädikat kurzschließt:

```csharp
// .NET 10.0.201, ASP.NET Core 10.0.5
app.MapPost("/upload", ([FromForm] string metadata, IFormFile file) =>
{
    var parsed = JsonSerializer.Deserialize<Dictionary<string, string>>(metadata);
    return Results.Text($"metadata={JsonSerializer.Serialize(parsed)}, file={file?.FileName}");
}).DisableAntiforgery();
```

```bash
curl -X POST http://localhost:5222/upload \
  -F 'metadata={"author":"marius","env":"prod"}' -F "file=@a.txt"
```

Nur diese Option liefert verschachtelte Werte, Arrays und Nicht-String-Typen, ohne mit der Schlüsselsyntax zu kämpfen, und sie funktioniert unter AOT identisch.

## Fallstricke und Varianten

- **`null` ist kein Validierungsfehler.** Der Parametertyp ist ein nicht nullbares `Dictionary<string, string>`, und der Handler bekommt trotzdem `null`, mit einer `200`-Antwort und nichts in den Logs. Der Mapper gibt `default(T)` zurück, wenn er keinen passenden Schlüssel findet, und ein formulargebundener komplexer Parameter gilt nie als erforderlich. Prüfen Sie auf `null` oder machen Sie den Parameter nullbar, damit der Compiler Sie erinnert. Ein Eigenschaftsinitialisierer wie `= new()` rettet Sie ebenfalls nicht: das Wrapper-Objekt selbst kommt als `null` zurück, wenn kein Schlüssel zu seinem Präfix passt.

- **`[FromForm(Name = "metadata")]` setzt das Präfix nicht.** Es liest sich wie der Fix und ist keiner. Der Name dient dem Nachschlagen der getrackten Parameter und wird dann verworfen, bevor der Mapper läuft. `[FromForm(Name = "metadata")] Dictionary<string, string> metadata` bindet weiterhin von `[author]`, nicht von `metadata[author]`.

- **Zwei komplexe Formularparameter kollidieren.** Da beide mit leerem Präfix binden, lesen sie dieselben Schlüssel. Ein Endpunkt mit `[FromForm] Dictionary<string, string> first, [FromForm] Dictionary<string, string> second`, der `[a]=1&[b]=2` empfängt, liefert `first={"a":"1","b":"2"} second={"a":"1","b":"2"}`. Es gibt keine Warnung. Schon deshalb ist die Wrapper-Klasse vorzuziehen.

- **Arrays und Listen verhalten sich unterschiedlich.** `List<string> tags` ist ein komplexer Typ und braucht `[0]`, `[1]`. `int[] ids` hat einen Elementtyp mit `TryParse`, nimmt also den einfachen Pfad und bindet aus wiederholtem `ids=1&ids=2`. Und `[FromForm] string[] tags` bricht unter .NET 10 beim Start ab mit `InvalidOperationException: TryParse method found on string with incorrect format`, weil `string` inzwischen ein span-basiertes `TryParse` bereitstellt, das der Binding-Method-Cache ablehnt statt es zu ignorieren. Das ist [dotnet/aspnetcore#62326](https://github.com/dotnet/aspnetcore/issues/62326), behoben durch [PR #63072](https://github.com/dotnet/aspnetcore/pull/63072); der Merge-Commit ist Vorfahre jedes `v11.0.0-preview`-Tags und weder von `v10.0.0` noch von `v10.0.5`, der Absturz bleibt Ihnen also über den gesamten Lebenszyklus von .NET 10 erhalten.

- **Zwei verschiedene Limits, beide standardmäßig 1024.** Senden Sie 1025 Schlüssel, und Sie bekommen `InvalidDataException: Form value count limit 1024 exceeded` vom `FormPipeReader`, das ist `FormOptions.ValueCountLimit`. Erhöhen Sie es mit `services.Configure<FormOptions>(o => o.ValueCountLimit = 5000)`, und Sie laufen gegen die nächste Wand: `The number of elements in the dictionary exceeded the maximum number of '1024' elements allowed`, die eigene Obergrenze des Mappers. Diese gilt pro Endpunkt: `.WithFormMappingOptions(maxCollectionSize: 5000)`. Sie brauchen beide, und wenn Sie nur eines erhöhen, sieht es so aus, als hätte der Fix nichts bewirkt. Sind Ihre Uploads eher in Bytes als in Schlüsselanzahl groß, behandelt [413 Request Entity Too Large beim Hochladen einer Datei](/de/2026/07/fix-413-request-entity-too-large-uploading-a-file-in-aspnetcore-11/) die größenbasierten Limits.

- **Formularbindung verlangt Antiforgery-Verdrahtung.** Jeder Minimal-API-Endpunkt mit einem formulargebundenen Parameter trägt Antiforgery-Metadaten. Ruft die Anwendung nie `app.UseAntiforgery()` auf, schlägt die Anfrage mit `InvalidOperationException: Endpoint HTTP: POST /upload contains anti-forgery metadata, but a middleware was not found that supports anti-forgery` und einem `500` fehl. Fügen Sie die Middleware hinzu, oder rufen Sie `.DisableAntiforgery()` bei Maschine-zu-Maschine-Endpunkten auf. Deaktivieren Sie es nicht pauschal bei Endpunkten, an die ein Browser sendet.

- **Der Request Delegate Generator verweigert all das.** Kompilieren Sie mit `EnableRequestDelegateGenerator` auf `true` oder mit `PublishAot`, und sowohl der Dictionary-Parameter als auch die Wrapper-Klasse erzeugen `warning RDG003: Unable to statically resolve parameter named 'metadata' for endpoint`. Der Endpunkt fällt auf Generierung zur Laufzeit zurück, und genau das kann AOT nicht. `IFormCollection` erzeugt keine Warnung, Option 3 ist also die AOT-sichere Form. Siehe [Native AOT mit ASP.NET Core Minimal APIs verwenden](/de/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) für die restlichen RDG-Diagnosen.

- **Ein falscher `Content-Type` sieht aus wie derselbe Fehler.** Kommt die Anfrage als `application/json` statt als `multipart/form-data` oder `application/x-www-form-urlencoded` an, bekommen Sie ein `415` statt eines stillen `null`. Das ist ein anderer Fehler mit einem anderen Fix, behandelt in [415 Unsupported Media Type von einem Minimal-API-Endpunkt](/de/2026/07/fix-415-unsupported-media-type-from-a-minimal-api-endpoint-in-aspnetcore-11/).

Die Regel, die man behalten sollte, ist kurz: in einer Minimal API wird ein `[FromForm]`-Parameter nur dann über seinen Namen adressiert, wenn sein Typ aus einer einzelnen Zeichenkette geparst werden kann. Alles andere geht durch den Blazor-Form-Mapper, der an der Wurzel des Formulars beginnt und nicht weiß, wie Ihr Parameter heißt. Geben Sie ihm eine Klasse, in die er absteigen kann, und die Namen kommen zurück.

## Verwandte Beiträge

- [Fix: "415 Unsupported Media Type" von einem Minimal-API-Endpunkt in ASP.NET Core 11](/de/2026/07/fix-415-unsupported-media-type-from-a-minimal-api-endpoint-in-aspnetcore-11/) für den Fall, dass das Formular den Binder gar nicht erreicht.
- [Fix: "413 Request Entity Too Large" beim Hochladen einer Datei an einen ASP.NET Core Endpunkt](/de/2026/07/fix-413-request-entity-too-large-uploading-a-file-in-aspnetcore-11/) für die Byte-Größenlimits, die vor dem Parsen des Formulars greifen.
- [Native AOT mit ASP.NET Core Minimal APIs verwenden](/de/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) dazu, was der Request Delegate Generator binden kann und was nicht.
- [Minimal APIs vs Controller in ASP.NET Core 11](/de/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) für die breitere Menge an Bindungsunterschieden zwischen beiden Modellen.
- [Eine große Datei per Streaming in Azure Blob Storage hochladen](/de/2026/04/how-to-upload-a-large-file-with-streaming-to-azure-blob-storage/), um vom `IFormFile`-Buffering wegzukommen, wenn die Uploads wachsen.

## Quellen

- Microsoft Learn, [Parameter binding in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/parameter-binding?view=aspnetcore-10.0) (Formularbindung an Sammlungen und komplexe Typen, die `IFormFile`-Sammlungstabelle und der Hinweis, dass Formularbindung an komplexe Typen und Sammlungen unter dem Request Delegate Generator nicht unterstützt wird).
- dotnet/aspnetcore, [RequestDelegateFactory.cs](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Http/Http.Extensions/src/RequestDelegateFactory.cs) (das Prädikat `useSimpleBinding` und `BindComplexParameterFromFormItem`, das `FormDataMapper.Map<T>` ohne Präfix aufruft).
- dotnet/aspnetcore Issue [#62326](https://github.com/dotnet/aspnetcore/issues/62326) und PR [#63072](https://github.com/dotnet/aspnetcore/pull/63072) (`[FromForm] string[]` bricht beim Start ab, und der Fix für die einfache Bindung, der in .NET 11 ausgeliefert wurde).
- Microsoft Learn, [RDG003: Unable to statically resolve parameter](https://learn.microsoft.com/aspnet/core/fundamentals/aot/request-delegate-generator/diagnostics/RDG003) (die Compile-Zeit-Diagnose für formulargemappte Parameter unter AOT).
