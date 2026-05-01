---
title: "Como usar OpenTelemetry com .NET 11 e um backend gratuito"
description: "Conecte traces, métricas e logs do OpenTelemetry em uma aplicação ASP.NET Core .NET 11 com o exportador OTLP, e envie os dados para um backend gratuito e auto-hospedado: o Aspire Dashboard standalone para desenvolvimento local, Jaeger e SigNoz para produção auto-hospedada, e o OpenTelemetry Collector quando você precisar dos dois."
pubDate: 2026-05-01
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "observability"
  - "opentelemetry"
lang: "pt-br"
translationOf: "2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend"
translatedBy: "claude"
translationDate: 2026-05-01
---

Para adicionar OpenTelemetry a uma aplicação ASP.NET Core .NET 11 e enviar os dados para algo gratuito, instale `OpenTelemetry.Extensions.Hosting` 1.15.3 e `OpenTelemetry.Exporter.OpenTelemetryProtocol` 1.15.3, registre o SDK com `services.AddOpenTelemetry().WithTracing(...).WithMetrics(...).UseOtlpExporter()`, configure `OTEL_EXPORTER_OTLP_ENDPOINT` apontando para seu collector ou backend, e execute o Aspire Dashboard standalone a partir da imagem Docker `mcr.microsoft.com/dotnet/aspire-dashboard` como visualizador local. O Aspire Dashboard fala OTLP/gRPC na porta `4317` e OTLP/HTTP na porta `4318`, não custa nada e renderiza traces, logs estruturados e métricas em uma única tela. Para observabilidade auto-hospedada em produção, troque o destino por Jaeger 2.x (apenas traces) ou SigNoz 0.x (traces, métricas, logs) e coloque o OpenTelemetry Collector na frente para poder bifurcar e filtrar. Este guia foi escrito para .NET 11 preview 3, C# 14 e OpenTelemetry .NET 1.15.3.

## Por que OpenTelemetry em vez de SDKs proprietários

Todo produto sério de observabilidade para .NET ainda traz um SDK proprietário: Application Insights, Datadog, New Relic, Dynatrace, o cliente próprio do Honeycomb, e por aí vai. Todos fazem mais ou menos a mesma coisa: se conectam a ASP.NET Core, HttpClient e EF Core, agrupam dados em lotes e os enviam no formato deles. O problema começa quando você quer trocar de fornecedor, rodar dois em paralelo ou simplesmente ver os dados localmente sem pagar a ninguém. Cada reescrita é um projeto de várias semanas, porque as chamadas de instrumentação estão espalhadas por centenas de arquivos.

OpenTelemetry substitui esse cenário por um único SDK neutro em relação ao fornecedor e um único formato de transporte (OTLP). Você instrumenta uma vez. O exportador é um pacote separado, intercambiável na inicialização. Você pode enviar a mesma telemetria para o Aspire Dashboard durante o desenvolvimento local, para o Jaeger em staging e para um backend pago em produção, sem mexer no código da aplicação. ASP.NET Core 11 inclusive já traz primitivos nativos de tracing OpenTelemetry, então os spans do próprio framework caem no mesmo pipeline que os seus spans personalizados (consulte [as mudanças de tracing nativo de OpenTelemetry no .NET 11](/pt-br/2026/04/aspnetcore-11-native-opentelemetry-tracing/) para ver o que foi promovido).

Os números de versão que vale fixar para 2026: `OpenTelemetry` 1.15.3, `OpenTelemetry.Extensions.Hosting` 1.15.3, `OpenTelemetry.Exporter.OpenTelemetryProtocol` 1.15.3, instrumentação ASP.NET Core 1.15.0, e instrumentação HttpClient 1.15.0. O Aspire Dashboard sai de `mcr.microsoft.com/dotnet/aspire-dashboard:9.5` no momento da escrita deste artigo.

## Suba o backend gratuito em 30 segundos

Antes de qualquer código, tenha um backend rodando. O Aspire Dashboard standalone é a opção de menor esforço para desenvolvimento local. Ele expõe um receptor OTLP, indexa traces, métricas e logs em memória, e te dá uma interface Blazor na porta `18888`:

```bash
# Aspire Dashboard 9.5, default ports
docker run --rm \
  --name aspire-dashboard \
  -p 18888:18888 \
  -p 4317:18889 \
  -p 4318:18890 \
  -e DASHBOARD__OTLP__AUTHMODE=ApiKey \
  -e DASHBOARD__OTLP__PRIMARYAPIKEY=local-dev-key \
  mcr.microsoft.com/dotnet/aspire-dashboard:9.5
```

O contêiner expõe internamente `18889` para OTLP/gRPC e `18890` para OTLP/HTTP, e você os mapeia para as portas padrão `4317`/`4318` por fora, para que qualquer SDK do OpenTelemetry com configurações default os encontre. Definir `DASHBOARD__OTLP__AUTHMODE=ApiKey` força os clientes a anexar a chave em um cabeçalho `x-otlp-api-key`, o que importa no momento em que você associa o dashboard a um endereço que não seja loopback. Abra `http://localhost:18888` e você verá abas vazias de Traces, Metrics e Structured Logs aguardando dados. O dashboard mantém tudo na memória do processo, então um restart limpa o estado: esta é uma ferramenta de desenvolvimento, não um armazenamento de longo prazo.

Se você prefere não rodar nada localmente, o Jaeger 2.x tem a mesma ergonomia apenas para traces:

```bash
# Jaeger 2.0 all-in-one
docker run --rm \
  --name jaeger \
  -p 16686:16686 \
  -p 4317:4317 \
  -p 4318:4318 \
  jaegertracing/jaeger:2.0.0
```

O Jaeger 2.x é em si um wrapper fino sobre o OpenTelemetry Collector com um backend de armazenamento Cassandra/Elasticsearch/Badger, e ele aceita OTLP nativamente. SigNoz, que adiciona métricas e logs em cima do ClickHouse, é uma instalação Docker Compose em vez de um one-liner; clone `https://github.com/SigNoz/signoz` e rode `docker compose up`.

## Instale o SDK e os pacotes de instrumentação

Para uma minimal API ASP.NET Core 11, quatro pacotes te dão o caminho feliz. O agregado `OpenTelemetry.Extensions.Hosting` puxa o SDK; o exportador OTLP cuida do transporte; e os dois pacotes de instrumentação cobrem as duas superfícies que toda aplicação web precisa: HTTP de entrada e HTTP de saída.

```bash
# OpenTelemetry .NET 1.15.3, .NET 11
dotnet add package OpenTelemetry.Extensions.Hosting --version 1.15.3
dotnet add package OpenTelemetry.Exporter.OpenTelemetryProtocol --version 1.15.3
dotnet add package OpenTelemetry.Instrumentation.AspNetCore --version 1.15.0
dotnet add package OpenTelemetry.Instrumentation.Http --version 1.15.0
```

Se você também usa EF Core, adicione `OpenTelemetry.Instrumentation.EntityFrameworkCore` 1.15.0-beta.1. Note o sufixo `-beta.1`: essa linha ainda está oficialmente em preview, mas todos os times com os quais trabalhei tratam como estável. A instrumentação se conecta ao diagnostic source do EF Core e emite um span por `SaveChanges`, query e DbCommand.

## Conecte traces, métricas e logs no Program.cs

O SDK é um único registro. Desde o OpenTelemetry .NET 1.8, `UseOtlpExporter()` é o helper transversal que registra o exportador OTLP para traces, métricas e logs em uma única chamada, substituindo o antigo `AddOtlpExporter()` por pipeline:

```csharp
// .NET 11, C# 14, OpenTelemetry 1.15.3
using OpenTelemetry.Logs;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOpenTelemetry()
    .ConfigureResource(r => r
        .AddService(
            serviceName: "orders-api",
            serviceVersion: typeof(Program).Assembly.GetName().Version?.ToString() ?? "0.0.0",
            serviceInstanceId: Environment.MachineName))
    .WithTracing(t => t
        .AddAspNetCoreInstrumentation()
        .AddHttpClientInstrumentation()
        .AddSource("Orders.*"))
    .WithMetrics(m => m
        .AddAspNetCoreInstrumentation()
        .AddHttpClientInstrumentation()
        .AddRuntimeInstrumentation()
        .AddMeter("Orders.*"))
    .WithLogging()
    .UseOtlpExporter();

var app = builder.Build();

app.MapGet("/orders/{id:int}", (int id) => new { id, status = "ok" });
app.Run();
```

Três coisas merecem destaque. Primeiro, `ConfigureResource` não é opcional na prática: sem `service.name`, todo backend vai jogar tudo embaixo de `unknown_service:dotnet`, o que se torna inviável no momento em que uma segunda aplicação aparece. Segundo, `AddSource("Orders.*")` é o que expõe suas instâncias personalizadas de `ActivitySource`; se você instancia uma com `new ActivitySource("Orders.Checkout")`, ela tem que casar com um glob que você registrou ou os spans não chegam a lugar nenhum. Terceiro, `WithLogging()` amarra `Microsoft.Extensions.Logging` ao mesmo pipeline, então uma chamada a `ILogger<T>` escreve registros de log estruturados do OpenTelemetry com o trace ID e o span ID atuais anexados. É isso que faz o link "View structured logs for this trace" do Aspire Dashboard funcionar.

## Configure o exportador a partir de variáveis de ambiente, não no código

O exportador OTLP padrão lê seu destino, protocolo e cabeçalhos a partir de variáveis de ambiente definidas pela especificação OpenTelemetry. Hardcodear esses valores dentro de `UseOtlpExporter(o => o.Endpoint = ...)` é um cheiro ruim porque amarra seu binário a um backend específico. Use variáveis de ambiente e a mesma imagem roda no laptop do desenvolvedor, no CI e em produção sem rebuild:

```bash
# Talk to a local Aspire Dashboard over gRPC
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4317"
export OTEL_EXPORTER_OTLP_PROTOCOL="grpc"
export OTEL_EXPORTER_OTLP_HEADERS="x-otlp-api-key=local-dev-key"
export OTEL_SERVICE_NAME="orders-api"
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment=dev"
```

Dois valores pegam a maioria das pessoas de surpresa. `OTEL_EXPORTER_OTLP_PROTOCOL` por padrão é `grpc` em .NET 8+ mas `http/protobuf` em builds .NET Standard 2.0, porque o SDK traz um cliente gRPC personalizado em targets modernos mas faz fallback para HTTP no Framework. Se você está fazendo bridging entre os dois, defina o valor explicitamente. E `OTEL_EXPORTER_OTLP_HEADERS` aceita uma lista separada por vírgulas de pares `chave=valor`. Backends que autenticam com bearer tokens usam isso para `Authorization=Bearer ...`. A chave de API do Aspire Dashboard é `x-otlp-api-key`, não a mais comum `Authorization`.

Quando você migra do desenvolvimento local para um backend implantado, a única mudança é o endpoint e o cabeçalho de auth. O binário da aplicação fica igual.

## Adicione um span personalizado com ActivitySource

Os pacotes de instrumentação cobrem HTTP de entrada e saída automaticamente, além do EF Core se você adicionou aquele. Todo o resto fica por sua conta. O .NET traz `System.Diagnostics.ActivitySource` como o primitivo cross-runtime para spans -- o OpenTelemetry .NET adota esse tipo diretamente em vez de introduzir um próprio. Crie um por área lógica, registre o prefixo no `AddSource`, e chame `StartActivity` onde você quiser um span:

```csharp
// Orders/CheckoutService.cs -- .NET 11, C# 14
using System.Diagnostics;

public sealed class CheckoutService(IOrdersRepository orders, IPaymentClient payments)
{
    private static readonly ActivitySource Source = new("Orders.Checkout");

    public async Task<CheckoutResult> CheckoutAsync(int orderId, CancellationToken ct)
    {
        using var activity = Source.StartActivity("checkout", ActivityKind.Internal);
        activity?.SetTag("order.id", orderId);

        var order = await orders.GetAsync(orderId, ct);
        activity?.SetTag("order.line_count", order.Lines.Count);

        var receipt = await payments.ChargeAsync(order, ct);
        activity?.SetTag("payment.provider", receipt.Provider);

        return new CheckoutResult(receipt.Id);
    }
}
```

`StartActivity` retorna `null` quando não há listener anexado, então as chamadas `?.SetTag` não são paranoia defensiva, elas evitam uma NullReferenceException em um build com OpenTelemetry desabilitado. Tags seguem as convenções semânticas do OpenTelemetry quando existe uma (`http.request.method`, `db.system`, `messaging.destination.name`); para valores específicos do domínio como `order.id`, prefixe com seu próprio namespace para mantê-las consultáveis sem colidir com as convenções.

O mesmo padrão se aplica a métricas com `System.Diagnostics.Metrics.Meter`. Crie um por área, registre com `AddMeter`, e use `Counter<T>`, `Histogram<T>` ou `ObservableGauge<T>` para gravar valores.

## Correlacione logs OTLP com traces

A razão para registrar `WithLogging()` e não apenas `WithTracing()` é correlação. Toda chamada a `ILogger<T>` dentro de um span ativo recebe automaticamente o `TraceId` e o `SpanId` do span anexados como campos do registro de log OTLP, e o Aspire Dashboard renderiza isso como um link clicável a partir da visualização do trace. A mesma correlação funciona em qualquer backend ciente de OpenTelemetry.

Se você já usa Serilog e não quer abrir mão dele, não precisa. O pacote `Serilog.Sinks.OpenTelemetry` escreve os eventos do Serilog como registros de log OTLP, e o provedor de logging do SDK do OpenTelemetry pode ser pulado em `WithLogging()`. O artigo de logging estruturado neste site tem um tratamento mais longo de [como configurar Serilog com Seq no .NET 11](/pt-br/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) e as mesmas regras de correlação de trace se aplicam quando você troca Seq por OTLP.

Para `Microsoft.Extensions.Logging` puro, a receita é mais curta: adicione `WithLogging()` ao pipeline do OpenTelemetry e desligue o provedor de console default em produção. `LogInformation("Order {OrderId} for {CustomerId} took {Elapsed} ms", id, customer, ms)` já é estruturado, e o OpenTelemetry serializa os placeholders nomeados como atributos do log OTLP. O provedor de console, em contraste, achata tudo de volta para uma única string, que é exatamente a regressão da qual você estava tentando escapar.

## Coloque o OpenTelemetry Collector na frente em produção

Em produção, raramente você quer que sua aplicação fale diretamente com um backend de observabilidade. Você quer um Collector no meio: um processo independente que recebe OTLP, aplica amostragem, limpa PII, agrupa em lotes, faz retry e bifurca os dados para um ou vários destinos. A imagem do Collector é `otel/opentelemetry-collector-contrib:0.111.0`, e uma configuração mínima que recebe OTLP e encaminha para Jaeger e mais um backend hospedado fica assim:

```yaml
# otel-collector-config.yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:
    timeout: 5s
    send_batch_size: 512
  attributes/scrub:
    actions:
      - key: http.request.header.authorization
        action: delete
      - key: user.email
        action: hash

exporters:
  otlp/jaeger:
    endpoint: jaeger:4317
    tls:
      insecure: true
  otlp/honeycomb:
    endpoint: api.honeycomb.io:443
    headers:
      x-honeycomb-team: ${env:HONEYCOMB_API_KEY}

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch, attributes/scrub]
      exporters: [otlp/jaeger, otlp/honeycomb]
```

O `OTEL_EXPORTER_OTLP_ENDPOINT` da aplicação agora aponta para o Collector, não para um backend específico. Trocar destinos é uma reconfiguração e restart no Collector, não um redeploy de cada serviço. O mesmo padrão é o que mantém seu volume de traces sob controle: coloque o processador `attributes/scrub` na frente de cada exportador e você para de mandar acidentalmente cabeçalhos de autorização para um terceiro logo no dia um.

