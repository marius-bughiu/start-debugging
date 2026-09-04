---
title: "What is the W^X flag in .NET and does Native AOT need it?"
description: "W^X (write xor execute) is the rule that no memory page is writable and executable at the same time. In .NET it is the DOTNET_EnableWriteXorExecute knob, on by default since .NET 7, and it exists entirely for the JIT. Native AOT never reads it. Here is how the runtime implements it, what it costs, and when turning it off is a legitimate fix."
pubDate: 2026-09-04
tags:
  - "dotnet"
  - "native-aot"
  - "jit"
  - "performance"
  - "security"
  - "dotnet-11"
---

W^X ("write xor execute") is a memory-protection policy: any given page of memory may be writable or executable, never both at once. In .NET it is exposed as the `DOTNET_EnableWriteXorExecute` knob, and its default has been `1` since .NET 7. The premise buried in the usual phrasing of this question is backwards, so let us fix it up front: Native AOT does not need the W^X flag, and does not read it. The flag configures CoreCLR's executable allocator, which exists to serve the JIT. Native AOT has no JIT and no executable allocator. The real relationship runs the other direction: platforms that enforce W^X unconditionally (iOS, tvOS) make JIT compilation impossible, and Native AOT is the answer to that constraint rather than a consumer of the flag.

Everything below targets `<TargetFramework>net11.0</TargetFramework>` with the .NET 11 SDK, but the mechanics have been stable since .NET 7. Where a behaviour depends on a specific version, I say so.

## Why a page being both writable and executable is a problem

The classic memory-corruption exploit has two halves: get attacker-controlled bytes into the process, then get the CPU to jump to them. If every page in the process is either writable or executable, the second half stops working. The bytes you wrote live on a page the CPU refuses to execute, and the pages the CPU will execute are pages you cannot write to. The policy came out of OpenBSD in 2003 and is now table stakes: Windows calls its version DEP, Linux relies on the NX bit plus the loader's page permissions, and Apple silicon enforces it at the kernel level for every process.

For ordinary compiled code this is free. The loader maps your `.text` section read-execute and your `.data` section read-write, and nothing ever needs to change. The awkward case is a runtime that generates machine code while the program is running.

## Why the JIT is the awkward case

A JIT compiler writes machine code bytes into memory and then calls into them. The naive implementation allocates a page RWX, writes, and jumps. That is exactly the shape W^X is designed to forbid, and it hands an attacker a page that is guaranteed to be both writable and executable at a stable-ish address.

The obvious fix is to allocate the page read-write, emit the code, then `mprotect` it to read-execute. That is not sufficient for CoreCLR, for two reasons. First, there is a window where the page is writable and its address is already known. Second, and more importantly, the runtime does not just write code once. It patches it continuously: call-counting stubs get rewritten when a method crosses the tiering threshold, [tiered compilation](/2026/07/what-is-tiered-compilation-and-how-do-i-reason-about-it/) swaps tier 0 code for tier 1 code, virtual stub dispatch cells get backpatched as monomorphic call sites resolve. Flipping a page RW and back to RX on every patch is both slow and racy across threads.

## How CoreCLR actually implements it: double mapping

CoreCLR's answer is to create two virtual mappings of the same physical memory. One mapping is read-execute and is what the CPU runs. The other is read-write and is what the runtime writes through. No single virtual address is ever both, so the policy holds, but the runtime can still patch code without changing any page permission.

The plumbing is `ExecutableAllocator` and the RAII helper `ExecutableWriterHolder` in `src/coreclr/inc/executableallocator.h`. Every place in the VM that wants to modify code takes a writer holder, writes through `holder.GetRW()`, and lets the destructor drop the writable view. The backing store is created in `src/coreclr/minipal/Unix/doublemapping.cpp`, which on Linux does:

```c
// dotnet/runtime, src/coreclr/minipal/Unix/doublemapping.cpp
int fd = memfd_create("doublemapper", MFD_CLOEXEC);
```

