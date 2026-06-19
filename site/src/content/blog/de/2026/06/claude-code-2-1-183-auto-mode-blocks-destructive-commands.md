---
title: "Claude Code 2.1.183 hindert den Auto-Modus daran, destruktive Git- und IaC-Befehle auszufuehren"
description: "Claude Code v2.1.183 (2026-06-19) blockiert git reset --hard, git clean -fd und terraform/pulumi/cdk destroy im Auto-Modus, sofern Sie sie nicht anfordern, und schliesst damit die agentische Luecke, in der ein schlechter Turn nicht committete Arbeit vernichtet."
pubDate: 2026-06-19
tags:
  - "claude-code"
  - "ai-agents"
  - "cli"
lang: "de"
translationOf: "2026/06/claude-code-2-1-183-auto-mode-blocks-destructive-commands"
translatedBy: "claude"
translationDate: 2026-06-19
---

Claude Code v2.1.183 erschien am 2026-06-19, und die wichtigste Aenderung ist eine Schutzfunktion, die es am selben Tag wie den Auto-Modus haette geben sollen: Der Agent kann eine Handvoll unumkehrbarer Befehle nicht mehr aus eigener Initiative ausfuehren. Wenn Sie nicht ausdruecklich ein `git reset --hard` angefordert haben, darf das Modell nicht entscheiden, dass es mitten in der Aufgabe eines braucht.

## Der Fehlerfall, den dies schliesst

Der Auto-Modus (frueher die YOLO-artige "mach einfach"-Variante) laesst den Agenten Shell-Befehle ohne Bestaetigungsabfrage pro Befehl ausfuehren. Genau das wollen Sie fuer eine Schleife aus `dotnet build`, `dotnet test` und Bearbeitungen. Genau das wollen Sie nicht, wenn das Modell beim Versuch, nach einer verworrenen Refaktorierung "zu einem sauberen Zustand zurueckzukehren", zu `git reset --hard` greift und eine Stunde nicht committeter Arbeit loescht oder `terraform destroy` gegen den falschen Stack ausfuehrt.

Das neue Release zieht eine Grenze: Destruktive, schwer rueckgaengig zu machende Befehle werden im Auto-Modus blockiert, sofern die ausloesende Anfrage diese Aktion nicht ausdruecklich genannt hat. Die blockierte Menge in 2.1.183:

```bash
# Blocked in auto mode unless you asked for them
git reset --hard
git checkout -- .
git clean -fd
git stash drop

# Blocked for commits the agent did not make this session
git commit --amend

# Blocked unless a specific stack is named
terraform destroy
pulumi destroy
cdk destroy
```

Die Unterscheidung ist die Absicht, kein pauschales Verbot. Wenn Ihr Prompt sagt "setze den Arbeitsbaum mit `git reset --hard` zurueck", fuehrt der Agent es aus. Wenn er von sich aus schliesst, dass ein Reset der richtige Schritt ist, haelt er an und teilt es Ihnen stattdessen mit. Dasselbe gilt fuer Infrastruktur: `terraform destroy` auf einen bestimmten, von Ihnen genannten Stack ist erlaubt; ein blosses `destroy` nicht.

## Warum amend eine Sonderbehandlung erhaelt

Die Regel fuer `git commit --amend` ist die subtile. Einen Commit zu aendern, den der Agent selbst frueher in der Sitzung erstellt hat, ist in Ordnung, das ist normales Iterieren an der eigenen Arbeit. Einen Commit zu aendern, den er nicht erstellt hat, schreibt eine Historie um, die ihm nicht gehoert, was stillschweigend den Commit eines Teammitglieds oder Ihre Arbeit vor der Sitzung ueberschreiben kann. Der Klassifizierer prueft nun die Urheberschaft innerhalb der Sitzung, bevor er dies zulaesst.

Das passt natuerlich zur frueheren Sicherheitsarbeit: [der `--safe-mode` von v2.1.169](/de/2026/06/claude-code-2-1-169-safe-mode-and-cd/) gibt Ihnen eine saubere Basis zum Debuggen, und nun weigert sich der Auto-Modus selbst, dasjenige zu sein, das Ihre Daten verliert. Wenn Sie wirklich moechten, dass der Agent einen dieser Befehle unaufgefordert ausfuehrt, ist der richtige Weg, dies im Prompt zu sagen oder fuer diesen Schritt den Auto-Modus zu verlassen und ihn von Hand zu bestaetigen.

## Der Rest des Releases

2.1.183 fuegt ausserdem Verwerfungswarnungen hinzu, wenn Sie ein Modell anfordern, das abgeloest wurde (auf stderr im Print-Modus und im Frontmatter des Agenten angezeigt), eine neue Einstellung `attribution.sessionUrl`, um claude.ai-Sitzungslinks aus Ihren Commits und PRs herauszuhalten, sowie `/config --help` zum Auflisten der Kurzschluessel. Die Fehlerbehebungen decken WebSearch ab, das in Subagenten leer zurueckkommt, die Beschaedigung der Vollbild-TUI im Windows Terminal sowie Turns, die still enden, wenn nur ein Denkblock erzeugt wurde.

Die vollstaendigen Notizen finden Sie im [Changelog von v2.1.183](https://code.claude.com/docs/en/changelog).
