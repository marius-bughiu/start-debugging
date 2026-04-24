---
title: "Como transmitir un archivo desde un endpoint de ASP.NET Core sin buffering"
description: "Sirve archivos grandes desde ASP.NET Core 11 sin cargarlos en memoria. Tres niveles: PhysicalFileResult para archivos en disco, Results.Stream para flujos arbitrarios y Response.BodyWriter para contenido generado -- con codigo para cada caso."
pubDate: 2026-04-24
tags:
  - "ASP.NET Core"
  - "dotnet"
  - ".NET 11"
  - "Performance"
  - "Streaming"
lang: "es"
translationOf: "2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering"
translatedBy: "claude"
translationDate: 2026-04-24
---

Usa `PhysicalFileResult` (o `Results.File(path, contentType)` en minimal APIs) para archivos ya en disco -- Kestrel llama a la syscall `sendfile` del sistema operativo internamente, por lo que los bytes del archivo nunca tocan la memoria administrada. Para flujos que no existen en disco -- Azure Blob, un objeto de S3, un archivo generado dinamicamente -- devuelve un `FileStreamResult` o `Results.Stream(factory, contentType)` y abre el `Stream` subyacente de forma diferida dentro del delegado factory. Para contenido completamente generado, escribe directamente en `HttpContext.Response.BodyWriter`. En los tres casos, el patron que silenciosamente destruye la escalabilidad es copiar el contenido en un `MemoryStream` primero: eso carga todo el payload en el heap administrado, generalmente en el Large Object Heap, antes de que un solo byte llegue al cliente.

Este articulo esta orientado a .NET 11 y ASP.NET Core 11 (preview 3). Todo lo de los niveles 1 y 2 ha funcionado desde .NET 6; el enfoque con `BodyWriter` se volvio ergonomico con las APIs estables de `System.IO.Pipelines` en .NET 5 y no ha cambiado desde entonces.

## Por que el buffering de respuesta es diferente de lo que imaginas

Cuando la gente dice "transmitir un archivo", normalmente quiere decir "no leerlo todo en memoria". Eso es correcto, pero hay una segunda parte: tampoco guardes la respuesta en un bufer. El middleware de cache de salida y de compresion de respuesta de ASP.NET Core pueden reintroducir el buffering de forma transparente. Si usas `AddResponseCompression` y no lo has configurado, los archivos pequeños (por debajo del umbral predeterminado de 256 bytes) nunca se comprimen, pero los archivos grandes se guardan completamente en un `MemoryStream` antes de que se escriban los bytes comprimidos. La solucion para archivos grandes es comprimir en la capa del CDN o configurar `MimeTypes` en `ResponseCompressionOptions` de forma conservadora y excluir los tipos de contenido binario de la compresion.

