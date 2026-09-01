---
title: "VS Code 1.135 bringt /rubber-duck, und nutzt bewusst ein anderes Modell"
description: "Der experimentelle Befehl /rubber-duck in VS Code 1.135 gibt Plan, Code und Tests des Agenten an ein Modell einer anderen Familie zur Prüfung. GPT-5.4 kritisiert Claude, und genau diese Wahl über Familiengrenzen hinweg ist der Kern."
pubDate: 2026-09-01
tags:
  - "ai-agents"
  - "github-copilot"
  - "llm"
  - "claude-code"
lang: "de"
translationOf: "2026/09/vscode-1-135-rubber-duck-cross-model-review"
translatedBy: "claude"
translationDate: 2026-09-01
---

VS Code 1.135 erschien am 2026-08-26, und GitHub nahm es am 2026-08-31 in das Changelog "GitHub Copilot in VS Code, August 2026 releases" auf. Zwischen der ganzen Arbeit am Sitzungslayout steckt das Interessanteste der Version: ein experimenteller Befehl `/rubber-duck`, der eine zweite Meinung zur Arbeit des Agenten von einem Modell aus einer anderen Familie einholt.

## Selbstprüfung findet nicht, was das Modell bereits übersehen hat

Ein Modell die eigene Ausgabe prüfen zu lassen, kostet fast nichts, und deshalb macht es nahezu jedes Agenten-Harness. Es ist aber schwach. Dieselben Gewichte, die den Plan erzeugt haben, erzeugen auch die Prüfung, also sind die blinden Flecken korreliert: Wenn das Modell beim Schreiben des Codes nicht an den Fall des gleichzeitigen Schreibens gedacht hat, denkt es beim Prüfen des Codes ebenso wenig daran.

Rubber Duck setzt auf das Gegenteil. Der Orchestrator ist ein beliebiges Modell der Claude-Familie aus der Modellauswahl, der Prüfer ist GPT-5.4. Die Strategie des komplementären Modells ist ausdrücklich gewollt und nicht zufällig: Der Prüfer stammt aus einer anderen Familie als das Hauptmodell, sodass eine Claude-Sitzung einen GPT-Kritiker erhält und eine GPT-Sitzung umgekehrt. GitHub sagt offen, dass dies ein Experiment ist, und spricht davon, "weitere Modellfamilien für den Orchestrator und für Rubber Duck" zu erkunden.

## Ein nur lesender Kritiker mit triagierter Ausgabe

Rubber Duck kann nicht bearbeiten. Es liest den Plan, das Diff und die Tests und sucht nach inhaltlichen Problemen: Logikfehler, Designschwächen, Sicherheitslücken, fehlende Testabdeckung. Was zurückkommt, ist triagiert und nicht einfach abgeladen:

```text
> /rubber-duck

Blocking
  - RefreshTokenAsync writes the new token before the old one is revoked.
    A crash between the two leaves both valid.

Non-blocking
  - The retry loop has no jitter. Three clients failing together will
    stay in lockstep.

Suggestions
  - No test covers an expired token with a valid signature.
```

Die Aufteilung in blockierend, nicht blockierend und Vorschläge ist der Teil, den Sie übernehmen sollten, wenn Sie einen eigenen Review-Subagenten bauen. Eine ungeordnete Liste mit zwölf Beobachtungen wird überflogen; drei blockierende Punkte werden gelesen.

## Es feuert von selbst, und zwar sparsam

Sie können es von Hand aufrufen, aber Copilot ruft es auch an vier Stellen mit dem höchsten Nutzen auf: nach dem Entwurf eines Plans, nach einer komplexen Implementierung, nach dem Schreiben von Tests und vor deren Ausführung, sowie wenn der Agent in einer Schleife feststeckt. Der letzte Auslöser rechtfertigt den Aufwand am deutlichsten, denn ein Agent in einer Schleife ist das klarste Signal dafür, dass dem Hauptmodell die Ideen zur eigenen Ausgabe ausgegangen sind.

Intern läuft es über das bestehende Task-Tool von Copilot, dieselbe Maschinerie wie bei anderen Subagenten. Das heißt, es ist nicht kostenlos: Jeder automatische Aufruf ist ein vollständiger Modellzug gegen Ihren Premium-Verbrauch, zusätzlich zu den Tokens des Hauptagenten. VS Code 1.135 hat außerdem eine Tokenabrechnung pro Modell in der Fußzeile jeder Chat-Antwort ergänzt, und darüber erfahren Sie, was die Ente kostet.

## Einschalten

In VS Code funktioniert `/rubber-duck` innerhalb einer Copilot-Agent-Host-Sitzung, also dem Modus, der das Harness in einem eigenen Prozess über das Agent Host Protocol ausführt. Falls Sie Agent-Host-Sitzungen noch nicht aktiviert haben: Das ist derselbe Funktionsumfang, der [in VS Code 1.128 die Claude-Agent-Host-Sitzungen mit mehreren Chats gebracht hat](/de/2026/07/vscode-1-128-multi-chat-claude-agent-host-sessions/). In der GitHub Copilot CLI schalten Sie es mit dem Befehl `/experimental` frei.

Die Verfügbarkeit ist an Bedingungen geknüpft: Die Hauptsitzung muss auf einem Claude- oder GPT-Modell laufen, und ein passendes komplementäres Modell muss verfügbar sein. Trifft eines von beidem nicht zu, erscheint der Befehl schlicht nicht.

Alle Details stehen in den [Release Notes zu VS Code 1.135](https://code.visualstudio.com/updates/v1_135) und in GitHubs Beitrag über das [Kombinieren von Modellfamilien für eine zweite Meinung](https://github.blog/ai-and-ml/github-copilot/github-copilot-cli-combines-model-families-for-a-second-opinion/).
