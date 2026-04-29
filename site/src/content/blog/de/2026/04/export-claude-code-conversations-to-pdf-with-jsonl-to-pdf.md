---
title: "Claude Code Konversationen mit jsonl-to-pdf als PDF exportieren"
description: "Eine praktische Anleitung, wie Sie die JSONL-Dateien, die Claude Code unter ~/.claude/projects/ schreibt, mit jsonl-to-pdf in teilbare PDFs verwandeln, mit Sub-Agent-Verschachtelung, Redaktion von Geheimnissen, kompaktem und dunklem Theme sowie CI-tauglichen Batch-Rezepten."
pubDate: 2026-04-29
tags:
  - "claude-code"
  - "ai-agents"
  - "cli"
  - "pdf"
lang: "de"
translationOf: "2026/04/export-claude-code-conversations-to-pdf-with-jsonl-to-pdf"
translatedBy: "claude"
translationDate: 2026-04-29
---

Jede Konversation, die Sie mit Claude Code führen, lebt als `.jsonl`-Datei tief in `~/.claude/projects/`, eine Zeile pro Turn, volle Treue, kein Rendering. `jsonl-to-pdf` ist eine kleine CLI, die diese Dateien in PDFs umwandelt, die Sie in einem Reader lesen, an einen Pull Request anhängen, in einen Slack-Thread legen oder auf echtem Papier ausdrucken können. Der schnellste Weg, es mit Ihrer letzten Sitzung zu testen, ist `npx jsonl-to-pdf`. Das öffnet einen interaktiven Picker, fragt, ob die Sub-Agent-Konversationen einbezogen werden sollen, und schreibt ein PDF mit Titel in das aktuelle Verzeichnis.

