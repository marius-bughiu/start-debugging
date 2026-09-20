---
title: "Como manter consistentes uma gravação no banco de dados e um upload para o Azure Blob Storage em uma única requisição ASP.NET Core"
description: "Não existe transação que abranja SQL Server e Blob Storage. Faça o upload para um nome que o banco de dados já conhece, confirme depois, compense em caso de falha e deixe um faxineiro limpar a janela de crash. Com a sobrecarga de UploadAsync que silenciosamente transforma uma criação condicional em sobrescrita."
pubDate: 2026-09-20
template: how-to
tags:
  - "aspnet-core"
  - "aspnet-core-11"
  - "azure"
  - "blob-storage"
  - "ef-core-11"
  - "consistency"
  - "dotnet-11"
  - "how-to"
lang: "pt-br"
translationOf: "2026/09/how-to-keep-a-database-write-and-an-azure-blob-upload-consistent-in-one-request"
translatedBy: "claude"
translationDate: 2026-09-20
---

Resposta curta: você não consegue. Nenhuma transação abrange um banco de dados relacional e o Azure Blob Storage, então pare de tentar fazer os dois confirmarem juntos e torne a falha sobrevivível. Grave primeiro a linha no banco de dados, em sua própria transação confirmada, com status `Pending` e o nome do blob que você está prestes a usar; faça o upload exatamente para esse nome com uma criação condicional; depois vire a linha para `Ready` em uma segunda transação. Todo ponto de crash deixa ou uma linha sem blob ou um blob sem linha visível, ambos resolvíveis por um faxineiro, e nunca uma linha apontando para um blob que não existe. Deleções compensatórias em um bloco `catch` valem a pena, mas são uma otimização, não o argumento de correção.

Este post percorre as quatro ordenações entre as quais você pode escolher, o que cada uma deixa para trás quando falha, e os comportamentos do SDK do Azure que decidem se sua nova tentativa é idempotente ou destrutiva.

Uma nota sobre versões e verificação. Tudo abaixo foi executado no SDK do .NET 11 RC 1 (`11.0.100-rc.1.26425.128`) com `Azure.Storage.Blobs` 12.29.2 e `Microsoft.EntityFrameworkCore.Sqlite` 11.0.0-rc.1.26425.128. Não há assinatura do Azure nesta máquina, então as chamadas de armazenamento rodam contra o emulador Azurite 3.37.0, que implementa a Blob REST API localmente. Onde o emulador e o serviço de produção poderiam plausivelmente divergir, eu digo isso e cito a referência REST. O lado do banco de dados usa SQLite com um índice único fazendo as vezes de qualquer restrição que seu esquema realmente tenha.

## Por que não há transação à qual recorrer

