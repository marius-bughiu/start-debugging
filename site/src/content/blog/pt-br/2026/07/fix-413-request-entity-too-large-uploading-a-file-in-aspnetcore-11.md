---
title: "Correção: \"413 Request Entity Too Large\" ao enviar um arquivo para um endpoint do ASP.NET Core"
description: "O Kestrel limita o corpo das requisições a 30.000.000 de bytes por padrão e devolve 413 quando você ultrapassa isso. Aumente MaxRequestBodySize globalmente, por endpoint ou no web.config atrás do IIS."
pubDate: 2026-07-17
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "file-upload"
lang: "pt-br"
translationOf: "2026/07/fix-413-request-entity-too-large-uploading-a-file-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-17
---

Um upload devolve `413 Request Entity Too Large` porque o Kestrel limita cada corpo de requisição a 30.000.000 de bytes (cerca de 28,6 MiB) por padrão, e o seu arquivo é maior. Aumente o limite onde ele de fato se aplica: defina `MaxRequestBodySize` no Kestrel de forma global, aplique `[RequestSizeLimit]` ou `[DisableRequestSizeLimit]` em uma action de controller, aumente `FormOptions.MultipartBodyLengthLimit` para envios de formulário e, atrás do IIS, aumente `maxAllowedContentLength` no `web.config`. Verificado com ASP.NET Core 11 no .NET 11 com C# 14; os limites e valores padrão são idênticos do .NET 8 ao .NET 11.

## O erro em contexto

Há duas formas de ele aparecer. A primeira é a resposta HTTP que o cliente vê:

```
HTTP/1.1 413 Request Entity Too Large
Content-Length: 0
Connection: close
Date: Fri, 17 Jul 2026 10:04:11 GMT
```

A segunda é a linha de log que o Kestrel escreve no servidor, que é a que diz exatamente qual limite disparou:

```
Microsoft.AspNetCore.Server.Kestrel.Core.BadHttpRequestException:
Request body too large. The max request body size is 30000000 bytes.
```

Esse `30000000` é a pista. Se você não mudou nada, o número na mensagem é o padrão do framework, e a correção é aumentar ou remover o limite na camada que o controla. Se o número for outro, alguém já configurou um limite e você está batendo nele. De qualquer forma a causa é a mesma: o corpo da requisição ultrapassou um máximo configurado, e o servidor rejeitou a conexão antes de o seu handler conseguir terminar de lê-lo.

## Por que isso acontece

Um upload pode ser bloqueado por quatro limites diferentes, e eles vivem em lugares diferentes. Acertar a correção significa saber qual deles produziu o seu `413`.

- **`MaxRequestBodySize` do Kestrel** limita o corpo total da requisição a 30.000.000 de bytes por padrão. Se você ultrapassar, o Kestrel lança `BadHttpRequestException` e devolve `413`. Este é o que produz a mensagem exata acima.
- **`FormOptions.MultipartBodyLengthLimit`** limita o comprimento de um corpo de formulário multipart a 134.217.728 de bytes (128 MiB) por padrão. Se você ultrapassar, o leitor de formulário lança `InvalidDataException`, que aparece como um `400 Bad Request`, não um `413`. As pessoas confundem os dois o tempo todo.
- **`maxAllowedContentLength` do IIS** (quando você hospeda atrás do IIS) limita a requisição na camada de filtragem de requisições do IIS, por padrão 30.000.000 de bytes, antes de a requisição chegar à sua aplicação. O IIS devolve o próprio erro para isso, então aumentar apenas o limite do Kestrel não faz nada atrás do IIS.
- **Um proxy reverso** (nginx, YARP, um API gateway, um balanceador de carga na nuvem) pode impor o próprio limite de corpo e devolver `413` antes de o Kestrel sequer ver a requisição.

Se a requisição funciona direto contra o Kestrel mas falha atrás de um proxy ou do IIS, o limite que você precisa mudar não está no seu código C#. Verifique primeiro a camada mais externa.

## Reprodução mínima

O menor endpoint que reproduz o `413` padrão. Sem limites personalizados, apenas os valores padrão do framework:

```csharp
// .NET 11, ASP.NET Core 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapPost("/upload", async (HttpRequest request) =>
{
    // Reading the body is what trips the limit
    using var reader = new StreamReader(request.Body);
    var content = await reader.ReadToEndAsync();
    return Results.Ok(new { bytes = content.Length });
});

app.Run();
```

