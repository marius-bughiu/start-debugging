---
title: ".NET Extensions 10.11: logs em buffer finalmente podem manter seus scopes"
description: "Microsoft.Extensions.Telemetry 10.11.0, lançado em 2026-10-15, adiciona uma opção experimental IncludeScopes ao log buffering global e por requisição, para que OrderId e TenantId de BeginScope sobrevivam a um Flush() em vez de serem descartados em silêncio."
pubDate: 2026-10-16
tags:
  - "dotnet"
  - "logging"
  - "observability"
  - "aspnetcore"
  - "csharp"
lang: "pt-br"
translationOf: "2026/10/dotnet-extensions-10-11-log-buffering-keeps-scopes-with-includescopes"
translatedBy: "claude"
translationDate: 2026-10-16
---

O [.NET Extensions 10.11.0](https://github.com/dotnet/extensions/releases/tag/v10.11.0) chegou ao NuGet em 2026-10-15. A maior parte das correções de IA é pequena, mas uma mudança de telemetria fecha uma lacuna que existia desde que o log buffering surgiu: registros em buffer perdiam todos os valores de `ILogger.BeginScope`. Você colocava logs de `Information` em buffer, uma exceção acontecia, você chamava `Flush()` e os registros saíam sem o `OrderId`, o `TenantId` ou o ID da requisição que você tinha colocado no scope. Exatamente o contexto de que você precisava para depurar a falha.

## Como um flush ficava antes

O log buffering fica em `Microsoft.Extensions.Telemetry` (buffer global) e `Microsoft.AspNetCore.Diagnostics.Middleware` (buffer por requisição). Registros que casam com uma regra ficam em um buffer circular e só são escritos quando você chama `Flush()`. Aqui está um repro mínimo com o logger JSON de console, que normalmente imprime scopes quando `IncludeScopes` está ligado:

```csharp
var builder = Host.CreateApplicationBuilder();
builder.Logging.ClearProviders();
builder.Logging.AddJsonConsole(o => o.IncludeScopes = true);
builder.Logging.AddGlobalBuffer(o =>
{
    o.Rules.Add(new LogBufferingFilterRule(logLevel: LogLevel.Information));
    o.IncludeScopes = true; // new in 10.11.0, EXTEXP0003
});
using var host = builder.Build();
var logger = host.Services.GetRequiredService<ILogger<Program>>();
var buffer = host.Services.GetRequiredService<GlobalLogBuffer>();

using (logger.BeginScope(new Dictionary<string, object?> { ["OrderId"] = 4711, ["TenantId"] = "contoso" }))
{
    logger.LogInformation("Reserving stock for {Sku}", "SKU-42");
    buffer.Flush();
}
```

Rodei como um app baseado em arquivo no SDK 10.0.302. Com `Microsoft.Extensions.Telemetry` 10.10.0 (sem a linha de `IncludeScopes`, que não compila lá), o registro descarregado não tem nenhum sinal do scope, mesmo com o flush acontecendo dentro dele:

```text
{"EventId":0,"LogLevel":"Information","Category":"Program","Message":"Reserving stock for SKU-42","Exception":"","State":{"Message":null,"Sku":"SKU-42","{OriginalFormat}":"Reserving stock for {Sku}"}}
```

No 10.11.0 com `IncludeScopes = true`:

```text
{"EventId":0,"LogLevel":"Information","Category":"Program","Message":"Reserving stock for SKU-42","Exception":"","State":{"Message":null,"Sku":"SKU-42","OrderId":"4711","TenantId":"contoso","{OriginalFormat}":"Reserving stock for {Sku}"}}
```

## Como funciona

O [PR #7813](https://github.com/dotnet/extensions/pull/7813) captura os scopes no momento em que o registro entra no buffer, não na hora do flush, que é o que você quer: quando algo chama `Flush()`, o scope original geralmente já acabou. Os buffers recebem um `IExternalScopeProvider` via DI (compartilhado com `ExtendedLoggerFactory`) e copiam os pares nome/valor de cada scope para o registro.

Alguns detalhes que vale conhecer:

- Os scopes aparecem como **atributos**, não como scopes. Provedores `IBufferedLogger` os veem em `BufferedLogRecord.Attributes`; os outros provedores os recebem mesclados no estado passado para `ILogger.Log`. Por isso eles aparecem em `State` acima, e não em um array `Scopes`.
- Só são capturados scopes que implementam `IEnumerable<KeyValuePair<string, object?>>`. Um scope de string simples como `BeginScope("Checkout")` é ignorado, e os pares `{OriginalFormat}` são descartados. Scopes de `ActivityTrackingOptions` (trace ID, span ID) são incluídos.
- Vem desligado por padrão, é experimental sob `EXTEXP0003` e pode ser vinculado pela configuração. As opções são relidas a cada registro em buffer, então um reload de configuração vale na hora.

Para o buffering por requisição do ASP.NET Core, a mesma chave existe em `PerRequestLogBufferingOptions`:

```csharp
builder.Logging.AddPerIncomingRequestBuffer(o =>
{
    o.Rules.Add(new LogBufferingFilterRule(logLevel: LogLevel.Information));
    o.IncludeScopes = true;
});
```

## Também no 10.11.0

A versão corrige uma `ArgumentNullException` no buffering por requisição no fim de uma requisição (#7811) e uma condição de corrida no buffering causada por um cache do seletor de regras (#7803). Se você usa o enriquecedor experimental de latência HTTP, `AddHttpLatencyTelemetry` agora se chama `AddHttpServerLatencyTelemetry` (#7730). No lado de IA, `FunctionInvocationContext.Terminate` agora é respeitado quando a função lança exceção (#7801), e `ChatResponseUpdate.Clone` mantém o `ContinuationToken` (#7699). A versão anterior desta série foi o [Microsoft.Extensions.AI 10.10.1](/pt-br/2026/09/microsoft-extensions-ai-10-10-1-fixes-openai-2-14-typeloadexception/).

Para atualizar:

```bash
dotnet add package Microsoft.Extensions.Telemetry --version 10.11.0
```

Se você coloca logs em buffer e os correlaciona por valores de scope, ligue `IncludeScopes`. Sem ele, os logs que você descarrega quando algo falha chegam sem os IDs de que você precisa para correlacioná-los.
