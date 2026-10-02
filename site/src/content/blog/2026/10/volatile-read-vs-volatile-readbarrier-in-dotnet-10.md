---
title: "Volatile.Read vs Volatile.ReadBarrier in .NET 10"
description: "Volatile.Read is an acquire load of one location. Volatile.ReadBarrier, new in .NET 10, is a fence that gives every earlier read acquire semantics. Use Volatile.Read for flags and published references, and ReadBarrier when you need a batch of plain or non-atomic reads to complete before the next memory access, as in a seqlock."
pubDate: 2026-10-02
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "concurrency"
  - "performance"
---

`Volatile.Read(ref x)` reads one location with acquire semantics: nothing later in your code can move above that read. `Volatile.ReadBarrier()`, added in .NET 10, reads nothing at all. It is a fence that gives acquire semantics to **every read before it**, so a whole batch of plain (even non-atomic) reads must finish before any memory access after the barrier. Use `Volatile.Read` for the common case of a flag, a counter, or a published reference. Reach for `ReadBarrier` when you need several ordinary reads, or one read that is too large to be atomic, to complete before a re-check. The textbook case is the reader side of a seqlock.

Everything below was measured on .NET 10.0.10 (SDK 10.0.302), C# 14, on an Apple M4 (arm64). The barrier APIs exist in `System.Threading.Volatile` from .NET 10 onward; on .NET 9 and earlier there is no public equivalent short of `Interlocked.MemoryBarrier()`.

## The comparison at a glance

| | `Volatile.Read(ref x)` | `Volatile.ReadBarrier()` |
| --- | --- | --- |
| Available since | .NET Framework 4.5 | .NET 10 |
| Reads a value | Yes, one location | No |
| What gets acquire semantics | That one read | All reads before the call |
| Blocks later reads and writes from moving up | Yes | Yes |
| Makes the read atomic | Yes, for supported types (including `long`/`double` on 32-bit) | No, atomicity is your problem |
| Works with any `T`, structs, native memory | No, fixed set of overloads | Yes, it orders whatever reads precede it |
| arm64 codegen (measured, .NET 10.0.10) | `ldapur` (load-acquire) | `dmb ishld` (load fence) |
| x64 codegen | plain `mov`, compiler ordering only | no instruction, compiler ordering only |
| Typical use | flags, double-checked init, published references | seqlocks, version-validated caches, batched reads |

## What the two APIs promise

The .NET memory model spec (`docs/design/specs/Memory-model.md` in dotnet/runtime) lists both under "volatile reads have acquire semantics", with one telling footnote on the barrier: it "applies to all prior reads". Acquire means no read or write that comes later in program order may execute ahead of the acquiring read.

With `Volatile.Read(ref _version)`, the acquire is attached to the load of `_version` and nothing else. Reads that happened *before* it in program order are not constrained at all. They may still drift below it.

