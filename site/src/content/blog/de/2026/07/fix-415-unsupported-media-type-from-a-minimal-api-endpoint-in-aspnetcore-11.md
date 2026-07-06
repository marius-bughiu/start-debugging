---
title: "Fix: \"415 Unsupported Media Type\" von einem Minimal-API-Endpunkt in ASP.NET Core 11"
description: "Eine Minimal API gibt 415 zurück, wenn der Content-Type der Anfrage nicht zu dem passt, was der Endpunkt bindet. Senden Sie Content-Type: application/json für einen aus dem Body gebundenen Typ, oder verwenden Sie [FromForm] für Formular- und Datei-Uploads."
pubDate: 2026-07-06
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-apis"
lang: "de"
translationOf: "2026/07/fix-415-unsupported-media-type-from-a-minimal-api-endpoint-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-06
---

Ein Minimal-API-Endpunkt gibt `415 Unsupported Media Type` zurück, wenn der `Content-Type`-Header des Anfrage-Bodys nicht zu dem passt, was der Route-Handler zu binden versucht. Die häufigste Ursache: Ein Handler-Parameter ist ein komplexer Typ, der aus dem Body gebunden wird und daher `Content-Type: application/json` erfordert, während der Client keinen Content-Type gesendet hat, `text/plain` gesendet hat oder Formulardaten gesendet hat. Beheben Sie es, indem Sie `Content-Type: application/json` für einen JSON-Body senden, oder annotieren Sie den Parameter mit `[FromForm]`, wenn der Client `application/x-www-form-urlencoded` oder `multipart/form-data` postet. Dies ist gegen ASP.NET Core 11 auf .NET 11 mit C# 14 verifiziert; das Verhalten ist auf .NET 8 bis .NET 10 identisch.

## Der Fehler im Kontext

Anders als die meisten Ausnahmen erreicht diese hier niemals Ihren Code. Die Bindungsschicht der Minimal API weist die Anfrage ab, bevor Ihr Handler läuft, und schreibt ein blankes `415` an den Client zurück. Es gibt keinen Stack Trace, standardmäßig keinen `ProblemDetails`-Body, nur die Statuszeile:

```
HTTP/1.1 415 Unsupported Media Type
Content-Type: application/problem+json
Date: Mon, 06 Jul 2026 09:12:44 GMT

{
  "type": "https://tools.ietf.org/html/rfc9110#section-15.5.16",
  "title": "Unsupported Media Type",
  "status": 415
}
```

Wenn Sie `AddProblemDetails()` nicht eingerichtet haben, erhalten Sie einen leeren Body mit lediglich dem `415`-Status. So oder so ist das Fehlen eines Stack Trace der verräterische Hinweis: Dies ist ein Content-Negotiation-Fehler auf Framework-Ebene, nichts, das innerhalb Ihres Handlers geworfen wurde. Die Parameter-Binding-Referenz von Microsoft Learn dokumentiert das in ihrer Tabelle der Bindungsfehler unmissverständlich: "Wrong content type (not `application/json`), body, 415."

## Warum das passiert

Ein Minimal-API-Route-Handler bindet jeden Parameter aus einer Quelle: der Route, dem Query-String, einem Header, einem Dienst aus DI oder dem Anfrage-Body. Wenn ein Parameter ein komplexer Typ ohne `[From*]`-Attribut ist, folgern Minimal APIs, dass er aus dem Anfrage-Body stammt, und der einzige standardmäßig eingebundene Body-Reader ist der `System.Text.Json`-Reader. Dieser Reader ist für genau einen Media-Type registriert: `application/json`.

Das Framework führt also eine Content-Type-Prüfung durch, bevor es überhaupt `JsonSerializer` aufruft. Wenn der eingehende `Content-Type` nicht `application/json` ist (oder ein kompatibler `+json`-Suffix-Typ), lehnt der Body-Reader die Anfrage ab, und Minimal APIs brechen mit `415` kurz ab. Es wird nicht versucht zu raten. Ein fehlender `Content-Type`, `text/plain`, `application/x-www-form-urlencoded` oder `multipart/form-data` schlagen alle auf dieselbe Weise fehl, wenn der Zielparameter einen JSON-Body erwartet.

Dies ist ein anderer Fehler als ein `400 Bad Request`. Ein `400` bedeutet, dass der Content-Type korrekt war, aber die JSON-Nutzlast fehlerhaft war oder gegen die Validierung verstieß. Ein `415` bedeutet, dass das Framework nie auch nur versucht hat, den Body zu lesen, weil der Content-Type falsch war. Diese beiden auseinanderzuhalten erspart Ihnen das Debuggen Ihres JSON, wenn das eigentliche Problem ein Header ist. Die drei üblichen Auslöser:

- Der Client sendet einen JSON-Body, vergisst aber den `Content-Type: application/json`-Header (oder ein Proxy entfernt ihn).
- Der Client postet Formulardaten (`application/x-www-form-urlencoded` oder `multipart/form-data`) an einen Handler, dessen Parameter aus dem JSON-Body gebunden wird.
- Der Client sendet einen mit Vendor- oder Charset-Angabe versehenen Content-Type, den der JSON-Reader nicht zu akzeptieren registriert ist.

## Minimales Repro

Hier ist der kleinste Endpunkt, der den Fehler erzeugt. `CreateProduct` ist ein komplexer Typ ohne Bindungsattribut, daher binden Minimal APIs ihn aus dem JSON-Body:

```csharp
// .NET 11, ASP.NET Core 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddProblemDetails();   // so the 415 comes back as problem+json
var app = builder.Build();

app.MapPost("/products", (CreateProduct product) =>
    TypedResults.Created($"/products/{product.Sku}", product));

app.Run();

public record CreateProduct(string Sku, string Name, int Quantity);
```

Posten Sie nun einen Body ohne den Content-Type-Header. Jeder Einzelne davon gibt `415` zurück:

```bash
# .NET 11 -- no Content-Type header at all
curl -i -X POST http://localhost:5000/products \
  -d '{"sku":"A-100","name":"Widget","quantity":5}'

# .NET 11 -- wrong Content-Type (curl defaults -d to x-www-form-urlencoded)
curl -i -X POST http://localhost:5000/products \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d 'sku=A-100&name=Widget&quantity=5'

# .NET 11 -- text/plain, even though the payload is valid JSON
curl -i -X POST http://localhost:5000/products \
  -H "Content-Type: text/plain" \
  -d '{"sku":"A-100","name":"Widget","quantity":5}'
```

Die Nutzlast im ersten und dritten Aufruf ist vollkommen gültiges JSON. Das spielt keine Rolle. Der Reader ist an den Header gebunden, nicht an die Bytes.

## Die Behebung im Detail

Arbeiten Sie diese der Reihe nach durch. Die erste löst die große Mehrheit der Fälle.

### 1. Senden Sie `Content-Type: application/json` für einen aus dem Body gebundenen Typ

Wenn Ihr Handler einen komplexen Typ aus dem Body bindet, muss der Client einen JSON-Content-Type deklarieren. Bei `curl` besteht die Falle darin, dass `-d` (oder `--data`) stillschweigend `application/x-www-form-urlencoded` setzt. Verwenden Sie `--json`, oder setzen Sie den Header explizit:

```bash
# .NET 11 -- curl 7.82+ has a --json shortcut that sets the header for you
curl -i -X POST http://localhost:5000/products \
  --json '{"sku":"A-100","name":"Widget","quantity":5}'

# .NET 11 -- or set it by hand
curl -i -X POST http://localhost:5000/products \
  -H "Content-Type: application/json" \
  -d '{"sku":"A-100","name":"Widget","quantity":5}'
```

Von einem typisierten `HttpClient` aus verwenden Sie `PostAsJsonAsync`, was den Header setzt und in einem Aufruf serialisiert. Dies ist die mit Abstand häufigste Art, den Header versehentlich zu korrigieren oder versehentlich zu zerstören:

```csharp
// .NET 11, C# 14 -- sets Content-Type: application/json automatically
using System.Net.Http.Json;

var http = new HttpClient { BaseAddress = new Uri("http://localhost:5000") };
var response = await http.PostAsJsonAsync(
    "/products",
    new { sku = "A-100", name = "Widget", quantity = 5 });

response.EnsureSuccessStatusCode();   // 201 Created, no 415
```

Wenn Sie den `HttpContent` von Hand bauen, verwenden Sie `JsonContent.Create(...)` oder ein `StringContent` mit gesetztem Media-Type. Ein `new StringContent(json)` ohne Media-Type fällt auf `text/plain` zurück und gibt Ihnen ein `415`:

```csharp
// .NET 11, C# 14
// WRONG -- StringContent defaults to text/plain -> 415
var bad = new StringContent(json);

// RIGHT -- declare the media type
var good = new StringContent(json, System.Text.Encoding.UTF8, "application/json");
```

In JavaScript `fetch` setzen Sie den Header explizit; `fetch` fügt ihn nicht für Sie hinzu, wenn der Body ein String ist:

```javascript
// browser fetch -- must set Content-Type or you get 415
await fetch("/products", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ sku: "A-100", name: "Widget", quantity: 5 }),
});
```

### 2. Verwenden Sie `[FromForm]` für Formular-Posts und Datei-Uploads

