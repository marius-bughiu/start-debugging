---
title: "Cómo construir un servidor MCP personalizado en Python con el SDK oficial"
description: "Construye un servidor Model Context Protocol funcional en Python usando el SDK oficial mcp 1.27 y FastMCP. Cubre los esquemas de Pydantic, la trampa de stdout en stdio, mcp dev / mcp install y el registro con Claude Desktop y Claude Code."
pubDate: 2026-04-25
tags:
  - "mcp"
  - "ai-agents"
  - "python"
  - "claude-code"
lang: "es"
translationOf: "2026/04/how-to-build-a-custom-mcp-server-in-python-with-the-official-sdk"
translatedBy: "claude"
translationDate: 2026-04-29
---

El ecosistema de Python tiene el catálogo más profundo de "cosas que quiero que mi agente use": ORMs de SQLAlchemy, dataframes de pandas, pipelines de scikit-learn, clientes boto3 de AWS, scripts internos que tu equipo de datos ya escribió. Envolver cualquiera de eso como un servidor Model Context Protocol toma 30 líneas con el SDK oficial, y el resultado es invocable desde Claude Desktop, Claude Code, Cursor y cualquier cliente que hable la spec MCP.

Esta guía construye un servidor MCP en Python real y ejecutable usando el SDK `mcp` 1.27.0 (publicado en abril de 2026) sobre Python 3.10+, con `FastMCP` como la API de alto nivel. Al final tendrás un servidor `db-mcp` que expone una base de datos SQLite a un agente a través de tres herramientas, con esquemas de Pydantic adecuados, manejo de errores y los dos comandos de depuración (`mcp dev` y `mcp install`) que la documentación pasa por alto pero que usarás todos los días.

## Por qué Python es la elección correcta para este tipo de servidor

El SDK de TypeScript está bien. El SDK de C# está bien. Pero si el sistema que quieres exponer ya es un script de Python, una app de FastAPI o la exportación de un notebook, reescribirlo en otro lenguaje para atornillarle MCP es trabajo desperdiciado. El SDK de Python te permite poner `@mcp.tool()` encima de una función existente y publicar.

Dos casos específicos en los que Python gana decisivamente:

- **Tooling de datos.** Cualquier cosa que involucre pandas, NumPy, DuckDB, Polars o un ORM SQL es un cambio de un decorador en Python. Hacer lo mismo en TypeScript significa reimplementar la capa de datos o invocar un proceso aparte.
- **Código pegamento de ML / LLM.** Si la herramienta misma llama a un LLM (un retriever de RAG, un re-ranker, un clasificador pequeño), las bibliotecas ya viven en Python. Envolverlas como herramientas MCP mantiene el grafo de llamadas en un solo proceso.

