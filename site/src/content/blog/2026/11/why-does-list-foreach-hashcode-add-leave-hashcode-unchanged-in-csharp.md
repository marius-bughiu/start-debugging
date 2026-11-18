---
title: "Why does list.ForEach(hashCode.Add) leave a C# HashCode unchanged when a lambda works?"
description: "System.HashCode is a mutable struct, so the method group hashCode.Add boxes a copy of it into the delegate and every Add lands in that box, not in your local. IL for the method group vs the lambda's closure, the same trap with TagList, List<T> indexers and readonly fields, and the fixes, verified on .NET 10.0.10 and .NET 11.0.0."
pubDate: 2026-11-18
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-10"
  - "dotnet-11"
  - "structs"
---

`strings.ForEach(hashCode.Add)` leaves `hashCode` untouched because `System.HashCode` is a mutable struct, and converting `hashCode.Add` (a method group) to an `Action<string>` boxes a copy of the struct into the delegate. Every `Add` call mutates that boxed copy, so your local still holds the empty initial state and `ToHashCode()` returns the same value as `new HashCode().ToHashCode()`. The lambda `s => hashCode.Add(s)` works because the compiler hoists `hashCode` into a closure class and the lambda mutates that field in place. The fix is a plain `foreach`, a lambda, or a helper that takes the struct by `ref`. Everything below was compiled with the .NET 11 SDK (11.0.100) and run on .NET 10.0.10 and .NET 11.0.0 on macOS arm64; both runtimes behave identically, because this is C# language semantics, not a runtime bug.

## Reproducing the lost writes

