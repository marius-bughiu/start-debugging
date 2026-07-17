---
title: "Correção: System.InvalidOperationException: Headers are read-only, response has already started"
description: "Você definiu um header, um status code ou um content type depois que o corpo já foi liberado. Defina todos os headers antes da primeira escrita, ou proteja com HttpResponse.HasStarted e OnStarting."
pubDate: 2026-07-17
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "aspnetcore-11"
lang: "pt-br"
translationOf: "2026/07/fix-headers-are-read-only-response-has-already-started-in-aspnetcore"
translatedBy: "claude"
translationDate: 2026-07-17
---

A correção: algo já escreveu no corpo da resposta, o que liberou os headers para o cliente e os tornou somente leitura, e então seu código tentou definir um header, um status code ou um content type. No ASP.NET Core, `HttpResponse.StatusCode`, `HttpResponse.ContentType` e tudo o que está em `HttpResponse.Headers` devem ser definidos **antes** de o primeiro byte do corpo ser escrito. Mova todas as atribuições de headers e de status para antes de qualquer `WriteAsync`, `Redirect` ou middleware descendente que escreva o corpo. Quando você não puder controlar a ordem, proteja a atribuição com `if (!context.Response.HasStarted)` ou registre o trabalho em `HttpResponse.OnStarting` para que ele rode no instante antes de os headers serem liberados. Este guia foi escrito para o ASP.NET Core 11 (`Microsoft.AspNetCore.App` 11.0.0-preview.4), C# 14 e Kestrel 11.0.0-preview.4; o comportamento é idêntico até o ASP.NET Core 3.0.

```text
System.InvalidOperationException: Headers are read-only, response has already started.
   at Microsoft.AspNetCore.Server.Kestrel.Core.Internal.Http.HttpResponseHeaders.ThrowHeadersReadOnlyException()
   at Microsoft.AspNetCore.Server.Kestrel.Core.Internal.Http.HttpHeaders.Microsoft.AspNetCore.Http.IHeaderDictionary.set_Item(String key, StringValues value)
   at MyApp.SecurityHeadersMiddleware.InvokeAsync(HttpContext context)
   at Microsoft.AspNetCore.Server.Kestrel.Core.Internal.Http.HttpProtocol.ProcessRequests[TContext](IHttpApplication`1 application)
```

O stack trace quase sempre termina em `ThrowHeadersReadOnlyException` dentro do Kestrel (ou o equivalente no HTTP.sys e no IIS). O frame diretamente acima dele é a linha que tentou a mutação. Esse frame é o seu culpado: ele está definindo um header, `StatusCode`, `ContentType` ou chamando `Redirect` depois que a resposta já começou.

## Por que definir um header depois da primeira escrita é impossível

O HTTP é ordenado no fio: linha de status, depois headers, depois uma linha em branco e depois o corpo. Assim que o servidor enviou o bloco de headers ao cliente, ele não pode desenviá-lo. O ASP.NET Core modela isso tornando a coleção de headers somente leitura no momento em que a resposta começa, e lança em vez de descartar silenciosamente sua alteração, porque um header de segurança ou um content type ignorado em silêncio é um bug muito pior do que uma exceção barulhenta.

Duas coisas iniciam a resposta. A documentação diz sem rodeios: "An app can't modify headers after the response has started. Once the response starts, the headers are sent to the client. A response is started by flushing the response body or calling `HttpResponse.StartAsync(CancellationToken)`." A primeira delas é a que morde as pessoas, porque é implícita. Escrever o corpo o libera: "Unless response buffering is enabled, all write operations (for example, `WriteAsync`) flush the response body internally and mark the response as started. Response buffering is disabled by default." Então o primeiro `WriteAsync`, o primeiro `CopyToAsync` em `Response.Body`, o primeiro `FlushAsync` em `Response.BodyWriter` e retornar um resultado que transmite conteúdo mudam `HttpResponse.HasStarted` para `true` e congelam os headers.

É por isso que `HttpResponse.StatusCode`, `HttpResponse.ContentType` e `HttpResponse.Headers` são cada um documentados como "Must be set before writing to the response body." Não são notas de aviso. São o contrato, e a exceção é a aplicação dele.

## Um repro mínimo

A menor versão escreve o corpo e depois tenta definir um header:

```csharp
// ASP.NET Core 11, C# 14
using Microsoft.AspNetCore.Builder;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapGet("/broken", async (HttpContext context) =>
{
    await context.Response.WriteAsync("Processing...");   // flushes: HasStarted is now true
    context.Response.Headers["X-Trace-Id"] = "abc123";     // throws: headers are read-only
});