El SDK oficial está en [modelcontextprotocol/python-sdk](https://github.com/modelcontextprotocol/python-sdk). Ten en cuenta que **FastMCP 1.0 se fusionó con este SDK oficial a finales de 2024**. También existe un paquete `fastmcp` separado, de terceros en PyPI (actualmente 3.x) que es un proyecto diferente. Para código nuevo, prefiere el paquete oficial `mcp` e importa `FastMCP` desde `mcp.server.fastmcp`. Mezclar los dos lleva a errores sutiles de importación y deriva de versiones.

## Configuración del proyecto con uv

Necesitas Python 3.10 o posterior. El SDK 1.27 soporta de 3.10 a 3.13. El gestor de paquetes recomendado en la documentación del SDK es `uv` porque alimenta los comandos `mcp install` y `mcp dev`, pero `pip` funciona para el paso de instalación en sí.

```bash
# Python 3.10+, uv 0.5+
mkdir db-mcp
cd db-mcp
uv init
uv add "mcp[cli]"
```

El extra `[cli]` trae la herramienta de línea de comandos `mcp` que te da `mcp dev` y `mcp install`. Sin eso, todavía puedes ejecutar el servidor, pero el inspector y los comandos de registro de Claude Desktop no existirán.

Crea el archivo fuente:

```bash
mkdir src
touch src/server.py
```

Añade un script de seed para SQLite (`seed.py`) para que el ejemplo tenga datos que consultar. Esto es solo para la demo, no es parte del servidor:

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

Ejecuta `python seed.py` una vez. El servidor MCP leerá este archivo en modo solo lectura.

## La trampa de stdout que rompe todo servidor stdio en Python

Antes de escribir un solo handler de herramienta, interioriza esto: **nunca imprimas en stdout en un servidor MCP stdio**.

Cuando un servidor MCP stdio arranca, el cliente (Claude Desktop, Claude Code, Cursor) se comunica con él sobre `stdin` y `stdout` usando JSON-RPC delimitado por línea. Cualquier byte que escribas a stdout que no sea un mensaje JSON-RPC válido corrompe el flujo. El cliente registra un error genérico de "MCP server disconnected" o "failed to parse response" y se rinde.

En Python los culpables son obvios una vez que sabes buscarlos:

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

La razón por la que esto atrapa a autores de Python más a menudo que a los de TypeScript: `print()` es el instrumento de depuración por defecto en Python, y uno perdido dentro del handler de una herramienta no rompe nada localmente. Solo ves el fallo cuando el cliente MCP intenta parsear la respuesta y encuentra basura delante del JSON. Añade `file=sys.stderr` en todas partes donde normalmente harías `print()`, y usa `logging` para cualquier cosa estructurada.

## El servidor mínimo con FastMCP

Abre `src/server.py`. Empieza con un servidor de una sola herramienta para confirmar que el cableado funciona:

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

Esa es toda la superficie requerida para un servidor funcional. El decorador infiere el esquema de entrada de los type hints (ninguno aquí) y la descripción del docstring. `mcp.run(transport="stdio")` bloquea el proceso y lee mensajes JSON-RPC desde stdin hasta que el cliente se desconecte.

Pruébalo sin configurar ningún cliente ejecutando el inspector:

```bash
uv run mcp dev src/server.py
```

`mcp dev` lanza el servidor, conecta la UI del [MCP Inspector](https://github.com/modelcontextprotocol/inspector) en localhost y te muestra el tráfico JSON-RPC crudo. Puedes invocar `ping`, ver la respuesta y confirmar que no hay salida perdida corrompiendo el flujo. Este es el único comando más útil del SDK y la documentación lo entierra en una subpágina.

## Herramientas reales con esquemas de Pydantic

Reemplaza el placeholder `ping` con tres herramientas útiles respaldadas por modelos Pydantic. El SDK usa Pydantic tanto para validación de entrada como para salida estructurada, que es lo que hace que los esquemas de las herramientas sean robustos sin escribir JSON Schema a mano:

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

Algunos detalles que importan:

- **`Annotated[T, Field(...)]` en lugar de defaults planos.** El SDK usa `Field(description=...)` para poblar la descripción del JSON Schema que el agente ve cuando decide qué herramienta llamar. Una descripción vaga como "el SKU" se confunde con strings arbitrarios; "Stock-keeping unit, e.g. SKU-001" ancla al agente al formato correcto.
- **Modelos Pydantic como tipos de retorno.** `list[Product]` y `StockUpdate` se convierten a salida estructurada automáticamente. El cliente recibe tanto un documento JSON como una representación de texto legible por humanos, y un agente downstream puede razonar directamente sobre los campos tipados. Si devolvieras un `dict` plano, el SDK aún lo serializaría, pero el agente perdería el esquema y cualquier garantía de tipo.
- **`raise ValueError` para errores a nivel de herramienta.** FastMCP captura la excepción y la devuelve como un error de herramienta al cliente, que el agente puede ver y al que puede reaccionar. No necesitas construir objetos `CallToolResult` a mano para el caso común. Reserva la construcción manual de `CallToolResult` para casos donde necesites establecer campos como `isError` junto a metadata extra.
- **Solo SQL parametrizado.** Marcadores `?`, nunca f-strings. Un LLM pasará felizmente un SKU como `'; DROP TABLE products; --` si la herramienta queda expuesta a entrada de usuario aguas arriba, y `sqlite3` tratará la versión parametrizada como un string literal en lugar de ejecutarlo.

## Conectarlo a Claude Desktop

Tienes dos caminos. El simple usa el propio comando `mcp install` del SDK:

```bash
uv run mcp install src/server.py --name "Inventory DB"
```

Esto parchea la configuración de Claude Desktop por ti y la apunta al servidor con la invocación `uv run` correcta, incluyendo el directorio de trabajo. Si necesitas variables de entorno (una clave de API, una URL de base de datos, cualquier secreto), pásalas con `-v`:

```bash
uv run mcp install src/server.py --name "Inventory DB" \
  -v DB_URL=postgres://... -v API_KEY=abc123
```

Si prefieres gestionar la configuración a mano, edita `claude_desktop_config.json`. En macOS vive en `~/Library/Application Support/Claude/claude_desktop_config.json`; en Windows en `%AppData%\Claude\claude_desktop_config.json`:

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

Reinicia Claude Desktop. El indicador MCP debería listar `list_products`, `get_product` y `adjust_stock`. Pregunta: "¿Qué productos están bajos de stock?" y mira a Claude llamar `list_products(low_stock=True)`.

Para conectarlo a Claude Code, ejecuta desde el directorio del proyecto:

```bash
claude mcp add inventory-db -- uv run python src/server.py
```

O añade el mismo bloque `mcpServers` a `.claude/settings.json` bajo la raíz del proyecto.

## Trampas en servidores Python en producción

**Herramientas async cuando las necesites.** Los handlers de arriba son síncronos. FastMCP también acepta handlers `async def`, que es la elección correcta cuando la herramienta llama a una API remota (httpx) u otro LLM. Mezclar sync y async está bien: no envuelvas una biblioteca síncrona en `asyncio.to_thread` a menos que realmente bloquee.

**Sorpresas del directorio de trabajo.** Cuando Claude Desktop lanza el servidor, el directorio de trabajo del proceso es desde donde Claude Desktop lo lanzó, no tu proyecto. Ancla las rutas de archivos usando `Path(__file__).parent` (como en el ejemplo) o pasa rutas absolutas a través de los argumentos de la herramienta. Apoyarte en `os.getcwd()` se romperá en el momento en que el usuario abra una sesión de chat distinta.

**Aislamiento del entorno virtual.** Si la configuración de Claude Desktop invoca `python` a secas, usa cualquier Python que haya en el PATH del sistema, no el `.venv` de tu proyecto. La forma `uv run python ...` resuelve esto: `uv` resuelve el entorno del proyecto desde `pyproject.toml` y ejecuta el intérprete correcto cada vez. Las configuraciones hechas a mano que apuntan a `python3` directamente fallarán la primera vez que añadas una dependencia.

**Resultados de consulta grandes.** Devolver un millón de filas como una lista de modelos Pydantic golpeará el límite de tamaño de contenido del cliente y se atascará. O paginas con parámetros explícitos de `limit` y `offset`, o resumes (cuenta, agrega) en la herramienta y dejas que el agente pregunte después. La spec MCP no impone un techo duro, pero los límites prácticos del cliente se sitúan alrededor de unos pocos cientos de KB de contenido estructurado.

**Concurrencia.** SQLite serializa las escrituras por defecto. Si dos llamadas de herramienta disparan `adjust_stock` simultáneamente y una mantiene un bloqueo de escritura más allá del `timeout` de 5 segundos, la otra lanza `OperationalError: database is locked`. Para cargas reales, cambia a PostgreSQL o usa un pool de conexiones. Para demos locales con agentes, el timeout de 5 segundos en `_connect()` es suficiente.

**Transporte HTTP streameable.** El SDK soporta `transport="streamable-http"` y el más antiguo `transport="sse"` para despliegues remotos. Si planeas ejecutar el servidor como un servicio de larga vida en lugar de lanzarlo por cliente, cambia los transportes aquí y pon el servidor detrás de un proxy inverso. Para trabajo local con agentes, stdio es correcto.

## Lo que este patrón desbloquea

El movimiento central -- decora una función, devuelve un modelo Pydantic, lanza en errores -- escala a cada integración Python que tu equipo ya tiene. Algunos siguientes pasos sencillos:

- Envuelve una sesión de SQLAlchemy y expón introspección de esquema más una herramienta `query` parametrizada, para que un agente pueda responder "cuántos pedidos se enviaron la semana pasada" sin que tú escribas el SQL.
- Envuelve un pipeline LLM interno que ya despliegas (retrievers de RAG, clasificadores) y deja que otros agentes lo llamen como herramienta en lugar de reimplementarlo.
- Envuelve un script tipo notebook que el equipo de datos usa (cargar CSV, ejecutar el modelo, volcar el reporte) en una herramienta que el agente de guardia pueda invocar durante respuesta a incidentes.

Si principalmente trabajas en TypeScript, [el mismo patrón en TypeScript que envuelve un CLI](/es/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) cubre el lado Node.js con `@modelcontextprotocol/sdk` 1.29. En el lado .NET, [el cableado de Microsoft de MCP para servidores Model Context Protocol desde C# en .NET 10](/2026/01/microsoft-mcp-wiring-model-context-protocol-servers-from-c-on-net-10/) muestra el equivalente C#. Para hacerte una idea de cómo se ve MCP cuando un IDE empaqueta servidores nativamente, [el Azure MCP Server dentro de Visual Studio 2022 17.14.30](/es/2026/04/azure-mcp-server-visual-studio-2022-17-14-30/) es una referencia útil del mundo real. Y si miras más allá del MCP crudo hacia orquestación multi-agente, [Microsoft Agent Framework 1.0](/es/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) es el SDK que recoge donde MCP termina.

Al servidor MCP en sí no le importa si tu herramienta envuelve una base de datos, un cliente REST o un pipeline de pandas de 200 líneas. Solo necesita un esquema de entrada tipado (Pydantic te da eso gratis), un valor de retorno que el SDK pueda serializar y un transporte que no tenga bytes perdidos.

## Enlaces de fuente

- [MCP Python SDK -- modelcontextprotocol/python-sdk](https://github.com/modelcontextprotocol/python-sdk)
- [mcp 1.27.0 en PyPI](https://pypi.org/project/mcp/)
- [Guía oficial de build-server de MCP](https://modelcontextprotocol.io/docs/develop/build-server)
- [Spec MCP (2025-03-26)](https://modelcontextprotocol.io/specification/2025-03-26)
- [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
