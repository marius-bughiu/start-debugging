---
title: "Como adicionar um endpoint de health check a uma minimal API no ASP.NET Core 11"
description: "Um guia completo e funcional de health checks em uma minimal API do ASP.NET Core 11: AddHealthChecks e MapHealthChecks, classes IHealthCheck personalizadas que retornam Healthy/Degraded/Unhealthy, a sonda de EF Core AddDbContextCheck, endpoints de liveness e readiness baseados em tags para Kubernetes, um ResponseWriter JSON, ResultStatusCodes, como proteger o endpoint com RequireAuthorization e RequireHost, e como enviar resultados com IHealthCheckPublisher."
pubDate: 2026-07-19
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-api"
  - "health-checks"
lang: "pt-br"
translationOf: "2026/07/how-to-add-a-health-check-endpoint-to-a-minimal-api-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-19
---

Para adicionar um endpoint de health check a uma minimal API no ASP.NET Core 11 você chama `builder.Services.AddHealthChecks()` para registrar o serviço, opcionalmente encadeia chamadas a `.AddCheck(...)` para descrever o que significa "healthy" para sua aplicação, e então chama `app.MapHealthChecks("/healthz")` para expor um endpoint. Acesse essa URL e você obtém `200 OK` com o corpo `Healthy` quando todas as verificações passam, ou `503 Service Unavailable` quando alguma verificação reporta `Unhealthy`. Essa configuração de duas linhas é o mínimo completo. Este post o leva desse mínimo até uma configuração pronta para produção: um `IHealthCheck` personalizado que realmente sonda uma dependência, a sonda de banco de dados integrada do EF Core, endpoints separados de liveness e readiness conectados para o Kubernetes, um corpo de resposta JSON, códigos de status HTTP corretos, e como travar o endpoint. Ele tem como alvo o .NET 11 (Preview 6 no momento em que escrevo, GA em novembro de 2026) com `Microsoft.NET.Sdk.Web` e C# 14, mas a API de health checks é estável desde o ASP.NET Core 2.2, então cada exemplo aqui funciona sem alterações no .NET 8, 9 e 10.

## Para que serve realmente um endpoint de health check

Um endpoint de health check é uma URL que um orquestrador, balanceador de carga ou monitor de disponibilidade pode consultar para perguntar "devo enviar tráfego para esta instância?" A resposta é deliberadamente grosseira: um status agregado calculado a partir de um conjunto de verificações registradas, exposto como um código de status HTTP para que qualquer coisa que fale HTTP possa consumi-lo sem analisar um corpo. O Kubernetes o usa para decidir se reinicia um pod ou roteia requisições para ele. Um Azure App Service ou um target group da AWS o usa para retirar uma instância não saudável de rotação. Uma ferramenta como o Uptime Kuma o usa para te avisar.

O ponto-chave de design é que um health check não é um endpoint de métricas nem um painel de diagnóstico. Ele responde uma pergunta rápido, idealmente em poucos milissegundos, e suas verificações devem testar apenas as coisas que genuinamente determinam se este processo consegue atender requisições: o banco de dados está acessível, uma API downstream crítica está respondendo, a aplicação terminou seu trabalho de inicialização. Empilhar sondas lentas ou não essenciais nele transforma um sinal de liveness em um passivo, porque um health check lento sob carga provoca os reinícios em cascata que ele deveria prevenir.

## Passos para adicionar um endpoint de health check

1. Registre o serviço com `builder.Services.AddHealthChecks()`, que retorna um `IHealthChecksBuilder`.
2. Encadeie chamadas `.AddCheck(...)` ou `.AddCheck<T>(...)` nesse builder para cada dependência que você quer sondar.
3. Compile a aplicação e chame `app.MapHealthChecks("/healthz")` para mapear o endpoint.
4. Opcionalmente passe um `HealthCheckOptions` para filtrar verificações por tag, moldar a resposta ou remapear códigos de status.
5. Opcionalmente encadeie `.RequireAuthorization()` ou `.RequireHost(...)` para controlar quem pode alcançá-lo.

O restante deste artigo expande cada um desses passos em código funcional.

## O ponto de partida de duas linhas

Aqui está a menor coisa que funciona. `AddHealthChecks` sem verificações registradas ainda é útil: ele te dá um endpoint de liveness que retorna `Healthy` enquanto o processo estiver de pé e o pipeline de requisições estiver girando.

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddHealthChecks();

