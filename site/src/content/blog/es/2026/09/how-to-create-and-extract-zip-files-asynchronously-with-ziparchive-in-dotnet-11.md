---
title: "Cómo crear y extraer archivos ZIP de forma asíncrona con las APIs async de ZipArchive en .NET 11"
description: "Usa ZipFile.CreateFromDirectoryAsync, ExtractToDirectoryAsync, ZipArchive.CreateAsync y ZipArchiveEntry.OpenAsync sin I/O síncrona oculta. Medido en .NET 11 RC 1 y .NET 10.0.12, incluido el bug de .NET 10 que todavía bloquea Kestrel."
pubDate: 2026-09-14
template: how-to
tags:
  - "dotnet-11"
  - "dotnet"
  - "csharp"
  - "aspnetcore"
  - "async"
lang: "es"
translationOf: "2026/09/how-to-create-and-extract-zip-files-asynchronously-with-ziparchive-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-09-14
---

**Respuesta corta:** para carpetas completas, llama a `await ZipFile.CreateFromDirectoryAsync(dir, zipPathOrStream, ct)` y a `await ZipFile.ExtractToDirectoryAsync(zipPathOrStream, dir, ct)`. Para controlar cada entrada, abre el archivo ZIP con `await ZipArchive.CreateAsync(stream, mode, leaveOpen, entryNameEncoding: null, ct)` en lugar del constructor, abre las entradas con `await entry.OpenAsync(ct)` y libera tanto el stream de la entrada como el archivo ZIP con `await using`. Si te saltas cualquiera de esos tres `await`, `System.IO.Compression` vuelve en silencio a la I/O síncrona. Las APIs asíncronas llegaron en .NET 10, pero .NET 10 (todavía en 10.0.12) hace escrituras síncronas al liberar el stream de una entrada, incluso con `await using`. Solo .NET 11 (medido en RC 1, `11.0.0-rc.1.26425.128`) es asíncrono de principio a fin.

Todo lo que sigue se ejecutó en un Apple M4 con dos runtimes: .NET 10.0.12 (la versión de servicio actual, compilada con el SDK 10.0.302) y .NET 11 RC 1. Las pruebas envuelven el stream de destino en un `Stream` que lanza una excepción en cada `Read`, `Write` y `Flush` síncrono. Es el mismo contrato que Kestrel impone a los cuerpos de solicitud y respuesta, así que cualquier llamada síncrona oculta aparece como una excepción y no como un hilo bloqueado que nunca notas.

## La superficie asíncrona, y por qué no hay constructor asíncrono

