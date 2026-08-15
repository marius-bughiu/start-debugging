---
title: "Zstandard vs Brotli vs Gzip bei der Antwortkomprimierung in .NET 11"
description: "Zstandard ist die richtige Voreinstellung für dynamische API-Antworten in .NET 11, aber nicht in der Qualität, mit der der ASP.NET Core Provider ausgeliefert wird. Benchmarks auf echten JSON-Payloads zeigen, warum Qualität 1 die voreingestellte Qualität 3 sowohl bei der Größe als auch bei der CPU schlägt, wann Brotli weiterhin gewinnt und warum Gzip nur noch als Kompatibilitäts-Fallback überlebt."
pubDate: 2026-08-15
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "csharp"
  - "compression"
  - "performance"
lang: "de"
translationOf: "2026/08/zstandard-vs-brotli-vs-gzip-response-compression-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-08-15
---

Verwenden Sie für dynamische API-Antworten in .NET 11 Zstandard, das ohnehin die Voreinstellung ist, setzen Sie aber `Quality = 1` explizit, statt die Voreinstellung des Providers zu übernehmen. Auf den JSON-Payloads, die ich gemessen habe, komprimierte Zstandard mit Qualität 1 um 7.37x, während die voreingestellte Qualität 3 des Providers nur 6.66x erreichte, und Qualität 1 schaffte das mit fast doppeltem Durchsatz. Brotli gewinnt nur dann, wenn Sie einmal komprimieren und vielfach ausliefern können, und selbst dann nur mit Qualität 11, die 3,2 Sekunden pro 3-MB-Antwort kostet. Gzip ist inzwischen reiner Kompatibilitäts-Fallback.

Alles Folgende bezieht sich auf .NET 11 (zum Zeitpunkt des Schreibens Preview 7, GA im November 2026) und C# 14. Der Zstandard-Provider ist neu in ASP.NET Core 11; Brotli und Gzip sind seit ASP.NET Core 2.1 in der Middleware und verhalten sich unter .NET 8, 9 und 10 identisch.

## Die Matrix

