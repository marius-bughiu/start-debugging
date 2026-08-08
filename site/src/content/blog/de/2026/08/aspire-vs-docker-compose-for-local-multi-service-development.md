---
title: "Aspire vs Docker Compose für die lokale Entwicklung mit mehreren Services"
description: "Aspire 13.4.6 gewinnt die .NET-Inner-Loop, weil es Ihre Projekte als Host-Prozesse ausführt, die Sie debuggen können, während Docker Compose gewinnt, wenn die Compose-Datei zugleich Ihr CI- und Bereitstellungsvertrag ist. Gemessene Start- und Edit-bis-Ausführung-Zeiten für beide, die Konfiguration, die jedes Werkzeug für Sie injiziert, und die sechs Fallstricke, die die Entscheidung treffen."
pubDate: 2026-08-08
template: vs
tags:
  - "comparison"
  - "aspire"
  - "docker"
  - "dotnet"
  - "devops"
lang: "de"
translationOf: "2026/08/aspire-vs-docker-compose-for-local-multi-service-development"
translatedBy: "claude"
translationDate: 2026-08-08
---

Wählen Sie Aspire, wenn die Services, die Sie lokal ausführen, .NET-Projekte sind, die Sie aus dem Quellcode kompilieren: Es führt sie als gewöhnliche Host-Prozesse aus, sodass sich ein Debugger an alle gleichzeitig anhängt, und es injiziert Verbindungszeichenfolgen und OpenTelemetry-Konfiguration, die Sie sonst von Hand schreiben würden. Wählen Sie Docker Compose, wenn Ihre `docker-compose.yaml` zugleich Ihr CI-, Staging- oder Produktionsvertrag ist, oder wenn Ihr Stack überwiegend aus fertigen Images besteht, die Sie nicht selbst schreiben. Sie müssen sich nicht entscheiden: `aspire publish` erzeugt eine Compose-Datei aus demselben Modell. Alle Zahlen und APIs unten stammen von Aspire 13.4.6 (der aktuellen stabilen Version, veröffentlicht am 2026-06-20) und Docker Compose v5.1.4 auf .NET 10.

Eine Anmerkung zum Namen: Das Produkt hat mit Aspire 13 im November 2025 das Präfix ".NET" abgelegt, ".NET Aspire" und "Aspire" bezeichnen also dasselbe, und der Schritt `dotnet workload install aspire` ist seit Aspire 9.0 verschwunden.

## Die Matrix

| | Aspire 13.4.6 | Docker Compose v5.1.4 |
| --- | --- | --- |
| Konfigurationsformat | C# oder TypeScript | YAML |
| Wie Ihr eigener .NET-Service läuft | Host-Prozess, gestartet von DCP | Container, kompiliert aus einem Dockerfile |
| Debugger anhängen | F5 über alle Projekte gleichzeitig | Remote-Debugger, pro Service konfiguriert |
| Verbindungszeichenfolgen | injiziert als `ConnectionStrings__<name>` | schreiben Sie selbst |
| URLs zwischen Services | injiziert als `services__<name>__<scheme>__0` | Container-DNS über den Servicenamen |
| Telemetrie | OTLP-Endpunkt plus Dashboard, ohne Konfiguration | keine |
| Startreihenfolge | `WaitFor()` plus Health Checks | `depends_on` mit `condition: service_healthy` |
| Eigene Netzwerke | kein Äquivalent | `networks:` |
| CPU- und Speichergrenzen | nicht modelliert | `deploy.resources` |
| Containernamen | zufälliges Suffix (`cache-mmsmckhq`) | deterministisch (`<project>-cache-1`) |
| Ist es Ihr Bereitstellungsartefakt? | nein, der AppHost existiert nur zur Entwicklungszeit | häufig ja |
| Services, die nicht .NET sind | Node, Bun, Python, Go oder ein beliebiger Container | jeder Container |

## Was jedes Werkzeug tatsächlich startet

