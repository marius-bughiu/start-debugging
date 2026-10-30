---
title: "Setter de FileSystemInfo.LastWriteTime vs File.SetLastWriteTime en .NET"
description: "Ambos terminan en la misma llamada al sistema operativo, así que la marca de tiempo que se escribe es idéntica. Las diferencias están alrededor: qué caché se invalida, si los directorios funcionan en Windows, cómo se convierte un DateTime que no es UTC y si puedes apuntar a un handle abierto. Usa File.SetLastWriteTimeUtc, por handle cuando el archivo está abierto. Verificado en .NET 10.0.10."
pubDate: 2026-10-30
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "dotnet-10"
  - "csharp"
  - "filesystem"
  - "io"
lang: "es"
translationOf: "2026/10/filesysteminfo-lastwritetime-setter-vs-file-setlastwritetime-in-dotnet"
translatedBy: "claude"
translationDate: 2026-10-30
---

Usa `File.SetLastWriteTimeUtc` (o `Directory.SetLastWriteTimeUtc` para carpetas), y usa la sobrecarga con `SafeFileHandle` si vas a fijar la hora de un archivo en el que todavía estás escribiendo. Usa el setter de `FileInfo.LastWriteTimeUtc` solo cuando ya tengas ese `FileInfo` y vayas a leer sus propiedades de nuevo después, porque el setter es la única API que también refresca la caché de esa instancia. Ambos caminos llaman al mismo `FileSystem.SetLastWriteTime` interno, así que los bits que llegan al disco son idénticos. Lo que cambia es todo lo que rodea esa llamada. En cualquier caso, pasa un `DateTime` con `Kind = Utc` al miembro `...Utc`, y nunca una hora local o sin especificar al que no es UTC.

