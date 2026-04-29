---
title: "Como detectar cuando un archivo termina de escribirse en .NET"
description: "FileSystemWatcher dispara Changed antes de que el escritor termine. Tres patrones confiables para .NET 11 para saber que un archivo esta totalmente escrito: abrir con FileShare.None, hacer debounce con estabilizacion de tamano y el truco de renombrado del lado del productor que evita el problema por completo."
pubDate: 2026-04-29
tags:
  - "dotnet"
  - "dotnet-11"
  - "filesystem"
  - "io"
  - "csharp"
lang: "es"
translationOf: "2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet"
translatedBy: "claude"
translationDate: 2026-04-29
---

`FileSystemWatcher` no te dice cuando un archivo esta "listo". Te dice que el sistema operativo observo un cambio. En Windows, cada llamada a `WriteFile` dispara un evento `Changed`, y `Created` se dispara en el momento en que aparece el archivo, a menudo antes de que se haya escrito un solo byte. Los patrones confiables son: (1) intentar abrir el archivo con `FileShare.None` y tratar `IOException` 0x20 / 0x21 como "todavia se esta escribiendo", reintentando con backoff; (2) sondear `FileInfo.Length` y `LastWriteTimeUtc` hasta que ambos se estabilicen en dos muestras consecutivas; o (3) cooperar con el productor para que escriba en `name.tmp` y luego haga `File.Move` al nombre final, lo cual es atomico en el mismo volumen. El patron 3 es el unico correcto sin condiciones de carrera. Los patrones 1 y 2 son como sobrevivir cuando no controlas al productor.

Este articulo apunta a .NET 11 (preview 4) y Windows / Linux / macOS. La semantica de `FileSystemWatcher` descrita abajo no ha cambiado desde .NET Core 3.1 en ninguna plataforma, y el truco del renombrado cooperativo es el mismo en POSIX y NTFS.

## Por que el enfoque obvio esta mal

El codigo ingenuo se ve asi y esta en produccion en demasiados lugares:

```csharp
// .NET 11 -- BROKEN, do not ship
var watcher = new FileSystemWatcher(@"C:\inbox", "*.csv");
watcher.Created += (_, e) =>
{
    var rows = File.ReadAllLines(e.FullPath); // throws IOException
    Process(rows);
};
watcher.EnableRaisingEvents = true;
```

`Created` se dispara cuando el sistema operativo informa que existe la entrada del directorio. El proceso de escritura no necesariamente ha hecho flush ni siquiera de un byte. En Windows el archivo puede estar abierto con `FileShare.Read` (asi que tu lectura devuelve un archivo parcial) o con `FileShare.None` (asi que tu lectura lanza `IOException: The process cannot access the file because it is being used by another process`, HRESULT `0x80070020`, error win32 32). En Linux casi siempre obtienes una lectura parcial porque no hay bloqueo obligatorio por defecto; vas a procesar silenciosamente medio CSV.

`Changed` es peor. Dependiendo de como escriba el productor, puedes obtener un evento por cada llamada a `WriteFile`, lo que significa que un archivo de 1 MB escrito en bloques de 4 KB dispara 256 eventos. Ninguno te dice que el escritor termino. No existe una notificacion `WriteFileLastTimeIPromise` porque el kernel no conoce la intencion del escritor.

Un tercer problema: muchas herramientas de copia (Explorer, `robocopy`, rsync) escriben primero a un nombre temporal oculto y despues renombran. Veras `Created` para el temporal y luego `Renamed` para el archivo final. El evento `Renamed` es al que quieres reaccionar en esos casos, pero los valores por defecto de `FileSystemWatcher.NotifyFilter` excluyen `LastWrite` en .NET 11 y en algunas plataformas excluyen `FileName`, asi que tienes que activarlo explicitamente.

## Patron 1: Abrir con FileShare.None y aplicar backoff

Si no controlas al productor, tu unico canal de observacion es "puedo abrir el archivo de forma exclusiva". El productor mantiene un handle abierto mientras escribe; una vez que cierra el handle, una apertura exclusiva tiene exito. Esto funciona en Windows, Linux y macOS (Linux ofrece bloqueos consultivos via `flock`, pero la semantica de apertura sin bloqueo de un `FileStream` regular es suficiente porque solo leemos para confirmar que el escritor ya no esta).

