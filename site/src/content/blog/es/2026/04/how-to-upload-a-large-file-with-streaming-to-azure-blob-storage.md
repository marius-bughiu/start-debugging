---
title: "Cómo subir un archivo grande mediante streaming a Azure Blob Storage"
description: "Sube archivos de varios GB a Azure Blob Storage desde .NET 11 sin cargarlos en memoria. BlockBlobClient.UploadAsync con StorageTransferOptions, MultipartReader para subidas en ASP.NET Core, y las trampas de buffering que dejan tu carga en el LOH."
pubDate: 2026-04-28
tags:
  - "azure"
  - "dotnet"
  - "dotnet-11"
  - "aspnet-core"
  - "streaming"
lang: "es"
translationOf: "2026/04/how-to-upload-a-large-file-with-streaming-to-azure-blob-storage"
translatedBy: "claude"
translationDate: 2026-04-28
---

Abre el origen como un `Stream` y pásalo directamente a `BlockBlobClient.UploadAsync(Stream, BlobUploadOptions)` con `StorageTransferOptions` configurado. El SDK de Azure trocea el stream en bloques de block-blob, los sube en paralelo y confirma la lista de bloques cuando el stream termina. Nunca asignas un `byte[]` mayor que `MaximumTransferSize`, y el stream de origen se lee una sola vez, hacia adelante. Los patrones que rompen esto en silencio son: copiar el cuerpo de la solicitud a un `MemoryStream` "para saber la longitud", llamar a `IFormFile.OpenReadStream` después de que ASP.NET Core ya ha bufferizado el formulario en memoria, y olvidar configurar `MaximumConcurrency`, lo que te deja subiendo 4 MiB cada vez en un único hilo a un servicio que aceptaría con gusto veinte stagings de bloques en paralelo.

Este post está dirigido a `Azure.Storage.Blobs` 12.22+, .NET 11 y ASP.NET Core 11. Los límites del protocolo de block-blob que se usan aquí (4000 MiB por bloque, 50 000 bloques, ~190.7 TiB en total por blob) requieren la x-ms-version `2019-12-12` o posterior, que el SDK negocia por defecto.

## La ruta de subida por defecto ya hace streaming, más o menos

`BlobClient.UploadAsync(Stream)` hace lo correcto para un stream de longitud desconocida: lee hasta `InitialTransferSize` bytes, y si el stream terminó dentro de esa ventana emite una sola solicitud `PUT Blob`. En caso contrario cambia a subidas con bloques en staging, leyendo `MaximumTransferSize` bytes a la vez y llamando `PUT Block` en paralelo hasta `MaximumConcurrency`. Una vez que el stream de origen devuelve 0 bytes, emite `PUT Block List` para confirmar el orden.

Los valores por defecto que vienen en 12.22 son `InitialTransferSize = 256 MiB`, `MaximumTransferSize = 8 MiB`, `MaximumConcurrency = 8`. Hay dos cosas mal con dejarlos así para subidas grandes. Primero, `InitialTransferSize = 256 MiB` significa que el SDK bufferizará hasta 256 MiB internamente antes de decidir si usa un único PUT, incluso si le pasaste un stream de 50 GiB que obviamente no cabe. Segundo, `MaximumConcurrency = 8` está bien para un enlace de 1 Gbps a una cuenta de almacenamiento colocalizada, pero es un cuello de botella para subidas entre regiones donde cada ida y vuelta de PUT cuesta 80-200 ms.

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

Tamaños de bloque entre 4 MiB y 16 MiB son el punto óptimo para cuentas Standard. Bloques más pequeños desperdician viajes de ida y vuelta en la sobrecarga del `PUT Block`; bloques más grandes hacen que los reintentos sean caros porque un 503 transitorio fuerza al SDK a reenviar el bloque entero.

## Los límites de block-blob deciden el tamaño de bloque por ti

Los block blobs de Azure tienen límites duros que una mentalidad de "solo hazlo streaming" terminará chocando. Hay 50 000 bloques por blob, cada bloque mide como máximo 4000 MiB, y el tamaño máximo del blob es 190.7 TiB (50 000 x 4000 MiB). Para una subida de 200 GiB, bloques de 4 MiB necesitan 51 200 bloques, uno por encima del límite. Entonces:

- Hasta ~195 GiB: cualquier tamaño de bloque a partir de 4 MiB funciona.
- 195 GiB a ~390 GiB: mínimo 8 MiB.
- 1 TiB: mínimo 21 MiB. El valor por defecto del SDK de 8 MiB fallará a mitad de subida con `BlockCountExceedsLimit`.

El SDK no aumenta el tamaño de bloque por ti. Si conoces la longitud del origen de antemano, calcula el tamaño de bloque requerido y configura `MaximumTransferSize` en consecuencia:

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

Para subidas de longitud desconocida (un archivo generado, un fan-in del lado del servidor), usa por defecto bloques de 16 MiB. Eso da margen hasta ~780 GiB sin tener que subir el límite después.