Todo lo que sigue se ejecutó en .NET 10.0.10 (SDK 10.0.302, C# 14) sobre macOS 27 con APFS, en una máquina cuya zona horaria local es `Europe/Bucharest` (UTC+2 en la fecha de la prueba). El comportamiento en Windows está citado de la rama `release/10.0` de dotnet/runtime. El código involucrado casi no se ha movido desde .NET 7, cuando se añadieron las sobrecargas con handle, así que las mismas reglas aplican a .NET 8, 9 y las versiones preliminares de .NET 11.

## La comparación de un vistazo

| | `fileInfo.LastWriteTimeUtc = t` | `File.SetLastWriteTimeUtc(path, t)` |
| --- | --- | --- |
| Llamada al SO (Windows) | `SetFileInformationByHandle(FileBasicInfo)` | igual |
| Llamada al SO (Unix) | `utimensat(..., AT_SYMLINK_NOFOLLOW)` | igual |
| Invalida la caché de | solo esa instancia de `FileInfo` | nada (no hay caché) |
| Otros objetos `FileInfo` para la misma ruta | obsoletos hasta `Refresh()` | obsoletos hasta `Refresh()` |
| Directorio como destino en Windows | solo mediante `DirectoryInfo` | falla, usa `Directory.SetLastWriteTimeUtc` |
| Acepta un `SafeFileHandle` abierto | no | sí, desde .NET 7 |
| `DateTime.MinValue` con un setter de hora local, zona UTC+ | se ajusta en silencio | lanza `ArgumentOutOfRangeException` |
| Archivo inexistente | `FileNotFoundException` | `FileNotFoundException` |
| Costo por llamada (10k llamadas, APFS, M4) | 10.4 us | 10.7 us (por handle: 8.6 us) |

## Qué hacen realmente las dos APIs

Si quitas la superficie pública, ambas se encuentran en un solo lugar. Este es el lado de `FileSystemInfo`, de `FileSystemInfo.cs` y `FileSystemInfo.Windows.cs`:

```csharp
// dotnet/runtime release/10.0, System.Private.CoreLib
public DateTime LastWriteTime
{
    get => LastWriteTimeUtc.ToLocalTime();
    set => LastWriteTimeUtc = value.ToUniversalTime();
}

public DateTime LastWriteTimeUtc
{
    get => LastWriteTimeCore.UtcDateTime;
    set => LastWriteTimeCore = File.GetUtcDateTimeOffset(value);
}

internal DateTimeOffset LastWriteTimeCore   // Windows
{
    set
    {
        FileSystem.SetLastWriteTime(FullPath, value, (this is DirectoryInfo));
        _dataInitialized = -1;   // invalidate this instance's cache
    }
}
```

Y el lado de `File`:

```csharp
// dotnet/runtime release/10.0, File.cs
public static void SetLastWriteTime(string path, DateTime lastWriteTime)
    => FileSystem.SetLastWriteTime(Path.GetFullPath(path), lastWriteTime, false);

public static void SetLastWriteTimeUtc(string path, DateTime lastWriteTimeUtc)
    => FileSystem.SetLastWriteTime(Path.GetFullPath(path), GetUtcDateTimeOffset(lastWriteTimeUtc), false);
```

Ese `false` final es la bandera `asDirectory`, y importa en Windows (más abajo). En Unix, el setter de `FileInfo` pasa por su propio struct `FileStatus`, mientras que `File` usa un `default(FileStatus)` desechable, pero ambos llaman al mismo `SetAccessOrWriteTimeCore`. Ese método primero vuelve a hacer stat del archivo para poder reescribir sin cambios la hora de acceso actual, luego llama a `utimensat` con `AT_SYMLINK_NOFOLLOW` y después invalida la caché de estado. En Windows ambos abren la ruta con `FILE_WRITE_ATTRIBUTES` y llaman a `SetFileInformationByHandle` con un `FILE_BASIC_INFO` donde todos los campos excepto `LastWriteTime` son cero, lo que Windows interpreta como "dejar sin cambios".

Así que no existe un comportamiento tipo "el setter de `FileInfo` es perezoso" o "solo cambia el objeto en memoria", que es una suposición común. El setter escribe en el disco de inmediato, igual que el método estático.

## Invalidación de caché: la diferencia con la que sí te vas a topar

`FileSystemInfo` guarda en caché todo lo que lee. El primer acceso a una propiedad hace stat del archivo, y los accesos posteriores devuelven la instantánea hasta que algo llame a `Refresh()`. El setter invalida la caché de la instancia sobre la que lo llamaste, y nada más. Esta prueba hace visibles los tres casos:

```csharp
// .NET 10.0.10, C# 14 - run with: dotnet run probe.cs
var path = Path.Combine(Path.GetTempPath(), "a.txt");
File.WriteAllText(path, "hello");
var target = new DateTime(2020, 1, 2, 3, 4, 5, DateTimeKind.Utc);

var fi1 = new FileInfo(path);
var fi2 = new FileInfo(path);
_ = fi1.LastWriteTimeUtc; _ = fi2.LastWriteTimeUtc; // populate both caches

fi1.LastWriteTimeUtc = target;
Console.WriteLine(fi1.LastWriteTimeUtc.ToString("O")); // 2020-01-02T03:04:05.0000000Z
Console.WriteLine(fi2.LastWriteTimeUtc.ToString("O")); // 2026-10-30T12:04:26.3262150Z (stale)
fi2.Refresh();
Console.WriteLine(fi2.LastWriteTimeUtc.ToString("O")); // 2020-01-02T03:04:05.0000000Z

var fi3 = new FileInfo(path); _ = fi3.Length;          // snapshot now
File.SetLastWriteTimeUtc(path, target.AddYears(1));
Console.WriteLine(fi3.LastWriteTimeUtc.ToString("O")); // 2020-01-02... (stale)
Console.WriteLine(File.GetLastWriteTimeUtc(path).ToString("O")); // 2021-01-02...
```

Esta es la única razón real para preferir el setter. Si un método recibe un `FileInfo`, fija su marca de tiempo y luego quien lo llamó registra `fileInfo.LastWriteTime` o lo compara con otro archivo, el setter mantiene ese objeto honesto. Llamar a `File.SetLastWriteTimeUtc(fileInfo.FullName, t)` en el mismo lugar le deja al llamador un valor obsoleto, y ese error solo aparece cuando alguien lee la propiedad de nuevo. Si tomas ese camino, añade `fileInfo.Refresh()` después.

Lo inverso es igual de importante: el setter no alcanza a otras instancias de `FileInfo`, incluidas las que salieron de `DirectoryInfo.EnumerateFiles`. Esas se llenaron durante la enumeración y quedan congeladas. El mismo comportamiento de instantánea es lo que hace que `FileInfo.Length` mienta sobre archivos que crecen, lo cual cubrí en detalle en [por qué FileInfo.Length devuelve un tamaño obsoleto en Windows](/es/2026/10/fix-fileinfo-length-returns-stale-size-for-a-file-still-being-written-on-windows/).

## Directorios: la trampa solo de Windows en File.SetLastWriteTime

`File.SetLastWriteTime` siempre pasa `asDirectory: false`. En Windows esa bandera decide si `OpenHandleToWriteAttributes` añade `FILE_FLAG_BACKUP_SEMANTICS` a la llamada a `CreateFile`:

```csharp
// dotnet/runtime release/10.0, FileSystem.Windows.cs
int dwFlagsAndAttributes = Interop.Kernel32.FileOperations.FILE_FLAG_OPEN_REPARSE_POINT;
if (asDirectory)
{
    dwFlagsAndAttributes |= Interop.Kernel32.FileOperations.FILE_FLAG_BACKUP_SEMANTICS;
}
```

La [documentación de `CreateFile`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew) es explícita en que debes establecer `FILE_FLAG_BACKUP_SEMANTICS` para obtener un handle a un directorio, así que `File.SetLastWriteTimeUtc(@"C:\data\folder", t)` falla con un error de acceso denegado en Windows. `DirectoryInfo.LastWriteTimeUtc = t` pasa `this is DirectoryInfo` y funciona, igual que `Directory.SetLastWriteTimeUtc`.

En Linux y macOS la bandera solo afecta qué tipo de excepción se lanza para una ruta inexistente, así que la misma llamada a `File` sobre un directorio tiene éxito. Mi prueba lo confirmó en APFS. Es exactamente el tipo de código que pasa el CI en un runner de Linux y luego falla en la laptop con Windows de un desarrollador. Si tu código puede recibir un archivo o una carpeta, ramifica con `Directory.Exists` y llama a la clase estática correspondiente, o construye el subtipo correcto de `FileSystemInfo`.

Una rareza relacionada: `new FileInfo(directoryPath).Exists` es `false`, pero en Unix `new FileInfo(directoryPath).LastWriteTimeUtc = t` tiene éxito y marca el directorio. No te apoyes en eso.

## Local vs UTC: dónde divergen los dos caminos en valores extremos

Los miembros que no son UTC son donde las dos APIs dejan de ser simétricas. `File.SetLastWriteTime(string, DateTime)` pasa el `DateTime` directamente a un parámetro `DateTimeOffset`, así que se ejecuta la conversión implícita de `DateTime` a `DateTimeOffset`. El setter de `FileInfo.LastWriteTime` llama a `value.ToUniversalTime()` en su lugar. Para fechas normales coinciden, y ambos tratan `DateTimeKind.Unspecified` como hora local:

```text
File.SetLastWriteTime(Unspecified 12:00)    -> 09:00Z   (treated as local, UTC+3 in June)
File.SetLastWriteTimeUtc(Unspecified 12:00) -> 12:00Z   (treated as UTC)
File.SetLastWriteTime(Utc-kind 03:04:05Z)   -> 03:04:05Z (Kind honoured)
fi.LastWriteTime = Unspecified 12:00        -> 09:00Z
fi.LastWriteTimeUtc = Local-kind 12:00      -> 09:00Z   (Local converted, not reinterpreted)
```

Los extremos son diferentes. En cualquier zona horaria al este de UTC, `DateTime.MinValue` no tiene un equivalente UTC válido. `ToUniversalTime()` lo ajusta silenciosamente a `DateTime.MinValue`, mientras que la conversión implícita a `DateTimeOffset` se niega:

```csharp
// .NET 10.0.10, Europe/Bucharest (UTC+2)
File.SetLastWriteTime(path, DateTime.MinValue);
// ArgumentOutOfRangeException: The UTC time represented when the offset is applied
// must be between year 0 and 10,000. (Parameter 'offset')

new FileInfo(path).LastWriteTime = DateTime.MinValue; // no exception here
```

Al oeste de UTC, `DateTime.MaxValue` lanza de la misma manera. No usarías esos valores a propósito, pero las rutas de código de "restablecer a valor predeterminado" y los campos sin inicializar los ponen ahí más a menudo de lo que esperarías.

Superar la conversión no significa que el valor se pueda almacenar. El `FILETIME` de Windows empieza en 1601, y `DateTimeOffset.ToFileTime()` lanza `ArgumentOutOfRangeException: Not a valid Win32 FileTime.` para cualquier valor anterior, así que en Windows ambas APIs lanzan con `DateTime.MinValue`. APFS almacena un conteo de 64 bits con signo de nanosegundos desde 1970, así que en macOS la escritura "exitosa" de `DateTime.MinValue` termina en `1677-09-21T00:12:43.1452241Z`, el instante más temprano que APFS puede representar. Ninguno es lo que querías. Valida el rango tú mismo antes de llamar a cualquiera de las dos APIs.

El horario de verano es la otra razón para quedarte en los miembros `...Utc`. Una hora local durante la hora de retroceso del otoño es ambigua, y `ToUniversalTime()` elige la interpretación de hora estándar sin avisarte. Si la marca de tiempo vino de otra máquina, una base de datos o una entrada de archivo comprimido, casi seguro era UTC desde el principio. Mantenla así hasta el disco. El mismo consejo aplica a [los valores `DateTime` en payloads JSON](/es/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/).

## La sobrecarga con handle, y por qué los archivos abiertos deshacen tu marca de tiempo

Solo la clase estática tiene `File.SetLastWriteTime(SafeFileHandle, DateTime)` y `File.SetLastWriteTimeUtc(SafeFileHandle, DateTime)`, añadidos en .NET 7. Llaman a `SetFileInformationByHandle` o `futimens` sobre el handle que ya tienes, lo que evita la búsqueda por ruta y la apertura adicional.

La razón más importante para usarlos es el orden. Fijar la marca de tiempo mientras tu propio `FileStream` aún tiene bytes en el búfer es un error clásico, porque el SO vuelve a actualizar la hora de modificación cuando esos bytes se vacían en `Dispose`:

```csharp
// .NET 10.0.10, C# 14
using (var fs = new FileStream(p, FileMode.Create, FileAccess.Write, FileShare.ReadWrite))
{
    fs.Write(new byte[100]);               // sits in FileStream's 4 KB buffer
    File.SetLastWriteTimeUtc(p, target);
    // File.GetLastWriteTimeUtc(p) here: 2020-01-02T03:04:05Z
}
// File.GetLastWriteTimeUtc(p) here: 2026-10-30T12:04:26Z  <- your value is gone

using (var fs = new FileStream(p, FileMode.Create, FileAccess.Write, FileShare.ReadWrite))
{
    fs.Write(new byte[100]);
    fs.Flush();                            // all writes reach the OS first
    File.SetLastWriteTimeUtc(fs.SafeFileHandle, target);
}
// File.GetLastWriteTimeUtc(p) here: 2020-01-02T03:04:05Z  <- kept
```

La regla es "gana la última escritura": la marca de tiempo debe ser lo último que toque el archivo. Vacía, fija por handle y luego cierra. Fijarla después del bloque `using` por ruta también funciona, pero cuesta una segunda apertura y deja una ventana en la que otro proceso puede ver el archivo con la hora equivocada. Eso importa si un consumidor está [esperando a que el archivo termine de escribirse](/es/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/) o consulta las marcas de tiempo periódicamente, como lo hace el [enfoque de comparación de instantáneas en recursos compartidos de red](/es/2026/10/filesystemwatcher-vs-polling-for-detecting-file-changes-on-a-network-share-in-dotnet/).

`FileSystemInfo` no tiene un equivalente basado en handle, así que si necesitas este patrón, estás en `File` sin importar tu preferencia.

## Enlaces simbólicos, hora de creación y precisión

Tres cosas son iguales en ambos caminos, pero la gente suele equivocarse con ellas:

- **Enlaces simbólicos**: Windows abre con `FILE_FLAG_OPEN_REPARSE_POINT` y Unix llama a `utimensat` con `AT_SYMLINK_NOFOLLOW`, así que ambas APIs marcan el enlace en sí y dejan intacto el destino. Si quieres el destino, resuélvelo primero con `FileSystemInfo.ResolveLinkTarget(returnFinalTarget: true)` y fija la hora sobre el resultado.
- **Hora de creación en macOS**: fijar una hora de modificación anterior a la hora de nacimiento hace que el kernel retroceda la hora de nacimiento para igualarla. .NET detecta esto en macOS y restaura la hora de creación original con `setattrlist`, así que `File.GetCreationTimeUtc` no cambia después de que retrocedes `LastWriteTime`. En Linux no hay una hora de nacimiento configurable, y .NET informa la más antigua entre `ctime` y `mtime` como hora de creación.
- **Precisión**: `DateTime` tiene ticks de 100 ns. NTFS, APFS y ext4 los conservan todos (mi ida y vuelta de `...07.1234567Z` regresó exacta), FAT32 redondea a 2 segundos y exFAT conserva 10 ms. Si comparas marcas de tiempo entre volúmenes, por ejemplo en una herramienta de respaldo o sincronización, compara con una tolerancia en lugar de `==`.

Ambas APIs lanzan `FileNotFoundException` para un archivo inexistente. Esto es asimétrico con los getters, que devuelven `1601-01-01T00:00:00Z` en lugar de lanzar. Por eso, el código que lee la hora, decide y luego escribe puede ver cómo un archivo desaparece entre las dos llamadas y recibir una excepción de un método que parecía inofensivo. Si el archivo puede eliminarse de forma concurrente, captura `FileNotFoundException` alrededor de la escritura.

## El benchmark que no importa

Para completar: 10 000 llamadas cada una en un volumen APFS caliente (Apple M4, .NET 10.0.10, Release, `Stopwatch` alrededor de un bucle) cuestan 10.72 us por llamada para `File.SetLastWriteTimeUtc(path, t)`, 10.40 us para el setter de `FileInfo` y 8.60 us para la sobrecarga con handle sobre un handle ya abierto. Las variantes por ruta son iguales dentro del ruido, porque cada una hace un stat, un `utimensat` y, del lado de `FileInfo`, un reinicio de caché. El handle ahorra la resolución de la ruta. Nada de esto debería guiar tu elección. Si estás marcando miles de archivos, el stat dentro de cada llamada de escritura domina, y paralelizar sobre los archivos ayudará mucho más que cambiar de API.

## La recomendación, en resumen

Usa por defecto `File.SetLastWriteTimeUtc(path, utc)` y `Directory.SetLastWriteTimeUtc(path, utc)`. Son explícitos sobre qué tipo de entrada estás apuntando, no pueden dejar un objeto en caché desactualizado y tienen una sobrecarga con handle para el caso de "fijarlo en el archivo que acabo de escribir", que es donde nacen la mayoría de los errores con marcas de tiempo. Cambia a `fileInfo.LastWriteTimeUtc = utc` cuando el `FileInfo` sea la unidad de trabajo en tu código y alguien vaya a leer sus propiedades de nuevo, porque el setter es la única API que mantiene esa instancia sincronizada. Evita los miembros que no son UTC de ambos, y valida que el valor quepa en el rango del sistema de archivos de destino antes de escribirlo.

## Lecturas relacionadas

- [Por qué FileInfo.Length devuelve un tamaño obsoleto en Windows](/es/2026/10/fix-fileinfo-length-returns-stale-size-for-a-file-still-being-written-on-windows/) profundiza en la misma caché de `FileSystemInfo` desde el ángulo del tamaño.
- [Cómo detectar cuándo un archivo termina de escribirse en .NET](/es/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/) cubre el lado del consumidor de "gana la última escritura".
- [FileSystemWatcher vs sondeo en un recurso compartido de red](/es/2026/10/filesystemwatcher-vs-polling-for-detecting-file-changes-on-a-network-share-in-dotnet/) depende de marcas de tiempo que acabas de aprender a fijar correctamente.
- [Cómo seguir un archivo de registro mientras otro proceso escribe en él](/es/2026/10/how-to-tail-a-log-file-in-csharp-while-another-process-is-writing-to-it/) muestra las banderas `FileShare` usadas en las pruebas anteriores.
- [Cómo ejecutar una app de C# basada en archivo con dotnet run](/es/2026/08/how-to-run-a-file-based-csharp-app-with-dotnet-run-in-dotnet-11/) si quieres volver a ejecutar `probe.cs` tú mismo.

## Fuentes

- [`FileSystemInfo.LastWriteTime`](https://learn.microsoft.com/en-us/dotnet/api/system.io.filesysteminfo.lastwritetime) y [`File.SetLastWriteTimeUtc`](https://learn.microsoft.com/en-us/dotnet/api/system.io.file.setlastwritetimeutc) (Microsoft Learn)
- [`FileSystemInfo.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/IO/FileSystemInfo.cs), [`FileSystemInfo.Windows.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/IO/FileSystemInfo.Windows.cs), [`File.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/IO/File.cs) (dotnet/runtime)
- [`FileSystem.Windows.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/IO/FileSystem.Windows.cs), [`FileStatus.Unix.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/IO/FileStatus.Unix.cs), [`pal_time.c`](https://github.com/dotnet/runtime/blob/release/10.0/src/native/libs/System.Native/pal_time.c) (dotnet/runtime)
- [`CreateFileW`, `FILE_FLAG_BACKUP_SEMANTICS`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew) y [`FILE_BASIC_INFO`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_basic_info) (Microsoft Learn)
- [`utimensat(2)`](https://man7.org/linux/man-pages/man2/utimensat.2.html) (páginas man de Linux)
- [Horas de archivo, resolución por sistema de archivos](https://learn.microsoft.com/en-us/windows/win32/sysinfo/file-times) (Microsoft Learn)
