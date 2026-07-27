---
title: "Wie Sie eine .NET 11-Anwendung mit dotnet publish /t:PublishContainer als Container-Image veröffentlichen"
description: "Ein vollständiger Leitfaden zum Erstellen von Container-Images aus einer .NET 11-Anwendung ohne Dockerfile: das Target PublishContainer, ContainerRepository und ContainerImageTags, die Auswahl des Basis-Images über ContainerBaseImage und ContainerFamily, das Pushen in eine Registry und wie die Authentifizierung aufgelöst wird, Multi-Arch-OCI-Image-Indizes, der rootlose Standardbenutzer, die Steuerung des Entrypoints, Tarball-Ausgabe für Scanner und die Fälle, in denen Sie weiterhin ein Dockerfile brauchen."
pubDate: 2026-07-27
template: how-to
tags:
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "containers"
  - "docker"
  - "devops"
  - "msbuild"
lang: "de"
translationOf: "2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer"
translatedBy: "claude"
translationDate: 2026-07-27
---

Um eine .NET 11-Anwendung ohne Dockerfile in ein Container-Image zu verwandeln, führen Sie im Projektverzeichnis `dotnet publish --os linux --arch x64 /t:PublishContainer` aus. Das SDK lädt das passende Microsoft-Basis-Image, legt Ihre Publish-Ausgabe darüber und schiebt das Ergebnis in Ihren lokalen Docker- oder Podman-Daemon. Mit `-p ContainerRegistry=ghcr.io` landet das Image stattdessen in einer echten Registry, mit `-p ContainerArchiveOutputPath=./images/app.tar.gz` erhalten Sie einen Tarball ganz ohne Daemon. Alles, was ein Dockerfile ausdrücken würde (Basis-Image, Tags, Ports, Umgebungsvariablen, Labels, Benutzer, Entrypoint), ist eine MSBuild-Eigenschaft oder ein MSBuild-Item. Dieser Beitrag zielt auf .NET 11 (zum Zeitpunkt des Schreibens Preview 6, finale Version im November 2026) mit C# 14 und dem SDK 11.0.1xx. Fast alles läuft unverändert auch auf den SDKs von .NET 8, 9 und 10, und die relevanten Mindestversionen benenne ich jeweils.

## Was das SDK anstelle eines Dockerfiles tut

Das mentale Modell, mit dem die meisten ankommen, ist auf nützliche Weise falsch. `PublishContainer` ist kein Wrapper um `docker build`. Es wird kein Dockerfile im Hintergrund erzeugt, und Docker ist an der Erzeugung des Images überhaupt nicht beteiligt.

Tatsächlich sprechen die Targets `Microsoft.NET.Build.Containers`, die im SDK enthalten sind, direkt mit der HTTP-API der Registry:

1. Ihre Anwendung wird normal nach `bin/Release/net11.0/<rid>/publish/` veröffentlicht.
2. Das SDK löst ein Basis-Image auf (standardmäßig eines der Repositories `mcr.microsoft.com/dotnet/*`) und holt dessen Manifest und Konfiguration von MCR. Layer-Blobs, die es nicht braucht, lädt es nicht herunter.
3. Ihr Publish-Ordner wird in ein einziges neues Tar-Layer gepackt.
4. Eine neue Image-Konfiguration und ein neues Manifest werden zusammengesetzt: Basis-Layer plus Ihr Layer, dazu Entrypoint, Arbeitsverzeichnis, freigegebene Ports, Umgebungsvariablen, Labels und Benutzer.
5. Das Ergebnis wird irgendwohin gepusht. Standardmäßig in den lokalen Daemon, in eine entfernte Registry, wenn Sie `ContainerRegistry` setzen, oder als `tar.gz` auf die Festplatte, wenn Sie `ContainerArchiveOutputPath` setzen.

