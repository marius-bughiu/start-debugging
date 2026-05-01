---
title: "Como configurar logging estruturado com Serilog e Seq no .NET 11"
description: "Um guia completo para conectar Serilog 4.x e Seq 2025.2 em uma aplicação ASP.NET Core do .NET 11: AddSerilog vs UseSerilog, bootstrap logging em duas etapas, configuração JSON, enrichers, request logging, correlação de traces com OpenTelemetry, API keys e os problemas de produção envolvendo buffering, retenção e nível de sinal."
pubDate: 2026-05-01
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "logging"
  - "serilog"
  - "seq"
lang: "pt-br"
translationOf: "2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-05-01
---

Para enviar logs estruturados de uma aplicação ASP.NET Core do .NET 11 para o Seq, instale `Serilog.AspNetCore` 10.0.0 e `Serilog.Sinks.Seq` 9.0.0, registre o pipeline com `services.AddSerilog((sp, lc) => lc.ReadFrom.Configuration(...).WriteTo.Seq("http://localhost:5341"))` e ative o request logger do host com `app.UseSerilogRequestLogging()`. Configure tudo a partir de `appsettings.json` para que produção possa alterar o nível mínimo sem um redeploy. Rode o Seq localmente como a imagem Docker `datalust/seq` com `ACCEPT_EULA=Y` e um mapeamento de porta, e aponte o sink para `http://localhost:5341`. Este guia foi escrito contra o .NET 11 preview 3 e C# 14, mas todos os trechos funcionam também no .NET 8, 9 e 10.

## Por que Serilog mais Seq em vez de "só `ILogger`"

`Microsoft.Extensions.Logging` é suficiente para demos hello-world e testes unitários. Não é o bastante para produção. `ILogger<T>.LogInformation("Order {OrderId} for {CustomerId} took {Elapsed} ms", id, customer, ms)` é estruturado no ponto da chamada, mas o provider de console padrão achata essas propriedades em uma única string e descarta a estrutura. No momento em que algo dá errado em produção, você volta a fazer grep em um tarball.

O Serilog mantém a estrutura. Cada chamada serializa os placeholders nomeados como propriedades JSON e os encaminha para qualquer sink que você configurar. O Seq é a ponta receptora: um servidor de logs auto-hospedado que indexa essas propriedades para que você possa escrever `select count(*) from stream where StatusCode >= 500 and Endpoint = '/api/orders' group by time(1m)` e obter uma resposta em milissegundos. A combinação tem sido uma escolha padrão no espaço .NET por uma década, porque ambas as peças são escritas por pessoas que de fato as usam.

Os números de versão que vale lembrar para 2026 são Serilog 4.3.1, Serilog.AspNetCore 10.0.0, Serilog.Sinks.Seq 9.0.0 e Seq 2025.2. Os números maiores acompanham o Microsoft.Extensions.Logging, então no .NET 11 você fica na linha 10.x do `Serilog.AspNetCore` e na linha 9.x do `Serilog.Sinks.Seq` até a Microsoft cortar uma nova major.

## Rode o Seq localmente em 30 segundos

Antes de qualquer código, deixe uma instância do Seq rodando. O one-liner do Docker é o que a maioria dos times usa, inclusive em CI:

```bash
# Seq 2025.2, default ports
docker run \
  --name seq \
  -d \
  --restart unless-stopped \
  -e ACCEPT_EULA=Y \
  -p 5341:80 \
  -p 5342:443 \
  -v seq-data:/data \
  datalust/seq:2025.2
```

`5341` é a porta de ingestão HTTP e da UI, `5342` é HTTPS. O volume nomeado `seq-data` mantém seus eventos entre reinícios do container. No Windows, a alternativa é o instalador MSI da datalust.co; ele entrega o mesmo engine e os mesmos defaults de porta. O tier gratuito é ilimitado para um único usuário; o licenciamento de time entra em ação assim que você adiciona contas autenticadas. Abra `http://localhost:5341` em um navegador, clique em "Settings", "API Keys" e crie uma key. Você vai usá-la tanto para a autenticação de ingestão quanto para quaisquer dashboards somente leitura que conectar mais tarde.

## Instale os pacotes

Três pacotes são suficientes para o caminho feliz:

```bash
dotnet add package Serilog.AspNetCore --version 10.0.0
dotnet add package Serilog.Sinks.Seq --version 9.0.0
dotnet add package Serilog.Settings.Configuration --version 9.0.0
```

