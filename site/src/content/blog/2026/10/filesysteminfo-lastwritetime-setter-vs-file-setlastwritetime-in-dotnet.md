---
title: "FileSystemInfo.LastWriteTime setter vs File.SetLastWriteTime in .NET"
description: "Both end in the same OS call, so the timestamp written is identical. The differences are around it: which cache gets invalidated, whether directories work on Windows, how a non-UTC DateTime is converted, and whether you can target an open handle. Use File.SetLastWriteTimeUtc, by handle when the file is open. Verified on .NET 10.0.10."
pubDate: 2026-10-30
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "dotnet-10"
  - "csharp"
  - "filesystem"
  - "io"
---

Use `File.SetLastWriteTimeUtc` (or `Directory.SetLastWriteTimeUtc` for folders), and use the `SafeFileHandle` overload if you are setting the time on a file you are still writing to. Use the `FileInfo.LastWriteTimeUtc` setter only when you already hold that `FileInfo` and will read its properties again afterwards, because the setter is the only API that also refreshes that instance's cache. Both paths call the exact same internal `FileSystem.SetLastWriteTime`, so the bits that reach the disk are identical. What differs is everything around that call. In either case, pass a `DateTime` with `Kind = Utc` to the `...Utc` member, never a local or unspecified time to the non-UTC one.

