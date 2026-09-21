---
title: "Como adicionar o id do usuário atual a cada entrada de log no ASP.NET Core"
description: "Um middleware com BeginScope deixa de fora o log de erro do exception handler e a linha Request finished. Registre um ILogEnricher que lê o usuário a partir do IHttpContextAccessor, abra um scope só quando o trabalho sai da requisição e cuidado com o AddSerilog do Serilog cancelando o enriquecimento sem avisar."
pubDate: 2026-09-21
template: how-to
tags:
  - "aspnet-core"
  - "dotnet-10"
  - "logging"
  - "observability"
  - "opentelemetry"
  - "serilog"
  - "how-to"
lang: "pt-br"
translationOf: "2026/09/how-to-add-the-current-user-id-to-every-log-entry-in-aspnet-core"
translatedBy: "claude"
translationDate: 2026-09-21
---

Resposta curta: não passe o id do usuário em cada chamada a `LogInformation` e não pare em um middleware que envolve o pipeline em `ILogger.BeginScope`. Esse scope só cobre chamadas de log feitas *dentro* dele, então perde justamente as duas linhas que você mais quer quando algo quebra: o erro do `ExceptionHandlerMiddleware` e a entrada "Request finished" do hosting. Em vez disso, adicione `Microsoft.Extensions.Telemetry`, chame `builder.Logging.EnableEnrichment()` e registre um `ILogEnricher` com `builder.Services.AddLogEnricher<UserIdEnricher>()` que lê `ClaimTypes.NameIdentifier` a partir do `IHttpContextAccessor`. Ele roda uma vez por registro de log, para todas as categorias, inclusive as do próprio framework. O único lugar em que ele não ajuda é o trabalho que sobrevive à requisição, então capture o id antes de entregar o trabalho a `Task.Run` ou a uma fila e abra um scope ali.

Tudo abaixo foi executado no .NET 10 (SDK 10.0.302, runtime do ASP.NET Core 10.0.10) com `Microsoft.Extensions.Telemetry` 10.10.0, `OpenTelemetry.Extensions.Hosting` e `OpenTelemetry.Exporter.Console` 1.19.1 e `Serilog.AspNetCore` 10.0.0. A tabela de resultados vem de requisições reais contra um pequeno app de teste, não da leitura da documentação.

## Por que um middleware com BeginScope parece certo e não é

A primeira resposta que você encontra no StackOverflow é um middleware como este:

```csharp
// .NET 10, ASP.NET Core 10: the common approach, and its gap
app.UseExceptionHandler("/error");
app.UseAuthentication();

app.Use(async (ctx, next) =>
{
    var userId = ctx.User.FindFirstValue(ClaimTypes.NameIdentifier);
    if (userId is null) { await next(ctx); return; }

    var logger = ctx.RequestServices.GetRequiredService<ILoggerFactory>()
        .CreateLogger("UserScope");
    using (logger.BeginScope(new Dictionary<string, object?> { ["UserId"] = userId }))
    {
        await next(ctx);
    }
});

app.UseAuthorization();
```

Funciona para o seu próprio código. Um `log.LogInformation("Loading orders")` dentro de um endpoint sai com `"UserId":"u-42"` nos seus scopes. O problema é estrutural. Os scopes de logging vivem em um `AsyncLocal`, então se anexam às chamadas de log feitas enquanto o bloco `using` está na pilha. Duas linhas de log importantes são escritas depois que esse bloco já foi descartado:

- `UseExceptionHandler` fica fora do middleware de scope (precisa ficar, senão não consegue capturar exceções da autenticação). Quando ele registra "An unhandled exception has occurred while executing the request.", a exceção já atravessou o seu `using` e o scope sumiu.
- "Request finished ... 500" é escrito por `Microsoft.AspNetCore.Hosting.Diagnostics`, que envolve o pipeline de middleware inteiro. Nenhum middleware que você escreva consegue colocar um scope ao redor disso.

