---
title: "Cómo leer un archivo de registro en C# al estilo tail mientras otro proceso sigue escribiendo en él"
description: "Abre el registro con FileShare.ReadWrite | FileShare.Delete, ve al final, consulta periódicamente si hay bytes nuevos, decodifícalos con tu propio Decoder UTF-8 en lugar de StreamReader y maneja el truncamiento y la rotación de forma explícita. Una implementación probada de tail -F para .NET 10 y .NET 11."
pubDate: 2026-10-11
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "file-io"
  - "logging"
  - "async"
lang: "es"
translationOf: "2026/10/how-to-tail-a-log-file-in-csharp-while-another-process-is-writing-to-it"
translatedBy: "claude"
translationDate: 2026-10-11
---

Para leer un archivo de registro que otro proceso todavía tiene abierto para escritura, ábrelo con `new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)`. `FileShare.ReadWrite` es lo que evita el `IOException: The process cannot access the file because it is being used by another process`, porque el escritor ya tiene acceso de escritura y tu modo de uso compartido tiene que permitirlo. `FileShare.Delete` permite que el escritor renombre o elimine el archivo durante la rotación del registro sin fallar. Luego ve al final, consulta periódicamente si hay bytes nuevos con un temporizador y emite texto solo hasta el último `\n`. No leas los bytes a través de `StreamReader`: al llegar al final del archivo vacía su decodificador, lo que corrompe cualquier carácter UTF-8 multibyte que el escritor haya escrito solo a medias. Por último, comprueba el truncamiento (`fs.Length < fs.Position`) y la rotación (la ruta ahora nombra un archivo distinto) cada vez que llegues al EOF. Todo lo que sigue se ejecutó en macOS con .NET 10.0.10 (SDK 10.0.302) y .NET 11 RC1 (SDK 11.0.100-rc.1.26425.128); las reglas de uso compartido de Windows se tomaron del código fuente del runtime y del contrato de Win32.

## Por qué File.ReadAllText lanza una excepción con un archivo de registro activo

Cada apertura en Windows lleva dos cosas: el acceso que quieres (`FileAccess`) y el acceso que estás dispuesto a permitir a otros al mismo tiempo (`FileShare`). Una segunda apertura tiene éxito solo si ambas partes están de acuerdo: el acceso que solicitas debe estar permitido por el modo de uso compartido de cada handle existente, y el acceso de cada handle existente debe estar permitido por tu modo de uso compartido.

Los registradores casi siempre abren su archivo así. Esta es la línea de [`FileSink` en Serilog.Sinks.File](https://github.com/serilog/serilog-sinks-file/blob/main/src/Serilog.Sinks.File/Sinks/File/FileSink.cs) cuando `shared: false` (el valor predeterminado):

```csharp
// Serilog.Sinks.File, non-shared mode
System.IO.File.Open(path, FileMode.OpenOrCreate, FileAccess.Write, FileShare.Read);
```

El escritor tiene `FileAccess.Write` y permite que otros lean. Ahora mira lo que hacen las API de conveniencia. `File.ReadAllText`, `File.ReadAllLines`, `File.ReadLines` y `new StreamReader(path)` terminan todas en el mismo método auxiliar de [`StreamReader.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/IO/StreamReader.cs):

```csharp
// dotnet/runtime, StreamReader path constructor
new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, FileStream.DefaultBufferSize);
```

`FileShare.Read` significa "nadie más puede escribir mientras yo tenga esto abierto". Pero alguien ya está escribiendo, así que Windows rechaza la apertura con `ERROR_SHARING_VIOLATION` (error de win32 32, HResult `0x80070020`), y .NET lo expone como `IOException: The process cannot access the file 'app.log' because it is being used by another process.` La solución no es un bucle de reintentos. La solución es pedir un modo de uso compartido que tolere al escritor:

```csharp
// .NET 10 / .NET 11, C# 14
using var fs = new FileStream(
    "app.log",
    FileMode.Open,
    FileAccess.Read,
    FileShare.ReadWrite | FileShare.Delete);
```

Si el escritor abrió el archivo con `FileShare.None`, ningún modo de uso compartido de tu lado ayuda. Ese escritor pidió acceso exclusivo, y solo puedes esperar a que cierre el handle.

### Qué cambia en Linux y macOS

Unix no tiene modos de uso compartido obligatorios, así que .NET los emula. Desde .NET 6, [`SafeFileHandle.Unix.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/Microsoft/Win32/SafeHandles/SafeFileHandle.Unix.cs) toma un `flock` consultivo: `LOCK_EX` cuando pasas `FileShare.None`, `LOCK_SH` para cualquier otro valor de uso compartido. Dos consecuencias, ambas reproducidas en macOS con .NET 10.0.10:

1. `File.ReadAllText` sobre un archivo que un escritor de .NET mantiene abierto con `FileShare.Read` tiene éxito en Unix. El código que "funciona en mi Mac" aún puede lanzar una excepción en producción en Windows.
2. Un escritor de .NET que intenta abrir con `FileShare.None` mientras tu lector tiene el archivo abierto falla con `IOException` (HResult `0x23` en macOS), porque tu bloqueo compartido impide el exclusivo. Los escritores que no son de .NET no participan en `flock` en absoluto.

El bloqueo se puede desactivar con el switch de runtime `System.IO.DisableFileLocking` (variable de entorno `DOTNET_SYSTEM_IO_DISABLEFILELOCKING=1`), que algunos equipos necesitan en montajes NFS sin un demonio de bloqueo. Pasar `FileShare.ReadWrite | FileShare.Delete` sigue siendo lo correcto en Unix: documenta la intención y se comporta igual en Windows.

## Los dos errores de un bucle tail ingenuo

Una vez que la apertura funciona, la implementación obvia es un `StreamReader` y un bucle alrededor de `ReadLine()`. `StreamReader` no fija el fin de archivo, así que cuando el escritor agrega más datos, el siguiente `ReadLine` los devuelve. Esa parte está bien. Otras dos cosas no.

Primero, las líneas parciales. Si el escritor ha vaciado `"line1\npart"` y llamas a `ReadLine()` dos veces, obtienes `"line1"` y luego `"part"`. Cuando el escritor agrega más tarde `"ial2\n"`, obtienes `"ial2"`. Una línea de registro ahora son dos registros. Ejecuté exactamente esa secuencia y obtuve `[line1] [part]`, y luego `[ial2]` después de la adición.

Segundo, y mucho menos conocido, los caracteres divididos. `StreamReader` entrega los bytes a un `Decoder` UTF-8, que puede retener los primeros bytes de un carácter multibyte hasta que llegue el resto. Pero cuando el flujo subyacente devuelve 0 bytes, `StreamReader` lo trata como el fin del flujo y llama a `_decoder.GetChars(..., flush: true)`. Un decodificador vaciado convierte cualquier secuencia incompleta en `U+FFFD`. En un archivo que crece, "el fin del flujo" es simplemente "el escritor aún no ha avanzado". Esta reproducción escribe `"żółć\n"` en dos fragmentos, dividiendo `ó` después de su primer byte:

```csharp
// .NET 10 / .NET 11, C# 14
using System.Text;

var path = Path.GetTempFileName();
var bytes = Encoding.UTF8.GetBytes("żółć\n");

using var writer = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.Read);
using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
using var reader = new StreamReader(fs, Encoding.UTF8);

var buf = new char[100];
var sb = new StringBuilder();
void Drain() { int n; while ((n = reader.Read(buf, 0, buf.Length)) > 0) sb.Append(buf, 0, n); }

writer.Write(bytes, 0, 3); writer.Flush(); Drain();               // "ż" + first byte of "ó"
writer.Write(bytes, 3, bytes.Length - 3); writer.Flush(); Drain();
Console.WriteLine(sb.ToString()); // prints "ż��łć"
```

La salida es `ż��łć` en .NET 10.0.10 y en .NET 11 RC1, tanto con `Read` como con `ReadAsync`. Los registros llenos de nombres de usuario, rutas de archivo o mensajes con caracteres no ASCII sufrirán esto en cuanto un escritor vacíe su búfer a mitad de un carácter, algo que los escritores con búfer hacen siempre que el límite de su búfer cae dentro de uno.

La solución para ambos problemas es la misma: lee los bytes del `FileStream` tú mismo, decodifícalos con tu propio `Decoder` y `flush: false`, y conserva el texto posterior al último salto de línea en un búfer hasta que aparezca el resto de la línea.

## Una implementación de tail -F que sobrevive a la rotación

Aquí está el método auxiliar completo. Expone el flujo de líneas como un `IAsyncEnumerable<string>`, de modo que los consumidores escriben `await foreach` y cancelan con un token.

