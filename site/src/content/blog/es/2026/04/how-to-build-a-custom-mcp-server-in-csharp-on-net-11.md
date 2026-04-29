---
title: "Cómo construir un servidor MCP personalizado en C# sobre .NET 11"
description: "Construye un servidor Model Context Protocol funcional en C# 14 / .NET 11 usando el SDK oficial ModelContextProtocol 1.2. Cubre el transporte stdio, los atributos [McpServerTool], inyección de dependencias, la trampa del logging por stderr y el registro con Claude Code, Claude Desktop y VS Code."
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
lang: "es"
translationOf: "2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11"
translatedBy: "claude"
translationDate: 2026-04-29
---

Si la fuente de verdad de tu equipo vive en un servicio .NET -- una base de datos EF Core, una API interna, un ejecutor de jobs Hangfire, una Workspace API -- entonces exponerlo a un agente de codificación a través del [Model Context Protocol](https://modelcontextprotocol.io/) es más rápido de lo que el lado .NET de internet suele anunciar. El SDK oficial de C# llegó a `1.0` el 5 de marzo de 2026 y publicó `1.2.0` el 27 de marzo, ambos mantenidos conjuntamente por Microsoft y Anthropic. El boilerplate ahora es lo bastante pequeño como para que el trabajo interesante esté en tus métodos de herramienta, no en la fontanería del protocolo.

Esta guía construye un servidor MCP real y ejecutable en **C# 14 sobre .NET 11**, usando el paquete **`ModelContextProtocol` 1.2.0** contra la **especificación MCP 2025-11-25**. Al final tendrás un servidor `inventory-mcp` que expone una base de datos SQLite a un agente a través de tres herramientas, con inyección de dependencias adecuada, el truco de logging por stderr que la documentación solo menciona de pasada, y los fragmentos de configuración exactos para Claude Code, Claude Desktop y `mcp.json` de VS Code.

## Cuándo el SDK de C# es la elección correcta

Los equipos de Anthropic y MCP publican SDKs oficiales en TypeScript, Python y C#. Producen tráfico idéntico por el cable, así que la pregunta no es "cuál transporta mejor el protocolo" sino "dónde vive ya el código que quiero exponer". Dos casos en los que C# gana:

- **Tu lógica de negocio ya está en .NET.** Modelos de EF Core, autenticación con Microsoft.Identity.Web, jobs programados de Hangfire / Quartz, políticas de reintento con Polly, una API interna expuesta vía Refit. Reimplementar cualquiera de eso en Python o Node para que un agente pueda llamarlo es trabajo desperdiciado. El SDK de C# te permite poner `[McpServerTool]` sobre un método y publicar.
- **Quieres el modelo de hosting estándar de .NET.** `IHostedService`, `IHttpClientFactory`, `IConfiguration`, logging estructurado a través de `Microsoft.Extensions.Logging`, OpenTelemetry. El SDK se enchufa directamente en `Host.CreateApplicationBuilder`, así que la observabilidad y la configuración se ven igual que en cualquier otro servicio ASP.NET Core.

Para contexto sobre el protocolo en sí, el [resumen del cableado de Microsoft `mcp` para .NET 10](/2026/01/microsoft-mcp-wiring-model-context-protocol-servers-from-c-on-net-10/), un poco más antiguo, cubre la mentalidad contract-first; este post es la actualización how-to concreta para .NET 11 y el SDK posterior a 1.0.

## Configuración del proyecto con el SDK de .NET 11

Necesitas el SDK de .NET 11 (`dotnet --version` debería reportar `11.0.x` o superior). El paquete `ModelContextProtocol` 1.2.0 apunta a `net8.0` y superiores, así que `net11.0` está soportado y te da las características de C# 14 gratis.

```bash
# .NET 11 SDK, ModelContextProtocol 1.2.0
dotnet new console -n InventoryMcp
cd InventoryMcp
dotnet add package ModelContextProtocol --version 1.2.0
dotnet add package Microsoft.Extensions.Hosting --version 11.0.0
dotnet add package Microsoft.Data.Sqlite --version 11.0.0
```

La división de paquetes se ve así, y la elección importa:

- **`ModelContextProtocol`** -- el paquete principal del servidor. Trae las extensiones de hosting e inyección de dependencias y el registro de herramientas basado en atributos. Elige este para cualquier proyecto que no necesite su propio host HTTP de ASP.NET Core.
- **`ModelContextProtocol.Core`** -- dependencias mínimas para trabajo cliente/servidor de bajo nivel o código de biblioteca. Sin `Microsoft.Extensions.Hosting` integrado.
- **`ModelContextProtocol.AspNetCore`** -- añade `WithHttpTransport()` y los endpoints de servidor HTTP streameable para despliegues remotos.

Para un servidor stdio que lanzas desde un agente de codificación, solo necesitas el primero.

El `.csproj` para .NET 11 termina siendo mínimo:

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

## El Program.cs que no corrompe stdout

El transporte stdio lleva mensajes JSON-RPC sobre el par stdin/stdout del proceso. El servidor lee solicitudes en stdin y escribe respuestas en stdout. Cualquier otra cosa que toque stdout -- un `Console.WriteLine` perdido, un `ILogger` con configuración por defecto emitiendo a stdout, una traza de pila de excepción cayendo en stdout en lugar de stderr -- se inyecta en el flujo JSON y el cliente mata la conexión con un error de parseo.

La integración de hosting del SDK de C# maneja las escrituras del protocolo, pero tienes que reenlazar el logger de consola a stderr o perderás los primeros 30 minutos de tu vida persiguiendo alertas de "MCP server disconnected" en Claude Code:

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

Tres cosas que vale la pena fijar:

- `LogToStandardErrorThreshold = LogLevel.Trace` envía cada línea de log a stderr. Sin eso, `Microsoft.Extensions.Logging` escribe warnings y superiores a stderr pero información e inferiores a stdout, lo que silenciosamente corrompe el flujo del protocolo en el momento en que algo loggea a nivel info.
- `AppContext.BaseDirectory` ancla la ruta de SQLite junto al binario publicado. El proceso del agente lanza el servidor con cualquier directorio de trabajo que le apetezca, así que no te apoyes en `Environment.CurrentDirectory`.
- `WithToolsFromAssembly()` escanea el ensamblado de entrada en busca de cualquier clase marcada con `[McpServerToolType]` y registra cada método marcado con `[McpServerTool]`. También puedes fijar tipos específicos con `WithTools<EchoTool>().WithTools<MonkeyTools>()` si prefieres registro explícito.

## Definir las herramientas

Cada herramienta es un método sobre una clase decorada con `[McpServerToolType]`. El método en sí lleva `[McpServerTool, Description("...")]`. Los parámetros del método se convierten en el esquema de entrada; `[Description]` sobre cada parámetro acaba en el JSON Schema que el agente ve cuando decide si llamar a la herramienta.

El repositorio es ADO.NET puro con `Microsoft.Data.Sqlite` para que el ejemplo se lea de cabo a rabo sin baile de ORM. El patrón funciona igual con EF Core 11 -- inyecta el `DbContext` y el bucle de registro es idéntico:

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

La clase de herramientas es la superficie que ve el agente:

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

Algunos detalles que importan una vez que un agente realmente empieza a llamar esto:

- **Inyección por constructor.** Los métodos de herramienta también pueden tomar servicios como parámetros directamente, pero un repositorio como este se comparte entre llamadas y pertenece al constructor. `WithToolsFromAssembly()` resuelve ambos estilos a través del contenedor DI estándar.
- **Records como tipos de retorno.** El SDK serializa `Product` a salida JSON estructurada que el cliente puede mostrar como un resultado tipado. Si devolvieras `IDictionary<string, object>` el agente seguiría obteniendo texto, pero perdería el esquema y cualquier garantía de tipo.
- **`[Description]` importa más que el nombre del parámetro.** "El nombre del mono del que obtener detalles" es lo que el agente lee cuando elige una herramienta. Descripciones vagas como "el SKU" enrutan el texto libre equivocado a la herramienta equivocada. Sé específico, incluyendo pistas de formato.
- **Lanza para errores a nivel de herramienta.** El SDK captura la excepción y la devuelve al cliente como un resultado de error de herramienta al que el modelo puede reaccionar. No necesitas construir objetos `CallToolResult` a mano para el caso común.
- **Solo SQL parametrizado.** Un agente pasará felizmente un SKU como `'; DROP TABLE products; --` si el prompt aguas arriba tiene entrada de usuario. Usa siempre marcadores `$param`.

## Conectarlo a Claude Code, Claude Desktop y VS Code

Una vez que `dotnet run` arranca el proceso, regístralo con el agente. Tres formatos, el mismo binario.

**Claude Code** tiene un comando incorporado para servidores stdio. Desde la raíz del proyecto:

```bash
# Claude Code 2.x
claude mcp add inventory -- dotnet run --project ./InventoryMcp.csproj
```

Para una compilación publicada, cambia al binario:

```bash
dotnet publish -c Release -o publish
claude mcp add inventory -- ./publish/InventoryMcp
```

**Claude Desktop** usa `claude_desktop_config.json`. En Windows vive en `%AppData%\Claude\claude_desktop_config.json`; en macOS en `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

Reinicia Claude Desktop, y el indicador MCP debería listar `list_products`, `get_product` y `adjust_stock`. Pregúntale "¿Qué productos están bajos de stock?" y míralo llamar a `list_products(lowStockOnly: true)`.

**VS Code** usa `.vscode/mcp.json` para servidores con alcance de workspace:

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

Para hacerte una idea de cómo un IDE empaqueta servidores MCP nativamente en lugar de pasar por la configuración de usuario, [el Azure MCP Server dentro de Visual Studio 2022 17.14.30](/es/2026/04/azure-mcp-server-visual-studio-2022-17-14-30/) es un buen punto de referencia.

## Cuándo stdio está mal: la forma del transporte HTTP

Stdio es correcto para "agente en mi máquina, servidor en mi máquina, un cliente por proceso". En el momento en que quieras un servidor de larga vida al que otros desarrolladores se conecten remotamente, cambia el paquete y el registro:

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

`MapMcp()` expone los endpoints HTTP-streameable y SSE que define la spec. Ponlo detrás de tu pipeline habitual de auth de ASP.NET Core y obtienes consentimiento incremental de scope con OAuth 2.0, descubrimiento well-known de autorización, y el polling de solicitudes de larga duración que aterrizó en la versión 1.0 gratis.

## Trampas de producción que la documentación minimiza

**No envíes una sola conexión `Microsoft.Data.Sqlite`.** El ejemplo de arriba abre una conexión nueva por llamada, que es el valor por defecto correcto para una demo de SDK. Para cargas más allá de una base de datos hobby, registra `SqliteConnection` como servicio transient o cablea EF Core 11 con pooling. SQLite serializa las escrituras por defecto; si dos llamadas a `AdjustStock` disparan simultáneamente verás `SQLITE_BUSY` cuando la contención de bloqueo cruce unos pocos cientos de ms.

**Tokens de cancelación.** Los métodos de herramienta pueden tomar un parámetro final `CancellationToken` y el SDK conectará el token por solicitud. Si tu herramienta llama a `HttpClient`, EF Core, o cualquier I/O, acepta el token y pásalo. Si no, un modelo mal portado que se queda sin tiempo deja una transacción de SQLite o solicitud HTTP colgada en el servidor.

**`IHttpClientFactory` para llamadas salientes.** Cuando una herramienta hace fetch desde una API externa, inyecta `IHttpClientFactory` y crea clientes con nombre. Las mismas reglas de tiempo de vida que muerden a las apps ASP.NET Core -- agotamiento de sockets por `new HttpClient()`, fijación de DNS -- muerden a los servidores MCP más fuerte, porque tienden a quedarse corriendo a través de muchas sesiones de agente.

**Volumen de logging.** Un `LogInformation` charlatán por llamada de herramienta está bien. Loggear toda la entrada de la herramienta en cada llamada filtra PII a stderr y acaba en la transcripción de Claude Code, que el usuario puede no darse cuenta que está siendo capturada. Trata los logs de llamadas de herramienta igual que tratas los logs de solicitud web: redacta secretos, resume entradas.

**Sorpresas de serialización JSON.** El SDK usa `System.Text.Json` con las opciones por defecto. Si tus tipos de dominio se apoyan en atributos de `Newtonsoft.Json` o casing no por defecto, configura las opciones JSON sobre el host o convierte a records planos en la frontera de la herramienta. Un tipo que se serializa de una forma a tus clientes REST y de otra a clientes MCP es una pesadilla de depuración.

**Native AOT.** El paquete `ModelContextProtocol` no es totalmente AOT-friendly todavía porque el descubrimiento de herramientas dirigido por atributos usa reflexión. Si necesitas un ejecutable AOT de archivo único para distribución, usa `ModelContextProtocol.Core` y registra herramientas manualmente con `MapTool` en lugar de `WithToolsFromAssembly`.

## Lo que este patrón desbloquea para una tienda .NET

El movimiento central -- decora un método, devuelve un record, lanza en errores -- escala a cada integración C# que tu equipo ya tiene. Algunos siguientes pasos obvios:

- Envuelve un `DbContext` de EF Core 11 y expón introspección de esquema más una herramienta de consulta parametrizada, para que un agente pueda responder "cuántos pedidos se enviaron la semana pasada" sin que tú escribas el SQL. Las características más recientes de EF Core combinan bien; ver [Búsqueda vectorial de SQL Server con índices DiskANN en EF Core 11](/es/2026/04/efcore-11-sql-server-vector-search-diskann-indexes/) para una primitiva de recuperación particularmente amigable con agentes.
- Envuelve un programador Hangfire / Quartz y deja que el agente inspeccione o dispare jobs en background.
- Envuelve un cliente Refit interno alrededor de tu API real, con la pipeline de auth existente, para que el agente hable con la misma superficie con la que hablan tus apps.

Si principalmente trabajas en otro lenguaje, [el servidor equivalente en TypeScript que envuelve un CLI](/es/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) cubre Node.js con `@modelcontextprotocol/sdk`, y [la guía de Python usando el SDK oficial `mcp`](/2026/04/how-to-build-a-custom-mcp-server-in-python-with-the-official-sdk/) cubre el patrón FastMCP. Y si miras más allá de MCP hacia orquestación multi-agente en C#, [Microsoft Agent Framework 1.0](/es/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) recoge donde MCP termina, con planificadores, traspaso multi-agente y estado de ejecución durable.

Al servidor MCP en sí no le importa si tu herramienta envuelve una base de datos SQLite, un hub de SignalR o un servicio de dominio de 500 líneas. Solo necesita parámetros tipados (los atributos de C# te dan eso gratis), un valor de retorno que el SDK pueda serializar y un flujo stdio que no tenga bytes perdidos.

## Enlaces de fuente

- [`modelcontextprotocol/csharp-sdk` en GitHub](https://github.com/modelcontextprotocol/csharp-sdk) -- repositorio oficial, mantenido por Anthropic y Microsoft.
- [`ModelContextProtocol` 1.2.0 en NuGet](https://www.nuget.org/packages/ModelContextProtocol/) -- paquete principal del servidor.
- [.NET Blog: Release v1.0 of the official MCP C# SDK](https://devblogs.microsoft.com/dotnet/release-v10-of-the-official-mcp-csharp-sdk/) -- notas de la versión 1.0 del 5 de marzo de 2026.
- [.NET Blog: Build a Model Context Protocol (MCP) server in C#](https://devblogs.microsoft.com/dotnet/build-a-model-context-protocol-mcp-server-in-csharp/) -- el recorrido canónico de Microsoft.
- [Especificación MCP 2025-11-25](https://modelcontextprotocol.io/specification/) -- la versión de spec implementada por el SDK 1.x.
