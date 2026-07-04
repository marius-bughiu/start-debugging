---
title: "Claude Code 2.1.200 benennt den Berechtigungsmodus default in Manual um"
description: "Claude Code v2.1.200 (3. Juli 2026) benennt den Berechtigungsmodus 'default' in 'Manual' um, und zwar in der CLI, in VS Code und in JetBrains, und verhindert, dass AskUserQuestion-Dialoge automatisch fortfahren. Der Konfigurationswert bleibt 'default', wobei 'manual' als Alias akzeptiert wird."
pubDate: 2026-07-04
tags:
  - "claude-code"
  - "ai-agents"
  - "cli"
lang: "de"
translationOf: "2026/07/claude-code-2-1-200-renames-default-permission-mode-to-manual"
translatedBy: "claude"
translationDate: 2026-07-04
---

Claude Code v2.1.200 ist am 3. Juli 2026 erschienen und ändert zwei Dinge, die jeden betreffen, der den Agenten interaktiv ausführt: Es benennt den Berechtigungsmodus, den Sie bisher "default" genannt haben, in "Manual" um, und es ändert `AskUserQuestion`-Dialoge so, dass sie nicht mehr von selbst fortfahren. Keine der beiden Änderungen ist eine große Funktion, aber beide ändern das Muskelgedächtnis und schließen im zweiten Fall eine kleine Fußfalle.

## Warum "default" ein schlechter Name war

Der Berechtigungsmodus, der jede Aktion überprüft und nachfragt, bevor etwas ausgeführt wird, war historisch mit "default" beschriftet. Dieser Name sagte Ihnen, wo er in einer Liste stand, nicht was er tat. Neue Benutzer lasen "default" und nahmen an, es sei eine passive Einstellung und nicht der Modus, der jeden Tool-Aufruf hinter einer Bestätigungsaufforderung absichert.

2.1.200 beschriftet ihn überall dort mit "Manual", wo ein Mensch ihn liest: im CLI-Auswahlmenü, in `claude --help` sowie in den Erweiterungen für VS Code und JetBrains. Der Punkt ist, dass der Name jetzt das Verhalten beschreibt, Sie bestätigen jeden Schritt von Hand.

Entscheidend ist, dass sich der Konfigurationswert nicht geändert hat. Hooks, das SDK und Ihre bestehende `settings.json` verwenden weiterhin `default`, sodass nichts kaputtgeht:

```jsonc
// Both of these mean the same mode
{ "permissions": { "defaultMode": "default" } }
{ "permissions": { "defaultMode": "manual" } }
```

```bash
# manual is accepted as an alias wherever you type the value
claude --permission-mode manual
claude --permission-mode default   # still valid
```

Wenn Sie Claude Code skripten oder eine eingecheckte Konfiguration mit einem Team teilen, bleiben Sie bei `default`, es ist der stabile, kanonische Wert. Greifen Sie nur dann zu `manual`, wenn Sie es von Hand eingeben und möchten, dass die Beschriftung dem entspricht, was die Benutzeroberfläche jetzt anzeigt.

## AskUserQuestion fährt nicht mehr automatisch fort

Die zweite Änderung ist diejenige, die im Code-Review erwähnenswert ist. Das `AskUserQuestion`-Tool, mit dem der Agent Ihnen mitten in einer Aufgabe eine Multiple-Choice-Entscheidung vorlegt, fuhr früher nach einer Leerlaufzeit automatisch fort und wählte eine hervorgehobene Option aus, wenn Sie sich entfernt hatten. Das ist praktisch, bis es Sie stillschweigend auf einen Arbeitszweig festlegt, den Sie nicht gelesen haben.

In 2.1.200 fahren diese Dialoge standardmäßig nicht mehr automatisch fort. Der Agent wartet auf Sie. Wenn Sie das alte Weggeh-Verhalten tatsächlich möchten, aktivieren Sie ein Leerlauf-Timeout explizit über `/config`, anstatt es zu erhalten, ob Sie danach gefragt haben oder nicht. Das ist derselbe Instinkt, "keine unumkehrbaren Dinge im Namen des Benutzers entscheiden", der auch hinter [2.1.183 steckt, das destruktive git- und IaC-Befehle im Auto-Modus blockiert](/2026/06/claude-code-2-1-183-auto-mode-blocks-destructive-commands/).

## Der Rest des Releases

2.1.200 legt den Schwerpunkt auf die Zuverlässigkeit von Hintergrund-Agenten. Es behebt, dass Hintergrundsitzungen nach dem Ruhezustand/Aufwachen stillschweigend stoppten, eine veraltete `daemon.lock`, deren wiederverwendete PID Agenten dauerhaft am Starten hinderte, sowie Subagenten, die von einem Rate Limit abgeschnitten wurden und ein leeres Ergebnis zurückgaben, anstatt sauber zu scheitern. Außerdem gibt es einen Fix für einen Startup-Crash, wenn `disabledMcpServers` oder `enabledMcpServers` in `.claude.json` auf einen Nicht-Array-Wert gesetzt ist, dazu eine Reihe von Verbesserungen für Screenreader und einen Fix für ein Rendering-Flackern bei tmux 3.4+.

Wenn Sie eine gemeinsame Team-Konfiguration pflegen, ist die Erkenntnis klein, aber real: Ihr Berechtigungsmodus hat sich nicht geändert, nur sein Anzeigename, und Ihre interaktiven Dialoge sind jetzt etwas weniger eifrig, sich ohne Sie zu bewegen. Die vollständigen Notizen finden Sie im [v2.1.200-Changelog](https://code.claude.com/docs/en/changelog).