Daraus folgen sofort zwei Dinge. Erstens brauchen Sie keine Container-Laufzeit, um ein Image zu *bauen*, sondern nur, um es lokal *auszuführen*. Das macht den Ansatz auf CI-Agents ohne Docker-Socket praktikabel. Zweitens gibt es keinen `RUN`-Schritt, weil während des Builds kein Container ausgeführt wird. Wenn Ihr Image `apt-get install` braucht, gehört das in ein eigenes Basis-Image, auf das `ContainerBaseImage` zeigt.

`/t:PublishContainer` ist ein MSBuild-Target und keine Option von `dotnet publish`, deshalb die MSBuild-Syntax. Die ältere Form `-p PublishProfile=DefaultContainer` funktioniert weiterhin und tut dasselbe. Falls der Unterschied zwischen `dotnet build` und `dotnet publish` unscharf ist, lohnen sich fünf Minuten für [den Unterschied zwischen dotnet build und dotnet publish](/de/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/), denn alles hier hängt an der Publish-Ausgabe.

## Schritte zum Veröffentlichen einer .NET 11-Anwendung als Container-Image

1. Prüfen Sie, dass das .NET 11 SDK installiert ist (`dotnet --info`). Container-Publishing funktioniert ab dem .NET 7 SDK, die hier beschriebenen Standardwerte gelten jedoch ab dem .NET 8 SDK.
2. Setzen Sie `ContainerRepository` in der Projektdatei, wenn der Assemblyname kein zulässiger Image-Name ist (Großbuchstaben sind der übliche Stolperstein).
3. Führen Sie `dotnet publish --os linux --arch x64 /t:PublishContainer` aus, um das Image zu bauen und in den lokalen Daemon zu laden.
4. Prüfen Sie mit `docker images` und starten Sie es: `docker run --rm -p 8080:8080 my-app:latest`.
5. Ergänzen Sie `-p ContainerRegistry=<registry>`, sobald das Image lokal korrekt ist, nachdem Sie sich mit `docker login <registry>` authentifiziert haben.
6. Verschieben Sie die dauerhaft gewünschten Einstellungen in die `.csproj`, damit CI und lokale Läufe übereinstimmen.

Das ist der gesamte Ablauf. Der Rest dieses Beitrags erklärt, was jeder Schalter tut und wo die Kanten scharf sind.

## Benennung: Registry, Repository, Tag

Der Image-Name, den das SDK erzeugt, wird aus getrennten Eigenschaften zusammengesetzt, die den Teilen einer vollständig qualifizierten Image-Referenz entsprechen:

```text
REGISTRY[:PORT]/REPOSITORY[:TAG]
```

- `ContainerRegistry` zeigt standardmäßig auf den lokalen Daemon. Setzen Sie es auf `ghcr.io`, `myorg.azurecr.io`, `docker.io`, `quay.io` oder eine private `registry.mycorp.com:5000`.
- `ContainerRepository` übernimmt standardmäßig den `AssemblyName` des Projekts. Image-Namen müssen aus kleingeschriebenen alphanumerischen Zeichen plus Punkten, Unterstrichen, Bindestrichen und Schrägstrichen bestehen und mit einem Buchstaben oder einer Ziffer beginnen. Eine Assembly namens `DotNet.ContainerImage` ist kein zulässiger Repository-Name, weshalb das Microsoft-Tutorial die Eigenschaft explizit setzt.
- `ContainerImageTag` ist ab dem .NET 8 SDK standardmäßig `latest`. Davor war der Standard die `Version` des Projekts.

```xml
<!-- .csproj, .NET 11 SDK 11.0.1xx -->
<PropertyGroup>
  <TargetFramework>net11.0</TargetFramework>
  <ContainerRegistry>ghcr.io</ContainerRegistry>
  <ContainerRepository>marius-bughiu/orders-api</ContainerRepository>
  <ContainerImageTags>1.4.2;latest</ContainerImageTags>
</PropertyGroup>
```

`ContainerImageTags` (Plural, semikolongetrennt) erzeugt ein Image pro Tag, das übliche Muster aus "fester Version plus wanderndem latest". Tags sind auf 127 Zeichen begrenzt und müssen mit einem alphanumerischen Zeichen oder einem Unterstrich beginnen.

