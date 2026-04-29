---
title: "Prompt Caching in einer Anthropic-SDK-App ergänzen und die Trefferquote messen"
description: "Ergänzen Sie Prompt Caching in einer Python- oder TypeScript-App mit dem Anthropic SDK, platzieren Sie cache_control-Breakpoints korrekt und lesen Sie cache_read_input_tokens und cache_creation_input_tokens, um eine echte Trefferquote zu berechnen. Mit Preisrechnung für Claude Sonnet 4.6 und Opus 4.7."
pubDate: 2026-04-29
tags:
  - "llm"
  - "ai-agents"
  - "anthropic-sdk"
  - "prompt-caching"
  - "claude-code"
lang: "de"
translationOf: "2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate"
translatedBy: "claude"
translationDate: 2026-04-29
---

Wenn Ihre Anthropic-SDK-App in jeder Runde denselben langen System-Prompt oder denselben Tool-Katalog sendet, zahlen Sie den vollen Input-Preis für Tokens, die das Modell schon vor dreißig Sekunden gesehen hat. Prompt Caching senkt diese wiederholten Tokens auf **10 Prozent des Basis-Input-Preises** im Tausch gegen einen kleinen einmaligen Schreibaufschlag. In einer Multi-Turn-Agent-Schleife mit einem 10k-Token-System-Prompt bedeutet das eine 5- bis 10-fache Kostensenkung beim Input und etwa 85ms weniger Latenz für das gecachte Präfix. Der Haken: Sie müssen die cache_control-Breakpoints an den richtigen Stellen platzieren und die Trefferquote mit dem Usage-Objekt des SDK verifizieren, denn ein falsch platzierter Breakpoint degradiert stillschweigend zu einem Aufruf zum vollen Preis.

Diese Anleitung führt durch das Hinzufügen von Caching zu einer Python- oder TypeScript-App mit dem Anthropic SDK auf der aktuellen API (Claude Opus 4.7, Sonnet 4.6, Haiku 4.5) und anschließend durch das Messen der tatsächlichen Cache-Trefferquote mit einem kleinen Wrapper. Der Code wurde gegen `anthropic` 0.42 (Python) und `@anthropic-ai/sdk` 0.30 (Node) verifiziert, beide Anfang 2026 veröffentlicht.

## Warum Caching für Agent-Schleifen nicht optional ist

Ein Coding-Agent, der über ein Repository iteriert, sendet typischerweise:

1. Einen System-Prompt von 5k bis 30k Tokens (die Anweisungen des Agenten, Tool-Beschreibungen, Datei-Konventionen).
2. Eine wachsende Nachrichtenhistorie (die Anfrage des Nutzers plus vorherige Tool-Aufrufe und Tool-Ergebnisse).
3. Eine neue Nutzer-Runde oder ein Tool-Ergebnis, das die nächste Antwort auslöst.

Ohne Caching wird in jeder Runde das gesamte Präfix neu kodiert. Auf Claude Sonnet 4.6 bei $3/MTok Input kostet ein 8k-Token-Präfix $0,024 pro Runde. Eine Sitzung mit 50 Runden sind $1,20 allein an erneut abgerechnetem Präfix, zusätzlich zur eigentlichen Arbeit. Mit Caching kostet dasselbe Präfix nach der ersten Schreibung $0,0024 pro gecachter Runde. Dieselbe Antwort, zehn Prozent der Rechnung.

