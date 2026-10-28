---
title: "Fix: [MemberNotNull] has no effect on a static factory method and CS8618 still fires"
description: "CS8618 is checked when the constructor exits, and [MemberNotNull] on a static method is silently ignored for instance members. Pass the values into a private constructor instead."
pubDate: 2026-10-28
template: error-page
tags:
  - "errors"
  - "csharp"
  - "csharp-14"
  - "dotnet"
  - "dotnet-10"
  - "nullable"
---

`[MemberNotNull]` on a static factory method cannot clear `CS8618`, because the warning is reported on the constructor, at the moment the constructor exits, and the compiler never looks at what the factory does afterwards. On top of that, a static method has no `this`, so when its `[MemberNotNull]` names an instance member the compiler silently ignores the attribute: no warning on the method, no effect for callers. The fix is to move the assignment back into a constructor: have the factory compute the values and pass them to a private constructor, or mark the members `required` and set them in an object initializer inside the factory. Verified with the .NET 10 SDK 10.0.302 (C# 14); the behavior is the same since `[MemberNotNull]` shipped in C# 9.

## The error in context

The build output points at the private constructor, not at the factory you annotated:

```
Widget.cs(8,13): warning CS8618: Non-nullable property 'Name' must contain a non-null value when exiting constructor. Consider adding the 'required' modifier or declaring the property as nullable.
```

There is no second diagnostic telling you the attribute was ignored. That silence is what makes this confusing: the `[MemberNotNull(nameof(Name))]` looks like it should be doing something, and nothing in the build says otherwise.

## Why this happens

Two separate rules combine here.

**`CS8618` is checked per constructor, at its exit.** The compiler runs nullable flow analysis over each constructor body (plus field and property initializers) and asks one question at the closing brace: is every non-nullable reference member definitely assigned to a non-null value? It does not follow the object after the constructor returns. A factory that does `var w = new Widget(); w.Name = name; return w;` assigns `Name` after the constructor has already exited with `Name` still `null`, and that exit is where the warning lives. The Roslyn team decided early on not to track initialization across method calls ("We've decided not to track initialization interprocedurally for now" in [dotnet/roslyn#32358](https://github.com/dotnet/roslyn/issues/32358)). `[MemberNotNull]` is the opt-in escape hatch for exactly one case: a helper called *from inside* the constructor on `this`.

**`[MemberNotNull]` on a static method only means something for static members.** The attribute is a postcondition: "when this method returns, these members of the receiver are not null." For an instance method the receiver is `this` (or whatever object you called it on). A static method has no receiver, so the only members it can vouch for are static fields and properties. When you list an instance member, Roslyn accepts the `nameof` (it compiles fine because `nameof(Name)` is valid anywhere in the class) and then drops the annotation on the floor. I confirmed both halves of that on SDK 10.0.302: a static method marked `[MemberNotNull(nameof(Nick))]` that never assigns `Nick` produces no `CS8774`, and an instance method that calls it still gets `CS8602` when it dereferences `Nick` afterwards. The same attribute naming a static field is enforced and honored.

So the static factory fails on both counts: it is not the constructor, and its annotation names members it cannot describe.

## Minimal repro

```csharp
// .NET 10 SDK 10.0.302, C# 14, <Nullable>enable</Nullable>
using System.Diagnostics.CodeAnalysis;

public class Widget
{
    public string Name { get; set; }

    private Widget() { }                     // CS8618 is reported here

    [MemberNotNull(nameof(Name))]            // silently ignored: static method, instance member
    public static Widget Create(string name)
    {
        var w = new Widget();
        w.Name = name;
        return w;
    }
}
```

The second shape of the same mistake is a static helper that takes the instance as a parameter and is called from the constructor. It looks like the documented pattern, but it is not:

```csharp
// .NET 10 SDK 10.0.302, C# 14
using System.Diagnostics.CodeAnalysis;

public class Gadget
{
    public string Name { get; set; }

    public Gadget(string name) => Init(this, name);   // CS8618 still fires here

    [MemberNotNull(nameof(Name))]
    private static void Init(Gadget g, string name) => g.Name = name;
}
```

`[MemberNotNull]` describes the receiver of the call, and `Init(this, name)` has no receiver. Passing `this` as an argument does not count. The only static version that works is the one where both the helper and the members are static, for example a static constructor calling a static loader:

```csharp
// .NET 10 SDK 10.0.302, C# 14
using System.Diagnostics.CodeAnalysis;

public static class Config
{
    public static string ConnectionString;

    static Config() => Load();                 // no CS8618: static helper, static member

    [MemberNotNull(nameof(ConnectionString))]
    private static void Load() => ConnectionString = "Server=.;Database=app";
}
```

## Fix, in detail

All the fixes below put the assignment back where `CS8618` can see it: inside a constructor, or behind a contract the compiler understands. They are in order of preference.

### 1. Pass the computed values into a private constructor

This is the right shape for almost every factory. The factory does the work (validation, parsing, I/O), then hands finished values to a constructor that only assigns:

```csharp
// .NET 10 SDK 10.0.302, C# 14
public sealed class Widget
{
    public string Name { get; }

    private Widget(string name) => Name = name;

    public static Widget Create(string raw)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(raw);
        return new Widget(raw.Trim());
    }
}
```

No attribute, no suppression, and `Name` can become get-only, which a two-step "construct then assign" factory could never offer. If you have several members, the constructor simply grows parameters. A [record](/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/) with a private positional constructor is the compact version of the same idea.

### 2. Turn the static helper into a function that returns the value

For the `Init(this, ...)` shape, change the helper so it returns what it computed, and let the constructor assign it:

```csharp
// .NET 10 SDK 10.0.302, C# 14
public sealed class Gadget
{
    public string Name { get; }

    public Gadget(string raw) => Name = Normalize(raw);

    private static string Normalize(string raw) => raw.Trim().ToLowerInvariant();
}
```

A static method with a return value is easier to test than one that mutates a parameter, and the compiler sees a plain assignment in the constructor. When the helper produces several values, return a tuple and deconstruct it: `(Name, Slug) = Parse(raw);` is a definite assignment of both members.

### 3. Make the helper an instance method and call it from the constructor

If the initialization really is a chunk of shared imperative code, keep it in a helper, but make the helper an instance method so `[MemberNotNull]` describes `this`:

```csharp
// .NET 10 SDK 10.0.302, C# 14
using System.Diagnostics.CodeAnalysis;

public sealed class Report
{
    public string Title { get; private set; }

    private Report(string raw) => Normalize(raw);

    [MemberNotNull(nameof(Title))]
    private void Normalize(string raw) => Title = raw.Trim();

    public static Report Create(string raw) => new(raw);
}
```

This is the pattern the [Microsoft Learn nullable attributes page](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/attributes/nullable-analysis#helper-methods-membernotnull-and-membernotnullwhen) documents. Unlike the static case, the compiler checks the helper: if `Normalize` can return without assigning `Title`, you get `CS8774: Member 'Title' must have a non-null value when exiting.`

One trap: calling the instance helper from the factory on the new object (`var r = new Report(); r.Normalize(raw);`) does make `r.Title` not-null for the rest of the factory, because `[MemberNotNull]` applies to whatever receiver you call it on. It still does nothing for `CS8618`, because the constructor already exited before that line ran.

### 4. Mark the members `required` and use an object initializer in the factory

If you prefer property-style construction, `required` moves the obligation from the constructor to the object creation expression, and the factory is the only place that can create one:

```csharp
// .NET 10 SDK 10.0.302, C# 14
public sealed class Invoice
{
    public required string Number { get; init; }
    public required string Customer { get; init; }

    private Invoice() { }

    public static Invoice Create(string number, string customer) =>
        new() { Number = number.Trim(), Customer = customer.Trim() };
}
```

`CS8618` goes away because a `required` member is not the constructor's responsibility. You also get a safety net the original factory never had: forget one of them and the build fails with `CS9035: Required member 'Invoice.Customer' must be set in the object initializer or attribute constructor.` That is an error, not a warning. The [CS9035 walkthrough](/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/) covers the caller side of this contract.

### 5. Use `[SetsRequiredMembers]` on a private constructor

If the type has `required` members for its public callers but the factory wants to pass values positionally, add a constructor that promises to set them all:

```csharp
// .NET 10 SDK 10.0.302, C# 14
using System.Diagnostics.CodeAnalysis;

public sealed class Tag
{
    public required string Value { get; init; }

    public Tag() { }

    [SetsRequiredMembers]
    private Tag(string value) => Value = value;

    public static Tag Create(string raw) => new(raw.Trim().ToLowerInvariant());
}
```

Like `[MemberNotNull]`, `[SetsRequiredMembers]` is trusted, not verified: if that constructor forgets a member, nothing warns. Keep the constructor short enough that you can check it by eye.

### 6. Last resort: suppress on the constructor, not the property

If the type is built by a framework that requires a parameterless constructor and fills members afterwards, scope a suppression to that constructor so you do not lose analysis anywhere else:

```csharp
// .NET 10 SDK 10.0.302, C# 14
public sealed class LegacyRow
{
    public string Name { get; private set; }

#pragma warning disable CS8618 // Name is always assigned by Create before the instance escapes
    private LegacyRow() { }
#pragma warning restore CS8618

    public static LegacyRow Create(string name) => new() { Name = name };
}
```

This is honest about what is going on, and the comment tells the next reader which method holds up the promise. Prefer it over `= null!` on the property: `null!` silences the warning for every constructor the type will ever have, including ones added later that really do forget to assign.

## Gotchas and variants

- **Delete the dead attribute.** After you fix the factory, remove `[MemberNotNull]` from any static method that names instance members. It does nothing, the compiler will never tell you so, and the next person will copy it. A quick search for `MemberNotNull` across the solution, checking each hit for `static`, finds them all.

- **Async factories hit `CS8774` for a different reason.** A `static async Task<T> CreateAsync()` is the usual reason people reach for a factory in the first place, since constructors cannot `await`. If you instead put `[MemberNotNull]` on an instance `async Task InitAsync()` helper, the compiler checks the postcondition at the `await` points, where the method can hand control back to its caller, not when the task completes, so assigning the member after an `await` still produces `CS8774`. Roslyn treats this as by design ([dotnet/roslyn#75022](https://github.com/dotnet/roslyn/issues/75022)). The fix is the same as fix 1: `await` the I/O inside the static factory, then pass the results into a private constructor.

- **For a `TryCreate` factory, annotate the `out` parameter, not the members.** What the caller cares about is whether the returned object is null, and that is a parameter postcondition:

  ```csharp
  // .NET 10 SDK 10.0.302, C# 14
  using System.Diagnostics.CodeAnalysis;

  public sealed class Sku
  {
      public string Code { get; }
      private Sku(string code) => Code = code;

      public static bool TryCreate(string? raw, [NotNullWhen(true)] out Sku? sku)
      {
          sku = string.IsNullOrWhiteSpace(raw) ? null : new Sku(raw.Trim());
          return sku is not null;
      }
  }
  ```

  The members themselves are non-nullable and guaranteed by the private constructor, so nothing else needs an attribute.

- **You cannot put `[MemberNotNull]` on a constructor.** The attribute targets methods and properties only. Asking a derived constructor to vouch for a base-class member is an open request ([dotnet/roslyn#71526](https://github.com/dotnet/roslyn/issues/71526)). Pass the value up through `base(...)` instead.

- **Instance helpers called on another object do flow, but only locally.** `other.Init(); other.Name.Length` is warning-free, because the receiver is `other`. That is useful inside a factory body, but it never retroactively satisfies the constructor that created `other`.

- **Lazy members are a different problem.** If `Name` is legitimately unset until first use, it is nullable or it belongs behind `Lazy<T>`. Compare the options in [Lazy&lt;T&gt; vs LazyInitializer vs double-checked locking](/2026/10/lazy-t-vs-lazyinitializer-vs-double-checked-locking-in-csharp/) rather than fighting `CS8618`.

## Related

- [Fix: CS8618 "Non-nullable property must contain a non-null value when exiting constructor"](/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/) for the general warning and the instance `[MemberNotNull]` helper pattern.
- [Fix: CS9035 "Required member 'X' must be set in the object initializer"](/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/) for the error you get when a `required`-based factory misses a member.
- [record vs class vs struct in C#: a decision matrix](/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/) for choosing a type shape that makes constructor-based initialization natural.
- [What does a C# with expression actually copy](/2026/10/what-does-a-csharp-with-expression-actually-copy/) for another place where construction bypasses the code you expect to run.
- [C# 14 null-conditional assignment](/2026/02/csharp-14-null-conditional-assignment/) for more of how the compiler reasons about null.

## Sources

- Microsoft Learn, [Attributes interpreted by the compiler: Nullable static analysis](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/attributes/nullable-analysis) (the "Helper methods: MemberNotNull and MemberNotNullWhen" section and its constructor-helper example).
- Microsoft Learn, [MemberNotNullAttribute Class](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.codeanalysis.membernotnullattribute) (attribute targets: methods and properties).
- Microsoft Learn, [Nullable reference type warnings](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/nullable-warnings) (`CS8618`, `CS8774`).
- GitHub, [dotnet/roslyn#32358](https://github.com/dotnet/roslyn/issues/32358) (initialization is not tracked across method calls).
- GitHub, [dotnet/roslyn#71526](https://github.com/dotnet/roslyn/issues/71526) (`[MemberNotNull]` is not allowed on constructors).
- GitHub, [dotnet/roslyn#75022](https://github.com/dotnet/roslyn/issues/75022) (`CS8774` on async `[MemberNotNull]` methods is by design).
