---
title: "ref T loop vs Span<T> indexing in C#: why the span version is as fast or faster in .NET 10"
description: "On .NET 10 a plain for loop over span[i] bounded by span.Length compiles to a bounds-check-free, strength-reduced, down-counting loop. A hand-written Unsafe.Add(ref r, i) loop with an int index keeps a sign extension and an up-counting compare, and measured 2-5% slower. Benchmarks and JIT disassembly for arm64 and x64 on .NET 10.0.10."
pubDate: 2026-10-30
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "performance"
  - "span"
  - "jit"
---

On .NET 10, write the loop as `for (int i = 0; i < span.Length; i++) sum += span[i];` and stop there. The JIT proves every index is in range, removes the bounds check, rewrites the index into a byte offset that it bumps by 4 each time (strength reduction), and turns the loop into a down-counter that ends on a single `dec`/`jne` (or `sub`/`cbnz` on Arm64). The "faster" hand-written version, `sum += Unsafe.Add(ref r, i)` with an `int` index, does not get that treatment. It keeps the `int` counter, sign-extends it into a native-sized offset on every iteration, and compares against the length at the bottom of the loop. In my measurements on .NET 10.0.10 that made the `Unsafe.Add` loop **2.4% slower at 4,096 elements and 3.6% slower at 1,000,000 elements** than the safe span loop. Switching the `ref` loop's counter to `nint` closes the gap completely, and a pointer-bumping `ref` walk ties the span loop. So `ref T` code can only tie the span loop on .NET 10. It never wins, and it gives up memory safety to get there.

Everything below was measured with BenchmarkDotNet 0.15.8 on .NET 10.0.10 (SDK 10.0.302), C# 14, on an Apple M4 running macOS 27.0.1. The Arm64 listings are the real Tier1 code from that run, captured with `DOTNET_JitDisasm`. The x64 listings come from crossgen2 10.0.10 targeting `win-x64`, which runs the same RyuJIT with full optimizations but without Dynamic PGO. The loop optimizations that explain the result shipped in [.NET 9](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-9/runtime#loop-optimizations), so everything here applies to .NET 9 as well.

## The comparison at a glance

| Loop shape | Bounds check in loop | Index math per iteration | 4,096 ints | 1,000,000 ints |
| --- | --- | --- | ---: | ---: |
| `for` over `array[i]` | Removed | Strength-reduced offset, down-counting | 1,035.6 ns | 251.9 us |
| `for` over `span[i]`, bound `span.Length` | Removed | Strength-reduced offset, down-counting | 1,035.9 ns | 254.4 us |
| `foreach (ref readonly int x in span)` | Removed | Same as above | 1,035.6 ns | 254.5 us |
| `for` over `span[i]`, bound is a parameter `n` | Hoisted out by loop cloning | Same as above in the fast clone | 1,035.4 ns | 254.5 us |
| `Unsafe.Add(ref r, i)`, `int i` | None (never had one) | Sign extend + up-counting compare | 1,060.1 ns | 263.7 us |
| `Unsafe.Add(ref r, i)`, `nint i` | None | Strength-reduced, down-counting | 1,036.1 ns | 254.7 us |
| `ref` walk with `Unsafe.IsAddressLessThan` | None | Post-increment pointer | 1,035.3 ns | 251.4 us |
| `Enumerable.Sum(int[])` | n/a | Vectorized | 506.9 ns | 128.6 us |

Each loop sums an `int[]`. The error bars are all under 1.5 ns at 4,096 and under 0.8 us at one million. I re-ran the span and `ref` rows in a second, separate BenchmarkDotNet session, and every mean came back within 0.6 ns (4,096) and 0.1 us (one million) of the first run. The last row is there to keep the result in proportion: the fastest scalar loop is still half the speed of a vectorized one.

## The two loops people actually compare

The question usually comes up after someone reads BCL source, sees `ref T` and `Unsafe.Add` everywhere, and rewrites a hot loop to match. Here are the two shapes side by side:

```csharp
// .NET 10.0.10, C# 14
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

static int SpanFor(ReadOnlySpan<int> s)
{
    int sum = 0;
    for (int i = 0; i < s.Length; i++) sum += s[i];
    return sum;
}

static int RefAdd(ReadOnlySpan<int> s)
{
    int sum = 0;
    ref int r = ref MemoryMarshal.GetReference(s);
    for (int i = 0; i < s.Length; i++) sum += Unsafe.Add(ref r, i);
    return sum;
}
```

