---
title: "FileSystemWatcher vs polling for detecting file changes on a network share in .NET"
description: "On an SMB or NFS share, polling is the source of truth and FileSystemWatcher is at best a hint. FileSystemWatcher misses remote changes on Linux and macOS, overflows its 64 KB network buffer, and stops for good when the connection drops. Use a periodic snapshot diff, and let the watcher only trigger an early scan. Verified on .NET 10.0.10."
pubDate: 2026-10-14
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "csharp"
  - "filesystem"
  - "io"
---

If the folder you watch lives on a network share, polling wins. Make a periodic directory snapshot and diff it against the previous one: that is the only mechanism that sees every change on every OS, survives disconnects, and can be reasoned about. `FileSystemWatcher` is still useful on Windows clients talking to SMB, but only as a hint that triggers the next scan early. Never let it be the only path by which you learn that a file arrived.

Everything below applies to `System.IO.FileSystemWatcher` and `Microsoft.Extensions.FileProviders.Physical` as they ship in .NET 10 (I ran the code on .NET 10.0.10, SDK 10.0.302, C# 14) and in the .NET 11 release candidates. The relevant source has not changed in a meaningful way since .NET Core 3.1, so the advice holds for .NET 8 and 9 too.

## The comparison at a glance

| | `FileSystemWatcher` on a share | Polling a snapshot |
| --- | --- | --- |
| Windows client, SMB 2/3 share | Works, via `ReadDirectoryChangesW` forwarded to the server | Works |
| Linux client, CIFS or NFS mount | Sees only changes made by the local machine | Works |
| macOS client, SMB or NFS mount | Sees only local changes in practice | Works |
| Latency | Sub-second when it works | Your poll interval, plus client metadata caching (up to 10 s on Windows SMB, up to 60 s on NFS) |
| Burst of changes | Buffer capped at 64 KB on network paths, overflow drops all detail | Unaffected, the next diff sees the end state |
| Connection drop | `Error` event, then `EnableRaisingEvents` flips to `false` and it stays off | The scan fails, you retry next tick |
| Changes made while you were offline | Lost | Seen on the first successful scan |
| Cost when nothing changes | Near zero | One directory listing per interval |
| Can tell you *what* changed | Yes, per event | Yes, by diffing snapshots |

Every row in the "watcher" column has an asterisk, and every row in the "polling" column does not. That asymmetry is the whole argument.

## Why FileSystemWatcher is fragile on a network share

`FileSystemWatcher` is a thin wrapper over whatever the OS gives it: `ReadDirectoryChangesW` on Windows, `inotify` on Linux, FSEvents on macOS. Each of those was designed around a local file system, where the kernel sees every write because every write goes through it. A network share breaks that assumption.

**On Linux and macOS, remote writes are invisible.** `inotify` fires when the local kernel performs an operation on the file. When another machine writes to the same NFS export or SMB share, your kernel never handles that write, so no event is generated. You get events for your own process's writes and nothing for anyone else's. Linux kernel developer J. Bruce Fields put it plainly in [an LWN discussion](https://lwn.net/Articles/757833/): client-side notification would need a "very chatty" protocol to learn about changes made by other clients, and NFS does not have one. The same holds for CIFS mounts. If your consumer runs in a Linux container and the producer is a Windows box dropping files on a share, a `FileSystemWatcher` will sit there silently forever.

**On Windows, the 64 KB ceiling bites.** A Windows client against an SMB 2 or SMB 3 server does get real remote notifications: the redirector sends a `CHANGE_NOTIFY` request to the server and the server answers when something changes. But the [`ReadDirectoryChangesW` documentation](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-readdirectorychangesw) states that the call "fails with ERROR_INVALID_PARAMETER when the buffer length is greater than 64 KB and the application is monitoring a directory over the network". The [`FileSystemWatcher` docs](https://learn.microsoft.com/en-us/dotnet/api/system.io.filesystemwatcher) repeat the limit. The default `InternalBufferSize` is 8 KB, each `FILE_NOTIFY_INFORMATION` record is 12 bytes plus the UTF-16 file name, so with 40-character names you fit roughly 90 events into 8 KB and roughly 700 into 64 KB. A batch job that drops 2,000 files in a second will overflow either one.

When the buffer overflows, the OS discards the entire batch. `ReadDirectoryChangesW` returns success with zero bytes, and the runtime turns that into an `Error` event carrying an `InternalBufferOverflowException` ("Too many changes at once in directory"). You know you missed something, but not what.

**On Windows, a dropped connection disables the watcher.** This is the one that causes the 3 a.m. incident. Here is the relevant part of `ReadDirectoryChangesCallback` in [`FileSystemWatcher.Windows.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.IO.FileSystem.Watcher/src/System/IO/FileSystemWatcher.Windows.cs):

```csharp
// dotnet/runtime main, System.IO.FileSystem.Watcher (unchanged since .NET Core 3.x)
if (errorCode != 0)
{
    const int ERROR_OPERATION_ABORTED = 995;
    if (errorCode != ERROR_OPERATION_ABORTED)
    {
        EnableRaisingEvents = false;
        OnError(new ErrorEventArgs(new Win32Exception((int)errorCode)));
    }
    return;
}
```

When the file server reboots, the VPN blips, or the SMB session times out, the pending read completes with an error such as `ERROR_NETNAME_DELETED` (64, "The specified network name is no longer available"). The watcher raises `Error` once, sets `EnableRaisingEvents = false`, and never comes back on its own. If nobody subscribed to `Error`, the process keeps running, looks healthy, and processes nothing. Note also that an initial failure, such as a buffer above 64 KB on a UNC path, surfaces the same way: as an `Error` event, not as an exception from the `EnableRaisingEvents = true` setter.

## The minimal repro of the silent failure

This is the code that shows up in most "my watcher stopped working" questions:

```csharp
// .NET 10, C# 14 -- the naive version. Do not ship this against a share.
using var watcher = new FileSystemWatcher(@"\\fileserver\drop", "*.csv");
watcher.Created += (_, e) => Process(e.FullPath);
watcher.EnableRaisingEvents = true;

Console.ReadLine();

static void Process(string path) => Console.WriteLine($"Got {path}");
```

Run it on Windows, drop a file on the share, and it works. Restart the file server, or pull the network cable for a minute, and it stops printing forever, with no exception and no log line. Run the same code in a Linux container with `/mnt/drop` mounted over CIFS and it never prints at all, unless the file is created from inside the same container.

## Polling, done properly

Polling has a bad reputation because people implement it badly: they list the directory, open every file, and compare contents. A good poll is a single directory listing that captures name, size and last-write time for every entry, compared with the previous listing.

The cheapest way to get that in .NET is `FileSystemEnumerable<T>` from `System.IO.Enumeration`. It lets you project each `FileSystemEntry` straight into the tuple you need, without allocating a `FileInfo` per file. On Windows, `Length` and `LastWriteTimeUtc` come from the directory enumeration data itself (`FindFirstFileEx` and friends), so over SMB the whole listing is a handful of `QUERY_DIRECTORY` exchanges rather than one round trip per file. On Linux and macOS, `readdir` only returns names, so each entry costs an extra `stat`, which a CIFS or NFS client usually serves from its attribute cache.

To get a feel for the CPU floor of a scan, I timed the `TakeSnapshot` method from the full implementation below against local APFS directories on an Apple M4 (macOS 26.6, .NET 10.0.10, Release build, average of 20 runs after 3 warm-ups):

| Files in directory | Time per scan | Allocated per scan |
| --- | --- | --- |
| 1,000 | 1.8 ms | 0.29 MB |
| 10,000 | 20.5 ms | 2.83 MB |
| 50,000 | 93.1 ms | 13.39 MB |

Over a network those numbers grow with latency and listing size, but the shape stays the same: one listing per interval. Polling a drop folder with a few thousand files every 5 to 30 seconds is not a load anyone will notice. Polling 500,000 files every second is, and the answer there is to partition the folder (one subfolder per day or per producer), not to switch to a watcher.

## The hybrid: polling as truth, watcher as a hint

The design that holds up in production combines the two:

1. Keep a snapshot (`path -> (length, lastWriteUtc)`) in memory.
2. Rescan on a fixed interval and diff against the snapshot. This is the only code path that emits `Created`, `Changed` and `Deleted`.
3. If a `FileSystemWatcher` can be started, let any of its events wake the scan loop early. On a Windows client talking to SMB this gives you sub-second latency in the common case.
4. On any watcher `Error` (overflow or disconnect), throw the watcher away, force a rescan, and try to recreate it on the next pass.
5. If the scan itself fails because the share is unreachable, keep the old snapshot and try again next tick. An outage is not the same thing as "every file was deleted".

Here is the full implementation. It runs as-is on .NET 10 and .NET 11:

```csharp
// .NET 10 / .NET 11, C# 14
using System.IO.Enumeration;

public enum ShareChangeKind { Created, Changed, Deleted }

public readonly record struct ShareChange(ShareChangeKind Kind, string Path);

public readonly record struct FileStamp(long Length, DateTime LastWriteUtc);

public sealed class ShareWatcher : IAsyncDisposable
{
    private readonly string _root;
    private readonly TimeSpan _reconcileInterval;
    private readonly Action<ShareChange> _onChange;
    private readonly SemaphoreSlim _wake = new(0, 1);
    private readonly CancellationTokenSource _cts = new();
    private Dictionary<string, FileStamp> _snapshot = new(StringComparer.OrdinalIgnoreCase); // SMB is case-insensitive
    private volatile FileSystemWatcher? _watcher; // swapped from the Error callback
    private Task? _loop;

    public ShareWatcher(string root, TimeSpan reconcileInterval, Action<ShareChange> onChange)
    {
        _root = root;
        _reconcileInterval = reconcileInterval;
        _onChange = onChange;
    }

    public void Start()
    {
        // Baseline: whatever exists now is not a change.
        _snapshot = TakeSnapshot(_root) ?? _snapshot;
        TryStartWatcher();
        _loop = Task.Run(() => LoopAsync(_cts.Token));
    }

    private async Task LoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            // Wake on the reconcile timer OR early when the watcher hints at a change.
            try { await _wake.WaitAsync(_reconcileInterval, ct); }
            catch (OperationCanceledException) { return; }

            // Small settle delay so a burst of hints becomes one scan.
            try { await Task.Delay(250, ct); }
            catch (OperationCanceledException) { return; }

            Reconcile();

            if (_watcher is null) TryStartWatcher();
        }
    }

    private void Reconcile()
    {
        var current = TakeSnapshot(_root);
        if (current is null)
        {
            // Share unreachable. Keep the old snapshot: an outage is not "every file was deleted".
            return;
        }

        foreach (var (path, stamp) in current)
        {
            if (!_snapshot.TryGetValue(path, out var old))
                _onChange(new(ShareChangeKind.Created, path));
            else if (old != stamp)
                _onChange(new(ShareChangeKind.Changed, path));
        }

        foreach (var path in _snapshot.Keys)
        {
            if (!current.ContainsKey(path))
                _onChange(new(ShareChangeKind.Deleted, path));
        }

        _snapshot = current;
    }

    private static Dictionary<string, FileStamp>? TakeSnapshot(string root)
    {
        var options = new EnumerationOptions
        {
            RecurseSubdirectories = false,
            IgnoreInaccessible = true,
            AttributesToSkip = FileAttributes.Hidden | FileAttributes.System,
        };

        try
        {
            // Length and LastWriteTimeUtc come from the directory listing itself on Windows,
            // so this is one QUERY_DIRECTORY exchange per batch, not one round trip per file.
            // The constructor opens the directory, so it must sit inside the try.
            var entries = new FileSystemEnumerable<KeyValuePair<string, FileStamp>>(
                root,
                (ref FileSystemEntry e) => new(
                    e.ToFullPath(),
                    new FileStamp(e.Length, e.LastWriteTimeUtc.UtcDateTime)),
                options)
            {
                ShouldIncludePredicate = (ref FileSystemEntry e) => !e.IsDirectory,
            };

            var result = new Dictionary<string, FileStamp>(StringComparer.OrdinalIgnoreCase);
            foreach (var (path, stamp) in entries) result[path] = stamp;
            return result;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    private void TryStartWatcher()
    {
        try
        {
            var w = new FileSystemWatcher(_root)
            {
                NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size,
                IncludeSubdirectories = false,
                InternalBufferSize = 64 * 1024, // hard ceiling for network paths
            };
            w.Created += (_, _) => Hint();
            w.Changed += (_, _) => Hint();
            w.Deleted += (_, _) => Hint();
            w.Renamed += (_, _) => Hint();
            w.Error += (_, e) => OnWatcherError(w, e.GetException());
            w.EnableRaisingEvents = true;
            _watcher = w;
        }
        catch (Exception ex) when (ex is IOException or ArgumentException or UnauthorizedAccessException)
        {
            // Share offline or path gone. Polling keeps running; we retry on the next pass.
            _watcher = null;
        }
    }

    private void OnWatcherError(FileSystemWatcher w, Exception ex)
    {
        // Overflow or a dropped connection: either way, events were lost.
        // Throw the watcher away, force a full rescan, and rebuild on the next pass.
        if (ReferenceEquals(_watcher, w)) _watcher = null;
        w.Dispose();
        Hint();
    }

    private void Hint()
    {
        try { _wake.Release(); }
        catch (SemaphoreFullException) { /* a scan is already pending */ }
    }

    public async ValueTask DisposeAsync()
    {
        _cts.Cancel();
        if (_loop is not null) await _loop;
        _watcher?.Dispose();
        _cts.Dispose();
        _wake.Dispose();
    }
}
```

Using it from a worker or a console app:

```csharp
// .NET 10 / .NET 11, C# 14
await using var watcher = new ShareWatcher(
    @"\\fileserver\drop",
    reconcileInterval: TimeSpan.FromSeconds(15),
    onChange: c => Console.WriteLine($"{c.Kind}: {c.Path}"));

watcher.Start();
await Task.Delay(Timeout.Infinite);
```

I tested this on a local directory with a 3 second reconcile interval: a created file, an append, and a delete were each reported about 265 ms after the operation (the watcher hint plus the 250 ms settle delay). While the directory was moved away for 4 seconds to simulate an outage, nothing was reported, and the file created after it came back was reported on the next pass. Nothing was misreported as deleted.

A few design choices worth calling out:

- **`SemaphoreSlim(0, 1)` as a wake-up signal** coalesces any number of hints into a single pending scan. The `SemaphoreFullException` catch is the coalescing, not an error path.
- **The 250 ms settle delay** turns a burst of hints (a 2,000-file batch) into one scan instead of 2,000.
- **`_onChange` runs on the scan loop**, one call at a time. If processing is slow, push the change into a `Channel<ShareChange>` and let a separate consumer handle it, so a slow handler does not delay the next scan.
- **Hidden and system files are skipped**, which drops `Thumbs.db`, `desktop.ini` and the `.DS_Store` files macOS clients leave behind.

## Gotchas that polling does not fix for you

**Client metadata caches add latency you did not configure.** The Windows SMB client caches directory listings and file metadata. Per the [file server tuning guide](https://learn.microsoft.com/en-us/windows-server/administration/performance-tuning/role/file-server/), `DirectoryCacheLifetime` and `FileInfoCacheLifetime` default to 10 seconds and `FileNotFoundCacheLifetime` to 5 seconds (all under `HKLM\System\CurrentControlSet\Services\LanmanWorkstation\Parameters`), with directory leases on SMB 3 changing the picture further. On Linux, `mount.cifs` caches attributes for 1 second by default (`actimeo`), and an NFS client by default caches directory attributes for 30 to 60 seconds (`acdirmin`/`acdirmax`, see [`nfs(5)`](https://man7.org/linux/man-pages/man5/nfs.5.html)). Your effective latency is your poll interval plus the cache lifetime. If you need faster than that, tune the mount options, not the poll interval.

**"New file" does not mean "finished file".** Both mechanisms tell you a file appeared, not that the writer is done with it. A 2 GB file copied over the network shows up in the listing the moment the copy starts. I covered the options in detail in [how to detect when a file finishes being written to](/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/): the most robust one is having the producer write to a temporary name and rename at the end. With the hybrid above you can also simply treat a file as ready only after its stamp has been unchanged across two scans.

**Timestamp-preserving copies look unchanged.** `robocopy` with its default `/COPY:DAT`, `cp -p`, and `rsync -t` all preserve the source's last-write time. If a file is replaced by one of the same size, the `(Length, LastWriteUtc)` stamp does not change. If that matters, add the creation time on Windows or a content hash for small files, or ask the producer to write a new name for every version.

**Clock skew between client and server.** The last-write time you read is the server's timestamp. Compare stamps only with other stamps from the same share, never with `DateTime.UtcNow` on your machine. "Modified in the last 5 minutes" logic breaks quietly when the file server's clock is off.

**Case sensitivity.** The snapshot dictionary uses `StringComparer.OrdinalIgnoreCase` because SMB shares are case-insensitive. On an NFS export with a case-sensitive file system, switch to `StringComparer.Ordinal`, or two files differing only by case will collapse into one entry.

**Container bind mounts on Docker Desktop.** The same rule applies to a host folder bind-mounted into a Linux container on Windows or macOS: change notifications from the host are unreliable, so polling is the only safe default there too.

## Configuration reload on a share: DOTNET_USE_POLLING_FILE_WATCHER

If the "file change" you care about is `appsettings.json` with `reloadOnChange: true`, or any other consumer of `PhysicalFileProvider`, you do not need the code above. `PhysicalFileProvider` reads the `DOTNET_USE_POLLING_FILE_WATCHER` environment variable in its constructor:

```bash
# .NET 8, 9, 10, 11: switches PhysicalFileProvider to polling
export DOTNET_USE_POLLING_FILE_WATCHER=1
```

With `1` or `true`, it sets both `UsePollingFileWatcher` and `UseActivePolling`, does not create a `FileSystemWatcher` at all, and checks each watched file's `LastWriteTimeUtc` on a timer. The interval is `PhysicalFilesWatcher.DefaultPollingInterval`, hard-coded to 4 seconds. You can also opt in per provider in code:

```csharp
// .NET 10 / .NET 11, C# 14
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;

var builder = Host.CreateApplicationBuilder(args);

var provider = new PhysicalFileProvider(@"\\fileserver\config")
{
    UsePollingFileWatcher = true,
    UseActivePolling = true,
};

builder.Configuration.AddJsonFile(provider, "appsettings.shared.json",
    optional: false, reloadOnChange: true);
```

The same caveats apply: it compares only the last-write time, so a timestamp-preserving copy is invisible to it, and SMB metadata caching can add up to 10 seconds on top of the 4 second interval. The [`IOptionsMonitor` comparison post](/2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11/) covers what happens downstream once the reload fires.

## The recommendation, restated

Use a polling snapshot diff as the single source of truth for any folder on an SMB share, an NFS export, or a bind mount. Pick the interval from your latency budget, then add the client's metadata cache lifetime to it. If you run on Windows and want low latency, add a `FileSystemWatcher` that only wakes the poller early, cap its `InternalBufferSize` at 64 KB, and treat every `Error` event as "rescan and rebuild". The only case where a bare `FileSystemWatcher` is acceptable is a local disk, and even there you should subscribe to `Error`.

## Related reading

- [How to detect when a file finishes being written to in .NET](/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/) covers the "appeared but not finished" half of the problem.
- [How to tail a log file in C# while another process is writing to it](/2026/10/how-to-tail-a-log-file-in-csharp-while-another-process-is-writing-to-it/) uses the same poll-first reasoning for a single growing file.
- [Why FileInfo.Length returns a stale size on Windows](/2026/10/fix-fileinfo-length-returns-stale-size-for-a-file-still-being-written-on-windows/) explains why directory-listing metadata can lag behind the real file.
- [Thread.Sleep vs Task.Delay vs SpinWait](/2026/10/thread-sleep-vs-task-delay-vs-spinwait-for-waiting-in-csharp/) explains why the poll loop awaits instead of sleeping.
- [Channels instead of BlockingCollection](/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) for handing changes from the scan loop to a slow consumer.

## Sources

- [`FileSystemWatcher` class, remarks on buffer size and network paths](https://learn.microsoft.com/en-us/dotnet/api/system.io.filesystemwatcher) (Microsoft Learn)
- [`ReadDirectoryChangesW` function](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-readdirectorychangesw) (Microsoft Learn)
- [`FileSystemWatcher.Windows.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.IO.FileSystem.Watcher/src/System/IO/FileSystemWatcher.Windows.cs) and [`FileSystemWatcher.Linux.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.IO.FileSystem.Watcher/src/System/IO/FileSystemWatcher.Linux.cs) (dotnet/runtime)
- [`PhysicalFileProvider.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.FileProviders.Physical/src/PhysicalFileProvider.cs) and [`PhysicalFilesWatcher.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.FileProviders.Physical/src/PhysicalFilesWatcher.cs) (dotnet/runtime)
- [`FileSystemEnumerable<TResult>`](https://learn.microsoft.com/en-us/dotnet/api/system.io.enumeration.filesystemenumerable-1) (Microsoft Learn)
- [Performance tuning for file servers, SMB client cache settings](https://learn.microsoft.com/en-us/windows-server/administration/performance-tuning/role/file-server/) (Microsoft Learn)
- [`nfs(5)`](https://man7.org/linux/man-pages/man5/nfs.5.html) and [`mount.cifs(8)`](https://man7.org/linux/man-pages/man8/mount.cifs.8.html) man pages
- [J. Bruce Fields on NFS change notification (LWN comment)](https://lwn.net/Articles/757833/)
