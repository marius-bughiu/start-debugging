---
title: "Como registrar o SQL que o EF Core 11 gera"
description: "Veja o SQL exato que o Entity Framework Core 11 envia ao seu banco de dados, com valores de parâmetros, usando LogTo, Microsoft.Extensions.Logging e ToQueryString."
pubDate: 2026-07-19
tags:
  - "ef-core"
  - "dotnet"
  - "csharp"
  - "logging"
lang: "pt-br"
translationOf: "2026/07/how-to-log-the-sql-that-ef-core-11-generates"
translatedBy: "claude"
translationDate: 2026-07-19
---

A forma mais rápida de ver o SQL que o Entity Framework Core 11 gera é chamar `LogTo(Console.WriteLine)` no seu `DbContextOptionsBuilder`. Isso imprime cada comando que o EF Core envia ao banco de dados, no nível `Information`, sob a categoria `Microsoft.EntityFrameworkCore.Database.Command`. Em um aplicativo ASP.NET Core, normalmente você nem precisa disso: defina `Microsoft.EntityFrameworkCore.Database.Command` como `Information` no `appsettings.json` e o SQL flui pelo log que você já tem. Para ver os valores reais dos parâmetros em vez de `?`, adicione `EnableSensitiveDataLogging()`. Para obter o SQL de uma única consulta sem executá-la, chame `.ToQueryString()`.

Este artigo cobre todas essas opções, quando cada uma é a ferramenta certa e os detalhes que fazem as pessoas tropeçarem: por que você não vê nada por padrão, por que os parâmetros ficam ocultos e por que você nunca deve levar `EnableSensitiveDataLogging` para produção. Tudo aqui é válido para o EF Core 11 e o C# 14 no .NET 11.

## Por que você não vê SQL por padrão

O EF Core não registra nada a menos que você diga para onde enviar os logs. Isso é intencional. Construir uma mensagem de log tem um custo, então o EF Core pula o trabalho por completo quando não há nenhum destino configurado. É uma mudança de mentalidade em relação ao EF6, onde `Database.Log` podia ser anexado a qualquer momento. No EF Core, o log é configurado uma vez, na inicialização do contexto, e o framework gera mensagens apenas quando há um destino presente.

Cada comando SQL que o EF Core executa é registrado como um único evento: `RelationalEventId.CommandExecuted`, evento com ID `20101`, na categoria `Microsoft.EntityFrameworkCore.Database.Command`, no nível `LogLevel.Information`. Esse último detalhe importa. Se o seu log estiver filtrado para `Warning` ou acima, que é um padrão comum em produção, o SQL é gerado internamente, mas nunca chega ao seu destino. Ver o SQL quase sempre é uma questão de baixar o nível para essa única categoria, e não de acionar algum interruptor especial.

## A linha única: LogTo

`LogTo` é o "log simples" embutido do EF Core. Não precisa de pacote NuGet nem de injeção de dependência. Ele recebe um `Action<string>` que o EF Core chama uma vez por mensagem de log.

```csharp
// EF Core 11, C# 14, .NET 11
public sealed class AppDbContext : DbContext
{
    protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
        => optionsBuilder
            .UseSqlServer("Server=(localdb)\\mssqllocaldb;Database=Shop;Trusted_Connection=True")
            .LogTo(Console.WriteLine);

    public DbSet<Order> Orders => Set<Order>();
}
```

Execute uma consulta e você obtém o comando, seus parâmetros, o tempo e o texto SQL:

```output
info: RelationalEventId.CommandExecuted[20101] (Microsoft.EntityFrameworkCore.Database.Command)
      Executed DbCommand (3ms) [Parameters=[@__customerId_0='?' (DbType = Int32)], CommandType='Text', CommandTimeout='30']
      SELECT [o].[Id], [o].[CustomerId], [o].[Total]
      FROM [Orders] AS [o]
      WHERE [o].[CustomerId] = @__customerId_0
```