The intuition behind `RefAdd` is that `s[i]` has a bounds check and `Unsafe.Add` does not, so the `ref` version must be faster. On .NET Core 2.1 that intuition was often correct. Since then, the JIT has learned to remove the bounds check from exactly this loop shape, and in .NET 9 it learned three more tricks that only apply when it fully understands the index variable. The span loop gets all of them. The `Unsafe.Add` loop falls outside the pattern.

## What the JIT does with the span loop

Here is the Tier1 Arm64 code for `SpanFor`, straight from `DOTNET_JitDisasm` on .NET 10.0.10:

```asm
; Kernels:SpanFor(System.ReadOnlySpan`1[int]):int (Tier1), .NET 10.0.10 Arm64
            mov     w2, wzr            ; sum = 0
            cmp     w1, #0             ; length <= 0 ?
            ble     G_M000_IG05
            mov     x3, xzr            ; byte offset = 0
G_M000_IG04:
            ldr     w4, [x0, x3]       ; load s[i]
            add     w2, w4, w2         ; sum += ...
            add     x3, x3, #4         ; offset += 4
            sub     w1, w1, #1         ; remaining--
            cbnz    w1, G_M000_IG04    ; loop while remaining != 0
```

Three separate optimizations are visible in that loop:

1. **Bounds check elimination.** There is no compare against the length and no call to `CORINFO_HELP_RNGCHKFAIL`. Because `i` starts at 0, only increments, and is guarded by `i < s.Length`, the JIT's range analysis proves `s[i]` is always valid. This is the part everyone knows about, and it has worked for spans since .NET Core 2.1.
2. **Strength reduction.** The source multiplies `i` by 4 to get an address. The loop instead keeps a byte offset in `x3` and adds 4 to it. The .NET 9 runtime notes describe this as the JIT "automatically" turning indexed access into this form.
3. **Loop counter direction.** The original `i` is gone. Once the address no longer depends on `i`, the counter only controls the trip count, so the JIT counts the length down to zero and ends the loop with `cbnz` instead of a separate compare and branch.

On x64 the same method compiles to four instructions in the loop body:

```asm
; Kernels:SpanFor, crossgen2 10.0.10, win-x64, full opts
G_M000_IG04:
       add      edx, dword ptr [rax+r8]
       add      r8, 4
       dec      ecx
       jne      SHORT G_M000_IG04
