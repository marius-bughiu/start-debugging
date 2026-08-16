---
title: "Como baixar um arquivo a partir de um componente Blazor sem interop com JavaScript"
description: "Dispense o módulo JS downloadFileFromStream. Renderize uma âncora com o atributo download apontando para um endpoint de minimal API que devolve TypedResults.File, ou envie por POST um formulário HTML simples com um AntiforgeryToken. Cobre por que o atributo download é o que impede a navegação aprimorada do Blazor de engolir o clique, por que data-enhance descarta o arquivo silenciosamente e a armadilha de cookie versus bearer."
pubDate: 2026-08-16
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "blazor"
  - "minimal-apis"
lang: "pt-br"
translationOf: "2026/08/how-to-download-a-file-from-a-blazor-component-without-javascript-interop"
translatedBy: "claude"
translationDate: 2026-08-16
---

Para baixar um arquivo a partir de um componente Blazor sem escrever uma linha de JavaScript, renderize um elemento `<a>` simples cujo `href` aponte para um endpoint que devolve `TypedResults.File` e que tenha o atributo `download` presente. Esse é o truque inteiro. O atributo `download` não é apenas uma dica de nome de arquivo: ele é a marcação que faz a navegação aprimorada do Blazor pular o clique e deixar o navegador executar uma navegação real, que o cabeçalho `Content-Disposition: attachment` então transforma em um salvamento. Para arquivos cujo conteúdo depende da entrada do usuário, envie por POST um `<form>` HTML simples com um `<AntiforgeryToken />` para o mesmo tipo de endpoint. Tudo abaixo tem como alvo .NET 11 e C# 14, e foi verificado de ponta a ponta contra um Blazor Web App rodando em ASP.NET Core 10.0.5, onde o comportamento é idêntico. As APIs não mudam desde o .NET 8.

## Por que a orientação oficial recorre ao interop com JS, e quando você pode ignorá-la

