---
title: "How to keep a database write and an Azure Blob Storage upload consistent in a single ASP.NET Core request"
description: "There is no transaction that spans SQL Server and Blob Storage. Upload to a name the database already knows about, commit second, compensate on failure, and let a sweeper clean up the crash window. With the UploadAsync overload that silently turns a conditional create into an overwrite."
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
---

Short answer: you cannot. No transaction spans a relational database and Azure Blob Storage, so stop trying to make the two commit together and make the failure survivable instead. Write the database row first, in its own committed transaction, with a `Pending` status and the blob name you are about to use; upload to exactly that name with a conditional create; then flip the row to `Ready` in a second transaction. Every crash point leaves either a row with no blob or a blob with no visible row, both of which a sweeper can resolve, and never a row pointing at a blob that does not exist. Compensating deletes in a `catch` block are worth adding, but they are an optimisation, not the correctness argument.

This post walks through the four orderings you can choose from, what each one leaves behind when it fails, and the Azure SDK behaviours that decide whether your retry is idempotent or destructive.

A note on versions and verification. Everything below was run on the .NET 11 RC 1 SDK (`11.0.100-rc.1.26425.128`) with `Azure.Storage.Blobs` 12.29.2 and `Microsoft.EntityFrameworkCore.Sqlite` 11.0.0-rc.1.26425.128. There is no Azure subscription on this machine, so the storage calls run against the Azurite emulator 3.37.0, which implements the Blob REST API locally. Where the emulator and the production service could plausibly differ I say so and cite the REST reference. The database side uses SQLite with a unique index standing in for whatever constraint your schema actually has.

## Why there is no transaction to reach for

Blob Storage is an HTTP service. It has no two-phase commit, no XA resource manager, and no enlistment hook. `TransactionScope` will happily wrap a `PutBlob` call and then roll back around it, and the blob will still be there afterwards. Same for an EF Core transaction:

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

Measured result:

```text
##### E DB transaction rollback does not undo the upload
rows=0 blobs=1
```

The row is gone and the blob is not. That is the whole problem in two lines. Since you cannot get atomicity, the design question becomes: which inconsistent state do you want to be possible, and who cleans it up?

There are only two orderings and each one has a distinct failure mode.

**Blob first, row second.** If the database write fails, you have an orphaned blob: storage you pay for that nothing references. Nobody sees a broken link.

**Row first, blob second.** If the upload fails, you have a row pointing at a blob that does not exist. Every reader that follows that pointer gets a 404.

Orphaned blobs cost money. Dangling pointers cost correctness. Prefer the orphan, and then make it cheap to find.

## The naive version and what it leaves behind

The handler everyone writes first uploads, then saves:

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

Give it a name that collides with a unique index and the save throws after the bytes are already in the container:

```text
##### A naive: upload then SaveChanges fails
SaveChanges threw SqliteException: SQLite Error 19: 'UNIQUE constraint failed: Documents.Name'
rows=1 blobs=1 orphaned=1
```

The obvious patch is a compensating delete, and it does work when the failure is an exception you catch:

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

Note the `ChangeTracker.Clear()`. After a failed `SaveChangesAsync` the entities are still `Added` in the tracker, so anything that reuses the context, including a retry on the same scoped `DbContext`, will try the same insert again. This is the same failure shape described in [guaranteeing idempotent message processing with an inbox table](/2026/09/how-to-guarantee-idempotent-message-processing-in-ef-core-11-with-an-inbox-table/).

You can move the compensation out of the endpoint entirely with an EF Core interceptor, which is worth doing if more than one handler does uploads:

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

Register `PendingBlobs` as scoped, add the blob name to it right after the upload, and `SaveChangesFailedAsync` fires on any failed save:

```text
##### F SaveChangesFailedAsync interceptor runs the compensating delete
interceptor: SaveChangesFailedAsync fired for DbUpdateException
rows=1 blobs=0
```

This is genuinely useful and it is still not a correctness argument. The compensating delete runs only when your process is alive to run it. A pod evicted between the upload and the commit, a connection pool timeout that kills the request, a `TaskCanceledException` from the client disconnecting: none of those give you a `catch` block. Under any real deployment you will accumulate orphans, so you need a protocol that lets you identify them later.

## The protocol that survives a crash

Write the intent to the database before you touch storage, and make the blob name a value the database already holds:

1. Insert the row with `Status = Pending`, a generated `BlobName`, and `CreatedUtc`. Commit.
2. Upload to that exact blob name, with a conditional create so a retry cannot clobber a different request's bytes.
3. Update the row to `Status = Ready`. Commit.
4. Readers filter on `Status == Ready`. A sweeper deletes `Pending` rows older than the request timeout, blob first, then row.

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

