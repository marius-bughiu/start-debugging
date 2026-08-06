---
title: "gRPC vs REST vs SignalR für Service-zu-Service-Aufrufe in .NET 11"
description: "Für interne Service-zu-Service-Aufrufe in .NET 11 ist gRPC die Standardwahl, wenn Sie beide Enden des Vertrags besitzen und der Aufruf Punkt-zu-Punkt ist. Verwenden Sie REST mit JSON, sobald etwas außerhalb Ihrer Kontrolle den Dienst aufrufen muss. SignalR ist kein RPC-Transport zwischen Diensten: Greifen Sie nur dann darauf zurück, wenn ein Produzent eine Nachricht an viele langlebige Konsumenten verteilen muss."
pubDate: 2026-08-06
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "grpc"
  - "signalr"
  - "csharp"
lang: "de"
translationOf: "2026/08/grpc-vs-rest-vs-signalr-for-service-to-service-calls-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-08-06
---

Wenn Dienst A den Dienst B aufruft und sonst nichts B aufruft, verwenden Sie gRPC. Sie besitzen beide Enden, also kosten ein generierter Client und ein binärer Vertrag nichts und bringen eine Nutzlast von etwa der Hälfte der JSON-Entsprechung sowie echte Weitergabe von Deadlines. Verwenden Sie REST mit JSON, sobald etwas außerhalb Ihrer Kontrolle den Dienst aufrufen muss: ein Browser, ein Partner, ein curl-Befehl in einem Runbook. SignalR fällt hier aus dem Rahmen, und der häufigste Fehler in diesem Vergleich besteht darin, es als dritte RPC-Option zu behandeln. Das ist es nicht. SignalR ist eine Schicht für Verbindungsverwaltung und Verteilung, und es verdient seinen Platz nur, wenn ein Produzent an viele langlebige Konsumenten senden muss. Alles Folgende zielt auf .NET 11 (Preview 6, SDK `11.0.100-preview.6.26359.118`, GA erwartet im November 2026) und C# 14, mit `Grpc.AspNetCore` 2.83.0.

## Die Entscheidung in einer Tabelle

| Merkmal | gRPC | REST mit JSON | SignalR |
| --- | --- | --- | --- |
| Form des Aufrufs | Punkt-zu-Punkt-RPC | Punkt-zu-Punkt-Anfrage/Antwort | Ein Produzent, viele Konsumenten |
| Vertrag | Erforderlich, `.proto` | Optional, OpenAPI | Keiner, Methodennamen als Zeichenfolge |
| Protokoll | HTTP/2 (erforderlich) | HTTP/1.1, HTTP/2, HTTP/3 | WebSockets, SSE, Long Polling |
| Nutzlast | Protobuf, binär | JSON, Text | JSON oder MessagePack |
| Client | Aus `.proto` generiert | Handgeschrieben oder aus OpenAPI generiert | Handgeschrieben, Zeichenfolgen für Methodennamen |
| Streaming | Client, Server, bidirektional | Server (chunked / SSE) | Server, Client, bidirektional |
| Abbruch des Aufrufers erreicht den Aufgerufenen | Ja, plus native Deadline | Nur als Verbindungsabbruch | Ja seit .NET 11, Aufrufe ohne Streaming |
| Aus einem Browser aufrufbar | Nein, benötigt gRPC-Web oder Transcoding | Ja | Ja, genau dafür gedacht |
| Funktioniert hinter einem L4-Load-Balancer | Schlecht | Ja | Benötigt Sticky Sessions oder ein Backplane |
| Auf der Leitung menschenlesbar | Nein | Ja | Ja mit JSON, nein mit MessagePack |
| Teil von ASP.NET Core | Nein, separates NuGet-Paket | Ja | Ja |

Zwei Zeilen entscheiden fast jeden realen Fall. "Form des Aufrufs" trennt SignalR von den anderen beiden, und "Vertrag" trennt gRPC von REST. Wenn Sie Zeilen weiter unten in der Tabelle abwägen, haben Sie die Entscheidung wahrscheinlich bereits getroffen und suchen nur noch eine Bestätigung.

