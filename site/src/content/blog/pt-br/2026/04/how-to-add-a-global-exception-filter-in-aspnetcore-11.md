---
title: "Como adicionar um filtro global de exceções no ASP.NET Core 11"
description: "Guia completo de tratamento global de exceções no ASP.NET Core 11: por que IExceptionFilter é a ferramenta errada, como IExceptionHandler e UseExceptionHandler funcionam juntos, respostas com ProblemDetails, cadeias de múltiplos handlers e a mudança de comportamento do .NET 10 sobre supressão de diagnósticos."
pubDate: 2026-04-26
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "error-handling"
lang: "pt-br"
translationOf: "2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-04-26
---

Para capturar toda exceção não tratada em uma aplicação ASP.NET Core 11 e transformá-la em uma resposta HTTP limpa, implemente `IExceptionHandler`, registre-o com `services.AddExceptionHandler<T>()` e coloque `app.UseExceptionHandler()` no início do pipeline de middleware. O antigo `IExceptionFilter` do MVC dispara apenas para ações de controllers, então ele perde endpoints de minimal API, exceções de middleware, falhas de model binding e qualquer coisa lançada antes do MVC executar. A abordagem baseada em handler substitui isso em todo o pipeline, integra-se com `ProblemDetails` para respostas RFC 7807 e funciona da mesma forma em Native AOT, minimal APIs e controllers. Tudo neste guia tem como alvo .NET 11 (preview 3) com `Microsoft.NET.Sdk.Web` e C# 14, mas a API está estável desde .NET 8 e os padrões se aplicam sem alteração no .NET 9 e .NET 10.

## "Filtro de exceções" é o termo de busca, mas você quase nunca quer um

Quando quem desenvolve pergunta como adicionar um "filtro global de exceções", o resultado mais bem ranqueado pelos buscadores costuma ser uma resposta de Stack Overflow de 2017 que aponta para `IExceptionFilter` e `MvcOptions.Filters.Add<T>`. Esse código ainda compila e ainda executa, mas ele não é a resposta correta desde o ASP.NET Core 8.

`IExceptionFilter` vive em `Microsoft.AspNetCore.Mvc.Filters`. Faz parte do pipeline do MVC, o que significa três coisas:

1. Ele só captura exceções lançadas dentro de uma ação MVC, um filtro MVC ou um result executor. Qualquer coisa lançada antes no pipeline (erros de model binding, falhas de autenticação, 404 de roteamento) nunca chega até ele.
2. Não enxerga exceções de endpoints de minimal API (`app.MapGet("/", ...)`). Minimal APIs não passam pelo `MvcRoutedActionInvoker`, então filtros MVC ficam silenciosos para elas.
3. Roda depois que o model binding já produziu um erro em `ModelState`, então um corpo de requisição malformado retorna 400 do framework antes do seu filtro sequer ver a exceção que você queria traduzir.

O equivalente moderno é `IExceptionHandler`, introduzido em `Microsoft.AspNetCore.Diagnostics` 8.0 e inalterado no .NET 11. Ele roda de dentro do middleware `UseExceptionHandler`, que fica no topo do pipeline, então um único handler cobre controllers, minimal APIs, gRPC, negociação de SignalR, arquivos estáticos e exceções lançadas pelo middleware em um só lugar. É isso que se quer dizer com "global".

O resto deste guia é o caminho do `IExceptionHandler`. A última seção cobre os poucos casos em que um filtro MVC ainda é a ferramenta correta.

## O IExceptionHandler mínimo

`IExceptionHandler` é uma interface de método único:

```csharp
// .NET 11, C# 14
namespace Microsoft.AspNetCore.Diagnostics;

public interface IExceptionHandler
{
    ValueTask<bool> TryHandleAsync(
        HttpContext httpContext,
        Exception exception,
        CancellationToken cancellationToken);
}
```

Retorne `true` se você escreveu a resposta e quer que o middleware pare. Retorne `false` para passar para o próximo handler na cadeia (ou, se nenhum tratar, para a resposta de erro padrão do framework).

Um handler funcional do tipo "traduza toda exceção em um 500 com corpo JSON" tem cerca de 30 linhas:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

