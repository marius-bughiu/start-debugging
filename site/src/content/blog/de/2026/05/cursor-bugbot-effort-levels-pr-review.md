---
title: "Cursor Bugbot bekommt Effort-Stufen Default, High und Custom"
description: "Am 11. Mai 2026 hat Cursor Effort-Stufen für Bugbot ausgeliefert. Default findet 0,7 Bugs pro Review, High hebt das auf 0,95, und Custom erlaubt es, in natürlicher Sprache zu beschreiben, wann welcher Modus greift."
pubDate: 2026-05-12
tags:
  - "cursor"
  - "bugbot"
  - "ai-agents"
  - "pull-requests"
lang: "de"
translationOf: "2026/05/cursor-bugbot-effort-levels-pr-review"
translatedBy: "claude"
translationDate: 2026-05-12
---

Am 11. Mai 2026 hat Cursor die [Effort-Stufen für Bugbot ausgeliefert](https://cursor.com/changelog), den PR-Review-Agent, der Pull Requests gegen die beobachteten Repos kommentiert. Bis jetzt lief jedes Review dieselbe Schleife mit demselben Budget. Das neue Release gibt Teams-Admins und Individual-Nutzern mit nutzungsbasierter Abrechnung drei Stellschrauben in die Hand: Default, High und Custom. Die Zahlen, die Cursor mit dem Release veröffentlicht hat, lohnt es sich festzunageln, bevor man darüber spricht, wie es konfiguriert wird.

## Default gegen High, in gemessenen Bugs pro Lauf

Cursor nennt im [Changelog-Eintrag](https://cursor.com/changelog) zwei konkrete Zahlen:

- **Default** liegt im Schnitt bei **0,7 gefundenen Bugs pro Review** und wird als "optimized for efficiency and speed" beschrieben. Über 79 % der gemeldeten Probleme werden bis zum Merge der PR gelöst, und das ist der Teil, der für das Signal-Rausch-Verhältnis zählt.
- **High** liegt im Schnitt bei **0,95 gefundenen Bugs pro Review**. Es gibt mehr für Reasoning-Tokens aus und dauert pro PR länger.

Das sind 36 % mehr Bugs pro Lauf, bezahlt mit zusätzlicher Latenz und Tokens. Ob sich der Tausch lohnt, hängt davon ab, wo Ihre PRs sich häufen: Ein Repo mit einer langen Liste subtiler Regressionen ist ein anderes Problem als ein Repo, in dem die meisten Bugs in zehn Sekunden Diff-Lesen offensichtlich sind. Cursor trifft diese Entscheidung nicht für Sie, und genau darin liegt der Sinn der dritten Stufe.

## Custom ist ein Router in natürlicher Sprache

Der Custom-Modus liefert weder einen Slider noch ein YAML-Schema. Sie schreiben eine kurze Anweisung, und Bugbot benutzt sie als Routing-Prompt, um pro Review zwischen Default und High zu wählen. Das Muster, das Cursor in der [Bugbot-Dokumentation](https://docs.cursor.com/en/bugbot) vorschlägt, liest sich eher wie eine Triage-Regel als wie eine Konfigurationsdatei:

```text
Use High effort for any PR that:
- touches files under src/billing/** or src/auth/**
- changes a database migration (paths matching db/migrations/**)
- modifies a public API surface (anything in src/api/v1/**)

Use Default effort for everything else, including
documentation, tests, and dependency bumps.
```

Sie fügen das im Bugbot-Dashboard unter der Effort-Einstellung Ihres Repos ein. Bei der nächsten PR liest Bugbot die Diff-Metadaten, wendet die Regel an und wählt einen Modus, bevor das Review startet. Es gibt keinen Kompilierschritt und keine `bugbot.yaml`. Wenn die Regel mehrdeutig ist, fällt Bugbot auf Default zurück.

## Wo es eingestellt wird

Der Effort lebt auf Repository-Ebene, nicht auf Nutzer-Ebene, also kann ein einzelnes Repo nicht einen Entwickler auf High und einen anderen auf Default haben. Die Einstellung liegt im Bugbot-Dashboard unter `cursor.com/dashboard/bugbot/<repo>`, im Bereich "Review effort." Teams-Admins setzen sie global für die Repos einer Organisation. Individual-Plan-Nutzer mit nutzungsbasierter Abrechnung sehen dasselbe Panel für ihre eigenen Repos. Individual-Pläne mit Pauschaltarif bekommen keine Effort-Auswahl: Dieser Topf bleibt auf Default.

## Einen Modus wählen, ohne das Budget zu verbrennen

Die ehrliche Lesart ist, dass **High kein "mach es schlauer"-Button ist, sondern ein "gib mehr aus"-Button**. 36 % mehr Bugs pro Lauf bedeuten auch ungefähr 36 % mehr Tokens, die gegen Ihre Nutzungsgrenze abgerechnet werden, und der Latenz-Treffer zeigt sich am schmerzhaftesten bei den PRs, die Sie vor dem Mittag mergen wollen. Custom ist der einzige Modus, mit dem Sie diese Rechnung im Zaum halten: Schreiben Sie eine Regel, die auf die Codeteile zielt, an denen ein übersehener Bug Sie wirklich etwas kostet, und lassen Sie den Rest auf Default. Wenn Sie diese Regel nicht in drei Zeilen Deutsch formulieren können, brauchen Sie High vermutlich gar nicht.

Das Release erscheint zusammen mit [den Parallel-Build- und Split-PR-Features von Cursor 3.3](/de/2026/05/cursor-3-3-build-in-parallel-split-prs/), und das ist das größere Muster: Cursor zerlegt seine Agenten in Stellschrauben, die Sie pro Workflow konfigurieren können, statt in einen einzigen Default, der allen gefallen muss.
