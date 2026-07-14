---
title: "So fügen Sie Response-Komprimierung zu einer ASP.NET Core 11 API hinzu"
description: "Ein vollständiger Leitfaden zur Response-Komprimierung in ASP.NET Core 11: AddResponseCompression und UseResponseCompression, der neue integrierte Zstandard-Provider neben Brotli und Gzip, Komprimierungsstufen, EnableForHttps und das CRIME/BREACH-Risiko, benutzerdefinierte MIME-Typen, die Middleware-Reihenfolge und wann Sie es dem Reverse-Proxy überlassen sollten."
pubDate: 2026-07-14
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-api"
  - "performance"
lang: "de"
translationOf: "2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api"
translatedBy: "claude"
translationDate: 2026-07-14
---

Um Response-Komprimierung zu einer ASP.NET Core 11 API hinzuzufügen, brauchen Sie genau zwei Zeilen: Registrieren Sie die Middleware mit `builder.Services.AddResponseCompression()` und fügen Sie sie mit `app.UseResponseCompression()` zur Pipeline hinzu. Das liefert Ihnen Brotli, Gzip und (neu in .NET 11) Zstandard, automatisch aus dem `Accept-Encoding`-Header des Clients ausgehandelt. Der Haken: Über HTTPS passiert nichts, es sei denn, Sie aktivieren es mit `EnableForHttps = true`, und diese Aktivierung birgt ein reales Sicherheitsrisiko, das Sie verstehen müssen, bevor Sie sie umlegen. Dieser Artikel behandelt den gesamten Weg: die Zwei-Zeilen-Einrichtung, die Zstandard-Ergänzung in .NET 11, die Komprimierungsstufen, die MIME-Typen, das HTTPS-Problem und die Fälle, in denen Sie die Komprimierung Ihrem Reverse-Proxy überlassen sollten.

Alles hier zielt auf .NET 11 ab (Preview 5 zum Zeitpunkt des Schreibens, allgemeine Verfügbarkeit im November 2026) mit `Microsoft.NET.Sdk.Web` und C# 14. Die Middleware `Microsoft.AspNetCore.ResponseCompression` ist seit ASP.NET Core 2.1 stabil, sodass die Brotli- und Gzip-Teile unverändert unter .NET 8, 9 und 10 funktionieren. Der Zstandard-Provider ist das einzige Teil, das ausschließlich .NET 11 und höher ist.

## Die zwei beweglichen Teile

Die Response-Komprimierung lebt im Shared Framework, daher gibt es kein NuGet-Paket zu installieren. Registrieren Sie die Dienste und fügen Sie die Middleware hinzu:

```csharp
// .NET 11, C# 14
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddResponseCompression();

var app = builder.Build();

app.UseResponseCompression();

app.MapGet("/data", () => Enumerable.Range(0, 1000)
    .Select(i => new { Id = i, Name = $"Item {i}", Note = "some repeated text" }));

app.Run();
```

Hier ist die vollständige Prozedur von Anfang bis Ende:

1. Rufen Sie `builder.Services.AddResponseCompression()` auf, um die Middleware und ihre Standard-Provider zu registrieren (Brotli, Gzip und Zstandard in .NET 11).
2. Rufen Sie `app.UseResponseCompression()` früh in der Pipeline auf, vor jeder Middleware, die den Response-Body schreibt.
3. Wenn Ihre API über HTTPS bereitgestellt wird (fast immer), setzen Sie `EnableForHttps = true` in den Optionen, nachdem Sie den Sicherheitsabschnitt weiter unten gelesen haben.
4. Fügen Sie alle Nicht-Standard-MIME-Typen, die Sie bereitstellen (zum Beispiel `image/svg+xml`), zu `ResponseCompressionOptions.MimeTypes` hinzu.
5. Passen Sie die Komprimierungsstufe pro Provider an, falls der Standard (der schnellste) nicht der Kompromiss ist, den Sie wünschen.
6. Überprüfen Sie mit einem Client, der `Accept-Encoding` sendet, und inspizieren Sie die Response-Header `Content-Encoding` und `Vary`.

Das ist die gesamte Funktion. Der Rest dieses Artikels handelt davon, jeden Schritt korrekt auszuführen, statt ihn nur zum Kompilieren zu bringen.

## Was sich in .NET 11 ändert: Zstandard ist jetzt integriert

