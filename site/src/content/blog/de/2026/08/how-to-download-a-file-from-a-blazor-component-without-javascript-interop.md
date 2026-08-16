---
title: "Wie man eine Datei aus einer Blazor-Komponente ohne JavaScript-Interop herunterlädt"
description: "Verzichten Sie komplett auf das JS-Modul downloadFileFromStream. Rendern Sie einen Anker mit dem download-Attribut, der auf einen Minimal-API-Endpunkt mit TypedResults.File zeigt, oder senden Sie ein einfaches HTML-Formular per POST mit einem AntiforgeryToken. Enthält, warum das download-Attribut verhindert, dass Blazors Enhanced Navigation den Klick schluckt, warum data-enhance die Datei stillschweigend verwirft, und die Cookie-gegen-Bearer-Falle."
pubDate: 2026-08-16
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "blazor"
  - "minimal-apis"
lang: "de"
translationOf: "2026/08/how-to-download-a-file-from-a-blazor-component-without-javascript-interop"
translatedBy: "claude"
translationDate: 2026-08-16
---

Um eine Datei aus einer Blazor-Komponente ohne eine einzige Zeile JavaScript herunterzuladen, rendern Sie ein einfaches `<a>`-Element, dessen `href` auf einen Endpunkt zeigt, der `TypedResults.File` zurückgibt, und dessen `download`-Attribut gesetzt ist. Das ist der ganze Trick. Das `download`-Attribut ist nicht nur ein Hinweis auf den Dateinamen: Es ist die Markierung, die Blazors Enhanced Navigation dazu bringt, den Klick zu überspringen und dem Browser eine echte Navigation zu überlassen, die der Header `Content-Disposition: attachment` dann in einen Speichervorgang verwandelt. Für Dateien, deren Inhalt von Benutzereingaben abhängt, senden Sie ein einfaches HTML-`<form>` mit einem `<AntiforgeryToken />` per POST an denselben Endpunkttyp. Alles Folgende zielt auf .NET 11 und C# 14 und wurde durchgängig gegen eine Blazor Web App auf ASP.NET Core 10.0.5 verifiziert, wo das Verhalten identisch ist. Die APIs sind seit .NET 8 unverändert.

## Warum die offizielle Anleitung zu JS-Interop greift und wann Sie sie ignorieren können

