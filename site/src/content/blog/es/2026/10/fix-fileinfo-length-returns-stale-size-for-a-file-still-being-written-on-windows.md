---
title: "Solución: FileInfo.Length devuelve un tamaño desactualizado para un archivo que aún se está escribiendo en Windows"
description: "FileInfo almacena su tamaño en caché, la enumeración lee la entrada de directorio de NTFS, que se actualiza de forma diferida, y el escritor puede seguir reteniendo bytes en sus propios búferes. Usa Refresh() o, mejor, lee la longitud desde un handle compartido con RandomAccess.GetLength."
pubDate: 2026-10-13
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "dotnet-11"
  - "csharp"
  - "filesystem"
lang: "es"
translationOf: "2026/10/fix-fileinfo-length-returns-stale-size-for-a-file-still-being-written-on-windows"
translatedBy: "claude"
translationDate: 2026-10-13
---

`FileInfo.Length` miente por tres razones distintas, y se acumulan. Primero, un `FileInfo` almacena sus datos en caché la primera vez que lees cualquier propiedad y no vuelve a leerlos hasta que llamas a `Refresh()`. Segundo, un `FileInfo` que proviene de `DirectoryInfo.EnumerateFiles` o `GetFiles` en Windows se llena a partir de la entrada de directorio de NTFS, y NTFS solo actualiza esa copia del tamaño cuando el escritor cierra su último handle. Tercero, el proceso que escribe puede seguir reteniendo los bytes en sus propios búferes de `StreamWriter` / `FileStream`, así que el sistema operativo realmente aún no los ha visto. La solución confiable es dejar de preguntarle a la ruta y preguntarle a un handle: `using var h = File.OpenHandle(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete); long size = RandomAccess.GetLength(h);`. Si controlas el escritor, haz flush. Los números de almacenamiento en búfer de abajo se midieron en .NET 10.0.10 (SDK 10.0.302) y .NET 11 RC1 (SDK 11.0.100-rc.1.26425.128), y resultaron idénticos. Las rutas de código específicas de Windows se citan del código fuente de dotnet/runtime en `main`.

## El síntoma en contexto

No se lanza ninguna excepción. El reporte del error suele parecerse a uno de estos:

```
// what people see, .NET 10 / .NET 11 on Windows
size = 0          // the log file is clearly growing in Notepad++
size = 4096       // the writer has logged 6000 characters
size = 1048576    // Explorer says 1 MB, the copy job says 37 MB
```

El patrón es siempre el mismo. Un bucle de monitoreo, un trabajo de carga o una verificación de "espera hasta que el archivo deje de crecer" lee `FileInfo.Length` mientras otro proceso (u otro hilo) tiene el archivo abierto para escritura. El número va retrasado, a veces congelado, y salta al valor correcto en cuanto el escritor cierra el archivo. Explorer y `dir` muestran el mismo número congelado, lo que convence a la gente de que el problema es Windows y no su código. En parte es ambos.

## Por qué ocurre

Hay tres capas, y cada una puede causar el problema por sí sola.

