---
title: "Como transmitir um arquivo de um endpoint ASP.NET Core sem buffering"
description: "Sirva arquivos grandes do ASP.NET Core 11 sem carrega-los na memoria. Tres niveis: PhysicalFileResult para arquivos em disco, Results.Stream para streams arbitrarios e Response.BodyWriter para conteudo gerado -- com codigo para cada caso."
pubDate: 2026-04-24
tags:
  - "ASP.NET Core"
  - "dotnet"
  - ".NET 11"
  - "Performance"
  - "Streaming"
lang: "pt-br"
translationOf: "2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering"
translatedBy: "claude"
translationDate: 2026-04-24
---

Use `PhysicalFileResult` (ou `Results.File(path, contentType)` em minimal APIs) para arquivos ja em disco -- o Kestrel chama a syscall `sendfile` do sistema operacional internamente, portanto os bytes do arquivo nunca tocam a memoria gerenciada. Para streams que nao existem em disco -- Azure Blob, um objeto S3, um arquivo gerado dinamicamente -- retorne um `FileStreamResult` ou `Results.Stream(factory, contentType)` e abra o `Stream` subjacente de forma lazy dentro do delegate factory. Para conteudo totalmente gerado, escreva diretamente em `HttpContext.Response.BodyWriter`. Nos tres casos, o padrao que silenciosamente mata a escalabilidade e copiar o conteudo para um `MemoryStream` primeiro: isso carrega todo o payload no heap gerenciado, geralmente no Large Object Heap, antes que um unico byte chegue ao cliente.

Este artigo e voltado para .NET 11 e ASP.NET Core 11 (preview 3). Tudo nos niveis 1 e 2 funciona desde .NET 6; a abordagem com `BodyWriter` se tornou ergonomica com as APIs estaveis de `System.IO.Pipelines` no .NET 5 e nao mudou desde entao.

## Por que o buffering de resposta e diferente do que voce imagina

Quando as pessoas dizem "transmitir um arquivo", normalmente querem dizer "nao leia tudo na memoria". Isso esta correto, mas ha uma segunda parte: tambem nao armazene a resposta em buffer. O middleware de cache de saida e compressao de resposta do ASP.NET Core pode reintroduzir o buffering de forma transparente. Se voce usa `AddResponseCompression` e nao o ajustou, arquivos pequenos (abaixo do limite padrao de 256 bytes) nunca sao comprimidos, mas arquivos grandes sao totalmente armazenados em um `MemoryStream` antes que os bytes comprimidos sejam escritos. A solucao para arquivos grandes e comprimir na camada do CDN ou configurar `MimeTypes` no `ResponseCompressionOptions` de forma conservadora e excluir tipos de conteudo binario da compressao.