On FreeBSD it uses `shm_open(SHM_ANON, ...)`, and on other Unix systems it falls back to a POSIX shared memory object named `/shm-dotnet-<pid>` that is immediately `shm_unlink`ed. That memfd is the piece you can actually observe from outside the process:

```bash
# Linux, .NET 11. Count the double mappings in a running .NET process.
grep -c doublemapper /proc/$(pgrep -n MyApp)/maps
```

Apple platforms take a different route. `CreateDoubleMemoryMapper` returns early on Apple with no file descriptor at all, because macOS on arm64 provides a per-thread mechanism instead: pages allocated with `MAP_JIT` can be toggled between writable and executable for the calling thread only, via `pthread_jit_write_protect_np`. The runtime wraps that as `PAL_JitWriteProtect`, and on `HOST_APPLE && HOST_ARM64` the writer holder simply hands back the same address rather than a second mapping:

```cpp
// dotnet/runtime, executableallocator.h, Apple arm64 path
m_addressRW = addressRX;
PAL_JitWriteProtect(true);
```

That per-thread scoping is the part people miss: on Apple silicon the write permission belongs to a thread, not to the page, which is why you must never let one thread write a region while another executes it.

## The flag, and how to set it

The knob is declared once, in `src/coreclr/inc/clrconfigvalues.h`:

```cpp
// dotnet/runtime, src/coreclr/inc/clrconfigvalues.h
RETAIL_CONFIG_DWORD_INFO(EXTERNAL_EnableWriteXorExecute, W("EnableWriteXorExecute"), 1,
                         "Enable W^X for executable memory.");
```

