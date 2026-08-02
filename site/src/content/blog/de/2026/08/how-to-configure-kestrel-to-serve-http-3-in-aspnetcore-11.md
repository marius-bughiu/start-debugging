---
title: "Kestrel in ASP.NET Core 11 für HTTP/3 konfigurieren"
description: "Ein vollständiger Leitfaden zur Aktivierung von HTTP/3 in Kestrel unter ASP.NET Core 11: die Endpunkt-Konfiguration mit HttpProtocols.Http1AndHttp2AndHttp3, die MsQuic-Plattformanforderungen unter Windows, Linux und macOS, warum die erste Anfrage nie HTTP/3 ist, die Überprüfung mit HttpClient und Middleware, das Tuning von QuicTransportOptions sowie die Firewall- und Proxy-Fallstricke, die zu einem stillen Fallback führen."
pubDate: 2026-08-02
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "kestrel"
  - "http-3"
  - "performance"
lang: "de"
translationOf: "2026/08/how-to-configure-kestrel-to-serve-http-3-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-08-02
---

Um HTTP/3 aus Kestrel auszuliefern, konfigurieren Sie einen HTTPS-Endpunkt mit `listenOptions.Protocols = HttpProtocols.Http1AndHttp2AndHttp3`. Das ist die gesamte API-Oberfläche. Alles, was danach schiefgeht, ist umgebungsbedingt: MsQuic fehlt auf dem Host, UDP ist auf dem Port blockiert, ein Reverse Proxy beendet die Verbindung, bevor QUIC Sie überhaupt erreicht, oder Sie testen mit einem Browser, der das Entwicklungszertifikat über HTTP/3 ablehnt. Kestrel wirft für keinen dieser Fälle eine Exception. Es deaktiviert HTTP/3, liefert weiterhin HTTP/1.1 und HTTP/2 aus, und Ihre `curl`-Ausgabe sieht exakt so aus wie vor der Änderung.

Alles hier zielt auf .NET 11 (getestet gegen Preview 6, SDK `11.0.100-preview.6.26359.118`) mit `Microsoft.NET.Sdk.Web` und C# 14. HTTP/3 in Kestrel wird seit .NET 7 vollständig unterstützt, die Konfiguration unten gilt also unverändert für .NET 8, 9 und 10. Wirklich neu in .NET 11 ist allein die frühe Anfrageverarbeitung am Ende dieses Artikels.

## Die sechs Schritte von Anfang bis Ende

1. Konfigurieren Sie einen HTTPS-Endpunkt und setzen Sie `Protocols` auf `HttpProtocols.Http1AndHttp2AndHttp3`.
2. Stellen Sie sicher, dass MsQuic auf dem Host vorhanden ist, also Windows 11 oder Windows Server 2022 oder neuer, beziehungsweise das Paket `libmsquic` unter Linux.
3. Öffnen Sie den UDP-Port mit derselben Nummer wie Ihr TLS-Port in jeder Firewall und jeder Sicherheitsgruppe auf dem Weg.
4. Fügen Sie eine Startprüfung hinzu, die deutlich protokolliert, wenn `QuicListener.IsSupported` false ist. Eine fehlende Abhängigkeit wird so zu einer Log-Zeile statt zu einem Rätsel.
5. Prüfen Sie mit `HttpClient` und fixierter Version 3.0, nicht mit einem Browser.
6. Protokollieren Sie `HttpContext.Request.Protocol` in einer Middleware, damit Sie sehen, was Clients in der Produktion tatsächlich ausgehandelt haben.

Der Rest dieses Artikels handelt davon, jeden dieser Schritte korrekt umzusetzen, statt den Code nur zum Kompilieren zu bringen.

## Den Endpunkt konfigurieren

Es gibt kein NuGet-Paket zu installieren. Der QUIC-Transport `Microsoft.AspNetCore.Server.Kestrel.Transport.Quic` liegt im Shared Framework von ASP.NET Core. Sie müssen nur ändern, wie der Endpunkt deklariert wird:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Server.Kestrel.Core;

