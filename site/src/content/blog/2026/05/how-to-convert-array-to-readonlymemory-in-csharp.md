---
title: "How to convert T[] to ReadOnlyMemory<T> in C# (implicit operator and explicit constructor)"
description: "Three ways to wrap a T[] in a ReadOnlyMemory<T> in .NET 11: the implicit conversion, the explicit constructor, and AsMemory(). When each is the right call."
pubDate: 2026-05-04
tags:
  - "csharp"
  - "dotnet"
  - "performance"
  - "memory"
template: "how-to"
---

If you just want a `ReadOnlyMemory<T>` view over an existing array, the shortest path is the implicit conversion: `ReadOnlyMemory<byte> rom = bytes;`. If you need a slice, prefer `bytes.AsMemory(start, length)` or `new ReadOnlyMemory<byte>(bytes, start, length)`. All three are zero-allocation, but only the constructor and `AsMemory` accept an offset and length, and only the constructor is explicit at the call site (which matters in code review).

Versions referenced in this post: .NET 11 (runtime), C# 14. `System.Memory` ships as part of `System.Runtime` in modern .NET, so no extra package is needed.

## Why there is more than one conversion path

`ReadOnlyMemory<T>` has been in the BCL since .NET Core 2.1 (and the `System.Memory` NuGet package on .NET Standard 2.0). Microsoft added several entry points on purpose: a frictionless one for the 90% case, an explicit constructor for code that needs to call out the conversion, and an extension method that mirrors `AsSpan()` so you can swap between span and memory mentally without context-switching.

Concretely, the BCL exposes:

1. An implicit conversion `T[]` to `Memory<T>` and `T[]` to `ReadOnlyMemory<T>`.
2. An implicit conversion `Memory<T>` to `ReadOnlyMemory<T>`.
3. The constructor `new ReadOnlyMemory<T>(T[])` and the slicing overload `new ReadOnlyMemory<T>(T[] array, int start, int length)`.
4. The extension methods `AsMemory<T>(this T[])`, `AsMemory<T>(this T[], int start)`, `AsMemory<T>(this T[], int start, int length)`, and `AsMemory<T>(this T[], Range)` defined on `MemoryExtensions`.

Every path is allocation-free. The choice is mostly stylistic, with two real distinctions: only the constructor and `AsMemory` accept a slice, and only the implicit conversion lets a `T[]` argument flow into a `ReadOnlyMemory<T>` parameter without the caller writing anything.

## The minimal example

```csharp
// .NET 11, C# 14
using System;

byte[] payload = "hello"u8.ToArray();

// Path 1: implicit operator
ReadOnlyMemory<byte> a = payload;

// Path 2: explicit constructor, full array
ReadOnlyMemory<byte> b = new ReadOnlyMemory<byte>(payload);

// Path 3: explicit constructor, slice
ReadOnlyMemory<byte> c = new ReadOnlyMemory<byte>(payload, start: 1, length: 3);

// Path 4: AsMemory extension, full array
ReadOnlyMemory<byte> d = payload.AsMemory();

// Path 5: AsMemory extension, slice with start + length
ReadOnlyMemory<byte> e = payload.AsMemory(start: 1, length: 3);

// Path 6: AsMemory extension, range
ReadOnlyMemory<byte> f = payload.AsMemory(1..4);
```

All six produce `ReadOnlyMemory<byte>` instances that point into the same backing array. None of them copy the array. All six are safe in tight loops because the cost is a small struct copy, not a buffer copy.

## When the implicit operator is the right call

The implicit conversion `T[]` to `ReadOnlyMemory<T>` is the cleanest at call sites where the destination type is already a `ReadOnlyMemory<T>` parameter:

```csharp
// .NET 11
public Task WriteAsync(ReadOnlyMemory<byte> data, CancellationToken ct = default)
{
    // ...
    return Task.CompletedTask;
}

byte[] payload = GetPayload();
await WriteAsync(payload); // implicit conversion happens here
```

You do not write `payload.AsMemory()` or `new ReadOnlyMemory<byte>(payload)`. The compiler emits the conversion for you. This matters in two ways: the call site stays readable in hot code, and your API can take `ReadOnlyMemory<T>` without forcing every caller to learn a new type.

