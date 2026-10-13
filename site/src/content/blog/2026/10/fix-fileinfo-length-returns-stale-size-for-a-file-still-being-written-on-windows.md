---
title: "Fix: FileInfo.Length returns a stale size for a file that is still being written on Windows"
description: "FileInfo caches its size, enumeration reads NTFS's lazily updated directory entry, and the writer may still hold bytes in its own buffers. Refresh(), or better, read the length from a shared handle with RandomAccess.GetLength."
pubDate: 2026-10-13
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "dotnet-11"
  - "csharp"
  - "filesystem"
---

`FileInfo.Length` lies for three separate reasons, and they stack. First, a `FileInfo` caches its data the first time you read any property and never re-reads it until you call `Refresh()`. Second, a `FileInfo` that came from `DirectoryInfo.EnumerateFiles` or `GetFiles` on Windows is filled from the NTFS directory entry, and NTFS only brings that copy of the size up to date when the writer closes its last handle. Third, the writing process may still hold the bytes in its own `StreamWriter` / `FileStream` buffers, so the OS really has not seen them yet. The reliable fix is to stop asking the path and ask a handle: `using var h = File.OpenHandle(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete); long size = RandomAccess.GetLength(h);`. If you control the writer, flush it. The buffering numbers below were measured on .NET 10.0.10 (SDK 10.0.302) and .NET 11 RC1 (SDK 11.0.100-rc.1.26425.128), and they came out identical. The Windows-specific code paths are quoted from the dotnet/runtime source on `main`.

## The symptom in context

No exception is thrown. The bug report usually reads like one of these:

```
// what people see, .NET 10 / .NET 11 on Windows
size = 0          // the log file is clearly growing in Notepad++
size = 4096       // the writer has logged 6000 characters
size = 1048576    // Explorer says 1 MB, the copy job says 37 MB
```

The pattern is always the same. A monitoring loop, an upload job, or a "wait until the file stops growing" check reads `FileInfo.Length` while another process (or another thread) has the file open for writing. The number is behind, sometimes frozen, and it jumps to the right value as soon as the writer closes the file. Explorer and `dir` show the same frozen number, which convinces people the problem is Windows and not their code. It is partly both.

## Why this happens

There are three layers, and each one can cause the problem on its own.