`OnConfiguring` ainda é executado mesmo quando você constrói o contexto por meio de `AddDbContext` ou passa um `DbContextOptions` já criado, então este é o único lugar para colocar a configuração de log, independentemente de como o contexto seja construído. Se você já registra as opções no `Program.cs`, pode encadear `LogTo` ali:

```csharp
// EF Core 11, .NET 11 - Program.cs
builder.Services.AddDbContext<AppDbContext>(options =>
    options
        .UseSqlServer(connectionString)
        .LogTo(Console.WriteLine, LogLevel.Information));
```

O segundo argumento eleva o nível mínimo. Por padrão, `LogTo` emite tudo no nível `Debug` e acima, o que é ruidoso. Passar `LogLevel.Information` reduz isso ao acesso ao banco de dados mais algumas mensagens de manutenção, que geralmente é o que você realmente quer quando está atrás de uma consulta.

## Mostrar os valores dos parâmetros em vez de pontos de interrogação

Repare no `@__customerId_0='?'` da saída acima. O EF Core oculta os valores dos parâmetros por padrão porque podem ser dados pessoais ou sensíveis que não devem parar em um arquivo de log. Quando você está depurando localmente e precisa ver qual valor foi realmente enviado, ative o log de dados sensíveis:

```csharp
// EF Core 11 - only ever do this in Development
optionsBuilder
    .UseSqlServer(connectionString)
    .LogTo(Console.WriteLine, LogLevel.Information)
    .EnableSensitiveDataLogging();
```

Agora o parâmetro é materializado:

```output
Executed DbCommand (2ms) [Parameters=[@__customerId_0='42' (DbType = Int32)], ...]
SELECT [o].[Id], [o].[CustomerId], [o].[Total]
FROM [Orders] AS [o]
WHERE [o].[CustomerId] = @__customerId_0
```

Proteja isso atrás de uma verificação de ambiente para que nunca seja ativado em produção. Um log de consultas vazado com valores de chave reais é um risco genuíno de exposição de dados:

```csharp
// EF Core 11, .NET 11
optionsBuilder.UseSqlServer(connectionString);
if (builder.Environment.IsDevelopment())
{
    optionsBuilder
        .LogTo(Console.WriteLine, LogLevel.Information)
        .EnableSensitiveDataLogging();
}
```

Já que você está aqui, `EnableDetailedErrors()` é um bom complemento. O EF Core pula os blocos try-catch por valor por questões de desempenho, o que torna alguns erros (por exemplo, um `NULL` que retorna para uma propriedade não anulável) difíceis de associar a um campo específico. `EnableDetailedErrors()` reintroduz essas verificações e dá a você uma mensagem que nomeia a propriedade culpada. É um auxílio de depuração, não uma configuração de produção.

## O jeito do ASP.NET Core: Microsoft.Extensions.Logging

Em um aplicativo ASP.NET Core, você raramente precisa de `LogTo`. `AddDbContext` e `AddDbContextPool` conectam automaticamente o EF Core ao pipeline de `Microsoft.Extensions.Logging` do aplicativo, então o SQL do EF Core flui pelo mesmo logger, provedores e filtros que o resto do seu aplicativo. Você o controla inteiramente a partir do `appsettings.json` definindo o nível para a categoria do comando:

```json
{
  "Logging": {
    "LogLevel": {
      "Default": "Information",
      "Microsoft.AspNetCore": "Warning",
      "Microsoft.EntityFrameworkCore.Database.Command": "Information"
    }
  }
}
```

Essa única linha é todo o truque. A categoria é hierárquica, então `Microsoft.EntityFrameworkCore.Database.Command` mira exatamente os eventos de comandos executados e nada mais. Coloque-a no `appsettings.Development.json` para ver o SQL localmente enquanto mantém a produção silenciosa, e depois ative-a sem um novo deploy quando precisar diagnosticar algo em um ambiente em execução.

Se preferir manter tudo em código, ou você está em um aplicativo de console usando o host genérico, registre um `ILoggerFactory` e o entregue ao EF Core com `UseLoggerFactory`. Armazene a fábrica como uma única instância compartilhada; criar uma por contexto causa vazamento de memória e anula o cache interno.

