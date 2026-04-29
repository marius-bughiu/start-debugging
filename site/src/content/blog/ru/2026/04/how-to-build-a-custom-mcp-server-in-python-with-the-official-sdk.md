---
title: "Как построить собственный MCP-сервер на Python с официальным SDK"
description: "Постройте рабочий сервер Model Context Protocol на Python, используя официальный SDK mcp 1.27 и FastMCP. Рассмотрены схемы Pydantic, ловушка stdout в stdio, mcp dev / mcp install и регистрация в Claude Desktop и Claude Code."
pubDate: 2026-04-25
tags:
  - "mcp"
  - "ai-agents"
  - "python"
  - "claude-code"
lang: "ru"
translationOf: "2026/04/how-to-build-a-custom-mcp-server-in-python-with-the-official-sdk"
translatedBy: "claude"
translationDate: 2026-04-29
---

В экосистеме Python самый глубокий каталог "вещей, которые я хочу, чтобы агент использовал": ORM SQLAlchemy, dataframe pandas, конвейеры scikit-learn, AWS-клиенты boto3, внутренние скрипты, которые ваша команда данных уже написала. Обернуть любое из этого в сервер Model Context Protocol -- это 30 строк с официальным SDK, и результат вызываем из Claude Desktop, Claude Code, Cursor и любого клиента, говорящего на спецификации MCP.

Это руководство строит реальный, запускаемый MCP-сервер на Python с использованием SDK `mcp` 1.27.0 (выпущен в апреле 2026) на Python 3.10+, c `FastMCP` в качестве высокоуровневого API. К концу у вас будет сервер `db-mcp`, выставляющий агенту базу SQLite через три инструмента, с правильными схемами Pydantic, обработкой ошибок и двумя командами отладки (`mcp dev` и `mcp install`), которые документация лишь бегло упоминает, но которые вы будете использовать ежедневно.

## Почему Python -- правильный выбор для такого сервера

TypeScript SDK -- нормальный. C# SDK -- нормальный. Но если система, которую вы хотите выставить, уже является скриптом Python, приложением FastAPI или экспортом ноутбука, переписывать её на другой язык, чтобы прикрутить MCP, -- пустая трата времени. Python SDK позволяет поставить `@mcp.tool()` поверх существующей функции и отгружать.

Два конкретных случая, в которых Python побеждает решительно:

- **Инструменты для работы с данными.** Что угодно, связанное с pandas, NumPy, DuckDB, Polars или SQL ORM, -- в Python это изменение в один декоратор. Сделать то же на TypeScript -- значит переписать слой данных или вызвать подпроцесс.
- **Связующий код для ML / LLM.** Если сам инструмент вызывает LLM (RAG-ретривер, реранкер, маленький классификатор), библиотеки уже живут в Python. Оборачивание их как MCP-инструментов держит граф вызовов в одном процессе.