Die [Dokumentation zu Datei-Downloads in Blazor](https://learn.microsoft.com/en-us/aspnet/core/blazor/file-downloads) bietet zwei Rezepte, und beide beginnen damit, eine `.js`-Datei hinzuzufügen. Das Rezept für kleine Dateien verpackt einen `Stream` in eine `DotNetStreamReference`, schickt ihn an eine JS-Funktion `downloadFileFromStream` und baut daraus auf dem Client einen `Blob` und eine Object-URL. Das Rezept für große Dateien ruft eine JS-Funktion `triggerFileDownload` auf, die per Skript ein `HTMLAnchorElement` erzeugt und ein synthetisches `click`-Ereignis darauf auslöst.

Lesen Sie das zweite noch einmal. Das JavaScript existiert, um ein Ankerelement zu erzeugen und darauf zu klicken. Sie befinden sich in einem UI-Framework, dessen gesamte Aufgabe das Rendern von HTML-Elementen ist. Sie können den Anker selbst rendern.

Der Weg ohne JS ist nicht nur weniger Code, er umgeht eine ganze Fehlerklasse, in die der Interop-Weg direkt hineinläuft. `IJSRuntime` ist während des Prerenderings einer Komponente nicht nutzbar, weshalb [JavaScript-Interop-Aufrufe zu diesem Zeitpunkt nicht ausgeführt werden können](/de/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/) zu den häufigsten Blazor-Ausnahmen gehört. In Komponenten mit statischem serverseitigem Rendering (Static SSR) steht es ebenfalls nicht zur Verfügung, weil es weder einen Circuit noch eine WebAssembly-Laufzeit gibt, die aufgerufen werden könnte. Ein Anker funktioniert in jedem Rendermodus einschließlich Static SSR, ganz ohne Lebenszyklusregeln.

Es gibt genau ein Szenario, in dem Interop wirklich nötig ist: eine eigenständige Blazor-WebAssembly-App, die Bytes auf dem Client erzeugt und sie ohne Serveraufruf speichern muss. Selbst dort bringt ein `data:`-URI Sie fast ans Ziel, und die Grenzen behandle ich am Ende.

## Das download-Attribut hindert Blazor daran, Ihren Klick zu fressen

Das ist der Teil, den niemand erklärt, und deshalb scheitert der Rat "nimm einfach einen Anker" in einer Blazor Web App so oft.

Blazor Web Apps aktivieren Enhanced Navigation standardmäßig. Ein Klick-Handler auf Dokumentebene fängt interne Links ab, holt das Ziel per `fetch` und patcht das zurückgelieferte HTML in das bestehende DOM, statt die Seite vollständig neu zu laden. Für Seiten ist das hervorragend, für eine CSV-Datei katastrophal.

Die Schutzbedingung des Interceptors ist im ausgelieferten `blazor.web.js` sichtbar:

```js
return (!t || "_self" === t) && e.hasAttribute("href") && !e.hasAttribute("download")
```

Ein Anker kommt nur dann für die Abfangung infrage, wenn er ein `href` hat und **kein** `download`-Attribut. Das Attribut ist eine bewusste Ausstiegsklausel, fest im Framework verankert.

Lassen Sie es weg, passiert Folgendes, gemessen im Browser gegen eine laufende App. Ein Klick auf `<a href="/exports/orders.csv">` erzeugt:

```text
[warn] Enhanced navigation failed for destination http://localhost:5248/exports/orders.csv.
       Falling back to full page load.
```

Die Adressleiste wechselt zu `/exports/orders.csv?`, inklusive überflüssigem Fragezeichen, während das DOM weiterhin die vorherige Seite zeigt. Das Netzwerkprotokoll zeigt den Endpunkt **zweimal** getroffen: einmal durch den `fetch` der Enhanced Navigation, der mit `text/csv` nichts anfangen konnte, und dann durch die Ersatz-Dokumentnavigation, die der Browser schließlich an den Download-Manager übergibt. Ihre Export-Abfrage läuft zweimal, die URL des Benutzers ist falsch, und die Datei kommt trotzdem an. Das ist die schlechteste denkbare Kombination, weil es aussieht, als würde es funktionieren.

Fügen Sie `download` hinzu und nichts davon passiert. Der Klick wird nie abgefangen, die URL ändert sich nie, eine Anfrage geht raus, eine Datei kommt zurück.

## Schritte für einen Download ohne JS

1. **Schreiben Sie einen Endpunkt, der die Datei zurückgibt.** Ein Minimal-API-`MapGet`, das `TypedResults.File`, `TypedResults.Bytes` oder `TypedResults.Stream` zurückgibt, setzt `Content-Disposition: attachment` selbst, sobald Sie `fileDownloadName` übergeben.
2. **Rendern Sie einen Anker darauf, mit gesetztem `download`-Attribut.** Lassen Sie es nicht weg, auch dann nicht, wenn der Endpunkt bereits `Content-Disposition` setzt.
3. **Für parametrisierte Exporte verwenden Sie ein einfaches `<form method="post">`**, das auf den Endpunkt zeigt, mit einem `<AntiforgeryToken />` darin und ohne `data-enhance`-Attribut.
4. **Sorgen Sie dafür, dass der Endpunkt so authentifiziert wie eine Browsernavigation**, also über Cookies und nicht über einen `Authorization`-Header.
5. **Prüfen Sie die Antwort-Header**, nicht den Speichern-Dialog des Browsers. `curl -I` gegen den Endpunkt sollte `Content-Disposition: attachment` und den erwarteten Dateinamen zeigen.

## Der Endpunkt: drei Ausprägungen von TypedResults

Für Inhalte, die ohnehin in den Speicher passen, übergeben Sie dem Endpunkt ein `byte[]`:

```csharp
// .NET 11, C# 14
app.MapGet("/exports/orders.csv", () =>
{
    var csv = new StringBuilder("Id,Customer,Total\n");
    foreach (var order in OrderStore.Recent())
    {
        csv.Append(CultureInfo.InvariantCulture, $"{order.Id},{order.Customer},{order.Total}\n");
    }

    return TypedResults.File(
        Encoding.UTF8.GetBytes(csv.ToString()),
        contentType: "text/csv",
        fileDownloadName: "orders.csv");
});
```

Das erzeugt genau die Header, die ein Browser braucht:

```text
HTTP/1.1 200 OK
Content-Length: 75
Content-Type: text/csv
Content-Disposition: attachment; filename=orders.csv; filename*=UTF-8''orders.csv
```

Beachten Sie die doppelten Parameter `filename` und `filename*`. ASP.NET Core gibt die Form nach RFC 6266 automatisch aus, und genau das lässt Dateinamen jenseits von ASCII die Reise überstehen.

Für alles, was groß genug ist, dass Pufferung ein Speicherrisiko darstellt, nutzen Sie `TypedResults.Stream` mit einem Callback und schreiben direkt in den Antwortkörper:

```csharp
// .NET 11, C# 14
app.MapGet("/exports/orders-stream.csv", (IOrderQuery query, CancellationToken ct) =>
    TypedResults.Stream(
        async stream =>
        {
            await using var writer = new StreamWriter(stream, new UTF8Encoding(false), leaveOpen: true);
            await writer.WriteLineAsync("Id,Customer,Total");

            await foreach (var order in query.StreamAsync(ct))
            {
                await writer.WriteLineAsync($"{order.Id},{order.Customer},{order.Total}");
            }
        },
        contentType: "text/csv",
        fileDownloadName: "orders-stream.csv"));
```

Das antwortet mit `Transfer-Encoding: chunked` und ohne `Content-Length`, der Benutzer bekommt also keinen Fortschrittsbalken, dafür hält der Server nie den gesamten Export vor. Derselbe Kompromiss gilt immer, wenn Sie [eine Datei aus einem ASP.NET-Core-Endpunkt ohne Pufferung streamen](/de/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/).

Das `new UTF8Encoding(false)` ist Absicht. Das Standard-`Encoding.UTF8` von `StreamWriter` hat die BOM-Präambel aktiviert, die Abkürzungsvariante schreibt also drei überflüssige Bytes vor Ihre Kopfzeile. In der Test-App bin ich darüber gestolpert: Der `byte[]`-Endpunkt lieferte saubere Ausgabe, weil `Encoding.UTF8.GetBytes` nie eine Präambel schreibt, während der Streaming-Endpunkt `Id,Customer,Total` eine BOM voranstellte. Für eine CSV-Datei, die in Excel geöffnet wird, ist diese BOM genau richtig, wählen Sie also je nach Format statt zufällig.

Liegt die Datei bereits auf der Platte, überspringen Sie den Puffer ganz: `TypedResults.File(File.OpenRead(path), "application/pdf", "manual.pdf", enableRangeProcessing: true)`. Range-Verarbeitung erlaubt dem Browser, einen abgebrochenen Download fortzusetzen.

## Static SSR: ein Anker und ein einfaches Formular, kein Circuit nötig

Hier eine Komponente mit Static SSR, ohne Rendermodus, ohne `@onclick`, die zwei verschiedene Dateien herunterlädt:

```razor
@* .NET 11, static SSR, no render mode *@
@page "/exports"

<h1>Exports</h1>

<a href="/exports/orders.csv" download>Download today's orders</a>

<a href="/exports/orders.csv" download="orders-2026-08.csv">Download with a custom name</a>

<form method="post" action="/exports/orders">
    <AntiforgeryToken />
    <label>
        Rows
        <input type="number" name="maxRows" value="500" />
    </label>
    <input type="hidden" name="format" value="csv" />
    <button type="submit">Export</button>
</form>
```

Der zweite Anker zeigt das Einzige, was das `download`-Attribut über den Ausstieg aus der Enhanced Navigation hinaus tut: Sein Wert überschreibt den vom Server vorgeschlagenen Dateinamen. Lassen Sie ihn leer, wenn `fileDownloadName` des Endpunkts bereits stimmt.

Das Formular ist ein einfaches HTML-`<form>` mit `action`, kein `EditForm`, und trägt weder `@formname` noch `@onsubmit`. Das ist beabsichtigt. Ein `EditForm` postet zurück in die Blazor-Komponente, und die Aufgabe einer Komponente ist das Rendern von HTML, sie kann also keine Datei zurückgeben. Der Post an einen separaten Endpunkt ist der einzige Weg, der in einem Download endet.

`<AntiforgeryToken />` rendert ein verstecktes Feld `__RequestVerificationToken`. Es ist erforderlich, weil ein Minimal-API-Endpunkt, der `[FromForm]`-Parameter bindet, seit .NET 8 der Antiforgery-Validierung unterliegt. Ein Post ohne Token liefert ein nacktes `400`:

```csharp
// .NET 11, C# 14
app.MapPost("/exports/orders", ([FromForm] string format, [FromForm] int maxRows) =>
{
    var bytes = ExportBuilder.Build(format, maxRows);

    return TypedResults.File(bytes, "text/csv", $"orders.{format}");
});
```

Mit `app.UseAntiforgery()` in der Pipeline und dem Token im Formular liefert das die Datei direkt an den Browser. Kein Circuit, keine WebAssembly-Nutzlast, kein JavaScript.

.NET 11 legt hier eine zweite Ebene darüber. Automatischer header-basierter CSRF-Schutz ist in Apps, die mit `WebApplication.CreateBuilder` gebaut werden, standardmäßig aktiv, prüft `Sec-Fetch-Site` und `Origin` bei unsicheren Methoden, und Blazor-SSR-Formular-Posts liefern `400 Bad Request` für nicht vertrauenswürdige Cross-Origin-Posts. Die Token-Validierung läuft weiterhin nur, wenn Sie `UseAntiforgery` aufrufen, und sind beide vorhanden, gewinnt das Token-Urteil. Wenn ein Formular, das unter .NET 10 funktionierte, nach dem Upgrade plötzlich 400 liefert, prüfen Sie zuerst diese Middleware. Ihr Verhalten habe ich ausführlich behandelt, als [ASP.NET Core 11 den automatischen CSRF-Schutz aktivierte](/de/2026/07/aspnetcore-11-automatic-csrf-protection-fetch-metadata-preview-6/).

## Interaktive Rendermodi: Geben Sie dem Client eine URL, keine Bytes

In einer interaktiven Komponente liegt der Reflex nahe, den Button-Handler ein `byte[]` erzeugen zu lassen und dann nach einem Weg zu suchen, es an den Browser zu drücken. Drehen Sie das um. Der Handler bereitet den Export serverseitig vor, legt ihn hinter einem Token ab und rendert einen Anker:

```razor
@* .NET 11, C# 14 *@
@page "/reports"
@rendermode InteractiveServer
@inject IReportService Reports

<button @onclick="Prepare" disabled="@_working">Prepare export</button>

@if (_token is not null)
{
    <a href="@($"/exports/report/{_token}")" download="report.csv">Your export is ready</a>
}

@code {
    private string? _token;
    private bool _working;

    private async Task Prepare()
    {
        _working = true;
        _token = await Reports.QueueExportAsync();
        _working = false;
    }
}
```

Der Benutzer klickt zweimal, was für einen Export, der ohnehin Zeit braucht, eine ehrliche Benutzerführung ist, und die Bytes wandern nie über den SignalR-Circuit.

Wenn es unbedingt ein einziger Klick sein soll, funktioniert `NavigationManager.NavigateTo(url, forceLoad: true)` und benötigt immer noch keinen eigenen Interop-Code. Da die Antwort `Content-Disposition: attachment` trägt, startet der Browser einen Download und bricht die Navigation ab. Ich habe bestätigt, dass die SPA-URL danach unverändert bleibt: Sie war vor dem Aufruf `/interactive` und danach ebenfalls `/interactive`, die Datei wurde geliefert.

```csharp
// .NET 11, C# 14
private void Download() => Nav.NavigateTo("/exports/orders-stream.csv", forceLoad: true);
```

Der Vorbehalt: Das ist eine Navigation. Liefert der Endpunkt statt einer Datei ein `404` oder `500`, navigiert der Browser aus Ihrer App heraus auf eine Fehlerseite. Ein Anker scheitert genauso, aber immerhin hat der Benutzer den Klick selbst gewählt.

## Blazor WebAssembly ohne Server: der data-URI-Notausgang

Wenn Bytes auf dem Client entstehen und es keinen Endpunkt gibt, auf den man zeigen könnte, codieren Sie sie base64-kodiert in das `href`:

```razor
@* .NET 11, C# 14, Blazor WebAssembly *@
@rendermode InteractiveWebAssembly

<button @onclick="Build">Build report</button>

@if (_href is not null)
{
    <a href="@_href" download="client-report.csv">Save client-report.csv</a>
}

@code {
    private string? _href;

    private void Build()
    {
        var bytes = Encoding.UTF8.GetBytes(ReportBuilder.ToCsv());
        _href = $"data:text/csv;base64,{Convert.ToBase64String(bytes)}";
    }
}
```

Chrome blockiert Top-Level-Navigation zu `data:`-URIs, nimmt aber Anker mit `download`-Attribut ausdrücklich aus, das überlebt also. Ich habe geprüft, dass der gerenderte Anker `download="client-report.csv"` nach der WebAssembly-Hydration unverändert im DOM behält.

Zwei Grenzen verhindern, dass dies die allgemeine Antwort ist. Base64 bläht Nutzlasten um etwa ein Drittel auf, und das Ganze liegt in einem DOM-Attribut, ein Export von 30 MB wird also zu einer 40 MB großen Zeichenkette im Renderbaum. Und die Browser sind sich über Obergrenzen uneinig: Chrome und Edge erzwingen in manchen `data:`-Kontexten ein Limit von 2 MB, während Firefox und Safari keines dokumentieren. Unterhalb von etwa einem Megabyte ist das in Ordnung. Darüber fügen Sie einen Serverendpunkt hinzu oder akzeptieren, dass Sie `Blob` und `URL.createObjectURL` brauchen, also Interop.

## Die Fallstricke, die Sie wirklich treffen werden

**`data-enhance` am Formular wirft Ihre Datei stillschweigend weg.** Enhanced Form Handling postet per `fetch` und weigert sich, mit etwas anderem als einem Blazor-Endpunkt zu sprechen. `data-enhance` am obigen Export-Formular erzeugte in der Konsole:

```text
Enhanced navigation does not support making a non-GET request to a non-Blazor endpoint.
Avoid enabling enhanced navigation for forms that post to a non-Blazor endpoint.
```

Der Netzwerk-Tab zeigte den `POST` mit `200` und vollständigem CSV-Body. Der Server baute den Export, schickte ihn raus, und der Client verwarf ihn. Nichts wurde heruntergeladen. `EditForm` mit `Enhance` scheitert identisch.

**Bearer-Token überleben keine Navigation.** Ein Ankerklick und ein Formular-Post sind vom Browser initiierte Anfragen. Es gibt keinen `Authorization`-Header, weil kein Code von Ihnen läuft, der ihn anhängen könnte. Authentifiziert sich Ihre API über JWTs im Speicher, liefert der Download-Endpunkt `401`, egal wie korrekt das Markup ist. Entweder Sie geben genau diesem Endpunkt Cookie-Authentifizierung, oder Sie stellen ein kurzlebiges Einmal-Token aus und legen es wie im interaktiven Beispiel in den Pfad. Die [Abwägungen zwischen JWT- und Cookie-Authentifizierung](/de/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/) lohnen sich vor der Entscheidung, denn das ist eine echte Architekturweiche und kein Workaround.

**Das `download`-Attribut wird cross-origin ignoriert.** Seit Chrome 65 wird der Dateinamen-Hinweis bei Cross-Origin-URLs stillschweigend verworfen, und Firefox ignoriert das Attribut vollständig und navigiert stattdessen. Liegen Ihre Dateien auf einem CDN oder einem separaten API-Host, verliert das Attribut seine tragende Rolle, und das vom Ursprungsserver gesetzte `Content-Disposition: attachment` ist das Einzige, was den Speichervorgang auslöst. Setzen Sie es dort.

**Auch statische Assets brauchen das Attribut.** `<a href="/docs/manual.pdf" download>` funktioniert gegen Dateien in `wwwroot`, aber ohne `download` greift die Abfangung durch Enhanced Navigation auch dort, und ein PDF ist genau die Art Antwort, bei der Enhanced Navigation mitten im Patchen aufgibt.

**Schreiben Sie die Antwort nicht aus der Komponente heraus.** Den kaskadierenden `HttpContext` in einer Static-SSR-Komponente zu greifen und Bytes in `Response.Body` zu schreiben, arbeitet gegen den Renderer und endet bei [Header sind schreibgeschützt, die Antwort hat bereits begonnen](/de/2026/07/fix-headers-are-read-only-response-has-already-started-in-aspnetcore/). Komponenten rendern Markup. Endpunkte liefern Dateien. Halten Sie die Trennung ein.

Die Regel, die aus alldem folgt, ist klein genug zum Merken: Der Browser weiß längst, wie man Dateien herunterlädt, und Blazor weiß längst, wie man Anker rendert. Zwischen beiden steht nur ein Attribut, auf das das Framework ausdrücklich prüft.

## Quellen

- [ASP.NET Core Blazor file downloads](https://learn.microsoft.com/en-us/aspnet/core/blazor/file-downloads) auf Microsoft Learn, für die interop-basierten Rezepte, die dieser Beitrag ersetzt
- [ASP.NET Core Blazor forms overview](https://learn.microsoft.com/en-us/aspnet/core/blazor/forms/) für die Komponente `AntiforgeryToken`, Enhanced Form Handling und die automatische CSRF-Middleware in .NET 11
- [Breaking change: IFormFile parameters require anti-forgery checks](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/8/antiforgery-checks) dazu, warum `[FromForm]`-Binding ein Token benötigt
- [Deprecations and removals in Chrome 65](https://developer.chrome.com/blog/chrome-65-deprecations) zur Cross-Origin-Einschränkung des `download`-Attributs
- Verhalten bestätigt gegen eine `dotnet new blazor -int Auto`-App auf ASP.NET Core 10.0.5, mit Blick in `blazor.web.js`, die Antwort-Header und die Browserkonsole
