---
title: "FileSystemWatcher vs sondeo para detectar cambios de archivos en un recurso compartido de red en .NET"
description: "En un recurso compartido SMB o NFS, el sondeo es la fuente de verdad y FileSystemWatcher es, como mucho, una pista. FileSystemWatcher no detecta los cambios remotos en Linux y macOS, desborda su búfer de red de 64 KB y se detiene para siempre cuando se cae la conexión. Usa una comparación periódica de instantáneas y deja que el watcher solo adelante un escaneo. Verificado en .NET 10.0.10."
pubDate: 2026-10-14
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "csharp"
  - "filesystem"
  - "io"
lang: "es"
translationOf: "2026/10/filesystemwatcher-vs-polling-for-detecting-file-changes-on-a-network-share-in-dotnet"
translatedBy: "claude"
translationDate: 2026-10-14
---

Si la carpeta que vigilas vive en un recurso compartido de red, gana el sondeo. Toma una instantánea periódica del directorio y compárala con la anterior: es el único mecanismo que ve todos los cambios en todos los sistemas operativos, sobrevive a las desconexiones y del que se puede razonar. `FileSystemWatcher` sigue siendo útil en clientes Windows que hablan con SMB, pero solo como una pista que adelanta el siguiente escaneo. Nunca dejes que sea la única vía por la que te enteras de que llegó un archivo.