## ASP.NET Core: haz streaming del cuerpo de la solicitud, no de `IFormFile`

La forma más común de arruinar todo este pipeline es `IFormFile`. Cuando llega una subida multipart, el `FormReader` de ASP.NET Core lee el cuerpo entero en la colección de formularios antes de que tu acción se ejecute. Cualquier cosa por debajo de `FormOptions.MemoryBufferThreshold` (por defecto 64 KiB por valor de formulario, pero la parte del archivo sigue `MultipartBodyLengthLimit` de 128 MiB) va a memoria; cualquier cosa por encima va a un `Microsoft.AspNetCore.WebUtilities.FileBufferingReadStream`, que es un archivo temporal en disco. De cualquier forma, cuando se ejecuta tu manejador, la subida ya se leyó una vez y se copió a alguna parte. `IFormFile.OpenReadStream()` ahora es un `FileStream` sobre esa copia temporal.

Esto mata tres cosas a la vez. Pagas E/S de disco por un buffer que no necesitas. La solicitud tarda el doble porque los bytes viajan del socket al archivo temporal, luego del archivo temporal al SDK y a Azure. Y `MultipartBodyLengthLimit` pone un techo de 128 MiB en cada subida por defecto.

La solución es deshabilitar el binding de formulario y leer el stream multipart tú mismo con `MultipartReader`:

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

`section.Body` es un stream respaldado por la red que lee directamente del cuerpo de la solicitud. El SDK de Azure lee de ahí, lo trocea en bloques y los sube. La memoria queda acotada por `MaximumTransferSize * MaximumConcurrency` (256 MiB en el ejemplo de arriba). El atributo `[DisableFormValueModelBinding]` es un pequeño filtro personalizado que quita los proveedores de valores de formulario por defecto del framework, para que MVC no intente bindear el cuerpo antes de que tu acción se ejecute:

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

`[RequestSizeLimit]` y `[RequestFormLimits]` son ambos necesarios: el primero es el tope por solicitud del cuerpo en Kestrel, el segundo es `FormOptions.MultipartBodyLengthLimit`. Olvidar cualquiera de los dos rechaza la subida en 30 MiB o 128 MiB respectivamente, con un error que no menciona multipart.

## Autenticarse sin un SAS

`DefaultAzureCredential` de `Azure.Identity` es el valor por defecto correcto para cualquier servicio que se ejecute en Azure (App Service, AKS, Functions, Container Apps). El contenedor necesita el rol `Storage Blob Data Contributor` sobre la cuenta de almacenamiento. Localmente el mismo código funciona contra `az login` o la cuenta de Azure de VS Code.

```csharp
// .NET 11, Azure.Identity 1.13+, Azure.Storage.Blobs 12.22+
var serviceUri = new Uri($"https://{accountName}.blob.core.windows.net");
var service    = new BlobServiceClient(serviceUri, new DefaultAzureCredential());
var container  = service.GetBlobContainerClient("uploads");
await container.CreateIfNotExistsAsync(cancellationToken: ct);

var blob = container.GetBlockBlobClient(blobName);
```

Evita guardar cadenas de conexión con la clave de la cuenta en la configuración de la app. La clave autentica al nivel de la cuenta de almacenamiento, lo que significa que una clave filtrada da acceso completo a todos los contenedores y todos los blobs, incluida la eliminación. Las mismas rutas de subida funcionan con `BlobSasBuilder` si un navegador sube directamente sin pasar por tu servidor.

## Progreso, reintentos y reanudación

El SDK llama a `IProgress<long>` después de cada bloque. Úsalo para la UI, pero no para contabilidad: el valor son los bytes acumulados transferidos, incluyendo bytes que se reintentaron.

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

La capa de transporte reintenta `PUT Block` automáticamente con backoff exponencial (`RetryOptions` por defecto son 3 reintentos, 0.8 s de retraso inicial). Para una subida de varias horas en una red inestable, sube `RetryOptions.MaxRetries` y `NetworkTimeout` en `BlobClientOptions` antes de construir el cliente:

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

`UploadAsync` no es reanudable entre reinicios de proceso. Si el proceso muere, los bloques en staging que no se confirmaron quedan en la cuenta de almacenamiento hasta siete días, y luego se recolectan. Para reanudar manualmente, usa `BlockBlobClient.GetBlockListAsync(BlockListTypes.Uncommitted)` para descubrir qué se hizo staging, transmite el origen desde ese desplazamiento y llama a `CommitBlockListAsync` con la lista combinada. La mayoría de las apps no necesitan esto; reiniciar la subida desde el byte 0 es más simple y el paralelismo del SDK lo hace barato.

## CancellationToken: pásalo por todas partes

