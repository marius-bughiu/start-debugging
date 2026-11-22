---
title: "How to build a static dispatch table of instance methods in C#"
description: "Replace an if/else chain of instance-method calls with a lookup table built once: give the delegate an explicit 'self' parameter, fill a static FrozenDictionary with static lambdas or open instance delegates from MethodInfo.CreateDelegate, and pass 'this' at call time. Benchmarked on .NET 11 against if/else, switch, Dictionary, MethodInfo.Invoke and per-instance tables, and checked under Native AOT."
pubDate: 2026-11-22
tags:
  - "dotnet"
  - "csharp"
  - "delegates"
  - "performance"
  - "dotnet-11"
---

**Short answer:** a delegate does not need its target when the table is built. Declare a delegate type whose *first parameter is the instance* (`delegate Task Handler(EventRouter self, Client client, BotEventArgs args)`), fill a `static readonly` table with `static (self, c, a) => self.FooAsync(c, a)` lambdas, and call `handler(this, client, args)` at dispatch time. If you want the table discovered from attributes instead of typed by hand, `methodInfo.CreateDelegate<Handler>()` produces the same thing, an *open instance delegate*, with one reflection pass at type initialization and no reflection per call. On .NET 11 both versions dispatched in 3-7 ns with zero allocations, ran fine under Native AOT, and beat the if/else chain once the matching branch was not near the top.