Todo lo que sigue aplica a `System.IO.FileSystemWatcher` y `Microsoft.Extensions.FileProviders.Physical` tal como se distribuyen en .NET 10 (ejecuté el código en .NET 10.0.10, SDK 10.0.302, C# 14) y en los release candidates de .NET 11. El código fuente relevante no ha cambiado de forma significativa desde .NET Core 3.1, así que el consejo también vale para .NET 8 y 9.

## La comparación de un vistazo

| | `FileSystemWatcher` en un recurso compartido | Sondeo de una instantánea |
| --- | --- | --- |
| Cliente Windows, recurso SMB 2/3 | Funciona, mediante `ReadDirectoryChangesW` reenviado al servidor | Funciona |
| Cliente Linux, montaje CIFS o NFS | Solo ve los cambios hechos por la máquina local | Funciona |
| Cliente macOS, montaje SMB o NFS | En la práctica solo ve los cambios locales | Funciona |
| Latencia | Menos de un segundo cuando funciona | Tu intervalo de sondeo, más el caché de metadatos del cliente (hasta 10 s en SMB de Windows, hasta 60 s en NFS) |
| Ráfaga de cambios | Búfer limitado a 64 KB en rutas de red, el desbordamiento descarta todo el detalle | No le afecta, la siguiente comparación ve el estado final |
| Caída de la conexión | Evento `Error`, luego `EnableRaisingEvents` pasa a `false` y se queda así | El escaneo falla, reintentas en el siguiente ciclo |
| Cambios hechos mientras estabas desconectado | Perdidos | Se ven en el primer escaneo exitoso |
| Costo cuando nada cambia | Casi cero | Un listado de directorio por intervalo |
| Puede decirte *qué* cambió | Sí, por evento | Sí, comparando instantáneas |

Cada fila de la columna del "watcher" lleva un asterisco, y ninguna de la columna de sondeo. Esa asimetría es todo el argumento.

## Por qué FileSystemWatcher es frágil en un recurso compartido de red

`FileSystemWatcher` es un envoltorio delgado sobre lo que le entregue el sistema operativo: `ReadDirectoryChangesW` en Windows, `inotify` en Linux, FSEvents en macOS. Cada uno de ellos se diseñó pensando en un sistema de archivos local, donde el kernel ve cada escritura porque toda escritura pasa por él. Un recurso compartido de red rompe esa suposición.

**En Linux y macOS, las escrituras remotas son invisibles.** `inotify` se dispara cuando el kernel local realiza una operación sobre el archivo. Cuando otra máquina escribe en la misma exportación NFS o recurso SMB, tu kernel nunca procesa esa escritura, así que no se genera ningún evento. Recibes eventos de las escrituras de tu propio proceso y nada de las de nadie más. El desarrollador del kernel de Linux J. Bruce Fields lo dijo claramente en [una discusión de LWN](https://lwn.net/Articles/757833/): la notificación del lado del cliente requeriría un protocolo muy "chatty" para enterarse de los cambios hechos por otros clientes, y NFS no tiene uno. Lo mismo ocurre con los montajes CIFS. Si tu consumidor corre en un contenedor Linux y el productor es una máquina Windows que deja archivos en un recurso compartido, un `FileSystemWatcher` se quedará esperando en silencio para siempre.

**En Windows, el techo de 64 KB duele.** Un cliente Windows contra un servidor SMB 2 o SMB 3 sí recibe notificaciones remotas reales: el redirector envía una solicitud `CHANGE_NOTIFY` al servidor y el servidor responde cuando algo cambia. Pero la [documentación de `ReadDirectoryChangesW`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-readdirectorychangesw) indica que la llamada "fails with ERROR_INVALID_PARAMETER when the buffer length is greater than 64 KB and the application is monitoring a directory over the network". La [documentación de `FileSystemWatcher`](https://learn.microsoft.com/en-us/dotnet/api/system.io.filesystemwatcher) repite el límite. El `InternalBufferSize` predeterminado es de 8 KB, cada registro `FILE_NOTIFY_INFORMATION` ocupa 12 bytes más el nombre de archivo en UTF-16, así que con nombres de 40 caracteres caben unos 90 eventos en 8 KB y unos 700 en 64 KB. Un trabajo por lotes que deja 2 000 archivos en un segundo desbordará cualquiera de los dos.

Cuando el búfer se desborda, el sistema operativo descarta el lote completo. `ReadDirectoryChangesW` devuelve éxito con cero bytes, y el runtime lo convierte en un evento `Error` que lleva una `InternalBufferOverflowException` ("Too many changes at once in directory"). Sabes que te perdiste algo, pero no qué.

**En Windows, una conexión caída deshabilita el watcher.** Este es el que provoca el incidente de las 3 a. m. Esta es la parte relevante de `ReadDirectoryChangesCallback` en [`FileSystemWatcher.Windows.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.IO.FileSystem.Watcher/src/System/IO/FileSystemWatcher.Windows.cs):

```csharp
// dotnet/runtime main, System.IO.FileSystem.Watcher (unchanged since .NET Core 3.x)
if (errorCode != 0)
{
    const int ERROR_OPERATION_ABORTED = 995;
    if (errorCode != ERROR_OPERATION_ABORTED)
    {
        EnableRaisingEvents = false;
        OnError(new ErrorEventArgs(new Win32Exception((int)errorCode)));
    }
    return;
}
```

Cuando el servidor de archivos se reinicia, la VPN parpadea o la sesión SMB expira, la lectura pendiente se completa con un error como `ERROR_NETNAME_DELETED` (64, "The specified network name is no longer available"). El watcher lanza `Error` una vez, establece `EnableRaisingEvents = false` y nunca vuelve por sí solo. Si nadie se suscribió a `Error`, el proceso sigue ejecutándose, parece sano y no procesa nada. Ten en cuenta también que un fallo inicial, como un búfer de más de 64 KB en una ruta UNC, aparece de la misma manera: como un evento `Error`, no como una excepción del setter de `EnableRaisingEvents = true`.

## El ejemplo mínimo del fallo silencioso

Este es el código que aparece en la mayoría de las preguntas del tipo "mi watcher dejó de funcionar":

```csharp
// .NET 10, C# 14 -- the naive version. Do not ship this against a share.
using var watcher = new FileSystemWatcher(@"\\fileserver\drop", "*.csv");
watcher.Created += (_, e) => Process(e.FullPath);
watcher.EnableRaisingEvents = true;

Console.ReadLine();

static void Process(string path) => Console.WriteLine($"Got {path}");
```

Ejecútalo en Windows, deja un archivo en el recurso compartido y funciona. Reinicia el servidor de archivos, o desconecta el cable de red durante un minuto, y deja de imprimir para siempre, sin excepción y sin una línea de registro. Ejecuta el mismo código en un contenedor Linux con `/mnt/drop` montado por CIFS y nunca imprime nada, a menos que el archivo se cree desde dentro del mismo contenedor.

## Sondeo, bien hecho

El sondeo tiene mala reputación porque la gente lo implementa mal: listan el directorio, abren cada archivo y comparan el contenido. Un buen sondeo es un único listado de directorio que captura nombre, tamaño y hora de última escritura de cada entrada, comparado con el listado anterior.

La forma más barata de obtenerlo en .NET es `FileSystemEnumerable<T>` de `System.IO.Enumeration`. Te permite proyectar cada `FileSystemEntry` directamente a la tupla que necesitas, sin asignar un `FileInfo` por archivo. En Windows, `Length` y `LastWriteTimeUtc` salen de los propios datos de enumeración del directorio (`FindFirstFileEx` y similares), así que sobre SMB todo el listado son unos pocos intercambios `QUERY_DIRECTORY` en lugar de un viaje de ida y vuelta por archivo. En Linux y macOS, `readdir` solo devuelve nombres, así que cada entrada cuesta un `stat` adicional, que un cliente CIFS o NFS suele atender desde su caché de atributos.

Para tener una idea del piso de CPU de un escaneo, medí el método `TakeSnapshot` de la implementación completa de abajo contra directorios locales en APFS, en un Apple M4 (macOS 26.6, .NET 10.0.10, compilación Release, promedio de 20 ejecuciones tras 3 de calentamiento):

| Archivos en el directorio | Tiempo por escaneo | Memoria asignada por escaneo |
| --- | --- | --- |
| 1 000 | 1.8 ms | 0.29 MB |
| 10 000 | 20.5 ms | 2.83 MB |
| 50 000 | 93.1 ms | 13.39 MB |

Por red esas cifras crecen con la latencia y el tamaño del listado, pero la forma sigue siendo la misma: un listado por intervalo. Sondear una carpeta de entrega con unos pocos miles de archivos cada 5 a 30 segundos no es una carga que nadie note. Sondear 500 000 archivos cada segundo sí lo es, y la respuesta ahí es particionar la carpeta (una subcarpeta por día o por productor), no cambiar a un watcher.

## El enfoque híbrido: sondeo como verdad, watcher como pista

El diseño que aguanta en producción combina ambos:

1. Mantén una instantánea (`path -> (length, lastWriteUtc)`) en memoria.
2. Vuelve a escanear a intervalos fijos y compara contra la instantánea. Esta es la única ruta de código que emite `Created`, `Changed` y `Deleted`.
3. Si se puede iniciar un `FileSystemWatcher`, deja que cualquiera de sus eventos despierte el ciclo de escaneo antes de tiempo. En un cliente Windows que habla con SMB esto te da latencia inferior al segundo en el caso común.
4. Ante cualquier `Error` del watcher (desbordamiento o desconexión), descarta el watcher, fuerza un nuevo escaneo e intenta recrearlo en la siguiente pasada.
5. Si el propio escaneo falla porque el recurso compartido no está disponible, conserva la instantánea anterior y reintenta en el siguiente ciclo. Una interrupción no es lo mismo que "todos los archivos fueron eliminados".

Aquí está la implementación completa. Se ejecuta tal cual en .NET 10 y .NET 11:

```csharp
// .NET 10 / .NET 11, C# 14
using System.IO.Enumeration;

public enum ShareChangeKind { Created, Changed, Deleted }

public readonly record struct ShareChange(ShareChangeKind Kind, string Path);

public readonly record struct FileStamp(long Length, DateTime LastWriteUtc);

public sealed class ShareWatcher : IAsyncDisposable
{
    private readonly string _root;
    private readonly TimeSpan _reconcileInterval;
    private readonly Action<ShareChange> _onChange;
    private readonly SemaphoreSlim _wake = new(0, 1);
    private readonly CancellationTokenSource _cts = new();
    private Dictionary<string, FileStamp> _snapshot = new(StringComparer.OrdinalIgnoreCase); // SMB is case-insensitive
    private volatile FileSystemWatcher? _watcher; // swapped from the Error callback
    private Task? _loop;

    public ShareWatcher(string root, TimeSpan reconcileInterval, Action<ShareChange> onChange)
    {
        _root = root;
        _reconcileInterval = reconcileInterval;
        _onChange = onChange;
    }

    public void Start()
    {
        // Baseline: whatever exists now is not a change.
        _snapshot = TakeSnapshot(_root) ?? _snapshot;
        TryStartWatcher();
        _loop = Task.Run(() => LoopAsync(_cts.Token));
    }

    private async Task LoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            // Wake on the reconcile timer OR early when the watcher hints at a change.
            try { await _wake.WaitAsync(_reconcileInterval, ct); }
            catch (OperationCanceledException) { return; }

            // Small settle delay so a burst of hints becomes one scan.
            try { await Task.Delay(250, ct); }
            catch (OperationCanceledException) { return; }

            Reconcile();

            if (_watcher is null) TryStartWatcher();
        }
    }

    private void Reconcile()
    {
        var current = TakeSnapshot(_root);
        if (current is null)
        {
            // Share unreachable. Keep the old snapshot: an outage is not "every file was deleted".
            return;
        }

        foreach (var (path, stamp) in current)
        {
            if (!_snapshot.TryGetValue(path, out var old))
                _onChange(new(ShareChangeKind.Created, path));
            else if (old != stamp)
                _onChange(new(ShareChangeKind.Changed, path));
        }

        foreach (var path in _snapshot.Keys)
        {
            if (!current.ContainsKey(path))
                _onChange(new(ShareChangeKind.Deleted, path));
        }

        _snapshot = current;
    }

    private static Dictionary<string, FileStamp>? TakeSnapshot(string root)
    {
        var options = new EnumerationOptions
        {
            RecurseSubdirectories = false,
            IgnoreInaccessible = true,
            AttributesToSkip = FileAttributes.Hidden | FileAttributes.System,
        };

        try
        {
            // Length and LastWriteTimeUtc come from the directory listing itself on Windows,
            // so this is one QUERY_DIRECTORY exchange per batch, not one round trip per file.
            // The constructor opens the directory, so it must sit inside the try.
            var entries = new FileSystemEnumerable<KeyValuePair<string, FileStamp>>(
                root,
                (ref FileSystemEntry e) => new(
                    e.ToFullPath(),
                    new FileStamp(e.Length, e.LastWriteTimeUtc.UtcDateTime)),
                options)
            {
                ShouldIncludePredicate = (ref FileSystemEntry e) => !e.IsDirectory,
            };

            var result = new Dictionary<string, FileStamp>(StringComparer.OrdinalIgnoreCase);
            foreach (var (path, stamp) in entries) result[path] = stamp;
            return result;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    private void TryStartWatcher()
    {
        try
        {
            var w = new FileSystemWatcher(_root)
            {
                NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size,
                IncludeSubdirectories = false,
                InternalBufferSize = 64 * 1024, // hard ceiling for network paths
            };
            w.Created += (_, _) => Hint();
            w.Changed += (_, _) => Hint();
            w.Deleted += (_, _) => Hint();
            w.Renamed += (_, _) => Hint();
            w.Error += (_, e) => OnWatcherError(w, e.GetException());
            w.EnableRaisingEvents = true;
            _watcher = w;
        }
        catch (Exception ex) when (ex is IOException or ArgumentException or UnauthorizedAccessException)
        {
            // Share offline or path gone. Polling keeps running; we retry on the next pass.
            _watcher = null;
        }
    }

    private void OnWatcherError(FileSystemWatcher w, Exception ex)
    {
        // Overflow or a dropped connection: either way, events were lost.
        // Throw the watcher away, force a full rescan, and rebuild on the next pass.
        if (ReferenceEquals(_watcher, w)) _watcher = null;
        w.Dispose();
        Hint();
    }

    private void Hint()
    {
        try { _wake.Release(); }
        catch (SemaphoreFullException) { /* a scan is already pending */ }
    }

    public async ValueTask DisposeAsync()
    {
        _cts.Cancel();
        if (_loop is not null) await _loop;
        _watcher?.Dispose();
        _cts.Dispose();
        _wake.Dispose();
    }
}
```

Úsalo desde un worker o una aplicación de consola:

```csharp
// .NET 10 / .NET 11, C# 14
await using var watcher = new ShareWatcher(
    @"\\fileserver\drop",
    reconcileInterval: TimeSpan.FromSeconds(15),
    onChange: c => Console.WriteLine($"{c.Kind}: {c.Path}"));

watcher.Start();
await Task.Delay(Timeout.Infinite);
```

Lo probé en un directorio local con un intervalo de reconciliación de 3 segundos: un archivo creado, un append y una eliminación se reportaron cada uno unos 265 ms después de la operación (la pista del watcher más el retraso de estabilización de 250 ms). Mientras el directorio estuvo movido durante 4 segundos para simular una interrupción, no se reportó nada, y el archivo creado después de que volviera se reportó en la siguiente pasada. Nada se reportó por error como eliminado.

Algunas decisiones de diseño que vale la pena destacar:

- **`SemaphoreSlim(0, 1)` como señal de despertar** fusiona cualquier cantidad de pistas en un único escaneo pendiente. El `catch` de `SemaphoreFullException` es la fusión, no una ruta de error.
- **El retraso de estabilización de 250 ms** convierte una ráfaga de pistas (un lote de 2 000 archivos) en un escaneo en lugar de 2 000.
- **`_onChange` se ejecuta en el ciclo de escaneo**, una llamada a la vez. Si el procesamiento es lento, envía el cambio a un `Channel<ShareChange>` y deja que un consumidor aparte lo maneje, para que un manejador lento no retrase el siguiente escaneo.
- **Los archivos ocultos y de sistema se omiten**, lo que descarta `Thumbs.db`, `desktop.ini` y los archivos `.DS_Store` que dejan los clientes macOS.

## Problemas que el sondeo no resuelve por ti

**Los cachés de metadatos del cliente añaden latencia que no configuraste.** El cliente SMB de Windows almacena en caché los listados de directorio y los metadatos de archivo. Según la [guía de ajuste de servidores de archivos](https://learn.microsoft.com/en-us/windows-server/administration/performance-tuning/role/file-server/), `DirectoryCacheLifetime` y `FileInfoCacheLifetime` valen 10 segundos por defecto y `FileNotFoundCacheLifetime` 5 segundos (todos bajo `HKLM\System\CurrentControlSet\Services\LanmanWorkstation\Parameters`), y los directory leases de SMB 3 cambian aún más el panorama. En Linux, `mount.cifs` almacena en caché los atributos durante 1 segundo por defecto (`actimeo`), y un cliente NFS por defecto almacena en caché los atributos de directorio entre 30 y 60 segundos (`acdirmin`/`acdirmax`, consulta [`nfs(5)`](https://man7.org/linux/man-pages/man5/nfs.5.html)). Tu latencia efectiva es tu intervalo de sondeo más el tiempo de vida del caché. Si necesitas algo más rápido, ajusta las opciones de montaje, no el intervalo de sondeo.

**"Archivo nuevo" no significa "archivo terminado".** Ambos mecanismos te dicen que apareció un archivo, no que el escritor haya terminado con él. Un archivo de 2 GB copiado por la red aparece en el listado en el momento en que empieza la copia. Cubrí las opciones en detalle en [cómo detectar cuándo termina de escribirse un archivo](/es/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/): la más robusta es hacer que el productor escriba con un nombre temporal y lo renombre al final. Con el enfoque híbrido de arriba también puedes simplemente considerar un archivo listo solo después de que su sello no haya cambiado durante dos escaneos.

**Las copias que preservan la marca de tiempo parecen sin cambios.** `robocopy` con su `/COPY:DAT` por defecto, `cp -p` y `rsync -t` preservan la hora de última escritura del origen. Si un archivo se reemplaza por otro del mismo tamaño, el sello `(Length, LastWriteUtc)` no cambia. Si eso importa, agrega la hora de creación en Windows o un hash del contenido para archivos pequeños, o pide al productor que escriba un nombre nuevo para cada versión.

**Desfase de reloj entre cliente y servidor.** La hora de última escritura que lees es la marca de tiempo del servidor. Compara sellos solo con otros sellos del mismo recurso compartido, nunca con `DateTime.UtcNow` de tu máquina. La lógica de "modificado en los últimos 5 minutos" se rompe en silencio cuando el reloj del servidor de archivos está desajustado.

**Distinción entre mayúsculas y minúsculas.** El diccionario de la instantánea usa `StringComparer.OrdinalIgnoreCase` porque los recursos SMB no distinguen mayúsculas de minúsculas. En una exportación NFS con un sistema de archivos que sí distingue, cambia a `StringComparer.Ordinal`, o dos archivos que difieran solo en mayúsculas se colapsarán en una sola entrada.

**Bind mounts de contenedores en Docker Desktop.** La misma regla aplica a una carpeta del host montada con bind mount en un contenedor Linux en Windows o macOS: las notificaciones de cambio desde el host no son confiables, así que el sondeo es también el único valor predeterminado seguro ahí.

## Recarga de configuración en un recurso compartido: DOTNET_USE_POLLING_FILE_WATCHER

Si el "cambio de archivo" que te importa es `appsettings.json` con `reloadOnChange: true`, o cualquier otro consumidor de `PhysicalFileProvider`, no necesitas el código de arriba. `PhysicalFileProvider` lee la variable de entorno `DOTNET_USE_POLLING_FILE_WATCHER` en su constructor:

```bash
# .NET 8, 9, 10, 11: switches PhysicalFileProvider to polling
export DOTNET_USE_POLLING_FILE_WATCHER=1
```

Con `1` o `true`, establece tanto `UsePollingFileWatcher` como `UseActivePolling`, no crea ningún `FileSystemWatcher` y revisa el `LastWriteTimeUtc` de cada archivo vigilado con un temporizador. El intervalo es `PhysicalFilesWatcher.DefaultPollingInterval`, fijado en el código en 4 segundos. También puedes optar por esto por proveedor en código:

```csharp
// .NET 10 / .NET 11, C# 14
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;

var builder = Host.CreateApplicationBuilder(args);

var provider = new PhysicalFileProvider(@"\\fileserver\config")
{
    UsePollingFileWatcher = true,
    UseActivePolling = true,
};

builder.Configuration.AddJsonFile(provider, "appsettings.shared.json",
    optional: false, reloadOnChange: true);
```

Aplican las mismas salvedades: compara solo la hora de última escritura, así que una copia que preserve la marca de tiempo le resulta invisible, y el almacenamiento en caché de metadatos de SMB puede sumar hasta 10 segundos a los 4 segundos del intervalo. La [comparación de `IOptionsMonitor`](/es/2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11/) cubre lo que ocurre aguas abajo una vez que se dispara la recarga.

## La recomendación, en resumen

Usa una comparación de instantáneas por sondeo como única fuente de verdad para cualquier carpeta en un recurso SMB, una exportación NFS o un bind mount. Elige el intervalo según tu presupuesto de latencia y luego súmale el tiempo de vida del caché de metadatos del cliente. Si corres en Windows y quieres baja latencia, agrega un `FileSystemWatcher` que solo despierte al sondeo antes de tiempo, limita su `InternalBufferSize` a 64 KB y trata cada evento `Error` como "volver a escanear y reconstruir". El único caso en que un `FileSystemWatcher` solo es aceptable es un disco local, e incluso ahí deberías suscribirte a `Error`.

## Lecturas relacionadas

- [Cómo detectar cuándo termina de escribirse un archivo en .NET](/es/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/) cubre la mitad del problema de "apareció pero no terminó".
- [Cómo seguir un archivo de registro en C# mientras otro proceso escribe en él](/es/2026/10/how-to-tail-a-log-file-in-csharp-while-another-process-is-writing-to-it/) usa el mismo razonamiento de sondeo primero para un único archivo que crece.
- [Por qué FileInfo.Length devuelve un tamaño obsoleto en Windows](/es/2026/10/fix-fileinfo-length-returns-stale-size-for-a-file-still-being-written-on-windows/) explica por qué los metadatos del listado de directorio pueden ir por detrás del archivo real.
- [Thread.Sleep vs Task.Delay vs SpinWait](/es/2026/10/thread-sleep-vs-task-delay-vs-spinwait-for-waiting-in-csharp/) explica por qué el ciclo de sondeo usa await en lugar de dormir.
- [Channels en lugar de BlockingCollection](/es/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) para pasar los cambios del ciclo de escaneo a un consumidor lento.

## Fuentes

- [`FileSystemWatcher` class, remarks on buffer size and network paths](https://learn.microsoft.com/en-us/dotnet/api/system.io.filesystemwatcher) (Microsoft Learn)
- [`ReadDirectoryChangesW` function](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-readdirectorychangesw) (Microsoft Learn)
- [`FileSystemWatcher.Windows.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.IO.FileSystem.Watcher/src/System/IO/FileSystemWatcher.Windows.cs) y [`FileSystemWatcher.Linux.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.IO.FileSystem.Watcher/src/System/IO/FileSystemWatcher.Linux.cs) (dotnet/runtime)
- [`PhysicalFileProvider.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.FileProviders.Physical/src/PhysicalFileProvider.cs) y [`PhysicalFilesWatcher.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.FileProviders.Physical/src/PhysicalFilesWatcher.cs) (dotnet/runtime)
- [`FileSystemEnumerable<TResult>`](https://learn.microsoft.com/en-us/dotnet/api/system.io.enumeration.filesystemenumerable-1) (Microsoft Learn)
- [Performance tuning for file servers, SMB client cache settings](https://learn.microsoft.com/en-us/windows-server/administration/performance-tuning/role/file-server/) (Microsoft Learn)
- Páginas de manual [`nfs(5)`](https://man7.org/linux/man-pages/man5/nfs.5.html) y [`mount.cifs(8)`](https://man7.org/linux/man-pages/man8/mount.cifs.8.html)
- [J. Bruce Fields on NFS change notification (LWN comment)](https://lwn.net/Articles/757833/)