```csharp
// .NET 11, C# 14
using System.IO;

static async Task<FileStream?> WaitForFileAsync(
    string path,
    TimeSpan timeout,
    CancellationToken ct)
{
    var deadline = DateTime.UtcNow + timeout;
    var delay = TimeSpan.FromMilliseconds(50);

    while (DateTime.UtcNow < deadline)
    {
        try
        {
            return new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.None);
        }
        catch (IOException ex) when (IsSharingViolation(ex))
        {
            await Task.Delay(delay, ct);
            delay = TimeSpan.FromMilliseconds(Math.Min(delay.TotalMilliseconds * 2, 1000));
        }
        catch (UnauthorizedAccessException)
        {
            // ACL problem, not a sharing problem -- do not retry
            throw;
        }
    }
    return null;
}

static bool IsSharingViolation(IOException ex)
{
    // ERROR_SHARING_VIOLATION = 0x20, ERROR_LOCK_VIOLATION = 0x21
    var hr = ex.HResult & 0xFFFF;
    return hr is 0x20 or 0x21;
}
```

Tres detalles sutiles:

- **Captura `IOException`, no `Exception`**. `UnauthorizedAccessException` (ACLs) y `FileNotFoundException` (el productor aborto y borro el archivo) son bugs distintos y no deben reintentarse.
- **Inspecciona `HResult`**. En .NET Core y posteriores, `IOException.HResult` es el error win32 estandar envuelto en `0x8007xxxx` en Windows, y los mismos codigos numericos se exponen en sistemas POSIX a traves de la capa de traduccion del runtime. La violacion de uso compartido es `0x20`; la de bloqueo es `0x21`. No hagas match contra el mensaje en string -- esta localizado.
- **Backoff exponencial con tope**. Si el productor se atasca (subida de red, USB lento), sondear cada 50ms gasta CPU sin razon. Limitar a 1 segundo mantiene al worker tranquilo sin perjudicar la latencia de las escrituras rapidas.

Este patron falla en un caso especifico: un productor que abre con `FileShare.Read | FileShare.Write` (algunos uploaders con bugs hacen esto). Tu apertura exclusiva tendra exito a mitad de la escritura y leeras basura. Si lo sospechas, combina el patron 1 con el patron 2.

## Patron 2: Debounce con estabilizacion de tamano

Cuando no puedes confiar en los bloqueos de archivo (algunos productores Linux, algunos shares SMB, algunos volcados de camara), sondea el tamano y `LastWriteTimeUtc`. La regla practica: si el tamano no cambia entre dos sondeos consecutivos separados por un intervalo razonable, el escritor probablemente termino.

```csharp
// .NET 11, C# 14
static async Task<bool> WaitForStableSizeAsync(
    string path,
    TimeSpan pollInterval,
    int requiredStableSamples,
    CancellationToken ct)
{
    var fi = new FileInfo(path);
    long lastSize = -1;
    DateTime lastWrite = default;
    int stable = 0;

    while (stable < requiredStableSamples)
    {
        await Task.Delay(pollInterval, ct);
        fi.Refresh(); // FileInfo caches; Refresh forces a fresh stat call
        if (!fi.Exists) return false;

        if (fi.Length == lastSize && fi.LastWriteTimeUtc == lastWrite)
        {
            stable++;
        }
        else
        {
            stable = 0;
            lastSize = fi.Length;
            lastWrite = fi.LastWriteTimeUtc;
        }
    }
    return true;
}
```

Elige `pollInterval` segun lo que sepas del escritor:

- Disco local rapido, archivo pequeno: 100ms, 2 muestras.
- Subida de red sobre enlace de 100 Mb: 1s, 3 muestras.
- USB / tarjeta SD / SMB: 2s, 3 muestras (el cache del sistema de archivos puede enmascarar la finalizacion momentanea).

La trampa es `FileInfo.Refresh()`. Sin el, `FileInfo.Length` devuelve el valor cacheado en el momento en que se construyo el `FileInfo`, y tu bucle gira para siempre. No hay advertencia del compilador para esto; es un bug silencioso comun.

Combina con el patron 1 en produccion: sondea hasta que el tamano sea estable y luego intenta una apertura exclusiva como confirmacion final. La combinacion maneja productores tanto bien comportados como mal comportados.

## Patron 3: El productor coopera -- escribir y luego renombrar

