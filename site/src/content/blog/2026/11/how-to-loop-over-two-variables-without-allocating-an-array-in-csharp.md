---
title: "How to loop over two variables in C# without allocating an array"
description: "foreach over (ReadOnlySpan<T>)[a, b] allocates nothing on .NET 8 and later and works for reference types, which stackalloc cannot do. On .NET 10 the compiler backs it with the BCL's InlineArray2<T>, and the JIT can even stack-allocate a plain new[] { a, b } once the method reaches Tier 1. Measured on .NET 10.0.10 and .NET 11 RC 3."
pubDate: 2026-11-07
tags:
  - "csharp"
  - "dotnet"
  - "performance"
  - "memory"
  - "span"
---

**Short answer:** write `foreach (Person p in (ReadOnlySpan<Person>)[p1, p2])`. Casting a collection expression to `Span<T>` or `ReadOnlySpan<T>` makes the C# compiler put the two references in an inline array on the stack, so the loop allocates 0 bytes, and it works for classes, which `stackalloc` refuses. If the loop body is more than a couple of lines, a `static` local function called twice is just as cheap and reads better. Avoid targeting `IEnumerable<T>` with `[p1, p2]`: that path allocates 72 bytes per loop. On .NET 10 and later the JIT also stack-allocates a plain `new Person[] { p1, p2 }` in many cases, but only after the method tiers up and only while the array does not escape, so don't count on it in code where it matters.

Everything below was compiled with C# 14 and measured on .NET 10.0.10 (SDK 10.0.302) and .NET 11.0.0-rc.3.26522.148 on an Apple M4 (macOS, arm64). The compiler-output checks also cover a `net8.0` build from the same source.

## Why `new[] { p1, p2 }` is the thing people try to avoid