This is the shape of the [Stack Overflow question](https://stackoverflow.com/questions/79765549) that prompted this post, extended with a couple of probes:

```csharp
// .NET 10 / .NET 11, C# 14
List<string> strings = ["test1", "test2"];

var viaLoop = new HashCode();
foreach (var s in strings) viaLoop.Add(s);

var viaLambda = new HashCode();
strings.ForEach(s => viaLambda.Add(s));

var viaMethodGroup = new HashCode();
strings.ForEach(viaMethodGroup.Add);

Console.WriteLine($"foreach:      {viaLoop.ToHashCode()}");
Console.WriteLine($"lambda:       {viaLambda.ToHashCode()}");
Console.WriteLine($"method group: {viaMethodGroup.ToHashCode()}");
Console.WriteLine($"empty:        {new HashCode().ToHashCode()}");
```

Output on .NET 10.0.10:

```text
foreach:      -1942103177
lambda:       -1942103177
method group: -328348445
empty:        -328348445
```

And on .NET 11.0.0 (different numbers, same pattern):

```text
foreach:      1407490624
lambda:       1407490624
method group: 636895095
empty:        636895095
```

The absolute values change on every run because `HashCode` mixes in a random per-process seed, the same mechanism behind [why `string.GetHashCode()` returns a different value every run](/2026/11/why-does-string-gethashcode-return-a-different-value-every-run-in-dotnet/). What matters is that within one run, the method group result is exactly the empty hash. Not a different hash of the same inputs: no input was ever added to `viaMethodGroup`.

The build produced zero warnings. Neither the compiler nor the default analyzers say anything about this line.

## What the C# spec says a method group conversion does

The behavior is spelled out in the [method group conversions section of the C# specification](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/conversions#108-method-group-conversions). When the selected method is an instance method, the delegate's target object is computed from the instance expression, and if that expression is of a value type, "a boxing operation is performed to convert the value to an object, and this object becomes the target object."

A delegate has to store its target as an `object` reference. A local variable of a struct type is not an object; it lives in the stack frame. So the compiler copies the current value of `viaMethodGroup` into a fresh heap box, and the delegate binds `HashCode.Add<string>` to that box. From that point on, the delegate and your local are two separate `HashCode` values that happen to start out identical.

The lambda takes a different route. A lambda that captures a local causes the compiler to lift that local into a field of a compiler-generated closure class (`<>c__DisplayClass0_0`). Every reference to `viaLambda`, both inside the lambda and in the rest of the method, now goes through that field. There is only one copy of the struct, and it lives on the heap inside the closure object.

## The IL that proves it

Here is the IL for the two `ForEach` calls, as compiled for `net10.0` by the .NET 11 SDK and dumped with a small `System.Reflection.Emit.OpCodes` decoder (instruction offsets trimmed for readability):

```text
// strings.ForEach(s => viaLambda.Add(s));
ldloc.0                                   // the closure object
ldflda   <>c__DisplayClass0_0::viaLambda  // address of the field
initobj  System.HashCode                  // viaLambda = new HashCode()
ldloc.1                                   // strings
ldloc.0                                   // closure is the delegate target
ldftn    <>c__DisplayClass0_0::<<Main>$>b__0(string)
newobj   Action<string>::.ctor(object, native int)
callvirt List<string>::ForEach(Action<string>)

// strings.ForEach(viaMethodGroup.Add);
ldloca.s 3
initobj  System.HashCode                  // viaMethodGroup = new HashCode()
ldloc.1                                   // strings
ldloc.3                                   // load the struct BY VALUE
box      System.HashCode                  // copy it into a new heap object
ldftn    System.HashCode::Add<string>(string)
newobj   Action<string>::.ctor(object, native int)
callvirt List<string>::ForEach(Action<string>)
```

And the lambda body itself:

```text
// <>c__DisplayClass0_0::<<Main>$>b__0(string s)
ldarg.0
ldflda   <>c__DisplayClass0_0::viaLambda  // address of the one real copy
ldarg.1
call     System.HashCode::Add<string>(string)
ret
```

The difference is `ldloc.3` plus `box` versus `ldflda`. `ldloc` pushes the value of the struct; `box` copies that value into a new object. `ldflda` pushes the address of the field, so `Add` mutates the original. Notice also that the local `viaMethodGroup` is never touched again after `initobj`. Nothing in the method writes to it.

## The writes did happen, just not where you look

You can prove the box received every `Add` by pulling it back out of the delegate's `Target`:

```csharp
// .NET 10 / .NET 11, C# 14
var original = new HashCode();
Action<string> add = original.Add;
strings.ForEach(add);

var boxed = (HashCode)add.Target!;
Console.WriteLine($"original after delegate: {original.ToHashCode()}");
Console.WriteLine($"delegate.Target (box):   {boxed.ToHashCode()}");
Console.WriteLine($"Target type: {add.Target!.GetType()}");
```

On .NET 10.0.10:

```text
original after delegate: -328348445
delegate.Target (box):   -1942103177
Target type: System.HashCode
```

The boxed copy holds `-1942103177`, the same value the `foreach` and the lambda produced. So the delegate did call `Add` twice, against the same boxed instance each time. The runtime calls instance methods on a boxed value type through a pointer to the data inside the box, so mutations persist in the box between calls. The only thing lost is the connection back to your local variable.

This also explains why the bug is silent instead of crashing: the box is a perfectly valid `HashCode`, it just becomes garbage once `ForEach` returns.

## Fixing it

Pick whichever reads best; all of these produced the expected hash in the test run.

A plain loop is the clearest and allocates nothing (no delegate, no box, no closure):

```csharp
// .NET 10 / .NET 11, C# 14
var hash = new HashCode();
foreach (var s in strings)
    hash.Add(s);
return hash.ToHashCode();
```

A lambda works, as shown above, but it costs a closure allocation plus a delegate allocation, and it relies on a subtle compiler transformation that the next refactoring tool might undo.

If you want a reusable helper, take the struct by `ref` so the callee writes into the caller's storage:

```csharp
// .NET 10 / .NET 11, C# 14
static void AddAll<T>(ref HashCode hash, IEnumerable<T> items)
{
    foreach (var item in items)
        hash.Add(item);
}

var viaRef = new HashCode();
AddAll(ref viaRef, strings);
Console.WriteLine(viaRef.ToHashCode()); // -1942103177 on the .NET 10.0.10 run above
```

If you need a delegate-shaped API for some reason, wrap the struct in a class you control, so the delegate target is a reference type and there is only one copy. In practice the loop is almost always the right call.

## Will an analyzer catch it?

Not by default. The test project built with no warnings on either SDK.

The interesting detail is that the Roslyn IDE fixer that offers to simplify `s => x.Add(s)` into `x.Add` (IDE0200, "remove unnecessary lambda expression") already knows about this trap. Its [source](https://source.dot.net/Microsoft.CodeAnalysis.CSharp.Features/src/Analyzers/CSharp/Analyzers/RemoveUnnecessaryLambdaExpression/CSharpRemoveUnnecessaryLambdaExpressionDiagnosticAnalyzer.cs.html) skips the suggestion when the receiver is a struct that is not `readonly`, because a method group conversion copies the receiver and that would change behavior. So Visual Studio will not push you into this bug. Other refactoring tools and hand edits can still produce it, and nothing flags the method group once it is written. [Gérald Barré's post on lambdas, method groups and delegate caching](https://www.meziantou.net/performance-lambda-expressions-method-groups-and-delegate-caching.htm) calls out the same mutable-struct difference from the performance angle: "convert lambda to method group" is not always a safe rewrite.

## The same trap with other mutable structs

`HashCode` is not special. Any non-`readonly` struct with a mutating instance method behaves this way. `System.Diagnostics.TagList`, the struct used to collect tags for `System.Diagnostics.Metrics` instruments, is a good example because it is designed to be filled with `Add`:

```csharp
// .NET 10 / .NET 11, C# 14
using System.Diagnostics;

KeyValuePair<string, object?>[] pairs =
    [new("http.method", "GET"), new("http.status", 200)];

var tags = new TagList();
Array.ForEach(pairs, tags.Add);
Console.WriteLine(tags.Count);   // 0

var tags2 = new TagList();
foreach (var p in pairs) tags2.Add(p);
Console.WriteLine(tags2.Count);  // 2
```

A metrics call that records `tags` after the method group version would silently record no dimensions at all.

Your own types are equally exposed. If you write a struct with a method like `Increment()` or `Append()`, every caller who passes `instance.Increment` as a delegate gets a copy. If the struct does not need to be mutable, mark it `readonly struct`: then there are no mutating methods to lose writes from, and the copy is harmless. The tradeoffs between mutable structs, readonly structs, records and classes are covered in [this decision matrix](/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/).

## Copies that happen without any delegate

The method group is one of several places where C# quietly operates on a copy of a struct. Two more that compile without a warning, from the same test run:

```csharp
// .NET 10 / .NET 11, C# 14
List<HashCode> list = [new HashCode()];
list[0].Add("x");   // the indexer returns a copy; Add mutates the copy
Console.WriteLine(list[0].ToHashCode() == new HashCode().ToHashCode()); // True

class Holder
{
    private readonly HashCode _hc = new();
    public void Add(string s) => _hc.Add(s);  // defensive copy of a readonly field
    public int Result => _hc.ToHashCode();
}
// new Holder() with Add("x") still returns the empty hash: True
```

For the `List<T>` indexer, the compiler reports CS1612 if you try to assign a field or property of the returned value (`list[0].X = 1`), but a method call on it is allowed, and the method runs against a temporary. For the `readonly` field, the compiler must guarantee the field is never modified, so it copies the struct before calling a non-`readonly` method on it. Both bugs have the same signature as the method group one: the code runs, the mutation happens, and it is thrown away. If you have been bitten by a similar "the write had no effect on a struct" problem through reflection, [the `UnsafeAccessor` struct field write post](/2026/11/fix-unsafeaccessor-field-write-has-no-effect-on-a-struct/) is the same root cause on a different path.

Collections that hand out a `ref` instead of a value avoid the copy. `CollectionsMarshal.AsSpan(list)[0].Add("x")` and `CollectionsMarshal.GetValueRefOrNullRef(dictionary, key)` both give you a reference to the stored struct, so mutation sticks (both checked on .NET 10.0.10: the stored hash matched a `HashCode` with `"x"` added directly). Those are worth reaching for when you genuinely need a collection of mutable structs, the same way [a span-based loop avoids allocating an array](/2026/11/how-to-loop-over-two-variables-without-allocating-an-array-in-csharp/).

## Why the lambda and the method group look the same in the IDE

Hovering both forms in an editor shows `HashCode.Add<string>(string)`, which is why the question is so confusing. The method being called is identical. What differs is the receiver: the lambda passes a reference to the one real variable, and the method group passes a boxed snapshot taken at the moment of conversion. Whenever the receiver is a mutable struct, `x.Method` as a delegate means "call `Method` on a copy of `x` as it is right now". Write the loop, or keep the lambda, and leave the method group for reference types and `readonly` structs.

## Sources

- [Stack Overflow: List<T>.ForEach does not invoke the action HashCode.Add<T>](https://stackoverflow.com/questions/79765549) (question and accepted answer)
- [C# specification: method group conversions](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/conversions#108-method-group-conversions)
- [HashCode struct API reference](https://learn.microsoft.com/en-us/dotnet/api/system.hashcode)
- [TagList struct API reference](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.taglist)
- [Roslyn: CSharpRemoveUnnecessaryLambdaExpressionDiagnosticAnalyzer source](https://source.dot.net/Microsoft.CodeAnalysis.CSharp.Features/src/Analyzers/CSharp/Analyzers/RemoveUnnecessaryLambdaExpression/CSharpRemoveUnnecessaryLambdaExpressionDiagnosticAnalyzer.cs.html)
- [Meziantou: lambda expressions, method groups, and delegate caching](https://www.meziantou.net/performance-lambda-expressions-method-groups-and-delegate-caching.htm)
