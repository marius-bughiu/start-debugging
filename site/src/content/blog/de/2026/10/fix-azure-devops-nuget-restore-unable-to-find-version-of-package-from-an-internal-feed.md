---
title: "Fix: Azure DevOps NuGet-Restore schlägt mit \"Unable to find version 'x.y.z' of package\" bei einem internen Feed fehl"
description: "Die Version existiert, aber die Pipeline sieht sie nicht. Prüfen Sie die Feed-Rolle der Build-Identität, die Feed-Ansicht in der URL, welche nuget.config der Task verwendet, Package Source Mapping und den 30-Minuten-HTTP-Cache."
pubDate: 2026-10-29
template: error-page
tags:
  - "errors"
  - "nuget"
  - "azure-devops"
  - "dotnet"
  - "dotnet-10"
  - "ci-cd"
lang: "de"
translationOf: "2026/10/fix-azure-devops-nuget-restore-unable-to-find-version-of-package-from-an-internal-feed"
translatedBy: "claude"
translationDate: 2026-10-29
---

Die Lösung: Enthält ein Azure-Artifacts-Feed das Paket, der Pipeline-Restore meldet aber, die Version nicht zu finden, fragt der Build fast nie den Feed ab, den Sie vermuten, oder er fragt mit einer Identität ab, die diese Version nicht sehen kann. Prüfen Sie der Reihe nach: Hat die Build-Identität der Pipeline die Rolle **Feed and Upstream Reader (Collaborator)** auf dem Feed? (Die einfache Rolle **Feed Reader** kann keine Version aus einer Upstream-Quelle wie NuGet.org abrufen, die noch nicht im Feed gespeichert wurde.) Zeigt die Feed-URL auf eine Ansicht wie `@Release`, in die die Version nie hochgestuft wurde? Verwendet der Restore-Task die `nuget.config` Ihres Repositorys oder eine generierte? Leitet `packageSourceMapping` die Paket-ID an eine andere Quelle weiter? Und schließlich: Liefert ein selbst gehosteter Agent eine veraltete Versionsliste aus dem 30-Minuten-HTTP-Cache von NuGet?

Alles Folgende wurde mit dem .NET-10-SDK (10.0.302, NuGet 7.6.0) und den aktuellen Azure-DevOps-Services-Tasks (`NuGetAuthenticate@1`, `DotNetCoreCLI@2`, `NuGetCommand@2`) Stand Oktober 2026 überprüft. Dieselben Ursachen gelten für .NET 8, 9 und die .NET-11-Vorschauen, weil der Fehler vom NuGet-Resolver und vom Berechtigungsmodell des Feeds stammt, nicht von der SDK-Version.

Der Fehler tritt in zwei Formen auf, je nachdem, welcher Client den Restore ausführt. `nuget.exe restore` auf einem `packages.config`-Projekt gibt die ältere Meldung aus:

```text
// nuget.exe 6.x/7.x, packages.config restore
Unable to find version '1.5.0' of package 'Contoso.Core'.
  https://pkgs.dev.azure.com/contoso/_packaging/contoso-internal/nuget/v3/index.json: Package 'Contoso.Core.1.5.0' is not found on source 'https://pkgs.dev.azure.com/contoso/_packaging/contoso-internal/nuget/v3/index.json'.
```

`dotnet restore`, `msbuild -t:restore` und `nuget.exe` auf PackageReference-Projekten geben stattdessen `NU1102` aus. Diese Variante ist deutlich hilfreicher, weil sie zeigt, was jede Quelle tatsächlich zurückgegeben hat:

```text
// dotnet restore, .NET SDK 10.0.302
error NU1102: Unable to find package Contoso.Core with version (>= 1.5.0)
error NU1102:   - Found 1 version(s) in contoso-internal [ Nearest version: 1.4.0 ]
```