Everything below was run on .NET 10.0.10 (SDK 10.0.302, C# 14) on macOS 27 with APFS, in a machine whose local time zone is `Europe/Bucharest` (UTC+2 on the test date). The Windows behaviour is quoted from the `release/10.0` branch of dotnet/runtime. The code involved has barely moved since .NET 7, when the handle overloads were added, so the same rules apply to .NET 8, 9, and the .NET 11 previews.

## The comparison at a glance

| | `fileInfo.LastWriteTimeUtc = t` | `File.SetLastWriteTimeUtc(path, t)` |
| --- | --- | --- |
| OS call (Windows) | `SetFileInformationByHandle(FileBasicInfo)` | same |
| OS call (Unix) | `utimensat(..., AT_SYMLINK_NOFOLLOW)` | same |
| Invalidates the cache of | that `FileInfo` instance only | nothing (no cache involved) |
| Other `FileInfo` objects for the same path | stale until `Refresh()` | stale until `Refresh()` |
| Directory as target on Windows | only via `DirectoryInfo` | fails, use `Directory.SetLastWriteTimeUtc` |
| Accepts an open `SafeFileHandle` | no | yes, since .NET 7 |
| `DateTime.MinValue` with a local-time setter, UTC+ zone | silently clamps | throws `ArgumentOutOfRangeException` |
| Missing file | `FileNotFoundException` | `FileNotFoundException` |
| Per-call cost (10k calls, APFS, M4) | 10.4 us | 10.7 us (by handle: 8.6 us) |

## What the two APIs actually do

Strip away the public surface and both meet in one place. Here is the `FileSystemInfo` side, from `FileSystemInfo.cs` and `FileSystemInfo.Windows.cs`:

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

And the `File` side:

```csharp
// dotnet/runtime release/10.0, File.cs
public static void SetLastWriteTime(string path, DateTime lastWriteTime)
    => FileSystem.SetLastWriteTime(Path.GetFullPath(path), lastWriteTime, false);

public static void SetLastWriteTimeUtc(string path, DateTime lastWriteTimeUtc)
    => FileSystem.SetLastWriteTime(Path.GetFullPath(path), GetUtcDateTimeOffset(lastWriteTimeUtc), false);
```

That trailing `false` is the `asDirectory` flag, and it matters on Windows (more below). On Unix, the `FileInfo` setter goes through its own `FileStatus` struct while `File` uses a throwaway `default(FileStatus)`, but both call the same `SetAccessOrWriteTimeCore`. That method first re-stats the file so it can write back the current access time unchanged, then calls `utimensat` with `AT_SYMLINK_NOFOLLOW`, then invalidates the status cache. On Windows both open the path with `FILE_WRITE_ATTRIBUTES` and call `SetFileInformationByHandle` with a `FILE_BASIC_INFO` where every field except `LastWriteTime` is zero, which Windows interprets as "leave unchanged".

So there is no "the `FileInfo` setter is lazy" or "it only changes the in-memory object" behaviour, which is a common assumption. The setter hits the disk immediately, just like the static method.

## Cache invalidation: the difference you will actually hit

`FileSystemInfo` caches everything it reads. The first property access stats the file, and later accesses return the snapshot until something calls `Refresh()`. The setter invalidates the cache of the instance you called it on, and nothing else. This probe makes all three cases visible:

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

This is the one real reason to prefer the setter. If a method receives a `FileInfo`, sets its timestamp, and then the caller logs `fileInfo.LastWriteTime` or compares it with another file, the setter keeps that object honest. Calling `File.SetLastWriteTimeUtc(fileInfo.FullName, t)` in the same spot leaves the caller with a stale value, and that bug only shows up when someone reads the property again. If you take that route, add `fileInfo.Refresh()` after it.

The reverse is just as important: the setter does not reach other `FileInfo` instances, including the ones that came out of `DirectoryInfo.EnumerateFiles`. Those were filled during enumeration and stay frozen. The same snapshot behaviour is what makes `FileInfo.Length` lie about growing files, which I covered in detail in [why FileInfo.Length returns a stale size on Windows](/2026/10/fix-fileinfo-length-returns-stale-size-for-a-file-still-being-written-on-windows/).

## Directories: the Windows-only trap in File.SetLastWriteTime

`File.SetLastWriteTime` always passes `asDirectory: false`. On Windows that flag decides whether `OpenHandleToWriteAttributes` adds `FILE_FLAG_BACKUP_SEMANTICS` to the `CreateFile` call:

```csharp
// dotnet/runtime release/10.0, FileSystem.Windows.cs
int dwFlagsAndAttributes = Interop.Kernel32.FileOperations.FILE_FLAG_OPEN_REPARSE_POINT;
if (asDirectory)
{
    dwFlagsAndAttributes |= Interop.Kernel32.FileOperations.FILE_FLAG_BACKUP_SEMANTICS;
}
```

The [`CreateFile` documentation](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew) is explicit that you must set `FILE_FLAG_BACKUP_SEMANTICS` to obtain a handle to a directory, so `File.SetLastWriteTimeUtc(@"C:\data\folder", t)` fails with an access-denied error on Windows. `DirectoryInfo.LastWriteTimeUtc = t` passes `this is DirectoryInfo` and works, as does `Directory.SetLastWriteTimeUtc`.

On Linux and macOS the flag only affects which exception type is thrown for a missing path, so the same `File` call on a directory succeeds. My probe confirmed it on APFS. It is exactly the kind of code that passes CI on a Linux runner and then fails on a developer's Windows laptop. If your code can receive either a file or a folder, branch on `Directory.Exists` and call the matching static class, or construct the right `FileSystemInfo` subtype.

A related oddity: `new FileInfo(directoryPath).Exists` is `false`, yet on Unix `new FileInfo(directoryPath).LastWriteTimeUtc = t` succeeds and stamps the directory. Do not lean on it.

## Local vs UTC: where the two paths diverge on edge values

The non-UTC members are where the two APIs stop being symmetric. `File.SetLastWriteTime(string, DateTime)` passes the `DateTime` straight into a `DateTimeOffset` parameter, so the implicit `DateTime` to `DateTimeOffset` conversion runs. The `FileInfo.LastWriteTime` setter calls `value.ToUniversalTime()` instead. For normal dates they agree, and both treat `DateTimeKind.Unspecified` as local time:

```text
File.SetLastWriteTime(Unspecified 12:00)    -> 09:00Z   (treated as local, UTC+3 in June)
File.SetLastWriteTimeUtc(Unspecified 12:00) -> 12:00Z   (treated as UTC)
File.SetLastWriteTime(Utc-kind 03:04:05Z)   -> 03:04:05Z (Kind honoured)
fi.LastWriteTime = Unspecified 12:00        -> 09:00Z
fi.LastWriteTimeUtc = Local-kind 12:00      -> 09:00Z   (Local converted, not reinterpreted)
```

The edges are different. In any time zone east of UTC, `DateTime.MinValue` has no valid UTC equivalent. `ToUniversalTime()` clamps quietly to `DateTime.MinValue`, while the implicit `DateTimeOffset` conversion refuses:

```csharp
// .NET 10.0.10, Europe/Bucharest (UTC+2)
File.SetLastWriteTime(path, DateTime.MinValue);
// ArgumentOutOfRangeException: The UTC time represented when the offset is applied
// must be between year 0 and 10,000. (Parameter 'offset')

new FileInfo(path).LastWriteTime = DateTime.MinValue; // no exception here
```

West of UTC, `DateTime.MaxValue` throws in the same way. You would not use those values on purpose, but "reset to default" code paths and uninitialized fields put them there more often than you would expect.

Getting past the conversion does not mean the value is storable. Windows `FILETIME` starts in 1601, and `DateTimeOffset.ToFileTime()` throws `ArgumentOutOfRangeException: Not a valid Win32 FileTime.` for anything earlier, so on Windows both APIs throw for `DateTime.MinValue`. APFS stores a signed 64-bit count of nanoseconds since 1970, so on macOS the "successful" `DateTime.MinValue` write lands at `1677-09-21T00:12:43.1452241Z`, the earliest instant APFS can represent. Neither is what you meant. Validate the range yourself before you call either API.

Daylight saving time is the other reason to stay on the `...Utc` members. A local wall-clock time during the autumn fall-back hour is ambiguous, and `ToUniversalTime()` picks the standard-time interpretation without telling you. If the timestamp came from another machine, a database, or an archive entry, it was almost certainly UTC to begin with. Keep it that way all the way to the disk. The same advice applies to [`DateTime` values in JSON payloads](/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/).

## The handle overload, and why open files undo your timestamp

Only the static class has `File.SetLastWriteTime(SafeFileHandle, DateTime)` and `File.SetLastWriteTimeUtc(SafeFileHandle, DateTime)`, added in .NET 7. They call `SetFileInformationByHandle` or `futimens` on the handle you already hold, which skips the path lookup and the extra open.

The more important reason to use them is ordering. Setting the timestamp while your own `FileStream` still holds buffered bytes is a classic bug, because the OS bumps the modification time again when those bytes are flushed on `Dispose`:

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

The rule is "last write wins": the timestamp must be the final thing that touches the file. Flush, then set by handle, then close. Setting it after the `using` block by path also works, but costs a second open and leaves a window in which another process can see the file with the wrong time. That matters if a consumer is [watching for the file to finish being written](/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/) or polls timestamps, as the [snapshot-diff approach to network shares](/2026/10/filesystemwatcher-vs-polling-for-detecting-file-changes-on-a-network-share-in-dotnet/) does.

`FileSystemInfo` has no handle-based equivalent, so if you need this pattern, you are on `File` regardless of preference.

## Symlinks, creation time, and precision

Three things are the same on both paths, but people often get them wrong:

- **Symlinks**: Windows opens with `FILE_FLAG_OPEN_REPARSE_POINT` and Unix calls `utimensat` with `AT_SYMLINK_NOFOLLOW`, so both APIs stamp the link itself and leave the target alone. If you want the target, resolve it first with `FileSystemInfo.ResolveLinkTarget(returnFinalTarget: true)` and set the time on the result.
- **Creation time on macOS**: setting a modification time earlier than the birth time makes the kernel pull the birth time back to match. .NET detects this on macOS and restores the original creation time with `setattrlist`, so `File.GetCreationTimeUtc` is unchanged after you backdate `LastWriteTime`. On Linux there is no settable birth time, and .NET reports the older of `ctime` and `mtime` as the creation time.
- **Precision**: `DateTime` has 100 ns ticks. NTFS, APFS, and ext4 keep all of them (my round-trip of `...07.1234567Z` came back exactly), FAT32 rounds to 2 seconds, and exFAT keeps 10 ms. If you compare timestamps across volumes, for example in a backup or sync tool, compare with a tolerance instead of `==`.

Both APIs throw `FileNotFoundException` for a missing file. This is asymmetric with the getters, which return `1601-01-01T00:00:00Z` instead of throwing. Code that reads the time, decides, then writes can therefore see a file vanish between the two calls and get an exception from a method that looked harmless. If the file may be deleted concurrently, catch `FileNotFoundException` around the write.

## The benchmark that does not matter

For completeness: 10,000 calls each on a warm APFS volume (Apple M4, .NET 10.0.10, Release, `Stopwatch` around a loop) cost 10.72 us per call for `File.SetLastWriteTimeUtc(path, t)`, 10.40 us for the `FileInfo` setter, and 8.60 us for the handle overload on an already-open handle. The path variants are equal within noise, because each one does a stat, a `utimensat`, and on the `FileInfo` side a cache reset. The handle saves the path resolution. None of this should drive your choice. If you are stamping thousands of files, the stat inside each set call dominates, and parallelizing over files will help far more than switching API.

## The recommendation, restated

Default to `File.SetLastWriteTimeUtc(path, utc)` and `Directory.SetLastWriteTimeUtc(path, utc)`. They are explicit about what kind of entry you are targeting, cannot leave a cached object behind, and have a handle overload for the "set it on the file I just wrote" case, which is where most timestamp bugs come from. Switch to `fileInfo.LastWriteTimeUtc = utc` when the `FileInfo` is the unit of work in your code and someone will read its properties again, because the setter is the only API that keeps that instance in sync. Avoid the non-UTC members of both, and validate that the value fits in the target file system's range before you write it.

## Related reading

- [Why FileInfo.Length returns a stale size on Windows](/2026/10/fix-fileinfo-length-returns-stale-size-for-a-file-still-being-written-on-windows/) digs into the same `FileSystemInfo` caching from the size angle.
- [How to detect when a file finishes being written to in .NET](/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/) covers the consumer side of "last write wins".
- [FileSystemWatcher vs polling on a network share](/2026/10/filesystemwatcher-vs-polling-for-detecting-file-changes-on-a-network-share-in-dotnet/) relies on timestamps that you just learned to set correctly.
- [How to tail a log file while another process writes to it](/2026/10/how-to-tail-a-log-file-in-csharp-while-another-process-is-writing-to-it/) shows the `FileShare` flags used in the probes above.
- [How to run a file-based C# app with dotnet run](/2026/08/how-to-run-a-file-based-csharp-app-with-dotnet-run-in-dotnet-11/) if you want to rerun `probe.cs` yourself.

## Sources

- [`FileSystemInfo.LastWriteTime`](https://learn.microsoft.com/en-us/dotnet/api/system.io.filesysteminfo.lastwritetime) and [`File.SetLastWriteTimeUtc`](https://learn.microsoft.com/en-us/dotnet/api/system.io.file.setlastwritetimeutc) (Microsoft Learn)
- [`FileSystemInfo.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/IO/FileSystemInfo.cs), [`FileSystemInfo.Windows.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/IO/FileSystemInfo.Windows.cs), [`File.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/IO/File.cs) (dotnet/runtime)
- [`FileSystem.Windows.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/IO/FileSystem.Windows.cs), [`FileStatus.Unix.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/IO/FileStatus.Unix.cs), [`pal_time.c`](https://github.com/dotnet/runtime/blob/release/10.0/src/native/libs/System.Native/pal_time.c) (dotnet/runtime)
- [`CreateFileW`, `FILE_FLAG_BACKUP_SEMANTICS`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew) and [`FILE_BASIC_INFO`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_basic_info) (Microsoft Learn)
- [`utimensat(2)`](https://man7.org/linux/man-pages/man2/utimensat.2.html) (Linux man pages)
- [File times, resolution per file system](https://learn.microsoft.com/en-us/windows/win32/sysinfo/file-times) (Microsoft Learn)