The question comes up in this exact shape on [Stack Overflow](https://stackoverflow.com/questions/79984276): you have two objects in two variables, you want to run the same few statements against each, and the obvious loop creates a throwaway array:

```csharp
// .NET 10, C# 14
Person p1 = new("Ada");
Person p2 = new("Linus");

foreach (Person p in new Person[] { p1, p2 })
{
    p.DoSomething();
    p.DoMoreStuff();
}
```

A `Person[]` of length 2 is a heap object: 8 bytes of object header, 8 bytes of method table pointer, 8 bytes of length, and 8 bytes per reference on 64-bit, so 40 bytes. In a method that runs once per request that is noise. In a per-frame game loop, a parser inner loop, or anywhere you are trying to keep Gen0 collections at zero, it is the kind of allocation that shows up in a profiler.

The two things people reach for first both fail to compile:

```csharp
// .NET 10, C# 14
Span<Person> persons = stackalloc Person[] { p1, p2 };
// error CS0208: Cannot take the address of, get the size of,
// or declare a pointer to a managed type ('Person')

foreach (Person p in (p1, p2)) { }
// error CS1579: foreach statement cannot operate on variables of type
// '(Person p1, Person p2)' because '(Person p1, Person p2)' does not contain
// a public instance or extension definition for 'GetEnumerator'
```

`stackalloc` only accepts unmanaged element types, because the GC has no way to find object references inside a raw stack buffer. Tuples are not enumerable. That leaves five realistic options, and the numbers below show they are not all equal.

## The span collection expression: allocation-free and still a loop

Since C# 12, a collection expression can target `Span<T>` or `ReadOnlySpan<T>`, and the [collection expressions reference](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/operators/collection-expressions) says the storage "might be stack allocated" in that case. For a fixed number of non-constant elements, the compiler does exactly that, and it does it with an inline array rather than `stackalloc`, which is why reference types are fine:

```csharp
// .NET 8 or later, C# 12 or later
foreach (Person p in (ReadOnlySpan<Person>)[p1, p2])
{
    p.DoSomething();
    p.DoMoreStuff();
}
```

The cast is needed because `foreach` has no target type of its own; without it, `[p1, p2]` has nothing to convert to and the compiler reports CS9176 ("There is no target type for the collection expression"). A local works too:

```csharp
// .NET 8 or later, C# 12 or later
ReadOnlySpan<Person> people = [p1, p2];
foreach (Person p in people) { /* ... */ }
```

### What the compiler actually emits

An [inline array](/2023/08/c-12-inline-arrays/) is a struct marked `[InlineArray(N)]` with a single field that the runtime repeats N times. Because it is a struct, it lives in the method's stack frame, and because the runtime knows its layout, the GC can report the object references inside it. The compiler fills it, takes a span over it with `InlineArrayAsReadOnlySpan`, and hands that span to `foreach`, which compiles to a plain indexed loop.

Where that struct comes from depends on the target framework. I listed the type definitions and type references in the compiled assembly with `System.Reflection.Metadata`, building the same `Program.cs` for both frameworks:

```text
net8.0  build:  type definition  <>y__InlineArray2`1  [InlineArrayAttribute]  field: _element0
net10.0 build:  type reference   System.Runtime.CompilerServices.InlineArray2`1
```

On `net8.0` the compiler synthesizes a private `<>y__InlineArray2<T>` in your assembly. On `net10.0` it finds the public `System.Runtime.CompilerServices.InlineArray2<T>` that .NET 10 added to CoreLib and uses that instead, so nothing extra is emitted. The .NET 10 reference assemblies ship `InlineArray2<T>` through `InlineArray16<T>`. Either way the runtime behaviour is identical: one struct on the stack, zero heap bytes.

The `InlineArray` attribute itself is a .NET 8 runtime feature, so this inline-array lowering needs a .NET 8 or later target. Older targets were not tested for this post; on them, the struct enumerator or local function below is the safe choice.

### `Span<T>` or `ReadOnlySpan<T>`?

Both compile to the same code here and measured the same. Prefer `ReadOnlySpan<T>` because it states intent: you are iterating, not writing. Writing through a `Span<T>` only changes the copy in the inline array, never `p1` or `p2`, which matters for structs (see the gotchas below).

## A `params ReadOnlySpan<T>` helper for the same thing with a name

If the same per-item work runs on two items in several places, C# 13 [`params` collections](/2025/01/csharp-13-params-collections/) let you move the span to the call site:

```csharp
// .NET 9 or later, C# 13 or later
static int Each(params ReadOnlySpan<Person> people)
{
    int sum = 0;
    foreach (Person p in people)
    {
        p.DoSomething();
        sum += p.DoMoreStuff();
    }
    return sum;
}

int total = Each(p1, p2);   // also works with 3, 4, ... arguments
```

The call `Each(p1, p2)` is lowered to exactly the same inline-array-plus-span code as the explicit cast. That is the main point of [C# 13 removing `params` allocations](/2026/01/c-13-the-end-of-params-allocations/): a classic `params Person[]` signature allocates a 40-byte array on every call unless the JIT inlines the callee and proves the array does not escape. In the benchmark below the non-inlined `params Person[]` version allocated 40 bytes per call on both runtimes.

## The no-loop answer: a static local function

The highest-voted answer on the Stack Overflow thread is "don't loop", and the numbers agree with it:

```csharp
// any .NET, C# 8 or later for static local functions
void Process(Person p1, Person p2)
{
    Handle(p1);
    Handle(p2);

    static void Handle(Person p)
    {
        p.DoSomething();
        p.DoMoreStuff();
    }
}
```

There is no collection at all, nothing to allocate, and the `static` modifier guarantees the local function cannot capture locals, so no closure object sneaks in either. It also works in `async` methods and iterators without restrictions, which the span loop does not (see below). If you need to mutate struct variables, give the local function a `ref` parameter and pass `ref p1`.

The trade-off is only stylistic: with a loop, adding a third item is one more element in the brackets; with a local function, it is one more call line. For two or three items, the local function is the clearest code.

## A struct enumerator over a `Pair<T>`

The accepted answer on the thread writes a `Pair<T>` with a struct enumerator. `foreach` binds to any `GetEnumerator()` method by pattern, without going through `IEnumerable<T>`, so nothing is boxed:

```csharp
// .NET 8 or later, C# 12 or later (primary constructors)
public static class Pair
{
    public static Pair<T> Of<T>(T first, T second) => new(first, second);
}

public readonly struct Pair<T>(T first, T second)
{
    public Enumerator GetEnumerator() => new(first, second);

    public struct Enumerator(T first, T second)
    {
        private int _index = -1;
        public bool MoveNext() => ++_index < 2;
        public readonly T Current => _index == 0 ? first : second;
    }
}

// usage
foreach (Person p in Pair.Of(p1, p2)) { /* ... */ }
```

It allocates nothing and runs as fast as the span version. It is also strictly more code that you have to own, and it stops being allocation-free the moment someone passes a `Pair<T>` to a method that takes `IEnumerable<T>`. Since .NET 8 the span collection expression gives you the same result with no helper type, so I would only reach for this on runtimes older than .NET 8, where the compiler cannot use inline arrays.

## Measured: allocations and time per loop

Each benchmark runs the same body (one non-inlined `DoSomething()` call and one cheap `DoMoreStuff()` call per item) over two `Person` instances. BenchmarkDotNet 0.15.8, `[MemoryDiagnoser]`, in-process toolchain, default job:

| Approach | .NET 10.0.10 mean | .NET 11 RC 3 mean | Allocated (both) |
|---|---:|---:|---:|
| `foreach` over `new Person[] { p1, p2 }` (baseline) | 2.61 ns | 2.37 ns | 0 B (stack-allocated by the JIT, see below) |
| `foreach` over `(Span<Person>)[p1, p2]` | 1.68 ns | 1.75 ns | 0 B |
| `foreach` over `(ReadOnlySpan<Person>)[p1, p2]` | 1.71 ns | 1.73 ns | 0 B |
| `params ReadOnlySpan<Person>` helper | 1.72 ns | 1.71 ns | 0 B |
| `Pair<T>` struct enumerator | 1.76 ns | 1.87 ns | 0 B |
| `static` local function called twice | 0.92 ns | 1.45 ns | 0 B |
| `for (i < 2)` with `i == 0 ? p1 : p2` | 1.19 ns | 1.27 ns | 0 B |
| `IEnumerable<Person> people = [p1, p2]` | 11.24 ns | 10.56 ns | 72 B |
| `params Person[]` helper, not inlined | 5.23 ns | 5.34 ns | 40 B |

The full project (one `Program.cs` plus a `.csproj` with `BenchmarkDotNet` 0.15.8) runs both modes: `dotnet run -c Release -f net10.0` prints the `GC.GetAllocatedBytesForCurrentThread()` numbers, and `dotnet run -c Release -f net10.0 -- bench --inProcess --filter '*'` runs BenchmarkDotNet. Error margins were below 0.13 ns for every row.

A few things in that table are worth spelling out.

**The span versions, `params ReadOnlySpan<T>`, the `Pair<T>` enumerator, the local function and the `for` loop with a ternary all allocate 0 bytes** on both runtimes. The differences between them are around a nanosecond for two items and are not a reason to choose one over another.

**`IEnumerable<Person> people = [p1, p2]` is the slowest and allocates the most.** For interface targets the compiler synthesizes a read-only wrapper type (`<>z__ReadOnlyArray<T>` in this build) around a real array, and `foreach` through `IEnumerable<T>` then calls `GetEnumerator()` through the interface. Writing `[p1, p2]` does not by itself make code allocation-free; the target type decides.

**`new Person[] { p1, p2 }` showed 0 bytes in BenchmarkDotNet.** That is not a measurement error, and it is the most interesting row. It was still the slowest of the allocation-free options, about 0.6 to 0.9 ns behind the span: a stack-allocated array is still a full array object, with a header, a length field and bounds-checked access, while the inline array is just two references.

## .NET 10 can stack-allocate the plain array, sometimes

.NET 10 extended the JIT's escape analysis to arrays. The [What's new in the .NET 10 runtime](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-10/runtime) page has a section on small arrays of reference types and uses almost exactly this example: a `string[]` initialized with two literals and iterated with `foreach`, which "is now allocated on the stack". The same page also covers [small arrays of value types](/2025/04/net-10-stack-allocation-of-arrays-of-value-types/), which got the same treatment.

So on .NET 10, the "naive" loop is often already free. The catch is in the word "often". I measured `GC.GetAllocatedBytesForCurrentThread()` over 1,000,000 calls of the `new[]` method under different JIT settings on .NET 10.0.10:

| Configuration | `new Person[] { p1, p2 }` per call |
|---|---|
| Default tiering, after warm-up to Tier 1 | ~0.8 B (amortized; essentially 0) |
| `DOTNET_TieredCompilation=0` (full opts immediately) | 0 B |
| `DOTNET_JitObjectStackAllocation=0` (escape analysis off) | 40 B |
| `params Person[]` callee marked `NoInlining` | 40 B |

The default-tiering run was not a clean zero because the method spent its first calls in Tier 0, where the JIT does no escape analysis and every call allocates 40 bytes. The JIT summary (`DOTNET_JitDisasmSummary=1`) showed `HeapArray()` compiled twice as `Instrumented Tier0` before the `Tier1 with Synthesized PGO` version replaced it. .NET 11 RC 3 behaved the same way (about 1 B per call amortized in the same run).

That gives you the rules for when the array stays on the heap:

- **Tier 0 and startup code.** Anything that runs a handful of times, or before tiering kicks in, allocates. Startup paths are often exactly where people care about Gen0 counts.
- **The array escapes.** The runtime docs define escape as being "assigned to non-local variables or passed to functions not inlined by the JIT". Pass the array to a method that does not get inlined, store it in a field, capture it in a lambda, and it goes back to the heap. The `params Person[]` row shows this.
- **The array is not small or its length is not a constant.** The optimization is for fixed, small sizes.
- **Escape analysis is a heuristic you do not control.** A refactor that makes the method bigger, or a body that prevents inlining of a helper, can silently turn the allocation back on, and nothing in the code warns you.

The span collection expression has none of these conditions. The compiler decides at build time, so it is allocation-free in Tier 0, in ReadyToRun code, under Native AOT, and in a `Debug` build. If allocation-free is a requirement rather than a nice-to-have, write the span, and let the JIT optimization be a bonus for the code you did not rewrite.

## Gotchas: `await`, `yield`, and structs

### Spans cannot cross `await` or `yield`

A span is a `ref struct`, so it cannot live in the state machine of an `async` method or an iterator. A span loop compiles fine in an `async` method as long as nothing in the loop body awaits:

```csharp
// .NET 10, C# 14
static async Task Ok(Person a, Person b)
{
    foreach (Person p in (ReadOnlySpan<Person>)[a, b]) p.DoSomething();  // fine
    await Task.Yield();
}

static async Task Bad(Person a, Person b)
{
    foreach (Person p in (ReadOnlySpan<Person>)[a, b])
    {
        await Task.Yield();
        p.DoSomething();
    }
}
// error CS4007: Instance of type 'System.ReadOnlySpan<Person>'
// cannot be preserved across 'await' or 'yield' boundary.
```

The same CS4007 error appears for a `yield return` inside the loop of an iterator method. In those methods, use the static local function (an `async` local function if the body awaits) or fall back to the array, which is a reasonable choice when the method already allocates a state machine.

### Structs are copied into the span

If the two variables are structs, the collection expression copies their values into the inline array. Mutating the loop variable, even with `foreach (ref ...)` over a `Span<T>`, only changes the copies:

```csharp
// .NET 10, C# 14
var a = new Counter();
var b = new Counter();

foreach (ref Counter c in (Span<Counter>)[a, b]) c.N++;
Console.WriteLine($"after span loop: a.N={a.N}, b.N={b.N}");
// after span loop: a.N=0, b.N=0

Bump(ref a);
Bump(ref b);
Console.WriteLine($"after ref local function: a.N={a.N}, b.N={b.N}");
// after ref local function: a.N=1, b.N=1

static void Bump(ref Counter c) => c.N++;
struct Counter { public int N; }
```

The array version has the same problem. For classes it does not matter, because the span holds copies of the references and both point at the same objects. For mutable structs, the `ref` local function is the only option of the five that updates the original variables.

### Don't let the span escape

The span from `[p1, p2]` points into the current stack frame, so you cannot return it or store it in a field. The compiler enforces this: `static ReadOnlySpan<T> Two<T>(T a, T b) => [a, b];` fails with CS9203, "A collection expression of type 'ReadOnlySpan<T>' cannot be used in this context because it may be exposed outside of the current scope." If you need the pair to outlive the method, you need a heap collection, and the allocation is the price of that.

## Which one to write

- Several statements per item, synchronous method: `foreach (var p in (ReadOnlySpan<Person>)[p1, p2])`.
- The same work repeated across call sites: a `params ReadOnlySpan<T>` helper.
- `async` or iterator method, mutable structs, or simply more than a few lines per item: a `static` local function, `ref` parameter for structs.
- Targeting .NET Framework or `netstandard2.0`: the local function, or a `Pair<T>` struct enumerator if you really want `foreach`.
- Not in a hot path: `new[] { p1, p2 }` is fine, and on .NET 10 the JIT will often remove the allocation for you anyway.

## Related

- If the two things you want to loop over are collections rather than single variables, the answer is different: see [how to iterate over two collections in lockstep without heap allocations](/2026/10/how-to-iterate-over-two-collections-in-lockstep-without-heap-allocations-in-csharp/).
- [What `Span<T>` is and when it makes your code faster](/2026/06/what-is-span-and-when-does-it-make-my-code-faster/) covers the `ref struct` rules behind the CS4007 error.
- [C# 12 collection expressions](/2023/08/c-12-collection-expressions/) introduces the `[a, b]` syntax used here.
- [C# 12 inline arrays](/2023/08/c-12-inline-arrays/) explains the `[InlineArray(N)]` struct the compiler builds the span on.
- [C# 13: the end of `params` allocations](/2026/01/c-13-the-end-of-params-allocations/) goes deeper on `params ReadOnlySpan<T>`.

## Sources

- [How to iterate over two objects without heap allocations?](https://stackoverflow.com/questions/79984276), the Stack Overflow question and answers this post tests.
- [Collection expressions](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/operators/collection-expressions), C# language reference.
- [Collection expressions feature specification](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-12.0/collection-expressions.md), including the inline-array strategy for span targets.
- [What's new in the .NET 10 runtime: stack allocation](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-10/runtime), small arrays of reference types and escape analysis.
- [`InlineArray2<T>` source in CoreLib](https://source.dot.net/System.Private.CoreLib/src/libraries/System.Private.CoreLib/src/System/Runtime/CompilerServices/InlineArray.cs.html).