var builder = WebApplication.CreateBuilder(args);

builder.WebHost.ConfigureKestrel((context, options) =>
{
    options.ListenAnyIP(5001, listenOptions =>
    {
        listenOptions.Protocols = HttpProtocols.Http1AndHttp2AndHttp3;
        listenOptions.UseHttps();
    });
});

var app = builder.Build();

app.MapGet("/ping", (HttpContext ctx) => new { protocol = ctx.Request.Protocol });

app.Run();
```

Zwei Details in diesem Ausschnitt leisten echte Arbeit. `UseHttps()` ist nicht optional: HTTP/3 verlangt zwingend TLS 1.3, ein Endpunkt ohne TLS kann h3 also nie aushandeln. Und der Enum-Wert lautet `Http1AndHttp2AndHttp3`, nicht `Http3`. Der Standardwert von Kestrel ist `Http1AndHttp2`, und der Drei-Protokoll-Wert ist der, den Sie in der Produktion wollen, weil nicht jeder Router, jeder Unternehmensproxy und jeder Mobilfunkanbieter QUIC sauber durchreicht. `HttpProtocols.Http3` allein liefert einen Endpunkt ohne Rückfallebene: Auf einem Host ohne verfügbares MsQuic deaktiviert Kestrel HTTP/3, und für diesen Endpunkt bleibt nichts mehr übrig, was er ausliefern könnte.

Dieselbe Einstellung ist über die Konfiguration verfügbar, was meist der bessere Ort dafür ist, weil Sie HTTP/3 damit pro Umgebung ohne Neubau aktivieren können:

```json
{
  "Kestrel": {
    "Endpoints": {
      "Https": {
        "Url": "https://*:5001",
        "Protocols": "Http1AndHttp2AndHttp3"
      }
    }
  }
}
```

Es gibt außerdem `Kestrel:EndpointDefaults:Protocols`, wenn Sie das auf jeden Endpunkt anwenden möchten. Beachten Sie die Vorrangregel, die hier viele erwischt: Ein expliziter Aufruf von `Listen` oder `ListenAnyIP` in `ConfigureKestrel` überschreibt `ASPNETCORE_URLS`, `--urls` und die `applicationUrl` aus `launchSettings.json`. Kestrel protokolliert dabei eine Warnung ("Overriding address(es)"), und wenn Sie die übersehen, verlieren Sie einen Nachmittag mit der Frage, warum Ihre Anwendung nicht mehr auf Port 7043 läuft. Entscheiden Sie sich für einen Mechanismus, nicht für beide.

## Was MsQuic auf jeder Plattform voraussetzt

ASP.NET Core implementiert QUIC nicht selbst. `System.Net.Quic` bindet [MsQuic](https://github.com/microsoft/msquic) ein, und die Plattformmatrix wird vollständig von dieser nativen Bibliothek geerbt.

Unter **Windows** wird `msquic.dll` als Teil der .NET-Laufzeit ausgeliefert, es ist also nichts zu installieren, aber das Betriebssystem muss Windows 11 oder Windows Server 2022 oder neuer sein. Frühere Windows-Versionen besitzen die kryptografischen APIs nicht, die QUIC benötigt, und keine Konfiguration umgeht das. Das ist der häufigste Grund, warum HTTP/3 auf einem Unternehmensziel, das noch Windows Server 2019 einsetzt, nicht anspringt.

Unter **Linux** müssen Sie `libmsquic` selbst installieren. Es wird im Paketrepository von Microsoft unter `packages.microsoft.com` veröffentlicht und liegt außerdem im community-Repository von Alpine:

```bash
# Debian / Ubuntu, after adding the packages.microsoft.com repo
sudo apt-get install libmsquic

