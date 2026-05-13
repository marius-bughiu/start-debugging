---
title: "Fehlerbehebung: The command 'dotnet' could not be found auf CI"
description: "Ihr CI-Runner kann dotnet nicht auflösen, weil das SDK für diesen Schritt nicht installiert ist oder zwar installiert, aber nicht im PATH liegt. Verwenden Sie actions/setup-dotnet, fixieren Sie ein global.json und exportieren Sie DOTNET_ROOT und ~/.dotnet/tools."
pubDate: 2026-05-13
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "ci"
  - "github-actions"
  - "azure-pipelines"
lang: "de"
translationOf: "2026/05/fix-the-command-dotnet-could-not-be-found-on-ci"
translatedBy: "claude"
translationDate: 2026-05-13
---

Die Lösung: Ein CI-Schritt führt `dotnet` in einer Shell aus, in der das SDK entweder nicht installiert ist, nicht im `PATH` liegt oder auf eine Version fixiert ist, die Ihre `global.json` ausschließt. In GitHub Actions fügen Sie vor jedem `dotnet`-Aufruf einen Schritt `actions/setup-dotnet@v4` ein, committen eine `global.json`, die zum angeforderten SDK passt, und exportieren in Linux-Containern `DOTNET_ROOT` sowie `$HOME/.dotnet/tools`. Der Fehler liegt fast nie im Runner-Image.

```text
/bin/bash: line 1: dotnet: command not found
##[error]Process completed with exit code 127.
```

oder auf Windows-Runnern:

```text
dotnet : The term 'dotnet' is not recognized as the name of a cmdlet, function, script file, or operable program.
At line:1 char:1
+ dotnet build
+ ~~~~~~
    + CategoryInfo          : ObjectNotFound: (dotnet:String) [], CommandNotFoundException
```

oder, auf Ubuntu nach `dotnet-install.sh`:

```text
Command 'dotnet' not found, but can be installed with:
sudo apt install dotnet-host
```

Diese Anleitung bezieht sich auf .NET 11 (SDK 11.0.100), `actions/setup-dotnet@v4.0.1`, die `UseDotNet@2`-Task von Azure DevOps in Version 2.213.x und das `dotnet-install.sh`, wie es unter `https://dot.net/v1/dotnet-install.sh` im Mai 2026 veröffentlicht ist. Die zugrundeliegenden Ursachen haben sich seit .NET Core 3.1 nicht geändert; nur die Action-Versionen.

## Warum CI-Shells `dotnet` verlieren

Es gibt vier Ursachen. Sie sind leicht zu verwechseln, weil alle dieselbe `command not found`-Zeile zeigen, deshalb lohnt es sich, vor dem Patchen des YAML zu wissen, welche davon vorliegt.

1. **Das Runner-Image hat überhaupt kein SDK.** Container-Images wie `ubuntu:24.04`, `alpine:3.20` oder `mcr.microsoft.com/devcontainers/base:ubuntu` enthalten das .NET-SDK nicht. Von GitHub gehostete Runner (`ubuntu-latest`, `windows-latest`) enthalten es, aber die gecachte Version ist die, die das Runner-Image zufällig eingebacken hat, nicht die, die Ihr Repository benötigt.
2. **Das SDK ist installiert, aber für diesen Schritt nicht im `PATH`.** Jeder Schritt in GitHub Actions läuft in einer frischen Shell. Eine Zeile in `~/.bashrc` aus einem vorherigen Schritt überträgt sich nicht. Ein `export` von `PATH` in einem `run:`-Block leckt nicht in den nächsten `run:`-Block.
3. **Das SDK ist im `PATH`, aber `global.json` fixiert eine Version, die nicht installiert ist.** Wenn `dotnet` startet, liest es die nächste `global.json` im Verzeichnisbaum nach oben und löst ein SDK auf, das zu `version` und `rollForward` passt. Findet sich keines, erhalten Sie `error NETSDK1045` oder einen Host-Fehler, der je nach Host als „command not found"-förmige Meldung im Wrapper-Skript erscheint.
4. **Das SDK wurde von `dotnet-install.sh` in `$HOME/.dotnet` installiert, aber `DOTNET_ROOT` und `PATH` wurden nie gesetzt.** Das ist der häufigste Fehler auf selbst gehosteten Linux-Runnern und in Docker-Containern. Das Skript installiert sauber, danach exportiert kein Folgeschritt die Variablen.

## Eine minimale CI-Reproduktion

Speichern Sie dies als `.github/workflows/build.yml` und pushen Sie in ein Repository mit einer `.csproj`:

```yaml
# .github/workflows/build.yml -- .NET 11, GitHub Actions May 2026
name: build
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    container: ubuntu:24.04   # no SDK is preinstalled here
    steps:
      - uses: actions/checkout@v4
      - run: dotnet --info     # fails: dotnet: command not found
```

