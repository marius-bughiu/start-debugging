---
title: "1 つの ASP.NET Core リクエストの中でデータベース書き込みと Azure Blob Storage へのアップロードの整合性を保つ方法"
description: "SQL Server と Blob Storage をまたぐトランザクションは存在しません。データベースが既に知っている名前にアップロードし、コミットは後から行い、失敗時には補償し、クラッシュの隙間はスイーパーに片付けさせます。条件付き作成を黙って上書きに変えてしまう UploadAsync のオーバーロードについても。"
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
lang: "ja"
translationOf: "2026/09/how-to-keep-a-database-write-and-an-azure-blob-upload-consistent-in-one-request"
translatedBy: "claude"
translationDate: 2026-09-20
---

短い答え: できません。リレーショナルデータベースと Azure Blob Storage をまたぐトランザクションは存在しないので、両者を一緒にコミットさせようとするのはやめて、代わりに失敗しても生き延びられるようにします。まずデータベースの行を、それ自体のコミット済みトランザクションの中で、`Pending` ステータスとこれから使う blob 名を付けて書き込みます。次に、まさにその名前へ条件付き作成でアップロードします。そして 2 つ目のトランザクションで行を `Ready` に切り替えます。どのクラッシュ地点でも、残るのは blob のない行か、可視の行のない blob のどちらかで、どちらもスイーパーが解消できます。存在しない blob を指す行が残ることは決してありません。`catch` ブロックでの補償削除は追加する価値がありますが、それは最適化であって、正しさの根拠ではありません。

この記事では、選択できる 4 つの順序、それぞれが失敗したときに何を残すのか、そして再試行が冪等になるか破壊的になるかを決める Azure SDK の挙動を見ていきます。

バージョンと検証についての注記です。以下のすべては .NET 11 RC 1 SDK (`11.0.100-rc.1.26425.128`) 上で、`Azure.Storage.Blobs` 12.29.2 と `Microsoft.EntityFrameworkCore.Sqlite` 11.0.0-rc.1.26425.128 を使って実行しました。このマシンには Azure サブスクリプションがないため、ストレージ呼び出しは Blob REST API をローカルに実装する Azurite エミュレーター 3.37.0 に対して実行しています。エミュレーターと本番サービスで挙動が違い得るところでは、その旨を述べて REST リファレンスを引用します。データベース側は SQLite を使い、実際のスキーマにある制約の代わりに一意インデックスを置いています。

## そもそも頼れるトランザクションが存在しない理由

Blob Storage は HTTP サービスです。2 フェーズコミットも、XA リソースマネージャーも、参加 (enlistment) フックもありません。`TransactionScope` は `PutBlob` 呼び出しを平然と包み込み、その周りでロールバックしますが、blob はその後も残ったままです。EF Core のトランザクションでも同じです。

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

計測結果はこうです。

```text
##### E DB transaction rollback does not undo the upload
rows=0 blobs=1
```

行は消え、blob は消えていません。2 行で問題のすべてが表れています。原子性が得られない以上、設計上の問いはこうなります。どの不整合な状態なら起きてよいのか、そしてそれを誰が片付けるのか。

順序は 2 つしかなく、それぞれに固有の失敗モードがあります。

**blob が先、行が後。** データベース書き込みが失敗すると、孤立した blob が残ります。何からも参照されないのに料金を払うストレージです。壊れたリンクを目にする人はいません。

**行が先、blob が後。** アップロードが失敗すると、存在しない blob を指す行が残ります。そのポインターをたどる読み手は全員 404 を受け取ります。

孤立した blob はお金を失わせます。宙に浮いたポインターは正しさを失わせます。孤立のほうを選び、そのうえで安く見つけられるようにしましょう。

## 素朴な実装と、それが残すもの

誰もが最初に書くハンドラーは、アップロードしてから保存します。

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

一意インデックスに衝突する名前を渡すと、バイト列が既にコンテナーに入った後で保存が例外を投げます。

```text
##### A naive: upload then SaveChanges fails
SaveChanges threw SqliteException: SQLite Error 19: 'UNIQUE constraint failed: Documents.Name'
rows=1 blobs=1 orphaned=1
```

分かりやすい修正は補償削除で、失敗が捕捉できる例外である限りは実際に機能します。

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

`ChangeTracker.Clear()` に注目してください。`SaveChangesAsync` が失敗した後もエンティティはトラッカーの中で `Added` のままなので、コンテキストを再利用するもの (同じスコープの `DbContext` での再試行を含む) は同じ挿入をもう一度試みます。これは [inbox テーブルで冪等なメッセージ処理を保証する方法](/ja/2026/09/how-to-guarantee-idempotent-message-processing-in-ef-core-11-with-an-inbox-table/) で説明したのと同じ失敗の形です。