Everything below was run on .NET 11.0.0 (SDK 11.0.100, C# 15) on macOS 27.0.1, Apple M4, with BenchmarkDotNet 0.15.8. The technique itself works the same way back to .NET Framework 2.0 for `Delegate.CreateDelegate`, and `MethodInfo.CreateDelegate<T>()` exists since .NET 5.

## Why the obvious delegate table needs an instance

The question comes from a [Stack Overflow post](https://stackoverflow.com/questions/80015429) with this shape:

```csharp
// .NET 11, C# 15
public Task HandleEventAsync(Client client, BotEventArgs args)
{
    if (args.EventId == "foo") return FooHandleEventAsync(client, args);
    else if (args.EventId == "bar") return BarHandleEventAsync(client, args);
    // ... six more
    return Task.CompletedTask;
}
```

The handlers are private instance methods because they touch instance state. The natural first attempt is a static dictionary of `Func<Client, BotEventArgs, Task>`:

```csharp
// .NET 11, C# 15 -- does not compile
private static readonly Dictionary<string, Func<Client, BotEventArgs, Task>> s_table = new()
{
    ["foo"] = FooHandleEventAsync,
};
```

The compiler rejects it:

```text
error CS0236: A field initializer cannot reference the non-static field, method, or property 'EventRouter.FooHandleEventAsync(Client, BotEventArgs)'
```

That is not a C# limitation so much as a statement about what `Func<Client, BotEventArgs, Task>` means. A delegate created from an instance method group is a *closed* delegate: it stores the method pointer **and** the target object, and `Invoke(client, args)` supplies only the remaining arguments. There is no object to close over in a static initializer, so the conversion is impossible. Building the dictionary per instance (`["foo"] = this.FooHandleEventAsync`) does compile, but then you are back to rebuilding the table for every instance, which is exactly what the asker wanted to avoid.

The fix is to stop asking for a closed delegate. Make the instance an explicit parameter.

## The static table with an explicit self parameter

```csharp
// .NET 11, C# 15
using System.Collections.Frozen;

public sealed class Client { public int Count; }
public sealed record BotEventArgs(string EventId);

public sealed class EventRouter
{
    private delegate Task Handler(EventRouter self, Client client, BotEventArgs args);

    private static readonly FrozenDictionary<string, Handler> s_handlers =
        new Dictionary<string, Handler>
        {
            ["foo"] = static (self, c, a) => self.FooHandleEventAsync(c, a),
            ["bar"] = static (self, c, a) => self.BarHandleEventAsync(c, a),
            ["baz"] = static (self, c, a) => self.BazHandleEventAsync(c, a),
            // ...
        }.ToFrozenDictionary();

    public Task HandleEventAsync(Client client, BotEventArgs args) =>
        s_handlers.TryGetValue(args.EventId, out var handler)
            ? handler(this, client, args)
            : Task.CompletedTask;

    private Task FooHandleEventAsync(Client c, BotEventArgs a) { /* ... */ return Task.CompletedTask; }
    private Task BarHandleEventAsync(Client c, BotEventArgs a) { /* ... */ return Task.CompletedTask; }
    private Task BazHandleEventAsync(Client c, BotEventArgs a) { /* ... */ return Task.CompletedTask; }
}
```

A few details are doing real work here:

- **The lambdas are `static`.** A static initializer has no `this` to capture anyway, but the `static` modifier (C# 9) documents the intent and turns any accidental capture of a local into a compile error. That guarantees each lambda stays a single cached delegate instance created once.
- **The lambdas can call private methods.** They are declared inside `EventRouter`, so `self.FooHandleEventAsync` is accessible. No reflection, no `UnsafeAccessor`.
- **A named delegate type is optional.** `Func<EventRouter, Client, BotEventArgs, Task>` works identically. The named `Handler` just reads better and lets you keep the type private.
- **The table is frozen.** `ToFrozenDictionary()` (since .NET 8) spends extra time at construction to pick a lookup strategy for the exact key set. It is a static, read-only table, so that is the right trade. The measured effect is more mixed than you might expect; see the benchmark below.

This is also what the accepted answer on the question suggests, and it is the version to pick for a handful of handlers: it is trim-safe, AOT-safe, refactor-safe (rename a handler and the lambda breaks at compile time), and fast.

## Building the table from attributes with open instance delegates

When there are dozens of handlers, keeping the dictionary in sync with the methods by hand gets tedious. You can mark each handler and discover them once:

```csharp
// .NET 11, C# 15
using System.Collections.Frozen;
using System.Reflection;

[AttributeUsage(AttributeTargets.Method)]
public sealed class HandlesAttribute(string eventId) : Attribute
{
    public string EventId { get; } = eventId;
}

public sealed class EventRouter
{
    private delegate Task Handler(EventRouter self, Client client, BotEventArgs args);

    private static readonly FrozenDictionary<string, Handler> s_handlers = BuildTable();

    private static FrozenDictionary<string, Handler> BuildTable()
    {
        var table = new Dictionary<string, Handler>();
        foreach (var m in typeof(EventRouter).GetMethods(BindingFlags.Instance | BindingFlags.NonPublic))
        {
            if (m.GetCustomAttribute<HandlesAttribute>() is not { } attr) continue;
            table.Add(attr.EventId, m.CreateDelegate<Handler>());
        }
        return table.ToFrozenDictionary();
    }

    public Task HandleEventAsync(Client client, BotEventArgs args) =>
        s_handlers.TryGetValue(args.EventId, out var handler)
            ? handler(this, client, args)
            : Task.CompletedTask;

    [Handles("foo")] private Task FooHandleEventAsync(Client c, BotEventArgs a) => Task.CompletedTask;
    [Handles("bar")] private Task BarHandleEventAsync(Client c, BotEventArgs a) => Task.CompletedTask;
}
```

`m.CreateDelegate<Handler>()` is called on an *instance* method, with no target, for a delegate type whose first parameter is `EventRouter`. The runtime treats that first delegate parameter as the hidden `this` argument and produces an open instance delegate. The [`Delegate.CreateDelegate` remarks](https://learn.microsoft.com/dotnet/api/system.delegate.createdelegate) describe this case explicitly: when the first argument is null and the method is an instance method, the delegate is "open" if its signature includes the method's hidden first parameter. In the test run, `handler.Target` was `null`, which confirms nothing is closed over.

Note that `Dictionary.Add` throws on a duplicate event ID, which is what you want: two methods claiming the same event is a bug, and it surfaces as a `TypeInitializationException` the first time the class is touched rather than as silent last-one-wins.

A few behaviours of open instance delegates worth knowing, all checked in the repro:

- **Signature mismatches fail at bind time, not call time.** Binding a `Task`-returning method to a `void`-returning delegate throws `System.ArgumentException: Cannot bind to the target method because its signature is not compatible with that of the delegate type.` You find out during type initialization.
- **Virtual methods dispatch virtually.** An open delegate created from `Base.Name()` and invoked with a `Derived` instance called `Derived.Name()`. That is usually what you want for a handler hierarchy, but it is not the same as `base.Name()`.
- **Structs need `ref`.** For an instance method on a struct, the self parameter must be `ref S`: `delegate int RefS(ref S self)` bound fine and mutated the caller's struct, while `Func<S, int>` threw the same `ArgumentException`.

### Why C# itself will not write this for you

You might expect `Handler h = EventRouter.FooHandleEventAsync;` to produce the open delegate directly. It does not:

```text
error CS0123: No overload for 'FooHandleEventAsync' matches delegate 'Handler'
```

C# method group conversions only produce closed delegates for instance methods. The runtime supports open instance delegates; the language has no syntax for them. Function pointers are not an escape hatch either: `delegate*<R, int, int> p = &Foo;` on an instance method fails with `CS8757: No overload for 'Foo' matches function pointer`, because the [function pointer feature](https://learn.microsoft.com/dotnet/csharp/language-reference/proposals/csharp-9.0/function-pointers) only accepts static methods. The lambda wrapper and `CreateDelegate` are the two supported routes.

## Benchmark: dispatch cost on .NET 11

The benchmark routes one call through an `EventRouter` with eight handlers (`foo`, `bar`, `baz`, `qux`, `join`, `leave`, `ping`, `pong`). Each handler increments two counters and returns `Task.CompletedTask`, so the numbers are dispatch overhead, not handler work. Two event IDs are measured: `foo` (first branch of the if/else chain) and `pong` (last branch).

The variants:

- `IfElse`: the original chain of `==` comparisons.
- `Switch`: the same eight cases as a `switch` expression on the string.
- `DictionaryLambda`: static `Dictionary<string, Handler>` with static lambdas.
- `FrozenLambda`: the same table as `FrozenDictionary`.
- `FrozenReflectedDelegate`: the attribute-discovered open instance delegates in a `FrozenDictionary`.
- `MethodInfoInvoke`: a static `FrozenDictionary<string, MethodInfo>` and `m.Invoke(this, [client, args])` per call.
- `PerInstanceTable`: what the asker wanted to avoid, building a `Dictionary` of closed delegates for a new instance, then dispatching once.

BenchmarkDotNet 0.15.8 ran with `--inProcess` (InProcessEmitToolchain), because its default out-of-process toolchain does not recognize the net11.0 runtime yet.

```text
BenchmarkDotNet v0.15.8, macOS 27.0.1 (26A434) [Darwin 27.0.0]
Apple M4, 1 CPU, 10 logical and 10 physical cores
.NET SDK 11.0.100
Toolchain=InProcessEmitToolchain

| Method                  | EventId | Mean        | Ratio  | Allocated |
|------------------------ |-------- |------------:|-------:|----------:|
| IfElse                  | foo     |   0.8783 ns |   1.00 |         - |
| Switch                  | foo     |   1.0537 ns |   1.20 |         - |
| DictionaryLambda        | foo     |   4.7978 ns |   5.47 |         - |
| FrozenLambda            | foo     |   2.7290 ns |   3.11 |         - |
| FrozenReflectedDelegate | foo     |   2.8401 ns |   3.24 |         - |
| MethodInfoInvoke        | foo     |  14.2377 ns |  16.22 |      40 B |
| PerInstanceTable        | foo     | 127.8732 ns | 145.71 |    1464 B |
|                         |         |             |        |           |
| IfElse                  | pong    |  11.5476 ns |   1.00 |         - |
| Switch                  | pong    |   5.5625 ns |   0.48 |         - |
| DictionaryLambda        | pong    |   4.7959 ns |   0.42 |         - |
| FrozenLambda            | pong    |   6.8502 ns |   0.59 |         - |
| FrozenReflectedDelegate | pong    |   7.2357 ns |   0.63 |         - |
| MethodInfoInvoke        | pong    |  18.2238 ns |   1.58 |      40 B |
| PerInstanceTable        | pong    | 127.5039 ns |  11.05 |    1464 B |
```

What the numbers say, and what they do not:

- **A lookup table is about flat cost, not raw speed.** The if/else chain is the fastest possible dispatch for the first branch (under a nanosecond) and the slowest of the non-reflection options for the last branch (11.5 ns), because it pays for every failed string comparison on the way down. A table costs roughly the same for every key. With eight handlers the crossover is already visible; with fifty it would not be close.
- **`switch` on a string is a strong contender.** For this key set Roslyn did not emit a `ComputeStringHash` call at all (the string is absent from the compiled DLL); it dispatches on length and characters, and landed at 1-5.6 ns with no table to maintain. If the goal is only "stop the if/else chain" and the handlers are known at compile time, a `switch` expression is a perfectly good answer.
- **`FrozenDictionary` was not uniformly faster than `Dictionary` here.** It won for `foo` (2.7 vs 4.8 ns) and lost for `pong` (6.9 vs 4.8 ns). `ToFrozenDictionary` picks its strategy from the key set, and for eight 3-5 character keys the result is not a clean win. Measure with your own event IDs before choosing; [the Dictionary vs FrozenDictionary comparison](/2024/04/net-8-performance-dictionary-vs-frozendictionary/) has the general picture with larger key sets.
- **Hand-written lambdas and reflected open delegates are equivalent at call time.** 2.73 vs 2.84 ns and 6.85 vs 7.24 ns are within noise of each other. Once the delegate exists, it does not matter how it was created.
- **`MethodInfo.Invoke` per call is the slow path you were worried about.** 14-18 ns and a 40-byte argument array on every dispatch. Recent .NET versions made `Invoke` much cheaper than it used to be, but turning the `MethodInfo` into a delegate once is still 2-5x faster and allocation-free. The [UnsafeAccessor vs reflection post](/2023/11/net-8-performance-unsafeaccessor-vs-reflection/) covers the same "do the reflection once" idea for fields.
- **Rebuilding closed delegates per instance is two orders of magnitude worse.** 1,464 bytes and ~128 ns per instance, all of it allocation for eight delegate objects plus the dictionary. That is the cost the explicit-self table removes.

These are micro-benchmark numbers for a single call on one machine. In a real event handler the handler body, the `await`, and the network will dwarf every row except `PerInstanceTable` if you construct routers often.

## Native AOT and trimming

The attribute-based table uses reflection, so the natural worry is Native AOT. The full benchmark project was published with `dotnet publish -c Release -r osx-arm64 -p:PublishAot=true` on SDK 11.0.100. The trim and AOT warnings it produced all came from BenchmarkDotNet's own dependencies (`CommandLine`, `TraceEvent`, `Microsoft.CodeAnalysis`); `EventRouter` produced none. The native binary then ran the self-check, and all six dispatch paths (including `CreateDelegate` and `MethodInfo.Invoke`) found all eight handlers and returned the same counters as the JIT build.

That works because `typeof(EventRouter).GetMethods(BindingFlags.Instance | BindingFlags.NonPublic)` is called on a statically known type, so the trimmer can see which members to keep. Move the same code into a generic helper and the analysis breaks:

```csharp
// .NET 11, C# 15 -- built with -p:IsAotCompatible=true
public static MethodInfo[] Find<T>() =>
    typeof(T).GetMethods(BindingFlags.Instance | BindingFlags.NonPublic);
```

```text
warning IL2090: 'this' argument does not satisfy 'DynamicallyAccessedMemberTypes.NonPublicMethods' in call to 'System.Type.GetMethods(BindingFlags)'. The generic parameter 'T' of 'Tables.Find<T>()' does not have matching annotations.
```

The fix is to annotate the type parameter, `Find<[DynamicallyAccessedMembers(DynamicallyAccessedMemberTypes.NonPublicMethods)] T>()`, which tells the trimmer to keep private methods on whatever `T` callers pass. The general rules are in [what trim-safe code is and how to write it](/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/). If you would rather not think about it at all, the hand-written static lambda table has no reflection and nothing to annotate.

## Which version to use

- **A few handlers, known at compile time:** a `switch` expression, or the static lambda table if you want the table to be data you can enumerate, log, or test.
- **Many handlers, or handlers added often:** the attribute plus `CreateDelegate` table, built once in a static initializer. Keep the reflection on a concrete `typeof(...)` or annotate generics for trimming.
- **Many handlers and you want zero reflection:** a source generator that emits the static lambda table from the `[Handles]` attributes at build time. That gives you the attribute ergonomics with the hand-written table's AOT story; [what a source generator is and when you need one](/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) covers whether that is worth building.
- **Never:** `MethodInfo.Invoke` per call, or a per-instance dictionary of closed delegates in a type that gets instantiated per request or per event.

One last note on the string keys: event IDs that arrive from a socket or a JSON payload are fresh strings, not interned literals, so every lookup does a real hash and comparison. That is fine at these costs. If the same `EventRouter` handles events whose ID set is tiny and fixed, an `enum` parsed once at the edge and a `switch` on it is cheaper still, but that is a protocol decision, not a dispatch one.

## Sources

- [Stack Overflow: Build a static dispatch table of non-static methods in C#](https://stackoverflow.com/questions/80015429)
- [`Delegate.CreateDelegate` remarks on open and closed instance delegates](https://learn.microsoft.com/dotnet/api/system.delegate.createdelegate)
- [`MethodInfo.CreateDelegate<T>()`](https://learn.microsoft.com/dotnet/api/system.reflection.methodinfo.createdelegate)
- [`FrozenDictionary<TKey, TValue>`](https://learn.microsoft.com/dotnet/api/system.collections.frozen.frozendictionary-2)
- [Static anonymous functions (C# 9)](https://learn.microsoft.com/dotnet/csharp/language-reference/proposals/csharp-9.0/static-anonymous-functions)
- [Function pointers (C# 9)](https://learn.microsoft.com/dotnet/csharp/language-reference/proposals/csharp-9.0/function-pointers)
- [Prepare .NET libraries for trimming: `DynamicallyAccessedMembers`](https://learn.microsoft.com/dotnet/core/deploying/trimming/prepare-libraries-for-trimming)