Der Schlüssel `container:` tauscht das Runner-Betriebssystem gegen ein nacktes Ubuntu-Image. Der Standard-Runner `ubuntu-latest` enthält das SDK, daher funktioniert das Snippet, wenn Sie `container:` entfernen. Die meisten Teams stolpern darüber, wenn sie einen Job aus Reproduzierbarkeitsgründen in einen Container verlagern und dabei vergessen, `setup-dotnet` mitzunehmen.

## Lösung 1: SDK im selben Job installieren und dann nutzen

Die kanonische Lösung in GitHub Actions ist `actions/setup-dotnet`. Setzen Sie sie vor jeden Schritt, der `dotnet` aufruft. Sie lädt das SDK in einen Cache pro Runner, stellt es allen folgenden Schritten an den Anfang des `PATH` und exportiert `DOTNET_ROOT` für Tools, die das SDK-Installationsverzeichnis direkt benötigen.

```yaml
# .github/workflows/build.yml -- setup-dotnet@v4
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-dotnet@v4
        with:
          dotnet-version: "11.0.x"
      - run: dotnet --info
      - run: dotnet build -c Release
```

Zwei Details, die wehtun:

- **`dotnet-version` akzeptiert einen Wildcard**, aber Sie sollten dennoch eine `global.json` einchecken, damit lokale Builds und CI übereinstimmen. Ohne sie können ein Entwickler mit lokal installiertem SDK 11.0.5 und CI auf 11.0.7 unterschiedliche `obj/project.assets.json` produzieren und sich gegenseitig überraschen.
- **`global-json-file:` überschreibt `dotnet-version`** in `setup-dotnet@v4`. Übergeben Sie beides, gewinnt das JSON. Das ist ein Feature, kein Bug, aber ich habe Leute gesehen, die `dotnet-version: "8.0.x"` zu einem Workflow mit `global.json` auf 11 hinzufügten und sich fragten, warum trotzdem .NET 11 installiert wird.

In Azure DevOps ist das Pendant `UseDotNet@2`:

```yaml
# azure-pipelines.yml -- Azure DevOps, UseDotNet@2
steps:
  - task: UseDotNet@2
    inputs:
      packageType: sdk
      version: "11.0.x"
  - script: dotnet build -c Release
```

In GitLab CI oder Buildkite ist der sauberste Weg ein Basis-Image mit eingebackenem SDK (`mcr.microsoft.com/dotnet/sdk:11.0`). Vermeiden Sie `dotnet-install.sh` im Job selbst, sofern nicht zwingend nötig: es funktioniert, aber jeder Job zahlt die Download-Kosten.

## Lösung 2: `global.json` einchecken, die zum CI passt

Wenn CI `dotnet build` ausführt, verwendet es das SDK, das die `global.json`-Auflösung gewinnt, nicht das neueste installierte SDK. Ein typischer Fehler sieht so aus:

```text
A compatible .NET SDK was not found.
Requested SDK version: 11.0.200
global.json file: /home/runner/work/myrepo/myrepo/global.json
Installed SDKs:
  8.0.412 [/usr/share/dotnet/sdk]
  11.0.100 [/usr/share/dotnet/sdk]
```

Der Runner hat 11.0.100; `global.json` fordert 11.0.200. Das Wrapper-Skript beendet mit einem Exit-Code ungleich null, und je nach Host kann das als „command not found" erscheinen, weil ein Bash-`if` den eigentlichen Fehler verschluckt.

Halten Sie `global.json` ehrlich:

```json
{
  "sdk": {
    "version": "11.0.100",
    "rollForward": "latestFeature"
  }
}
```

`rollForward: latestFeature` lässt einen Entwickler mit 11.0.103 arbeiten, ohne die Datei bei jedem Patch-Release anzupassen. `latestMajor` ist zu permissiv für CI, `disable` zu streng für lokal. Lassen Sie `version` mit dem übereinstimmen, was `dotnet-version` von `actions/setup-dotnet` installiert.

## Lösung 3: wenn Sie `dotnet-install.sh` verwenden müssen

Innerhalb eines abgespeckten Containers oder auf einem selbst gehosteten Runner, auf dem Sie `setup-dotnet` nicht verwenden können, installieren Sie mit dem offiziellen Skript und exportieren die Variablen anschließend in jedem Folgeschritt explizit.

```yaml
# self-hosted runner or restrictive container -- .NET 11
jobs:
  build:
    runs-on: self-hosted
    steps:
      - uses: actions/checkout@v4
      - name: Install .NET 11 SDK
        run: |
          curl -sSL https://dot.net/v1/dotnet-install.sh -o dotnet-install.sh
          chmod +x dotnet-install.sh
          ./dotnet-install.sh --channel 11.0 --install-dir "$HOME/.dotnet"
          echo "$HOME/.dotnet" >> "$GITHUB_PATH"
          echo "$HOME/.dotnet/tools" >> "$GITHUB_PATH"
          echo "DOTNET_ROOT=$HOME/.dotnet" >> "$GITHUB_ENV"
      - run: dotnet --info
      - run: dotnet tool restore && dotnet build -c Release
```

