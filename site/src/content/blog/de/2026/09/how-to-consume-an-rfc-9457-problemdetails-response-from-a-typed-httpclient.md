---
title: "Eine ProblemDetails-Antwort nach RFC 9457 mit einem typisierten HttpClient lesen, ohne ASP.NET Core zu referenzieren"
description: "Die BCL kennt keinen ProblemDetails-Typ, und ein FrameworkReference auf Microsoft.AspNetCore.App sorgt dafür, dass Ihr Client in einem Container mit reiner Laufzeit gar nicht erst startet. Hier ist das 20-Zeilen-Modell, der DelegatingHandler, der problem+json in eine typisierte Ausnahme verwandelt, und der Content-Type-Mythos, den die meisten Antworten bis heute wiederholen."
pubDate: 2026-09-07
template: how-to
tags:
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "httpclient"
  - "system-text-json"
  - "aspnetcore-11"
  - "how-to"
lang: "de"
translationOf: "2026/09/how-to-consume-an-rfc-9457-problemdetails-response-from-a-typed-httpclient"
translatedBy: "claude"
translationDate: 2026-09-07
---

Kurze Antwort: Referenzieren Sie ASP.NET Core nicht. Deklarieren Sie eine Klasse mit fünf Eigenschaften und einem `[JsonExtensionData]`-Dictionary für die Erweiterungsmitglieder und deserialisieren Sie sie mit `HttpContent.ReadFromJsonAsync<T>` aus `System.Net.Http.Json`. Der Medientyp `application/problem+json` wird problemlos geparst, denn `ReadFromJsonAsync` prüft seit .NET 5 keine Content-Types mehr, und das Ganze funktioniert in einer Konsolenanwendung, einer Klassenbibliothek, Blazor WebAssembly, MAUI und einem Native-AOT-Client.

Dieser Beitrag behandelt, warum `Microsoft.AspNetCore.Mvc.ProblemDetails` auf dem Client der falsche Typ ist, welcher Fehler genau auftritt, wenn Sie trotzdem danach greifen, welches Modell eine echte ASP.NET-Core-Problemantwort inklusive `errors` und `traceId` vollständig abbildet, wie Sie es in einen typisierten `HttpClient` einhängen, sodass ein 4xx zu einer typisierten Ausnahme wird, und die Handvoll RFC-9457-Regeln, die Ihnen schaden, wenn Sie `status` für vertrauenswürdig halten.

Ein Hinweis zu Versionen. .NET 11 und ASP.NET Core 11 sind im September 2026 in der Vorschau und erreichen am 2026-11-10 die allgemeine Verfügbarkeit, laut den [.NET 11 Release Notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/README.md). In diesem Bereich ändert sich mit .NET 11 nichts, und der API-Vorschlag, der das Problem sauber lösen würde, zielt auf .NET 12 (mehr dazu am Ende). Jede Ausgabe unten entstand auf diesem Rechner mit dem .NET SDK 10.0.302 und den Laufzeiten 10.0.10, gegen eine Minimal API mit `AddProblemDetails()`.

## Warum der Client den Servertyp nicht einfach verwenden kann

`ProblemDetails` ist eine reine Datenklasse mit fünf nullbaren Eigenschaften und einem Dictionary. Sie hat kein Verhalten und keine Serverabhängigkeiten. Trotzdem liegt sie in `Microsoft.AspNetCore.Http.Abstractions.dll`, die ausschließlich als Teil des Shared Framework `Microsoft.AspNetCore.App` ausgeliefert wird. Der einzige unterstützte Weg dorthin ist damit eine Framework-Referenz:

```xml
<!-- Contracts.csproj, .NET 10 / .NET 11 -->
<ItemGroup>
  <FrameworkReference Include="Microsoft.AspNetCore.App" />
</ItemGroup>
```

Das kompiliert. Es überträgt sich auch. Fügen Sie diese Klassenbibliothek einer ansonsten gewöhnlichen Konsolenanwendung hinzu und sehen Sie sich an, was das SDK in `Cli.runtimeconfig.json` schreibt:

```json
{
  "runtimeOptions": {
    "tfm": "net10.0",
    "frameworks": [
      { "name": "Microsoft.NETCore.App", "version": "10.0.0" },
      { "name": "Microsoft.AspNetCore.App", "version": "10.0.0" }
    ]
  }
}
```