EF Core のインターセプターを使えば、補償処理をエンドポイントから完全に外に出せます。アップロードを行うハンドラーが複数あるなら、そうする価値があります。

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

`PendingBlobs` をスコープ付きで登録し、アップロードの直後に blob 名を追加すれば、保存が失敗したときに必ず `SaveChangesFailedAsync` が発火します。

```text
##### F SaveChangesFailedAsync interceptor runs the compensating delete
interceptor: SaveChangesFailedAsync fired for DbUpdateException
rows=1 blobs=0
```

これは本当に役に立ちますが、それでも正しさの根拠にはなりません。補償削除が走るのは、それを実行できるだけプロセスが生きているときだけです。アップロードとコミットの間で退去させられた Pod、リクエストを殺すコネクションプールのタイムアウト、クライアントの切断による `TaskCanceledException`。どれも `catch` ブロックを与えてはくれません。現実のデプロイではいずれ孤立が溜まるので、後からそれを特定できるプロトコルが必要です。

## クラッシュを生き延びるプロトコル

ストレージに触れる前に意図をデータベースに書き込み、blob 名をデータベースが既に保持している値にします。

1. `Status = Pending`、生成した `BlobName`、`CreatedUtc` を持つ行を挿入します。コミットします。
2. まさにその blob 名にアップロードします。再試行が別のリクエストのバイト列を壊さないよう、条件付き作成を使います。
3. 行を `Status = Ready` に更新します。コミットします。
4. 読み手は `Status == Ready` で絞り込みます。スイーパーはリクエストタイムアウトより古い `Pending` の行を、blob を先に、次に行の順で削除します。

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

クラッシュ地点を順に見ていきます。手順 1 の後で落ちると、`Pending` の行があって blob はありません。読み手には見えず、後でスイープされます。手順 2 の後で落ちると、`Pending` の行と blob があります。やはり見えませんし、行が blob 名を保持しているのでスイーパーはその名前を知っています。これが素朴な順序にはない性質です。「blob が先」で生まれた孤立は、コンテナー全体を列挙してテーブルと突き合わせないと見つけられません。このプロトコルで生まれた孤立は、インデックスでクエリできる行です。

スイーパー自体は何の変哲もありません。そこが肝心です。

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

カットオフは、最大のリクエスト時間に、受け付ける最長のアップロード時間を足したものより長く設定してください。15 分の猶予は小さなファイルには十分ですが、[ストリーミングエンドポイント](/ja/2026/04/how-to-upload-a-large-file-with-streaming-to-azure-blob-storage/) 経由で数ギガバイトのアップロードを許すならまるで足りません。

## 安全な作成を上書きに変えてしまう UploadAsync のオーバーロード

`BlobClient.UploadAsync(Stream)` は作成専用です。これは気の利いた仕様として文書化されているのではなく、ソースにそう書かれています。`BlobUploadOptions` パラメーターを取らないオーバーロードはすべて、条件を組み立ててくれる呼び出しに `overwrite: false` を渡します。

```csharp
// Azure.Storage.Blobs 12.29.2, BlobClient.cs
conditions: overwrite ? null : new BlobRequestConditions { IfNoneMatch = new ETag(Constants.Wildcard) },
```

`BlobUploadOptions` を取るオーバーロードは、渡されたオプションをそのまま素通しします。何も注入しません。つまり `StorageTransferOptions` やタグ、コンテンツタイプを設定しようとオプションを足した瞬間に、自分で書き戻さない限り条件付き作成は消えます。同じ名前に 2 回アップロードして計測した結果です。

```text
##### I default conditions per UploadAsync overload
UploadAsync(content)                          -> HTTP 409 BlobAlreadyExists
UploadAsync(content, overwrite: false)        -> HTTP 409 BlobAlreadyExists
UploadAsync(content, new BlobUploadOptions()) -> overwrote
UploadAsync(stream)                           -> HTTP 409 BlobAlreadyExists
UploadAsync(stream, new BlobUploadOptions())  -> overwrote
```

これはファイルアップロードのエンドポイントがデータを失う最も一般的な経路です。パフォーマンスのために `MaximumConcurrency` を足すリファクタリングは、同じ名前で 2 つのリクエストが競合することへのガードも同時に取り除きますが、diff にはそうと書かれていません。

オプションを渡すときは常に条件を明示的に設定してください。

```csharp
new BlobUploadOptions
{
    Conditions = new BlobRequestConditions { IfNoneMatch = ETag.All },
    TransferOptions = new StorageTransferOptions { MaximumConcurrency = 16 }
}
```