app.Run();
```

A chamada `WriteAsync` libera o corpo e envia os headers. A próxima linha tenta adicionar `X-Trace-Id`, e o Kestrel lança `InvalidOperationException: Headers are read-only, response has already started`. A mesma forma aparece com um status code:

```csharp
// ASP.NET Core 11, C# 14
app.MapGet("/broken-status", async (HttpContext context) =>
{
    await context.Response.WriteAsync("partial output");
    context.Response.StatusCode = 500;   // throws for the same reason
});
```

E aparece com um redirect, porque `Redirect` define tanto o header `Location` quanto um status 302:

```csharp
// ASP.NET Core 11, C# 14
app.MapGet("/broken-redirect", async (HttpContext context) =>
{
    await context.Response.WriteAsync("about to redirect");
    context.Response.Redirect("/login");   // throws: Location header is read-only
});
```

## Reordene para que os headers venham primeiro

A correção principal, e a que você deve buscar sempre que o código estiver sob seu controle, é definir cada header, o status code e o content type antes de escrever qualquer coisa no corpo. Em um endpoint ou controller isso costuma ser um movimento de uma linha:

```csharp
// ASP.NET Core 11, C# 14 -- correct order
app.MapGet("/fixed", async (HttpContext context) =>
{
    context.Response.StatusCode = 200;
    context.Response.ContentType = "text/plain";
    context.Response.Headers["X-Trace-Id"] = "abc123";   // set before any write

    await context.Response.WriteAsync("Processing...");  // now safe to flush
});
```

Prefira retornar um `IResult` (minimal APIs) ou um `IActionResult` (MVC) em vez de escrever em `Response.Body` na mão. `Results.Text`, `Results.Json`, `Results.File` e `TypedResults` constroem a resposta inteira, headers incluídos, e só então escrevem, então nunca tropeçam nesse erro. Recorrer a [uma união Results tipada de um endpoint de minimal API](/pt-br/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/) mantém o status e os headers declarativos e remove por completo o risco da ordenação manual.

## Proteja o middleware com HasStarted

O caso mais difícil é o middleware que roda `await next(context)` e depois quer tocar a resposta. Quando `next` retorna, um endpoint descendente normalmente já escreveu o corpo, então a resposta começou e qualquer alteração de header lança. Esta é a fonte mais comum desse erro, e o clássico infrator é um middleware de "security headers" ou de "correlation id" escrito assim:

```csharp
// ASP.NET Core 11, C# 14 -- broken middleware
app.Use(async (context, next) =>
{
    await next(context);   // endpoint writes the body here; response starts
    context.Response.Headers["X-Frame-Options"] = "DENY";   // throws
});
```

Há dois padrões corretos, e a escolha depende de você precisar ou não definir o header incondicionalmente.

**Registre o trabalho em `OnStarting`.** `HttpResponse.OnStarting` recebe um callback que o servidor roda exatamente uma vez, logo antes de liberar os headers, seja o corpo escrito pelo seu middleware ou por qualquer coisa descendente. Registre-o antes de chamar `next`, e o header é escrito no último momento seguro:

```csharp
// ASP.NET Core 11, C# 14 -- correct: set headers just before they flush
app.Use(async (context, next) =>
{
    context.Response.OnStarting(() =>
    {
        context.Response.Headers["X-Frame-Options"] = "DENY";
        context.Response.Headers["X-Content-Type-Options"] = "nosniff";
        return Task.CompletedTask;
    });

    await next(context);
});
```

Esta é a ferramenta certa para headers de resposta transversais, porque funciona mesmo quando o código descendente começa a transmitir de imediato. É o mesmo mecanismo que o próprio middleware de headers do ASP.NET Core usa internamente.

**Proteja com `HasStarted`.** Quando o header só importa se a resposta ainda não se comprometeu (por exemplo, um manipulador de exceções que quer transformar uma falha em um 500), verifique primeiro `HttpResponse.HasStarted` e pule a mutação quando for `true`:

```csharp
// ASP.NET Core 11, C# 14 -- defensive guard
app.Use(async (context, next) =>
{
    try
    {
        await next(context);
    }
    catch (Exception)
    {
        if (!context.Response.HasStarted)
        {
            context.Response.Clear();
            context.Response.StatusCode = 500;
            await context.Response.WriteAsync("Something went wrong.");
        }
        throw;   // nothing safe to do if the response already started
    }
});
```

`HttpResponse.Clear()` reinicia o status code, os headers e qualquer corpo em buffer, mas só funciona enquanto `HasStarted` for `false`. Assim que o corpo começou a transmitir, realmente não há nada que você possa fazer para mudar o status ou os headers, e o movimento honesto é deixar a exceção se propagar ou chamar `HttpContext.Abort()` para cortar a conexão, de modo que o cliente veja uma resposta quebrada em vez de uma mentira. É por isso que o manipulador de exceções embutido e [um filtro de exceções global no ASP.NET Core 11](/pt-br/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) verificam ambos `HasStarted` antes de escrever um corpo problem-details e relançam quando já é tarde demais.

## Faça buffer do corpo quando o middleware precisar reescrevê-lo

Alguns middlewares realmente precisam ler ou transformar a resposta descendente, minificar HTML, injetar uma tag de script ou comprimir conteúdo, e só então definir um header `Content-Length` ou `Content-Encoding`. Você não pode fazer isso se o corpo já foi liberado para o cliente. A correção é trocar o corpo da resposta por um buffer, deixar o descendente escrever no buffer, depois definir seus headers e copiar o buffer para o corpo real:

```csharp
// ASP.NET Core 11, C# 14 -- buffer downstream output, then set headers
app.Use(async (context, next) =>
{
    var originalBody = context.Response.Body;
    using var buffer = new MemoryStream();
    context.Response.Body = buffer;

    await next(context);   // downstream writes into the MemoryStream, not the socket

    // Response has NOT started: the real body was never touched.
    context.Response.Headers["Content-Length"] = buffer.Length.ToString();
    buffer.Position = 0;
    context.Response.Body = originalBody;
    await buffer.CopyToAsync(originalBody);
});
```

Como a escrita descendente foi para um `MemoryStream` e não para a conexão, `HasStarted` permanece `false` e as atribuições de headers têm sucesso. Esta é a versão manual do que o middleware que transforma respostas faz; a rota suportada pelo framework é trabalhar por meio de `IHttpResponseBodyFeature` em vez de atribuir `Response.Body` diretamente, mas o princípio do buffer é o mesmo. Se o seu objetivo é especificamente a compressão, não faça isso na mão: recorra a [compressão de respostas em uma API ASP.NET Core 11](/pt-br/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/), que cuida da negociação e do header `Content-Encoding` para você sem fazer buffer da resposta inteira na memória.

## Pegadinhas e falsos parecidos

**`Response.Redirect` conta como uma escrita de header.** Um redirect define o header `Location` e um status 3xx, então chamá-lo depois de qualquer escrita do corpo lança exatamente esta exceção. Se você se pegar redirecionando de dentro de uma action que já escreveu saída, o bug real é que a decisão de redirecionar foi tomada tarde demais; mova-a para antes da primeira escrita.

**Endpoints de streaming têm uma janela de headers minúscula.** Quando você [transmite um arquivo de um endpoint sem buffer](/2026/07/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/), a resposta começa no momento em que o primeiro chunk é liberado. Qualquer `Content-Disposition` ou `Content-Type` que você queira deve ser definido antes daquele primeiro `WriteAsync`. Se um erro ocorrer no meio do stream você não pode mudar para um 500, porque o bloco de header 200 já está no fio; a conexão simplesmente termina. Projete os manipuladores de streaming para validar tudo e definir todos os headers de antemão.

**Este não é o erro de I/O síncrona.** `Headers are read-only, response has already started` é sobre *ordem*, não sobre síncrono versus assíncrono. Se a sua mensagem em vez disso diz `Synchronous operations are disallowed`, esse é um problema diferente com uma correção diferente, coberto em [InvalidOperationException: Synchronous operations are disallowed](/pt-br/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed). Não confunda os dois; trocar `WriteAsync` por `Write` não vai ajudar aqui e reordenar não vai ajudar lá.

**Blazor e Identity o expõem indiretamente.** Componentes interativos do Blazor e fluxos do ASP.NET Core Identity às vezes disparam isto a partir de código do framework, tipicamente quando um componente tenta definir um cookie ou redirecionar depois que o render começou, ou quando uma incompatibilidade de render mode força a saída antes de a autenticação rodar. Se o stack trace aponta para o render do Blazor em vez do seu próprio middleware, procure um `NavigationManager.NavigateTo` ou uma escrita de cookie acontecendo depois do primeiro render, e veja [a render mode is not supported by the parent component's render mode](/pt-br/2026/06/fix-render-mode-is-not-supported-by-the-parent-components-render-mode-blazor) para o problema adjacente de render mode.

**A ordem do middleware decide quem vence.** Um middleware que define headers só funciona se registrar seu callback de `OnStarting`, ou definir seus headers, antes de o middleware terminal escrever o corpo. Se o seu middleware de headers personalizado fica *depois* de `UseStaticFiles` ou do middleware de endpoints no pipeline para as rotas que o alcançam, já é tarde demais. Registre o middleware de resposta transversal cedo no `Program.cs`.

**Escritas duplas em caminhos de exceção.** Um gatilho frequente em produção é código que escreve uma resposta de sucesso parcial, depois atinge uma exceção e um manipulador externo tenta sobrescrevê-la com um erro. A primeira escrita já iniciou a resposta. Valide e reúna tudo o que pode falhar antes de escrever o primeiro byte, para que a escrita seja a última coisa que o manipulador faz, não a primeira.

## Relacionados

- [Como adicionar um filtro de exceções global no ASP.NET Core 11](/pt-br/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) mostra a proteção com `HasStarted` em um manipulador de exceções real.
- [Como transmitir um arquivo de um endpoint do ASP.NET Core sem buffer](/2026/07/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) explica exatamente quando uma resposta transmitida compromete seus headers.
- [Como adicionar compressão de respostas a uma API ASP.NET Core 11](/pt-br/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/) é a forma suportada de transformar o corpo sem buffer manual.
- [Como retornar uma união Results tipada de um endpoint de minimal API](/pt-br/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/) mantém o status e os headers declarativos para que a ordem não possa dar errado.
- [Correção: InvalidOperationException: Synchronous operations are disallowed](/pt-br/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed) é a outra InvalidOperationException que parece similar mas não é.

## Fontes

- [Use HttpContext in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/use-http-context?view=aspnetcore-10.0), Microsoft Learn, para a regra de que headers, `StatusCode` e `ContentType` devem ser definidos antes de escrever, o texto exato da exceção e a nota de que `WriteAsync` libera e inicia a resposta porque o buffer está desativado por padrão.
- [HttpResponse.HasStarted](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.httpresponse.hasstarted), documentação da API do .NET, sobre detectar se a resposta se comprometeu.
- [HttpResponse.OnStarting](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.httpresponse.onstarting), documentação da API do .NET, para registrar trabalho que roda logo antes de os headers serem liberados.
- [Write custom ASP.NET Core middleware](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/middleware/write?view=aspnetcore-10.0), Microsoft Learn, sobre a ordem do pipeline que determina quem escreve o corpo primeiro.
