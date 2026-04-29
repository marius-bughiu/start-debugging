---
title: "C# と .NET 11 でカスタム MCP サーバーを構築する方法"
description: ".NET 11 / C# 14 と公式 ModelContextProtocol 1.2 SDK を使って動作する Model Context Protocol サーバーを構築します。stdio トランスポート、[McpServerTool] 属性、依存性注入、stderr ログ出力の落とし穴、そして Claude Code、Claude Desktop、VS Code への登録までカバーします。"
pubDate: 2026-04-26
tags:
  - "mcp"
  - "ai-agents"
  - "claude-code"
  - "csharp"
  - "csharp-14"
  - "dotnet"
  - "dotnet-11"
  - "anthropic-sdk"
lang: "ja"
translationOf: "2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11"
translatedBy: "claude"
translationDate: 2026-04-29
---

チームの真実の源が .NET サービスにある場合 -- EF Core データベース、内部 API、Hangfire ジョブ ランナー、Workspace API -- それを [Model Context Protocol](https://modelcontextprotocol.io/) 経由でコーディング エージェントに公開するのは、.NET 界隈のインターネットが普段宣伝しているよりも速いです。公式の C# SDK は 2026 年 3 月 5 日に `1.0` に到達し、3 月 27 日に `1.2.0` を出しました。両方とも Microsoft と Anthropic が共同で保守しています。ボイラープレートは今や十分に小さく、興味深い作業はあなたのツール メソッドにあり、プロトコルの配管にはありません。

本ガイドは、**MCP 仕様 2025-11-25** に対する **`ModelContextProtocol` 1.2.0** パッケージを用いて、**.NET 11 上の C# 14** で実際に動く MCP サーバーを構築します。最後には、SQLite データベースを 3 つのツールでエージェントに公開する `inventory-mcp` サーバーが手に入ります。きちんとした依存性注入、ドキュメントが軽く触れるだけの stderr ログ出力のテクニック、そして Claude Code、Claude Desktop、VS Code の `mcp.json` に対する正確な構成スニペット付きです。

## C# SDK が正解になるとき

Anthropic と MCP のチームは TypeScript、Python、C# の公式 SDK を出荷しています。ワイヤー上のトラフィックは同一なので、問いは「どれが最もよくプロトコルを運ぶか」ではなく「公開したいコードが既にどこに住んでいるか」です。C# が勝つケースは 2 つ:

- **ビジネス ロジックがすでに .NET にある。** EF Core モデル、Microsoft.Identity.Web 認証、Hangfire / Quartz のスケジュール ジョブ、Polly のリトライ ポリシー、Refit 経由で公開した内部 API。これらを Python や Node に再実装してエージェントから呼べるようにするのは、無駄な作業です。C# SDK ならメソッドに `[McpServerTool]` を付けて出荷できます。
- **標準的な .NET ホスティング モデルが欲しい。** `IHostedService`、`IHttpClientFactory`、`IConfiguration`、`Microsoft.Extensions.Logging` 経由の構造化ログ、OpenTelemetry。SDK は `Host.CreateApplicationBuilder` に直接プラグインするので、可観測性と構成は他の ASP.NET Core サービスと同じに見えます。

プロトコル自体の背景は、やや古い [Microsoft `mcp` を .NET 10 で配線する概要](/2026/01/microsoft-mcp-wiring-model-context-protocol-servers-from-c-on-net-10/) が contract-first の考え方をカバーしています。本記事は .NET 11 と 1.0 後の SDK 向けの具体的な how-to アップデートです。

## .NET 11 SDK でのプロジェクト セットアップ

.NET 11 SDK が必要です (`dotnet --version` が `11.0.x` 以上を報告するはず)。`ModelContextProtocol` 1.2.0 パッケージは `net8.0` 以上を対象とするので、`net11.0` はサポートされ、C# 14 の機能も無料で手に入ります。

```bash
# .NET 11 SDK, ModelContextProtocol 1.2.0
dotnet new console -n InventoryMcp
cd InventoryMcp
dotnet add package ModelContextProtocol --version 1.2.0
dotnet add package Microsoft.Extensions.Hosting --version 11.0.0
dotnet add package Microsoft.Data.Sqlite --version 11.0.0
```

パッケージの分割はこうなっていて、選択は重要です:

- **`ModelContextProtocol`** -- メインのサーバー パッケージ。ホスティングと DI の拡張、属性ベースのツール登録を引き入れます。独自の ASP.NET Core HTTP ホストを必要としないプロジェクトはこれを選びます。
- **`ModelContextProtocol.Core`** -- 低レベルのクライアント/サーバー作業やライブラリ コード向けの最小依存。`Microsoft.Extensions.Hosting` は組み込まれていません。
- **`ModelContextProtocol.AspNetCore`** -- リモート デプロイ向けに `WithHttpTransport()` と streamable HTTP サーバー エンドポイントを追加します。

コーディング エージェントから起動する stdio サーバーには最初の 1 つだけで十分です。

.NET 11 用の `.csproj` は最小限になります:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net11.0</TargetFramework>
    <LangVersion>14.0</LangVersion>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <RootNamespace>InventoryMcp</RootNamespace>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="ModelContextProtocol" Version="1.2.0" />
    <PackageReference Include="Microsoft.Extensions.Hosting" Version="11.0.0" />
    <PackageReference Include="Microsoft.Data.Sqlite" Version="11.0.0" />
  </ItemGroup>
</Project>
```

## stdout を壊さない Program.cs

stdio トランスポートはプロセスの stdin/stdout のペア上で JSON-RPC メッセージを運びます。サーバーは stdin でリクエストを読み、stdout でレスポンスを書きます。stdout に触れるそれ以外のもの -- 流れ込んだ `Console.WriteLine`、デフォルト設定の `ILogger` が stdout に出すもの、stderr ではなく stdout に着地した例外スタック トレース -- は JSON ストリームに混入し、クライアントはパース エラーで接続を切ります。

C# SDK のホスティング統合がプロトコルの書き込みを処理しますが、コンソール ロガーを stderr にバインドし直さないと、Claude Code で「MCP server disconnected」アラートを追って人生最初の 30 分を失います:

```csharp
// Program.cs, .NET 11, ModelContextProtocol 1.2.0
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Data.Sqlite;
using InventoryMcp;

var builder = Host.CreateApplicationBuilder(args);

// All log output goes to stderr. Stdout is reserved for MCP traffic.
builder.Logging.AddConsole(o =>
{
    o.LogToStandardErrorThreshold = LogLevel.Trace;
});

builder.Services.AddSingleton<ProductRepository>(_ =>
{
    var dbPath = Environment.GetEnvironmentVariable("INVENTORY_DB_PATH")
                 ?? Path.Combine(AppContext.BaseDirectory, "inventory.db");
    return new ProductRepository($"Data Source={dbPath}");
});

builder.Services
    .AddMcpServer()
    .WithStdioServerTransport()
    .WithToolsFromAssembly();

await builder.Build().RunAsync();
```

押さえておきたい 3 点:

- `LogToStandardErrorThreshold = LogLevel.Trace` はすべてのログ行を stderr に送ります。これがないと、`Microsoft.Extensions.Logging` は Warning 以上を stderr、Information 以下を stdout に書き込み、何かが Info レベルでログを吐いた瞬間にプロトコル ストリームが静かに壊れます。
- `AppContext.BaseDirectory` は SQLite のパスを発行されたバイナリの隣に固定します。エージェント プロセスは好きな作業ディレクトリでサーバーを起動するので、`Environment.CurrentDirectory` を頼らないでください。
- `WithToolsFromAssembly()` はエントリ アセンブリをスキャンして `[McpServerToolType]` のクラスを探し、`[McpServerTool]` の付いたメソッドをすべて登録します。明示的な登録が好みなら `WithTools<EchoTool>().WithTools<MonkeyTools>()` で特定の型を固定することもできます。

## ツールを定義する

各ツールは `[McpServerToolType]` で装飾されたクラス上のメソッドです。メソッド自身は `[McpServerTool, Description("...")]` を持ちます。メソッド パラメータが入力スキーマになり、各パラメータの `[Description]` がエージェントがツールを呼ぶか決めるときに見る JSON Schema に入ります。

リポジトリは ORM のダンスなしで例を端から端まで読めるよう、`Microsoft.Data.Sqlite` を使った素の ADO.NET です。同じパターンが EF Core 11 でもそのまま動きます -- `DbContext` を注入すれば、登録ループは同一です:

```csharp
// ProductRepository.cs, .NET 11
using Microsoft.Data.Sqlite;

namespace InventoryMcp;

public sealed record Product(string Sku, string Name, int Stock, decimal Price);

public sealed class ProductRepository
{
    private readonly string _connectionString;

    public ProductRepository(string connectionString)
    {
        _connectionString = connectionString;
        EnsureSchema();
    }

    public IReadOnlyList<Product> List(bool lowStockOnly, int limit)
    {
        using var conn = new SqliteConnection(_connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = lowStockOnly
            ? "SELECT sku, name, stock, price FROM products WHERE stock < 10 ORDER BY name LIMIT $limit"
            : "SELECT sku, name, stock, price FROM products ORDER BY name LIMIT $limit";
        cmd.Parameters.AddWithValue("$limit", limit);

        var results = new List<Product>();
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
        {
            results.Add(new Product(
                reader.GetString(0),
                reader.GetString(1),
                reader.GetInt32(2),
                reader.GetDecimal(3)));
        }
        return results;
    }

    public Product? Get(string sku)
    {
        using var conn = new SqliteConnection(_connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT sku, name, stock, price FROM products WHERE sku = $sku";
        cmd.Parameters.AddWithValue("$sku", sku);

        using var reader = cmd.ExecuteReader();
        return reader.Read()
            ? new Product(reader.GetString(0), reader.GetString(1), reader.GetInt32(2), reader.GetDecimal(3))
            : null;
    }

    public int Adjust(string sku, int delta)
    {
        using var conn = new SqliteConnection(_connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            UPDATE products SET stock = stock + $delta
            WHERE sku = $sku AND stock + $delta >= 0
            RETURNING stock
            """;
        cmd.Parameters.AddWithValue("$sku", sku);
        cmd.Parameters.AddWithValue("$delta", delta);

        var result = cmd.ExecuteScalar();
        if (result is null)
        {
            throw new InvalidOperationException(
                $"Cannot adjust stock for SKU '{sku}': product not found or stock would go negative.");
        }
        return Convert.ToInt32(result);
    }

    private void EnsureSchema() { /* CREATE TABLE IF NOT EXISTS ... and seed */ }
}
```

ツール クラスはエージェントが見る面です:

```csharp
// InventoryTools.cs, ModelContextProtocol 1.2.0
using System.ComponentModel;
using ModelContextProtocol.Server;

namespace InventoryMcp;

[McpServerToolType]
public sealed class InventoryTools
{
    private readonly ProductRepository _repo;
    private readonly ILogger<InventoryTools> _logger;

    public InventoryTools(ProductRepository repo, ILogger<InventoryTools> logger)
    {
        _repo = repo;
        _logger = logger;
    }

    [McpServerTool, Description("List products in the inventory database. Optionally filter to low-stock items (under 10 units).")]
    public IReadOnlyList<Product> ListProducts(
        [Description("If true, return only products with fewer than 10 units in stock.")] bool lowStockOnly = false,
        [Description("Maximum number of rows to return. Default 50, hard cap 500.")] int limit = 50)
    {
        limit = Math.Clamp(limit, 1, 500);
        return _repo.List(lowStockOnly, limit);
    }

    [McpServerTool, Description("Get a single product by its SKU. Returns null if no product matches.")]
    public Product? GetProduct(
        [Description("Stock-keeping unit, e.g. 'SKU-001'. Case-sensitive exact match.")] string sku)
        => _repo.Get(sku);

    [McpServerTool, Description("Adjust stock for a SKU by a positive or negative delta. Returns the new stock level. Errors if the SKU does not exist or the result would be negative.")]
    public int AdjustStock(
        [Description("SKU to adjust, e.g. 'SKU-001'.")] string sku,
        [Description("Signed integer delta. Use positive numbers to receive stock, negative to ship.")] int delta)
    {
        _logger.LogInformation("AdjustStock sku={Sku} delta={Delta}", sku, delta);
        return _repo.Adjust(sku, delta);
    }
}
```

実際にエージェントが呼び始めると効いてくる細部:

- **コンストラクター注入。** ツール メソッドはサービスをパラメータとして直接受け取ることもできますが、このようなリポジトリは呼び出し間で共有されるのでコンストラクターに置くべきです。`WithToolsFromAssembly()` は両方のスタイルを標準 DI コンテナで解決します。
- **戻り値の型としての record。** SDK は `Product` を構造化 JSON 出力としてシリアライズし、クライアントは型付き結果として表示できます。`IDictionary<string, object>` を返すと、エージェントには依然テキストが届きますが、スキーマと型保証は失われます。
- **`[Description]` はパラメータ名より重要です。** "詳細を取得する猿の名前" は、ツールを選ぶときにエージェントが読むものです。「SKU」のような曖昧な説明では、誤った自由文が誤ったツールにルーティングされます。フォーマットのヒントを含めて具体的に。
- **ツール レベルのエラーは例外を投げる。** SDK が例外を捕まえて、モデルが反応できるツール エラー結果としてクライアントに返します。一般的なケースで `CallToolResult` オブジェクトを手で構築する必要はありません。
- **パラメータ化 SQL のみ。** 上流のプロンプトにユーザー入力があると、エージェントは喜んで `'; DROP TABLE products; --` のような SKU を渡してきます。常に `$param` プレースホルダーを使ってください。

## Claude Code、Claude Desktop、VS Code への接続

`dotnet run` でプロセスが起動したら、エージェントに登録します。フォーマットは 3 種類、バイナリは同じです。

**Claude Code** には stdio サーバー用の組み込みコマンドがあります。プロジェクト ルートから:

```bash
# Claude Code 2.x
claude mcp add inventory -- dotnet run --project ./InventoryMcp.csproj
```

公開ビルドの場合はバイナリに切り替えます:

```bash
dotnet publish -c Release -o publish
claude mcp add inventory -- ./publish/InventoryMcp
```

**Claude Desktop** は `claude_desktop_config.json` を使います。Windows では `%AppData%\Claude\claude_desktop_config.json`、macOS では `~/Library/Application Support/Claude/claude_desktop_config.json` にあります:

```json
{
  "mcpServers": {
    "inventory": {
      "command": "dotnet",
      "args": [
        "run",
        "--project",
        "C:\\src\\InventoryMcp\\InventoryMcp.csproj",
        "--no-launch-profile"
      ],
      "env": {
        "INVENTORY_DB_PATH": "C:\\data\\inventory.db"
      }
    }
  }
}
```

Claude Desktop を再起動すると、MCP インジケーターに `list_products`、`get_product`、`adjust_stock` が並ぶはずです。「在庫が少ない商品は?」と聞けば、`list_products(lowStockOnly: true)` が呼ばれるのが見えます。

**VS Code** はワークスペース スコープのサーバーに `.vscode/mcp.json` を使います:

```json
{
  "inputs": [],
  "servers": {
    "inventory": {
      "type": "stdio",
      "command": "dotnet",
      "args": ["run", "--project", "${workspaceFolder}/InventoryMcp/InventoryMcp.csproj"]
    }
  }
}
```

IDE がユーザー設定ではなく MCP サーバーをネイティブにバンドルするやり方の感覚をつかむには、[Visual Studio 2022 17.14.30 内の Azure MCP サーバー](/ja/2026/04/azure-mcp-server-visual-studio-2022-17-14-30/) が役立つ参照点です。

## stdio が間違いになるとき: HTTP トランスポートの形

stdio は「自分のマシン上のエージェント、自分のマシン上のサーバー、プロセスごとに 1 クライアント」では正解です。他の開発者がリモート接続する長寿命のサーバーが必要になった瞬間、パッケージと登録を入れ替えます:

```csharp
// dotnet add package ModelContextProtocol.AspNetCore --version 1.2.0
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton<ProductRepository>(/* ... */);
builder.Services
    .AddMcpServer(o => o.ServerInfo = new() { Name = "inventory", Version = "1.0.0" })
    .WithHttpTransport()
    .WithToolsFromAssembly();

var app = builder.Build();
app.MapMcp();
app.Run();
```

`MapMcp()` は仕様が定義する streamable HTTP と SSE のエンドポイントを公開します。普段の ASP.NET Core 認証パイプラインの背後に置けば、OAuth 2.0 のインクリメンタル スコープ同意、well-known authorization discovery、そして 1.0 リリースで入った長時間リクエスト ポーリングが無料で手に入ります。

## ドキュメントが控えめにしか書かない本番運用の落とし穴

**`Microsoft.Data.Sqlite` 接続を 1 つだけ持って出荷しないでください。** 上の例は呼び出しごとに新しい接続を開きますが、これは SDK デモとしては正しいデフォルトです。趣味のデータベースを超える負荷では、`SqliteConnection` を transient サービスとして登録するか、EF Core 11 をプーリング付きで配線してください。SQLite は既定で書き込みを直列化します。`AdjustStock` の呼び出しが 2 つ同時に飛ぶと、ロック競合が数百ミリ秒を超えた段階で `SQLITE_BUSY` が出ます。

**キャンセル トークン。** ツール メソッドは末尾に `CancellationToken` パラメータを取れて、SDK がリクエスト単位のトークンを通します。ツールが `HttpClient`、EF Core、または何らかの I/O を呼ぶなら、トークンを受け取り、それを伝播してください。さもないと、タイムアウトする行儀の悪いモデルが、サーバー側に SQLite トランザクションや HTTP リクエストをぶら下げたまま放置します。

**外向き呼び出しのための `IHttpClientFactory`。** ツールが外部 API から取得するときは、`IHttpClientFactory` を注入して名前付きクライアントを作ってください。ASP.NET Core アプリを噛む同じ寿命ルール -- `new HttpClient()` によるソケット枯渇、DNS ピンニング -- は MCP サーバーをもっと強く噛みます。多くのエージェント セッションをまたいで動き続けがちだからです。

**ログのボリューム。** ツール呼び出しごとのおしゃべりな `LogInformation` は問題ありません。すべての呼び出しでツール入力全体をログ出力すると、PII が stderr に漏れて Claude Code のトランスクリプトに残り、ユーザーはキャプチャされていることに気づかないかもしれません。ツール呼び出しのログは Web リクエストのログと同じに扱ってください -- 機密を伏せ字に、入力を要約に。

**JSON シリアライゼーションの驚き。** SDK は `System.Text.Json` を既定オプションで使います。ドメイン型が `Newtonsoft.Json` 属性や非デフォルトのケーシングに依存しているなら、ホストで JSON オプションを構成するか、ツール境界でプレーンな record に変換してください。REST クライアント向けに 1 つの方法でシリアライズし、MCP クライアント向けに別の方法でシリアライズする型はデバッグの悪夢です。

**Native AOT。** 属性駆動のツール検出がリフレクションを使うため、`ModelContextProtocol` パッケージは現状まだ完全には AOT フレンドリーではありません。配布用の単一ファイル AOT 実行可能ファイルが必要なら、`ModelContextProtocol.Core` を使い、`WithToolsFromAssembly` の代わりに `MapTool` で手動でツールを登録してください。

## このパターンが .NET ショップにもたらすもの

中心となる動き -- メソッドを装飾する、record を返す、エラーで投げる -- は、チームが既に持つすべての C# 統合にスケールします。明白な次の手順をいくつか:

- EF Core 11 の `DbContext` をラップして、スキーマ イントロスペクションとパラメータ化クエリ ツールを公開すれば、エージェントは「先週出荷した注文は何件か」に対し、あなたが SQL を書かなくても答えられます。EF Core の最新機能とよくマッチします。エージェントに特に向く検索プリミティブとして [EF Core 11 SQL Server ベクトル検索と DiskANN インデックス](/ja/2026/04/efcore-11-sql-server-vector-search-diskann-indexes/) を参照してください。
- Hangfire / Quartz スケジューラーをラップして、エージェントにバックグラウンド ジョブの確認や起動をさせる。
- 既存の認証パイプライン込みで、本物の API のまわりに内部 Refit クライアントをラップして、エージェントにアプリと同じ面に話させる。

主に別言語で作業しているなら、[CLI をラップする TypeScript の同等のサーバー](/ja/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) は `@modelcontextprotocol/sdk` を使った Node.js をカバーし、[公式 `mcp` SDK を使った Python ガイド](/2026/04/how-to-build-a-custom-mcp-server-in-python-with-the-official-sdk/) は FastMCP パターンをカバーします。さらに MCP の先、C# でのマルチエージェント オーケストレーションを見ているなら、[Microsoft Agent Framework 1.0](/ja/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) が MCP の止まったところ -- プランナー、マルチエージェント ハンドオフ、永続的な実行状態 -- を引き継ぎます。

MCP サーバー自体は、ツールが SQLite データベースをラップしているか、SignalR ハブか、500 行のドメイン サービスかを気にしません。型付きパラメータ (C# の属性が無料で提供) と、SDK がシリアライズできる戻り値、そして余分なバイトの混じらない stdio ストリームだけが必要です。

## ソース リンク

- [`modelcontextprotocol/csharp-sdk` (GitHub)](https://github.com/modelcontextprotocol/csharp-sdk) -- Anthropic と Microsoft が保守する公式リポジトリ。
- [NuGet 上の `ModelContextProtocol` 1.2.0](https://www.nuget.org/packages/ModelContextProtocol/) -- メイン サーバー パッケージ。
- [.NET Blog: Release v1.0 of the official MCP C# SDK](https://devblogs.microsoft.com/dotnet/release-v10-of-the-official-mcp-csharp-sdk/) -- 2026 年 3 月 5 日の 1.0 リリース ノート。
- [.NET Blog: Build a Model Context Protocol (MCP) server in C#](https://devblogs.microsoft.com/dotnet/build-a-model-context-protocol-mcp-server-in-csharp/) -- Microsoft の正典ウォークスルー。
- [MCP 仕様 2025-11-25](https://modelcontextprotocol.io/specification/) -- SDK 1.x が実装する仕様バージョン。
