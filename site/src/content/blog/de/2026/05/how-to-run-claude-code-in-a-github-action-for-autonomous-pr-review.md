---
title: "Wie man Claude Code in einer GitHub Action für autonome PR-Reviews ausführt"
description: "Konfigurieren Sie anthropics/claude-code-action@v1, sodass jeder Pull Request einen autonomen Claude-Code-Review erhält, ohne dass ein @claude-Trigger nötig ist. Enthält das v1-YAML, claude_args für claude-sonnet-4-6 vs. claude-opus-4-7, Tools für Inline-Kommentare, Pfadfilter, REVIEW.md und die Wahl zwischen der selbst gehosteten Action und der Managed-Code-Review-Forschungsvorschau."
pubDate: 2026-05-01
tags:
  - "claude-code"
  - "ai-agents"
  - "github-actions"
  - "automation"
  - "anthropic-sdk"
lang: "de"
translationOf: "2026/05/how-to-run-claude-code-in-a-github-action-for-autonomous-pr-review"
translatedBy: "claude"
translationDate: 2026-05-01
---

Ein Pull Request wird geöffnet, GitHub Actions wacht auf, Claude Code liest den Diff im Kontext des restlichen Repositorys, postet Inline-Kommentare zu den Zeilen, die ihm nicht gefallen, und schreibt eine Zusammenfassung. Kein Mensch hat `@claude` getippt. Das ist der Workflow, den dieser Beitrag durchgängig mit `anthropics/claude-code-action@v1` (der GA-Version vom 26. August 2025), `claude-sonnet-4-6` für den Review-Durchlauf und einem optionalen Upgrade auf `claude-opus-4-7` für sicherheitskritische Pfade einrichtet. Stand Mai 2026 gibt es zwei Wege, das zu tun, und sie sind nicht austauschbar, also beginnt der Beitrag mit der Wahl und geht dann den Pfad der selbst gehosteten Action durch, der für jeden Plan funktioniert.

