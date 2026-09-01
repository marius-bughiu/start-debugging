---
title: "Framework-abhängig vs. eigenständig vs. Native AOT für ein .NET 11 Container-Image"
description: "Framework-abhängig auf einem chiseled aspnet-Image ist der richtige Standard für einen ASP.NET Core Dienst unter .NET 11, weil die Laufzeit-Schicht zwischen Diensten geteilt wird und eine Laufzeit-CVE durch einen Wechsel des Basis-Images behoben wird. Eigenständig mit Trimming und Native AOT erkaufen ein 2- bis 5-mal kleineres Image und einen deutlich schnelleren Kaltstart und kosten genau das. Echte veröffentlichte Größen, die Rechnung der geteilten Layer und der .NET 11 Basis-Image-Inferenzfehler, der den AOT-Pfad bricht."
pubDate: 2026-09-01
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "dotnet-11"
  - "containers"
  - "docker"
  - "native-aot"
  - "deployment"
lang: "de"
translationOf: "2026/09/framework-dependent-vs-self-contained-vs-native-aot-for-a-dotnet-11-container-image"
translatedBy: "claude"
translationDate: 2026-09-01
---

Für einen gewöhnlichen, langlaufenden ASP.NET Core Dienst unter .NET 11 veröffentlichen Sie **framework-abhängig auf einem chiseled `aspnet`-Image**. Das ist das Kleinste, was Sie tatsächlich ausliefern (ein paar Megabyte Anwendung auf einer Laufzeit-Schicht, die Ihre anderen Dienste ohnehin schon geladen haben), und eine Laufzeit-CVE wird durch einen Rebuild auf einem neuen Basis-Image-Tag behoben statt durch Rebuild, erneutes Testen und erneutes Deployment der Anwendung. Wechseln Sie zu **eigenständig plus Trimming**, wenn die Anwendung einen bestimmten Laufzeit-Patch festschreiben oder auf einem Basis-Image ganz ohne .NET laufen muss. Greifen Sie nur dann zu **Native AOT**, wenn Kaltstart oder Speicher pro Pod die dominierende Einschränkung ist und `dotnet publish` über den gesamten Abhängigkeitsbaum keine AOT-Warnung meldet. Die Größenangaben, die für AOT herumgereicht werden, stimmen, aber für eine Flotte messen sie das Falsche: framework-abhängige Images teilen sich eine einzige Laufzeit-Schicht über alle Dienste eines Knotens, eigenständige und AOT-Images nicht.

Alles hier zielt auf `<TargetFramework>net11.0</TargetFramework>`. .NET 11 steht beim Schreiben dieses Textes bei Preview 7 (`11.0.100-preview.7.26381.103`, veröffentlicht am 2026-08-11), [die finale Version wird für November 2026 erwartet](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/overview). Preview-Image-Tags tragen einen `-preview`-Qualifizierer, den die finale Version fallen lässt, aus `11.0-preview-resolute-chiseled` wird im November also `11.0-resolute-chiseled`. Die Mechanik unten ist seit .NET 8 stabil, fast alles gilt daher unverändert für .NET 9 und .NET 10.

## Die drei Modi als Container-Images

| Eigenschaft | Framework-abhängig | Eigenständig + Trimming | Native AOT |
| --- | --- | --- | --- |
| Basis-Image-Repository | `dotnet/aspnet` oder `dotnet/runtime` | `dotnet/runtime-deps` | `dotnet/runtime-deps` |
| Die Laufzeit liegt in | der Basis-Image-Schicht | Ihrer Anwendungsschicht | in die Binärdatei kompiliert |
| Laufzeit-Schicht über Dienste geteilt | Ja | Nein | Nein |
| Laufzeit-CVE behoben durch | neues Basis-Tag ziehen, Rebuild | neues SDK, Rebuild, Retest, Redeployment | neues SDK, Rebuild, Retest, Redeployment |
| Rollt auf installierten Patch vor | Ja | Nein | Nein |
| Aktiviert durch | nichts (ist der Standard) | `--self-contained -p:PublishTrimmed=true` | `-p:PublishAot=true` |
| Benötigt eine RID | Nein | Ja | Ja |
| Build-Host braucht C-Toolchain | Nein | Nein | Ja (clang, zlib1g-dev) |
| Reflection, `Reflection.Emit`, Plugin-Laden | Vollständig | Trimming-Warnungen, Laufzeitfehler möglich | Eingeschränkt oder nicht verfügbar |
| Beispiel-Image, komprimiert | 52,81 MB | 21,86 MB | 11,60 MB |