Das ist der Unterschied, aus dem alles andere folgt. Compose startet Container, Punkt. Jeder Service in der Datei, auch der, den Sie gerade bearbeiten, ist ein Image, das kompiliert werden muss, bevor es laufen kann.

Der AppHost von Aspire startet eine Mischung. Alles, was Sie mit `AddProject<T>` deklariert haben, läuft als gewöhnlicher Prozess auf Ihrem Rechner unter der Developer Control Plane; nur die Dinge, die Sie nicht selbst geschrieben haben, deklariert mit `AddContainer`, `AddRedis`, `AddPostgres` und Verwandten, werden zu Containern. Man sieht das in `docker ps`, während die Anwendung läuft:

```
NAMES              IMAGE
cache-mmsmckhq     redis:8.6
```

Das ist die vollständige Containerliste für eine Anwendung mit zwei Services. Die API ist ein `dotnet`-Prozess, und deshalb können Visual Studio und Rider einen Haltepunkt darin setzen, ohne dass irgendein Remote-Debugging eingerichtet werden muss, und deshalb ist Docker an einer Neukompilierung überhaupt nicht beteiligt.

## Derselbe Stack, zweimal geschrieben

Eine Minimal API plus Redis. Zuerst die Compose-Variante:

```yaml
# docker-compose.yaml -- Docker Compose v5.1.4
services:
  cache:
    image: redis:8.2
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 2s
      retries: 15

  api:
    build:
      context: .
      dockerfile: Dockerfile
    environment:
      - ConnectionStrings__cache=cache:6379
    ports:
      - "8080:8080"
    depends_on:
      cache:
        condition: service_healthy
```

Dazu ein Dockerfile, das nicht optional ist und hier nicht gezeigt wird. Nun die Aspire-Variante, die gesamte Datei:

```csharp
// AppHost/AppHost.cs -- Aspire 13.4.6, .NET 10
var builder = DistributedApplication.CreateBuilder(args);

var cache = builder.AddRedis("cache");

builder.AddProject<Projects.Api>("api")
       .WithHttpEndpoint(port: 8080, name: "public")
       .WithReference(cache)
       .WaitFor(cache);

builder.Build().Run();
```

Die Projektdatei enthält drei Zeilen interessanten Inhalt, und beachten Sie, dass das Template von 13.4.6 das SDK nun in das Attribut `Sdk` schreibt statt in ein verschachteltes `<Sdk>`-Element:

```xml
<!-- AppHost/AppHost.csproj -- Aspire 13.4.6 -->
<Project Sdk="Aspire.AppHost.Sdk/13.4.6">
  <ItemGroup>
    <ProjectReference Include="..\Api\Api.csproj" />
  </ItemGroup>
  <ItemGroup>
    <PackageReference Include="Aspire.Hosting.Redis" Version="13.4.6" />
  </ItemGroup>
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>
```

Beide Stacks führen dasselbe `Program.cs` aus, das `ConnectionStrings:cache` aus der Konfiguration liest. Unter Compose haben Sie diesen Wert selbst geliefert. Unter Aspire nicht.

## Was Aspire in Ihren Prozess schreibt

Ich habe einen Debug-Endpunkt ergänzt, der die interessanten Umgebungsvariablen ausgibt, und dann den AppHost ausgeführt. Das hat der API-Prozess ohne eine einzige Zeile Konfiguration meinerseits erhalten:

```
ASPNETCORE_URLS=https://localhost:61681;http://localhost:61682;http://localhost:61683
ConnectionStrings__cache=localhost:58390,password=T9bjFegjra6EBk5HG3M9uq
OTEL_EXPORTER_OTLP_ENDPOINT=https://localhost:21089
OTEL_EXPORTER_OTLP_HEADERS=x-otlp-api-key=566b726e1f4c36c1b4e0474e80db9cd5
OTEL_EXPORTER_OTLP_PROTOCOL=grpc
OTEL_METRIC_EXPORT_INTERVAL=1000
OTEL_SERVICE_NAME=api
OTEL_TRACES_SAMPLER=always_on
```