Então o log de erro, a entrada que o suporte vai procurar pelo id do usuário, é justamente a entrada sem id do usuário. Mover o middleware de scope para cima de `UseExceptionHandler` também não resolve, porque o usuário só é conhecido depois que a autenticação rodou.

O mesmo comportamento do `AsyncLocal` tem uma vantagem que o enricher não tem: um scope flui com o `ExecutionContext` para dentro de `Task.Run` e outras continuações, então trabalho fire-and-forget iniciado dentro da requisição mantém o id mesmo depois que a resposta foi enviada.

## O que cada abordagem realmente marca

Executei três requisições com um usuário autenticado `u-42` contra o mesmo app em cada configuração: um endpoint que faz log, um endpoint que lança exceção e um endpoint que inicia um `Task.Run` que faz log 300 ms depois de a resposta ter sido enviada. A saída passou por `AddJsonConsole` com `IncludeScopes = true` e depois foi repetida com o exporter de console do OpenTelemetry.

| Entrada de log | Middleware `BeginScope` | `ILogEnricher` | Enricher + scope na entrega |
| --- | --- | --- | --- |
| "Request starting" (hosting) | não | não | não |
| `LogInformation` do próprio endpoint | sim | sim | sim |
| Erro do `ExceptionHandlerMiddleware` | **não** | sim | sim |
| "Request finished" (hosting) | **não** | sim | sim |
| Log do `Task.Run` após a resposta | sim | **não** | sim |

"Request starting" não pode ser marcado por design: ele é escrito antes de a autenticação rodar, então ainda não existe usuário. Use o `TraceId` compartilhado para ligá-lo ao resto da requisição.

## Passo 1: adicione o enricher

O enriquecimento de logs faz parte das bibliotecas `dotnet/extensions`. `ILogEnricher` e `AddLogEnricher` ficam em `Microsoft.Extensions.Telemetry.Abstractions`; `EnableEnrichment()` fica em `Microsoft.Extensions.Telemetry`, que referencia as abstrações, então um pacote basta:

```bash
dotnet add package Microsoft.Extensions.Telemetry --version 10.10.0
```

O enricher em si tem poucas linhas:

```csharp
// .NET 10, Microsoft.Extensions.Telemetry 10.10.0
using System.Security.Claims;
using Microsoft.Extensions.Diagnostics.Enrichment;

public sealed class UserIdEnricher(IHttpContextAccessor accessor) : ILogEnricher
{
    public void Enrich(IEnrichmentTagCollector collector)
    {
        var userId = accessor.HttpContext?.User.FindFirstValue(ClaimTypes.NameIdentifier);
        if (userId is not null)
        {
            collector.Add("user.id", userId);
        }
    }
}
```

Depois conecte tudo em `Program.cs`:

```csharp
// .NET 10, ASP.NET Core 10, Microsoft.Extensions.Telemetry 10.10.0
var builder = WebApplication.CreateBuilder(args);

builder.Logging.EnableEnrichment();
builder.Services.AddHttpContextAccessor();
builder.Services.AddLogEnricher<UserIdEnricher>();

builder.Services.AddAuthentication(/* your scheme */);
builder.Services.AddAuthorization();

var app = builder.Build();
app.UseExceptionHandler("/error");
app.UseAuthentication();
app.UseAuthorization();
```

Nenhum middleware é necessário. `EnableEnrichment()` troca o `LoggerFactory` padrão pelo estendido de `Microsoft.Extensions.Telemetry`, que chama cada `ILogEnricher` registrado uma vez para cada registro de log e acrescenta as tags ao state do registro. Como o enricher lê o usuário no momento da chamada de log, e não no momento em que um scope foi aberto, ele ainda encontra o usuário quando o exception handler e o hosting diagnostics escrevem suas entradas: o `HttpContext` está vivo até a requisição terminar.

Na saída do console JSON a tag aparece em `State`, ao lado dos parâmetros do message template, e não em `Scopes`:

```json
{"EventId":1,"LogLevel":"Error","Category":"Microsoft.AspNetCore.Diagnostics.ExceptionHandlerMiddleware","Message":"An unhandled exception has occurred while executing the request.","State":{"user.id":"u-42","exception.type":"System.InvalidOperationException","{OriginalFormat}":"An unhandled exception has occurred while executing the request."}}
```

Removi o texto da exceção e os scopes. Repare na tag `exception.type` que vem de graça: o logger estendido a adiciona a qualquer registro que carregue uma exceção, o que transforma "todas as falhas deste usuário, agrupadas por tipo de exceção" em uma única consulta.

Alguns detalhes importam aqui:

- `AddLogEnricher<T>` registra o enricher como **singleton** (`AddSingleton<ILogEnricher, T>()` no código-fonte). Injete apenas singletons. `IHttpContextAccessor` é um singleton que lê um `AsyncLocal`, e é exatamente por isso que funciona; um serviço scoped como o seu `DbContext` ou um serviço de usuário por requisição seria capturado uma única vez a partir do provider raiz.
- Registrá-lo duas vezes faz com que rode duas vezes, porque ele usa `AddSingleton`, não `TryAddEnumerable`.
- O enricher roda para todo registro de log do processo, inclusive na inicialização e em serviços em segundo plano. Mantenha-o sem alocações e deixe-o retornar em silêncio quando `HttpContext` for null.

## Passo 2: leve o id além do limite da requisição

`IHttpContextAccessor.HttpContext` passa a ser null quando a requisição termina, então o enricher não consegue marcar trabalho que sobrevive à requisição. Essa é a última linha da tabela. Capture o id enquanto você ainda tem a requisição e abra um scope dentro do trabalho em segundo plano:

```csharp
// .NET 10, ASP.NET Core 10
app.MapPost("/reports", (HttpContext ctx, ILogger<Program> log) =>
{
    var userId = ctx.User.FindFirstValue(ClaimTypes.NameIdentifier);

    _ = Task.Run(async () =>
    {
        using var scope = log.BeginScope("user.id:{user.id}", userId);
        await Task.Delay(300);
        log.LogInformation("Background work finished");
    });

    return Results.Accepted();
});
```

Com essa mudança a linha em segundo plano saiu com um scope `{"Message":"user.id:u-42","user.id":"u-42"}`, então todas as linhas da tabela ficam marcadas, exceto "Request starting". Use a mesma chave do enricher para que suas consultas não precisem de um `OR`.