var app = builder.Build();

app.MapHealthChecks("/healthz");

app.Run();
```

Um `GET /healthz` agora retorna `200 OK` com o corpo em texto puro `Healthy`. Não há verificações registradas, então não há nada que possa falhar. Isso por si só responde "o processo está vivo e atendendo HTTP", que é precisamente o que uma sonda de liveness do Kubernetes quer. Tudo a partir deste ponto é sobre registrar verificações que possam reportar algo diferente de saudável, e sobre moldar como o endpoint se comunica.

## Escrevendo uma verificação personalizada com IHealthCheck

Uma verificação real sonda uma dependência e reporta um de três estados. Implemente `IHealthCheck`, cujo único método retorna um `HealthCheckResult`:

```csharp
// .NET 11, C# 14
using Microsoft.Extensions.Diagnostics.HealthChecks;

public sealed class QueueDepthHealthCheck : IHealthCheck
{
    private readonly IMessageQueue _queue;

    public QueueDepthHealthCheck(IMessageQueue queue) => _queue = queue;

    public async Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context,
        CancellationToken cancellationToken = default)
    {
        try
        {
            var depth = await _queue.GetApproximateDepthAsync(cancellationToken);

            if (depth > 10_000)
            {
                return HealthCheckResult.Unhealthy(
                    $"Queue backlog is {depth} messages.");
            }

            if (depth > 1_000)
            {
                // Still serving, but the backlog is a warning sign.
                return HealthCheckResult.Degraded(
                    $"Queue backlog is {depth} messages.",
                    data: new Dictionary<string, object> { ["depth"] = depth });
            }

            return HealthCheckResult.Healthy($"Queue depth {depth}.");
        }
        catch (Exception ex)
        {
            // Could not even reach the queue: that is unhealthy, not an unhandled 500.
            return HealthCheckResult.Unhealthy("Queue is unreachable.", ex);
        }
    }
}
```

Os três métodos de fábrica correspondem aos três membros do enum `HealthStatus`. `Healthy` significa plenamente operacional. `Unhealthy` significa que esta instância não consegue fazer seu trabalho e deve ser retirada de rotação ou reiniciada. `Degraded` é o meio-termo interessante: a aplicação ainda atende requisições, mas algo está errado (uma dependência lenta, um backlog crescente), e por padrão um resultado degradado ainda retorna `200 OK`. Isso é deliberado: normalmente você não quer que um orquestrador reinicie um pod só porque uma fila está enchendo. O dicionário opcional `data` viaja junto no relatório e aparece em um corpo de resposta JSON, o que é útil para um painel sem mudar a decisão de aprovado/reprovado.

Registre a classe e dê a ela um nome e, opcionalmente, um status de falha e tags:

```csharp
// .NET 11, C# 14
builder.Services.AddHealthChecks()
    .AddCheck<QueueDepthHealthCheck>(
        "queue",
        failureStatus: HealthStatus.Unhealthy,
        tags: ["ready"]);
```

A dependência do construtor (`IMessageQueue`) é resolvida a partir da injeção de dependência, então sua verificação pode injetar qualquer serviço registrado. Se você precisar passar argumentos literais ao construtor que não estão no contêiner, use `AddTypeActivatedCheck<T>(...)` e forneça um array `args` em vez disso.

Para uma verificação inline descartável que não merece uma classe, a forma lambda basta:

```csharp
// .NET 11, C# 14
builder.Services.AddHealthChecks()
    .AddCheck("self", () => HealthCheckResult.Healthy(), tags: ["live"]);
```

## Sondando o banco de dados com AddDbContextCheck

A coisa mais comum que as equipes querem em uma sonda de readiness é "consigo alcançar o banco de dados". Você não precisa escrever um `IHealthCheck` para isso. Adicione o pacote `Microsoft.Extensions.Diagnostics.HealthChecks.EntityFrameworkCore` e use o `AddDbContextCheck<TContext>` integrado:

```csharp
// .NET 11, C# 14
builder.Services.AddDbContext<AppDbContext>(options =>
    options.UseSqlServer(
        builder.Configuration.GetConnectionString("DefaultConnection")));

builder.Services.AddHealthChecks()
    .AddDbContextCheck<AppDbContext>("database", tags: ["ready"]);
