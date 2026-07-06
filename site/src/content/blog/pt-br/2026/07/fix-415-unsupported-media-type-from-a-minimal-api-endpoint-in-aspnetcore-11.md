---
title: "Correção: \"415 Unsupported Media Type\" de um endpoint de minimal API no ASP.NET Core 11"
description: "Uma minimal API retorna 415 quando o Content-Type da requisição não corresponde ao que o endpoint faz o binding. Envie Content-Type: application/json para um tipo vinculado ao corpo, ou use [FromForm] para formulários e uploads de arquivos."
pubDate: 2026-07-06
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-apis"
lang: "pt-br"
translationOf: "2026/07/fix-415-unsupported-media-type-from-a-minimal-api-endpoint-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-06
---

Um endpoint de minimal API retorna `415 Unsupported Media Type` quando o cabeçalho `Content-Type` do corpo da requisição não corresponde ao que o route handler está tentando vincular. A causa mais comum: um parâmetro do handler é um tipo complexo vinculado a partir do corpo, o que exige `Content-Type: application/json`, e o cliente não enviou nenhum content type, enviou `text/plain` ou enviou dados de formulário. Corrija isso enviando `Content-Type: application/json` para um corpo JSON, ou anote o parâmetro com `[FromForm]` quando o cliente envia `application/x-www-form-urlencoded` ou `multipart/form-data`. Isso foi verificado no ASP.NET Core 11 sobre .NET 11 com C# 14; o comportamento é idêntico do .NET 8 ao .NET 10.

## O erro em contexto

Ao contrário da maioria das exceções, esta nunca chega ao seu código. A camada de binding da minimal API rejeita a requisição antes de o seu handler executar e escreve um `415` cru de volta para o cliente. Não há stack trace, nenhum corpo `ProblemDetails` por padrão, apenas a linha de status:

```
HTTP/1.1 415 Unsupported Media Type
Content-Type: application/problem+json
Date: Mon, 06 Jul 2026 09:12:44 GMT

{
  "type": "https://tools.ietf.org/html/rfc9110#section-15.5.16",
  "title": "Unsupported Media Type",
  "status": 415
}
```

Se você não configurou `AddProblemDetails()`, obtém um corpo vazio apenas com o status `415`. De qualquer forma, a ausência de um stack trace é o indício: esta é uma falha de negociação de conteúdo em nível de framework, não algo lançado dentro do seu handler. A referência de parameter binding da Microsoft Learn documenta isso claramente em sua tabela de falhas de binding: "Wrong content type (not `application/json`), body, 415."

## Por que isso acontece

Um route handler de minimal API vincula cada parâmetro a partir de uma origem: a rota, a query string, um cabeçalho, um serviço da DI ou o corpo da requisição. Quando um parâmetro é um tipo complexo sem atributo `[From*]`, as minimal APIs inferem que ele vem do corpo da requisição, e o único leitor de corpo configurado por padrão é o leitor do `System.Text.Json`. Esse leitor é registrado para exatamente um media type: `application/json`.

Então o framework faz uma verificação de content type antes mesmo de chamar `JsonSerializer`. Se o `Content-Type` recebido não for `application/json` (ou um tipo com sufixo `+json` compatível), o leitor de corpo recusa a requisição, e as minimal APIs fazem um curto-circuito com `415`. Ele não tenta adivinhar. Um `Content-Type` ausente, `text/plain`, `application/x-www-form-urlencoded` ou `multipart/form-data` falham todos da mesma forma quando o parâmetro de destino espera um corpo JSON.

Esta é uma falha diferente de um `400 Bad Request`. Um `400` significa que o content type estava correto, mas o payload JSON estava malformado ou violou a validação. Um `415` significa que o framework nunca sequer tentou ler o corpo porque o content type estava errado. Manter esses dois separados evita que você depure o seu JSON quando o problema real é um cabeçalho. Os três gatilhos usuais:

- O cliente envia um corpo JSON, mas esquece o cabeçalho `Content-Type: application/json` (ou um proxy o remove).
- O cliente envia dados de formulário (`application/x-www-form-urlencoded` ou `multipart/form-data`) para um handler cujo parâmetro é vinculado a partir do corpo JSON.
- O cliente envia um content type de fornecedor ou decorado com charset que o leitor JSON não está registrado para aceitar.

## Reprodução mínima

Aqui está o menor endpoint que produz o erro. `CreateProduct` é um tipo complexo sem atributo de binding, então as minimal APIs o vinculam a partir do corpo JSON:

```csharp
// .NET 11, ASP.NET Core 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddProblemDetails();   // so the 415 comes back as problem+json
var app = builder.Build();

app.MapPost("/products", (CreateProduct product) =>
    TypedResults.Created($"/products/{product.Sku}", product));

app.Run();

public record CreateProduct(string Sku, string Name, int Quantity);
```

Agora envie um corpo sem o cabeçalho de content type. Cada uma destas retorna `415`:

```bash
# .NET 11 -- no Content-Type header at all
curl -i -X POST http://localhost:5000/products \
  -d '{"sku":"A-100","name":"Widget","quantity":5}'

# .NET 11 -- wrong Content-Type (curl defaults -d to x-www-form-urlencoded)
curl -i -X POST http://localhost:5000/products \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d 'sku=A-100&name=Widget&quantity=5'

# .NET 11 -- text/plain, even though the payload is valid JSON
curl -i -X POST http://localhost:5000/products \
  -H "Content-Type: text/plain" \
  -d '{"sku":"A-100","name":"Widget","quantity":5}'
```

O payload na primeira e na terceira chamadas é JSON perfeitamente válido. Isso não importa. O leitor é controlado pelo cabeçalho, não pelos bytes.

## Correção, em detalhe

Trabalhe nestes itens em ordem. O primeiro resolve a grande maioria dos casos.

### 1. Envie `Content-Type: application/json` para um tipo vinculado ao corpo

Se o seu handler vincula um tipo complexo a partir do corpo, o cliente precisa declarar um content type JSON. Com o `curl`, a armadilha é que `-d` (ou `--data`) define silenciosamente `application/x-www-form-urlencoded`. Use `--json`, ou defina o cabeçalho explicitamente:

```bash
# .NET 11 -- curl 7.82+ has a --json shortcut that sets the header for you
curl -i -X POST http://localhost:5000/products \
  --json '{"sku":"A-100","name":"Widget","quantity":5}'

# .NET 11 -- or set it by hand
curl -i -X POST http://localhost:5000/products \
  -H "Content-Type: application/json" \
  -d '{"sku":"A-100","name":"Widget","quantity":5}'
```

A partir de um `HttpClient` tipado, use `PostAsJsonAsync`, que define o cabeçalho e serializa em uma única chamada. Esta é a maneira mais comum de acidentalmente corrigir ou acidentalmente quebrar o cabeçalho:

```csharp
// .NET 11, C# 14 -- sets Content-Type: application/json automatically
using System.Net.Http.Json;

var http = new HttpClient { BaseAddress = new Uri("http://localhost:5000") };
var response = await http.PostAsJsonAsync(
    "/products",
    new { sku = "A-100", name = "Widget", quantity = 5 });

response.EnsureSuccessStatusCode();   // 201 Created, no 415
```

Se você constrói o `HttpContent` manualmente, use `JsonContent.Create(...)` ou um `StringContent` com o media type definido. Um `new StringContent(json)` sem media type usa `text/plain` por padrão e resulta em um `415`:

```csharp
// .NET 11, C# 14
// WRONG -- StringContent defaults to text/plain -> 415
var bad = new StringContent(json);

// RIGHT -- declare the media type
var good = new StringContent(json, System.Text.Encoding.UTF8, "application/json");
```

No `fetch` do JavaScript, defina o cabeçalho explicitamente; o `fetch` não o adiciona para você quando o corpo é uma string:

```javascript
// browser fetch -- must set Content-Type or you get 415
await fetch("/products", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ sku: "A-100", name: "Widget", quantity: 5 }),
});
```

