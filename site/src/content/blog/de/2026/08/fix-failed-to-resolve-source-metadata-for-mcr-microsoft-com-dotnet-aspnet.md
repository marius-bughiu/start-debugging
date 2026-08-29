---
title: "Lösung: failed to resolve source metadata for mcr.microsoft.com/dotnet/aspnet"
description: "BuildKit kann das Manifest Ihres Base-Image nicht lesen. Prüfen Sie, ob das Tag existiert, reparieren Sie den Docker Credential Helper, öffnen Sie beide MCR-Endpunkte und laden Sie Images für Offline-Builds vorab."
pubDate: 2026-08-29
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "docker"
  - "containers"
  - "buildkit"
  - "dotnet-11"
lang: "de"
translationOf: "2026/08/fix-failed-to-resolve-source-metadata-for-mcr-microsoft-com-dotnet-aspnet"
translatedBy: "claude"
translationDate: 2026-08-29
---

Hier scheitert BuildKit daran, das Image-Manifest für Ihre `FROM`-Zeile zu lesen, und das passiert, bevor eine einzige Anweisung Ihres Dockerfile ausgeführt wird. Vier Ursachen decken fast alle Fälle ab, in dieser Reihenfolge: Das Tag existiert nicht (`11.0` ist kein echtes Tag, solange .NET 11 noch im Preview ist), ein defekter Credential Helper in `~/.docker/config.json`, ein Proxy oder eine Firewall, die `mcr.microsoft.com` oder `*.data.mcr.microsoft.com` blockiert, oder ein Offline-Build mit einem Builder, der die lokal geladenen Images nicht sieht. Führen Sie zuerst `docker buildx imagetools inspect mcr.microsoft.com/dotnet/aspnet:10.0` aus. Scheitert auch das, liegt es nicht an Ihrem Dockerfile.

```text
 => ERROR [internal] load metadata for mcr.microsoft.com/dotnet/aspnet:11.0
------
 > [internal] load metadata for mcr.microsoft.com/dotnet/aspnet:11.0:
------
failed to solve: failed to resolve source metadata for
mcr.microsoft.com/dotnet/aspnet:11.0: mcr.microsoft.com/dotnet/aspnet:11.0: not found
```

Alles Folgende ist gegen Docker Engine 29 (BuildKit v0.32.x, Buildx v0.32), .NET 10 (`10.0`, veröffentlicht am 2025-11-11) und die .NET 11 Previews verifiziert, die im August 2026 bei Preview 7 stehen; GA ist für November 2026 geplant. Derselbe Mechanismus gilt unverändert für Engine 27 und 28 sowie für das BuildKit-kompatible Frontend von Podman. Nur der genaue Wortlaut der letzten Klausel ändert sich zwischen Versionen.

## Was BuildKit tut, wenn es "resolve source metadata" meldet

BuildKit führt Ihr Dockerfile nicht von oben nach unten aus, wie es der klassische Builder tat. Es baut zuerst einen Abhängigkeitsgraphen auf, und dafür muss es wissen, worauf jede `FROM`-Referenz tatsächlich zeigt. Das bedeutet eine `HEAD https://mcr.microsoft.com/v2/dotnet/aspnet/manifests/<tag>`-Anfrage pro Base-Image und pro Build, damit die Referenz vor jeder Planung auf einen Content-Digest festgenagelt werden kann. Diese Anfrage ist der Schritt "load metadata" in der Build-Ausgabe, und Ihre Meldung ist genau dieser Schritt beim Scheitern.

Daraus folgen drei Dinge, die den größten Teil der Verwirrung rund um diesen Fehler erklären:

- **Er tritt auch dann auf, wenn alle Layer bereits im Cache liegen.** Gecachte Layer beantworten die Frage "zeigt dieses Tag noch auf denselben Digest" nicht, also fragt BuildKit trotzdem nach. Deshalb scheitert ein Offline-Build auf einem Rechner, der genau dasselbe Image eine Stunde zuvor gebaut hat.
- **Er tritt vor `RUN`, `COPY` und `WORKDIR` auf.** Kein Build-Argument, das die Build-Umgebung beeinflusst, hilft hier, denn von der Build-Umgebung ist noch nichts gestartet. Insbesondere bewirkt `--build-arg HTTP_PROXY=...` an dieser Stelle nichts. Dieses Build-Argument wird in `RUN`-Schritte injiziert; es konfiguriert nicht den Registry-Client des BuildKit-Daemon selbst.
- **Die letzte Klausel nach dem letzten Doppelpunkt ist der eigentliche Fehler.** `not found` heißt, das Tag existiert nicht. `dial tcp ...: i/o timeout` heißt Netzwerk. `error getting credentials` heißt Ihre Docker-Konfiguration. Lesen Sie diese Klausel zuerst und springen Sie direkt zum passenden Abschnitt weiter unten.

Alles andere in der Meldung ist Verpackung von BuildKit. Das scheiternde Verb ist immer dasselbe.

## Das minimale Repro

Zwei Stages, ein Build-Image und ein Runtime-Image, also genau die Form, die die .NET-Containervorlagen erzeugen:

```dockerfile
# Docker Engine 29, BuildKit v0.32. Fails at "load metadata".
FROM mcr.microsoft.com/dotnet/sdk:11.0 AS build
WORKDIR /src
COPY . .
RUN dotnet publish -c Release -o /app

FROM mcr.microsoft.com/dotnet/aspnet:11.0
WORKDIR /app
COPY --from=build /app .
ENTRYPOINT ["dotnet", "MyApi.dll"]
```

`docker build .` scheitert sofort mit dem obigen Fehler und erreicht `dotnet publish` nie. Beachten Sie, dass überhaupt kein Anwendungscode beteiligt ist. Ein leeres Verzeichnis mit nur diesem Dockerfile reproduziert das Problem, und das ist der schnellste Weg zu zeigen, dass es nicht an Ihrem Projekt liegt.

## Lösung 1: Prüfen Sie, ob das Tag überhaupt existiert

Das ist derzeit die mit Abstand häufigste Ursache, und .NET 11 ist der Grund. Microsoft veröffentlicht kein gleitendes Major-Version-Tag, bevor ein Release GA erreicht. Während des Preview-Zeitraums heißen die Tags `11.0-preview` und das fixierte `11.0.0-preview.7`, dazu betriebssystemspezifische Varianten wie `11.0-preview-resolute` und `11.0-preview-alpine`. Ein `11.0` gibt es nicht. Dieses Tag erscheint im November 2026 und keinen Tag früher, also scheitert ein aus einem .NET 10 Projekt kopiertes und von Hand hochgezogenes Dockerfile an einem Namen, den es nie gegeben hat.

Fragen Sie die Registry direkt, statt zu raten:

```bash
# Works against any registry, prints the manifest list and its platforms.
docker buildx imagetools inspect mcr.microsoft.com/dotnet/aspnet:11.0-preview
```

MCR liefert außerdem die anonyme OCI-Tag-Liste, was nützlich ist, wenn Sie sehen wollen, was tatsächlich veröffentlicht ist:

```bash
curl -s https://mcr.microsoft.com/v2/dotnet/aspnet/tags/list | jq '.tags[] | select(startswith("11.0"))'
```