`Serilog.AspNetCore` traz `Serilog`, `Serilog.Extensions.Hosting` e o sink de console. `Serilog.Sinks.Seq` é o sink HTTP que envia eventos em lotes para o endpoint de ingestão do Seq. `Serilog.Settings.Configuration` é a ponte que permite descrever o pipeline inteiro em `appsettings.json`, que é como você de fato quer rodar isso em produção.

## O Program.cs mínimo

Aqui está a menor configuração viável para uma minimal API do .NET 11. Ela usa a API `AddSerilog` que se tornou o único entry point suportado depois que o Serilog.AspNetCore 8.0.0 removeu a extensão obsoleta `IWebHostBuilder.UseSerilog()`.

```csharp
// .NET 11 preview 3, C# 14
// Serilog 4.3.1, Serilog.AspNetCore 10.0.0, Serilog.Sinks.Seq 9.0.0
using Serilog;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSerilog((services, lc) => lc
    .ReadFrom.Configuration(builder.Configuration)
    .ReadFrom.Services(services)
    .Enrich.FromLogContext()
    .WriteTo.Console()
    .WriteTo.Seq("http://localhost:5341"));

var app = builder.Build();

app.UseSerilogRequestLogging();

app.MapGet("/api/orders/{id:int}", (int id, ILogger<Program> log) =>
{
    log.LogInformation("Fetching order {OrderId}", id);
    return Results.Ok(new { id, total = 99.95m });
});

app.Run();
```

Cinco linhas fazem o trabalho de verdade. `ReadFrom.Configuration` carrega níveis mínimos e overrides do `appsettings.json`. `ReadFrom.Services` permite que sinks resolvam dependências com escopo, o que importa quando você começa a escrever enrichers customizados. `Enrich.FromLogContext` é o que permite empilhar um bloco `using (LogContext.PushProperty("CorrelationId", id))` em um middleware e fazer com que cada linha de log dentro desse escopo seja marcada automaticamente. `WriteTo.Console` mantém a experiência de desenvolvimento local rápida. `WriteTo.Seq` é o sink propriamente dito.

`UseSerilogRequestLogging` substitui o middleware padrão de request logging do ASP.NET Core por um único evento estruturado por requisição. Em vez de três ou quatro linhas por requisição, você obtém uma linha com `RequestPath`, `StatusCode`, `Elapsed` e quaisquer propriedades que você empurrar via callback `EnrichDiagnosticContext`. Menos ruído, mais sinal.

## Mova a configuração para appsettings.json

Hardcoding de `http://localhost:5341` é aceitável para uma demo e errado para produção. Mova a descrição inteira do pipeline para `appsettings.json` para poder mudar a verbosidade sem fazer redeploy:

```json
{
  "Serilog": {
    "Using": [ "Serilog.Sinks.Console", "Serilog.Sinks.Seq" ],
    "MinimumLevel": {
      "Default": "Information",
      "Override": {
        "Microsoft.AspNetCore": "Warning",
        "Microsoft.EntityFrameworkCore.Database.Command": "Warning",
        "System.Net.Http.HttpClient": "Warning"
      }
    },
    "Enrich": [ "FromLogContext", "WithMachineName", "WithThreadId" ],
    "WriteTo": [
      { "Name": "Console" },
      {
        "Name": "Seq",
        "Args": {
          "serverUrl": "http://localhost:5341",
          "apiKey": "REPLACE_WITH_API_KEY"
        }
      }
    ],
    "Properties": {
      "Application": "Orders.Api"
    }
  }
}
```

Alguns detalhes que importam. O array `Using` é o que o `Serilog.Settings.Configuration` 9.x usa para carregar os assemblies dos sinks; sem ele, o parser JSON não sabe qual assembly contém `WriteTo.Seq`. O mapa `Override` é o recurso mais subestimado do Serilog: ele permite manter o nível global em `Information` enquanto fixa o command logger do EF Core em `Warning`, para que você não se afogue em SQL em um servidor movimentado. Adicione `WithMachineName` e `WithThreadId` somente se você instalar `Serilog.Enrichers.Environment` e `Serilog.Enrichers.Thread`; remova-os caso contrário, ou a configuração vai falhar no startup com um silencioso erro de "method not found".

A propriedade `Application` é a chave para usar uma única instância do Seq para muitos serviços. Empurre o nome de cada app via `Properties` e você ganha um filtro grátis na UI do Seq: `Application = 'Orders.Api'`.

## Bootstrap logging: capture o crash antes do logging começar

O logging dirigido por configuração tem uma fraqueza. Se `appsettings.json` estiver malformado, o host explode antes dos sinks configurados estarem ativos, e você não obtém nada. O padrão oficial, e o que o `Serilog.AspNetCore` documenta, é o bootstrap em duas etapas: instale um logger mínimo antes do host ser construído e, depois, substitua-o assim que a configuração for carregada.