Die beiden `echo`-Zeilen schreiben in spezielle Dateien, die GitHub Actions zwischen Schritten liest: `GITHUB_PATH` stellt einen Eintrag an den Anfang des `PATH` für jeden folgenden Schritt im Job, und `GITHUB_ENV` exportiert eine Umgebungsvariable auf dieselbe Weise. `export PATH=...` innerhalb desselben `run:`-Blocks würde für den nächsten Schritt nicht greifen, und das ist die Falle, in die man tappt, wenn man ein Shell-Skript wörtlich übersetzt.

`DOTNET_ROOT` ist wichtig, auch wenn `PATH` gesetzt ist. Der Host (das Binary `dotnet`) nutzt `DOTNET_ROOT`, um die Ordner `shared/Microsoft.NETCore.App` und `sdk/` zu finden. Korrigieren Sie nur `PATH`, kann es vorkommen, dass `dotnet --info` funktioniert, aber `dotnet build` mit einem Host-Fehler über eine fehlende Laufzeit scheitert. Laut Microsoft Learn wird `DOTNET_ROOT` vom Host auf Linux und macOS und auf Windows bei nicht standardmäßiger Installation gelesen.

Fügen Sie auch das `tools`-Verzeichnis hinzu. Ohne `$HOME/.dotnet/tools` im `PATH` gelingt zwar jeder `dotnet tool install --global`-Aufruf, das Tool ist aber unerreichbar und erzeugt den verwandten Fehler: `dotnet-ef: command not found`.

## Lösung 4: vorgefertigtes SDK-Image, kein Installationsschritt

Für Docker-basiertes CI ist der reibungsärmste Weg, mit einem Image zu starten, das das SDK bereits enthält:

```yaml
# .gitlab-ci.yml -- pinned SDK image, no install step
build:
  image: mcr.microsoft.com/dotnet/sdk:11.0
  script:
    - dotnet --info
    - dotnet build -c Release
```

Spiegeln Sie das auf Buildkite, CircleCI, Jenkins-Agenten in Docker und jeder Plattform, deren CI-Primitiv „ein Container plus ein Skript" ist. Sie tauschen Flexibilität (ein Image, ein SDK) gegen die Garantie, dass `dotnet` ab dem ersten Befehl im `PATH` ist.

## Häufige Varianten und Ähnliches

Suchanfragen, die auf dieser Seite landen, zielen manchmal auf einen leicht anderen Fehler. Es lohnt sich, früh abzugrenzen, um nicht die falsche Korrektur zu jagen.

- **`dotnet-ef: command not found`**. Das globale Tool wurde installiert, aber `$HOME/.dotnet/tools` ist nicht im `PATH`. Fügen Sie es wie oben gezeigt hinzu, oder verwenden Sie ein lokales `dotnet-tools.json`-Manifest und rufen Sie `dotnet tool restore && dotnet ef` auf.
- **`Could not execute because the specified command or file was not found`**. `dotnet` ist im `PATH`, aber der Unterbefehl (`dotnet foo`) ist weder eingebaut noch als Tool installiert. Anderer Fehler, andere Ursache.
- **`error NETSDK1045: The current .NET SDK does not support targeting .NET 11.0`**. Das SDK ist im `PATH`, aber zu alt für das `TargetFramework` des Projekts. Erhöhen Sie `dotnet-version` von `setup-dotnet` (oder die `global.json`), installieren Sie kein zweites SDK neben dem ersten in der Hoffnung, dass Multi-Target-Auflösung das löst.
- **`/usr/bin/env: 'dotnet': No such file or directory`**. Dieselbe Ursache wie „command not found", andere Shell. Die Lösung ist identisch.
- **`A fatal error occurred. The required library libhostfxr.so could not be found`**. `dotnet` ist im `PATH`, aber `DOTNET_ROOT` zeigt auf ein leeres Verzeichnis, oder das SDK wurde nur teilweise installiert. Führen Sie `dotnet-install.sh` erneut aus und bestätigen Sie, dass `DOTNET_ROOT` zum tatsächlichen Installationsverzeichnis passt.

## Dinge, die wie Lösungen aussehen, aber keine sind

