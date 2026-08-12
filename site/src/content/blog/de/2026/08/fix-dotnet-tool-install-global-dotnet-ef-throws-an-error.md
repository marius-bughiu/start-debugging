---
title: "Fix: dotnet tool install --global dotnet-ef wirft einen Fehler"
description: "Alle Arten, auf die dotnet tool install --global dotnet-ef im .NET 10 SDK fehlschlägt, mit der exakten Meldung und dem Exit-Code zu jeder: bereits installiert, Version nicht gefunden, Downgrade blockiert, Shim-Konflikt, totes NuGet-Feed und die Laufzeit-Diskrepanz, die erst nach erfolgreicher Installation zuschlägt."
pubDate: 2026-08-12
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "dotnet-11"
  - "ef-core"
  - "entity-framework"
lang: "de"
translationOf: "2026/08/fix-dotnet-tool-install-global-dotnet-ef-throws-an-error"
translatedBy: "claude"
translationDate: 2026-08-12
---

`dotnet tool install --global dotnet-ef` schlägt aus sechs verschiedenen Gründen fehl, und das SDK gibt jedem eine andere einzeilige Meldung, ohne Stack Trace zur Unterscheidung. Lesen Sie die Zeile, nicht den Exit-Code: "Tool 'dotnet-ef' is already installed." endet mit **0** und ist überhaupt kein Fehler, während "is not found in NuGet feeds", "is lower than existing version", "conflicts with an existing command from another tool" und "No NuGet sources are defined or enabled" alle mit **1** enden und jeweils ein anderes Flag brauchen. Alles Folgende wurde am 2026-08-12 gegen SDK 10.0.201 unter Windows 11 ausgeführt, gegen das Live-Feed von nuget.org.

## Der Fehler im Kontext

Dies sind die tatsächlichen Meldungen, wörtlich aufgezeichnet. Das SDK gibt eine Zeile aus und bricht ab:

```
Tool 'dotnet-ef' is already installed.

Version 99.0.0 of package dotnet-ef is not found in NuGet feeds https://api.nuget.org/v3/index.json.

dotnet-ef-typo-xyz is not found in NuGet feeds https://api.nuget.org/v3/index.json.

The requested version 8.0.11 is lower than existing version 9.0.11.

Tool 'dotnet-ef' failed to update due to the following:
Failed to create shell shim for tool 'dotnet-ef': Command 'dotnet-ef' conflicts with an existing command from another tool.
Tool 'dotnet-ef' failed to install.

No NuGet sources are defined or enabled

Unhandled exception: Unable to load the service index for source https://nuget.invalid.example/v3/index.json.
```

Es gibt einen siebten Fehlerfall, der schlimmer ist als alle diese, weil die Installation Erfolg meldet:

```
You can invoke the tool using the following command: dotnet-ef
Tool 'dotnet-ef' (version '3.1.32') was successfully installed.
```

und das Tool sich danach weigert zu starten.

## Warum das passiert

`dotnet tool install` erledigt drei getrennte Aufgaben in einem Befehl, und jede Aufgabe hat ihre eigene Fehlerfläche. Es löst eine Paketversion aus den konfigurierten NuGet-Feeds auf, entpackt dieses Paket in den Tool-Store und schreibt eine ausführbare Shim-Datei in das Tool-Verzeichnis. Ein NuGet-Auflösungsproblem, eine Versionsreihenfolge-Regel und eine Namenskollision im Dateisystem erzeugen völlig unzusammenhängende Meldungen. Deshalb liefert die Suche nach "dotnet tool install dotnet-ef error" Ratschläge, die nicht zu dem passen, was Sie vor sich haben.

Der siebte Fall ist grundsätzlich anders. Eine Tool-Installation prüft nie, ob eine Laufzeit vorhanden ist, die das Tool ausführen kann. Das Target Framework des Pakets wird erst vom Host beim Start durchgesetzt, also installiert sich ein Tool für eine nicht vorhandene Laufzeit sauber und stirbt beim ersten Aufruf.

