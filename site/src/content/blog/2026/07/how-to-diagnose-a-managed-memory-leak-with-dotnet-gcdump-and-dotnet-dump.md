---
title: "How to diagnose a managed memory leak with dotnet-gcdump and dotnet-dump"
description: "A complete workflow for finding a managed memory leak in .NET 11: confirm growth with dotnet-counters, take two gcdumps and diff them, then collect a dump and use dumpheap, gcroot, and objsize in dotnet-dump analyze to find what is still holding the reference."
pubDate: 2026-07-27
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "diagnostics"
  - "memory"
  - "performance"
---

To diagnose a managed memory leak in .NET, confirm the growth is real with `dotnet-counters monitor`, capture two `dotnet-gcdump collect` snapshots a few minutes apart to see which type count is climbing, then take a `dotnet-dump collect` and run `dumpheap -stat`, `dumpheap -type <Name>`, and `gcroot <address>` inside `dotnet-dump analyze` to find the reference chain that is keeping those objects alive. The gcdump tells you *what* is growing with almost no overhead; the dump tells you *who is holding it*. You need both, in that order. This post uses `dotnet-gcdump` and `dotnet-dump` 10.0 against .NET 11 (Preview 6 at the time of writing, GA in November 2026), but every command here has been stable since .NET Core 3.1.

## Why the GC will not save you here

A managed memory leak is not a leak in the C sense. Nothing is unfreed. The garbage collector is working exactly as designed: it will not collect an object that is reachable from a root, and your code has accidentally made a few hundred thousand objects reachable. A root is a static field, a live local or argument on some thread's stack, a strong GC handle, or the finalizer queue. Everything else is reachable transitively from those.

That means the diagnostic question is never "why did the GC not run?" It is "which root chain still points at this object?" Every tool below exists to answer that one question. The classic culprits in an ASP.NET Core app:

- A static or singleton collection that only ever grows: a `ConcurrentDictionary` used as a cache with no eviction, a `List<T>` of "recent requests".
- An event subscription that is never unsubscribed. The publisher holds a delegate, the delegate holds the subscriber, and if the publisher is a singleton or a static, every subscriber lives forever.
- A scoped service captured by a singleton, which drags the whole scope's object graph along with it. This one usually shows up first as [an ObjectDisposedException on a disposed DbContext](/2026/06/fix-objectdisposedexception-cannot-access-a-disposed-context-instance/), because the capture is also [a scoped-from-singleton lifetime bug](/2026/05/fix-cannot-consume-scoped-service-from-singleton/).
- A `Timer` or a long-lived `CancellationTokenSource` registration whose callback closes over a large object graph.

## Step 0: prove there is actually a leak

Do not collect anything until you have watched the managed heap grow over time. Working-set growth alone is not a managed leak; it can be native allocations, fragmentation, or the GC simply not returning memory to the OS because nothing is pressuring it.

Install the tools once and find the PID:

```bash
# Verified with the .NET 11 SDK, July 2026
dotnet tool install --global dotnet-counters
dotnet tool install --global dotnet-gcdump
dotnet tool install --global dotnet-dump

dotnet-counters ps
# 4807  MyApi  /srv/myapi/MyApi
```

Then watch the heap, not the process:

```bash
dotnet-counters monitor --refresh-interval 5 --process-id 4807 \
  --counters System.Runtime[dotnet.gc.last_collection.heap.size,dotnet.process.memory.working_set]
```

On .NET 9 and later, `System.Runtime` is a `Meter` and the counter names are the OpenTelemetry-style ones shown above. On .NET 8 and earlier `dotnet-counters` falls back to the old EventCounters and you want `GC Heap Size (MB)` instead.

The number that matters is `dotnet.gc.last_collection.heap.size` broken down by generation. Two readings tell you what you are dealing with:

- **gen2 climbing monotonically across collections**: a real managed leak. Objects are surviving to the oldest generation and never dying. Continue with this article.
- **gen0/gen1 churning but gen2 flat, working set high**: not a leak. That is allocation pressure or fragmentation. Reach for [dotnet-trace with the gc-verbose profile](/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) to find the allocation hotspot instead.
- **heap size flat but working set climbing**: the leak is native. gcdump and SOS will show you nothing useful. Look at native interop, `SafeHandle` lifetimes, or the LOH being committed but not decommitted.

## A minimal repro that leaks

Here is the smallest ASP.NET Core service that leaks in a way both tools can find. It is a singleton that subscribes to an event on another singleton and never unsubscribes:

```csharp
// .NET 11, C# 14
public sealed class TelemetryBus
{
    public event EventHandler<string>? MetricRecorded;
    public void Record(string metric) => MetricRecorded?.Invoke(this, metric);
}

public sealed class ReportSession
{
    private readonly byte[] _buffer = new byte[64 * 1024];
    private readonly List<string> _log = [];

    public ReportSession(TelemetryBus bus)
    {
        // Nothing ever removes this handler, so `bus` roots every ReportSession
        // ever created, and each one roots 64 KB plus a growing List<string>.
        bus.MetricRecorded += OnMetric;
    }

    private void OnMetric(object? sender, string metric) => _log.Add(metric);
}

app.MapPost("/reports", (TelemetryBus bus) =>
{
    _ = new ReportSession(bus);   // per-request, never released
    return Results.Accepted();
});
```