Die kurze Antwort: Verwenden Sie `anthropics/claude-code-action@v1`, ausgelöst auf `pull_request: [opened, synchronize]`, mit einem Prompt und `--allowedTools "mcp__github_inline_comment__create_inline_comment,Bash(gh pr comment:*),Bash(gh pr diff:*),Bash(gh pr view:*)"`. Verzichten Sie auf das Filtern nach `@claude`-Erwähnung. Wenn Ihre Organisation einen Team- oder Enterprise-Plan hat und kein Zero Data Retention nutzt, ist die [Managed-Code-Review-Forschungsvorschau](https://code.claude.com/docs/en/code-review) die reibungsärmere Alternative für dieselbe Aufgabe.

## Zwei Primitive, zwei Kostenmodelle, eine Entscheidung

Anthropic liefert 2026 zwei separate "Claude-reviewt-Ihren-PR"-Produkte aus. Sie sehen von außen ähnlich aus und verhalten sich sehr unterschiedlich:

| Fähigkeit                        | claude-code-action@v1                   | Managed Code Review (Preview)              |
| :------------------------------- | :-------------------------------------- | :----------------------------------------- |
| Wo es läuft                      | Ihre GitHub-Actions-Runner              | Anthropic-Infrastruktur                    |
| Was Sie konfigurieren            | Eine Workflow-YAML in `.github/workflows/` | Toggle in `claude.ai/admin-settings`       |
| Trigger-Oberfläche               | Jedes GitHub-Event, das Sie schreiben können | Dropdown pro Repo: opened, jeder Push, manuell |
| Modell                           | `--model claude-sonnet-4-6` oder beliebige ID | Multi-Agenten-Flotte, Modell nicht wählbar |
| Inline-Kommentare auf Diff-Zeilen | Über den `mcp__github_inline_comment` MCP-Server | Nativ, mit Schweregrad-Markern             |
| Kosten                           | API-Token plus Ihre Actions-Minuten     | $15-25 pro Review, als Zusatznutzung abgerechnet |
| Plan-Voraussetzung               | Beliebiger Plan mit API-Key             | Team oder Enterprise, nur Nicht-ZDR        |
| Verfügbar auf Bedrock / Vertex   | Ja (`use_bedrock: true`, `use_vertex: true`) | Nein                                     |
| Eigener Prompt                   | Freier Text in der Eingabe `prompt`     | `CLAUDE.md` plus `REVIEW.md`               |

Das Managed-Produkt ist die richtige Antwort, wenn es für Sie verfügbar ist. Es betreibt eine Flotte spezialisierter Agenten parallel und führt vor dem Posten einer Erkenntnis einen Verifizierungsschritt aus, was Falschmeldungen reduziert. Der Tradeoff ist, dass Sie kein Modell festlegen können und der Preis mit der PR-Größe so skaliert, dass ein einzelnes $25-Review eines 2000-Zeilen-Refactors einen Manager schocken kann, der eine Token-Raten-Abrechnung erwartet hatte.

Die Action ist die richtige Antwort, wenn Sie volle Kontrolle über den Prompt wollen, Bedrock oder Vertex aus Datenresidenz-Gründen nutzen wollen, nach Pfadfiltern oder Branch-Namen gaten wollen oder nicht auf einem Team- oder Enterprise-Plan sind. Alles Folgende ist der Action-Pfad.

## Der minimal lauffähige autonome Review-Workflow

Beginnen Sie in einem Repo, in dem Sie Admin sind. Aus einem Terminal mit installiertem [Claude Code 2.x](https://code.claude.com/docs/en/setup):

```text
# Claude Code 2.x
claude
/install-github-app
```

Der Slash-Befehl führt Sie durch die Installation der [Claude GitHub App](https://github.com/apps/claude) auf dem Repo und durch das Speichern von `ANTHROPIC_API_KEY` als Repo-Secret. Er funktioniert nur für direkte Anthropic-API-Nutzer. Für Bedrock oder Vertex verdrahten Sie OIDC manuell, was die [GitHub-Actions-Dokumentation](https://code.claude.com/docs/en/github-actions) unter "Using with AWS Bedrock & Google Vertex AI" abdeckt.

Legen Sie das in `.github/workflows/claude-review.yml`:

```yaml
# claude-code-action v1 (GA Aug 26, 2025), Claude Code 2.x
name: Claude Code Review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      id-token: write
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 1

      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          prompt: |
            REPO: ${{ github.repository }}
            PR NUMBER: ${{ github.event.pull_request.number }}

            Review the diff for correctness, security, and obvious bugs.
            Focus on logic errors, unhandled error paths, missing input
            validation, and tests that do not actually exercise the new
            behavior. Skip style nits. Post inline comments on the lines
            you have something concrete to say about, then a one-paragraph
            summary as a top-level PR comment.

          claude_args: |
            --model claude-sonnet-4-6
            --max-turns 8
            --allowedTools "mcp__github_inline_comment__create_inline_comment,Bash(gh pr comment:*),Bash(gh pr diff:*),Bash(gh pr view:*)"
```

Das ist alles. Kein `@claude`-Trigger-Gating, kein `if:`-Conditional auf den Kommentartext, kein `mode: agent`. Das [v1-Release](https://code.claude.com/docs/en/github-actions) der Action erkennt den Automatisierungsmodus automatisch, sobald Sie eine `prompt`-Eingabe in einem Nicht-Kommentar-Event bereitstellen, sodass Sie das Conditional nicht mehr selbst schreiben. Der `permissions`-Block gewährt genau das, was der Prompt braucht: das Repo lesen, PR-Kommentare schreiben und (für OIDC gegen Cloud-Anbieter) ein ID-Token ausstellen.

Ein paar Dinge in diesem YAML sind wichtig und leicht falsch zu machen.

`actions/checkout@v6` mit `fetch-depth: 1`. Die Action liest den Diff des PR über `gh`, aber der Prompt erlaubt es ihr auch, Dateien im Arbeitsverzeichnis zu öffnen, um eine Erkenntnis vor dem Posten zu verifizieren. Ohne Checkout schlägt jede Runde "schau dir den umliegenden Code an" fehl, und Claude rät entweder oder läuft in ein Timeout.

`--allowedTools "mcp__github_inline_comment__create_inline_comment,..."`. Die Action liefert einen MCP-Server aus, der GitHubs Review-API kapselt. Ohne diese Allowlist hat Claude keine Möglichkeit, einen Kommentar an eine bestimmte Zeile zu hängen. Er fällt auf einen großen Top-Level-PR-Kommentar zurück, was nur die Hälfte des Werts ist. Die `Bash(gh pr ...)`-Einträge sind auf das Lesen des Diffs und das Posten des Zusammenfassungskommentars beschränkt.

`--max-turns 8`. Konversationsbudget. Acht reichen, damit das Modell den Diff liest, drei oder vier Dateien zur Kontextgewinnung öffnet und Kommentare postet. Das höher zu setzen ist selten der Gewinn, der es zu sein scheint; wenn Reviews in Timeouts laufen, schränken Sie den Pfadfilter ein oder wechseln Sie das Modell, statt mehr Turns zu verbrauchen.

## v1 hat viele Beta-Workflows zerbrochen

Wenn Sie von `claude-code-action@beta` kommen, läuft Ihr alter YAML nicht mehr. Die [Tabelle der Breaking Changes](https://code.claude.com/docs/en/github-actions#breaking-changes-reference) der v1 ist der Migrations-Spickzettel:

| Beta-Eingabe          | v1-Äquivalent                          |
| :-------------------- | :------------------------------------- |
| `mode: tag` / `agent` | Entfernt, aus dem Event autodetektiert |
| `direct_prompt`       | `prompt`                               |
| `override_prompt`     | `prompt` mit GitHub-Variablen          |
| `custom_instructions` | `claude_args: --append-system-prompt`  |
| `max_turns: "10"`     | `claude_args: --max-turns 10`          |
| `model: ...`          | `claude_args: --model ...`             |
| `allowed_tools: ...`  | `claude_args: --allowedTools ...`      |
| `claude_env: ...`     | `settings`-JSON-Format                 |

Das Muster ist klar: Jede CLI-förmige Einstellung kollabiert in `claude_args`, und alles, was früher "ist das der Kommentar-Trigger-Flow oder der Automatisierungs-Flow" disambiguiert hat, wurde entfernt, weil v1 es aus dem Event ableitet. Die Migration ist mechanisch, aber die Reihenfolge zählt. Wenn Sie `mode: tag` stehen lassen, scheitert v1 mit einem Konfigurationsfehler kontrolliert, statt stillschweigend den falschen Pfad zu gehen.

## Die Modellwahl: Sonnet 4.6 ist aus gutem Grund der Default

Die Action nutzt standardmäßig `claude-sonnet-4-6`, wenn `--model` nicht gesetzt ist, und das ist der richtige Default für PR-Reviews. Sonnet 4.6 ist schneller, billiger pro Token und gut kalibriert für die "scanne einen Diff, finde die offensichtlichen Bugs"-Schleife, die ein PR-Review tatsächlich ist. Opus 4.7 ist das Upgrade, zu dem Sie greifen, wenn der Diff Authentifizierung, Verschlüsselung, Zahlungsflüsse oder irgendetwas berührt, wo ein übersehener Bug mehr kostet als ein $5-Review.

Das sauberste Muster sind zwei Workflows. Sonnet 4.6 auf jedem PR, Opus 4.7 nur, wenn der Pfadfilter sagt, dass es die Ausgabe wert ist:

```yaml
# Opus 4.7 review for security-critical paths only
on:
  pull_request:
    types: [opened, synchronize]
    paths:
      - "src/auth/**"
      - "src/billing/**"
      - "src/api/middleware/**"

jobs:
  review-opus:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      id-token: write
    steps:
      - uses: actions/checkout@v6
        with: { fetch-depth: 1 }

      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          prompt: |
            Treat this diff as security-sensitive. Flag any changes to
            authentication, session handling, secret storage, or trust
            boundaries. Cite a file:line for every claim about behavior,
            do not infer from naming.
          claude_args: |
            --model claude-opus-4-7
            --max-turns 12
            --allowedTools "mcp__github_inline_comment__create_inline_comment,Bash(gh pr diff:*),Bash(gh pr view:*),Bash(gh pr comment:*)"
```

Derselbe Trick funktioniert umgekehrt: gaten Sie den Sonnet-Workflow auf `paths-ignore: ["docs/**", "*.md", "src/gen/**"]`, damit reine Doku-PRs keine Token verbrauchen.

## Inline-Kommentare und Fortschrittsverfolgung hinzufügen

Der MCP-Server `mcp__github_inline_comment__create_inline_comment` ist das Stück, das Claude von "schreibt einen langen PR-Kommentar" zu "platziert Vorschläge auf bestimmten Diff-Zeilen" bringt. Er wird über `--allowedTools` freigeschaltet, und das ist die ganze Verdrahtung, die nötig ist. Das Modell entscheidet, wann es ihn aufruft.

Für größere Reviews, bei denen Sie ein sichtbares Signal wollen, dass die Ausführung lebt, liefert die Action eine `track_progress`-Eingabe aus. Setzen Sie `track_progress: true`, und die Action postet einen Tracking-Kommentar mit Checkboxen, hakt sie ab, während Claude jeden Teil des Reviews abschließt, und markiert am Ende als erledigt. Das vollständige Muster aus dem [offiziellen `pr-review-comprehensive.yml`-Beispiel](https://github.com/anthropics/claude-code-action/tree/main/examples) ist:

```yaml
- uses: anthropics/claude-code-action@v1
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    track_progress: true
    prompt: |
      REPO: ${{ github.repository }}
      PR NUMBER: ${{ github.event.pull_request.number }}

      Comprehensive review covering: code quality, security, performance,
      test coverage, documentation. Inline comments for specific issues,
      one top-level summary at the end.
    claude_args: |
      --allowedTools "mcp__github_inline_comment__create_inline_comment,Bash(gh pr comment:*),Bash(gh pr diff:*),Bash(gh pr view:*)"
```

`track_progress` ist das, was v1 dem alten Beta-`mode: agent`-UX am nächsten kommt, und es ist die richtige Wahl, wenn Reviews regelmäßig länger als ein, zwei Minuten dauern und der PR-Autor wissen möchte, dass er läuft.

## Was der Reviewer meldet, kalibrieren

Ein Workflow, der jeden Variablennamen und jedes fehlende Komma kommentiert, ist innerhalb einer Woche stummgeschaltet. Zwei Dateien im Repo-Root steuern, was das Modell ernst nimmt: `CLAUDE.md` für allgemeines Verhalten und (nur für die Managed-Code-Review-Vorschau) `REVIEW.md` für review-spezifische Regeln. Die Action lädt `REVIEW.md` nicht automatisch, liest aber `CLAUDE.md` genauso wie eine lokale Claude-Code-Sitzung, und ein knappes `CLAUDE.md` plus ein knapper `prompt` decken denselben Boden ab.

Die Regeln, die die Review-Qualität wirklich verändern, sind konkret, repo-spezifisch und kurz:

```markdown
# CLAUDE.md (excerpt)

## What "important" means here
Reserve "important" for findings that would break behavior in
production, leak data, or block a rollback: incorrect logic,
unscoped database queries, PII in logs, migrations that are not
backward compatible. Style and naming are nits at most.

## Cap the nits
Report at most five nits per review. If you found more, say
"plus N similar items" in the summary.

## Do not report
- Anything CI already enforces (lint, format, type errors)
- Generated files under `src/gen/` and any `*.lock`
- Test-only code that intentionally violates production rules

## Always check
- New API routes have an integration test
- Log lines do not include user IDs or request bodies
- Database queries are scoped to the caller's tenant
```

Diesen Inhalt grob in die `prompt`-Eingabe zu kleben, funktioniert ebenfalls und hat den Vorteil, dass die Regeln zusammen mit der Workflow-Datei versioniert werden. So oder so ist der entscheidende Hebel, "laut Nein zur Nitpick-Menge zu sagen", weil Sonnets Default-Review-Stimme gründlicher ist, als die meisten Teams es wollen.

## Forks, Secrets und die `pull_request_target`-Falle

Das Standard-Event `on: pull_request` läuft im Kontext des Head-Branches des PR. Für PRs aus Forks heißt das, dass der Workflow ohne Zugriff auf Repo-Secrets läuft, einschließlich `ANTHROPIC_API_KEY`. Die Lösung, die naheliegend wirkt, ist der Wechsel zu `pull_request_target`, das im Kontext des Base-Branches läuft und Secrets hat. Tun Sie das nicht für autonome Claude-Reviews, denn `pull_request_target` checkt standardmäßig den Code des Base-Branches aus, das heißt, Sie reviewen den falschen Baum, und wenn Sie das Checkout so ändern, dass es die Head-Ref holt, lassen Sie modellgesteuerte Tools gegen vom Angreifer kontrollierten Code mit Secrets im Scope laufen.

Tragfähige Muster sind: `on: pull_request` belassen und akzeptieren, dass Fork-PRs nicht reviewt werden (nutzen Sie die Managed-Code-Review-Vorschau, falls Sie die abdecken müssen), oder einen manuellen Workflow betreiben, den Maintainer nach einer Sichtprüfung des Diffs auf einem Fork-PR auslösen. Die vollständige [Sicherheitsanleitung](https://github.com/anthropics/claude-code-action/blob/main/docs/security.md) lohnt sich einmal zu lesen, bevor Sie das irgendwo außerhalb eines privaten Repos ausrollen.

## Wann stattdessen zu Bedrock oder Vertex greifen

Wenn Ihre Organisation über AWS Bedrock oder Google Vertex AI läuft, unterstützt die Action beide mit `use_bedrock: true` oder `use_vertex: true` plus einem OIDC-authentifizierten Schritt vor dem Lauf der Action. Das Format der Modell-ID ändert sich (Bedrock nutzt die regionale Präfixform, zum Beispiel `us.anthropic.claude-sonnet-4-6`), und die Cloud-Anbieter-Dokumentation führt durch die IAM- und Workload-Identity-Federation-Einrichtung. Die obigen Trigger- und Prompt-Muster bleiben unverändert. Derselbe Ansatz ist für Microsoft Foundry dokumentiert. Das einzige Anthropic-managed Produkt, das diese Pfade nicht unterstützt, ist die Code-Review-Forschungsvorschau, was einer der Gründe ist, warum die selbst gehostete Action auch nach dem GA-Release der Managed-Vorschau nützlich bleibt.

## Verwandt

- [Wie man eine wiederkehrende Claude-Code-Aufgabe einrichtet, die GitHub-Issues triagiert](/de/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/)
- [Wie man einen eigenen MCP-Server in TypeScript baut, der eine CLI kapselt](/de/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/)
- [Wie man Prompt Caching zu einer Anthropic-SDK-App hinzufügt und die Trefferquote misst](/de/2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate/)
- [Claude Code 2.1.119: Pull Requests von GitLab und Bitbucket reviewen](/de/2026/04/claude-code-2-1-119-from-pr-gitlab-bitbucket/)
- [Der Coding-Agent von GitHub Copilot auf dotnet/runtime: zehn Monate Daten](/de/2026/03/copilot-coding-agent-dotnet-runtime-ten-months-data/)

## Quellen

- [Claude Code GitHub Actions Doku](https://code.claude.com/docs/en/github-actions)
- [Claude Code Code Review (Forschungsvorschau) Doku](https://code.claude.com/docs/en/code-review)
- [`anthropics/claude-code-action` auf GitHub](https://github.com/anthropics/claude-code-action)
- [`pr-review-comprehensive.yml`-Beispiel](https://github.com/anthropics/claude-code-action/blob/main/examples/pr-review-comprehensive.yml)
- [`pr-review-filtered-paths.yml`-Beispiel](https://github.com/anthropics/claude-code-action/blob/main/examples/pr-review-filtered-paths.yml)
