---
title: "Como criar e extrair arquivos ZIP de forma assíncrona com as APIs async do ZipArchive no .NET 11"
description: "Use ZipFile.CreateFromDirectoryAsync, ExtractToDirectoryAsync, ZipArchive.CreateAsync e ZipArchiveEntry.OpenAsync sem I/O síncrono escondido. Medido no .NET 11 RC 1 e no .NET 10.0.12, incluindo o bug do .NET 10 que ainda bloqueia o Kestrel."
pubDate: 2026-09-14
template: how-to
tags:
  - "dotnet-11"
  - "dotnet"
  - "csharp"
  - "aspnetcore"
  - "async"
lang: "pt-br"
translationOf: "2026/09/how-to-create-and-extract-zip-files-asynchronously-with-ziparchive-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-09-14
---

**Resposta curta:** para pastas inteiras, chame `await ZipFile.CreateFromDirectoryAsync(dir, zipPathOrStream, ct)` e `await ZipFile.ExtractToDirectoryAsync(zipPathOrStream, dir, ct)`. Para controlar cada entrada, abra o arquivo ZIP com `await ZipArchive.CreateAsync(stream, mode, leaveOpen, entryNameEncoding: null, ct)` em vez do construtor, abra as entradas com `await entry.OpenAsync(ct)` e descarte tanto o stream da entrada quanto o arquivo ZIP com `await using`. Pule qualquer um desses três `await`s e o `System.IO.Compression` volta silenciosamente para I/O síncrono. As APIs assíncronas chegaram no .NET 10, mas o .NET 10 (o que ainda vale no 10.0.12) faz escritas síncronas quando o stream de uma entrada é descartado, mesmo com `await using`. Só o .NET 11 (medido no RC 1, `11.0.0-rc.1.26425.128`) é assíncrono de ponta a ponta.

Tudo o que vem abaixo foi executado em um Apple M4 com dois runtimes: .NET 10.0.12 (a versão de manutenção atual, compilada com o SDK 10.0.302) e .NET 11 RC 1. Os testes envolvem o stream de destino em um `Stream` que lança exceção em todo `Read`, `Write` e `Flush` síncrono. É o mesmo contrato que o Kestrel impõe aos corpos de requisição e resposta, então qualquer chamada síncrona escondida aparece como exceção, e não como uma thread bloqueada que você nunca percebe.

## A superfície assíncrona, e por que não existe construtor assíncrono