# Alpine 3.21 and later
sudo apk add libmsquic
```

.NET 7 und neuer benötigen libmsquic 2.2 oder neuer. Die 1.9.x-Linie, auf die .NET 6 festgelegt war, ist nicht kompatibel. Wenn Sie also ein altes Dockerfile aus einem .NET-6-Projekt weiterverwenden, prüfen Sie die Version, die Sie ziehen. Das bedeutet auch: Ein einfaches Container-Image `mcr.microsoft.com/dotnet/aspnet` spricht **kein** HTTP/3 ab Werk; Sie müssen das Paket in Ihrer eigenen Image-Schicht ergänzen. Wenn Sie Images mit `dotnet publish /t:PublishContainer` bauen, ist das ein zusätzliches `RUN`, das sich nicht allein über die Container-Eigenschaften des SDK ausdrücken lässt, und Sie brauchen ein Dockerfile.

Unter **macOS** ist die Unterstützung teilweise und inoffiziell. Sie können `brew install libmsquic` ausführen, aber die Laufzeit findet die Bibliothek nur, wenn Sie den dynamischen Loader auf das Präfix von Homebrew zeigen lassen:

```bash
DYLD_FALLBACK_LIBRARY_PATH=$DYLD_FALLBACK_LIBRARY_PATH:$(brew --prefix)/lib dotnet run
```

Behandeln Sie das als Komfort für die lokale Entwicklung, nicht als unterstützte Produktionskonfiguration.

## Den stillen Fallback laut machen

Das Fallback-Verhalten von Kestrel ist der richtige Standard für einen Webserver und der denkbar schlechteste für die Fehlersuche. Fehlt MsQuic, wird HTTP/3 deaktiviert und die Anwendung startet normal. Nichts in der Standardausgabe auf Stufe `Information` weist darauf hin.

Die Lösung ist eine dreizeilige Startprüfung gegen dieselbe `IsSupported`-Eigenschaft, die `System.Net.Quic` bereitstellt:

```csharp
// .NET 11, C# 14
using System.Net.Quic;

var app = builder.Build();