Zwei Dinge fallen auf. Aspire hat ein Passwort für Redis erzeugt und in die Verbindungszeichenfolge geschrieben, der lokale Cache liegt also nicht ohne Authentifizierung auf einem bekannten Port, wie es bei `redis:8.2` in einer Compose-Datei der Fall ist. Und der OTLP-Block sorgt dafür, dass Traces und Metriken kostenlos im Dashboard erscheinen; wer dasselbe unter Compose will, stellt einen Collector auf und verdrahtet Exporter selbst, was einen eigenen Artikel füllt: [OpenTelemetry mit .NET 11 und einem kostenlosen Backend](/de/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/).

Bei Referenzen zwischen Projekten lautet die injizierte Variable `services__<name>__<scheme>__0`, zum Beispiel `services__basket__https__0`, und die Service Discovery von .NET löst `https://basket` darüber auf.

## Die Messungen

Gleicher Rechner, gleiche Anwendung, gleiches Redis: ein Intel Core Ultra 7 265KF (20 Kerne), 32 GB RAM, Windows 11 Pro 26200, Docker 29.5.3 mit Compose v5.1.4, .NET SDK 10.0.201, Aspire CLI 13.4.6. Die Basis-Images wurden vor der Messung heruntergeladen, keine Messung enthält also einen Download aus der Registry. Gemessen wird die Wanduhrzeit vom Start des Befehls bis ein HTTP-GET auf die Anwendung den frisch kompilierten Code zurückgibt, mit Abfrage alle 250 ms. Die Änderung ist eine einzeilige Änderung an einem Zeichenfolgenliteral in `Program.cs`, und jede Runde verwendet einen neuen Wert, damit nichts aus einem Cache ausgeliefert werden kann.

| Szenario | Aspire 13.4.6 | Docker Compose v5.1.4 |
| --- | --- | --- |
| Kaltstart: nichts kompiliert, Stack läuft und antwortet | 15,5 s (`dotnet clean`, dann `aspire run`) | 10,8 s (7,0 s `build --no-cache` plus 3,8 s `up`) |
| Einzeilige C#-Änderung bis zur Auslieferung des neuen Codes | 14,6 / 13,9 / 11,0 s, Median 13,9 s | 5,4 / 5,6 / 5,3 s, Median 5,4 s |

Docker Compose hat jede Zeile gewonnen, und das beschönige ich nicht. Es lohnt sich zu verstehen, warum, bevor Sie daraus eine Schlussfolgerung ziehen.

Die Compose-Schleife ist hier ein dreisekündiger inkrementeller `docker build` (die Restore-Schicht liegt im Cache, nur `COPY` und `dotnet publish` laufen erneut) plus das Neuerstellen des Containers, bei einer Anwendung, deren veröffentlichte Ausgabe etwa zehn Kilobyte meines Codes umfasst. Die Aspire-Schleife besteht aus `aspire resource api stop`, einem vollständigen MSBuild-Aufruf und `aspire resource api start`, und der Startaufwand von MSBuild selbst dominiert bei einem derart kleinen Projekt. Die Zahl von Compose wächst mit der Größe der Image-Schicht, die neu gebaut wird; die von Aspire wächst mit dem MSBuild-Graphen. Wo sich diese Kurven schneiden, habe ich nicht gemessen, also behaupte ich auch keinen Schnittpunkt.

Der gewichtigere Vorbehalt ist, dass die Aspire-Zeile mit der CLI gemessen wurde, und die CLI ist nicht die Art, wie die meisten Aspire nutzen. In Visual Studio oder Rider besteht die Schleife aus F5 plus Hot Reload, was den laufenden Prozess patcht und gar nicht neu kompiliert. Für einen containerisierten Service gibt es dafür kein Äquivalent: `docker compose watch` synchronisiert Dateien oder baut das Image neu, es patcht keinen laufenden Prozess. Lesen Sie die Tabelle also als obere Schranke für die Inner Loop von Aspire und als faires Maß für die von Compose.