Die Konsolenanwendung verlangt jetzt beim Start zwingend das ASP.NET-Core-Shared-Framework. Auf einer Maschine, die es hat, sieht alles gut aus, und genau deshalb geht so etwas in Produktion. Führen Sie dieselbe Binärdatei gegen eine .NET-Installation aus, die nur die Laufzeit enthält, also das, was `mcr.microsoft.com/dotnet/runtime:10.0` liefert, dann verweigert der Host den Dienst, bevor eine einzige Zeile Ihres Codes läuft:

```
You must install or update .NET to run this application.

App: /app/Cli.dll
Architecture: arm64
Framework: 'Microsoft.AspNetCore.App', version '10.0.0' (arm64)

No frameworks were found.
```

Ich habe das erzeugt, indem ich nur `shared/Microsoft.NETCore.App` in ein temporäres `DOTNET_ROOT` kopiert und die Anwendung dort gestartet habe. Es ist exakt die Meldung, die das falsche Basis-Image liefert, und die übliche Reaktion ist der Wechsel auf das `aspnet`-Image, was einem Client, der nie einen Socket im Lauschmodus öffnet, rund 20 MB Server-Framework hinzufügt. Wenn Sie Images dimensionieren, stehen die Abwägungen in [Framework-abhängig vs. eigenständig vs. Native AOT für ein .NET 11 Container-Image](/de/2026/09/framework-dependent-vs-self-contained-vs-native-aot-for-a-dotnet-11-container-image/).

