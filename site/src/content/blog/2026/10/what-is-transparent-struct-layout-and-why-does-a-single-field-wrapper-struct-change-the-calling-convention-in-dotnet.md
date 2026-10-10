---
title: "What Is Transparent Struct Layout, and Why Does a Single-Field Wrapper Struct Change the Calling Convention in .NET?"
description: "A transparent struct is one the ABI treats exactly like its only field. .NET 11 has no such guarantee: a struct wrapping a double is passed in RCX on Windows x64 but in XMM0 on Linux and macOS. Here is the disassembly from the .NET 11 JIT on three ABIs, the P/Invoke bugs it causes, and how to write wrapper types that are safe at every boundary."
pubDate: 2026-10-10
tags:
  - "dotnet-11"
  - "csharp"
  - "interop"
  - "jit"
  - "performance"
---

Short answer: "transparent layout" is the guarantee that a struct with exactly one field is laid out *and passed across calls* exactly like that field. Rust spells it `#[repr(transparent)]`. .NET 11 does not have it. A C# struct like `readonly record struct Meters(double Value)` has the same 8-byte memory layout as a `double`, but at a call boundary the JIT classifies it as an aggregate, and each platform ABI decides how aggregates travel. On Linux x64, macOS x64, and every ARM64 target the wrapper still rides in a floating-point register, so you never notice. On Windows x64 it goes in `RCX`, an integer register, and is returned in `RAX` instead of `XMM0`. That costs a couple of register moves in managed code and silently corrupts values if you use the wrapper in a P/Invoke signature whose native side takes a plain `double`.

Everything below was run on .NET 11 RC1 (runtime 11.0.0-rc.1.26425.128, SDK 11.0.100-rc.1.26425.128) with C# 15. The managed disassembly for Windows x64 and Linux x64 comes from the RC1 `crossgen2` cross-compiler with `JitDisasm`, the macOS listings come from running the app natively on arm64 and under Rosetta on x64, and the native listings come from Apple clang 21 targeting each ABI.

## Memory layout and calling convention are two different contracts

When people say a single-field struct is "free", they usually mean memory layout. That part is true. `Meters` occupies 8 bytes, aligned to 8, exactly like `double`. `Unsafe.SizeOf<Meters>()` returns 8, an array of `Meters` is bit-compatible with an array of `double`, and `MemoryMarshal.Cast<Meters, double>` works.

The calling convention is a separate contract. It answers: when this value is an argument or a return value, which register or stack slot holds it? An ABI makes that decision by *classifying* the type, and most ABIs classify by "is this a scalar or an aggregate" first and only then look inside. A struct is an aggregate even if it has one field. Whether the ABI then looks through it to the `double` inside depends entirely on the platform:

- **System V AMD64 (Linux x64, macOS x64)** splits aggregates into eightbytes and classifies each one by the fields it contains. One `double` field means the eightbyte is class SSE, so the struct goes in `XMM0`, same as a bare `double`.
- **AAPCS64 (Linux, macOS, and Windows on ARM64)** has the homogeneous floating-point aggregate (HFA) rule: a struct of one to four fields of the same floating-point type is passed in consecutive SIMD registers. One `double` is an HFA of size one, so it goes in `D0`, same as a bare `double`.
- **Windows x64** does not look inside at all. The [x64 calling convention docs](https://learn.microsoft.com/en-us/cpp/build/x64-calling-convention) say structs of size 8, 16, 32, or 64 bits "are passed as if they were integers of the same size." A struct containing one `double` is 64 bits, so it goes in `RCX`. For returns, a user-defined type of the right size comes back in `RAX`, while floats and doubles come back in `XMM0`.

The .NET JIT follows the platform ABI for managed-to-managed calls, not just for P/Invoke. So this is not an interop-only curiosity. It shows up in ordinary C# code.

## The native ABI, straight from the compiler

Here is the smallest C file that exposes the difference. Compiling it for three targets with `clang -O2 -S` shows what each ABI expects:

```c
// abi.c, Apple clang 21, -O2
typedef struct { double value; } Meters;
typedef struct { float x, y; } Vec2;

double take_double(double d) { return d * 2.0; }
double take_meters(Meters m) { return m.value * 2.0; }
Meters ret_meters(double d) { Meters m = { d }; return m; }
float  take_vec2(Vec2 v) { return v.x + v.y; }
float  take_two_floats(float x, float y) { return x + y; }
```

For `x86_64-pc-windows-msvc`:

```asm
; Windows x64
take_double:
    addsd   %xmm0, %xmm0      ; double arrives in xmm0
    retq
take_meters:
    movq    %rcx, %xmm0       ; Meters arrives in rcx, moved to xmm0 first
    addsd   %xmm0, %xmm0
    retq
ret_meters:
    movq    %xmm0, %rax       ; Meters is returned in rax, not xmm0
    retq
```

For `x86_64-apple-macos` (System V) and `arm64-apple-macos` (AAPCS64), `take_meters` compiles to the exact same instructions as `take_double` (`addsd %xmm0, %xmm0` and `fadd d0, d0, d0` respectively), and `ret_meters` compiles to a bare `ret` because the value is already in the return register.

So the wrapper is transparent on two of the three ABIs by accident of their classification rules, and opaque on Windows x64.

## What the .NET 11 JIT emits for a wrapper struct

Now the managed side. Two methods, identical except for the wrapper:

```csharp
// .NET 11 RC1, C# 15
using System.Runtime.CompilerServices;

public readonly record struct Meters(double Value);

static class Managed
{
    [MethodImpl(MethodImplOptions.NoInlining)]
    public static double ScaleDouble(double d) => d * 2.0;

    [MethodImpl(MethodImplOptions.NoInlining)]
    public static Meters ScaleMeters(Meters m) => new(m.Value * 2.0);
}
```

On Linux x64 (crossgen2 `--targetos:linux --targetarch:x64`), both methods compile to the same 5 bytes:

```asm
; Managed:ScaleMeters(Meters):Meters, .NET 11 RC1, linux-x64
       vaddsd   xmm0, xmm0, xmm0
       ret
; Total bytes of code 5
```

On macOS arm64, running natively with `DOTNET_JitDisasm`, both are the same 20 bytes, with `fadd d0, d0, d0` as the only real work.

On Windows x64 (crossgen2 `--targetos:windows --targetarch:x64`), `ScaleDouble` is still 5 bytes, but `ScaleMeters` becomes:

```asm
; Managed:ScaleMeters(Meters):Meters, .NET 11 RC1, win-x64
       vmovq    xmm0, rcx          ; argument arrives in an integer register
       vaddsd   xmm0, xmm0, xmm0
       vmovq    rax, xmm0          ; result leaves in an integer register
       ret
; Total bytes of code 15
```

Two extra cross-domain moves per call, three times the code size. Inside the method body the JIT promotes the struct to its single field and works on a plain `double` register; the cost lives entirely at the boundary. If the call is inlined, the boundary disappears and so does the cost. That is why the overhead rarely matters in practice, and why you only see it on hot non-inlined paths: virtual calls, interface dispatch, delegates, `NoInlining` methods, or methods too large to inline.

Wrapping an integer or a reference does not have this problem on any of these ABIs. A `readonly record struct UserId(int Value)` travels in `ECX` on Windows x64, `EDI` on System V, and `W0` on ARM64, exactly like a bare `int`. A struct wrapping an object reference travels like a pointer. The divergence is specific to floating-point fields (and, as shown below, to multi-field structs), because only floating-point values have a separate register file the ABI can choose to skip.

## The real bug: wrapper types in P/Invoke signatures

The performance difference is a footnote. The correctness difference is not. If you use a strongly typed wrapper in a `LibraryImport` or `DllImport` signature whose native counterpart takes the underlying primitive, you are asserting that the wrapper is transparent. The marshaller does not check that, because the struct is blittable and gets passed as-is.

Here is a repro against the `abi.c` library above:

```csharp
// .NET 11 RC1, C# 15
using System.Runtime.InteropServices;

Console.WriteLine($"{RuntimeInformation.ProcessArchitecture} / {RuntimeInformation.FrameworkDescription}");
Console.WriteLine($"take_double(Meters 21)  = {Native.TakeDoubleAsMeters(new Meters(21)).Value}");
Console.WriteLine($"take_two_floats(Vec2)   = {Native.TakeTwoFloatsAsVec2(new Vec2(1f, 2f))}");
Console.WriteLine($"take_two_floats(f, f)   = {Native.TakeTwoFloats(1f, 2f)}");

public readonly record struct Meters(double Value);
public readonly record struct Vec2(float X, float Y);

static partial class Native
{
    // Wrong on purpose: the C side is double take_double(double)
    [LibraryImport("libabi", EntryPoint = "take_double")]
    public static partial Meters TakeDoubleAsMeters(Meters m);

    // Wrong on purpose: the C side is float take_two_floats(float, float)
    [LibraryImport("libabi", EntryPoint = "take_two_floats")]
    public static partial float TakeTwoFloatsAsVec2(Vec2 v);

    [LibraryImport("libabi", EntryPoint = "take_two_floats")]
    public static partial float TakeTwoFloats(float x, float y);
}
```

On macOS arm64:

```text
take_double(Meters 21)  = 42
take_two_floats(Vec2)   = 3
take_two_floats(f, f)   = 3
```

Everything "works". `Meters` is an HFA of one `double`, `Vec2` is an HFA of two `float`s, and AAPCS64 puts them in `D0` and `S0`/`S1`, exactly where the native code looks.

On macOS x64 (System V), same binary, same library:

```text
take_double(Meters 21)  = 42
take_two_floats(Vec2)   = 1
take_two_floats(f, f)   = 3
```

`Meters` still works, because a single SSE eightbyte goes in `XMM0`. `Vec2` does not: System V packs both floats into one eightbyte, so the whole struct arrives in the low 64 bits of `XMM0`. The native function reads `x` from `XMM0` and `y` from `XMM1`, which holds whatever was left there. In this run that happened to be zero, so the answer was `1`. In another run it might be anything.

On Windows x64, both wrong declarations break. `Meters` goes in `RCX` while `take_double` reads `XMM0`, and the result is read back from `RAX` while the native code wrote `XMM0`. `Vec2` (8 bytes) also goes in `RCX`. You can confirm the native side from the `x86_64-pc-windows-msvc` listing above; the managed side follows the same rule the `ScaleMeters` disassembly shows.

This is the classic "works on my Mac, garbage on the Windows build agent" bug. Code reviewed and tested on ARM64 laptops passes, and the first Windows x64 run produces nonsense or a value that is subtly off.

## How to write wrapper types that are safe at every boundary

There is no attribute in .NET 11 that makes a struct transparent. `[StructLayout(LayoutKind.Sequential)]`, `Pack`, and `Size` all control memory layout, not register classification. So the fix is to keep wrappers on the managed side of the boundary.

1. **Declare native signatures with the exact native types.** If C takes `double`, the P/Invoke takes `double`. Wrap and unwrap in a thin managed method:

    ```csharp
    // .NET 11 RC1, C# 15
    static partial class Native
    {
        [LibraryImport("libabi", EntryPoint = "take_double")]
        private static partial double TakeDouble(double d);

        public static Meters Scale(Meters m) => new(TakeDouble(m.Value));
    }
    ```

    The wrapper method gets inlined, so you pay nothing for the type safety.

2. **Only use a struct in a P/Invoke when the native side uses a struct with the same fields.** If the C header says `Vec2 v`, a C# `Vec2` with the same fields in the same order is correct on every ABI, because both sides apply the same classification. The bug is only ever a struct on one side and loose scalars on the other.

3. **Treat function pointers and `UnmanagedCallersOnly` the same way.** A `delegate* unmanaged<Meters, Meters>` has the same problem as a `LibraryImport`, and so does an `[UnmanagedCallersOnly]` export that a native host calls with a `double`. If you build Node addons or plugin hosts that way, as in [writing Node.js addons with .NET Native AOT](/2026/04/nodejs-addons-dotnet-native-aot/), keep the exported signatures primitive.

4. **For hot managed paths on Windows x64, check whether the call is inlined before worrying.** If a profiler points at a non-inlined method that takes or returns a floating-point wrapper, look at the disassembly. Rider's [ASM viewer for JIT and Native AOT disassembly](/2026/04/rider-2026-1-asm-viewer-jit-nativeaot-disassembly/) or `DOTNET_JitDisasm` will show the `vmovq` pair. You can then pass the primitive across the hot boundary, or restructure so the call inlines.

## Gotchas and edge cases

- **Two floats are not one double.** Many people assume "8 bytes is 8 bytes". `Vec2(float, float)` is 8 bytes, but it is one SSE eightbyte on System V, an HFA of two on ARM64, and an integer-sized blob on Windows x64. Three ABIs, three answers. This is the case that bites cross-platform game and graphics code most often.
- **Mixed fields change classification again.** A `struct { int Id; float Weight; }` is 8 bytes. On System V it becomes one INTEGER-class eightbyte (integer wins when an eightbyte mixes classes) and goes in `RDI`. On ARM64 it is not an HFA, so it goes in `X0`. On Windows x64, `RCX`. None of those match passing an `int` and a `float` separately.
- **Size matters on Windows x64.** Only 1, 2, 4, and 8-byte structs are passed by value in a register. A 12-byte or 16-byte struct is passed by reference to a caller-allocated copy, which is a much larger change from passing its fields individually. On System V and ARM64, structs up to 16 bytes still go in registers.
- **Instance methods on C++ classes are different again.** MSVC returns user-defined types from non-static member functions through a hidden pointer even when they would fit in `RAX`. This is why `CallConvMemberFunction` exists in `System.Runtime.CompilerServices`, and why COM methods returning small structs are a known trap.
- **Struct promotion hides the cost, it does not remove it.** Inside a method the JIT replaces a promoted struct with its field, so local arithmetic on `Meters` is as fast as on `double`. Promotion does not change how the value crosses a call. If you are weighing structs against classes for value objects, the [record vs class vs struct decision matrix](/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/) covers the size and copying side of that trade-off.
- **ReadyToRun and Native AOT use the same rules.** Precompiled code still has to agree with the platform ABI, so publishing with [Native AOT or ReadyToRun](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) does not make a wrapper transparent. The crossgen2 output in this post is ReadyToRun code.

## Will .NET get a real transparent layout?

Not in .NET 11. The closest thing on the roadmap is the [interop struct layout proposal in dotnet/runtime#100896](https://github.com/dotnet/runtime/issues/100896), which approved a `CustomLayoutAttribute` with layout kinds for C-style structs, unions, and Swift types. The issue explicitly mentions requests for a mechanism like Rust's `repr(transparent)`, but the approved shape does not include one, and the issue was moved from the 11.0.0 milestone to 12.0.0 in July 2026. If a transparent kind ever ships, it would let the JIT and the marshaller classify a single-field wrapper as its field on every ABI, which is exactly what [Rust's RFC 1758](https://rust-lang.github.io/rfcs/1758-repr-transparent.html) does for its newtypes.

Until then, the rule is short: wrappers are free in memory and free after inlining, but at an ABI boundary they are aggregates, and only the platform decides whether that matters. Keep them out of native signatures, and if you have to pass them across a hot non-inlined call on Windows x64, read the disassembly first.

## Related

- [Record vs class vs struct in C#: a decision matrix](/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/) for choosing the shape of a value type in the first place.
- [Rider 2026.1's ASM viewer for JIT and Native AOT disassembly](/2026/04/rider-2026-1-asm-viewer-jit-nativeaot-disassembly/), the easiest way to see the `vmovq` pair yourself.
- [Native AOT vs ReadyToRun vs JIT in .NET 11](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) for how the three code generation modes differ, and where they do not.
- [Polars.NET and LibraryImport](/2026/02/dotnet-polarsnet-rust-dataframe-engine-with-libraryimport/) for a real Rust-backed library that has to get these signatures right.
- [Node.js addons with .NET Native AOT](/2026/04/nodejs-addons-dotnet-native-aot/), where `UnmanagedCallersOnly` exports face the same rule in reverse.

## Sources

- [x64 calling convention](https://learn.microsoft.com/en-us/cpp/build/x64-calling-convention), Microsoft C++ docs, for the Windows x64 aggregate and return-value rules.
- [System V AMD64 ABI](https://gitlab.com/x86-psABIs/x86-64-ABI), section 3.2.3, for eightbyte classification.
- [Procedure Call Standard for the Arm 64-bit Architecture (AAPCS64)](https://github.com/ARM-software/abi-aa/blob/main/aapcs64/aapcs64.rst), for the HFA rule.
- [dotnet/runtime#100896: New attribute for interop-specific struct concerns](https://github.com/dotnet/runtime/issues/100896).
- [dotnet/runtime#43867: Keep structs in registers](https://github.com/dotnet/runtime/issues/43867), the JIT tracking issue for single-field struct handling.
- [Rust RFC 1758: repr(transparent)](https://rust-lang.github.io/rfcs/1758-repr-transparent.html).
