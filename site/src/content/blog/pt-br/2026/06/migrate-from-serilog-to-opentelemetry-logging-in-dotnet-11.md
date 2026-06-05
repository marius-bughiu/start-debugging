---
title: "Migre do Serilog para o logging com OpenTelemetry no .NET 11"
description: "Um guia passo a passo para tirar um app .NET 11 do Serilog e colocá-lo no logging com OpenTelemetry: a ponte de baixo risco Serilog.Sinks.OpenTelemetry, a migração completa para Microsoft.Extensions.Logging, o que quebra, como verificar e como fazer rollback."
pubDate: 2026-06-05
updatedDate: 2026-06-05
template: migration
tags:
  - "migration"
  - "serilog"
  - "opentelemetry"
  - "dotnet-11"
  - "logging"
  - "observability"
lang: "pt-br"
translationOf: "2026/06/migrate-from-serilog-to-opentelemetry-logging-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-06-05
---

Se a sua equipe padronizou o OpenTelemetry para traces e métricas, o ponto fora da curva costuma ser o logging, que ainda passa pelo Serilog e por um sink de arquivo ou Seq. Este guia move um app .NET 11 (OpenTelemetry .NET SDK 1.15.x, Serilog 4.x) desse setup dividido para o logging com OpenTelemetry. Há dois caminhos: uma ponte de uma noite que mantém o Serilog e troca só o sink, e uma migração completa para `Microsoft.Extensions.Logging` que remove o Serilog por inteiro. A ponte é reversível em um único commit e quase não quebra nada. A migração completa leva um ou dois dias em uma base de código real, toca cada `BeginScope` e cada template de mensagem, e só vale a pena se remover a dependência do Serilog e unificar tudo em uma única API de logging for um objetivo de fato, e não apenas algo bom de ter.

## Por que mover o logging para o OpenTelemetry afinal

- **Um pipeline para três sinais.** Traces, métricas e logs saem do processo pelo mesmo exportador OTLP e chegam no mesmo backend, correlacionados por `TraceId` e `SpanId`. Nenhum endpoint Seq separado para operar ao lado do seu backend de traces.
- **Formato de transmissão neutro em relação ao fornecedor.** OTLP é um protocolo estável. Você pode apontar o mesmo app para o Aspire Dashboard localmente, para o Jaeger ou o SigNoz auto-hospedados, ou para um backend comercial, mudando um endpoint, e não trocando um pacote de sink.
- **Correlação automática de traces.** Logs emitidos dentro de uma `Activity` ativa carregam os IDs de trace e span sem um enricher, então "me mostre cada linha de log desta requisição" funciona entre serviços.
- **Menos peças móveis em CI e em produção.** Tirar o bootstrap do Serilog e a configuração de sink remove uma classe de incidentes do tipo "os logs pararam silenciosamente" causados por bugs de buffering de sink e de flush no shutdown.

Se você ainda não conectou os traces do OpenTelemetry, faça isso primeiro: [use OpenTelemetry com .NET 11 e um backend gratuito](/pt-br/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) cobre o setup do exportador e do backend que este guia presume já estar no lugar.

## O que quebra

| Área | Mudança | Severidade |
| --- | --- | --- |
| Configuração de sink | Sinks de arquivo/console/Seq substituídos pelo exportador OTLP ou pelo `Serilog.Sinks.OpenTelemetry` | alta (completa) / baixa (ponte) |
| `Log.Logger` estático + `CreateBootstrapLogger()` | Removido na migração completa; sem logging de startup em dois estágios | alta (só completa) |
| Enrichers `LogContext.PushProperty` | Substituídos por `ILogger.BeginScope` mais `IncludeScopes = true` | média (só completa) |
| Operador de destructuring `{@Order}` | Sem equivalente em `Microsoft.Extensions.Logging`; logue campos escalares ou serialize explicitamente | média (só completa) |
| `UseSerilogRequestLogging()` | Substituído pela instrumentação OTel do ASP.NET Core ou por `AddHttpLogging` | média (só completa) |
| Bloco de config `MinimumLevel` | Migra para a seção `Logging:LogLevel` no `appsettings.json` | baixa (só completa) |
| Nomes de severidade | O `Verbose` do Serilog mapeia para `Trace` do OTel; `Information` permanece | baixa |

A coluna da "ponte" importa: se você escolher o caminho A, só a primeira linha se aplica e a severidade é baixa. Tudo o mais é uma preocupação da migração completa.

