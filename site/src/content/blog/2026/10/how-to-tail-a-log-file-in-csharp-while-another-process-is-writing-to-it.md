---
title: "How to tail a log file in C# while another process is still writing to it"
description: "Open the log with FileShare.ReadWrite | FileShare.Delete, seek to the end, poll for new bytes, decode them with your own UTF-8 Decoder instead of StreamReader, and handle truncation and rotation explicitly. A tested tail -F implementation for .NET 10 and .NET 11."
pubDate: 2026-10-11
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "file-io"
  - "logging"
  - "async"
---

To read a log file that another process still has open for writing, open it with `new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)`. `FileShare.ReadWrite` is what stops the `IOException: The process cannot access the file because it is being used by another process`, because the writer already holds write access and your share mode has to allow it. `FileShare.Delete` lets the writer rename or delete the file during log rotation without failing. Then seek to the end, poll for new bytes on a timer, and only emit text up to the last `\n`. Do not read the bytes through `StreamReader`: at end-of-file it flushes its decoder, which corrupts any multi-byte UTF-8 character the writer has only half-written. Finally, check for truncation (`fs.Length < fs.Position`) and for rotation (the path now names a different file) every time you hit EOF. Everything below was run on macOS with .NET 10.0.10 (SDK 10.0.302) and .NET 11 RC1 (SDK 11.0.100-rc.1.26425.128); the Windows sharing rules are taken from the runtime source and the Win32 contract.

## Why File.ReadAllText throws on a live log file

Every open on Windows carries two things: the access you want (`FileAccess`) and the access you are willing to let others have at the same time (`FileShare`). A second open succeeds only if both sides agree: your requested access must be allowed by every existing handle's share mode, and every existing handle's access must be allowed by your share mode.

Loggers almost always open their file like this. Here is the line from [Serilog.Sinks.File's `FileSink`](https://github.com/serilog/serilog-sinks-file/blob/main/src/Serilog.Sinks.File/Sinks/File/FileSink.cs) when `shared: false` (the default):

```csharp
// Serilog.Sinks.File, non-shared mode
System.IO.File.Open(path, FileMode.OpenOrCreate, FileAccess.Write, FileShare.Read);
```

The writer holds `FileAccess.Write` and allows others to read. Now look at what the convenience APIs do. `File.ReadAllText`, `File.ReadAllLines`, `File.ReadLines` and `new StreamReader(path)` all end up in the same helper in [`StreamReader.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/IO/StreamReader.cs):

```csharp
// dotnet/runtime, StreamReader path constructor
new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, FileStream.DefaultBufferSize);
```

`FileShare.Read` means "nobody else may write while I have this open". But somebody already is writing, so Windows refuses the open with `ERROR_SHARING_VIOLATION` (win32 error 32, HResult `0x80070020`), and .NET surfaces it as `IOException: The process cannot access the file 'app.log' because it is being used by another process.` The fix is not a retry loop. The fix is to ask for a share mode that tolerates the writer:

```csharp
// .NET 10 / .NET 11, C# 14
using var fs = new FileStream(
    "app.log",
    FileMode.Open,
    FileAccess.Read,
    FileShare.ReadWrite | FileShare.Delete);
```

If the writer opened the file with `FileShare.None`, no share mode on your side helps. That writer has asked for exclusive access, and you can only wait until it closes the handle.

### What changes on Linux and macOS

Unix has no mandatory share modes, so .NET emulates them. Since .NET 6, [`SafeFileHandle.Unix.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/Microsoft/Win32/SafeHandles/SafeFileHandle.Unix.cs) takes an advisory `flock`: `LOCK_EX` when you pass `FileShare.None`, `LOCK_SH` for every other share value. Two consequences, both of which I reproduced on macOS with .NET 10.0.10:

1. `File.ReadAllText` on a file a .NET writer holds with `FileShare.Read` succeeds on Unix. Code that "works on my Mac" can still throw in production on Windows.
2. A .NET writer that tries to open with `FileShare.None` while your tailer has the file open fails with `IOException` (HResult `0x23` on macOS), because your shared lock blocks its exclusive one. Non-.NET writers do not participate in `flock` at all.

The locking can be switched off with the `System.IO.DisableFileLocking` runtime switch (environment variable `DOTNET_SYSTEM_IO_DISABLEFILELOCKING=1`), which some teams need on NFS mounts without a lock daemon. Passing `FileShare.ReadWrite | FileShare.Delete` is still the right call on Unix: it documents intent and behaves identically on Windows.

