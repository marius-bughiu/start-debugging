---
title: "What Is ref-safe-context in C#, and How Does the Compiler Decide It for ref Locals?"
description: "ref-safe-context is the scope in which a reference to a variable stays valid. Here are the four contexts, the rule that fixes a ref local's context at its initializer, why ref reassignment can never widen or narrow it, and the CS8157, CS8168, CS8374 and CS9079 errors that fall out of it, with compiler output from C# 14 on .NET 10 and .NET 11 RC1."
pubDate: 2026-10-15
template: how-to
tags:
  - "csharp"
  - "csharp-14"
  - "dotnet-11"
  - "ref-locals"
  - "span"
  - "compiler-errors"
---

Short answer: ref-safe-context is the region of code in which a reference (a `ref` local, a `ref` return, a `ref` field) to a given variable is guaranteed to point at live memory. The C# compiler assigns every variable one of four contexts, from narrowest to widest: declaration-block, function-member, return-only, and caller-context. A `ref` local does not get its own context. It copies the ref-safe-context of the expression it was initialized with, that context is fixed for the rest of its life, and every later `r = ref other;` must point at something whose context is at least as wide. That one rule explains why a `ref` local initialized from a stack local can never be returned, even if you later reassign it to an array element.

Every result in this post comes from real builds: the .NET 10 SDK 10.0.302 with `<LangVersion>14</LangVersion>`, and the same files rebuilt on the .NET 11 RC1 SDK (11.0.100-rc.1.26425.128). The diagnostics are identical on both, and they are pasted from the compiler output, not paraphrased.

## Why the compiler tracks a "context" at all

A `ref` in C# is a managed pointer. It can point into the heap (an array element, a field of a class instance), into static storage, or into a stack frame (a local, a parameter). Heap and static memory outlive any method call. A stack frame dies when its method returns. If a method could hand out a `ref` to one of its own locals, the caller would hold a pointer into a dead frame, which is exactly the use-after-free bug that `ref` was designed not to have.

C# does not solve this with a runtime check. It solves it statically: each variable gets a ref-safe-context describing how far a reference to it may travel, and each place that stores or returns a reference checks that the referent's context is at least as wide as the reference's own. The C# standard puts it in one sentence in [section 9.7.2](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/variables#972-ref-safe-contexts): "The referent of a reference variable shall have a ref-safe-context that is at least as wide as the ref-safe-context of the reference variable itself."

There is a sibling concept, safe-context, that applies to values of `ref struct` types such as `Span<T>`. Ref-safe-context answers "how long is a reference to this variable valid?" Safe-context answers "how long is the value stored in this variable (which itself contains references) valid?" Most of this post is about the first one, but they meet at `Span<T>` indexers, which is covered further down.

## The four contexts, narrowest to widest

| Context | What has it | Can be ref-returned? |
| --- | --- | --- |
| declaration-block | Ordinary locals, scoped to the block they are declared in | No |
| function-member | Value parameters, `out` parameters, `this` in a struct method, `scoped ref` locals and parameters | No |
| return-only | `ref` and `in` parameters | Yes, via `return ref` only |
| caller-context | Array elements, fields of class instances, static fields, fields reached through `ref` parameters | Yes |

Two details are easy to miss. First, declaration-block really is per block: a local declared inside an `if` body has a narrower context than one declared at the top of the method. Second, return-only exists so that a `ref` parameter can be returned (`return ref p;` is legal), but cannot be stored somewhere that outlives the call, such as a `ref` field of a `ref struct` passed in by the caller. That level was added in C# 11 as part of the [low-level struct improvements](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-11.0/low-level-struct-improvements).

Here is the baseline in code, every method compiled under C# 14:

```csharp
// .NET 10 SDK 10.0.302, C# 14 (same result on .NET 11 RC1)
class Contexts
{
    int[] _arr = new int[10];
    static int s_counter;

    // declaration-block: error CS8168
    static ref int FromLocal() { int v = 5; return ref v; }

    // function-member (value parameter): error CS8157 once aliased
    static ref int FromValueParam(int p) { ref int r = ref p; return ref r; }

    // return-only (ref parameter): OK
    static ref int FromRefParam(ref int p) { ref int r = ref p; return ref r; }

    // caller-context (array element): OK
    ref int FromArray() { ref int r = ref _arr[3]; return ref r; }

    // caller-context (static field): OK
    static ref int FromStatic() { ref int r = ref s_counter; return ref r; }
}
```