Envie qualquer coisa maior que 30.000.000 de bytes e a leitura lança a exceção:

```bash
# .NET 11 -- generate a 40 MB file and POST it
head -c 40000000 /dev/urandom > big.bin
curl -i -X POST http://localhost:5000/upload \
  -H "Content-Type: application/octet-stream" \
  --data-binary @big.bin
# -> HTTP/1.1 413 Request Entity Too Large
```

A carga de 40 MB passa pelo limite multipart de 128 MiB (de qualquer forma não é multipart), mas ultrapassa o teto de 30 MB do corpo do Kestrel, então você recebe `413`, não `400`.

## Aumente o limite onde ele se aplica

Percorra estes conforme a origem do seu `413`. A maioria das aplicações Kestrel auto-hospedadas só precisa do primeiro.

### 1. Aumente ou remova o limite global do Kestrel

Configure `KestrelServerOptions.Limits.MaxRequestBodySize` na inicialização. Defina uma contagem específica de bytes, ou `null` para remover o teto por completo:

```csharp
// .NET 11, ASP.NET Core 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.WebHost.ConfigureKestrel(options =>
{
    // 200 MB ceiling for the whole app
    options.Limits.MaxRequestBodySize = 200 * 1024 * 1024;
});

var app = builder.Build();
```

Prefira um teto real a `null`. Um tamanho de corpo sem limite é um vetor de negação de serviço: um único cliente pode transmitir gigabytes para o seu processo e esgotar a memória ou o disco. Escolha o maior upload legítimo que você espera e adicione folga, em vez de desabilitar a proteção.

### 2. Defina um limite por endpoint em controllers com atributos

Se apenas um endpoint aceita uploads grandes, não aumente o limite global de toda a aplicação. Em uma action de controller ou uma Razor Page, use `[RequestSizeLimit(bytes)]` para definir um teto específico, ou `[DisableRequestSizeLimit]` para removê-lo só naquela action. Ambos os atributos implementam `IRequestSizeLimitMetadata`, que o pipeline do MVC lê em cada requisição:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
[ApiController]
[Route("api/[controller]")]
public sealed class FilesController : ControllerBase
{
    [HttpPost("upload")]
    [RequestSizeLimit(200 * 1024 * 1024)]   // 200 MB, this action only
    public async Task<IResult> Upload(IFormFile file)
    {
        await using var stream = System.IO.File.Create(
            Path.Combine("uploads", file.FileName));
        await file.CopyToAsync(stream);
        return Results.Ok(new { file.FileName, file.Length });
    }
}
```

Troque `[RequestSizeLimit(...)]` por `[DisableRequestSizeLimit]` quando a action precisar aceitar corpos arbitrariamente grandes e você tiver outra proteção (streaming, uma verificação de cota) no lugar.

### 3. Defina o limite por requisição em minimal APIs

As minimal APIs não respeitam `[RequestSizeLimit]` como os controllers fazem, porque não há nenhum resource filter do MVC no pipeline para lê-lo. Defina o limite de forma imperativa via `IHttpMaxRequestBodySizeFeature`, antes de qualquer coisa ler o corpo:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
app.MapPost("/upload", async (HttpContext context) =>
{
    var sizeFeature = context.Features.Get<IHttpMaxRequestBodySizeFeature>();
    if (sizeFeature is not null && !sizeFeature.IsReadOnly)
    {
        sizeFeature.MaxRequestBodySize = 200 * 1024 * 1024;   // 200 MB
    }

    using var reader = new StreamReader(context.Request.Body);
    var content = await reader.ReadToEndAsync();
    return Results.Ok(new { bytes = content.Length });
});
```