条件を入れておけば、1 つの blob 名に対する 5 つの同時書き込みはきれいに決着します。1 つが勝ち、4 つが競合を受け取り、誰のバイト列も黙って置き換えられません。

```text
##### G five concurrent conditional creates of the same blob name
won=1 conflict409=4 other=[] blobs=1
```

ステータスコードについて 1 つ注意です。Azurite 3.37.0 は既存の blob に対する条件付き作成に `409 BlobAlreadyExists` で応答し、これは Azure SDK 自身のドキュメントコメントの記述 ("creates a new block blob or throws if the blob already exists") と一致します。しかし REST リファレンスの [書き込み操作における条件付きヘッダー](https://learn.microsoft.com/en-us/rest/api/storageservices/specifying-conditional-headers-for-blob-service-operations) の表では、満たされなかった `If-None-Match` に対する応答として `412 Precondition Failed` が挙げられています。どちらか一方に賭けるのではなく、両方にマッチさせてください。

```csharp
catch (RequestFailedException e) when (e.Status is 409 or 412)
{
    // Someone already created this blob. For a retry of our own request
    // with the same blob name, that is success, not failure.
}
```

この `catch` があるからこそ、エンドポイントは安全に再試行できます。blob 名は手順 1 で書き込んだ行から来るので、同じドキュメント ID を再利用するクライアントの再試行は同じ名前に着地し、条件付き作成が競合し、それを「すでに完了した」として扱えます。

## 条件が失敗すると、マルチブロックアップロードはブロックを残す

条件付き作成が評価されるのは `Put Block List` の時点であって、`Put Block` の時点ではありません。`InitialTransferSize` より大きいものでは、SDK は先にブロックをステージングし、最後にコミットします。そのため負けた書き手は、自分が負けたと知る頃にはすでにブロックのアップロード料金を払い終えています。

```text
##### K conditional create on a staged multi-block upload
first staged upload ok, size=12582912
second staged upload -> HTTP 409 BlobAlreadyExists
blocks left uncommitted: 3
```

この 3 つの未コミットブロックは `GetBlobsAsync` からは見えませんし、無料でもありません。[Put Block のリファレンス](https://learn.microsoft.com/en-us/rest/api/storageservices/put-block) によれば、未コミットのブロックがガベージコレクトされるのは、最後に成功した `Put Block` から 1 週間以内にその blob への成功した `Put Block` または `Put Block List` がない場合だけで、`Put Block` はそれぞれ書き込み操作として課金されます。再試行の設計に同じ名前への大きな同時アップロードが多数含まれるなら、これを机上の話だと決めつける前にストレージの請求を確認してください。

## 補償削除をタグ条件で守る

この一連の中で危険な命令は削除です。カットオフがわずかに間違っているスイーパーや、実際には成功したリクエストに対して発火する補償削除は、コミット済みのファイルを破壊します。Blob Storage はサーバー側のガードを用意しています。`x-ms-if-tags` で、SDK では `BlobRequestConditions.TagConditions` として公開されています。アップロード時に blob へ `state=pending` のタグを付け、行を `Ready` にするときに `committed` へ変え、すべての削除をタグがまだ `pending` であることを条件にします。

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

サービスが削除を拒否します。スイーパーのバグは、サポートチケットではなくログの中の 412 になります。権限に注意してください。インデックスタグはサブリソースなので、blob の読み取りと書き込みの権限だけでは足りません。`t` の SAS 権限か `Microsoft.Storage/storageAccounts/blobServices/containers/blobs/tags/write` の RBAC アクションが必要です。またタグは blob あたり 10 個までで、キーは 1 から 128 文字、値は最大 256 文字です。

タグベースの仕組みがやってくれないことが 2 つあります。`FindBlobsByTags` が読むインデックスは非同期に更新されるので、アップロードしたばかりの blob はしばらくタグクエリに現れないことがあります。Microsoft の [blob インデックスのドキュメント](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-manage-find-blobs) は、書き込みレートに応じて 1 秒未満から 10 分程度までのインデックス作成の遅延があると説明しています。正しさにかかわる判断をタグクエリで決めては絶対にいけません。もう 1 つ、blob インデックスタグがサポートされるのは汎用 v2 と Premium ブロック blob のアカウントだけです。階層型名前空間のアカウントではプレビュー機能で、ライフサイクル管理とは統合されません。

## ライフサイクルポリシーは後始末ではなく最後の砦として使う

スイーパーを省いて、まだ `state=pending` のタグが付いているものをライフサイクル管理ルールに削除させたくなります。

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

このルールは持っておく価値がありますが、頼る前に制約を読んでください。実行条件はすべて日単位でしか表現できないので、指定できる最短の窓は 1 日です。ポリシーの編集が反映されて最初の実行が始まるまでに最大 24 時間かかることがあります。ライフサイクルが blob インデックスマッチでサポートするのは等価比較だけで、ルールあたりタグ条件は 10 個、プレフィックスも 10 個までです。さらに `blobIndexMatch` はフラット名前空間のアカウントでのみサポートされます。これはスイーパーが取りこぼしたもの (まったく別の何かによって行を削除された blob を含む) を拾うものとして扱ってください。

## すでに存在するファイルを置き換える

更新では順序が逆になります。新しいバージョンが古いものを置き換えるときは、新しい blob を新しい名前でアップロードし、行の変更をコミットし、そのうえで初めて古い blob を削除します。先に削除すると、ロールバックによって行は今しがた破壊したバイト列を指したまま残ります。

この経路では、アカウントで [blob の論理削除](https://learn.microsoft.com/en-us/azure/storage/blobs/soft-delete-blob-overview) を有効にしてください。誤った削除を、保持期間のあいだは `Undelete Blob` の呼び出しに変えてくれます。データベースの行を根拠にストレージを削除するシステムにとって、これは手に入る最も安い保険です。ライフサイクルの削除アクションはすでに論理削除された blob には効かないこと、そしてタグで守られた削除はガードのタグがまだ存在している必要があることは覚えておいてください。

更新が整合性の問題ではなく本当の同時編集の問題であるなら、そのデータベース側は [rowversion による同時実行トークン](/ja/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/) であって、ストレージ API の中の何かではありません。

## やってはいけない 3 つのこと

`Pending` 状態なしで、同じリクエストの中で `SaveChangesAsync` を呼んでからアップロードしてはいけません。それは宙に浮いたポインターを作る順序で、アップロードが失敗した瞬間に読み手は壊れたドキュメントを見ることになります。

補償削除を `finally` に置いてはいけません。フラグで守らない限り成功パスでも走ってしまいますし、正しく動くのは失敗パスでだけ走る版です。

アップロードをリクエストパイプラインに、行をバックグラウンドジョブに押し込むのを、両者をつなぐ永続的な記録なしにやってはいけません。ジョブキューが行と同じトランザクションにないなら、問題を移動させただけです。それこそトランザクショナル outbox パターンが存在する理由であり、inbox テーブルと同じ「1 回のコミット」という性質を必要とします。

頭に入れておくべき形はこうです。何が存在するかについての信頼できる情報源はデータベースであり、ストレージはバイト列が住む場所です。そして読み手に決して嘘をつかない唯一の順序は、データベースが最初に名前を知り、最後にドキュメントの存在を認める順序です。

### 関連記事

- [Azure Blob Storage へストリーミングで大きなファイルをアップロードする方法](/ja/2026/04/how-to-upload-a-large-file-with-streaming-to-azure-blob-storage/)
- [2 つのアプリインスタンスが同じメッセージを処理するときに EF Core 11 で冪等なメッセージ処理を保証する方法](/ja/2026/09/how-to-guarantee-idempotent-message-processing-in-ef-core-11-with-an-inbox-table/)
- [EF Core 11 で rowversion トークンによる楽観的同時実行制御を実装する方法](/ja/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/)
- [Fix: ASP.NET Core 11 でファイルをアップロードすると 413 Request Entity Too Large](/ja/2026/07/fix-413-request-entity-too-large-uploading-a-file-in-aspnetcore-11/)
- [ASP.NET Core のエンドポイントからバッファリングせずにファイルをストリーミングする方法](/ja/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/)

### 参考資料

- [Specifying conditional headers for Blob service operations](https://learn.microsoft.com/en-us/rest/api/storageservices/specifying-conditional-headers-for-blob-service-operations), Azure Storage REST API
- [Put Block](https://learn.microsoft.com/en-us/rest/api/storageservices/put-block), Azure Storage REST API
- [Manage and find Azure Blob data with blob index tags](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-manage-find-blobs), Microsoft Learn
- [Azure Blob Storage lifecycle management overview](https://learn.microsoft.com/en-us/azure/storage/blobs/lifecycle-management-overview), Microsoft Learn
- [Lifecycle management policy structure](https://learn.microsoft.com/en-us/azure/storage/blobs/lifecycle-management-policy-structure), Microsoft Learn
- [Soft delete for blobs](https://learn.microsoft.com/en-us/azure/storage/blobs/soft-delete-blob-overview), Microsoft Learn
- [`BlobClient.cs` at tag `Azure.Storage.Blobs_12.29.2`](https://github.com/Azure/azure-sdk-for-net/blob/Azure.Storage.Blobs_12.29.2/sdk/storage/Azure.Storage.Blobs/src/BlobClient.cs), Azure SDK for .NET
- [Compensating Transaction pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/compensating-transaction), Azure Architecture Center
