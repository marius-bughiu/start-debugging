---
title: "Cómo mantener consistentes una escritura en base de datos y una subida a Azure Blob Storage en una sola solicitud de ASP.NET Core"
description: "No existe ninguna transacción que abarque SQL Server y Blob Storage. Sube a un nombre que la base de datos ya conoce, confirma en segundo lugar, compensa ante el fallo y deja que un barredor limpie la ventana de caída. Con la sobrecarga de UploadAsync que convierte en silencio una creación condicional en una sobrescritura."
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
lang: "es"
translationOf: "2026/09/how-to-keep-a-database-write-and-an-azure-blob-upload-consistent-in-one-request"
translatedBy: "claude"
translationDate: 2026-09-20
---

Respuesta corta: no puedes. Ninguna transacción abarca una base de datos relacional y Azure Blob Storage, así que deja de intentar que las dos confirmen juntas y haz que el fallo sea sobrevivible. Escribe primero la fila de la base de datos, en su propia transacción confirmada, con estado `Pending` y el nombre del blob que estás a punto de usar; sube a exactamente ese nombre con una creación condicional; luego cambia la fila a `Ready` en una segunda transacción. Cada punto de caída deja o bien una fila sin blob o bien un blob sin fila visible, y ambos los puede resolver un barredor, pero nunca una fila que apunta a un blob que no existe. Vale la pena agregar eliminaciones compensatorias en un bloque `catch`, pero son una optimización, no el argumento de corrección.

Este artículo recorre los cuatro ordenamientos entre los que puedes elegir, qué deja cada uno atrás cuando falla, y los comportamientos del SDK de Azure que deciden si tu reintento es idempotente o destructivo.

Una nota sobre versiones y verificación. Todo lo que sigue se ejecutó con el SDK de .NET 11 RC 1 (`11.0.100-rc.1.26425.128`) con `Azure.Storage.Blobs` 12.29.2 y `Microsoft.EntityFrameworkCore.Sqlite` 11.0.0-rc.1.26425.128. En esta máquina no hay suscripción de Azure, así que las llamadas de almacenamiento corren contra el emulador Azurite 3.37.0, que implementa la API REST de Blob de forma local. Donde el emulador y el servicio en producción podrían diferir de manera plausible lo digo y cito la referencia REST. El lado de la base de datos usa SQLite con un índice único que hace las veces de la restricción que tenga tu esquema real.

## Por qué no hay ninguna transacción a la que recurrir

Blob Storage es un servicio HTTP. No tiene confirmación en dos fases, ni gestor de recursos XA, ni gancho de inscripción. `TransactionScope` envolverá tan campante una llamada `PutBlob` y luego revertirá a su alrededor, y el blob seguirá ahí después. Lo mismo con una transacción de EF Core:

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

La fila desapareció y el blob no. Ese es todo el problema en dos líneas. Como no puedes conseguir atomicidad, la pregunta de diseño pasa a ser: ¿qué estado inconsistente quieres que sea posible, y quién lo limpia?

Solo hay dos ordenamientos y cada uno tiene un modo de fallo distinto.

**Blob primero, fila después.** Si la escritura en la base de datos falla, tienes un blob huérfano: almacenamiento que pagas y que nada referencia. Nadie ve un enlace roto.

**Fila primero, blob después.** Si la subida falla, tienes una fila que apunta a un blob que no existe. Cada lector que siga ese puntero recibe un 404.

Los blobs huérfanos cuestan dinero. Los punteros colgantes cuestan corrección. Prefiere el huérfano, y luego haz que sea barato encontrarlo.

## La versión ingenua y lo que deja atrás

El handler que todo el mundo escribe primero sube y después guarda:

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

Dale un nombre que colisione con un índice único y el guardado lanza una excepción cuando los bytes ya están en el contenedor:

```text
##### A naive: upload then SaveChanges fails
SaveChanges threw SqliteException: SQLite Error 19: 'UNIQUE constraint failed: Documents.Name'
rows=1 blobs=1 orphaned=1
```

El parche obvio es una eliminación compensatoria, y sí funciona cuando el fallo es una excepción que capturas:

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

Fíjate en el `ChangeTracker.Clear()`. Después de un `SaveChangesAsync` fallido las entidades siguen en estado `Added` en el tracker, así que cualquier cosa que reutilice el contexto, incluido un reintento sobre el mismo `DbContext` con ámbito scoped, volverá a intentar el mismo insert. Esta es la misma forma de fallo que se describe en [garantizar el procesamiento idempotente de mensajes con una tabla inbox](/es/2026/09/how-to-guarantee-idempotent-message-processing-in-ef-core-11-with-an-inbox-table/).

