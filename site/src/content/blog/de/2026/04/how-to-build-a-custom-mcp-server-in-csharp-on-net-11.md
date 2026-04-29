---
title: "Wie Sie einen eigenen MCP-Server in C# auf .NET 11 bauen"
description: "Bauen Sie einen funktionierenden Model-Context-Protocol-Server in C# 14 / .NET 11 mit dem offiziellen ModelContextProtocol-1.2-SDK. Behandelt Stdio-Transport, [McpServerTool]-Attribute, Dependency Injection, die Stderr-Logging-Falle und die Registrierung bei Claude Code, Claude Desktop und VS Code."
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
lang: "de"
translationOf: "2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11"
translatedBy: "claude"
translationDate: 2026-04-29
---

Wenn die Source of Truth Ihres Teams in einem .NET-Service lebt -- einer EF-Core-Datenbank, einer internen API, einem Hangfire-Job-Runner, einer Workspace-API -- dann ist es schneller, das über das [Model Context Protocol](https://modelcontextprotocol.io/) einem Coding Agent zugänglich zu machen, als die .NET-Ecke des Internets üblicherweise wirbt. Das offizielle C#-SDK erreichte am 5. März 2026 `1.0` und veröffentlichte am 27. März `1.2.0`, beide gemeinsam von Microsoft und Anthropic gepflegt. Der Boilerplate ist mittlerweile so klein, dass die interessante Arbeit in Ihren Tool-Methoden steckt, nicht in der Protokoll-Klempnerei.

Diese Anleitung baut einen echten, lauffähigen MCP-Server in **C# 14 auf .NET 11**, mit dem **`ModelContextProtocol`-1.2.0**-Paket gegen die **MCP-Spezifikation 2025-11-25**. Am Ende haben Sie einen `inventory-mcp`-Server, der eine SQLite-Datenbank über drei Tools an einen Agenten exponiert, mit ordentlicher Dependency Injection, dem Stderr-Logging-Trick, den die Doku nur am Rande erwähnt, und den exakten Konfigurations-Snippets für Claude Code, Claude Desktop und die `mcp.json` von VS Code.

## Wann das C#-SDK die richtige Wahl ist

Die Anthropic- und MCP-Teams liefern offizielle SDKs in TypeScript, Python und C#. Sie produzieren identischen Wire-Traffic, also ist die Frage nicht "welches transportiert das Protokoll am besten", sondern "wo lebt der Code, den ich exponieren möchte, schon?". Zwei Fälle, in denen C# gewinnt:

- **Ihre Geschäftslogik liegt bereits in .NET.** EF-Core-Modelle, Microsoft.Identity.Web-Auth, Hangfire-/Quartz-Scheduled-Jobs, Polly-Retry-Policies, eine über Refit verfügbar gemachte interne API. Davon irgendetwas in Python oder Node neu zu implementieren, damit ein Agent es aufrufen kann, ist verschwendete Arbeit. Mit dem C#-SDK setzen Sie `[McpServerTool]` auf eine Methode und liefern aus.
- **Sie wollen das Standard-.NET-Hosting-Modell.** `IHostedService`, `IHttpClientFactory`, `IConfiguration`, strukturierte Protokollierung über `Microsoft.Extensions.Logging`, OpenTelemetry. Das SDK steckt direkt in `Host.CreateApplicationBuilder`, sodass Observability und Konfiguration genauso aussehen wie bei jedem anderen ASP.NET-Core-Service.

Hintergrund zum Protokoll selbst gibt der ältere [Überblick über Microsofts `mcp`-Verdrahtung für .NET 10](/2026/01/microsoft-mcp-wiring-model-context-protocol-servers-from-c-on-net-10/), der die Contract-First-Denke abdeckt; dieser Beitrag ist das konkrete How-to-Update für .NET 11 und das Post-1.0-SDK.

## Projekt-Setup mit dem .NET-11-SDK

Sie brauchen das .NET-11-SDK (`dotnet --version` sollte `11.0.x` oder höher melden). Das Paket `ModelContextProtocol` 1.2.0 zielt auf `net8.0` und höher, also wird `net11.0` unterstützt und Sie bekommen die C#-14-Features kostenlos dazu.

```bash
# .NET 11 SDK, ModelContextProtocol 1.2.0
dotnet new console -n InventoryMcp
cd InventoryMcp
dotnet add package ModelContextProtocol --version 1.2.0
dotnet add package Microsoft.Extensions.Hosting --version 11.0.0
dotnet add package Microsoft.Data.Sqlite --version 11.0.0
```

Die Paketaufteilung sieht so aus, und die Wahl ist relevant:

- **`ModelContextProtocol`** -- das Hauptserver-Paket. Zieht Hosting- und Dependency-Injection-Erweiterungen sowie die attributbasierte Tool-Registrierung mit. Wählen Sie das für jedes Projekt, das keinen eigenen ASP.NET-Core-HTTP-Host braucht.
- **`ModelContextProtocol.Core`** -- minimale Abhängigkeiten für Low-Level-Client/Server-Arbeit oder Bibliothekscode. Kein eingebautes `Microsoft.Extensions.Hosting`.
- **`ModelContextProtocol.AspNetCore`** -- fügt `WithHttpTransport()` und die Streamable-HTTP-Server-Endpunkte für Remote-Deployments hinzu.

Für einen Stdio-Server, den Sie aus einem Coding Agent starten, wird nur das erste benötigt.

Die `.csproj` für .NET 11 fällt minimal aus:

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

## Die Program.cs, die stdout nicht korrumpiert

Der Stdio-Transport trägt JSON-RPC-Nachrichten über das stdin/stdout-Paar des Prozesses. Der Server liest Anfragen auf stdin und schreibt Antworten auf stdout. Alles andere, was stdout berührt -- ein verirrtes `Console.WriteLine`, ein standardkonfigurierter `ILogger`, der nach stdout ausgibt, ein Stack Trace, der auf stdout statt auf stderr landet -- wird in den JSON-Stream injiziert, und der Client tötet die Verbindung mit einem Parse-Fehler.

Die Hosting-Integration des C#-SDKs erledigt die Protokoll-Schreibvorgänge, aber Sie müssen den Console-Logger nach stderr umbiegen, sonst verlieren Sie die ersten 30 Minuten Ihres Lebens damit, in Claude Code "MCP server disconnected"-Alerts hinterherzulaufen:

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

Drei Punkte zum Festhalten:

- `LogToStandardErrorThreshold = LogLevel.Trace` schickt jede Logzeile nach stderr. Ohne das schreibt `Microsoft.Extensions.Logging` Warnings und höher nach stderr, aber Information und niedriger nach stdout, was den Protokollstream stillschweigend korrumpiert, sobald irgendetwas auf Info-Level loggt.
- `AppContext.BaseDirectory` verankert den SQLite-Pfad neben der veröffentlichten Binary. Der Agentenprozess startet den Server mit beliebigem Working Directory, also verlassen Sie sich nicht auf `Environment.CurrentDirectory`.
- `WithToolsFromAssembly()` scannt das Entry-Assembly nach jeder Klasse mit `[McpServerToolType]` und registriert jede Methode mit `[McpServerTool]`. Sie können auch bestimmte Typen mit `WithTools<EchoTool>().WithTools<MonkeyTools>()` festnageln, wenn Sie explizite Registrierung bevorzugen.

## Die Tools definieren

Jedes Tool ist eine Methode auf einer Klasse, die mit `[McpServerToolType]` dekoriert ist. Die Methode selbst trägt `[McpServerTool, Description("...")]`. Die Methodenparameter werden zum Eingabeschema; `[Description]` an jedem Parameter landet im JSON-Schema, das der Agent sieht, wenn er entscheidet, ob er das Tool aufruft.

Das Repository ist schlichtes ADO.NET mit `Microsoft.Data.Sqlite`, damit das Beispiel ohne ORM-Tanz von vorn bis hinten lesbar ist. Das Muster funktioniert mit EF Core 11 genauso -- injizieren Sie den `DbContext`, und die Registrierungsschleife ist identisch:

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

Die Tool-Klasse ist die Oberfläche, die der Agent sieht:

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

Ein paar Details, die zählen, sobald ein Agent das tatsächlich anruft:

- **Konstruktor-Injektion.** Tool-Methoden können Dienste auch direkt als Parameter nehmen, aber ein Repository wie dieses wird über Aufrufe hinweg geteilt und gehört in den Konstruktor. `WithToolsFromAssembly()` löst beide Stile über den Standard-DI-Container auf.
- **Records als Rückgabetypen.** Das SDK serialisiert `Product` zu strukturierter JSON-Ausgabe, die der Client als typisiertes Ergebnis zeigen kann. Würden Sie `IDictionary<string, object>` zurückgeben, bekäme der Agent zwar weiterhin Text, würde aber Schema und Typgarantien verlieren.
- **`[Description]` zählt mehr als der Parametername.** "Der Name des Affen, dessen Details abgerufen werden sollen" ist das, was der Agent liest, wenn er ein Tool wählt. Vage Beschreibungen wie "die SKU" leiten den falschen Freitext ins falsche Tool. Seien Sie spezifisch, samt Format-Hinweisen.
- **Werfen Sie für Tool-Level-Fehler Exceptions.** Das SDK fängt die Exception ab und gibt sie an den Client als Tool-Error-Result zurück, auf das das Modell reagieren kann. Sie müssen `CallToolResult`-Objekte für den Standardfall nicht von Hand bauen.
- **Nur parametrisiertes SQL.** Ein Agent reicht freudig eine SKU wie `'; DROP TABLE products; --` durch, wenn der vorgelagerte Prompt Benutzereingabe enthält. Verwenden Sie immer `$param`-Platzhalter.

## Anschluss an Claude Code, Claude Desktop und VS Code

Sobald `dotnet run` den Prozess startet, registrieren Sie ihn beim Agenten. Drei Formate, dieselbe Binary.

**Claude Code** hat einen eingebauten Befehl für Stdio-Server. Aus dem Projektroot:

```bash
# Claude Code 2.x
claude mcp add inventory -- dotnet run --project ./InventoryMcp.csproj
```

Für einen veröffentlichten Build wechseln Sie zur Binary:

```bash
dotnet publish -c Release -o publish
claude mcp add inventory -- ./publish/InventoryMcp
```

**Claude Desktop** verwendet `claude_desktop_config.json`. Unter Windows liegt sie in `%AppData%\Claude\claude_desktop_config.json`; unter macOS in `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

Starten Sie Claude Desktop neu, und der MCP-Indikator sollte `list_products`, `get_product` und `adjust_stock` listen. Fragen Sie "Welche Produkte sind knapp?" und sehen Sie zu, wie es `list_products(lowStockOnly: true)` aufruft.

**VS Code** nutzt `.vscode/mcp.json` für Workspace-bezogene Server:

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

Für ein Gefühl, wie eine IDE MCP-Server nativ bündelt, statt über User-Config zu gehen, ist [der Azure MCP Server in Visual Studio 2022 17.14.30](/de/2026/04/azure-mcp-server-visual-studio-2022-17-14-30/) ein nützlicher Bezugspunkt.

## Wann Stdio falsch ist: die Form des HTTP-Transports

Stdio ist richtig für "Agent auf meiner Maschine, Server auf meiner Maschine, ein Client pro Prozess". In dem Moment, in dem Sie einen langlebigen Server möchten, mit dem sich andere Entwickler aus der Ferne verbinden, tauschen Sie das Paket und die Registrierung:

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

`MapMcp()` exponiert die in der Spec definierten Streamable-HTTP- und SSE-Endpunkte. Setzen Sie es hinter Ihre übliche ASP.NET-Core-Auth-Pipeline, und Sie bekommen OAuth-2.0-Incremental-Scope-Consent, Well-Known-Authorization-Discovery und das Long-Running-Request-Polling, das in der 1.0-Release gelandet ist, gratis.

## Produktionsfallen, die die Doku unterschätzt

**Liefern Sie nicht eine einzige `Microsoft.Data.Sqlite`-Verbindung.** Das obige Beispiel öffnet pro Aufruf eine frische Verbindung, was der richtige Default für eine SDK-Demo ist. Für Lasten jenseits einer Hobbydatenbank registrieren Sie `SqliteConnection` als transienten Service oder verdrahten Sie EF Core 11 mit Pooling. SQLite serialisiert Schreibzugriffe per Default; wenn zwei `AdjustStock`-Aufrufe gleichzeitig feuern, sehen Sie `SQLITE_BUSY`, sobald die Lock-Contention die paar hundert ms überschreitet.

**Cancellation-Token.** Tool-Methoden können einen abschließenden `CancellationToken`-Parameter aufnehmen, und das SDK verdrahtet das Token pro Anfrage durch. Wenn Ihr Tool `HttpClient`, EF Core oder irgendeine I/O aufruft, akzeptieren Sie das Token und reichen Sie es weiter. Sonst hinterlässt ein sich schlecht benehmendes Modell, das ins Timeout läuft, eine SQLite-Transaktion oder HTTP-Anfrage, die am Server hängt.

**`IHttpClientFactory` für ausgehende Aufrufe.** Wenn ein Tool von einer externen API holt, injizieren Sie `IHttpClientFactory` und erstellen Sie benannte Clients. Dieselben Lebenszyklusregeln, die ASP.NET-Core-Apps beißen -- Socket-Erschöpfung durch `new HttpClient()`, DNS-Pinning -- beißen MCP-Server härter, weil sie über viele Agentensitzungen hinweg laufen.

**Logging-Volumen.** Ein redseliges `LogInformation` pro Tool-Aufruf ist okay. Den gesamten Tool-Input bei jedem Aufruf zu loggen, leakt PII nach stderr und landet im Transkript von Claude Code, das der Nutzer womöglich nicht als erfasst wahrnimmt. Behandeln Sie Tool-Call-Logs wie Webrequest-Logs: Geheimnisse maskieren, Eingaben zusammenfassen.

**JSON-Serialisierungs-Überraschungen.** Das SDK nutzt `System.Text.Json` mit Default-Optionen. Wenn Ihre Domänentypen auf `Newtonsoft.Json`-Attribute oder Nicht-Default-Casing setzen, konfigurieren Sie die JSON-Optionen am Host oder konvertieren Sie an der Tool-Grenze in plain Records. Ein Typ, der für REST-Clients anders serialisiert als für MCP-Clients, ist ein Debugging-Albtraum.

**Native AOT.** Das `ModelContextProtocol`-Paket ist noch nicht voll AOT-fähig, weil das attributgetriebene Tool-Discovery Reflection nutzt. Wenn Sie eine Single-File-AOT-Executable für die Distribution brauchen, verwenden Sie `ModelContextProtocol.Core` und registrieren Tools manuell mit `MapTool` statt `WithToolsFromAssembly`.

## Was dieses Muster für einen .NET-Shop freischaltet

Der Kernzug -- Methode dekorieren, Record zurückgeben, bei Fehlern werfen -- skaliert auf jede C#-Integration, die Ihr Team bereits hat. Ein paar offensichtliche nächste Schritte:

- Wickeln Sie einen EF-Core-11-`DbContext` ein und exponieren Sie Schema-Introspektion plus ein parametrisiertes Query-Tool, sodass ein Agent "wie viele Bestellungen wurden letzte Woche versandt" beantworten kann, ohne dass Sie das SQL schreiben. Die neueren EF-Core-Features passen gut dazu; siehe [EF Core 11 SQL Server Vector Search mit DiskANN-Indizes](/de/2026/04/efcore-11-sql-server-vector-search-diskann-indexes/) für eine besonders agentenfreundliche Retrieval-Primitive.
- Wickeln Sie einen Hangfire-/Quartz-Scheduler ein und lassen Sie den Agenten Hintergrund-Jobs inspizieren oder auslösen.
- Wickeln Sie einen internen Refit-Client um Ihre echte API, mit der bestehenden Auth-Pipeline, sodass der Agent mit derselben Oberfläche spricht wie Ihre Apps.

Wenn Sie hauptsächlich in einer anderen Sprache arbeiten, deckt [der äquivalente Server in TypeScript, der ein CLI umhüllt](/de/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) Node.js mit `@modelcontextprotocol/sdk` ab, und [der Python-Leitfaden mit dem offiziellen `mcp`-SDK](/2026/04/how-to-build-a-custom-mcp-server-in-python-with-the-official-sdk/) deckt das FastMCP-Muster ab. Und wenn Sie über MCP hinaus auf Multi-Agent-Orchestrierung in C# schauen, knüpft [Microsoft Agent Framework 1.0](/de/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) dort an, wo MCP aufhört, mit Plannern, Multi-Agent-Handoff und durablem Run-State.

Den MCP-Server selbst kümmert es nicht, ob Ihr Tool eine SQLite-Datenbank, einen SignalR-Hub oder einen 500-Zeilen-Domänenservice umhüllt. Er braucht nur typisierte Parameter (die C#-Attribute geben Ihnen das gratis), einen Rückgabewert, den das SDK serialisieren kann, und einen Stdio-Stream, in dem keine verirrten Bytes landen.

## Quellen

- [`modelcontextprotocol/csharp-sdk` auf GitHub](https://github.com/modelcontextprotocol/csharp-sdk) -- offizielles Repository, betreut von Anthropic und Microsoft.
- [`ModelContextProtocol` 1.2.0 auf NuGet](https://www.nuget.org/packages/ModelContextProtocol/) -- Hauptserver-Paket.
- [.NET Blog: Release v1.0 of the official MCP C# SDK](https://devblogs.microsoft.com/dotnet/release-v10-of-the-official-mcp-csharp-sdk/) -- Release-Notes der 1.0 vom 5. März 2026.
- [.NET Blog: Build a Model Context Protocol (MCP) server in C#](https://devblogs.microsoft.com/dotnet/build-a-model-context-protocol-mcp-server-in-csharp/) -- der kanonische Microsoft-Walkthrough.
- [MCP-Spezifikation 2025-11-25](https://modelcontextprotocol.io/specification/) -- die vom SDK 1.x implementierte Spec-Version.