```

Por baixo dos panos isso chama `DbContext.Database.CanConnectAsync`, que abre uma conexão e a fecha sem executar uma consulta. Esse é o padrão certo: é barato e verifica exatamente o que uma sonda de readiness se importa, que a connection string resolva e o servidor aceite conexões. Se você precisar de algo mais forte, `AddDbContextCheck` tem uma sobrecarga que recebe uma consulta de teste personalizada, mas para o caso comum `CanConnectAsync` é o que você quer. Para uma configuração mais profunda sobre preparar o EF Core antes do primeiro uso, veja [como preparar o modelo do EF Core antes da primeira consulta](/pt-br/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/); uma verificação que executa `CanConnectAsync` é um lugar natural para que esse aquecimento já tenha acontecido.

Pacotes da comunidade sob `AspNetCore.Diagnostics.HealthChecks` (o projeto Xabaril) fornecem verificações prontas para Redis, RabbitMQ, PostgreSQL, blob storage e dezenas de outras dependências com o mesmo padrão `.Add...`, então você raramente precisa escrever à mão uma sonda para um serviço conhecido.

## Endpoints separados de liveness e readiness

O Kubernetes distingue duas sondas, e confundi-las é o erro mais comum de health check. Uma sonda de liveness responde "este processo travou e precisa de um reinício"; se ela falha, o Kubernetes mata o pod. Uma sonda de readiness responde "esta instância está pronta para receber tráfego agora"; se ela falha, o Kubernetes para de rotear para ela mas a deixa em execução. Você não quer que seu banco de dados estar momentaneamente inacessível dispare um reinício de pod, porque um reinício não consegue consertar o banco de dados e só remove capacidade. Então a verificação de banco de dados pertence a readiness, não a liveness.

O mecanismo são tags mais o `Predicate` no `HealthCheckOptions`. Registre as verificações com tags, depois mapeie dois endpoints que cada um filtre para o conjunto certo:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Diagnostics.HealthChecks;

app.MapHealthChecks("/health/live", new HealthCheckOptions
{
    // Liveness: run no dependency checks. If the pipeline responds, we are alive.
    Predicate = _ => false
});

app.MapHealthChecks("/health/ready", new HealthCheckOptions
{
    // Readiness: only the checks tagged "ready" (database, queue, downstreams).
    Predicate = check => check.Tags.Contains("ready")
});
```

`Predicate = _ => false` significa "não inclua nenhuma verificação", então `/health/live` faz curto-circuito para `Healthy` no momento em que a requisição alcança o endpoint. `/health/ready` executa apenas as verificações que você marcou como `ready`. Aponte seu `livenessProbe` do Kubernetes para `/health/live` e seu `readinessProbe` para `/health/ready`, e as duas preocupações permanecem limpamente separadas.

## Retornando JSON em vez de texto puro

O corpo de resposta padrão é a única palavra `Healthy`, `Degraded` ou `Unhealthy`. Isso basta para uma sonda, mas é inútil para uma pessoa depurando por que a readiness está falhando. Forneça um `ResponseWriter` para emitir JSON com detalhe por verificação:

```csharp
// .NET 11, C# 14
using System.Text.Json;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.Extensions.Diagnostics.HealthChecks;

static Task WriteJsonResponse(HttpContext context, HealthReport report)
{
    context.Response.ContentType = "application/json; charset=utf-8";

    var payload = new
    {
        status = report.Status.ToString(),
        totalDurationMs = report.TotalDuration.TotalMilliseconds,
        checks = report.Entries.Select(e => new
        {
            name = e.Key,
            status = e.Value.Status.ToString(),
            description = e.Value.Description,
            durationMs = e.Value.Duration.TotalMilliseconds
        })
    };

    return context.Response.WriteAsync(JsonSerializer.Serialize(payload));
}

app.MapHealthChecks("/health/ready", new HealthCheckOptions
{
    Predicate = check => check.Tags.Contains("ready"),
    ResponseWriter = WriteJsonResponse
});
```

Agora uma verificação de readiness que falha retorna um corpo que nomeia a verificação, seu status, sua descrição e quanto tempo levou, então você consegue ver de relance que "database" é a entrada que ficou `Unhealthy`. O objeto `HealthReport` expõe `Status` (o agregado), `TotalDuration` e um dicionário `Entries` indexado pelos nomes de verificação que você registrou. Note que o código de status é controlado separadamente do corpo: um `503` pode carregar este JSON tranquilamente.