## Repro: jeden Fehlerfall unter SDK 10.0.201 nachstellen

Verwenden Sie zum Experimentieren `--tool-path` statt `--global`. Das isoliert jeden Fall in ein Wegwerf-Verzeichnis, statt Ihren echten Tool-Store durcheinanderzubringen, und die Fehlermeldungen sind identisch:

```bash
# SDK 10.0.201. Each block is one failure mode.
dotnet tool install --tool-path ./tp dotnet-ef --version 99.0.0
dotnet tool install --tool-path ./tp dotnet-ef-typo-xyz
dotnet tool install --tool-path ./tp dotnet-ef --version 9.0.11
dotnet tool install --tool-path ./tp dotnet-ef --version 8.0.11
```

Der dritte Befehl gelingt, der vierte gibt `The requested version 8.0.11 is lower than existing version 9.0.11.` aus und endet mit 1. Für die Shim-Kollision legen Sie zuerst eine beliebige Datei mit dem Befehlsnamen des Tools in das Zielverzeichnis:

```bash
# SDK 10.0.201
mkdir -p ./tp6 && echo dummy > ./tp6/dotnet-ef.exe
dotnet tool install --tool-path ./tp6 dotnet-ef
```

## Der Fix im Detail

Sortiert danach, wie oft Sie den jeweiligen Fall tatsächlich treffen.

### "Tool 'dotnet-ef' is already installed." ist kein Fehlschlag

Exit-Code 0. Gemessen, nicht angenommen. Der Befehl ist bewusst idempotent, also ist es korrekt, ihn ungeschützt in einem Provisioning-Skript oder einem Dockerfile stehen zu lassen, und der Build bricht dadurch nicht ab.

Verwirrend ist, dass derselbe Befehl manchmal etwas völlig anderes ausgibt:

```
Tool 'dotnet-ef' was successfully updated from version '10.0.10' to version '10.0.11'.
```

Im .NET 10 SDK aktualisiert `dotnet tool install --global dotnet-ef` ohne `--version` eine bestehende Installation auf die neueste stabile Version, statt sie abzulehnen. "already installed" erscheint nur, wenn die Zielversion genau die bereits installierte ist. Wenn Sie eine feste Version wollten und ein unerwartetes Update bekommen haben, liegt es daran: Pinnen Sie sie.

```bash
# SDK 10.0.201. Both forms work; the @ syntax needs SDK 10.0.100 or later.
dotnet tool install --global dotnet-ef --version 10.0.11
dotnet tool install --global dotnet-ef@10.0.11
```

### "is not found in NuGet feeds" meint die Version, nicht das Paket

Zwei verschiedene Meldungen teilen sich diese Formulierung und bedeuten Unterschiedliches. `dotnet-ef-typo-xyz is not found in NuGet feeds ...` nennt das Paket, also ist die Paket-ID falsch oder Ihr Feed führt sie nicht. `Version 99.0.0 of package dotnet-ef is not found in NuGet feeds ...` nennt eine Version, also wurde das Paket aufgelöst und die Version existierte nicht.

Der zweite Fall ist der häufige, denn `--version 11.0.0` tut nicht, was man erwartet. Seit .NET 8 trifft `--version Major.Minor.Patch` genau diese Version, einschließlich nicht gelisteter, und gleitet nicht mit. Für die neueste 11.x nehmen Sie einen Platzhalter, und für eine Vorschauversion müssen Sie sich explizit dafür entscheiden:

```bash
# SDK 10.0.201
dotnet tool install --global dotnet-ef --version 11.0.*
dotnet tool install --global dotnet-ef --prerelease
```

Der Lauf mit `--prerelease` löste am Tag dieses Artikels `11.0.0-preview.7.26381.103` auf. Ohne das Flag sind Vorschauversionen unsichtbar, und Sie bekommen ein "not found" für eine Version, die auf nuget.org klar zu sehen ist.

### "The requested version X is lower than existing version Y"

