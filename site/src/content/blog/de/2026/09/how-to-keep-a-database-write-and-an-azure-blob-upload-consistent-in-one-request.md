---
title: "Wie Sie einen Datenbankschreibvorgang und einen Azure Blob Storage Upload in einer einzigen ASP.NET-Core-Anfrage konsistent halten"
description: "Es gibt keine Transaktion, die SQL Server und Blob Storage umspannt. Laden Sie unter einen Namen hoch, den die Datenbank bereits kennt, committen Sie danach, kompensieren Sie im Fehlerfall, und lassen Sie einen Sweeper das Absturzfenster aufräumen. Inklusive der UploadAsync-Überladung, die ein bedingtes Erstellen still in ein Überschreiben verwandelt."
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
lang: "de"
translationOf: "2026/09/how-to-keep-a-database-write-and-an-azure-blob-upload-consistent-in-one-request"
translatedBy: "claude"
translationDate: 2026-09-20
---

Kurze Antwort: Sie können es nicht. Keine Transaktion umspannt eine relationale Datenbank und Azure Blob Storage, hören Sie also auf, beide gemeinsam committen zu wollen, und machen Sie stattdessen den Fehlerfall überlebbar. Schreiben Sie zuerst die Datenbankzeile, in einer eigenen committeten Transaktion, mit dem Status `Pending` und dem Blob-Namen, den Sie gleich verwenden werden; laden Sie auf genau diesen Namen mit einem bedingten Erstellen hoch; setzen Sie die Zeile dann in einer zweiten Transaktion auf `Ready`. Jeder Absturzpunkt hinterlässt entweder eine Zeile ohne Blob oder einen Blob ohne sichtbare Zeile, beides kann ein Sweeper auflösen, und niemals eine Zeile, die auf einen nicht existierenden Blob zeigt. Kompensierende Löschvorgänge in einem `catch`-Block lohnen sich, aber sie sind eine Optimierung, kein Korrektheitsargument.

Dieser Beitrag geht die vier Reihenfolgen durch, zwischen denen Sie wählen können, was jede davon im Fehlerfall hinterlässt, und die Verhaltensweisen des Azure SDK, die darüber entscheiden, ob Ihr Retry idempotent oder zerstörerisch ist.

Eine Anmerkung zu Versionen und Verifikation. Alles Folgende lief auf dem .NET 11 RC 1 SDK (`11.0.100-rc.1.26425.128`) mit `Azure.Storage.Blobs` 12.29.2 und `Microsoft.EntityFrameworkCore.Sqlite` 11.0.0-rc.1.26425.128. Auf dieser Maschine gibt es kein Azure-Abonnement, daher laufen die Storage-Aufrufe gegen den Azurite-Emulator 3.37.0, der die Blob REST API lokal implementiert. Wo Emulator und Produktivdienst plausibel abweichen könnten, sage ich es und zitiere die REST-Referenz. Die Datenbankseite verwendet SQLite mit einem eindeutigen Index als Platzhalter für die Einschränkung, die Ihr Schema tatsächlich hat.

## Warum es keine Transaktion gibt, zu der Sie greifen könnten

Blob Storage ist ein HTTP-Dienst. Es gibt kein Zwei-Phasen-Commit, keinen XA-Resource-Manager und keinen Enlistment-Hook. `TransactionScope` umschließt bereitwillig einen `PutBlob`-Aufruf und rollt darum herum zurück, und der Blob ist danach immer noch da. Dasselbe gilt für eine EF-Core-Transaktion:

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

Gemessenes Ergebnis:

```text
##### E DB transaction rollback does not undo the upload
rows=0 blobs=1
```

Die Zeile ist weg, der Blob nicht. Das ist das ganze Problem in zwei Zeilen. Da Sie keine Atomarität bekommen, wird die Entwurfsfrage zu: welchen inkonsistenten Zustand wollen Sie zulassen, und wer räumt ihn auf?

Es gibt nur zwei Reihenfolgen und jede hat einen eigenen Fehlermodus.

**Blob zuerst, Zeile danach.** Wenn der Datenbankschreibvorgang fehlschlägt, haben Sie einen verwaisten Blob: Speicher, den Sie bezahlen und den nichts referenziert. Niemand sieht einen kaputten Link.

**Zeile zuerst, Blob danach.** Wenn der Upload fehlschlägt, haben Sie eine Zeile, die auf einen nicht existierenden Blob zeigt. Jeder Leser, der diesem Zeiger folgt, bekommt einen 404.

Verwaiste Blobs kosten Geld. Hängende Zeiger kosten Korrektheit. Bevorzugen Sie die Waise, und machen Sie sie dann billig auffindbar.