Die letzten drei Zahlen stammen aus dem [.NET Container-Image-Größenbericht](https://github.com/dotnet/dotnet-docker/blob/main/documentation/sample-image-size-report.md) in `dotnet/dotnet-docker`, gemessen am Beispiel `releasesapi` gegen .NET 10.0 mit `noble-chiseled`-Basis-Images. Die vollständigen Details gleich, denn genau diese Zeile führt in die Irre.

## Was jeder Modus tatsächlich ins Image legt

Das Container-Tooling des SDK leitet das Basis-Image aus Ihrem Projekt ab, und die Regel ist kurz. [Laut der Containerisierungsreferenz](https://learn.microsoft.com/en-us/dotnet/core/containers/publish-configuration) bekommt ein eigenständiges Projekt `mcr.microsoft.com/dotnet/runtime-deps`, ein ASP.NET Core Projekt bekommt `mcr.microsoft.com/dotnet/aspnet`, und alles andere bekommt `mcr.microsoft.com/dotnet/runtime`. Das Tag ist der numerische Teil Ihres TFM, mit `ContainerFamily` als angehängtem Suffix.

Diese Ableitung ist die ganze Geschichte:

- **Framework-abhängig** landet auf `aspnet`, also `runtime-deps` plus .NET-Laufzeit plus dem Shared Framework von ASP.NET Core. Ihre Schicht enthält IL-Assemblies und statische Assets, typischerweise einstellige Megabyte.
- **Eigenständig** landet auf `runtime-deps`, das nur die nativen Bibliotheken enthält, die .NET braucht (libc, OpenSSL und Konsorten), und gar kein .NET. Ihre Schicht trägt die komplette Laufzeit und das Shared Framework, und deshalb ist Trimming hier so wichtig.
- **Native AOT** landet ebenfalls auf `runtime-deps`, aber Ihre Schicht ist eine einzige native ausführbare Datei ohne IL und ohne JIT. Beachten Sie, dass es das Suffix `-aot` auf `runtime-deps` nicht mehr gibt: es existierte für .NET 8, und in .NET 10 wurden die AOT-spezifischen runtime-deps-Tags in die normalen `-chiseled`-Tags überführt. Das Suffix `-aot` lebt jetzt auf den **SDK**-Images (`sdk:11.0-preview-aot`, `sdk:11.0-preview-resolute-aot`), die die clang- und zlib-Toolchain mitbringen, die der AOT-Compiler zur Buildzeit braucht.

Alle drei erben dieselbe Härtung der Microsoft-Images: den Nicht-Root-Benutzer `app` mit UID 1654, über `$APP_UID` verfügbar, und Port 8080 statt 80, beides [mit .NET 8 eingeführt](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-8/containers). Chiseled-Images liefern zusätzlich keine Shell, keinen Paketmanager und kein `curl` mit, Debugging per `docker exec` und Shell-basierte Health Checks funktionieren also in keinem der drei Modi, sobald Sie eine chiseled Familie wählen.

## Wie Sie jeden der drei veröffentlichen

Framework-abhängig, ohne RID, direkt auf eine chiseled ASP.NET Core Basis:

```bash
# .NET 11 SDK 11.0.100-preview.7. Framework-dependent onto aspnet:11.0-preview-resolute-chiseled.
dotnet publish --os linux --arch x64 /t:PublishContainer \
  -p ContainerFamily=resolute-chiseled \
  -p ContainerRepository=orders-api
```

Eigenständig mit Trimming. `PublishTrimmed` impliziert `SelfContained`, aber schreiben Sie beides aus, damit ein späterer Leser sich das nicht merken muss:

```bash
# .NET 11 SDK 11.0.100-preview.7. Self-contained + trimmed onto runtime-deps:11.0-preview-resolute-chiseled.
dotnet publish --os linux --arch x64 /t:PublishContainer \
  --self-contained \
  -p PublishTrimmed=true \
  -p ContainerFamily=resolute-chiseled \
  -p ContainerRepository=orders-api
```

Native AOT. `PublishAot` impliziert eigenständig und braucht die C-Toolchain der Plattform auf der Build-Maschine:

```bash
# .NET 11 SDK 11.0.100-preview.7. Native AOT onto runtime-deps:11.0-preview-resolute-chiseled.
# Requires clang and zlib1g-dev locally, or build inside sdk:11.0-preview-aot.
dotnet publish --os linux --arch x64 /t:PublishContainer \
  -p PublishAot=true \
  -p ContainerFamily=resolute-chiseled \
  -p ContainerRepository=orders-api
```

Wenn Sie das lieber aus der CI heraus tun, ohne clang auf dem Agent zu installieren: dafür gibt es die AOT-Images des SDK:

```dockerfile
# .NET 11 preview. Multi-stage AOT build.
FROM mcr.microsoft.com/dotnet/sdk:11.0-preview-resolute-aot AS build
WORKDIR /src
COPY . .
RUN dotnet publish OrdersApi/OrdersApi.csproj -c Release -r linux-x64 -p:PublishAot=true -o /app

FROM mcr.microsoft.com/dotnet/runtime-deps:11.0-preview-resolute-chiseled
WORKDIR /app
COPY --from=build /app/OrdersApi .
USER $APP_UID
ENTRYPOINT ["./OrdersApi"]
```

Die vollständige Menge der `Container*`-Eigenschaften, die Tag-Steuerung und die Registry-Authentifizierung beschreibt der Durchgang zum [Veröffentlichen einer .NET 11 Anwendung als Container-Image ohne Dockerfile](/de/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/).

## Die veröffentlichten Größenzahlen

Microsoft veröffentlicht gemessene Größen für eine minimale Beispiel-Web-API über alle Basis-Image-Varianten hinweg, Spekulation ist also unnötig. Dies sind die komprimierten Größen des Beispiels `releasesapi` unter .NET 10.0:

| Basis-Image | Framework-abhängig | Eigenständig + Trimming | Native AOT |
| --- | --- | --- | --- |
| Vollständiges Ubuntu (`10.0`) | 92,48 MB | 61,53 MB | 51,27 MB |
| `10.0-noble-chiseled` | 52,81 MB | 21,86 MB | 11,60 MB |
| `10.0-noble-chiseled-extra` | 67,68 MB | 36,82 MB | 26,56 MB |
| `10.0-alpine` | 51,93 MB | 20,95 MB | 10,69 MB |
| `10.0-alpine-extra` | 66,50 MB | 35,52 MB | 25,25 MB |

Zwei Dinge fallen sofort aus dieser Tabelle. Erstens: **die Basis-Image-Familie ist ein größerer Hebel als der Deployment-Modus**. Eine framework-abhängige Anwendung vom vollständigen Ubuntu-Image auf `noble-chiseled` zu ziehen spart 39,67 MB, mehr als dieselbe Anwendung auf dem vollständigen Image von framework-abhängig auf Native AOT umzustellen einspart (41,21 MB), und es kostet keine der Kompatibilitätsarbeit. Wenn Sie noch nicht auf chiseled sind, tun Sie das zuerst und messen Sie neu, bevor Sie irgendetwas anderes erwägen.

Zweitens: chiseled Native AOT ist tatsächlich rund 4,5-mal kleiner als chiseled framework-abhängig. Das ist ein echter Gewinn, und für eine Scale-to-Zero-Funktion oder einen Knoten mit sehr hoher Dichte ist er ausschlaggebend.

## Die Layer-Rechnung, die das Größenargument umdreht

Hier ist der Teil, den der Größenbericht nicht zeigen kann, weil er ein Image isoliert misst.

Container-Images sind inhaltsadressierte Layer. Wenn zehn Ihrer Dienste alle `FROM mcr.microsoft.com/dotnet/aspnet:11.0-preview-resolute-chiseled` bauen, zieht und speichert jeder Knoten, der sie ausführt, diese Laufzeit-Schicht genau einmal. Die Grenzkosten des elften Dienstes sind seine eigene Anwendungsschicht, für einen framework-abhängigen ASP.NET Core Dienst also ein paar Megabyte IL.

Rechnen Sie das für zehn Dienste auf einem Knoten durch, mit der chiseled Spalte von oben:

- **Framework-abhängig**: rund 50 MB geteilte `aspnet`-Layer, plus 10 Anwendungsschichten von je etwa 3 MB. Sagen wir 80 MB.
- **Eigenständig getrimmt**: eine geteilte `runtime-deps`-Schicht von wenigen Megabyte, plus 10 Anwendungsschichten, die jeweils ihre eigene getrimmte Kopie der Laufzeit tragen. Grob 10 x 20 MB, also etwa 200 MB.
- **Native AOT**: dieselbe Form, 10 x 11 MB, also etwa 110 MB.

Eigenständig ist im Flottenmaßstab der schlechteste der drei, obwohl es bei einem einzelnen Image framework-abhängig um den Faktor 2,4 schlägt, denn Trimming ist anwendungsspezifisch und kann nicht über Anwendungen hinweg deduplizieren. Native AOT ist klein genug, um vorn zu bleiben, aber sein Vorsprung schrumpft von 4,5-fach auf deutlich unter das Doppelte. Registry-Speicher, Pull-Bandbreite über Availability Zones hinweg und Plattendruck auf dem Knoten folgen dieser zweiten Rechnung, nicht der ersten. Messen Sie Ihre eigene Flotte, bevor Sie irgendetwas aus Größengründen migrieren.

## Patching: wer eine Laufzeit-CVE behebt

Das ist das Argument, das für die meisten Teams tatsächlich entscheiden sollte, und es steht unmissverständlich in der [Veröffentlichungsübersicht](https://learn.microsoft.com/en-us/dotnet/core/deploying/). Eine framework-abhängige Anwendung "rollt automatisch auf den neuesten in der Umgebung verfügbaren .NET-Sicherheitspatch vor", während eine eigenständige Bereitstellung "nicht vorrollt" und "die .NET-Laufzeit nur durch die Veröffentlichung einer neuen Version der Anwendung aktualisiert werden kann".

In Container-Begriffen:

- **Framework-abhängig**: wenn Microsoft einen Out-of-Band-Laufzeitfix ausliefert, taggen Sie neu, bauen neu und deployen neu. Ihr Code ist byteidentisch, die Änderung ist also mechanisch sicher. Eine Automatisierung für Basis-Image-Updates (Dependabot, Renovate) erledigt das ohne Menschen, und ein PR pro Repository deckt es ab.
- **Eigenständig und Native AOT**: die Laufzeit steckt in Ihrer Anwendungsschicht, der Fix erfordert also ein neues SDK auf dem Build-Agent, einen vollständigen Rebuild und einen vollständigen Testdurchlauf, pro Dienst. Bei AOT bedeutet das zusätzlich das Neukompilieren von nativem Code, der langsamste Build, den Sie besitzen.

Wenn Ihre Organisation eine Vorgabe "kritische CVEs innerhalb von N Tagen patchen" hat, ist dieser Unterschied keine Fußnote. Er ist der Grund, framework-abhängig zu bleiben, solange Sie nichts zwingt.

## Globalisierung ist der versteckte Schalter zwischen chiseled und chiseled-extra

Einfache `-chiseled`-, `-alpine`- und Azure Linux `-distroless`-Images kommen ohne ICU und tzdata, sie funktionieren also nur für Anwendungen im Globalization Invariant Mode. Die `-extra`-Varianten bringen ICU, tzdata und `libstdc++` zurück, und genau daher kommen die 15 MB Differenz in der Größentabelle.

Bei eigenständigen und AOT-Veröffentlichungen versucht das SDK zu helfen: ist `InvariantGlobalization` false, lenkt es Sie auf eine `-extra`-Variante. Bei framework-abhängigen Veröffentlichungen wählen Sie die Familie selbst, es liegt also an Ihnen, die Eigenschaft passend zu setzen:

```xml
<!-- .NET 11, net11.0. Required if you target a plain -chiseled or -alpine base. -->
<PropertyGroup>
  <InvariantGlobalization>true</InvariantGlobalization>
</PropertyGroup>
```

Machen Sie das falsch, stirbt der Container beim Start mit `Couldn't find a valid ICU package installed on the system`, wofür es [einen eigenen Fix-Artikel](/de/2026/07/fix-couldnt-find-a-valid-icu-package-installed-on-the-system/) gibt. Und der Invariant Mode ist nicht kostenlos: kultursensitiver Zeichenkettenvergleich, `ToUpper` und `ToLower` für Nicht-ASCII sowie `TimeZoneInfo`-Abfragen ändern ihr Verhalten. Wenn Sie irgendetwas lokalisieren oder Währungen formatieren, zahlen Sie die 15 MB für `-extra`.

## Der .NET 11 Stolperstein: die Basis-Image-Ableitung sagt weiterhin noble

Das Container-Tooling berechnet den Ubuntu-Codenamen für das abgeleitete Tag aus der SDK-Version, und in den .NET 11 Previews kennt diese Zuordnung nur `jammy` (SDK unter 8.0.300) und `noble` (8.0.300 und höher). Da `11.0.100` die zweite Bedingung erfüllt, liefert sie `noble`, .NET 11 Images auf MCR erscheinen aber unter `resolute` (Ubuntu 26.04). Das Ergebnis, [gemeldet als dotnet/sdk#53553](https://github.com/dotnet/sdk/issues/53553):

```console
error CONTAINER1015: Unable to access the repository 'dotnet/runtime-deps' at tag '11.0.0-preview.2-noble-chiseled-extra'
```

Der Schadensradius sind genau die Pfade, um die es in diesem Artikel geht. Framework-abhängiges Veröffentlichen ist unbetroffen, weil es den Codename-Ableitungszweig nicht durchläuft. Getrimmt eigenständige und `PublishAot=true`-Veröffentlichungen laufen beide hinein. Die Lösung ist, sich nicht auf die Ableitung zu verlassen und die Familie explizit zu benennen, weshalb alle Kommandos oben sie mitgeben:

```bash
# .NET 11 SDK 11.0.100-preview.7. Explicit family, no codename inference.
dotnet publish --os linux --arch x64 /t:PublishContainer \
  -p PublishAot=true \
  -p ContainerFamily=resolute-chiseled
```

`ContainerBaseImage` auf einen vollqualifizierten Namen zu setzen funktioniert ebenfalls und umgeht `ContainerFamily` vollständig. Die Familie explizit festzuschreiben ist ohnehin gute Praxis: sie hindert ein künftiges SDK daran, Ihre Flotte still auf eine andere Distribution zu verschieben. Die [Tag-Rotation von Ubuntu 26.04](/de/2026/04/dotnet-10-ubuntu-2604-resolute-container-tags/) ist dieselbe Lektion von der .NET 10 Seite.

## Die Einschränkung, die für Sie entscheidet

Die meisten Teams kommen nie zum Abwägen der Größen, weil eine harte Einschränkung entscheidet:

- **Reflection-lastige Abhängigkeiten.** Dynamische Proxys, reflectionbasierte Serialisierer, DI-Container mit Codegenerierung zur Laufzeit, Plugin-Laden. Native AOT scheidet aus, Trimming ist riskant. Behandeln Sie die Publish-Warnungen als das eigentliche Go/No-Go-Signal, nicht die Dokumentation. [Trim-sicherer Code](/de/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/) ist die Voraussetzung für beides.
- **Eine Compliance-Frist für CVE-Behebung.** Framework-abhängig, weil ein Basis-Image-Update eine mechanische Änderung ist und ein Rebuild nicht.
- **Scale-to-Zero oder Abrechnung pro Anfrage.** Der Kaltstart dominiert die Rechnung. Native AOT startet rund dreimal schneller als der normale JIT und braucht weniger als die Hälfte des Working Sets, gemäß den Messungen in [Native AOT vs. ReadyToRun vs. JIT in .NET 11](/de/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/).
- **Ein Build-Artefakt für mehrere Plattformen.** Framework-abhängig ohne RID ist der einzige Modus, der ein einziges Artefakt erzeugt; die anderen beiden sind RID-spezifisch und brauchen eine Build-Matrix.
- **Ein Basis-Image ohne .NET, das Sie nicht kontrollieren.** Eigenständig, denn es ist der einzige Modus, der auf einem beliebigen Distributions-Image mit den richtigen nativen Bibliotheken und sonst nichts läuft.

## Empfehlung, noch einmal

Standard ist **framework-abhängig auf `aspnet:11.0-<family>-chiseled`**. Es ist das billigste Image im Flottenmaßstab, es ist der einzige Modus, in dem eine Laufzeit-CVE ein Basis-Image-Update statt eines Releases ist, und es ist der einzige, der ein einziges RID-unabhängiges Artefakt liefert. Wechseln Sie zu **Native AOT auf `runtime-deps:11.0-<family>-chiseled`**, wenn Kaltstart oder Speicherdichte die bindende Einschränkung ist und Ihr Abhängigkeitsbaum sauber veröffentlicht. Nehmen Sie **eigenständig plus Trimming** als Mittelweg, wenn Sie die Laufzeitversion festschreiben oder ein Basis-Image ohne .NET brauchen, im Bewusstsein, dass es für flottenweiten Speicher der schlechteste der drei ist. Was immer Sie wählen: setzen Sie `ContainerFamily` explizit, und stellen Sie das Image auf chiseled um, bevor Sie irgendetwas anderes optimieren.

## Verwandt

- [Wie Sie eine .NET 11 Anwendung mit dotnet publish /t:PublishContainer als Container-Image veröffentlichen](/de/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/) behandelt die vollständige `Container*`-Eigenschaftsfläche, auf die sich diese Kommandos stützen.
- [Native AOT vs. ReadyToRun vs. JIT in .NET 11](/de/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) ist der Vergleich der Kompilierungsmodelle unter diesem Verpackungsvergleich, mit Start- und Durchsatzmessungen.
- [Was ist Native AOT und was kostet es Sie?](/de/2026/06/what-is-native-aot-and-what-does-it-cost-you/) zählt die API- und Bibliothekseinschränkungen auf, bevor Sie sich festlegen.
- [Was ist trim-sicherer Code und wie schreibe ich ihn?](/de/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/) ist die Voraussetzung sowohl für getrimmt eigenständig als auch für AOT.
- [Was ist der Unterschied zwischen dotnet build und dotnet publish?](/de/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/) erklärt, warum all das ausschließlich zur Veröffentlichungszeit passiert.

## Quellen

- [Übersicht zur Veröffentlichung von .NET Anwendungen](https://learn.microsoft.com/en-us/dotnet/core/deploying/), MS Learn (Abwägungen framework-abhängig gegen eigenständig, Roll-Forward, AOT).
- [Referenz zur Containerisierung einer .NET Anwendung](https://learn.microsoft.com/en-us/dotnet/core/containers/publish-configuration), MS Learn (`ContainerBaseImage`-Ableitung, `ContainerFamily`, `ContainerUser`).
- [.NET Container-Images](https://learn.microsoft.com/en-us/dotnet/core/docker/container-images), MS Learn (Repositories, chiseled- und extra-Varianten, Globalisierung).
- [Größenbericht der Beispiel-Images](https://github.com/dotnet/dotnet-docker/blob/main/documentation/sample-image-size-report.md), `dotnet/dotnet-docker` (gemessene Größen für das Beispiel `releasesapi`).
- [Basis-Image-Ableitung verwendet für .NET 11 den falschen Ubuntu-Codenamen](https://github.com/dotnet/sdk/issues/53553), `dotnet/sdk` (CONTAINER1015, Workaround mit `ContainerFamily`).
- [Neues bei Containern in .NET 8](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-8/containers), MS Learn (Nicht-Root-Benutzer `app`, `APP_UID`, Port 8080).
- [Neues in .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/overview), MS Learn (Preview-Status, Termin der finalen Version, SDK-Containeränderungen).