```csharp
// .NET 11 preview 3, C# 14
using Serilog;

Log.Logger = new LoggerConfiguration()
    .MinimumLevel.Information()
    .WriteTo.Console()
    .WriteTo.Seq("http://localhost:5341")
    .CreateBootstrapLogger();

try
{
    var builder = WebApplication.CreateBuilder(args);

    builder.Services.AddSerilog((services, lc) => lc
        .ReadFrom.Configuration(builder.Configuration)
        .ReadFrom.Services(services)
        .Enrich.FromLogContext()
        .WriteTo.Console()
        .WriteTo.Seq("http://localhost:5341"));

    var app = builder.Build();

    app.UseSerilogRequestLogging();
    app.MapGet("/", () => "ok");

    app.Run();
}
catch (Exception ex) when (ex is not HostAbortedException)
{
    Log.Fatal(ex, "Host terminated unexpectedly");
    throw;
}
finally
{
    Log.CloseAndFlush();
}
```

`CreateBootstrapLogger` retorna um logger que é tanto utilizável agora quanto substituível depois, então o mesmo estático `Log.Logger` continua funcionando depois que `AddSerilog` troca a implementação. `Log.CloseAndFlush()` no bloco `finally` é o que garante que o lote em memória do `Serilog.Sinks.Seq` realmente seja drenado antes do processo sair. Pule isso e você vai perder os últimos segundos de logs em um shutdown limpo, que é exatamente a janela onde os eventos interessantes vivem.

## Request logging que é de fato útil

`UseSerilogRequestLogging` escreve um evento por requisição em `Information` para 2xx e 3xx, `Warning` para 4xx e `Error` para 5xx. Os defaults são razoáveis. Para deixá-lo pronto para produção, sobrescreva o template da mensagem e enriqueça cada evento com a identidade do usuário e o trace id:

```csharp
// .NET 11 preview 3, C# 14
app.UseSerilogRequestLogging(options =>
{
    options.MessageTemplate =
        "HTTP {RequestMethod} {RequestPath} responded {StatusCode} in {Elapsed:0} ms";

    options.EnrichDiagnosticContext = (diagnosticContext, httpContext) =>
    {
        diagnosticContext.Set("UserId", httpContext.User?.FindFirst("sub")?.Value);
        diagnosticContext.Set("ClientIp", httpContext.Connection.RemoteIpAddress?.ToString());
        diagnosticContext.Set("TraceId", System.Diagnostics.Activity.Current?.TraceId.ToString());
    };
});
```

A linha do `TraceId` é o enricher mais valioso que você pode adicionar. Combinada com a coleta de trace id que chegou no Serilog 3.1, cada evento de log que seu código escrever dentro de uma requisição vai carregar o mesmo `TraceId` da requisição em si. No Seq, você pode clicar em qualquer evento e pivotar para "show all events with this TraceId" para obter a cadeia de chamadas completa em uma única consulta.

## Conecte a correlação de traces do OpenTelemetry

Se você também exporta traces via OpenTelemetry, não adicione um exporter de logging separado. O Serilog já entende `Activity.Current` e escreve `TraceId` e `SpanId` automaticamente quando presentes. O tracing nativo do OpenTelemetry no ASP.NET Core 11 significa que os traces começam na requisição de entrada e se propagam por `HttpClient`, EF Core e qualquer outra biblioteca instrumentada. O Serilog pega o mesmo contexto de `Activity`, então cada evento de log acaba correlacionado ao trace sem qualquer fiação extra do lado do logging. Leia [o pipeline de tracing nativo do OpenTelemetry no .NET 11](/pt-br/2026/04/aspnetcore-11-native-opentelemetry-tracing/) para a configuração do lado do trace.

Para enviar esses traces ao Seq em vez de a um backend separado, instale `Serilog.Sinks.Seq` mais o suporte OTLP que vem com o Seq 2025.2 e aponte o exporter do OpenTelemetry para `http://localhost:5341/ingest/otlp/v1/traces`. O Seq vai exibir traces e logs na mesma UI, unidos por `TraceId`.

## Níveis, sampling e "estamos sendo paginados por nada"

O nível padrão `Information` em uma API movimentada vai produzir centenas de eventos por segundo. Dois botões controlam o volume.

O primeiro é o mapa `MinimumLevel.Override` mostrado acima. Empurre logs ruidosos do framework para `Warning` e você corta a mangueira de incêndio em uma ordem de magnitude sem perder seus próprios logs de aplicação. Sempre faça override de `Microsoft.AspNetCore` para `Warning` assim que ligar o `UseSerilogRequestLogging`, caso contrário você obtém a linha por requisição duas vezes: uma do framework e uma do Serilog.