### 2. Use `[FromForm]` para envios de formulário e uploads de arquivos

Se o cliente genuinamente envia dados de formulário (um submit de `<form>` HTML, ou um upload de arquivo), não force isso para JSON. Diga ao handler para vincular a partir do formulário em vez do corpo, anotando cada parâmetro com `[FromForm]`. Isso muda o content type esperado do endpoint para `application/x-www-form-urlencoded` e `multipart/form-data`:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
app.MapPost("/products",
    ([FromForm] string sku, [FromForm] string name, [FromForm] int quantity) =>
        TypedResults.Created($"/products/{sku}", new { sku, name, quantity }));
```

Para uploads de arquivos, um parâmetro `IFormFile` exige `multipart/form-data`. Conforme a documentação de minimal API, as minimal APIs não vinculam o corpo inteiro da requisição diretamente a um `IFormFile`; o campo precisa vir através de codificação de formulário, e o nome do parâmetro precisa corresponder ao nome do campo do formulário:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
app.MapPost("/upload",
    async ([FromForm] string title, IFormFile file, HttpContext ctx) =>
    {
        await using var stream = File.Create(Path.Combine("uploads", file.FileName));
        await file.CopyToAsync(stream);
        return TypedResults.Ok(new { title, file.FileName, file.Length });
    })
    .DisableAntiforgery();   // see the gotcha below before you copy this line
```

Envie isso como multipart e o `415` desaparece:

```bash
# .NET 11 -- multipart, matches the [FromForm] + IFormFile handler
curl -i -X POST http://localhost:5000/upload \
  -F "title=Spec sheet" \
  -F "file=@./spec.pdf"
```

### 3. Remova o charset ou sufixo de fornecedor que o leitor JSON rejeita

Um content type como `application/json; charset=utf-8` é aceito, mas um tipo de fornecedor puro como `application/vnd.myapp+json` pode não ser, dependendo de como os media types do leitor estão configurados. Se você controla um cliente que envia um media type `+json` personalizado e não consegue alterá-lo, registre esse media type para que o leitor de corpo JSON o reconheça. Nas minimal APIs você faz isso configurando os content types de requisição aceitos pelo endpoint com `Accepts`, o que também alimenta o seu documento OpenAPI:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
app.MapPost("/products", (CreateProduct product) =>
        TypedResults.Created($"/products/{product.Sku}", product))
    .Accepts<CreateProduct>("application/json", "application/vnd.myapp+json");