O buffering de resposta tambem ocorre dentro do framework quando voce retorna um `IResult` ou `ActionResult` de uma action de controller: o framework escreve o status e os cabecalhos primeiro, depois chama `ExecuteAsync` no resultado, que e onde a transferencia real de bytes ocorre. No .NET 6, `Results.File(path, ...)` chamava `PhysicalFileResultExecutor.WriteFileAsync`, que delegava para `IHttpSendFileFeature.SendFileAsync` -- o caminho sem copia. No .NET 7, uma refatoracao introduziu uma regressao onde `Results.File` envolvia o `FileStream` em um `StreamPipeWriter`, contornando `IHttpSendFileFeature` e fazendo o kernel copiar paginas de arquivo para o espaco do usuario desnecessariamente (rastreado como [issue #45037](https://github.com/dotnet/aspnetcore/issues/45037)). Essa regressao foi corrigida, mas ilustra que o tipo de resultado "correto" importa para o desempenho, nao apenas para a corretude.

## Nivel 1: Arquivos ja em disco

Para arquivos em disco, o tipo de retorno correto e `PhysicalFileResult` em controllers MVC, ou `Results.File(physicalPath, contentType)` em minimal APIs. Ambos recebem uma string de caminho fisico em vez de um `Stream`, o que permite ao executor verificar se `IHttpSendFileFeature` esta disponivel no transporte atual. O Kestrel no Linux expoe esse recurso e usa `sendfile(2)` -- os bytes vao do cache de paginas do sistema operacional diretamente para o buffer do socket sem nunca serem copiados para o processo .NET. No Windows, o Kestrel usa `TransmitFile` por meio de uma porta de conclusao de I/O com o mesmo efeito.

```csharp
// .NET 11, ASP.NET Core 11
// Minimal API
app.MapGet("/downloads/{filename}", (string filename, IWebHostEnvironment env) =>
{
    string physicalPath = Path.Combine(env.ContentRootPath, "downloads", filename);

    if (!File.Exists(physicalPath))
        return Results.NotFound();

    return Results.File(
        physicalPath,
        contentType: "application/octet-stream",
        fileDownloadName: filename,
        enableRangeProcessing: true);
});
```

```csharp
// .NET 11, ASP.NET Core 11
// MVC controller
[HttpGet("downloads/{filename}")]
public IActionResult Download(string filename)
{
    string physicalPath = Path.Combine(_env.ContentRootPath, "downloads", filename);

    if (!System.IO.File.Exists(physicalPath))
        return NotFound();

    return PhysicalFile(
        physicalPath,
        "application/octet-stream",
        fileDownloadName: filename,
        enableRangeProcessing: true);
}
```

Duas notas sobre o caminho. Primeiro, nao passe nomes de arquivo fornecidos pelo usuario diretamente para `Path.Combine` sem sanitiza-los. O codigo acima e um esqueleto: valide que o caminho resolvido ainda esta dentro do diretorio permitido antes de chamar `File.Exists`. Segundo, `IWebHostEnvironment.ContentRootPath` se resolve para o diretorio de trabalho do app, nao para `wwwroot`. Para assets estaticos publicos, o middleware de arquivos estaticos com `app.UseStaticFiles()` ja lida com requisicoes de range e ETags, e voce deve preferi-lo a um endpoint manual para arquivos em `wwwroot`.

## Nivel 2: Transmissao a partir de um Stream arbitrario

O objeto S3, o Azure Blob, a coluna `varbinary(max)` do banco de dados -- todos retornam um `Stream` que nao tem um caminho correspondente em disco, portanto `PhysicalFileResult` nao se aplica. O tipo correto aqui e `FileStreamResult` em controllers, ou `Results.Stream` em minimal APIs.

O detalhe critico e abrir o `Stream` de forma lazy. `Results.Stream` aceita uma sobrecarga de factory `Func<Stream>`; use-a para que o stream nao seja aberto ate depois que os cabecalhos de resposta sejam escritos e a conexao seja confirmada como ativa. Se o factory lancar uma excecao (por exemplo, porque o blob nao existe mais), o framework ainda pode retornar um 404 antes que os cabecalhos sejam confirmados.

```csharp
// .NET 11, ASP.NET Core 11
// Minimal API -- transmissao do Azure Blob Storage
app.MapGet("/blobs/{blobName}", async (
    string blobName,
    BlobServiceClient blobService,
    CancellationToken ct) =>
{
    var container = blobService.GetBlobContainerClient("exports");
    var blob = container.GetBlobClient(blobName);

    if (!await blob.ExistsAsync(ct))
        return Results.NotFound();

    BlobProperties props = await blob.GetPropertiesAsync(cancellationToken: ct);

    return Results.Stream(
        streamWriterCallback: async responseStream =>
        {
            await blob.DownloadToAsync(responseStream, ct);
        },
        contentType: props.ContentType,
        fileDownloadName: blobName,
        lastModified: props.LastModified,
        enableRangeProcessing: false); // Azure lida com ranges na origem; desabilitar processamento duplo
});
```

`Results.Stream` tem duas sobrecargas: uma recebe um `Stream` diretamente, a outra recebe um callback `Func<Stream, Task>` (mostrado acima). Prefira a forma de callback quando a fonte e um stream de rede, pois ela adia o I/O ate que o framework esteja pronto para escrever o corpo da resposta. O callback recebe o `Stream` do corpo da resposta como argumento; escreva seus dados de origem nele.

Para controllers, `FileStreamResult` requer que voce passe o stream diretamente. Abra-o o mais tarde possivel no metodo de action, e use `FileOptions.Asynchronous | FileOptions.SequentialScan` ao abrir instancias de `FileStream` para evitar bloquear o thread pool:

```csharp
// .NET 11, ASP.NET Core 11
// MVC controller -- transmissao do sistema de arquivos local via FileStreamResult
[HttpGet("exports/{id}")]
public async Task<IActionResult> GetExport(Guid id, CancellationToken ct)
{
    string? path = await _exportService.GetPathAsync(id, ct);

    if (path is null)
        return NotFound();

    var fs = new FileStream(
        path,
        new FileStreamOptions
        {
            Mode    = FileMode.Open,
            Access  = FileAccess.Read,
            Share   = FileShare.Read,
            Options = FileOptions.Asynchronous | FileOptions.SequentialScan,
            BufferSize = 64 * 1024,
        });

    return new FileStreamResult(fs, "application/octet-stream")
    {
        FileDownloadName    = $"{id}.bin",
        EnableRangeProcessing = true,
    };
}
```

O framework descarta `fs` apos o envio da resposta. Voce nao precisa de um bloco `using` ao redor dele.

## Nivel 3: Escrita de conteudo gerado no pipe de resposta

As vezes o conteudo nao existe em nenhum lugar -- ele e gerado na hora: um relatorio renderizado em PDF, um CSV montado a partir de resultados de consultas, um ZIP criado a partir de arquivos selecionados. A abordagem ingenua e renderizar em um `MemoryStream` e retorna-lo como `FileStreamResult`. Isso funciona, mas todo o payload tem que estar na memoria antes que o cliente receba o primeiro byte. Para uma exportacao de 200 MB, isso e 200 MB no Large Object Heap por requisicao concorrente.

A abordagem correta e escrever diretamente em `HttpContext.Response.BodyWriter`, que e um `PipeWriter` respaldado por um pool de buffers de 4 KB. O framework despeja no socket de forma incremental; o uso de memoria e limitado pela janela em andamento, nao pelo tamanho do arquivo.

```csharp
// .NET 11, ASP.NET Core 11
// Minimal API -- transmissao de um relatorio CSV gerado
app.MapGet("/reports/{year:int}", async (
    int year,
    ReportService reports,
    HttpContext ctx,
    CancellationToken ct) =>
{
    ctx.Response.ContentType = "text/csv";
    ctx.Response.Headers.ContentDisposition = $"attachment; filename=\"report-{year}.csv\"";

    var writer = ctx.Response.BodyWriter;

    await writer.WriteAsync("id,date,amount\n"u8.ToArray(), ct);

    await foreach (ReportRow row in reports.GetRowsAsync(year, ct))
    {
        string line = $"{row.Id},{row.Date:yyyy-MM-dd},{row.Amount:F2}\n";
        await writer.WriteAsync(Encoding.UTF8.GetBytes(line), ct);
    }

    await writer.CompleteAsync();
    return Results.Empty;
});
```

Note o uso de `"id,date,amount\n"u8.ToArray()` -- um literal de string UTF-8 introduzido no C# 11, produzindo um `byte[]` sem alocacao. Para as linhas de registro, `Encoding.UTF8.GetBytes(line)` ainda aloca; para eliminar isso, solicite um buffer diretamente do writer:

```csharp
// .NET 11, C# 14 -- escrita sem alocacao usando PipeWriter.GetMemory
await foreach (ReportRow row in reports.GetRowsAsync(year, ct))
{
    string line = $"{row.Id},{row.Date:yyyy-MM-dd},{row.Amount:F2}\n";
    int byteCount = Encoding.UTF8.GetByteCount(line);
    Memory<byte> buffer = writer.GetMemory(byteCount);
    int written = Encoding.UTF8.GetBytes(line, buffer.Span);
    writer.Advance(written);
    await writer.FlushAsync(ct);
}
```

`GetMemory` / `Advance` / `FlushAsync` e o padrao canonico do `PipeWriter`. `FlushAsync` retorna um `FlushResult` que informa se o consumidor downstream cancelou ou completou (`FlushResult.IsCompleted`); em um cliente que se comporta corretamente isso raramente e verdade durante um download, mas verificar dentro do loop permite que voce saia antecipadamente se o cliente desconectar.

Como voce esta escrevendo o corpo da resposta diretamente, nao pode retornar um codigo de status apos a primeira chamada `FlushAsync` confirmar os cabecalhos. Defina `ctx.Response.StatusCode` antes de escrever qualquer byte. Se a sua chamada de servico pode falhar de uma forma que deva produzir um 500, verifique isso antes de tocar em `BodyWriter`.

Para a geracao de ZIP especificamente, o .NET 11 (por meio de `System.IO.Compression`) permite criar um `ZipArchive` que escreve em qualquer stream gravavel. Passe um `StreamWriter` que envolve `ctx.Response.Body` (nao `BodyWriter` diretamente, pois `ZipArchive` espera um `Stream`, nao um `PipeWriter`). A abordagem e coberta no artigo [C# ZIP files to Stream](/2023/11/c-zip-files-to-stream/), que usa a nova sobrecarga `CreateFromDirectory` adicionada no .NET 8. Da mesma forma, se a exportacao e comprimida com Zstandard, encadeie o stream de compressao antes do corpo da resposta -- o novo `ZstandardStream` integrado no [suporte de compressao Zstandard do .NET 11](/2026/04/dotnet-11-zstandard-compression-system-io/) evita uma dependencia de NuGet.

## Requisicoes de range: downloads retomados gratuitamente

`EnableRangeProcessing = true` em `FileStreamResult` ou `Results.File` instrui o ASP.NET Core a analisar os cabecalhos de requisicao `Range` e responder com `206 Partial Content`. O framework lida com tudo: analisar o cabecalho `Range`, buscar no stream (para streams buscaveis), definir os cabecalhos de resposta `Content-Range` e `Accept-Ranges`, e enviar apenas o intervalo de bytes solicitado.

Para `PhysicalFileResult`, o processamento de range sempre esta disponivel porque o framework controla o handle do arquivo. Para `FileStreamResult`, o processamento de range so funciona se `Stream.CanSeek` for `true`. Streams do Azure Blob retornados de `BlobClient.OpenReadAsync` sao buscaveis; streams brutos de `HttpResponseMessage.Content` geralmente nao sao. Se a busca nao estiver disponivel, defina `EnableRangeProcessing = false` (o padrao) e sirva sem suporte a range ou armazene em buffer o range relevante voce mesmo.

## Erros comuns que silenciosamente reintroduzem o buffering

**Retornar `byte[]` de uma action de controller.** O ASP.NET Core o envolve em um `FileContentResult`, que esta bem para arquivos pequenos mas e terrivel para arquivos grandes porque o array de bytes e alocado antes que o metodo de action retorne.

**Chamar `stream.ToArray()` ou `MemoryStream.GetBuffer()` em um stream de origem.** Ambos materializam o stream inteiro. Se voce se encontra fazendo isso antes de chamar `Results.Stream`, esta negando o streaming.

**Definir `Response.ContentLength` incorretamente.** Se `ContentLength` esta definido mas o stream produz menos bytes (porque voce abortou cedo), o Kestrel registrara um erro de conexao. Se for muito pequeno, o cliente parara de ler apos `ContentLength` bytes e pode considerar o download completo mesmo que ainda haja bytes. Para conteudo gerado dinamicamente onde o comprimento e desconhecido antecipadamente, omita `ContentLength` e deixe o cliente usar codificacao chunked.

**Esquecer a cancelacao.** Uma exportacao de 2 GB leva minutos. Conectar `CancellationToken` pelo loop de flush do `PipeWriter` permite ao servidor limpar imediatamente quando o cliente fecha a conexao. Consulte o artigo [como cancelar uma tarefa de longa duracao em C# sem deadlock](/pt-br/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) para os padroes de cancelamento que previnem deadlocks durante a desmontagem do stream.

**Usar `IAsyncEnumerable<byte[]>` de um controller.** O formatador JSON do ASP.NET Core tentara serializar os arrays de bytes como tokens JSON em Base64 em vez de escrevelos diretamente. Use `IAsyncEnumerable` apenas na camada de aplicacao para alimentar um loop de escrita de nivel inferior; nao o retorne diretamente como resultado da action para conteudo binario.

**Buffering de saida comprimida.** `AddResponseCompression` com as configuracoes padrao armazena toda a resposta em buffer para comprimi-la, o que desfaz tudo o que foi feito acima para tipos de conteudo de texto. Exclua seu tipo de conteudo de download da compressao, comprima a origem antes de transmitir (encadeie um `DeflateStream` ou `ZstandardStream` antes do pipe de resposta), ou pre-comprima no CDN.

## Escolhendo o nivel certo

Arquivo em disco com caminho conhecido: `Results.File(physicalPath, contentType, enableRangeProcessing: true)`.

Blob ou stream externo: `Results.Stream(callback, contentType)` ou `FileStreamResult` com um stream buscavel.

Conteudo gerado: escreva em `ctx.Response.BodyWriter`, defina os cabecalhos antes do primeiro `FlushAsync`, e passe `CancellationToken` pelo loop.

O fio condutor e manter o pipeline aberto e deixar os dados fluirem por ele. No momento em que voce armazena todo o payload em buffer, passou de um endpoint com memoria O(1) para um com memoria O(N), e sob carga concorrente esses valores de N se acumulam ate o processo morrer.

Pelo mesmo motivo pelo qual o streaming importa aqui, ele tambem importa ao ler entradas grandes: o artigo [como ler um CSV grande no .NET 11 sem ficar sem memoria](/pt-br/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) mostra a mesma troca do lado da ingestao.

## Fontes

- [FileStreamResult no MS Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.mvc.filestreamresult)
- [Results.Stream no MS Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.results.stream)
- [IHttpSendFileFeature.SendFileAsync no MS Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.features.ihttpsendfilefeature.sendfileasync)
- [System.IO.Pipelines no MS Learn](https://learn.microsoft.com/en-us/dotnet/standard/io/pipelines)
- [dotnet/aspnetcore issue #45037 -- regressao de Results.File no .NET 7](https://github.com/dotnet/aspnetcore/issues/45037)
- [dotnet/aspnetcore issue #55606 -- I/O excessivo no FileStreamResult](https://github.com/dotnet/aspnetcore/issues/55606)
- [Compressao de resposta no ASP.NET Core no MS Learn](https://learn.microsoft.com/en-us/aspnet/core/performance/response-compression)
