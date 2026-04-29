---
title: "公式 SDK を使って Python でカスタム MCP サーバーを構築する方法"
description: "公式の mcp 1.27 SDK と FastMCP を使って Python で動作する Model Context Protocol サーバーを構築します。Pydantic スキーマ、stdio の stdout 落とし穴、mcp dev / mcp install、Claude Desktop と Claude Code への登録までカバーします。"
pubDate: 2026-04-25
tags:
  - "mcp"
  - "ai-agents"
  - "python"
  - "claude-code"
lang: "ja"
translationOf: "2026/04/how-to-build-a-custom-mcp-server-in-python-with-the-official-sdk"
translatedBy: "claude"
translationDate: 2026-04-29
---

Python のエコシステムには「自分のエージェントに使わせたいもの」のカタログが最も深く揃っています。SQLAlchemy ORM、pandas の DataFrame、scikit-learn のパイプライン、AWS の boto3 クライアント、データ チームがすでに書いた内製スクリプトなど。これらを Model Context Protocol サーバーとしてラップするには、公式 SDK で 30 行で済みます。結果は Claude Desktop、Claude Code、Cursor、そして MCP 仕様を話すあらゆるクライアントから呼び出し可能です。

本ガイドは、Python 3.10 以上の上で `mcp` 1.27.0 SDK (2026 年 4 月リリース) を用い、高水準 API として `FastMCP` を使って、実際に動く Python の MCP サーバーを構築します。最後には、SQLite データベースをエージェントに 3 つのツールで公開する `db-mcp` サーバーが手に入ります。きちんとした Pydantic スキーマ、エラー処理、そしてドキュメントが軽く触れるだけで毎日使うことになる 2 つのデバッグ コマンド (`mcp dev` と `mcp install`) 付きです。

## こうしたサーバーで Python が正解になる理由

TypeScript SDK は問題ありません。C# SDK も問題ありません。しかし公開したいシステムが既に Python スクリプト、FastAPI アプリ、ノートブックのエクスポートなのであれば、別言語に書き直して MCP をネジ止めするのは無駄な作業です。Python SDK なら既存関数の上に `@mcp.tool()` を載せて出荷できます。

Python が決定的に勝つ具体的なケースは 2 つ:

- **データ ツーリング。** pandas、NumPy、DuckDB、Polars、SQL ORM が絡むものは Python ではデコレーター 1 つの変更です。同じことを TypeScript でやるなら、データ層を再実装するか、外部プロセスを起動することになります。
- **ML / LLM のグルー コード。** ツール自体が LLM を呼ぶ場合 (RAG リトリーバー、リランカー、小さな分類器) には、ライブラリは既に Python にあります。MCP ツールとしてラップすれば、コール グラフを 1 プロセスに保てます。