El buffering de respuesta tambien ocurre dentro del framework cuando devuelves un `IResult` o `ActionResult` desde una accion de controlador: el framework escribe el estado y los encabezados primero, luego llama a `ExecuteAsync` en el resultado, que es donde ocurre la transferencia real de bytes. En .NET 6, `Results.File(path, ...)` llamaba a `PhysicalFileResultExecutor.WriteFileAsync`, que delegaba en `IHttpSendFileFeature.SendFileAsync` -- la ruta sin copia. En .NET 7, una refactorizacion introdujo una regresion donde `Results.File` envolvia el `FileStream` en un `StreamPipeWriter`, omitiendo `IHttpSendFileFeature` y haciendo que el kernel copiara paginas de archivos en el espacio de usuario innecesariamente (registrado como [issue #45037](https://github.com/dotnet/aspnetcore/issues/45037)). Esa regresion fue corregida, pero ilustra que el tipo de resultado "correcto" importa para el rendimiento, no solo para la correccion.

## Nivel 1: Archivos ya en disco

Para archivos en disco, el tipo de retorno correcto es `PhysicalFileResult` en controladores MVC, o `Results.File(physicalPath, contentType)` en minimal APIs. Ambos toman una cadena de ruta fisica en lugar de un `Stream`, lo que permite al ejecutor verificar si `IHttpSendFileFeature` esta disponible en el transporte actual. Kestrel en Linux expone esta caracteristica y usa `sendfile(2)` -- los bytes van desde la cache de paginas del sistema operativo directamente al buffer del socket sin copiarse nunca en el proceso .NET. En Windows, Kestrel usa `TransmitFile` a traves de un puerto de finalizacion de I/O con el mismo efecto.

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

Dos notas sobre la ruta. Primero, no pases nombres de archivo proporcionados por el usuario directamente a `Path.Combine` sin validarlos. El codigo anterior es un esqueleto: verifica que la ruta resuelta siga dentro del directorio permitido antes de llamar a `File.Exists`. Segundo, `IWebHostEnvironment.ContentRootPath` se resuelve al directorio de trabajo de la aplicacion, no a `wwwroot`. Para activos estaticos publicos, el middleware de archivos estaticos con `app.UseStaticFiles()` ya maneja solicitudes de rango y ETags, y deberias preferirlo frente a un endpoint manual para archivos en `wwwroot`.

## Nivel 2: Transmision desde un Stream arbitrario

El objeto de S3, el Azure Blob, la columna `varbinary(max)` de la base de datos -- todos devuelven un `Stream` que no tiene una ruta correspondiente en disco, por lo que `PhysicalFileResult` no aplica. El tipo correcto aqui es `FileStreamResult` en controladores, o `Results.Stream` en minimal APIs.

El detalle critico es abrir el `Stream` de forma diferida. `Results.Stream` acepta una sobrecarga de factory `Func<Stream>`; usala para que el flujo no se abra hasta despues de que se escriban los encabezados de respuesta y se confirme que la conexion esta viva. Si el factory lanza una excepcion (por ejemplo, porque el blob ya no existe), el framework aun puede devolver un 404 antes de que se confirmen los encabezados.

```csharp
// .NET 11, ASP.NET Core 11
// Minimal API -- transmision desde Azure Blob Storage
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
        enableRangeProcessing: false); // Azure maneja los rangos en el origen; deshabilitar doble procesamiento
});
```

`Results.Stream` tiene dos sobrecargas: una toma un `Stream` directamente, la otra toma un callback `Func<Stream, Task>` (mostrado arriba). Prefiere la forma de callback cuando el origen es un flujo de red, ya que difiere el I/O hasta que el framework este listo para escribir el cuerpo de la respuesta. El callback recibe el `Stream` del cuerpo de respuesta como argumento; escribe los datos de origen en el.

Para controladores, `FileStreamResult` requiere que pases el flujo directamente. Abrelo lo mas tarde posible en el metodo de accion, y usa `FileOptions.Asynchronous | FileOptions.SequentialScan` al abrir instancias de `FileStream` para evitar bloquear el grupo de subprocesos:

```csharp
// .NET 11, ASP.NET Core 11
// MVC controller -- transmision desde sistema de archivos local via FileStreamResult
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

El framework elimina `fs` despues de que se envia la respuesta. No necesitas un bloque `using` alrededor de el.

## Nivel 3: Escritura de contenido generado en el pipe de respuesta

A veces el contenido no existe en ningun lugar -- se genera sobre la marcha: un informe renderizado a PDF, un CSV ensamblado a partir de resultados de consultas, un ZIP creado a partir de archivos seleccionados. El enfoque ingenuo es renderizar en un `MemoryStream` y luego devolverlo como `FileStreamResult`. Eso funciona, pero todo el payload tiene que estar en memoria antes de que el cliente reciba el primer byte. Para una exportacion de 200 MB, eso es 200 MB en el Large Object Heap por solicitud concurrente.

El enfoque correcto es escribir directamente en `HttpContext.Response.BodyWriter`, que es un `PipeWriter` respaldado por un grupo de buferes de 4 KB. El framework vacia al socket de forma incremental; el uso de memoria esta acotado por la ventana en vuelo, no por el tamano del archivo.

```csharp
// .NET 11, ASP.NET Core 11
// Minimal API -- transmision de un informe CSV generado
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

Nota el uso de `"id,date,amount\n"u8.ToArray()` -- un literal de cadena UTF-8 introducido en C# 11, que produce un `byte[]` sin asignacion. Para las lineas de fila, `Encoding.UTF8.GetBytes(line)` sigue asignando; para eliminarlo, solicita un bufer directamente del writer:

```csharp
// .NET 11, C# 14 -- escritura sin asignacion usando PipeWriter.GetMemory
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

`GetMemory` / `Advance` / `FlushAsync` es el patron canonico de `PipeWriter`. `FlushAsync` devuelve un `FlushResult` que te indica si el consumidor aguas abajo ha cancelado o completado (`FlushResult.IsCompleted`); en un cliente que se comporta correctamente esto raramente es verdad durante una descarga, pero verificarlo dentro del bucle te permite salir antes si el cliente se desconecta.

Dado que estas escribiendo el cuerpo de la respuesta directamente, no puedes devolver un codigo de estado despues de que la primera llamada a `FlushAsync` confirme los encabezados. Establece `ctx.Response.StatusCode` antes de escribir cualquier byte. Si tu llamada al servicio puede fallar de una forma que deberia producir un 500, verificalo antes de tocar `BodyWriter`.

Para la generacion de ZIP especificamente, .NET 11 (a traves de `System.IO.Compression`) te permite crear un `ZipArchive` que escribe en cualquier flujo escribible. Pasa un `StreamWriter` que envuelve `ctx.Response.Body` (no `BodyWriter` directamente, ya que `ZipArchive` espera un `Stream`, no un `PipeWriter`). El enfoque se cubre en el articulo [C# ZIP files to Stream](/2023/11/c-zip-files-to-stream/), que usa la nueva sobrecarga `CreateFromDirectory` agregada en .NET 8. Del mismo modo, si la exportacion esta comprimida con Zstandard, encadena el flujo compresor antes del cuerpo de respuesta -- el nuevo `ZstandardStream` integrado en [el soporte de compresion Zstandard de .NET 11](/2026/04/dotnet-11-zstandard-compression-system-io/) evita una dependencia de NuGet.

## Solicitudes de rango: descargas reanudables sin costo adicional

`EnableRangeProcessing = true` en `FileStreamResult` o `Results.File` instruye a ASP.NET Core para analizar los encabezados de solicitud `Range` y responder con `206 Partial Content`. El framework maneja todo: analizar el encabezado `Range`, buscar en el flujo (para flujos que admiten busqueda), establecer los encabezados de respuesta `Content-Range` y `Accept-Ranges`, y enviar solo el rango de bytes solicitado.

Para `PhysicalFileResult`, el procesamiento de rangos siempre esta disponible porque el framework controla el descriptor de archivo. Para `FileStreamResult`, el procesamiento de rangos solo funciona si `Stream.CanSeek` es `true`. Los flujos de Azure Blob devueltos por `BlobClient.OpenReadAsync` admiten busqueda; los flujos de `HttpResponseMessage.Content` generalmente no. Si la busqueda no esta disponible, establece `EnableRangeProcessing = false` (el valor predeterminado) y sirve sin soporte de rango o almacena en bufer el rango relevante tu mismo.

## Errores comunes que reintroducen el buffering silenciosamente

**Devolver `byte[]` desde una accion de controlador.** ASP.NET Core lo envuelve en un `FileContentResult`, que esta bien para archivos pequenos pero es terrible para archivos grandes porque el array de bytes se asigna antes de que retorne el metodo de accion.

**Llamar a `stream.ToArray()` o `MemoryStream.GetBuffer()` en un flujo de origen.** Ambos materializan el flujo completo. Si te encuentras haciendo esto antes de llamar a `Results.Stream`, estas negando el streaming.

**Establecer `Response.ContentLength` incorrectamente.** Si `ContentLength` esta establecido pero el flujo produce menos bytes (porque abortaste antes), Kestrel registrara un error de conexion. Si es demasiado pequeno, el cliente dejara de leer despues de `ContentLength` bytes y puede considerar la descarga completa aunque queden bytes. Para contenido generado dinamicamente donde la longitud es desconocida de antemano, omite `ContentLength` y deja que el cliente use codificacion chunked.

**Olvidar la cancelacion.** Una exportacion de 2 GB tarda minutos. Conectar `CancellationToken` a traves del bucle de vaciado de `PipeWriter` permite al servidor limpiar de inmediato cuando el cliente cierra la conexion. Consulta el articulo [como cancelar una tarea de larga duracion en C# sin interbloqueos](/es/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) para los patrones de cancelacion que previenen interbloqueos durante el desmontaje del flujo.

**Usar `IAsyncEnumerable<byte[]>` desde un controlador.** El formateador JSON de ASP.NET Core intentara serializar los arrays de bytes como tokens JSON en Base64 en lugar de escribirlos sin procesar. Solo usa `IAsyncEnumerable` en la capa de aplicacion para alimentar un bucle de escritura de nivel inferior; no lo devuelvas directamente como resultado de la accion para contenido binario.

**Buffering de salida comprimida.** `AddResponseCompression` con la configuracion predeterminada almacena en bufer la respuesta completa para comprimirla, lo que deshace todo lo anterior para tipos de contenido de texto. Excluye tu tipo de contenido de descarga de la compresion, comprime el origen antes de transmitir (encadena un `DeflateStream` o `ZstandardStream` antes del pipe de respuesta), o precomprime en el CDN.

## Elegir el nivel correcto

Archivo en disco con ruta conocida: `Results.File(physicalPath, contentType, enableRangeProcessing: true)`.

Blob o flujo externo: `Results.Stream(callback, contentType)` o `FileStreamResult` con un flujo que admita busqueda.

Contenido generado: escribe en `ctx.Response.BodyWriter`, establece los encabezados antes del primer `FlushAsync`, y pasa `CancellationToken` a traves del bucle.

El hilo comun es mantener el pipeline abierto y dejar que los datos fluyan a traves de el. En el momento en que almacenas en bufer todo el payload, has pasado de un endpoint con memoria O(1) a uno con memoria O(N), y bajo carga concurrente esos valores de N se acumulan hasta que el proceso muere.

Por la misma razon por la que el streaming importa aqui, tambien importa al leer entradas grandes: el articulo [como leer un CSV grande en .NET 11 sin quedarse sin memoria](/es/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) muestra el mismo compromiso desde el lado de la ingesta.

## Fuentes

- [FileStreamResult en MS Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.mvc.filestreamresult)
- [Results.Stream en MS Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.results.stream)
- [IHttpSendFileFeature.SendFileAsync en MS Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.features.ihttpsendfilefeature.sendfileasync)
- [System.IO.Pipelines en MS Learn](https://learn.microsoft.com/en-us/dotnet/standard/io/pipelines)
- [dotnet/aspnetcore issue #45037 -- regresion de Results.File en .NET 7](https://github.com/dotnet/aspnetcore/issues/45037)
- [dotnet/aspnetcore issue #55606 -- I/O excesivo en FileStreamResult](https://github.com/dotnet/aspnetcore/issues/55606)
- [Compresion de respuesta en ASP.NET Core en MS Learn](https://learn.microsoft.com/en-us/aspnet/core/performance/response-compression)
