---
title: "What does FileShare actually control in .NET, and how does it interact with another handle's FileAccess?"
description: "FileShare is what you let other handles do while yours is open, and Windows checks it in both directions against every open handle's FileAccess. Linux and macOS only emulate it with an advisory flock, so 56 of 144 open combinations behave differently. The rule, the defaults of every File.* helper, and measured results on .NET 10."
pubDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
  - "file-io"
  - "windows"
  - "linux"
---

**Short answer:** `FileAccess` is what *your* handle wants to do with the file; `FileShare` is what you allow *every other handle* to do while yours stays open. On Windows a new open succeeds only if two checks pass against every handle already open on that file: the new handle's access must be allowed by each existing handle's share mode, and each existing handle's access must be allowed by the new handle's share mode. That second half is the one people miss: a reader that passes `FileShare.Read` to a file a logger already holds for writing fails, because the reader refuses to tolerate a writer that is already there. On Linux and macOS, .NET emulates all of this with an advisory `flock`: `FileShare.None` takes an exclusive lock, every other value takes a shared lock, so the only conflict is "someone used `FileShare.None`", and processes that are not .NET ignore it entirely. Everything below is .NET 10 (runtime 10.0.10, SDK 10.0.302). The Unix results were measured on macOS 27.0.1; the Windows column is computed from the documented Win32 rule and the .NET 10 source, not run on a Windows machine.

## The two values on every open

Every `FileStream`, `File.OpenHandle`, `StreamReader(path)`, and `File.ReadAllText` call ends up in one native open with two separate arguments:

- `FileAccess` (`Read`, `Write`, `ReadWrite`): the rights this handle requests. On Windows, .NET maps them to `GENERIC_READ` and `GENERIC_WRITE` in [`SafeFileHandle.Windows.cs`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Private.CoreLib/src/Microsoft/Win32/SafeHandles/SafeFileHandle.Windows.cs).
- `FileShare` (`None`, `Read`, `Write`, `ReadWrite`, `Delete`, `Inheritable`): the rights this handle is willing to let *other* handles hold at the same time. The numeric values of `Read`, `Write`, and `Delete` are literally `FILE_SHARE_READ`, `FILE_SHARE_WRITE`, and `FILE_SHARE_DELETE`, passed straight to `CreateFileW` as `dwShareMode`.