Lesen Sie die zweite Zeile genau. "Found 1 version(s)" bedeutet: Die Authentifizierung hat funktioniert und die Paket-ID wurde gefunden. Der Feed hat dem Aufrufer lediglich `1.5.0` nicht geliefert. Das grenzt das Problem auf die Frage ein, welche Versionen diese Identität über diese URL sehen darf, und genau das steuern die folgenden Ursachen.

## Warum die Version im Browser existiert, aber nicht in der Pipeline

Öffnen Sie den Feed in der Azure-DevOps-Weboberfläche, sehen Sie ihn als Ihr eigener Benutzer (oft als Feed Owner), über die Standardansicht `@Local`, mit allen aktivierten Upstream-Quellen. Die Pipeline sieht den Feed als anderer Principal, möglicherweise über eine andere URL und mit einer `nuget.config`, die Sie nicht geschrieben haben. Jeder der folgenden Punkte kann eine Version verbergen:

1. **Upstream-Versionen erfordern eine Rolle, die sie speichern darf.** Azure Artifacts liefert ein Paket aus einem Upstream (NuGet.org, ein anderer Feed) aus, indem es beim ersten Zugriff eine Kopie in Ihrem Feed speichert. Laut der [Tabelle der Feed-Berechtigungen](https://learn.microsoft.com/en-us/azure/devops/artifacts/feeds/feed-permissions) erfordert "Save packages from upstream sources" die Rolle **Feed and Upstream Reader (Collaborator)** oder höher. Eine Build-Identität mit nur **Feed Reader** kann bereits gespeicherte Versionen wiederherstellen, neue jedoch nicht. Auf Ihrem Laptop wurde `1.5.0` letzte Woche problemlos wiederhergestellt, weil Sie Collaborator sind und Ihr Restore die Version gespeichert hat. Die nächste Version, die noch niemand wiederhergestellt hat, schlägt in der CI fehl.
2. **Die falsche Build-Identität.** Eine Pipeline läuft entweder als `Project Collection Build Service (<org>)` oder als `<Project> Build Service (<org>)`. Welche der beiden, hängt von der Einstellung "Limit job authorization scope to current project" ab. Die Rolle der jeweils anderen Identität zu geben, bewirkt nichts.
3. **Eine Ansichts-URL.** `.../_packaging/contoso-internal@Release/nuget/v3/index.json` zeigt nur Versionen, die nach `@Release` hochgestuft wurden. Eine frisch veröffentlichte `1.5.0` liegt in `@Local`, bis jemand sie hochstuft.
4. **Der Task hat Ihre `nuget.config` ignoriert.** `DotNetCoreCLI@2` und `NuGetCommand@2` mit `feedsToUse: 'select'` erzeugen eine temporäre Konfiguration, die nur den in `vstsFeed` gewählten Feed enthält (plus NuGet.org, wenn `includeNuGetOrg` true ist).
5. **Package Source Mapping** leitet `Contoso.*` an eine Quelle weiter, die benötigte Version liegt aber auf einer anderen. NuGet meldet dann, dass Versionen der anderen Quelle "were not considered".
6. **Veralteter HTTP-Cache.** Auf einem selbst gehosteten Agent verwendet NuGet die zwischengespeicherte Versionsliste eines Pakets bis zu 30 Minuten lang weiter. Eine vor fünf Minuten veröffentlichte Version ist für den nächsten Lauf daher unsichtbar.
7. **Upstream-Verzögerung oder eine blockierte externe Version.** NuGet.org-Pakete können 3 bis 6 Stunden brauchen, bis sie über einen Upstream erscheinen, und bei einer Paket-ID, die Sie auch intern veröffentlichen, können externe Versionen blockiert sein.

## Minimales Repro: derselbe NU1102 mit einem lokalen Ordner-Feed

Sie brauchen kein Azure DevOps, um zu sehen, was NuGet tut, wenn eine Quelle weniger Versionen liefert als angefragt. Dieses Repro simuliert die Ursachen 1 und 3 lokal mit einer Quelle, die dem Aufrufer nur `1.4.0` "zeigt".

```bash
# .NET SDK 10.0.302, macOS/Linux shell
mkdir -p feed lib app
cd lib && dotnet new classlib -n Contoso.Core -o . -f net10.0
dotnet pack -c Release -p:Version=1.4.0 -o ../feed
cd ../app && dotnet new console -f net10.0
dotnet add package Contoso.Core --version 1.5.0 --no-restore
```

```xml
<!-- app/nuget.config, NuGet 7.6 -->
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="contoso-internal" value="../feed" />
  </packageSources>
</configuration>
```

```text
// dotnet restore output, .NET SDK 10.0.302
error NU1102: Unable to find package Contoso.Core with version (>= 1.5.0)
error NU1102:   - Found 1 version(s) in contoso-internal [ Nearest version: 1.4.0 ]
```

Das ist Byte für Byte dieselbe Form, die Sie von Azure Artifacts erhalten, wenn die Build-Identität `1.5.0` nicht aus einem Upstream speichern kann oder wenn die URL auf eine Ansicht zeigt, die nur `1.4.0` enthält. Der Restore ist nicht defekt. Er meldet getreu, was die Quelle ihm geliefert hat.

## Lösung 1: der richtigen Build-Identität die Collaborator-Rolle geben

Das ist die Ursache hinter den meisten "bei mir funktioniert es"-Meldungen, weil Entwickler meist Collaborator oder höher sind und die Build-Identität bei älteren Feeds oft nur Reader ist.

1. Ermitteln Sie, als welche Identität die Pipeline läuft. Prüfen Sie unter **Project settings > Pipelines > Settings** die Option **Limit job authorization scope to current project for non-release pipelines**. Ist sie aktiviert, lautet die Identität `<Project> Build Service (<org>)`. Ist sie deaktiviert, lautet sie `Project Collection Build Service (<org>)`. Release-Pipelines haben auf derselben Seite einen eigenen Schalter.
2. Öffnen Sie **Artifacts**, wählen Sie den Feed, klicken Sie auf das Zahnradsymbol für **Feed settings** und dann auf **Permissions**.
3. Fügen Sie diese Identität hinzu (suchen Sie nach "Build Service") und weisen Sie ihr die Rolle **Feed and Upstream Reader (Collaborator)** zu. Veröffentlicht die Pipeline auch Pakete, geben Sie beiden Build-Identitäten **Feed Publisher (Contributor)**, wie es die Dokumentation empfiehlt.
4. Liegt der Feed in einem anderen Projekt als die Pipeline und verwenden Sie die projektbezogene Identität, muss auch dieses andere Projekt der Identität mindestens **Edit project-level information** gewähren, gemäß dem Hinweis am Ende von [Manage permissions](https://learn.microsoft.com/en-us/azure/devops/artifacts/feeds/feed-permissions#pipelines-permissions).

In Azure DevOps Services gewähren neue Feeds beiden Build-Identitäten bereits die Collaborator-Rolle. Probleme haben Feeds, die vor dieser Standardeinstellung erstellt wurden, Feeds von Azure DevOps Server 2022 (wo nur die Collection-Identität die Rolle erhält) und Feeds, deren Berechtigungen jemand "verschärft" hat.

Stellen Sie anschließend sicher, dass sich die Pipeline überhaupt authentifiziert. Mit der .NET CLI ist `NuGetAuthenticate@1` der unterstützte Weg, und auf gehosteten Images ab Ubuntu 24.04 ist er Pflicht, weil `nuget.exe` dort nicht mehr unterstützt wird:

```yaml
# Azure Pipelines YAML, .NET SDK 10.0.302, NuGetAuthenticate@1
steps:
- task: UseDotNet@2
  inputs:
    packageType: sdk
    version: '10.0.x'

- task: NuGetAuthenticate@1

- script: dotnet restore MySolution.sln --configfile nuget.config
  displayName: Restore
```

`NuGetAuthenticate@1` installiert den Azure-Artifacts-Credential-Provider und übergibt ihm das Zugriffstoken des Jobs für jeden Azure-Artifacts-Feed derselben Organisation. Für einen Feed in einer anderen Organisation erstellen Sie ein PAT mit **Packaging > Read**, verpacken es in eine NuGet-Dienstverbindung und übergeben es über `nuGetServiceConnections`, wie in [Restore NuGet packages with Azure Pipelines](https://learn.microsoft.com/en-us/azure/devops/pipelines/packages/nuget-restore) gezeigt.

## Lösung 2: auf die Ansicht zeigen, die die Version tatsächlich enthält

Sehen Sie sich die Feed-URL in Ihrer `nuget.config` an. Alles nach einem `@` im Feed-Segment ist eine Ansicht:

```xml
<!-- nuget.config, NuGet 7.6: the @Release view only sees promoted versions -->
<add key="contoso-internal"
     value="https://pkgs.dev.azure.com/contoso/_packaging/contoso-internal@Release/nuget/v3/index.json" />
```

Jeder Feed beginnt mit `@Local`, `@Prerelease` und `@Release`. `@Local` enthält alles, was im Feed veröffentlicht wurde, plus alles, was aus Upstreams gespeichert wurde. `@Prerelease` und `@Release` enthalten nur, was ein Feed Publisher ausdrücklich hochgestuft hat. Stufen Sie die Version entweder hoch (Paket öffnen, **Promote** wählen, die Ansicht auswählen) oder lassen Sie die erzeugende Pipeline das als letzten Schritt erledigen. Soll der konsumierende Build nicht hochgestufte Versionen sehen, entfernen Sie das Suffix `@Release`, damit die Standardansicht des Feeds verwendet wird.

Dasselbe gilt, wenn die benötigte Version über einen Feed-zu-Feed-Upstream kommt. Die Upstream-Definition benennt eine Ansicht des anderen Feeds, sodass eine dort nicht hochgestufte Version auch über Ihren Feed unsichtbar ist.

## Lösung 3: verhindern, dass der Task Ihre nuget.config ersetzt

Dieses YAML sieht harmlos aus, verwirft aber die `nuget.config` Ihres Repositorys:

```yaml
# Azure Pipelines YAML, DotNetCoreCLI@2: generates a temporary nuget.config
- task: DotNetCoreCLI@2
  inputs:
    command: restore
    projects: '**/*.csproj'
    feedsToUse: select
    vstsFeed: 'contoso-internal'
    includeNuGetOrg: false
```

Mit `feedsToUse: select` schreibt der Task eine temporäre Konfiguration, die nur `vstsFeed` enthält (und NuGet.org bei `includeNuGetOrg: true`). Listet Ihre `nuget.config` zwei Feeds auf, verwendet sie eine projektbezogene Feed-URL mit Projektsegment oder enthält sie `packageSourceMapping`, gilt nichts davon für diesen Restore. Weisen Sie den Task an, stattdessen Ihre Datei zu verwenden:

```yaml
# Azure Pipelines YAML, DotNetCoreCLI@2 with the repo's nuget.config
- task: DotNetCoreCLI@2
  inputs:
    command: restore
    projects: '**/*.csproj'
    feedsToUse: config
    nugetConfigPath: 'nuget.config'
```

Oder verzichten Sie ganz auf den Restore-Task und führen Sie nach `NuGetAuthenticate@1` `dotnet restore --configfile nuget.config` aus, wie in Lösung 1. Das hat den Vorteil, dass die CI genau das ausführt, was ein Entwickler lokal ausführt.

Folgen Sie in dieser Datei auch Microsofts eigener Empfehlung für Upstream-Feeds: Beginnen Sie `<packageSources>` mit `<clear />` und listen Sie genau einen Azure-Artifacts-Feed mit aktivierten Upstreams auf. NuGet fragt alle Quellen parallel ab und nimmt die erste Antwort, sodass zwei Quellen Restores nichtdeterministisch machen. Ein einzelner Feed mit Upstreams durchsucht in fester Reihenfolge: zuerst die im Feed veröffentlichten Pakete, dann die aus Upstreams gespeicherten, dann jeden Upstream in der konfigurierten Reihenfolge.

## Lösung 4: Package Source Mapping prüfen

Verwendet das Repository [Package Source Mapping](https://learn.microsoft.com/en-us/nuget/consume-packages/package-source-mapping), sagt Ihnen der Fehler das direkt:

```text
// dotnet restore output, .NET SDK 10.0.302, with packageSourceMapping
error NU1102: Unable to find package Contoso.Core with version (>= 1.5.0)
error NU1102:   - Found 1 version(s) in contoso-internal [ Nearest version: 1.4.0 ]
error NU1102:   - Versions from contoso-release were not considered
```

"Were not considered" bedeutet: Die Version kann durchaus auf `contoso-release` liegen, aber kein Mapping-Muster leitet `Contoso.Core` dorthin. Jede Paket-ID wird nur gegen die Quellen aufgelöst, deren Muster zu ihr passen, wobei das spezifischste Muster gewinnt. Korrigieren Sie das Mapping:

```xml
<!-- nuget.config, NuGet 7.6 -->
<packageSourceMapping>
  <packageSource key="contoso-internal">
    <package pattern="Contoso.*" />
    <package pattern="*" />
  </packageSource>
</packageSourceMapping>
```

Bei einem einzelnen Feed mit aktivierten Upstreams ist das einfachste korrekte Mapping `*` auf diesen Feed. Mapping ist nur sinnvoll, wenn Sie tatsächlich zwei Quellen behalten, und dann muss jedes interne Präfix aufgelistet werden.

## Lösung 5: den HTTP-Cache auf selbst gehosteten Agents umgehen

Gehostete Agents starten mit leerem Cache, sodass dieser Punkt nur selbst gehostete Agents und Entwicklerrechner betrifft. Der [HTTP-Cache](https://learn.microsoft.com/en-us/nuget/consume-packages/managing-the-global-packages-and-cache-folders#http-cache) von NuGet speichert die Liste der Versionen, die jede Quelle zurückgegeben hat, und Einträge, die jünger als 30 Minuten sind, werden wiederverwendet. Veröffentlichen Sie `1.5.0` und starten den konsumierenden Build drei Minuten später auf demselben Agent, sieht der Restore weiterhin die zwischengespeicherte Liste, die bei `1.4.0` endet.

```bash
# .NET SDK 10.0.302
dotnet restore --no-http-cache
# or, for packages.config projects with nuget.exe
nuget restore MySolution.sln -NoHttpCache
# or clear it once
dotnet nuget locals http-cache --clear
```

`--no-http-cache` ist günstig genug, um es in der CI für den Schritt aktiviert zu lassen, der gerade veröffentlichte interne Pakete wiederherstellt. Greifen Sie auf einem gemeinsam genutzten Agent nicht zu `dotnet nuget locals all --clear`: Das Leeren von `global-packages` zwingt jede andere Pipeline auf diesem Rechner, alles erneut herunterzuladen.

## Lösung 6: Upstream-Latenz abwarten oder externe Versionen erlauben

Zwei Verhaltensweisen auf Feed-Seite erzeugen dasselbe "Nearest version"-Symptom bei Paketen, die von NuGet.org stammen:

- **Verzögerung bei der Weitergabe.** Die [Dokumentation zu Upstream-Quellen](https://learn.microsoft.com/en-us/azure/devops/artifacts/concepts/upstream-sources) nennt eine typische Verzögerung von 3 bis 6 Stunden zwischen einem Push nach NuGet.org und der Verfügbarkeit der Version über einen Upstream. Zwischen Azure-Artifacts-Feeds sind es meist wenige Minuten. Schlägt eine Abhängigkeit, die heute Morgen veröffentlicht wurde, fehl und die Version von letzter Woche wird wiederhergestellt, warten Sie oder fixieren Sie für einige Stunden die vorherige Version.
- **Blockierte externe Versionen.** Veröffentlichen Sie intern eine Paket-ID, die auch öffentlich existiert, kann Azure Artifacts das Speichern neuer öffentlicher Versionen dieser ID blockieren, um vor Dependency Confusion zu schützen. Ein Feed Owner kann sie pro Paket mit **Allow externally-sourced versions** auf der Paketseite erlauben oder mit dem REST-Aufruf `versionsFromExternalUpstreams: AllowExternalVersions`, der in [Safeguard against malicious public packages](https://learn.microsoft.com/en-us/azure/devops/artifacts/concepts/upstream-behavior) beschrieben ist. Planen Sie bis zu 3 Stunden ein, bis diese Änderung wirksam wird.

Prüfen Sie außerdem unter **Feed settings > Upstream sources** auf einen fehlgeschlagenen Synchronisierungsstatus. Ein defekter Upstream stoppt die Metadatenaktualisierung für jedes Paket dieses Protokolls, sodass neue Versionen auch aus gesunden Upstreams nicht mehr erscheinen.

## Fallstricke, die wie dieser Fehler aussehen, aber keiner sind

**`NU1101: Unable to find package Contoso.Core. No packages exist with this id in source(s)`.** Das ist eine andere Situation: Die ID wurde überhaupt nicht gefunden. Meist ist die Quelle falsch, der Feed ist projektbezogen und der URL fehlt das Projektsegment (`https://pkgs.dev.azure.com/<org>/<project>/_packaging/<feed>/nuget/v3/index.json`), oder Package Source Mapping schließt für diese ID jede Quelle aus.

**`NU1301: Unable to load the service index for source` oder ein `401 Unauthorized`.** Die Authentifizierung ist fehlgeschlagen, bevor die Versionsauflösung begann. Fügen Sie `NuGetAuthenticate@1` hinzu und prüfen Sie, dass die `nuget.config` des Repositorys keine `<packageSourceCredentials>` mit einem abgelaufenen PAT fest einträgt, da diese den Credential-Provider überschreiben.

**`403 Forbidden ... lacks permission to complete this action`.** Die Identität hat den Feed erreicht, besitzt dort aber gar keine Rolle. Die Lösung ist dieselbe wie Lösung 1, zusätzlich sollten Sie den Job-Autorisierungsbereich prüfen.

**Eine Version, die in einer Pipeline wiederhergestellt wird und in einer anderen nicht.** Verschiedene Pipelines können als unterschiedliche Identitäten laufen: Klassische Release-Pipelines haben einen eigenen Scope-Schalter, und YAML-Pipelines, die aus einem anderen Projekt ausgelöst werden, laufen als der Build Service dieses Projekts.

**Versionen bei Central Package Management.** Mit `Directory.Packages.props` stammt die Version in der Fehlermeldung aus der zentralen Datei, nicht aus der `.csproj`. Die Projektdatei zu "korrigieren" bewirkt also nichts. Befinden Sie sich mitten in der Migration, zeigt die Anleitung zum [Umstieg einer Solution auf Central Package Management](/de/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/), woher jede Version aufgelöst wird.

**Ein Paket, das nach einem SDK-Upgrade verschwindet.** Ist ein transitives Paket verschwunden, statt nicht aufgelöst zu werden, wurde es möglicherweise durch [NuGet Package Pruning in .NET 10](/de/2026/05/nuget-package-pruning-default-net-10/) entfernt. Das ist erwartetes Verhalten und kein Feed-Problem.

**Probleme auf der Veröffentlichungsseite.** Fehlt die Version tatsächlich im Feed, ist der Push des Produzenten fehlgeschlagen oder wurde abgelehnt. Die Versionierung mit MinVer und das Trusted-Publishing-Setup aus [mehrere NuGet-Pakete unabhängig veröffentlichen](/2026/05/independently-release-multiple-nuget-packages-with-minver-and-trusted-publishing/) machen leicht sichtbar, welche Version jedes Tag erzeugt hat. Zu den Sicherheitskontrollen auf NuGet.org-Seite, die ebenfalls Pushes blockieren, siehe [was Sie bei Ihrem NuGet-Konto absichern sollten](/de/2026/01/nuget-become-owner-request-spam-what-to-do-and-what-to-lock-down-in-net-9-net-10/).

## Eine Checkliste, die die Ursache in fünf Minuten findet

1. Lesen Sie die vollständige `NU1102`-Ausgabe. "Found N version(s)" bedeutet: Die Authentifizierung funktioniert und das Problem ist die Sichtbarkeit. "Were not considered" bedeutet Package Source Mapping.
2. Kopieren Sie die Feed-URL aus dem Restore-Log, nicht aus Ihrer lokalen `nuget.config`. Hat der Task eine temporäre Konfiguration erzeugt, zeigt das Log ihren Pfad. Wechseln Sie dann zu `feedsToUse: config`.
3. Suchen Sie in dieser URL nach `@`. Gibt es eine Ansicht, prüfen Sie, ob die Version dorthin hochgestuft wurde.
4. Suchen Sie die Version auf der Paketseite des Feeds. Fehlt sie dort, existiert aber auf NuGet.org oder in einem Upstream-Feed, wurde sie nie gespeichert: Geben Sie der Build-Identität die Collaborator-Rolle oder stellen Sie sie einmal als Collaborator wieder her, um sie zu speichern.
5. Bestätigen Sie über die Einstellung zum Job-Autorisierungsbereich, welche Build-Identität den Job ausführt, und prüfen Sie genau diese Identität auf der Seite Permissions des Feeds.
6. Führen Sie auf einem selbst gehosteten Agent den Lauf erneut mit `--no-http-cache` aus.
7. Prüfen Sie bei einem Paket, das heute auf NuGet.org veröffentlicht wurde, den Upstream-Status und die Einstellung für externe Versionen des Pakets, und warten Sie dann.

In neun von zehn Fällen lautet die Antwort Schritt 4 oder 5. Der Feed lügt nicht und NuGet ist nicht kaputt; die Pipeline ist nur ein anderer Leser als Sie.

## Quellen

- [Manage permissions - Azure Artifacts](https://learn.microsoft.com/en-us/azure/devops/artifacts/feeds/feed-permissions) (Feed-Rollen, Namen der Build-Identitäten, Hinweis zu projektübergreifenden Feeds)
- [What are upstream sources?](https://learn.microsoft.com/en-us/azure/devops/artifacts/concepts/upstream-sources) (Suchreihenfolge, Empfehlung für einen einzelnen Feed, Verzögerung von 3 bis 6 Stunden)
- [Safeguard against malicious public packages](https://learn.microsoft.com/en-us/azure/devops/artifacts/concepts/upstream-behavior) (Allow external versions)
- [Restore NuGet packages with Azure Pipelines](https://learn.microsoft.com/en-us/azure/devops/pipelines/packages/nuget-restore) (`NuGetAuthenticate@1`, Hinweis zu Ubuntu 24.04, organisationsübergreifende Feeds)
- [Feed views](https://learn.microsoft.com/en-us/azure/devops/artifacts/concepts/views)
- [NuGet Error NU1102](https://learn.microsoft.com/en-us/nuget/reference/errors-and-warnings/nu1102)
- [Package Source Mapping](https://learn.microsoft.com/en-us/nuget/consume-packages/package-source-mapping)
- [Managing the global packages, cache, and temp folders](https://learn.microsoft.com/en-us/nuget/consume-packages/managing-the-global-packages-and-cache-folders) (30-Minuten-HTTP-Cache)
- [NuGet.Client Strings.resx](https://github.com/NuGet/NuGet.Client/blob/dev/src/NuGet.Core/NuGet.PackageManagement/Strings.resx) (Meldungen `UnknownPackageSpecificVersion` und `PackageNotFoundOnSource`)
