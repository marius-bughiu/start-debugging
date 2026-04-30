---
title: "gRPC in Containern wirkt unter .NET 9 und .NET 10 schwer: 4 Fallen, die Sie beheben können"
description: "Vier verbreitete Fallen beim Hosten von gRPC in Containern mit .NET 9 und .NET 10: HTTP/2-Protokollkonflikte, unklare TLS-Terminierung, kaputte Health Checks und falsch konfigurierte Proxies -- mit Lösungen für jede."
pubDate: 2026-01-10
tags:
  - "grpc"
  - "dotnet"
  - "dotnet-10"
  - "dotnet-9"
lang: "de"
translationOf: "2026/01/grpc-in-containers-feels-hard-in-net-9-and-net-10-4-traps-you-can-fix"
translatedBy: "claude"
translationDate: 2026-04-30
---
Heute ist es wieder in r/dotnet aufgetaucht: "Warum ist das Hosten von gRPC-Diensten in Containern so schwer?". Die kurze Antwort: gRPC ist sehr meinungsstark, was HTTP/2 angeht, und Container machen den Netzwerkrand expliziter. Sie müssen entscheiden, wo TLS terminiert, welche Ports HTTP/2 sprechen und welcher Proxy davorsteht.

Ursprüngliche Diskussion: [https://www.reddit.com/r/dotnet/comments/1q93h2h/why_is_hosting_grpc_services_in_containers_so_hard/](https://www.reddit.com/r/dotnet/comments/1q93h2h/why_is_hosting_grpc_services_in_containers_so_hard/)

## Falle 1: Der Container-Port ist erreichbar, spricht aber kein HTTP/2

gRPC verlangt HTTP/2 von Ende zu Ende. Wenn ein Proxy auf HTTP/1.1 herabstuft, erhalten Sie mysteriöse "unavailable"-Fehler, die wie Anwendungsbugs aussehen.

In .NET 9 / .NET 10 machen Sie die Absicht des Servers explizit:

```cs
using Microsoft.AspNetCore.Server.Kestrel.Core;

var builder = WebApplication.CreateBuilder(args);

builder.WebHost.ConfigureKestrel(options =>
{
    // Inside a container you usually run plaintext HTTP/2 and terminate TLS at the proxy.
    options.ListenAnyIP(8080, listen =>
    {
        listen.Protocols = HttpProtocols.Http2;
    });
});

builder.Services.AddGrpc();

var app = builder.Build();
app.MapGrpcService<GreeterService>();
app.MapGet("/", () => "gRPC service. Use a gRPC client.");
app.Run();
```

## Falle 2: Die TLS-Terminierung ist unklar (und gRPC-Clients ist das nicht egal)

Viele Teams nehmen an: "Container = TLS". In der Praxis ist es einfacher, TLS am Rand zu terminieren:

-   **Kestrel**: HTTP/2 ohne TLS auf `8080` innerhalb des Clusters laufen lassen.
-   **Ingress / Reverse Proxy**: TLS terminieren und per HTTP/2 an den Dienst weiterleiten.

Wenn Sie TLS in Kestrel terminieren, brauchen Sie auch Zertifikate im Container und müssen den richtigen Port freigeben. Das geht, sind nur mehr bewegliche Teile.

## Falle 3: Health Checks prüfen das Falsche

HTTP-Probes von Kubernetes und einfache Load-Balancer-Probes sind oft HTTP/1.1. Wenn Sie Ihren gRPC-Endpunkt direkt sondieren, kann er fehlschlagen, obwohl der Dienst gesund ist.

Zwei praktische Lösungen:

-   **Stellen Sie einen einfachen HTTP-Endpunkt** für Probes bereit (wie das `MapGet("/")` oben), auf einem separaten Port oder auf demselben Port, falls der Proxy das unterstützt.
-   **Verwenden Sie gRPC-Health-Checking** (`grpc.health.v1.Health`), wenn Ihre Umgebung gRPC-bewusste Probes unterstützt.

## Falle 4: Proxies und HTTP/2-Defaults beißen Sie

Der einfachste Weg, gRPC "schwer" wirken zu lassen, ist, einen Proxy davorzustellen, der nicht für HTTP/2 zum Upstream konfiguriert ist. Stellen Sie sicher, dass Ihr Proxy explizit so konfiguriert ist, dass er:

-   HTTP/2 von Clients akzeptiert
-   HTTP/2 an den Upstream-Dienst weiterleitet (nicht nur HTTP/1.1)

Der letzte Punkt ist die Stelle, an der viele Standard-Nginx-Konfigurationen für gRPC scheitern.

## Eine Container-Konfiguration, die langweilig bleibt

-   **Container**: lauscht auf `8080` mit `HttpProtocols.Http2`.
-   **Proxy/Ingress**: terminiert TLS auf `443` und spricht HTTP/2 mit Client und Upstream.
-   **Observability**: aktiviert strukturierte Logs für fehlgeschlagene Anfragen und schreibt die gRPC-Statuscodes mit.

Wenn Sie einen einzigen Referenzpunkt wollen, bevor Sie Kubernetes anfassen: validieren Sie zuerst lokal. Container starten, mit `grpcurl` darauf zugreifen, dann einen Proxy davorsetzen und prüfen, ob HTTP/2 weiterhin Ende zu Ende ausgehandelt wird.

Weiterführend: [https://learn.microsoft.com/aspnet/core/grpc/](https://learn.microsoft.com/aspnet/core/grpc/)