## Warum SignalR immer wieder in diesem Vergleich landet, und warum es meist verliert

SignalR taucht in Suchanfragen zur Service-zu-Service-Kommunikation auf, weil eine Hub-Methode genau wie ein RPC aussieht:

```csharp
// .NET 11, C# 14 -- looks like RPC, is not built for it
public sealed class PricingHub : Hub
{
    public Task<decimal> GetPrice(string sku) => _pricing.LookupAsync(sku);
}
```

Ein Aufrufer kann durchaus `InvokeAsync<decimal>("GetPrice", sku)` aus einem anderen Dienst ausführen und eine Antwort erhalten. Es funktioniert. Gebaut haben Sie damit allerdings einen RPC-Kanal auf einer Technologie, deren gesamtes Designzentrum die Verwaltung von Verbindungslebensdauern für Clients ist, die kommen und gehen. Sie erben die Kosten dieses Designs, ohne einen seiner Vorteile zu benötigen.

Die konkreten Kosten: Methodennamen sind Zeichenfolgen, die zum Dispatch-Zeitpunkt per Reflexion aufgelöst werden, eine Umbenennung ist also ein Laufzeitfehler statt eines Build-Fehlers. Es gibt kein Schema, also generiert nichts einen Client und nichts validiert die Form der Nutzlast. Horizontales Skalieren bedeutet, dass jeder Server im Pool jede Verbindung erreichen muss, was ein Redis-Backplane oder den Azure SignalR Service erfordert, plus Sticky Sessions, wenn Sie nicht über WebSockets laufen. Und eine Hub-Verbindung ist zustandsbehaftet: Ihr Aufrufer muss nun über eine Zustandsmaschine für die Wiederverbindung nachdenken, wo vorher eine zustandslose Anfrage stand.