O segundo é sampling. O Serilog não tem um sampler embutido, mas você pode envolver o sink do Seq em um predicado `Filter.ByExcluding` para descartar eventos de baixo valor antes que deixem o processo:

```csharp
// .NET 11, C# 14: drop /health probe noise
.Filter.ByExcluding(le =>
    le.Properties.TryGetValue("RequestPath", out var p) &&
    p is ScalarValue { Value: string path } &&
    path.StartsWith("/health", StringComparison.OrdinalIgnoreCase))
```

Para tráfego de alto volume, uma resposta melhor é manter `Information` para o request log e subir todo o resto para `Warning`, e então usar o recurso "signal" do Seq para marcar a pequena fatia em que você de fato quer alertar.

## Problemas de produção

Um punhado de problemas pega todo time que coloca Serilog mais Seq em produção pela primeira vez.

**O batching do sink esconde indisponibilidades.** `Serilog.Sinks.Seq` faz buffer de eventos por até 2 segundos ou 1000 eventos antes de fazer flush. Se o Seq estiver inalcançável, o sink tenta novamente com backoff exponencial, mas o buffer é limitado. Em uma indisponibilidade prolongada do Seq, você vai descartar eventos silenciosamente. Deploys de produção devem definir `bufferBaseFilename` para que o sink derrame em disco primeiro e replique quando o Seq voltar:

```json
{
  "Name": "Seq",
  "Args": {
    "serverUrl": "https://seq.internal",
    "apiKey": "...",
    "bufferBaseFilename": "/var/log/myapp/seq-buffer"
  }
}
```

**Chamadas síncronas ao sink do Seq não são de graça.** Mesmo que o sink seja assíncrono, a chamada para `LogInformation` faz trabalho na thread chamadora para renderizar o template da mensagem e empurrar para o channel. Em um caminho quente, isso aparece em profiles. Use `Async` ([`Serilog.Sinks.Async`](https://github.com/serilog/serilog-sinks-async)) para envolver o sink do Seq em uma thread de background dedicada, para que a thread da requisição retorne instantaneamente.

**API keys em `appsettings.json` são um vazamento esperando para acontecer.** Mova-as para user secrets em desenvolvimento e para seu cofre de segredos (Key Vault, AWS Secrets Manager) em produção. O Serilog lê qualquer configuration provider que o host registra, então a única coisa que você muda é de onde o valor vem.

**A retenção do Seq não é infinita.** O volume Docker padrão `seq-data` cresce até o disco encher e o Seq começar a descartar ingestão. Configure políticas de retenção na UI do Seq em "Settings", "Data". Um ponto de partida comum é 30 dias para `Information`, 90 dias para `Warning` e acima.

**`UseSerilogRequestLogging` precisa vir antes de `UseEndpoints` e depois de `UseRouting`.** Se você o colocar antes, ele não vai ver o endpoint correspondido, e `RequestPath` vai conter a URL bruta em vez do template de rota, o que torna os dashboards do Seq muito menos úteis.

## Onde isso se encaixa na sua stack

Serilog mais Seq é a perna de logging de uma stack de observabilidade de três pernas: logs (Serilog/Seq), traces (OpenTelemetry) e exceções ([global exception handlers](/pt-br/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/)). Quando algo está errado em uma API de produção, você começa no Seq, encontra a requisição que falhou, copia o `TraceId` e pivota tanto para a visualização do trace quanto para o código-fonte que lançou. Esse round-trip é o ponto inteiro. Se você não consegue fazê-lo em menos de um minuto, seu logging não está se pagando.

Se você está caçando uma lentidão específica em vez de um erro de runtime, prossiga com [um loop de profiling com `dotnet-trace`](/pt-br/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/). O Seq é excelente para "o que aconteceu", `dotnet-trace` é a ferramenta certa para "por que isso está lento". E se a resposta acabar sendo "serializamos demais por requisição", o [guia de JsonConverter customizado](/pt-br/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) cobre o lado do System.Text.Json.

Links de referência:

- [Serilog.AspNetCore release notes](https://github.com/serilog/serilog-aspnetcore/releases)
- [Serilog.Sinks.Seq on NuGet](https://www.nuget.org/packages/Serilog.Sinks.Seq/)
- [Seq documentation](https://docs.datalust.co/docs)
- [Datalust seq-extensions-logging](https://github.com/datalust/seq-extensions-logging)
