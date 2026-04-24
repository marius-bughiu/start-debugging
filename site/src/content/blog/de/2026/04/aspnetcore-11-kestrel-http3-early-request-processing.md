---
title: "Kestrel beginnt mit der Verarbeitung von HTTP/3-Requests vor dem SETTINGS-Frame in .NET 11 Preview 3"
description: ".NET 11 Preview 3 lässt Kestrel HTTP/3-Requests bedienen, bevor der Control Stream und der SETTINGS-Frame des Peers ankommen, und reduziert so die Handshake-Latenz beim ersten Request jeder neuen QUIC-Verbindung."
pubDate: 2026-04-20
tags:
  - ".NET 11"
  - "ASP.NET Core"
  - "Kestrel"
  - "HTTP/3"
  - "Performance"
lang: "de"
translationOf: "2026/04/aspnetcore-11-kestrel-http3-early-request-processing"
translatedBy: "claude"
translationDate: 2026-04-24
---

Einer der kleinen, aber sichtbaren Gewinne in der [.NET 11 Preview 3 Ankündigung](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/) ist eine Kestrel-Änderung für HTTP/3: Der Server wartet nicht mehr darauf, dass der Control Stream des Clients und der SETTINGS-Frame eintreffen, bevor er mit der Verarbeitung von Requests beginnt. Die Änderung ist in [dotnet/aspnetcore #65399](https://github.com/dotnet/aspnetcore/pull/65399) gelandet und zielt auf die First-Request-Latenz auf brandneuen QUIC-Verbindungen ab, was genau dort ist, wo HTTP/3 gegenüber einer bereits warmen HTTP/2-Verbindung Boden verlor.

## Was der HTTP/3-Handshake Sie früher gekostet hat

HTTP/3 läuft über QUIC, also ist der Transport-Handshake (TLS 1.3 + QUIC) bereits in den Verbindungs-Setup eingefaltet. Darüber hinaus definiert das Protokoll einen unidirektionalen Control Stream, auf dem jede Seite zuerst einen `SETTINGS`-Frame sendet. Diese Settings annoncieren Dinge wie `SETTINGS_QPACK_MAX_TABLE_CAPACITY`, `SETTINGS_QPACK_BLOCKED_STREAMS` und `SETTINGS_MAX_FIELD_SECTION_SIZE`. Kestrel hat zuvor die Request-Verarbeitungs-Pipeline auf diesem ersten Peer-Frame blockiert. In der Praxis hieß das, eine neue Verbindung musste nach dem QUIC-Handshake einen zusätzlichen logischen Roundtrip warten, bevor Ihre `Map*`-Handler liefen, obwohl der Client bereits einen `HEADERS`-Frame auf einem Request-Stream 0-RTT'd hatte.

Sie sehen das Symptom, wenn Sie das Connection-Trace mit `Logging__LogLevel__Microsoft.AspNetCore.Server.Kestrel=Trace` dumpen:

```text
Connection id "0HN7..." accepted (HTTP/3).
Stream id "0" started (control).
Waiting for SETTINGS frame from peer.
Stream id "4" started (request).  <-- request arrived, but not dispatched yet
SETTINGS frame received.
Dispatching request on stream id "4".
```

Diese `Waiting for SETTINGS frame`-Lücke skaliert mit dem Peer-RTT, nicht mit der Server-Arbeit.

## Was Preview 3 ändert

In Preview 3 dispatched Kestrel Request-Streams, sobald sie ankommen, und wendet die Peer-Settings an, sobald der Control Stream aufholt. Die Spezifikation erlaubt das: RFC 9114 Abschnitt 6.2.1 erlaubt Implementierungen, mit der Verarbeitung von Frames auf Request-Streams parallel zum Control-Stream-Handshake zu beginnen, solange sie Settings retroaktiv für alles erzwingen, was sich noch nicht zu einer Wire-Entscheidung committed hat.

An Ihrem Handler-Level ändert sich nichts, dieselbe Minimal-API funktioniert weiterhin:

```csharp
var builder = WebApplication.CreateBuilder(args);

builder.WebHost.ConfigureKestrel(o =>
{
    o.ListenAnyIP(5001, listen =>
    {
        listen.Protocols = HttpProtocols.Http1AndHttp2AndHttp3;
        listen.UseHttps();
    });
});

var app = builder.Build();

app.MapGet("/ping", () => Results.Ok(new { ok = true, proto = "h3" }));

app.Run();
```

Der Preview-3-Effekt liegt auf der Leitung: Der `HEADERS`-Frame auf Stream 4 oben wird jetzt sofort dispatched, und der `SETTINGS`-Frame wird auf alle QPACK-codierten Felder angewendet, die noch nicht decodiert wurden. Für einen einfachen `GET /ping`, der keine dynamischen Tabellenreferenzen sendet, wird der Request abgeschlossen, ohne jemals auf den Control Stream zu warten.

## Was Sie auf Ihrer Seite verifizieren sollten

Zwei Caveats sind es wert, geprüft zu werden, bevor Sie sich auf das neue Verhalten verlassen.

Erstens, wenn Sie große Response-Header senden, respektiert Kestrel weiterhin das finale `SETTINGS_MAX_FIELD_SECTION_SIZE` des Peers, bevor es den `HEADERS`-Frame zurück serialisiert. Wenn der Peer noch keine SETTINGS gesendet hat, gilt der Default in [RFC 9114](https://www.rfc-editor.org/rfc/rfc9114#name-settings) (unbegrenzt), was bedeutet, dass Ihre Antwort später dennoch abgelehnt werden kann, wenn das tatsächliche Peer-Setting kleiner ist. Halten Sie Response-Header beim ersten Request einer Verbindung klein.

Zweitens sollte alles, was als Time-to-First-Byte auf einer neuen QUIC-Session gemessen wird, spürbar sinken. Ein enger lokaler Benchmark über Loopback mit künstlicher 50ms-Peer-Latenz zeigte den ersten Request von ungefähr `2 * RTT + server_time` auf `1 * RTT + server_time` fallen. Folge-Requests auf derselben Verbindung waren vor Preview 3 bereits unbeeinflusst und bleiben es jetzt.

Wenn Sie HTTP/3 hinter YARP oder einem API Gateway betreiben, stellen Sie sicher, dass Sie Ende-zu-Ende auf einen .NET 11 Preview 3 Build upgraden; der Gewinn liegt auf der Kestrel-Seite des QUIC-Hops, also ist der Reverse Proxy der Ort, an dem Sie ihn sehen werden. Der vollständige Satz an HTTP/3- und Kestrel-Notes für dieses Preview lebt in den [ASP.NET Core Release Notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/aspnetcore.md).