Die Pluralform ist auf der Kommandozeile eine echte Falle, denn das Semikolon ist der Listentrenner von MSBuild, und sowohl PowerShell als auch Bash wollen mitreden. Das Escaping unterscheidet sich je Shell:

```bash
dotnet publish --os linux --arch x64 /t:PublishContainer \
  /p:ContainerImageTags='"1.4.2;latest"'
```

```powershell
dotnet publish --os linux --arch x64 /t:PublishContainer /p:ContainerImageTags=`"1.4.2`;latest`"
```

Wenn Sie diesen Kampf in einem CI-Skript nicht führen wollen, setzen Sie stattdessen die Umgebungsvariable `ContainerImageTags`. MSBuild liest Umgebungsvariablen als Eigenschaften, und die Shell sieht nie ein Semikolon, das sie interpretieren möchte.

Beachten Sie außerdem: Ein Push zu Docker Hub verlangt den Benutzernamen im Repository (`myuser/orders-api`), nicht nur den bloßen Image-Namen.

## Ein Basis-Image ohne FROM-Zeile wählen

Standardmäßig leitet das SDK das Basis-Image aus der Form des Projekts ab:

- ASP.NET Core-Projekte erhalten `mcr.microsoft.com/dotnet/aspnet`.
- Self-contained-Projekte erhalten `mcr.microsoft.com/dotnet/runtime-deps`, weil die Laufzeit in der Publish-Ausgabe steckt.
- Alles andere erhält `mcr.microsoft.com/dotnet/runtime`.

Der Tag stammt aus dem numerischen Teil Ihres `TargetFramework`, `net11.0` löst also auf den Tag `11.0` auf. Seit SDK 8.0.200 reagiert die Ableitung auch darauf, wie Sie veröffentlichen: Ein RID `linux-musl-x64` oder `linux-musl-arm64` wählt die Alpine-Varianten, und `PublishAot=true` wählt eine chiseled AOT-Variante von `runtime-deps`.

Um eine andere *Ausprägung* des Microsoft-Images statt eines völlig anderen Images zu wählen, nutzen Sie `ContainerFamily`. Der Wert wird an den abgeleiteten Tag angehängt:

```xml
<PropertyGroup>
  <ContainerFamily>alpine</ContainerFamily>
</PropertyGroup>
```

Damit wird der Tag des Basis-Images zu `11.0-alpine`. Das Feld ist frei formulierbar und wird schlicht angehängt, prüfen Sie also vorher, ob der angeforderte Tag im Repository `mcr.microsoft.com/dotnet/aspnet` (oder `runtime`) tatsächlich existiert. `ContainerFamily` wird vollständig ignoriert, sobald `ContainerBaseImage` gesetzt ist.

Für volle Kontrolle setzen Sie `ContainerBaseImage` auf einen vollständig qualifizierten Namen inklusive Tag:

```xml
<PropertyGroup>
  <ContainerBaseImage>mcr.microsoft.com/dotnet/aspnet:11.0-alpine</ContainerBaseImage>
</PropertyGroup>
```

Das ist zugleich der Ausweg aus dem fehlenden `RUN`-Support: Bauen Sie einmalig ein Basis-Image mit einem Dockerfile, das das benötigte native Paket installiert, pushen Sie es und lassen Sie alle Dienste darauf zeigen.

Windows-Container brauchen dieselbe Behandlung. Seit .NET 8 enthalten die Manifest-Listen von Microsoft keine Windows-Varianten mehr, für Nano Server muss der Tag also explizit benannt werden, zum Beispiel `mcr.microsoft.com/dotnet/aspnet:11.0-nanoserver-ltsc2022`.

Wenn Sie das mit Native AOT kombinieren, um ein wirklich kleines Image zu bekommen, gelten die Abwägungen aus [was Native AOT wirklich kostet](/de/2026/06/what-is-native-aot-and-what-does-it-cost-you/) im Container unverändert, und die Layer-Ersparnis fällt meist geringer aus als der Preis, den die Reflection-Einschränkungen bei der Bibliothekskompatibilität kosten.

## In eine Registry pushen, und wie die Authentifizierung aufgelöst wird

Setzen Sie `ContainerRegistry`, und das SDK pusht über die Docker Registry HTTP API V2, statt in einen lokalen Daemon zu laden:

```bash
# .NET 11 SDK
dotnet publish --os linux --arch x64 /t:PublishContainer \
  -p ContainerRegistry=ghcr.io \
  -p ContainerRepository=marius-bughiu/orders-api