**1. `FileInfo` is a snapshot, not a live view.** `FileSystemInfo` keeps a private `WIN32_FILE_ATTRIBUTE_DATA` struct and a `_dataInitialized` flag. The first property access populates it, and every later access returns the cached value. The [`FileInfo.Length` docs](https://learn.microsoft.com/en-us/dotnet/api/system.io.fileinfo.length) say this directly: the value is pre-cached when the instance came from `GetFiles` or `EnumerateFiles`, and you must call `Refresh` to get the latest value. A subtle detail: population is lazy. Constructing `new FileInfo(path)` does not touch the disk, so the "snapshot time" is whenever your code first reads `Length`, `Exists`, or any timestamp, which is often much earlier than you think.

**2. Enumeration reads the directory entry, and NTFS updates it lazily.** On Windows, `FileSystemEnumerator` calls `NtQueryDirectoryFile` with `FileFullDirectoryInformation`, and `FileSystemInfo.Init(FILE_FULL_DIR_INFORMATION*)` copies `EndOfFile` straight into the cached size. That number comes from the directory index, not from the file. As Raymond Chen explains in [Why is the file size reported incorrectly for files that are still being written to?](https://devblogs.microsoft.com/oldnewthing/20111226-00/?p=8813), NTFS treats size as a property of the file and only replicates it into the directory entry as an optimization for listings. Since Windows Vista, that replica is refreshed when the last handle to the file object closes. A writer that keeps a log open for hours leaves the directory entry at whatever size it had when the file was opened, which is often 0. This is exactly what Explorer, `dir`, `Directory.GetFiles` plus `new FileInfo(...)` on the result, and `FileSystemEntry.Length` in a custom `FileSystemEnumerable` all report.

**3. The writer has not written the bytes yet.** A `StreamWriter` holds characters in its own buffer, then hands encoded bytes to a `FileStream`, which has its own 4096-byte buffer by default. Until the buffers fill or someone calls `Flush()`, the operating system has not received a single byte, so every API on every platform correctly reports the old size. This layer is the one most people forget, because it looks identical to the other two from the outside.

A fourth layer only shows up on network shares: the SMB client redirector caches file metadata for path-based queries. `FileInfoCacheLifetime` and `DirectoryCacheLifetime` both default to 10 seconds on current Windows versions (see [Performance tuning for file servers](https://learn.microsoft.com/en-us/windows-server/administration/performance-tuning/role/file-server)), so a UNC path can show a size up to 10 seconds old even after a `Refresh()`.

## Minimal repro

This file-based app writes through a `StreamWriter` without flushing and samples the size four ways: a cached `FileInfo`, the same `FileInfo` after `Refresh()`, a fresh handle via `RandomAccess.GetLength`, and a `FileInfo` from directory enumeration. Run it with `dotnet run probe.cs`.

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

Output, identical on .NET 10.0.10 and .NET 11.0.0 RC1 (macOS arm64, APFS):

```
start: cached=0
after 1000 chars, no flush: cached=0 refreshed=0 handle=0 writer.BaseStream.Position=0
after 6000 chars, no flush: cached=0 refreshed=4096 handle=4096 writer.BaseStream.Position=5120
after StreamWriter.Flush(): cached=4096 refreshed=6000 handle=6000 writer.BaseStream.Position=6000
enumerated FileInfo (no Refresh) after +4000: 6000
enumerated FileInfo after Refresh: 10000
```

Read it line by line:

- After 1000 characters, nothing has reached the OS. `StreamWriter` is still holding everything, so even the handle says 0. No reader-side fix can help here.
- After 6000 characters, `StreamWriter` has pushed 5120 characters (five 1024-char chunks) into the `FileStream`, and the `FileStream` has written one full 4096-byte buffer to the OS. Every honest API says 4096. The cached `FileInfo` still says 0.
- After `Flush()`, the real size is 6000. The cached `FileInfo` says 4096, because the previous `Report` call refreshed it and nothing has refreshed it since.
- The enumerated `FileInfo` was frozen at enumeration time and needed a `Refresh()` to see the extra 4000 bytes.

On macOS and Linux, layers 1 and 3 are the whole story, because `stat` reads the inode and there is no separate directory copy of the size. On Windows, layer 2 comes on top: run the same program there and look at the folder in Explorer while it waits, and the directory listing stays behind the handle value until the writer is disposed. I have not benchmarked that half on a Windows box for this post. The mechanism is documented by Raymond Chen, and the exact code path (`NtQueryDirectoryFile` into `FileSystemInfo.Init`) is visible in the runtime source linked at the end.

## Fix, in detail

Pick the fix that matches the layer you are hitting. In most real code, you are hitting more than one.

### 1. Recommended: read the size from a handle, not from a path

A handle-based query goes to the open file object, which is where NTFS keeps the authoritative end-of-file. It is the only answer Raymond Chen describes as correct (`GetFileSize` on a handle), and it sidesteps both the `FileInfo` cache and the directory entry. Since .NET 6, you can do this without a `FileStream`:

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

`File.OpenHandle` plus `RandomAccess.GetLength` is lighter than `new FileStream(...).Length`: no buffer allocation, no position tracking, and on Windows `RandomAccess.GetLength` calls `GetFileInformationByHandleEx(FileStandardInfo)` on the handle and returns `EndOfFile`. If you already have a `FileStream` open on the file (for example, you are tailing it), use `stream.Length` on that stream. It goes through the same handle query.

One more cache hides here. On Windows, `SafeFileHandle` sets `_lengthCanBeCached` when the handle was opened read-only **and** without `FileShare.Write`, and from then on it returns the first length it fetched. That is correct, because no one can write to the file while your handle refuses write sharing. It does mean `FileShare.Read` is never the right choice for watching a growing file. If the writer is already running, your open fails. If you open first, the writer's open fails, which is worse because now you have broken the producer. Use `FileShare.ReadWrite` (plus `FileShare.Delete`), and the runtime queries the OS on every call.

The share mode matters. If you open with the default `FileShare.Read`, the open fails with `IOException: The process cannot access the file because it is being used by another process`, because the writer already has write access and your share mode refuses to allow it. That error is the most common reason people give up on the handle approach and go back to `FileInfo`.

A side effect worth knowing: opening and closing your own handle also makes NTFS update the directory entry when that handle closes, per the same Old New Thing post. So after a `GetLiveLength` call, Explorer and enumeration catch up too, until the writer appends again.

### 2. If you must use `FileInfo`, call `Refresh()` before every read

For a polling loop, keep one `FileInfo` and refresh it each iteration:

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

On Windows, `Refresh()` on a path-constructed `FileInfo` goes through `FileSystem.FillAttributeInfo`, which calls `GetFileAttributesEx` on the path and falls back to `FindFirstFile` (a directory-entry read) only when that call fails with something like `ERROR_SHARING_VIOLATION` or `ERROR_ACCESS_DENIED`. That fallback exists for `pagefile.sys` and files pending deletion. Microsoft does not document whether `GetFileAttributesEx` always reflects an open file's live size, so treat `Refresh()` as "fixes layer 1, probably fixes layer 2 on local NTFS" and use the handle approach anywhere correctness matters.

### 3. Never trust sizes from enumeration for files that may be open

`Directory.EnumerateFiles` returning paths is fine. `DirectoryInfo.EnumerateFiles` returning `FileInfo` objects, and `FileSystemEntry.Length` inside a `FileSystemEnumerable<T>` transform, are fast precisely because they reuse the directory entry's copy of the size. That is the copy NTFS updates lazily. Use enumeration to find candidate files, then query each one you care about:

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

The per-file open costs a few metadata round trips, which is why Explorer does not do it. For a folder with thousands of files, query only the ones that are new or recently modified.

### 4. If you control the writer, flush (and know what flush means)

No reader-side trick can see bytes that never left the writer's process. If a monitor needs to see progress, the writer has to push the bytes to the OS:

```csharp
// .NET 10 / .NET 11, C# 14
using var log = new StreamWriter(new FileStream(path, FileMode.Append,
    FileAccess.Write, FileShare.ReadWrite | FileShare.Delete))
{
    AutoFlush = true    // every Write call pushes through StreamWriter and FileStream to the OS
};
```

`AutoFlush = true` costs one system call per `Write`. For a high-volume logger, call `Flush()` on a timer or after each logical record instead. `Flush()` (or `Flush(false)` on a `FileStream`) hands the bytes to the OS cache, which is enough for other processes to see the new size. `FileStream.Flush(flushToDisk: true)` additionally forces them to the physical disk. That is for durability, not visibility, and it is much slower.

### 5. On network shares, account for the SMB client cache

A `Refresh()` on a UNC path can be served from the SMB redirector's file information cache for up to `FileInfoCacheLifetime` seconds (10 by default). Opening a handle, as in fix 1, sends an open request to the server, so it is the better choice here too. If you cannot change the code, you can lower the lifetime on the client with `Set-SmbClientConfiguration -FileInfoCacheLifetime 0`, but that slows every path-based metadata query on the machine. Treat it as a diagnostic, not a fix.

## Gotchas and lookalikes

**"The file is done" is a different question.** A stable size is not proof that the writer finished. It may simply be paused. If what you really need is "can I process this file now", use the rename-on-completion pattern or an exclusive-open probe from [how to detect when a file finishes being written to in .NET](/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/).

**Reading new bytes as they arrive** is also a separate problem. For that, keep one shared-read `FileStream` open and compare `fs.Length` to `fs.Position`, as shown in [how to tail a log file in C# while another process is writing to it](/2026/10/how-to-tail-a-log-file-in-csharp-while-another-process-is-writing-to-it/). That post also covers truncation and rotation, where a smaller size means "start over", not "stale".

**`LastWriteTime` is stale in the same ways.** The directory entry's timestamp is replicated just like its size, and `FileInfo` caches it in the same struct. Everything above applies to `LastWriteTimeUtc`, and NTFS can additionally defer timestamp updates on its own. Do not use a timestamp alone to detect growth.

**Pre-allocated files.** Some writers (databases, download managers, `FileStream` with `preallocationSize`, `SetLength` calls) extend the file to its final size up front and fill it in later. The handle reports the true end-of-file, which is already the final size. Here, "the size did not change" tells you nothing about progress. Use the writer's own progress signal.

**Memory-mapped writers.** A writer that maps the file and writes through the view changes content without changing the size, and the end-of-file was fixed when the mapping was created. Size-based polling cannot detect those writes at all.

**`IOException` when opening the handle.** If the writer opened the file with `FileShare.None` (the default for `File.Create` / `File.OpenWrite`), no other open is allowed, not even yours with `FileShare.ReadWrite`. Then you can only read the possibly stale path-based size, or change the writer. Catching that sharing violation is the basis of the "is it still being written" probe in the related post above.

## Related

- [How to detect when a file finishes being written to in .NET](/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/) covers stability polling, exclusive-open probes, and the producer-side rename trick.
- [How to tail a log file in C# while another process is writing to it](/2026/10/how-to-tail-a-log-file-in-csharp-while-another-process-is-writing-to-it/) is the handle-based reader in full, with rotation handling.
- [How to read a large CSV in .NET 11 without running out of memory](/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) is useful once the file is complete and you need to process it.
- [How to run a file-based C# app with dotnet run in .NET 11](/2026/08/how-to-run-a-file-based-csharp-app-with-dotnet-run-in-dotnet-11/) explains the `#:property` directives used in the probe above.

## Sources

- Raymond Chen, [Why is the file size reported incorrectly for files that are still being written to?](https://devblogs.microsoft.com/oldnewthing/20111226-00/?p=8813), The Old New Thing.
- [`FileInfo.Length` property](https://learn.microsoft.com/en-us/dotnet/api/system.io.fileinfo.length) and [`FileSystemInfo.Refresh`](https://learn.microsoft.com/en-us/dotnet/api/system.io.filesysteminfo.refresh), Microsoft Learn.
- [`RandomAccess.GetLength`](https://learn.microsoft.com/en-us/dotnet/api/system.io.randomaccess.getlength) and [`File.OpenHandle`](https://learn.microsoft.com/en-us/dotnet/api/system.io.file.openhandle), Microsoft Learn.
- dotnet/runtime source: [`FileSystem.Attributes.Windows.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Common/src/System/IO/FileSystem.Attributes.Windows.cs) (`FillAttributeInfo`), [`FileSystemInfo.Windows.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/IO/FileSystemInfo.Windows.cs) (`Init` from `FILE_FULL_DIR_INFORMATION`), [`FileSystemEnumerator.Windows.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/IO/Enumeration/FileSystemEnumerator.Windows.cs) (`NtQueryDirectoryFile`).
- [Performance tuning for file servers](https://learn.microsoft.com/en-us/windows-server/administration/performance-tuning/role/file-server), SMB client `FileInfoCacheLifetime` and `DirectoryCacheLifetime`.
