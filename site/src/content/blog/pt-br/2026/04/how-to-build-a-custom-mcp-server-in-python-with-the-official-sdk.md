---
title: "Como construir um servidor MCP customizado em Python com o SDK oficial"
description: "Construa um servidor Model Context Protocol funcional em Python usando o SDK oficial mcp 1.27 e FastMCP. Cobre esquemas Pydantic, a armadilha do stdout em stdio, mcp dev / mcp install e o registro com Claude Desktop e Claude Code."
pubDate: 2026-04-25
tags:
  - "mcp"
  - "ai-agents"
  - "python"
  - "claude-code"
lang: "pt-br"
translationOf: "2026/04/how-to-build-a-custom-mcp-server-in-python-with-the-official-sdk"
translatedBy: "claude"
translationDate: 2026-04-29
---

O ecossistema Python tem o catálogo mais profundo de "coisa que eu quero que meu agente use": ORMs SQLAlchemy, dataframes pandas, pipelines scikit-learn, clientes boto3 da AWS, scripts internos que seu time de dados já escreveu. Envolver qualquer coisa disso como um servidor Model Context Protocol leva 30 linhas com o SDK oficial, e o resultado é chamável a partir do Claude Desktop, Claude Code, Cursor e qualquer cliente que fale a spec MCP.

Este guia constrói um servidor MCP em Python real e executável usando o SDK `mcp` 1.27.0 (lançado em abril de 2026) sobre Python 3.10+, com `FastMCP` como a API de alto nível. No final você terá um servidor `db-mcp` que expõe um banco SQLite a um agente por meio de três ferramentas, com esquemas Pydantic adequados, tratamento de erros e os dois comandos de depuração (`mcp dev` e `mcp install`) que a documentação passa por cima mas que você usará todos os dias.

## Por que Python é a escolha certa para esse tipo de servidor

O SDK em TypeScript está bem. O SDK em C# está bem. Mas se o sistema que você quer expor já é um script Python, um app FastAPI ou a exportação de um notebook, reescrever em outra linguagem só para parafusar MCP nele é trabalho desperdiçado. O SDK em Python permite colocar `@mcp.tool()` em cima de uma função existente e enviar.

Dois casos específicos onde Python ganha decisivamente:

- **Tooling de dados.** Qualquer coisa envolvendo pandas, NumPy, DuckDB, Polars ou um ORM SQL é uma mudança de um decorador em Python. Fazer o mesmo em TypeScript significa reimplementar a camada de dados ou abrir um subprocesso.
- **Código de cola para ML / LLM.** Se a ferramenta em si chama um LLM (um retriever de RAG, um re-ranker, um classificador pequeno), as bibliotecas já vivem em Python. Envolvê-las como ferramentas MCP mantém o grafo de chamadas em um único processo.

