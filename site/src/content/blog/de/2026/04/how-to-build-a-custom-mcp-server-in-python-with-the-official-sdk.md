---
title: "Wie Sie einen eigenen MCP-Server in Python mit dem offiziellen SDK bauen"
description: "Bauen Sie einen funktionierenden Model-Context-Protocol-Server in Python mit dem offiziellen mcp-1.27-SDK und FastMCP. Behandelt Pydantic-Schemas, die Stdio-Stdout-Falle, mcp dev / mcp install und die Registrierung bei Claude Desktop und Claude Code."
pubDate: 2026-04-25
tags:
  - "mcp"
  - "ai-agents"
  - "python"
  - "claude-code"
lang: "de"
translationOf: "2026/04/how-to-build-a-custom-mcp-server-in-python-with-the-official-sdk"
translatedBy: "claude"
translationDate: 2026-04-29
---

Das Python-Ökosystem hat den tiefsten Katalog an "Sache, die ich meinen Agenten nutzen lassen will": SQLAlchemy-ORMs, pandas-DataFrames, scikit-learn-Pipelines, AWS-boto3-Clients, interne Skripte, die Ihr Datenteam längst geschrieben hat. Beliebiges davon als Model-Context-Protocol-Server zu verpacken, dauert mit dem offiziellen SDK 30 Zeilen, und das Ergebnis ist aus Claude Desktop, Claude Code, Cursor und jedem Client aufrufbar, der die MCP-Spec spricht.

Diese Anleitung baut einen echten, lauffähigen MCP-Server in Python mit dem `mcp`-1.27.0-SDK (veröffentlicht im April 2026) auf Python 3.10+, mit `FastMCP` als High-Level-API. Am Ende haben Sie einen `db-mcp`-Server, der eine SQLite-Datenbank über drei Tools an einen Agenten exponiert, mit ordentlichen Pydantic-Schemas, Fehlerbehandlung und den zwei Debug-Befehlen (`mcp dev` und `mcp install`), die die Doku überfliegt, die Sie aber täglich nutzen werden.

## Warum Python die richtige Wahl für diese Art Server ist

Das TypeScript-SDK ist okay. Das C#-SDK ist okay. Aber wenn das System, das Sie exponieren möchten, schon ein Python-Skript, eine FastAPI-App oder ein exportiertes Notebook ist, ist es verschwendete Arbeit, das in einer anderen Sprache neu zu schreiben, nur um MCP daranzuschrauben. Das Python-SDK lässt Sie `@mcp.tool()` über eine bestehende Funktion setzen und ausliefern.

Zwei spezifische Fälle, in denen Python entscheidend gewinnt:

- **Daten-Tooling.** Alles, was pandas, NumPy, DuckDB, Polars oder ein SQL-ORM betrifft, ist in Python eine Ein-Decorator-Änderung. Dasselbe in TypeScript zu machen heißt, die Datenebene neu zu implementieren oder einen Subprozess zu starten.
- **ML-/LLM-Glue-Code.** Wenn das Tool selbst einen LLM aufruft (ein RAG-Retriever, ein Re-Ranker, ein kleiner Klassifizierer), liegen die Bibliotheken bereits in Python. Sie als MCP-Tools zu verpacken, hält den Aufrufgraphen in einem Prozess.

