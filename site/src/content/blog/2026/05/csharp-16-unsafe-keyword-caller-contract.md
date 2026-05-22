---
title: "C# 16 Reworks unsafe Into a Caller Contract"
description: "C# 16 redesigns the unsafe keyword so it propagates a caller obligation instead of silently opening an unsafe context, with inner unsafe blocks now mandatory."
pubDate: 2026-05-22
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "memory-safety"
---

Richard Lander [laid out a redesign](https://devblogs.microsoft.com/dotnet/improving-csharp-memory-safety/) of the `unsafe` keyword that changes what it means after 25 years. Today `unsafe` marks an implementation detail: you flip a method or block into an unsafe context, write your pointer code, and nobody calling that method has any idea they are touching memory-unsafe code. The new model, targeting **C# 16** as a preview in **.NET 11** and production in **.NET 12**, turns `unsafe` into a caller-facing contract. The motivation is partly the rise of AI-generated code: a safety obligation that exists only as a convention is invisible to a reviewer and to the model writing the code.

## What the keyword means now

Under the current rules, marking a method `unsafe` does two unrelated jobs at once: it lets you write pointer operations inside, and it requires nothing of callers. The redesign splits those apart.

`unsafe` on a member signature becomes a propagating contract. Callers must wrap the invocation in an `unsafe { }` block, the same way you must wrap a `pointer` dereference. And inside an `unsafe` method, the unsafe operations themselves still need an explicit inner block. No more free pass:

```csharp
/// <safety>
/// The sum of <paramref name="ptr"/> and <paramref name="ofs"/> must address
/// a byte the caller is permitted to read.
/// </safety>
public static unsafe byte ReadByte(IntPtr ptr, int ofs)
{
    // SAFETY: relies on caller obligation.
    unsafe { return ((byte*)ptr)[ofs]; }
}
```

The `/// <safety>` doc block is the formal place to write down the obligation, and an analyzer flags `unsafe` members that are missing one.

## Discharging the obligation

A method that calls an `unsafe` API has two choices: keep propagating by being `unsafe` itself, or become a safe boundary by validating the precondition and then wrapping the call.

```csharp
void Caller2()
{
    if (!ObligationSatisfied()) throw new InvalidOperationException();
    unsafe { ReadByte(ptr, ofs); } // the guard discharges the contract
}
```

That is the whole point: the `unsafe` block is where you assert "I have checked the precondition," so it should be small and deliberate, not wrapped around a whole method.

## Smaller surface, stricter default

A few other rules tighten the model. The `unsafe` type modifier is gone, so unsafety lives only on methods, properties, and fields. Pointer types no longer make a signature unsafe on their own; passing a `byte*` is fine, dereferencing it is the unsafe act. And `extern` declarations get a new `safe` modifier to attest that a P/Invoke is safe to call:

```csharp
[LibraryImport("libc")]
internal static safe partial int getpid();
```

Project configuration splits too. The existing `<AllowUnsafeBlocks>` still gates whether the `unsafe` keyword compiles at all, while a new opt-in property selects the C# 16 model of what counts as unsafe. Omit both and you get the strictest posture.

None of this makes pointer code safe by itself. As Lander puts it, the keywords "aren't the safety; they're the scaffolding that gets developers to articulate and honor it." If you maintain a library with pointer-heavy hot paths, the preview is the time to start writing `<safety>` blocks, because in .NET 12 your callers will be the ones forced to wrap your APIs.