internal sealed class GlobalExceptionHandler(
    ILogger<GlobalExceptionHandler> logger,
    IProblemDetailsService problemDetailsService) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(
        HttpContext httpContext,
        Exception exception,
        CancellationToken cancellationToken)
    {
        logger.LogError(exception, "Unhandled exception on {Path}", httpContext.Request.Path);

        httpContext.Response.StatusCode = StatusCodes.Status500InternalServerError;

        return await problemDetailsService.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = httpContext,
            Exception = exception,
            ProblemDetails = new ProblemDetails
            {
                Type = "https://tools.ietf.org/html/rfc9110#section-15.6.1",
                Title = "An unexpected error occurred",
                Status = StatusCodes.Status500InternalServerError,
            },
        });
    }
}
```

Dois detalhes importam aqui. Primeiro, o handler é `sealed` e usa injeção via construtor primário, que é o idiom de C# 12+. Segundo, delegamos o corpo real da resposta para `IProblemDetailsService` em vez de chamar `httpContext.Response.WriteAsJsonAsync(...)` nós mesmos. Essa única mudança é o que faz a resposta respeitar o cabeçalho `Accept` do cliente, o conjunto de `IProblemDetailsWriter` registrados e qualquer callback `CustomizeProblemDetails` que você tenha configurado. Voltamos a isso na seção sobre ProblemDetails.

## Conectando o handler no Program.cs

Três linhas adicionam o handler. A ordem do middleware importa:

```csharp
// .NET 11, C# 14, Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddProblemDetails();
builder.Services.AddExceptionHandler<GlobalExceptionHandler>();

var app = builder.Build();

app.UseExceptionHandler();   // must come before UseAuthorization, MapControllers, etc.
app.UseStatusCodePages();    // optional, formats 4xx the same way

app.MapControllers();
app.Run();
```

`AddExceptionHandler<T>` registra o handler como singleton, e isso é imposto pelo framework. Se seu handler precisa de serviços scoped (um `DbContext`, um logger com escopo de requisição), injete `IServiceProvider` e crie um escopo por chamada em vez de pegar o serviço scoped no construtor:

```csharp
// .NET 11, C# 14
internal sealed class DbBackedExceptionHandler(IServiceScopeFactory scopes) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(
        HttpContext ctx, Exception ex, CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AuditDbContext>();
        db.Failures.Add(new FailureRecord(ctx.TraceIdentifier, ex.GetType().FullName!));
        await db.SaveChangesAsync(ct);
        return false; // let another handler write the response
    }
}
```

`UseExceptionHandler()` sem argumentos usa a cadeia de `IExceptionHandler` registrados. A sobrecarga que aceita uma `string` com caminho ou um `Action<IApplicationBuilder>` é o modelo antigo somente de middleware e ignora a cadeia de handlers. Escolha um ou outro, não os dois.

## ProblemDetails de graça, quando você o conecta

`AddProblemDetails()` registra o `IProblemDetailsService` padrão e um `IProblemDetailsWriter` para `application/problem+json`. Uma vez registrado, três coisas acontecem automaticamente:

1. `UseExceptionHandler()` escreve um corpo `ProblemDetails` para exceções não tratadas quando nenhum `IExceptionHandler` reivindica a resposta.
2. `UseStatusCodePages()` escreve um corpo `ProblemDetails` para respostas 4xx sem corpo.
3. Seu próprio handler pode chamar `problemDetailsService.TryWriteAsync(...)` para obter a mesma negociação de conteúdo e personalização de graça.

O ponto de personalização mais útil é `CustomizeProblemDetails`, que executa depois que seu handler constrói o objeto e antes que ele seja escrito. Um site típico adiciona o trace identifier para que o suporte possa correlacionar um erro visível ao usuário com uma entrada de log:

```csharp
// .NET 11, C# 14
builder.Services.AddProblemDetails(options =>
{
    options.CustomizeProblemDetails = ctx =>
    {
        ctx.ProblemDetails.Extensions["traceId"] = ctx.HttpContext.TraceIdentifier;
        ctx.ProblemDetails.Extensions["requestId"] =
            Activity.Current?.Id ?? ctx.HttpContext.TraceIdentifier;
    };
});
```

Não coloque mensagens de exceção nem stack trace na resposta em produção. Eles vazam estrutura interna (nomes de tabelas, caminhos de arquivos, URLs de APIs de terceiros) que um atacante pode encadear em uma sondagem mais direcionada. Condicione qualquer eco de `ex.Message` a `IHostEnvironment.IsDevelopment()`.

## Múltiplos handlers, ordenados por tipo de exceção

O middleware de exceções itera os handlers registrados na ordem de registro até que um retorne `true`. Esse é o lugar certo para colocar tradução por tipo de exceção:

```csharp
// .NET 11, C# 14
internal sealed class ValidationExceptionHandler(IProblemDetailsService pds) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(
        HttpContext ctx, Exception ex, CancellationToken ct)
    {
        if (ex is not FluentValidation.ValidationException ve) return false;

        ctx.Response.StatusCode = StatusCodes.Status400BadRequest;

        var errors = ve.Errors
            .GroupBy(e => e.PropertyName)
            .ToDictionary(g => g.Key, g => g.Select(e => e.ErrorMessage).ToArray());

        return await pds.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = ctx,
            Exception = ex,
            ProblemDetails = new HttpValidationProblemDetails(errors)
            {
                Type = "https://tools.ietf.org/html/rfc9110#section-15.5.1",
                Title = "One or more validation errors occurred",
                Status = StatusCodes.Status400BadRequest,
            },
        });
    }
}