Das offizielle SDK liegt unter [modelcontextprotocol/python-sdk](https://github.com/modelcontextprotocol/python-sdk). Beachten Sie, dass **FastMCP 1.0 Ende 2024 in dieses offizielle SDK gemerged wurde**. Es gibt zudem ein separates, drittanbietendes `fastmcp`-Paket auf PyPI (derzeit 3.x), das ein anderes Projekt ist. Für neuen Code bevorzugen Sie das offizielle `mcp`-Paket und importieren `FastMCP` aus `mcp.server.fastmcp`. Beides zu mischen führt zu subtilen Importfehlern und Versions-Drift.

## Projekt-Setup mit uv

Sie brauchen Python 3.10 oder höher. Das 1.27-SDK unterstützt 3.10 bis 3.13. Der in der SDK-Doku empfohlene Paketmanager ist `uv`, weil er die Befehle `mcp install` und `mcp dev` antreibt, aber `pip` funktioniert für den Installationsschritt selbst.

```bash
# Python 3.10+, uv 0.5+
mkdir db-mcp
cd db-mcp
uv init
uv add "mcp[cli]"
```

Das Extra `[cli]` zieht das `mcp`-Kommandozeilenwerkzeug nach, das Ihnen `mcp dev` und `mcp install` gibt. Ohne es können Sie den Server zwar laufen lassen, aber der Inspector und die Claude-Desktop-Registrierungsbefehle existieren dann nicht.

Erstellen Sie die Quelldatei:

```bash
mkdir src
touch src/server.py
```

Fügen Sie ein SQLite-Seed-Skript (`seed.py`) hinzu, damit das Beispiel Daten zum Abfragen hat. Das ist nur für die Demo, kein Teil des Servers:

```python
# seed.py -- creates a sample SQLite DB for the MCP server to expose
import sqlite3

conn = sqlite3.connect("inventory.db")
cur = conn.cursor()
cur.executescript("""
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  stock INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO products (sku, name, stock) VALUES
  ('SKU-001', 'Mechanical keyboard', 12),
  ('SKU-002', 'Trackball mouse', 0),
  ('SKU-003', 'USB-C dock', 4);
""")
conn.commit()
conn.close()
```

Führen Sie `python seed.py` einmal aus. Der MCP-Server liest diese Datei im Read-only-Modus.

## Die Stdout-Falle, die jeden Python-Stdio-Server zerstört

Bevor Sie einen einzigen Tool-Handler schreiben, verinnerlichen Sie das: **Drucken Sie in einem Stdio-MCP-Server niemals nach stdout**.

Wenn ein Stdio-MCP-Server startet, kommuniziert der Client (Claude Desktop, Claude Code, Cursor) über `stdin` und `stdout` mit ihm via zeilenbegrenztes JSON-RPC. Jedes Byte, das Sie nach stdout schreiben und das keine gültige JSON-RPC-Nachricht ist, korrumpiert den Stream. Der Client loggt einen generischen "MCP server disconnected"- oder "failed to parse response"-Fehler und gibt auf.

In Python sind die Übeltäter offensichtlich, sobald man weiß, wonach man sucht:

```python
# mcp 1.27.0, stdio transport

# Bad -- corrupts the JSON-RPC stream
print("Loaded 47 rows from inventory.db")

# Bad -- logging.basicConfig() defaults to stderr in modern Python,
# but if you reroute it to stdout you have the same problem
import logging
logging.basicConfig(stream=sys.stdout)  # do not do this

# Good -- write diagnostics to stderr
import sys
print("Loaded 47 rows from inventory.db", file=sys.stderr)

# Good -- the standard logging module defaults to stderr
import logging
logging.basicConfig(level=logging.INFO)
log = logging.getLogger("db-mcp")
log.info("Loaded 47 rows from inventory.db")
```

Der Grund, warum das Python-Autoren öfter erwischt als TypeScript-Autoren: `print()` ist in Python das Standard-Debug-Instrument, und ein verirrter Aufruf in einem Tool-Handler bringt lokal nichts zum Absturz. Den Fehler sehen Sie erst, wenn der MCP-Client die Antwort parsen will und Müll vor dem JSON findet. Setzen Sie `file=sys.stderr` überall, wo Sie sonst `print()` schreiben würden, und nutzen Sie `logging` für alles Strukturierte.

## Der minimale Server mit FastMCP

Öffnen Sie `src/server.py`. Beginnen Sie mit einem Ein-Tool-Server, um zu bestätigen, dass die Verdrahtung funktioniert:

```python
# src/server.py
# mcp 1.27.0, Python 3.10+, MCP spec 2025-03-26

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("db-mcp")

@mcp.tool()
def ping() -> str:
    """Return 'pong' to confirm the server is reachable."""
    return "pong"

if __name__ == "__main__":
    mcp.run(transport="stdio")
```

Das ist die gesamte erforderliche Oberfläche für einen funktionierenden Server. Der Decorator leitet das Eingabeschema aus den Type-Hints (hier keine) und die Beschreibung aus dem Docstring ab. `mcp.run(transport="stdio")` blockiert den Prozess und liest JSON-RPC-Nachrichten von stdin, bis der Client trennt.

Testen Sie ohne jede Client-Konfiguration, indem Sie den Inspector starten:

```bash
uv run mcp dev src/server.py
```

`mcp dev` startet den Server, hängt die UI des [MCP Inspectors](https://github.com/modelcontextprotocol/inspector) auf localhost an und zeigt Ihnen den rohen JSON-RPC-Verkehr. Sie können `ping` aufrufen, die Antwort sehen und bestätigen, dass keine verirrte Ausgabe den Stream korrumpiert. Das ist der einzige nützlichste Befehl im SDK, und die Doku vergräbt ihn auf einer Unterseite.

## Echte Tools mit Pydantic-Schemas

Ersetzen Sie den `ping`-Platzhalter mit drei nützlichen Tools, die von Pydantic-Modellen gestützt werden. Das SDK nutzt Pydantic sowohl für Eingabe-Validierung als auch für strukturierte Ausgabe, was die Tool-Schemas robust macht, ohne JSON-Schema von Hand zu schreiben:

```python
# src/server.py
# mcp 1.27.0, Pydantic 2.x

import sqlite3
from pathlib import Path
from typing import Annotated

from pydantic import BaseModel, Field
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("db-mcp")

DB_PATH = Path(__file__).parent.parent / "inventory.db"

class Product(BaseModel):
    """A row from the products table."""
    id: int
    sku: str
    name: str
    stock: int = Field(description="Units currently in stock")

class StockUpdate(BaseModel):
    """Result of a stock-adjustment call."""
    sku: str
    previous_stock: int
    new_stock: int

def _connect() -> sqlite3.Connection:
    # Open read/write but with a timeout so a long write doesn't wedge the agent
    conn = sqlite3.connect(DB_PATH, timeout=5.0)
    conn.row_factory = sqlite3.Row
    return conn

@mcp.tool()
def list_products(
    low_stock: Annotated[
        bool,
        Field(description="If true, return only products with stock < 5."),
    ] = False,
) -> list[Product]:
    """List products in the inventory database."""
    with _connect() as conn:
        if low_stock:
            rows = conn.execute(
                "SELECT id, sku, name, stock FROM products WHERE stock < 5"
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT id, sku, name, stock FROM products"
            ).fetchall()
        return [Product(**dict(r)) for r in rows]

@mcp.tool()
def get_product(
    sku: Annotated[str, Field(description="Stock-keeping unit, e.g. SKU-001")],
) -> Product:
    """Look up a single product by SKU."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT id, sku, name, stock FROM products WHERE sku = ?",
            (sku,),
        ).fetchone()
        if row is None:
            raise ValueError(f"No product found with sku={sku!r}")
        return Product(**dict(row))

@mcp.tool()
def adjust_stock(
    sku: Annotated[str, Field(description="SKU to adjust")],
    delta: Annotated[
        int,
        Field(
            description="Positive to add stock, negative to remove. "
                        "Tool will refuse to drive stock below zero.",
        ),
    ],
) -> StockUpdate:
    """Adjust stock for a SKU by a positive or negative delta."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT stock FROM products WHERE sku = ?", (sku,)
        ).fetchone()
        if row is None:
            raise ValueError(f"No product found with sku={sku!r}")
        previous = row["stock"]
        new = previous + delta
        if new < 0:
            raise ValueError(
                f"Refusing to set stock below zero (would be {new})."
            )
        conn.execute(
            "UPDATE products SET stock = ? WHERE sku = ?", (new, sku)
        )
        conn.commit()
        return StockUpdate(sku=sku, previous_stock=previous, new_stock=new)

if __name__ == "__main__":
    mcp.run(transport="stdio")
```

Ein paar Details, die zählen:

- **`Annotated[T, Field(...)]` statt schlichter Defaults.** Das SDK nutzt `Field(description=...)`, um die Beschreibung im JSON-Schema zu füllen, die der Agent sieht, wenn er entscheidet, welches Tool er aufrufen soll. Eine vage Beschreibung wie "die SKU" wird mit beliebigen Strings verwechselt; "Stock-keeping unit, e.g. SKU-001" verankert den Agenten am richtigen Format.
- **Pydantic-Modelle als Rückgabetypen.** `list[Product]` und `StockUpdate` werden automatisch in strukturierte Ausgabe umgewandelt. Der Client erhält sowohl ein JSON-Dokument als auch eine menschenlesbare Textdarstellung, und ein nachgelagerter Agent kann direkt über typisierte Felder schließen. Würden Sie ein einfaches `dict` zurückgeben, würde das SDK es zwar weiterhin serialisieren, aber der Agent verlöre Schema und Typgarantien.
- **`raise ValueError` für Tool-Level-Fehler.** FastMCP fängt die Exception ab und gibt sie als Tool-Error an den Client zurück, den der Agent sehen und auf den er reagieren kann. Sie müssen `CallToolResult`-Objekte für den Standardfall nicht von Hand bauen. Reservieren Sie manuelles `CallToolResult`-Bauen für Fälle, in denen Sie Felder wie `isError` zusammen mit zusätzlichen Metadaten setzen müssen.
- **Nur parametrisiertes SQL.** `?`-Platzhalter, niemals f-Strings. Ein LLM reicht freudig eine SKU wie `'; DROP TABLE products; --` durch, wenn das Tool weiter oben gegenüber Benutzereingabe exponiert ist, und `sqlite3` behandelt die parametrisierte Variante als literalen String, statt sie auszuführen.

## Anschluss an Claude Desktop

Sie haben zwei Wege. Der einfache nutzt den eigenen `mcp install`-Befehl des SDKs:

```bash
uv run mcp install src/server.py --name "Inventory DB"
```

Damit wird die Claude-Desktop-Konfiguration für Sie gepatcht und auf den Server mit dem richtigen `uv run`-Aufruf samt Working Directory zeigt. Wenn Sie Umgebungsvariablen brauchen (einen API-Key, eine Datenbank-URL, irgendetwas Geheimes), übergeben Sie sie mit `-v`:

```bash
uv run mcp install src/server.py --name "Inventory DB" \
  -v DB_URL=postgres://... -v API_KEY=abc123
```

Wenn Sie die Konfiguration lieber von Hand verwalten, bearbeiten Sie `claude_desktop_config.json`. Auf macOS liegt sie in `~/Library/Application Support/Claude/claude_desktop_config.json`; unter Windows in `%AppData%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "inventory-db": {
      "command": "uv",
      "args": [
        "--directory",
        "/absolute/path/to/db-mcp",
        "run",
        "python",
        "src/server.py"
      ]
    }
  }
}
```

Starten Sie Claude Desktop neu. Der MCP-Indikator sollte `list_products`, `get_product` und `adjust_stock` listen. Fragen Sie: "Welche Produkte sind knapp?" und beobachten Sie, wie Claude `list_products(low_stock=True)` aufruft.

Um es an Claude Code anzubinden, führen Sie aus dem Projektverzeichnis aus:

```bash
claude mcp add inventory-db -- uv run python src/server.py
```

Oder fügen Sie denselben `mcpServers`-Block in `.claude/settings.json` unter dem Projektroot ein.

## Fallen in Python-Servern in Produktion

**Async-Tools, wenn Sie sie brauchen.** Die Handler oben sind synchron. FastMCP akzeptiert auch `async def`-Handler, was die richtige Wahl ist, wenn das Tool eine Remote-API (httpx) oder einen anderen LLM aufruft. Sync und Async zu mischen, ist okay: Wickeln Sie eine synchrone Bibliothek nicht in `asyncio.to_thread`, es sei denn, sie blockiert wirklich.

**Working-Directory-Überraschungen.** Wenn Claude Desktop den Server startet, ist das Working Directory des Prozesses dort, wo Claude Desktop ihn aufgerufen hat, nicht Ihr Projekt. Verankern Sie Dateipfade mit `Path(__file__).parent` (wie im Beispiel) oder reichen Sie absolute Pfade über Tool-Argumente durch. Sich auf `os.getcwd()` zu stützen, bricht in dem Moment, in dem der Nutzer eine andere Chat-Session öffnet.

**Isolation der virtuellen Umgebung.** Wenn die Claude-Desktop-Konfiguration schlichtweg `python` aufruft, nutzt sie das Python, das auf dem System-PATH liegt, nicht das `.venv` Ihres Projekts. Die Form `uv run python ...` löst das: `uv` löst die Projekt-Umgebung aus `pyproject.toml` auf und startet jedes Mal den richtigen Interpreter. Selbstgebaute Konfigurationen, die direkt auf `python3` zeigen, scheitern beim ersten Hinzufügen einer Abhängigkeit.

**Große Abfrageergebnisse.** Eine Million Zeilen als Liste von Pydantic-Modellen zurückzugeben, schlägt das Content-Size-Limit des Clients und stallt. Entweder paginieren Sie mit expliziten `limit`- und `offset`-Parametern, oder fassen Sie im Tool zusammen (count, aggregate) und lassen den Agenten Folgefragen stellen. Die MCP-Spec erzwingt keine harte Obergrenze, aber praktische Client-Limits liegen bei ein paar hundert KB strukturiertem Inhalt.

**Concurrency.** SQLite serialisiert per Default Schreibvorgänge. Wenn zwei Tool-Aufrufe `adjust_stock` gleichzeitig feuern und einer einen Schreib-Lock über das `timeout` von 5 Sekunden hinaus hält, wirft der andere `OperationalError: database is locked`. Für echte Lasten wechseln Sie zu PostgreSQL oder nutzen einen Connection Pool. Für lokale Agenten-Demos ist das 5-Sekunden-Timeout in `_connect()` ausreichend.

**Streaming-HTTP-Transport.** Das SDK unterstützt `transport="streamable-http"` und das ältere `transport="sse"` für Remote-Deployments. Wenn Sie den Server als langlebigen Dienst betreiben wollen, statt ihn pro Client zu starten, wechseln Sie hier den Transport und stellen den Server hinter einen Reverse Proxy. Für lokale Agentenarbeit ist Stdio richtig.

## Was dieses Muster freischaltet

Der Kernzug -- eine Funktion dekorieren, ein Pydantic-Modell zurückgeben, bei Fehlern werfen -- skaliert auf jede Python-Integration, die Ihr Team bereits hat. Ein paar einfache nächste Schritte:

- Wickeln Sie eine SQLAlchemy-Session ein und exponieren Sie Schema-Introspektion plus ein parametrisiertes `query`-Tool, sodass ein Agent "wie viele Bestellungen wurden letzte Woche versandt?" beantworten kann, ohne dass Sie das SQL schreiben.
- Wickeln Sie eine interne LLM-Pipeline ein, die Sie bereits ausliefern (RAG-Retriever, Klassifizierer), und lassen Sie andere Agenten sie als Tool aufrufen, statt sie nachzubauen.
- Wickeln Sie ein notebookartiges Skript ein, das das Datenteam nutzt (CSV laden, Modell ausführen, Report schreiben), in ein Tool, das der Bereitschaftsagent während der Incident Response aufrufen kann.

Wenn Sie hauptsächlich in TypeScript arbeiten, deckt [dasselbe Muster in TypeScript, das ein CLI umhüllt](/de/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) die Node.js-Seite mit `@modelcontextprotocol/sdk` 1.29 ab. Auf der .NET-Seite zeigt [Microsofts MCP-Verdrahtung für Model-Context-Protocol-Server aus C# auf .NET 10](/2026/01/microsoft-mcp-wiring-model-context-protocol-servers-from-c-on-net-10/) das C#-Pendant. Für ein Gefühl, wie MCP aussieht, wenn eine IDE Server nativ bündelt, ist [der Azure MCP Server in Visual Studio 2022 17.14.30](/de/2026/04/azure-mcp-server-visual-studio-2022-17-14-30/) eine nützliche Praxisreferenz. Und wenn Sie über rohes MCP hinaus auf Multi-Agent-Orchestrierung schauen, ist [Microsoft Agent Framework 1.0](/de/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) das SDK, das dort anknüpft, wo MCP aufhört.

Den MCP-Server selbst kümmert es nicht, ob Ihr Tool eine Datenbank, einen REST-Client oder eine 200-zeilige pandas-Pipeline umhüllt. Er braucht nur ein typisiertes Eingabeschema (Pydantic gibt Ihnen das gratis), einen Rückgabewert, den das SDK serialisieren kann, und einen Transport, in dem keine verirrten Bytes herumfliegen.

## Quellen

- [MCP Python SDK -- modelcontextprotocol/python-sdk](https://github.com/modelcontextprotocol/python-sdk)
- [mcp 1.27.0 auf PyPI](https://pypi.org/project/mcp/)
- [Offizieller MCP-Build-Server-Leitfaden](https://modelcontextprotocol.io/docs/develop/build-server)
- [MCP-Spec (2025-03-26)](https://modelcontextprotocol.io/specification/2025-03-26)
- [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