Duas observações sobre esse trecho. Primeiro, use a sobrecarga de `BeginScope` com message template: um scope com `Dictionary<string, object?>` puro funciona, mas os exporters de console e do OpenTelemetry imprimem o seu `ToString()`, que é ``System.Collections.Generic.Dictionary`2[System.String,System.Object]``, como mensagem do scope. Segundo, `Task.Run` a partir de um endpoint é apenas um substituto para uma entrega de trabalho. Para trabalho fire-and-forget de verdade, coloque o id do usuário no item de trabalho que você enfileira para um `BackgroundService` e abra o scope quando o worker o retirar da fila. O padrão e suas armadilhas estão em [executar trabalho fire-and-forget com segurança usando BackgroundService](/pt-br/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/).

## Passo 3: garanta que o seu sink realmente mostre o id

Onde a tag vai parar depende do provider.

**Formatadores de console.** Tags enriquecidas fazem parte do state, então `AddJsonConsole` as mostra mesmo com `IncludeScopes = false`. O scope da entrega do Passo 2 precisa de `IncludeScopes = true`, que vem desligado por padrão em todos os formatadores de console. O formatador de console simples não imprime propriedades do state nem, sem `IncludeScopes`, scopes, então use o formatador JSON ou um sink de verdade.

**OpenTelemetry.** Com `builder.Logging.AddOpenTelemetry(o => { o.IncludeScopes = true; o.AddConsoleExporter(); })` a tag enriquecida virou um atributo comum do registro de log (`LogRecord.Attributes: user.id: u-42`) no log do endpoint, no erro do exception handler e em "Request finished", enquanto o scope da entrega chegou como `[Scope.3]:UserId: u-42` em `ScopeValues`. Sem `IncludeScopes = true` os valores de scope são descartados, então a linha em segundo plano perderia o id. Se você já está migrando para o OpenTelemetry, [a migração de logging do Serilog para o OpenTelemetry](/pt-br/2026/06/migrate-from-serilog-to-opentelemetry-logging-in-dotnet-11/) cobre o lado do exporter.

**Serilog: a armadilha.** Esta foi a que mais me custou tempo. `Serilog.AspNetCore` recomenda `builder.Services.AddSerilog(...)`, que registra o `ILoggerFactory` do próprio Serilog. `EnableEnrichment()` também substitui o `ILoggerFactory`. O último registro vence, e nenhum dos dois avisa você:

| Registro | Resultado |
| --- | --- |
| `Services.AddSerilog(...)`, depois `EnableEnrichment()` | **Nenhuma saída de log**: a factory estendida vence e não tem providers |
| `EnableEnrichment()`, depois `Services.AddSerilog(...)` | Os logs funcionam, mas o enricher nunca roda; nenhum `user.id` em lugar algum |
| `EnableEnrichment()` mais `builder.Logging.AddSerilog(logger)` | Funciona em qualquer ordem; `user.id` em todas as linhas que o enricher cobre |

A primeira linha não é força de expressão. O app atendeu requisições e escreveu zero bytes no stdout. A combinação que funciona registra o Serilog como um `ILoggerProvider` sob a factory da Microsoft:

```csharp
// .NET 10, Serilog.AspNetCore 10.0.0, Microsoft.Extensions.Telemetry 10.10.0
using Serilog;
using Serilog.Formatting.Compact;

var serilog = new LoggerConfiguration()
    .MinimumLevel.Information()
    .Enrich.FromLogContext()
    .WriteTo.Console(new CompactJsonFormatter())
    .CreateLogger();

