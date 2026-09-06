---
title: "Copilot Code Review kann jetzt Pull Requests genehmigen"
description: "Das GitHub-Changelog vom 2026-09-01 erlaubt Copilot, eine genehmigende Review abzugeben, die die Regel für erforderliche Genehmigungen eines Repositorys erfüllt. Standardmäßig deaktiviert, über Datei-Globs eingegrenzt und bei neuen Commits verworfen. Das ändert sich tatsächlich an Ihrem Branch-Schutz."
pubDate: 2026-09-06
tags:
  - "github-copilot"
  - "code-review"
  - "ai-agents"
  - "devops"
lang: "de"
translationOf: "2026/09/copilot-code-review-can-now-approve-pull-requests"
translatedBy: "claude"
translationDate: 2026-09-06
---

Am 2026-09-01 hat GitHub die Änderung ausgeliefert, die Copilot Code Review vom Kommentar zur Autorität macht: [Copilot code review can now approve pull requests](https://github.blog/changelog/2026-09-01-copilot-code-review-can-now-approve-pull-requests/). Sie ist als öffentliche Preview für Copilot Pro, Pro+, Max, Business und Enterprise verfügbar.

Hier sind zwei getrennte Dinge gelandet, und wer sie vermischt, erlebt Überraschungen.

## Eine Einschätzung ist keine Genehmigung

Jede Copilot-Review beendet ihren Übersichtskommentar jetzt mit einer Genehmigungseinschätzung: Copilots Urteil darüber, ob der Pull Request bereit zur Genehmigung ist. Dieser Teil ist für alle aktiv und ändert mechanisch nichts. Es ist ein Satz in einem Kommentar und berührt Ihre Merge-Anforderungen nicht.

Das zweite ist die tatsächliche genehmigende Review, abgegeben von `copilot-pull-request-reviewer[bot]`, die für die Regel der erforderlichen Genehmigungen eines Repositorys genauso zählt wie die Genehmigung eines Teammitglieds. Das ist **standardmäßig deaktiviert** und muss von einer Administration auf Unternehmens-, Organisations- oder Repository-Ebene eingeschaltet werden.

Wenn Ihr Repository "Require 1 approval" in einem Branch-Ruleset stehen hat und Sie das aktivieren, haben Sie keine Reviewerin ergänzt. Sie haben den Menschen optional gemacht.

## Grenzen Sie den Umfang mit Globs ein, bevor Sie aktivieren

Die Einstellung auf Repository-Ebene nimmt eine Liste von Datei-Globs entgegen, einen pro Zeile, und zählt eine Copilot-Genehmigung nur "bei Pull Requests, in denen jede geänderte Datei auf einen der Globs passt". Das entscheidende Wort ist *jede*. Ein Pull Request, der `docs/setup.md` und `src/Payments/Charge.cs` anfasst, erhält keine zählende Genehmigung, wenn Ihre Glob-Liste nur Dokumentation abdeckt. Das ist die richtige Ausgangshaltung: Beginnen Sie bei den Pfaden, bei denen eine falsche Genehmigung billig ist.

Genehmigungen werden außerdem verworfen, wenn neue Commits gepusht werden, genau wie eine menschliche Genehmigung in einem Repository, das veraltete Reviews verwirft. Der Fehlerfall ist also nicht eine alte Freigabe, die einen Force Push überdauert.

## Automatische Review ist eine Ruleset-Regel und damit skriptbar

Der Genehmigungsschalter liegt in den Einstellungen, aber ob Copilot überhaupt reviewt, ist eine Branch-Ruleset-Regel (`copilot_code_review`) und lässt sich daher über die API anlegen statt per Klick:

```bash
gh api repos/OWNER/REPO/rulesets --method POST --input - <<'JSON'
{
  "name": "copilot-review-main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/main"], "exclude": [] } },
  "rules": [
    {
      "type": "copilot_code_review",
      "parameters": {
        "review_on_push": true,
        "review_draft_pull_requests": false
      }
    }
  ]
}
JSON
```

Kombinieren Sie das mit einer Audit-Abfrage, denn ein Dashboard dafür liefert GitHub nicht mit. Genehmigungen sind gewöhnliche Reviews, also lassen sie sich zählen:

```bash
gh api "repos/OWNER/REPO/pulls/123/reviews" \
  --jq '.[] | select(.user.login == "copilot-pull-request-reviewer[bot]") | {state, submitted_at}'
```

Führen Sie das über die gemergten Pull Requests aus, und Sie haben die Zahl, auf die es ankommt: wie viele Merges ihre Genehmigungsschwelle passiert haben, ohne dass ein Mensch hingesehen hat. `review_on_push` zu aktivieren vervielfacht zudem den Verbrauch an Premium Requests, was sich damit summiert, dass [die Standard-Review-Stufe am 2026-09-28 von Lite auf Balanced wechselt](/de/2026/08/copilot-code-review-defaults-to-balanced-on-september-28/).

Aktivieren Sie es zuerst für generierte Dateien und Dokumentation. Weiten Sie es aus, wenn Sie die Audit-Zahlen haben, nicht vorher.