## Wann Docker Compose die richtige Antwort ist

- **Die Compose-Datei ist ein Liefergegenstand.** Wenn die CI dasselbe YAML hochfährt, wenn eine QA-Maschine es ausführt, wenn Ihr Bereitschafts-Runbook `docker compose up` sagt, dann ist Compose nicht nur ein Entwicklungswerkzeug, und es durch einen AppHost zu ersetzen bedeutet, zwei Beschreibungen desselben Systems zu pflegen.
- **Sie kompilieren die Services überwiegend nicht selbst.** Ein Stack aus Kafka, MinIO, Keycloak und einem Postgres mit drei Initialisierungsskripten ist ein Stack aus Images. Aspire modelliert das ebenfalls als Container, aber Sie bezahlen dann eine C#-Abstraktion über Dinge, die als YAML bereits in Ordnung waren.
- **Sie brauchen Netzwerke oder Ressourcengrenzen.** Aspire hat kein Äquivalent für eigene Netzwerkisolation; jede Ressource ist über den Namen erreichbar. Wenn Sie testen, was passiert, wenn Service A Service B tatsächlich nicht erreichen kann, oder wenn Sie `deploy.resources` benötigen, um einen Container auf eine CPU zu begrenzen, dann leistet Compose das und Aspire nicht.
- **Ihr Team arbeitet nicht .NET-zuerst.** Aspire 13.4 hat TypeScript-AppHosts allgemein verfügbar gemacht und `AddGoApp` sowie `AddBunApp` ergänzt, das trifft also weniger zu als noch vor einem Jahr, aber Dokumentation, Beispiele und der Integrationskatalog sind weiterhin auf .NET ausgerichtet.

## Wann Aspire die richtige Antwort ist

- **Sie debuggen mehr als einen Service gleichzeitig.** Das ist der mit Abstand wichtigste Grund. Haltepunkte in der API und im Worker mit einem einzigen F5, ohne `docker-compose.debug.yml`, ohne `vsdbg` im Image, ohne Port-Jonglage.
- **Ihr Entwicklungs-Stack enthält Backing Services mit heikler Konfiguration.** `AddPostgres("db").AddDatabase("orders")` liefert einen Container, ein erzeugtes Passwort, eine Verbindungszeichenfolge im korrekten .NET-Format und einen über Health Checks abgesicherten Start. Das Compose-Äquivalent sind fünfzehn Zeilen und eine `.env`-Datei.
- **Sie wollen Telemetrie in der Inner Loop.** Das Dashboard zeigt Traces über Services hinweg, strukturierte Logs und Metriken ab dem Moment, in dem Sie auf Ausführen drücken. Ein N+1 oder einen Retry-Sturm auf dem eigenen Rechner zu finden statt im Staging verändert, wie man den Code schreibt. Wer [N+1-Abfragen in EF Core 11 erkennt](/de/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) und das bisher aus Logdateien getan hat, erhält hier eine echte Verbesserung.
- **Sie führen es ohnehin schrittweise ein.** Aspire kommt als zwei neue Projekte in eine bestehende Lösung, was Thema von [Aspire zu einer bestehenden ASP.NET Core-Lösung hinzufügen](/de/2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it/) ist.

## Die Fallstricke, die für Sie entscheiden

**Die Port-Syntax von Compose lässt sich nicht wörtlich übertragen.** `ports: ["8080:8080"]` sieht aus wie `WithHttpEndpoint(port: 8080, targetPort: 8080)`, und diese Kombination wirft beim Start:

```
System.InvalidOperationException: The endpoint 'public' for resource 'api'
requested a proxy (IsProxied is true). Non-container resources cannot be
proxied when both TargetPort and Port are specified with the same value.
```

Aspire stellt Projekt-Endpunkte über einen Proxy bereit, deshalb dürfen Host-Port und Ziel-Port nicht denselben Wert haben. Geben Sie nur `port:` an und lassen Sie das Ziel automatisch wählen.

