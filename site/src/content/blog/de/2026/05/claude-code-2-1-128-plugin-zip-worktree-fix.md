---
title: "Claude Code 2.1.128 lädt Plugins aus .zip-Archiven und verliert keine ungepushten Commits mehr"
description: "Claude Code v2.1.128 (4. Mai 2026) bringt --plugin-dir-Unterstützung für .zip-Archive, lässt EnterWorktree den Branch vom lokalen HEAD aus erstellen und verhindert, dass der CLI seinen eigenen OTLP-Endpunkt an Bash-Subprozesse weitergibt."
pubDate: 2026-05-05
tags:
  - "claude-code"
  - "ai-agents"
  - "cli"
lang: "de"
translationOf: "2026/05/claude-code-2-1-128-plugin-zip-worktree-fix"
translatedBy: "claude"
translationDate: 2026-05-05
---

Claude Code v2.1.128 erschien am 4. Mai 2026 mit drei Änderungen, die unauffällig Workflow-Probleme beheben, die viele von uns hatten, ohne es zu bemerken: Plugins lassen sich jetzt direkt aus einem `.zip` laden, `EnterWorktree` erstellt den Branch endlich vom lokalen `HEAD` statt von `origin/<default>`, und Subprozesse erben die `OTEL_*`-Umgebungsvariablen des CLI nicht mehr. Keine ist spektakulär, aber alle entfernen eine ganze Kategorie von "warte, warum ist das gerade passiert?".

## `--plugin-dir` akzeptiert jetzt gezippte Plugin-Archive

Bis v2.1.128 akzeptierte `--plugin-dir` nur ein Verzeichnis. Wenn Sie ein internes Plugin mit einem Kollegen teilen oder eine Version festpinnen wollten, mussten Sie es in einen Marketplace pushen, den entpackten Baum ins Repository committen oder ein Wrapper-Skript schreiben, das vor dem Start entpackt. Nichts davon skalierte über ein oder zwei Plugins hinaus.

Das neue Verhalten ist genau das, was Sie erwarten:

```bash
# Old: had to point at an unpacked directory
claude --plugin-dir ./plugins/my-team-tooling

# New in v2.1.128: zip works directly
claude --plugin-dir ./plugins/my-team-tooling-1.4.0.zip

# Mix and match in the same launch
claude \
  --plugin-dir ./plugins/local-dev \
  --plugin-dir ./dist/release-bundle.zip
```

Es gibt auch eine Korrektur in diesem Release, die dazu passt. Das `/plugin` Components-Panel zeigte für Plugins, die über `--plugin-dir` geladen wurden, früher "Marketplace 'inline' not found". v2.1.128 stoppt das. Und das `init.plugin_errors`-JSON im Headless-Modus meldet jetzt Ladefehler von `--plugin-dir` (beschädigtes Zip, fehlendes Manifest) zusätzlich zu den bestehenden Fehlern bei der Herabstufung von Abhängigkeiten, damit CI-Skripte laut fehlschlagen können, statt stillschweigend einen kaputten Plugin-Satz auszuliefern.

## `EnterWorktree` verliert Ihre ungepushten Commits nicht mehr

Das ist ein echter Bugfix, verkleidet als Verhaltensänderung. `EnterWorktree` ist das Tool, mit dem Claude Code einen isolierten Worktree für eine Agent-Aufgabe erstellt. Vor diesem Release wurde der neue Branch von `origin/<default-branch>` aus erstellt, was vernünftig klingt, bis Ihnen klar wird, was es bedeutet: Jeder Commit, den Sie lokal auf `main` hatten, aber noch nicht gepusht hatten, war einfach nicht Teil des Worktree, den der Agent sah.

In v2.1.128 erstellt `EnterWorktree` den Branch vom lokalen `HEAD` aus, was die Dokumentation ohnehin schon behauptete. Konkret:

```bash
# You're on main with a local-only commit
git log --oneline -2
# a1b2c3d feat: WIP rate limiter (NOT pushed)
# 9876543 chore: bump deps (origin/main)

# Agent calls EnterWorktree
# v2.1.126 and earlier: branch starts at 9876543, your WIP commit is GONE
# v2.1.128: branch starts at a1b2c3d, the agent sees your WIP
```

Wenn jemals eine lange laufende Agent-Aufgabe stillschweigend die Änderung übersprungen hat, die Sie vor fünf Minuten gemacht haben, ist das wahrscheinlich der Grund.

## OTEL-Umgebungsvariablen lecken nicht mehr in Subprozesse

Claude Code selbst ist OpenTelemetry-instrumentiert und liest `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME` und andere aus der Umgebung. Bis v2.1.128 wurden diese Variablen von jedem Subprozess vererbt, den der CLI startete: Bash-Tool-Aufrufe, Hooks, MCP-Server, LSP-Prozesse. Wenn Sie eine .NET-Anwendung über das Bash-Tool ausführten, die selbst OTel-instrumentiert war, schickte sie ihre Traces fröhlich an den Collector des CLI.

Der Fix in v2.1.128 entfernt `OTEL_*` aus der Umgebung vor dem exec. Ihre Anwendungen verwenden jetzt den OTLP-Endpunkt, mit dem sie konfiguriert wurden, nicht den, an den Ihr Editor zufällig meldet. Wenn Sie wirklich möchten, dass ein Kindprozess den Collector des CLI mitnutzt, setzen Sie die Variable explizit in Ihrem Run-Skript.

Einige weitere bemerkenswerte Punkte: Bloßes `/color` wählt jetzt eine zufällige Sitzungsfarbe, `/mcp` zeigt die Anzahl der Tools pro Server und markiert die, die sich mit null Tools verbunden haben, parallele Shell-Tool-Aufrufe brechen Geschwister-Aufrufe nicht mehr ab, wenn ein Read-only-Befehl (`grep`, `git diff`) fehlschlägt, und die Fortschrittszusammenfassungen von Sub-Agenten treffen endlich den Prompt-Cache, was die `cache_creation`-Kosten bei stark ausgelasteten Multi-Agent-Läufen um etwa das Dreifache reduziert. Der Vim-Modus erhielt außerdem einen kleinen, aber korrekten Fix: `Space` im NORMAL-Modus bewegt den Cursor nach rechts, was dem echten vi-Verhalten entspricht.

Das setzt den Trend fort, den das [v2.1.126-Release mit project purge](/de/2026/05/claude-code-2-1-126-project-purge/) begonnen hat: kleine, gezielte CLI-Änderungen, die stumpfe Werkzeuge aus den Händen des Benutzers nehmen. Vollständige Hinweise auf der [v2.1.128-Release-Seite](https://github.com/anthropics/claude-code/releases/tag/v2.1.128).
