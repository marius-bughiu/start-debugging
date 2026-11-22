---
title: "How to fill or overwrite a file stream with zeros efficiently in C#"
description: "Overwrite every byte of a file with zeros in .NET 11: use one shared 1 MB zero buffer with RandomAccess.Write or Stream.Write, not a 1 KB stackalloc loop. Benchmarked on .NET 11 / APFS, plus why SetLength(0) + SetLength(n) is fast but leaves a sparse file and does not overwrite anything."
pubDate: 2026-11-22
tags:
  - "dotnet"
  - "csharp"
  - "file-io"
  - "performance"
  - "dotnet-11"
---

**Short answer:** on .NET 11, keep one static, never-written `byte[]` of zeros around 1 MB in size and write it in a loop with `RandomAccess.Write(handle, zeros[..n], offset)` (or `stream.Write` on a `FileStream`). It allocates nothing per call, makes 64 write syscalls for a 64 MB file instead of tens of thousands, and ran about 2.3x faster than the common 1 KB `stackalloc` loop in the benchmark below. If you only need the file to *read back* as zeros and do not care whether the old bytes are physically overwritten, `SetLength(0)` followed by `SetLength(length)` is roughly 15x faster still, but on APFS it frees every data block and leaves a sparse file, and on Windows the docs say the re-extended region is undefined. For a "wipe" you need the explicit write.

