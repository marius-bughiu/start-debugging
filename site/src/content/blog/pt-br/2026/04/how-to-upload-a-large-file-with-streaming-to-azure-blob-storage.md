---
title: "Como fazer upload de um arquivo grande com streaming para o Azure Blob Storage"
description: "Faça upload de arquivos de vários GB para o Azure Blob Storage a partir do .NET 11 sem carregá-los na memória. BlockBlobClient.UploadAsync com StorageTransferOptions, MultipartReader para uploads em ASP.NET Core, e as armadilhas de buffering que jogam seu payload na LOH."
pubDate: 2026-04-28
tags:
  - "azure"
  - "dotnet"
  - "dotnet-11"
  - "aspnet-core"
  - "streaming"
lang: "pt-br"
translationOf: "2026/04/how-to-upload-a-large-file-with-streaming-to-azure-blob-storage"
translatedBy: "claude"
translationDate: 2026-04-28
---

Abra a origem como uma `Stream` e a passe direto para `BlockBlobClient.UploadAsync(Stream, BlobUploadOptions)` com `StorageTransferOptions` configurado. O SDK do Azure divide a stream em blocos de block-blob, faz o staging deles em paralelo e confirma a lista de blocos quando a stream termina. Você nunca aloca um `byte[]` maior que `MaximumTransferSize`, e a stream de origem é lida uma única vez, somente para frente. Os padrões que silenciosamente quebram isso são: copiar o corpo da requisição para uma `MemoryStream` "para saber o tamanho", chamar `IFormFile.OpenReadStream` depois que o ASP.NET Core já bufferizou o formulário em memória, e esquecer de configurar `MaximumConcurrency`, o que te deixa fazendo upload de 4 MiB por vez em uma única thread para um serviço que aceitaria com prazer vinte stagings de blocos em paralelo.

Este post tem como alvo `Azure.Storage.Blobs` 12.22+, .NET 11 e ASP.NET Core 11. Os limites do protocolo de block-blob usados aqui (4000 MiB por bloco, 50 000 blocos, ~190.7 TiB no total por blob) requerem a x-ms-version `2019-12-12` ou posterior, que o SDK negocia por padrão.

## O caminho de upload padrão já é streaming, mais ou menos

`BlobClient.UploadAsync(Stream)` faz a coisa certa para uma stream de tamanho desconhecido: lê até `InitialTransferSize` bytes e, se a stream terminou dentro dessa janela, emite uma única requisição `PUT Blob`. Caso contrário, alterna para uploads de blocos em staging, lendo `MaximumTransferSize` bytes por vez e chamando `PUT Block` em paralelo até `MaximumConcurrency`. Quando a stream de origem retorna 0 bytes, ele emite `PUT Block List` para confirmar a ordem.

Os valores padrão que vêm na 12.22 são `InitialTransferSize = 256 MiB`, `MaximumTransferSize = 8 MiB`, `MaximumConcurrency = 8`. Há duas coisas erradas em deixar isso intacto para uploads grandes. Primeiro, `InitialTransferSize = 256 MiB` significa que o SDK irá bufferizar até 256 MiB internamente antes de decidir se usa um único PUT, mesmo que você tenha passado uma stream de 50 GiB que obviamente não cabe. Segundo, `MaximumConcurrency = 8` está bom para um link de 1 Gbps a uma conta de armazenamento colocalizada, mas é um gargalo para uploads entre regiões em que cada round-trip de PUT custa 80-200 ms.

```csharp
// .NET 11, Azure.Storage.Blobs 12.22
var transferOptions = new StorageTransferOptions
{
    InitialTransferSize = 8 * 1024 * 1024,   // 8 MiB. Always go via block uploads for large files.
    MaximumTransferSize = 8 * 1024 * 1024,   // 8 MiB blocks. Sweet spot for most networks.
    MaximumConcurrency  = 16                  // Parallel PUT Block calls.
};

var uploadOptions = new BlobUploadOptions
{
    TransferOptions = transferOptions,
    HttpHeaders     = new BlobHttpHeaders { ContentType = "application/octet-stream" }
};

await using FileStream source = File.OpenRead(localPath);
await blobClient.UploadAsync(source, uploadOptions, cancellationToken);
```

Tamanhos de bloco entre 4 MiB e 16 MiB são o ponto ideal para contas Standard. Blocos menores desperdiçam round-trips na sobrecarga do `PUT Block`; blocos maiores tornam as retentativas caras porque um 503 transitório força o SDK a reenviar o bloco inteiro.

## Os limites de block-blob decidem o tamanho do bloco por você

