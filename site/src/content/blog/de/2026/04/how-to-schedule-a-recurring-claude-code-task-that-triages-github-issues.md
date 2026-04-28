---
title: "Eine wiederkehrende Claude-Code-Aufgabe planen, die GitHub-Issues triagiert"
description: "Drei Wege, um Claude Code 2026 unbeaufsichtigt auf einen Zeitplan zu setzen, der GitHub-Issues triagiert: Cloud-Routines (das neue /schedule), claude-code-action v1 mit cron + issues.opened und das auf eine Sitzung beschränkte /loop. Inklusive eines lauffähigen Routine-Prompts, eines vollständigen GitHub-Actions-YAML, Jitter- und Identitätsfallen sowie einer Entscheidungshilfe, wann man was wählt."
pubDate: 2026-04-27
tags:
  - "claude-code"
  - "ai-agents"
  - "github-actions"
  - "automation"
  - "anthropic-sdk"
lang: "de"
translationOf: "2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues"
translatedBy: "claude"
translationDate: 2026-04-29
---

Ein geplanter Triage-Durchgang über ein GitHub-Backlog ist eines der nützlichsten Dinge, die man einem Coding-Agenten geben kann, und gleichzeitig eines der einfachsten, das man falsch macht. Stand April 2026 gibt es drei verschiedene Primitive zum "Planen einer Claude-Code-Aufgabe", sie leben in unterschiedlichen Laufzeiten und haben sehr verschiedene Fehlerverhalten. Dieser Beitrag geht alle drei für denselben Job durch, "jeden Werktagmorgen um 8 Uhr alle neuen Issues in meinem Repo labeln und routen", und verwendet **Claude Code v2.1.x**, die GitHub Action **`anthropics/claude-code-action@v1`** und die **Routines Research Preview**, die Anthropic am [14. April 2026](https://claude.com/blog/introducing-routines-in-claude-code) ausgeliefert hat. Das Modell ist `claude-sonnet-4-6` für den Triage-Prompt und `claude-opus-4-7` für den Dedupe-Durchgang.

Die kurze Antwort: Verwenden Sie eine **Cloud-Routine** mit sowohl einem Schedule-Trigger als auch einem GitHub-`issues.opened`-Trigger, wenn Ihr Konto Claude Code im Web aktiviert hat. Greifen Sie auf einen **GitHub-Actions-Workflow mit schedule + workflow_dispatch + issues.opened** zurück, wenn Sie es auf Bedrock, Vertex oder eigenen Runnern brauchen. Verwenden Sie **`/loop`** nur für Ad-hoc-Polling, während eine Sitzung offen ist, niemals für unbeaufsichtigte Triage.

## Warum es die drei Optionen gibt und welche man wählt

Anthropic liefert bewusst drei verschiedene Scheduler aus, weil die Trade-offs real sind. Die offizielle [Scheduling-Dokumentation](https://code.claude.com/docs/en/scheduled-tasks) stellt sie auf einer Seite gegenüber:

| Eigenschaft                  | Routines (Cloud)         | GitHub Actions          | `/loop` (Sitzung)         |
| :--------------------------- | :----------------------- | :---------------------- | :------------------------ |
| Wo es läuft                  | Anthropic-Infrastruktur  | GitHub-gehosteter Runner | Ihr Terminal             |
| Übersteht ein geschlossenes Notebook | Ja               | Ja                      | Nein                      |
| Durch `issue.opened` ausgelöst | Ja (nativ)             | Ja (Workflow-Event)     | Nein                      |
| Lokaler Dateizugriff         | Nein (frischer Clone)    | Ja (Checkout)           | Ja (aktuelles cwd)        |
| Mindestintervall             | 1 Stunde                 | 5 Minuten (cron-Eigenheit) | 1 Minute               |
| Läuft automatisch ab         | Nein                     | Nein                    | 7 Tage                    |
| Berechtigungs-Prompts        | Keine (autonom)          | Keine (`claude_args`)   | Aus der Sitzung geerbt    |
| Plan-Anforderung             | Pro / Max / Team / Ent.  | Jeder Plan mit API-Key  | Lokale CLI                |

Für "jedes neue Issue triagieren und einen täglichen Sweep ausführen" ist die Cloud-Routine das richtige Primitiv. Sie hat einen nativen GitHub-Trigger, sodass Sie kein `actions/checkout` verdrahten müssen, der Prompt ist über die Web-UI ohne PR editierbar, und die Läufe verbrauchen keine Ihrer GitHub-Actions-Minuten. Der einzige Grund, sie zu überspringen, ist, wenn Ihre Organisation Claude über AWS Bedrock oder Google Vertex AI fährt; dann sind Cloud-Routines noch nicht verfügbar und Sie greifen auf die Action zurück.

## Die Triage-Routine, von Anfang bis Ende

Eine Routine ist "eine gespeicherte Claude-Code-Konfiguration: ein Prompt, ein oder mehrere Repositories und ein Satz Connectors, einmal verpackt und automatisch ausgeführt". Jeder Lauf ist eine autonome Cloud-Sitzung von Claude Code ohne Berechtigungs-Prompts, die Ihr Repo aus dem Default-Branch klont und Code-Änderungen standardmäßig in einen mit `claude/` präfixierten Branch schreibt.

Erstellen Sie eine aus jeder Claude-Code-Sitzung heraus:

```text
# Claude Code 2.1.x
/schedule weekdays at 8am triage new GitHub issues in marius-bughiu/start-debugging
```

`/schedule` führt Sie durch dasselbe Formular, das die [Web-UI unter claude.ai/code/routines](https://claude.ai/code/routines) zeigt: Name, Prompt, Repositories, Umgebung, Connectors und Trigger. Alles, was Sie in der CLI setzen, ist in der Web-UI editierbar, und dieselbe Routine erscheint sofort in Desktop, Web und CLI. Eine wichtige Einschränkung: `/schedule` heftet nur **Schedule**-Trigger an. Um den `issues.opened`-Trigger anzubringen, der Triage nahezu sofort macht, bearbeiten Sie die Routine nach der Erstellung in der Web-UI.

### Der Prompt

Eine Routine läuft ohne Mensch im Loop, daher muss der Prompt selbsterklärend sein. Die Beispielformulierung des Anthropic-Teams aus der [Routines-Doku](https://code.claude.com/docs/en/web-scheduled-tasks) lautet "wendet Labels an, weist Owner basierend auf dem referenzierten Codebereich zu und postet eine Zusammenfassung in Slack, sodass das Team mit einer aufgeräumten Queue in den Tag startet". Konkret:

```markdown
# Routine prompt: daily-issue-triage
# Model: claude-sonnet-4-6
# Repos: marius-bughiu/start-debugging

You are the issue triage bot for this repository. Every run, do the following.

1. List every issue opened or updated since the last successful run of this
   routine, using `gh issue list --search "updated:>=YYYY-MM-DD"` with the
   timestamp of the previous run from the routine's session history. If you
   cannot find a previous run, scope to the last 24 hours.

2. For each issue, classify it as exactly one of: bug, feature, docs,
   question, support, spam. Apply that label with `gh issue edit`.

3. Assess priority as one of: p0, p1, p2, p3. Apply that label too.
   p0 only when the issue describes a production-affecting regression
   with a reproducer.

4. Look up the touched code area. Use `gh search code --repo` and `rg`
   against the cloned working copy to find the most likely owner via
   the `CODEOWNERS` file. Assign that user. If there is no CODEOWNERS
   match, leave it unassigned and apply the `needs-triage` label.

5. Run a duplicate check. Use `gh issue list --search "<title keywords>
   in:title is:open"` to find similar open issues. If you find one with
   high confidence, post a comment on the new issue: "This looks like
   a duplicate of #N. Closing in favor of that thread; please reopen
   if I got it wrong." and then `gh issue close`.

6. Post a single Slack message to #engineering-triage via the connector
   summarizing what you did: counts per label, p0 issues by number, and
   any issue that you could not classify with confidence above 0.7.

Do not push any commits. Do not modify code. The only writes this routine
performs are GitHub label/assign/comment/close calls and one Slack message.
```

Zwei nicht offensichtliche Details, die festzuschrauben sind:

- **Der "Zeitstempel des vorherigen Laufs"-Trick.** Routines sind zustandslos zwischen Läufen. Jede Sitzung ist ein frischer Clone. Damit dasselbe Issue nicht zweimal gelabelt wird, muss der Prompt den Cutoff aus etwas Dauerhaftem ableiten. Entweder (a) verwenden Sie die GitHub-Identität der Routine, um ein Label `triaged-YYYY-MM-DD` zu setzen, und überspringen alles mit diesem Label, oder (b) lesen Sie den Zeitstempel aus der vorherigen Slack-Zusammenfassungs-Nachricht über den Connector. Beides ist zuverlässig. Das Modell zu bitten, "sich zu erinnern, wann du zuletzt gelaufen bist", ist es nicht.
- **Die Regeln des autonomen Modus.** Routines laufen ohne Berechtigungs-Prompts. Die Sitzung kann Shell-Befehle ausführen, jedes Tool aus jedem eingebundenen Connector nutzen und `gh` aufrufen. Behandeln Sie den Prompt wie die Policy eines Service-Accounts: Schreiben Sie genau auf, welche Schreiboperationen erlaubt sind.

### Die Trigger

Hängen Sie im Bearbeitungsformular der Routine zwei Trigger an:

1. **Schedule, werktags um 08:00.** Zeiten sind in Ihrer lokalen Zone und werden serverseitig in UTC umgerechnet, sodass ein US-Pacific-Schedule und ein CET-Schedule zur selben Wanduhrzeit feuern, egal wo die Cloud-Sitzung landet. Routines fügen einen deterministischen Stagger von bis zu wenigen Minuten pro Konto hinzu, also setzen Sie den Schedule nicht auf `0 8`, wenn das genaue Timing zählt, sondern auf `:03` oder `:07`.
2. **GitHub-Event, `issues.opened`.** Damit feuert die Routine binnen Sekunden nach jedem neuen Issue, zusätzlich zum 8-Uhr-Sweep. Die beiden sind nicht redundant: Der Schedule-Trigger fängt alles ab, was landet, während die GitHub-App pausiert oder hinter dem Konto-Stundenlimit ist, und der Event-Trigger verhindert, dass frische Issues einen Werktag lang kalt bleiben.

Damit der `issues.opened`-Trigger angeheftet werden kann, muss die [Claude GitHub App](https://github.com/apps/claude) am Repository installiert sein. `/web-setup` aus der CLI gewährt nur Clone-Zugriff und aktiviert keine Webhook-Zustellung, das Installieren der App über die Web-UI ist also Pflicht.

### Der eigene Cron-Ausdruck

Die Schedule-Presets sind stündlich, täglich, werktags und wöchentlich. Für alles andere wählen Sie den nächstgelegenen Preset im Formular und gehen dann in die CLI:

```text
/schedule update
```

Gehen Sie die Eingabeaufforderungen bis zum Schedule-Abschnitt durch und geben Sie einen eigenen 5-Felder-Cron-Ausdruck ein. Die einzige harte Regel ist, dass das **Mindestintervall eine Stunde** beträgt; ein Ausdruck wie `*/15 * * * *` wird beim Speichern abgelehnt. Wenn Sie wirklich eine engere Kadenz brauchen, ist das ein Signal, dass Sie den GitHub-Actions-Pfad oder den Event-Trigger wollen, nicht den Schedule-Trigger.

## Der GitHub-Actions-Fallback

Wenn Ihr Team auf Bedrock oder Vertex ist oder Sie einfach den Audit-Trail eines Actions-Run-Logs bevorzugen, läuft derselbe Job als Workflow mit `claude-code-action@v1`. Die Action ging am 26. August 2025 GA, und die v1-Oberfläche ist auf zwei Eingaben vereinheitlicht: einen `prompt` und einen String `claude_args`, der jede Flag direkt an die Claude-Code-CLI durchreicht. Die vollständige Upgrade-Tabelle gegenüber der Beta-Oberfläche finden Sie in der [GitHub-Actions-Doku](https://code.claude.com/docs/en/github-actions#breaking-changes-reference).

```yaml
# .github/workflows/issue-triage.yml
# claude-code-action v1, claude-sonnet-4-6, schedule + issues.opened + manual
name: Issue triage

on:
  schedule:
    - cron: "3 8 * * 1-5"  # weekdays 08:03 UTC, off the :00 boundary
  issues:
    types: [opened]
  workflow_dispatch:        # manual run from the Actions tab

permissions:
  contents: read
  issues: write
  pull-requests: read
  id-token: write

jobs:
  triage:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4

      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          prompt: |
            REPO: ${{ github.repository }}
            EVENT: ${{ github.event_name }}
            ISSUE: ${{ github.event.issue.number }}

            On a schedule run, list open issues updated in the last 24 hours
            and triage each one. On an `issues.opened` event, triage only
            the single issue ${{ github.event.issue.number }}.

            For each issue:
            1. Classify as bug / feature / docs / question / support / spam.
            2. Assess priority p0 / p1 / p2 / p3.
            3. Apply both labels with `gh issue edit`.
            4. Resolve the touched area via CODEOWNERS and assign the owner,
               or apply `needs-triage` if no match.
            5. Search for duplicates by title keywords. Comment and close
               only if confidence is high.

            Do not edit code. Do not push. Only GitHub label / assign /
            comment / close calls are allowed.
          claude_args: |
            --model claude-sonnet-4-6
            --max-turns 12
            --allowedTools "Bash(gh:*),Read,Grep"
```

Drei Dinge, die dieser Workflow richtig macht und die ein handgerollter Cron nicht hinkriegt. **`workflow_dispatch`** neben `schedule` setzt einen "Run workflow"-Button in den Actions-Tab, sodass Sie testen können, ohne auf 8 Uhr zu warten. **`--allowedTools "Bash(gh:*),Read,Grep"`** verwendet dasselbe Gating wie die lokale CLI; ohne sie hätte die Action zusätzlich `Edit`- und `Write`-Zugriff. **Die Minute `:03`** umgeht die breite, nicht deterministische Verzögerung, die GitHub Actions zu Free-Tier-Cron-Triggern in Stoßzeiten hinzufügt. Das ist im Wesentlichen das [Issue-Triage-Beispiel](https://github.com/anthropics/claude-code-action/blob/main/docs/solutions.md) aus dem Solutions-Guide der Action, mit einem Schedule-Trigger und einer engeren Tool-Allowlist.

## Wann `/loop` das richtige Primitiv ist

`/loop` ist die dritte Option und diejenige, zu der man bei Triage-Arbeit am **wenigsten** greifen sollte. Die [Scheduled-Tasks-Doku](https://code.claude.com/docs/en/scheduled-tasks) zählt die Einschränkungen auf:

- Tasks feuern nur, während Claude Code läuft und idle ist. Das Schließen des Terminals stoppt sie.
- Wiederkehrende Tasks laufen 7 Tage nach Erstellung ab.
- Eine Sitzung kann gleichzeitig bis zu 50 geplante Tasks halten.
- Cron wird mit Minuten-Granularität honoriert, mit bis zu 10% Jitter, gedeckelt bei 15 Minuten.

Der richtige Einsatz für `/loop` ist, eine Triage-Routine zu babysitten, die Sie noch tunen, nicht die Triage selbst zu betreiben. In einer offenen Sitzung, die auf das Repo zeigt:

```text
/loop 30m check the last 5 runs of the daily-issue-triage routine on
claude.ai/code/routines and tell me which ones produced label edits
that look wrong. Skip silently if nothing has changed.
```

Claude konvertiert `30m` in einen Cron-Ausdruck, plant den Prompt unter einer generierten 8-stelligen ID und feuert ihn zwischen Ihren Turns wieder, bis Sie `Esc` drücken oder sieben Tage vergehen. Das ist tatsächlich nützlich für eine "läuft die Routine aus dem Ruder?"-Feedbackschleife, während ein Mensch an der Tastatur bleibt. Es ist die falsche Form für "ewig laufen, unbeaufsichtigt".

## Fallstricke, die man vor dem ersten Lauf kennen sollte

Ein paar Dinge beißen Sie beim ersten geplanten Lauf, wenn Sie nicht vorbeugen.

**Identität.** Routines gehören zu Ihrem individuellen claude.ai-Konto, und alles, was die Routine über Ihre verbundene GitHub-Identität tut, erscheint als Sie. Für ein Open-Source-Repo installieren Sie die Routine unter einem dedizierten Bot-Konto, oder nutzen Sie den GitHub-Actions-Pfad mit einer separaten Bot-Installation der [Claude GitHub App](https://github.com/anthropics/claude-code-action).

**Tägliches Run-Limit.** Routines haben ein tägliches Limit pro Plan (Pro 5, Max 15, Team und Enterprise 25). Jedes `issues.opened`-Event ist ein Lauf, also schlägt ein Repo, das pro Tag 30 Issues bekommt, vor dem Mittag das Limit, sofern Sie nicht zusätzliche Nutzung im Billing aktivieren. Die nur-Schedule-Routine und der GitHub-Actions-Pfad umgehen das beide; letzterer rechnet gegen API-Tokens ab.

**Branch-Push-Sicherheit.** Eine Routine kann standardmäßig nur in mit `claude/` präfixierte Branches pushen. Der Triage-Prompt oben pusht überhaupt nicht, aber ihn auszuweiten, um einen Fix-PR zu öffnen, bedeutet entweder das Präfix zu akzeptieren oder pro Repo **Allow unrestricted branch pushes** zu aktivieren. Diesen Schalter nicht gedankenlos umlegen.

**Der Beta-Header `experimental-cc-routine-2026-04-01`.** Der `/fire`-Endpunkt, der den API-Trigger trägt, läuft heute unter diesem Header. Anthropic hält die zwei zuletzt datierten Versionen am Laufen, wenn sie brechen, also bauen Sie den Header in eine Konstante und rotieren Sie zu Versionswechseln, nicht in jedem Webhook.

**Stagger und kein Catch-up.** Beide Laufzeiten fügen einen deterministischen Offset hinzu (bis zu 10% der Periode bei Routines, bei Free-Tier-Actions in Stoßzeiten viel breiter), und keine spielt verpasste Feuer nach. Die Kombination `schedule + issues.opened` handhabt die Catch-up-Lücke besser als Schedule allein, weil der Event-Trigger die tote Zone abdeckt.

## Verwandte Lektüre

- Das vollständige Claude-Code-Release, das `--from-pr` für GitLab und Bitbucket geöffnet hat, passt gut zu Cloud-Routines: siehe [Claude Code 2.1.119: PRs aus GitLab, Bitbucket und GHE](/2026/04/claude-code-2-1-119-from-pr-gitlab-bitbucket/).
- Wenn die Routine während der Triage aus einem `.NET`-Geschäftssystem lesen soll, exponieren Sie es zuerst über MCP. Der Walkthrough ist in [Wie man einen eigenen MCP-Server in C# auf .NET 11 baut](/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/).
- Für die GitHub-Copilot-förmige Entsprechung gibt es die Agent-Skills-Variante in [Visual Studio 2026 Copilot Agent Skills](/de/2026/04/visual-studio-2026-copilot-agent-skills/).
- Für C#-Entwicklerinnen und -Entwickler, die Agent-Runner auf der Microsoft-Seite statt auf der Anthropic-Seite bauen, ist [Microsoft Agent Framework 1.0](/de/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) der produktionsreife Einstieg.
- Und zur Bring-Your-Own-Key-Ökonomie, falls Sie lieber Token gegen ein anderes Modell zahlen, siehe [GitHub Copilot in VS Code mit BYOK Anthropic, Ollama und Foundry Local](/de/2026/04/github-copilot-vs-code-byok-anthropic-ollama-foundry-local/).

Routines sind noch in der Research Preview, daher werden sich die genaue UI und der `/fire`-Beta-Header bewegen. Das Modell, auf das das alles zielt, ist jedoch stabil: ein selbstständiger Prompt, eingegrenzter Tool-Zugriff, deterministische Trigger und ein Audit-Trail pro Lauf. Das ist der Teil, den man sorgfältig entwirft. Die Laufzeit ist der Teil, den man tauschen kann.