El `CancellationToken` que entregas a `UploadAsync` se respeta en cada bloque hecho staging, pero solo entre bloques. Un solo `PUT Block` no se aborta a mitad de vuelo; el SDK espera a que termine (o falle) antes de observar el token. Para un bloque de 16 MiB en un enlace de 1 Gbps eso son ~130 ms, lo cual está bien. En un enlace de 10 Mbps son 13 segundos. Si una cancelación rápida importa, baja `MaximumTransferSize` a 4 MiB para que el peor caso de bloque en vuelo sea pequeño.

La misma advertencia aplica si configuras `NetworkTimeout` muy alto. `CancellationToken` no interrumpe un socket colgado: el timeout sí. Mantén `NetworkTimeout` más pequeño que tu latencia de cancelación aceptable. El patrón de cancelación cooperativa es el mismo que se cubre en detalle en [cancelar una Task de larga duración sin interbloqueos](/es/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/): pasa el token hacia abajo, deja que `OperationCanceledException` se propague y limpia en `finally`.

## Verificar la subida

Para block blobs, el MD5 por bloque lo verifica el servicio automáticamente cuando configuras `TransactionalContentHash`, pero el SDK solo lo configura para la ruta de un único PUT, no para la ruta de bloques en staging. Para verificar la integridad de extremo a extremo con subidas troceadas, configura el hash del blob completo en `BlobHttpHeaders.ContentHash`. El servicio lo guarda y lo devuelve en `Get Blob Properties`, pero **no** lo valida en la subida. Tienes que calcularlo en el cliente y volver a verificarlo en la descarga.

```csharp
// .NET 11
using var sha = SHA256.Create();
await using var hashed = new CryptoStream(source, sha, CryptoStreamMode.Read, leaveOpen: true);

await blob.UploadAsync(hashed, options, ct);

byte[] hash = sha.Hash!;
await blob.SetHttpHeadersAsync(new BlobHttpHeaders { ContentHash = hash }, cancellationToken: ct);
```

Envolver el origen en un `CryptoStream` añade costo de CPU (~600 MB/s de SHA-256 en hardware moderno), pero es la única forma de calcular el hash sin bufferizar. Sáltatelo si el canal es HTTPS y confías en la integridad de transporte de Azure.

## Cosas que bufferizan en silencio

Incluso con la llamada correcta del SDK, tres patrones resucitarán el problema de memoria que intentabas evitar:

1. `Stream.CopyToAsync(memoryStream)` "para inspeccionar cabeceras". No hagas esto para nada más grande que unos pocos MiB. Si necesitas los bytes iniciales, lee a un `Span<byte>` asignado en stack y `Stream.Position = 0` solo si el stream soporta seek. La mayoría de los streams respaldados por red no, en cuyo caso usa un pequeño `BufferedStream`.
2. Loguear el cuerpo de la solicitud. El middleware de captura de cuerpo de Serilog/NLog puede bufferizar la carga entera para hacerla logueable. Deshabilítalo en las rutas de subida.
3. Devolver un `IActionResult` después de la subida configurando cabeceras de `Response.Body`. El formateador de `ObjectResult` del framework puede serializar un objeto de estado de vuelta en una respuesta bufferizada. Devuelve `Results.Ok()` o `NoContent()` después de una subida con streaming, no un objeto grande.

La verificación de "¿está realmente haciendo streaming?" es vigilar el working set del proceso durante una subida de 5 GiB. Con el SDK y `StorageTransferOptions` configurados como en este post, el working set debería rondar `MaximumTransferSize * MaximumConcurrency + ~50 MiB` de sobrecarga. Cualquier cosa que crezca linealmente con el tamaño de la subida es un bug en alguna parte de tu pipeline.

## Relacionados

- [Servir un archivo desde un endpoint de ASP.NET Core sin bufferizar](/es/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) cubre la imagen espejo del lado de descarga de este post.
- [Leer un CSV grande en .NET 11 sin quedarse sin memoria](/es/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) recorre el streaming con buffer acotado para parseo, que se compone bien con el patrón de subida de aquí cuando transformas en camino al blob storage.
- [Cancelar una Task de larga duración en C# sin interbloqueos](/es/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) profundiza en la propagación de `CancellationToken`, que importa para cualquier subida de varios minutos.
- [Usar `IAsyncEnumerable<T>` con EF Core 11](/es/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) para el caso de exportación con streaming en el que filas de EF Core alimentan directamente un blob.

## Enlaces de referencia

- [Notas de versión de Azure.Storage.Blobs 12.22](https://github.com/Azure/azure-sdk-for-net/blob/main/sdk/storage/Azure.Storage.Blobs/CHANGELOG.md)
- [Objetivos de escalabilidad de block blobs](https://learn.microsoft.com/en-us/rest/api/storageservices/scalability-targets-for-the-azure-blob-storage-service)
- [API REST Put Block](https://learn.microsoft.com/en-us/rest/api/storageservices/put-block)
- [Referencia de `StorageTransferOptions`](https://learn.microsoft.com/en-us/dotnet/api/azure.storage.storagetransferoptions)
- [Guía de subida de archivos grandes en ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/mvc/models/file-uploads)