`TelemetryBus` is a singleton, so its invocation list is rooted for the life of the process. Every `ReportSession` is reachable from that delegate, so every `byte[64*1024]` is too. Hammer `/reports` and the gen2 heap climbs forever.

## The full procedure

1. **Confirm the managed heap is growing** with `dotnet-counters monitor --counters System.Runtime[dotnet.gc.last_collection.heap.size]`, watching gen2 specifically.
2. **Capture a baseline gcdump** with `dotnet-gcdump collect --process-id <PID> --output baseline.gcdump`.
3. **Let the app run under load** for long enough that the leak is unambiguous, typically five to fifteen minutes.
4. **Capture a second gcdump** with `dotnet-gcdump collect --process-id <PID> --output after.gcdump`, then compare the two type counts to find which type is growing.
5. **Collect a full dump** with `dotnet-dump collect --process-id <PID> --type Heap --output leak.dmp` once you know what you are looking for.
6. **Open it** with `dotnet-dump analyze leak.dmp` and confirm the type with `dumpheap -stat` or `dumpheap -type <TypeName> -stat`.
7. **Grab one instance address** from `dumpheap -type <TypeName>` and run `gcroot <address>` to print the reference chain from a root down to that object.
8. **Fix the chain**, not the object. The last hop before your type in the `gcroot` output is the thing holding the reference.

## Steps 2 to 4: gcdump, the cheap first look

`dotnet-gcdump` does not write a process dump. It induces a gen2 collection, turns on GC heap-survival events, and reconstructs the object graph from the [EventPipe](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/eventpipe) stream. The result is a `.gcdump` file containing types, counts, sizes, and edges, but no field values and no thread stacks. It is typically single-digit megabytes where a full dump of the same process is hundreds.

```bash
dotnet-gcdump collect --process-id 4807 --output baseline.gcdump
# Writing gcdump to './baseline.gcdump'...
#     Finished writing 5763432 bytes.

# ... let it run under load ...

dotnet-gcdump collect --process-id 4807 --output after.gcdump
```

You do not need a GUI to compare them. The `report` verb prints a heap-statistics table straight to stdout, which works on Linux where nothing can open a `.gcdump` file:

```bash
dotnet-gcdump report ./after.gcdump
#           Size (Bytes) Count       Type
#         ============== =====       ====
#          1,603,588,000 22,000,000  System.String
#            201,096,000  2,010,000  System.Byte[]
#             25,000,000    250,000  MyApi.Reports.ReportSession
```

Run `report` against both files and diff the counts. On Windows you can also open both `.gcdump` files in Visual Studio at the same time and get a real side-by-side comparison view with a delta column, which is worth the trip if you have a Windows box handy. PerfView reads them too. There is currently no way to open a `.gcdump` on Linux or macOS, so `dotnet-gcdump report` is your only option there.

`report` also accepts `--process-id` directly, which collects and prints in one shot when you do not want the file:

```bash
dotnet-gcdump report --process-id 4807
```

At the end of this step you should have a type name. That is all gcdump owes you.

## Steps 5 to 7: dotnet-dump, where you find the root

A gcdump cannot tell you which *field* on which *object* holds the reference, and it cannot show you thread stacks. For that you need a real dump and SOS.

```bash
dotnet-dump collect --process-id 4807 --type Heap --output leak.dmp
```

`--type` defaults to `Full`, which includes mapped module images and is usually much larger than you need. `Heap` gives you module lists, thread lists, all stacks, exception and handle information, and all memory except mapped images, which covers everything in this workflow. Use `Mini` only for crash triage; it does not carry the GC heap.

Then open the interactive SOS shell:

```bash
dotnet-dump analyze leak.dmp
```

Start with the statistical view. Add `-live` so the GC's mark phase is used to exclude objects that are already garbage but not yet swept, which removes a lot of noise:

```console
> dumpheap -stat -live

Statistics:
              MT    Count    TotalSize Class Name
00007f6c1dc014c0      467       416464 System.Byte[]
00007f6c20a67498   250000     16000000 MyApi.Reports.ReportSession
00007f6c1dc00f90   206770     19494060 System.String
```

Useful variants on the same command:

- `dumpheap -stat -bycount` sorts by instance count rather than total size, which surfaces "a million tiny objects" leaks that byte totals hide.
- `dumpheap -type MyApi.Reports -stat` filters by a substring of the type name, so you can scope the table to one namespace and ignore framework noise.
- `dumpheap -gen loh -stat` restricts to the large object heap. Accepts `gen0`, `gen1`, `gen2`, `loh`, `poh`, and `foh`.
- `dumpheap -min 100000 -stat` ignores anything under 100,000 bytes.

Now get one concrete address and root it:

```console
> dumpheap -type MyApi.Reports.ReportSession
         Address               MT     Size
00007f6ad09421f8 00007f6c20a67498       32
...

> gcroot 00007f6ad09421f8

HandleTable:
    00007F6C98BB15F8 (pinned handle)
    -> 00007F6BDFFFF038 System.Object[]
    -> 00007F69D0033570 MyApi.Telemetry.TelemetryBus
    -> 00007F69D0033588 System.EventHandler`1[[System.String, System.Private.CoreLib]]
    -> 00007F69D00335A0 System.Object[]
    -> 00007F6AD0942258 MyApi.Reports.ReportSession

Found 1 root.
```

Read that chain bottom-up. The leaking object is at the bottom; the root is at the top. The hop immediately above your type is the culprit, and here it is unmistakable: an `EventHandler<string>` multicast delegate whose invocation list (`System.Object[]`) holds every session. That maps directly back to the `bus.MetricRecorded += OnMetric` line with no matching `-=`.

`gcroot` prints only unique roots by default. Pass `-all` when you want every path, and `-nostacks` to restrict the search to handles and reachable objects when stack scanning is producing false positives from stale registers.

Two more commands worth knowing at this point. `objsize <address>` reports the retained size of an object including everything it transitively holds, which is how you turn "this thing is 32 bytes" into "this thing is keeping 68 KB alive". And `dumpobj <address>` prints the field-by-field layout so you can confirm which field on the holder is the one pointing at you:

```console
> dumpobj 00007F69D0033570
Name:        MyApi.Telemetry.TelemetryBus
MethodTable: 00007f6c20a67498
Size:        24(0x18) bytes
Fields:
              MT    Field   Offset                 Type VT     Attr            Value Name
00007f6c1dc00f90  4000001        8 ...EventHandler`1  0 instance 00007F69D0033588 MetricRecorded
```

## Gotchas that cost people an afternoon

**gcdump triggers a full blocking gen2 collection.** That is how it walks the heap. On a process with a large heap this can suspend the runtime for a long time. Do not run it in a tight loop against a latency-sensitive production instance, and expect a visible pause spike in your metrics when you do run it.

**gcdump can silently fail on a huge heap.** The event buffer is owned by the target application and grows up to 256 MB. If the heap is large enough that events get dropped, you get `System.ApplicationException: ETL file shows the start of a heap dump but not its completion`, or a `.gcdump` that quietly contains only part of the heap. When that happens, skip gcdump and go straight to `dotnet-dump collect`.

**Both tools need the same user and the same `TMPDIR`.** On Linux and macOS, `--process-id` and `--name` work by connecting to a Unix domain socket the runtime creates under `TMPDIR`. If your tool runs as a different user, or under a different `TMPDIR`, the command just times out after 30 seconds with no useful error. Run as the same user as the target process or as root.

**In containers you need `ptrace`.** `dotnet-dump collect` requires `ptrace` capabilities, commonly granted with `--cap-add=SYS_PTRACE`. Separately, collecting a heap or full dump forces the OS to page in a lot of virtual memory for the target process, which can push a memory-limited container over its cgroup limit and get it OOM-killed mid-collection. Raise or temporarily remove the limit if your platform allows it.

**`Free` rows are not objects.** A large `Free` count in `dumpheap -stat` means fragmentation, not a leak. Space between live objects that the GC has not compacted away, typically on the LOH. Different problem, different fix (pooling, `ArrayPool<T>`, or `GCSettings.LargeObjectHeapCompactionMode`).

**Cache-shaped leaks may be a configuration bug, not a code bug.** If the growing type is your own DTO sitting inside an `IMemoryCache`, the "leak" is usually a missing size limit or expiration policy rather than a rogue reference. That decision belongs in [the HybridCache vs IMemoryCache vs IDistributedCache comparison](/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/) rather than in a debugger.

**Check the finalizer queue before blaming your code.** `finalizequeue` in the analyze shell lists objects registered for finalization. A backed-up queue means finalizable objects are being promoted to gen2 and held for an extra collection cycle, which looks exactly like a slow leak on a graph. The fix there is almost always to dispose deterministically, which is what [implementing IAsyncDisposable and using await using](/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/) is for.

**Async state machines hide their own roots.** If the growing types are compiler-generated `<SomeMethod>d__12` structs, use `dumpasync -roots` instead of `gcroot`. It understands continuation chains and will show you which awaiting task is holding the machine, which a raw `gcroot` walk presents as an unreadable pile of `Task` and `Action` objects.

## What to do with the answer

Once `gcroot` names the holder, the fix is ordinary code. Unsubscribe in a `Dispose`. Put a size limit and an expiration on the cache. Stop capturing a scoped service in a singleton, and instead [create a scope per unit of work inside the BackgroundService](/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/). Then repeat steps 1 through 4: run under load, take two gcdumps, and confirm the type count is flat. A leak is only fixed when the second gcdump proves it.

Sources: [dotnet-gcdump reference](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/dotnet-gcdump), [dotnet-dump reference](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/dotnet-dump), [Debug a memory leak tutorial](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/debug-memory-leak), [SOS debugging extension](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/sos-debugging-extension), and [dotnet-counters reference](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/dotnet-counters).