## Checklist de pré-voo

- **SDK do .NET 11 instalado.** Confirme com `dotnet --version` (espere `11.0.x`).
- **Traces do OpenTelemetry já exportando por OTLP.** Este guia reutiliza esse exportador e esse resource.
- **Um backend que ingere logs OTLP.** O Aspire Dashboard, o SigNoz e o Seq todos aceitam OTLP/HTTP. O Seq expõe um endpoint de ingestão OTLP em `/ingest/otlp/v1/logs`, então você pode manter o Seq como destino mesmo depois de descartar o sink Seq do Serilog.
- **Uma suíte de testes verde e uma working tree limpa** antes de começar, para que o `git diff` mostre apenas as mudanças de migração.
- **Conheça seu endpoint e protocolo OTLP.** O gRPC padrão é `http://localhost:4317`; o HTTP/protobuf padrão é `http://localhost:4318`. O exportador HTTP acrescenta `/v1/logs` ao endpoint base.

## Passos da migração

### 1. Fixe as versões dos pacotes

Decida o caminho, depois instale os pacotes correspondentes. Ambos os caminhos têm como alvo a mesma linha de SDK.

```xml
<!-- .NET 11, both routes -->
<!-- Route A (bridge): keep Serilog, swap the sink -->
<PackageReference Include="Serilog.AspNetCore" Version="9.0.0" />
<PackageReference Include="Serilog.Sinks.OpenTelemetry" Version="4.2.0" />

<!-- Route B (full): Microsoft.Extensions.Logging + OpenTelemetry -->
<PackageReference Include="OpenTelemetry.Extensions.Hosting" Version="1.15.3" />
<PackageReference Include="OpenTelemetry.Exporter.OpenTelemetryProtocol" Version="1.15.3" />
```

Verifique: `dotnet restore` tem sucesso e `dotnet build` está limpo antes de você mudar qualquer código.

### 2a. Caminho A -- troque o sink do Serilog por OTLP

Este é o caminho de baixo risco. Mantenha cada enricher, template de mensagem e chamada `LogContext` que você já tem. Substitua apenas a configuração de sink.

```csharp
// .NET 11, C# 14, Serilog 4.x, Serilog.Sinks.OpenTelemetry 4.2.0
using Serilog;
using Serilog.Sinks.OpenTelemetry;

Log.Logger = new LoggerConfiguration()
    .Enrich.FromLogContext()
    .WriteTo.OpenTelemetry(options =>
    {
        options.Endpoint = "http://localhost:4318/v1/logs";
        options.Protocol = OtlpProtocol.HttpProtobuf;
        options.ResourceAttributes = new Dictionary<string, object>
        {
            ["service.name"] = "orders-api",
            ["service.version"] = "2.4.0"
        };
    })
    .CreateLogger();
```

O sink lê `Activity.Current` e injeta `TraceId` e `SpanId` em cada registro de log automaticamente (`IncludedData.TraceIdField` e `SpanIdField` estão ligados por padrão), então a correlação entre sinais funciona sem nenhum enricher extra. Seus templates `_logger.LogInformation("Placed order {OrderId}", id)` fluem sem alteração.

Verifique: inicie o app, faça uma requisição e confirme que a linha de log aparece no seu backend OTLP com o mesmo `TraceId` do trace da requisição.

### 2b. Caminho B -- migre para Microsoft.Extensions.Logging

Remova `UseSerilog()` / `AddSerilog()` e o bootstrap `Log.Logger` do `Program.cs`. Em vez disso, conecte o OpenTelemetry ao logging builder embutido.

```csharp
// .NET 11, C# 14, OpenTelemetry .NET SDK 1.15.3
using OpenTelemetry.Logs;
using OpenTelemetry.Resources;

var builder = WebApplication.CreateBuilder(args);

builder.Logging.AddOpenTelemetry(options =>
{
    options.IncludeScopes = true;            // keep BeginScope properties
    options.IncludeFormattedMessage = true;  // populate the log body
    options.ParseStateValues = true;         // capture structured attributes
    options.SetResourceBuilder(
        ResourceBuilder.CreateDefault()
            .AddService("orders-api", serviceVersion: "2.4.0"));
    options.AddOtlpExporter(o =>
    {
        o.Endpoint = new Uri("http://localhost:4318");
    });
});

var app = builder.Build();
```

Se o seu app já chama `builder.Services.AddOpenTelemetry()` para traces e métricas, prefira a forma unificada para que os três sinais compartilhem um resource e um exportador:

```csharp
// .NET 11, OpenTelemetry .NET SDK 1.15.3
builder.Services.AddOpenTelemetry()
    .ConfigureResource(r => r.AddService("orders-api", serviceVersion: "2.4.0"))
    .WithTracing(t => t.AddAspNetCoreInstrumentation())
    .WithMetrics(m => m.AddAspNetCoreInstrumentation())
    .UseOtlpExporter(); // one call: configures OTLP for traces, metrics, AND logs

// Logs still need the provider on the logging builder:
builder.Logging.AddOpenTelemetry(o =>
{
    o.IncludeScopes = true;
    o.IncludeFormattedMessage = true;
    o.ParseStateValues = true;
});
```

`UseOtlpExporter()` (adicionado no SDK 1.8) registra o exportador OTLP para cada sinal de uma vez, então você não repete o endpoint três vezes.

Verifique: `dotnet run`, depois confirme que uma linha de `ILogger` chega ao backend com o `service.name` correto e um corpo preenchido.

### 3. Traduza enrichers para scopes (somente Caminho B)

O `LogContext.PushProperty("UserId", id)` do Serilog não tem equivalente em `Microsoft.Extensions.Logging`. Use `ILogger.BeginScope` e as propriedades fluem para o registro OTLP porque você definiu `IncludeScopes = true`.

```csharp
// Before (Serilog)
using (LogContext.PushProperty("UserId", userId))
{
    _logger.LogInformation("Loaded cart");
}

// After (.NET 11, Microsoft.Extensions.Logging)
using (_logger.BeginScope(new Dictionary<string, object> { ["UserId"] = userId }))
{
    _logger.LogInformation("Loaded cart");
}
```

Verifique: o registro de log emitido carrega `UserId` como um atributo. Se ele estiver faltando, você esqueceu `IncludeScopes = true`.

### 4. Substitua o logging de requisições (somente Caminho B)

`app.UseSerilogRequestLogging()` produzia uma linha de log resumida por requisição. Com o OpenTelemetry, a instrumentação do ASP.NET Core já emite um span de servidor HTTP por requisição, que é a primitiva melhor para "o que aconteceu nesta requisição". Se você ainda quiser uma linha de log, adicione o HTTP logging:

```csharp
// .NET 11
builder.Services.AddHttpLogging(o => { });
// ...
app.UseHttpLogging();
```

Verifique: cada requisição produz um span de servidor HTTP (e uma entrada de log HTTP opcional) correlacionados por `TraceId`.

### 5. Mova a configuração de nível para o appsettings

O bloco `MinimumLevel` do Serilog é substituído pela seção padrão `Logging:LogLevel`, que o provider do OpenTelemetry respeita como qualquer outro.

```json
{
  "Logging": {
    "LogLevel": {
      "Default": "Information",
      "Microsoft.AspNetCore": "Warning"
    }
  }
}
```

Verifique: defina uma categoria como `Warning`, confirme que suas linhas `Information` param de aparecer no backend.

## Checklist de verificação

Rode isto depois de qualquer um dos caminhos, antes de você deletar os pacotes antigos:

- `dotnet build` está limpo, sem avisos de `Serilog` que você não esperava.
- `dotnet test` passa com zero falhas.
- Uma requisição produz registros de log no backend com um corpo não vazio (`IncludeFormattedMessage` funcionando).
- Esses registros compartilham o `TraceId` da requisição (correlação funcionando).
- Propriedades estruturadas (`OrderId`, valores de scope) aparecem como atributos, não embutidas na string da mensagem (`ParseStateValues` e `IncludeScopes` funcionando).
- O volume de logs no backend corresponde às expectativas; nenhum filtro de nível está descartando silenciosamente ou inundando.
- O shutdown faz flush: pare o app no meio de uma requisição e confirme que as últimas linhas ainda chegam (o batch processor faz flush no dispose).

## Plano de rollback

**O Caminho A é reversível em um commit.** Reverta o bloco `WriteTo.OpenTelemetry(...)` de volta para a sua antiga configuração `WriteTo.Seq(...)` / `WriteTo.File(...)` e remova o pacote `Serilog.Sinks.OpenTelemetry`. Nada mais mudou, então não há superfície de risco.