- **`apt install dotnet-host` in CI ausführen.** Das installiert nur den Host, nicht das SDK, und zieht ein von Microsoft signiertes `.deb`, das dem SDK-Kanal Wochen hinterherhinken kann. Nutzen Sie `setup-dotnet` oder `dotnet-install.sh`.
- **`dotnet` zur `PATH` in `~/.bashrc` hinzufügen** in einem `run:`-Schritt. CI-Schritte laufen in nicht-interaktiven Shells; `~/.bashrc` wird nicht gesourced. Verwenden Sie `GITHUB_PATH` (GitHub Actions), `task.prependpath` (Azure DevOps) oder ein Per-Schritt-Präfix `PATH=...`.
- **`sudo` auf einem gehosteten Runner.** Gehostete Runner laufen bereits als Benutzer mit passwortlosem `sudo`, aber das SDK wird in `/usr/share/dotnet` installiert, und der Wrapper unter `/usr/bin/dotnet` ist bereits da. Wenn Sie zu `sudo` greifen, damit es funktioniert, fehlt Ihnen höchstwahrscheinlich `setup-dotnet`, nicht die Berechtigung.
- **`actions/setup-dotnet` auf ein älteres Major fixieren**, weil „v4 uns kaputt gemacht hat". v4 hat Cache-Verzeichnisse geändert und parst `global.json` strenger. Der Bruch ist fast immer eine `global.json`, die auf ein nicht verfügbares SDK zeigt. Reparieren Sie das JSON; bleiben Sie nicht für immer auf v3.

## Die Lösung in CI verifizieren

Bevor Sie weitermachen, führen Sie zwei Diagnoseschritte aus. Sie sind günstig und ersparen die Jagd nach Phantomen in der `dotnet build`-Ausgabe.

```yaml
- run: which dotnet || command -v dotnet || true
- run: dotnet --info
```

`which dotnet` (oder `where dotnet` unter Windows) bestätigt, welches Binary die Shell auflöst. `dotnet --info` druckt die Laufzeit, die SDK-Liste und die aufgelöste `global.json`. Wenn `--info` erfolgreich ist, `build` aber mit „command not found" scheitert, liegt der Fehler in einem Wrapper-Skript, das Fehler verschluckt, nicht in `dotnet` selbst. Das ist der Moment, den Wrapper zu lesen, nicht neu zu installieren.

Wenn die `--info`-Ausgabe das angeforderte SDK zeigt, `Base Path:` auf das erwartete Verzeichnis zeigt und `global.json file: <Ihr Pfad>` listet, sind Sie fertig. Alles andere ist eine echte Fehlkonfiguration, die es zu beheben gilt.

## Verwandt

- Für das größere Bild, Tooling in parallelen CI-Lanes laufen zu lassen, siehe [wie man mehrere Flutter-Versionen in einer einzigen CI-Pipeline anvisiert](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/), wo derselbe `GITHUB_PATH`-Trick zum SDK-Tausch pro Matrix-Job genutzt wird.
- Wenn der Build nach gefundenem SDK fehlschlägt, schauen Sie in [warum eine veröffentlichte App keine Assemblies laden kann](/de/2026/05/fix-could-not-load-file-or-assembly-in-published-app/) für die Trim- und Runtime-Pack-Geschichte.
- Für Build-Kopierfehler im Speziellen deckt [die MSB3027-Korrektur mit Retry-Count](/de/2026/05/fix-msbuild-msb3027-could-not-copy-exceeded-retry-count/) die Antivirus- und File-Lock-Fälle ab.
- Für ein EF-Core-Tool, das aufgelöst wird, aber sich nicht an den Host anhängt, siehe [dotnet ef migrations add reparieren, wenn DbContext nicht erstellt werden kann](/de/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/).
- Für Container-basierte Integrationstests, wenn Sie eine echte Datenbank im selben Job wollen, geht [Integrationstests gegen einen echten SQL Server mit Testcontainers](/de/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) eine funktionierende Pipeline durch.

## Quellen

- [README von `actions/setup-dotnet`](https://github.com/actions/setup-dotnet), `v4.0.x`-Dokumentation zu `dotnet-version`, `global-json-file` und `cache`.
- [.NET unter Linux ohne Paketmanager installieren](https://learn.microsoft.com/en-us/dotnet/core/install/linux-scripted-manual), Microsoft Learn, behandelt `dotnet-install.sh`, `DOTNET_ROOT` und `PATH`.
- [Vom .NET-SDK und der CLI verwendete Umgebungsvariablen](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-environment-variables), Microsoft Learn, zu `DOTNET_ROOT`.
- [`global.json`-Übersicht](https://learn.microsoft.com/en-us/dotnet/core/tools/global-json), Microsoft Learn, zu den `rollForward`-Regeln.
- [Workflow-Befehle für GitHub Actions](https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions#adding-a-system-path), GitHub Docs, zu `GITHUB_PATH` und `GITHUB_ENV`.
- [`dotnet/core` Issue 5267](https://github.com/dotnet/core/issues/5267), der langlebige Upstream-Thread zu „command 'dotnet' not found, but can be installed with".