Die übrigen Ziele scheitern früher und härter. Ein `FrameworkReference` auf `Microsoft.AspNetCore.App` steht einer `netstandard2.0`-Bibliothek überhaupt nicht zur Verfügung, und ein Blazor-WebAssembly- oder MAUI-Client hat keinen Grund, Kestrel, MVC und Routing-Metadaten in seinen Trimming-Graphen zu ziehen, nur um fünf JSON-Strings zu lesen. Das `dotnet/aspnetcore`-Issue, das die Verlagerung des Typs fordert, [#58551 "Move ProblemDetails outside of Asp.Net Core"](https://github.com/dotnet/aspnetcore/issues/58551), liegt seit der Erstellung unbearbeitet im Backlog.

## Das Modell in vier Schritten

1. **Deklarieren Sie die fünf RFC-9457-Mitglieder als nullbare Eigenschaften.** Jedes Mitglied in [RFC 9457, Abschnitt 3.1](https://datatracker.ietf.org/doc/html/rfc9457#section-3.1) ist optional. `status` ist eine JSON-Zahl, also `int?`; die anderen vier sind Zeichenketten.
2. **Ergänzen Sie ein `[JsonExtensionData]`-Dictionary.** RFC 9457, Abschnitt 3.2, erlaubt einem Problemtyp, Mitglieder im selben flachen Namensraum wie die Standardmitglieder zu ergänzen, und ASP.NET Core schreibt sein `Extensions`-Dictionary genau so. Ohne dieses Dictionary verlieren Sie stillschweigend `errors`, `traceId` und jedes domänenspezifische Feld, das die API hinzugefügt hat.
3. **Deserialisieren Sie mit `ReadFromJsonAsync<T>` auf dem `HttpContent`,** nicht mit `GetFromJsonAsync`. Die Helfer auf `HttpClient`-Ebene rufen `EnsureSuccessStatusCode` für Sie auf, also genau das Gegenteil dessen, was Sie hier wollen.
4. **Prüfen Sie den Medientyp selbst,** denn sonst tut es niemand.

Der Typ ist kurz genug, um ihn in jedes Client-Projekt zu kopieren:

```csharp
// .NET 10 / .NET 11, C# 14. Only needs System.Net.Http.Json + System.Text.Json.
using System.Text.Json;
using System.Text.Json.Serialization;

public sealed class ProblemDetails
{
    public string? Type { get; set; }
    public string? Title { get; set; }
    public int? Status { get; set; }
    public string? Detail { get; set; }
    public string? Instance { get; set; }

    [JsonExtensionData]
    public IDictionary<string, JsonElement>? Extensions { get; set; }
}
```

`[JsonPropertyName]`-Attribute sind nicht nötig. `ReadFromJsonAsync` verwendet standardmäßig `JsonSerializerOptions.Web`, was `PropertyNamingPolicy` auf camelCase und `PropertyNameCaseInsensitive` auf `true` setzt, sodass `title` von allein an `Title` bindet. Gegen eine echte ASP.NET-Core-Antwort erfasst das Modell alles:

```
type=https://example.com/probs/insufficient-funds
title=Insufficient funds
status=402
detail=Account 12345 has a balance of 4.20 EUR.
instance=/accounts/12345/withdraw
extensions: balance=4.20, accounts=["/account/12345","/account/67890"], traceId=00-5bf0...-00
```

Diese `traceId` hat der Endpunkt nicht gesetzt. Der `DefaultProblemDetailsWriter` von ASP.NET Core ergänzt sie aus `Activity.Current?.Id`, ersatzweise aus `HttpContext.TraceIdentifier`, bei jeder Problemantwort, die über `AddProblemDetails()` geschrieben wird. Es ist das mit Abstand nützlichste Feld im Payload, wenn Sie einen clientseitigen Fehler mit einem Serverprotokoll korrelieren, und es überlebt nur, wenn Sie das Erweiterungs-Dictionary behalten haben.

## Validierungsfehler sind ein Erweiterungsmitglied, keine Eigenschaft

Ein Validierungsfehler von ASP.NET Core sieht auf der Leitung so aus:

```json
{
  "type": "https://tools.ietf.org/html/rfc9110#section-15.5.1",
  "title": "One or more validation errors occurred.",
  "status": 400,
  "errors": {
    "Sku": ["The Sku field is required."],
    "Quantity": ["The field Quantity must be between 1 and 100."]
  },
  "traceId": "00-8246...-00"
}
```

`errors` steht auf oberster Ebene neben `title` und landet daher in `Extensions` mit `ValueKind` gleich `Object`. Das Auslesen ist ein kleiner Helfer, und er muss defensiv sein: RFC 9457, Abschnitt 3.1, sagt, dass ein Mitglied, dessen Werttyp nicht dem erwarteten entspricht, ignoriert werden MUSS, und das Beispiel des RFC in Abschnitt 3 verwendet ein `errors`-**Array** aus `{detail, pointer}`-Objekten statt der nach Mitgliedsnamen geschlüsselten Map von ASP.NET Core. Wenn Sie eine API außerhalb der .NET-Welt aufrufen, begegnet Ihnen die andere Form.

```csharp
// .NET 10 / .NET 11, C# 14
using System.Collections.ObjectModel;

public IReadOnlyDictionary<string, string[]> GetValidationErrors()
{
    if (Extensions is null ||
        !Extensions.TryGetValue("errors", out var errors) ||
        errors.ValueKind is not JsonValueKind.Object)
    {
        return ReadOnlyDictionary<string, string[]>.Empty;
    }

    var result = new Dictionary<string, string[]>(StringComparer.Ordinal);
    foreach (var member in errors.EnumerateObject())
    {
        if (member.Value.ValueKind is not JsonValueKind.Array) continue;
        result[member.Name] = member.Value.EnumerateArray()
            .Where(e => e.ValueKind is JsonValueKind.String)
            .Select(e => e.GetString()!)
            .ToArray();
    }
    return result;
}
```

Verifizierte Ausgabe gegen das obige Payload:

```
Sku: The Sku field is required.
Quantity: The field Quantity must be between 1 and 100.
```

Jeder Zweig, der aufgibt, liefert ein leeres Dictionary statt zu werfen, und genau das verlangt Abschnitt 3.2 von Konsumenten: Erweiterungen ignorieren, die man nicht kennt. Wenn Ihnen auch der Server gehört, steuern Sie dessen Ausgabe über [IProblemDetailsService und die Validierungsantworten von Minimal APIs](/de/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/).

## Die Content-Type-Prüfung, die es nicht mehr gibt

Die Hälfte der Antworten zu diesem Thema warnt, dass `ReadFromJsonAsync` ein `NotSupportedException: The provided ContentType is not supported` wirft, solange die Antwort nicht `application/json` ist. Das stimmte in der .NET-Core-3.1-Vorschau von `System.Net.Http.Json` und ist seit .NET 5 falsch: [dotnet/runtime#40594](https://github.com/dotnet/runtime/pull/40594) hat die Validierung vollständig entfernt, um [#38713](https://github.com/dotnet/runtime/issues/38713) zu lösen, und im aktuellen Quellcode von `HttpContentJsonExtensions` gibt es kein `ValidateContent`.

Gemessen auf 10.0.10, über eine Matrix von Content-Types mit demselben problem+json-Rumpf:

| Content-Type | Rumpf | Ergebnis |
| --- | --- | --- |
| `application/problem+json` | Problem-JSON | geparst |
| `application/problem+json; charset=utf-8` | Problem-JSON | geparst |
| `text/html` | Problem-JSON | **geparst** |
| `text/plain` | Problem-JSON | geparst |
| (keiner) | Problem-JSON | geparst |
| `text/html` | `<html/>` | `JsonException: '<' is an invalid start of a value` |
| `application/problem+json` | leer | `JsonException: The input does not contain any JSON tokens` |
| `application/problem+json` | `null` | liefert `null` |

Daraus folgt zweierlei. Erstens brauchen Sie keinen Workaround, um `application/problem+json` zu lesen, und brauchten ihn ab .NET 5 auch nie. Zweitens existiert das Sicherheitsnetz nicht, das Sie vermutet haben: Liefert ein Gateway eine HTML-Fehlerseite mit 502, versucht `ReadFromJsonAsync` bereitwillig, sie zu parsen, und reicht Ihnen eine `JsonException` statt eines sauberen Signals "das ist kein Problemdokument". Deshalb sagt Schritt 4 oben, dass Sie den Medientyp selbst prüfen sollen, und deshalb gehört die Prüfung auf `Content.Headers.ContentType?.MediaType` und nicht auf den rohen Header, der den `charset`-Parameter mitführt.

Nebenbei: `JsonSerializerOptions.Web` setzt außerdem `NumberHandling` auf `AllowReadingFromString`, sodass ein Server, der `"status": "402"` als Zeichenkette schreibt, trotzdem an `int?` bindet. Das arbeitet für Sie.

## Aus einem 4xx eine typisierte Ausnahme machen

Der natürliche Ort dafür ist ein `DelegatingHandler` an einem typisierten Client, damit jede Aufrufstelle das Verhalten ohne ein `if` pro Methode bekommt. Die Ausnahme leitet von `HttpRequestException` ab, sodass bestehende `catch`-Blöcke und Wiederholungsrichtlinien weiter funktionieren:

```csharp
// .NET 10 / .NET 11, C# 14
public sealed class ProblemDetailsException(ProblemDetails problem, HttpStatusCode status)
    : HttpRequestException(
        problem.Detail ?? problem.Title ?? "The server returned a problem response.",
        inner: null,
        statusCode: status)
{
    public ProblemDetails ProblemDetails { get; } = problem;
}

public sealed class ProblemDetailsHandler : DelegatingHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken ct)
    {
        var response = await base.SendAsync(request, ct);
        if (response.IsSuccessStatusCode) return response;

        var mediaType = response.Content.Headers.ContentType?.MediaType;
        if (!string.Equals(mediaType, "application/problem+json", StringComparison.OrdinalIgnoreCase))
            return response;

        var json = await response.Content.ReadAsStringAsync(ct);
        var problem = JsonSerializer.Deserialize<ProblemDetails>(json, JsonSerializerOptions.Web);
        if (problem is null) return response;

        throw new ProblemDetailsException(problem, response.StatusCode);
    }
}
```

Die Registrierung ist gewöhnliche `IHttpClientFactory`-Arbeit:

```csharp
services.AddTransient<ProblemDetailsHandler>();
services.AddHttpClient<OrdersClient>(c => c.BaseAddress = new Uri("https://api.example.com"))
        .AddHttpMessageHandler<ProblemDetailsHandler>();
```

Und die Aufrufstelle erhält das gesamte Payload, bei einem 404, der zuvor ein nackter Statuscode war:

```
ProblemDetailsException: No order with id abc.
  StatusCode=NotFound  type=https://api.example.com/probs/order-not-found
  orderId extension = abc
  is HttpRequestException: True
```

Beachten Sie das `ReadAsStringAsync` im Handler statt `ReadFromJsonAsync`. Das ist keine Stilfrage. Auf 10.0.10 verwirft ein `ReadFromJsonAsync` auf einem `HttpContent` den gepufferten Stream, sodass ein zweiter Aufruf auf derselben Antwort ein `ObjectDisposedException: Cannot access a closed Stream` wirft. In einem Handler, der die Antwort manchmal zurückgibt statt zu werfen, haben Sie damit den Rumpf für den Aufrufer zerstört. `ReadAsStringAsync` ist wiederholbar, und `ReadAsStringAsync` gefolgt von `ReadFromJsonAsync` funktioniert ebenfalls; nur zweimal `ReadFromJsonAsync` scheitert. Wenn Sie irgendwo in der Kette `HttpCompletionOption.ResponseHeadersRead` verwenden, rufen Sie vorher `LoadIntoBufferAsync()` auf.

Den Handler zu testen ist die übliche Übung mit einem gefälschten `HttpMessageHandler`, beschrieben in [So testen Sie Code, der HttpClient verwendet, mit Unit Tests](/de/2026/04/how-to-unit-test-code-that-uses-httpclient/). Falls Sie die Form des Clients selbst noch abwägen: [HttpClient vs HttpClientFactory vs Refit](/de/2026/05/httpclient-vs-httpclientfactory-vs-refit/) zeigt, wo ein solcher Handler in jeder Variante sitzt.

## Vier RFC-Regeln, die Ihnen schaden werden

**`status` ist nur ein Hinweis.** Abschnitt 3.1.2 ist eindeutig: "The 'status' member, if present, is only advisory". Es ist außerdem optional. Ein Server hinter einem Proxy, der den Status umschreibt, hinterlässt Ihnen einen Rumpf, der 409 behauptet, auf einer HTTP-502-Antwort. Verzweigen Sie immer über `response.StatusCode` und behandeln Sie `ProblemDetails.Status` als Diagnosefeld, das Sie protokollieren, nicht als Schaltbedingung.

**Verzweigen Sie über `type`, nicht über `title` oder den Status.** `type` ist der stabile Bezeichner; `title` darf ausdrücklich lokalisiert sein, und Abschnitt 3.1 sagt nur für einen gegebenen Typ, dass es "SHOULD NOT change from occurrence to occurrence". Fehlt `type`, gilt laut Abschnitt 3.1.1 der Wert `about:blank`, was nach Abschnitt 4.2.1 "keine Information über den Statuscode hinaus" bedeutet und impliziert, dass `title` nur die Statusphrase ist. Normalisieren Sie ein fehlendes oder leeres `type` auf `about:blank`, bevor Sie vergleichen.

**`type` und `instance` sind URI-*Referenzen* und dürfen damit relativ sein.** Der RFC erlaubt es und warnt, dass "using relative URIs can cause confusion, and they might not be handled correctly by all implementations". Wenn Sie `type` gegen eine Konstante vergleichen, lösen Sie es zuerst auf: `new Uri(response.RequestMessage!.RequestUri!, pd.Type ?? "about:blank")`.

**Dereferenzieren Sie `type` nicht und zeigen Sie `detail` keinen Endanwendern.** Abschnitt 5 sagt Konsumenten, sie "SHOULD NOT automatically dereference the type URI" außerhalb von Entwicklerwerkzeugen, und der ganze Sinn von `detail` ist, vorfallspezifischer Servertext zu sein, der regelmäßig Interna preisgibt. Protokollieren Sie ihn, korrelieren Sie über `traceId` und rendern Sie Ihre eigene Meldung.

Zwei kleinere Punkte. Header bleiben wichtig: Ein Problemdokument mit 429 trägt die Wartezeit nicht im Rumpf, sondern in `Retry-After`, also lesen Sie den Header. Und eine Problemantwort ist nicht für jeden Fehler garantiert. In meiner Matrix kam ein 429 ohne Content-Type und mit einem Rumpf der Länge null zurück, also genau der Fall, den die Medientyp-Prüfung im obigen Handler unangetastet durchreicht.

## Native AOT und Trimming

Das Modell funktioniert mit dem Source Generator von `System.Text.Json`, `[JsonExtensionData]` eingeschlossen, sofern das Dictionary eines von `IDictionary<string, JsonElement>`, `IDictionary<string, object>`, `IDictionary<string, JsonNode>` oder `JsonNode` ist. Alles andere ergibt `SYSLIB1036` zur Buildzeit.

```csharp
// .NET 10 / .NET 11, C# 14
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(ProblemDetails))]
public partial class ProblemJsonContext : JsonSerializerContext;

// ...
var problem = await response.Content.ReadFromJsonAsync(ProblemJsonContext.Default.ProblemDetails, ct);
```

Verifiziert auf 10.0.10: Der quellcodegenerierte Pfad parst dasselbe Payload und bewahrt `4.20` als exakten Dezimalwert im Erweiterungs-Dictionary, weil `JsonElement` den Rohtext behält. Ein `GetDecimal()` liefert `4.20`, kein Gleitkomma-Artefakt. Das ist bei Geldbeträgen relevant und ein weiterer Grund, Erweiterungen als `JsonElement` statt als `object` zu halten. Wenn Sie umformen müssen, was der Generator ausgibt, ist [ein Type-Info-Resolver-Modifier](/de/2026/08/how-to-customize-source-generated-system-text-json-serialization-with-a-modifier/) der Ansatzpunkt.

## Was sich mit .NET 12 ändern könnte

Es gibt einen offenen API-Vorschlag, [dotnet/runtime#131046](https://github.com/dotnet/runtime/issues/131046), all das in die BCL zu holen: ein `ProblemDetails`-Modell in `System.Net.Http.Json`, `HttpResponseMessage.IsProblemJson()`, `ReadProblemJsonAsync()`, `ThrowIfProblemJsonAsync()` und eine `ProblemDetailsException`, die von `HttpRequestException` ableitet. Die Begründung im Vorschlag ist dieselbe, mit der dieser Beitrag beginnt: Eine Referenz auf das Server-Framework "pulls ASP.NET Core into console apps, MAUI apps, Blazor WASM clients, and class libraries that have no business depending on a server framework". Er trägt das Label `api-suggestion` im Meilenstein 12.0.0, ist also nicht in .NET 11 und auch für .NET 12 nicht garantiert.

Bis dahin sind die zwanzig Zeilen oben die vollständige Antwort, und sie sind zukunftssicher: Der vorgeschlagene BCL-Typ hat dieselben fünf Eigenschaften und ein Erweiterungs-Dictionary, ein späterer Wechsel ist eine Namensraumänderung und ein Löschvorgang.

## Verwandte Beiträge

- [Validierungsfehler-Antworten in Minimal APIs mit IProblemDetailsService in ASP.NET Core 11 anpassen](/de/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/)
- [HttpClient vs HttpClientFactory vs Refit: Was sollten Sie in .NET 11 verwenden?](/de/2026/05/httpclient-vs-httpclientfactory-vs-refit/)
- [So testen Sie Code, der HttpClient verwendet, mit Unit Tests](/de/2026/04/how-to-unit-test-code-that-uses-httpclient/)
- [So passen Sie quellcodegenerierte System.Text.Json-Serialisierung mit einem Type-Info-Resolver-Modifier an](/de/2026/08/how-to-customize-source-generated-system-text-json-serialization-with-a-modifier/)
- [Framework-abhängig vs. eigenständig vs. Native AOT für ein .NET 11 Container-Image](/de/2026/09/framework-dependent-vs-self-contained-vs-native-aot-for-a-dotnet-11-container-image/)

## Quellen

- [RFC 9457, Problem Details for HTTP APIs](https://datatracker.ietf.org/doc/html/rfc9457)
- [API-Vorschlag: Problem Details (RFC 9457) in System.Net.Http.Json, dotnet/runtime#131046](https://github.com/dotnet/runtime/issues/131046)
- [Move ProblemDetails outside of Asp.Net Core, dotnet/aspnetcore#58551](https://github.com/dotnet/aspnetcore/issues/58551)
- [Content-Type-Prüfung aus ReadFromJsonAsync entfernen, dotnet/runtime#40594](https://github.com/dotnet/runtime/pull/40594)
- [Referenz der ProblemDetails-Klasse auf Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.mvc.problemdetails)
- [Quellcode von DefaultProblemDetailsWriter in dotnet/aspnetcore](https://github.com/dotnet/aspnetcore/blob/main/src/Http/Http.Extensions/src/DefaultProblemDetailsWriter.cs)
- [SYSLIB1036: Typanforderungen für JsonExtensionData](https://learn.microsoft.com/en-US/dotnet/fundamentals/syslib-diagnostics/syslib1036)