Wenn der Client tatsächlich Formulardaten sendet (ein HTML-`<form>`-Submit oder ein Datei-Upload), zwingen Sie es nicht in JSON. Weisen Sie den Handler an, aus dem Formular statt aus dem Body zu binden, indem Sie jeden Parameter mit `[FromForm]` annotieren. Das schaltet den erwarteten Content-Type des Endpunkts auf `application/x-www-form-urlencoded` und `multipart/form-data` um:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
app.MapPost("/products",
    ([FromForm] string sku, [FromForm] string name, [FromForm] int quantity) =>
        TypedResults.Created($"/products/{sku}", new { sku, name, quantity }));
```

Für Datei-Uploads erfordert ein `IFormFile`-Parameter `multipart/form-data`. Laut der Minimal-API-Dokumentation binden Minimal APIs den gesamten Anfrage-Body nicht direkt an ein `IFormFile`; das Feld muss über Formular-Encoding kommen, und der Parametername muss mit dem Formularfeldnamen übereinstimmen:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
app.MapPost("/upload",
    async ([FromForm] string title, IFormFile file, HttpContext ctx) =>
    {
        await using var stream = File.Create(Path.Combine("uploads", file.FileName));
        await file.CopyToAsync(stream);
        return TypedResults.Ok(new { title, file.FileName, file.Length });
    })
    .DisableAntiforgery();   // see the gotcha below before you copy this line
```

Posten Sie es als multipart, und das `415` ist weg:

```bash
# .NET 11 -- multipart, matches the [FromForm] + IFormFile handler
curl -i -X POST http://localhost:5000/upload \
  -F "title=Spec sheet" \
  -F "file=@./spec.pdf"
```

### 3. Entfernen Sie den Charset- oder Vendor-Suffix, den der JSON-Reader ablehnt

Ein Content-Type wie `application/json; charset=utf-8` wird akzeptiert, aber ein blanker Vendor-Typ wie `application/vnd.myapp+json` möglicherweise nicht, je nachdem, wie die Media-Types des Readers konfiguriert sind. Wenn Sie einen Client steuern, der einen benutzerdefinierten `+json`-Media-Type sendet, und Sie ihn nicht ändern können, registrieren Sie diesen Media-Type, damit der JSON-Body-Reader ihn erkennt. In Minimal APIs tun Sie dies, indem Sie die akzeptierten Anfrage-Content-Types des Endpunkts mit `Accepts` konfigurieren, was auch Ihr OpenAPI-Dokument speist:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
app.MapPost("/products", (CreateProduct product) =>
        TypedResults.Created($"/products/{product.Sku}", product))
    .Accepts<CreateProduct>("application/json", "application/vnd.myapp+json");
