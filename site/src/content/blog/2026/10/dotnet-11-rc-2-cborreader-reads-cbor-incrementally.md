---
title: ".NET 11 RC 2 Lets CborReader Parse a Payload One Chunk at a Time"
description: "System.Formats.Cbor 11.0.0-rc.2 adds isFinalBlock, NeedsMoreData, and SlideData to CborReader, so you can decode CBOR straight off a stream without buffering the whole document. Verified on SDK 11.0.100-rc.2."
pubDate: 2026-10-14
tags:
  - "dotnet-11"
  - "csharp"
  - "cbor"
  - "dotnet"
---

[.NET 11 Release Candidate 2](https://github.com/dotnet/core/discussions/10644) shipped on October 13, 2026, the second and last RC with a go-live license. The libraries notes open with a change that matters to anyone decoding CBOR from a socket, a pipe, or a large file: `CborReader` in `System.Formats.Cbor` can now read a payload delivered in chunks instead of demanding the whole document in one contiguous `ReadOnlyMemory<byte>` ([dotnet/runtime#134374](https://github.com/dotnet/runtime/pull/134374), a backport of [#133602](https://github.com/dotnet/runtime/pull/133602)).

## Why the old reader forced a full buffer

Until now, `CborReader` assumed it owned the complete document. If a WebAuthn attestation, a COSE message, or a CTAP2 response arrived over the network, you read the whole thing into a byte array first. For a few hundred bytes that is fine. For multi-megabyte CBOR logs or a long-lived stream of CBOR records, it means an allocation the size of the payload and no way to start work until the last byte lands.

## The three new pieces

The RC 2 package (`System.Formats.Cbor` 11.0.0-rc.2.26504.105) adds:

- A constructor overload `CborReader(ReadOnlyMemory<byte> data, CborReaderOptions? options, bool isFinalBlock)`.
- A new `CborReaderState.NeedsMoreData` value returned by `PeekState()` when the next item is cut off.
- `SlideData(ReadOnlyMemory<byte> data, bool isFinalBlock)` to hand the reader its next buffer, plus `Reset(data, isFinalBlock)` and non-throwing `TrySkipValue` / `TrySkipToParent`.

There is one hard requirement: incremental mode only works with `CborConformanceMode.Lax`. Passing `isFinalBlock: false` with `Strict` throws `ArgumentException: Reading CBOR data incrementally is only supported in the 'Lax' conformance mode.`

## Reading from a Stream

The official sample stops at "buffer management omitted". The part you have to supply is that `SlideData` replaces the buffer, so any bytes the reader has not consumed yet must be carried into the next one. `BytesRemaining` tells you how many that is:

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

I ran this on SDK 11.0.100-rc.2.26504.105 against a 10,003-byte array of 1,000 text strings. It returned all 1,000. Shrinking the chunk to 7 bytes still decoded every item, with 1,428 `SlideData` calls along the way. Starting from an empty buffer works too: the first `PeekState()` simply reports `NeedsMoreData`. In production you would rent `next` from `ArrayPool<byte>` rather than allocating per chunk.

## Always peek before you read

The resumable signal comes only from `PeekState()`. If you call `ReadTextString()` directly on a truncated item, you get `CborContentException: Declared definite length of CBOR data item exceeds available buffer size`, not a polite "need more data". Treat `PeekState()` as the gate for every read in incremental mode, or use `TrySkipValue` when you only want to step over items.

RC 2 has a go-live license, so this is usable in production today, with GA expected in November. If you are tracking the release, the previous libraries change I covered was [Process signals in RC 1](/2026/09/dotnet-11-rc-1-process-signal-exit-status/).