```

Anmeldedaten werden über Dockers eigene Konfiguration aufgelöst, in dieser Reihenfolge der Nützlichkeit:

1. `~/.docker/config.json`, oder das Verzeichnis, das die Umgebungsvariable `DOCKER_CONFIG` benennt. Der Abschnitt `auths` (das, was `docker login` schreibt) wird direkt gelesen.
2. Einträge unter `credHelpers`, die eine Registry auf eine ausführbare Datei `docker-credential-<name>` im `PATH` abbilden. So geben ACR, ECR und Google Artifact Registry kurzlebige Tokens aus.
3. `credsStore`, der Schlüsselbund-Helper des Betriebssystems.

Wenn nichts davon verfügbar ist, etwa in einem SDK-Container ohne eingebundene Docker-Konfiguration, gibt es zwei Umgebungsvariablen als letzte Rettung:

```bash
export DOTNET_CONTAINER_REGISTRY_UNAME='<token>'
export DOTNET_CONTAINER_REGISTRY_PWORD="$GITHUB_TOKEN"
```

Zwei Dinge dazu. Das Präfix wechselte in SDK 8.0.400 von `SDK_CONTAINER_*` zu `DOTNET_CONTAINER_*`, und veraltete Beiträge zeigen weiterhin die alten Namen. Und sie gelten für *beide* Registries, die Quelle (MCR, woher das Basis-Image kommt) und das Ziel, was sie unbrauchbar macht, wenn beide unterschiedliche Anmeldedaten brauchen. Bevorzugen Sie `docker login`.

Für eine Registry mit reinem HTTP im internen Netz akzeptiert das SDK ab 9.0.1xx eine kommaseparierte Positivliste:

```bash
export DOTNET_CONTAINER_INSECURE_REGISTRIES=localhost:5000,registry.mycorp.com
```

**Neu in .NET 11:** Das SDK validiert jetzt den `realm` des Bearer-Tokens, den eine Registry in ihrer Authentifizierungs-Challenge zurückgibt, bevor es ihm folgt ([dotnet/sdk#54225](https://github.com/dotnet/sdk/pull/54225)). Der Realm muss ein absoluter URI sein, muss HTTPS verwenden, sofern die Registry nicht ausdrücklich als unsicher gelistet ist, und darf nicht auf ein IP-Literal aus Loopback-, privaten, Link-Local- oder unspezifizierten Bereichen auflösen. Registry- und Auth-Host dürfen weiterhin unterschiedlich sein, das ist das normale OCI-Muster. Es handelt sich insofern um eine Breaking Change, als eine falsch konfigurierte oder bösartige Registry, die früher "funktionierte", das Publishing nun früh scheitern lässt. Wenn eine bislang unauffällige interne Registry unter .NET 11 zu scheitern beginnt, prüfen Sie zuerst diese Validierung.

## Multi-Arch-Images und der OCI-Image-Index

Seit den SDKs 8.0.405, 9.0.102 und 9.0.2xx kann `PublishContainer` ein echtes Multi-Arch-Image erzeugen. Die Regel hängt daran, welche RID-Eigenschaften Sie setzen:

- Ein einzelner `RuntimeIdentifier` oder `ContainerRuntimeIdentifier` ergibt wie bisher ein Image für eine Architektur.
- Ohne einzelnen RID, aber mit mehreren `RuntimeIdentifiers` oder `ContainerRuntimeIdentifiers` veröffentlicht das SDK je RID einmal und kombiniert die Ergebnisse zu einem [OCI Image Index](https://specs.opencontainers.org/image-spec/image-index/), sodass sich alle Architekturen einen Namen teilen.

```xml
<!-- .NET 11, SDK 11.0.1xx -->
<PropertyGroup>
  <RuntimeIdentifiers>linux-x64;linux-arm64</RuntimeIdentifiers>
  <ContainerRuntimeIdentifiers>linux-x64;linux-arm64</ContainerRuntimeIdentifiers>
