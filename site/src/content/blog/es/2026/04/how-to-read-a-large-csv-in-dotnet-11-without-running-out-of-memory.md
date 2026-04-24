---
title: "Cómo leer un CSV grande en .NET 11 sin quedarte sin memoria"
description: "Haz streaming de un CSV de varios gigabytes en .NET 11 sin OutOfMemoryException. File.ReadLines, CsvHelper, Sylvan y Pipelines comparados con código y mediciones."
pubDate: 2026-04-24
tags:
  - ".NET 11"
  - "C# 14"
  - "Performance"
  - "CSV"
  - "Streaming"
lang: "es"
translationOf: "2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory"
translatedBy: "claude"
translationDate: 2026-04-24
---

Si tu proceso muere con `OutOfMemoryException` mientras lee un CSV, el arreglo es casi siempre la misma frase: deja de materializar el archivo, empieza a hacerle streaming. En .NET 11 y C# 14, `File.ReadLines` cubre el 80% de los casos, `CsvHelper.GetRecords<T>()` cubre el parseo tipado sin buffering, y `Sylvan.Data.Csv` más `System.IO.Pipelines` te dan el último orden de magnitud cuando el archivo está en el rango de 5-50 GB. Lo peor que puedes hacer es llamar a `File.ReadAllLines` o `File.ReadAllText` sobre cualquier cosa más grande que unos pocos megabytes, porque ambos cargan todo el payload en un `string[]` que tiene que vivir en el Large Object Heap hasta que el GC se convenza de que nadie lo está tocando.

Este post recorre las cuatro técnicas en orden de complejidad, muestra qué asigna cada una en realidad, y resalta las trampas que te van a morder cuando el CSV tenga campos multilínea entre comillas, un BOM, o necesite cancelarse a mitad de lectura. Versiones usadas: .NET 11, C# 14, `CsvHelper 33.x`, `Sylvan.Data.Csv 1.4.x`.

## Por qué tu lector de CSV está asignando gigabytes

Un CSV UTF-8 de 2 GB se convierte en aproximadamente un `string` de 4 GB en memoria, porque las strings de .NET son UTF-16. `File.ReadAllLines` va más allá y también asigna un `string` por línea, más el array `string[]` que las contiene. En un archivo con 20 millones de filas terminas con 20 millones de objetos en heap, el array de nivel superior en el Large Object Heap, y una pausa de GC de generación 2 de decenas de segundos cuando la presión finalmente fuerza una recolección. En procesos de 32 bits o contenedores constreñidos, el proceso simplemente muere.

El arreglo es leer un registro a la vez y dejar que cada registro sea elegible para la recolección de basura antes de que se parsee el siguiente. Esa es la definición de streaming, y cada técnica de abajo es un punto distinto en la curva de ergonomía vs throughput.

## El upgrade de una línea: `File.ReadLines`

`File.ReadAllLines` devuelve `string[]`. `File.ReadLines` devuelve `IEnumerable<string>` y lee perezosamente. Cambiar uno por otro suele bastar.

```csharp
// .NET 11, C# 14
using System.Globalization;

int rowCount = 0;
decimal total = 0m;

foreach (string line in File.ReadLines("orders.csv"))
{
    if (rowCount++ == 0) continue; // header

    ReadOnlySpan<char> span = line;
    int firstComma = span.IndexOf(',');
    int secondComma = span[(firstComma + 1)..].IndexOf(',') + firstComma + 1;

    ReadOnlySpan<char> amountSlice = span[(secondComma + 1)..];
    total += decimal.Parse(amountSlice, CultureInfo.InvariantCulture);
}

Console.WriteLine($"{rowCount - 1} rows, total = {total}");
```

La asignación en estado estable aquí es un `string` por línea más lo que la sobrecarga de `decimal.Parse` necesite. El working set pico se queda plano en unos pocos megabytes sin importar el tamaño del archivo, porque el enumerador lee a través de un buffer interno de `StreamReader` de 4 KB.

Dos advertencias que te morderán si te apoyas en esto para datos reales.

Primero, `File.ReadLines` no tiene conciencia de comillas CSV. Una celda que contenga `"first line\r\nsecond line"` se vuelve dos registros. Si tus datos vienen de Excel, exportaciones de Salesforce o de cualquier sitio donde escriban humanos, lo tocarás en una semana.

Segundo, el enumerador abre el archivo y mantiene el handle hasta que liberes el enumerador o lo iteres hasta el final. Si rompes el bucle antes, el handle se libera cuando el enumerador es finalizado, lo cual no es determinista. Envuelve el uso en un `IEnumerator<string>` explícito con `using` si eso importa para tu escenario.