Os block blobs do Azure têm limites rígidos que uma mentalidade de "só faz streaming" eventualmente vai bater. São 50 000 blocos por blob, cada bloco tem no máximo 4000 MiB, e o tamanho máximo do blob é 190.7 TiB (50 000 x 4000 MiB). Para um upload de 200 GiB, blocos de 4 MiB precisariam de 51 200 blocos, um acima do limite. Então:

- Até ~195 GiB: qualquer tamanho de bloco a partir de 4 MiB funciona.
- 195 GiB a ~390 GiB: mínimo de 8 MiB.
- 1 TiB: mínimo de 21 MiB. O padrão de 8 MiB do SDK falhará no meio do upload com `BlockCountExceedsLimit`.

O SDK não aumenta o tamanho do bloco para você. Se você conhece o tamanho da origem antecipadamente, calcule o tamanho de bloco necessário e configure `MaximumTransferSize` de acordo:

```csharp
// .NET 11
static long PickBlockSize(long contentLength)
{
    const long maxBlocks = 50_000;
    const long minBlock  = 4 * 1024 * 1024;          // 4 MiB
    const long maxBlock  = 4000L * 1024 * 1024;      // 4000 MiB

    long required = (contentLength + maxBlocks - 1) / maxBlocks;
    long rounded  = ((required + minBlock - 1) / minBlock) * minBlock;
    return Math.Clamp(rounded, minBlock, maxBlock);
}
```

Para uploads de tamanho desconhecido (um arquivo gerado, um fan-in do lado do servidor), use blocos de 16 MiB por padrão. Isso dá margem até ~780 GiB sem ter que aumentar o limite depois.

## ASP.NET Core: faça streaming do corpo da requisição, não do `IFormFile`

A forma mais comum de arruinar todo este pipeline é o `IFormFile`. Quando um upload multipart chega, o `FormReader` do ASP.NET Core lê o corpo inteiro para a coleção do formulário antes da sua action executar. Qualquer coisa abaixo de `FormOptions.MemoryBufferThreshold` (padrão de 64 KiB por valor de formulário, mas a parte do arquivo segue `MultipartBodyLengthLimit` de 128 MiB) vai para a memória; qualquer coisa acima vai para uma `Microsoft.AspNetCore.WebUtilities.FileBufferingReadStream`, que é um arquivo temporário em disco. De qualquer forma, quando o seu handler executa, o upload já foi lido uma vez e copiado para algum lugar. `IFormFile.OpenReadStream()` agora é uma `FileStream` sobre essa cópia temporária.

Isso mata três coisas de uma vez. Você paga I/O de disco por um buffer que não precisa. A requisição leva o dobro do tempo porque os bytes viajam do socket para o arquivo temporário, depois do arquivo temporário para o SDK e para o Azure. E `MultipartBodyLengthLimit` impõe um teto de 128 MiB em cada upload por padrão.

A correção é desabilitar o binding de formulário e ler a stream multipart você mesmo com `MultipartReader`:

```csharp
// .NET 11, ASP.NET Core 11
[HttpPost("upload")]
[DisableFormValueModelBinding]
[RequestSizeLimit(50L * 1024 * 1024 * 1024)]      // 50 GiB
[RequestFormLimits(MultipartBodyLengthLimit = 50L * 1024 * 1024 * 1024)]
public async Task<IActionResult> Upload(CancellationToken ct)
{
    if (!MediaTypeHeaderValue.TryParse(Request.ContentType, out var mediaType) ||
        !mediaType.MediaType.Equals("multipart/form-data", StringComparison.OrdinalIgnoreCase))
    {
        return BadRequest("Expected multipart/form-data.");
    }

    string boundary = HeaderUtilities.RemoveQuotes(mediaType.Boundary).Value!;
    var reader = new MultipartReader(boundary, Request.Body);

    MultipartSection? section;
    while ((section = await reader.ReadNextSectionAsync(ct)) != null)
    {
        var contentDisposition = section.GetContentDispositionHeader();
        if (contentDisposition is null || !contentDisposition.IsFileDisposition()) continue;

        string fileName = Path.GetFileName(contentDisposition.FileName.Value!);
        var blob = _container.GetBlockBlobClient(fileName);

        var options = new BlobUploadOptions
        {
            TransferOptions = new StorageTransferOptions
            {
                InitialTransferSize = 8 * 1024 * 1024,
                MaximumTransferSize = 16 * 1024 * 1024,
                MaximumConcurrency  = 16
            },
            HttpHeaders = new BlobHttpHeaders
            {
                ContentType = section.ContentType ?? "application/octet-stream"
            }
        };

        await blob.UploadAsync(section.Body, options, ct);
    }

    return Ok();
}
```