```csharp
// .NET 10 / .NET 11, C# 14
using System.Runtime.CompilerServices;
using System.Text;

public static class LogTail
{
    public static async IAsyncEnumerable<string> FollowAsync(
        string path,
        bool fromStart = false,
        TimeSpan? pollInterval = null,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        var interval = pollInterval ?? TimeSpan.FromMilliseconds(250);
        var bytes = new byte[16 * 1024];
        var chars = new char[Encoding.UTF8.GetMaxCharCount(bytes.Length)];
        var decoder = Encoding.UTF8.GetDecoder();
        var pending = new StringBuilder();
        FileStream? fs = null;

        try
        {
            while (!ct.IsCancellationRequested)
            {
                if (fs is null)
                {
                    fs = TryOpen(path);
                    if (fs is null)
                    {
                        await Task.Delay(interval, ct);
                        continue;
                    }
                    if (!fromStart) fs.Seek(0, SeekOrigin.End);
                    fromStart = true; // a rotated-in file is read from the top
                    decoder.Reset();
                    pending.Clear();
                }

                int read = await fs.ReadAsync(bytes, ct);
                if (read > 0)
                {
                    // flush: false keeps a half-written multi-byte character
                    // inside the decoder until the rest of it arrives.
                    int n = decoder.GetChars(bytes, 0, read, chars, 0, flush: false);
                    pending.Append(chars, 0, n);
                    foreach (var line in DrainCompleteLines(pending))
                        yield return line;
                    continue;
                }

                // At EOF. Truncated in place (copytruncate)?
                if (fs.Length < fs.Position)
                {
                    fs.Seek(0, SeekOrigin.Begin);
                    decoder.Reset();
                    pending.Clear();
                    continue;
                }

                // Path now points at a different file (rename-and-recreate)?
                if (WasReplaced(path, fs))
                {
                    await fs.DisposeAsync();
                    fs = null;
                    continue;
                }

                await Task.Delay(interval, ct);
            }
        }
        finally
        {
            if (fs is not null) await fs.DisposeAsync();
        }
    }

    static FileStream? TryOpen(string path)
    {
        try
        {
            return new FileStream(path, FileMode.Open, FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete,
                bufferSize: 0, FileOptions.Asynchronous);
        }
        catch (FileNotFoundException) { return null; }
        catch (DirectoryNotFoundException) { return null; }
        catch (IOException) { return null; } // writer holds FileShare.None right now
    }

    static IEnumerable<string> DrainCompleteLines(StringBuilder pending)
    {
        int start = 0;
        for (int i = 0; i < pending.Length; i++)
        {
            if (pending[i] != '\n') continue;
            int end = i > start && pending[i - 1] == '\r' ? i - 1 : i;
            yield return pending.ToString(start, end - start);
            start = i + 1;
        }
        pending.Remove(0, start);
    }

    static bool WasReplaced(string path, FileStream current)
    {
        // Measure the path through a fresh handle, not FileInfo, and do it
        // before reading the current handle's length.
        using var probe = TryOpen(path);
        if (probe is null) return false; // rotated, new file not created yet
        long pathLength = probe.Length;
        // Same append-only file: pathLength == current.Position (we are at EOF)
        // or current.Length grew past it in the meantime. Anything else means
        // the name now belongs to another file.
        return pathLength < current.Position || pathLength > current.Length;
    }
}
```

Usarlo desde una aplicación de consola o un `BackgroundService` se ve así:

```csharp
// .NET 10 / .NET 11, C# 14
using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };

try
{
    await foreach (var line in LogTail.FollowAsync("/var/log/myapp/app.log", ct: cts.Token))
        Console.WriteLine(line);
}
catch (OperationCanceledException) { }
```

Lo probé contra un segundo proceso que escribía líneas en dos fragmentos (divididos dentro de un carácter de dos bytes, con vaciados y pausas de 120 ms entre ellos), luego renombraba el archivo a `app.log.1` y empezaba uno nuevo, y después truncaba el nuevo y seguía escribiendo. El lector imprimió cada línea intacta, sin caracteres de reemplazo, siguió el renombrado hacia el archivo nuevo y volvió a empezar desde el principio tras el truncamiento, tanto en .NET 10.0.10 como en .NET 11 RC1.

## Qué aporta cada pieza

En orden, el bucle hace cinco cosas:

1. **Abre con `FileShare.ReadWrite | FileShare.Delete`.** `ReadWrite` tolera al escritor. `Delete` importa para la rotación en Windows: los registradores que archivan renombrando `app.log` a `app.log.1` llaman a `MoveFile`, que falla con una violación de uso compartido si algún handle abierto carece de `FILE_SHARE_DELETE`. Sin él, tu lector rompe la rotación de registros de la aplicación, que es un error mucho peor que perder una línea.
2. **Va al final en la primera apertura.** Esa es la semántica de `tail -f`: mostrar lo que ocurre de ahora en adelante. Pasa `fromStart: true` para reproducir el archivo completo. Después de una rotación, el método auxiliar siempre lee el archivo nuevo desde el principio, porque todo lo que contiene es nuevo.
3. **Consulta periódicamente con `Task.Delay`.** Una consulta cada 250 ms en el EOF es una llamada de sistema `read` que devuelve 0, más un `open` y un `fstat` para la comprobación de rotación. Eso es insignificante. `FileSystemWatcher` resulta tentador, pero no funciona en muchos recursos compartidos de red ni en montajes bind de contenedores, su búfer interno se desborda bajo ráfagas y pierde eventos, y las notificaciones `Changed` de un escritor que agrega datos las fusiona y retrasa el sistema operativo. Úsalo, si acaso, como una pista que acorta la espera, nunca como el único disparador.
4. **Decodifica con `flush: false` y almacena en búfer las líneas parciales.** `DrainCompleteLines` solo produce texto terminado en `\n`, elimina un `\r` final para que los registros CRLF salgan limpios y deja la cola incompleta en `pending`.
5. **Comprueba el truncamiento y la rotación solo en el EOF.** Mientras haya bytes por leer, nada más importa. Cuando no los hay, la comprobación basada en el handle `fs.Length < fs.Position` detecta `copytruncate`, y `WasReplaced` detecta el renombrado y recreación.

### Por qué la rotación necesita su propia comprobación

Cuando `logrotate` (o el archivado de NLog, o tu propio código) renombra `app.log` y crea uno nuevo, tu handle no sigue al nombre. Los handles apuntan a archivos, no a rutas: tanto en Unix como en Windows con `FILE_SHARE_DELETE`, el handle antiguo sigue leyendo el archivo renombrado, que nunca volverá a crecer. El lector se quedaría en el EOF para siempre mientras la aplicación escribe tranquilamente en el nuevo `app.log`.

`WasReplaced` abre la ruta de nuevo y compara longitudes. Para un registro de solo adición, si la ruta aún nombra el archivo que estás leyendo, su longitud es igual a tu posición (estás en el EOF) o el escritor ha agregado datos desde entonces, en cuyo caso `current.Length` es al menos igual de grande porque se lee después. Una longitud de la ruta menor que tu posición o mayor que la longitud de tu handle significa un archivo distinto. Mido a través de un handle nuevo en lugar de `FileInfo.Length` porque en Windows la información de tamaño que proviene de la entrada de directorio puede ir por detrás de un archivo que sigue abierto para escritura.

La comprobación tiene un punto ciego: un archivo nuevo que tenga exactamente la misma longitud que el antiguo en cada sondeo. Esa ventana se cierra en cuanto el archivo nuevo crece. Si necesitas una identidad a prueba de fallos, compara el ID del archivo (`GetFileInformationByHandle` en Windows, `st_dev` más `st_ino` de `fstat` en Unix) mediante P/Invoke. .NET no expone ninguno de los dos públicamente a partir de .NET 11.

## Leer primero solo las últimas N líneas

`tail -n 50 -f` muestra contexto reciente antes de seguir el archivo. Leer un archivo de 2 GB para encontrar sus últimas 50 líneas es un desperdicio, así que lee una ventana desde el final:

```csharp
// .NET 10 / .NET 11, C# 14
public static async Task<IReadOnlyList<string>> ReadLastLinesAsync(
    string path, int count, int maxBytes = 64 * 1024)
{
    await using var fs = new FileStream(path, FileMode.Open, FileAccess.Read,
        FileShare.ReadWrite | FileShare.Delete);
    long start = Math.Max(0, fs.Length - maxBytes);
    fs.Seek(start, SeekOrigin.Begin);
    using var reader = new StreamReader(fs, Encoding.UTF8);
    var lines = new Queue<string>(count + 1);
    bool skipFirst = start > 0; // we probably landed mid-line
    string? line;
    while ((line = await reader.ReadLineAsync()) is not null)
    {
        if (skipFirst) { skipFirst = false; continue; }
        lines.Enqueue(line);
        if (lines.Count > count) lines.Dequeue();
    }
    return lines.ToArray();
}
```

