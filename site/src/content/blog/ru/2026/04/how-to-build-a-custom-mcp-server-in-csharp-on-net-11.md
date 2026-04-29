---
title: "Как построить собственный MCP-сервер на C# в .NET 11"
description: "Постройте рабочий сервер Model Context Protocol на C# 14 / .NET 11, используя официальный SDK ModelContextProtocol 1.2. Рассмотрены транспорт stdio, атрибуты [McpServerTool], внедрение зависимостей, ловушка с журналированием в stderr и регистрация в Claude Code, Claude Desktop и VS Code."
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
lang: "ru"
translationOf: "2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11"
translatedBy: "claude"
translationDate: 2026-04-29
---

Если источник истины вашей команды живёт в .NET-сервисе -- база данных EF Core, внутреннее API, раннер задач Hangfire, Workspace API -- то выставить его агенту-кодеру через [Model Context Protocol](https://modelcontextprotocol.io/) быстрее, чем обычно рекламирует .NET-уголок интернета. Официальный C#-SDK достиг `1.0` 5 марта 2026 года и выпустил `1.2.0` 27 марта; обе версии поддерживаются совместно Microsoft и Anthropic. Шаблонного кода теперь достаточно мало, чтобы интересная работа была в ваших методах-инструментах, а не в сантехнике протокола.

Это руководство строит реальный, запускаемый MCP-сервер на **C# 14 в .NET 11**, используя пакет **`ModelContextProtocol` 1.2.0** на основе **спецификации MCP 2025-11-25**. К концу у вас будет сервер `inventory-mcp`, выставляющий агенту базу SQLite через три инструмента, с правильным внедрением зависимостей, фокусом с журналированием в stderr, который документация упоминает лишь мимоходом, и точными фрагментами конфигурации для Claude Code, Claude Desktop и `mcp.json` в VS Code.

## Когда C#-SDK -- правильный выбор

Команды Anthropic и MCP выпускают официальные SDK на TypeScript, Python и C#. Они производят идентичный трафик по проводу, поэтому вопрос не "какой лучше передаёт протокол", а "где уже живёт код, который я хочу выставить". Два случая, в которых C# выигрывает:

- **Ваша бизнес-логика уже на .NET.** Модели EF Core, аутентификация Microsoft.Identity.Web, плановые задачи Hangfire / Quartz, политики повторов Polly, внутреннее API через Refit. Переписывать что-либо из этого на Python или Node, чтобы агент мог это вызвать, -- пустая трата времени. C#-SDK позволяет поставить `[McpServerTool]` на метод и отгружать.
- **Вы хотите стандартную модель хостинга .NET.** `IHostedService`, `IHttpClientFactory`, `IConfiguration`, структурированное журналирование через `Microsoft.Extensions.Logging`, OpenTelemetry. SDK подключается напрямую к `Host.CreateApplicationBuilder`, поэтому наблюдаемость и конфигурация выглядят так же, как в любом другом ASP.NET Core-сервисе.

Для контекста по самому протоколу [более старый обзор обвязки `mcp` от Microsoft для .NET 10](/2026/01/microsoft-mcp-wiring-model-context-protocol-servers-from-c-on-net-10/) описывает мышление "контракт прежде всего"; этот пост -- конкретное how-to-обновление для .NET 11 и пост-1.0 SDK.

## Настройка проекта на .NET 11 SDK

Вам нужен .NET 11 SDK (`dotnet --version` должна сообщать `11.0.x` или выше). Пакет `ModelContextProtocol` 1.2.0 нацелен на `net8.0` и выше, так что `net11.0` поддерживается, и вы получаете возможности C# 14 бесплатно.

```bash
# .NET 11 SDK, ModelContextProtocol 1.2.0
dotnet new console -n InventoryMcp
cd InventoryMcp
dotnet add package ModelContextProtocol --version 1.2.0
dotnet add package Microsoft.Extensions.Hosting --version 11.0.0
dotnet add package Microsoft.Data.Sqlite --version 11.0.0
```

Разделение пакетов выглядит так, и выбор имеет значение:

- **`ModelContextProtocol`** -- основной серверный пакет. Подтягивает расширения хостинга и внедрения зависимостей и регистрацию инструментов на основе атрибутов. Выбирайте его для любого проекта, которому не нужен собственный HTTP-хост ASP.NET Core.
- **`ModelContextProtocol.Core`** -- минимальные зависимости для низкоуровневой клиент-серверной работы или библиотечного кода. Без встроенного `Microsoft.Extensions.Hosting`.
- **`ModelContextProtocol.AspNetCore`** -- добавляет `WithHttpTransport()` и серверные эндпоинты streamable HTTP для удалённых развёртываний.

Для stdio-сервера, который вы запускаете из агента-кодера, нужен только первый.

`.csproj` для .NET 11 получается минимальным:

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

## Program.cs, не портящий stdout

Транспорт stdio переносит JSON-RPC-сообщения через пару stdin/stdout процесса. Сервер читает запросы из stdin и пишет ответы в stdout. Всё, что ещё прикасается к stdout -- случайный `Console.WriteLine`, стандартно сконфигурированный `ILogger`, отдающий в stdout, стек-трейс исключения, упавший в stdout вместо stderr, -- внедряется в JSON-поток, и клиент убивает соединение с ошибкой парсинга.

Интеграция хостинга C#-SDK обрабатывает запись протокола, но вам нужно перенаправить console-логгер на stderr, иначе вы потеряете первые 30 минут жизни, гоняясь за алертами "MCP server disconnected" в Claude Code:

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

Три момента, которые стоит зафиксировать:

- `LogToStandardErrorThreshold = LogLevel.Trace` отправляет каждую строку лога в stderr. Без этого `Microsoft.Extensions.Logging` пишет warning и выше в stderr, а information и ниже -- в stdout, что незаметно портит поток протокола, как только что-то залогируется на уровне info.
- `AppContext.BaseDirectory` привязывает путь SQLite к каталогу опубликованной бинарки. Процесс агента запускает сервер с произвольной рабочей директорией, поэтому не полагайтесь на `Environment.CurrentDirectory`.
- `WithToolsFromAssembly()` сканирует входную сборку в поисках любого класса с `[McpServerToolType]` и регистрирует каждый метод с `[McpServerTool]`. Можно также прибить конкретные типы вызовами `WithTools<EchoTool>().WithTools<MonkeyTools>()`, если предпочитаете явную регистрацию.

## Определение инструментов

Каждый инструмент -- это метод класса, помеченного `[McpServerToolType]`. Сам метод несёт `[McpServerTool, Description("...")]`. Параметры метода становятся входной схемой; `[Description]` на каждом параметре оказывается в JSON Schema, который агент видит, решая, вызвать инструмент или нет.

Репозиторий -- обычный ADO.NET с `Microsoft.Data.Sqlite`, чтобы пример читался от начала до конца без танца с ORM. Паттерн работает так же с EF Core 11 -- внедрите `DbContext`, цикл регистрации идентичен:

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

Класс инструментов -- это поверхность, которую видит агент:

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

Несколько деталей, которые имеют значение, как только агент действительно начинает это вызывать:

- **Внедрение через конструктор.** Методы инструмента могут принимать сервисы как параметры напрямую, но репозиторий вроде этого общий между вызовами и принадлежит конструктору. `WithToolsFromAssembly()` разрешает оба стиля через стандартный DI-контейнер.
- **Record как тип возвращаемого значения.** SDK сериализует `Product` в структурированный JSON-выход, который клиент может показать как типизированный результат. Если бы вы возвращали `IDictionary<string, object>`, агент всё равно получил бы текст, но потерял бы схему и любые гарантии типов.
- **`[Description]` важнее, чем имя параметра.** "Имя обезьяны, для которой нужно получить детали" -- это то, что агент читает, выбирая инструмент. Размытые описания вроде "SKU" направляют не тот свободный текст не в тот инструмент. Будьте конкретны, включая подсказки по формату.
- **Бросайте исключения для ошибок на уровне инструмента.** SDK перехватывает исключение и возвращает его клиенту как результат-ошибку инструмента, на который модель может отреагировать. Конструировать объекты `CallToolResult` вручную в обычном случае не нужно.
- **Только параметризованный SQL.** Агент с радостью передаст SKU вроде `'; DROP TABLE products; --`, если в восходящем промпте есть пользовательский ввод. Всегда используйте плейсхолдеры `$param`.

## Подключение к Claude Code, Claude Desktop и VS Code

Как только `dotnet run` запускает процесс, зарегистрируйте его у агента. Три формата, одна и та же бинарка.

**Claude Code** имеет встроенную команду для stdio-серверов. Из корня проекта:

```bash
# Claude Code 2.x
claude mcp add inventory -- dotnet run --project ./InventoryMcp.csproj
```

Для опубликованной сборки переключитесь на бинарку:

```bash
dotnet publish -c Release -o publish
claude mcp add inventory -- ./publish/InventoryMcp
```

**Claude Desktop** использует `claude_desktop_config.json`. На Windows он живёт в `%AppData%\Claude\claude_desktop_config.json`; на macOS -- в `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

Перезапустите Claude Desktop, и MCP-индикатор должен показать `list_products`, `get_product` и `adjust_stock`. Спросите "Каких товаров мало на складе?" и наблюдайте, как он вызывает `list_products(lowStockOnly: true)`.

**VS Code** использует `.vscode/mcp.json` для серверов в области рабочего пространства:

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

Чтобы понять, как IDE упаковывает MCP-серверы нативно вместо обхода через пользовательскую конфигурацию, [Azure MCP Server в Visual Studio 2022 17.14.30](/ru/2026/04/azure-mcp-server-visual-studio-2022-17-14-30/) -- полезный ориентир.

## Когда stdio неуместен: форма HTTP-транспорта

Stdio корректен для "агент на моей машине, сервер на моей машине, один клиент на процесс". Как только вам понадобится долгоживущий сервер, к которому удалённо подключаются другие разработчики, поменяйте пакет и регистрацию:

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

`MapMcp()` выставляет streamable HTTP- и SSE-эндпоинты, определённые спецификацией. Поставьте его за свой обычный auth-конвейер ASP.NET Core -- и получите бесплатно инкрементальное согласие на scope OAuth 2.0, well-known-обнаружение авторизации и поллинг долгоживущих запросов, появившийся в релизе 1.0.

## Производственные подводные камни, которые документация недооценивает

**Не отгружайте одно соединение `Microsoft.Data.Sqlite`.** Пример выше открывает свежее соединение на каждый вызов, что -- правильное поведение по умолчанию для демо SDK. Для нагрузок выше хобби-базы зарегистрируйте `SqliteConnection` как transient-сервис или подключите EF Core 11 с пулом соединений. SQLite по умолчанию сериализует записи; если два вызова `AdjustStock` срабатывают одновременно, вы увидите `SQLITE_BUSY`, как только конкуренция за блокировку перевалит несколько сотен мс.

**Токены отмены.** Методы инструмента могут принимать завершающим параметром `CancellationToken`, и SDK прокинет токен на запрос. Если ваш инструмент вызывает `HttpClient`, EF Core или любой ввод/вывод, принимайте токен и пробрасывайте дальше. Иначе плохо ведущая себя модель, ушедшая в таймаут, оставит зависшую транзакцию SQLite или HTTP-запрос на сервере.

**`IHttpClientFactory` для исходящих вызовов.** Когда инструмент тянет данные из внешнего API, внедряйте `IHttpClientFactory` и создавайте именованных клиентов. Те же правила времени жизни, которые кусают приложения ASP.NET Core, -- исчерпание сокетов от `new HttpClient()`, фиксация DNS -- кусают MCP-серверы сильнее, потому что они склонны жить через множество сессий агента.

**Объём журналирования.** Болтливый `LogInformation` на каждый вызов инструмента -- нормально. Логирование всего входа инструмента при каждом вызове утечёт PII в stderr и попадёт в транскрипт Claude Code, а пользователь может не осознавать, что это записывается. Относитесь к логам вызова инструмента так же, как к логам веб-запросов: маскируйте секреты, кратко излагайте входы.

**Сюрпризы JSON-сериализации.** SDK использует `System.Text.Json` с настройками по умолчанию. Если ваши доменные типы полагаются на атрибуты `Newtonsoft.Json` или нестандартный регистр имён, настройте JSON-опции на хосте или преобразуйте в простые record на границе инструмента. Тип, сериализующийся одним способом для ваших REST-клиентов и другим для MCP-клиентов, -- кошмар отладки.

**Native AOT.** Пакет `ModelContextProtocol` пока не полностью совместим с AOT, потому что управляемое атрибутами обнаружение инструментов использует рефлексию. Если нужен однофайловый AOT-исполняемый файл для распространения, используйте `ModelContextProtocol.Core` и регистрируйте инструменты вручную через `MapTool` вместо `WithToolsFromAssembly`.

## Что этот паттерн открывает для .NET-команды

Главный приём -- украсить метод, вернуть record, бросать исключения при ошибках -- масштабируется на любую интеграцию C#, что у вашей команды уже есть. Несколько очевидных следующих шагов:

- Оберните `DbContext` EF Core 11 и выставьте интроспекцию схемы плюс инструмент параметризованного запроса, чтобы агент мог отвечать на "сколько заказов было отгружено на прошлой неделе" без того, чтобы вы писали SQL. Свежие фичи EF Core хорошо сочетаются; см. [Векторный поиск SQL Server с индексами DiskANN в EF Core 11](/ru/2026/04/efcore-11-sql-server-vector-search-diskann-indexes/) для особенно дружественной к агентам примитива поиска.
- Оберните планировщик Hangfire / Quartz и позвольте агенту инспектировать или запускать фоновые задачи.
- Оберните внутренний клиент Refit вокруг вашего реального API с существующим auth-конвейером, чтобы агент общался с той же поверхностью, что и ваши приложения.

Если вы в основном работаете на другом языке, [эквивалентный сервер на TypeScript, оборачивающий CLI](/ru/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) покрывает Node.js с `@modelcontextprotocol/sdk`, а [руководство по Python с использованием официального SDK `mcp`](/2026/04/how-to-build-a-custom-mcp-server-in-python-with-the-official-sdk/) покрывает паттерн FastMCP. И если вы смотрите за пределы MCP -- на мульти-агентную оркестрацию на C#, [Microsoft Agent Framework 1.0](/ru/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) подхватывает там, где MCP останавливается, с планировщиками, мульти-агентным handoff и долговечным состоянием прогона.

Самому MCP-серверу всё равно, оборачивает ли ваш инструмент базу SQLite, hub SignalR или 500-строчный доменный сервис. Ему нужны только типизированные параметры (атрибуты C# дают это бесплатно), значение возврата, которое SDK может сериализовать, и stdio-поток без заблудших байтов.

## Ссылки на источники

- [`modelcontextprotocol/csharp-sdk` на GitHub](https://github.com/modelcontextprotocol/csharp-sdk) -- официальный репозиторий, поддерживается Anthropic и Microsoft.
- [`ModelContextProtocol` 1.2.0 на NuGet](https://www.nuget.org/packages/ModelContextProtocol/) -- основной серверный пакет.
- [.NET Blog: Release v1.0 of the official MCP C# SDK](https://devblogs.microsoft.com/dotnet/release-v10-of-the-official-mcp-csharp-sdk/) -- заметки к релизу 1.0 от 5 марта 2026.
- [.NET Blog: Build a Model Context Protocol (MCP) server in C#](https://devblogs.microsoft.com/dotnet/build-a-model-context-protocol-mcp-server-in-csharp/) -- канонический разбор от Microsoft.
- [Спецификация MCP 2025-11-25](https://modelcontextprotocol.io/specification/) -- версия спецификации, реализованная SDK 1.x.