**`WithReference` ist nicht `depends_on`.** Der Migrationsleitfaden ist eindeutig: `WithReference()` konfiguriert ausschließlich Service Discovery und Verbindungszeichenfolgen und steuert nicht die Startreihenfolge. Wer das Verhalten von `condition: service_healthy` aus Compose will, braucht `WaitFor()`, und zwar zusätzlich zu `WithReference()`, nicht anstelle davon.

**Containernamen sind nicht stabil.** Compose liefert `bench-cache-1`, abgeleitet aus Projekt- und Servicenamen. Aspire lieferte mir `cache-vvkhtnuf`, dann `cache-zwjpvzxh`, dann `cache-mmsmckhq` über drei Läufe. Jedes Skript und jede Gewohnheit im Team, die auf `docker exec -it myapp-cache-1 redis-cli` aufbaut, bricht.

**Standard-Image-Versionen wandern mit der Aspire-Version.** `AddRedis` hat unter 13.4.6 `redis:8.6` geladen, nicht das in meiner Compose-Datei fixierte `redis:8.2`. Aspire 13.4 hat außerdem den Postgres-Standard von 17.6 auf 18.3 verschoben, was mit einem bestehenden Datenvolume nicht kompatibel ist. Fixieren Sie mit `WithImageTag`, wenn Ihnen das wichtig ist.

**Ein Compose-Build-Kontext braucht eine `.dockerignore`.** Ohne sie schickt `COPY Api/ Api/` Ihre `bin/`- und `obj/`-Verzeichnisse vom Host in den Build-Kontext, was jeden Build aufbläht und Schichten bei Änderungen invalidiert, die den Quellcode gar nicht berührt haben. Zwei Zeilen beheben das, und der Unterschied ist im Build-Log sichtbar, wo die Kontextübertragung für dieses Projekt auf 1,18 kB fällt:

```
# .dockerignore
**/bin
**/obj
```

Aspire hat kein entsprechendes Problem, weil es für Ihr Projekt nie ein Image baut. Es hat das gespiegelte Problem: MSBuild kann `Api.dll` nicht überschreiben, solange die Ressource läuft, eine Neukompilierung von der Kommandozeile braucht also `aspire resource api stop` vor `dotnet build`. Die IDE erledigt das für Sie, ein Shell-Skript nicht.

**Der Proxy von Aspire kann `aspire stop` überleben und Ihre Container verdecken.** Dieser Punkt hat mich beim Erheben der obigen Zahlen eine Stunde gekostet. Nach `aspire stop --force` war ein `dcp`-Prozess weiterhin an den festen Host-Port gebunden:

```
PID=70448 Name=dcp Addr=127.0.0.1
PID=70448 Name=dcp Addr=::1
```

Docker hat denselben Port dann auf `::` gebunden, beide Befehle meldeten Erfolg, und jede Anfrage an `localhost:8080` wurde vom verwaisten Aspire-Proxy beantwortet statt vom Container. Nichts schlägt fehl. `docker compose ps` zeigt den Container gesund und gemappt, das Image enthält tatsächlich Ihren neuen Code, und die Anwendung liefert weiterhin die Antworten des vorherigen Builds, weil Sie überhaupt nicht mit dem Container sprechen. Ich habe eine Weile den Schicht-Cache von Docker verdächtigt, bevor ich geprüft habe, wem der Port tatsächlich gehört:

```bash
Get-NetTCPConnection -LocalPort 8080 -State Listen
```

Das trifft nur zu, wenn Sie einen Host-Port mit `WithHttpEndpoint(port: ...)` fixieren, und genau das tun Sie beim Übersetzen einer Compose-Datei. Die dynamischen Standardports von Aspire kollidieren nicht.

## Beides zusammen nutzen

Die Entscheidung ist nicht endgültig, denn das AppHost-Modell kann die Compose-Datei erzeugen:

```csharp
// AppHost/AppHost.cs -- Aspire 13.4.6
builder.AddDockerComposeEnvironment("compose")
       .WithDashboard(d => d.WithHostPort(8080));
```

```bash
aspire publish
```

Das erzeugt eine `docker-compose.yaml` plus eine `.env` mit unausgefüllten Parametern, und jede Ressource im Modell wird ohne weiteres Opt-in zu einem Compose-Service. `PublishAsDockerComposeService` passt einen einzelnen Service an (Containername, Labels, Restart-Policy), und `ConfigureComposeFile` bearbeitet das gesamte Dokument, bevor es geschrieben wird. Ein sinnvoller Endzustand lautet also: Aspire für die Inner Loop, generiertes Compose für die Umgebungen, die eine YAML-Datei brauchen, eine einzige Quelle der Wahrheit. Beachten Sie, dass der AppHost selbst nie ausgeliefert wird, genauso wie [ein Container-Image mit `dotnet publish /t:PublishContainer` zu veröffentlichen](/de/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/) eine von der lokalen Ausführung getrennte Angelegenheit ist.

## Die Entscheidung

Für eine .NET-Lösung, deren Services Sie selbst kompilieren, ist Aspire die bessere lokale Entwicklungsumgebung, und der Grund ist ausdrücklich nicht die Geschwindigkeit: Compose hat bei jeder Messung gewonnen, die ich vorgenommen habe. Der Grund ist, dass Ihr Code als Prozess läuft, den Sie debuggen können, und dass der AppHost die Verbindungszeichenfolgen, Ports und OpenTelemetry-Konfiguration schreibt, die Sie sonst von Hand in YAML pflegen und die auseinanderlaufen würden. Sekunden Startzeit sind billig gegenüber einem Nachmittag, an dem Sie herausfinden, warum der Container einen veralteten Build enthält oder warum der Debugger sich nicht anhängt.

Bleiben Sie bei Docker Compose, wenn die Datei eine zweite Aufgabe hat. Wenn CI, Staging oder ein Runbook von diesem YAML abhängen, lautet der ehrliche Vergleich nicht "Aspire vs Compose", sondern "Aspire plus generiertes Compose vs Compose allein", und wenn Ihr Team klein ist und der Stack aus fünf Images besteht, die Sie nicht geschrieben haben, bleibt die zweite Option 2026 eine völlig gute Antwort.

## Verwandte Artikel

- [Aspire zu einer bestehenden ASP.NET Core-Lösung hinzufügen, ohne sie umzubauen](/de/2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it/)
- [Was ist .NET Aspire?](/de/2023/11/what-is-net-aspire/)
- [OpenTelemetry mit .NET 11 und einem kostenlosen Backend verwenden](/de/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/)
- [WebApplicationFactory vs Testcontainers für Integrationstests in ASP.NET Core](/de/2026/08/webapplicationfactory-vs-testcontainers-for-aspnetcore-integration-tests/)
- [Eine .NET 11-Anwendung mit dotnet publish /t:PublishContainer als Container-Image veröffentlichen](/de/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/)

## Quellen

- [Migrate from Docker Compose to Aspire](https://aspire.dev/app-host/migrate-from-docker-compose/), die offizielle Zuordnung Konzept für Konzept
- [Deploy Aspire apps with Docker Compose to any host](https://aspire.dev/deployment/docker-compose/)
- [Aspire Docker integration for containerized resources](https://aspire.dev/integrations/compute/docker/)
- [What's new in Aspire 13.4](https://aspire.dev/whats-new/aspire-13-4/), einschließlich der geänderten Standard-Images für Postgres und RabbitMQ
- [Aspire service discovery fundamentals](https://aspire.dev/fundamentals/service-discovery/)
- [Compose Develop Specification](https://docs.docker.com/reference/compose-file/develop/) zu `watch`
- [microsoft/aspire releases](https://github.com/microsoft/aspire/releases)