## Streaming asíncrono con `StreamReader.ReadLineAsync`

Si lees desde un share de red, un bucket de S3, o cualquier sitio con latencia, el `foreach` síncrono bloquea un hilo por archivo. `StreamReader.ReadLineAsync` (sobrecargado en .NET 7+ para devolver `ValueTask<string?>`) y `IAsyncEnumerable<string>` son las primitivas correctas.

```csharp
// .NET 11, C# 14
public static async IAsyncEnumerable<string> ReadLinesAsync(
    string path,
    [EnumeratorCancellation] CancellationToken ct = default)
{
    using var stream = new FileStream(
        path,
        new FileStreamOptions
        {
            Access = FileAccess.Read,
            Mode = FileMode.Open,
            Share = FileShare.Read,
            Options = FileOptions.Asynchronous | FileOptions.SequentialScan,
            BufferSize = 64 * 1024,
        });

    using var reader = new StreamReader(stream);

    while (await reader.ReadLineAsync(ct) is { } line)
    {
        yield return line;
    }
}
```

Aquí se ajustan dos perillas relevantes en producción. `FileOptions.SequentialScan` le dice al SO que use read-ahead agresivo y descarte páginas después de que las pases, lo que evita que el page cache se pelee cuando el archivo es más grande que la RAM. `BufferSize = 64 * 1024` es cuatro veces el default y reduce mensurablemente el conteo de syscalls en almacenamiento NVMe; ir por encima de 64 KB rara vez ayuda.