Eine Installation über ein neueres Tool wird abgelehnt, ebenso `dotnet tool update` auf eine ältere Version. Genau dafür gibt es das Flag:

```bash
# SDK 10.0.201
dotnet tool install --global dotnet-ef --version 8.0.11 --allow-downgrade
```

Das meldet `Tool 'dotnet-ef' was successfully updated from version '9.0.11' to version '8.0.11'.` und endet mit 0. Greifen Sie dazu, wenn Sie das Tool auf eine ältere EF Core Laufzeit in einem Legacy-Branch festlegen. `dotnet tool uninstall --global dotnet-ef` gefolgt von einer frischen Installation geht auch, sind aber zwei Befehle, und Sie stehen ohne Installation da, falls der zweite fehlschlägt.

### "Failed to create shell shim ... conflicts with an existing command from another tool"

Im Tool-Verzeichnis liegt bereits eine ausführbare Datei namens `dotnet-ef`, die diese Installation nicht erzeugt hat. Die Installation bricht ab, statt sie zu überschreiben. Beachten Sie die irreführende erste Zeile: Sie sagt "failed to update", bevor sie "failed to install" sagt.

In der Praxis ist das fast immer eine halb entfernte frühere Installation oder eine `--tool-path`-Installation, die eine `--global`-Installation überdeckt. Suchen Sie die veraltete Shim-Datei und löschen Sie sie. Globale Tools liegen unter `%USERPROFILE%\.dotnet\tools` unter Windows und unter `$HOME/.dotnet/tools` unter Linux und macOS, die eigentlichen Binaries in einem `.store`-Nachbarverzeichnis:

```bash
# SDK 10.0.201
dotnet tool list --global
ls ~/.dotnet/tools
```

Zeigt `dotnet tool list --global` kein `dotnet-ef`, die Datei liegt aber dort, ist die Shim-Datei verwaist und kann gefahrlos von Hand entfernt werden.

### "No NuGet sources are defined or enabled"

Es gibt nichts, woraus wiederhergestellt werden könnte. Eine `NuGet.config` irgendwo oberhalb Ihres aktuellen Verzeichnisses enthält `<clear />` in `<packageSources>`, ohne danach etwas hinzuzufügen, oder alle Quellen sind deaktiviert. Das trifft man leicht in einem Repository, das sich auf ein privates Feed beschränkt, und übersieht es leicht, weil die störende Konfiguration mehrere Verzeichnisse höher liegen kann.

```bash
# SDK 10.0.201
dotnet nuget list source
dotnet tool install --global dotnet-ef --source https://api.nuget.org/v3/index.json
```

`--source` ersetzt für diesen einen Befehl sämtliche konfigurierten Quellen. Das ist der schnellste Weg zu bestätigen, dass die Konfiguration das Problem ist und nicht das Netzwerk.

### "Unable to load the service index for source"

Ein Feed in Ihrer Konfiguration ist nicht erreichbar, und unter SDK 10.0.201 erscheint das als rohe `Unhandled exception:`-Zeile. Es bricht die gesamte Installation ab, selbst wenn ein funktionierendes Feed weiter hinten in der Liste das Paket hat. Weisen Sie das SDK an, ein totes Feed als Warnung zu behandeln:

```bash
# SDK 10.0.201
dotnet tool install --global dotnet-ef --ignore-failed-sources
```

Mit einer Konfiguration, die ein nicht erreichbares privates Feed vor nuget.org listet, warf der nackte Befehl die Exception, und `--ignore-failed-sources` installierte 10.0.11 sauber. Liegt das Paket ausgerechnet im privaten Feed, hilft dieses Flag nicht, und Sie brauchen stattdessen `--interactive`, um die Authentifizierung abzuschließen.

### Die Installation gelingt und das Tool startet nicht

Dieser Fall kostet einen Nachmittag. Ein altes `dotnet-ef` auf einer Maschine ohne die passende Laufzeit zu installieren funktioniert problemlos, und dann:

```
You must install or update .NET to run this application.

App: ...\dotnet-ef.exe
Architecture: x64
Framework: 'Microsoft.NETCore.App', version '3.1.0' (x64)
.NET location: C:\Program Files\dotnet\

The following frameworks were found:
  6.0.36 at [C:\Program Files\dotnet\shared\Microsoft.NETCore.App]
  8.0.23 at [C:\Program Files\dotnet\shared\Microsoft.NETCore.App]
  10.0.5 at [C:\Program Files\dotnet\shared\Microsoft.NETCore.App]
```

Der Fix ist ein Flag zur Installationszeit, verfügbar seit dem .NET 9 SDK, das dem Tool erlaubt, auf einer neueren Laufzeit als der angezielten zu laufen:

```bash
# SDK 10.0.201
dotnet tool install --global dotnet-ef --version 3.1.32 --allow-roll-forward
```

Gleiches Paket, gleiche Maschine. Ohne das Flag verweigert die Shim-Datei den Start, mit ihm gibt `dotnet-ef --version` auf der Laufzeit 10.0.5 den Wert `3.1.32` aus. Es ist eine Entscheidung zur Installationszeit, die in die Shim-Datei eingebrannt wird, also muss ein bereits installiertes Tool neu installiert werden, um sie zu übernehmen.

## Was sich im .NET 10 SDK geändert hat

Drei Verhaltensweisen haben sich geändert, und alle drei erzeugen Supportfragen.

Die Installation verhält sich für ungepinnte globale Tools jetzt wie installieren-oder-aktualisieren. Deshalb schiebt ein Befehl, der auf einer bereitgestellten Maschine früher wirkungslos war, Sie nun still eine Patchversion weiter. Pinnen Sie die Version, falls das relevant ist.

Lokale Installationen scheitern nicht mehr, wenn kein Manifest vorhanden ist. Früher erzeugte `dotnet tool install dotnet-ef` ohne `-g` in einem Ordner ohne `.config/dotnet-tools.json` die Meldung "Cannot find a manifest file." Ab .NET 10 ist `--create-manifest-if-needed` standardmäßig aktiv, und das Manifest wird für Sie angelegt, und zwar im nächstgelegenen übergeordneten Verzeichnis mit einem `.git`-Unterordner. Das ist meistens richtig und gelegentlich sehr falsch: Führen Sie es in einem Downloads-Ordner oder in einem fremden Repository aus, und Sie ändern still das Manifest von jemand anderem. Abschalten lässt sich das mit `--create-manifest-if-needed=false`. Das Flag `-d`, das früher die durchsuchten Manifest-Orte ausgab, ist tot, weil der Fehler, den es kommentierte, nicht mehr existiert.

Die `@version`-Syntax kam mit SDK 10.0.100, also entspricht `dotnet-ef@10.0.11` jetzt `dotnet-ef --version 10.0.11`. Beide Formen zu mischen ist ein Fehler: `dotnet-ef@10.0.11` zusammen mit `--version` liefert "Cannot specify --version when the package argument already contains a version."

## Lässt sich dotnet-ef ausführen, ohne es zu installieren

Wenn die Installation auf einem CI-Runner scheitert, den Sie nicht kontrollieren, ist der schnellste Fix unter .NET 10, gar nicht erst zu installieren. `dotnet tool exec` und die Kurzform `dnx` laden ein Tool herunter und führen es in einem Schritt aus:

```bash
# SDK 10.0.201
dnx dotnet-ef -y -- --version
dotnet tool exec dotnet-ef --yes -- database update
```

Das `-y` bestätigt die Download-Abfrage, was Sie in jedem nicht interaktiven Kontext brauchen. Der Trenner `--` ist hier nicht optional, und der Fehler ohne ihn ist verwirrend: `dnx` parst `--version`, `--prerelease` und `--source` als eigene Optionen, also erreicht `dnx dotnet-ef --version` das Tool nie. Alles, was für `dotnet-ef` bestimmt ist, gehört hinter `--`.