</PropertyGroup>
```

```bash
# Note: no --arch, and no -r. Passing either collapses it back to one architecture.
dotnet publish --os linux /t:PublishContainer
```

`ContainerRuntimeIdentifiers` muss eine Teilmenge von `RuntimeIdentifiers` sein, sonst scheitern Teile der Build-Pipeline auf verwirrende Weise. Multi-Arch-Images werden immer im OCI-Format ausgegeben, unabhängig davon, was `ContainerImageFormat` sagt, denn das Docker-v2-Manifestschema kennt kein Gegenstück zum Image-Index.

Zwei betriebliche Hinweise. Blazor WebAssembly-Projekte können in Build-Race-Conditions laufen, wenn RIDs parallel veröffentlicht werden; `ContainerPublishInParallel=false` serialisiert sie auf Kosten der Laufzeit (SDK 8.0.408, 9.0.300, 10.0 und höher). Und .NET 11 Preview 6 hat Multi-Arch-Unterstützung ergänzt, wenn Podman die lokale Engine ist ([dotnet/sdk#54575](https://github.com/dotnet/sdk/pull/54575)); zuvor war dafür Docker nötig.

`ContainerImageFormat`, eingeführt in .NET 10, erlaubt es, für den Einzel-Architektur-Fall `Docker` oder `OCI` zu erzwingen. Der Standard wird aus dem Basis-Image abgeleitet, und Microsofts Images verwenden weiterhin den Docker-Manifest-Medientyp. Setzen Sie ihn auf `OCI`, falls ein nachgelagertes Werkzeug darauf besteht.

## Ports, Umgebungsvariablen, Labels und der Benutzer

Das sind Items statt Eigenschaften, sie gehören also in eine `ItemGroup`:

```xml
<ItemGroup>
  <ContainerPort Include="8080" Type="tcp" />
  <ContainerEnvironmentVariable Include="ASPNETCORE_FORWARDEDHEADERS_ENABLED" Value="true" />
  <ContainerLabel Include="org.contoso.businessunit" Value="orders" />