The two errors:

```text
error CS8168: Cannot return local 'v' by reference because it is not a ref local
error CS8157: Cannot return 'r' by reference because it was initialized to a value that cannot be returned by reference
```

Read the wording of CS8157 carefully: "because it was initialized to". The compiler is not looking at what `r` points to at the `return`. It is looking at what `r` was initialized with.

## How a ref local gets its context

The standard's rule for locals ([section 9.7.2.2](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/variables#9722-local-variable-ref-safe-context)) is two lines:

- If `v` is a reference variable, its ref-safe-context is the same as the ref-safe-context of its initializing expression.
- Otherwise its ref-safe-context is declaration-block.

So the compiler decides a `ref` local's context in exactly one place: the declaration. The initializer expression is evaluated for its context using these rules:

1. A local or a value parameter: its own context (declaration-block or function-member).
2. A `ref` or `in` parameter: return-only.
3. A field `e.F` of a class instance, an array element, a static field: caller-context.
4. A field `e.F` of a struct: the context of `e`. A field of a struct local is declaration-block; a field of `this` inside a struct method is function-member.
5. A conditional `c ? ref a : ref b`: the narrower of `a` and `b`.
6. A `ref`-returning method, property or indexer call: the narrowest of caller-context and every `ref` argument's ref-safe-context (plus every argument's safe-context, receiver included), skipping arguments bound to `scoped` and `out` parameters.

Rule 6 is the one that surprises people, because it means a perfectly innocent helper can poison a `ref` local:

```csharp
// .NET 10 SDK 10.0.302, C# 14
static ref int Pick(ref int a) => ref a;

static ref int ThroughHelper()
{
    int v = 5;
    ref int r = ref Pick(ref v); // r inherits v's declaration-block context
    return ref r;                // error CS8157
}
```

`Pick` itself is fine, it returns its own `ref` parameter. But the compiler does not look inside `Pick`. It only sees the signature: "returns a `ref` that may be any of my `ref` arguments", so the result's context is the narrowest argument's context, and that argument is a local. This is how the spec prevents laundering a stack reference through a method call.

The way out, when the helper genuinely never returns that argument, is to say so with `scoped`:

```csharp
// .NET 10 SDK 10.0.302, C# 14
static ref int PickSecond(scoped ref int a, ref int b) => ref b;

static ref int Fine(ref int b)
{
    int v = 5;
    ref int r = ref PickSecond(ref v, ref b); // only b contributes: return-only
    return ref r;                             // OK
}
```

A `scoped ref` parameter cannot be returned or captured by the callee, so it no longer contributes to the result's context. The conditional operator has no such escape hatch:

```csharp
// .NET 10 SDK 10.0.302, C# 14
ref int Either(bool f)
{
    int v = 1;
    ref int r = ref f ? ref _arr[0] : ref v; // narrowest wins: declaration-block
    return ref r;                            // error CS8157
}
```

## Ref reassignment can neither widen nor narrow

Since C# 7.3, a `ref` local can be pointed somewhere else with `r = ref other;`. The rule from [section 9.7.2.9](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/variables#9729-limitations-on-reference-variables) is: "For a ref reassignment `e1 = ref e2`, the ref-safe-context of `e2` shall be at least as wide a context as the ref-safe-context of `e1`." The local's context does not change as a result. That has consequences in both directions.

**Narrowing is an error.** Initialize from an array element, then try to point at a local:

```csharp
// .NET 10 SDK 10.0.302, C# 14
ref int Narrowing()
{
    ref int r = ref _arr[0]; // caller-context
    int v = 1;
    r = ref v;               // error CS8374
    return ref r;
}
```

```text
error CS8374: Cannot ref-assign 'v' to 'r' because 'v' has a narrower escape scope than 'r'.
```

The same thing happens between nested blocks, which is the version people hit in real loops:

```csharp
// .NET 10 SDK 10.0.302, C# 14
static void NestedBlock()
{
    int outer = 1;
    ref int r = ref outer;   // declaration-block of the method body
    {
        int inner = 2;
        r = ref inner;       // error CS8374: inner's block is narrower
    }
}
```

**Widening is allowed but does not help.** Initialize from a local, then point at an array element. The reassignment compiles. The return does not:

```csharp
// .NET 10 SDK 10.0.302, C# 14
ref int Widening()
{
    int v = 1;
    ref int r = ref v;   // declaration-block, fixed forever
    r = ref _arr[0];     // OK: caller-context is wider
    return ref r;        // error CS8157: r was *initialized* to a local
}
```

This is flow-insensitive on purpose. The compiler does not track that `r` currently happens to point at the heap. It only knows the declared context, and that is declaration-block.

**The return-only trap.** A `ref` parameter is return-only, which is narrower than caller-context. So this fails, with a different error code:

```csharp
// .NET 10 SDK 10.0.302, C# 14
ref int FieldThenParam(ref int p)
{
    ref int r = ref _arr[0]; // caller-context
    r = ref p;               // error CS9079
    return ref r;
}
```

```text
error CS9079: Cannot ref-assign 'p' to 'r' because 'p' can only escape the current method through a return statement.
```

Both `_arr[0]` and `p` are individually returnable, yet the combination is rejected. The fix in every one of these cases is the same: initialize the `ref` local with the **narrowest** referent it will ever hold, then reassign to wider ones.

```csharp
// .NET 10 SDK 10.0.302, C# 14
ref int ParamThenField(ref int p, bool useField)
{
    ref int r = ref p;               // return-only
    if (useField) r = ref _arr[0];   // caller-context is wider: OK
    return ref r;                    // OK: return-only is returnable
}
```

## `scoped ref` locals: opting into a narrower context

You can also narrow a `ref` local deliberately. Declaring it `scoped ref` gives it function-member context regardless of the initializer:

```csharp
// .NET 10 SDK 10.0.302, C# 14
ref int ScopedLocal()
{
    scoped ref int r = ref _arr[0]; // function-member, despite caller-context initializer
    return ref r;                   // error CS8157
}
```

On its own that looks pointless. It pays off when the local is later reassigned to something narrower. Compare the two methods below, which differ only in the `scoped` keyword:

```csharp
// .NET 10 SDK 10.0.302, C# 14
void Unscoped()
{
    ref int r = ref _arr[0]; // caller-context
    int v = 1;
    r = ref v;               // error CS8374
    r = 5;
}

void Scoped()
{
    scoped ref int r = ref _arr[0]; // function-member
    int v = 1;
    r = ref v;                      // OK: v's block is the method body
    r = 5;
}
```

Think of `scoped` as the documented way to say "this reference never leaves the method", which unlocks reassignments the inferred context would forbid. The same keyword on a `ref struct` local (`scoped Span<int> s`) narrows its safe-context instead, which stops its contents from escaping.

## Structs, `this`, and `[UnscopedRef]`

Inside a struct instance method, `this` is an implicit `scoped ref` parameter, so its context is function-member, and so are all of its fields (rule 4). That is why a struct cannot ref-return its own field:

```csharp
// .NET 10 SDK 10.0.302, C# 14
using System.Diagnostics.CodeAnalysis;

struct Counter
{
    int _n;

    public ref int Bad() => ref _n;                 // error CS8170
    [UnscopedRef] public ref int Good() => ref _n;  // OK: this widened to return-only

    static ref int UseGood()
    {
        Counter c = default;
        ref int r = ref c.Good(); // receiver c is a local: declaration-block
        return ref r;             // error CS8157
    }
}
```

```text
error CS8170: Struct members cannot return 'this' or other instance members by reference
```

`[UnscopedRef]` widens `this` by one level, from function-member to return-only, which is enough to `return ref _n`. But it does not make the result heap-safe. At the call site, `c.Good()` is a `ref`-returning call whose receiver is passed by `ref`, so rule 6 applies and the result inherits the local `c`'s declaration-block context. The returned reference is only as long-lived as the struct it points into, which is precisely correct.

## Spans: where ref-safe-context meets safe-context

`Span<T>` has a `ref`-returning indexer, so `ref span[i]` follows rule 6 too. The receiver contributes its **safe-context**, and a span's safe-context depends on where its memory came from:

```csharp
// .NET 10 SDK 10.0.302, C# 14
static ref int FromStackSpan()
{
    Span<int> local = stackalloc int[4]; // safe-context: function-member
    ref int r = ref local[0];
    return ref r;                        // error CS8157
}

static ref int FromHeapSpan()
{
    Span<int> local = new int[4];        // safe-context: caller-context
    ref int r = ref local[0];
    return ref r;                        // OK
}
```

The two methods are identical except for the initializer of `local`, and only one compiles. A span parameter has caller-context safe-context, which makes the classic "find the element by reference" pattern legal with no annotations:

```csharp
// .NET 10 SDK 10.0.302, C# 14
static ref int MaxRef(Span<int> values)
{
    ref int best = ref values[0];        // caller-context via the span parameter
    for (int i = 1; i < values.Length; i++)
        if (values[i] > best) best = ref values[i]; // same context: OK
    return ref best;
}

int[] data = { 3, 9, 4 };
MaxRef(data) = 0;
Console.WriteLine(string.Join(",", data)); // 3,0,4
```

Every reassignment inside the loop is from the same span, so the context never conflicts. This is the shape to aim for: one source, one context, reassign freely.

## How to read the error codes

When you hit one of these, the code tells you which side of the rule failed:

1. **CS8168** ("not a ref local"): you tried `return ref` on a plain local or value parameter. Return the value, or move the storage to the heap.
2. **CS8157** ("was initialized to a value that cannot be returned"): the `ref` local's initializer had a context narrower than return-only. Look at the initializer, not the latest reassignment. Check helper calls for local `ref` arguments and mark non-escaping parameters `scoped`.
3. **CS8374** ("narrower escape scope"): a reassignment tried to narrow the local. Initialize with the narrowest referent first, or declare the local in the same block as the referent.
4. **CS9079** ("can only escape the current method through a return statement"): the special case of CS8374 where the new referent is a `ref` or `in` parameter (return-only) and the local was caller-context. Initialize from the parameter instead.
5. **CS8170**: a struct is returning a ref to its own field. Add `[UnscopedRef]` if callers can live with the result being tied to the struct's own lifetime.

## Gotchas worth knowing

- `ref` locals cannot be captured by lambdas or local functions, and cannot be live across an `await` or `yield return`. That is a separate restriction in section 9.7.2.9, not a context error, but it often shows up in the same refactoring.
- `out` parameters are implicitly `scoped ref` under the C# 11 ref safety rules, so `return ref outParam;` fails with `error CS9075: Cannot return a parameter by reference 'o' because it is scoped to the current method`, even though `return ref refParam;` works. Lowering `<LangVersion>` does not bring the old behavior back: with `<LangVersion>10</LangVersion>` on a `net10.0` project I got the same CS9075, because the compiler applies the new rules whenever the target runtime supports `ref` fields. Mark the parameter `[UnscopedRef] out int o` if you really need it.
- `in` parameters are return-only like `ref` parameters, but only as `ref readonly`. The [`ref readonly` parameter post](/2023/10/csharp-ref-readonly-parameters/) covers when to pick each.
- The compiler is conservative. Rule 6 assumes a `ref`-returning method may return any of its `ref` arguments. If your method does not, `scoped` is not a workaround, it is the correct, documented contract.
- Unsafe code opts out. Inside `unsafe` blocks you can take pointers to locals and the compiler does not track their lifetime. The [C# 16 redesign of `unsafe` as a caller contract](/2026/05/csharp-16-unsafe-keyword-caller-contract/) is about making that boundary explicit.

## Related

- If spans themselves are new to you, start with [what `Span<T>` is and when it actually makes code faster](/2026/06/what-is-span-and-when-does-it-make-my-code-faster/).
- For picking a collection shape before worrying about lifetimes, see [List vs Span vs ReadOnlySpan in C#](/2026/05/list-vs-span-vs-readonlyspan-in-csharp/).
- C# 14 also changed how spans bind; [the overload resolution breaking change with spans](/2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans/) explains the `MemoryExtensions` surprises.
- [Implicit span conversions in C# 14](/2025/04/implicit-span-conversions-in-c-14-first-class-support-for-span-and-readonlyspan/) covers the newer language-level conversions that let arrays flow into span parameters like `MaxRef` above in more places, including extension method receivers.

## Sources

- [C# standard, section 9.7.2 Ref safe contexts](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/variables#972-ref-safe-contexts), including 9.7.2.2 (locals), 9.7.2.6 (function invocation) and 9.7.2.9 (ref reassignment).
- [C# standard, section 9.7.3 The scoped modifier](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/variables#973-the-scoped-modifier).
- [Low-level struct improvements](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-11.0/low-level-struct-improvements), the C# 11 proposal that introduced return-only, `scoped`, and `[UnscopedRef]`.
- [Reference variables](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/statements/declarations#reference-variables) and [`ref` structure types](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/ref-struct) in the C# language reference.