```csharp
// EF Core 11, .NET 11
public static readonly ILoggerFactory DbLoggerFactory =
    LoggerFactory.Create(b => b.AddConsole().AddFilter(
        "Microsoft.EntityFrameworkCore.Database.Command", LogLevel.Information));

protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
    => optionsBuilder
        .UseSqlServer(connectionString)
        .UseLoggerFactory(DbLoggerFactory);
```

Como esse caminho é `Microsoft.Extensions.Logging` padrão, qualquer provedor se conecta da mesma forma. Se você direciona os logs através do Serilog, o SQL do EF Core chega aos seus destinos sem nenhuma configuração específica de EF adicional. Esse é o mesmo pipeline coberto em [log estruturado com Serilog e Seq](/pt-br/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/); o EF Core é apenas mais uma categoria alimentando-o.

## Filtrar até restar só o SQL

`LogTo` oferece três formas de estreitar o fluxo apenas para os comandos que interessam a você. A mais legível é por categoria. Use os nomes fortemente tipados de `DbLoggerCategory` para não codificar strings à mão:

```csharp
// EF Core 11 - only database interactions
optionsBuilder.LogTo(
    Console.WriteLine,
    new[] { DbLoggerCategory.Database.Command.Name },
    LogLevel.Information);
```

Você também pode filtrar por ID de evento quando quer um evento preciso e nada mais. Para apenas o SQL bruto, esse é `RelationalEventId.CommandExecuted`:

```csharp
// EF Core 11 - only the executed-command event
optionsBuilder.LogTo(
    Console.WriteLine,
    new[] { RelationalEventId.CommandExecuted });
```

E para qualquer coisa que as opções embutidas não consigam expressar, passe um predicado sobre `(eventId, logLevel)`. Isso filtra no caminho quente do EF Core, antes de a string da mensagem ser construída, então é mais barato do que filtrar dentro do seu delegate:

```csharp
// EF Core 11 - custom filter
optionsBuilder.LogTo(
    Console.WriteLine,
    (eventId, level) => eventId == RelationalEventId.CommandExecuted);
```

Filtrar aqui é como manter os logs de consultas legíveis quando você está caçando um problema específico, como identificar o `SELECT` idêntico e repetido que denuncia um laço de carregamento tardio. Se é isso que você está caçando, o filtro por categoria mais uma varredura da saída é exatamente a versão manual de [detectar consultas N+1 no EF Core 11](/pt-br/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/).

## Enviar os logs para um arquivo

`LogTo` recebe qualquer `Action<string>`, então escrever em um arquivo é só uma questão de apontá-lo para um `StreamWriter`. Libere o writer quando o contexto for liberado para que o arquivo feche de forma limpa:

```csharp
// EF Core 11, .NET 11
public sealed class AppDbContext : DbContext
{
    private readonly StreamWriter _log = new("ef-sql.log", append: true);

    protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
        => optionsBuilder
            .UseSqlServer(connectionString)
            .LogTo(_log.WriteLine, LogLevel.Information);

    public override void Dispose()
    {
        base.Dispose();
        _log.Dispose();
    }

    public override async ValueTask DisposeAsync()
    {
        await base.DisposeAsync();
        await _log.DisposeAsync();
    }
}
```

Para um arquivo mais enxuto, peça saída de linha única e carimbos de tempo UTC via `DbContextLoggerOptions`:

```csharp
// EF Core 11 - compact one-line-per-message format
optionsBuilder.LogTo(
    _log.WriteLine,
    LogLevel.Information,
    DbContextLoggerOptions.UtcTime | DbContextLoggerOptions.SingleLine);
```

Para qualquer coisa além de um arquivo de depuração descartável, prefira rotear através de `Microsoft.Extensions.Logging` e um destino de arquivo de verdade. `LogTo` para um `StreamWriter` serve para uma olhada rápida; não é uma estratégia de log para produção.

## Obter o SQL de uma consulta sem executá-la