builder.Logging.ClearProviders();
builder.Logging.AddSerilog(serilog, dispose: true);
builder.Logging.EnableEnrichment();
builder.Services.AddHttpContextAccessor();
builder.Services.AddLogEnricher<UserIdEnricher>();
```

O Serilog transforma a tag enriquecida em uma propriedade `user.id` de primeira classe e também captura os valores de `BeginScope`, então o scope do Passo 2 funciona sem alterações. O custo é que `Services.AddSerilog` também é o que registra o `IDiagnosticContext` do Serilog, que `UseSerilogRequestLogging` precisa. Se você depende desse middleware, mantenha `Services.AddSerilog`, pule `EnableEnrichment` e faça do jeito do Serilog: envie o id com `LogContext.PushProperty("UserId", userId)` em um middleware depois de `UseAuthentication` e adicione-o ao evento de conclusão com `options.EnrichDiagnosticContext = (dc, http) => dc.Set("UserId", http.User.FindFirstValue(ClaimTypes.NameIdentifier))`. Medi o middleware com `PushProperty` sozinho e ele tem exatamente as mesmas lacunas do `BeginScope` (nenhum id no erro do exception handler nem em "Request finished"), e é por isso que o callback do diagnostic context importa. A configuração base do Serilog está em [logging estruturado com Serilog e Seq](/pt-br/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/).

## Armadilhas que mordem em produção

**O id do usuário é dado pessoal.** Sob a GDPR, um identificador de conta estável anexado a cada linha de log torna esses logs dados pessoais, o que afeta a retenção e quem pode lê-los. Registre um id interno opaco, nunca um endereço de e-mail ou uma claim `name`, e, se a sua equipe de compliance exigir, aplique hash ou redação na camada de logging. O suporte a redação do .NET faz isso por propriedade; veja [redigir valores sensíveis com LogProperties](/pt-br/2026/08/how-to-redact-sensitive-values-from-logs-with-logproperties-in-dotnet/).

**Escolha a claim certa.** `ClaimTypes.NameIdentifier` é o que o ASP.NET Core Identity e a autenticação por cookie preenchem. O JWT bearer mapeia a claim `sub` do token para `NameIdentifier` somente enquanto `JwtBearerOptions.MapInboundClaims` for `true`, que é o padrão. Muitas APIs desligam isso para manter os nomes brutos das claims JWT, e a partir daí o subject chega como `sub` e o enricher acima não registra nada, sem avisar. Leia `User.FindFirstValue("sub") ?? User.FindFirstValue(ClaimTypes.NameIdentifier)` se você não tiver certeza de qual vai receber.

**A autenticação precisa rodar antes da chamada de log, não antes do registro.** O enricher lê `HttpContext.User` de forma preguiçosa, então marca tudo o que for registrado depois que o middleware de autenticação rodou, onde quer que esse middleware esteja. Se você depende do middleware de autenticação automático que o `WebApplication` adiciona quando os serviços de autenticação estão registrados e não chama `UseAuthentication` você mesmo, ele roda cedo no pipeline e você está coberto.

**Blazor interativo e SignalR.** `IHttpContextAccessor` não é uma fonte confiável do usuário atual em componentes interativos do Blazor Server; a documentação do ASP.NET Core recomenda evitá-lo com renderização interativa. Para circuits e invocações de hub, obtenha o usuário de `AuthenticationStateProvider` ou `HubCallerContext.User` e abra um scope ao redor do trabalho.

**Enrichers rodam por registro, então mantenha-os baratos.** Uma busca entre um punhado de claims é trivial, mas não resolva serviços, não consulte um banco de dados nem aloque strings em `Enrich`. Se um valor é constante para o processo (versão, região), use `IStaticLogEnricher`, que roda uma vez só.

**Não coloque o id também nos seus message templates.** `LogInformation("User {UserId} loaded orders", userId)` duplica a propriedade e, se as chaves forem diferentes, divide suas consultas. Mantenha os templates focados no evento; veja [migrar de interpolação de strings para message templates](/pt-br/2026/07/migrate-from-ilogger-string-interpolation-to-message-templates-in-dotnet-11/) para o resto dessa disciplina.

### Leia a seguir

- [Como configurar logging estruturado com Serilog e Seq no .NET 11](/pt-br/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/)
- [Migrar do Serilog para o logging do OpenTelemetry no .NET 11](/pt-br/2026/06/migrate-from-serilog-to-opentelemetry-logging-in-dotnet-11/)
- [Como redigir valores sensíveis nos logs com LogProperties no .NET](/pt-br/2026/08/how-to-redact-sensitive-values-from-logs-with-logproperties-in-dotnet/)
- [Como executar trabalho fire-and-forget com segurança no ASP.NET Core com BackgroundService](/pt-br/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/)

### Fontes

- [Visão geral do enriquecimento de logs](https://learn.microsoft.com/dotnet/core/enrichment/overview) e [Enricher de log personalizado](https://learn.microsoft.com/dotnet/core/enrichment/custom-enricher) no Microsoft Learn
- [`EnrichmentServiceCollectionExtensions.cs`](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Telemetry.Abstractions/Enrichment/EnrichmentServiceCollectionExtensions.cs) em dotnet/extensions (registro como singleton)
- [Logging no .NET: scopes de log](https://learn.microsoft.com/dotnet/core/extensions/logging#log-scopes)
- [Acessar o HttpContext no ASP.NET Core](https://learn.microsoft.com/aspnet/core/fundamentals/http-context) (incluindo as orientações sobre Blazor interativo)
- [README do Serilog.AspNetCore](https://github.com/serilog/serilog-aspnetcore)
- [Logs do OpenTelemetry .NET: IncludeScopes](https://github.com/open-telemetry/opentelemetry-dotnet/tree/main/docs/logs)
