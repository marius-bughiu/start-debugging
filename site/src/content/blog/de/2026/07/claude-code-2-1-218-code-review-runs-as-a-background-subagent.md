---
title: "Claude Code 2.1.218 führt /code-review als Subagent im Hintergrund aus"
description: "Version 2.1.218 verschiebt /code-review aus Ihrer Hauptunterhaltung in einen Subagenten im Hintergrund, und Skills mit fork-Kontext laufen jetzt standardmäßig im Hintergrund. Das hat sich geändert und so deaktivieren Sie es."
pubDate: 2026-07-23
tags:
  - "claude-code"
  - "ai-agents"
  - "subagents"
lang: "de"
translationOf: "2026/07/claude-code-2-1-218-code-review-runs-as-a-background-subagent"
translatedBy: "claude"
translationDate: 2026-07-23
---

Claude Code 2.1.218, veröffentlicht am 23. Juli 2026, ändert, wo `/code-review` läuft. Statt eine lange Review innerhalb der Unterhaltung aufzufächern und Ihre eigentliche Arbeit nach oben aus dem Blickfeld zu drängen, läuft die Review jetzt als Subagent im Hintergrund. Ihre Unterhaltung bleibt Ihre. Die Review passiert nebenbei, und Sie sehen nach ihr, wann Sie möchten.

## Was sich in 2.1.218 ändert

Die Schlagzeile ist klein im Changelog und groß im täglichen Gebrauch: `/code-review` läuft jetzt als Subagent im Hintergrund. Daraus folgen drei Dinge.

Die Review-Ausgabe füllt nicht mehr Ihre Unterhaltung. Eine Code-Review kann Dutzende Befunde über viele Dateien hinweg erzeugen. Zuvor landete das alles im Haupt-Transkript und begrub den Thread, in dem Sie gerade arbeiteten. Jetzt lebt es im Subagenten.

Gestapelte Slash-Befehle bleiben das Ziel der Review. Wenn Sie `/code-review` hinter anderen Befehlen einreihen, weiß die Review weiterhin, was sie untersuchen soll, anstatt ihr Ziel zu verlieren, wenn sie in den Hintergrund wechselt.

Die Navigation hat eine Sicherung erhalten. Das Drücken von `Esc` in der Agentenansicht bringt Sie zurück zu der Unterhaltung, aus der die Review in den Hintergrund verschoben wurde, sodass Sie Ihre Stelle nicht verlieren. Dieselbe Version behob auch, dass die Pfeil-links-Taste eine Unterhaltung stillschweigend ohne Rückgängigmachen verwarf. Jetzt fragt sie nach Bestätigung.

## Das Ende einer Verschiebung, die in 2.1.215 begann

Das kam nicht aus dem Nichts. Ein paar Builds zuvor hörte 2.1.215 (19. Juli) auf, Claude `/verify` und `/code-review` von selbst ausführen zu lassen. Sie rufen sie auf, wenn Sie sie wollen. 2.1.218 überträgt dieselbe Idee auf die Recherche: `/deep-research` startet jetzt nur, wenn Sie es manuell aufrufen, und Claude startet es nicht mehr von selbst.

Zusammengenommen ist die Botschaft konsistent. Lange, laute, teure Skills sind opt-in und außerhalb des Hauptkanals. Sie feuern nicht automatisch, und wenn Sie sie feuern, übernehmen sie nicht Ihre Sitzung. Das ist derselbe Instinkt dahinter, dass Subagenten seit 2.1.198 [standardmäßig im Hintergrund laufen](/de/2026/07/claude-code-2-1-198-subagents-run-in-the-background-by-default/).

## Skills mit fork-Kontext laufen jetzt standardmäßig im Hintergrund

Es gibt eine begleitende Änderung, die es zu kennen lohnt, wenn Sie Skills schreiben. Skills mit `context: fork` laufen jetzt standardmäßig im Hintergrund. Das entspricht dem Verhalten von `/code-review` für Ihre eigenen Skills, die einen isolierten Kontext hochfahren.

Wenn Sie möchten, dass eine fork-Skill im Vordergrund bleibt, deaktivieren Sie es pro Skill mit einem Flag im Frontmatter:

```yaml
---
name: my-review-skill
context: fork
background: false
---
```

Der Boolean-Parser wurde in 2.1.218 ebenfalls freundlicher: `yes`, `no`, `on`, `off`, `1` und `0` werden jetzt neben `true` und `false` für die Booleans im Frontmatter von Skills und Plugins akzeptiert, ohne Beachtung der Groß- und Kleinschreibung.

## Warum das wichtig ist

Die Hauptunterhaltung ist der Ort, an dem Sie denken. Alles, was eine Wand von Ausgabe hineinkippt, kostet Sie Aufmerksamkeit, nicht nur Tokens. Review und Recherche in Subagenten im Hintergrund zu verschieben, hält das Transkript lesbar und lässt die langsame Arbeit laufen, ohne Sie zu blockieren. Wenn Sie das Muskelgedächtnis haben, dass `/code-review` den Bildschirm flutet, aktualisieren Sie es: führen Sie es aus, arbeiten Sie weiter, und sehen Sie in der Agentenansicht nach, wenn es fertig ist.

Alle Details stehen im [Claude Code Changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md).