Wenn Sie Response-Komprimierung in einer älteren .NET-Version eingerichtet haben, sagt das Muskelgedächtnis "Brotli und Gzip". In .NET 11 ist diese Liste gewachsen. Zstandard (Encoding-Token `zstd`, [RFC 8878](https://datatracker.ietf.org/doc/html/rfc8878)) ist jetzt ein erstklassiger Komprimierungs-Provider, integriert im `System.IO.Compression`-Stack ohne NuGet-Paket, ohne P/Invoke und ohne Drittanbieter-Binding. Wenn Sie `AddResponseCompression()` ohne explizite Provider aufrufen, registriert ASP.NET Core 11 alle drei: `BrotliCompressionProvider`, `GzipCompressionProvider` und `ZstandardCompressionProvider`.

Auch die Aushandlungsreihenfolge hat sich geändert. Unter .NET 10 und früher bevorzugte die Middleware Brotli und griff dann auf Gzip zurück. Unter .NET 11 ist die Präferenz zuerst Zstandard, dann Brotli und dann Gzip. Wenn also ein moderner Browser `Accept-Encoding: gzip, deflate, br, zstd` sendet, antwortet eine ASP.NET Core 11 API nun mit `Content-Encoding: zstd`. Der Grund für die Umsortierung ist, dass Zstandard bei dynamischen API-Antworten einen besseren Punkt auf der Geschwindigkeits-/Verhältnis-Kurve trifft: Auf seiner Standardstufe komprimiert es merklich schneller als Brotli bei einem gleichwertigen Verhältnis, und es dekomprimiert schneller als sowohl Brotli als auch Gzip, was zählt, wenn der Client ein Mobilgerät oder ein anderer Dienst ist.

Die wichtige betriebliche Konsequenz: Nach dem Upgrade auf .NET 11 beginnt Ihre API, `zstd` an jeden Client auszugeben, der es ankündigt, ohne dass Sie eine einzige Zeile ändern. Das ist für Browser und moderne HTTP-Clients in Ordnung, aber wenn Sie einen alten internen Konsumenten haben, der `zstd`-Unterstützung angab, es aber tatsächlich nicht dekodieren kann (selten, aber es kommt bei handgeschriebenen Clients vor), sehen Sie verstümmelte Bodies. Die Lösung besteht nicht darin, die Komprimierung global zu deaktivieren, sondern die Provider-Liste einzuschränken, wie der nächste Abschnitt zeigt.

## Provider explizit auswählen

In dem Moment, in dem Sie auch nur einen Provider von Hand hinzufügen, schalten sich die automatischen Standards aus. Das ist die häufigste Stolperfalle: `options.Providers.Add<BrotliCompressionProvider>()` zu schreiben und sich dann zu fragen, warum Gzip aufgehört hat zu funktionieren. Wenn Sie Provider explizit hinzufügen, sind nur die aktiv, die Sie auflisten.

Um also alle drei zu behalten und die HTTPS-Komprimierung zu aktivieren:

```csharp
// .NET 11, C# 14
using System.IO.Compression;
using Microsoft.AspNetCore.ResponseCompression;

builder.Services.AddResponseCompression(options =>
{
    options.EnableForHttps = true;
    options.Providers.Add<ZstandardCompressionProvider>();
    options.Providers.Add<BrotliCompressionProvider>();
    options.Providers.Add<GzipCompressionProvider>();
});
```

Die Reihenfolge, in der Sie Provider hinzufügen, ist die Präferenzreihenfolge des Servers, wenn ein Client mehr als einen akzeptiert. Setzen Sie Zstandard an die erste Stelle, wenn Sie es bevorzugen möchten, und Gzip an die letzte als universellen Rückfall. Wenn Sie nur Gzip erzwingen möchten (etwa um die Konfiguration eines Legacy-CDN abzubilden), fügen Sie ausschließlich `GzipCompressionProvider` und keinen anderen hinzu, und die Middleware wird nie Brotli oder Zstandard ausgeben.

## Komprimierungsstufen, und warum der Standard "am schnellsten" ist

Jeder Provider hat als Standard `CompressionLevel.Fastest`, nicht `Optimal`. Das überrascht Leute, die den kleinstmöglichen Body ab Werk erwarten. Der Standard ist bewusst gewählt: Für eine dynamische, pro Request berechnete Antwort liegt die CPU, die Sie für die Komprimierung aufwenden, auf dem heißen Pfad jeder Antwort, sodass das Framework die Latenz über die letzten paar Prozentpunkte an Größe stellt. `Optimal` und `SmallestSize` können ein Vielfaches an CPU für einen einstelligen prozentualen Zusatzschrumpf bei ohnehin kleinem JSON kosten.

Sie legen die Stufe pro Provider über dessen Optionsklasse fest:

```csharp
// .NET 11, C# 14
using System.IO.Compression;
using Microsoft.AspNetCore.ResponseCompression;

builder.Services.AddResponseCompression(options =>
{
    options.EnableForHttps = true;
    options.Providers.Add<ZstandardCompressionProvider>();
    options.Providers.Add<BrotliCompressionProvider>();
    options.Providers.Add<GzipCompressionProvider>();
});

builder.Services.Configure<BrotliCompressionProviderOptions>(options =>
{
    options.Level = CompressionLevel.Fastest;
});

builder.Services.Configure<GzipCompressionProviderOptions>(options =>
{
    options.Level = CompressionLevel.SmallestSize;
});
```

Das Enum `CompressionLevel` hat vier Werte: `NoCompression`, `Fastest`, `Optimal` und `SmallestSize`. Lassen Sie für eine interaktive API Zstandard und Brotli auf `Fastest`. Reservieren Sie `Optimal` oder `SmallestSize` für Antworten, die Sie einmal komprimieren und vielfach ausliefern, was bei einer reinen API meist bedeutet, dass Sie besser fahren, wenn Sie die komprimierten Bytes selbst cachen, statt bei jedem Request die optimale Komprimierung zu bezahlen. Wenn Sie zudem statische Assets bereitstellen, beachten Sie, dass die Komprimierung statischer Dateien eine separate Angelegenheit ist (zur Build-Zeit oder im CDN), nicht etwas, das diese Middleware zur Request-Zeit tun sollte.

Zstandard hat seinen eigenen, feineren Regler. Seine Qualität reicht von 1 bis 22, mit dem Standard bei etwa Stufe 3, und Sie legen sie über `ZstandardCompressionProviderOptions` fest:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.ResponseCompression;

builder.Services.Configure<ZstandardCompressionProviderOptions>(options =>
{
    options.CompressionOptions = new ZstandardCompressionOptions
    {
        Quality = 6 // 1 to 22; higher = smaller output, slower
    };
});
```

Höhere Qualität bedeutet einen kleineren Body und mehr CPU. Stufe 6 ist ein sinnvoller Schritt über den Standard hinaus, wenn Ihre Antworten groß und repetitiv sind (denken Sie an Listen-Endpunkte, die Tausende ähnlicher Objekte zurückgeben) und Sie CPU-Reserven haben.

## Die HTTPS-Sicherheitsfalle, die Sie nicht überspringen dürfen

`EnableForHttps` ist standardmäßig `false`, und dieser Standard ist eine Sicherheitsentscheidung, kein Versehen. Eine Antwort zu komprimieren, deren Body ein Geheimnis (ein Session-Token, ein CSRF-Token, eine Kontonummer) mit vom Angreifer beeinflusster Eingabe vermischt, über TLS, öffnet die Tür für die Angriffe [CRIME](https://en.wikipedia.org/wiki/CRIME) und [BREACH](https://en.wikipedia.org/wiki/BREACH). Diese Seitenkanalangriffe schließen auf das Geheimnis, indem sie beobachten, wie sich die Größe der komprimierten Antwort ändert, während der Angreifer die von ihm kontrollierte Eingabe variiert. Das Komprimierungsverhältnis verrät Informationen über den Inhalt, und über HTTPS bleibt die Größe des verschlüsselten Bodys beobachtbar.

Für eine typische JSON-API, die keine benutzerspezifischen Geheimnisse neben vom Angreifer kontrollierten Query-Werten zurückspiegelt, ist das Aktivieren der HTTPS-Komprimierung eine normale und vernünftige Sache, und fast jeder macht es. Aber Sie sollten diese Entscheidung bewusst treffen:

- Wenn Ihre Antworten nie ein geheimes Token im Body neben zurückgespiegelter Benutzereingabe einbetten, ist das Aktivieren der Komprimierung über HTTPS risikoarm.
- Wenn sie es könnten (eine HTML-Seite mit einem Antifälschungs-Token, ein Endpunkt, der einen Suchbegriff neben einem Session-Identifier zurückgibt), mildern Sie vor dem Aktivieren: Verwenden Sie Antifälschungs-Token (die Standard-Milderung in ASP.NET Core), vermeiden Sie das Zurückspiegeln nicht vertrauenswürdiger Eingabe in geheimnistragende Antworten, und erwägen Sie, die Komprimierung für diese spezifischen Endpunkte deaktiviert zu lassen.

Das Flag `EnableForHttps` ist global. Wenn Sie Komprimierung für öffentliche Daten-Endpunkte brauchen, aber nicht für einen sensiblen, ist die sauberste Aufteilung, die sensiblen Endpunkte ohne Komprimierung auszuführen, indem Sie die Pipeline segmentieren, oder sie mit einem `Content-Type` auszuliefern, den Sie bewusst aus der Liste komprimierbarer MIME-Typen herauslassen.

Noch eine Feinheit: Selbst mit `EnableForHttps = false` sehen Sie in Produktion möglicherweise dennoch einen `Content-Encoding`-Header. IIS, IIS Express und Azure App Service können Gzip auf der Ebene des Webservers unabhängig von Ihrer Anwendung anwenden. Wenn eine komprimierte Antwort auftaucht, die Sie nicht konfiguriert haben, prüfen Sie den `Server`-Response-Header, bevor Sie annehmen, dass die Middleware sich falsch verhält.

## MIME-Typen: was tatsächlich komprimiert wird

Die Middleware komprimiert nur Antworten, deren `Content-Type` mit ihrer Liste übereinstimmt. Die Standards decken die üblichen API- und Web-Payloads ab: `application/json`, `application/javascript`, `application/xml`, `text/css`, `text/html`, `text/json`, `text/plain` und `text/xml`. Für eine JSON-API erhalten Sie Komprimierung ohne jede Konfiguration, weil `application/json` auf der Liste steht.

Um etwas außerhalb der Standards zu komprimieren, hängen Sie es an `ResponseCompressionOptions.MimeTypes` an. Platzhalter wie `text/*` werden nicht unterstützt, listen Sie also jeden Typ auf:

```csharp
// .NET 11, C# 14
using System.Linq;
using Microsoft.AspNetCore.ResponseCompression;

builder.Services.AddResponseCompression(options =>
{
    options.EnableForHttps = true;
    options.MimeTypes = ResponseCompressionDefaults.MimeTypes.Concat(
        new[] { "image/svg+xml", "application/manifest+json" });
});
```

Fügen Sie keine bereits komprimierten Formate wie PNG, JPEG, WebP oder ZIP hinzu. Sie sind nativ komprimiert, und sie durch Brotli oder Zstandard zu schicken verbrennt CPU, um einen Body derselben Größe oder etwas größer zu erzeugen. Dasselbe gilt für sehr kleine Antworten: Unterhalb von etwa 150 bis 1000 Bytes kann der Komprimierungs-Overhead die Ausgabe größer machen als die Eingabe, sodass sich winzige Antworten unabhängig vom Typ nicht zum Komprimieren lohnen.

## Reihenfolge: UseResponseCompression kommt früh

Die Middleware-Reihenfolge entscheidet, ob die Komprimierung überhaupt funktioniert. `app.UseResponseCompression()` muss vor jeder Middleware laufen, die in den Response-Body schreibt, weil die Komprimierung funktioniert, indem sie den Response-Stream umhüllt. Wenn eine andere Middleware bereits mit dem Schreiben begonnen hat, sieht die Komprimierungs-Hülle diese Bytes nie. In der Praxis platzieren Sie sie nahe dem Anfang der Pipeline:

```csharp
// .NET 11, C# 14
var app = builder.Build();

app.UseResponseCompression();   // first, so it wraps everything below
app.UseStaticFiles();
app.UseRouting();
app.UseAuthentication();
app.UseAuthorization();

app.MapControllers();

app.Run();
```

Wenn die Komprimierung angewendet wird, macht die Middleware auch mit den Cache-Headern automatisch das Richtige: Sie entfernt `Content-Length` (die Body-Länge hat sich geändert), entfernt `Content-MD5` (der Hash ist nicht mehr gültig) und fügt `Vary: Accept-Encoding` hinzu, damit Caches die komprimierte und die unkomprimierte Variante getrennt speichern. Das verwalten Sie nicht von Hand.

## Wann Sie die Middleware ganz weglassen sollten

Die Response-Komprimierungs-Middleware ist das richtige Werkzeug, wenn Sie direkt auf Kestrel oder HTTP.sys hosten, ohne etwas davor, weil keiner dieser Server integrierte Komprimierung bietet. Aber wenn Ihre API hinter IIS, Nginx, Apache oder einem CDN sitzt, kann der Reverse-Proxy in der Regel schneller komprimieren als die verwaltete Middleware, und es an einer Stelle zu tun ist einfacher zu durchdenken. Microsofts eigene Empfehlung lautet, die serverbasierte Komprimierung zu bevorzugen, wenn sie verfügbar ist.

Zwei Fallen, auf die Sie achten sollten, wenn ein Proxy im Spiel ist:

- Nginx entfernt den `Accept-Encoding`-Header, wenn es den Request nach oben weiterleitet, was die ASP.NET Core-Middleware stillschweigend am Komprimieren hindert. Wenn Sie die Middleware hinter Nginx behalten, konfigurieren Sie Nginx entweder so, dass es den Header bewahrt, oder lassen Sie Nginx die Komprimierung übernehmen und lassen Sie die Middleware weg.
- Doppelte Komprimierung ist verschwendete Arbeit und kann Antworten beschädigen. Wenn der Proxy bereits komprimiert, führen Sie die Middleware nicht zusätzlich für dieselben Content-Typen aus. Wählen Sie eine einzige Schicht.

Für eine Minimal-API, die direkt aus Kestrel in einem Container ohne Sidecar-Proxy bereitgestellt wird, ist die Middleware genau richtig, und die Zwei-Zeilen-Einrichtung vom Anfang dieses Artikels ist alles, was Sie brauchen. Für alles, was hinter einem ausgereiften Proxy oder CDN sitzt, messen Sie zuerst: Möglicherweise erhalten Sie bereits eine Komprimierung, die Sie nicht konfiguriert haben.

## Benutzerdefinierte Provider, kurz gefasst

Wenn Sie ein Encoding brauchen, das das Framework nicht mitliefert, implementieren Sie `ICompressionProvider`. Die Eigenschaft `EncodingName` ist das Token, das die Middleware gegen `Accept-Encoding` abgleicht, und `CreateStream` liefert Ihre komprimierende Hülle zurück:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.ResponseCompression;

public sealed class CustomCompressionProvider : ICompressionProvider
{
    public string EncodingName => "mycustomcompression";
    public bool SupportsFlush => true;

    public Stream CreateStream(Stream outputStream)
    {
        // Wrap outputStream in your compression stream here.
        return outputStream;
    }
}
```

Registrieren Sie ihn wie jeden anderen Provider mit `options.Providers.Add<CustomCompressionProvider>()`. In der Praxis ist der Bedarf an benutzerdefinierten Providern mit dem nun integrierten Zstandard weitgehend verdampft. Zwischen Zstandard, Brotli und Gzip deckt .NET 11 jedes Encoding ab, das ein echter HTTP-Client verlangen wird, was der ganze Sinn der .NET 11-Änderung ist: Die schnelle, moderne Option ist jetzt standardmäßig aktiv, und Sie müssen nicht länger über das Framework hinausgreifen, um sie zu bekommen.

## Verwandte Artikel

- [So streamen Sie eine Datei aus einem ASP.NET Core-Endpunkt ohne Pufferung](/de/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) erklärt, warum Komprimierungs-Middleware und Streaming in Konflikt geraten können.
- [So fügen Sie Output-Caching zu einer Minimal-API in ASP.NET Core 11 hinzu](/de/2026/07/how-to-add-output-caching-to-a-minimal-api-in-aspnetcore-11/) passt gut zur Komprimierung für leselastige Endpunkte.
- [So organisieren Sie Minimal-API-Endpunkte mit MapGroup in ASP.NET Core 11](/de/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) hilft, wenn Sie Komprimierung für einige Routengruppen wollen, aber nicht für andere.
- [So geben Sie eine typisierte Results-Union aus einem Minimal-API-Endpunkt in ASP.NET Core 11 zurück](/de/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/) behandelt die Antworttypen, die durch diese Middleware fließen.
- [So verwenden Sie Native AOT mit ASP.NET Core Minimal-APIs](/de/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) lohnt sich, wenn Sie sich um die CPU-Kosten der Komprimierung bei Kaltstarts sorgen.

## Quellen

- [Response compression in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/response-compression?view=aspnetcore-11.0)
- [ResponseCompressionOptions.EnableForHttps (API reference)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.responsecompression.responsecompressionoptions.enableforhttps)
- [CompressionLevel enum (API reference)](https://learn.microsoft.com/en-us/dotnet/api/system.io.compression.compressionlevel)
- [RFC 8878: Zstandard Compression](https://datatracker.ietf.org/doc/html/rfc8878)
- [CRIME attack (Wikipedia)](https://en.wikipedia.org/wiki/CRIME) und [BREACH attack (Wikipedia)](https://en.wikipedia.org/wiki/BREACH)