SignalR ist die richtige Antwort, wenn der Verkehr tatsächlich eine Verteilung an viele ist. Ein Preisdienst, der Kursaktualisierungen an vierzig Worker-Prozesse senden muss, ist ein SignalR-Problem, denn SignalR hat Gruppen, Broadcast und ein Backplane, gRPC hingegen keines davon. Microsofts eigener [Vergleich von gRPC und HTTP-APIs](https://learn.microsoft.com/en-us/aspnet/core/grpc/comparison) sagt das direkt: gRPC unterstützt Streaming, kennt aber kein Konzept für das Broadcasten an registrierte Verbindungen, also muss jeder gRPC-Aufruf einzeln an seinen Client streamen.

Die Unterscheidung ist die Verteilung an viele, nicht "Echtzeit". Bidirektionales gRPC-Streaming ist Echtzeit. Es ist nur Punkt-zu-Punkt.

## Was jede Variante tatsächlich auf die Leitung legt

Das Leistungsargument für gRPC wird üblicherweise als "Protobuf ist kleiner als JSON" formuliert, ohne eine Zahl dahinter. Hier ist die Zahl, für eine Nachricht in der Form einer typischen internen Antwort:

```protobuf
// proto3
message OrderStatus {
  string order_id   = 1;  // "8f14e45f-ceea-467a-9c1d-2b7f2f0c3a11"
  int32  status     = 2;  // 3
  int64  updated_at = 3;  // 1786060800
  double total      = 4;  // 129.95
  string currency   = 5;  // "EUR"
}
```

| Kodierung | Nachrichten-Bytes | Bytes mit Framing | Verhältnis zu JSON |
| --- | --- | --- | --- |
| JSON (`System.Text.Json`, Standardoptionen) | 116 | 116 | 100% |
| MessagePack (binäres SignalR-Hub-Protokoll) | 66 | entfällt | 56,9% |
| Protobuf (`Google.Protobuf` 3.35.1) | 60 | 65 | 51,7% |
| Aufruf über das JSON-Hub-Protokoll von SignalR | entfällt | 165 | 142% |

**Methodik**: Jede Kodierung derselben fünf Felder wurde serialisiert und die Bytes gezählt, gemessen unter Windows 11 mit der .NET-Laufzeit 10.0.5 (SDK 10.0.201), `Google.Protobuf` 3.35.1 und `MessagePack` 3.1.8. Die Leitungsformate sind unabhängig von der Laufzeitversion spezifiziert, die Byte-Zahlen sind unter .NET 11 also identisch; nur die kodierende Laufzeit unterscheidet sich. "Bytes mit Framing" ergänzt das Fünf-Byte-Längenpräfix von gRPC (ein Flag-Byte für Komprimierung plus vier Byte Länge in Big-Endian) und, für SignalR, den JSON-Aufrufumschlag plus das Datensatztrennzeichen `0x1E`.

Lesen Sie diese Tabelle genau, bevor Sie damit etwas begründen. Protobuf spart 56 Byte bei einer Nachricht von 116 Byte. Bei einem Dienst mit zehntausend Aufrufen pro Sekunde sind das 560 KB/s ausgehender Verkehr, was zählt, wenn Sie für zonenübergreifenden Verkehr zahlen, und Rauschen ist, wenn nicht. Interessant ist die SignalR-Zeile: Der Umschlag des JSON-Hub-Protokolls macht einen einzelnen Aufruf *größer* als die einfache REST-Entsprechung, weil Sie `type`, `target` und `arguments` zusätzlich zur Nutzlast bezahlen. Ein Wechsel des Hubs auf MessagePack holt den größten Teil davon zurück, auf Kosten der menschlichen Lesbarkeit, die überhaupt der Grund für ein Textprotokoll war.

Die Serialisierungsgröße ist außerdem der schwächste Vorteil von gRPC. Die stärkeren sind der generierte Client und die Deadline.

## Wann gRPC die richtige Wahl ist

- **Intern, Punkt-zu-Punkt, und Sie besitzen beide Repositorys.** Die `.proto`-Datei ist der Vertrag, beide Seiten generieren daraus, und ein umbenanntes Feld bricht den Build auf beiden Seiten im selben Pull Request. Das ist das ganze Argument, und es wiegt mehr als die Byte-Zahl.
- **Sie brauchen Deadlines, die den Aufgerufenen erreichen.** Eine gRPC-Deadline reist mit dem Aufruf, Dienst B weiß also, wie lange Dienst A noch zu warten bereit ist, und kann seine eigene Datenbankabfrage aufgeben. HTTP hat keine Entsprechung: Das Abbrechen einer `HttpClient`-Anfrage bricht die Verbindung ab und der Server sieht `HttpContext.RequestAborted`, aber nichts teilt dem Server das ursprüngliche Zeitbudget mit.
- **Aufrufer in mehreren Sprachen.** Ein Go- oder Python-Dienst, der Ihre `.proto` konsumiert, bekommt kostenlos einen echten Client. Demselben Team ein OpenAPI-Dokument zu geben und viel Glück zu wünschen, ist eine schlechtere Erfahrung.
- **Gesprächige heiße Pfade.** Sobald ein bidirektionaler Stream offen ist, laufen Nachrichten über eine bestehende HTTP/2-Anfrage, statt für jeden Aufruf eine neue zu bezahlen. Microsofts [Leitfaden zur gRPC-Leistung](https://learn.microsoft.com/en-us/aspnet/core/grpc/performance) empfiehlt das ausdrücklich als fortgeschrittene Technik für Pfade mit hohem Durchsatz, mit dem Vorbehalt, dass `RequestStream.WriteAsync` nicht threadsicher ist und Sie einen `Channel<T>` brauchen, um Schreibvorgänge zu ordnen.

```csharp
// .NET 11, C# 14 -- Grpc.AspNetCore 2.83.0
// Server
builder.Services.AddGrpc();
app.MapGrpcService<OrderService>();

// Client: register through the factory so channels are reused.
builder.Services
    .AddGrpcClient<Orders.OrdersClient>(o => o.Address = new Uri("https://orders"))
    .AddStandardResilienceHandler();

// Call site: the deadline is the point.
var reply = await client.GetStatusAsync(
    new OrderRequest { OrderId = id },
    deadline: DateTime.UtcNow.AddSeconds(2),
    cancellationToken: ct);
```

Verwenden Sie im Anwendungscode `AddGrpcClient` statt `GrpcChannel.ForAddress`. Ein Kanal pro Aufruf erzwingt jedes Mal einen neuen Socket, einen TCP-Handshake, eine TLS-Aushandlung und eine HTTP/2-Verbindungspräambel, während die Factory den Kanal für Sie wiederverwendet. Wenn Sie Wiederholungsversuche darüberlegen, gilt hier derselbe [Resilience-Handler, der HttpClient umschließt](/de/2026/05/polly-vs-resilience-handlers-in-dotnet-11/), denn ein gRPC-Kanal ist darunter ein `SocketsHttpHandler`.

## Wann REST mit JSON die richtige Wahl ist

- **Etwas ruft den Dienst auf, für das Sie keinen Client neu generieren können.** Browser sprechen gRPC überhaupt nicht, und gRPC-Web wie auch JSON-Transcoding sind echte Erweiterungen Ihrer Deployment-Topologie. Wenn die Antwort auf "wer ruft das auf" jemanden außerhalb Ihres Builds einschließt, liefern Sie JSON aus.
- **Der Aufruf ist selten.** Ein nächtlicher Abgleichjob, der einen Endpunkt aufruft, rechtfertigt keine `.proto`-Datei, keinen Codegenerierungsschritt in CI und kein zweites Protokoll in Ihrem Service Mesh.
- **Sie wollen mit den Werkzeugen debuggen, die Sie schon haben.** Protobuf auf der Leitung ist ohne Schema undurchsichtig. Ein 500er um 3 Uhr morgens lässt sich leichter diagnostizieren, wenn Sie die Anfrage mit curl wiederholen können.
- **Ihr Load-Balancer arbeitet auf L4.** Das ist keine Vorliebe, und es wird weiter unten behandelt.

```csharp
// .NET 11, C# 14 -- minimal API + typed client
app.MapGet("/orders/{id}", async (string id, IOrderStore store, CancellationToken ct)
    => await store.FindAsync(id, ct) is { } o
        ? Results.Ok(o)
        : Results.NotFound());

// Caller
builder.Services
    .AddHttpClient<OrdersClient>(c => c.BaseAddress = new Uri("https://orders"))
    .AddStandardResilienceHandler();
```

Für etwas Strukturierteres liefert [die Rückgabe einer typisierten Results-Union](/de/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/) eine Prüfung der Antwortformen zur Kompilierzeit und ein korrektes OpenAPI-Dokument ohne handgeschriebene Attribute, was einen Teil der Vertragsdisziplin zurückholt, die gRPC attraktiv machte.

## Wann SignalR wirklich richtig ist

- **Ein Produzent, viele langlebige Konsumenten, und jeder Konsument braucht dieselbe Nachricht.** Kursticks, Zustand einer Job-Warteschlange, Invalidierung von Konfiguration. Gruppen und Broadcast sind die Funktionen, die Sie kaufen.
- **Die Menge der Konsumenten ändert sich zur Laufzeit.** SignalR behandelt Verbinden, Trennen und Wiederverbinden. Das auf gRPC-Streams nachzubauen ist ein eigenes Projekt.
- **Einige der Konsumenten sind Browser.** Wenn ein Dashboard und eine Reihe von Worker-Diensten denselben Feed brauchen, bedient ein Hub beide, und keine gRPC-Konfiguration bedient den Browser ohne Proxy.

.NET 11 verbessert SignalR für langlebige Verbindungen in zwei Punkten deutlich. Der `/refresh`-Endpunkt zusammen mit `EnableAuthenticationRefresh` sorgt dafür, dass eine Hub-Verbindung nicht mehr abbricht, wenn ihr Bearer-Token abläuft, was die größte einzelne Quelle unnötiger Wiederverbindungen in tokenauthentifizierten Deployments war. Und [SignalR-Clients können endlich eine laufende Hub-Methode abbrechen](/de/2026/07/signalr-client-cancel-hub-method-dotnet-11-preview-6/), das Abbrechen des an `InvokeAsync` übergebenen `CancellationToken` erreicht also tatsächlich den Server. Beide Funktionen gelten in Preview 6 nur für den .NET-Client; die Unterstützung für den JavaScript-Client und den Azure SignalR Service ist noch in Arbeit.

## Die Details, die für Sie entscheiden

**L4-Load-Balancer brechen gRPC.** Ein gRPC-Kanal ist eine HTTP/2-Verbindung, und jeder Aufruf wird darüber gemultiplext. Ein L4-Balancer verteilt TCP-Verbindungen, jeder Aufruf dieses Kanals landet also dauerhaft auf demselben Backend. Ihre Flotte bekommt eine heiße Instanz und viele im Leerlauf. Die Behebung bedeutet clientseitiges Load-Balancing oder einen L7-Proxy wie Envoy, Linkerd oder YARP, und diese Entscheidung gehört meist einem Plattformteam und nicht Ihnen. Wenn Sie diese Änderung nicht durchsetzen können, ist der Vergleich beendet und REST gewinnt. Dieselbe Art von Infrastrukturreibung zeigt sich beim [Betrieb von gRPC in Containern](/de/2026/01/grpc-in-containers-feels-hard-in-net-9-and-net-10-4-traps-you-can-fix/), wo ein Proxy, der nur HTTP/1.1 spricht, Fehler erzeugt, die nichts nach einer Protokollabweichung aussehen.

**gRPC erscheint außerhalb des .NET-Zyklus, und die TFM-Liste beweist es.** `Grpc.AspNetCore` 2.83.0, veröffentlicht am 2026-08-03, zielt auf `net8.0`, `net9.0` und `net10.0`. Es gibt kein Target Framework `net11.0`, und in den Release Notes [Neues in ASP.NET Core in .NET 11](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-11) gibt es überhaupt keinen Abschnitt zu gRPC. Das ist keine Support-Lücke: Eine `net10.0`-Assembly wird unter .NET 11 geladen und ausgeführt. Es ist ein Unterschied in der Taktung. gRPC auf .NET wird in `grpc/grpc-dotnet` mit eigenem Veröffentlichungsplan gepflegt, eine .NET-11-Funktion, die gRPC nützen würde, kommt also dann, wenn grpc-dotnet sie ausliefert, und nicht im November. Planen Sie Ihre Upgrade-Notizen entsprechend.

**HTTP/2 ist für gRPC Pflicht und für alles andere optional.** Das ist eine echte Einschränkung auf jedem Abschnitt, auf dem Sie die Zwischenstationen nicht kontrollieren. Es bedeutet auch, dass gRPC heute nicht von HTTP/3 profitiert, ein REST-Endpunkt hingegen schon: [Kestrel für HTTP/3 zu konfigurieren](/de/2026/08/how-to-configure-kestrel-to-serve-http-3-in-aspnetcore-11/) ist eine einzeilige Änderung am Endpunkt, und Kestrel in .NET 11 beginnt nun mit der Verarbeitung von HTTP/3-Anfragen, ohne auf den Control Stream und den SETTINGS-Frame zu warten, was die Latenz der ersten Anfrage auf neuen Verbindungen senkt.

**Die Skalierung von SignalR ist eine Abhängigkeit, keine Einstellung.** Mehr als eine Serverinstanz bedeutet ein Redis-Backplane oder den Azure SignalR Service, und Transporte außer WebSocket brauchen zusätzlich Sticky Sessions. Vergleichen Sie das mit einem zustandslosen REST-Endpunkt hinter einem Round-Robin-Balancer, bevor Sie entscheiden, dass die Verteilung an viele es wert ist.

**Die Beobachtbarkeit ist nicht gleich.** Alle drei geben `ActivitySource`-Traces aus, die durch OpenTelemetry fließen, [Traces an ein kostenloses Backend anzubinden](/de/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) deckt also alle ab. Der Unterschied liegt darin, was Sie in einem Netzwerkmitschnitt sehen: JSON ist lesbar, Protobuf und MessagePack brauchen das Schema und passende Werkzeuge.

## Die Empfehlung, noch einmal

Ziehen Sie die Grenze zuerst bei der Verteilung an viele. Wenn ein Dienst viele langlebige Konsumenten benachrichtigen muss, ist das SignalR, und keine der anderen beiden Optionen ersetzt Gruppen und ein Backplane. Alles andere ist Punkt-zu-Punkt, und dort lautet die Frage, wem der Vertrag gehört. Wenn Sie beide Enden besitzen und Clients im selben Pull Request neu generieren können, der das Schema ändert, zahlt sich gRPC über den generierten Client und die weitergegebenen Deadlines aus, mit der kleineren Nutzlast als Zugabe statt als Grund. Wenn jemand außerhalb Ihres Builds den Dienst aufruft, liefern Sie REST mit JSON aus und hören Sie auf, Bytes zu optimieren, für die Sie nicht bezahlen.

Der Fehlermodus, den es zu vermeiden gilt: gRPC für einen Dienst mit drei Aufrufen pro Minute zu wählen, weil ein Benchmark 51,7% Nutzlastgröße zeigte, und dann festzustellen, dass Ihr L4-Load-Balancer jeden Aufruf auf einen Pod festnagelt. Sechsundfünfzig Byte pro Nachricht sind keine Plattformmigration wert.

## Verwandte Artikel

- [gRPC in Containern fühlt sich in .NET 9 und .NET 10 schwer an: 4 Fallen, die Sie beheben können](/de/2026/01/grpc-in-containers-feels-hard-in-net-9-and-net-10-4-traps-you-can-fix/)
- [SignalR-Clients können in .NET 11 Preview 6 endlich eine laufende Hub-Methode abbrechen](/de/2026/07/signalr-client-cancel-hub-method-dotnet-11-preview-6/)
- [Kestrel für HTTP/3 in ASP.NET Core 11 konfigurieren](/de/2026/08/how-to-configure-kestrel-to-serve-http-3-in-aspnetcore-11/)
- [Polly vs Resilience-Handler in .NET 11: was sollten Sie verwenden?](/de/2026/05/polly-vs-resilience-handlers-in-dotnet-11/)
- [Minimal APIs vs Controller in ASP.NET Core 11](/de/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)
- [OpenTelemetry mit .NET 11 und einem kostenlosen Backend verwenden](/de/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/)

## Quellen

- [Compare gRPC services with HTTP APIs](https://learn.microsoft.com/en-us/aspnet/core/grpc/comparison), Microsoft Learn
- [Performance best practices with gRPC](https://learn.microsoft.com/en-us/aspnet/core/grpc/performance), Microsoft Learn
- [Overview of ASP.NET Core SignalR](https://learn.microsoft.com/en-us/aspnet/core/signalr/introduction), Microsoft Learn
- [What's new in ASP.NET Core in .NET 11](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-11), Microsoft Learn
- [Grpc.AspNetCore 2.83.0](https://www.nuget.org/packages/Grpc.AspNetCore), NuGet
- [SignalR Hub Protocol specification](https://github.com/dotnet/aspnetcore/blob/main/src/SignalR/docs/specs/HubProtocol.md), dotnet/aspnetcore
- [gRPC over HTTP/2 protocol specification](https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md), grpc/grpc