Walk the crash points. Die after step 1 and you have a `Pending` row and no blob: invisible to readers, swept later. Die after step 2 and you have a `Pending` row and a blob: still invisible, and the sweeper knows the blob name because the row holds it. That is the property the naive ordering does not have. An orphan created by "blob first" is only findable by listing the whole container and diffing it against the table; an orphan created by this protocol is a row you can query with an index.

The sweeper is unremarkable, which is the point:

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

Set the cutoff longer than your maximum request duration plus the longest upload you accept. A 15 minute window is generous for small files and far too short if you allow multi-gigabyte uploads through a [streaming endpoint](/2026/04/how-to-upload-a-large-file-with-streaming-to-azure-blob-storage/).

## The UploadAsync overload that turns a safe create into an overwrite

`BlobClient.UploadAsync(Stream)` is create-only. It is not documented as a nicety, it is in the source: every overload without a `BlobUploadOptions` parameter passes `overwrite: false` down to a call that builds the condition for you.

```csharp
// Azure.Storage.Blobs 12.29.2, BlobClient.cs
conditions: overwrite ? null : new BlobRequestConditions { IfNoneMatch = new ETag(Constants.Wildcard) },
```

The overload that takes `BlobUploadOptions` passes your options through verbatim. It injects nothing. So the moment you add options to set `StorageTransferOptions`, or tags, or a content type, the conditional create disappears unless you write it back in yourself. Measured, uploading twice to the same name:

```text
##### I default conditions per UploadAsync overload
UploadAsync(content)                          -> HTTP 409 BlobAlreadyExists
UploadAsync(content, overwrite: false)        -> HTTP 409 BlobAlreadyExists
UploadAsync(content, new BlobUploadOptions()) -> overwrote
UploadAsync(stream)                           -> HTTP 409 BlobAlreadyExists
UploadAsync(stream, new BlobUploadOptions())  -> overwrote
```

This is the single most common way a file-upload endpoint loses data. The refactor that adds `MaximumConcurrency` for performance also removes the guard against two requests racing on the same name, and nothing in the diff says so.

Set the condition explicitly whenever you pass options:

```csharp
new BlobUploadOptions
{
    Conditions = new BlobRequestConditions { IfNoneMatch = ETag.All },
    TransferOptions = new StorageTransferOptions { MaximumConcurrency = 16 }
}
```

With the condition in place, five concurrent writers to one blob name resolve cleanly: one wins, four get a conflict, and nobody's bytes are silently replaced.

```text
##### G five concurrent conditional creates of the same blob name
won=1 conflict409=4 other=[] blobs=1
```