## The two bugs a naive tail loop has

Once the open works, the obvious implementation is a `StreamReader` and a loop around `ReadLine()`. `StreamReader` does not latch end-of-file, so when the writer appends more data, the next `ReadLine` returns it. That part is fine. Two other things are not.

First, partial lines. If the writer has flushed `"line1\npart"` and you call `ReadLine()` twice, you get `"line1"` and then `"part"`. When the writer later appends `"ial2\n"`, you get `"ial2"`. One log line is now two records. I ran exactly that sequence and got `[line1] [part]`, then `[ial2]` after the append.

Second, and much less known, split characters. `StreamReader` hands bytes to a UTF-8 `Decoder`, which can hold the first bytes of a multi-byte character until the rest arrive. But when the underlying stream returns 0 bytes, `StreamReader` treats that as the end of the stream and calls `_decoder.GetChars(..., flush: true)`. A flushed decoder turns any incomplete sequence into `U+FFFD`. On a growing file, "the end of the stream" is just "the writer has not caught up yet". This repro writes `"żółć\n"` in two chunks, splitting `ó` after its first byte:

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

The output is `ż��łć` on .NET 10.0.10 and on .NET 11 RC1, with both `Read` and `ReadAsync`. Logs full of non-ASCII user names, file paths or messages will hit this the moment a writer flushes mid-character, which buffered writers do whenever their buffer boundary lands inside one.

The fix for both problems is the same: read bytes from the `FileStream` yourself, decode them with your own `Decoder` and `flush: false`, and keep the text after the last newline in a buffer until the rest of the line shows up.

## A tail -F implementation that survives rotation

Here is the full helper. It exposes the stream of lines as an `IAsyncEnumerable<string>`, so consumers write `await foreach` and cancel with a token.

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

Using it from a console app or a `BackgroundService` looks like this:

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

I tested it against a second process that wrote lines in two chunks (split inside a two-byte character, with flushes and 120 ms pauses between them), then renamed the file to `app.log.1` and started a new one, then truncated the new one and kept writing. The tailer printed every line intact, with no replacement characters, followed the rename to the new file, and restarted from the top after the truncation, on both .NET 10.0.10 and .NET 11 RC1.

## How each piece earns its place

Taken in order, the loop does five things:

1. **Opens with `FileShare.ReadWrite | FileShare.Delete`.** `ReadWrite` tolerates the writer. `Delete` matters for rotation on Windows: loggers that archive by renaming `app.log` to `app.log.1` call `MoveFile`, which fails with a sharing violation if any open handle lacks `FILE_SHARE_DELETE`. Without it, your tailer breaks the application's log rotation, which is a far worse bug than a missed line.
2. **Seeks to the end on first open.** That is `tail -f` semantics: show what happens from now on. Pass `fromStart: true` to replay the whole file. After a rotation the helper always reads the new file from the beginning, because everything in it is new.
3. **Polls with `Task.Delay`.** A 250 ms poll at EOF is one `read` syscall that returns 0, plus one `open` and `fstat` for the rotation probe. That is negligible. `FileSystemWatcher` looks tempting, but it does not work on many network shares and container bind mounts, its internal buffer overflows under bursts and drops events, and an appending writer's `Changed` notifications are coalesced and delayed by the OS. Use it, if at all, as a hint that cuts the delay short, never as the only trigger.
4. **Decodes with `flush: false` and buffers partial lines.** `DrainCompleteLines` yields only text terminated by `\n`, strips a trailing `\r` so CRLF logs come out clean, and leaves the incomplete tail in `pending`.
5. **Checks for truncation and rotation only at EOF.** While there are bytes to read, nothing else matters. When there are none, the handle-based `fs.Length < fs.Position` catches `copytruncate`, and `WasReplaced` catches rename-and-recreate.

### Why rotation needs its own check

