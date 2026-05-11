---
title: "Cursor 3.3 bringt Build in Parallel, Split PRs und eine vereinheitlichte PR-Review"
description: "Cursor 3.3 (7. Mai 2026) liefert asynchrone Subagenten, die unabhängige Schritte eines Plans gleichzeitig bearbeiten, eine Schnellaktion, die einen Chat in mehrere Pull Requests aufteilt, und einen neu gestalteten PR-Workflow, der Reviews, Commits und Changes an einem Ort hält."
pubDate: 2026-05-11
tags:
  - "cursor"
  - "ai-agents"
  - "pull-requests"
  - "subagents"
lang: "de"
translationOf: "2026/05/cursor-3-3-build-in-parallel-split-prs"
translatedBy: "claude"
translationDate: 2026-05-11
---

Am 7. Mai 2026 hat Cursor [Version 3.3](https://cursor.com/changelog/05-07-26) veröffentlicht. Es ist ein Release, das dieselbe Verschiebung verstärkt, die schon die [Vorschau auf das TypeScript SDK](/de/2026/05/cursor-typescript-sdk-programmatic-coding-agents/) angedeutet hat: Agenten sind kein einzelner Arbeitsstrang mehr, der an einen Chat gebunden ist. Die Hauptfunktionen, "Build in Parallel", "Split PRs" und eine neu gestaltete PR-Review-Oberfläche, schieben den Editor näher an eine Multi-Agent-IDE, in der eine Person mehrere gleichzeitige Läufe überwacht.

## Build in Parallel macht aus einem Plan asynchrone Subagenten

Planung war bereits Teil der Schleife in Cursor: Sie entwerfen einen Plan, der Agent läuft die Schritte ab. In 3.3 nimmt eine neue Aktion "Build in Parallel" diesen Plan, identifiziert unabhängige Schritte und startet asynchrone Subagenten, die an jedem davon gleichzeitig arbeiten. Cursor hält abhängige Schritte weiterhin in Reihenfolge, wenn der Plan eine Ordnung impliziert, sodass Sie den Graphen nicht manuell markieren müssen.

Wenn Sie den CLI-Geschmack bevorzugen, gibt es einen Befehl `/multitask`, der dieselbe Maschinerie aus dem Chat ansteuert:

```text
/multitask
- Wire the Stripe webhook handler
- Add a Polly retry policy around the OpenAI client
- Rewrite the README install section
```

Jeder Eintrag läuft in seinem eigenen Subagent-Kontext. Die Subagenten teilen sich den Workspace über Snapshots, nicht über denselben Puffer, sodass zwei gleichzeitige Bearbeitungen derselben Datei sich nicht mehr in die Quere kommen. Der Explore-Subagent nimmt jetzt zusätzlich einen Modell-Selektor (`model: opus`, `model: parent` oder `disabled`), was bedeutet, dass der günstige "finde relevanten Code"-Schritt auf einem kleineren Modell als der Schreiber laufen kann.

## Split PRs zerlegt einen Chat in mehrere

Wer einen Agenten schon einmal eine Stunde lang laufen ließ, kennt den Schmerz: Wenn Sie ihn stoppen, deckt das Diff vier zusammenhanglose Änderungen ab, und es als einen einzelnen PR zu reviewen ist aussichtslos. Die neue Schnellaktion "Split into PRs" analysiert das Chat-Transkript, gruppiert Commits nach logischem Anliegen und öffnet einen PR pro Gruppe. Cursor hält die PRs unabhängig, es sei denn, eine echte Abhängigkeit wird erkannt, dann verknüpft es sie mit einer "depends on"-Notiz.

Vor der Aufteilung wird ein Sicherheits-Snapshot erstellt, und Cursor fragt vor dem Push nach einer Bestätigung.

## PR Review fasst drei Tabs zu einem Workflow zusammen

Das dritte Element ist eine neu gestaltete PR-Ansicht im Editor. Drei Tabs ersetzen die alte Aufteilung zwischen GitHub und dem Agent-Panel:

- **Reviews**: inline Review-Threads und PR-Kommentare auf oberster Ebene, mit Schnellaktionen zum Antworten oder Akzeptieren.
- **Commits**: eine fokussierte Commit-Liste für den PR, mit der Sie sich durch die Historie des Agenten klicken können.
- **Changes**: ein Dateibaum plus eine Auswahl, der Teil, der auffällt, wenn der PR vierzig Dateien berührt.

Zusammen skizzieren die drei Funktionen dieselbe Richtung, auf die das [TypeScript SDK von Cursor](/de/2026/05/cursor-typescript-sdk-programmatic-coding-agents/) hingewiesen hat: Die Arbeitseinheit ist nicht mehr "ein Prompt, ein Diff", sondern "ein Plan, viele Subagenten, viele PRs".