```

### 4. Lesen Sie einen Nicht-JSON-Body selbst mit HttpRequest

Wenn die Nutzlast überhaupt kein JSON ist (rohe Bytes, CSV, ein benutzerdefiniertes Textformat), hören Sie auf, einen komplexen Typ zu binden, und lesen Sie den Stream direkt. Binden Sie `HttpRequest` (oder `Stream` oder `PipeReader`), was Minimal APIs ohne jegliche Content-Type-Prüfung bereitstellen, und parsen Sie den Body nach Ihren eigenen Regeln:

```csharp
// .NET 11, ASP.NET Core 11, C# 14 -- accepts any content type
app.MapPost("/import", async (HttpRequest request) =>
{
    using var reader = new StreamReader(request.Body);
    var raw = await reader.ReadToEndAsync();
    // parse `raw` (CSV, custom format, whatever) here
    return TypedResults.Ok(new { bytes = raw.Length });
});
```

Weil Sie das Framework nie gebeten haben, den Body in einen typisierten Parameter zu deserialisieren, gibt es kein Content-Type-Gate, und das `415` kann auf diesem Endpunkt nicht auftreten.

## Fallstricke und Varianten

Eine Handvoll ähnlich aussehender Fälle schickt Leute irrtümlich auf diese Seite, und ein paar scharfe Kanten stechen selbst nach der Behebung noch zu:

- **`415` ist nicht `406`.** Bei `415 Unsupported Media Type` geht es um den `Content-Type` des Anfrage-Bodys. Bei `406 Not Acceptable` geht es um den `Accept`-Header des Clients für die Antwort. Wenn Sie ein `406` erhalten, sind Sie auf der falschen Seite: Der Server kann keine Repräsentation erzeugen, die der Client akzeptiert, was ein Formatter-Problem auf dem Weg nach draußen ist, nicht auf dem Weg herein.

- **`415` ist nicht `400`.** Wenn der Content-Type korrekt ist, das JSON aber fehlerhaft ist oder die Validierung nicht besteht, erhalten Sie ein `400`, nicht ein `415`. Für diesen Pfad siehe [wie man Anfrage-Bodys in Minimal APIs ohne Controller validiert](/de/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/), und wenn Sie die `400`-Nutzlast umformen müssen, [passen Sie Minimal-API-Validierungsfehlerantworten mit IProblemDetailsService an](/de/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/). Eine spezifische Variante mit fehlerhaftem JSON, ein Datums-String, den der Serializer nicht parsen kann, wird in [the JSON value could not be converted](/de/2026/05/fix-jsonexception-the-json-value-could-not-be-converted/) behandelt.

- **`[FromForm]`-Endpunkte erfordern standardmäßig ein Antiforgery-Token.** Seit .NET 8 lösen formulargebundene Minimal-API-Parameter eine Antiforgery-Validierung aus. Ein programmatischer Client (curl, `HttpClient`), der ein Formular ohne gültiges Token postet, wird abgewiesen, was sich wie ein Content-Type-Problem liest, es aber nicht ist. Senden Sie entweder das Antiforgery-Token, oder rufen Sie `.DisableAntiforgery()` auf Endpunkten auf, die nicht browsergesteuert sind, wie im obigen Upload-Beispiel. Deaktivieren Sie es nicht pauschal auf Endpunkten, an die ein Browser postet.

- **Ein fehlender `Content-Type` verhält sich wie ein falscher.** Manche HTTP-Clients lassen den Header bei einem `POST` mit Body vollständig weg. Aus Sicht des Frameworks ist ein fehlender Content-Type nicht `application/json`, also fällt er durch dieselbe `415`-Prüfung. Setzen Sie den Header stets explizit, statt sich auf einen Client-Standard zu verlassen.

- **Reverse-Proxys und API-Gateways können den Header umschreiben oder entfernen.** Wenn dieselbe Anfrage direkt gegen Kestrel funktioniert, hinter nginx, YARP oder einem API-Gateway aber `415` zurückgibt, prüfen Sie, welcher `Content-Type` tatsächlich bei der App ankommt. Loggen Sie `HttpContext.Request.ContentType` ganz oben in der Pipeline, um den echten Wert zu sehen, statt den, von dem Sie glauben, ihn gesendet zu haben.

- **`[ApiController]`-Inferenz ist ein Controller-Konzept, kein Minimal-API-Konzept.** Wenn Sie von Controllern migriert sind, denken Sie daran, dass Minimal APIs die Body-Bindung für komplexe Typen auf dieselbe Weise ableiten, es aber kein `[Consumes]`-Attribut zum Filtern von Media-Types gibt, sofern Sie nicht `Accepts` hinzufügen. Die Bindungsquelle, nicht ein Attribut, ist es, was den Content-Type festlegt.

Das mentale Modell, das Sie behalten sollten: Ein Minimal-API-`415` ist eine Diskrepanz zwischen dem `Content-Type`, den der Client gesendet hat, und dem Body-Reader, den der Endpunkt erwartet. Entscheiden Sie, was der Endpunkt akzeptieren soll, JSON-Body, Formular, Datei oder rohen Stream, und bringen Sie dann den Header des Clients und die Bindung des Handlers zur Übereinstimmung. Wenn sie übereinstimmen, verschwindet das `415`, und Sie sind zurück im normalen `400`/`200`-Terrain.

## Verwandt

- [Wie man Anfrage-Bodys in Minimal APIs ohne Controller in ASP.NET Core 11 validiert](/de/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/) für den `400`-Pfad, sobald der Content-Type korrekt ist.
- [Wie man Minimal-API-Validierungsfehlerantworten mit IProblemDetailsService in ASP.NET Core 11 anpasst](/de/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/) zum Formen des Fehler-Bodys, den der Client sieht.
- [Wie man Minimal-API-Endpunkte mit MapGroup in ASP.NET Core 11 organisiert](/de/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) zum Anwenden von `Accepts` und Filtern über eine Gruppe von Endpunkten.
- [Minimal APIs vs. Controller in ASP.NET Core 11](/de/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) dazu, wie sich die Content-Type-Behandlung zwischen den beiden Modellen unterscheidet.
- [Wie man JWT-Bearer-Authentifizierung in einer Minimal API in ASP.NET Core 11 einrichtet](/de/2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11/) für die Auth-Schicht, die vor diesen Endpunkten sitzt.

## Quellen

- Microsoft Learn, [Parameter binding in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/parameter-binding?view=aspnetcore-9.0) (Tabelle der Bindungsfehler: falscher Content-Type bei einem Body-Parameter gibt 415 zurück; `[FromForm]`-, `IFormFile`- und `multipart/form-data`-Anforderungen; Antiforgery bei Formularbindung).
- Microsoft Learn, [Minimal APIs quick reference](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis?view=aspnetcore-9.0) (`Accepts`-Metadaten, Body- vs. Formular-Bindungsquellen).
- MDN, [415 Unsupported Media Type](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/415) (die HTTP-Semantik: Server verweigert den Media-Type der Anfrage-Nutzlast).