</ItemGroup>
```

`ContainerPort` wird ab .NET 8 aus `ASPNETCORE_URLS`, `ASPNETCORE_HTTP_PORTS` oder `ASPNETCORE_HTTPS_PORTS` abgeleitet, gelesen entweder aus dem Basis-Image oder aus Ihren eigenen `ContainerEnvironmentVariable`-Items. Da die ASP.NET Core-Images `ASPNETCORE_HTTP_PORTS=8080` setzen, braucht eine gewöhnliche Web-API in der Regel gar keine Port-Konfiguration.

`ContainerEnvironmentVariable` hat eine reale Einschränkung, die man einplanen sollte: Sie lässt sich derzeit nicht über die CLI setzen, nur über die Projektdatei ([dotnet/sdk-container-builds#451](https://github.com/dotnet/sdk-container-builds/issues/451)). Alles Umgebungsspezifische gehört daher in die Konfiguration Ihres Orchestrators und nicht ins Image, wo es ohnehin nichts zu suchen hat.

Labels erledigen sich weitgehend von selbst. Das SDK schreibt die üblichen OCI-Annotationen (`org.opencontainers.image.created`, `.version`, `.title`, `.source`, `.revision`, `.base.name`, `.base.digest` und weitere) aus vorhandenen MSBuild-Eigenschaften. `.source` und `.revision` erscheinen nur, wenn `PublishRepositoryUrl` auf `true` steht und SourceLink Teil des Builds ist. Den ganzen Satz schalten Sie mit `ContainerGenerateLabels=false` ab, ein einzelnes Label über dessen `ContainerGenerateLabelsImage*`-Flag.

Der Benutzer-Standard überrascht positiv. Ab .NET 8 und mit den Microsoft-Runtime-Images läuft der Container unter Linux als der rootlose Benutzer `app` (referenziert über die UID aus der Umgebungsvariable `APP_UID`) und unter Windows als `ContainerUser`. Das ist der richtige Standard, und Sie sollten ihn so lassen. Er bedeutet allerdings, dass die Anwendung nicht in beliebige Pfade schreiben, keine Ports unterhalb 1024 binden und keine Dateien lesen kann, deren Rechte root voraussetzen. Wenn Sie root wirklich brauchen, gibt es `ContainerUser=root`, und das SDK prüft nicht, ob der genannte Benutzer im Image überhaupt existiert.

`ContainerWorkingDirectory` ist standardmäßig `/app`.

## Den Entrypoint steuern

Bei den meisten Anwendungen ist die erzeugte AppHost-Binärdatei der Entrypoint, und es gibt nichts zu tun. Wenn das Image ein Werkzeug statt Ihrer Anwendung ausführen soll, nutzen Sie `ContainerAppCommand` zusammen mit `ContainerAppCommandArgs` und `ContainerDefaultArgs` für Argumente, die ein Aufrufer überschreiben können soll:

```xml
<ItemGroup>
  <!-- Semicolons split tokens: this is dotnet ef database update -->
  <ContainerAppCommand Include="dotnet;ef" />
  <ContainerAppCommandArgs Include="database;update" />
</ItemGroup>
```

`ContainerAppCommandInstruction` entscheidet, wie das mit einem eventuellen `ENTRYPOINT` des Basis-Images kombiniert wird, und nimmt `Entrypoint`, `DefaultArgs` oder `None` an. `DefaultArgs` ist der Standard und der subtilste Fall: Wenn keine `ContainerEntrypoint`-Items vorhanden sind, überspringt er einen fest auf `dotnet` oder `/usr/bin/dotnet` gesetzten Entrypoint des Basis-Images, sodass Sie vollständige Kontrolle behalten. `ContainerEntrypoint` und `ContainerEntrypointArgs` sind seit .NET 8 veraltet; verwenden Sie stattdessen die App-Command-Items.

## Tarball-Ausgabe für Scanning-Pipelines

Sicherheitsbewusste Pipelines wollen oft scannen, bevor irgendetwas eine Registry erreicht. `ContainerArchiveOutputPath` schreibt das Image in ein `tar.gz` und braucht keinen Daemon:

```bash
dotnet publish --os linux --arch x64 /t:PublishContainer \
  -p ContainerArchiveOutputPath=./images/orders-api.tar.gz
```

```bash
docker load -i ./images/orders-api.tar.gz
```

Podman verwendet `podman load -i` mit derselben Datei. Geben Sie ein Verzeichnis statt eines Dateinamens an, heißt das Archiv `$(ContainerRepository).tar.gz`. Alle `ContainerImageTags` landen in diesem einen Archiv, statt mehrere Dateien zu erzeugen.

## Einbau in GitHub Actions

Das Ganze schrumpft auf drei Schritte, weil es kein Buildx, kein QEMU und kein Dockerfile gibt, das mit dem Projekt synchron gehalten werden muss:

```yaml
# .github/workflows/publish.yml
- uses: actions/setup-dotnet@v4
  with:
    dotnet-version: '11.0.x'

- name: Log in to GHCR
  run: echo "${{ secrets.GITHUB_TOKEN }}" | docker login ghcr.io -u ${{ github.actor }} --password-stdin

- name: Publish container
  run: >
    dotnet publish src/Orders.Api/Orders.Api.csproj
    --os linux /t:PublishContainer
    -p ContainerRegistry=ghcr.io
    -p ContainerRepository=${{ github.repository_owner }}/orders-api
    -p ContainerImageTag=${{ github.sha }}