One caveat on the status code. Azurite 3.37.0 answers a conditional create against an existing blob with `409 BlobAlreadyExists`, and that matches what the Azure SDK's own doc comments describe ("creates a new block blob or throws if the blob already exists"). But the REST reference's table for [conditional headers on write operations](https://learn.microsoft.com/en-us/rest/api/storageservices/specifying-conditional-headers-for-blob-service-operations) lists `412 Precondition Failed` as the response for an unmet `If-None-Match`. Match on both rather than betting on one:

```csharp
catch (RequestFailedException e) when (e.Status is 409 or 412)
{
    // Someone already created this blob. For a retry of our own request
    // with the same blob name, that is success, not failure.
}
```

That `catch` is what makes the endpoint safe to retry. Because the blob name comes from the row written in step 1, a client retry that reuses the same document id lands on the same name, the conditional create conflicts, and you treat it as already done.

## Multi-block uploads leave blocks behind when the condition fails

The conditional create is evaluated at `Put Block List`, not at `Put Block`. For anything larger than `InitialTransferSize` the SDK stages blocks first and commits them last, so a losing writer has already paid to upload its blocks by the time it learns it lost:

```text
##### K conditional create on a staged multi-block upload
first staged upload ok, size=12582912
second staged upload -> HTTP 409 BlobAlreadyExists
blocks left uncommitted: 3
```

Those three uncommitted blocks are not visible through `GetBlobsAsync` and they are not free. Per the [Put Block reference](https://learn.microsoft.com/en-us/rest/api/storageservices/put-block), uncommitted blocks are garbage collected only if there is no successful `Put Block` or `Put Block List` on that blob within a week of the last successful `Put Block`, and each `Put Block` is billed as a write operation. If your retry story involves many large concurrent uploads to the same name, check your storage bill before deciding this is theoretical.

## Guard the compensating delete with a tag condition

The dangerous instruction in any of this is the delete. A sweeper with a slightly wrong cutoff, or a compensating delete that fires on a request that actually succeeded, destroys a committed file. Blob Storage gives you a server-side guard: `x-ms-if-tags`, exposed by the SDK as `BlobRequestConditions.TagConditions`. Tag the blob `state=pending` on upload, set it to `committed` when you mark the row `Ready`, and make every delete conditional on the tag still saying `pending`:

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

The service refuses the delete. A bug in your sweeper becomes a 412 in a log instead of a support ticket. Note the permissions: index tags are a subresource, so blob read and write permissions are not enough. You need the `t` SAS permission or the `Microsoft.Storage/storageAccounts/blobServices/containers/blobs/tags/write` RBAC action, and tags are limited to 10 per blob with keys of 1 to 128 characters and values of up to 256.

Two things a tag-based scheme will not do for you. `FindBlobsByTags` reads an index that updates asynchronously, so a just-uploaded blob may not appear in a tag query for some time; Microsoft's [blob index documentation](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-manage-find-blobs) describes indexing delays ranging from under a second to around ten minutes depending on write rate. Never drive a correctness decision off a tag query. And blob index tags are supported on general-purpose v2 and premium block blob accounts only; on a hierarchical-namespace account they are a preview feature that does not integrate with lifecycle management.

## Use a lifecycle policy as a backstop, not as the cleanup

It is tempting to skip the sweeper and let a lifecycle management rule delete anything still tagged `state=pending`:

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

That rule is worth having, but read its limits before you rely on it. The run conditions are all expressed in whole days, so the tightest window you can express is one day. Editing a policy can take up to 24 hours to take effect and for the first run to start. Lifecycle only supports equality checks on blob index match, with at most 10 tag conditions and 10 prefixes per rule, and `blobIndexMatch` is supported only on flat-namespace accounts. Treat it as the thing that catches what your sweeper missed, including blobs whose rows were deleted by something else entirely.

## Replacing a file that is already there

Updates are where the ordering flips. When a new version replaces an old one, upload the new blob under a new name, commit the row change, and only then delete the old blob. Delete first and a rollback leaves the row pointing at bytes you just destroyed.

For that path, enable [soft delete for blobs](https://learn.microsoft.com/en-us/azure/storage/blobs/soft-delete-blob-overview) on the account. It converts a mistaken delete into an `Undelete Blob` call for the length of the retention period, which is the cheapest insurance available for any system that deletes storage on the strength of a database row. Keep in mind that a lifecycle delete action does not work on a blob that is already soft-deleted, and that a tag-guarded delete needs the guard tag to still be present.

If the update is a genuine concurrent-edit problem rather than a consistency problem, the database side of it is a [rowversion concurrency token](/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/), not anything in the storage API.

## Three things not to do

Do not call `SaveChangesAsync` and then upload inside the same request without a `Pending` state. That is the dangling-pointer ordering, and readers see a broken document the instant the upload fails.

Do not put the compensating delete in a `finally`. It runs on the success path too, unless you guard it with a flag, and the version that works is the version that only runs on the failure path.

Do not push the upload into the request pipeline and the row into a background job without a durable record connecting them. If the job queue is not in the same transaction as the row, you have just moved the problem; that is exactly the case the transactional outbox pattern exists for, and it needs the same "one commit" property as the inbox table.

The shape to keep in your head: the database is the source of truth about what exists, storage is where bytes live, and the only ordering that never lies to a reader is the one where the database learns the name first and admits the document exists last.

### Read next

- [How to upload a large file with streaming to Azure Blob Storage](/2026/04/how-to-upload-a-large-file-with-streaming-to-azure-blob-storage/)
- [How to guarantee idempotent message processing with EF Core 11 when two app instances consume the same message](/2026/09/how-to-guarantee-idempotent-message-processing-in-ef-core-11-with-an-inbox-table/)
- [How to implement optimistic concurrency with a rowversion token in EF Core 11](/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/)
- [Fix: 413 Request Entity Too Large uploading a file in ASP.NET Core 11](/2026/07/fix-413-request-entity-too-large-uploading-a-file-in-aspnetcore-11/)
- [How to stream a file from an ASP.NET Core endpoint without buffering](/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/)

### Sources

- [Specifying conditional headers for Blob service operations](https://learn.microsoft.com/en-us/rest/api/storageservices/specifying-conditional-headers-for-blob-service-operations), Azure Storage REST API
- [Put Block](https://learn.microsoft.com/en-us/rest/api/storageservices/put-block), Azure Storage REST API
- [Manage and find Azure Blob data with blob index tags](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-manage-find-blobs), Microsoft Learn
- [Azure Blob Storage lifecycle management overview](https://learn.microsoft.com/en-us/azure/storage/blobs/lifecycle-management-overview), Microsoft Learn
- [Lifecycle management policy structure](https://learn.microsoft.com/en-us/azure/storage/blobs/lifecycle-management-policy-structure), Microsoft Learn
- [Soft delete for blobs](https://learn.microsoft.com/en-us/azure/storage/blobs/soft-delete-blob-overview), Microsoft Learn
- [`BlobClient.cs` at tag `Azure.Storage.Blobs_12.29.2`](https://github.com/Azure/azure-sdk-for-net/blob/Azure.Storage.Blobs_12.29.2/sdk/storage/Azure.Storage.Blobs/src/BlobClient.cs), Azure SDK for .NET
- [Compensating Transaction pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/compensating-transaction), Azure Architecture Center
