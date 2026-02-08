---
title: "C# 14 Null-Conditional Assignment: Using ?. and ?[] on the Left Side"
description: "C# 14 extends null-conditional operators to work on the left-hand side of assignments, eliminating verbose null checks when setting properties or indexers."
pubDate: 2026-02-08
tags:
  - "c-sharp"
  - "csharp-14"
  - "net-10"
  - "null-safety"
---

C# 14 brings a small but impactful change: the null-conditional operators `?.` and `?[]` now work on the left-hand side of assignments. This eliminates a common pattern of wrapping property assignments in null checks.

## The Verbose Pattern It Replaces

Before C# 14, assigning to a property only when an object isn't null required explicit checks:

```csharp
if (customer is not null)
{
    customer.LastOrderDate = DateTime.UtcNow;
}

if (settings is not null)
{
    settings["theme"] = "dark";
}
```

With deeply nested objects, this became worse:

```csharp
if (order?.Customer?.Address is not null)
{
    order.Customer.Address.IsVerified = true;
}
```

## Null-Conditional Assignment in C# 14

C# 14 lets you write the same logic more concisely:

```csharp
customer?.LastOrderDate = DateTime.UtcNow;

settings?["theme"] = "dark";

order?.Customer?.Address?.IsVerified = true;
```

The assignment only executes if the left-hand side evaluates to a non-null reference. The right-hand side is never evaluated when the target is null.

## How It Works

The expression `P?.A = B` is equivalent to:

```csharp
if (P is not null)
{
    P.A = B;
}
```

With one important difference: `P` is evaluated only once. This matters when `P` is a method call or has side effects.

## Compound Assignment Operators

Null-conditional assignment also works with compound operators like `+=`, `-=`, `*=`, and others:

```csharp
inventory?.StockLevel += restockAmount;

counter?.Value -= 1;

account?.Balance *= interestRate;
```

Each of these evaluates the left side once and applies the operation only if the target isn't null.

## Increment and Decrement Are Not Allowed

One limitation: `++` and `--` operators cannot be used with null-conditional assignment. This won't compile:

```csharp
// Error: ++ and -- not allowed
counter?.Value++;
```

Use compound assignment instead:

```csharp
counter?.Value += 1;
```

## Practical Example: Event Handlers

A common use case is conditionally setting event handlers:

```csharp
public void Initialize(Button? submitButton, Button? cancelButton)
{
    submitButton?.Click += OnSubmit;
    cancelButton?.Click += OnCancel;
}
```

Without null-conditional assignment, you'd need separate null checks for each button.

## Chaining with Indexers

The `?[]` operator works the same way for indexer assignments:

```csharp
Dictionary<string, string>? headers = GetHeaders();

headers?["Authorization"] = $"Bearer {token}";
headers?["Content-Type"] = "application/json";
```

If `headers` is null, neither assignment executes and no exception is thrown.

## When to Use It

Null-conditional assignment works best when:
- You have optional objects that may or may not need updates
- You're working with nullable reference types and want to avoid verbose null checks
- The assignment is a fire-and-forget operation where you don't need to know if it executed

The feature is available in .NET 10 with C# 14. Set `<LangVersion>14</LangVersion>` in your project file to enable it.

For the complete specification, see [Null-conditional assignment on Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-14.0/null-conditional-assignment).
