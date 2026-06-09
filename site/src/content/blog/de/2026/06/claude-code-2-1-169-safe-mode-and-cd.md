---
title: "Claude Code 2.1.169 ergänzt --safe-mode und ein /cd, das den Prompt-Cache warm hält"
description: "Claude Code v2.1.169 (8. Juni 2026) bringt eine --safe-mode-Option, die jede Anpassung für sauberes Troubleshooting deaktiviert, sowie einen /cd-Befehl, der Ihre Sitzung in ein neues Verzeichnis verschiebt, ohne den Prompt-Cache mitten im Lauf zu zerstören."
pubDate: 2026-06-09
tags:
  - "claude-code"
  - "ai-agents"
  - "cli"
lang: "de"
translationOf: "2026/06/claude-code-2-1-169-safe-mode-and-cd"
translatedBy: "claude"
translationDate: 2026-06-09
---

Claude Code v2.1.169 erschien am 8. Juni 2026 mit zwei Änderungen, die auf die beiden lästigsten Momente einer langen Agent-Sitzung zielen: die Debugging-Spirale "liegt es an meiner Konfiguration oder am Tool?" und das Zurücksetzen des Prompt-Caches, das Sie jedes Mal bezahlen, wenn Sie in einem anderen Verzeichnis arbeiten müssen. Beides sind kleine Optionen. Beide nehmen echte Kosten weg.

## `--safe-mode` gibt Ihnen eine saubere Basis zum Eingrenzen

Wenn sich Claude Code merkwürdig verhält, ein Hook feuert, obwohl er das nicht sollte, ein MCP-Server beim Start hängt, eine Skill einen Slash-Befehl kapert, dann ist die schwierige Frage, ob der Fehler im CLI oder in Ihrem eigenen Stapel an Anpassungen steckt. Bisher bedeutete deren Beantwortung, `CLAUDE.md` manuell beiseitezuschieben, die Hooks in `settings.json` auszukommentieren und Plugins einzeln zu deaktivieren.

v2.1.169 fasst all das in einer einzigen Option zusammen:

```bash
# Start with CLAUDE.md, plugins, skills, hooks, and MCP servers all disabled
claude --safe-mode

# Same thing via env var, handy in CI or a wrapper script
CLAUDE_CODE_SAFE_MODE=1 claude
```

Verschwindet das Problem im sicheren Modus, liegt es bei Ihnen, und Sie können die Anpassungen Gruppe für Gruppe wieder aktivieren, bis es zurückkehrt. Bleibt es bestehen, liegt es am CLI, und Sie haben eine saubere Reproduktion zum Melden. Das ist das Agent-CLI-Äquivalent dazu, Windows im abgesicherten Modus zu starten oder einen Editor mit `--disable-extensions` zu öffnen: keine Lösung, aber der schnellste Weg zu einem Urteil.

## `/cd` verschiebt die Sitzung, ohne den Cache zurückzusetzen

Die andere Änderung ist subtiler und spart bei langen Läufen echtes Geld. Claude Code cacht das Präfix der Konversation über den Prompt-Cache von Anthropic, der eine kurze TTL hat und dafür sorgt, dass die folgenden Runden schnell und günstig bleiben. Das Verzeichnis zu wechseln bedeutete bisher Beenden und Neustarten, was diesen Cache verwarf. Die nächste Runde las Ihren gesamten Kontext ohne Cache erneut: langsamer, und zum vollen `cache_creation`-Tarif abgerechnet statt zum günstigen Cache-Lesetarif.

Der neue `/cd`-Befehl verschiebt eine aktive Sitzung an Ort und Stelle in ein neues Verzeichnis:

```text
# Working in the API project, now need to touch the shared library
/cd ../shared-lib

# Absolute paths work too
/cd C:\S\start-debugging\site
```

Die Sitzung behält ihren Verlauf und ihren warmen Cache, sodass die Runde direkt nach `/cd` weiterhin ein Cache-Treffer ist. Bei einer Multi-Repo-Aufgabe, bei der Sie zwischen einem Backend- und einem Frontend-Baum hin- und herspringen, ist das der Unterschied zwischen einmal für einen gecachten Kontext zu bezahlen und ihn bei jedem Verzeichniswechsel erneut zu bezahlen.

## Ein dritter Schalter, den man kennen sollte

Dieselbe Version ergänzt `disableBundledSkills` (und `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS`), das dem Modell die mitgelieferten Skills, Workflows und integrierten Slash-Befehle von Claude Code verbirgt. Wenn Sie Ihr eigenes, dezidiertes Set haben und die mitgelieferten im Weg sind, ist das Ihr Ausschalter.

Das setzt das Muster der [Plugin- und Worktree-Korrekturen von v2.1.128](/de/2026/05/claude-code-2-1-128-plugin-zip-worktree-fix/) fort: unauffällige CLI-Änderungen, die eine Klasse von Ärgernissen aus dem täglichen Ablauf nehmen. Die vollständigen Notizen finden Sie auf der [Release-Seite zu v2.1.169](https://github.com/anthropics/claude-code/releases/tag/v2.1.169).