O SDK oficial está em [modelcontextprotocol/python-sdk](https://github.com/modelcontextprotocol/python-sdk). Note que **FastMCP 1.0 foi mesclado a este SDK oficial no fim de 2024**. Existe também um pacote `fastmcp` separado de terceiros no PyPI (atualmente 3.x) que é um projeto diferente. Para código novo, prefira o pacote oficial `mcp` e importe `FastMCP` de `mcp.server.fastmcp`. Misturar os dois leva a erros sutis de import e drift de versões.

## Configuração do projeto com uv

Você precisa de Python 3.10 ou superior. O SDK 1.27 suporta de 3.10 a 3.13. O gerenciador de pacotes recomendado na documentação do SDK é `uv` porque ele alimenta os comandos `mcp install` e `mcp dev`, mas `pip` funciona para a etapa de instalação em si.

```bash
# Python 3.10+, uv 0.5+
mkdir db-mcp
cd db-mcp
uv init
uv add "mcp[cli]"
```

O extra `[cli]` puxa a ferramenta de linha de comando `mcp` que te dá `mcp dev` e `mcp install`. Sem ele, você ainda consegue rodar o servidor, mas o inspector e os comandos de registro do Claude Desktop não existirão.

Crie o arquivo fonte:

```bash
mkdir src
touch src/server.py
```

Adicione um script de seed para SQLite (`seed.py`) para que o exemplo tenha dados a consultar. Isso é só para a demo, não faz parte do servidor:

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

Rode `python seed.py` uma vez. O servidor MCP lerá esse arquivo em modo somente leitura.

## A armadilha do stdout que quebra todo servidor stdio em Python

Antes de escrever um único handler de ferramenta, internalize isso: **nunca dê print no stdout em um servidor MCP stdio**.

Quando um servidor MCP stdio inicia, o cliente (Claude Desktop, Claude Code, Cursor) se comunica com ele por `stdin` e `stdout` usando JSON-RPC delimitado por linha. Qualquer byte que você escreva em stdout que não seja uma mensagem JSON-RPC válida corrompe o fluxo. O cliente registra um erro genérico "MCP server disconnected" ou "failed to parse response" e desiste.

Em Python, os culpados são óbvios uma vez que você sabe procurá-los:

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

A razão de isso pegar autores Python com mais frequência do que autores TypeScript: `print()` é o instrumento de depuração padrão em Python, e um `print` perdido dentro de um handler de ferramenta não quebra nada localmente. Você só vê a falha quando o cliente MCP tenta parsear a resposta e encontra lixo na frente do JSON. Adicione `file=sys.stderr` em todos os lugares onde normalmente daria `print()`, e use `logging` para qualquer coisa estruturada.

## O servidor mínimo com FastMCP

Abra `src/server.py`. Comece com um servidor de uma única ferramenta para confirmar que o cabeamento funciona:

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

Essa é toda a superfície necessária para um servidor funcional. O decorator infere o esquema de entrada das type hints (nenhuma aqui) e a descrição da docstring. `mcp.run(transport="stdio")` bloqueia o processo e lê mensagens JSON-RPC do stdin até o cliente desconectar.

Teste sem configurar nenhum cliente rodando o inspector:

```bash
uv run mcp dev src/server.py
```

`mcp dev` sobe o servidor, conecta a UI do [MCP Inspector](https://github.com/modelcontextprotocol/inspector) no localhost e mostra o tráfego JSON-RPC bruto. Você pode chamar `ping`, ver a resposta e confirmar que não há saída perdida corrompendo o fluxo. Esse é o único comando mais útil do SDK e a documentação o esconde em uma subpágina.

## Ferramentas reais com esquemas Pydantic

Substitua o placeholder `ping` por três ferramentas úteis apoiadas por modelos Pydantic. O SDK usa Pydantic tanto para validação de entrada quanto para saída estruturada, o que torna os esquemas das ferramentas robustos sem escrever JSON Schema à mão:

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

Alguns detalhes que importam:

- **`Annotated[T, Field(...)]` em vez de defaults simples.** O SDK usa `Field(description=...)` para popular a descrição do JSON Schema que o agente vê ao decidir qual ferramenta chamar. Uma descrição vaga como "o SKU" é confundida com strings arbitrárias; "Stock-keeping unit, e.g. SKU-001" ancora o agente ao formato certo.
- **Modelos Pydantic como tipos de retorno.** `list[Product]` e `StockUpdate` são convertidos em saída estruturada automaticamente. O cliente recebe tanto um documento JSON quanto uma renderização de texto legível por humanos, e um agente downstream pode raciocinar diretamente sobre os campos tipados. Se você retornasse um `dict` simples, o SDK ainda serializaria, mas o agente perderia o esquema e qualquer garantia de tipo.
- **`raise ValueError` para erros no nível da ferramenta.** O FastMCP captura a exceção e a devolve como erro de ferramenta ao cliente, ao qual o agente pode reagir. Você não precisa construir objetos `CallToolResult` à mão para o caso comum. Reserve a construção manual de `CallToolResult` para casos onde precisa setar campos como `isError` junto com metadata extra.
- **Apenas SQL parametrizado.** Placeholders `?`, nunca f-strings. Um LLM vai felizmente passar um SKU como `'; DROP TABLE products; --` se a ferramenta estiver exposta a entrada de usuário a montante, e `sqlite3` tratará a versão parametrizada como uma string literal em vez de executá-la.

## Conectando ao Claude Desktop

Você tem dois caminhos. O simples usa o próprio comando `mcp install` do SDK:

```bash
uv run mcp install src/server.py --name "Inventory DB"
```

Isso patcha a configuração do Claude Desktop para você e a aponta para o servidor com a invocação `uv run` correta, incluindo o working directory. Se precisar de variáveis de ambiente (uma chave de API, uma URL de banco, qualquer segredo), passe-as com `-v`:

```bash
uv run mcp install src/server.py --name "Inventory DB" \
  -v DB_URL=postgres://... -v API_KEY=abc123
```

Se preferir gerenciar a configuração à mão, edite o `claude_desktop_config.json`. No macOS ele fica em `~/Library/Application Support/Claude/claude_desktop_config.json`; no Windows em `%AppData%\Claude\claude_desktop_config.json`:

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

Reinicie o Claude Desktop. O indicador MCP deve listar `list_products`, `get_product` e `adjust_stock`. Pergunte: "Quais produtos estão com estoque baixo?" e veja o Claude chamar `list_products(low_stock=True)`.

Para conectar ao Claude Code, rode a partir do diretório do projeto:

```bash
claude mcp add inventory-db -- uv run python src/server.py
```

Ou adicione o mesmo bloco `mcpServers` ao `.claude/settings.json` na raiz do projeto.

## Pegadinhas em servidores Python em produção

**Ferramentas async quando você precisar.** Os handlers acima são síncronos. O FastMCP também aceita handlers `async def`, que é a escolha certa quando a ferramenta chama uma API remota (httpx) ou outro LLM. Misturar sync e async tudo bem: não envolva uma biblioteca síncrona em `asyncio.to_thread` a menos que ela realmente bloqueie.

**Surpresas com o working directory.** Quando o Claude Desktop sobe o servidor, o working directory do processo é de onde o Claude Desktop o iniciou, não o seu projeto. Ancore os caminhos de arquivo usando `Path(__file__).parent` (como no exemplo) ou passe caminhos absolutos via argumentos da ferramenta. Confiar em `os.getcwd()` quebra no momento em que o usuário abre uma sessão de chat diferente.

**Isolamento do virtual environment.** Se a configuração do Claude Desktop invoca `python` puro, ele usa o Python que estiver no PATH do sistema, não o `.venv` do seu projeto. A forma `uv run python ...` resolve isso: `uv` resolve o ambiente do projeto a partir do `pyproject.toml` e roda o interpretador certo todas as vezes. Configurações feitas na mão que apontam para `python3` direto vão falhar na primeira vez que você adicionar uma dependência.

**Resultados de consulta grandes.** Retornar um milhão de linhas como uma lista de modelos Pydantic vai bater no limite de tamanho de conteúdo do cliente e travar. Ou pagine com parâmetros explícitos `limit` e `offset`, ou resuma (count, agregação) na ferramenta e deixe o agente fazer perguntas seguintes. A spec MCP não impõe um teto rígido, mas os limites práticos de cliente ficam em torno de algumas centenas de KB de conteúdo estruturado.

**Concorrência.** SQLite serializa as escritas por padrão. Se duas chamadas de ferramenta dispararem `adjust_stock` simultaneamente e uma segurar o lock de escrita além do `timeout` de 5 segundos, a outra levanta `OperationalError: database is locked`. Para cargas reais, mude para PostgreSQL ou use um pool de conexões. Para demos locais com agente, o timeout de 5 segundos no `_connect()` é suficiente.

**Transporte HTTP streamable.** O SDK suporta `transport="streamable-http"` e o mais antigo `transport="sse"` para deploys remotos. Se planeja rodar o servidor como um serviço de longa vida em vez de spawn por cliente, troque o transporte aqui e coloque o servidor atrás de um proxy reverso. Para trabalho local com agente, stdio é o correto.

## O que esse padrão destrava

O movimento central -- decorar uma função, retornar um modelo Pydantic, lançar em erros -- escala para toda integração Python que seu time já tem. Alguns próximos passos fáceis:

- Envolva uma sessão SQLAlchemy e exponha introspecção de esquema mais uma ferramenta `query` parametrizada, para que um agente possa responder "quantos pedidos enviaram na semana passada" sem você escrever o SQL.
- Envolva um pipeline LLM interno que você já implanta (retrievers de RAG, classificadores) e deixe outros agentes chamarem como ferramenta em vez de reimplementarem.
- Envolva um script em formato de notebook que o time de dados usa (carrega CSV, roda o modelo, gera o relatório) em uma ferramenta que o agente de plantão possa invocar durante a resposta a incidentes.

Se você principalmente trabalha em TypeScript, [o mesmo padrão em TypeScript que envolve um CLI](/pt-br/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) cobre o lado Node.js com `@modelcontextprotocol/sdk` 1.29. No lado .NET, [o cabeamento MCP da Microsoft para servidores Model Context Protocol em C# no .NET 10](/2026/01/microsoft-mcp-wiring-model-context-protocol-servers-from-c-on-net-10/) mostra o equivalente em C#. Para uma noção de como o MCP fica quando uma IDE empacota servidores nativamente, [o Azure MCP Server dentro do Visual Studio 2022 17.14.30](/pt-br/2026/04/azure-mcp-server-visual-studio-2022-17-14-30/) é uma referência útil do mundo real. E se você está olhando além do MCP cru para orquestração multi-agente, [Microsoft Agent Framework 1.0](/pt-br/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) é o SDK que pega de onde o MCP para.

O servidor MCP em si não se importa se sua ferramenta envolve um banco, um cliente REST ou um pipeline pandas de 200 linhas. Ele só precisa de um esquema de entrada tipado (Pydantic te dá isso de graça), um valor de retorno que o SDK consiga serializar e um transporte sem bytes perdidos.

## Links de origem

- [MCP Python SDK -- modelcontextprotocol/python-sdk](https://github.com/modelcontextprotocol/python-sdk)
- [mcp 1.27.0 no PyPI](https://pypi.org/project/mcp/)
- [Guia oficial de build-server do MCP](https://modelcontextprotocol.io/docs/develop/build-server)
- [Spec MCP (2025-03-26)](https://modelcontextprotocol.io/specification/2025-03-26)
- [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