The trade-off is that the conversion is invisible. If you want a code reviewer to notice "this code is now passing a `ReadOnlyMemory<T>` view rather than an array", the implicit operator hides that.

## When the constructor is worth its verbosity

`new ReadOnlyMemory<byte>(payload, start, length)` is the explicit form. You reach for it in three situations:

1. **You need a slice with offset and length.** The implicit conversion always covers the whole array.
2. **You want the call site to make the conversion visible.** A field like `private ReadOnlyMemory<byte> _buffer;` initialised by the constructor is easier to grep for than an implicit operator.
3. **You want the compiler to bounds-check the offset and length once, at construction.** All paths bounds-check eventually, but the constructor accepts `start` and `length` as parameters and throws `ArgumentOutOfRangeException` immediately if they fall outside the array, before any consumer touches the memory.

```csharp
// .NET 11
byte[] frame = ReceiveFrame();
const int headerLength = 16;

// Skip the header. Bounds-checked here, not when the consumer reads.
var payload = new ReadOnlyMemory<byte>(frame, headerLength, frame.Length - headerLength);

await ProcessAsync(payload);
```

If `frame.Length < headerLength`, the `ArgumentOutOfRangeException` is thrown at the construction site, where the local variables are still in scope and a debugger can show you what `frame.Length` actually was. If you defer the slicing into `ProcessAsync`, you lose that locality and the failure shows up wherever the slice is finally materialised.

## When to use `AsMemory()` instead

`AsMemory()` is the same thing as the constructor, with two ergonomic upsides: it reads left-to-right (`payload.AsMemory(1, 3)` rather than `new ReadOnlyMemory<byte>(payload, 1, 3)`), and it has a `Range` overload, so C#'s slicing syntax works:

```csharp
// .NET 11, C# 14
byte[] payload = GetPayload();
const int headerLength = 16;

ReadOnlyMemory<byte> body = payload.AsMemory(headerLength..);
ReadOnlyMemory<byte> first16 = payload.AsMemory(..headerLength);
ReadOnlyMemory<byte> middle = payload.AsMemory(8..24);
```

`AsMemory(Range)` returns `Memory<T>`, and the cast to `ReadOnlyMemory<T>` here goes through the `Memory<T>` to `ReadOnlyMemory<T>` implicit conversion. That is also allocation-free.

If you have already mentally adopted `AsSpan()` (the same pattern for `Span<T>`), `AsMemory()` is the version of that habit that survives across an `await`.

## What happens with `null` arrays

Passing a `null` array to the implicit conversion or `AsMemory()` does not throw. It produces a default `ReadOnlyMemory<T>`, which is equivalent to `ReadOnlyMemory<T>.Empty` semantically (`IsEmpty == true`, `Length == 0`):

```csharp
// .NET 11
byte[]? maybeNull = null;

ReadOnlyMemory<byte> a = maybeNull;            // default, not a NullReferenceException
ReadOnlyMemory<byte> b = maybeNull.AsMemory(); // also default
// new ReadOnlyMemory<byte>(maybeNull) also returns default
```

The single-argument constructor `new ReadOnlyMemory<T>(T[]? array)` documents this explicitly: a null reference produces a default-valued `ReadOnlyMemory<T>`. The three-argument `new ReadOnlyMemory<T>(T[]? array, int start, int length)` does throw `ArgumentNullException` if the array is null and you specify a non-zero start or length, because the bounds cannot be satisfied against `null`.

This `null` tolerance is convenient for optional payloads but it is also a footgun: a caller who passes `null` will silently get an empty buffer rather than a crash, which can mask a bug upstream. If your method depends on the array being non-null, validate before you wrap.

## Slicing the result is also free

Once you have a `ReadOnlyMemory<T>`, calling `.Slice(start, length)` produces another `ReadOnlyMemory<T>` over the same backing storage. There is no second copy and no second allocation:

```csharp
// .NET 11
ReadOnlyMemory<byte> all = payload.AsMemory();

ReadOnlyMemory<byte> head = all.Slice(0, 16);
ReadOnlyMemory<byte> body = all.Slice(16);
```