Puedes sacar la compensación del endpoint por completo con un interceptor de EF Core, algo que vale la pena si más de un handler hace subidas:

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

Registra `PendingBlobs` como scoped, agrégale el nombre del blob justo después de la subida, y `SaveChangesFailedAsync` se dispara en cualquier guardado fallido:

```text
##### F SaveChangesFailedAsync interceptor runs the compensating delete
interceptor: SaveChangesFailedAsync fired for DbUpdateException
rows=1 blobs=0
```

Esto es genuinamente útil y sigue sin ser un argumento de corrección. La eliminación compensatoria solo se ejecuta cuando tu proceso está vivo para ejecutarla. Un pod desalojado entre la subida y la confirmación, un timeout del pool de conexiones que mata la solicitud, una `TaskCanceledException` porque el cliente se desconecta: ninguno de esos te da un bloque `catch`. En cualquier despliegue real vas a acumular huérfanos, así que necesitas un protocolo que te permita identificarlos más tarde.

## El protocolo que sobrevive a una caída

Escribe la intención en la base de datos antes de tocar el almacenamiento, y haz que el nombre del blob sea un valor que la base de datos ya tiene:

1. Inserta la fila con `Status = Pending`, un `BlobName` generado y `CreatedUtc`. Confirma.
2. Sube a ese nombre de blob exacto, con una creación condicional para que un reintento no pueda pisar los bytes de otra solicitud.
3. Actualiza la fila a `Status = Ready`. Confirma.
4. Los lectores filtran por `Status == Ready`. Un barredor elimina las filas `Pending` más viejas que el timeout de la solicitud, primero el blob y luego la fila.

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

Recorre los puntos de caída. Muere después del paso 1 y tienes una fila `Pending` y ningún blob: invisible para los lectores, barrido más tarde. Muere después del paso 2 y tienes una fila `Pending` y un blob: sigue siendo invisible, y el barredor conoce el nombre del blob porque la fila lo guarda. Esa es la propiedad que el ordenamiento ingenuo no tiene. Un huérfano creado por "blob primero" solo se puede encontrar listando el contenedor entero y comparándolo con la tabla; un huérfano creado por este protocolo es una fila que puedes consultar con un índice.

El barredor no tiene nada de particular, y ese es el punto:

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

Pon el corte más largo que la duración máxima de tus solicitudes más la subida más larga que aceptes. Una ventana de 15 minutos es generosa para archivos pequeños y demasiado corta si permites subidas de varios gigabytes a través de un [endpoint con streaming](/es/2026/04/how-to-upload-a-large-file-with-streaming-to-azure-blob-storage/).

## La sobrecarga de UploadAsync que convierte una creación segura en una sobrescritura

`BlobClient.UploadAsync(Stream)` es solo de creación. No está documentado como un detalle amable, está en el código fuente: cada sobrecarga sin un parámetro `BlobUploadOptions` pasa `overwrite: false` hacia una llamada que construye la condición por ti.

```csharp
// Azure.Storage.Blobs 12.29.2, BlobClient.cs
conditions: overwrite ? null : new BlobRequestConditions { IfNoneMatch = new ETag(Constants.Wildcard) },
```

La sobrecarga que recibe `BlobUploadOptions` pasa tus opciones tal cual. No inyecta nada. Así que en el momento en que agregas opciones para configurar `StorageTransferOptions`, o etiquetas, o un content type, la creación condicional desaparece a menos que tú mismo la vuelvas a escribir. Medido, subiendo dos veces al mismo nombre:

```text
##### I default conditions per UploadAsync overload
UploadAsync(content)                          -> HTTP 409 BlobAlreadyExists
UploadAsync(content, overwrite: false)        -> HTTP 409 BlobAlreadyExists
UploadAsync(content, new BlobUploadOptions()) -> overwrote
UploadAsync(stream)                           -> HTTP 409 BlobAlreadyExists
UploadAsync(stream, new BlobUploadOptions())  -> overwrote
```

Esta es la forma más común en que un endpoint de subida de archivos pierde datos. La refactorización que agrega `MaximumConcurrency` por rendimiento también quita la protección contra dos solicitudes compitiendo por el mismo nombre, y nada en el diff lo dice.

Configura la condición de forma explícita siempre que pases opciones:

```csharp
new BlobUploadOptions
{
    Conditions = new BlobRequestConditions { IfNoneMatch = ETag.All },
    TransferOptions = new StorageTransferOptions { MaximumConcurrency = 16 }
}
```

Con la condición en su lugar, cinco escritores concurrentes sobre un mismo nombre de blob se resuelven limpiamente: uno gana, cuatro reciben un conflicto, y a nadie le reemplazan los bytes en silencio.

```text
##### G five concurrent conditional creates of the same blob name
won=1 conflict409=4 other=[] blobs=1
```

