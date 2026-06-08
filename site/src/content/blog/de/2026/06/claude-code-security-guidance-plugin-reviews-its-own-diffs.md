---
title: "Das security-guidance-Plugin von Claude Code prüft seine eigenen Diffs vor dem Commit"
description: "Anthropic hat ein kostenloses security-guidance-Plugin für Claude Code veröffentlicht, das die eigenen Edits des Agenten in drei Ebenen auf Schwachstellen prüft, vom kostenlosen Mustervergleich bis zur agentischen Prüfung beim Commit."
pubDate: 2026-06-08
tags:
  - "claude-code"
  - "ai-agents"
  - "security"
lang: "de"
translationOf: "2026/06/claude-code-security-guidance-plugin-reviews-its-own-diffs"
translatedBy: "claude"
translationDate: 2026-06-08
---

Anthropic hat Ende Mai 2026 ein kostenloses [security-guidance-Plugin](https://code.claude.com/docs/en/security-guidance) für Claude Code veröffentlicht, das etwas tut, das die meisten KI-Setups beim Programmieren auslassen: Es lässt den Agenten seine eigenen Diffs während der Arbeit auf Schwachstellen prüfen und das Gefundene in derselben Sitzung beheben. Der Ansatz ist einfach. Der am günstigsten zu behebende Sicherheitsfehler ist der, der nie den Pull Request erreicht, und ein separater Prüfer ohne Bindung an den ursprünglichen Ansatz findet mehr als das Modell, das den Code geschrieben hat.

## Drei Ebenen, von denen nur eine Tokens verbraucht

Das Plugin läuft an drei Punkten, jeder mit einer anderen Tiefe.

Der erste wird bei jedem `Edit`, `Write` oder `NotebookEdit` ausgelöst. Es handelt sich um einen deterministischen Mustervergleich ohne Modellaufruf, der also keine Nutzungskosten verursacht. Er markiert riskante Konstrukte in dem Moment, in dem sie auftauchen:

- Dynamische Ausführung: `eval(`, `new Function`, `os.system`, `child_process.exec`
- Unsichere Deserialisierung: `pickle`
- DOM-Injection: `dangerouslySetInnerHTML`, `.innerHTML =`, `document.write`
- Edits unter `.github/workflows/`, die unbemerkt Berechtigungen auf Repository-Ebene gewähren können

Jede Warnung wird einmal pro Muster, pro Datei und pro Sitzung ausgelöst, sodass sie die Konversation nicht überflutet.

Die zweite Ebene läuft am Ende jeder Runde. Das Plugin erstellt einen Diff von allem, was sich im Arbeitsbaum geändert hat, einschließlich der Edits von Bash und Subagenten, und übergibt ihn einer separaten, auf Sicherheit ausgerichteten Claude-Prüfung. Hier reicht der Stringvergleich nicht hin: Autorisierungs-Bypass, unsichere direkte Objektreferenzen, SSRF, schwache Kryptografie. Sie läuft im Hintergrund, deckt bis zu 30 geänderte Dateien ab und wird höchstens dreimal hintereinander ausgelöst.

Die dritte Ebene wird ausgelöst, wenn Claude `git commit` oder `git push` über sein Bash-Tool ausführt. Diese ist agentisch: Sie liest die Aufrufer, die Sanitizer und verwandte Dateien, um vor dem Melden zu entscheiden, ob ein Befund echt ist, was die Falsch-Positiv-Rate bei Code niedrig hält, der isoliert gefährlich aussieht, im Kontext aber sicher ist. Sie ist auf 20 Prüfungen pro gleitender Stunde begrenzt. Commits, die Sie aus Ihrer eigenen Shell ausführen, werden nicht geprüft.

Beide modellgestützten Ebenen verwenden standardmäßig Claude Opus 4.7 als Prüfer.

## Installation und Erweiterung

Sie benötigen Claude Code 2.1.144 oder neuer und Python 3.8 in Ihrem `PATH`. Installation aus dem offiziellen Marketplace:

```text
/plugin install security-guidance@claude-plugins-official
/reload-plugins
```

Die Ebene pro Edit lässt sich erweitern, ohne das Modell anzufassen. Legen Sie eine `.claude/security-patterns.yaml` in Ihr Repository und fügen Sie eigene Regeln hinzu:

```yaml
patterns:
  - rule_name: tenant_unfiltered_query
    regex: "\\.objects\\.all\\(\\)"
    paths: ["**/src/tenants/**"]
    reminder: "Multi-tenant code must filter by org_id."
```

Keine der drei Ebenen blockiert Schreibvorgänge oder Commits. Befunde erreichen den schreibenden Claude als Anweisungen, und der Prüfer kann immer noch etwas übersehen. Behandeln Sie es als eine Ebene der Defense in Depth: Es sitzt in der Sitzung, vor `/security-review` auf Abruf und der vollständigen Code Review im Pull Request. Die genauen Hook-Events und die Schalter pro Umgebungsvariable beschreibt die [Plugin-Dokumentation](https://code.claude.com/docs/en/security-guidance) im Detail.