The `ReadOnlyMemory<T>` struct stores a reference to the original `T[]` (or a `MemoryManager<T>`), an offset within that storage, and a length. Slicing just returns a new struct with adjusted offset and length. This is why all six conversion paths above are safe to use even in tight loops: the cost is a struct copy, not a buffer copy.

## Going from `ReadOnlyMemory<T>` back to a `Span<T>`

Inside a synchronous method you usually want a span, not a memory:

```csharp
// .NET 11
public int CountZeroBytes(ReadOnlyMemory<byte> data)
{
    ReadOnlySpan<byte> span = data.Span; // allocation-free
    int count = 0;
    foreach (byte b in span)
    {
        if (b == 0) count++;
    }
    return count;
}
```

`.Span` is a property on `ReadOnlyMemory<T>` that returns a `ReadOnlySpan<T>` over the same memory. Use the span for the inner loop, keep the memory in fields and across `await` boundaries. The inverse (span to memory) is intentionally not provided because spans can live on the stack, where a `Memory<T>` cannot reach.

## What you cannot do (and the workarounds)

`ReadOnlyMemory<T>` is genuinely read-only as far as the public API is concerned. There is no public `ToMemory()` that returns the underlying mutable `Memory<T>`. The escape hatch lives in `MemoryMarshal`:

```csharp
// .NET 11
using System.Runtime.InteropServices;

ReadOnlyMemory<byte> ro = payload.AsMemory();
Memory<byte> rw = MemoryMarshal.AsMemory(ro);
```

This is unsafe in the sense of "the type system was telling you something". Only reach for it when you are sure no other consumer relies on the read-only contract you just broke, for example in a unit test or in code that owns the buffer end-to-end.

`ReadOnlyMemory<T>` also cannot point into a `string` via the array-conversion paths. `string.AsMemory()` returns a `ReadOnlyMemory<char>` that wraps the string itself, not a `T[]`. The conversion paths from `T[]` covered above do not apply to strings, but the rest of the API surface (slicing, `Span`, equality) behaves identically.

## Picking one in your codebase

A reasonable default in a .NET 11 codebase:

- **In API signatures**: take `ReadOnlyMemory<T>`. Callers with a `T[]` will pass it as is (implicit operator), callers with a slice will pass `array.AsMemory(start, length)`. You give up nothing.
- **At call sites with a full array**: use the implicit conversion, do not write `.AsMemory()`. It is noise.
- **At call sites with a slice**: use `array.AsMemory(start, length)` or `array.AsMemory(range)`. Avoid `new ReadOnlyMemory<T>(array, start, length)` unless the explicitness at the call site is the actual point.
- **In hot paths**: it does not matter for performance. The JIT lowers all six paths to the same struct construction. Pick whichever reads best.

## Related

- [How to use `SearchValues<T>` correctly in .NET 11](/2026/04/how-to-use-searchvalues-correctly-in-dotnet-11/) for span-friendly searching that pairs naturally with `ReadOnlyMemory<T>.Span`.
- [How to use Channels instead of `BlockingCollection` in C#](/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) when you want async pipelines that pass `ReadOnlyMemory<T>` payloads around.
- [How to use `IAsyncEnumerable<T>` with EF Core 11](/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) for streaming patterns that combine well with memory views.
- [How to read a large CSV in .NET 11 without running out of memory](/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) which leans heavily on slicing without copying.
- [How to use the new `System.Threading.Lock` type in .NET 11](/2026/04/how-to-use-the-new-system-threading-lock-type-in-dotnet-11/) for the synchronisation primitive you will want around mutable `Memory<T>` shared between threads.

## Sources

- [`ReadOnlyMemory<T>` reference (MS Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.readonlymemory-1)
- [`MemoryExtensions.AsMemory` reference (MS Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.memoryextensions.asmemory)
- [Memory<T> and Span<T> usage guidelines (MS Learn)](https://learn.microsoft.com/en-us/dotnet/standard/memory-and-span/)
- [`MemoryMarshal.AsMemory` reference (MS Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.memorymarshal.asmemory)