Zwei weitere Tag-Fehler erzeugen exakt dieselbe Meldung. Der erste ist die Umbenennung des Repositorys: .NET Core 3.1 und älter lagen unter `mcr.microsoft.com/dotnet/core/aspnet`, alles ab .NET 5 liegt unter `mcr.microsoft.com/dotnet/aspnet`. Ein altes, weitergeschlepptes Dockerfile behält das Segment `core/` und bekommt für jede moderne Version ein `not found`. Der zweite ist eine ausgemusterte Betriebssystemvariante, etwa ein `bullseye-slim`-Tag für eine .NET-Version, deren Debian-Basis weitergezogen ist. Die [Dokumentation der .NET-Container-Image-Tags](https://github.com/dotnet/dotnet-docker/blob/main/README.aspnet.md) ist die maßgebliche Quelle dafür, welche Varianten aktiv sind, und ein Blick dorthin lohnt sich bei jedem Wechsel des Base-Image mehr als das Vertrauen in einen alten Blogbeitrag. Wenn Sie zwischen Betriebssystemvarianten wählen, gelten die Abwägungen aus [den resolute Container-Tags für .NET 10](/de/2026/04/dotnet-10-ubuntu-2604-resolute-container-tags/) auch für die .NET 11 Previews.

## Lösung 2: Reparieren Sie den Docker Credential Helper

Wenn die letzte Klausel so aussieht, ist die Registry in Ordnung und Ihre lokale Docker-Konfiguration defekt:

```text
failed to resolve source metadata for mcr.microsoft.com/dotnet/aspnet:10.0:
error getting credentials - err: exit status 1, out: ``
```

Die Docker-CLI liest `~/.docker/config.json`, findet einen `credsStore`- oder `credHelpers`-Eintrag und ruft eine Binärdatei `docker-credential-<name>` auf, um Zugangsdaten für die Registry zu holen. Fehlt diese Binärdatei im `PATH` oder erreicht sie keinen Schlüsselbund, bricht die CLI ab, bevor sie MCR überhaupt kontaktiert. Der klassische Auslöser ist `"credsStore": "desktop"` in einer Konfigurationsdatei, die mit einer WSL2-Distribution, einem CI-Container oder einer entfernten SSH-Sitzung geteilt wird, wo `docker-credential-desktop` nicht existiert.

MCR liefert seine öffentlichen Images anonym aus, Sie brauchen dafür also gar keine Zugangsdaten. Löschen Sie den Eintrag:

```json
{
  "auths": {},
  "credsStore": ""
}
```

Oder entfernen Sie den Schlüssel `credsStore` vollständig. Unter macOS ist `osxkeychain` der funktionierende Wert, unter Linux `pass` oder `secretservice`, und falls tatsächlich ein Helper installiert ist, prüfen Sie, ob er antwortet:

```bash
echo '{"ServerURL":"https://index.docker.io/v1/"}' | docker-credential-desktop get
```

Eine verwandte Variante zeigt sich als `401 Unauthorized` bei einer HEAD-Anfrage an MCR. Das heißt, dass veraltete Zugangsdaten an eine anonyme Registry geschickt werden. Löschen Sie sie mit `docker logout mcr.microsoft.com` und bauen Sie neu.

## Lösung 3: Öffnen Sie beide MCR-Endpunkte und konfigurieren Sie den Proxy des Builders

Die Microsoft Artifact Registry verteilt ihre Arbeit auf zwei Hostnamen, und Firewall-Regeln, die nur den ersten kennen, scheitern auf eine Weise, die zufällig wirkt. `mcr.microsoft.com` übernimmt die Inhaltssuche, also Manifest- und Tag-Anfragen. `*.data.mcr.microsoft.com` ist das Azure Front Door CDN, das die eigentlichen Layer-Bytes ausliefert. Microsofts [Firewall-Regeln für Clients](https://github.com/microsoft/containerregistry/blob/main/docs/client-firewall-rules.md) verlangen beide über HTTPS auf Port 443 und warnen ausdrücklich vor regionsspezifischen Regeln, weil sich die Regionen des Datenendpunkts aus Performancegründen ändern. Erlauben Sie nur den Registry-Endpunkt, gelingt die Metadatenauflösung und der Pull stirbt danach. Erlauben Sie keinen von beiden, bekommen Sie den Fehler aus diesem Beitrag.

Die Proxy-Konfiguration kostet die meiste Zeit, denn sie hängt vom verwendeten Builder-Treiber ab, und die beiden verhalten sich unterschiedlich:

- **Der Standardtreiber `docker`** führt BuildKit im Docker-Daemon aus und erbt damit dessen Proxy-Einstellungen. In Docker Desktop stehen die unter Settings, Resources, Proxies. Unter Linux ist es ein systemd-Drop-in unter `/etc/systemd/system/docker.service.d/http-proxy.conf`, gefolgt von `systemctl daemon-reload && systemctl restart docker`.
- **Der Treiber `docker-container`**, den `docker buildx create` anlegt, führt BuildKit in einem eigenen Container aus, der nichts erbt. Sie müssen die Umgebung explizit übergeben:

```bash
# Buildx v0.32. env.<key> sets variables inside the BuildKit container.
docker buildx create --name proxied \
  --driver docker-container \
  --driver-opt env.HTTP_PROXY=http://proxy.corp:8080 \
  --driver-opt env.HTTPS_PROXY=http://proxy.corp:8080 \
  --driver-opt env.NO_PROXY=localhost,127.0.0.1 \
  --use
```

Wenn Ihr Proxy TLS mit einer unternehmenseigenen Zertifizierungsstelle aufbricht, lautet die letzte Klausel `tls: failed to verify certificate: x509: certificate signed by unknown authority`. Die Lösung auf Daemon-Seite besteht darin, die CA in den Zertifikatsspeicher des Hosts aufzunehmen und Docker neu zu starten. Für einen `docker-container`-Builder müssen Sie die CA in diesen Container bringen, entweder über ein eigenes `buildkitd.toml` eingehängt oder indem Sie stattdessen auf dem Standardtreiber bauen.

Reine DNS-Fehler zeigen sich als `dial tcp: lookup mcr.microsoft.com: no such host`, was unter WSL2 nach einem VPN-Wechsel häufig vorkommt. Explizite Resolver in `/etc/docker/daemon.json` mit `"dns": ["1.1.1.1", "8.8.8.8"]` und ein Neustart des Daemon beheben das meistens.

## Lösung 4: Laden Sie Images für Offline-Builds vorab und achten Sie auf den Builder-Treiber

Weil die Metadatenauflösung immer eine erreichbare Registry will, scheitert ein Build ohne Netz oder mit instabiler Verbindung selbst dann, wenn die Layer auf der Platte liegen. Die Lösung besteht darin, das Image im lokalen Image-Store vorliegen zu haben, nicht nur im Cache:

```bash
# Run these while you still have connectivity.
docker pull mcr.microsoft.com/dotnet/sdk:10.0
docker pull mcr.microsoft.com/dotnet/aspnet:10.0
```

Mit dem Standardtreiber `docker` kann BuildKit die Referenz dann aus dem Image-Store des Daemon auflösen, und der Offline-Build gelingt. `--pull=false` macht die Absicht explizit und hindert BuildKit daran, eine entfernte Abfrage zu bevorzugen.

Der Haken ist, dass das nur mit dem Standardtreiber funktioniert. Ein `docker-container`-Builder hat einen eigenen Content-Store und sieht die Images des Docker-Daemon nicht, [ein seit Langem bekanntes und immer wieder neu entdecktes Verhalten](https://github.com/moby/moby/issues/49542). Wenn Sie einen eigenen Builder für Multi-Plattform-Ausgabe angelegt haben und danach offline gehen, nützt Ihnen das Vorabladen nichts. Wechseln Sie für Offline-Arbeit mit `docker buildx use default` zurück, oder betreiben Sie einen Registry-Mirror, den der Builder erreicht.

Dieselbe Unterscheidung schlägt in CI zu. GitHub-Actions-Runner mit `docker/setup-buildx-action` bekommen standardmäßig einen `docker-container`-Builder, sodass ein Workflow, der lokal nach einem `docker pull`-Schritt läuft, auf dem Runner trotzdem die Registry anspricht.

## Lösung 5: Bringen Sie die Plattform in Übereinstimmung

Existiert das Tag, hat aber kein Image für Ihre Zielplattform, kommt der Fehler im selben Schritt mit anderem Ende:

```text
failed to resolve source metadata for mcr.microsoft.com/dotnet/aspnet:10.0-nanoserver-ltsc2022:
no match for platform in manifest: not found
```

Zwei häufige Formen. Die erste ist ein reines Windows-Tag wie `nanoserver` oder `windowsservercore`, das von einem Daemon mit Linux-Containern angefragt wird. Stellen Sie Docker Desktop auf Windows-Container um oder nehmen Sie ein Linux-Tag. Die zweite ist ein explizites `--platform linux/arm64` gegen ein Tag, das nur amd64 ausliefert, was bei Sidecar-Images von Drittanbietern häufiger vorkommt als bei denen von Microsoft, da die .NET-Runtime-Images amd64, arm64 und arm32v7 veröffentlichen. `docker buildx imagetools inspect` listet jede Plattform der Manifest-Liste auf, prüfen Sie also dort, bevor Sie das Image für defekt halten.

## Varianten, die gleich aussehen, es aber nicht sind

`failed to solve: process "/bin/sh -c dotnet restore" did not complete successfully` ist ein völlig anderer Fehler. Die Metadatenauflösung war erfolgreich und Ihr Build läuft bereits, das Problem ist also NuGet, nicht die Registry. Ebenso bedeutet `NU1301: Unable to load the service index for source https://api.nuget.org/v3/index.json` in einer Build-Stage, dass der Container MCR erreicht, aber NuGet nicht, was meist dieselbe Proxy-Geschichte eine Ebene tiefer ist.

Wenn das Image geladen wird und startet, der Container aber sofort beendet wird, sind Sie an diesem Fehler vorbei und im Laufzeitbereich. Der Globalisierungs-Crash aus [der Lösung für das fehlende ICU-Paket](/de/2026/07/fix-couldnt-find-a-valid-icu-package-installed-on-the-system/) ist bei schlanken Base-Images der häufigste.

Wenn Sie sich ohnehin mit den `FROM`-Zeilen herumschlagen, überlegen Sie zuletzt, ob Sie überhaupt ein Dockerfile brauchen. Das SDK kann ein OCI-Image direkt erzeugen, und [eine .NET 11 App mit `/t:PublishContainer` zu veröffentlichen](/de/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/) löst Base-Images über eine NuGet-artige Logik auf, die mit deutlich spezifischeren Meldungen scheitert als BuildKit.

## Verwandte Beiträge

- [Wie Sie eine .NET 11 App mit dotnet publish /t:PublishContainer als Container-Image veröffentlichen](/de/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/)
- [.NET 10 auf Ubuntu 26.04: resolute Container-Tags und Native AOT im Archiv](/de/2026/04/dotnet-10-ubuntu-2604-resolute-container-tags/)
- [Lösung: Couldn't find a valid ICU package installed on the system in einem .NET-Container](/de/2026/07/fix-couldnt-find-a-valid-icu-package-installed-on-the-system/)
- [SBOM für .NET in Docker: hören Sie auf, ein einziges Werkzeug zu allem zwingen zu wollen](/de/2026/01/sbom-for-net-in-docker-stop-trying-to-force-one-tool-to-see-everything/)
- [Aspire vs Docker Compose für die lokale Multi-Service-Entwicklung](/de/2026/08/aspire-vs-docker-compose-for-local-multi-service-development/)

## Quellen

- [Firewall-Regeln für Clients der Microsoft Artifact Registry](https://github.com/microsoft/containerregistry/blob/main/docs/client-firewall-rules.md)
- [Leitfaden zu den Endpunkten der Microsoft Artifact Registry](https://github.com/microsoft/containerregistry/blob/main/docs/mcr-endpoints-guidance.md)
- [dotnet/dotnet-docker: unterstützte Tags der ASP.NET Core Runtime](https://github.com/dotnet/dotnet-docker/blob/main/README.aspnet.md)
- [Docker-Dokumentation: Optionen des Build-Treibers docker-container](https://docs.docker.com/build/builders/drivers/docker-container/)
- [Docker-Dokumentation: Build-Variablen und Proxy-Build-Argumente](https://docs.docker.com/build/building/variables/)
- [moby/moby#49542: BuildKit mit dem docker-container-Treiber verweigert die Nutzung lokaler Images](https://github.com/moby/moby/issues/49542)
- [dotnet/core#8268: docker-compose build kann Images von mcr.microsoft.com nicht laden](https://github.com/dotnet/core/issues/8268)