O Blob Storage é um serviço HTTP. Ele não tem commit em duas fases, nem gerenciador de recursos XA, nem gancho de alistamento. O `TransactionScope` envolverá alegremente uma chamada `PutBlob` e depois fará rollback em volta dela, e o blob continuará lá depois. O mesmo vale para uma transação do EF Core:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1, Azure.Storage.Blobs 12.29.2
await using (var tx = await db.Database.BeginTransactionAsync())
{
    db.Documents.Add(new Document { Name = "tx", BlobName = blobName, Status = "Ready" });
    await db.SaveChangesAsync();
    await container.GetBlobClient(blobName).UploadAsync(content);
    await tx.RollbackAsync();
}
```

Resultado medido:

```text
##### E DB transaction rollback does not undo the upload
rows=0 blobs=1
```

A linha sumiu e o blob não. Esse é o problema inteiro em duas linhas. Já que você não consegue atomicidade, a questão de projeto passa a ser: qual estado inconsistente você quer que seja possível, e quem o limpa?

Existem apenas duas ordenações e cada uma tem um modo de falha distinto.

**Blob primeiro, linha depois.** Se a gravação no banco de dados falhar, você tem um blob órfão: armazenamento que você paga e que nada referencia. Ninguém vê um link quebrado.

**Linha primeiro, blob depois.** Se o upload falhar, você tem uma linha apontando para um blob que não existe. Todo leitor que seguir esse ponteiro recebe um 404.

Blobs órfãos custam dinheiro. Ponteiros pendurados custam correção. Prefira o órfão, e então torne-o barato de encontrar.

## A versão ingênua e o que ela deixa para trás

O handler que todo mundo escreve primeiro faz upload e depois salva:

```csharp
// .NET 11 RC 1. Do not ship this.
app.MapPost("/documents", async (IFormFile file, string name, AppDb db, BlobContainerClient container) =>
{
    var blobName = $"{Guid.NewGuid():N}{Path.GetExtension(file.FileName)}";
    await using var stream = file.OpenReadStream();
    await container.GetBlobClient(blobName).UploadAsync(stream);

    db.Documents.Add(new Document { Name = name, BlobName = blobName, Status = "Ready" });
    await db.SaveChangesAsync();
    return Results.Created($"/documents/{name}", null);
});
```

Dê a ele um nome que colida com um índice único e o save lança depois que os bytes já estão no container:

```text
##### A naive: upload then SaveChanges fails
SaveChanges threw SqliteException: SQLite Error 19: 'UNIQUE constraint failed: Documents.Name'
rows=1 blobs=1 orphaned=1
```

O remendo óbvio é uma deleção compensatória, e ela de fato funciona quando a falha é uma exceção que você captura:

```csharp
var blob = container.GetBlobClient(blobName);
await blob.UploadAsync(stream);
db.Documents.Add(entity);
try
{
    await db.SaveChangesAsync();
}
catch (DbUpdateException)
{
    db.ChangeTracker.Clear();
    await blob.DeleteIfExistsAsync(DeleteSnapshotsOption.IncludeSnapshots);
    throw;
}
```

```text
##### B compensating delete in catch
compensating DeleteIfExists returned True
rows=1 blobs=0
```

Repare no `ChangeTracker.Clear()`. Depois de um `SaveChangesAsync` que falhou, as entidades continuam como `Added` no tracker, então qualquer coisa que reutilize o contexto, incluindo uma nova tentativa no mesmo `DbContext` com escopo, vai tentar o mesmo insert de novo. Esse é o mesmo formato de falha descrito em [garantindo o processamento idempotente de mensagens com uma tabela de inbox](/pt-br/2026/09/how-to-guarantee-idempotent-message-processing-in-ef-core-11-with-an-inbox-table/).

Você pode tirar a compensação inteiramente do endpoint com um interceptor do EF Core, o que vale a pena se mais de um handler faz uploads:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1
sealed class BlobCompensationInterceptor(BlobContainerClient container, PendingBlobs pending)
    : SaveChangesInterceptor
{
    public override async Task SaveChangesFailedAsync(
        DbContextErrorEventData eventData, CancellationToken ct = default)
    {
        foreach (var name in pending.Names)
            await container.GetBlobClient(name).DeleteIfExistsAsync(cancellationToken: ct);
        pending.Names.Clear();
    }

    public override ValueTask<int> SavedChangesAsync(
        SaveChangesCompletedEventData eventData, int result, CancellationToken ct = default)
    {
        pending.Names.Clear();
        return ValueTask.FromResult(result);
    }
}
```

Registre `PendingBlobs` como scoped, adicione o nome do blob a ele logo após o upload, e `SaveChangesFailedAsync` dispara em qualquer save que falhe:

```text
##### F SaveChangesFailedAsync interceptor runs the compensating delete
interceptor: SaveChangesFailedAsync fired for DbUpdateException
rows=1 blobs=0
```

Isso é genuinamente útil e continua não sendo um argumento de correção. A deleção compensatória só roda quando seu processo está vivo para rodá-la. Um pod despejado entre o upload e o commit, um timeout do pool de conexões que mata a requisição, uma `TaskCanceledException` vinda do cliente que se desconectou: nada disso lhe dá um bloco `catch`. Sob qualquer implantação real você vai acumular órfãos, então você precisa de um protocolo que permita identificá-los depois.