Aquí `StreamReader` está bien, porque es una lectura única: los únicos datos parciales están al inicio (se omiten) y posiblemente en la última línea, que puedes mostrar tal cual. Buscar en medio del archivo puede caer dentro de una secuencia UTF-8, que es otra razón para descartar la primera línea. Si 64 KB no contiene `count` líneas, duplica `maxBytes` e inténtalo de nuevo. Llámalo, imprime el resultado y luego inicia `FollowAsync` con `fromStart: false`. Se pueden perder algunas líneas escritas entre las dos llamadas; si eso importa, haz que `ReadLastLinesAsync` devuelva el desplazamiento en el que se detuvo y empieza a seguir desde ahí.

## Problemas que no son culpa del lector

**El escritor debe vaciar su búfer.** Solo puedes ver lo que ha llegado al sistema operativo. El sink de archivo de Serilog usa `buffered: false` de forma predeterminada, y el target de archivo de NLog tiene `autoFlush="true"` por defecto, pero un `StreamWriter` con `AutoFlush = false` retiene en memoria hasta el tamaño de su búfer. Muchos reportes de "el lector se pierde las últimas líneas" son un escritor que aún no ha vaciado.

**`copytruncate` pierde datos, por diseño.** En mi prueba, el escritor truncó el archivo 120 ms después de su última escritura, y el lector, que consulta cada 250 ms, nunca vio esa línea. La propia documentación de `logrotate` advierte que las líneas escritas entre la copia y el truncamiento se pierden. Prefiere la rotación basada en renombrado (`create`) con una aplicación que reabra su archivo, o mantén corto el intervalo de consulta.

**No abras con `FileAccess.ReadWrite`.** Algunos fragmentos en línea lo hacen, supongo que para "coincidir" con el escritor. Solo necesitas acceso de lectura, y en Windows pedir acceso de escritura falla si el escritor abrió con `FileShare.Read`.

**Codificación y BOM.** El método auxiliar asume UTF-8, que es lo que escriben Serilog, NLog, la redirección de consola de Microsoft.Extensions.Logging y casi todas las herramientas de Unix. Si sigues registros UTF-16, cambia el `Decoder`, y si reproduces con `fromStart: true` un archivo que empieza con un BOM UTF-8, recorta `'\uFEFF'` de la primera línea.

**Líneas muy largas.** `pending` crece hasta que llega un salto de línea. Si un escritor puede emitir líneas sin límite (basura binaria, un blob JSON minificado), limita `pending.Length` y emite o descarta lo que tengas una vez que supere el límite.

**Varios escritores.** El `shared: true` de Serilog y varios procesos que agregan datos a un mismo archivo solo funcionan porque cada escritura va al final del archivo de forma atómica. Al lector no le importa cuántos escritores haya, pero el entrelazado entre sus escrituras parciales es problema de los escritores, no tuyo.

## Lecturas relacionadas

- Si la pregunta no es "qué se ha agregado" sino "ya terminó este archivo", consulta [cómo detectar cuándo un archivo termina de escribirse en .NET](/es/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/), que cubre el sondeo con `FileShare.None` y la estabilización del tamaño.
- `FollowAsync` es un flujo asíncrono. [Qué es `IAsyncEnumerable` y cuándo usarlo](/es/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/) explica por qué `[EnumeratorCancellation]` va en el parámetro del token.
- Para detener el tail limpiamente desde un servicio hospedado, [propaga el `CancellationToken` a través de la cadena de llamadas asíncronas](/es/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/).
- Si quieres repartir las líneas entre varios consumidores, coloca un [`Channel<T>` entre el lector y los procesadores](/es/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/).
- Para el lado del escritor, [el registro estructurado con Serilog y Seq en .NET 11](/es/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) muestra la configuración del sink de archivo que este artículo lee.

## Fuentes

- [`StreamReader.cs` en dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/IO/StreamReader.cs): el constructor de ruta con `FileShare.Read` y la decodificación con `flush: true` al final del flujo.
- [`SafeFileHandle.Unix.cs` en dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/Microsoft/Win32/SafeHandles/SafeFileHandle.Unix.cs): emulación de `FileShare` con `LOCK_SH` / `LOCK_EX` y el switch `System.IO.DisableFileLocking`.
- [`FileSink.cs` en serilog-sinks-file](https://github.com/serilog/serilog-sinks-file/blob/main/src/Serilog.Sinks.File/Sinks/File/FileSink.cs): cómo abre Serilog su archivo de registro.
- [Enumeración `FileShare` en Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.fileshare).
- [`Decoder.GetChars` en Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.text.decoder.getchars), incluido el parámetro `flush`.
- [Issue 48757 de dotnet/runtime](https://github.com/dotnet/runtime/issues/48757): bloqueo de archivos en NFS y `DOTNET_SYSTEM_IO_DISABLEFILELOCKING`.