if (!QuicListener.IsSupported)
{
    app.Logger.LogWarning(
        "QUIC is not supported on this host. HTTP/3 is disabled and Kestrel " +
        "will serve HTTP/1.1 and HTTP/2 only. Check for libmsquic and TLS 1.3 support.");
}
```

`QuicListener.IsSupported` liefert false aus den beiden Gründen, die zählen: Die native Bibliothek fehlt, oder TLS 1.3 steht nicht zur Verfügung. Verwenden Sie `QuicListener.IsSupported` auf der Serverseite und `QuicConnection.IsSupported` auf der Clientseite. Derzeit melden beide denselben Wert, die dokumentierte Empfehlung lautet aber, die zu Ihrer Rolle passende Eigenschaft zu prüfen.

Wenn Sie mehr Details brauchen, setzen Sie die Kestrel-Kategorie auf `Debug` und beobachten Sie das Binden:

```json
{
  "Logging": {
    "LogLevel": {
      "Microsoft.AspNetCore.Server.Kestrel": "Debug"
    }
  }
}
```

## Warum Ihre erste Anfrage nie HTTP/3 ist

Das ist der Teil, der viele glauben lässt, ihre Konfiguration sei kaputt, obwohl sie einwandfrei funktioniert.

Ein Client kann vor dem Verbindungsaufbau nicht wissen, dass ein Server HTTP/3 spricht, denn es gibt weder einen DNS-Eintrag noch eine TLS-Erweiterung, die das ankündigt. Die Erkennung läuft über den Antwort-Header [`alt-svc`](https://developer.mozilla.org/docs/Web/HTTP/Headers/Alt-Svc): Der Client stellt seine erste Anfrage über HTTP/1.1 oder HTTP/2, sieht einen Header, der einen h3-Endpunkt nennt, und nutzt QUIC für die weiteren Anfragen an diesen Origin. Kestrel setzt diesen Header automatisch, sobald HTTP/3 auf dem Endpunkt aktiviert ist, sodass die erste Antwort etwa so aussieht:

```text
HTTP/2 200
alt-svc: h3=":5001"
```

Ein Test mit einer einzelnen Anfrage meldet daher immer HTTP/2. Jede Messung muss mindestens zwei Anfragen über dieselbe Client-Instanz absetzen, und der Client muss `alt-svc` beachten.

IIS ist die Ausnahme, die man kennen sollte. Beim Hosting hinter IIS wird HTTP/3 im In-Process-Modell unterstützt, aber IIS setzt `alt-svc` nicht für Sie. Sie setzen den Header selbst, früh in der Pipeline:

```csharp
// .NET 11, C# 14 - only needed when hosting behind IIS
app.Use((context, next) =>
{
    context.Response.Headers.AltSvc = "h3=\":443\"";
    return next(context);
});
```

IIS benötigt zusätzlich Windows Server 2022 oder Windows 11, eine `https`-Bindung und den gesetzten Registrierungsschlüssel `EnableHttp3`. Beachten Sie außerdem, dass Out-of-Process-Hosting `HTTP/1.1` aus `HttpRequest.Protocol` meldet, selbst auf einer HTTP/3-Verbindung, weil IIS die Anfragen mit diesem Protokoll an Kestrel weiterreicht. Nur das In-Process-Modell meldet `HTTP/3`.

## Überprüfen, dass es wirklich funktioniert

Verwenden Sie keinen Browser. Browser lehnen selbstsignierte Zertifikate über HTTP/3 ab, dazu gehört das Entwicklungszertifikat von ASP.NET Core. Ein lokaler Browsertest meldet deshalb dauerhaft HTTP/2 und sagt Ihnen nichts.

Verwenden Sie `HttpClient` mit fixierter Version. Für einen Test wollen Sie `RequestVersionExact`, weil das laut fehlschlägt statt still herunterzustufen:

```csharp
// .NET 11, C# 14
using System.Net;

using var client = new HttpClient
{
    DefaultRequestVersion = HttpVersion.Version30,
    DefaultVersionPolicy = HttpVersionPolicy.RequestVersionExact
};

var response = await client.GetAsync("https://localhost:5001/ping");