## O protocolo que sobrevive a um crash

Grave a intenção no banco de dados antes de tocar no armazenamento, e faça do nome do blob um valor que o banco de dados já guarda:

1. Insira a linha com `Status = Pending`, um `BlobName` gerado e `CreatedUtc`. Confirme.
2. Faça o upload exatamente para esse nome de blob, com uma criação condicional para que uma nova tentativa não possa atropelar os bytes de outra requisição.
3. Atualize a linha para `Status = Ready`. Confirme.
4. Leitores filtram por `Status == Ready`. Um faxineiro deleta linhas `Pending` mais velhas que o timeout da requisição, blob primeiro, depois a linha.

```csharp
// .NET 11 RC 1, ASP.NET Core 11, Azure.Storage.Blobs 12.29.2
app.MapPost("/documents", async (
    IFormFile file, string name, AppDb db, BlobContainerClient container, TimeProvider clock, CancellationToken ct) =>
{
    var doc = new Document
    {
        Name = name,
        BlobName = $"{Guid.NewGuid():N}{Path.GetExtension(file.FileName)}",
        Status = DocumentStatus.Pending,
        CreatedUtc = clock.GetUtcNow().UtcDateTime
    };
    db.Documents.Add(doc);
    await db.SaveChangesAsync(ct);                       // 1: intent is durable

    await using var stream = file.OpenReadStream();
    await container.GetBlobClient(doc.BlobName).UploadAsync(
        stream,
        new BlobUploadOptions
        {
            Conditions = new BlobRequestConditions { IfNoneMatch = ETag.All },
            Tags = new Dictionary<string, string> { ["state"] = "pending" }
        },
        ct);                                             // 2: bytes land, create-only

    doc.Status = DocumentStatus.Ready;
    await db.SaveChangesAsync(ct);                       // 3: now it is visible
    return Results.Created($"/documents/{doc.Id}", null);
});
```

Percorra os pontos de crash. Morra depois do passo 1 e você tem uma linha `Pending` e nenhum blob: invisível para leitores, varrida depois. Morra depois do passo 2 e você tem uma linha `Pending` e um blob: ainda invisível, e o faxineiro sabe o nome do blob porque a linha o guarda. Essa é a propriedade que a ordenação ingênua não tem. Um órfão criado por "blob primeiro" só é localizável listando o container inteiro e comparando com a tabela; um órfão criado por este protocolo é uma linha que você consulta com um índice.

O faxineiro não tem nada de notável, e esse é justamente o ponto:

```csharp
var cutoff = clock.GetUtcNow().UtcDateTime.AddMinutes(-15);
var stale = await db.Documents
    .Where(d => d.Status == DocumentStatus.Pending && d.CreatedUtc < cutoff)
    .ToListAsync(ct);

foreach (var s in stale)
    await container.GetBlobClient(s.BlobName).DeleteIfExistsAsync(cancellationToken: ct);

db.Documents.RemoveRange(stale);
await db.SaveChangesAsync(ct);
```

```text
##### C pending row -> upload -> mark ready, with a crash before the mark
before sweep: rows=2 pending=1 blobs=2
after sweep:  rows=1 blobs=1 swept=1
```

Defina o corte como maior que a duração máxima da sua requisição mais o upload mais longo que você aceita. Uma janela de 15 minutos é generosa para arquivos pequenos e curta demais se você permite uploads de vários gigabytes por um [endpoint com streaming](/pt-br/2026/04/how-to-upload-a-large-file-with-streaming-to-azure-blob-storage/).

## A sobrecarga de UploadAsync que transforma uma criação segura em sobrescrita

`BlobClient.UploadAsync(Stream)` é somente criação. Isso não está documentado como uma gentileza, está no código-fonte: toda sobrecarga sem um parâmetro `BlobUploadOptions` passa `overwrite: false` adiante para uma chamada que monta a condição para você.

