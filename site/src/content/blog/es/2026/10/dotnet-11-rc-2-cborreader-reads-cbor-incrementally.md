---
title: ".NET 11 RC 2 permite que CborReader procese un payload fragmento por fragmento"
description: "System.Formats.Cbor 11.0.0-rc.2 agrega isFinalBlock, NeedsMoreData y SlideData a CborReader, para que puedas decodificar CBOR directamente desde un stream sin almacenar todo el documento en un búfer. Verificado en el SDK 11.0.100-rc.2."
pubDate: 2026-10-14
tags:
  - "dotnet-11"
  - "csharp"
  - "cbor"
  - "dotnet"
lang: "es"
translationOf: "2026/10/dotnet-11-rc-2-cborreader-reads-cbor-incrementally"
translatedBy: "claude"
translationDate: 2026-10-14
---

[.NET 11 Release Candidate 2](https://github.com/dotnet/core/discussions/10644) se lanzó el 13 de octubre de 2026, la segunda y última RC con licencia go-live. Las notas de bibliotecas abren con un cambio que importa a cualquiera que decodifique CBOR desde un socket, un pipe o un archivo grande: `CborReader` en `System.Formats.Cbor` ahora puede leer un payload entregado en fragmentos, en lugar de exigir todo el documento en un único `ReadOnlyMemory<byte>` contiguo ([dotnet/runtime#134374](https://github.com/dotnet/runtime/pull/134374), un backport de [#133602](https://github.com/dotnet/runtime/pull/133602)).

## Por qué el lector anterior exigía un búfer completo

Hasta ahora, `CborReader` asumía que era dueño del documento completo. Si una atestación de WebAuthn, un mensaje COSE o una respuesta CTAP2 llegaba por la red, primero tenías que leerlo entero en un arreglo de bytes. Para unos cientos de bytes eso está bien. Para registros CBOR de varios megabytes o un stream de larga duración de registros CBOR, significa una asignación del tamaño del payload y ninguna forma de empezar a trabajar hasta que llega el último byte.

## Las tres piezas nuevas

El paquete de RC 2 (`System.Formats.Cbor` 11.0.0-rc.2.26504.105) agrega:

- Una sobrecarga del constructor `CborReader(ReadOnlyMemory<byte> data, CborReaderOptions? options, bool isFinalBlock)`.
- Un nuevo valor `CborReaderState.NeedsMoreData` que devuelve `PeekState()` cuando el siguiente elemento está cortado.
- `SlideData(ReadOnlyMemory<byte> data, bool isFinalBlock)` para entregarle al lector su siguiente búfer, además de `Reset(data, isFinalBlock)` y los métodos que no lanzan excepciones `TrySkipValue` / `TrySkipToParent`.

Hay un requisito estricto: el modo incremental solo funciona con `CborConformanceMode.Lax`. Pasar `isFinalBlock: false` con `Strict` lanza `ArgumentException: Reading CBOR data incrementally is only supported in the 'Lax' conformance mode.`

## Leer desde un Stream

El ejemplo oficial se detiene en "buffer management omitted". La parte que debes aportar tú es que `SlideData` reemplaza el búfer, así que los bytes que el lector aún no ha consumido deben pasarse al siguiente. `BytesRemaining` te dice cuántos son:

```csharp
static async Task<int> ReadAllStringsAsync(Stream stream)
{
    var options = new CborReaderOptions { ConformanceMode = CborConformanceMode.Lax };
    byte[] chunk = new byte[4096];
    ReadOnlyMemory<byte> buffer = ReadOnlyMemory<byte>.Empty;
    var reader = new CborReader(buffer, options, isFinalBlock: false);
    int count = 0;

    while (true)
    {
        switch (reader.PeekState())
        {
            case CborReaderState.NeedsMoreData:
                int read = await stream.ReadAsync(chunk);
                // Keep the bytes the reader has not consumed yet, then append the new chunk.
                ReadOnlyMemory<byte> unread = buffer[^reader.BytesRemaining..];
                byte[] next = new byte[unread.Length + read];
                unread.CopyTo(next);
                chunk.AsSpan(0, read).CopyTo(next.AsSpan(unread.Length));
                buffer = next;
                reader.SlideData(buffer, isFinalBlock: read == 0);
                break;
            case CborReaderState.StartArray: reader.ReadStartArray(); break;
            case CborReaderState.EndArray: reader.ReadEndArray(); break;
            case CborReaderState.TextString: reader.ReadTextString(); count++; break;
            case CborReaderState.Finished: return count;
            default: reader.SkipValue(); break;
        }
    }
}
```

Lo ejecuté en el SDK 11.0.100-rc.2.26504.105 contra un arreglo de 10 003 bytes con 1 000 cadenas de texto. Devolvió las 1 000. Reducir el fragmento a 7 bytes siguió decodificando todos los elementos, con 1 428 llamadas a `SlideData` en el camino. Empezar desde un búfer vacío también funciona: el primer `PeekState()` simplemente informa `NeedsMoreData`. En producción conviene alquilar `next` de `ArrayPool<byte>` en lugar de asignar uno por fragmento.

## Siempre haz peek antes de leer

La señal de reanudación viene únicamente de `PeekState()`. Si llamas a `ReadTextString()` directamente sobre un elemento truncado, obtienes `CborContentException: Declared definite length of CBOR data item exceeds available buffer size`, no un amable "necesito más datos". Trata `PeekState()` como la puerta de entrada de cada lectura en modo incremental, o usa `TrySkipValue` cuando solo quieras saltar elementos.

RC 2 tiene licencia go-live, así que ya se puede usar en producción hoy, con GA esperado en noviembre. Si sigues el lanzamiento, el cambio anterior de bibliotecas que cubrí fue [las señales de proceso en RC 1](/es/2026/09/dotnet-11-rc-1-process-signal-exit-status/).