Console.WriteLine($"status: {response.StatusCode}, version: {response.Version}");
// status: OK, version: 3.0
```

Im Anwendungscode wollen Sie die umgekehrte Richtlinie. Setzen Sie die Version auf 1.1 mit `HttpVersionPolicy.RequestVersionOrHigher`, damit der Client auf HTTP/3 hochstuft, wenn der Server es ankündigt, und sauber zurückfällt, wenn nicht. `RequestVersionExact` in der Produktion macht aus einem Netzwerkaussetzer einen harten Fehler, ein naher Verwandter [der TLS-Handshake-Fehler, die als "The SSL connection could not be established" auftauchen](/de/2026/06/fix-the-ssl-connection-could-not-be-established-with-httpclient/).

Auf dem Server ist die verlässliche Wahrheit eine einzige Zeile Middleware:

```csharp
// .NET 11, C# 14
app.Use(async (context, next) =>
{
    app.Logger.LogInformation("Request served over {Protocol}", context.Request.Protocol);
    await next(context);
});
```

`HttpContext.Request.Protocol` ist bei einer QUIC-Verbindung die Zeichenfolge `"HTTP/3"`. Wenn Sie darauf verzweigen wollen, vermeidet `HttpProtocol.IsHttp3(context.Request.Protocol)` aus `Microsoft.AspNetCore.Http` das Hartkodieren des Literals. Diesen Wert nach dem Rollout eine Woche lang als Metrik-Dimension auszugeben ist die einzige ehrliche Methode, um zu erfahren, welcher Anteil Ihres Verkehrs tatsächlich auf h3 gelandet ist, und der Anteil ist meist niedriger als erwartet.

## QuicTransportOptions tunen

Der Transport hat ein eigenes Optionsobjekt, das über `UseQuic` am Web Host Builder konfiguriert wird und nicht über `ConfigureKestrel`:

```csharp
// .NET 11, C# 14
builder.WebHost.UseQuic(options =>
{
    options.MaxBidirectionalStreamCount = 200;
    options.MaxUnidirectionalStreamCount = 20;
});
```

Die Standardwerte sind `MaxBidirectionalStreamCount` 100, `MaxUnidirectionalStreamCount` 10, `MaxReadBufferSize` 1 MB, `MaxWriteBufferSize` 64 KB und `Backlog` 512. Die Anzahl bidirektionaler Streams lohnt eine erneute Betrachtung: Sie begrenzt die gleichzeitigen Anfragen pro Verbindung, und weil QUIC kein Head-of-Line-Blocking kennt, schiebt ein Client, der früher mehrere HTTP/2-Verbindungen geöffnet hätte, nun womöglich alles durch eine einzige. Wenn Sie eine gesprächige Single-Page-App oder einen gRPC-Client bedienen, kann 100 zur Obergrenze werden.

Falls Sie ein Beispiel kopiert haben, das diesen Block in `#pragma warning disable CA2252` einschließt: Das stammt aus der Zeit, als `System.Net.Quic` als Vorschaufunktion ausgeliefert wurde. Diese APIs sind seit .NET 9 stabil, das Pragma können Sie daher meist entfernen.

## Die Fallstricke, die am meisten Zeit kosten

**UDP ist nicht geöffnet.** QUIC läuft über UDP auf derselben Portnummer wie Ihr TLS-Endpunkt. Jede Firewall, jede Sicherheitsgruppe und jeder Load Balancer auf dem Weg muss eingehendes UDP auf diesem Port erlauben, und die meisten Standardvorlagen öffnen nur TCP. Das ist die häufigste Ursache für "es läuft auf meinem Rechner, aber nicht in Azure".

**Etwas davor beendet die Verbindung.** Wenn ein Layer-7-Load-Balancer, ein Ingress Controller oder ein CDN zwischen Client und Kestrel sitzt, muss HTTP/3 *dort* aktiviert sein, und der Sprung von diesem Proxy zu Kestrel läuft häufig ohnehin über HTTP/1.1. h3 auf Kestrel hinter einem Proxy zu aktivieren, der QUIC nicht weiterleitet, ändert überhaupt nichts.

**Manche `UseHttps`-Überladungen sind nicht kompatibel.** Sobald HTTP/3 im Spiel ist, sind `HandshakeTimeout` und `OnAuthenticate` in `HttpsConnectionAdapterOptions` wirkungslos, und die `UseHttps`-Überladungen mit einem `ServerOptionsSelectionCallback` samt Handshake-Timeout oder mit `TlsHandshakeCallbackOptions` werfen eine Exception. Wenn Sie Zertifikate dynamisch pro Hostname auswählen, prüfen Sie diesen Pfad, bevor Sie h3 aktivieren.

**Sie messen das Falsche.** Die Gewinne von HTTP/3 sind weniger Handshake-Roundtrips und kein Head-of-Line-Blocking bei Paketverlust. Auf einer verlustfreien Verbindung mit niedriger Latenz zwischen zwei Maschinen im selben Rechenzentrum sieht es identisch zu HTTP/2 aus, und ein Benchmark über Loopback zeigt gar nichts. Messen Sie in einem echten Mobilfunk- oder verlustbehafteten Netz oder lassen Sie es. Die Antwortgröße dominiert weiterhin die meisten Latenzbudgets einer API, weshalb [Antwortkomprimierung](/de/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/) in der Regel ein größerer und billigerer Gewinn ist als ein Protokoll-Upgrade.