Der Mechanismus ist in der [offiziellen Prompt-Caching-Dokumentation](https://docs.claude.com/en/docs/build-with-claude/prompt-caching) beschrieben. Sie markieren einen Content-Block mit `cache_control: {"type": "ephemeral"}`, und die API behandelt alles **vor und einschließlich** dieses Blocks als Cache-Schlüssel. Wenn beim nächsten Request das Präfix Byte für Byte übereinstimmt, liest das Modell aus dem Cache, statt neu zu kodieren.

Was "Byte für Byte" wirklich bedeutet, ist die Quelle jedes "warum cached das nicht"-Threads in den Anthropic-Foren. Dazu kommen wir gleich.

## Versionen, Modell-IDs und die Falle des Token-Minimums

Caching greift nur, wenn das gecachte Präfix ein modellspezifisches Minimum überschreitet:

- **Claude Opus 4.7 (`claude-opus-4-7`)**: 4.096 Tokens Minimum.
- **Claude Sonnet 4.6 (`claude-sonnet-4-6`)**: 2.048 Tokens Minimum.
- **Claude Haiku 4.5 (`claude-haiku-4-5`)**: 4.096 Tokens Minimum.
- **Ältere Sonnet 4.5, Opus 4.1, Sonnet 3.7**: 1.024 Tokens Minimum.

Liegt Ihr Präfix unter dem Schwellwert, ist der Request weiterhin erfolgreich, aber `cache_creation_input_tokens` kommt als 0 zurück, und Sie zahlen stillschweigend den vollen Input-Preis. Das ist der häufigste Grund, warum Entwickler berichten, "Caching macht nichts". Prüfen Sie immer zuerst den Schwellwert für Ihr Zielmodell.

Das Python-SDK `anthropic` hat in 0.40 native `cache_control`-Unterstützung erhalten und in 0.42 die Typisierung für die Usage-Aufschlüsselung verschärft. Das Node-SDK hat es seit `@anthropic-ai/sdk` 0.27. Es ist kein Beta-Header mehr erforderlich, weder für die 5-Minuten- noch für die 1-Stunden-TTL: setzen Sie einfach `ttl` innerhalb von `cache_control`.

## Ein minimales Python-Beispiel mit cache_control

Das untenstehende Muster cached einen langen System-Prompt. Es ist der einfachste und häufigste Anwendungsfall.

```python
# Python 3.11, anthropic 0.42
import anthropic

client = anthropic.Anthropic()

LONG_SYSTEM_PROMPT = open("prompts/system.md").read()  # ~8k tokens

def ask(user_message: str) -> anthropic.types.Message:
    return client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=1024,
        system=[
            {
                "type": "text",
                "text": LONG_SYSTEM_PROMPT,
                "cache_control": {"type": "ephemeral"},
            }
        ],
        messages=[{"role": "user", "content": user_message}],
    )

first = ask("List the public methods on OrderService.")
second = ask("Now list the private ones.")

print(first.usage)
print(second.usage)
```

Der Parameter `system` muss ein **Array von Content-Blöcken** sein, wenn Sie `cache_control` anhängen. Eine einfache Zeichenkette zu übergeben (die Bequemlichkeitsform) erlaubt kein Caching: das SDK hat keinen Platz, um das Cache-Flag zu setzen. Darüber stolpert jeder beim ersten Mal.

Der erste Aufruf schreibt das Präfix in den Cache. Der zweite Aufruf liest es. Die Usage-Objekte machen das sichtbar:

```
# first.usage
{ "cache_creation_input_tokens": 8137, "cache_read_input_tokens": 0,  "input_tokens": 18,  "output_tokens": 124 }
# second.usage
{ "cache_creation_input_tokens": 0,    "cache_read_input_tokens": 8137, "input_tokens": 22, "output_tokens": 156 }
```

Die Felder, die Sie interessieren:

- `cache_creation_input_tokens`: Tokens, die in diesem Request in den Cache geschrieben wurden, abgerechnet zu 1,25x Basis für die 5-Minuten-TTL oder 2,0x für die 1-Stunden-TTL.
- `cache_read_input_tokens`: Aus dem Cache gelesene Tokens, abgerechnet zu 0,10x Basis.
- `input_tokens`: Tokens **nach dem letzten Cache-Breakpoint**, die nicht für Caching geeignet waren. Das ist der Nachrichten-Schwanz, den Sie ständig ändern.

## Dasselbe Beispiel in TypeScript

Das Node-SDK hat dieselbe Form. Beachten Sie, dass die Einträge im `system`-Array einfache Objekt-Literale verwenden, keine Klassen-Wrapper.

```typescript
// Node 22, @anthropic-ai/sdk 0.30
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";

const client = new Anthropic();
const SYSTEM = readFileSync("prompts/system.md", "utf8");

async function ask(userMessage: string) {
  return client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: [
      {
        type: "text",
        text: SYSTEM,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userMessage }],
  });
}

const first = await ask("List the public methods on OrderService.");
const second = await ask("Now list the private ones.");
console.log(first.usage);
console.log(second.usage);
```

Dieselbe Usage-Aufschlüsselung, dieselben Preise. Keine Header-Akrobatik.

## Wo Cache-Breakpoints in einer Agent-Schleife platzieren

Ein Coding-Agent hat nicht nur einen langen System-Prompt. Er hat eine lange **und wachsende** Nachrichtenhistorie plus einen statischen Tool-Katalog. Das Optimum sind meistens drei oder vier Breakpoints, angeordnet von am stabilsten zu am volatilsten.

Sie haben bis zu **4 explizite Cache-Breakpoints** pro Request. Die API cached alles vor und einschließlich jedes markierten Blocks, sodass jeder Breakpoint ein geschichtetes Präfix erzeugt.

```python
# Python 3.11, anthropic 0.42
client.messages.create(
    model="claude-opus-4-7",
    max_tokens=2048,
    tools=[
        # ... tool schemas ...
        {
            "name": "search_repo",
            "description": "...",
            "input_schema": {"type": "object", "properties": {...}},
            "cache_control": {"type": "ephemeral"},  # breakpoint 1: tools
        },
    ],
    system=[
        {
            "type": "text",
            "text": SYSTEM_PROMPT,
            "cache_control": {"type": "ephemeral"},  # breakpoint 2: system
        }
    ],
    messages=[
        # All prior turns...
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": stable_repo_summary,
                    "cache_control": {"type": "ephemeral"},  # breakpoint 3: repo state
                }
            ],
        },
        # ... older messages ...
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": current_user_turn,
                    "cache_control": {"type": "ephemeral"},  # breakpoint 4: most recent stable point
                }
            ],
        },
    ],
)
```

Die Regel lautet "stabil außen, volatil innen". Wenn sich Ihr Tool-Katalog ändert, sobald ein Feature Flag umgelegt wird, invalidiert diese Änderung jede andere Schicht dahinter. Wenn Ihr System-Prompt das heutige Datum einbettet, läuft jede Cache-Schreibung um Mitternacht UTC ab. Ziehen Sie alles Dynamische aus den gecachten Blöcken heraus.

## Die Trefferquote messen

Das Anbieter-Dashboard ist gut für eine monatliche Rechnung. Es ist nicht gut, um einen Agenten in Echtzeit zu tunen. Wickeln Sie das SDK ein und aggregieren Sie die Usage-Felder selbst.

```python
# Python 3.11, anthropic 0.42
from dataclasses import dataclass, field
import anthropic

@dataclass
class CacheStats:
    requests: int = 0
    base_input: int = 0          # uncached
    cache_writes_5m: int = 0
    cache_writes_1h: int = 0
    cache_reads: int = 0
    output: int = 0

    def record(self, usage):
        self.requests += 1
        self.base_input += usage.input_tokens
        self.cache_reads += usage.cache_read_input_tokens or 0
        creation = getattr(usage, "cache_creation", None)
        if creation:
            self.cache_writes_5m += creation.ephemeral_5m_input_tokens or 0
            self.cache_writes_1h += creation.ephemeral_1h_input_tokens or 0
        else:
            self.cache_writes_5m += usage.cache_creation_input_tokens or 0
        self.output += usage.output_tokens

    @property
    def hit_rate(self) -> float:
        cacheable = self.cache_reads + self.cache_writes_5m + self.cache_writes_1h
        return self.cache_reads / cacheable if cacheable else 0.0

    def cost_usd(self, base_input_per_mtok: float, output_per_mtok: float) -> float:
        # Sonnet 4.6: base_input=3.00, output=15.00
        # Opus 4.7:   base_input=15.00, output=75.00
        write_5m = self.cache_writes_5m * base_input_per_mtok * 1.25
        write_1h = self.cache_writes_1h * base_input_per_mtok * 2.0
        reads    = self.cache_reads     * base_input_per_mtok * 0.10
        base     = self.base_input      * base_input_per_mtok
        out      = self.output          * output_per_mtok
        return (write_5m + write_1h + reads + base + out) / 1_000_000

stats = CacheStats()

def cached_call(client, **kwargs):
    response = client.messages.create(**kwargs)
    stats.record(response.usage)
    return response
```

Lassen Sie den Agenten end-to-end laufen und drucken Sie dann die Trefferquote.

```python
print(f"requests:    {stats.requests}")
print(f"hit rate:    {stats.hit_rate:.1%}")
print(f"cache reads: {stats.cache_reads:,}")
print(f"5m writes:   {stats.cache_writes_5m:,}")
print(f"1h writes:   {stats.cache_writes_1h:,}")
print(f"uncached in: {stats.base_input:,}")
print(f"USD:         ${stats.cost_usd(3.00, 15.00):.4f}")  # Sonnet 4.6 prices
```

Ein gesunder 50-Runden-Coding-Agent auf Sonnet 4.6 mit einem 8k-System-Prompt landet typischerweise bei:

- 95-98% Trefferquote auf dem System-Prompt-Block.
- 70-90% Trefferquote auf dem Nachrichten-Block, je nachdem, wie aggressiv Sie neu prompten.
- 1,5x bis 4x weniger Gesamtausgaben als derselbe Agent ohne Caching.

Wenn die Trefferquote bei 0% kleben bleibt, sind fast immer drei Dinge schuld: Präfix unter dem Token-Mindestschwellwert, ein nicht-deterministischer Wert (Zeitstempel, Zufalls-ID, Dict-Reihenfolge) im gecachten Text, oder Nachrichten, die zwischen den Runden umsortiert wurden.

## Die 1-Stunden-TTL: Wann sie sich rechnet

Die Standard-TTL beträgt 5 Minuten. Für einen Chat-artigen Agenten ist das in Ordnung: Jede Runde frischt den Cache auf, und der kleine Schreibaufschlag wird über viele Lesevorgänge amortisiert.

Die 1-Stunden-TTL kostet beim Schreiben **2x Basis-Input**, hält aber zwölfmal länger. Die Rechnung: Wenn Sie für eine Stunde mindestens einen Lesevorgang alle fünf Minuten erwarten, funktioniert der 5-Minuten-Cache. Ist Ihr Traffic stoßweise (jemand führt den Agenten alle 20 Minuten aus), läuft der 5-Minuten-Cache zwischen den Runden ab, und Sie zahlen die Schreibkosten immer wieder. Die 1-Stunden-TTL rechnet sich in dem Moment, in dem zwei Cache-Lesevorgänge während einer einstündigen Leerlaufphase stattfinden.

```python
# Python 3.11, anthropic 0.42 -- mixing TTLs
system=[
    {
        "type": "text",
        "text": STABLE_INSTRUCTIONS,             # the bedrock part
        "cache_control": {"type": "ephemeral", "ttl": "1h"},
    },
    {
        "type": "text",
        "text": SESSION_SCOPED_CONTEXT,          # changes per user session
        "cache_control": {"type": "ephemeral", "ttl": "5m"},
    },
],
```

Beim Mischen von TTLs müssen Einträge mit längerer TTL **vor** denen mit kürzerer TTL stehen. Drehen Sie sie um, lehnt die API den Request ab.

Es ist kein Beta-Header erforderlich. Die alten `anthropic-beta: prompt-caching-2024-07-31` und der spätere `extended-cache-ttl-2025-04-11` sind eingestellt, das SDK akzeptiert sie aber weiterhin als No-Ops zur Abwärtskompatibilität.

## Fünf Stolperfallen, die die Trefferquote ruinieren

**1. Nicht-deterministischen Inhalt einbetten.** Ein `datetime.now()` in Ihrem System-Prompt invalidiert den Cache jede Sekunde. Häufige Übeltäter: Zeitstempel, Request-IDs, zufällige Beispieldaten zur Diversifikation, JSON-Serialisierung, die die Schlüssel-Reihenfolge nicht festlegt. Ändern sich die Bytes, scheitert der Cache.

**2. Tools oder Nachrichten umsortieren.** Die API hasht die Bytes in Reihenfolge. Ihr Tool-Array zwischen den Aufrufen anders zu sortieren, erzeugt einen anderen Hash. Bleiben Sie bei einer deterministischen Reihenfolge, idealerweise der Reihenfolge aus Ihrer Konfigurationsdatei.

**3. Vergessen, system von String auf Array umzustellen.** `system="..."` (eine einfache Zeichenkette) akzeptiert kein `cache_control`. Sie müssen `system=[{"type": "text", "text": "...", "cache_control": {"type": "ephemeral"}}]` verwenden. Das SDK warnt nicht, wenn Sie eine Zeichenkette mit Caching-Erwartungen übergeben.

**4. Das Lookback-Fenster von 20 Blöcken überschreiten.** Ein Breakpoint sieht nur 20 Content-Blöcke vor sich. In einer langen Tool-Use-Schleife mit vielen tool_result-Blöcken fällt Ihr Breakpoint nahe dem Anfang der Konversation irgendwann aus dem Bereich. Fügen Sie einen zweiten Breakpoint näher an der aktuellen Runde hinzu, bevor das passiert.

**5. Auf denselben Cache aus verschiedenen Organisationen oder Workspaces zugreifen.** Caches sind pro Organisation isoliert und seit Februar 2026 auch pro Workspace auf der Anthropic-API und auf Azure. Wenn Sie Dev in einem Workspace und Prod in einem anderen betreiben, teilen sie keine gecachten Präfixe.

Für einen tieferen Blick auf das, was das Anthropic SDK auf der .NET-Seite umhüllt, siehe [Microsoft Agent Framework 1.0 für KI-Agenten in C#](/de/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) und [GitHub Copilots BYOK-Unterstützung für den Anthropic-Provider in VS Code](/de/2026/04/github-copilot-vs-code-byok-anthropic-ollama-foundry-local/).

## Was "automatisches Caching" tut und warum es nicht ausreicht

Die jüngsten SDK-Releases haben einen `cache_control`-Parameter auf oberster Ebene in `messages.create` ergänzt. Ihn zu setzen, weist die API an, Caching automatisch auf Basis von Heuristiken anzuwenden. Es funktioniert, wählt aber einen Breakpoint, und Sie können nicht steuern, welchen. Für einen einzelnen langen System-Prompt ist das in Ordnung. Für eine Agent-Schleife mit Tool-Katalogen, Zusammenfassungen und Nachrichtenhistorie wollen Sie explizite Breakpoints. Den Auto-Modus behandelt man am besten als Rauchtest: einmal einschalten, um zu bestätigen, dass Caching in Ihrem Setup funktioniert, dann zu expliziten `cache_control`-Blöcken wechseln.

Wenn Sie auch MCP-Server bauen, die Tools an denselben Agenten freigeben, gelten dieselben Layout-Prinzipien. Siehe [Wie man einen eigenen MCP-Server in C# auf .NET 11 baut](/de/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/), [Wie man einen MCP-Server in TypeScript baut, der ein CLI umhüllt](/de/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) und [Wie man einen eigenen MCP-Server in Python mit dem offiziellen SDK baut](/de/2026/04/how-to-build-a-custom-mcp-server-in-python-with-the-official-sdk/) für die Server-Seite. Die Anleitung zur Breakpoint-Platzierung hier gilt für den Client, der sie aufruft.

## Eine Tabellenkalkulationssicht, wann sich Caching lohnt

Für eine grobe Überschlagsrechnung nehmen Sie die Präfixgröße in Tokens (`P`), die Anzahl erwarteter Lesevorgänge pro Schreibvorgang (`R`) und den Cache-TTL-Multiplikator (`m`, wobei `m=1.25` für 5m und `m=2.0` für 1h). Die Break-even-Lesezahl für ein einzelnes gecachtes Präfix gegenüber der ungecachten Baseline ist:

```
R_breakeven = (m - 1) / (1 - 0.1)
            = (m - 1) / 0.9
```

Das sind **0,28 Lesevorgänge** für die 5-Minuten-TTL und **1,11 Lesevorgänge** für die 1-Stunden-TTL. Mit anderen Worten: Der 5-Minuten-Cache rechnet sich nach einem einzigen Lesevorgang in jedem realistischen Szenario, der 1-Stunden-Cache nach dem zweiten Lesevorgang. Es gibt im Grunde kein Agent-Schleifen-Szenario, in dem Caching die falsche Wahl wäre; die einzige Frage ist, welche TTL.

Mehr zu Agent-Schleifen-Mustern, die von Caching profitieren, finden Sie in [Wie man eine CLAUDE.md schreibt, die das Modellverhalten tatsächlich ändert](/de/2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour/) und [Wie man eine wiederkehrende Claude-Code-Aufgabe plant, die GitHub-Issues triagiert](/de/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/).

## Referenz-Links

- [Prompt-Caching-Dokumentation](https://docs.claude.com/en/docs/build-with-claude/prompt-caching)
- [Anthropic Python SDK auf PyPI](https://pypi.org/project/anthropic/)
- [Anthropic TypeScript SDK auf npm](https://www.npmjs.com/package/@anthropic-ai/sdk)
- [Anthropic-API-Preise](https://docs.claude.com/en/docs/about-claude/pricing)