## Die naive Variante und was sie hinterlässt

Der Handler, den jeder zuerst schreibt, lädt hoch und speichert dann:

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

Geben Sie ihm einen Namen, der mit einem eindeutigen Index kollidiert, und das Speichern wirft eine Ausnahme, nachdem die Bytes bereits im Container liegen:

```text
##### A naive: upload then SaveChanges fails
SaveChanges threw SqliteException: SQLite Error 19: 'UNIQUE constraint failed: Documents.Name'
rows=1 blobs=1 orphaned=1
```

Der naheliegende Patch ist ein kompensierender Löschvorgang, und er funktioniert tatsächlich, wenn der Fehler eine Ausnahme ist, die Sie fangen:

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

Beachten Sie das `ChangeTracker.Clear()`. Nach einem fehlgeschlagenen `SaveChangesAsync` sind die Entitäten im Tracker weiterhin `Added`, sodass alles, was den Kontext wiederverwendet, einschließlich eines Retry auf demselben scoped `DbContext`, denselben Insert erneut versucht. Das ist dieselbe Fehlerform, die in [idempotente Nachrichtenverarbeitung mit einer Inbox-Tabelle garantieren](/de/2026/09/how-to-guarantee-idempotent-message-processing-in-ef-core-11-with-an-inbox-table/) beschrieben wird.

Sie können die Kompensation mit einem EF-Core-Interceptor vollständig aus dem Endpunkt herausziehen, was sich lohnt, wenn mehr als ein Handler Uploads durchführt:

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

Registrieren Sie `PendingBlobs` als scoped, fügen Sie den Blob-Namen direkt nach dem Upload hinzu, und `SaveChangesFailedAsync` feuert bei jedem fehlgeschlagenen Speichern:

```text
##### F SaveChangesFailedAsync interceptor runs the compensating delete
interceptor: SaveChangesFailedAsync fired for DbUpdateException
rows=1 blobs=0
```

Das ist wirklich nützlich und trotzdem kein Korrektheitsargument. Der kompensierende Löschvorgang läuft nur, wenn Ihr Prozess noch lebt, um ihn auszuführen. Ein Pod, der zwischen Upload und Commit evakuiert wird, ein Timeout des Verbindungspools, das die Anfrage abbricht, eine `TaskCanceledException`, weil der Client die Verbindung trennt: nichts davon gibt Ihnen einen `catch`-Block. Unter jeder realen Bereitstellung sammeln Sie Waisen an, Sie brauchen also ein Protokoll, mit dem Sie sie später identifizieren können.

## Das Protokoll, das einen Absturz übersteht

Schreiben Sie die Absicht in die Datenbank, bevor Sie den Speicher anfassen, und machen Sie den Blob-Namen zu einem Wert, den die Datenbank bereits hält:

1. Fügen Sie die Zeile mit `Status = Pending`, einem generierten `BlobName` und `CreatedUtc` ein. Commit.
2. Laden Sie auf genau diesen Blob-Namen hoch, mit einem bedingten Erstellen, damit ein Retry nicht die Bytes einer anderen Anfrage überschreiben kann.
3. Aktualisieren Sie die Zeile auf `Status = Ready`. Commit.
4. Leser filtern auf `Status == Ready`. Ein Sweeper löscht `Pending`-Zeilen, die älter sind als das Anfrage-Timeout, zuerst den Blob, dann die Zeile.

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

Gehen Sie die Absturzpunkte durch. Sterben Sie nach Schritt 1, haben Sie eine `Pending`-Zeile und keinen Blob: für Leser unsichtbar, wird später aufgeräumt. Sterben Sie nach Schritt 2, haben Sie eine `Pending`-Zeile und einen Blob: weiterhin unsichtbar, und der Sweeper kennt den Blob-Namen, weil die Zeile ihn hält. Das ist die Eigenschaft, die die naive Reihenfolge nicht hat. Eine Waise, die durch "Blob zuerst" entsteht, finden Sie nur, indem Sie den gesamten Container auflisten und gegen die Tabelle abgleichen; eine Waise, die dieses Protokoll erzeugt, ist eine Zeile, die Sie mit einem Index abfragen können.

Der Sweeper ist unspektakulär, und genau das ist der Punkt:

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

Setzen Sie den Cutoff länger als Ihre maximale Anfragedauer plus den längsten Upload, den Sie akzeptieren. Ein Fenster von 15 Minuten ist großzügig für kleine Dateien und viel zu kurz, wenn Sie Uploads von mehreren Gigabyte über einen [Streaming-Endpunkt](/de/2026/04/how-to-upload-a-large-file-with-streaming-to-azure-blob-storage/) zulassen.