```csharp
// Azure.Storage.Blobs 12.29.2, BlobClient.cs
conditions: overwrite ? null : new BlobRequestConditions { IfNoneMatch = new ETag(Constants.Wildcard) },
```

A sobrecarga que recebe `BlobUploadOptions` repassa suas opções literalmente. Ela não injeta nada. Então, no momento em que você adiciona opções para definir `StorageTransferOptions`, ou tags, ou um content type, a criação condicional desaparece a menos que você mesmo a escreva de volta. Medido, fazendo upload duas vezes para o mesmo nome:

```text
##### I default conditions per UploadAsync overload
UploadAsync(content)                          -> HTTP 409 BlobAlreadyExists
UploadAsync(content, overwrite: false)        -> HTTP 409 BlobAlreadyExists
UploadAsync(content, new BlobUploadOptions()) -> overwrote
UploadAsync(stream)                           -> HTTP 409 BlobAlreadyExists
UploadAsync(stream, new BlobUploadOptions())  -> overwrote
```

Essa é a maneira mais comum de um endpoint de upload de arquivos perder dados. A refatoração que adiciona `MaximumConcurrency` por desempenho também remove a proteção contra duas requisições disputando o mesmo nome, e nada no diff diz isso.

Defina a condição explicitamente sempre que passar opções:

```csharp
new BlobUploadOptions
{
    Conditions = new BlobRequestConditions { IfNoneMatch = ETag.All },
    TransferOptions = new StorageTransferOptions { MaximumConcurrency = 16 }
}
```

Com a condição no lugar, cinco escritores concorrentes para um mesmo nome de blob se resolvem de forma limpa: um vence, quatro recebem conflito, e os bytes de ninguém são silenciosamente substituídos.

```text
##### G five concurrent conditional creates of the same blob name
won=1 conflict409=4 other=[] blobs=1
```