A API veio do [dotnet/runtime#1541](https://github.com/dotnet/runtime/issues/1541), um pedido aberto ainda na época do corefx, e foi implementada no [PR #114421](https://github.com/dotnet/runtime/pull/114421) para o .NET 10. O [formato aprovado](https://github.com/dotnet/runtime/issues/1541#issuecomment-2715269236) é menor que a proposta original, e o raciocínio explica a maioria das armadilhas:

- O construtor de `ZipArchive` faz I/O (no modo de leitura ele lê o registro end-of-central-directory), e construtores não podem ser aguardados. Por isso existe uma factory estática `ZipArchive.CreateAsync`.
- Não existe `GetEntriesAsync`. `CreateAsync` deveria ler o diretório central antes de retornar, então a propriedade síncrona `Entries` só devolve o que já está em memória.
- Não existe `CreateEntryAsync` nem `DeleteAsync`, porque `CreateEntry` e `Delete` não fazem I/O.
- `ZipArchive` implementa `IAsyncDisposable`, porque descartar um arquivo ZIP gravável escreve o diretório central.

Veja como as chamadas síncronas correspondem às versões assíncronas (todas aceitam um `CancellationToken` opcional):

| Síncrono | Assíncrono (.NET 10+) |
| --- | --- |
| `new ZipArchive(stream, mode, ...)` | `ZipArchive.CreateAsync(stream, mode, leaveOpen, entryNameEncoding, ct)` |
| `archive.Dispose()` | `archive.DisposeAsync()` |
| `entry.Open()` | `entry.OpenAsync(ct)` |
| `ZipFile.Open` / `OpenRead` | `ZipFile.OpenAsync` / `OpenReadAsync` |
| `ZipFile.CreateFromDirectory` | `ZipFile.CreateFromDirectoryAsync` (destino como caminho ou `Stream`) |
| `ZipFile.ExtractToDirectory` | `ZipFile.ExtractToDirectoryAsync` (origem como caminho ou `Stream`) |
| `archive.CreateEntryFromFile` | `archive.CreateEntryFromFileAsync` |
| `archive.ExtractToDirectory` | `archive.ExtractToDirectoryAsync` |
| `entry.ExtractToFile` | `entry.ExtractToFileAsync` |

O .NET 11 adiciona mais sobrecargas em cima disso: `OpenAsync(ReadOnlySpan<char> password, ...)`, `OpenAsync(FileAccess, ...)`, `CreateEntryFromFileAsync` com senha e `ZipEncryptionMethod`, e sobrecargas com `ZipFileCreationOptions` / `ZipExtractionOptions` para os helpers de diretório. Listei todas elas via reflection sobre `System.IO.Compression` nos dois runtimes. A parte de senhas está coberta no [post sobre ZIPs criptografados no .NET 11](/pt-br/2026/08/dotnet-11-preview-7-password-protected-zip-archives/).

## Passos para ficar totalmente assíncrono

1. Use os helpers de diretório `ZipFile.*Async` quando você não precisa de controle por entrada.
2. Caso contrário, crie o arquivo ZIP com `await ZipArchive.CreateAsync(...)` ou `await ZipFile.OpenAsync(...)`, nunca com `new ZipArchive(...)`.
3. Abra cada entrada com `await entry.OpenAsync(ct)`, ou use `CreateEntryFromFileAsync` / `ExtractToFileAsync`.
4. Descarte o stream de cada entrada com `await using`, antes de o arquivo ZIP ser descartado.
5. Descarte o arquivo ZIP com `await using`.
6. Passe um único `CancellationToken` por tudo isso e decida o que uma extração cancelada deve deixar no disco.

## Compactando e descompactando uma pasta inteira

Quando o arquivo ZIP deve espelhar um diretório, os helpers estáticos fazem tudo:

```csharp
// .NET 10+, C# 14 (tested on .NET 11 RC 1 and .NET 10.0.12)
using System.IO.Compression;

using var cts = new CancellationTokenSource(TimeSpan.FromMinutes(2));

// Folder -> .zip file
await ZipFile.CreateFromDirectoryAsync(
    "out/reports", "reports.zip",
    CompressionLevel.Optimal, includeBaseDirectory: false,
    cancellationToken: cts.Token);

// .zip file -> folder
await ZipFile.ExtractToDirectoryAsync(
    "reports.zip", "in/reports",
    overwriteFiles: true, cancellationToken: cts.Token);
```

Os dois helpers também têm sobrecargas com `Stream`, e é assim que você compacta direto para um stream de rede ou descompacta um upload sem arquivo temporário. [O post do .NET 8 sobre arquivos ZIP para Stream](/pt-br/2023/11/c-zip-files-to-stream/) apresentou as sobrecargas síncronas com `Stream`, e as versões assíncronas têm o mesmo formato, mais um token.

## Montando um arquivo ZIP entrada por entrada

Assim que você precisa filtrar, renomear ou gerar conteúdo, desça para `ZipArchive`. Os três `await`s importam aqui:

```csharp
// .NET 11 RC 1, C# 14
using System.IO.Compression;
using System.Text;

static async Task WriteExportAsync(Stream destination, IEnumerable<string> files, CancellationToken ct)
{
    await using ZipArchive zip = await ZipArchive.CreateAsync(
        destination, ZipArchiveMode.Create, leaveOpen: true, entryNameEncoding: null, ct);

    // Files from disk, renamed and filtered
    foreach (string path in files.Where(f => !f.EndsWith(".tmp")))
    {
        await zip.CreateEntryFromFileAsync(
            path, $"data/{Path.GetFileName(path)}", CompressionLevel.Fastest, ct);
    }

    // Generated content
    ZipArchiveEntry manifest = zip.CreateEntry("manifest.txt", CompressionLevel.Optimal);
    await using (Stream s = await manifest.OpenAsync(ct))
    {
        await s.WriteAsync(Encoding.UTF8.GetBytes($"created={DateTime.UtcNow:O}\n"), ct);
    }
}
```

Coloque o stream da entrada no seu próprio bloco `await using`, como acima, para que ele seja descartado antes de a próxima entrada ser criada. No modo `Create` só uma entrada pode estar aberta por vez, e descartar o stream da entrada faz o flush do último bloco comprimido e escreve os tamanhos e o CRC da entrada.

A leitura funciona do mesmo jeito. `Entries` é uma propriedade comum e, no .NET 11, não faz mais I/O depois de `CreateAsync`:

```csharp
// .NET 11 RC 1, C# 14
await using ZipArchive zip = await ZipFile.OpenReadAsync("reports.zip", ct);

foreach (ZipArchiveEntry entry in zip.Entries)
{
    if (entry.FullName.EndsWith('/')) continue; // directory entry

    await using Stream source = await entry.OpenAsync(ct);
    await using FileStream target = new(
        Path.Combine("in", entry.Name), FileMode.Create, FileAccess.Write,
        FileShare.None, bufferSize: 81920, FileOptions.Asynchronous);
    await source.CopyToAsync(target, ct);
}
```

Se você mesmo escreve caminhos a partir de `entry.FullName`, também assume a validação de caminhos que `ExtractToDirectoryAsync` faz por você. O helper recusa entradas que cairiam fora do diretório de destino, enquanto código feito à mão faz o que `Path.Combine` mandar.

## O que cada `await` realmente oferece, medido

Esta é a matriz de testes. "lança exceção" significa que o código do ZIP fez pelo menos uma chamada síncrona em um stream que as proíbe. Os streams não têm suporte a seek, a menos que a linha diga o contrário, como o corpo de uma requisição no Kestrel.

| Cenário | .NET 10.0.12 | .NET 11 RC 1 |
| --- | --- | --- |
| `new ZipArchive` (Create) + `Open()` + `using` | lança exceção | lança exceção |
| `CreateAsync` + `OpenAsync` + `await using` em tudo | **lança exceção** | funciona |
| Igual, mas `using` no arquivo ZIP | lança exceção | lança exceção |
| Igual, mas `using` no stream da entrada | lança exceção | lança exceção |
| `ZipFile.CreateFromDirectoryAsync(dir, stream)` | **lança exceção** | funciona |
| `new ZipArchive` (Read) | lança exceção | lança exceção |
| `CreateAsync` (Read) | funciona | funciona |
| `CreateAsync` (Read), stream com seek | **lança exceção** | funciona |
| `CreateAsync` (Read), com seek, `entry.Open()` síncrono | lança exceção | lança exceção |
| `ZipFile.ExtractToDirectoryAsync(stream, dir)` | funciona | funciona |
| `CreateAsync` (Update) em um stream sem seek | `ArgumentException` | `ArgumentException` |

Duas conclusões. Primeiro, as linhas que lançam exceção no .NET 11 são todas casos em que você deixou uma chamada síncrona: o construtor, `Open()` no modo de leitura ou um `using` simples. `Dispose()` precisa fazer o flush dos dados comprimidos e escrever o diretório central, e não consegue fazer isso de forma assíncrona. Segundo, as linhas em negrito são bugs do .NET 10, não erros seus.

## O bug do .NET 10: `await using` ainda escreve de forma síncrona

No .NET 10, o `WrappedStream` interno que `OpenAsync` retorna no modo de criação não sobrescreve `DisposeAsync`. O `Stream.DisposeAsync` base chama `Dispose()`, então toda a cadeia abaixo é descartada de forma síncrona e o `DeflateStream` faz o flush do último bloco com um `Write` síncrono. A stack trace do meu teste no .NET 10.0.12:

```text
at System.IO.Compression.DeflateStream.PurgeBuffers(Boolean disposing)
at System.IO.Compression.DeflateStream.Dispose(Boolean disposing)
at System.IO.Compression.CheckSumAndSizeWriteStream.Dispose(Boolean disposing)
at System.IO.Compression.ZipArchiveEntry.DirectToArchiveWriterStream.Dispose(Boolean disposing)
at System.IO.Compression.WrappedStream.Dispose(Boolean disposing)
```

O bug do lado da leitura é parecido: em um stream com seek, o `CreateAsync` do .NET 10 lê só o registro end-of-central-directory e deixa o diretório central para o primeiro acesso a `Entries`, que executa `ReadCentralDirectory()` de forma síncrona. Streams sem seek escapam desse bug por acidente, porque `CreateAsync` primeiro os copia para um `MemoryStream` com leituras assíncronas.

Os dois foram reportados como [dotnet/runtime#121624](https://github.com/dotnet/runtime/issues/121624) ("Asynchronous Zip Methods still have synchronous calls") e corrigidos no [PR #121938](https://github.com/dotnet/runtime/pull/121938), mesclado em 2025-12-01 com o milestone 11.0.0. A correção tem 18 linhas: um `DisposeAsync` de verdade em `WrappedStream`, mais um `EnsureCentralDirectoryReadAsync` antecipado em `CreateAsync` para o modo de leitura. Não há backport para `release/10.0`. As versões de manutenção do .NET 10 até a 10.0.12 ainda falham, e reproduzi isso na 10.0.10 e na 10.0.12.

Com um `FileStream` você nunca perceberia, porque uma escrita síncrona só bloqueia uma thread do thread pool por um instante. O Kestrel é diferente.

## Transmitindo um ZIP a partir de um endpoint do ASP.NET Core

Este é o caso que realmente importa para a maioria das pessoas: montar o arquivo ZIP direto em `Response.Body`, sem arquivo temporário e sem `MemoryStream`.

```csharp
// .NET 11 RC 1, ASP.NET Core 11 minimal API
using System.IO.Compression;

app.MapGet("/export", async (HttpContext ctx, CancellationToken ct) =>
{
    ctx.Response.ContentType = "application/zip";
    ctx.Response.Headers.ContentDisposition = "attachment; filename=\"export.zip\"";

    await using ZipArchive zip = await ZipArchive.CreateAsync(
        ctx.Response.Body, ZipArchiveMode.Create, leaveOpen: true, entryNameEncoding: null, ct);

    foreach (string file in Directory.EnumerateFiles(exportFolder))
        await zip.CreateEntryFromFileAsync(file, Path.GetFileName(file), CompressionLevel.Fastest, ct);
});
```

Executei isso com uma pasta de 100 arquivos (64 KB cada) nos dois runtimes:

- **.NET 11 RC 1:** `200`, 3.499.034 bytes, e `unzip -l` lista todos os 100 arquivos.
- **.NET 10.0.10:** `200`, **130 bytes**. O cabeçalho local da primeira entrada foi enviado, depois `DisposeAsync` bateu na escrita síncrona, o Kestrel registrou `InvalidOperationException: Synchronous operations are disallowed. Call WriteAsync or set AllowSynchronousIO to true instead.` e a conexão foi cortada. `unzip -t` reporta `invalid compressed data to inflate`.

Esse segundo resultado é o perigoso. O código de status já tinha sido enviado, então o cliente vê um download bem-sucedido de um arquivo corrompido. O mesmo endpoint escrito com `new ZipArchive(...)` falha nos dois runtimes, mas pelo menos falha com um `500`, antes de qualquer byte ser escrito. Para mais sobre essa exceção, veja [como corrigir "Synchronous operations are disallowed"](/pt-br/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed/).

Se você está preso ao .NET 10, monte o arquivo ZIP em um arquivo temporário assíncrono e depois copie para a resposta:

```csharp
// .NET 10 workaround (verified on 10.0.10): the ZIP code does sync I/O against the temp file, never against Kestrel
app.MapGet("/export", async (HttpContext ctx, CancellationToken ct) =>
{
    await using var tmp = new FileStream(Path.GetTempFileName(), FileMode.Create, FileAccess.ReadWrite,
        FileShare.None, bufferSize: 81920, FileOptions.Asynchronous | FileOptions.DeleteOnClose);

    await using (ZipArchive zip = await ZipArchive.CreateAsync(tmp, ZipArchiveMode.Create, leaveOpen: true, entryNameEncoding: null, ct))
    {
        foreach (string file in Directory.EnumerateFiles(exportFolder))
            await zip.CreateEntryFromFileAsync(file, Path.GetFileName(file), CompressionLevel.Fastest, ct);
    }

    tmp.Position = 0;
    ctx.Response.ContentType = "application/zip";
    ctx.Response.ContentLength = tmp.Length;
    await tmp.CopyToAsync(ctx.Response.Body, ct);
});
```

Isso retornou um arquivo ZIP válido de 3,5 MB no .NET 10.0.10, e você ainda ganha um `Content-Length` de verdade. A alternativa, definir `IHttpBodyControlFeature.AllowSynchronousIO = true` para a requisição, funciona, mas bloqueia uma thread por download. Para mais sobre manter respostas grandes fora do heap, veja [transmitir um arquivo a partir de um endpoint do ASP.NET Core sem buffering](/pt-br/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/).

## Extraindo um ZIP enviado no corpo da requisição

A outra direção funciona nos dois runtimes, porque o corpo da requisição não tem suporte a seek:

```csharp
// .NET 10+ (tested on 10.0.10 and 11 RC 1)
app.MapPost("/import", async (HttpRequest req, CancellationToken ct) =>
{
    await using ZipArchive zip = await ZipArchive.CreateAsync(
        req.Body, ZipArchiveMode.Read, leaveOpen: false, entryNameEncoding: null, ct);

    long total = 0;
    foreach (ZipArchiveEntry entry in zip.Entries)
    {
        await using Stream s = await entry.OpenAsync(ct);
        var buffer = new byte[81920];
        int read;
        while ((read = await s.ReadAsync(buffer, ct)) > 0) total += read;
    }
    return Results.Ok(new { entries = zip.Entries.Count, bytes = total });
});
```

Enviar o arquivo ZIP de 100 arquivos retornou `{"entries":100,"bytes":6553600}`, enquanto a versão com `new ZipArchive(req.Body, ZipArchiveMode.Read)` retornou `500` com a variante `ReadAsync` da mesma exceção. Há um porém: o índice de um ZIP fica no fim do arquivo, então o modo de leitura sobre um stream sem seek primeiro copia **o arquivo ZIP inteiro para a memória**. Meu arquivo de teste de 32 MB precisou de 253 leituras assíncronas antes de a primeira entrada ficar disponível. Para uploads grandes, transmita o corpo primeiro para um arquivo temporário com `FileOptions.Asynchronous` (e confira seus [limites de tamanho de requisição](/pt-br/2026/07/fix-413-request-entity-too-large-uploading-a-file-in-aspnetcore-11/)), e depois abra esse arquivo. Só lembre que, no .NET 10, uma origem com seek traz de volta a leitura síncrona de `Entries`.

## Armadilhas que vale conhecer antes de publicar

**O cancelamento deixa um diretório extraído pela metade.** Cancelei `ExtractToDirectoryAsync` em um arquivo ZIP de 1.000 entradas depois de 20 ms. Ele lançou `OperationCanceledException` com 129 arquivos no disco, um deles truncado (no .NET 10.0.12 foram 181 arquivos). Uma segunda chamada sem `overwriteFiles: true` então falha com `IOException: The file '.../f539.bin' already exists.` Se a saída parcial importa, extraia para um diretório temporário irmão e use `Directory.Move` para colocá-lo no lugar só depois que a tarefa terminar. Como o token flui está coberto em [propagar um CancellationToken por métodos assíncronos](/pt-br/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/).

**Assíncrono não é mais rápido.** Ele libera threads enquanto espera I/O, e é só isso. Compactando 1.000 arquivos (64 MB) e extraindo o resultado, mediana de 7 execuções com `Stopwatch` em SSD local (não é uma execução do BenchmarkDotNet):

| Operação | .NET 11 RC 1 síncrono | .NET 11 RC 1 assíncrono | .NET 10.0.12 síncrono | .NET 10.0.12 assíncrono |
| --- | --- | --- | --- | --- |
| `CreateFromDirectory` | 249 ms | 268 ms | 252 ms | 259 ms |
| `ExtractToDirectory` | 103 ms | 108 ms | 84 ms | 101 ms |

Compressão é trabalho de CPU, e I/O de arquivo assíncrono em um disco local rápido adiciona um pouco de overhead. Use as APIs assíncronas em servidores e threads de UI, onde uma thread bloqueada custa alguma coisa. Uma ferramenta de console que compacta a saída de um build não ganha nada com elas.

**O modo Update continua sendo um caso especial.** `ZipArchiveMode.Update` exige um stream que consiga ler, escrever e fazer seek (`ArgumentException: Update mode requires a stream with read, write, and seek capabilities.`), e carrega as entradas na memória conforme você as abre. Ele funciona com `CreateAsync` e `await using` em um stream com seek, mas para arquivos ZIP grandes costuma sair mais barato escrever um arquivo ZIP novo.

**`Open()` síncrono nem sempre é inofensivo.** No .NET 11, um `entry.Open()` síncrono no modo de criação funcionou por acaso no meu teste, porque abrir uma entrada nova não faz I/O. No modo de leitura ele lança exceção contra um stream sem operações síncronas nos dois runtimes. Use `OpenAsync` em todo lugar e pare de ficar controlando isso.

**Vai implementar `IAsyncDisposable` você mesmo?** O bug do .NET 10 é um exemplo clássico de um wrapper que esqueceu de repassar `DisposeAsync`. [Implementando e consumindo IAsyncDisposable](/pt-br/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/) mostra como fazer isso direito.

### Leia a seguir

- [Correção: InvalidOperationException: Synchronous operations are disallowed no ASP.NET Core](/pt-br/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed/)
- [Como transmitir um arquivo a partir de um endpoint do ASP.NET Core sem buffering](/pt-br/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/)
- [System.IO.Compression lê e escreve ZIPs criptografados no .NET 11](/pt-br/2026/08/dotnet-11-preview-7-password-protected-zip-archives/)
- [Como implementar e consumir IAsyncDisposable com await using em C#](/pt-br/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/)

### Fontes

- [dotnet/runtime#1541: Add async ZipFile APIs](https://github.com/dotnet/runtime/issues/1541) e o [formato de API aprovado](https://github.com/dotnet/runtime/issues/1541#issuecomment-2715269236)
- [dotnet/runtime PR #114421: Zip async implementation](https://github.com/dotnet/runtime/pull/114421)
- [dotnet/runtime#121624: Asynchronous Zip Methods still have synchronous calls](https://github.com/dotnet/runtime/issues/121624)
- [dotnet/runtime PR #121938: Fix async ZipArchive calling non-async Stream methods](https://github.com/dotnet/runtime/pull/121938)
- [ZipArchive.CreateAsync no Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.compression.ziparchive.createasync)
- [ZipFile.ExtractToDirectoryAsync no Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.compression.zipfile.extracttodirectoryasync)