Si necesitas honrar la cancelación de forma determinista, combina esto con un `CancellationTokenSource` que tenga un timeout. Para una discusión más larga sobre cómo cablear la cancelación a través de un pipeline async sin interbloquear, ver [cómo cancelar una Task de larga duración en C# sin interbloquear](/es/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/).

## Parseo tipado sin buffering: `GetRecords<T>()` de CsvHelper

Las líneas crudas están bien para datos con forma trivial. Para cualquier cosa con columnas anulables, delimitadores entre comillas, o cabeceras que quieres mapear a un POCO, CsvHelper es el default. El punto clave es que `GetRecords<T>()` devuelve `IEnumerable<T>` y reutiliza una sola instancia de registro durante toda la enumeración. Si materializas ese enumerable con `.ToList()`, has anulado toda la librería.

```csharp
// .NET 11, C# 14, CsvHelper 33.x
using System.Globalization;
using CsvHelper;
using CsvHelper.Configuration;

public sealed record Order(int Id, string Sku, decimal Amount, DateTime PlacedAt);

static async Task ProcessAsync(string path, CancellationToken ct)
{
    var config = new CsvConfiguration(CultureInfo.InvariantCulture)
    {
        HasHeaderRecord = true,
        MissingFieldFound = null,   // tolerate missing optional columns
        BadDataFound = null,        // silently skip malformed quotes; log these in prod
    };

    using var reader = new StreamReader(path);
    using var csv = new CsvReader(reader, config);

    await foreach (Order order in csv.GetRecordsAsync<Order>(ct))
    {
        // process one record; do NOT cache `order`, it is reused under synchronous mode
    }
}
```

`GetRecordsAsync<T>` devuelve `IAsyncEnumerable<T>` e internamente usa `ReadAsync`, así que un disco lento o un stream de red no matan de hambre al thread pool. Como el tipo es un `record` con un constructor explícito, CsvHelper genera setters por columna una vez vía reflection y luego reutiliza el camino para cada fila. En un archivo de pedidos de 1 GB con 12 columnas esto parsea a aproximadamente 600 K filas por segundo en un portátil moderno con working set fijado bajo 30 MB.

La advertencia que pilla a la gente que viene de `DataTable`: el objeto que recibes dentro del bucle es la misma instancia en cada iteración cuando CsvHelper usa su camino de reutilización. Si necesitas capturar filas en una cola downstream, clónalas explícitamente o proyéctalas a un nuevo record con expresiones `with`.

## Throughput máximo: Sylvan.Data.Csv y `DbDataReader`

CsvHelper es conveniente. No es el más rápido. Cuando necesitas empujar 100 MB/s a través de un solo core, `Sylvan.Data.Csv` es la librería que envía un `DbDataReader` sobre un CSV con casi cero asignación por celda. Evita el `string` por campo exponiendo `GetFieldSpan` y parsea números directamente desde el buffer subyacente de `char`.

```csharp
// .NET 11, C# 14, Sylvan.Data.Csv 1.4.x
using Sylvan.Data.Csv;

using var reader = CsvDataReader.Create(
    "orders.csv",
    new CsvDataReaderOptions
    {
        HasHeaders = true,
        BufferSize = 0x10000, // 64 KB
    });

int idOrd     = reader.GetOrdinal("id");
int skuOrd    = reader.GetOrdinal("sku");
int amountOrd = reader.GetOrdinal("amount");

long rows = 0;
decimal total = 0m;

while (reader.Read())
{
    rows++;
    // GetFieldSpan avoids allocating a string for fields you never need as a string
    ReadOnlySpan<char> amountSpan = reader.GetFieldSpan(amountOrd);
    total += decimal.Parse(amountSpan, provider: CultureInfo.InvariantCulture);

    // GetString only when you actually need the managed string
    string sku = reader.GetString(skuOrd);
    _ = sku;
}
```

En el mismo archivo de 1 GB esto llega a aproximadamente 2.5 M filas/s y asigna menos de 1 MB para toda la corrida, dominado por el buffer en sí. El truco es `GetFieldSpan` más sobrecargas como `decimal.Parse(ReadOnlySpan<char>, ...)` que no requieren un string intermedio. Las primitivas de parsing de .NET 11 están diseñadas alrededor de este patrón, y combinarlas con un reader que expone spans directamente elimina la asignación por celda por completo.

Como `CsvDataReader` hereda de `DbDataReader`, también puedes alimentarlo directamente a `SqlBulkCopy`, un `Execute` de Dapper, o un `ExecuteSqlRaw` de EF Core, que es como mueves un CSV de 10 GB a SQL Server sin materializarlo nunca en memoria gestionada. Si tu estado final es una base de datos, a menudo puedes saltarte el bucle de parseo por completo.

## El último 10%: `System.IO.Pipelines` con parseo UTF-8

Cuando el cuello de botella se vuelve la conversión UTF-16 en sí, baja al parseo a nivel de bytes con `System.IO.Pipelines`. La idea es mantener los bytes del archivo como UTF-8 hasta el final, segmentar el buffer en límites de `,` y `\n`, y usar `Utf8Parser.TryParse` o `int.TryParse(ReadOnlySpan<byte>, ...)` (añadido en .NET 7 y afinado más en .NET 11) para parsear valores sin asignación.

```csharp
// .NET 11, C# 14
using System.Buffers;
using System.Buffers.Text;
using System.IO.Pipelines;

static async Task<decimal> SumAmountsAsync(Stream source, CancellationToken ct)
{
    var reader = PipeReader.Create(source);
    decimal total = 0m;
    bool headerSkipped = false;

    while (true)
    {
        ReadResult result = await reader.ReadAsync(ct);
        ReadOnlySequence<byte> buffer = result.Buffer;

        while (TryReadLine(ref buffer, out ReadOnlySequence<byte> line))
        {
            if (!headerSkipped) { headerSkipped = true; continue; }
            total += ParseAmount(line);
        }

        reader.AdvanceTo(buffer.Start, buffer.End);

        if (result.IsCompleted) break;
    }

    await reader.CompleteAsync();
    return total;
}

static bool TryReadLine(ref ReadOnlySequence<byte> buffer, out ReadOnlySequence<byte> line)
{
    SequencePosition? position = buffer.PositionOf((byte)'\n');
    if (position is null) { line = default; return false; }

    line = buffer.Slice(0, position.Value);
    buffer = buffer.Slice(buffer.GetPosition(1, position.Value));
    return true;
}

static decimal ParseAmount(ReadOnlySequence<byte> line)
{
    ReadOnlySpan<byte> span = line.IsSingleSegment ? line.FirstSpan : line.ToArray();
    int c1 = span.IndexOf((byte)',');
    int c2 = span[(c1 + 1)..].IndexOf((byte)',') + c1 + 1;
    ReadOnlySpan<byte> amount = span[(c2 + 1)..];

    Utf8Parser.TryParse(amount, out decimal value, out _);
    return value;
}
```

Esto es verboso, no maneja campos entre comillas, y no deberías echar mano de él a menos que hayas medido un cuello de botella real. Lo que obtienes a cambio es un throughput dentro del 10% de lo que el almacenamiento subyacente puede entregar, porque el código gestionado prácticamente no hace trabajo más allá de cazar comas. Un truco relacionado que ayuda cuando el camino caliente tiene un conjunto pequeño de delimitadores o bytes centinela es [`SearchValues<T>` introducido en .NET 10](/2026/01/net-10-performance-searchvalues/), que vectoriza el escaneo para cualquier byte dentro de un conjunto.

## Trampas que te morderán en producción

Los campos multilínea entre comillas rompen cualquier enfoque basado en líneas. Un parser CSV correcto rastrea un estado "dentro de comillas" a través de los límites de línea. `File.ReadLines`, `StreamReader.ReadLine`, y el ejemplo casero de `Pipelines` de arriba lo hacen todos mal. CsvHelper y Sylvan lo manejan. Si estás escribiendo tu propio parser por razones de rendimiento, también te estás apuntando a implementar RFC 4180 tú mismo.

El BOM UTF-8 (`0xEF 0xBB 0xBF`) aparece al inicio de archivos producidos por Excel y muchas herramientas de Windows. `StreamReader` lo elimina por defecto; `PipeReader.Create(FileStream)` no. Compruébalo explícitamente antes del primer parseo de campo, o el primer nombre de cabecera se verá como `\uFEFFid` y tu lookup ordinal lanzará.

`File.ReadLines` y el flujo de CsvHelper de arriba mantienen el handle del archivo abierto durante la vida del enumerador. Si necesitas borrar o renombrar el archivo mientras el llamador está iterando (por ejemplo, un directorio inbox observado), pasa `FileShare.ReadWrite | FileShare.Delete` cuando abras el `FileStream` manualmente.

El procesamiento paralelo de filas CSV es tentador y normalmente equivocado a menos que tu trabajo por fila esté genuinamente ligado a CPU. El parsing está ligado a I/O, y el parser en sí no es thread-safe. El patrón correcto es parsear en un solo hilo y publicar filas en un `Channel<T>` que abanique a workers. El [recorrido de `IAsyncEnumerable<T>` para EF Core 11](/es/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) muestra el mismo patrón de un solo productor y múltiples consumidores contra una fuente de base de datos; la forma se transfiere directamente.

Si el archivo está comprimido, no lo descomprimas a disco primero. Encadena el stream de descompresión a tu parser:

```csharp
// .NET 11, C# 14
using var file = File.OpenRead("orders.csv.zst");
using var zstd = new ZstandardStream(file, CompressionMode.Decompress);
using var reader = new StreamReader(zstd);
// feed `reader` to CsvReader or parse lines directly
```

Para contexto sobre el nuevo soporte built-in de Zstandard, ver [la compresión nativa Zstandard de .NET 11](/2026/04/dotnet-11-zstandard-compression-system-io/). Antes de .NET 11 necesitabas el paquete NuGet `ZstdNet`; la versión de System.IO.Compression es significativamente más rápida y evita una dependencia P/Invoke.

La cancelación importa más de lo que crees. Un parseo de 20 GB de CSV es una operación de varios minutos. Si el llamador se rinde, quieres que el enumerador lo note en el siguiente registro y lance `OperationCanceledException`, no que corra hasta el final. Todas las variantes async de arriba enhebran un `CancellationToken`; para el bucle síncrono `File.ReadLines`, comprueba `ct.ThrowIfCancellationRequested()` dentro del cuerpo del bucle a un intervalo sensato (cada 1000 filas, no cada fila).

## Eligiendo la herramienta correcta

Si tu CSV es de menos de 100 MB y de forma trivial, usa `File.ReadLines` más `string.Split` o slicing con `ReadOnlySpan<char>`. Si tiene comillas, anulabilidad, o quieres registros tipados, usa `GetRecordsAsync<T>` de CsvHelper. Si el throughput domina y tus datos están bien formados, usa `CsvDataReader` de Sylvan y parsea directamente desde spans. Solo baja a `System.IO.Pipelines` cuando hayas medido un cuello de botella específico en la conversión UTF-16 y tengas el presupuesto para mantener un parser personalizado.

El hilo común a las cuatro: nunca buffereas el archivo entero. En el momento en que llamas a `ToList`, `ReadAllLines`, o `ReadAllText`, has renunciado a la propiedad de streaming y tu huella de memoria ahora crece con la entrada. En un archivo de 20 GB en un contenedor de 4 GB, eso termina de una sola forma.

## Fuentes

- [File.ReadLines en MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.file.readlines)
- [FileStreamOptions en MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.filestreamoptions)
- [Documentación de CsvHelper](https://joshclose.github.io/CsvHelper/)
- [Sylvan.Data.Csv en GitHub](https://github.com/MarkPflug/Sylvan)
- [System.IO.Pipelines en .NET](https://learn.microsoft.com/en-us/dotnet/standard/io/pipelines)
- [Utf8Parser en MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.buffers.text.utf8parser)