The [`FileShare` docs](https://learn.microsoft.com/en-us/dotnet/api/system.io.fileshare) describe `FileShare.Read` as "allows subsequent opening of the file for reading". That sentence is true but incomplete. The share mode is also checked against handles that were opened *before* yours.

## The Win32 rule, written as code

The [`CreateFileW` documentation](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew) states that you "cannot request a sharing mode that conflicts with the access mode that is specified in an existing request that has an open handle", and the [Creating and Opening Files](https://learn.microsoft.com/en-us/windows/win32/fileio/creating-and-opening-files) page has a table of valid combinations. Both say the same thing as this function:

```csharp
// .NET 10, C# 14
// Can a second open (a2, s2) succeed while a handle (a1, s1) is open? Windows rule.
static bool WindowsAllows(FileAccess a1, FileShare s1, FileAccess a2, FileShare s2)
{
    static bool Permits(FileShare share, FileAccess access) =>
        ((access & FileAccess.Read) == 0 || (share & FileShare.Read) != 0) &&
        ((access & FileAccess.Write) == 0 || (share & FileShare.Write) != 0);

    return Permits(s1, a2)   // existing handle's share allows the new access
        && Permits(s2, a1);  // new handle's share allows the existing access
}
```

With three or more handles, the check runs against every one of them. It does not matter whether the other handle lives in your process or in another one, and it does not matter whether that handle is still "in use": a `FileStream` you forgot to dispose holds its share mode until the finalizer runs.

When the check fails, `CreateFileW` returns `ERROR_SHARING_VIOLATION` (32) and .NET throws `IOException` with HResult `0x80070020` and the familiar message "The process cannot access the file '...' because it is being used by another process."

## Common pairs, both platforms

Here are the combinations that show up in real code. The "Linux/macOS" column is measured; the "Windows" column is `WindowsAllows` above.

| Handle already open (access / share) | New open (access / share) | Windows | Linux/macOS |
|---|---|---|---|
| Write / Read (a logger, `StreamWriter`) | Read / Read (`File.ReadAllText`) | fails | ok |
| Write / Read | Read / ReadWrite | ok | ok |
| Read / Read (`File.OpenRead`) | Write / Read (`File.WriteAllText`) | fails | ok |
| Read / ReadWrite | Write / Read | ok | ok |
| Read / Read | Read / Read | ok | ok |
| Read / Read | Read / None | fails | fails |
| Write / ReadWrite | Write / Read | fails | ok |
| Write / ReadWrite | Write / ReadWrite | ok | ok |
| ReadWrite / None (`File.Create`, `File.Open(path, mode)`) | Read / ReadWrite | fails | fails |

Row 1 is the classic "I can't read the log file" bug. The logger allows readers (`FileShare.Read`), so the first half of the check passes. But the reader's own `FileShare.Read` says "nobody may write while I'm open", and somebody already is, so the second half fails. The fix is on the reader's side: pass `FileShare.ReadWrite`, which is row 2. The [post on tailing a log file in C#](/2026/10/how-to-tail-a-log-file-in-csharp-while-another-process-is-writing-to-it/) builds a full reader on top of that one change.

Row 7 is the same trap between two writers. Two processes that append to a shared file both need `FileShare.ReadWrite` (or at least `Write`), because each one has to tolerate the other's write access.

## What .NET's convenience methods pass

Most sharing violations come from helpers whose share mode you never wrote. These are the values in the .NET 10 source ([`File.cs`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Private.CoreLib/src/System/IO/File.cs), [`FileInfo.cs`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Private.CoreLib/src/System/IO/FileInfo.cs), [`StreamReader.cs`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Private.CoreLib/src/System/IO/StreamReader.cs), [`StreamWriter.cs`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Private.CoreLib/src/System/IO/StreamWriter.cs)):

| API | FileAccess | FileShare |
|---|---|---|
| `File.ReadAllText`, `ReadAllLines`, `ReadLines`, `ReadAllBytes`, `OpenText`, `new StreamReader(path)` | Read | Read |
| `File.OpenRead`, `FileInfo.OpenRead` | Read | Read |
| `File.WriteAllText`, `WriteAllBytes`, `AppendAllText`, `AppendAllBytes`, `new StreamWriter(path)` | Write | Read |
| `File.OpenHandle(path)` with no share argument | Read | Read |
| `new FileStream(path, mode)` and `(path, mode, access)` | ReadWrite (Write for Append) | Read |
| `File.Create`, `FileInfo.Create` | ReadWrite | **None** |
| `File.OpenWrite`, `FileInfo.OpenWrite` | Write | **None** |
| `File.Open(path, mode)` and `File.Open(path, mode, access)`, same on `FileInfo` | ReadWrite (Write for Append) | **None** |

Two things stand out. First, every read helper uses `FileShare.Read`, which means none of them can open a file that something else is currently writing on Windows. Second, `File.Open` without a share argument is exclusive, while `new FileStream` with the same arguments shares for reading. Swapping one for the other in a refactor silently changes whether other processes can read your file.

The async variants (`ReadAllTextAsync`, `WriteAllBytesAsync`, and so on) use the same share modes as their synchronous counterparts.

## How Linux and macOS emulate FileShare

Unix has no share modes in `open(2)`. In .NET 10, [`SafeFileHandle.Unix.cs`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Private.CoreLib/src/Microsoft/Win32/SafeHandles/SafeFileHandle.Unix.cs) approximates them after the file is open:

```csharp
// dotnet/runtime v10.0.0, SafeFileHandle.Unix.cs (excerpt)
Interop.Sys.LockOperations lockOperation =
    (share == FileShare.None) ? Interop.Sys.LockOperations.LOCK_EX : Interop.Sys.LockOperations.LOCK_SH;
if (CanLockTheFile(lockOperation, access) &&
    !(_isLocked = Interop.Sys.FLock(this, lockOperation | Interop.Sys.LockOperations.LOCK_NB) >= 0))
{
    // only EWOULDBLOCK is turned into an IOException
}
```

So `Read`, `Write`, `ReadWrite`, and `Delete` all collapse into the same shared lock, and `FileAccess` plays no part in the decision. The source comment calls it "not as granular as Windows, not mandatory, and not atomic with file opening". To see exactly how far apart the two models are, this file-based app opens every pair of `FileAccess` x `FileShare` (`None`, `Read`, `Write`, `ReadWrite`) and compares the real outcome with the Win32 rule:

```csharp
// .NET 10.0.10, C# 14, file-based app: dotnet run probe.cs
using System.Runtime.InteropServices;

string path = Path.Combine(Path.GetTempPath(), "share-probe.txt");
File.WriteAllText(path, "hello");

var accesses = new[] { FileAccess.Read, FileAccess.Write, FileAccess.ReadWrite };
var shares = new[] { FileShare.None, FileShare.Read, FileShare.Write, FileShare.ReadWrite };

Console.WriteLine($"{RuntimeInformation.OSDescription}, .NET {Environment.Version}");
int differ = 0, total = 0;
foreach (var a1 in accesses) foreach (var s1 in shares)
foreach (var a2 in accesses) foreach (var s2 in shares)
{
    bool actual;
    using (var first = new FileStream(path, FileMode.Open, a1, s1))
    {
        try { using var second = new FileStream(path, FileMode.Open, a2, s2); actual = true; }
        catch (IOException) { actual = false; }
    }
    bool win = WindowsAllows(a1, s1, a2, s2);
    total++; if (actual != win) differ++;
    if (actual != win)
        Console.WriteLine($"{a1,-9}/{s1,-9} | {a2,-9}/{s2,-9} | {(actual ? "ok" : "FAIL"),-4} | {(win ? "ok" : "FAIL")}");
}
Console.WriteLine($"{differ} of {total} combinations differ from the Win32 rule");

static bool WindowsAllows(FileAccess a1, FileShare s1, FileAccess a2, FileShare s2)
{
    static bool Permits(FileShare share, FileAccess access) =>
        ((access & FileAccess.Read) == 0 || (share & FileShare.Read) != 0) &&
        ((access & FileAccess.Write) == 0 || (share & FileShare.Write) != 0);
    return Permits(s1, a2) && Permits(s2, a1);
}
```

On macOS 27.0.1 with .NET 10.0.10 it prints 56 lines and ends with:

```text
56 of 144 combinations differ from the Win32 rule
```

Of the 144 pairs, 81 open fine on macOS and 63 fail: exactly the pairs where either side passed `FileShare.None`. The Win32 rule allows only 25. All 56 differences go the same way: Unix allows an open that Windows refuses. There is no combination where code that works on Windows fails on Linux or macOS because of `FileShare` alone, but there are 56 where code that works on a developer's Mac throws `IOException` on a Windows server.

### The lock only binds .NET (and other flock users)

`flock` is advisory. Processes that never call it are not affected. While a .NET process held a file with `FileAccess.ReadWrite, FileShare.None`, the measured results were:

```text
holding
read failed: The process cannot access the file '.../share-xproc.txt' because it is being used by another process.
cat: ok
shell append: ok
```

The second .NET process was refused, but `cat` read the file and `echo appended >> file` wrote to it. The reverse also holds: a Python process that called `fcntl.flock(f, fcntl.LOCK_EX)` made a .NET `File.ReadAllText` throw the same "being used by another process" message, even though Python never heard of `FileShare`. On macOS the exception's HResult is `0x00000023` (`EWOULDBLOCK` is 35 there), not the Windows `0x80070020`, so code that filters on the Windows HResult never matches on Unix.

### Turning the emulation off

The `System.IO.DisableFileLocking` runtime switch, or the environment variable `DOTNET_SYSTEM_IO_DISABLEFILELOCKING=1`, disables the `flock` calls. With it set, the probe reports `119 of 144` differences, because nothing fails at all. Shared locks are also skipped automatically for write handles on NFS, SMB, and CIFS mounts (`CanLockTheFile` in the same file), which is why an exclusive open on a network share can behave differently from the same open on a local disk.

## FileShare.Delete and FileShare.Inheritable

`FileShare.Delete` maps to `FILE_SHARE_DELETE`. On Windows, deleting or renaming a file opens it with `DELETE` access, so `File.Delete` and `File.Move` fail with a sharing violation if any open handle lacks `FileShare.Delete`. The `CreateFileW` docs spell it out: delete access "allows both delete and rename operations". This is what breaks log rotation when a reader forgets the flag.

On Unix, `FileShare.Delete` changes nothing, because `unlink` and `rename` never consult `flock`. The probe confirmed that `File.Move` and `File.Delete` both succeed while another handle holds `FileShare.None`, and that the open handle keeps reading the now-unlinked file:

```text
Move under FileShare.None: ok, exists at old path=False
Delete under FileShare.None: ok, handle still reads 17 bytes
```

`FileShare.Inheritable` is not a sharing flag at all. .NET strips it before calling `CreateFileW` and sets `bInheritHandle` in the security attributes instead; on Unix it decides whether `O_CLOEXEC` is passed. It controls whether a child process inherits the handle, which matters because an inherited handle keeps its share mode alive in the child after your process closes its copy.

## Gotchas that follow from the rule

**A failed open does not truncate, unless locking is off.** On Windows, `CreateFileW` checks sharing before applying `FileMode.Create`. On Unix, .NET opens without `O_TRUNC` and calls `ftruncate` only after it gets the lock. The probe confirmed it: with a `FileShare.None` handle open, `File.Create` threw and the file kept its 17 bytes. With `DOTNET_SYSTEM_IO_DISABLEFILELOCKING=1` set, the same `File.Create` succeeded and the file was 0 bytes long while the first handle was still using it.

**Metadata does not need a data handle.** `File.Exists` and `new FileInfo(path).Length` returned the right values while the file was held with `FileShare.None` (measured on macOS; on Windows they read attributes without requesting `GENERIC_READ`). A successful `File.Exists` tells you nothing about whether the next `File.OpenRead` will work, which is why [detecting when a file has finished being written](/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/) needs an actual open probe. Attribute reads have their own staleness problem on Windows, covered in [why FileInfo.Length returns a stale size for a file still being written](/2026/10/fix-fileinfo-length-returns-stale-size-for-a-file-still-being-written-on-windows/).

**Not sharing writes makes `FileStream.Length` cached on Windows.** When a handle has no write access and no `FileShare.Write`, nobody else can be writing, so .NET 10 caches the file length after the first query (`_lengthCanBeCached` in `SafeFileHandle.Windows.cs`). Passing `FileShare.ReadWrite` to tail a file turns that cache off, which is exactly what you want.

**Do not request more access than you need.** `FileAccess.ReadWrite` on a reader looks harmless, but it makes your open fail against every existing handle whose share mode lacks `Write`, and it forces every later opener to allow writes too. Ask for `Read` when you only read.

**Retrying does not fix a share-mode mismatch.** If your share mode is incompatible with a long-lived handle, the open fails until that handle closes, which for a logger is never. Retry loops are for short-lived holders like antivirus scanners, indexers, and the build tools behind [MSB3027 "could not copy, exceeded retry count"](/2026/05/fix-msbuild-msb3027-could-not-copy-exceeded-retry-count/). Fix the share mode first, then decide whether you also need a retry.

**`FileShare.None` is the only portable lock.** If you need mutual exclusion between .NET processes on all platforms, `FileShare.None` is the one value that is enforced on Windows and (advisory, .NET-to-.NET) on Unix. Anything finer, such as "readers may coexist but writers may not", only holds on Windows.

## Choosing a share mode

- Reading a file someone else may be writing: `FileAccess.Read, FileShare.ReadWrite | FileShare.Delete`.
- Writing a file others may read while you write: `FileAccess.Write, FileShare.Read` (the `StreamWriter` default). Add `FileShare.Delete` if something else rotates or replaces the file.
- Several writers appending to one file: every writer uses `FileShare.ReadWrite`, and you still need your own record-level coordination, because sharing allows concurrent writes without ordering them.
- Exclusive ownership, for example while you rewrite a config file: `FileShare.None`, and on Unix accept that only .NET and `flock`-aware processes will respect it.

For large sequential reads where none of this applies, the defaults are fine, as in [reading a large CSV without running out of memory](/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/).

## Related reading

- [How to tail a log file in C# while another process is still writing to it](/2026/10/how-to-tail-a-log-file-in-csharp-while-another-process-is-writing-to-it/) puts `FileShare.ReadWrite | FileShare.Delete` to work in a rotation-safe reader.
- [How to detect when a file finishes being written to in .NET](/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/) uses a `FileShare.None` open as a "writer is done" probe.
- [Fix: FileInfo.Length returns a stale size on Windows](/2026/10/fix-fileinfo-length-returns-stale-size-for-a-file-still-being-written-on-windows/) explains the attribute-cache side of the same scenario.
- [Fix MSB3027 could not copy, exceeded retry count](/2026/05/fix-msbuild-msb3027-could-not-copy-exceeded-retry-count/) is a sharing violation seen from the build side.

## Sources

- [`FileShare` enum on Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.fileshare).
- [`CreateFileW` on Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew): `dwShareMode`, `FILE_SHARE_DELETE`, and `ERROR_SHARING_VIOLATION`.
- [Creating and Opening Files on Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/fileio/creating-and-opening-files): the table of valid access and share combinations.
- [`SafeFileHandle.Windows.cs` at v10.0.0](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Private.CoreLib/src/Microsoft/Win32/SafeHandles/SafeFileHandle.Windows.cs): access mapping, `Inheritable` handling, and the length cache.
- [`SafeFileHandle.Unix.cs` at v10.0.0](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Private.CoreLib/src/Microsoft/Win32/SafeHandles/SafeFileHandle.Unix.cs): the `flock` emulation, `DisableFileLocking`, network file system exceptions, and deferred truncation.
- [`File.cs` at v10.0.0](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Private.CoreLib/src/System/IO/File.cs): the share modes used by every `File.*` helper.
- [dotnet/runtime issue 48757](https://github.com/dotnet/runtime/issues/48757): file locking on NFS and `DOTNET_SYSTEM_IO_DISABLEFILELOCKING`.