Verifique `IsReadOnly` primeiro. Depois que o servidor começou a ler o corpo, o limite fica travado e atribuir um valor a ele lança `InvalidOperationException`. É também por isso que essa técnica não funciona com um parâmetro `IFormFile` em uma minimal API: o model binding lê o corpo multipart antes de o seu handler rodar, então quando você consegue tocar na feature ela já é somente leitura (essa é a raiz da issue dotnet/aspnetcore #50871, em que uploads multipart grandes para uma minimal API devolviam `200` em silêncio com um arquivo truncado). Para uploads em minimal API, faça o bind de `HttpContext` ou `HttpRequest`, aumente o limite e então leia o formulário você mesmo com `request.ReadFormAsync()`, ou defina um limite para todo um grupo com um pequeno middleware em um `MapGroup`.

### 4. Aumente o limite do formulário multipart para envios de formulário

Se o seu `413` for na verdade um `400` com uma `InvalidDataException` sobre o comprimento de um corpo multipart, o limite que disparou é `FormOptions.MultipartBodyLengthLimit`, não o do Kestrel. Aumente-o globalmente via options, ou por action de controller com `[RequestFormLimits]`:

```csharp
// .NET 11, ASP.NET Core 11, C# 14 -- global, in Program.cs
builder.Services.Configure<FormOptions>(options =>
{
    options.MultipartBodyLengthLimit = 200 * 1024 * 1024;   // 200 MB
});
```

```csharp
// .NET 11, ASP.NET Core 11, C# 14 -- per action
[HttpPost("upload")]
[RequestSizeLimit(200 * 1024 * 1024)]
[RequestFormLimits(MultipartBodyLengthLimit = 200 * 1024 * 1024)]
public async Task<IResult> Upload(IFormFile file) { /* ... */ }
```

Para um upload grande você normalmente precisa aumentar os dois: `MaxRequestBodySize` governa a requisição inteira, e `MultipartBodyLengthLimit` governa o corpo do formulário dentro dela. Defina o mesmo valor para ambos.

### 5. Atrás do IIS, aumente maxAllowedContentLength no web.config

Quando você hospeda atrás do IIS (in-process ou out-of-process), o módulo de filtragem de requisições do IIS impõe `maxAllowedContentLength`, por padrão 30.000.000 de bytes, antes de a requisição chegar ao Kestrel. Aumentar o limite do Kestrel não faz nada até você também aumentar este. Adicione-o ao `web.config`:

```xml
<!-- web.config -- value is in bytes; 200 MB here -->
<system.webServer>
  <security>
    <requestFiltering>
      <requestLimits maxAllowedContentLength="209715200" />
    </requestFiltering>
  </security>
</system.webServer>
```

O módulo de hospedagem in-process tem um segundo limite, separado, que você pode definir em código via `IISServerOptions`:

```csharp
// .NET 11, ASP.NET Core 11, C# 14 -- in-process IIS hosting
builder.Services.Configure<IISServerOptions>(options =>
{
    options.MaxRequestBodySize = 200 * 1024 * 1024;   // 200 MB
});
```

Atrás do IIS você pode precisar alinhar os três: `maxAllowedContentLength` no `web.config`, `IISServerOptions.MaxRequestBodySize` e o `MaxRequestBodySize` do Kestrel. A requisição é rejeitada por qualquer um que for o menor.

### 6. Aumente o teto no seu proxy reverso

Se um proxy fica na frente da aplicação, ele tem o próprio limite e devolve `413` antes de a sua aplicação entrar em cena. No nginx, a diretiva é `client_max_body_size` (por padrão 1 MiB, muito menor que o padrão do Kestrel e uma surpresa comum):

```nginx
# nginx.conf -- allow 200 MB uploads through the proxy
client_max_body_size 200M;
```

Para YARP, um API gateway ou um balanceador de carga na nuvem, encontre a configuração equivalente de tamanho de requisição na configuração daquela camada. Aumentar os limites do lado da aplicação não vai ajudar até o proxy deixar o corpo passar.

## Pegadinhas e variantes

- **`413` não é `400`.** Um `413 Request Entity Too Large` vem do `MaxRequestBodySize` do Kestrel. Um `400 Bad Request` com `InvalidDataException: Multipart body length limit ... exceeded` vem do `FormOptions.MultipartBodyLengthLimit`. São limites diferentes com padrões diferentes (30 MB contra 128 MiB). Leia o tipo da exceção, não só o código de status.
- **HttpSys devolve `500`, não `413`.** Se você hospeda no `HttpSys` em vez do Kestrel, ultrapassar `HttpSysOptions.MaxRequestBodySize` produz um `500 Internal Server Error`, não um `413`. Mesma causa raiz, superfície diferente.
- **Bytes, não mebibytes.** O padrão é `30000000` (trinta milhões) de bytes, que são cerca de 28,6 MiB, não 30 MiB. Se você calcula um limite a partir de "megabytes", decida se quer dizer `1024 * 1024` ou `1000 * 1000` e seja consistente, para que um arquivo de 30 MB não falhe contra um limite de "30 MB".
- **Não recorra a `null` em produção.** Remover o limite por completo transforma cada endpoint de upload em um alvo de esgotamento de memória ou disco. Combine um limite generoso com streaming para nunca bufferizar o arquivo inteiro. Veja [como transmitir um arquivo de um endpoint do ASP.NET Core sem bufferizar](/pt-br/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) e [como enviar um arquivo grande com streaming para o Azure Blob Storage](/pt-br/2026/04/how-to-upload-a-large-file-with-streaming-to-azure-blob-storage/).
- **Blazor Server e SignalR têm o próprio limite.** Um upload grande sobre um circuito de SignalR ou Blazor Server é limitado por `HubOptions.MaximumReceiveMessageSize` (por padrão 32 KB), não por `MaxRequestBodySize`. Essa é uma correção diferente em um lugar diferente.
- **O cliente pode fechar a conexão primeiro.** Um `413` muitas vezes chega com `Connection: close`, e alguns clientes HTTP reportam isso como um erro de socket em vez de um `413` limpo. Registre a `BadHttpRequestException` do lado do servidor para confirmar a causa real em vez de confiar na string de erro do cliente.

O modelo mental: um upload passa por uma pilha de portões de tamanho (proxy, IIS, tamanho de corpo do Kestrel, tamanho de formulário multipart), e é rejeitado pelo primeiro que ele ultrapassar. Encontre a camada que produziu o seu `413`, aumente aquele limite para um valor real e limitado, e combine-o com streaming para que um limite maior não vire uma responsabilidade maior.

## Relacionado

- [Como transmitir um arquivo de um endpoint do ASP.NET Core sem bufferizar](/pt-br/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) para servir arquivos grandes sem carregá-los na memória.
- [Como enviar um arquivo grande com streaming para o Azure Blob Storage](/pt-br/2026/04/how-to-upload-a-large-file-with-streaming-to-azure-blob-storage/) para empurrar uploads grandes direto para o blob storage.
- [Correção: "415 Unsupported Media Type" de um endpoint de minimal API no ASP.NET Core 11](/pt-br/2026/07/fix-415-unsupported-media-type-from-a-minimal-api-endpoint-in-aspnetcore-11/) para o erro irmão quando o Content-Type da requisição está errado.
- [Como personalizar as respostas de erro de validação de minimal API com IProblemDetailsService no ASP.NET Core 11](/pt-br/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/) para transformar um código de status nu em um corpo de erro útil.
- [Como adicionar compressão de resposta a uma API do ASP.NET Core 11](/pt-br/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/) para a contraparte de saída dos limites de corpo de entrada.

## Fontes

- ASP.NET Announcements, [New default 30 MB (~28.6 MiB) max request body size limit](https://github.com/aspnet/Announcements/issues/267) (padrão de 30.000.000 de bytes no Kestrel e HttpSys, `413` no Kestrel e `500` no HttpSys, `MaxRequestBodySize`, `IHttpMaxRequestBodySizeFeature`, `[RequestSizeLimit]` / `[DisableRequestSizeLimit]`, comportamento no IIS).
- Microsoft Learn, [Upload files in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/mvc/models/file-uploads?view=aspnetcore-10.0) (padrão de 134.217.728 de bytes do `FormOptions.MultipartBodyLengthLimit`, `[RequestFormLimits]`, `IISServerOptions.MaxRequestBodySize`, `maxAllowedContentLength` no `web.config`).
- Microsoft Learn, [IRequestSizeLimitMetadata.MaxRequestBodySize](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.metadata.irequestsizelimitmetadata.maxrequestbodysize?view=aspnetcore-10.0) (a interface de metadata que os atributos de limite de tamanho implementam).
- dotnet/aspnetcore, [Minimal API endpoints accepting IFormFile terminating with HTTP 200 for large files](https://github.com/dotnet/aspnetcore/issues/50871) (por que `IHttpMaxRequestBodySizeFeature` não pode ser definido depois de o corpo multipart ter sido vinculado em uma minimal API).