Dieser Beitrag zeigt, woher die JSONL-Dateien kommen, was das PDF tatsächlich enthält (Sub-Agents inline verschachtelt, Thinking-Blöcke, Tool-Aufrufe und -Ergebnisse, Bildanhänge), die Flags, die für externes Teilen wichtig sind (`--compact`, `--redact`, `--no-thinking`, `--subagents-mode appendix`, `--dark`), sowie einige CI- und Automatisierungs-Rezepte. Die behandelte Version ist `jsonl-to-pdf` 0.1.0 gegen Claude Code 2.1.x. Das Repository liegt auf [GitHub](https://github.com/marius-bughiu/jsonl-to-pdf), das Paket auf [npm](https://www.npmjs.com/package/jsonl-to-pdf).

## Wo Claude Code Ihre Konversationen ablegt

Claude Code schreibt eine JSONL-Datei pro Sitzung unter `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. Das Segment `<encoded-cwd>` ist das Arbeitsverzeichnis, in dem die Sitzung lief, mit Pfadtrennzeichen, die zu `-` reduziert sind. So wird `C:\S\my-app` unter Windows zu `C--S-my-app`, und `/Users/marius/work` unter macOS oder Linux zu `-Users-marius-work`. Jede Zeile ist ein JSON-Objekt: ein Benutzer-Turn, ein Assistent-Turn, ein Tool-Aufruf, ein Tool-Ergebnis, ein Thinking-Block, oder Sitzungs-Metadaten wie `cwd`, `gitBranch`, `aiTitle` und `permissionMode`.

Sub-Agent-Konversationen (Sitzungen, die der Hauptagent über das `Task`/`Agent`-Tool spawnt) liegen in einem Geschwister-Verzeichnis: `<session-id>/subagents/<sub-session-id>.jsonl`. Sie sind eigenständige Sitzungen mit eigenen JSONL-Streams, per ID an einen Tool-Aufruf in der Hauptdatei zurückverknüpft. Diese Verschachtelung ist in der Praxis rekursiv: Ein Sub-Agent, der seinen eigenen Sub-Agent spawnt, hinterlässt eine dritte Datei neben der zweiten.

Dieses Layout ist wichtig, weil nichts in der Claude Code Oberfläche es direkt anzeigt. Wenn Sie nach dem Ende einer Konversation noch etwas mit der Sitzung machen müssen (archivieren, teilen, auditieren), finden Sie sie zuerst auf der Festplatte. Die CLI übernimmt die Suche mit `jsonl-to-pdf list` für Sie, aber die Pfadkodierung ist es wert, gekannt zu werden, falls Sie eine bestimmte Sitzung manuell mit grep suchen. Die kürzlich erfolgte [PR-from-URL-Änderung in Claude Code 2.1.119](/de/2026/04/claude-code-2-1-119-from-pr-gitlab-bitbucket/) fügt diesen Dateien immer mehr Sitzungs-Metadaten hinzu, sodass das JSONL zunehmend zur kanonischen Aufzeichnung dessen wird, was ein Agent-Lauf wirklich getan hat.

## Schnellstart: npx jsonl-to-pdf

Der installationsfreie Pfad führt `jsonl-to-pdf` direkt aus npm aus, ohne Ihre `package.json` anzufassen:

```bash
# Node
npx jsonl-to-pdf

# Bun
bunx jsonl-to-pdf

# pnpm
pnpm dlx jsonl-to-pdf
```

Das landet in einem interaktiven Picker, der das lokale Verzeichnis der Claude Code Projekte durchgeht, jede Sitzung neueste zuerst mit Titel, Alter und Größe auflistet, und fragt, ob Sub-Agent-Konversationen einbezogen werden sollen. Wählen Sie eine Sitzung, beantworten Sie die Frage, und die CLI schreibt ein PDF, das nach dem Sitzungstitel benannt ist, in Ihr aktuelles Arbeitsverzeichnis:

```
$ jsonl-to-pdf
◆ Project   C:\S\my-app
◆ Session   Refactor the billing module to use Stripe webhooks  · 2h ago · 412KB
◆ Include sub-agent conversations? › Yes

✓ Wrote refactor-the-billing-module-to-use-stripe-webhooks.pdf
```

Wenn Sie den Dateipfad bereits kennen, nimmt `convert` ihn als positionalen Parameter und überspringt den Picker:

```bash
jsonl-to-pdf convert ~/.claude/projects/C--S-my-app/abc-123.jsonl
```

Beide Formen akzeptieren dieselben Flags. Der interaktive Picker ist der richtige Einstieg, wenn Sie eine Ad-hoc-Sitzung konvertieren; die `convert`-Form ist der richtige Einstieg, wenn Sie gegen eine bekannte Datei skripten (CI-Artefakt-Upload, Automatisierungs-Hook, Archivierungs-Sweep).

Für eine globale Installation legen `npm i -g jsonl-to-pdf` oder `bun i -g jsonl-to-pdf` sowohl `jsonl-to-pdf` als auch den kürzeren Alias `j2pdf` in Ihren `PATH`. Node 18 oder neuer ist erforderlich.

## Was im PDF landet

Ohne weitere Optionen behält das PDF die **volle Treue** der Sitzung, nicht nur den sichtbaren Chat:

- Jede Benutzeranfrage und Assistent-Antwort, in Reihenfolge.
- *Thinking*-Blöcke (das interne Reasoning des Modells, wenn Extended Thinking aktiviert ist). Hilfreich beim Nachvollziehen, wie der Agent entschieden hat, was zu tun ist.
- Jeder Tool-Aufruf mit vollständigem Input. Ein `Bash`-Aufruf zeigt sein Kommando, ein `Edit`-Aufruf zeigt das Diff, ein MCP-Aufruf zeigt seine Argumente.
- Jedes Tool-Ergebnis, einschließlich vollständigem Bash-stdout/stderr. Lange Ausgaben werden umgebrochen, nicht abgeschnitten.
- Bildanhänge, inline an der Stelle in der Konversation eingebettet, an der sie angehängt wurden.
- **Sub-Agents** an der richtigen Stelle verschachtelt gerendert. Wenn der Hauptagent ein `Task` oder `Agent` gespawnt hat, erscheint die gesamte Sub-Konversation eingerückt am Tool-Aufruf, der sie gestartet hat. Sub-Agents, die Sub-Agents spawnen, werden auf dieselbe Weise rekursiv gerendert.

Code-Blöcke werden mit Monospace-Schrift, syntax-bewusstem Zeilenumbruch und Seitenumbruch-Logik gerendert, die nicht mitten in einem Token reißt. Abschnitte enthalten leichte Navigationselemente (Seitenzahlen, Sitzungstitel im Kopf), ohne Design um seiner selbst willen. Das Standard-Theme ist hell; `--dark` schaltet auf ein dunkles Theme um, das auf dem Bildschirm besser aussieht und auf Papier schlechter.

Diese Treue ist der Punkt. PDFs von Agent-Sitzungen sind am nützlichsten, wenn der Leser genau sehen kann, was das Modell gesehen hat, was es ausgeführt hat, und was zurückgekommen ist. Ein zusammengefasster Export liest sich wie ein Postmortem; ein vollständiger Export liest sich wie ein Transkript.

## Sub-Agents inline oder als Anhang

Das Standard-Rendering ist **inline**: Jede Sub-Agent-Konversation erscheint an der Position des Tool-Aufrufs, der sie gespawnt hat, eingerückt und visuell gruppiert, sodass der Eltern-Flow leicht zu verfolgen ist. Das ist der richtige Standard für Debugging, bei dem Sie den Seiten-Trip im Kontext sehen wollen.

`--subagents-mode appendix` schaltet auf ein anderes Layout um: Die Hauptkonversation liest sich von oben nach unten ohne Unterbrechung, und die Sub-Agent-Konversationen wandern an das Ende des Dokuments mit Ankern zurück zum Tool-Aufruf, der jede gespawnt hat. Das ist der richtige Modus für Code-Review-artiges Lesen, bei dem die Eltern-Konversation die Geschichte ist und die Sub-Agent-Threads die Belege:

```bash
# inline (default)
jsonl-to-pdf convert session.jsonl

# appendix
jsonl-to-pdf convert session.jsonl --subagents-mode appendix

# omit sub-agents entirely
jsonl-to-pdf convert session.jsonl --no-subagents
```

Die dritte Option, `--no-subagents`, ist für Fälle, in denen Sub-Agent-Konversationen Rauschen sind (oft: lange Suchen im Explore-Stil, die die endgültige Änderung nicht beeinflussen). Das PDF enthält dann nur den Flow des Hauptagenten.

## Compact und redact: eine Sitzung sicher zum Teilen machen

Zwei Flags decken den Fall "Ich möchte das extern teilen" ab.

`--compact` reduziert die Sitzung auf das Wesentliche. Thinking-Blöcke werden ausgeblendet, und jede Tool-I/O länger als etwa 30 Zeilen wird mit einem klaren Marker `[N lines omitted]` gekürzt. Das Ergebnis liest sich wie der Chat, ohne den tiefen Trace. Nützlich, um die Konversation einem Teamkollegen zu übergeben, dem nur das Ergebnis wichtig ist.

`--no-thinking` ist ein feinerer Schnitt: Es blendet nur die Thinking-Blöcke des Assistenten aus, lässt Tool-Aufrufe und Ergebnisse intakt. Hilfreich, wenn der Trace wichtig ist, das interne Reasoning aber zu ausführlich zum Drucken.

`--redact` läuft jeden String im Dokument durch eine Reihe von regulären Ausdrücken, die auf die gängigen Formate von Geheimnissen passen: AWS-Access- und Secret Keys, GitHub Personal Access Tokens (klassisch und fein granuliert), Anthropic- und OpenAI-API-Keys, `Bearer`-Header, Slack-Tokens und PEM-kodierte private Schlüssel. Jeder Treffer wird durch `[redacted:<kind>]` ersetzt, sodass der Leser erkennen kann, welche Art von Geheimnis dort war, ohne den Wert zu sehen. Die vollständige Liste der Muster steht in [src/utils/redact.ts](https://github.com/marius-bughiu/jsonl-to-pdf/blob/main/src/utils/redact.ts) auf der GitHub-Seite des Projekts.

```bash
# safe to email
jsonl-to-pdf convert session.jsonl --compact --redact

# safe to share, full fidelity
jsonl-to-pdf convert session.jsonl --redact
```

Verwenden Sie `--redact` immer dann, wenn das Ziel außerhalb Ihrer Vertrauensgrenze liegt. Selbst wenn Sie sicher sind, dass die Sitzung nie einen Schlüssel berührt hat, sind die Kosten der Flag praktisch null und die Kosten eines Irrtums sind ein rotiertes Produktionscredential.

## Rezepte

Ein paar Muster, die häufig auftauchen.

**Konvertieren Sie die letzte Woche im Batch.** Jede Sitzung, die neuer als ein Datum ist, jeweils ein PDF, geschrieben dort, wo Sie das Kommando ausgeführt haben:

```bash
jsonl-to-pdf list --json |
  jq -r '.[] | select(.modifiedAt > "2026-04-22") | .filePath' |
  while read f; do jsonl-to-pdf convert "$f"; done
```

`jsonl-to-pdf list --json` gibt einen Datensatz pro Sitzung mit `sessionId`, `projectPath`, `filePath`, `sizeBytes` und `modifiedAt` aus, sodass jeder Filter, den Sie in `jq` ausdrücken können, funktioniert.

**Hängen Sie die aktive Sitzung als CI-Artefakt an.** Nützlich in jeder Pipeline, in der ein Claude Code Lauf die Änderung erzeugt hat und Sie die Konversation neben der Build-Ausgabe archiviert haben wollen:

```yaml
- run: npx -y jsonl-to-pdf convert "$CLAUDE_SESSION_FILE" -o session.pdf --redact
- uses: actions/upload-artifact@v4
  with:
    name: claude-session
    path: session.pdf
```

**Pipen Sie an einen Drucker oder PDF-Reader.** Die Form `-o -` schreibt das PDF nach stdout, was praktisch ist, um es an `lp`, `lpr` oder das Druckbinary Ihrer Plattform zu pipen, oder an einen einmaligen PDF-Reader, ohne eine Datei auf der Festplatte zu hinterlassen:

```bash
jsonl-to-pdf convert session.jsonl -o - | lp
```

**Listen Sie jede Sitzung auf, die die CLI sehen kann.** Kein PDF, nur den Index:

```bash
jsonl-to-pdf list
```

Die Ausgabe ist standardmäßig menschenlesbar und mit `--json` maschinenlesbar. Der Sweet Spot beim Skripten von Agent-Tooling; der [Beitrag zum wiederkehrenden Claude Code Triage](/de/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/) hat ein längeres Beispiel desselben Musters (ein geplanter Job, der `list --json` konsumiert).

## Standalone-Binaries, wenn Sie keine Node-Toolchain wollen

Die GitHub Releases-Seite liefert Single-File-Binaries, gebaut mit `bun build --compile`, eines pro Betriebssystem und Architektur, ohne Node-Runtime. Nützlich auf Build-Agents, denen das Installieren einer Node-Toolchain nicht erlaubt ist, oder auf gesperrten Entwickler-Workstations, auf denen globale npm-Installationen blockiert sind:

```bash
# macOS / Linux
curl -fsSL https://github.com/marius-bughiu/jsonl-to-pdf/releases/latest/download/install.sh | sh
```

Unter Windows laden Sie `jsonl-to-pdf-win-x64.exe` aus dem letzten Release herunter und legen es in Ihren `PATH`. Das Binary akzeptiert dieselben Flags wie die npm-Installation: `convert`, `list`, `--compact`, `--redact`, `--dark`, alles.

## Warum genau ein PDF und nicht "im Browser öffnen"

Ein paar Gründe, warum sich das PDF-Format gegenüber einer HTML-Ansicht behauptet, die im Roadmap steht.

- **Archivieren.** Lokale Claude Code Sitzungs-Dateien werden rotiert, vom Garbage Collector eingesammelt oder einfach vergessen. Ein PDF ist ein eingefrorener, autarker Snapshot, den Sie in einen Projektordner, ein Issue oder ein Backup legen können.
- **Teilen.** Die meisten Code-Review- und Chat-Tools akzeptieren einen PDF-Anhang sauber. Einen 400KB JSONL in einen Slack-Thread einzufügen ist eine schlechtere Erfahrung, als ein PDF zu droppen.
- **Reviewen.** Agent-Arbeit so zu lesen, wie Sie ein Code-Review lesen (am Schreibtisch, im Flug, auf Papier), ist ein anderer Aufmerksamkeitsmodus als das Scrollen eines Chats. PDFs überleben diesen Wechsel.
- **Auditieren.** Ein signierter, deterministischer Export ist ein Nachweis dessen, was tatsächlich gesagt und ausgeführt wurde. Interne Compliance-Teams können ein PDF kommentieren; ein JSONL nicht.
- **Onboarding.** Eine echte Sitzung ist deutlich besseres Studienmaterial für Junior-Entwickler als ein generisches Tutorial. Ein PDF macht aus dieser Übergabe ein Ein-Anhang-Problem.

## Roadmap, kurz

Das 0.1.0 Release deckt nur Claude Code ab. Die Roadmap im GitHub des Projekts verspricht Adapter für Aider, OpenAI Codex CLI, Cursor Compose und Gemini CLI, die alle eine Variante von JSONL- oder JSON-Lines-Transkripten schreiben. Über die Format-Abdeckung hinaus:

- HTML-Ausgabe für Inline-Web-Sharing und einen kleinen statischen Viewer.
- Syntax-Highlighting für Code-Blöcke über Shiki-Tokens.
- Ein Inhaltsverzeichnis mit Seitenzahlen (aktuelle Builds verwenden PDF-Outlines/Lesezeichen).
- Filter-Flags: `--turns 5..15`, `--only assistant`, `--exclude-tool Bash`, für die Fälle, in denen das vollständige Transkript zu viel ist.

Wenn Sie eine CLAUDE.md und einen Hook schreiben, um Ihre Sitzungen auf Kurs zu halten (das [CLAUDE.md Playbook](/de/2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour/) deckt das ab), ist `jsonl-to-pdf` das passende Artefakt: ein Weg, eine Sitzung mit etwas Dauerhaftem zu verlassen, auf das man zeigen kann. Das Repo liegt unter [github.com/marius-bughiu/jsonl-to-pdf](https://github.com/marius-bughiu/jsonl-to-pdf).