With `Volatile.ReadBarrier()`, the acquire is attached to every load that precedes the call. The API proposal ([dotnet/runtime#98837](https://github.com/dotnet/runtime/issues/98837)) calls this a `Read-ReadWrite` barrier: all preceding reads must complete before any subsequent memory operation. Its counterpart, `Volatile.WriteBarrier()`, is a `ReadWrite-Write` barrier: all preceding memory operations complete before any subsequent write.

So the two APIs are not two strengths of the same thing. They answer different questions:

- `Volatile.Read`: "read this value, and make sure everything after it sees memory at least as fresh."
- `Volatile.ReadBarrier`: "make sure everything I have already read is done before I touch memory again."

Neither one is a full fence. A `ReadBarrier` does nothing to stop an earlier *write* from being reordered with a later read (the store-load case). If you need that, you still need `Interlocked.MemoryBarrier()` or an `Interlocked` operation.

## What the JIT actually emits

The JIT treats both methods as intrinsics. The source of `Volatile.cs` is just `[Intrinsic] public static void ReadBarrier() => ReadBarrier();`, and the importer replaces the call with a memory-barrier node flagged as load-only ([PR #107843](https://github.com/dotnet/runtime/pull/107843)). To see what that becomes, I compiled a small class with full opts and dumped it with `DOTNET_JitDisasm`:

```csharp
// .NET 10.0.10, C# 14
// DOTNET_TieredCompilation=0 DOTNET_JitDisasm='Codegen:*' dotnet vb.dll
sealed class Codegen
{
    private int _x;
    private long _a, _b, _c, _d;

    [MethodImpl(MethodImplOptions.NoInlining)]
    public long AcquireFour() =>
        Volatile.Read(ref _a) + Volatile.Read(ref _b) +
        Volatile.Read(ref _c) + Volatile.Read(ref _d);

    [MethodImpl(MethodImplOptions.NoInlining)]
    public long PlainFourThenBarrier()
    {
        long sum = _a + _b + _c + _d;
        Volatile.ReadBarrier();
        return sum;
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    public void BarrierThenPlainFour(long v)
    {
        Volatile.WriteBarrier();
        _a = v; _b = v; _c = v; _d = v;
    }
}
```

On the M4, the interesting instructions were:

```text
; AcquireFour: four separate load-acquire instructions
ldapur  x1, [x0, #0x08]
ldapur  x2, [x0, #0x10]
ldapur  x2, [x0, #0x18]
ldapur  x0, [x0, #0x20]

; PlainFourThenBarrier: two paired loads, then one load fence
ldp     x1, x2, [x0, #0x08]
ldp     x2, x0, [x0, #0x18]
dmb     ishld

; BarrierThenPlainFour: a full fence, then two paired stores
dmb     ish
stp     x1, x1, [x0, #0x08]
stp     x1, x1, [x0, #0x18]
```

Three things stand out.

First, `Volatile.Read` compiles to `ldapur`, an RCpc load-acquire (the RCpc extensions arrived in ARMv8.3 and v8.4), which the M4 supports. Cores without RCpc get the older `ldar` instead. Either way, there is no separate fence instruction.

Second, the plain reads before `ReadBarrier` stay plain, so the JIT is free to pair them into `ldp` (and, for a 32-byte struct copy, into a pair of 128-bit `ldp q` loads). You lose that freedom with four acquire loads. That is the efficiency argument the proposal made: one fence for N reads instead of N ordered reads.

Third, `Volatile.WriteBarrier()` is a full `dmb ish` on arm64, exactly what `Interlocked.MemoryBarrier()` emits. The JIT has a comment saying it cannot currently emit a store-only barrier better than a full one on arm64, so do not expect `WriteBarrier` to be cheaper than a full fence there.

On x64, both barriers emit no instruction at all. The PR's codegen comment is explicit: load-only and store-only barriers "are no-ops on xarch", because x86's TSO model already keeps loads ordered with later loads and stores, and stores ordered with earlier memory operations. They still matter on x64, though: they stop the JIT itself from reordering, caching, or eliminating memory accesses across the barrier. I did not have an x64 machine for this run, so the x64 row in the table comes from the JIT source, not a disassembly.

## A seqlock: the case ReadBarrier was built for

The runtime itself was the first customer. `GenericCache` and `CastCache` in CoreLib used an internal `Interlocked.ReadMemoryBarrier()` and were switched to `Volatile.ReadBarrier()` in the same PR. Their comment spells out the pattern: "we must read in this order: version -> [entry parts] -> version".

That is a seqlock. A single writer bumps a version to an odd number, writes the data, then bumps it to the next even number. Readers read the version, copy the data with ordinary loads, and read the version again. If both reads match and are even, the copy is consistent. The data can be any size: a 32-byte struct is not atomic on any platform, and that is fine, because the version check catches torn copies.

Here is the minimal version, with both barriers in the places they belong:

```csharp
// .NET 10, C# 14
struct Snapshot { public long A, B, C, D; }

sealed class SeqLockBox
{
    private int _version;          // even = stable, odd = write in progress
    private Snapshot _data;

    // Single writer only.
    public void Write(long n)
    {
        int v = _version;
        _version = v + 1;          // mark "writing" (odd)
        Volatile.WriteBarrier();   // odd version is published before any data write below
        _data.A = n; _data.B = n; _data.C = n; _data.D = n;
        Volatile.Write(ref _version, v + 2); // release: data writes complete before the even version
    }

    public bool TryRead(out Snapshot snapshot)
    {
        int v1 = Volatile.Read(ref _version); // acquire: the data reads below cannot move above this
        snapshot = _data;                     // plain, non-atomic 32-byte copy
        Volatile.ReadBarrier();               // every read above completes before the re-check
        return (v1 & 1) == 0 && _version == v1;
    }
}
```

Look at how the reader uses both APIs. The first version read is a `Volatile.Read`, because we need the data reads to stay *below* it. The data copy is plain. Then `ReadBarrier` keeps the data reads *above* the second version read. No single `Volatile.Read` can express that second constraint, because `Volatile.Read` only constrains what comes after the location it reads, and here the thing we need to order is what came before.

The writer mirrors it. `Volatile.Write` on the final even version is a release, so the data writes cannot sink below it. But a release does nothing to stop the data writes from rising above the earlier odd-version store. `WriteBarrier` covers that side.

## Proving each half is necessary

I ran the reader and writer on two threads for five seconds per scenario and counted how many accepted snapshots had `A`, `B`, `C`, `D` disagreeing. Each scenario removes one piece of the ordering:

```csharp
// .NET 10, C# 14: the reader variants in the stress test
public bool TryReadAcquireOnly(out Snapshot snapshot)   // no ReadBarrier
{
    int v1 = Volatile.Read(ref _version);
    snapshot = _data;
    return (v1 & 1) == 0 && _version == v1;
}

public bool TryReadBarrierOnly(out Snapshot snapshot)   // no acquire on the first read
{
    int v1 = _version;
    snapshot = _data;
    Volatile.ReadBarrier();
    return (v1 & 1) == 0 && _version == v1;
}
```

Results on the M4, .NET 10.0.10, Release build, two runs:

| Scenario | Accepted snapshots (run 1 / run 2) | Torn and accepted (run 1 / run 2) |
| --- | --- | --- |
| No ordering at all (plain reads) | 1,014,876,206 / 1,003,303,309 | 547,804 / 515,135 |
| `Volatile.Read` only, no `ReadBarrier` | 164,358,676 / 152,032,561 | 99 / 357 |
| `ReadBarrier` only, plain first read | 34,543,735 / 27,982,884 | 54 / 62 |
| Writer without `WriteBarrier`, correct reader | 354,942,744 / 384,287,324 | 66,155,404 / 54,597,163 |
| Both barriers (the code above) | 62,659,697 / 66,048,738 | 0 / 0 |

Every half-measure produced torn data that passed validation. The rare ones are the dangerous ones: 99 bad reads out of 164 million is the kind of bug that survives every test run and shows up in production on a Graviton or Ampere box. The missing `WriteBarrier` was the loudest failure, and the disassembly shows why: the two writer methods compile to identical code apart from the single `dmb ish`, so every one of those 54+ million tears is the arm64 core making the data stores visible before the odd version store.

On x64 you would very likely see zero tears for most of these rows, because the hardware does not reorder in those directions. That is exactly why these bugs ship. The code is still wrong on x64, since the JIT is allowed to reorder plain accesses, and it becomes visibly wrong the moment it runs on arm64.

## The JIT reorders too, not only the CPU

The first version of my stress harness hung forever, and it is worth showing why. The broken reader looped until it saw an even version:

```csharp
// .NET 10, C# 14: do not do this
public void WaitForEvenBroken()
{
    while ((_version & 1) != 0) { }
}
```

The JIT compiled that to one load and a branch to itself:

```text
ldr     w0, [x0, #0x08]
and     w0, w0, #1
G_M000_IG03:
cbnz    w0, G_M000_IG03
```

The load of `_version` was hoisted out of the loop, which is legal for an ordinary field read with no intervening synchronization. If the first read happened to land on an odd version, the thread spins forever. A `Volatile.Read(ref _version)` inside the condition fixes it, and so would a `ReadBarrier` inside the loop body. This is the part of "volatile" that x64 developers do experience, and it is why the barriers are not empty calls even where they emit no instruction.

## When to pick Volatile.Read

- **A flag or a stop signal.** `while (!Volatile.Read(ref _stop))` is the canonical case. One location, one value, and you want later reads to see what the writer published before setting it.
- **Publishing a reference.** Writer builds an object, then `Volatile.Write(ref _instance, obj)`; reader does `Volatile.Read(ref _instance)` and then reads fields through it. The acquire on the reference read is all you need.
- **Double-checked lazy initialization.** Same shape as publishing, and the reason `LazyInitializer` uses volatile reads internally.
- **You target .NET 9 or earlier.** `ReadBarrier` does not exist there.

In all of these, the ordering is anchored to a single read, so `Volatile.Read` says exactly what you mean and generates no fence on either architecture.

## When to pick Volatile.ReadBarrier

- **Seqlock readers and version-validated caches.** The pattern above, and the one CoreLib's `CastCache` and `GenericCache` use.
- **Data that cannot be read atomically.** Structs larger than a pointer, `Int128`, spans of bytes, or a struct with several fields. There is no `Volatile.Read` overload for them, and `ReadBarrier` lets you copy them with ordinary loads and validate afterwards.
- **Reads from native memory or through `Unsafe`.** If you read through a pointer or `ref` into an unmanaged buffer, there may be no managed field to hand to `Volatile.Read`. The barrier orders those loads all the same.
- **Many reads that need one ordering point.** One `dmb ishld` after N plain loads instead of N acquire loads, while letting the JIT pair the plain loads.

## The cost, measured

There are two correct ways to write the seqlock reader without `ReadBarrier`: make every data read a `Volatile.Read`, or use a full `Interlocked.MemoryBarrier()` where the barrier goes. I benchmarked all of them against the unordered (broken) reader with BenchmarkDotNet 0.15.8. Each invocation does 1,024 single-threaded reads of the 32-byte snapshot, and the table reports the cost per read:

```csharp
// .NET 10.0.10, C# 14, BenchmarkDotNet 0.15.8, Apple M4 (arm64)
[Benchmark(OperationsPerInvoke = N)]
public long VolatileReadPlusReadBarrier()
{
    long sum = 0;
    for (int i = 0; i < N; i++)
    {
        int v1 = Volatile.Read(ref _version);
        Snapshot s = _data;
        Volatile.ReadBarrier();
        if ((v1 & 1) == 0 && _version == v1) sum += s.A + s.B + s.C + s.D;
    }
    return sum;
}
```

| Reader (per snapshot read) | Mean | Ratio |
| --- | --- | --- |
| No ordering (broken) | 0.916 ns | 1.00 |
| `Volatile.Read` on the version and on all four fields | 1.135 ns | 1.24 |
| `Volatile.Read` + `Volatile.ReadBarrier` | 0.929 ns | 1.01 |
| `Volatile.Read` + `Interlocked.MemoryBarrier` | 0.930 ns | 1.02 |

The barrier version costs about the same as the broken one. The read-everything-volatile version is about 24% slower, mostly because four ordered `ldapur` loads cannot be fused into two wide loads the way the plain copy can. Scale that up to a larger struct and the gap grows with the field count, while the barrier stays one instruction.

Two honest caveats. This is an uncontended, single-threaded loop: a `dmb` is cheap when the core has no outstanding memory traffic to wait for, which is why the full fence also looks free here. Under real write contention a full fence typically costs more than a load-only one, but I did not run a contended benchmark, so I am not putting a number on that. And all of this is arm64. On x64 both barriers emit no instruction, so you are only comparing what the JIT is allowed to do around them.

## Gotchas that bite

**Placement is everything.** `ReadBarrier` orders reads *before* it against accesses *after* it. Putting it at the top of a reader, where people instinctively put a "volatile" read, orders nothing you care about. In a seqlock it goes after the data copy and before the second version read.

**It is not a full fence.** A store followed by `ReadBarrier` followed by a load can still be reordered. Dekker-style code, where each thread writes its own flag and then reads the other's, needs `Interlocked.MemoryBarrier()` or an `Interlocked` operation.

**It does not make anything atomic.** The memory model spec is blunt: volatile semantics does not imply atomicity. If you skip the version validation, a barrier will happily order a torn read.

**It is not a lock.** A seqlock as written supports exactly one writer. Two writers need to serialize with an `Interlocked.CompareExchange` on the version (which is what `GenericCache` does) or with a real lock. If you are reaching for barriers because a lock felt slow, measure first: the post on [lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock](/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/) shows how cheap an uncontended lock already is.

**C# `volatile` fields are not the same tool.** A `volatile` field makes the C# compiler emit every access with the `volatile.` IL prefix, so every read is an acquire and every write is a release. That is per-access `Volatile.Read`/`Volatile.Write` semantics, never a barrier over a batch, and it disables the load pairing shown above.

## The verdict

Default to `Volatile.Read`. It is the right tool for nearly every lock-free flag, publication, and lazy-init pattern, it costs nothing on x64, and on modern arm64 it is a single load-acquire instruction. Use `Volatile.ReadBarrier` (on .NET 10 and later) only when the thing you need to order is a batch of earlier reads, typically a non-atomic copy that you validate afterwards. When you do, pair it with `Volatile.WriteBarrier` on the writer side, test on arm64, and remember that on arm64 `WriteBarrier` is as expensive as a full fence.

## Related

- [How to use the new System.Threading.Lock type](/2026/04/how-to-use-the-new-system-threading-lock-type-in-dotnet-11/), the right answer when you do not actually need lock-free code.
- [lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock in C#](/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/) for picking a synchronization primitive.
- [How to cancel a long-running Task without deadlocking](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/), where a `Volatile.Read` sits behind every cancellation check.
- [record vs class vs struct in C#](/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/), relevant once your shared state is a multi-field struct that cannot be read atomically.

## Sources

- [Volatile.ReadBarrier method](https://learn.microsoft.com/en-us/dotnet/api/system.threading.volatile.readbarrier?view=net-10.0) and [Volatile class](https://learn.microsoft.com/en-us/dotnet/api/system.threading.volatile?view=net-10.0) on MS Learn.
- [API proposal: Volatile barrier APIs, dotnet/runtime#98837](https://github.com/dotnet/runtime/issues/98837).
- [Implement volatile barrier APIs, dotnet/runtime#107843](https://github.com/dotnet/runtime/pull/107843), including the JIT codegen and the CoreLib cache changes.
- [.NET memory model specification](https://github.com/dotnet/runtime/blob/main/docs/design/specs/Memory-model.md).
- [GenericCache.cs on release/10.0](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/Runtime/CompilerServices/GenericCache.cs), a production seqlock reader using `Volatile.ReadBarrier`.
