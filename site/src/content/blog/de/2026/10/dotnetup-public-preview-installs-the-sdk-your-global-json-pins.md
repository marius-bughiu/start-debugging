---
title: "dotnetup Public Preview: Ein Befehl installiert das SDK, das Ihre global.json festlegt"
description: "dotnetup ist am 15. Oktober 2026 in die Public Preview gegangen. Führen Sie dotnetup sdk install in einem Repository aus: Es liest global.json, ordnet rollForward einem Update-Kanal zu und kann sogar neuere Patch-Versionen in die Datei zurückschreiben."
pubDate: 2026-10-15
tags:
  - "dotnet"
  - "tooling"
  - "sdk"
  - "global-json"
lang: "de"
translationOf: "2026/10/dotnetup-public-preview-installs-the-sdk-your-global-json-pins"
translatedBy: "claude"
translationDate: 2026-10-15
---

Am 15. Oktober 2026 hat Microsoft die [Public Preview von dotnetup angekündigt](https://devblogs.microsoft.com/dotnet/introducing-dotnetup/), dem Toolchain-Manager im Stil von rustup für .NET-SDKs und -Laufzeiten. Als ich [im Juni zum ersten Mal darüber geschrieben habe](/de/2026/06/dotnetup-official-dotnet-sdk-version-manager/), musste man es aus dem Quellcode bauen, und nur `dotnetup sdk install preview` war bestätigt. Jetzt gibt es einen einzeiligen Installer, eine vollständige [Befehlsreferenz auf Microsoft Learn](https://learn.microsoft.com/dotnet/core/tools/dotnetup/) und eine Antwort auf die Frage, die mich am meisten interessiert hat: Was macht es mit `global.json`?

## dotnetup auf den Rechner bringen

Das Bootstrap-Skript lädt den neuesten `preview`-Build herunter, prüft dessen SHA-512-Prüfsumme und legt ihn in `~/.dotnetup` ab. Ohne `sudo`.

```bash
# macOS / Linux (x64 and Arm64, glibc and musl)
curl -fsSL https://aka.ms/dotnetup/get-dotnetup.sh | bash

# then, non-interactively
dotnetup install latest
dotnetup env set shell
```

Unter Windows lautet das PowerShell-Äquivalent `irm https://aka.ms/dotnetup/get-dotnetup.ps1 | iex`. Vorsicht bei den Windows-Standardwerten: `dotnetup init` schlägt den Modus `everywhere` vor, der den System-`PATH` ändert und `DOTNET_ROOT` setzt. Die verwaltete Installation hat dann Vorrang vor den SDKs, die Visual Studio installiert hat. Ein Projekt, das ein systemweites SDK benötigt, das dotnetup nicht ebenfalls besitzt, lässt sich dann nicht mehr kompilieren. Wählen Sie `shell` oder `none`, es sei denn, Sie wollen alles migrieren.

`none` ist der interessanteste Modus zum Ausprobieren. Er lässt `PATH` und `DOTNET_ROOT` unangetastet und leitet stattdessen Befehle weiter:

```bash
dotnetup env set none --dotnetup-on-path true
dotnetup dotnet -- --info
dotnetup dotnet build
```

## global.json wird zu einer nachverfolgten Anforderung

Führen Sie innerhalb eines Repositorys `dotnetup sdk install` ohne Kanal aus. Der Befehl sucht ab dem aktuellen Verzeichnis aufwärts, verwendet die nächstgelegene `global.json` und fällt auf `latest` zurück, falls keine existiert. Eine fehlerhafte Datei lässt den Befehl fehlschlagen. Er fällt nicht stillschweigend auf ein übergeordnetes Verzeichnis zurück.

```json
{
  "sdk": {
    "version": "10.0.103",
    "rollForward": "latestPatch"
  }
}
```

Das entscheidende Detail: dotnetup installiert nicht einfach nur `10.0.103`. Es wandelt `rollForward` in einen Kanal um, den `dotnetup update` fortlaufend aktualisiert:

| `rollForward` | Nachverfolgter Kanal |
| --- | --- |
| weggelassen oder `latestPatch` | `10.0.1xx` |
| `latestFeature` | `10.0` |
| `latestMinor` | `10` |
| `latestMajor` | `latest` |
| `disable`, `patch`, `feature`, `minor`, `major` | exakt `10.0.103`, wird nie aktualisiert |

`allowPrerelease` hat keinen Einfluss auf den Kanal. `dotnetup list` zeigt den Pfad der `global.json` als Quelle jeder Anforderung an, sodass Sie erkennen, welches Repository ein altes SDK am Leben hält. Wenn kein Verweis auf ein SDK mehr besteht, entfernt es das nächste Update.

## Patches in global.json zurückschreiben

Das war mir neu und ist sehr praktisch für Repositorys, die für reproduzierbare Builds exakte Patch-Versionen festlegen:

```bash
dotnetup sdk install --update-global-json
# later, across every tracked repo
dotnetup sdk update --update-global-json
```

Der Befehl installiert das neueste SDK im abgeleiteten Kanal und überschreibt nur `sdk.version`. Formatierung, andere Eigenschaften und die Textkodierung der Datei bleiben erhalten. Das ersetzt einen Pull Request im Dependabot-Stil oder eine manuelle Änderung an jedem Patch Tuesday.

## Ecken und Kanten der Preview

- Enthält `global.json` den Eintrag `sdk.paths`, installiert dotnetup in den ersten Eintrag. In dieser Preview behandelt es `$host$` als wörtlichen Pfad und überspringt keine leeren Einträge. Lassen Sie daher `sdk.paths` weg oder übergeben Sie `--install-path`.
- `dotnetup sdk uninstall 10.0.1xx --source globaljson` entfernt jede passende `global.json`-Anforderung im Installationsstamm, nicht nur die des aktuellen Repositorys.
- Eine erstklassige Integration für GitHub Actions und Azure DevOps steht noch auf der Roadmap, auch wenn die Befehle in der CI bereits nicht interaktiv laufen.

Wenn Sie mehrere Repositorys betreuen, die an unterschiedliche .NET-10-Feature-Bänder gebunden sind, ist `dotnetup sdk install` pro Repository plus ein wöchentliches `dotnetup update` schon jetzt besser als die `dotnet-install`-Skripte. Feedback geht an die [dotnetup-Diskussionen in dotnet/sdk](https://github.com/dotnet/sdk/discussions/categories/dotnetup).