```

### 4. Leia um corpo não-JSON por conta própria com HttpRequest

Quando o payload não é JSON de forma alguma (bytes crus, CSV, um formato de texto personalizado), pare de vincular um tipo complexo e leia o stream diretamente. Vincule `HttpRequest` (ou `Stream`, ou `PipeReader`), que as minimal APIs fornecem sem nenhuma verificação de content type, e faça o parse do corpo nos seus próprios termos:

```csharp
// .NET 11, ASP.NET Core 11, C# 14 -- accepts any content type
app.MapPost("/import", async (HttpRequest request) =>
{
    using var reader = new StreamReader(request.Body);
    var raw = await reader.ReadToEndAsync();
    // parse `raw` (CSV, custom format, whatever) here
    return TypedResults.Ok(new { bytes = raw.Length });
});
```

Como você nunca pediu ao framework para desserializar o corpo em um parâmetro tipado, não há controle de content type, e o `415` não pode ocorrer neste endpoint.

## Pegadinhas e variantes

Um punhado de casos parecidos leva pessoas a esta página por engano, e algumas arestas afiadas mordem mesmo depois da correção:

- **`415` não é `406`.** `415 Unsupported Media Type` é sobre o `Content-Type` do corpo da requisição. `406 Not Acceptable` é sobre o cabeçalho `Accept` do cliente para a resposta. Se você está recebendo `406`, está na página errada: o servidor não consegue produzir uma representação que o cliente aceite, o que é um problema de formatter na saída, não na entrada.

- **`415` não é `400`.** Se o content type está correto, mas o JSON está malformado ou falha na validação, você recebe um `400`, não um `415`. Para esse caminho, veja [como validar corpos de requisição em minimal APIs sem controllers](/pt-br/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/), e se você precisa remodelar o payload do `400`, [personalize as respostas de erro de validação de minimal API com IProblemDetailsService](/pt-br/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/). Uma variante específica de JSON malformado, uma string de data que o serializador não consegue fazer o parse, é coberta em [the JSON value could not be converted](/pt-br/2026/05/fix-jsonexception-the-json-value-could-not-be-converted/).

- **Endpoints com `[FromForm]` exigem um token antiforgery por padrão.** Desde o .NET 8, parâmetros de minimal API vinculados a formulário acionam a validação antiforgery. Um cliente programático (curl, `HttpClient`) que envia um formulário sem um token válido é rejeitado, o que parece um problema de content type, mas não é. Ou envie o token antiforgery, ou chame `.DisableAntiforgery()` em endpoints que não são acionados por navegador, como no exemplo de upload acima. Não desative isso de forma geral em endpoints para os quais um navegador envia dados.

- **Um `Content-Type` ausente se comporta como o errado.** Alguns clientes HTTP omitem o cabeçalho inteiramente em um `POST` com corpo. Da perspectiva do framework, um content type ausente não é `application/json`, então falha na mesma verificação `415`. Sempre defina o cabeçalho explicitamente em vez de depender de um padrão do cliente.

- **Proxies reversos e API gateways podem reescrever ou remover o cabeçalho.** Se a mesma requisição funciona contra o Kestrel diretamente, mas retorna `415` atrás do nginx, YARP ou um API gateway, inspecione qual `Content-Type` realmente chega ao app. Registre `HttpContext.Request.ContentType` no topo do pipeline para ver o valor real em vez do que você pensa que enviou.

- **A inferência de `[ApiController]` é um conceito de controllers, não de minimal API.** Se você migrou de controllers, lembre-se de que as minimal APIs inferem o binding de corpo para tipos complexos da mesma forma, mas não há atributo `[Consumes]` filtrando media types a menos que você adicione `Accepts`. A origem do binding, não um atributo, é o que controla o content type.

O modelo mental a manter: um `415` de minimal API é uma incompatibilidade entre o `Content-Type` que o cliente enviou e o leitor de corpo que o endpoint espera. Decida o que o endpoint deve aceitar, corpo JSON, formulário, arquivo ou stream cru, e então faça o cabeçalho do cliente e o binding do handler concordarem. Quando eles concordam, o `415` desaparece e você volta ao território normal de `400`/`200`.

## Relacionados

- [Como validar corpos de requisição em minimal APIs sem controllers no ASP.NET Core 11](/pt-br/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/) para o caminho do `400` uma vez que o content type esteja correto.
- [Como personalizar respostas de erro de validação de minimal API com IProblemDetailsService no ASP.NET Core 11](/pt-br/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/) para moldar o corpo do erro que o cliente vê.
- [Como organizar endpoints de minimal API com MapGroup no ASP.NET Core 11](/pt-br/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) para aplicar `Accepts` e filtros em um grupo de endpoints.
- [Minimal APIs vs controllers no ASP.NET Core 11](/pt-br/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) para como o tratamento de content type difere entre os dois modelos.
- [Como configurar autenticação JWT bearer em uma minimal API no ASP.NET Core 11](/pt-br/2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11/) para a camada de autenticação que fica na frente desses endpoints.

## Fontes

- Microsoft Learn, [Parameter binding in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/parameter-binding?view=aspnetcore-9.0) (tabela de falhas de binding: content type errado em um parâmetro de corpo retorna 415; requisitos de `[FromForm]`, `IFormFile` e `multipart/form-data`; antiforgery no binding de formulário).
- Microsoft Learn, [Minimal APIs quick reference](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis?view=aspnetcore-9.0) (metadados `Accepts`, origens de binding de corpo vs formulário).
- MDN, [415 Unsupported Media Type](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/415) (a semântica HTTP: o servidor recusa o media type do payload da requisição).