## Was .NET 11 geändert hat

Vor .NET 11 wartete Kestrel darauf, den QUIC-Control-Stream der Gegenstelle und deren initialen `SETTINGS`-Frame zu empfangen, bevor es irgendeinen Anfrage-Stream weitergab. Das kostete ungefähr einen zusätzlichen logischen Roundtrip bei jeder neuen Verbindung, also genau in dem Szenario, in dem HTTP/3 eine bereits warme HTTP/2-Verbindung schlagen soll. In .NET 11 gibt Kestrel Anfrage-Streams weiter, sobald sie eintreffen, und wendet die Einstellungen der Gegenstelle an, wenn der Control-Stream nachzieht. Es gibt nichts zu konfigurieren und keine Codeänderungen auf Handler-Ebene: Es ist eine Verhaltensänderung auf Protokollebene, die Sie durch das Upgrade erhalten, ausführlicher beschrieben im Artikel über [die frühe HTTP/3-Anfrageverarbeitung in Kestrel](/de/2026/04/aspnetcore-11-kestrel-http3-early-request-processing/).

Zu beachten bleibt, dass Kestrel weiterhin die endgültige `SETTINGS_MAX_FIELD_SECTION_SIZE` der Gegenstelle respektiert, bevor es Antwort-Header serialisiert. Halten Sie die Antwort-Header der ersten Anfrage klein, dann erhalten Sie den vollen Nutzen.

Wenn Sie einen neuen Dienst aufsetzen und entscheiden, wie viel vom Host Sie explizit konfigurieren, ist die Protokolleinstellung einer der wenigen Regler, die für einen selbst gebauten Host statt des Standardhosts sprechen; die Abwägungen stehen im Vergleich von [CreateBuilder, CreateSlimBuilder und CreateEmptyBuilder](/de/2026/07/webapplication-createbuilder-vs-createslimbuilder-vs-createemptybuilder-in-aspnetcore-11/).

## Verwandte Artikel

- [Kestrel verarbeitet HTTP/3-Anfragen vor dem SETTINGS-Frame in .NET 11](/de/2026/04/aspnetcore-11-kestrel-http3-early-request-processing/)
- [Antwortkomprimierung zu einer ASP.NET Core 11 API hinzufügen](/de/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/)
- [Fix: The SSL connection could not be established mit HttpClient](/de/2026/06/fix-the-ssl-connection-could-not-be-established-with-httpclient/)
- [Eine .NET 11 Anwendung als Container-Image mit dotnet publish /t:PublishContainer veröffentlichen](/de/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/)
- [WebApplication.CreateBuilder vs CreateSlimBuilder vs CreateEmptyBuilder in ASP.NET Core 11](/de/2026/07/webapplication-createbuilder-vs-createslimbuilder-vs-createemptybuilder-in-aspnetcore-11/)

## Quellen

- [Use HTTP/3 with the ASP.NET Core Kestrel web server](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/servers/kestrel/http3), Microsoft Learn
- [Configure endpoints for the ASP.NET Core Kestrel web server](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/servers/kestrel/endpoints), Microsoft Learn
- [QUIC support in .NET, platform dependencies](https://learn.microsoft.com/en-us/dotnet/fundamentals/networking/quic/quic-overview#platform-dependencies), Microsoft Learn
- [Use HTTP/3 with HttpClient](https://learn.microsoft.com/en-us/dotnet/core/extensions/httpclient-http3), Microsoft Learn
- [Use ASP.NET Core with HTTP/3 on IIS](https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/iis/http3), Microsoft Learn
- [RFC 9114: HTTP/3](https://www.rfc-editor.org/rfc/rfc9114), IETF
- [RFC 9000: QUIC, a UDP-based multiplexed and secure transport](https://www.rfc-editor.org/rfc/rfc9000), IETF
- [microsoft/msquic](https://github.com/microsoft/msquic), GitHub
