---
title: ".NET 11 RC 2: CborReader parst eine Nutzlast Chunk für Chunk"
description: "System.Formats.Cbor 11.0.0-rc.2 ergänzt CborReader um isFinalBlock, NeedsMoreData und SlideData. So decodieren Sie CBOR direkt aus einem Stream, ohne das ganze Dokument zu puffern. Geprüft mit SDK 11.0.100-rc.2."
pubDate: 2026-10-14
tags:
  - "dotnet-11"
  - "csharp"
  - "cbor"
  - "dotnet"
lang: "de"
translationOf: "2026/10/dotnet-11-rc-2-cborreader-reads-cbor-incrementally"
translatedBy: "claude"
translationDate: 2026-10-14
---

[.NET 11 Release Candidate 2](https://github.com/dotnet/core/discussions/10644) ist am 2026-10-13 erschienen, der zweite und letzte RC mit Go-Live-Lizenz. Die Notizen zu den Bibliotheken beginnen mit einer Änderung, die für alle relevant ist, die CBOR aus einem Socket, einer Pipe oder einer großen Datei decodieren: `CborReader` in `System.Formats.Cbor` kann jetzt eine in Chunks gelieferte Nutzlast lesen, statt das gesamte Dokument in einem zusammenhängenden `ReadOnlyMemory<byte>` zu verlangen ([dotnet/runtime#134374](https://github.com/dotnet/runtime/pull/134374), ein Backport von [#133602](https://github.com/dotnet/runtime/pull/133602)).

## Warum der bisherige Reader einen vollständigen Puffer erzwang

Bisher ging `CborReader` davon aus, dass ihm das komplette Dokument gehört. Kam eine WebAuthn-Attestation, eine COSE-Nachricht oder eine CTAP2-Antwort über das Netzwerk, mussten Sie sie zuerst vollständig in ein Byte-Array lesen. Bei ein paar hundert Bytes ist das unproblematisch. Bei CBOR-Logs von mehreren Megabyte oder einem langlebigen Strom von CBOR-Records bedeutet es eine Allokation in der Größe der Nutzlast und keine Möglichkeit, vor dem Eintreffen des letzten Bytes mit der Arbeit zu beginnen.

## Die drei neuen Bausteine

Das RC-2-Paket (`System.Formats.Cbor` 11.0.0-rc.2.26504.105) ergänzt:

- Eine Konstruktor-Überladung `CborReader(ReadOnlyMemory<byte> data, CborReaderOptions? options, bool isFinalBlock)`.
- Einen neuen Wert `CborReaderState.NeedsMoreData`, den `PeekState()` zurückgibt, wenn das nächste Element abgeschnitten ist.
- `SlideData(ReadOnlyMemory<byte> data, bool isFinalBlock)`, um dem Reader den nächsten Puffer zu übergeben, sowie `Reset(data, isFinalBlock)` und die nicht werfenden Methoden `TrySkipValue` / `TrySkipToParent`.

Es gibt eine harte Voraussetzung: Der inkrementelle Modus funktioniert nur mit `CborConformanceMode.Lax`. Wer `isFinalBlock: false` mit `Strict` übergibt, erhält `ArgumentException: Reading CBOR data incrementally is only supported in the 'Lax' conformance mode.`

## Aus einem Stream lesen

Das offizielle Beispiel endet bei "buffer management omitted". Den fehlenden Teil müssen Sie selbst liefern: `SlideData` ersetzt den Puffer, also müssen Bytes, die der Reader noch nicht verbraucht hat, in den nächsten Puffer übernommen werden. `BytesRemaining` sagt Ihnen, wie viele das sind:

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

Ich habe das mit SDK 11.0.100-rc.2.26504.105 gegen ein Byte-Array mit 10.003 Bytes und 1.000 Textstrings ausgeführt. Es lieferte alle 1.000 zurück. Auch mit einer Chunk-Größe von nur 7 Bytes wurde jedes Element decodiert, bei 1.428 `SlideData`-Aufrufen. Der Start mit einem leeren Puffer funktioniert ebenfalls: Das erste `PeekState()` meldet einfach `NeedsMoreData`. In Produktion würden Sie `next` aus `ArrayPool<byte>` mieten, statt pro Chunk zu allozieren.

## Immer erst peeken, dann lesen

Das Signal zum Fortsetzen kommt ausschließlich von `PeekState()`. Wenn Sie `ReadTextString()` direkt auf einem abgeschnittenen Element aufrufen, erhalten Sie `CborContentException: Declared definite length of CBOR data item exceeds available buffer size` statt eines höflichen "need more data". Behandeln Sie `PeekState()` im inkrementellen Modus als Schranke vor jedem Lesevorgang, oder verwenden Sie `TrySkipValue`, wenn Sie Elemente nur überspringen wollen.

RC 2 hat eine Go-Live-Lizenz und ist damit heute produktiv einsetzbar, GA wird im November erwartet. Wenn Sie das Release verfolgen: Die vorherige Änderung an den Bibliotheken, über die ich geschrieben habe, waren die [Prozesssignale in RC 1](/de/2026/09/dotnet-11-rc-1-process-signal-exit-status/).
