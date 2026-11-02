---
title: "What Is ref-safe-context in C#, and How Does the Compiler Decide It for ref Locals?"
description: "Understand C# reference escape rules with compiler-checked examples for ref locals, reassignment, scoped references and heap-backed versus stack-backed spans."
pubDate: 2026-10-15
updatedDate: 2026-11-02
template: how-to
tags:
  - "csharp"
  - "csharp-14"
  - "dotnet-11"
  - "ref-locals"
  - "span"
  - "compiler-errors"
---
A reference must not escape the lifetime of the storage it points into. C# checks that relationship at compile time. A `ref` local initialized from a method local cannot be returned merely because it is later reassigned to an array element.

**Correction — November 2, 2026:** The previous .NET 11 RC1 testing claim was not supported by retained evidence and has been removed. The positive/negative examples described here were compiled with SDK 10.0.302, `net10.0` and `LangVersion` 14. Error codes below refer to those exact code shapes; related expressions can produce different diagnostics.

## Ref-safe-context and safe-context

`ref-safe-context` concerns a reference to storage. The related `safe-context` concerns a value that can itself contain references, such as a `Span<T>`. A local variable holding a span and the storage described by that span are different things.

The language specification describes four nested contexts:

| Context | Typical example |
| --- | --- |
| declaration-block | A reference to an ordinary local variable |
| function-member | A value parameter or scoped parameter |
| return-only | An ordinary `ref` parameter that may be returned |
| caller-context | An array element or an appropriate class field |

These labels are not an instruction to treat all storage as lasting until a method returns. Nested blocks and `scoped` restrictions still matter. The [language specification](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/variables#972-ref-safe-contexts) gives the full rules, including parameter and invocation cases.

## An initializer constrains an unscoped ref local

This negative example produces CS8157 in the verified build:

```csharp
class Example
{
    static ref int CannotReturn(int[] array)
    {
        int local = 1;
        ref int reference = ref local;
        reference = ref array[0];
        return ref reference; // CS8157
    }
}
```

The later reassignment is allowed, but does not turn a local-derived reference into a returnable reference. Returning an ordinary local directly instead produces CS8168:

```csharp
class Example
{
    static ref int CannotReturn()
    {
        int local = 1;
        return ref local; // CS8168
    }
}
```

## Reassignment cannot accept a narrower referent

Starting with an array-element reference and then assigning a local reference produces CS8374:

```csharp
class Example
{
    static void CannotNarrow(int[] array)
    {
        ref int reference = ref array[0];
        int local = 1;
        reference = ref local; // CS8374
    }
}
```

A `ref` parameter has a different escape contract from an array element. Initializing from the array and then assigning the parameter produces CS9079:

```csharp
class Example
{
    static ref int CannotAssign(int[] array, ref int parameter)
    {
        ref int reference = ref array[0];
        reference = ref parameter; // CS9079
        return ref reference;
    }
}
```

The opposite order compiled successfully in the same probe:

```csharp
class Example
{
    static ref int CanReturn(int[] array, ref int parameter)
    {
        ref int reference = ref parameter;
        reference = ref array[0];
        return ref reference;
    }
}
```

Choose an initializer whose contract fits every intended use. Moving declarations or adding `scoped` is not a universal fix for every escape error.

## Scoped references remain local

This same-block mutation compiled successfully:

```csharp
class Example
{
    static void LocalUse(int[] array)
    {
        scoped ref int reference = ref array[0];
        int local = 1;
        reference = ref local;
        reference = 5;
    }
}
```

Returning that scoped reference is rejected. A separate probe that declared `local` in a narrower nested block also rejected the reassignment with CS8374. `scoped` does not erase block lifetime restrictions or make a reference returnable.

A scoped parameter can also communicate that an argument does not escape through a method's result. That is a signature contract; the compiler does not need to inspect an arbitrary helper's implementation. See the [C# 11 design proposal](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-11.0/low-level-struct-improvements.md) for the detailed rules and `[UnscopedRef]` cases.

## A span is not necessarily stack-backed

Both examples below declare a local span, but only the first result can escape:

```csharp
using System;

class Example
{
    static ref int HeapBacked()
    {
        Span<int> values = new int[2];
        return ref values[0]; // Compiles in the verified probe
    }

    static ref int StackBacked()
    {
        Span<int> values = stackalloc int[2];
        return ref values[0]; // CS8352 in this exact probe
    }
}
```

The array-backed span describes managed heap storage. Returning a reference into that storage is different from returning a reference to the local span variable itself. Managed references keep their referenced objects reachable; this does not mean heap objects are immortal.

For a practical ref-returning algorithm, use a span supplied by the caller and handle an empty input:

```csharp
using System;

static ref int MaxRef(Span<int> values)
{
    if (values.IsEmpty)
        throw new ArgumentException("At least one element is required", nameof(values));

    ref int best = ref values[0];
    for (int i = 1; i < values.Length; i++)
        if (values[i] > best) best = ref values[i];
    return ref best;
}

int[] data = { 3, 9, 4 };
MaxRef(data) = 0;
Console.WriteLine(string.Join(",", data)); // 3,0,4
```

## Read the diagnostic in context

The verified probes distinguish direct local returns (CS8168), a non-returnable ref local (CS8157), narrower ref assignment (CS8374), and a return-only parameter assigned to a wider reference (CS9079). The direct stack-span expression above produced CS8352. An extra alias or helper call may change the diagnostic without changing the underlying lifetime problem.

Async/iterator restrictions are a separate concern: a reference must not be preserved across a suspension point where the language disallows it. Avoid explaining every compiler rejection solely through the initializer rule.

Related: [Span<T> and its storage](/2026/06/what-is-span-and-when-does-it-make-my-code-faster/), [List vs Span vs ReadOnlySpan](/2026/05/list-vs-span-vs-readonlyspan-in-csharp/), and [reference-variable declarations](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/statements/declarations#reference-variables).