When `logrotate` (or NLog's archiving, or your own code) renames `app.log` and creates a fresh one, your handle does not follow the name. Handles point at files, not paths: both on Unix and on Windows with `FILE_SHARE_DELETE`, the old handle keeps reading the renamed file, which will never grow again. The tailer would sit at EOF forever while the application happily writes to the new `app.log`.

`WasReplaced` opens the path again and compares lengths. For an append-only log, if the path still names the file you are reading, its length equals your position (you are at EOF) or the writer has appended since, in which case `current.Length` is at least as large because it is read afterwards. A path length below your position or above your handle's length means a different file. I measure through a fresh handle rather than `FileInfo.Length` because on Windows, size information that comes from the directory entry can lag behind a file that is still open for writing.

The check has one blind spot: a new file that has exactly the same length as the old one at every probe. That window closes as soon as the new file grows. If you need airtight identity, compare the file ID (`GetFileInformationByHandle` on Windows, `st_dev` plus `st_ino` from `fstat` on Unix) through P/Invoke. .NET does not expose either publicly as of .NET 11.

## Reading only the last N lines first

`tail -n 50 -f` shows recent context before following. Reading a 2 GB file to find its last 50 lines is wasteful, so read a window from the end instead:

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

Here `StreamReader` is fine, because this is a one-shot read: the only partial data is at the very start (skipped) and possibly the final line, which you may show as-is. Seeking into the middle of the file can land inside a UTF-8 sequence, which is another reason the first line is thrown away. If 64 KB does not contain `count` lines, double `maxBytes` and try again. Call it, print the result, then start `FollowAsync` with `fromStart: false`. A few lines written between the two calls can be lost; if that matters, have `ReadLastLinesAsync` return the offset it stopped at and start following from there.

## Gotchas that are not the reader's fault

**The writer must flush.** You can only see what has reached the OS. Serilog's file sink defaults to `buffered: false`, and NLog's file target has `autoFlush="true"` by default, but `StreamWriter` with `AutoFlush = false` holds up to its buffer size in memory. Plenty of "the tailer misses the last lines" reports are a writer that has not flushed yet.

**`copytruncate` loses data, by design.** In my test, the writer truncated the file 120 ms after its last write, and the tailer, polling every 250 ms, never saw that line. `logrotate`'s own documentation warns that lines written between the copy and the truncate are lost. Prefer rename-based rotation (`create`) with an application that reopens its file, or keep the poll interval short.

**Do not open with `FileAccess.ReadWrite`.** Some snippets online do, presumably to "match" the writer. You only need read access, and on Windows requesting write access fails if the writer opened with `FileShare.Read`.

**Encoding and BOMs.** The helper assumes UTF-8, which is what Serilog, NLog, Microsoft.Extensions.Logging console redirection and almost every Unix tool write. If you follow UTF-16 logs, swap the `Decoder`, and if you replay with `fromStart: true` on a file that starts with a UTF-8 BOM, trim `'\uFEFF'` from the first line.

**Very long lines.** `pending` grows until a newline arrives. If a writer can emit unbounded lines (binary garbage, a minified JSON blob), cap `pending.Length` and emit or discard what you have once it exceeds the cap.

**Several writers.** Serilog's `shared: true` and multiple processes appending to one file only work because each write goes to the end of the file atomically. The tailer does not care how many writers there are, but interleaving between their partial writes is the writers' problem, not yours.

## Related reading

- If the question is not "what has been appended" but "is this file finished yet", see [how to detect when a file finishes being written to in .NET](/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/), which covers `FileShare.None` probing and size stabilization.
- `FollowAsync` is an async stream. [What `IAsyncEnumerable` is and when to use it](/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/) explains why `[EnumeratorCancellation]` is on the token parameter.
- To stop the tail cleanly from a hosted service, [propagate the `CancellationToken` through the async call chain](/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/).
- If you want to fan lines out to several consumers, put a [`Channel<T>` between the tailer and the processors](/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/).
- For the writer side, [structured logging with Serilog and Seq in .NET 11](/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) shows the file sink configuration this post reads from.

## Sources

- [`StreamReader.cs` in dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/IO/StreamReader.cs): the `FileShare.Read` path constructor and the `flush: true` decode at end of stream.
- [`SafeFileHandle.Unix.cs` in dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/Microsoft/Win32/SafeHandles/SafeFileHandle.Unix.cs): `LOCK_SH` / `LOCK_EX` emulation of `FileShare` and the `System.IO.DisableFileLocking` switch.
- [`FileSink.cs` in serilog-sinks-file](https://github.com/serilog/serilog-sinks-file/blob/main/src/Serilog.Sinks.File/Sinks/File/FileSink.cs): how Serilog opens its log file.
- [`FileShare` enum on Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.fileshare).
- [`Decoder.GetChars` on Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.text.decoder.getchars), including the `flush` parameter.
- [dotnet/runtime issue 48757](https://github.com/dotnet/runtime/issues/48757): file locking on NFS and `DOTNET_SYSTEM_IO_DISABLEFILELOCKING`.