```

That is about as tight as a scalar sum loop can get. There is no instruction left for a `ref` rewrite to remove.

## What the JIT does with the `Unsafe.Add` loop

Now `RefAdd`, same machine, same run:

```asm
; Kernels:RefAdd(System.ReadOnlySpan`1[int]):int (Tier1), .NET 10.0.10 Arm64
G_M000_IG03:
            ldr     w4, [x0, w3, SXTW #2]   ; load r[(nint)i * 4]
            add     w2, w4, w2
            add     w3, w3, #1              ; i++
            cmp     w3, w1                  ; i < length ?
            blt     G_M000_IG03
```

```asm
; Kernels:RefAdd, crossgen2 10.0.10, win-x64, full opts
G_M000_IG05:
       movsxd   r8, ecx                     ; sign-extend i to 64 bits
       add      esi, dword ptr [rax+4*r8]
       inc      ecx
       cmp      ecx, edx
       jl       SHORT G_M000_IG05
```

The loop has no bounds check, but the span loop didn't have one either, so that buys nothing. What it lost is the strength reduction and the down-counting. `Unsafe.Add<T>(ref T source, int elementOffset)` converts the `int` offset to a native integer before scaling it. That sign extension sits between the induction variable and the address, and the JIT does not rewrite through it. So the loop keeps `i` as a 32-bit counter, re-derives the address from it on every iteration (`SXTW #2` on Arm64, an explicit `movsxd` on x64), and needs a real compare against the length at the bottom.

On Arm64 the sign extension is folded into the load's addressing mode, so the instruction count matches the span loop. It still measured slower, consistently, across both runs. The visible difference is the loop exit: an explicit `cmp` of the incremented counter against the length, instead of the down-counter's fused `cbnz`. I did not profile below the instruction level, so treat that as the likely cause rather than a proven one. On x64 there is simply one extra instruction per element. Neither difference is large, and that is the point: the hand-written version costs you safety and still loses a few percent.

## Fixing the `ref` loop, if you really need one

There are two ways to write a `ref` loop that matches the span loop. The first is to make the index native-sized, so there is nothing to sign-extend:

```csharp
// .NET 10.0.10, C# 14
static int RefAddNint(ReadOnlySpan<int> s)
{
    int sum = 0;
    ref int r = ref MemoryMarshal.GetReference(s);
    for (nint i = 0; i < s.Length; i++) sum += Unsafe.Add(ref r, i);
    return sum;
}
```

The Arm64 Tier1 code for this is instruction-for-instruction the same as `SpanFor` (`ldr w4, [x0, x3]`, `add x3, x3, #4`, `sub x1, x1, #1`, `cbnz`), and it benchmarked at 1,036.1 ns against the span loop's 1,035.7 ns. The x64 crossgen2 output is also the same four-instruction body.

The second is the pointer-bumping walk that a lot of older high-performance code uses:

```csharp
// .NET 10.0.10, C# 14
static int RefWalk(ReadOnlySpan<int> s)
{
    int sum = 0;
    ref int p = ref MemoryMarshal.GetReference(s);
    ref int end = ref Unsafe.Add(ref p, s.Length);
    while (Unsafe.IsAddressLessThan(ref p, ref end))
    {
        sum += p;
        p = ref Unsafe.Add(ref p, 1);
    }
    return sum;
}
```

On Arm64 this one uses post-indexed addressing (`ldr w3, [x0], #0x04`, load and advance in one instruction), so the loop body is four instructions instead of five. It was the fastest row at one million elements by about 1%, which is within the noise you would see between two different machines. That is the best case for hand-written `ref` code on .NET 10: a 1% tie, in exchange for code where an off-by-one reads or writes memory outside the span with no exception. Also note that `end` is a managed reference one element past the end of the buffer. The [unsafe code best practices](https://learn.microsoft.com/en-us/dotnet/standard/unsafe-code/best-practices) say not to create invalid managed pointers even if you never dereference them, and they leave the exact validity rules to ECMA-335. That is not a corner you want to be in for a 1% gain.

If you write `foreach (ref readonly int x in span)` because you heard it is the "ref loop", it compiles to the same code as the indexed span loop. The C# compiler lowers a span `foreach` to an indexed `for` over the span, so the JIT sees the same shape.

## Where the span loop loses its advantage

The span loop is fast because the JIT can prove things about it. Break the proof and the loop changes shape. The most common way is bounding the loop by something other than `span.Length`:

```csharp
// .NET 10.0.10, C# 14
static int SpanForN(ReadOnlySpan<int> s, int n)
{
    int sum = 0;
    for (int i = 0; i < n; i++) sum += s[i];   // n is not s.Length
    return sum;
}
```

Now `s[i]` can genuinely be out of range. The Tier1 JIT handles this with **loop cloning**: it emits a check `n <= s.Length` before the loop, a fast clone with no bounds check for when it holds, and a slow clone that checks every iteration and throws `IndexOutOfRangeException` at the first bad index. The fast clone in my Arm64 listing is identical to `SpanFor`, which is why the benchmark row ties. The crossgen2 x64 output for the same method did not clone and kept a `cmp`/`jae` in the loop. So if a method like this runs from ReadyToRun code before tiering replaces it, it pays the check. The fix is to give the JIT the proof yourself: `s = s[..n];` before the loop, then loop to `s.Length`. The slice does one bounds check up front, and every iteration after that is free.

The same trick matters when two spans are involved:

```csharp
// .NET 10.0.10, C# 14
static void CopyX2(ReadOnlySpan<int> src, Span<int> dst)
{
    dst = dst[..src.Length];                    // one check here...
    for (int i = 0; i < src.Length; i++)
        dst[i] = src[i] * 2;                    // ...none in the loop
}
```

Without the slice, `dst[i]` is not covered by the `i < src.Length` guard. Tier1 cloned that loop too (a `cmp w1, w3` / `bgt` before entry selects the checked or unchecked copy), so all three variants (unsliced, sliced, and an `Unsafe.Add` version with a manual length check) measured within 1% of each other at 4,096 elements. At 64 elements, the `Unsafe.Add` version with its up-front `ArgumentException` check was the slowest of the three at 20.1 ns against 16.8 ns for the sliced span loop. Slicing is still the version to write, because it does not depend on cloning heuristics and it says what the method requires.

If you want to see the checks for yourself, the earlier post on [bounds-check elimination for index-from-end access in .NET 11](/2026/04/jit-bounds-check-elimination-index-from-end-dotnet-11-preview-3/) covers how to read `CORINFO_HELP_RNGCHKFAIL` in a listing, and [Rider's ASM viewer](/2026/04/rider-2026-1-asm-viewer-jit-nativeaot-disassembly/) shows the same code without environment variables.

## How to verify this on your own code

Microsoft's own guidance in the [unsafe code best practices](https://learn.microsoft.com/en-us/dotnet/standard/unsafe-code/best-practices) is blunt about it: the benefits of unsafe bounds-check removal "are often transient", so check whether the current JIT still needs it and rewrite in safe code if it doesn't. Two commands are enough to check:

```bash
# .NET 10 SDK, any OS
DOTNET_JitDisasm="SpanFor RefAdd" DOTNET_JitStdOutFile=jit.txt dotnet run -c Release
dotnet run -c Release -- --filter '*SpanFor*' '*RefAdd*'   # BenchmarkDotNet
```

Things that will mislead you while you do it:

- **Tier0 code.** The first listing printed for a method is unoptimized Tier0 code, where `s[i]` is a real call with a real check. Look for the listing marked `Tier1`. The post on [how tiered compilation works](/2026/07/what-is-tiered-compilation-and-how-do-i-reason-about-it/) explains when each tier runs and what OSR does to long-running loops.
- **ReadyToRun and crossgen2 listings.** Precompiled code has no PGO, and it can keep calls that Tier1 inlines. My x64 listings call `MemoryMarshal.GetReference` out of line, most likely because crossgen2 does not inline across the version bubble into `System.Private.CoreLib`. The loop bodies are still representative, but the prologue is not.
- **Microbenchmarks that hide the loop.** Mark the kernel `[MethodImpl(MethodImplOptions.NoInlining)]` so the JIT compiles it as its own method, and read the listing for that method, not the benchmark wrapper.
- **Wrong baseline.** If the real goal is throughput, compare against a vectorized version. `Enumerable.Sum` on an `int[]` ran at 2x the speed of every scalar loop here, and `Vector<T>` or `TensorPrimitives` gets you there for custom operations.

## Picking between them

Use the span (or array) indexed loop bounded by `.Length` as the default. It is safe, it is what the JIT's loop optimizer is tuned for, and on .NET 10 it is never slower than the `ref` alternatives in any of these measurements. When the bound is something else, slice first so the bound becomes `.Length`.

Reach for `ref T` and `Unsafe.Add` only when you have a listing that shows a bounds check the JIT cannot remove, and a benchmark that shows the check matters. When you do, use an `nint` index or a pointer walk, not an `int` index, or you will lose the strength reduction the span loop got for free. If you are making `ref` and slicing choices across a whole API, [`List<T>` vs `Span<T>` vs `ReadOnlySpan<T>`](/2026/05/list-vs-span-vs-readonlyspan-in-csharp/) covers which type to accept in the first place, [what `Span<T>` is and when it makes code faster](/2026/06/what-is-span-and-when-does-it-make-my-code-faster/) covers the other two places spans actually pay off, and [iterating two collections in lockstep without allocations](/2026/10/how-to-iterate-over-two-collections-in-lockstep-without-heap-allocations-in-csharp/) applies the slice-to-prove-bounds pattern to a two-input loop.

## Sources

- [What's new in the .NET 9 runtime: loop optimizations](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-9/runtime#loop-optimizations) (induction variable widening, post-indexed addressing, strength reduction, loop counter direction)
- [What's new in the .NET 10 runtime](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-10/runtime) (improved loop inversion, which loop cloning and induction variable optimizations depend on)
- [Unsafe code best practices](https://learn.microsoft.com/en-us/dotnet/standard/unsafe-code/best-practices) (section 9, unsafe bounds check removal; section 4, invalid managed pointers)
- [`Unsafe` class API reference](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.unsafe)
- [BenchmarkDotNet](https://benchmarkdotnet.org/)