internal sealed class NotFoundExceptionHandler(IProblemDetailsService pds) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(
        HttpContext ctx, Exception ex, CancellationToken ct)
    {
        if (ex is not EntityNotFoundException) return false;

        ctx.Response.StatusCode = StatusCodes.Status404NotFound;
        return await pds.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = ctx,
            Exception = ex,
            ProblemDetails = new ProblemDetails
            {
                Type = "https://tools.ietf.org/html/rfc9110#section-15.5.5",
                Title = "Resource not found",
                Status = StatusCodes.Status404NotFound,
            },
        });
    }
}
```

Registre-os em ordem de prioridade. O handler 500 que captura tudo vai por último:

```csharp
// .NET 11, C# 14
builder.Services.AddExceptionHandler<ValidationExceptionHandler>();
builder.Services.AddExceptionHandler<NotFoundExceptionHandler>();
builder.Services.AddExceptionHandler<GlobalExceptionHandler>();
```

O middleware itera os singletons exatamente nessa ordem. Se `ValidationExceptionHandler` retorna `false`, o próximo handler é consultado. Se `GlobalExceptionHandler` retorna `true`, nenhum handler subsequente roda.

Resista à tentação de escrever um mega-handler com um `switch` gigante. Handlers por tipo de exceção são mais fáceis de testar (cada um é uma classe pequena que recebe um fake), mais fáceis de deletar quando um tipo de exceção desaparece e mais fáceis de conectar condicionalmente (por exemplo, registrar `ValidationExceptionHandler` somente quando FluentValidation está no projeto).

## Ordem de middleware que quebra o handler

O erro mais comum é colocar `UseExceptionHandler()` no lugar errado. A regra é: ele precisa vir antes de qualquer middleware que possa lançar uma exceção que você queira capturar. Na prática isso significa que ele deve ser o primeiro middleware não relacionado ao ambiente.

```csharp
// Wrong: a NullReferenceException from authentication never reaches the handler.
app.UseAuthentication();
app.UseAuthorization();
app.UseExceptionHandler();   // too late
app.MapControllers();