## Die UploadAsync-Überladung, die ein sicheres Erstellen in ein Überschreiben verwandelt

`BlobClient.UploadAsync(Stream)` erstellt ausschließlich. Das ist nicht nur als nette Zusage dokumentiert, es steht im Quellcode: jede Überladung ohne einen `BlobUploadOptions`-Parameter reicht `overwrite: false` an einen Aufruf weiter, der die Bedingung für Sie baut.

```csharp
// Azure.Storage.Blobs 12.29.2, BlobClient.cs
conditions: overwrite ? null : new BlobRequestConditions { IfNoneMatch = new ETag(Constants.Wildcard) },
```

Die Überladung, die `BlobUploadOptions` entgegennimmt, reicht Ihre Optionen unverändert weiter. Sie ergänzt nichts. In dem Moment, in dem Sie also Optionen hinzufügen, um `StorageTransferOptions`, Tags oder einen Content-Type zu setzen, verschwindet das bedingte Erstellen, sofern Sie es nicht selbst wieder hineinschreiben. Gemessen, bei zweimaligem Upload auf denselben Namen:

```text
##### I default conditions per UploadAsync overload
UploadAsync(content)                          -> HTTP 409 BlobAlreadyExists
UploadAsync(content, overwrite: false)        -> HTTP 409 BlobAlreadyExists
UploadAsync(content, new BlobUploadOptions()) -> overwrote
UploadAsync(stream)                           -> HTTP 409 BlobAlreadyExists
UploadAsync(stream, new BlobUploadOptions())  -> overwrote
```

Das ist der mit Abstand häufigste Weg, auf dem ein Datei-Upload-Endpunkt Daten verliert. Das Refactoring, das `MaximumConcurrency` für die Leistung ergänzt, entfernt zugleich den Schutz davor, dass zwei Anfragen um denselben Namen konkurrieren, und nichts im Diff sagt das.

Setzen Sie die Bedingung explizit, sobald Sie Optionen übergeben:

```csharp
new BlobUploadOptions
{
    Conditions = new BlobRequestConditions { IfNoneMatch = ETag.All },
    TransferOptions = new StorageTransferOptions { MaximumConcurrency = 16 }
}
```

Mit gesetzter Bedingung lösen sich fünf gleichzeitige Schreiber auf einen Blob-Namen sauber auf: einer gewinnt, vier bekommen einen Konflikt, und niemandes Bytes werden still ersetzt.

```text
##### G five concurrent conditional creates of the same blob name
won=1 conflict409=4 other=[] blobs=1
```

