---
title: "Correção: InvalidOperationException: Synchronous operations are disallowed"
description: "Substitua a chamada Stream.Read ou Write por ReadAsync/WriteAsync. Como último recurso, defina AllowSynchronousIO no Kestrel, IIS ou por requisição via IHttpBodyControlFeature."
pubDate: 2026-05-12
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "aspnetcore-11"
  - "kestrel"
lang: "pt-br"
translationOf: "2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed"
translatedBy: "claude"
translationDate: 2026-05-12
---

A correção: ASP.NET Core 3.0 e versões posteriores desabilitam por padrão leituras e gravações síncronas em `HttpRequest.Body` e `HttpResponse.Body`, então qualquer código que chame `Stream.Read`, `Stream.Write`, `Stream.Flush`, `StreamReader.ReadToEnd`, `StreamWriter.Write` ou `JsonSerializer.Deserialize(stream)` lançará `InvalidOperationException: Synchronous operations are disallowed`. A correção limpa é mudar a chamada para o equivalente assíncrono (`ReadAsync`, `WriteAsync`, `DeserializeAsync`) e aguardar com `await`. Se você não consegue alterar quem chama, habilite `AllowSynchronousIO = true` no Kestrel ou IIS, ou alterne `IHttpBodyControlFeature.AllowSynchronousIO` apenas na requisição problemática.

```text
System.InvalidOperationException: Synchronous operations are disallowed. Call ReadAsync or set AllowSynchronousIO to true instead.
   at Microsoft.AspNetCore.Server.Kestrel.Core.Internal.Http.HttpRequestStream.Read(Byte[] buffer, Int32 offset, Int32 count)
   at System.IO.Stream.CopyTo(Stream destination, Int32 bufferSize)
   at Newtonsoft.Json.JsonSerializer.DeserializeInternal(JsonReader reader, Type objectType)
   at MyApp.LegacyHandler.Parse(HttpRequest request)
```

Este guia é escrito contra ASP.NET Core 11 (`Microsoft.AspNetCore.App` 11.0.0-preview.4) e Kestrel 11.0.0-preview.4. A verificação existe desde 3.0.0-preview3 (fevereiro de 2019) e se aplica ao Kestrel, HTTP.sys, IIS in-process e `TestServer`. O texto da exceção é idêntico entre versões; só mudaram os servidores padrão e as APIs de conveniência ao redor.

## Por que o servidor bloqueia E/S síncrona por padrão

Cada thread bloqueada dentro de um handler de requisição é uma thread indisponível para o resto da aplicação. Uma `Stream.Read` síncrona sobre uma conexão de cliente lenta pode prender uma thread do thread pool por vários segundos. Sob carga, o pool fica sem threads, a latência das requisições dispara, e o processo acaba parecendo travado mesmo com a CPU ociosa. Esse padrão, a inanição do thread pool, foi responsável por uma cauda longa de incidentes em produção no ASP.NET Core 1.x e 2.x onde aplicações congelavam sob tráfego irregular.

A versão 3.0 mudou `AllowSynchronousIO` de `true` para `false` em todos os servidores embutidos. O runtime agora rejeita ativamente chamadas síncronas em vez de deixá-las bloquear silenciosamente. A exceção não é um bug, é o servidor dizendo a você que a chamada teria bloqueado uma thread durante toda a duração da leitura ou gravação de rede. Uma vez entendido isso, a "correção" deixa de ser "desligar a verificação" e passa a ser "pare de bloquear a thread".