A [documentação de downloads de arquivos no Blazor](https://learn.microsoft.com/en-us/aspnet/core/blazor/file-downloads) oferece duas receitas, e ambas começam mandando você adicionar um arquivo `.js`. A receita para arquivos pequenos embrulha um `Stream` em um `DotNetStreamReference`, envia para uma função JS `downloadFileFromStream` e reconstrói tudo como um `Blob` e uma object URL no cliente. A receita para arquivos grandes chama uma função JS `triggerFileDownload` que constrói um `HTMLAnchorElement` em script e dispara um `click` sintético nele.

Leia a segunda de novo. O JavaScript existe para criar um elemento âncora e clicar nele. Você está dentro de um framework de UI cujo trabalho inteiro é renderizar elementos HTML. Você pode renderizar a âncora você mesmo.

O caminho sem JS não é só menos código: ele desvia de uma classe de bug na qual o caminho de interop entra de cabeça. `IJSRuntime` não pode ser usado enquanto um componente está em pré-renderização, e é por isso que [chamadas de interop com JavaScript não podem ser emitidas neste momento](/pt-br/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/) é uma das exceções mais comuns do Blazor. Ele também não está disponível em componentes que usam renderização estática no servidor (static SSR), porque não há circuito nem runtime WebAssembly para chamar. Uma âncora funciona em todos os modos de renderização, incluindo static SSR, sem nenhuma regra de ciclo de vida.

Existe exatamente um cenário em que você realmente precisa de interop: um app Blazor WebAssembly independente que gera bytes no cliente e precisa salvá-los sem ida e volta ao servidor. Mesmo lá, um URI `data:` resolve quase tudo, e eu cubro os limites no final.

## O atributo download é o que impede o Blazor de comer seu clique

Esta é a parte que ninguém explica, e é por isso que o conselho "é só usar uma âncora" falha tanto em um Blazor Web App.

Blazor Web Apps habilitam navegação aprimorada por padrão. Um manipulador de clique no nível do documento intercepta links internos, busca o destino com `fetch` e aplica o HTML retornado no DOM existente em vez de fazer uma carga completa de página. Isso é ótimo para páginas e catastrófico para um CSV.

A cláusula de guarda do interceptador está visível no `blazor.web.js` distribuído:

```js
return (!t || "_self" === t) && e.hasAttribute("href") && !e.hasAttribute("download")
```

Uma âncora só é candidata à interceptação quando tem um `href` e **não** tem um atributo `download`. O atributo é uma exclusão deliberada, embutida no framework.

Deixe-o de fora e é isto que realmente acontece, medido em um navegador contra um app rodando. Clicar em `<a href="/exports/orders.csv">` produz:

```text
[warn] Enhanced navigation failed for destination http://localhost:5248/exports/orders.csv.
       Falling back to full page load.
```

A barra de endereços muda para `/exports/orders.csv?`, com um ponto de interrogação perdido incluído, enquanto o DOM ainda mostra a página anterior. O log de rede mostra o endpoint acessado **duas vezes**: primeiro pelo `fetch` da navegação aprimorada, que não soube o que fazer com `text/csv`, e depois pela navegação de documento de fallback que o navegador finalmente entrega ao gerenciador de downloads. Sua consulta de exportação roda duas vezes, a URL do usuário fica errada e o arquivo chega mesmo assim, que é a pior combinação possível porque parece que funciona.

Adicione `download` e nada disso acontece. O clique nunca é interceptado, a URL nunca muda, sai uma requisição e volta um arquivo.

## Passos para montar um download sem JS

1. **Escreva um endpoint que devolve o arquivo.** Um `MapGet` de minimal API que devolve `TypedResults.File`, `TypedResults.Bytes` ou `TypedResults.Stream` define `Content-Disposition: attachment` para você quando você passa `fileDownloadName`.
2. **Renderize uma âncora apontando para ele, com o atributo `download` presente.** Não o omita, nem quando o endpoint já define `Content-Disposition`.
3. **Para exportações parametrizadas, use um `<form method="post">` simples** direcionado ao endpoint, com um `<AntiforgeryToken />` dentro e sem o atributo `data-enhance`.
4. **Garanta que o endpoint autentique do jeito que uma navegação do navegador autentica**, ou seja, com cookies e não com um cabeçalho `Authorization`.
5. **Verifique os cabeçalhos da resposta**, não a caixa de diálogo de salvamento do navegador. `curl -I` contra o endpoint deve mostrar `Content-Disposition: attachment` e o nome de arquivo que você espera.

## O endpoint: três formatos de TypedResults

Para conteúdo que já cabe na memória, entregue ao endpoint um `byte[]`:

```csharp
// .NET 11, C# 14
app.MapGet("/exports/orders.csv", () =>
{
    var csv = new StringBuilder("Id,Customer,Total\n");
    foreach (var order in OrderStore.Recent())
    {
        csv.Append(CultureInfo.InvariantCulture, $"{order.Id},{order.Customer},{order.Total}\n");
    }

    return TypedResults.File(
        Encoding.UTF8.GetBytes(csv.ToString()),
        contentType: "text/csv",
        fileDownloadName: "orders.csv");
});
```

Isso produz exatamente os cabeçalhos de que um navegador precisa:

```text
HTTP/1.1 200 OK
Content-Length: 75
Content-Type: text/csv
Content-Disposition: attachment; filename=orders.csv; filename*=UTF-8''orders.csv
```

Repare nos parâmetros `filename` e `filename*` duplicados. O ASP.NET Core emite a forma da RFC 6266 automaticamente, e é isso que faz nomes de arquivo não ASCII sobreviverem à viagem.

Para qualquer coisa grande o bastante para que armazená-la em memória seja um risco, use `TypedResults.Stream` com um callback e escreva direto no corpo da resposta:

```csharp
// .NET 11, C# 14
app.MapGet("/exports/orders-stream.csv", (IOrderQuery query, CancellationToken ct) =>
    TypedResults.Stream(
        async stream =>
        {
            await using var writer = new StreamWriter(stream, new UTF8Encoding(false), leaveOpen: true);
            await writer.WriteLineAsync("Id,Customer,Total");

            await foreach (var order in query.StreamAsync(ct))
            {
                await writer.WriteLineAsync($"{order.Id},{order.Customer},{order.Total}");
            }
        },
        contentType: "text/csv",
        fileDownloadName: "orders-stream.csv"));
```

Isso responde com `Transfer-Encoding: chunked` e sem `Content-Length`, então o usuário não ganha barra de progresso, mas o servidor nunca segura a exportação inteira. A mesma troca vale sempre que você precisa [transmitir um arquivo de um endpoint ASP.NET Core sem bufferizar](/pt-br/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/).

O `new UTF8Encoding(false)` é deliberado. O `Encoding.UTF8` padrão do `StreamWriter` tem o preâmbulo BOM habilitado, então a versão atalho escreve três bytes perdidos antes da sua linha de cabeçalho. Bati nisso no app de teste: o endpoint de `byte[]` produziu saída limpa porque `Encoding.UTF8.GetBytes` nunca emite preâmbulo, enquanto o endpoint de streaming prefixou `Id,Customer,Total` com um BOM. Para CSV aberto no Excel esse BOM é exatamente o que você quer, então escolha por formato em vez de por acidente.

Se o arquivo já existe em disco, pule o buffer por completo: `TypedResults.File(File.OpenRead(path), "application/pdf", "manual.pdf", enableRangeProcessing: true)`. O processamento de range permite ao navegador retomar um download interrompido.

## Static SSR: uma âncora e um formulário simples, sem circuito

Aqui está um componente que adota static SSR, não tem modo de renderização, não tem `@onclick` e baixa dois arquivos diferentes:

```razor
@* .NET 11, static SSR, no render mode *@
@page "/exports"

<h1>Exports</h1>

<a href="/exports/orders.csv" download>Download today's orders</a>

<a href="/exports/orders.csv" download="orders-2026-08.csv">Download with a custom name</a>

<form method="post" action="/exports/orders">
    <AntiforgeryToken />
    <label>
        Rows
        <input type="number" name="maxRows" value="500" />
    </label>
    <input type="hidden" name="format" value="csv" />
    <button type="submit">Export</button>
</form>
```

A segunda âncora mostra a única coisa que o atributo `download` faz além de sair da navegação aprimorada: seu valor sobrescreve o nome de arquivo sugerido pelo servidor. Deixe-o vazio quando o `fileDownloadName` do endpoint já estiver certo.

O formulário é um `<form>` HTML simples com um `action`, não um `EditForm`, e não carrega `@formname` nem `@onsubmit`. Isso é intencional. Um `EditForm` faz post de volta para dentro do componente Blazor, e o trabalho de um componente é renderizar HTML, então não há como ele devolver um arquivo. Fazer post para um endpoint separado é o único caminho que termina em download.

`<AntiforgeryToken />` renderiza um campo oculto `__RequestVerificationToken`. Ele é obrigatório, porque um endpoint de minimal API que faz binding de parâmetros `[FromForm]` está coberto pela validação antiforgery desde o .NET 8. Faça post sem o token e você recebe um `400` seco:

```csharp
// .NET 11, C# 14
app.MapPost("/exports/orders", ([FromForm] string format, [FromForm] int maxRows) =>
{
    var bytes = ExportBuilder.Build(format, maxRows);

    return TypedResults.File(bytes, "text/csv", $"orders.{format}");
});
```

Com `app.UseAntiforgery()` no pipeline e o token no formulário, isso devolve o arquivo direto para o navegador. Sem circuito, sem payload de WebAssembly, sem JavaScript.

O .NET 11 adiciona uma segunda camada aqui. A proteção CSRF automática baseada em cabeçalhos vem ligada por padrão em apps construídos com `WebApplication.CreateBuilder`, inspecionando `Sec-Fetch-Site` e `Origin` em métodos não seguros, e os posts de formulário do Blazor SSR devolvem `400 Bad Request` para posts cross-origin não confiáveis. A validação de token continua rodando só se você chamar `UseAntiforgery`, e quando as duas estão presentes o veredito do token prevalece. Se um formulário que funcionava no .NET 10 começa a dar 400 depois da atualização, esse middleware é a primeira coisa a checar. Detalhei o comportamento dele quando [o ASP.NET Core 11 ligou a proteção CSRF automática](/pt-br/2026/07/aspnetcore-11-automatic-csrf-protection-fetch-metadata-preview-6/).

## Modos de renderização interativos: entregue uma URL ao cliente, não bytes

Em um componente interativo o instinto é fazer o manipulador do botão produzir um `byte[]` e depois procurar algum jeito de empurrá-lo para o navegador. Inverta. Faça o manipulador preparar a exportação no servidor, guardá-la atrás de um token e renderizar uma âncora:

```razor
@* .NET 11, C# 14 *@
@page "/reports"
@rendermode InteractiveServer
@inject IReportService Reports

<button @onclick="Prepare" disabled="@_working">Prepare export</button>

@if (_token is not null)
{
    <a href="@($"/exports/report/{_token}")" download="report.csv">Your export is ready</a>
}

@code {
    private string? _token;
    private bool _working;

    private async Task Prepare()
    {
        _working = true;
        _token = await Reports.QueueExportAsync();
        _working = false;
    }
}
```

O usuário clica duas vezes, o que é uma UI honesta para uma exportação que leva tempo real de qualquer jeito, e os bytes nunca trafegam pelo circuito SignalR.

Se você insiste em um clique só, `NavigationManager.NavigateTo(url, forceLoad: true)` funciona e continua sem envolver código de interop seu. Como a resposta carrega `Content-Disposition: attachment`, o navegador inicia um download e abandona a navegação. Confirmei que a URL da SPA fica intacta depois: era `/interactive` antes da chamada e `/interactive` depois, com o arquivo entregue.

```csharp
// .NET 11, C# 14
private void Download() => Nav.NavigateTo("/exports/orders-stream.csv", forceLoad: true);
```

A ressalva é que isso é uma navegação, então se o endpoint devolver um `404` ou um `500` em vez de um arquivo, o navegador tira o usuário do seu app e o leva a uma página de erro. Uma âncora falha do mesmo jeito, mas pelo menos o usuário escolheu clicar.

## Blazor WebAssembly sem servidor: a saída de emergência do URI data

Quando os bytes são produzidos no cliente e não existe endpoint para apontar, jogue-os em base64 dentro do `href`:

```razor
@* .NET 11, C# 14, Blazor WebAssembly *@
@rendermode InteractiveWebAssembly

<button @onclick="Build">Build report</button>

@if (_href is not null)
{
    <a href="@_href" download="client-report.csv">Save client-report.csv</a>
}

@code {
    private string? _href;

    private void Build()
    {
        var bytes = Encoding.UTF8.GetBytes(ReportBuilder.ToCsv());
        _href = $"data:text/csv;base64,{Convert.ToBase64String(bytes)}";
    }
}
```

O Chrome bloqueia navegação de nível superior para URIs `data:`, mas isenta explicitamente âncoras que carregam um atributo `download`, então isso sobrevive. Verifiquei que a âncora renderizada mantém `download="client-report.csv"` intacto no DOM depois da hidratação do WebAssembly.

Dois limites impedem que essa seja a resposta geral. Base64 infla payloads em cerca de um terço e tudo isso vive em um atributo do DOM, então uma exportação de 30 MB vira uma string de 40 MB na árvore de renderização. E os navegadores discordam sobre tetos: Chrome e Edge impõem um limite de 2 MB em alguns contextos `data:`, enquanto Firefox e Safari não documentam nenhum. Abaixo de um megabyte mais ou menos, isso está de bom tamanho. Acima disso, adicione um endpoint no servidor ou aceite que você precisa de `Blob` e `URL.createObjectURL`, o que significa interop.

## Os detalhes que vão realmente te morder

**`data-enhance` no formulário joga seu arquivo fora silenciosamente.** O tratamento aprimorado de formulários faz post com `fetch` e se recusa a falar com qualquer coisa que não seja um endpoint Blazor. Adicionar `data-enhance` ao formulário de exportação acima produziu isto no console:

```text
Enhanced navigation does not support making a non-GET request to a non-Blazor endpoint.
Avoid enabling enhanced navigation for forms that post to a non-Blazor endpoint.
```

A aba de rede mostrou o `POST` devolvendo `200` com o corpo CSV completo. O servidor construiu a exportação, transmitiu tudo, e o cliente descartou. Nada foi baixado. `EditForm` com `Enhance` falha de forma idêntica.

**Tokens bearer não sobrevivem a uma navegação.** Um clique em âncora e um post de formulário são requisições iniciadas pelo navegador. Não existe cabeçalho `Authorization`, porque não existe código seu rodando para anexá-lo. Se sua API autentica com JWTs guardados em memória, o endpoint de download devolve `401` por mais correta que a marcação esteja. Ou você dá autenticação por cookie àquele endpoint específico, ou emite um token de uso único e vida curta e o coloca na rota, como no exemplo interativo. Vale ler as [diferenças entre autenticação JWT e por cookie](/pt-br/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/) antes de escolher, porque isso é uma bifurcação arquitetural de verdade e não uma gambiarra.

**O atributo `download` é ignorado entre origens.** Desde o Chrome 65 a dica de nome de arquivo é descartada silenciosamente para URLs cross-origin, e o Firefox ignora o atributo por completo e navega no lugar. Se seus arquivos vivem em uma CDN ou em um host de API separado, o atributo deixa de ser decisivo e o `Content-Disposition: attachment` definido pelo servidor de origem passa a ser a única coisa que dispara o salvamento. Configure-o lá.

**Ativos estáticos também precisam do atributo.** `<a href="/docs/manual.pdf" download>` funciona contra arquivos em `wwwroot`, mas sem `download` a interceptação da navegação aprimorada também vale para eles, e um PDF é exatamente o tipo de resposta que faz a navegação aprimorada desistir no meio da aplicação do patch.

**Não tente escrever a resposta a partir do componente.** Pegar o `HttpContext` em cascata dentro de um componente static SSR e escrever bytes em `Response.Body` briga com o renderizador e te deixa em [cabeçalhos são somente leitura, a resposta já começou](/pt-br/2026/07/fix-headers-are-read-only-response-has-already-started-in-aspnetcore/). Componentes renderizam marcação. Endpoints devolvem arquivos. Mantenha a separação.

A regra que sai de tudo isso é pequena o bastante para lembrar: o navegador já sabe baixar arquivos, e o Blazor já sabe renderizar âncoras. A única coisa entre os dois é um atributo que o framework está checando explicitamente.

## Fontes

- [ASP.NET Core Blazor file downloads](https://learn.microsoft.com/en-us/aspnet/core/blazor/file-downloads) no Microsoft Learn, pelas receitas baseadas em interop que este post substitui
- [ASP.NET Core Blazor forms overview](https://learn.microsoft.com/en-us/aspnet/core/blazor/forms/) pelo componente `AntiforgeryToken`, o tratamento aprimorado de formulários e o middleware CSRF automático do .NET 11
- [Breaking change: IFormFile parameters require anti-forgery checks](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/8/antiforgery-checks) pelo motivo de o binding `[FromForm]` precisar de um token
- [Deprecations and removals in Chrome 65](https://developer.chrome.com/blog/chrome-65-deprecations) pela restrição cross-origin do atributo `download`
- Comportamento confirmado contra um app `dotnet new blazor -int Auto` em ASP.NET Core 10.0.5, inspecionando `blazor.web.js`, os cabeçalhos de resposta e o console do navegador