`section.Body` é uma stream baseada em rede que lê direto do corpo da requisição. O SDK do Azure lê dela, fatia em blocos e faz o upload. A memória fica limitada por `MaximumTransferSize * MaximumConcurrency` (256 MiB no exemplo acima). O atributo `[DisableFormValueModelBinding]` é um pequeno filter customizado que remove os value providers de formulário padrão do framework, para que o MVC não tente bindar o corpo antes da sua action executar:

```csharp
// .NET 11, ASP.NET Core 11
public class DisableFormValueModelBindingAttribute : Attribute, IResourceFilter
{
    public void OnResourceExecuting(ResourceExecutingContext context)
    {
        var factories = context.ValueProviderFactories;
        factories.RemoveType<FormValueProviderFactory>();
        factories.RemoveType<FormFileValueProviderFactory>();
        factories.RemoveType<JQueryFormValueProviderFactory>();
    }

    public void OnResourceExecuted(ResourceExecutedContext context) { }
}
```

`[RequestSizeLimit]` e `[RequestFormLimits]` são ambos necessários: o primeiro é o teto por requisição do corpo no Kestrel, o segundo é `FormOptions.MultipartBodyLengthLimit`. Esquecer qualquer um deles rejeita o upload em 30 MiB ou 128 MiB respectivamente, com um erro que não menciona multipart.

## Autenticação sem um SAS

`DefaultAzureCredential` do `Azure.Identity` é o padrão correto para qualquer serviço rodando no Azure (App Service, AKS, Functions, Container Apps). O contêiner precisa do papel `Storage Blob Data Contributor` na conta de armazenamento. Localmente, o mesmo código funciona contra `az login` ou a conta Azure do VS Code.

```csharp
// .NET 11, Azure.Identity 1.13+, Azure.Storage.Blobs 12.22+
var serviceUri = new Uri($"https://{accountName}.blob.core.windows.net");
var service    = new BlobServiceClient(serviceUri, new DefaultAzureCredential());
var container  = service.GetBlobContainerClient("uploads");
await container.CreateIfNotExistsAsync(cancellationToken: ct);

var blob = container.GetBlockBlobClient(blobName);
```

Evite armazenar connection strings com a chave da conta nas configurações do app. A chave autentica no nível da conta de armazenamento, o que significa que uma chave vazada dá acesso total a todos os contêineres e blobs, inclusive exclusão. Os mesmos caminhos de upload funcionam com `BlobSasBuilder` se um navegador faz upload direto sem passar pelo seu servidor.

## Progresso, retentativas e retomada

O SDK chama `IProgress<long>` depois de cada bloco. Use para UI, mas não para contabilidade: o valor é o total acumulado de bytes transferidos, incluindo bytes que foram retentados.

```csharp
// .NET 11
var progress = new Progress<long>(bytes =>
{
    Console.WriteLine($"{bytes:N0} bytes transferred");
});

var options = new BlobUploadOptions
{
    TransferOptions  = transferOptions,
    ProgressHandler  = progress
};
```

A camada de transporte retenta `PUT Block` automaticamente com backoff exponencial (`RetryOptions` por padrão são 3 retentativas, atraso inicial de 0.8 s). Para um upload de várias horas em uma rede instável, aumente `RetryOptions.MaxRetries` e `NetworkTimeout` em `BlobClientOptions` antes de construir o cliente:

```csharp
// .NET 11
var clientOptions = new BlobClientOptions
{
    Retry =
    {
        MaxRetries     = 10,
        Delay          = TimeSpan.FromSeconds(2),
        MaxDelay       = TimeSpan.FromSeconds(60),
        Mode           = RetryMode.Exponential,
        NetworkTimeout = TimeSpan.FromMinutes(10)
    }
};

var service = new BlobServiceClient(serviceUri, new DefaultAzureCredential(), clientOptions);
```

`UploadAsync` não é retomável entre reinícios de processo. Se o processo morre, os blocos em staging não confirmados ficam na conta de armazenamento por até sete dias e depois são coletados pelo garbage collection. Para retomar manualmente, use `BlockBlobClient.GetBlockListAsync(BlockListTypes.Uncommitted)` para descobrir o que foi feito staging, transmita a origem a partir desse offset e chame `CommitBlockListAsync` com a lista mesclada. A maioria dos apps não precisa disso; reiniciar o upload do byte 0 é mais simples e o paralelismo do SDK torna isso barato.

## CancellationToken: passe-o por toda parte

O `CancellationToken` que você entrega a `UploadAsync` é honrado em cada bloco em staging, mas apenas entre blocos. Um `PUT Block` único não é abortado em pleno voo; o SDK espera ele terminar (ou falhar) antes de observar o token. Para um bloco de 16 MiB em um link de 1 Gbps são ~130 ms, o que está bom. Em um link de 10 Mbps são 13 segundos. Se cancelamento rápido importa, baixe `MaximumTransferSize` para 4 MiB para que o pior caso de bloco em voo seja pequeno.

