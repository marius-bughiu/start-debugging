---
title: "Wie man eine CLAUDE.md schreibt, die das Modellverhalten tatsächlich verändert"
description: "Ein Spielbuch für 2026 für CLAUDE.md-Dateien, denen Claude Code wirklich folgt: das Ziel von 200 Zeilen, wann pfadgebundene Regeln in .claude/rules/ sinnvoll sind, die @import-Hierarchie und das Maximum von 5 Sprüngen, die Lücke zwischen Benutzernachricht und System-Prompt, die Trennlinie zwischen CLAUDE.md und automatischer Memory, und wann man aufgibt und stattdessen einen Hook schreibt. Verankert in Claude Code 2.1.x und gegen die offizielle Memory-Dokumentation verifiziert."
pubDate: 2026-04-28
tags:
  - "claude-code"
  - "ai-agents"
  - "agent-skills"
  - "developer-workflow"
lang: "de"
translationOf: "2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour"
translatedBy: "claude"
translationDate: 2026-04-29
---

Eine CLAUDE.md, die "nicht funktioniert", bedeutet fast immer eines von drei Dingen: Sie ist zu lang und wichtige Regeln gehen unter, sie ist zu vage, um überprüfbar zu sein, oder die Anweisung gehört in einen Hook, weil CLAUDE.md per Design beratend ist. Ab **Claude Code 2.1.x** wird die Datei nach dem System-Prompt als Benutzernachricht in den Kontext geladen und nicht in den System-Prompt selbst. Das ist ein nicht offensichtliches Detail, das einen Großteil der Frustration nach dem Muster "Claude ignoriert meine Regeln" auf `r/ClaudeAI` und `r/cursor` in diesem Monat erklärt. Das Modellverhalten ändert sich tatsächlich als Reaktion auf eine gute CLAUDE.md, aber nur, wenn Sie sie so behandeln, wie Anthropics eigene [Memory-Dokumentation](https://code.claude.com/docs/en/memory) es beschreibt: als Kontext, nicht als Konfiguration.

Die Kurzfassung: unter 200 Zeilen anvisieren, spezifische und überprüfbare Anweisungen schreiben, themenspezifische Regeln in `.claude/rules/` mit `paths:`-Frontmatter auslagern, wiederverwendbare Workflows in Skills auslagern, und Hooks für alles verwenden, was zwingend laufen muss. Verwenden Sie `@imports` zur Strukturierung, aber wissen Sie, dass sie keine Token sparen. Und wenn Sie denselben Fehler zweimal korrigieren, vergraben Sie ihn nicht tiefer in der CLAUDE.md, er verliert dort bereits den Kampf gegen Ihre anderen Regeln.

Dieser Beitrag setzt Claude Code 2.1.59+ voraus (die Version, die die automatische Memory mitbringt) und `claude-sonnet-4-6` oder `claude-opus-4-7` als zugrunde liegendes Modell. Die Muster funktionieren auf beiden gleich, aber Sonnet reagiert empfindlicher auf aufgeblähte CLAUDE.md-Dateien, weil die Regelbefolgung schneller nachlässt, sobald sich der Kontext füllt.

## Warum "Ich habe es ihm gesagt" nicht reicht

Der einzige nützlichste Satz in der offiziellen [Memory-Dokumentation](https://code.claude.com/docs/en/memory#claude-isn-t-following-my-claude-md) ist dieser: "Der Inhalt von CLAUDE.md wird nach dem System-Prompt als Benutzernachricht geliefert, nicht als Teil des System-Prompts selbst. Claude liest sie und versucht, ihr zu folgen, aber strikte Befolgung ist nicht garantiert." Das erklärt jeden Thread mit "Ich habe wörtlich `NEVER use console.log` geschrieben und es ist trotzdem passiert". Das Modell sieht Ihre CLAUDE.md genauso wie den Rest Ihres Prompts: als Anweisungen zum Abwägen, nicht als nicht überschreibbare Direktive.

Drei konkrete Konsequenzen folgen daraus:

1. **Mehr Text reduziert die Befolgung.** Je länger die Datei, desto stärker verwässert jede einzelne Regel. Die offizielle Dokumentation empfiehlt: "Anvisieren Sie unter 200 Zeilen pro CLAUDE.md-Datei. Längere Dateien verbrauchen mehr Kontext und reduzieren die Befolgung."
2. **Vage Regeln werden weichgespült.** "Formatieren Sie den Code ordentlich" interpretiert das Modell genauso wie Sie: irgendetwas Vernünftiges tun. "Verwenden Sie 2-Leerzeichen-Einrückung, kein abschließendes Semikolon außer nach Imports" ist eine überprüfbare Anweisung, der das Modell wirklich folgen kann.
3. **Widersprüchliche Regeln werden willkürlich aufgelöst.** Wenn Ihre Wurzel-CLAUDE.md sagt "schreibe immer Tests" und eine verschachtelte in einem Unterordner sagt "überspringe Tests bei Prototypen", wählt das Modell eine, ohne Ihnen zu sagen welche.

Wenn Sie wirklich eine nicht überschreibbare Direktive brauchen, haben Sie zwei Optionen. Die erste ist `--append-system-prompt`, das Text in den System-Prompt selbst einfügt. Laut [CLI-Referenz](https://code.claude.com/docs/en/cli-reference#system-prompt-flags) muss sie bei jeder Invocation übergeben werden, was für Skripte und CI in Ordnung ist, aber für interaktive Nutzung unpraktisch. Die zweite und fast immer bessere Option ist ein Hook, zu dem wir noch kommen.

## Was in CLAUDE.md gehört, was nicht

Anthropics eigener [Best-Practices-Leitfaden](https://code.claude.com/docs/en/best-practices#write-an-effective-claude-md) liefert eine knappe Include-/Exclude-Tabelle, die ich in jedes Projekt kopiere, das ich starte. Umformuliert und verdichtet:

**Aufnehmen**: Bash-Befehle, die Claude nicht aus Ihrer `package.json` oder `Cargo.toml` erraten kann, Code-Style-Regeln, die von den Standardvorgaben der Sprache abweichen, der Test Runner, den Sie tatsächlich verwenden möchten, Branch- und PR-Konventionen, architektonische Entscheidungen, die nicht offensichtlich aus dem Code hervorgehen, und Stolperfallen wie "der Postgres-Test-Container braucht `POSTGRES_HOST_AUTH_METHOD=trust`, sonst hängen Migrationen."

**Ausschließen**: alles, was Claude aus `tsconfig.json` ablesen kann, Framework-Konventionen, die jeder Entwickler kennt, Datei-für-Datei-Beschreibungen der Codebasis, die Geschichte, wie der Code zu seinem aktuellen Zustand gekommen ist, und selbstverständliche Praktiken wie "schreibe sauberen Code". Das Best-Practices-Dokument ist deutlich: "Aufgeblähte CLAUDE.md-Dateien führen dazu, dass Claude Ihre tatsächlichen Anweisungen ignoriert." Jede Zeile, die Sie hinzufügen, senkt das Signal-Rausch-Verhältnis für den Rest.

Eine CLAUDE.md, die diesen Filter für ein Next.js + Postgres-Backend überstanden hat, sieht so aus:

```markdown
# Project: invoice-api
# Claude Code 2.1.x, Node 22, Next.js 15

## Build and test
- Use `pnpm`, never `npm` or `yarn`. The lockfile is committed.
- Run `pnpm test --filter @app/api` for backend tests, NOT the full workspace.
- Migrations: `pnpm db:migrate` only inside the `apps/api` workspace.

## Code style
- Use ESM (`import`/`export`). Default export is forbidden except in
  Next.js page/route files where the framework requires it.
- Zod schemas for every external input. No `any`, no `as unknown as T`.

## Architecture
- Database access goes through `apps/api/src/db/repositories/`.
  Do not call `db.query` from route handlers.
- All money is `bigint` cents. Never `number`, never decimals.

## Workflow
- After a code change, run `pnpm typecheck` and `pnpm test --filter @app/api`.
- Commit messages: imperative, no scope prefix, max 72 chars on the title.
```

Das sind 17 Zeilen und sie adressieren jede wiederkehrende Korrektur, die dieses Team in seiner PR-Vorlage dokumentiert hatte. Beachten Sie, was nicht da steht: kein "schreibe immer sauberen Code", kein "achte auf Sicherheit", kein "verwende TypeScript Strict Mode" (steht in `tsconfig.json`, das Modell sieht es). Jede Zeile beantwortet "würde das Entfernen einen messbaren Fehler verursachen?" mit Ja.

## Die 200-Zeilen-Grenze und `.claude/rules/`

Sobald Sie 200 Zeilen überschreiten, empfiehlt die offizielle Memory-Dokumentation, themenspezifische Anweisungen in `.claude/rules/` aufzuteilen, mit YAML-Frontmatter, das jede Datei auf ein Glob beschränkt:

```markdown
---
paths:
  - "src/api/**/*.ts"
  - "src/api/**/*.tsx"
---

# API endpoint conventions

- Every route under `src/api/` exports a `POST`, `GET`, `PUT`, or `DELETE`
  function. Never a default export.
- Validate the body with the matching Zod schema in `src/api/schemas/`
  before doing anything else. If no schema exists, write one first.
- Return errors with `Response.json({ error }, { status })`. Do not throw.
```

Eine Regel mit `paths:` wird nur dann in den Kontext geladen, wenn Claude eine Datei liest, die einem der Globs entspricht. Die Kosten für zehn Regeldateien zu je 100 Zeilen sind viel geringer als für eine CLAUDE.md mit 1000 Zeilen, weil neun davon für eine bestimmte Aufgabe nicht im Kontext sind. Regeln ohne `paths:` werden in jeder Sitzung mit derselben Priorität wie `.claude/CLAUDE.md` geladen, packen Sie sie also nicht aus Gewohnheit dorthin, es sei denn, sie gelten wirklich für jede Datei.

Hier stirbt auch der "Scope Creep in CLAUDE.md". Wenn ein Teamkollege vorschlägt, zwölf Zeilen über ein obskures Migrationswerkzeug einzufügen, lautet die Antwort "das gehört in `.claude/rules/migrations.md` mit `paths: ['db/migrations/**/*.sql']`", nicht "wir kürzen es später". Wir kürzen nie später.

## Imports, Hierarchie und das 5-Sprung-Limit

Die `@path/to/file`-Import-Syntax ist zur Strukturierung gedacht, nicht zur Token-Ersparnis. Aus der [Dokumentation](https://code.claude.com/docs/en/memory#import-additional-files): "Importierte Dateien werden beim Start zusammen mit der referenzierenden CLAUDE.md expandiert und in den Kontext geladen." Wenn Sie eine 600-zeilige CLAUDE.md in eine 50-zeilige Wurzel und eine `@docs/conventions.md` mit 550 Zeilen aufteilen, sieht das Modell weiterhin 600 Zeilen.

Imports sind für drei spezifische Zwecke nützlich:

1. **Wiederverwenden derselben Anweisungen über zwei Repos hinweg**, ohne Copy-Paste. Symlinken oder importieren Sie eine gemeinsam genutzte Datei aus `~/shared/team-conventions.md`.
2. **Pro-Entwickler-Überschreibungen**, die nicht eingecheckt werden sollten. Mit `@~/.claude/my-project-instructions.md` können Sie persönliche Vorlieben in Ihrem Home-Verzeichnis halten, während alle die Team-CLAUDE.md aus Git bekommen.
3. **Brücke zu `AGENTS.md`**, wenn Ihr Repo bereits eine für andere Coding-Agenten hat. Die Dokumentation empfiehlt explizit `@AGENTS.md` gefolgt von Claude-spezifischen Überschreibungen:

```markdown
@AGENTS.md

## Claude Code

Use plan mode for changes under `src/billing/`.
```

Imports werden rekursiv bis zu **fünf Sprünge tief** aufgelöst. Darüber hinaus wird der Import stillschweigend verworfen. Wenn Sie eine CLAUDE.md haben, die eine Datei importiert, die eine Datei importiert, die eine Datei importiert, viermal hintereinander, haben Sie etwas Brüchiges gebaut: flachen Sie es ab.

Die Hierarchie selbst ist additiv, nicht überschreibend. Projekt-CLAUDE.md, Benutzer-CLAUDE.md (`~/.claude/CLAUDE.md`) und jede CLAUDE.md, die vom Arbeitsverzeichnis aus den Verzeichnisbaum hinaufgeht, werden alle aneinandergehängt. `CLAUDE.local.md` (von Git ignoriert) wird auf derselben Ebene nach `CLAUDE.md` geladen, also gewinnen Ihre persönlichen Notizen im Konflikt. In einem Monorepo, in dem Sie keine CLAUDE.md-Dateien benachbarter Teams in Ihrem Kontext haben möchten, nimmt die [Einstellung `claudeMdExcludes`](https://code.claude.com/docs/en/memory#exclude-specific-claude-md-files) eine Liste von Glob-Mustern entgegen:

```json
{
  "claudeMdExcludes": [
    "**/monorepo/CLAUDE.md",
    "/home/marius/monorepo/other-team/.claude/rules/**"
  ]
}
```

Legen Sie das in `.claude/settings.local.json` ab, damit der Ausschluss Ihnen gehört und nicht dem Team.

## CLAUDE.md ist "Ihre Anforderungen", die automatische Memory ist "was Claude bemerkt hat"

Claude Code 2.1.59 hat die automatische Memory hinzugefügt: Notizen, die Claude basierend auf Ihren Korrekturen über sich selbst schreibt. Sie liegt in `~/.claude/projects/<project>/memory/MEMORY.md` und wird genauso geladen wie CLAUDE.md, mit dem Unterschied, dass nur die ersten 200 Zeilen oder 25KB der `MEMORY.md` beim Sitzungsstart eingezogen werden. Der Rest des Verzeichnisses wird auf Anfrage gelesen.

Die sauberste Art, über die Aufteilung nachzudenken:

- **CLAUDE.md** enthält Regeln, die Sie ab dem ersten Tag durchgesetzt haben möchten. "Führe `pnpm test --filter @app/api` aus, nicht die gesamte Suite." Sie haben sie geschrieben, sie eingecheckt, Ihr Team sieht sie.
- **Automatische Memory** enthält Muster, die Claude bemerkt hat. "Benutzer bevorzugt `vitest` gegenüber `jest` und hat mich korrigiert, als ich eine `jest.config.js` erzeugt habe." Claude hat sie geschrieben, sie ist pro Maschine, sie ist nicht in Git.

Daraus ergeben sich zwei praktische Regeln. Erstens: Duplizieren Sie keine Einträge der automatischen Memory "zur Sicherheit" in CLAUDE.md. Die automatische Memory wird ebenfalls in jeder Sitzung geladen. Zweitens: Wenn die automatische Memory ein Muster ansammelt, das das gesamte Team kennen sollte, befördern Sie es: öffnen Sie `MEMORY.md`, kopieren Sie den Eintrag in CLAUDE.md, und mit `/memory` können Sie das Original löschen. Die Beförderung ist der Moment, in dem aus "Claude hat das über mich beobachtet" "wir als Team haben das so entschieden" wird.

Mehr zur Aufteilung deckt der Beitrag über das [Planen wiederkehrender Claude-Code-Routinen](/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/) ab; er behandelt, was eine autonome Ausführung ohne Mensch im Loop überlebt, was ein nützlicher Drucktest dafür ist, ob Ihre CLAUDE.md tatsächlich in sich abgeschlossen ist.

## Auf Befolgung trimmen

Sobald die Datei kurz und spezifisch ist, können Sie ihr mit drei Techniken, auf die Dokumentation und Felderfahrungen zusammenlaufen, mehr Befolgung abringen:

1. **Setzen Sie Hervorhebungen sparsam ein.** Die offizielle Empfehlung lautet, "Anweisungen zu trimmen, indem man Hervorhebungen hinzufügt (z.B. `IMPORTANT` oder `YOU MUST`), um die Befolgung zu verbessern." Sparsam ist das operative Wort. Wenn alles `IMPORTANT` ist, ist nichts mehr wichtig. Reservieren Sie Hervorhebungen für die Regel, deren Verletzung tatsächlich einen Build sprengen oder einen Oncall-Mitarbeiter wachhalten würde.
2. **Beginnen Sie mit dem Verb, dann der Bedingung.** "Führe `pnpm typecheck` nach jeder Codeänderung in `src/` aus" wird zuverlässiger befolgt als "Typprüfung sollte regelmäßig durchgeführt werden." Ersteres ist eine Aktion; Zweiteres eine Stimmung.
3. **Verorten Sie die Regel beim Fehlerfall.** "Rufen Sie `db.query` nicht aus Route-Handlern auf; der Verbindungspool ist pro Anfrage und Route-Handler lecken. Verwenden Sie stattdessen `repositories/`." Der Fehlerfall ist das, was die Regel zwischen Sitzungen klebrig macht.

Wenn Sie denselben Fehler zweimal korrigieren und die Regel bereits in CLAUDE.md steht, ist es nicht richtig, eine weitere Regel hinzuzufügen. Richtig ist die Frage, warum die bestehende Regel nicht durchdringt. Meist ist es eines davon: die Datei ist zu lang, zwei Regeln widersprechen sich, oder die Anweisung gehört zur Sorte, die einen Hook braucht.

## Wann man CLAUDE.md aufgibt und einen Hook schreibt

CLAUDE.md ist beratend. Hooks sind deterministisch. Aus dem [Hooks-Leitfaden](https://code.claude.com/docs/en/hooks-guide) sind sie "Skripte, die automatisch an bestimmten Punkten in Claudes Workflow laufen" und "garantieren, dass die Aktion stattfindet". Wenn Ihre Regel in die Kategorie "muss ohne Ausnahme laufen" gehört, gehört sie nicht in CLAUDE.md.

Ein `PostToolUse`-Hook, der Prettier nach jeder Dateibearbeitung ausführt, ist zuverlässiger als eine CLAUDE.md-Zeile, die "führe nach Bearbeitungen immer Prettier aus" sagt. Dasselbe für "Schreibvorgänge in `migrations/` blockieren", was zu einem `PreToolUse`-Hook mit einem Verbots-Pattern wird. Dieselbe Logik macht die breitere Geschichte der [Visual Studio 2026 Agent Skills](/de/2026/04/visual-studio-2026-copilot-agent-skills/) in der Praxis tragfähig: die Skill ist die weiche Anweisung, der Hook ist die harte Schiene.

Das ist auch der richtige Moment, um über die Linie zwischen CLAUDE.md und Skills nachzudenken. Eine CLAUDE.md-Anweisung wird in jeder Sitzung geladen und gilt breit. Eine Skill in `.claude/skills/SKILL.md` wird auf Anfrage geladen, wenn das Modell entscheidet, dass die Aufgabe relevant ist, daher gehört tiefes Workflow-Wissen mit Seiteneffekten (etwa ein "fix-issue"-Workflow, der einen PR öffnet) dorthin. Dieselbe Logik gilt für Anweisungen, die riesig sind, aber nur für einen Teil Ihrer Codebasis relevant: die wollen eine pfadgebundene Regel, nicht CLAUDE.md.

## Diagnostizieren, was wirklich geladen ist

Wenn das Modell das Falsche tut, ist der erste Schritt, zu bestätigen, was es tatsächlich sieht. Führen Sie `/memory` in einer Claude-Code-Sitzung aus. Das listet jede CLAUDE.md, CLAUDE.local.md und Regeldatei, die aktuell geladen ist, mit Pfaden. Wenn die Datei, die Sie erwarten, nicht in der Liste ist, ist der Rest der Konversation irrelevant: Claude kann sie nicht sehen.

Für pfadgebundene Regeln und träge geladene CLAUDE.md-Dateien aus Unterverzeichnissen feuert der [`InstructionsLoaded`-Hook](https://code.claude.com/docs/en/hooks#instructionsloaded), sobald Claude Anweisungen einzieht. Hängen Sie ihn an einen Logger, um zu bestätigen, dass ein `paths:`-Glob tatsächlich gegriffen hat, oder um zu debuggen, warum eine verschachtelte CLAUDE.md nach `/compact` nie nachgeladen wird. Der Compaction-Fall ist eine bekannte scharfe Kante: die CLAUDE.md des Projektstamms wird nach `/compact` neu eingespielt, verschachtelte werden aber erst beim nächsten Dateizugriff in jenem Unterverzeichnis nachgeladen. Wenn Sie sich auf eine verschachtelte CLAUDE.md verlassen und Anweisungen mitten in der Sitzung verloren scheinen, ist das der Grund.

Die andere Diagnose, die wissenswert ist: HTML-Block-Kommentare (`<!-- like this -->`) werden vor der Injektion aus CLAUDE.md entfernt. Verwenden Sie sie für Notizen, die nur für Menschen gedacht sind (eine `<!-- last reviewed 2026-04 -->`-Zeile), ohne Token-Kosten zu zahlen.

## Verwandt

- [So planen Sie eine wiederkehrende Claude-Code-Aufgabe, die GitHub-Issues triagiert](/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/) deckt ab, was eine CLAUDE.md für autonome Läufe braucht.
- [Claude Code 2.1.119: Start aus einem PR mit GitLab und Bitbucket](/2026/04/claude-code-2-1-119-from-pr-gitlab-bitbucket/) für die verwandte Frage "wo wohnen meine Anweisungen in einer Cloud-Sitzung".
- [Visual Studio 2026 Copilot Agent Skills](/de/2026/04/visual-studio-2026-copilot-agent-skills/) ist das nächstliegende Pendant auf Microsoft-Seite: Skill-Dateien gegenüber persistentem Kontext.
- [Einen MCP-Server in TypeScript bauen](/de/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) für den Fall, dass die bessere Antwort als "mehr Regeln in CLAUDE.md" lautet "exponieren Sie das Werkzeug für den Agenten".

## Quellen

- Offiziell: [Wie Claude sich Ihr Projekt merkt](https://code.claude.com/docs/en/memory) (Claude-Code-Memory- und CLAUDE.md-Dokumentation).
- Offiziell: [Best Practices für Claude Code](https://code.claude.com/docs/en/best-practices#write-an-effective-claude-md).
- Offiziell: [Hooks-Referenz](https://code.claude.com/docs/en/hooks-guide) und [`InstructionsLoaded`-Hook](https://code.claude.com/docs/en/hooks#instructionsloaded).
- Felderfahrung: [Writing a good CLAUDE.md](https://www.humanlayer.dev/blog/writing-a-good-claude-md) (HumanLayer).
