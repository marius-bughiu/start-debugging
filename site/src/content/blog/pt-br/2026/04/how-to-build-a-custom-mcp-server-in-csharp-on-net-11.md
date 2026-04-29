---
title: "Como construir um servidor MCP customizado em C# no .NET 11"
description: "Construa um servidor Model Context Protocol funcional em C# 14 / .NET 11 usando o SDK oficial ModelContextProtocol 1.2. Cobre transporte stdio, atributos [McpServerTool], injeção de dependência, a armadilha do logging em stderr e o registro com Claude Code, Claude Desktop e VS Code."
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
lang: "pt-br"
translationOf: "2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11"
translatedBy: "claude"
translationDate: 2026-04-29
---

Se a fonte da verdade do seu time vive em um serviço .NET -- um banco EF Core, uma API interna, um runner de jobs Hangfire, uma Workspace API -- então expor isso a um agente de codificação via [Model Context Protocol](https://modelcontextprotocol.io/) é mais rápido do que o lado .NET da internet costuma anunciar. O SDK oficial em C# chegou ao `1.0` em 5 de março de 2026 e lançou `1.2.0` em 27 de março, ambos mantidos em conjunto pela Microsoft e pela Anthropic. O boilerplate agora é pequeno o suficiente para que o trabalho interessante esteja nos seus métodos de ferramenta, não no encanamento do protocolo.

Este guia constrói um servidor MCP real e executável em **C# 14 no .NET 11**, usando o pacote **`ModelContextProtocol` 1.2.0** contra a **especificação MCP 2025-11-25**. No final você terá um servidor `inventory-mcp` que expõe um banco SQLite a um agente por meio de três ferramentas, com injeção de dependência adequada, o truque de logging via stderr que a documentação só menciona de passagem, e os snippets de configuração exatos para Claude Code, Claude Desktop e o `mcp.json` do VS Code.

## Quando o SDK em C# é a escolha certa

Os times da Anthropic e do MCP publicam SDKs oficiais em TypeScript, Python e C#. Eles produzem tráfego idêntico no fio, então a pergunta não é "qual transporta melhor o protocolo" mas "onde já vive o código que quero expor". Dois casos onde C# vence:

- **Sua lógica de negócio já está em .NET.** Modelos EF Core, autenticação Microsoft.Identity.Web, jobs agendados Hangfire / Quartz, políticas de retry com Polly, uma API interna exposta via Refit. Reimplementar qualquer coisa disso em Python ou Node para que um agente possa chamar é trabalho desperdiçado. O SDK em C# permite colocar `[McpServerTool]` em um método e enviar.
- **Você quer o modelo padrão de hosting do .NET.** `IHostedService`, `IHttpClientFactory`, `IConfiguration`, logging estruturado via `Microsoft.Extensions.Logging`, OpenTelemetry. O SDK se conecta direto ao `Host.CreateApplicationBuilder`, então observabilidade e configuração ficam iguais às de qualquer outro serviço ASP.NET Core.

Para contexto sobre o protocolo em si, [a visão geral mais antiga sobre o `mcp` da Microsoft no .NET 10](/2026/01/microsoft-mcp-wiring-model-context-protocol-servers-from-c-on-net-10/) cobre a mentalidade contract-first; este post é a atualização concreta, no formato how-to, para .NET 11 e o SDK pós-1.0.

## Configuração do projeto com o SDK do .NET 11

Você precisa do SDK do .NET 11 (`dotnet --version` deve reportar `11.0.x` ou superior). O pacote `ModelContextProtocol` 1.2.0 mira `net8.0` e acima, então `net11.0` é suportado e te dá os recursos do C# 14 de graça.

```bash
# .NET 11 SDK, ModelContextProtocol 1.2.0
dotnet new console -n InventoryMcp
cd InventoryMcp
dotnet add package ModelContextProtocol --version 1.2.0
dotnet add package Microsoft.Extensions.Hosting --version 11.0.0
dotnet add package Microsoft.Data.Sqlite --version 11.0.0
```

A divisão dos pacotes fica assim, e a escolha importa:

- **`ModelContextProtocol`** -- pacote principal do servidor. Puxa as extensões de hosting e DI e o registro de ferramentas baseado em atributos. Escolha este para qualquer projeto que não precise do próprio host HTTP do ASP.NET Core.
- **`ModelContextProtocol.Core`** -- dependências mínimas para trabalho de cliente/servidor de baixo nível ou código de biblioteca. Sem `Microsoft.Extensions.Hosting` embutido.
- **`ModelContextProtocol.AspNetCore`** -- adiciona `WithHttpTransport()` e os endpoints de servidor streamable HTTP para implantações remotas.

Para um servidor stdio que você inicia a partir de um agente de codificação, só o primeiro é necessário.

O `.csproj` para .NET 11 fica mínimo:

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

## O Program.cs que não corrompe o stdout

O transporte stdio leva mensagens JSON-RPC sobre o par stdin/stdout do processo. O servidor lê requisições no stdin e escreve respostas no stdout. Qualquer outra coisa que toque o stdout -- um `Console.WriteLine` perdido, um `ILogger` com configuração padrão emitindo para stdout, um stack trace de exceção caindo em stdout em vez de stderr -- é injetada no fluxo JSON e o cliente mata a conexão com um erro de parse.

A integração de hosting do SDK em C# cuida das escritas do protocolo, mas você precisa redirecionar o logger de console para stderr ou vai perder os primeiros 30 minutos da sua vida correndo atrás de alertas "MCP server disconnected" no Claude Code:

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

Três coisas que vale fixar:

- `LogToStandardErrorThreshold = LogLevel.Trace` envia toda linha de log para stderr. Sem isso, `Microsoft.Extensions.Logging` escreve warnings e acima em stderr mas information e abaixo em stdout, o que silenciosamente corrompe o fluxo do protocolo no momento em que algo loga em nível info.
- `AppContext.BaseDirectory` ancora o caminho do SQLite ao lado do binário publicado. O processo do agente sobe o servidor com qualquer working directory que ele quiser, então não confie em `Environment.CurrentDirectory`.
- `WithToolsFromAssembly()` varre o assembly de entrada em busca de qualquer classe marcada com `[McpServerToolType]` e registra cada método marcado com `[McpServerTool]`. Você também pode fixar tipos específicos com `WithTools<EchoTool>().WithTools<MonkeyTools>()` se preferir registro explícito.

## Definindo as ferramentas

Cada ferramenta é um método em uma classe decorada com `[McpServerToolType]`. O método em si carrega `[McpServerTool, Description("...")]`. Os parâmetros do método viram o esquema de entrada; `[Description]` em cada parâmetro acaba no JSON Schema que o agente vê quando decide se chama a ferramenta.

O repositório é ADO.NET puro com `Microsoft.Data.Sqlite` para que o exemplo possa ser lido de ponta a ponta sem dança de ORM. O padrão funciona igual com EF Core 11 -- injete o `DbContext` e o loop de registro é idêntico:

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

A classe de ferramentas é a superfície que o agente vê:

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

Alguns detalhes que importam quando um agente realmente começa a chamar isso:

- **Injeção pelo construtor.** Métodos de ferramenta também podem receber serviços diretamente como parâmetros, mas um repositório como esse é compartilhado entre chamadas e pertence ao construtor. `WithToolsFromAssembly()` resolve ambos os estilos pelo container DI padrão.
- **Records como tipos de retorno.** O SDK serializa `Product` como saída JSON estruturada que o cliente pode mostrar como resultado tipado. Se você retornasse `IDictionary<string, object>` o agente ainda receberia texto, mas perderia o esquema e qualquer garantia de tipo.
- **`[Description]` importa mais que o nome do parâmetro.** "O nome do macaco para obter detalhes" é o que o agente lê quando escolhe uma ferramenta. Descrições vagas como "o SKU" roteiam o texto livre errado para a ferramenta errada. Seja específico, incluindo dicas de formato.
- **Lance exceções para erros no nível da ferramenta.** O SDK captura a exceção e a devolve ao cliente como um resultado de erro de ferramenta ao qual o modelo pode reagir. Você não precisa construir objetos `CallToolResult` à mão para o caso comum.
- **Apenas SQL parametrizado.** Um agente vai felizmente passar um SKU como `'; DROP TABLE products; --` se o prompt anterior tiver entrada do usuário. Use sempre placeholders `$param`.

## Conectando ao Claude Code, Claude Desktop e VS Code

Uma vez que `dotnet run` inicie o processo, registre-o no agente. Três formatos, o mesmo binário.

**Claude Code** tem um comando embutido para servidores stdio. A partir da raiz do projeto:

```bash
# Claude Code 2.x
claude mcp add inventory -- dotnet run --project ./InventoryMcp.csproj
```

Para um build publicado, troque para o binário:

```bash
dotnet publish -c Release -o publish
claude mcp add inventory -- ./publish/InventoryMcp
```

**Claude Desktop** usa o `claude_desktop_config.json`. No Windows ele fica em `%AppData%\Claude\claude_desktop_config.json`; no macOS em `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

Reinicie o Claude Desktop, e o indicador MCP deve listar `list_products`, `get_product` e `adjust_stock`. Pergunte "Quais produtos estão com estoque baixo?" e veja-o chamar `list_products(lowStockOnly: true)`.

**VS Code** usa `.vscode/mcp.json` para servidores no escopo do workspace:

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

Para uma noção de como uma IDE empacota servidores MCP nativamente em vez de passar pela configuração do usuário, [o Azure MCP Server dentro do Visual Studio 2022 17.14.30](/pt-br/2026/04/azure-mcp-server-visual-studio-2022-17-14-30/) é uma referência útil.

## Quando stdio está errado: o formato do transporte HTTP

Stdio é correto para "agente na minha máquina, servidor na minha máquina, um cliente por processo". No instante em que você quer um servidor de longa vida que outros desenvolvedores conectam remotamente, troque o pacote e o registro:

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

`MapMcp()` expõe os endpoints streamable HTTP e SSE que a spec define. Coloque atrás do seu pipeline de auth do ASP.NET Core habitual e você ganha consentimento incremental de escopos OAuth 2.0, descoberta well-known de autorização e o polling de requisições de longa duração que entrou na release 1.0, tudo de graça.

## Pegadinhas de produção que a documentação subestima

**Não use uma única conexão `Microsoft.Data.Sqlite`.** O exemplo acima abre uma conexão nova por chamada, o que é o padrão certo para uma demo de SDK. Para cargas além de um banco hobby, registre `SqliteConnection` como serviço transient ou monte EF Core 11 com pooling. SQLite serializa escritas por padrão; se duas chamadas a `AdjustStock` disparam ao mesmo tempo, você verá `SQLITE_BUSY` quando a contenção de lock cruzar algumas centenas de ms.

**Cancellation tokens.** Métodos de ferramenta podem receber um parâmetro `CancellationToken` no final e o SDK conecta o token por requisição. Se sua ferramenta chama `HttpClient`, EF Core ou qualquer I/O, aceite o token e repasse-o. Caso contrário, um modelo se comportando mal que dá timeout deixa uma transação SQLite ou requisição HTTP penduradas no servidor.

**`IHttpClientFactory` para chamadas externas.** Quando uma ferramenta busca de uma API externa, injete `IHttpClientFactory` e crie clients nomeados. As mesmas regras de tempo de vida que mordem apps ASP.NET Core -- esgotamento de sockets por `new HttpClient()`, DNS pinning -- mordem servidores MCP com mais força, porque eles tendem a ficar em execução através de muitas sessões de agente.

**Volume de logging.** Um `LogInformation` falador por chamada de ferramenta está ok. Logar a entrada inteira da ferramenta a cada chamada vaza PII para stderr e acaba na transcrição do Claude Code, que o usuário pode não perceber estar sendo capturada. Trate logs de chamada de ferramenta do mesmo jeito que trata logs de requisição web: redija segredos, resuma entradas.

**Surpresas de serialização JSON.** O SDK usa `System.Text.Json` com as opções padrão. Se seus tipos de domínio dependem de atributos do `Newtonsoft.Json` ou de casing fora do padrão, configure as opções JSON no host ou converta para records simples na fronteira da ferramenta. Um tipo que serializa de um jeito para seus clients REST e de outro para clients MCP é um pesadelo de depuração.

**Native AOT.** O pacote `ModelContextProtocol` ainda não é totalmente AOT-friendly porque a descoberta de ferramentas guiada por atributos usa reflection. Se você precisa de um executável AOT em arquivo único para distribuição, use `ModelContextProtocol.Core` e registre ferramentas manualmente com `MapTool` em vez de `WithToolsFromAssembly`.

## O que esse padrão destrava para uma loja .NET

O movimento central -- decorar um método, retornar um record, lançar em erros -- escala para toda integração C# que seu time já tem. Alguns próximos passos óbvios:

- Envolver um `DbContext` do EF Core 11 e expor introspecção de esquema mais uma ferramenta de consulta parametrizada, para que um agente possa responder "quantos pedidos enviaram na semana passada" sem você escrever o SQL. Os recursos mais novos do EF Core combinam bem; veja [Busca vetorial no SQL Server com índices DiskANN no EF Core 11](/pt-br/2026/04/efcore-11-sql-server-vector-search-diskann-indexes/) para uma primitiva de recuperação particularmente amigável a agentes.
- Envolver um agendador Hangfire / Quartz e deixar o agente inspecionar ou disparar jobs em background.
- Envolver um cliente Refit interno em torno da sua API real, com o pipeline de auth existente, para que o agente fale com a mesma superfície que seus apps falam.

Se você principalmente trabalha em outra linguagem, [o servidor equivalente em TypeScript que envolve um CLI](/pt-br/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) cobre Node.js com `@modelcontextprotocol/sdk`, e [o guia em Python usando o SDK oficial `mcp`](/2026/04/how-to-build-a-custom-mcp-server-in-python-with-the-official-sdk/) cobre o padrão FastMCP. E se você estiver olhando além do MCP para orquestração multi-agente em C#, [Microsoft Agent Framework 1.0](/pt-br/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) pega de onde o MCP para, com planejadores, handoff multi-agente e estado de execução durável.

O servidor MCP em si não se importa se sua ferramenta envolve um banco SQLite, um hub SignalR ou um serviço de domínio de 500 linhas. Ele só precisa de parâmetros tipados (os atributos do C# te dão isso de graça), um valor de retorno que o SDK consegue serializar e um fluxo stdio sem bytes perdidos.

## Links de origem

- [`modelcontextprotocol/csharp-sdk` no GitHub](https://github.com/modelcontextprotocol/csharp-sdk) -- repositório oficial, mantido por Anthropic e Microsoft.
- [`ModelContextProtocol` 1.2.0 no NuGet](https://www.nuget.org/packages/ModelContextProtocol/) -- pacote principal do servidor.
- [.NET Blog: Release v1.0 of the official MCP C# SDK](https://devblogs.microsoft.com/dotnet/release-v10-of-the-official-mcp-csharp-sdk/) -- notas da release 1.0 de 5 de março de 2026.
- [.NET Blog: Build a Model Context Protocol (MCP) server in C#](https://devblogs.microsoft.com/dotnet/build-a-model-context-protocol-mcp-server-in-csharp/) -- o passo a passo canônico da Microsoft.
- [Especificação MCP 2025-11-25](https://modelcontextprotocol.io/specification/) -- a versão da spec implementada pelo SDK 1.x.
