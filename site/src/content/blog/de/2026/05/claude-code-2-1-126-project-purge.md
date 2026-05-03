---
title: "Claude Code 2.1.126 fügt `claude project purge` hinzu, um den gesamten Zustand eines Repos zu löschen"
description: "Claude Code v2.1.126 liefert claude project purge aus, einen neuen CLI-Unterbefehl, der jede Transkription, Aufgabe, jeden Dateiverlaufseintrag und Konfigurationsblock zu einem Projektpfad in einem Schritt löscht. Enthält --dry-run, --yes, --interactive und --all."
pubDate: 2026-05-03
tags:
  - "claude-code"
  - "ai-agents"
  - "cli"
lang: "de"
translationOf: "2026/05/claude-code-2-1-126-project-purge"
translatedBy: "claude"
translationDate: 2026-05-03
---

Das Claude Code v2.1.126 Release vom 1. Mai 2026 brachte einen kleinen Befehl mit überdimensionaler Aufräumgeschichte: `claude project purge [path]`. Führen Sie ihn gegen ein Repository aus, und die CLI löscht jede Transkription, jede Aufgabe, jeden Dateiverlaufseintrag und jeden zu diesem Projektpfad gehörenden `~/.claude/projects/...`-Konfigurationsblock in einem einzigen Vorgang. Kein manuelles Wühlen mehr in `~/.claude/projects/`, um ein Projekt zurückzusetzen, das ein Jahr Sitzungsverlauf angesammelt hat.

## Warum ein dedizierter Befehl statt `rm -rf`

Der projektbezogene Zustand von Claude Code lebt an mehreren Orten gleichzeitig. Es gibt ein Projektverzeichnis unter `~/.claude/projects/<encoded-path>/`, das JSONL-Transkriptionen, die gespeicherte Aufgabenliste und Dateiverlauf-Snapshots enthält. Außerdem gibt es Einträge in der globalen `~/.claude/settings.json` und in der projektbezogenen Konfiguration, die per absolutem Pfad auf dieses Verzeichnis zeigen. Wenn nur der Projektordner entfernt wird, bleiben hängende Referenzen zurück; wenn nur die Einstellungseinträge entfernt werden, bleiben Megabytes verwaister Transkriptionen liegen.

Bis v2.1.126 war die offizielle Antwort eine sorgfältige manuelle Bereinigung. Der neue Unterbefehl läuft dieselbe interne Karte ab wie der Rest der CLI, sodass Transkriptionen, Aufgaben, Dateiverlauf und Konfigurationseinträge in einem konsistenten Durchgang verschwinden. Wenn Sie ihn gegen das Verzeichnis ausführen, in dem Sie sich gerade befinden, können Sie den Pfad weglassen:

```bash
# Nuke everything Claude Code knows about the current repo
claude project purge

# Or target an absolute path from elsewhere
claude project purge /home/marius/work/legacy-monolith
```

## Die Flags, die das skriptsicher machen

Der interessante Teil ist die Flag-Oberfläche. Das Release liefert vier:

```bash
# Show what would be deleted without touching anything
claude project purge --dry-run

# Skip the confirmation prompt (CI-friendly)
claude project purge -y
claude project purge --yes

# Walk projects one at a time and choose
claude project purge --interactive

# Purge every project Claude Code has ever recorded
claude project purge --all
```

`--dry-run` druckt die Projekt-IDs, die Transkriptionsanzahl und die Byte-Summen auf der Festplatte aus, die entfernt würden. `--all` ist der schwere Hammer, nützlich nach einem Laptop-Wechsel, bei dem die meisten der aufgezeichneten Pfade auf der Festplatte nicht mehr existieren. `-i` ist der Zwischenmodus zur Sichtung einer langen Liste.

## Wo das ins v2.1.126-Bild passt

Project purge ist eine von mehreren Verschiebungen im Zustandsmanagement dieses Releases. Derselbe Build erlaubt `--dangerously-skip-permissions` jetzt auch das Schreiben in zuvor geschützte Pfade wie `.claude/`, `.git/`, `.vscode/` und Shell-Konfigurationsdateien, was zum Purge-Modell passt: Claude Code lehnt sich darauf ein, Ihnen stumpfere Werkzeuge zum Wegblasen seines eigenen Fußabdrucks zu geben, mit der Annahme, dass Sie wissen, was Sie tun. Die frühere [Bedrock Service Tier Umgebungsvariable in Claude Code 2.1.122](/de/2026/04/claude-code-2-1-122-bedrock-service-tier/) war ein ähnliches Release im Stil "ein Schalter, keine SDK-Änderungen"; v2.1.126 setzt dieses Muster fort.

Wenn Sie Claude Code unter einem verwalteten `~/.claude` ausführen (einer organisationsweit fixierten Settings-Policy), purgt `--all` nur Projekte, deren Zustand unter Ihrem Benutzerprofil liegt. Die verwaltete Policy-Datei selbst bleibt unangetastet.

Die vollständigen Notes finden Sie auf der [Claude Code v2.1.126 Release-Seite](https://github.com/anthropics/claude-code/releases/tag/v2.1.126).