Uma ressalva sobre o código de status. O Azurite 3.37.0 responde a uma criação condicional contra um blob existente com `409 BlobAlreadyExists`, e isso combina com o que os próprios comentários de documentação do SDK do Azure descrevem ("creates a new block blob or throws if the blob already exists"). Mas a tabela da referência REST sobre [cabeçalhos condicionais em operações de escrita](https://learn.microsoft.com/en-us/rest/api/storageservices/specifying-conditional-headers-for-blob-service-operations) lista `412 Precondition Failed` como a resposta para um `If-None-Match` não atendido. Trate os dois casos em vez de apostar em um:

```csharp
catch (RequestFailedException e) when (e.Status is 409 or 412)
{
    // Someone already created this blob. For a retry of our own request
    // with the same blob name, that is success, not failure.
}
```

Esse `catch` é o que torna o endpoint seguro para novas tentativas. Como o nome do blob vem da linha gravada no passo 1, uma nova tentativa do cliente que reutiliza o mesmo id de documento cai no mesmo nome, a criação condicional conflita, e você trata isso como já feito.

## Uploads multibloco deixam blocos para trás quando a condição falha

A criação condicional é avaliada no `Put Block List`, não no `Put Block`. Para qualquer coisa maior que `InitialTransferSize`, o SDK primeiro faz o staging dos blocos e os confirma por último, então um escritor perdedor já pagou pelo upload dos seus blocos quando descobre que perdeu:

```text
##### K conditional create on a staged multi-block upload
first staged upload ok, size=12582912
second staged upload -> HTTP 409 BlobAlreadyExists
blocks left uncommitted: 3
```

Esses três blocos não confirmados não são visíveis via `GetBlobsAsync` e não são gratuitos. Segundo a [referência de Put Block](https://learn.microsoft.com/en-us/rest/api/storageservices/put-block), blocos não confirmados só passam por coleta de lixo se não houver nenhum `Put Block` ou `Put Block List` bem-sucedido naquele blob dentro de uma semana a partir do último `Put Block` bem-sucedido, e cada `Put Block` é cobrado como uma operação de escrita. Se sua história de nova tentativa envolve muitos uploads grandes e concorrentes para o mesmo nome, confira sua fatura de armazenamento antes de decidir que isso é teórico.

## Proteja a deleção compensatória com uma condição de tag

A instrução perigosa em tudo isso é a deleção. Um faxineiro com um corte ligeiramente errado, ou uma deleção compensatória que dispara em uma requisição que na verdade teve sucesso, destrói um arquivo já confirmado. O Blob Storage lhe dá uma proteção do lado do servidor: `x-ms-if-tags`, exposto pelo SDK como `BlobRequestConditions.TagConditions`. Marque o blob com `state=pending` no upload, mude para `committed` quando você marcar a linha como `Ready`, e torne toda deleção condicional a que a tag ainda diga `pending`:

```csharp
var guard = new BlobRequestConditions { TagConditions = "\"state\" = 'pending'" };
await container.GetBlobClient(s.BlobName).DeleteIfExistsAsync(conditions: guard, cancellationToken: ct);
```

```text
##### J conditional delete guarded by x-ms-if-tags
delete still-pending     -> deleted=True
delete already-committed -> HTTP 412 ConditionNotMet
remaining: already-committed.txt
```

O serviço recusa a deleção. Um bug no seu faxineiro vira um 412 em um log em vez de um chamado de suporte. Repare nas permissões: tags de índice são um sub-recurso, então permissões de leitura e escrita de blob não bastam. Você precisa da permissão SAS `t` ou da ação RBAC `Microsoft.Storage/storageAccounts/blobServices/containers/blobs/tags/write`, e as tags são limitadas a 10 por blob, com chaves de 1 a 128 caracteres e valores de até 256.

Duas coisas que um esquema baseado em tags não vai fazer por você. O `FindBlobsByTags` lê um índice que é atualizado de forma assíncrona, então um blob recém-enviado pode não aparecer em uma consulta por tags durante algum tempo; a [documentação de índice de blobs](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-manage-find-blobs) da Microsoft descreve atrasos de indexação que vão de menos de um segundo a cerca de dez minutos, dependendo da taxa de escrita. Nunca baseie uma decisão de correção em uma consulta por tags. E as tags de índice de blob são suportadas apenas em contas de uso geral v2 e de block blob premium; em uma conta com namespace hierárquico elas são um recurso em versão prévia que não se integra ao gerenciamento de ciclo de vida.

## Use uma política de ciclo de vida como rede de segurança, não como a limpeza

É tentador pular o faxineiro e deixar uma regra de gerenciamento de ciclo de vida deletar qualquer coisa ainda marcada com `state=pending`:

```json
{
  "rules": [{
    "name": "delete-abandoned-uploads",
    "enabled": true,
    "type": "Lifecycle",
    "definition": {
      "actions": { "baseBlob": { "delete": { "daysAfterCreationGreaterThan": 1 } } },
      "filters": {
        "blobTypes": [ "blockBlob" ],
        "prefixMatch": [ "documents/" ],
        "blobIndexMatch": [ { "name": "state", "op": "==", "value": "pending" } ]
      }
    }
  }]
}
```

Essa regra vale a pena ter, mas leia seus limites antes de depender dela. As condições de execução são todas expressas em dias inteiros, então a janela mais apertada que você consegue expressar é um dia. Editar uma política pode levar até 24 horas para fazer efeito e para a primeira execução começar. O ciclo de vida suporta apenas verificações de igualdade no blob index match, com no máximo 10 condições de tag e 10 prefixos por regra, e `blobIndexMatch` é suportado apenas em contas com namespace plano. Trate isso como aquilo que pega o que seu faxineiro deixou passar, incluindo blobs cujas linhas foram deletadas por alguma outra coisa completamente diferente.

## Substituindo um arquivo que já está lá

Atualizações são onde a ordenação se inverte. Quando uma nova versão substitui uma antiga, faça o upload do novo blob sob um novo nome, confirme a mudança na linha, e só então delete o blob antigo. Delete primeiro e um rollback deixa a linha apontando para bytes que você acabou de destruir.

Para esse caminho, habilite [soft delete para blobs](https://learn.microsoft.com/en-us/azure/storage/blobs/soft-delete-blob-overview) na conta. Isso converte uma deleção equivocada em uma chamada `Undelete Blob` durante o período de retenção, que é o seguro mais barato disponível para qualquer sistema que deleta armazenamento com base em uma linha de banco de dados. Tenha em mente que uma ação de deleção do ciclo de vida não funciona em um blob que já está soft-deleted, e que uma deleção protegida por tag precisa que a tag de proteção ainda esteja presente.

Se a atualização é um problema genuíno de edição concorrente em vez de um problema de consistência, o lado do banco de dados disso é um [token de concorrência rowversion](/pt-br/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/), não algo na API de armazenamento.

## Três coisas para não fazer

Não chame `SaveChangesAsync` e depois faça o upload dentro da mesma requisição sem um estado `Pending`. Essa é a ordenação do ponteiro pendurado, e leitores veem um documento quebrado no instante em que o upload falha.

Não coloque a deleção compensatória em um `finally`. Ela roda também no caminho de sucesso, a menos que você a proteja com uma flag, e a versão que funciona é a versão que só roda no caminho de falha.

Não empurre o upload para o pipeline de requisições e a linha para um job em segundo plano sem um registro durável conectando os dois. Se a fila de jobs não está na mesma transação que a linha, você só moveu o problema de lugar; esse é exatamente o caso para o qual existe o padrão transactional outbox, e ele precisa da mesma propriedade de "um único commit" que a tabela de inbox.

O formato para guardar na cabeça: o banco de dados é a fonte da verdade sobre o que existe, o armazenamento é onde os bytes vivem, e a única ordenação que nunca mente para um leitor é aquela em que o banco de dados aprende o nome primeiro e admite que o documento existe por último.

### Leia em seguida

- [How to upload a large file with streaming to Azure Blob Storage](/pt-br/2026/04/how-to-upload-a-large-file-with-streaming-to-azure-blob-storage/)
- [How to guarantee idempotent message processing with EF Core 11 when two app instances consume the same message](/pt-br/2026/09/how-to-guarantee-idempotent-message-processing-in-ef-core-11-with-an-inbox-table/)
- [How to implement optimistic concurrency with a rowversion token in EF Core 11](/pt-br/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/)
- [Fix: 413 Request Entity Too Large uploading a file in ASP.NET Core 11](/pt-br/2026/07/fix-413-request-entity-too-large-uploading-a-file-in-aspnetcore-11/)
- [How to stream a file from an ASP.NET Core endpoint without buffering](/pt-br/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/)

### Fontes

- [Specifying conditional headers for Blob service operations](https://learn.microsoft.com/en-us/rest/api/storageservices/specifying-conditional-headers-for-blob-service-operations), Azure Storage REST API
- [Put Block](https://learn.microsoft.com/en-us/rest/api/storageservices/put-block), Azure Storage REST API
- [Manage and find Azure Blob data with blob index tags](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-manage-find-blobs), Microsoft Learn
- [Azure Blob Storage lifecycle management overview](https://learn.microsoft.com/en-us/azure/storage/blobs/lifecycle-management-overview), Microsoft Learn
- [Lifecycle management policy structure](https://learn.microsoft.com/en-us/azure/storage/blobs/lifecycle-management-policy-structure), Microsoft Learn
- [Soft delete for blobs](https://learn.microsoft.com/en-us/azure/storage/blobs/soft-delete-blob-overview), Microsoft Learn
- [`BlobClient.cs` at tag `Azure.Storage.Blobs_12.29.2`](https://github.com/Azure/azure-sdk-for-net/blob/Azure.Storage.Blobs_12.29.2/sdk/storage/Azure.Storage.Blobs/src/BlobClient.cs), Azure SDK for .NET
- [Compensating Transaction pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/compensating-transaction), Azure Architecture Center