## Pegadinhas que a documentação não avisa

Três coisas mordem as pessoas no caminho até um pipeline funcional.

Primeiro, **os defaults de gRPC e HTTP não combinam entre runtimes**. Em .NET 8 e posteriores, o SDK traz um cliente gRPC gerenciado e o `OTEL_EXPORTER_OTLP_PROTOCOL` por padrão é `grpc`. Em .NET Framework 4.8 e .NET Standard 2.0, o default é `http/protobuf` para evitar a dependência de `Grpc.Net.Client`. Se uma única solução faz target nos dois, defina o protocolo explicitamente ou você verá comportamentos diferentes do mesmo código em dois assemblies.

Segundo, **atributos de recurso são globais, não por pipeline**. `ConfigureResource` roda uma vez, e o resultado é anexado a cada trace, métrica e registro de log do processo. Tentar definir um atributo por requisição via API de recurso não faz nada silenciosamente; o que você quer ali é `Activity.SetTag` no span ativo, ou uma entrada de `Baggage` que se propaga pela chamada. A CVE de DoS de baggage no Aspire 13.2.4, documentada em [a análise da CVE de baggage do OpenTelemetry .NET](/pt-br/2026/04/aspire-13-2-4-opentelemetry-cve-2026-40894-baggage-dos/), é um lembrete de que baggage é parseado de forma antecipada em cada requisição e, portanto, é uma ferramenta útil mas afiada.

Terceiro, **o exportador OTLP faz retry silenciosamente em segundo plano**. Quando o backend está fora, o exportador continua agrupando eventos em memória e tentando novamente com backoff exponencial até um teto configurável. Geralmente é o que você quer; o que surpreende é que o Collector ou o dashboard voltarem a operar não dispara um flush instantâneo. Se você está rodando um teste de integração e afirmando "o trace X chegou ao Aspire Dashboard em 100 ms", dê ao exportador um cronograma de `BatchExportProcessor` mais curto que os 5 segundos default, ou chame `TracerProvider.ForceFlush()` explicitamente antes da asserção.

## Para onde ir a partir daqui

O valor do OpenTelemetry cresce com a área de superfície que você instrumenta. O ponto de partida é ASP.NET Core mais HttpClient mais EF Core. A partir daí, as adições de maior alavancagem são serviços em background (todo `IHostedService` deveria iniciar uma `Activity` por unidade de trabalho) e brokers de mensagem de saída (as instrumentações `OpenTelemetry.Instrumentation.MassTransit` e Confluent.Kafka cobrem a maioria dos times). Para profiling mais profundo de unidades de trabalho depois que os spans te levam ao minuto certo, [o guia de dotnet-trace neste site](/pt-br/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) percorre a ferramenta que mais frequentemente assume onde o OpenTelemetry para, e [o artigo do filtro de exceção global](/pt-br/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) cobre o lado ASP.NET Core de capturar falhas de forma limpa no mesmo pipeline.

O estado final que vale a pena perseguir é: um pipeline, um formato de transporte e um lugar único para olhar primeiro quando algo dá errado. OpenTelemetry mais o Aspire Dashboard mais um Collector na frente te levam até lá pelo preço de um docker pull.

Sources:

- [OpenTelemetry .NET Exporters documentation](https://opentelemetry.io/docs/languages/dotnet/exporters/)
- [OTLP Exporter for OpenTelemetry .NET](https://github.com/open-telemetry/opentelemetry-dotnet/blob/main/src/OpenTelemetry.Exporter.OpenTelemetryProtocol/README.md)
- [Use OpenTelemetry with the standalone Aspire Dashboard - .NET](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/observability-otlp-example)
- [.NET Observability with OpenTelemetry](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/observability-with-otel)
- [OpenTelemetry.Exporter.OpenTelemetryProtocol on NuGet](https://www.nuget.org/packages/OpenTelemetry.Exporter.OpenTelemetryProtocol)