Официальный SDK находится по адресу [modelcontextprotocol/python-sdk](https://github.com/modelcontextprotocol/python-sdk). Обратите внимание, что **FastMCP 1.0 был объединён с этим официальным SDK в конце 2024**. Также существует отдельный сторонний пакет `fastmcp` на PyPI (сейчас 3.x), это другой проект. Для нового кода предпочитайте официальный пакет `mcp` и импортируйте `FastMCP` из `mcp.server.fastmcp`. Смешивание двух ведёт к тонким ошибкам импорта и расхождению версий.

## Настройка проекта с uv

Вам нужен Python 3.10 или выше. SDK 1.27 поддерживает 3.10--3.13. Рекомендованный в документации SDK менеджер пакетов -- `uv`, потому что он питает команды `mcp install` и `mcp dev`, но `pip` сработает для шага установки сам по себе.

```bash
# Python 3.10+, uv 0.5+
mkdir db-mcp
cd db-mcp
uv init
uv add "mcp[cli]"
```

Дополнение `[cli]` подтягивает командную утилиту `mcp`, которая даёт `mcp dev` и `mcp install`. Без него сервер запустить ещё можно, но инспектор и команды регистрации Claude Desktop существовать не будут.

Создайте исходный файл:

```bash
mkdir src
touch src/server.py
```

Добавьте сид-скрипт SQLite (`seed.py`), чтобы у примера были данные для запросов. Это только для демо, не часть сервера:

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

Запустите `python seed.py` один раз. MCP-сервер будет читать этот файл в режиме только для чтения.

## Ловушка stdout, ломающая каждый stdio-сервер на Python

Прежде чем писать хоть один обработчик инструмента, усвойте: **никогда не выводите в stdout в stdio MCP-сервере**.

Когда stdio MCP-сервер стартует, клиент (Claude Desktop, Claude Code, Cursor) общается с ним по `stdin` и `stdout` через JSON-RPC, разделённый строками. Любой байт, который вы пишете в stdout и который не является валидным JSON-RPC-сообщением, портит поток. Клиент логирует общую ошибку "MCP server disconnected" или "failed to parse response" и сдаётся.

В Python виновники очевидны, как только знаешь, что искать:

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

Причина, по которой это ловит авторов на Python чаще, чем авторов на TypeScript: `print()` -- стандартный инструмент отладки в Python, и случайный вызов внутри обработчика инструмента ничего локально не ломает. Вы видите сбой, только когда MCP-клиент пытается распарсить ответ и находит мусор перед JSON. Добавляйте `file=sys.stderr` везде, где обычно бы написали `print()`, и используйте `logging` для всего структурированного.

## Минимальный сервер на FastMCP

Откройте `src/server.py`. Начните с однопровайдерного сервера, чтобы убедиться, что обвязка работает:

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

Это вся требуемая поверхность для рабочего сервера. Декоратор выводит входную схему из подсказок типов (здесь их нет) и описание из docstring. `mcp.run(transport="stdio")` блокирует процесс и читает JSON-RPC-сообщения из stdin, пока клиент не отключится.

Тестируйте без настройки клиента, запустив инспектор:

```bash
uv run mcp dev src/server.py
```

`mcp dev` запускает сервер, подключает UI [MCP Inspector](https://github.com/modelcontextprotocol/inspector) на localhost и показывает сырой JSON-RPC-трафик. Можно вызвать `ping`, увидеть ответ и убедиться, что нет случайного вывода, портящего поток. Это самая полезная команда в SDK, и документация прячет её на подстранице.

## Реальные инструменты со схемами Pydantic

Замените заглушку `ping` тремя полезными инструментами на основе моделей Pydantic. SDK использует Pydantic как для валидации входа, так и для структурированного вывода, что делает схемы инструментов надёжными без рукописного JSON Schema:

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

Несколько важных деталей:

- **`Annotated[T, Field(...)]` вместо обычных значений по умолчанию.** SDK использует `Field(description=...)`, чтобы заполнить описание в JSON Schema, которое агент видит, решая, какой инструмент вызвать. Размытое описание вроде "SKU" путается с произвольными строками; "Stock-keeping unit, e.g. SKU-001" якорит агента к нужному формату.
- **Модели Pydantic как типы возвращаемых значений.** `list[Product]` и `StockUpdate` автоматически конвертируются в структурированный вывод. Клиент получает и JSON-документ, и читаемое человеком текстовое представление, а нижестоящий агент может рассуждать прямо по типизированным полям. Вернёте обычный `dict` -- SDK всё ещё сериализует его, но агент потеряет схему и любые гарантии типов.
- **`raise ValueError` для ошибок на уровне инструмента.** FastMCP перехватывает исключение и возвращает его клиенту как ошибку инструмента, на которую агент может реагировать. Конструировать объекты `CallToolResult` вручную для обычного случая не нужно. Оставляйте ручное построение `CallToolResult` для случаев, когда нужно установить поля вроде `isError` вместе с дополнительной метаинформацией.
- **Только параметризованный SQL.** Плейсхолдеры `?`, никогда не f-строки. LLM с радостью передаст SKU вроде `'; DROP TABLE products; --`, если инструмент выставлен на пользовательский ввод выше по потоку, и `sqlite3` обработает параметризованную версию как литеральную строку, а не как код.

## Подключение к Claude Desktop

Есть два пути. Простой -- использовать собственную команду SDK `mcp install`:

```bash
uv run mcp install src/server.py --name "Inventory DB"
```

Это пропатчит конфиг Claude Desktop за вас и направит его на сервер с правильным вызовом `uv run`, включая рабочую директорию. Если нужны переменные окружения (ключ API, URL базы, любой секрет), передайте их через `-v`:

```bash
uv run mcp install src/server.py --name "Inventory DB" \
  -v DB_URL=postgres://... -v API_KEY=abc123
```

Если предпочитаете править конфиг руками, отредактируйте `claude_desktop_config.json`. На macOS он живёт по адресу `~/Library/Application Support/Claude/claude_desktop_config.json`; на Windows -- `%AppData%\Claude\claude_desktop_config.json`:

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

Перезапустите Claude Desktop. Индикатор MCP должен показать `list_products`, `get_product` и `adjust_stock`. Спросите: "Каких товаров мало на складе?" и наблюдайте, как Claude вызывает `list_products(low_stock=True)`.

Чтобы подключить к Claude Code, выполните в каталоге проекта:

```bash
claude mcp add inventory-db -- uv run python src/server.py
```

Или добавьте тот же блок `mcpServers` в `.claude/settings.json` в корне проекта.

## Подводные камни в продакшен Python-серверах

**Асинхронные инструменты, когда они нужны.** Обработчики выше синхронные. FastMCP также принимает обработчики `async def`, и это правильный выбор, когда инструмент вызывает удалённый API (httpx) или другой LLM. Смешивать sync и async можно: не оборачивайте синхронную библиотеку в `asyncio.to_thread`, если она реально не блокирует.

**Сюрпризы рабочей директории.** Когда Claude Desktop запускает сервер, рабочая директория процесса -- та, откуда Claude Desktop его запустил, а не ваш проект. Привязывайте пути к файлам через `Path(__file__).parent` (как в примере) или передавайте абсолютные пути через аргументы инструментов. Опора на `os.getcwd()` сломается в момент, когда пользователь откроет другую сессию чата.

**Изоляция виртуального окружения.** Если конфиг Claude Desktop вызывает голый `python`, он использует тот Python, что лежит в системном PATH, а не `.venv` вашего проекта. Форма `uv run python ...` решает это: `uv` разрешает окружение проекта из `pyproject.toml` и каждый раз запускает нужный интерпретатор. Самописные конфиги, указывающие на `python3` напрямую, упадут при первом же добавлении зависимости.

**Большие результаты запросов.** Возврат миллиона строк как списка моделей Pydantic упрётся в лимит размера контента клиента и подвиснет. Либо постранично с явными параметрами `limit` и `offset`, либо суммируйте (count, агрегат) в инструменте и дайте агенту задать дальнейшие вопросы. Спецификация MCP не задаёт жёсткого потолка, но практические клиентские лимиты лежат в районе нескольких сотен КБ структурированного контента.

**Параллельность.** SQLite по умолчанию сериализует записи. Если два вызова инструмента одновременно выполняют `adjust_stock` и один держит блокировку записи дольше 5-секундного `timeout`, второй выбросит `OperationalError: database is locked`. Для реальной нагрузки переходите на PostgreSQL или используйте пул соединений. Для локальных демо с агентом 5-секундного таймаута в `_connect()` достаточно.

**Streaming HTTP-транспорт.** SDK поддерживает `transport="streamable-http"` и более старый `transport="sse"` для удалённых развёртываний. Если планируете запускать сервер как долгоживущий сервис вместо порождения на клиента, переключите транспорт здесь и поставьте сервер за обратным прокси. Для локальной работы с агентом stdio корректен.

## Что открывает этот паттерн

Главный приём -- декорировать функцию, вернуть модель Pydantic, бросать исключение при ошибках -- масштабируется на любую интеграцию Python, что у вашей команды уже есть. Несколько простых следующих шагов:

- Оберните сессию SQLAlchemy и выставьте интроспекцию схемы плюс параметризованный инструмент `query`, чтобы агент мог отвечать на "сколько заказов отгрузили на прошлой неделе" без того, чтобы вы писали SQL.
- Оберните внутренний LLM-конвейер, который вы уже разворачиваете (RAG-ретриверы, классификаторы), и позвольте другим агентам вызывать его как инструмент вместо переписывания.
- Оберните скрипт в форме ноутбука, которым пользуется команда данных (загрузить CSV, прогнать модель, выгрузить отчёт), в инструмент, который дежурный агент сможет вызвать в ходе ответа на инцидент.

Если вы в основном работаете на TypeScript, [тот же паттерн на TypeScript, оборачивающий CLI](/ru/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) покрывает сторону Node.js с `@modelcontextprotocol/sdk` 1.29. На стороне .NET [обвязка MCP от Microsoft для серверов Model Context Protocol на C# в .NET 10](/2026/01/microsoft-mcp-wiring-model-context-protocol-servers-from-c-on-net-10/) показывает эквивалент на C#. Чтобы понять, как выглядит MCP, когда IDE упаковывает серверы нативно, [Azure MCP Server в Visual Studio 2022 17.14.30](/ru/2026/04/azure-mcp-server-visual-studio-2022-17-14-30/) -- полезный реальный ориентир. А если смотрите за пределы голого MCP -- на мульти-агентную оркестрацию, [Microsoft Agent Framework 1.0](/ru/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) -- это SDK, подхватывающий там, где MCP останавливается.

Самому MCP-серверу всё равно, оборачивает ли ваш инструмент базу данных, REST-клиент или 200-строчный конвейер pandas. Ему нужны лишь типизированная входная схема (Pydantic даёт это бесплатно), значение возврата, которое SDK может сериализовать, и транспорт без заблудших байтов.

## Ссылки на источники

- [MCP Python SDK -- modelcontextprotocol/python-sdk](https://github.com/modelcontextprotocol/python-sdk)
- [mcp 1.27.0 на PyPI](https://pypi.org/project/mcp/)
- [Официальное руководство build-server MCP](https://modelcontextprotocol.io/docs/develop/build-server)
- [Спецификация MCP (2025-03-26)](https://modelcontextprotocol.io/specification/2025-03-26)
- [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