Eine Einschränkung zum Statuscode. Azurite 3.37.0 beantwortet ein bedingtes Erstellen auf einen existierenden Blob mit `409 BlobAlreadyExists`, und das passt zu dem, was die Doc-Kommentare des Azure SDK selbst beschreiben ("creates a new block blob or throws if the blob already exists"). Die Tabelle der REST-Referenz zu [bedingten Headern bei Schreiboperationen](https://learn.microsoft.com/en-us/rest/api/storageservices/specifying-conditional-headers-for-blob-service-operations) führt jedoch `412 Precondition Failed` als Antwort auf ein nicht erfülltes `If-None-Match` auf. Fangen Sie beide ab, statt auf eines zu wetten:

```csharp
catch (RequestFailedException e) when (e.Status is 409 or 412)
{
    // Someone already created this blob. For a retry of our own request
    // with the same blob name, that is success, not failure.
}
```

Dieser `catch` ist das, was den Endpunkt retry-sicher macht. Weil der Blob-Name aus der in Schritt 1 geschriebenen Zeile stammt, landet ein Client-Retry, der dieselbe Dokument-ID wiederverwendet, auf demselben Namen, das bedingte Erstellen kollidiert, und Sie behandeln es als bereits erledigt.

## Multi-Block-Uploads lassen Blöcke zurück, wenn die Bedingung fehlschlägt

Das bedingte Erstellen wird bei `Put Block List` ausgewertet, nicht bei `Put Block`. Für alles, was größer ist als `InitialTransferSize`, staged das SDK zuerst Blöcke und committet sie zuletzt, sodass ein unterlegener Schreiber seine Blöcke bereits hochgeladen und bezahlt hat, wenn er erfährt, dass er verloren hat:

```text
##### K conditional create on a staged multi-block upload
first staged upload ok, size=12582912
second staged upload -> HTTP 409 BlobAlreadyExists
blocks left uncommitted: 3
```

Diese drei nicht committeten Blöcke sind über `GetBlobsAsync` nicht sichtbar und sie sind nicht kostenlos. Laut der [Put Block Referenz](https://learn.microsoft.com/en-us/rest/api/storageservices/put-block) werden nicht committete Blöcke nur dann per Garbage Collection entfernt, wenn es innerhalb einer Woche nach dem letzten erfolgreichen `Put Block` keinen erfolgreichen `Put Block` oder `Put Block List` auf diesem Blob gibt, und jeder `Put Block` wird als Schreiboperation abgerechnet. Wenn Ihre Retry-Strategie viele große gleichzeitige Uploads auf denselben Namen umfasst, prüfen Sie Ihre Speicherrechnung, bevor Sie das für theoretisch halten.

## Sichern Sie den kompensierenden Löschvorgang mit einer Tag-Bedingung ab

Die gefährliche Anweisung in all dem ist das Löschen. Ein Sweeper mit einem leicht falschen Cutoff oder ein kompensierender Löschvorgang, der bei einer tatsächlich erfolgreichen Anfrage feuert, zerstört eine committete Datei. Blob Storage gibt Ihnen einen serverseitigen Schutz: `x-ms-if-tags`, vom SDK als `BlobRequestConditions.TagConditions` bereitgestellt. Taggen Sie den Blob beim Upload mit `state=pending`, setzen Sie ihn auf `committed`, wenn Sie die Zeile als `Ready` markieren, und machen Sie jedes Löschen davon abhängig, dass das Tag weiterhin `pending` sagt:

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

Der Dienst verweigert das Löschen. Ein Bug in Ihrem Sweeper wird zu einem 412 in einem Log statt zu einem Support-Ticket. Beachten Sie die Berechtigungen: Index-Tags sind eine Subressource, Lese- und Schreibrechte auf dem Blob reichen also nicht. Sie brauchen die SAS-Berechtigung `t` oder die RBAC-Aktion `Microsoft.Storage/storageAccounts/blobServices/containers/blobs/tags/write`, und Tags sind auf 10 pro Blob begrenzt, mit Schlüsseln von 1 bis 128 Zeichen und Werten von bis zu 256.

Zwei Dinge, die ein tag-basiertes Schema nicht für Sie leistet. `FindBlobsByTags` liest einen Index, der asynchron aktualisiert wird, ein gerade hochgeladener Blob taucht also unter Umständen eine Zeit lang nicht in einer Tag-Abfrage auf; Microsofts [Dokumentation zum Blob-Index](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-manage-find-blobs) beschreibt Indizierungsverzögerungen von unter einer Sekunde bis zu rund zehn Minuten, abhängig von der Schreibrate. Treffen Sie niemals eine Korrektheitsentscheidung auf Basis einer Tag-Abfrage. Und Blob-Index-Tags werden nur von General-Purpose-v2- und Premium-Blockblob-Konten unterstützt; auf einem Konto mit hierarchischem Namespace sind sie eine Vorschaufunktion, die sich nicht in die Lifecycle-Verwaltung integriert.

## Nutzen Sie eine Lifecycle-Richtlinie als Rückfallebene, nicht als das Aufräumen

Es ist verlockend, den Sweeper wegzulassen und eine Lifecycle-Management-Regel alles löschen zu lassen, was noch mit `state=pending` getaggt ist:

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

Diese Regel lohnt sich, aber lesen Sie ihre Grenzen, bevor Sie sich auf sie verlassen. Die Laufbedingungen sind alle in ganzen Tagen ausgedrückt, das engste Fenster, das Sie ausdrücken können, ist also ein Tag. Das Bearbeiten einer Richtlinie kann bis zu 24 Stunden dauern, bis es wirksam wird und der erste Lauf startet. Lifecycle unterstützt beim Blob-Index-Abgleich nur Gleichheitsprüfungen, mit höchstens 10 Tag-Bedingungen und 10 Präfixen pro Regel, und `blobIndexMatch` wird nur auf Konten mit flachem Namespace unterstützt. Behandeln Sie es als das, was auffängt, was Ihr Sweeper verpasst hat, einschließlich Blobs, deren Zeilen von etwas ganz anderem gelöscht wurden.

## Eine bereits vorhandene Datei ersetzen

Bei Aktualisierungen dreht sich die Reihenfolge um. Wenn eine neue Version eine alte ersetzt, laden Sie den neuen Blob unter einem neuen Namen hoch, committen Sie die Zeilenänderung, und löschen Sie erst dann den alten Blob. Löschen Sie zuerst, hinterlässt ein Rollback eine Zeile, die auf Bytes zeigt, die Sie gerade zerstört haben.

Aktivieren Sie für diesen Pfad [Soft Delete für Blobs](https://learn.microsoft.com/en-us/azure/storage/blobs/soft-delete-blob-overview) auf dem Konto. Es verwandelt ein versehentliches Löschen für die Dauer der Aufbewahrungsfrist in einen `Undelete Blob`-Aufruf, die billigste Versicherung, die es für ein System gibt, das Speicher auf Grundlage einer Datenbankzeile löscht. Denken Sie daran, dass eine Lifecycle-Löschaktion bei einem bereits soft-gelöschten Blob nicht funktioniert und dass ein tag-geschütztes Löschen das Schutz-Tag weiterhin braucht.

Wenn die Aktualisierung eher ein echtes Problem gleichzeitiger Bearbeitungen als ein Konsistenzproblem ist, liegt die Datenbankseite davon in einem [rowversion-Nebenläufigkeitstoken](/de/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/), nicht in irgendetwas in der Storage-API.

## Drei Dinge, die Sie nicht tun sollten

Rufen Sie nicht `SaveChangesAsync` auf und laden dann in derselben Anfrage ohne einen `Pending`-Zustand hoch. Das ist die Reihenfolge mit dem hängenden Zeiger, und Leser sehen ein kaputtes Dokument in dem Moment, in dem der Upload fehlschlägt.

Setzen Sie den kompensierenden Löschvorgang nicht in ein `finally`. Er läuft dann auch auf dem Erfolgspfad, sofern Sie ihn nicht mit einem Flag absichern, und die Variante, die funktioniert, ist die, die nur auf dem Fehlerpfad läuft.

Schieben Sie nicht den Upload in die Anfragepipeline und die Zeile in einen Hintergrundjob, ohne einen dauerhaften Datensatz, der beide verbindet. Wenn die Job-Queue nicht in derselben Transaktion liegt wie die Zeile, haben Sie das Problem nur verschoben; genau dafür gibt es das Transactional-Outbox-Muster, und es braucht dieselbe Eigenschaft des einen Commits wie die Inbox-Tabelle.

Die Form, die Sie im Kopf behalten sollten: die Datenbank ist die Quelle der Wahrheit darüber, was existiert, der Speicher ist der Ort, an dem die Bytes liegen, und die einzige Reihenfolge, die einen Leser nie belügt, ist die, bei der die Datenbank den Namen zuerst erfährt und zuletzt zugibt, dass das Dokument existiert.

### Weiterlesen

- [Wie Sie eine große Datei per Streaming in Azure Blob Storage hochladen](/de/2026/04/how-to-upload-a-large-file-with-streaming-to-azure-blob-storage/)
- [Idempotente Nachrichtenverarbeitung mit EF Core 11 garantieren, wenn zwei App-Instanzen dieselbe Nachricht konsumieren](/de/2026/09/how-to-guarantee-idempotent-message-processing-in-ef-core-11-with-an-inbox-table/)
- [Optimistische Nebenläufigkeit mit einem rowversion-Token in EF Core 11 implementieren](/de/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/)
- [Fix: "413 Request Entity Too Large" beim Hochladen einer Datei in ASP.NET Core 11](/de/2026/07/fix-413-request-entity-too-large-uploading-a-file-in-aspnetcore-11/)
- [Wie man eine Datei von einem ASP.NET Core Endpunkt ohne Pufferung streamt](/de/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/)

### Quellen

- [Specifying conditional headers for Blob service operations](https://learn.microsoft.com/en-us/rest/api/storageservices/specifying-conditional-headers-for-blob-service-operations), Azure Storage REST API
- [Put Block](https://learn.microsoft.com/en-us/rest/api/storageservices/put-block), Azure Storage REST API
- [Manage and find Azure Blob data with blob index tags](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-manage-find-blobs), Microsoft Learn
- [Azure Blob Storage lifecycle management overview](https://learn.microsoft.com/en-us/azure/storage/blobs/lifecycle-management-overview), Microsoft Learn
- [Lifecycle management policy structure](https://learn.microsoft.com/en-us/azure/storage/blobs/lifecycle-management-policy-structure), Microsoft Learn
- [Soft delete for blobs](https://learn.microsoft.com/en-us/azure/storage/blobs/soft-delete-blob-overview), Microsoft Learn
- [`BlobClient.cs` at tag `Azure.Storage.Blobs_12.29.2`](https://github.com/Azure/azure-sdk-for-net/blob/Azure.Storage.Blobs_12.29.2/sdk/storage/Azure.Storage.Blobs/src/BlobClient.cs), Azure SDK for .NET
- [Compensating Transaction pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/compensating-transaction), Azure Architecture Center