Si controlas al escritor, no necesitas detectar nada. Escribe a `final.csv.tmp`, haz fsync, cierra y renombra a `final.csv`. El `FileSystemWatcher` del consumidor observa `Renamed` (o `Created` con la extension final) y reacciona. En el mismo volumen NTFS o ext4, `File.Move` es atomico: o el destino existe con el contenido completo, o no existe en absoluto.

```csharp
// .NET 11, C# 14 -- producer side
static async Task WriteAtomicallyAsync(
    string finalPath,
    Func<Stream, Task> writeBody,
    CancellationToken ct)
{
    var tmpPath = finalPath + ".tmp";

    await using (var fs = new FileStream(
        tmpPath,
        FileMode.Create,
        FileAccess.Write,
        FileShare.None,
        bufferSize: 81920,
        useAsync: true))
    {
        await writeBody(fs, ct);
        await fs.FlushAsync(ct);
        // FlushAsync flushes the .NET buffer; FlushToDisk forces fsync.
        // For most use cases FlushAsync + closing the handle is enough,
        // because Windows Cached Manager and the Linux page cache will
        // serialize the rename after the writes. If you must survive a
        // crash mid-write, also call:
        //   fs.Flush(flushToDisk: true);
    }

    // File.Move with overwrite=true uses MoveFileEx with MOVEFILE_REPLACE_EXISTING
    // on Windows and rename(2) on POSIX. Both are atomic on the same volume.
    File.Move(tmpPath, finalPath, overwrite: true);
}
```

Dos reglas no obvias:

- **Mismo volumen**. El renombrado atomico solo funciona dentro de un solo sistema de archivos. Escribir el temporal en `C:\temp\x.tmp` y renombrar a `D:\inbox\x.csv` es una copia-y-borrado por debajo, y el consumidor puede agarrar el archivo a mitad de la copia. Siempre coloca el `.tmp` en el directorio destino.
- **Misma familia de extensiones**. Si tu filtro del watcher es `*.csv` y el productor crea `x.csv.tmp`, el watcher no se disparara con el archivo temporal, que es lo que quieres. Si el filtro del watcher es `*` recibiras un evento `Created` para el temporal; ignora cualquier cosa que termine en `.tmp` en tu handler.

Este es el mismo patron que Git usa para actualizar refs, el mismo que SQLite usa para su journal y el mismo que los recargadores de configuracion atomicos (nginx, HAProxy) usan. Hay una razon. Si puedes cambiar al productor, hazlo y deja de leer.

## Conectarlo correctamente a FileSystemWatcher

El handler debe ser barato y delegar a una cola. `FileSystemWatcher` levanta eventos en un hilo del thread pool con un buffer interno pequeno (por defecto 8 KB en Windows). Si bloqueas en el handler, el buffer se desborda y obtienes eventos `Error` con `InternalBufferOverflowException`, perdiendo eventos en silencio.

```csharp
// .NET 11, C# 14
using System.IO;
using System.Threading.Channels;

var channel = Channel.CreateUnbounded<string>(
    new UnboundedChannelOptions { SingleReader = true });

var watcher = new FileSystemWatcher(@"C:\inbox")
{
    Filter = "*.csv",
    NotifyFilter = NotifyFilters.FileName
                 | NotifyFilters.LastWrite
                 | NotifyFilters.Size,
    InternalBufferSize = 64 * 1024, // 64 KB, max is 64 KB on most platforms
};

watcher.Created += (_, e) => channel.Writer.TryWrite(e.FullPath);
watcher.Renamed += (_, e) => channel.Writer.TryWrite(e.FullPath);
watcher.EnableRaisingEvents = true;

// Dedicated consumer
_ = Task.Run(async () =>
{
    await foreach (var path in channel.Reader.ReadAllAsync())
    {
        if (path.EndsWith(".tmp", StringComparison.OrdinalIgnoreCase)) continue;
        if (!await WaitForStableSizeAsync(path, TimeSpan.FromMilliseconds(250), 2, default))
            continue;
        await using var fs = await WaitForFileAsync(path, TimeSpan.FromSeconds(30), default);
        if (fs is null) continue;
        await ProcessAsync(fs);
    }
});
```

Tres cosas en ese codigo que pillan a la gente:

- **`InternalBufferSize`**. El valor por defecto de 8 KB es muy pequeno para cualquier carga real. Subelo al maximo de la plataforma (64 KB en Windows; el backend inotify de Linux toma de `/proc/sys/fs/inotify/max_queued_events`). El costo es memoria de proceso que nunca notaras.
- **`NotifyFilter`**. El valor por defecto en .NET 11 es `LastWrite | FileName | DirectoryName`, pero en macOS el backend kqueue ignora algunos flags; activa `Size` explicitamente para que los cambios solo de tamano (un escritor que usa `WriteFile` sin cambio de metadatos) disparen eventos.
- **Un `Channel<T>` desacopla el watcher del consumidor**. Si el consumidor tarda 5 segundos en procesar un archivo y llegan 100 eventos en esa ventana, el channel los almacena mientras el watcher retorna inmediatamente. Mira [por que los Channels superan a BlockingCollection para esta clase de productor / consumidor](/es/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/).

## Cuando el archivo esta en un share de red

SMB y NFS anaden su propio timing. `FileSystemWatcher` en una ruta UNC en Windows usa `ReadDirectoryChangesW` contra el share, pero los eventos los coalescente el redirector SMB. Puedes ver un evento `Changed` por minuto incluso para un archivo de 1 GB que se escribe continuamente. Los patrones 1 y 2 todavia funcionan, pero deberias poner `pollInterval` en el orden de 5-10 segundos; sondear un `FileInfo.Length` remoto cada 100ms genera un round-trip de metadatos por sondeo y satura el enlace.

NFS es peor: `inotify` no se dispara con cambios hechos en otros clientes, solo con cambios al mount local hechos por procesos locales. Si tu consumidor esta en el host A y el productor esta en el host B escribiendo via NFS, `FileSystemWatcher` no vera nada. La solucion es solo polling -- `Directory.EnumerateFiles` en un timer, con los patrones 1 y 2 aplicados a cada nueva entrada. No hay un camino de notificacion del kernel que te salve aqui.

## Casos limite comunes

- **El productor trunca y reescribe en el mismo lugar**. `FileSystemWatcher` disparara un solo evento `Changed` cuando aterrice el nuevo contenido. La verificacion de tamano estable del patron 2 maneja esto correctamente porque el tamano solo se estabiliza despues de que la reescritura termina. El patron 1 puede tener exito brevemente durante la ventana de truncado cuando el archivo esta vacio; combinalo con una verificacion de tamano minimo esperado si tu dominio tiene una.
- **El antivirus bloquea el archivo despues de la creacion**. Defender (Windows) y la mayoria de los productos AV empresariales abren el archivo para escanearlo cuando aparece, manteniendo `FileShare.Read` durante decenas o cientos de milisegundos. El bucle de reintento del patron 1 absorbe esto de forma transparente; solo no pongas el timeout en 100ms.
- **El archivo lo crea un proceso que se cae**. Veras `Created`, posiblemente `Changed`, y luego nada. La verificacion de tamano estable del patron 2 devuelve true despues de la ventana de polling porque no hay mas escrituras. Vas a procesar un archivo parcial. Haz que el productor coopere (patron 3) o ten un archivo centinela (`final.csv.done`) que el productor toque al final.
- **Multiples archivos escritos en sincronia** (por ejemplo, `data.csv` mas `data.idx`). Observa la aparicion del archivo secundario, no la del primario. El productor es responsable de escribir el indice despues de los datos, asi que la aparicion del indice implica que los datos estan completos.

## Lectura relacionada

- [Hacer streaming de un archivo desde ASP.NET Core sin buffering](/es/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) cubre el lado de la lectura una vez que has confirmado que el archivo esta completo.
- [Leer CSVs grandes sin OOM](/es/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) es el seguimiento natural si tus archivos del inbox son grandes.
- [Cancelar tareas de larga duracion sin deadlock](/es/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) aplica a los bucles de espera de arriba cuando quieres que respeten el shutdown.
- [Channels en lugar de BlockingCollection](/es/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) es el transporte correcto entre el watcher y el worker.

## Fuentes

- [Referencia de `FileSystemWatcher`, MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.filesystemwatcher) -- la seccion de notas de plataforma es la mas util.
- [`File.Move(string, string, bool)` MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.file.move) -- documenta la sobrecarga de renombrado atomico anadida en .NET Core 3.0.
- [Documentacion de Win32 `MoveFileEx`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexa) -- la primitiva subyacente que usa `File.Move(overwrite: true)`.
- [API `ReadDirectoryChangesW`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-readdirectorychangesw) -- explica las condiciones de buffer overflow que se traducen en `InternalBufferOverflowException`.