**O Caminho B é reversível, mas não é trivial.** Mantenha os pacotes do Serilog instalados e o antigo bootstrap do `Program.cs` no seu histórico do git até o novo pipeline ter rodado em produção por um ciclo de release. Se você precisar reverter, restaure `UseSerilog()`, o bootstrap `Log.Logger` e converta as chamadas `BeginScope` de volta para `LogContext.PushProperty`. Como a migração toca scopes e logging de requisições por toda a base de código, trate a reversão como uma pequena migração própria, não como uma alavanca de uma linha. Não delete os pacotes do Serilog do `.csproj` até a verificação ter passado em produção.

## Pegadinhas que enfrentamos

**Corpos de log vazios no backend.** Se `IncludeFormattedMessage` ficar no seu padrão `false`, o registro OTLP é enviado com atributos estruturados, mas sem mensagem renderizada, e alguns backends mostram uma linha em branco. Ligue isso. Combine com `ParseStateValues = true` para que os placeholders nomeados (`{OrderId}`) também cheguem como atributos, em vez de só dentro da string formatada.

**Propriedades de scope desaparecem.** `IncludeScopes` tem padrão `false`. Cada valor de `BeginScope`, e qualquer coisa que o ASP.NET Core coloque no scope da requisição, é descartado até você habilitá-lo. Este é o relato mais comum do tipo "minha migração perdeu metade do meu contexto de log".

**Sem destructuring `{@Object}`.** O `_logger.LogInformation("Got {@Order}", order)` do Serilog serializava o objeto inteiro. `Microsoft.Extensions.Logging` trata `@` como texto literal. Logue os campos escalares que você de fato consulta, ou serialize explicitamente com `System.Text.Json`. Despejar objetos inteiros também explode a cardinalidade de atributos, que alguns backends cobram.

**Perder o logging de bootstrap em dois estágios.** O `CreateBootstrapLogger()` do Serilog capturava falhas que acontecem antes do host ser construído. O provider do OpenTelemetry só existe depois de `builder.Build()`, então exceções muito cedo no startup vão apenas para o console. Se a observabilidade no início do startup importa, mantenha um logger de console mínimo para essa janela.

**Surpresas no mapeamento de severidade.** O `Verbose` do Serilog vira `Trace` do OTel, e `Fatal` vira `Critical`. Se você filtra ou alerta com base em nomes de severidade lá na frente, atualize essas regras. `Debug`, `Information`, `Warning` e `Error` mapeiam um para um.

Se você vai apertar o logging de qualquer forma, vale a pena revisitar como você emite dados estruturados em primeiro lugar; [configure logging estruturado com Serilog e Seq no .NET 11](/pt-br/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) cobre os padrões de template de mensagem que migram limpamente para o `ILogger`, e [o tracing nativo com OpenTelemetry do ASP.NET Core 11](/pt-br/2026/04/aspnetcore-11-native-opentelemetry-tracing/) explica por que você pode não precisar de pacotes de instrumentação extras quando estiver no pipeline unificado. Para jobs em background e serviços hospedados, [monitorar jobs em background sem Hangfire](/pt-br/2026/01/monitor-background-jobs-in-net-9-and-net-10-without-hangfire-health-metrics-alerts/) mostra a mesma correlação funcionando fora do caminho da requisição, e o [aviso de segurança sobre baggage do OpenTelemetry no Aspire 13.2.4](/pt-br/2026/04/aspire-13-2-4-opentelemetry-cve-2026-40894-baggage-dos/) é um lembrete para manter os pacotes do OTel atualizados.

Escolha a ponte, a menos que remover o Serilog seja um objetivo de verdade. Ela te dá logs OTLP e correlação de traces hoje à noite, e você pode fazer a migração completa mais tarde, quando tiver um sprint tranquilo para traduzir scopes e logging de requisições direito.

## Fontes

- [Documentação de logs do OpenTelemetry .NET](https://opentelemetry.io/docs/languages/dotnet/logs/)
- [Serilog.Sinks.OpenTelemetry no GitHub](https://github.com/serilog/serilog-sinks-opentelemetry)
- [Exportador OTLP para OpenTelemetry .NET](https://github.com/open-telemetry/opentelemetry-dotnet/blob/main/src/OpenTelemetry.Exporter.OpenTelemetryProtocol/README.md)
- [Observabilidade no .NET com OpenTelemetry (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/observability-with-otel)
- [OpenTelemetry.Exporter.OpenTelemetryProtocol no NuGet](https://www.nuget.org/packages/OpenTelemetry.Exporter.OpenTelemetryProtocol)