La API nació de [dotnet/runtime#1541](https://github.com/dotnet/runtime/issues/1541), una petición abierta en la época de corefx, y se implementó en el [PR #114421](https://github.com/dotnet/runtime/pull/114421) para .NET 10. La [forma aprobada](https://github.com/dotnet/runtime/issues/1541#issuecomment-2715269236) es más pequeña que la propuesta original, y el razonamiento explica la mayoría de las trampas:

- El constructor de `ZipArchive` hace I/O (en modo lectura lee el registro de fin del directorio central), y los constructores no se pueden esperar. Por eso existe una factoría estática `ZipArchive.CreateAsync`.
- No hay `GetEntriesAsync`. Se supone que `CreateAsync` lee el directorio central antes de retornar, así que la propiedad síncrona `Entries` solo devuelve lo que ya está en memoria.
- No hay `CreateEntryAsync` ni `DeleteAsync`, porque `CreateEntry` y `Delete` no hacen I/O.
- `ZipArchive` implementa `IAsyncDisposable`, porque liberar un archivo ZIP escribible escribe el directorio central.

Así se corresponden las llamadas síncronas con sus versiones asíncronas (todas aceptan un `CancellationToken` opcional):

| Síncrono | Asíncrono (.NET 10+) |
| --- | --- |
| `new ZipArchive(stream, mode, ...)` | `ZipArchive.CreateAsync(stream, mode, leaveOpen, entryNameEncoding, ct)` |
| `archive.Dispose()` | `archive.DisposeAsync()` |
| `entry.Open()` | `entry.OpenAsync(ct)` |
| `ZipFile.Open` / `OpenRead` | `ZipFile.OpenAsync` / `OpenReadAsync` |
| `ZipFile.CreateFromDirectory` | `ZipFile.CreateFromDirectoryAsync` (destino ruta o `Stream`) |
| `ZipFile.ExtractToDirectory` | `ZipFile.ExtractToDirectoryAsync` (origen ruta o `Stream`) |
| `archive.CreateEntryFromFile` | `archive.CreateEntryFromFileAsync` |
| `archive.ExtractToDirectory` | `archive.ExtractToDirectoryAsync` |
| `entry.ExtractToFile` | `entry.ExtractToFileAsync` |

.NET 11 añade más sobrecargas encima de esto: `OpenAsync(ReadOnlySpan<char> password, ...)`, `OpenAsync(FileAccess, ...)`, `CreateEntryFromFileAsync` con contraseña y `ZipEncryptionMethod`, y sobrecargas con `ZipFileCreationOptions` / `ZipExtractionOptions` para los helpers de directorio. Las listé todas usando reflexión sobre `System.IO.Compression` en ambos runtimes. La parte de contraseñas se trata en [el artículo sobre ZIP cifrados en .NET 11](/es/2026/08/dotnet-11-preview-7-password-protected-zip-archives/).

## Pasos para ser completamente asíncrono

1. Usa los helpers de directorio `ZipFile.*Async` cuando no necesites control por entrada.
2. Si no, crea el archivo ZIP con `await ZipArchive.CreateAsync(...)` o `await ZipFile.OpenAsync(...)`, nunca con `new ZipArchive(...)`.
3. Abre cada entrada con `await entry.OpenAsync(ct)`, o usa `CreateEntryFromFileAsync` / `ExtractToFileAsync`.
4. Libera cada stream de entrada con `await using`, antes de liberar el archivo ZIP.
5. Libera el archivo ZIP con `await using`.
6. Pasa un único `CancellationToken` por todo el proceso y decide qué debe quedar en disco si se cancela una extracción.

## Comprimir y descomprimir una carpeta completa

Cuando el archivo ZIP debe reflejar un directorio, los helpers estáticos lo hacen todo:

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

Ambos helpers tienen también sobrecargas con `Stream`, que es como comprimes directamente en un stream de red o descomprimes una subida sin archivo temporal. [El artículo de .NET 8 sobre archivos ZIP a Stream](/es/2023/11/c-zip-files-to-stream/) presentó las sobrecargas síncronas con `Stream`, y las versiones asíncronas tienen la misma forma más un token.

## Construir un archivo ZIP entrada por entrada

En cuanto necesitas filtrar, renombrar o generar contenido, baja a `ZipArchive`. Aquí importan los tres `await`:

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

Limita el stream de la entrada a su propio bloque `await using`, como arriba, para que se libere antes de crear la siguiente entrada. En modo `Create` solo puede haber una entrada abierta a la vez, y liberar el stream de la entrada vacía el último bloque comprimido y escribe los tamaños y el CRC de la entrada.

La lectura funciona igual. `Entries` es una propiedad normal, y en .NET 11 ya no hace I/O después de `CreateAsync`:

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

Si escribes rutas a partir de `entry.FullName` por tu cuenta, también asumes la validación de rutas que `ExtractToDirectoryAsync` hace por ti. El helper rechaza las entradas que acabarían fuera del directorio de destino, mientras que el código hecho a mano hace lo que `Path.Combine` le diga.

## Lo que te aporta realmente cada `await`, medido

Esta es la matriz de pruebas. "Lanza" significa que el código del archivo ZIP hizo al menos una llamada síncrona sobre un stream que las prohíbe. Los streams no admiten seek salvo que la fila diga lo contrario, como el cuerpo de Kestrel.

| Escenario | .NET 10.0.12 | .NET 11 RC 1 |
| --- | --- | --- |
| `new ZipArchive` (Create) + `Open()` + `using` | lanza | lanza |
| `CreateAsync` + `OpenAsync` + `await using` en todas partes | **lanza** | funciona |
| Igual, pero `using` en el archivo ZIP | lanza | lanza |
| Igual, pero `using` en el stream de la entrada | lanza | lanza |
| `ZipFile.CreateFromDirectoryAsync(dir, stream)` | **lanza** | funciona |
| `new ZipArchive` (Read) | lanza | lanza |
| `CreateAsync` (Read) | funciona | funciona |
| `CreateAsync` (Read), stream con seek | **lanza** | funciona |
| `CreateAsync` (Read), con seek, `entry.Open()` síncrono | lanza | lanza |
| `ZipFile.ExtractToDirectoryAsync(stream, dir)` | funciona | funciona |
| `CreateAsync` (Update) sobre un stream sin seek | `ArgumentException` | `ArgumentException` |

Dos conclusiones. Primera: las filas que lanzan en .NET 11 son todas casos en los que dejaste una llamada síncrona: el constructor, `Open()` en modo lectura o un `using` simple. `Dispose()` tiene que vaciar los datos comprimidos y escribir el directorio central, y no puede hacerlo de forma asíncrona. Segunda: las filas en negrita son bugs de .NET 10, no errores tuyos.

## El bug de .NET 10: `await using` sigue escribiendo de forma síncrona

En .NET 10, el `WrappedStream` interno que `OpenAsync` devuelve en modo creación no sobrescribe `DisposeAsync`. El `Stream.DisposeAsync` base llama a `Dispose()`, así que toda la cadena de abajo se libera de forma síncrona y `DeflateStream` vacía su último bloque con un `Write` síncrono. La pila de mi prueba en .NET 10.0.12:

```text
at System.IO.Compression.DeflateStream.PurgeBuffers(Boolean disposing)
at System.IO.Compression.DeflateStream.Dispose(Boolean disposing)
at System.IO.Compression.CheckSumAndSizeWriteStream.Dispose(Boolean disposing)
at System.IO.Compression.ZipArchiveEntry.DirectToArchiveWriterStream.Dispose(Boolean disposing)
at System.IO.Compression.WrappedStream.Dispose(Boolean disposing)
```

El bug del lado de lectura es parecido: sobre un stream con seek, el `CreateAsync` de .NET 10 lee solo el registro de fin del directorio central y deja el directorio central para el primer acceso a `Entries`, que ejecuta `ReadCentralDirectory()` de forma síncrona. Los streams sin seek se libran de ese bug por accidente, porque `CreateAsync` primero los copia a un `MemoryStream` con lecturas asíncronas.

Ambos se reportaron como [dotnet/runtime#121624](https://github.com/dotnet/runtime/issues/121624) ("Asynchronous Zip Methods still have synchronous calls") y se corrigieron en el [PR #121938](https://github.com/dotnet/runtime/pull/121938), fusionado el 2025-12-01 con el milestone 11.0.0. La corrección son 18 líneas: un `DisposeAsync` real en `WrappedStream`, más un `EnsureCentralDirectoryReadAsync` anticipado en `CreateAsync` para el modo lectura. No hay backport a `release/10.0`. Las versiones de servicio de .NET 10 hasta la 10.0.12 siguen fallando, y lo reproduje en 10.0.10 y 10.0.12.

Con un `FileStream` nunca lo notarías, porque una escritura síncrona solo bloquea un hilo del thread pool un momento. Kestrel es distinto.

## Transmitir un ZIP desde un endpoint de ASP.NET Core

Este es el caso que de verdad le importa a la mayoría: construir el archivo ZIP directamente en `Response.Body`, sin archivo temporal y sin `MemoryStream`.

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

Lo ejecuté contra una carpeta de 100 archivos (64 KB cada uno) en ambos runtimes:

- **.NET 11 RC 1:** `200`, 3 499 034 bytes, y `unzip -l` lista los 100 archivos.
- **.NET 10.0.10:** `200`, **130 bytes**. Salió la cabecera local de la primera entrada, luego `DisposeAsync` llegó a la escritura síncrona, Kestrel registró `InvalidOperationException: Synchronous operations are disallowed. Call WriteAsync or set AllowSynchronousIO to true instead.` y la conexión se cortó. `unzip -t` informa `invalid compressed data to inflate`.

Ese segundo resultado es el peligroso. El código de estado ya se había enviado, así que el cliente ve una descarga exitosa de un archivo corrupto. El mismo endpoint escrito con `new ZipArchive(...)` falla en ambos runtimes, pero al menos falla con un `500`, antes de escribir ningún byte. Para más sobre esa excepción, consulta [cómo solucionar "Synchronous operations are disallowed"](/es/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed/).

Si estás atado a .NET 10, construye el archivo ZIP en un archivo temporal asíncrono y luego cópialo a la respuesta:

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

Eso devolvió un archivo ZIP válido de 3.5 MB en .NET 10.0.10, y además obtienes un `Content-Length` real. La alternativa, poner `IHttpBodyControlFeature.AllowSynchronousIO = true` para la solicitud, funciona pero bloquea un hilo por descarga. Para más sobre cómo mantener las respuestas grandes fuera del heap, consulta [transmitir un archivo desde un endpoint de ASP.NET Core sin buffering](/es/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/).

## Extraer un ZIP subido desde el cuerpo de la solicitud

La dirección contraria funciona en ambos runtimes, porque el cuerpo de la solicitud no admite seek:

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

Enviar el archivo ZIP de 100 archivos devolvió `{"entries":100,"bytes":6553600}`, mientras que la versión con `new ZipArchive(req.Body, ZipArchiveMode.Read)` devolvió `500` con la variante `ReadAsync` de la misma excepción. Hay una trampa: el índice de un ZIP está al final del archivo, así que el modo lectura sobre un stream sin seek primero copia **el archivo ZIP completo a memoria**. Mi archivo de prueba de 32 MB necesitó 253 lecturas asíncronas antes de que la primera entrada estuviera disponible. Para subidas grandes, primero transmite el cuerpo a un archivo temporal con `FileOptions.Asynchronous` (y revisa tus [límites de tamaño de solicitud](/es/2026/07/fix-413-request-entity-too-large-uploading-a-file-in-aspnetcore-11/)), y luego abre ese. Solo recuerda que en .NET 10 un origen con seek trae de vuelta la lectura síncrona de `Entries`.

## Trampas que conviene conocer antes de publicar

**La cancelación deja un directorio a medio extraer.** Cancelé `ExtractToDirectoryAsync` sobre un archivo ZIP de 1 000 entradas a los 20 ms. Lanzó `OperationCanceledException` con 129 archivos en disco, uno de ellos truncado (en .NET 10.0.12 fueron 181 archivos). Una segunda llamada sin `overwriteFiles: true` falla entonces con `IOException: The file '.../f539.bin' already exists.` Si la salida parcial importa, extrae en un directorio temporal hermano y muévelo a su sitio con `Directory.Move` solo después de que la tarea termine. Cómo fluye el token se explica en [propagar un CancellationToken a través de métodos asíncronos](/es/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/).

**Asíncrono no es más rápido.** Libera hilos mientras espera la I/O, y nada más. Comprimir 1 000 archivos (64 MB) y extraer el resultado, mediana de 7 ejecuciones con `Stopwatch` en un SSD local (no es una ejecución de BenchmarkDotNet):

| Operación | .NET 11 RC 1 síncrono | .NET 11 RC 1 asíncrono | .NET 10.0.12 síncrono | .NET 10.0.12 asíncrono |
| --- | --- | --- | --- | --- |
| `CreateFromDirectory` | 249 ms | 268 ms | 252 ms | 259 ms |
| `ExtractToDirectory` | 103 ms | 108 ms | 84 ms | 101 ms |

La compresión es trabajo de CPU, y la I/O de archivos asíncrona sobre un disco local rápido añade un poco de sobrecarga. Usa las APIs asíncronas en servidores y en hilos de UI, donde un hilo bloqueado cuesta algo. Una herramienta de consola que comprime la salida de una compilación no gana nada con ellas.

**El modo Update sigue siendo un caso especial.** `ZipArchiveMode.Update` requiere un stream que pueda leer, escribir y hacer seek (`ArgumentException: Update mode requires a stream with read, write, and seek capabilities.`), y carga las entradas en memoria a medida que las abres. Funciona con `CreateAsync` y `await using` sobre un stream con seek, pero para archivos ZIP grandes normalmente sale más barato escribir uno nuevo.

**El `Open()` síncrono no siempre es inofensivo.** En .NET 11, un `entry.Open()` síncrono en modo creación funcionó de casualidad en mi prueba, porque abrir una entrada nueva no hace I/O. En modo lectura lanza contra un stream sin operaciones síncronas en ambos runtimes. Usa `OpenAsync` en todas partes y deja de llevar la cuenta.

**¿Implementas `IAsyncDisposable` tú mismo?** El bug de .NET 10 es un ejemplo de manual de un wrapper que olvidó reenviar `DisposeAsync`. [Implementar y consumir IAsyncDisposable](/es/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/) explica cómo hacerlo bien.

### Lecturas recomendadas

- [Solución: InvalidOperationException: Synchronous operations are disallowed en ASP.NET Core](/es/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed/)
- [Cómo transmitir un archivo desde un endpoint de ASP.NET Core sin buffering](/es/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/)
- [System.IO.Compression lee y escribe ZIP cifrados en .NET 11](/es/2026/08/dotnet-11-preview-7-password-protected-zip-archives/)
- [Cómo implementar y consumir IAsyncDisposable con await using en C#](/es/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/)

### Fuentes

- [dotnet/runtime#1541: Add async ZipFile APIs](https://github.com/dotnet/runtime/issues/1541) y la [forma de API aprobada](https://github.com/dotnet/runtime/issues/1541#issuecomment-2715269236)
- [dotnet/runtime PR #114421: Zip async implementation](https://github.com/dotnet/runtime/pull/114421)
- [dotnet/runtime#121624: Asynchronous Zip Methods still have synchronous calls](https://github.com/dotnet/runtime/issues/121624)
- [dotnet/runtime PR #121938: Fix async ZipArchive calling non-async Stream methods](https://github.com/dotnet/runtime/pull/121938)
- [ZipArchive.CreateAsync en Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.compression.ziparchive.createasync)
- [ZipFile.ExtractToDirectoryAsync en Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.compression.zipfile.extracttodirectoryasync)
