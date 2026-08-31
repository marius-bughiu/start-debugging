---
title: "Copilot Code Review wechselt am 28. September auf Balanced"
description: "Die GitHub-Changelogs vom 27. und 28. August 2026 entfernen die Grenze von 20.000 Zeilen pro Review, prüfen jetzt auch von Bots erstellte PRs und stellen die Standard-Aufwandsstufe am 28. September von Lite auf Balanced um. Alle drei erhöhen den Verbrauch an AI Credits im selben Monat."
pubDate: 2026-08-31
tags:
  - "github-copilot"
  - "code-review"
  - "ai-agents"
  - "devops"
lang: "de"
translationOf: "2026/08/copilot-code-review-defaults-to-balanced-on-september-28"
translatedBy: "claude"
translationDate: 2026-08-31
---

GitHub hat innerhalb von zwei Tagen zwei Changelog-Einträge veröffentlicht, die zusammengenommen sowohl verändern, was Copilot code review betrachtet, als auch, was es kostet. Am 27. August 2026 fiel die Größenbegrenzung für Reviews weg, und von Bots erstellte Pull Requests wurden prüfbar. Am 28. August 2026 kündigte GitHub an, dass am **28. September 2026** die Standard-Aufwandsstufe von Lite auf Balanced wechselt. Nichts davon ist optional.

## Drei Multiplikatoren im selben Monat

Der Eintrag vom 27. August, [Copilot code review: resolution reasons and expanded capabilities](https://github.blog/changelog/2026-08-27-copilot-code-review-resolution-reasons-and-expanded-capabilities/), entfernte die Obergrenze, die ein Review bisher bei 300 Dateien oder 20.000 Codezeilen abbrach. Große Refactorings und PRs mit generiertem Code, die Copilot stillschweigend übersprang, werden jetzt vollständig geprüft. Derselbe Eintrag machte von Bots erstellte Pull Requests für automatische Reviews zugänglich, ausdrücklich einschließlich des Copilot cloud agent. Von Agenten geöffnete PRs laufen damit über den Reviewer, statt direkt in einer menschlichen Warteschlange zu landen.

Der [Eintrag zu Richtlinien und Abrechnung](https://github.blog/changelog/2026-08-28-upcoming-changes-to-github-copilot-policies-and-billing/) ändert dann den Standardaufwand. Die GitHub-Dokumentation benennt den Kompromiss deutlich: Lite ist eine "standard review", Balanced liefert "deeper analysis of complex logic, security-sensitive code, and cross-service changes", und Balanced-Reviews "use more AI credits, and may consume marginally more GitHub Actions minutes."

Mehr geprüfte PRs, größere Diffs pro Review und ein tieferer Modelldurchlauf bei jedem einzelnen. Wer AI Credits nach der Juli-Rechnung budgetiert hat, wird im September andere Zahlen sehen.

## Lite vor dem 28. September festschreiben, wenn das heutige Verhalten bleiben soll

Die Aufwandsstufe existiert sowohl auf Organisations- als auch auf Repository-Ebene, und die Repository-Einstellung gewinnt. Settings, dann Copilot, dann Code review, unter "Code, planning, and automation". Wird sie vor dem 28. September ausdrücklich auf Lite gesetzt, bleibt das aktuelle Verhalten erhalten; wird sie nicht angefasst, gilt Balanced.

Gleichzeitig lohnt sich ein Blick auf das Flag `review_on_push` in den Rulesets. Es prüft bei jedem Push erneut und multipliziert sich damit mit dem tieferen Standard, statt sich nur zu addieren. Der Regeltyp heißt `copilot_code_review` und lässt sich prüfen, ohne jedes Repository einzeln zu öffnen:

```bash
gh api /repos/OWNER/REPO/rulesets --jq '.[].id' \
  | xargs -I{} gh api /repos/OWNER/REPO/rulesets/{} \
      --jq '.rules[] | select(.type=="copilot_code_review")'
```

Eine Regel, die bei jedem Push auslöst, sieht so aus:

```json
{
  "type": "copilot_code_review",
  "parameters": {
    "review_on_push": true,
    "review_draft_pull_requests": true
  }
}
```

In einem Branch, in dem sechsmal gepusht wird, bevor jemand ein Review anfordert, ergeben `review_on_push` plus `review_draft_pull_requests` sechs Balanced-Reviews eines Diffs, den noch niemand angesehen hat.

## Resolution Reasons machen die Kommentare endlich messbar

Die einzige uneingeschränkt gute Änderung: Das Auflösen eines Copilot-Review-Kommentars verlangt jetzt einen Grund aus einem Dropdown neben "Resolve conversation". Die Optionen sind **Addressed**, **Won't fix** und **Incorrect**. Der dritte Wert ist der entscheidende, denn zum ersten Mal ist die False-Positive-Rate automatisierter Reviews eine Zahl, die sich abrufen lässt, und kein Bauchgefühl der erfahrenen Entwickler. Bevor Balanced über alle Repositories läuft, empfiehlt sich ein Sprint mit Lite und sauber gesetzten Gründen, um das tatsächliche Verhältnis zu sehen.

Zwei weitere Termine aus demselben Eintrag: Neue Business- und Enterprise-Seat-Zuweisungen erfordern ab dem 1. September 2026 die Zahlung vor dem Zugriff, bestehende Kunden sehen ab dem 1. Oktober 2026 Seat-Kosten im Voraus, und die am 28. September erscheinende einheitliche Copilot-Erfahrung verlängert die Aufbewahrung der Chatdaten von 28 Tagen auf die Lebensdauer des Kontos. Letzteres ist standardmäßig aktiv, und ein Opt-out kostet Copilot Chat auf github.com und mobil vollständig. Das ist eine Compliance-Frage, keine Vorliebe.

Zur Kontextseite desselben Produkts siehe [Copilot code review liest jetzt den Ordner .github/skills](/de/2026/07/copilot-code-review-agent-skills-and-mcp-ga/).