Everything here was checked on .NET 11.0.0 (SDK 11.0.100, C# 15) on macOS 27.0.1, Apple M4, internal SSD formatted APFS. Linux and Windows behaviour is cited from the docs, not measured.

## The 1 KB stackalloc loop and why it is not the bottleneck you think

This is the version that shows up in a [Stack Overflow question](https://stackoverflow.com/questions/80012904) asking for the most efficient way to zero a stream, and it is a reasonable first attempt:

```csharp
// .NET 11, C# 15
public static void Loop1K(Stream stream)
{
    long remaining = stream.Length;
    if (remaining == 0) return;
    const int BufferSize = 1024;
    Span<byte> span = stackalloc byte[BufferSize];
    span.Clear();
    stream.Position = 0;
    while (remaining > BufferSize)
    {
        stream.Write(span);
        remaining -= BufferSize;
    }
    stream.Write(span.Slice(0, (int)remaining));
}
```

It allocates nothing on the heap, and the `span.Clear()` is redundant but harmless (`stackalloc` memory is zeroed unless the method opts out with `[SkipLocalsInit]`, so keep the `Clear()` if you ever add that attribute). The cost is not in the C# code at all. It is in how many times the bytes cross into the kernel.

A `FileStream` opened with the default constructor has a 4096-byte internal buffer. A 1 KB write is smaller than that buffer, so `FileStream` copies it into the buffer and only issues a real `write` syscall every fourth call. On paper, for a 64 MB file that is 16,384 syscalls of 4 KB each, plus 65,536 trips through `FileStream`'s buffering logic. If the stream was opened with `bufferSize: 0` (or `1`), buffering is off and you get 65,536 syscalls of 1 KB. Writes that are equal to or larger than the buffer skip the buffer and go straight to the OS, which is exactly what we want for a bulk fill.

So the fix is boring: write bigger chunks. Allocation-free does not have to mean stack-allocated.

## A shared zero buffer and positional writes

A `stackalloc` of 1 MB is a bad idea (it eats a large slice of the thread's stack, and a stack overflow cannot be caught: it kills the process). A heap array that is allocated once per process and never written to is just as allocation-free per call, and because nobody writes to it, it stays zero forever and is safe to share across threads:

```csharp
// .NET 11, C# 15
using Microsoft.Win32.SafeHandles;

public static class Zero
{
    // Allocated once, never written. Lives on the LOH; that is fine for a static.
    private static readonly byte[] s_zeros = new byte[1024 * 1024];

    // Works for any seekable Stream.
    public static void FillWithZeros(Stream stream)
    {
        long remaining = stream.Length;
        stream.Position = 0;
        ReadOnlySpan<byte> zeros = s_zeros;
        while (remaining > 0)
        {
            int n = (int)Math.Min(remaining, zeros.Length);
            stream.Write(zeros[..n]);
            remaining -= n;
        }
    }

    // FileStream-specific: positional writes straight on the OS handle.
    public static void FillWithZeros(SafeFileHandle handle, long offset = 0, long? length = null)
    {
        long end = offset + (length ?? RandomAccess.GetLength(handle) - offset);
        ReadOnlySpan<byte> zeros = s_zeros;
        while (offset < end)
        {
            int n = (int)Math.Min(end - offset, zeros.Length);
            RandomAccess.Write(handle, zeros[..n], offset);
            offset += n;
        }
    }
}
```

[`RandomAccess.Write`](https://learn.microsoft.com/en-us/dotnet/api/system.io.randomaccess.write) has existed since .NET 6. It maps to `pwrite` on Unix and an overlapped-offset `WriteFile` on Windows, and for seekable files it does not move the file position. That gives you two things the `Stream` version does not: you can zero an arbitrary range without touching `Position`, and several threads can zero different ranges of the same handle without coordinating on a shared cursor. Call it with `fileStream.SafeFileHandle`, or open the handle directly with `File.OpenHandle(path, FileMode.Open, FileAccess.Write)` and skip `FileStream` entirely.

If you are zeroing a `FileStream` you already hold and you mix the two APIs, call `fileStream.Flush()` before touching the handle so no buffered bytes land after your zeros. Also note that the [.NET 11 docs](https://learn.microsoft.com/en-us/dotnet/api/system.io.randomaccess.write) say the offset is ignored for non-seekable files (on .NET 10 and earlier those threw `NotSupportedException`), which matters if the handle could ever be a pipe.

Why 1 MB? Past a few hundred KB the per-syscall overhead is already negligible next to the cost of moving the bytes, and the buffer stays small enough to keep around forever. If you zero gigabyte-sized files and want fewer syscalls still, `RandomAccess.Write` has an overload that takes `IReadOnlyList<ReadOnlyMemory<byte>>` and maps to a gather write (`pwritev`), so you can hand the same zero buffer in several times per call.

## The SetLength shortcut and what it really does

There is a much faster trick that people find next:

```csharp
// .NET 11, C# 15
public static void Truncate(FileStream stream)
{
    long length = stream.Length;
    stream.SetLength(0);
    stream.SetLength(length);
}
```

It does not write any zeros. It tells the file system the file is now empty, which releases the data blocks, and then extends the logical size again. Whether the extended region reads as zeros depends on the platform, and the [`FileStream.SetLength` docs](https://learn.microsoft.com/en-us/dotnet/api/system.io.filestream.setlength) are explicit that the contents between the old and new length are undefined on Windows, while on Linux that space is filled with zeros ([`ftruncate(2)`](https://man7.org/linux/man-pages/man2/ftruncate.2.html) guarantees the extended part reads as null bytes). The base [`Stream.SetLength`](https://learn.microsoft.com/en-us/dotnet/api/system.io.stream.setlength) contract says the same "not defined" for every stream type.

To see what this does on disk, a small check program filled a 64 MB file with random bytes, ran each method, called `Flush(flushToDisk: true)`, then read the file back and asked `stat -f %b` how many 512-byte blocks were actually allocated:

```text
Loop1K          length=67108864 allZero=True blocks before=131072 after=131072 ms=31,7
Loop1M          length=67108864 allZero=True blocks before=131072 after=131072 ms=23,6
RandomAccess1M  length=67108864 allZero=True blocks before=131072 after=131072 ms=22,7
Truncate        length=67108864 allZero=True blocks before=131072 after=0 ms=4,5
```

All four leave a 64 MB file that reads back as zeros. The three writing methods keep all 131,072 blocks allocated and overwrite them. The `SetLength` version leaves a file with a logical length of 64 MB and **zero** allocated blocks: a fully sparse file. APFS supports sparse files, so reads of the hole return zeros without ever touching the SSD.

That has three practical consequences:

1. **It is not a wipe.** The old data blocks go back to the free list with their contents intact until something else reuses them (or the SSD's TRIM gets to them). If your intent is "make the previous contents unrecoverable", truncate-and-extend gives you nothing over deleting the file.
2. **The space comes back as free space.** That is a feature for a scratch file and a bug for a preallocated file whose point was to reserve disk space up front. The next real write to that file has to allocate again and can fail with "disk full".
3. **Behaviour differs by OS and file system.** Windows makes no promise about the extended contents per the docs, and FAT-family volumes do not support sparse files at all. Code that relies on it is not portable.

Use it when you are resetting a scratch or cache file and only care about what reads return. Do not use it when the bytes on disk matter.

## Benchmark numbers on .NET 11

The benchmark used [BenchmarkDotNet](https://benchmarkdotnet.org/) 0.15.8, a 64 MB file rewritten with random data in `[IterationSetup]` before every measured call (so every method starts from a fully allocated, non-zero file), and two modes: `Fsync = False` ends with `FileStream.Flush()` (the data reaches the OS page cache) and `Fsync = True` ends with `Flush(flushToDisk: true)` (the runtime also asks the OS to persist it). BenchmarkDotNet 0.15.8 does not recognize `net11.0` for its default out-of-process toolchain, so the job ran in-process:

```csharp
// .NET 11, C# 15, BenchmarkDotNet 0.15.8
BenchmarkRunner.Run<ZeroFillBenchmarks>(DefaultConfig.Instance.AddJob(
    Job.Default.WithWarmupCount(3).WithIterationCount(30)
        .WithToolchain(InProcessEmitToolchain.Instance)), args);

[MemoryDiagnoser]
public class ZeroFillBenchmarks
{
    [Params(64 * 1024 * 1024)] public int Size;
    [Params(false, true)] public bool Fsync;

    // IterationSetup writes Size random bytes to the file and opens _fs on it.

    [Benchmark(Baseline = true)] public void Loop1K_Stackalloc() { Zero.Loop1K(_fs); Done(); }
    [Benchmark] public void Loop1K_Unbuffered() { /* same loop, FileStream bufferSize: 0 */ }
    [Benchmark] public void Loop1M_SharedBuffer() { Zero.Loop1M(_fs); Done(); }
    [Benchmark] public void RandomAccess_1M() { Zero.RandomAccess1M(_fs.SafeFileHandle); Done(); }
    [Benchmark] public void SetLength_Truncate() { Zero.Truncate(_fs); Done(); }
}
```

Results (BenchmarkDotNet v0.15.8, macOS 27.0.1, Apple M4, .NET 11.0.0 Arm64 RyuJIT, 30 iterations):

| Method              | Fsync | Mean       | StdDev   | Ratio | Allocated |
|---------------------|-------|-----------:|---------:|------:|----------:|
| Loop1K_Stackalloc   | False |  44.7 ms   |  8.7 ms  | 1.00  | -         |
| Loop1K_Unbuffered   | False |  99.4 ms   |  4.6 ms  | 2.32  | -         |
| Loop1M_SharedBuffer | False |  18.7 ms   |  1.6 ms  | 0.44  | -         |
| RandomAccess_1M     | False |  18.3 ms   |  2.0 ms  | 0.43  | -         |
| SetLength_Truncate  | False |   2.8 ms   |  0.7 ms  | 0.07  | -         |
| Loop1K_Stackalloc   | True  | 102.0 ms   | 12.7 ms  | 1.00  | -         |
| Loop1K_Unbuffered   | True  | 118.3 ms   |  9.6 ms  | 1.18  | -         |
| Loop1M_SharedBuffer | True  |  97.9 ms   | 11.1 ms  | 0.97  | -         |
| RandomAccess_1M     | True  |  95.8 ms   | 10.7 ms  | 0.95  | -         |
| SetLength_Truncate  | True  |   8.4 ms   |  1.5 ms  | 0.08  | -         |

How to read it:

- **When the data only has to reach the page cache**, chunk size is everything. The 1 MB buffer is about 2.3x faster than the buffered 1 KB loop, and the unbuffered 1 KB loop is another 2.3x slower than that. An earlier 15-iteration run on the same machine gave the same ordering (0.43x, 0.37x and 2.96x against the baseline), so the ranking is stable even though the absolute times moved between runs.
- **When you force the data to disk**, the SSD dominates and every writing method lands within noise of the others (around 100 ms for 64 MB here). Buffer size stops mattering once you wait for the device. The 15-iteration run was much noisier in this mode (one method swung by 40 ms between iterations), which is typical for fsync-bound measurements on a laptop that is doing other I/O.
- **Nothing allocates.** The MemoryDiagnoser shows zero managed allocation per operation for every method, so "minimal allocations" is not a reason to prefer `stackalloc` over a static array.
- **`SetLength` is fastest because it skips the work**, as the block counts above show. It is not a faster way of writing zeros.

These are single-machine numbers on one SSD and one file system. Treat the ratios as the takeaway, not the milliseconds, and re-measure on your target if the absolute cost matters.

## Native zero-range calls on Linux and Windows

If you want the file system to zero a range without your process pushing the bytes, each OS has a dedicated call, and none of them is wrapped by .NET:

- **Linux:** [`fallocate(2)`](https://man7.org/linux/man-pages/man2/fallocate.2.html) with `FALLOC_FL_ZERO_RANGE` (Linux 3.15+, supported on XFS, ext4 extent-based files, Btrfs and SMB3). Reads of the range then return zeros, but the man page says it prefers converting the range into unwritten extents, so the device itself is not zeroed except for partial blocks at the edges. `FALLOC_FL_PUNCH_HOLE | FALLOC_FL_KEEP_SIZE` deallocates the range instead, similar to what `SetLength` did on APFS.
- **Windows:** [`FSCTL_SET_ZERO_DATA`](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ni-winioctl-fsctl_set_zero_data) through `DeviceIoControl`. On a non-sparse file the system actually writes zeros and keeps the storage allocated. On a sparse file NTFS may deallocate the range instead.

The accepted answer on the Stack Overflow question shows the P/Invoke for both. They were not benchmarked here (the test machine is macOS), and both share the caveat of the `SetLength` trick on some paths: "reads as zero" is guaranteed, "the old bytes are physically gone" is not. The portable managed loop above is the only option in this post that is guaranteed to issue real writes on every platform.

## Edge cases worth handling

**Non-seekable streams.** `stream.Length` and `stream.Position` throw `NotSupportedException` on a `NetworkStream`, a pipe, or a `GZipStream`. A "fill with zeros" helper only makes sense for seekable streams, so check `stream.CanSeek && stream.CanWrite` up front and fail with a clear message instead of a confusing exception from deep in the loop.

**Durability.** `FileStream.Dispose()` flushes the managed buffer to the OS, not to the device. If the zeros must survive a power cut, end with `fileStream.Flush(flushToDisk: true)`, or use `File.OpenHandle(..., options: FileOptions.WriteThrough)` with `RandomAccess.Write` so every write is written through.

**Async.** For a server that must not block a thread pool thread for 100 ms, swap `RandomAccess.Write` for `RandomAccess.WriteAsync(handle, s_zeros.AsMemory(0, n), offset, ct)`. The static `byte[]` works for both, because `ReadOnlyMemory<byte>` over an array can cross an `await` while a `stackalloc` span cannot. That is another quiet reason to prefer the shared array.

**Secure deletion.** Overwriting in place is the best a user-mode process can do, and it is still not a guarantee. SSDs remap logical blocks for wear levelling, and copy-on-write file systems can keep the old blocks alive in a snapshot or a clone (`cp -c` on APFS, reflinks on Btrfs/XFS, Volume Shadow Copies on Windows). If the requirement is "the data must be unrecoverable", the reliable tools are full-disk encryption (destroy the key) or the drive's own secure-erase command, not a zero-fill loop.

**Partial ranges.** To zero only part of a file, pass `offset` and `length` to the `SafeFileHandle` overload. Writes past the current end of the file extend it, so clamp `length` to `RandomAccess.GetLength(handle) - offset` if you do not want that.

### Read next

- [What is Span<T> in C#, and when does it actually make your code faster?](/2026/06/what-is-span-and-when-does-it-make-my-code-faster/) explains why `stackalloc` buys nothing here compared to a cached array.
- [List vs Span vs ReadOnlySpan in C#](/2026/05/list-vs-span-vs-readonlyspan-in-csharp/) covers when a span can and cannot cross an `await`.
- [How to detect when a file finishes being written to in .NET](/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/) is the reader-side companion to bulk writes like these.
- [Fix: FileInfo.Length returns a stale size for a file still being written on Windows](/2026/10/fix-fileinfo-length-returns-stale-size-for-a-file-still-being-written-on-windows/) shows another place where file metadata and on-disk reality disagree.
- [StringBuilder vs string interpolation in .NET 11](/2026/05/stringbuilder-vs-string-interpolation-in-dotnet-11/) is another BenchmarkDotNet comparison on the same runtime.

## Sources

- [Stack Overflow: Most efficient way to fill a stream with zeros?](https://stackoverflow.com/questions/80012904)
- [RandomAccess.Write (MS Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.io.randomaccess.write)
- [FileStream.SetLength (MS Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.io.filestream.setlength) and [Stream.SetLength (MS Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.io.stream.setlength)
- [ftruncate(2)](https://man7.org/linux/man-pages/man2/ftruncate.2.html) and [fallocate(2)](https://man7.org/linux/man-pages/man2/fallocate.2.html) Linux man pages
- [FSCTL_SET_ZERO_DATA (Win32 docs)](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ni-winioctl-fsctl_set_zero_data)