Una advertencia sobre el código de estado. Azurite 3.37.0 responde a una creación condicional contra un blob existente con `409 BlobAlreadyExists`, y eso coincide con lo que describen los propios comentarios de documentación del SDK de Azure ("crea un nuevo block blob o lanza si el blob ya existe"). Pero la tabla de la referencia REST sobre [encabezados condicionales en operaciones de escritura](https://learn.microsoft.com/en-us/rest/api/storageservices/specifying-conditional-headers-for-blob-service-operations) lista `412 Precondition Failed` como respuesta para un `If-None-Match` no cumplido. Contempla los dos en lugar de apostar por uno:

```csharp
catch (RequestFailedException e) when (e.Status is 409 or 412)
{
    // Someone already created this blob. For a retry of our own request
    // with the same blob name, that is success, not failure.
}
```

Ese `catch` es lo que hace que el endpoint sea seguro de reintentar. Como el nombre del blob viene de la fila escrita en el paso 1, un reintento del cliente que reutiliza el mismo id de documento cae en el mismo nombre, la creación condicional entra en conflicto, y lo tratas como ya hecho.

## Las subidas multibloque dejan bloques atrás cuando la condición falla

La creación condicional se evalúa en `Put Block List`, no en `Put Block`. Para cualquier cosa mayor que `InitialTransferSize` el SDK primero sube los bloques por etapas y los confirma al final, así que un escritor perdedor ya pagó por subir sus bloques cuando se entera de que perdió:

```text
##### K conditional create on a staged multi-block upload
first staged upload ok, size=12582912
second staged upload -> HTTP 409 BlobAlreadyExists
blocks left uncommitted: 3
```

Esos tres bloques sin confirmar no se ven a través de `GetBlobsAsync` y no son gratis. Según la [referencia de Put Block](https://learn.microsoft.com/en-us/rest/api/storageservices/put-block), los bloques sin confirmar solo se recolectan como basura si no hay ningún `Put Block` o `Put Block List` exitoso sobre ese blob dentro de la semana siguiente al último `Put Block` exitoso, y cada `Put Block` se factura como una operación de escritura. Si tu historia de reintentos implica muchas subidas grandes concurrentes al mismo nombre, revisa tu factura de almacenamiento antes de decidir que esto es teórico.

## Protege la eliminación compensatoria con una condición de etiqueta

La instrucción peligrosa en todo esto es la eliminación. Un barredor con un corte un poco equivocado, o una eliminación compensatoria que se dispara sobre una solicitud que en realidad tuvo éxito, destruye un archivo ya confirmado. Blob Storage te da una protección del lado del servidor: `x-ms-if-tags`, expuesta por el SDK como `BlobRequestConditions.TagConditions`. Etiqueta el blob con `state=pending` al subirlo, ponlo en `committed` cuando marques la fila como `Ready`, y haz que cada eliminación sea condicional a que la etiqueta siga diciendo `pending`:

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

El servicio rechaza la eliminación. Un bug en tu barredor se convierte en un 412 en un registro de eventos en lugar de un ticket de soporte. Fíjate en los permisos: las etiquetas de índice son un subrecurso, así que los permisos de lectura y escritura de blobs no alcanzan. Necesitas el permiso SAS `t` o la acción RBAC `Microsoft.Storage/storageAccounts/blobServices/containers/blobs/tags/write`, y las etiquetas están limitadas a 10 por blob, con claves de 1 a 128 caracteres y valores de hasta 256.

Dos cosas que un esquema basado en etiquetas no hará por ti. `FindBlobsByTags` lee un índice que se actualiza de forma asíncrona, así que un blob recién subido puede no aparecer en una consulta por etiquetas durante un rato; la [documentación del índice de blobs](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-manage-find-blobs) de Microsoft describe retrasos de indexación que van de menos de un segundo a unos diez minutos según la tasa de escritura. Nunca bases una decisión de corrección en una consulta por etiquetas. Y las etiquetas de índice de blob solo están soportadas en cuentas de uso general v2 y de block blob premium; en una cuenta con espacio de nombres jerárquico son una característica en versión preliminar que no se integra con la gestión del ciclo de vida.

## Usa una política de ciclo de vida como red de seguridad, no como la limpieza

Es tentador saltarse el barredor y dejar que una regla de gestión del ciclo de vida elimine todo lo que siga etiquetado como `state=pending`:

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

Vale la pena tener esa regla, pero lee sus límites antes de depender de ella. Las condiciones de ejecución se expresan todas en días completos, así que la ventana más ajustada que puedes expresar es de un día. Editar una política puede tardar hasta 24 horas en surtir efecto y en que arranque la primera ejecución. El ciclo de vida solo soporta comprobaciones de igualdad en la coincidencia por índice de blob, con un máximo de 10 condiciones de etiqueta y 10 prefijos por regla, y `blobIndexMatch` solo está soportado en cuentas con espacio de nombres plano. Trátala como lo que atrapa lo que a tu barredor se le escapó, incluidos los blobs cuyas filas fueron eliminadas por algo completamente distinto.

## Reemplazar un archivo que ya está ahí

Las actualizaciones son donde el ordenamiento se invierte. Cuando una versión nueva reemplaza a una vieja, sube el blob nuevo con un nombre nuevo, confirma el cambio de la fila, y solo entonces elimina el blob viejo. Elimina primero y una reversión deja la fila apuntando a bytes que acabas de destruir.

Para ese camino, habilita [soft delete para blobs](https://learn.microsoft.com/en-us/azure/storage/blobs/soft-delete-blob-overview) en la cuenta. Convierte una eliminación equivocada en una llamada `Undelete Blob` durante lo que dure el periodo de retención, que es el seguro más barato disponible para cualquier sistema que elimine almacenamiento basándose en una fila de la base de datos. Ten en cuenta que una acción de eliminación del ciclo de vida no funciona sobre un blob que ya está en soft delete, y que una eliminación protegida por etiqueta necesita que la etiqueta de protección siga presente.

Si la actualización es un problema genuino de edición concurrente y no un problema de consistencia, el lado de la base de datos es un [token de concurrencia rowversion](/es/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/), no nada de la API de almacenamiento.

## Tres cosas que no debes hacer

No llames a `SaveChangesAsync` y después subas dentro de la misma solicitud sin un estado `Pending`. Ese es el ordenamiento del puntero colgante, y los lectores ven un documento roto en el instante en que la subida falla.

No pongas la eliminación compensatoria en un `finally`. También se ejecuta en el camino de éxito, a menos que la protejas con una bandera, y la versión que funciona es la que solo se ejecuta en el camino de fallo.

No empujes la subida al pipeline de la solicitud y la fila a un trabajo en segundo plano sin un registro durable que las conecte. Si la cola de trabajos no está en la misma transacción que la fila, solo moviste el problema; ese es exactamente el caso para el que existe el patrón transactional outbox, y necesita la misma propiedad de "una sola confirmación" que la tabla inbox.

La forma que conviene tener en la cabeza: la base de datos es la fuente de verdad sobre qué existe, el almacenamiento es donde viven los bytes, y el único ordenamiento que nunca le miente a un lector es aquel en el que la base de datos aprende el nombre primero y admite que el documento existe al final.

### Lee a continuación

- [Cómo subir un archivo grande mediante streaming a Azure Blob Storage](/es/2026/04/how-to-upload-a-large-file-with-streaming-to-azure-blob-storage/)
- [Cómo garantizar el procesamiento idempotente de mensajes con EF Core 11 cuando dos instancias de la app consumen el mismo mensaje](/es/2026/09/how-to-guarantee-idempotent-message-processing-in-ef-core-11-with-an-inbox-table/)
- [Cómo implementar concurrencia optimista con un token rowversion en EF Core 11](/es/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/)
- [Solución: 413 Request Entity Too Large al subir un archivo en ASP.NET Core 11](/es/2026/07/fix-413-request-entity-too-large-uploading-a-file-in-aspnetcore-11/)
- [Cómo transmitir un archivo desde un endpoint de ASP.NET Core sin buffering](/es/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/)

### Fuentes

- [Specifying conditional headers for Blob service operations](https://learn.microsoft.com/en-us/rest/api/storageservices/specifying-conditional-headers-for-blob-service-operations), Azure Storage REST API
- [Put Block](https://learn.microsoft.com/en-us/rest/api/storageservices/put-block), Azure Storage REST API
- [Manage and find Azure Blob data with blob index tags](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-manage-find-blobs), Microsoft Learn
- [Azure Blob Storage lifecycle management overview](https://learn.microsoft.com/en-us/azure/storage/blobs/lifecycle-management-overview), Microsoft Learn
- [Lifecycle management policy structure](https://learn.microsoft.com/en-us/azure/storage/blobs/lifecycle-management-policy-structure), Microsoft Learn
- [Soft delete for blobs](https://learn.microsoft.com/en-us/azure/storage/blobs/soft-delete-blob-overview), Microsoft Learn
- [`BlobClient.cs` at tag `Azure.Storage.Blobs_12.29.2`](https://github.com/Azure/azure-sdk-for-net/blob/Azure.Storage.Blobs_12.29.2/sdk/storage/Azure.Storage.Blobs/src/BlobClient.cs), Azure SDK for .NET
- [Compensating Transaction pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/compensating-transaction), Azure Architecture Center