**1. `FileInfo` es una instantánea, no una vista en vivo.** `FileSystemInfo` mantiene una estructura privada `WIN32_FILE_ATTRIBUTE_DATA` y un indicador `_dataInitialized`. El primer acceso a una propiedad la llena, y cada acceso posterior devuelve el valor en caché. La [documentación de `FileInfo.Length`](https://learn.microsoft.com/en-us/dotnet/api/system.io.fileinfo.length) lo dice directamente: el valor se precarga cuando la instancia proviene de `GetFiles` o `EnumerateFiles`, y debes llamar a `Refresh` para obtener el valor más reciente. Un detalle sutil: la población es diferida. Construir `new FileInfo(path)` no toca el disco, así que el "momento de la instantánea" es cuando tu código lee por primera vez `Length`, `Exists` o cualquier marca de tiempo, que suele ser mucho antes de lo que piensas.

**2. La enumeración lee la entrada de directorio, y NTFS la actualiza de forma diferida.** En Windows, `FileSystemEnumerator` llama a `NtQueryDirectoryFile` con `FileFullDirectoryInformation`, y `FileSystemInfo.Init(FILE_FULL_DIR_INFORMATION*)` copia `EndOfFile` directamente al tamaño en caché. Ese número viene del índice del directorio, no del archivo. Como explica Raymond Chen en [Why is the file size reported incorrectly for files that are still being written to?](https://devblogs.microsoft.com/oldnewthing/20111226-00/?p=8813), NTFS trata el tamaño como una propiedad del archivo y solo lo replica en la entrada de directorio como optimización para los listados. Desde Windows Vista, esa réplica se actualiza cuando se cierra el último handle del objeto de archivo. Un escritor que mantiene un registro abierto durante horas deja la entrada de directorio con el tamaño que tenía cuando se abrió el archivo, que a menudo es 0. Esto es exactamente lo que reportan Explorer, `dir`, `Directory.GetFiles` seguido de `new FileInfo(...)` sobre el resultado, y `FileSystemEntry.Length` en un `FileSystemEnumerable` personalizado.

**3. El escritor aún no ha escrito los bytes.** Un `StreamWriter` retiene caracteres en su propio búfer, luego entrega bytes codificados a un `FileStream`, que tiene su propio búfer de 4096 bytes por defecto. Hasta que los búferes se llenan o alguien llama a `Flush()`, el sistema operativo no ha recibido ni un solo byte, así que todas las API en todas las plataformas reportan correctamente el tamaño anterior. Esta es la capa que la mayoría olvida, porque desde fuera se ve idéntica a las otras dos.

Una cuarta capa solo aparece en recursos compartidos de red: el redirector del cliente SMB almacena en caché los metadatos de archivos para las consultas basadas en ruta. `FileInfoCacheLifetime` y `DirectoryCacheLifetime` valen ambos 10 segundos por defecto en las versiones actuales de Windows (consulta [Performance tuning for file servers](https://learn.microsoft.com/en-us/windows-server/administration/performance-tuning/role/file-server)), así que una ruta UNC puede mostrar un tamaño de hasta 10 segundos de antigüedad incluso después de un `Refresh()`.

## Reproducción mínima

Esta aplicación basada en archivo escribe a través de un `StreamWriter` sin hacer flush y muestrea el tamaño de cuatro maneras: un `FileInfo` en caché, el mismo `FileInfo` tras `Refresh()`, un handle nuevo mediante `RandomAccess.GetLength`, y un `FileInfo` obtenido de la enumeración de directorio. Ejecútala con `dotnet run probe.cs`.

```csharp
// .NET 10 / .NET 11, C# 14, file-based app: dotnet run probe.cs
#:property PublishAot=false
using Microsoft.Win32.SafeHandles;

string path = Path.Combine(Path.GetTempPath(), "stale-probe.log");
File.Delete(path);

using var writer = new StreamWriter(new FileStream(path, FileMode.Create,
    FileAccess.Write, FileShare.ReadWrite | FileShare.Delete));
var cached = new FileInfo(path);
Console.WriteLine($"start: cached={cached.Length}");   // first access: snapshot taken here

writer.Write(new string('a', 1000));
Report("after 1000 chars, no flush");
writer.Write(new string('a', 5000));
Report("after 6000 chars, no flush");
writer.Flush();
Report("after StreamWriter.Flush()");

var fromEnum = new DirectoryInfo(Path.GetTempPath())
    .EnumerateFiles("stale-probe.log").Single();
writer.Write(new string('b', 4000)); writer.Flush();
Console.WriteLine($"enumerated FileInfo (no Refresh) after +4000: {fromEnum.Length}");
fromEnum.Refresh();
Console.WriteLine($"enumerated FileInfo after Refresh: {fromEnum.Length}");

void Report(string label)
{
    long stale = cached.Length;
    cached.Refresh();
    long refreshed = cached.Length;
    using SafeFileHandle h = File.OpenHandle(path, FileMode.Open, FileAccess.Read,
        FileShare.ReadWrite | FileShare.Delete);
    Console.WriteLine($"{label}: cached={stale} refreshed={refreshed} " +
        $"handle={RandomAccess.GetLength(h)} writer.BaseStream.Position={writer.BaseStream.Position}");
}
```

Salida, idéntica en .NET 10.0.10 y .NET 11.0.0 RC1 (macOS arm64, APFS):

```
start: cached=0
after 1000 chars, no flush: cached=0 refreshed=0 handle=0 writer.BaseStream.Position=0
after 6000 chars, no flush: cached=0 refreshed=4096 handle=4096 writer.BaseStream.Position=5120
after StreamWriter.Flush(): cached=4096 refreshed=6000 handle=6000 writer.BaseStream.Position=6000
enumerated FileInfo (no Refresh) after +4000: 6000
enumerated FileInfo after Refresh: 10000
```

Léela línea por línea:

- Tras 1000 caracteres, nada ha llegado al sistema operativo. `StreamWriter` sigue reteniéndolo todo, así que incluso el handle dice 0. Ninguna corrección del lado del lector puede ayudar aquí.
- Tras 6000 caracteres, `StreamWriter` ha empujado 5120 caracteres (cinco fragmentos de 1024 caracteres) al `FileStream`, y el `FileStream` ha escrito al sistema operativo un búfer completo de 4096 bytes. Toda API honesta dice 4096. El `FileInfo` en caché sigue diciendo 0.
- Tras `Flush()`, el tamaño real es 6000. El `FileInfo` en caché dice 4096, porque la llamada anterior a `Report` lo refrescó y nada lo ha refrescado desde entonces.
- El `FileInfo` enumerado quedó congelado en el momento de la enumeración y necesitó un `Refresh()` para ver los 4000 bytes adicionales.

En macOS y Linux, las capas 1 y 3 son toda la historia, porque `stat` lee el inodo y no existe una copia separada del tamaño en el directorio. En Windows, la capa 2 se suma: ejecuta el mismo programa allí y mira la carpeta en Explorer mientras espera, y el listado del directorio se queda por detrás del valor del handle hasta que se libera el escritor. No he medido esa mitad en una máquina Windows para este artículo. El mecanismo está documentado por Raymond Chen, y la ruta de código exacta (`NtQueryDirectoryFile` hacia `FileSystemInfo.Init`) se puede ver en el código fuente del runtime enlazado al final.

## La solución, en detalle

Elige la solución que corresponda a la capa que estás sufriendo. En la mayoría del código real, estás sufriendo más de una.

### 1. Recomendada: lee el tamaño desde un handle, no desde una ruta

Una consulta basada en handle va al objeto de archivo abierto, que es donde NTFS guarda el final de archivo autoritativo. Es la única respuesta que Raymond Chen describe como correcta (`GetFileSize` sobre un handle), y evita tanto la caché de `FileInfo` como la entrada de directorio. Desde .NET 6, puedes hacerlo sin un `FileStream`:

```csharp
// .NET 10 / .NET 11, C# 14
using Microsoft.Win32.SafeHandles;

static long GetLiveLength(string path)
{
    // FileShare.ReadWrite: the writer already holds write access, so we must allow it.
    // FileShare.Delete: do not break a writer that renames or deletes during rotation.
    using SafeFileHandle handle = File.OpenHandle(
        path,
        FileMode.Open,
        FileAccess.Read,
        FileShare.ReadWrite | FileShare.Delete);

    return RandomAccess.GetLength(handle);
}
```

`File.OpenHandle` junto con `RandomAccess.GetLength` es más ligero que `new FileStream(...).Length`: sin asignación de búfer, sin seguimiento de posición, y en Windows `RandomAccess.GetLength` llama a `GetFileInformationByHandleEx(FileStandardInfo)` sobre el handle y devuelve `EndOfFile`. Si ya tienes un `FileStream` abierto sobre el archivo (por ejemplo, lo estás siguiendo con tail), usa `stream.Length` en ese stream. Pasa por la misma consulta al handle.

Aquí se esconde una caché más. En Windows, `SafeFileHandle` activa `_lengthCanBeCached` cuando el handle se abrió en solo lectura **y** sin `FileShare.Write`, y a partir de entonces devuelve la primera longitud que obtuvo. Eso es correcto, porque nadie puede escribir en el archivo mientras tu handle rechaza el uso compartido de escritura. Sí implica que `FileShare.Read` nunca es la elección correcta para vigilar un archivo que crece. Si el escritor ya está en ejecución, tu apertura falla. Si abres primero, falla la apertura del escritor, lo cual es peor porque ahora has roto al productor. Usa `FileShare.ReadWrite` (más `FileShare.Delete`), y el runtime consulta al sistema operativo en cada llamada.

El modo de uso compartido importa. Si abres con el `FileShare.Read` por defecto, la apertura falla con `IOException: The process cannot access the file because it is being used by another process`, porque el escritor ya tiene acceso de escritura y tu modo de uso compartido se niega a permitirlo. Ese error es la razón más común por la que la gente abandona el enfoque con handle y vuelve a `FileInfo`.

Un efecto secundario que conviene conocer: abrir y cerrar tu propio handle también hace que NTFS actualice la entrada de directorio cuando ese handle se cierra, según la misma publicación de Old New Thing. Así que tras una llamada a `GetLiveLength`, Explorer y la enumeración también se ponen al día, hasta que el escritor vuelve a añadir datos.

### 2. Si debes usar `FileInfo`, llama a `Refresh()` antes de cada lectura

Para un bucle de sondeo, conserva un único `FileInfo` y refréscalo en cada iteración:

```csharp
// .NET 10 / .NET 11, C# 14
var fi = new FileInfo(path);
long last = -1;
while (!ct.IsCancellationRequested)
{
    fi.Refresh();                       // without this, Length never changes
    if (fi.Exists && fi.Length != last)
    {
        Console.WriteLine($"{fi.Length:N0} bytes");
        last = fi.Length;
    }
    await Task.Delay(TimeSpan.FromSeconds(1), ct);
}
```

En Windows, `Refresh()` sobre un `FileInfo` construido a partir de una ruta pasa por `FileSystem.FillAttributeInfo`, que llama a `GetFileAttributesEx` sobre la ruta y recurre a `FindFirstFile` (una lectura de entrada de directorio) solo cuando esa llamada falla con algo como `ERROR_SHARING_VIOLATION` o `ERROR_ACCESS_DENIED`. Ese recurso existe para `pagefile.sys` y archivos pendientes de eliminación. Microsoft no documenta si `GetFileAttributesEx` siempre refleja el tamaño en vivo de un archivo abierto, así que trata `Refresh()` como "arregla la capa 1, probablemente arregla la capa 2 en NTFS local" y usa el enfoque con handle en cualquier lugar donde importe la corrección.

### 3. Nunca confíes en los tamaños de la enumeración para archivos que pueden estar abiertos

`Directory.EnumerateFiles` que devuelve rutas está bien. `DirectoryInfo.EnumerateFiles` que devuelve objetos `FileInfo`, y `FileSystemEntry.Length` dentro de una transformación de `FileSystemEnumerable<T>`, son rápidos precisamente porque reutilizan la copia del tamaño de la entrada de directorio. Esa es la copia que NTFS actualiza de forma diferida. Usa la enumeración para encontrar archivos candidatos y luego consulta cada uno que te importe:

```csharp
// .NET 10 / .NET 11, C# 14
foreach (FileInfo fi in new DirectoryInfo(inbox).EnumerateFiles("*.csv"))
{
    long listed = fi.Length;          // directory-entry copy on Windows, may be stale
    long live = GetLiveLength(fi.FullName);
    if (listed != live)
        Console.WriteLine($"{fi.Name}: listing says {listed:N0}, handle says {live:N0}");
}
```

La apertura por archivo cuesta unos cuantos viajes de metadatos, por eso Explorer no la hace. Para una carpeta con miles de archivos, consulta solo los que son nuevos o se modificaron recientemente.

### 4. Si controlas el escritor, haz flush (y sabe qué significa flush)

Ningún truco del lado del lector puede ver bytes que nunca salieron del proceso del escritor. Si un monitor necesita ver el progreso, el escritor tiene que empujar los bytes al sistema operativo:

```csharp
// .NET 10 / .NET 11, C# 14
using var log = new StreamWriter(new FileStream(path, FileMode.Append,
    FileAccess.Write, FileShare.ReadWrite | FileShare.Delete))
{
    AutoFlush = true    // every Write call pushes through StreamWriter and FileStream to the OS
};
```

`AutoFlush = true` cuesta una llamada al sistema por cada `Write`. Para un registrador de alto volumen, llama a `Flush()` con un temporizador o después de cada registro lógico. `Flush()` (o `Flush(false)` en un `FileStream`) entrega los bytes a la caché del sistema operativo, lo cual basta para que otros procesos vean el nuevo tamaño. `FileStream.Flush(flushToDisk: true)` además los fuerza al disco físico. Eso es para durabilidad, no para visibilidad, y es mucho más lento.

### 5. En recursos compartidos de red, ten en cuenta la caché del cliente SMB

Un `Refresh()` sobre una ruta UNC puede responderse desde la caché de información de archivos del redirector SMB hasta `FileInfoCacheLifetime` segundos (10 por defecto). Abrir un handle, como en la solución 1, envía una solicitud de apertura al servidor, así que también es la mejor opción aquí. Si no puedes cambiar el código, puedes reducir el tiempo de vida en el cliente con `Set-SmbClientConfiguration -FileInfoCacheLifetime 0`, pero eso ralentiza todas las consultas de metadatos basadas en ruta de la máquina. Trátalo como un diagnóstico, no como una solución.

## Trampas y casos parecidos

**"El archivo está terminado" es una pregunta distinta.** Un tamaño estable no es prueba de que el escritor haya terminado. Puede estar simplemente en pausa. Si lo que realmente necesitas es "¿puedo procesar este archivo ahora?", usa el patrón de renombrar al completar o una sonda de apertura exclusiva de [cómo detectar cuándo termina de escribirse un archivo en .NET](/es/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/).

**Leer los bytes nuevos conforme llegan** también es un problema aparte. Para eso, mantén abierto un único `FileStream` de lectura compartida y compara `fs.Length` con `fs.Position`, como se muestra en [cómo seguir un archivo de registro en C# mientras otro proceso escribe en él](/es/2026/10/how-to-tail-a-log-file-in-csharp-while-another-process-is-writing-to-it/). Ese artículo también cubre el truncamiento y la rotación, donde un tamaño menor significa "empezar de nuevo", no "desactualizado".

**`LastWriteTime` está desactualizado de las mismas maneras.** La marca de tiempo de la entrada de directorio se replica igual que su tamaño, y `FileInfo` la guarda en caché en la misma estructura. Todo lo anterior aplica a `LastWriteTimeUtc`, y NTFS además puede diferir por su cuenta las actualizaciones de las marcas de tiempo. No uses una marca de tiempo por sí sola para detectar crecimiento.

**Archivos preasignados.** Algunos escritores (bases de datos, gestores de descargas, `FileStream` con `preallocationSize`, llamadas a `SetLength`) extienden el archivo a su tamaño final de entrada y lo llenan después. El handle reporta el verdadero final de archivo, que ya es el tamaño final. Aquí, "el tamaño no cambió" no te dice nada sobre el progreso. Usa la propia señal de progreso del escritor.

**Escritores con archivos mapeados en memoria.** Un escritor que mapea el archivo y escribe a través de la vista cambia el contenido sin cambiar el tamaño, y el final de archivo quedó fijado cuando se creó el mapeo. El sondeo basado en tamaño no puede detectar esas escrituras en absoluto.

**`IOException` al abrir el handle.** Si el escritor abrió el archivo con `FileShare.None` (el valor por defecto de `File.Create` / `File.OpenWrite`), no se permite ninguna otra apertura, ni siquiera la tuya con `FileShare.ReadWrite`. Entonces solo puedes leer el tamaño basado en ruta, posiblemente desactualizado, o cambiar el escritor. Capturar esa violación de uso compartido es la base de la sonda "¿aún se está escribiendo?" del artículo relacionado de arriba.

## Relacionado

- [Cómo detectar cuándo termina de escribirse un archivo en .NET](/es/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/) cubre el sondeo de estabilidad, las sondas de apertura exclusiva y el truco de renombrar del lado del productor.
- [Cómo seguir un archivo de registro en C# mientras otro proceso escribe en él](/es/2026/10/how-to-tail-a-log-file-in-csharp-while-another-process-is-writing-to-it/) es el lector basado en handle completo, con manejo de rotación.
- [Cómo leer un CSV grande en .NET 11 sin quedarte sin memoria](/es/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) es útil cuando el archivo ya está completo y necesitas procesarlo.
- [Cómo ejecutar una aplicación C# basada en archivo con dotnet run en .NET 11](/es/2026/08/how-to-run-a-file-based-csharp-app-with-dotnet-run-in-dotnet-11/) explica las directivas `#:property` usadas en la sonda de arriba.

## Fuentes

- Raymond Chen, [Why is the file size reported incorrectly for files that are still being written to?](https://devblogs.microsoft.com/oldnewthing/20111226-00/?p=8813), The Old New Thing.
- [`FileInfo.Length` property](https://learn.microsoft.com/en-us/dotnet/api/system.io.fileinfo.length) y [`FileSystemInfo.Refresh`](https://learn.microsoft.com/en-us/dotnet/api/system.io.filesysteminfo.refresh), Microsoft Learn.
- [`RandomAccess.GetLength`](https://learn.microsoft.com/en-us/dotnet/api/system.io.randomaccess.getlength) y [`File.OpenHandle`](https://learn.microsoft.com/en-us/dotnet/api/system.io.file.openhandle), Microsoft Learn.
- Código fuente de dotnet/runtime: [`FileSystem.Attributes.Windows.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Common/src/System/IO/FileSystem.Attributes.Windows.cs) (`FillAttributeInfo`), [`FileSystemInfo.Windows.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/IO/FileSystemInfo.Windows.cs) (`Init` desde `FILE_FULL_DIR_INFORMATION`), [`FileSystemEnumerator.Windows.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/IO/Enumeration/FileSystemEnumerator.Windows.cs) (`NtQueryDirectoryFile`).
- [Performance tuning for file servers](https://learn.microsoft.com/en-us/windows-server/administration/performance-tuning/role/file-server), `FileInfoCacheLifetime` y `DirectoryCacheLifetime` del cliente SMB.