Die Einmalausführung berücksichtigt auch ein lokales Manifest. Liegt in der Nähe eine `.config/dotnet-tools.json`, führt `dnx` die dort gepinnte Version aus statt der neuesten aus dem Feed, was es zu einer sinnvollen Voreinstellung für Repository-Skripte macht.

## Fallstricke und ähnlich aussehende Fehler

**"Could not execute because the specified command or file was not found"** ist ein anderes Problem. Die Installation hat funktioniert und das Shim-Verzeichnis liegt nicht in Ihrem `PATH`. Dafür gibt es eine eigene Anleitung unter [dotnet ef not found beheben](/de/2023/06/how-to-fix-command-dotnet-ef-not-found/); unter Linux ist das Tool nur aus `$HOME/.dotnet/tools` heraus ausführbar, bis Sie es selbst exportieren, und auf einem CI-Runner brauchen Sie meist zuerst [dotnet selbst im PATH](/de/2026/05/fix-the-command-dotnet-could-not-be-found-on-ci/).

**Die Warnung, dass die Tools älter sind als die Laufzeit**, schickt Leute zur Neuinstallation, obwohl nichts kaputt ist:

```
The Entity Framework tools version '8.0.11' is older than that of the runtime '10.0.5'. Update the tools for the latest features and bug fixes. See https://aka.ms/AAc1fbw for more information.
```

Das ist eine Warnung, nicht die Ursache dessen, was danach fehlschlug. Im obigen Lauf folgte darauf ein unabhängiger Fehler, "No DbContext was found in assembly". Aktualisieren Sie das Tool ruhig, aber gehen Sie nicht davon aus, dass es etwas behoben hat.

**Eine erfolgreiche Installation bedeutet nicht, dass `dotnet ef` in Ihrer Solution funktioniert.** Die beiden häufigsten Folgefehler sind der nicht auflösbare Entwurfszeit-Host, behandelt in [Unable to create an object of type DbContext](/de/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/), und das Design-Paket im falschen Projekt, behandelt in [Ihr Startprojekt referenziert Microsoft.EntityFrameworkCore.Design nicht](/de/2026/07/fix-startup-project-doesnt-reference-microsoft-entityframeworkcore-design/).

**Installieren Sie das Tool nicht auf Produktionsmaschinen, um Migrationen auszuführen.** Bauen Sie stattdessen ein Migration Bundle in der CI, das auf dem Zielsystem weder SDK noch globales Tool benötigt. Dieser Ablauf steht in [EF Core 11 Migrationen mit dotnet ef migrations bundle anwenden](/de/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/).

## Verwandt

Sobald das Tool installiert ist, verlagert sich die Reibung darauf, es in einer aufgeteilten Solution korrekt aufzurufen, und EF Core 11 hat dafür endlich eine Antwort mit [der Standardwertedatei .config/dotnet-ef.json](/de/2026/06/efcore-11-dotnet-ef-json-config-file/). Wenn Sie mitten in einem Upgrade hier gelandet sind: Die Tool-Version ist nur ein Punkt unter vielen in der [Checkliste von .NET 8 auf .NET 11](/de/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) und in den [Breaking Changes von EF Core 6 auf EF Core 11](/de/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).

## Quellen

- [Befehl dotnet tool install](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-tool-install), für die Optionsreferenz, die Tabelle der Installationsorte und die mit .NET 8 eingeführte Matching-Regel `--version Major.Minor.Patch`.
- [Breaking Change: dotnet tool install --local erstellt das Manifest standardmäßig](https://learn.microsoft.com/en-us/dotnet/core/compatibility/sdk/10.0/dotnet-tool-install-local-manifest), für den entfallenen Fehler "Cannot find a manifest file." und das Opt-out `--create-manifest-if-needed=false`.
- [Neuerungen im SDK und Tooling für .NET 10](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-10/sdk), für die Einmalausführung mit `dotnet tool exec` und das `dnx`-Skript.
- [Probleme bei der Nutzung von .NET Tools beheben](https://learn.microsoft.com/en-us/dotnet/core/tools/troubleshoot-usage-issues), für die PATH- und Shim-Diagnose.