Default `1` on every architecture except `TARGET_RISCV64`, where the same declaration ships a default of `0`. It became the default in [PR #69672](https://github.com/dotnet/runtime/pull/69672), merged in May 2022 for .NET 7. Before that, .NET 6 shipped it on by default only for macOS arm64 (where the OS gives you no choice) and opt-in everywhere else, exactly as the [.NET 6 announcement](https://devblogs.microsoft.com/dotnet/announcing-net-6/) promised.

There are two ways to set it. The environment variable works everywhere:

```bash
# Disables W^X for this process only. .NET 7 and later.
DOTNET_EnableWriteXorExecute=0 ./MyApp
```

From .NET 9 onward you can also put it in `runtimeconfig.json`, thanks to [PR #101490](https://github.com/dotnet/runtime/pull/101490):

```json
{
  "configProperties": {
    "System.Runtime.EnableWriteXorExecute": 0
  }
}
```

In an SDK-style project, express that as an MSBuild item so it survives a rebuild:

```xml
<!-- .NET 9 and later. Ignored by .NET 8 and earlier, which need the env var. -->
<ItemGroup>
  <RuntimeHostConfigurationOption Include="System.Runtime.EnableWriteXorExecute" Value="0" />
</ItemGroup>
```

The runtimeconfig path was never backported to .NET 8; the request in [issue #103340](https://github.com/dotnet/runtime/issues/103340) was closed as not planned. On .NET 8 the environment variable is your only option. And note the .NET 9 precedence change: environment variables now win over `runtimeconfig.json`, so a stray `DOTNET_EnableWriteXorExecute` in a container image will silently override your project setting.

## What it costs

This is not a free mitigation, and the runtime team measured it before shipping it on. The numbers in [PR #69672](https://github.com/dotnet/runtime/pull/69672) across the ASP.NET plaintext, json, fortunes, and orchard benchmarks on x64 Windows, x64 Linux, and arm64 Linux were a 5 to 10 percent startup regression, with follow-up analysis putting time-to-first-request at roughly 10 percent worse. Steady state showed no measurable difference, which makes sense: once the hot methods are jitted and patched, the executable allocator stops being on any path that matters.

The first shipped version was worse than that in JIT-heavy workloads. [PR #74526](https://github.com/dotnet/runtime/pull/74526) tracked a regression in regex tests that turned out to be driven by jitting roughly 50,000 methods, each of which allocated and released a fresh writable mapping. Caching the most recently used writable mapping instead of unmapping it eagerly fixed that completely, and shipped in .NET 7 alongside the default flip. If you are benchmarking startup on .NET 7 or later, you already have that fix.

The practical read: W^X costs you startup, not throughput. That matters for short-lived processes and cold starts, and matters much less for a long-running server. It is the same axis that [Native AOT versus ReadyToRun versus plain JIT](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) trades along.

## Where Native AOT actually sits

Now the part the question gets backwards. Native AOT publishes a binary whose code is fully compiled at build time and mapped read-execute by the OS loader, exactly like a C program. There is no JIT, no tiering, no stub backpatching, and therefore no `ExecutableAllocator`. Grep the Native AOT runtime under `src/coreclr/nativeaot/Runtime` and you will not find `EnableWriteXorExecute` anywhere. Setting the flag against a Native AOT binary does nothing at all: the knob is a CoreCLR VM config value, and the Native AOT runtime is a different, much smaller runtime that never reads CLR config.

You can confirm the absence of runtime code generation from managed code:

```csharp
// .NET 11, C# 14. Prints False under Native AOT, True under CoreCLR.
using System.Runtime.CompilerServices;

Console.WriteLine(RuntimeFeature.IsDynamicCodeCompiled);
```

That is not quite the same as saying Native AOT allocates no executable memory at runtime. It allocates a little, for one specific reason: marshalled delegates. When you hand a managed instance delegate to native code as a function pointer, the target address has to encode which delegate instance to invoke, and that cannot be baked into the image because the instance does not exist at build time. The runtime materialises a small thunk per delegate:

```csharp
// .NET 11, C# 14. This is the call that forces a runtime-allocated thunk.
using System.Runtime.InteropServices;

Action<int> callback = Console.WriteLine;
nint fnPtr = Marshal.GetFunctionPointerForDelegate(callback);
// fnPtr points at a thunk allocated from a thunk pool, not at compiled image code.
GC.KeepAlive(callback);
```

Those thunks come from `PalAllocateThunksFromTemplate`, whose signature in `src/coreclr/nativeaot/Runtime/unix/PalUnix.cpp` is:

```cpp
UInt32_BOOL PalAllocateThunksFromTemplate(HANDLE hTemplateModule, uint32_t templateRva,
                                          size_t templateSize, void** newThunksOut);
```

The design, added for iOS-like platforms in [PR #82317](https://github.com/dotnet/runtime/pull/82317), never produces an RWX page. On Apple targets it reserves two adjacent ranges with `vm_allocate`, then uses `vm_remap` with `VM_FLAGS_FIXED | VM_FLAGS_OVERWRITE` to map the already-compiled template code page from the loaded image into the executable half, while the writable half holds only the per-thunk *data* (the target address and the delegate handle). The code is never written at runtime, only pointed at. That is W^X compliance by construction rather than by policy, which is precisely why it works on a platform that offers no escape hatch.

`PalVirtualAlloc` in the same file does pass `MAP_JIT` when allocating executable memory on macOS arm64, since the kernel demands it there.

## The direction the causation actually runs

Apple does not let a third-party App Store app map memory RWX or flip a page to executable after writing to it. There is no entitlement that changes this for shipping apps. That single constraint eliminates JIT compilation, and with it Mono's JIT mode, CoreCLR's tiering, and hot reload of compiled code. It is the same wall Flutter hits, which is why a [Flutter iOS debug build fails with mprotect permission denied](/2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build/) on recent iOS versions while release builds, which are fully AOT compiled, are unaffected.

So the accurate framing is: iOS enforces W^X, W^X forbids JIT, and Native AOT is how .NET ships code to a platform that forbids JIT. Native AOT has supported iOS-like platforms since .NET 9, and is the default compilation mode for .NET MAUI release builds on iOS and Mac Catalyst. Nothing in that chain involves the `EnableWriteXorExecute` flag, which only ever governed how CoreCLR's JIT gets its bytes into memory on platforms that would otherwise have let it be sloppy.

## When turning it off is a legitimate fix

W^X is a defence-in-depth mitigation. Disabling it is a real reduction in your process's security posture, so treat `DOTNET_EnableWriteXorExecute=0` as a diagnosis tool first and a permanent setting only with a reason. These are the reasons that hold up:

**Profiling JIT-compiled frames with Linux `perf`.** The runtime writes its perf map using the address of the RW mapping, not the RX mapping the CPU actually executes, so JIT frames resolve to the wrong symbols or to nothing. This has been open since July 2022 as [issue #71786](https://github.com/dotnet/runtime/issues/71786) and is still parked in the Future milestone. If you need a usable `perf` profile of jitted code, disable W^X for that run. For everyday profiling, prefer [dotnet-trace, which reads its own rundown events](/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) and is unaffected.

**Growing `/memfd:doublemapper (deleted)` entries.** [Issue #89776](https://github.com/dotnet/runtime/issues/89776) reports these mappings accumulating on Linux (they are released on macOS but not on Linux), which shows up as climbing mapping counts and virtual memory in a long-lived service. On ARM32 the same mechanism has been reported as an outright leak causing OOM kills in [issue #121455](https://github.com/dotnet/runtime/issues/121455). If your `/proc/<pid>/maps` is full of `doublemapper`, that is what you are looking at.

**`SIGXFSZ` under a file size rlimit.** The memfd is a file as far as the kernel is concerned, so a `ulimit -f` below the mapper's requested size kills the process with `SIGXFSZ`. That was [issue #117819](https://github.com/dotnet/runtime/issues/117819).

**Native debuggers setting breakpoints.** Writing an `int3` through the RX mapping instead of the RW one produced access violations, tracked in [issue #107444](https://github.com/dotnet/runtime/issues/107444). If you attach `lldb` or `gdb` to a .NET process and see faults on breakpoint insertion, disable W^X for the debugging session.

**Rosetta.** You do not need to do anything here. Double mapping has never worked correctly under Rosetta emulation ([issue #70910](https://github.com/dotnet/runtime/issues/70910)), and the runtime detects Rosetta and disables W^X for you.

What is not on that list is "my app starts slowly". If cold start is your problem, the flag buys you 5 to 10 percent while a proper fix, ReadyToRun or [Native AOT with its own cost ledger](/2026/06/what-is-native-aot-and-what-does-it-cost-you/), buys you far more and does not weaken the process. Reach for the flag when you have one of the concrete symptoms above, and put a comment next to it saying which one.

## Related

- [What is Native AOT and what does it cost you?](/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [Native AOT vs ReadyToRun vs plain JIT in .NET 11](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [What is tiered compilation and how do I reason about it?](/2026/07/what-is-tiered-compilation-and-how-do-i-reason-about-it/)
- [How to profile a .NET app with dotnet-trace and read the output](/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/)
- [Fix mprotect failed: Permission denied in a Flutter iOS debug build](/2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build/)

## Sources

- [W^X support, dotnet/runtime PR #54954](https://github.com/dotnet/runtime/pull/54954)
- [Enable W^X by default, dotnet/runtime PR #69672](https://github.com/dotnet/runtime/pull/69672)
- [Enable caching of writeable W^X mappings, dotnet/runtime PR #74526](https://github.com/dotnet/runtime/pull/74526)
- [Read EnableWriteXorExecute from runtimeConfig, dotnet/runtime PR #101490](https://github.com/dotnet/runtime/pull/101490)
- [NativeAOT thunk page generation and mapping for iOS-like platforms, PR #82317](https://github.com/dotnet/runtime/pull/82317)
- [clrconfigvalues.h, dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/coreclr/inc/clrconfigvalues.h)
- [doublemapping.cpp, dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/coreclr/minipal/Unix/doublemapping.cpp)
- [Announcing .NET 6, .NET Blog](https://devblogs.microsoft.com/dotnet/announcing-net-6/)
- [.NET Runtime config options, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/)
- [Native AOT support for iOS-like platforms, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/ios-like-platforms/)
- [pthread_jit_write_protect_np(3), Apple](https://keith.github.io/xcode-man-pages/pthread_jit_write_protect_np.3.html)