```

`docker login` dient nur dazu, `~/.docker/config.json` zu befüllen; den Push selbst erledigt das SDK über HTTPS. Auf einem Runner ganz ohne Docker ersetzen Sie diesen Schritt durch das Exportieren von `DOTNET_CONTAINER_REGISTRY_UNAME` und `DOTNET_CONTAINER_REGISTRY_PWORD`.

## Wann Sie weiterhin ein Dockerfile wollen

Bleiben Sie bei den Grenzen ehrlich. Greifen Sie zum Dockerfile, wenn Sie `RUN`-Schritte brauchen, wenn ein mehrstufiger Build in derselben Datei Nicht-.NET-Artefakte kompilieren muss (ein Node-Frontend, native Abhängigkeiten), oder wenn Sie feine Kontrolle über die Layer-Reihenfolge für Cache-Effizienz über viele Images hinweg benötigen.

Alles andere, in der Praxis die meisten ASP.NET Core-Dienste und Worker Services, fährt mit `PublishContainer` besser. Die Image-Konfiguration liegt in derselben Datei wie der restliche Build, sie kann nicht vom TFM abweichen, und es gibt keine Zeile `COPY --from=build /app/publish .`, die man falsch schreiben kann. Wenn Sie die Anwendung ohnehin unter [.NET Aspire](/de/2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it/) betreiben, ist das zugleich der Mechanismus, den der AppHost nutzt, wenn er eine Projektressource für die Bereitstellung in einen Container packt.

Ein letzter Versionshinweis für Konsolenanwendungen: Ab dem .NET 10 SDK kann ein Konsolenprojekt ohne zusätzliche Konfiguration einen Container veröffentlichen. Bei den SDKs von .NET 9 und älter brauchten Sie `<EnableSdkContainerSupport>true</EnableSdkContainerSupport>` in der Projektdatei, und genau diese Eigenschaft setzen Sie weiterhin für Projekttypen, die das SDK nicht automatisch aktiviert.

## Verwandte Beiträge

- [Was ist der Unterschied zwischen dotnet build und dotnet publish?](/de/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/) dazu, was tatsächlich in dem Ordner landet, der zu Ihrem Image-Layer wird.
- [Was ist Native AOT und was kostet es Sie?](/de/2026/06/what-is-native-aot-and-what-does-it-cost-you/) bevor Sie mit `PublishAot` einem kleineren Image hinterherjagen.
- [Native AOT vs ReadyToRun vs JIT in .NET 11](/de/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) für die Startzeit- und Größenzahlen hinter dieser Entscheidung.
- [Wie Sie .NET Aspire zu einer bestehenden ASP.NET Core-Solution hinzufügen](/de/2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it/) falls dieselben Projekte auch lokale Orchestrierung brauchen.
- [Was ist trim-sicherer Code und wie schreibt man ihn?](/de/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/) denn Trimming ist die andere Hälfte davon, ein Container-Image zu verkleinern.

## Quellen

- [Containerize an app with dotnet publish](https://learn.microsoft.com/en-us/dotnet/core/containers/sdk-publish) auf Microsoft Learn.
- [Containerize a .NET app reference](https://learn.microsoft.com/en-us/dotnet/core/containers/publish-configuration), die vollständige Liste der Eigenschaften und Items.
- [Authenticating to container registries](https://github.com/dotnet/sdk-container-builds/blob/main/docs/RegistryAuthentication.md) im Repository dotnet/sdk-container-builds.
- [What's new in the SDK and tooling for .NET 10](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-10/sdk) zu `ContainerImageFormat` und der Unterstützung für Konsolenanwendungen.
- [.NET SDK in .NET 11 Preview 5 release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/sdk.md) zur Validierung des Bearer-Token-Realms.
- [.NET SDK in .NET 11 Preview 6 release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/sdk.md) zur Multi-Arch-Unterstützung mit Podman.