A mesma advertência se aplica se você configurar `NetworkTimeout` muito alto. `CancellationToken` não interrompe um socket travado: o timeout sim. Mantenha `NetworkTimeout` menor que sua latência de cancelamento aceitável. O padrão de cancelamento cooperativo é o mesmo coberto em detalhe em [cancelar uma Task de longa duração sem deadlock](/pt-br/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/): passe o token para baixo, deixe `OperationCanceledException` se propagar e limpe no `finally`.

## Verificando o upload

Para block blobs, o MD5 por bloco é verificado pelo serviço automaticamente quando você configura `TransactionalContentHash`, mas o SDK só configura isso para o caminho de PUT único, não para o caminho de blocos em staging. Para verificar a integridade fim-a-fim com uploads fatiados, configure o hash do blob inteiro em `BlobHttpHeaders.ContentHash`. O serviço armazena e devolve em `Get Blob Properties`, mas **não** valida no upload. Você precisa calcular no cliente e reverificar no download.

```csharp
// .NET 11
using var sha = SHA256.Create();
await using var hashed = new CryptoStream(source, sha, CryptoStreamMode.Read, leaveOpen: true);

await blob.UploadAsync(hashed, options, ct);

byte[] hash = sha.Hash!;
await blob.SetHttpHeadersAsync(new BlobHttpHeaders { ContentHash = hash }, cancellationToken: ct);
```

Envolver a origem em uma `CryptoStream` adiciona custo de CPU (~600 MB/s de SHA-256 em hardware moderno), mas é a única forma de calcular o hash sem bufferizar. Pule isso se o canal é HTTPS e você confia na integridade de transporte do Azure.

## Coisas que silenciosamente bufferizam

Mesmo com a chamada correta do SDK, três padrões irão ressuscitar o problema de memória que você estava tentando evitar:

1. `Stream.CopyToAsync(memoryStream)` "para inspecionar cabeçalhos". Não faça isso para nada maior que poucos MiB. Se você precisa dos primeiros bytes, leia em uma `Span<byte>` alocada em stack e `Stream.Position = 0` apenas se a stream suportar seek. A maioria das streams baseadas em rede não suporta, em cujo caso use uma pequena `BufferedStream`.
2. Logar o corpo da requisição. Middleware de captura de corpo do Serilog/NLog pode bufferizar o payload inteiro para torná-lo logável. Desabilite nas rotas de upload.
3. Retornar um `IActionResult` depois do upload configurando cabeçalhos de `Response.Body`. O formatter `ObjectResult` do framework pode serializar um objeto de status de volta em uma resposta bufferizada. Retorne `Results.Ok()` ou `NoContent()` depois de um upload com streaming, não um objeto grande.

A verificação de "isso é realmente streaming?" é observar o working set do processo durante um upload de 5 GiB. Com o SDK e `StorageTransferOptions` configurados como neste post, o working set deveria pairar em torno de `MaximumTransferSize * MaximumConcurrency + ~50 MiB` de sobrecarga. Qualquer coisa que cresça linearmente com o tamanho do upload é um bug em algum lugar do seu pipeline.

## Relacionados

- [Servir um arquivo de um endpoint ASP.NET Core sem buffering](/pt-br/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) cobre a imagem espelho do lado de download deste post.
- [Ler um CSV grande em .NET 11 sem ficar sem memória](/pt-br/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) percorre streaming com buffer limitado para parsing, que se compõe bem com o padrão de upload daqui quando você transforma a caminho do blob storage.
- [Cancelar uma Task de longa duração em C# sem deadlock](/pt-br/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) aprofunda a propagação de `CancellationToken`, que importa para qualquer upload de vários minutos.
- [Usar `IAsyncEnumerable<T>` com EF Core 11](/pt-br/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) para o caso de exportação com streaming em que linhas do EF Core alimentam direto um blob.

## Links de referência

- [Notas de release do Azure.Storage.Blobs 12.22](https://github.com/Azure/azure-sdk-for-net/blob/main/sdk/storage/Azure.Storage.Blobs/CHANGELOG.md)
- [Metas de escalabilidade de block blobs](https://learn.microsoft.com/en-us/rest/api/storageservices/scalability-targets-for-the-azure-blob-storage-service)
- [API REST Put Block](https://learn.microsoft.com/en-us/rest/api/storageservices/put-block)
- [Referência de `StorageTransferOptions`](https://learn.microsoft.com/en-us/dotnet/api/azure.storage.storagetransferoptions)
- [Guia de upload de arquivos grandes em ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/mvc/models/file-uploads)