Às vezes você não quer uma mangueira com cada comando. Você tem uma consulta LINQ e quer ver o SQL que ela vai produzir. `ToQueryString()` renderiza o SQL de um `IQueryable` sem executá-lo contra o banco de dados:

```csharp
// EF Core 11, C# 14
var query = db.Orders
    .Where(o => o.Total > 100)
    .OrderByDescending(o => o.Total);

Console.WriteLine(query.ToQueryString());
```

```output
SELECT [o].[Id], [o].[CustomerId], [o].[Total]
FROM [Orders] AS [o]
WHERE [o].[Total] > 100.0
ORDER BY [o].[Total] DESC
```

Esta é a ferramenta a que recorrer quando você está refinando uma consulta em um teste ou em um endpoint de rascunho, porque não há configuração de log para preparar nem outro ruído. Ela só funciona para consultas (`IQueryable`), não para `SaveChanges`, `ExecuteUpdate` ou `ExecuteDelete`; para esses, recorra ao `LogTo` ou à categoria do comando. Se você está raciocinando sobre o SQL que as operações em massa emitem, as formas mostradas em [ExecuteUpdate e ExecuteDelete para escritas em massa](/pt-br/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) são o que você verá no log de comandos.

## Detalhes que vale a pena conhecer

**`CommandExecuted` dispara após a ida e volta.** O evento `20101` carrega o tempo, então ele é registrado assim que o comando retorna. Se uma consulta travar, você não verá o SQL dela no log de execução porque ela nunca se completou. Fique atento ao `CommandExecuting` (`20100`) se precisar do SQL antes da execução, ou use `ToQueryString()` para inspecioná-lo estaticamente.

**A configuração é fixada na inicialização.** Você não pode anexar nem desanexar `LogTo` depois que o contexto é construído. Se quiser um interruptor em tempo de execução, capture o delegate e faça a verificação de nulo: `optionsBuilder.LogTo(s => _sink?.Invoke(s))`, e depois defina `_sink` sob demanda. Isso espelha o antigo comportamento de `Database.Log` do EF6.

**Não chame `LogTo` duas vezes com a intenção de adicionar destinos.** Uma segunda chamada substitui a configuração em vez de somar-se a ela. Para distribuir para vários destinos, escreva um delegate que encaminhe para cada um.

**O log de dados sensíveis e os erros detalhados são ambos apenas para desenvolvimento.** `EnableSensitiveDataLogging` coloca valores reais de parâmetros, incluindo chaves e dados pessoais, nos seus logs. `EnableDetailedErrors` adiciona sobrecarga por leitura. Proteja ambos atrás de uma verificação de ambiente. Aqui também é onde um log inesperadamente ruidoso pode vazar mais do que você pretende, então revise o que os seus destinos retêm.

**A categoria, e não um interruptor, é o seu controle de produção.** Em um aplicativo implantado, deixe o EF Core conectado ao `Microsoft.Extensions.Logging` e dirija a visibilidade puramente através do nível de `Microsoft.EntityFrameworkCore.Database.Command`. Você obtém SQL sob demanda mudando um único valor de configuração, e nunca envia um `LogTo(Console.WriteLine)` que esqueceu de remover.

Ler o SQL gerado é o primeiro movimento em quase toda investigação de desempenho do EF Core, de uma consulta que se avalia silenciosamente no cliente a uma migração que emite mais do que você esperava. Uma vez que você consegue vê-lo, as correções em [a expressão LINQ não pôde ser traduzida](/pt-br/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/) e as notas de mudanças significativas em [migrar do EF Core 6 para o EF Core 11](/pt-br/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) ficam bem mais fáceis de aplicar, porque você está depurando o SQL real em vez de adivinhá-lo.

## Fontes

- [EF Core simple logging (LogTo) - Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/simple-logging)
- [Using Microsoft.Extensions.Logging with EF Core - Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/extensions-logging)
- [ToQueryString / viewing generated SQL - Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/querying/#viewing-generated-sql)
- [RelationalEventId.CommandExecuted - .NET API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.diagnostics.relationaleventid.commandexecuted)