## Controlando o código de status

Por padrão o framework mapeia `Healthy` e `Degraded` para `200 OK` e `Unhealthy` para `503 Service Unavailable`. Esse mapeamento é o que os balanceadores de carga esperam, então mude-o apenas quando tiver um motivo específico. Quando mudar, `ResultStatusCodes` é o botão:

```csharp
// .NET 11, C# 14
app.MapHealthChecks("/health/ready", new HealthCheckOptions
{
    Predicate = check => check.Tags.Contains("ready"),
    ResultStatusCodes =
    {
        [HealthStatus.Healthy] = StatusCodes.Status200OK,
        [HealthStatus.Degraded] = StatusCodes.Status200OK,
        [HealthStatus.Unhealthy] = StatusCodes.Status503ServiceUnavailable
    }
});
```

Uma sutileza que vale a pena internalizar: como `Degraded` retorna `200` por padrão, um balanceador de carga trata uma instância degradada como saudável e continua enviando tráfego para ela. Isso normalmente está correto, mas se sua definição de "degradado" for severa o suficiente para você querer tirá-la de rotação, ou mapeie `Degraded` para `503` aqui ou retorne `Unhealthy` da verificação em vez de `Degraded`. Não deixe a intenção ambígua.

Outro padrão que vale conhecer: as respostas de health check definem cabeçalhos no-cache para que um intermediário não possa servir um `Healthy` obsoleto enquanto a instância na verdade está falhando. Se você algum dia precisar de cache, `AllowCachingResponses = true` nas opções o desativa, mas você quase nunca quer isso em uma sonda.

## Travando o endpoint

Um endpoint de saúde que retorna JSON detalhado é uma pequena superfície de divulgação de informação: ele nomeia suas dependências e pode vazar detalhes de falha. Há duas formas limpas de restringi-lo. `RequireHost` limita o endpoint a um host ou porta específico, que é o truque padrão para expor a saúde apenas em uma porta de gerenciamento interna que não é roteada publicamente:

```csharp
// .NET 11, C# 14
app.MapHealthChecks("/health/ready", new HealthCheckOptions
{
    Predicate = check => check.Tags.Contains("ready")
})
.RequireHost("*:8081");
```

`RequireAuthorization` coloca o endpoint atrás das suas políticas de autorização, que se combinam com qualquer autenticação que você tenha configurado. Se você já roda autenticação JWT bearer, adicioná-la ao endpoint de saúde é uma única chamada:

```csharp
// .NET 11, C# 14
app.MapHealthChecks("/health/ready")
    .RequireAuthorization();
```

Um alerta: não exija autorização no endpoint que seu orquestrador sonda, porque o orquestrador não apresentará um token e a sonda falhará. Mantenha abertos os endpoints simples de liveness/readiness (restrinja por host ou rede em vez disso) e coloque o endpoint detalhado que emite JSON atrás de autorização se é que você o expõe. A mecânica de configurar o lado do token está coberta em [como configurar autenticação JWT bearer em uma minimal API no ASP.NET Core 11](/pt-br/2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11/).

## Enviando resultados em vez de esperar ser consultado

Tudo acima é baseado em pull: algo chama seu endpoint. O framework também suporta relatório baseado em push através do `IHealthCheckPublisher`, que executa as verificações registradas em um temporizador e entrega o `HealthReport` agregado ao seu código para que você possa encaminhá-lo a um sistema de monitoramento, emitir uma métrica ou registrar um alerta:

```csharp
// .NET 11, C# 14
using Microsoft.Extensions.Diagnostics.HealthChecks;

public sealed class LoggingHealthCheckPublisher : IHealthCheckPublisher
{
    private readonly ILogger<LoggingHealthCheckPublisher> _logger;

    public LoggingHealthCheckPublisher(ILogger<LoggingHealthCheckPublisher> logger)
        => _logger = logger;

    public Task PublishAsync(HealthReport report, CancellationToken cancellationToken)
    {
        if (report.Status != HealthStatus.Healthy)
        {
            _logger.LogWarning(
                "Health degraded: {Status} across {Count} checks.",
                report.Status, report.Entries.Count);
        }
        return Task.CompletedTask;
    }
}

builder.Services.AddSingleton<IHealthCheckPublisher, LoggingHealthCheckPublisher>();
builder.Services.Configure<HealthCheckPublisherOptions>(options =>
{
    options.Delay = TimeSpan.FromSeconds(5);   // Wait before the first run.
    options.Period = TimeSpan.FromSeconds(30); // Then run every 30 seconds.
    options.Predicate = check => check.Tags.Contains("ready");
});
```