| | Zstandard | Brotli | Gzip |
| --- | --- | --- | --- |
| `Accept-Encoding`-Token | `zstd` | `br` | `gzip` |
| Spezifikation | [RFC 8878](https://datatracker.ietf.org/doc/html/rfc8878) | [RFC 7932](https://datatracker.ietf.org/doc/html/rfc7932) | [RFC 1952](https://www.ietf.org/rfc/rfc1952.txt) |
| In `System.IO.Compression` enthalten seit | .NET 11 | .NET Core 2.1 | .NET Framework 2.0 |
| Standardmäßig registriert in ASP.NET Core 11 | Ja, als erstes | Ja, als zweites | Ja, als drittes |
| Voreingestellte Stufe des Providers | Qualität 3 | `CompressionLevel.Fastest` | `CompressionLevel.Fastest` |
| Stufenbereich | `MinQuality` (negativ) bis 22 | 0 bis 11 | 0 bis 9 |
| Ratio bei 292 KB JSON (beste sinnvolle Stufe) | 7.26x | 7.01x | 6.55x |
| Kompressionsdurchsatz auf dieser Stufe | 572 MB/s | 215 MB/s | 208 MB/s |
| Dekompressionsdurchsatz | 3103 MB/s | 1134 MB/s | 1575 MB/s |
| Funktioniert in Blazor WebAssembly | Nein | Ja | Ja |
| Wörterbuchunterstützung | Trainierbar (`ZstandardDictionary`) | Nur eingebautes statisches | Nein |

Die beiden Zeilen, die die meisten Diskussionen entscheiden, sind der Dekompressionsdurchsatz und die WebAssembly-Zeile. Alles andere liegt nah genug beieinander, dass eine Münze reichen würde.

## Was .NET 11 tatsächlich registriert, und in welcher Reihenfolge

Wenn Sie `AddResponseCompression()` ohne Angabe von Providern aufrufen, registriert ASP.NET Core 11 drei davon, und die Reihenfolge in [`ResponseCompressionProvider`](https://github.com/dotnet/aspnetcore/blob/main/src/Middleware/ResponseCompression/src/ResponseCompressionProvider.cs) ist die Präferenzreihenfolge des Servers:

```csharp
// ASP.NET Core 11, from ResponseCompressionProvider.cs
_providers = new ICompressionProvider[]
{
    new CompressionProviderFactory(typeof(ZstandardCompressionProvider)),
    new CompressionProviderFactory(typeof(BrotliCompressionProvider)),
    new CompressionProviderFactory(typeof(GzipCompressionProvider)),
};
```

Ein Browser, der `Accept-Encoding: gzip, deflate, br, zstd` sendet, erhält also `Content-Encoding: zstd` von einer ASP.NET Core 11 Anwendung, die Sie nie konfiguriert haben. Unter .NET 10 bekam dieselbe Anfrage `br`. Das ist die gesamte für Benutzer sichtbare Änderung, und sie tritt beim Upgrade ohne eine einzige Codezeile ein.

Sobald Sie einen Provider von Hand hinzufügen, schalten sich die Voreinstellungen vollständig ab und nur Ihre Liste bleibt aktiv. Das ist der häufigste Weg, Zstandard versehentlich zu deaktivieren, während man glaubt, lediglich die Komprimierung über HTTPS einzuschalten.

## Die voreingestellte Qualität ist die falsche Qualität

Hier der Teil, der nicht in den Release Notes steht. `BrotliCompressionProviderOptions` und `GzipCompressionProviderOptions` verwenden beide `CompressionLevel.Fastest` als Voreinstellung. Der Zstandard-Provider hat überhaupt keine `Level`-Eigenschaft. Er hat dies:

```csharp
// ASP.NET Core 11, from ZstandardCompressionProviderOptions.cs
public ZstandardCompressionOptions CompressionOptions { get; set; } = new();
```

Ein frisch erzeugtes `ZstandardCompressionOptions` lässt `Quality` auf `0`, und `0` bedeutet "implementierungsdefinierte Voreinstellung", die libzstd zu Stufe 3 auflöst. Die Brotli- und Gzip-Provider sind also auf Latenz getrimmt, während der Zstandard-Provider mit dem ausgewogenen Standardwert von libzstd ausgeliefert wird. Diese Asymmetrie hat niemand dokumentiert, aber genau das sagt der Quellcode.

Das wäre eine Randnotiz, wenn Qualität 3 einfach die langsamere, kleinere Option wäre. Ist sie nicht. Auf den JSON-Payloads, die ich gemessen habe, ist Qualität 3 auf **beiden** Achsen schlechter als Qualität 1:

| zstd-Qualität | Größe des 2.88-MB-JSON | Ratio | Kompressionsdurchsatz |
| --- | --- | --- | --- |
| 1 | 409,809 B | 7.37x | 806 MB/s |
| 2 | 427,111 B | 7.07x | - |
| 3 (Voreinstellung des Providers) | 453,130 B | 6.66x | 425 MB/s |
| 4 | 460,813 B | 6.55x | - |
| 5 | 449,750 B | 6.71x | - |
| 6 | 436,263 B | 6.92x | 159 MB/s |
| 9 | 422,148 B | 7.15x | - |
| 12 | 416,795 B | 7.24x | 54 MB/s |
| 19 | 362,100 B | 8.34x | - |

Lesen Sie diese Spalte noch einmal. Das Ratio fällt von Stufe 1 bis Stufe 4, steigt dann wieder und übertrifft Stufe 1 erst ab Stufe 9 erneut. 1,9x CPU zu zahlen, um einen 11% größeren Body zu bekommen, ist in jeder Richtung ein schlechtes Geschäft.

Das ist kein Fehler und nicht .NET-spezifisch. Die Stufen von Zstandard sind kein einzelner Regler: Jede Stufe wählt eine andere Match-Finder-Strategie samt eigener Fenster-, Chain-, Hash- und Mindestübereinstimmungsparameter. Fragt man libzstd direkt nach den verwendeten Parametern, wird die Unstetigkeit sichtbar:

```
level  1: strategy=1 (fast)   windowLog=19 chainLog=13 hashLog=14 minMatch=7
level  2: strategy=1 (fast)   windowLog=20 chainLog=15 hashLog=16 minMatch=6
level  3: strategy=2 (dfast)  windowLog=21 chainLog=16 hashLog=17 minMatch=5
level  4: strategy=2 (dfast)  windowLog=21 chainLog=18 hashLog=18 minMatch=5
level  5: strategy=3 (greedy) windowLog=21 chainLog=18 hashLog=19 minMatch=5
level  6: strategy=4 (lazy)   windowLog=21 chainLog=18 hashLog=19 minMatch=5
```

Der Sprung von Stufe 2 auf Stufe 3 senkt `minMatch` von 6 auf 5 und wechselt die Strategie. Bei Text mit langen, stark repetitiven Abschnitten (JSON-Schlüssel, die sich einmal pro Array-Element wiederholen, eine identische `notes`-Zeichenkette in jedem Datensatz) findet die Konfiguration von Stufe 1 weniger, dafür längere Übereinstimmungen, die sich entropiecodiert besser packen lassen. Diese Stufentabellen wurden gegen einen allgemeinen Korpus abgestimmt, die Reihenfolge gilt also im Mittel, nicht auf Ihrem Payload.

Die praktische Regel: Die Standardstufe eines jeden Codecs ist eine Vermutung über Daten, die er nie gesehen hat. Messen Sie die zwei oder drei realen Formen Ihrer Endpunkte und legen Sie die Qualität fest.

## Der Benchmark

Payload: ein JSON-Array aus Kundendatensätzen, die Form, die ein Listen-Endpunkt tatsächlich zurückgibt. Deterministisch, damit Sie es reproduzieren können:

```csharp
// .NET 10 / .NET 11, C# 14
static Guid NextGuid(Random rnd)
{
    var b = new byte[16];
    rnd.NextBytes(b);
    return new Guid(b);
}

static byte[] MakeListPayload(int count, int seed)
{
    var rnd = new Random(seed);
    string[] cities = ["Bucharest", "Berlin", "Lisbon", "Warsaw", "Dublin", "Madrid", "Helsinki"];
    string[] statuses = ["active", "pending", "suspended", "closed"];
    var items = Enumerable.Range(1, count).Select(i => new
    {
        id = i,
        externalId = NextGuid(rnd).ToString(),
        name = $"Customer {i}",
        email = $"user{i}@example.com",
        city = cities[rnd.Next(cities.Length)],
        status = statuses[rnd.Next(statuses.Length)],
        balance = Math.Round(rnd.NextDouble() * 10000, 2),
        createdAt = new DateTime(2024, 1, 1).AddMinutes(i * 7).ToString("O"),
        tags = new[] { "vip", "eu", "newsletter" }.Take(rnd.Next(1, 4)).ToArray(),
        notes = "Imported from the legacy CRM during the 2024 migration."
    });
    return JsonSerializer.SerializeToUtf8Bytes(items);
}
```

Methode: Jeder Codec umschließt einen `MemoryStream` genau so, wie die Antwortkomprimierungs-Middleware den Antwortbody umschließt, sodass die Encoder-Einrichtung pro Antwort innerhalb der Messung liegt. Drei Aufwärmdurchläufe, dann 60 gemessene Durchläufe für den 292-KB-Payload und 15 für den 2.88-MB-Payload, berichtet wird der Median. Maschine: Intel Core Ultra 7 265KF, Windows 11, .NET 10.0.5 x64.

Eine ehrliche Einschränkung zur Umgebung. Auf meiner Maschine liegt nur SDK 10.0.201, `System.IO.Compression.ZstandardStream` stand also nicht zum Kompilieren zur Verfügung. Die Zstandard-Zeilen stammen aus [ZstdSharp.Port](https://www.nuget.org/packages/ZstdSharp.Port) 0.8.8, einer verwalteten Portierung der Referenzimplementierung. Zwei Punkte machen diesen Ersatz vertretbar. Erstens enthält .NET 11 [libzstd 1.5.7](https://github.com/dotnet/runtime/blob/main/src/native/external/zstd/lib/zstd.h), und ich habe jede Ausgabegröße von ZstdSharp gegen natives libzstd 1.5.7 auf identischen Bytes geprüft: Sie stimmen auf 0,05% überein (41,132 gegenüber 41,135 Bytes bei Qualität 1, 43,644 gegenüber 43,647 bei Qualität 3). Die komprimierten Größen sind damit das, was .NET 11 erzeugen wird. Zweitens ist der Durchsatz die nicht übertragbare Zahl: Natives libzstd erreichte auf dieser Hardware 1092 MB/s bei Qualität 1, wo die verwaltete Portierung 806 MB/s schaffte. Behandeln Sie die Geschwindigkeitsspalte von Zstandard also als Untergrenze, nicht als Obergrenze.

**292 KB JSON (1.000 Datensätze), 298,727 Bytes roh:**

| Codec | Stufe | komprimiert | Ratio | Komp. MB/s | Dekomp. MB/s |
| --- | --- | --- | --- | --- | --- |
| gzip | Fastest | 69,832 | 4.28x | 743 | 1488 |
| gzip | Optimal | 45,586 | 6.55x | 208 | 1575 |
| brotli | Fastest | 44,606 | 6.70x | 564 | 808 |
| brotli | Optimal | 42,610 | 7.01x | 215 | 1134 |
| brotli | q11 (SmallestSize) | 34,025 | 8.78x | 1 | 728 |
| zstd | q1 | 41,132 | 7.26x | 572 | 3103 |
| zstd | q3 (Voreinstellung des Providers) | 43,644 | 6.84x | 276 | 1796 |
| zstd | q6 | 41,009 | 7.28x | 112 | 1735 |
| zstd | q12 | 38,881 | 7.68x | 20 | 1320 |

**2.88 MB JSON (10.000 Datensätze), 3,018,756 Bytes roh:**

| Codec | Stufe | komprimiert | Ratio | Komp. MB/s | Dekomp. MB/s |
| --- | --- | --- | --- | --- | --- |
| gzip | Fastest | 697,252 | 4.33x | 712 | 1443 |
| gzip | Optimal | 452,661 | 6.67x | 204 | 1620 |
| brotli | Fastest | 447,954 | 6.74x | 786 | 726 |
| brotli | Optimal | 429,060 | 7.04x | 186 | 1088 |
| brotli | q11 (SmallestSize) | 341,338 | 8.84x | 1 | 842 |
| zstd | q1 | 409,805 | 7.37x | 806 | 3158 |
| zstd | q3 (Voreinstellung des Providers) | 454,007 | 6.65x | 425 | 1914 |
| zstd | q6 | 436,263 | 6.92x | 159 | 1846 |
| zstd | q12 | 416,792 | 7.24x | 54 | 1891 |

Drei Ergebnisse tragen den gesamten Vergleich.

**Zstandard mit Qualität 1 dominiert Brotli `Fastest`.** Kleinere Ausgabe (41,132 gegenüber 44,606 Bytes), derselbe Kompressionsdurchsatz (572 gegenüber 564 MB/s) und 3,8x der Dekompressionsdurchsatz. Es gibt keine Achse, auf der die schnelle Einstellung von Brotli die bessere Wahl für eine dynamische Antwort wäre.

**Gzip `Fastest` ist bei der Größe nicht konkurrenzfähig.** 69,832 Bytes gegen die 41,132 von Zstandard sind ein um 70% größerer Body ohne Durchsatzvorteil. Wer modernen Clients weiterhin `gzip` schickt, bezahlt das in Bandbreite.

**Brotli q11 ist eine Falle auf dem Anfragepfad.** Es liefert tatsächlich die kleinste Ausgabe der Tabelle, 8.78x, rund 17% besser als Zstandard mit Qualität 1. Es brauchte aber auch 272 Millisekunden für den 292-KB-Payload und 3,2 Sekunden für den 2.88-MB-Payload. Und zwar pro Antwort. Wer "Brotli komprimiert am besten" misst und `SmallestSize` in einer produktiven API konfiguriert, hat jeder großen Antwort drei Sekunden CPU-gebundene Latenz hinzugefügt.

## Wann welches Verfahren

**Zstandard, Qualität 1** für alles, was pro Anfrage berechnet wird. JSON-Listen-Endpunkte, GraphQL-Antworten, serverseitig gerendertes HTML, Antworten bei der Log-Aufnahme. Das ist die Voreinstellung in .NET 11, und die einzige nötige Änderung ist das Festlegen der Qualität.

**Zstandard, Qualität 12 bis 19** für Inhalte, die einmal komprimiert und gecacht werden, wenn Sie die komprimierten Bytes speichern und wiederholt ausliefern. Qualität 19 erreichte 8.34x auf dem großen Payload und schloss damit den größten Teil des Abstands zu Brotli q11 zu einem Bruchteil der Kosten. Kombinieren Sie das mit [Output Caching](/de/2026/07/how-to-add-output-caching-to-a-minimal-api-in-aspnetcore-11/), damit die CPU einmal pro Cache-Eintrag statt einmal pro Anfrage bezahlt wird.

**Brotli, Qualität 11** für statische Assets, die zur Buildzeit komprimiert werden. Ihr JS-Bundle, Ihr CSS, Ihr WASM-Payload. Die Kompressionszeit spielt keine Rolle, wenn sie in der CI anfällt, und das eingebaute statische Wörterbuch von Brotli ist genau auf diese Inhalte abgestimmt. Tun Sie das nicht in der Antwortkomprimierungs-Middleware; komprimieren Sie vorab und liefern Sie die `.br`-Datei aus.

**Brotli, `Optimal`** wenn Sie breite Client-Unterstützung brauchen und Zstandard nicht nutzen können. Das betrifft insbesondere Blazor WebAssembly, siehe unten.

**Gzip** nur als letzten Eintrag in der Providerliste, für Clients, die nichts anderes ankündigen. Lassen Sie es registriert; bevorzugen Sie es nie.

## Die Punkte, die für Sie entscheiden

**Zstandard existiert weder im Browser noch unter WASI.** Die Laufzeit markiert die gesamte Typfamilie mit `[UnsupportedOSPlatform("browser")]` und `[UnsupportedOSPlatform("wasi")]`. Wenn Ihr Client eine Blazor WebAssembly Anwendung ist, die selbst dekomprimiert, oder Sie auf `wasi-wasm` laufen, ist Zstandard keine Option, und der Analyzer sagt Ihnen das zur Buildzeit. Serverseitige Komprimierung an einen Browser ist davon nicht betroffen: Die `zstd`-Unterstützung des Browsers selbst verarbeitet `Content-Encoding: zstd` nativ, und das ist in Chrome, Edge und Firefox schon eine Weile verfügbar. Betroffen ist nur Code, der `ZstandardStream` innerhalb einer WASM-Laufzeit aufruft.

**`CompressionLevel.NoCompression` bedeutet für Zstandard nicht "keine Komprimierung".** Die Laufzeit bildet das Enum wie folgt auf die zstd-Qualität ab:

```csharp
// .NET 11, from ZstandardUtils.cs
CompressionLevel.NoCompression => Quality_Min,   // ZSTD_minCLevel(), a large negative number
CompressionLevel.Fastest       => 1,
CompressionLevel.Optimal       => Quality_Default,  // 3
CompressionLevel.SmallestSize  => Quality_Max,      // 22
```

`NoCompression` bildet auf die *minimale Qualität* ab, was immer noch eine komprimierende Konfiguration ist, nur eine extrem schnelle und schwache. Bei Gzip und Brotli bedeutet `NoCompression` tatsächlich gespeicherte Blöcke. Derselbe Enum-Wert liefert bei den drei Codecs drei verschiedene Verhaltensweisen.

**Negative Qualitäten sind zulässig, und die ASP.NET Core Dokumentation erwähnt sie nicht.** [Die Seite zur Antwortkomprimierung](https://learn.microsoft.com/en-us/aspnet/core/performance/response-compression?view=aspnetcore-11.0) sagt, die Qualitätsstufe reiche "von 1 bis 22". Der Quellcode der Laufzeit ist weiter gefasst: `Quality` akzeptiert alles von `MinQuality` bis `MaxQuality`, wobei negative Werte dokumentiert als Erweiterung des Bereichs zwischen Geschwindigkeit und Ratio dienen. Für JSON sind sie selten das Richtige. Qualität -5 brachte die Komprimierung auf 1635 MB/s, aber das Ratio brach von 7.37x auf 3.81x ein, was bei einer 3-MB-Antwort bedeutet, rund 375 KB mehr über die Leitung zu schicken, um eine Millisekunde CPU zu sparen. Greifen Sie zu Qualität 1, nicht zu negativen Werten.

**Die Komprimierung über HTTPS zu aktivieren, bleibt eine Opt-in-Entscheidung mit realem Risiko.** `EnableForHttps` ist standardmäßig `false`, weil das Komprimieren einer Antwort, die ein Geheimnis mit von Angreifern beeinflusster Eingabe mischt, dieses Geheimnis über die komprimierte Größe preisgibt ([CRIME](https://en.wikipedia.org/wiki/CRIME) und [BREACH](https://en.wikipedia.org/wiki/BREACH)). Ein Codec-Wechsel ändert daran nichts: Zstandard ist genauso verwundbar, wie Gzip es war. Die Begründung und die Liste der Gegenmaßnahmen liefert der [vollständige Leitfaden zur Einrichtung der Antwortkomprimierung](/de/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/).

**Kleine Antworten verlieren bei jedem Codec.** Die Einzeldatensatz-Antwort in meinem Testsatz ist 179 Bytes groß. Gzip `Fastest` machte daraus 188 Bytes, also mehr als die Eingabe, und Zstandard mit Qualität 1 machte 157 Bytes daraus, ein "Gewinn" von 1.14x, den der Framing-Overhead und die Encoder-Einrichtung pro Antwort vollständig auffressen. Die Empfehlung des Frameworks selbst lautet, unterhalb von etwa 150 bis 1.000 Bytes nicht zu komprimieren, und die Codec-Wahl verschiebt diese Schwelle nicht.

## Die Konfiguration

Die vollständige Konfiguration für eine JSON-API mit festgelegter Qualität:

```csharp
// .NET 11, C# 14
using System.IO.Compression;
using Microsoft.AspNetCore.ResponseCompression;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddResponseCompression(options =>
{
    options.EnableForHttps = true;
    options.Providers.Add<ZstandardCompressionProvider>();
    options.Providers.Add<BrotliCompressionProvider>();
    options.Providers.Add<GzipCompressionProvider>();
});

builder.Services.Configure<ZstandardCompressionProviderOptions>(options =>
{
    options.CompressionOptions = new ZstandardCompressionOptions
    {
        Quality = 1
    };
});

var app = builder.Build();

app.UseResponseCompression();

app.MapGet("/customers", () => Results.Ok(GetCustomers()));

app.Run();
```

Alle drei Provider explizit hinzuzufügen, ist gegenüber den Voreinstellungen redundant, dokumentiert aber die Präferenzreihenfolge für die nächste Person und übersteht es, wenn später jemand einen vierten Provider ergänzt.

Zwei weitere Stellschrauben an `ZstandardCompressionOptions` sind bei Streaming-Antworten erwähnenswert. `TargetBlockSize` (gültiger Bereich 1.340 bis 131.072 Bytes) gibt einen Hinweis darauf, wie häufig der Encoder einen Block ausgibt; kleinere Werte bedeuten geringere Latenz bei einer tröpfelnden Antwort, zu einem gewissen Preis beim Ratio. `EnableLongDistanceMatching` verbessert die Ratios bei großen Bodies auf Kosten des Speichers. Beides lohnt sich erst, wenn Sie die Qualität festgelegt und gemessen haben.

Wenn Ihre Antworten klein, gleichförmig und repetitiv sind, ist `ZstandardDictionary` die Funktion, die sich wirklich zu prüfen lohnt. Ein auf repräsentativen Stichproben trainiertes Wörterbuch erlaubt Zstandard, Payloads zu komprimieren, die einzeln zu klein sind, um ein brauchbares Fenster aufzubauen. Genau das ist der Fall, in dem die 179-Byte-Antwort von oben komprimierbar wird. Brotli und Gzip haben kein Äquivalent, das Sie selbst trainieren könnten.

## Die Empfehlung, noch einmal

Nehmen Sie die Voreinstellung von .NET 11 und legen Sie eine Eigenschaft fest. Zstandard mit Qualität 1 lieferte das beste Ratio aller Stufen, die schnell genug für einen Anfragepfad laufen, erreichte die schnellste Brotli-Einstellung beim Kompressionsdurchsatz und dekomprimierte rund 3x schneller als alles andere in der Tabelle. Das ist die Zahl, die Ihre mobilen Clients spüren. Lassen Sie Brotli und Gzip darunter registriert, damit alte Clients weiterhin etwas bekommen.

Übernehmen Sie nicht die voreingestellte Qualität 3 des Providers. Sie ist die einzige Konfiguration in diesem Vergleich, die gleichzeitig bei Größe und Geschwindigkeit unterliegt, und genau das bekommen Sie, wenn Sie nichts ändern.

## Verwandte Artikel

- [Antwortkomprimierung zu einer ASP.NET Core 11 API hinzufügen](/de/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/) behandelt die Einrichtung der Middleware, die MIME-Typen und die Sicherheitsentscheidung zu HTTPS vollständig.
- [.NET 11 fügt System.IO.Compression native Zstandard-Komprimierung hinzu](/de/2026/04/dotnet-11-zstandard-compression-system-io/) stellt die `ZstandardStream`-API außerhalb des HTTP-Kontexts vor.
- [Output Caching vs Response Caching in ASP.NET Core 11](/de/2026/07/output-caching-vs-response-caching-in-aspnetcore-11/) zeigt, wie Sie eine hohe Kompressionsstufe bezahlbar machen.
- [Span-basierte Deflate- und Gzip-Komprimierung in .NET 11](/de/2026/05/dotnet-11-span-based-deflate-gzip-compression/) behandelt die allokationsfreien Einzelschritt-APIs für die älteren Codecs.
- [Eine Datei aus einem ASP.NET Core Endpunkt ohne Pufferung streamen](/de/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) erklärt, wo Komprimierung und Streaming schlecht zusammenspielen.

## Quellen

- [Antwortkomprimierung in ASP.NET Core 11 (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/response-compression?view=aspnetcore-11.0)
- [ResponseCompressionProvider.cs, voreingestellte Providerreihenfolge (dotnet/aspnetcore)](https://github.com/dotnet/aspnetcore/blob/main/src/Middleware/ResponseCompression/src/ResponseCompressionProvider.cs)
- [ZstandardCompressionProviderOptions.cs (dotnet/aspnetcore)](https://github.com/dotnet/aspnetcore/blob/main/src/Middleware/ResponseCompression/src/ZstandardCompressionProviderOptions.cs)
- [ZstandardCompressionOptions.cs, Semantik von Qualität und Fenster (dotnet/dotnet)](https://github.com/dotnet/dotnet/blob/main/src/runtime/src/libraries/System.IO.Compression.Zstandard/src/System/IO/Compression/ZstandardCompressionOptions.cs)
- [Klassenreferenz ZstandardCompressionOptions (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.io.compression.zstandardcompressionoptions?view=net-11.0)
- [Support zstd Content-Encoding (dotnet/aspnetcore issue 50643)](https://github.com/dotnet/aspnetcore/issues/50643)
- [RFC 8878: Zstandard Compression and the application/zstd Media Type](https://datatracker.ietf.org/doc/html/rfc8878)
- [Zstandard-Referenzimplementierung](https://github.com/facebook/zstd)