O anúncio do time de runtime em [aspnetcore#7644](https://github.com/dotnet/aspnetcore/issues/7644) lista os servidores afetados e o escape recomendado via `IHttpBodyControlFeature`.

## Uma reprodução mínima

```csharp
// ASP.NET Core 11, C# 14, Newtonsoft.Json 13.0.4
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapPost("/legacy", (HttpRequest request) =>
{
    using var reader = new StreamReader(request.Body);
    var json = reader.ReadToEnd();                      // throws
    return Results.Ok(json.Length);
});

app.Run();
```

`StreamReader.ReadToEnd` chama `Stream.Read` internamente. O `HttpRequestStream` do Kestrel sobrescreve `Read` para lançar imediatamente quando `AllowSynchronousIO` é `false`. O mesmo formato de erro aparece com qualquer um destes chamadores:

- `JsonSerializer.Deserialize<T>(request.Body)` do `System.Text.Json`.
- `JsonSerializer.Create().Deserialize(...)` do `Newtonsoft.Json` ao receber `request.Body`.
- `request.Body.CopyTo(target)` para encaminhar um corpo de requisição.
- `response.Body.Write(buffer, 0, count)` de um middleware personalizado.
- `XmlSerializer.Deserialize(request.Body)`.
- Qualquer biblioteca de terceiros que chame internamente `Stream.Read` ou `Stream.Write` no stream de request/response.

O stack trace é seu melhor amigo aqui: leia de baixo para cima para achar a API síncrona que caiu no stream do servidor.

## Correção 1: trocar para a API assíncrona (recomendada)

Essa é a única correção que de fato resolve o problema subjacente. Quase toda API comum tem uma irmã assíncrona.

```csharp
// ASP.NET Core 11, C# 14
app.MapPost("/legacy", async (HttpRequest request) =>
{
    using var reader = new StreamReader(request.Body);
    var json = await reader.ReadToEndAsync();
    return Results.Ok(json.Length);
});
```

Para JSON, prefira o deserializador em streaming do `System.Text.Json`, que nunca materializa o payload completo como string:

```csharp
// ASP.NET Core 11, System.Text.Json 11.0.0-preview.4
using System.Text.Json;

app.MapPost("/orders", async (HttpRequest request) =>
{
    var order = await JsonSerializer.DeserializeAsync<Order>(
        request.Body,
        cancellationToken: request.HttpContext.RequestAborted);
    return Results.Ok(order);
});

record Order(string Sku, int Quantity);
```

Se você está lendo um modelo em uma minimal API, a correção mais simples é deixar o framework fazer o binding. Parâmetros `[FromBody]` em minimal APIs e MVC deserializam de forma assíncrona, então a verificação de E/S síncrona nunca dispara.

```csharp
app.MapPost("/orders", (Order order) => Results.Ok(order));
```

Para Newtonsoft.Json, o destino de migração é `System.Text.Json` e seu deserializador assíncrono. Se você não pode migrar, leia o corpo para um `MemoryStream` de forma assíncrona primeiro, depois entregue esse buffer ao Newtonsoft:

```csharp
// ASP.NET Core 11, Newtonsoft.Json 13.0.4
using Newtonsoft.Json;

app.MapPost("/legacy", async (HttpRequest request) =>
{
    using var ms = new MemoryStream();
    await request.Body.CopyToAsync(ms);
    ms.Position = 0;

    using var reader = new StreamReader(ms);
    using var jsonReader = new JsonTextReader(reader);
    var serializer = new JsonSerializer();
    var order = serializer.Deserialize<Order>(jsonReader);
    return Results.Ok(order);
});
```

O `Deserialize` síncrono do Newtonsoft agora opera sobre um `MemoryStream`, não sobre o stream de requisição do Kestrel, então a verificação passa. Esse padrão também serve para envolver parsers de terceiros que são apenas síncronos. Para planejamento de longo prazo, veja a abordagem de [migração de Newtonsoft.Json para System.Text.Json](/pt-br/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/).

## Correção 2: habilitar AllowSynchronousIO no servidor inteiro

Se você está preso a uma biblioteca que não tem nenhuma API assíncrona, pode reabilitar E/S síncrona no servidor. Este é um escape global e deve vir acompanhado de um plano registrado para removê-lo. A configuração depende do servidor que você executa.

**Kestrel:**

```csharp
// ASP.NET Core 11
builder.WebHost.ConfigureKestrel(options =>
{
    options.AllowSynchronousIO = true;
});
```

**IIS in-process:**

```csharp
// ASP.NET Core 11
builder.Services.Configure<IISServerOptions>(options =>
{
    options.AllowSynchronousIO = true;
});
```

**HTTP.sys:**

```csharp
// ASP.NET Core 11
builder.WebHost.UseHttpSys(options =>
{
    options.AllowSynchronousIO = true;
});
```

A documentação oficial do Kestrel confirma que a propriedade está em `KestrelServerOptions` e o padrão é `false`; veja [Configure options for the ASP.NET Core Kestrel web server](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/servers/kestrel/options?view=aspnetcore-10.0#synchronous-io). Habilitar em todo lugar faz a verificação sumir, mas também reintroduz o risco de inanição de threads que o padrão foi adicionado para evitar. Trate a flag como um rótulo que diz "ainda não terminei de migrar para assíncrono", não como configuração permanente.

## Correção 3: habilitar E/S síncrona em uma única requisição

Se apenas um endpoint tem dependência síncrona, não acione o interruptor global do servidor. Use `IHttpBodyControlFeature` para optar pela ativação apenas naquela requisição, idealmente dentro de um middleware delimitado à rota exata.

```csharp
// ASP.NET Core 11
using Microsoft.AspNetCore.Http.Features;

app.MapPost("/legacy/export", (HttpContext ctx) =>
{
    var feature = ctx.Features.Get<IHttpBodyControlFeature>();
    if (feature is not null)
    {
        feature.AllowSynchronousIO = true;
    }

    using var writer = new StreamWriter(ctx.Response.Body);
    writer.Write("<huge legacy XML payload>");
    return Results.Empty;
});
```

A feature precisa ser ativada antes da primeira chamada que de outra forma lançaria. Se você ler o corpo primeiro e depois ativar a flag, a leitura já falhou. Para MVC, o equivalente é um filtro que roda no `OnActionExecuting` e ativa a feature antes do model binder ler o corpo.

Essa abordagem por requisição mantém o resto da aplicação protegido pelo padrão. É a resposta certa quando você tem um endpoint legado cercado por outros modernos e assíncronos.

## Pegadinhas e casos parecidos

**A exceção às vezes encobre um problema diferente.** Uma resposta com `Response.Body.Write(...)` depois de `await Response.WriteAsync(...)` pode lançar a mesma exceção mesmo que o dev pensasse que tudo era assíncrono; o problema costuma ser uma chamada oculta a `Flush` dentro de um logger ou um `JsonSerializer` que não aceita o token de cancelamento. Leia o stack trace completo, não só o frame de cima.

**`HttpRequest.ReadFormAsync` é a forma segura para dados de formulário.** Um caminho comum para esse erro é `request.Form["..."]`, que é um accessor síncrono que internamente chama `Read`. Mude para `await request.ReadFormAsync()` e depois acesse o `IFormCollection` resultante.

**Middleware de logging que chama `Response.Body.Seek` ou `CopyTo`.** Middleware personalizado de captura de resposta quase sempre dispara essa verificação. Substitua `CopyTo` por `CopyToAsync` e troque qualquer leitura bloqueante no stream encapsulador pelas sobrecargas assíncronas.

**A verificação não dispara sob TestServer em alguns cenários.** O `TestServer` nem sempre configura o mesmo `IHttpBodyControlFeature` que o Kestrel. Código que funciona em testes pode lançar em produção. Faça um teste de fumaça contra o Kestrel localmente antes de fazer deploy.

**Definir `AllowSynchronousIO = true` não silencia todo erro relacionado a assíncrono.** Ele só muda a verificação de E/S síncrona. `TaskCanceledException` por desconexão do cliente é outro problema; veja o artigo sobre [TaskCanceledException: A task was canceled no HttpClient](/pt-br/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) para essa família de erros.

**Casos parecidos específicos de JSON.** Um `JsonException: The JSON value could not be converted to System.DateTime` é erro de formato em deserialização, não de E/S, mesmo que ambos apareçam dentro de um handler de requisição. Se o frame da sua pilha terminar em `System.Text.Json`, veja o [guia de deserialização de DateTime](/pt-br/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/).

**`DisposeAsync` importa.** Chamar `Dispose` síncrono em um stream que o servidor te entregou pode chamar implicitamente `Flush`, que é uma gravação. Use `await using` para qualquer stream que você obtenha do `HttpContext`.

```csharp
// ASP.NET Core 11
await using var writer = new StreamWriter(response.Body);
await writer.WriteAsync("done");
```

O padrão `await using` é um daqueles pequenos hábitos que se pagam na primeira vez que salvam uma requisição dessa exceção.

## Relacionados

- [Como fazer streaming de um arquivo de um endpoint ASP.NET Core sem buffer](/pt-br/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) cobre os padrões assíncronos que o runtime espera ao escrever respostas grandes.
- [Como enviar um arquivo grande com streaming para o Azure Blob Storage](/pt-br/2026/04/how-to-upload-a-large-file-with-streaming-to-azure-blob-storage/) é o guia correspondente do lado de gravação.
- [Como fazer testes unitários de código que usa HttpClient](/pt-br/2026/04/how-to-unit-test-code-that-uses-httpclient/) mostra o encanamento assíncrono de testes que você quer em volta de qualquer handler que toque corpos de request ou response.
- [Correção: A second operation was started on this context instance before a previous operation completed](/pt-br/2026/05/fix-second-operation-was-started-on-this-context-instance/) é o primo do EF Core deste erro: outro caso em que o runtime pega um erro de sync-sobre-async.
- [Correção: TaskCanceledException: A task was canceled no HttpClient](/pt-br/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) para a família de timeouts relacionados do lado cliente.

## Fontes

- [Configure options for the ASP.NET Core Kestrel web server, Synchronous I/O](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/servers/kestrel/options?view=aspnetcore-10.0#synchronous-io) (MS Learn, .NET 10 / 11)
- [Announcement: AllowSynchronousIO disabled in all servers, dotnet/aspnetcore#7644](https://github.com/dotnet/aspnetcore/issues/7644)
- [ASP.NET Core breaking changes for versions 3.0 and 3.1](https://learn.microsoft.com/en-us/dotnet/core/compatibility/aspnetcore)
- [Referência da API `KestrelServerOptions.AllowSynchronousIO`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.server.kestrel.core.kestrelserveroptions.allowsynchronousio)
- [Interface `IHttpBodyControlFeature`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.features.ihttpbodycontrolfeature)