// Right: the handler wraps everything that follows.
app.UseExceptionHandler();
app.UseAuthentication();
app.UseAuthorization();
app.MapControllers();
```

A única coisa que legitimamente roda antes de `UseExceptionHandler` é a página de exceções de desenvolvedor em ambientes não produtivos:

```csharp
// .NET 11, C# 14
if (app.Environment.IsDevelopment())
{
    app.UseDeveloperExceptionPage();
}
else
{
    app.UseExceptionHandler();
    app.UseHsts();
}
```

Se você registra os dois, a página de desenvolvedor vence em dev porque ela curto-circuita a requisição antes do middleware do handler executar. Geralmente é o que se quer: a página de dev mostra o stack trace e o trecho de código-fonte, que é a razão inteira de rodar localmente.

## A mudança disruptiva de supressão de diagnósticos no .NET 10

No .NET 8 e 9, `UseExceptionHandler` sempre logava a exceção não tratada em nível `Error` e emitia a atividade `Microsoft.AspNetCore.Diagnostics.HandlerException`, independentemente de seu `IExceptionHandler` retornar `true`. Isso facilitava o log duplicado: seu handler logava, e o framework também.

A partir do .NET 10 (e preservado no .NET 11), o framework suprime seus próprios diagnósticos para qualquer exceção que um handler tenha reivindicado retornando `true`. Seu handler agora é o único responsável pelo log nesse caso. Exceções que passam sem tratamento ainda emitem o log do framework.

Essa é uma mudança de comportamento que pode ser percebida em silêncio. Se você tem um alerta no Grafana sobre `aspnetcore.diagnostics.handler.unhandled_exceptions` e atualiza para .NET 10 ou posterior, a métrica cai a zero para exceções tratadas e seu dashboard fica plano. A correção é:

```csharp
// Opt back in to the .NET 8/9 behaviour.
app.UseExceptionHandler(new ExceptionHandlerOptions
{
    SuppressDiagnosticsCallback = _ => false,
});
```

Ou, de preferência, deletar o dashboard e confiar no log que seu handler faz. A contagem dupla sempre foi um bug.

O callback recebe um `ExceptionHandlerDiagnosticsContext` com a exceção, a requisição e uma flag indicando se um handler reivindicou a resposta, então você pode suprimir seletivamente, por exemplo, não logar `OperationCanceledException` de uma requisição que o cliente abortou:

```csharp
// .NET 11, C# 14
app.UseExceptionHandler(new ExceptionHandlerOptions
{
    SuppressDiagnosticsCallback = ctx =>
        ctx.Exception is OperationCanceledException &&
        ctx.HttpContext.RequestAborted.IsCancellationRequested,
});
```

Veja a [nota de mudança disruptiva no Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/compatibility/aspnet-core/10/exception-handler-diagnostics-suppressed) para a semântica exata.

## Quando IExceptionFilter ainda é a ferramenta certa

Há dois casos estreitos em que o `IExceptionFilter` do MVC ainda está correto:

1. Você quer traduzir uma exceção apenas para um controller ou ação específica, e quer o filtro descobrível nos atributos da ação. `[TypeFilter(typeof(MyExceptionFilter))]` na classe do controller delimita o comportamento sem poluir o pipeline global. Isso é mais um filtro de ação para um endpoint específico do que algo realmente "global".
2. Você precisa acessar o `ActionContext` do MVC (por exemplo, o `IModelMetadataProvider` para os parâmetros da ação). `IExceptionHandler` só vê `HttpContext`, então esses metadados não estão disponíveis lá.

Fora isso, `IExceptionHandler` vence. Funciona para minimal APIs, roda antes do MVC e compõe limpo com múltiplos handlers registrados. Trate o filtro MVC como uma ferramenta com escopo de ação, não como uma global.

## Um erro comum: lançar dentro de um IProblemDetailsWriter customizado

Se você implementa um `IProblemDetailsWriter` customizado (por exemplo, para emitir um envelope de erro específico do fornecedor), não lance de dentro do `WriteAsync`. O middleware de exceções captura essa exceção também, recurse de volta pela mesma cadeia de handlers e você obtém ou um stack overflow ou, com sorte, um 500 vazio sem corpo. Envolva a lógica de escrita do corpo em um try/catch e retorne `false` em `CanWrite` se o writer estiver em estado ruim. A mesma regra vale para o código do handler: não lance de dentro de `TryHandleAsync`. Retorne `false` em vez disso.

Um formato seguro:

```csharp
// .NET 11, C# 14
public async ValueTask<bool> TryHandleAsync(
    HttpContext ctx, Exception ex, CancellationToken ct)
{
    try
    {
        ctx.Response.StatusCode = MapStatus(ex);
        await pds.TryWriteAsync(BuildContext(ctx, ex));
        return true;
    }
    catch
    {
        return false; // let the framework default kick in
    }
}
```

## Relacionados

- [JsonConverter customizado em System.Text.Json](/pt-br/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) para serializar o dicionário `ProblemDetails.Extensions` da forma que seus clientes esperam.
- [Transmitir um arquivo de um endpoint do ASP.NET Core sem buffering](/pt-br/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) cobre outra sutileza de ordem de middleware no mesmo pipeline.
- [Cancelar uma Task de longa duração sem deadlock](/pt-br/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) para os padrões de `OperationCanceledException` em que o callback de diagnósticos acima se baseia.
- [Gerar clientes fortemente tipados a partir de uma especificação OpenAPI no .NET 11](/pt-br/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/) se você publica o esquema `ProblemDetails` para consumidores.

## Fontes

- Microsoft Learn, [Tratar erros no ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/error-handling?view=aspnetcore-10.0).
- Microsoft Learn, [Tratar erros em APIs do ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/error-handling-api?view=aspnetcore-10.0).
- Mudança disruptiva no Microsoft Learn, [Diagnósticos de exceções são suprimidos quando IExceptionHandler.TryHandleAsync retorna true](https://learn.microsoft.com/en-us/dotnet/core/compatibility/aspnet-core/10/exception-handler-diagnostics-suppressed).
- Notas de versão do ASP.NET Core, [.NET 10 preview 7 ASP.NET Core](https://github.com/dotnet/core/blob/main/release-notes/10.0/preview/preview7/aspnetcore.md).
- Discussão no GitHub, [IExceptionHandler no .NET 8 para tratamento global de exceções](https://github.com/dotnet/aspnetcore/discussions/54613).