O publisher roda em um serviço em segundo plano hospedado que o framework registra assim que qualquer `IHealthCheckPublisher` está no contêiner, então você obtém execução periódica sem fiar seu próprio temporizador. Este é o lugar idiomático para alimentar a saúde em um pipeline de métricas; se você já exporta telemetria, combine-o com [OpenTelemetry no .NET 11](/pt-br/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) para que o status degradado apareça junto aos seus traces. Ele também se dá bem com qualquer [monitoramento de trabalhos em segundo plano](/pt-br/2026/01/monitor-background-jobs-in-net-9-and-net-10-without-hangfire-health-metrics-alerts/) que você já execute, já que um publisher é simplesmente outro consumidor do mesmo relatório.

## MapHealthChecks versus UseHealthChecks, e onde as verificações rodam

Tutoriais mais antigos usam `app.UseHealthChecks("/healthz")`, que é middleware que faz curto-circuito no pipeline quando o caminho corresponde. `MapHealthChecks` é o equivalente ciente do roteamento e o que se deve preferir em qualquer minimal API moderna, porque participa do roteamento de endpoints, que é o que faz `RequireAuthorization`, `RequireHost` e `RequireCors` funcionarem. Essas convenções de endpoint não têm significado na forma de middleware. No .NET 8 e posteriores você também pode encadear `.ShortCircuit()` em um endpoint de saúde mapeado para pular o restante do pipeline de middleware para aquela requisição, economizando um pouco de overhead em uma sonda de alta frequência.

Um lembrete operacional: as verificações executam dentro da requisição que alcançou o endpoint, usando serviços scoped resolvidos para aquela requisição. Se uma verificação precisar de uma dependência scoped como um `DbContext`, essa resolução simplesmente funciona porque o endpoint roda em um escopo de requisição. Essa é a mesma preocupação de escopo que morde quem busca serviços scoped a partir de singletons de vida longa, exatamente a armadilha que [usar serviços scoped dentro de um BackgroundService](/pt-br/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/) existe para resolver; um health check nunca a toca, porque já tem um escopo de requisição.

## A forma a lembrar

Um endpoint de health check é `AddHealthChecks()` para registrar o serviço, `.AddCheck<T>(...)` (ou `.AddDbContextCheck<T>()`, ou uma lambda) para cada dependência que valha a pena sondar, e `MapHealthChecks("/path")` para expô-lo. Retorne `Healthy`, `Degraded` ou `Unhealthy` de cada verificação, e lembre que `Unhealthy` é um `503` enquanto os outros dois são `200` por padrão. Separe liveness de readiness com tags e um `Predicate` para que um banco de dados instável nunca reinicie um pod saudável, adicione um `ResponseWriter` quando uma pessoa precisar ler o resultado, proteja o endpoint com `RequireHost` em vez de autorização no caminho da sonda, e recorra a `IHealthCheckPublisher` quando quiser push em vez de pull. Essa é a superfície completa, e cada linha acima roda no .NET 8 até o .NET 11 sem alterações.

## Relacionados

- [Como usar serviços scoped dentro de um BackgroundService no ASP.NET Core 11](/pt-br/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/)
- [Como organizar os endpoints de uma minimal API com MapGroup no ASP.NET Core 11](/pt-br/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [Como configurar autenticação JWT bearer em uma minimal API no ASP.NET Core 11](/pt-br/2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11/)
- [Como usar OpenTelemetry com .NET 11 e um backend gratuito](/pt-br/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/)
- [Como preparar o modelo do EF Core antes da primeira consulta](/pt-br/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/)

## Fontes

- [Health checks in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/health-checks)
- [IHealthCheck interface (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.diagnostics.healthchecks.ihealthcheck)
- [HealthCheckOptions (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.diagnostics.healthchecks.healthcheckoptions)
- [AddDbContextCheck extension (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.entityframeworkcorehealthchecksbuilderextensions.adddbcontextcheck)
- [AspNetCore.Diagnostics.HealthChecks (Xabaril, GitHub)](https://github.com/Xabaril/AspNetCore.Diagnostics.HealthChecks)