公式 SDK は [modelcontextprotocol/python-sdk](https://github.com/modelcontextprotocol/python-sdk) にあります。**FastMCP 1.0 は 2024 年末にこの公式 SDK にマージされている** 点に注意してください。PyPI には別途、サードパーティの `fastmcp` パッケージ (現時点で 3.x) が存在しますが、これは別プロジェクトです。新規コードでは公式の `mcp` パッケージを優先し、`mcp.server.fastmcp` から `FastMCP` をインポートしてください。両者を混ぜると、微妙なインポート エラーやバージョンずれにつながります。

## uv を使ったプロジェクト セットアップ

Python 3.10 以上が必要です。1.27 SDK は 3.10 から 3.13 までをサポートします。SDK のドキュメントが推奨するパッケージ マネージャーは `uv` です。`mcp install` と `mcp dev` コマンドの土台になっているからですが、インストール ステップ自体は `pip` でも動きます。

```bash
# Python 3.10+, uv 0.5+
mkdir db-mcp
cd db-mcp
uv init
uv add "mcp[cli]"
```

`[cli]` エキストラが、`mcp dev` と `mcp install` を提供する `mcp` コマンド ライン ツールを引き入れます。これがないとサーバー自体は実行できますが、インスペクターと Claude Desktop の登録コマンドは存在しません。

ソース ファイルを作成します:

```bash
mkdir src
touch src/server.py
```

例にクエリするデータがあるよう、SQLite シード スクリプト (`seed.py`) を追加します。これはデモのためだけのもので、サーバーの一部ではありません:

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

`python seed.py` を一度実行します。MCP サーバーはこのファイルを読み取り専用で読みます。

## すべての Python stdio サーバーを壊す stdout の落とし穴

ツール ハンドラーを 1 行書く前に、これを叩き込んでください: **stdio MCP サーバーでは絶対に stdout に出力しないこと**。

stdio MCP サーバーが起動すると、クライアント (Claude Desktop、Claude Code、Cursor) は `stdin` と `stdout` を通じて、行区切りの JSON-RPC でやり取りします。stdout に書いた、有効な JSON-RPC メッセージでないバイトはストリームを破壊します。クライアントは「MCP server disconnected」や「failed to parse response」といった一般的なエラーを記録して諦めます。

Python では犯人は、見方さえ知っていれば明白です:

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

これが TypeScript の作者より Python の作者を多く捕まえる理由は、`print()` が Python のデフォルトのデバッグ手段だからです。ツール ハンドラー内に紛れ込んでもローカルでは何もクラッシュしません。MCP クライアントがレスポンスをパースしようとして JSON の前にゴミを見つけたときに初めて失敗が見えます。普段 `print()` を書く場所すべてに `file=sys.stderr` を加え、構造化されたものには `logging` を使ってください。

## FastMCP による最小サーバー

`src/server.py` を開きます。配線が動くことを確認するため、ツール 1 つのサーバーから始めます:

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

これが動くサーバーに必要な面のすべてです。デコレーターは型ヒント (ここでは無し) から入力スキーマを、docstring から説明を推論します。`mcp.run(transport="stdio")` はプロセスをブロックし、クライアントが切断するまで stdin から JSON-RPC メッセージを読みます。

クライアントの設定なしでテストするには、インスペクターを起動します:

```bash
uv run mcp dev src/server.py
```

`mcp dev` はサーバーを起動し、localhost で [MCP Inspector](https://github.com/modelcontextprotocol/inspector) UI を開き、生の JSON-RPC トラフィックを表示します。`ping` を呼んでレスポンスを確認し、ストリームを破壊する余分な出力がないことを確かめられます。これは SDK の中で最も有用な単一コマンドで、ドキュメントはサブページに埋もれさせています。

## Pydantic スキーマによる本物のツール

`ping` プレースホルダーを、Pydantic モデルに支えられた 3 つの実用的なツールに置き換えます。SDK は Pydantic を入力検証と構造化出力の両方に使うので、JSON Schema を手書きしなくてもツール スキーマが堅牢になります:

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

重要な細部:

- **デフォルト値だけより `Annotated[T, Field(...)]`。** SDK は `Field(description=...)` で、エージェントがどのツールを呼ぶか決めるときに見る JSON Schema の説明を埋めます。「SKU」のような曖昧な説明は任意の文字列と混同されますが、「Stock-keeping unit, e.g. SKU-001」はエージェントを正しいフォーマットに固定します。
- **戻り値の型としての Pydantic モデル。** `list[Product]` と `StockUpdate` は自動で構造化出力に変換されます。クライアントは JSON ドキュメントと人間可読のテキスト レンダリングの両方を受け取り、下流のエージェントは型付きフィールドについて直接推論できます。素の `dict` を返した場合、SDK は依然シリアライズしますが、エージェントはスキーマと型保証を失います。
- **ツール レベルのエラーには `raise ValueError`。** FastMCP が例外を捕えてクライアントにツール エラーとして返し、エージェントはそれを見て反応できます。一般的なケースで `CallToolResult` オブジェクトを手で構築する必要はありません。手動の `CallToolResult` 構築は、`isError` のようなフィールドを追加メタデータと一緒にセットしたい場合に取っておきます。
- **パラメータ化 SQL のみ。** プレースホルダー `?`、f 文字列は決して使わない。上流のプロンプトでユーザー入力にツールがさらされていれば、LLM は喜んで `'; DROP TABLE products; --` のような SKU を渡してきます。`sqlite3` はパラメータ化版を実行されるコードではなくリテラル文字列として扱います。

## Claude Desktop への接続

道は 2 つあります。シンプルな方は SDK 自身の `mcp install` コマンドを使います:

```bash
uv run mcp install src/server.py --name "Inventory DB"
```

これは Claude Desktop の設定をパッチして、作業ディレクトリも含めた正しい `uv run` 呼び出しでサーバーを指すようにしてくれます。環境変数が必要な場合 (API キー、データベース URL、何らかの秘密情報) は `-v` で渡します:

```bash
uv run mcp install src/server.py --name "Inventory DB" \
  -v DB_URL=postgres://... -v API_KEY=abc123
```

設定を手で管理したい場合は `claude_desktop_config.json` を編集します。macOS では `~/Library/Application Support/Claude/claude_desktop_config.json`、Windows では `%AppData%\Claude\claude_desktop_config.json` にあります:

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

Claude Desktop を再起動します。MCP インジケーターに `list_products`、`get_product`、`adjust_stock` が並ぶはずです。「在庫の少ない商品は?」と尋ねれば、Claude が `list_products(low_stock=True)` を呼ぶのが見えます。

Claude Code に接続するには、プロジェクト ディレクトリから:

```bash
claude mcp add inventory-db -- uv run python src/server.py
```

または同じ `mcpServers` ブロックをプロジェクト ルート配下の `.claude/settings.json` に追加します。

## 本番運用 Python サーバーの落とし穴

**必要なときに非同期ツール。** 上記のハンドラーは同期です。FastMCP は `async def` ハンドラーも受け入れ、ツールがリモート API (httpx) や別の LLM を呼ぶ場合の正解です。同期と非同期の混在は問題ありません。実際にブロックしない限り、同期ライブラリを `asyncio.to_thread` で包む必要はありません。

**作業ディレクトリの驚き。** Claude Desktop がサーバーを起動すると、プロセスの作業ディレクトリは Claude Desktop が起動した場所であって、あなたのプロジェクトではありません。ファイル パスは `Path(__file__).parent` で固定 (例のように) するか、ツール引数として絶対パスを渡してください。`os.getcwd()` を頼ると、ユーザーが別のチャット セッションを開いた瞬間に壊れます。

**仮想環境の隔離。** Claude Desktop の設定が素の `python` を呼び出すと、システム PATH 上の Python を使い、プロジェクトの `.venv` ではありません。`uv run python ...` の形式がこれを解決します。`uv` は `pyproject.toml` からプロジェクトの環境を解決し、毎回正しいインタプリタを起動します。`python3` を直接指す自作の設定は、依存関係を最初に追加した瞬間に失敗します。

**大きなクエリ結果。** Pydantic モデル 100 万行のリストとして返すとクライアントのコンテンツ サイズ上限を超えてストールします。明示的な `limit` と `offset` パラメータでページングするか、ツール内で要約 (count、集計) してエージェントにフォローアップを任せてください。MCP 仕様にハードな上限はありませんが、現実のクライアント上限は数百 KB 程度の構造化コンテンツです。

**並行性。** SQLite は既定で書き込みを直列化します。2 つのツール呼び出しが同時に `adjust_stock` を発火し、片方が 5 秒の `timeout` を超えて書き込みロックを保持すると、もう片方は `OperationalError: database is locked` を投げます。実ワークロードでは PostgreSQL に切り替えるか、コネクション プールを使ってください。ローカル エージェント デモなら `_connect()` の 5 秒タイムアウトで十分です。

**Streaming HTTP トランスポート。** SDK はリモート デプロイ向けに `transport="streamable-http"` と古い `transport="sse"` をサポートします。クライアントごとに起動するのではなく長寿命サービスとしてサーバーを動かす予定なら、ここでトランスポートを切り替え、サーバーをリバース プロキシの背後に置きます。ローカルなエージェント作業では stdio が正解です。

## このパターンが解き放つもの

中心となる動き -- 関数を装飾し、Pydantic モデルを返し、エラーで投げる -- は、チームが既に持つすべての Python 統合にスケールします。簡単な次の手をいくつか:

- SQLAlchemy セッションをラップし、スキーマ イントロスペクションとパラメータ化された `query` ツールを公開すれば、エージェントは「先週何件出荷したか」をあなたが SQL を書かずに答えられます。
- すでにデプロイしている内製 LLM パイプライン (RAG リトリーバー、分類器) をラップし、再実装する代わりに他のエージェントからツールとして呼べるようにする。
- データ チームが使うノートブック型のスクリプト (CSV 読み込み、モデル実行、レポート出力) をラップして、インシデント対応中にオンコール エージェントが呼べるツールにする。

主に TypeScript で作業しているなら、[CLI をラップする TypeScript の同じパターン](/ja/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) が `@modelcontextprotocol/sdk` 1.29 で Node.js 側をカバーします。.NET 側では、[.NET 10 上の C# から Microsoft の MCP 配線で Model Context Protocol サーバーを動かす](/2026/01/microsoft-mcp-wiring-model-context-protocol-servers-from-c-on-net-10/) が C# 等価物を示します。IDE が MCP サーバーをネイティブに同梱するときの感触をつかむには、[Visual Studio 2022 17.14.30 内の Azure MCP サーバー](/ja/2026/04/azure-mcp-server-visual-studio-2022-17-14-30/) が現実的な参照点として有用です。さらに、生の MCP の先 -- マルチエージェント オーケストレーション -- を見ているなら、[Microsoft Agent Framework 1.0](/ja/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) が MCP の止まったところを引き継ぐ SDK です。

MCP サーバー自体は、ツールがデータベースをラップするか、REST クライアントをラップするか、200 行の pandas パイプラインをラップするかを気にしません。型付き入力スキーマ (Pydantic が無料で提供) と、SDK がシリアライズできる戻り値、そして余分なバイトの混じらないトランスポートだけが必要です。

## ソース リンク

- [MCP Python SDK -- modelcontextprotocol/python-sdk](https://github.com/modelcontextprotocol/python-sdk)
- [PyPI 上の mcp 1.27.0](https://pypi.org/project/mcp/)
- [公式の MCP build-server ガイド](https://modelcontextprotocol.io/docs/develop/build-server)
- [MCP 仕様 (2025-03-26)](https://modelcontextprotocol.io/specification/2025-03-26)
- [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
