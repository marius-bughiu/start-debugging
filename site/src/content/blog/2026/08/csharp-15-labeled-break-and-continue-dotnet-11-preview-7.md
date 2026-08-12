---
title: "C# 15 Gets Labeled break and continue in .NET 11 Preview 7"
description: "Labeled break and continue landed in the C# section of .NET 11 Preview 7. You can now put a label on a loop and jump straight to it, which retires the bool flag and goto workarounds for nested loops."
pubDate: 2026-08-12
tags:
  - "dotnet-11"
  - "csharp"
  - "csharp-15"
  - "language-features"
---

.NET 11 Preview 7 shipped on August 11, 2026, and the C# section carries a feature the community has been asking for since roughly forever: `break` and `continue` can now name a label on an enclosing loop or `switch`. The championed proposal is [dotnet/csharplang#9875](https://github.com/dotnet/csharplang/issues/9875), and the discussion list attached to it links nine separate community threads going back years.

## What the syntax looks like

The label goes directly on the loop, and the jump statement names it:

```csharp
outer: for (int row = 0; row < grid.Height; row++)
{
    for (int column = 0; column < grid.Width; column++)
    {
        if (grid[row, column].IsBlocked)
        {
            continue outer;
        }

        if (grid[row, column].IsGoal)
        {
            break outer;
        }
    }
}
```

One label serves both jumps. Without a label, `break` and `continue` behave exactly as before and target the innermost applicable statement, so this is purely additive.

## The two workarounds it replaces

The bool flag version needs state that exists only to propagate the exit outward, and it has to be checked at every level:

```csharp
bool found = false;
for (int i = 0; i < 10; i++)
{
    for (int j = 0; j < 10; j++)
    {
        if (i * j > 20)
        {
            found = true;
            break;
        }
    }

    if (found)
        break;
}
```

The `goto` version is worse for the continue case, because the label has to sit at the end of the loop body so the incrementor and condition still run:

```csharp
for (int i = 0; i < 10; i++)
{
    for (int j = 0; j < 10; j++)
    {
        if (j == 5)
            goto next;
    }

    next: ; // The empty statement is required.
}
```

That is brittle. Any statement accidentally inserted between the label and the closing brace silently changes what the jump does. Binding the label to the loop construct itself removes that failure mode.

## Two rules worth knowing before you refactor

Only the statement **immediately** nested inside a labeled statement gets the label. Given `a: b: while (...) ...`, only `b` labels the loop. `a` labels the inner labeled statement, which is not itself a loop, so `break a;` inside that body is a compile-time error rather than a jump to the `while`. The spec explicitly rejects nested labels.

Also, `break` can target an enclosing `switch`, but `continue` cannot. `continue` only ever resolves to an iteration statement, which follows from what the two jumps mean.

## The analyzer that finds your existing cases

You do not have to hunt for the code that qualifies. [IDE0410](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/style-rules/ide0410) ("Use labeled jump statement") flags all three patterns: a `goto` jumping past a nested loop, a `goto` to an empty trailing label, and the bool flag propagation chain. It is on by default via `csharp_style_prefer_labeled_jump_statements = true`, and applies to C# 15 and later. Turn it off per project with:

```ini
[*.cs]
dotnet_diagnostic.IDE0410.severity = none
```

You need the .NET 11 preview SDK to try it, same as the [extension indexers that landed in Preview 6](/2026/07/csharp-15-extension-indexers-dotnet-11-preview-6/). Full details are in the [feature specification](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/labeled-break-continue) and the [Preview 7 announcement](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-7/).
